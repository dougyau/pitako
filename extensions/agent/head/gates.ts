import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
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
  artifacts: Map<string, { file: string; bytes: number; tail: string }>; receipt?: string; offered?: { anchor: string | null; after: Set<string> }; activeDeadlineAt?: number; guideDigest?: string;
}
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
    return structuredClone({ runId: id, phase: r.phase, candidate: r.candidate, closure: r.envelope?.closure ?? "pending", outcome: r.envelope?.outcome,
      available: !!r.envelope, stale: !!r.envelope && !this.current(r), receipt: r.receipt, artifacts: [...r.artifacts].map(([id,a]) => ({ id, bytes: a.bytes, tail: a.tail })) });
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
  ready(binding: object) { return [...this.runs.values()].some(r => r.binding === binding && r.envelope && !r.receipt); }
  pending() { return [...this.runs.values()].some(r => !r.envelope); }
  hold() { const r = [...this.runs.values()].find(r => !r.envelope); return r && { kind: "owned-gates-wait" as const, runId: r.runId, deadlineAt: r.activeDeadlineAt ?? r.deadlineAt }; }
  outcomes(binding: object) { return [...this.runs.values()].filter(r => r.binding === binding && r.envelope).map(r => structuredClone(r.envelope!)); }
  deliveryReceipts(binding: object): string[] {
    this.owner.check(binding);
    return [...this.runs.values()].flatMap(r => r.binding === binding && r.receipt && r.envelope ? [r.envelope.deliveryId] : []);
  }
  /** Only this boundary may offer. Read/status/verification cannot manufacture an offer. */
  drafts(binding: object, branch: ReturnType<SessionManager["getBranch"]>, offer: boolean | ((id: string) => boolean) = false) {
    const drafts: Array<{ type: "custom_message"; customType: string; content: string; display: boolean; details: Record<string, string> }> = [];
    for (const r of this.runs.values()) {
      if (r.binding !== binding || !r.envelope) continue;
      const content = JSON.stringify(r.envelope);
      const receipt = r.offered && branch.find(e => !r.offered!.after.has(e.id) && e.parentId === r.offered!.anchor &&
        e.type === "custom_message" && e.customType === "pitako.head.gates" && e.content === content &&
        (e.details as { deliveryId?: string })?.deliveryId === r.envelope!.deliveryId);
      // Once observed, retain the exact entry identity. Copies on another branch are not receipts.
      if (!r.receipt && receipt) r.receipt = receipt.id;
      if (r.receipt && branch.some(e => e.id === r.receipt)) continue;
      if (!offer || r.receipt || typeof offer === "function" && !offer(r.envelope.deliveryId)) continue;
      r.offered = { anchor: branch.at(-1)?.id ?? null, after: new Set(branch.map(e => e.id)) };
      drafts.push({ type: "custom_message", customType: "pitako.head.gates", content, display: true,
        details: { deliveryId: r.envelope.deliveryId, assignmentId: this.owner.assignmentId, runId: r.runId } });
      // One receipt per boundary keeps the exact native parent identity unambiguous.
      break;
    }
    return drafts;
  }
  verification(binding: object, branch: ReturnType<SessionManager["getBranch"]>) {
    this.drafts(binding, branch);
    return [...this.runs.values()].flatMap(r => r.binding === binding && r.receipt && branch.some(e => e.id === r.receipt) && r.envelope?.outcome === "passed" && r.envelope.closure === "released" && r.envelope.complete && this.current(r)
      ? [{ kind: "owned-gates" as const, entryId: r.receipt, runId: r.runId, candidate: r.candidate! }] : []);
  }
}
