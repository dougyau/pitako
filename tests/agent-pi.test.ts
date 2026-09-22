import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { classifyProviderFailure } from "../extensions/agent/fallback.ts";
import { activateTarget, DEFAULT_THINKING_LEVEL } from "../extensions/agent/pi.ts";
import { childActiveTools } from "../extensions/profile.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pi adapter boundary", () => {
  test("construction enables grep, find, and ls without session_start", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-agent-tools-"));
    tempDirs.push(agentDir);
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-agent-tools-cwd-"));
    tempDirs.push(cwd);
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    const model = runtime.getModels()[0];
    if (!model) throw new Error("Pi static catalog has no model");
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      modelRuntime: runtime,
      excludeTools: ["agent_run"],
    });
    try {
      const available = session.getAllTools().map((tool) => tool.name);
      session.setActiveToolsByName(childActiveTools(available));
      const active = session.getActiveToolNames();
      expect(available).toEqual(expect.arrayContaining(["grep", "find", "ls", "read"]));
      expect(active).toEqual(expect.arrayContaining(["grep", "find", "ls", "read"]));
      expect(active).not.toContain("agent_run");
    } finally {
      session.dispose();
    }
  }, 60_000);
  test("in-memory session starts empty, setModel auth failure is fallback-worthy, and reasoning is not forced", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-agent-pi-"));
    tempDirs.push(agentDir);
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-agent-cwd-"));
    tempDirs.push(cwd);
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const model = runtime.getModels()[0];
    if (!model) throw new Error("Pi static catalog has no model");
    const parent = SessionManager.inMemory(cwd);
    const child = SessionManager.inMemory(cwd);
    expect(parent.getSessionId()).not.toBe(child.getSessionId());
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      sessionManager: child,
      modelRuntime: runtime,
      excludeTools: ["agent_run"],
      noTools: "builtin",
    });
    try {
      expect(session.messages).toEqual([]);
      session.setActiveToolsByName(childActiveTools(session.getAllTools().map((tool) => tool.name)));
      const active = session.getActiveToolNames();
      for (const name of ["grep", "find", "ls", "read"]) {
        if (session.getAllTools().some((tool) => tool.name === name)) expect(active).toContain(name);
      }
      expect(active).not.toContain("agent_run");
      await expect(session.setModel(model, { persist: false })).rejects.toThrow(/No API key/);
      const thrown = await activateTarget(
        {
          async setModel() {
            throw new Error("No API key for cursor/grok-4.7");
          },
          setThinkingLevel() {
            throw new Error("should not set reasoning when activation fails");
          },
        },
        model,
        { model: "cursor/grok-4.7" },
      );
      expect(thrown).toMatch(/No API key/);
      expect(classifyProviderFailure(thrown)).toBe("auth");
      const levels: string[] = [];
      await activateTarget(
        {
          async setModel() {},
          setThinkingLevel(level: string) {
            levels.push(level);
          },
        },
        model,
        { model: "example/explicit", reasoning: "high" },
      );
      expect(levels).toEqual(["high"]);
      levels.length = 0;
      await activateTarget(
        {
          async setModel() {},
          setThinkingLevel(level: string) {
            levels.push(level);
          },
        },
        model,
        { model: "example/default" },
      );
      expect(levels).toEqual([DEFAULT_THINKING_LEVEL]);
    } finally {
      session.dispose();
    }
  }, 60_000);

  test("continue without reasoning does not inherit xhigh", async () => {
    let level = "xhigh";
    await activateTarget(
      {
        async setModel() {},
        setThinkingLevel(next: string) {
          level = next;
        },
      },
      { provider: "example", id: "continue" } as never,
      { model: "example/continue" },
    );
    expect(level).not.toBe("xhigh");
    expect(level).toBe(DEFAULT_THINKING_LEVEL);
  });
});
