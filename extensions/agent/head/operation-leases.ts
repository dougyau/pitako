import { AgentClosureError, hasUnknownClosure, joinedClosureObservation, type ClosureObservation } from "../closure.ts";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { createBashToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  type ExtensionAPI, type BashOperations } from "@earendil-works/pi-coding-agent";
import { toolEffect } from "../effects.ts";
import { captureCallContext, checkCallContext, reserveEffect, guardDefinition, hasDefinitionGuard, hasReadDefinitionGuard,
  withCallContext as withCaptured, assertGenericWrite, type Producer } from "../../workflow-engine.ts";
import type { CallContext } from "../../workflow-engine.ts";
import type { Reservation } from "../../workflow-state.ts";
import { randomUUID } from "node:crypto";

type Lease = { root?: string; kind: "writer" | "checkpoint" | "gates"; unknown?: string;
  observations: Array<ClosureObservation | undefined>; released?: boolean; producer: Producer };
// Only local observation handles live here. Reservation/closure authority is in SQLite.
const pending = new Set<Lease>();
export const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
export function canonicalRoot(root: string): string { return realpathSync(root); }
function reobserve(root?: string): void {
  for (const lease of pending) {
    if (lease.unknown === undefined || root && lease.root && !overlaps(root, lease.root) || !lease.observations?.length) continue;
    try {
      if (!lease.observations.every(observation => observation?.observe() === "closed")) continue;
      lease.producer.observe("host-operation", "closed", true);
      pending.delete(lease);
      lease.released = true;
    } catch { /* A failed observation is not closure. */ }
  }
  for (const lease of pending) {
    if (lease.root === undefined && lease.unknown !== undefined &&
      lease.producer.snapshot().facts["host-operation"] !== "closed")
      throw new AgentClosureError([new Error(lease.unknown ?? "unreleased operation")], "unscoped operation lease");
  }
}
// Ordinary writers may overlap; retained unknown writers may not admit new effects.
export function assertNoExclusive(root?: string): void {
  reobserve(root);
  const context = captureCallContext(root ? physicalTarget(root) : process.cwd());
  checkCallContext(context).assertIdle([root ?? path.parse(process.cwd()).root], true);
}
export function assertQuiescent(root: string): void {
  reobserve(root);
  checkCallContext(captureCallContext(physicalTarget(root))).assertIdle([root]);
}
export function mutationGeneration(root: string): number {
  const store = checkCallContext(captureCallContext(root)).store;
  return Math.max(0, ...store.outbox().filter(entry => {
    const body = entry.body as { kind?: string; reservation?: Reservation };
    return body.kind === "reserved" && body.reservation?.kind === "writer" &&
      body.reservation.paths.some(scope => overlaps(root, scope));
  }).map(entry => entry.sequence));
}
/** Admission precedes effects. Unknown closure deliberately keeps its reservation. */
export function reserveOperation(root: string | undefined, kind: Lease["kind"], context?: CallContext) {
  if (kind !== "writer" && !root) throw new Error("exclusive operations require a physical root");
  reobserve(root);
  if (!context && !root) throw new Error("unscoped native operation requires captured context");
  context ??= captureCallContext(physicalTarget(root!));
  assertGenericWrite(context);
  const reservation = reserveEffect(context, { reservationId: randomUUID(), kind,
    paths: [root ?? path.parse(process.cwd()).root] });
  const producer = reservation.register("native-operation", ["host-operation"]);
  producer.enter();
  const lease: Lease = { root, kind, producer, observations: [] };
  return {
    release() {
      if (lease.released || lease.unknown !== undefined) return;
      producer.observe("host-operation", "closed", true);
      lease.released = true;
      pending.delete(lease);
    },
    unknown(reason: string, observation?: ClosureObservation) {
      if (lease.released) return;
      producer.observe("host-operation", "unknown");
      lease.unknown = reason;
      lease.observations.push(observation);
      pending.add(lease);
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
    const info = pi.getAllTools?.().find(tool => tool.name === event.toolName);
    if (info && hasDefinitionGuard(info.parameters)) {
      try {
        const context = captureCallContext(ctx.cwd, ctx.sessionManager);
        checkCallContext(context);
        if (!hasReadDefinitionGuard(info.parameters))
          withCaptured(context, () => assertNoExclusive(ctx.cwd));
      } catch (error) { return { block: true, reason: String(error) }; }
      if (hasReadDefinitionGuard(info.parameters)) return;
    }
    // A familiar spelling is not proof: only SDK-owned definitions get this exemption.
    if (info?.sourceInfo.path === `builtin:${event.toolName}` &&
        (toolEffect(event.toolName) === "read_only" || BOOKKEEPING.has(event.toolName))) return;
    try {
      const context = captureCallContext(ctx.cwd, ctx.sessionManager);
      checkCallContext(context);
      const input = event.input as { path?: string };
      const root = ["write", "edit"].includes(event.toolName) && typeof input.path === "string"
        ? physicalTarget(path.resolve(ctx.cwd, input.path))
        : event.toolName === "bash" ? realpathSync(ctx.cwd) : undefined;
      if (active.has(event.toolCallId)) throw new Error("writer call already active");
      active.set(event.toolCallId, { lease: reserveOperation(root, "writer", context), linked: false });
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
  pi.registerTool(guardDefinition(createWriteToolDefinition(process.cwd()), "write"));
  pi.registerTool(guardDefinition(createEditToolDefinition(process.cwd()), "write"));
  pi.registerTool(guardDefinition({ ...definition, async execute(id, params, signal, onUpdate, ctx) {
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
  } }, "write"));
  // Returning operations is not settlement: surround the actual executor, not this handler.
  pi.on("user_bash", (_event, ctx) => {
    const context = captureCallContext(ctx.cwd, ctx.sessionManager);
    checkCallContext(context);
    return { operations: { exec: (...args) => withCaptured(context, () => leasedForeground().exec(...args)) } };
  });
}
