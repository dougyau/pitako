import type { TaskAction, TaskMutationParams, SyncRow } from "../tool/types.ts";
import { STATE_ENTRY_TYPE } from "../tool/types.ts";
import type { TaskState } from "./state.ts";
import { applyTaskMutation, applyTaskSync, finalizeTaskState, type Op } from "./state-reducer.ts";
import { commitState, commitSyncSequences, getActiveRenderSession, getState, getSyncSequences } from "./store.ts";

export type CommitOperation =
	| { action: TaskAction; params: TaskMutationParams }
	| { action: "sync"; owner: string; seq: number; rows: readonly SyncRow[] };

export interface CommitResult {
	state: TaskState;
	changed: boolean;
	error?: string;
	/** Last reducer outcome, used by the tool's response formatter. */
	op?: Op;
}

export type TodoCommit = (sessionId: string, actor: string | undefined, ops: readonly CommitOperation[]) => CommitResult;

/** One synchronous write boundary. Replay replacement is a separate lifecycle read. */
export function createTodoCommit(
	pi: { appendEntry(type: string, data: unknown): void },
	refreshOverlay: () => void = () => {},
): TodoCommit {
	return (sessionId, actor, ops) => {
		const before = getState(sessionId);
		let state = before;
		let op: Op | undefined;
		const sequences = new Map(getSyncSequences(sessionId));
		const fail = (error: string): CommitResult => ({ state: before, changed: false, error, op: { kind: "error", message: error } });
		for (const operation of ops) {
			if (operation.action === "sync") {
				const result = applyTaskSync(state, actor, operation.owner, operation.seq, operation.rows, sequences.get(operation.owner));
				if (result.error) return fail(result.error);
				state = result.state;
				if (result.lastSyncSeq !== undefined) sequences.set(operation.owner, result.lastSyncSeq);
			} else {
				const result = applyTaskMutation(state, operation.action, operation.params, actor);
				if (result.op.kind === "error") return fail(result.op.message);
				state = result.state;
				op = result.op;
			}
		}
		const checked = finalizeTaskState(state);
		if (checked.error) return fail(checked.error);
		state = checked.state;
		const changed = JSON.stringify(before) !== JSON.stringify(state);
		commitSyncSequences(sessionId, sequences);
		if (!changed) return { state: before, changed: false, op };
		commitState(sessionId, state);
		// A pending lazy import schedules a render of the committed store, not a captured snapshot.
		if (sessionId === getActiveRenderSession()) refreshOverlay();
		pi.appendEntry(STATE_ENTRY_TYPE, { version: 1, tasks: state.tasks, nextId: state.nextId });
		return { state, changed: true, op };
	};
}
