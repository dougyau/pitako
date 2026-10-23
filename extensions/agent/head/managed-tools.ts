import { fileURLToPath } from "node:url";
import { ownProcess } from "./owned-process.ts";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { TSchema } from "typebox";
import {
  createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createReadToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  type BashOperations, type DefaultResourceLoader, type ExtensionFactory, type ToolDefinition, type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { parseApplyPatch } from "pi-codex-tools";
import { AgentClosureError, hasUnknownClosure, joinedClosureObservation } from "../closure.ts";
import { toolEffect } from "../effects.ts";
import { contains } from "./graph.ts";
import { AdmissionInventory, digest, type Contribution } from "./inventory.ts";
import { reserveOperation } from "./operation-leases.ts";
import { assertNoCheckpointLease } from "./checkpoint-lease.ts";
import type { CheckpointManifest } from "../checkpoints.ts";
import { captureCallContext, checkCallContext, guardDefinition, hasDefinitionGuard, isGuardedDefinition, registerResource, type CallContext, type Producer } from "../../workflow-engine.ts";
import { packageRoot } from "../../stack.ts";

// Heterogeneous SDK registry. Individual wrappers retain their schema/details/render-state types.
type NativeDefinition = ToolDefinition<any, any, any>;
function physicalOwner(file: string): string | undefined {
  try { return realpathSync(file); } catch { return undefined; }
}

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
    return ownProcess(child, { onData: options.onData, signal: options.signal,
      timeoutMs: options.timeout === undefined ? undefined : options.timeout * 1000 });
  },
};

/** Assignment-wide exclusion/uncertainty; each native producer keeps its own product slot. */
export class ManagedAssignment {
  readonly inventory: AdmissionInventory;
  readonly context: CallContext;
  private inventoryPin?: { release: () => void; producer: Producer };
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
    this.context = captureCallContext(root);
    checkCallContext(this.context);
    assertNoCheckpointLease(root);
    this.inventory = new AdmissionInventory(root, envelope, adopted);
    const source = this.inventory.snapshot().admission;
    if (source) {
      const producer = registerResource(this.context, "source-inventory", ["callback"], "observation", "independent", ["callback"]);
      producer.enter();
      const release = checkCallContext(this.context).store.pinGit({ bindingId: `inventory:${producer.ref.resourceId}`, root,
        resource: producer.ref, components: [{ component: "HEAD", expected: source.admissionHead },
          { component: "index", expected: source.indexDigest }, { component: "gitDir", expected: source.gitDir },
          { component: "commonDir", expected: source.repository }, { component: "policy", expected: source.configuration }] });
      this.inventoryPin = { release, producer };
    }
  }
  assertHealthy(): void {
    checkCallContext(this.context);
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
  /** Called only after the owning Head retires and joins its operations. Historical snapshots grant no live pin. */
  retireInventory(): void {
    if (this.active.size) throw new Error("source inventory operations remain active");
    this.inventoryPin?.release();
    this.inventoryPin?.producer.observe("callback", "closed", true);
    this.inventoryPin = undefined;
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
  wrap<P extends TSchema, D, S>(definition: ToolDefinition<P, D, S>,
    createDefinition?: (observeUnknown: (error: unknown) => void) => ToolDefinition<P, D, S>): ToolDefinition<P, D, S> {
    return guardDefinition({ ...definition, execute: (id, params, signal, onUpdate, ctx) => {
      const revision = this.check();
      if (this.slot) throw new Error("managed product operation slot is occupied");
      if (realpathSync(ctx.cwd) !== this.assignment.root) throw new Error("managed tool cwd differs from the launch root");
      const targets = definition.name === "apply_patch"
        ? parseApplyPatch((params as { patch: string }).patch).flatMap(hunk =>
          hunk.kind === "update" && hunk.moveTo ? [hunk.path, hunk.moveTo] : [hunk.path])
        : definition.name === "bash" ? [] : [(params as { path: string }).path];
      for (const target of targets) this.target(target);
      const lease = reserveOperation(this.assignment.root, "writer", this.assignment.context);
      this.assignment.reserve(this); // Synchronous admission before preflight or native suspension.
      const callbacks = new Set<Promise<unknown>>();
      const failures: unknown[] = [];
      let settled = false;
      const observeUnknown = (error: unknown) => {
        if (!hasUnknownClosure(error)) return;
        failures.push(error);
        const observation = joinedClosureObservation([error]);
        // Capture before native output finalization can replace the executor's error.
        lease.unknown(String(error), observation && { observe: () => settled ? observation.observe() : "unknown" });
      };
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
          const native = createDefinition?.(observeUnknown) ?? definition;
          value = await native.execute(id, params, combined, onUpdate ? update => {
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
          try {
            const source = this.binding.source();
            this.assignment.inventory.contributed(before, { ...source, ...(source.kind === "consultation" ? { observedRevision: revision } : { effectiveRevision: revision }),
              toolCallId: id, toolName: definition.name }, outcome, this.binding.writes);
          } catch (error) { failures.push(error); }
        }
        const allFailures = [...new Set([...(threw ? [failure] : []), ...failures])];
        if (allFailures.some(hasUnknownClosure)) throw new AgentClosureError(allFailures, "managed native operation",
          joinedClosureObservation(allFailures));
        if (failures.length) throw new AggregateError(allFailures, "managed callback failed after settlement");
        if (threw) throw failure;
        return value!;
      });
      this.slot = pending;
      void pending.then(() => {
        settled = true;
        lease.release();
        this.slot = undefined; this.assignment.release(this);
      }, error => {
        if (error instanceof AgentClosureError) { this.assignment.unknown(error); lease.unknown(String(error), error.observation); }
        settled = true;
        lease.release();
        this.slot = undefined; this.assignment.release(this);
      });
      return pending;
    } }, "read", definition.name === "apply_patch");
  }
}

/** Preserve the exact loaded patch definition (schema, grammar, renderers), not a name-only substitute. */
export function managedTools(loader: DefaultResourceLoader, producer: ManagedProducer): NativeDefinition[] {
  const root = producer.assignment.root;
  const bash = createBashToolDefinition(root, { operations: foregroundBash });
  const managedBash = producer.wrap(bash, observeUnknown => createBashToolDefinition(root, { operations: {
    async exec(command, cwd, options) {
      try { return await foregroundBash.exec(command, cwd, options); }
      catch (error) { observeUnknown(error); throw error; }
    },
  } }));
  const definitions: NativeDefinition[] = [
    producer.wrap(createWriteToolDefinition(root)), producer.wrap(createEditToolDefinition(root)), managedBash,
  ];
  const extensions = loader.getExtensions().extensions;
  const patchOwners = extensions.filter(extension => extension.tools.has("apply_patch"));
  const knownEntry = realpathSync(fileURLToPath(new URL("../index.ts", import.meta.resolve("pi-codex-tools"))));
  if (patchOwners.length === 1 && physicalOwner(patchOwners[0]!.resolvedPath) === knownEntry) {
    const tool = patchOwners[0]!.tools.get("apply_patch")!;
    tool.definition = producer.wrap(tool.definition);
    definitions.push(tool.definition);
  }
  return [...definitions,
    ...[createReadToolDefinition(root), createGrepToolDefinition(root), createFindToolDefinition(root), createLsToolDefinition(root)]
      .map((definition: NativeDefinition) => guardDefinition(definition, "read"))];
}

const LOCAL = new Set(["head_gates", "consultation_feedback", "head_consult", "head_result", "head_wait", "head_plan", "head_start", "head_observe", "head_input", "head_review", "head_finish", "head_scope_ack"]);
const BOOKKEEPING = new Set(["todo", "compress", "decompress", "search_context", "acp_status", "acp_cache",
  "board_post", "board_topic_create", "board_topic_update", "board_workflow_claim", "board_workflow_lifecycle",
  "memory_search", "memory_add", "memory_replace", "memory_remove", "session_search"]);

/** Enrol only actual packaged read/bookkeeping definitions from their known owners. */
export function guardManagedLoadedDefinitions(loader: DefaultResourceLoader): void {
  const root = packageRoot();
  const owners = new Set([
    "extensions/todo.ts", "extensions/acp.ts", "extensions/board/index.ts",
    "node_modules/pi-lsp-client/src/index.ts", "node_modules/@vndv/pi-codegraph/extensions/codegraph.ts",
    "node_modules/pi-hermes-memory/src/index.ts",
  ].map(file => realpathSync(path.join(root, file))));
  for (const extension of loader.getExtensions().extensions) {
    const owner = physicalOwner(extension.resolvedPath);
    const known = owner !== undefined && owners.has(owner);
    const knownPatch = owner === realpathSync(fileURLToPath(new URL("../index.ts", import.meta.resolve("pi-codex-tools"))));
    for (const [name, tool] of extension.tools) {
      if (isGuardedDefinition(tool.definition) || knownPatch && name === "apply_patch") continue;
      if (known && (BOOKKEEPING.has(name) || toolEffect(name) === "read_only"))
        tool.definition = guardDefinition(tool.definition, "read");
      else tool.definition = guardDefinition({ ...tool.definition, async execute() {
        throw new Error("Unsupported managed definition/composition");
      } }, "read");
    }
  }
}

export function managedGuard(supported: Set<string>, checkpoint = false): ExtensionFactory {
  return pi => { pi.on("tool_call", event => {
    const info = pi.getAllTools?.().find(tool => tool.name === event.toolName);
    if (info && hasDefinitionGuard(info.parameters)) return;
    if (info?.sourceInfo.path === `builtin:${event.toolName}` &&
      (BOOKKEEPING.has(event.toolName) || toolEffect(event.toolName) === "read_only")) return;
    return { block: true, reason: "Unsupported writer/composition in a locally checkpointed assignment; use managed native file tools or finite foreground bash" };
  }); };
}
