import { randomUUID } from "node:crypto";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import { relative as pathRelative } from "node:path";
import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult, ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentClosureError, type AgentClosure } from "../closure.ts";
import { runAgentInstance, type AgentRunResult, type AgentUsage, type AttemptExecutor } from "../run.ts";
import { developerCapacityPreflight, type DispatchSnapshot } from "../routing.ts";
import type { PitakoConfig } from "../../roles/types.ts";
import type { ActivityReadOptions, LiveHandle } from "../live.ts";
import { HeadGraph, boundedText, contains, evidenceRefs, writesConflict, type HeadNodeSpec, type HeadTransaction } from "./graph.ts";
import { ManagedAssignment } from "./managed-tools.ts";
import { acquireCheckpointLease, assertNoCheckpointLease } from "./checkpoint-lease.ts";
import { CheckpointWriter } from "./checkpoint.ts";
import { adoptCheckpoint, type CheckpointManifest, type CheckpointNative, type CheckpointOrigin } from "../checkpoints.ts";

export interface HeadResultEnvelope {
  envelopeId: string;
  assignmentId: string;
  childId: string;
  nodeId?: string;
  admittedRevision?: number;
  effectiveRevision?: number;
  result: AgentRunResult;
}

/** Host-only, assignment-local authority. Never construct this from model/tool input. */
export class HeadAttachment {
  readonly signal: AbortSignal;
  private controller = new AbortController();
  private instanceId?: string;
  private binding?: object;
  private operations = new Set<Promise<unknown>>();
  private failures: unknown[] = [];
  private children = new Map<string, { envelope?: HeadResultEnvelope; closure: AgentClosure }>();
  private waiters = new Set<() => void>();
  private closing?: Promise<void>;
  private effects = false;
  private offered = new Set<string>();
  closure: AgentClosure = { state: "pending" };
  readonly dag?: HeadDagRuntime;
  readonly managed?: ManagedAssignment;
  readonly checkpointOrigin?: CheckpointManifest;
  private checkpointWriter?: CheckpointWriter;
  private checkpointCapture?: () => CheckpointNative["source"];

  constructor(readonly assignmentId: string, readonly executionRoot: string, options?: HeadDagOptions) {
    this.signal = this.controller.signal;
    if (options) this.dag = new HeadDagRuntime(this, options);
    assertNoCheckpointLease(this.dag?.graph.root ?? executionRoot);
    if (this.dag) {
      this.checkpointOrigin = options?.checkpoint_origin && adoptCheckpoint(this.dag.graph.root, options.checkpoint_origin, this.dag.graph.envelope);
      this.managed = new ManagedAssignment(this.dag.graph.root, this.dag.graph.envelope, this.checkpointOrigin);
    }
  }

  bindCheckpointCapture(capture: () => CheckpointNative["source"]): void { this.checkpointCapture = capture; }
  checkpoints(binding: object, append: (result: unknown) => void): CheckpointWriter {
    this.check(binding);
    if (!this.managed || !this.dag) throw new Error("local checkpoints not granted");
    this.checkpointWriter ??= new CheckpointWriter({
      assignmentId: this.assignmentId, managed: this.managed, signal: this.signal,
      acquire: revision => {
        this.check(binding);
        if (this.operations.size || this.failures.length) throw new Error("Head attachment operations are still settling or unknown");
        this.dag!.assertCheckpointReady(binding, revision);
        return acquireCheckpointLease(this.managed!.root);
      },
      check: revision => { this.check(binding); this.dag!.checkCheckpointRevision(revision); this.managed!.assertHealthy(); },
      capture: () => {
        if (!this.checkpointCapture) throw new Error("native checkpoint source not bound");
        return this.checkpointCapture();
      },
      graph: () => this.dag!.graph.snapshot(), effects: () => this.admitted(),
      own: operation => this.own(binding, operation), append,
    }, this.checkpointOrigin);
    return this.checkpointWriter;
  }

  claim(instanceId: string, executionRoot: string): void {
    if (this.instanceId || this.signal.aborted || executionRoot !== this.executionRoot) {
      throw new Error("Head attachment is stale, already claimed, or belongs to another execution root");
    }
    this.instanceId = instanceId;
  }

  get sideEffects(): boolean { return this.effects; }
  get ownedOperations(): number { return this.operations.size; }
  get headInstanceId(): string | undefined { return this.instanceId; }
  admitted(): void { this.effects = true; }

  bind(instanceId: string): object {
    this.managed?.assertIdle();
    if (instanceId !== this.instanceId || this.signal.aborted) throw new Error("Head attachment is not granted");
    // Replacing a native binding synchronously invalidates every borrowed capability.
    this.wake();
    this.dag?.invalidateProposals();
    this.binding = {};
    return this.binding;
  }

  unbind(binding: object): void {
    if (this.binding === binding) { this.binding = undefined; this.dag?.invalidateProposals(); this.wake(); }
  }

  revoke(): void {
    this.binding = undefined;
    this.controller.abort();
    this.dag?.revoke();
    this.wake();
  }

  check(binding: object): void {
    if (binding !== this.binding || this.signal.aborted) throw new Error("Head binding is retired");
  }

  /** Registers startup/preflight before it can suspend; admission must be checked after preflight. */
  own<T>(binding: object, operation: () => Promise<T>): Promise<T> {
    this.check(binding);
    const pending = Promise.resolve().then(() => {
      this.check(binding);
      return operation();
    });
    this.operations.add(pending);
    void pending.then(
      () => this.operations.delete(pending),
      error => {
        this.operations.delete(pending);
        if (error instanceof AgentClosureError) this.failures.push(error);
      },
    );
    return pending;
  }

  /** The operation must own a runner through disposal, not just its terminal status. */
  startChild(childId: string, run: (signal: AbortSignal) => Promise<AgentRunResult>,
    context?: () => Pick<HeadResultEnvelope, "nodeId" | "admittedRevision" | "effectiveRevision">): Promise<AgentRunResult> {
    const binding = this.binding;
    if (!binding) throw new Error("Head binding is retired");
    this.check(binding);
    if (this.children.has(childId)) throw new Error(`Head child ${childId} already admitted`);
    this.effects = true; // Admission fences replay even before a child writes.
    const child: { envelope?: HeadResultEnvelope; closure: AgentClosure } = { closure: { state: "pending" } };
    this.children.set(childId, child);
    const pending = this.own(binding, async () => {
      try {
        const result = await run(this.signal);
        child.closure = { state: "released" };
        child.envelope = { envelopeId: randomUUID(), assignmentId: this.assignmentId, childId, ...context?.(), result: structuredClone(result) };
        this.wake();
        return result;
      } catch (error) {
        child.closure = error instanceof AgentClosureError
          ? { state: "unknown", reason: String(error) } : { state: "released" };
        this.wake();
        throw error;
      }
    });
    void pending.catch(error => {
      if (child.closure.state === "pending") child.closure = error instanceof AgentClosureError
        ? { state: "unknown", reason: String(error) } : { state: "released" };
      this.wake();
    });
    return pending;
  }

  result(binding: object, childId: string): HeadResultEnvelope | undefined {
    this.check(binding);
    const child = this.children.get(childId);
    if (!child) throw new Error("unknown Head child");
    return child.envelope ? structuredClone(child.envelope) : undefined;
  }
  closedOutcome(childId: string): HeadResultEnvelope | undefined {
    const envelope = this.children.get(childId)?.envelope;
    return envelope ? structuredClone(envelope) : undefined;
  }

  async wait(binding: object, signal?: AbortSignal): Promise<HeadResultEnvelope[]> {
    this.check(binding);
    if (signal?.aborted) throw new Error("Head wait cancelled");
    if (![...this.children.values()].some(child => child.envelope)) {
      await new Promise<void>((resolve) => {
        const done = () => { this.waiters.delete(done); signal?.removeEventListener("abort", done); resolve(); };
        this.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    this.check(binding);
    if (signal?.aborted) throw new Error("Head wait cancelled");
    return [...this.children.values()].flatMap(child => child.envelope ? [structuredClone(child.envelope)] : []);
  }

  /** A draft/callback is only an offer; active native entries are the delivery receipt. */
  boundary(binding: object, event: AgentBeforeSettleEvent, manager: Pick<SessionManager, "getBranch">): AgentBeforeSettleEventResult | undefined {
    this.check(binding);
    if (event.outcome !== "completed" || !event.context.canContinue) return;
    const entries: NonNullable<AgentBeforeSettleEventResult["entries"]> = [];
    for (const child of this.children.values()) {
      const envelope = child.envelope;
      if (!envelope) continue;
      const content = JSON.stringify(envelope);
      const incorporated = manager.getBranch().some(entry => entry.type === "custom_message" &&
        entry.customType === "pitako.head.result" && entry.content === content &&
        entry.details && typeof entry.details === "object" && "envelopeId" in entry.details &&
        entry.details.envelopeId === envelope.envelopeId);
      this.check(binding);
      if (!incorporated) {
        entries.push({ type: "custom_message", customType: "pitako.head.result", content, display: true,
          details: { envelopeId: envelope.envelopeId, assignmentId: this.assignmentId, childId: envelope.childId,
            ...(this.dag && this.offered.has(envelope.envelopeId) ? { deliveryGap: "Prior offer not observed in the current native branch" } : {}) } });
        this.offered.add(envelope.envelopeId);
      }
    }
    if (this.dag) return this.dag.boundary(binding, entries, manager);
    return entries.length ? { entries, continue: true } : undefined;
  }

  close(): Promise<void> {
    if (this.closure.state === "unknown") return Promise.reject(new AgentClosureError(this.failures, `Head ${this.assignmentId}`));
    if (this.closing) return this.closing;
    this.revoke();
    this.closing = (async () => {
      while (this.operations.size) await Promise.allSettled([...this.operations]);
      try { await this.managed?.settle(); } catch (error) { this.failures.push(error); }
      const uncertainty = this.dag?.closureFailures();
      if (uncertainty?.length) this.failures.push(...uncertainty);
      if (this.failures.length) {
        const error = new AgentClosureError(this.failures, `Head ${this.assignmentId}`);
        this.closure = { state: "unknown", reason: error.message };
        throw error;
      }
      this.closure = { state: "released" };
    })();
    return this.closing;
  }

  retainUnknown(error: AgentClosureError): void {
    this.failures.push(error);
    this.revoke();
    this.closure = { state: "unknown", reason: error.message };
  }

  private wake(): void { for (const wake of [...this.waiters]) wake(); }
}

export interface HeadDagOptions {
  writes: string[];
  config: PitakoConfig;
  executor: AttemptExecutor;
  checkpoint_origin?: CheckpointOrigin;
  /** Host boundary injection for controlled tests; snapshots still confer no start authority. */
  preflight?: typeof developerCapacityPreflight;
}
export type HeadFinish =
  | { status: "completed"; epoch: string; summary: string; verification: string[]; limits: string[] }
  | { status: "failed"; diagnostic: string; evidence: string[]; limits: string[] };
export interface HeadHandoff {
  assignmentId: string;
  managed?: ReturnType<ManagedAssignment["snapshot"]>;
  headInstanceId?: string;
  revision: number;
  finish: HeadFinish;
  barrier?: { epoch: string; revision: number };
  leaves: Array<{ runId: string; nodeId: string; admittedRevision: number; effectiveRevision: number;
    instanceId?: string; status?: AgentRunResult["status"]; closure: AgentClosure; diagnostic?: string; usage?: AgentUsage }>;
  metrics: {
    ownUsage?: AgentUsage;
    aggregateUsage?: AgentUsage;
    aggregateClassifierUsage?: Partial<AgentUsage>;
    usageComplete: boolean;
    classifierUsage: Array<{ dispatchId: string; usage: ClassifierResult["usage"] | null }>;
    elapsedMs: number;
    observedPeakParallelism: number;
  };
}
export interface HeadRunIdentity {
  runId: string;
  effectiveRevision: number;
  historyId: string;
  sessionId: string;
}
interface ScopeProposal {
  proposalId: string;
  expectedRevision: number;
  effectiveRevision: number;
  next: HeadNodeSpec;
  additions: HeadNodeSpec[];
  progress: string[];
  native: { historyId: string; sessionId: string };
  receipt?: Record<string, unknown>;
  acknowledgment?: { accept: boolean; progress: string[] };
  state: "proposed" | "confirmed" | "invalidated";
}
interface HeadAttempt {
  runId: string;
  nodeId: string;
  admittedRevision: number;
  effectiveRevision: number;
  graphRevision: number;
  phase: "preflight" | "startup" | "running" | "cancelling" | "closed" | "unknown";
  closure: AgentClosure;
  originalWrites: string[];
  controller: AbortController;
  signal: AbortSignal;
  binding: object;
  instanceId?: string;
  live?: LiveHandle;
  dispatch?: DispatchSnapshot;
  diagnostic?: string;
  proposals: ScopeProposal[];
  observations: Map<string, HeadRunIdentity>;
  onRevision?: (revision: number) => void;
}

/** Borrowed by one native leaf only. Neither run nor ownership comes from tool input. */
export class LeafScopeAttachment {
  constructor(private runtime: HeadDagRuntime, private attempt: HeadAttempt) {}
  bindRevision(sink: (revision: number) => void): void { this.attempt.onRevision = sink; }
  assertStartup(): void { this.runtime.checkAdmission(this.attempt); }
  beginPrompt(sessionId: string): void { this.runtime.beginPrompt(this.attempt, sessionId); }
  get managed(): ManagedAssignment | undefined { return this.runtime.managed; }
  get originalWrites(): readonly string[] { return [...this.attempt.originalWrites]; }
  checkManaged(sessionId: string): number {
    this.runtime.checkLeaf(this.attempt, sessionId);
    return this.attempt.effectiveRevision;
  }
  get runId(): string { return this.attempt.runId; }
  get effectiveRevision(): number { return this.attempt.effectiveRevision; }
  current(sessionId: string) {
    this.runtime.checkLeaf(this.attempt, sessionId);
    return { runId: this.attempt.runId, effectiveRevision: this.attempt.effectiveRevision,
      contract: this.runtime.contract(this.attempt.nodeId),
      proposals: this.attempt.proposals.filter(proposal => proposal.state === "proposed").map(proposal => structuredClone({
        proposalId: proposal.proposalId, effectiveRevision: proposal.effectiveRevision,
        contract: proposal.next, progress: proposal.progress, acknowledgment: proposal.acknowledgment,
      })) };
  }
  acknowledge(sessionId: string, proposalId: string, effectiveRevision: number, accept: boolean,
    progress: string[], nativeEntries: readonly { id: string }[]) {
    this.runtime.checkLeaf(this.attempt, sessionId);
    evidenceRefs(progress);
    if (!progress.every(ref => nativeEntries.some(entry => entry.id === ref))) throw new Error("acknowledgment progress is not observed in this native branch");
    const proposal = this.attempt.proposals.find(item => item.proposalId === proposalId);
    if (!proposal || proposal.state !== "proposed" || proposal.acknowledgment ||
        proposal.effectiveRevision !== effectiveRevision || effectiveRevision !== this.attempt.effectiveRevision ||
        proposal.native.sessionId !== sessionId || proposal.native.historyId !== this.attempt.live?.historyId ||
        !["queued", "handled"].includes(String(proposal.receipt?.status))) {
      throw new Error("stale, foreign, or uncommunicated scope proposal");
    }
    proposal.acknowledgment = { accept, progress: [...progress] };
    if (!accept) proposal.state = "invalidated";
    this.runtime.changed("scope_ack", this.attempt);
    return { proposalId, acknowledgment: structuredClone(proposal.acknowledgment), confirmed: false };
  }
}

/** Owns only this assignment's leaf reservations and producers, never the foreground singleton. */
export class HeadDagRuntime {
  readonly graph: HeadGraph;
  readonly maxParallel: number;
  private config: PitakoConfig;
  private attempts = new Map<string, HeadAttempt>();
  private events: Array<{ sequence: number; kind: string; runId?: string; effectiveRevision?: number }> = [];
  private sequence = 0;
  private waiters = new Set<() => void>();
  private barrier?: { epoch: string; revision: number; before: Set<string> };
  private finished?: HeadFinish;
  private corrections = 0;
  private correctionKey?: string;
  private repeatedFinals = 0;
  private peak = 0;
  private startedAt = Date.now();
  private diagnostics?: (kind: string, data: unknown) => void;
  get finishStatus(): HeadFinish["status"] | undefined { return this.finished?.status; }
  get managed(): ManagedAssignment | undefined { return this.owner.managed; }

  checkCheckpointRevision(revision: number): void {
    if (this.finished) throw new Error("Head already finished");
    if (revision !== this.graph.revision) throw new Error("stale checkpoint revision");
  }
  assertCheckpointReady(binding: object, revision: number): void {
    this.owner.check(binding);
    this.owner.managed?.assertIdle();
    this.checkCheckpointRevision(revision);
    if (this.active().length || this.closureFailures().length) throw new Error("checkpoint requires physically released leaf attempts");
  }

  constructor(private owner: HeadAttachment, private options: HeadDagOptions) {
    this.config = structuredClone(options.config);
    this.maxParallel = this.config.headDeveloper.maxParallel;
    if (!Number.isSafeInteger(this.maxParallel) || this.maxParallel <= 0) throw new Error("invalid Head parallel limit");
    this.graph = new HeadGraph(owner.executionRoot, options.writes);
  }
  get configSnapshot(): PitakoConfig { return this.config; }
  bindDiagnostics(sink: (kind: string, data: unknown) => void): void {
    this.diagnostics = sink;
  }
  private record(kind: string, data: unknown): void { this.diagnostics?.(kind, structuredClone(data)); }
  private active(): HeadAttempt[] { return [...this.attempts.values()].filter(run => run.closure.state !== "released"); }
  private activeNodes(): Set<string> { return new Set(this.active().map(run => run.nodeId)); }
  private run(runId: string, effectiveRevision: number): HeadAttempt {
    const run = this.attempts.get(runId);
    if (!run || run.effectiveRevision !== effectiveRevision || this.graph.get(run.nodeId).revision !== effectiveRevision) {
      throw new Error("stale or foreign Head run identity");
    }
    return run;
  }
  private liveRun(identity: HeadRunIdentity): HeadAttempt {
    const run = this.run(identity.runId, identity.effectiveRevision);
    if (!run.live || run.live.historyId !== identity.historyId || run.live.sessionId !== identity.sessionId ||
        run.phase !== "running" || run.signal.aborted || run.live.observe().active !== true) {
      throw new Error("stale or inactive native leaf identity");
    }
    return run;
  }
  checkLeaf(run: HeadAttempt, sessionId: string): void {
    if (this.attempts.get(run.runId) !== run || run.signal.aborted || run.phase !== "running" ||
        !run.live || run.live.sessionId !== sessionId || run.live.observe().active !== true) {
      throw new Error("leaf scope binding is retired");
    }
  }
  checkAdmission(run: HeadAttempt): void {
    if (run.phase === "startup") this.checkStart(run);
    else {
      this.owner.check(run.binding);
      if (run.phase !== "running" || run.signal.aborted ||
          this.graph.get(run.nodeId).revision !== run.effectiveRevision) throw new Error("Head leaf startup cancelled");
    }
  }
  beginPrompt(run: HeadAttempt, sessionId: string): void {
    this.checkAdmission(run);
    const native = run.live?.observe().native as { sessionId?: string } | undefined;
    if (!run.live || run.live.sessionId !== sessionId || native?.sessionId !== sessionId) {
      throw new Error("leaf scope binding is retired");
    }
    // Native binding is not execution. Keep startup authority until the synchronous prompt boundary.
    if (run.phase === "startup") {
      run.phase = "running";
      this.changed("running", run);
    }
  }
  contract(nodeId: string) {
    const node = this.graph.get(nodeId);
    return { ...node, writes: node.writes.map(write => pathRelative(this.graph.root, write)) };
  }
  snapshot(binding: object) {
    this.owner.check(binding);
    return { ...this.graph.snapshot(), maxParallel: this.maxParallel,
      ...(this.owner.managed ? { managed: this.owner.managed.snapshot() } : {}),
      barrier: this.barrier ? { epoch: this.barrier.epoch, revision: this.barrier.revision } : undefined,
      runs: [...this.attempts.values()].map(run => this.result(binding, run.runId)) };
  }
  plan(binding: object, transaction: HeadTransaction) {
    this.owner.check(binding);
    this.owner.managed?.assertIdle();
    this.assertOpen();
    this.graph.transact(transaction, this.activeNodes());
    this.invalidateProposals();
    this.changed("plan");
    return this.snapshot(binding);
  }
  start(binding: object, expectedRevision: number, nodeIds: string[], toolCallId: string,
    ctx: ExtensionContext, pi: Pick<ExtensionAPI, "appendEntry">, signal?: AbortSignal) {
    this.owner.check(binding);
    this.owner.managed?.assertWritable();
    this.assertOpen();
    if (signal?.aborted || expectedRevision !== this.graph.revision) throw new Error("stale or cancelled Head start");
    if (!nodeIds.length || new Set(nodeIds).size !== nodeIds.length) throw new Error("invalid Head start batch");
    const active = this.active();
    if (active.length + nodeIds.length > this.maxParallel) throw new Error("Head parallel limit is occupied");
    const nodes = nodeIds.map(id => this.graph.get(id));
    for (const [index, node] of nodes.entries()) {
      if (!this.graph.ready(node.id) || active.some(run => run.nodeId === node.id) ||
          [...this.attempts.values()].some(run => run.nodeId === node.id && run.effectiveRevision === node.revision)) {
        throw new Error("Head node is not ready for a new attempt");
      }
      // Recanonicalize at admission too: filesystem aliases may have changed since plan.
      const writes = this.graph.canonicalWrites(node.writes.map(write => pathRelative(this.graph.root, write)), true);
      if (JSON.stringify(writes) !== JSON.stringify(node.writes)) throw new Error("declared writes changed canonical identity");
      if (active.some(run => writesConflict(node.writes, run.originalWrites)) ||
          nodes.slice(0, index).some(other => writesConflict(node.writes, other.writes))) {
        throw new Error("Head write reservations conflict");
      }
    }
    // All validation precedes mutation; every reservation precedes the first asynchronous preflight.
    const runs = nodes.map(node => {
      const controller = new AbortController();
      const run: HeadAttempt = { runId: randomUUID(), nodeId: node.id, admittedRevision: node.revision,
        effectiveRevision: node.revision, graphRevision: expectedRevision, phase: "preflight",
        closure: { state: "pending" }, originalWrites: [...node.writes], controller,
        signal: AbortSignal.any([controller.signal, this.owner.signal, ...(signal ? [signal] : [])]),
        binding, proposals: [], observations: new Map() };
      return run;
    });
    for (const run of runs) this.brief(run); // An oversized effective context rejects the whole batch.
    for (const run of runs) this.attempts.set(run.runId, run);
    this.owner.admitted();
    for (const run of runs) {
      this.changed("reserved", run);
      const operation = this.owner.own(binding, () => this.dispatch(run, toolCallId, ctx, pi));
      // The operation may be fenced before its callback starts. Only its own unstarted reservation is released.
      void operation.catch(error => {
        if (!run.instanceId && run.closure.state === "pending") this.closed(run, error);
      });
    }
    return runs.map(run => this.result(binding, run.runId));
  }
  private checkStart(run: HeadAttempt): void {
    this.owner.check(run.binding);
    if (run.signal.aborted || run.graphRevision !== this.graph.revision ||
        run.effectiveRevision !== this.graph.get(run.nodeId).revision) throw new Error("Head start authority changed after reservation");
    const writes = this.graph.canonicalWrites(run.originalWrites.map(write => pathRelative(this.graph.root, write)), true);
    if (JSON.stringify(writes) !== JSON.stringify(run.originalWrites)) throw new Error("Head writes changed canonical identity");
  }
  private brief(run: HeadAttempt): string {
    const node = this.contract(run.nodeId);
    const dependencies = node.deps.map(id => {
      const dep = this.graph.get(id);
      return { id, revision: dep.revision, contract: dep.brief, evidence: dep.review?.evidence ?? [] };
    });
    const task = JSON.stringify({ runId: run.runId, effectiveRevision: run.effectiveRevision,
      brief: node.brief, writes: node.writes, dependencies,
      obligations: "Use Ponytail and verify-behavior. Do not start unmanaged external writing work. Scope changes require head_scope_ack and Head confirmation; read head_scope_ack current for the effective contract." });
    boundedText(task, "effective leaf brief", 64 * 1024);
    return task;
  }
  private async dispatch(run: HeadAttempt, toolCallId: string, ctx: ExtensionContext, pi: Pick<ExtensionAPI, "appendEntry">) {
    try {
      this.checkStart(run);
      const task = this.brief(run);
      run.dispatch = await (this.options.preflight ?? developerCapacityPreflight)({
        task, capacity: this.graph.get(run.nodeId).capacity, config: this.config, toolCallId,
        source: "head_start", ctx, pi, signal: run.signal,
        owns: () => { try { this.checkStart(run); return true; } catch { return false; } },
      });
      this.checkStart(run); // A snapshot is a policy choice, never authority to start.
      run.phase = "startup";
      this.changed("startup", run);
      const scope = new LeafScopeAttachment(this, run);
      const executor: AttemptExecutor = {
        capturesHistory: this.options.executor.capturesHistory,
        capturesPublicConversation: this.options.executor.capturesPublicConversation,
        start: input => {
          this.checkAdmission(run);
          return this.options.executor.start({ ...input, scope,
            bindLive: live => {
              if (run.signal.aborted) throw new Error("Head leaf binding cancelled");
              this.invalidateRunProposals(run);
              run.live = live;
              return () => {
                if (run.live === live) { run.live = undefined; this.invalidateRunProposals(run); }
              };
            } });
        },
      };
      await this.owner.startChild(run.runId, () => {
        this.checkStart(run); // Includes the interval in the T1 admission microtask.
        return runAgentInstance({ roleId: "developer", task, cwd: this.owner.executionRoot,
          executionRoot: this.owner.executionRoot, signal: run.signal, dispatch: run.dispatch, executor,
          historyOrigin: { source: "agent_spawn", coordinatorSessionId: ctx.sessionManager?.getSessionId?.(),
            assignmentId: this.owner.assignmentId, head: { assignmentId: this.owner.assignmentId,
              headInstanceId: this.owner.headInstanceId, nodeId: run.nodeId, runId: run.runId,
              admittedRevision: run.admittedRevision, effectiveRevision: run.effectiveRevision } },
          onAccepted: instance => { run.instanceId = instance.id; } });
      }, () => ({ nodeId: run.nodeId, admittedRevision: run.admittedRevision, effectiveRevision: run.effectiveRevision }));
      this.closed(run);
    } catch (error) { this.closed(run, error); }
  }
  private closed(run: HeadAttempt, error?: unknown): void {
    if (run.closure.state !== "pending") return;
    this.invalidateRunProposals(run);
    run.live = undefined;
    run.diagnostic = error === undefined ? undefined : String(error);
    run.closure = error instanceof AgentClosureError ? { state: "unknown", reason: String(error) } : { state: "released" };
    run.phase = run.closure.state === "unknown" ? "unknown" : "closed";
    this.changed("closed", run);
  }
  result(binding: object, runId: string) {
    this.owner.check(binding);
    const run = this.attempts.get(runId);
    if (!run) throw new Error("unknown Head run");
    const envelope = run.instanceId ? this.owner.result(binding, runId) : undefined;
    return structuredClone({ runId, nodeId: run.nodeId, instanceId: run.instanceId,
      admittedRevision: run.admittedRevision, effectiveRevision: run.effectiveRevision, phase: run.phase,
      closure: run.closure, originalWrites: run.originalWrites, diagnostic: run.diagnostic,
      native: run.live ? { historyId: run.live.historyId, sessionId: run.live.sessionId } : undefined,
      dispatch: run.dispatch, proposals: run.proposals, envelope });
  }
  observe(binding: object, identity: HeadRunIdentity, options?: ActivityReadOptions) {
    this.owner.check(binding);
    const run = this.liveRun(identity);
    const activity = run.live!.observe(options);
    this.owner.check(binding);
    this.liveRun(identity);
    const observationId = randomUUID();
    run.observations.set(observationId, { runId: identity.runId, effectiveRevision: identity.effectiveRevision,
      historyId: identity.historyId, sessionId: identity.sessionId });
    return { observationId, effectiveRevision: run.effectiveRevision, contract: this.contract(run.nodeId), activity };
  }
  input(binding: object, identity: HeadRunIdentity, intent: "query" | "steer", text: string, decisionId?: string) {
    this.owner.check(binding);
    const run = this.liveRun(identity);
    boundedText(text, "leaf input");
    return this.owner.own(binding, async () => {
      this.liveRun(identity);
      const receipt = await run.live!.input({ ...identity, intent, text, decisionId });
      this.owner.check(binding);
      return receipt; // Producer receipts are not scope acknowledgment or evidence of behavior.
    });
  }
  review(binding: object, runId: string, effectiveRevision: number, judgment: "satisfied" | "rejected",
    evidence: string[], reason: string, closureConcern?: string) {
    this.owner.check(binding);
    this.owner.managed?.assertIdle();
    const run = this.run(runId, effectiveRevision);
    if (run.phase !== "closed" || run.closure.state !== "released") throw new Error("Head review requires physical closure");
    if (closureConcern) {
      boundedText(closureConcern, "closure concern");
      run.closure = { state: "unknown", reason: closureConcern }; run.phase = "unknown";
      this.changed("closure_unknown", run);
      return this.result(binding, runId);
    }
    if (judgment === "satisfied" && this.owner.result(binding, runId)?.result.status !== "completed") {
      throw new Error("only a completed closed result can satisfy work");
    }
    this.graph.review(run.nodeId, effectiveRevision, judgment, { runId, effectiveRevision, evidence, reason });
    this.changed("review", run);
    return this.snapshot(binding);
  }
  propose(binding: object, identity: HeadRunIdentity, expectedRevision: number,
    next: HeadNodeSpec, additions: HeadNodeSpec[], progress: string[]) {
    this.owner.check(binding);
    this.owner.managed?.assertWritable();
    this.assertOpen();
    const run = this.liveRun(identity);
    evidenceRefs(progress);
    if (!progress.every(ref => {
      const observed = run.observations.get(ref);
      return observed && observed.runId === identity.runId && observed.effectiveRevision === identity.effectiveRevision &&
        observed.historyId === identity.historyId && observed.sessionId === identity.sessionId;
    })) throw new Error("scope proposal requires this run's observed progress");
    const current = this.graph.get(run.nodeId);
    if (next.id !== current.id || JSON.stringify(next.deps) !== JSON.stringify(current.deps) ||
        JSON.stringify(next.capacity) !== JSON.stringify(current.capacity)) throw new Error("active adjustment cannot replace dependencies or capacity");
    const writes = this.graph.canonicalWrites(next.writes, true);
    if (writes.some(write => !run.originalWrites.some(original => contains(original, write)))) {
      throw new Error("active scope cannot enlarge the donor's original reservation; add another node");
    }
    this.graph.transact({ expectedRevision, nodes: [next, ...additions], supersede: [] },
      this.activeNodes(), { id: run.nodeId, revision: run.effectiveRevision }, true);
    if (run.proposals.some(proposal => proposal.state === "proposed")) throw new Error("scope proposal already pending");
    const proposal: ScopeProposal = { proposalId: randomUUID(), expectedRevision, effectiveRevision: run.effectiveRevision,
      next: structuredClone(next), additions: structuredClone(additions), progress: [...progress],
      native: { historyId: identity.historyId, sessionId: identity.sessionId }, state: "proposed" };
    run.proposals.push(proposal);
    this.changed("scope_proposed", run);
    return this.owner.own(binding, async () => {
      this.liveRun(identity);
      proposal.receipt = await run.live!.input({ ...identity, intent: "steer",
        text: `Scope proposal (not confirmed): ${JSON.stringify({ proposalId: proposal.proposalId,
          effectiveRevision: proposal.effectiveRevision, contract: proposal.next, progress: proposal.progress })}`,
        decisionId: proposal.proposalId });
      this.owner.check(binding);
      this.liveRun(identity);
      return structuredClone(proposal);
    });
  }
  confirm(binding: object, identity: HeadRunIdentity, proposalId: string) {
    this.owner.check(binding);
    this.owner.managed?.assertIdle();
    this.assertOpen();
    const run = this.liveRun(identity);
    const proposal = run.proposals.find(item => item.proposalId === proposalId);
    if (!proposal || proposal.state !== "proposed" || !proposal.acknowledgment?.accept ||
        proposal.effectiveRevision !== run.effectiveRevision || proposal.native.sessionId !== identity.sessionId ||
        proposal.native.historyId !== identity.historyId) throw new Error("scope proposal is stale or not acknowledged");
    const revision = this.graph.transact({ expectedRevision: proposal.expectedRevision,
      nodes: [proposal.next, ...proposal.additions], supersede: [] }, this.activeNodes(),
    { id: run.nodeId, revision: run.effectiveRevision });
    run.effectiveRevision = revision;
    run.onRevision?.(revision);
    proposal.state = "confirmed";
    this.invalidateProposals();
    this.changed("scope_confirmed", run);
    // The leaf's host-only scope tool exposes the current effective contract; no transcript replay is required.
    return { effectiveRevision: revision, contract: this.contract(run.nodeId), graph: this.snapshot(binding) };
  }
  cancel(binding: object, runIds: string[]) {
    this.owner.check(binding);
    const runs = runIds.map(id => {
      const run = this.attempts.get(id);
      if (!run) throw new Error("unknown Head run");
      return run;
    });
    for (const run of runs) if (run.closure.state === "pending") {
      run.phase = "cancelling"; this.invalidateRunProposals(run); run.controller.abort(); this.changed("cancelling", run);
    }
    return this.snapshot(binding);
  }
  changed(kind: string, run?: HeadAttempt): void {
    if (kind === "running") this.peak = Math.max(this.peak, this.active().filter(run => run.phase === "running").length);
    const event = { sequence: ++this.sequence, kind, runId: run?.runId, effectiveRevision: run?.effectiveRevision };
    this.events.push(event);
    this.record(kind, { ...event, graphRevision: this.graph.revision,
      ...(run ? { nodeId: run.nodeId, phase: run.phase, closure: run.closure, proposals: run.proposals } : {}) });
    if (this.events.length > 512) this.events.shift();
    for (const wake of [...this.waiters]) wake();
  }
  async wait(binding: object, after: number, signal?: AbortSignal) {
    this.owner.check(binding);
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence) throw new Error("invalid Head event cursor");
    if (signal?.aborted) throw new Error("Head wait cancelled");
    if (after === this.sequence) await new Promise<void>(resolve => {
      const done = () => { this.waiters.delete(done); signal?.removeEventListener("abort", done); resolve(); };
      this.waiters.add(done); signal?.addEventListener("abort", done, { once: true });
    });
    this.owner.check(binding);
    if (signal?.aborted) throw new Error("Head wait cancelled");
    const events = this.events.filter(event => event.sequence > after);
    const outcomes = [...new Set(events.filter(event => event.kind === "closed" || event.kind === "closure_unknown")
      .flatMap(event => event.runId ? [event.runId] : []))].map(runId => this.result(binding, runId));
    return { cursor: this.sequence, events,
      gap: after < (this.events[0]?.sequence ?? 1) - 1 ? "Earlier events omitted" : undefined,
      outcomes };
  }
  private invalidateRunProposals(run: HeadAttempt): void {
    for (const proposal of run.proposals) if (proposal.state === "proposed") proposal.state = "invalidated";
  }
  invalidateProposals(): void { for (const run of this.attempts.values()) this.invalidateRunProposals(run); }
  revoke(): void {
    this.invalidateProposals();
    for (const run of this.active()) { run.phase = "cancelling"; run.controller.abort(); }
    for (const wake of [...this.waiters]) wake();
  }
  closureFailures(): Error[] {
    return this.active().map(run => new Error(`Head run ${run.runId} closure ${run.closure.state}: ${run.closure.state === "unknown" ? run.closure.reason : "unsettled"}`));
  }

  private assertOpen(): void {
    if (this.barrier || this.finished) throw new Error("Head admissions closed; reopen integration before changing work");
  }
  beginIntegration(binding: object, expectedRevision: number, entries: readonly { id: string }[]) {
    this.owner.check(binding);
    this.owner.managed?.assertIdle();
    this.assertOpen();
    if (expectedRevision !== this.graph.revision) throw new Error("stale Head integration revision");
    if (this.active().length || this.owner.ownedOperations || this.closureFailures().length ||
        this.graph.snapshot().nodes.some(node => !["satisfied", "superseded"].includes(node.judgment))) {
      throw new Error("Head integration requires satisfied work and physical closure of every owned operation");
    }
    this.owner.admitted(); // Integration effects must never permit initial-prompt replay.
    this.owner.managed?.inventory.observe();
    this.barrier = { epoch: randomUUID(), revision: this.graph.revision, before: new Set(entries.map(entry => entry.id)) };
    this.changed("integration_barrier");
    this.record("barrier", { epoch: this.barrier.epoch, revision: this.barrier.revision });
    return { epoch: this.barrier.epoch, revision: this.barrier.revision };
  }
  reopen(binding: object, epoch: string) {
    this.owner.check(binding);
    this.owner.managed?.assertIdle();
    if (!this.barrier || this.barrier.epoch !== epoch) throw new Error("stale Head integration epoch");
    this.barrier = undefined;
    this.finished = undefined;
    this.owner.managed?.inventory.observe();
    this.changed("integration_reopened");
    return this.snapshot(binding);
  }
  codingAllowed(binding: object): boolean {
    this.owner.check(binding);
    return Boolean(this.barrier && !this.finished && !this.active().length);
  }
  verificationEntries(binding: object, entries: ReturnType<SessionManager["getBranch"]>) {
    this.owner.check(binding);
    const barrier = this.barrier;
    if (!barrier) return [];
    return entries.flatMap(entry => entry.type === "message" && !barrier.before.has(entry.id) &&
      entry.message.role === "toolResult" && !entry.message.isError && !entry.message.toolName.startsWith("head_")
      ? [{ entryId: entry.id, toolCallId: entry.message.toolCallId, toolName: entry.message.toolName }] : []);
  }
  async finish(binding: object, finish: HeadFinish, entries: ReturnType<SessionManager["getBranch"]>) {
    this.owner.check(binding);
    if (this.finished) throw new Error("Head already finished");
    for (const limit of finish.limits) boundedText(limit, "Head limit");
    if (finish.limits.length > 32) throw new Error("too many Head limits");
    if (finish.status === "completed") {
      this.owner.managed?.assertIdle();
      boundedText(finish.summary, "integrated summary");
      evidenceRefs(finish.verification);
      const barrier = this.barrier;
      if (!barrier || barrier.epoch !== finish.epoch || barrier.revision !== this.graph.revision ||
          this.active().length || this.owner.ownedOperations) throw new Error("stale or unavailable Head integration barrier");
      const observed = new Set(this.verificationEntries(binding, entries).map(entry => entry.entryId));
      if (!finish.verification.every(ref => observed.has(ref))) {
        throw new Error("verification must reference successful native tool results in this Head after this barrier");
      }
      this.finished = structuredClone(finish);
    } else {
      boundedText(finish.diagnostic, "Head failure diagnostic");
      for (const ref of finish.evidence) boundedText(ref, "diagnostic evidence reference", 1024);
      // Failure is an integrated diagnostic, not permission to abandon active children.
      await this.owner.close();
      this.finished = structuredClone(finish);
    }
    this.record("finish", this.finished);
    return structuredClone(this.finished);
  }
  boundary(binding: object, entries: NonNullable<AgentBeforeSettleEventResult["entries"]>,
    manager: Pick<SessionManager, "getBranch">): AgentBeforeSettleEventResult | undefined {
    this.owner.check(binding);
    if (this.finished) return entries.length ? { entries } : undefined;
    const key = `${this.graph.revision}:${this.sequence}`;
    this.repeatedFinals = key === this.correctionKey ? this.repeatedFinals + 1 : 1;
    this.correctionKey = key;
    // A new graph/event may justify correction, but never an unbounded automatic loop.
    if (++this.corrections > 8 || this.repeatedFinals > 2) {
      this.record("invalid_final", { graphRevision: this.graph.revision, diagnostic: "Head finalized repeatedly without head_finish" });
      return;
    }
    const correctionId = `head-finish-required:${this.owner.assignmentId}:${key}`;
    const incorporated = manager.getBranch().some(entry => entry.type === "custom_message" &&
      entry.customType === "pitako.head.finish-required" && entry.details &&
      typeof entry.details === "object" && "correctionId" in entry.details && entry.details.correctionId === correctionId);
    this.owner.check(binding);
    entries.push({ type: "custom_message", customType: "pitako.head.finish-required",
      content: "Final text is not a Head outcome. Inspect closed results, explicitly review retained work, beginIntegration, integrate and verify, then head_finish. Use failed head_finish for a diagnostic. Do not poll.",
      display: true, details: { correctionId, revision: this.graph.revision,
        deliveryGap: incorporated ? undefined : "Not observed in the current native branch" } });
    return { entries, continue: true };
  }
  handoff(result: AgentRunResult): HeadHandoff {
    const leaves = [...this.attempts.values()].map(run => {
      // Reading closure results during retirement does not borrow a native capability.
      const envelope = this.owner.closedOutcome(run.runId);
      return { runId: run.runId, nodeId: run.nodeId, instanceId: run.instanceId,
        admittedRevision: run.admittedRevision, effectiveRevision: run.effectiveRevision,
        status: envelope?.result.status, closure: structuredClone(run.closure), diagnostic: run.diagnostic, usage: envelope?.result.usage };
    });
    const usages = [result.usage, ...leaves.map(leaf => leaf.usage)];
    const numeric = ["input", "output", "cacheRead", "cacheWrite", "total", "cost", "turns", "toolCalls"] as const;
    const classifierUsage = [...this.attempts.values()].flatMap(run => run.dispatch?.routing.request ? [{
      dispatchId: run.dispatch.routing.dispatchId, usage: run.dispatch.routing.response?.usage ?? null,
    }] : []);
    const aggregateClassifierUsage: Partial<AgentUsage> = {};
    const classifierFields = ["input", "output", "cacheRead", "cacheWrite", "total", "cost"] as const;
    for (const field of classifierFields) {
      const values = classifierUsage.map(item => field === "total" ? item.usage?.totalTokens :
        field === "cost" ? item.usage?.cost?.total : item.usage?.[field]);
      if (values.length && values.every(value => value !== undefined)) {
        aggregateClassifierUsage[field] = values.reduce<number>((sum, value) => sum + value!, 0);
      }
    }
    const aggregateUsage: Partial<AgentUsage> = {};
    for (const field of numeric) {
      if (usages.every(usage => usage?.[field] !== undefined) &&
          (!classifierUsage.length || field === "turns" || field === "toolCalls" || aggregateClassifierUsage[field] !== undefined)) {
        aggregateUsage[field] = usages.reduce((sum, usage) => sum + usage![field]!, 0) + (aggregateClassifierUsage[field] ?? 0);
      }
    }
    return { assignmentId: this.owner.assignmentId, headInstanceId: this.owner.headInstanceId, revision: this.graph.revision,
      ...(this.owner.managed ? { managed: this.owner.managed.snapshot() } : {}),
      finish: (result.status === "completed" || this.finished?.status === "failed" ? this.finished : undefined) ??
        { status: "failed", diagnostic: result.status === "completed"
        ? "Head returned without head_finish" : result.result, evidence: [], limits: ["No integrated finish was observed"] },
      barrier: this.barrier ? { epoch: this.barrier.epoch, revision: this.barrier.revision } : undefined,
      leaves, metrics: { ownUsage: result.usage,
        aggregateUsage: aggregateUsage.input !== undefined && aggregateUsage.output !== undefined
          ? { ...aggregateUsage, input: aggregateUsage.input, output: aggregateUsage.output } : undefined,
        aggregateClassifierUsage: classifierUsage.length ? aggregateClassifierUsage : undefined,
        usageComplete: numeric.every(field => usages.every(usage => usage?.[field] !== undefined)) &&
          (!classifierUsage.length || classifierFields.every(field => aggregateClassifierUsage[field] !== undefined)),
        classifierUsage,
        elapsedMs: Date.now() - this.startedAt, observedPeakParallelism: this.peak } };
  }
}
