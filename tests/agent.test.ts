import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentInstance from "../extensions/agent/index.ts";
import { currentInstanceId, agentScope } from "../extensions/agent/scope.ts";
import { classifyProviderFailure } from "../extensions/agent/fallback.ts";
import { childInstructions, runAgentInstance, skillNamesForRole, type Attempt, type AttemptExecutor } from "../extensions/agent/run.ts";
import { withBoardAuthor, currentBoardAuthor } from "../extensions/board/author.ts";
import { openBoard } from "../extensions/board/store.ts";
import { currentWorkspace } from "../extensions/board/workspace.ts";
import pitako from "../extensions/index.ts";
import { resolveRole } from "../extensions/roles/load.ts";
import { packageRoot } from "../extensions/stack.ts";
import { loadPitako, registeredToolNames } from "../scripts/load-pitako.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envFor(dir: string): NodeJS.ProcessEnv {
  return { PI_CODING_AGENT_DIR: dir };
}

function tempEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-agent-"));
  tempDirs.push(dir);
  return envFor(dir);
}

function scripted(attempts: Attempt[]): AttemptExecutor & { starts: string[]; notes: string[] } {
  const starts: string[] = [];
  const notes: string[] = [];
  return {
    starts,
    notes,
    async start(input) {
      starts.push(input.target.model);
      expect(input.task).toBe("review the boundary");
      expect(input.task).not.toContain("PARENT-TRANSCRIPT");
      const attempt = attempts.shift() ?? { status: "failed", result: "", error: "exhausted", sideEffects: false };
      return {
        ...attempt,
        session: attempt.session ?? {
          async continueWith(target, note) {
            notes.push(`${target.model}:${note}`);
            return attempts.shift() ?? { status: "failed", result: "", error: "no continue", sideEffects: true };
          },
          async dispose() {},
        },
      };
    },
  };
}

describe("agent instance", () => {
  test("resolves architect, isolates context, and does not replay side effects", async () => {
    const env = tempEnv();
    const cwd = packageRoot();
    const role = resolveRole("architect", { env });
    expect(role.modelPolicy.primary).toBeUndefined();
    await expect(runAgentInstance({ roleId: "missing", task: "x", cwd, executor: scripted([]), load: { env } })).rejects.toThrow(/unknown role/);
    await expect(runAgentInstance({ roleId: "architect", task: "x", cwd, executor: scripted([]), load: { env } })).rejects.toThrow(/no primary target/);

    const configured = {
      env,
      userConfigPath: path.join(env.PI_CODING_AGENT_DIR!, "pitako", "config.toml"),
    };
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.dirname(configured.userConfigPath), { recursive: true });
    writeFileSync(
      configured.userConfigPath,
      `[model_policies.architect.primary]
model = "example/primary"
reasoning = "high"
[[model_policies.architect.fallbacks]]
model = "example/fallback-1"
reasoning = "xhigh"
[[model_policies.architect.fallbacks]]
model = "example/fallback-2"
reasoning = "medium"
`,
    );
    const resolved = resolveRole("architect", configured);
    expect(resolved.modelPolicy.primary?.model).toBe("example/primary");
    expect(resolved.modelPolicy.fallbacks.map((target) => target.model)).toEqual(["example/fallback-1", "example/fallback-2"]);
    expect(skillNamesForRole(resolved)).toContain("architect");
    expect(skillNamesForRole(resolved)).toContain("ponytail");
    expect(skillNamesForRole(resolved)).not.toContain("tdd");
    const prompt = childInstructions(resolved, "architect-abc123");
    expect(prompt).toContain("You own system structure");
    expect(prompt).not.toContain("PARENT-TRANSCRIPT");

    const rateLimited = scripted([
      { status: "failed", result: "", error: "429 rate limit", sideEffects: false },
      { status: "completed", result: "sketch", sideEffects: false },
    ]);
    const first = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd,
      executor: rateLimited,
      load: configured,
    });
    expect(first.status).toBe("completed");
    expect(first.model.selectedModel).toBe("example/fallback-1");
    expect(first.model.reasoning).toBe("xhigh");
    expect(first.model.fallbackIndex).toBe(0);
    expect(first.model.fallbackReason).toBe("rate_limit");
    expect(rateLimited.starts).toEqual(["example/primary", "example/fallback-1"]);
    expect(first.instanceId.startsWith("architect-")).toBe(true);
    expect(first.instanceId).not.toBe("architect");
    expect(currentWorkspace(cwd)).toBe(currentWorkspace(first.instanceId ? cwd : cwd));

    const replay = scripted([
      {
        status: "failed",
        result: "",
        error: "503 unavailable",
        sideEffects: true,
        session: {
          async continueWith(target, note) {
            replay.notes.push(note);
            expect(target.model).toBe("example/fallback-1");
            return { status: "completed", result: "continued", sideEffects: true };
          },
          async dispose() {},
        },
      },
    ]);
    const continued = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd,
      executor: replay,
      load: configured,
    });
    expect(continued.result).toBe("continued");
    expect(replay.starts).toEqual(["example/primary"]);
    expect(replay.notes[0]).toContain("Do not repeat completed side effects");

    const taskFailure = scripted([{ status: "failed", result: "", error: "tests failed in the repository", sideEffects: true }]);
    const stayed = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd,
      executor: taskFailure,
      load: configured,
    });
    expect(stayed.status).toBe("failed");
    expect(taskFailure.starts).toEqual(["example/primary"]);

    const controller = new AbortController();
    const cancelled = scripted([
      {
        status: "cancelled",
        result: "cancelled",
        sideEffects: false,
      },
    ]);
    controller.abort();
    const aborted = await runAgentInstance({
      roleId: "architect",
      task: "review the boundary",
      cwd,
      signal: controller.signal,
      executor: cancelled,
      load: configured,
    });
    expect(aborted.status).toBe("cancelled");
    expect(cancelled.starts).toEqual([]);
  });

  test("fallback classification is narrow", () => {
    expect(classifyProviderFailure("429 too many requests")).toBe("rate_limit");
    expect(classifyProviderFailure("insufficient_quota")).toBe("quota");
    expect(classifyProviderFailure("Codex error: The usage limit has been reached")).toBe("quota");
    expect(classifyProviderFailure("invalid api key")).toBe("auth");
    expect(classifyProviderFailure("503 service unavailable")).toBe("unavailable");
    expect(classifyProviderFailure("tests failed")).toBeUndefined();
    expect(classifyProviderFailure("compilation failed")).toBeUndefined();
    expect(classifyProviderFailure(undefined)).toBeUndefined();
  });

  test("Board author follows the instance and todos stay on the session id", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pitako-agent-board-"));
    tempDirs.push(dir);
    const db = path.join(dir, "board.db");
    const board = await openBoard(db);
    const topic = board.createTopic("/repo", { title: "shared" });
    expect(topic.createdBy).toBe("pi");
    await withBoardAuthor("architect-a31f2c", async () => {
      expect(currentBoardAuthor()).toBe("architect-a31f2c");
      board.post("/repo", { topicId: topic.id, type: "FINDING", content: "from the child" });
    });
    expect(currentBoardAuthor()).toBe("pi");
    const page = board.readTopic("/repo", topic.id);
    expect(page.posts[0]?.author).toBe("architect-a31f2c");
    board.close();

    const parent = SessionManager.inMemory(packageRoot());
    const child = SessionManager.inMemory(packageRoot());
    expect(parent.getSessionId()).not.toBe(child.getSessionId());
    expect(currentWorkspace(packageRoot())).toBe(currentWorkspace(packageRoot()));
  });

  test("agent_run is registered, refused inside an instance, and Pitako still loads", async () => {
    const loaded = await loadPitako(packageRoot());
    expect(registeredToolNames(loaded.extensions)).toContain("agent_run");
    expect(registeredToolNames(loaded.extensions)).toContain("board_post");
    expect(registeredToolNames(loaded.extensions)).toContain("todo");

    const tools = new Map<string, { execute: Function }>();
    const active: string[] = [];
    const pi = {
      registerTool(def: { name: string; execute: Function }) {
        tools.set(def.name, def);
      },
      registerFlag() {},
      getFlag() {
        return undefined;
      },
      on(event: string, handler: (event: unknown, ctx: { hasUI: boolean; ui: { notify(): void; setStatus(): void } }) => Promise<void>) {
        if (event === "session_start") {
          void agentScope.run({ instanceId: "architect-test" }, () =>
            handler({}, { hasUI: false, ui: { notify() {}, setStatus() {} } }),
          );
        }
      },
      registerCommand() {},
      getActiveTools() {
        return ["agent_run", "read"];
      },
      getAllTools() {
        return [{ name: "agent_run" }, { name: "read" }];
      },
      setActiveTools(names: string[]) {
        active.splice(0, active.length, ...names);
      },
      getSessionName() {
        return "kept";
      },
      setSessionName() {},
    };
    pitako(pi as unknown as ExtensionAPI);
    agentInstance(pi as unknown as ExtensionAPI);
    expect(active.includes("agent_run")).toBe(false);
    expect(currentInstanceId()).toBeUndefined();
    const tool = tools.get("agent_run");
    if (!tool) throw new Error("agent_run missing");
    const nested = await agentScope.run({ instanceId: "architect-test" }, () =>
      tool.execute("id", { role: "architect", task: "no" }, undefined, undefined, { cwd: packageRoot() }),
    );
    expect(nested.isError).toBe(true);
    expect(nested.details.error).toMatch(/cannot be called/);
  });
});
