import { afterEach, expect, test, vi } from "bun:test";
import { isolateTodoConfig } from "../vendor/rpiv-todo/test-isolation.ts";
import { createMockCtx, createMockPi, makeTheme } from "../vendor/rpiv-todo/test-utils.ts";
import { registerTodosCommand } from "../vendor/rpiv-todo/todo.ts";
import { TodoOverlay } from "../vendor/rpiv-todo/todo-overlay.ts";
import { __resetState, getState, replaceState, setActiveRenderSession } from "../vendor/rpiv-todo/state/store.ts";
import { selectOverlayLayout } from "../vendor/rpiv-todo/state/selectors.ts";
import { formatStatusLabel } from "../vendor/rpiv-todo/state/i18n-bridge.ts";
import type { TaskState } from "../vendor/rpiv-todo/state/state.ts";

isolateTodoConfig();
afterEach(() => __resetState());

// Different statuses deliberately span the old /todos status sections.
const snapshot: TaskState = {
 tasks: [
  { id: 1, subject: "Phase", status: "in_progress", owner: "execute:run" },
  { id: 2, parentId: 1, subject: "Stopped step", status: "cancelled", owner: "execute:run" },
  { id: 3, parentId: 1, subject: "Requested step", status: "pending", owner: "execute:run", metadata: { cancelRequested: true } },
  { id: 4, subject: "Hidden tombstone", status: "deleted" },
  { id: 5, subject: "Other root", status: "pending" },
 ], nextId: 6,
};
function seed() {
 __resetState();
 replaceState("test-session", structuredClone(snapshot));
 setActiveRenderSession("test-session");
}
function renderOverlay() {
 const ctx = createMockCtx({ hasUI: true });
 const setWidget = vi.spyOn(ctx.ui, "setWidget");
 const overlay = new TodoOverlay();
 overlay.setUICtx(ctx.ui);
 overlay.update();
 const factory = setWidget.mock.calls[0]?.[1];
 if (typeof factory !== "function") throw new Error("Overlay factory not registered");
 const widget = factory({ requestRender: vi.fn() } as never, makeTheme() as never);
 return { overlay, widget };
}
test("overlay nests children, marks cancellation and requests, counts cancelled as done, and hides deleted", () => {
 seed();
 const { overlay, widget } = renderOverlay();
 try {
  const lines = widget.render(200);
  expect(lines[0]).toContain("Todos (1/4)");
  expect(lines[1]).toBe("├─ ◐ Phase");
  expect(lines[2]).toBe("  ├─ ⊘ Stopped step");
  expect(lines[3]).toBe("  ├─ ○ Requested step [cancel requested]");
  expect(lines[4]).toBe("└─ ○ Other root");
  expect(lines.join("\n")).not.toContain("Hidden tombstone");
  expect(formatStatusLabel("cancelled")).toBe("cancelled");
  overlay.hideCompletedTasksFromPreviousTurn();
  expect(widget.render(200).join("\n")).not.toContain("Stopped step");
 } finally { overlay.dispose(); }
});
test("/todos keeps mixed-status children under the parent and is read-only", async () => {
 seed();
 const { pi, captured } = createMockPi();
 registerTodosCommand(pi);
 const cmd = captured.commands.get("todos");
 if (!cmd) throw new Error("/todos not registered");
 const ctx = createMockCtx({ hasUI: true });
 const notify = vi.fn(ctx.ui.notify);
 ctx.ui.notify = notify;
 const before = structuredClone(getState("test-session"));
 await cmd.handler("", ctx as never);
 const output = notify.mock.calls[0]?.[0];
 expect(output).toContain("1/4 completed");
 expect(output).toContain("  ◐ #1 Phase\n    ⊘ #2 Stopped step\n    ○ #3 Requested step [cancel requested]");
 expect(output).not.toContain("Hidden tombstone");
 expect(output?.match(/#2/g)).toHaveLength(1);
 expect(getState("test-session")).toEqual(before);
 expect(captured.entries).toEqual([]);
});
test("cancelled-only lists render as done and overflow drops done rows before active rows", async () => {
 seed();
 const layout = selectOverlayLayout(snapshot, 4);
 expect(layout.visible.map(task => task.id)).toEqual([1, 2, 3, 5]);
 const limited = selectOverlayLayout(snapshot, 3);
 expect(limited.visible.map(task => task.id)).toEqual([1, 3]);
 expect(limited.hiddenCompleted).toBe(1);
 replaceState("test-session", { tasks: [{ id: 2, subject: "Stopped", status: "cancelled" }], nextId: 6 });
 const { overlay, widget } = renderOverlay();
 try { expect(widget.render(200).join("\n")).toContain("Todos (1/1)"); }
 finally { overlay.dispose(); }
 const { pi, captured } = createMockPi();
 registerTodosCommand(pi);
 const ctx = createMockCtx({ hasUI: true });
 const notify = vi.fn(ctx.ui.notify);
 ctx.ui.notify = notify;
 await captured.commands.get("todos")!.handler("", ctx as never);
 expect(notify.mock.calls[0]?.[0]).toContain("⊘ #2 Stopped");
});
