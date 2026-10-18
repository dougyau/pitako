import { AgentClosureError, hasUnknownClosure, joinedClosureObservation, type ClosureObservation } from "../closure.ts";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { createBashToolDefinition, type ExtensionAPI, type BashOperations } from "@earendil-works/pi-coding-agent";
import { toolEffect } from "../effects.ts";
import { executionForSession } from "../../execution-identity.ts";

type Lease = { root?: string; kind: "writer" | "checkpoint" | "gates"; unknown?: string;
  observations?: Array<ClosureObservation | undefined>; released?: boolean };
const KEY = Symbol.for("pitako.operationLeases");
const host = globalThis as typeof globalThis & { [KEY]?: { leases: Set<Lease>; mutations: Map<string, number>; next: number } };
host[KEY] ??= { leases: new Set(), mutations: new Map(), next: 0 };
const state = host[KEY];
export const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
export function canonicalRoot(root: string): string { return realpathSync(root); }
function reobserve(root?: string): void {
  for (const lease of state.leases) {
    if (lease.unknown === undefined || root && lease.root && !overlaps(root, lease.root) || !lease.observations?.length) continue;
    try {
      if (!lease.observations.every(observation => observation?.observe() === "closed")) continue;
      state.leases.delete(lease);
      lease.released = true;
    } catch { /* A failed observation is not closure. */ }
  }
}
// Ordinary writers may overlap; retained unknown writers may not admit new effects.
export function assertNoExclusive(root?: string): void {
  reobserve(root);
  const lease = [...state.leases].find(l => (l.kind !== "writer" || l.unknown !== undefined) && (!root || !l.root || overlaps(root, l.root)));
  if (!lease) return;
  if (lease.kind === "writer") throw new AgentClosureError([new Error(lease.unknown)], "overlapping writer");
  throw new Error("checkpoint lease or gates lease is occupied");
}
export function assertQuiescent(root: string): void {
  reobserve(root);
  if ([...state.leases].some(l => !l.root || overlaps(root, l.root)))
    throw new Error("overlapping operation is active or unknown");
}
export function mutationGeneration(root: string): number {
  return Math.max(0, ...[...state.mutations].filter(([r]) => r === "*" || overlaps(root, r)).map(([, n]) => n));
}
/** Admission precedes effects. Unknown closure deliberately keeps its reservation. */
export function reserveOperation(root: string | undefined, kind: Lease["kind"]) {
  if (kind === "writer") {
    assertNoExclusive(root);
    state.mutations.set(root ?? "*", ++state.next);
  } else {
    if (!root) throw new Error("exclusive operations require a physical root");
    assertQuiescent(root);
  }
  const lease: Lease = { root, kind };
  state.leases.add(lease);
  return {
    release() {
      if (lease.released || lease.unknown !== undefined) return;
      lease.released = true;
      state.leases.delete(lease);
    },
    unknown(reason: string, observation?: ClosureObservation) {
      if (lease.released) return;
      lease.unknown = reason;
      (lease.observations ??= []).push(observation);
    },
  };
}

// Host bookkeeping does not modify candidate inputs. Unknown tools and compositions fail closed.
const BOOKKEEPING = new Set(["todo", "compress", "decompress", "search_context", "acp_status", "acp_cache",
  "board_post", "board_topic_create", "board_topic_update", "board_workflow_claim", "board_workflow_lifecycle",
  "memory_search", "memory_add", "memory_replace", "memory_remove", "session_search",
  "agent_observe", "agent_input", "agent_status", "agent_result", "team_status", "team_result", "agent_cancel", "team_cancel"]);
function physicalTarget(target: string) {
  let existing = target;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("cannot establish writer scope");
    existing = parent;
  }
  return realpathSync(existing);
}
/** Hooks include nested session ctx.executeTool calls, not just model-issued calls. */
export function principalLeases(pi: ExtensionAPI, foreground: BashOperations) {
  const active = new Map<string, { lease: ReturnType<typeof reserveOperation>; linked: boolean }>();
  pi.on("tool_call", (event, ctx) => {
    if (executionForSession(ctx.sessionManager?.getSessionId())?.managed ||
        toolEffect(event.toolName) === "read_only" || BOOKKEEPING.has(event.toolName)) return;
    try {
      const input = event.input as { path?: string };
      const root = ["write", "edit"].includes(event.toolName) && typeof input.path === "string"
        ? physicalTarget(path.resolve(ctx.cwd, input.path))
        : event.toolName === "bash" ? realpathSync(ctx.cwd) : undefined;
      if (active.has(event.toolCallId)) throw new Error("writer call already active");
      active.set(event.toolCallId, { lease: reserveOperation(root, "writer"), linked: false });
    } catch (error) { return { block: true, reason: String(error) }; }
  });
  pi.on("tool_result", event => {
    const call = active.get(event.toolCallId);
    if (!call) return;
    if ((event.details as { closure?: string })?.closure === "unknown" && !call.linked) call.lease.unknown("principal executor closure unknown");
    call.lease.release(); active.delete(event.toolCallId);
  });
  const leasedForeground = (onUnknown?: (error: AgentClosureError) => void): BashOperations => ({ async exec(command, cwd, options) {
    const lease = reserveOperation(realpathSync(cwd), "writer");
    try { return await foreground.exec(command, cwd, options); }
    catch (error) {
      if (hasUnknownClosure(error)) {
        const closure = error instanceof AgentClosureError ? error : new AgentClosureError([error], "foreground executor");
        lease.unknown(closure.message, closure.observation);
        onUnknown?.(closure);
      }
      throw error;
    }
    finally { lease.release(); }
  } });
  const definition = createBashToolDefinition(process.cwd());
  pi.registerTool({ ...definition, async execute(id, params, signal, onUpdate, ctx) {
    const call = active.get(id);
    let settled = false;
    const unknown = (error: AgentClosureError) => {
      if (!call) return;
      call.linked = true;
      call.lease.unknown(error.message, error.observation && { observe: () =>
        settled ? error.observation!.observe() : "unknown" });
    };
    const callbacks = new Set<Promise<unknown>>(), failures: unknown[] = [];
    const native = createBashToolDefinition(process.cwd(), { operations: leasedForeground(unknown) });
    let value: Awaited<ReturnType<typeof native.execute>> | undefined, failure: unknown, threw = false;
    try {
      value = await native.execute(id, params, signal, onUpdate ? update => {
        try {
          const callback = Promise.resolve(onUpdate(update));
          callbacks.add(callback);
          void callback.then(() => callbacks.delete(callback), error => { failures.push(error); callbacks.delete(callback); });
        } catch (error) { failures.push(error); }
      } : undefined, ctx);
    } catch (error) { threw = true; failure = error; }
    finally {
      while (callbacks.size) await Promise.allSettled([...callbacks]);
      // Unknown callback obligations cannot be discharged by a process observation.
      for (const error of failures.filter(hasUnknownClosure)) unknown(error instanceof AgentClosureError
        ? error : new AgentClosureError([error], "foreground callback"));
      settled = true;
    }
    const errors = [...(threw ? [failure] : []), ...failures];
    if (failures.length) {
      if (errors.some(hasUnknownClosure)) throw new AgentClosureError(errors, "foreground callbacks", joinedClosureObservation(errors));
      throw new AggregateError(errors, "foreground callbacks failed after settlement");
    }
    if (threw) throw failure;
    return value!;
  } });
  // Returning operations is not settlement: surround the actual executor, not this handler.
  pi.on("user_bash", () => ({ operations: leasedForeground() }));
}
