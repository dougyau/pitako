import type { createAgentController, AgentSelection } from "../../agent/controller.ts";
import type { HistoryQuery } from "../../agent/history-query.ts";

export const descriptorEnv = "PITAKO_AGENTS_UI_DESCRIPTOR";
export { frameBytes, frame, frames } from "../../agent/framing.js";
type ControllerView = ReturnType<ReturnType<typeof createAgentController>["openView"]>;
export type LocalView = Omit<ControllerView,
  "readDetail" | "readRequests" | "readActivity" | "readResult" | "subscribe" | "list"> & {
  list(after?: string): Omit<ReturnType<ControllerView["list"]>, "revision">;
};
export type PaneView = { [K in keyof LocalView]: (...args: Parameters<LocalView[K]>) =>
  ReturnType<LocalView[K]> | Promise<Awaited<ReturnType<LocalView[K]>>> } & {
  connection?(): string;
  reconnect?(): Promise<void>;
};
export interface OwnerFence { processId: string; coordinatorSessionId: string; epoch: string }
export interface Descriptor { version: 1; socket: string; owner: OwnerFence; capability: string }
export type Operation =
  | { op: "list"; after?: string }
  | { op: "detail"; id: string; briefOffset?: number; activityAfter?: number }
  | { op: "requests" | "route"; id: string; offset?: number }
  | { op: "observe"; selection: AgentSelection; options?: { after?: number; limit?: number; briefOffset?: number } }
  | { op: "history"; query: HistoryQuery; worker?: { instanceId: string } }
  | { op: "input"; selection: AgentSelection; input: { intent: "query" | "steer"; text: string; decisionId?: string } }
  | { op: "cancel"; selection: AgentSelection }
  | { op: "acknowledge"; kind: "history" | "route" }
  | { op: "close" };
export interface Request { version: 1; id: number; capability: string; owner: OwnerFence; operation: Operation }
export type Reply = { version: 1; id: number; result: unknown } | { version: 1; id: number; error: string };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const str = (v: unknown, max = 1024): v is string => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= max;
const number = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
export function isOwner(v: unknown): v is OwnerFence {
  return object(v) && keys(v, ["processId", "coordinatorSessionId", "epoch"]) &&
    str(v.processId) && str(v.coordinatorSessionId) && str(v.epoch);
}
export const sameOwner = (a: OwnerFence, b: OwnerFence) =>
  a.processId === b.processId && a.coordinatorSessionId === b.coordinatorSessionId && a.epoch === b.epoch;
export function isDescriptor(v: unknown): v is Descriptor {
  return object(v) && keys(v, ["version", "socket", "owner", "capability"]) && v.version === 1 &&
    str(v.socket, 103) && v.socket.startsWith("/") && !v.socket.includes("\0") &&
    isOwner(v.owner) && typeof v.capability === "string" && /^[a-f0-9]{64}$/.test(v.capability);
}
function selection(v: unknown): v is AgentSelection {
  return object(v) && keys(v, ["processId", "coordinatorSessionId", "epoch", "target", "instanceId", "generation", "historyId", "sessionId"]) &&
    str(v.processId) && str(v.coordinatorSessionId) && str(v.epoch) && str(v.instanceId) && number(v.generation) &&
    str(v.historyId) && str(v.sessionId) && object(v.target) &&
    (v.target.kind === "background" && keys(v.target, ["kind", "instanceId"]) && str(v.target.instanceId) ||
      v.target.kind === "team" && keys(v.target, ["kind", "assignmentId"]) && str(v.target.assignmentId));
}
function history(v: unknown): v is HistoryQuery {
  if (!object(v) || !optional(v.cursor, x => str(x, 2048)) || !optional(v.limit, x => number(x, 20) && x !== 0)) return false;
  if (v.action === "read") return keys(v, ["action", "historyId", "cursor", "limit"]) && str(v.historyId);
  return v.action === "list" && keys(v, ["action", "cursor", "limit"]);
}
export function isOperation(v: unknown): v is Operation {
  if (!object(v)) return false;
  switch (v.op) {
    case "list": return keys(v, ["op", "after"]) && optional(v.after, str);
    case "detail": return keys(v, ["op", "id", "briefOffset", "activityAfter"]) && str(v.id) &&
      optional(v.briefOffset, number) && optional(v.activityAfter, number);
    case "requests": case "route": return keys(v, ["op", "id", "offset"]) && str(v.id) && optional(v.offset, number);
    case "observe": return keys(v, ["op", "selection", "options"]) && selection(v.selection) &&
      optional(v.options, x => object(x) && keys(x, ["after", "limit", "briefOffset"]) &&
        optional(x.after, number) && optional(x.limit, y => number(y, 50) && y !== 0) && optional(x.briefOffset, number));
    case "history": return keys(v, ["op", "query", "worker"]) && history(v.query) &&
      optional(v.worker, x => object(x) && keys(x, ["instanceId"]) && str(x.instanceId));
    case "input": return keys(v, ["op", "selection", "input"]) && selection(v.selection) && object(v.input) &&
      keys(v.input, ["intent", "text", "decisionId"]) && (v.input.intent === "query" || v.input.intent === "steer") &&
      str(v.input.text, 16 * 1024) && !!v.input.text.trim() && optional(v.input.decisionId, str);
    case "cancel": return keys(v, ["op", "selection"]) && selection(v.selection);
    case "acknowledge": return keys(v, ["op", "kind"]) && (v.kind === "history" || v.kind === "route");
    case "close": return keys(v, ["op"]);
    default: return false;
  }
}
export function isRequest(v: unknown): v is Request {
  return object(v) && keys(v, ["version", "id", "capability", "owner", "operation"]) &&
    v.version === 1 && number(v.id) && str(v.capability, 64) && isOwner(v.owner) && isOperation(v.operation);
}
export function isReply(v: unknown): v is Reply {
  return object(v) && v.version === 1 && number(v.id) &&
    (keys(v, ["version", "id", "error"]) && str(v.error, 4096) ||
      keys(v, ["version", "id", "result"]) && Object.hasOwn(v, "result"));
}
