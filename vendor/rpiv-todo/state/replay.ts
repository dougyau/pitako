import type { Task, TaskDetails, TaskStatus } from "../tool/types.ts";
import { EMPTY_STATE, type TaskState } from "./state.ts";

const TASK_STATUSES: ReadonlySet<unknown> = new Set<TaskStatus>(["pending", "in_progress", "completed", "cancelled", "deleted"]);

const optional = (value: unknown, valid: (v: unknown) => boolean): boolean => value === undefined || valid(value);
const isString = (v: unknown): boolean => typeof v === "string";

function isTask(value: unknown): value is Task {
	if (!value || typeof value !== "object") return false;
	const t = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(t.id) && Number(t.id) > 0 &&
		typeof t.subject === "string" && t.subject.length <= 2000 && t.subject.trim().length > 0 &&
		TASK_STATUSES.has(t.status) &&
		optional(t.description, isString) &&
		optional(t.activeForm, isString) &&
		optional(t.owner, isString) &&
		optional(t.parentId, (v) => Number.isSafeInteger(v) && Number(v) > 0) &&
		optional(t.blockedBy, (v) => Array.isArray(v) && v.every((id) => Number.isSafeInteger(id))) &&
		optional(t.metadata, (v) => typeof v === "object" && v !== null && !Array.isArray(v))
	);
}

/**
 * Discriminator for `details` envelopes that match the persisted `TaskDetails`
 * shape, down to every task. Defensive — a snapshot from an older or corrupt
 * session (e.g. a `tasks[]` another extension truncated with a marker string)
 * is skipped whole, so replay keeps the last valid one.
 */
export function isTaskDetails(value: unknown): value is Pick<TaskDetails, "tasks" | "nextId"> {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && v.tasks.every(isTask) && Number.isSafeInteger(v.nextId) &&
		Number(v.nextId) > Math.max(0, ...v.tasks.map((t: Task) => t.id)) &&
		new Set(v.tasks.map((t: Task) => t.id)).size === v.tasks.length;
}

/** Fresh `TaskState` from a persisted snapshot — copies each task so replay never aliases branch data. */
function stateOf(details: Pick<TaskDetails, "tasks" | "nextId">): TaskState {
	return { tasks: structuredClone(details.tasks), nextId: details.nextId };
}

/** Latest valid snapshot in branch order; entries precede their toolResults. Pure. */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let state: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: string; customType?: string; data?: unknown;
			message?: { role?: string; toolName?: string; details?: unknown } };
		let snapshot: unknown;
		if (e.type === "custom" && e.customType === "pitako-todo-state") {
			if (!e.data || typeof e.data !== "object" || !("version" in e.data) || e.data.version !== 1) continue;
			snapshot = e.data;
		} else if (e.type === "custom" && e.customType === "rpiv-todo-state") snapshot = e.data;
		else if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "todo") snapshot = e.message.details;
		if (isTaskDetails(snapshot)) {
			const nextId = Math.max(state.nextId, snapshot.nextId);
			state = stateOf(snapshot);
			state.nextId = nextId;
		}
	}
	return state;
}
