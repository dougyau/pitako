import { randomUUID, createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MissionEventDraft, MissionStore } from "./store.ts";
import {
  captureWorkspaceImage, captureWorkspacePaths, captureWorkspacePath, currentProcessIdentity, filterWorkspaceImage, hasContainmentProof, processBirthTicks, processIsDescendantOf, processesInNamespace, processNamespaceId,
  quarantineWorkspace, readOwnedNamespaceInit, sandboxProductPath, spawnContained, type ManifestPath, type MissionWorkspace,
} from "./workspace.ts";
import { sealWorkspaceImage } from "./reconcile.ts";
import { loadCodexTools } from "./codex-tools.ts";

const EFFECT_TOOLS = ["bash", "edit", "write", "apply_patch"] as const;
const DENIED_TOOLS = new Set(["powershell", "lsp_rename"]);
const EVENT_VERSION_RETRIES = 8;
const OUTPUT_LIMIT = 1024 * 1024;

export interface MissionEffectContext {
  store: MissionStore;
  workspace: MissionWorkspace;
  missionId: string;
  revision: number;
  unitId: string;
  attemptId: string;
  runtimeId: string;
  ownerEpoch: number;
  allowedOperations: readonly string[];
  recoveryMode?: "verify" | "repair";
  recoveryImageHash?: string;
  repairAuthorizationId?: string;
  canInvoke?: (effectId: string) => boolean;
}

export interface MissionEffectReceipt {
  effectId: string;
  operation: string;
  status: "completed" | "failed" | "unknown" | "denied";
  exitCode?: number;
  termination?: "exit" | "signal" | "timeout" | "unknown";
  stdout?: string;
  stderr?: string;
  paths: Array<Record<string, unknown>>;
  process?: Record<string, unknown>;
  reason?: string;
}

type EffectInput = Record<string, unknown> & { command?: string; path?: string; paths?: string[]; patch?: string };
interface RunningEffect {
  effectId: string;
  child: ChildProcess;
  namespace?: string;
  namespaceRootPid?: number;
  workspace: MissionWorkspace;
  promise?: Promise<MissionEffectReceipt>;
  quiescent: boolean;
}

export class MissionEffects {
  private readonly context: MissionEffectContext;
  private readonly inFlight = new Map<string, RunningEffect>();
  private readonly jobs = new Set<Promise<MissionEffectReceipt>>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private fenced = false;
  private verificationOnly = false;
  private verificationSubject = false;

  constructor(context: MissionEffectContext) {
    this.context = context;
  }

  get workspace(): MissionWorkspace {
    return this.context.workspace;
  }

  get quiescent(): boolean {
    return this.inFlight.size === 0 && this.jobs.size === 0;
  }

  fence(): void {
    this.fenced = true;
  }

  enableVerificationOnly(sealedSubject = false): void {
    this.verificationOnly = true;
    this.verificationSubject ||= sealedSubject;
  }

  async invoke(operation: string, input: EffectInput, signal?: AbortSignal): Promise<MissionEffectReceipt> {
    const job = this.invokeNow(operation, input, signal);
    this.jobs.add(job);
    try { return await job; }
    finally { this.jobs.delete(job); }
  }

  private async invokeNow(operation: string, input: EffectInput, signal?: AbortSignal): Promise<MissionEffectReceipt> {
    const effectId = randomUUID();
    if (this.fenced) return this.recordDenied(effectId, operation, "mission effects are fenced for shutdown");
    if (this.verificationOnly && operation !== "bash") return this.recordDenied(effectId, operation, "recovery verification forbids candidate mutations");
    if (operation !== "bash" && this.context.recoveryMode === "repair" &&
      (!this.context.repairAuthorizationId || !this.context.recoveryImageHash)) {
      return this.recordDenied(effectId, operation, "bounded recovery repair lacks its persisted image authorization");
    }
    if (DENIED_TOOLS.has(operation) || !EFFECT_TOOLS.includes(operation as (typeof EFFECT_TOOLS)[number]) || !this.context.allowedOperations.includes(operation)) {
      return this.recordDenied(effectId, operation, `managed tool is not authorized: ${operation}`);
    }
    if (operation === "apply_patch" && !this.context.workspace.runtimeBun) {
      return this.recordDenied(effectId, operation, "managed apply_patch requires the tested Bun TypeScript runtime; no writer launched");
    }
    if (!hasContainmentProof(this.context.workspace)) return this.recordDenied(effectId, operation, "containment preflight is absent or invalid");
    if (signal?.aborted) return this.recordDenied(effectId, operation, "effect was cancelled before invocation");
    const job = this.serialized(() => this.fenced || this.context.canInvoke?.(effectId) === false
      ? this.recordDenied(effectId, operation, "mission effects are fenced by current admission")
      : this.run(effectId, operation, input, signal));
    this.jobs.add(job);
    try { return await job; }
    finally { this.jobs.delete(job); }
  }

  async shutdown(): Promise<void> {
    this.fence();
    if (await settlesWithin(Promise.allSettled([...this.jobs]), 5_000) && this.quiescent) return;
    await this.terminateOutstanding();
  }

  async terminateOutstanding(): Promise<void> {
    this.fence();
    for (const running of this.inFlight.values()) {
      quarantineWorkspace(running.workspace, `shutdown terminated unresolved effect ${running.effectId}`);
      try { running.child.kill("SIGKILL"); } catch { /* process may already be gone */ }
      if (running.namespace) {
        if (!running.namespaceRootPid) throw new Error(`effect ${running.effectId} has no verified namespace root`);
        await terminateNamespace(running.namespace, running.namespaceRootPid);
      }
      try { running.child.kill("SIGKILL"); } catch { /* process may already be gone */ }
    }
    if (!await settlesWithin(Promise.allSettled([...this.jobs]), 5_000) || !this.quiescent) {
      throw new Error("contained effects did not quiesce within shutdown budget; owner release is unsafe");
    }
  }

  private async serialized<T extends MissionEffectReceipt>(run: () => Promise<T>): Promise<T> {
    const key = this.context.workspace.candidateRoot;
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => tail);
    this.lockTails.set(key, chain);
    await previous;
    try { return await run(); }
    finally {
      release();
      if (this.lockTails.get(key) === chain) this.lockTails.delete(key);
    }
  }

  private async run(effectId: string, operation: string, input: EffectInput, signal?: AbortSignal): Promise<MissionEffectReceipt> {
    const requestHash = hashJson(input);
    let beforePaths: ManifestPath[];
    try { beforePaths = captureWorkspacePaths(this.context.workspace.candidateRoot, true); }
    catch (error) {
      return this.recordDenied(effectId, operation, `candidate baseline observation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const candidateManifestHash = hashJson(beforePaths);
    const owner = currentProcessIdentity(this.context.runtimeId, this.context.ownerEpoch);
    const plan = await createEffectPlan(this.context.workspace, operation, input, requestHash, beforePaths);
    if (this.verificationOnly) plan.verification = { writablePaths: [], network: "disabled",
      sourceView: this.verificationSubject ? "sealed-subject" : "source", privateGitView: this.verificationSubject };
    const planBytes = Buffer.from(JSON.stringify(plan));
    const effectPlanHash = createHash("sha256").update(planBytes).digest("hex");
    const intent = {
      effectId, operation, requestHash, effectPlanHash, missionId: this.context.missionId, revision: this.context.revision,
      unitId: this.context.unitId, attemptId: this.context.attemptId, owner, candidate: this.context.workspace.candidateRoot,
      candidateId: this.context.workspace.candidateId, candidateIdentity: this.context.workspace.candidateIdentity,
      candidateGitIdentity: this.context.workspace.candidateGitIdentity, candidateGitDir: this.context.workspace.candidateGitDir,
      candidateArenaRoot: this.context.workspace.candidateArenaRoot, candidateArenaIdentity: this.context.workspace.candidateArenaIdentity,
      inputManifestHash: this.context.workspace.manifest.hash, candidateManifestHash, recovery: "local-observation-required",
      recoveryMode: this.context.recoveryMode, recoveryImageHash: this.context.recoveryImageHash,
      repairAuthorizationId: this.context.repairAuthorizationId,
    };
    if (this.fenced || this.context.canInvoke?.(effectId) === false)
      return this.recordDenied(effectId, operation, "mission effects are fenced by current admission");
    await this.appendEffectEvent("effect.intent", effectId, intent, undefined, [{ bytes: planBytes, mediaType: "application/json" }]);
    if (this.fenced || signal?.aborted || this.context.canInvoke?.(effectId) === false) {
      const reason = "effect fenced before invocation";
      const receipt: MissionEffectReceipt = { effectId, operation, status: "denied", paths: [], reason };
      await this.appendEffectEvent("effect.receipt", effectId, { effectId, operation, status: receipt.status, paths: [], requestHash, owner, reason, process: null });
      return receipt;
    }
    await this.appendEffectEvent("effect.invoking", effectId, { effectId, operation, owner, requestHash, effectPlanHash });
    if (this.fenced || signal?.aborted || this.context.canInvoke?.(effectId) === false) {
      const reason = "effect fenced before process launch";
      const receipt: MissionEffectReceipt = { effectId, operation, status: "denied", paths: [], reason };
      await this.appendEffectEvent("effect.receipt", effectId, {
        effectId, operation, status: receipt.status, paths: [], requestHash, owner, reason, process: null,
      });
      return receipt;
    }

    const writablePaths = this.verificationOnly ? [] : operation === "bash" || operation === "apply_patch" ? this.context.workspace.allowedPaths : ["."];
    const bashScript = `printf '{"kind":"ready","pid":%s,"namespace":"%s","networkNamespace":"%s"}\\n' "$$" "$(readlink /proc/self/ns/pid)" "$(readlink /proc/self/ns/net)"; IFS= read -r gate || exit 94; [ "$gate" = GO ] || exit 94; exec /bin/bash -c "$1"`;
    const child = operation === "bash"
      ? spawnContained(this.context.workspace, "bash", ["-c", bashScript, "pitako-effect", String(input.command ?? "")], { signal, writablePaths, verificationSubject: this.verificationSubject })
      : spawnContained(this.context.workspace, operation === "apply_patch" ? "bun" : "node", [sandboxProductPath(this.context.workspace, this.context.workspace.adapterScript)], { signal, writablePaths, verificationSubject: this.verificationSubject });
    const running: RunningEffect = { effectId, child, workspace: this.context.workspace, quiescent: false };
    this.inFlight.set(effectId, running);
    const job = this.observeChild(effectId, operation, input, beforePaths, child, owner, requestHash, signal, (ns, rootPid) => {
      running.namespace = ns;
      running.namespaceRootPid = rootPid;
    });
    running.promise = job;
    try { return await job; }
    finally { if (running.quiescent) this.inFlight.delete(effectId); }
  }

  private async observeChild(
    effectId: string,
    operation: string,
    input: EffectInput,
    beforePaths: ManifestPath[],
    child: ChildProcess,
    owner: ReturnType<typeof currentProcessIdentity>,
    requestHash: string,
    signal: AbortSignal | undefined,
    onNamespace: (namespace: string, rootPid: number) => void,
  ): Promise<MissionEffectReceipt> {
    let namespace: string | undefined;
    let namespaceRootPid: number | undefined;
    let identity: Record<string, unknown> | undefined;
    let observedPaths: Array<Record<string, unknown>> = [];
    let closed = false;
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      // AbortError reports a requested stop, not physical process disposal.
      child.once("error", () => {});
      child.once("close", (code, childSignal) => { closed = true; resolve({ code, signal: childSignal }); });
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > OUTPUT_LIMIT) stdoutTruncated = true;
      if (stdoutBytes < OUTPUT_LIMIT) {
        const bounded = chunk.subarray(0, OUTPUT_LIMIT - stdoutBytes);
        stdoutChunks.push(bounded);
        stdoutBytes += bounded.length;
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.length > OUTPUT_LIMIT) stderrTruncated = true;
      if (stderrBytes < OUTPUT_LIMIT) {
        const bounded = chunk.subarray(0, OUTPUT_LIMIT - stderrBytes);
        stderrChunks.push(bounded);
        stderrBytes += bounded.length;
      }
    });
    try {
      if (operation !== "bash") {
        const request = { ...input, operation, hostCandidateRoot: this.context.workspace.candidateRoot, allowedPaths: this.context.workspace.allowedPaths };
        child.stdin!.write(`${JSON.stringify(request)}\n`);
      }
      const readyRow = await nextLine(iterator, 10_000);
      const ready = parseProtocol(readyRow);
      if (ready.kind !== "ready" || !Number.isSafeInteger(ready.pid) || ready.pid < 1 || typeof ready.namespace !== "string" || typeof ready.networkNamespace !== "string") {
        throw new Error("contained process returned an invalid launch handshake");
      }
      namespace = ready.namespace;
      if (namespace === processNamespaceId(process.pid) || ready.networkNamespace === this.context.workspace.containmentProof!.networkNamespace) {
        throw new Error("contained process did not enter private PID and network namespaces");
      }
      const pid = child.pid;
      if (!pid) throw new Error("contained process has no host PID");
      const launcher = { ...owner, pid, birthTicks: processBirthTicks(pid) };
      const ancestry = namespaceProcesses(namespace);
      const namespaceRoot = ancestry.find(({ parentPid }) => parentPid === pid);
      if (!namespaceRoot) throw new Error("contained PID namespace has no child of its registered launch process");
      namespaceRootPid = namespaceRoot.pid;
      const namespaceInit = readOwnedNamespaceInit(namespace, namespaceRoot, launcher);
      assertNamespaceAncestry(namespace, namespaceRootPid);
      onNamespace(namespace, namespaceRootPid);
      identity = {
        ...launcher, namespaceInit,
        containedPid: ready.pid, pidNamespace: namespace, networkNamespace: ready.networkNamespace,
        ancestry, runtimeId: this.context.runtimeId, epoch: this.context.ownerEpoch,
      };
      await this.appendEffectEvent("effect.process.registered", effectId, { effectId, operation, owner, identity });
      if (signal?.aborted || this.fenced) throw new Error("effect fenced before launch release");
      readOwnedNamespaceInit(namespace, namespaceRoot, launcher);
      await this.appendEffectEvent("effect.released", effectId, { effectId, requestHash, processIdentity: identity });
      if (signal?.aborted || this.fenced) throw new Error("effect fenced before launch release");
      readOwnedNamespaceInit(namespace, namespaceRoot, launcher);
      child.stdin!.end("GO\n");

      let receipt: Record<string, any>;
      let timedOut = false;
      if (operation === "bash") {
        const timeoutMs = Number.isSafeInteger(input.timeoutMs) ? Math.max(1, Math.min(Number(input.timeoutMs), 30 * 60_000)) : 120_000;
        const waited = await waitForExit(exit, child, timeoutMs);
        timedOut = waited.timedOut;
        const output = Buffer.concat(stdoutChunks);
        const handshakeEnd = output.indexOf(10);
        const stdout = output.subarray(handshakeEnd < 0 ? output.length : handshakeEnd + 1).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        receipt = {
          kind: "receipt", status: !timedOut && waited.ended.code === 0 ? "completed" : "failed",
          exitCode: timedOut ? 124 : waited.ended.code ?? 1, stdout, stderr,
          termination: timedOut ? "timeout" : waited.ended.signal ? "signal" : "exit",
          outputTruncated: stdoutTruncated || stderrTruncated,
          paths: [],
          process: { descendantsQuiescent: true },
        };
      } else {
        const receiptRow = await nextLine(iterator, 30 * 60_000);
        receipt = parseProtocol(receiptRow);
      }
      const ended = await exit;
      const remaining = namespaceProcesses(namespace);
      if (remaining.length > 0) {
        if (!namespaceRootPid) throw new Error("contained process namespace has no registered ancestry root");
        await terminateNamespace(namespace, namespaceRootPid);
      }
      const stillAlive = namespaceProcesses(namespace);
      if (stillAlive.length > 0) throw new Error("contained process namespace could not be emptied");
      const afterPaths: ManifestPath[] = [];
      try { captureWorkspacePaths(this.context.workspace.candidateRoot, true, afterPaths); }
      catch (error) {
        const visited = new Set(afterPaths.map(({ path: name }) => name));
        observedPaths = diffPathRows(beforePaths.filter(({ path: name }) => visited.has(name)), afterPaths);
        throw error;
      }
      observedPaths = diffPathRows(beforePaths, afterPaths);
      if (operation === "bash") receipt.paths = diffPathRows(beforePaths, afterPaths);
      else if (receipt.kind !== "receipt" || !Array.isArray(receipt.paths) || ended.code !== 0 || receipt.process?.descendantsQuiescent !== true) {
        receipt = {
          kind: "receipt", status: "failed", exitCode: ended.code ?? 1, stdout: "",
          stderr: Buffer.concat(stderrChunks).toString("utf8"), paths: diffPathRows(beforePaths, afterPaths), process: { descendantsQuiescent: true },
        };
      } else {
        const reconciled = reconcileAdapterPaths(receipt.paths, beforePaths, afterPaths);
        receipt.paths = reconciled.paths;
        if (!reconciled.consistent) {
          receipt.status = "failed";
          receipt.stderr = `${String(receipt.stderr ?? "")}adapter path observations did not match host candidate bytes`.trim();
        }
      }
      if (!Array.isArray(receipt.paths) || receipt.process?.descendantsQuiescent !== true) throw new Error("contained process receipt omitted quiescence or path observations");
      const completed: MissionEffectReceipt = {
        effectId, operation, status: receipt.status === "completed" ? "completed" : "failed",
        exitCode: Number(receipt.exitCode), termination: receipt.termination ?? (ended.signal ? "signal" : "exit"), stdout: String(receipt.stdout ?? ""),
        stderr: String(receipt.stderr ?? ""), paths: receipt.paths,
        process: { ...identity, descendantsQuiescent: true, namespaceEmptyAfterExit: true },
      };
      let snapshot: { draft: MissionEventDraft; artifacts: Array<{ bytes: Uint8Array; mediaType: string }> };
      try { snapshot = this.effectSnapshot(effectId, observedPaths); }
      catch (snapshotError) {
        const reason = `effect completed but its private candidate image could not be safely sealed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}`;
        if (completed.status === "failed" && observedPaths.length === 0 && identity && namespace && namespaceProcesses(namespace).length === 0) {
          const noChange: MissionEffectReceipt = { ...completed, process: { ...identity, descendantsQuiescent: true, namespaceEmptyAfterExit: true } };
          await this.appendEffectEvent("effect.receipt", effectId, {
            effectId, operation, status: noChange.status, exitCode: noChange.exitCode,
            stdoutHash: hashText(noChange.stdout ?? ""), stderrHash: hashText(noChange.stderr ?? ""),
            stdoutBytes: Buffer.byteLength(noChange.stdout ?? ""), stderrBytes: Buffer.byteLength(noChange.stderr ?? ""),
            paths: noChange.paths, process: noChange.process, requestHash, owner, termination: noChange.termination,
          });
          runningQuiescent(this.inFlight.get(effectId));
          return noChange;
        }
        quarantineWorkspace(this.context.workspace, reason);
        const unknown = { ...this.unknownReceipt(effectId, operation, reason, completed.process, completed.paths),
          exitCode: completed.exitCode, termination: completed.termination };
        await this.appendEffectEvent("effect.unknown", effectId, unknown as unknown as Record<string, unknown>);
        runningQuiescent(this.inFlight.get(effectId));
        return unknown;
      }
      await this.appendEffectEvent("effect.receipt", effectId, {
        effectId, operation, status: completed.status, exitCode: completed.exitCode,
        stdoutHash: hashText(completed.stdout ?? ""), stderrHash: hashText(completed.stderr ?? ""),
        stdoutBytes: Buffer.byteLength(completed.stdout ?? ""), stderrBytes: Buffer.byteLength(completed.stderr ?? ""),
        outputTruncated: receipt.outputTruncated === true, paths: completed.paths, process: completed.process,
        requestHash, owner, termination: completed.termination,
      }, snapshot);
      runningQuiescent(this.inFlight.get(effectId));
      return completed;
    } catch (error) {
      if (!closed) {
        try { child.kill("SIGKILL"); } catch { /* process already ended */ }
        if (!await settlesWithin(exit, 5_000)) {
          this.fenced = true;
          quarantineWorkspace(this.context.workspace, "effect process could not be reaped");
          throw new Error("effect process could not be reaped; owner release is unsafe");
        }
      }
      if (namespace && namespaceRootPid) await terminateNamespace(namespace, namespaceRootPid);
      const remaining = namespace ? namespaceProcesses(namespace) : [];
      if (remaining.length > 0) {
        this.fenced = true;
        quarantineWorkspace(this.context.workspace, "effect namespace could not be emptied");
        throw new Error("effect namespace could not be emptied; owner release is unsafe");
      }
      const ended = await exit;
      runningQuiescent(this.inFlight.get(effectId));
      const reason = error instanceof Error ? error.message : String(error);
      const afterPaths: ManifestPath[] = [];
      try {
        captureWorkspacePaths(this.context.workspace.candidateRoot, true, afterPaths);
        const paths = diffPathRows(beforePaths, afterPaths);
        observedPaths = paths;
        const failed: MissionEffectReceipt = {
          effectId, operation, status: "failed", exitCode: ended.code ?? 1,
          termination: ended.signal ? "signal" : ended.code !== null ? "exit" : "unknown", stdout: "",
          stderr: Buffer.concat(stderrChunks).toString("utf8") || reason, paths,
          process: identity && namespace ? { ...identity, descendantsQuiescent: true, namespaceEmptyAfterExit: true } : undefined,
        };
        let snapshot: { draft: MissionEventDraft; artifacts: Array<{ bytes: Uint8Array; mediaType: string }> };
        try { snapshot = this.effectSnapshot(effectId, paths); }
        catch (snapshotError) {
          const reason = `effect outcome is uncertain because its partial candidate could not be safely sealed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}`;
          if (paths.length === 0 && identity && namespace && namespaceProcesses(namespace).length === 0) {
            const noChange: MissionEffectReceipt = { ...failed, process: { ...identity, descendantsQuiescent: true, namespaceEmptyAfterExit: true } };
            await this.appendEffectEvent("effect.receipt", effectId, {
              effectId, operation, status: noChange.status, exitCode: noChange.exitCode, paths: [],
              stderrHash: hashText(noChange.stderr ?? ""), requestHash, owner, process: noChange.process,
              outputTruncated: stdoutTruncated || stderrTruncated, termination: noChange.termination,
            });
            return noChange;
          }
          quarantineWorkspace(this.context.workspace, reason);
          const unknown = { ...this.unknownReceipt(effectId, operation, reason, failed.process, paths),
            exitCode: failed.exitCode, termination: failed.termination };
          await this.appendEffectEvent("effect.unknown", effectId, unknown as unknown as Record<string, unknown>);
          return unknown;
        }
        await this.appendEffectEvent("effect.receipt", effectId, {
          effectId, operation, status: failed.status, exitCode: failed.exitCode, paths,
          stderrHash: hashText(failed.stderr ?? ""), requestHash, owner,
          process: failed.process, outputTruncated: stdoutTruncated || stderrTruncated, termination: failed.termination,
        }, snapshot);
        return failed;
      } catch (observationError) {
        const reason = observationError instanceof Error ? observationError.message : String(observationError);
        quarantineWorkspace(this.context.workspace, reason);
        // Only visited paths prove changes after an incomplete inventory; unvisited paths are not deletions.
        const visited = new Set(afterPaths.map(({ path: name }) => name));
        const partial = diffPathRows(beforePaths.filter(({ path: name }) => visited.has(name)), afterPaths);
        const retained = new Map([...observedPaths, ...partial].map((row) => [row.path, row]));
        const unknown = this.unknownReceipt(effectId, operation, reason,
          identity && namespace ? { ...identity, descendantsQuiescent: true, namespaceEmptyAfterExit: true } : undefined,
          [...retained.values()]);
        try { await this.appendEffectEvent("effect.unknown", effectId, unknown as unknown as Record<string, unknown>); } catch { /* crash recovery reads invoking/released events */ }
        return { ...unknown, stderr: Buffer.concat(stderrChunks).toString("utf8") };
      }
    } finally {
      lines.close();
    }
  }

  private async recordDenied(effectId: string, operation: string, reason: string): Promise<MissionEffectReceipt> {
    const receipt: MissionEffectReceipt = { effectId, operation, status: "denied", paths: [], reason };
    await this.appendEffectEvent("effect.denied", effectId, {
      effectId, operation, reason, missionId: this.context.missionId, revision: this.context.revision,
      unitId: this.context.unitId, attemptId: this.context.attemptId,
      owner: currentProcessIdentity(this.context.runtimeId, this.context.ownerEpoch),
    });
    return receipt;
  }

  private unknownReceipt(effectId: string, operation: string, reason: string, process?: unknown, paths: unknown[] = []): MissionEffectReceipt {
    return { effectId, operation, status: "unknown", reason, process: process as Record<string, unknown> | undefined, paths: paths as Array<Record<string, unknown>> };
  }

  private effectSnapshot(effectId: string, paths: Array<Record<string, unknown>>): { draft: MissionEventDraft; artifacts: Array<{ bytes: Uint8Array; mediaType: string }> } {
    const image = filterWorkspaceImage(captureWorkspaceImage(this.context.workspace.candidateRoot), this.context.workspace.allowedPaths);
    for (const row of paths) {
      const after = row.after as ManifestPath;
      if (after.kind === "directory") continue;
      const file = image.files.find(({ path: name }) => name === row.path);
      if (after.kind === "missing" ? !file || file.kind !== "missing" :
        !file || file.kind !== after.kind || file.mode !== after.mode || (file.bytes ? hashBytes(file.bytes) : null) !== after.hash) {
        throw new Error(`workspace image omits effect output bytes or identity: ${row.path}`);
      }
    }
    const sealed = sealWorkspaceImage(image);
    return {
      draft: {
        revision: this.context.revision, kind: "workspace.snapshot.sealed", causalId: randomUUID(),
        effectId, unitId: this.context.unitId, attemptId: this.context.attemptId,
        payload: {
          attemptId: this.context.attemptId, effectId, phase: "effect", imageHash: sealed.imageHash,
          manifestHash: image.manifest.hash, candidateRoot: this.context.workspace.candidateRoot,
          candidateIdentity: this.context.workspace.candidateIdentity,
          candidateGitIdentity: this.context.workspace.candidateGitIdentity,
        },
      },
      artifacts: sealed.artifacts,
    };
  }

  private async appendEffectEvent(
    kind: string,
    effectId: string,
    payload: Record<string, unknown>,
    related?: { draft: MissionEventDraft; artifacts: Array<{ bytes: Uint8Array; mediaType: string }> },
    extraArtifacts: Array<{ bytes: Uint8Array; mediaType: string }> = [],
  ): Promise<void> {
    const draft: MissionEventDraft = {
      revision: this.context.revision, kind, causalId: randomUUID(), effectId,
      unitId: this.context.unitId, attemptId: this.context.attemptId,
      payload,
    };
    const events = related ? [draft, related.draft] : [draft];
    const artifacts = [...(related?.artifacts ?? []), ...extraArtifacts];
    for (let attempt = 0; attempt < EVENT_VERSION_RETRIES; attempt += 1) {
      const inspection = this.context.store.inspectMission(this.context.missionId);
      try {
        this.context.store.appendTransition(this.context.missionId, inspection.version, { events, artifacts });
        return;
      } catch (error) {
        if (!(error instanceof Error) || !/version conflict/.test(error.message) || attempt + 1 >= EVENT_VERSION_RETRIES) throw error;
      }
    }
  }
}

interface PlannedEffectImage extends ManifestPath {
  bytesBase64: string | null;
}

async function createEffectPlan(
  workspace: MissionWorkspace,
  operation: string,
  input: EffectInput,
  requestHash: string,
  beforePaths: ManifestPath[],
): Promise<Record<string, unknown>> {
  const preconditions = beforePaths.filter(({ path: name }) => pathAllowed(name, workspace.allowedPaths));
  const candidate = {
    candidateId: workspace.candidateId, root: workspace.candidateRoot, rootIdentity: workspace.candidateIdentity,
    gitDir: workspace.candidateGitDir, gitIdentity: workspace.candidateGitIdentity,
    arenaRoot: workspace.candidateArenaRoot, arenaIdentity: workspace.candidateArenaIdentity,
  };
  const plan: Record<string, unknown> = {
    format: "mission-effect-plan-v1", operation, requestHash, request: structuredClone(input), candidate,
    preconditions, beforeImageHash: hashJson(preconditions), allowedPaths: [...workspace.allowedPaths], deterministic: operation !== "bash",
    expectedAfter: null, expectedAfterFiles: null,
  };
  if (operation === "bash") return plan;

  let targets: string[];
  try {
    targets = operation === "apply_patch"
      ? [...new Set((await loadCodexTools()).parseApplyPatch(String(input.patch ?? "")).flatMap((hunk) =>
        hunk.kind === "update" && hunk.moveTo ? [hunk.path, hunk.moveTo] : [hunk.path]))]
        .map((name) => validateEffectPath(name, workspace.allowedPaths))
      : [validateEffectPath(String(input.path ?? ""), workspace.allowedPaths)];
  } catch (error) {
    plan.planningError = error instanceof Error ? error.message : String(error);
    plan.deterministic = false;
    return plan;
  }
  plan.targetPaths = targets;
  if (!targets.every((name) => effectParentsAreSafe(workspace.candidateRoot, name, operation === "apply_patch"))) {
    plan.planningError = "one or more effect paths has a symlink or missing parent";
    plan.deterministic = false;
    return plan;
  }
  try {
    const beforeFiles = targets.map((name) => effectPathImage(workspace.candidateRoot, name));
    const expectedFiles = operation === "write"
      ? [writeAfterImage(beforeFiles[0]!, input.content)]
      : operation === "edit"
        ? [editAfterImage(beforeFiles[0]!, input.oldText, input.newText)]
        : await patchAfterImages(workspace.candidateRoot, targets, String(input.patch ?? ""));
    const after = new Map(preconditions.map((row) => [row.path, { ...row }]));
    for (const row of expectedFiles) {
      if (row.kind === "missing") after.delete(row.path);
      else after.set(row.path, { path: row.path, kind: row.kind, mode: row.mode, hash: row.hash });
    }
    const expectedAfter = [...after.values()].sort((left, right) => left.path.localeCompare(right.path));
    const currentAfter = captureWorkspacePaths(workspace.candidateRoot, true)
      .filter(({ path: name }) => pathAllowed(name, workspace.allowedPaths));
    if (hashJson(currentAfter) !== hashJson(preconditions)) throw new Error("candidate changed during after-image preparation");
    plan.deterministic = true;
    plan.beforeFiles = beforeFiles;
    plan.expectedAfterFiles = expectedFiles;
    plan.expectedAfter = expectedAfter;
    plan.expectedAfterHash = hashJson(expectedAfter);
  } catch (error) {
    plan.planningError = error instanceof Error ? error.message : String(error);
    plan.deterministic = false;
  }
  return plan;
}

function writeAfterImage(before: PlannedEffectImage, content: unknown): PlannedEffectImage {
  if (typeof content !== "string") throw new Error("write content must be text");
  if (before.kind !== "file" && before.kind !== "missing") throw new Error("write target must be a regular file");
  const bytes = Buffer.from(content);
  return { path: before.path, kind: "file", mode: before.kind === "file" ? before.mode : 0o644, hash: hashBytes(bytes), bytesBase64: bytes.toString("base64") };
}

function editAfterImage(before: PlannedEffectImage, oldText: unknown, newText: unknown): PlannedEffectImage {
  if (typeof oldText !== "string" || !oldText || typeof newText !== "string" || before.kind !== "file" || before.bytesBase64 === null) {
    throw new Error("edit requires one exact match in an existing regular file");
  }
  const original = Buffer.from(before.bytesBase64, "base64");
  const from = Buffer.from(oldText);
  const to = Buffer.from(newText);
  const index = original.indexOf(from);
  if (index < 0 || original.indexOf(from, index + from.length) >= 0) throw new Error("edit oldText must match exactly once");
  const bytes = Buffer.concat([original.subarray(0, index), to, original.subarray(index + from.length)]);
  return { path: before.path, kind: "file", mode: before.mode, hash: hashBytes(bytes), bytesBase64: bytes.toString("base64") };
}

async function patchAfterImages(root: string, targets: string[], patch: string): Promise<PlannedEffectImage[]> {
  const scratch = mkdtempSync(path.join(tmpdir(), "pitako-effect-plan-"));
  try {
    for (const target of targets) copyEffectPath(root, scratch, target);
    const { applyPatch } = await loadCodexTools();
    await applyPatch(patch, { cwd: scratch });
    const directories = captureWorkspacePaths(scratch).filter((row) => row.kind === "directory").map((row) => row.path);
    return [...new Set([...targets, ...directories])].map((target) => effectPathImage(scratch, target));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function validateEffectPath(input: string, allowedPaths: readonly string[]): string {
  if (!input || input.includes("\\") || input.includes("\0") || path.posix.isAbsolute(input)) throw new Error("managed tool path must be workspace-relative");
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) throw new Error("managed tool path contains a forbidden component");
  const relative = parts.join("/");
  if (!pathAllowed(relative, allowedPaths)) throw new Error(`path is outside mission allowedPaths: ${relative}`);
  return relative;
}

function effectParentsAreSafe(root: string, relative: string, allowMissing = false): boolean {
  let parent = root;
  for (const part of relative.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    try {
      const state = lstatSync(parent);
      if (!state.isDirectory() || state.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return allowMissing;
      throw error;
    }
  }
  return true;
}

function pathAllowed(name: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some((grant) => {
    if (grant === "." || grant === "*" || grant === "/") return true;
    const subtree = grant.endsWith("/**");
    const base = subtree ? grant.slice(0, -3) : grant;
    return name === base || (subtree && name.startsWith(`${base}/`));
  });
}

function effectPathImage(root: string, relative: string): PlannedEffectImage {
  const observed = captureWorkspacePath(root, relative);
  if (observed.kind === "missing" || observed.kind === "directory") return { ...observed, bytesBase64: null };
  const target = path.join(root, ...relative.split("/"));
  const bytes = observed.kind === "symlink" ? Buffer.from(readlinkSync(target)) : readFileSync(target);
  if (hashBytes(bytes) !== observed.hash) throw new Error(`candidate changed while capturing effect precondition: ${relative}`);
  return { ...observed, bytesBase64: bytes.toString("base64") };
}

function copyEffectPath(source: string, destination: string, relative: string): void {
  const parts = relative.split("/");
  let from = source;
  let to = destination;
  for (const part of parts.slice(0, -1)) {
    from = path.join(from, part);
    to = path.join(to, part);
    let mode = 0o755;
    try { mode = lstatSync(from).mode & 0o7777; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    mkdirSync(to, { recursive: true, mode });
  }
  const sourcePath = path.join(source, ...parts);
  const destinationPath = path.join(destination, ...parts);
  try {
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw new Error(`apply_patch after-image requires a contained regular target: ${relative}`);
    else if (stat.isFile()) writeFileSync(destinationPath, readFileSync(sourcePath), { mode: stat.mode & 0o7777 });
    else if (stat.isDirectory()) mkdirSync(destinationPath, { recursive: false, mode: stat.mode & 0o7777 });
    else throw new Error(`unsupported apply_patch precondition at ${relative}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createMissionToolAdapters(effects: MissionEffects): ToolDefinition[] {
  const bash = Type.Object({ command: Type.String({ minLength: 1 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 * 60_000 })) }, { additionalProperties: false });
  const edit = Type.Object({ path: Type.String({ minLength: 1 }), oldText: Type.String({ minLength: 1 }), newText: Type.String() }, { additionalProperties: false });
  const write = Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String() }, { additionalProperties: false });
  const patch = Type.Object({ patch: Type.String({ minLength: 1 }) }, { additionalProperties: false });
  const rows: Array<[typeof EFFECT_TOOLS[number], unknown]> = [["bash", bash], ["edit", edit], ["write", write], ["apply_patch", patch]];
  return rows.map(([name, parameters]) => ({
    name,
    label: `Managed ${name}`,
    description: `Run ${name} inside the mission's fenced Linux candidate boundary.`,
    parameters,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      try {
        const receipt = await effects.invoke(name, params, signal);
        const text = [receipt.stdout, receipt.stderr, receipt.reason].filter((value) => typeof value === "string" && value.length > 0).join("\n") ||
          `${name}: ${receipt.status}`;
        return {
          content: [{ type: "text" as const, text }],
          details: receipt,
          isError: receipt.status !== "completed",
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  } as ToolDefinition));
}

async function nextLine(iterator: AsyncIterator<string>, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("contained process handshake or receipt timed out")), timeoutMs);
  });
  const next = iterator.next().then((row) => {
    if (row.done) throw new Error("contained process exited before protocol receipt");
    return row.value;
  });
  try { return await Promise.race([next, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function parseProtocol(line: string): Record<string, any> {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("protocol row is not an object");
    return parsed as Record<string, any>;
  } catch (error) { throw new Error(`invalid contained process protocol: ${error instanceof Error ? error.message : String(error)}`); }
}

async function terminateNamespace(namespace: string, rootPid: number): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    const processes = namespaceProcesses(namespace);
    if (processes.length === 0) return;
    assertNamespaceAncestry(namespace, rootPid);
    for (const candidate of processes) {
      try {
        if (processBirthTicks(candidate.pid) === candidate.birthTicks && processNamespaceId(candidate.pid) === namespace) globalThis.process.kill(candidate.pid, "SIGKILL");
      } catch { /* exact identity vanished before signal */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function namespaceProcesses(namespace: string): Array<{ pid: number; birthTicks: number; parentPid: number }> {
  return processesInNamespace(namespace);
}

function assertNamespaceAncestry(namespace: string, rootPid: number): void {
  const processes = namespaceProcesses(namespace);
  if (processes.length === 0) throw new Error("contained process ancestry is unavailable");
  for (const candidate of processes) {
    if (!processIsDescendantOf(candidate.pid, rootPid)) {
      throw new Error(`contained PID ${candidate.pid} escaped its registered process ancestry`);
    }
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try { return await Promise.race([promise.then(() => true, () => true), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function reconcileAdapterPaths(reported: unknown[], before: ManifestPath[], after: ManifestPath[]): { paths: Array<Record<string, unknown>>; consistent: boolean } {
  const missing = (name: string): ManifestPath => ({ path: name, kind: "missing", mode: null, hash: null });
  const beforeByPath = new Map(before.map((row) => [row.path, row]));
  const afterByPath = new Map(after.map((row) => [row.path, row]));
  const paths = new Map<string, Record<string, unknown>>();
  let consistent = true;
  for (const value of reported) {
    if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).path !== "string") { consistent = false; continue; }
    const name = (value as { path: string }).path;
    const expectedBefore = beforeByPath.get(name) ?? missing(name);
    const expectedAfter = afterByPath.get(name) ?? missing(name);
    const toObservation = ({ kind, mode, hash }: ManifestPath) => ({ kind, mode, hash });
    if (JSON.stringify((value as Record<string, unknown>).before) !== JSON.stringify(toObservation(expectedBefore))
      || JSON.stringify((value as Record<string, unknown>).after) !== JSON.stringify(toObservation(expectedAfter))) consistent = false;
    paths.set(name, { path: name, before: expectedBefore, after: expectedAfter });
  }
  for (const row of diffPathRows(before, after)) paths.set(String(row.path), row);
  return { paths: [...paths.values()].sort((left, right) => String(left.path).localeCompare(String(right.path))), consistent };
}

async function waitForExit(
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ ended: { code: number | null; signal: NodeJS.Signals | null }; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
  try {
    const first = await Promise.race([exit.then((ended) => ({ ended, timedOut: false as const })), timeout]);
    if (first !== "timeout") return first;
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
    if (await settlesWithin(exit, 250)) return { ended: await exit, timedOut: true };
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    return { ended: await exit, timedOut: true };
  } finally { if (timer) clearTimeout(timer); }
}

function diffPathRows(before: ManifestPath[], after: ManifestPath[]): Array<Record<string, unknown>> {
  const left = new Map(before.map((row) => [row.path, row]));
  const right = new Map(after.map((row) => [row.path, row]));
  const missing = (name: string): ManifestPath => ({ path: name, kind: "missing", mode: null, hash: null });
  const paths: Array<Record<string, unknown>> = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const prior = left.get(name) ?? missing(name);
    const current = right.get(name) ?? missing(name);
    if (JSON.stringify(prior) !== JSON.stringify(current)) paths.push({ path: name, before: prior, after: current });
  }
  return paths;
}

function runningQuiescent(running: RunningEffect | undefined): void {
  if (running) running.quiescent = true;
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
