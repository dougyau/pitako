import { beforeEach, expect, it } from "bun:test";
import { isolateTodoConfig } from "../vendor/rpiv-todo/test-isolation.ts";
import { createMockPi, createMockCtx, makeCustomEntry } from "../vendor/rpiv-todo/test-utils.ts";
import { createTodoCommit } from "../vendor/rpiv-todo/state/commit.ts";
import { __resetState, getState, setActiveRenderSession, replaceState } from "../vendor/rpiv-todo/state/store.ts";
import type { TaskDetails } from "../vendor/rpiv-todo/tool/types.ts";
import { registerTodoTool } from "../vendor/rpiv-todo/todo.ts";
import registerTodo from "../vendor/rpiv-todo/index.ts";
import { replayFromBranch } from "../vendor/rpiv-todo/state/replay.ts";
isolateTodoConfig();
beforeEach(__resetState);

it("commits atomically, refreshes only foreground after store and before one v1 append", () => {
 const order: string[] = [];
 const entries: unknown[] = [];
 setActiveRenderSession("main");
 const commit = createTodoCommit({appendEntry(type, data) {
   expect(type).toBe("pitako-todo-state"); entries.push(data); order.push("append");
 }}, () => { expect(getState("main").tasks).toHaveLength(2); order.push("refresh"); });
 const result = commit("main", undefined, [
   {action:"create",params:{subject:"one"}}, {action:"create",params:{subject:"two"}}
 ]);
 expect(result.error).toBeUndefined(); expect(result.changed).toBe(true);
 expect(getState("main")).toBe(result.state);
 expect(order).toEqual(["refresh", "append"]);
 expect(entries).toEqual([{version:1,tasks:result.state.tasks,nextId:3}]);
 const failed = commit("main", undefined, [
   {action:"update",params:{id:1,status:"in_progress"}},
   {action:"update",params:{id:2,status:"in_progress"}}
 ]);
 expect(failed.error).toContain("one in_progress");
 expect(failed.state).toBe(result.state); expect(failed.changed).toBe(false);
 for (const action of ["list", "get", "update"] as const)
   expect(commit("main",undefined,[{action,params:{id:1,status:"pending"}}]).changed).toBe(false);
 expect(entries).toHaveLength(1);
 commit("child",undefined,[{action:"create",params:{subject:"child"}}]);
 expect(order).toEqual(["refresh","append","append"]);
 expect(getState("main")).toBe(result.state);
});

it("records unchanged sync sequences, rolls them back on error, and preserves terminal rows through replay", () => {
 const entries: {type:string;customType:string;data:unknown}[] = [];
 const commit = createTodoCommit({appendEntry(customType,data) { entries.push({type:"custom",customType,data}); }});
 const owner = "execute:run";
 const rows = [{key:"task",subject:"owned",status:"pending" as const}];
 const sync = (seq:number) => ({action:"sync" as const,owner,seq,rows});
 expect(commit("s",owner,[sync(1)]).changed).toBe(true);
 expect(commit("s",owner,[sync(3)]).changed).toBe(false);
 expect(commit("s",owner,[{...sync(2),rows:[]}]).changed).toBe(false);
 expect(commit("s",owner,[{...sync(4),rows:[]},{action:"update",params:{id:999,status:"pending"}}]).error).toBeDefined();
 expect(commit("s",owner,[{...sync(4),rows:[{...rows[0],subject:"renamed"}]}]).changed).toBe(true);
 expect(commit("s",undefined,[{action:"cancel",params:{id:1}}]).changed).toBe(true);
 replaceState("resumed",replayFromBranch({sessionManager:{getBranch:()=>entries}}));
 expect(commit("resumed",owner,[sync(1)]).changed).toBe(false);
 expect(getState("resumed").tasks[0].status).toBe("cancelled");
 expect(commit("resumed",owner,[{...sync(2), rows:[...rows,{key:"deleted",subject:"gone",status:"deleted"}]}]).changed).toBe(true);
 expect(commit("resumed",owner,[{...sync(3),rows:[...rows,{key:"deleted",subject:"revived",status:"pending"}]}]).changed).toBe(false);
 expect(entries).toHaveLength(4);
});

it("tool is main actor, ignores supplied owners, rejects reserved owners in both call shapes, and appends before returning", async () => {
 const {pi,captured} = createMockPi();
 registerTodoTool(pi);
 const tool = captured.tools.get("todo"); if (!tool) throw new Error("missing tool");
 const call = (params: Record<string,unknown>) => tool.execute!("tc",params as never,undefined,undefined,createMockCtx());
 const result = await call({action:"create",subject:"main",owner:"someone"});
 expect((result.details as TaskDetails).tasks[0].owner).toBeUndefined();
 expect(captured.entries).toHaveLength(1);
 expect(captured.entries[0]).toMatchObject({customType:"pitako-todo-state",data:{version:1,nextId:2}});
 for (const owner of ["execute:run","worker:run:t:1"]) {
   expect(((await call({action:"create",subject:"bad",owner})).details as TaskDetails).error).toContain("reserved");
   expect(((await call({action:"create",tasks:[{subject:"bad",owner}]})).details as TaskDetails).error).toContain("reserved");
 }
 expect(captured.entries).toHaveLength(1);
});

it("pending lazy refresh starts before append and reads the latest committed state when resolved", async () => {
 let release!: (mod: typeof import("../vendor/rpiv-todo/todo-overlay.ts")) => void;
 const gate = new Promise<typeof import("../vendor/rpiv-todo/todo-overlay.ts")>(resolve => {release=resolve;});
 const observed: string[][] = [];
 const order: string[] = [];
 const {pi,captured} = createMockPi();
 const append = pi.appendEntry;
 pi.appendEntry = (type,data) => { order.push("append"); append(type,data); };
 registerTodo(pi, () => {order.push("import"); return gate;});
 const ctx = createMockCtx({hasUI:true,sessionId:"main"});
 const start = captured.events.get("session_start")![0];
 await start({} as never,ctx);
 const tool = captured.tools.get("todo")!;
 const first = tool.execute!("one",{action:"create",subject:"one"} as never,undefined,undefined,ctx);
 const second = tool.execute!("two",{action:"create",subject:"two"} as never,undefined,undefined,ctx);
 await Promise.all([first,second]);
 expect(order).toEqual(["import","append","append"]);
 const {TodoOverlay} = await import("../vendor/rpiv-todo/todo-overlay.ts");
 class ObservedOverlay extends TodoOverlay {
   override update() { observed.push(getState("main").tasks.map(t=>t.subject)); }
 }
 release({TodoOverlay:ObservedOverlay});
 await gate;
 // Await the same loader through the lifecycle; no sleeps or timer races.
 await captured.events.get("session_compact")![0]({} as never,createMockCtx({hasUI:true,sessionId:"main",branch:captured.entries.map(e=>makeCustomEntry(e.customType,e.data))}));
 expect(observed.length).toBeGreaterThan(0);
 expect(observed.every(rows => rows.join() === "one,two")).toBe(true);
 await captured.events.get("session_shutdown")![0]({} as never,ctx);
});

for (const event of ["session_start", "session_compact", "session_tree"] as const) {
 it(`keeps mutable-row sync watermarks through same-session ${event} replay`, async () => {
  const {pi,captured} = createMockPi();
  const commit = registerTodo(pi);
  const owner = "execute:run";
  const rows = [{key:"task",subject:"current",status:"pending" as const}];
  const sync = (seq:number) => ({action:"sync" as const,owner,seq,rows});
  expect(commit("s",owner,[sync(1)]).changed).toBe(true);
  // Even an unchanged sync advances the watermark without an entry.
  expect(commit("s",owner,[sync(3)]).changed).toBe(false);
  const ctx = createMockCtx({sessionId:"s",branch:captured.entries.map(e=>makeCustomEntry(e.customType,e.data))});
  await captured.events.get(event)![0]({} as never,ctx);
  const restored = getState("s");
  for (const seq of [2,3]) {
   for (const staleRows of [[],[{...rows[0],subject:"stale"}]]) {
    const result = commit("s",owner,[{...sync(seq),rows:staleRows}]);
    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(false);
    expect(result.state).toBe(restored);
   }
  }
  expect(restored.tasks).toMatchObject([{subject:"current",status:"pending"}]);
  expect(captured.entries).toHaveLength(1);
  expect(commit("s",owner,[{...sync(4),rows:[{...rows[0],subject:"newer"}]}]).changed).toBe(true);
  expect(captured.entries).toHaveLength(2);
  await captured.events.get("session_shutdown")![0]({} as never,ctx);
 });
}
