import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { admitMissionChange, nextPlanBytes, recordOperatorChoice, recordOperatorInput } from "../extensions/mission/admission.ts";
import { missionPolicyTargets } from "../extensions/mission/engine.ts";
import { missionInputIdentity } from "../extensions/mission/inputs.ts";
import { sha256, type MissionDefinition } from "../extensions/mission/model.ts";
import {
  assertPreparedAdmission, bindPreparationAuthority, openPreparationRequest, preparationAuthorityText,
  preparationContext, preparedAdmissionText, validatePreparation, type EvidenceMapping,
  bindPreparationSetup, preparationSetupText,
} from "../extensions/mission/preparation.ts";
import { admitSetupStart, assertSetupRequirements, MissionSetup, setupRequiredBy, setupStartText, type SetupAllocation } from "../extensions/mission/setup.ts";
import { createMissionWorkspace, preflightContainment, processesInNamespace, spawnContained } from "../extensions/mission/workspace.ts";
import { createMissionFixture, missionDefinition, openFixtureStore } from "./mission-fixtures.ts";

const source = `---
id: durable-fixture
revision: 1
status: frozen
execution: expected
---
# Ordinary fix
## Goal
Fix input, preserve independent obligations.
## Ordered work units
### T1 — Implement
Objective: fix input.
Scope: input.mjs
Acceptance:
- Valid input works.
- Invalid input rejects.
  - Empty input rejects.
Expected evidence: native Node checks.
### T2 — Check
Objective: verify the result.
Scope: check.mjs
Acceptance criteria:
- Integration works.
Expected evidence: native Node.
## Final verification and success
- Complete final gates and independent review.
`;

test("setup input provenance is conservative and preserves predicate and transitive consumer closure", () => {
  const sample = preparedFixture("exit 23\n");
  try {
    const prepared = validatePreparation({ request: sample.request, proposal: sample.proposal });
    // Host setup choice is separate; this fixture has not granted it yet.
    expect(prepared.state).toBe("needs-input");
    const values: SetupAllocation = { effectProfile: "execution-root-local-v1", writableDirectories: ["node_modules"],
      activeTimeMs: 1000, artifactBytes: 16384 };
    bindPreparationSetup(sample.request, values,
      recordOperatorInput("native-confirmation", "principal", preparationSetupText(sample.request, values))!);
    const admitted = validatePreparation({ request: sample.request, proposal: sample.proposal });
    expect(admitted.state).toBe("ready");
    if (admitted.state !== "ready") return;
    const setup = structuredClone(admitted.prepared.setup!);
    const definition = structuredClone(admitted.prepared.definition);
    for (const unit of definition.units) {
      unit.inputs = ["scripts/setup.sh"];
      for (const predicate of unit.acceptance) predicate.inputPaths = ["scripts/setup.sh", ...unit.outputs];
    }
    expect(setupRequiredBy(setup.identity, definition)).toEqual({ unitIds: [], predicateIds: [] });
    definition.units[0]!.acceptance[0]!.inputPaths = ["node_modules/dependency"];
    setup.requiredBy = setupRequiredBy(setup.identity, definition);
    expect(setup.requiredBy.unitIds).toEqual(definition.units.map(({ id }) => id).sort());
    expect(setup.requiredBy.predicateIds).toEqual(definition.units.flatMap(({ acceptance }) => acceptance.map(({ id }) => id)).sort());
    expect(() => assertSetupRequirements(setup, definition)).not.toThrow();
    setup.requiredBy.unitIds.pop();
    expect(() => assertSetupRequirements(setup, definition)).toThrow("incomplete");
    for (const unknown of [".", "missing-input", "../outside", "scripts/**"]) {
      definition.units[0]!.inputs = [unknown];
      expect(setupRequiredBy(setup.identity, definition).unitIds).toEqual(definition.units.map(({ id }) => id).sort());
    }
  } finally { rmSync(sample.fixture.base, { recursive: true, force: true }); }
});

function preparedFixture(setupScript?: string) {
  const fixture = createMissionFixture("pitako-prepared-");
  rmSync(fixture.definitionFile);
  writeFileSync(fixture.planFile, source);
  const executionRoot = path.join(fixture.base, "execution");
  execFileSync("git", ["worktree", "add", "-q", "-b", "execution", executionRoot], { cwd: fixture.root });
  if (setupScript !== undefined) {
    mkdirSync(path.join(executionRoot, "scripts"), { recursive: true });
    mkdirSync(path.join(executionRoot, "node_modules"));
    writeFileSync(path.join(executionRoot, "scripts/setup.sh"), setupScript);
  }
  const configFile = path.join(fixture.base, "fixture.toml");
  writeFileSync(configFile, '[model_policies.developer]\nprimary = { model = "test/child", reasoning = "high", fast = false }\n[model_policies.reviewer]\nprimary = { model = "test/review", reasoning = "high", fast = false }\n');
  const request = openPreparationRequest("durable-fixture", executionRoot, "principal", { userConfigPath: configFile });
  const context = preparationContext(request);
  const definition = missionDefinition();
  definition.schemaVersion = 2;
  const rolePolicies: MissionDefinition["authority"]["rolePolicies"] = {};
  for (const role of ["developer", "reviewer"]) {
    const policy = context.roles[role]!;
    const primary = policy.primary!;
    const split = primary.model.indexOf("/");
    rolePolicies[role] = { hash: policy.hash, provider: primary.model.slice(0, split), model: primary.model.slice(split + 1),
      fallbacks: policy.fallbacks.map(({ model }) => model), primaryTarget: primary, fallbackTargets: policy.fallbacks };
  }
  definition.authority = { allowedPaths: ["input.mjs", "check.mjs"], operations: ["read", "write", "bash"],
    externalEffects: [], rolePolicies, allowTechnicalAmendments: true, resumeAfterClose: false };
  definition.budget = { roleLaunches: 6, providerRequests: 10, tokens: 100000, activeTimeMs: 600000, artifactBytes: 64 * 1024 * 1024 };
  const mappings: EvidenceMapping[] = context.inventory.criteria.map((criterion, index) => ({
    sourceId: criterion.id, predicateIds: [`proof-${index}`], explanation: "Run the discriminating local Node check." }));
  definition.units = context.inventory.units.map((unit) => ({
    id: unit.engineId, dependencies: context.inventory.dependencies.filter(({ unitId }) => unitId === unit.engineId).map(({ requires }) => requires),
    kind: "implementation", role: "developer", inputs: ["input.mjs", "check.mjs"], outputs: ["input.mjs"], risk: "low", retryLimit: 0,
    originalIntent: { sourceId: unit.id, objective: context.inventory.context.filter(({ owner, role }) =>
      owner === unit.engineId && role === "objective").map(({ text }) => text).join(""), workBrief: unit.text,
    criteria: context.inventory.criteria.filter(({ owner }) => owner === unit.engineId).map((criterion) => ({
      sourceId: criterion.id, text: criterion.text, predicateIds: mappings.find(({ sourceId }) => sourceId === criterion.id)!.predicateIds })) },
    acceptance: context.inventory.criteria.filter(({ owner }) => owner === unit.engineId ||
      unit.ordinal === 0 && owner === "mission").map((criterion) => ({
      id: mappings.find(({ sourceId }) => sourceId === criterion.id)!.predicateIds[0]!, kind: "command_exit",
      target: "Node discriminating check", command: "node check.mjs" })),
  }));
  const ordinary = mappings.filter((mapping) => context.inventory.criteria.find(({ id }) => id === mapping.sourceId)!.owner !== "mission")
    .flatMap(({ predicateIds }) => predicateIds);
  const final = mappings.flatMap(({ predicateIds }) => predicateIds);
  definition.finalization = { contractVersion: 1, independentReview: true, requiredPredicates: final,
    selections: { ordinary, integrated: [ordinary[0]!], affected: [ordinary[1]!], final } };
  const values = { authority: definition.authority, budget: definition.budget };
  const text = preparationAuthorityText(request, values);
  bindPreparationAuthority(request, values, recordOperatorInput("native-confirmation", "principal", text)!);
  return { fixture, executionRoot, request, context, proposal: { definition, mappings } };
}

const allocation: SetupAllocation = { effectProfile: "execution-root-local-v1", writableDirectories: ["node_modules"],
  activeTimeMs: 10000, artifactBytes: 1024 * 1024 };
function approveSetup(request: Parameters<typeof preparationSetupText>[0]) {
  const text = preparationSetupText(request, allocation);
  bindPreparationSetup(request, allocation, recordOperatorInput("native-confirmation", "principal", text)!);
}
async function setupMission(script: string | undefined) {
  const sample = preparedFixture(script);
  if (script === undefined) {
    mkdirSync(path.join(sample.executionRoot, "node_modules"));
    writeFileSync(path.join(sample.executionRoot, "node_modules/dependency"), "preexisting");
  }
  approveSetup(sample.request);
  const prepared = validatePreparation({ request: sample.request, proposal: sample.proposal });
  if (prepared.state !== "ready") throw new Error(JSON.stringify(prepared.issues));
  const store = await openFixtureStore(sample.fixture);
  const text = preparedAdmissionText(prepared.prepared);
  const receipt = recordOperatorInput("native-confirmation", "principal", text)!;
  const mission = store.createMission({ repositoryRoot: sample.executionRoot, planId: "durable-fixture", prepared: prepared.prepared,
    commandId: receipt.id, admissionReceiptId: receipt.id, operatorText: text, operatorReceipt: receipt });
  const inspection = store.inspectMission(mission.id);
  store.appendTransition(mission.id, inspection.version, { events: [{ revision: inspection.revision,
    kind: "mission.activated", causalId: receipt.id, payload: {} }] });
  const producer = new MissionSetup(store, mission.id);
  const start = (recheck: () => void = () => {}) => {
    const text = setupStartText(store, mission.id, "principal");
    return admitSetupStart(store, mission.id, "principal", recordOperatorInput("native-confirmation", "principal", text)!, recheck);
  };
  return { ...sample, store, mission, producer, start };
}

test("setup authority is separately host issued; no proposal/bash/replayed/alias authority", () => {
  const sample = preparedFixture("printf installed > node_modules/dependency\n");
  try {
    const absent = validatePreparation({ request: sample.request, proposal: sample.proposal });
    expect(absent.state).toBe("needs-input");
    if (absent.state === "needs-input") expect(absent.issues.some(({ kind }) => kind === "authority")).toBe(true);
    const text = preparationSetupText(sample.request, allocation);
    const receipt = recordOperatorInput("native-confirmation", "wrong-session", text)!;
    expect(() => bindPreparationSetup(sample.request, allocation, receipt)).toThrow();
    expect(() => preparationSetupText(sample.request, { ...allocation, writableDirectories: ["."] })).toThrow();
    expect(() => preparationSetupText(sample.request, { ...allocation, writableDirectories: ["node_modules", "node_modules/nested"] })).toThrow();
    approveSetup(sample.request);
    expect(validatePreparation({ request: sample.request, proposal: sample.proposal }).state).toBe("ready");
    expect(existsSync(path.join(sample.executionRoot, "node_modules/dependency"))).toBe(false);
    linkSync(path.join(sample.executionRoot, "scripts/setup.sh"), path.join(sample.executionRoot, "node_modules/alias"));
    expect(validatePreparation({ request: sample.request, proposal: sample.proposal }).state).toBe("needs-input");
  } finally { rmSync(sample.fixture.base, { recursive: true, force: true }); }
});

test("real setup producer installs only on exact execution; receipt reuse compares AFTER output and contained consumer reads it", async () => {
  const sample = await setupMission("printf installed > node_modules/dependency\n");
  try {
    expect(sample.producer.observe().state).toBe("blocked");
    expect(existsSync(path.join(sample.executionRoot, "node_modules/dependency"))).toBe(false);
    await expect(sample.producer.ensure({ id: "fake" }, () => true)).rejects.toThrow(/live admission/);
    const admission = sample.start();
    const result = await sample.producer.ensure(admission, () => true);
    expect(result.state).toBe("ready");
    expect(readFileSync(path.join(sample.executionRoot, "node_modules/dependency"), "utf8")).toBe("installed");
    expect(sample.producer.quiescent).toBe(true);
    const events = sample.store.inspectMission(sample.mission.id).events;
    const receiptEvent = events.find(({ kind }) => kind === "mission.setup.receipt")!;
    const receipt = JSON.parse(sample.store.readArtifact(String(receiptEvent.payload.receiptHash)).toString());
    expect(receipt).toMatchObject({ status: "completed", disposed: true, released: true, cwd: sample.executionRoot });
    expect(receipt.before.filter(({ kind }: { kind: string }) => kind === "file")).toHaveLength(0);
    expect(receipt.after.find(({ path }: { path: string }) => path === "node_modules/dependency").hash)
      .toBe(sha256(Buffer.from("installed")));
    expect(processesInNamespace(receipt.process.namespace)).toHaveLength(0);
    expect(await sample.producer.ensure(admission, () => true)).toMatchObject({ state: "ready", reused: true });
    expect(sample.store.inspectMission(sample.mission.id).events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
    const workspace = createMissionWorkspace({ missionId: sample.mission.id, attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceRoot: sample.executionRoot, storeRoot: sample.store.storageRoot, candidateParent: path.join(sample.fixture.base, "candidates") });
    await preflightContainment(workspace);
    const child = spawnContained(workspace, "bash", ["-c", "test \"$(cat node_modules/dependency)\" = installed && ! (printf bad > node_modules/dependency)"], { writablePaths: [] });
    child.stdin!.end();
    child.stdout!.resume(); child.stderr!.resume();
    const code = await new Promise((resolve) => child.once("close", resolve));
    expect(code).toBe(0);
    writeFileSync(path.join(sample.executionRoot, "node_modules/dependency"), "changed");
    expect(sample.producer.observe().state).toBe("blocked");
    writeFileSync(path.join(sample.executionRoot, "node_modules/dependency"), "installed");
    expect(sample.producer.observe().state).toBe("ready");
    for (const filename of ["bun.lock", "GATES.md"]) {
      writeFileSync(path.join(sample.executionRoot, filename), "changed recipe");
      expect(sample.producer.observe().state).toBe("blocked");
      rmSync(path.join(sample.executionRoot, filename));
      expect(sample.producer.observe().state).toBe("ready");
    }
    writeFileSync(path.join(sample.executionRoot, "helper.sh"), "changed recipe");
    expect(sample.producer.observe().state).toBe("blocked");
  } finally { sample.store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
}, 30000);

test("stale live execution after namespace await fences before any script effects", async () => {
  const sample = await setupMission("printf installed > node_modules/dependency\n");
  try {
    const text = setupStartText(sample.store, sample.mission.id, "principal");
    expect(() => admitSetupStart(sample.store, sample.mission.id, "principal",
      recordOperatorInput("console", "principal", text)!, () => {})).toThrow(/native/);
    expect(() => admitSetupStart(sample.store, sample.mission.id, "principal",
      recordOperatorInput("native-confirmation", "other-session", text)!, () => {})).toThrow();
    let stale = false;
    const admission = sample.start(() => { if (stale) throw new Error("session/action expired"); });
    const job = sample.producer.ensure(admission, () => true);
    stale = true;
    expect((await job).state).toBe("blocked");
    expect(existsSync(path.join(sample.executionRoot, "node_modules/dependency"))).toBe(false);
    expect(sample.producer.quiescent).toBe(true);
    const receiptEvent = sample.store.inspectMission(sample.mission.id).events.find(({ kind }) => kind === "mission.setup.receipt")!;
    const receipt = JSON.parse(sample.store.readArtifact(String(receiptEvent.payload.receiptHash)).toString());
    expect(receipt).toMatchObject({ released: false, status: "stopped", disposed: true });
  } finally { sample.store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
}, 30000);

test("missing optional hook persists absence, not success; contained discovery can use preexisting prerequisites", async () => {
  const sample = await setupMission(undefined);
  try {
    expect(sample.store.inspectMission(sample.mission.id).prepared?.setup?.identity.script).toBeNull();
    expect(sample.producer.observe().state).toBe("missing-script");
    expect((await sample.producer.ensure({ id: "unarmed" }, () => true)).state).toBe("missing-script");
    expect(sample.store.inspectMission(sample.mission.id).events.some(({ kind }) => kind === "mission.setup.intent")).toBe(false);
    const workspace = createMissionWorkspace({ missionId: sample.mission.id, attemptId: crypto.randomUUID(),
      sourceRoot: sample.executionRoot, storeRoot: sample.store.storageRoot, candidateParent: path.join(sample.fixture.base, "candidates") });
    await preflightContainment(workspace);
    const child = spawnContained(workspace, "bash", ["-c", 'test "$(cat node_modules/dependency)" = preexisting'], { writablePaths: [] });
    child.stdin!.end(); child.stdout!.resume(); child.stderr!.resume();
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(0);
  } finally { sample.store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
}, 30000);

test("bounded real producer logs are explicit incomplete evidence, never reusable success", async () => {
  const sample = await setupMission("i=0; while ((i < 30000)); do printf '01234567890123456789'; ((i+=1)); done\nprintf installed > node_modules/dependency\n");
  try {
    expect((await sample.producer.ensure(sample.start(), () => true)).state).toBe("blocked");
    const inspection = sample.store.inspectMission(sample.mission.id);
    const receiptEvent = inspection.events.find(({ kind }) => kind === "mission.setup.receipt")!;
    const receiptBytes = sample.store.readArtifact(String(receiptEvent.payload.receiptHash));
    const intent = inspection.events.find(({ kind }) => kind === "mission.setup.intent")!;
    expect(receiptBytes.length + sample.store.readArtifact(String(intent.payload.inputHash)).length)
      .toBeLessThanOrEqual(allocation.artifactBytes);
    expect(JSON.parse(receiptBytes.toString())).toMatchObject({ status: "failed", truncated: true, disposed: true });
    expect(sample.producer.observe().state).toBe("blocked");
    expect(sample.producer.quiescent).toBe(true);
  } finally { sample.store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
}, 30000);

test("actual producer crash leaves durable invocation; physical recovery stops it without replay or success", async () => {
  const evidence = path.join("/tmp", `pitako-setup-interrupt-${crypto.randomUUID()}`);
  const child = spawn(process.execPath, [path.resolve("scripts/mission-setup-local.mjs"), evidence, "--interrupt"],
    { stdio: "ignore" });
  const code = await new Promise((resolve) => child.once("close", resolve));
  expect(code).toBe(74);
  const interrupted = JSON.parse(readFileSync(path.join(evidence, "interrupted.json"), "utf8"));
  const store = await openFixtureStore(interrupted.fixture);
  try {
    for (let turn = 0; turn < 200 && processesInNamespace(interrupted.process.namespace).length; turn++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(processesInNamespace(interrupted.process.namespace)).toHaveLength(0);
    const producer = new MissionSetup(store, interrupted.missionId);
    expect(producer.quiescent).toBe(false);
    expect(producer.reconcile().state).toBe("blocked");
    expect(producer.quiescent).toBe(true);
    expect((await producer.ensure({ id: "fake" }, () => true)).state).toBe("blocked");
    const events = store.inspectMission(interrupted.missionId).events;
    expect(events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
    expect(events.filter(({ kind }) => kind === "mission.setup.receipt")).toHaveLength(0);
    expect(events.filter(({ kind }) => kind === "mission.setup.reconciled")).toHaveLength(1);
  } finally {
    store.close(); rmSync(interrupted.fixture.base, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
}, 30000);

test("real setup profile denies protected, sentinel, credentials and socket access", async () => {
  const sample = await setupMission(`set -e
if printf changed > scripts/setup.sh; then exit 31; fi
printf changed > ../sentinel
if [ -r "$HOME/.ssh/id_rsa" ]; then exit 33; fi
if ${process.versions.bun ? "bun" : "node"} -e 'require("node:net").createServer().listen(24680)' 2>/dev/null; then exit 34; fi
if [ -s .git ] || [ -r .git/HEAD ] || [ -r .pitako/plans/durable-fixture.md ] || [ -r .pitako/runs/private.txt ]; then exit 35; fi
printf safe > node_modules/dependency
`);
  try {
    writeFileSync(path.join(sample.fixture.base, "sentinel"), "protected");
    mkdirSync(path.join(sample.executionRoot, ".pitako/runs"), { recursive: true });
    writeFileSync(path.join(sample.executionRoot, ".pitako/runs/private.txt"), "not an installer input");
    const result = await sample.producer.ensure(sample.start(), () => true);
    if (result.state !== "ready") {
      const event = sample.store.inspectMission(sample.mission.id).events.find(({ kind }) => kind === "mission.setup.receipt")!;
      throw new Error(sample.store.readArtifact(String(event.payload.receiptHash)).toString());
    }
    expect(result.state).toBe("ready");
    expect(readFileSync(path.join(sample.fixture.base, "sentinel"), "utf8")).toBe("protected");
    expect(readFileSync(path.join(sample.executionRoot, "node_modules/dependency"), "utf8")).toBe("safe");
  } finally { sample.store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
}, 30000);

test("real detached setup descendant is retired before durable stopped receipt; unfinished invocation never replays", async () => {
  const sample = await setupMission("setsid /bin/bash -c 'while :; do sleep 1; done' &\nprintf begun > node_modules/dependency\nwait\n");
  try {
    const job = sample.producer.ensure(sample.start(), () => true);
    for (let turn = 0; turn < 200 && !existsSync(path.join(sample.executionRoot, "node_modules/dependency")); turn++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(path.join(sample.executionRoot, "node_modules/dependency"))).toBe(true);
    sample.producer.fence();
    await sample.producer.stop();
    expect((await job).state).toBe("blocked");
    expect(sample.producer.quiescent).toBe(true);
    const reopened = new MissionSetup(sample.store, sample.mission.id);
    expect(reopened.observe().state).toBe("blocked");
    expect((await reopened.ensure(sample.start(), () => true)).state).toBe("blocked");
    expect(sample.store.inspectMission(sample.mission.id).events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
  } finally { sample.store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
}, 30000);

test("host inventory catches criteria omitted from both proposal mapping and executable proof", () => {
  const { fixture, request, context, proposal } = preparedFixture();
  try {
    const ready = validatePreparation({ request, proposal });
    if (ready.state !== "ready") throw new Error(JSON.stringify(ready.issues));
    for (const criterion of context.inventory.criteria) {
      const omitted = structuredClone(proposal);
      const ids = omitted.mappings.find(({ sourceId }) => sourceId === criterion.id)!.predicateIds;
      omitted.mappings = omitted.mappings.filter(({ sourceId }) => sourceId !== criterion.id);
      for (const unit of omitted.definition.units) {
        unit.acceptance = unit.acceptance.filter(({ id }) => !ids.includes(id));
        unit.originalIntent!.criteria = unit.originalIntent!.criteria.filter(({ sourceId }) => sourceId !== criterion.id);
      }
      for (const phase of Object.values(omitted.definition.finalization.selections!))
        phase.splice(0, phase.length, ...phase.filter((id) => !ids.includes(id)));
      omitted.definition.finalization.requiredPredicates = omitted.definition.finalization.requiredPredicates.filter((id) => !ids.includes(id));
      const result = validatePreparation({ request, proposal: omitted });
      expect(result.state).toBe("needs-input");
      if (result.state === "needs-input") expect(result.issues.some(({ sourceId }) => sourceId === criterion.id)).toBe(true);
    }
    const noDependency = structuredClone(proposal);
    noDependency.definition.units[1]!.dependencies = [];
    expect(validatePreparation({ request, proposal: noDependency }).state).toBe("needs-input");
    const noUnit = structuredClone(proposal);
    noUnit.definition.units.pop();
    const result = validatePreparation({ request, proposal: noUnit });
    expect(result.state).toBe("needs-input");
    expect(() => validatePreparation({ request: { id: request.id }, proposal })).toThrow(/host-owned/);
    expect(validatePreparation({ request, proposal: { ...proposal, inventory: context.inventory } }).state).toBe("needs-input");
  } finally { rmSync(fixture.base, { recursive: true, force: true }); }
});

test("generated store uses sibling pin and immutable prepared bytes, not local Markdown/JSON", async () => {
  const { fixture, executionRoot, request, proposal } = preparedFixture();
  const store = await openFixtureStore(fixture);
  try {
    const result = validatePreparation({ request, proposal });
    if (result.state !== "ready") throw new Error(JSON.stringify(result.issues));
    expect(() => assertPreparedAdmission(structuredClone(result.prepared))).toThrow(/host-validated/);
    const text = preparedAdmissionText(result.prepared);
    const operatorReceipt = recordOperatorInput("native-confirmation", "principal", text)!;
    const input = { repositoryRoot: executionRoot, planId: "durable-fixture", prepared: result.prepared,
      commandId: operatorReceipt.id, admissionReceiptId: operatorReceipt.id, operatorText: text, operatorReceipt };
    expect(() => store.createMission({ ...input, operatorReceipt: undefined })).toThrow(/confirmation provenance/);
    expect(() => store.createMission({ ...input, operatorReceipt: structuredClone(operatorReceipt) })).toThrow(/one-use/);
    const mission = store.createMission(input);
    const inspection = store.inspectMission(mission.id);
    expect(inspection.snapshot.schemaVersion).toBe(2);
    expect(inspection.snapshot.preparedHash).toBe(result.digest);
    expect(inspection.prepared!.originalSource).toBe(source);
    expect(missionPolicyTargets(inspection.definition, "developer")).toEqual({
      primary: proposal.definition.authority.rolePolicies.developer!.primaryTarget!,
      fallbacks: proposal.definition.authority.rolePolicies.developer!.fallbackTargets!,
    });
    expect(inspection.snapshot.planHash).toBe(sha256(Buffer.from(source)));
    expect(missionInputIdentity(inspection, executionRoot).planFile).toBe(fixture.planFile);
    expect(existsSync(path.join(executionRoot, ".pitako/runs"))).toBe(false);
    const local = path.join(executionRoot, ".pitako/plans");
    mkdirSync(local, { recursive: true });
    writeFileSync(path.join(local, "durable-fixture.md"), "ignored competing copy");
    expect(missionInputIdentity(store.inspectMission(mission.id), executionRoot).pinHash).toBe(inspection.snapshot.planHash);
    expect(() => missionInputIdentity(inspection, fixture.root)).toThrow(/execution root/);
    const revised = structuredClone(inspection.definition);
    revised.units[0]!.acceptance[0]!.command = "node --check check.mjs";
    const detail = `set ${JSON.stringify([{ target: { kind: "predicate", id: revised.units[0]!.acceptance[0]!.id, field: "command" },
      before: inspection.definition.units[0]!.acceptance[0]!.command, after: revised.units[0]!.acceptance[0]!.command }])}`;
    const choice = recordOperatorChoice(store, inspection, "principal", `/mission revise durable-fixture ${detail}`,
      detail, undefined, "native-confirmation");
    expect(admitMissionChange({ store, missionId: mission.id, expectedVersion: inspection.version, actor: "operator",
      planBytes: nextPlanBytes(inspection.planBytes), definitionBytes: Buffer.from(JSON.stringify(revised)), receipt: choice }).revision).toBe(2);
    const admitted = store.inspectMission(mission.id);
    expect(admitted.snapshot.preparedHash).not.toBe(inspection.snapshot.preparedHash);
    expect(admitted.snapshot.planHash).not.toBe(inspection.snapshot.planHash);
    expect(admitted.snapshot.sourceBinding).toEqual(inspection.snapshot.sourceBinding);
    expect(admitted.prepared!.originalSource).toBe(source);
    expect(missionInputIdentity(admitted, executionRoot).pinHash).toBe(inspection.snapshot.planHash);
    expect(admitted.events.find(({ kind }) => kind === "mission.revised")!.payload.operatorReceipt).toMatchObject({
      id: choice.id, source: "native-confirmation", base: { revision: 1, planHash: inspection.snapshot.planHash } });
    expect(() => admitMissionChange({ store, missionId: mission.id, expectedVersion: admitted.version, actor: "operator",
      planBytes: nextPlanBytes(admitted.planBytes), definitionBytes: Buffer.from(JSON.stringify(revised)), receipt: choice })).toThrow();
    const displaced = `${fixture.planFile}.moved`;
    renameSync(fixture.planFile, displaced);
    expect(() => missionInputIdentity(admitted, executionRoot)).toThrow();
    symlinkSync(displaced, fixture.planFile);
    expect(() => missionInputIdentity(admitted, executionRoot)).toThrow();
    rmSync(fixture.planFile); renameSync(displaced, fixture.planFile);
    expect(missionInputIdentity(admitted, executionRoot).pinHash).toBe(inspection.snapshot.planHash);
    writeFileSync(fixture.planFile, source + "\nchanged");
    expect(() => missionInputIdentity(inspection, executionRoot)).toThrow();
  } finally { store.close(); rmSync(fixture.base, { recursive: true, force: true }); }
});

test("unsupported observer and infeasible mandatory path do not become ready", () => {
  const { fixture, request, proposal } = preparedFixture();
  try {
    const manual = structuredClone(proposal);
    manual.definition.units[0]!.acceptance[0] = { id: "proof-0", kind: "manual", target: "just explain PASS" };
    const result = validatePreparation({ request, proposal: manual });
    expect(result.state).toBe("needs-input");
    if (result.state === "needs-input") expect(result.issues.some(({ message }) => message.includes("unsupported observer"))).toBe(true);
    const budget = structuredClone(proposal);
    budget.definition.budget.roleLaunches = 1;
    const blocked = validatePreparation({ request, proposal: budget });
    expect(blocked.state).toBe("needs-input");
    if (blocked.state === "needs-input") expect(blocked.issues.some(({ kind }) => kind === "budget")).toBe(true);
  } finally { rmSync(fixture.base, { recursive: true, force: true }); }
});
