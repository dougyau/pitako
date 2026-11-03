import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendExecuteTodoRecords, deriveExecuteTodoRequests, latestExecuteTodoSnapshot, projectExecuteTodos, registerExecuteTodoProjection, type ExecuteTodoSnapshot, type WorkerTodoSnapshot } from "../extensions/execute-todo-projection.ts";
import { createTodoCommit } from "../vendor/rpiv-todo/index.ts";
import { getState, getSyncSequences, evictSession, replaceState } from "../vendor/rpiv-todo/state/store.ts";
import { createMockPi, createMockCtx } from "../vendor/rpiv-todo/test-utils.ts";
import type { Task } from "../vendor/rpiv-todo/tool/types.ts";

function snapshot(extra: Partial<ExecuteTodoSnapshot> = {}): ExecuteTodoSnapshot {
  return {schema:"pitako.execute-todo",v:1,seq:1,invocation:"invocation",loop:1,maxLoops:3,
    phases:[{name:"plan",subject:"Loop 1/3 · Plan",status:"completed"}],
    tasks:[{id:"t1",subject:"Build",status:"in_progress",blockedBy:[]}],
    active:{taskId:"t1",attempt:1,workflowKey:"work.t1.a1"},outcome:null,...extra};
}
const worker = (tasks: Task[] = [{id:1,subject:"Edit",status:"in_progress"},{id:2,subject:"Test",status:"pending"}]): WorkerTodoSnapshot => ({taskId:"t1",attempt:1,tasks});
function fixture() {
  const {pi,captured} = createMockPi(), sid=randomUUID();
  const commit=createTodoCommit(pi);
  function apply(s: ExecuteTodoSnapshot, workers: WorkerTodoSnapshot[] = [], run="run") {
    const operations=projectExecuteTodos(run,s,workers,getState(sid));
    for (const op of operations) {
      const result=commit(sid,op.owner,[{action:"sync",...op,seq:(getSyncSequences(sid).get(op.owner)??0)+1}]);
      expect(result.error).toBeUndefined();
    }
    return getState(sid);
  }
  return {sid,commit,captured,apply,close:()=>evictSession(sid)};
}
const visible = (tasks: readonly Task[]) => tasks.filter(t=>t.status!=="deleted");

describe("execute todo pure projection", () => {
  test("validates whole snapshots and chooses newest, not last; malformed emits do not leak drafts", () => {
    const next=snapshot({seq:2});
    expect(latestExecuteTodoSnapshot([snapshot(),next,snapshot(),{...next,seq:3,tasks:[{id:"draft"}]}])).toEqual(next);
    for (const bad of [{...next,v:2},{...next,seq:0},{...next,invocation:"../escape"},{...next,tasks:[next.tasks[0],next.tasks[0]]},{...next,phases:[{name:"other",subject:"bad",status:"pending"}]}])
      expect(latestExecuteTodoSnapshot([bad])).toBeUndefined();
    const planning=snapshot({tasks:[],active:null,phases:[{name:"plan",subject:"Loop 1/3 · Plan",status:"in_progress"}]});
    const result=projectExecuteTodos("run",planning,[],{tasks:[],nextId:1});
    expect(projectExecuteTodos("run",{...planning,phases:[{...planning.phases[0],status:"cancelled",reason:"Plan rejected"}]},[],{tasks:[],nextId:1})[0].rows[0].subject).toBe("Loop 1/3 · Plan · Plan rejected");
    expect(result).toEqual([{owner:"execute:run",rows:[{key:"exec:run:phase:1:plan",subject:"Loop 1/3 · Plan",status:"in_progress",metadata:{invocation:"invocation",loop:1,protected:true}}]}]);
  });

  test("whole snapshots nest worker steps, protect phases, and no-op across repeats and reload", () => {
    const f=fixture();
    try {
      const state=f.apply(snapshot(),[worker()]);
      const parent=state.tasks.find(t=>t.metadata?.taskId==="t1" && !t.parentId)!;
      expect(parent).toMatchObject({owner:"execute:run",status:"in_progress",metadata:{key:"exec:run:task:1:t1",cancel:"request"}});
      const children=state.tasks.filter(t=>t.parentId===parent.id);
      expect(children).toHaveLength(2);
      expect(children[0]).toMatchObject({owner:"worker:run:t1:1",metadata:{key:"exec:run:step:1:t1:1:1"}});
      const count=f.captured.entries.length;
      f.apply(snapshot(),[worker()]); expect(f.captured.entries).toHaveLength(count);
      // Simulate process-local seq loss, retaining exactly the persisted state.
      evictSession(f.sid); replaceState(f.sid,state);
      f.apply(snapshot(),[worker()]); expect(f.captured.entries).toHaveLength(count);
      const phase=state.tasks.find(t=>t.metadata?.protected)!;
      expect(f.commit(f.sid,undefined,[{action:"cancel",params:{id:phase.id}}]).error).toBeDefined();
      expect(f.commit(f.sid,undefined,[{action:"delete",params:{id:phase.id}}]).error).toContain("protected");
    } finally {f.close();}
  });

  test("main cancellation marker is added and removed, requests re-derive, and step cancellation stays sticky", () => {
    const f=fixture(); const root=mkdtempSync(path.join(tmpdir(),"pitako-projection-requests-"));
    try {
      let state=f.apply(snapshot(),[worker()]);
      const plan=state.tasks.find(t=>t.metadata?.key==="exec:run:task:1:t1")!;
      expect(f.commit(f.sid,undefined,[{action:"cancel",params:{id:plan.id}}]).error).toBeUndefined();
      state=f.apply(snapshot(),[worker()]);
      expect(state.tasks.find(t=>t.id===plan.id)?.subject).toBe("Build (cancelación pedida)");
      const requests=deriveExecuteTodoRequests("run",snapshot(),state);
      expect(requests).toMatchObject([{v:1,invocation:"invocation",taskId:"t1",kind:"cancel",origin:"model"}]);
      appendExecuteTodoRecords(root,"invocation","requests.jsonl",requests);
      appendExecuteTodoRecords(root,"invocation","requests.jsonl",deriveExecuteTodoRequests("run",snapshot(),state));
      const file=path.join(root,".pi/subagents/execute/invocation/requests.jsonl");
      expect(readFileSync(file,"utf8").trim().split("\n")).toHaveLength(1);
      const step=state.tasks.find(t=>t.parentId===plan.id)!;
      expect(f.commit(f.sid,undefined,[{action:"cancel",params:{id:step.id}}]).error).toBeUndefined();
      expect(f.apply(snapshot(),[worker()]).tasks.find(t=>t.id===step.id)?.status).toBe("cancelled");
      const done=snapshot({seq:2,tasks:[{...snapshot().tasks[0],status:"completed"}],active:null});
      state=f.apply(done);
      expect(state.tasks.find(t=>t.id===plan.id)).toMatchObject({subject:"Build",status:"completed"});
      expect(deriveExecuteTodoRequests("run",done,state)[0]?.requestId).toBe(requests[0].requestId);
      expect(f.commit(f.sid,undefined,[{action:"delete",params:{id:step.id}}]).error).toBeUndefined();
    } finally {f.close();rmSync(root,{recursive:true,force:true});}
  });

  test("Q6 closes unfinished steps immediately before completing the parent, including missed child reads", () => {
    const f=fixture();
    try {
      f.apply(snapshot(),[worker()]);
      const before=f.captured.entries.length;
      // A missing session file on a hint cannot close a still-active worker.
      f.apply(snapshot()); expect(f.captured.entries).toHaveLength(before);
      const done=snapshot({seq:2,tasks:[{...snapshot().tasks[0],status:"completed"}],active:null});
      f.apply(done);
      const entries=f.captured.entries.slice(before).map(e=>e.data as {tasks:Task[]});
      expect(entries).toHaveLength(2);
      expect(entries[0].tasks.filter(t=>t.parentId).every(t=>t.status==="cancelled")).toBe(true);
      expect(entries[0].tasks.find(t=>t.owner==="execute:run" && t.metadata?.taskId==="t1")?.status).toBe("in_progress");
      expect(entries[1].tasks.find(t=>t.owner==="execute:run" && t.metadata?.taskId==="t1")?.status).toBe("completed");
    } finally {f.close();}
  });

  test("Q7 collapses cancelled loop rows and prunes steps; Q8 retains terminal summaries and permits hiding", () => {
    const f=fixture();
    try {
      f.apply(snapshot(),[worker()]);
      f.apply(snapshot({seq:2,active:null,tasks:[{...snapshot().tasks[0],status:"cancelled"}]}));
      let state=f.apply(snapshot({seq:3,active:null,outcome:"gaps",tasks:[{...snapshot().tasks[0],status:"cancelled"}]}));
      expect(visible(state.tasks)).toHaveLength(1);
      expect(visible(state.tasks)[0]).toMatchObject({subject:"Loop 1/3 · gaps (0 de 1)",status:"cancelled",metadata:{key:"exec:run:summary:1"}});
      expect(state.tasks.filter(t=>t.parentId).every(t=>t.status==="deleted")).toBe(true);
      const count=f.captured.entries.length;
      f.apply(snapshot({seq:3,active:null,outcome:"gaps",tasks:[{...snapshot().tasks[0],status:"cancelled"}]}));
      expect(f.captured.entries).toHaveLength(count);
      const old=visible(state.tasks)[0];
      state=f.apply(snapshot({seq:4,loop:2,tasks:[],active:null,phases:[{name:"plan",subject:"Loop 2/3 · Plan",status:"in_progress"}]}));
      expect(visible(state.tasks).map(t=>t.id)).toContain(old.id);
      expect(f.commit(f.sid,undefined,[{action:"delete",params:{id:old.id}}]).error).toBeUndefined();
      state=f.apply(snapshot({seq:4,loop:2,tasks:[],active:null,phases:[{name:"plan",subject:"Loop 2/3 · Plan",status:"in_progress"}]}));
      expect(visible(state.tasks).some(t=>t.id===old.id)).toBe(false);
    } finally {f.close();}
  });

  test("loop-qualified row identity recreates unfinished same-ID work and steps after Q7 without re-deriving old tombstones as requests", () => {
    const f=fixture();
    try {
      f.apply(snapshot(),[worker()]);
      f.apply(snapshot({seq:2,outcome:"gaps",active:null}));
      const next=snapshot({seq:3,loop:2});
      const state=f.apply(next,[worker()]);
      const parent=state.tasks.find(t=>t.metadata?.key==="exec:run:task:2:t1")!;
      expect(parent.status).toBe("in_progress");
      expect(state.tasks.filter(t=>t.parentId===parent.id).map(t=>t.metadata?.key)).toEqual(["exec:run:step:2:t1:1:1","exec:run:step:2:t1:1:2"]);
      expect(deriveExecuteTodoRequests("run",next,state)).toEqual([]);
      expect(visible(state.tasks).some(t=>t.metadata?.key==="exec:run:summary:1")).toBe(true);
    } finally {f.close();}
  });

  test("main delete with worker children hides the whole family and derives a task request without interrupting or reviving steps", () => {
    const f=fixture();
    try {
      let state=f.apply(snapshot(),[worker()]);
      const parent=state.tasks.find(t=>t.metadata?.key==="exec:run:task:1:t1")!;
      expect(f.commit(f.sid,undefined,[{action:"delete",params:{id:parent.id}}]).error).toBeUndefined();
      state=f.apply(snapshot(),[worker()]);
      expect(state.tasks.filter(t=>t.id===parent.id||t.parentId===parent.id).every(t=>t.status==="deleted")).toBe(true);
      expect(deriveExecuteTodoRequests("run",snapshot(),state)).toMatchObject([{taskId:"t1",kind:"delete",origin:"model"}]);
    } finally {f.close();}
  });

  test("concurrent runs keep separate owners/keys; deletes derive the same idempotence key as cancel", () => {
    const f=fixture();
    try {
      f.apply(snapshot()); f.apply(snapshot({invocation:"other"}),[],"run2");
      let state=getState(f.sid);
      expect(state.tasks.filter(t=>t.status==="in_progress")).toHaveLength(2);
      const plan=state.tasks.find(t=>t.metadata?.key==="exec:run:task:1:t1")!;
      f.commit(f.sid,undefined,[{action:"cancel",params:{id:plan.id}}]);
      const cancel=deriveExecuteTodoRequests("run",snapshot(),getState(f.sid))[0];
      expect(f.commit(f.sid,undefined,[{action:"delete",params:{id:plan.id}}]).error).toBeUndefined();
      state=f.apply(snapshot());
      const deletion=deriveExecuteTodoRequests("run",snapshot(),state)[0];
      expect(deletion.requestId).toBe(cancel.requestId); expect(deletion.kind).toBe("delete");
      expect(state.tasks.find(t=>t.metadata?.key==="exec:run2:task:1:t1")?.status).toBe("in_progress");
    } finally {f.close();}
  });
});

// Controlled public RPC boundary: no dependency runtime, providers or UI needed.
function runtimeFixture() {
  const root=mkdtempSync(path.join(tmpdir(),"pitako-projection-runtime-"));
  const bus=new EventEmitter(), steers: unknown[]=[];
  const events = {
    emit:(name:string,data:unknown)=>{bus.emit(name,data);},
    on:(name:string,handler:(payload:any)=>void)=>{bus.on(name,handler);return ()=>{bus.off(name,handler);};},
  } as ExtensionAPI["events"];
  const {pi,captured}=createMockPi({events});
  const sid=randomUUID(), ctx=createMockCtx({sessionId:sid,hasUI:false});
  const foreground=path.join(root,"nested"); mkdirSync(foreground);
  Object.assign(ctx,{cwd:foreground});
  const main=path.join(root,"main"), child=path.join(root,"child"); mkdirSync(main);mkdirSync(child);
  const childSession=SessionManager.create(root,path.join(root,"sessions"));
  childSession.appendMessage({role:"user",content:"Worker task",timestamp:Date.now()});
  childSession.appendCustomEntry("pitako-todo-state",{version:1,tasks:worker().tasks,nextId:3});
  const writeMain=(s:ExecuteTodoSnapshot)=>writeFileSync(path.join(main,"status.json"),JSON.stringify({runId:"run",cwd:root,workflow:{emits:[s]},steps:[{runId:"child",workflowKey:"work.t1.a1",asyncDir:child}]}));
  const writeChild=(extra:Record<string,unknown>={})=>writeFileSync(path.join(child,"status.json"),JSON.stringify({runId:"child",parentWorkflowRunId:"run",workflowKey:"work.t1.a1",state:"running",steps:[{sessionFile:childSession.getSessionFile()}],...extra}));
  writeMain(snapshot());writeChild();
  const directories = new Map([["run",main],["child",child]]);
  function addRun(id: string, s: ExecuteTodoSnapshot, workflow: Record<string,unknown> = {}, top: Record<string,unknown> = {}) {
    const directory=path.join(root,id); mkdirSync(directory); directories.set(id,directory);
    writeFileSync(path.join(directory,"status.json"),JSON.stringify({runId:id,cwd:root,workflow:{emits:[s],...workflow},steps:[{runId:"child",workflowKey:"work.t1.a1",asyncDir:child}],...top}));
    return directory;
  }
  let snapshotRuns: unknown[]=[{id:"run"}];
  const statusIds: string[]=[];
  bus.on("subagents:rpc:v1:request",(request:any)=>{
    if(request.method==="steer") steers.push(request.params);
    if(request.method==="status" && request.params.id) statusIds.push(request.params.id);
    // pi-subagents answers unknown ids with this error after retention or for non-run ids.
    if(request.method==="status" && request.params.id && !directories.has(request.params.id))
      return events.emit(`subagents:rpc:v1:reply:${request.requestId}`,{version:1,requestId:request.requestId,success:false,
        error:{message:`Status target: run ${request.params.id} Spawn budget: unlimited Active async capacity: 0/unlimited used Async run not found. Provide id or dir.`}});
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`,{version:1,requestId:request.requestId,success:true,data:request.method==="steer" ? {ok:true,state:"delivered"} :
      request.params.id ? {details:{runId:request.params.id,asyncDir:directories.get(request.params.id)}} : {asyncSnapshot:{runs:snapshotRuns}}});
  });
  const commit=createTodoCommit(pi);
  registerExecuteTodoProjection(pi,commit);
  const fire=async (name:string,event:unknown={})=>{for(const handler of captured.events.get(name)??[]) await handler(event,ctx);};
  const warnings=():string[]=>(ctx.ui.notify as any).mock.calls.map((call:unknown[])=>String(call[0]));
  return {root,sid,ctx,pi,captured,commit,fire,steers,events,writeMain,writeChild,childSession,statusIds,warnings,
    addRun, setRuns:(runs:unknown[])=>{snapshotRuns=runs;},
    noSnapshot:()=>{snapshotRuns=[];},
    close:async()=>{await fire("session_shutdown"); evictSession(sid);
      try { expect(existsSync(path.join(foreground,".pi"))).toBe(false); }
      finally { rmSync(root,{recursive:true,force:true}); }}};
}

describe("execute todo registration and reconciliation",()=>{
  test("headless session-start reads public status and child session; duplicate/out-of-order hints do not write",async()=>{
    const f=runtimeFixture();
    try {
      f.noSnapshot(); await f.fire("session_start");
      expect(getState(f.sid).tasks).toHaveLength(0);
      await f.fire("message_end",{message:{customType:"subagent-notify",details:{runs:[{runId:"run"}]}}});
      expect(visible(getState(f.sid).tasks).filter(t=>t.parentId)).toHaveLength(2);
      const count=f.captured.entries.length;
      f.events.emit("subagent:child-status",{runId:"run"});
      f.events.emit("subagent:jobs-changed",{});
      await f.fire("tool_result",{toolName:"todo"});
      expect(f.captured.entries).toHaveLength(count);
      // Completion may clear active before a queued file-watch event is handled.
      f.childSession.appendCustomEntry("pitako-todo-state",{version:1,tasks:[{id:1,subject:"Edit",status:"completed"},{id:2,subject:"Test",status:"pending"}],nextId:3});
      f.writeMain(snapshot({seq:2,tasks:[{...snapshot().tasks[0],status:"completed"}],active:null}));
      await f.fire("tool_result",{toolName:"subagent"});
      expect(getState(f.sid).tasks.find(t=>t.metadata?.todoId===1)?.status).toBe("completed");
      expect(getState(f.sid).tasks.find(t=>t.metadata?.todoId===2)?.status).toBe("cancelled");
      const doneCount=f.captured.entries.length;
      f.writeMain(snapshot());
      await f.fire("tool_result",{toolName:"subagent"});
      expect(f.captured.entries).toHaveLength(doneCount);
      expect(getState(f.sid).tasks.find(t=>t.metadata?.key==="exec:run:task:1:t1")?.status).toBe("completed");
    } finally {await f.close();}
  });

  test("skipped loop outcome empties old workers before replacing parents and keeps concurrent reconciliation running",async()=>{
    const f=runtimeFixture();
    try {
      const other=snapshot({invocation:"other"});
      const otherDir=f.addRun("other",other);
      f.setRuns([{id:"run"},{id:"other"}]);
      await f.fire("session_start");
      const parent=getState(f.sid).tasks.find(t=>t.metadata?.key==="exec:run:task:1:t1")!;
      const steps=getState(f.sid).tasks.filter(t=>t.parentId===parent.id);
      expect(steps).toHaveLength(2);
      const before=f.captured.entries.length;
      // Only the latest snapshot survives: no loop-1 outcome is applied.
      f.writeMain(snapshot({seq:3,loop:2,
        phases:[{name:"plan",subject:"Loop 2/3 · Plan",status:"completed"}],
        tasks:[{id:"t1",subject:"Next loop",status:"in_progress",blockedBy:[]}]}));
      writeFileSync(path.join(otherDir,"status.json"),JSON.stringify({cwd:f.root,runId:"other",workflow:{emits:[{
        ...other,seq:2,tasks:[{...other.tasks[0],subject:"Concurrent update"}],
      }]}}));
      await f.fire("tool_result",{toolName:"subagent"});
      const entries=f.captured.entries.slice(before).map(e=>e.data as {tasks:Task[]});
      const cleared=entries.findIndex(e=>steps.every(step=>e.tasks.find(t=>t.id===step.id)?.status==="deleted"));
      const retired=entries.findIndex(e=>e.tasks.find(t=>t.id===parent.id)?.status==="deleted");
      expect(cleared).toBeGreaterThanOrEqual(0);
      expect(retired).toBeGreaterThan(cleared);
      expect(entries[cleared].tasks.find(t=>t.id===parent.id)?.status).toBe("in_progress");
      const current=visible(getState(f.sid).tasks);
      expect(current.filter(t=>t.owner==="execute:run").map(t=>t.subject)).toEqual(["Loop 2/3 · Plan","Next loop"]);
      const nextParent=current.find(t=>t.metadata?.key==="exec:run:task:2:t1")!;
      expect(nextParent.status).toBe("in_progress");
      expect(current.filter(t=>t.parentId===nextParent.id).map(t=>t.metadata?.key)).toEqual(["exec:run:step:2:t1:1:1","exec:run:step:2:t1:1:2"]);
      expect(current.filter(t=>t.owner==="worker:run:t1:1").map(t=>t.parentId)).toEqual([nextParent.id,nextParent.id]);
      expect(f.ctx.ui.notify).not.toHaveBeenCalled();
      expect(current.find(t=>t.metadata?.key==="exec:other:task:1:t1")?.subject).toBe("Concurrent update");
    } finally {await f.close();}
  });

  test("session-start discovers completed runs from persisted custom-message notifications without rows or async jobs",async()=>{
    const f=runtimeFixture();
    try {
      f.noSnapshot();
      const notes=SessionManager.inMemory(f.root);
      notes.appendCustomMessageEntry("subagent-notify","Done",false,{runs:[{runId:"run"}]});
      Object.assign(f.ctx.sessionManager,{getBranch:()=>notes.getBranch()});
      await f.fire("session_start");
      expect(visible(getState(f.sid).tasks).filter(t=>t.parentId)).toHaveLength(2);
    } finally {await f.close();}
  });

  test("worker binding is verified; main step cancel persists a single best-effort steer receipt",async()=>{
    const f=runtimeFixture();
    try {
      f.writeChild({parentWorkflowRunId:"foreign"});await f.fire("session_start");
      expect(getState(f.sid).tasks.filter(t=>t.parentId)).toHaveLength(0);
      f.writeChild(); await f.fire("tool_result",{toolName:"subagent"});
      const step=getState(f.sid).tasks.find(t=>t.parentId)!;
      expect(f.commit(f.sid,undefined,[{action:"cancel",params:{id:step.id}}]).error).toBeUndefined();
      await f.fire("tool_result",{toolName:"todo"});
      expect(f.steers).toMatchObject([{id:"child",mode:"steer"}]);
      const file=path.join(f.root,".pi/subagents/execute/invocation/step-receipts.jsonl");
      expect(JSON.parse(readFileSync(file,"utf8").trim())).toMatchObject({origin:"model",todoId:1,receipt:{ok:true,state:"delivered"}});
      await f.fire("tool_result",{toolName:"todo"});
      expect(f.steers).toHaveLength(1);
      expect(getState(f.sid).tasks.find(t=>t.id===step.id)?.status).toBe("cancelled");
    } finally {await f.close();}
  });

  test("file watch refreshes a live worker without a model turn and settles before cleanup",async()=>{
    const f=runtimeFixture(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await f.fire("session_start");
      let signal!:()=>void;
      const updated=new Promise<void>((resolve,reject)=>{signal=resolve; timer=setTimeout(()=>reject(new Error("No live worker file update")),1000);});
      const original=f.pi.appendEntry;
      f.pi.appendEntry=((type:string,data:any)=>{
        original(type,data);
        if(data.tasks?.some((t:Task)=>t.subject==="Testing live")) signal();
      }) as ExtensionAPI["appendEntry"];
      f.childSession.appendCustomEntry("pitako-todo-state",{version:1,tasks:[{id:1,subject:"Testing live",status:"in_progress"}],nextId:3});
      await updated;
      expect(visible(getState(f.sid).tasks).some(t=>t.subject==="Testing live")).toBe(true);
    } finally {clearTimeout(timer);await f.close();}
  });

  for (const link of ["reusedFrom","resumeOrigin"] as const) for (const middleHasSnapshot of [true,false]) test(`${link} retires predecessors transitively (middle snapshot: ${middleHasSnapshot}) after persisting requests; repeats and reload write nothing`,async()=>{
    const f=runtimeFixture();
    try {
      f.writeMain(snapshot({outcome:"gaps",active:null})); await f.fire("session_start");
      const s=snapshot({seq:2,loop:2,tasks:[...snapshot().tasks,{id:"t2",subject:"Follow up",status:"pending",blockedBy:["t1"]}]});
      f.writeMain(s); await f.fire("tool_result",{toolName:"subagent"});
      const history=getState(f.sid).tasks.find(t=>t.metadata?.summary)!;
      const rows=getState(f.sid).tasks;
      expect(f.commit(f.sid,undefined,[{action:"cancel",params:{id:rows.find(t=>t.metadata?.key==="exec:run:task:2:t1")!.id}}]).error).toBeUndefined();
      expect(f.commit(f.sid,undefined,[{action:"delete",params:{id:rows.find(t=>t.metadata?.key==="exec:run:task:2:t2")!.id}}]).error).toBeUndefined();
      const predecessor=(id:string)=>link==="reusedFrom"?{reusedFrom:id}:{resumeOrigin:{sourceRunId:id,attempt:1}};
      f.addRun("middle",s,{...predecessor("run"),...(!middleHasSnapshot ? {emits:[]} : {})});
      const finalDir=f.addRun("successor",s,predecessor("middle"));
      f.setRuns([{id:"successor"}]);
      const requests=path.join(f.root,".pi/subagents/execute/invocation/requests.jsonl");
      const append=f.pi.appendEntry;
      f.pi.appendEntry=((type:string,data:any)=>{
        if(data.tasks?.some((t:Task)=>t.owner==="execute:run" && t.metadata?.protected && t.status==="deleted"))
          expect(readFileSync(requests,"utf8").trim().split("\n").map(line=>JSON.parse(line).kind).sort()).toEqual(["cancel","delete"]);
        append(type,data);
      }) as ExtensionAPI["appendEntry"];
      await f.fire("session_start");
      const active=visible(getState(f.sid).tasks);
      const parent=active.find(t=>t.metadata?.key==="exec:successor:task:2:t1")!;
      expect(parent).toMatchObject({status:"in_progress",subject:"Build (cancelación pedida)"});
      expect(getState(f.sid).tasks.find(t=>t.metadata?.key==="exec:successor:task:2:t2")?.status).toBe("deleted");
      expect(active.some(t=>t.metadata?.taskId==="t2")).toBe(false);
      expect(active.filter(t=>t.metadata?.summary)).toEqual([history]);
      expect(active.filter(t=>!t.metadata?.summary).every(t=>t.owner==="execute:successor"||t.owner==="worker:successor:t1:1")).toBe(true);
      expect(active.filter(t=>t.parentId).map(t=>t.parentId)).toEqual([parent.id,parent.id]);
      // The original child is still running under run, not successor. Its file watch must survive.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const appendLive=f.pi.appendEntry;
      try {
        const updated=new Promise<void>((resolve,reject)=>{
          timer=setTimeout(()=>reject(new Error("Reused worker file watch did not refresh")),2000);
          f.pi.appendEntry=((type:string,data:any)=>{
            appendLive(type,data);
            if(data.tasks?.some((t:Task)=>t.owner==="worker:successor:t1:1" && t.subject==="Reused live" && t.parentId===parent.id)) resolve();
          }) as ExtensionAPI["appendEntry"];
        });
        f.childSession.appendCustomEntry("pitako-todo-state",{version:1,tasks:[{id:1,subject:"Reused live",status:"in_progress"},{id:2,subject:"Test",status:"pending"}],nextId:3});
        await updated;
        await f.fire("tool_result",{toolName:"todo"});
      } finally {clearTimeout(timer);f.pi.appendEntry=appendLive;}
      expect(visible(getState(f.sid).tasks).find(t=>t.subject==="Reused live")?.parentId).toBe(parent.id);
      const bytes=readFileSync(requests,"utf8"), count=f.captured.entries.length;
      f.setRuns([{id:"successor"},{id:"middle"},{id:"run"}]);
      f.events.emit("subagent:child-status",{runId:"run"});
      f.events.emit("subagent:jobs-changed",{runId:"middle"});
      await f.fire("tool_result",{toolName:"todo"});
      await f.fire("session_start");
      expect(f.captured.entries).toHaveLength(count);
      expect(readFileSync(requests,"utf8")).toBe(bytes);
      const settled={...s,seq:3,active:null,tasks:s.tasks.map(t=>({...t,status:"completed" as const}))};
      writeFileSync(path.join(finalDir,"status.json"),JSON.stringify({cwd:f.root,runId:"successor",workflow:{...predecessor("middle"),emits:[s,settled]},steps:[{runId:"child",workflowKey:"work.t1.a1"}]}));
      await f.fire("tool_result",{toolName:"subagent"});
      expect(getState(f.sid).tasks.find(t=>t.id===parent.id)).toMatchObject({status:"completed",subject:"Build"});
      expect(visible(getState(f.sid).tasks).some(t=>t.metadata?.taskId==="t2")).toBe(false);
      expect(visible(getState(f.sid).tasks).filter(t=>t.metadata?.summary)).toEqual([history]);
      writeFileSync(path.join(finalDir,"status.json"),JSON.stringify({cwd:f.root,runId:"successor",workflow:{...predecessor("middle"),emits:[{...settled,seq:4,outcome:"complete"}]}}));
      await f.fire("tool_result",{toolName:"subagent"});
      const summaries=visible(getState(f.sid).tasks);
      expect(summaries).toHaveLength(2);
      expect(summaries.filter(t=>t.metadata?.loop===1)).toEqual([history]);
      expect(summaries.filter(t=>t.metadata?.loop===2)).toMatchObject([{owner:"execute:successor",metadata:{summary:true},status:"completed"}]);
      const finalCount=f.captured.entries.length;
      await f.fire("session_start");
      expect(f.captured.entries).toHaveLength(finalCount);
      expect(readFileSync(requests,"utf8")).toBe(bytes);
    } finally {await f.close();}
  });

  for (const legacy of [false,true]) test(`retired predecessor requests stay unchanged when its successor is unreadable after reconnect (legacy: ${legacy})`,async()=>{
    const f=runtimeFixture();
    try {
      await f.fire("session_start");
      const successor=f.addRun("successor",snapshot(),{reusedFrom:"run"});
      f.setRuns([{id:"successor"}]);
      await f.fire("session_start");
      const retired=getState(f.sid).tasks.filter(t=>t.owner==="execute:run");
      expect(retired.length).toBeGreaterThan(0);
      expect(retired.every(t=>t.status==="deleted")).toBe(true);
      appendExecuteTodoRecords(f.root,"invocation","requests.jsonl",[{requestId:"existing",kind:"cancel",...{v:1,invocation:"invocation",taskId:"unrelated",origin:"model",at:"2026-11-03T00:00:00Z"}}]);
      const requests=path.join(f.root,".pi/subagents/execute/invocation/requests.jsonl");
      const bytes=readFileSync(requests,"utf8");
      // Legacy snapshots have no retirement journal yet.
      if (legacy) rmSync(path.join(f.root,".pi/subagents/execute/invocation/retired-runs.jsonl"),{force:true});
      // session_start clears cached lineage; only the predecessor's status remains readable.
      rmSync(path.join(successor,"status.json"));
      f.setRuns([{id:"run"}]);
      await f.fire("session_start");
      expect(readFileSync(requests,"utf8")).toBe(bytes);
      const retirement=path.join(f.root,".pi/subagents/execute/invocation/retired-runs.jsonl");
      const retirementBytes=readFileSync(retirement,"utf8");
      expect(retirementBytes.trim().split("\n").map(line=>JSON.parse(line))).toMatchObject([{v:1,invocation:"invocation",runId:"run"}]);
      // A previously unseen phase recreates a live row; a later refresh must still ignore retirement deletes.
      f.writeMain(snapshot({seq:2,phases:[...snapshot().phases,{name:"review",subject:"Review",status:"in_progress"}]}));
      await f.fire("tool_result",{toolName:"subagent"});
      await f.fire("tool_result",{toolName:"subagent"});
      expect(readFileSync(requests,"utf8")).toBe(bytes);
      // Real capacity pruning removes the old protected phase and task tombstones.
      const count=1000-visible(getState(f.sid).tasks).length;
      expect(f.commit(f.sid,"execute:pressure",[{action:"sync",owner:"execute:pressure",seq:1,rows:Array.from({length:count},(_,id)=>({key:`pressure:${id}`,subject:"Pressure",status:"completed" as const}))}]).error).toBeUndefined();
      expect(getState(f.sid).tasks.some(t=>retired.some(old=>old.id===t.id))).toBe(false);
      expect(f.commit(f.sid,"execute:pressure",[{action:"sync",owner:"execute:pressure",seq:2,rows:[]}]).error).toBeUndefined();
      await f.fire("session_start");
      await f.fire("tool_result",{toolName:"subagent"});
      expect(readFileSync(requests,"utf8")).toBe(bytes);
      expect(readFileSync(requests,"utf8").trim().split("\n").map(line=>JSON.parse(line)).some(record=>record.taskId==="t1")).toBe(false);
      expect(readFileSync(retirement,"utf8")).toBe(retirementBytes);
    } finally {await f.close();}
  });

  for (const cancelFirst of [false,true]) test(`linked resume with an initially empty plan never inherits retirement deletes (cancel first: ${cancelFirst})`,async()=>{
    const f=runtimeFixture();
    try {
      f.writeChild({parentWorkflowRunId:"foreign"});
      await f.fire("session_start");
      appendExecuteTodoRecords(f.root,"invocation","requests.jsonl",[{requestId:"existing",kind:"cancel",...{v:1,invocation:"invocation",taskId:"unrelated",origin:"model",at:"2026-11-03T00:00:00Z"}}]);
      const requests=path.join(f.root,".pi/subagents/execute/invocation/requests.jsonl");
      if (cancelFirst) {
        const task=getState(f.sid).tasks.find(t=>t.metadata?.key==="exec:run:task:1:t1")!;
        expect(f.commit(f.sid,undefined,[{action:"cancel",params:{id:task.id}}]).error).toBeUndefined();
        await f.fire("tool_result",{toolName:"todo"});
      }
      const requestBytes=readFileSync(requests,"utf8");
      const empty=snapshot({tasks:[],active:null});
      const successor=f.addRun("successor",empty,{reusedFrom:"run"});
      f.setRuns([{id:"successor"}]);
      await f.fire("session_start");
      expect(getState(f.sid).tasks.filter(t=>t.owner==="execute:run").every(t=>t.status==="deleted")).toBe(true);
      writeFileSync(path.join(successor,"status.json"),JSON.stringify({cwd:f.root,runId:"successor",workflow:{reusedFrom:"run",emits:[empty,snapshot({seq:2})]}}));
      await f.fire("tool_result",{toolName:"subagent"});
      await f.fire("tool_result",{toolName:"subagent"});
      await f.fire("session_start");
      expect(readFileSync(requests,"utf8")).toBe(requestBytes);
      expect(getState(f.sid).tasks.find(t=>t.metadata?.key==="exec:successor:task:1:t1")).toMatchObject({status:"in_progress",subject:cancelFirst ? "Build (cancelación pedida)" : "Build"});
    } finally {await f.close();}
  });

  for (const cancelFirst of [false,true]) test(`linked resume keeps deletion hidden after capacity pruning and reconnect (cancel first: ${cancelFirst})`,async()=>{
    const f=runtimeFixture();
    try {
      f.writeChild({parentWorkflowRunId:"foreign"});
      const s=snapshot({tasks:[...snapshot().tasks,{id:"t2",subject:"Hidden",status:"pending",blockedBy:[]}]});
      f.writeMain(s);
      expect(f.commit(f.sid,undefined,[{action:"create",params:{tasks:Array.from({length:996},()=>({subject:"Main"}))}}]).error).toBeUndefined();
      await f.fire("session_start");
      const deleted=getState(f.sid).tasks.find(t=>t.metadata?.taskId==="t2")!;
      if (cancelFirst) {
        expect(f.commit(f.sid,undefined,[{action:"cancel",params:{id:deleted.id}}]).error).toBeUndefined();
        await f.fire("tool_result",{toolName:"todo"});
      }
      expect(f.commit(f.sid,undefined,[{action:"delete",params:{id:deleted.id}}]).error).toBeUndefined();
      expect(f.commit(f.sid,"execute:old",[{action:"sync",owner:"execute:old",seq:1,rows:[{key:"old",subject:"Old",status:"deleted"}]}]).error).toBeUndefined();
      expect(getState(f.sid).tasks).toHaveLength(1000);
      f.addRun("successor",s,{reusedFrom:"run"});f.setRuns([{id:"successor"}]);
      await f.fire("session_start");
      expect(getState(f.sid).tasks.some(t=>t.metadata?.taskId==="t2")).toBe(false);
      expect(getState(f.sid).tasks).toHaveLength(1000);
      const transferred=f.captured.entries.length;
      await f.fire("tool_result",{toolName:"subagent"});
      await f.fire("session_start");
      expect(visible(getState(f.sid).tasks).some(t=>t.metadata?.taskId==="t2")).toBe(false);
      expect(f.captured.entries).toHaveLength(transferred);
      const requests=readFileSync(path.join(f.root,".pi/subagents/execute/invocation/requests.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
      expect(requests.map(r=>r.kind)).toEqual(cancelFirst ? ["cancel","delete"] : ["delete"]);
      expect(requests.at(-1)).toMatchObject({taskId:"t2",kind:"delete",origin:"model"});
      // Q8 remains sticky after the finished summary's tombstone is pruned too.
      const finished={...s,seq:2,active:null,outcome:"complete"};
      const successor=path.join(f.root,"successor","status.json");
      writeFileSync(successor,JSON.stringify({cwd:f.root,runId:"successor",workflow:{emits:[finished],reusedFrom:"run"}}));
      await f.fire("tool_result",{toolName:"subagent"});
      const summary=getState(f.sid).tasks.find(t=>t.owner==="execute:successor" && t.metadata?.summary && t.status!=="deleted")!;
      expect(summary).toMatchObject({status:"completed",metadata:{loop:1}});
      expect(f.commit(f.sid,undefined,[{action:"delete",params:{id:summary.id}}]).error).toBeUndefined();
      const directory=path.join(f.root,".pi/subagents/execute/invocation");
      const ledger=path.join(directory,"000000.json"); writeFileSync(ledger,"owned ledger sentinel");
      const requestBytes=readFileSync(path.join(directory,"requests.jsonl"),"utf8");
      await f.fire("tool_result",{toolName:"todo"});
      const guard=path.join(directory,"summary-deletions.jsonl"), guardBytes=readFileSync(guard,"utf8");
      expect(JSON.parse(guardBytes.trim())).toMatchObject({v:1,invocation:"invocation",runId:"successor",loop:1});
      // Other runs and loops still get their first summaries, even in the same invocation.
      f.addRun("other",snapshot({active:null,outcome:"complete"}));
      f.addRun("later",snapshot({loop:2,active:null,outcome:"complete"}));
      f.setRuns([{id:"successor"},{id:"later"},{id:"other"}]);
      await f.fire("tool_result",{toolName:"subagent"});
      const retained=visible(getState(f.sid).tasks).filter(t=>t.metadata?.summary);
      expect(retained.map(t=>t.owner).sort()).toEqual(["execute:later","execute:other"]);
      expect(f.commit(f.sid,"execute:pressure",[{action:"sync",owner:"execute:pressure",seq:1,rows:[1,2].map(id=>({key:`pressure:${id}`,subject:"Pressure",status:"completed" as const}))}]).error).toBeUndefined();
      expect(getState(f.sid).tasks).toHaveLength(1000);
      expect(getState(f.sid).tasks.some(t=>t.id===summary.id)).toBe(false);
      // Leave prunable capacity: a broken guard must be able to recreate the summary, not just hit the limit.
      expect(f.commit(f.sid,"execute:pressure",[{action:"sync",owner:"execute:pressure",seq:2,rows:[]}]).error).toBeUndefined();
      const count=f.captured.entries.length;
      await f.fire("tool_result",{toolName:"subagent"});
      await f.fire("session_start");
      expect(f.captured.entries).toHaveLength(count);
      expect(visible(getState(f.sid).tasks).filter(t=>t.metadata?.summary)).toEqual(retained);
      writeFileSync(path.join(f.root,"later","status.json"),JSON.stringify({cwd:f.root,runId:"later",workflow:{reusedFrom:"successor",emits:[snapshot({loop:2,active:null,outcome:"complete"})]}}));
      await f.fire("session_start");
      expect(f.captured.entries).toHaveLength(count);
      expect(visible(getState(f.sid).tasks).filter(t=>t.metadata?.summary)).toEqual(retained);
      expect(readFileSync(guard,"utf8")).toBe(guardBytes);
      const observed=JSON.parse(execFileSync("node",[path.resolve("skills/execute/observe.mjs"),"--requests"],{
        cwd:f.root,input:JSON.stringify({invocation:"invocation",cursor:0}),encoding:"utf8"}));
      expect(observed).toEqual({version:1,ok:true,invocation:"invocation",requests,next:null});
      expect(readFileSync(path.join(directory,"requests.jsonl"),"utf8")).toBe(requestBytes);
      expect(readFileSync(ledger,"utf8")).toBe("owned ledger sentinel");
    } finally {await f.close();}
  });

  for (const pressure of ["earlier run sync","todo during refresh"]) test(`records summary deletion before pruning by ${pressure}`,async()=>{
    const f=runtimeFixture();
    let off: (()=>void) | undefined, todoResult: Promise<void> | undefined;
    try {
      const finished=snapshot({active:null,outcome:"complete"});
      f.writeMain(finished);
      f.addRun("finished",finished);
      f.setRuns([{id:"run"},{id:"finished"}]);
      await f.fire("session_start");
      const summary=getState(f.sid).tasks.find(t=>t.owner==="execute:finished" && t.metadata?.summary)!;
      expect(f.commit(f.sid,"execute:reserve",[{action:"sync",owner:"execute:reserve",seq:1,rows:[{key:"reserve",subject:"Reserve",status:"deleted"}]}]).error).toBeUndefined();
      expect(f.commit(f.sid,undefined,[{action:"create",params:{tasks:Array.from({length:997},()=>({subject:"Main"}))}}]).error).toBeUndefined();
      expect(getState(f.sid).tasks).toHaveLength(1000);
      appendExecuteTodoRecords(f.root,"invocation","requests.jsonl",[{requestId:"existing",kind:"cancel",...{v:1,invocation:"invocation",taskId:"t1",origin:"model",at:"2026-11-03T00:00:00Z"}}]);
      const directory=path.join(f.root,".pi/subagents/execute/invocation");
      const requestFile=path.join(directory,"requests.jsonl"), requestBytes=readFileSync(requestFile,"utf8");
      const ledger=path.join(directory,"000000.json"); writeFileSync(ledger,"owned ledger sentinel");
      const observe=()=>execFileSync("node",[path.resolve("skills/execute/observe.mjs"),"--requests"],{
        cwd:f.root,input:JSON.stringify({invocation:"invocation",cursor:0}),encoding:"utf8"});
      const observerBytes=observe();
      if (pressure==="earlier run sync") {
        expect(f.commit(f.sid,undefined,[{action:"delete",params:{id:summary.id}}]).error).toBeUndefined();
        // The first run grows before the finished run gets its projection turn.
        f.writeMain({...finished,seq:2,loop:2});
      } else {
        // Delete after the reconcile pre-pass, while refresh is already running.
        off=f.events.on("subagents:rpc:v1:request",(request:any)=>{
          if (request.method!=="status" || request.params.id) return;
          off!(); off=undefined;
          expect(f.commit(f.sid,undefined,[{action:"delete",params:{id:summary.id}}]).error).toBeUndefined();
          todoResult=f.fire("tool_result",{toolName:"todo"});
          // No reconcile can run between this tool_result handler and the next commit.
          expect(f.commit(f.sid,undefined,[{action:"create",params:{subject:"Main pressure"}}]).error).toBeUndefined();
          expect(getState(f.sid).tasks.some(t=>t.id===summary.id)).toBe(false);
        });
      }
      await f.fire("tool_result",{toolName:"subagent"});
      await todoResult;
      expect(getState(f.sid).tasks.some(t=>t.id===summary.id)).toBe(false);
      expect(visible(getState(f.sid).tasks).some(t=>t.owner==="execute:finished")).toBe(false);
      const guard=path.join(directory,"summary-deletions.jsonl"), guardBytes=readFileSync(guard,"utf8");
      expect(JSON.parse(guardBytes.trim())).toMatchObject({v:1,invocation:"invocation",runId:"finished",loop:1});
      await f.fire("session_start");
      expect(visible(getState(f.sid).tasks).some(t=>t.owner==="execute:finished")).toBe(false);
      expect(readFileSync(guard,"utf8")).toBe(guardBytes);
      expect(readFileSync(requestFile,"utf8")).toBe(requestBytes);
      expect(observe()).toBe(observerBytes);
      expect(readFileSync(ledger,"utf8")).toBe("owned ledger sentinel");
    } finally {off?.(); await todoResult; await f.close();}
  });

  test("a relaunch of the same invocation supersedes the earlier run; linked runs of different invocations remain separate",async()=>{
    const f=runtimeFixture();
    try {
      const main=path.join(f.root,"main","status.json");
      writeFileSync(main,JSON.stringify({...JSON.parse(readFileSync(main,"utf8")),startedAt:1}));
      f.addRun("relaunch",snapshot({active:{taskId:"t1",attempt:2,workflowKey:"work.t1.a2"}}),{},{startedAt:2});
      f.addRun("different",snapshot({invocation:"other"}),{reusedFrom:"run"});
      f.setRuns([{id:"different"},{id:"relaunch"},{id:"run"}]);
      await f.fire("session_start");
      expect(visible(getState(f.sid).tasks).filter(t=>t.owner?.startsWith("execute:")&&t.status==="in_progress").map(t=>t.owner).sort()).toEqual(["execute:different","execute:relaunch"]);
      expect(visible(getState(f.sid).tasks).some(t=>t.owner==="execute:run"||t.owner?.startsWith("worker:run:"))).toBe(false);
      expect(readFileSync(path.join(f.root,".pi/subagents/execute/invocation/retired-runs.jsonl"),"utf8")).toContain('"runId":"run"');
      const count=f.captured.entries.length;
      await f.fire("session_start");expect(f.captured.entries).toHaveLength(count);
    } finally {await f.close();}
  });

  test("a halted run cancels its open rows with the reason, and its unblock relaunch neither inherits nor duplicates them",async()=>{
    const f=runtimeFixture();
    try {
      await f.fire("session_start");
      expect(visible(getState(f.sid).tasks).filter(t=>t.owner==="worker:run:t1:1")).toHaveLength(2);
      const main=path.join(f.root,"main","status.json");
      writeFileSync(main,JSON.stringify({...JSON.parse(readFileSync(main,"utf8")),state:"complete",startedAt:1,
        workflow:{emits:[snapshot()],value:{status:"blocked",reason:"Fallback lacks evidence."}}}));
      f.writeChild({state:"complete"});
      await f.fire("tool_result",{toolName:"subagent"});
      const halted=visible(getState(f.sid).tasks);
      expect(halted.find(t=>t.metadata?.key==="exec:run:task:1:t1")).toMatchObject({status:"cancelled",subject:"Build · blocked: Fallback lacks evidence."});
      expect(halted.filter(t=>t.owner==="worker:run:t1:1").map(t=>t.status)).toEqual(["cancelled","cancelled"]);
      expect(halted.some(t=>t.status==="in_progress")).toBe(false);
      f.addRun("relaunch",snapshot({active:{taskId:"t1",attempt:2,workflowKey:"work.t1.a2"}}),{},{startedAt:2});
      f.setRuns([{id:"relaunch"},{id:"run"}]);
      await f.fire("tool_result",{toolName:"subagent"});
      const rows=visible(getState(f.sid).tasks);
      expect(rows.map(t=>[t.owner,t.subject,t.status])).toEqual([
        ["execute:relaunch","Loop 1/3 · Plan","completed"],["execute:relaunch","Build","in_progress"]]);
      expect(existsSync(path.join(f.root,".pi/subagents/execute/invocation/requests.jsonl"))).toBe(false);
      const count=f.captured.entries.length;
      await f.fire("session_start");expect(f.captured.entries).toHaveLength(count);
      expect(f.warnings()).toEqual([]);
    } finally {await f.close();}
  });

  test("runs removed by retention or unknown to pi-subagents are silent, queried once, and orphan rows move to the live run",async()=>{
    const f=runtimeFixture();
    try {
      await f.fire("session_start");
      f.setRuns([{id:"run"},{id:"gone"},{id:"unavailable"},{id:"removed",asyncDir:path.join(f.root,"missing")}]);
      await f.fire("session_start");
      await f.fire("tool_result",{toolName:"todo"});
      await f.fire("tool_result",{toolName:"todo"});
      expect(f.warnings()).toEqual([]);
      expect(f.statusIds.filter(id=>id==="gone")).toHaveLength(1);
      // Live events are fresh evidence: the id is queried again.
      f.events.emit("subagent:async-started",{runId:"gone"});
      await f.fire("tool_result",{toolName:"todo"});
      expect(f.statusIds.filter(id=>id==="gone")).toHaveLength(2);
      // Retention removes the original run; its frozen rows move to the relaunch.
      rmSync(path.join(f.root,"main"),{recursive:true});
      f.addRun("relaunch",snapshot({active:{taskId:"t1",attempt:2,workflowKey:"work.t1.a2"}}));
      f.setRuns([{id:"relaunch"}]);
      await f.fire("session_start");
      expect(visible(getState(f.sid).tasks).map(t=>t.owner)).toEqual(["execute:relaunch","execute:relaunch"]);
      expect(readFileSync(path.join(f.root,".pi/subagents/execute/invocation/retired-runs.jsonl"),"utf8")).toContain('"runId":"run"');
      expect(f.warnings()).toEqual([]);
      // Real failures still warn.
      writeFileSync(path.join(f.root,"relaunch","status.json"),"{");
      await f.fire("tool_result",{toolName:"subagent"});
      expect(f.warnings().some(w=>w.startsWith("Execute todo: SyntaxError"))).toBe(true);
    } finally {await f.close();}
  });

  test("alias launch cwd sends model cancellation to the physical-root observer",async()=>{
    const f=runtimeFixture();
    try {
      await f.fire("session_start");
      const alias=path.join(f.root,"alias"); symlinkSync(f.root,alias,"dir");
      const statusFile=path.join(f.root,"main","status.json");
      const run=JSON.parse(readFileSync(statusFile,"utf8"));
      writeFileSync(statusFile,JSON.stringify({...run,cwd:alias}));
      await f.fire("session_start");
      const plan=getState(f.sid).tasks.find(t=>t.metadata?.key==="exec:run:task:1:t1")!;
      expect(plan).toBeDefined();
      expect(f.commit(f.sid,undefined,[{action:"cancel",params:{id:plan.id}}]).error).toBeUndefined();
      await f.fire("tool_result",{toolName:"todo"});
      const observed=JSON.parse(execFileSync("node",[path.resolve("skills/execute/observe.mjs"),"--requests"],{
        cwd:f.root,input:JSON.stringify({invocation:"invocation",cursor:0}),encoding:"utf8"}));
      expect(observed.requests).toMatchObject([{taskId:"t1",kind:"cancel",origin:"model"}]);
    } finally {await f.close();}
  });

  test("reconnect recovers run ids from main rows even when async snapshot is empty",async()=>{
    const f=runtimeFixture();
    try {
      await f.fire("session_start"); const before=f.captured.entries.length;
      f.noSnapshot(); await f.fire("session_start");
      expect(f.captured.entries).toHaveLength(before);
      const plan=getState(f.sid).tasks.find(t=>t.metadata?.key==="exec:run:task:1:t1")!;
      f.commit(f.sid,undefined,[{action:"cancel",params:{id:plan.id}}]);
      await f.fire("tool_result",{toolName:"todo"});
      const observed=JSON.parse(execFileSync("node",[path.resolve("skills/execute/observe.mjs"),"--requests"],{
        cwd:f.root,input:JSON.stringify({invocation:"invocation",cursor:0}),encoding:"utf8"}));
      expect(observed.requests).toMatchObject([{taskId:"t1",kind:"cancel",origin:"model"}]);
      expect(existsSync(path.join(f.ctx.cwd,".pi"))).toBe(false);
      f.writeMain(snapshot({seq:2,active:null,tasks:[{...snapshot().tasks[0],status:"completed"}]}));
      await f.fire("tool_result",{toolName:"todo"});
      const file=path.join(f.root,".pi/subagents/execute/invocation/requests.jsonl");
      const lines=readFileSync(file,"utf8").trim().split("\n");
      expect(lines).toHaveLength(1);expect(JSON.parse(lines[0])).toMatchObject({taskId:"t1",origin:"model"});
      await f.fire("session_start");expect(readFileSync(file,"utf8").trim().split("\n")).toHaveLength(1);
    } finally {await f.close();}
  });
});
