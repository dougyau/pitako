import { expect, spyOn, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine, type MissionAttemptBinding } from "../extensions/mission/engine.ts";
import { FINALIZATION_PHASES, currentWholeResultApproval, observeSourceMutation, sourceWitnessCurrent, parseFinalizationResponse, parseWholeResultResponse, type FinalizationTarget } from "../extensions/mission/finalization.ts";
import { captureWorkspaceImage, processesInNamespace } from "../extensions/mission/workspace.ts";
import { assessMissionCompletion, missionCompletionCertificate } from "../extensions/mission/completion.ts";
import { readSealedWorkspaceImage, reconcileMission } from "../extensions/mission/reconcile.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import { missionInputIdentity } from "../extensions/mission/inputs.ts";
import { recordOperatorInput } from "../extensions/mission/admission.ts";
import { bindPreparationAuthority, bindPreparationSetup, openPreparationRequest, preparationAuthorityText, preparationSetupText,
  preparationContext, preparedAdmissionText, validatePreparation } from "../extensions/mission/preparation.ts";
import { admitSetupStart, MissionSetup, setupStartText } from "../extensions/mission/setup.ts";
import { registerMissionExtension } from "../extensions/mission/index.ts";

const evidenceRoot = process.env.PITAKO_SLICE4B_EVIDENCE;

test("finalization transport accepts the retained whole-body receipt and rejects non-JSON presentation", () => {
  const retained = "```json\n{\"format\":\"mission-finalization-cleanup-v1\",\"phase\":\"ponytail\",\"inputArtifactHash\":\"66c41a8e3fde2f0d176dcdfc7338e7d38e7d328ad94a81a80ee1969608b96c9d\",\"scope\":[\"src/greeting.mjs\"],\"steps\":[{\"skill\":\"Ponytail\",\"changedPaths\":[],\"noOpReason\":\"src/greeting.mjs is already the shortest working form: greet returns `Hello, ${name.trim()}!` using String.prototype.trim(). No helper, dependency, comment, branch, or extra file to delete. Restyling the function declaration would not remove behavior. Existing suite still passes (2/2).\"}]}\n```";
  expect(createHash("sha256").update(retained).digest("hex")).toBe("39a73ab648ae05235df44e36aba6eb0fd39c42717f0cd9bb17f7e2d0ac5ab630");
  const response = parseFinalizationResponse(retained);
  expect(response.phase).toBe("ponytail");
  expect(response.steps[0].skill).toBe("Ponytail");
  expect(parseFinalizationResponse(JSON.stringify(response))).toEqual(response);
  for (const invalid of ["prose\n" + retained, retained + "\ntrailing", retained + "\n" + retained,
    "```json\n{}\n``", "```json\nnot JSON\n```", "```javascript\n{}\n```"])
    expect(() => parseFinalizationResponse(invalid)).toThrow();
  const expected = { format: "mission-whole-result-response-v1" as const, scope: "whole-result" as const,
    missionId: "mission", revision: 1, generation: 1, manifestHash: "a".repeat(64),
    rolePolicyHash: "b".repeat(64), evidenceHashes: [] };
  const fenced = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";
  expect(parseWholeResultResponse(fenced({ ...expected, verdict: "approve" }), expected).verdict).toBe("approve");
  expect(() => parseWholeResultResponse(fenced({ ...expected, verdict: "pass" }), expected)).toThrow();
  expect(() => parseWholeResultResponse(fenced({ ...expected, manifestHash: "c".repeat(64), verdict: "approve" }), expected)).toThrow();
});

async function runCase(name: string, changed = false) {
  const timed = name.startsWith("phase-time");
  const remainder = name.startsWith("token-remainder");
  const tokenExhausted = name === "token-remainder-exhausted";
  const timeHeld = name !== "phase-time" && timed;
  const timeExhausted = name === "phase-time-exhausted";
  const timeHoldId = randomUUID();
  let clock = 0;
  const pairing = name === "generated-token-pairing";
  const slackCase = name === "generated-token-slack" || pairing;
  const generated = name.startsWith("generated-");
  const setup = name.startsWith("generated-setup");
  const revised = name === "generated-setup-revised-recovery";
  const stopSetup = name === "generated-setup-stop";
  const selective = name.startsWith("generated-setup-selective");
  const diagnosticOnly = name === "generated-setup-selective-diagnostic";
  const selectedPhases = name === "generated-setup-selected-phases";
  const inputNegative = selective && name !== "generated-setup-selective" && !diagnosticOnly;
  const oneUnit = inputNegative || diagnosticOnly;
  const brokenProduct = name === "generated-failing-product" || name === "generated-setup-failing-product";
  const pausedReview = name.endsWith("paused-review");
  const cancelledReview = name.endsWith("cancelled-review");
  const twoCommands = ["two-commands", "failed-second-gate"].includes(name);
  const failedGate = ["failed-gate", "failed-second-gate"].includes(name);
  const sample = createMissionFixture(`pitako-finalization-${name}-`);
  const pinRoot = sample.root;
  const prior = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  if (revised) {
    sample.dbPath = path.join(agentDir, "pitako/missions.db");
    sample.objectDir = path.join(agentDir, "pitako/missions/objects");
  }
  mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
  mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src/a"), "original\n");
  execFileSync("git", ["add", "src"], { cwd: sample.root });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const provider = await installMissionLocalProvider({ agentDir, reasoning: generated,
    usage: name === "generated-token-slack" ? { input: 13000, output: 617, cacheRead: 0 } : undefined,
    contextWindow: slackCase ? 32768 : undefined,
    toolTurns: name === "generated-token-slack" ? 3 : 1,
    toolForPrompt: generated ? (prompt, completedTools) => prompt.includes('"format":"mission-finalization-brief-v1"')
      ? slackCase && prompt.includes('"phase":"ponytail"')
        ? { name: "bash", arguments: { command: "test -s src/a" } } : undefined :
        completedTools > 0 ? undefined :
        selective ? { name: "bash", arguments: { command:
          "test ! -e node_modules/dependency && cat src/diagnostic-input > src/diagnosis" } } :
        setup ? { name: "bash", arguments: { command:
          `test "$(cat node_modules/dependency)" = installed && printf '${brokenProduct ? "broken" : "product"}\\n' > src/a` } } :
        { name: "write", arguments: { path: "src/a", content: brokenProduct ? "broken\n" : "product\n" } } : undefined,
    responseForPrompt(prompt) {
    if (!prompt.includes('"format":"mission-finalization-brief-v1"')) return "producer response";
    const brief = JSON.parse(prompt.slice(prompt.indexOf('{"format":"mission-finalization-brief-v1"')).split("\n", 1)[0]!);
    if (brief.target.phase === "whole-review") {
      const product = brief.resultFiles?.find(({ path }: { path: string }) => path === "src/a");
      const observed = product?.kind === "file" && Buffer.from(product.bytesBase64, "base64").toString() === "product\n" &&
        brief.originalSource.includes("The complete result contains product after cleanup.") &&
        brief.manifest.phaseReceiptHashes.length === FINALIZATION_PHASES.length - 1;
      return "```json\n" + JSON.stringify({ ...brief.expectedResponse, ...(name === "wrong-manifest" ? { manifestHash: "0".repeat(64) } : {}),
        verdict: generated && !observed ? "inconclusive" : "approve" }) + "\n```";
    }
    return "```json\n" + JSON.stringify({ ...brief.expectedResponse, steps: brief.expectedResponse.steps.map((step: { skill: string }, index: number) => ({
      ...(name === "wrong-step-name" ? { name: step.skill } : { skill: step.skill }),
      changedPaths: changed && brief.target.phase === "cleanup" && index === 0 ? ["src/a"] : [],
      noOpReason: "Changed scope inspected; preserve the checked product behavior",
    })) }) + "\n```";
  } });
  const definition = missionDefinition();
  definition.finalization.contractVersion = 1;
  definition.authority.allowedPaths = ["src/**"];
  definition.authority.operations = ["write", "bash"];
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
  definition.authority.rolePolicies.reviewer = { hash: "b".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
  definition.units = [{ id: "product", role: "developer", kind: "implementation", dependencies: [], inputs: ["."], outputs: ["src/a"],
    acceptance: twoCommands ? [
      { id: "nonempty", kind: "command_exit", target: "result", command: "printf 'first-command\\n'; test -s src/a", expected: "0", timeoutMs: 3000 },
      { id: "product-present", kind: "command_exit", target: "result", command: "printf 'second-command\\n'; grep -q product src/a", expected: "0", timeoutMs: 3000 },
    ] : [{ id: "product-present", kind: "command_exit", target: "result", command: "grep -q product src/a", expected: "0", timeoutMs: 3000 }],
    risk: "low", retryLimit: 0 }];
  if (selective) definition.units.unshift({ id: "diagnostic", role: "developer", kind: "implementation", dependencies: [],
    inputs: ["src/diagnostic-input"], outputs: ["src/diagnosis"],
    acceptance: [{ id: "diagnosis-present", kind: "command_exit", target: "result", command: "grep -q '^unrelated$' src/diagnosis",
      inputPaths: ["src/diagnostic-input", "src/diagnosis"], expected: "0", timeoutMs: 3000 }], risk: "low", retryLimit: 0 });
  if (oneUnit) definition.units.pop();
  if (selectedPhases) definition.units[0]!.acceptance.push(
    { id: "nonempty", kind: "command_exit", target: "result", command: "test -s src/a", expected: "0", timeoutMs: 3000 },
    { id: "final-product", kind: "command_exit", target: "result", command: "test \"$(cat src/a)\" = product", expected: "0", timeoutMs: 3000 });
  definition.finalization.requiredPredicates = definition.units.flatMap(({ acceptance }) => acceptance.map(({ id }) => id));
  definition.budget = { roleLaunches: 4, providerRequests: 5, tokens: 10000, activeTimeMs: 120000, artifactBytes: 32_000_000 };
  if (setup) definition.budget.roleLaunches = 5;
  // Explicit disposable grant, not authority inferred for a real mission.
  if (name === "generated-setup-selective" || selectedPhases)
    definition.budget = { roleLaunches: 6, providerRequests: 10, tokens: 100000, activeTimeMs: 600000, artifactBytes: 67108864 };
  if (slackCase || timed || remainder)
    definition.budget = { roleLaunches: 6, providerRequests: pairing ? 12 : 32, tokens: 200000, activeTimeMs: 900000, artifactBytes: 67108864 };
  let prepared: ReturnType<typeof validatePreparation> | undefined;
  if (generated) {
    // The only source is the original sibling; neither JSON nor a plan is copied into execution.
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
${selective ? `### T1 — Diagnostic
Objective: diagnose unrelated source input without installed dependencies.
Scope: src/diagnostic-input, src/diagnosis
Acceptance:
- Diagnosis contains unrelated.
Expected evidence: a contained command reads the real diagnosis.
` : ""}${oneUnit ? "" : `### ${selective ? "T2" : "T1"} — Product
Objective: write the product, not a PASS report.
Scope: src/a
Acceptance:
- The product contains product.
Expected evidence: a contained command reads the real output.
`}## Final verification and success
- ${oneUnit ? "The complete result contains unrelated diagnosis after cleanup." : "The complete result contains product after cleanup."}
`);
    sample.root = path.join(sample.base, "execution");
    execFileSync("git", ["worktree", "add", "-q", "-b", "execution", sample.root], { cwd: pinRoot });
    // Temporary worktrees do not inherit this checkout's ignore policy.
    writeFileSync(path.join(sample.root, ".gitignore"), `.pitako/\n${selective ? "node_modules/\n" : ""}`);
    execFileSync("git", ["add", ".gitignore"], { cwd: sample.root });
    mkdirSync(path.join(sample.root, "src"), { recursive: true });
    writeFileSync(path.join(sample.root, "src/a"), "original\n");
    if (selective) writeFileSync(path.join(sample.root, "src/diagnostic-input"), "unrelated\n");
    execFileSync("git", ["add", "src"], { cwd: sample.root });
    writeFileSync(config, ["developer", "reviewer"].map((role) => `[model_policies.${role}]
primary = { model = "${provider.provider}/${provider.model}", reasoning = "high", fast = false }
fallbacks = [{ model = "${provider.provider}/${provider.model}", reasoning = "medium", fast = true }]
`).join("\n"));
    if (setup) {
      mkdirSync(path.join(sample.root, "scripts"));
      mkdirSync(path.join(sample.root, "node_modules"));
      writeFileSync(path.join(sample.root, "scripts/setup.sh"), selective ?
        "printf incomplete > node_modules/dependency\nexit 23\n" : stopSetup ?
        "setsid /bin/bash -c 'while :; do sleep 1; done' &\nprintf installed > node_modules/dependency\nwait\n" :
        "printf installed > node_modules/dependency\n");
    }
    const request = openPreparationRequest("durable-fixture", sample.root, "principal", { userConfigPath: config });
    if (setup) {
      const values = { effectProfile: "execution-root-local-v1" as const,
        writableDirectories: ["node_modules"], activeTimeMs: 10000, artifactBytes: 2_000_000 };
      bindPreparationSetup(request, values,
        recordOperatorInput("native-confirmation", "principal", preparationSetupText(request, values))!);
    }
    const context = preparationContext(request);
    definition.schemaVersion = 2;
    if (definition.budget.providerRequests < 6) definition.budget.providerRequests = 6; // ordinary tool call plus its terminal response
    for (const [index, unit] of definition.units.entries()) {
    unit.id = context.inventory.units[index]!.engineId;
    unit.originalIntent = {
      sourceId: context.inventory.units[index]!.id,
      objective: context.inventory.context.filter(({ role, owner }) => role === "objective" && owner === unit.id).map(({ text }) => text).join(""),
      workBrief: context.inventory.units[index]!.text,
      criteria: context.inventory.criteria.filter(({ owner }) => owner === unit.id).map(({ id, text }) =>
        ({ sourceId: id, text, predicateIds: selectedPhases ? ["product-present"] : unit.acceptance.map(({ id }) => id) })),
    };
    }
    const mappings = context.inventory.criteria.map(({ id, owner }) => ({
      sourceId: id, predicateIds: selectedPhases && owner === "mission" ? ["final-product"] :
        oneUnit || selective && owner === context.inventory.units[0]!.engineId ? ["diagnosis-present"] : ["product-present"],
      explanation: "The actual contained grep reads the mapped output.",
    }));
    if (selective && !oneUnit) definition.units[1]!.dependencies = [definition.units[0]!.id];
    for (const role of ["developer", "reviewer"]) {
      const policy = context.roles[role]!;
      definition.authority.rolePolicies[role] = { hash: policy.hash, provider: provider.provider, model: provider.model,
        fallbacks: policy.fallbacks.map(({ model }) => model), primaryTarget: policy.primary!,
        fallbackTargets: policy.fallbacks };
    }
    definition.finalization.selections = { ordinary: [...definition.finalization.requiredPredicates], integrated: [...definition.finalization.requiredPredicates],
      affected: [...definition.finalization.requiredPredicates], final: [...definition.finalization.requiredPredicates] };
    if (selectedPhases) definition.finalization.selections = {
      ordinary: ["product-present", "nonempty"], integrated: ["nonempty"], affected: ["product-present"],
      final: [...definition.finalization.requiredPredicates],
    };
    const values = { authority: definition.authority, budget: definition.budget };
    const text = preparationAuthorityText(request, values);
    bindPreparationAuthority(request, values, recordOperatorInput("native-confirmation", "principal", text)!);
    prepared = validatePreparation({ request, proposal: { definition, mappings } });
    if (prepared.state !== "ready") throw new Error(JSON.stringify(prepared.issues));
    if (name === "generated-setup-selective") {
      const insufficient = structuredClone(definition);
      insufficient.budget = { roleLaunches: 5, providerRequests: 6, tokens: 12000, activeTimeMs: 120000, artifactBytes: 32000000 };
      const insufficientValues = { authority: insufficient.authority, budget: insufficient.budget };
      bindPreparationAuthority(request, insufficientValues, recordOperatorInput("native-confirmation", "principal",
        preparationAuthorityText(request, insufficientValues))!);
      const denied = validatePreparation({ request, proposal: { definition: insufficient, mappings } });
      expect(denied.state).toBe("needs-input");
      if (denied.state === "needs-input") {
        expect(denied.issues.map(({ kind }) => kind)).toEqual(["budget"]);
        expect(denied.issues[0]!.message).toContain("setup allocation");
      }
      bindPreparationAuthority(request, values, recordOperatorInput("native-confirmation", "principal", text)!);
      if (evidenceRoot) {
        mkdirSync(path.join(evidenceRoot, name), { recursive: true });
        writeFileSync(path.join(evidenceRoot, name, "insufficient-grant.json"), JSON.stringify(denied, null, 2));
      }
    }
    if (!revised) {
      const competing = path.join(sample.root, ".pitako/plans");
      mkdirSync(competing, { recursive: true });
      writeFileSync(path.join(competing, "durable-fixture.md"), "not the pinned source");
      writeFileSync(path.join(competing, "durable-fixture.mission.json"), "not an admission contract");
    }
  } else writeFileSync(sample.definitionFile, JSON.stringify(definition));
  let store = await openFixtureStore(sample);
  let engine: MissionEngine | undefined;
  const timers = timed ? spyOn(globalThis, "setTimeout") : undefined;
  const observerErrors: unknown[] = [];
  let reviewReady!: () => void;
  let releaseReview!: () => void;
  const ready = new Promise<void>((resolve) => { reviewReady = resolve; });
  const released = new Promise<void>((resolve) => { releaseReview = resolve; });
  try {
    const admissionText = prepared?.state === "ready" ? preparedAdmissionText(prepared.prepared) : undefined;
    const admission = admissionText ? recordOperatorInput("native-confirmation", "principal", admissionText)! : undefined;
    const mission = store.createMission(prepared?.state === "ready" ? {
      repositoryRoot: sample.root, planId: "durable-fixture", prepared: prepared.prepared,
      commandId: admission!.id, admissionReceiptId: admission!.id,
      operatorText: admissionText!, operatorReceipt: admission!,
    } : missionInput(sample));
    const originalPin = readFileSync(sample.planFile);
    if (timed) {
      const append = store.appendTransition.bind(store);
      store.appendTransition = (id, version, transition) => {
        const result = append(id, version, transition);
        if (transition.events.some(row => row.kind === "mission.finalization.phase.started" &&
          !["ponytail", "cleanup", "whole-review"].includes((row.payload.target as FinalizationTarget).phase)))
          clock += 30000;
        return result;
      };
    }
    let revisionOne: ReturnType<typeof store.inspectMission> | undefined;
    let revisionOneRecovery: Awaited<ReturnType<typeof reconcileMission>> | undefined;
    let recovery: ReturnType<typeof reconcileMission> | undefined;
    if (name === "clean-report") {
      const append = store.appendTransition.bind(store);
      store.appendTransition = (id, version, transition) => {
        const result = append(id, version, transition);
        if (transition.events.some((row) => row.kind === "mission.activated"))
          recovery = reconcileMission({ store, missionId: mission.id, sourceRoot: sample.root, planFile: sample.planFile });
        return result;
      };
    }
    const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
    const options = { store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      ...(timed ? { now: () => clock } : {}),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
      runRole: async (...args: Parameters<typeof runner>) => {
        try {
        const [input, durable] = args;
        if (timed && input.binding.finalization) {
          const admitted = store.inspectMission(mission.id).events.filter(row =>
            row.kind === "mission.active.window.opened").at(-1)!;
          const abortTimer = timers!.mock.calls.filter(([callback]) =>
            String(callback).includes('controller.abort("finalization phase active-time grant expired")')).at(-1);
          expect(abortTimer).toBeDefined();
          expect(abortTimer![1]).toBe(admitted.payload.grantAmount as number);
          expect(abortTimer![1]).toBeGreaterThan(90000);
        }
        if (timed) {
          if (timeHeld && !input.binding.finalization) {
            const before = store.inspectMission(mission.id);
            store.appendTransition(mission.id, before.version, { events: [{
              revision: before.revision, kind: "reservation.created", causalId: timeHoldId,
              occurredAt: new Date().toISOString(), unitId: null, attemptId: null,
              payload: { reservationId: timeHoldId, resource: "active-time-ms",
                amount: 200000, purpose: "ordinary" },
            }, {
              revision: before.revision, kind: "budget.reservation.settled", causalId: randomUUID(),
              occurredAt: new Date().toISOString(), unitId: null, attemptId: null,
              payload: { reservationId: timeHoldId, resource: "active-time-ms", knownCharge: 0,
                unknownCharge: 100000, released: 0, source: "fixture interrupted clock",
                unknownReason: "prior runtime tail unresolved" },
            }] });
          }
          clock += input.binding.finalization?.phase === "cleanup" ? timeExhausted ? 500001 : 100001 :
            input.binding.finalization?.phase === "whole-review" ? 110000 : 59000;
        }
        if (generated) {
          const policy = definition.authority.rolePolicies[input.unit.role]!;
          if (!policy.primaryTarget || !policy.fallbackTargets) throw new Error("generated policy lacks complete frozen targets");
          expect(durable.rolePolicy).toEqual({ primary: policy.primaryTarget, fallbacks: policy.fallbackTargets });
        }
        expect(createHash("sha256").update(JSON.stringify(input.brief)).digest("hex")).toBe(input.binding.briefHash);
        const reservation = store.inspectMission(mission.id).events.find(({ kind, attemptId }) =>
          kind === "attempt.reserved" && attemptId === input.binding.attemptId)!;
        expect((reservation.payload.binding as MissionAttemptBinding).briefHash).toBe(input.binding.briefHash);
        if (input.binding.finalization) {
          // Parse the complete reserved string, not one JSON line that could hide a trailing ordinary brief.
          const brief = JSON.parse(input.brief);
          expect(input.brief).toBe(JSON.stringify(brief));
          expect(Object.keys(brief)).toEqual(["format", "target", "goal", "criteria", "changedScope",
            ...(generated ? ["originalSource", "sourceInventory", "evidenceMappings", "procedure"] : []),
            ...(setup ? ["setup"] : []),
            ...(generated && input.binding.finalization.phase === "whole-review" ? ["resultFiles"] : []), "instructions",
            ...(input.binding.finalization.phase === "whole-review" ? ["manifest"] : []), "expectedResponse"]);
          if (generated && prepared?.state === "ready") {
            expect(brief.originalSource).toBe(prepared.prepared.originalSource);
            expect(brief.sourceInventory).toEqual(prepared.prepared.inventory);
            expect(brief.evidenceMappings).toEqual(prepared.prepared.mappings);
          }
          expect(brief.format).toBe("mission-finalization-brief-v1");
          expect(brief.target).toEqual(input.binding.finalization);
          expect(brief.goal).toBe(definition.goal);
          expect(brief.criteria).toEqual(definition.units.map(({ id, acceptance }) => ({ id, acceptance })));
          expect(brief.changedScope).toEqual(["src/a"]);
          if (input.binding.finalization.phase === "whole-review") {
            const manifest = JSON.parse(store.readArtifact(input.binding.finalization.manifestHash!).toString());
            expect(brief.manifest).toEqual(manifest);
            expect(brief.expectedResponse).toEqual({ format: "mission-whole-result-response-v1", scope: "whole-result",
              missionId: mission.id, revision: input.binding.revision, generation: input.binding.finalization.generation,
              manifestHash: input.binding.finalization.manifestHash, rolePolicyHash: input.binding.rolePolicyHash,
              evidenceHashes: manifest.phaseReceiptHashes, verdict: "inconclusive" });
          } else expect(brief.expectedResponse).toEqual({ format: "mission-finalization-cleanup-v1",
            phase: input.binding.finalization.phase, inputArtifactHash: input.binding.finalization.inputArtifactHash,
            scope: ["src/a"], steps: (input.binding.finalization.phase === "cleanup" ? ["Unslop", "remove-ai-slops"] : ["Ponytail"]).map((skill) =>
              ({ skill, changedPaths: [], noOpReason: "Replace with the actual scope-bound no-op justification, or report actual changedPaths." })) });
          expect(brief.instructions).toBe((input.binding.finalization.phase === "whole-review"
            ? "Read-only independent review of the complete result, integrated delta, criteria, cleanup receipts and gates. Return only the exact structured response with verdict approve/reject/inconclusive."
            : input.binding.finalization.phase === "cleanup"
              ? "Perform Unslop, then remove-ai-slops, scoped to changedScope. Return ordered steps with changedPaths or a non-empty scope-bound no-op reason for each."
              : "Apply Ponytail full to changedScope. Preserve behavior. Return steps with changedPaths or a non-empty scope-bound no-op reason.") +
              " Return raw JSON only, without Markdown fences or surrounding prose.");
          expect(input.brief).not.toContain("Mission goal:");
          expect(input.brief).not.toContain("Previous observations:");
        }
        if (!generated && !input.binding.finalization || changed && input.binding.finalization?.phase === "cleanup") {
          const receipt = await durable.effects!.invoke("write", { path: "src/a", content: failedGate && input.binding.finalization ?
            "broken\n" : changed && input.binding.finalization ? "product\n# simplified\n" : "product\n" });
          expect(receipt.status).toBe("completed");
        }
        if (input.binding.finalization?.phase === "whole-review") {
          expect(durable.readOnly).toBe(true);
          const denied = await durable.effects!.invoke("write", { path: "src/a", content: "not authorized" });
          expect(denied.status).toBe("denied");
        }
        if (slackCase && !input.binding.finalization) {
          for (let index = 0; index < 3; index++) {
            const requestId = randomUUID();
            const ticket = await durable.onProviderDispatch({ requestId, provider: provider.provider, model: provider.model });
            await durable.onProviderReceipt({ requestId, provider: provider.provider, model: provider.model,
              inputTokens: pairing && index < 2 ? null : 10, outputTokens: pairing && index < 2 ? null : 15, ticket });
          }
          expect(store.inspectMission(mission.id).reservations.filter(row => row.purpose === "protected" &&
            row.resource === "provider-requests").reduce((sum, row) => sum + row.amount, 0)).toBe(4);
        }
        if (slackCase && input.binding.finalization?.phase === "ponytail") {
          const before = store.inspectMission(mission.id);
          const extra = before.events.filter(row => row.kind === "reservation.created" &&
            row.payload.purpose === "protected" && row.payload.resource === "provider-requests");
           expect(extra.map(row => row.payload.amount)).toEqual([4, pairing ? 1 : 16]);
          expect(extra[1]!.seq).toBeGreaterThan(before.events.find(row => row.kind === "attempt.settled" &&
            row.unitId !== "$finalization")!.seq);
          const requestId = randomUUID();
          const ticket = await durable.onProviderDispatch({ requestId, provider: provider.provider, model: provider.model });
          await durable.onProviderReceipt({ requestId, provider: provider.provider, model: provider.model,
            inputTokens: null, outputTokens: null, ticket });
          const accounting = store.inspectMission(mission.id);
          const reservationId = accounting.events.find(row => row.kind === "provider.request.dispatched" &&
            row.payload.requestId === requestId)!.payload.tokenReservationId;
          const first = accounting.reservations.find(row => row.id === reservationId)!;
           expect(first.grantAmount).toBe(pairing ? 33296 : 69679);
           expect(first.unknownCharge).toBe(first.grantAmount);
        }
        if (remainder) {
          const charge = async (amount: number) => {
            const requestId = randomUUID();
            const ticket = await durable.onProviderDispatch({ requestId, provider: provider.provider, model: provider.model });
            const before = store.inspectMission(mission.id);
            const id = before.events.find(row => row.payload.requestId === requestId &&
              row.kind === "provider.request.dispatched")!.payload.tokenReservationId;
            if (input.binding.finalization?.phase === "whole-review" && amount !== 18987)
              expect(before.reservations.find(row => row.id === id)!.grantAmount).toBe(1381 + 4234);
            await durable.onProviderReceipt({ requestId, provider: provider.provider, model: provider.model,
              inputTokens: amount, outputTokens: 0, ticket });
          };
          if (!input.binding.finalization) await charge(35323);
          if (input.binding.finalization?.phase === "ponytail") await charge(60000);
          if (input.binding.finalization?.phase === "cleanup") await charge(80000);
          if (input.binding.finalization?.phase === "whole-review") {
            const protectedTokens = store.inspectMission(mission.id).reservations.filter(row =>
              row.resource === "tokens" && row.purpose === "protected");
            expect(protectedTokens.slice(0, 2).map(row => row.grantAmount)).toEqual([66668, 93750]);
            await charge(18987);
            await charge(tokenExhausted ? 5616 : 3544);
            if (tokenExhausted) return { instanceId: input.binding.attemptId, role: input.binding.memberId,
              status: "failed" as const, result: "", error: "root tokens exhausted",
              model: { policyId: input.binding.memberId, requestedModel: "fixture/local", selectedModel: "fixture/local" } };
          }
        }
        const result = await runner(...args);
        if (timeExhausted && input.binding.finalization?.phase === "cleanup") return result;
        if (timed) expect(store.inspectMission(mission.id).events.filter(row =>
          row.kind === "budget.admission.fenced").map(row => row.payload.reason)).toEqual([]);
        if (slackCase) {
          const accounting = store.inspectMission(mission.id);
          const reservations = accounting.reservations;
          const grant = accounting.events.find(row => row.kind === "reservation.created" &&
            row.payload.resource === "tokens" && row.attemptId === input.binding.attemptId);
          const current = reservations.find(row => row.id === grant?.payload.reservationId);
          if (input.binding.finalization) {
             const grants = { ponytail: pairing ? 33296 : 69679, cleanup: pairing ? 49913 : 31877, "whole-review": pairing ? 66555 : 34927 };
            expect(current?.grantAmount).toBe(grants[input.binding.finalization.phase as keyof typeof grants]);
             expect(current?.knownCharge).toBe(input.binding.finalization.phase === "ponytail" ? 0 : pairing ? 25 : 13617);
            expect(current?.overage).toBe(0);
            if (input.binding.finalization.phase === "ponytail") {
              const second = reservations.filter(row => row.resource === "tokens" && row.purpose === "finalization").at(-1)!;
              expect(second.grantAmount).toBe(16667);
               expect(second.knownCharge).toBe(pairing ? 25 : 13617);
              const turns = provider.trace.filter(row => row.sessionId === input.binding.attemptId);
              expect(turns).toHaveLength(pairing ? 2 : 4); // real tool turns and the SDK terminal turn
               if (pairing) await expect(durable.onProviderDispatch({ requestId: randomUUID(), provider: provider.provider, model: provider.model }))
                 .rejects.toThrow(/retaining remaining mandatory stages/);
            }
            expect(reservations.filter(row => row.resource === "tokens" && row.purpose === "protected")
               .map(row => row.amount)).toEqual([66668, pairing ? 16667 : 100000, pairing ? 16591 : 6023]);
          }
        }
        if (generated) {
          expect(result.requests?.length).toBeGreaterThan(0);
          for (const request of result.requests!) {
            expect(request.reasoning).toBe("high");
            expect(request.fast_requested).toBe(false);
          }
          if (evidenceRoot) {
            const out = path.join(evidenceRoot, name, "sdk");
            mkdirSync(out, { recursive: true });
            writeFileSync(path.join(out, `${input.binding.attemptId}.json`), JSON.stringify({
              binding: input.binding, brief: input.brief, policy: durable.rolePolicy, result,
            }, null, 2));
          }
        }
        expect(provider.trace.find(({ sessionId }) => sessionId === input.binding.attemptId)!.prompt).toContain(input.brief);
        if (generated && !input.binding.finalization && prepared?.state === "ready") {
          expect(input.brief).toContain(input.unit.originalIntent!.workBrief);
          expect(input.brief).toContain(JSON.stringify(prepared.prepared.originalSource));
          const ordinary = store.inspectMission(mission.id).events.find(({ kind, attemptId }) =>
            kind === "attempt.reserved" && attemptId === input.binding.attemptId)!;
          const reservedBinding = ordinary.payload.binding as MissionAttemptBinding;
          expect(store.readArtifact(reservedBinding.briefArtifactHash!).toString()).toBe(input.brief);
        }
        if (input.binding.finalization?.phase === "ponytail" && name === "ordered") {
          const requestId = randomUUID();
          const ticket = await durable.onProviderDispatch({ requestId, provider: provider.provider, model: provider.model });
          await durable.onProviderReceipt({ requestId, provider: provider.provider, model: provider.model,
            inputTokens: 10, outputTokens: 15, ticket });
          await expect(Promise.resolve().then(() => durable.onProviderDispatch({
            requestId: randomUUID(), provider: provider.provider, model: provider.model,
          }))).rejects.toThrow(/retaining remaining mandatory stages/);
        }
        if (input.binding.finalization?.phase === "whole-review" && (pausedReview || cancelledReview)) {
          reviewReady(); await released;
        }
        return result;
        } catch (error) { observerErrors.push(error); throw error; }
      } };
    engine = new MissionEngine({ ...options, managedWorkspace: { ...options.managedWorkspace,
      sourceRoot: name.endsWith("wrong-root") ? pinRoot : sample.root } });
    const setupAdmission = setup ? admitSetupStart(store, mission.id, "principal",
      recordOperatorInput("native-confirmation", "principal", setupStartText(store, mission.id, "principal"))!, () => {}) : undefined;
    if (inputNegative) {
      if (name.endsWith("missing-pin")) rmSync(sample.planFile);
      if (name.endsWith("changed-pin")) writeFileSync(sample.planFile, "changed frozen input");
      if (name.endsWith("retargeted-pin")) {
        renameSync(sample.planFile, `${sample.planFile}.saved`);
        symlinkSync(`${sample.planFile}.saved`, sample.planFile);
      }
    }
    if (revised) {
      // Pause at the actual producer receipt, before the first worker reservation.
      const append = store.appendTransition.bind(store);
      let paused: Promise<void> | undefined;
      store.appendTransition = (id, version, transition) => {
        const result = append(id, version, transition);
        if (transition.events.some(({ kind }) => kind === "mission.setup.receipt"))
          paused = engine!.control("pause");
        return result;
      };
      engine.start(undefined, setupAdmission);
      await engine.waitForIdle();
      await paused;
      revisionOne = store.inspectMission(mission.id);
      expect(revisionOne.state).toBe("paused");
      expect(revisionOne.events.some(({ kind }) => kind === "attempt.reserved")).toBe(false);
      expect(new MissionSetup(store, mission.id).observe().state).toBe("ready");
      revisionOneRecovery = await reconcileMission({ store, missionId: mission.id, sourceRoot: sample.root, planFile: sample.planFile });
      await engine.retireForShutdown("quit");
      const handlers = new Map<string, Function[]>();
      let command!: Function;
      const notices: string[] = [], confirmations: string[] = [];
      registerMissionExtension({
        on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
        registerCommand: (_name: string, value: { handler: Function }) => { command = value.handler; },
        registerTool: () => {},
      } as any);
      let confirm: (text: string) => Promise<boolean> = async () => true;
      const ctx = { mode: "tui", cwd: sample.root, hasUI: true,
        sessionManager: { getSessionId: () => "fixture-native-principal" },
        ui: { notify: (text: string) => notices.push(text), confirm: async (_title: string, text: string) => {
          confirmations.push(text); return confirm(text); // Fixture UI response, not human approval.
        } } };
      const instruction = `revise durable-fixture Change predicate product-present command to "grep -q '^product$' src/a"`;
      // A later native action invalidates a still-awaited earlier confirmation.
      let releaseStale!: (value: boolean) => void;
      let opened!: () => void;
      const dialog = new Promise<void>((resolve) => { opened = resolve; });
      confirm = async () => { opened(); return new Promise<boolean>((resolve) => { releaseStale = resolve; }); };
      const stale = command(instruction, ctx);
      await dialog;
      confirm = async () => false;
      await command(instruction, ctx);
      releaseStale(true); await stale;
      expect(notices.at(-1)).toContain("confirmation expired");
      confirm = async () => true;
      await command(instruction, ctx);
      expect(notices.at(-1)).toContain("Revision 2");
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
      store = await openFixtureStore(sample);
      const admitted = store.inspectMission(mission.id);
      expect(admitted.revision).toBe(2);
      expect(admitted.snapshot.sourceBinding).toEqual(revisionOne.snapshot.sourceBinding);
      expect(admitted.prepared!.originalSource).toBe(revisionOne.prepared!.originalSource);
      expect(admitted.snapshot.preparedHash).not.toBe(revisionOne.snapshot.preparedHash);
      expect(admitted.snapshot.definitionHash).not.toBe(revisionOne.snapshot.definitionHash);
      expect(admitted.snapshot.planHash).not.toBe(revisionOne.snapshot.planHash);
      expect(readFileSync(sample.planFile).equals(originalPin)).toBe(true);
      expect(new MissionSetup(store, mission.id).observe()).toMatchObject({ state: "blocked",
        reason: "compatible setup success needs a current durable reuse reference" });
      const setupObserver = new MissionSetup(store, mission.id);
      setupObserver.reconcile();
      expect(setupObserver.observe().state).toBe("ready");
      const negativeCases: string[] = [];
      const checkPin = (caseName: string, mutate: () => void, restore: () => void) => {
        mutate();
        try {
          expect(() => missionInputIdentity(admitted, sample.root)).toThrow();
          expect(setupObserver.reconcile().state).toBe("blocked");
          negativeCases.push(caseName);
        } finally { restore(); }
      };
      checkPin("missing physical pin", () => renameSync(sample.planFile, `${sample.planFile}.saved`),
        () => renameSync(`${sample.planFile}.saved`, sample.planFile));
      checkPin("changed physical pin", () => writeFileSync(sample.planFile, "changed"),
        () => writeFileSync(sample.planFile, originalPin));
      checkPin("retargeted physical pin", () => {
        renameSync(sample.planFile, `${sample.planFile}.saved`);
        symlinkSync(`${sample.planFile}.saved`, sample.planFile);
      }, () => { rmSync(sample.planFile); renameSync(`${sample.planFile}.saved`, sample.planFile); });
      expect(() => missionInputIdentity(admitted, pinRoot)).toThrow();
      negativeCases.push("wrong execution root");
      for (const [caseName, file] of [
        ["incompatible setup input", path.join(sample.root, "scripts/setup.sh")],
        ["incompatible installed output", path.join(sample.root, "node_modules/dependency")],
      ]) {
        const bytes = readFileSync(file!);
        writeFileSync(file!, "incompatible");
        expect(setupObserver.observe().state).toBe("blocked");
        expect((await setupObserver.ensure(setupAdmission!, () => true)).state).toBe("blocked");
        writeFileSync(file!, bytes);
        negativeCases.push(caseName!);
      }
      const wrongAuthority = structuredClone(admitted);
      wrongAuthority.definition.authority.operations = ["bash"];
      expect(setupObserver.observe(wrongAuthority).state).toBe("blocked");
      negativeCases.push("changed execution authority");
      const unknownPrerequisite = structuredClone(admitted);
      unknownPrerequisite.prepared!.setup!.requiredBy.predicateIds = [];
      expect(setupObserver.observe(unknownPrerequisite).state).toBe("blocked");
      negativeCases.push("incomplete prerequisite references");
      expect(setupObserver.observe().state).toBe("ready");
      expect(store.inspectMission(mission.id).events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
      const revisedRecovery = await reconcileMission({ store, missionId: mission.id, sourceRoot: sample.root, planFile: sample.planFile });
      expect(revisedRecovery.revision).toBe(2);
      expect(revisedRecovery.plan.inputIdentity).toMatchObject({ pinRevision: 1, preparedHash: admitted.snapshot.preparedHash });
      expect(revisedRecovery.plan.inputIdentityHash).not.toBe(revisionOneRecovery!.plan.inputIdentityHash);
      negativeCases.push("stale revision-one recovery identity");
      definition.units[0]!.acceptance[0]!.command = "grep -q '^product$' src/a";
      if (evidenceRoot) {
        const out = path.join(evidenceRoot, name); mkdirSync(out, { recursive: true });
        writeFileSync(path.join(out, "native-revise.json"), JSON.stringify({ fixtureUI: true, confirmations, notices,
          revisionOne: revisionOne.snapshot, admitted: admitted.snapshot }, null, 2));
        writeFileSync(path.join(out, "recovery-and-negatives.json"), JSON.stringify({
          revisionOneRecovery, revisedRecovery, negativeCases }, null, 2));
      }
      engine = new MissionEngine({ ...options, store });
      await engine.control("resume");
    } else engine.start(undefined, setupAdmission);
    if (inputNegative) await expect(engine.waitForIdle()).rejects.toThrow(
      name.endsWith("missing-pin") ? "could not resolve pinned execution paths" :
        name.endsWith("changed-pin") ? "missing frontmatter" :
          name.endsWith("retargeted-pin") ? "changed physical path" : "execution root does not match");
    if (stopSetup) {
      for (let turn = 0; turn < 1000; turn++) {
        try { if (readFileSync(path.join(sample.root, "node_modules/dependency"), "utf8") === "installed") break; } catch {}
        await Bun.sleep(10);
      }
      expect(readFileSync(path.join(sample.root, "node_modules/dependency"), "utf8")).toBe("installed");
      const invocation = store.inspectMission(mission.id).events.find(({ kind, payload }) =>
        kind === "mission.setup.invoking" && payload.released === true)!;
      const namespace = (invocation.payload.process as { namespace: string }).namespace;
      expect(processesInNamespace(namespace).length).toBeGreaterThan(1);
      await engine.retireForShutdown("quit");
      await engine.waitForIdle();
      store = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
      const stopped = store.inspectMission(mission.id);
      expect(processesInNamespace(namespace)).toEqual([]);
      expect(stopped.events.some(({ kind }) => kind === "attempt.reserved")).toBe(false);
      const receiptRow = stopped.events.find(({ kind }) => kind === "mission.setup.receipt")!;
      const receipt = JSON.parse(store.readArtifact(String(receiptRow.payload.receiptHash)).toString());
      expect(receipt).toMatchObject({ status: "stopped", disposed: true });
      expect(stopped.events.find(({ kind }) => kind === "mission.owner.released")!.seq).toBeGreaterThan(receiptRow.seq);
      expect(new MissionSetup(store, mission.id).observe().state).toBe("blocked");
      if (evidenceRoot) {
        const out = path.join(evidenceRoot, name); mkdirSync(out, { recursive: true });
        writeFileSync(path.join(out, "journal-stopped.json"), JSON.stringify(stopped, null, 2));
        await store.exportMission(mission.id, path.join(out, "export-stopped"));
      }
      return;
    }
    if (name === "clean-report") {
      const report = await recovery!;
      expect(report.status).toBe("resumed");
      expect(report.blockers).toEqual([]);
      expect(report.disposition.causes).toEqual([]);
    }
    if (pausedReview || cancelledReview) {
      await Promise.race([ready, engine.waitForIdle().then(() => {
        throw new Error(`Reviewer was never reached: ${observerErrors.map(String).join("; ")}`);
      })]);
      engine.start();
      expect(store.inspectMission(mission.id).events.filter((row) => row.kind === "attempt.reserved" &&
        (row.payload.binding as { finalization?: { phase: string } }).finalization?.phase === "whole-review")).toHaveLength(1);
      const stopped = engine.control(pausedReview ? "pause" : "cancel");
      releaseReview(); await stopped;
      expect(currentWholeResultApproval(store.inspectMission(mission.id), store, sample.root)).toBeUndefined();
      if (pausedReview) {
        await engine.retireForShutdown("quit");
        store = await openFixtureStore(sample);
        engine = new MissionEngine({ ...options, store });
        await engine.control("resume");
      }
    }
    await engine.waitForIdle();
    expect(observerErrors).toEqual([]);
    let inspection = store.inspectMission(mission.id);
    if (evidenceRoot) {
      const out = path.join(evidenceRoot, name); mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "journal-initial.json"), JSON.stringify(inspection, null, 2));
      provider.flush(path.join(out, "provider-initial.json")); await store.exportMission(mission.id, path.join(out, "export-initial"));
    }
    const phases = inspection.events.filter((event) => event.kind === "mission.finalization.phase.receipted");
    if (remainder) {
      expect(inspection.reservations.filter(row => row.resource === "tokens" && row.purpose === "ordinary")
        .reduce((sum, row) => sum + row.amount, 0)).toBe(35348);
      const tokens = inspection.reservations.filter(row => row.resource === "tokens" && row.purpose !== "protected");
      expect(tokens.reduce((sum, row) => sum + row.knownCharge, 0)).toBe(tokenExhausted ? 200001 : 197954);
      if (tokenExhausted) {
        expect(inspection.events.some(row => row.kind === "budget.admission.fenced")).toBe(true);
        expect(missionCompletionCertificate(inspection, store)).toBeUndefined();
        expect(currentWholeResultApproval(inspection, store, sample.root)).toBeUndefined();
        expect(phases).toHaveLength(6);
        return;
      }
    }
    if (timed) {
      const time = inspection.reservations.filter(row => row.resource === "active-time-ms");
      expect(time.filter(row => row.purpose === "protected").map(row => row.grantAmount)).toEqual(
        [630000, timeHeld ? 11000 : 211000]);
      if (timeHeld) expect(time.find(row => row.id === timeHoldId)).toMatchObject({
        amount: 200000, grantAmount: 200000, unknownCharge: 100000, remainingHold: 100000, released: 0,
      });
      if (timeExhausted) {
        expect(inspection.events.filter(row => row.kind === "budget.admission.fenced").map(row =>
          row.payload.reason)).toContain("finalization phase exhausted its compiled finite active-time grant");
        expect(phases.map(row => (row.payload.target as FinalizationTarget).phase)).toEqual(FINALIZATION_PHASES.slice(0, 4));
        expect(missionCompletionCertificate(inspection, store)).toBeUndefined();
        expect(currentWholeResultApproval(inspection, store, sample.root)).toBeUndefined();
        return;
      }
      expect(time.reduce((sum, row) => sum + (row.purpose === "protected" ? 0 : row.amount), 0)).toBe(
        448001 + (timeHeld ? 200000 : 0));
    }
    if (inputNegative) {
      expect(inspection.events.some(({ kind }) => ["mission.setup.intent", "mission.setup.invoking",
        "attempt.reserved", "evidence.recorded", "unit.accepted"].includes(kind))).toBe(false);
      expect(provider.trace).toHaveLength(0);
      expect(phases).toHaveLength(0);
      expect(missionCompletionCertificate(inspection, store)).toBeUndefined();
      expect(currentWholeResultApproval(inspection, store, sample.root)).toBeUndefined();
      return;
    }
    if (selective) {
      expect(prepared!.state).toBe("ready");
      expect(inspection.prepared!.setup!.requiredBy).toEqual(diagnosticOnly ? { unitIds: [], predicateIds: [] } :
        { unitIds: [definition.units[1]!.id], predicateIds: ["product-present"] });
      expect(inspection.events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
      expect(inspection.events.filter(({ kind }) => kind === "mission.setup.invoking")).toHaveLength(2); // fence + released producer
      const setupRow = inspection.events.find(({ kind }) => kind === "mission.setup.receipt")!;
      expect(JSON.parse(store.readArtifact(String(setupRow.payload.receiptHash)).toString())).toMatchObject({ status: "failed", exitCode: 23, disposed: true });
      expect(inspection.events.filter(({ kind }) => kind === "attempt.reserved").map(({ unitId }) => unitId)).toEqual([definition.units[0]!.id]);
      expect(inspection.events.filter(({ kind }) => kind === "unit.accepted").map(({ unitId }) => unitId)).toEqual([definition.units[0]!.id]);
      expect(inspection.events.some(({ kind, payload }) => kind === "evidence.recorded" &&
        payload.predicateId === "diagnosis-present" && payload.verdict === "pass" && payload.assessmentAuthority === "production-checker")).toBe(true);
      expect(new MissionSetup(store, mission.id).observe().state).toBe("blocked");
      expect(readFileSync(path.join(sample.root, "node_modules/dependency"), "utf8")).toBe("incomplete");
      const terminal = inspection.events.find(({ kind, payload }) =>
        kind === "workspace.snapshot.sealed" && payload.purpose === "terminal-output")!;
      const result = readSealedWorkspaceImage(store, String(terminal.payload.imageHash));
      expect(result.files.find(({ path }) => path === "src/diagnosis")?.bytes?.toString()).toBe("unrelated\n");
      expect(result.files.some(({ path }) => path.startsWith("node_modules/"))).toBe(false);
      // Full original source includes the blocked unit's intent. Dispatch identity,
      // not prompt omission, proves that only the diagnostic actually ran.
      expect([...new Set(provider.trace.map(({ sessionId }) => sessionId))]).toEqual([terminal.attemptId!]);
      expect(inspection.reservations.filter(({ resource, purpose }) => resource === "role-launches" && purpose === "ordinary")).toHaveLength(1);
      expect(inspection.reservations.filter(({ purpose }) => purpose === "finalization")).toHaveLength(0);
      expect(inspection.reservations.filter(({ resource, purpose }) => resource === "role-launches" && purpose === "ordinary").every(
        ({ eventId }) => inspection.events.find((row) => row.eventId === eventId)?.unitId === definition.units[0]!.id)).toBe(true);
      expect(phases).toHaveLength(0);
      expect(missionCompletionCertificate(inspection, store)).toBeUndefined();
      expect(currentWholeResultApproval(inspection, store, sample.root)).toBeUndefined();
      engine.start(); await engine.waitForIdle();
      expect(store.inspectMission(mission.id).events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
      if (evidenceRoot) await store.exportMission(mission.id, path.join(evidenceRoot, name, "export"));
      return;
    }
    if (setup) {
      expect(inspection.events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
      expect(new MissionSetup(store, mission.id).observe().state).toBe("ready");
      const setupRow = inspection.events.find(({ kind }) => kind === "mission.setup.receipt")!;
      expect(inspection.events.findIndex(({ kind }) => kind === "attempt.reserved")).toBeGreaterThan(
        inspection.events.findIndex(({ eventId }) => eventId === setupRow.eventId));
      expect(readFileSync(path.join(sample.root, "node_modules/dependency"), "utf8")).toBe("installed");
      if (revised) {
        expect(inspection.revision).toBe(2);
        expect(missionInputIdentity(inspection, sample.root).pinRevision).toBe(1);
        const producing = JSON.parse(store.readArtifact(String(setupRow.payload.receiptHash)).toString());
        expect(producing.revision).toBe(1);
        const reuse = inspection.events.find(({ kind }) => kind === "mission.setup.reused")!;
        const proof = JSON.parse(store.readArtifact(String(reuse.payload.reuseHash)).toString());
        expect(proof).toMatchObject({ producingRevision: 1, revision: 2,
          producingPreparedHash: revisionOne!.snapshot.preparedHash,
          preparedHash: inspection.snapshot.preparedHash, definitionHash: inspection.snapshot.definitionHash });
        expect(proof.inputIdentity.pinRevision).toBe(1);
        expect(existsSync(path.join(sample.root, ".pitako/plans"))).toBe(false);
        expect(existsSync(sample.definitionFile)).toBe(false);
      }
    }
    if (brokenProduct) {
      expect(phases).toHaveLength(0);
      expect(inspection.events.some((row) => row.kind === "unit.accepted")).toBe(false);
      expect(inspection.events.some((row) => row.kind === "effect.receipt" &&
        row.payload.operation === (setup ? "bash" : "write") && row.payload.status === "completed")).toBe(true);
      expect(inspection.events.some((row) => row.kind === "evidence.recorded" &&
        row.payload.verdict === "inconclusive" && row.payload.assessmentAuthority === "production-checker")).toBe(true);
      expect(missionCompletionCertificate(inspection, store)).toBeUndefined();
      expect(currentWholeResultApproval(inspection, store, sample.root)).toBeUndefined();
      expect(provider.trace.filter(({ prompt }) => prompt.includes('"phase":"whole-review"'))).toHaveLength(0);
      if (evidenceRoot) {
        const out = path.join(evidenceRoot, name);
        provider.flush(path.join(out, "provider.json"));
        await store.exportMission(mission.id, path.join(out, "export"));
      }
      return;
    }
    if (twoCommands) {
      const gateObservations = ["integrated-checks", "affected-checks", "final-gates"].map((phase) => {
        const start = inspection.events.find((row) => row.kind === "mission.finalization.phase.started" &&
          (row.payload.target as { phase: string }).phase === phase)!;
        const receiptRow = phases.find((row) => row.attemptId === start.attemptId);
        const hashes = receiptRow ? JSON.parse(store.readArtifact(String(receiptRow.payload.receiptHash)).toString()).evidenceHashes :
          inspection.events.find((row) => row.kind === "attempt.settled" && row.attemptId === start.attemptId)!.payload.evidenceHashes;
        const observations = (hashes as string[]).map((hash) => store.readArtifact(hash).toString())
          .filter((text) => text.startsWith("{")).map((text) => JSON.parse(text))
          .filter((row) => row.format === "mission-predicate-observation-v1");
        expect(observations.map((row) => row.predicate.id)).toEqual(["nonempty", "product-present"]);
        expect(observations.map((row) => row.verdict)).toEqual(failedGate && phase === "final-gates" ? ["pass", "inconclusive"] : ["pass", "pass"]);
        expect(new Set(observations.map((row) => row.receipt.effectId)).size).toBe(2);
        for (const [index, observation] of observations.entries()) {
          expect(observation.subject.imageHash).toBe((start.payload.target as { inputArtifactHash: string }).inputArtifactHash);
          expect(observation.receipt.status).toBe(failedGate && phase === "final-gates" && index === 1 ? "failed" : "completed");
          expect(observation.receipt.exitCode).toBe(failedGate && phase === "final-gates" && index === 1 ? 1 : 0);
          expect(store.readArtifact(observation.stdoutHash).toString()).toBe(index === 0 ? "first-command\n" : "second-command\n");
          const terminal = inspection.events.find((row) => row.kind === "effect.receipt" && row.effectId === observation.receipt.effectId);
          expect(terminal?.payload.termination).toBe("exit");
        }
        return { phase, observations };
      });
      if (evidenceRoot) writeFileSync(path.join(evidenceRoot, name, "gate-observations.json"), JSON.stringify(gateObservations, null, 2));
    }
    if (selectedPhases) {
      const selections = definition.finalization.selections!;
      const ordinary = inspection.events.filter(({ kind }) => kind === "evidence.recorded");
      expect(ordinary.map(({ payload }) => payload.predicateId)).toEqual(selections.ordinary);
      const observations = Object.entries({ "integrated-checks": selections.integrated,
        "affected-checks": selections.affected, "final-gates": selections.final }).map(([phase, ids]) => {
        const row = phases.find(({ payload }) => (payload.target as { phase: string }).phase === phase)!;
        const receipt = JSON.parse(store.readArtifact(String(row.payload.receiptHash)).toString());
        const predicates = (receipt.evidenceHashes as string[]).map((hash) => {
          try { return JSON.parse(store.readArtifact(hash).toString()); } catch { return undefined; }
        }).filter((value) => value?.format === "mission-predicate-observation-v1");
        expect(predicates.map(({ predicate }) => predicate.id)).toEqual(ids);
        for (const observation of predicates) {
          expect(observation.verdict).toBe("pass");
          expect(observation.receipt).toMatchObject({ status: "completed", exitCode: 0 });
          expect(observation.subject.imageHash).toBe(receipt.target.inputArtifactHash);
          expect(inspection.events.find(({ effectId, kind }) =>
            kind === "effect.receipt" && effectId === observation.receipt.effectId)?.attemptId).toBe(row.attemptId);
        }
        return { phase, receipt, predicates };
      });
      expect(new Set([selections.ordinary, ...observations.map(({ predicates }) =>
        predicates.map(({ predicate }) => predicate.id))].map((ids) => JSON.stringify(ids))).size).toBe(4);
      if (evidenceRoot) writeFileSync(path.join(evidenceRoot, name, "selected-phase-observations.json"),
        JSON.stringify({ ordinary, observations }, null, 2));
    }
    if (name === "wrong-manifest" || name === "wrong-step-name" || cancelledReview || failedGate) {
      expect(phases.map((row) => (row.payload.target as { phase: string }).phase)).toEqual(
        FINALIZATION_PHASES.slice(0, name === "wrong-step-name" ? 2 : failedGate ? -2 : -1));
      expect(currentWholeResultApproval(inspection, store, sample.root)).toBeUndefined();
      expect(inspection.events.some((row) => row.kind === "mission.finalization.reviewed")).toBe(false);
      if (name === "wrong-manifest") expect(inspection.events.some((row) => String(row.payload.reason).includes("exact current manifest"))).toBe(true);
      if (name === "wrong-step-name") expect(inspection.events.some((row) =>
        String(row.payload.reason).includes("cleanup lacks ordered skill"))).toBe(true);
      if (failedGate) {
        const failed = inspection.events.find((row) => row.kind === "attempt.settled" && String(row.payload.reason).includes("final-gates:product-present"));
        expect(failed).toBeDefined();
        const observations = (failed!.payload.evidenceHashes as string[]).map((hash) => store.readArtifact(hash).toString())
          .filter((text) => text.startsWith("{")).map((text) => JSON.parse(text));
        expect(observations.some((row) => row.format === "mission-predicate-observation-v1" &&
          row.verdict === "inconclusive" && row.receipt.exitCode === 1)).toBe(true);
        expect(provider.trace).toHaveLength(3);
      }
    } else {
      expect(phases.map((row) => (row.payload.target as { phase: string }).phase)).toEqual([...FINALIZATION_PHASES]);
      const approval = currentWholeResultApproval(inspection, store, sample.root);
      expect(approval?.verdict).toBe("approve");
      expect(assessMissionCompletion(inspection, store).blockers).toEqual([]);
      expect(missionCompletionCertificate(inspection, store)).toBeDefined();
      if (revised) {
        const certificate = missionCompletionCertificate(inspection, store)!;
        expect(certificate.revision).toBe(2);
        expect(certificate.sourceIdentity).toMatchObject({ pinRevision: 1,
          planHash: inspection.snapshot.planHash, definitionHash: inspection.snapshot.definitionHash,
          preparedHash: inspection.snapshot.preparedHash });
        const manifest = JSON.parse(store.readArtifact(certificate.manifestHash).toString());
        expect(manifest.revision).toBe(2);
        expect(manifest.inputIdentity.pin.pinRevision).toBe(1);
        expect(manifest.inputIdentity.setup.reuseHash).toBeDefined();
        const staleReview = { ...inspection, events: inspection.events.map((row) => row.kind === "mission.finalization.reviewed" ?
          { ...row, revision: 1 } : row) };
        expect(currentWholeResultApproval(staleReview, store, sample.root)).toBeUndefined();
        expect(missionCompletionCertificate(staleReview, store)).toBeUndefined();
        const staleEvidence = { ...inspection, events: inspection.events.map((row) =>
          ["unit.accepted", "evidence.recorded"].includes(row.kind) ? { ...row, revision: 1 } : row) };
        expect(missionCompletionCertificate(staleEvidence, store)).toBeUndefined();
        expect(readFileSync(sample.planFile).equals(originalPin)).toBe(true);
        expect(existsSync(path.join(sample.root, ".pitako/plans"))).toBe(false);
      }
      if (generated && evidenceRoot) writeFileSync(path.join(evidenceRoot, name, "terminal-certificate.json"),
        JSON.stringify(missionCompletionCertificate(inspection, store), null, 2));
      const result = readSealedWorkspaceImage(store, JSON.parse(store.readArtifact(String(phases.at(-1)!.payload.receiptHash)).toString()).outputArtifactHash);
      expect(result.files.find((row) => row.path === "src/a")?.bytes?.toString()).toBe(changed ? "product\n# simplified\n" : "product\n");
      const sessions = provider.trace.map((row) => row.sessionId);
      expect(new Set(sessions).size).toBe(4);
      expect(inspection.reservations.filter((row) => row.resource === "role-launches" && row.purpose === "finalization")).toHaveLength(3);
      const extra = remainder ? 4 : slackCase ? pairing ? 2 : 4 : name === "ordered" ? 1 : 0;
      expect(inspection.reservations.filter((row) => row.resource === "provider-requests" && row.purpose === "finalization")).toHaveLength(3 + extra);
      expect(inspection.events.filter((row) => row.kind === "provider.request.dispatched")).toHaveLength((generated ? 5 : 4) + extra +
        (slackCase ? 3 : remainder ? 1 : 0));
      const launches = inspection.events.filter((row) => row.kind === "attempt.reserved").length;
      await engine.retireForShutdown("quit");
      store = name === "clean-report"
        ? await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true })
        : await openFixtureStore(sample);
      engine = new MissionEngine({ ...options, store });
      expect(() => engine!.start()).toThrow("completed cannot start");
      if (name === "clean-report") engine = undefined;
      inspection = store.inspectMission(mission.id);
      if (name === "clean-report") {
        expect(inspection.events.at(-1)?.kind).toBe("mission.owner.released");
        expect(inspection.events.at(-1)?.payload.effectsQuiescent).toBe(true);
      }
      if (evidenceRoot) {
        writeFileSync(path.join(evidenceRoot, name, "journal-reopen.json"), JSON.stringify(inspection, null, 2));
        const before = JSON.parse(store.readArtifact(approval!.sourceWitnessHash).toString());
        const after = observeSourceMutation(sample.root, captureWorkspaceImage(sample.root).manifest,
          before.planId, before.sourceBinding);
        expect(after).toEqual(before);
        writeFileSync(path.join(evidenceRoot, name, "witness-reopen.json"), JSON.stringify({ before, after }, null, 2));
      }
      expect(inspection.events.filter((row) => row.kind === "attempt.reserved")).toHaveLength(launches);
      expect(inspection.events.filter((row) => row.kind === "mission.finalization.reviewed")).toHaveLength(1);
      if (timed) expect(inspection.reservations.filter(row => row.resource === "active-time-ms" &&
        row.purpose === "protected").map(row => row.grantAmount)).toEqual([630000, timeHeld ? 11000 : 211000]);
      if (slackCase) {
        expect(inspection.reservations.filter(row => row.resource === "provider-requests" && row.purpose === "protected")
           .map(row => row.amount)).toEqual([4, pairing ? 1 : 16]);
        expect(missionCompletionCertificate(inspection, store)).toBeDefined();
      }
      if (remainder) expect(inspection.reservations.filter(row => row.resource === "tokens" &&
        row.purpose === "protected").map(row => row.grantAmount)).toEqual([66668, 93750, 4234]);
      expect(currentWholeResultApproval(inspection, store, sample.root)?.manifestHash).toBe(approval!.manifestHash);
      if (setup) {
        expect(new MissionSetup(store, mission.id).observe()).toMatchObject({ state: "ready", reused: true });
        expect(inspection.events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
        writeFileSync(path.join(sample.root, "node_modules/dependency"), "changed");
        expect(new MissionSetup(store, mission.id).observe().state).toBe("blocked");
        expect(currentWholeResultApproval(inspection, store, sample.root)).toBeUndefined();
        expect(missionCompletionCertificate(inspection, store)).toBeUndefined();
        return; // setup-only slice; native full-terminal/revision and existing ignored-copy fences are separate evidence
      }
      if (generated) {
        const identity = missionInputIdentity(inspection, sample.root);
        expect(identity.planFile).toBe(sample.planFile);
        expect(identity.preparedHash).toBe(prepared?.state === "ready" ? prepared.digest : undefined);
        const image = captureWorkspaceImage(sample.root).manifest;
        expect([...image.tracked, ...image.untracked].some(({ path }) => path.startsWith(".pitako/"))).toBe(false);
        // Overwrite already-present, genuinely ignored files without changing root directory ctime.
        writeFileSync(path.join(sample.root, ".pitako/plans/durable-fixture.md"), "changed ignored local copy");
        writeFileSync(path.join(sample.root, ".pitako/plans/durable-fixture.mission.json"), "changed ignored local JSON");
        expect(captureWorkspaceImage(sample.root).manifest.hash).toBe(image.hash);
        expect(sourceWitnessCurrent(store, approval!.sourceWitnessHash, sample.root)).toBe(true);
        expect(missionInputIdentity(inspection, sample.root)).toEqual(identity);
        expect(currentWholeResultApproval(inspection, store, sample.root)?.manifestHash).toBe(approval!.manifestHash);
        expect(missionCompletionCertificate(inspection, store)).toBeDefined();
      }
      if (name === "clean-report") expect(missionCompletionCertificate(inspection, store)).toBeDefined();
      const root = path.resolve(import.meta.dir, "..");
      const node = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, ["--experimental-strip-types",
        path.join(root, "scripts/mission-finalization-node.mjs"), sample.dbPath, sample.objectDir, mission.id, sample.root],
        { cwd: root, encoding: "utf8" });
      expect(node.status, node.stderr + node.stdout).toBe(0);
      if (evidenceRoot) {
        const out = path.join(evidenceRoot, name); mkdirSync(out, { recursive: true });
        writeFileSync(path.join(out, "node-observation.json"), node.stdout);
        writeFileSync(path.join(out, "journal.json"), JSON.stringify(inspection, null, 2));
        provider.flush(path.join(out, "provider.json")); await store.exportMission(mission.id, path.join(out, "export"));
      }
      const mutationPath = name === "ordered" || name === "generated-paused-review" ? sample.planFile : path.join(sample.root, "src/a");
      const originalBytes = readFileSync(mutationPath);
      const originalManifest = captureWorkspaceImage(sample.root).manifest.hash;
      expect(sourceWitnessCurrent(store, approval!.sourceWitnessHash, sample.root)).toBe(true);
      writeFileSync(mutationPath, "temporary\n");
      expect(currentWholeResultApproval(inspection, store, sample.root)).toBeUndefined();
      expect(missionCompletionCertificate(inspection, store)).toBeUndefined();
      if (generated && mutationPath === sample.planFile)
        expect(() => missionInputIdentity(inspection, sample.root)).toThrow();
      writeFileSync(mutationPath, originalBytes);
      expect(readFileSync(mutationPath).equals(originalBytes)).toBe(true);
      expect(captureWorkspaceImage(sample.root).manifest.hash).toBe(originalManifest);
      expect(sourceWitnessCurrent(store, approval!.sourceWitnessHash, sample.root)).toBe(false);
      expect(currentWholeResultApproval(inspection, store, sample.root)).toBeUndefined();
      expect(missionCompletionCertificate(store.inspectMission(mission.id), store)).toBeUndefined();
      if (generated) {
        expect(missionInputIdentity(inspection, sample.root).planFile).toBe(sample.planFile);
        const negativeNode = spawnSync("node", ["--experimental-strip-types",
          path.join(root, "scripts/mission-finalization-node.mjs"), sample.dbPath, sample.objectDir, mission.id, sample.root, "mutations"],
          { cwd: root, encoding: "utf8" });
        expect(negativeNode.status, negativeNode.stderr + negativeNode.stdout).toBe(0);
        if (evidenceRoot) writeFileSync(path.join(evidenceRoot, name, "node-mutations.json"), negativeNode.stdout);
      }
      if (evidenceRoot) writeFileSync(path.join(evidenceRoot, name, "journal-after-invalidation.json"),
        JSON.stringify(store.inspectMission(mission.id), null, 2));
    }
    expect(readFileSync(path.join(sample.root, "src/a"), "utf8")).toBe("original\n");
    expect(inspection.events.filter((row) => row.kind === "unit.accepted").map((row) => row.unitId)).toEqual([definition.units[0]!.id]);
    expect(missionCompletionCertificate(inspection, store)).toBeUndefined();
    expect(inspection.events.some((row) => row.kind === "mission.completed")).toBe(name !== "wrong-manifest" && name !== "wrong-step-name" && !cancelledReview && !failedGate);
    if (evidenceRoot && (name === "wrong-manifest" || cancelledReview || failedGate)) {
      const out = path.join(evidenceRoot, name); mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "journal.json"), JSON.stringify(inspection, null, 2));
      provider.flush(path.join(out, "provider.json")); await store.exportMission(mission.id, path.join(out, "export"));
    }
  } finally {
    releaseReview();
    try { await engine?.retireForShutdown("quit"); }
    finally {
      timers?.mockRestore();
      store.close(); rmSync(sample.base, { recursive: true, force: true });
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
      delete (globalThis as Record<string, unknown>)[`__${provider.provider.replace(/\W/g, "_")}`];
    }
  }
}

test("production SDK schedules exact current seven phases, no-op cleanup, distinct Reviewer, restart reuse and ignored frozen-plan edit-restore invalidation", () => runCase("ordered"), 90000);
test("production SDK completes finalization using the admitted token rounding remainder for the reached review charge", () => runCase("token-remainder"), 90000);
test("production SDK finalization still fences genuine root token exhaustion after allocating the rounding remainder", () => runCase("token-remainder-exhausted"), 90000);
test("production SDK completes cleanup beyond the compiled time estimate and subsequent final gates and review within admitted time", () => runCase("phase-time"), 90000);
test("production SDK keeps outstanding ordinary time holds while completing the required finalization path", () => runCase("phase-time-held"), 90000);
test("production SDK fences finalization time exhaustion without borrowing later mandatory minima or unknown holds", () => runCase("phase-time-exhausted"), 90000);
test("production SDK contains cleanup and checks changed result before exact whole review", () => runCase("changed-cleanup", true), 90000);
test("production SDK mismatched whole-result response never obtains approval", () => runCase("wrong-manifest"), 90000);
test("production SDK rejects cleanup name instead of the advertised exact skill key", () => runCase("wrong-step-name"), 90000);
test("durable completed SDK review held by pause is ingested once on explicit valid resume", () => runCase("paused-review"), 90000);
test("cancellation during real Reviewer lifecycle blocks completed receipt approval", () => runCase("cancelled-review"), 90000);
test("failed post-cleanup production gate preserves its actual inconclusive receipt and never launches Reviewer", () => runCase("failed-gate", true), 90000);
test("production SDK assesses two distinct required commands through every host gate before whole review", () => runCase("two-commands"), 90000);
test("production SDK retains genuine failing second-command evidence without final gate receipt or approval", () => runCase("failed-second-gate", true), 90000);
test("clean production recovery report permits contained checks, completion and quiescent reopen", () => runCase("clean-report"), 90000);
test("generated setup production SDK consumes installed backing through managed bash and real seven-phase certificate", () => runCase("generated-setup"), 90000);
test("real contained setup failure still permits generated independent SDK diagnosis at unchanged fixture caps", () =>
  runCase("generated-setup-selective-diagnostic"), 90000);
test("generated setup revised recovery keeps physical pin and reuses original producer through production terminal acceptance", () => runCase("generated-setup-revised-recovery"), 90000);
test("generated setup production SDK success cannot mask failing managed product predicate", () => runCase("generated-setup-failing-product"), 90000);
test("generated setup production SDK retirement disposes detached descendants before owner release and dispatch", () => runCase("generated-setup-stop"), 30000);
test("failed generated setup permits isolated unrelated production SDK diagnosis, not dependent approval", () => runCase("generated-setup-selective"), 90000);
test("generated healthy setup selects distinct production ordinary integrated affected and complete final predicates", () => runCase("generated-setup-selected-phases"), 90000);
test("generated production finalization retains a separate Ponytail quantum under unknown usage", () => runCase("generated-token-slack"), 90000);
test("generated production finalization pairs request slack only with tokens remaining after ordinary unknown holds", () => runCase("generated-token-pairing"), 90000);
for (const boundary of ["missing-pin", "changed-pin", "retargeted-pin", "wrong-root"]) {
  test(`selective generated engine ${boundary} admits zero setup, dispatch or acceptance`,
    () => runCase(`generated-setup-selective-${boundary}`), 30000);
}
test("generated sibling-only proposal dispatches exact source bytes and produces a production terminal certificate", () => runCase("generated-product"), 90000);
test("generated passing prose cannot replace failing production output evidence", () => runCase("generated-failing-product"), 90000);
test("generated SDK pause and reload retain physical pin and admitted prepared identity through resume and finalization", () => runCase("generated-paused-review"), 90000);
