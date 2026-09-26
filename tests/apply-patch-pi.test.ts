import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { loadPitako } from "../scripts/load-pitako.ts";
import { childActiveTools, toolsForProfile } from "../extensions/profile.ts";
import { packageRoot } from "../extensions/stack.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("apply_patch Pi result hook", () => {
  test("Pi loader keeps tool registered and scopes activation by AgentInstance role", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pitako-patch-policy-"));
    tempDirs.push(cwd);
    const loaded = await loadPitako(packageRoot(), cwd);
    tempDirs.push(loaded.agentDir);
    const runtime = await ModelRuntime.create({
      authPath: path.join(loaded.agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    runtime.registerProvider("pitako-policy-test", {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1",
      apiKey: "test",
      models: [{
        id: "policy",
        name: "Policy",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 2000,
        maxTokens: 128,
      }],
    });
    const model = runtime.getModel("pitako-policy-test", "policy");
    if (!model) throw new Error("policy test model was not registered");
    const create = () => createAgentSession({
      cwd,
      agentDir: loaded.agentDir,
      model,
      modelRuntime: runtime,
      resourceLoader: loaded.loader,
      settingsManager: SettingsManager.create(cwd, loaded.agentDir, { projectTrusted: true }),
      sessionManager: SessionManager.inMemory(cwd),
    });
    const foreground = await create();
    try {
      const available = foreground.session.getAllTools().map((tool) => tool.name);
      expect(available).toContain("apply_patch");
      foreground.session.setActiveToolsByName(toolsForProfile({ available, profile: "coding" }));
      expect(foreground.session.getActiveToolNames()).not.toContain("apply_patch");
      await foreground.session.setModel(model, { persist: false });
      expect(foreground.session.getActiveToolNames()).not.toContain("apply_patch");
    } finally {
      foreground.session.dispose();
    }

    for (const roleId of ["architect", "reviewer", "researcher", "developer", "scout"]) {
      const child = await create();
      try {
        const available = child.session.getAllTools().map((tool) => tool.name);
        expect(available).toContain("apply_patch");
        child.session.setActiveToolsByName(childActiveTools(available, process.platform, roleId));
        expect(child.session.getActiveToolNames().includes("apply_patch")).toBe(roleId === "developer");
        if (roleId === "scout") {
          for (const name of ["edit", "write", "apply_patch", "lsp_rename"]) expect(child.session.getActiveToolNames()).not.toContain(name);
          expect(child.session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash"]));
        }
        child.session.setActiveToolsByName(toolsForProfile({ available, profile: "coding", roleId }));
        expect(child.session.getActiveToolNames().includes("apply_patch")).toBe(roleId === "developer");
        if (roleId === "scout") {
          for (const name of ["edit", "write", "apply_patch", "lsp_rename"]) expect(child.session.getActiveToolNames()).not.toContain(name);
          expect(child.session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash"]));
        }
        const activeBeforeModel = child.session.getActiveToolNames();
        await child.session.setModel(model, { persist: false });
        expect(child.session.getActiveToolNames().includes("apply_patch")).toBe(roleId === "developer");
        if (roleId === "scout") {
          expect(child.session.getActiveToolNames()).toEqual(activeBeforeModel);
          for (const name of ["edit", "write", "apply_patch", "lsp_rename"]) expect(child.session.getActiveToolNames()).not.toContain(name);
        }
      } finally {
        child.session.dispose();
      }
    }
  }, 60_000);

  test("actual Pi tool result marks structured patch failure as an error", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pitako-patch-session-"));
    tempDirs.push(cwd);
    const loaded = await loadPitako(packageRoot(), cwd);
    tempDirs.push(loaded.agentDir);
    const agentDir = loaded.agentDir;
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    let requests = 0;
    runtime.registerProvider("pitako-patch-test", {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1",
      apiKey: "test",
      models: [{
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 2000,
        maxTokens: 128,
      }],
      streamSimple(model) {
        requests++;
        const stream = createAssistantMessageEventStream();
        const message = requests === 1
          ? {
              role: "assistant" as const,
              content: [{
                type: "toolCall" as const,
                id: "call-patch-failure",
                name: "apply_patch",
                arguments: { patch: "*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+DO-NOT-ECHO-PATCH-BODY\n*** End Patch" },
              }],
              api: "openai-completions" as const,
              provider: "pitako-patch-test",
              model: model.id,
              stopReason: "toolUse" as const,
              timestamp: Date.now(),
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            }
          : requests === 2
            ? {
                role: "assistant" as const,
                content: [{
                  type: "toolCall" as const,
                  id: "call-patch-success",
                  name: "apply_patch",
                  arguments: { patch: "*** Begin Patch\n*** Add File: success.txt\n+small result\n*** End Patch" },
                }],
                api: "openai-completions" as const,
                provider: "pitako-patch-test",
                model: model.id,
                stopReason: "toolUse" as const,
                timestamp: Date.now(),
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              }
            : {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "Patch failure reported." }],
              api: "openai-completions" as const,
              provider: "pitako-patch-test",
              model: model.id,
              stopReason: "stop" as const,
              timestamp: Date.now(),
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
        queueMicrotask(() => {
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end(message);
        });
        return stream;
      },
    });
    const model = runtime.getModel("pitako-patch-test", "fixture");
    if (!model) throw new Error("test provider model was not registered");
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime: runtime,
      resourceLoader: loaded.loader,
      settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
      sessionManager: SessionManager.inMemory(cwd),
    });
    const results: Array<{ isError: boolean; result: unknown }> = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "apply_patch") {
        results.push({ isError: event.isError, result: event.result });
      }
    });
    try {
      expect(session.getAllTools().map((tool) => tool.name)).toContain("apply_patch");
      session.setActiveToolsByName(["apply_patch"]);
      await session.prompt("Call apply_patch once. Do not read files.");
      expect(requests).toBe(3);
      expect(results).toHaveLength(2);
      expect(results[0]?.isError).toBe(true);
      expect(results[1]?.isError).toBe(false);
      const failed = results[0]?.result as { content?: Array<{ text?: string }>; details?: { errorCode?: string; pending?: string[] } };
      const failureContent = failed.content?.map((part) => part.text ?? "").join("\n") ?? "";
      expect(failed.details).toMatchObject({ errorCode: "PATCH_NOT_FILE", pending: ["missing.txt"] });
      expect(failureContent).toContain("Committed: none; pending: missing.txt; uncertain: none.");
      expect(failureContent).not.toContain("DO-NOT-ECHO-PATCH-BODY");
      const succeeded = results[1]?.result as { content?: Array<{ text?: string }>; details?: { ok?: boolean } };
      const successContent = succeeded.content?.map((part) => part.text ?? "").join("\n") ?? "";
      expect(succeeded.details?.ok).toBe(true);
      expect(successContent).toContain("Applied patch: 1 file(s), 1 hunk(s).");
      expect(await readFile(path.join(cwd, "success.txt"), "utf8")).toBe("small result\n");
    } finally {
      unsubscribe();
      session.dispose();
    }
  }, 60_000);
});
