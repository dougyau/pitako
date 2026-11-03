import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, watch, writeSync, type FSWatcher } from "node:fs";
import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { replayFromBranch, type TodoCommit } from "../vendor/rpiv-todo/index.ts";
import { getState, getSyncSequences } from "../vendor/rpiv-todo/state/store.ts";
import type { TaskState } from "../vendor/rpiv-todo/state/state.ts";
import type { SyncRow, Task, TaskStatus } from "../vendor/rpiv-todo/tool/types.ts";

type DisplayRow = { subject: string; status: Exclude<TaskStatus, "deleted">; reason?: string };
export type ExecuteTodoSnapshot = {
  schema: "pitako.execute-todo"; v: 1; seq: number; invocation: string; loop: number; maxLoops: number;
  phases: (DisplayRow & { name: string })[];
  tasks: (DisplayRow & { id: string; blockedBy: string[] })[];
  active: { taskId: string; attempt: number; workflowKey: string } | null;
  outcome: string | null;
  /** Display-only: the run ended without emitting a closing snapshot. Never read from emits. */
  halted?: true;
};
export type WorkerTodoSnapshot = { taskId: string; attempt: number; tasks: readonly Task[] };
export type OwnerSnapshot = { owner: string; rows: SyncRow[] };
const terminal = (status: TaskStatus) => ["completed", "cancelled", "deleted"].includes(status);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 2000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const invocationId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..");
const planId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const displayRow = (value: unknown): value is DisplayRow & Record<string, any> => object(value) && text(value.subject) && ["pending","in_progress","completed","cancelled"].includes(value.status) && (value.reason === undefined || text(value.reason,240));

/** Ignore corrupt/unknown emits whole; never partially render a draft or truncated plan. */
export function latestExecuteTodoSnapshot(emits: unknown): ExecuteTodoSnapshot | undefined {
  if (!Array.isArray(emits)) return;
  let latest: ExecuteTodoSnapshot | undefined;
  for (const value of emits) {
    if (!object(value) || value.schema !== "pitako.execute-todo" || value.v !== 1 || !positive(value.seq) ||
        !invocationId(value.invocation) || !positive(value.loop) || !positive(value.maxLoops) || value.loop > value.maxLoops ||
        !Array.isArray(value.phases) || value.phases.length > 3 || !value.phases.every(p => displayRow(p) && object(p) && ["plan","review","compliance"].includes(p.name)) ||
        new Set(value.phases.map(p => p.name)).size !== value.phases.length ||
        !Array.isArray(value.tasks) || value.tasks.length > 1000 || !value.tasks.every(t => displayRow(t) && object(t) && planId(t.id) && Array.isArray(t.blockedBy) && t.blockedBy.every(planId)) ||
        new Set(value.tasks.map(t => t.id)).size !== value.tasks.length ||
        !(value.outcome === null || text(value.outcome,240)) ||
        !(value.active === null || object(value.active) && planId(value.active.taskId) && positive(value.active.attempt) && text(value.active.workflowKey,256) && value.tasks.some(t => t.id === value.active.taskId))) continue;
    if (!latest || value.seq > latest.seq) latest = value as ExecuteTodoSnapshot;
  }
  return latest;
}
/** A blocked or crashed root stops emitting; its last snapshot must not stay "in progress". */
export function haltedView(snapshot: ExecuteTodoSnapshot, run: {state?: unknown; error?: unknown; workflow?: {value?: any}}): ExecuteTodoSnapshot {
  if (snapshot.outcome || !terminalRun(String(run.state))) return snapshot;
  const value = run.workflow?.value;
  const cause = String((object(value) ? value.reason : undefined) ?? run.error ?? "ejecución terminada");
  const reason = `${object(value) && text(value.status,64) ? value.status : String(run.state)}: ${cause}`.replace(/\s+/g," ").slice(0,240);
  const stop = <T extends DisplayRow>(row: T): T => terminal(row.status) ? row
    : {...row,status:"cancelled",...(row.status === "in_progress" ? {reason} : {})};
  return {...snapshot,phases:snapshot.phases.map(stop),tasks:snapshot.tasks.map(stop),active:null,halted:true};
}
const taskKey = (runId: string, loop: number, taskId: string) => `exec:${runId}:task:${loop}:${taskId}`;
const subject = (row: DisplayRow) => `${row.subject}${row.reason ? ` · ${row.reason.replace(/\s+/g," ")}` : ""}`.slice(0,2000);
const workerOwner = (runId: string, taskId: string, attempt: number) => `worker:${runId}:${taskId}:${attempt}`;
const toRow = (task: Task): SyncRow => ({ key: String(task.metadata?.key), subject: task.subject, status: task.status,
  ...(task.activeForm ? {activeForm:task.activeForm} : {}), metadata:task.metadata });

/** Pure full-owner snapshots, ordered so no completed parent can expose active steps. */
export function projectExecuteTodos(runId: string, snapshot: ExecuteTodoSnapshot, workers: readonly WorkerTodoSnapshot[], state: TaskState, predecessors: readonly string[] = [], deletions: ReadonlySet<string> = new Set(), summaryDeleted = false): OwnerSnapshot[] {
  const owner = `execute:${runId}`, prefix = `exec:${runId}:`;
  const rows: SyncRow[] = state.tasks.filter(t => t.owner === owner && t.status !== "deleted" && t.metadata?.summary === true && t.metadata.loop !== snapshot.loop).map(toRow);
  const metadata = { invocation:snapshot.invocation, loop:snapshot.loop, ...(snapshot.halted ? {halted:true} : {}) };
  const lineage = [runId,...predecessors];
  // Retirement deletes are not display decisions; only durable deletes or pending requests carry over.
  const priorTask = (id: string) => lineage.map(run => state.tasks.find(t => t.owner === `execute:${run}` && t.metadata?.key === taskKey(run,snapshot.loop,id) && (run === runId || t.status !== "deleted" || deletions.has(id) || t.metadata?.cancelRequested))).find(Boolean);
  if (snapshot.outcome) {
    if (!summaryDeleted && !state.tasks.some(t => predecessors.includes(t.owner?.slice(8) ?? "") && t.owner?.startsWith("execute:") && t.metadata?.summary === true && t.metadata.loop === snapshot.loop)) rows.push({key:`${prefix}summary:${snapshot.loop}`, subject:`Loop ${snapshot.loop}/${snapshot.maxLoops} · ${snapshot.outcome} (${snapshot.tasks.filter(t => t.status === "completed").length} de ${snapshot.tasks.length})`.slice(0,2000),
      status:snapshot.outcome === "complete" ? "completed" : "cancelled", metadata:{...metadata,summary:true}});
  } else {
    rows.push(...snapshot.phases.map(p => ({key:`${prefix}phase:${snapshot.loop}:${p.name}`,subject:subject(p),status:p.status,metadata:{...metadata,protected:true}})));
    // A pruned tombstone must not allocate a fresh row on every hint.
    rows.push(...snapshot.tasks.filter(t => !deletions.has(t.id) || priorTask(t.id)).map(t => {
      const prior = priorTask(t.id);
      // A predecessor's halt is not a decision about the relaunched work.
      const inherited = prior && terminal(prior.status) && (prior.owner === owner || prior.status !== "deleted" && !(prior.status === "cancelled" && prior.metadata?.halted));
      const status = deletions.has(t.id) ? "deleted" : inherited ? prior.status : t.status;
      const marker = prior?.metadata?.cancelRequested && !terminal(status) ? " (cancelación pedida)" : "";
      return {key:taskKey(runId,snapshot.loop,t.id),subject:subject(t).slice(0,2000-marker.length)+marker,status,
        metadata:{...metadata,taskId:t.id,cancel:"request",...(prior?.metadata?.cancelRequested ? {cancelRequested:true,cancelledBy:prior.metadata.cancelledBy} : {}),
          ...(prior && (prior.metadata?.requestKey || prior.owner !== owner) ? {requestKey:prior.metadata?.requestKey ?? prior.metadata?.key} : {})}};
    }));
  }
  const before: OwnerSnapshot[] = [], after: OwnerSnapshot[] = [];
  const stepRows = (worker: WorkerTodoSnapshot, closing: boolean): SyncRow[] => worker.tasks.filter(t => t.owner === undefined).map(t => {
    const prior = lineage.map(run => state.tasks.find(row => row.metadata?.key === `exec:${run}:step:${snapshot.loop}:${worker.taskId}:${worker.attempt}:${t.id}`)).find(Boolean);
    return {
      key:`${prefix}step:${snapshot.loop}:${worker.taskId}:${worker.attempt}:${t.id}`,parentKey:taskKey(runId,snapshot.loop,worker.taskId),subject:t.subject,
      status:prior && terminal(prior.status) ? prior.status : closing && !terminal(t.status) ? "cancelled" : t.status,
      ...(t.activeForm ? {activeForm:t.activeForm} : {}),metadata:{...metadata,taskId:worker.taskId,todoId:t.id,attempt:worker.attempt},
    };
  });
  const owners = new Set([...state.tasks.filter(t => t.owner?.startsWith(`worker:${runId}:`)).map(t => t.owner!),
    ...workers.map(w => workerOwner(runId,w.taskId,w.attempt))]);
  for (const stepOwner of owners) {
    const worker = workers.find(w => workerOwner(runId,w.taskId,w.attempt) === stepOwner);
    const active = !snapshot.outcome && snapshot.active && stepOwner === workerOwner(runId,snapshot.active.taskId,snapshot.active.attempt) && snapshot.tasks.find(t => t.id === snapshot.active?.taskId)?.status === "in_progress" && !(priorTask(snapshot.active.taskId)?.owner === owner && priorTask(snapshot.active.taskId)?.status === "deleted") && !deletions.has(snapshot.active.taskId);
    const old = state.tasks.filter(t => t.owner === stepOwner && t.status !== "deleted");
    const staleLoop = old.some(t => t.metadata?.loop !== snapshot.loop);
    if (active && staleLoop) before.push({owner:stepOwner,rows:[]});
    if (active && !worker) {
      after.push({owner:stepOwner,rows:old.filter(t => t.metadata?.loop === snapshot.loop).map(t => ({...toRow(t),parentKey:taskKey(runId,snapshot.loop,snapshot.active!.taskId)}))});
      continue;
    }
    if (active && worker) {
      // A main-session terminal step is sticky even if the worker re-sends it.
      after.push({owner:stepOwner,rows:stepRows(worker,false)});
    } else {
      const parent = worker && priorTask(worker.taskId);
      before.push({owner:stepOwner,rows:snapshot.outcome || staleLoop || deletions.has(worker?.taskId ?? "") || parent?.owner === owner && parent.status === "deleted" ? [] : worker && parent ? stepRows(worker,true) : old.map(t => ({...toRow(t),parentKey:String(state.tasks.find(p => p.id === t.parentId)?.metadata?.key),status:terminal(t.status) ? t.status : "cancelled"}))});
    }
  }
  return [...before,{owner,rows},...after];
}

export type ExecuteTodoRequest = {v:1; requestId:string; invocation:string; taskId:string; kind:"cancel"|"delete"; origin:string; at:string};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function deriveExecuteTodoRequests(runId: string, snapshot: ExecuteTodoSnapshot, state: TaskState): ExecuteTodoRequest[] {
  if (snapshot.outcome) return [];
  return state.tasks.flatMap(task => {
    const taskId = task.metadata?.taskId;
    if (task.owner !== `execute:${runId}` || task.metadata?.loop !== snapshot.loop || !planId(taskId) || !snapshot.tasks.some(t => t.id === taskId) ||
        !(task.status === "deleted" || task.metadata?.cancelRequested)) return [];
    // A replacement display row must re-derive the original request, not append a new one.
    return [{v:1 as const,requestId:digest(`${snapshot.invocation}\0${task.metadata?.requestKey ?? task.metadata?.key}`),invocation:snapshot.invocation,taskId,
      kind:task.status === "deleted" ? "delete" as const : "cancel" as const,origin:"model",at:new Date().toISOString()}];
  });
}

// These append-only files are separate from the execute ledger and never alter its chain.
function requestDirectory(root: string, invocation: string) {
  if (!path.isAbsolute(root) || !invocationId(invocation)) throw new Error("Invalid execute todo request location");
  const directory = path.join(root,".pi/subagents/execute",invocation);
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current,part);
    if (!existsSync(current)) mkdirSync(current);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe execute todo request directory");
  }
  return directory;
}
export function appendExecuteTodoRecords(root: string, invocation: string, name: "requests.jsonl"|"step-receipts.jsonl"|"summary-deletions.jsonl"|"retired-runs.jsonl", records: readonly {requestId:string; kind?:string}[]) {
  if (!records.length) return;
  const file = path.join(requestDirectory(root,invocation),name);
  const fd = openSync(file,constants.O_CREAT|constants.O_APPEND|constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Execute todo records must be a regular file");
    const bytes = readFileSync(fd,"utf8");
    const existing = new Set(bytes.split("\n").filter(Boolean).map(line => {
      const row: unknown = JSON.parse(line);
      if (!object(row) || !text(row.requestId,256)) throw new Error("Invalid execute todo request record");
      return `${row.requestId}\0${row.kind === "delete" ? "delete" : ""}`;
    }));
    for (const record of records) {
      // Cancel and delete share execution identity, but delete also durably hides the row.
      const key = `${record.requestId}\0${record.kind === "delete" ? "delete" : ""}`;
      if (!existing.has(key)) { writeSync(fd,JSON.stringify(record)+"\n"); existing.add(key); }
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Retirement is display-only and must survive pruning and unreadable successor status. */
function readRetiredExecuteTodoRuns(root: string, invocation: string): Set<string> {
  const file = path.join(requestDirectory(root,invocation),"retired-runs.jsonl");
  const retired = new Set<string>();
  if (!existsSync(file)) return retired;
  const fd = openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Execute todo records must be a regular file");
    for (const line of readFileSync(fd,"utf8").split("\n").filter(Boolean)) {
      const row: unknown = JSON.parse(line);
      if (!object(row) || row.v !== 1 || row.invocation !== invocation || !text(row.runId,256) ||
          row.requestId !== digest(`${invocation}\0retired:${row.runId}`)) throw new Error("Invalid execute todo retirement record");
      retired.add(row.runId);
    }
  } finally { closeSync(fd); }
  return retired;
}

/** Read durable hiding decisions even after capacity pruning removes every display tombstone. */
function readExecuteTodoDeletions(root: string, snapshot: ExecuteTodoSnapshot, lineage: readonly string[], state: TaskState): Set<string> {
  const file = path.join(requestDirectory(root,snapshot.invocation),"requests.jsonl");
  const deleted = new Set<string>();
  if (!existsSync(file)) return deleted;
  const fd = openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Execute todo records must be a regular file");
    const keys = new Map(snapshot.tasks.map(task => [task.id,new Set([
      ...lineage.map(run => digest(`${snapshot.invocation}\0${taskKey(run,snapshot.loop,task.id)}`)),
      ...state.tasks.filter(t => lineage.some(run => t.owner === `execute:${run}`) && t.metadata?.loop === snapshot.loop && t.metadata?.taskId === task.id && text(t.metadata?.requestKey))
        .map(t => digest(`${snapshot.invocation}\0${t.metadata!.requestKey}`)),
    ])]));
    for (const line of readFileSync(fd,"utf8").split("\n").filter(Boolean)) {
      const row: unknown = JSON.parse(line);
      if (!object(row) || row.v !== 1 || row.invocation !== snapshot.invocation || !planId(row.taskId) ||
          !["cancel","delete"].includes(row.kind) || !text(row.requestId,256)) throw new Error("Invalid execute todo request record");
      if (row.kind === "delete" && keys.get(row.taskId)?.has(row.requestId)) deleted.add(row.taskId);
    }
  } finally { closeSync(fd); }
  return deleted;
}

/** Capture all runs before a growing commit can prune their deleted summaries. */
function recordDeletedExecuteTodoSummaries(root: string, state: TaskState, roots: ReadonlyMap<string,string>): void {
  for (const task of state.tasks) {
    if (!task.owner?.startsWith("execute:") || task.status !== "deleted" || task.metadata?.summary !== true ||
        !invocationId(task.metadata.invocation) || !positive(task.metadata.loop)) continue;
    const invocation = task.metadata.invocation, runId = task.owner.slice(8), loop = task.metadata.loop;
    appendExecuteTodoRecords(roots.get(invocation) ?? root,invocation,"summary-deletions.jsonl",[
      {requestId:digest(`${invocation}\0exec:${runId}:summary:${loop}`),...{v:1,invocation,runId,loop}},
    ]);
  }
}

/** Display-only records never enter the execution request observer's input. */
function deletedExecuteTodoSummary(root: string, snapshot: ExecuteTodoSnapshot, lineage: readonly string[]): boolean {
  const file = path.join(requestDirectory(root,snapshot.invocation),"summary-deletions.jsonl");
  if (!existsSync(file)) return false;
  const fd = openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Execute todo records must be a regular file");
    let deleted = false;
    for (const line of readFileSync(fd,"utf8").split("\n").filter(Boolean)) {
      const row: unknown = JSON.parse(line);
      if (!object(row) || row.v !== 1 || row.invocation !== snapshot.invocation || !text(row.runId,256) || !positive(row.loop) ||
          row.requestId !== digest(`${snapshot.invocation}\0exec:${row.runId}:summary:${row.loop}`)) throw new Error("Invalid execute todo summary deletion record");
      if (row.loop === snapshot.loop && lineage.includes(row.runId)) deleted = true;
    }
    return deleted;
  } finally { closeSync(fd); }
}

/** One registrar in the todo entry's module graph, usable in TUI, RPC and print. */
export function registerExecuteTodoProjection(pi: ExtensionAPI, commit: TodoCommit): void {
  let context: ExtensionContext | undefined, generation = 0;
  let running: Promise<void> | undefined, dirty = false;
  const known = new Map<string,string | undefined>();
  // Retention removes old runs and branch history names non-execute runs: absence is normal, not a warning.
  const absent = new Set<string>();
  const latest = new Map<string,ExecuteTodoSnapshot>();
  const invocationRoots = new Map<string,string>();
  const workerSnapshots = new Map<string,{loop:number; workers:Map<string,WorkerTodoSnapshot>}>();
  const watchers = new Map<string,FSWatcher>();
  const unsubscribe: (()=>void)[] = [];
  const pending = new Set<()=>void>();
  const warn = (error: unknown) => context?.ui.notify(`Execute todo: ${String(error)}`,"warning");
  function rpc(method: "status"|"steer", params: Record<string,unknown> = {}): Promise<any> {
    const requestId = randomUUID();
    return new Promise((resolve,reject) => {
      const cancel = () => finish(new Error("RPC unavailable or session closed"));
      const timer = setTimeout(cancel,2000);
      const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply: any) => {
        if (reply?.version !== 1 || reply.requestId !== requestId) return;
        finish(reply.success ? null : new Error(reply.error?.message ?? "status failed"),reply.data);
      });
      function finish(error: Error|null, data?: unknown) { clearTimeout(timer); off(); pending.delete(cancel); error ? reject(error) : resolve(data); }
      pending.add(cancel);
      pi.events.emit("subagents:rpc:v1:request",{version:1,requestId,method,params});
    });
  }
  // Live events are fresh evidence that a run exists again; branch history is not.
  function remember(value: any, fresh = false) {
    if (!object(value)) return;
    const id = value.runId ?? value.id;
    if (text(id,256)) {
      known.set(id,typeof value.asyncDir === "string" ? value.asyncDir : known.get(id));
      if (fresh) absent.delete(id);
    }
    for (const child of value.childRuns ?? []) remember(child,fresh);
  }
  async function status(runId: string) {
    if (absent.has(runId)) return;
    let directory = known.get(runId);
    if (!directory) {
      let response: any;
      try { response = await rpc("status",{id:runId}); }
      catch (error) {
        if (!/Async run not found/.test(String(error))) throw error;
        absent.add(runId); return;
      }
      remember(response?.details);
      directory = known.get(runId);
    }
    if (!directory) return;
    let bytes: string;
    try { bytes = readFileSync(path.join(directory,"status.json"),"utf8"); }
    catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      // A missing directory is retention; a missing file in a live directory may not be written yet.
      if (!existsSync(directory)) absent.add(runId);
      return;
    }
    const value = JSON.parse(bytes);
    if ((value.runId ?? value.id) !== runId) throw new Error("Execute todo status run mismatch");
    return value;
  }
  async function reconcile(epoch: number) {
    const ctx = context;
    if (!ctx) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const state = () => getState(sessionId);
    for (const row of state().tasks) if (row.owner?.startsWith("execute:")) remember({runId:row.owner.slice(8)});
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom_message" && entry.customType === "subagent-notify" && object(entry.details))
        for (const run of entry.details.runs ?? []) remember(run);
      if (entry.type !== "message") continue;
      const message = entry.message as any;
      if (message.customType === "subagent-notify") for (const run of message.details?.runs ?? []) remember(run);
      if (message.role === "toolResult" && message.toolName === "subagent") {
        remember(message.details);
        for (const run of message.details?.results ?? []) remember(run);
      }
    }
    try {
      const response = await rpc("status");
      for (const run of response?.asyncSnapshot?.runs ?? []) remember(run);
    } catch (error) { if (known.size) warn(error); }
    const files = new Set<string>();
    const runs = new Map<string,{run:any; prior:ExecuteTodoSnapshot|undefined}>();
    const predecessors = new Map<string,string[]>();
    // Load lineage before projecting: discovery order must not choose the active run.
    for (const runId of known.keys()) {
      if (epoch !== generation) return;
      try {
        const run = await status(runId);
        if (!run) continue;
        const links = [run.workflow?.reusedFrom,run.workflow?.resumeOrigin?.sourceRunId]
          .filter((id): id is string => text(id,256) && id !== runId);
        predecessors.set(runId,links);
        for (const predecessor of links) remember({runId:predecessor});
        const found = latestExecuteTodoSnapshot(run.workflow?.emits);
        if (!found) continue;
        if (typeof run.cwd === "string" && path.isAbsolute(run.cwd)) {
          let root = run.cwd;
          try { root = realpathSync(root); } catch { /* Retained history may refer to a removed worktree. */ }
          invocationRoots.set(found.invocation,root);
        }
        const prior = latest.get(runId);
        if (!prior || found.seq > prior.seq) latest.set(runId,found);
        runs.set(runId,{run,prior});
      } catch (error) { warn(error); }
    }
    if (epoch !== generation) return;
    // Unblock and budget relaunches are new top-level runs without native links. One invocation
    // has one live root, so the newest run of an invocation succeeds the earlier ones.
    const relaunches = new Map<string,string[]>();
    for (const [runId,{run}] of runs) {
      const invocation = latest.get(runId)!.invocation;
      if (!Number.isFinite(run.startedAt)) continue;
      relaunches.set(invocation,[...relaunches.get(invocation) ?? [],runId]);
    }
    for (const family of relaunches.values()) {
      family.sort((a,b) => runs.get(a)!.run.startedAt - runs.get(b)!.run.startedAt);
      for (let index = 1; index < family.length; index++) {
        const links = predecessors.get(family[index])!;
        if (!links.includes(family[index-1])) links.push(family[index-1]);
      }
    }
    // Rows of a run removed by retention stay frozen; the live run of their invocation adopts them.
    const orphans = new Map<string,string>();
    for (const row of state().tasks) {
      const runId = row.owner?.startsWith("execute:") ? row.owner.slice(8) : undefined;
      if (!runId || !absent.has(runId) || row.status === "deleted" || row.metadata?.summary === true || !invocationId(row.metadata?.invocation)) continue;
      const family = relaunches.get(row.metadata.invocation) ?? [...runs.keys()].filter(id => latest.get(id)?.invocation === row.metadata!.invocation);
      const successor = family.at(-1);
      if (!successor || orphans.has(runId)) continue;
      orphans.set(runId,row.metadata.invocation);
      predecessors.set(runId,[]);
      predecessors.get(successor)!.push(runId);
    }
    recordDeletedExecuteTodoSummaries(ctx.cwd,state(),invocationRoots);
    const rootFor = (invocation: string) => invocationRoots.get(invocation) ?? ctx.cwd;
    function lineage(runId: string, seen = new Set<string>(), invocation = latest.get(runId)?.invocation): string[] {
      seen.add(runId);
      for (const id of predecessors.get(runId) ?? []) {
        const snapshot = latest.get(id);
        // A snapshot-free relaunch bridges lineage, but cannot bridge different invocations.
        if (!seen.has(id) && predecessors.has(id) && (!snapshot || snapshot.invocation === invocation))
          lineage(id,seen,invocation);
      }
      return [...seen];
    }
    const superseded = new Set<string>();
    for (const runId of runs.keys()) for (const id of lineage(runId))
      if (id !== runId && runs.has(id)) superseded.add(id);
    function sync(projection: OwnerSnapshot) {
      const seq = (getSyncSequences(sessionId).get(projection.owner) ?? 0)+1;
      const result = commit(sessionId,projection.owner,[{action:"sync",owner:projection.owner,seq,rows:projection.rows}]);
      if (result.error) throw new Error(result.error);
    }
    const retirements = new Map<string,Set<string>>();
    function retiredRuns(invocation: string) {
      let retired = retirements.get(invocation);
      if (!retired) { retired = readRetiredExecuteTodoRuns(rootFor(invocation),invocation); retirements.set(invocation,retired); }
      return retired;
    }
    function retire(runId: string, invocation: string) {
      const retired = retiredRuns(invocation);
      if (retired.has(runId)) return;
      appendExecuteTodoRecords(rootFor(invocation),invocation,"retired-runs.jsonl",[
        {requestId:digest(`${invocation}\0retired:${runId}`),...{v:1,invocation,runId}},
      ]);
      retired.add(runId);
    }
    function canDeriveRequests(runId: string, snapshot: ExecuteTodoSnapshot) {
      if (retiredRuns(snapshot.invocation).has(runId)) return false;
      const rows = state().tasks.filter(t => t.owner === `execute:${runId}`);
      const active = rows.some(t => t.status !== "deleted" && t.metadata?.summary !== true);
      // Upgrade legacy retirement before projection can recreate a phase. Old-loop history is not retirement.
      if (!active && !snapshot.outcome && rows.some(t => t.status === "deleted" && t.metadata?.summary !== true && t.metadata?.loop === snapshot.loop)) retire(runId,snapshot.invocation);
      return active;
    }
    for (const runId of superseded) {
      if (epoch !== generation) return;
      try {
        const snapshot = latest.get(runId)!;
        if (canDeriveRequests(runId,snapshot))
          appendExecuteTodoRecords(rootFor(snapshot.invocation),snapshot.invocation,"requests.jsonl",deriveExecuteTodoRequests(runId,snapshot,state()));
      } catch (error) { warn(error); return; }
    }
    for (const [runId,{run,prior}] of runs) {
      if (epoch !== generation) return;
      if (superseded.has(runId)) continue;
      try {
        const snapshot = haltedView(latest.get(runId)!,run);
        let cache = workerSnapshots.get(runId);
        if (!cache || cache.loop !== snapshot.loop) {
          cache = {loop:snapshot.loop,workers:new Map()}; workerSnapshots.set(runId,cache);
        }
        const bindings = new Map<string,NonNullable<ExecuteTodoSnapshot["active"]>>();
        // Retain the last task/attempt mapping when the completing snapshot clears active.
        for (const emit of run.workflow?.emits ?? []) {
          const value = latestExecuteTodoSnapshot([emit]);
          if (value?.loop === snapshot.loop && value.seq <= snapshot.seq && value.active) bindings.set(value.active.taskId,value.active);
        }
        if (prior?.loop === snapshot.loop && prior.active) bindings.set(prior.active.taskId,prior.active);
        if (snapshot.active) bindings.set(snapshot.active.taskId,snapshot.active);
        const childIds = new Map<string,string>();
        if (!snapshot.outcome) for (const binding of bindings.values()) {
          const parent = state().tasks.find(t => t.metadata?.key === taskKey(runId,snapshot.loop,binding.taskId));
          if (snapshot.active?.taskId !== binding.taskId && parent?.status !== "in_progress") continue;
          for (const step of run.steps ?? []) {
            if (step.workflowKey !== binding.workflowKey || !text(step.runId,256)) continue;
            remember(step);
            let child: any;
            // One unreadable worker must not stop the other runs or retirement.
            try { child = await status(step.runId); } catch (error) { warn(error); continue; }
            if (!child || !lineage(runId).includes(child.parentWorkflowRunId) || child.workflowKey !== binding.workflowKey) continue;
            const file = child.steps?.[0]?.sessionFile;
            if (typeof file !== "string" || !existsSync(file)) continue;
            const owner = workerOwner(runId,binding.taskId,binding.attempt);
            childIds.set(owner,step.runId);
            const replay = replayFromBranch({sessionManager:SessionManager.open(file)});
            cache.workers.set(owner,{taskId:binding.taskId,attempt:binding.attempt,tasks:replay.tasks});
            if (snapshot.active?.workflowKey === binding.workflowKey && !terminalRun(child.state)) files.add(file);
          }
        }
        const workers = [...cache.workers.values()];
        if (epoch !== generation) return;
        if (canDeriveRequests(runId,snapshot))
          appendExecuteTodoRecords(rootFor(snapshot.invocation),snapshot.invocation,"requests.jsonl",deriveExecuteTodoRequests(runId,snapshot,state()));
        // Persist best-effort steer receipts; terminal main steps remain sticky regardless of delivery.
        for (const worker of workers) for (const step of worker.tasks) {
          if (snapshot.active?.taskId !== worker.taskId || snapshot.active.attempt !== worker.attempt) continue;
          const key = `exec:${runId}:step:${snapshot.loop}:${worker.taskId}:${worker.attempt}:${step.id}`;
          const main = state().tasks.find(t => t.metadata?.key === key);
          if (!main || !["cancelled","deleted"].includes(main.status) || terminal(step.status) || state().tasks.some(t => t.id === main.parentId && t.status === "deleted")) continue;
          const requestId = digest(`${key}\0${main.status}`);
          const receiptFile = path.join(requestDirectory(rootFor(snapshot.invocation),snapshot.invocation),"step-receipts.jsonl");
          if (existsSync(receiptFile) && readFileSync(receiptFile,"utf8").split("\n").filter(Boolean).some(line => JSON.parse(line).requestId === requestId)) continue;
          let receipt: unknown;
          try { receipt = await rpc("steer",{id:childIds.get(workerOwner(runId,worker.taskId,worker.attempt)),message:`Main-session model requested ${main.status === "deleted" ? "delete" : "cancel"} of todo step ${step.id}. Display only: this never drops required work or checks.`,mode:"steer"}); }
          catch (error) { receipt = {state:"failed",reason:String(error).slice(0,240)}; }
          if (epoch !== generation) return;
          appendExecuteTodoRecords(rootFor(snapshot.invocation),snapshot.invocation,"step-receipts.jsonl",[{requestId, ...{v:1,origin:"model",taskId:worker.taskId,todoId:step.id,receipt}}]);
        }
        if (epoch !== generation) return;
        const family = lineage(runId);
        const deletions = readExecuteTodoDeletions(rootFor(snapshot.invocation),snapshot,family,state());
        const summaryDeleted = deletedExecuteTodoSummary(rootFor(snapshot.invocation),snapshot,family);
        for (const projection of projectExecuteTodos(runId,snapshot,workers,state(),family.filter(id => id !== runId),deletions,summaryDeleted)) sync(projection);
      } catch (error) { warn(error); return; }
    }
    // Retire only after successor display decisions have been durably carried over.
    for (const [runId,invocation] of [...[...superseded].map(id => [id,latest.get(id)!.invocation] as const),...orphans]) {
      if (epoch !== generation) return;
      try {
        retire(runId,invocation);
        const owners = new Set(state().tasks.filter(t => t.owner?.startsWith(`worker:${runId}:`)).map(t => t.owner!));
        for (const owner of owners) sync({owner,rows:[]});
        const family = [...runs.keys()].filter(id => lineage(id).includes(runId)).flatMap(id => lineage(id));
        const summaries = state().tasks.filter(t => family.includes(t.owner?.slice(8) ?? "") && t.owner?.startsWith("execute:") && t.metadata?.summary === true);
        sync({owner:`execute:${runId}`,rows:summaries.filter(t => t.owner === `execute:${runId}` && summaries.find(p => p.metadata?.loop === t.metadata?.loop)?.id === t.id).map(toRow)});
      } catch (error) { warn(error); return; }
    }
    if (epoch !== generation) return;
    for (const [file,watcher] of watchers) if (!files.has(file)) { watcher.close(); watchers.delete(file); }
    for (const file of files) if (!watchers.has(file)) {
      const watcher = watch(file,() => { void refresh(); });
      watcher.on("error",warn); watchers.set(file,watcher);
    }
  }
  function refresh(): Promise<void> {
    dirty = true;
    if (!running) {
      const epoch = generation;
      running = (async () => { while (dirty && context && epoch === generation) { dirty = false; await reconcile(epoch); } })()
        .catch(warn).finally(() => { running = undefined; });
    }
    return running;
  }
  async function stop() {
    if (context) {
      try { recordDeletedExecuteTodoSummaries(context.cwd,getState(context.sessionManager.getSessionId()),invocationRoots); }
      catch (error) { warn(error); }
    }
    context = undefined; generation++; dirty = false;
    for (const watcher of watchers.values()) watcher.close(); watchers.clear();
    for (const cancel of pending) cancel();
    await running; known.clear(); absent.clear(); latest.clear(); workerSnapshots.clear(); invocationRoots.clear();
  }
  pi.on("session_start",async (_event,ctx) => { await stop(); context=ctx; await refresh(); });
  pi.on("session_shutdown",async () => { await stop(); for (const off of unsubscribe) off(); });
  pi.on("session_tree",async (_event,ctx) => { context=ctx; await refresh(); });
  pi.on("session_compact",async (_event,ctx) => { context=ctx; await refresh(); });
  pi.on("tool_result",async (event) => {
    if (event.toolName === "todo" && context) {
      try { recordDeletedExecuteTodoSummaries(context.cwd,getState(context.sessionManager.getSessionId()),invocationRoots); }
      catch (error) { warn(error); return; }
    }
    if (event.toolName === "subagent" && object(event.details)) { remember(event.details,true); if (Array.isArray(event.details.results)) for (const run of event.details.results) remember(run,true); }
    if (event.toolName === "todo" || event.toolName === "subagent") await refresh();
  });
  pi.on("message_end",async (event) => {
    const message = event.message as any;
    if (message.customType === "subagent-notify") { for (const run of message.details?.runs ?? []) remember(run,true); await refresh(); }
  });
  for (const event of ["subagent:child-status","subagent:jobs-changed","subagent:async-started","subagent:async-complete","subagents:rpc:v1:ready"]) {
    unsubscribe.push(pi.events.on(event,payload => { remember(payload,true); void refresh(); }));
  }
}
function terminalRun(state: string) { return ["complete","completed","failed","stopped"].includes(state); }
