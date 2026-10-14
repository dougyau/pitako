import type { PublicTodoHead, PublicTodoSnapshot } from "./bridge/protocol.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Replay selects by shape, not by success, action, or the validity of individual rows. */
function matching(entry: Record<string, unknown>): unknown[] | undefined {
  const message = entry.message;
  if (entry.type !== "message" || !object(message) || message.role !== "toolResult" ||
      message.toolName !== "todo" || !object(message.details) ||
      !Array.isArray(message.details.tasks) || typeof message.details.nextId !== "number") return;
  return message.details.tasks;
}

/** Borrow the native lookup. Only the selected tasks and their unresolved lifetimes are retained. */
export function resolvePublicTodo(lookup: (id: string) => unknown, head: string | null,
  limits: { entries: number; bytes: number }): { head: PublicTodoHead; snapshot?: PublicTodoSnapshot; budgetExceeded?: true } {
  const unavailable = { head: { state: "unavailable" as const } };
  const exhausted = { ...unavailable, budgetExceeded: true as const };
  let current = head, source: string | null = null, bytes = 0;
  let tasks: PublicTodoSnapshot["tasks"] | undefined;
  const seen = new Set<string>(), pending = new Map<number, PublicTodoSnapshot["tasks"][number]>();
  try {
    while (current !== null) {
      if (seen.has(current)) return unavailable;
      if (seen.size >= limits.entries) return exhausted;
      seen.add(current);
      const entry = lookup(current);
      if (!object(entry) || entry.id !== current || typeof entry.type !== "string" ||
          !(entry.parentId === null || typeof entry.parentId === "string")) return unavailable;
      bytes += Buffer.byteLength(JSON.stringify(entry));
      if (bytes > limits.bytes) return exhausted;
      const rows = matching(entry);
      if (rows) {
        if (tasks === undefined) {
          source = current;
          tasks = [];
          for (const row of rows) {
            if (!object(row) || !Number.isSafeInteger(row.id) || (row.id as number) <= 0 ||
                pending.has(row.id as number) || typeof row.subject !== "string" ||
                !["pending", "in_progress", "completed", "deleted"].includes(row.status as string)) return unavailable;
            const task = { id: row.id as number, identityEntryId: current, subject: row.subject,
              status: row.status as PublicTodoSnapshot["tasks"][number]["status"] };
            tasks.push(task); pending.set(task.id, task);
          }
        } else if (pending.size) {
          const present = new Set(rows.flatMap(row => object(row) && typeof row.id === "number" ? [row.id] : []));
          for (const [id, task] of pending) {
            if (present.has(id)) task.identityEntryId = current;
            else pending.delete(id);
          }
        }
      }
      // Still prove the complete ancestry even when all lifetimes have ended.
      current = entry.parentId as string | null;
    }
    if (tasks && bytes + Buffer.byteLength(JSON.stringify({ format: "rpiv-todo-v1", tasks })) > limits.bytes)
      return exhausted;
    return { head: { state: "ready", sourceEntryId: source },
      ...(tasks ? { snapshot: { format: "rpiv-todo-v1", tasks } } : {}) };
  } catch { return unavailable; }
}
