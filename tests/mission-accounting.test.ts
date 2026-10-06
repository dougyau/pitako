import { createHash, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { AgentRunResult } from "../extensions/agent/run.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore, type MissionFixture } from "./mission-fixtures.ts";
import type { MissionEventDraft } from "../extensions/mission/store.ts";

const fixtures: MissionFixture[] = [];
const accountingProbes: Array<{ id: string; facts: Record<string, unknown>; assertionsPassed: boolean }> = [];
afterAll(() => {
  const observationPath = process.env.MISSION_ACCOUNTING_OBSERVATION_PATH;
  if (observationPath) writeFileSync(observationPath, `${JSON.stringify({ probes: accountingProbes }, null, 2)}\n`);
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture.base, { recursive: true, force: true });
});

function result(text: string, requests?: AgentRunResult["requests"]): AgentRunResult {
  return {
    instanceId: "accounting-worker",
    role: "developer",
    status: "completed",
    model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
    result: text,
    ...(requests ? { requests } : {}),
  };
}

const pass = () => ({ verdict: "pass" as const, method: "independent fixture check" });

describe("mission resource accounting", () => {
  test("ordinary requests cannot spend the extra protected Ponytail slot", async () => {
    const fixture = createMissionFixture("pitako-accounting-ponytail-slot-");
    fixtures.push(fixture);
    const definition = missionDefinition();
    definition.finalization.contractVersion = 1;
    definition.budget = { roleLaunches: 6, providerRequests: 32, tokens: 200000, activeTimeMs: 900000, artifactBytes: 67108864 };
    writeFileSync(fixture.definitionFile, JSON.stringify(definition));
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    let rejected = false;
    const engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(fixture.stateDir, "sessions"),
      runRole: async (_input, durable) => {
        for (let index = 0; index < 28; index++) {
          const requestId = randomUUID();
          const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
          await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens: 1, outputTokens: 1, ticket });
        }
        await expect(durable.onProviderDispatch({ requestId: randomUUID(), provider: "fixture", model: "local" }))
          .rejects.toThrow();
        rejected = true;
        return { ...result("intentional stop"), status: "failed", error: "no completion claim" };
      },
    });
    try {
      engine.start(); await engine.waitForIdle();
      expect(rejected).toBe(true);
      const inspection = store.inspectMission(mission.id);
      expect(inspection.events.filter(row => row.kind === "provider.request.dispatched")).toHaveLength(28);
      expect(inspection.reservations.find(row => row.resource === "provider-requests" && row.purpose === "protected")?.amount).toBe(4);
    } finally { await engine.close(); store.close(); }
  });

  test.each([false, true])("reserves ordinary token slack without borrowing finalization (versioned %s)", async (versioned) => {
    const fixture = createMissionFixture("pitako-accounting-token-slack-");
    fixtures.push(fixture);
    const definition = missionDefinition();
    if (versioned) definition.finalization.contractVersion = 1;
    definition.budget = { roleLaunches: 6, providerRequests: 12, tokens: 200000, activeTimeMs: 900000, artifactBytes: 67108864 };
    fixture.definitionBytes = Buffer.from(JSON.stringify(definition));
    writeFileSync(fixture.definitionFile, fixture.definitionBytes);
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    const engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(fixture.stateDir, "sessions"),
      runRole: async (_input, durable) => {
        for (const [inputTokens, outputTokens] of [[14994, 299], [15801, 1186]]) {
          const requestId = randomUUID();
          const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
          await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens, outputTokens, ticket });
        }
        const requestId = randomUUID();
        const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
        await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens: null, outputTokens: null, ticket });
        return { ...result("intentional stop"), status: "failed", error: "no completion claim" };
      },
    });
    try {
      engine.start();
      await engine.waitForIdle();
      const inspection = store.inspectMission(mission.id);
      const ordinary = inspection.reservations.filter(row => row.resource === "tokens" && row.purpose === "ordinary");
      const protectedTokens = versioned ? 66668 : 33334;
      expect(ordinary.map(row => row.knownCharge)).toEqual([15293, 16987, 0]);
      for (const row of ordinary) {
        expect(row.grantAmount).toBeGreaterThan(16987);
        expect(row.grantAmount).toBeLessThanOrEqual(200000 - protectedTokens);
      }
      expect(ordinary.every(row => row.overage === 0)).toBe(true);
      expect(ordinary[2]!.unknownCharge).toBe(ordinary[2]!.grantAmount);
      expect(inspection.reservations.find(row => row.resource === "tokens" && row.purpose === "protected")?.amount).toBe(protectedTokens);
      expect(inspection.events.some(row => row.kind === "budget.admission.fenced")).toBe(false);
    } finally {
      await engine.close();
      store.close();
    }
  });

  test("reconciles runner usage claims without rebilling or rejecting the attempt receipt", async () => {
    const fixture = createMissionFixture("pitako-accounting-usage-");
    fixtures.push(fixture);
    const definition = missionDefinition();
    definition.units = [
      { ...definition.units[0]!, id: "first", outputs: ["first"], acceptance: [{ id: "first-ok", kind: "manual", target: "first" }] },
      { ...definition.units[0]!, id: "second", dependencies: ["first"], outputs: ["second"], acceptance: [{ id: "second-ok", kind: "manual", target: "second" }] },
    ];
    definition.finalization.requiredPredicates = ["first-ok", "second-ok"];
    definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 100, activeTimeMs: 60000, artifactBytes: 12000 };
    fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(fixture.definitionFile, fixture.definitionBytes);
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    const requestId = randomUUID();
    const starts: string[] = [];
    const engine = new MissionEngine({
      store,
      missionId: mission.id,
      sessionsDirectory: path.join(fixture.stateDir, "sessions"),
      runRole: async ({ unit }, durable) => {
        starts.push(unit.id);
        const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
        await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens: 120, outputTokens: 60, ticket });
        await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens: 3, outputTokens: 4, ticket });
        return result("verified result", [{
          requestId, provider: "fixture", model: "fixture/local", fast_requested: false,
          returned_service_tier: "unavailable", time_to_first_model_output_ms: "unavailable",
          inputTokens: 3, outputTokens: 4,
        }]);
      },
      assessPredicate: pass,
    });

    engine.start();
    await engine.waitForIdle();

    const inspection = store.inspectMission(mission.id);
    const tokenReservations = inspection.reservations.filter(({ resource }) => resource === "tokens");
    expect(starts).toEqual(["first"]);
    expect(inspection.events.filter(({ kind }) => kind === "attempt.receipt")).toHaveLength(1);
    expect(inspection.events.filter(({ kind }) => kind === "provider.request.receipt")).toHaveLength(1);
    expect(inspection.measurements.map(({ value }) => value)).toEqual([180]);
    expect(tokenReservations.reduce((sum, row) => sum + (row.purpose === "protected" ? row.amount : 0), 0)).toBe(50);
    expect(tokenReservations.reduce((sum, row) => sum + (row.purpose === "ordinary" ? row.amount : 0), 0)).toBe(180);
    const claims = inspection.events.filter(({ kind }) => kind === "provider.usage.claimed");
    expect(claims).toHaveLength(2);
    expect(claims.map(({ payload }) => payload.source).sort()).toEqual(["provider-hook-duplicate", "runner-result"]);
    expect(inspection.events.some(({ kind }) => kind === "budget.admission.fenced")).toBe(true);
    expect(inspection.events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "first")).toBe(true);
    expect(inspection.events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "second")).toBe(false);
    recordAccountingProbe("provider-usage-reconciliation", {
      canonicalReceiptCount: inspection.events.filter(({ kind }) => kind === "provider.request.receipt").length,
      measurementValues: inspection.measurements.map(({ value }) => value),
      claims: claims.map(({ payload }) => payload.source),
      protectedTokens: tokenReservations.filter(({ purpose }) => purpose === "protected").reduce((sum, row) => sum + row.amount, 0),
      actualTokenOccupancy: tokenReservations.filter(({ purpose }) => purpose === "ordinary").reduce((sum, row) => sum + row.amount, 0),
      admissionFenced: inspection.events.some(({ kind }) => kind === "budget.admission.fenced"),
      firstAccepted: inspection.events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "first"),
      secondAccepted: inspection.events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "second"),
    });
    await engine.close();
    store.close();
  });

  test("keeps partial provider token observations while holding the full bounded grant as unknown", async () => {
    const fixture = createMissionFixture("pitako-accounting-partial-usage-");
    fixtures.push(fixture);
    const definition = missionDefinition();
    definition.units = [{ ...definition.units[0]!, id: "partial", outputs: ["partial"], acceptance: [{ id: "partial-ok", kind: "manual", target: "partial" }] }];
    definition.finalization.requiredPredicates = ["partial-ok"];
    definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 400, activeTimeMs: 60_000, artifactBytes: 12_000 };
    fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(fixture.definitionFile, fixture.definitionBytes);
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    const engine = new MissionEngine({
      store,
      missionId: mission.id,
      sessionsDirectory: path.join(fixture.stateDir, "sessions"),
      runRole: async (_input, durable) => {
        const requestId = randomUUID();
        const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
        await durable.onProviderReceipt({ requestId, provider: "fixture", model: "local", inputTokens: 8, outputTokens: null, ticket });
        return result("partial usage result");
      },
      assessPredicate: pass,
    });
    engine.start();
    await engine.waitForIdle();

    const inspection = store.inspectMission(mission.id);
    const measurement = inspection.measurements.find(({ metric }) => metric === "provider-tokens");
    const usage = inspection.reservations.find(({ resource, purpose }) => resource === "tokens" && purpose === "ordinary");
    expect(measurement?.value).toBeNull();
    expect(measurement?.inputTokens).toBe(8);
    expect(measurement?.outputTokens).toBeNull();
    expect(usage?.knownCharge).toBe(0);
    expect(usage?.unknownCharge).toBe(100);
    recordAccountingProbe("partial-provider-usage", {
      inputTokensObserved: measurement?.inputTokens,
      outputTokensUnknown: measurement?.outputTokens === null,
      totalUsageUnknown: measurement?.value === null,
      retainedUnknownCharge: usage?.unknownCharge,
    });
    await engine.close();
    store.close();
  });

  test("measures concurrent attempts as one shared active-time interval", async () => {
    const fixture = createMissionFixture("pitako-accounting-active-union-");
    fixtures.push(fixture);
    const definition = missionDefinition();
    const baseUnit = definition.units[0]!;
    definition.units = [
      { ...baseUnit, id: "first", outputs: ["first"], acceptance: [{ id: "first-ok", kind: "manual", target: "first" }] },
      { ...baseUnit, id: "second", outputs: ["second"], acceptance: [{ id: "second-ok", kind: "manual", target: "second" }] },
    ];
    definition.finalization.requiredPredicates = ["first-ok", "second-ok"];
    definition.budget = { roleLaunches: 8, providerRequests: 8, tokens: 800, activeTimeMs: 12_000, artifactBytes: 12_000 };
    fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(fixture.definitionFile, fixture.definitionBytes);
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    let clock = 10;
    const starts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = new MissionEngine({
      store,
      missionId: mission.id,
      sessionsDirectory: path.join(fixture.stateDir, "sessions"),
      now: () => clock,
      runRole: async ({ unit }) => {
        starts.push(unit.id);
        await gate;
        return result("shared interval result");
      },
      assessPredicate: pass,
    });
    engine.start();
    await waitUntil(() => starts.length === 2);
    clock = 30;
    release();
    await engine.waitForIdle();

    const inspection = store.inspectMission(mission.id);
    const ordinaryWindows = inspection.reservations.filter(({ resource, purpose }) => resource === "active-time-ms" && purpose === "ordinary");
    expect(inspection.events.filter(({ kind }) => kind === "mission.active.window.opened")).toHaveLength(1);
    expect(ordinaryWindows).toHaveLength(1);
    expect(ordinaryWindows[0]?.knownCharge).toBe(20);
    expect(engine.snapshot().activeTimeMs).toBe(20);
    recordAccountingProbe("active-time-union", {
      openedWindows: inspection.events.filter(({ kind }) => kind === "mission.active.window.opened").length,
      ordinaryWindowCount: ordinaryWindows.length,
      measuredActiveMs: engine.snapshot().activeTimeMs,
      occupiedActiveMs: ordinaryWindows.reduce((sum, row) => sum + row.amount, 0),
    });
    await engine.close();
    store.close();
  });

  for (const [activeTimeMs, roleLaunches, prePauseMs] of [[6000, 6, 999], [6000, 6, 1001], [4000, 4, 999]] as const)
    test(`retained assessment pause closes at ${prePauseMs}ms with ${activeTimeMs}ms budget without spending idle or sibling grants`, async () => {
    const fixture = createMissionFixture("pitako-accounting-assessment-pause-");
    fixtures.push(fixture);
    const definition = missionDefinition();
    const unit = definition.units[0]!;
    definition.units = ["first", "second"].map((id) => ({ ...unit, id, outputs: [id],
      acceptance: [{ id: `${id}-ok`, kind: "manual" as const, target: id }] }));
    definition.finalization.requiredPredicates = ["first-ok", "second-ok"];
    definition.budget = { roleLaunches, providerRequests: roleLaunches, tokens: roleLaunches * 1000, activeTimeMs, artifactBytes: 12000 };
    writeFileSync(fixture.definitionFile, JSON.stringify(definition));
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    let clock = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const starts: string[] = [];
    let assessing = false;
    const engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"), maxConcurrent: 1,
      now: () => clock,
      runRole: async ({ unit }) => { starts.push(unit.id); return result(unit.id); },
      assessPredicate: async ({ unit }) => {
        if (unit.id === "first") { assessing = true; await gate; }
        return pass();
      },
    });
    try {
      engine.start();
      await waitUntil(() => assessing);
      clock = prePauseMs;
      const pausing = engine.control("pause").then(() => "", (error: Error) => error.message);
      // Pause must close before the assessor or the ten-second drain fence returns.
      await Bun.sleep(10);
      const paused = store.inspectMission(mission.id);
      expect(paused.state).toBe("paused");
      expect(paused.events.filter(({ kind }) => kind === "mission.active.window.closed")).toHaveLength(1);
      const charge = () => store.inspectMission(mission.id).reservations.filter(({ resource }) => resource === "active-time-ms")
        .reduce((sum, row) => sum + row.knownCharge, 0);
      expect(charge()).toBe(prePauseMs);
      clock += 20000;
      await engine.control("pause");
      // Exercise the real armed timer and the slow-assessment reconciliation fence.
      await Bun.sleep(10100);
      expect(await pausing).toBe("mission pause is fenced; active worker still needs reconciliation");
      expect(charge()).toBe(prePauseMs);
      const idle = store.inspectMission(mission.id);
      expect(idle.events.filter(({ kind }) => kind === "mission.active.window.opened")).toHaveLength(1);
      expect(starts).toEqual(["first"]);
      expect(idle.events.some(({ kind }) => kind === "unit.accepted" || kind === "attempt.settled")).toBe(false);
      expect(idle.reservations.find(({ resource, purpose }) => resource === "active-time-ms" && purpose === "protected"))
        .toMatchObject({ amount: 2000, knownCharge: 0, unknownCharge: 0 });
      const first = idle.reservations.find(({ resource, purpose }) => resource === "active-time-ms" && purpose === "ordinary")!;
      expect(first).toMatchObject({ grantAmount: 1000, knownCharge: prePauseMs, overage: Math.max(0, prePauseMs - 1000) });
      release();
      await engine.waitForIdle();
      await engine.control("resume");
      await engine.waitForIdle();
      const final = store.inspectMission(mission.id);
      // Real pre-pause overage is retained and fences admission; a near-quantum valid pause does not.
      expect(starts).toEqual(prePauseMs > 1000 ? ["first"] : ["first", "second"]);
      expect(final.events.filter(({ kind, unitId }) => kind === "unit.accepted" && unitId === "first")).toHaveLength(1);
      expect(final.events.filter(({ kind }) => kind === "attempt.receipt").map(({ payload }) => payload.status))
        .toEqual(starts.map(() => "completed"));
      expect(final.events.some(({ kind, payload }) => kind === "attempt.settled" && payload.status === "interrupted")).toBe(false);
      expect(charge()).toBe(prePauseMs);
    } finally {
      release();
      await engine.close();
      store.close();
    }
  }, 20000);

  test("late fast assessment pause drain does not close a resumed independent interval", async () => {
    const fixture = createMissionFixture("pitako-accounting-pause-drain-");
    fixtures.push(fixture);
    const definition = missionDefinition();
    definition.units = ["first", "second"].map((id) => ({ ...definition.units[0]!, id, outputs: [id],
      acceptance: [{ id: `${id}-ok`, kind: "manual" as const, target: id }] }));
    definition.finalization.requiredPredicates = ["first-ok", "second-ok"];
    definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 4000, activeTimeMs: 4000, artifactBytes: 12000 };
    writeFileSync(fixture.definitionFile, JSON.stringify(definition));
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    let clock = 0;
    const releases: Array<() => void> = [];
    const gates = [0, 1].map(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    const starts: string[] = [];
    const assessing: string[] = [];
    const engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"), maxConcurrent: 1, now: () => clock,
      runRole: async ({ unit }) => { starts.push(unit.id); return result(unit.id); },
      assessPredicate: async ({ unit }) => { assessing.push(unit.id); await gates[unit.id === "first" ? 0 : 1]; return pass(); },
    });
    try {
      engine.start();
      await waitUntil(() => assessing.includes("first"));
      clock = 20;
      const pausing = engine.control("pause");
      const resuming = engine.control("resume");
      releases[0]!();
      await resuming;
      await waitUntil(() => assessing.includes("second"));
      await pausing;
      const resumed = store.inspectMission(mission.id);
      expect(resumed.events.filter(({ kind }) => kind === "mission.active.window.opened")).toHaveLength(2);
      expect(resumed.events.filter(({ kind }) => kind === "mission.active.window.closed")).toHaveLength(1);
      clock += 30;
      releases[1]!();
      await engine.waitForIdle();
      const final = store.inspectMission(mission.id);
      expect(starts).toEqual(["first", "second"]);
      expect(final.events.filter(({ kind }) => kind === "unit.accepted")).toHaveLength(2);
      expect(final.reservations.filter(({ resource }) => resource === "active-time-ms").reduce((sum, row) => sum + row.knownCharge, 0)).toBe(50);
      expect(final.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(2);
      expect(final.events.some(({ kind, payload }) => kind === "attempt.settled" && payload.status === "interrupted")).toBe(false);
    } finally {
      releases.forEach((release) => release());
      await engine.close();
      store.close();
    }
  });

  test("admission loads saved limits for direct reserve and protects finalization quota", async () => {
    const fixture = createMissionFixture("pitako-accounting-admission-");
    fixtures.push(fixture);
    const definition = missionDefinition();
    definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 100, activeTimeMs: 100, artifactBytes: 100 };
    fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(fixture.definitionFile, fixture.definitionBytes);
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    const protectedGrant = store.reserve(mission.id, {
      id: randomUUID(), revision: 1, resource: "tokens", amount: 50, purpose: "protected",
    }, mission.version);
    const ordinary = store.reserve(mission.id, {
      id: randomUUID(), revision: 1, resource: "tokens", amount: 50,
    }, mission.version + 1);

    expect(() => store.reserve(mission.id, {
      id: randomUUID(), revision: 1, resource: "tokens", amount: 1,
    }, mission.version + 2)).toThrow(/reservation exceeds root budget/);
    expect(() => store.reserve(mission.id, {
      id: randomUUID(), revision: 1, resource: "tokens", amount: 51, purpose: "finalization",
    }, mission.version + 2)).toThrow(/finalization exceeded protected capacity/);
    expect(store.inspectMission(mission.id).reservations.map(({ id }) => id)).toEqual([protectedGrant.id, ordinary.id]);
    recordAccountingProbe("protected-admission", {
      protectedTokens: protectedGrant.amount,
      ordinaryTokens: ordinary.amount,
      overBudgetRejected: true,
      finalizationOverProtectedRejected: true,
      committedReservations: store.inspectMission(mission.id).reservations.length,
    });
    store.close();
  });

  test("checkpoints active time before admitting a later ready unit", async () => {
    const fixture = createMissionFixture("pitako-accounting-active-fence-");
    fixtures.push(fixture);
    const definition = missionDefinition();
    const baseUnit = definition.units[0]!;
    definition.units = [
      { ...baseUnit, id: "over", outputs: ["over"], acceptance: [{ id: "over-ok", kind: "manual", target: "over" }] },
      { ...baseUnit, id: "later", outputs: ["later"], acceptance: [{ id: "later-ok", kind: "manual", target: "later" }] },
    ];
    definition.finalization.requiredPredicates = ["over-ok", "later-ok"];
    definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 100, activeTimeMs: 100, artifactBytes: 4000 };
    fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(fixture.definitionFile, fixture.definitionBytes);
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    let clock = 0;
    const starts: string[] = [];
    let markStarted!: () => void;
    let releaseRunner!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const runnerGate = new Promise<void>((resolve) => { releaseRunner = resolve; });
    const engine = new MissionEngine({
      store,
      missionId: mission.id,
      sessionsDirectory: path.join(fixture.stateDir, "sessions"),
      now: () => clock,
      runRole: async ({ unit }) => {
        starts.push(unit.id);
        if (unit.id === "over") {
          markStarted();
          await runnerGate;
        }
        return result(`verified ${unit.id}`);
      },
      assessPredicate: pass,
      maxConcurrent: 1,
    });

    engine.start();
    await started;
    clock = 80;
    releaseRunner();
    await engine.waitForIdle();

    const inspection = store.inspectMission(mission.id);
    const state = engine.snapshot();
    const activeReservation = inspection.reservations.find(({ resource, purpose }) => resource === "active-time-ms" && purpose === "ordinary")!;
    const eventRows = inspection.events.filter(({ kind }) =>
      kind === "attempt.reserved" || kind === "attempt.started" || kind === "attempt.receipt" ||
      kind === "evidence.recorded" || kind === "unit.accepted" || kind === "budget.reservation.settled" ||
      kind === "budget.admission.fenced").map(({ seq, kind, unitId, payload }) => ({ seq, kind, unitId, payload }));
    const receiptSeq = inspection.events.find(({ kind, unitId }) => kind === "attempt.receipt" && unitId === "over")?.seq;
    const evidenceSeq = inspection.events.find(({ kind, unitId }) => kind === "evidence.recorded" && unitId === "over")?.seq;
    const acceptedSeq = inspection.events.find(({ kind, unitId }) => kind === "unit.accepted" && unitId === "over")?.seq;
    const settlementSeq = inspection.events.find(({ kind, payload }) =>
      kind === "budget.reservation.settled" && payload.reservationId === activeReservation.id)?.seq;
    const fenceSeq = inspection.events.find(({ kind }) => kind === "budget.admission.fenced")?.seq;
    expect(starts).toEqual(["over"]);
    expect(receiptSeq).toBeDefined();
    expect(evidenceSeq).toBeDefined();
    expect(acceptedSeq).toBeDefined();
    expect(settlementSeq).toBeDefined();
    expect(fenceSeq).toBeDefined();
    expect(receiptSeq!).toBeLessThan(evidenceSeq!);
    expect(evidenceSeq!).toBeLessThan(acceptedSeq!);
    expect(acceptedSeq!).toBeLessThan(settlementSeq!);
    expect(settlementSeq!).toBeLessThan(fenceSeq!);
    expect(activeReservation).toMatchObject({ grantAmount: 25, knownCharge: 80, overage: 55 });
    expect(inspection.reservations.find(({ resource, purpose }) => resource === "active-time-ms" && purpose === "protected")?.amount).toBe(50);
    expect(inspection.events.some(({ kind, unitId }) => kind === "attempt.reserved" && unitId === "later")).toBe(false);
    expect(inspection.events.some(({ kind, unitId }) => kind === "attempt.started" && unitId === "later")).toBe(false);
    expect(state.units.over?.status).toBe("accepted");
    expect(state.units.later?.status).not.toBe("accepted");
    expect(state.admissionFenced).toBe(true);
    recordAccountingProbe("active-time-pre-admission-fence", {
      starts,
      grantAmount: activeReservation.grantAmount,
      knownCharge: activeReservation.knownCharge,
      overage: activeReservation.overage,
      protectedAmount: inspection.reservations.find(({ resource, purpose }) => resource === "active-time-ms" && purpose === "protected")?.amount,
      receiptBeforeEvidenceBeforeAcceptance: receiptSeq! < evidenceSeq! && evidenceSeq! < acceptedSeq!,
      acceptanceBeforeSettlementBeforeFence: acceptedSeq! < settlementSeq! && settlementSeq! < fenceSeq!,
      laterAttemptReserved: inspection.events.some(({ kind, unitId }) => kind === "attempt.reserved" && unitId === "later"),
      laterAttemptStarted: inspection.events.some(({ kind, unitId }) => kind === "attempt.started" && unitId === "later"),
      admissionFenced: state.admissionFenced,
      rows: eventRows,
    });
    await engine.close();
    store.close();
  });

  test("settled grant cannot be adjusted away or bypass root admission", async () => {
    const fixture = createMissionFixture("pitako-accounting-settlement-lock-");
    fixtures.push(fixture);
    const definition = missionDefinition();
    definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 100, activeTimeMs: 100, artifactBytes: 100 };
    fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(fixture.definitionFile, fixture.definitionBytes);
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    const protectedGrant = store.reserve(mission.id, {
      id: randomUUID(), revision: 1, resource: "tokens", amount: 50, purpose: "protected",
    }, mission.version);
    const ordinaryGrant = store.reserve(mission.id, {
      id: randomUUID(), revision: 1, resource: "tokens", amount: 40,
    }, mission.version + 1);
    let grantLimitAdjustmentRejected = false;
    try {
      store.appendTransition(mission.id, mission.version + 2, { events: [{
        revision: 1,
        kind: "budget.reservation.adjusted",
        causalId: randomUUID(),
        payload: { reservationId: ordinaryGrant.id, resource: "tokens", amount: 60 },
      }] });
    } catch (error) {
      grantLimitAdjustmentRejected = /exceeds immutable grant/.test(String(error));
    }
    const settlement: MissionEventDraft = {
      revision: 1,
      kind: "budget.reservation.settled",
      causalId: randomUUID(),
      payload: { reservationId: ordinaryGrant.id, resource: "tokens", knownCharge: 40, unknownCharge: 0, released: 0, source: "direct store test" },
    };
    const committedSettlement = store.appendTransition(mission.id, mission.version + 2, { events: [settlement] });
    const settledVersion = store.inspectMission(mission.id).version;
    const replayedSettlement = store.appendTransition(mission.id, settledVersion - 1, { events: [settlement] });
    let wrongIdentityRejected = false;
    try {
      store.appendTransition(mission.id, settledVersion, { events: [{
        revision: 1,
        kind: "budget.reservation.adjusted",
        causalId: randomUUID(),
        payload: { reservationId: ordinaryGrant.id, resource: "provider-requests", amount: 0 },
      }] });
    } catch (error) {
      wrongIdentityRejected = /adjusted reservation resource changed/.test(String(error));
    }
    let adjustmentRejected = false;
    try {
      store.appendTransition(mission.id, settledVersion, { events: [{
        revision: 1,
        kind: "budget.reservation.adjusted",
        causalId: randomUUID(),
        payload: { reservationId: ordinaryGrant.id, resource: "tokens", amount: 0 },
      }] });
    } catch (error) {
      adjustmentRejected = /settled reservation cannot be adjusted/.test(String(error));
    }
    let newReservationRejected = false;
    try {
      store.reserve(mission.id, { id: randomUUID(), revision: 1, resource: "tokens", amount: 50 }, settledVersion);
    } catch (error) {
      newReservationRejected = /reservation exceeds root budget/.test(String(error));
    }
    const inspection = store.inspectMission(mission.id);
    const settledGrant = inspection.reservations.find(({ id }) => id === ordinaryGrant.id);
    expect(replayedSettlement).toEqual(committedSettlement);
    expect(inspection.version).toBe(settledVersion);
    expect(grantLimitAdjustmentRejected).toBe(true);
    expect(wrongIdentityRejected).toBe(true);
    expect(adjustmentRejected).toBe(true);
    expect(newReservationRejected).toBe(true);
    expect(settledGrant).toMatchObject({ knownCharge: 40, amount: 40 });
    expect(inspection.reservations.find(({ id }) => id === protectedGrant.id)?.amount).toBe(50);
    recordAccountingProbe("settled-grant-immutable", {
      settlementReplayIdempotent: replayedSettlement[0]?.eventId === committedSettlement[0]?.eventId,
      grantLimitAdjustmentRejected,
      wrongIdentityRejected,
      adjustmentRejected,
      newReservationRejected,
      protectedTokens: inspection.reservations.find(({ id }) => id === protectedGrant.id)?.amount,
      settledKnownCharge: settledGrant?.knownCharge,
      settledAmount: settledGrant?.amount,
      versionUnchangedAfterRejectedAdjustment: inspection.version === settledVersion,
      rows: inspection.events.filter(({ kind, payload }) =>
        kind === "reservation.created" || kind === "budget.reservation.settled" || kind === "budget.reservation.adjusted" ||
        (kind === "budget.admission.fenced" && payload.resource === "tokens"))
        .map(({ seq, kind, payload }) => ({ seq, kind, payload })),
    });
    store.close();
  });

  test("releases only a short active quantum across owner recovery before or after receipt", async () => {
    for (const receiptPersisted of [false, true]) {
      const fixture = createMissionFixture("pitako-accounting-recovery-");
      fixtures.push(fixture);
      const definition = missionDefinition();
      const baseUnit = definition.units[0]!;
      definition.units = [
        { ...baseUnit, id: "stuck", outputs: ["stuck"], acceptance: [{ id: "stuck-ok", kind: "manual", target: "stuck" }] },
        { ...baseUnit, id: "independent", outputs: ["independent"], acceptance: [{ id: "independent-ok", kind: "manual", target: "independent" }] },
      ];
      definition.finalization.requiredPredicates = ["stuck-ok", "independent-ok"];
      definition.budget = { roleLaunches: 8, providerRequests: 8, tokens: 800, activeTimeMs: 21_600_000, artifactBytes: 12_000 };
      fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
      writeFileSync(fixture.definitionFile, fixture.definitionBytes);
      const store = await openFixtureStore(fixture);
      const mission = store.createMission(missionInput(fixture));
      const activation = [
        ["role-launches", 2], ["provider-requests", 2], ["tokens", 200],
        ["active-time-ms", 5_400_000], ["artifact-bytes", 3_000],
      ].map(([resource, amount]) => accountingEvent(1, "reservation.created", {
        reservationId: randomUUID(), revision: 1, resource, amount, purpose: "protected",
      }));
      activation.push(accountingEvent(1, "mission.activated", { missionId: mission.id }));
      store.appendTransition(mission.id, 1, { events: activation });

      const oldEpoch = store.ownerEpoch!;
      const binding = {
        missionId: mission.id, revision: 1, unitId: "stuck", roundId: "main", memberId: "solo",
        attemptId: randomUUID(), attemptNo: 1, ownerEpoch: oldEpoch, candidate: "read-only" as const,
        inputManifestHash: "c".repeat(64), briefHash: "d".repeat(64), rolePolicyHash: "a".repeat(64),
      };
      const launchId = randomUUID();
      const artifactId = randomUUID();
      const activeId = randomUUID();
      const providerId = randomUUID();
      const tokenId = randomUUID();
      const requestId = randomUUID();
      const runningEvents = [
        accountingEvent(1, "unit.ready", { unitId: "stuck" }, "stuck"),
        accountingEvent(1, "attempt.reserved", { attemptId: binding.attemptId, unitId: "stuck", roundId: "main", memberId: "solo", binding }, "stuck", binding.attemptId),
        ...[
          { reservationId: launchId, resource: "role-launches", amount: 1 },
          { reservationId: artifactId, resource: "artifact-bytes", amount: 1_500 },
          { reservationId: activeId, resource: "active-time-ms", amount: 1_000 },
          { reservationId: providerId, resource: "provider-requests", amount: 1 },
          { reservationId: tokenId, resource: "tokens", amount: 100 },
        ].map(({ reservationId, resource, amount }) => accountingEvent(1, "reservation.created", {
          reservationId, revision: 1, resource, amount, purpose: "ordinary",
        }, "stuck", binding.attemptId)),
        accountingEvent(1, "mission.active.window.opened", {
          windowId: randomUUID(), reservationId: activeId, grantAmount: 1_000,
          runtimeId: store.runtimeId, ownerEpoch: oldEpoch, engineId: "old-owner",
        }),
        accountingEvent(1, "attempt.started", { attemptId: binding.attemptId, unitId: "stuck" }, "stuck", binding.attemptId),
        accountingEvent(1, "provider.request.dispatched", {
          requestId, attemptId: binding.attemptId, unitId: "stuck", provider: "fixture", model: "local",
          tokenReservationId: tokenId, ownerEpoch: oldEpoch,
        }, "stuck", binding.attemptId),
      ];
      let inspection = store.inspectMission(mission.id);
      store.appendTransition(mission.id, inspection.version, { events: runningEvents });
      const resultBytes = Buffer.from("completed before restart");
      const resultHash = createHash("sha256").update(resultBytes).digest("hex");
      if (receiptPersisted) {
        inspection = store.inspectMission(mission.id);
        store.appendTransition(mission.id, inspection.version, {
          events: [accountingEvent(1, "attempt.receipt", {
            attemptId: binding.attemptId, unitId: "stuck", status: "completed", resultHash,
            artifactHash: resultHash, artifactMediaType: "text/plain; charset=utf-8",
            model: { selectedModel: "fixture/local" }, usage: null, requests: [], role: "developer",
          }, "stuck", binding.attemptId)],
          artifacts: [{ bytes: resultBytes, mediaType: "text/plain; charset=utf-8" }],
        });
      }
      const retiringEngine = new MissionEngine({
        store,
        missionId: mission.id,
        sessionsDirectory: path.join(fixture.stateDir, "retiring-sessions"),
        runRole: async () => result("unused retirement fixture"),
        assessPredicate: pass,
      });
      await retiringEngine.retireForShutdown("accounting-owner-recovery");

      const reopened = await openFixtureStore(fixture);
      expect(reopened.ownerEpoch).not.toBe(oldEpoch);
      const starts: string[] = [];
      const engine = new MissionEngine({
        store: reopened,
        missionId: mission.id,
        sessionsDirectory: path.join(fixture.stateDir, "recovered-sessions"),
        now: () => 21_600_000,
        runRole: async ({ unit }) => {
          starts.push(unit.id);
          return result("independent work completed");
        },
        assessPredicate: pass,
      });
      await engine.control("resume");
      await engine.waitForIdle();

      const recovered = reopened.inspectMission(mission.id);
      const oldWindow = recovered.reservations.find(({ id }) => id === activeId)!;
      const unknownUsage = recovered.reservations.find(({ id }) => id === tokenId)!;
      const snapshot = engine.snapshot();
      expect(starts).toEqual(["independent"]);
      expect(oldWindow.grantAmount).toBe(1_000);
      expect(oldWindow.unknownCharge).toBe(1_000);
      expect(oldWindow.amount).toBe(1_000);
      expect(unknownUsage.unknownCharge).toBe(100);
      expect(recovered.measurements.some(({ value, unknownReason }) => value === null && unknownReason?.includes("canonical provider usage"))).toBe(true);
      expect(snapshot.activeTimeMs).toBe(0);
      expect(snapshot.units.independent?.status).toBe("accepted");
      expect(snapshot.units.stuck?.status).toBe(receiptPersisted ? "accepted" : "blocked");
      expect(snapshot.attempts[binding.attemptId]?.settled).toBe(receiptPersisted);
      expect(reopened.replayMission(mission.id).reservations).toEqual(recovered.reservations);
      recordAccountingProbe(`owner-recovery-${receiptPersisted ? "after" : "before"}-receipt`, {
        ownerEpochChanged: reopened.ownerEpoch !== oldEpoch,
        activeWindowUnknownCharge: oldWindow.unknownCharge,
        tokenUnknownCharge: unknownUsage.unknownCharge,
        missingReceiptMeasurement: recovered.measurements.some(({ value, unknownReason }) => value === null && unknownReason?.includes("canonical provider usage")),
        independentWorkAccepted: snapshot.units.independent?.status === "accepted",
        recoveredWorkAccepted: snapshot.units.stuck?.status === "accepted",
        measuredActiveMs: snapshot.activeTimeMs,
        replayStable: reopened.replayMission(mission.id).reservations.length === recovered.reservations.length,
      });
      await engine.close();
      reopened.close();
    }
  });
});

function recordAccountingProbe(id: string, facts: Record<string, unknown>): void {
  accountingProbes.push({ id, facts, assertionsPassed: true });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for concurrent attempts");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function accountingEvent(
  revision: number,
  kind: string,
  payload: Record<string, unknown>,
  unitId?: string,
  attemptId?: string,
): MissionEventDraft {
  return { revision, kind, causalId: randomUUID(), payload, unitId, attemptId };
}
