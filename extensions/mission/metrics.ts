import { readFileSync, writeFileSync } from "node:fs";
import { sha256, validateEvaluationObservation, type EvaluationObservation } from "./model.ts";
import type { MissionInspection, MissionStore } from "./store.ts";

export const METRIC_VERSION = "mission-metrics-v1";
export type Population = "deterministic-fixture" | "live-evaluation" | "normal-use";
type Effort = "implementation" | "verification" | "recovery" | "team";
export interface EvaluationProvenance {
  format: "mission-evaluator-v1";
  evaluatorIdentity: string;
  method: string;
  independent: true;
  missionId: string;
  revision: number;
  resultManifestHash: string;
  criterionVersion: string;
  evidenceRefs: string[];
  intervention?: "none" | "goal_authority" | "rescue" | "unknown";
  safeguard?: "lost_user_edits" | "unauthorized_effect" | "duplicate_effect" | "stale_acceptance";
  findingId?: string;
}
export interface MetricFact {
  id: string;
  seq: number;
  kind: string;
  at: string;
  runtime: string;
  revision: number;
  attempt: string | null;
  unit: string | null;
  round: string | null;
  data: Record<string, unknown>;
}
export interface CapturedMission {
  missionId: string;
  asOfSeq: number;
  asOfTime: string;
  identity: {
    planId: string; repositoryId: string; engineCommit: string; runtime: string;
    revisions: Array<{ revision: number; planHash: string; definitionHash: string; authorityHash: string;
      budget: unknown; policies: unknown; criteria: unknown }>;
  };
  facts: MetricFact[];
  observations: Array<{ seq: number; observation: EvaluationObservation; provenance: EvaluationProvenance }>;
}
export interface MetricCohort {
  format: "mission-metric-cohort-v1";
  metricVersion: typeof METRIC_VERSION;
  population: Population;
  label: string;
  missions: CapturedMission[];
}

// Deliberately no prompt, plan bytes, command text, file bytes, operator text, or error text.
const DATA_FIELDS = ["requestId", "inputTokens", "outputTokens", "estimatedCost", "pricingBasis", "durationMs",
  "elapsedMs", "queueWaitMs", "responseMs", "windowId", "unknownReason", "unknownInterval", "status",
  "manifestHash", "acceptedManifestHash", "inputManifestHash", "outputManifestHash", "artifactHash", "reportHash",
  "provider", "model", "requestedReasoning", "appliedReasoning", "intervention", "pauseEventId",
  "recoveryOf", "correctionNo", "continuationOf", "round", "memberId", "resumedFrom", "checkpointHash", "ownerEpoch"];

function provenance(store: MissionStore, observation: EvaluationObservation): EvaluationProvenance {
  const docs = observation.evidenceRefs.filter((hash) => /^[a-f0-9]{64}$/.test(hash)).flatMap((hash) => {
    try {
      const row = JSON.parse(store.readArtifact(hash).toString("utf8"));
      return row.format === "mission-evaluator-v1" ? [row] : [];
    } catch { return []; }
  });
  if (docs.length !== 1) throw new Error("observation requires one evaluator provenance artifact");
  const doc = docs[0];
  if (doc.independent !== true || doc.evaluatorIdentity !== observation.evaluatorIdentity || doc.method !== observation.method ||
    doc.missionId !== observation.missionId || doc.revision !== observation.revision ||
    doc.resultManifestHash !== observation.resultManifestHash || doc.criterionVersion !== observation.criterionVersion ||
    !Array.isArray(doc.evidenceRefs) || !doc.evidenceRefs.length ||
    !doc.evidenceRefs.every((ref: unknown) => typeof ref === "string" && observation.evidenceRefs.includes(ref))) {
    throw new Error("evaluator provenance does not bind observation identity and evidence");
  }
  if (doc.intervention !== undefined && !["none", "goal_authority", "rescue", "unknown"].includes(doc.intervention))
    throw new Error("invalid intervention classification");
  if (doc.safeguard !== undefined && !["lost_user_edits", "unauthorized_effect", "duplicate_effect", "stale_acceptance"].includes(doc.safeguard))
    throw new Error("invalid safeguard classification");
  // Project only the documented fields, even when the external provenance document has more.
  return { format: doc.format, evaluatorIdentity: doc.evaluatorIdentity, method: doc.method, independent: true,
    missionId: doc.missionId, revision: doc.revision, resultManifestHash: doc.resultManifestHash,
    criterionVersion: doc.criterionVersion, evidenceRefs: doc.evidenceRefs,
    ...(doc.intervention ? { intervention: doc.intervention } : {}),
    ...(doc.safeguard ? { safeguard: doc.safeguard } : {}),
    ...(typeof doc.findingId === "string" ? { findingId: doc.findingId } : {}) };
}

/** Operator-attested external audit, never worker self-report or completion authority. */
export function importMetricObservations(store: MissionStore, value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("observation import must be an array");
  const ids = new Set<string>(), corrections = new Set<string>();
  const validated = value.map((row) => {
    const o = validateEvaluationObservation(row, row?.missionId);
    if (ids.has(o.id)) throw new Error("duplicate observation id in import");
    ids.add(o.id);
    const m = store.inspectMission(o.missionId);
    const existing = m.evaluations.find((item) => item.id === o.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(o)) throw new Error("observation id replay contents differ");
    const p = provenance(store, o);
    const workers = m.events.filter((e) => e.kind === "attempt.reserved").map((e) => e.attemptId);
    if (workers.includes(o.evaluatorIdentity) || ["developer", "worker", "self", "engine"].includes(o.evaluatorIdentity))
      throw new Error("worker or engine self-report is not independent evaluation");
    if (!m.events.some((e) => e.revision === o.revision &&
      (e.kind === "mission.result.integrated" &&
        JSON.parse(store.readArtifact(String(e.payload.reportHash)).toString()).acceptedManifestHash === o.resultManifestHash ||
       e.kind === "mission.finalization.published" && e.payload.manifestHash === o.resultManifestHash ||
       e.kind === "mission.completed" && e.payload.manifestHash === o.resultManifestHash)))
      throw new Error("observation result identity is not a stored result at the stated revision");
    for (const hash of o.evidenceRefs) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("observation evidence must be content-addressed artifacts");
      if (sha256(store.readArtifact(hash)) !== hash) throw new Error("observation evidence identity mismatch");
    }
    if (Date.parse(o.observedAt) > Date.now() || o.windowEnd && Date.parse(o.windowEnd) > Date.parse(o.observedAt))
      throw new Error("observation time or follow-up window is in the future");
    if (o.supersedesId) {
      const key = `${o.missionId}:${o.supersedesId}`;
      if (corrections.has(key)) throw new Error("duplicate correction target in import");
      corrections.add(key);
      const previous = m.evaluations.find((item) => item.id === o.supersedesId);
      if (!previous || previous.classification !== o.classification || previous.criterionVersion !== o.criterionVersion ||
        previous.revision !== o.revision || previous.resultManifestHash !== o.resultManifestHash ||
        Date.parse(previous.observedAt) > Date.parse(o.observedAt)) throw new Error("correction target identity mismatch");
      if (m.evaluations.some((item) => item.supersedesId === previous.id && item.id !== o.id))
        throw new Error("correction target already superseded");
    }
    return { o, p };
  });
  // Validation completes before importing anything; persistence uses the existing journal/CAS path.
  for (const { o } of validated) store.recordEvaluationObservation(o, store.inspectMission(o.missionId).version);
  return validated.map(({ o }) => o.id);
}

export function captureMetricMission(store: MissionStore, mission: MissionInspection,
  engineCommit: string, cutoff = mission.latestSeq): CapturedMission {
  if (!Number.isInteger(cutoff) || cutoff < 1 || cutoff > mission.latestSeq) throw new Error("invalid metrics event cutoff");
  const events = mission.events.filter((e) => e.seq <= cutoff);
  const revisions = events.filter((e) => ["mission.created", "mission.revised"].includes(e.kind)).map((e) => {
    const snapshot = e.payload.snapshot as MissionInspection["snapshot"];
    const definition = JSON.parse(store.readArtifact(snapshot.definitionHash).toString("utf8"));
    return { revision: e.revision, planHash: snapshot.planHash, definitionHash: snapshot.definitionHash,
      authorityHash: sha256(Buffer.from(JSON.stringify(definition.authority))), budget: definition.budget,
      policies: definition.authority.rolePolicies,
      criteria: definition.units.map((u: { id: string; acceptance: unknown }) => ({
        unitId: u.id, criterionHash: sha256(Buffer.from(JSON.stringify(u.acceptance))) })) };
  });
  return { missionId: mission.id, asOfSeq: cutoff, asOfTime: events.at(-1)!.occurredAt,
    identity: { planId: mission.planId, repositoryId: mission.repositoryId, engineCommit,
      runtime: process.version, revisions },
    facts: events.map((e) => {
      const binding = e.payload.binding as Record<string, unknown> | undefined;
      const data = Object.fromEntries(DATA_FIELDS.filter((key) => e.payload[key] !== undefined).map((key) => [key, e.payload[key]]));
      if (binding) {
        data.effort = binding.teamBundleHash || binding.consultationId ? "team" : binding.recoveryOf || binding.recoveryMode || binding.roundId === "recovery" ? "recovery" :
          binding.finalization ? "verification" : "implementation";
        data.round = binding.roundId;
        data.memberId = binding.memberId;
        data.rolePolicyHash = binding.rolePolicyHash;
        data.inputManifestHash = binding.inputManifestHash;
        data.correctionNo = binding.correctionNo;
        data.recoveryOf = binding.recoveryOf;
        data.ownerEpoch = binding.ownerEpoch;
      }
      const interruption = e.payload.interruption as Record<string, unknown> | undefined;
      if (interruption?.pauseEventId) data.pauseEventId = interruption.pauseEventId;
      const owner = e.payload.owner as Record<string, unknown> | undefined;
      if (owner?.epoch !== undefined) data.ownerEpoch = owner.epoch;
      if (e.kind === "mission.result.integrated")
        data.acceptedManifestHash = JSON.parse(store.readArtifact(String(e.payload.reportHash)).toString()).acceptedManifestHash;
      if (e.monotonicDurationMs !== null) data.durationMs = e.monotonicDurationMs;
      return { id: e.eventId, seq: e.seq, kind: e.kind, at: e.occurredAt, runtime: e.runtimeId,
        revision: e.revision, attempt: e.attemptId, unit: e.unitId, round: e.teamRoundId, data };
    }),
    observations: events.filter((e) => e.kind === "evaluation.observed").flatMap((e) => {
      const observation = validateEvaluationObservation(e.payload, mission.id);
      try { return [{ seq: e.seq, observation, provenance: provenance(store, observation) }]; }
      catch { return []; } // Legacy/unattested assessments stay unassessed, never promoted to success.
    }) };
}

const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const ratio = (n: number, d: number) => d ? n / d : null;
function distribution(values: Array<number | null>) {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return { samples: known.length, unknown: values.length - known.length, unit: "ms", total: known.reduce((a, b) => a + b, 0),
    min: known[0] ?? null, median: known.length ? known[Math.floor((known.length - 1) / 2)] : null,
    p95: known.length ? known[Math.ceil(known.length * .95) - 1] : null, max: known.at(-1) ?? null };
}

/** Pure projection. No store, scheduler, clock, or mutation in this function. */
export function calculateMissionMetrics(cohort: MetricCohort) {
  if (cohort.format !== "mission-metric-cohort-v1" || cohort.metricVersion !== METRIC_VERSION ||
    !["deterministic-fixture", "live-evaluation", "normal-use"].includes(cohort.population))
    throw new Error("unsupported metric capture format/version/population");
  if (new Set(cohort.missions.map((m) => m.missionId)).size !== cohort.missions.length) throw new Error("duplicate cohort mission");
  const counts = { admitted: 0, terminal: 0, unfinished: 0, cancelled: 0, passed: 0, failed: 0, inconclusive: 0, unassessed: 0,
    rescueFreePassed: 0, rescue: 0, goalAuthority: 0, interventionUnknown: 0 };
  const effort = Object.fromEntries(["implementation", "verification", "recovery", "team"].map((k) => [k,
    { inputTokens: 0, outputTokens: 0, estimatedUSD: 0, unknownUsage: 0, unknownCost: 0, requests: 0 }])) as
    Record<Effort, { inputTokens: number; outputTokens: number; estimatedUSD: number; unknownUsage: number; unknownCost: number; requests: number }>;
  const time: Record<string, Array<number | null>> = Object.fromEntries(
    ["delivery", "engineActive", "paused", "resourceWait", "humanWait", "model", "tool", "dispatch", "visibleResponse", "assessmentDelay"].map((k) => [k, []]));
  const recovery = { episodes: 0, resumed: 0, safelyDeferred: 0, failed: 0, unknown: 0, reused: 0, repeated: 0, checkpointDelay: [] as Array<number | null> };
  const rework = { correctiveAttempts: 0, reopenedUnits: 0, confirmedDefects: [] as unknown[], followUpAssessed: 0 };
  const safeguards = { confirmed: [] as unknown[], prevented: 0, unknown: 0 };
  const team = { rounds: [] as unknown[], work: [] as unknown[], distinctConfirmedFindings: 0 };
  const findings = new Set<string>(), pricing = new Set<string>();
  const outcomes: unknown[] = [];
  for (const mission of [...cohort.missions].sort((a, b) => a.missionId.localeCompare(b.missionId))) {
    const seen = new Set<string>();
    const facts = mission.facts.filter((f) => f.seq <= mission.asOfSeq && !seen.has(f.id) && !!seen.add(f.id)).sort((a, b) => a.seq - b.seq);
    const activation = facts.find((f) => f.kind === "mission.activated");
    if (!activation) continue;
    counts.admitted++;
    const revision = facts.filter((f) => f.kind === "mission.revised").at(-1)?.revision ?? activation.revision;
    const result = facts.filter((f) => f.revision === revision && ["mission.completed", "mission.result.integrated"].includes(f.kind)).at(-1);
    const manifest = result?.data.manifestHash ?? result?.data.acceptedManifestHash;
    const cancelled = facts.some((f) => f.kind === "mission.cancelled");
    const completed = facts.some((f) => f.kind === "mission.completed" && f.revision === revision);
    counts[cancelled || completed ? "terminal" : "unfinished"]++;
    if (cancelled) counts.cancelled++;
    const admittedObservations = mission.observations.filter((o) => o.seq <= mission.asOfSeq && Date.parse(o.observation.observedAt) <= Date.parse(mission.asOfTime));
    const superseded = new Set(admittedObservations.map((o) => o.observation.supersedesId));
    const current = admittedObservations.filter((o) => !superseded.has(o.observation.id) &&
      o.observation.revision === revision && o.observation.resultManifestHash === manifest);
    const outcome = current.filter((o) => o.observation.classification === "outcome").sort((a, b) => a.seq - b.seq).at(-1);
    const verdict = outcome?.observation.verdict ?? "unassessed";
    counts[verdict === "pass" ? "passed" : verdict === "fail" ? "failed" : verdict === "inconclusive" ? "inconclusive" : "unassessed"]++;
    const interventions = current.filter((o) => o.observation.classification === "operator_intervention");
    const rescue = interventions.some((o) => o.provenance.intervention === "rescue") ||
      facts.some((f) => f.kind === "mission.input.recorded" && f.data.intervention === "operational_rescue");
    const noRescue = !rescue && interventions.some((o) => o.provenance.intervention === "none");
    if (rescue) counts.rescue++;
    if (interventions.some((o) => o.provenance.intervention === "goal_authority") || facts.some((f) => f.kind === "mission.revised")) counts.goalAuthority++;
    if (!rescue && !noRescue) counts.interventionUnknown++;
    if (noRescue && verdict === "pass") counts.rescueFreePassed++;
    outcomes.push({ missionId: mission.missionId, revision, manifest: manifest ?? null, verdict,
      observationId: outcome?.observation.id ?? null, criteriaVersion: outcome?.observation.criterionVersion ?? null });
    const attempts = facts.filter((f) => f.kind === "attempt.reserved");
    const categories = new Map(attempts.map((f) => [f.attempt, f.data.effort as Effort ?? "implementation"]));
    const requests = new Set<string>();
    for (const f of facts.filter((f) => f.kind === "provider.request.dispatched")) {
      const id = String(f.data.requestId);
      if (requests.has(id)) continue;
      requests.add(id);
      const receipt = facts.find((r) => r.kind === "provider.request.receipt" && r.data.requestId === id);
      const cost = effort[categories.get(f.attempt) ?? "implementation"];
      cost.requests++;
      const input = number(receipt?.data.inputTokens), output = number(receipt?.data.outputTokens), usd = number(receipt?.data.estimatedCost);
      cost.inputTokens += input ?? 0; cost.outputTokens += output ?? 0;
      if (input === null || output === null) cost.unknownUsage++;
      cost.estimatedUSD += usd ?? 0; if (usd === null) cost.unknownCost++;
      pricing.add(String(receipt?.data.pricingBasis ?? "unknown"));
      time.model!.push(number(receipt?.data.durationMs));
      if (categories.get(f.attempt) === "team") {
        const attempt = attempts.find((a) => a.attempt === f.attempt);
        const result = facts.find((r) => r.kind === "attempt.receipt" && r.attempt === f.attempt);
        team.work.push({ missionId: mission.missionId, revision: f.revision, attemptId: f.attempt,
          round: attempt?.data.round ?? attempt?.round ?? null, member: attempt?.data.memberId ?? null,
          requestId: id, inputTokens: input, outputTokens: output, estimatedUSD: usd,
          durationMs: number(receipt?.data.durationMs), resultArtifactHash: result?.data.artifactHash ?? null });
      }
    }
    for (const f of facts) {
      if (["mission.active.duration", "mission.active.window.checkpointed", "mission.active.window.closed"].includes(f.kind)) time.engineActive!.push(number(f.data.durationMs));
      if (f.kind === "dispatch.observed") time.dispatch!.push(number(f.data.queueWaitMs));
      if (f.kind === "mission.input.visible") time.visibleResponse!.push(number(f.data.responseMs));
      if (f.kind === "effect.receipt") time.tool!.push(number(f.data.durationMs));
      if (f.kind === "resource.wait") time.resourceWait!.push(number(f.data.durationMs));
      if (f.kind === "effect.denied") safeguards.prevented++;
      if (f.kind === "effect.unknown") safeguards.unknown++;
      if (f.kind === "team.barrier.recorded") team.rounds.push({ missionId: mission.missionId, revision: f.revision,
        round: f.data.round, seq: f.seq });
    }
    time.delivery!.push(result ? Math.max(0, Date.parse(result.at) - Date.parse(activation.at)) : null);
    time.assessmentDelay!.push(outcome && result ? Math.max(0, Date.parse(outcome.observation.observedAt) - Date.parse(result.at)) : null);
    // No paired durable monotonic observation yet: do not manufacture these durations from wall-clock gaps.
    time.paused!.push(null); time.humanWait!.push(null);
    const episodes = new Map<string, MetricFact>();
    for (const f of facts.filter((f) => f.kind === "attempt.interrupted" ||
      f.kind === "attempt.settled" && f.data.status === "interrupted" ||
      f.kind === "mission.owner.released" && !facts.some((prior) => prior.seq < f.seq &&
        ["mission.completed", "mission.cancelled"].includes(prior.kind)))) {
      const pause = f.kind === "mission.owner.released" && f.data.ownerEpoch !== undefined
        ? facts.filter((prior) => prior.seq < f.seq && prior.kind === "mission.paused" &&
          prior.runtime === f.runtime && prior.data.ownerEpoch === f.data.ownerEpoch).at(-1) : undefined;
      const pausedRelease = pause && !facts.some((prior) => prior.seq > pause.seq && prior.seq < f.seq &&
        prior.kind === "mission.resumed");
      const key = String(f.data.pauseEventId ?? (pausedRelease ? pause.id : `${f.runtime}:${f.data.ownerEpoch ?? f.id}`));
      if (!episodes.has(key)) episodes.set(key, f);
    }
    for (const episode of episodes.values()) {
      recovery.episodes++;
      const checkpoint = facts.find((f) => f.seq > episode.seq && f.kind === "unit.accepted");
      if (checkpoint) {
        recovery.resumed++;
        recovery.checkpointDelay.push(episode.runtime === checkpoint.runtime ? Math.max(0, Date.parse(checkpoint.at) - Date.parse(episode.at)) : null);
      } else if (cancelled || facts.some((f) => f.seq > episode.seq && f.kind === "mission.paused")) recovery.safelyDeferred++;
      else if (facts.some((f) => f.seq > episode.seq && f.kind === "mission.exhausted")) recovery.failed++;
      else recovery.unknown++;
    }
    recovery.reused += facts.filter((f) => f.kind === "mission.recovery.continuation.recorded").length;
    recovery.repeated += attempts.filter((f) => f.data.recoveryOf).length;
    rework.correctiveAttempts += attempts.filter((f) => number(f.data.correctionNo) !== null && Number(f.data.correctionNo) > 0).length;
    rework.reopenedUnits += facts.filter((f) => f.kind === "unit.ready" &&
      facts.some((prior) => prior.kind === "unit.accepted" && prior.unit === f.unit && prior.seq < f.seq)).length;
    if (current.some((o) => o.observation.windowEnd)) rework.followUpAssessed++;
    for (const o of admittedObservations.filter((o) => !superseded.has(o.observation.id) && o.observation.classification === "confirmed_defect")) {
      const link = { missionId: mission.missionId, revision: o.observation.revision,
        manifest: o.observation.resultManifestHash, observation: o.observation.id,
        criterion: o.observation.criterionVersion, windowStart: o.observation.windowStart, windowEnd: o.observation.windowEnd,
        evidence: o.observation.evidenceRefs };
      rework.confirmedDefects.push(link);
      if (o.provenance.safeguard) safeguards.confirmed.push({ ...link, violation: o.provenance.safeguard });
      if (o.provenance.findingId) findings.add(`${mission.missionId}:${o.provenance.findingId}`);
    }
  }
  team.distinctConfirmedFindings = findings.size;
  const total = Object.values(effort).reduce((a, c) => ({ estimatedUSD: a.estimatedUSD + c.estimatedUSD,
    inputTokens: a.inputTokens + c.inputTokens, outputTokens: a.outputTokens + c.outputTokens,
    unknownCost: a.unknownCost + c.unknownCost, unknownUsage: a.unknownUsage + c.unknownUsage }),
  { estimatedUSD: 0, inputTokens: 0, outputTokens: 0, unknownCost: 0, unknownUsage: 0 });
  return { format: "mission-metric-report-v1", metricVersion: METRIC_VERSION, population: cohort.population, label: cohort.label,
    captureHash: sha256(Buffer.from(JSON.stringify(cohort))), identities: cohort.missions.map(({ facts, observations, ...identity }) => identity),
    counts, correctness: { numerator: counts.passed, denominator: counts.admitted, rate: ratio(counts.passed, counts.admitted) },
    coverage: { numerator: counts.passed + counts.failed + counts.inconclusive, denominator: counts.admitted,
      rate: ratio(counts.passed + counts.failed + counts.inconclusive, counts.admitted) },
    rescueFree: { numerator: counts.rescueFreePassed, denominator: counts.admitted, rate: ratio(counts.rescueFreePassed, counts.admitted) },
    costs: { ...total, effort, pricingBasis: [...pricing].sort(), unit: "USD estimate, not invoiced",
      estimatedCostPerSuccess: total.unknownCost ? null : ratio(total.estimatedUSD, counts.passed), denominator: counts.passed,
      completeness: total.unknownCost ? "incomplete lower bound" : "SDK estimates only; not billed spend",
      reservationsAreSpend: false },
    time: Object.fromEntries(Object.entries(time).map(([k, v]) => [k, distribution(v)])),
    recovery: { ...recovery, checkpointDelay: distribution(recovery.checkpointDelay) }, rework, team, safeguards, outcomes,
    evidenceStatus: counts.admitted < 20 || cohort.population === "deterministic-fixture" ? "insufficient evidence of live effectiveness" : "descriptive only; comparison protocol required",
    definitions: {
      population: "All activated missions in explicit cohort, at each captured sequence and time; revisions are not extra missions.",
      outcome: "Latest non-superseded independent attested outcome for current revision/result; absent or obsolete is unassessed.",
      cost: "All distinct dispatched requests including failures/retries; known tokens and SDK USD estimates, unknown exposure separate.",
      time: "Observed samples only; unpaired/cross-runtime crash intervals unknown; milliseconds, no inferred human minutes.",
      recovery: "Interruption episodes grouped by pause identity or runtime/owner epoch, otherwise distinct event; later accepted unit is checkpoint, unknown crash delay retained.",
      rework: "Linked current artifact/revision defects with follow-up windows; missing follow-up is not defect-free.",
      team: "Round attribution and cost/time are descriptive; distinct confirmed findings do not prove benefit.",
      safeguards: "Confirmed independent evidenced violations are defects; denials are prevented attempts, uncertainty not zero violations.",
    } };
}

export function metricCommand(store: MissionStore, args: string, engineCommit: string) {
  const parts = args.trim().split(/\s+/);
  if (parts[0] === "--import-observations") {
    if (parts.length !== 2) throw new Error("use metrics --import-observations <file> in operator console");
    return { imported: importMetricObservations(store, JSON.parse(readFileSync(parts[1]!, "utf8"))) };
  }
  let cohort: MetricCohort;
  const exportIndex = parts.indexOf("--export");
  const exportFile = exportIndex < 0 ? undefined : parts[exportIndex + 1];
  const input = exportIndex < 0 ? parts : parts.slice(0, exportIndex);
  if (exportIndex >= 0 && (!exportFile || exportIndex + 2 !== parts.length)) throw new Error("use --export <report.json>");
  if (input[0] === "--cohort" && input.length === 2) cohort = JSON.parse(readFileSync(input[1]!, "utf8"));
  else if (input.length === 1 && input[0]) cohort = { format: "mission-metric-cohort-v1", metricVersion: METRIC_VERSION,
    population: "normal-use", label: "local mission", missions: [captureMetricMission(store, store.inspectMission(input[0]), engineCommit)] };
  else throw new Error("use metrics <mission-id> or --cohort <capture.json> [--export <report.json>]");
  const report = calculateMissionMetrics(cohort);
  if (exportFile) writeFileSync(exportFile, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return report;
}
