import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSqlite } from "../extensions/board/sqlite.ts";
import { ledgerTeamHolds, parseLedgerBinding, parseLedgerStatus } from "../extensions/workflow.ts";
import { openMissionStore, renderGeneratedLedger } from "../extensions/mission/store.ts";
import { currentProcessIdentity } from "../extensions/mission/workspace.ts";
import type { EvaluationObservation, MissionMeasurement } from "../extensions/mission/model.ts";
import {
  createMissionFixture,
  missionInput,
  openFixtureStore,
  type MissionFixture,
} from "./mission-fixtures.ts";

const fixtures: MissionFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture.base, { recursive: true, force: true });
});

function fixture(): MissionFixture {
  const value = createMissionFixture();
  fixtures.push(value);
  return value;
}

function acknowledgeOwnerRetirement(store: Awaited<ReturnType<typeof openFixtureStore>>, missionId: string): void {
  const inspection = store.inspectMission(missionId);
  const epoch = store.ownerEpoch;
  if (epoch === null) throw new Error("fixture store has no writer claim");
  store.appendTransition(missionId, inspection.version, { events: [{
    revision: inspection.revision,
    kind: "mission.owner.released",
    causalId: randomUUID(),
    payload: {
      owner: currentProcessIdentity(store.runtimeId, epoch),
      reason: "orderly fixture retirement",
      effectsQuiescent: true,
      resumablePause: false,
      interruptedAttempts: [],
    },
  }] });
}

function measurement(missionId: string, runtimeId = randomUUID()): MissionMeasurement {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    missionId,
    revision: 1,
    causalId: randomUUID(),
    metric: "input-tokens",
    value: null,
    unit: "tokens",
    source: "provider receipt",
    occurredAt: "2026-09-27T01:00:00.000Z",
    runtimeId,
    durationMs: null,
    unknownReason: "provider usage was unavailable after process exit",
    unitId: "snapshot",
    inputTokens: null,
    outputTokens: 8,
    usageUnknownReason: "provider supplied partial usage",
  };
}

function evaluation(missionId: string, id = randomUUID(), supersedesId: string | null = null): EvaluationObservation {
  return {
    schemaVersion: 1,
    id,
    missionId,
    revision: 1,
    resultManifestHash: "c".repeat(64),
    criterionVersion: "artifact-outcome-v1",
    evaluatorIdentity: "independent-fixture-reader",
    method: "read exported snapshot and manifest",
    observedAt: "2026-09-27T01:01:00.000Z",
    windowStart: null,
    windowEnd: null,
    evidenceRefs: ["export.json"],
    verdict: "unassessed",
    classification: "outcome",
    supersedesId,
  };
}

describe("durable mission store", () => {
  test("pre-claim observation of a canonical foreign marker never mints a local store id", async () => {
    const sample = fixture();
    const owner = await openFixtureStore(sample);
    const mission = owner.createMission(missionInput(sample));
    const markerFile = path.join(sample.root, ".git", "pitako", "repository-id");
    const marker = readFileSync(markerFile);
    const foreign = { dbPath: path.join(sample.base, "foreign.db"), objectDir: path.join(sample.base, "foreign-objects") };
    try {
      await expect(openMissionStore({ ...foreign, admitWriter: (observation) => {
        if (!observation) return;
        expect(observation.ownerEpoch).toBeNull();
        expect(observation.ownershipIdentity).toEqual({ epoch: 0, claimId: "" });
        observation.findManagedMission(sample.root);
      } })).rejects.toThrow("repository marker does not prove this repository association");
      const db = await openSqlite(foreign.dbPath, { readOnly: true });
      try {
        expect(db.prepare("SELECT value FROM store_meta WHERE key = 'store_instance_id'").get()).toBeUndefined();
        expect(db.prepare("SELECT value FROM store_meta WHERE key = 'owner_epoch'").get()?.value).toBe("0");
        expect(db.prepare("SELECT value FROM store_meta WHERE key = 'owner_claim_id'").get()?.value).toBe("");
        expect(db.prepare("SELECT value FROM store_meta WHERE key = 'owner_acquisition_proof'").get()?.value).toBe("");
        expect(db.prepare("SELECT * FROM mission_events").all()).toEqual([]);
        expect(db.prepare("SELECT * FROM missions").all()).toEqual([]);
      } finally { db.close(); }
      const claimed = await openMissionStore(foreign);
      try {
        expect(claimed.ownerEpoch).toBe(1);
        expect(() => claimed.createMission(missionInput(sample))).toThrow("repository marker belongs to a different mission store");
        expect(readFileSync(markerFile)).toEqual(marker);
        expect(owner.verifyRepositoryAssociation(sample.root)).toBe(mission.repositoryId);
      } finally { claimed.close(); }
    } finally { acknowledgeOwnerRetirement(owner, mission.id); owner.close(); }
  });

  test("pre-claim observation preserves fresh acquisition and previously owned read-only association", async () => {
    const sample = fixture();
    let observed = false;
    const store = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, admitWriter: (observation) => {
      if (!observation) return;
      observed = true;
      expect(observation.ownerEpoch).toBeNull();
      expect(observation.findManagedMission(sample.root)).toBeUndefined();
      expect(() => observation.ensureRepositoryIdentity(sample.root)).toThrow(/read-only.*writer reservation/);
    } });
    const mission = store.createMission(missionInput(sample));
    expect(observed).toBe(true);
    expect(store.ownerEpoch).toBe(1);
    acknowledgeOwnerRetirement(store, mission.id);
    store.close();
    const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try {
      expect(reader.ownerEpoch).toBeNull();
      expect(reader.findManagedMission(sample.root)?.id).toBe(mission.id);
      expect(reader.verifyRepositoryAssociation(sample.root)).toBe(mission.repositoryId);
      expect(() => reader.ensureRepositoryIdentity(sample.root)).toThrow(/read-only.*writer reservation/);
    } finally { reader.close(); }
    const reopened = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, admitWriter: (observation) => {
      if (observation) expect(observation.findManagedMission(sample.root)?.id).toBe(mission.id);
    } });
    try {
      expect(reopened.ownerEpoch).toBe(2);
      expect(reopened.ensureRepositoryIdentity(sample.root)).toBe(mission.repositoryId);
    } finally { acknowledgeOwnerRetirement(reopened, mission.id); reopened.close(); }
  });

  test("pins exact plan and executable bytes, ignores later source edits, and replays command ids", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const first = store.createMission(missionInput(sample));
    const identityFile = path.join(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: sample.root, encoding: "utf8" }).trim(), "pitako", "repository-id");
    expect(existsSync(identityFile)).toBe(true);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.repositoryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.snapshot.planHash).toBe(createHash("sha256").update(sample.planBytes).digest("hex"));
    expect(first.snapshot.definitionHash).toBe(createHash("sha256").update(sample.definitionBytes).digest("hex"));

    const replayBeforeExit = store.replayMission(first.id).projectionHash;
    writeFileSync(sample.planFile, Buffer.from("changed live plan\n"));
    writeFileSync(sample.definitionFile, Buffer.from("changed live executable definition\n"));
    expect(store.createMission(missionInput(sample, { missionId: randomUUID() }))).toEqual(first);
    rmSync(sample.planFile);
    expect(store.createMission(missionInput(sample, { missionId: randomUUID() }))).toEqual(first);
    const reopened = await openFixtureStore(sample);
    store.close();
    const inspection = reopened.inspectMission(first.id);
    expect(inspection.planBytes).toEqual(sample.planBytes);
    expect(inspection.definitionBytes).toEqual(sample.definitionBytes);
    expect(inspection.snapshot.planHash).toBe(first.snapshot.planHash);
    expect(reopened.replayMission(first.id).projectionHash).toBe(replayBeforeExit);
    reopened.close();
  });

  test("commits reservations, measurements, and observations atomically and idempotently", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const reservation = { id: randomUUID(), revision: 1, resource: "provider-requests", amount: 3 };
    const firstReservation = store.reserve(mission.id, reservation, 1);
    expect(store.reserve(mission.id, reservation, 1)).toEqual(firstReservation);
    expect(() => store.reserve(mission.id, { ...reservation, amount: 4 }, 1)).toThrow(/replayed with different contents/);
    expect(() => store.reserve(mission.id, { ...reservation, id: randomUUID() }, 1)).toThrow(/version conflict/);

    const fact = measurement(mission.id, store.runtimeId);
    store.recordMeasurement(fact, 2);
    expect(store.recordMeasurement(fact, 2)).toEqual(fact);
    expect(() => store.recordMeasurement({ ...fact, value: 0, unknownReason: undefined }, 2)).toThrow(/replayed with different contents/);
    const firstEvaluation = evaluation(mission.id);
    store.recordEvaluationObservation(firstEvaluation, 3);
    expect(store.recordEvaluationObservation(firstEvaluation, 3)).toEqual(firstEvaluation);
    const correction = evaluation(mission.id, randomUUID(), firstEvaluation.id);
    store.recordEvaluationObservation(correction, 4);

    const inspection = store.inspectMission(mission.id);
    expect(inspection.version).toBe(5);
    expect(inspection.latestSeq).toBe(5);
    expect(inspection.reservations).toEqual([firstReservation]);
    expect(inspection.measurements).toEqual([fact]);
    expect(inspection.evaluations).toEqual([firstEvaluation, correction]);
    expect(inspection.events.filter(({ kind }) => ["mission.created", "reservation.created", "evaluation.observed"].includes(kind)).every(({ runtimeId }) => runtimeId === store.runtimeId)).toBe(true);
    expect(inspection.events.find(({ kind }) => kind === "measurement.recorded")?.runtimeId).toBe(store.runtimeId);
    expect(inspection.measurements[0]!.value).toBeNull();
    expect(inspection.measurements[0]!.usageUnknownReason).toBe("provider supplied partial usage");

    const replay = store.replayMission(mission.id);
    const exportDir = path.join(sample.base, "export");
    const exported = await store.exportMission(mission.id, exportDir);
    const manifest = JSON.parse(readFileSync(exported.manifestPath, "utf8"));
    expect(manifest.eventSeq).toBe(inspection.latestSeq);
    expect(manifest.projectionHash).toBe(replay.projectionHash);
    expect(manifest.artifacts.map(({ hash }: { hash: string }) => hash).sort()).toEqual([inspection.snapshot.planHash, inspection.snapshot.definitionHash].sort());
    const ledger = readFileSync(path.join(exportDir, "ledger.md"), "utf8");
    expect(ledger).toBe(renderGeneratedLedger(inspection));
    expect(() => parseLedgerBinding(ledger)).toThrow(/generated mission ledger/);
    expect(() => parseLedgerStatus(ledger)).toThrow(/generated mission ledger/);
    expect(() => ledgerTeamHolds(ledger)).toThrow(/generated mission ledger/);
    store.close();
  });

  test("released reservation ids remain durable and cannot be reused", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const reservationId = randomUUID();
    store.appendTransition(mission.id, 1, { events: [{
      revision: 1,
      kind: "reservation.created",
      causalId: randomUUID(),
      payload: { reservationId, revision: 1, resource: "provider-requests", amount: 1, purpose: "ordinary" },
    }] });
    store.appendTransition(mission.id, 2, { events: [{
      revision: 1,
      kind: "budget.reservation.adjusted",
      causalId: randomUUID(),
      payload: { reservationId, resource: "provider-requests", amount: 0 },
    }] });

    expect(store.inspectMission(mission.id).reservations).toEqual([]);
    expect(store.replayMission(mission.id).reservations).toEqual([]);
    expect(() => store.appendTransition(mission.id, 3, { events: [{
      revision: 1,
      kind: "reservation.created",
      causalId: randomUUID(),
      payload: { reservationId, revision: 1, resource: "provider-requests", amount: 1, purpose: "ordinary" },
    }] })).toThrow(/reservation id is already committed/);
    expect(() => store.reserve(mission.id, { id: reservationId, revision: 1, resource: "provider-requests", amount: 1 }, 3))
      .toThrow(/reservation id was already committed and released/);
    store.close();
  });

  test("deduplicates a measurement when its causal fact is replayed with a new id", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const fact = measurement(mission.id, store.runtimeId);
    const first = store.recordMeasurement(fact, 1);
    const replay = store.recordMeasurement({ ...fact, id: randomUUID() }, 2);

    expect(replay).toEqual(first);
    expect(store.inspectMission(mission.id).measurements).toEqual([first]);
    expect(store.inspectMission(mission.id).version).toBe(2);
    expect(() => store.recordMeasurement({ ...fact, id: randomUUID(), metric: "different" }, 2)).toThrow(/causalId.*different contents/);
    store.close();
  });

  test("a second live opener stays read-only until the holder releases and it reopens", async () => {
    const sample = fixture();
    const first = await openFixtureStore(sample);
    const mission = first.createMission(missionInput(sample));
    const second = await openFixtureStore(sample);
    const reservation = { id: randomUUID(), revision: 1, resource: "provider-requests", amount: 1 };

    expect(second.inspectMission(mission.id).id).toBe(mission.id);
    const exportDir = path.join(sample.base, "read-only-export");
    const exported = await second.exportMission(mission.id, exportDir);
    expect(JSON.parse(readFileSync(exported.manifestPath, "utf8")).missionId).toBe(mission.id);
    expect(() => second.reserve(mission.id, reservation, 1)).toThrow(/read-only.*writer reservation/);
    expect(first.reserve(mission.id, reservation, 1).id).toBe(reservation.id);
    acknowledgeOwnerRetirement(first, mission.id);
    first.close();
    expect(() => second.reserve(mission.id, { ...reservation, id: randomUUID() }, 2)).toThrow(/read-only.*writer reservation/);
    second.close();

    const reopened = await openFixtureStore(sample);
    expect(reopened.reserve(mission.id, { ...reservation, id: randomUUID() }, reopened.inspectMission(mission.id).version).amount).toBe(1);
    reopened.close();
  });

  test("close without retirement cannot grant a same-process owner a new epoch", async () => {
    const sample = fixture();
    const first = await openFixtureStore(sample);
    const mission = first.createMission(missionInput(sample));
    const epoch = first.ownerEpoch;
    first.close();

    const sameProcess = await openFixtureStore(sample);
    expect(sameProcess.ownerEpoch).toBeNull();
    sameProcess.close();
    const ownerless = await openSqlite(sample.dbPath);
    ownerless.prepare("UPDATE store_meta SET value = '' WHERE key = 'owner_claim_id'").run();
    ownerless.close();

    const reopened = await openFixtureStore(sample);
    expect(reopened.ownerEpoch).toBeNull();
    expect(reopened.inspectMission(mission.id).id).toBe(mission.id);
    expect(() => reopened.reserve(mission.id, { id: randomUUID(), revision: 1, resource: "provider-requests", amount: 1 }, 1))
      .toThrow(/read-only.*writer reservation/);
    const db = await openSqlite(sample.dbPath, { readOnly: true });
    expect(db.prepare("SELECT value FROM store_meta WHERE key = 'owner_epoch'").get()?.value).toBe(String(epoch));
    db.close();
    reopened.close();
  });

  test("a persisted retirement acknowledgement permits the next owner epoch", async () => {
    const sample = fixture();
    const first = await openFixtureStore(sample);
    const mission = first.createMission(missionInput(sample));
    const epoch = first.ownerEpoch;
    acknowledgeOwnerRetirement(first, mission.id);
    first.close();

    const reopened = await openFixtureStore(sample);
    expect(reopened.ownerEpoch).toBe(epoch! + 1);
    expect(reopened.inspectMission(mission.id).events.some(({ kind, payload }) =>
      kind === "mission.owner.released" && payload.effectsQuiescent === true)).toBe(true);
    const db = await openSqlite(sample.dbPath, { readOnly: true });
    const proof = JSON.parse(String(db.prepare("SELECT value FROM store_meta WHERE key = 'owner_acquisition_proof'").get()?.value));
    db.close();
    expect(proof.source).toBe("retirement");
    expect(proof.retirementEventId).toBeTruthy();
    reopened.close();
  });

  test("a hard-dead Node writer can be replaced after process identity proof", async () => {
    const sample = fixture();
    const missionId = randomUUID();
    const script = fileURLToPath(new URL("../scripts/mission-durability-node.mjs", import.meta.url));
    const crashed = spawnSync("node", [script, "--orphan-owner", sample.root, sample.stateDir, sample.planFile,
      sample.definitionFile, sample.commandId, sample.receiptId, missionId], { encoding: "utf8" });
    expect(crashed.status).toBe(86);
    const crashedOwner = JSON.parse(crashed.stdout.trim());

    const reopened = await openFixtureStore(sample);
    const inspection = reopened.inspectMission(missionId);
    expect(inspection.id).toBe(missionId);
    expect(reopened.ownerEpoch).toBe(2);
    expect(reopened.reserve(missionId, { id: randomUUID(), revision: 1, resource: "provider-requests", amount: 1 }, 1).amount).toBe(1);
    const db = await openSqlite(sample.dbPath, { readOnly: true });
    const proof = JSON.parse(String(db.prepare("SELECT value FROM store_meta WHERE key = 'owner_acquisition_proof'").get()?.value));
    db.close();
    expect(proof.source).toBe("owner-death");
    expect(proof.previous.owner.pid).toBe(crashedOwner.pid);
    reopened.close();
  });

  test("legacy import preview repeats exactly, retains source bytes, and keeps unknown holds unresolved", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const planBytes = Buffer.from("---\r\nid: durable-fixture\r\nstatus: frozen\r\n---\r\n# Preserve  \r\n", "utf8");
    const ledgerBytes = Buffer.from([
      "---",
      "plan_id: durable-fixture",
      "revision: 1",
      `hash: ${"d".repeat(64)}`,
      "status: running",
      "---",
      "",
      "<!-- pitako-team-holds:v1 -->",
      '[{"assignmentId":"known","unitId":"T1","status":"pending"},{"assignmentId":"mystery","unitId":"T2","status":"future"}]',
      "<!-- /pitako-team-holds -->",
      "",
    ].join("\r\n"), "utf8");
    const evidenceBytes = Buffer.from([0x00, 0xff, 0x0a, 0x20]);
    const beforePlan = readFileSync(sample.planFile);
    const beforeDefinition = readFileSync(sample.definitionFile);
    const input = { planId: "durable-fixture", planBytes, ledgerBytes, evidence: [{ path: "T1/raw.bin", bytes: evidenceBytes }] };
    const preview = store.previewLegacyImport(input);
    expect(store.previewLegacyImport(input)).toEqual(preview);
    expect(Buffer.from(preview.rawPlanBase64, "base64")).toEqual(planBytes);
    expect(Buffer.from(preview.rawLedgerBase64, "base64")).toEqual(ledgerBytes);
    expect(Buffer.from(preview.evidence[0]!.bytesBase64, "base64")).toEqual(evidenceBytes);
    expect(preview.holdsKnown).toBe(false);
    expect(preview.holds.map(({ disposition }) => disposition)).toEqual(["unresolved", "unknown"]);
    expect(preview.holds[1]!.status).toBe("future");
    expect(readFileSync(sample.planFile)).toEqual(beforePlan);
    expect(readFileSync(sample.definitionFile)).toEqual(beforeDefinition);
    const invalidUtf8Ledger = Buffer.from([0xff, 0x00, 0x0a]);
    const invalidPreview = store.previewLegacyImport({ planId: "durable-fixture", planBytes, ledgerBytes: invalidUtf8Ledger });
    expect(invalidPreview.holdsKnown).toBe(false);
    expect(Buffer.from(invalidPreview.rawLedgerBase64, "base64")).toEqual(invalidUtf8Ledger);
    for (const format of [
      'format: " mission-ledger-v1 "\u200b',
      'format: "mission-ledger-v\\u0031"',
      'format: "mission-\\x6cedger-v1"',
      "format: &id mission-ledger-v1",
    ]) {
      const forgedLedger = Buffer.from([
        "---", format, "plan_id: durable-fixture", "revision: 1", `hash: ${"d".repeat(64)}`,
        "status: completed", "---", "", "<!-- pitako-team-holds:v1 -->", "[]", "<!-- /pitako-team-holds -->", "",
      ].join("\n"));
      const forgedPreview = store.previewLegacyImport({ planId: "durable-fixture", planBytes, ledgerBytes: forgedLedger });
      expect(forgedPreview.generatedLedger).toBe(true);
      expect(forgedPreview.holdsKnown).toBe(false);
    }
    store.close();
  });

  test("does not migrate existing schemas and rejects unknown, incomplete, and corrupt databases", async () => {
    const sample = fixture();
    const initialized = await openFixtureStore(sample);
    initialized.close();

    const migrationPath = path.join(sample.base, "migration.db");
    const migrationObjects = path.join(sample.base, "migration-objects");
    const migrationStore = await openFixtureStore({ ...sample, dbPath: migrationPath, objectDir: migrationObjects });
    migrationStore.close();
    const legacy = await openSqlite(migrationPath);
    legacy.exec("DROP INDEX active_mission_per_repository_plan");
    legacy.exec("DROP INDEX measurement_causal_fact");
    legacy.exec("DROP TABLE schema_meta");
    legacy.exec("CREATE TABLE schema_meta (version INTEGER NOT NULL CHECK (version = 1))");
    legacy.prepare("INSERT INTO schema_meta (version) VALUES (1)").run();
    legacy.prepare("DELETE FROM store_meta WHERE key = 'owner_epoch'").run();
    legacy.exec("PRAGMA user_version = 1");
    legacy.close();
    const inspectLegacy = await openFixtureStore({ ...sample, dbPath: migrationPath, objectDir: migrationObjects });
    expect(() => inspectLegacy.ensureRepositoryIdentity(sample.root)).toThrow(/read-only/);
    inspectLegacy.close();
    expect(existsSync(path.join(sample.root, ".git", "pitako", "repository-id"))).toBe(false);
    const legacyDb = await openSqlite(migrationPath);
    expect(legacyDb.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(legacyDb.prepare("PRAGMA index_list(missions)").all().some(({ name }) => name === "active_mission_per_repository_plan")).toBe(false);
    expect(legacyDb.prepare("PRAGMA index_list(mission_events)").all().some(({ name }) => name === "measurement_causal_fact")).toBe(false);
    expect(legacyDb.prepare("SELECT value FROM store_meta WHERE key = 'owner_epoch'").get()?.value).toBeUndefined();
    legacyDb.close();

    const db = await openSqlite(sample.dbPath);
    db.exec("PRAGMA user_version = 77");
    db.close();
    await expect(openFixtureStore(sample)).rejects.toThrow(/schema version 77 is unsupported/);
    const check = await openSqlite(sample.dbPath);
    expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(77);
    check.close();

    const incomplete = path.join(sample.base, "incomplete.db");
    const partial = await openSqlite(incomplete);
    partial.exec("PRAGMA user_version = 1");
    partial.exec("CREATE TABLE schema_meta (version INTEGER)");
    partial.prepare("INSERT INTO schema_meta (version) VALUES (1)").run();
    partial.close();
    await expect(openFixtureStore({ ...sample, dbPath: incomplete, objectDir: path.join(sample.base, "incomplete-objects") })).rejects.toThrow(/schema is incomplete/);

    const broken = path.join(sample.base, "broken.db");
    writeFileSync(broken, Buffer.from("not a SQLite database"));
    const before = readFileSync(broken);
    await expect(openFixtureStore({ ...sample, dbPath: broken, objectDir: path.join(sample.base, "broken-objects") })).rejects.toThrow();
    expect(readFileSync(broken)).toEqual(before);
  });

  test("rejects same-path repository replacement and a copied cross-host marker", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const repositoryId = store.ensureRepositoryIdentity(sample.root);
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: sample.root, encoding: "utf8" }).trim();
    const markerFile = path.join(commonDir, "pitako", "repository-id");
    const marker = JSON.parse(readFileSync(markerFile, "utf8"));

    const other = path.join(sample.base, "other");
    mkdirSync(other);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: other });
    const otherCommon = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: other, encoding: "utf8" }).trim();
    mkdirSync(path.join(otherCommon, "pitako"), { recursive: true });
    writeFileSync(path.join(otherCommon, "pitako", "repository-id"), JSON.stringify({ ...marker, hostId: "f".repeat(32), commonDir: otherCommon }));
    expect(() => store.ensureRepositoryIdentity(other)).toThrow(/different host/);

    rmSync(path.join(sample.root, ".git"), { recursive: true, force: true });
    execFileSync("git", ["init", "-q", "-b", "replacement"], { cwd: sample.root });
    expect(() => store.ensureRepositoryIdentity(sample.root)).toThrow(/marker is missing for a registered/);
    expect(repositoryId).toBe(marker.repositoryId);
    store.close();
  });

  test("rejects an in-place Git replacement after the old marker is restored", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const repositoryId = store.ensureRepositoryIdentity(sample.root);
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: sample.root, encoding: "utf8" }).trim();
    const markerFile = path.join(commonDir, "pitako", "repository-id");
    const marker = readFileSync(markerFile);
    const originalInode = statSync(commonDir, { bigint: true }).ino;

    for (const entry of readdirSync(commonDir)) rmSync(path.join(commonDir, entry), { recursive: true, force: true });
    execFileSync("git", ["init", "-q", "-b", "replacement"], { cwd: sample.root });
    expect(statSync(commonDir, { bigint: true }).ino).toBe(originalInode);
    mkdirSync(path.dirname(markerFile), { recursive: true });
    writeFileSync(markerFile, marker);

    expect(() => store.ensureRepositoryIdentity(sample.root)).toThrow(/continuity|unproven/i);
    expect(repositoryId).toBe(JSON.parse(marker.toString("utf8")).repositoryId);
    store.close();
  });

  test("keeps repository identity across ref and packing drift", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const repositoryId = store.ensureRepositoryIdentity(sample.root);

    execFileSync("git", ["switch", "-c", "identity-drift"], { cwd: sample.root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "drift", "-q"], { cwd: sample.root });
    execFileSync("git", ["gc", "--prune=now"], { cwd: sample.root });

    expect(store.ensureRepositoryIdentity(sample.root)).toBe(repositoryId);
    store.close();
  });

  test("does not use an alternate object database as continuity proof", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    store.ensureRepositoryIdentity(sample.root);
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: sample.root, encoding: "utf8" }).trim();
    const witness = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sample.root, encoding: "utf8" }).trim();
    const alternate = path.join(sample.base, "alternate.git");
    execFileSync("git", ["clone", "-q", "--bare", sample.root, alternate]);
    const objects = path.join(commonDir, "objects");
    for (const entry of readdirSync(objects)) if (entry !== "info") rmSync(path.join(objects, entry), { recursive: true, force: true });
    const alternateObjects = path.join(alternate, "objects");
    mkdirSync(path.join(objects, "info"), { recursive: true });
    writeFileSync(path.join(objects, "info", "alternates"), `${alternateObjects}\n`);

    expect(execFileSync("git", ["cat-file", "-t", witness], { cwd: sample.root, encoding: "utf8" }).trim()).toBe("commit");
    expect(() => store.ensureRepositoryIdentity(sample.root)).toThrow(/witness is missing|unproven/i);
    store.close();
  });

  test("rejects a rewritten same-host marker alias without stored owner proof", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    store.ensureRepositoryIdentity(sample.root);
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: sample.root, encoding: "utf8" }).trim();
    const marker = JSON.parse(readFileSync(path.join(commonDir, "pitako", "repository-id"), "utf8"));

    const alias = path.join(sample.base, "alias");
    mkdirSync(alias);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: alias });
    const aliasCommon = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: alias, encoding: "utf8" }).trim();
    const aliasState = statSync(aliasCommon, { bigint: true });
    mkdirSync(path.join(aliasCommon, "pitako"), { recursive: true });
    writeFileSync(path.join(aliasCommon, "pitako", "repository-id"), JSON.stringify({
      ...marker,
      commonDir: aliasCommon,
      gitDirectoryId: `${aliasState.dev}:${aliasState.ino}`,
    }));

    expect(() => store.ensureRepositoryIdentity(alias)).toThrow(/owner proof/);
    store.close();
  });

  test("rejects a pre-existing empty mission database instead of initializing it", async () => {
    const sample = fixture();
    mkdirSync(path.dirname(sample.dbPath), { recursive: true });
    writeFileSync(sample.dbPath, Buffer.alloc(0));

    await expect(openFixtureStore(sample)).rejects.toThrow(/zero-byte|empty mission database|SQLite header/);
    expect(readFileSync(sample.dbPath)).toHaveLength(0);
  });

  test("rejects a pre-existing one-byte mission database instead of initializing it", async () => {
    const sample = fixture();
    mkdirSync(path.dirname(sample.dbPath), { recursive: true });
    const corruptByte = Buffer.from([0x58]);
    writeFileSync(sample.dbPath, corruptByte);

    await expect(openFixtureStore(sample)).rejects.toThrow(/SQLite header|corrupt|not a SQLite/);
    expect(readFileSync(sample.dbPath)).toEqual(corruptByte);
  });

  test("allows only one active mission per repository and plan", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const first = store.createMission(missionInput(sample));

    expect(() => store.createMission(missionInput(sample, {
      commandId: randomUUID(),
      admissionReceiptId: randomUUID(),
      missionId: randomUUID(),
    }))).toThrow(/active mission already exists/);
    expect(store.inspectMission(first.id).state).toBe("prepared");
    store.close();
  });

  test("keeps repository marker and mission inspectable after deleting linked worktree", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const linked = path.join(sample.base, "linked");
    execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked], { cwd: sample.root });
    expect(store.ensureRepositoryIdentity(linked)).toBe(mission.repositoryId);
    execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: sample.root });
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: sample.root, encoding: "utf8" }).trim();
    expect(existsSync(path.join(commonDir, "pitako", "repository-id"))).toBe(true);
    acknowledgeOwnerRetirement(store, mission.id);
    store.close();

    const reopened = await openFixtureStore(sample);
    expect(reopened.ensureRepositoryIdentity(sample.root)).toBe(mission.repositoryId);
    expect(reopened.inspectMission(mission.id).snapshot.planHash).toBe(mission.snapshot.planHash);
    reopened.close();
  });

  test("rejects unknown event schema without rebuilding projections", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    store.close();
    const db = await openSqlite(sample.dbPath);
    db.prepare("UPDATE mission_events SET schema_version = 2 WHERE mission_id = ?").run(mission.id);
    db.close();
    const reopened = await openFixtureStore(sample);
    expect(() => reopened.inspectMission(mission.id)).toThrow(/event schema 2 is unsupported/);
    reopened.close();
  });

  test("returns nonzero with a recorded blocker for every later unimplemented stage", () => {
    const sample = fixture();
    for (const stage of ["T8"]) {
      const evidenceDir = path.join(sample.base, stage);
      const result = spawnSync("bun", ["scripts/verify-mission.ts", stage, "--evidence-dir", evidenceDir], { encoding: "utf8" });
      expect(result.status).toBe(1);
      const manifest = JSON.parse(readFileSync(path.join(evidenceDir, "verification-manifest.json"), "utf8"));
      expect(manifest.status).toBe("not_implemented");
      expect(manifest.stage).toBe(stage);
    }
  });

  test("reopened writer cannot replay or batch an uncertified mission completion", async () => {
    const sample = fixture();
    const first = await openFixtureStore(sample);
    const mission = first.createMission(missionInput(sample));
    acknowledgeOwnerRetirement(first, mission.id);
    first.close();
    const reopened = await openFixtureStore(sample);
    try {
      const before = reopened.inspectMission(mission.id);
      expect(reopened.ownerEpoch).not.toBeNull();
      const completion = { revision: before.revision, kind: "mission.completed", causalId: randomUUID(), payload: {} };
      expect(() => reopened.appendTransition(mission.id, before.version, { events: [completion] })).toThrow(/completion blocked/);
      expect(() => reopened.appendTransition(mission.id, before.version, { events: [
        { revision: before.revision, kind: "mission.resumed", causalId: randomUUID(), payload: {} }, completion,
      ] })).toThrow(/completion blocked/);
      expect(reopened.inspectMission(mission.id).latestSeq).toBe(before.latestSeq);
    } finally { reopened.close(); }
  });

  test("replay of a historical uncertified completion stays denied after reopening", async () => {
    const sample = fixture();
    const first = await openFixtureStore(sample);
    const mission = first.createMission(missionInput(sample));
    acknowledgeOwnerRetirement(first, mission.id);
    const before = first.inspectMission(mission.id);
    first.close();
    const causalId = randomUUID();
    const db = await openSqlite(sample.dbPath);
    db.prepare(`INSERT INTO mission_events (event_id, mission_id, revision, seq, schema_version, kind, causal_id,
      occurred_at, runtime_id, monotonic_duration_ms, unit_id, attempt_id, effect_id, team_round_id, reason, provenance_json, payload_json)
      SELECT ?, mission_id, revision, ?, schema_version, 'mission.completed', ?, occurred_at, runtime_id,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}' FROM mission_events WHERE mission_id = ? AND seq = 1`)
      .run(randomUUID(), before.latestSeq + 1, causalId, mission.id);
    db.prepare("UPDATE missions SET state = 'completed', version = version + 1, latest_seq = ? WHERE mission_id = ?")
      .run(before.latestSeq + 1, mission.id);
    db.close();
    const reopened = await openFixtureStore(sample);
    try {
      const current = reopened.inspectMission(mission.id);
      expect(current.state).toBe("completed");
      const replay = { revision: current.revision, kind: "mission.completed", causalId, payload: {} };
      expect(() => reopened.appendTransition(mission.id, current.version, { events: [replay] })).toThrow(/completion blocked/);
      expect(() => reopened.appendTransition(mission.id, current.version, { events: [replay,
        { revision: current.revision, kind: "mission.notification.delivered", causalId: randomUUID(), payload: {} },
      ] })).toThrow(/completion blocked/);
      expect(reopened.inspectMission(mission.id).version).toBe(current.version);
    } finally { reopened.close(); }
  });

  test("fails closed when a committed content object is missing or corrupt", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    store.close();
    const objectPath = path.join(sample.objectDir, mission.snapshot.planHash.slice(0, 2), mission.snapshot.planHash);
    writeFileSync(objectPath, Buffer.from("corrupt"));
    const reopened = await openFixtureStore(sample);
    expect(() => reopened.inspectMission(mission.id)).toThrow(/SHA-256 check/);
    reopened.close();
  });
});
