import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Attempt } from "./run.ts";
import type { ModelTarget } from "../roles/types.ts";
import { acquireHistoryExclusion } from "./history-retention.ts";

/** Host-supplied origin, never recovered from a prompt or child cwd. */
export interface HistoryOrigin {
  source: "agent_run" | "agent_spawn" | "team_assign";
  coordinatorSessionId?: string;
  coordinatorSessionFile?: string;
  assignmentId?: string;
  workbrief?: string;
  execution?: { executionRoot: string; executionRef: string };
}

export type HistoryClosure =
  | { state: "unclosed" }
  | { state: "unknown"; reason: string }
  | { state: "closed"; closedAt: string; evidenceRef: string };

/** New groups use host invocation/execution authority; mission identities remain archive provenance. */
export type HistoryIdentity =
  | { kind: "invocation"; invocationId: string }
  | { kind: "execution"; executionRoot: string; executionRef: string }
  | { kind: "mission"; storeRoot: string; missionId: string };

export type HistoryDisposition =
  | { state: "pending" }
  | { state: "unknown"; reason: string }
  | { state: "disposed"; at: string };

export interface HistoryMember {
  historyId: string;
  roleId: string;
  coordinatorSessionId?: string;
  coordinatorSessionFile?: string;
  assignmentId?: string;
  instanceId?: string;
  attemptId?: string;
  memberId?: string;
  continuationOf?: string;
  diagnosisId?: string;
  diagnosisOf?: string;
  unitId?: string;
  roundId?: string;
  recoveryOf?: string;
  retryOf?: string;
  admittedAt: string;
  native:
    | { state: "not-created" }
    | { state: "pruned" }
    | { state: "allocated"; sessionId: string; path: string; disposition: HistoryDisposition };
  terminal?: {
    status: Attempt["status"];
    at: string;
    reason?: string;
    /** Positive lifecycle observation, not inferred from a missing file. */
    beforeFirstAssistant: boolean;
  };
  gaps: string[];
}

export interface HistoryGroup {
  version: 1;
  groupId: string;
  workspace: string;
  identity: HistoryIdentity;
  coverage: "complete" | "partial";
  members: HistoryMember[];
  closure: HistoryClosure;
  missionStore?: { dbPath: string; objectDir: string; sessionsDirectory: string };
  /** Exact cleanup intent remains visible until every owned unlink succeeds. */
  cleanup?: { state: "deleting"; owner: string; files: Array<{ path: string; kind: "file" | "alias"; target?: string }>;
    closedAt: string };
  prunedAt?: string;
  aliases?: Array<{ path: string; target: string }>;
}

export type HistoryAdmission = Pick<HistoryMember,
  "roleId" | "coordinatorSessionId" | "coordinatorSessionFile" | "assignmentId" |
  "instanceId" | "attemptId" | "memberId" | "continuationOf" | "diagnosisId" | "diagnosisOf" | "unitId" | "roundId" | "recoveryOf" | "retryOf">;

export type NativeHistoryStatus =
  | { state: "not-created" }
  | { state: "pruned" }
  | { state: "present" }
  | { state: "not-persisted-before-assistant" }
  | { state: "missing"; reason: string };

/** Absence is not evidence of no activity, even for an allocated session. */
export function nativeHistoryStatus(member: HistoryMember): NativeHistoryStatus {
  if (member.native.state !== "allocated") return { state: member.native.state };
  try {
    const stat = lstatSync(member.native.path);
    if (!stat.isFile()) return { state: "missing", reason: "native path is not a regular file" };
    return { state: "present" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return member.terminal?.beforeFirstAssistant
      ? { state: "not-persisted-before-assistant" }
      : { state: "missing", reason: "native file absent; persistence or loss not established" };
  }
}

function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("worker history directory is not a directory");
  chmodSync(directory, 0o700);
}

function lstatExists(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function assertId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("invalid worker history identity");
  }
  return id;
}

/** Metadata only. Native JSONL remains the sole transcript.
 * Mutations fail closed on a busy/uncertain lock; no lock spans provider work.
 */
export class WorkerHistory {
  readonly agentDir: string;
  readonly catalogDir: string;

  constructor(agentDir = getAgentDir(), options: { initialize?: boolean } = {}) {
    if (options.initialize !== false) mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    this.agentDir = options.initialize === false && !lstatExists(agentDir) ? path.resolve(agentDir) : realpathSync(agentDir);
    this.catalogDir = path.join(this.agentDir, "pitako", "worker-history");
    if (options.initialize !== false) privateDirectory(this.catalogDir);
  }

  private file(groupId: string): string {
    return path.join(this.catalogDir, `${assertId(groupId)}.json`);
  }

  read(groupId: string): HistoryGroup {
    const file = this.file(groupId);
    if (!lstatSync(file).isFile() || realpathSync(file) !== file) throw new Error("unsafe worker history catalog");
    const group: HistoryGroup = JSON.parse(readFileSync(file, "utf8"));
    if (group.version !== 1 || group.groupId !== groupId || !Array.isArray(group.members)) {
      throw new Error("unsupported or invalid worker history catalog");
    }
    return group;
  }

  list(): HistoryGroup[] {
    let names: string[];
    try { names = readdirSync(this.catalogDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return names
      .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
      .sort().map((name) => this.read(name.slice(0, -5)));
  }

  private write(group: HistoryGroup): void {
    if (group.identity.kind === "mission") throw new Error("archived worker history is catalog-only");
    const destination = this.file(group.groupId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(group)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  mutate<T>(groupId: string, action: (group: HistoryGroup) => T): T {
    if (this.read(groupId).identity.kind === "mission") throw new Error("archived worker history is catalog-only");
    const release = acquireHistoryExclusion(this.file(groupId));
    try {
      const group = this.read(groupId);
      if (group.identity.kind === "mission") throw new Error("archived worker history is catalog-only");
      if (group.cleanup || group.prunedAt) throw new Error("worker history group is sealed");
      const result = action(group);
      this.write(group);
      return result;
    } finally {
      release();
    }
  }

  /** Async authority refresh and cleanup share the admission exclusion; no provider request runs here. */
  async exclusive<T>(groupId: string, action: (group: HistoryGroup, save: () => void) => Promise<T>): Promise<T> {
    if (this.read(groupId).identity.kind === "mission") throw new Error("archived worker history is catalog-only");
    const release = acquireHistoryExclusion(this.file(groupId));
    try {
      const group = this.read(groupId);
      if (group.identity.kind === "mission") throw new Error("archived worker history is catalog-only");
      return await action(group, () => this.write(group));
    } finally { release(); }
  }

  createGroup(workspace: string, identity?: Exclude<HistoryIdentity, { kind: "mission" }>,
    metadata: Partial<Pick<HistoryGroup, "coverage">> = {}): HistoryGroup {
    const group: HistoryGroup = {
      version: 1, groupId: randomUUID(), workspace: realpathSync(workspace),
      identity: identity ?? { kind: "invocation", invocationId: randomUUID() },
      coverage: "complete", members: [], closure: { state: "unclosed" },
      ...metadata,
    };
    if (group.identity.kind === "execution") {
      group.identity = { ...group.identity, executionRoot: realpathSync(group.identity.executionRoot) };
    }
    this.write(group);
    return group;
  }

  executionGroup(workspace: string, execution: Extract<HistoryIdentity, { kind: "execution" }>): HistoryGroup {
    const identity = { ...execution, executionRoot: realpathSync(execution.executionRoot) };
    const key = createHash("sha256").update(JSON.stringify([identity.executionRoot, identity.executionRef])).digest("hex");
    const lock = path.join(this.catalogDir, `execution-${key}.lock`);
    mkdirSync(lock, { mode: 0o700 });
    try {
      const existing = this.list().find((group) => group.identity.kind === "execution" &&
        group.identity.executionRoot === identity.executionRoot && group.identity.executionRef === identity.executionRef);
      return existing ?? this.createGroup(workspace, identity);
    } finally {
      rmSync(lock, { recursive: true });
    }
  }

  closeInvocation(groupId: string): void {
    this.mutate(groupId, (group) => {
      if (group.identity.kind !== "invocation") return; // A worker cannot seal an execution.
      if (group.members.some((member) => !member.terminal ||
        member.native.state === "allocated" && member.native.disposition.state !== "disposed")) return;
      group.closure = { state: "closed", closedAt: new Date().toISOString(), evidenceRef: "host invocation settled and all allocated sessions disposed" };
    });
  }

  admit(groupId: string, admission: HistoryAdmission): HistoryMember {
    return this.mutate(groupId, (group) => {
      if (group.closure.state !== "unclosed" || group.cleanup || group.prunedAt) throw new Error("worker history group is not open");
      const member: HistoryMember = {
        ...admission, historyId: randomUUID(), admittedAt: new Date().toISOString(),
        native: { state: "not-created" }, gaps: [],
      };
      group.members.push(member);
      return member;
    });
  }

  /** Public SDK only: no header, synthetic message, flush or memory fallback. */
  createSession(groupId: string, historyId: string, cwd: string): SessionManager {
    return this.mutate(groupId, (group) => {
      const member = this.member(group, historyId);
      if (group.closure.state !== "unclosed" || member.terminal || member.native.state !== "not-created") {
        throw new Error("worker history session already allocated or member closed");
      }
      const directory = path.join(this.agentDir, "sessions", `--pitako-workers--${group.groupId}`);
      privateDirectory(directory);
      const manager = SessionManager.create(cwd, directory);
      const file = manager.getSessionFile();
      if (!file) throw new Error("Pi did not allocate a persistent worker session");
      member.native = {
        state: "allocated", sessionId: manager.getSessionId(), path: file,
        disposition: { state: "pending" },
      };
      return manager;
    });
  }

  private member(group: HistoryGroup, historyId: string): HistoryMember {
    const member = group.members.find((entry) => entry.historyId === assertId(historyId));
    if (!member) throw new Error("worker history member not found");
    return member;
  }

  recordTerminal(groupId: string, historyId: string, terminal: Omit<NonNullable<HistoryMember["terminal"]>, "at">): void {
    this.mutate(groupId, (group) => {
      const member = this.member(group, historyId);
      if (member.terminal) throw new Error("worker history terminal result already recorded");
      member.terminal = { ...terminal, at: new Date().toISOString() };
    });
  }

  recordDisposition(groupId: string, historyId: string, disposition: HistoryDisposition): void {
    this.mutate(groupId, (group) => {
      const member = this.member(group, historyId);
      if (member.native.state !== "allocated") throw new Error("worker has no session to dispose");
      member.native.disposition = disposition;
    });
  }

  recordGap(groupId: string, historyId: string, gap: string): void {
    this.mutate(groupId, (group) => {
      this.member(group, historyId).gaps.push(gap);
      // Missing native provenance before the first assistant is not missing admission coverage.
    });
  }
}

/** One invocation owns every replacement session; execution-bound invocations share a group. */
export class InvocationHistory {
  readonly store = new WorkerHistory();
  readonly group: HistoryGroup;
  readonly cwd: string;
  readonly origin: HistoryOrigin | undefined;
  readonly task: string;
  readonly standalone: boolean;
  private admissions = 0;

  constructor(cwd: string, origin: HistoryOrigin | undefined, task: string, standalone = false) {
    this.cwd = cwd;
    this.origin = origin;
    this.task = task;
    this.standalone = standalone;
    this.group = origin?.execution
      ? this.store.executionGroup(cwd, { kind: "execution", ...origin.execution })
      : this.store.createGroup(cwd);
  }

  admit(instanceId: string, roleId: string, target: ModelTarget): SessionHistory {
    const admission = {
      instanceId, roleId, coordinatorSessionId: this.origin?.coordinatorSessionId,
      coordinatorSessionFile: this.origin?.coordinatorSessionFile, assignmentId: this.origin?.assignmentId,
    };
    const current = this.store.read(this.group.groupId);
    if (current.closure.state !== "unclosed" || current.cleanup || current.prunedAt) throw new Error("worker history group is not open");
    const member = this.store.admit(this.group.groupId, admission);
    this.admissions += 1;
    return new SessionHistory(this, member.historyId, target);
  }

  get admitted(): boolean {
    return this.admissions > 0;
  }

  settled(): void {
    this.store.closeInvocation(this.group.groupId);
  }
}

/** Captured by the session handle, including continuation after side effects. */
export class SessionHistory {
  readonly invocation: InvocationHistory;
  readonly historyId: string;
  readonly target: ModelTarget;
  manager?: SessionManager;
  private last?: Attempt;
  private disposalObserved = false;
  private live = false;
  private terminal = false;
  private observedAssistant = false;
  private streamInstructions?: string;

  constructor(invocation: InvocationHistory, historyId: string, target: ModelTarget) {
    this.invocation = invocation;
    this.historyId = historyId;
    this.target = target;
  }

  append(event: string, data: unknown): void {
    this.manager?.appendCustomEntry("pitako.worker-history", { version: 1, event, data });
  }

  create(): SessionManager {
    const { store, group, cwd, origin, task } = this.invocation;
    this.manager = store.createSession(group.groupId, this.historyId, cwd);
    this.append("origin", { groupId: group.groupId, historyId: this.historyId, identity: group.identity,
      origin, workbrief: origin?.workbrief ?? task, initialTarget: this.target });
    return this.manager;
  }

  assistantObserved(): void {
    this.observedAssistant = true;
  }

  attached(): void {
    this.live = true;
  }

  /** Native system messages are authoritative; retain only stream-boundary differences. */
  instructions(effective: string, native: string): void {
    if (effective === this.streamInstructions) return;
    this.streamInstructions = effective;
    this.append("stream-instructions", {
      ...(effective === native ? { source: "native-system-entries" } : { effective }),
      boundary: "host streamFunction input; later provider transformations are not observed",
    });
  }

  result(attempt: Attempt): Attempt {
    this.last = attempt;
    this.append("result", { status: attempt.status, error: attempt.error,
      sideEffects: attempt.sideEffects, appliedReasoning: attempt.appliedReasoning });
    // Setup failures may dispose before returning their result, or never allocate.
    if (this.disposalObserved || !this.live) {
      if (!this.disposalObserved) {
        const { store, group } = this.invocation;
        const member = store.read(group.groupId).members.find((entry) => entry.historyId === this.historyId);
        if (member?.native.state === "allocated" && this.manager) store.recordDisposition(group.groupId, this.historyId,
          { state: "unknown", reason: "setup returned no live session handle; disposal not established" });
      }
      this.finish();
    }
    return attempt;
  }

  disposition(error?: unknown): void {
    const { store, group } = this.invocation;
    this.disposalObserved = true;
    this.append("disposal", error ? { state: "unknown", reason: String(error) } : { state: "disposed" });
    store.recordDisposition(group.groupId, this.historyId, error
      ? { state: "unknown", reason: String(error) }
      : { state: "disposed", at: new Date().toISOString() });
    this.finish();
  }

  private finish(): void {
    if (!this.last || this.terminal) return;
    this.terminal = true;
    const { store, group } = this.invocation;
    store.recordTerminal(group.groupId, this.historyId, {
      status: this.last.status, reason: this.last.error,
      beforeFirstAssistant: !this.observedAssistant,
    });
    if (!this.observedAssistant) store.recordGap(group.groupId, this.historyId,
      "No first assistant observed: native custom provenance may not have persisted; catalog retains admission and lifecycle only.");
    if (this.invocation.standalone) this.invocation.settled();
  }
}
