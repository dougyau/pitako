import { METRIC_VERSION, type CapturedMission, type MetricCohort, type MetricFact } from "../extensions/mission/metrics.ts";
import type { EvaluationObservation } from "../extensions/mission/model.ts";

const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const hash = "a".repeat(64);
export function metricFixture(): MetricCohort {
  const missions: CapturedMission[] = [];
  for (let i = 0; i < 6; i++) {
    let seq = 0;
    const facts: MetricFact[] = [];
    const add = (kind: string, ms: number, data: Record<string, unknown> = {}, attempt: string | null = null, revision = 1) => {
      const f = { id: `${i}:${++seq}`, seq, kind, at: at(ms), runtime: `${i}:runtime`, revision, attempt, unit: "product", round: null, data };
      facts.push(f); return f;
    };
    add("mission.created", 0); add("mission.activated", 100);
    add("attempt.reserved", 110, { effort: i === 1 ? "team" : "implementation" }, `${i}:attempt`);
    add("provider.request.dispatched", 120, { requestId: `${i}:request` }, `${i}:attempt`);
    add("provider.request.receipt", 170, { requestId: `${i}:request`, inputTokens: i === 4 ? null : 100,
      outputTokens: i === 4 ? null : 20, estimatedCost: i === 4 ? null : 2, pricingBasis: "fixture USD estimate", durationMs: 50 }, `${i}:attempt`);
    // Duplicate same fact and duplicate receipt with distinct event id must not double measured spend.
    facts.push(facts.at(-1)!); add("provider.request.receipt", 175, { requestId: `${i}:request`, inputTokens: 100,
      outputTokens: 20, estimatedCost: 2, pricingBasis: "fixture USD estimate", durationMs: 50 }, `${i}:attempt`);
    add("mission.active.window.checkpointed", 200, { durationMs: 80 });
    add("dispatch.observed", 120, { queueWaitMs: 10 });
    add("mission.input.visible", 190, { responseMs: 15 });
    if (i === 0) {
      add("attempt.interrupted", 220, { pauseEventId: "episode-0" });
      add("attempt.interrupted", 221, { pauseEventId: "episode-0" });
      add("mission.recovery.recorded", 240); add("mission.recovery.recorded", 241);
      add("mission.recovery.continuation.recorded", 250);
      add("unit.accepted", 300);
    }
    if (i === 1) add("mission.input.recorded", 190, { intervention: "operational_rescue" });
    if (i === 2) add("mission.revised", 250, {}, null, 2);
    if (i < 4) add("mission.completed", 400, { manifestHash: hash }, null, i === 2 ? 2 : 1);
    if (i === 5) add("mission.cancelled", 300);
    const missionId = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    const observations: CapturedMission["observations"] = [];
    const observe = (classification: EvaluationObservation["classification"], verdict: EvaluationObservation["verdict"],
      revision = i === 2 ? 2 : 1, intervention?: "none" | "goal_authority") => {
      const observation: EvaluationObservation = { schemaVersion: 1, id: `${missionId}:${classification}`, missionId,
        revision, resultManifestHash: hash, criterionVersion: `fixture-criterion-${revision}`, evaluatorIdentity: "independent-fixture-byte-auditor",
        method: "fixture host exact byte comparison", observedAt: at(450), windowStart: at(400), windowEnd: at(450),
        evidenceRefs: [hash], verdict, classification, supersedesId: null };
      observations.push({ seq: ++seq, observation, provenance: {
        format: "mission-evaluator-v1", evaluatorIdentity: observation.evaluatorIdentity, method: observation.method, independent: true,
        missionId, revision, resultManifestHash: hash, criterionVersion: observation.criterionVersion, evidenceRefs: [hash],
        ...(intervention ? { intervention } : {}),
      } });
    };
    if (i === 0) { observe("outcome", "pass"); observe("operator_intervention", "pass", 1, "none"); }
    if (i === 1) observe("outcome", "fail");
    if (i === 2) { observe("outcome", "pass", 1); observe("outcome", "inconclusive"); observe("operator_intervention", "pass", 2, "goal_authority"); }
    missions.push({ missionId, asOfSeq: seq, asOfTime: at(500), facts, observations,
      identity: { planId: "fixture", repositoryId: missionId, engineCommit: "fixture", runtime: "fixture-clock",
        revisions: [{ revision: 1, planHash: hash, definitionHash: hash, authorityHash: hash, budget: { finite: true },
          policies: { fixture: true }, criteria: [{ criterionHash: hash }] }] } });
  }
  return { format: "mission-metric-cohort-v1", metricVersion: METRIC_VERSION, population: "deterministic-fixture",
    label: "frozen-counterexamples-v1", missions };
}
