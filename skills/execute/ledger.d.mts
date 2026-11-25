import type { PitakoStore, StoreRecord, StoreHead, CommitResult, VerifiedStoreRecord } from "../../extensions/pitako-store.ts";
import type { CheckpointIntent, SealerRequest } from "../../extensions/execute-checkpoint.ts";

export { canonicalJSON } from "../../extensions/canonical.mjs";
export function readRequest(raw: string): unknown;
export function storedGateEvidence(records: readonly VerifiedStoreRecord[], request: any): any;
export function storedGateProjection(store: PitakoStore<ExecuteProjection>, scope: string,
  prefix: { records: readonly StoreRecord[] }, request: any): any;

type Candidate = { head?: string; fingerprint?: string };
type LoopBody = {
  observation?: { checkout?: Candidate };
  candidate?: Candidate;
  review?: { verdict?: string; reason?: unknown; unresolved?: unknown };
  compliance?: { status?: string; reason?: unknown; unresolved?: unknown; candidate?: Candidate };
  results?: {
    taskId?: string;
    remaining?: unknown;
    diagnosis?: unknown;
    checks?: { current?: unknown };
  }[];
  plan?: { rejection?: { diagnostic?: unknown } };
};

type ProjectionReference = { scope: string; seq: number; digest: string };
type InputReference = Pick<ProjectionReference, "seq" | "digest">;
type ProjectionPage<T> = { items: T[]; total: number; omitted: number; ref: ProjectionReference | null };
type LoopSummary = {
  loop: number;
  status: "complete" | "gaps";
  gaps: string;
  review: string;
  compliance: string;
  rejection: string;
};
type AttemptProjection = {
  lastAttempt: {
    taskId: string; number: number;
    result: unknown;
    checkpoint?: unknown; launch?: unknown; revival?: unknown;
    gate?: { receipt: { after: Candidate; progress: { nonImproving?: number }; stalled: boolean; contextPeak: number | null } };
    halt?: unknown; restore?: ProjectionReference | null;
  } | null;
};
type SelectedTask = {
  id: string; status: string; dependsOn: string[];
  gates: { id: string; command: string; cwd: string; timeoutMs?: number }[];
  metric: { command: string; unit: string; target: number } | null;
  [field: string]: unknown;
};
type RootAdmission = {
  association: CheckpointIntent["association"];
  admissionBinding: string;
  amendments: unknown[];
  revivalContextPeak: number;
  startedAt: number;
  timeouts: { values: Record<string, number>; since: { loop: number; attempt: number } } | null;
  models: {
    taskReviewer: string; taskSynthesis: string;
    r1: { key: string; model: string }; r2: { key: string; model: string }; synthesis: { key: string; model: string };
  };
};
export type ExecuteProjection = {
  control: AttemptProjection & {
    selectedTask: (Pick<SelectedTask, "id" | "status" | "dependsOn" | "gates" | "metric"> & { ref: ProjectionReference }) | null;
    intent: ProjectionReference | null;
    admission: InputReference | null;
    operation: { operation: "advance" | "selection" | "close"; key: string; input: InputReference; loop?: number } | null;
    plan: InputReference | null;
    taskFrame: InputReference | null;
  };
  prompt: {
    selectedTask: SelectedTask | null; admission: RootAdmission | null;
    execution?: { plan: unknown; backlogPath: string | null; checkpoint: CheckpointIntent | null; worker: unknown;
      continuationRef?: InputReference; foldedContinuation?: unknown };
  };
  preview: ExecutePreview;
};
type ExecutePreview = {
  loopSummaries: LoopSummary[];
  closeReferences: (ProjectionReference & { loop: number })[];
  planRejections: { loop: number; diagnostic: string }[];
  admittedTasks: ProjectionPage<{ id: string; status: string; title: string; goal: string; remaining: string; dependsOn: string[]; dependenciesOmitted: number }>;
  manifest: { digest: string | null; length: number; current: string | null };
  view: (ProjectionPage<{ id: number; type: string; content: string }> & { topicId: number; authority: string }) | null;
  criterionStatuses: ProjectionPage<{ criterion: number; status: "not-run" | "passed" | "failed"; candidate: Candidate; loop: number }>;
  usage: { tokens: number; known: number; unknown: number };
  pendingDemand: {
    requests: ProjectionPage<{ v: 1; invocation: string; requestId: string; taskId: string; kind: "cancel" | "delete"; origin: string; at: string | number }> & { next?: number | null };
    sources: (ProjectionReference & { loop: number; gaps: string; review: string; compliance: string })[];
  };
};
type LedgerAnchor = { count: number; head: string | null };
type LedgerRecord = { seq: number; prev: string | null; kind: "spec" | "unit" | "loop"; loop: number; body: LoopBody & Record<string, unknown> };
type LedgerRequest = {
  expected: LedgerAnchor;
  spec?: { content: string; digest: string };
  record: { kind: "unit" | "loop"; loop: number; body: unknown };
};
type ExecuteCommit = Extract<CommitResult<ExecuteProjection>, { outcome: "appended" | "replay" }>;

export function ledgerPath(root: string, invocation: string): string;
export function executeScope(invocation: string, epoch?: number): string;
export function executeEpoch(invocation: string, key: string): number;
export function withExecuteStore<T>(root: string, invocation: string, fn: () => T | Promise<T>, epoch?: number | null,
  cursor?: { storeId: string; expectedHead: StoreHead }): Promise<T>;
export function executeProjection(rows: readonly StoreRecord[]): ExecuteProjection;
export function fullExecuteProjection(rows: readonly StoreRecord[]): ExecuteProjection;
export function executeStore(root: string, invocation: string, writer?: boolean, epoch?: number): { store: PitakoStore<ExecuteProjection>; scope: string; head?: StoreHead };
export function commitExecute(root: string, invocation: string, opKey: string, requestDigest: string, kind: string, body: unknown): ExecuteCommit;
export function admitExecuteRoot(root: string, invocation: string, admission: RootAdmission): ExecuteCommit & { result: RootAdmission };
export function committedIntent(intent: CheckpointIntent, candidate: { head: string; fingerprint: string }): { seq: number; digest: string };
export function committedSeal(request: SealerRequest, receipt: unknown): ExecuteCommit;
export function verifyLedger(root: string, invocation: string, expected: LedgerAnchor, epoch?: number): LedgerRecord[];
export function loopSummaries(root: string, invocation: string, expected: LedgerAnchor): LoopSummary[];
export function ledgerProjection(root: string, invocation: string, expected: LedgerAnchor): {
  storeId: string; head: { seq: number; hash: string }; P: ExecuteProjection;
};
export function isLedgerIntegrityError(error: unknown): boolean;
export function verifyExecuteStoreForWrite(root: string): { storeId: string; root: string };
export function appendLedger(root: string, invocation: string, request: LedgerRequest): LedgerAnchor;

export function summarizeLoops(records: readonly {
  kind: string;
  loop: number;
  body: LoopBody;
}[]): LoopSummary[];
