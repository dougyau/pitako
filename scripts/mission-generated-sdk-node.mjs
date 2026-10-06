// Disposable native Node/installed SDK evidence. All confirmations are fixture authority, NOT user approval.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine } from "../extensions/mission/engine.ts";
import { currentWholeResultApproval, FINALIZATION_PHASES, observeSourceMutation, sourceWitnessCurrent } from "../extensions/mission/finalization.ts";
import { missionCompletionCertificate, assessMissionCompletion } from "../extensions/mission/completion.ts";
import { captureWorkspaceImage } from "../extensions/mission/workspace.ts";
import { reconcileMission } from "../extensions/mission/reconcile.ts";
import { recordOperatorInput } from "../extensions/mission/admission.ts";
import { bindPreparationAuthority, bindPreparationSetup, openPreparationRequest, preparationAuthorityText,
  preparationContext, preparationSetupText, preparedAdmissionText, validatePreparation } from "../extensions/mission/preparation.ts";
import { admitSetupStart, MissionSetup, setupStartText } from "../extensions/mission/setup.ts";
import { registerMissionExtension } from "../extensions/mission/index.ts";
import { createMissionFixture, missionDefinition, openFixtureStore } from "../tests/mission-fixtures.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";

const out = process.argv[2];
assert.ok(out, "supply a fresh evidence directory");
assert.equal(process.versions.bun, undefined, "this observation must run in native Node");
mkdirSync(out);
const sample = createMissionFixture("pitako-generated-node-");
const pinRoot = sample.root;
const agentDir = path.join(sample.base, "agent");
sample.dbPath = path.join(agentDir, "pitako/missions.db");
sample.objectDir = path.join(agentDir, "pitako/missions/objects");
const config = path.join(agentDir, "pitako/config.toml");
mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
const prior = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
let store, engine, missionId;
const save = (name, value) => writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));
try {
  const provider = await installMissionLocalProvider({ agentDir, reasoning: true,
    toolForPrompt: (prompt) => prompt.includes('"format":"mission-finalization-brief-v1"') ? undefined :
      { name: "bash", arguments: { command: 'test "$(cat node_modules/dependency)" = installed && printf "product\\n" > src/a' } },
    responseForPrompt(prompt) {
      if (!prompt.includes('"format":"mission-finalization-brief-v1"')) return "producer response";
      const brief = JSON.parse(prompt.slice(prompt.indexOf('{"format":"mission-finalization-brief-v1"')).split("\n", 1)[0]);
      if (brief.target.phase === "whole-review") {
        const product = brief.resultFiles.find(({ path: file }) => file === "src/a");
        const observed = product?.kind === "file" && Buffer.from(product.bytesBase64, "base64").toString() === "product\n" &&
          brief.originalSource.includes("The complete result contains product after cleanup.") &&
          brief.manifest.phaseReceiptHashes.length === FINALIZATION_PHASES.length - 1;
        return JSON.stringify({ ...brief.expectedResponse, verdict: observed ? "approve" : "inconclusive" });
      }
      return JSON.stringify({ ...brief.expectedResponse, steps: brief.expectedResponse.steps.map((skill) => ({
        skill, changedPaths: [], noOpReason: "Inspected delivered changed scope; preserve checked product behavior",
      })) });
    } });
  rmSync(sample.definitionFile);
  writeFileSync(sample.planFile, `---
id: durable-fixture
revision: 1
status: frozen
execution: expected
---
# Generated result
## Goal
Produce a checked product.
## Ordered work units
### T1 — Product
Objective: write the product, not a PASS report.
Scope: src/a
Acceptance:
- The product contains product.
Expected evidence: a contained command reads the real output.
## Final verification and success
- The complete result contains product after cleanup.
`);
  const originalPin = readFileSync(sample.planFile);
  sample.root = path.join(sample.base, "execution");
  execFileSync("git", ["worktree", "add", "-q", "-b", "execution", sample.root], { cwd: pinRoot });
  // Explicit exception: this untracked local plan participates in general source freshness.
  writeFileSync(path.join(sample.root, ".gitignore"), ".pitako/*\n!.pitako/plans/\n.pitako/plans/*\n!.pitako/plans/local-witness.md\nnode_modules/\n");
  mkdirSync(path.join(sample.root, ".pitako/plans"), { recursive: true });
  const localPlan = path.join(sample.root, ".pitako/plans/local-witness.md");
  writeFileSync(localPlan, "untracked local source witness\n");
  mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src/a"), "original\n");
  mkdirSync(path.join(sample.root, "scripts")); mkdirSync(path.join(sample.root, "node_modules"));
  writeFileSync(path.join(sample.root, "scripts/setup.sh"), "printf installed > node_modules/dependency\n");
  execFileSync("git", ["add", ".gitignore", "src", "scripts"], { cwd: sample.root });
  assert.equal(spawnGit("check-ignore", localPlan), 1);
  writeFileSync(config, ["developer", "reviewer"].map((role) => `[model_policies.${role}]
primary = { model = "${provider.provider}/${provider.model}", reasoning = "high", fast = false }
fallbacks = [{ model = "${provider.provider}/${provider.model}", reasoning = "medium", fast = true }]
`).join("\n"));
  const request = openPreparationRequest("durable-fixture", sample.root, "principal", { userConfigPath: config });
  const confirm = (text) => recordOperatorInput("native-confirmation", "principal", text);
  const allocation = { effectProfile: "execution-root-local-v1", writableDirectories: ["node_modules"],
    activeTimeMs: 10000, artifactBytes: 2000000 };
  bindPreparationSetup(request, allocation, confirm(preparationSetupText(request, allocation)));
  const context = preparationContext(request), definition = missionDefinition();
  definition.schemaVersion = 2; definition.finalization.contractVersion = 1;
  definition.authority.allowedPaths = ["src/**"]; definition.authority.operations = ["write", "bash"];
  definition.budget = { roleLaunches: 6, providerRequests: 10, tokens: 100000, activeTimeMs: 600000, artifactBytes: 67108864 };
  for (const role of ["developer", "reviewer"]) {
    const policy = context.roles[role];
    definition.authority.rolePolicies[role] = { hash: policy.hash, provider: provider.provider, model: provider.model,
      fallbacks: policy.fallbacks.map(({ model }) => model), primaryTarget: policy.primary, fallbackTargets: policy.fallbacks };
  }
  const unit = context.inventory.units[0];
  definition.units = [{ id: unit.engineId, role: "developer", kind: "implementation", dependencies: [], inputs: ["."],
    outputs: ["src/a"], risk: "low", retryLimit: 0, originalIntent: { sourceId: unit.id,
      objective: context.inventory.context.filter(({ role }) => role === "objective").map(({ text }) => text).join(""),
      workBrief: unit.text, criteria: context.inventory.criteria.filter(({ owner }) => owner === unit.engineId)
        .map(({ id, text }) => ({ sourceId: id, text, predicateIds: ["product-present"] })) },
    acceptance: [
      { id: "product-present", kind: "command_exit", target: "result", command: "grep -q product src/a", expected: "0", timeoutMs: 3000 },
      { id: "nonempty", kind: "command_exit", target: "result", command: "test -s src/a", expected: "0", timeoutMs: 3000 },
      { id: "final-product", kind: "command_exit", target: "result", command: 'test "$(cat src/a)" = product', expected: "0", timeoutMs: 3000 },
    ] }];
  definition.finalization.requiredPredicates = ["product-present", "nonempty", "final-product"];
  definition.finalization.selections = { ordinary: ["product-present", "nonempty"], integrated: ["nonempty"],
    affected: ["product-present"], final: [...definition.finalization.requiredPredicates] };
  const mappings = context.inventory.criteria.map(({ id, owner }) => ({ sourceId: id,
    predicateIds: owner === "mission" ? ["final-product"] : ["product-present"],
    explanation: "Actual contained command reads mapped output." }));
  const values = { authority: definition.authority, budget: definition.budget };
  bindPreparationAuthority(request, values, confirm(preparationAuthorityText(request, values)));
  const ready = validatePreparation({ request, proposal: { definition, mappings } });
  assert.equal(ready.state, "ready", JSON.stringify(ready.issues));
  save("preparation.json", { fixtureAuthority: true, userApproval: false, request, ready });
  store = await openFixtureStore(sample);
  const text = preparedAdmissionText(ready.prepared), admission = confirm(text);
  const mission = store.createMission({ repositoryRoot: sample.root, planId: "durable-fixture", prepared: ready.prepared,
    commandId: admission.id, admissionReceiptId: admission.id, operatorText: text, operatorReceipt: admission });
  missionId = mission.id;
  const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
    load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
  const options = { store, missionId, sessionsDirectory: path.join(sample.base, "sessions"),
    managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
    runRole: async (input, durable) => {
      const policy = definition.authority.rolePolicies[input.unit.role];
      assert.deepEqual(durable.rolePolicy, { primary: policy.primaryTarget, fallbacks: policy.fallbackTargets });
      assert.equal(createHash("sha256").update(JSON.stringify(input.brief)).digest("hex"), input.binding.briefHash);
      const reserved = store.inspectMission(missionId).events.find(({ kind, attemptId }) =>
        kind === "attempt.reserved" && attemptId === input.binding.attemptId);
      assert.equal(reserved.payload.binding.briefHash, input.binding.briefHash);
      if (!input.binding.finalization)
        assert.equal(store.readArtifact(reserved.payload.binding.briefArtifactHash).toString(), input.brief);
      if (input.binding.finalization) {
        const brief = JSON.parse(input.brief);
        assert.equal(input.brief, JSON.stringify(brief));
        assert.equal(brief.originalSource, ready.prepared.originalSource);
        assert.deepEqual(brief.target, input.binding.finalization);
      } else assert.ok(input.brief.includes(input.unit.originalIntent.workBrief));
      if (input.binding.finalization?.phase === "whole-review") {
        assert.equal(durable.readOnly, true);
        assert.equal((await durable.effects.invoke("write", { path: "src/a", content: "not authorized" })).status, "denied");
      }
      const result = await runner(input, durable);
      assert.ok(result.requests.length);
      for (const row of result.requests) { assert.equal(row.reasoning, "high"); assert.equal(row.fast_requested, false); }
      assert.ok(provider.trace.find(({ sessionId }) => sessionId === input.binding.attemptId).prompt.includes(input.brief));
      save(`sdk-${input.binding.attemptId}.json`, { binding: input.binding, brief: input.brief, policy: durable.rolePolicy, result });
      return result;
    } };
  engine = new MissionEngine(options);
  const setupAdmission = admitSetupStart(store, missionId, "principal", confirm(setupStartText(store, missionId, "principal")), () => {});
  const append = store.appendTransition.bind(store);
  let paused;
  store.appendTransition = (id, version, transition) => {
    const result = append(id, version, transition);
    if (transition.events.some(({ kind }) => kind === "mission.setup.receipt")) paused = engine.control("pause");
    return result;
  };
  engine.start(undefined, setupAdmission); await engine.waitForIdle(); await paused;
  const revisionOne = store.inspectMission(missionId);
  assert.equal(revisionOne.state, "paused");
  assert.equal(revisionOne.events.some(({ kind }) => kind === "attempt.reserved"), false);
  assert.equal(new MissionSetup(store, missionId).observe().state, "ready");
  const firstRecovery = await reconcileMission({ store, missionId, sourceRoot: sample.root, planFile: sample.planFile });
  await engine.retireForShutdown("quit"); engine = undefined;
  const handlers = new Map();
  let command;
  registerMissionExtension({ on: (name, handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    registerCommand: (_name, value) => { command = value.handler; }, registerTool() {} });
  const notices = [], confirmations = [];
  const ctx = { mode: "tui", cwd: sample.root, hasUI: true,
    sessionManager: { getSessionId: () => "fixture-native-principal" },
    ui: { notify: (text) => notices.push(text), confirm: async (_title, text) => { confirmations.push(text); return true; } } };
  await command(`revise durable-fixture Change predicate product-present command to "grep -q '^product$' src/a"`, ctx);
  assert.ok(notices.at(-1).includes("Revision 2"), JSON.stringify(notices));
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
  store = await openFixtureStore(sample);
  const admitted = store.inspectMission(missionId);
  assert.equal(admitted.revision, 2); assert.deepEqual(admitted.snapshot.sourceBinding, revisionOne.snapshot.sourceBinding);
  assert.equal(admitted.prepared.originalSource, revisionOne.prepared.originalSource);
  assert.notEqual(admitted.snapshot.preparedHash, revisionOne.snapshot.preparedHash);
  assert.notEqual(admitted.snapshot.definitionHash, revisionOne.snapshot.definitionHash);
  assert.ok(readFileSync(sample.planFile).equals(originalPin));
  assert.equal(new MissionSetup(store, missionId).observe().state, "blocked");
  assert.equal(new MissionSetup(store, missionId).reconcile().state, "ready");
  const recovery = await reconcileMission({ store, missionId, sourceRoot: sample.root, planFile: sample.planFile });
  assert.equal(recovery.status, "resumed"); assert.deepEqual(recovery.blockers, []);
  assert.deepEqual(recovery.disposition.causes, []);
  assert.equal(recovery.revision, 2); assert.equal(recovery.plan.inputIdentity.pinRevision, 1);
  assert.equal(recovery.plan.inputIdentity.preparedHash, admitted.snapshot.preparedHash);
  assert.notEqual(recovery.plan.inputIdentityHash, firstRecovery.plan.inputIdentityHash);
  save("revision-recovery.json", { fixtureUI: true, confirmations, notices, revisionOne, admitted, firstRecovery, recovery });
  writeFileSync(path.join(sample.root, ".pitako/plans/durable-fixture.md"), "ignored competing plan, not the pin");
  engine = new MissionEngine({ ...options, store });
  await engine.control("resume"); await engine.waitForIdle();
  let inspection = store.inspectMission(missionId);
  provider.flush(path.join(out, "provider.json"));
  save("journal-acceptance.json", inspection);
  const approval = currentWholeResultApproval(inspection, store, sample.root);
  assert.equal(approval?.verdict, "approve", JSON.stringify(assessMissionCompletion(inspection, store)));
  const certificate = missionCompletionCertificate(inspection, store);
  assert.ok(certificate, JSON.stringify(assessMissionCompletion(inspection, store)));
  assert.deepEqual(inspection.events.filter(({ kind }) => kind === "mission.finalization.phase.receipted")
    .map(({ payload }) => payload.target.phase), FINALIZATION_PHASES);
  const ordinary = inspection.events.filter(({ kind }) => kind === "evidence.recorded");
  assert.deepEqual(ordinary.map(({ payload }) => payload.predicateId), definition.finalization.selections.ordinary);
  const phases = Object.entries({ "integrated-checks": definition.finalization.selections.integrated,
    "affected-checks": definition.finalization.selections.affected, "final-gates": definition.finalization.selections.final })
    .map(([phase, ids]) => {
      const row = inspection.events.find(({ kind, payload }) =>
        kind === "mission.finalization.phase.receipted" && payload.target.phase === phase);
      const receipt = JSON.parse(store.readArtifact(row.payload.receiptHash).toString());
      const predicates = receipt.evidenceHashes.map((hash) => {
        const bytes = store.readArtifact(hash).toString();
        return bytes.startsWith("{") ? JSON.parse(bytes) : undefined;
      }).filter((value) => value?.format === "mission-predicate-observation-v1");
      assert.deepEqual(predicates.map(({ predicate }) => predicate.id), ids);
      for (const observation of predicates) {
        assert.equal(observation.verdict, "pass");
        assert.equal(observation.receipt.status, "completed"); assert.equal(observation.receipt.exitCode, 0);
        assert.equal(observation.subject.imageHash, receipt.target.inputArtifactHash);
        assert.equal(inspection.events.find(({ kind, effectId }) =>
          kind === "effect.receipt" && effectId === observation.receipt.effectId).attemptId, row.attemptId);
      }
      return { phase, receipt, predicates };
    });
  save("selected-phase-observations.json", { ordinary, phases });
  assert.equal(inspection.events.filter(({ kind }) => kind === "mission.setup.intent").length, 1);
  assert.equal(readFileSync(path.join(sample.root, "src/a"), "utf8"), "original\n");
  assert.equal(existsSync(path.join(sample.root, ".pitako/plans/durable-fixture.mission.json")), false);
  save("acceptance.json", { runtime: process.version, execPath: process.execPath, versions: process.versions,
    fixtureAuthority: true, userApproval: false, sample, approval, certificate, admittedRevision: inspection.revision,
    physicalPin: inspection.snapshot.sourceBinding, inputIdentity: recovery.plan.inputIdentity });
  await store.exportMission(missionId, path.join(out, "export-acceptance"));
  // Exported roots do not include every transitive predicate artifact. Preserve actual bytes before disposal.
  cpSync(sample.objectDir, path.join(out, "objects-complete"), { recursive: true });
  // Admission baseline is CURRENT above, in the SAME runtime. Non-ignored untracked plan is a distinct freshness input.
  const imageBefore = captureWorkspaceImage(sample.root);
  const witnessBefore = JSON.parse(store.readArtifact(approval.sourceWitnessHash).toString());
  assert.equal(sourceWitnessCurrent(store, approval.sourceWitnessHash, sample.root), true);
  const localBytes = readFileSync(localPlan);
  writeFileSync(localPlan, "changed untracked local plan\n");
  const imageChanged = captureWorkspaceImage(sample.root), witnessChanged = observeSourceMutation(sample.root,
    imageChanged.manifest, witnessBefore.planId, witnessBefore.sourceBinding);
  assert.notEqual(imageChanged.manifest.hash, imageBefore.manifest.hash);
  assert.equal(sourceWitnessCurrent(store, approval.sourceWitnessHash, sample.root), false);
  assert.equal(currentWholeResultApproval(inspection, store, sample.root), undefined);
  assert.equal(missionCompletionCertificate(inspection, store), undefined);
  writeFileSync(localPlan, localBytes);
  const imageRestored = captureWorkspaceImage(sample.root), witnessRestored = observeSourceMutation(sample.root,
    imageRestored.manifest, witnessBefore.planId, witnessBefore.sourceBinding);
  assert.equal(imageRestored.manifest.hash, imageBefore.manifest.hash);
  assert.equal(sourceWitnessCurrent(store, approval.sourceWitnessHash, sample.root), false);
  assert.equal(currentWholeResultApproval(inspection, store, sample.root), undefined);
  assert.equal(missionCompletionCertificate(inspection, store), undefined);
  save("untracked-local-plan-drift.json", { localPlan, imageBefore, imageChanged, imageRestored,
    witnessBefore, witnessChanged, witnessRestored, approvalLost: true, certificateLost: true, restoredStillRejected: true });
  console.log(JSON.stringify({ runtime: process.version, revision: inspection.revision, pinRevision: recovery.plan.inputIdentity.pinRevision,
    certificateHash: certificate.certificateHash, restoredStillRejected: true }));
} finally {
  if (store && missionId) save("journal-final.json", store.inspectMission(missionId));
  await engine?.retireForShutdown("quit"); store?.close();
  rmSync(sample.base, { recursive: true, force: true });
  if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
}

function spawnGit(...args) {
  try { execFileSync("git", args, { cwd: sample.root, stdio: "pipe" }); return 0; }
  catch (error) { return error.status; }
}
