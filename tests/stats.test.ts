import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pitako from "../extensions/index.ts";
import { publishObservation, removeObservation } from "../extensions/agent/observe.ts";
import type { AgentUiSnapshot } from "../extensions/agent/ui.ts";
import { packageRoot } from "../extensions/stack.ts";

test("/pitako stats preserves model, role, instance and absence observations", async () => {
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notifications: string[] = [];
  const pi = {
    registerFlag() {},
    registerTool() {},
    getFlag() { return undefined; },
    on() {},
    registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      if (name === "pitako") command = definition.handler;
    },
  };
  pitako(pi as unknown as ExtensionAPI);
  if (!command) throw new Error("pitako command was not registered");
  const sessionId = "stats-owned-session";
  const context = {
    cwd: packageRoot(),
    hasUI: true,
    ui: { notify(message: string) { notifications.push(message); } },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => [{ type: "message", message: { role: "assistant",
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } } } }],
    },
  };
  const worker: AgentUiSnapshot = {
    id: "stats-owned-worker", roleId: "developer", status: "running", phase: "working",
    task: "stats fixture", origin: { source: "agent_run", coordinatorSessionId: sessionId },
    acceptedAt: 0, selectedModel: "test/model", lastActivityKind: "tool_end",
    agentUsage: { input: 3, output: 2, total: 5, cacheRead: 1, cacheWrite: 2, cost: 0.1,
      turns: 2, toolCalls: 3, contextTokens: 128, tools: { read: 1, codegraph_search: 1, apply_patch: 1 } },
  };
  const ids = [worker.id, "stats-owned-unknown", "stats-owned-foreign"];
  try {
    publishObservation(worker);
    publishObservation({ ...worker, id: ids[1]!, roleId: "architect", agentUsage: undefined });
    publishObservation({ ...worker, id: ids[2]!, origin: { source: "agent_run", coordinatorSessionId: "other" } });
    await command("stats", context);
    const stats = notifications.at(-1)!;
    expect(stats).toContain(`foreground session: ${sessionId}`);
    expect(stats).toContain("model usage: input=10, output=4, cached_read=2, cached_write=1, total=17, cost=0.25");
    expect(stats).toContain("role developer:");
    expect(stats).toContain(`instance ${worker.id}`);
    expect(stats).toContain("role architect: usage unknown");
    expect(stats).not.toContain(ids[2]!);
    expect(stats).not.toContain("code intelligence");
    expect(stats).not.toContain("raw navigation");
    await command(`stats ${worker.id}`, context);
    const instance = notifications.at(-1)!;
    expect(instance).toContain(`instance: ${worker.id}`);
    expect(instance).toContain("input: 3");
    expect(instance).toContain("cached read: 1");
    expect(instance).toContain("cached write: 2");
    expect(instance).toContain("cost: 0.1");
    expect(instance).toContain("turns: 2");
    expect(instance).toContain("tools: 3");
    expect(instance).toContain("mutations: edit 0, write 0, apply_patch 1");
    expect(instance).toContain("context: 128");
    expect(instance).not.toContain("code intelligence");
    await command(`stats ${ids[1]}`, context);
    expect(notifications.at(-1)).toContain("model usage: unknown (attempt has not reported usage)");
  } finally {
    for (const id of ids) removeObservation(id);
  }
  await command("stats", { ...context, sessionManager: { getSessionId: () => undefined, getEntries: () => undefined } });
  expect(notifications.at(-1)).toContain("foreground session: unknown");
  expect(notifications.at(-1)).toContain("model usage: unknown");
  expect(notifications.at(-1)).toContain("AgentInstances: none");
  expect(notifications.at(-1)).not.toContain("code intelligence");
});
