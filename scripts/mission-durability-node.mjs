import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { missionDefinition } from "../tests/mission-fixtures.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";
import { applyConditionalMissionPatch, reconcileMission, sealWorkspaceImage } from "../extensions/mission/reconcile.ts";
import { captureWorkspaceImage, createMissionWorkspace, currentProcessIdentity, filterWorkspaceImage, registerCandidateWorkspace } from "../extensions/mission/workspace.ts";
import { ledgerFile, ledgerTeamHolds, openExecutionPlan, parseLedgerBinding, parseLedgerStatus, readFrozenPlan } from "../extensions/workflow.ts";

const script = fileURLToPath(import.meta.url);
const phases = new Set(["cross-process", "replay", "crash", "schema", "identity", "authority", "recovery"]);
const selectedPhase = process.env.MISSION_DURABILITY_PHASE;
if (selectedPhase && !phases.has(selectedPhase)) throw new Error(`unknown mission durability phase ${selectedPhase}`);
const roots = [];
const observations = [];
const cliMode = process.argv[2]?.startsWith("--") ?? false;

function phaseTest(phase, name, action) {
  if (!cliMode && (!selectedPhase || selectedPhase === phase)) test(`[${phase}] ${name}`, action);
}

function observe(id, facts) {
  const observation = { id, phase: selectedPhase ?? "all", facts, assertionsPassed: false };
  observations.push(observation);
  return () => { observation.assertionsPassed = true; };
}

function fixture(prefix = "pitako-node-mission-") {
  const base = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(base);
  const root = path.join(base, "repo");
  const plans = path.join(root, ".pitako", "plans");
  mkdirSync(plans, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial", "-q"]);
  const planFile = path.join(plans, "durable-fixture.md");
  const definitionFile = path.join(plans, "durable-fixture.mission.json");
  const planBytes = Buffer.from("---\r\nid: durable-fixture\r\nrevision: 1\r\nstatus: frozen\r\nexecution: expected\r\n---\r\n\r\n# Exact snapshot  \r\n", "utf8");
  const definitionBytes = Buffer.from(`${JSON.stringify(missionDefinition(), null, 2)}\n`, "utf8");
  writeFileSync(planFile, planBytes);
  writeFileSync(definitionFile, definitionBytes);
  const stateDir = path.join(base, "agent-state");
  return { base, root, planFile, definitionFile, planBytes, definitionBytes, stateDir, commandId: randomUUID(), receiptId: randomUUID() };
}

function dbPaths(stateDir) {
  const dataDir = path.join(stateDir, "pitako");
  return { dbPath: path.join(dataDir, "missions.db"), objectDir: path.join(dataDir, "missions", "objects") };
}

function git(cwd, args) {
  return execGit(cwd, args);
}

function execGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanGitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

function node(args, expectedStatus = 0) {
  const env = { ...process.env };
  delete env.MISSION_DURABILITY_PHASE;
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  assert.equal(result.status, expectedStatus, `child status; stdout=${result.stdout}; stderr=${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null;
}

function crashNode(args, expectedStatus) {
  const env = { ...process.env };
  delete env.MISSION_DURABILITY_PHASE;
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  assert.equal(result.status, expectedStatus, `crashed child status; stdout=${result.stdout}; stderr=${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function writerArgs(sample, missionId, cut) {
  return ["--writer", sample.root, sample.stateDir, sample.planFile, sample.definitionFile, sample.commandId, sample.receiptId, missionId, cut ?? "-"];
}

function acknowledgeRetirement(store, missionId) {
  const inspection = store.inspectMission(missionId);
  const epoch = store.ownerEpoch;
  assert.notEqual(epoch, null);
  store.appendTransition(missionId, inspection.version, { events: [{
    revision: inspection.revision,
    kind: "mission.owner.released",
    causalId: randomUUID(),
    payload: {
      owner: currentProcessIdentity(store.runtimeId, epoch),
      reason: "Node owner probe retirement",
      effectsQuiescent: true,
      resumablePause: false,
      interruptedAttempts: [],
    },
  }] });
}

function startHolder(sample) {
  const child = spawn(process.execPath, [script, "--hold-owner", sample.root, sample.stateDir, sample.planFile, sample.definitionFile,
    sample.commandId, sample.receiptId, randomUUID()], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const nextLine = () => new Promise((resolve, reject) => {
    const onLine = (line) => { cleanup(); resolve(JSON.parse(line)); };
    const onExit = (code, signal) => { cleanup(); reject(new Error(`owner child exited before output: ${code ?? signal}`)); };
    const cleanup = () => { lines.off("line", onLine); child.off("exit", onExit); };
    lines.once("line", onLine);
    child.once("exit", onExit);
  });
  return { child, nextLine, ready: nextLine() };
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

phaseTest("cross-process", "reopens exact committed snapshots and exports from a second Node process", () => {
  const sample = fixture();
  const missionId = randomUUID();
  const writer = node(writerArgs(sample, missionId));
  const exportDir = path.join(sample.base, "export");
  const reader = node(["--reader", sample.stateDir, missionId, exportDir]);
  const observedPlanBytes = Buffer.from(reader.planBase64, "base64");
  const observedDefinitionBytes = Buffer.from(reader.definitionBase64, "base64");
  const manifest = JSON.parse(readFileSync(path.join(exportDir, "export.json"), "utf8"));
  const databaseHashMatches = manifest.database.hash === createHash("sha256").update(readFileSync(path.join(exportDir, "missions.sqlite"))).digest("hex");
  const objectHashesMatch = manifest.artifacts.every((artifact) => {
    const bytes = readFileSync(path.join(exportDir, artifact.path));
    return createHash("sha256").update(bytes).digest("hex") === artifact.hash;
  });
  const finish = observe("cross-process-read", {
    writerMissionId: writer.missionId,
    readerMissionId: reader.missionId,
    readerPid: reader.pid,
    verifierPid: process.pid,
    planBytes: { observed: observedPlanBytes.length, expected: sample.planBytes.length, hash: reader.planHash, expectedHash: createHash("sha256").update(sample.planBytes).digest("hex") },
    definitionBytes: { observed: observedDefinitionBytes.length, expected: sample.definitionBytes.length, hash: reader.definitionHash, expectedHash: createHash("sha256").update(sample.definitionBytes).digest("hex") },
    manifest: { missionId: manifest.missionId, artifactCount: manifest.artifacts.length, databaseHashMatches, objectHashesMatch },
  });
  assert.equal(writer.missionId, missionId);
  assert.notEqual(reader.pid, process.pid);
  assert.equal(observedPlanBytes.compare(sample.planBytes), 0);
  assert.equal(observedDefinitionBytes.compare(sample.definitionBytes), 0);
  assert.equal(reader.planHash, createHash("sha256").update(sample.planBytes).digest("hex"));
  assert.equal(reader.definitionHash, createHash("sha256").update(sample.definitionBytes).digest("hex"));
  assert.equal(manifest.missionId, missionId);
  assert.equal(databaseHashMatches, true);
  assert.equal(objectHashesMatch, true);
  finish();
});

phaseTest("recovery", "a hard owner crash restores partial candidate work, merges source drift, and replays recovery idempotently", async () => {
  const sample = fixture("pitako-node-recovery-");
  mkdirSync(path.join(sample.root, "src"));
  writeFileSync(path.join(sample.root, "src", "app.ts"), "export const mission = 'base';\n");
  writeFileSync(path.join(sample.root, "src", "user.ts"), "export const user = 'base';\n");
  git(sample.root, ["add", "src/app.ts", "src/user.ts"]);
  git(sample.root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "recovery fixture", "-q"]);
  const definition = missionDefinition();
  definition.authority.allowedPaths = ["src/**"];
  definition.units[0].inputs = ["src/**"];
  sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
  writeFileSync(sample.definitionFile, sample.definitionBytes);
  const missionId = randomUUID();
  const candidateParent = path.join(sample.base, "candidates");
  const crashed = crashNode([
    "--recovery-crash-writer", sample.root, sample.stateDir, sample.planFile, sample.definitionFile,
    sample.commandId, sample.receiptId, missionId, candidateParent,
  ], 86);
  assert.equal(crashed.missionId, missionId);
  writeFileSync(path.join(sample.root, "src", "user.ts"), "export const user = 'edited by user';\n");
  const store = await openMissionStore(dbPaths(sample.stateDir));
  assert.equal(store.ownerAcquisitionProof?.source, "owner-death");
  const report = await reconcileMission({
    store, missionId, sourceRoot: sample.root, candidateParent: path.join(sample.base, "recovered"),
    planFile: sample.planFile, trigger: "node-hard-crash",
  });
  assert.equal(report.status, "resumed");
  assert.equal(report.candidate.restored, true);
  assert.equal(report.source.changedPaths.includes("src/user.ts"), true);
  assert.equal(report.frontier.includes("snapshot"), true);
  assert.equal(readFileSync(path.join(sample.root, "src", "app.ts"), "utf8"), "export const mission = 'base';\n");
  const reportEvent = store.inspectMission(missionId).events.find((event) => event.kind === "mission.recovery.recorded");
  const patchHash = report.delivery.patchHash;
  assert.ok(reportEvent && patchHash);
  const patch = JSON.parse(store.readArtifact(patchHash).toString("utf8"));
  const deliveryCopy = createMissionWorkspace({
    missionId, attemptId: randomUUID(), sourceRoot: sample.root, storeRoot: store.storageRoot,
    candidateParent: path.join(sample.base, "delivery-copy"), allowedPaths: ["src/**"],
  });
  const accepted = applyConditionalMissionPatch(patch, deliveryCopy);
  assert.equal(accepted.hash, report.delivery.acceptedManifestHash);
  assert.equal(readFileSync(path.join(deliveryCopy.candidateRoot, "src", "app.ts"), "utf8"), "export const mission = 'partial mission write';\n");
  assert.equal(readFileSync(path.join(deliveryCopy.candidateRoot, "src", "user.ts"), "utf8"), "export const user = 'edited by user';\n");
  const version = store.inspectMission(missionId).version;
  const repeated = await reconcileMission({
    store, missionId, sourceRoot: sample.root, candidateParent: path.join(sample.base, "recovered"),
    planFile: sample.planFile, trigger: "node-hard-crash",
  });
  assert.deepEqual(repeated, report);
  assert.equal(store.inspectMission(missionId).version, version);
  const recoveryInspection = store.inspectMission(missionId);
  const baseSnapshot = recoveryInspection.events.find((event) => event.kind === "workspace.snapshot.sealed" && event.payload.phase === "base");
  const reconciledManifest = captureWorkspaceImage(deliveryCopy.candidateRoot).manifest;
  const facts = {
    writerPid: crashed.pid, readerPid: process.pid, writerExitCode: crashed.exitCode ?? 86, ownerProof: store.ownerAcquisitionProof?.source,
    beforeManifest: baseSnapshot?.payload.manifest ?? null, currentManifest: report.source.manifest, reconciledManifest,
    actionReport: { status: report.status, blockers: report.blockers, frontier: report.frontier, effects: report.effects, holds: report.holds },
    missionId, attemptId: crashed.attemptId, status: report.status, restored: report.candidate.restored,
    sourceChangedPaths: report.source.changedPaths, frontier: report.frontier,
    deliveryBaseManifestHash: report.delivery.baseManifestHash, acceptedManifestHash: accepted.hash,
    sourceMissionFileUnchanged: readFileSync(path.join(sample.root, "src", "app.ts"), "utf8") === "export const mission = 'base';\n",
    userDriftPreserved: readFileSync(path.join(deliveryCopy.candidateRoot, "src", "user.ts"), "utf8").includes("edited by user"),
    repeatedVersionStable: store.inspectMission(missionId).version === version,
  };
  assert.notEqual(facts.writerPid, facts.readerPid);
  assert.equal(facts.sourceMissionFileUnchanged, true);
  assert.equal(facts.userDriftPreserved, true);
  assert.equal(facts.repeatedVersionStable, true);
  const finish = observe("hard-crash-recovery", facts);
  finish();
  store.close();
});

phaseTest("replay", "duplicate command and reservation remain stable across production Node processes", () => {
  const sample = fixture();
  const missionId = randomUUID();
  node(writerArgs(sample, missionId));
  const reservationId = randomUUID();
  const first = node(["--repeat", sample.stateDir, missionId, reservationId]);
  const second = node(["--repeat", sample.stateDir, missionId, reservationId]);
  const finish = observe("cross-process-replay", {
    firstVersion: first.version,
    secondVersion: second.version,
    sameProjectionHash: first.replay === second.replay,
    sameReservationEvent: first.first.eventId === second.first.eventId,
  });
  assert.deepEqual(second, first);
  const duplicateCommand = node(writerArgs(sample, randomUUID()));
  assert.equal(duplicateCommand.missionId, missionId);
  finish();
});

phaseTest("replay", "reservation grants, overage debt, and admission fences survive production Node replay", async () => {
  const sample = fixture("pitako-node-settlement-");
  const definition = missionDefinition();
  definition.budget.tokens = 10;
  sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
  writeFileSync(sample.definitionFile, sample.definitionBytes);
  const input = {
    repositoryRoot: sample.root,
    planId: "durable-fixture",
    planFile: sample.planFile,
    definitionFile: sample.definitionFile,
    commandId: sample.commandId,
    admissionReceiptId: sample.receiptId,
  };
  const store = await openMissionStore(dbPaths(sample.stateDir));
  const mission = store.createMission(input);
  const reservation = store.reserve(mission.id, {
    id: randomUUID(), revision: 1, resource: "tokens", amount: 10,
  }, mission.version);
  store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{
    revision: 1,
    kind: "budget.reservation.settled",
    causalId: randomUUID(),
    payload: {
      reservationId: reservation.id, resource: "tokens", knownCharge: 15, unknownCharge: 0,
      released: 0, source: "Node settlement replay probe",
    },
  }] });
  acknowledgeRetirement(store, mission.id);
  const before = store.inspectMission(mission.id);
  const projectionHash = store.replayMission(mission.id).projectionHash;
  store.close();

  const reopened = await openMissionStore(dbPaths(sample.stateDir));
  const after = reopened.inspectMission(mission.id);
  const replay = reopened.replayMission(mission.id);
  let admissionError = "";
  try { reopened.reserve(mission.id, { id: randomUUID(), revision: 1, resource: "tokens", amount: 1 }, after.version); }
  catch (error) { admissionError = String(error); }
  const settled = after.reservations.find(({ id }) => id === reservation.id);
  const finish = observe("reservation-settlement-replay", {
    originalGrant: settled?.grantAmount,
    actualCharge: settled?.knownCharge,
    preservedDebt: settled?.overage,
    occupiedCapacity: settled?.amount,
    admissionFence: after.events.some(({ kind }) => kind === "budget.admission.fenced"),
    admissionError,
    sameProjectionHash: replay.projectionHash === projectionHash,
    sameReservations: JSON.stringify(after.reservations) === JSON.stringify(before.reservations),
  });
  assert.equal(settled?.grantAmount, 10);
  assert.equal(settled?.knownCharge, 15);
  assert.equal(settled?.overage, 5);
  assert.equal(settled?.amount, 15);
  assert.equal(after.events.some(({ kind }) => kind === "budget.admission.fenced"), true);
  assert.match(admissionError, /mission admission is fenced/);
  assert.equal(replay.projectionHash, projectionHash);
  assert.deepEqual(after.reservations, before.reservations);
  finish();
  reopened.close();
});

phaseTest("replay", "writer reservations and causal fact replay prevent duplicate writes in production Node", async () => {
  const sample = fixture("pitako-node-owner-");
  const first = await openMissionStore(dbPaths(sample.stateDir));
  const input = {
    repositoryRoot: sample.root,
    planId: "durable-fixture",
    planFile: sample.planFile,
    definitionFile: sample.definitionFile,
    commandId: sample.commandId,
    admissionReceiptId: sample.receiptId,
  };
  const mission = first.createMission(input);
  const second = await openMissionStore(dbPaths(sample.stateDir));
  let secondWriterError = "";
  try { second.reserve(mission.id, { id: randomUUID(), revision: 1, resource: "provider-requests", amount: 1 }, 1); }
  catch (error) { secondWriterError = String(error); }
  let secondMissionError = "";
  try { second.createMission({ ...input, commandId: randomUUID(), admissionReceiptId: randomUUID(), missionId: randomUUID() }); }
  catch (error) { secondMissionError = String(error); }
  const reservation = first.reserve(mission.id, { id: randomUUID(), revision: 1, resource: "provider-requests", amount: 1 }, 1);
  const fact = {
    schemaVersion: 1,
    id: randomUUID(),
    missionId: mission.id,
    revision: 1,
    causalId: randomUUID(),
    metric: "provider-input-tokens",
    value: null,
    unit: "tokens",
    source: "production Node receipt fixture",
    occurredAt: new Date().toISOString(),
    runtimeId: first.runtimeId,
    durationMs: null,
    unknownReason: "fixture has no provider usage",
    inputTokens: null,
    outputTokens: null,
    usageUnknownReason: "no provider request was made",
  };
  const firstMeasurement = first.recordMeasurement(fact, 2);
  const duplicateMeasurement = first.recordMeasurement({ ...fact, id: randomUUID() }, 3);
  let causalConflictError = "";
  try { first.recordMeasurement({ ...fact, id: randomUUID(), metric: "different" }, 3); }
  catch (error) { causalConflictError = String(error); }
  const inspection = first.inspectMission(mission.id);
  const finish = observe("owner-and-causal-replay", {
    secondWriter: { expected: "read-only", error: secondWriterError },
    secondMission: { expected: "read-only", error: secondMissionError },
    reservationEventId: reservation.eventId,
    measurement: {
      firstId: firstMeasurement.id,
      replayId: duplicateMeasurement.id,
      count: inspection.measurements.length,
      causalId: inspection.measurements[0]?.causalId,
      version: inspection.version,
      conflictError: causalConflictError,
    },
  });

  assert.match(secondWriterError, /read-only.*writer reservation/);
  assert.match(secondMissionError, /read-only.*writer reservation/);
  assert.equal(firstMeasurement.id, duplicateMeasurement.id);
  assert.equal(inspection.measurements.length, 1);
  assert.match(causalConflictError, /causalId.*different contents/);
  assert.equal(inspection.version, 3);
  finish();
  first.close();
  second.close();
});

phaseTest("replay", "live owners, persisted retirement, and hard-death proof fence Node writer epochs", async () => {
  const live = fixture("pitako-node-live-owner-");
  const holder = startHolder(live);
  const ready = await holder.ready;
  const rejected = node(["--owner-probe", live.stateDir, ready.missionId, randomUUID(), path.join(live.base, "read-only-export")]);
  holder.child.stdin.write("release\n");
  const released = await holder.nextLine();
  const holderExit = await waitForExit(holder.child);
  const afterRelease = node(["--owner-probe", live.stateDir, ready.missionId, randomUUID()]);

  const crashed = fixture("pitako-node-crashed-owner-");
  const crashMissionId = randomUUID();
  const orphan = node(["--orphan-owner", crashed.root, crashed.stateDir, crashed.planFile, crashed.definitionFile,
    crashed.commandId, crashed.receiptId, crashMissionId], 86);
  const afterCrash = node(["--owner-probe", crashed.stateDir, crashMissionId, randomUUID()]);
  const finish = observe("writer-reservation-lifecycle", {
    live: { holderPid: ready.pid, probePid: rejected.pid, missionId: ready.missionId, writeError: rejected.writeError,
      inspected: rejected.missionId, exported: rejected.exportedMissionId },
    release: { message: released, exitCode: holderExit.code, reopenedVersion: afterRelease.version, ownerEpoch: afterRelease.ownerEpoch },
    crash: { exitCode: 86, observedExitCode: 86, orphanPid: orphan.pid, missionId: crashMissionId,
      writeError: afterCrash.writeError, inspected: afterCrash.missionId, ownerEpoch: afterCrash.ownerEpoch,
      reservationId: afterCrash.reservationId },
  });
  assert.notEqual(ready.pid, rejected.pid);
  assert.equal(rejected.missionId, ready.missionId);
  assert.equal(rejected.exportedMissionId, ready.missionId);
  assert.match(rejected.writeError, /read-only.*writer reservation/);
  assert.deepEqual(released, { released: true });
  assert.equal(holderExit.code, 0);
  assert.equal(afterRelease.version, 2);
  assert.equal(afterRelease.ownerEpoch, 2);
  assert.equal(orphan.missionId, crashMissionId);
  assert.equal(afterCrash.missionId, crashMissionId);
  assert.equal(afterCrash.writeError, "");
  assert.equal(afterCrash.ownerEpoch, 2);
  assert.ok(afterCrash.reservationId);
  finish();
});

phaseTest("crash", "process death at each object and database commit cut leaves safe references", () => {
  for (const [boundary, committed, unreferenced] of [
    ["object.after-temp-sync", false, 1],
    ["object.after-rename", false, 1],
    ["mission.create.before-commit", false, 2],
    ["mission.create.after-commit", true, 0],
  ]) {
    const sample = fixture(`pitako-node-cut-${boundary.replaceAll(".", "-")}-`);
    const missionId = randomUUID();
    node(writerArgs(sample, missionId, boundary), 86);
    const result = node(["--probe", sample.stateDir, missionId]);
    const finish = observe(`crash-cut:${boundary}`, {
      boundary,
      expected: { found: committed, referenceCount: committed ? 2 : 0, invalidObjectCount: 0, unreferencedObjectCount: unreferenced },
      observed: result,
    });
    assert.equal(result.found, committed, boundary);
    if (committed) {
      assert.equal(result.referenceCount, 2);
      assert.equal(result.invalidObjectCount, 0);
      assert.equal(result.unreferencedObjectCount, unreferenced);
    } else {
      assert.equal(result.referenceCount, 0);
      assert.equal(result.invalidObjectCount, 0);
      assert.equal(result.unreferencedObjectCount, unreferenced);
    }
    finish();
  }
});

phaseTest("crash", "replayed receipt claims cannot settle unknown or unbound invoking effects", async () => {
  const cases = [];
  for (const mode of ["unknown-then-receipt", "invoking-without-identity"]) {
    const sample = fixture(`pitako-node-effect-settlement-${mode}-`);
    let store = await openMissionStore(dbPaths(sample.stateDir));
    const mission = store.createMission({
      repositoryRoot: sample.root, planId: "durable-fixture", planFile: sample.planFile,
      definitionFile: sample.definitionFile, commandId: sample.commandId, admissionReceiptId: sample.receiptId,
    });
    const attemptId = randomUUID();
    const effectId = randomUUID();
    const artifact = Buffer.from("worker claims PASS");
    const artifactHash = createHash("sha256").update(artifact).digest("hex");
    const binding = {
      missionId: mission.id, revision: 1, unitId: "snapshot", roundId: "main", memberId: "solo",
      attemptId, attemptNo: 1, ownerEpoch: store.ownerEpoch, candidate: "managed",
      candidateRoot: "/quarantined-candidate", inputManifestHash: "a".repeat(64),
      briefHash: "b".repeat(64), rolePolicyHash: "c".repeat(64),
    };
    const pidNamespace = "pid:[4026533003]";
    const identity = {
      hostId: "host-fixture", bootId: "boot-fixture", pid: process.pid, birthTicks: 789,
      containedPid: 1, pidNamespace, networkNamespace: "net:[4026533003]",
      runtimeId: store.runtimeId, epoch: store.ownerEpoch,
    };
    const kinds = mode === "unknown-then-receipt"
      ? ["effect.intent", "effect.invoking", "effect.process.registered", "effect.released", "effect.unknown"]
      : ["effect.intent", "effect.invoking"];
    const effectEvents = kinds.map((kind) => ({
      kind, unitId: "snapshot", attemptId, effectId,
      payload: {
        effectId,
        ...(kind === "effect.process.registered" ? { identity } : {}),
        ...(kind === "effect.released" ? { processIdentity: identity } : {}),
        ...(kind === "effect.unknown" ? { reason: "receipt missing" } : {}),
      },
    }));
    const processClaim = mode === "unknown-then-receipt"
      ? { ...identity, descendantsQuiescent: true, namespaceEmptyAfterExit: true }
      : { descendantsQuiescent: true, namespaceEmptyAfterExit: true };
    const inspection = store.inspectMission(mission.id);
    store.appendTransition(mission.id, inspection.version, {
      events: [
        { kind: "mission.activated", payload: { missionId: mission.id } },
        { kind: "attempt.reserved", unitId: "snapshot", attemptId, payload: { attemptId, binding, unitId: "snapshot", roundId: "main", memberId: "solo" } },
        ...effectEvents,
        { kind: "effect.receipt", unitId: "snapshot", attemptId, effectId,
          payload: { effectId, status: "completed", paths: [], process: processClaim } },
        { kind: "attempt.receipt", unitId: "snapshot", attemptId,
          payload: { attemptId, unitId: "snapshot", status: "completed", artifactHash } },
      ].map((event) => ({ revision: 1, causalId: randomUUID(), ...event })),
      artifacts: [{ bytes: artifact, mediaType: "text/plain; charset=utf-8" }],
    });
    acknowledgeRetirement(store, mission.id);
    store.close();

    store = await openMissionStore(dbPaths(sample.stateDir));
    let assessments = 0;
    const engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole: async () => { throw new Error("replayed receipts must settle before role dispatch"); },
      assessPredicate: () => { assessments += 1; return { verdict: "pass", method: "Node settlement regression" }; },
    });
    try {
      engine.start();
      await engine.waitForIdle();
      const saved = store.inspectMission(mission.id).events;
      const facts = {
        mode,
        replayedOwnerEpoch: store.ownerEpoch,
        assessments,
        evidenceRecorded: saved.some(({ kind }) => kind === "evidence.recorded"),
        unitAccepted: saved.some(({ kind }) => kind === "unit.accepted"),
        settledStatus: saved.find(({ kind }) => kind === "attempt.settled")?.payload.status ?? null,
        unitStatus: engine.snapshot().units.snapshot?.status ?? null,
        effectKinds: saved.filter(({ effectId: id }) => id === effectId).map(({ kind }) => kind),
      };
      const finish = observe(`effect-settlement:${mode}`, facts);
      assert.equal(facts.replayedOwnerEpoch, 2);
      assert.equal(assessments, 0);
      assert.equal(facts.evidenceRecorded, false);
      assert.equal(facts.unitAccepted, false);
      assert.equal(facts.settledStatus, "failed");
      assert.equal(facts.unitStatus, "blocked");
      finish();
      cases.push(facts);
    } finally {
      await engine.close();
      store.close();
    }
  }
  assert.deepEqual(cases.map(({ mode }) => mode), ["unknown-then-receipt", "invoking-without-identity"]);
});

phaseTest("schema", "unknown and corrupt Node SQLite stores never become empty missions", () => {
  const sample = fixture();
  const { dbPath } = dbPaths(sample.stateDir);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA user_version = 93");
  db.close();
  const unknown = node(["--schema", sample.stateDir, "pitako"]);
  const unknownVersion = new DatabaseSync(dbPath, { readOnly: true });
  const observedVersion = unknownVersion.prepare("PRAGMA user_version").get().user_version;
  unknownVersion.close();
  const corruptPath = path.join(sample.base, "corrupt", "missions.db");
  mkdirSync(path.dirname(corruptPath), { recursive: true });
  const corruptBytes = Buffer.from("not sqlite data");
  writeFileSync(corruptPath, corruptBytes);
  const corrupt = node(["--schema", sample.base, "corrupt"]);
  const corruptPreserved = readFileSync(corruptPath).equals(corruptBytes);
  const zeroPath = path.join(sample.base, "zero", "missions.db");
  mkdirSync(path.dirname(zeroPath), { recursive: true });
  writeFileSync(zeroPath, Buffer.alloc(0));
  const zero = node(["--schema", sample.base, "zero"]);
  const zeroPreserved = readFileSync(zeroPath).length === 0;
  const oneBytePath = path.join(sample.base, "one-byte", "missions.db");
  mkdirSync(path.dirname(oneBytePath), { recursive: true });
  const oneByte = Buffer.from([0x58]);
  writeFileSync(oneBytePath, oneByte);
  const oneByteResult = node(["--schema", sample.base, "one-byte"]);
  const oneBytePreserved = readFileSync(oneBytePath).equals(oneByte);
  const finish = observe("fail-closed-schema", {
    unknownSchema: { expectedVersion: 93, observedVersion, rejection: unknown.error },
    corruptDatabase: { expectedBytes: corruptBytes.length, observedBytes: readFileSync(corruptPath).length, preserved: corruptPreserved, rejection: corrupt.error },
    emptyDatabase: { expectedBytes: 0, observedBytes: readFileSync(zeroPath).length, preserved: zeroPreserved, rejection: zero.error },
    oneByteDatabase: { expectedBytes: oneByte.length, observedBytes: readFileSync(oneBytePath).length, preserved: oneBytePreserved, rejection: oneByteResult.error },
  });
  assert.match(unknown.error, /schema version 93 is unsupported/);
  assert.equal(observedVersion, 93);
  assert.match(corrupt.error, /invalid SQLite header|could not open mission database|not a database|database disk image is malformed/i);
  assert.equal(corruptPreserved, true);
  assert.match(zero.error, /invalid SQLite header/);
  assert.equal(zeroPreserved, true);
  assert.match(oneByteResult.error, /invalid SQLite header/);
  assert.equal(oneBytePreserved, true);
  finish();
});

phaseTest("identity", "pre-claim association observation never mints a missing store id", async () => {
  const sample = fixture();
  const paths = dbPaths(sample.stateDir);
  let freshObserved = false;
  const owner = await openMissionStore({ ...paths, admitWriter: (observation) => {
    if (!observation) return;
    freshObserved = true;
    assert.equal(observation.ownerEpoch, null);
    assert.equal(observation.findManagedMission(sample.root), undefined);
    assert.throws(() => observation.ensureRepositoryIdentity(sample.root), /read-only.*writer reservation/);
  } });
  const mission = owner.createMission({
    repositoryRoot: sample.root, planId: "durable-fixture", planFile: sample.planFile,
    definitionFile: sample.definitionFile, commandId: sample.commandId, admissionReceiptId: sample.receiptId,
  });
  const markerFile = path.join(sample.root, ".git", "pitako", "repository-id");
  const marker = readFileSync(markerFile);
  const foreign = dbPaths(path.join(sample.base, "foreign-state"));
  let callbackError;
  try {
    await assert.rejects(openMissionStore({ ...foreign, admitWriter: (observation) => {
      if (!observation) return;
      assert.equal(observation.ownerEpoch, null);
      assert.deepEqual(observation.ownershipIdentity, { epoch: 0, claimId: "" });
      observation.findManagedMission(sample.root);
    } }), (error) => {
      callbackError = error.message;
      return error.message === "repository marker does not prove this repository association";
    });
    const db = new DatabaseSync(foreign.dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT value FROM store_meta WHERE key = 'store_instance_id'").get(), undefined);
      assert.equal(db.prepare("SELECT value FROM store_meta WHERE key = 'owner_epoch'").get().value, "0");
      assert.equal(db.prepare("SELECT value FROM store_meta WHERE key = 'owner_claim_id'").get().value, "");
      assert.equal(db.prepare("SELECT value FROM store_meta WHERE key = 'owner_acquisition_proof'").get().value, "");
      assert.deepEqual(db.prepare("SELECT * FROM mission_events").all(), []);
      assert.deepEqual(db.prepare("SELECT * FROM missions").all(), []);
    } finally { db.close(); }
    const claimed = await openMissionStore(foreign);
    try {
      assert.equal(claimed.ownerEpoch, 1);
      assert.throws(() => claimed.ensureRepositoryIdentity(sample.root), /repository marker belongs to a different mission store/);
      assert.deepEqual(readFileSync(markerFile), marker);
      assert.equal(owner.verifyRepositoryAssociation(sample.root), mission.repositoryId);
    } finally { claimed.close(); }
  } finally { acknowledgeRetirement(owner, mission.id); owner.close(); }
  const reader = await openMissionStore({ ...paths, readOnly: true });
  try {
    assert.equal(reader.ownerEpoch, null);
    assert.equal(reader.findManagedMission(sample.root).id, mission.id);
    assert.equal(reader.verifyRepositoryAssociation(sample.root), mission.repositoryId);
    assert.throws(() => reader.ensureRepositoryIdentity(sample.root), /read-only.*writer reservation/);
  } finally { reader.close(); }
  const reopened = await openMissionStore({ ...paths, admitWriter: (observation) => {
    if (observation) assert.equal(observation.findManagedMission(sample.root).id, mission.id);
  } });
  try {
    assert.equal(reopened.ownerEpoch, 2);
    assert.equal(reopened.ensureRepositoryIdentity(sample.root), mission.repositoryId);
    assert.equal(freshObserved, true);
    observe("preclaim-association-read-only", {
      callbackError, freshAcquisition: true, ownedAssociationReopen: true,
      foreignMarkerPreserved: true, preclaimStoreIdAbsent: true,
    })();
  } finally { acknowledgeRetirement(reopened, mission.id); reopened.close(); }
});

phaseTest("identity", "rejects copied cross-host and same-path replacement identities", async () => {
  const sample = fixture();
  const { dbPath, objectDir } = dbPaths(sample.stateDir);
  const store = await openMissionStore({ dbPath, objectDir });
  const repositoryId = store.ensureRepositoryIdentity(sample.root);
  const commonDir = execGit(sample.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const markerPath = path.join(commonDir, "pitako", "repository-id");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const copy = path.join(sample.base, "copied");
  mkdirSync(copy);
  git(copy, ["init", "-q", "-b", "main"]);
  const copyCommon = execGit(copy, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  mkdirSync(path.join(copyCommon, "pitako"), { recursive: true });
  writeFileSync(path.join(copyCommon, "pitako", "repository-id"), JSON.stringify({ ...marker, hostId: "e".repeat(32), commonDir: copyCommon }));
  let crossHostError = "";
  try { store.ensureRepositoryIdentity(copy); } catch (error) { crossHostError = String(error); }
  git(sample.root, ["switch", "-c", "identity-drift"]);
  git(sample.root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "drift", "-q"]);
  git(sample.root, ["gc", "--prune=now"]);
  const refDriftIdentity = store.ensureRepositoryIdentity(sample.root);
  const finish = observe("repository-identity-rejections", {
    crossHost: { expected: "rejected", error: crossHostError },
    refAndPackDrift: { expectedRepositoryId: repositoryId, observedRepositoryId: refDriftIdentity, head: git(sample.root, ["rev-parse", "HEAD"]) },
  });
  assert.match(crossHostError, /different host/);
  assert.equal(refDriftIdentity, repositoryId);
  finish();
  store.close();

  const samePath = fixture("pitako-node-same-path-");
  const sameStore = await openMissionStore({ ...dbPaths(samePath.stateDir) });
  sameStore.ensureRepositoryIdentity(samePath.root);
  const sameCommon = execGit(samePath.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const sameMarkerPath = path.join(sameCommon, "pitako", "repository-id");
  const sameMarker = readFileSync(sameMarkerPath);
  const originalCommonInode = statSync(sameCommon, { bigint: true }).ino;
  const originalObjectsInode = statSync(path.join(sameCommon, "objects"), { bigint: true }).ino;
  for (const entry of readdirSync(sameCommon)) rmSync(path.join(sameCommon, entry), { recursive: true, force: true });
  git(samePath.root, ["init", "-q", "-b", "replacement"]);
  const recreatedCommonInode = statSync(sameCommon, { bigint: true }).ino;
  const recreatedObjectsInode = statSync(path.join(sameCommon, "objects"), { bigint: true }).ino;
  mkdirSync(path.dirname(sameMarkerPath), { recursive: true });
  writeFileSync(sameMarkerPath, sameMarker);
  let samePathError = "";
  try { sameStore.ensureRepositoryIdentity(samePath.root); } catch (error) { samePathError = String(error); }

  const alias = path.join(samePath.base, "alias");
  mkdirSync(alias);
  git(alias, ["init", "-q", "-b", "main"]);
  const aliasCommon = execGit(alias, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const aliasState = statSync(aliasCommon, { bigint: true });
  mkdirSync(path.join(aliasCommon, "pitako"), { recursive: true });
  writeFileSync(path.join(aliasCommon, "pitako", "repository-id"), JSON.stringify({
    ...JSON.parse(sameMarker.toString("utf8")),
    commonDir: aliasCommon,
    gitDirectoryId: `${aliasState.dev}:${aliasState.ino}`,
  }));
  let aliasError = "";
  try { sameStore.ensureRepositoryIdentity(alias); } catch (error) { aliasError = String(error); }
  const identityFinish = observe("repository-same-path-and-alias", {
    samePathCopiedMarker: {
      expected: "rejected", error: samePathError, commonInodePreserved: originalCommonInode === recreatedCommonInode,
      originalObjectsInode: String(originalObjectsInode), recreatedObjectsInode: String(recreatedObjectsInode),
    },
    sameHostAlias: { expected: "rejected", error: aliasError },
    markerRepositoryId: JSON.parse(sameMarker.toString("utf8")).repositoryId,
  });
  assert.match(samePathError, /continuity|unproven/i);
  assert.equal(originalCommonInode, recreatedCommonInode);
  assert.match(aliasError, /owner proof/);
  identityFinish();
  sameStore.close();
});

phaseTest("identity", "repository marker survives linked-worktree deletion and store reopen", async () => {
  const sample = fixture();
  const missionId = randomUUID();
  const { dbPath, objectDir } = dbPaths(sample.stateDir);
  const store = await openMissionStore({ dbPath, objectDir });
  const mission = store.createMission({
    repositoryRoot: sample.root,
    planId: "durable-fixture",
    planFile: sample.planFile,
    definitionFile: sample.definitionFile,
    commandId: sample.commandId,
    admissionReceiptId: sample.receiptId,
    missionId,
  });
  const linked = path.join(sample.base, "linked");
  git(sample.root, ["worktree", "add", "-q", "-b", "linked", linked]);
  const linkedRepositoryId = store.ensureRepositoryIdentity(linked);
  git(sample.root, ["worktree", "remove", "--force", linked]);
  acknowledgeRetirement(store, missionId);
  store.close();
  const result = node(["--repository-read", sample.stateDir, sample.root, missionId]);
  const finish = observe("repository-worktree-reopen", {
    linkedRepositoryId,
    expectedRepositoryId: mission.repositoryId,
    reopenedRepositoryId: result.repositoryId,
    reopenedPlanHash: result.planHash,
    expectedPlanHash: mission.snapshot.planHash,
  });
  assert.equal(linkedRepositoryId, mission.repositoryId);
  assert.equal(result.repositoryId, mission.repositoryId);
  assert.equal(result.planHash, mission.snapshot.planHash);
  finish();
});

phaseTest("authority", "legacy authority APIs reject any generated-ledger format key in Node", async () => {
  const sample = fixture("pitako-node-forged-ledger-");
  const plan = readFrozenPlan("durable-fixture", sample.root).meta;
  const file = ledgerFile(plan.id, sample.root);
  mkdirSync(path.dirname(file), { recursive: true });
  const store = await openMissionStore(dbPaths(sample.stateDir));
  const legacy = [
    "---", `plan_id: ${plan.id}`, `revision: ${plan.revision}`, `hash: ${plan.hash}`,
    "status: completed", "---", "", "<!-- pitako-team-holds:v1 -->", "[]", "<!-- /pitako-team-holds -->", "",
  ].join("\n");
  const legacyPreview = store.previewLegacyImport({ planId: plan.id, planBytes: sample.planBytes, ledgerBytes: Buffer.from(legacy) });
  writeFileSync(file, legacy);
  const legacyBinding = parseLedgerBinding(legacy);
  const legacyStatus = parseLedgerStatus(legacy);
  const legacyHolds = ledgerTeamHolds(legacy);
  const legacyExecution = openExecutionPlan(plan.id, sample.root).binding;
  const formats = [
    'format: " mission-ledger-v1 "\u200b',
    'format: "mission-ledger-v\\u0031"',
    'format: "mission-\\x6cedger-v1"',
    "format: &id mission-ledger-v1",
    `format: mission-ledger-v1\u200b`,
    "format: |\n  mission-ledger-v1",
    "\ufeffF\u200bORMAT : unrelated",
    '"format": unrelated',
    "format: unrelated",
  ];
  const cases = formats.map((format) => {
    const forged = [
      "---", format, `plan_id: ${plan.id}`, `revision: ${plan.revision}`, `hash: ${plan.hash}`,
      "status: completed", "---", "", "<!-- pitako-team-holds:v1 -->", "[]", "<!-- /pitako-team-holds -->", "",
    ].join("\n");
    writeFileSync(file, forged);
    const rejected = {};
    for (const [name, parse] of Object.entries({
      binding: parseLedgerBinding,
      status: parseLedgerStatus,
      holds: ledgerTeamHolds,
      execution: () => openExecutionPlan(plan.id, sample.root),
    })) {
      try { parse(forged); rejected[name] = "accepted"; }
      catch (error) { rejected[name] = String(error); }
    }
    const preview = store.previewLegacyImport({ planId: plan.id, planBytes: sample.planBytes, ledgerBytes: Buffer.from(forged) });
    return { format, rejected, preview: { generatedLedger: preview.generatedLedger, holdsKnown: preview.holdsKnown } };
  });
  store.close();
  const finish = observe("forged-generated-ledger", {
    validLegacy: { binding: legacyBinding, status: legacyStatus, holds: legacyHolds, execution: legacyExecution,
      preview: { generatedLedger: legacyPreview.generatedLedger, holdsKnown: legacyPreview.holdsKnown } },
    cases,
  });
  assert.equal(legacyStatus, "completed");
  assert.equal(legacyHolds.length, 0);
  assert.equal(legacyExecution.planId, plan.id);
  assert.equal(legacyPreview.generatedLedger, false);
  assert.equal(legacyPreview.holdsKnown, true);
  for (const item of cases) {
    for (const name of ["binding", "status", "holds", "execution"]) assert.match(item.rejected[name], /generated mission ledger/);
    assert.deepEqual(item.preview, { generatedLedger: true, holdsKnown: false });
  }
  finish();
});

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}

async function command(args) {
  const [mode, ...values] = args;
  if (mode === "--recovery-crash-writer") {
    const [root, stateDir, planFile, definitionFile, commandId, receiptId, missionId, candidateParent] = values;
    const store = await openMissionStore(dbPaths(stateDir));
    const mission = store.createMission({ repositoryRoot: root, planId: "durable-fixture", planFile, definitionFile, commandId, admissionReceiptId: receiptId, missionId });
    const attemptId = randomUUID();
    const workspace = createMissionWorkspace({
      missionId, attemptId, sourceRoot: root, storeRoot: store.storageRoot, candidateParent,
      allowedPaths: store.inspectMission(missionId).definition.authority.allowedPaths,
    });
    const base = filterWorkspaceImage({ ...captureWorkspaceImage(workspace.candidateRoot), manifest: workspace.manifest }, workspace.allowedPaths);
    const sealed = sealWorkspaceImage(base);
    const ownerEpoch = store.ownerEpoch;
    if (ownerEpoch === null) throw new Error("crash writer failed to acquire owner epoch");
    const candidateRegistration = registerCandidateWorkspace(workspace, {
      repositoryId: store.inspectMission(missionId).repositoryId,
      owner: currentProcessIdentity(store.runtimeId, ownerEpoch),
    });
    const binding = {
      missionId, revision: mission.revision, unitId: "snapshot", roundId: "main", memberId: "solo", attemptId,
      attemptNo: 1, ownerEpoch, candidate: "managed", candidateId: workspace.candidateId,
      candidateRoot: workspace.candidateRoot, candidateRegistration, workspaceManifestHash: workspace.manifest.hash,
      inputManifestHash: workspace.manifest.hash, briefHash: "a".repeat(64), rolePolicyHash: "b".repeat(64),
    };
    store.appendTransition(missionId, mission.version, { events: [
      { revision: mission.revision, kind: "attempt.reserved", causalId: randomUUID(), unitId: "snapshot", attemptId,
        payload: { attemptId, binding, unitId: "snapshot", roundId: "main", memberId: "solo", attemptNo: 1 } },
      { revision: mission.revision, kind: "workspace.candidate.registered", causalId: randomUUID(), unitId: "snapshot", attemptId,
        payload: { ...candidateRegistration, locationHistory: [candidateRegistration.root] } },
      { revision: mission.revision, kind: "attempt.started", causalId: randomUUID(), unitId: "snapshot", attemptId,
        payload: { attemptId, unitId: "snapshot" } },
      { revision: mission.revision, kind: "workspace.snapshot.sealed", causalId: randomUUID(), unitId: "snapshot", attemptId,
        payload: { attemptId, phase: "base", imageHash: sealed.imageHash, manifestHash: workspace.manifest.hash,
          manifest: workspace.manifest, candidateRoot: workspace.candidateRoot,
          candidateIdentity: workspace.candidateIdentity, candidateGitIdentity: workspace.candidateGitIdentity } },
    ], artifacts: sealed.artifacts });
    writeFileSync(path.join(workspace.candidateRoot, "src", "app.ts"), "export const mission = 'partial mission write';\n");
    const inspection = store.inspectMission(missionId);
    store.appendTransition(missionId, inspection.version, { events: [{
      revision: mission.revision, kind: "attempt.interrupted", causalId: randomUUID(), unitId: "snapshot", attemptId,
      payload: { attemptId, unitId: "snapshot", reason: "hard child process exit after partial write" },
    }] });
    writeSync(1, JSON.stringify({ pid: process.pid, missionId, attemptId, candidateRoot: workspace.candidateRoot }) + "\n");
    process.exit(86);
  } else if (mode === "--writer") {
    const [root, stateDir, planFile, definitionFile, commandId, receiptId, missionId, cut] = values;
    const store = await openMissionStore({ ...dbPaths(stateDir), onDurabilityBoundary(boundary) { if (boundary === cut) process.exit(86); } });
    const record = store.createMission({ repositoryRoot: root, planId: "durable-fixture", planFile, definitionFile, commandId, admissionReceiptId: receiptId, missionId });
    store.close();
    console.log(JSON.stringify({ missionId: record.id, repositoryId: record.repositoryId }));
  } else if (mode === "--hold-owner") {
    const [root, stateDir, planFile, definitionFile, commandId, receiptId, missionId] = values;
    const store = await openMissionStore(dbPaths(stateDir));
    const mission = store.createMission({ repositoryRoot: root, planId: "durable-fixture", planFile, definitionFile, commandId, admissionReceiptId: receiptId, missionId });
    console.log(JSON.stringify({ pid: process.pid, missionId: mission.id }));
    await new Promise((resolve) => process.stdin.once("data", resolve));
    acknowledgeRetirement(store, mission.id);
    store.close();
    process.stdin.pause();
    console.log(JSON.stringify({ released: true }));
  } else if (mode === "--orphan-owner") {
    const [root, stateDir, planFile, definitionFile, commandId, receiptId, missionId] = values;
    const store = await openMissionStore(dbPaths(stateDir));
    const mission = store.createMission({ repositoryRoot: root, planId: "durable-fixture", planFile, definitionFile, commandId, admissionReceiptId: receiptId, missionId });
    writeSync(1, JSON.stringify({ pid: process.pid, missionId: mission.id }) + "\n");
    process.exit(86);
  } else if (mode === "--owner-probe") {
    const [stateDir, missionId, reservationId, exportDir] = values;
    const store = await openMissionStore(dbPaths(stateDir));
    const mission = store.inspectMission(missionId);
    const exported = exportDir ? await store.exportMission(missionId, exportDir) : undefined;
    const exportedMissionId = exported ? JSON.parse(readFileSync(exported.manifestPath, "utf8")).missionId : undefined;
    let writeError = "";
    let reservation;
    try { reservation = store.reserve(missionId, { id: reservationId, revision: 1, resource: "provider-requests", amount: 1 }, mission.version); }
    catch (error) { writeError = String(error); }
    const ownerEpoch = store.ownerEpoch;
    store.close();
    console.log(JSON.stringify({ pid: process.pid, missionId: mission.id, version: mission.version, writeError, exportedMissionId, ownerEpoch, reservationId: reservation?.id ?? null }));
  } else if (mode === "--reader") {
    const [stateDir, missionId, exportDir] = values;
    const store = await openMissionStore(dbPaths(stateDir));
    const inspection = store.inspectMission(missionId);
    const exported = await store.exportMission(missionId, exportDir);
    store.close();
    console.log(JSON.stringify({ pid: process.pid, missionId, planHash: inspection.snapshot.planHash, definitionHash: inspection.snapshot.definitionHash,
      planBase64: inspection.planBytes.toString("base64"), definitionBase64: inspection.definitionBytes.toString("base64"), eventSeq: exported.eventSeq }));
  } else if (mode === "--probe") {
    const [stateDir, missionId] = values;
    const store = await openMissionStore(dbPaths(stateDir));
    let found = false;
    try { store.inspectMission(missionId); found = true; } catch (error) { if (!/mission not found/.test(String(error))) throw error; }
    store.close();
    const { dbPath, objectDir } = dbPaths(stateDir);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const refs = db.prepare("SELECT plan_hash AS hash FROM revisions WHERE mission_id = ? UNION SELECT definition_hash AS hash FROM revisions WHERE mission_id = ?").all(missionId, missionId);
    db.close();
    const referenceCount = refs.length;
    const referenced = new Set(refs.map(({ hash }) => hash));
    const invalidObjectCount = refs.filter(({ hash }) => {
      const file = path.join(objectDir, hash.slice(0, 2), hash);
      return !existsSync(file) || createHash("sha256").update(readFileSync(file)).digest("hex") !== hash;
    }).length;
    const unreferencedObjectCount = listFiles(objectDir).filter((file) => !referenced.has(path.basename(file))).length;
    console.log(JSON.stringify({ found, referenceCount, invalidObjectCount, unreferencedObjectCount }));
  } else if (mode === "--repeat") {
    const [stateDir, missionId, reservationId] = values;
    const store = await openMissionStore(dbPaths(stateDir));
    const reservation = { id: reservationId, revision: 1, resource: "provider-requests", amount: 2 };
    const first = store.reserve(missionId, reservation, 1);
    const second = store.reserve(missionId, reservation, 1);
    const result = { first, second, version: store.inspectMission(missionId).version, replay: store.replayMission(missionId).projectionHash };
    store.close();
    console.log(JSON.stringify(result));
  } else if (mode === "--schema") {
    const [directory, name] = values;
    const dbPath = path.join(directory, name, "missions.db");
    try { await openMissionStore({ dbPath, objectDir: path.join(directory, name, "objects") }); console.log(JSON.stringify({ error: "unexpected open" })); }
    catch (error) { console.log(JSON.stringify({ error: String(error) })); }
  } else if (mode === "--repository-read") {
    const [stateDir, root, missionId] = values;
    const store = await openMissionStore(dbPaths(stateDir));
    const repositoryId = store.ensureRepositoryIdentity(root);
    const inspection = store.inspectMission(missionId);
    store.close();
    console.log(JSON.stringify({ repositoryId, planHash: inspection.snapshot.planHash }));
  } else {
    throw new Error(`unknown command ${mode}`);
  }
}

if (cliMode) {
  command(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

if (!cliMode) test.after(() => {
  const observationPath = process.env.MISSION_DURABILITY_OBSERVATION_PATH;
  if (observationPath) {
    mkdirSync(path.dirname(observationPath), { recursive: true });
    writeFileSync(observationPath, JSON.stringify(observations, null, 2) + "\n");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
