import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { checkoutEvidence } from "../../extensions/spec-plans.ts";
import { repositoryIdentity } from "../../extensions/board/workspace.ts";
import { openBoard, type Board, type Post } from "../../extensions/board/store.ts";

const require = createRequire(import.meta.url);
const { canonicalDigest } = require("../../extensions/canonical.mjs") as { canonicalDigest(value: unknown): string };
const { safePath } = require("../../extensions/hash-ledger.mjs") as { safePath(file: string): string };

export type Command = { id: string; command: string; cwd: string; timeoutMs: number; verifies?: number[] };
export type Metric = { command: string; unit: string; target: number };
export type Sample = { value: number | null; best: number | null; fingerprint: string; gatesPassed: number; gatesTotal: number };
export type Progress = { nonImproving: number; last5: Sample[] };
export type Task = {
  id: string; goal: string; expectedResult: string; status: "pending" | "done" | "obsolete" | "blocked";
  origin: { kind: "spec" | "director" | "final-phase" | "human"; ref: string };
  specRefs: string[]; dependsOn: string[]; gates: Command[]; metric: Metric | null; parent: string | null;
  remaining: string; progress: Progress;
  history: { invocation: string; loop: number; event: string; reason: string }[];
};
export type Authority = { specDigest: string; amendmentDigests: string[] };
export type AcceptanceHistory = { invocation: string; loop: number; kind: "init" | "replace" | "human"; reason: string; digest: string };
export type Backlog = { version: 1; acceptanceHistory: AcceptanceHistory[]; specId: string; authority: Authority;
  acceptance: Omit<Command, "timeoutMs">[]; lastApplied: { key: string; requestDigest: string; contentDigest: string } | null; tasks: Task[] };
export type Change = { kind: "add"; task: Task; reason: string } |
  { kind: "split"; id: string; tasks: Task[]; reason: string } |
  { kind: "obsolete"; id: string; reason: string } |
  { kind: "update"; id: string; patch: Partial<Pick<Task, "goal" | "expectedResult" | "specRefs" | "dependsOn" | "gates" | "metric" | "remaining">>; reason: string };
export type Selection = { select: string | null; changes: Change[]; reason: string; acceptance?: Backlog["acceptance"] };
export type BoardView = { topicId: number; authority: string; posts: Pick<Post, "id" | "type" | "content" | "metadata">[]; omitted: number };
export type GateResult = { id: string; status: "pass" | "fail" | "timeout" | "error"; exit: number | null; ms: number; tail: string; logRef: string };
export type GateReceipt = { before: Pick<ReturnType<typeof checkoutEvidence>, "head" | "fingerprint">; after: Pick<ReturnType<typeof checkoutEvidence>, "head" | "fingerprint">;
  mutated: boolean; gates: GateResult[]; metric: { value: number | null; error: string | null } | null;
  progress: Progress; stalled: boolean; view: BoardView };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !value.includes("\0");
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function key(value: unknown): asserts value is string { assert(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes(".."), "Invalid loop key"); }
function command(value: unknown, timed: boolean) {
  assert(record(value) && text(value.id) && text(value.command) && text(value.cwd) && (!timed || Number.isSafeInteger(value.timeoutMs) && Number(value.timeoutMs) > 0 && Number(value.timeoutMs) <= 2147483647), "Invalid gate command");
  assert(value.verifies === undefined || Array.isArray(value.verifies) && value.verifies.every(n => Number.isSafeInteger(n) && Number(n) > 0), "Invalid gate verifies: expected positive criterion integers");
}
function authority(value: unknown) {
  assert(record(value) && digest(value.specDigest) && Array.isArray(value.amendmentDigests) && value.amendmentDigests.every(digest), "Invalid backlog authority");
}
export function validateBacklog(value: unknown): asserts value is Backlog {
  assert(record(value) && value.version === 1, "Expected backlog version 1"); key(value.specId); authority(value.authority);
  assert(value.lastApplied === null || record(value.lastApplied) && text(value.lastApplied.key) && digest(value.lastApplied.requestDigest) && digest(value.lastApplied.contentDigest), "Invalid lastApplied");
  assert(Array.isArray(value.acceptance), "Invalid acceptance commands"); value.acceptance.forEach(c => command(c, false));
  assert(Array.isArray(value.acceptanceHistory) && value.acceptanceHistory.length <= 8, "Invalid acceptanceHistory");
  for (const entry of value.acceptanceHistory) assert(record(entry) && text(entry.invocation) && Number.isSafeInteger(entry.loop) && Number(entry.loop) >= 1 &&
    ["init", "replace", "human"].includes(String(entry.kind)) && text(entry.reason) && digest(entry.digest), "Invalid acceptance history entry");
  assert(Array.isArray(value.tasks), "Invalid tasks");
  const ids = new Set<string>();
  for (const task of value.tasks) {
    assert(record(task), "Invalid task"); key(task.id); assert(!ids.has(task.id), `Duplicate task ID ${task.id}`); ids.add(task.id);
    assert(text(task.goal) && text(task.expectedResult) && ["pending", "done", "obsolete", "blocked"].includes(String(task.status)), `Invalid task ${task.id}`);
    assert(record(task.origin) && ["spec", "director", "final-phase", "human"].includes(String(task.origin.kind)) && text(task.origin.ref), `Invalid origin for ${task.id}`);
    assert(strings(task.specRefs) && strings(task.dependsOn), `Invalid references for ${task.id}`);
    assert(Array.isArray(task.gates), `Invalid gates for ${task.id}`); task.gates.forEach(c => command(c, true));
    assert(new Set(task.gates.map(c => c.id)).size === task.gates.length, `Duplicate gates for ${task.id}`);
    assert(task.metric === null || record(task.metric) && text(task.metric.command) && text(task.metric.unit) && typeof task.metric.target === "number" && Number.isFinite(task.metric.target), `Invalid metric for ${task.id}`);
    assert(task.parent === null || text(task.parent), `Invalid parent for ${task.id}`);
    assert(typeof task.remaining === "string" && Buffer.byteLength(task.remaining) <= 1024, `Invalid remaining for ${task.id}`);
    const p = task.progress;
    assert(record(p) && Number.isSafeInteger(p.nonImproving) && Number(p.nonImproving) >= 0 && Array.isArray(p.last5) && p.last5.length <= 5, `Invalid progress for ${task.id}`);
    for (const s of p.last5) assert(record(s) && (s.value === null || typeof s.value === "number" && Number.isFinite(s.value)) &&
      (s.best === null || typeof s.best === "number" && Number.isFinite(s.best)) && digest(s.fingerprint) &&
      Number.isSafeInteger(s.gatesPassed) && Number(s.gatesPassed) >= 0 && Number.isSafeInteger(s.gatesTotal) && Number(s.gatesTotal) >= Number(s.gatesPassed), `Invalid sample for ${task.id}`);
    assert(Array.isArray(task.history) && task.history.length <= 8, `Invalid history for ${task.id}`);
    for (const h of task.history) assert(record(h) && text(h.invocation) && Number.isSafeInteger(h.loop) && Number(h.loop) >= 1 && text(h.event) && text(h.reason), `Invalid history entry for ${task.id}`);
  }
  for (const task of value.tasks as Task[]) {
    for (const entry of task.history.filter(h => ["cancel", "late-cancel"].includes(h.event))) {
      let cancel: unknown; try { cancel = JSON.parse(entry.reason); } catch { throw new Error(`Invalid cancellation history for ${task.id}`); }
      assert(record(cancel) && cancel.taskId === task.id && text(cancel.requestId) && text(cancel.origin) &&
        ["cancel", "delete"].includes(String(cancel.kind)) && text(cancel.reason), `Invalid cancellation history for ${task.id}`);
    }
    assert(task.dependsOn.every(id => ids.has(id) && id !== task.id), `Unknown/self dependency for ${task.id}`);
    assert(task.parent === null || ids.has(task.parent) && task.parent !== task.id, `Unknown/self parent for ${task.id}`);
  }
}
export function backlogPath(root: string, specId: string) { key(specId); return safePath(path.join(root, ".pitako/backlog", `${specId}.json`)); }
export function readBacklog(root: string, specId: string) {
  const file = backlogPath(root, specId);
  try {
    const raw = readFileSync(file, "utf8"), backlog: unknown = JSON.parse(raw);
    validateBacklog(backlog); assert(backlog.specId === specId, "specId mismatch");
    return { path: file, digest: hash(raw), backlog };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, digest: null, backlog: null };
    throw new Error(`${file}: ${error instanceof Error ? error.message : error}`);
  }
}
export function topicOwner(root: string, specId: string) { key(specId); return `execute:${specId}:${hash(realpathSync(root)).slice(0, 16)}`; }
const AUTHORITY = "spec and frozen amendments > DECISION > FINDING > HANDOFF; code wins over any map";
export function boardView(board: Board, workspace: string, topicId: number, taskId?: string, maxBytes = 12 * 1024): BoardView {
  const posts: Post[] = [];
  let beforePostId: number | undefined;
  do {
    const page = board.readTopic(workspace, topicId, { limit: 100, ...(beforePostId ? { beforePostId } : {}) });
    posts.push(...page.posts); if (!page.hasOlder) break;
    beforePostId = page.posts[0]!.id;
  } while (true);
  posts.sort((a, b) => b.id - a.id);
  const superseded = new Set<number>();
  for (const p of posts) {
    const refs = Array.isArray(p.metadata?.supersedes) ? p.metadata.supersedes : [p.metadata?.supersedes];
    for (const ref of refs) if (posts.some(old => old.id === ref && old.id < p.id && old.type === p.type)) superseded.add(ref as number);
  }
  const relevant = posts.filter(p => !superseded.has(p.id) && (p.type === "DECISION" || p.type === "FINDING" && (!taskId || !p.metadata?.taskId || p.metadata.taskId === taskId) || p.type === "HANDOFF" && taskId && p.metadata?.taskId === taskId));
  const project = (p: Post) => ({ id: p.id, type: p.type, content: p.content, metadata: p.metadata });
  const decisions = relevant.filter(p => p.type === "DECISION").map(project);
  assert(bytes(decisions) <= 8192, "DECISION overflow: ask the human to consolidate current Board decisions");
  const view: BoardView = { topicId, authority: AUTHORITY, posts: [...decisions], omitted: relevant.length - decisions.length };
  assert(bytes(view) <= maxBytes, "DECISION overflow: Board view cannot retain binding rules; human consolidation required");
  for (const p of relevant.filter(p => p.type !== "DECISION")) {
    const entry = project(p); view.posts.push(entry); view.omitted--;
    if (bytes(view) > maxBytes) { view.posts.pop(); view.omitted++; }
  }
  view.posts.sort((a, b) => b.id - a.id);
  return view;
}
async function withBoard<T>(root: string, specId: string, dbPath: string | undefined, run: (board: Board, workspace: string, topicId: number) => T | Promise<T>): Promise<T> {
  const board = await openBoard(dbPath);
  try {
    const workspace = repositoryIdentity(root);
    const topic = board.ensureOwnedTopic(workspace, topicOwner(root, specId), { title: `Execute ${specId}` });
    return await run(board, workspace, topic.id);
  } finally { board.close(); }
}
export async function prepare(input: { root: string; specId: string; previousConfirmedUnit: string | null; dbPath?: string; taskId?: string; invocation?: string; loop?: number }) {
  let state = readBacklog(input.root, input.specId);
  if (state.backlog && auditHumanAcceptance(state.backlog, input.invocation ?? "prepare", input.loop ?? 1)) {
    const written = writeBacklog(input.root, state, state.backlog);
    state = { ...state, ...written };
  }
  const lastConfirmedUnit = state.backlog?.tasks.some(t => t.id === input.previousConfirmedUnit && t.status === "done") ? input.previousConfirmedUnit : null;
  return withBoard(input.root, input.specId, input.dbPath, (board, workspace, topicId) => ({ ...state,
    cancelledScope: state.backlog ? cancelledScope(state.backlog) : [],
    view: boardView(board, workspace, topicId, input.taskId), lastConfirmedUnit }));
}
function selectTask(backlog: Backlog, selected: string | null) {
  if (selected === null) { assert(!backlog.tasks.some(t => t.status === "pending" || t.status === "blocked"), "Invalid final selection: unfinished tasks remain"); assert(backlog.acceptance.length > 0, "Final phase requires non-empty acceptance commands"); return null; }
  const task = backlog.tasks.find(t => t.id === selected);
  assert(task && task.status === "pending", "Selected task must be pending");
  assert(task.gates.length > 0, "Selected task must have focused gates");
  assert(task.dependsOn.every(id => backlog.tasks.find(t => t.id === id)?.status === "done"), "Selected task has unfinished dependencies");
  return task;
}
export function apply(input: { root: string; specId: string; expectedDigest: string | null; key: string; invocation: string; loop: number;
  authority: Authority; acceptance?: Backlog["acceptance"]; director: Selection; settle?: boolean; recordGaps?: boolean; cancellations?: Cancellation[];
  confirmedUnit?: { taskId: string; kind: "unit"; workerStatus: "complete"; receipt: GateReceipt }; progress?: { taskId: string; progress: Progress; remaining: string } }) {
  key(input.key); key(input.invocation); authority(input.authority);
  assert(Number.isSafeInteger(input.loop) && input.loop >= 1, "Invalid loop number");
  if (input.settle) assert((input.confirmedUnit || input.progress) && input.director.select === null && input.director.changes.length === 0, "Settlement requires workflow progress or a confirmed unit, without director changes");
  const current = readBacklog(input.root, input.specId);
  const requestDigest = canonicalDigest(JSON.parse(JSON.stringify(input)));
  // Replay may bypass the old CAS only for the same request and unchanged applied content.
  if (current.backlog?.lastApplied?.key === input.key) {
    assert(current.backlog.lastApplied.requestDigest === requestDigest &&
      current.backlog.lastApplied.contentDigest === canonicalDigest({ ...current.backlog, lastApplied: null }), `backlog-conflict: ${current.path} (replay differs)`);
    return { ...current, completedTasks: completedTasks(current.backlog), cancelledScope: cancelledScope(current.backlog), selected: input.settle || input.recordGaps || input.cancellations ? null : selectTask(current.backlog, input.director.select), replay: true };
  }
  assert(current.digest === input.expectedDigest, `backlog-conflict: ${current.path}`);
  const backlog: Backlog = structuredClone(current.backlog ?? { version: 1, specId: input.specId, authority: input.authority, acceptance: [], acceptanceHistory: [], lastApplied: null, tasks: [] });
  const history = (task: Task, event: string, reason: string) => { task.history = [...task.history, { invocation: input.invocation, loop: input.loop, event, reason }].slice(-8); };
  if (input.confirmedUnit) {
    const unit = input.confirmedUnit, task = backlog.tasks.find(t => t.id === unit.taskId);
    assert(unit.kind === "unit" && unit.workerStatus === "complete" && task?.status === "pending" && !unit.receipt.mutated && unit.receipt.gates.length === task.gates.length && task.gates.every(g => unit.receipt.gates.some(r => r.id === g.id && r.status === "pass")), "Done requires workflow-confirmed unit backed by passing focused gates");
    task.status = "done"; history(task, "unit", "Workflow-confirmed gated unit");
  }
  if (input.progress) {
    const task = backlog.tasks.find(t => t.id === input.progress!.taskId); assert(task, "Unknown progress task");
    task.progress = input.progress.progress; task.remaining = input.progress.remaining;
  }
  let selected: Task | null;
  try {
    assert(text(input.director.reason) && Array.isArray(input.director.changes), "Director changes and reason required");
    if (JSON.stringify(backlog.authority) !== JSON.stringify(input.authority)) assert(input.director.changes.length > 0, "Authority changed: director must reconcile with reasons");
    if (current.backlog) auditHumanAcceptance(backlog, input.invocation, input.loop);
    const acceptance = input.director.acceptance ?? input.acceptance;
    if (!current.backlog || acceptance !== undefined) {
      assert(Array.isArray(acceptance) && acceptance.length > 0, "Backlog initialization/replacement requires valid non-empty acceptance commands from the director");
      acceptance.forEach(c => command(c, false));
      assert(new Set(acceptance.map(c => c.id)).size === acceptance.length, "Duplicate acceptance command IDs");
      assert(text(input.director.reason), "Acceptance replacement requires a reason");
      if (!current.backlog || canonicalDigest(acceptance) !== canonicalDigest(backlog.acceptance)) {
        backlog.acceptance = structuredClone(acceptance);
        backlog.acceptanceHistory = [...backlog.acceptanceHistory, { invocation: input.invocation, loop: input.loop,
          kind: current.backlog ? "replace" as const : "init" as const, reason: input.director.reason, digest: canonicalDigest(acceptance) }].slice(-8);
      }
    }
    if (input.recordGaps) {
      assert(!input.settle && input.director.select === null && !backlog.tasks.some(t => ["pending", "blocked"].includes(t.status)), "Final-phase gaps require a finished implementation backlog");
      assert(input.director.changes.length > 0 && input.director.changes.every(c => c.kind === "add" && c.task.origin.kind === "final-phase"), "Final-phase gaps must add findings without changing tombstones");
    }
    const add = (task: Task, reason: string, parent: string | null = null) => {
      assert(!backlog.tasks.some(t => t.id === task.id), `Task ID never reused: ${task.id}`);
      assert(task.status === "pending", "New tasks must be pending");
      const added = structuredClone(task); added.parent = parent ?? task.parent; added.history = []; history(added, "add", reason); backlog.tasks.push(added);
    };
    for (const change of input.director.changes) {
      assert(text(change.reason), "Every backlog change needs a reason");
      if (change.kind === "add") add(change.task, change.reason);
      else {
        const task = backlog.tasks.find(t => t.id === change.id); assert(task && ["pending", "blocked"].includes(task.status), "Cannot change unknown task or tombstone");
        if (change.kind === "obsolete") task.status = "obsolete";
        else if (change.kind === "split") { assert(Array.isArray(change.tasks) && change.tasks.length > 0, "Split needs children"); task.status = "obsolete"; for (const child of change.tasks) add(child, change.reason, task.id); }
        else if (change.kind === "update") {
          assert(record(change.patch) && Object.keys(change.patch).every(k => ["goal", "expectedResult", "specRefs", "dependsOn", "gates", "metric", "remaining"].includes(k)), "Invalid update patch (status/identity cannot be changed)");
          Object.assign(task, change.patch);
        } else throw new Error("Unknown backlog change");
        history(task, change.kind, change.reason);
      }
    }
    if (input.cancellations) {
      assert(input.director.select === null && input.director.changes.length === 0 && !input.confirmedUnit && !input.progress && !input.settle && !input.recordGaps,
        "Cancellation cannot carry director changes or settlement");
      for (const cancel of input.cancellations) {
        assert(record(cancel) && text(cancel.requestId) && text(cancel.taskId) && ["cancel", "delete"].includes(cancel.kind) &&
          /^[a-z][a-z0-9_-]{0,31}$/.test(cancel.origin) && bytes(cancel) <= 2048, "Invalid cancellation request");
        const task = backlog.tasks.find(t => t.id === cancel.taskId); assert(task, "Unknown cancelled task");
        if (task.history.some(h => ["cancel", "late-cancel"].includes(h.event))) continue;
        const late = task.status === "done";
        if (task.status === "obsolete") continue;
        if (!late) { task.status = "obsolete"; task.origin = { kind: "human", ref: cancel.requestId }; }
        history(task, late ? "late-cancel" : "cancel", JSON.stringify({ ...cancel,
          reason: late ? "cancellation arrived after settlement" : `cancelled by main-session request (origin: ${cancel.origin}; ${cancel.kind})` }));
      }
    }
    backlog.authority = input.authority; backlog.lastApplied = null;
    backlog.lastApplied = { key: input.key, requestDigest, contentDigest: canonicalDigest(backlog) };
    validateBacklog(backlog);
    selected = input.settle || input.recordGaps || input.cancellations ? null : selectTask(backlog, input.director.select);
  } catch (error) {
    if (!input.settle && !input.recordGaps && !input.cancellations && !(error as Error).message.startsWith("Final phase requires"))
      Object.assign(error as Error, { selectionRejected: true });
    throw error;
  }
  const excluded = cancelledScope(backlog);
  const written = writeBacklog(input.root, current, backlog);
  return { ...written, backlog, completedTasks: completedTasks(backlog), cancelledScope: excluded, selected, replay: false };
}
export type Cancellation = { taskId: string; requestId: string; kind: "cancel" | "delete"; origin: string };
export function cancelledScope(backlog: Backlog) {
  const excluded = new Map<string, { id: string; goal: string; expectedResult: string; completed: boolean; cancel: Cancellation & { reason: string; cascadeFrom?: string } }>();
  for (const task of backlog.tasks) {
    const event = task.history.find(h => ["cancel", "late-cancel"].includes(h.event));
    if (event) excluded.set(task.id, { id: task.id, goal: task.goal, expectedResult: task.expectedResult,
      completed: task.status === "done", cancel: JSON.parse(event.reason) });
    else if (task.status === "obsolete") excluded.set(task.id, { id: task.id, goal: task.goal, expectedResult: task.expectedResult,
      completed: false, cancel: { taskId: task.id, requestId: task.origin.ref, origin: task.origin.kind, kind: "cancel",
        reason: task.history.at(-1)?.reason ?? "Obsolete prerequisite" } });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of backlog.tasks.filter(t => t.status === "pending" && !excluded.has(t.id))) {
      const dependency = task.dependsOn.find(id => excluded.has(id));
      if (!dependency) continue;
      const source = excluded.get(dependency)!.cancel;
      excluded.set(task.id, { id: task.id, goal: task.goal, expectedResult: task.expectedResult, completed: false,
        cancel: { ...source, cascadeFrom: dependency,
          reason: `cancelled by main-session request (origin: ${source.origin}; dependency: ${dependency})` } });
      changed = true;
    }
  }
  const summary = [...excluded.values()].filter(item => item.cancel.cascadeFrom || backlog.tasks.find(t => t.id === item.id)!.history.some(h => ["cancel", "late-cancel"].includes(h.event)));
  assert(bytes(summary) <= 16384, "Cancelled scope exceeds bounded workflow summary");
  return summary;
}
function completedTasks(backlog: Backlog) {
  return backlog.tasks.filter(task => ["done", "obsolete"].includes(task.status)).map(task => ({
    id: task.id, goal: task.goal, status: task.status, reasons: task.history.map(entry => entry.reason) }));
}
function writeBacklog(root: string, current: { path: string; digest: string | null }, backlog: Backlog) {
  const raw = JSON.stringify(backlog, null, 2) + "\n", directory = path.dirname(current.path);
  safePath(directory); mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${backlog.specId}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
    assert(readBacklog(root, backlog.specId).digest === current.digest, `backlog-conflict: ${current.path}`);
    renameSync(temporary, current.path);
    const dirFd = openSync(directory, "r"); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return { path: current.path, digest: hash(raw) };
}
function auditHumanAcceptance(backlog: Backlog, invocation: string, loop: number) {
  const digest = canonicalDigest(backlog.acceptance);
  if (backlog.acceptanceHistory.at(-1)?.digest === digest) return false;
  backlog.acceptanceHistory = [...backlog.acceptanceHistory, { invocation, loop, kind: "human" as const,
    reason: "Acceptance list edited outside workflow apply", digest }].slice(-8);
  backlog.lastApplied = null;
  return true;
}

export function parseMetric(stdout: string): number | null {
  const last = stdout.split(/\r?\n/).filter(s => s.trim()).at(-1)?.trim();
  if (!last) return null;
  const value = Number(last); return Number.isFinite(value) ? value : null;
}
export function metricBefore(progress: Progress, fingerprint: string): number | null {
  const last = progress.last5.at(-1); return last?.fingerprint === fingerprint ? last.value : null;
}
export function updateProgress(previous: Progress, sample: Omit<Sample, "best">, target: number | null, timeout = false): Progress {
  const old = previous.last5.at(-1)?.best ?? (target === null ? 0 : null);
  const value = target === null ? sample.gatesPassed / Math.max(1, sample.gatesTotal) : sample.value;
  const objective = target ?? 1;
  const improved = !timeout && value !== null && (old === null || Math.abs(value - objective) < Math.abs(old - objective));
  const next: Sample = { ...sample, best: improved ? value : old };
  return { nonImproving: improved ? 0 : previous.nonImproving + 1, last5: [...previous.last5, next].slice(-5) };
}

function clipped(value: string, maxBytes: number): string {
  while (Buffer.byteLength(value) > maxBytes) value = value.slice(Math.max(1, Math.ceil((Buffer.byteLength(value) - maxBytes) / 4)));
  return value;
}
/** Command groups are separate so a timeout can kill the tree without killing its receipt producer. */
export async function runCommand(root: string, cmd: Command, logRef: string): Promise<{ result: GateResult; stdout: string }> {
  command(cmd, true);
  safePath(logRef); mkdirSync(path.dirname(logRef), { recursive: true });
  const fd = openSync(logRef, "w", 0o600), start = Date.now();
  let written = 0, tail = "", pendingLine = "", lastLine = "", timedOut = false, errorMessage = "";
  let childPid: number | undefined;
  const killGroup = (signal: NodeJS.Signals) => {
    if (!childPid) return;
    try { process.kill(-childPid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const stopped = (signal: NodeJS.Signals) => { killGroup("SIGKILL"); process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal as "SIGINT"] ?? 15)); };
  const onTerm = () => stopped("SIGTERM"), onInt = () => stopped("SIGINT"), onHup = () => stopped("SIGHUP");
  const onExit = () => killGroup("SIGKILL");
  process.on("SIGTERM", onTerm); process.on("SIGINT", onInt); process.on("SIGHUP", onHup); process.on("exit", onExit);
  // The shell can publish readiness before spawn returns; protect it before it exists.
  const child = spawn("sh", ["-c", cmd.command], { cwd: path.resolve(root, cmd.cwd), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  childPid = child.pid;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); hardKill = setTimeout(() => killGroup("SIGKILL"), 100); }, cmd.timeoutMs);
  function consume(data: Buffer, isStdout: boolean) {
    const available = Math.max(0, 8 * 1024 * 1024 - written);
    if (available) { const chunk = data.subarray(0, available); writeFileSync(fd, chunk); written += chunk.length; }
    tail = clipped(tail + data.toString("utf8"), 2048);
    // Retain the last non-empty stdout line, independently of stderr and log truncation.
    if (isStdout) {
      const lines = (pendingLine + data.toString("utf8")).split("\n");
      pendingLine = lines.pop()!;
      for (const line of lines) if (line.trim()) lastLine = line;
    }
  }
  child.stdout.on("data", data => consume(data, true)); child.stderr.on("data", data => consume(data, false));
  try {
    const exit = await new Promise<number | null>(resolve => {
      child.on("error", error => { errorMessage = error.message; });
      // A shell may exit while a background descendant still holds its output pipes.
      child.on("exit", () => killGroup("SIGKILL"));
      child.on("close", code => resolve(code));
    });
    return { result: { id: cmd.id, status: timedOut ? "timeout" : errorMessage ? "error" : exit === 0 ? "pass" : "fail", exit,
      ms: Date.now() - start, tail: errorMessage || tail, logRef }, stdout: pendingLine.trim() ? pendingLine : lastLine };
  } finally {
    clearTimeout(timer); if (hardKill) clearTimeout(hardKill); killGroup("SIGKILL"); closeSync(fd);
    process.off("SIGTERM", onTerm); process.off("SIGINT", onInt); process.off("SIGHUP", onHup); process.off("exit", onExit);
  }
}
export type GateInput = { root: string; specId: string; invocation: string; loop: number; attempt: number; key: string;
  task: Pick<Task, "id" | "gates" | "metric" | "progress">; workerStatus: string; writerSettled: true;
  knowledge?: { findings?: unknown; handoff?: unknown }; dbPath?: string; metricTimeoutMs?: number };
export async function gate(input: GateInput): Promise<GateReceipt> {
  assert(input.writerSettled === true, "Gate requires a settled worker and no active writer");
  key(input.invocation); key(input.key); key(input.task.id);
  assert(Number.isSafeInteger(input.loop) && input.loop > 0 && Number.isSafeInteger(input.attempt) && input.attempt > 0, "Invalid gate attempt");
  const directory = safePath(path.join(input.root, ".pi/subagents/execute", input.invocation, "gates", input.key));
  const before = checkoutEvidence(input.root), gates: GateResult[] = [];
  let metric: GateReceipt["metric"] = null;
  if (input.task.metric) {
    const result = await runCommand(input.root, { id: "metric", command: input.task.metric.command, cwd: ".", timeoutMs: input.metricTimeoutMs ?? 30 * 60 * 1000 }, path.join(directory, "metric.log"));
    const value = result.result.status === "timeout" || result.result.status === "error" ? null : parseMetric(result.stdout);
    metric = { value, error: value === null ? `Metric ${result.result.status}: no finite value; ${result.result.logRef}` : null };
  }
  if (input.workerStatus === "complete" || !input.task.metric) {
    for (const [index, cmd] of input.task.gates.entries()) gates.push((await runCommand(input.root, cmd, path.join(directory, `${index}.log`))).result);
  }
  const after = checkoutEvidence(input.root), mutated = before.head !== after.head || before.fingerprint !== after.fingerprint;
  const progress = updateProgress(input.task.progress, { value: metric?.value ?? null, fingerprint: after.fingerprint,
    gatesPassed: gates.filter(g => g.status === "pass").length, gatesTotal: input.task.gates.length }, input.task.metric?.target ?? null,
    mutated || gates.some(g => g.status === "timeout") || !!metric?.error);
  return withBoard(input.root, input.specId, input.dbPath, (board, workspace, topicId) => {
    const prefix = `execute:${input.invocation}:l${input.loop}:a${input.attempt}`;
    const findings = Array.isArray(input.knowledge?.findings) ? input.knowledge.findings : [];
    findings.forEach((finding, n) => {
      if (text(finding)) board.postOnce(workspace, `${prefix}:FINDING:${n}`, { topicId, type: "FINDING", content: clipped(finding, 2048), metadata: { taskId: input.task.id } });
    });
    if (text(input.knowledge?.handoff)) board.postOnce(workspace, `${prefix}:HANDOFF`, { topicId, type: "HANDOFF", content: clipped(input.knowledge.handoff, 2048), metadata: { taskId: input.task.id } });
    const receipt: GateReceipt = { before: { head: before.head, fingerprint: before.fingerprint },
      after: { head: after.head, fingerprint: after.fingerprint }, mutated, gates, metric, progress, stalled: progress.nonImproving >= 3,
      view: boardView(board, workspace, topicId, input.task.id) };
    mkdirSync(directory, { recursive: true });
    // Keep the full diagnostic even when the wire representation needs smaller tails/views.
    writeFileSync(safePath(path.join(directory, "receipt.json")), JSON.stringify({ ...receipt, before, after }) + "\n");
    for (const g of receipt.gates) { while (bytes(g.tail) > 2048) g.tail = g.tail.slice(Math.max(1, Math.ceil(g.tail.length / 8))); }
    while (bytes(receipt) > 8191 && receipt.gates.some(g => g.tail.length > 0)) {
      for (const g of receipt.gates) g.tail = g.tail.slice(Math.ceil(g.tail.length / 2));
    }
    if (bytes(receipt) > 8191) {
      const overhead = bytes(receipt) - bytes(receipt.view);
      receipt.view = boardView(board, workspace, topicId, input.task.id, 8191 - overhead);
    }
    assert(bytes(receipt) <= 8191, `Gate receipt exceeds 8 KiB; see ${path.join(directory, "receipt.json")}`);
    return receipt;
  });
}
