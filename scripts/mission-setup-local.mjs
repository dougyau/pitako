// Disposable, credential-free setup evidence. Fixture confirmations are NOT user approval.
// Run with the chosen host runtime; this is not native full-terminal T2 acceptance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMissionFixture, missionDefinition, openFixtureStore } from "../tests/mission-fixtures.ts";
import { recordOperatorInput } from "../extensions/mission/admission.ts";
import { bindPreparationAuthority, bindPreparationSetup, openPreparationRequest, preparationAuthorityText,
  preparationContext, preparationSetupText, preparedAdmissionText, validatePreparation } from "../extensions/mission/preparation.ts";
import { admitSetupStart, MissionSetup, setupStartText } from "../extensions/mission/setup.ts";
import { createMissionWorkspace, preflightContainment, spawnContained } from "../extensions/mission/workspace.ts";

const out = process.argv[2];
const interrupt = process.argv[3] === "--interrupt";
if (!out) throw new Error("supply a new evidence directory");
mkdirSync(out);
const fixture = createMissionFixture("pitako-native-setup-");
let store;
try {
  rmSync(fixture.definitionFile);
  writeFileSync(fixture.planFile, `---
id: durable-fixture
revision: 1
status: frozen
execution: expected
---
# Setup fixture
## Goal
Read installed local dependency.
## Ordered work units
### T1 — Product
Objective: read dependency without reinstalling.
Scope: src/a
Acceptance:
- Installed dependency is readable.
Expected evidence: contained command reads actual installed bytes.
## Final verification and success
- Original obligations remain.
`);
  const root = path.join(fixture.base, "execution");
  execFileSync("git", ["worktree", "add", "-q", "-b", "execution", root], { cwd: fixture.root });
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "node_modules"));
  const runtime = process.versions.bun ? "bun" : "node";
  writeFileSync(path.join(root, "scripts/setup.sh"),
    `${runtime} -e 'require("node:fs").writeFileSync("node_modules/dependency", "installed")'\n` +
    (interrupt ? "setsid /bin/bash -c 'while :; do sleep 1; done' &\nwait\n" : ""));
  const config = path.join(fixture.base, "fixture.toml");
  writeFileSync(config, ['developer', 'reviewer'].map((role) =>
    `[model_policies.${role}]\nprimary = { model = "test/${role}", reasoning = "high", fast = false }\n`).join(""));
  const request = openPreparationRequest("durable-fixture", root, "fixture-principal", { userConfigPath: config });
  const context = preparationContext(request), definition = missionDefinition();
  definition.schemaVersion = 2;
  definition.budget = { roleLaunches: 5, providerRequests: 5, tokens: 100000, activeTimeMs: 600000, artifactBytes: 64000000 };
  definition.authority = { allowedPaths: ["src/a"], operations: ["read", "write", "bash"], externalEffects: [],
    rolePolicies: {}, allowTechnicalAmendments: false, resumeAfterClose: false };
  for (const role of ["developer", "reviewer"]) {
    const policy = context.roles[role];
    definition.authority.rolePolicies[role] = { hash: policy.hash, provider: "test", model: role,
      fallbacks: [], primaryTarget: policy.primary, fallbackTargets: [] };
  }
  const mappings = context.inventory.criteria.map(({ id }) => ({
    sourceId: id, predicateIds: ["dependency-readable"], explanation: "Contained consumer reads actual installed dependency." }));
  const unit = context.inventory.units[0];
  definition.units = [{ id: unit.engineId, role: "developer", kind: "implementation", dependencies: [], inputs: ["."],
    outputs: ["src/a"], risk: "low", retryLimit: 0, originalIntent: { sourceId: unit.id,
      objective: context.inventory.context.filter(({ role }) => role === "objective").map(({ text }) => text).join(""),
      workBrief: unit.text, criteria: context.inventory.criteria.filter(({ owner }) => owner !== "mission")
        .map(({ id, text }) => ({ sourceId: id, text, predicateIds: ["dependency-readable"] })) },
    acceptance: [{ id: "dependency-readable", kind: "command_exit", target: "dependency",
      command: 'test "$(cat node_modules/dependency)" = installed' }] }];
  definition.finalization = { contractVersion: 1, independentReview: true, requiredPredicates: ["dependency-readable"],
    selections: { ordinary: ["dependency-readable"], integrated: ["dependency-readable"],
      affected: ["dependency-readable"], final: ["dependency-readable"] } };
  const confirm = (text) => recordOperatorInput("native-confirmation", "fixture-principal", text);
  const values = { authority: definition.authority, budget: definition.budget };
  bindPreparationAuthority(request, values, confirm(preparationAuthorityText(request, values)));
  const allocation = { effectProfile: "execution-root-local-v1", writableDirectories: ["node_modules"],
    activeTimeMs: 15000, artifactBytes: 1000000 };
  bindPreparationSetup(request, allocation, confirm(preparationSetupText(request, allocation)));
  const ready = validatePreparation({ request, proposal: { definition, mappings } });
  assert.equal(ready.state, "ready", JSON.stringify(ready.issues));
  store = await openFixtureStore(fixture);
  const text = preparedAdmissionText(ready.prepared), approval = confirm(text);
  const mission = store.createMission({ repositoryRoot: root, planId: "durable-fixture", prepared: ready.prepared,
    commandId: approval.id, admissionReceiptId: approval.id, operatorText: text, operatorReceipt: approval });
  store.appendTransition(mission.id, mission.version, { events: [{ revision: 1, kind: "mission.activated",
    causalId: approval.id, payload: {} }] });
  const producer = new MissionSetup(store, mission.id);
  assert.equal(producer.observe().state, "blocked");
  const admission = admitSetupStart(store, mission.id, "fixture-principal",
    confirm(setupStartText(store, mission.id, "fixture-principal")), () => {});
  const setupJob = producer.ensure(admission, () => true);
  if (interrupt) {
    for (let turn = 0; turn < 200; turn++) {
      try {
        if (readFileSync(path.join(root, "node_modules/dependency"), "utf8") === "installed") break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(readFileSync(path.join(root, "node_modules/dependency"), "utf8"), "installed");
    const invoking = store.inspectMission(mission.id).events.find(({ kind, payload }) =>
      kind === "mission.setup.invoking" && payload.released === true);
    assert.ok(invoking?.payload.process);
    writeFileSync(path.join(out, "interrupted.json"), JSON.stringify({ fixture, missionId: mission.id,
      process: invoking.payload.process, fixturePermission: true, userApproval: false }));
    // Deliberately skip stop, receipt, owner release and fixture deletion.
    process.exit(74);
  }
  assert.equal((await setupJob).state, "ready");
  assert.equal((await producer.ensure(admission, () => true)).reused, true);
  const workspace = createMissionWorkspace({ missionId: mission.id, attemptId: approval.id,
    sourceRoot: root, storeRoot: store.storageRoot, candidateParent: path.join(fixture.base, "candidates") });
  await preflightContainment(workspace);
  const child = spawnContained(workspace, "bash", ["-c",
    'test "$(cat node_modules/dependency)" = installed && ! (printf bad > node_modules/dependency)'], { writablePaths: [] });
  child.stdin.end(); child.stdout.resume(); child.stderr.resume();
  assert.equal(await new Promise((resolve) => child.once("close", resolve)), 0);
  const inspection = store.inspectMission(mission.id);
  assert.equal(inspection.events.filter(({ kind }) => kind === "mission.setup.intent").length, 1);
  const receipt = inspection.events.find(({ kind }) => kind === "mission.setup.receipt");
  writeFileSync(path.join(out, "receipt.json"), store.readArtifact(receipt.payload.receiptHash));
  writeFileSync(path.join(out, "observation.json"), JSON.stringify({ runtime: process.version, bun: process.versions.bun,
    root, sourcePin: ready.prepared.binding, fixturePermission: true, userApproval: false, disposed: producer.quiescent,
    dependency: readFileSync(path.join(root, "node_modules/dependency"), "utf8"),
    containedConsumerExit: 0, reusedWithoutSecondProcess: true, fullTerminalAcceptance: false }, null, 2));
  await store.exportMission(mission.id, path.join(out, "export"));
  console.log(JSON.stringify({ runtime: process.version, state: "ready", disposed: producer.quiescent, output: out }));
} finally {
  store?.close();
  rmSync(fixture.base, { recursive: true, force: true });
}
