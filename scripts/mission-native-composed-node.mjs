// Fixture-only native UI driver. No internal admission receipts or checker doubles.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registerMissionExtension } from "../extensions/mission/index.ts";
import { FINALIZATION_PHASES } from "../extensions/mission/finalization.ts";
import { assessMissionCompletion, missionCompletionCertificate } from "../extensions/mission/completion.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import { MissionSetup } from "../extensions/mission/setup.ts";
import { createMissionFixture, missionDefinition } from "../tests/mission-fixtures.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";

const out = process.argv[2];
assert.ok(out, "supply a fresh evidence directory");
assert.equal(process.versions.bun, undefined, "composed observation requires native Node");
assert.equal(process.env.PI_OFFLINE, "1", "composed observation is offline only");
mkdirSync(out);
const f = createMissionFixture("pitako-native-composed-");
const pinRoot = f.root, prior = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = f.stateDir;
const save = (name, value) => writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n");
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
let db, destination, settled = false, command;
const handlers = new Map(), tools = new Map(), messages = [], notices = [], confirmations = [];
registerMissionExtension({
  on: (name, fn) => handlers.set(name, [...handlers.get(name) ?? [], fn]),
  registerCommand: (_name, value) => { command = value.handler; },
  registerTool: (tool) => tools.set(tool.name, tool),
  sendUserMessage: (text, options) => { assert.deepEqual(options, { deliverAs: "followUp" }); messages.push(text); },
});
const ctx = { mode: "tui", hasUI: true, cwd: "", sessionManager: { getSessionId: () => "fixture-native-principal" },
  ui: { notify: (text) => notices.push(text), confirm: async (title, text) => {
    confirmations.push({ title, text }); return true;
  } } };
try {
  const provider = await installMissionLocalProvider({ agentDir: f.stateDir, reasoning: true,
    toolForPrompt: (prompt) => prompt.includes('"format":"mission-finalization-brief-v1"') ? undefined :
      { name: "bash", arguments: { command: 'test "$(cat node_modules/dependency)" = installed && printf "product\\n" > src/a' } },
    responseForPrompt(prompt) {
      if (!prompt.includes('"format":"mission-finalization-brief-v1"')) return "Offline fixture producer response.";
      const brief = JSON.parse(prompt.slice(prompt.indexOf('{"format":"mission-finalization-brief-v1"')).split("\n", 1)[0]);
      if (brief.target.phase === "whole-review") {
        const product = brief.resultFiles.find(({ path: file }) => file === "src/a");
        const observed = product?.kind === "file" && Buffer.from(product.bytesBase64, "base64").toString() === "product\n" &&
          brief.manifest.phaseReceiptHashes.length === FINALIZATION_PHASES.length - 1;
        return JSON.stringify({ ...brief.expectedResponse, verdict: observed ? "approve" : "inconclusive" });
      }
      return JSON.stringify({ ...brief.expectedResponse, steps: brief.expectedResponse.steps.map((step) => ({
        skill: step.skill, changedPaths: [], noOpReason: "Inspected src/a: its single product line is the complete checked behavior; no helper or prose to remove.",
      })) });
    } });
  rmSync(f.definitionFile);
  writeFileSync(f.planFile, `---
id: durable-fixture
revision: 1
status: frozen
execution: expected
---
# Native composed fixture
## Goal
Produce a checked product using the copied dependency.
## Ordered work units
### T1 — Product
Objective: write the product, not a PASS report.
Scope: src/a
Acceptance:
- The product contains product and the copied dependency contains installed.
Expected evidence: a contained offline checker reads both actual files.
## Final verification and success
- The complete result contains product after cleanup with the same copied dependency.
`);
  f.root = path.join(f.base, "execution");
  execFileSync("git", ["worktree", "add", "-q", "-b", "execution", f.root], { cwd: pinRoot });
  ctx.cwd = f.root;
  writeFileSync(path.join(f.root, ".gitignore"), ".pitako/\nnode_modules/\n");
  mkdirSync(path.join(f.root, "src")); writeFileSync(path.join(f.root, "src/a"), "original\n");
  mkdirSync(path.join(f.root, "scripts"));
  // This fixture's real hook exercises copy publication. The checkout hook's
  // frozen-lock and native-module compatibility is covered by retained T4 proof.
  writeFileSync(path.join(f.root, "scripts/setup.sh"), "test \"$(cat node_modules/seed)\" = local\nprintf installed > node_modules/dependency\n");
  execFileSync("git", ["add", ".gitignore", "src", "scripts"], { cwd: f.root });
  const seed = path.join(f.base, "seed"); mkdirSync(seed); writeFileSync(path.join(seed, "seed"), "local\n");
  const seedHash = hash(path.join(seed, "seed")), pinHash = hash(f.planFile);
  const config = path.join(f.stateDir, "pitako/config.toml");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, ["developer", "reviewer"].map((role) => `[model_policies.${role}]
primary = { model = "${provider.provider}/${provider.model}", reasoning = "high", fast = false }
`).join("\n"));
  await command("prepare durable-fixture", ctx);
  const context = JSON.parse(messages[0].split("\n")[1]);
  const definition = missionDefinition();
  definition.schemaVersion = 2;
  definition.authority.allowedPaths = ["src/**"]; definition.authority.operations = ["write", "bash"];
  definition.authority.verificationProfiles = ["sealed-nested-verification-v1"];
  definition.budget = { roleLaunches: 6, providerRequests: 12, tokens: 100000, activeTimeMs: 600000, artifactBytes: 8000000000 };
  for (const role of ["developer", "reviewer"]) {
    const policy = context.roles[role];
    definition.authority.rolePolicies[role] = { hash: policy.hash, provider: provider.provider, model: provider.model,
      fallbacks: [], primaryTarget: policy.primary, fallbackTargets: [] };
  }
  const unit = context.inventory.units[0];
  definition.units = [{ id: unit.engineId, role: "developer", kind: "implementation", dependencies: [],
    inputs: ["."], outputs: ["src/a"], risk: "low", retryLimit: 0,
    originalIntent: { sourceId: unit.id, objective: context.inventory.context.filter(({ role }) => role === "objective")
      .map(({ text }) => text).join(""), workBrief: unit.text, criteria: context.inventory.criteria
      .filter(({ owner }) => owner === unit.engineId).map(({ id, text }) => ({ sourceId: id, text, predicateIds: ["product-present"] })) },
    acceptance: [{ id: "product-present", kind: "command_exit", target: "result", expected: "0", timeoutMs: 30000,
      profile: "sealed-nested-verification-v1",
      command: `node --input-type=module -e 'import fs from "node:fs"; if(fs.readFileSync("src/a","utf8")!=="product\\n" || fs.readFileSync("node_modules/dependency","utf8")!=="installed") process.exit(2); fs.writeFileSync("/verification/evidence/checked.txt","actual product and copied dependency\\n"); console.log("observed product and copied dependency")'` }] }];
  definition.finalization = { contractVersion: 1, independentReview: true, requiredPredicates: ["product-present"],
    selections: { ordinary: ["product-present"], integrated: ["product-present"], affected: ["product-present"], final: ["product-present"] } };
  const proposal = { definition, mappings: context.inventory.criteria.map(({ id }) => ({
    sourceId: id, predicateIds: ["product-present"], explanation: "The contained command reads the actual product and dependency.",
  })) };
  const bounds = { paths: 100, largestFileBytes: 1000000, totalBytes: 1000000 };
  const setup = { effectProfile: "execution-root-local-copy-v1", writableDirectories: ["node_modules"],
    activeTimeMs: 30000, artifactBytes: 1000000000, copy: { bounds, seeds: [{ source: seed, destination: "node_modules", bounds }] } };
  const submit = (value) => tools.get("mission_prepare").execute("fixture-author", value, undefined, undefined, ctx);
  // A structural correction remains author-owned and never requests permission.
  const bad = structuredClone(proposal); bad.mappings.pop();
  const unresolved = JSON.parse((await submit({ id: "durable-fixture", requestId: context.requestId, proposal: bad, setup })).content[0].text);
  assert.equal(unresolved.status, "technical-unresolved"); assert.ok(unresolved.nextAction);
  assert.equal(confirmations.length, 0); assert.equal(existsSync(f.dbPath), false);
  const preparedResult = JSON.parse((await submit({ id: "durable-fixture", requestId: context.requestId, proposal, setup })).content[0].text);
  save("native-preparation.json", { context, unresolved, preparedResult, confirmations, notices });
  assert.equal(preparedResult.state, "prepared"); assert.equal(preparedResult.status, "ready");
  assert.ok(preparedResult.nextAction.includes("/mission start"));
  db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
  const prepared = db.findManagedMission(f.root);
  save("prepared.json", prepared);
  assert.equal(prepared.state, "prepared"); assert.equal(provider.trace.length, 0);
  assert.equal(prepared.events.some(({ kind }) => kind === "attempt.reserved" || kind === "mission.activated"), false);
  assert.equal(prepared.events[0].payload.operatorReceipt.source, "native-confirmation");
  assert.equal(new MissionSetup(db, prepared.id).observe().state, "ready");
  destination = prepared.prepared.setup.identity.copy.destination;
  assert.equal(prepared.events.filter(({ kind }) => kind === "mission.setup.intent").length, 1);
  const protectedCount = prepared.events.filter(({ kind, payload }) => kind === "reservation.created" && payload.purpose === "protected").length;
  assert.equal(protectedCount, 5);
  await command("status", ctx);
  assert.ok(notices.at(-1).includes('"preparationStatus":"ready"'));
  await command("start durable-fixture", ctx);
  const deadline = performance.now() + 600000;
  let inspection;
  let lastPhase;
  do {
    inspection = db.inspectMission(prepared.id);
    const phase = inspection.events.findLast(({ kind }) => kind === "mission.finalization.phase.started")?.payload.target.phase ?? inspection.state;
    if (phase !== lastPhase) { console.log(JSON.stringify({ phase, at: new Date().toISOString() })); lastPhase = phase; }
    if (["completed", "blocked", "paused", "cancelled"].includes(inspection.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (performance.now() < deadline);
  save("final.json", inspection); provider.flush(path.join(out, "provider.json"));
  const certificate = missionCompletionCertificate(inspection, db);
  assert.ok(certificate, JSON.stringify(assessMissionCompletion(inspection, db)));
  assert.equal(inspection.events.filter(({ kind }) => kind === "mission.setup.intent").length, 1);
  const firstAttempt = inspection.events.find(({ kind }) => kind === "attempt.reserved");
  assert.equal(inspection.events.filter(({ kind, payload, seq }) => kind === "reservation.created" &&
    payload.purpose === "protected" && seq < firstAttempt.seq).length, protectedCount);
  assert.equal(inspection.prepared.setup.identity.copy.destination, destination);
  const observations = inspection.events.filter(({ kind }) => kind === "evidence.recorded").map(({ payload }) =>
    JSON.parse(db.readArtifact(payload.artifactHash).toString()));
  const phases = inspection.events.filter(({ kind }) => kind === "mission.finalization.phase.receipted").map(({ payload }) => {
    const receipt = JSON.parse(db.readArtifact(payload.receiptHash).toString());
    return { receipt, observations: receipt.evidenceHashes.map((hash) => db.readArtifact(hash).toString())
      .filter((bytes) => bytes.startsWith("{")).map((bytes) => JSON.parse(bytes))
      .filter(({ format }) => format === "mission-predicate-observation-v1") };
  });
  assert.deepEqual(phases.map(({ receipt }) => receipt.target.phase), FINALIZATION_PHASES);
  for (const observation of [...observations, ...phases.flatMap(({ observations }) => observations)]) {
    assert.equal(observation.verdict, "pass");
    assert.equal(observation.receipt.status, "completed"); assert.equal(observation.receipt.exitCode, 0);
    assert.equal(observation.nestedVerification.profile, "sealed-nested-verification-v1");
    assert.equal(observation.nestedVerification.preparedHash, inspection.snapshot.preparedHash);
    assert.equal(observation.cleanupWitness.outerInitRetired, true);
    assert.equal(observation.cleanupWitness.namespaceEmptyAfterExit, true);
    assert.equal(observation.cleanupWitness.descendantsQuiescent, true);
    assert.ok(observation.receipt.stdoutSummary.includes("observed product and copied dependency"));
  }
  assert.ok(observations.length); assert.equal(phases.find(({ receipt }) => receipt.target.phase === "final-gates").observations.length, 1);
  assert.equal(hash(path.join(seed, "seed")), seedHash); assert.equal(hash(f.planFile), pinHash);
  assert.equal(existsSync(path.join(f.root, "node_modules")), false);
  assert.equal(readFileSync(path.join(f.root, "src/a"), "utf8"), "original\n");
  await command("status", ctx);
  save("observations.json", { fixtureAuthority: true, userApproval: false, certificate, observations, phases,
    confirmations, notices, seedHash, pinHash, originalsUnchanged: true, runtime: process.version, sample: f });
  cpSync(f.objectDir, path.join(out, "objects"), { recursive: true });
  settled = true;
  console.log(JSON.stringify({ state: inspection.state, certificateHash: certificate.certificateHash, setupIntents: 1, observations: observations.length }));
} finally {
  save("interaction.json", { messages, notices, confirmations, settled });
  let retired = false;
  try {
    for (const fn of handlers.get("session_shutdown") ?? []) await fn({ reason: "quit" }, ctx);
    retired = true;
  } catch (error) { save("retirement-error.json", { error: String(error) }); }
  db?.close();
  // Only a fully observed fixture is disposable. Unknown/failed ownership stays retained.
  if (settled && retired) {
    if (destination) rmSync(destination, { recursive: true, force: true });
    rmSync(f.base, { recursive: true, force: true });
  }
  save("lifecycle.json", { settled, retired, removed: settled && retired, fixtureRoot: f.base, destination });
  if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
}
