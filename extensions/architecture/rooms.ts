import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { teamEvaluationForSession, type TeamEvaluation, type TeamAssignment } from "../team.ts";
import type { AgentRunResult } from "../agent/run.ts";
import type { Consultation } from "./runtime.ts";
import type { KnowledgeBoundary } from "./protocol.ts";
import type { Message, Stage, Body } from "./types.ts";
import type { ArchitectureRecord, ArchitectureLifecycle } from "../agent/bridge/protocol.js";

type Identity = { assignmentId: string; memberId: string; instanceId: string };
export interface ArchitectureRoom {
  evaluation: TeamEvaluation;
  roomId: string;
  assignmentId: string;
  instanceId: string;
  runtime?: Consultation;
  records: Map<string, ArchitectureRecord>;
  lifecycle: ArchitectureLifecycle;
  capture: { state: "open" | "closed" | "incomplete"; finalCut: number | null; gaps: ("not_captured" | "capture_failed")[] };
  mode: "table" | "consultation";
  director: Identity;
  preparationSettled: boolean;
  runtimeCreated: boolean;
  candidate?: { result: AgentRunResult; body: Extract<Body, { kind: "synthesis" }> };
  controlOrder: number;
  captureComplete: boolean;
}
const KEY = Symbol.for("pitako.architectureRooms");
interface Registry {
  rooms: Map<symbol, Map<string, ArchitectureRoom>>;
  listeners: Set<(evaluation: TeamEvaluation) => void>;
}
const host = globalThis as Record<symbol, Registry | undefined>;
const { rooms, listeners } = (host[KEY] ??= { rooms: new Map(), listeners: new Set() });
export function subscribeArchitectureChanges(listener: (evaluation: TeamEvaluation) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const live = (room: ArchitectureRoom) => teamEvaluationForSession(room.evaluation.sessionId, false)?.token === room.evaluation.token;
function changed(room: ArchitectureRoom) {
  for (const listener of listeners) try { listener(room.evaluation); } catch { /* Passive listener. */ }
}
/** Observer boundaries never participate in execution decisions. */
export function captureArchitecture(room: ArchitectureRoom | undefined, write: (room: ArchitectureRoom) => void) {
  if (!room || !live(room)) return;
  try { write(room); }
  catch {
    room.capture.state = "incomplete";
    if (!room.records.has("final") && room.preparationSettled) room.lifecycle.outcome = "unavailable";
    if (!room.capture.gaps.includes("capture_failed")) room.capture.gaps.push("capture_failed");
  }
  changed(room);
}
export function architectureRooms(evaluation: TeamEvaluation | undefined): ArchitectureRoom[] {
  return evaluation ? [...rooms.get(evaluation.token)?.values() ?? []] : [];
}
export function architectureRoom(evaluation: TeamEvaluation, id: string) { return rooms.get(evaluation.token)?.get(id); }
export function retireArchitectureRooms(evaluation: TeamEvaluation) { rooms.delete(evaluation.token); }
export function registerArchitectureRoom(input: { evaluation: TeamEvaluation; roomId: string; mode: "table" | "consultation";
  director: Identity; toolCallId: string }): ArchitectureRoom {
  const room: ArchitectureRoom = { ...input, assignmentId: input.director.assignmentId, instanceId: input.director.instanceId,
    records: new Map(), preparationSettled: false, runtimeCreated: false, controlOrder: 0, captureComplete: false,
    capture: { state: "open", finalCut: null, gaps: [] },
    lifecycle: { stage: null, round: 0, protocolState: "starting", outcome: "pending",
      closure: { state: "pending", members: "pending", director: "pending" } } };
  let catalog = rooms.get(input.evaluation.token);
  if (!catalog) { catalog = new Map(); rooms.set(input.evaluation.token, catalog); }
  catalog.set(input.roomId, room);
  captureArchitecture(room, () => room.records.set(input.roomId, { kind: "room", id: input.roomId, mode: input.mode,
    origin: { coordinatorSessionId: input.evaluation.sessionId, tool: "architecture_start", toolCallId: input.toolCallId, ...input.director },
    goalSource: { kind: "worker-workbrief", instanceId: input.director.instanceId }, lifecycle: room.lifecycle, pendingDoubtIds: [] }));
  return room;
}
export function observeArchitectureAssignment(evaluation: TeamEvaluation, assignment: TeamAssignment) {
  const room = architectureRoom(evaluation, assignment.teamId);
  captureArchitecture(room, room => {
    const prior = room.records.get(assignment.memberId);
    const director = assignment.id === room.assignmentId;
    room.records.set(assignment.memberId, { ...(prior?.kind === "member" ? prior : {}), kind: "member", id: assignment.memberId,
      assignmentId: assignment.id, instanceId: assignment.instanceId, roleId: assignment.roleId,
      function: director ? "director" : prior?.kind === "member" ? prior.function : "specialist", ordinal: assignment.ordinal, admittedAt: assignment.admittedAt,
      mandate: director ? { source: "root-workbrief", instanceId: assignment.instanceId } : { source: "TeamAssignment.task", text: assignment.task },
      execution: prior?.kind === "member" ? prior.execution : "accepted", conversationRefs: prior?.kind === "member" ? prior.conversationRefs : [] });
  });
}
export function architecturePublication(room: ArchitectureRoom | undefined, message: Message) {
  captureArchitecture(room, room => room.records.set(message.id, { kind: "publication", id: message.id, message: structuredClone(message) }));
}
export function architectureKnowledge(room: ArchitectureRoom | undefined, boundary: KnowledgeBoundary) {
  captureArchitecture(room, room => room.records.set(boundary.id, structuredClone(boundary)));
}
export function architectureFailure(room: ArchitectureRoom | undefined, phase: "preparation" | "admission" | "turn" | "disband" | "director-close", error: unknown,
  context: { memberId?: string; assignmentId?: string; stage?: Stage; round?: number } = {}) {
  captureArchitecture(room, room => {
    const id = randomUUID();
    room.records.set(id, { kind: "failure", id, phase, error: String(error), ...context });
    const member = context.memberId && room.records.get(context.memberId);
    if (member && member.kind === "member") member.execution = "failed";
  });
}
export function architectureProgress(room: ArchitectureRoom | undefined, stage: ArchitectureLifecycle["stage"],
  round: number, protocolState: ArchitectureLifecycle["protocolState"], pendingDoubtIds?: string[]) {
  captureArchitecture(room, room => {
    Object.assign(room.lifecycle, { stage, round, protocolState });
    const record = room.records.get(room.roomId);
    if (record?.kind === "room" && pendingDoubtIds) record.pendingDoubtIds = [...pendingDoubtIds];
  });
}
export function architectureMember(room: ArchitectureRoom | undefined, memberId: string, purpose: "specialist" | "support",
  compositionMessageId?: string, supersededByCompositionId?: string) {
  captureArchitecture(room, room => {
    const member = room.records.get(memberId);
    if (member?.kind !== "member") return;
    member.function = purpose;
    if (compositionMessageId) member.compositionMessageId = compositionMessageId;
    if (supersededByCompositionId) member.supersededByCompositionId = supersededByCompositionId;
  });
}
export function architectureControl(room: ArchitectureRoom | undefined, action: "context" | "priorities" | "finish" | "stop",
  text: string | undefined, toolCallId: string): string | undefined {
  let id: string | undefined;
  captureArchitecture(room, room => {
    id = randomUUID();
    room.records.set(id, { kind: "control", id, order: ++room.controlOrder, action, ...(text === undefined ? {} : { text }),
      author: { coordinatorSessionId: room.evaluation.sessionId, toolCallId }, application: { state: "pending" } });
  });
  return id;
}
export function architectureControlApplied(room: ArchitectureRoom | undefined, ids: (string | undefined)[], stage: ArchitectureLifecycle["stage"], round: number) {
  captureArchitecture(room, room => {
    for (const id of ids) {
      const control = id && room.records.get(id);
      if (control && control.kind === "control") control.application = { state: "applied", stage, round };
    }
  });
}
export function architectureCandidate(room: ArchitectureRoom | undefined, result: AgentRunResult, body: Extract<Body, { kind: "synthesis" }>) {
  captureArchitecture(room, room => { room.candidate = { result, body: structuredClone(body) }; });
}
export function architectureMembersClosed(room: ArchitectureRoom | undefined, error?: unknown) {
  captureArchitecture(room, room => { room.lifecycle.closure.members = error ? "unknown" : "released"; });
  if (error) architectureFailure(room, "disband", error);
}
/** Nonconsuming facts, emitted again after preparation's finally. */
export function observeArchitectureBackground(fact: { token?: symbol; teamId?: string; instanceId: string;
  workerStarted?: boolean; preparationSettled?: boolean; closure: { state: "pending" | "released" | "unknown" };
  result?: AgentRunResult; selectedDriver?: AgentRunResult; running?: boolean }) {
  const room = fact.token && fact.teamId ? rooms.get(fact.token)?.get(fact.teamId) : undefined;
  captureArchitecture(room, room => {
    const member = [...room.records.values()].find(record => record.kind === "member" && record.instanceId === fact.instanceId);
    if (member?.kind === "member" && !(member.execution === "failed" && fact.result?.status === "completed"))
      member.execution = fact.result?.status ?? (fact.running ? "running" : member.execution);
    if (fact.instanceId !== room.instanceId) return;
    room.preparationSettled ||= fact.preparationSettled === true;
    if (fact.result) {
      const selected = fact.selectedDriver && room.candidate?.result === fact.selectedDriver ? room.candidate : undefined;
      room.records.set("final", { kind: "outcome", id: "final", source: "background-settlement", status: fact.result.status,
        content: selected ? { kind: "synthesis", body: structuredClone(selected.body) } : { kind: "text", text: fact.result.result } });
      room.lifecycle.outcome = "available";
      room.lifecycle.protocolState = fact.closure.state === "unknown" ? "closure-unknown" : fact.result.status === "completed" ? "finished" : fact.result.status;
    }
    if (fact.closure.state === "unknown") {
      room.lifecycle.closure.director = "unknown";
      room.lifecycle.closure.state = "unknown";
      if (!room.runtimeCreated) room.lifecycle.closure.members = "unknown";
    } else if (fact.workerStarted === false && room.preparationSettled && !room.runtimeCreated) {
      room.lifecycle.closure = { state: "released", members: "not-created", director: "not-created" };
    } else {
      if (fact.workerStarted && fact.closure.state === "released") room.lifecycle.closure.director = "released";
      const closure = room.lifecycle.closure;
      if (room.preparationSettled && closure.members === "released" && closure.director === "released") closure.state = "released";
    }
    if (fact.result && room.preparationSettled) {
      room.captureComplete = true;
      if (room.capture.state !== "incomplete") room.capture.state = "closed";
    }
  });
}

/** Frozen export storage; independent of the unbounded running authority. */
export function createArchitectureSnapshots(owner: import("../agent/bridge/protocol.js").Owner,
  limits = { snapshotBytes: 4 * 1024 * 1024, ownerBytes: 32 * 1024 * 1024, ttl: 5 * 60_000 }, now = Date.now) {
  type Snapshot = { id: string; view: string; room: string | null; created: number; cut: number; bytes: number;
    records: Buffer[]; header: Record<string, unknown> };
  const snapshots = new Map<string, Snapshot>(), secret = randomBytes(32);
  const expire = () => { for (const [id, snapshot] of snapshots) if (now() - snapshot.created >= limits.ttl) snapshots.delete(id); };
  const sign = (data: string) => createHmac("sha256", secret).update(data).digest("base64url");
  const cursor = (snapshot: Snapshot, index: number, offset: number) => {
    const data = Buffer.from(JSON.stringify({ owner, view: snapshot.view, room: snapshot.room, id: snapshot.id, index, offset })).toString("base64url");
    return `${data}.${sign(data)}`;
  };
  return {
    clear() { snapshots.clear(); },
    view() {
      const view = randomUUID();
      return {
        close() { for (const [id, snapshot] of snapshots) if (snapshot.view === view) snapshots.delete(id); },
        read(room: string | null, continuation: string | undefined, cut: number, source: () => { header: Record<string, unknown>; records: unknown[] } | undefined, byteBudget = 40 * 1024) {
          expire();
          let snapshot: Snapshot | undefined, index = 0, offset = 0;
          if (continuation !== undefined) {
            try {
              const [data, signature, extra] = continuation.split(".");
              if (!data || !signature || extra !== undefined || Buffer.byteLength(signature) !== Buffer.byteLength(sign(data)) ||
                  !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(data)))) throw new Error();
              const decoded = JSON.parse(Buffer.from(data, "base64url").toString());
              if (JSON.stringify(decoded.owner) !== JSON.stringify(owner) || decoded.view !== view || decoded.room !== room ||
                  !Number.isSafeInteger(decoded.index) || decoded.index < 0 || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error();
              snapshot = snapshots.get(decoded.id);
              if (!snapshot) throw new Error("stale_cursor");
              index = decoded.index; offset = decoded.offset;
              if (index > snapshot.records.length || offset && (index === snapshot.records.length || offset >= snapshot.records[index]!.length)) throw new Error();
            } catch (error) { throw new Error(error instanceof Error && error.message === "stale_cursor" ? "stale_cursor" : "invalid_cursor"); }
          } else {
            const observed = source();
            if (!observed) return { state: "unavailable" as const, reason: room === null ? "not_captured" as const : "unknown_room" as const };
            const records = observed.records.map(record => Buffer.from(JSON.stringify(record)));
            const bytes = records.reduce((sum, record) => sum + record.length, Buffer.byteLength(JSON.stringify(observed.header)));
            const old = [...snapshots.values()].find(snapshot => snapshot.view === view && (snapshot.room === null) === (room === null));
            const total = [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.bytes, 0);
            if (bytes > limits.snapshotBytes || total - (old?.bytes ?? 0) + bytes > limits.ownerBytes)
              return { state: "unavailable" as const, reason: "snapshot_oversized" as const };
            snapshot = { id: randomUUID(), view, room, cut, bytes, records, header: structuredClone(observed.header), created: now() };
            if (old) snapshots.delete(old.id);
            snapshots.set(snapshot.id, snapshot);
          }
          const key = room === null ? "items" : "records";
          const page: Record<string, unknown> = { format: "architecture-public-v1", state: "ready", ...snapshot.header,
            snapshotId: snapshot.id, cut: snapshot.cut, [key]: [], next: null };
          if (Buffer.byteLength(JSON.stringify(page)) > Math.min(40 * 1024, byteBudget)) throw new RangeError("Architecture envelope exceeds page budget");
          const items: unknown[] = [];
          const fits = (item: unknown, nextIndex: number, nextOffset: number) => Buffer.byteLength(JSON.stringify({ ...page, [key]: [...items, item],
            next: nextIndex < snapshot!.records.length ? cursor(snapshot!, nextIndex, nextOffset) : null })) <= Math.min(40 * 1024, byteBudget);
          while (index < snapshot.records.length) {
            const bytes = snapshot.records[index]!;
            const record = JSON.parse(bytes.toString());
            if (!offset && fits(record, index + 1, 0)) { items.push(record); index++; continue; }
            if (room === null) {
              if (!items.length) return { state: "unavailable" as const, reason: "snapshot_oversized" as const };
              break;
            }
            let count = Math.min(12 * 1024, bytes.length - offset);
            let fragment: unknown;
            while (count > 0) {
              fragment = { kind: "fragment", recordId: record.id, encoding: "base64-json", byteOffset: offset, totalBytes: bytes.length,
                data: bytes.subarray(offset, offset + count).toString("base64") };
              const complete = offset + count === bytes.length;
              if (fits(fragment, complete ? index + 1 : index, complete ? 0 : offset + count)) break;
              count = Math.floor(count / 2);
            }
            if (!count) { if (!items.length) throw new RangeError("Architecture envelope exceeds page budget"); break; }
            items.push(fragment); offset += count;
            if (offset === bytes.length) { index++; offset = 0; }
          }
          return { ...page, [key]: items, next: index < snapshot.records.length ? cursor(snapshot, index, offset) : null };
        },
      };
    },
  };
}
