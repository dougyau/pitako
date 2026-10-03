import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { calculateMissionMetrics, captureMetricMission, importMetricObservations, metricCommand, METRIC_VERSION } from "../extensions/mission/metrics.ts";
import { sha256, type EvaluationObservation } from "../extensions/mission/model.ts";
import { metricFixture } from "./mission-metrics-fixture.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { calculateCost, type Model } from "@earendil-works/pi-ai";
import { MissionEngine } from "../extensions/mission/engine.ts";

test("all-unknown and fully-known calculated cost cohorts keep subtotal and success denominator separate", () => {
  const cohort = metricFixture();
  const model: Model<"openai-completions"> = { id: "priced", name: "priced", provider: "fixture", api: "openai-completions",
    baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], contextWindow: 2048, maxTokens: 64,
    cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 } };
  const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const cost = calculateCost(model, usage).total;
  for (const mission of cohort.missions) for (const fact of mission.facts)
    if (fact.kind === "provider.request.receipt") fact.data.estimatedCost = cost;
  const known = calculateMissionMetrics(cohort);
  expect(known.costs.unknownCost).toBe(0);
  expect(known.costs.estimatedUSD).toBeCloseTo(6 * cost, 12);
  expect(known.costs.estimatedCostPerSuccess).toBeCloseTo(6 * cost, 12);
  expect(known.costs.denominator).toBe(1);
  for (const mission of cohort.missions) for (const fact of mission.facts)
    if (fact.kind === "provider.request.receipt") fact.data.estimatedCost = null;
  const unknown = calculateMissionMetrics(cohort);
  expect(unknown.counts).toEqual(known.counts);
  expect(unknown.costs).toMatchObject({ estimatedUSD: 0, unknownCost: 6, estimatedCostPerSuccess: null,
    denominator: 1, completeness: "incomplete lower bound", unknownUsage: 1 });
});

test("cohort keeps every denominator, costs including failed work, waits, recovery episodes and obsolete assessments", () => {
  const cohort = metricFixture();
  const report = calculateMissionMetrics(cohort);
  expect(report.counts).toMatchObject({ admitted: 6, terminal: 5, unfinished: 1, cancelled: 1,
    passed: 1, failed: 1, inconclusive: 1, unassessed: 3, rescueFreePassed: 1, rescue: 1, goalAuthority: 1, interventionUnknown: 4 });
  expect(report.correctness.rate).toBe(1 / 6);
  expect(report.coverage.rate).toBe(.5);
  expect(report.costs).toMatchObject({ inputTokens: 500, outputTokens: 100, estimatedUSD: 10,
    estimatedCostPerSuccess: null, unknownCost: 1, unknownUsage: 1 });
  expect(report.costs.effort.team.estimatedUSD).toBe(2);
  expect(report.time.delivery).toMatchObject({ samples: 4, unknown: 2, total: 1200 });
  expect(report.time.engineActive).toMatchObject({ samples: 6, total: 480 });
  expect(report.time.model).toMatchObject({ samples: 6, total: 300 });
  expect(report.time.dispatch).toMatchObject({ samples: 6, total: 60 });
  expect(report.time.visibleResponse).toMatchObject({ samples: 6, total: 90 });
  expect(report.recovery).toMatchObject({ episodes: 1, resumed: 1, reused: 1 });
  expect(report.recovery.checkpointDelay).toMatchObject({ samples: 1, total: 80 });
  expect(report.evidenceStatus).toContain("insufficient");
  expect(calculateMissionMetrics(JSON.parse(JSON.stringify(cohort)))).toEqual(report);
  if (process.env.MISSION_T7_METRICS_EVIDENCE) {
    mkdirSync(process.env.MISSION_T7_METRICS_EVIDENCE, { recursive: true });
    writeFileSync(path.join(process.env.MISSION_T7_METRICS_EVIDENCE, "cohort.json"), JSON.stringify(cohort, null, 2));
    writeFileSync(path.join(process.env.MISSION_T7_METRICS_EVIDENCE, "report.json"), JSON.stringify(report, null, 2));
  }
});

test("empty, zero success, correction cutoff and mixed populations do not invent effectiveness", () => {
  const c = metricFixture();
  const empty = calculateMissionMetrics({ ...c, population: "live-evaluation", label: "unmeasured; no authorized paid work", missions: [] });
  expect(empty.correctness.rate).toBeNull(); expect(empty.costs.estimatedCostPerSuccess).toBeNull();
  if (process.env.MISSION_T7_METRICS_EVIDENCE) {
    writeFileSync(path.join(process.env.MISSION_T7_METRICS_EVIDENCE, "unmeasured-baseline.json"), JSON.stringify(
      { ...c, population: "live-evaluation", label: "unmeasured; no authorized paid work", missions: [] }, null, 2));
    writeFileSync(path.join(process.env.MISSION_T7_METRICS_EVIDENCE, "empty-report.json"), JSON.stringify(empty, null, 2));
  }
  const zero = calculateMissionMetrics({ ...c, missions: c.missions.slice(1) });
  expect(zero.counts.passed).toBe(0); expect(zero.costs.estimatedCostPerSuccess).toBeNull();
  const original = calculateMissionMetrics(c);
  const m = c.missions[0]!, pass = m.observations[0]!;
  const corrected = { ...pass, seq: m.asOfSeq + 1, observation: { ...pass.observation, id: "correction", verdict: "fail" as const,
    observedAt: "2026-01-01T00:00:00.600Z", supersedesId: pass.observation.id } };
  m.observations.push(corrected);
  expect(calculateMissionMetrics(c).counts).toEqual(original.counts);
  m.asOfSeq++; m.asOfTime = corrected.observation.observedAt;
  expect(calculateMissionMetrics(c).counts.passed).toBe(0);
  expect(calculateMissionMetrics(c).counts.failed).toBe(2);
  expect(() => calculateMissionMetrics({ ...c, metricVersion: "future" as typeof METRIC_VERSION })).toThrow();
  expect(() => calculateMissionMetrics({ ...c, missions: [m, m] })).toThrow("duplicate");
});

test("historical safeguard defects persist and distinct owner-close episodes survive later completion", () => {
  const c = metricFixture(), m = c.missions[2]!, old = m.observations[0]!;
  m.observations.push({ ...old, observation: { ...old.observation, id: "old-defect", classification: "confirmed_defect", verdict: "fail" },
    provenance: { ...old.provenance, safeguard: "lost_user_edits", findingId: "lost-edit-1" } });
  const completed = m.facts.find((f) => f.kind === "mission.completed")!;
  const release = { ...completed, id: "release-one", seq: 6, at: "2026-01-01T00:00:00.180Z",
    kind: "mission.owner.released", data: { ownerEpoch: 1 } };
  m.facts.push(release, { ...release, id: "release-two", seq: 8, at: "2026-01-01T00:00:00.200Z", data: { ownerEpoch: 2 } },
    { ...release, id: "release-after-complete", seq: completed.seq + 1 });
  const report = calculateMissionMetrics(c);
  expect(report.recovery.episodes).toBe(3); // existing host pause + two distinct owner epochs
  expect(report.safeguards.confirmed).toHaveLength(1);
  expect(report.safeguards.confirmed[0]).toMatchObject({ revision: 1, violation: "lost_user_edits" });
  expect(report.rework.confirmedDefects).toHaveLength(1);
  expect(report.team.distinctConfirmedFindings).toBe(1);
  expect(report.team.work).toHaveLength(1);
});

test("captured pause settlements and owner release count one interruption, not one per writer event", async () => {
  const s = createMissionFixture("pitako-metric-episodes-"), store = await openFixtureStore(s);
  try {
    const m = store.createMission(missionInput(s));
    const epoch = store.ownerEpoch!, pauseEventId = crypto.randomUUID();
    const inspected = store.inspectMission(m.id), created = inspected.events[0]!;
    // Projection fixture: preserve real creation artifacts and production payload shapes,
    // without pretending these interruption markers are certified live attempts.
    const events = [created, ...[
      { kind: "mission.activated", payload: {} },
      { kind: "mission.paused", eventId: pauseEventId, payload: { ownerEpoch: epoch } },
      { kind: "attempt.settled", payload: { status: "interrupted", interruption: { pauseEventId } } },
      { kind: "mission.owner.released", payload: { owner: { epoch }, effectsQuiescent: true } },
      { kind: "mission.resumed", payload: {} },
      { kind: "attempt.interrupted", payload: { owner: { epoch: epoch + 1 } } },
      { kind: "attempt.interrupted", payload: { owner: { epoch: epoch + 1 } } },
      { kind: "mission.owner.released", payload: { owner: { epoch: epoch + 1 }, effectsQuiescent: true } },
    ].map((e, i) => ({ ...created, ...e, seq: i + 2, eventId: e.eventId ?? crypto.randomUUID(), causalId: crypto.randomUUID() }))];
    const captured = captureMetricMission(store, { ...inspected, events, latestSeq: events.length }, "fixture");
    expect(captured.facts.filter((f) => f.kind === "mission.owner.released").map((f) => f.data.ownerEpoch)).toEqual([epoch, epoch + 1]);
    const report = calculateMissionMetrics({ format: "mission-metric-cohort-v1", metricVersion: METRIC_VERSION,
      population: "deterministic-fixture", label: "captured production-shaped interruption facts", missions: [captured] });
    expect(report.recovery.episodes).toBe(2);
  } finally { store.close(); rmSync(s.base, { recursive: true, force: true }); }
});

test("import rejects unbound artifact/provenance without acceptance, resource or execution changes", async () => {
  const s = createMissionFixture("pitako-metric-import-");
  const store = await openFixtureStore(s);
  try {
    const m = store.createMission(missionInput(s)), before = store.inspectMission(m.id);
    const o = { schemaVersion: 1, id: crypto.randomUUID(), missionId: m.id, revision: 1, resultManifestHash: "a".repeat(64),
      criterionVersion: "test-v1", evaluatorIdentity: "external-auditor", method: "byte audit", observedAt: new Date().toISOString(),
      windowStart: null, windowEnd: null, evidenceRefs: [], verdict: "pass", classification: "outcome", supersedesId: null };
    expect(() => importMetricObservations(store, [o])).toThrow("provenance");
    expect(store.inspectMission(m.id)).toEqual(before);
    const cohort = metricFixture(), file = path.join(s.base, "cohort.json"), out = path.join(s.base, "report.json");
    writeFileSync(file, JSON.stringify(cohort));
    const rendered = metricCommand(store, `--cohort ${file} --export ${out}`, "fixture");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(rendered);
    expect(() => metricCommand(store, `--cohort ${file} --export ${out}`, "fixture")).toThrow();
    expect(store.inspectMission(m.id)).toEqual(before);
  } finally { store.close(); rmSync(s.base, { recursive: true, force: true }); }
});

test("failed metric export during active work preserves progress and denies retry spend reserved for another root", async () => {
  const s = createMissionFixture("pitako-metric-active-");
  const definition = missionDefinition();
  definition.units = ["alpha", "beta"].map((id) => ({
    id, dependencies: [], kind: "consultation", role: "developer", inputs: [], outputs: [`${id}.result`],
    acceptance: [{ id: `${id}-checked`, kind: "manual", target: `oracle:${id}` }],
    risk: "low", retryLimit: id === "alpha" ? 1 : 0,
  }));
  definition.finalization.requiredPredicates = ["alpha-checked", "beta-checked"];
  definition.budget = { roleLaunches: 5, providerRequests: 4, tokens: 200, activeTimeMs: 300000, artifactBytes: 5000 };
  writeFileSync(s.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(s), m = store.createMission(missionInput(s));
  let releaseAlpha!: () => void, releaseBeta!: () => void, started!: () => void;
  const alphaGate = new Promise<void>((resolve) => { releaseAlpha = resolve; });
  const betaGate = new Promise<void>((resolve) => { releaseBeta = resolve; });
  const active = new Promise<void>((resolve) => { started = resolve; });
  const calls: Array<{ unitId: string; attemptId: string; attemptNo: number; requestId: string; admitted: boolean; error: string }> = [];
  const engine = new MissionEngine({ store, missionId: m.id, sessionsDirectory: path.join(s.stateDir, "sessions"),
    runRole: async ({ unit, binding }, durable) => {
      if (unit.id === "beta") await betaGate;
      const requestId = crypto.randomUUID();
      let admitted = false, error = "";
      try {
        const ticket = await durable.onProviderDispatch({ requestId, provider: "fixture", model: "local" });
        admitted = true;
        if (unit.id === "beta") await durable.onProviderReceipt({
          requestId, provider: "fixture", model: "local", inputTokens: 1, outputTokens: 1, ticket,
        });
      } catch (caught) { error = String(caught); }
      calls.push({ unitId: unit.id, attemptId: binding.attemptId, attemptNo: binding.attemptNo, requestId, admitted, error });
      if (unit.id === "alpha" && binding.attemptNo === 1) { started(); await alphaGate; }
      if (unit.id === "alpha" && binding.attemptNo === 2) releaseBeta();
      return { instanceId: "metric-fixture-worker", role: "developer",
        status: unit.id === "beta" && admitted ? "completed" : "failed",
        model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
        result: unit.id === "beta" && admitted ? "beta output" : "",
        usage: { input: 7, output: 3, turns: 1, toolCalls: 0 } };
    },
    assessPredicate: ({ resultArtifact }) => ({ verdict: resultArtifact.toString("utf8") === "beta output" ? "pass" : "fail",
      method: "fixture host exact output comparison" }),
  });
  try {
    engine.start(); await active;
    const before = store.inspectMission(m.id);
    expect(engine.snapshot().state).toBe("running");
    expect(before.events.some(({ kind }) => kind === "provider.request.dispatched")).toBe(true);
    const exportFile = path.join(s.base, "occupied-report.json");
    writeFileSync(exportFile, "retain these bytes");
    const args = `${m.id} --export ${exportFile}`;
    let failure: { code: string; message: string } | undefined;
    try { metricCommand(store, args, "fixture"); }
    catch (error) {
      failure = { code: (error as NodeJS.ErrnoException).code ?? "", message: String(error) };
    }
    expect(failure?.code).toBe("EEXIST");
    expect(readFileSync(exportFile, "utf8")).toBe("retain these bytes");
    const afterFailure = store.inspectMission(m.id);
    expect(afterFailure).toEqual(before);
    releaseAlpha(); await engine.waitForIdle();
    const final = store.inspectMission(m.id);
    const retry = calls.find(({ unitId, attemptNo }) => unitId === "alpha" && attemptNo === 2)!;
    const beta = calls.find(({ unitId }) => unitId === "beta")!;
    expect(retry).toMatchObject({ admitted: false });
    expect(retry.error).toContain("ordinary provider-requests is reserved for remaining root slots");
    expect(beta).toMatchObject({ admitted: true, error: "" });
    expect(final.events.filter(({ kind }) => kind === "provider.request.dispatched")).toHaveLength(2);
    expect(final.events.some(({ kind, payload }) => kind === "provider.request.dispatched" && payload.requestId === retry.requestId)).toBe(false);
    expect(final.events.some(({ kind, unitId, seq }) => kind === "unit.accepted" && unitId === "beta" && seq > before.latestSeq)).toBe(true);
    expect(engine.snapshot().units.beta?.status).toBe("accepted");
    expect(final.reservations.filter(({ purpose }) => purpose === "protected").map(({ amount }) => amount))
      .toEqual([2, 2, 100, 120000, 2000]);
    if (process.env.MISSION_T7_METRICS_EVIDENCE) {
      const directory = process.env.MISSION_T7_METRICS_EVIDENCE;
      mkdirSync(directory, { recursive: true });
      const journal = ({ id, state, latestSeq, events, reservations, measurements }: typeof before) => ({
        id, state, latestSeq, reservations, measurements,
        events: events.filter(({ kind }) => ["attempt.reserved", "attempt.started", "attempt.receipt",
          "provider.request.dispatched", "provider.request.receipt", "unit.accepted",
          "evidence.recorded", "budget.reservation.settled"].includes(kind)),
      });
      // This scenario alone owns this file; cohort/empty tests have separate writers.
      writeFileSync(path.join(directory, "failure-isolation.json"), JSON.stringify({
        action: { command: "metricCommand", args, missionId: m.id, failure },
        budget: definition.budget, before: journal(before), afterFailure: journal(afterFailure), final: journal(final), calls,
        cohort: { format: "mission-metric-cohort-v1", metricVersion: METRIC_VERSION, population: "deterministic-fixture",
          label: "active export failure; controlled provider, real scheduling/accounting",
          missions: [captureMetricMission(store, final, "fixture")] },
      }, null, 2));
    }
  } finally { releaseAlpha(); releaseBeta(); await engine.close(); store.close(); rmSync(s.base, { recursive: true, force: true }); }
}, 30000);

test("observation import binds stored result/provenance, replays once, corrects append-only and rejects batch conflicts", async () => {
  const s = createMissionFixture("pitako-metric-provenance-"), store = await openFixtureStore(s);
  try {
    const m = store.createMission(missionInput(s));
    const resultBytes = Buffer.from("independently measured fixture bytes"), resultHash = sha256(resultBytes);
    const reportBytes = Buffer.from(JSON.stringify({ acceptedManifestHash: resultHash })), reportHash = sha256(reportBytes);
    const provenance = { format: "mission-evaluator-v1", independent: true, evaluatorIdentity: "external-byte-auditor",
      method: "external exact byte comparison", missionId: m.id, revision: 1, resultManifestHash: resultHash,
      criterionVersion: "fixture-bytes-v1", evidenceRefs: [resultHash] };
    const provenanceBytes = Buffer.from(JSON.stringify(provenance)), provenanceHash = sha256(provenanceBytes);
    store.appendTransition(m.id, m.version, {
      artifacts: [resultBytes, reportBytes, provenanceBytes].map((bytes) => ({ bytes, mediaType: "application/json" })),
      events: [{ revision: 1, kind: "mission.result.integrated", causalId: crypto.randomUUID(), payload: { reportHash } }],
    });
    const before = store.inspectMission(m.id);
    const observation: EvaluationObservation = { schemaVersion: 1, id: crypto.randomUUID(), missionId: m.id, revision: 1,
      resultManifestHash: resultHash, criterionVersion: provenance.criterionVersion,
      evaluatorIdentity: provenance.evaluatorIdentity, method: provenance.method, observedAt: new Date().toISOString(),
      windowStart: null, windowEnd: null, evidenceRefs: [resultHash, provenanceHash],
      verdict: "pass", classification: "outcome", supersedesId: null };
    expect(() => importMetricObservations(store, [observation, observation])).toThrow("duplicate observation");
    expect(store.inspectMission(m.id)).toEqual(before);
    expect(() => importMetricObservations(store, [{ ...observation, evaluatorIdentity: "another-auditor" }])).toThrow("provenance");
    expect(store.inspectMission(m.id)).toEqual(before);
    importMetricObservations(store, [observation]);
    const after = store.inspectMission(m.id);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.events.filter((event) => event.kind !== "evaluation.observed")).toEqual(before.events);
    expect(after.evaluations).toEqual([observation]);
    importMetricObservations(store, [observation]);
    expect(store.inspectMission(m.id)).toEqual(after);
    const corrected: EvaluationObservation = { ...observation, id: crypto.randomUUID(), verdict: "fail", supersedesId: observation.id };
    expect(() => importMetricObservations(store, [corrected, { ...corrected, id: crypto.randomUUID() }])).toThrow("duplicate correction");
    expect(store.inspectMission(m.id)).toEqual(after);
    importMetricObservations(store, [corrected]);
    expect(store.inspectMission(m.id).evaluations).toEqual([observation, corrected]);
    expect(store.inspectMission(m.id).snapshot).toEqual(before.snapshot);
  } finally { store.close(); rmSync(s.base, { recursive: true, force: true }); }
});
