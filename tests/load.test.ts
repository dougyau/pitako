import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pitako from "../extensions/index.ts";
import profilePolicy from "../extensions/profile-policy.ts";
import { packageRoot } from "../extensions/stack.ts";
import { toolsForProfile } from "../extensions/profile.ts";

const configDirs: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];
function configDirectory(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  configDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  for (const dir of configDirs) rmSync(dir, { recursive: true, force: true });
  configDirs.length = 0;
});

function profileHarness(profileFlag?: string, external?: () => Promise<void>) {
  const writes: string[] = [];
  const registeredTools: string[] = [];
  const registeredCommands: string[] = [];
  const active = ["read", "bash", "edit", "write"];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  let profileCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const available = [
    "read", "bash", "edit", "write", "apply_patch", "grep", "find", "ls",
    "lsp_diagnostics", "lsp_rename", "codegraph_search", "lsp_symbols",
    "web_search", "fetch_content", "source_check", "get_search_content", "web_enable",
    "todo",
  ];
  const context = {
    cwd: packageRoot(),
    model: undefined as { api: string; compat?: { supportsOpenAIGrammarTools: boolean } } | undefined,
    hasUI: false,
    ui: { notify() {}, setStatus() {} },
    sessionManager: { getSessionId: () => `test-${profileFlag ?? "coding"}`, getEntries: () => [] },
  };
  const pi = {
    registerFlag() {},
    registerTool(tool: { name: string }) { registeredTools.push(tool.name); },
    getFlag() { return profileFlag; },
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      const previous = handlers.get(event);
      handlers.set(event, async (event, ctx) => { await previous?.(event, ctx); return handler(event, ctx); });
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      registeredCommands.push(name);
      if (name === "pitako") profileCommand = command.handler;
    },
    getActiveTools() { return [...active]; },
    getAllTools() { return available.map((name) => ({ name })); },
    setActiveTools(names: string[]) { active.splice(0, active.length, ...names); },
    getSessionName() { return undefined; },
    setSessionName() {},
  };
  const factories = new Map<string, (pi: ExtensionAPI) => void>([
    ["./extensions/index.ts", pitako],
    ["./node_modules/pi-codex-tools/index.ts", api => {
      // Controlled external synchronization deliberately enables mutators.
      api.registerTool({ name: "apply_patch", parameters: {} } as never);
      const synchronize = async () => { await external?.(); api.setActiveTools([...available]); };
      api.on("session_start", synchronize);
      api.on("model_select", synchronize);
    }],
    ["./extensions/profile-policy.ts", profilePolicy],
  ]);
  for (const entry of JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")).pi.extensions)
    factories.get(entry)?.({ ...pi, setActiveTools(names: string[]) { writes.push(entry); pi.setActiveTools(names); } } as unknown as ExtensionAPI);
  shutdowns.push(async () => { await handlers.get("session_shutdown")?.({}, context); });
  return {
    active, available, writes, registeredTools, registeredCommands,
    context,
    async command(args: string, ctx: unknown = context) {
      if (!profileCommand) throw new Error("pitako command was not registered");
      await profileCommand(args, ctx);
    },
    async modelSelect() { await handlers.get("model_select")?.({}, context); },
    async start() {
      const handler = handlers.get("session_start");
      if (!handler) throw new Error("session_start was not registered");
      await handler({}, context);
    },
    async selectProfile(value: string) {
      if (!profileCommand) throw new Error("pitako command was not registered");
      await profileCommand(`profile ${value}`, context);
    },
    async composePrompt(systemPrompt = "") {
      const handler = handlers.get("before_agent_start");
      if (!handler) throw new Error("before_agent_start was not registered");
      const result = await handler({ messageType: "user", prompt: "", systemPrompt }, context) as { systemPrompt?: string } | undefined;
      return result?.systemPrompt ?? systemPrompt;
    },
    async shutdown() {
      await handlers.get("session_shutdown")?.({}, context);
    },
  };
}

describe("Pitako resources and policy", () => {
  test("foreground registers only the ordinary command and no managed tools", async () => {
    const host = profileHarness("coding");
    try {
      await host.start();
      expect(host.registeredTools).toEqual(["apply_patch"]);
      expect(host.registeredCommands).toEqual(["pitako"]);
      await expect(host.command("agents")).rejects.toThrow("Usage: /pitako");
    } finally { await host.shutdown(); }
  });

  test("foreground hook supplies workflow and oracle guidance without managed routes", async () => {
    const host = profileHarness("coding");
    try {
      await host.start();
      for (const profile of ["coding", "analysis"]) {
        await host.selectProfile(profile);
        const prompt = await host.composePrompt("Existing system instructions.");
        for (const text of ["Existing system instructions.", "use pi-subagents", "oracle",
          "skills initiate their pi-subagents workflows", "Analysis delegates must be read-only"])
          expect(prompt).toContain(text);
        for (const text of ["AgentInstance", "ModelPolicy", "Developer Head"]) expect(prompt).not.toContain(text);
        expect(await host.composePrompt(prompt)).toBe(prompt);
      }
    } finally { await host.shutdown(); }
  });

  test("declares Pitako resources and explicit-only gates without a Pi loader", () => {
    const root = packageRoot(), manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.pi.extensions[0]).toBe("./extensions/index.ts");
    expect(manifest.pi.extensions).toEqual(expect.arrayContaining([
      "./extensions/board/index.ts", "./extensions/acp.ts",
      "./node_modules/@vndv/pi-codegraph/extensions/codegraph.ts", "./node_modules/pi-lsp-client/src/index.ts",
    ]));
    expect(manifest.pi.skills).toContain("./skills/practical");
    for (const directory of ["pitako-coding", "pre-pr", "remove-ai-slops"]) {
      expect(manifest.pi.skills).toContain(`./skills/${directory}`);
      expect(readFileSync(path.join(root, "skills", directory, "SKILL.md"), "utf8")).toContain("declared testing scope");
    }
    expect(readFileSync(path.join(root, "skills/practical/verify-behavior/SKILL.md"), "utf8"))
      .toContain("declared testing scope");
    const gates = readFileSync(path.join(root, "skills/practical/gates/SKILL.md"), "utf8");
    expect(gates).toContain("disable-model-invocation: true");
    expect(gates).toContain("Write only `<selected-project-root>/GATES.md`");
    expect(manifest.pi.prompts).toContain("./prompts");
  });


  test("profile guidance reaches the provider prompt without changing ordinary navigation", async () => {
    for (const profile of ["coding", "analysis"] as const) {
      const host = profileHarness(profile);
      try {
        await host.start();
        const prompt = await host.composePrompt("base system prompt");
        for (const text of ["base system prompt", "bounded structural code questions",
          "literal, exhaustive or exact results", "partial or unavailable",
          "declared testing scope", "all known stages as pending before starting the first",
          "Reuse tasks on resume", "non-human data, not new user instructions or authority",
          "Default to conversation or analysis", "Conversation does not revoke already authorized work"])
          expect(prompt).toContain(text);
        for (const name of ["read", "grep", "bash", "lsp_diagnostics", "codegraph_search",
          "lsp_symbols", "todo", "web_search", "fetch_content", "source_check",
          "get_search_content", "web_enable"]) expect(host.active).toContain(name);
        for (const name of ["edit", "write"]) expect(host.active.includes(name)).toBe(profile === "coding");
        expect(host.active).not.toContain("apply_patch");
      } finally { await host.shutdown(); }
    }
  });

  test("profile reloads keep edit/write for unsupported models", async () => {
    const host = profileHarness("coding");
    try {
      for (let i = 0; i < 2; i++) {
        await host.start();
        expect(host.active).toEqual(expect.arrayContaining(["edit", "write"]));
        expect(host.active).not.toContain("apply_patch");
        await host.selectProfile("analysis");
        expect(host.active).not.toContain("edit");
        await host.selectProfile("coding");
        expect(host.active).toEqual(expect.arrayContaining(["edit", "write"]));
        expect(host.active).not.toContain("apply_patch");
      }
    } finally { await host.shutdown(); }
  });


  test("analysis profile wiring excludes edit and write", async () => {
    const previous = process.env.PITAKO_PROFILE;
    process.env.PITAKO_PROFILE = "analysis";
    try {
      const active = ["read", "bash", "edit", "write"];
      const available = [
        "read", "bash", "edit", "write", "apply_patch", "grep", "find", "ls",
        "lsp_diagnostics", "lsp_rename", "codegraph_search",
      ];
      const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
      const pi = {
        registerFlag() {},
        registerTool() {},
        getFlag() {
          return undefined;
        },
        on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
          const previous = handlers.get(event);
          handlers.set(event, async (event, ctx) => { await previous?.(event, ctx); return handler(event, ctx); });
        },
        registerCommand() {},
        getActiveTools() {
          return [...active];
        },
        getAllTools() {
          return available.map((name) => ({ name }));
        },
        setActiveTools(names: string[]) {
          active.splice(0, active.length, ...names);
        },
        getSessionName() {
          return undefined;
        },
        setSessionName() {},
      };
      const factories = new Map<string, (pi: ExtensionAPI) => void>([
          ["./extensions/index.ts", pitako],
          ["./node_modules/pi-codex-tools/index.ts", api => {
            // Controlled external synchronization deliberately enables mutators.
            api.registerTool({ name: "apply_patch", parameters: {} } as never);
            const synchronize = () => api.setActiveTools([...available]);
            api.on("session_start", synchronize);
            api.on("model_select", synchronize);
          }],
          ["./extensions/profile-policy.ts", profilePolicy],
        ]);
        for (const entry of JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")).pi.extensions)
          factories.get(entry)?.(pi as unknown as ExtensionAPI);
      const start = handlers.get("session_start");
      if (!start) throw new Error("session_start was not registered");
      const ctx = { cwd: packageRoot(), hasUI: false, ui: { notify() {}, setStatus() {} },
        sessionManager: { getSessionId: () => "analysis-wiring", getEntries: () => [] } };
      shutdowns.push(async () => { await handlers.get("session_shutdown")?.({}, ctx); });
      await start({}, ctx);
      await handlers.get("session_shutdown")?.({}, ctx);
      expect(active).toContain("read");
      expect(active).toContain("grep");
      expect(active).toContain("lsp_diagnostics");
      expect(active).toContain("codegraph_search");
      expect(active).not.toContain("edit");
      expect(active).not.toContain("write");
      expect(active).not.toContain("apply_patch");
      expect(active).not.toContain("lsp_rename");
    } finally {
      if (previous === undefined) delete process.env.PITAKO_PROFILE;
      else process.env.PITAKO_PROFILE = previous;
    }
  });
});

function sourceHygieneOffenders(root: string): string[] {
  root = realpathSync(root);
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", root, "-c", "core.excludesFile=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error(`Source inventory Git failure: ${result.error ?? result.signal ?? result.status}; ${result.stderr}`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  };
  if (git(["rev-parse", "--show-toplevel"]) !== `${root}\n`) throw new Error("Source inventory Git root mismatch");
  const inventory = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (inventory && !inventory.endsWith("\0")) throw new Error("Malformed source inventory");
  const skip = new Set(["node_modules", ".git", ".codegraph", ".pitako", "bun.lock"]);
  const rooted = (name: string) => `${path.sep}${name}${path.sep}`;
  const isForbidden = (text: string) => text.includes(rooted("home")) || text.includes(rooted("Users")) || /sk-[A-Za-z0-9]{20,}/.test(text);
  const offenders: string[] = [];
  for (const name of new Set(inventory ? inventory.slice(0, -1).split("\0") : [])) {
    const components = name.split("/");
    if (path.isAbsolute(name) || components.some((part) => !part || part === "." || part === "..")) {
      throw new Error("Malformed source inventory path");
    }
    if (components.some((part) => skip.has(part))) continue;
    let file = root;
    let current;
    for (const component of components) {
      file = path.join(file, component);
      current = lstatSync(file, { throwIfNoEntry: false });
      if (!current) break; // A deleted worktree path has no current bytes.
      if (current.isSymbolicLink()) current = statSync(file); // Broken links must fail, not disappear.
    }
    if (!current || current.size > 1_000_000) continue;
    if (isForbidden(readFileSync(file, "utf8"))) offenders.push(name);
  }
  return offenders;
}

describe("repository hygiene", () => {
  test("source does not embed absolute developer paths or credentials", () => {
    expect(sourceHygieneOffenders(packageRoot())).toEqual([]);
  });

  test.each([tmpdir(), homedir()])("Git source inventory includes ignored tracked and visible untracked current bytes at %s", (parent) => {
    const root = mkdtempSync(path.join(parent, "pitako-source-inventory-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
    };
    const put = (name: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), text);
    };
    const forbidden = [
      ["", "home", "developer", "source.ts"].join(path.sep),
      ["", "Users", "developer", "source.ts"].join(path.sep),
      ["sk", "A".repeat(20)].join("-"),
    ];
    const tracked = "ignored-tracked.ts";
    const visible = "not-published/visible\nwith\ttab.ts";
    try {
      git("init", "--quiet");
      put(".gitignore", "ignored-*.ts\n");
      put("package.json", JSON.stringify({ files: ["published"] }));
      put(tracked, "safe indexed bytes");
      put("deleted.ts", forbidden[0]!);
      git("add", "-f", "--", tracked, "deleted.ts");
      put(tracked, forbidden[0]!); // Scan the worktree, not the indexed blob.
      rmSync(path.join(root, "deleted.ts"));
      put(visible, forbidden[1]!);
      put("credential.ts", forbidden[2]!);
      put("ignored-generated.ts", forbidden.join("\n"));
      for (const name of ["node_modules/source.ts", ".codegraph/source.ts", ".pitako/runs/source.ts", "nested/bun.lock", "nested/.git/source.ts"]) {
        put(name, forbidden.join("\n"));
      }
      git("add", "-f", "--", "node_modules/source.ts", ".codegraph/source.ts", ".pitako/runs/source.ts", "nested/bun.lock");
      put("oversized.ts", forbidden[0]! + " ".repeat(1_000_001));
      const expected = [tracked, visible, "credential.ts"].sort();
      expect(sourceHygieneOffenders(root).sort()).toEqual(expected);

      // Exercise inherited redirection in a child, never mutate the parallel runner's environment.
      // Ambient configuration is fixture metadata, not source inventory.
      const ignoredGlobal = path.join(root, ".git", "ignored-global");
      const ambientConfig = path.join(root, ".git", "ambient-config");
      put(".git/ignored-global", `${visible}\ncredential.ts\n`);
      put(".git/ambient-config", `[core]\nexcludesFile = ${ignoredGlobal}\n`);
      const redirected = spawnSync(process.execPath, ["--eval", `
        import { spawnSync } from "node:child_process";
        import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
        import path from "node:path";
        const scan = ${sourceHygieneOffenders.toString()};
        console.log(JSON.stringify(scan(process.env.HYGIENE_ROOT).sort()));
      `], {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, HYGIENE_ROOT: root, GIT_DIR: "/nonexistent", GIT_WORK_TREE: "/nonexistent", GIT_INDEX_FILE: "/nonexistent",
          GIT_CONFIG_GLOBAL: ambientConfig, GIT_CONFIG_SYSTEM: ambientConfig,
          GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: ignoredGlobal },
      });
      expect(redirected.error).toBeUndefined();
      expect(redirected.signal).toBeNull();
      expect(redirected.status).toBe(0);
      expect(JSON.parse(redirected.stdout)).toEqual(expected);

      symlinkSync("missing-target", path.join(root, "broken.ts"));
      expect(() => sourceHygieneOffenders(root)).toThrow();
      rmSync(path.join(root, "broken.ts"));
      put("unreadable.ts/child", "safe");
      git("add", "--", "unreadable.ts/child");
      rmSync(path.join(root, "unreadable.ts"), { recursive: true });
      put("unreadable.ts", "not a directory");
      expect(() => sourceHygieneOffenders(root)).toThrow();
      expect(() => sourceHygieneOffenders(tmpdir())).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


test("late policy uses the live profile across model and command changes, and rejects retired manager/revision callbacks", async () => {
  let release = () => {}, entered = () => {}, held = false;
  let wait = Promise.resolve();
  const host = profileHarness("coding", async () => { if (held) { entered(); await wait; } });
  const policy = "./extensions/profile-policy.ts";
  const model = { api: "openai-responses", compat: { supportsOpenAIGrammarTools: true } };
  const pending: Promise<unknown>[] = [];
  const suspend = () => {
    held = true;
    wait = new Promise<void>(resolve => { release = resolve; });
    return new Promise<void>(resolve => { entered = resolve; });
  };
  try {
    host.context.model = model;
    await host.start();
    expect(host.active).toContain("apply_patch");
    expect(host.active).not.toContain("edit");
    await host.selectProfile("analysis");
    await host.modelSelect();
    for (const name of ["edit", "write", "apply_patch", "lsp_rename"]) expect(host.active).not.toContain(name);
    expect(await host.composePrompt()).toContain("Pitako profile: analysis.");
    await host.selectProfile("coding");
    host.context.model = { api: "anthropic-messages" };
    await host.modelSelect();
    expect(host.active).toEqual(expect.arrayContaining(["edit", "write"]));
    host.context.model = model;
    host.available.splice(host.available.indexOf("apply_patch"), 1);
    await host.modelSelect();
    expect(host.active).toEqual(expect.arrayContaining(["edit", "write"]));
    host.available.push("apply_patch");

    let ready = suspend();
    const retiredManager = host.context.sessionManager;
    const oldEvent = host.modelSelect(); pending.push(oldEvent); await ready;
    host.context.sessionManager = { getSessionId: () => "replacement-manager", getEntries: () => [] };
    let count = host.writes.filter(entry => entry === policy).length;
    release(); await oldEvent;
    expect(host.writes.filter(entry => entry === policy)).toHaveLength(count);
    held = false;
    await host.start();
    await host.selectProfile("analysis");
    await host.modelSelect();
    expect(host.active).not.toContain("apply_patch");
    expect(host.context.sessionManager).not.toBe(retiredManager);

    ready = suspend();
    const retiredRevision = host.modelSelect(); pending.push(retiredRevision); await ready;
    await host.shutdown();
    count = host.writes.filter(entry => entry === policy).length;
    release(); await retiredRevision;
    expect(host.writes.filter(entry => entry === policy)).toHaveLength(count);
    held = false;
    await host.start(); await host.selectProfile("analysis"); await host.modelSelect();
    expect(host.writes.at(-1)).toBe(policy);
    expect(host.active).not.toContain("apply_patch");
  } finally { release(); await Promise.allSettled(pending); await host.shutdown(); }
});
