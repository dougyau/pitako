import type { Task, TaskAction, TaskMutationParams, TaskStatus, SyncRow } from "../tool/types.ts";
import { isTransitionValid } from "./invariants.ts";
import type { TaskState } from "./state.ts";
import { detectCycle } from "./task-graph.ts";

/**
 * Reducer outcome. Closed tagged union — adding a new action requires extending
 * this union AND the response-envelope's `formatContent` switch (compiler-
 * enforced exhaustive). Mirrors the `Effect` pattern in
 * `packages/rpiv-ask-user-question/state/state-reducer.ts:14-30`.
 *
 * `error` carries the message in-band so callers can pattern-match on
 * `op.kind === "error"` without a side-channel boolean.
 */
export type Op =
	| { kind: "create"; taskIds: number[] }
	| { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus; changed: boolean }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

/**
 * True when `op` changed the task state — the calls whose post-commit snapshot
 * must be persisted for replay. Reads (`list`/`get`), failures, and a no-effect
 * `update` leave state untouched. Exhaustive over `Op` (compiler-enforced), so a
 * new action must decide here whether it persists.
 */
export function changesState(op: Op): boolean {
	switch (op.kind) {
		case "create":
		case "delete":
			return true;
		case "clear":
			return op.count > 0;
		case "update":
			return op.changed;
		case "list":
		case "get":
		case "error":
			return false;
	}
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

/** Per-task create fields: on a batch they belong to each `tasks[]` item. */
const BATCH_ITEM_FIELDS = ["description", "activeForm", "blockedBy", "metadata", "parentId"] as const;

function asCreateItem(value: unknown): TaskMutationParams | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as TaskMutationParams;
}

function buildCreatedTask(id: number, spec: TaskMutationParams, subject: string, actor?: string): Task {
	const newTask: Task = {
		id,
		subject,
		status: "pending",
	};
	if (spec.description) newTask.description = spec.description;
	if (spec.activeForm) newTask.activeForm = spec.activeForm;
	if (spec.blockedBy?.length) newTask.blockedBy = [...spec.blockedBy];
	if (actor !== undefined) newTask.owner = actor;
	if (spec.parentId !== undefined) newTask.parentId = spec.parentId;
	if (spec.metadata) newTask.metadata = { ...spec.metadata };
	return newTask;
}

function validateCreateBlockedBy(
	state: TaskState,
	blockedBy: number[] | undefined,
	siblingIds: ReadonlySet<number>,
): string | undefined {
	if (!blockedBy?.length) return undefined;
	for (const dep of blockedBy) {
		if (siblingIds.has(dep)) {
			return `blockedBy: #${dep} is another item in this batch; create the prerequisite first, then the dependent with blockedBy`;
		}
		const depTask = state.tasks.find((t) => t.id === dep);
		if (!depTask) return `blockedBy: #${dep} not found`;
		if (depTask.status === "deleted") return `blockedBy: #${dep} is deleted`;
	}
	return undefined;
}

function sameNumberList(a: number[] | undefined, b: number[] | undefined): boolean {
	const x = a ?? [];
	const y = b ?? [];
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameRecord(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Did this `update` change anything? Compares the task before/after the params
 * are applied. A no-effect update — `status` set to its current value, or any
 * field re-sent unchanged — returns false, letting the response envelope say
 * "No change" instead of "Updated #N". Without this, a no-op update is
 * indistinguishable from a real mutation, which can drive a model to re-issue
 * the same call in a loop.
 *
 * blockedBy is order-sensitive (the reducer preserves insertion order);
 * metadata round-trips through JSON persistence, so JSON-equality is the
 * operative notion of "changed".
 */
function taskChanged(before: Task, after: Task): boolean {
	return (
		before.subject !== after.subject ||
		before.status !== after.status ||
		before.description !== after.description ||
		before.activeForm !== after.activeForm ||
		before.owner !== after.owner ||
		!sameNumberList(before.blockedBy, after.blockedBy) ||
		!sameRecord(before.metadata, after.metadata)
	);
}

/**
 * Pure reducer: (state, action, params) → (state, op). The response envelope (`tool/response-envelope.ts`) owns
 * formatting, the store (`state/store.ts`) owns commit.
 *
 * Validation is in-line: structural guards (`subject required`, `id required`,
 * `at least one mutable field`) plus state-aware checks (transition legality,
 * dangling/deleted blockedBy, self-block, cycles). Decision: validation stays
 * in-reducer.
 */
function reduceTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams, actor?: string): ApplyResult {
	switch (action) {
		case "cancel": return errorResult(state, "cancel must pass ownership checks");
		case "create": {
			const batch = params.tasks;

			if (Array.isArray(batch) && params.subject !== undefined) {
				return errorResult(state, "create requires subject or tasks[], not both");
			}

			if (Array.isArray(batch)) {
				// Each item carries its own fields; a top-level one would apply to no item.
				const topLevel = BATCH_ITEM_FIELDS.filter((field) => params[field] !== undefined);
				if (topLevel.length) {
					return errorResult(
						state,
						`create with tasks[] takes ${topLevel.join(", ")} on each item, not at the top level`,
					);
				}
				if (batch.length === 0) {
					return errorResult(state, "tasks[] must be non-empty");
				}
				const items: Array<{ spec: TaskMutationParams; subject: string }> = [];
				for (let i = 0; i < batch.length; i++) {
					const spec = asCreateItem(batch[i]);
					const subject = spec?.subject;
					if (!spec || (typeof subject !== "string" || !subject.trim())) {
						return errorResult(state, `tasks[${i}]: subject required for create`);
					}
					items.push({ spec, subject });
				}
				const siblingIds = new Set(items.map((_, i) => state.nextId + i));
				for (const item of items) {
					const blockedError = validateCreateBlockedBy(state, item.spec.blockedBy, siblingIds);
					if (blockedError) return errorResult(state, blockedError);
				}
				const created = items.map((item, i) => buildCreatedTask(state.nextId + i, item.spec, item.subject, actor));
				return {
					state: { tasks: [...state.tasks, ...created], nextId: state.nextId + created.length },
					op: { kind: "create", taskIds: created.map((t) => t.id) },
				};
			}

			if (typeof params.subject !== "string" || !params.subject.trim()) {
				return errorResult(state, "subject required for create");
			}
			const blockedError = validateCreateBlockedBy(state, params.blockedBy, new Set());
			if (blockedError) return errorResult(state, blockedError);
			const newTask = buildCreatedTask(state.nextId, params, params.subject, actor);
			return {
				state: { tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
				op: { kind: "create", taskIds: [newTask.id] },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation)
				return errorResult(
					state,
					"update requires at least one mutable field: subject, description, activeForm, status, metadata, addBlockedBy, or removeBlockedBy",
				);

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				}
				newStatus = params.status;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;

			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: {
					kind: "update",
					id: updated.id,
					fromStatus: current.status,
					toStatus: newStatus,
					changed: taskChanged(current, updated),
				},
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			const updated: Task = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "delete", id: updated.id, subject: updated.subject },
			};
		}

		case "clear": {
			const count = state.tasks.filter(t => t.owner === actor).length;
			return {
				state: { tasks: state.tasks.filter(t => t.owner !== actor), nextId: state.nextId },
				op: { kind: "clear", count },
			};
		}
	}
}

function isTerminal(task: Task): boolean {
	return task.status === "cancelled" || task.status === "deleted";
}

/** Validate the resulting snapshot, then order children and prune only scoped tombstones. */
export function finalizeTaskState(state: TaskState): { state: TaskState; error?: string } {
	const fail = (error: string) => ({state, error});
	// First occurrence wins, as a linear scan would find it; duplicates still fail below.
	const byId = new Map<number, Task>();
	for (const task of state.tasks) if (!byId.has(task.id)) byId.set(task.id, task);
	const ids = new Set<number>();
	const running = new Set<string | undefined>();
	for (const task of state.tasks) {
		if (!Number.isSafeInteger(task.id) || task.id < 1 || ids.has(task.id)) return fail("ids must be unique positive integers");
		ids.add(task.id);
		if (typeof task.subject !== "string" || !task.subject.trim() || task.subject.length > 2000) return fail("subject must be 1..2000 nonblank characters");
		if (!["pending", "in_progress", "completed", "cancelled", "deleted"].includes(task.status)) return fail("invalid status");
		if (task.status === "in_progress") {
			if (running.has(task.owner)) return fail("at most one in_progress task per owner");
			running.add(task.owner);
		}
		if (task.parentId !== undefined && task.status !== "deleted") {
			const parent = byId.get(task.parentId);
			if (!parent || parent === task || parent.parentId !== undefined || parent.status === "deleted") return fail("parentId must name a top-level non-deleted parent");
			if (parent.status === "completed" && (task.status === "pending" || task.status === "in_progress")) return fail("completed parent cannot have active children");
			if (task.status === "in_progress" && parent.status !== "in_progress") return fail("parent must stay in_progress while a child runs");
		}
	}
	let maxId = 0;
	for (const id of ids) if (id > maxId) maxId = id;
	if (!Number.isSafeInteger(state.nextId) || state.nextId <= maxId) return fail("nextId must exceed every id");
	// Linear in the task count: callers run this on every commit and sync.
	const children = new Map<number, Task[]>();
	for (const task of state.tasks) if (task.parentId !== undefined) {
		const list = children.get(task.parentId);
		if (list) list.push(task); else children.set(task.parentId, [task]);
	}
	const ordered: Task[] = [];
	const placed = new Set<Task>();
	for (const task of state.tasks) {
		if (task.parentId === undefined || !byId.has(task.parentId)) {
			ordered.push(task); placed.add(task);
			for (const child of children.get(task.id) ?? []) { ordered.push(child); placed.add(child); }
		}
	}
	// Deleted descendants with a deleted/nested parent are still retained as tombstones.
	for (const task of state.tasks) if (!placed.has(task)) ordered.push(task);
	// Measure once; removing one array element removes its JSON and one separating comma.
	const encoder = new TextEncoder();
	const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
	let size = bytes({version:1, tasks: ordered, nextId: state.nextId});
	let count = ordered.length;
	const overLimit = () => count > 1000 || size > 262144;
	const pruned = new Set<number>();
	if (overLimit()) for (const task of [...ordered].sort((a,b) => a.id-b.id)) {
		if (!overLimit()) break;
		if (task.status === "deleted" && /^(execute:|worker:)/.test(task.owner ?? "")) {
			pruned.add(task.id);
			size -= bytes(task) + (count > 1 ? 1 : 0);
			count--;
		}
	}
	if (overLimit()) return fail("todo state exceeds 1000 tasks or 262144 bytes");
	return {state: {tasks: pruned.size ? ordered.filter(t => !pruned.has(t.id)) : ordered, nextId: state.nextId}};
}

/** Pure actor-aware entry: all failures retain the exact input snapshot. */
export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams, actor?: string): ApplyResult {
	if (params.owner !== undefined && actor === undefined && /^(execute:|worker:)/.test(params.owner) ||
					params.tasks?.some(t => actor === undefined && /^(execute:|worker:)/.test(t.owner ?? ""))) return errorResult(state, "reserved owner prefix");
	if (action === "list" || action === "get") return reduceTaskMutation(state, action, params, actor);

	if (action === "update" || action === "delete" || action === "cancel") {
		const current = state.tasks.find(t => t.id === params.id);
		if (!current) return errorResult(state, params.id === undefined ? `id required for ${action}` : `#${params.id} not found`);
		if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
		if (current.status === "cancelled" && !(action === "delete" || action === "update" && params.status === "deleted" && Object.keys(params).every(k => ["action", "id", "status"].includes(k)))) return errorResult(state, "cancelled is terminal except delete");
		if (current.status === "completed" && action !== "delete" && !(action === "update" && params.status === "deleted" && Object.keys(params).every(k => ["action", "id", "status"].includes(k)))) return errorResult(state, "completed rows are read-only except delete");
		if (current.owner !== actor) {
			if (action === "update" && !(current.status === "cancelled" && params.status === "deleted")) return errorResult(state, "only the owner may edit a task");
			if (current.metadata?.protected === true) return errorResult(state, "task is protected");
		}
		if (action === "cancel") {
			const requested = current.owner !== actor && current.metadata?.cancel === "request";
			const updated: Task = requested ? {...current, metadata: {...current.metadata, cancelRequested: true, cancelledBy: actor ?? "main"}} : {...current, status:"cancelled"};
			const candidate = finalizeTaskState({...state, tasks:state.tasks.map(t => t.id === current.id ? updated : t)});
			if (candidate.error) return errorResult(state, candidate.error);
			const changed = taskChanged(current, updated);
			return {state: changed ? candidate.state : state, op:{kind:"update", id:current.id, fromStatus:current.status, toStatus:updated.status, changed}};
		}
	}
	// The wrapper has validated the one allowed exit from cancelled. Use delete's
	// existing reduction rather than relaxing the general transition table.
	const deletingCancelled = action === "update" && params.status === "deleted" && state.tasks.find(t => t.id === params.id)?.status === "cancelled";
	const reduced = reduceTaskMutation(state, deletingCancelled ? "delete" : action, params, actor);
	if (reduced.op.kind === "error") return reduced;
	const parent = reduced.state.tasks.find(t => t.id === params.id);
	if ((action === "delete" || action === "update" && params.status === "deleted") && parent?.status === "deleted" && parent.parentId === undefined) {
		const children = reduced.state.tasks.filter(t => t.parentId === parent.id && t.status !== "deleted");
		if (children.some(t => t.metadata?.protected === true)) return errorResult(state, "child task is protected");
		reduced.state = {...reduced.state, tasks:reduced.state.tasks.map(t => children.includes(t) ? {...t,status:"deleted"} : t)};
	}
	const checked = finalizeTaskState(reduced.state);
	if (checked.error) return errorResult(state, checked.error);
	return {...reduced, state: JSON.stringify(checked.state) === JSON.stringify(state) ? state : checked.state};
}

export interface SyncResult {
	state: TaskState;
	changed: boolean;
	lastSyncSeq?: number;
	error?: string;
}

/** lastSyncSeq is per-owner, in-memory slot data; callers commit it only on success. */
export function applyTaskSync(state: TaskState, actor: string | undefined, owner: string, seq: number, rows: readonly SyncRow[], lastSyncSeq?: number): SyncResult {
	const fail = (error: string): SyncResult => ({state, changed:false, lastSyncSeq, error});
	if (actor !== owner || !/^(execute:|worker:)/.test(owner)) return fail("sync requires the scoped owner actor");
	if (!Number.isSafeInteger(seq) || seq < 0) return fail("sync seq must be a nonnegative integer");
	if (lastSyncSeq !== undefined && seq <= lastSyncSeq) return {state, changed:false, lastSyncSeq};
	const keys = new Set<string>();
	for (const row of rows) {
		if (!row.key || keys.has(row.key)) return fail("sync keys must be nonempty and unique");
		keys.add(row.key);
	}
	let nextId = state.nextId;
	const owned = state.tasks.filter(t => t.owner === owner);
	const byKey = new Map(owned.map(t => [t.metadata?.key, t]));
	const incoming = rows.map(row => {
		const prior = byKey.get(row.key);
		if (prior && isTerminal(prior)) return prior;
		if (prior?.status === "completed") return row.status === "deleted" ? {...prior, status:"deleted" as const} : prior;
		return {...prior, id: prior?.id ?? nextId++, owner, subject:row.subject, status:row.status, activeForm:row.activeForm,
			metadata:{...row.metadata, key:row.key, ...(prior?.metadata?.cancelRequested ? {cancelRequested:true, cancelledBy:prior.metadata.cancelledBy} : {})}};
	});
	const incomingByKey = new Map<unknown, Task>();
	for (const task of incoming) if (!incomingByKey.has(task.metadata?.key)) incomingByKey.set(task.metadata?.key, task);
	let parents: Map<unknown, Task> | undefined;
	const existingParent = (key: string) => {
		if (!parents) {
			parents = new Map();
			for (const t of state.tasks) if (t.parentId === undefined && t.status !== "deleted" && !parents.has(t.metadata?.key)) parents.set(t.metadata?.key, t);
		}
		return parents.get(key);
	};
	for (let i=0; i<rows.length; i++) {
		const row = rows[i], task = incoming[i];
		const prior = byKey.get(row.key);
		if (prior && (isTerminal(prior) || prior.status === "completed")) continue;
		if (row.parentKey !== undefined) {
			const parent = incomingByKey.get(row.parentKey) ?? existingParent(row.parentKey);
			if (!parent) return fail("sync parentKey must name a top-level non-deleted row");
			task.parentId = parent.id;
		} else delete task.parentId;
	}
	const absent = owned.filter(t => !keys.has(String(t.metadata?.key))).map(t => t.status === "deleted" ? t : {...t, status:"deleted" as const});
	const replacements = new Map([...incoming, ...absent].map(t => [t.id, t]));
	const tasks = state.tasks.map(t => replacements.get(t.id) ?? t);
	const priorIds = new Set(state.tasks.map(t => t.id));
	tasks.push(...incoming.filter(t => !priorIds.has(t.id)));
	const checked = finalizeTaskState({tasks, nextId});
	if (checked.error) return fail(checked.error);
	const changed = JSON.stringify(checked.state) !== JSON.stringify(state);
	return {state:changed ? checked.state : state, changed, lastSyncSeq:seq};
}

/**
 * Drop an owner's tombstones once its display decisions are durable elsewhere.
 * Keeps summaries, pending cancellation markers and parents of live rows.
 */
export function applyTaskPurge(state: TaskState, actor: string | undefined, owner: string): SyncResult {
	if (actor !== owner || !/^(execute:|worker:)/.test(owner)) return {state, changed:false, error:"purge requires the scoped owner actor"};
	const liveParents = new Set(state.tasks.filter(t => t.status !== "deleted" && t.parentId !== undefined).map(t => t.parentId));
	const tasks = state.tasks.filter(t => !(t.owner === owner && t.status === "deleted" && t.metadata?.summary !== true &&
		!t.metadata?.cancelRequested && !liveParents.has(t.id)));
	return tasks.length === state.tasks.length ? {state, changed:false} : {state:{tasks, nextId:state.nextId}, changed:true};
}
