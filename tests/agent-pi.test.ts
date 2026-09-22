import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { classifyProviderFailure } from "../extensions/agent/fallback.ts";
import { activateTarget } from "../extensions/agent/pi.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pi adapter boundary", () => {
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
      expect(levels).toEqual([]);
    } finally {
      session.dispose();
    }
  }, 60_000);
});
