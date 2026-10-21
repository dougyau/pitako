import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import type { AgentSession, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { offerEnvelope, type DeliveryProgress } from "../delivery.ts";
import { Type } from "typebox";
import { contains } from "./graph.ts";
import { mutationGeneration, reserveOperation } from "./operation-leases.ts";
import { AgentClosureError, hasUnknownClosure, joinedClosureObservation, type ClosureObservation } from "../closure.ts";
import type { ManagedAssignment } from "./managed-tools.ts";
import { ownProcess } from "./owned-process.ts";

export interface VerificationGrantInput { durationMs: number; captureBytes: number; invocations: number; artifactRoots: string[]; scratchRoots: string[] }
export const verificationSchema = Type.Optional(Type.Object({
  durationMs: Type.Number({ exclusiveMinimum: 0, maximum: 2147483647 }),
  captureBytes: Type.Integer({ minimum: 1, maximum: 1073741824 }),
  invocations: Type.Integer({ minimum: 1, maximum: 32 }),
  artifactRoots: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 16 }),
  scratchRoots: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 16 }),
}, { additionalProperties: false }));
export function validateVerification(input: VerificationGrantInput): VerificationGrantInput {
  for (const [key, max] of [["durationMs", 2147483647], ["captureBytes", 1073741824], ["invocations", 32]] as const) {
    if (!Number.isFinite(input[key]) || input[key] <= 0 || input[key] > max || key !== "durationMs" && !Number.isSafeInteger(input[key])) throw new Error(`invalid verification ${key}`);
  }
  for (const roots of [input.artifactRoots, input.scratchRoots]) {
    if (!Array.isArray(roots) || roots.length > 16) throw new Error("explicit finite artifact/scratch roots required");
    for (const root of roots) if (!root || path.isAbsolute(root) || root === "." || root.split(/[\\/]/).some(p => p === ".." || p === ".git" || p === "node_modules") || root.includes("\0")) throw new Error("invalid verification artifact/scratch root");
  }
  return structuredClone(input);
}
export interface GateCommand { id: string; shell: string; cwd: string; env: Record<string, string>; timeoutMs: number }
export interface GateRequest { epoch: string; expectedRevision: number; commands: GateCommand[]; coverage: string }
export interface CandidateIdentity { assignmentId: string; bindingId: string; epoch: string; revision: number; generation: number; fingerprint: string; basis: string; exclusions: string[] }
type Outcome = "passed" | "failed" | "cancelled" | "timed-out" | "no-process" | "incomplete" | "unknown";
type CommandResult = { id: string; cwd: string; shell: string; envKeys: string[]; state: Outcome | "unrun"; exitCode?: number | null; signal?: string | null; startedAt?: number; closedAt?: number; artifacts: string[]; diagnostic?: string };
export function processGroupClosed(pid: number): boolean {
  try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
export interface GateEnvelope {
  deliveryId: string; assignmentId: string; runId: string; candidate?: CandidateIdentity;
  requestDigest: string; guideDigest?: string; coverage: string; outcome: Outcome; closure: "released" | "unknown";
  commands: CommandResult[]; artifacts: Array<{ id: string; bytes: number; tail: string }>; diagnostic?: string; bytes: number; complete: boolean; stale: boolean; limits: string[];
}
interface GateRun {
  runId: string; binding: object; bindingId: string; request: GateRequest; controller: AbortController;
  deadlineAt: number; phase: "preparing" | "running" | "cancelling" | "closed" | "unknown";
  lease: ReturnType<typeof reserveOperation>; candidate?: CandidateIdentity; envelope?: GateEnvelope;
  artifacts: Map<string, { file: string; bytes: number; tail: string }>; deliveryId?: string; activeDeadlineAt?: number; guideDigest?: string;
}
type Branch = ReturnType<SessionManager["getBranch"]>;
type NativeOwner = {
  session: AgentSession; manager: SessionManager; binding: object; sessionId: string; file: string | undefined;
  incarnation: object; retired: boolean; unsubscribe?: () => void;
};
type FinalMessageObservation = {
  message: Extract<SessionEntry, { type: "message" }>["message"]; ordinal: number; before: Set<string>;
};
type GateProof =
  | { kind: "native"; owner: NativeOwner; call: SessionEntry; callId: string; resultId: string; result: Extract<SessionEntry, { type: "message" }>;
      observation: FinalMessageObservation; wait: WaitInvocation }
  | { kind: "custom"; entryId: string; entry: Extract<SessionEntry, { type: "custom_message" }> };
export interface WaitInvocation {
  binding: object; toolCallId: string; ordinal: number; rawArguments: unknown; effectiveAfter: number;
  owner?: NativeOwner; returned: boolean; observation?: FinalMessageObservation;
  finalMessage?: FinalMessageObservation["message"];
  calls: SessionEntry[];
  emissions: GateWaitEmission[]; unavailable?: string;
}
type GateWaitEmission = { run: GateRun; record: GateDeliveryRecord; invocation: WaitInvocation; envelope: GateEnvelope; block: string };
interface GateDeliveryRecord {
  run: GateRun; progress: DeliveryProgress; availability?: string; pinnedWinner?: GateProof; consumed: boolean;
  offers: Array<{ before: Set<string>; content: string }>; emissions: GateWaitEmission[];
}
const gateBlock = (envelope: GateEnvelope) => `<pitako.head.gates.v1>\n${JSON.stringify(envelope)}\n</pitako.head.gates.v1>`;
interface GateOwner {
  assignmentId: string; executionRoot: string; signal: AbortSignal;
  managed?: Pick<ManagedAssignment, "unknown">;
  check(binding: object): void; admitted(): void; own<T>(binding: object, operation: () => Promise<T>): Promise<T>;
  gateEpoch(binding: object): { epoch: string; revision: number };
  gateIdle(binding: object): void; gateChanged(): void; gateUnknown(reason: string): void;
}
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const EXCLUSIONS = [".git", "node_modules", ".codegraph", ".pitako/runs", ".pitako/gates", ".pitako/sessions"];
/** All on-disk project inputs, not the contribution inventory. No project code is evaluated. */
export function candidateFingerprint(root: string, exclusions: string[]) {
  const h = createHash("sha256"); let files = 0, bytes = 0;
  function walk(relative: string) {
    if (exclusions.some(ex => relative === ex || relative.startsWith(ex + "/"))) return;
    const file = path.join(root, relative), stat = lstatSync(file);
    if (++files > 20000) throw new Error("candidate exceeds 20000 paths");
    h.update(JSON.stringify([relative, stat.mode]));
    if (stat.isSymbolicLink()) { h.update(readlinkSync(file)); return; }
    if (stat.isDirectory()) { for (const name of readdirSync(file).sort()) walk(relative ? relative + "/" + name : name); }
    else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 256 * 1024 * 1024) throw new Error("candidate exceeds 256MiB fingerprint budget");
      h.update(readFileSync(file));
    } else throw new Error(`unsupported candidate input: ${relative}`);
  }
  walk(""); return h.digest("hex");
}

/** Host-owned finite producer. Handles and control-tool results are never evidence. */
export class OwnedGates {
  private runs = new Map<string, GateRun>();
  // Lost records/accounts are unavailable, never reconstructed from outcomes or journals.
  private deliveries = new Map<string, GateDeliveryRecord>();
  private native?: NativeOwner;
  private waits: WaitInvocation[] = [];
  private ordinal = 0;
  private bindings = new WeakMap<object, string>();
  private env = { ...process.env };
  private used = 0;
  private bytes = 0;
  private expires: number;
  private grant: VerificationGrantInput;
  constructor(private owner: GateOwner, grant: VerificationGrantInput, private evidenceRoot?: string,
    private io: { write: typeof writeSync; groupClosed(pid: number): boolean; leaderExit?(): void;
      close?: typeof closeSync; spawn?: typeof spawn; processHost?: Parameters<typeof ownProcess>[2] } = { write: writeSync, groupClosed: processGroupClosed }) {
    this.grant = validateVerification(grant);
    this.expires = Date.now() + grant.durationMs;
  }
  private exclusions() { return [...EXCLUSIONS, ...this.grant.artifactRoots, ...this.grant.scratchRoots]; }
  private check(run: GateRun, budget = true) {
    this.owner.check(run.binding);
    const epoch = this.owner.gateEpoch(run.binding);
    if (epoch.epoch !== run.request.epoch || epoch.revision !== run.request.expectedRevision || realpathSync(this.owner.executionRoot) !== this.owner.executionRoot) throw new Error("gate owner/candidate binding changed");
    if (run.controller.signal.aborted || this.owner.signal.aborted) throw new Error("gate cancelled");
    if (budget && Date.now() >= run.deadlineAt) throw new Error("gate budget expired");
  }
  request(binding: object, input: GateRequest) {
    this.owner.check(binding); this.owner.gateIdle(binding);
    const epoch = this.owner.gateEpoch(binding);
    if (input.epoch !== epoch.epoch || input.expectedRevision !== epoch.revision) throw new Error("stale gate epoch/revision");
    if (!input.coverage?.trim() || Buffer.byteLength(input.coverage) > 16384 || !Array.isArray(input.commands) || !input.commands.length || input.commands.length > 32) throw new Error("invalid gate selection/coverage");
    const ids = new Set<string>();
    for (const c of input.commands) {
      if (!c.id || c.id.length > 64 || ids.has(c.id) || !c.shell?.trim() || Buffer.byteLength(c.shell) > 16384 || c.shell.includes("\0") ||
          typeof c.cwd !== "string" || c.cwd.length > 4096 || path.isAbsolute(c.cwd) || c.cwd.split(/[\\/]/).includes("..") || c.cwd.includes("\0") ||
          !Number.isFinite(c.timeoutMs) || c.timeoutMs <= 0 || c.timeoutMs > 2147483647 || !c.env || Object.keys(c.env).length > 64 ||
          Object.entries(c.env).some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string" || v.includes("\0") || Buffer.byteLength(v) > 16384)) throw new Error("invalid gate command");
      ids.add(c.id);
    }
    if (this.used >= this.grant.invocations || this.bytes >= this.grant.captureBytes || Date.now() >= this.expires) throw new Error("verification grant exhausted");
    const lease = reserveOperation(this.owner.executionRoot, "gates");
    const bindingId = this.bindings.get(binding) ?? randomUUID(); this.bindings.set(binding, bindingId);
    const run: GateRun = { runId: randomUUID(), binding, bindingId, request: structuredClone(input), lease,
      controller: new AbortController(), deadlineAt: this.expires, phase: "preparing", artifacts: new Map() };
    this.runs.set(run.runId, run); this.used++; this.owner.admitted();
    // Reserve synchronously, but no preflight, filesystem or spawn until the next macrotask.
    void this.owner.own(binding, async () => { await new Promise<void>(resolve => setImmediate(resolve)); await this.execute(run); })
      .catch(error => { if (!run.envelope) this.noProcess(run, error); });
    return { runId: run.runId, assignmentId: this.owner.assignmentId, state: "preparing" };
  }
  private identity(run: GateRun): CandidateIdentity {
    return { assignmentId: this.owner.assignmentId, bindingId: run.bindingId, epoch: run.request.epoch, revision: run.request.expectedRevision,
      generation: mutationGeneration(this.owner.executionRoot), fingerprint: candidateFingerprint(this.owner.executionRoot, this.exclusions()),
      basis: "All files/modes and symlink text under physical execution root, including new/dirty inputs; symlink targets and external dependencies not certified", exclusions: this.exclusions() };
  }
  current(run: GateRun): boolean {
    try { this.check(run, false); return JSON.stringify(this.identity(run)) === JSON.stringify(run.candidate); } catch { return false; }
  }
  private noProcess(run: GateRun, error: unknown) {
    this.complete(run, { outcome: run.controller.signal.aborted || this.owner.signal.aborted ? "cancelled" : "no-process", closure: "released", diagnostic: String(error), commands: run.request.commands.map(c => ({ id: c.id, cwd: c.cwd, shell: c.shell, envKeys: Object.keys(c.env), state: "unrun", artifacts: [] })), bytes: 0, complete: false, stale: false });
  }
  private complete(run: GateRun, value: Omit<GateEnvelope, "deliveryId" | "assignmentId" | "runId" | "candidate" | "requestDigest" | "coverage" | "limits" | "artifacts">,
    observation?: ClosureObservation) {
    run.envelope = structuredClone({ ...value, deliveryId: randomUUID(), assignmentId: this.owner.assignmentId, runId: run.runId, candidate: run.candidate,
      requestDigest: hash(JSON.stringify(run.request)), coverage: run.request.coverage,
      guideDigest: run.guideDigest, artifacts: [...run.artifacts].map(([id, a]) => ({ id, bytes: a.bytes, tail: a.tail })),
      limits: ["POSIX cooperative process groups, not a sandbox or escaped/remote descendant confinement", "TERM then KILL after 250ms; closure observation bounded at 1500ms after cancellation", "No engine retries; selected commands only, manual obligations remain with Head and principal"] });
    run.phase = value.closure === "unknown" ? "unknown" : "closed";
    run.deliveryId = run.envelope.deliveryId;
    this.deliveries.set(run.deliveryId, { run, consumed: false, offers: [], emissions: [],
      progress: { delivery: "pending", continuation: "not-requested", deliveryAttempts: 0,
        wakeAttempts: 0, outstanding: false, busyContinuation: false } });
    if (value.closure === "unknown") {
      const reason = value.diagnostic ?? "gate closure unknown";
      run.lease.unknown(reason, observation);
      // Recovering physical exclusion must not rehabilitate this assignment.
      this.owner.managed?.unknown(new AgentClosureError([new Error(reason)], "owned gates"));
      this.owner.gateUnknown(reason);
    } else run.lease.release();
    this.owner.gateChanged();
  }
  private async execute(run: GateRun) {
    const results: CommandResult[] = run.request.commands.map(c => ({ id: c.id, cwd: c.cwd, shell: c.shell, envKeys: Object.keys(c.env), state: "unrun", artifacts: [] }));
    let outcome: Outcome = "no-process", diagnostic: string | undefined, closure: "released" | "unknown" = "released", bytes = 0;
    let observation: ClosureObservation | undefined, captureUnknown = false;
    try {
      this.check(run);
      if (process.platform === "win32") throw new Error("no POSIX owned process group support");
      run.guideDigest = existsSync(path.join(this.owner.executionRoot, "GATES.md")) ? hash(readFileSync(path.join(this.owner.executionRoot, "GATES.md"))) : undefined;
      this.check(run);
      const base = this.evidenceRoot ?? path.join(this.owner.executionRoot, ".pitako", "gates", hash(this.owner.assignmentId));
      let ancestor = path.resolve(base);
      while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
      if (contains(this.owner.executionRoot, path.resolve(base)) && !contains(this.owner.executionRoot, realpathSync(ancestor))) throw new Error("evidence directory escapes physical root");
      mkdirSync(base, { recursive: true }); this.check(run);
      const directory = mkdtempSync(path.join(base, "pitako-gates-")); this.check(run);
      run.candidate = this.identity(run); this.check(run);
      for (let i = 0; i < run.request.commands.length; i++) {
        const command = run.request.commands[i]!, result = results[i]!;
        this.check(run);
        const cwd = realpathSync(path.resolve(this.owner.executionRoot, command.cwd));
        if (!contains(this.owner.executionRoot, cwd)) throw new Error("gate cwd escapes physical execution root");
        const env = { ...this.env, ...command.env }; delete env.BASH_ENV; delete env.ENV;
        const fds: number[] = [];
        try {
          for (const stream of ["stdout", "stderr"]) {
            const id = `${i}-${stream}`, file = path.join(directory, id + ".log");
            fds.push(openSync(file, "wx", 0o600)); run.artifacts.set(id, { file, bytes: 0, tail: "" }); result.artifacts.push(id);
          }
          this.check(run); run.phase = "running"; result.startedAt = Date.now();
          const captured = await this.command(run, command, cwd, env, (stream, data) => {
            const remaining = this.grant.captureBytes - this.bytes;
            const chunk = data.subarray(0, Math.max(0, remaining));
            if (chunk.length) {
              let written = 0;
              while (written < chunk.length) {
                const count = this.io.write(fds[stream]!, chunk.subarray(written));
                if (count <= 0) throw new Error("gate capture made no progress");
                const a = run.artifacts.get(result.artifacts[stream]!)!;
                a.tail = (a.tail + chunk.subarray(written, written + count).toString("utf8")).slice(-2048);
                written += count; this.bytes += count; bytes += count; a.bytes += count;
              }
            }
            if (chunk.length !== data.length) throw new Error("gate capture cap exhausted");
          });
          Object.assign(result, captured.result, { closedAt: Date.now() }); outcome = captured.result.state; diagnostic = captured.result.diagnostic;
          if (outcome === "unknown") { closure = "unknown"; observation = captured.observation; }
        } finally {
          for (const fd of fds) try { (this.io.close ?? closeSync)(fd); } catch (error) {
            captureUnknown = true;
            closure = "unknown"; outcome = "unknown"; diagnostic = `Capture descriptor closure unknown: ${error}`;
          }
        }
        if (outcome !== "passed") break;
        this.check(run);
      }
    } catch (error) {
      diagnostic = String(error);
      outcome = run.controller.signal.aborted || this.owner.signal.aborted ? "cancelled" : Date.now() >= run.deadlineAt ? "timed-out" : outcome === "no-process" ? "no-process" : "incomplete";
    }
    if (closure === "unknown") outcome = "unknown";
    const stale = !!run.candidate && !this.current(run);
    if (outcome === "passed" && Date.now() >= run.deadlineAt) outcome = "timed-out";
    if (outcome === "passed" && stale) outcome = "incomplete";
    this.complete(run, { outcome, closure, commands: results, diagnostic, bytes, complete: outcome === "passed", stale },
      captureUnknown ? undefined : observation);
  }
  private async command(run: GateRun, command: GateCommand, cwd: string, env: NodeJS.ProcessEnv,
    capture: (stream: number, bytes: Buffer) => void) {
    const child = (this.io.spawn ?? spawn)("bash", ["--noprofile", "--norc", "-c", command.shell], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const host = this.io.processHost ?? {
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        if (signal !== 0) return process.kill(pid, signal);
        if (this.io.groupClosed(-pid)) throw Object.assign(new Error("owned group absent"), { code: "ESRCH" });
        return true;
      },
      schedule: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    };
    const timeout = new AbortController();
    const signal = AbortSignal.any([run.controller.signal, this.owner.signal, timeout.signal]);
    let timedOut = false, reported = false, captureFailure = false;
    const cancelling = () => { run.phase = "cancelling"; };
    signal.addEventListener("abort", cancelling, { once: true });
    if (signal.aborted) cancelling();
    run.activeDeadlineAt = Math.min(Date.now() + command.timeoutMs, run.deadlineAt);
    const deadline = host.schedule(() => { timedOut = true; timeout.abort(); }, Math.max(1, run.activeDeadlineAt - Date.now()));
    child.once("exit", () => { if (!reported) this.io.leaderExit?.(); });
    let state: Outcome, diagnostic: string | undefined, observation: ClosureObservation | undefined;
    try {
      const result = await ownProcess(child, { signal, onData: (data, stream) => {
        try { capture(stream, data); } catch (error) { captureFailure = true; cancelling(); throw error; }
      } }, host);
      state = result.exitCode === 0 ? "passed" : "failed";
    } catch (error) {
      if (hasUnknownClosure(error)) { state = "unknown"; observation = joinedClosureObservation([error]); }
      else state = captureFailure ? "incomplete" : timedOut ? "timed-out" :
        run.controller.signal.aborted || this.owner.signal.aborted ? "cancelled" : child.pid ? "incomplete" : "no-process";
      diagnostic = String(error);
    } finally {
      reported = true;
      host.clear(deadline);
      signal.removeEventListener("abort", cancelling);
    }
    return { result: { state, exitCode: child.exitCode ?? null, signal: child.signalCode ?? null, diagnostic }, observation };
  }
  private run(binding: object, id: string) { this.owner.check(binding); const run = this.runs.get(id); if (!run || run.binding !== binding) throw new Error("unknown/foreign gate run"); return run; }
  status(binding: object, id: string) {
    const r = this.run(binding, id);
    const proof = this.recordFor(r)?.pinnedWinner;
    return structuredClone({ runId: id, phase: r.phase, candidate: r.candidate, closure: r.envelope?.closure ?? "pending", outcome: r.envelope?.outcome,
      available: !!r.envelope, stale: !!r.envelope && !this.current(r),
      receipt: proof && (proof.kind === "native" ? proof.result.id : proof.entry.id),
      artifacts: [...r.artifacts].map(([id,a]) => ({ id, bytes: a.bytes, tail: a.tail })) });
  }
  cancel(binding: object, id: string) { const run = this.run(binding, id); run.controller.abort(); this.owner.gateChanged(); return this.status(binding, id); }
  read(binding: object, id: string, artifact: string, offset = 0, limit = 8192) {
    const r = this.run(binding, id), a = r.artifacts.get(artifact);
    if (!a || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16384) throw new Error("invalid gate artifact/page");
    const fd = openSync(a.file, "r"), page = Buffer.alloc(Math.min(limit, Math.max(0, a.bytes - offset)));
    let count: number;
    try { count = readSync(fd, page, 0, page.length, offset); } finally { closeSync(fd); }
    const end = offset + count;
    return { artifact, text: page.subarray(0, count).toString("utf8"), nextOffset: end < a.bytes ? end : null, bytes: a.bytes, omitted: Math.max(0, a.bytes - end), complete: !!r.envelope && r.envelope.closure === "released" };
  }
  bindGateReceiptObserver(binding: object, session: AgentSession): void {
    this.owner.check(binding);
    this.retire();
    const manager = session.sessionManager;
    const owner: NativeOwner = { session, manager, binding, sessionId: session.sessionId,
      file: manager.getSessionFile(), incarnation: {}, retired: false };
    this.native = owner;
    owner.unsubscribe = session.subscribe(event => {
      // Public message_end is post-extension-hooks/PREappend. Never send, await or throw here.
      if (event.type !== "message_start" && event.type !== "message_end") return;
      try {
        if (!this.live(owner)) { this.retire(); return; }
        if (event.type === "message_start") {
          const message = event.message;
          if (message.role === "toolResult" && message.toolName === "head_wait") {
            const matches = this.waits.filter(w => w.owner === owner && w.returned && w.toolCallId === message.toolCallId);
            if (matches.length === 1) {
              const wait = matches[0]!;
              if (wait.finalMessage) {
                wait.unavailable = "ambiguous native message occurrence";
                for (const emission of wait.emissions) this.invalidate(emission.record, wait.unavailable);
              } else wait.finalMessage = message;
            }
          }
          return;
        }
        this.observeFinal(owner, event.message);
      }
      catch (error) {
        for (const wait of this.waits) if (wait.owner === owner) {
          wait.unavailable = `native final observation unavailable: ${String(error)}`;
          for (const emission of wait.emissions) this.invalidate(emission.record, wait.unavailable);
        }
      }
    });
  }
  retire(): void {
    const owner = this.native;
    if (!owner) return;
    owner.retired = true;
    owner.unsubscribe?.(); owner.unsubscribe = undefined;
    for (const record of this.deliveries.values()) if (record.run.binding === owner.binding)
      this.invalidate(record, "native owner retired");
    this.native = undefined;
  }
  private live(owner: NativeOwner): boolean {
    try {
      this.owner.check(owner.binding);
      return !owner.retired && this.native === owner && owner.session.sessionManager === owner.manager &&
        owner.session.sessionId === owner.sessionId && owner.manager.getSessionId() === owner.sessionId &&
        owner.manager.getSessionFile() === owner.file;
    } catch { return false; }
  }
  beginWait(binding: object, toolCallId: string, rawArguments: unknown, effectiveAfter: number): WaitInvocation {
    this.owner.check(binding);
    const wait: WaitInvocation = { binding, toolCallId, rawArguments: structuredClone(rawArguments), effectiveAfter,
      ordinal: ++this.ordinal, owner: this.native, returned: false, emissions: [],
      calls: this.native?.manager.getBranch().filter(e => e.type === "message" && e.message.role === "assistant" &&
        e.message.content.some(c => c.type === "toolCall" && c.id === toolCallId && c.name === "head_wait")) ?? [] };
    this.waits.push(wait);
    if (this.waits.filter(w => w.binding === binding && w.toolCallId === toolCallId).length !== 1) {
      for (const w of this.waits.filter(w => w.binding === binding && w.toolCallId === toolCallId)) {
        w.unavailable = "ambiguous head_wait execution toolCallId";
        for (const emission of w.emissions) this.invalidate(emission.record, w.unavailable);
      }
    }
    return wait;
  }
  emitWait(wait: WaitInvocation): { gates: GateEnvelope[]; blocks: string[] } {
    this.owner.check(wait.binding);
    wait.returned = true;
    const gates: GateEnvelope[] = [], blocks: string[] = [];
    if (!wait.owner || !this.live(wait.owner) || wait.unavailable) return { gates, blocks };
    for (const record of this.deliveries.values()) {
      if (record.run.binding !== wait.binding || !this.current(record.run) || !this.canOffer(record)) continue;
      const envelope = structuredClone(record.run.envelope!);
      const emission: GateWaitEmission = { run: record.run, record, invocation: wait, envelope, block: gateBlock(envelope) };
      // Debit before returning. A failed/altered return spent this same channel-independent credit.
      offerEnvelope(record.progress, undefined);
      record.emissions.push(emission); wait.emissions.push(emission);
      gates.push(structuredClone(envelope)); blocks.push(emission.block);
    }
    return { gates, blocks };
  }
  private invalidate(record: GateDeliveryRecord, reason: string): void {
    record.availability = reason;
    if (record.progress) { record.progress.outstanding = false; record.progress.deliveryDiagnostic = reason; }
  }
  private intact(message: FinalMessageObservation["message"], wait: WaitInvocation): boolean {
    if (message.role !== "toolResult" || message.toolName !== "head_wait" ||
        message.toolCallId !== wait.toolCallId || message.isError !== false) return false;
    const expected = wait.emissions.map(e => e.envelope);
    const details = message.details as { gates?: unknown } | undefined;
    if (!isDeepStrictEqual(details?.gates, expected)) return false;
    return wait.emissions.every(emission =>
      message.content.filter(block => block.type === "text" && block.text === emission.block).length === 1 &&
      message.content.filter(block => block.type === "text" &&
        (block.text.includes("<pitako.head.gates.v1>") || block.text.includes("</pitako.head.gates.v1>")))
        .every(block => block.type === "text" && wait.emissions.some(e => e.block === block.text)));
  }
  private observeFinal(owner: NativeOwner, message: FinalMessageObservation["message"]): void {
    if (!this.live(owner)) { this.retire(); return; }
    // Identity is borrowed from the public start's actual message reference, not
    // guessed from whichever unrelated message happens to finalize next. The SDK
    // preserves this reference through message_end replacement and normal append.
    const matches = this.waits.filter(w => w.owner === owner && w.finalMessage === message);
    const direct = matches.length === 1 && matches[0]!.calls.length === 1;
    if (!direct && message.role === "toolResult" && message.toolName !== "head_wait") {
      // Nested invocations have no transcript head_wait pair. The original account,
      // not this unauthenticated return, may still fund the custom fallback.
      for (const wait of this.waits.filter(w => w.owner === owner && w.returned && w.calls.length !== 1 && !w.observation && !w.unavailable)) {
        wait.unavailable = "head_wait return has no direct transcript occurrence";
        for (const { record } of wait.emissions) if (!record.pinnedWinner && !record.availability)
          record.progress.outstanding = false;
      }
      return;
    }
    if (matches.length !== 1) return;
    const wait = matches[0]!;
    if (!wait.returned || !wait.emissions.length) return;
    if (wait.observation || !this.intact(message, wait)) {
      wait.observation ??= { message, ordinal: ++this.ordinal, before: new Set(owner.manager.getEntries().map(e => e.id)) };
      wait.unavailable = "protected head_wait projection changed or occurrence repeated";
      for (const emission of wait.emissions) this.invalidate(emission.record, wait.unavailable);
      return;
    }
    wait.observation = { message, ordinal: ++this.ordinal, before: new Set(owner.manager.getEntries().map(e => e.id)) };
  }
  ownsWaitMessage(message: FinalMessageObservation["message"]): boolean {
    // Exclusion only: a corrupted owned return must not turn into generic tool
    // evidence by changing toolName. This does not authenticate any message.
    const owned = (w: WaitInvocation) => w.calls.length > 0 && (w.finalMessage === message ||
      w.observation?.message === message || "toolCallId" in message && message.toolCallId === w.toolCallId);
    return this.waits.some(owned) || [...this.deliveries.values()].some(record =>
      record.emissions.some(emission => owned(emission.invocation)));
  }
  private recordFor(run: GateRun): GateDeliveryRecord | undefined {
    const record = run.deliveryId && this.deliveries.get(run.deliveryId);
    if (!record || record.run !== run) return;
    if (this.runs.get(run.runId) !== run) { this.invalidate(record, "gate run registry lost"); return; }
    if (!record.progress) { this.invalidate(record, "gate delivery account lost"); return; }
    if (!record.pinnedWinner && record.progress.delivery === "incorporated")
      this.invalidate(record, "gate pinned winner lost");
    return record;
  }
  private canOffer(record: GateDeliveryRecord): boolean {
    return this.recordFor(record.run) === record && !record.availability && !record.pinnedWinner && !record.consumed &&
      record.progress.deliveryAttempts < 2 && !record.progress.outstanding;
  }
  ready(binding: object) { return [...this.deliveries.values()].some(r => r.run.binding === binding && this.canOffer(r)); }
  pending() { return [...this.runs.values()].some(r => !r.envelope); }
  hold() { const r = [...this.runs.values()].find(r => !r.envelope); return r && { kind: "owned-gates-wait" as const, runId: r.runId, deadlineAt: r.activeDeadlineAt ?? r.deadlineAt }; }
  outcomes(binding: object) { return [...this.runs.values()].filter(r => r.binding === binding && r.envelope).map(r => structuredClone(r.envelope!)); }
  progress(binding: object) {
    return [...this.deliveries].filter(([, r]) => r.run.binding === binding).map(([id, r]) =>
      ({ id, ...r.progress, availability: r.availability, pinned: !!r.pinnedWinner, consumed: r.consumed }));
  }
  gateRecoveryPending(binding: object): boolean {
    return [...this.deliveries.values()].some(r => r.run.binding === binding && this.recordFor(r.run) === r && !r.pinnedWinner && !r.consumed &&
      !r.availability && !r.progress.outstanding && r.progress.deliveryAttempts < 2);
  }
  returnPending(binding: object): boolean {
    return this.waits.some(w => w.binding === binding && !w.unavailable && w.emissions.length &&
      w.owner && this.live(w.owner) && (!w.observation ||
        !w.owner.manager.getEntries().some(e => e.type === "message" && e.message === w.observation!.message)) &&
      w.emissions.some(e => this.recordFor(e.run) === e.record && !e.record.pinnedWinner && !e.record.availability));
  }
  reconcile(binding: object, branch: Branch): void {
    this.owner.check(binding);
    for (const run of this.runs.values()) {
      if (run.binding !== binding || !run.envelope) continue;
      const record = this.recordFor(run);
      if (!record || record.availability) continue;
      if (!record.pinnedWinner && record.emissions.some(e => !this.waits.includes(e.invocation))) {
        if (record.emissions.every(e => e.invocation.owner && this.live(e.invocation.owner)))
          record.progress.outstanding = false; // native registry lost; original owner/account remain
        else this.invalidate(record, "native registry and original owner unavailable");
      }
      for (const wait of this.waits) {
        if (!wait.emissions.some(e => e.record === record) || !wait.observation) continue;
        const observation = wait.observation, owner = wait.owner!;
        if (!this.live(owner) || !this.intact(observation.message, wait)) {
          this.invalidate(record, "protected native proof corrupted or retired"); break;
        }
        const results = owner.manager.getEntries().filter(e => !observation.before.has(e.id) &&
          e.type === "message" && e.message === observation.message);
        if (!results.length) {
          if (owner.manager.getEntries().some(e => !observation.before.has(e.id) && e.type === "message" &&
              e.message.role === "toolResult" && e.message.toolCallId === wait.toolCallId))
            this.invalidate(record, "native append cloned the final message");
          continue; // final observation alone is not append
        }
        const result = results[0]!;
        const calls = branch.filter(e => e.type === "message" && e.message.role === "assistant" &&
          e.message.content.some(c => c.type === "toolCall" && c.id === wait.toolCallId));
        const call = calls[0];
        const occurrences = calls.flatMap(e => e.type === "message" && e.message.role === "assistant"
          ? e.message.content.filter(c => c.type === "toolCall" && c.id === wait.toolCallId) : []);
        const competing = branch.filter(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === wait.toolCallId);
        if (!branch.includes(result) || !call) continue;
        if (results.length !== 1 || occurrences.length !== 1 || occurrences[0]?.type !== "toolCall" ||
            occurrences[0].name !== "head_wait" || wait.calls.length !== 1 || wait.calls[0] !== call ||
            !observation.before.has(call.id) || competing.length !== 1 || branch.indexOf(call) >= branch.indexOf(result)) {
          this.invalidate(record, "ambiguous native call/result pairing"); break;
        }
        if (!record.pinnedWinner && result.type === "message")
          record.pinnedWinner = { kind: "native", owner, call, callId: call.id, resultId: result.id, result, observation, wait };
      }
      if (record.availability) continue;
      if (!record.pinnedWinner) {
        for (const offer of record.offers) {
          const matches = branch.filter(e => !offer.before.has(e.id) && e.type === "custom_message" &&
            e.customType === "pitako.head.gates" && e.content === offer.content &&
            (e.details as { deliveryId?: string })?.deliveryId === run.deliveryId);
          if (matches.length > 1) { this.invalidate(record, "ambiguous custom receipt"); break; }
          if (matches.length === 1 && matches[0]?.type === "custom_message") {
            record.pinnedWinner = { kind: "custom", entryId: matches[0].id, entry: matches[0] }; break;
          }
        }
      }
      if (record.pinnedWinner) { record.progress.delivery = "incorporated"; record.progress.outstanding = false; }
    }
  }
  private eligible(record: GateDeliveryRecord, branch: Branch): boolean {
    if (record.availability || this.recordFor(record.run) !== record || !this.current(record.run)) return false;
    const proof = record.pinnedWinner;
    if (!proof) return false;
    if (proof.kind === "custom") {
      if (proof.entry.id !== proof.entryId || proof.entry.content !== JSON.stringify(record.run.envelope) ||
          proof.entry.customType !== "pitako.head.gates" ||
          (proof.entry.details as { deliveryId?: string })?.deliveryId !== record.run.deliveryId) {
        this.invalidate(record, "protected custom proof corrupted"); return false;
      }
      return branch.includes(proof.entry);
    }
    if (!this.live(proof.owner) || !this.waits.includes(proof.wait) || !this.intact(proof.observation.message, proof.wait) ||
        proof.call.id !== proof.callId || proof.result.id !== proof.resultId ||
        !proof.wait.emissions.some(e => e.record === record && e.run === record.run && e.invocation === proof.wait &&
          record.emissions.includes(e) && isDeepStrictEqual(e.envelope, record.run.envelope)) ||
        proof.result.message !== proof.observation.message || proof.call.type !== "message" ||
        proof.call.message.role !== "assistant" || proof.call.message.content.filter(c =>
          c.type === "toolCall" && c.id === proof.wait.toolCallId && c.name === "head_wait").length !== 1) {
      this.invalidate(record, "protected native proof corrupted or retired"); return false;
    }
    const calls = branch.flatMap(e => e.type === "message" && e.message.role === "assistant"
      ? e.message.content.filter(c => c.type === "toolCall" && c.id === proof.wait.toolCallId) : []);
    return branch.includes(proof.call) && branch.includes(proof.result) && branch.indexOf(proof.call) < branch.indexOf(proof.result) &&
      calls.length === 1 && calls[0]?.type === "toolCall" && calls[0].name === "head_wait" &&
      branch.filter(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === proof.wait.toolCallId).length === 1;
  }
  settle(binding: object): void {
    for (const record of this.deliveries.values()) {
      if (record.run.binding !== binding || this.recordFor(record.run) !== record || record.pinnedWinner || record.availability || record.consumed) continue;
      record.progress.outstanding = false;
      if (record.progress.deliveryAttempts >= 2) this.invalidate(record, "gate delivery exhausted after two total offers");
    }
  }
  deliveryReceipts(binding: object): string[] {
    this.owner.check(binding);
    return [...this.deliveries].flatMap(([id, r]) => r.run.binding === binding && r.pinnedWinner ? [id] : []);
  }
  /** Only this boundary may offer. Read/status/verification cannot manufacture an offer. */
  drafts(binding: object, branch: ReturnType<SessionManager["getBranch"]>, offer: boolean | ((id: string) => boolean) = false) {
    this.reconcile(binding, branch);
    const drafts: Array<{ type: "custom_message"; customType: string; content: string; display: boolean; details: Record<string, string> }> = [];
    for (const r of this.runs.values()) {
      if (r.binding !== binding || !r.envelope) continue;
      const record = this.recordFor(r), content = JSON.stringify(r.envelope);
      if (!record || !offer || !this.canOffer(record) || typeof offer === "function" && !offer(r.envelope.deliveryId)) continue;
      offerEnvelope(record.progress, undefined);
      record.progress.busyContinuation = true; record.progress.continuation = "requested";
      record.offers.push({ before: new Set(branch.map(e => e.id)), content });
      drafts.push({ type: "custom_message", customType: "pitako.head.gates", content, display: true,
        details: { deliveryId: r.envelope.deliveryId, assignmentId: this.owner.assignmentId, runId: r.runId } });
      // One receipt per boundary keeps the exact native parent identity unambiguous.
      break;
    }
    return drafts;
  }
  verification(binding: object, branch: ReturnType<SessionManager["getBranch"]>) {
    this.reconcile(binding, branch);
    return [...this.deliveries.values()].flatMap(record => {
      const r = record.run, proof = record.pinnedWinner;
      return r.binding === binding && proof && this.eligible(record, branch) && r.envelope?.outcome === "passed" &&
        r.envelope.closure === "released" && r.envelope.complete
        ? [{ kind: "owned-gates" as const, entryId: proof.kind === "native" ? proof.result.id : proof.entry.id,
            runId: r.runId, candidate: r.candidate! }] : [];
    });
  }
  consume(binding: object, refs: string[], branch: Branch): void {
    const valid = this.verification(binding, branch);
    for (const record of this.deliveries.values()) {
      const proof = record.pinnedWinner;
      const id = proof && (proof.kind === "native" ? proof.result.id : proof.entry.id);
      if (id && refs.includes(id) && valid.some(v => v.entryId === id)) {
        record.consumed = true; record.progress.outstanding = false;
      }
    }
  }
}
