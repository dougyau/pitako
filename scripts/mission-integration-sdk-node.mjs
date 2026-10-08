import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadPitako } from "./load-pitako.ts";
import { createMissionFixture, missionDefinition } from "../tests/mission-fixtures.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import { missionCompletionCertificate } from "../extensions/mission/completion.ts";
import { chosenDefinition, nextPlanBytes } from "../extensions/mission/admission.ts";
import { captureMetricMission, calculateMissionMetrics, importMetricObservations, METRIC_VERSION } from "../extensions/mission/metrics.ts";
import { sha256 } from "../extensions/mission/model.ts";
import { auditCompletionEvidence } from "../extensions/mission/completion-evidence.ts";
import { readContributionInput, readSealedWorkspaceImage } from "../extensions/mission/reconcile.ts";

const script = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(script), "..");
const probe = process.argv[2] === "--probe";
const evidence = probe ? undefined : process.argv[2];
const prior = process.env.PI_CODING_AGENT_DIR;
let session, loaded, reader, sample, provider, missionId;
const calls = [];
let phase = "interrupt";
let releaseProvider;
const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
let shutdown, midEffect;
let scenarioDone = false;
process.once("beforeExit", () => {
  if (scenarioDone || process.exitCode === 1) return;
  save("incomplete.json", { message: "SDK scenario exited with unfinished asynchronous work", phase, calls });
  if (reader) save("journal-incomplete.json", reader.inspectMission(missionId));
  if (provider && evidence) provider.flush(path.join(evidence, "provider-incomplete.json"));
  console.error("SDK scenario did not finish");
  process.exitCode = 1;
});
async function wait(check, label, interval = 25) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise((r) => setTimeout(r, interval)); }
  throw new Error(`timed out: ${label}`);
}
async function foreground(root, agentDir) {
  if (!loaded) loaded = await loadPitako(packageRoot, root, agentDir);
  if (agentDir) loaded.agentDir = agentDir;
  process.env.PI_CODING_AGENT_DIR = loaded.agentDir;
  await loaded.loader.reload();
  const runtime = await ModelRuntime.create({ authPath: path.join(loaded.agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  session = (await createAgentSession({ cwd: root, agentDir: loaded.agentDir, resourceLoader: loaded.loader,
    sessionManager: SessionManager.inMemory(root), modelRuntime: runtime })).session;
  await session.bindExtensions({ mode: "rpc" });
  await session.prompt("/mission console");
  return await wait(() => readdirSync(path.join(loaded.agentDir, "pitako/console")).find((name) =>
    name.startsWith(`operator-${process.pid}-`) && name.endsWith(".sock")), "operator socket");
}
async function frame(socket, payload) {
  const proof = readFileSync(`${socket}.key`).toString("hex");
  return await new Promise((resolve, reject) => {
    const client = createConnection(socket), chunks = [];
    client.setEncoding("utf8"); client.on("error", reject);
    client.on("connect", () => client.write(JSON.stringify({ proof, ...payload }) + "\n"));
    client.on("data", (s) => chunks.push(s));
    client.on("end", () => { try { resolve(JSON.parse(chunks.join(""))); } catch (e) { reject(e); } });
  });
}
async function submit(socket, text, ok = true) {
  const response = await frame(socket, { text });
  calls.push({ text, response });
  assert.equal(response.ok, ok, JSON.stringify(response));
  if (ok) await frame(socket, { visibleId: response.causalId });
  return response;
}
async function closePi() {
  // The actual SDK lifecycle event used by Pi quit, not a store-close approximation.
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose(); session = undefined;
}
function save(name, value) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, name), typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + "\n");
}
try {
  if (probe) {
    const [root, agentDir, missionId] = process.argv.slice(3);
    // A separate Pi SDK process uses the same database, but a private console socket.
    const socket = path.join(agentDir, "pitako/console", await foreground(root, agentDir));
    const denied = await submit(socket, `/mission start ${missionId}`, false);
    assert.match(denied.message, /writer is owned elsewhere/);
    const inspection = await submit(socket, "/mission inspect");
    assert.equal(JSON.parse(inspection.message).authority, "read-only");
    await closePi();
    console.log(JSON.stringify({ pid: process.pid, denied, inspection }));
    scenarioDone = true;
  } else {
    sample = createMissionFixture("t7-s-", "/tmp");
    mkdirSync(path.join(sample.root, "src"));
    writeFileSync(path.join(sample.root, "src/a"), "original\n");
    writeFileSync(path.join(sample.root, "src/user"), "user-before\n");
    execFileSync("git", ["add", "src"], { cwd: sample.root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source"], { cwd: sample.root });
    loaded = await loadPitako(packageRoot, sample.root, sample.stateDir);
    provider = await installMissionLocalProvider({ agentDir: loaded.agentDir,
      responseGate: (prompt) => phase === "interrupt" && !prompt.includes("mission-finalization-brief-v1") ? providerGate : Promise.resolve(),
      toolForPrompt(prompt) {
        if (!prompt.includes("mission-finalization-brief-v1") && phase === "interrupt")
          return { name: "bash", arguments: { command: "printf 'partial\\n' > src/a; sleep 30; printf 'finished\\n' >> src/a" } };
        if (!prompt.includes("mission-finalization-brief-v1") && phase === "revision")
          return { name: "write", arguments: { path: "src/a", content: "product-two\n" } };
      },
      responseForPrompt(prompt) {
        if (!prompt.includes('"format":"mission-finalization-brief-v1"')) return "producer fixture; host checks decide acceptance";
        // The compact JSON brief occupies one line; SDK extensions may append context.
        const brief = JSON.parse(prompt.slice(prompt.indexOf('{"format":"mission-finalization-brief-v1"')).split("\n", 1)[0]);
        return JSON.stringify(brief.target.phase === "whole-review" ? { ...brief.expectedResponse, verdict: "approve" } :
          { ...brief.expectedResponse, steps: brief.expectedResponse.steps.map((skill) => ({ skill,
            changedPaths: [], noOpReason: "Exact tiny byte-change scope inspected; no behavior-preserving cleanup applicable" })) });
      },
    });
    const definition = missionDefinition();
    definition.goal = "Deliver one private byte change after interruption and a user revision";
    definition.finalization.contractVersion = 1;
    definition.authority.allowedPaths = ["src/**"]; definition.authority.operations = ["write", "bash"];
    definition.authority.resumeAfterClose = false;
    for (const role of ["developer", "reviewer"]) definition.authority.rolePolicies[role] = {
      hash: sha256(Buffer.from(role)), provider: provider.provider, model: provider.model, fallbacks: [],
    };
    definition.units = [{ id: "product", kind: "implementation", role: "developer", dependencies: [], inputs: ["src/**"],
      outputs: ["src/a"], acceptance: [{ id: "bytes", kind: "artifact_hash", target: "path:src/a",
        expected: sha256(Buffer.from("product-one\n")) }, { id: "gate", kind: "command_exit", target: "result",
        command: "grep -q '^user-after$' src/user", expected: "0", timeoutMs: 3000 }],
      risk: "low", retryLimit: 0 }];
    definition.finalization.requiredPredicates = ["bytes", "gate"];
    definition.budget = { roleLaunches: 12, providerRequests: 20, tokens: 50000, activeTimeMs: 600000, artifactBytes: 1_000_000_000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    save("initial-definition.json", definition);
    save("initial-plan.md", readFileSync(sample.planFile));
    save("source-original.json", { "src/a": "original\n", "src/user": "user-before\n" });
    let socket = path.join(loaded.agentDir, "pitako/console", await foreground(sample.root));
    save("console-activation.json", { command: "/mission console", socket, endpointBytes: Buffer.byteLength(socket) + 1,
      ownerPid: process.pid, fixtureBase: sample.base });
    await submit(socket, "/mission prepare durable-fixture");
    reader = await openMissionStore({ readOnly: true });
    const mission = reader.findManagedMission(sample.root);
    assert.ok(mission);
    missionId = mission.id;
    await submit(socket, "/mission start durable-fixture");
    await wait(() => reader.inspectMission(mission.id).events.some((e) => e.kind === "provider.request.dispatched"), "SDK request during work");
    await submit(socket, "/mission inspect");
    const beforeMetricRead = reader.inspectMission(mission.id);
    await session.prompt(`/mission metrics ${mission.id}`);
    if (evidence) {
      const existing = path.join(evidence, "initial-definition.json"), before = readFileSync(existing);
      await session.prompt(`/mission metrics ${mission.id} --export ${existing}`);
      assert.deepEqual(readFileSync(existing), before);
    }
    assert.deepEqual(reader.inspectMission(mission.id), beforeMetricRead);
    save("metric-read-during-work.json", { unchanged: true, overwriteRejected: !!evidence,
      evidence: "journal unchanged; existing export target bytes unchanged" });
    const beforeProbe = reader.inspectMission(mission.id).latestSeq;
    const contender = spawnSync(process.execPath, [script, "--probe", sample.root, loaded.agentDir, mission.id], {
      encoding: "utf8", env: { ...process.env }, timeout: 60000 });
    assert.equal(contender.status, 0, contender.stderr + contender.stdout);
    const probeResult = JSON.parse(contender.stdout.trim().split("\n").at(-1));
    assert.notEqual(probeResult.pid, process.pid);
    assert.equal(reader.inspectMission(mission.id).latestSeq, beforeProbe);
    save("contender.json", probeResult);
    releaseProvider();
    midEffect = await wait(() => {
      const m = reader.inspectMission(missionId);
      const registered = m.events.findLast((e) => e.kind === "effect.process.registered");
      const binding = m.events.find((e) => e.kind === "attempt.reserved" && e.attemptId === registered?.attemptId)?.payload.binding;
      return registered &&
        existsSync(`/proc/${registered.payload.identity.pid}`) &&
        binding?.candidateRoot && existsSync(path.join(binding.candidateRoot, "src/a")) &&
        readFileSync(path.join(binding.candidateRoot, "src/a"), "utf8") === "partial\n" &&
        m.events.some((e) => e.kind === "effect.released" && e.effectId === registered.effectId) &&
        !m.events.some((e) => e.kind === "effect.receipt") && m;
    }, "actual SDK managed child alive without a receipt", 1);
    save("journal-mid-effect.json", midEffect);
    shutdown = closePi();
    await shutdown;
    const interrupted = reader.inspectMission(mission.id);
    assert.ok(interrupted.events.some((e) => e.kind === "attempt.interrupted" ||
      e.kind === "attempt.receipt" && e.payload.status === "cancelled"));
    const release = interrupted.events.findLast((e) => e.kind === "mission.owner.released");
    assert.equal(release.payload.effectsQuiescent, true);
    assert.equal(readFileSync(path.join(sample.root, "src/a"), "utf8"), "original\n");
    save("journal-interrupted.json", interrupted);
    const pause = interrupted.events.findLast((e) => e.kind === "mission.paused");
    const settlement = interrupted.events.find((e) => e.kind === "attempt.settled" && e.payload.status === "interrupted");
    assert.equal(pause.payload.controlOrigin, "lifecycle");
    assert.equal(pause.payload.resumeAfterClose, false);
    assert.equal(release.payload.pauseEventId, pause.eventId);
    assert.ok(settlement, "actual disposed SDK stop must have a bound interruption");
    const interruptionProof = JSON.parse(reader.readArtifact(settlement.payload.interruption.proofHash));
    assert.equal(interruptionProof.pauseEventId, pause.eventId);
    assert.equal(interruptionProof.sdkDisposed, true);
    assert.equal(interruptionProof.effectsQuiescent, true);
    assert.equal(interruptionProof.processesQuiescent, true);
    const effectReceipt = interrupted.events.find((e) => e.kind === "effect.receipt" && e.effectId === midEffect.events.findLast((e) => e.kind === "effect.released").effectId);
    assert.equal(effectReceipt.payload.status, "failed");
    assert.equal(effectReceipt.payload.termination, "signal");
    assert.equal(effectReceipt.payload.process.descendantsQuiescent, true);
    assert.equal(effectReceipt.payload.process.namespaceEmptyAfterExit, true);
    assert.deepEqual(auditCompletionEvidence(interrupted.events, reader, interrupted), { effects: [], writers: [] });
    assert.equal(missionCompletionCertificate(interrupted, reader), undefined); // Stop safety is not acceptance.
    const sealed = JSON.parse(reader.readArtifact(interruptionProof.observedImageHash));
    save("sealed-partial-image.json", sealed);
    save("stopped-effect-receipt.json", effectReceipt);
    save("interruption-proof.json", interruptionProof);
    if (process.env.PITAKO_T7_CLOSE_ONLY) {
      await reader.exportMission(mission.id, path.join(evidence, "mission-export"));
      provider.flush(path.join(evidence, "provider.json"));
      save("operator-inputs.json", calls);
      console.log("T7 actual SDK orderly close bound interruption passed");
      scenarioDone = true;
    } else {
    writeFileSync(path.join(sample.root, "src/user"), "user-after\n");
    save("source-edited.json", { "src/a": readFileSync(path.join(sample.root, "src/a"), "utf8"),
      "src/user": readFileSync(path.join(sample.root, "src/user"), "utf8") });
    phase = "recover";
    socket = path.join(loaded.agentDir, "pitako/console", await foreground(sample.root));
    await submit(socket, "/mission resume durable-fixture");
    await wait(() => reader.inspectMission(mission.id).events.some((e) => e.kind === "unit.blocked"), "old-revision check fails without inventing acceptance");
    const recovered = reader.inspectMission(mission.id);
    assert.ok(recovered.events.some((e) => e.kind === "mission.recovery.recorded"));
    const observations = recovered.events.filter((event) => event.kind === "mission.recovery.continuation.recorded" && event.payload.lifecycle);
    assert.equal(observations.length, 1);
    const consumers = recovered.events.filter((event) => event.kind === "attempt.reserved" &&
      event.payload.binding.recoveryContinuationId === observations[0].payload.continuationId);
    assert.equal(consumers.length, 1);
    assert.equal(consumers[0].payload.binding.recoveryMode, "verify");
    const contribution = readContributionInput(reader, recovered, consumers[0].payload.binding);
    assert.equal(contribution.originAttemptId, consumers[0].attemptId);
    assert.equal(contribution.baseImageHash, observations[0].payload.lifecycle.basisImageHash);
    const terminal = recovered.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === consumers[0].attemptId);
    const output = JSON.parse(reader.readArtifact(terminal.payload.terminalOutputHash));
    const result = readSealedWorkspaceImage(reader, output.terminalImageHash);
    const fileBytes = (image, file) => image.files.find((row) => row.path === file).bytes.toString();
    assert.equal(fileBytes(result, "src/a"), "partial\n"); // No-write verification retained the predecessor's work.
    assert.equal(fileBytes(result, "src/user"), "user-after\n");
    const recoveryAudit = auditCompletionEvidence(recovered.events, reader, recovered);
    assert.deepEqual(recoveryAudit.effects, []);
    assert.ok(!recoveryAudit.writers.includes(`writer:${observations[0].payload.sourceAttemptId}`));
    assert.equal(missionCompletionCertificate(recovered, reader), undefined);
    assert.equal(recovered.events.filter((event) => event.kind === "mission.recovery.repair.started").length, 0);
    const beforeRetry = recovered.events.filter((event) => event.kind === "attempt.reserved").length;
    await assert.rejects(() => submit(socket, "/mission resume durable-fixture"), /only a paused mission can resume/);
    assert.equal(reader.inspectMission(mission.id).events.filter((event) => event.kind === "attempt.reserved").length, beforeRetry);
    save("journal-recovered.json", recovered);
    save("lifecycle-controls.json", { noWriteRetained: true, userEditRetained: true, contribution,
      consumers: consumers.map((event) => event.attemptId), cleanAuditNotAcceptance: true, noRepair: true, noRepeatedConsumption: true });
    phase = "revision";
    const edits = [
      { target: { kind: "predicate", id: "bytes", field: "expected" }, before: definition.units[0].acceptance[0].expected,
        after: sha256(Buffer.from("product-two\n")) },
      { target: { kind: "predicate", id: "gate", field: "command" }, before: definition.units[0].acceptance[1].command,
        after: "grep -q '^product-two$' src/a && grep -q '^user-after$' src/user" },
    ];
    // User persists exact next revision bytes; the engine never auto-applies source.
    writeFileSync(sample.definitionFile, JSON.stringify(chosenDefinition(recovered.definition, edits)));
    writeFileSync(sample.planFile, nextPlanBytes(recovered.planBytes));
    save("revised-definition.json", readFileSync(sample.definitionFile));
    save("revised-plan.md", readFileSync(sample.planFile));
    await submit(socket, `/mission revise durable-fixture set ${JSON.stringify(edits)}`);
    await submit(socket, "/mission start durable-fixture");
    const finished = await wait(() => {
      const m = reader.inspectMission(mission.id);
      return m.events.some((e) => e.kind === "mission.completed") ? m : false;
    }, "revision result passes checks, cleanup and independent whole review");
    assert.equal(finished.revision, 2);
    assert.ok(finished.events.filter((event) => event.kind === "attempt.reserved" && event.revision === 2)
      .every((event) => !event.payload.binding.recoveryContinuationId)); // Old observation is not current work.
    const certificate = missionCompletionCertificate(finished, reader);
    assert.ok(certificate);
    const integrated = finished.events.findLast((e) => e.kind === "mission.result.integrated" && e.revision === 2);
    const report = JSON.parse(reader.readArtifact(integrated.payload.reportHash));
    assert.equal(readFileSync(path.join(report.candidateRoot, "src/a"), "utf8"), "product-two\n");
    assert.equal(readFileSync(path.join(report.candidateRoot, "src/user"), "utf8"), "user-after\n");
    assert.equal(readFileSync(path.join(sample.root, "src/a"), "utf8"), "original\n");
    assert.equal(readFileSync(path.join(sample.root, "src/user"), "utf8"), "user-after\n");
    const patch = JSON.parse(reader.readArtifact(report.patchHash));
    assert.equal(patch.format, "mission-conditional-patch-v1");
    const beforeReads = reader.inspectMission(mission.id).latestSeq;
    await session.prompt("/mission inspect"); // Native Pi read, never operator admission.
    await session.prompt(`/mission metrics ${mission.id}`);
    assert.equal(reader.inspectMission(mission.id).latestSeq, beforeReads);
    save("journal-completed.json", finished); save("certificate.json", certificate);
    save("integrated-report.json", report); save("conditional-patch.json", patch);
    save("output-manifest.json", reader.readArtifact(certificate.manifestHash));
    provider.flush(path.join(evidence, "provider.json"));
    await closePi(); reader.close(); reader = undefined;
    const writer = await openMissionStore();
    try {
      const pre = writer.inspectMission(mission.id);
      const independent = { format: "mission-evaluator-v1", evaluatorIdentity: "t7-host-byte-auditor",
        method: "independent host byte checks of result and source after engine completion", independent: true,
        missionId: mission.id, revision: 2, resultManifestHash: certificate.manifestHash, criterionVersion: "t7-private-bytes-v1",
        evidenceRefs: [certificate.manifestHash, integrated.payload.reportHash, report.patchHash] };
      const bytes = Buffer.from(JSON.stringify(independent)), provenanceHash = sha256(bytes);
      writer.appendTransition(mission.id, pre.version, { artifacts: [{ bytes, mediaType: "application/json" }],
        events: [{ revision: pre.revision, kind: "mission.input.recorded", causalId: randomUUID(),
          payload: { source: "independent-fixture-evaluator", provenanceHash, text: independent.method } }] });
      const observation = { schemaVersion: 1, id: randomUUID(), missionId: mission.id, revision: 2,
        resultManifestHash: certificate.manifestHash, criterionVersion: independent.criterionVersion,
        evaluatorIdentity: independent.evaluatorIdentity, method: independent.method, observedAt: new Date().toISOString(),
        windowStart: null, windowEnd: null, evidenceRefs: [...independent.evidenceRefs, provenanceHash],
        verdict: "pass", classification: "outcome", supersedesId: null };
      importMetricObservations(writer, [observation]);
      const inspected = writer.inspectMission(mission.id);
      // The evaluator acquired a new writer epoch after delivery. It may record
      // an outcome, not re-admit completion under that different ownership.
      const completed = inspected.events.findLast((event) => event.kind === "mission.completed");
      assert.deepEqual(JSON.parse(writer.readArtifact(completed.payload.certificateArtifactHash)), certificate);
      const cohort = { format: "mission-metric-cohort-v1", metricVersion: METRIC_VERSION, population: "deterministic-fixture",
        label: "actual-sdk-byte-outcome-only", missions: [captureMetricMission(writer, inspected, process.env.PITAKO_ENGINE_COMMIT ?? "unmeasured-source")] };
      const metrics = calculateMissionMetrics(cohort);
      assert.equal(metrics.counts.passed, 1);
      save("observation.json", [observation]); save("cohort.json", cohort); save("metrics.json", metrics);
      save("journal-observed.json", inspected);
      await writer.exportMission(mission.id, path.join(evidence, "mission-export"));
    } finally { writer.close(); }
    save("operator-inputs.json", calls);
    save("observed.json", { format: "mission-t7-sdk-observed-v1", missionId: mission.id, node: process.version,
      ownerPid: process.pid, contenderPid: probeResult.pid, actualManagedWriteInterrupted: true, effectsQuiescent: true,
      revision: 2, sourceUserBytes: "user-after\n", sourceProductBytes: "original\n", resultProductBytes: "product-two\n",
      reportHash: integrated.payload.reportHash, manifestHash: certificate.manifestHash, patchHash: report.patchHash,
      certificateHash: certificate.certificateHash, sourceApplied: false, publication: false,
      engineAccepted: true, outcome: "host independently checked deterministic bytes only; no expert-quality or live-effectiveness claim",
      resultWorkspace: report.candidateRoot });
    console.log("T7 actual SDK interruption/source-edit/recovery/revision/private delivery passed");
    scenarioDone = true;
    }
  }
} catch (error) {
  if (reader && missionId) {
    save("journal-failed.json", reader.inspectMission(missionId));
    if (evidence) {
      try { await reader.exportMission(missionId, path.join(evidence, "failed-mission-export")); }
      catch (exportError) { save("export-failure.json", { message: String(exportError) }); }
    }
  }
  if (provider && evidence) provider.flush(path.join(evidence, "provider-failed.json"));
  save("failure.json", { message: String(error), calls });
  // Keep the nonzero command result without Jiti retrying a failed module import.
  console.error(error);
  process.exitCode = 1;
} finally {
  releaseProvider();
  reader?.close();
  if (session) await closePi().catch(() => {});
  // Retain exported durable artifacts, not an unmanaged writable temporary result.
  if (sample && scenarioDone) rmSync(sample.base, { recursive: true, force: true });
  else if (sample) save("retained-fixture.json", { base: sample.base, disposition: "retained; unfinished scenario" });
  if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
}
