import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentScope } from "../extensions/agent/scope.ts";
import { PitakoConfigError } from "../extensions/errors.ts";
import pitako from "../extensions/index.ts";
import { executionForSession, resolveBoardAuthor } from "../extensions/execution-identity.ts";
import { unregisterSupervisedSession } from "../extensions/herdr/author.ts";
import { piIntegrationCurrent, readHerdrPresence } from "../extensions/herdr/presence.ts";
import { superviseAgent, type HerdrCommandResult, type HerdrRunner } from "../extensions/herdr/supervise.ts";
import { childActiveTools } from "../extensions/profile.ts";
import { resolveRole, type LoadOptions } from "../extensions/roles/load.ts";
import { packageRoot } from "../extensions/stack.ts";

const inside = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w8:p5",
  HERDR_SOCKET_PATH: "/tmp/herdr.sock",
  HERDR_TAB_ID: "tab-1",
  HERDR_WORKSPACE_ID: "ws-1",
};

describe("herdr presence", () => {
  test("missing HERDR_ENV is absent", () => {
    expect(readHerdrPresence({ HERDR_PANE_ID: "w8:p5", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }).present).toBe(false);
    expect(readHerdrPresence({}).present).toBe(false);
  });

  test("HERDR_ENV=1 without pane id or socket is absent", () => {
    expect(readHerdrPresence({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }).present).toBe(false);
    expect(readHerdrPresence({ HERDR_ENV: "1", HERDR_PANE_ID: "w8:p5" }).present).toBe(false);
    expect(readHerdrPresence({ HERDR_ENV: "1", HERDR_PANE_ID: "", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }).present).toBe(false);
    expect(readHerdrPresence({ HERDR_ENV: "1", HERDR_PANE_ID: "w8:p5", HERDR_SOCKET_PATH: "" }).present).toBe(false);
  });

  test("full env with the three required vars is present and records optional ids", () => {
    expect(readHerdrPresence(inside)).toEqual({
      present: true,
      paneId: "w8:p5",
      socketPath: "/tmp/herdr.sock",
      tabId: "tab-1",
      workspaceId: "ws-1",
    });
    expect(readHerdrPresence({
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w8:p5",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    })).toEqual({
      present: true,
      paneId: "w8:p5",
      socketPath: "/tmp/herdr.sock",
    });
  });

  test("does not infer presence from a terminal title", () => {
    expect(readHerdrPresence({
      HERDR_TITLE: "pi — pitako",
      TERM_TITLE: "herdr",
      HERDR_PANE_TITLE: "working",
    }).present).toBe(false);
  });
});

describe("pi integration status", () => {
  test("pi: current (vN) (path) passes", () => {
    expect(piIntegrationCurrent("pi: current (vN) (path)")).toBe(true);
    expect(piIntegrationCurrent("claude: outdated ( < v10) (/path)\npi: current (v9) (~/.pi/agent/extensions/herdr-agent-state.ts)")).toBe(true);
  });

  test("pi: not installed does not pass", () => {
    expect(piIntegrationCurrent("pi: not installed (~/.pi/agent/extensions/herdr-agent-state.ts)")).toBe(false);
  });

  test("outdated and needs repair fail closed", () => {
    expect(piIntegrationCurrent("pi: outdated ( < v10) (/path)")).toBe(false);
    expect(piIntegrationCurrent("pi: needs repair (hash mismatch) (/path)")).toBe(false);
  });

  test("another agent current does not make pi current", () => {
    expect(piIntegrationCurrent("claude: current (v10) (/path)")).toBe(false);
    expect(piIntegrationCurrent("claude: current (v10) (/path)\npi: not installed (~/.pi/agent/extensions/herdr-agent-state.ts)")).toBe(false);
  });
});

const AUTHOR_ENV = ["PITAKO_INSTANCE_ID", "PITAKO_ROLE_ID", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"] as const;

function sessionHooks(): {
  start: (event: unknown, ctx: unknown) => Promise<unknown>;
  shutdown: (event: unknown, ctx: unknown) => Promise<unknown>;
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  pitako({
    registerFlag() {},
    registerTool() {},
    getFlag() {
      return undefined;
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    getActiveTools() {
      return ["read"];
    },
    getAllTools() {
      return [{ name: "read" }, { name: "bash" }];
    },
    setActiveTools() {},
    getSessionName() {
      return "pitako:coding";
    },
    setSessionName() {},
  } as unknown as ExtensionAPI);
  const start = handlers.get("session_start");
  const shutdown = handlers.get("session_shutdown");
  if (!start || !shutdown) throw new Error("session hooks were not registered");
  return { start, shutdown };
}

async function withAuthorEnv(patch: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const saved = AUTHOR_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of AUTHOR_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("supervised board author", () => {
  afterEach(() => {
    unregisterSupervisedSession();
  });

  test("no env, or env outside Herdr, still resolves to pi", async () => {
    const { start } = sessionHooks();
    const sessionManager = { getSessionId: () => "foreground-sess" };
    await withAuthorEnv({}, async () => {
      await start({}, { hasUI: false, sessionManager });
    });
    expect(resolveBoardAuthor("foreground-sess")).toBe("pi");

    await withAuthorEnv({
      PITAKO_INSTANCE_ID: "developer-c121cc",
      PITAKO_ROLE_ID: "developer",
      HERDR_ENV: "1",
    }, async () => {
      await start({}, { hasUI: false, sessionManager: { getSessionId: () => "herdr-env-only" } });
    });
    expect(resolveBoardAuthor("herdr-env-only")).toBe("pi");

    await withAuthorEnv({
      PITAKO_INSTANCE_ID: "developer-c121cc",
      PITAKO_ROLE_ID: "developer",
    }, async () => {
      await start({}, { hasUI: false, sessionManager: { getSessionId: () => "outside-herdr" } });
    });
    expect(resolveBoardAuthor("outside-herdr")).toBe("pi");

    await withAuthorEnv({
      PITAKO_INSTANCE_ID: "developer-c121cc",
      ...inside,
    }, async () => {
      await start({}, { hasUI: false, sessionManager: { getSessionId: () => "missing-role" } });
    });
    expect(resolveBoardAuthor("missing-role")).toBe("pi");
  });

  test("session_start reads getSessionId and resolveBoardAuthor returns the instance id", async () => {
    const { start, shutdown } = sessionHooks();
    let reads = 0;
    const sessionManager = {
      getSessionId() {
        reads += 1;
        return "pane-sess";
      },
    };
    await withAuthorEnv({
      PITAKO_INSTANCE_ID: "developer-c121cc",
      PITAKO_ROLE_ID: "developer",
      ...inside,
    }, async () => {
      await start({}, { hasUI: false, sessionManager });
    });
    expect(reads).toBe(1);
    expect(resolveBoardAuthor("pane-sess")).toBe("developer-c121cc");
    expect(executionForSession("pane-sess")?.roleId).toBe("developer");

    await shutdown({}, { hasUI: false });
    expect(resolveBoardAuthor("pane-sess")).toBe("pi");

    reads = 0;
    const next = {
      getSessionId() {
        reads += 1;
        return "pane-sess-next";
      },
    };
    await withAuthorEnv({
      PITAKO_INSTANCE_ID: "developer-c121cc",
      PITAKO_ROLE_ID: "developer",
      ...inside,
    }, async () => {
      await start({}, { hasUI: false, sessionManager: next });
    });
    expect(reads).toBe(1);
    expect(resolveBoardAuthor("pane-sess-next")).toBe("developer-c121cc");
    expect(resolveBoardAuthor("pane-sess")).toBe("pi");
    await shutdown({}, { hasUI: false });
  });

  test("missing session id does not throw and does not invent an author", async () => {
    const { start } = sessionHooks();
    await withAuthorEnv({
      PITAKO_INSTANCE_ID: "developer-c121cc",
      PITAKO_ROLE_ID: "developer",
      ...inside,
    }, async () => {
      await start({}, { hasUI: false, sessionManager: { getSessionId: () => undefined } });
      await start({}, { hasUI: false, sessionManager: { getSessionId: () => "" } });
      await start({}, { hasUI: false });
    });
    expect(resolveBoardAuthor(undefined)).toBe("pi");
    expect(resolveBoardAuthor("")).toBe("pi");
    expect(resolveBoardAuthor("developer-c121cc")).toBe("pi");
    expect(executionForSession("developer-c121cc")).toBeUndefined();
  });
});

describe("herdr presence module", () => {
  test("does not exec herdr", () => {
    const source = readFileSync(new URL("../extensions/herdr/presence.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process|\bspawn\b|\bexecFile\b|\bexecSync\b|Bun\.spawn/);
  });
});

const CALLER_CWD = "/tmp/pitako-caller";
const NEW_PANE = "w8:p9";

function ok(stdout: string): HerdrCommandResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(code: string): HerdrCommandResult {
  return { code: 1, stdout: JSON.stringify({ id: "cli:herdr", error: { code, message: code } }), stderr: "" };
}

function layoutJson(width: number, height: number): string {
  return JSON.stringify({
    id: "cli:pane:layout",
    result: {
      type: "pane_layout",
      layout: {
        panes: [{ pane_id: inside.HERDR_PANE_ID, focused: true, rect: { x: 0, y: 0, width, height } }],
        area: { x: 0, y: 0, width, height },
      },
    },
  });
}

function commandKey(args: readonly string[]): string {
  if (args[0] === "agent" || args[0] === "pane") return `${args[0]} ${args[1]}`;
  return args[0] ?? "";
}

function respond(args: readonly string[]): HerdrCommandResult {
  const key = commandKey(args);
  if (args[0] === "integration") return ok("pi: current (vN) (path)\n");
  if (args[0] === "status") return ok(JSON.stringify({ server: { running: true, endpoint_compatible: true } }));
  if (key === "pane layout") return ok(layoutJson(120, 40));
  if (key === "pane split") {
    return ok(JSON.stringify({ id: "cli:pane:split", result: { type: "pane_info", pane: { pane_id: NEW_PANE } } }));
  }
  if (key === "agent start") {
    return ok(JSON.stringify({ id: "cli:agent:start", result: { type: "agent_started", agent: { agent_status: "idle", pane_id: NEW_PANE }, argv: ["pi"] } }));
  }
  if (key === "agent prompt") {
    return ok(JSON.stringify({ id: "cli:agent:prompt", result: { type: "agent_prompted", agent: { agent_status: "done", pane_id: NEW_PANE }, text: "SECRET_TRANSCRIPT" } }));
  }
  if (key === "agent read") return ok("BLOCKED_EXCERPT\n");
  if (key === "pane close" || key === "agent send-keys") return ok("{\"type\":\"ok\"}");
  throw new Error(`unexpected herdr argv: ${args.join(" ")}`);
}

function scripted(overrides: Record<string, HerdrCommandResult | ((args: string[]) => Promise<HerdrCommandResult>)> = {}) {
  const calls: string[][] = [];
  const run: HerdrRunner = async (args) => {
    const copy = [...args];
    calls.push(copy);
    const found = overrides[commandKey(copy)];
    if (typeof found === "function") return found(copy);
    if (found) return found;
    return respond(copy);
  };
  return { calls, run };
}

function developerLoad(reasoning?: string, options: { fast?: boolean; fallbackFast?: boolean } = {}): LoadOptions {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-supervise-"));
  const userConfigPath = path.join(dir, "config.toml");
  const reasoningLine = reasoning ? `reasoning = "${reasoning}"\n` : "";
  const fastLine = options.fast === undefined ? "" : `fast = ${options.fast}\n`;
  const fallback = options.fallbackFast === undefined ? "" : `\n[[model_policies.developer.fallbacks]]\nmodel = "example/fallback"\nfast = ${options.fallbackFast}\n`;
  writeFileSync(userConfigPath, `[model_policies.developer.primary]\nmodel = "example/coder"\n${reasoningLine}${fastLine}${fallback}`);
  return { userConfigPath, packageRoot: packageRoot() };
}

function superviseInput(run: HerdrRunner, extra: { env?: Record<string, string | undefined>; load?: LoadOptions; signal?: AbortSignal; task?: string } = {}) {
  return {
    roleId: "developer",
    task: extra.task ?? "Inspect the diff",
    cwd: CALLER_CWD,
    env: extra.env ?? inside,
    load: extra.load ?? developerLoad("high"),
    signal: extra.signal,
    run,
  };
}

describe("agent_supervise", () => {
  test("registers the tool", () => {
    const names: string[] = [];
    pitako({
      registerFlag() {},
      registerTool(def: { name: string }) {
        names.push(def.name);
      },
      getFlag() {
        return undefined;
      },
      on() {},
      registerCommand() {},
      getActiveTools() {
        return ["read"];
      },
      getAllTools() {
        return [{ name: "read" }];
      },
      setActiveTools() {},
      getSessionName() {
        return "pitako:coding";
      },
      setSessionName() {},
    } as unknown as ExtensionAPI);
    expect(names).toContain("agent_supervise");
  });

  test("childActiveTools drops agent_supervise", () => {
    const names = childActiveTools(["read", "bash", "agent_run", "agent_supervise"]);
    expect(names).not.toContain("agent_supervise");
    expect(names).not.toContain("agent_run");
    expect(names).toContain("read");
  });

  test("agent_run has no herdr argv", () => {
    const source = readFileSync(new URL("../extensions/agent/run.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bherdr\b/);
  });

  test("outside Herdr errors and does not split", async () => {
    const { calls, run } = scripted();
    await expect(superviseAgent(superviseInput(run, { env: {} }))).rejects.toThrow(/Herdr presence/);
    expect(calls).toEqual([]);
  });

  test("missing, outdated, and needs-repair integrations error before split", async () => {
    for (const text of [
      "pi: not installed (~/.pi/agent/extensions/herdr-agent-state.ts)",
      "pi: outdated ( < v10) (path)",
      "pi: needs repair (hash mismatch) (path)",
    ]) {
      const { calls, run } = scripted({ integration: ok(text) });
      await expect(superviseAgent(superviseInput(run))).rejects.toThrow(/herdr integration install pi/);
      expect(calls.map(commandKey)).toEqual(["integration"]);
    }
  });

  test("server not running or not endpoint-compatible stops before split", async () => {
    for (const server of [{ running: false, endpoint_compatible: true }, { running: true, endpoint_compatible: false }]) {
      const { calls, run } = scripted({ status: ok(JSON.stringify({ server })) });
      await expect(superviseAgent(superviseInput(run))).rejects.toThrow(/not running or not endpoint-compatible/);
      expect(calls.some((args) => args[1] === "split")).toBe(false);
    }
  });

  test("no primary target is a PitakoConfigError before split", async () => {
    const { calls, run } = scripted();
    const missing = path.join(mkdtempSync(path.join(tmpdir(), "pitako-supervise-")), "missing.toml");
    await expect(superviseAgent(superviseInput(run, { load: { userConfigPath: missing, packageRoot: packageRoot() } }))).rejects.toThrow(/no primary target/);
    expect(calls.some((args) => args[1] === "split")).toBe(false);
  });

  test("rejects a fast primary before pane layout, split, or agent start", async () => {
    const { calls, run } = scripted();
    const error = await superviseAgent(superviseInput(run, { load: developerLoad("max", { fast: true }) })).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PitakoConfigError);
    expect((error as Error).message).toMatch(/fast.*not supported|not supported.*fast/i);
    expect(calls.map(commandKey)).toEqual(["integration", "status"]);
    expect(calls.some((args) => args[1] === "split" || args[1] === "start" || args[1] === "layout")).toBe(false);
  });

  test("normal primary ignores a fast fallback and passes no speculative flag", async () => {
    const { calls, run } = scripted();
    const load = developerLoad("high", { fast: false, fallbackFast: true });
    await superviseAgent(superviseInput(run, { load }));
    const start = calls.find((args) => args[1] === "start");
    expect(start).toContain("--model");
    expect(start?.[start.indexOf("--model") + 1]).toBe("example/coder");
    expect(start?.[start.indexOf("--thinking") + 1]).toBe("high");
    expect(start).not.toContain("--fast");
    expect(start).not.toContain("--priority");
  });

  test("refuses a child instance before any herdr command", async () => {
    const envRun = scripted();
    await expect(superviseAgent(superviseInput(envRun.run, { env: { ...inside, PITAKO_INSTANCE_ID: "developer-abc" } }))).rejects.toThrow(/child agent/);
    expect(envRun.calls).toEqual([]);
    const scoped = scripted();
    await agentScope.run({ instanceId: "developer-abc" }, () =>
      expect(superviseAgent(superviseInput(scoped.run))).rejects.toThrow(/child agent/),
    );
    expect(scoped.calls).toEqual([]);
  });

  test("happy path argv starts one named Pi and returns ids plus status", async () => {
    const load = developerLoad("high");
    const role = resolveRole("developer", load);
    const { calls, run } = scripted();
    const result = await superviseAgent(superviseInput(run, { load }));
    const split = calls.find((args) => args[1] === "split");
    const start = calls.find((args) => args[1] === "start");
    const prompt = calls.find((args) => args[1] === "prompt");
    if (!split || !start || !prompt) throw new Error("missing split, start, or prompt");
    const instanceId = start[2];
    expect(instanceId).toMatch(/^developer-[0-9a-f]{6}$/);
    expect(split).toContain("--current");
    expect(split).toContain("--no-focus");
    expect(split).toContain("--direction");
    expect(split[split.indexOf("--direction") + 1]).toBe("right");
    expect(split[split.indexOf("--cwd") + 1]).toBe(CALLER_CWD);
    expect(split).toContain(`PITAKO_INSTANCE_ID=${instanceId}`);
    expect(split).toContain("PITAKO_ROLE_ID=developer");
    expect(start[1]).toBe("start");
    expect(start).toContain("--kind");
    expect(start[start.indexOf("--kind") + 1]).toBe("pi");
    expect(start[start.indexOf("--model") + 1]).toBe("example/coder");
    expect(start[start.indexOf("--thinking") + 1]).toBe("high");
    expect(start).toContain("--no-approve");
    expect(start).not.toContain("--approve");
    expect(start[start.indexOf("--exclude-tools") + 1]).toBe(
      "agent_run,agent_supervise,agent_spawn,agent_status,agent_result,agent_cancel,team_assign,team_status,team_result,team_cancel",
    );
    const preamble = start[start.indexOf("--append-system-prompt") + 1] ?? "";
    expect(preamble).not.toContain("AgentInstance");
    expect(preamble).toContain(role.instructions);
    expect(prompt).toEqual(["agent", "prompt", instanceId, "Inspect the diff", "--wait"]);
    expect(calls.flat()).not.toContain("--approve");
    expect(calls.flat()).not.toContain("--timeout");
    expect(calls.some((args) => args[1] === "close" || args.includes("report-agent") || args[1] === "run" || args[1] === "send-text")).toBe(false);
    expect(result).toEqual({ instanceId, paneId: NEW_PANE, agent_status: "done" });
    expect(JSON.stringify(result)).not.toContain("SECRET_TRANSCRIPT");
  });

  test("omitted reasoning does not pass --thinking, and a tall pane splits down", async () => {
    const { calls, run } = scripted({ "pane layout": ok(layoutJson(40, 80)) });
    await superviseAgent(superviseInput(run, { load: developerLoad() }));
    const split = calls.find((args) => args[1] === "split") ?? [];
    const start = calls.find((args) => args[1] === "start") ?? [];
    expect(split[split.indexOf("--direction") + 1]).toBe("down");
    expect(start).not.toContain("--thinking");
    const equal = scripted({ "pane layout": ok(layoutJson(40, 40)) });
    await superviseAgent(superviseInput(equal.run, { load: developerLoad() }));
    const equalSplit = equal.calls.find((args) => args[1] === "split") ?? [];
    expect(equalSplit[equalSplit.indexOf("--direction") + 1]).toBe("right");
  });

  test("start agent_not_ready or timeout does not prompt and leaves the pane open", async () => {
    for (const code of ["agent_not_ready", "timeout"]) {
      const { calls, run } = scripted({ "agent start": fail(code) });
      const result = await superviseAgent(superviseInput(run));
      expect(result.agent_status).toBe(code);
      expect(result.paneId).toBe(NEW_PANE);
      expect(calls.some((args) => args[1] === "prompt" || args[1] === "close")).toBe(false);
    }
  });

  test("prompt outcomes do not close the pane or resubmit", async () => {
    const cases: Array<{ status: string; result: HerdrCommandResult; read: boolean }> = [
      { status: "idle", result: ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } })), read: false },
      { status: "done", result: ok(JSON.stringify({ result: { agent: { agent_status: "done" }, text: "SECRET_TRANSCRIPT" } })), read: false },
      { status: "blocked", result: ok(JSON.stringify({ result: { agent: { agent_status: "blocked" } } })), read: true },
      { status: "unknown", result: ok(JSON.stringify({ result: { agent: { agent_status: "unknown" } } })), read: false },
      { status: "agent_blocked", result: fail("agent_blocked"), read: true },
      { status: "agent_prompt_stalled", result: fail("agent_prompt_stalled"), read: false },
      { status: "timeout", result: fail("timeout"), read: false },
      { status: "agent_not_ready", result: fail("agent_not_ready"), read: false },
    ];
    for (const item of cases) {
      const { calls, run } = scripted({ "agent prompt": item.result });
      const result = await superviseAgent(superviseInput(run));
      expect(result.agent_status).toBe(item.status);
      expect(calls.filter((args) => args[1] === "prompt")).toHaveLength(1);
      expect(calls.some((args) => args[1] === "close")).toBe(false);
      const read = calls.find((args) => args[1] === "read");
      if (item.read) {
        expect(read).toEqual(["agent", "read", result.instanceId, "--source", "recent-unwrapped", "--lines", "40"]);
        expect(result.excerpt).toContain("BLOCKED_EXCERPT");
      } else {
        expect(read).toBeUndefined();
        expect(result.excerpt).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain("SECRET_TRANSCRIPT");
      }
    }
  });

  test("closes the pane when start fails before a live agent", async () => {
    const { calls, run } = scripted({ "agent start": fail("agent_start_failed") });
    await expect(superviseAgent(superviseInput(run))).rejects.toThrow(/agent start failed/);
    expect(calls.some((args) => args[1] === "prompt")).toBe(false);
    expect(calls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === NEW_PANE)).toBe(true);
    expect(calls.some((args) => args[1] === "send-keys")).toBe(false);
  });

  test("parent abort sends ctrl+c and then closes the created pane", async () => {
    const ac = new AbortController();
    const { calls, run } = scripted({
      "agent prompt": async () => {
        ac.abort();
        throw new Error("aborted");
      },
    });
    await expect(superviseAgent(superviseInput(run, { signal: ac.signal }))).rejects.toThrow(/cancelled/);
    const start = calls.find((args) => args[1] === "start");
    const instanceId = start?.[2];
    if (!instanceId) throw new Error("missing instance id");
    const send = calls.findIndex((args) => args[1] === "send-keys");
    const close = calls.findIndex((args) => args[1] === "close");
    expect(calls[send]).toEqual(["agent", "send-keys", instanceId, "ctrl+c"]);
    expect(calls[close]).toEqual(["pane", "close", NEW_PANE]);
    expect(close).toBeGreaterThan(send);
    expect(calls.filter((args) => args[1] === "prompt")).toHaveLength(1);
  });

  test("a second overlapping call fails without a queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls: string[][] = [];
    const run: HerdrRunner = async (args) => {
      calls.push([...args]);
      if (args[1] === "layout") await gate;
      return respond(args);
    };
    const first = superviseAgent(superviseInput(run));
    const second = await superviseAgent(superviseInput(scripted().run)).then(() => "queued", (error: Error) => error.message);
    expect(second).toMatch(/already in flight/);
    expect(calls.filter((args) => args[1] === "split")).toHaveLength(0);
    release();
    await first;
    expect(calls.filter((args) => args[1] === "split")).toHaveLength(1);
  });
});
