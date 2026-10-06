import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { consultManagedMission, managedAttemptRows } from "../agent/managed-mission.ts";
import { queryHistory, type HistoryPage } from "../agent/history-query.ts";
import { HISTORY_BYTES, HISTORY_FRAGMENT } from "../agent/history-native.ts";
import type { MissionDefinition, MissionEvent, PlanSnapshot } from "./model.ts";

export interface MissionObservationQuery {
  missionId: string;
  unitId?: string;
  attemptId?: string;
  cursor?: string;
}
export interface MissionObservationPage extends HistoryPage {
  authority: "read-only";
  missionId: string;
}
type Reference = { hash: string; fields?: Array<string | number> } | { eventSeq: number };
type Cursor = {
  version: 1; identity: string; throughSeq: number;
  mode: "records" | "text" | "history" | "native";
  offset?: number; reference?: Reference; historyCursor?: string; historyId?: string; groupId?: string;
};
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Host metadata is an observation, not a returned workspace/runtime capability.
// Native text and referenced evidence bytes retain their existing private disclosure policy.
const detailKeys = ["status", "reason", "command", "exitCode", "signal", "stdout", "stderr", "attemptNo",
  "retryOf", "generation", "predicateId", "phase", "outcome", "complete", "pass", "error", "impact",
  "parentRevision", "retained", "repairAuthorized", "operatorText", "disposition", "failureClass",
  "diagnosisId", "attemptId", "unitId", "role", "fingerprint", "controlOrigin", "resumeAfterClose",
  "provider", "model", "usageUnknownReason", "durationMs", "process", "effectsQuiescent",
  "throughSeq", "eventIds", "targetId", "parentAttemptId", "affectedUnits", "roots"] as const;
function eventView(event: MissionEvent) {
  const details = Object.fromEntries(detailKeys.filter((key) => event.payload[key] !== undefined)
    .map((key) => [key, event.payload[key]]));
  const evidence = Object.entries(event.payload).filter(([key, value]) =>
    /Hash$/.test(key) && typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    .map(([field, hash]) => ({ field, hash: String(hash) }));
  return { kind: "host-event", seq: event.seq, eventId: event.eventId, revision: event.revision,
    unitId: event.unitId, attemptId: event.attemptId, action: event.kind, occurredAt: event.occurredAt,
    details, evidence };
}

function decode(token: string | undefined, identity: string, latestSeq: number): Cursor {
  if (token === undefined) return { version: 1, identity, throughSeq: latestSeq, mode: "records", offset: 0 };
  if (token.length > 8192 || !/^[\w-]+$/.test(token)) throw new Error("invalid_cursor");
  let cursor: Cursor;
  try { cursor = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); }
  catch { throw new Error("invalid_cursor"); }
  if (!cursor || cursor.version !== 1 || cursor.identity !== identity ||
      !Number.isSafeInteger(cursor.throughSeq) || cursor.throughSeq < 1 || cursor.throughSeq > latestSeq ||
      !["records", "text", "history", "native"].includes(cursor.mode) ||
      cursor.offset !== undefined && (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) ||
      cursor.historyCursor !== undefined && typeof cursor.historyCursor !== "string" ||
      cursor.mode === "native" && (typeof cursor.historyId !== "string" || !UUID.test(cursor.historyId) ||
        typeof cursor.groupId !== "string" || !UUID.test(cursor.groupId)) ||
      cursor.mode === "text" && (!cursor.reference || typeof cursor.reference !== "object"))
    throw new Error("invalid_cursor");
  return cursor;
}

/** Pure consultation; repositoryRoot comes from the host context, never tool input. */
export async function readMissionObservation(query: MissionObservationQuery,
  repositoryRoot = process.cwd()): Promise<MissionObservationPage> {
  const page: MissionObservationPage = { authority: "read-only", missionId: query.missionId,
    items: [], diagnostics: [], cursor: null };
  try {
    if (Object.keys(query).some((key) => !["missionId", "unitId", "attemptId", "cursor"].includes(key)) ||
        !UUID.test(query.missionId) || [query.unitId, query.attemptId].some((value) =>
          value !== undefined && (typeof value !== "string" || !value || value.length > 200)))
      throw new Error("invalid_selector");
    const identity = digest([realpathSync(repositoryRoot), query.missionId, query.unitId ?? null, query.attemptId ?? null]);
    const observed = await consultManagedMission(repositoryRoot, query.missionId, async (store, mission) => {
      if (!store.dbPath) throw new Error("mission_store_unavailable");
      const storeRoot = path.dirname(store.dbPath);
      const cursor = decode(query.cursor, identity, mission.latestSeq);
      const events = mission.events.filter((event) => event.seq <= cursor.throughSeq);
      const attempts = managedAttemptRows({ ...mission, events });
      const selected = attempts.filter((row) => (!query.unitId || row.unitId === query.unitId) &&
        (!query.attemptId || row.assignmentId === query.attemptId));
      if (query.attemptId && !selected.length) throw new Error("attempt_not_found");
      const diagnosisIds = new Set(events.filter((event) => event.kind === "mission.recovery.diagnosed" &&
        event.payload.attemptId === query.attemptId && event.attemptId).map((event) => event.attemptId));
      const snapshots = events.filter((event) => event.kind === "mission.created" || event.kind === "mission.revised")
        .map((event) => event.payload.snapshot as PlanSnapshot);
      const units = snapshots.flatMap((snapshot) => snapshot.units);
      if (query.unitId && !units.some((unit) => unit.id === query.unitId)) throw new Error("unit_not_found");
      const relevant = (event: MissionEvent) => (!query.unitId || !event.unitId || event.unitId === query.unitId) &&
        (!query.attemptId || !event.attemptId || event.attemptId === query.attemptId || diagnosisIds.has(event.attemptId));
      const references = new Map<string, Reference>();
      const ref = (reference: Reference) => {
        references.set(JSON.stringify(reference), reference);
        return { ...reference, readCursor: encode({ ...cursor, mode: "text", offset: 0, reference,
          historyId: undefined, historyCursor: undefined }) };
      };
      const rows: unknown[] = [{ kind: "mission", id: mission.id, planId: mission.planId,
        revision: mission.revision, state: mission.state, throughSeq: cursor.throughSeq,
        sourcePin: mission.snapshot.sourceBinding,
        guidance: "Compare original assignments with observed actions. Findings are advisory. Use a discriminating check or recommend an exact /mission pause or revise; observation grants no control or repair authority." }];
      for (const snapshot of snapshots) {
        rows.push({ kind: "revision", ...snapshot, units: undefined, plan: ref({ hash: snapshot.planHash }),
          definition: ref({ hash: snapshot.definitionHash }) });
        if (snapshot.preparedHash) rows.push({ kind: "original-source", revision: snapshot.revision,
          source: ref({ hash: snapshot.preparedHash, fields: ["originalSource"] }) });
        const definition = JSON.parse(store.readArtifact(snapshot.definitionHash).toString("utf8")) as MissionDefinition;
        for (const [index, unit] of definition.units.entries()) {
          if (query.unitId && unit.id !== query.unitId ||
              query.attemptId && !selected.some((attempt) => attempt.unitId === unit.id)) continue;
          rows.push({ kind: "assignment", revision: snapshot.revision, unitId: unit.id, parentId: unit.parentId,
            role: unit.role, originalIntent: unit.originalIntent ? {
              sourceId: unit.originalIntent.sourceId,
              objective: ref({ hash: snapshot.definitionHash, fields: ["units", index, "originalIntent", "objective"] }),
              workBrief: ref({ hash: snapshot.definitionHash, fields: ["units", index, "originalIntent", "workBrief"] }),
              criteria: ref({ hash: snapshot.definitionHash, fields: ["units", index, "originalIntent", "criteria"] }),
            } : null });
          if (!unit.originalIntent) page.diagnostics.push({ code: "original_intent_unavailable",
            detail: `revision ${snapshot.revision}, unit ${unit.id}: legacy definition; do not reconstruct original prose from commentary` });
        }
      }
      for (const attempt of selected) {
        const reservation = events.find((event) => event.kind === "attempt.reserved" && event.attemptId === attempt.assignmentId)!;
        const binding = reservation.payload.binding as Record<string, unknown> | undefined;
        const retry = [...events].reverse().find((event) => event.seq < reservation.seq && event.kind === "unit.ready" &&
          event.unitId === reservation.unitId && typeof event.payload.retryOf === "string");
        rows.push({ kind: "attempt", ...attempt, revision: reservation.revision, reservedEventId: reservation.eventId,
          briefHash: binding?.briefHash, continuationOf: binding?.continuationOf, recoveryOf: binding?.recoveryOf,
          retryOf: retry?.payload.retryOf, rolePolicyHash: binding?.rolePolicyHash,
          reservedBrief: typeof binding?.briefArtifactHash === "string" ? ref({ hash: binding.briefArtifactHash }) : null });
        if (!binding?.briefArtifactHash) page.diagnostics.push({ code: "reserved_brief_unavailable", detail: attempt.assignmentId });
      }
      for (const event of events.filter(relevant)) {
        const view = eventView(event);
        rows.push({ ...view, details: undefined, detailsRef: ref({ eventSeq: event.seq }),
          evidence: view.evidence.map(({ field, hash }) => ({ field, ...ref({ hash }) })) });
      }
      if (cursor.mode === "text") {
        const reference = references.get(JSON.stringify(cursor.reference));
        if (!reference) throw new Error("unbound_evidence_reference");
        let bytes: Buffer;
        try {
          if ("eventSeq" in reference) bytes = Buffer.from(JSON.stringify(eventView(events.find((event) => event.seq === reference.eventSeq)!)));
          else {
            bytes = store.readArtifact(reference.hash);
            if (reference.fields) {
              let value: unknown = JSON.parse(bytes.toString("utf8"));
              for (const field of reference.fields) value = (value as Record<string | number, unknown>)[field];
              if (value === undefined) throw new Error("reference field unavailable");
              bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
            }
          }
        } catch (error) {
          page.diagnostics.push({ code: "evidence_unavailable", detail: String(error) }); return page;
        }
        const offset = cursor.offset ?? 0;
        if (offset > bytes.length) throw new Error("invalid_cursor");
        const fragment = bytes.subarray(offset, offset + HISTORY_FRAGMENT);
        page.items.push({ kind: "evidence-bytes", reference, byteOffset: offset, encoding: "base64",
          data: fragment.toString("base64"), totalBytes: bytes.length });
        if (offset + fragment.length < bytes.length) page.cursor = encode({ ...cursor, offset: offset + fragment.length });
        if (!bytes.length) page.diagnostics.push({ code: "evidence_empty" });
      } else if (cursor.mode === "records") {
        let index = cursor.offset ?? 0;
        if (index > rows.length) throw new Error("invalid_cursor");
        while (index < rows.length && page.items.length < 50) {
          const next = rows[index];
          const continuation = encode({ ...cursor, offset: index + 1 });
          if (Buffer.byteLength(JSON.stringify({ ...page, items: [...page.items, next], cursor: continuation })) > HISTORY_BYTES - 4096) {
            if (!page.items.length) throw new Error("summary_limit");
            break;
          }
          page.items.push(next); index++;
        }
        page.cursor = encode(index < rows.length ? { ...cursor, offset: index } :
          { ...cursor, mode: "history", offset: undefined });
      } else {
        const listing = { action: "list" as const, missionId: mission.id, unitId: query.unitId };
        const matchingMember = (item: Record<string, unknown>) => !query.attemptId ||
          item.attemptId === query.attemptId || item.diagnosisOf === query.attemptId;
        if (cursor.mode === "history") {
          const history = await queryHistory({ ...listing, cursor: cursor.historyCursor, limit: 20 });
          page.diagnostics.push(...history.diagnostics);
          for (const item of history.items as Array<Record<string, unknown>>) {
            if (!matchingMember(item)) continue;
            const group = item.group as { identity?: { storeRoot?: string } } | undefined;
            if (group?.identity?.storeRoot !== storeRoot) {
              page.diagnostics.push({ code: "history_identity_mismatch" }); continue;
            }
            page.items.push({ ...item, kind: "native-history", ...(item.historyId ? { readCursor: encode({ ...cursor,
              mode: "native", historyId: String(item.historyId), groupId: String(item.groupId), historyCursor: undefined }) } : {}) });
          }
          if (history.cursor) page.cursor = encode({ ...cursor, historyCursor: history.cursor });
          if (!history.items.length && !history.cursor) page.diagnostics.push({ code: "history_membership_unavailable",
            detail: "No retained matching member; not proof of no activity." });
        } else {
          // Recheck the catalog admission and store identity; arbitrary history IDs are not mission selectors.
          let found = false;
          let continuation: string | undefined;
          do {
            const history = await queryHistory({ ...listing, cursor: continuation });
            for (const item of history.items as Array<Record<string, unknown>>) {
              const group = item.group as { identity?: { storeRoot?: string } } | undefined;
              if (matchingMember(item) && item.historyId === cursor.historyId && item.groupId === cursor.groupId &&
                  group?.identity?.storeRoot === storeRoot) found = true;
            }
            continuation = history.cursor ?? undefined;
          } while (!found && continuation);
          if (!found) throw new Error("history_membership_unavailable");
          const history = await queryHistory({ action: "read", historyId: cursor.historyId!, groupId: cursor.groupId,
            cursor: cursor.historyCursor, limit: 20 });
          page.items = history.items;
          page.diagnostics.push(...history.diagnostics);
          if (history.cursor) page.cursor = encode({ ...cursor, historyCursor: history.cursor });
        }
      }
      return page;
    });
    if (!observed) throw new Error("mission_not_bound_to_repository");
    if (!page.diagnostics.length) page.diagnostics.push({ code: "ok" });
  } catch (error) {
    page.items = []; page.cursor = null;
    page.diagnostics = [{ code: error instanceof Error ? error.message.slice(0, 200) : "observation_unavailable" }];
  }
  if (page.diagnostics.length > 16) page.diagnostics = [...page.diagnostics.slice(0, 15),
    { code: "diagnostic_preview_limit", detail: `${page.diagnostics.length} diagnostics; select a unit/attempt for detail` }];
  page.diagnostics = page.diagnostics.map((row) => ({ ...row,
    ...(row.detail ? { detail: row.detail.slice(0, 1024) } : {}) }));
  return page;
}

export function parseMissionInspect(args: string): Omit<MissionObservationQuery, "missionId"> & { missionId?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.shift() !== "inspect" || args.length > 16384) throw new Error("invalid inspect command");
  const query: Record<string, string> = {};
  if (parts[0] && !parts[0].startsWith("--")) query.missionId = parts.shift()!;
  while (parts.length) {
    const flag = parts.shift()!;
    const key = ({ "--unit": "unitId", "--attempt": "attemptId", "--cursor": "cursor" } as Record<string, string>)[flag];
    const value = parts.shift();
    if (!key || !value || value.startsWith("--") || query[key] !== undefined) throw new Error("invalid inspect flag");
    query[key] = value;
  }
  return query;
}
