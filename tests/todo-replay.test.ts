import { applyTaskMutation } from "../vendor/rpiv-todo/state/state-reducer.ts";
import { expect, it } from "bun:test";
import type { Task } from "../vendor/rpiv-todo/tool/types.ts";
import { isTaskDetails, replayFromBranch } from "../vendor/rpiv-todo/state/replay.ts";
const snapshot = (subject:string) => ({tasks:[{id:1,subject,status:"pending"}],nextId:2});
const custom = (customType:string,data:unknown) => ({type:"custom",customType,data});
const tool = (details:unknown) => ({type:"message",message:{role:"toolResult",toolName:"todo",details}});
const replay = (branch:unknown[]) => replayFromBranch({sessionManager:{getBranch:()=>branch}});

it("replays all three sources in branch order, skipping unknown versions and malformed snapshots", () => {
 const branch = [tool(snapshot("legacy")),custom("rpiv-todo-state",snapshot("upstream")),custom("pitako-todo-state",{version:1,...snapshot("fork")})];
 expect(replay(branch).tasks[0].subject).toBe("fork");
 branch.push(tool(snapshot("latest result")));
 expect(replay(branch).tasks[0].subject).toBe("latest result");
 branch.push(custom("pitako-todo-state",{version:2,...snapshot("future")}));
 branch.push(custom("pitako-todo-state",snapshot("missing version")));
 branch.push(tool({tasks:[{id:0,subject:"bad",status:"pending"}],nextId:1}));
 expect(replay(branch).tasks[0].subject).toBe("latest result");
 branch.push(custom("rpiv-todo-state",snapshot("latest entry")));
 expect(replay(branch).tasks[0].subject).toBe("latest entry");
});

it("retains ownership, metadata, nesting, cancellation and tombstones without aliasing branch data", () => {
 const tasks: Task[] = [{id:1,subject:"parent",status:"cancelled",owner:"execute:r",metadata:{key:"p",protected:true}},
 {id:2,subject:"child",status:"deleted",owner:"execute:r",parentId:1,metadata:{key:"c",cancelRequested:true,cancelledBy:"main"}}];
 const branch = [custom("pitako-todo-state",{version:1,tasks,nextId:9})];
 const state = replay(branch);
 expect(state).toEqual({tasks,nextId:9});
 state.tasks[0].metadata!.key = "changed";
 expect(tasks[0].metadata!.key).toBe("p");
 expect(replay(branch).tasks[0].status).toBe("cancelled");
});

it("rejects invalid identity or subject snapshots instead of replacing the last valid list", () => {
 for (const tasks of [
   [{id:1,subject:" ",status:"pending"}], [{id:1,subject:"x".repeat(2001),status:"pending"}],
   [{id:1,subject:"a",status:"pending"},{id:1,subject:"b",status:"pending"}],
 ]) expect(isTaskDetails({tasks,nextId:3})).toBe(false);
 expect(isTaskDetails({...snapshot("x"),nextId:1})).toBe(false);
 expect(replay([null,42,custom("pitako-todo-state",{version:99,...snapshot("skip")})])).toEqual({tasks:[],nextId:1});
});

for (const source of ["rpiv-todo-state", "toolResult", "pitako-todo-state"]) {
 it(`keeps allocator high-water after a legacy clear from ${source}`, () => {
  const entry = (data:{tasks:unknown[];nextId:number}) => source === "toolResult" ? tool(data)
   : custom(source, source === "pitako-todo-state" ? {version:1,...data} : data);
  const state = replay([
   entry({tasks:[{id:7,subject:"gone",status:"pending"}],nextId:12}),
   entry({tasks:[],nextId:1}),
   custom("pitako-todo-state",{version:99,tasks:[],nextId:999}),
   tool({tasks:[{id:0,subject:"invalid",status:"pending"}],nextId:1000}),
  ]);
  expect(state).toEqual({tasks:[],nextId:12});
  const created = applyTaskMutation(state,"create",{subject:"fresh"});
  expect(created.op).toEqual({kind:"create",taskIds:[12]});
  expect(created.state.tasks).toMatchObject([{id:12,subject:"fresh"}]);
  expect(created.state.nextId).toBe(13);
 });
}
