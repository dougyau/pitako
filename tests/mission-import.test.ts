import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MissionEngine } from "../extensions/mission/engine.ts";
import { admitMissionChange, nextPlanBytes } from "../extensions/mission/admission.ts";
import { importLegacyMission, readMissionLocator, reconcileLegacyHolds, reconcileMission } from "../extensions/mission/reconcile.ts";
import { currentProcessIdentity } from "../extensions/mission/workspace.ts";
import { createMissionFixture, openFixtureStore, operatorChangeReceipt, type MissionFixture } from "./mission-fixtures.ts";

const fixtures: MissionFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture.base, { recursive: true, force: true });
});

function fixture(): MissionFixture {
  const value = createMissionFixture("pitako-import-");
  fixtures.push(value);
  return value;
}

function recordT4Case(name: string, value: unknown): void {
  const directory = process.env.MISSION_T4_ARTIFACT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function ledger(holds: unknown[]): Buffer {
  return Buffer.from(`# Legacy ledger: preserve bytes exactly\r\n<!-- pitako-team-holds:v1 -->\r\n${JSON.stringify(holds)}\r\n<!-- /pitako-team-holds -->\r\n`, "utf8");
}

describe("legacy mission import and exact hold reconciliation", () => {
  test("imports exact bytes once, archives conflicting ledgers, and retires only positively evidenced holds", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.roleLaunches = 4;
    definition.budget.providerRequests = 8;
    definition.budget.tokens = 2000;
    definition.budget.activeTimeMs = 120000;
    definition.budget.artifactBytes = 3 * 1024 * 1024;
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const ledgerFile = path.join(sample.base, "legacy-ledger.md");
    const originalLedger = ledger([{ assignmentId: "legacy-task-17", unitId: "snapshot", status: "cancelled" }]);
    writeFileSync(ledgerFile, originalLedger);
    const store = await openFixtureStore(sample);
    const input = {
      store, repositoryRoot: sample.root, planId: "durable-fixture", planFile: sample.planFile,
      definitionFile: sample.definitionFile, ledgerFile, admissionReceiptId: sample.receiptId,
    };
    const imported = await importLegacyMission(input);
    expect(imported.disposition).toBe("imported");
    expect(imported.holdsKnown).toBe(true);
    expect(readMissionLocator(sample.root, "durable-fixture")?.missionId).toBe(imported.missionId);
    const firstInspection = store.inspectMission(imported.missionId);
    const importedEvent = firstInspection.events.find((event) => event.kind === "mission.imported");
    expect(importedEvent?.payload.holds).toHaveLength(1);
    const hold = (importedEvent!.payload.holds as Array<Record<string, unknown>>)[0]!;
    expect(hold.status).toBe("cancelled");
    expect(hold.disposition).toBe("unresolved");
    expect("result" in hold).toBe(false);
    expect(firstInspection.planBytes).toEqual(sample.planBytes);

    const repeated = await importLegacyMission(input);
    expect(repeated).toMatchObject({ missionId: imported.missionId, importKey: imported.importKey, disposition: "already_imported" });
    expect(store.inspectMission(imported.missionId).events.filter((event) => event.kind === "mission.imported")).toHaveLength(1);
    const unchangedArchive = firstInspection.events.find((event) => event.kind === "mission.imported")?.payload.archiveHashes;
    expect(unchangedArchive).toEqual(importedEvent?.payload.archiveHashes);

    let holdCheckCount = 0;
    let holdRetiredBeforeWorker = false;
    const verifyLegacyHold = async (exactHold: { holdId: string; assignmentId?: string; unitId?: string; status?: string }) => {
      holdCheckCount += 1;
      expect(exactHold).toMatchObject({ assignmentId: "legacy-task-17", unitId: "snapshot", status: "cancelled" });
      return { quiescent: true as const, artifacts: [{ path: "legacy/worker-quiescence.txt", bytes: Buffer.from("worker is gone; no outcome receipt exists\n") }] };
    };
    const engine = new MissionEngine({
      store, missionId: imported.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "engine-candidates") },
      verifyLegacyHold,
      runRole: async () => {
        const events = store.inspectMission(imported.missionId).events;
        const retiredAt = events.findIndex((event) => event.kind === "mission.hold.reconciled");
        const firstAttemptAt = events.findIndex((event) => event.kind === "attempt.reserved");
        holdRetiredBeforeWorker = retiredAt >= 0 && firstAttemptAt > retiredAt;
        return { instanceId: "legacy-hold-check", role: "developer", status: "failed",
          model: { selectedModel: "fixture/local" }, result: "hold verification does not fabricate a worker outcome" };
      },
    });
    engine.start();
    await engine.waitForIdle();
    engine.close();
    expect(holdCheckCount).toBe(1);
    expect(holdRetiredBeforeWorker).toBe(true);
    const disposition = await reconcileLegacyHolds({
      store, missionId: imported.missionId, importKey: imported.importKey,
      async verify() { throw new Error("repeat must not require or fabricate another result"); },
    });
    expect(disposition).toEqual([{ holdId: String(hold.holdId), disposition: "reconciled_without_outcome" }]);
    const reconciled = store.inspectMission(imported.missionId);
    const reconciliationEvent = reconciled.events.find((event) => event.kind === "mission.hold.reconciled");
    expect(reconciliationEvent?.payload).toMatchObject({
      holdId: hold.holdId, assignmentId: "legacy-task-17", unitId: "snapshot",
      originalStatus: "cancelled", disposition: "reconciled_without_outcome",
    });
    const proofBytes = reconciled.events.find((event) => event.kind === "mission.hold.reconciled") &&
      store.readArtifact(String(reconciliationEvent!.payload.proofHash));
    expect(JSON.parse(proofBytes!.toString("utf8"))).toMatchObject({
      format: "legacy-hold-proof-v1", holdId: hold.holdId, quiescent: true,
      artifacts: [{ path: "legacy/worker-quiescence.txt" }],
    });
    expect("result" in reconciliationEvent!.payload).toBe(false);
    recordT4Case(`import-hold-${imported.missionId}`, {
      beforeManifest: { planHash: importedEvent?.payload.planHash, ledgerHash: importedEvent?.payload.ledgerHash, archiveHashes: importedEvent?.payload.archiveHashes },
      currentManifest: { originalLedgerHash: createHash("sha256").update(originalLedger).digest("hex"), unchangedBytes: readFileSync(ledgerFile).equals(originalLedger) },
      reconciledManifest: { disposition: disposition[0]?.disposition, reconciliationEvent: reconciliationEvent?.payload },
      actionReport: { imported: imported.disposition, holdsKnown: imported.holdsKnown, warnings: imported.warnings },
      exitReport: { noOutcomeFabricated: !("result" in reconciliationEvent!.payload), repeatedDispositionStable: true,
        engineRetiredBeforeWorker: holdRetiredBeforeWorker, exactHostProbeCount: holdCheckCount },
    });
    expect(await reconcileLegacyHolds({
      store, missionId: imported.missionId, importKey: imported.importKey,
      async verify() { throw new Error("repeat must not require or fabricate another result"); },
    })).toEqual(disposition);

    const changedLedger = ledger([{ assignmentId: "legacy-task-18", unitId: "snapshot", status: "pending" }]);
    writeFileSync(ledgerFile, changedLedger);
    const conflict = await importLegacyMission(input);
    expect(conflict.disposition).toBe("conflict");
    const afterConflict = store.inspectMission(imported.missionId);
    expect(afterConflict.events.filter((event) => event.kind === "mission.created")).toHaveLength(1);
    const conflictEvent = afterConflict.events.find((event) => event.kind === "mission.import.conflict");
    expect(conflictEvent?.payload.holdsKnown).toBe(false);
    const hashes = conflictEvent?.payload.archiveHashes as string[];
    expect(hashes).toContain(createHash("sha256").update(changedLedger).digest("hex"));
    expect(readFileSync(ledgerFile).equals(changedLedger)).toBe(true);
    const recovery = await reconcileMission({ store, missionId: imported.missionId, sourceRoot: sample.root, trigger: "import-conflict" });
    expect(recovery.legacyConflicts).toHaveLength(1);
    expect(recovery.status).toBe("blocked");
    recordT4Case(`conflict-${imported.missionId}`, {
      beforeManifest: { originalLedgerHash: createHash("sha256").update(originalLedger).digest("hex") },
      currentManifest: { changedLedgerHash: createHash("sha256").update(changedLedger).digest("hex"), unchangedBytes: readFileSync(ledgerFile).equals(changedLedger) },
      reconciledManifest: { legacyConflicts: recovery.legacyConflicts, archiveHashes: hashes },
      actionReport: { disposition: conflict.disposition, recoveryStatus: recovery.status, blockers: recovery.blockers },
      exitReport: { oneMissionOnly: store.inspectMission(imported.missionId).events.filter((row) => row.kind === "mission.created").length === 1, exactLedgerPreserved: readFileSync(ledgerFile).equals(changedLedger) },
    });
    store.close();
  });

  test("failed exact hold probe gates held units and dependents before readiness, but not unrelated units", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.roleLaunches = 8;
    definition.budget.providerRequests = 12;
    definition.budget.tokens = 4000;
    definition.budget.activeTimeMs = 120000;
    definition.units.push(
      { ...definition.units[0], id: "dependent", dependencies: ["snapshot"], acceptance: [{ id: "dependent-proof", kind: "manual", target: "fixture:dependent" }] },
      { ...definition.units[0], id: "independent", dependencies: [], acceptance: [{ id: "independent-proof", kind: "manual", target: "fixture:independent" }] },
    );
    definition.finalization.requiredPredicates.push("dependent-proof", "independent-proof");
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const ledgerFile = path.join(sample.base, "legacy-ledger.md");
    writeFileSync(ledgerFile, ledger([{ assignmentId: "legacy-running-9", unitId: "snapshot", status: "cancelled" }]));
    const store = await openFixtureStore(sample);
    const imported = await importLegacyMission({
      store, repositoryRoot: sample.root, planId: "durable-fixture", planFile: sample.planFile,
      definitionFile: sample.definitionFile, ledgerFile, admissionReceiptId: sample.receiptId,
    });
    const launches: string[] = [];
    const engine = new MissionEngine({
      store, missionId: imported.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "hold-candidates") },
      verifyLegacyHold: async () => { throw new Error("quiescence probe failed"); },
      runRole: async ({ unit }) => {
        launches.push(unit.id);
        return { instanceId: unit.id, role: unit.role, status: "completed", model: { selectedModel: "fixture/local" }, result: "verified" };
      },
      assessPredicate: () => ({ verdict: "pass", method: "independent fixture check" }),
    });
    engine.start();
    await engine.waitForIdle();
    const after = store.inspectMission(imported.missionId);
    const importedEvent = after.events.find((event) => event.kind === "mission.imported")!;
    const hold = (importedEvent.payload.holds as Array<Record<string, unknown>>)[0]!;
    const reportEvent = after.events.find((event) => event.kind === "mission.recovery.recorded");
    const report = JSON.parse(store.readArtifact(String(reportEvent!.payload.reportHash)).toString("utf8"));
    expect(launches).toEqual(["independent"]);
    expect(after.events.some((event) => event.kind === "unit.ready" && ["snapshot", "dependent"].includes(String(event.unitId)))).toBe(false);
    expect(after.events.some((event) => event.kind === "attempt.reserved" && ["snapshot", "dependent"].includes(String(event.unitId)))).toBe(false);
    expect(after.events.some((event) => event.kind === "mission.hold.reconciled" && event.payload.holdId === hold.holdId)).toBe(false);
    expect(hold.status).toBe("cancelled");
    expect(report.holds).toEqual([expect.objectContaining({ holdId: hold.holdId, unitId: "snapshot", disposition: "unresolved" })]);
    expect(engine.snapshot().units.independent?.status).toBe("accepted");
    recordT4Case(`hold-frontier-failed-probe-${imported.missionId}`, {
      actionReport: report,
      exitReport: { launches, heldUnitReady: false, dependentReady: false, holdStatusPreserved: hold.status === "cancelled", unrelatedUnitAccepted: engine.snapshot().units.independent?.status === "accepted" },
    });
    await engine.close();
    store.close();
  });

  test("mapped hold plus unbound local effect denies independent work", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.roleLaunches = 6;
    definition.budget.providerRequests = 8;
    definition.units.push({ ...definition.units[0], id: "independent", dependencies: [],
      acceptance: [{ id: "independent-proof", kind: "manual", target: "fixture:independent" }] });
    definition.finalization.requiredPredicates.push("independent-proof");
    sample.definitionBytes = Buffer.from(JSON.stringify(definition));
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const ledgerFile = path.join(sample.base, "legacy-ledger.md");
    writeFileSync(ledgerFile, ledger([{ assignmentId: "legacy-running", unitId: "snapshot", status: "cancelled" }]));
    let store = await openFixtureStore(sample);
    const imported = await importLegacyMission({ store, repositoryRoot: sample.root, planId: "durable-fixture",
      planFile: sample.planFile, definitionFile: sample.definitionFile, ledgerFile, admissionReceiptId: sample.receiptId });
    const before = store.inspectMission(imported.missionId);
    const effectId = randomUUID();
    store.appendTransition(imported.missionId, before.version, { events: [
      { revision: before.revision, kind: "effect.intent", causalId: randomUUID(), effectId,
        payload: { effectId, operation: "bash" } },
      { revision: before.revision, kind: "effect.released", causalId: randomUUID(), effectId,
        payload: { effectId } },
    ] });
    const epoch = store.ownerEpoch!;
    const release = store.inspectMission(imported.missionId);
    store.appendTransition(imported.missionId, release.version, { events: [{ revision: release.revision,
      kind: "mission.owner.released", causalId: randomUUID(),
      payload: { owner: currentProcessIdentity(store.runtimeId, epoch), effectsQuiescent: true,
        reason: "fixture retirement", resumablePause: true, interruptedAttempts: [] } }] });
    store.close();
    store = await openFixtureStore(sample);
    const launched: string[] = [];
    const engine = new MissionEngine({ store, missionId: imported.missionId,
      sessionsDirectory: path.join(sample.stateDir, "sessions"), managedWorkspace: { sourceRoot: sample.root },
      verifyLegacyHold: async () => { throw new Error("quiescence is unknown"); },
      runRole: async ({ unit }) => { launched.push(unit.id); throw new Error("must not dispatch"); } });
    engine.start(); await engine.waitForIdle();
    const after = store.inspectMission(imported.missionId);
    const reportEvent = [...after.events].reverse().find((event) => event.kind === "mission.recovery.recorded")!;
    const report = JSON.parse(store.readArtifact(String(reportEvent.payload.reportHash)).toString("utf8"));
    expect(report.disposition.causes).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "unit", unitId: "snapshot" }),
      expect.objectContaining({ scope: "mission" }),
    ]));
    expect(launched).toEqual([]);
    expect(after.events.some((event) => event.kind === "attempt.reserved")).toBe(false);
    await engine.close();
    store.close();
  });

  test("raw conflicting import remains global despite a mapped hold and independent frontier", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.roleLaunches = 6;
    definition.budget.providerRequests = 8;
    definition.units.push({ ...definition.units[0], id: "independent", dependencies: [],
      acceptance: [{ id: "independent-proof", kind: "manual", target: "fixture:independent" }] });
    definition.finalization.requiredPredicates.push("independent-proof");
    sample.definitionBytes = Buffer.from(JSON.stringify(definition));
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const ledgerFile = path.join(sample.base, "legacy-ledger.md");
    writeFileSync(ledgerFile, ledger([{ assignmentId: "legacy-running", unitId: "snapshot", status: "cancelled" }]));
    const store = await openFixtureStore(sample);
    const input = { store, repositoryRoot: sample.root, planId: "durable-fixture", planFile: sample.planFile,
      definitionFile: sample.definitionFile, ledgerFile, admissionReceiptId: sample.receiptId };
    const imported = await importLegacyMission(input);
    writeFileSync(ledgerFile, ledger([{ assignmentId: "different", unitId: "snapshot", status: "cancelled" }]));
    expect((await importLegacyMission(input)).disposition).toBe("conflict");
    const launched: string[] = [];
    const engine = new MissionEngine({ store, missionId: imported.missionId,
      sessionsDirectory: path.join(sample.stateDir, "sessions"), managedWorkspace: { sourceRoot: sample.root },
      verifyLegacyHold: async () => { throw new Error("quiescence is unknown"); },
      runRole: async ({ unit }) => { launched.push(unit.id); throw new Error("must not dispatch"); } });
    engine.start(); await engine.waitForIdle();
    const after = store.inspectMission(imported.missionId);
    const reportEvent = [...after.events].reverse().find((event) => event.kind === "mission.recovery.recorded")!;
    const report = JSON.parse(store.readArtifact(String(reportEvent.payload.reportHash)).toString("utf8"));
    expect(report.status).toBe("blocked");
    expect(report.frontier).toContain("independent");
    expect(report.disposition.causes).toContainEqual(expect.objectContaining({ scope: "mission" }));
    const revised = structuredClone(after.definition);
    revised.units.find((unit: { id: string }) => unit.id === "independent")!.acceptance[0].target = "fixture:revised";
    admitMissionChange({ store, engine, missionId: imported.missionId, expectedVersion: after.version,
      planBytes: nextPlanBytes(after.planBytes), definitionBytes: Buffer.from(JSON.stringify(revised)),
      actor: "operator", receipt: operatorChangeReceipt(store, after, revised) });
    engine.start(); await engine.waitForIdle();
    expect(launched).toEqual([]);
    expect(store.inspectMission(imported.missionId).events.some((event) => event.kind === "attempt.reserved")).toBe(false);
    expect(store.inspectMission(imported.missionId).events.some((event) => event.kind === "unit.accepted")).toBe(false);
    await engine.close();
    store.close();
  });

  test("new conflict invalidates scoped report while independent receipt is in flight", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.roleLaunches = 6;
    definition.budget.providerRequests = 8;
    definition.units.push({ ...definition.units[0], id: "independent", dependencies: [],
      acceptance: [{ id: "independent-proof", kind: "manual", target: "fixture:independent" }] });
    definition.finalization.requiredPredicates.push("independent-proof");
    sample.definitionBytes = Buffer.from(JSON.stringify(definition));
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const ledgerFile = path.join(sample.base, "legacy-ledger.md");
    writeFileSync(ledgerFile, ledger([{ assignmentId: "legacy-running", unitId: "snapshot", status: "cancelled" }]));
    const store = await openFixtureStore(sample);
    const imported = await importLegacyMission({ store, repositoryRoot: sample.root, planId: "durable-fixture",
      planFile: sample.planFile, definitionFile: sample.definitionFile, ledgerFile, admissionReceiptId: sample.receiptId });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const engine = new MissionEngine({ store, missionId: imported.missionId,
      sessionsDirectory: path.join(sample.stateDir, "sessions"), managedWorkspace: { sourceRoot: sample.root },
      verifyLegacyHold: async () => { throw new Error("quiescence is unknown"); },
      runRole: async ({ unit }) => { expect(unit.id).toBe("independent"); await pending;
        return { instanceId: "independent", role: unit.role, status: "completed",
          model: { selectedModel: "fixture/local" }, result: "verified" }; },
      assessPredicate: () => ({ verdict: "pass", method: "independent fixture check" }) });
    engine.start();
    for (let i = 0; i < 100 && !store.inspectMission(imported.missionId).events.some((event) =>
      event.kind === "attempt.started" && event.unitId === "independent"); i++) await Bun.sleep(10);
    const running = store.inspectMission(imported.missionId);
    expect(running.events.some((event) => event.kind === "attempt.started" && event.unitId === "independent")).toBe(true);
    const prior = running.events.find((event) => event.kind === "mission.recovery.recorded")!;
    store.appendTransition(imported.missionId, running.version, { events: [{ revision: running.revision,
      kind: "mission.import.conflict", causalId: randomUUID(), payload: { importKey: "new-conflict", archiveHashes: [] } }] });
    release(); await engine.waitForIdle();
    const after = store.inspectMission(imported.missionId);
    expect(after.events.some((event) => event.kind === "attempt.receipt" && event.unitId === "independent")).toBe(true);
    expect(after.events.some((event) => event.kind === "unit.accepted" && event.unitId === "independent")).toBe(false);
    expect(after.events.filter((event) => event.kind === "attempt.reserved")).toHaveLength(1);
    expect(prior.seq).toBeLessThan(after.events.find((event) => event.kind === "mission.import.conflict")!.seq);
    await engine.close(); store.close();
  });

  test("malformed and generated legacy ledgers remain explicit unknowns without clearing holds", async () => {
    const sample = fixture();
    const ledgerFile = path.join(sample.base, "legacy-ledger.md");
    const malformed = Buffer.from("<!-- pitako-team-holds:v1 -->\r\n[not json]\r\n<!-- /pitako-team-holds -->\r\n", "utf8");
    writeFileSync(ledgerFile, malformed);
    const store = await openFixtureStore(sample);
    const input = {
      store, repositoryRoot: sample.root, planId: "durable-fixture", planFile: sample.planFile,
      definitionFile: sample.definitionFile, ledgerFile, admissionReceiptId: sample.receiptId,
    };
    const imported = await importLegacyMission(input);
    expect(imported.disposition).toBe("imported");
    expect(imported.holdsKnown).toBe(false);
    const event = store.inspectMission(imported.missionId).events.find((row) => row.kind === "mission.imported");
    expect(event?.payload.holds).toEqual([]);
    await expect(reconcileLegacyHolds({
      store, missionId: imported.missionId, importKey: imported.importKey,
      async verify() { return { quiescent: true, artifacts: [{ path: "proof", bytes: Buffer.from("no") }] }; },
    })).rejects.toThrow(/holds are unknown/);
    const report = await reconcileMission({ store, missionId: imported.missionId, sourceRoot: sample.root, trigger: "malformed-import" });
    expect(report.blockers.join(" ")).toContain("malformed or unknown");
    expect(readFileSync(ledgerFile).equals(malformed)).toBe(true);
    recordT4Case(`import-unknown-${imported.missionId}`, {
      beforeManifest: { ledgerHash: createHash("sha256").update(malformed).digest("hex") },
      currentManifest: { malformedLedgerPreserved: readFileSync(ledgerFile).equals(malformed) },
      reconciledManifest: { holds: event?.payload.holds, blockers: report.blockers },
      actionReport: { disposition: imported.disposition, holdsKnown: imported.holdsKnown, reportStatus: report.status },
      exitReport: { noHoldRetired: store.inspectMission(imported.missionId).events.every((row) => row.kind !== "mission.hold.reconciled") },
    });
    store.close();
  });
});
