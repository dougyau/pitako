import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { admitMissionChange, nextPlanBytes } from "../extensions/mission/admission.ts";
import { applyConditionalMissionPatch, missionHasUnresolvedEffects, reconcileMission, recoveryDiagnosisBrief, sealWorkspaceImage, type RecoveryOverlapAnswer, type RecoveryOverlapRequest } from "../extensions/mission/reconcile.ts";
import { MissionEffects } from "../extensions/mission/effects.ts";
import { missionCompletionBlockers } from "../extensions/mission/completion.ts";
import { auditCompletionEvidence } from "../extensions/mission/completion-evidence.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import { MissionEngine, missionAssessmentToolIdentity, missionRuntimeIdentity } from "../extensions/mission/engine.ts";
import { captureWorkspaceImage, createMissionWorkspace, currentProcessIdentity, filterWorkspaceImage, preflightContainment, processNamespaceId, processesInNamespace, registerCandidateWorkspace } from "../extensions/mission/workspace.ts";
import type { MissionEventDraft } from "../extensions/mission/store.ts";
import { fixtureCommandTime, createMissionFixture, missionInput, openFixtureStore, operatorChangeReceipt, type MissionFixture } from "./mission-fixtures.ts";

const fixtures: MissionFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture.base, { recursive: true, force: true });
});

function permitExternalGrant(sample: MissionFixture, grantId: string): void {
  const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
  definition.authority.externalEffects = [...new Set([...definition.authority.externalEffects, grantId])];
  sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
  writeFileSync(sample.definitionFile, sample.definitionBytes);
}

function fixture(): MissionFixture {
  const value = createMissionFixture("pitako-recovery-");
  fixtures.push(value);
  mkdirSync(path.join(value.root, "src"));
  writeFileSync(path.join(value.root, "src", "app.ts"), "export const mission = 'base';\n");
  writeFileSync(path.join(value.root, "src", "user.ts"), "export const user = 'base';\n");
  execFileSync("git", ["add", "src/app.ts", "src/user.ts"], { cwd: value.root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture source", "-q"], { cwd: value.root });
  const definition = JSON.parse(value.definitionBytes.toString("utf8"));
  definition.authority.allowedPaths = ["src/**"];
  definition.authority.operations = ["write", "bash"];
  definition.units[0].inputs = ["src/**"];
  value.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
  writeFileSync(value.definitionFile, value.definitionBytes);
  return value;
}

async function createInterruptedAttempt(sample: MissionFixture, containedWrite = false, interruptedClose = false) {
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const attemptId = randomUUID();
  const workspace = await createMissionWorkspace({
    missionId: mission.id, attemptId, sourceRoot: sample.root, storeRoot: store.storageRoot,
    candidateParent: path.join(sample.base, "candidates"), allowedPaths: ["src/**"],
  });
  const epoch = store.ownerEpoch;
  if (epoch === null) throw new Error("fixture did not acquire its writer reservation");
  const base = filterWorkspaceImage({ ...captureWorkspaceImage(workspace.candidateRoot), manifest: workspace.manifest }, workspace.allowedPaths);
  const sealed = sealWorkspaceImage(base);
  const candidateRegistration = registerCandidateWorkspace(workspace, {
    repositoryId: store.inspectMission(mission.id).repositoryId, owner: currentProcessIdentity(store.runtimeId, epoch),
  });
  const binding = {
    missionId: mission.id, revision: mission.revision, unitId: "snapshot", roundId: "main", memberId: "solo",
    attemptId, attemptNo: 1, ownerEpoch: epoch, candidate: "managed", candidateId: workspace.candidateId,
    candidateRoot: workspace.candidateRoot, workspaceManifestHash: workspace.manifest.hash,
    candidateRegistration,
    inputManifestHash: workspace.manifest.hash, briefHash: "a".repeat(64), rolePolicyHash: "b".repeat(64),
  };
  const events: MissionEventDraft[] = [
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
    { revision: mission.revision, kind: "workspace.snapshot.sealed", causalId: randomUUID(), unitId: "snapshot", attemptId,
      payload: { attemptId, phase: "observed", purpose: "execution-start", imageHash: sealed.imageHash, manifestHash: base.manifest.hash } },
  ];
  store.appendTransition(mission.id, mission.version, { events, artifacts: sealed.artifacts });
  if (containedWrite) {
    await preflightContainment(workspace);
    const effects = new MissionEffects({ store, workspace, missionId: mission.id, revision: mission.revision, unitId: "snapshot",
      attemptId, runtimeId: store.runtimeId, ownerEpoch: epoch, allowedOperations: ["write", "bash"], commandTime: fixtureCommandTime() });
    const result = await effects.invoke("write", { path: "src/app.ts", content: "export const mission = 'partial mission write';\n" });
    if (result.status !== "completed") throw new Error(`contained fixture write failed: ${result.status}: ${result.reason ?? ""}`);
    await effects.shutdown();
  } else {
    writeFileSync(path.join(workspace.candidateRoot, "src", "app.ts"), "export const mission = 'partial mission write';\n");
  }
  let pauseEventId: string | undefined;
  if (interruptedClose) {
    const current = store.inspectMission(mission.id);
    [pauseEventId] = store.appendTransition(mission.id, current.version, { events: [{
      revision: mission.revision, kind: "mission.paused", causalId: randomUUID(),
      payload: {
        controlOrigin: "lifecycle", resumeAfterClose: true,
        ownerEpoch: epoch, runtimeId: store.runtimeId, owner: currentProcessIdentity(store.runtimeId, epoch),
        stoppedAttempts: [{ attemptId, bindingHash: createHash("sha256").update(JSON.stringify(binding)).digest("hex") }],
      },
    }] }).map(({ eventId }) => eventId);
  }
  const current = store.inspectMission(mission.id);
  store.appendTransition(mission.id, current.version, { events: [{
    revision: mission.revision, kind: "attempt.interrupted", causalId: randomUUID(), unitId: "snapshot", attemptId,
    payload: { attemptId, unitId: "snapshot", reason: "fixture crash after partial write" },
  }] });
  const interrupted = store.inspectMission(mission.id);
  store.appendTransition(mission.id, interrupted.version, { events: [{
    revision: mission.revision, kind: "mission.owner.released", causalId: randomUUID(),
    payload: { owner: currentProcessIdentity(store.runtimeId, epoch), reason: "fixture process retirement", effectsQuiescent: true, resumablePause: true, interruptedAttempts: [attemptId], ...(pauseEventId ? { pauseEventId } : {}) },
  }] });
  const effectId = store.inspectMission(mission.id).events.find((event) => event.kind === "effect.intent" && event.attemptId === attemptId)?.effectId ?? null;
  store.close();
  return { missionId: mission.id, attemptId, candidateRoot: workspace.candidateRoot, effectId };
}

test("clean recovered continuation discharges actual effects without erasing the old writer, including quiescent release", async () => {
  const sample = fixture();
  const definition = JSON.parse(sample.definitionBytes.toString());
  definition.budget.artifactBytes = 30_000_000;
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const interrupted = await createInterruptedAttempt(sample);
  const store = await openFixtureStore(sample);
  const engine = new MissionEngine({ store, missionId: interrupted.missionId,
    sessionsDirectory: path.join(sample.base, "sessions"),
    managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
    runRole: async ({ unit }, durable) => {
      const receipt = await durable.effects!.invoke("bash", { command: "printf CHECK_OK" });
      expect(receipt.status).toBe("completed");
      return { instanceId: randomUUID(), role: unit.role, status: "completed",
        model: { selectedModel: "fixture/local" }, result: "Observed recovered candidate" };
    } });
  let liveEffectObserved = false;
  const append = store.appendTransition.bind(store);
  store.appendTransition = (id, version, transition) => {
    const result = append(id, version, transition);
    const intent = transition.events.find((row) => row.kind === "effect.intent");
    if (intent) {
      expect(missionCompletionBlockers(store.inspectMission(id), store)).toContain(`effect:${intent.effectId}`);
      liveEffectObserved = true;
    }
    return result;
  };
  try {
    await engine.start(); await engine.waitForIdle();
    const inspection = store.inspectMission(interrupted.missionId);
    const row = inspection.events.find((event) => event.kind === "mission.recovery.recorded")!;
    const report = JSON.parse(store.readArtifact(String(row.payload.reportHash)).toString());
    recordT4Case("clean-report-completion-audit", { report, events: inspection.events,
      exposure: auditCompletionEvidence(inspection.events, store), blockers: missionCompletionBlockers(inspection, store) });
    expect(report.status).toBe("resumed");
    expect(report.blockers).toEqual([]); expect(report.disposition.causes).toEqual([]);
    expect(liveEffectObserved).toBe(true);
    expect(auditCompletionEvidence(inspection.events, store).effects).toEqual([]);
    expect(missionCompletionBlockers(inspection, store)).not.toContain("recovery:unresolved");
    expect(missionCompletionBlockers(inspection, store)).toContain(`writer:${interrupted.attemptId}`);
    const originalPlan = readFileSync(sample.planFile);
    writeFileSync(sample.planFile, Buffer.concat([originalPlan, Buffer.from("\nstale plan\n")]));
    expect(missionCompletionBlockers(inspection, store)).toContain("recovery:unresolved");
    writeFileSync(sample.planFile, originalPlan);
    await engine.retireForShutdown("quit");
    const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try {
      const reopened = reader.inspectMission(interrupted.missionId);
      recordT4Case("clean-report-quiescent-reopen", { events: reopened.events,
        exposure: auditCompletionEvidence(reopened.events, reader), blockers: missionCompletionBlockers(reopened, reader) });
      expect(reopened.events.at(-1)?.kind).toBe("mission.owner.released");
      expect(reopened.events.at(-1)?.payload.effectsQuiescent).toBe(true);
      expect(missionCompletionBlockers(reopened, reader)).not.toContain("recovery:unresolved");
      expect(missionCompletionBlockers(reopened, reader)).toContain(`writer:${interrupted.attemptId}`);
    } finally { reader.close(); }
  } finally { await engine.retireForShutdown("quit"); store.close(); }
}, 30_000);

async function crashUnreceiptedWrite(sample: MissionFixture, content: string) {
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const epoch = store.ownerEpoch;
  if (epoch === null) throw new Error("fixture did not acquire its writer reservation");
  const inspection = store.inspectMission(mission.id);
  store.appendTransition(mission.id, inspection.version, { events: [{
    revision: inspection.revision, kind: "mission.owner.released", causalId: randomUUID(),
    payload: { owner: currentProcessIdentity(store.runtimeId, epoch), reason: "crash fixture setup", effectsQuiescent: true, resumablePause: false, interruptedAttempts: [] },
  }] });
  const candidateParent = path.join(sample.base, "candidates");
  const eventLog = path.join(sample.base, "effect-events.jsonl");
  const metadataFile = path.join(sample.base, "candidate.json");
  store.close();
  const node = execFileSync("/bin/sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
  const child = spawn(node, [path.resolve("tests/fixtures/mission-effect-crash-child.mjs")], {
    cwd: process.cwd(), stdio: "ignore",
    env: {
      ...process.env, T3_SOURCE: sample.root, T3_STORE: path.join(sample.stateDir, "pitako"),
      T3_CANDIDATES: candidateParent, T3_DB: sample.dbPath, T3_OBJECTS: sample.objectDir,
      T3_MISSION: mission.id, T3_ATTEMPT: randomUUID(), T3_LOG: eventLog, T3_META: metadataFile,
      T3_CRASH_KIND: "effect.receipt", T3_OPERATION: "write", T3_REGISTER_ATTEMPT: "true",
      T3_EFFECT_INPUT: JSON.stringify({ path: "src/app.ts", content }),
    },
  });
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  if (closed.signal !== "SIGKILL" || !existsSync(metadataFile) || !existsSync(eventLog)) {
    throw new Error(`crash fixture failed before missing receipt boundary: ${JSON.stringify(closed)}`);
  }
  const { candidateRoot, attemptId } = JSON.parse(readFileSync(metadataFile, "utf8")) as { candidateRoot: string; attemptId: string };
  const durableEvents = readFileSync(eventLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; payload: Record<string, any> });
  if (durableEvents.some(({ kind }) => kind === "effect.receipt")) throw new Error("crash fixture unexpectedly persisted effect receipt");
  const effectId = String(durableEvents.find(({ kind }) => kind === "effect.intent")?.payload.effectId);
  if (!attemptId || !effectId) throw new Error("crash fixture omitted its bound attempt or effect");
  return { missionId: mission.id, attemptId, effectId, candidateRoot, candidateParent, store: await openFixtureStore(sample), durableEvents };
}

test("recovered source admission keeps binding checks cheap and rejects a fresh provider and effect after drift", async () => {
  const sample = fixture();
  const definition = JSON.parse(sample.definitionBytes.toString());
  definition.budget.artifactBytes = 30_000_000;
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const interrupted = await createInterruptedAttempt(sample);
  const store = await openFixtureStore(sample);
  let checked = false;
  const engine = new MissionEngine({ store, missionId: interrupted.missionId,
    sessionsDirectory: path.join(sample.base, "sessions"),
    managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
    runRole: async ({ unit, binding }, durable) => {
      const requestId = randomUUID();
      const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
      await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens: 2, outputTokens: 1, ticket });
      const receipt = await durable.effects!.invoke("bash", { command: "printf CURRENT_SOURCE" });
      expect(receipt.status).toBe("completed");
      writeFileSync(path.join(sample.root, "src", "user.ts"), "changed after independent effect frontier\n");
      // Projection refresh is not physical authorization; only the next owned frontier reads source.
      expect(engine.snapshot().attempts[binding.attemptId]?.status).toBe("running");
      const host = engine as unknown as { attemptAdmitted(attempt: typeof binding): boolean };
      expect(host.attemptAdmitted(binding)).toBe(true);
      await expect(durable.onProviderDispatch({ requestId: randomUUID(), provider: "fixture", model: "local" }))
        .rejects.toThrow("physical source or inputs changed");
      await expect(durable.effects!.invoke("bash", { command: "touch src/MUST_NOT_EXIST" }))
        .rejects.toThrow("physical source or inputs changed");
      expect(existsSync(path.join(binding.candidateRoot!, "src", "MUST_NOT_EXIST"))).toBe(false);
      checked = true;
      return { instanceId: randomUUID(), role: unit.role, status: "failed" as const,
        model: { selectedModel: "fixture/local" }, result: "source drift observed and denied" };
    },
  });
  try {
    await engine.start(); await engine.waitForIdle();
    expect(checked).toBe(true);
    const events = store.inspectMission(interrupted.missionId).events;
    expect(events.filter(event => event.kind === "provider.request.dispatched")).toHaveLength(1);
    expect(events.filter(event => event.kind === "effect.intent")).toHaveLength(1);
  } finally { await engine.retireForShutdown("quit"); store.close(); }
}, 30_000);

describe("durable mission reconciliation", () => {
  test.each(["none", "interrupted", "failed-recovery"] as const)(
    "MissionEngine restart discovers a relocated partial candidate, close %s", async (close) => {
    const interruptedClose = close !== "none";
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.artifactBytes = 3 * 1024 * 1024;
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const interrupted = await createInterruptedAttempt(sample, false, interruptedClose);
    const candidateArena = path.join(sample.base, "candidates");
    const relocatedRoot = path.join(candidateArena, "renamed-after-crash");
    renameSync(interrupted.candidateRoot, relocatedRoot);
    const store = await openFixtureStore(sample);
    if (close === "failed-recovery") {
      const sourceFile = path.join(sample.root, "src", "app.ts");
      const sourceBytes = readFileSync(sourceFile);
      try {
        writeFileSync(sourceFile, "export const mission = 'conflicting source edit';\n");
        const firstRecovery = await reconcileMission({
          store, missionId: interrupted.missionId, sourceRoot: sample.root,
          planFile: sample.planFile, candidateParent: candidateArena, trigger: "engine-restart",
        });
        expect(firstRecovery.status).toBe("blocked");
      } finally {
        writeFileSync(sourceFile, sourceBytes);
      }
      expect(store.inspectMission(interrupted.missionId).events.some((event) =>
        event.kind === "attempt.settled" && event.attemptId === interrupted.attemptId &&
        event.payload.recoveryDisposition === "interrupted-without-worker-result",
      )).toBe(true);
    }
    let checkedCandidate = "";
    let checkStatus = "";
    let checkOutput = "";
    const engine = new MissionEngine({
      store, missionId: interrupted.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: candidateArena },
      runRole: async (_input, durable) => {
        checkedCandidate = durable.cwd ?? "";
        const check = await durable.effects!.invoke("bash", {
          command: "grep -q 'partial mission write' src/app.ts && printf RECOVERED",
        });
        checkStatus = check.status;
        checkOutput = check.stdout ?? "";
        return {
          instanceId: randomUUID(), role: "developer", status: check.status === "completed" ? "completed" : "failed",
          model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
          result: check.stdout ?? "",
        };
      },
      assessPredicate: ({ resultArtifact }) => ({
        verdict: checkStatus === "completed" && resultArtifact.toString("utf8") === "RECOVERED" ? "pass" : "fail",
        method: "bash grep inspected recovered candidate bytes",
      }),
    });
    try {
      if (interruptedClose) await engine.control("resume", { id: "fixture-resume", text: "/mission resume durable-fixture" });
      else engine.start();
      await engine.waitForIdle();
      const recoveryEvents = store.inspectMission(interrupted.missionId).events;
      const blockers = recoveryEvents.filter((event) =>
        ["mission.blocked", "mission.recovery.recorded"].includes(event.kind),
      ).map(({ payload }) => ({ reason: payload.reason, status: payload.status, blockers: payload.blockers }));
      expect(checkedCandidate).not.toBe(relocatedRoot);
      expect(checkedCandidate.startsWith(`${candidateArena}${path.sep}`), JSON.stringify(blockers)).toBe(true);
      expect(readFileText(path.join(checkedCandidate, "src", "app.ts"))).toContain("partial mission write");
      expect(readFileText(path.join(relocatedRoot, "src", "app.ts"))).toContain("partial mission write");
      expect(engine.snapshot().units.snapshot?.status).toBe("accepted");
      if (close === "failed-recovery") {
        const oldSettlements = recoveryEvents.filter((event) =>
          event.kind === "attempt.settled" && event.attemptId === interrupted.attemptId);
        expect(oldSettlements).toHaveLength(1);
        expect(oldSettlements[0]!.payload.recoveryDisposition).toBe("interrupted-without-worker-result");
        expect(missionCompletionBlockers(store.inspectMission(interrupted.missionId), store))
          .toContain(`writer:${interrupted.attemptId}`);
      }
      const recovery = recoveryEvents.find((event) => event.kind === "mission.recovery.recorded");
      expect(recovery).toBeDefined();
      const recoveryReport = JSON.parse(store.readArtifact(String(recovery!.payload.reportHash)).toString("utf8"));
      const relocation = recoveryEvents.find((event) => event.kind === "workspace.candidate.relocated" && event.attemptId === interrupted.attemptId);
      recordT4Case(`engine-relocated-${interrupted.missionId}`, {
        candidateRelocated: relocation?.payload.toRoot === relocatedRoot,
        actionReport: recoveryReport,
        exitReport: {
          checkStatus, checkOutput,
          preservedPartial: readFileText(path.join(checkedCandidate, "src", "app.ts")).includes("partial mission write"),
          unitAccepted: engine.snapshot().units.snapshot?.status === "accepted",
        },
      });
    } finally {
      await engine.close();
      store.close();
    }
  }, 30_000);

  test.each(["applied", "partial"] as const)("MissionEngine recovers renamed missing-receipt %s image without candidate hints", async (mode) => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.artifactBytes = 3 * 1024 * 1024;
    definition.budget.roleLaunches = 4;
    definition.units[0].retryLimit = 1;
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const original = await crashUnreceiptedWrite(sample, "export const mission = 'partial mission write';\n");
    const relocatedRoot = path.join(original.candidateParent, `renamed-${mode}`);
    renameSync(original.candidateRoot, relocatedRoot);
    if (mode === "partial") writeFileSync(path.join(relocatedRoot, "src", "app.ts"), "export const mission = 'damaged partial';\n");
    const registered = original.durableEvents.find(({ kind }) => kind === "effect.process.registered")?.payload.identity;
    expect(registered).toBeDefined();
    expect(processesInNamespace(String(registered.pidNamespace))).toHaveLength(0);
    const runs: Array<{ mode?: string; root: string; readOnly: boolean }> = [];
    const engine = new MissionEngine({
      store: original.store, missionId: original.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: original.candidateParent },
      runRole: async (input, durable) => {
        runs.push({ mode: input.binding.recoveryMode, root: durable.cwd ?? "", readOnly: durable.readOnly });
        if (input.binding.recoveryMode === "repair") {
          await durable.effects!.invoke("write", { path: "src/app.ts", content: "export const mission = 'partial mission write';\n" });
        }
        const check = await durable.effects!.invoke("bash", {
          command: "grep -q 'partial mission write' src/app.ts && printf RECOVERED || printf NEEDS_REPAIR",
        });
        return { instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: check.stdout ?? "" };
      },
      assessPredicate: ({ resultArtifact }) => ({
        verdict: resultArtifact.toString("utf8").includes("RECOVERED") ? "pass" : "fail",
        method: "read-only command checks exact recovered candidate content",
      }),
    });
    engine.start();
    await engine.waitForIdle();
    const inspection = original.store.inspectMission(original.missionId);
    const recoveryEvent = inspection.events.find((event) => event.kind === "mission.recovery.recorded");
    const report = JSON.parse(original.store.readArtifact(String(recoveryEvent!.payload.reportHash)).toString("utf8"));
    expect(report.effects).toEqual([expect.objectContaining({ effectId: original.effectId, disposition: mode })]);
    expect(inspection.events.find((event) => event.kind === "workspace.candidate.relocated" && event.attemptId === original.attemptId)?.payload.toRoot).toBe(relocatedRoot);
    expect(runs.map(({ mode: attemptMode }) => attemptMode)).toEqual(mode === "applied" ? ["verify"] : ["verify", "repair"]);
    expect(runs.every(({ root }) => root !== relocatedRoot)).toBe(true);
    expect(inspection.events.filter((event) => event.kind === "effect.intent" && event.attemptId === original.attemptId)).toHaveLength(1);
    expect(engine.snapshot().units.snapshot?.status).toBe("accepted");
    expect(readFileText(path.join(runs.at(-1)!.root, "src", "app.ts"))).toContain("partial mission write");
    recordT4Case(`engine-renamed-missing-receipt-${mode}-${original.missionId}`, {
      renamedRoot: relocatedRoot,
      actionReport: report,
      exitReport: {
        effectDisposition: report.effects[0]?.disposition,
        oldCandidateWasNotReused: runs.every(({ root }) => root !== relocatedRoot),
        oldCandidateNamespaceQuiescent: processesInNamespace(String(registered.pidNamespace)).length === 0,
        originalWriteNotRepeated: inspection.events.filter((event) => event.kind === "effect.intent" && event.attemptId === original.attemptId).length === 1,
        attempts: runs, accepted: engine.snapshot().units.snapshot?.status === "accepted",
      },
    });
    await engine.close();
    original.store.close();
  }, 60_000);

  test("does not recover a missing candidate from its execution-start seal", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.artifactBytes = 3 * 1024 * 1024;
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const interrupted = await createInterruptedAttempt(sample);
    const outsideRoot = path.join(sample.base, "unregistered-candidate-location");
    renameSync(interrupted.candidateRoot, outsideRoot);
    const store = await openFixtureStore(sample);
    let workerRuns = 0;
    const engine = new MissionEngine({
      store, missionId: interrupted.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "recovered-candidates") },
      runRole: async () => {
        workerRuns += 1;
        return { instanceId: "unsafe-retry", role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "must not run" };
      },
    });
    engine.start();
    await engine.waitForIdle();
    const reportEvent = [...store.inspectMission(interrupted.missionId).events].reverse().find((event) => event.kind === "mission.recovery.recorded");
    const report = reportEvent ? JSON.parse(store.readArtifact(String(reportEvent.payload.reportHash)).toString("utf8")) : null;
    expect(workerRuns).toBe(0);
    expect(report?.blockers.some((reason: string) => reason.includes("candidate is missing"))).toBe(true);
    expect(engine.snapshot().units.snapshot?.status).toBe("blocked");
    expect(report?.candidate.restored).toBe(false);
    const outsideCandidatePreserved = readFileText(path.join(outsideRoot, "src", "app.ts")).includes("partial mission write");
    expect(outsideCandidatePreserved).toBe(true);
    recordT4Case(`candidate-outside-arena-${interrupted.missionId}`, {
      actionReport: report,
      exitReport: { workerRuns, unitStatus: engine.snapshot().units.snapshot?.status, outsideCandidatePreserved },
    });
    await engine.retireForShutdown("missing candidate test complete");
    store.close();
  });

  test("keeps unbound no-receipt effects unknown and preserves their candidate bytes without retry", async () => {
    const sample = fixture();
    const interrupted = await createInterruptedAttempt(sample);
    const store = await openFixtureStore(sample);
    const effectId = randomUUID();
    const inspection = store.inspectMission(interrupted.missionId);
    store.appendTransition(interrupted.missionId, inspection.version, { events: [
      { revision: inspection.revision, kind: "effect.intent", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { effectId, operation: "write", requestHash: "c".repeat(64), recovery: "local-observation-required", candidate: interrupted.candidateRoot } },
      { revision: inspection.revision, kind: "effect.invoking", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { effectId, operation: "write" } },
      { revision: inspection.revision, kind: "effect.released", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { effectId, processIdentity: currentProcessIdentity(store.runtimeId, store.ownerEpoch ?? 1) } },
    ] });
    const report = await reconcileMission({
      store, missionId: interrupted.missionId, sourceRoot: sample.root,
      candidateParent: path.join(sample.base, "recovered-candidates"), trigger: "missing-effect-receipt",
    });
    expect(report.effects).toEqual([expect.objectContaining({ effectId, disposition: "unknown" })]);
    expect(report.frontier).not.toContain("snapshot");
    expect(report.candidate.restored).toBe(true);
    expect(readFileText(path.join(String(report.candidate.root), "src", "app.ts"))).toContain("partial mission write");
    const after = store.inspectMission(interrupted.missionId);
    const workerReceiptFabricated = after.events.some((event) => event.kind === "attempt.receipt" && event.attemptId === interrupted.attemptId);
    expect(workerReceiptFabricated).toBe(false);
    recordT4Case(`missing-local-receipt-${interrupted.missionId}`, {
      actionReport: report,
      exitReport: {
        workerReceiptFabricated,
        partialBytesPreserved: readFileText(path.join(String(report.candidate.root), "src", "app.ts")).includes("partial mission write"),
        originalIntentCount: after.events.filter((event) => event.kind === "effect.intent" && event.effectId === effectId).length,
      },
    });
    store.close();
  });

  test("merges mission partial work with disjoint user edits, restores a private candidate, and exports an exact conditional patch", async () => {
    const sample = fixture();
    const interrupted = await createInterruptedAttempt(sample);
    writeFileSync(path.join(sample.root, "src", "user.ts"), "export const user = 'edited by user';\n");
    writeFileSync(path.join(sample.root, "src", "head.ts"), "export const head = 'changed';\n");
    execFileSync("git", ["add", "src/head.ts"], { cwd: sample.root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "source head drift", "-q"], { cwd: sample.root });
    writeFileSync(path.join(sample.root, "src", "index.ts"), "export const index = 'staged';\n");
    execFileSync("git", ["add", "src/index.ts"], { cwd: sample.root });
    writeFileSync(sample.planFile, `${readFileText(sample.planFile)}\nObserved plan draft.\n`);
    const store = await openFixtureStore(sample);
    const before = store.inspectMission(interrupted.missionId);
    let driftDiagnosisCalls = 0;
    expect(store.ownerAcquisitionProof?.source).toBe("retirement");
    const report = await reconcileMission({
      store, missionId: interrupted.missionId, sourceRoot: sample.root,
      candidateParent: path.join(sample.base, "recovered-candidates"), planFile: sample.planFile,
      trigger: "test-recovery",
      resolveOverlap: {
        diagnose: async () => { driftDiagnosisCalls += 1; return { disposition: "unresolved", reason: "disjoint drift must not route" }; },
        expertDisposition: async () => { throw new Error("expert must not run for disjoint drift"); },
      },
    });
    expect(driftDiagnosisCalls).toBe(0);
    expect(report.status).toBe("resumed");
    expect(report.candidate.restored).toBe(true);
    expect(report.frontier).toEqual(["snapshot"]);
    expect(report.source.changedPaths).toContain("src/user.ts");
    expect(report.source.headChanged).toBe(true);
    expect(report.source.indexChanged).toBe(true);
    expect(report.plan.status).toBe("changed");
    expect(report.delivery.baseManifestHash).not.toBeNull();
    expect(report.delivery.acceptedManifestHash).not.toBeNull();
    expect(report.delivery.patchHash).not.toBeNull();
    expect(readFileText(path.join(sample.root, "src", "app.ts"))).toContain("base");
    expect(readFileText(path.join(sample.root, "src", "user.ts"))).toContain("edited by user");

    const reportEvent = store.inspectMission(interrupted.missionId).events.find((event) =>
      event.kind === "mission.recovery.recorded" && event.payload.episodeId === report.episodeId);
    expect(reportEvent).toBeDefined();
    const eventCount = store.inspectMission(interrupted.missionId).events.length;
    const repeated = await reconcileMission({
      store, missionId: interrupted.missionId, sourceRoot: sample.root,
      candidateParent: path.join(sample.base, "recovered-candidates"), planFile: sample.planFile,
      trigger: "test-recovery",
      resolveOverlap: {
        diagnose: async () => { driftDiagnosisCalls += 1; return { disposition: "unresolved", reason: "must remain unused" }; },
        expertDisposition: async () => { throw new Error("expert must remain unused"); },
      },
    });
    expect(repeated).toEqual(report);
    expect(driftDiagnosisCalls).toBe(0);
    expect(store.inspectMission(interrupted.missionId).events).toHaveLength(eventCount);

    const patchHash = report.delivery.patchHash;
    const acceptedHash = report.delivery.acceptedManifestHash;
    if (!patchHash || !acceptedHash) throw new Error("recovery report omitted its conditional patch identity");
    const patchBytes = store.readArtifact(patchHash);
    const patch = JSON.parse(patchBytes.toString("utf8"));
    const deliveryCopy = await createMissionWorkspace({
      missionId: interrupted.missionId, attemptId: randomUUID(), sourceRoot: sample.root, storeRoot: store.storageRoot,
      candidateParent: path.join(sample.base, "delivery-copies"), allowedPaths: ["src/**"],
    });
    const patchPreimageManifest = captureWorkspaceImage(deliveryCopy.candidateRoot).manifest;
    const accepted = applyConditionalMissionPatch(patch, deliveryCopy);
    const patchResultManifest = accepted;
    expect(accepted.hash).toBe(acceptedHash);
    expect(readFileText(path.join(deliveryCopy.candidateRoot, "src", "app.ts"))).toContain("partial mission write");
    expect(readFileText(path.join(deliveryCopy.candidateRoot, "src", "user.ts"))).toContain("edited by user");
    expect(readFileText(path.join(sample.root, "src", "app.ts"))).toContain("base");
    expect(store.inspectMission(interrupted.missionId).events.length).toBe(eventCount);
    expect(before.events.some((event) => event.kind === "attempt.receipt" && event.attemptId === interrupted.attemptId)).toBe(false);
    recordT4Case(`delivery-patch-${interrupted.missionId}`, {
      beforeManifest: before.events.find((event) => event.kind === "workspace.snapshot.sealed" && event.payload.phase === "base")?.payload.manifest ?? null,
      currentManifest: report.source.manifest,
      reconciledManifest: patchResultManifest,
      conditionalPatch: patch,
      patchArtifactHash: patchHash,
      patchArtifactBase64: patchBytes.toString("base64"),
      acceptedManifestHash: acceptedHash,
      patchPreimageManifest,
      patchPreimageManifestHash: patchPreimageManifest.hash,
      patchResultManifest,
      patchResultManifestHash: patchResultManifest.hash,
      actionReport: { status: report.status, blockers: report.blockers, frontier: report.frontier, effects: report.effects, holds: report.holds },
      exitReport: {
        sourceUnchanged: readFileText(path.join(sample.root, "src", "app.ts")).includes("base"),
        userEditPreserved: readFileText(path.join(deliveryCopy.candidateRoot, "src", "user.ts")).includes("edited by user"),
        missionWritePreserved: readFileText(path.join(deliveryCopy.candidateRoot, "src", "app.ts")).includes("partial mission write"),
        acceptedManifestHashMatches: accepted.hash === acceptedHash,
      },
    });
    const storedPlanHash = store.inspectMission(interrupted.missionId).snapshot.planHash;
    rmSync(sample.planFile);
    const missingPlan = await reconcileMission({
      store, missionId: interrupted.missionId, sourceRoot: sample.root,
      candidateParent: path.join(sample.base, "recovered-candidates"), planFile: sample.planFile, trigger: "missing-plan",
    });
    expect(missingPlan.plan.status).toBe("missing");
    expect(store.inspectMission(interrupted.missionId).snapshot.planHash).toBe(storedPlanHash);
    recordT4Case(`source-drift-${interrupted.missionId}`, {
      source: { headChanged: report.source.headChanged, indexChanged: report.source.indexChanged, changedPaths: report.source.changedPaths },
      plan: { changed: report.plan, missing: missingPlan.plan },
      actionReport: { status: report.status, blockers: report.blockers, staleEvidence: report.evidence },
      exitReport: {
        headRecordedSeparately: report.source.headChanged, indexRecordedSeparately: report.source.indexChanged,
        planChanged: report.plan.status === "changed", planMissing: missingPlan.plan.status === "missing",
        immutablePlanHashPreserved: store.inspectMission(interrupted.missionId).snapshot.planHash === storedPlanHash,
      },
    });
    store.close();
  }, 30_000);

  test("retains path-independent evidence and invalidates only checks affected by source drift", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.units[0].inputs = ["src/app.ts"];
    definition.units.push(
      { ...definition.units[0], id: "user-check", inputs: ["src/user.ts"], acceptance: [{ id: "user-check-proof", kind: "manual", target: "fixture:user" }] },
      { ...definition.units[0], id: "head-check", inputs: ["src/head.ts"], acceptance: [{ id: "head-check-proof", kind: "manual", target: "fixture:head" }] },
    );
    definition.finalization.requiredPredicates.push("user-check-proof", "head-check-proof");
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const interrupted = await createInterruptedAttempt(sample);
    writeFileSync(path.join(sample.root, "src", "user.ts"), "export const user = 'new source';\n");
    const store = await openFixtureStore(sample);
    const retainedId = randomUUID();
    const invalidatedId = randomUUID();
    const inspection = store.inspectMission(interrupted.missionId);
    store.appendTransition(interrupted.missionId, inspection.version, { events: [
      { revision: inspection.revision, kind: "evidence.recorded", causalId: randomUUID(), unitId: "head-check",
        payload: { id: retainedId, unitId: "head-check", predicateId: "head-check-proof", revision: 1, verdict: "pass", inputManifestHash: "a".repeat(64), outputManifestHash: "b".repeat(64), method: "fixture", artifactHash: null, attemptId: randomUUID() } },
      { revision: inspection.revision, kind: "evidence.recorded", causalId: randomUUID(), unitId: "user-check",
        payload: { id: invalidatedId, unitId: "user-check", predicateId: "user-check-proof", revision: 1, verdict: "pass", inputManifestHash: "c".repeat(64), outputManifestHash: "d".repeat(64), method: "fixture", artifactHash: null, attemptId: randomUUID() } },
    ] });
    const report = await reconcileMission({ store, missionId: interrupted.missionId, sourceRoot: sample.root, planFile: sample.planFile, trigger: "path-sensitive-evidence" });
    expect(report.evidence.retained).toEqual([retainedId]);
    expect(report.evidence.invalidated).toEqual([invalidatedId]);
    expect(report.frontier).toContain("user-check");
    const after = store.inspectMission(interrupted.missionId);
    expect(after.events.some((event) => event.kind === "evidence.reused" && event.payload.evidenceId === retainedId)).toBe(true);
    expect(after.events.some((event) => event.kind === "evidence.invalidated" && (event.payload.evidenceIds as string[]).includes(invalidatedId))).toBe(true);
    const candidateRoot = report.candidate.root;
    if (!candidateRoot) throw new Error("evidence drift recovery omitted its disposable candidate");
    const inputImage = captureWorkspaceImage(candidateRoot);
    const sourceBefore = captureWorkspaceImage(sample.root).manifest;
    const bwrap = execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
    const node = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
    const checkScript = [
      'import { readFileSync } from "node:fs";',
      'const source = readFileSync("src/user.ts", "utf8");',
      'if (!source.includes("export const user = \'new source\';")) process.exit(1);',
      'console.log("fresh-user-check: PASS");',
    ].join("\n");
    const args = ["--unshare-all", "--die-with-parent", "--new-session", "--ro-bind", "/", "/",
      "--ro-bind", candidateRoot, candidateRoot, "--proc", "/proc", "--dev", "/dev", "--chdir", candidateRoot,
      "--", node, "--input-type=module", "-e", checkScript];
    const checkEnv = { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
    const freshRun = spawnSync(bwrap, args, { encoding: "utf8", timeout: 30_000, env: checkEnv });
    const resultImage = captureWorkspaceImage(candidateRoot);
    const sourceAfter = captureWorkspaceImage(sample.root).manifest;
    const output = Buffer.concat([Buffer.from(freshRun.stdout ?? ""), Buffer.from(freshRun.stderr ?? "")]);
    const freshCheck = {
      method: "bubblewrap read-only candidate mount with isolated user, PID, and network namespaces",
      candidateRoot,
      command: { executable: bwrap, args, cwd: candidateRoot, env: checkEnv },
      exitCode: freshRun.status ?? -1,
      error: freshRun.error?.message ?? null,
      inputManifest: inputImage.manifest,
      inputManifestHash: inputImage.manifest.hash,
      resultManifest: resultImage.manifest,
      resultManifestHash: resultImage.manifest.hash,
      output: output.toString("utf8"),
      outputHash: createHash("sha256").update(output).digest("hex"),
      candidateUnchanged: inputImage.manifest.hash === resultImage.manifest.hash,
      sourceUnchanged: sourceBefore.hash === sourceAfter.hash,
    };
    expect(report.frontier).toContain("user-check");
    expect(freshCheck.exitCode).toBe(0);
    expect(freshCheck.candidateUnchanged).toBe(true);
    expect(freshCheck.sourceUnchanged).toBe(true);
    expect(freshCheck.output).toContain("fresh-user-check: PASS");
    recordT4Case(`evidence-drift-${interrupted.missionId}`, {
      evidence: report.evidence, actionReport: { status: report.status, frontier: report.frontier, blockers: report.blockers },
      exitReport: {
        retainedUnaffected: report.evidence.retained.includes(retainedId),
        invalidatedAffected: report.evidence.invalidated.includes(invalidatedId),
        freshCheckScheduled: report.frontier.includes("user-check"), freshCheck,
      },
    });
    store.close();
  });

  test("persists predicate input bindings and retains only evidence whose own inputs remain unchanged", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.artifactBytes = 3 * 1024 * 1024;
    definition.budget.roleLaunches = 6;
    definition.budget.providerRequests = 8;
    definition.budget.tokens = 2000;
    definition.budget.activeTimeMs = 120000;
    definition.units[0].inputs = ["src"];
    definition.units.push({
      ...definition.units[0], id: "user-check", inputs: ["src/user.ts"],
      acceptance: [{ id: "user-proof", kind: "manual", target: "fixture:user" }],
    });
    definition.finalization.requiredPredicates.push("user-proof");
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const assessPredicate = () => ({ verdict: "pass" as const, method: "predicate-bound fixture check" });
    const engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
      runRole: async ({ unit }) => ({ instanceId: unit.id, role: unit.role, status: "completed", model: { selectedModel: "fixture/local" }, result: unit.id }),
      assessPredicate,
    });
    engine.start();
    await engine.waitForIdle();
    expect(engine.snapshot().units.snapshot?.status).toBe("accepted");
    expect(engine.snapshot().units["user-check"]?.status).toBe("accepted");
    const evidence = store.inspectMission(mission.id).events.filter((event) => event.kind === "evidence.recorded");
    expect(evidence).toHaveLength(2);
    expect(evidence.every((event) => typeof event.payload.predicateHash === "string" &&
      typeof event.payload.inputBindingHash === "string" && Array.isArray(event.payload.inputPatterns))).toBe(true);
    await engine.retireForShutdown("predicate binding test complete");
    store.close();

    const resumed = await openFixtureStore(sample);
    const unchanged = await reconcileMission({
      store: resumed, missionId: mission.id, sourceRoot: sample.root,
      candidateParent: path.join(sample.base, "recovered-candidates"), planFile: sample.planFile, trigger: "predicate-input-unchanged",
      assessmentToolIdentity: missionAssessmentToolIdentity(assessPredicate), runtimeIdentity: missionRuntimeIdentity(),
    });
    expect(unchanged.evidence.invalidated).toEqual([]);
    expect([...unchanged.evidence.retained].sort()).toEqual(evidence.map((event) => String(event.payload.id)).sort());
    writeFileSync(path.join(sample.root, "src", "app.ts"), "export const mission = 'changed app';\n");
    const report = await reconcileMission({
      store: resumed, missionId: mission.id, sourceRoot: sample.root,
      candidateParent: path.join(sample.base, "recovered-candidates"), planFile: sample.planFile, trigger: "predicate-input-drift",
      assessmentToolIdentity: missionAssessmentToolIdentity(assessPredicate), runtimeIdentity: missionRuntimeIdentity(),
    });
    const appEvidence = String(evidence.find((event) => event.payload.unitId === "snapshot")!.payload.id);
    const userEvidence = String(evidence.find((event) => event.payload.unitId === "user-check")!.payload.id);
    expect(report.evidence.invalidated).toContain(appEvidence);
    expect(report.evidence.retained).toContain(userEvidence);
    expect(report.frontier).toContain("snapshot");
    expect(report.frontier).not.toContain("user-check");
    const alternateIndexBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: sample.root, input: Buffer.from("export const user = 'staged-only change';\n"),
    }).toString().trim();
    execFileSync("git", ["update-index", "--cacheinfo", `100644,${alternateIndexBlob},src/user.ts`], { cwd: sample.root });
    const indexReport = await reconcileMission({
      store: resumed, missionId: mission.id, sourceRoot: sample.root,
      candidateParent: path.join(sample.base, "recovered-candidates"), planFile: sample.planFile, trigger: "predicate-index-drift",
      assessmentToolIdentity: missionAssessmentToolIdentity(assessPredicate), runtimeIdentity: missionRuntimeIdentity(),
    });
    expect(readFileSync(path.join(sample.root, "src", "user.ts"), "utf8")).toContain("user = 'base'");
    expect(indexReport.evidence.invalidated).toContain(userEvidence);
    recordT4Case(`predicate-input-binding-${mission.id}`, {
      actionReport: report,
      exitReport: {
        perPredicateBindingsStored: evidence.every((event) => typeof event.payload.inputBindingHash === "string" &&
          typeof event.payload.predicateHash === "string" && typeof event.payload.rolePolicyHash === "string" &&
          typeof event.payload.assessmentToolIdentity === "string" && typeof event.payload.runtimeIdentity === "string" &&
          Array.isArray(event.payload.inputIndexEntries) && Array.isArray(event.payload.dependencyEvidence)),
        changedInputInvalidated: report.evidence.invalidated.includes(appEvidence),
        unaffectedInputRetained: report.evidence.retained.includes(userEvidence),
        onlyChangedUnitScheduled: report.frontier.includes("snapshot") && !report.frontier.includes("user-check"),
        indexOnlyChangeInvalidated: indexReport.evidence.invalidated.includes(userEvidence),
        indexOnlyChangePreservedWorktree: readFileSync(path.join(sample.root, "src", "user.ts"), "utf8").includes("user = 'base'"),
      },
    });
    resumed.close();
  });

  test("diagnoses only semantic overlap, persists role dispositions, and reuses them after candidate relocation", async () => {
    const sample = fixture();
    const interrupted = await createInterruptedAttempt(sample);
    const relocatedRoot = path.join(path.dirname(interrupted.candidateRoot), "relocated-candidate");
    renameSync(interrupted.candidateRoot, relocatedRoot);
    writeFileSync(path.join(sample.root, "src", "app.ts"), "export const user = 'edited by user';\n");
    const store = await openFixtureStore(sample);
    const calls = { developer: 0, expert: 0 };
    const resolveOverlap = {
      diagnose: async (input: Parameters<NonNullable<Parameters<typeof reconcileMission>[0]["resolveOverlap"]>["diagnose"]>[0]) => {
        calls.developer += 1;
        expect(input.conflicts.map(({ path: name }) => name)).toEqual(["src/app.ts"]);
        return { disposition: "genuine-conflict" as const, reason: "Mission and user changed same file with different intent." };
      },
      expertDisposition: async (input: Parameters<NonNullable<Parameters<typeof reconcileMission>[0]["resolveOverlap"]>["expertDisposition"]>[0]) => {
        calls.expert += 1;
        expect(input.developerDiagnosis?.disposition).toBe("genuine-conflict");
        const conflict = input.conflicts[0]!;
        return {
          disposition: "compatible" as const,
          reason: "Both exact declarations are preserved in one result.",
          resolutions: [{
            path: conflict.path, kind: "file" as const, mode: conflict.mission.mode,
            bytes: Buffer.from("export const mission = 'partial mission write';\nexport const user = 'edited by user';\n"),
          }],
        };
      },
    };
    const reconcile = () => reconcileMission({
      store, missionId: interrupted.missionId, sourceRoot: sample.root,
      candidateParent: path.join(sample.base, "recovered-candidates"),
      planFile: sample.planFile, trigger: "semantic-overlap", resolveOverlap,
    });
    const report = await reconcile();
    expect(report.status).toBe("resumed");
    expect(report.diagnoses.map(({ role, disposition, resultHash }) => [role, disposition, Boolean(resultHash)])).toEqual([
      ["developer", "genuine-conflict", true], ["expert", "compatible", true],
    ]);
    expect(calls).toEqual({ developer: 1, expert: 1 });
    const inspection = store.inspectMission(interrupted.missionId);
    const diagnosisEvents = inspection.events.filter(({ kind }) => kind === "mission.recovery.diagnosed");
    const relocationEvent = inspection.events.find(({ kind, attemptId }) => kind === "workspace.candidate.relocated" && attemptId === interrupted.attemptId);
    expect(diagnosisEvents.filter(({ payload }) => payload.status === "started")).toHaveLength(2);
    expect(diagnosisEvents.filter(({ payload }) => payload.status === "completed")).toHaveLength(2);
    if (!report.delivery.patchHash || !report.delivery.acceptedManifestHash) throw new Error("recovery report omitted its conditional patch identity");
    const patch = JSON.parse(store.readArtifact(report.delivery.patchHash).toString("utf8"));
    const deliveryCopy = await createMissionWorkspace({
      missionId: interrupted.missionId, attemptId: randomUUID(), sourceRoot: sample.root, storeRoot: store.storageRoot,
      candidateParent: path.join(sample.base, "delivery-copies"), allowedPaths: ["src/**"],
    });
    const acceptedManifestHashMatches = applyConditionalMissionPatch(patch, deliveryCopy).hash === report.delivery.acceptedManifestHash;
    expect(acceptedManifestHashMatches).toBe(true);
    const deliveredApp = readFileText(path.join(deliveryCopy.candidateRoot, "src", "app.ts"));
    execFileSync("bash", ["-c", "grep -q 'partial mission write' src/app.ts && grep -q 'edited by user' src/app.ts"], { cwd: deliveryCopy.candidateRoot });
    expect(deliveredApp).toContain("partial mission write");
    expect(deliveredApp).toContain("edited by user");
    expect(readFileText(path.join(sample.root, "src", "app.ts"))).toContain("edited by user");
    const versionBeforeRepeat = store.inspectMission(interrupted.missionId).version;
    const repeated = await reconcile();
    expect(repeated).toEqual(report);
    expect(store.inspectMission(interrupted.missionId).version).toBe(versionBeforeRepeat);
    expect(calls).toEqual({ developer: 1, expert: 1 });
    recordT4Case(`recovery-conflict-${interrupted.missionId}`, {
      candidateRelocated: relocationEvent?.payload.toRoot === relocatedRoot,
      actionReport: { status: report.status, blockers: report.blockers, frontier: report.frontier, diagnoses: report.diagnoses },
      exitReport: {
        userEditPreserved: deliveredApp.includes("edited by user"),
        missionWritePreserved: deliveredApp.includes("partial mission write"),
        acceptedManifestHashMatches,
        repeatedVersionStable: store.inspectMission(interrupted.missionId).version === versionBeforeRepeat,
        diagnosisCallsUnchanged: calls.developer === 1 && calls.expert === 1,
      },
    });
    store.close();
  }, 30_000);

  test("explicit recovery settles a pre-revision released effect before revision-2 dispatch", async () => {
    const sample = fixture();
    const original = await crashUnreceiptedWrite(sample, "export const mission = 'partial mission write';\n");
    const store = original.store;
    const initial = store.inspectMission(original.missionId);
    store.appendTransition(original.missionId, initial.version, { events: [{
      revision: 1, kind: "mission.blocked", causalId: randomUUID(), payload: { reason: "shutdown requires recovery" },
    }] });
    const before = store.inspectMission(original.missionId);
    const next = structuredClone(before.definition);
    next.units[0]!.acceptance[0]!.expected = "recovered bytes";
    let roleLaunches = 0;
    const engine = new MissionEngine({
      store, missionId: original.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: original.candidateParent },
      runRole: async (_input, durable) => {
        roleLaunches += 1;
        const check = await durable.effects!.invoke("bash", {
          command: "grep -q 'partial mission write' src/app.ts && printf RECOVERED",
        });
        return { instanceId: randomUUID(), role: "developer", status: check.status === "completed" ? "completed" : "failed",
          model: { selectedModel: "fixture/local" }, result: check.stdout ?? "" };
      },
      assessPredicate: ({ resultArtifact }) => ({ verdict: resultArtifact.toString("utf8") === "RECOVERED" ? "pass" : "fail",
        method: "fresh recovered image check" }),
    });
    try {
      const receipt = operatorChangeReceipt(store, before, next);
      admitMissionChange({ store, engine, missionId: original.missionId, expectedVersion: before.version,
        planBytes: nextPlanBytes(before.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), receipt, actor: "operator" });
      expect(store.inspectMission(original.missionId).events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
      expect(missionHasUnresolvedEffects(store, store.inspectMission(original.missionId).events)).toBe(true);
      engine.start(); // Explicit authorized recovery, not revision admission, permits the next dispatch.
      await engine.waitForIdle();
      const after = store.inspectMission(original.missionId);
      const recovered = after.events.find((event) => event.kind === "effect.reconciled" && event.effectId === original.effectId);
      const accepted = after.events.find((event) => event.kind === "unit.accepted" && event.revision === 2);
      expect(recovered?.payload.disposition).toBe("applied");
      expect(missionHasUnresolvedEffects(store, after.events)).toBe(false);
      expect(after.events.some((event) => event.kind === "mission.recovery.recorded" && event.revision === 2)).toBe(true);
      expect(roleLaunches).toBe(1);
      expect(accepted?.payload.attemptId).toBe(after.events.find((event) => event.kind === "attempt.reserved" && event.revision === 2)?.attemptId);
      expect(missionCompletionBlockers(after, store)).toContain("recovery:unproven");
    } finally { await engine.close(); store.close(); }
  }, 60_000);

  test("uses persisted exact write request and after-image to resolve an ambiguous local effect", async () => {
    const sample = fixture();
    const interrupted = await createInterruptedAttempt(sample, true);
    if (!interrupted.effectId) throw new Error("contained write did not persist its effect identity");
    const store = await openFixtureStore(sample);
    const inspection = store.inspectMission(interrupted.missionId);
    store.appendTransition(interrupted.missionId, inspection.version, { events: [{
      revision: inspection.revision, kind: "effect.unknown", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId,
      effectId: interrupted.effectId, payload: { effectId: interrupted.effectId, reason: "simulated lost receipt boundary" },
    }] });
    const report = await reconcileMission({
      store, missionId: interrupted.missionId, sourceRoot: sample.root,
      candidateParent: path.join(sample.base, "recovered-candidates"), trigger: "exact-local-after-image",
    });
    expect(report.effects).toEqual([expect.objectContaining({ effectId: interrupted.effectId, disposition: "applied" })]);
    const events = store.inspectMission(interrupted.missionId).events;
    const intent = events.find((event) => event.kind === "effect.intent" && event.effectId === interrupted.effectId)!;
    const plan = JSON.parse(store.readArtifact(String(intent.payload.effectPlanHash)).toString("utf8"));
    expect(plan.format).toBe("mission-effect-plan-v1");
    expect(plan.request).toEqual({ path: "src/app.ts", content: "export const mission = 'partial mission write';\n", timeoutMs: 120_000 });
    expect(plan.preconditions.some((row: { path: string }) => row.path === "src/app.ts")).toBe(true);
    expect(Buffer.from(plan.beforeFiles[0].bytesBase64, "base64").toString("utf8")).toContain("base");
    expect(Buffer.from(plan.expectedAfterFiles[0].bytesBase64, "base64").toString("utf8")).toContain("partial mission write");
    const reconciliation = events.find((event) => event.kind === "effect.reconciled" && event.effectId === interrupted.effectId)!;
    expect(reconciliation.payload.proofKind).toBe("candidate-after-image-v1");
    expect(reconciliation.payload.disposition).toBe("applied");
    recordT4Case(`effect-after-image-${interrupted.missionId}`, {
      actionReport: report,
      effectPlan: { hash: intent.payload.effectPlanHash, request: plan.request, preconditions: plan.preconditions, expectedAfterFiles: plan.expectedAfterFiles },
      exitReport: { exactRequestPersisted: plan.requestHash === intent.payload.requestHash, afterImageProofPersisted: reconciliation.payload.proofKind === "candidate-after-image-v1", disposition: report.effects[0]?.disposition },
    });
    store.close();
  });

  test("a completed receipt with changed candidate bytes becomes partial and requires a fresh check", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.artifactBytes = 3 * 1024 * 1024;
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const interrupted = await createInterruptedAttempt(sample, true);
    if (!interrupted.effectId) throw new Error("contained write did not persist its effect identity");
    writeFileSync(path.join(interrupted.candidateRoot, "src", "app.ts"), "export const mission = 'changed after receipt';\n");
    const store = await openFixtureStore(sample);
    let verification = "";
    const engine = new MissionEngine({
      store, missionId: interrupted.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "receipt-candidates") },
      runRole: async (_input, durable) => {
        const check = await durable.effects!.invoke("bash", {
          command: "grep -q 'partial mission write' src/app.ts && printf EXACT || printf CHANGED",
        });
        verification = check.stdout ?? "";
        return { instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: verification };
      },
      assessPredicate: ({ resultArtifact }) => ({
        verdict: resultArtifact.toString("utf8") === "EXACT" ? "pass" : "fail",
        method: "fresh candidate command compares exact expected bytes",
      }),
    });
    engine.start();
    await engine.waitForIdle();
    const inspection = store.inspectMission(interrupted.missionId);
    const recoveryEvent = inspection.events.find((event) => event.kind === "mission.recovery.recorded");
    const report = JSON.parse(store.readArtifact(String(recoveryEvent!.payload.reportHash)).toString("utf8"));
    expect(report.effects).toEqual([expect.objectContaining({ effectId: interrupted.effectId, disposition: "partial" })]);
    expect(verification).toBe("CHANGED");
    expect(inspection.events.some((event) => event.kind === "unit.accepted" && event.unitId === "snapshot")).toBe(false);
    expect(inspection.events.filter((event) => event.kind === "evidence.recorded" && event.payload.verdict === "pass")).toHaveLength(0);
    expect(engine.snapshot().units.snapshot?.status).toBe("blocked");
    recordT4Case(`receipt-changed-image-${interrupted.missionId}`, {
      actionReport: report,
      exitReport: { disposition: report.effects[0]?.disposition, freshCheck: verification, accepted: false, passEvidence: false },
    });
    await engine.close();
    store.close();
  }, 30_000);

  test("a receipt cannot claim quiescence while its exact process namespace remains live", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.artifactBytes = 3 * 1024 * 1024;
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const interrupted = await createInterruptedAttempt(sample, true);
    const store = await openFixtureStore(sample);
    const inspection = store.inspectMission(interrupted.missionId);
    const priorIntent = inspection.events.find((event) => event.kind === "effect.intent" && event.effectId === interrupted.effectId)!;
    const liveOwner = currentProcessIdentity(store.runtimeId, store.ownerEpoch!);
    const liveProcess = {
      ...liveOwner, containedPid: process.pid, pidNamespace: processNamespaceId(process.pid),
      networkNamespace: readlinkSync("/proc/self/ns/net"),
      descendantsQuiescent: true, namespaceEmptyAfterExit: true,
    };
    const effectId = randomUUID();
    store.appendTransition(interrupted.missionId, inspection.version, { events: [
      { revision: inspection.revision, kind: "effect.intent", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { ...priorIntent.payload, effectId, owner: liveOwner } },
      { revision: inspection.revision, kind: "effect.invoking", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { effectId, operation: priorIntent.payload.operation, requestHash: priorIntent.payload.requestHash } },
      { revision: inspection.revision, kind: "effect.process.registered", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { effectId, identity: liveProcess } },
      { revision: inspection.revision, kind: "effect.released", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { effectId, processIdentity: liveProcess, requestHash: priorIntent.payload.requestHash } },
      { revision: inspection.revision, kind: "effect.receipt", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { effectId, operation: priorIntent.payload.operation, status: "completed", paths: [], process: liveProcess } },
    ] });
    let roleLaunches = 0;
    let assessments = 0;
    const engine = new MissionEngine({
      store, missionId: interrupted.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "live-receipt-candidates") },
      runRole: async () => {
        roleLaunches += 1;
        return { instanceId: "unsafe", role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "PASS" };
      },
      assessPredicate: () => { assessments += 1; return { verdict: "pass", method: "must not run" }; },
    });
    engine.start();
    await engine.waitForIdle();
    const after = store.inspectMission(interrupted.missionId);
    const recoveryEvent = after.events.find((event) => event.kind === "mission.recovery.recorded");
    const report = JSON.parse(store.readArtifact(String(recoveryEvent!.payload.reportHash)).toString("utf8"));
    expect(processesInNamespace(liveProcess.pidNamespace).some(({ pid, birthTicks }) => pid === process.pid && birthTicks === liveProcess.birthTicks)).toBe(true);
    expect(report.effects).toEqual(expect.arrayContaining([expect.objectContaining({ effectId, disposition: "unknown" })]));
    expect(roleLaunches).toBe(0);
    expect(assessments).toBe(0);
    expect(after.events.some((event) => event.kind === "evidence.recorded" && event.payload.verdict === "pass")).toBe(false);
    recordT4Case(`receipt-live-namespace-${interrupted.missionId}`, {
      actionReport: report,
      exitReport: { namespaceStillLive: true, effectUnknown: report.effects.some((effect: { effectId: string; disposition: string }) => effect.effectId === effectId && effect.disposition === "unknown"), roleLaunches, assessments },
    });
    await engine.close();
    store.close();
  }, 30_000);

  test("failed verification authorizes one bounded repair on a fresh candidate", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.roleLaunches = 4;
    definition.budget.artifactBytes = 3 * 1024 * 1024;
    definition.units[0].retryLimit = 1;
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const interrupted = await createInterruptedAttempt(sample, true);
    if (!interrupted.effectId) throw new Error("contained write did not persist its effect identity");
    writeFileSync(path.join(interrupted.candidateRoot, "src", "app.ts"), "export const mission = 'damaged partial';\n");
    const store = await openFixtureStore(sample);
    const before = store.inspectMission(interrupted.missionId);
    store.appendTransition(interrupted.missionId, before.version, { events: [{
      revision: before.revision, kind: "effect.unknown", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId,
      effectId: interrupted.effectId, payload: { effectId: interrupted.effectId, reason: "simulate a lost completion receipt" },
    }] });
    const attempts: Array<{ attemptId: string; mode?: string; imageHash?: string; candidateRoot: string }> = [];
    const engine = new MissionEngine({
      store, missionId: interrupted.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "repair-candidates") },
      runRole: async (input, durable) => {
        attempts.push({ attemptId: input.binding.attemptId, mode: input.binding.recoveryMode,
          imageHash: input.binding.recoveryImageHash, candidateRoot: durable.cwd ?? "" });
        if (durable.readOnly) {
          const check = await durable.effects!.invoke("bash", { command: "grep -q 'corrected mission' src/app.ts && printf PASS || printf NEEDS_REPAIR" });
          return { instanceId: randomUUID(), role: "developer", status: "completed",
            model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" }, result: check.stdout ?? "" };
        }
        const write = await durable.effects!.invoke("write", {
          path: "src/app.ts", content: "export const mission = 'corrected mission';\n",
        });
        const check = write.status === "completed"
          ? await durable.effects!.invoke("bash", { command: "grep -q 'corrected mission' src/app.ts && printf PASS" }) : write;
        return { instanceId: randomUUID(), role: "developer", status: check.status === "completed" ? "completed" : "failed",
          model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" }, result: check.stdout ?? "" };
      },
      assessPredicate: ({ resultArtifact }) => ({
        verdict: resultArtifact.toString("utf8").includes("PASS") ? "pass" : "fail",
        method: "read-only check first, then exact bounded local repair and check",
      }),
    });
    engine.start();
    await engine.waitForIdle();
    const inspection = store.inspectMission(interrupted.missionId);
    expect(attempts.map(({ mode }) => mode)).toEqual(["verify", "repair"]);
    expect(attempts[0]!.candidateRoot).not.toBe(attempts[1]!.candidateRoot);
    expect(attempts[0]!.imageHash).toBe(attempts[1]!.imageHash);
    expect(inspection.events.filter((event) => event.kind === "effect.intent" && event.attemptId === interrupted.attemptId)).toHaveLength(1);
    expect(inspection.events.some((event) => event.kind === "mission.recovery.repair.authorized")).toBe(true);
    expect(inspection.events.some((event) => event.kind === "mission.recovery.repair.started")).toBe(true);
    expect(inspection.events.some((event) => event.kind === "mission.recovery.repair.settled" && event.payload.disposition === "verified")).toBe(true);
    expect(inspection.events.find((event) => event.kind === "unit.accepted")?.payload.attemptId).toBe(attempts[1]!.attemptId);
    expect(readFileSync(path.join(attempts[1]!.candidateRoot, "src", "app.ts"), "utf8")).toContain("corrected mission");
    const repairIntent = inspection.events.find((event) => event.kind === "effect.intent" && event.attemptId === attempts[1]!.attemptId)!;
    expect(repairIntent.payload.repairAuthorizationId).toBeDefined();
    expect(repairIntent.payload.recoveryImageHash).toBe(attempts[0]!.imageHash);
    recordT4Case(`fresh-repair-${interrupted.missionId}`, {
      actionReport: { attempts, recoveryContinuation: inspection.events.find((event) => event.kind === "mission.recovery.continuation.recorded")?.payload },
      exitReport: { freshCandidate: attempts[0]!.candidateRoot !== attempts[1]!.candidateRoot,
        originalEffectNotRepeated: inspection.events.filter((event) => event.kind === "effect.intent" && event.attemptId === interrupted.attemptId).length === 1,
        repairVerified: inspection.events.some((event) => event.kind === "mission.recovery.repair.settled" && event.payload.disposition === "verified"),
      },
    });
    engine.close();
    store.close();
  }, 30_000);

  test("rebuilds a missing candidate from its sealed effect after-image, not the receipt alone", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.budget.roleLaunches = 4;
    definition.budget.providerRequests = 8;
    definition.budget.tokens = 2000;
    definition.budget.activeTimeMs = 120000;
    definition.budget.artifactBytes = 3 * 1024 * 1024;
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const interrupted = await createInterruptedAttempt(sample, true);
    if (!interrupted.effectId) throw new Error("contained write did not persist its effect identity");
    const store = await openFixtureStore(sample);
    const registered = store.inspectMission(interrupted.missionId).events.find((event) => event.kind === "effect.process.registered")?.payload.identity as Record<string, unknown> | undefined;
    const pidNamespace = String(registered?.pidNamespace ?? "");
    if (!pidNamespace) throw new Error("completed local effect omitted its bound process namespace");
    expect(processesInNamespace(pidNamespace)).toHaveLength(0);
    rmSync(interrupted.candidateRoot, { recursive: true, force: true });
    let workerRuns = 0;
    let mutationStatus = "";
    let checkStatus = "";
    const engine = new MissionEngine({
      store, missionId: interrupted.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "verification-candidates") },
      runRole: async (input, durable) => {
        workerRuns += 1;
        expect(durable.readOnly).toBe(true);
        expect(input.binding.recoveryMode).toBe("verify");
        mutationStatus = (await durable.effects!.invoke("write", { path: "src/app.ts", content: "must not repeat" })).status;
        const check = await durable.effects!.invoke("bash", { command: "grep -q 'partial mission write' src/app.ts && printf RECOVERED" });
        checkStatus = check.status;
        return { instanceId: input.binding.attemptId, role: "developer", status: check.status === "completed" ? "completed" : "failed",
          model: { selectedModel: "fixture/local" }, result: check.stdout ?? "" };
      },
      assessPredicate: ({ resultArtifact }) => ({
        verdict: checkStatus === "completed" && resultArtifact.toString("utf8") === "RECOVERED" ? "pass" : "fail",
        method: "fresh read-only check validates the rebuilt host-sealed candidate image",
      }),
    });
    engine.start();
    await engine.waitForIdle();
    const afterRecovery = store.inspectMission(interrupted.missionId);
    const reportEvent = afterRecovery.events.find((event) => event.kind === "mission.recovery.recorded")!;
    const report = JSON.parse(store.readArtifact(String(reportEvent.payload.reportHash)).toString("utf8"));
    expect(report.effects).toEqual([expect.objectContaining({
      effectId: interrupted.effectId, attemptId: interrupted.attemptId, disposition: "applied",
      probe: expect.objectContaining({ imageSource: "sealed-effect-snapshot" }),
    })]);
    expect(report.candidate.restored).toBe(true);
    expect(report.frontier).toEqual(["snapshot"]);
    expect(afterRecovery.events.filter((event) => event.kind === "effect.intent" && event.effectId === interrupted.effectId)).toHaveLength(1);
    expect(afterRecovery.events.some((event) => event.kind === "attempt.receipt" && event.attemptId === interrupted.attemptId)).toBe(false);
    expect(workerRuns).toBe(1);
    expect(mutationStatus).toBe("denied");
    expect(checkStatus).toBe("completed");
    expect(engine.snapshot().units.snapshot?.status).toBe("accepted");
    recordT4Case(`effect-recovery-${interrupted.missionId}`, {
      currentManifest: report.source.manifest,
      candidate: report.candidate,
      actionReport: { status: report.status, blockers: report.blockers, frontier: report.frontier, effects: report.effects, holds: report.holds },
      exitReport: { workerReceiptFabricated: afterRecovery.events.some((event) => event.kind === "attempt.receipt" && event.attemptId === interrupted.attemptId),
        namespaceEmpty: processesInNamespace(pidNamespace).length === 0, rebuiltImageReadVerified: checkStatus === "completed",
        mutationDenied: mutationStatus === "denied", engineRecoveredAndAccepted: engine.snapshot().units.snapshot?.status === "accepted" },
    });
    engine.close();
    store.close();
  }, 30_000);

  test("probes ambiguous external effects by original identity during engine resume and never invokes them again", async () => {
    const sample = fixture();
    const grantId = "payments:charge";
    permitExternalGrant(sample, grantId);
    const budget = JSON.parse(sample.definitionBytes.toString("utf8"));
    budget.budget.artifactBytes = 3 * 1024 * 1024;
    sample.definitionBytes = Buffer.from(`${JSON.stringify(budget, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const interrupted = await createInterruptedAttempt(sample);
    const store = await openFixtureStore(sample);
    const effectId = randomUUID();
    const operationKey = "payment-operation-17";
    const target = "account:customer-17";
    const requestHash = "a".repeat(64);
    const adapterId = "payments-probe";
    const adapterVersion = "1";
    const inspection = store.inspectMission(interrupted.missionId);
    store.appendTransition(interrupted.missionId, inspection.version, { events: [
      { revision: inspection.revision, kind: "effect.intent", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { effectId, operation: "external:charge", grantId, target, operationKey, requestHash, adapterId, adapterVersion, recovery: "external-probe-required" } },
      { revision: inspection.revision, kind: "effect.invoking", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { effectId, operation: "external:charge", operationKey } },
    ] });
    let probes = 0;
    let engineRuns = 0;
    const engine = new MissionEngine({
      store, missionId: interrupted.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "recovered-candidates") },
      externalEffectProbes: {
        [grantId]: {
          grantId, adapterId, adapterVersion,
          probe: async (input) => {
            probes += 1;
            expect(input).toEqual({ missionId: interrupted.missionId, effectId, operation: "external:charge", grantId, target, operationKey, requestHash, adapterId, adapterVersion });
            return { disposition: "applied", evidence: { serviceReceipt: "read-only-probe-17" } };
          },
        },
      },
      runRole: async () => {
        engineRuns += 1;
        return { instanceId: `resume-${engineRuns}`, role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "verified" };
      },
      assessPredicate: () => ({ verdict: "pass", method: "fixture read-only verifier" }),
    });
    engine.start();
    await engine.waitForIdle();
    const after = store.inspectMission(interrupted.missionId);
    const reportEvent = [...after.events].reverse().find((event) => event.kind === "mission.recovery.recorded");
    const report = reportEvent ? JSON.parse(store.readArtifact(String(reportEvent.payload.reportHash)).toString("utf8")) : null;
    expect(report?.effects).toEqual([expect.objectContaining({ effectId, disposition: "applied" })]);
    expect(probes).toBe(1);
    expect(engineRuns).toBe(1);
    expect(after.events.filter((event) => event.kind === "effect.intent" && event.effectId === effectId)).toHaveLength(1);
    expect(after.events.some((event) => event.kind === "effect.reconciled" && event.effectId === effectId && event.payload.proofKind === "host-external-probe-v1")).toBe(true);
    expect(missionHasUnresolvedEffects(store, after.events)).toBe(false);
    expect(missionCompletionBlockers(after, store)).toContain(`effect:${effectId}`);
    recordT4Case(`external-effect-probed-${interrupted.missionId}`, {
      actionReport: report,
      exitReport: { originalIdentityProbed: probes === 1, mutationNotRepeated: after.events.filter((event) => event.kind === "effect.intent" && event.effectId === effectId).length === 1 },
    });
    await engine.retireForShutdown("external probe test complete");
    store.close();
  });

  test("unknown external effects block their attempt but leave independent units ready", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.units.push({
      ...definition.units[0], id: "independent", acceptance: [{ id: "independent-proof", kind: "manual", target: "fixture:independent" }],
    });
    definition.finalization.requiredPredicates.push("independent-proof");
    definition.authority.externalEffects = ["payments:charge"];
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const interrupted = await createInterruptedAttempt(sample);
    const store = await openFixtureStore(sample);
    const effectId = randomUUID();
    const inspection = store.inspectMission(interrupted.missionId);
    store.appendTransition(interrupted.missionId, inspection.version, { events: [
      { revision: inspection.revision, kind: "effect.intent", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { effectId, operation: "external:charge", grantId: "payments:charge", target: "account:unknown", operationKey: "payment-operation-unknown", requestHash: "b".repeat(64), adapterId: "payments-probe", adapterVersion: "1", recovery: "external-probe-required" } },
      { revision: inspection.revision, kind: "effect.invoking", causalId: randomUUID(), unitId: "snapshot", attemptId: interrupted.attemptId, effectId,
        payload: { effectId, operation: "external:charge" } },
    ] });
    const report = await reconcileMission({ store, missionId: interrupted.missionId, sourceRoot: sample.root, trigger: "unknown-external-effect" });
    expect(report.effects).toEqual([expect.objectContaining({ effectId, disposition: "unknown" })]);
    expect(report.frontier).toContain("independent");
    expect(report.frontier).not.toContain("snapshot");
    const launched: string[] = [];
    const engine = new MissionEngine({ store, missionId: interrupted.missionId,
      sessionsDirectory: path.join(sample.stateDir, "sessions"), managedWorkspace: { sourceRoot: sample.root },
      runRole: async ({ unit }) => { launched.push(unit.id); return { instanceId: unit.id, role: unit.role,
        status: "completed", model: { selectedModel: "fixture/local" }, result: "verified" }; },
      assessPredicate: () => ({ verdict: "pass", method: "independent fixture check" }),
    });
    engine.start(); await engine.waitForIdle();
    expect(launched).toEqual(["independent"]);
    expect(engine.snapshot().units.independent?.status).toBe("accepted");
    expect(engine.snapshot().state).toBe("blocked");
    await engine.close();
    recordT4Case(`external-effect-unknown-${interrupted.missionId}`, {
      actionReport: { status: report.status, effects: report.effects, blockers: report.blockers, frontier: report.frontier },
      exitReport: { duplicateInvocationPrevented: store.inspectMission(interrupted.missionId).events.filter((event) => event.kind === "effect.intent" && event.effectId === effectId).length === 1, independentReady: report.frontier.includes("independent") },
    });
    store.close();
  });

  test("engine routes bounded recovery consultations through frozen roles and root budgets", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.authority.rolePolicies.architect = { hash: "c".repeat(64), provider: "fixture", model: "local", fallbacks: [] };
    sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(sample.definitionFile, sample.definitionBytes);
    const interrupted = await createInterruptedAttempt(sample);
    const store = await openFixtureStore(sample);
    const roles: string[] = [];
    const engine = new MissionEngine({
      store, missionId: interrupted.missionId, sessionsDirectory: path.join(sample.stateDir, "sessions"),
      runRole: async ({ unit }, durable) => {
        roles.push(unit.role);
        const requestId = randomUUID();
        const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
        await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens: 4, outputTokens: 2, ticket });
        const result = unit.role === "developer"
          ? JSON.stringify({ disposition: "genuine-conflict", reason: "Both sides changed same declaration." })
          : JSON.stringify({ disposition: "compatible", reason: "Preserved both declarations.", resolutions: [{
              path: "src/app.ts", kind: "file", mode: 0o644,
              bytesBase64: Buffer.from("export const merged = true;\n").toString("base64"),
            }] });
        return { instanceId: randomUUID(), role: unit.role, status: "completed", model: { selectedModel: "fixture/local" }, result };
      },
    });
    const access = engine as unknown as { consultRecoveryOverlap(role: string, input: any): Promise<any> };
    const baseFile = { path: "src/app.ts", kind: "file" as const, mode: 0o644, bytes: Buffer.from("base\n") };
    const conflict = { path: "src/app.ts", base: baseFile, mission: { ...baseFile, bytes: Buffer.from("mission\n") }, current: { ...baseFile, bytes: Buffer.from("user\n") } };
    const developerInput = { missionId: interrupted.missionId, fingerprint: "d".repeat(64), diagnosisId: randomUUID(),
      attemptId: interrupted.attemptId, unitId: "snapshot", conflicts: [conflict], sourceManifestHash: "e".repeat(64), planStatus: "unchanged" as const };
    startRecoveryConsultation(store, developerInput, "developer");
    const developer = await access.consultRecoveryOverlap("developer", developerInput);
    const expertInput = { ...developerInput, fingerprint: "f".repeat(64), diagnosisId: randomUUID(), developerDiagnosis: developer };
    startRecoveryConsultation(store, expertInput, "architect");
    const expert = await access.consultRecoveryOverlap("architect", expertInput);
    expect(roles).toEqual(["developer", "architect"]);
    expect(developer.disposition).toBe("genuine-conflict");
    expect(expert.resolutions[0].bytes.toString()).toContain("merged");
    const events = store.inspectMission(interrupted.missionId).events;
    expect(events.filter((event) => event.kind === "reservation.created" && event.payload.resource === "role-launches")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "provider.request.receipt")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "mission.active.window.closed")).toHaveLength(2);
    await engine.close();
    store.close();
  });

  test.each(["before-dispatch", "after-dispatch", "stale-revision", "old-epoch", "old-start"] as const)(
    "recovery consultation %s keeps paid dispatch and answer behind its classified observation", async (scenario) => {
      const sample = fixture();
      const interrupted = await createInterruptedAttempt(sample);
      const store = await openFixtureStore(sample);
      const input = { missionId: interrupted.missionId, fingerprint: "d".repeat(64), diagnosisId: randomUUID(),
        attemptId: interrupted.attemptId, unitId: "snapshot", conflicts: [],
        sourceManifestHash: "e".repeat(64), planStatus: "unchanged" as const };
      const calls: string[] = [];
      const conflict = () => {
        const current = store.inspectMission(interrupted.missionId);
        store.appendTransition(interrupted.missionId, current.version, { events: [{ revision: current.revision,
          kind: "mission.import.conflict", causalId: randomUUID(), payload: { importKey: "new-global-conflict", archiveHashes: [] } }] });
      };
      const engine = new MissionEngine({ store, missionId: interrupted.missionId,
        sessionsDirectory: path.join(sample.stateDir, "sessions"),
        runRole: async (_role, durable) => {
          calls.push("role");
          if (scenario === "before-dispatch") conflict();
          try {
            const requestId = randomUUID();
            const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
            calls.push("dispatch");
            await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens: 3, outputTokens: 2, ticket });
          } catch { calls.push("denied"); }
          if (scenario === "after-dispatch") conflict();
          return { instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" },
            result: JSON.stringify({ disposition: "compatible", reason: "stale result", resolutions: [] }) };
        },
      });
      const inspection = store.inspectMission(interrupted.missionId);
      if (scenario === "old-start") {
        store.appendTransition(interrupted.missionId, inspection.version, { events: [{ revision: inspection.revision,
          kind: "mission.recovery.diagnosed", causalId: randomUUID(), attemptId: input.diagnosisId, unitId: input.unitId,
          payload: { diagnosisId: input.diagnosisId, fingerprint: input.fingerprint, role: "developer", status: "started",
            attemptId: input.attemptId, unitId: input.unitId } }] });
      } else startRecoveryConsultation(store, input, "developer", scenario === "old-epoch" ? store.ownerEpoch! - 1 : undefined,
        scenario === "stale-revision" ? inspection.revision - 1 : undefined);
      try {
        const answer = await (engine as unknown as { consultRecoveryOverlap(role: string, request: RecoveryOverlapRequest & { diagnosisId: string }): Promise<RecoveryOverlapAnswer> })
          .consultRecoveryOverlap("developer", input);
        const events = store.inspectMission(interrupted.missionId).events;
        expect(answer.disposition).toBe("unresolved");
        expect(events.filter(({ kind }) => kind === "provider.request.dispatched")).toHaveLength(scenario === "after-dispatch" ? 1 : 0);
        expect(events.filter(({ kind }) => kind === "provider.request.receipt")).toHaveLength(scenario === "after-dispatch" ? 1 : 0);
        expect(calls).toEqual(scenario === "before-dispatch" ? ["role", "denied"] :
          scenario === "after-dispatch" ? ["role", "dispatch"] : []);
      } finally { await engine.close(); store.close(); }
    }, 30_000);

  test.each(["current-ticks", "source-change", "control-during-await"] as const)(
    "source admission frontier %s uses fresh physical evidence for actual provider dispatch", async (scenario) => {
      const sample = fixture();
      const interrupted = await createInterruptedAttempt(sample);
      const store = await openFixtureStore(sample);
      const input = { missionId: interrupted.missionId, fingerprint: "d".repeat(64), diagnosisId: randomUUID(),
        attemptId: interrupted.attemptId, unitId: "snapshot", conflicts: [],
        sourceManifestHash: captureWorkspaceImage(sample.root).manifest.hash, planStatus: "unchanged" as const };
      let ticks = 0, dispatched = false, denied = "";
      let controlTimer: ReturnType<typeof setTimeout> | undefined;
      const engine = new MissionEngine({ store, missionId: interrupted.missionId,
        sessionsDirectory: path.join(sample.base, "sessions"), managedWorkspace: { sourceRoot: sample.root },
        runRole: async (_role, durable) => {
          if (scenario === "source-change") writeFileSync(path.join(sample.root, "src", "user.ts"), "changed after role admission\n");
          if (scenario === "control-during-await") controlTimer = setTimeout(() => {
            const current = store.inspectMission(interrupted.missionId);
            store.appendTransition(interrupted.missionId, current.version, { events: [{
              revision: current.revision, kind: "mission.import.conflict", causalId: randomUUID(),
              payload: { importKey: "changed-during-source-observation", archiveHashes: [] },
            }] });
          }, 0);
          try {
            const requestId = randomUUID();
            const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
            dispatched = true;
            await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens: 2, outputTokens: 1, ticket });
          } catch (error) { denied = String(error); }
          return { instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" },
            result: JSON.stringify({ disposition: "compatible", reason: "Current classified source", resolutions: [] }) };
        },
      });
      startRecoveryConsultation(store, input, "developer");
      const ticker = setInterval(() => {
        const current = store.inspectMission(interrupted.missionId);
        store.appendTransition(interrupted.missionId, current.version, { events: [{
          revision: current.revision, kind: "mission.active.duration", causalId: randomUUID(), payload: { durationMs: 0 },
        }] });
        ticks++;
      }, 20);
      try {
        const answer = await (engine as unknown as {
          consultRecoveryOverlap(role: string, request: RecoveryOverlapRequest & { diagnosisId: string }): Promise<RecoveryOverlapAnswer>;
        }).consultRecoveryOverlap("developer", input);
        console.log(JSON.stringify({ sourceAdmission: scenario, ticks, dispatched, denied, answer }));
        expect(ticks).toBeGreaterThan(0);
        expect(dispatched).toBe(scenario === "current-ticks");
        expect(answer.disposition).toBe(scenario === "current-ticks" ? "compatible" : "unresolved");
        if (scenario === "source-change") expect(denied).toContain("physical source or inputs changed");
        if (scenario === "control-during-await") expect(denied).toContain("control or result changed during observation");
        expect(store.inspectMission(interrupted.missionId).events.filter(event => event.kind === "provider.request.dispatched"))
          .toHaveLength(scenario === "current-ticks" ? 1 : 0);
      } finally {
        clearInterval(ticker);
        if (controlTimer) clearTimeout(controlTimer);
        await engine.close(); store.close();
      }
    }, 30_000);

  test("real overlap reconciliation admits bounded Developer and expert provider requests", async () => {
    const sample = fixture();
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.authority.rolePolicies.architect = { hash: "c".repeat(64), provider: "fixture", model: "local", fallbacks: [] };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    const interrupted = await createInterruptedAttempt(sample);
    writeFileSync(path.join(sample.root, "src", "app.ts"), "export const user = 'edited by user';\n");
    const store = await openFixtureStore(sample);
    const engine = new MissionEngine({ store, missionId: interrupted.missionId,
      sessionsDirectory: path.join(sample.stateDir, "sessions"), managedWorkspace: { sourceRoot: sample.root },
      runRole: async ({ unit }, durable) => {
        const requestId = randomUUID();
        const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
        await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens: 4, outputTokens: 2, ticket });
        return { instanceId: randomUUID(), role: unit.role, status: "completed", model: { selectedModel: "fixture/local" },
          result: unit.role === "developer" ? JSON.stringify({ disposition: "genuine-conflict", reason: "Both edited same declaration." }) :
            JSON.stringify({ disposition: "compatible", reason: "Both declarations retained.", resolutions: [{
              path: "src/app.ts", kind: "file", mode: 0o644,
              bytesBase64: Buffer.from("export const mission = 'partial mission write';\nexport const user = 'edited by user';\n").toString("base64"),
            }] }) };
      },
    });
    const access = engine as unknown as { consultRecoveryOverlap(role: string, input: RecoveryOverlapRequest & { diagnosisId: string; developerDiagnosis?: RecoveryOverlapAnswer }): Promise<RecoveryOverlapAnswer> };
    try {
      const report = await reconcileMission({ store, missionId: interrupted.missionId, sourceRoot: sample.root,
        candidateParent: path.join(sample.base, "recovered-candidates"), planFile: sample.planFile,
        resolveOverlap: { diagnose: (input) => access.consultRecoveryOverlap("developer", input),
          expertDisposition: (input) => access.consultRecoveryOverlap("architect", input) },
      });
      expect(report.status).toBe("resumed");
      expect(report.diagnoses.map(({ disposition }) => disposition)).toEqual(["genuine-conflict", "compatible"]);
      expect(store.inspectMission(interrupted.missionId).events.filter(({ kind }) => kind === "provider.request.dispatched")).toHaveLength(2);
      const repeated = await reconcileMission({ store, missionId: interrupted.missionId, sourceRoot: sample.root,
        candidateParent: path.join(sample.base, "recovered-candidates"), planFile: sample.planFile,
        resolveOverlap: { diagnose: () => { throw new Error("repeated paid call"); }, expertDisposition: () => { throw new Error("repeated paid call"); } },
      });
      expect(repeated).toEqual(report);
      expect(store.inspectMission(interrupted.missionId).events.filter(({ kind }) => kind === "provider.request.dispatched")).toHaveLength(2);
    } finally { await engine.close(); store.close(); }
  }, 30_000);

  test("cached completed diagnosis does not erase a later global import conflict", async () => {
    const sample = fixture();
    const interrupted = await createInterruptedAttempt(sample);
    writeFileSync(path.join(sample.root, "src", "app.ts"), "export const user = 'edited by user';\n");
    const store = await openFixtureStore(sample);
    try {
      const options = { store, missionId: interrupted.missionId, sourceRoot: sample.root,
        candidateParent: path.join(sample.base, "recovered-candidates"), planFile: sample.planFile };
      await expect(reconcileMission({ ...options,
        resolveOverlap: { diagnose: async () => ({ disposition: "genuine-conflict" as const, reason: "Both edited the same file." }),
          expertDisposition: async () => {
            const current = store.inspectMission(interrupted.missionId);
            store.appendTransition(interrupted.missionId, current.version, { events: [{ revision: current.revision,
              kind: "mission.import.conflict", causalId: randomUUID(), payload: { importKey: "later-global-conflict", archiveHashes: [] } }] });
            return { disposition: "unresolved" as const, reason: "Cannot merge." };
          } },
      })).rejects.toThrow(/recovery observation changed/);
      const completed = store.inspectMission(interrupted.missionId).events.filter(({ kind, payload }) =>
        kind === "mission.recovery.diagnosed" && payload.status === "completed");
      expect(completed).toHaveLength(2);
      const second = await reconcileMission({ ...options,
        resolveOverlap: { diagnose: async () => { throw new Error("repeated paid call"); },
          expertDisposition: async () => { throw new Error("repeated paid call"); } } });
      expect(second.status).toBe("blocked");
      expect(second.diagnoses.map(({ disposition }) => disposition)).toEqual(["genuine-conflict", "unresolved"]);
      expect(second.blockers).toContain("conflicting legacy ledger bytes are archived but unresolved; no second mission was created");
      expect(store.inspectMission(interrupted.missionId).events.filter(({ kind, payload }) =>
        kind === "mission.recovery.diagnosed" && payload.role === "developer" && payload.status === "completed")).toHaveLength(1);
    } finally { store.close(); }
  }, 30_000);

  test.each(["global-conflict", "new-owner", "unproven-owner", "unchanged", "ghost-hold", "disjoint-hold", "malformed-non-array", "malformed-missing-id", "malformed-numeric-id", "malformed-seal-race", "seal-race"] as const)(
    "completed compatible diagnosis %s requires current permission without another consultation", async (scenario) => {
      const sample = fixture();
      if (["disjoint-hold", "malformed-numeric-id"].includes(scenario)) {
        const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
        definition.units.push({ ...definition.units[0], id: "independent", acceptance: [{ ...definition.units[0].acceptance[0], id: "independent-present" }] });
        sample.definitionBytes = Buffer.from(JSON.stringify(definition));
        writeFileSync(sample.definitionFile, sample.definitionBytes);
      }
      const interrupted = await createInterruptedAttempt(sample);
      writeFileSync(path.join(sample.root, "src", "app.ts"), "export const user = 'edited by user';\n");
      const store = await openFixtureStore(sample);
      const occupiedParent = path.join(sample.base, "occupied-parent");
      writeFileSync(occupiedParent, "not a directory");
      const options = { missionId: interrupted.missionId, sourceRoot: sample.root,
        planFile: sample.planFile, candidateParent: path.join(sample.base, "recovered-candidates") };
      let calls = 0;
      try {
        const append = store.appendTransition.bind(store);
        store.appendTransition = (...args) => {
          if (args[2].events.some(({ kind }) => kind === "mission.recovery.recorded")) throw new Error("fixture crash before report");
          return append(...args);
        };
        await expect(reconcileMission({ ...options, store, candidateParent: occupiedParent, trigger: "seed-compatible",
          resolveOverlap: { diagnose: async ({ conflicts }) => {
            calls += 1;
            return { disposition: "compatible", reason: "Exact combined bytes", resolutions: [{
              path: conflicts[0]!.path, kind: "file", mode: 0o644,
              bytes: Buffer.from("export const mission = 'partial mission write';\nexport const user = 'edited by user';\n"),
            }] };
          }, expertDisposition: async () => { throw new Error("unexpected expert call"); } },
        })).rejects.toThrow("fixture crash before report");
        store.appendTransition = append;
        expect(store.inspectMission(interrupted.missionId).events.some(({ kind, payload }) =>
          kind === "mission.recovery.diagnosed" && payload.status === "completed")).toBe(true);
        expect(store.inspectMission(interrupted.missionId).events.filter(({ kind, payload }) =>
          kind === "workspace.snapshot.sealed" && payload.phase === "recovered")).toHaveLength(0);
        if (scenario === "ghost-hold" || scenario === "disjoint-hold") {
          renameSync(interrupted.candidateRoot, path.join(path.dirname(interrupted.candidateRoot), "moved-after-diagnosis"));
        }
        if (scenario === "ghost-hold") {
          const current = store.inspectMission(interrupted.missionId);
          store.appendTransition(interrupted.missionId, current.version, { events: [{ revision: current.revision,
            kind: "mission.imported", causalId: randomUUID(), payload: { holdsKnown: true,
              holds: [{ holdId: "ghost", unitId: "missing-unit", disposition: "unresolved" }] } }] });
        } else if (scenario === "disjoint-hold") {
          const current = store.inspectMission(interrupted.missionId);
          store.appendTransition(interrupted.missionId, current.version, { events: [{ revision: current.revision,
            kind: "mission.imported", causalId: randomUUID(), payload: { holdsKnown: true,
              holds: [{ holdId: "independent-hold", unitId: "independent", disposition: "unresolved" }] } }] });
        } else if (["malformed-non-array", "malformed-missing-id", "malformed-numeric-id"].includes(scenario)) {
          const current = store.inspectMission(interrupted.missionId);
          const holds = scenario === "malformed-non-array"
            ? { holdId: "bad", unitId: "missing-unit", disposition: "unresolved" }
            : scenario === "malformed-missing-id"
              ? [{ unitId: "missing-unit", disposition: "unresolved" }]
              : [{ holdId: 7, unitId: "missing-unit", disposition: "unresolved" },
                { holdId: "independent-hold", unitId: "independent", disposition: "unresolved" }];
          store.appendTransition(interrupted.missionId, current.version, { events: [{ revision: current.revision,
            kind: "mission.imported", causalId: randomUUID(), payload: { holdsKnown: true, holds } }] });
        } else if (scenario === "global-conflict") {
          const current = store.inspectMission(interrupted.missionId);
          store.appendTransition(interrupted.missionId, current.version, { events: [{ revision: current.revision,
            kind: "mission.import.conflict", causalId: randomUUID(), payload: { importKey: "new-global-conflict", archiveHashes: [] } }] });
        } else if (scenario === "new-owner") {
          const current = store.inspectMission(interrupted.missionId);
          store.appendTransition(interrupted.missionId, current.version, { events: [{ revision: current.revision,
            kind: "mission.owner.released", causalId: randomUUID(),
            payload: { owner: currentProcessIdentity(store.runtimeId, store.ownerEpoch!), reason: "fixture retirement",
              effectsQuiescent: true, resumablePause: true, interruptedAttempts: [interrupted.attemptId] } }] });
          store.close();
        }
        if (scenario === "unproven-owner") store.close();
        const resumed = scenario === "new-owner" || scenario === "unproven-owner" ? await openFixtureStore(sample) : store;
        try {
          if (scenario === "seal-race" || scenario === "malformed-seal-race") {
            let injected = false;
            resumed.appendTransition = (...args) => {
              if (!injected && args[2].events.some(({ kind, payload }) =>
                kind === "workspace.snapshot.sealed" && payload.phase === "recovered")) {
                injected = true;
                const current = resumed.inspectMission(interrupted.missionId);
                append(interrupted.missionId, current.version, { events: [{ revision: current.revision,
                  kind: scenario === "seal-race" ? "mission.import.conflict" : "mission.imported", causalId: randomUUID(),
                  payload: scenario === "seal-race" ? { importKey: "seal-race", archiveHashes: [] } :
                    { holdsKnown: true, holds: [{ unitId: "missing-unit", disposition: "unresolved" }] } }] });
              }
              return append(...args);
            };
          }
          const recover = () => reconcileMission({ ...options, store: resumed, trigger: "reuse-compatible",
            resolveOverlap: { diagnose: async () => { calls += 1; throw new Error("repeated paid call"); },
              expertDisposition: async () => { calls += 1; throw new Error("repeated expert call"); } },
          });
          if (scenario === "seal-race" || scenario === "malformed-seal-race") {
            await expect(recover()).rejects.toThrow(/recovery observation changed/);
            expect(resumed.inspectMission(interrupted.missionId).events.filter(({ kind, payload }) =>
              kind === "workspace.snapshot.sealed" && payload.phase === "recovered")).toHaveLength(0);
            expect(calls).toBe(1);
            if (scenario === "malformed-seal-race") {
              const report = await recover();
              expect(report.status).toBe("blocked");
              expect(report.frontier).toEqual([]);
              expect(report.disposition.causes).toContainEqual(expect.objectContaining({ scope: "mission" }));
              expect(calls).toBe(1);
            }
            return;
          }
          const report = await recover();
          expect(calls).toBe(1);
          expect(resumed.inspectMission(interrupted.missionId).events.filter(({ kind }) => kind === "provider.request.dispatched")).toHaveLength(0);
          expect(report.status).toBe(["global-conflict", "unproven-owner", "ghost-hold", "disjoint-hold"].includes(scenario) || scenario.startsWith("malformed-") ? "blocked" : "resumed");
          const recovered = resumed.inspectMission(interrupted.missionId).events.filter(({ kind, payload }) =>
            kind === "workspace.snapshot.sealed" && payload.phase === "recovered");
          expect(recovered).toHaveLength(["global-conflict", "unproven-owner", "ghost-hold"].includes(scenario) || scenario.startsWith("malformed-") ? 0 : 1);
          if (scenario.startsWith("malformed-")) {
            expect(report.candidate.restored).toBe(false);
            expect(report.frontier).toEqual([]);
            expect(report.disposition.causes).toContainEqual(expect.objectContaining({ scope: "mission" }));
            expect(report.blockers).toContain("legacy Team holds are malformed or unknown; no hold was cleared");
            if (scenario === "malformed-numeric-id") {
              expect(report.holds).toContainEqual({ holdId: "independent-hold", unitId: "independent", disposition: "unresolved" });
            }
            expect(report.diagnoses[0]?.disposition).toBe("compatible");
            const repeated = await recover();
            expect(repeated.status).toBe("blocked");
            expect(repeated.frontier).toEqual([]);
            expect(calls).toBe(1);
          } else if (scenario === "ghost-hold") {
            expect(report.candidate.restored).toBe(false);
            expect(report.frontier).toEqual([]);
            expect(report.disposition.causes).toContainEqual(expect.objectContaining({ scope: "mission" }));
            expect(recovered.some(({ payload }) => Boolean(payload.diagnosisUses))).toBe(false);
            expect(report.diagnoses[0]?.disposition).toBe("compatible");
          } else if (scenario === "unproven-owner") {
            expect(resumed.ownerEpoch).toBeNull();
            expect(report.blockers.some((reason) => /owner/.test(reason))).toBe(true);
          } else if (scenario === "global-conflict") {
            expect(report.blockers).toContain("conflicting legacy ledger bytes are archived but unresolved; no second mission was created");
            expect(report.candidate.restored).toBe(false);
          } else {
            expect(report.diagnoses[0]?.disposition).toBe("compatible");
            if (scenario === "disjoint-hold") {
              expect(report.frontier).toContain("snapshot");
              expect(report.frontier).not.toContain("independent");
            }
            expect((recovered[0]?.payload.diagnosisUses as Array<{ resultHash: string }> | undefined)?.[0]?.resultHash).toBe(report.diagnoses[0]?.resultHash ?? undefined);
            expect((recovered[0]?.payload.diagnosisUses as Array<{ ownerEpoch: number }> | undefined)?.[0]?.ownerEpoch).toBe(resumed.ownerEpoch ?? undefined);
          }
        } finally { if (resumed !== store) resumed.close(); }
      } finally { store.close(); }
    }, 30_000);

  test("recovery refuses to publish a stale report after a consultation appends a global conflict", async () => {
    const sample = fixture();
    const interrupted = await createInterruptedAttempt(sample);
    writeFileSync(path.join(sample.root, "src", "app.ts"), "export const user = 'edited by user';\n");
    const store = await openFixtureStore(sample);
    try {
      await expect(reconcileMission({ store, missionId: interrupted.missionId, sourceRoot: sample.root,
        candidateParent: path.join(sample.base, "recovered-candidates"), planFile: sample.planFile,
        resolveOverlap: { diagnose: async () => {
          const current = store.inspectMission(interrupted.missionId);
          store.appendTransition(interrupted.missionId, current.version, { events: [{ revision: current.revision,
            kind: "mission.import.conflict", causalId: randomUUID(), payload: { importKey: "late-global-conflict", archiveHashes: [] } }] });
          return { disposition: "genuine-conflict", reason: "stale result" };
        }, expertDisposition: async () => ({ disposition: "unresolved", reason: "should not apply" }) },
      })).rejects.toThrow(/recovery observation changed/);
      expect(store.inspectMission(interrupted.missionId).events.some(({ kind }) => kind === "mission.recovery.recorded")).toBe(false);
    } finally { store.close(); }
  }, 30_000);

  test("sealing and patch generation refuse sensitive changed paths", async () => {
    const sample = fixture();
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const workspace = await createMissionWorkspace({
      missionId: mission.id, attemptId: randomUUID(), sourceRoot: sample.root, storeRoot: store.storageRoot,
      candidateParent: path.join(sample.base, "candidates"), allowedPaths: ["."],
    });
    writeFileSync(path.join(workspace.candidateRoot, ".env"), "TOKEN=do-not-archive\n");
    expect(() => sealWorkspaceImage(captureWorkspaceImage(workspace.candidateRoot))).toThrow(/sensitive path/);
    store.close();
  });
});

function startRecoveryConsultation(
  store: Awaited<ReturnType<typeof openFixtureStore>>,
  input: RecoveryOverlapRequest & { diagnosisId: string; developerDiagnosis?: RecoveryOverlapAnswer },
  memberRole: string,
  ownerEpoch = store.ownerEpoch,
  revision?: number,
): void {
  const inspection = store.inspectMission(input.missionId);
  const sourceAttempt = inspection.events.find((event) => event.kind === "attempt.reserved" && event.attemptId === input.attemptId)!;
  const admission = {
    version: 1, revision: revision ?? inspection.revision, ownerEpoch, observedSeq: inspection.latestSeq,
    fingerprint: input.fingerprint, attemptId: input.attemptId, unitId: input.unitId,
    sourceEventId: sourceAttempt.eventId, sourceProofHash: createHash("sha256").update(JSON.stringify(sourceAttempt.payload)).digest("hex"),
    sourceManifestHash: input.sourceManifestHash, planStatus: input.planStatus, memberRole,
    briefHash: createHash("sha256").update(recoveryDiagnosisBrief(memberRole, input)).digest("hex"),
    rolePolicyHash: inspection.definition.authority.rolePolicies[memberRole]!.hash,
  };
  store.appendTransition(input.missionId, inspection.version, { events: [{
    revision: inspection.revision, kind: "mission.recovery.diagnosed", causalId: randomUUID(),
    attemptId: input.diagnosisId, unitId: input.unitId,
    payload: { diagnosisId: input.diagnosisId, fingerprint: input.fingerprint,
      role: memberRole === "developer" ? "developer" : "expert", status: "started",
      attemptId: input.attemptId, unitId: input.unitId, admission },
  }] });
}

function recordT4Case(name: string, value: unknown): void {
  const directory = process.env.MISSION_T4_ARTIFACT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function readFileText(file: string): string {
  return readFileSync(file, "utf8");
}
