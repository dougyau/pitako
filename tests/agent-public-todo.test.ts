import { expect, test } from "bun:test";
import { resolvePublicTodo } from "../extensions/agent/public-todo.ts";
import { isReply } from "../extensions/agent/bridge/protocol.js";
import { PublicConversation } from "../extensions/agent/public-conversation.ts";

const limits = { entries: 100, bytes: 100000 };
const task = (id = 1, subject = "one", status: "pending" | "in_progress" | "completed" | "deleted" = "pending") => ({ id, subject, status });
const todo = (id: string, parentId: string | null, tasks: unknown[], nextId: unknown = 2) =>
  ({ id, parentId, type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks, nextId } } });
const resolve = (entries: ReturnType<typeof todo>[], head: string | null, budget = limits) =>
  resolvePublicTodo(id => entries.find(entry => entry.id === id), head, budget);

test("TODO identity includes deleted, clear resets reuse, and invalid intermediate membership is authoritative", () => {
  const entries = [todo("a", null, [task()]), todo("b", "a", [task(1, "one", "deleted")]),
    todo("c", "b", []), todo("d", "c", [task(1, "new")])];
  expect(resolve(entries, "b").snapshot?.tasks).toEqual([{ ...task(1, "one", "deleted"), identityEntryId: "a" }]);
  expect(resolve(entries, "c")).toEqual({ head: { state: "ready", sourceEntryId: "c" },
    snapshot: { format: "rpiv-todo-v1", tasks: [] } });
  expect(resolve(entries, "d").snapshot?.tasks[0]?.identityEntryId).toBe("d");
  const invalid = todo("invalid", "a", [{ id: 1, subject: null }, { id: 1, status: "bad" }]);
  const valid = todo("valid", "invalid", [task()]);
  expect(resolve([entries[0]!, invalid, valid], "valid").snapshot?.tasks[0]?.identityEntryId).toBe("a");
  invalid.message.details.tasks = [{ id: "1" }];
  expect(resolve([entries[0]!, invalid, valid], "valid").snapshot?.tasks[0]?.identityEntryId).toBe("valid");
});

test("selected invalid matching rows never fall back; nonmatching envelopes do not select", () => {
  const first = todo("first", null, [task()]);
  for (const rows of [[task(0)], [task(-1)], [task(1.5)], [task(Number.MAX_SAFE_INTEGER + 1)],
    [task(), task()], [{ id: 1, subject: 3, status: "pending" }], [{ ...task(), status: "unknown" }]]) {
    expect(resolve([first, todo("bad", "first", rows)], "bad")).toEqual({ head: { state: "unavailable" } });
  }
  expect(resolve([first, todo("skip", "first", [task(2)], "2")], "skip").head)
    .toEqual({ state: "ready", sourceEntryId: "first" });
  // Replay's numeric test includes NaN and negative nextId; neither is an allocator authority.
  expect(resolve([todo("a", null, [task()], NaN)], "a").head).toEqual({ state: "ready", sourceEntryId: "a" });
});

test("full ancestry across arbitrary classes, divergence, and uncertainty never yield partial snapshots", () => {
  const entries: unknown[] = [todo("a", null, [task()]), { id: "custom", parentId: "a", type: "custom" },
    todo("b", "custom", [task(1, "branch b")]), todo("c", "a", [task(1, "branch c")]),
    { id: "root", parentId: null, type: "compaction" }];
  const lookup = (id: string) => entries.find(entry => (entry as { id: string }).id === id);
  expect(resolvePublicTodo(lookup, "b", limits).snapshot?.tasks).toEqual([{ ...task(1, "branch b"), identityEntryId: "a" }]);
  expect(resolvePublicTodo(lookup, "c", limits).head).toEqual({ state: "ready", sourceEntryId: "c" });
  expect(resolvePublicTodo(lookup, "root", limits)).toEqual({ head: { state: "ready", sourceEntryId: null } });
  for (const budget of [{ entries: 1, bytes: 100000 }, { entries: 100, bytes: 10 }])
    expect(resolvePublicTodo(lookup, "b", budget)).toEqual({ head: { state: "unavailable" }, budgetExceeded: true });
  for (const parentId of ["missing", "a", 3]) {
    const broken = { ...todo("a", null, [task()]), parentId };
    expect(resolvePublicTodo(() => broken, "a", limits)).toEqual({ head: { state: "unavailable" } });
  }
  expect(resolvePublicTodo(() => { throw Error("corrupt"); }, "a", limits)).toEqual({ head: { state: "unavailable" } });
});

const owner = { processId: "process", coordinatorSessionId: "coordinator", epoch: "owner" };
const ref = { kind: "read" as const, ...owner, instanceId: "worker", source: "agent_spawn" as const,
  native: { generation: 1, historyId: "history", sessionId: "session" } };
test("shared wire validator admits optional TODO fields and rejects extra keys and malformed rows", () => {
  const capture = new PublicConversation();
  const generation = capture.binding("history", "session");
  const entry = { ...todo("native", null, [task()]), timestamp: "now",
    message: { role: "toolResult", toolCallId: "call", toolName: "todo", timestamp: 1, content: [],
      isError: false, details: { tasks: [task()], nextId: 2 } } };
  capture.entry(generation, entry as never, false, undefined, 0,
    { format: "rpiv-todo-v1", tasks: [{ id: 1, subject: "", status: "pending", identityEntryId: "native" }] });
  capture.head(generation, "native", [entry as never], undefined, { state: "ready", sourceEntryId: "native" });
  const page = capture.read(ref);
  const reply = { version: 2, id: "1", clientId: "client", owner, ok: true, result: page };
  expect(isReply(reply, "workers.activity", "public-v1")).toBe(true);
  const { todoHead, ...legacyBinding } = page.binding!;
  expect(isReply({ ...reply, result: { ...page, binding: legacyBinding } }, "workers.activity", "public-v1")).toBe(true);
  expect(legacyBinding).not.toHaveProperty("todoHead"); // Absent capability is not ready/null or unavailable.
  expect(isReply({ ...reply, result: { ...page, binding: { ...legacyBinding, todoHead: { state: "unavailable" } } } },
    "workers.activity", "public-v1")).toBe(true);
  for (const head of [{ state: "unavailable", reason: "bad" }, { state: "ready" },
    { state: "ready", sourceEntryId: 1 }]) {
    expect(isReply({ ...reply, result: { ...page, binding: { ...page.binding, todoHead: head } } },
      "workers.activity", "public-v1")).toBe(false);
  }
  const change = page.changes[0]!;
  if (!("record" in change) || change.record.kind !== "tool") throw Error("missing tool");
  const snapshot = change.record.payload.todoSnapshot!;
  for (const tasks of [[{ ...snapshot.tasks[0], private: true }], [snapshot.tasks[0], snapshot.tasks[0]],
    [{ ...snapshot.tasks[0], id: 0 }], [{ ...snapshot.tasks[0], status: "bad" }],
    [{ ...snapshot.tasks[0], subject: 1 }], [{ ...snapshot.tasks[0], identityEntryId: null }]]) {
    const malformed = { ...change, record: { ...change.record, payload: { ...change.record.payload,
      todoSnapshot: { ...snapshot, tasks } } } };
    expect(isReply({ ...reply, result: { ...page, changes: [malformed] } }, "workers.activity", "public-v1")).toBe(false);
  }
  capture.retire();
});

test("selector-only changes notify and refresh follow while an ordinary page keeps its frozen binding", () => {
  const capture = new PublicConversation();
  const generation = capture.binding("history", "session");
  capture.head(generation, null, [], undefined, { state: "ready", sourceEntryId: null });
  const initial = capture.read(ref);
  let notifications = 0;
  capture.onChange = () => { notifications++; };
  capture.head(generation, null, [], undefined, { state: "unavailable" });
  expect(notifications).toBe(1);
  const follow = capture.read(ref, initial.next!);
  expect(follow.changes).toEqual([]);
  expect(follow.binding!.todoHead).toEqual({ state: "unavailable" });
  expect(initial.binding!.todoHead).toEqual({ state: "ready", sourceEntryId: null });
  capture.retire();
});

test("atomic native publication keeps accumulation bounded before notifying readers", () => {
  const capture = new PublicConversation({ worker: 4096, owner: 32768 });
  const generation = capture.binding("history", "session");
  let notifications = 0;
  capture.onChange = () => { notifications++; };
  capture.batch(() => {
    for (let index = 0; index < 50; index++) {
      capture.entry(generation, { id: `entry-${index}`, parentId: null, type: "message", timestamp: "now",
        message: { role: "user", timestamp: index, content: "x".repeat(1000) } });
      expect(Buffer.byteLength(JSON.stringify(capture.read(ref).changes))).toBeLessThanOrEqual(4096);
      expect(notifications).toBe(0);
    }
    capture.head(generation, null, [], undefined, { state: "ready", sourceEntryId: null });
  });
  expect(notifications).toBe(1);
  expect(capture.metadata(ref).gaps).toContain("evicted");
  expect(capture.read(ref).binding!.todoHead).toEqual({ state: "ready", sourceEntryId: null });
  capture.retire();
});
