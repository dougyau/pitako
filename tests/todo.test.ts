import { describe, expect, test, beforeEach } from "bun:test";
import { replayFromBranch } from "../node_modules/@juicesharp/rpiv-todo/state/replay.ts";
import { __resetState, replaceState } from "../node_modules/@juicesharp/rpiv-todo/state/store.ts";
import { packageRoot } from "../extensions/stack.ts";
import { loadPitako } from "../scripts/load-pitako.ts";

interface ToolResult {
  content?: Array<{ type?: string; text?: string }>;
  details?: {
    error?: string;
    tasks?: Array<{
      id: number;
      subject: string;
      status: string;
      blockedBy?: number[];
      owner?: string;
      metadata?: Record<string, unknown>;
    }>;
    nextId?: number;
  };
}

interface ToolRunner {
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: SessionCtx,
  ): Promise<ToolResult>;
}

interface SessionCtx {
  sessionManager: {
    getSessionId(): string;
    getBranch(): unknown[];
  };
  hasUI: boolean;
  ui: { notify(message: string, kind?: string): void; setStatus(): void };
}

function sessionCtx(id: string, branch: unknown[] = []): SessionCtx {
  return {
    sessionManager: {
      getSessionId: () => id,
      getBranch: () => branch,
    },
    hasUI: true,
    ui: { notify() {}, setStatus() {} },
  };
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

describe("rpiv-todo composition", () => {
  beforeEach(() => {
    __resetState();
  });

  test("registers todo and /todos, with no competing TODO tools", async () => {
    const loaded = await loadPitako(packageRoot());
    expect(loaded.extensions.errors).toEqual([]);

    const toolNames: string[] = [];
    const commandNames: string[] = [];
    for (const extension of loaded.extensions.extensions) {
      for (const name of extension.tools.keys()) toolNames.push(name);
      for (const name of extension.commands.keys()) commandNames.push(name);
    }
    expect(toolNames.filter((name) => name === "todo")).toEqual(["todo"]);
    expect(commandNames).toContain("todos");
    for (const name of ["todo_write", "todowrite", "todoread", "TodoWrite"]) {
      expect(toolNames).not.toContain(name);
    }
  });

  test("create, in_progress, complete, blockedBy, and cycle rejection work", async () => {
    const loaded = await loadPitako(packageRoot());
    let todo: ToolRunner | undefined;
    let todosHandler: ((args: string, ctx: SessionCtx) => Promise<void>) | undefined;
    for (const extension of loaded.extensions.extensions) {
      const registered = extension.tools.get("todo");
      if (registered) todo = registered.definition as unknown as ToolRunner;
      const command = extension.commands.get("todos");
      if (command) todosHandler = command.handler as unknown as (args: string, ctx: SessionCtx) => Promise<void>;
    }
    if (!todo) throw new Error("todo tool was not registered");
    if (!todosHandler) throw new Error("/todos was not registered");

    const ctx = sessionCtx("session-a");
    const created = await todo.execute("t1", { action: "create", subject: "Inspect current system" }, undefined, undefined, ctx);
    expect(textOf(created)).toContain("Created #1");
    expect(created.details?.tasks?.[0]?.status).toBe("pending");

    const started = await todo.execute(
      "t2",
      { action: "update", id: 1, status: "in_progress", activeForm: "inspecting the system" },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(started)).toContain("pending → in_progress");

    const blocked = await todo.execute(
      "t3",
      { action: "create", subject: "Verify the change", blockedBy: [1] },
      undefined,
      undefined,
      ctx,
    );
    expect(blocked.details?.tasks?.[1]?.blockedBy).toEqual([1]);

    const cycle = await todo.execute("t4", { action: "update", id: 1, addBlockedBy: [2] }, undefined, undefined, ctx);
    expect(textOf(cycle)).toContain("Error:");
    expect(cycle.details?.error).toMatch(/cycle/i);
    expect(cycle.details?.tasks?.[0]?.blockedBy).toBeUndefined();

    const listed = await todo.execute("t5", { action: "list" }, undefined, undefined, ctx);
    expect(textOf(listed)).toContain("#1");
    expect(textOf(listed)).toContain("#2");

    const done = await todo.execute("t6", { action: "update", id: 1, status: "completed" }, undefined, undefined, ctx);
    expect(textOf(done)).toContain("in_progress → completed");

    const notices: string[] = [];
    await todosHandler("", {
      ...ctx,
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        setStatus() {},
      },
    });
    expect(notices.join("\n")).toContain("Inspect current system");
  });

  test("session branches keep separate TODO state", async () => {
    const loaded = await loadPitako(packageRoot());
    let todo: ToolRunner | undefined;
    for (const extension of loaded.extensions.extensions) {
      const registered = extension.tools.get("todo");
      if (registered) todo = registered.definition as unknown as ToolRunner;
    }
    if (!todo) throw new Error("todo tool was not registered");

    const a = sessionCtx("branch-a");
    const b = sessionCtx("branch-b");
    await todo.execute("a1", { action: "create", subject: "Work on A" }, undefined, undefined, a);
    await todo.execute("b1", { action: "create", subject: "Work on B" }, undefined, undefined, b);

    const listA = await todo.execute("a2", { action: "list" }, undefined, undefined, a);
    const listB = await todo.execute("b2", { action: "list" }, undefined, undefined, b);
    expect(textOf(listA)).toContain("Work on A");
    expect(textOf(listA)).not.toContain("Work on B");
    expect(textOf(listB)).toContain("Work on B");
    expect(textOf(listB)).not.toContain("Work on A");
  });

  test("TODO snapshots replay after reload and compaction", async () => {
    const loaded = await loadPitako(packageRoot());
    let todo: ToolRunner | undefined;
    for (const extension of loaded.extensions.extensions) {
      const registered = extension.tools.get("todo");
      if (registered) todo = registered.definition as unknown as ToolRunner;
    }
    if (!todo) throw new Error("todo tool was not registered");

    const live = sessionCtx("replay-live");
    const created = await todo.execute(
      "r1",
      { action: "create", subject: "Survive reload", owner: "developer", metadata: { pitako: "session" } },
      undefined,
      undefined,
      live,
    );
    expect(created.details?.tasks?.[0]?.owner).toBe("developer");
    expect(created.details?.tasks?.[0]?.metadata).toEqual({ pitako: "session" });

    const branch = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          details: created.details,
        },
      },
    ];
    __resetState();
    const restored = replayFromBranch({ sessionManager: { getBranch: () => branch } });
    expect(restored.tasks[0]?.subject).toBe("Survive reload");
    replaceState("replay-after-reload", restored);

    const afterReload = await todo.execute("r2", { action: "list" }, undefined, undefined, sessionCtx("replay-after-reload"));
    expect(textOf(afterReload)).toContain("Survive reload");

    const compacted = replayFromBranch({
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: { role: "toolResult", toolName: "todo", details: created.details },
          },
          {
            type: "message",
            message: { role: "assistant", content: "compacted" },
          },
        ],
      },
    });
    expect(compacted.tasks[0]?.subject).toBe("Survive reload");
    expect(compacted.nextId).toBe(2);
  });
});
