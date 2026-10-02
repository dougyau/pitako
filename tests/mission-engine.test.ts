import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRunResult } from "../extensions/agent/run.ts";
import { MissionEngine, reduceMissionEvents, type MissionRoleRunner } from "../extensions/mission/engine.ts";
import { reconcileMission } from "../extensions/mission/reconcile.ts";
import { admitMissionChange, nextPlanBytes } from "../extensions/mission/admission.ts";
import type { MissionDefinition, MissionUnit } from "../extensions/mission/model.ts";
import { createMissionFixture, missionInput, missionDefinition, openFixtureStore, operatorChangeReceipt, type MissionFixture } from "./mission-fixtures.ts";

const fixtures: MissionFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture.base, { recursive: true, force: true });
});

function fixture(units: MissionUnit[], overrides: Partial<MissionDefinition["budget"]> = {}): MissionFixture {
  const sample = createMissionFixture("pitako-mission-engine-");
  fixtures.push(sample);
  const definition = missionDefinition();
  definition.goal = "Advance a durable fixture frontier";
  definition.units = units;
  definition.finalization.requiredPredicates = units.flatMap((unit) => unit.acceptance.map(({ id }) => id));
  definition.budget = {
    roleLaunches: 12,
    providerRequests: 16,
    tokens: 1600,
    activeTimeMs: 12000,
    artifactBytes: 12000,
    ...overrides,
  };
  definition.authority.rolePolicies = {
    developer: { hash: "a".repeat(64), provider: "fixture", model: "local", fallbacks: [] },
  };
  sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
  writeFileSync(sample.definitionFile, sample.definitionBytes);
  return sample;
}

function unit(id: string, dependencies: string[] = [], predicateId = `${id}-checked`): MissionUnit {
  return {
    id,
    dependencies,
    kind: "consultation",
    role: "developer",
    inputs: [],
    outputs: [`${id}.result`],
    acceptance: [{ id: predicateId, kind: "manual", target: `oracle:${id}` }],
    risk: "low",
    retryLimit: 0,
  };
}

async function mission(sample: MissionFixture) {
  const store = await openFixtureStore(sample);
  const record = store.createMission(missionInput(sample));
  return { store, record };
}

function result(text: string, requests?: AgentRunResult["requests"]): AgentRunResult {
  return {
    instanceId: "fixture-worker",
    role: "developer",
    status: "completed",
    model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
    result: text,
    ...(requests ? { requests } : {}),
    usage: { input: 7, output: 3, turns: 1, toolCalls: 0 },
  };
}

const assessAll = () => ({ verdict: "pass" as const, method: "fixture host observed expected output" });

describe("mission reducer and frontier pump", () => {
  test("blocked recovery frontier and unresolved import conflict cannot dispatch; resumed recovery can", async () => {
    const sample = fixture([unit("snapshot")]);
    const { store, record } = await mission(sample);
    let starts = 0;
    let conflictAttempts = -1;
    let conflictUnresolved = false;
    let blockedReport: Awaited<ReturnType<typeof reconcileMission>>;
    let blockedEvent: ReturnType<typeof store.inspectMission>["events"][number];
    let blockedArtifact: Buffer;
    let blockedAttempts = 0;
    let blockedAcceptances = 0;
    const engine = new MissionEngine({ store, missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      managedWorkspace: { sourceRoot: sample.root },
      runRole: async () => { starts++; return result("PASS"); }, assessPredicate: assessAll });
    const append = (kind: string, payload: Record<string, unknown>) => {
      const current = store.inspectMission(record.id);
      store.appendTransition(record.id, current.version, { events: [{ revision: current.revision, kind, causalId: randomUUID(), payload }] });
    };
    try {
      append("mission.activated", {});
      append("mission.import.conflict", { importKey: "legacy", archiveHashes: [] });
      append("mission.blocked", { reason: "import conflict" });
      blockedReport = await reconcileMission({ store, missionId: record.id, sourceRoot: sample.root, planFile: sample.planFile });
      expect(blockedReport.status).toBe("blocked");
      const blockedInspection = store.inspectMission(record.id);
      blockedEvent = [...blockedInspection.events].reverse().find(({ kind }) => kind === "mission.recovery.recorded")!;
      blockedArtifact = store.readArtifact(String(blockedEvent.payload.reportHash));
      blockedAttempts = blockedInspection.events.filter(({ kind }) => kind === "attempt.reserved").length;
      blockedAcceptances = blockedInspection.events.filter(({ kind }) => kind === "unit.accepted").length;
      expect(engine.snapshot().state).toBe("blocked");
      engine.start(); await engine.waitForIdle();
      expect(starts).toBe(0);
      expect(store.inspectMission(record.id).events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(0);
      const old = store.inspectMission(record.id);
      const next = structuredClone(old.definition);
      next.units[0]!.acceptance[0]!.target = "stricter";
      admitMissionChange({ store, engine, missionId: record.id, expectedVersion: old.version,
        planBytes: nextPlanBytes(old.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator",
        receipt: operatorChangeReceipt(store, old, next) });
      await engine.waitForIdle();
      expect(store.inspectMission(record.id).events.some(({ kind }) => kind === "unit.accepted")).toBe(false);
      // Even a stale resumed report cannot certify an unresolved import conflict.
      append("mission.recovery.recorded", { status: "resumed", frontier: ["snapshot"] });
      engine.start(); await engine.waitForIdle();
      expect(starts).toBe(0);
      const conflict = store.inspectMission(record.id);
      conflictAttempts = conflict.events.filter(({ kind }) => kind === "attempt.reserved").length;
      conflictUnresolved = conflict.events.some(({ kind }) => kind === "mission.import.conflict") &&
        !conflict.events.some(({ kind }) => kind === "mission.import.resolved");
    } finally { await engine.close(); store.close(); }

    const clean = fixture([unit("snapshot")]);
    const recovered = await mission(clean);
    const continuation = new MissionEngine({ store: recovered.store, missionId: recovered.record.id,
      sessionsDirectory: path.join(clean.stateDir, "pitako", "sessions"),
      runRole: async () => result("PASS"), assessPredicate: assessAll });
    try {
      const initial = recovered.store.inspectMission(recovered.record.id);
      recovered.store.appendTransition(recovered.record.id, initial.version, { events: [
        { revision: 1, kind: "mission.activated", causalId: randomUUID(), payload: {} },
        { revision: 1, kind: "mission.blocked", causalId: randomUUID(), payload: { reason: "shutdown" } },
        { revision: 1, kind: "mission.recovery.recorded", causalId: randomUUID(), payload: { status: "blocked", frontier: ["snapshot"] } },
      ] });
      continuation.start(); await continuation.waitForIdle();
      const blocked = recovered.store.inspectMission(recovered.record.id);
      expect(blocked.events.some(({ kind }) => kind === "attempt.reserved")).toBe(false);
      const before = blocked;
      recovered.store.appendTransition(recovered.record.id, before.version, { events: [
        { revision: 1, kind: "mission.recovery.recorded", causalId: randomUUID(), payload: { status: "resumed", frontier: ["snapshot"] } },
      ] });
      continuation.start(); await continuation.waitForIdle();
      expect(recovered.store.inspectMission(recovered.record.id).events.some(({ kind }) => kind === "attempt.reserved")).toBe(false);
      await continuation.close();
      const report = await reconcileMission({ store: recovered.store, missionId: recovered.record.id,
        sourceRoot: clean.root, planFile: clean.planFile });
      expect(report.status).toBe("resumed");
      const resumedEngine = new MissionEngine({ store: recovered.store, missionId: recovered.record.id,
        sessionsDirectory: path.join(clean.stateDir, "pitako", "sessions"),
        managedWorkspace: { sourceRoot: clean.root }, runRole: async () => result("PASS"), assessPredicate: assessAll });
      resumedEngine.start(); await resumedEngine.waitForIdle();
      await resumedEngine.close();
      const resumed = recovered.store.inspectMission(recovered.record.id);
      expect(resumed.events.some(({ kind }) => kind === "unit.accepted")).toBe(true);
      if (process.env.MISSION_T5_ARTIFACT_DIR) {
        mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
        writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "recovery-frontier-observed.json"), JSON.stringify({
          blockedStatus: blockedReport.status, blockedFrontier: blockedReport.frontier,
          blockedReport: JSON.parse(blockedArtifact.toString("utf8")), blockedReportEvent: blockedEvent,
          blockedReportHash: createHash("sha256").update(blockedArtifact).digest("hex"),
          blockedAttempts, blockedAcceptances,
          resumedStatus: [...resumed.events].reverse().find(({ kind }) => kind === "mission.recovery.recorded")?.payload.status,
          resumedAcceptances: resumed.events.filter(({ kind }) => kind === "unit.accepted").length,
          conflictAttempts, conflictUnresolved,
        }, null, 2));
      }
    } finally { await continuation.close(); recovered.store.close(); }
  });
  test.each(["provider", "effect"] as const)("global conflict immediately before %s invocation fences reserved attempt", async (boundary) => {
    const sample = fixture([unit("snapshot")]);
    const definition = JSON.parse(sample.definitionBytes.toString("utf8"));
    definition.authority.allowedPaths = ["."];
    definition.authority.operations = ["bash"];
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    const { store, record } = await mission(sample);
    let denied = false;
    const engine = new MissionEngine({ store, missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "sessions"), managedWorkspace: { sourceRoot: sample.root },
      runRole: async (_input, durable) => {
        const current = store.inspectMission(record.id);
        expect(current.events.some(({ kind }) => kind === "attempt.reserved")).toBe(true);
        store.appendTransition(record.id, current.version, { events: [{ revision: current.revision,
          kind: "mission.import.conflict", causalId: randomUUID(), payload: { importKey: "new-global-conflict" } }] });
        if (boundary === "provider") {
          try { await durable.onProviderDispatch({ requestId: randomUUID(), provider: "fixture", model: "local" }); }
          catch { denied = true; }
        } else {
          denied = (await durable.effects!.invoke("bash", { command: "printf SHOULD_NOT_RUN" })).status === "denied";
        }
        return result("unusable");
      }, assessPredicate: assessAll });
    try {
      engine.start(); await engine.waitForIdle();
      const events = store.inspectMission(record.id).events;
      expect(denied).toBe(true);
      expect(events.some(({ kind }) => kind === "provider.request.dispatched")).toBe(false);
      expect(events.some(({ kind }) => kind === "effect.intent" || kind === "effect.invoking")).toBe(false);
      expect(events.some(({ kind }) => kind === "unit.accepted")).toBe(false);
    } finally { await engine.close(); store.close(); }
  }, 30000);

  test("blocked recovery parks an in-flight receipt until a resumed report permits acceptance", async () => {
    const sample = fixture([unit("snapshot")]);
    const { store, record } = await mission(sample);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const engine = new MissionEngine({ store, missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole: async () => { await pending; return result("PASS"); }, assessPredicate: assessAll });
    try {
      engine.start();
      for (let i = 0; i < 100 && !store.inspectMission(record.id).events.some(({ kind }) => kind === "attempt.started"); i++) await Bun.sleep(10);
      const running = store.inspectMission(record.id);
      expect(running.events.some(({ kind }) => kind === "attempt.started")).toBe(true);
      store.appendTransition(record.id, running.version, { events: [{ revision: 1, kind: "mission.recovery.recorded",
        causalId: randomUUID(), payload: { status: "blocked", frontier: ["snapshot"] } }] });
      release();
      for (let i = 0; i < 100 && !store.inspectMission(record.id).events.some(({ kind }) => kind === "attempt.receipt"); i++) await Bun.sleep(10);
      await engine.waitForIdle();
      const blocked = store.inspectMission(record.id);
      expect(blocked.events.some(({ kind }) => kind === "attempt.receipt")).toBe(true);
      expect(blocked.events.some(({ kind }) => kind === "unit.accepted")).toBe(false);
      store.appendTransition(record.id, blocked.version, { events: [{ revision: 1, kind: "mission.recovery.recorded",
        causalId: randomUUID(), payload: { status: "resumed", frontier: ["snapshot"] } }] });
      engine.start(); await engine.waitForIdle();
      expect(engine.snapshot().units.snapshot?.status).not.toBe("accepted");
      await engine.retireForShutdown("quit");
      const restarted = await openFixtureStore(sample);
      const report = await reconcileMission({ store: restarted, missionId: record.id, sourceRoot: sample.root, planFile: sample.planFile });
      expect(report.status).toBe("resumed");
      const resumed = new MissionEngine({ store: restarted, missionId: record.id,
        sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
        managedWorkspace: { sourceRoot: sample.root }, runRole: async () => result("unexpected retry"), assessPredicate: assessAll });
      await resumed.control("resume"); await resumed.waitForIdle();
      expect(restarted.inspectMission(record.id).events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
      expect(resumed.snapshot().units.snapshot?.status).toBe("accepted");
      await resumed.close();
      restarted.close();
    } finally { release(); await engine.close(); store.close(); }
  });

  test("unsettled quit keeps unknown debt and cannot retry on explicit resume", async () => {
    const sample = fixture([unit("one")], { activeTimeMs: 240000 });
    const { store, record } = await mission(sample);
    const engine = new MissionEngine({ store, missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      managedWorkspace: { sourceRoot: sample.root },
      runRole: async () => new Promise<AgentRunResult>(() => {}) });
    engine.start();
    for (let i = 0; i < 100 && !store.inspectMission(record.id).events.some(({ kind }) => kind === "attempt.started"); i++) await Bun.sleep(10);
    expect(store.inspectMission(record.id).events.some(({ kind }) => kind === "attempt.started")).toBe(true);
    await engine.retireForShutdown("quit");
    const reopened = await openFixtureStore(sample);
    expect(reopened.inspectMission(record.id).state).toBe("paused");
    const successor = new MissionEngine({ store: reopened, missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      managedWorkspace: { sourceRoot: sample.root }, runRole: async () => result("recovered"), assessPredicate: assessAll });
    await successor.control("resume");
    await successor.waitForIdle();
    const after = reopened.inspectMission(record.id);
    expect(after.events.some(({ kind }) => kind === "mission.recovery.recorded")).toBe(true);
    expect(after.state).toBe("blocked");
    expect(after.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
    expect(after.events.some(({ kind }) => kind === "unit.accepted")).toBe(false);
    await successor.close(); reopened.close();
  }, 30000);

  test("journal, projection and manual cancellation agree across recovery and fresh preparation", async () => {
    const sample = fixture([unit("one")]);
    const { store, record } = await mission(sample);
    const engine = new MissionEngine({ store, missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole: async () => result("unused") });
    await engine.control("pause");
    expect(store.inspectMission(record.id).state).toBe("paused");
    await expect(engine.control("resume")).resolves.toBeUndefined();
    expect(store.inspectMission(record.id).state).toBe("running");
    await engine.waitForIdle();
    await engine.control("cancel");
    const cancelled = store.inspectMission(record.id);
    expect(cancelled.state).toBe("cancelled");
    store.appendTransition(record.id, cancelled.version, { events: [{ revision: cancelled.revision,
      kind: "mission.recovery.recorded", causalId: randomUUID(),
      payload: { status: "blocked", frontier: ["one"] } }] });
    expect(reduceMissionEvents(store.inspectMission(record.id)).state).toBe("cancelled");
    expect(store.inspectMission(record.id).state).toBe("cancelled");
    expect(() => engine.start()).toThrow("cannot start");
    expect(store.createMission(missionInput(sample, { commandId: randomUUID(), admissionReceiptId: randomUUID() })).id).not.toBe(record.id);
    await engine.close();
    store.close();
  });
  test("lost runner callback persists returned result and advances dependent frontier", async () => {
    const sample = fixture([unit("prepare"), unit("verify", ["prepare"])]);
    const { store, record } = await mission(sample);
    const starts: string[] = [];
    const runRole: MissionRoleRunner = async ({ unit: work }) => {
      starts.push(work.id);
      return result(`worker report for ${work.id}: PASS`);
    };
    const engine = new MissionEngine({
      store,
      missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole,
      assessPredicate: assessAll,
    });

    engine.start();
    await engine.waitForIdle();

    const inspection = store.inspectMission(record.id);
    const snapshot = engine.snapshot();
    expect(starts).toEqual(["prepare", "verify"]);
    expect(snapshot.units.prepare?.status).toBe("accepted");
    expect(snapshot.units.verify?.status).toBe("accepted");
    expect(snapshot.canFinalize).toBe(true);
    expect(snapshot.attempts && Object.keys(snapshot.attempts)).toHaveLength(2);
    expect(inspection.events.filter(({ kind }) => kind === "attempt.receipt")).toHaveLength(2);
    expect(inspection.events.filter(({ kind }) => kind === "unit.accepted")).toHaveLength(2);
    expect(inspection.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(2);
    const artifactReservations = inspection.events.filter(({ kind, payload }) => kind === "reservation.created" && payload.resource === "artifact-bytes" && payload.purpose === "ordinary");
    expect(artifactReservations.every((reservation) => {
      const settled = inspection.events.find(({ kind, payload }) => kind === "budget.reservation.settled" && payload.reservationId === reservation.payload.reservationId);
      return settled?.payload.knownCharge === Buffer.byteLength(`worker report for ${reservation.unitId}: PASS`);
    })).toBe(true);
    await engine.close();
    store.close();
  });

  test("uses runner return over conflicting duplicate callbacks without late job failure", async () => {
    const sample = fixture([unit("only")]);
    const { store, record } = await mission(sample);
    const returned = result("runner return is authoritative");
    let starts = 0;
    const engine = new MissionEngine({
      store,
      missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole: async (_input, durable) => {
        starts += 1;
        durable.onOutcome?.(result("first callback"));
        durable.onOutcome?.(result("conflicting duplicate callback"));
        return returned;
      },
      assessPredicate: assessAll,
    });

    engine.start();
    await expect(engine.waitForIdle()).resolves.toBeUndefined();

    const inspection = store.inspectMission(record.id);
    const receipts = inspection.events.filter(({ kind }) => kind === "attempt.receipt");
    expect(starts).toBe(1);
    expect(receipts).toHaveLength(1);
    expect(store.readArtifact(String(receipts[0]!.payload.artifactHash)).toString()).toBe(returned.result);
    expect(engine.snapshot().units.only?.status).toBe("accepted");
    await engine.close();
    store.close();
  });

  test("does not accept a PASS claim when independent artifact observation fails", async () => {
    const sample = fixture([unit("checks")]);
    const actualFile = path.join(sample.root, "actual-check.txt");
    mkdirSync(path.dirname(actualFile), { recursive: true });
    writeFileSync(actualFile, "FAIL\n");
    const { store, record } = await mission(sample);
    const engine = new MissionEngine({
      store,
      missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole: async (_input, context) => {
        const claimed = result("PASS");
        context.onOutcome?.(claimed);
        return claimed;
      },
      assessPredicate: ({ predicate }) => ({
        verdict: readFileSync(actualFile, "utf8").trim() === "PASS" ? "pass" : "fail",
        method: `read actual artifact ${predicate.target}`,
        artifactHash: "b".repeat(64),
      }),
    });

    engine.start();
    await engine.waitForIdle();

    expect(engine.snapshot().units.checks?.status).toBe("blocked");
    expect(engine.snapshot().evidence).toMatchObject([{ verdict: "fail", artifactHash: "b".repeat(64) }]);
    expect(engine.snapshot().canFinalize).toBe(false);
    await engine.close();
    store.close();
  });

  test("withholds success evidence until every local effect has a quiescent receipt", async () => {
    const stages = [
      ["effect.intent"],
      ["effect.intent", "effect.invoking"],
      ["effect.intent", "effect.invoking", "effect.process.registered"],
      ["effect.intent", "effect.invoking", "effect.process.registered", "effect.released"],
      ["effect.intent", "effect.invoking", "effect.process.registered", "effect.released", "effect.receipt"],
      ["effect.intent", "effect.invoking", "effect.process.registered", "effect.released", "effect.unknown"],
    ];

    for (const effectKinds of stages) {
      const sample = fixture([unit("managed")]);
      const { store, record } = await mission(sample);
      const inspection = store.inspectMission(record.id);
      const attemptId = randomUUID();
      const effectId = randomUUID();
      const artifact = Buffer.from("worker claims PASS");
      const artifactHash = createHash("sha256").update(artifact).digest("hex");
      const binding = {
        missionId: record.id, revision: 1, unitId: "managed", roundId: "main", memberId: "solo",
        attemptId, attemptNo: 1, ownerEpoch: store.ownerEpoch!, candidate: "managed" as const,
        candidateRoot: "/quarantined-candidate", inputManifestHash: "a".repeat(64),
        briefHash: "b".repeat(64), rolePolicyHash: "c".repeat(64),
      };
      const pidNamespace = "pid:[4026533000]";
      const identity = { pid: process.pid, pidNamespace, runtimeId: store.runtimeId, epoch: store.ownerEpoch };
      const events = [
        { kind: "mission.activated", payload: { missionId: record.id } },
        { kind: "attempt.reserved", unitId: "managed", attemptId, payload: { attemptId, binding, unitId: "managed", roundId: "main", memberId: "solo" } },
        ...effectKinds.map((kind) => ({
          kind, unitId: "managed", attemptId, effectId,
          payload: kind === "effect.receipt"
            ? { effectId, status: "failed", paths: [], process: { pidNamespace } }
            : { effectId, identity, processIdentity: identity, reason: kind === "effect.unknown" ? "receipt missing" : undefined },
        })),
        {
          kind: "attempt.receipt", unitId: "managed", attemptId,
          payload: { attemptId, unitId: "managed", status: "completed", artifactHash },
        },
      ].map((event) => ({
        revision: 1, causalId: randomUUID(), ...event,
      }));
      store.appendTransition(record.id, inspection.version, {
        events: events as never,
        artifacts: [{ bytes: artifact, mediaType: "text/plain; charset=utf-8" }],
      });

      let assessments = 0;
      const engine = new MissionEngine({
        store, missionId: record.id, sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
        runRole: async () => result("unused"),
        assessPredicate: () => { assessments += 1; return assessAll(); },
      });
      try {
        engine.start();
        await engine.waitForIdle();
        const saved = store.inspectMission(record.id).events;
        expect(assessments).toBe(0);
        expect(saved.some(({ kind }) => kind === "evidence.recorded")).toBe(false);
        expect(saved.some(({ kind }) => kind === "unit.accepted")).toBe(false);
        expect(saved.find(({ kind }) => kind === "attempt.settled")?.payload.status).toBe("failed");
        expect(engine.snapshot().units.managed?.status).toBe("blocked");
      } finally {
        await engine.close();
        store.close();
      }
    }

    const sample = fixture([unit("managed")]);
    const { store, record } = await mission(sample);
    const inspection = store.inspectMission(record.id);
    const attemptId = randomUUID();
    const effectId = randomUUID();
    const artifact = Buffer.from("observed result");
    const artifactHash = createHash("sha256").update(artifact).digest("hex");
    const binding = {
      missionId: record.id, revision: 1, unitId: "managed", roundId: "main", memberId: "solo",
      attemptId, attemptNo: 1, ownerEpoch: store.ownerEpoch!, candidate: "managed" as const,
      candidateRoot: "/observed-candidate", inputManifestHash: "a".repeat(64),
      briefHash: "b".repeat(64), rolePolicyHash: "c".repeat(64),
    };
    const request = { command: "fixture" };
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const candidate = { candidateId: `${record.id}:${attemptId}`, root: binding.candidateRoot,
      rootIdentity: "identity", gitDir: "git", gitIdentity: "git-identity", arenaRoot: "arena", arenaIdentity: "arena-identity" };
    const planBytes = Buffer.from(JSON.stringify({ format: "mission-effect-plan-v1", request, requestHash,
      preconditions: [], beforeImageHash: createHash("sha256").update("[]").digest("hex"), deterministic: false, candidate }));
    const effectPlanHash = createHash("sha256").update(planBytes).digest("hex");
    const pidNamespace = "pid:[4026533001]";
    const processIdentity = {
      hostId: "host-fixture", bootId: "boot-fixture", pid: process.pid, birthTicks: 123,
      containedPid: 1, pidNamespace, networkNamespace: "net:[4026533001]",
      runtimeId: store.runtimeId, epoch: store.ownerEpoch,
    };
    store.appendTransition(record.id, inspection.version, {
      events: [
        { kind: "mission.activated", payload: { missionId: record.id } },
        { kind: "attempt.reserved", unitId: "managed", attemptId, payload: { attemptId, binding, unitId: "managed", roundId: "main", memberId: "solo" } },
        { kind: "effect.intent", unitId: "managed", attemptId, effectId, payload: {
          effectId, attemptId, missionId: record.id, operation: "write", owner: processIdentity, requestHash, effectPlanHash,
          candidate: candidate.root, candidateId: candidate.candidateId, candidateIdentity: candidate.rootIdentity,
          candidateGitDir: candidate.gitDir, candidateGitIdentity: candidate.gitIdentity,
          candidateArenaRoot: candidate.arenaRoot, candidateArenaIdentity: candidate.arenaIdentity,
        } },
        ...["effect.invoking", "effect.process.registered", "effect.released"].map((kind) => ({
          kind, unitId: "managed", attemptId, effectId, payload: { effectId, identity: processIdentity, processIdentity, owner: processIdentity },
        })),
        {
          kind: "effect.receipt", unitId: "managed", attemptId, effectId,
          payload: {
            effectId, status: "completed", paths: [],
            process: { ...processIdentity, descendantsQuiescent: true, namespaceEmptyAfterExit: true },
          },
        },
        { kind: "attempt.receipt", unitId: "managed", attemptId, payload: { attemptId, unitId: "managed", status: "completed", artifactHash } },
      ].map((event) => ({ revision: 1, causalId: randomUUID(), ...event })) as never,
      artifacts: [{ bytes: artifact, mediaType: "text/plain; charset=utf-8" }, { bytes: planBytes, mediaType: "application/json" }],
    });
    const engine = new MissionEngine({
      store, missionId: record.id, sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole: async () => result("unused"), assessPredicate: assessAll,
    });
    try {
      engine.start();
      await engine.waitForIdle();
      expect(store.inspectMission(record.id).events.some(({ kind }) => kind === "evidence.recorded")).toBe(true);
      expect(engine.snapshot().units.managed?.status).toBe("accepted");
    } finally {
      await engine.close();
      store.close();
    }
  });

  test("keeps unknown exposure sticky and rejects invoking receipts without registered identity", async () => {
    for (const mode of ["unknown-then-receipt", "invoking-without-identity"] as const) {
      const sample = fixture([unit("managed")]);
      const { store, record } = await mission(sample);
      const inspection = store.inspectMission(record.id);
      const attemptId = randomUUID();
      const effectId = randomUUID();
      const artifact = Buffer.from("worker claims PASS");
      const artifactHash = createHash("sha256").update(artifact).digest("hex");
      const binding = {
        missionId: record.id, revision: 1, unitId: "managed", roundId: "main", memberId: "solo",
        attemptId, attemptNo: 1, ownerEpoch: store.ownerEpoch!, candidate: "managed" as const,
        candidateRoot: "/quarantined-candidate", inputManifestHash: "a".repeat(64),
        briefHash: "b".repeat(64), rolePolicyHash: "c".repeat(64),
      };
      const pidNamespace = "pid:[4026533002]";
      const identity = {
        hostId: "host-fixture", bootId: "boot-fixture", pid: process.pid, birthTicks: 456,
        containedPid: 1, pidNamespace, networkNamespace: "net:[4026533002]",
        runtimeId: store.runtimeId, epoch: store.ownerEpoch,
      };
      const effectKinds = mode === "unknown-then-receipt"
        ? ["effect.intent", "effect.invoking", "effect.process.registered", "effect.released", "effect.unknown"]
        : ["effect.intent", "effect.invoking"];
      const effectEvents = effectKinds.map((kind) => ({
        kind, unitId: "managed", attemptId, effectId,
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
      store.appendTransition(record.id, inspection.version, {
        events: [
          { kind: "mission.activated", payload: { missionId: record.id } },
          { kind: "attempt.reserved", unitId: "managed", attemptId, payload: { attemptId, binding, unitId: "managed", roundId: "main", memberId: "solo" } },
          ...effectEvents,
          {
            kind: "effect.receipt", unitId: "managed", attemptId, effectId,
            payload: { effectId, status: "completed", paths: [], process: processClaim },
          },
          { kind: "attempt.receipt", unitId: "managed", attemptId, payload: { attemptId, unitId: "managed", status: "completed", artifactHash } },
        ].map((event) => ({ revision: 1, causalId: randomUUID(), ...event })) as never,
        artifacts: [{ bytes: artifact, mediaType: "text/plain; charset=utf-8" }],
      });

      let assessments = 0;
      const engine = new MissionEngine({
        store, missionId: record.id, sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
        runRole: async () => result("unused"),
        assessPredicate: () => { assessments += 1; return assessAll(); },
      });
      try {
        engine.start();
        await engine.waitForIdle();
        const saved = store.inspectMission(record.id).events;
        expect(assessments).toBe(0);
        expect(saved.some(({ kind }) => kind === "evidence.recorded")).toBe(false);
        expect(saved.some(({ kind }) => kind === "unit.accepted")).toBe(false);
        expect(saved.find(({ kind }) => kind === "attempt.settled")?.payload.status).toBe("failed");
        expect(engine.snapshot().units.managed?.status).toBe("blocked");
      } finally {
        await engine.close();
        store.close();
      }
    }
  });

  test("dispatches another ready unit while a sibling remains slow", async () => {
    const sample = fixture([unit("slow"), unit("fast"), unit("after-fast", ["fast"])]);
    const { store, record } = await mission(sample);
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const starts: string[] = [];
    const runner: MissionRoleRunner = async ({ unit: work }, context) => {
      starts.push(work.id);
      if (work.id === "slow") await slowGate;
      const output = result(work.id);
      context.onOutcome?.(output);
      return output;
    };
    const engine = new MissionEngine({
      store,
      missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole: runner,
      assessPredicate: assessAll,
      maxConcurrent: 2,
    });

    engine.start();
    await waitUntil(() => starts.includes("after-fast"));
    expect(starts).toContain("slow");
    expect(starts).toContain("fast");
    expect(starts.indexOf("after-fast")).toBeGreaterThan(starts.indexOf("fast"));
    releaseSlow();
    await engine.waitForIdle();
    expect(engine.snapshot().units["after-fast"]?.status).toBe("accepted");
    await engine.close();
    store.close();
  });

  test("keeps root reservations across concurrent writers and orderly restart", async () => {
    const sample = fixture([unit("only")], { roleLaunches: 4 });
    const { store, record } = await mission(sample);
    const engine = new MissionEngine({
      store,
      missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole: async (_input, context) => {
        const output = result("done");
        context.onOutcome?.(output);
        return output;
      },
      assessPredicate: assessAll,
    });
    engine.start();
    await engine.waitForIdle();
    const inspection = store.inspectMission(record.id);
    const currentVersion = inspection.version;
    const extra = () => ({
      revision: 1,
      kind: "reservation.created",
      causalId: randomUUID(),
      payload: { reservationId: randomUUID(), revision: 1, resource: "role-launches", amount: 1, purpose: "ordinary" },
    });
    const transition = (draft: ReturnType<typeof extra>) => store.appendTransition(record.id, currentVersion, {
      events: [draft],
    });
    const concurrent = await Promise.allSettled([Promise.resolve().then(() => transition(extra())), Promise.resolve().then(() => transition(extra()))]);
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await engine.retireForShutdown("orderly-fixture-restart");
    store.close();

    const reopened = await openFixtureStore(sample);
    const afterRestart = reopened.inspectMission(record.id);
    expect(afterRestart.reservations.filter(({ resource }) => resource === "role-launches").reduce((sum, row) => sum + row.amount, 0)).toBe(4);
    const next = extra();
    expect(() => reopened.appendTransition(record.id, afterRestart.version, { events: [next] })).toThrow(/reservation exceeds root budget/);
    reopened.close();
  });

  test.each([
    { providerRequests: 4, tokens: 200, retryAdmitted: false, denial: "provider-requests" },
    { providerRequests: 5, tokens: 201, retryAdmitted: false, denial: "tokens" },
    { providerRequests: 5, tokens: 200, retryAdmitted: true, denial: "" },
  ])("root retry preserves beta's first provider/token grant ($providerRequests requests, $tokens tokens)",
    async ({ providerRequests, tokens, retryAdmitted, denial }) => {
      const alpha = { ...unit("alpha"), retryLimit: 1 };
      const sample = fixture([alpha, unit("beta")], {
        roleLaunches: 5, providerRequests, tokens, activeTimeMs: 300000, artifactBytes: 5000,
      });
      const { store, record } = await mission(sample);
      let releaseBeta!: () => void;
      const betaGate = new Promise<void>((resolve) => { releaseBeta = resolve; });
      const calls: Array<{ unit: string; attemptNo: number; admitted: boolean; error: string; requestId: string }> = [];
      const engine = new MissionEngine({ store, missionId: record.id,
        sessionsDirectory: path.join(sample.stateDir, "sessions"),
        runRole: async ({ unit: current, binding }, durable) => {
          if (current.id === "beta") await betaGate;
          const requestId = randomUUID();
          let admitted = false;
          let error = "";
          try {
            const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
            admitted = true;
            if (current.id === "beta") await durable.onProviderReceipt({
              requestId, provider: "fixture", model: "local", inputTokens: 1, outputTokens: 1, ticket,
            });
          } catch (caught) { error = String(caught); }
          calls.push({ unit: current.id, attemptNo: binding.attemptNo, admitted, error, requestId });
          if (current.id === "alpha" && binding.attemptNo === 2) releaseBeta();
          return { ...result(current.id === "beta" && admitted ? "PASS" : ""),
            status: current.id === "beta" && admitted ? "completed" : "failed" };
        }, assessPredicate: assessAll });
      try {
        engine.start(); await engine.waitForIdle();
        const inspection = store.inspectMission(record.id);
        const retry = calls.find(({ unit: id, attemptNo }) => id === "alpha" && attemptNo === 2);
        const beta = calls.find(({ unit: id }) => id === "beta");
        expect(calls.filter(({ unit: id }) => id === "alpha")).toHaveLength(2);
        expect(retry).toMatchObject({ admitted: retryAdmitted });
        expect(retry?.error).toMatch(denial ? new RegExp(`ordinary ${denial} is reserved for remaining root slots`) : /^$/);
        expect(beta).toMatchObject({ attemptNo: 1, admitted: true, error: "" });
        const dispatched = inspection.events.filter(({ kind }) => kind === "provider.request.dispatched");
        expect(dispatched.map(({ payload }) => payload.requestId)).toContain(beta?.requestId);
        expect(dispatched.some(({ payload }) => payload.requestId === retry?.requestId)).toBe(retryAdmitted);
        expect(dispatched).toHaveLength(retryAdmitted ? 3 : 2);
        expect(engine.snapshot().units.beta?.status).toBe("accepted");
        expect(inspection.reservations.filter(({ purpose }) => purpose === "protected").map(({ amount }) => amount))
          .toEqual([2, 2, 2 * Math.ceil(tokens / providerRequests), 120000, 2000]);
      } finally { releaseBeta(); await engine.close(); store.close(); }
    });

  test("records unknown provider usage once and measures only active time", async () => {
    const sample = fixture([unit("observe")]);
    const { store, record } = await mission(sample);
    let clock = 100;
    const requestId = randomUUID();
    const runRole: MissionRoleRunner = async (_input, context) => {
      const ticket = await context.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
      clock += 7;
      const receipt = {
        requestId,
        provider: "fixture",
        model: "local",
        inputTokens: null,
        outputTokens: null,
        usageUnknownReason: "fixture omitted usage",
        ticket,
      };
      await context.onProviderReceipt(receipt);
      await context.onProviderReceipt(receipt);
      clock += 3;
      const output = result("worker report", [{
        requestId, provider: "fixture", model: "fixture/local", fast_requested: false,
        returned_service_tier: "unavailable", time_to_first_model_output_ms: 7,
        inputTokens: null, outputTokens: null,
      }]);
      context.onOutcome?.(output);
      return output;
    };
    const engine = new MissionEngine({
      store,
      missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole,
      assessPredicate: assessAll,
      now: () => clock,
    });

    engine.start();
    await engine.waitForIdle();
    const active = engine.snapshot().activeTimeMs;
    const inspection = store.inspectMission(record.id);
    expect(active).toBe(10);
    expect(inspection.events.filter(({ kind }) => kind === "provider.request.dispatched")).toHaveLength(1);
    expect(inspection.events.filter(({ kind }) => kind === "provider.request.receipt")).toHaveLength(1);
    expect(inspection.measurements).toHaveLength(1);
    expect(inspection.measurements[0]).toMatchObject({ value: null, inputTokens: null, outputTokens: null, usageUnknownReason: "fixture omitted usage" });
    expect(inspection.measurements[0]?.durationMs).toBe(7);
    const activeReservations = inspection.reservations.filter(({ resource, purpose }) => resource === "active-time-ms" && purpose === "ordinary");
    expect(activeReservations.reduce((sum, row) => sum + row.amount, 0)).toBe(10);
    expect(store.replayMission(record.id).reservations).toEqual(inspection.reservations);

    const beforeClose = engine.snapshot().activeTimeMs;
    clock += 6 * 60 * 60 * 1000;
    await engine.close();
    expect(engine.snapshot().activeTimeMs).toBe(beforeClose);
    store.close();
  });

  test("reserves one short active-time quantum then persists measured duration through reopen", async () => {
    const sample = fixture([unit("only")], { activeTimeMs: 12000, roleLaunches: 12 });
    const { store, record } = await mission(sample);
    let clock = 10;
    let finishRunner!: () => void;
    let runnerStarted = false;
    const runnerGate = new Promise<void>((resolve) => { finishRunner = resolve; });
    const engine = new MissionEngine({
      store,
      missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      now: () => clock,
      runRole: async () => {
        runnerStarted = true;
        await runnerGate;
        clock += 19;
        return result("done");
      },
      assessPredicate: assessAll,
    });

    engine.start();
    await waitUntil(() => runnerStarted);
    const during = store.inspectMission(record.id).reservations.filter(({ resource, purpose }) => resource === "active-time-ms" && purpose === "ordinary");
    expect(during.reduce((sum, row) => sum + row.amount, 0)).toBe(1000);
    finishRunner();
    await engine.waitForIdle();

    const settled = store.inspectMission(record.id);
    const active = settled.reservations.filter(({ resource, purpose }) => resource === "active-time-ms" && purpose === "ordinary");
    expect(active.reduce((sum, row) => sum + row.amount, 0)).toBe(19);
    expect(engine.snapshot().activeTimeMs).toBe(19);
    await engine.retireForShutdown("orderly-fixture-restart");
    store.close();

    const reopened = await openFixtureStore(sample);
    expect(reopened.inspectMission(record.id).reservations.filter(({ resource, purpose }) => resource === "active-time-ms" && purpose === "ordinary").reduce((sum, row) => sum + row.amount, 0)).toBe(19);
    reopened.close();
  });

  test("underfunded mandatory path fails activation and member slots remain distinct", async () => {
    const sample = fixture([unit("one"), unit("two")], { roleLaunches: 3 });
    const { store, record } = await mission(sample);
    const engine = new MissionEngine({
      store,
      missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole: async () => result("unused"),
      assessPredicate: assessAll,
    });
    expect(() => engine.start()).toThrow(/mandatory path needs 4 role launches/);
    const inspection = store.inspectMission(record.id);
    const attemptEvent = (memberId: string, attemptId: string) => ({
      revision: 1,
      kind: "attempt.reserved",
      causalId: randomUUID(),
      unitId: "one",
      attemptId,
      payload: {
        attemptId,
        unitId: "one",
        roundId: "round-1",
        memberId,
        binding: {
          missionId: record.id, revision: 1, unitId: "one", roundId: "round-1", memberId,
          attemptId, attemptNo: 1, ownerEpoch: store.ownerEpoch, candidate: "read-only",
          inputManifestHash: "c".repeat(64), briefHash: "d".repeat(64), rolePolicyHash: "a".repeat(64),
        },
      },
    });
    store.appendTransition(record.id, inspection.version, { events: [attemptEvent("member-a", randomUUID()), attemptEvent("member-b", randomUUID())] });
    const afterMembers = store.inspectMission(record.id);
    expect(() => store.appendTransition(record.id, afterMembers.version, { events: [attemptEvent("member-a", randomUUID())] })).toThrow(/active attempt slot/);
    store.close();
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for frontier dispatch");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
