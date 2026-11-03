import { describe, expect, it } from "bun:test";
import { applyTaskMutation as mutate, applyTaskSync as sync, changesState, finalizeTaskState } from "../vendor/rpiv-todo/state/state-reducer.ts";
import type { TaskState } from "../vendor/rpiv-todo/state/state.ts";
import type { Task, TaskAction, TaskMutationParams, SyncRow } from "../vendor/rpiv-todo/tool/types.ts";

const owner = "execute:run";
const worker = "worker:run:task:1";
const task = (id: number, extra: Partial<Task> = {}): Task => ({ id, subject: `task ${id}`, status: "pending", ...extra });
const state = (...tasks: Task[]): TaskState => ({ tasks, nextId: Math.max(0, ...tasks.map(t => t.id)) + 1 });
const row = (key: string, extra: Partial<SyncRow> = {}): SyncRow => ({key, subject: key, status:"pending", ...extra});
function rejects(input: TaskState, action: TaskAction, params: TaskMutationParams, actor?: string) {
	const before = JSON.stringify(input);
	const result = mutate(input, action, params, actor);
	expect(result.op.kind).toBe("error");
	expect(result.state).toBe(input);
	expect(JSON.stringify(input)).toBe(before);
	return result;
}

describe("actor-aware todo reducer", () => {
	it("stamps the actor, ignores supplied owner, and rejects reserved model owners including batches", () => {
		expect(mutate(state(), "create", {subject:"main", owner:"someone"}).state.tasks[0].owner).toBeUndefined();
		expect(mutate(state(), "create", {tasks:[{subject:"main"}], owner:"someone"}).state.tasks[0].owner).toBeUndefined();
		expect(mutate(state(), "create", {subject:"scoped", owner:"someone"}, owner).state.tasks[0].owner).toBe(owner);
		rejects(state(), "create", {subject:"bad", owner});
		rejects(state(), "create", {tasks:[{subject:"bad", owner:worker}]});
		const original = state(task(1, {owner}));
		rejects(original, "update", {id:1, subject:"stolen"});
		rejects(original, "update", {id:1, status:"completed"}, worker);
		const edited = mutate(original, "update", {id:1, subject:"display", description:"detail", activeForm:"editing", status:"in_progress"}, owner);
		expect(edited.state.tasks[0]).toMatchObject({owner, subject:"display", description:"detail", activeForm:"editing", status:"in_progress"});
		expect(mutate(edited.state, "update", {id:1, subject:"still editable"}, owner).state.tasks[0].subject).toBe("still editable");
	});

	it("non-owners cancel or delete, but protected rows refuse both", () => {
		const original = state(task(1, {owner}));
		expect(mutate(original, "cancel", {id:1}).state.tasks[0].status).toBe("cancelled");
		expect(mutate(original, "delete", {id:1}).state.tasks[0].status).toBe("deleted");
		const protectedState = state(task(1, {owner, metadata:{protected:true}}));
		rejects(protectedState, "cancel", {id:1});
		rejects(protectedState, "delete", {id:1});
		expect(mutate(protectedState, "cancel", {id:1}, owner).state.tasks[0].status).toBe("cancelled");
	});

	it("cancel request retains status, records actor and is idempotent", () => {
		const original = state(task(1, {owner, metadata:{cancel:"request", key:"plan"}}));
		const result = mutate(original, "cancel", {id:1, reason:"stop"}, worker);
		expect(result.state.tasks[0]).toMatchObject({status:"pending", metadata:{cancel:"request", cancelRequested:true, cancelledBy:worker, key:"plan"}});
		const again = mutate(result.state, "cancel", {id:1}, worker);
		expect(again.state).toBe(result.state);
		expect(changesState(again.op)).toBe(false);
		expect(mutate(result.state, "delete", {id:1}, worker).state.tasks[0].status).toBe("deleted");
	});

	it("completed is read-only except delete; cancelled and deleted remain terminal", () => {
		const completed = state(task(1, {status:"completed"}));
		for (const params of [{id:1, subject:"new"}, {id:1, status:"completed" as const}, {id:1, status:"deleted" as const, subject:"new"}]) rejects(completed, "update", params);
		rejects(completed, "cancel", {id:1});
		expect(mutate(completed, "delete", {id:1}).state.tasks[0].status).toBe("deleted");
		for (const status of ["cancelled", "deleted"] as const) {
			const terminal = state(task(1, {owner, status, metadata:{key:"a"}}));
			rejects(terminal, "update", {id:1, status:"pending"}, owner);
			if (status === "deleted") rejects(terminal, "delete", {id:1}, owner);
			else expect(mutate(terminal, "delete", {id:1}, owner).state.tasks[0].status).toBe("deleted");
			const updated = sync(terminal, owner, owner, 1, [row("a", {subject:"revive"})]);
			expect(updated.state).toBe(terminal);
			expect(updated.changed).toBe(false);
			expect(updated.state.nextId).toBe(2);
		}
	});

	it("allows one in_progress per owner, never silently demotes", () => {
		const original = state(task(1, {status:"in_progress"}), task(2), task(3, {owner}));
		rejects(original, "update", {id:2, status:"in_progress"});
		const result = mutate(original, "update", {id:3, status:"in_progress"}, owner);
		expect(result.state.tasks.filter(t => t.status === "in_progress")).toHaveLength(2);
		const invalid = sync(state(), owner, owner, 1, [row("a", {status:"in_progress"}), row("b", {status:"in_progress"})]);
		expect(invalid.error).toContain("one in_progress");
		expect(invalid.state.tasks).toEqual([]);
	});

	it("validates parents on resulting snapshots and orders children immediately after parents", () => {
		const original = state(task(1), task(2));
		const created = mutate(original, "create", {subject:"child", parentId:1});
		expect(created.state.tasks.map(t => t.id)).toEqual([1,3,2]);
		rejects(original, "create", {subject:"missing", parentId:99});
		rejects(created.state, "create", {subject:"nested", parentId:3});
		const deleted = mutate(created.state, "delete", {id:1});
		expect(deleted.state.tasks.map(t => [t.id,t.status])).toEqual([[1,"deleted"],[3,"deleted"],[2,"pending"]]);
		rejects(created.state, "update", {id:1, status:"completed"});
		const scopedChild = state(task(1), task(2, {owner, parentId:1}));
		rejects(scopedChild, "clear", {});
		const running = state(task(1, {status:"in_progress"}), task(2, {parentId:1, owner, status:"in_progress"}));
		rejects(running, "update", {id:1, status:"pending"});
		rejects(state(task(1), task(2, {owner, parentId:1})), "update", {id:2, status:"in_progress"}, owner);
	});

	it("accepts subject bounds and atomically rejects invalid create, batch, update and sync subjects", () => {
		expect(mutate(state(), "create", {subject:"x".repeat(2000)}).op.kind).toBe("create");
		for (const subject of ["", " \t", "x".repeat(2001)]) {
			rejects(state(), "create", {subject});
			rejects(state(), "create", {tasks:[{subject:"valid"}, {subject}]});
			rejects(state(task(1)), "update", {id:1, subject});
			const result = sync(state(), owner, owner, 1, [row("bad", {subject})]);
			expect(result.error).toBeDefined();
			expect(result.state.tasks).toEqual([]);
		}
	});

	it("clear removes only actor rows and never reuses ids, including empty clear", () => {
		const original = state(task(6), task(7, {owner}));
		const cleared = mutate(original, "clear", {});
		expect(cleared.state).toEqual({tasks:[original.tasks[1]], nextId:8});
		expect(mutate(cleared.state, "create", {subject:"new"}).state.tasks[1].id).toBe(8);
		const emptyClear = mutate(cleared.state, "clear", {});
		expect(emptyClear.state).toBe(cleared.state);
		expect(changesState(emptyClear.op)).toBe(false);
	});

	it("prunes only scoped deleted rows oldest-first and retains nextId", () => {
		const original = state(...Array.from({length:1000}, (_,i) => task(i+1, i < 3 ? {owner: i===0 ? undefined : owner, status:"deleted"} : {})));
		const result = mutate(original, "create", {subject:"new"});
		expect(result.op.kind).toBe("create");
		expect(result.state.tasks).toHaveLength(1000);
		expect(result.state.tasks.some(t => t.id === 1)).toBe(true);
		expect(result.state.tasks.some(t => t.id === 2)).toBe(false);
		expect(result.state.tasks.some(t => t.id === 3)).toBe(true);
		expect(result.state.nextId).toBe(1002);
		const cleared = mutate(result.state, "clear", {});
		expect(mutate(cleared.state, "create", {subject:"later"}).state.nextId).toBe(1003);
	});

	it("fails count and UTF-8 byte limits with no partial state", () => {
		const full = state(...Array.from({length:1000}, (_,i) => task(i+1)));
		rejects(full, "create", {subject:"overflow"});
		const original = state(task(1));
		rejects(original, "update", {id:1, description:"é".repeat(131072)});
		const result = sync(original, owner, owner, 1, [row("big", {metadata:{data:"é".repeat(131072)}})]);
		expect(result.state).toBe(original);
		expect(result.error).toContain("262144");
		const base = state(task(1));
		const overhead = new TextEncoder().encode(JSON.stringify({version:1, ...base, tasks:[{...base.tasks[0], description:""}]})).length;
		const atLimit = mutate(base, "update", {id:1, description:"x".repeat(262144-overhead)});
		expect(atLimit.op.kind).toBe("update");
		rejects(base, "update", {id:1, description:"x".repeat(262145-overhead)});
	});

	it("byte pruning preserves non-scoped tombstones and never lowers nextId", () => {
		const input = state(task(1, {owner, status:"deleted", description:"x".repeat(200000)}), task(2, {status:"deleted"}));
		const result = mutate(input, "create", {subject:"live", description:"x".repeat(100000)});
		expect(result.state.tasks.map(t => t.id)).toEqual([2,3]);
		expect(result.state.nextId).toBe(4);
		expect(finalizeTaskState(result.state).error).toBeUndefined();
	});

	it("sync matches keys, scopes replacements, resolves parents, tombstones absent rows and ignores stale seq", () => {
		const main = task(1);
		const start = state(main);
		const first = sync(start, owner, owner, 3, [row("child", {parentKey:"parent"}), row("parent")]);
		expect(first.error).toBeUndefined();
		expect(first.state.tasks.map(t => t.subject)).toEqual([main.subject,"parent","child"]);
		expect(first.state.tasks[2].parentId).toBe(first.state.tasks[1].id);
		const childId = first.state.tasks[2].id;
		expect(sync(first.state, owner, owner, 3, [], 3).state).toBe(first.state);
		const stale = sync(first.state, owner, owner, 2, [], first.lastSyncSeq);
		expect(stale.state).toBe(first.state);
		expect(stale.lastSyncSeq).toBe(3);
		const same = sync(first.state, owner, owner, 4, [row("child", {parentKey:"parent"}), row("parent")], first.lastSyncSeq);
		expect(same.changed).toBe(false);
		expect(same.lastSyncSeq).toBe(4);
		const removed = sync(same.state, owner, owner, 5, [row("parent")], same.lastSyncSeq);
		expect(removed.state.tasks.find(t => t.id === childId)?.status).toBe("deleted");
		expect(removed.state.tasks[0]).toEqual(main);
		const revived = sync(removed.state, owner, owner, 6, [row("parent"), row("child", {parentKey:"parent"})], 5);
		expect(revived.state.tasks.find(t => t.id === childId)?.status).toBe("deleted");
		expect(revived.state.nextId).toBe(first.state.nextId);
	});

	it("sync resolves existing top-level parent keys across owners without changing their rows", () => {
		for (const parentOwner of [owner, "worker:other:task:1", undefined]) {
			const parent = task(1, {owner:parentOwner, status:"in_progress", metadata:{key:"plan"}});
			const input = state(parent);
			const before = JSON.stringify(input);
			const rows = [row("step", {parentKey:"plan", status:"in_progress"})];
			const result = sync(input, worker, worker, 1, rows);
			expect(result.error).toBeUndefined();
			expect(result.state.tasks.map(t => t.id)).toEqual([1,2]);
			expect(result.state.tasks[1]).toMatchObject({owner:worker, parentId:1, metadata:{key:"step"}});
			expect(JSON.stringify(input)).toBe(before);
			expect(result.state.tasks[0]).toBe(parent);
			expect(sync(result.state, worker, worker, 2, rows, 1).changed).toBe(false);
		}
	});

	it("sync fallback rejects missing, deleted and nested parents atomically and prefers snapshot parents", () => {
		for (const input of [state(), state(task(1, {owner, status:"deleted", metadata:{key:"plan"}})), state(task(1, {owner}), task(2, {owner, parentId:1, metadata:{key:"plan"}}))]) {
			const before = JSON.stringify(input);
			const result = sync(input, worker, worker, 2, [row("step", {parentKey:"plan"})], 1);
			expect(result.error).toBeDefined();
			expect(result.state).toBe(input);
			expect(result.changed).toBe(false);
			expect(result.lastSyncSeq).toBe(1);
			expect(JSON.stringify(input)).toBe(before);
		}
		const input = state(task(1, {owner, metadata:{key:"plan"}}));
		const result = sync(input, worker, worker, 1, [row("step", {parentKey:"plan"}), row("plan")]);
		expect(result.error).toBeUndefined();
		expect(result.state.tasks.find(t => t.metadata?.key === "step")?.parentId).toBe(3);
		expect(result.state.tasks[0]).toBe(input.tasks[0]);
	});

	it("owner cancellation by update and sync cannot be undone by later snapshots", () => {
		const initial = sync(state(), owner, owner, 1, [row("a")]);
		const cancelled = mutate(initial.state, "update", {id:1, status:"cancelled"}, owner);
		expect(cancelled.state.tasks[0].status).toBe("cancelled");
		expect(sync(cancelled.state, owner, owner, 2, [row("a", {status:"in_progress"})], 1).state).toBe(cancelled.state);
		const completed = sync(state(), owner, owner, 1, [row("done", {status:"completed"})]);
		const deleted = sync(completed.state, owner, owner, 2, [row("done", {status:"deleted", subject:"ignored"})], 1);
		expect(deleted.state.tasks[0]).toMatchObject({subject:"done", status:"deleted"});
		const directly = sync(state(), owner, owner, 1, [row("a", {status:"cancelled"})]);
		expect(sync(directly.state, owner, owner, 2, [], 1).state.tasks[0].status).toBe("deleted");
		const requested = mutate(initial.state, "update", {id:1, metadata:{cancel:"request"}}, owner);
		const pending = mutate(requested.state, "cancel", {id:1});
		const refreshed = sync(pending.state, owner, owner, 2, [row("a")], 1);
		expect(refreshed.state.tasks[0].metadata).toMatchObject({cancelRequested:true, cancelledBy:"main"});
	});

	it("sync rejects wrong actor, duplicate keys, missing/nested parents and invalid snapshots atomically", () => {
		const input = state();
		for (const result of [sync(input, worker, owner, 1, []), sync(input, owner, owner, 1, [row("a"), row("a")]), sync(input, owner, owner, 1, [row("a", {parentKey:"missing"})]), sync(input, owner, owner, 1, [row("a"), row("b", {parentKey:"a"}), row("c", {parentKey:"b"})])]) {
			expect(result.error).toBeDefined();
			expect(result.state).toBe(input);
			expect(result.lastSyncSeq).toBeUndefined();
		}
	});
});

// Human amendment: cancelled history can hide, but cannot revive or change fields.
it("cancelled-to-deleted fork prerequisite honors ownership and sync omission", () => {
 const original = state(task(1, {owner, status:"cancelled", metadata:{key:"a"}}));
 for (const actor of [owner, undefined, worker]) {
  for (const action of ["delete", "update"] as const) {
   const result = mutate(original, action, {id:1, ...(action === "update" ? {status:"deleted" as const} : {})}, actor);
   expect(result.op.kind).not.toBe("error");
   expect(result.state.tasks[0]).toEqual({...original.tasks[0],status:"deleted"});
  }
  for (const status of ["pending","in_progress","completed","cancelled"] as const)
   rejects(original,"update",{id:1,status},actor);
  rejects(original,"update",{id:1,status:"deleted",subject:"edit"},actor);
  rejects(original,"update",{id:1,metadata:{edit:true}},actor);
 }
 const protectedRow = state({...original.tasks[0],metadata:{key:"a",protected:true}});
 rejects(protectedRow,"delete",{id:1});
 rejects(protectedRow,"update",{id:1,status:"deleted"});
 expect(mutate(protectedRow,"delete",{id:1},owner).state.tasks[0].status).toBe("deleted");
 const present = sync(original,owner,owner,1,[row("a",{status:"deleted",subject:"changed"})]);
 expect(present.state).toBe(original);
 const absent = sync(original,owner,owner,2,[]);
 expect(absent.error).toBeUndefined();
 expect(absent.state.tasks[0]).toEqual({...original.tasks[0],status:"deleted"});
 expect(sync(absent.state,owner,owner,3,[row("a")]).state).toBe(absent.state);
});

it("parent delete cascades across owners, including completed and cancelled children, atomically", () => {
 for (const action of ["delete", "update"] as const) for (const actor of [owner, undefined]) {
  const original=state(task(1,{owner}),task(2,{owner:worker,parentId:1,status:"pending"}),task(3,{owner:worker,parentId:1,status:"completed"}),task(4,{owner:worker,parentId:1,status:"cancelled"}),task(5,{owner:worker,parentId:1,status:"deleted"}));
  const params={id:1,...(action==="update" ? {status:"deleted" as const} : {})};
  if(action==="update" && actor!==owner) {rejects(original,action,params,actor);continue;}
  const result=mutate(original,action,params,actor);
  expect(result.op.kind).not.toBe("error");
  expect(result.state.tasks.every(t=>t.status==="deleted")).toBe(true);
  expect(result.state.nextId).toBe(original.nextId);
  expect(original.tasks[0].status).toBe("pending");
  const protectedChild=state(original.tasks[0],{...original.tasks[1],metadata:{protected:true}});
  rejects(protectedChild,action,params,actor);
  const alone=state(original.tasks[0]);
  expect(mutate(alone,action,params,actor).state.tasks[0]).toEqual({...alone.tasks[0],status:"deleted"});
 }
 const protectedParent=state(task(1,{owner,metadata:{protected:true}}),task(2,{owner:worker,parentId:1}));
 rejects(protectedParent,"delete",{id:1});
});
