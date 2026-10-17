import { AgentClosureError } from "../closure.ts";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { createBashToolDefinition, type ExtensionAPI, type BashOperations } from "@earendil-works/pi-coding-agent";
import { toolEffect } from "../effects.ts";
import { executionForSession } from "../../execution-identity.ts";

type Lease = { root?: string; kind: "writer" | "checkpoint" | "gates"; unknown?: string };
const KEY = Symbol.for("pitako.operationLeases");
const host = globalThis as typeof globalThis & { [KEY]?: { leases: Set<Lease>; mutations: Map<string, number>; next: number } };
host[KEY] ??= { leases: new Set(), mutations: new Map(), next: 0 };
const state = host[KEY];
export const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
export function canonicalRoot(root: string): string { return realpathSync(root); }
// Ordinary writers may overlap; retained unknown writers may not admit new effects.
export function assertNoExclusive(root?: string): void {
  const lease = [...state.leases].find(l => (l.kind !== "writer" || l.unknown !== undefined) && (!root || !l.root || overlaps(root, l.root)));
  if (!lease) return;
  if (lease.kind === "writer") throw new AgentClosureError([new Error(lease.unknown)], "overlapping writer");
  throw new Error("checkpoint lease or gates lease is occupied");
}
export function assertQuiescent(root: string): void {
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
    release() { if (lease.unknown === undefined) state.leases.delete(lease); },
    unknown(reason: string) { lease.unknown = reason; state.leases.add(lease); },
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
  const active = new Map<string, ReturnType<typeof reserveOperation>>();
  pi.on("tool_call", (event, ctx) => {
    if (executionForSession(ctx.sessionManager?.getSessionId())?.managed ||
        toolEffect(event.toolName) === "read_only" || BOOKKEEPING.has(event.toolName)) return;
    try {
      const input = event.input as { path?: string };
      const root = ["write", "edit"].includes(event.toolName) && typeof input.path === "string"
        ? physicalTarget(path.resolve(ctx.cwd, input.path))
        : event.toolName === "bash" ? realpathSync(ctx.cwd) : undefined;
      if (active.has(event.toolCallId)) throw new Error("writer call already active");
      active.set(event.toolCallId, reserveOperation(root, "writer"));
    } catch (error) { return { block: true, reason: String(error) }; }
  });
  pi.on("tool_result", event => {
    const lease = active.get(event.toolCallId);
    if (!lease) return;
    if ((event.details as { closure?: string })?.closure === "unknown") lease.unknown("principal executor closure unknown");
    lease.release(); active.delete(event.toolCallId);
  });
  const leasedForeground: BashOperations = { async exec(command, cwd, options) {
    const lease = reserveOperation(realpathSync(cwd), "writer");
    try { return await foreground.exec(command, cwd, options); }
    catch (error) { if (error instanceof AgentClosureError) lease.unknown(error.message); throw error; }
    finally { lease.release(); }
  } };
  pi.registerTool(createBashToolDefinition(process.cwd(), { operations: leasedForeground }));
  // Returning operations is not settlement: surround the actual executor, not this handler.
  pi.on("user_bash", () => ({ operations: leasedForeground }));
}
