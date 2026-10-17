import { processGroupClosed } from "./gates.ts";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { TSchema } from "typebox";
import {
  createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createReadToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  type BashOperations, type DefaultResourceLoader, type ExtensionFactory, type ToolDefinition, type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { parseApplyPatch } from "pi-codex-tools";
import { AgentClosureError } from "../closure.ts";
import { toolEffect } from "../effects.ts";
import { contains } from "./graph.ts";
import { AdmissionInventory, digest, type Contribution } from "./inventory.ts";
import { reserveOperation } from "./operation-leases.ts";
import { assertNoCheckpointLease } from "./checkpoint-lease.ts";
import type { CheckpointManifest } from "../checkpoints.ts";

// Heterogeneous SDK registry. Individual wrappers retain their schema/details/render-state types.
type NativeDefinition = ToolDefinition<any, any, any>;

/** Finite cooperative foreground commands only. Not descendant confinement or a sandbox. */
export const foregroundBash: BashOperations = {
  async exec(command, cwd, options) {
    if (options.signal?.aborted) throw new Error("aborted");
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout > 2147483)) {
      throw new Error("Invalid timeout: must be a finite positive number of seconds");
    }
    const env = { ...(options.env ?? process.env) };
    delete env.BASH_ENV; delete env.ENV;
    const child = spawn("bash", ["--noprofile", "--norc", "-c", command], {
      cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let failure: unknown, timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= new AgentClosureError([error], "managed bash cancellation"); }
    };
    const cancel = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 250);
    };
    const data = (bytes: Buffer) => { try { options.onData(bytes); } catch (error) { failure ??= error; cancel(); } };
    child.stdout.on("data", data);
    child.stderr.on("data", data);
    child.on("error", error => { failure ??= error; });
    const timeout = options.timeout === undefined ? undefined : setTimeout(() => { timedOut = true; cancel(); }, options.timeout * 1000);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      // close, unlike exit/tool result/abort receipt, includes the owned stdio handles.
      const exitCode = await new Promise<number | null>(resolve => child.once("close", (code, signal) =>
        resolve(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : null))));
      if (child.pid && process.platform !== "win32" && !processGroupClosed(child.pid)) {
        cancel();
        throw new AgentClosureError([new Error("owned process group closure unknown")], "foreground bash");
      }
      if (failure) throw failure;
      if (options.signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${options.timeout}`);
      return { exitCode };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", cancel);
      child.stdout.removeListener("data", data);
      child.stderr.removeListener("data", data);
    }
  },
};

/** Assignment-wide exclusion/uncertainty; each native producer keeps its own product slot. */
export class ManagedAssignment {
  readonly inventory: AdmissionInventory;
  private active = new Set<ManagedProducer>();
  private failures: unknown[] = [];
  private nativeOmitted = 0;
  private native = new Map<string, {
    source: Omit<Contribution["source"], "toolCallId" | "toolName" | "effectiveRevision"> & { observedRevision: number };
    entries: Array<{ entryId: string; toolCallId: string; toolName: string; isError: boolean; digest: string; excerpt: string; truncated: boolean }>;
    gaps: string[];
    closure: "observed" | "released" | "unknown";
  }>();
  constructor(readonly root: string, envelope: readonly string[], adopted?: CheckpointManifest) {
    assertNoCheckpointLease(root);
    this.inventory = new AdmissionInventory(root, envelope, adopted);
  }
  assertHealthy(): void {
    if (this.failures.length) throw new AgentClosureError([...this.failures], "managed assignment");
    if (realpathSync(this.root) !== this.root) throw new Error("managed launch root changed");
  }
  assertGateIdle(): void {
    if (this.failures.length || this.active.size) throw new Error("managed operations active or unknown");
  }
  assertIdle(): void {
    assertNoCheckpointLease(this.root);
    this.assertHealthy();
    if (this.active.size) throw new Error("managed product operation is still settling");
  }
  assertWritable(): void { this.assertHealthy(); assertNoCheckpointLease(this.root); }
  reserve(producer: ManagedProducer): void { this.assertWritable(); this.active.add(producer); }
  release(producer: ManagedProducer): void { this.active.delete(producer); }
  unknown(error: unknown): void { this.failures.push(error); }
  capture(source: Omit<Contribution["source"], "toolCallId" | "toolName" | "effectiveRevision"> & { observedRevision: number },
    branch: ReturnType<SessionManager["getBranch"]>, closure: "observed" | "released" | "unknown" = "observed"): void {
    const results = branch.flatMap(entry => {
      if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
      const payload = JSON.stringify({ content: entry.message.content, details: entry.message.details });
      return [{ entryId: entry.id, toolCallId: entry.message.toolCallId, toolName: entry.message.toolName,
        isError: Boolean(entry.message.isError), digest: digest(payload), excerpt: payload.slice(0, 2048), truncated: payload.length > 2048 }];
    });
    const entries = results.slice(-256);
    const gaps = this.inventory.sources(source.historyId)
      .filter(call => !entries.some(entry => entry.toolCallId === call.toolCallId && entry.toolName === call.toolName))
      .map(call => `No captured native result: ${call.toolName}/${call.toolCallId}`);
    if (results.length > 256) gaps.unshift("Earlier native results omitted");
    this.native.set(source.historyId, { source: structuredClone(source), entries, gaps, closure });
    if (this.native.size > 256) {
      this.native.delete(this.native.keys().next().value!);
      this.nativeOmitted++;
    }
  }
  closed(historyId: string, closure: "released" | "unknown"): void {
    const record = this.native.get(historyId);
    if (record) record.closure = closure;
  }
  snapshot() { return structuredClone({ inventory: this.inventory.snapshot(), native: [...this.native.values()],
    nativeOmitted: this.nativeOmitted, active: this.active.size, closureFailures: this.failures.map(String) }); }
  async settle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active].map(producer => producer.settle()));
    this.assertHealthy();
  }
}

export interface ManagedBinding {
  writes: readonly string[];
  check(): number;
  effects(): void;
  source(): Omit<Contribution["source"], "effectiveRevision" | "toolCallId" | "toolName">;
}

export class ManagedProducer {
  private slot?: Promise<unknown>;
  private controller = new AbortController();
  private retired = false;
  constructor(readonly assignment: ManagedAssignment, private binding: ManagedBinding, private signal: AbortSignal) {}
  cancel(): void { this.retired = true; this.controller.abort(); }
  async settle(): Promise<void> { await this.slot?.catch(() => {}); }
  private check(revision?: number): number {
    this.assignment.assertWritable();
    if (this.retired || this.signal.aborted) throw new Error("managed native binding is retired");
    const current = this.binding.check();
    if (revision !== undefined && revision !== current) throw new Error("managed scope revision changed");
    return current;
  }
  private target(name: string): void {
    if (typeof name !== "string" || !name || name.includes("\0")) throw new Error("invalid managed path");
    const absolute = path.resolve(this.assignment.root, name);
    if (!contains(this.assignment.root, absolute)) throw new Error("managed target escapes the launch root");
    // Resolve every existing component. Refuse dangling links, not just aliases realpath can resolve.
    for (let cursor = absolute; contains(this.assignment.root, cursor); cursor = path.dirname(cursor)) {
      try {
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink() && !existsSync(cursor)) throw new Error("managed target has a dangling symlink");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (cursor === this.assignment.root) break;
    }
    let existing = absolute;
    while (!existsSync(existing)) existing = path.dirname(existing);
    const canonical = path.join(realpathSync(existing), path.relative(existing, absolute));
    if (!this.binding.writes.some(write => contains(write, absolute) && contains(write, canonical))) {
      throw new Error("managed target escapes the original write reservation");
    }
    if (contains(path.join(this.assignment.root, ".git"), absolute) || contains(path.join(this.assignment.root, ".git"), canonical)) {
      throw new Error("managed file tools cannot mutate Git metadata");
    }
  }
  wrap<P extends TSchema, D, S>(definition: ToolDefinition<P, D, S>): ToolDefinition<P, D, S> {
    return { ...definition, execute: (id, params, signal, onUpdate, ctx) => {
      const revision = this.check();
      if (this.slot) throw new Error("managed product operation slot is occupied");
      if (realpathSync(ctx.cwd) !== this.assignment.root) throw new Error("managed tool cwd differs from the launch root");
      const targets = definition.name === "apply_patch"
        ? parseApplyPatch((params as { patch: string }).patch).flatMap(hunk =>
          hunk.kind === "update" && hunk.moveTo ? [hunk.path, hunk.moveTo] : [hunk.path])
        : definition.name === "bash" ? [] : [(params as { path: string }).path];
      for (const target of targets) this.target(target);
      const lease = reserveOperation(this.assignment.root, "writer");
      this.assignment.reserve(this); // Synchronous admission before preflight or native suspension.
      const callbacks = new Set<Promise<unknown>>();
      const failures: unknown[] = [];
      const combined = AbortSignal.any([this.signal, this.controller.signal, ...(signal ? [signal] : [])]);
      const pending = Promise.resolve().then(async () => {
        this.check(revision);
        if (realpathSync(ctx.cwd) !== this.assignment.root) throw new Error("managed tool cwd differs from the launch root");
        if (combined.aborted) throw new Error("managed operation cancelled");
        for (const target of targets) this.target(target);
        const before = this.assignment.inventory.observe(this.binding.writes);
        this.binding.effects(); // Before invoking any native mutation, including partial failures.
        let outcome: Contribution["outcome"] = "threw";
        let value: Awaited<ReturnType<typeof definition.execute>> | undefined;
        let threw = false, failure: unknown;
        try {
          value = await definition.execute(id, params, combined, onUpdate ? update => {
            // Accepting a callback also owns any async work it returned, even if its public type is void.
            try {
              const value: unknown = onUpdate(update);
              const callback = Promise.resolve(value);
              callbacks.add(callback);
              void callback.then(() => callbacks.delete(callback), error => { failures.push(error); callbacks.delete(callback); });
            } catch (error) { failures.push(error); }
          } : undefined, ctx);
          outcome = "returned";
        } catch (error) {
          threw = true; failure = error;
        } finally {
          while (callbacks.size) await Promise.allSettled([...callbacks]);
          const source = this.binding.source();
          this.assignment.inventory.contributed(before, { ...source, ...(source.kind === "consultation" ? { observedRevision: revision } : { effectiveRevision: revision }),
            toolCallId: id, toolName: definition.name }, outcome, this.binding.writes);
        }
        const allFailures = [...(threw ? [failure] : []), ...failures];
        if (allFailures.some(error => error instanceof AgentClosureError)) throw new AgentClosureError(allFailures, "managed native operation");
        if (failures.length) throw new AggregateError(allFailures, "managed callback failed after settlement");
        if (threw) throw failure;
        return value!;
      });
      this.slot = pending;
      void pending.then(() => {
        lease.release();
        this.slot = undefined; this.assignment.release(this);
      }, error => {
        if (error instanceof AgentClosureError) { this.assignment.unknown(error); lease.unknown(String(error)); }
        lease.release();
        this.slot = undefined; this.assignment.release(this);
      });
      return pending;
    } };
  }
}

/** Preserve the exact loaded patch definition (schema, grammar, renderers), not a name-only substitute. */
export function managedTools(loader: DefaultResourceLoader, producer: ManagedProducer): NativeDefinition[] {
  const root = producer.assignment.root;
  const definitions: NativeDefinition[] = [
    createWriteToolDefinition(root), createEditToolDefinition(root), createBashToolDefinition(root, { operations: foregroundBash }),
  ];
  const extensions = loader.getExtensions().extensions;
  const patchOwners = extensions.filter(extension => extension.tools.has("apply_patch"));
  const knownEntry = realpathSync(new URL("../extensions/index.ts", import.meta.resolve("pi-codex-tools")).pathname);
  if (patchOwners.length === 1 && realpathSync(patchOwners[0]!.resolvedPath) === knownEntry) {
    definitions.push(patchOwners[0]!.tools.get("apply_patch")!.definition);
  }
  return [...definitions.map(definition => producer.wrap(definition)),
    createReadToolDefinition(root), createGrepToolDefinition(root), createFindToolDefinition(root), createLsToolDefinition(root)];
}

const LOCAL = new Set(["head_gates", "consultation_feedback", "head_consult", "head_result", "head_wait", "head_plan", "head_start", "head_observe", "head_input", "head_review", "head_finish", "head_scope_ack"]);
const BOOKKEEPING = new Set(["todo", "compress", "decompress", "search_context", "acp_status", "acp_cache",
  "board_post", "board_topic_create", "board_topic_update", "board_workflow_claim", "board_workflow_lifecycle",
  "memory_search", "memory_add", "memory_replace", "memory_remove", "session_search"]);

export function managedGuard(supported: Set<string>, checkpoint = false): ExtensionFactory {
  return pi => { pi.on("tool_call", event => {
    if (supported.has(event.toolName) || LOCAL.has(event.toolName) && (!["head_consult", "consultation_feedback"].includes(event.toolName) || checkpoint) || checkpoint && event.toolName === "head_checkpoint" || BOOKKEEPING.has(event.toolName) ||
        toolEffect(event.toolName) === "read_only") return;
    return { block: true, reason: "Unsupported writer/composition in a locally checkpointed assignment; use managed native file tools or finite foreground bash" };
  }); };
}
