import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine } from "../extensions/mission/engine.ts";
import { currentWholeResultApproval, FINALIZATION_PHASES } from "../extensions/mission/finalization.ts";
import { missionCompletionCertificate } from "../extensions/mission/completion.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "../tests/mission-fixtures.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";
import { sha256 } from "../extensions/mission/model.ts";
import { assessMissionCompletion } from "../extensions/mission/completion.ts";
import { openBoard } from "../extensions/board/store.ts";
import { registerBoard } from "../extensions/board/tools.ts";
import { repositoryIdentity } from "../extensions/board/workspace.ts";
import { reconcileMission } from "../extensions/mission/reconcile.ts";
import { openMissionStore } from "../extensions/mission/store.ts";

const evidence = process.argv[2];
const teamScenario = process.env.MISSION_T6_TEAM === "1";
const sample = createMissionFixture("pitako-b-node-sdk-");
const agentDir = sample.stateDir;
const config = path.join(agentDir, "pitako/config.toml");
mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src/a"), "original\n");
const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
let store; let engine;
try {
  let requested = false;
  const provider = await installMissionLocalProvider({ agentDir, responseForPrompt(prompt) {
    if (teamScenario && prompt.includes('"format":"mission-team-bundle-v1"')) {
      const b = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
      if (b.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: b.phase,
        round: b.round, memberId: b.memberId, classifications: b.priorFindings.map(({ id, evidenceRefs }) =>
          ({ findingId: id, evidenceRefs, category: "uncertainty", reason: "Host byte check required; protocol is not expert truth" })) });
      const peer = b.priorFindings?.find(({ id }) => !id.includes(`:${b.memberId}:`)) ?? b.priorFindings?.[0];
      return JSON.stringify({ format: "mission-team-response-v1", phase: b.phase, round: b.round, memberId: b.memberId,
        findings: [{ id: "bytes", claim: "Check delivered bytes", evidenceRefs: [`bytes:${b.memberId}`],
          detail: { recommendation: "Inspect exact bytes", impact: "Private result only" },
          ...(peer ? { respondsTo: { id: peer.id, evidenceRefs: peer.evidenceRefs } } : {}) }] });
    }
    if (!prompt.includes('"format":"mission-finalization-brief-v1"')) {
      if (teamScenario && !requested) {
        requested = true;
        return JSON.stringify({ format: "mission-consultation-request-v1", question: "Assess private product",
          evidenceRefs: ["."], members: ["alpha", "beta", "gamma"].map((id) => ({ id, role: "developer", perspective: id })),
          synthesisRole: "developer" });
      }
      return "producer";
    }
    const brief = JSON.parse(prompt.slice(prompt.indexOf('{"format":"mission-finalization-brief-v1"')).split("\n", 1)[0]);
    return JSON.stringify(brief.target.phase === "whole-review" ? { ...brief.expectedResponse, verdict: "approve" } :
      { ...brief.expectedResponse, steps: brief.expectedResponse.steps.map((skill) => ({
        skill, changedPaths: [], noOpReason: "Inspected exact changed scope; no behavior-preserving simplification needed",
      })) });
  } });
  const definition = missionDefinition();
  definition.finalization.contractVersion = 1;
  definition.authority.allowedPaths = ["src/**"]; definition.authority.operations = ["write", "bash"];
  for (const role of ["developer", "reviewer"]) definition.authority.rolePolicies[role] = {
    hash: sha256(Buffer.from(role)), provider: provider.provider, model: provider.model, fallbacks: [],
  };
  definition.units = [{ id: "product", kind: "implementation", role: "developer", dependencies: [], inputs: ["."], outputs: ["src/a"],
    acceptance: [{ id: "bytes", kind: "artifact_hash", target: "path:src/a", expected: sha256(Buffer.from("product\n")) },
      { id: "command", kind: "command_exit", target: "result", command: "printf 'node-gate\\n'; grep -q '^product$' src/a",
        expected: "0", timeoutMs: 3000 }],
    risk: "low", retryLimit: 0 }];
  definition.finalization.requiredPredicates = ["bytes", "command"];
  definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 10000, activeTimeMs: 120000, artifactBytes: 32_000_000 };
  let topic;
  if (teamScenario) {
    // Read-only specialists advise a suspended producer; only its continuation owns output acceptance.
    definition.budget.roleLaunches = 15; definition.budget.providerRequests = 15;
    definition.budget.tokens = 15000;
    definition.budget.activeTimeMs = 1200000;
    const board = await openBoard();
    topic = board.createTopic(repositoryIdentity(sample.root), { title: "Actual Node completion" });
    board.claimTopic(repositoryIdentity(sample.root), topic.id, "durable-fixture"); board.close();
    writeFileSync(sample.planFile, `---\nid: durable-fixture\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\nexecution: expected\n---\n\nNode private delivery.\n`);
  }
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  let missionId;
  let reviewed = false;
  store = await openFixtureStore(sample, (boundary) => {
      if (boundary !== process.env.MISSION_COMPLETION_CUT || !missionId || !reviewed) return;
      mkdirSync(evidence, { recursive: true });
      writeFileSync(path.join(evidence, "crash-location.json"), JSON.stringify({ base: sample.base, root: sample.root,
        dbPath: sample.dbPath, objectDir: sample.objectDir, missionId, boundary }));
      process.exit(86);
  });
  const mission = store.createMission(missionInput(sample)); missionId = mission.id;
  let recoveryPromise;
  const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
    load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
  const options = { store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
    managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
    runRole: async (input, durable) => {
      if (!input.binding.finalization && !input.binding.consultationId && input.binding.unitId === "product")
        assert.equal((await durable.effects.invoke("write", { path: "src/a", content: "product\n" })).status, "completed");
      return runner(input, durable);
    } };
  engine = new MissionEngine(options);
  let interrupted = false;
  let pause;
  const append = store.appendTransition.bind(store);
  store.appendTransition = (id, version, transition) => {
    const result = append(id, version, transition);
    if (transition.events.some((row) => row.kind === "mission.activated"))
      recoveryPromise = reconcileMission({ store, missionId, sourceRoot: sample.root, planFile: sample.planFile });
    reviewed ||= transition.events.some((row) => row.kind === "mission.finalization.reviewed");
    if (teamScenario && !interrupted && transition.events.some((row) => row.kind === "team.barrier.recorded" && row.payload.round === "independent")) {
      interrupted = true; pause = engine.control("pause");
    }
    return result;
  };
  engine.start();
  const recovery = await recoveryPromise;
  assert.equal(recovery.status, "resumed");
  assert.deepEqual(recovery.blockers, []); assert.deepEqual(recovery.disposition.causes, []);
  await engine.waitForIdle();
  if (teamScenario) {
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(path.join(evidence, "journal-interruption.json"), JSON.stringify(store.inspectMission(mission.id), null, 2));
    }
    await pause;
    assert.equal(engine.snapshot().state, "paused");
    await engine.control("resume"); await engine.waitForIdle();
  }
  let inspection = store.inspectMission(mission.id);
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(path.join(evidence, "journal-initial.json"), JSON.stringify(inspection, null, 2));
    provider.flush(path.join(evidence, "provider-initial.json"));
  }
  const approval = currentWholeResultApproval(inspection, store, sample.root);
  assert.equal(approval?.verdict, "approve", JSON.stringify(assessMissionCompletion(inspection, store)));
  assert.equal(new Set(provider.trace.map((row) => row.sessionId)).size, teamScenario ? 15 : 4);
  assert.deepEqual(inspection.events.filter((row) => row.kind === "mission.finalization.phase.receipted").map((row) => row.payload.target.phase), FINALIZATION_PHASES);
  const certificate = missionCompletionCertificate(inspection, store);
  assert.ok(certificate, JSON.stringify(assessMissionCompletion(inspection, store)));
  const evaluation = { schemaVersion: 1, id: randomUUID(), missionId: mission.id, revision: inspection.revision,
    resultManifestHash: certificate.manifestHash, criterionVersion: "t6-outcome-separation-v1",
    evaluatorIdentity: "independent-negative-control", method: "scripted evaluator control, not expert truth",
    observedAt: new Date().toISOString(), windowStart: null, windowEnd: null, evidenceRefs: [certificate.manifestHash],
    verdict: "unassessed", classification: "outcome", supersedesId: null };
  store.recordEvaluationObservation(evaluation, store.inspectMission(mission.id).version);
  const disproven = { ...evaluation, id: randomUUID(), verdict: "fail", supersedesId: evaluation.id };
  store.recordEvaluationObservation(disproven, store.inspectMission(mission.id).version);
  store.recordEvaluationObservation(disproven, store.inspectMission(mission.id).version);
  inspection = store.inspectMission(mission.id);
  assert.equal(inspection.evaluations.length, 2);
  assert.equal(missionCompletionCertificate(inspection, store)?.certificateHash, certificate.certificateHash);
  await engine.retireForShutdown("quit");
  store = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
  engine = new MissionEngine({ ...options, store }); assert.throws(() => engine.start(), /completed cannot start/);
  engine = undefined;
  inspection = store.inspectMission(mission.id);
  assert.equal(inspection.events.at(-1)?.kind, "mission.owner.released");
  assert.equal(inspection.events.at(-1)?.payload.effectsQuiescent, true);
  assert.equal(currentWholeResultApproval(inspection, store, sample.root)?.manifestHash, approval.manifestHash);
  assert.equal(inspection.events.filter((row) => row.kind === "mission.finalization.reviewed").length, 1);
  assert.equal(missionCompletionCertificate(inspection, store)?.certificateHash, certificate.certificateHash);
  let boardObservation;
  if (teamScenario) {
    const tools = new Map();
    registerBoard({ registerTool: (tool) => tools.set(tool.name, tool), registerFlag() {}, registerCommand() {}, on() {} });
    const invoke = () => tools.get("board_workflow_lifecycle").execute("node-call", { planId: mission.planId, status: "resolved" },
      new AbortController().signal, undefined, { cwd: sample.root });
    const first = await invoke(), second = await invoke();
    assert.ok(!first.isError, JSON.stringify(first)); assert.ok(!second.isError, JSON.stringify(second));
    const board = await openBoard();
    assert.equal(board.readTopic(repositoryIdentity(sample.root), topic.id).topic.status, "resolved"); board.close();
    const rounds = inspection.events.filter((row) => row.kind === "team.barrier.recorded");
    assert.deepEqual(rounds.map((row) => row.payload.round), ["independent", "critique", "rebuttal", "synthesis"]);
    assert.equal(inspection.events.filter((row) => row.kind === "attempt.reserved" && row.payload.binding.consultationId &&
      !row.payload.binding.continuationOf).length, 10);
    boardObservation = { first, second, status: "resolved", rounds: rounds.map((row) => row.payload.round), interrupted, completedTeamSlots: 10 };
    writeFileSync(path.join(sample.root, "src/a"), "tampered\n");
    assert.equal(missionCompletionCertificate(store.inspectMission(mission.id), store), undefined);
    const stale = await invoke(); assert.ok(stale.isError);
    writeFileSync(path.join(sample.root, "src/a"), "original\n");
    assert.equal(missionCompletionCertificate(store.inspectMission(mission.id), store), undefined);
    boardObservation.staleRejected = true; boardObservation.restoredStillRejected = true;
  }
  assert.equal(readFileSync(path.join(sample.root, "src/a"), "utf8"), "original\n");
  if (evidence) {
    mkdirSync(evidence, { recursive: true }); provider.flush(path.join(evidence, "provider.json"));
    writeFileSync(path.join(evidence, "journal.json"), JSON.stringify(inspection, null, 2));
    await store.exportMission(mission.id, path.join(evidence, "export"));
    writeFileSync(path.join(evidence, "observed.json"), JSON.stringify({ runtime: process.version, certificate,
      recovery, boardObservation, teamScenario, exactNodeRestart: true, sourcePreserved: true, completionPublished: true,
      outcomeObservations: inspection.evaluations, engineCompletedNotVerifiedOutcome: true }, null, 2));
  }
  console.log(JSON.stringify({ format: "mission-node-sdk-b-v1", runtime: process.version, producer: "actual Pi SDK local provider",
    approval, certificate, boardObservation, exactNodeRestart: true, sourcePreserved: true, completionPublished: true }));
} finally {
  if (evidence && store && engine) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(path.join(evidence, "journal-final.json"), JSON.stringify(store.inspectMission(engine.missionId), null, 2));
  }
  await engine?.retireForShutdown("quit"); store?.close(); rmSync(sample.base, { recursive: true, force: true });
  if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
}
