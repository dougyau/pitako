import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resourceAllocations, resourceLimit, assertSupportedResourcePolicy, RESOURCE_FIELDS, meteredConsumptions } from "./resources.ts";
import { getPitakoDataDir } from "../board/paths.ts";
import { currentWorkspace, registeredWorktrees, repositoryIdentity } from "../board/workspace.ts";
import { openSqlite, type SqlDatabase } from "../board/sqlite.ts";
import { assertPlanId, isGeneratedMissionLedger, parsePlanDocument, planHash, verifyExecutionBinding } from "../workflow.ts";
import {
  isUuid,
  sha256,
  validateEvaluationObservation,
  validateMeasurement,
  validateMissionDefinitionBytes,
  type EvaluationObservation,
  type MissionDefinition,
  type MissionEvent,
  type MissionMeasurement,
  type MissionRecord,
  type PlanSnapshot,
} from "./model.ts";
import { currentProcessIdentity, ownerProcessState, verifyPrivateCandidate, type ProcessIdentity } from "./workspace.ts";
import { missionCorrectionNo, reduceMissionEvent, reduceMissionEvents, type MissionAttemptBinding } from "./engine.ts";
import { assessMissionCompletion, missionCompletionBlockers, physicalResultBinding } from "./completion.ts";
import { importedHoldReconciled, validLegacyHoldProof } from "./reconcile.ts";
import { assertPreparedAdmission, consumePreparedAdmission, type PreparedMission } from "./preparation.ts";
import { setupRequiredBy } from "./setup.ts";

export const MISSION_STORE_SCHEMA_VERSION = 2;
const EVENT_SCHEMA_VERSION = 1;
const PROCESS_RUNTIME_ID = randomUUID();
export const EVENT_KINDS = new Set([
  "mission.created", "reservation.created", "measurement.recorded", "evaluation.observed",
  "mission.activated", "mission.result.integrated", "mission.completed", "mission.blocked", "mission.active.duration",
  "mission.finalization.generation", "mission.finalization.phase.started", "mission.finalization.phase.receipted",
  "mission.finalization.invalidated", "mission.finalization.reviewed", "mission.finalization.output.inconclusive", "mission.finalization.published",
  "unit.ready", "unit.verifying", "unit.accepted", "unit.blocked", "evidence.recorded", "team.member.recorded", "team.barrier.recorded",
  "team.consultation.admitted", "team.consultation.denied", "team.consultation.resolved", "team.consultation.cancelled", "team.consultation.revalidated",
  "attempt.reserved", "attempt.started", "attempt.receipt", "attempt.settled",
  "provider.request.dispatched", "provider.request.receipt", "budget.reservation.adjusted",
  "budget.reservation.settled", "budget.admission.fenced", "provider.usage.claimed",
  "resource.metered.admitted", "resource.metered.settled",
  "mission.active.window.opened", "mission.active.window.checkpointed", "mission.active.window.closed",
  "resource.wait", "dispatch.observed",
  "effect.denied", "effect.intent", "effect.invoking", "effect.process.registered", "effect.released", "effect.receipt", "effect.unknown", "effect.observation.recorded",
  "attempt.interrupted", "mission.owner.released",
  "mission.setup.intent", "mission.setup.invoking", "mission.setup.receipt", "mission.setup.reconciled", "mission.setup.reused",
  "workspace.snapshot.sealed", "workspace.candidate.registered", "workspace.candidate.relocated",
  "mission.recovery.recorded", "mission.recovery.diagnosed", "mission.recovery.continuation",
  "mission.recovery.continuation.recorded", "mission.recovery.repair.authorized", "mission.recovery.repair.started", "mission.recovery.repair.settled",
  "mission.imported", "mission.import.conflict", "mission.hold.reconciled", "evidence.invalidated", "evidence.reused", "effect.reconciled",
  "mission.revised", "mission.paused", "mission.resumed", "mission.cancelled", "mission.input.recorded", "mission.input.visible", "mission.notification.delivered",
]);
const OBJECT_HASH = /^[0-9a-f]{64}$/;

export class MissionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionStoreError";
  }
}

type CrashBoundary = "object.after-temp-sync" | "object.after-rename" | "mission.create.before-commit" | "mission.create.after-commit" |
  "completion.after-publication" | "completion.before-commit" | "completion.after-commit";
interface WriterClaim {
  id: string;
  epoch: number;
  owner: ProcessIdentity;
}

interface StoredWriterOwner {
  claimId: string;
  epoch: number;
  owner: ProcessIdentity;
}

interface WriterRetirementAck {
  claimId: string;
  epoch: number;
  owner: ProcessIdentity;
  eventId: string;
}

export interface MissionStoreOptions {
  dbPath?: string;
  objectDir?: string;
  readOnly?: boolean;
  /** Host admission recheck at writer acquisition, before any ownership mutation. */
  admitWriter?: (observation?: MissionStore) => void;
  /** Foreground history snapshot only. Never applies to the engine/writer. */
  historyReadBudget?: { databaseBytes: number; objectBytes: number };
  /** Test-only process-crash seam. Production callers must not set this. */
  onDurabilityBoundary?: (boundary: CrashBoundary) => void;
}

interface MissionCreateBase {
  repositoryRoot: string;
  planId: string;
  commandId: string;
  admissionReceiptId: string;
  operatorText?: string;
  operatorReceipt?: import("./admission.ts").OperatorReceipt;
  missionId?: string;
  occurredAt?: string;
}
export type MissionCreateInput = MissionCreateBase & (
  { planFile: string; definitionFile: string; prepared?: never } |
  { prepared: PreparedMission; planFile?: never; definitionFile?: never }
);

export interface MissionInspection extends MissionRecord {
  prepared?: PreparedMission;
  planBytes: Buffer;
  definitionBytes: Buffer;
  events: MissionEvent[];
  reservations: Reservation[];
  measurements: MissionMeasurement[];
  evaluations: EvaluationObservation[];
}

export interface ManagedTargetClaim {
  mission: MissionInspection;
  targetKind: "repository" | "candidate";
  candidateId?: string;
  physicalRoot: string;
  rootIdentity: string;
  gitIdentity: string;
}

export interface Reservation {
  id: string;
  missionId: string;
  revision: number;
  resource: string;
  grantAmount: number;
  amount: number;
  knownCharge: number;
  unknownCharge: number;
  remainingHold: number;
  released: number;
  overage: number;
  eventId: string;
  purpose?: "ordinary" | "protected" | "finalization";
}

export interface MissionEventDraft {
  revision: number;
  kind: string;
  causalId: string;
  occurredAt?: string;
  monotonicDurationMs?: number | null;
  unitId?: string | null;
  attemptId?: string | null;
  effectId?: string | null;
  teamRoundId?: string | null;
  reason?: string | null;
  provenance?: Record<string, unknown> | null;
  payload: Record<string, unknown>;
}

export interface MissionTransition {
  events: MissionEventDraft[];
  artifacts?: Array<{ bytes: Uint8Array; mediaType: string }>;
}

export interface LegacyHoldPreview {
  raw: string;
  assignmentId?: string;
  unitId?: string;
  status?: string;
  disposition: "unresolved" | "unknown";
}

export interface LegacyImportPreview {
  format: "legacy-import-preview-v1";
  planId: string;
  planHash: string;
  ledgerHash: string;
  evidence: Array<{ path: string; hash: string; bytesBase64: string }>;
  rawPlanBase64: string;
  rawLedgerBase64: string;
  holds: LegacyHoldPreview[];
  holdsKnown: boolean;
  generatedLedger: boolean;
  warnings: string[];
}

export interface LegacyImportArchive {
  importKey: string;
  preview: LegacyImportPreview;
  rawPlan: Uint8Array;
  rawLedger: Uint8Array;
  evidence: Array<{ path: string; bytes: Uint8Array }>;
}

export interface MissionExport {
  directory: string;
  manifestPath: string;
  databasePath: string;
  missionId: string;
  eventSeq: number;
}

const SCHEMA = [
  `CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `INSERT INTO store_meta (key, value) VALUES ('owner_epoch', '0')`,
  `INSERT INTO store_meta (key, value) VALUES ('owner_claim_id', '')`,
  `INSERT INTO store_meta (key, value) VALUES ('owner_claim_owner', '')`,
  `INSERT INTO store_meta (key, value) VALUES ('owner_release_ack', '')`,
  `INSERT INTO store_meta (key, value) VALUES ('owner_acquisition_proof', '')`,
  `CREATE TABLE repositories (
    repository_id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE repository_locations (
    canonical_path TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
    kind TEXT NOT NULL CHECK (kind IN ('common', 'worktree')),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE objects (
    hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL CHECK (size >= 0),
    media_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE missions (
    mission_id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
    plan_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'running', 'reconciling', 'pausing', 'paused', 'blocked', 'awaiting_human', 'completing', 'completed', 'cancelled')),
    version INTEGER NOT NULL CHECK (version >= 1),
    latest_seq INTEGER NOT NULL CHECK (latest_seq >= 1),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE revisions (
    mission_id TEXT NOT NULL REFERENCES missions(mission_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    plan_hash TEXT NOT NULL,
    definition_hash TEXT NOT NULL REFERENCES objects(hash),
    source_path TEXT NOT NULL,
    parent_revision INTEGER,
    admission_json TEXT NOT NULL,
    unit_mapping_json TEXT NOT NULL,
    PRIMARY KEY (mission_id, revision),
    FOREIGN KEY (plan_hash) REFERENCES objects(hash)
  )`,
  `CREATE TABLE units (
    mission_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    unit_id TEXT NOT NULL,
    parent_id TEXT,
    definition_json TEXT NOT NULL,
    PRIMARY KEY (mission_id, revision, unit_id),
    FOREIGN KEY (mission_id, revision) REFERENCES revisions(mission_id, revision)
  )`,
  `CREATE TABLE mission_events (
    event_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(mission_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    seq INTEGER NOT NULL CHECK (seq >= 1),
    schema_version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    causal_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    runtime_id TEXT NOT NULL,
    monotonic_duration_ms REAL,
    unit_id TEXT,
    attempt_id TEXT,
    effect_id TEXT,
    team_round_id TEXT,
    reason TEXT,
    provenance_json TEXT,
    payload_json TEXT NOT NULL,
    UNIQUE (mission_id, seq)
  )`,
  `CREATE TABLE reservations (
    reservation_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(mission_id),
    revision INTEGER NOT NULL,
    resource TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    event_id TEXT NOT NULL UNIQUE REFERENCES mission_events(event_id),
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE measurements (
    measurement_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(mission_id),
    revision INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE REFERENCES mission_events(event_id),
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE evaluation_observations (
    observation_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(mission_id),
    revision INTEGER NOT NULL,
    supersedes_id TEXT,
    event_id TEXT NOT NULL UNIQUE REFERENCES mission_events(event_id),
    payload_json TEXT NOT NULL
  )`,
  `CREATE INDEX mission_events_mission_seq ON mission_events(mission_id, seq)`,
  `CREATE INDEX repository_locations_family ON repository_locations(repository_id, kind)`,
  `CREATE INDEX observations_mission_revision ON evaluation_observations(mission_id, revision)`,
  `CREATE UNIQUE INDEX active_mission_per_repository_plan ON missions(repository_id, plan_id) WHERE state NOT IN ('completed', 'cancelled')`,
  `CREATE UNIQUE INDEX measurement_causal_fact ON mission_events(mission_id, causal_id) WHERE kind = 'measurement.recorded'`,
];

export async function openMissionStore(options: MissionStoreOptions = {}): Promise<MissionStore> {
  if (options.historyReadBudget && !options.readOnly) throw new MissionStoreError("history budget requires read-only store");
  const dataDir = getPitakoDataDir();
  const dbPath = path.resolve(options.dbPath ?? path.join(dataDir, "missions.db"));
  const objectDir = path.resolve(options.objectDir ?? path.join(dataDir, "missions", "objects"));
  const existed = existsSync(dbPath);
  if (options.readOnly && !existed) throw new MissionStoreError(`mission database does not exist: ${dbPath}`);
  if (options.historyReadBudget) {
    let size = 0;
    for (const file of [dbPath, `${dbPath}-wal`]) {
      try { size += statSync(file).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (size > options.historyReadBudget.databaseBytes) throw new MissionStoreError("history_authority_limit");
  }
  if (!options.readOnly) ensureDirectory(path.dirname(dbPath));
  if (existed) validateSqliteFile(dbPath);

  let db: SqlDatabase;
  try {
    if (options.readOnly) {
      db = await openSqlite(dbPath, { readOnly: true });
      validateExistingDatabase(db, dbPath);
      return new MissionStore(db, objectDir, options.onDurabilityBoundary, undefined, dbPath, options.historyReadBudget?.objectBytes);
    }
    if (existed) {
      db = await openSqlite(dbPath, { readOnly: true });
      validateExistingDatabase(db, dbPath);
      if (!canAttemptWriterClaim(db)) return new MissionStore(db, objectDir, options.onDurabilityBoundary, undefined, dbPath);
      db.close();
      db = await openSqlite(dbPath, { setWal: false });
      db.exec("PRAGMA synchronous = FULL");
      validateExistingDatabase(db, dbPath);
    } else {
      options.admitWriter?.();
      db = await openSqlite(dbPath, { setWal: false });
      options.admitWriter?.();
      db.exec("PRAGMA synchronous = FULL");
      initializeNewDatabase(db, dbPath);
    }

    const claim = claimWriterReservation(db, options.admitWriter
      ? () => options.admitWriter!(new MissionStore(db, objectDir, undefined, undefined, dbPath)) : undefined);
    if (!claim) {
      db.close();
      db = await openSqlite(dbPath, { readOnly: true });
      validateExistingDatabase(db, dbPath);
      return new MissionStore(db, objectDir, options.onDurabilityBoundary, undefined, dbPath);
    }
    db.exec("PRAGMA journal_mode = WAL");
    ensureDirectory(objectDir);
    return new MissionStore(db, objectDir, options.onDurabilityBoundary, claim, dbPath);
  } catch (error) {
    try { db!.close(); } catch { /* database may already be closed */ }
    if (error instanceof MissionStoreError) throw error;
    throw new MissionStoreError(`could not open mission database ${dbPath}: ${messageOf(error)}`);
  }
}

export class MissionStore {
  readonly runtimeId = PROCESS_RUNTIME_ID;
  private readonly db: SqlDatabase;
  readonly objectDir: string;
  private readonly onDurabilityBoundary?: (boundary: CrashBoundary) => void;
  private readonly writerClaim?: WriterClaim;
  private closed = false;
  private historyObjectBytes?: number;
  private historyObjectLimited = false;

  get historyReadLimitReached(): boolean { return this.historyObjectLimited; }

  readonly dbPath?: string;

  constructor(db: SqlDatabase, objectDir: string, onDurabilityBoundary?: (boundary: CrashBoundary) => void, writerClaim?: WriterClaim,
    dbPath?: string, historyObjectBytes?: number) {
    this.dbPath = dbPath;
    this.db = db;
    this.objectDir = objectDir;
    this.onDurabilityBoundary = onDurabilityBoundary;
    this.writerClaim = writerClaim;
    this.historyObjectBytes = historyObjectBytes;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.writerClaim) {
        const acknowledgement = findRetirementAcknowledgement(this.db, this.writerClaim);
        if (acknowledgement) releaseWriterReservation(this.db, this.writerClaim, acknowledgement);
      }
    } finally {
      this.db.close();
    }
  }

  get ownerEpoch(): number | null {
    return this.writerClaim?.epoch ?? null;
  }

  /** Observation only; unlike ownerEpoch this also describes a remote writer. */
  get ownershipIdentity(): { epoch: number; claimId: string } {
    return {
      epoch: Number(this.db.prepare("SELECT value FROM store_meta WHERE key = 'owner_epoch'").get()?.value),
      claimId: String(this.db.prepare("SELECT value FROM store_meta WHERE key = 'owner_claim_id'").get()?.value ?? ""),
    };
  }

  get storageRoot(): string {
    return path.dirname(path.dirname(this.objectDir));
  }

  get historyLocator(): { dbPath: string; objectDir: string } {
    if (!this.dbPath) throw new MissionStoreError("mission store has no known database locator");
    return { dbPath: this.dbPath, objectDir: this.objectDir };
  }

  get ownerAcquisitionProof(): Record<string, unknown> | undefined {
    const raw = this.db.prepare("SELECT value FROM store_meta WHERE key = 'owner_acquisition_proof'").get()?.value;
    if (typeof raw !== "string" || !raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch { return undefined; }
  }

  readArtifact(hash: string): Buffer {
    return this.readObject(hash);
  }

  verifyRepositoryAssociation(rootPath: string): string {
    const workspace = verifiedWorkspace(rootPath);
    const marker = readRepositoryMarker(path.join(workspace.commonDir, "pitako", "repository-id"));
    if (!marker) throw new MissionStoreError("repository marker is missing; repository association is unproven");
    if (marker.hostId !== machineIdentity() || marker.commonDir !== workspace.commonDir ||
      marker.gitDirectoryId !== gitDirectoryIdentity(workspace.commonDir) || marker.storeInstanceId !== this.readStoreInstanceId()) {
      throw new MissionStoreError("repository marker does not prove this repository association");
    }
    const location = this.db.prepare("SELECT repository_id FROM repository_locations WHERE canonical_path = ? AND kind = 'common'").get(workspace.commonDir);
    if (location?.repository_id !== marker.repositoryId) throw new MissionStoreError("repository marker has no matching stored owner proof");
    this.verifyRepositoryContinuity(marker, workspace);
    return marker.repositoryId;
  }

  findManagedTargetClaims(rootPath: string, planId?: string): ManagedTargetClaim[] {
    let workspace: VerifiedWorkspace;
    try { workspace = verifiedWorkspace(rootPath); }
    catch (error) {
      if (/not a git repository/i.test(messageOf(error))) return [];
      throw error;
    }

    const physicalRoot = realpathSync(workspace.root);
    const rootIdentity = gitDirectoryIdentity(physicalRoot);
    const gitIdentity = gitDirectoryIdentity(workspace.gitDir);
    const claims: ManagedTargetClaim[] = [];
    const location = this.db.prepare("SELECT repository_id FROM repository_locations WHERE canonical_path = ? AND kind = 'common'").get(workspace.commonDir);
    const markerFile = path.join(workspace.commonDir, "pitako", "repository-id");
    if (location || existsSync(markerFile)) {
      const repositoryId = this.verifyRepositoryAssociation(rootPath);
      const active = this.db.prepare(`SELECT mission_id FROM missions WHERE repository_id = ? AND state NOT IN ('completed', 'cancelled')
        ORDER BY created_at, mission_id`).all(repositoryId);
      const selected = active.length ? active : planId === undefined ? [] : this.db.prepare(
        "SELECT mission_id FROM missions WHERE repository_id = ? AND plan_id = ? ORDER BY created_at DESC LIMIT 1",
      ).all(repositoryId, assertPlanId(planId));
      for (const row of selected) claims.push({
        mission: this.inspectMission(text(row.mission_id, "mission_id")), targetKind: "repository", physicalRoot, rootIdentity, gitIdentity,
      });
    }

    const registrations = this.db.prepare(`SELECT m.mission_id, m.repository_id, e.attempt_id, e.payload_json
      FROM missions m JOIN mission_events e ON e.mission_id = m.mission_id
      WHERE e.kind = 'workspace.candidate.registered'`).all();
    for (const row of registrations) {
      const payload = parseJson<Record<string, unknown>>(row.payload_json, "candidate registration");
      if (payload.rootIdentity !== rootIdentity || payload.gitIdentity !== gitIdentity) continue;
      verifyPrivateCandidate(physicalRoot);
      const owner = payload.owner as Record<string, unknown> | undefined;
      const attemptId = text(row.attempt_id, "candidate attempt_id");
      const missionId = text(row.mission_id, "candidate mission_id");
      const candidateId = `${missionId}:${attemptId}`;
      const mission = this.inspectMission(missionId);
      const reserved = mission.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === attemptId);
      const binding = reserved?.payload.binding as Record<string, unknown> | undefined;
      if (payload.missionId !== missionId || payload.repositoryId !== row.repository_id || payload.attemptId !== attemptId ||
        payload.candidateId !== candidateId || binding?.candidateId !== candidateId ||
        typeof owner?.hostId !== "string" || owner.hostId !== currentProcessIdentity(PROCESS_RUNTIME_ID, 1).hostId ||
        typeof owner.epoch !== "number" || binding.ownerEpoch !== owner.epoch) {
        throw new MissionStoreError(`managed candidate identity claim is inconsistent for ${candidateId}`);
      }
      claims.push({ mission, targetKind: "candidate", candidateId, physicalRoot, rootIdentity, gitIdentity });
    }
    return claims;
  }

  findManagedMission(rootPath: string, planId?: string): MissionInspection | undefined {
    const claims = this.findManagedTargetClaims(rootPath, planId);
    const owned = claims.filter(({ targetKind, mission }) => targetKind === "candidate" || !["completed", "cancelled"].includes(mission.state));
    if (owned.length > 1) throw new MissionStoreError("multiple managed missions claim this physical target; dispatch is ambiguous");
    return owned[0]?.mission ?? claims.find(({ mission }) => mission.planId === planId)?.mission;
  }

  findManagedAttempt(rootPath: string, attemptId: string): MissionInspection | undefined {
    const workspace = verifiedWorkspace(rootPath);
    const location = this.db.prepare("SELECT repository_id FROM repository_locations WHERE canonical_path = ? AND kind = 'common'").get(workspace.commonDir);
    const markerFile = path.join(workspace.commonDir, "pitako", "repository-id");
    if (!location && !existsSync(markerFile)) return undefined;
    const repositoryId = this.verifyRepositoryAssociation(rootPath);
    return this.findMissionForAttempt(repositoryId, attemptId);
  }

  findActiveMissionForRepository(repositoryId: string): MissionInspection | undefined {
    requireUuid(repositoryId, "repositoryId");
    const row = this.db.prepare(`SELECT mission_id FROM missions WHERE repository_id = ? AND state NOT IN ('completed', 'cancelled')
      ORDER BY created_at, mission_id LIMIT 1`).get(repositoryId);
    return row ? this.inspectMission(text(row.mission_id, "mission_id")) : undefined;
  }

  findMissionForAttempt(repositoryId: string, attemptId: string): MissionInspection | undefined {
    requireUuid(repositoryId, "repositoryId");
    requireUuid(attemptId, "attemptId");
    const row = this.db.prepare(`SELECT m.mission_id FROM missions m JOIN mission_events e ON e.mission_id = m.mission_id
      WHERE m.repository_id = ? AND e.kind = 'attempt.reserved' AND e.attempt_id = ? ORDER BY e.seq DESC LIMIT 1`).get(repositoryId, attemptId);
    return row ? this.inspectMission(text(row.mission_id, "mission_id")) : undefined;
  }

  findMissionForPlan(rootPath: string, planId: string): MissionInspection | undefined {
    const repositoryId = this.verifyRepositoryAssociation(rootPath);
    const rows = this.db.prepare(`SELECT mission_id FROM missions WHERE repository_id = ? AND plan_id = ?
      ORDER BY CASE state WHEN 'completed' THEN 0 WHEN 'cancelled' THEN 0 ELSE 1 END DESC, created_at DESC`).all(repositoryId, assertPlanId(planId));
    if (rows.length === 0) return undefined;
    const active = rows.filter((row) => !["completed", "cancelled"].includes(String(this.db.prepare("SELECT state FROM missions WHERE mission_id = ?").get(row.mission_id)?.state)));
    if (active.length > 1) throw new MissionStoreError("multiple active missions exist for this repository and plan; association is ambiguous");
    return this.inspectMission(text((active[0] ?? rows[0])!.mission_id, "mission_id"));
  }

  ensureRepositoryIdentity(rootPath: string): string {
    this.assertWriterClaim();
    const workspace = verifiedWorkspace(rootPath);
    const hostId = machineIdentity();
    const gitDirectoryId = gitDirectoryIdentity(workspace.commonDir);
    const storeInstanceId = this.requireStoreInstanceId();
    const markerPath = path.join(workspace.commonDir, "pitako", "repository-id");
    const existingPath = this.db.prepare("SELECT repository_id FROM repository_locations WHERE canonical_path = ?").get(workspace.commonDir);
    const marker = readRepositoryMarker(markerPath);

    if (marker) {
      if (marker.hostId !== hostId) throw new MissionStoreError("repository marker belongs to a different host; copied marker is not authority");
      if (marker.commonDir !== workspace.commonDir) throw new MissionStoreError("repository marker common directory does not match verified Git discovery");
      if (marker.gitDirectoryId !== gitDirectoryId) throw new MissionStoreError("Git repository identity changed at the registered common-directory path");
      if (marker.storeInstanceId !== storeInstanceId) throw new MissionStoreError("repository marker belongs to a different mission store");
      if (!existingPath) throw new MissionStoreError("repository marker has no stored owner proof for this Git common directory");
      if (existingPath.repository_id !== marker.repositoryId) throw new MissionStoreError("repository identity changed at an already registered Git common directory");
      this.verifyRepositoryContinuity(marker, workspace);
      this.registerRepository(marker, workspace);
      return marker.repositoryId;
    }

    if (existingPath) throw new MissionStoreError("repository marker is missing for a registered Git common directory; refusing to invent identity");
    const created: RepositoryMarker = {
      schemaVersion: 2,
      repositoryId: randomUUID(),
      hostId,
      storeInstanceId,
      commonDir: workspace.commonDir,
      gitDirectoryId,
      createdAt: new Date().toISOString(),
    };
    const continuity = captureRepositoryContinuity(created, workspace);
    this.registerRepository(created, workspace, continuity);
    writeRepositoryMarker(markerPath, created);
    const observed = readRepositoryMarker(markerPath);
    if (!observed || json(observed) !== json(created)) throw new MissionStoreError("repository marker creation did not persist the expected identity");
    return created.repositoryId;
  }

  createMission(input: MissionCreateInput): MissionRecord {
    this.assertWriterClaim();
    requireUuid(input.commandId, "commandId");
    requireUuid(input.admissionReceiptId, "admissionReceiptId");
    const requestedId = input.missionId ?? randomUUID();
    requireUuid(requestedId, "missionId");
    const planId = assertPlanId(input.planId);
    const workspace = verifiedWorkspace(input.repositoryRoot);
    const knownRepository = this.findRepositoryAt(workspace.commonDir);
    const marker = readRepositoryMarker(path.join(workspace.commonDir, "pitako", "repository-id"));
    if (knownRepository && !marker) throw new MissionStoreError("repository marker is missing for a registered Git common directory; refusing to create mission");
    const repositoryId = marker ? this.ensureRepositoryIdentity(input.repositoryRoot) : undefined;
    if (repositoryId) {
      const prior = this.db.prepare("SELECT mission_id, repository_id, plan_id FROM missions WHERE command_id = ?").get(input.commandId);
      if (prior) {
        if (prior.repository_id !== repositoryId || prior.plan_id !== planId) throw new MissionStoreError("commandId was already used for a different repository or plan");
        return this.requireMission(text(prior.mission_id, "mission_id"));
      }
    }

    const preparedHash = input.prepared ? assertPreparedAdmission(input.prepared) : undefined;
    if (input.prepared && (input.prepared.binding.executionRoot !== workspace.root ||
      input.prepared.repositoryFamily !== workspace.commonDir))
      throw new MissionStoreError("prepared source binding has a different execution root or repository family");
    const planPath = input.prepared?.binding.planSource ?? realpathSync(path.resolve(input.planFile!));
    const definitionPath = input.prepared ? undefined : realpathSync(path.resolve(input.definitionFile!));
    if (repositoryIdentity(path.dirname(planPath)) !== workspace.commonDir || definitionPath && repositoryIdentity(path.dirname(definitionPath)) !== workspace.commonDir) {
      throw new MissionStoreError("plan and definition must belong to the verified repository family");
    }
    const planBytes = input.prepared ? Buffer.from(input.prepared.originalSource) : readFileSync(planPath);
    const definitionBytes = input.prepared ? Buffer.from(JSON.stringify(input.prepared.definition)) : readFileSync(definitionPath!);
    const planText = decodeUtf8(planBytes, "plan");
    const plan = parsePlanDocument(planText);
    if (plan.id !== planId) throw new MissionStoreError(`plan id ${plan.id} does not match requested ${planId}`);
    if (plan.status !== "frozen") throw new MissionStoreError(`plan ${planId} is ${plan.status}, not frozen`);
    const validated = validateMissionDefinitionBytes(definitionBytes);
    assertSupportedResourcePolicy(validated.definition);
    if (!input.prepared && validated.definition.schemaVersion !== 1)
      throw new MissionStoreError("generated definitions require host preparation; local JSON cannot bypass validation");
    const currentHash = planHash(planText);
    if (currentHash !== plan.hash) throw new MissionStoreError("plan hash changed during snapshot validation");
    const familyId = repositoryId ?? this.ensureRepositoryIdentity(input.repositoryRoot);
    const prior = this.db.prepare("SELECT mission_id, repository_id, plan_id FROM missions WHERE command_id = ?").get(input.commandId);
    if (prior) {
      if (prior.repository_id !== familyId || prior.plan_id !== planId) throw new MissionStoreError("commandId was already used for a different repository or plan");
      return this.requireMission(text(prior.mission_id, "mission_id"));
    }

    if (input.prepared) {
      if (!input.operatorReceipt || input.operatorReceipt.id !== input.admissionReceiptId ||
        input.operatorReceipt.id !== input.commandId || input.operatorText !== input.operatorReceipt.text)
        throw new MissionStoreError("generated admission requires exact prepared confirmation provenance");
      consumePreparedAdmission(input.prepared, input.operatorReceipt);
    }
    const planObject = this.writeObject(planBytes, "text/markdown; charset=utf-8");
    const definitionObject = this.writeObject(definitionBytes, "application/json");
    const preparedObject = input.prepared ? this.writeObject(Buffer.from(JSON.stringify(input.prepared)), "application/json") : undefined;
    if (preparedObject && preparedObject.hash !== preparedHash) throw new MissionStoreError("prepared object identity changed");
    const snapshot: PlanSnapshot = {
      schemaVersion: input.prepared ? validated.definition.schemaVersion : 1,
      ...(input.prepared ? { preparedHash, sourceBinding: input.prepared.binding } : {}),
      planId,
      revision: plan.revision,
      sourcePath: planPath,
      planHash: planObject.hash,
      definitionHash: definitionObject.hash,
      parentRevision: null,
      admissionProvenance: { kind: "operator", receiptId: input.admissionReceiptId },
      units: validated.definition.units.map(({ id, parentId }) => ({ id, ...(parentId ? { parentId } : {}) })),
    };
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const runtimeId = this.runtimeId;
    const eventId = randomUUID();
    const causalId = randomUUID();
    const payload = {
      repositoryId: familyId,
      planId,
      revision: plan.revision,
      state: "prepared",
      snapshot,
      definitionHash: definitionObject.hash,
      unitIds: validated.definition.units.map(({ id }) => id),
      ...(input.operatorText ? { operatorInputId: input.admissionReceiptId, operatorText: input.operatorText, intervention: "operator_choice" } : {}),
      ...(input.operatorReceipt ? { operatorReceipt: input.operatorReceipt } : {}),
    };
    const event = makeEvent({ eventId, missionId: requestedId, revision: plan.revision, seq: 1, kind: "mission.created", causalId, occurredAt, runtimeId, payload });

    const committedMissionId = this.withTransaction(() => {
      const priorCommand = this.db.prepare(`SELECT m.mission_id, m.repository_id, m.plan_id, m.revision, r.plan_hash, r.definition_hash
        FROM missions m JOIN revisions r ON r.mission_id = m.mission_id AND r.revision = m.revision WHERE m.command_id = ?`).get(input.commandId);
      if (priorCommand) {
        if (priorCommand.repository_id !== familyId || priorCommand.plan_id !== planId || priorCommand.revision !== plan.revision ||
          priorCommand.plan_hash !== planObject.hash || priorCommand.definition_hash !== definitionObject.hash) {
          throw new MissionStoreError("commandId was already used for a different snapshot");
        }
        return text(priorCommand.mission_id, "mission_id");
      }
      if (this.db.prepare(`SELECT mission_id FROM missions WHERE repository_id = ? AND plan_id = ?
        AND state NOT IN ('completed', 'cancelled')`).get(familyId, planId)) {
        throw new MissionStoreError("active mission already exists for repository and plan");
      }
      if (this.db.prepare("SELECT mission_id FROM missions WHERE mission_id = ?").get(requestedId)) throw new MissionStoreError("mission UUID already exists");
      this.insertObject(planObject);
      this.insertObject(definitionObject);
      if (preparedObject) this.insertObject(preparedObject);
      this.db.prepare(`INSERT INTO missions (mission_id, command_id, repository_id, plan_id, revision, state, version, latest_seq, created_at)
        VALUES (?, ?, ?, ?, ?, 'prepared', 1, 1, ?)`)
        .run(requestedId, input.commandId, familyId, planId, plan.revision, occurredAt);
      this.db.prepare(`INSERT INTO revisions (mission_id, revision, schema_version, plan_hash, definition_hash, source_path, parent_revision, admission_json, unit_mapping_json)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
        .run(requestedId, plan.revision, 1, planObject.hash, definitionObject.hash, planPath,
          json(snapshot.schemaVersion !== 1 ? { schemaVersion: snapshot.schemaVersion, provenance: snapshot.admissionProvenance, preparedHash, sourceBinding: snapshot.sourceBinding } : snapshot.admissionProvenance),
          json(snapshot.units));
      const insertUnit = this.db.prepare("INSERT INTO units (mission_id, revision, unit_id, parent_id, definition_json) VALUES (?, ?, ?, ?, ?)");
      for (const unit of validated.definition.units) insertUnit.run(requestedId, plan.revision, unit.id, unit.parentId ?? null, json(unit));
      this.insertEvent(event);
      this.onDurabilityBoundary?.("mission.create.before-commit");
      return requestedId;
    });
    if (committedMissionId === requestedId) this.onDurabilityBoundary?.("mission.create.after-commit");
    return this.requireMission(committedMissionId);
  }

  admitRevision(input: {
    missionId: string; expectedVersion: number; planBytes: Uint8Array; definitionBytes: Uint8Array;
    receiptId: string; actor: "operator" | "model"; impact: string[]; retained: string[]; operatorText?: string; operatorInstruction?: string; operatorReceipt?: import("./admission.ts").OperatorReceipt; resolvesInputIds?: string[]; questionMappings?: Array<{ id: string; roots: string[]; heldUnits: string[] }>;
  }): MissionInspection {
    this.assertWriterClaim();
    requireUuid(input.receiptId, "revision receiptId");
    const current = this.inspectMission(input.missionId);
    if (current.version !== input.expectedVersion) throw new MissionStoreError("revision version conflict");
    if (current.prepared) verifyExecutionBinding(current.prepared.binding);
    const plan = parsePlanDocument(decodeUtf8(Buffer.from(input.planBytes), "revised plan"));
    if (plan.id !== current.planId || plan.revision !== current.revision + 1 || plan.status !== "frozen") {
      throw new MissionStoreError("revision must be the next frozen revision of this plan");
    }
    const definition = validateMissionDefinitionBytes(input.definitionBytes).definition;
    if (definition.schemaVersion !== current.definition.schemaVersion) throw new MissionStoreError("revision cannot change executable contract version");
    assertSupportedResourcePolicy(definition);
    if (current.prepared) {
      for (const original of current.prepared.definition.units) {
        const revised = definition.units.find(({ id }) => id === original.id);
        if (!revised || json(revised.originalIntent) !== json(original.originalIntent))
          throw new MissionStoreError("revision cannot silently shrink or replace original unit intent");
        for (const criterion of original.originalIntent!.criteria)
          for (const id of criterion.predicateIds) if (!revised.acceptance.some((predicate) => predicate.id === id))
            throw new MissionStoreError("revision cannot silently omit an original criterion predicate");
      }
      for (const mapping of current.prepared.mappings)
        for (const id of mapping.predicateIds) if (!definition.units.some((unit) => unit.acceptance.some((predicate) => predicate.id === id)))
          throw new MissionStoreError("revision cannot silently omit an original source obligation");
      for (const edge of current.prepared.inventory.dependencies)
        if (!definition.units.find(({ id }) => id === edge.unitId)?.dependencies.includes(edge.requires))
          throw new MissionStoreError("revision cannot omit an original ordered dependency");
      for (const phase of ["ordinary", "integrated", "affected", "final"] as const)
        if (current.definition.finalization.selections![phase].some((id) => !definition.finalization.selections![phase].includes(id)))
          throw new MissionStoreError("revision cannot silently omit a frozen phase selection");
      if (definition.units.some((unit) => unit.acceptance.some(({ kind }) => kind === "manual")))
        throw new MissionStoreError("revision cannot introduce unsupported observers");
    }
    const planObject = this.writeObject(input.planBytes, "text/markdown; charset=utf-8");
    const definitionObject = this.writeObject(input.definitionBytes, "application/json");
    const preparedObject = current.prepared ? this.writeObject(Buffer.from(json({ ...current.prepared, definition,
      ...(current.prepared.setup ? { setup: { ...current.prepared.setup,
        requiredBy: setupRequiredBy(current.prepared.setup.identity, definition) } } : {}),
    })), "application/json") : undefined;
    if (plan.hash !== planObject.hash) throw new MissionStoreError("revision plan hash mismatch");
    const revision = plan.revision;
    const units = definition.units.map(({ id, parentId }) => ({ id, ...(parentId ? { parentId } : {}) }));
    const snapshot: PlanSnapshot = {
      schemaVersion: current.snapshot.schemaVersion, planId: current.planId, revision, sourcePath: current.snapshot.sourcePath,
      ...(preparedObject ? { preparedHash: preparedObject.hash, sourceBinding: current.snapshot.sourceBinding } : {}),
      planHash: planObject.hash, definitionHash: definitionObject.hash, parentRevision: current.revision,
      admissionProvenance: { kind: input.actor, receiptId: input.receiptId }, units,
    };
    const event = makeEvent({ eventId: randomUUID(), missionId: input.missionId, revision,
      seq: current.latestSeq + 1, kind: "mission.revised", causalId: input.receiptId,
      occurredAt: new Date().toISOString(), runtimeId: this.runtimeId,
      payload: { snapshot, impact: input.impact, retained: input.retained, parentRevision: current.revision,
        requiredPredicates: definition.finalization.selections?.ordinary ?? definition.finalization.requiredPredicates, questionMappings: input.questionMappings ?? [],
        ...(input.operatorText ? { operatorText: input.operatorText, operatorInputId: input.receiptId, intervention: "operator_choice" } : {}),
        ...(input.operatorInstruction ? { operatorInstruction: input.operatorInstruction } : {}),
        ...(input.operatorReceipt ? { operatorReceipt: input.operatorReceipt } : {}),
        ...(input.resolvesInputIds?.length ? { resolvesInputId: input.resolvesInputIds[0], resolvesInputIds: input.resolvesInputIds } : {}) } });
    this.withTransaction(() => {
      this.requireVersion(input.missionId, input.expectedVersion);
      this.insertObject(planObject);
      this.insertObject(definitionObject);
      if (preparedObject) this.insertObject(preparedObject);
      this.db.prepare(`INSERT INTO revisions (mission_id, revision, schema_version, plan_hash, definition_hash, source_path, parent_revision, admission_json, unit_mapping_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.missionId, revision, 1, planObject.hash, definitionObject.hash,
          snapshot.sourcePath, current.revision, json(preparedObject ? { schemaVersion: snapshot.schemaVersion, provenance: snapshot.admissionProvenance,
            preparedHash: snapshot.preparedHash, sourceBinding: snapshot.sourceBinding } : snapshot.admissionProvenance), json(units));
      const insert = this.db.prepare("INSERT INTO units (mission_id, revision, unit_id, parent_id, definition_json) VALUES (?, ?, ?, ?, ?)");
      for (const unit of definition.units) insert.run(input.missionId, revision, unit.id, unit.parentId ?? null, json(unit));
      this.insertEvent(event);
      const projected = reduceMissionEvent(reduceMissionEvents(current), event);
      const changed = this.db.prepare("UPDATE missions SET revision = ?, state = ?, version = version + 1, latest_seq = ? WHERE mission_id = ? AND version = ?")
        .run(revision, projected.state, event.seq, input.missionId, input.expectedVersion);
      if (changed.changes !== 1) throw new MissionStoreError("revision CAS failed");
    });
    return this.inspectMission(input.missionId);
  }

  /** Display-only events; admission still requires inspectMission and its artifact checks. */
  readNotifications(missionId: string, afterSeq: number): MissionEvent[] {
    requireUuid(missionId, "missionId");
    return this.db.prepare(`SELECT * FROM mission_events
      WHERE mission_id = ? AND seq > MAX(?, COALESCE((
        SELECT MAX(CAST(json_extract(payload_json, '$.throughSeq') AS INTEGER))
        FROM mission_events WHERE mission_id = ? AND kind = 'mission.notification.delivered'
      ), 0)) AND kind IN (
        'attempt.started', 'unit.accepted', 'unit.blocked', 'mission.completed',
        'mission.revised', 'mission.blocked', 'mission.recovery.recorded'
      ) ORDER BY seq`).all(missionId, afterSeq, missionId).map(readEvent);
  }

  /** Bounded display tail only; no inspection, source/setup validation or replay reduction. */
  readProgressEvents(missionId: string, afterSeq: number): MissionEvent[] {
    requireUuid(missionId, "missionId");
    return this.db.prepare("SELECT * FROM mission_events WHERE mission_id = ? AND seq > ? ORDER BY seq LIMIT 128")
      .all(missionId, afterSeq).map(readEvent);
  }

  inspectMission(missionId: string): MissionInspection {
    return this.readInspection(missionId, true);
  }

  /** Accounting only: this projection is not evidence for dispatch, effects or acceptance. */
  /** Cheap invalidation of hydration within a single physical write frontier. */
  readMissionControl(missionId: string): Pick<MissionInspection, "revision" | "version" | "state"> {
    requireUuid(missionId, "missionId");
    const row = this.db.prepare("SELECT revision, version, state FROM missions WHERE mission_id = ?").get(missionId);
    if (!row) throw new MissionStoreError("mission not found");
    return { revision: number(row.revision, "revision"), version: number(row.version, "version"),
      state: text(row.state, "state") as MissionInspection["state"] };
  }
  readActiveTimeAccounting(missionId: string): Pick<MissionInspection, "revision" | "version" | "state" | "reservations"> &
    { metered: ReturnType<typeof meteredConsumptions> } {
    const inspection = this.readInspection(missionId, false);
    return { revision: inspection.revision, version: inspection.version,
      state: reduceMissionEvents(inspection).state, reservations: inspection.reservations, metered: meteredConsumptions(inspection.events) };
  }

  private readInspection(missionId: string, hydratePrepared: boolean): MissionInspection {
    requireUuid(missionId, "missionId");
    this.db.exec("BEGIN");
    try {
      if (this.historyObjectBytes !== undefined) {
        const size = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
          FROM mission_events WHERE mission_id = ?`).get(missionId)!;
        if (Number(size.count) > 5000 || Number(size.bytes) > 8 * 1024 * 1024)
          throw new MissionStoreError("history_authority_limit");
      }
      const inspection = this.inspectWithinTransaction(missionId, hydratePrepared);
      this.db.exec("COMMIT");
      return inspection;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* read transaction may already be closed */ }
      throw error;
    }
  }

  appendTransition(missionId: string, expectedVersion: number, transition: MissionTransition): MissionEvent[] {
    this.assertWriterClaim();
    requireUuid(missionId, "missionId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new MissionStoreError("expectedVersion must be a positive integer");
    if (!Array.isArray(transition.events) || transition.events.length === 0) throw new MissionStoreError("mission transition requires at least one event");
    const batchTypes = new Map<string, string>();
    const artifacts = (transition.artifacts ?? []).map((artifact) => {
      const bytes = Buffer.from(artifact.bytes);
      const hash = sha256(bytes);
      const prior = this.db.prepare("SELECT media_type FROM objects WHERE hash = ?").get(hash);
      const mediaType = prior ? text(prior.media_type, "artifact media type") :
        batchTypes.get(hash) ?? requireText(artifact.mediaType, "artifact media type");
      batchTypes.set(hash, mediaType);
      return { ...this.writeObject(bytes, mediaType), mediaType };
    });
    const drafts = transition.events.map((draft) => {
      if (!EVENT_KINDS.has(draft.kind) || draft.kind === "mission.created" || draft.kind === "evaluation.observed") {
        throw new MissionStoreError(`unsupported engine event kind ${draft.kind}`);
      }
      if (!draft.payload || typeof draft.payload !== "object" || Array.isArray(draft.payload)) throw new MissionStoreError("mission event payload must be an object");
      requireUuid(draft.causalId, "event causalId");
      this.requireRevision(missionId, draft.revision);
      return draft;
    });
    const existing = drafts.map((draft) => this.db.prepare("SELECT * FROM mission_events WHERE mission_id = ? AND causal_id = ?").get(missionId, draft.causalId));
    for (let index = 0; index < drafts.length; index += 1) {
      const row = existing[index];
      if (!row) continue;
      const prior = readEvent(row);
      const draft = drafts[index]!;
      if (prior.kind !== draft.kind || prior.revision !== draft.revision || prior.unitId !== (draft.unitId ?? null) ||
        prior.attemptId !== (draft.attemptId ?? null) || prior.teamRoundId !== (draft.teamRoundId ?? null) || json(prior.payload) !== json(draft.payload)) {
        throw new MissionStoreError(`mission event causalId was replayed with different contents: ${draft.kind} ${draft.causalId}`);
      }
    }
    if (existing.every(Boolean)) {
      if (drafts.some(({ kind }) => kind === "mission.completed")) {
        const blockers = this.currentCompletionObservation(missionId, expectedVersion).blockers;
        if (blockers.length) throw new MissionStoreError(`mission completion blocked: ${blockers.join(", ")}`);
      }
      return existing.map((row) => readEvent(row!));
    }

    const row = this.requireMissionRow(missionId);
    if (number(row.version, "version") !== expectedVersion) throw new MissionStoreError(`mission version conflict: expected ${expectedVersion}, observed ${String(row.version)}`);
    // Only an existing window's measured charge can avoid reloading setup proof.
    // Any mixed transition, new grant, effect or acceptance keeps full inspection.
    const checkpointOnly = !artifacts.length && drafts.length === 2 &&
      ["budget.reservation.settled", "resource.metered.settled"].includes(drafts[0]!.kind) &&
      drafts[1]!.kind === "mission.active.window.checkpointed";
    const inspection = checkpointOnly ? this.readInspection(missionId, false) : this.inspectMission(missionId);
    if (checkpointOnly) this.assertActiveTimeCheckpoint(inspection, drafts);
    const definition = inspection.definition;
    let projected = reduceMissionEvents(inspection);
    const newDrafts = drafts.filter((_, index) => !existing[index]);
    this.withTransaction(() => {
      this.requireVersion(missionId, expectedVersion);
      for (const artifact of artifacts) this.insertObject(artifact);
      const priorEvents = this.db.prepare("SELECT * FROM mission_events WHERE mission_id = ? ORDER BY seq").all(missionId).map(readEvent);
      const inserted = [...priorEvents];
      if (drafts.some((draft, index) => draft.kind === "mission.completed" && existing[index])) {
        const blockers = this.currentCompletionObservation(missionId, expectedVersion).blockers;
        if (blockers.length) throw new MissionStoreError(`mission completion blocked: ${blockers.join(", ")}`);
      }
      const reservationRows = new Map<string, Reservation>();
      let fenceReason: string | undefined;
      for (const draft of newDrafts) {
        if (draft.kind === "mission.completed") {
          if (draft.revision !== inspection.revision || draft !== newDrafts.at(-1) ||
            inserted.some((event) => event.kind === "mission.completed"))
            throw new MissionStoreError("mission completion blocked: stale or duplicate completion");
          const assessment = this.currentCompletionObservation(missionId, expectedVersion);
          if (assessment.blockers.length) throw new MissionStoreError(`mission completion blocked: ${assessment.blockers.join(", ")}`);
          const publication = inserted.at(-1);
          const certificateHash = sha256(Buffer.from(json(assessment.certificate)));
          if (publication?.kind !== "mission.finalization.published" ||
            publication.payload.certificateArtifactHash !== certificateHash ||
            draft.payload.certificateArtifactHash !== certificateHash ||
            publication.payload.manifestHash !== assessment.certificate?.manifestHash ||
            publication.payload.approvalHash !== assessment.certificate?.approvalHash ||
            sha256(this.readArtifact(certificateHash)) !== certificateHash)
            throw new MissionStoreError("mission completion blocked: atomic publication missing");
        }
        if (draft.kind === "attempt.reserved") assertAttemptSlotAvailable(inserted, draft.payload);
        if (draft.kind === "attempt.settled") assertAttemptIsActive(inserted, draft.payload);
        if (draft.kind === "resource.metered.admitted" && (fenceReason || draft.revision !== inspection.revision ||
          ["paused", "cancelled", "completed"].includes(projected.state)))
          throw new MissionStoreError("metered admission needs current unfenced revision and control authority");
        if (draft.kind === "reservation.created") {
          if (fenceReason || inserted.some((event) => event.kind === "budget.admission.fenced")) {
            throw new MissionStoreError(`mission admission is fenced: ${fenceReason ?? "prior resource overage"}`);
          }
          const reservation = reservationFromEvent(missionId, draft);
          if (resourceLimit(definition, reservation.resource as import("./resources.ts").Resource) === undefined)
            throw new MissionStoreError("numeric reservation requires an explicit cap");
          if (reservationRows.has(reservation.id) || inserted.some((event) => event.kind === "reservation.created" && event.payload.reservationId === reservation.id) ||
            this.db.prepare("SELECT reservation_id FROM reservations WHERE reservation_id = ?").get(reservation.id)) {
            throw new MissionStoreError("reservation id is already committed by another event");
          }
          reservationRows.set(reservation.id, reservation);
        }
        if (draft.kind === "budget.reservation.adjusted") {
          validateReservationAdjustment(missionId, inserted, draft.payload);
        }
        const event = makeEvent({
          eventId: randomUUID(), missionId, revision: draft.revision, seq: inserted.length + 1, kind: draft.kind,
          causalId: draft.causalId, occurredAt: draft.occurredAt ?? new Date().toISOString(), runtimeId: this.runtimeId,
          monotonicDurationMs: draft.monotonicDurationMs, unitId: draft.unitId, attemptId: draft.attemptId,
          effectId: draft.effectId, teamRoundId: draft.teamRoundId, reason: draft.reason, provenance: draft.provenance,
          payload: draft.payload,
        });
        inserted.push(event);
        projected = reduceMissionEvent(projected, event);
        if (draft.kind === "resource.metered.admitted" || draft.kind === "resource.metered.settled")
          validateMeteredEvent(inserted, event, definition, this.ownerEpoch);
        if (draft.kind === "reservation.created" || draft.kind === "budget.reservation.adjusted") {
          validateBudgetReservations(missionId, inserted, definition);
        } else if (draft.kind === "budget.reservation.settled") {
          validateReservationSettlement(missionId, inserted, draft.payload);
          fenceReason ??= budgetOverrunReason(missionId, inserted, definition);
        }
      }
      if (fenceReason && !inserted.some((event) => event.kind === "budget.admission.fenced")) {
        inserted.push(makeEvent({
          eventId: randomUUID(), missionId, revision: number(row.revision, "revision"), seq: inserted.length + 1,
          kind: "budget.admission.fenced", causalId: randomUUID(), occurredAt: new Date().toISOString(),
          runtimeId: this.runtimeId, reason: fenceReason,
          payload: { reason: fenceReason, sourceEventIds: inserted.slice(priorEvents.length).map(({ eventId }) => eventId) },
        }));
      }
      for (const event of inserted.slice(priorEvents.length)) {
        this.insertEvent(event);
        if (event.kind === "mission.finalization.published") this.onDurabilityBoundary?.("completion.after-publication");
        if (event.kind === "reservation.created") {
          const reservation = reservationFromEvent(missionId, drafts.find((draft) => draft.causalId === event.causalId)!);
          this.db.prepare(`INSERT INTO reservations (reservation_id, mission_id, revision, resource, amount, event_id, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(reservation.id, missionId, reservation.revision, reservation.resource, reservation.amount, event.eventId, json(reservation));
        } else if (event.kind === "budget.reservation.settled") {
          const reservation = reservationProjection(missionId, inserted, event.payload.reservationId);
          if (!reservation) throw new MissionStoreError(`settled reservation does not exist: ${String(event.payload.reservationId)}`);
          const result = reservation.amount === 0
            ? this.db.prepare("DELETE FROM reservations WHERE reservation_id = ? AND mission_id = ?").run(reservation.id, missionId)
            : this.db.prepare("UPDATE reservations SET amount = ?, payload_json = ? WHERE reservation_id = ? AND mission_id = ?")
              .run(reservation.amount, json(reservation), reservation.id, missionId);
          if (result.changes !== 1) throw new MissionStoreError(`reservation settlement failed: ${reservation.id}`);
        } else if (event.kind === "budget.reservation.adjusted") {
          const reservationId = requireUuid(event.payload.reservationId, "reservationId");
          const amount = event.payload.amount;
          if (!Number.isSafeInteger(amount) || Number(amount) < 0) throw new MissionStoreError("adjusted reservation amount must be nonnegative");
          const row = this.db.prepare("SELECT reservation_id, mission_id, revision, resource, amount, event_id, payload_json FROM reservations WHERE reservation_id = ? AND mission_id = ?")
            .get(reservationId, missionId);
          if (!row) throw new MissionStoreError(`adjusted reservation does not exist: ${reservationId}`);
          const reservation = readReservation(row);
          if (event.payload.resource !== reservation.resource) throw new MissionStoreError(`adjusted reservation resource changed: ${reservationId}`);
          const updated = { ...reservation, amount: Number(amount), remainingHold: Number(amount), released: Math.max(0, reservation.grantAmount - Number(amount)) };
          const result = updated.amount === 0
            ? this.db.prepare("DELETE FROM reservations WHERE reservation_id = ? AND mission_id = ?").run(reservationId, missionId)
            : this.db.prepare("UPDATE reservations SET amount = ?, payload_json = ? WHERE reservation_id = ? AND mission_id = ?")
              .run(updated.amount, json(updated), reservationId, missionId);
          if (result.changes !== 1) throw new MissionStoreError(`reservation adjustment failed: ${reservationId}`);
        } else if (event.kind === "measurement.recorded") {
          const measurement = validateMeasurement(event.payload, missionId);
          if (measurement.runtimeId !== this.runtimeId) throw new MissionStoreError("new measurement runtimeId must match the current process runtime");
          this.db.prepare("INSERT INTO measurements (measurement_id, mission_id, revision, event_id, payload_json) VALUES (?, ?, ?, ?, ?)")
            .run(measurement.id, missionId, measurement.revision, event.eventId, json(measurement));
        }
      }
      const lastSeq = number(row.latest_seq, "latest_seq") + inserted.length - priorEvents.length;
      const result = this.db.prepare("UPDATE missions SET state = ?, version = version + ?, latest_seq = ? WHERE mission_id = ? AND version = ?")
        .run(projected.state, inserted.length - priorEvents.length, lastSeq, missionId, expectedVersion);
      if (result.changes !== 1) throw new MissionStoreError("mission version changed during atomic transition");
      if (newDrafts.some((draft) => draft.kind === "mission.completed")) this.onDurabilityBoundary?.("completion.before-commit");
    });
    if (drafts.some((draft) => draft.kind === "mission.completed")) this.onDurabilityBoundary?.("completion.after-commit");
    return checkpointOnly
      ? this.db.prepare("SELECT * FROM mission_events WHERE mission_id = ? AND seq > ? ORDER BY seq")
        .all(missionId, number(row.latest_seq, "latest_seq")).map(readEvent)
      : this.inspectMission(missionId).events.slice(number(row.latest_seq, "latest_seq"));
  }

  private completionObservation?: { missionId: string; version: number; assessment: ReturnType<typeof assessMissionCompletion> };
  private currentCompletionObservation(missionId: string, version: number): ReturnType<typeof assessMissionCompletion> {
    const proof = this.completionObservation;
    if (!proof || proof.missionId !== missionId || proof.version !== version)
      throw new MissionStoreError("mission completion blocked: fresh completion observation required");
    return proof.assessment;
  }

  async completeMission(missionId: string, expectedVersion: number): Promise<void> {
    this.assertWriterClaim();
    const inspection = this.inspectMission(missionId);
    if (inspection.version !== expectedVersion) throw new MissionStoreError("mission completion version conflict");
    const owner = this.ownershipIdentity;
    const { PhysicalObservation } = await import("./physical-observation.ts");
    const observer = new PhysicalObservation();
    let assessment: ReturnType<typeof assessMissionCompletion>;
    try { assessment = await observer.request("completion",
      { ...this.historyLocator, missionId, binding: physicalResultBinding(inspection) }); }
    finally { await observer.dispose(); }
    this.assertWriterClaim();
    const current = this.inspectMission(missionId);
    if (json(owner) !== json(this.ownershipIdentity) || physicalResultBinding(current) !== physicalResultBinding(inspection))
      throw new MissionStoreError("mission completion observation became stale");
    if (assessment.blockers.length || !assessment.certificate)
      throw new MissionStoreError(`mission completion blocked: ${assessment.blockers.join(", ")}`);
    if (inspection.events.some((event) => event.kind === "mission.completed")) return;
    const { certificateHash: _observedHash, ...observed } = assessment.certificate;
    const unsigned = { ...observed, eventSequence: current.latestSeq + 2 };
    assessment.certificate = { ...unsigned, certificateHash: sha256(Buffer.from(JSON.stringify(unsigned))) };
    const bytes = Buffer.from(json(assessment.certificate));
    const certificateArtifactHash = sha256(bytes);
    const payload = { manifestHash: assessment.certificate.manifestHash, approvalHash: assessment.certificate.approvalHash,
      certificateArtifactHash };
    this.completionObservation = { missionId, version: current.version, assessment };
    try { this.appendTransition(missionId, current.version, { artifacts: [{ bytes, mediaType: "application/json" }], events: [
      { revision: inspection.revision, kind: "mission.finalization.published", causalId: randomUUID(), payload },
      { revision: inspection.revision, kind: "mission.completed", causalId: randomUUID(), payload },
    ] }); } finally { this.completionObservation = undefined; }
  }

  reserve(
    missionId: string,
    reservation: Pick<Reservation, "id" | "revision" | "resource" | "amount"> & Partial<Pick<Reservation, "purpose">>,
    expectedVersion: number,
  ): Reservation {
    this.assertWriterClaim();
    requireUuid(missionId, "missionId");
    requireUuid(reservation.id, "reservation id");
    if (!Number.isSafeInteger(reservation.amount) || reservation.amount < 1) throw new MissionStoreError("reservation amount must be a positive integer");
    const resource = requireText(reservation.resource, "reservation resource");
    const existing = this.db.prepare("SELECT reservation_id, mission_id, revision, resource, amount, event_id, payload_json FROM reservations WHERE reservation_id = ?").get(reservation.id);
    if (existing) {
      const result = readReservation(existing);
      if (result.missionId !== missionId || result.revision !== reservation.revision || result.resource !== resource || result.grantAmount !== reservation.amount) {
        throw new MissionStoreError("reservation id was replayed with different contents");
      }
      return result;
    }
    const released = this.db.prepare("SELECT payload_json FROM mission_events WHERE mission_id = ? AND kind = 'reservation.created'").all(missionId)
      .some((event) => parseJson<Record<string, unknown>>(event.payload_json, "reservation event payload").reservationId === reservation.id);
    if (released) throw new MissionStoreError("reservation id was already committed and released");
    const mission = this.inspectMission(missionId);
    if (mission.version !== expectedVersion) throw new MissionStoreError(`mission version conflict: expected ${expectedVersion}, observed ${mission.version}`);
    this.requireRevision(missionId, reservation.revision);
    const draft: MissionEventDraft = {
      revision: reservation.revision,
      kind: "reservation.created",
      causalId: randomUUID(),
      payload: {
        reservationId: reservation.id, revision: reservation.revision, resource,
        amount: reservation.amount, purpose: reservation.purpose ?? "ordinary",
      },
    };
    this.appendTransition(missionId, expectedVersion, { events: [draft] });
    return this.inspectMission(missionId).reservations.find(({ id }) => id === reservation.id)!;
  }

  recordMeasurement(value: unknown, expectedVersion: number): MissionMeasurement {
    this.assertWriterClaim();
    const candidate = value as Record<string, unknown>;
    if (!candidate || typeof candidate !== "object" || typeof candidate.missionId !== "string") throw new MissionStoreError("measurement missionId is required");
    requireUuid(candidate.missionId, "measurement missionId");
    requireUuid(candidate.id, "measurement id");
    const measurement = validateMeasurement(value, candidate.missionId);
    const existing = this.db.prepare("SELECT payload_json FROM measurements WHERE measurement_id = ?").get(candidate.id);
    if (existing) {
      const stored = parseJson<MissionMeasurement>(existing.payload_json, "stored measurement");
      if (json(stored) !== json(measurement)) throw new MissionStoreError("measurement id was replayed with different contents");
      return stored;
    }
    return this.withTransaction(() => {
      const causal = this.db.prepare(`SELECT m.payload_json FROM measurements m
        JOIN mission_events e ON e.event_id = m.event_id
        WHERE m.mission_id = ? AND e.kind = 'measurement.recorded' AND e.causal_id = ?`)
        .get(measurement.missionId, measurement.causalId);
      if (causal) {
        const stored = parseJson<MissionMeasurement>(causal.payload_json, "stored causal measurement");
        if (json({ ...stored, id: measurement.id }) !== json(measurement)) {
          throw new MissionStoreError("measurement causalId was replayed with different contents");
        }
        return stored;
      }
      const mission = this.requireMissionRow(measurement.missionId);
      if (measurement.runtimeId !== this.runtimeId) throw new MissionStoreError("new measurement runtimeId must match the current process runtime");
      if (number(mission.version, "version") !== expectedVersion) throw new MissionStoreError(`mission version conflict: expected ${expectedVersion}, observed ${String(mission.version)}`);
      this.requireRevision(measurement.missionId, measurement.revision);
      const seq = number(mission.latest_seq, "latest_seq") + 1;
      const event = makeEvent({
        eventId: measurement.id,
        missionId: measurement.missionId,
        revision: measurement.revision,
        seq,
        kind: "measurement.recorded",
        causalId: measurement.causalId,
        occurredAt: measurement.occurredAt,
        runtimeId: measurement.runtimeId,
        monotonicDurationMs: measurement.durationMs,
        unitId: measurement.unitId ?? null,
        attemptId: measurement.attemptId ?? null,
        effectId: measurement.effectId ?? null,
        teamRoundId: measurement.teamRoundId ?? null,
        provenance: { provider: measurement.provider ?? null, model: measurement.model ?? null, inputTokens: measurement.inputTokens, outputTokens: measurement.outputTokens, usageUnknownReason: measurement.usageUnknownReason ?? null },
        payload: measurement as unknown as Record<string, unknown>,
      });
      this.requireVersion(measurement.missionId, expectedVersion);
      this.insertEvent(event);
      this.db.prepare("INSERT INTO measurements (measurement_id, mission_id, revision, event_id, payload_json) VALUES (?, ?, ?, ?, ?)")
        .run(measurement.id, measurement.missionId, measurement.revision, event.eventId, json(measurement));
      this.advanceProjection(measurement.missionId, expectedVersion, seq);
      return measurement;
    });
  }

  recordEvaluationObservation(value: unknown, expectedVersion: number): EvaluationObservation {
    this.assertWriterClaim();
    const candidate = value as Record<string, unknown>;
    if (!candidate || typeof candidate !== "object" || typeof candidate.missionId !== "string") throw new MissionStoreError("observation missionId is required");
    requireUuid(candidate.missionId, "observation missionId");
    requireUuid(candidate.id, "observation id");
    const existing = this.db.prepare("SELECT payload_json FROM evaluation_observations WHERE observation_id = ?").get(candidate.id);
    const observation = validateEvaluationObservation(value, candidate.missionId);
    if (existing) {
      const stored = parseJson<EvaluationObservation>(existing.payload_json, "stored observation");
      if (json(stored) !== json(observation)) throw new MissionStoreError("observation id was replayed with different contents");
      return stored;
    }
    const mission = this.requireMissionRow(candidate.missionId);
    if (number(mission.version, "version") !== expectedVersion) throw new MissionStoreError(`mission version conflict: expected ${expectedVersion}, observed ${String(mission.version)}`);
    this.requireRevision(observation.missionId, observation.revision);
    if (observation.supersedesId && !this.db.prepare("SELECT observation_id FROM evaluation_observations WHERE observation_id = ? AND mission_id = ?").get(observation.supersedesId, observation.missionId)) {
      throw new MissionStoreError("superseded observation does not exist for this mission");
    }
    const seq = number(mission.latest_seq, "latest_seq") + 1;
    const event = makeEvent({
      eventId: observation.id,
      missionId: observation.missionId,
      revision: observation.revision,
      seq,
      kind: "evaluation.observed",
      causalId: observation.id,
      occurredAt: observation.observedAt,
      runtimeId: this.runtimeId,
      payload: observation as unknown as Record<string, unknown>,
    });
    this.withTransaction(() => {
      this.requireVersion(observation.missionId, expectedVersion);
      this.insertEvent(event);
      this.db.prepare(`INSERT INTO evaluation_observations (observation_id, mission_id, revision, supersedes_id, event_id, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(observation.id, observation.missionId, observation.revision, observation.supersedesId, event.eventId, json(observation));
      this.advanceProjection(observation.missionId, expectedVersion, seq);
    });
    return observation;
  }

  replayMission(missionId: string): { mission: Record<string, unknown>; reservations: Reservation[]; measurements: MissionMeasurement[]; evaluations: EvaluationObservation[]; events: MissionEvent[]; projectionHash: string } {
    const inspection = this.inspectMission(missionId);
    const created = inspection.events[0];
    if (!created || created.kind !== "mission.created" || created.seq !== 1) throw new MissionStoreError("event journal has no valid mission.created record");
    const events = inspection.events;
    for (let index = 0; index < events.length; index++) {
      const event = events[index]!;
      if (event.seq !== index + 1 || event.schemaVersion !== EVENT_SCHEMA_VERSION) throw new MissionStoreError(`event journal sequence or schema is invalid at sequence ${index + 1}`);
    }
    const revisions = events.filter(({ kind }) => kind === "mission.revised");
    let previousRevision = created.revision;
    for (const revision of revisions) {
      if (revision.revision !== previousRevision + 1 || revision.payload.parentRevision !== previousRevision) {
        throw new MissionStoreError("event journal revision ancestry is invalid");
      }
      previousRevision = revision.revision;
    }
    const latest = revisions.at(-1);
    const base = latest ? { ...created.payload, revision: latest.revision,
      snapshot: latest.payload.snapshot, unitIds: (latest.payload.snapshot as PlanSnapshot).units.map(({ id }) => id) } : created.payload;
    if (previousRevision !== inspection.revision || base.repositoryId !== inspection.repositoryId || base.planId !== inspection.planId ||
      base.revision !== inspection.revision || reduceMissionEvents(inspection).state !== inspection.state || !isDeepStrictEqual(base.snapshot, inspection.snapshot) ||
      json(base.unitIds) !== json(inspection.definition.units.map(({ id }) => id)) ||
      inspection.latestSeq !== events.length || inspection.version !== events.length) {
      throw new MissionStoreError("event replay does not match mission projection");
    }
    const reservations = events.filter(({ kind }) => kind === "reservation.created")
      .map((event) => reservationProjection(missionId, events, event.payload.reservationId)!)
      .filter(({ amount }) => amount > 0);
    const measurements = events.filter(({ kind }) => kind === "measurement.recorded").map(({ payload }) => validateMeasurement(payload, missionId));
    const evaluations = events.filter(({ kind }) => kind === "evaluation.observed").map(({ payload }) => validateEvaluationObservation(payload, missionId));
    if (json(reservations) !== json(inspection.reservations) || json(measurements) !== json(inspection.measurements) || json(evaluations) !== json(inspection.evaluations)) {
      throw new MissionStoreError("event replay does not match authoritative projections");
    }
    for (const event of events) if (!EVENT_KINDS.has(event.kind)) throw new MissionStoreError(`unknown mission event kind ${event.kind}`);
    const projection = { mission: base, reservations, measurements, evaluations, eventCount: events.length };
    return { mission: base, reservations, measurements, evaluations, events, projectionHash: sha256(Buffer.from(json(projection))) };
  }

  recordLegacyImport(missionId: string, expectedVersion: number, archive: LegacyImportArchive): MissionEvent {
    this.assertWriterClaim();
    const { preview } = archive;
    if (preview.generatedLedger) throw new MissionStoreError("generated managed ledger cannot be imported as legacy authority");
    const evidenceByPath = new Map(archive.evidence.map(({ path: name, bytes }) => [normalizeEvidencePath(name), Buffer.from(bytes)]));
    if (evidenceByPath.size !== archive.evidence.length || evidenceByPath.size !== preview.evidence.length) {
      throw new MissionStoreError("legacy import evidence paths are missing or duplicated");
    }
    for (const item of preview.evidence) {
      const bytes = evidenceByPath.get(item.path);
      if (!bytes || sha256(bytes) !== item.hash || bytes.toString("base64") !== item.bytesBase64) {
        throw new MissionStoreError(`legacy import evidence changed after preview: ${item.path}`);
      }
    }
    const verifiedPreview = this.previewLegacyImport({ planId: preview.planId, planBytes: archive.rawPlan, ledgerBytes: archive.rawLedger, evidence: archive.evidence });
    if (json(verifiedPreview) !== json(preview)) throw new MissionStoreError("legacy import preview does not match the archived files");
    if (!OBJECT_HASH.test(archive.importKey)) throw new MissionStoreError("legacy import key must be a SHA-256 digest");
    const mission = this.inspectMission(missionId);
    if (mission.planId !== preview.planId || archive.importKey !== sha256(Buffer.from(`${mission.repositoryId}\0${mission.planId}\0${preview.ledgerHash}`))) {
      throw new MissionStoreError("legacy import identity does not match the managed mission");
    }
    const holds = preview.holds.map((hold, index) => ({
      holdId: sha256(Buffer.from(`${archive.importKey}\0${index}\0${hold.raw}`)),
      index,
      ...hold,
      reconciled: false,
    }));
    const artifacts = [
      { bytes: Buffer.from(archive.rawPlan), mediaType: "application/octet-stream" },
      { bytes: Buffer.from(archive.rawLedger), mediaType: "application/octet-stream" },
      ...archive.evidence.map(({ bytes }) => ({ bytes: Buffer.from(bytes), mediaType: "application/octet-stream" })),
    ];
    const hashes = artifacts.map(({ bytes }) => sha256(bytes));
    const evidenceHashes = archive.evidence.map(({ path: name, bytes }) => ({ path: normalizeEvidencePath(name), hash: sha256(bytes) }));
    const causalId = stableEventUuid(`legacy-import:${archive.importKey}`);
    const existing = this.inspectMission(missionId).events.find((event) => event.kind === "mission.imported" && event.payload.importKey === archive.importKey);
    if (existing) {
      if (existing.payload.ledgerHash !== preview.ledgerHash || existing.payload.planHash !== preview.planHash || json(existing.payload.archiveHashes) !== json(hashes)) {
        throw new MissionStoreError("legacy import key was replayed with different archived contents");
      }
      return existing;
    }
    const [event] = this.appendTransition(missionId, expectedVersion, {
      events: [{
        revision: this.inspectMission(missionId).revision,
        kind: "mission.imported",
        causalId,
        payload: {
          importKey: archive.importKey, planId: preview.planId, planHash: preview.planHash,
          ledgerHash: preview.ledgerHash, holds, holdsKnown: preview.holdsKnown,
          warnings: preview.warnings, generatedLedger: false, archiveHashes: hashes,
          evidence: evidenceHashes,
        },
      }],
      artifacts,
    });
    return event!;
  }

  recordLegacyImportConflict(missionId: string, expectedVersion: number, archive: LegacyImportArchive): MissionEvent {
    this.assertWriterClaim();
    const { preview } = archive;
    if (preview.generatedLedger) throw new MissionStoreError("generated managed ledger cannot be imported as legacy authority");
    const verifiedPreview = this.previewLegacyImport({ planId: preview.planId, planBytes: archive.rawPlan, ledgerBytes: archive.rawLedger, evidence: archive.evidence });
    if (json(verifiedPreview) !== json(preview)) throw new MissionStoreError("legacy conflict preview does not match exact archived bytes");
    if (!OBJECT_HASH.test(archive.importKey)) throw new MissionStoreError("legacy import key must be a SHA-256 digest");
    const mission = this.inspectMission(missionId);
    if (mission.planId !== preview.planId || archive.importKey !== sha256(Buffer.from(`${mission.repositoryId}\0${mission.planId}\0${preview.ledgerHash}`))) {
      throw new MissionStoreError("legacy conflict identity does not match the managed mission");
    }
    const artifacts = [
      { bytes: Buffer.from(archive.rawPlan), mediaType: "application/octet-stream" },
      { bytes: Buffer.from(archive.rawLedger), mediaType: "application/octet-stream" },
      ...archive.evidence.map(({ bytes }) => ({ bytes: Buffer.from(bytes), mediaType: "application/octet-stream" })),
    ];
    const hashes = artifacts.map(({ bytes }) => sha256(bytes));
    const conflictHash = sha256(Buffer.from(json({ importKey: archive.importKey, hashes })));
    const causalId = stableEventUuid(`legacy-import-conflict:${conflictHash}`);
    const prior = this.inspectMission(missionId).events.find((event) => event.causalId === causalId);
    if (prior) {
      if (json(prior.payload.archiveHashes) !== json(hashes)) throw new MissionStoreError("legacy conflict identity was replayed with different archived contents");
      return prior;
    }
    const [event] = this.appendTransition(missionId, expectedVersion, {
      events: [{
        revision: this.inspectMission(missionId).revision,
        kind: "mission.import.conflict",
        causalId,
        payload: { importKey: archive.importKey, planId: preview.planId, planHash: preview.planHash, ledgerHash: preview.ledgerHash, archiveHashes: hashes, holdsKnown: false },
      }],
      artifacts,
    });
    return event!;
  }

  recordLegacyHoldReconciled(missionId: string, expectedVersion: number, input: {
    importKey: string;
    holdId: string;
    proofBytes: Uint8Array;
    proofHash: string;
    occurredAt?: string;
  }): MissionEvent {
    this.assertWriterClaim();
    const inspection = this.inspectMission(missionId);
    const imported = inspection.events.find((event) => event.kind === "mission.imported" && event.payload.importKey === input.importKey);
    if (!imported || imported.payload.holdsKnown !== true) throw new MissionStoreError("legacy holds are unknown; no hold can be retired");
    const holds = imported.payload.holds as Array<Record<string, unknown>>;
    const hold = holds.find((entry) => entry.holdId === input.holdId);
    if (!hold || hold.disposition !== "unresolved") throw new MissionStoreError("exact legacy hold is missing or not reconcilable");
    const prior = inspection.events.find((event) => event.kind === "mission.hold.reconciled" &&
      importedHoldReconciled(this, [event], imported, hold));
    if (prior) return prior;
    const proofBytes = Buffer.from(input.proofBytes);
    if (!validLegacyHoldProof(proofBytes, input.proofHash, input.holdId)) throw new MissionStoreError("legacy hold proof does not establish exact quiescence");
    const [event] = this.appendTransition(missionId, expectedVersion, {
      events: [{
        revision: inspection.revision,
        kind: "mission.hold.reconciled",
        causalId: stableEventUuid(`legacy-hold:${input.importKey}:${input.holdId}`),
        occurredAt: input.occurredAt,
        payload: {
          importKey: input.importKey, holdId: input.holdId,
          assignmentId: hold.assignmentId ?? null, unitId: hold.unitId ?? null,
          originalStatus: hold.status ?? null, disposition: "reconciled_without_outcome",
          proofHash: input.proofHash,
        },
      }],
      artifacts: [{ bytes: proofBytes, mediaType: "application/octet-stream" }],
    });
    return event!;
  }

  previewLegacyImport(input: {
    planId: string;
    planBytes: Uint8Array;
    ledgerBytes: Uint8Array;
    evidence?: Array<{ path: string; bytes: Uint8Array }>;
  }): LegacyImportPreview {
    const planId = assertPlanId(input.planId);
    const planBytes = Buffer.from(input.planBytes);
    const ledgerBytes = Buffer.from(input.ledgerBytes);
    let ledger = "";
    let decoded = true;
    try { ledger = decodeUtf8(ledgerBytes, "legacy ledger"); }
    catch { decoded = false; }
    const generatedLedger = decoded && isGeneratedMissionLedger(ledger);
    const parsedHolds = !decoded
      ? { known: false, holds: [] as LegacyHoldPreview[], warning: "legacy ledger is not valid UTF-8; exact bytes retained" }
      : generatedLedger
        ? { known: false, holds: [] as LegacyHoldPreview[], warning: "generated mission ledger is not legacy authority" }
        : parseLegacyHolds(ledger);
    const evidence = (input.evidence ?? []).map(({ path: name, bytes }) => {
      const safePath = normalizeEvidencePath(name);
      const raw = Buffer.from(bytes);
      return { path: safePath, hash: sha256(raw), bytesBase64: raw.toString("base64") };
    }).sort((a, b) => a.path.localeCompare(b.path));
    if (new Set(evidence.map(({ path: name }) => name)).size !== evidence.length) throw new MissionStoreError("legacy evidence paths must be unique");
    return {
      format: "legacy-import-preview-v1",
      planId,
      planHash: sha256(planBytes),
      ledgerHash: sha256(ledgerBytes),
      evidence,
      rawPlanBase64: planBytes.toString("base64"),
      rawLedgerBase64: ledgerBytes.toString("base64"),
      holds: parsedHolds.holds,
      holdsKnown: parsedHolds.known,
      generatedLedger,
      warnings: parsedHolds.warning ? [parsedHolds.warning] : [],
    };
  }

  async exportMission(missionId: string, directory: string): Promise<MissionExport> {
    requireUuid(missionId, "missionId");
    const target = path.resolve(directory);
    mkdirSync(path.dirname(target), { recursive: true });
    mkdirSync(target);
    const databasePath = path.join(target, "missions.sqlite");
    try {
      this.db.exec(`VACUUM INTO '${sqliteQuote(databasePath)}'`);
      fsyncFile(databasePath);
      fsyncDirectory(target);
    } catch (error) {
      rmSync(target, { recursive: true, force: true });
      throw new MissionStoreError(`mission database snapshot export failed: ${messageOf(error)}`);
    }

    try {
      const snapshotDb = await openSqlite(databasePath);
      let inspection: MissionInspection;
      let replay: ReturnType<MissionStore["replayMission"]>;
      let artifactRows: Record<string, unknown>[];
      try {
        const snapshotStore = new MissionStore(snapshotDb, this.objectDir);
        inspection = snapshotStore.inspectMission(missionId);
        replay = snapshotStore.replayMission(missionId);
        artifactRows = snapshotDb.prepare(`SELECT plan_hash AS hash, 'text/markdown; charset=utf-8' AS media_type FROM revisions
          UNION SELECT definition_hash AS hash, 'application/json' AS media_type FROM revisions ORDER BY hash`).all();
        const referenced = new Set(artifactRows.map((row) => text(row.hash, "artifact hash")));
        const hashes = new Set<string>();
        const collectHashes = (value: unknown): void => {
          if (typeof value === "string" && OBJECT_HASH.test(value)) hashes.add(value);
          else if (Array.isArray(value)) for (const item of value) collectHashes(item);
          else if (value && typeof value === "object") for (const item of Object.values(value)) collectHashes(item);
        };
        for (const event of inspection.events) collectHashes(event.payload);
        for (const hash of hashes) {
          if (referenced.has(hash)) continue;
          const artifact = snapshotDb.prepare("SELECT hash, media_type FROM objects WHERE hash = ?").get(hash);
          if (!artifact) continue;
          artifactRows.push(artifact);
          referenced.add(hash);
        }
      } finally {
        snapshotDb.close();
        fsyncFile(databasePath);
        rmSync(`${databasePath}-wal`, { force: true });
        rmSync(`${databasePath}-shm`, { force: true });
        fsyncDirectory(target);
      }

      const artifacts: Array<{ hash: string; size: number; mediaType: string; path: string }> = [];
      for (const row of artifactRows) {
        const hash = text(row.hash, "artifact hash");
        const bytes = this.readObject(hash);
        const relative = path.join("objects", hash.slice(0, 2), hash);
        writeAtomic(path.join(target, relative), bytes);
        artifacts.push({ hash, size: bytes.length, mediaType: text(row.media_type, "media_type"), path: relative.split(path.sep).join("/") });
      }
      const ledger = renderGeneratedLedger(inspection);
      const locator = { format: "mission-locator-v1", missionId, repositoryId: inspection.repositoryId, planId: inspection.planId, revision: inspection.revision, eventSeq: inspection.latestSeq };
      writeAtomic(path.join(target, "mission.json"), Buffer.from(json(locator) + "\n"));
      writeAtomic(path.join(target, "ledger.md"), Buffer.from(ledger));
      const manifest = {
        format: "mission-export-v1",
        schemaVersion: MISSION_STORE_SCHEMA_VERSION,
        missionId,
        repositoryId: inspection.repositoryId,
        planId: inspection.planId,
        revision: inspection.revision,
        eventSeq: inspection.latestSeq,
        version: inspection.version,
        projectionHash: replay.projectionHash,
        database: { path: "missions.sqlite", hash: hashFile(databasePath), size: statSync(databasePath).size },
        artifacts,
        generatedViews: [
          { path: "mission.json", hash: hashFile(path.join(target, "mission.json")) },
          { path: "ledger.md", hash: hashFile(path.join(target, "ledger.md")) },
        ],
      };
      const manifestPath = path.join(target, "export.json");
      writeAtomic(manifestPath, Buffer.from(json(manifest) + "\n"));
      fsyncDirectory(target);
      return { directory: target, manifestPath, databasePath, missionId, eventSeq: inspection.latestSeq };
    } catch (error) {
      throw new MissionStoreError(`mission artifact export failed; partial export kept at ${target}: ${messageOf(error)}`);
    }
  }

  private assertActiveTimeCheckpoint(inspection: MissionInspection, drafts: MissionEventDraft[]): void {
    const [settlement, checkpoint] = drafts;
    const charge = settlement!.payload;
    const tick = checkpoint!.payload;
    const window = [...inspection.events].reverse().find((event) =>
      event.kind === "mission.active.window.opened" || event.kind === "mission.active.window.closed");
    if (settlement!.kind === "resource.metered.settled") {
      const ticket = meteredConsumptions(inspection.events).find(row => row.ticketId === tick.ticketId);
      if (!window || window.kind !== "mission.active.window.opened" ||
        window.payload.windowId !== tick.windowId || window.payload.ticketId !== tick.ticketId ||
        window.payload.runtimeId !== this.runtimeId || window.payload.ownerEpoch !== this.ownerEpoch ||
        reduceMissionEvents(inspection).state === "paused" || drafts.some(draft => draft.revision !== inspection.revision) ||
        !ticket?.outstanding || ticket.resource !== "active-time-ms" || ticket.ownerEpoch !== this.ownerEpoch ||
        charge.ticketId !== ticket.ticketId || charge.resource !== ticket.resource ||
        !Number.isSafeInteger(tick.durationMs) || Number(tick.durationMs) < 1 ||
        tick.cumulativeKnownMs !== ticket.knownCharge + Number(tick.durationMs) ||
        charge.knownCharge !== tick.cumulativeKnownMs || charge.unknown !== false || charge.outstanding !== true || tick.measured !== true)
        throw new MissionStoreError("metered checkpoint must charge the current owned interval");
      return;
    }
    const reservation = inspection.reservations.find(({ id }) => id === tick.reservationId);
    if (!window || window.kind !== "mission.active.window.opened" ||
      window.payload.windowId !== tick.windowId || window.payload.reservationId !== tick.reservationId ||
      window.payload.runtimeId !== this.runtimeId || window.payload.ownerEpoch !== this.ownerEpoch ||
      reduceMissionEvents(inspection).state === "paused" ||
      drafts.some((draft) => draft.revision !== inspection.revision) ||
      !reservation || reservation.resource !== "active-time-ms" || reservation.purpose !== "ordinary" ||
      charge.resource !== reservation.resource ||
      charge.reservationId !== reservation.id || !Number.isSafeInteger(tick.durationMs) || Number(tick.durationMs) < 1 ||
      tick.cumulativeKnownMs !== reservation.knownCharge + Number(tick.durationMs) ||
      charge.knownCharge !== tick.cumulativeKnownMs || charge.unknownCharge !== reservation.unknownCharge ||
      charge.released !== reservation.released || tick.measured !== true ||
      Number(charge.knownCharge) + reservation.unknownCharge + reservation.released >= reservation.grantAmount) {
      throw new MissionStoreError("active-time checkpoint must charge the current owned window without renewing authority");
    }
  }

  private inspectWithinTransaction(missionId: string, hydratePrepared = true): MissionInspection {
    const mission = this.requireMissionRow(missionId);
    const revision = this.db.prepare("SELECT * FROM revisions WHERE mission_id = ? AND revision = ?").get(missionId, mission.revision);
    if (!revision) throw new MissionStoreError("mission revision projection is missing");
    if (number(revision.schema_version, "revision schema_version") !== 1) throw new MissionStoreError("mission revision storage schema is unsupported");
    const envelope = parseJson(revision.admission_json, "admission provenance");
    const schemaVersion = envelope.schemaVersion === 3 ? 3 : envelope.schemaVersion === 2 ? 2 : 1;
    const admission = schemaVersion !== 1
      ? parseJson<{ provenance: PlanSnapshot["admissionProvenance"]; preparedHash: string; sourceBinding: NonNullable<PlanSnapshot["sourceBinding"]> }>(
        revision.admission_json, "generated admission provenance") : undefined;
    const snapshot: PlanSnapshot = {
      schemaVersion,
      ...(admission ? { preparedHash: admission.preparedHash, sourceBinding: admission.sourceBinding } : {}),
      planId: text(mission.plan_id, "plan_id"),
      revision: number(mission.revision, "revision"),
      sourcePath: text(revision.source_path, "source_path"),
      planHash: text(revision.plan_hash, "plan_hash"),
      definitionHash: text(revision.definition_hash, "definition_hash"),
      parentRevision: revision.parent_revision === null ? null : number(revision.parent_revision, "parent_revision"),
      admissionProvenance: admission?.provenance ?? parseJson<PlanSnapshot["admissionProvenance"]>(revision.admission_json, "admission provenance"),
      units: parseJson(revision.unit_mapping_json, "unit mapping"),
    };
    if (!OBJECT_HASH.test(snapshot.planHash) || !OBJECT_HASH.test(snapshot.definitionHash)) throw new MissionStoreError("mission snapshot contains an invalid object hash");
    const planBytes = this.readObject(snapshot.planHash);
    const definitionBytes = this.readObject(snapshot.definitionHash);
    const objectRows = this.db.prepare("SELECT hash, size FROM objects WHERE hash IN (?, ?)").all(snapshot.planHash, snapshot.definitionHash);
    const objectSizes = new Map(objectRows.map((row) => [text(row.hash, "object hash"), number(row.size, "object size")]));
    if (objectRows.length !== 2 || objectSizes.get(snapshot.planHash) !== planBytes.length || objectSizes.get(snapshot.definitionHash) !== definitionBytes.length) {
      throw new MissionStoreError("mission snapshot object projection is incomplete or corrupt");
    }
    const planMeta = parsePlanDocument(decodeUtf8(planBytes, "stored plan"));
    if (planMeta.id !== snapshot.planId || planMeta.revision !== snapshot.revision || planMeta.status !== "frozen" || planMeta.hash !== snapshot.planHash) {
      throw new MissionStoreError("stored plan bytes do not match immutable snapshot metadata");
    }
    const definition = validateMissionDefinitionBytes(definitionBytes).definition;
    let prepared: PreparedMission | undefined;
    if (schemaVersion !== 1) {
      if (!snapshot.preparedHash || !OBJECT_HASH.test(snapshot.preparedHash) || !snapshot.sourceBinding)
        throw new MissionStoreError("generated snapshot lacks prepared source identity");
      if (hydratePrepared) {
        prepared = JSON.parse(this.readObject(snapshot.preparedHash).toString()) as PreparedMission;
        if (prepared.format !== "prepared-mission-v1" || prepared.inventory.sourceHash !== sha256(Buffer.from(prepared.originalSource)) ||
          json(prepared.binding) !== json(snapshot.sourceBinding) || json(prepared.definition) !== json(definition) ||
          prepared.binding.hash !== prepared.inventory.sourceHash || prepared.binding.planSource !== snapshot.sourcePath ||
          repositoryIdentity(prepared.binding.executionRoot) !== prepared.repositoryFamily)
          throw new MissionStoreError("immutable prepared inputs do not match generated snapshot");
      }
    }
    if (definition.schemaVersion !== schemaVersion) throw new MissionStoreError("executable definition and snapshot versions differ");
    const unitMapping = definition.units.map(({ id, parentId }) => ({ id, ...(parentId ? { parentId } : {}) }));
    if (json(snapshot.units) !== json(unitMapping)) throw new MissionStoreError("stored unit mapping does not match executable snapshot");
    const unitRows = this.db.prepare("SELECT definition_json FROM units WHERE mission_id = ? AND revision = ? ORDER BY rowid").all(missionId, snapshot.revision)
      .map((row) => parseJson(row.definition_json, "unit projection"));
    if (json(unitRows) !== json(definition.units)) throw new MissionStoreError("unit projection does not match executable snapshot");
    const events = this.db.prepare("SELECT * FROM mission_events WHERE mission_id = ? ORDER BY seq").all(missionId).map(readEvent);
    const reservations = events.filter(({ kind }) => kind === "reservation.created")
      .map((event) => reservationProjection(missionId, events, event.payload.reservationId)!)
      .filter(({ amount }) => amount > 0);
    const measurements = this.db.prepare(`SELECT m.payload_json FROM measurements m JOIN mission_events e ON e.event_id = m.event_id
      WHERE m.mission_id = ? ORDER BY e.seq`).all(missionId).map((row) => validateMeasurement(parseJson(row.payload_json, "measurement projection"), missionId));
    const evaluations = this.db.prepare(`SELECT o.payload_json FROM evaluation_observations o JOIN mission_events e ON e.event_id = o.event_id
      WHERE o.mission_id = ? ORDER BY e.seq`).all(missionId).map((row) => validateEvaluationObservation(parseJson(row.payload_json, "evaluation projection"), missionId));
    return {
      id: text(mission.mission_id, "mission_id"),
      repositoryId: text(mission.repository_id, "repository_id"),
      planId: text(mission.plan_id, "plan_id"),
      revision: number(mission.revision, "revision"),
      state: text(mission.state, "state") as MissionRecord["state"],
      version: number(mission.version, "version"),
      latestSeq: number(mission.latest_seq, "latest_seq"),
      snapshot,
      definition,
      ...(prepared ? { prepared } : {}),
      planBytes,
      definitionBytes,
      events,
      reservations,
      measurements,
      evaluations,
    };
  }

  private requireMission(missionId: string): MissionRecord {
    const inspection = this.inspectMission(missionId);
    const { planBytes: _planBytes, definitionBytes: _definitionBytes, events: _events, reservations: _reservations, measurements: _measurements, evaluations: _evaluations, ...record } = inspection;
    return record;
  }

  private requireMissionRow(missionId: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM missions WHERE mission_id = ?").get(missionId);
    if (!row) throw new MissionStoreError(`mission not found: ${missionId}`);
    return row;
  }

  private requireRevision(missionId: string, revision: number): void {
    if (!this.db.prepare("SELECT revision FROM revisions WHERE mission_id = ? AND revision = ?").get(missionId, revision)) {
      throw new MissionStoreError(`mission revision not found: ${missionId}@${revision}`);
    }
  }

  private requireVersion(missionId: string, version: number): void {
    const row = this.requireMissionRow(missionId);
    if (number(row.version, "version") !== version) throw new MissionStoreError(`mission version conflict: expected ${version}, observed ${String(row.version)}`);
  }

  private advanceProjection(missionId: string, expectedVersion: number, seq: number): void {
    const result = this.db.prepare("UPDATE missions SET version = version + 1, latest_seq = ? WHERE mission_id = ? AND version = ?")
      .run(seq, missionId, expectedVersion);
    if (result.changes !== 1) throw new MissionStoreError("mission version changed during atomic append");
  }

  private insertEvent(event: MissionEvent): void {
    this.db.prepare(`INSERT INTO mission_events (event_id, mission_id, revision, seq, schema_version, kind, causal_id, occurred_at, runtime_id,
      monotonic_duration_ms, unit_id, attempt_id, effect_id, team_round_id, reason, provenance_json, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.eventId, event.missionId, event.revision, event.seq, event.schemaVersion, event.kind, event.causalId, event.occurredAt, event.runtimeId,
        event.monotonicDurationMs, event.unitId, event.attemptId, event.effectId, event.teamRoundId, event.reason,
        event.provenance === null ? null : json(event.provenance), json(event.payload));
  }

  private insertObject(object: { hash: string; bytes: Buffer; mediaType: string }): void {
    const existing = this.db.prepare("SELECT size, media_type FROM objects WHERE hash = ?").get(object.hash);
    if (existing) {
      if (number(existing.size, "object size") !== object.bytes.length || text(existing.media_type, "object media type") !== object.mediaType) {
        throw new MissionStoreError(`object metadata conflicts for ${object.hash}`);
      }
      return;
    }
    this.db.prepare("INSERT INTO objects (hash, size, media_type, created_at) VALUES (?, ?, ?, ?)")
      .run(object.hash, object.bytes.length, object.mediaType, new Date().toISOString());
  }

  private writeObject(bytesInput: Uint8Array, mediaType: string): { hash: string; bytes: Buffer; mediaType: string } {
    const bytes = Buffer.from(bytesInput);
    const hash = sha256(bytes);
    const directory = path.join(this.objectDir, hash.slice(0, 2));
    ensureDirectory(directory);
    const target = path.join(directory, hash);
    if (existsSync(target)) {
      const current = readFileSync(target);
      if (sha256(current) !== hash || !current.equals(bytes)) throw new MissionStoreError(`content-addressed object is corrupt: ${hash}`);
      return { hash, bytes, mediaType };
    }
    const temporary = path.join(directory, `.tmp-${process.pid}-${randomUUID()}`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.onDurabilityBoundary?.("object.after-temp-sync");
    try {
      linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readFileSync(target);
      if (sha256(current) !== hash || !current.equals(bytes)) throw new MissionStoreError(`content-addressed object collision or corruption: ${hash}`);
    }
    rmSync(temporary, { force: true });
    fsyncDirectory(directory);
    this.onDurabilityBoundary?.("object.after-rename");
    return { hash, bytes, mediaType };
  }

  private readObject(hash: string): Buffer {
    if (!OBJECT_HASH.test(hash)) throw new MissionStoreError(`invalid object hash ${hash}`);
    const target = path.join(this.objectDir, hash.slice(0, 2), hash);
    let state;
    try { state = lstatSync(target); }
    catch (error) { throw new MissionStoreError(`mission object ${hash} is missing: ${messageOf(error)}`); }
    if (!state.isFile() || state.isSymbolicLink()) throw new MissionStoreError(`mission object ${hash} is not a regular file`);
    let bytes: Buffer;
    if (this.historyObjectBytes !== undefined) {
      if (state.size > this.historyObjectBytes) {
        this.historyObjectLimited = true;
        throw new MissionStoreError("history_authority_limit");
      }
      this.historyObjectBytes -= state.size;
      const fd = openSync(target, "r");
      try {
        bytes = Buffer.alloc(state.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, Math.min(4096, bytes.length - offset), offset);
          if (!count) throw new MissionStoreError("history authority object changed while reading");
          offset += count;
        }
        if (fstatSync(fd).size !== state.size) throw new MissionStoreError("history authority object changed while reading");
      } finally { closeSync(fd); }
    } else bytes = readFileSync(target);
    if (sha256(bytes) !== hash) throw new MissionStoreError(`mission object ${hash} failed its SHA-256 check`);
    return bytes;
  }

  private withTransaction<T>(action: () => T): T {
    this.assertWriterClaim();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertWriterClaim();
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* connection may already be closed */ }
      throw error;
    }
  }

  private assertWriterClaim(): void {
    if (this.closed) throw new MissionStoreError("mission store is closed");
    if (!this.writerClaim) throw new MissionStoreError("mission store is read-only; writer reservation is held or unproven");
    const current = this.db.prepare("SELECT value FROM store_meta WHERE key = 'owner_epoch'").get();
    const claim = this.db.prepare("SELECT value FROM store_meta WHERE key = 'owner_claim_id'").get();
    if (current?.value !== String(this.writerClaim.epoch) || claim?.value !== this.writerClaim.id) {
      throw new MissionStoreError("mission store writer reservation is stale");
    }
  }

  private verifyRepositoryContinuity(marker: RepositoryMarker, workspace: VerifiedWorkspace): void {
    const markerHash = sha256(Buffer.from(json(marker)));
    const row = this.db.prepare("SELECT value FROM store_meta WHERE key = ?").get(`repository_continuity:${marker.repositoryId}`);
    if (!row) throw new MissionStoreError("repository continuity proof is missing; identity is unproven");
    let proof: RepositoryContinuityProof;
    try { proof = JSON.parse(text(row.value, "repository continuity proof")) as RepositoryContinuityProof; }
    catch (error) { throw new MissionStoreError(`repository continuity proof is corrupt: ${messageOf(error)}`); }
    if (proof.schemaVersion !== 1 || proof.markerHash !== markerHash) throw new MissionStoreError("repository continuity proof does not match stored marker; identity is unproven");
    verifyRepositoryContinuityProof(proof, workspace);
  }

  private readStoreInstanceId(): string | undefined {
    const existing = this.db.prepare("SELECT value FROM store_meta WHERE key = 'store_instance_id'").get();
    return existing ? requireUuid(text(existing.value, "store_instance_id"), "store instance id") : undefined;
  }

  private requireStoreInstanceId(): string {
    const existing = this.readStoreInstanceId();
    if (existing) return existing;
    const created = randomUUID();
    this.withTransaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES ('store_instance_id', ?)").run(created);
    });
    return requireUuid(text(this.db.prepare("SELECT value FROM store_meta WHERE key = 'store_instance_id'").get()?.value, "store_instance_id"), "store instance id");
  }

  private findRepositoryAt(commonDir: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT repository_id FROM repository_locations WHERE canonical_path = ? AND kind = 'common'").get(commonDir);
  }

  private registerRepository(marker: RepositoryMarker, workspace: VerifiedWorkspace, continuity?: RepositoryContinuityProof): void {
    this.withTransaction(() => {
      const existing = this.db.prepare("SELECT host_id FROM repositories WHERE repository_id = ?").get(marker.repositoryId);
      if (existing && existing.host_id !== marker.hostId) throw new MissionStoreError("repository id conflicts with a different host identity");
      const location = this.db.prepare("SELECT repository_id FROM repository_locations WHERE canonical_path = ?").get(workspace.commonDir);
      if (location && location.repository_id !== marker.repositoryId) throw new MissionStoreError("Git common directory is already bound to a different repository family id");
      const proofKey = `repository_marker:${marker.repositoryId}`;
      const proof = this.db.prepare("SELECT value FROM store_meta WHERE key = ?").get(proofKey);
      const markerHash = sha256(Buffer.from(json(marker)));
      if (proof && proof.value !== markerHash) throw new MissionStoreError("repository marker does not match stored owner proof");
      if (!proof && (existing || location)) throw new MissionStoreError("repository marker has no stored owner proof");
      if (continuity && continuity.markerHash !== markerHash) throw new MissionStoreError("repository continuity proof does not match its marker");
      if (!continuity && !this.db.prepare("SELECT value FROM store_meta WHERE key = ?").get(`repository_continuity:${marker.repositoryId}`)) {
        throw new MissionStoreError("repository continuity proof is missing; identity is unproven");
      }
      const now = new Date().toISOString();
      this.db.prepare("INSERT OR IGNORE INTO repositories (repository_id, host_id, created_at) VALUES (?, ?, ?)")
        .run(marker.repositoryId, marker.hostId, marker.createdAt);
      this.db.prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)").run(proofKey, markerHash);
      if (continuity) {
        this.db.prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)")
          .run(`repository_continuity:${marker.repositoryId}`, json(continuity));
      }
      this.upsertLocation(workspace.commonDir, marker.repositoryId, "common", now);
      this.upsertLocation(workspace.root, marker.repositoryId, "worktree", now);
    });
  }

  private upsertLocation(canonicalPath: string, repositoryId: string, kind: "common" | "worktree", now: string): void {
    const prior = this.db.prepare("SELECT repository_id, kind FROM repository_locations WHERE canonical_path = ?").get(canonicalPath);
    if (prior && (prior.repository_id !== repositoryId || prior.kind !== kind)) throw new MissionStoreError(`repository location ${canonicalPath} is already registered to a different family`);
    this.db.prepare(`INSERT INTO repository_locations (canonical_path, repository_id, kind, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(canonical_path) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
      .run(canonicalPath, repositoryId, kind, now, now);
  }
}

export function renderGeneratedLedger(mission: MissionRecord | MissionInspection): string {
  const unitList = mission.snapshot.units.map(({ id }) => `- ${id}`).join("\n");
  return [
    "---",
    "format: mission-ledger-v1",
    `mission_id: ${mission.id}`,
    `event_seq: ${mission.latestSeq}`,
    "---",
    "",
    "# Managed mission ledger",
    "",
    "This file is a generated view. The mission store is authoritative.",
    "",
    `- Plan: ${mission.planId}@${mission.revision}`,
    `- State: ${mission.state}`,
    `- Version: ${mission.version}`,
    "",
    "## Units",
    "",
    unitList,
    "",
  ].join("\n");
}

function validateSqliteFile(file: string): void {
  const state = lstatSync(file);
  if (!state.isFile() || state.isSymbolicLink() || state.size < 512) {
    throw new MissionStoreError(`mission database has an invalid SQLite header at ${file}; refusing to initialize an empty mission store`);
  }
  const header = Buffer.alloc(100);
  const fd = openSync(file, "r");
  try { readSync(fd, header, 0, header.length, 0); }
  finally { closeSync(fd); }
  const pageSize = header.readUInt16BE(16) === 1 ? 65536 : header.readUInt16BE(16);
  if (header.toString("binary", 0, 16) !== "SQLite format 3\0" || pageSize < 512 || pageSize > 65536 ||
    (pageSize & (pageSize - 1)) !== 0 || state.size % pageSize !== 0) {
    throw new MissionStoreError(`mission database has an invalid SQLite header at ${file}; refusing to initialize an empty mission store`);
  }
}

function initializeNewDatabase(db: SqlDatabase, dbPath: string): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'").all();
  if (pragmaInteger(db, "user_version") !== 0 || tables.length > 0) {
    throw new MissionStoreError(`new mission database path already contains a schema at ${dbPath}`);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of SCHEMA) db.exec(statement);
    db.exec(`CREATE TABLE schema_meta (version INTEGER NOT NULL CHECK (version = ${MISSION_STORE_SCHEMA_VERSION}))`);
    db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(MISSION_STORE_SCHEMA_VERSION);
    db.exec(`PRAGMA user_version = ${MISSION_STORE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* connection may already be closed */ }
    throw error;
  }
  validateExistingDatabase(db, dbPath);
}

function validateExistingDatabase(db: SqlDatabase, dbPath: string): number {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new MissionStoreError(`mission database integrity check failed at ${dbPath}: ${JSON.stringify(integrity)}`);
  const version = pragmaInteger(db, "user_version");
  if (version !== 1 && version !== MISSION_STORE_SCHEMA_VERSION) {
    throw new MissionStoreError(`mission database schema version ${version} is unsupported at ${dbPath}; refusing to initialize or downgrade`);
  }
  validateSchema(db, dbPath, version);
  return version;
}

function canAttemptWriterClaim(db: SqlDatabase): boolean {
  if (pragmaInteger(db, "user_version") !== MISSION_STORE_SCHEMA_VERSION) return false;
  const epoch = Number(db.prepare("SELECT value FROM store_meta WHERE key = 'owner_epoch'").get()?.value);
  const claimId = db.prepare("SELECT value FROM store_meta WHERE key = 'owner_claim_id'").get()?.value;
  if (!Number.isSafeInteger(epoch) || epoch < 0 || typeof claimId !== "string") return false;
  if (epoch === 0 && claimId === "") return true;
  const previous = readStoredWriterOwner(db);
  if (!previous || previous.epoch !== epoch) return false;
  if (claimId === "") return hasMatchingRetirementAck(db, previous);
  if (previous.claimId !== claimId) return false;
  try { return ownerProcessState(previous.owner) === "dead"; }
  catch { return false; }
}

function claimWriterReservation(db: SqlDatabase, admit?: () => void): WriterClaim | undefined {
  // The callback may open its own read snapshots. No valid mission writer can change
  // their contents without a claim; compare that claim again under the write lock.
  const observedOwner = admit ? db.prepare("SELECT key, value FROM store_meta WHERE key IN ('owner_epoch', 'owner_claim_id') ORDER BY key").all() : undefined;
  admit?.();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (observedOwner && json(observedOwner) !== json(db.prepare("SELECT key, value FROM store_meta WHERE key IN ('owner_epoch', 'owner_claim_id') ORDER BY key").all()))
      throw new MissionStoreError("ownership changed during writer admission; repeat /mission action");
    const epochRow = db.prepare("SELECT value FROM store_meta WHERE key = 'owner_epoch'").get();
    const claimRow = db.prepare("SELECT value FROM store_meta WHERE key = 'owner_claim_id'").get();
    const current = Number(epochRow?.value);
    const claimId = claimRow?.value;
    if (typeof claimId !== "string" || !Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) {
      db.exec("COMMIT");
      return undefined;
    }
    let source: "initial" | "retirement" | "owner-death";
    let previous: StoredWriterOwner | undefined;
    let retirementEventId: string | undefined;
    if (current === 0 && claimId === "") {
      source = "initial";
    } else {
      previous = readStoredWriterOwner(db);
      if (!previous || previous.epoch !== current || (claimId !== "" && previous.claimId !== claimId)) {
        db.exec("COMMIT");
        return undefined;
      }
      if (claimId === "") {
        if (!hasMatchingRetirementAck(db, previous)) {
          db.exec("COMMIT");
          return undefined;
        }
        source = "retirement";
        retirementEventId = readRetirementAck(db)?.eventId;
      } else {
        let processState: "live" | "dead" | "unknown";
        try { processState = ownerProcessState(previous.owner); } catch { processState = "unknown"; }
        if (processState !== "dead") {
          db.exec("COMMIT");
          return undefined;
        }
        source = "owner-death";
      }
    }
    for (const [key, value] of [
      ["owner_claim_owner", ""], ["owner_release_ack", ""], ["owner_acquisition_proof", ""],
    ]) db.prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)").run(key, value);
    const claim: WriterClaim = {
      id: randomUUID(), epoch: current + 1,
      owner: currentProcessIdentity(PROCESS_RUNTIME_ID, current + 1),
    };
    const storedOwner: StoredWriterOwner = { claimId: claim.id, epoch: claim.epoch, owner: claim.owner };
    const proof = {
      schemaVersion: 1, source, claimId: claim.id, epoch: claim.epoch,
      ...(previous ? { previous } : {}), ...(retirementEventId ? { retirementEventId } : {}),
    };
    db.prepare("UPDATE store_meta SET value = ? WHERE key = 'owner_epoch'").run(String(claim.epoch));
    db.prepare("UPDATE store_meta SET value = ? WHERE key = 'owner_claim_id'").run(claim.id);
    db.prepare("UPDATE store_meta SET value = ? WHERE key = 'owner_claim_owner'").run(json(storedOwner));
    db.prepare("UPDATE store_meta SET value = '' WHERE key = 'owner_release_ack'").run();
    db.prepare("UPDATE store_meta SET value = ? WHERE key = 'owner_acquisition_proof'").run(json(proof));
    db.exec("COMMIT");
    return claim;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* connection may already be closed */ }
    throw error;
  }
}

function releaseWriterReservation(db: SqlDatabase, claim: WriterClaim, acknowledgement: WriterRetirementAck): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const epoch = db.prepare("SELECT value FROM store_meta WHERE key = 'owner_epoch'").get();
    const stored = db.prepare("SELECT value FROM store_meta WHERE key = 'owner_claim_id'").get();
    const storedOwner = readStoredWriterOwner(db);
    const persisted = findRetirementAcknowledgement(db, claim);
    if (epoch?.value !== String(claim.epoch) || stored?.value !== claim.id || !storedOwner ||
      storedOwner.claimId !== claim.id || !sameProcessIdentity(storedOwner.owner, claim.owner) ||
      !persisted || persisted.eventId !== acknowledgement.eventId) {
      throw new MissionStoreError("mission store writer reservation is not held by this handle");
    }
    db.prepare("UPDATE store_meta SET value = ? WHERE key = 'owner_release_ack'").run(json(acknowledgement));
    const released = db.prepare("UPDATE store_meta SET value = '' WHERE key = 'owner_claim_id' AND value = ?").run(claim.id);
    if (released.changes !== 1) throw new MissionStoreError("mission store writer reservation release failed");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* connection may already be closed */ }
    throw error;
  }
}

function readStoredWriterOwner(db: SqlDatabase): StoredWriterOwner | undefined {
  const raw = db.prepare("SELECT value FROM store_meta WHERE key = 'owner_claim_owner'").get()?.value;
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const stored = JSON.parse(raw) as StoredWriterOwner;
    if (!stored || typeof stored.claimId !== "string" || !stored.claimId || !Number.isSafeInteger(stored.epoch) ||
      !isProcessIdentity(stored.owner) || stored.owner.epoch !== stored.epoch) return undefined;
    return stored;
  } catch { return undefined; }
}

function readRetirementAck(db: SqlDatabase): WriterRetirementAck | undefined {
  const raw = db.prepare("SELECT value FROM store_meta WHERE key = 'owner_release_ack'").get()?.value;
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const acknowledgement = JSON.parse(raw) as WriterRetirementAck;
    if (!acknowledgement || typeof acknowledgement.claimId !== "string" || !Number.isSafeInteger(acknowledgement.epoch) ||
      typeof acknowledgement.eventId !== "string" || !isProcessIdentity(acknowledgement.owner) ||
      acknowledgement.owner.epoch !== acknowledgement.epoch) return undefined;
    return acknowledgement;
  } catch { return undefined; }
}

function hasMatchingRetirementAck(db: SqlDatabase, previous: StoredWriterOwner): boolean {
  const acknowledgement = readRetirementAck(db);
  return Boolean(acknowledgement && acknowledgement.claimId === previous.claimId && acknowledgement.epoch === previous.epoch &&
    sameProcessIdentity(acknowledgement.owner, previous.owner));
}

function findRetirementAcknowledgement(db: SqlDatabase, claim: WriterClaim): WriterRetirementAck | undefined {
  const rows = db.prepare("SELECT event_id, runtime_id, payload_json FROM mission_events WHERE kind = 'mission.owner.released'").all();
  for (const row of rows) {
    if (row.runtime_id !== claim.owner.runtimeId) continue;
    try {
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      const owner = payload.owner as ProcessIdentity | undefined;
      if (payload.effectsQuiescent !== true || !owner || !sameProcessIdentity(owner, claim.owner)) continue;
      return { claimId: claim.id, epoch: claim.epoch, owner: claim.owner, eventId: String(row.event_id) };
    } catch { /* ignore malformed retirement evidence */ }
  }
  return undefined;
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<ProcessIdentity>;
  return typeof identity.hostId === "string" && typeof identity.bootId === "string" &&
    Number.isSafeInteger(identity.pid) && Number.isSafeInteger(identity.birthTicks) &&
    typeof identity.runtimeId === "string" && Number.isSafeInteger(identity.epoch);
}

function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.hostId === right.hostId && left.bootId === right.bootId && left.pid === right.pid &&
    left.birthTicks === right.birthTicks && left.runtimeId === right.runtimeId && left.epoch === right.epoch;
}

function validateSchema(db: SqlDatabase, dbPath: string, expectedVersion = MISSION_STORE_SCHEMA_VERSION): void {
  const version = db.prepare("SELECT version FROM schema_meta").get();
  if (!version || version.version !== expectedVersion) throw new MissionStoreError(`mission database schema metadata is incomplete at ${dbPath}`);
  const required: Record<string, string[]> = {
    store_meta: ["key", "value"],
    repositories: ["repository_id", "host_id", "created_at"],
    repository_locations: ["canonical_path", "repository_id", "kind", "first_seen_at", "last_seen_at"],
    objects: ["hash", "size", "media_type", "created_at"],
    missions: ["mission_id", "command_id", "repository_id", "plan_id", "revision", "state", "version", "latest_seq", "created_at"],
    revisions: ["mission_id", "revision", "schema_version", "plan_hash", "definition_hash", "source_path", "parent_revision", "admission_json", "unit_mapping_json"],
    units: ["mission_id", "revision", "unit_id", "parent_id", "definition_json"],
    mission_events: ["event_id", "mission_id", "revision", "seq", "schema_version", "kind", "causal_id", "occurred_at", "runtime_id", "monotonic_duration_ms", "unit_id", "attempt_id", "effect_id", "team_round_id", "reason", "provenance_json", "payload_json"],
    reservations: ["reservation_id", "mission_id", "revision", "resource", "amount", "event_id", "payload_json"],
    measurements: ["measurement_id", "mission_id", "revision", "event_id", "payload_json"],
    evaluation_observations: ["observation_id", "mission_id", "revision", "supersedes_id", "event_id", "payload_json"],
  };
  for (const [table, expected] of Object.entries(required)) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    if (!expected.every((column) => columns.has(column))) throw new MissionStoreError(`mission database schema is incomplete: ${table} at ${dbPath}`);
  }
  if (expectedVersion === MISSION_STORE_SCHEMA_VERSION) {
    for (const [table, name, columns] of [
      ["missions", "active_mission_per_repository_plan", ["repository_id", "plan_id"]],
      ["mission_events", "measurement_causal_fact", ["mission_id", "causal_id"]],
    ] as const) {
      const index = db.prepare(`PRAGMA index_list(${table})`).all().find((row) => row.name === name);
      const indexedColumns = db.prepare(`PRAGMA index_info(${name})`).all().map((row) => row.name);
      if (!index || index.unique !== 1 || index.partial !== 1 || json(indexedColumns) !== json(columns)) {
        throw new MissionStoreError(`mission database schema is incomplete: index ${name} at ${dbPath}`);
      }
    }
  }
}

interface RepositoryMarker {
  schemaVersion: 2;
  repositoryId: string;
  hostId: string;
  storeInstanceId: string;
  commonDir: string;
  gitDirectoryId: string;
  createdAt: string;
}

interface RepositoryContinuityProof {
  schemaVersion: 1;
  markerHash: string;
  commonDirectory: DirectoryIncarnation;
  objectsDirectory: DirectoryIncarnation;
  objectFormat: "sha1" | "sha256";
  witness: { type: "commit"; oid: string } | null;
  refs: Array<{ name: string; oid: string; peeledOid: string | null }>;
  config: Record<string, string[]>;
}

interface DirectoryIncarnation {
  dev: string;
  ino: string;
  birthtimeNs: string | null;
}

interface VerifiedWorkspace {
  root: string;
  commonDir: string;
  gitDir: string;
}

function verifiedWorkspace(input: string): VerifiedWorkspace {
  let root: string;
  let commonDir: string;
  let gitDir: string;
  try {
    root = currentWorkspace(path.resolve(input));
    commonDir = repositoryIdentity(root);
    gitDir = runGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    gitDir = realpathSync(gitDir);
  } catch (error) {
    throw new MissionStoreError(`could not verify Git repository: ${messageOf(error)}`);
  }
  if (commonDir === root) throw new MissionStoreError("mission repository identity requires a non-bare Git working tree");
  let roots: string[];
  try { roots = registeredWorktrees(root, commonDir); }
  catch (error) { throw new MissionStoreError(`could not verify registered Git worktree: ${messageOf(error)}`); }
  if (!roots.includes(root)) throw new MissionStoreError(`worktree ${root} is not registered with Git common directory ${commonDir}`);
  return { root, commonDir, gitDir };
}

function captureRepositoryContinuity(marker: RepositoryMarker, workspace: VerifiedWorkspace): RepositoryContinuityProof {
  const commonDirectory = directoryIncarnation(workspace.commonDir);
  const objectsDirectory = directoryIncarnation(path.join(workspace.commonDir, "objects"));
  const objectFormat = runGit(workspace.root, ["rev-parse", "--show-object-format=storage"]) as "sha1" | "sha256";
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new MissionStoreError(`unsupported Git object format ${objectFormat}`);
  const refs = gitRefObservations(workspace);
  const config = gitConfigObservations(workspace);
  const headOid = optionalGitOutput(workspace.root, ["rev-parse", "--verify", "HEAD"]);
  const candidates = [...new Set([headOid, ...refs.flatMap(({ oid, peeledOid }) => [oid, peeledOid])].filter((oid): oid is string => !!oid))];
  const objectDatabase = isolatedObjectDatabase(workspace, candidates);
  let witness: RepositoryContinuityProof["witness"] = null;
  try {
    for (const oid of candidates) {
      const bytes = readCommitObject(workspace, objectDatabase.directory, objectFormat, oid);
      if (bytes) {
        witness = { type: "commit", oid };
        break;
      }
    }
  } finally {
    rmSync(objectDatabase.temporary, { recursive: true, force: true });
  }
  const afterCommon = directoryIncarnation(workspace.commonDir);
  const afterObjects = directoryIncarnation(path.join(workspace.commonDir, "objects"));
  if (!sameIncarnation(commonDirectory, afterCommon) || !sameIncarnation(objectsDirectory, afterObjects)) {
    throw new MissionStoreError("repository filesystem incarnation changed during identity observation");
  }
  if (!witness && (refs.length > 0 || !hasReliableBirthtime(commonDirectory, objectsDirectory))) {
    throw new MissionStoreError("repository identity is unproven: no commit witness and no reliable unborn-repository incarnation");
  }
  return {
    schemaVersion: 1,
    markerHash: sha256(Buffer.from(json(marker))),
    commonDirectory,
    objectsDirectory,
    objectFormat,
    witness,
    refs,
    config,
  };
}

function verifyRepositoryContinuityProof(proof: RepositoryContinuityProof, workspace: VerifiedWorkspace): void {
  if (!isRepositoryContinuityProof(proof)) throw new MissionStoreError("repository continuity proof has an unknown or invalid schema");
  const commonDirectory = directoryIncarnation(workspace.commonDir);
  const objectsDirectory = directoryIncarnation(path.join(workspace.commonDir, "objects"));
  if (!sameIncarnation(proof.commonDirectory, commonDirectory) || !sameIncarnation(proof.objectsDirectory, objectsDirectory)) {
    throw new MissionStoreError("repository continuity filesystem incarnation changed; identity is unproven");
  }
  const objectFormat = runGit(workspace.root, ["rev-parse", "--show-object-format=storage"]);
  if (objectFormat !== proof.objectFormat) throw new MissionStoreError("repository object format changed; identity is unproven");
  if (proof.witness) {
    const objectDatabase = isolatedObjectDatabase(workspace, [proof.witness.oid]);
    let bytes: Buffer | undefined;
    try { bytes = readCommitObject(workspace, objectDatabase.directory, proof.objectFormat, proof.witness.oid); }
    finally { rmSync(objectDatabase.temporary, { recursive: true, force: true }); }
    if (!bytes) throw new MissionStoreError("recorded Git commit witness is missing; identity is unproven");
  } else if (!hasReliableBirthtime(commonDirectory, objectsDirectory)) {
    throw new MissionStoreError("unborn repository identity is unproven: reliable filesystem incarnation is unavailable");
  }
  if (!sameIncarnation(commonDirectory, directoryIncarnation(workspace.commonDir)) ||
    !sameIncarnation(objectsDirectory, directoryIncarnation(path.join(workspace.commonDir, "objects")))) {
    throw new MissionStoreError("repository filesystem incarnation changed during identity verification");
  }
}

function isRepositoryContinuityProof(value: RepositoryContinuityProof): boolean {
  const validIncarnation = (row: DirectoryIncarnation) => !!row && typeof row.dev === "string" && /^\d+$/.test(row.dev) &&
    typeof row.ino === "string" && /^\d+$/.test(row.ino) &&
    (row.birthtimeNs === null || typeof row.birthtimeNs === "string" && /^\d+$/.test(row.birthtimeNs));
  return !!value && value.schemaVersion === 1 && /^[0-9a-f]{64}$/.test(value.markerHash) &&
    validIncarnation(value.commonDirectory) && validIncarnation(value.objectsDirectory) &&
    (value.objectFormat === "sha1" || value.objectFormat === "sha256") &&
    (value.witness === null || value.witness?.type === "commit" && validGitObjectId(value.witness.oid, value.objectFormat)) &&
    Array.isArray(value.refs) && value.refs.length <= 128 &&
    value.refs.every((ref) => typeof ref.name === "string" && ref.name.startsWith("refs/") &&
      validGitObjectId(ref.oid, value.objectFormat) && (ref.peeledOid === null || validGitObjectId(ref.peeledOid, value.objectFormat))) &&
    !!value.config && typeof value.config === "object" && !Array.isArray(value.config) &&
    Object.keys(value.config).every((key) => ["core.repositoryformatversion", "extensions.objectformat", "core.bare", "core.logallrefupdates", "core.filemode", "core.ignorecase", "core.symlinks"].includes(key)) &&
    Object.values(value.config).every((values) => Array.isArray(values) && values.length <= 8 && values.every((item) => typeof item === "string" && item.length <= 256));
}

function directoryIncarnation(directory: string): DirectoryIncarnation {
  const state = lstatSync(directory, { bigint: true });
  if (!state.isDirectory() || state.isSymbolicLink()) throw new MissionStoreError(`repository identity directory is not a real directory: ${directory}`);
  return {
    dev: String(state.dev),
    ino: String(state.ino),
    birthtimeNs: process.platform === "linux" && state.birthtimeNs > 0n ? String(state.birthtimeNs) : null,
  };
}

function sameIncarnation(first: DirectoryIncarnation, second: DirectoryIncarnation): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.birthtimeNs === second.birthtimeNs;
}

function hasReliableBirthtime(common: DirectoryIncarnation, objects: DirectoryIncarnation): boolean {
  return process.platform === "linux" && common.birthtimeNs !== null && objects.birthtimeNs !== null;
}

function gitRefObservations(workspace: VerifiedWorkspace): RepositoryContinuityProof["refs"] {
  const output = runGit(workspace.root, ["for-each-ref", "--count=128", "--format=%(refname) %(objectname) %(*objectname)"]);
  if (!output) return [];
  return output.split(/\r?\n/).slice(0, 128).map((line) => {
    const [name, oid, peeled] = line.split(" ");
    if (!name?.startsWith("refs/") || !oid || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid)) {
      throw new MissionStoreError("Git ref observation is malformed");
    }
    return { name, oid, peeledOid: peeled || null };
  });
}

function gitConfigObservations(workspace: VerifiedWorkspace): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const key of ["core.repositoryformatversion", "extensions.objectformat", "core.bare", "core.logallrefupdates", "core.filemode", "core.ignorecase", "core.symlinks"]) {
    const value = optionalGitOutput(workspace.root, ["config", "--local", "--null", "--get-all", key]);
    if (value !== undefined) {
      const values = value.split("\0").filter(Boolean);
      if (values.length > 8 || values.some((item) => item.length > 256)) throw new MissionStoreError(`Git config observation is unbounded: ${key}`);
      result[key] = values;
    }
  }
  return result;
}

function isolatedObjectDatabase(workspace: VerifiedWorkspace, objectIds: string[]): { temporary: string; directory: string } {
  const temporary = mkdtempSync(path.join(tmpdir(), "pitako-mission-git-proof-"));
  const directory = path.join(temporary, "objects");
  const packDirectory = path.join(directory, "pack");
  mkdirSync(packDirectory, { recursive: true });
  try {
    const sourceObjects = path.join(workspace.commonDir, "objects");
    const sourcePackDirectory = path.join(sourceObjects, "pack");
    if (existsSync(sourcePackDirectory)) {
      const packNames = readdirSync(sourcePackDirectory);
      const bases = [...new Set(packNames.filter((name) => /^pack-[0-9a-f]+\.idx$/.test(name)).map((name) => name.slice(0, -4)))];
      if (bases.length > 256) throw new MissionStoreError("Git pack observation exceeds the bounded pack count");
      for (const base of bases) {
        for (const extension of [".idx", ".pack"]) {
          const source = path.join(sourcePackDirectory, `${base}${extension}`);
          const state = lstatSync(source);
          if (!state.isFile() || state.isSymbolicLink()) throw new MissionStoreError("Git pack observation found a non-regular pack file");
          symlinkSync(realpathSync(source), path.join(packDirectory, `${base}${extension}`));
        }
      }
    }
    for (const oid of objectIds) {
      if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid)) continue;
      const source = path.join(sourceObjects, oid.slice(0, 2), oid.slice(2));
      try {
        const state = lstatSync(source);
        if (!state.isFile() || state.isSymbolicLink()) throw new MissionStoreError("Git loose-object observation found a non-regular object");
        const targetDirectory = path.join(directory, oid.slice(0, 2));
        mkdirSync(targetDirectory, { recursive: true });
        symlinkSync(realpathSync(source), path.join(targetDirectory, oid.slice(2)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { temporary, directory };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function readCommitObject(workspace: VerifiedWorkspace, objectDirectory: string, format: "sha1" | "sha256", oid: string): Buffer | undefined {
  if (!validGitObjectId(oid, format)) return undefined;
  const env = gitEnvironment({ GIT_DIR: workspace.gitDir, GIT_OBJECT_DIRECTORY: objectDirectory });
  let type: string;
  try {
    type = execFileSync("git", ["cat-file", "-t", oid], {
      cwd: workspace.root, encoding: "utf8", env, timeout: 5000, maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = gitErrorMessage(error);
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : -1;
    if (status === 128 && /could not get object info|Not a valid object name|bad object/i.test(stderr)) return undefined;
    throw new MissionStoreError(`could not verify fixed Git object ${oid}: ${stderr}`);
  }
  if (type !== "commit") return undefined;
  let bytes: Buffer;
  try {
    bytes = execFileSync("git", ["cat-file", "commit", oid], {
      cwd: workspace.root, env, timeout: 5000, maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new MissionStoreError(`could not read fixed Git commit ${oid}: ${gitErrorMessage(error)}`);
  }
  const actual = createHash(format).update(Buffer.from(`commit ${bytes.length}\0`)).update(bytes).digest("hex");
  if (actual !== oid) throw new MissionStoreError(`fixed Git commit ${oid} failed its ${format} content hash`);
  return bytes;
}

function validGitObjectId(value: string, format: "sha1" | "sha256"): boolean {
  return new RegExp(`^[0-9a-f]{${format === "sha1" ? 40 : 64}}$`).test(value);
}

function optionalGitOutput(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: gitEnvironment(),
      timeout: 5000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch (error) {
    const stderr = gitErrorMessage(error);
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : -1;
    if (status === 1) return undefined;
    if (status === 128 && /Needed a single revision|unknown revision/i.test(stderr)) return undefined;
    throw new MissionStoreError(`Git identity observation failed: ${stderr}`);
  }
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: gitEnvironment(),
      timeout: 5000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch (error) {
    throw new MissionStoreError(`Git ${args.join(" ")} failed: ${gitErrorMessage(error)}`);
  }
}

function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  }, extra);
  return env;
}

function gitDirectoryIdentity(directory: string): string {
  const state = statSync(directory, { bigint: true });
  if (!state.isDirectory()) throw new MissionStoreError(`Git common directory is not a directory: ${directory}`);
  return `${state.dev}:${state.ino}`;
}

function machineIdentity(): string {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(file, "utf8").trim().toLowerCase();
      if (/^[a-f0-9]{32}$/.test(value)) return value;
    } catch { /* try next OS identity source */ }
  }
  throw new MissionStoreError("stable host identity is unavailable; repository marker cannot be trusted");
}

function readRepositoryMarker(file: string): RepositoryMarker | undefined {
  let state;
  try { state = lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new MissionStoreError(`could not inspect repository marker ${file}: ${messageOf(error)}`);
  }
  if (!state.isFile() || state.isSymbolicLink()) throw new MissionStoreError(`repository marker is not a regular file: ${file}`);
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new MissionStoreError(`repository marker is malformed: ${messageOf(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MissionStoreError("repository marker must be an object");
  const row = value as Record<string, unknown>;
  const required = ["schemaVersion", "repositoryId", "hostId", "storeInstanceId", "commonDir", "gitDirectoryId", "createdAt"];
  if (Object.keys(row).sort().join(",") !== required.sort().join(",") || row.schemaVersion !== 2 ||
    !isUuid(row.repositoryId) || !isUuid(row.storeInstanceId) || typeof row.hostId !== "string" ||
    typeof row.commonDir !== "string" || !path.isAbsolute(row.commonDir) || typeof row.gitDirectoryId !== "string" ||
    !/^\d+:\d+$/.test(row.gitDirectoryId) || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))) {
    throw new MissionStoreError("repository marker has an unknown or invalid schema");
  }
  return row as unknown as RepositoryMarker;
}

function writeRepositoryMarker(file: string, marker: RepositoryMarker): void {
  const directory = path.dirname(file);
  ensureDirectory(directory);
  if (realpathSync(directory) !== directory) throw new MissionStoreError("repository marker directory is not canonical");
  const state = lstatSync(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new MissionStoreError("repository marker parent is not a real directory");
  const temporary = path.join(directory, `.repository-id-${process.pid}-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, Buffer.from(json(marker) + "\n")); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { linkSync(temporary, file); }
  catch (error) {
    rmSync(temporary, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  rmSync(temporary, { force: true });
  fsyncDirectory(directory);
}

function parseLegacyHolds(ledger: string): { known: boolean; holds: LegacyHoldPreview[]; warning?: string } {
  const start = "<!-- pitako-team-holds:v1 -->";
  const end = "<!-- /pitako-team-holds -->";
  const starts = ledger.split(start).length - 1;
  const ends = ledger.split(end).length - 1;
  const match = ledger.match(/^<!-- pitako-team-holds:v1 -->\r?\n([\s\S]*?)\r?\n<!-- \/pitako-team-holds -->$/m);
  if (starts !== 1 || ends !== 1 || !match) return { known: false, holds: [], warning: "legacy Team hold block is missing or malformed; exact bytes retained" };
  let raw: unknown;
  try { raw = JSON.parse(match[1]!); }
  catch { return { known: false, holds: [], warning: "legacy Team hold JSON is malformed; exact bytes retained" }; }
  if (!Array.isArray(raw)) return { known: false, holds: [], warning: "legacy Team hold value is not an array; exact bytes retained" };
  const holds = raw.map((entry): LegacyHoldPreview => {
    const exact = json(entry);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { raw: exact, disposition: "unknown" };
    const row = entry as Record<string, unknown>;
    const assignmentId = typeof row.assignmentId === "string" && row.assignmentId ? row.assignmentId : undefined;
    const unitId = typeof row.unitId === "string" && row.unitId ? row.unitId : undefined;
    const status = typeof row.status === "string" ? row.status : undefined;
    if (!assignmentId || !unitId || !status || !["pending", "failed", "cancelled"].includes(status) || Object.keys(row).sort().join(",") !== "assignmentId,status,unitId") {
      return { raw: exact, ...(assignmentId ? { assignmentId } : {}), ...(unitId ? { unitId } : {}), ...(status ? { status } : {}), disposition: "unknown" };
    }
    return { raw: exact, assignmentId, unitId, status, disposition: "unresolved" };
  });
  return { known: holds.every(({ disposition }) => disposition !== "unknown"), holds, ...holds.some(({ disposition }) => disposition === "unknown") ? { warning: "one or more legacy holds have unknown fields or status; none are cleared" } : {} };
}

function stableEventUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeEvent(input: Partial<MissionEvent> & Pick<MissionEvent, "eventId" | "missionId" | "seq" | "kind" | "causalId" | "occurredAt" | "runtimeId" | "payload">): MissionEvent {
  requireUuid(input.eventId, "eventId");
  requireUuid(input.missionId, "missionId");
  requireUuid(input.causalId, "causalId");
  requireUuid(input.runtimeId, "runtimeId");
  if (!Number.isSafeInteger(input.seq) || input.seq! < 1) throw new MissionStoreError("event sequence must be positive");
  const occurredAt = requireTimestamp(input.occurredAt, "event occurredAt");
  if (!Number.isSafeInteger(input.revision) || input.revision! < 1) throw new MissionStoreError("event revision must be positive");
  const duration = input.monotonicDurationMs ?? null;
  if (duration !== null && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)) throw new MissionStoreError("event duration must be nonnegative or unknown");
  return {
    eventId: input.eventId,
    schemaVersion: EVENT_SCHEMA_VERSION,
    missionId: input.missionId,
    revision: input.revision!,
    seq: input.seq!,
    kind: input.kind,
    causalId: input.causalId,
    occurredAt,
    runtimeId: input.runtimeId,
    monotonicDurationMs: duration,
    unitId: input.unitId ?? null,
    attemptId: input.attemptId ?? null,
    effectId: input.effectId ?? null,
    teamRoundId: input.teamRoundId ?? null,
    reason: input.reason ?? null,
    provenance: input.provenance ?? null,
    payload: input.payload,
  };
}

function readEvent(row: Record<string, unknown>): MissionEvent {
  const schemaVersion = number(row.schema_version, "event schema_version");
  if (schemaVersion !== EVENT_SCHEMA_VERSION) throw new MissionStoreError(`event schema ${schemaVersion} is unsupported`);
  const kind = text(row.kind, "event kind");
  if (!EVENT_KINDS.has(kind)) throw new MissionStoreError(`unknown mission event kind ${kind}`);
  return {
    eventId: text(row.event_id, "event_id"),
    schemaVersion: 1,
    missionId: text(row.mission_id, "mission_id"),
    revision: number(row.revision, "event revision"),
    seq: number(row.seq, "event seq"),
    kind,
    causalId: text(row.causal_id, "event causal_id"),
    occurredAt: requireTimestamp(row.occurred_at, "event occurred_at"),
    runtimeId: text(row.runtime_id, "event runtime_id"),
    monotonicDurationMs: row.monotonic_duration_ms === null ? null : finiteNumber(row.monotonic_duration_ms, "event duration"),
    unitId: nullableText(row.unit_id, "unit_id"),
    attemptId: nullableText(row.attempt_id, "attempt_id"),
    effectId: nullableText(row.effect_id, "effect_id"),
    teamRoundId: nullableText(row.team_round_id, "team_round_id"),
    reason: nullableText(row.reason, "event reason"),
    provenance: row.provenance_json === null ? null : parseJson(row.provenance_json, "event provenance"),
    payload: parseJson(row.payload_json, "event payload"),
  };
}

function readReservation(row: Record<string, unknown>): Reservation {
  const payload = parseJson<Reservation>(row.payload_json, "reservation payload");
  const purpose = reservationPurpose(payload.purpose);
  const amount = number(row.amount, "reservation amount");
  const grantAmount = payload.grantAmount ?? amount;
  return {
    id: text(row.reservation_id, "reservation_id"),
    missionId: text(row.mission_id, "mission_id"),
    revision: number(row.revision, "reservation revision"),
    resource: text(row.resource, "reservation resource"),
    grantAmount: number(grantAmount, "reservation grant amount"),
    amount,
    knownCharge: payload.knownCharge ?? 0,
    unknownCharge: payload.unknownCharge ?? 0,
    remainingHold: payload.remainingHold ?? amount,
    released: payload.released ?? Math.max(0, grantAmount - amount),
    overage: payload.overage ?? Math.max(0, amount - grantAmount),
    eventId: text(row.event_id, "reservation event_id"),
    purpose,
  };
}

function validateMeteredEvent(events: MissionEvent[], event: MissionEvent, definition: MissionDefinition, ownerEpoch: number | null): void {
  if (definition.schemaVersion !== 3) throw new MissionStoreError("legacy missions require capped reservations");
  if (event.kind === "resource.metered.admitted") {
    const ticket = event.payload.ticket as import("./resources.ts").MeteredTicket | undefined;
    if (!ticket || ticket.kind !== "metered" || !isUuid(ticket.ticketId) || !isUuid(ticket.operationId) ||
      ticket.revision !== event.revision || ticket.ownerEpoch !== ownerEpoch ||
      !Object.hasOwn(RESOURCE_FIELDS, ticket.resource) || resourceLimit(definition, ticket.resource) !== undefined ||
      Object.keys(ticket).sort().join() !== ["kind", "ticketId", "operationId", "resource", "revision", "ownerEpoch"].sort().join() ||
      event.payload.knownCharge !== undefined && (typeof event.payload.knownCharge !== "number" ||
        !Number.isSafeInteger(event.payload.knownCharge) || event.payload.knownCharge < 0) ||
      event.payload.outstanding !== undefined && typeof event.payload.outstanding !== "boolean" ||
      events.slice(0, -1).some(row => row.kind === "resource.metered.admitted" &&
        (row.payload.ticket as import("./resources.ts").MeteredTicket).ticketId === ticket.ticketId) ||
      events.some(row => row.kind === "budget.admission.fenced"))
      throw new MissionStoreError("invalid, capped, duplicate or fenced metered ticket");
    return;
  }
  const charge = event.payload;
  const ticket = meteredConsumptions(events.slice(0, -1)).find(row => row.ticketId === charge.ticketId);
  if (!ticket || ticket.revision !== event.revision || charge.resource !== ticket.resource ||
    !Number.isSafeInteger(charge.knownCharge) || Number(charge.knownCharge) < ticket.knownCharge ||
    typeof charge.unknown !== "boolean" || typeof charge.outstanding !== "boolean" ||
    ticket.unknown && charge.unknown !== true || !ticket.outstanding)
    throw new MissionStoreError("metered settlement needs a current ticket and monotonic known/unknown consumption");
}

function reservationPurpose(value: unknown): NonNullable<Reservation["purpose"]> {
  const purpose = value === undefined ? "ordinary" : text(value, "reservation purpose");
  if (purpose !== "ordinary" && purpose !== "protected" && purpose !== "finalization") throw new MissionStoreError(`unsupported reservation purpose ${purpose}`);
  return purpose;
}

function reservationFromEvent(missionId: string, event: MissionEventDraft): Reservation {
  if (event.kind !== "reservation.created") throw new MissionStoreError("reservation projection requires reservation.created event");
  const payload = event.payload;
  const purpose = reservationPurpose(payload.purpose);
  const id = text(payload.reservationId, "reservationId");
  requireUuid(id, "reservationId");
  const resource = text(payload.resource, "reservation resource");
  if (!Number.isSafeInteger(payload.amount) || Number(payload.amount) < 1) throw new MissionStoreError("reservation amount must be a positive integer");
  const amount = Number(payload.amount);
  return {
    id, missionId, revision: Number.isSafeInteger(payload.revision) ? Number(payload.revision) : event.revision,
    resource, grantAmount: amount, amount, knownCharge: 0, unknownCharge: 0, remainingHold: amount,
    released: 0, overage: 0, eventId: "", purpose,
  };
}

function assertAttemptSlotAvailable(events: MissionEvent[], payload: Record<string, unknown>): void {
  const attemptId = text(payload.attemptId, "attemptId");
  const slot = [text(payload.unitId, "unitId"), text(payload.targetId ?? payload.unitId, "targetId"),
    text(payload.roundId, "roundId"), text(payload.memberId, "memberId")].join("\0");
  const attempts = new Map<string, { slot: string; active: boolean }>();
  for (const event of events) {
    if (event.kind === "attempt.reserved") {
      const body = event.payload;
      attempts.set(text(body.attemptId, "attemptId"), {
        slot: [text(body.unitId, "unitId"), text(body.targetId ?? body.unitId, "targetId"),
          text(body.roundId, "roundId"), text(body.memberId, "memberId")].join("\0"), active: true,
      });
    } else if (event.kind === "attempt.settled") {
      const prior = attempts.get(text(event.payload.attemptId, "attemptId"));
      if (prior) prior.active = false;
    }
  }
  if ([...attempts.values()].some((attempt) => attempt.active && attempt.slot === slot)) throw new MissionStoreError("active attempt slot is already reserved");
  if (attempts.has(attemptId)) throw new MissionStoreError("attempt id is already reserved");
  const binding = payload.binding as Record<string, unknown>;
  if (binding.recoveryOf) {
    const source = events.find((event) => event.kind === "attempt.reserved" && event.attemptId === binding.recoveryOf);
    const predecessor = source?.payload.binding as Record<string, unknown> | undefined;
    const settlement = events.find((event) => event.kind === "attempt.settled" && event.attemptId === binding.recoveryOf);
    const interruption = settlement?.payload.interruption as Record<string, unknown> | undefined;
    const observation = events.find((event) => event.kind === "mission.recovery.continuation.recorded" &&
      event.payload.continuationId === binding.recoveryContinuationId);
    if (!predecessor || settlement?.payload.status !== "interrupted" || interruption?.kind !== "host-pause" ||
      !observation || observation.payload.sourceAttemptId !== binding.recoveryOf ||
      observation.payload.proofHash !== interruption.proofHash || observation.payload.pauseEventId !== interruption.pauseEventId ||
      observation.payload.ownerEpoch !== binding.ownerEpoch || source?.revision !== binding.revision ||
      ["unitId", "roundId", "memberId", "continuationOf", "checkpointHash", "childResultHash", "teamBundleHash", "consultationId"].some((key) =>
        predecessor[key] !== binding[key]) || (predecessor.targetId ?? predecessor.unitId) !== (binding.targetId ?? binding.unitId) ||
      missionCorrectionNo(events, predecessor as unknown as MissionAttemptBinding) !== binding.correctionNo ||
      Number(binding.attemptNo) !== [...attempts.values()].filter((attempt) => attempt.slot === slot).length + 1 ||
      events.some((event) => event.kind === "attempt.reserved" &&
        (event.payload.binding as Record<string, unknown>).recoveryOf === binding.recoveryOf))
      throw new MissionStoreError("pause recovery predecessor is spent, unproven or belongs to another logical slot");
  }
}

function assertAttemptIsActive(events: MissionEvent[], payload: Record<string, unknown>): void {
  const attemptId = text(payload.attemptId, "attemptId");
  const active = events.some((event) => event.kind === "attempt.reserved" && event.payload.attemptId === attemptId) &&
    !events.some((event) => event.kind === "attempt.settled" && event.payload.attemptId === attemptId);
  if (!active) throw new MissionStoreError(`attempt is not active: ${attemptId}`);
}

function validateBudgetReservations(missionId: string, events: MissionEvent[], definition: MissionDefinition): void {
  const reservations = events.filter(({ kind }) => kind === "reservation.created")
    .map((event) => reservationProjection(missionId, events, event.payload.reservationId)!)
    .filter(({ amount }) => amount > 0);
  const overGrant = reservations.find(({ overage }) => overage > 0);
  if (overGrant) throw new MissionStoreError(`${overGrant.resource} settlement exceeds immutable grant by ${overGrant.overage}`);
  const resources = new Set(reservations.map(({ resource }) => resource));
  for (const resource of resources) {
    const limit = resourceLimit(definition, resource as import("./resources.ts").Resource);
    if (limit === undefined) throw new MissionStoreError(`unknown mission budget resource ${resource}`);
    const rows = reservations.filter((reservation) => reservation.resource === resource);
    const ordinary = rows.filter(({ purpose }) => purpose === "ordinary").reduce((sum, { amount }) => sum + amount, 0);
    const protectedCapacity = rows.filter(({ purpose }) => purpose === "protected").reduce((sum, { amount }) => sum + amount, 0);
    const finalization = rows.filter(({ purpose }) => purpose === "finalization").reduce((sum, { amount }) => sum + amount, 0);
    if (finalization > protectedCapacity) throw new MissionStoreError(`${resource} finalization exceeded protected capacity`);
    if (ordinary + protectedCapacity > limit) throw new MissionStoreError(`${resource} reservation exceeds root budget (${ordinary + protectedCapacity} > ${limit})`);
  }
}

function reservationProjection(missionId: string, events: MissionEvent[], idValue: unknown): Reservation | undefined {
  const id = text(idValue, "reservationId");
  const created = events.find((event) => event.kind === "reservation.created" && event.payload.reservationId === id);
  if (!created) return undefined;
  const grant = reservationFromEvent(missionId, created as unknown as MissionEventDraft);
  const latest = events.filter((event) =>
    (event.kind === "budget.reservation.settled" || event.kind === "budget.reservation.adjusted") &&
    event.payload.reservationId === id).at(-1);
  if (!latest) return { ...grant, eventId: created.eventId };
  if (latest.kind === "budget.reservation.adjusted") {
    const amount = number(latest.payload.amount, "adjusted reservation amount");
    return {
      ...grant, amount, knownCharge: 0, unknownCharge: 0, remainingHold: amount,
      released: Math.max(0, grant.grantAmount - amount), overage: Math.max(0, amount - grant.grantAmount),
      eventId: created.eventId,
    };
  }
  const knownCharge = number(latest.payload.knownCharge, "known resource charge");
  const unknownCharge = number(latest.payload.unknownCharge, "unknown resource charge");
  const released = number(latest.payload.released, "released resource capacity");
  const remainingHold = Math.max(0, grant.grantAmount - knownCharge - unknownCharge - released);
  return {
    ...grant, amount: knownCharge + unknownCharge + remainingHold, knownCharge, unknownCharge,
    remainingHold, released, overage: Math.max(0, knownCharge + unknownCharge - grant.grantAmount),
    eventId: created.eventId,
  };
}

function validateReservationSettlement(missionId: string, events: MissionEvent[], payload: Record<string, unknown>): void {
  const id = requireUuid(payload.reservationId, "reservationId");
  const grant = reservationProjection(missionId, events.slice(0, -1), id);
  if (!grant) throw new MissionStoreError(`settled reservation does not exist: ${id}`);
  if (payload.resource !== grant.resource) throw new MissionStoreError(`settled reservation resource changed: ${id}`);
  const knownCharge = number(payload.knownCharge, "known resource charge");
  const unknownCharge = number(payload.unknownCharge, "unknown resource charge");
  const released = number(payload.released, "released resource capacity");
  if (knownCharge < 0 || unknownCharge < 0 || released < 0) throw new MissionStoreError("reservation settlement fields must be nonnegative");
  if (knownCharge < grant.knownCharge || unknownCharge < grant.unknownCharge || released < grant.released) {
    throw new MissionStoreError(`reservation settlement cannot revise prior charges: ${id}`);
  }
  if (released > Math.max(0, grant.grantAmount - knownCharge - unknownCharge)) {
    throw new MissionStoreError(`reservation settlement releases charged or ungranted capacity: ${id}`);
  }
}

function validateReservationAdjustment(missionId: string, events: MissionEvent[], payload: Record<string, unknown>): void {
  const id = requireUuid(payload.reservationId, "reservationId");
  const grant = reservationProjection(missionId, events, id);
  if (!grant) throw new MissionStoreError(`adjusted reservation does not exist: ${id}`);
  if (payload.resource !== grant.resource) throw new MissionStoreError(`adjusted reservation resource changed: ${id}`);
  const amount = number(payload.amount, "adjusted reservation amount");
  if (amount < 0) throw new MissionStoreError("adjusted reservation amount must be nonnegative");
  if (events.some((event) => event.kind === "budget.reservation.settled" && event.payload.reservationId === id)) {
    throw new MissionStoreError(`settled reservation cannot be adjusted: ${id}`);
  }
}

function budgetOverrunReason(missionId: string, events: MissionEvent[], definition: MissionDefinition): string | undefined {
  const reservations = events.filter(({ kind }) => kind === "reservation.created")
    .map((event) => reservationProjection(missionId, events, event.payload.reservationId)!)
    .filter(({ amount }) => amount > 0);
  const overGrant = reservations.find(({ overage }) => overage > 0);
  if (overGrant) return `${overGrant.resource} actual charge exceeded immutable grant by ${overGrant.overage}`;
  for (const resource of new Set(reservations.map(({ resource }) => resource))) {
    const rows = reservations.filter((reservation) => reservation.resource === resource);
    const ordinary = rows.filter(({ purpose }) => purpose === "ordinary").reduce((sum, { amount }) => sum + amount, 0);
    const protectedCapacity = rows.filter(({ purpose }) => purpose === "protected").reduce((sum, { amount }) => sum + amount, 0);
    const finalization = rows.filter(({ purpose }) => purpose === "finalization").reduce((sum, { amount }) => sum + amount, 0);
    const limit = resourceLimit(definition, resource as import("./resources.ts").Resource);
    if (limit === undefined) return `numeric reservation without explicit ${resource} cap`;
    if (ordinary + protectedCapacity > limit) return `${resource} occupancy exceeds root budget (${ordinary + protectedCapacity} > ${limit})`;
    if (finalization > protectedCapacity) return `${resource} finalization occupancy exceeds protected capacity (${finalization} > ${protectedCapacity})`;
  }
  return undefined;
}

function requireUuid(value: unknown, label: string): string {
  if (!isUuid(value)) throw new MissionStoreError(`${label} must be a UUID`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new MissionStoreError(`${label} must be non-empty`);
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    throw new MissionStoreError(`${label} must be an ISO UTC timestamp`);
  }
  return value;
}

function pragmaInteger(db: SqlDatabase, name: "user_version"): number {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return number(row?.[name], name);
}

function finiteNumber(value: unknown, label: string): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isFinite(result)) throw new MissionStoreError(`${label} must be finite`);
  return result;
}

function number(value: unknown, label: string): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result)) throw new MissionStoreError(`${label} must be a safe integer`);
  return result;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new MissionStoreError(`${label} must be a string`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function parseJson<T = Record<string, unknown>>(value: unknown, label: string): T {
  try { return JSON.parse(text(value, label)) as T; }
  catch (error) { throw new MissionStoreError(`${label} JSON is corrupt: ${messageOf(error)}`); }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new MissionStoreError(`${label} is not valid UTF-8: ${messageOf(error)}`); }
}

function normalizeEvidencePath(input: string): string {
  if (!input || path.isAbsolute(input) || input.includes("\\") || input.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new MissionStoreError(`legacy evidence path is unsafe: ${input}`);
  }
  return input;
}

function sqliteQuote(value: string): string {
  return value.replaceAll("'", "''");
}

function ensureDirectory(directory: string): void {
  const target = path.resolve(directory);
  const missing: string[] = [];
  let current = target;
  while (!existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw new MissionStoreError(`directory does not exist: ${target}`);
    current = parent;
  }
  for (const created of missing.reverse()) {
    try { mkdirSync(created); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    fsyncDirectory(path.dirname(created));
    fsyncDirectory(created);
  }
  const resolved = realpathSync(target);
  if (resolved !== target || !statSync(resolved).isDirectory()) throw new MissionStoreError(`directory is not canonical: ${directory}`);
}

function fsyncFile(file: string): void {
  const fd = openSync(file, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeAtomic(target: string, bytes: Uint8Array): void {
  ensureDirectory(path.dirname(target));
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, target);
  fsyncDirectory(path.dirname(target));
}

function hashFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function gitErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = error.stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf8").trim();
  }
  return messageOf(error);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
