import { expect, spyOn, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { admitMissionChange, nextPlanBytes, recordOperatorChoice, recordOperatorInput } from "../extensions/mission/admission.ts";
import { createPiMissionRunner, MissionEngine, missionPolicyTargets, type MissionRoleRunner } from "../extensions/mission/engine.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";
import { missionCompletionCertificate } from "../extensions/mission/completion.ts";
import { auditCompletionEvidence } from "../extensions/mission/completion-evidence.ts";
import { missionInputIdentity } from "../extensions/mission/inputs.ts";
import { captureMetricMission } from "../extensions/mission/metrics.ts";
import { sha256, validateMissionDefinition, type MissionDefinition } from "../extensions/mission/model.ts";
import { ARTIFACT_OPERATION_BYTES, HARD_TOKEN_CAP_UNSUPPORTED, meteredConsumptions, resourceAuthority } from "../extensions/mission/resources.ts";
import {
  assertPreparedAdmission, bindPreparationAuthority, openPreparationRequest, preparationAuthorityText,
  preparationContext, preparedAdmissionText, validatePreparation, type EvidenceMapping,
  bindPreparationSetup, preparationSetupText,
} from "../extensions/mission/preparation.ts";
import { admitSetupStart, assertSetupRequirements, captureSetupOutputs, MissionSetup, setupRequiredBy, setupStartText, type SetupAllocation } from "../extensions/mission/setup.ts";
import { createMissionWorkspace, preflightContainment, processesInNamespace, spawnContained } from "../extensions/mission/workspace.ts";
import { createMissionFixture, missionDefinition, openFixtureStore } from "./mission-fixtures.ts";
import { fixtureCommandTime } from "./mission-fixtures.ts";
import { assessMissionPredicate, readNestedVerificationAdmission } from "../extensions/mission/checks.ts";
import * as workspaceModule from "../extensions/mission/workspace.ts";
import { MissionEffects } from "../extensions/mission/effects.ts";
import { captureWorkspaceImage } from "../extensions/mission/workspace.ts";
import { missionEffectProcessesQuiescent, reconcileMission, sealWorkspaceImage } from "../extensions/mission/reconcile.ts";
import { PhysicalObservation } from "../extensions/mission/physical-observation.ts";

test("nested profile permission requires exact native confirmation, not console or proposal text", () => {
  const sample = preparedFixture();
  try {
    sample.proposal.definition.authority.verificationProfiles = ["sealed-nested-verification-v1"];
    const values = { authority: sample.proposal.definition.authority, budget: sample.proposal.definition.budget };
    const text = preparationAuthorityText(sample.request, values);
    expect(() => bindPreparationAuthority(sample.request, values, recordOperatorInput("console", "principal", text)!))
      .toThrow(/explicit native confirmation/);
    expect(validatePreparation({ request: sample.request, proposal: sample.proposal }).state).not.toBe("ready");
    bindPreparationAuthority(sample.request, values, recordOperatorInput("native-confirmation", "principal", text)!);
    expect(validatePreparation({ request: sample.request, proposal: sample.proposal }).state).toBe("ready");
  } finally { rmSync(sample.fixture.base, { recursive: true, force: true }); }
});

test("native checker admits sealed nested containment and ordinary SDK in one offline effect", async () => {
  const sample = preparedFixture();
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let effects: MissionEffects | undefined;
  try {
    for (const dir of ["extensions", "scripts", "roles"]) cpSync(path.join(process.cwd(), dir), path.join(sample.executionRoot, dir), { recursive: true });
    rmSync(path.join(sample.executionRoot, "scripts/setup.sh"));
    cpSync(path.join(process.cwd(), "package.json"), path.join(sample.executionRoot, "package.json"));
    for (const file of ["tests/mission-local-provider.ts", "tests/fixtures/nested-verification-case.ts"]) {
      mkdirSync(path.dirname(path.join(sample.executionRoot, file)), { recursive: true });
      cpSync(path.join(process.cwd(), file), path.join(sample.executionRoot, file));
    }
    cpSync(path.join(process.cwd(), "node_modules"), path.join(sample.executionRoot, "node_modules"), { recursive: true, verbatimSymlinks: true });
    writeFileSync(path.join(sample.executionRoot, ".gitignore"), "node_modules/\n");
    const definition = sample.proposal.definition;
    definition.authority.verificationProfiles = ["sealed-nested-verification-v1"];
    definition.budget.artifactBytes = 16000000000;
    const selected = definition.units[0]!.acceptance[0]!;
    Object.assign(selected, { target: "result", expected: "0", profile: "sealed-nested-verification-v1",
      command: `bun tests/fixtures/nested-verification-case.ts '${path.join(homedir(), ".ssh").replaceAll("'", "'\\''")}'`, timeoutMs: 60000 });
    const text = preparationAuthorityText(sample.request, { authority: definition.authority, budget: definition.budget });
    bindPreparationAuthority(sample.request, { authority: definition.authority, budget: definition.budget },
      recordOperatorInput("native-confirmation", "principal", text)!);
    const prepared = validatePreparation({ request: sample.request, proposal: sample.proposal });
    if (prepared.state !== "ready") throw new Error(JSON.stringify(prepared));
    store = await openFixtureStore(sample.fixture);
    const admissionText = preparedAdmissionText(prepared.prepared);
    const receipt = recordOperatorInput("native-confirmation", "principal", admissionText)!;
    const mission = store.createMission({ repositoryRoot: sample.executionRoot, planId: "durable-fixture", prepared: prepared.prepared,
      commandId: receipt.id, admissionReceiptId: receipt.id, operatorText: admissionText, operatorReceipt: receipt });
    const workspace = await createMissionWorkspace({ missionId: mission.id, attemptId: crypto.randomUUID(), sourceRoot: sample.executionRoot,
      productRoot: sample.executionRoot, storeRoot: store.storageRoot, candidateParent: path.join(sample.fixture.base, "candidates"), allowedPaths: ["."] });
    await preflightContainment(workspace);
    const sealed = sealWorkspaceImage(captureWorkspaceImage(workspace.candidateRoot));
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{
      revision: 1, kind: "mission.input.visible", causalId: crypto.randomUUID(), payload: {},
    }], artifacts: sealed.artifacts });
    effects = new MissionEffects({ store, workspace, missionId: mission.id, revision: 1, unitId: definition.units[0]!.id,
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!, allowedOperations: ["bash"],
      commandTime: fixtureCommandTime(120000) });
    const predicate = store.inspectMission(mission.id).definition.units[0]!.acceptance[0]!;
    const insufficient = await assessMissionPredicate({ predicate, subject: { kind: "workspace", imageHash: sealed.imageHash } },
      { store, effects, scopeEstablished: true, inputBindingHash: "a".repeat(64), timeoutLimitMs: 120000, artifactLimitBytes: 2000000 });
    expect(insufficient.verdict).toBe("inconclusive");
    expect(insufficient.method).toContain("insufficient finite artifact grant");
    expect(store.inspectMission(mission.id).events.some(({ kind }) => kind === "effect.invoking")).toBe(false);
    const observation = await assessMissionPredicate({ predicate, subject: { kind: "workspace", imageHash: sealed.imageHash } },
      { store, effects, scopeEstablished: true, inputBindingHash: "a".repeat(64), timeoutLimitMs: 120000, artifactLimitBytes: 2000000000 });
    const proof = JSON.parse(Buffer.from(observation.artifactBytes!).toString());
    const evidence = process.env.MISSION_T4_ARTIFACT_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(path.join(evidence, "native-observation.json"), JSON.stringify(proof, null, 2));
      for (const [index, artifact] of (observation.artifacts ?? []).entries())
        writeFileSync(path.join(evidence, `artifact-${index}`), artifact.bytes);
      writeFileSync(path.join(evidence, "events.json"), JSON.stringify(store.inspectMission(mission.id).events, null, 2));
    }
    expect(proof.reason).toBe("contained exact command passed");
    expect(observation.verdict).toBe("pass");
    expect(proof.receipt.stdoutSummary).toContain("NESTED_AND_SDK_PASS");
    expect(proof.receipt.stderrSummary).toContain("NESTED_TRAILING_STDERR");
    expect(proof.cleanupWitness.outerInitRetired).toBe(true);
    expect(proof.exportManifest.length).toBeGreaterThanOrEqual(3);
    expect(effects.quiescent).toBe(true);
  } finally {
    store?.close();
    if (!effects || effects.quiescent) rmSync(sample.fixture.base, { recursive: true, force: true });
  }
}, 120000);

for (const backing of ["absent", "denied", "denied-after-mkdir", "symlink", "populated",
  "forged-predicate", "forged-authority", "stale-grant", "policy-mismatch", "cancel-after-go"] as const)
test(`native nested launcher validates ${backing} dependency mountpoint before child`, async () => {
  const sample = preparedFixture();
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let effects: MissionEffects | undefined;
  let restoreFilter: (() => void) | undefined;
  let cancellationPoll: ReturnType<typeof setInterval> | undefined;
  let cancellationLimit: ReturnType<typeof setTimeout> | undefined;
  let cancellationObserved: Record<string, unknown> | undefined;
  let recoveryObservation: Promise<unknown> | undefined;
  let restoreInspection: (() => void) | undefined;
  try {
    const definition = sample.proposal.definition;
    definition.authority.verificationProfiles = ["sealed-nested-verification-v1"];
    definition.budget.artifactBytes = 16000000000;
    const selected = { id: `mountpoint-${backing}`, kind: "command_exit" as const,
      target: "result", expected: "0", profile: "sealed-nested-verification-v1" as const,
      command: "printf MOUNTPOINT_READY; printf TRAILING >&2", timeoutMs: 60000 };
    definition.units[0]!.acceptance.push(selected);
    if (backing === "cancel-after-go") selected.command = `node -e 'const cp=require("child_process"),fs=require("fs"); const marker="/verification/scratch/detached-started"; const child=cp.spawn("/usr/bin/bwrap",["--unshare-user","--unshare-pid","--ro-bind","/","/","--bind","/verification/scratch","/verification/scratch","--proc","/proc","--","/bin/bash","-c","printf started > "+marker+"; exec /usr/bin/sleep 1000"],{detached:true,stdio:"ignore"});child.unref();setInterval(()=>{},1000);'`;
    const values = { authority: definition.authority, budget: definition.budget };
    bindPreparationAuthority(sample.request, values,
      recordOperatorInput("native-confirmation", "principal", preparationAuthorityText(sample.request, values))!);
    const prepared = validatePreparation({ request: sample.request, proposal: sample.proposal });
    if (prepared.state !== "ready") throw new Error(JSON.stringify(prepared));
    store = await openFixtureStore(sample.fixture);
    const text = preparedAdmissionText(prepared.prepared);
    const admission = recordOperatorInput("native-confirmation", "principal", text)!;
    const mission = store.createMission({ repositoryRoot: sample.executionRoot, planId: "durable-fixture",
      prepared: prepared.prepared, commandId: admission.id, admissionReceiptId: admission.id,
      operatorText: text, operatorReceipt: admission });
    const workspace = await createMissionWorkspace({ missionId: mission.id, attemptId: crypto.randomUUID(),
      sourceRoot: sample.executionRoot, productRoot: sample.executionRoot, storeRoot: store.storageRoot,
      candidateParent: path.join(sample.fixture.base, "candidates"), allowedPaths: ["."] });
    const sourceBefore = sealWorkspaceImage(captureWorkspaceImage(sample.executionRoot)).imageHash;
    expect(existsSync(path.join(sample.executionRoot, "node_modules"))).toBe(false);
    await preflightContainment(workspace);
    expect(existsSync(path.join(workspace.candidateRoot, "node_modules"))).toBe(false);
    const mountpoint = path.join(workspace.candidateRoot, "node_modules");
    if (backing === "symlink") {
      const target = path.join(sample.fixture.base, "empty-link-target");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, mountpoint);
    }
    if (backing === "populated") {
      mkdirSync(mountpoint, { mode: 0o700 });
      writeFileSync(path.join(mountpoint, "candidate-content"), "must not overlay");
    }
    let launcherPrepared = false;
    const launcher = workspace.bwrapPath;
    Object.defineProperty(workspace, "bwrapPath", { get() {
      launcherPrepared = true;
      return launcher;
    } });
    const sealed = sealWorkspaceImage(captureWorkspaceImage(workspace.candidateRoot));
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{
      revision: 1, kind: "mission.input.visible", causalId: crypto.randomUUID(), payload: {},
    }], artifacts: sealed.artifacts });
    effects = new MissionEffects({ store, workspace, missionId: mission.id, revision: 1,
      unitId: definition.units[0]!.id, attemptId: workspace.attemptId, runtimeId: store.runtimeId,
      ownerEpoch: store.ownerEpoch!, allowedOperations: ["bash"], commandTime: {
        admit: async requested => requested!,
        remaining: () => launcherPrepared && (backing === "denied" ||
          backing === "denied-after-mkdir" && existsSync(mountpoint)) ? 0 : 120000,
      } });
    const controller = new AbortController();
    if (backing === "stale-grant" || backing === "cancel-after-go") {
      const enable = effects.enableNestedVerification.bind(effects);
      effects.enableNestedVerification = token => {
        enable(token);
        const grant = readNestedVerificationAdmission(token, workspace);
        if (backing === "stale-grant") {
          const current = store!.inspectMission(mission.id);
          store!.appendTransition(mission.id, current.version, { events: [{
            revision: current.revision, kind: "mission.cancelled", causalId: crypto.randomUUID(), payload: { reason: "fixture cancellation fences issued grant" },
          }] });
        } else {
          cancellationPoll = setInterval(() => {
            const marker = path.join(grant.capsule.root, "scratch/detached-started");
            if (!existsSync(marker)) return;
            const rows = store!.inspectMission(mission.id).events;
            cancellationObserved = { marker: readFileSync(marker, "utf8"), registered: rows.some(row => row.kind === "effect.process.registered"),
              released: rows.some(row => row.kind === "effect.released"),
              liveProcessesQuiescent: missionEffectProcessesQuiescent(rows, workspace.attemptId) };
            clearInterval(cancellationPoll);
            recoveryObservation = (async () => {
              const liveLifetime: Record<string, unknown>[] = [];
              expect(missionEffectProcessesQuiescent(rows, workspace.attemptId, liveLifetime)).toBe(false);
              const live = await reconcileMission({ store: store!, missionId: mission.id,
                sourceRoot: sample.executionRoot, trigger: "nested-live-owner" });
              const inspect = store!.inspectMission.bind(store);
              // Negative observation: the same native registration belongs to an unobservable host.
              store!.inspectMission = (...args) => {
                const current = inspect(...args);
                for (const row of current.events.filter(row => row.attemptId === workspace.attemptId))
                  for (const key of ["owner", "identity", "processIdentity"])
                    if (row.payload[key]) (row.payload[key] as Record<string, unknown>).hostId = "unobservable-host";
                return current;
              };
              let unknown;
              const unknownLifetime: Record<string, unknown>[] = [];
              try {
                expect(missionEffectProcessesQuiescent(store!.inspectMission(mission.id).events,
                  workspace.attemptId, unknownLifetime)).toBe(false);
                unknown = await reconcileMission({ store: store!, missionId: mission.id,
                  sourceRoot: sample.executionRoot, trigger: "nested-unknown-owner" });
              } finally { store!.inspectMission = inspect; }
              return { live: { report: live, lifetime: liveLifetime }, unknown: { report: unknown, lifetime: unknownLifetime } };
            })().finally(() => controller.abort("native nested fixture cancellation after detached startup"));
            void recoveryObservation.catch(() => {});
          }, 10);
          cancellationLimit = setTimeout(() => controller.abort("detached startup not observed within fixture bound"), 20000);
        }
      };
      if (backing === "cancel-after-go") {
        const invoke = effects.invoke.bind(effects);
        effects.invoke = (operation, input) => invoke(operation, input, controller.signal);
      }
    }
    if (backing === "policy-mismatch") {
      const original = workspaceModule.openSeccompFilter;
      let opened = 0;
      const filter = spyOn(workspaceModule, "openSeccompFilter").mockImplementation(profile =>
        original(++opened === 2 ? undefined : profile));
      restoreFilter = () => filter.mockRestore();
    }
    const admittedPredicate = store.inspectMission(mission.id).definition.units[0]!.acceptance.find(row => row.id === selected.id)!;
    const predicate = backing === "forged-predicate" ? { ...admittedPredicate, command: "printf forged" } : admittedPredicate;
    if (backing === "forged-authority") {
      // Corrupt only the bytes presented to the production checker, never issue new authority.
      const inspect = store.inspectMission.bind(store);
      store.inspectMission = (...args) => {
        const current = inspect(...args);
        const authority = JSON.parse(current.prepared!.authorityDecision.text);
        authority.values.budget.activeTimeMs += 1;
        current.prepared!.authorityDecision.text = JSON.stringify(authority);
        return current;
      };
      restoreInspection = () => { store!.inspectMission = inspect; };
    }
    const observation = await assessMissionPredicate({ predicate, subject: { kind: "workspace", imageHash: sealed.imageHash } },
      { store, effects, scopeEstablished: true, inputBindingHash: "c".repeat(64),
        timeoutLimitMs: 120000, artifactLimitBytes: 2000000000 });
    const recoveryProof = await recoveryObservation;
    const proof = JSON.parse(Buffer.from(observation.artifactBytes!).toString());
    const identities = { sourceBefore, sourceAfter: sealWorkspaceImage(captureWorkspaceImage(sample.executionRoot)).imageHash,
      sealedBefore: sealed.imageHash, sealedAfter: sealWorkspaceImage(captureWorkspaceImage(workspace.candidateRoot)).imageHash };
    if (process.env.MISSION_T4_ARTIFACT_DIR) {
      const root = process.env.MISSION_T4_ARTIFACT_DIR;
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, `mountpoint-${backing}.json`), JSON.stringify({ proof, identities, workspace,
        mountpoint: existsSync(mountpoint) ? { mode: lstatSync(mountpoint).mode & 0o777,
          symlink: lstatSync(mountpoint).isSymbolicLink() } : null,
        fixtureRoot: sample.fixture.base, quiescent: effects.quiescent, cancellationObserved, recoveryProof }, null, 2));
      writeFileSync(path.join(root, `mountpoint-${backing}-events.json`), JSON.stringify(store.inspectMission(mission.id).events, null, 2));
      for (const [index, artifact] of (observation.artifacts ?? []).entries())
        writeFileSync(path.join(root, `mountpoint-${backing}-artifact-${index}`), artifact.bytes);
    }
    if (backing !== "absent") {
      expect(observation.verdict).toBe("inconclusive");
      const rows = store.inspectMission(mission.id).events;
      if (backing === "cancel-after-go") {
        expect(cancellationObserved).toEqual({ marker: "started", registered: true, released: true, liveProcessesQuiescent: false });
        for (const [state, observation] of Object.entries(recoveryProof as Record<string, {
          report: Awaited<ReturnType<typeof reconcileMission>>; lifetime: Record<string, unknown>[];
        }>)) {
          expect(observation.lifetime).toEqual([expect.objectContaining({ effectId: proof.receipt.effectId,
            namespaceInitState: state, quiescent: false })]);
          expect(observation.report.blockers).toContain("prior mission owner release or positive death proof is missing");
          expect(observation.report.status).toBe("blocked");
          expect(observation.report.effects).toEqual([]);
        }
        expect(store.ownerEpoch).toBe(1);
        expect(rows.some(row => row.kind === "effect.reconciled" || row.kind === "mission.owner.released")).toBe(false);
        const terminal = rows.filter(row => row.kind === "effect.receipt").at(-1)!;
        expect(terminal.payload.status).toBe("failed");
        expect(terminal.payload.termination).toBe("signal");
        expect(terminal.payload.process).toMatchObject({ outerInitRetired: true });
        expect(effects.quiescent).toBe(true);
        return;
      }
      expect(rows.some(row => row.kind === "effect.process.registered" || row.kind === "effect.released")).toBe(false);
      if (backing === "forged-predicate" || backing === "forged-authority" || backing === "stale-grant" || backing === "policy-mismatch") {
        expect(proof.reason).toBe(backing === "forged-predicate" ? "explicit native nested verification authority is missing" :
          backing === "forged-authority" ? "native nested verification authority does not match the frozen definition" :
          backing === "stale-grant" ? "nested verification grant is stale or fenced" : "nested verification profile policy proof mismatch");
        expect(existsSync(mountpoint)).toBe(false);
        return;
      }
      if (backing === "denied" || backing === "denied-after-mkdir") {
        expect(existsSync(mountpoint)).toBe(false);
        expect(proof.receipt).toMatchObject({ status: "denied", paths: [],
          reason: "command timeout exceeds current remaining effect time grant" });
        expect(rows.filter(row => row.kind === "effect.receipt").at(-1)!.payload.process).toBeNull();
      } else {
        expect(proof.reason).toBe("source dependency mountpoint contains unexpected candidate content");
        if (backing === "symlink") expect(lstatSync(mountpoint).isSymbolicLink()).toBe(true);
        else expect(readFileSync(path.join(mountpoint, "candidate-content"), "utf8")).toBe("must not overlay");
      }
      return;
    }
    expect(proof.reason).toBe("contained exact command passed");
    expect(observation.verdict).toBe("pass");
    expect(proof.receipt.stdoutSummary).toBe("MOUNTPOINT_READY");
    expect(proof.receipt.stderrSummary).toBe("TRAILING");
    expect(proof.cleanupWitness.outerInitRetired).toBe(true);
    expect(identities.sourceAfter).toBe(sourceBefore);
    expect(identities.sealedAfter).toBe(sealed.imageHash);
    expect(effects.quiescent).toBe(true);
    const events = store.inspectMission(mission.id).events;
    const effectId = proof.receipt.effectId;
    expect(auditCompletionEvidence(events, store).effects).toEqual([]);
    const auditRefusals: Record<string, string[]> = {};
    for (const alteration of ["missing-retirement", "false-retirement", "changed-identity", "changed-registration",
      "unknown-field", "unbound-profile", "mismatched-binding", "unknown-profile"] as const) {
      const changed = structuredClone(events);
      const terminal = changed.find(row => row.kind === "effect.receipt" && row.effectId === effectId)!;
      const process = terminal.payload.process as Record<string, unknown>;
      if (alteration === "missing-retirement") delete process.outerInitRetired;
      if (alteration === "false-retirement") process.outerInitRetired = false;
      if (alteration === "changed-identity") process.birthTicks = Number(process.birthTicks) + 1;
      if (alteration === "changed-registration")
        (changed.find(row => row.kind === "effect.process.registered")!.payload.identity as Record<string, unknown>).birthTicks = -1;
      if (alteration === "unknown-field") process.unrecognizedRetirement = true;
      if (alteration === "unbound-profile" || alteration === "mismatched-binding" || alteration === "unknown-profile") {
        const intent = changed.find(row => row.kind === "effect.intent" && row.effectId === effectId)!;
        const plan = JSON.parse(store.readArtifact(String(intent.payload.effectPlanHash)).toString());
        if (alteration === "unbound-profile") delete plan.nestedVerification;
        else if (alteration === "mismatched-binding") plan.nestedVerification.ownerEpoch += 1;
        else plan.nestedVerification.profile = "unknown-profile";
        const bytes = Buffer.from(JSON.stringify(plan));
        store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{
          revision: 1, kind: "mission.input.visible", causalId: crypto.randomUUID(), payload: {},
        }], artifacts: [{ bytes, mediaType: "application/json" }] });
        for (const row of changed.filter(row => row.effectId === effectId && ["effect.intent", "effect.invoking"].includes(row.kind)))
          row.payload.effectPlanHash = sha256(bytes);
      }
      auditRefusals[alteration] = auditCompletionEvidence(changed, store).effects;
      expect(auditRefusals[alteration]).toContain(`effect:${effectId}`);
    }
    const ordinary = new MissionEffects({ store, workspace, missionId: mission.id, revision: 1, unitId: definition.units[0]!.id,
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!, allowedOperations: ["bash"],
      commandTime: fixtureCommandTime(120000) });
    const legacy = await ordinary.invoke("bash", { command: "printf LEGACY_IDENTITY" });
    await ordinary.shutdown();
    expect(legacy.status).toBe("completed");
    const legacyRows = store.inspectMission(mission.id).events.filter(row => row.effectId === legacy.effectId);
    expect(auditCompletionEvidence(legacyRows, store).effects).toEqual([]);
    for (const extra of [{ outerInitRetired: true }, { unknownObservation: true }, { birthTicks: -1 }]) {
      const changed = structuredClone(legacyRows);
      Object.assign(changed.find(row => row.kind === "effect.receipt")!.payload.process as object, extra);
      expect(auditCompletionEvidence(changed, store).effects).toContain(`effect:${legacy.effectId}`);
    }
    if (process.env.MISSION_T4_ARTIFACT_DIR) {
      const intent = events.find(row => row.kind === "effect.intent" && row.effectId === effectId)!;
      writeFileSync(path.join(process.env.MISSION_T4_ARTIFACT_DIR, "completion-audit.json"), JSON.stringify({
        effectId, planHash: intent.payload.effectPlanHash,
        plan: JSON.parse(store.readArtifact(String(intent.payload.effectPlanHash)).toString()),
        nativeRows: events.filter(row => row.effectId === effectId),
        positive: auditCompletionEvidence(events, store).effects, auditRefusals,
        legacyRows, legacyPositive: auditCompletionEvidence(legacyRows, store).effects,
      }, null, 2));
    }
    expect(lstatSync(mountpoint).mode & 0o777).toBe(0o700);
    expect(readdirSync(mountpoint)).toEqual([]);
  } finally {
    restoreFilter?.();
    restoreInspection?.();
    clearInterval(cancellationPoll);
    clearTimeout(cancellationLimit);
    store?.close();
    if (!effects || effects.quiescent) rmSync(sample.fixture.base, { recursive: true, force: true });
  }
}, 120000);

test("native nested checker rejects expired invocation, incomplete output and unsafe export after owned settlement", async () => {
  const sample = preparedFixture();
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let effects: MissionEffects | undefined;
  const nativeEvents: Array<Record<string, unknown>> = [];
  const note = (event: string, facts: Record<string, unknown> = {}) =>
    nativeEvents.push({ event, at: performance.now(), ...facts });
  const realSpawn = workspaceModule.spawnContained;
  type SpawnOptions = NonNullable<Parameters<typeof realSpawn>[3]>;
  function observedSpawn(workspace: Parameters<typeof realSpawn>[0], command: string, args: string[],
    options?: SpawnOptions & { canSpawn?: never }): ReturnType<typeof spawn>;
  function observedSpawn(workspace: Parameters<typeof realSpawn>[0], command: string, args: string[],
    options: SpawnOptions): ReturnType<typeof spawn> | undefined;
  function observedSpawn(workspace: Parameters<typeof realSpawn>[0], command: string, args: string[],
    options: SpawnOptions = {}): ReturnType<typeof spawn> | undefined {
    const transport = options.checkerTransport;
    note("spawn.begin", { command, args });
    if (transport) {
      for (const method of ["release", "drain"] as const) {
        const original = transport[method].bind(transport);
        transport[method] = async (timeoutMs) => {
          note(`${method}.begin`, { timeoutMs });
          try { await original(timeoutMs); note(`${method}.end`); }
          catch (error) { note(`${method}.error`, { error: String(error) }); throw error; }
        };
      }
      for (const [name, stream] of [["stdout", transport.stdout], ["stderr", transport.stderr]] as const)
        stream.once("end", () => note("output.end", { name }));
    }
    const child = realSpawn(workspace, command, args, options);
    note("spawn.return", { pid: child?.pid });
    if (child) {
      const kill = child.kill.bind(child);
      child.kill = (signal) => { note("signal", { signal }); return kill(signal); };
      child.once("exit", (code, signal) => note("exit", { code, signal }));
      child.once("close", (code, signal) => note("close", { code, signal }));
    }
    return child;
  }
  const spawnObserver = spyOn(workspaceModule, "spawnContained").mockImplementation(observedSpawn);
  try {
    const cases = [
      { id: "diagnostic-timeout", command: "exec /usr/bin/sleep 10", timeoutMs: 3000 },
      { id: "current-post-go-timeout", command: "printf POST_GO_STARTED; exec /usr/bin/sleep 1000", timeoutMs: 30000 },
      { id: "current-output", command: "printf '%02000000d' 1", timeoutMs: 60000 },
      { id: "current-export", command: "node -e 'require(\"fs\").symlinkSync(\"/tmp\", \"/verification/evidence/escape\"); console.log(\"EXPORT_COMMAND_RAN\")'", timeoutMs: 60000 },
    ];
    const definition = sample.proposal.definition;
    definition.authority.verificationProfiles = ["sealed-nested-verification-v1"];
    definition.budget.artifactBytes = 16000000000;
    definition.units[0]!.acceptance.push(...cases.map((row) => ({ ...row, kind: "command_exit" as const,
      target: "result", expected: row.id === "current-post-go-timeout" ? "124" : "0",
      profile: "sealed-nested-verification-v1" as const })));
    const values = { authority: definition.authority, budget: definition.budget };
    bindPreparationAuthority(sample.request, values,
      recordOperatorInput("native-confirmation", "principal", preparationAuthorityText(sample.request, values))!);
    const prepared = validatePreparation({ request: sample.request, proposal: sample.proposal });
    if (prepared.state !== "ready") throw new Error(JSON.stringify(prepared));
    store = await openFixtureStore(sample.fixture);
    const text = preparedAdmissionText(prepared.prepared);
    const receipt = recordOperatorInput("native-confirmation", "principal", text)!;
    const mission = store.createMission({ repositoryRoot: sample.executionRoot, planId: "durable-fixture",
      prepared: prepared.prepared, commandId: receipt.id, admissionReceiptId: receipt.id,
      operatorText: text, operatorReceipt: receipt });
    const workspace = await createMissionWorkspace({ missionId: mission.id, attemptId: crypto.randomUUID(),
      sourceRoot: sample.executionRoot, productRoot: sample.executionRoot, storeRoot: store.storageRoot,
      candidateParent: path.join(sample.fixture.base, "candidates"), allowedPaths: ["."] });
    await preflightContainment(workspace);
    const sealed = sealWorkspaceImage(captureWorkspaceImage(workspace.candidateRoot));
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{
      revision: 1, kind: "mission.input.visible", causalId: crypto.randomUUID(), payload: {},
    }], artifacts: sealed.artifacts });
    for (const predicate of store.inspectMission(mission.id).definition.units[0]!.acceptance.filter(
      (row) => cases.some(({ id }) => id === row.id))) {
      effects = new MissionEffects({ store, workspace, missionId: mission.id, revision: 1,
        unitId: definition.units[0]!.id, attemptId: workspace.attemptId, runtimeId: store.runtimeId,
        ownerEpoch: store.ownerEpoch!, allowedOperations: ["bash"],
        commandTime: fixtureCommandTime(predicate.id === "diagnostic-timeout" ? 20000 : 120000) });
      note("predicate.begin", { id: predicate.id, timeoutMs: predicate.timeoutMs });
      const observation = await assessMissionPredicate({ predicate, subject: { kind: "workspace", imageHash: sealed.imageHash } },
        { store, effects, scopeEstablished: true, inputBindingHash: "b".repeat(64),
          timeoutLimitMs: predicate.id === "diagnostic-timeout" ? 20000 : 120000, artifactLimitBytes: 2000000000 });
      const proof = JSON.parse(Buffer.from(observation.artifactBytes!).toString());
      note("predicate.end", { id: predicate.id, quiescent: effects.quiescent });
      const evidence = process.env.MISSION_T4_ARTIFACT_DIR;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(path.join(evidence, `${predicate.id}.json`), JSON.stringify(proof, null, 2));
        writeFileSync(path.join(evidence, `${predicate.id}-events.json`), JSON.stringify(
          store.inspectMission(mission.id).events, null, 2));
        writeFileSync(path.join(evidence, "native-events.json"), JSON.stringify(nativeEvents, null, 2));
        writeFileSync(path.join(evidence, "fixture-root.txt"), sample.fixture.base);
        for (const [index, artifact] of (observation.artifacts ?? []).entries())
          writeFileSync(path.join(evidence, `${predicate.id}-artifact-${index}`), artifact.bytes);
      }
      expect(observation.verdict).toBe("inconclusive");
      expect(effects.quiescent).toBe(true);
      const terminal = store.inspectMission(mission.id).events.filter(({ kind }) => kind === "effect.receipt").at(-1)!;
      if (predicate.id === "diagnostic-timeout") {
        expect(proof.reason).toBe("command termination, image or effect settlement is inconclusive");
        expect(terminal.payload.status).toBe("denied");
        expect(terminal.payload.process).toBeNull();
        expect(terminal.payload.reason).toBe("command timeout exceeds current remaining effect time grant");
        expect(store.inspectMission(mission.id).events.filter(row => row.effectId === terminal.effectId)
          .some(row => row.kind === "effect.process.registered" || row.kind === "effect.released")).toBe(false);
      } else expect(terminal.payload.process).toMatchObject({ outerInitRetired: true });
      if (predicate.id === "current-post-go-timeout") {
        expect(terminal.payload.termination).toBe("timeout");
        expect(terminal.payload.exitCode).toBe(124);
        expect(proof.reason).toBe("command termination, image or effect settlement is inconclusive");
        expect(proof.receipt.stdoutSummary).toBe("POST_GO_STARTED");
        const rows = store.inspectMission(mission.id).events.filter(row => row.effectId === terminal.effectId);
        expect(rows.some(row => row.kind === "effect.process.registered")).toBe(true);
        expect(rows.some(row => row.kind === "effect.released")).toBe(true);
        expect(terminal.payload.outputDrained).not.toBe(true);
        expect(terminal.payload.outputIncomplete).toBe(true);
        expect(terminal.payload.captureFailure).toBe("checker output drain exceeded finite deadline");
      }
      if (predicate.id === "current-output") {
        expect(proof.reason).toBe("command termination, image or effect settlement is inconclusive");
        expect(terminal.payload.outputTruncated).toBe(true);
      }
      if (predicate.id === "current-export") {
        expect(proof.reason).toBe("verification export is a link");
        expect(terminal.payload.termination).toBe("exit");
        expect(proof.receipt.exitCode).toBe(0);
        expect(proof.receipt.stdoutSummary).toContain("EXPORT_COMMAND_RAN");
      }
    }
  } finally {
    spawnObserver.mockRestore();
    store?.close();
    if (!effects || effects.quiescent) rmSync(sample.fixture.base, { recursive: true, force: true });
  }
}, 240000);

test("production engine denies expired pre-child invocation and rejects undisposed offline role", async () => {
  const sample = preparedFixture();
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let engine: MissionEngine | undefined;
  try {
    const definition = sample.proposal.definition;
    definition.authority.verificationProfiles = ["sealed-nested-verification-v1"];
    definition.budget.activeTimeMs = 1800000;
    definition.budget.artifactBytes = 16000000000;
    for (const unit of definition.units) for (const predicate of unit.acceptance)
      Object.assign(predicate, { target: "result", expected: "0", profile: "sealed-nested-verification-v1",
        command: "printf CURRENT_ENGINE_ROUTE; test -s input.mjs", timeoutMs: 60000 });
    const values = { authority: definition.authority, budget: definition.budget };
    bindPreparationAuthority(sample.request, values,
      recordOperatorInput("native-confirmation", "principal", preparationAuthorityText(sample.request, values))!);
    const prepared = validatePreparation({ request: sample.request, proposal: sample.proposal });
    if (prepared.state !== "ready") throw new Error(JSON.stringify(prepared));
    store = await openFixtureStore(sample.fixture);
    const text = preparedAdmissionText(prepared.prepared);
    const admission = recordOperatorInput("native-confirmation", "principal", text)!;
    const mission = store.createMission({ repositoryRoot: sample.executionRoot, planId: "durable-fixture",
      prepared: prepared.prepared, commandId: admission.id, admissionReceiptId: admission.id,
      operatorText: text, operatorReceipt: admission });
    engine = new MissionEngine({ store, missionId: mission.id, managedWorkspace: { sourceRoot: sample.executionRoot },
      sessionsDirectory: path.join(sample.fixture.base, "sessions"),
      runRole: async (input, durable) => {
        expect(input.binding.finalization).toBeUndefined();
        if (!input.binding.finalization) {
          expect((await durable.effects!.invoke("write", { path: "input.mjs", content: "export const value = 1;\n" })).status)
            .toBe("completed");
          expect((await durable.effects!.invoke("write", { path: "check.mjs", content: "export const check = true;\n" })).status)
            .toBe("completed");
          const workspace = durable.effects!.workspace;
          const launcher = workspace.bwrapPath;
          Object.defineProperty(workspace, "bwrapPath", { configurable: true, get() {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
            return launcher;
          } });
          try {
            expect(await durable.effects!.invoke("bash", {
              command: "printf MUST_NOT_EXECUTE", timeoutMs: 50,
            })).toMatchObject({ status: "denied", reason: "command timeout exceeds current remaining effect time grant" });
          } finally { Object.defineProperty(workspace, "bwrapPath", { configurable: true, value: launcher }); }
        }
        return { instanceId: input.binding.attemptId, role: input.binding.memberId, status: "completed",
          result: "offline producer settled", requests: [], model: { policyId: input.binding.memberId,
            requestedModel: "test/child", selectedModel: "test/child" } };
      } });
    engine.start();
    await engine.waitForIdle();
    const current = store.inspectMission(mission.id);
    const root = process.env.MISSION_T4_ARTIFACT_DIR;
    if (root) {
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "engine-current.json"), JSON.stringify(current, null, 2));
      writeFileSync(path.join(root, "engine-fixture-root.txt"), sample.fixture.base);
      for (const row of current.events) if (typeof row.payload.artifactHash === "string")
        writeFileSync(path.join(root, row.payload.artifactHash), store.readArtifact(row.payload.artifactHash));
    }
    expect(current.state).not.toBe("completed");
    const receipts = current.events.filter(row => row.kind === "effect.receipt" && row.payload.operation === "bash");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.payload).toMatchObject({ status: "denied", process: null,
      reason: "command timeout exceeds current remaining effect time grant" });
    const rows = current.events.filter(row => row.effectId === receipts[0]!.effectId);
    expect(rows.some(row => row.kind === "effect.invoking")).toBe(true);
    expect(rows.some(row => row.kind === "effect.process.registered" || row.kind === "effect.released")).toBe(false);
    expect(current.events.some(row => row.kind === "unit.verifying" &&
      row.payload.reason === "output seal inconclusive: terminal SDK disposal is unproven")).toBe(true);
    const observations = current.events.filter(row => row.kind === "evidence.recorded");
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every(row => row.payload.verdict === "inconclusive" &&
      row.payload.assessmentAuthority === "production-checker" &&
      row.payload.method === "check input scope is unestablished")).toBe(true);
    expect(current.events.some(row => row.kind === "mission.active.window.opened")).toBe(true);
    expect(current.events.some(row => row.kind === "budget.reservation.settled" &&
      row.payload.resource === "active-time-ms" && Number(row.payload.knownCharge) >= 100)).toBe(true);
    expect(missionCompletionCertificate(current, store)).toBeUndefined();
    await engine.close();
  } finally {
    store?.close();
    // The ordinary write receipts do not carry the nested outer-init retirement proof.
    // Retain this owned fixture rather than treating wrapper exit as cleanup authority.
  }
}, 240000);

function physicalWitness(root: string): string {
  const hash = createHash("sha256");
  const visit = (file: string) => {
    const stat = lstatSync(file);
    hash.update(JSON.stringify([path.relative(root, file), stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.nlink]));
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(path.join(file, name));
    else if (stat.isFile()) hash.update(readFileSync(file));
  };
  visit(root);
  return hash.digest("hex");
}

test("copied setup prepares a genuinely missing dependency directory using disclosed hardlinked seeds and real hook", async () => {
  // This is the actual checkout hook and native closure, not a receipt-producing double.
  const evidence = process.env.MISSION_SETUP_EVIDENCE;
  const started = performance.now();
  const stage = (name: string, details: unknown = {}) => {
    if (!evidence) return;
    mkdirSync(evidence, { recursive: true });
    writeFileSync(path.join(evidence, "stages.jsonl"),
      JSON.stringify({ stage: name, elapsedMs: performance.now() - started, details }) + "\n", { flag: "a" });
  };
  stage("fixture-start");
  const sample = preparedFixture();
  stage("fixture-created", { root: sample.fixture.base });
  let engine: MissionEngine | undefined;
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let destination: string | undefined;
  let producer: MissionSetup | undefined;
  let missionId: string | undefined;
  let primaryError: unknown;
  const witnesses: Array<{ path: string; before: string }> = [];
  const capture = () => {
    if (!evidence) return;
    if (store && missionId) {
      const current = store.inspectMission(missionId);
      writeFileSync(path.join(evidence, "live-events.json"), JSON.stringify(current, null, 2));
      for (const row of current.events.filter(({ kind }) => kind === "mission.setup.receipt"))
        writeFileSync(path.join(evidence, `${row.payload.receiptHash}.json`), store.readArtifact(String(row.payload.receiptHash)));
    }
    writeFileSync(path.join(evidence, "witnesses.json"), JSON.stringify(witnesses.map(row => ({
      ...row, after: physicalWitness(row.path),
    })), null, 2));
  };
  try {
    mkdirSync(path.join(sample.executionRoot, "scripts"), { recursive: true });
    for (const name of ["scripts/setup.sh", "package.json", "bun.lock"])
      cpSync(path.join(process.cwd(), name), path.join(sample.executionRoot, name));
    const originalDependencies = physicalWitness(path.join(process.cwd(), "node_modules"));
    stage("dependencies-witnessed");
    expect(existsSync(path.join(sample.executionRoot, "node_modules"))).toBe(false);
    const seed = path.join(sample.fixture.base, "installed-seed");
    cpSync(path.join(process.cwd(), "node_modules"), seed, { recursive: true, verbatimSymlinks: true });
    stage("seed-copied");
    rmSync(path.join(seed, "smol-toml"), { recursive: true });
    // Cache-hardlinked input is permitted; publication must still have no aliases.
    const hardlinkCache = path.join(sample.fixture.base, "hardlink-cache");
    mkdirSync(hardlinkCache);
    cpSync(path.join(seed, "pi-hermes-memory/package.json"), path.join(hardlinkCache, "package.json"));
    rmSync(path.join(seed, "pi-hermes-memory/package.json"));
    linkSync(path.join(hardlinkCache, "package.json"), path.join(seed, "pi-hermes-memory/package.json"));
    const cache = path.join(process.env.BUN_INSTALL_CACHE_DIR ?? path.join(homedir(), ".bun/install/cache"), "smol-toml@1.8.0@@@1");
    const originalCache = physicalWitness(cache);
    const originalSeed = physicalWitness(seed);
    witnesses.push({ path: path.join(process.cwd(), "node_modules"), before: originalDependencies },
      { path: cache, before: originalCache }, { path: seed, before: originalSeed });
    stage("inputs-witnessed");
    const limits = { paths: 40000, largestFileBytes: 123438592, totalBytes: 550000000 };
    const values: SetupAllocation = { effectProfile: "execution-root-local-copy-v1", writableDirectories: ["node_modules"],
      activeTimeMs: 120000, artifactBytes: 2000000000, copy: { bounds: limits, seeds: [
        { source: seed, destination: "node_modules", bounds: limits },
        { source: cache, destination: "cache/smol-toml@1.8.0@@@1", bounds: { paths: 100, largestFileBytes: 1000000, totalBytes: 1000000 } },
      ] } };
    expect(() => preparationSetupText(sample.request, { ...values, artifactBytes: 100000000 })).toThrow("allocation");
    expect(() => preparationSetupText(sample.request, { ...values, copy: { ...values.copy!,
      seeds: [{ ...values.copy!.seeds[0]!, bounds: { ...limits, largestFileBytes: 64 * 1024 * 1024 } }] } })).toThrow("byte bound");
    const definition = sample.proposal.definition;
    definition.budget = { ...definition.budget, roleLaunches: 100, providerRequests: 100, artifactBytes: 8000000000 };
    const authorityText = preparationAuthorityText(sample.request, { authority: definition.authority, budget: definition.budget });
    bindPreparationAuthority(sample.request, { authority: definition.authority, budget: definition.budget },
      recordOperatorInput("native-confirmation", "principal", authorityText)!);
    const text = preparationSetupText(sample.request, values);
    stage("setup-preview-captured");
    bindPreparationSetup(sample.request, values, recordOperatorInput("native-confirmation", "principal", text)!);
    const result = validatePreparation({ request: sample.request, proposal: sample.proposal });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error(JSON.stringify(result));
    destination = result.prepared.setup!.identity.copy!.destination;
    stage("prepared", { destination });
    store = await openFixtureStore(sample.fixture);
    const admissionText = preparedAdmissionText(result.prepared);
    const receipt = recordOperatorInput("native-confirmation", "principal", admissionText)!;
    const mission = store.createMission({ repositoryRoot: sample.executionRoot, planId: "durable-fixture", prepared: result.prepared,
      commandId: receipt.id, admissionReceiptId: receipt.id, operatorText: admissionText, operatorReceipt: receipt });
    missionId = mission.id;
    producer = new MissionSetup(store, mission.id);
    let dispatches = 0;
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.fixture.base, "sessions"),
      runRole: async () => { dispatches++; throw new Error("prepare cannot dispatch"); } });
    stage("producer-start", { missionId: mission.id });
    let preparationMarkers = 0;
    const marker = setInterval(() => preparationMarkers++, 10);
    const readiness = await engine.prepareSetup(() => {}).finally(() => clearInterval(marker));
    stage("preparation-overlap", { preparationMarkers });
    expect(preparationMarkers).toBeGreaterThan(0);
    stage("producer-settled", readiness);
    if (evidence) {
      const settled = store.inspectMission(mission.id);
      writeFileSync(path.join(evidence, "settled-events.json"), JSON.stringify(settled.events, null, 2));
      for (const row of settled.events.filter(({ kind }) => kind === "mission.setup.receipt"))
        writeFileSync(path.join(evidence, `${row.payload.receiptHash}.json`), store.readArtifact(String(row.payload.receiptHash)));
    }
    expect(readiness.state).toBe("ready");
    if (readiness.state !== "ready") throw new Error(readiness.reason);
    const current = store.inspectMission(mission.id);
    expect(current.state).toBe("prepared");
    expect(dispatches).toBe(0);
    expect(current.events.some(({ kind }) => kind === "mission.activated" || kind === "attempt.reserved")).toBe(false);
    const protectedRows = current.events.filter(({ kind, payload }) => kind === "reservation.created" && payload.purpose === "protected");
    expect(protectedRows).toHaveLength(5);
    const intent = current.events.find(({ kind }) => kind === "mission.setup.intent")!;
    expect(protectedRows.every(({ seq }) => seq < intent.seq)).toBe(true);
    const proof = JSON.parse(store.readArtifact(readiness.receiptHash).toString());
    expect(proof).toMatchObject({ format: "mission-setup-receipt-v2", status: "completed", disposed: true,
      released: true, exitCode: 0, truncated: false, timedOut: false });
    expect(proof.stdout).toContain("+ smol-toml@1.8.0");
    expect(proof.stdout).toContain("better-sqlite3: SELECT 42 = 42");
    expect(proof.stdout).toContain("node:sqlite: closed");
    expect(proof.measuredOutput.largestFileBytes).toBe(123438592);
    expect(proof.copy.bounds).toEqual(limits);
    const boundSetup = current.prepared!.setup!;
    expect(() => captureSetupOutputs({ ...boundSetup, identity: { ...boundSetup.identity,
      copy: { ...boundSetup.identity.copy!, bounds: { ...limits, largestFileBytes: 64 * 1024 * 1024 } } } }))
      .toThrow("byte bound exceeded");
    expect(physicalWitness(path.join(process.cwd(), "node_modules"))).toBe(originalDependencies);
    expect(physicalWitness(cache)).toBe(originalCache);
    expect(physicalWitness(seed)).toBe(originalSeed);
    expect(existsSync(path.join(sample.executionRoot, "node_modules"))).toBe(false);
    expect(await engine.prepareSetup(() => {})).toMatchObject({ state: "ready", reused: true });
    stage("reuse-verified");
    expect(store.inspectMission(mission.id).events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
    expect((await producer.refresh()).state).toBe("ready");
    const workspace = await createMissionWorkspace({ missionId: mission.id, attemptId: crypto.randomUUID(),
      sourceRoot: sample.executionRoot, storeRoot: store.storageRoot, candidateParent: path.join(sample.fixture.base, "candidates"),
      dependencyBacking: producer.dependencyBacking() });
    await preflightContainment(workspace);
    const child = spawnContained(workspace, "node", ["--input-type=module", "-e",
      `import fs from "node:fs"; import net from "node:net"; console.log(JSON.parse(fs.readFileSync("node_modules/smol-toml/package.json")).version); try { fs.writeFileSync("node_modules/forbidden","x"); process.exit(3); } catch(e) { console.log(e.code); } const s=net.connect(443,"1.1.1.1"); s.on("error",e=>{console.log(e.code);process.exit(e.code==="EPERM"?0:4)});`], { writablePaths: [] });
    child.stdin!.end();
    child.stderr!.resume();
    let output = "";
    child.stdout!.on("data", (data) => { output += data; });
    const exit = await new Promise((resolve) => child.once("close", resolve));
    stage("consumer-closed", { exit, output });
    expect(exit).toBe(0);
    expect(output).toContain("1.8.0");
    expect(output).toContain("EROFS");
    expect(output).toContain("EPERM");
    const alias = path.join(destination, "published/node_modules/alias");
    symlinkSync(path.join(hardlinkCache, "package.json"), alias);
    expect((await producer.refresh()).state).toBe("blocked");
    rmSync(alias);
    linkSync(path.join(hardlinkCache, "package.json"), alias);
    expect((await producer.refresh()).state).toBe("blocked");
    rmSync(alias);
    const publishedPackage = path.join(destination, "published/node_modules/smol-toml/package.json");
    const packageBytes = readFileSync(publishedPackage);
    writeFileSync(publishedPackage, "{}");
    expect((await producer.refresh()).state).toBe("blocked");
    expect(() => spawnContained(workspace, "node", ["-e", "process.exit(0)"], { writablePaths: [] })).toThrow("no longer current");
    await expect(engine!.start()).rejects.toThrow("current settled");
    writeFileSync(publishedPackage, packageBytes);
    expect((await producer.refresh()).state).toBe("ready");
    stage("publication-tamper-rejected-and-restored");
    await engine.start();
    await engine.control("pause");
    const started = store.inspectMission(mission.id);
    expect(started.events.filter(({ kind, payload }) => kind === "reservation.created" && payload.purpose === "protected")).toHaveLength(5);
    expect(started.events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
    if (process.env.MISSION_SETUP_EVIDENCE) {
      const evidence = process.env.MISSION_SETUP_EVIDENCE;
      mkdirSync(evidence, { recursive: true });
      writeFileSync(path.join(evidence, "production-input.json"), store.readArtifact(String(intent.payload.inputHash)));
      writeFileSync(path.join(evidence, "production-prepared.json"), JSON.stringify(current.prepared, null, 2));
      writeFileSync(path.join(evidence, "production-receipt.json"), JSON.stringify(proof, null, 2));
      writeFileSync(path.join(evidence, "production-observations.json"), JSON.stringify({
        originalDependencies, originalCache, originalSeed, originalsUnchanged: true,
        sourceDependenciesAbsent: !existsSync(path.join(sample.executionRoot, "node_modules")),
        candidateOutput: output, dispatchesBeforeStart: 0, protectedBeforeSetup: true,
        protectedReservationsAfterStart: 5, setupIntentsAfterStart: 1,
        events: started.events.map(({ kind, seq, payload }) => ({ kind, seq, payload })),
      }, null, 2));
    }
    stage("assertions-completed");
  } catch (error) {
    primaryError = error;
    stage("error", { error: String(error), stack: error instanceof Error ? error.stack : undefined });
    throw error;
  } finally {
    stage("retirement-start");
    try {
      capture();
      // Successful retirement awaits setup.stop(), proves effect quiescence,
      // releases the owner and closes the store. Do not query it after close.
      await engine?.retireForShutdown("quit");
      stage("retirement-settled", { retired: true });
      store?.close();
    } catch (error) {
      stage("retirement-error", { error: String(error), stack: error instanceof Error ? error.stack : undefined });
      if (primaryError !== undefined) throw new AggregateError([primaryError, error], "copied hook failed; retirement also failed");
      throw error;
    }
    if (destination) rmSync(destination, { recursive: true, force: true });
    rmSync(sample.fixture.base, { recursive: true, force: true });
    stage("fixture-removed");
  }
// Observer includes source/seed witnesses, native consent, reuse/tamper/consumer
// checks and retirement: 119s observed outside the unchanged 120s producer grant.
}, 360000);

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
    expect(admitted.status).toBe("technical-unresolved");
    expect(admitted.issues).toContainEqual(expect.objectContaining({ code: "unresolved-setup", owner: "runtime" }));
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

function preparedFixture(setupScript?: string, userConfigPath?: string) {
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
  const request = openPreparationRequest("durable-fixture", executionRoot, "principal", { userConfigPath: userConfigPath ?? configFile });
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
      target: "Node discriminating check", command: "node check.mjs", timeoutMs: 3000 })),
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

function meteredProposal(sample: ReturnType<typeof preparedFixture>, limits = {}) {
  const { budget: _budget, ...common } = sample.proposal.definition;
  const definition = validateMissionDefinition({ ...common, schemaVersion: 3,
    resourcePolicy: { estimates: { tokens: 1, activeTimeMs: 1 }, limits } });
  const values = resourceAuthority(definition);
  bindPreparationAuthority(sample.request, values, recordOperatorInput("native-confirmation", "principal",
    preparationAuthorityText(sample.request, values))!);
  return { definition, mappings: sample.proposal.mappings };
}

test("T2 schema 3 host preparation permits omitted ceilings and rejects unsupported hard tokens before dispatch", () => {
  const sample = preparedFixture();
  try {
    expect(validatePreparation({ request: sample.request, proposal: meteredProposal(sample) }).state).toBe("ready");
    const denied = validatePreparation({ request: sample.request, proposal: meteredProposal(sample, { tokens: 100000 }) });
    expect(denied.state).toBe("needs-input");
    expect(denied.issues.some(row => row.message.includes(HARD_TOKEN_CAP_UNSUPPORTED))).toBe(true);
  } finally { rmSync(sample.fixture.base, { recursive: true, force: true }); }
});

test("T2 metered provider unknown consumption remains traceable and admits further authorized requests", async () => {
  const sample = preparedFixture();
  const prepared = validatePreparation({ request: sample.request, proposal: meteredProposal(sample) });
  if (prepared.state !== "ready") throw new Error(JSON.stringify(prepared));
  const store = await openFixtureStore(sample.fixture);
  let engine: MissionEngine | undefined;
  try {
    const text = preparedAdmissionText(prepared.prepared);
    const receipt = recordOperatorInput("native-confirmation", "principal", text)!;
    const mission = store.createMission({ repositoryRoot: sample.executionRoot, planId: "durable-fixture", prepared: prepared.prepared,
      commandId: receipt.id, admissionReceiptId: receipt.id, operatorText: text, operatorReceipt: receipt });
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.fixture.base, "sessions"),
      managedWorkspace: { sourceRoot: sample.executionRoot, candidateParent: path.join(sample.fixture.base, "candidates") },
      runRole: async (_input, durable) => {
        for (const [inputTokens, outputTokens] of [[100, 25], [null, null], [200, 50]]) {
          const requestId = randomUUID();
          const ticket = await durable.onProviderDispatch({ requestId, provider: "test", model: "child" });
          expect(ticket).toMatchObject({ kind: "metered", operationId: requestId, resource: "tokens" });
          await durable.onProviderReceipt({ requestId, provider: "test", model: "child", inputTokens, outputTokens, ticket });
        }
        return { instanceId: "offline", role: "developer", status: "failed", result: "Intentional accounting-only stop.",
          model: { policyId: "developer", requestedModel: "test/child", selectedModel: "test/child" } };
      } });
    engine.start(); await engine.waitForIdle();
    const inspection = store.inspectMission(mission.id);
    const tokens = meteredConsumptions(inspection.events).filter(row => row.resource === "tokens");
    expect(tokens.map(row => [row.knownCharge, row.unknown, row.outstanding])).toEqual([[125, false, false], [0, true, false], [250, false, false]]);
    expect(inspection.reservations).toHaveLength(0);
    expect(inspection.events.filter(row => row.kind === "provider.request.dispatched")).toHaveLength(3);
    expect(inspection.events.some(row => row.kind === "budget.admission.fenced")).toBe(false);
    expect(inspection.measurements.find(row => row.metric === "provider-tokens" && row.value === null)?.inputTokens).toBeNull();
    const metrics = captureMetricMission(store, inspection, "offline-T2");
    expect(metrics.identity.revisions[0]?.resourcePolicy).toEqual(prepared.prepared.definition.resourcePolicy);
    expect(metrics.facts.filter(row => row.kind === "resource.metered.settled" && row.data.resource === "tokens")
      .map(row => [row.data.knownCharge, row.data.unknown])).toEqual([[125, false], [0, true], [250, false]]);
    expect(missionCompletionCertificate(inspection, store)).toBeUndefined();
  } finally { await engine?.close(); store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
}, 30000);

test("ordinary uncapped checking forwards finite artifact allowance and rejects absent ticket authority", async () => {
  const sample = preparedFixture();
  const prepared = validatePreparation({ request: sample.request, proposal: meteredProposal(sample) });
  if (prepared.state !== "ready") throw new Error(JSON.stringify(prepared));
  const store = await openFixtureStore(sample.fixture);
  let engine: MissionEngine | undefined;
  const observed: Array<{ allowance: number; reportBytes: number; current: boolean; absent: boolean }> = [];
  try {
    const text = preparedAdmissionText(prepared.prepared);
    const receipt = recordOperatorInput("native-confirmation", "principal", text)!;
    const mission = store.createMission({ repositoryRoot: sample.executionRoot, planId: "durable-fixture", prepared: prepared.prepared,
      commandId: receipt.id, admissionReceiptId: receipt.id, operatorText: text, operatorReceipt: receipt });
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.fixture.base, "sessions"),
      managedWorkspace: { sourceRoot: sample.executionRoot, candidateParent: path.join(sample.fixture.base, "candidates") },
      runRole: async () => ({ instanceId: "offline", role: "developer", status: "completed", result: "Claim only, no SDK disposal.",
        model: { policyId: "developer", requestedModel: "test/child", selectedModel: "test/child" } }) });
    const assess = engine["assessProductionPredicate"];
    engine["assessProductionPredicate"] = async function(inspection, attempt, predicate, artifactHash, allowance) {
      const withoutTickets = { ...inspection, events: inspection.events.filter(row => row.kind !== "resource.metered.admitted") };
      observed.push({ allowance, reportBytes: store.readArtifact(artifactHash).byteLength,
        current: this["artifactAllows"](inspection, attempt.binding.attemptId, 0),
        absent: this["artifactAllows"](withoutTickets, attempt.binding.attemptId, 0) });
      return assess.call(this, inspection, attempt, predicate, artifactHash, allowance);
    };
    engine.start(); await engine.waitForIdle();
    expect(observed.length).toBeGreaterThan(0);
    for (const row of observed) {
      expect(row.current).toBe(true);
      expect(row.absent).toBe(false);
      expect(row.allowance).toBeGreaterThan(0);
      expect(row.allowance + row.reportBytes).toBeLessThanOrEqual(ARTIFACT_OPERATION_BYTES);
    }
    const inspection = store.inspectMission(mission.id);
    expect(inspection.reservations).toHaveLength(0);
    expect(inspection.events.some(row => row.kind === "unit.accepted" || row.kind === "mission.completed")).toBe(false);
  } finally { await engine?.close(); store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
}, 30000);

test("T2 explicit schema 3 cap rejects exposure and records real overage without metered downgrade or schema conversion", async () => {
  const sample = preparedFixture();
  const prepared = validatePreparation({ request: sample.request, proposal: meteredProposal(sample, { activeTimeMs: 600000 }) });
  if (prepared.state !== "ready") throw new Error(JSON.stringify(prepared));
  const store = await openFixtureStore(sample.fixture);
  try {
    const text = preparedAdmissionText(prepared.prepared);
    const receipt = recordOperatorInput("native-confirmation", "principal", text)!;
    const mission = store.createMission({ repositoryRoot: sample.executionRoot, planId: "durable-fixture", prepared: prepared.prepared,
      commandId: receipt.id, admissionReceiptId: receipt.id, operatorText: text, operatorReceipt: receipt });
    const id = randomUUID();
    const reserve = (amount: number) => ({ revision: 1, kind: "reservation.created", causalId: randomUUID(),
      payload: { reservationId: id, revision: 1, resource: "active-time-ms", amount, purpose: "ordinary" } });
    expect(() => store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [reserve(600001)] })).toThrow();
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [reserve(600000)] });
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [
      { revision: 1, kind: "budget.reservation.settled", causalId: randomUUID(), payload: { reservationId: id,
        resource: "active-time-ms", knownCharge: 600001, unknownCharge: 0, released: 0, source: "observed test active clock" } }] });
    const inspection = store.inspectMission(mission.id);
    expect(inspection.reservations[0]?.overage).toBe(1);
    expect(inspection.events.some(row => row.kind === "budget.admission.fenced")).toBe(true);
    expect(() => store.admitRevision({ missionId: mission.id, expectedVersion: inspection.version, receiptId: randomUUID(),
      actor: "operator", impact: [], retained: [], planBytes: nextPlanBytes(inspection.planBytes),
      definitionBytes: Buffer.from(JSON.stringify(sample.proposal.definition)) })).toThrow("revision cannot change executable contract version");
    expect(() => store.appendTransition(mission.id, inspection.version, { events: [{ revision: 1,
      kind: "resource.metered.admitted", causalId: randomUUID(), payload: { ticket: { kind: "metered", ticketId: randomUUID(),
        operationId: randomUUID(), resource: "active-time-ms", revision: 1, ownerEpoch: store.ownerEpoch } } }] })).toThrow();
  } finally { store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
});

test("T2 retained schema 2 bytes, hashes, capped reservations and overages cannot convert to schema 3", async () => {
  const sample = preparedFixture();
  const prepared = validatePreparation({ request: sample.request, proposal: sample.proposal });
  if (prepared.state !== "ready") throw new Error(JSON.stringify(prepared));
  const store = await openFixtureStore(sample.fixture);
  try {
    const text = preparedAdmissionText(prepared.prepared);
    const receipt = recordOperatorInput("native-confirmation", "principal", text)!;
    const mission = store.createMission({ repositoryRoot: sample.executionRoot, planId: "durable-fixture", prepared: prepared.prepared,
      commandId: receipt.id, admissionReceiptId: receipt.id, operatorText: text, operatorReceipt: receipt });
    const bytes = Buffer.from(JSON.stringify(prepared.prepared.definition));
    const before = store.inspectMission(mission.id);
    expect(Object.keys(before.definition)).toEqual(["schemaVersion", "goal", "scope", "nonGoals", "invariants",
      "authority", "budget", "finalization", "units"]);
    expect(before.snapshot.schemaVersion).toBe(2);
    expect(before.snapshot.definitionHash).toBe(sha256(bytes));
    expect(store.readArtifact(before.snapshot.definitionHash)).toEqual(bytes);
    const id = randomUUID();
    store.appendTransition(mission.id, before.version, { events: [{ revision: 1, kind: "reservation.created",
      causalId: randomUUID(), payload: { reservationId: id, revision: 1, resource: "tokens", amount: 10, purpose: "ordinary" } }] });
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{ revision: 1,
      kind: "budget.reservation.settled", causalId: randomUUID(), payload: { reservationId: id, resource: "tokens",
        knownCharge: 12, unknownCharge: 0, released: 0, source: "legacy retained usage" } }] });
    const after = store.inspectMission(mission.id);
    expect(after.reservations[0]).toMatchObject({ grantAmount: 10, knownCharge: 12, overage: 2 });
    expect(after.snapshot.definitionHash).toBe(before.snapshot.definitionHash);
    expect(after.events[0]).toEqual(before.events[0]);
    const converted = meteredProposal(sample);
    expect(() => store.admitRevision({ missionId: mission.id, expectedVersion: after.version, receiptId: randomUUID(),
      actor: "operator", impact: [], retained: [], planBytes: nextPlanBytes(after.planBytes),
      definitionBytes: Buffer.from(JSON.stringify(converted.definition)) })).toThrow("revision cannot change executable contract version");
    expect(store.inspectMission(mission.id).snapshot).toEqual(after.snapshot);
  } finally { store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
});

test("T3 preparation rejects infeasible protected command stages and unsupported timer bounds before readiness", () => {
  for (const [rootMs, commandMs, reason] of [
    [40_000_000, 4_000_001, "protected stage allocation"],
    [40_000_000_000, 2_147_483_648, "2147483647"],
  ] as const) {
    const sample = preparedFixture();
    try {
      const definition = sample.proposal.definition;
      definition.budget.activeTimeMs = rootMs;
      definition.units[0]!.acceptance[0]!.timeoutMs = commandMs;
      const values = { authority: definition.authority, budget: definition.budget };
      bindPreparationAuthority(sample.request, values, recordOperatorInput("native-confirmation", "principal",
        preparationAuthorityText(sample.request, values))!);
      const result = validatePreparation({ request: sample.request, proposal: sample.proposal });
      expect(result.state).not.toBe("ready");
      expect(result.status).toBe("technical-unresolved");
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "insufficient-grant", owner: "author",
        message: expect.stringContaining(reason) }));
      if (process.env.MISSION_TIME_EVIDENCE) {
        mkdirSync(process.env.MISSION_TIME_EVIDENCE, { recursive: true });
        writeFileSync(path.join(process.env.MISSION_TIME_EVIDENCE, `preparation-${commandMs}.json`), JSON.stringify(result, null, 2));
      }
    } finally { rmSync(sample.fixture.base, { recursive: true, force: true }); }
  }
});

const allocation: SetupAllocation = { effectProfile: "execution-root-local-v1", writableDirectories: ["node_modules"],
  activeTimeMs: 10000, artifactBytes: 1024 * 1024 };
function approveSetup(request: Parameters<typeof preparationSetupText>[0]) {
  const text = preparationSetupText(request, allocation);
  bindPreparationSetup(request, allocation, recordOperatorInput("native-confirmation", "principal", text)!);
}
async function copiedMission(script: string, values: SetupAllocation,
  recovery?: { runRole: MissionRoleRunner; userConfigPath: string }) {
  const sample = preparedFixture(script, recovery?.userConfigPath);
  rmSync(path.join(sample.executionRoot, "node_modules"), { recursive: true });
  const seed = path.join(sample.fixture.base, "seed");
  mkdirSync(seed);
  writeFileSync(path.join(seed, "seed"), "1");
  values = { ...values, copy: { ...values.copy!, seeds: [{ source: seed, destination: "node_modules",
    bounds: { paths: 2, largestFileBytes: 1, totalBytes: 1 } }] } };
  const definition = sample.proposal.definition;
  if (recovery) {
    definition.authority.resumeAfterClose = true;
    for (const unit of definition.units) for (const predicate of unit.acceptance) {
      predicate.command = "grep -q recovered input.mjs && test \"$(cat node_modules/dependency)\" = installed";
      predicate.target = "result";
      predicate.expected = "0";
    }
  }
  definition.budget = { ...definition.budget, roleLaunches: 100, providerRequests: 100, artifactBytes: 8000000000 };
  const authority = { authority: definition.authority, budget: definition.budget };
  bindPreparationAuthority(sample.request, authority,
    recordOperatorInput("native-confirmation", "principal", preparationAuthorityText(sample.request, authority))!);
  bindPreparationSetup(sample.request, values,
    recordOperatorInput("native-confirmation", "principal", preparationSetupText(sample.request, values))!);
  const result = validatePreparation({ request: sample.request, proposal: sample.proposal });
  if (result.state !== "ready") throw new Error(JSON.stringify(result.issues));
  const store = await openFixtureStore(sample.fixture);
  const text = preparedAdmissionText(result.prepared);
  const receipt = recordOperatorInput("native-confirmation", "principal", text)!;
  const mission = store.createMission({ repositoryRoot: sample.executionRoot, planId: "durable-fixture", prepared: result.prepared,
    commandId: receipt.id, admissionReceiptId: receipt.id, operatorText: text, operatorReceipt: receipt });
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.fixture.base, "sessions"),
    managedWorkspace: recovery ? { sourceRoot: sample.executionRoot,
      candidateParent: path.join(sample.fixture.base, "candidates") } : undefined,
    runRole: recovery?.runRole ?? (async () => { throw new Error("prepare must not dispatch"); }) });
  return { ...sample, store, mission, engine, destination: result.prepared.setup!.identity.copy!.destination };
}

test("copied lifecycle recovery observes fresh backing and historical contribution without replaying setup", async () => {
  const providerFixture = createMissionFixture("pitako-copied-recovery-provider-");
  const agentDir = path.join(providerFixture.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, '[model_policies.developer]\nprimary = { model = "pitako-mission-local/fixture", reasoning = "off", fast = false }\n[model_policies.reviewer]\nprimary = { model = "pitako-mission-local/fixture", reasoning = "off", fast = false }\n');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let ready!: () => void;
  const written = new Promise<void>(resolve => { ready = resolve; });
  let initialRequest = true;
  const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: () => "copied recovery result",
    responseGate: async (_prompt, signal) => {
      if (!initialRequest) return;
      initialRequest = false;
      ready();
      if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
    errorForRequest: (_prompt, _model, _afterTool, signal) => signal?.aborted ? "owned lifecycle interruption" : undefined,
  });
  const runner = createPiMissionRunner({ cwd: providerFixture.root, executor: createPiExecutor(),
    load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
  const sample = await copiedMission("printf installed > node_modules/dependency\n", {
    effectProfile: "execution-root-local-copy-v1", writableDirectories: ["node_modules"],
    activeTimeMs: 15000, artifactBytes: 600000000,
    copy: { bounds: { paths: 20, largestFileBytes: 100, totalBytes: 100 }, seeds: [] },
  }, { userConfigPath: config,
    runRole: async (input, durable) => {
    const write = await durable.effects!.invoke("write", { path: "input.mjs", content: "recovered\n", timeoutMs: 10000 });
    expect(write.status, JSON.stringify(write)).toBe("completed");
    return runner(input, durable);
  } });
  let engine = sample.engine;
  let store = sample.store;
  const request = PhysicalObservation.prototype.request;
  const operations: string[] = [];
  try {
    expect((await engine.prepareSetup(() => {})).state).toBe("ready");
    await engine.start();
    await Promise.race([written, engine.waitForIdle().then(() => {
      throw new Error(`copied producer stopped before write: ${JSON.stringify(store.inspectMission(sample.mission.id).events.slice(-8))}`);
    })]);
    await engine.retireForShutdown("quit");
    store = await openFixtureStore(sample.fixture);
    PhysicalObservation.prototype.request = async function<T>(operation: string, input: unknown,
      signal?: AbortSignal, deadline?: number): Promise<T> {
      operations.push(operation);
      return (request<T>).call(this, operation, input, signal, deadline);
    };
    let checkedRoot = "";
    engine = new MissionEngine({ store, missionId: sample.mission.id,
      sessionsDirectory: path.join(sample.fixture.base, "sessions"),
      managedWorkspace: { sourceRoot: sample.executionRoot, candidateParent: path.join(sample.fixture.base, "candidates") },
      runRole: async (input, durable) => {
        if (checkedRoot) {
          if (!durable.signal!.aborted) await new Promise<void>(resolve =>
            durable.signal!.addEventListener("abort", () => resolve(), { once: true }));
          return runner(input, durable);
        }
        checkedRoot = durable.cwd!;
        const check = await durable.effects!.invoke("bash", {
          command: "grep -q recovered input.mjs && test \"$(cat node_modules/dependency)\" = installed && printf COPIED_RECOVERED",
          timeoutMs: 10000,
        });
        expect(check.status).toBe("completed");
        return runner(input, durable);
      } });
    await engine.control("resume", { id: "copied-recovery-resume", text: "/mission resume durable-fixture" });
    const deadline = Date.now() + 90000;
    while (engine.snapshot().units["t1"]?.status !== "accepted") {
      if (engine.snapshot().units["t1"]?.status === "blocked" || Date.now() > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const inspection = store.inspectMission(sample.mission.id);
    const out = process.env.MISSION_SETUP_EVIDENCE;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "copied-recovery.json"), JSON.stringify({ operations, inspection }, null, 2));
    }
    expect(operations).toContain("historicalContribution");
    expect(operations).toContain("setupReadiness");
    expect(engine.snapshot().units[inspection.definition.units[0]!.id]!.status).toBe("accepted");
    expect(readFileSync(path.join(checkedRoot, "input.mjs"), "utf8")).toBe("recovered\n");
    expect(readFileSync(path.join(sample.destination, "published/node_modules/dependency"), "utf8")).toBe("installed");
    expect(existsSync(path.join(sample.executionRoot, "node_modules"))).toBe(false);
    expect(inspection.events.filter(row => row.kind === "mission.setup.intent")).toHaveLength(1);
    expect(auditCompletionEvidence(inspection.events, store, inspection).effects).toEqual([]);
  } finally {
    PhysicalObservation.prototype.request = request;
    await engine.retireForShutdown("quit");
    store.close();
    rmSync(sample.destination, { recursive: true, force: true });
    rmSync(sample.fixture.base, { recursive: true, force: true });
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(providerFixture.base, { recursive: true, force: true });
  }
}, 120000);

test("copied setup refuses excess output without enlarging bounds, publishing or claiming readiness", async () => {
  const values: SetupAllocation = { effectProfile: "execution-root-local-copy-v1", writableDirectories: ["node_modules"],
    activeTimeMs: 15000, artifactBytes: 600000000, copy: { bounds: { paths: 10, largestFileBytes: 4, totalBytes: 4 }, seeds: [] } };
  const sample = await copiedMission("printf installed > node_modules/dependency\n", values);
  try {
    expect((await sample.engine.prepareSetup(() => {})).state).toBe("blocked");
    const events = sample.store.inspectMission(sample.mission.id).events;
    const receipt = events.find(({ kind }) => kind === "mission.setup.receipt")!;
    const proof = JSON.parse(sample.store.readArtifact(String(receipt.payload.receiptHash)).toString());
    expect(proof).toMatchObject({ format: "mission-setup-receipt-v2", status: "failed", disposed: true, exitCode: 0 });
    expect(proof.copy.bounds).toEqual(values.copy!.bounds);
    expect(proof.outputError).toContain("byte bound exceeded");
    expect(existsSync(path.join(sample.destination, "published/node_modules"))).toBe(false);
    expect(existsSync(path.join(sample.executionRoot, "node_modules"))).toBe(false);
    expect((await sample.engine.prepareSetup(() => {})).state).toBe("blocked");
    expect(sample.store.inspectMission(sample.mission.id).events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
    await expect(sample.engine.start()).rejects.toThrow("current settled");
  } finally {
    await sample.engine.retireForShutdown("quit");
    sample.store.close();
    rmSync(sample.destination, { recursive: true, force: true });
    rmSync(sample.fixture.base, { recursive: true, force: true });
  }
}, 60000);

test("cancel before start fences copied setup; cancellation is not cleanup or successful preparation proof", async () => {
  const sample = await copiedMission("printf begun > node_modules/dependency\nwhile :; do :; done\n", {
    effectProfile: "execution-root-local-copy-v1", writableDirectories: ["node_modules"], activeTimeMs: 15000,
    artifactBytes: 600000000, copy: { bounds: { paths: 20, largestFileBytes: 100, totalBytes: 100 }, seeds: [] },
  });
  const job = sample.engine.prepareSetup(() => {});
  try {
    for (let turn = 0; turn < 1000 && !existsSync(path.join(sample.destination, "capsule/node_modules/dependency")); turn++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFileSync(path.join(sample.destination, "capsule/node_modules/dependency"), "utf8")).toBe("begun");
    await sample.engine.control("cancel");
    const cancelled = sample.store.inspectMission(sample.mission.id);
    expect(cancelled.state).toBe("cancelled");
    expect(missionCompletionCertificate(cancelled, sample.store)).toBeUndefined();
    expect((await job).state).toBe("blocked");
    const producer = new MissionSetup(sample.store, sample.mission.id);
    expect(producer.quiescent).toBe(true);
    expect((await producer.refresh()).state).toBe("blocked");
    expect(existsSync(path.join(sample.destination, "published/node_modules"))).toBe(false);
    const stopped = sample.store.inspectMission(sample.mission.id);
    expect(stopped.events.some(({ kind }) => kind === "mission.activated" || kind === "attempt.reserved")).toBe(false);
    const receipt = stopped.events.find(({ kind }) => kind === "mission.setup.receipt")!;
    expect(JSON.parse(sample.store.readArtifact(String(receipt.payload.receiptHash)).toString()))
      .toMatchObject({ format: "mission-setup-receipt-v2", status: "stopped", disposed: true });
    expect(() => sample.engine.start()).toThrow("cancelled");
  } finally {
    await sample.engine.retireForShutdown("quit");
    await job;
    sample.store.close();
    rmSync(sample.destination, { recursive: true, force: true });
    rmSync(sample.fixture.base, { recursive: true, force: true });
  }
}, 60000);

async function setupMission(script: string | undefined, kind: "implementation" | "check" = "implementation", metered = false) {
  const sample = preparedFixture(script);
  for (const unit of sample.proposal.definition.units) unit.kind = kind;
  if (script === undefined) {
    mkdirSync(path.join(sample.executionRoot, "node_modules"));
    writeFileSync(path.join(sample.executionRoot, "node_modules/dependency"), "preexisting");
  }
  approveSetup(sample.request);
  const prepared = validatePreparation({ request: sample.request, proposal: metered ? meteredProposal(sample) : sample.proposal });
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

test("T2 finite setup bounds stay technical while actual setup time and storage are metered without reservations", async () => {
  const sample = await setupMission("printf installed > node_modules/dependency\n", "implementation", true);
  try {
    const result = await sample.producer.ensure(sample.start(), () => true);
    expect(result.state).toBe("ready");
    const inspection = sample.store.inspectMission(sample.mission.id);
    expect(inspection.reservations).toHaveLength(0);
    const usage = meteredConsumptions(inspection.events);
    expect(usage.map(row => row.resource).sort()).toEqual(["active-time-ms", "artifact-bytes"]);
    expect(usage.every(row => row.knownCharge > 1 && !row.unknown && !row.outstanding)).toBe(true);
    expect(sample.producer.quiescent).toBe(true);
    expect(await sample.producer.ensure(sample.start(), () => true)).toMatchObject({ state: "ready", reused: true });
    expect(missionCompletionCertificate(inspection, sample.store)).toBeUndefined();
  } finally { await sample.producer.stop(); sample.store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
}, 30000);

test("active-time checkpoints do not hydrate setup proof or authorize work without it", async () => {
  const sample = await setupMission(undefined);
  const { store, mission } = sample;
  const reservationId = crypto.randomUUID();
  const windowId = crypto.randomUUID();
  const preparedHash = mission.snapshot.preparedHash!;
  const object = path.join(sample.fixture.objectDir, preparedHash.slice(0, 2), preparedHash);
  const bytes = readFileSync(object);
  try {
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [
      { revision: 1, kind: "reservation.created", causalId: crypto.randomUUID(), payload: {
        reservationId, resource: "active-time-ms", amount: 1000, purpose: "ordinary", phase: "active",
        expiresAt: "2099-01-01T00:00:00.000Z",
      } },
      { revision: 1, kind: "mission.active.window.opened", causalId: crypto.randomUUID(), payload: {
        windowId, reservationId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch,
      } },
    ] });
    writeFileSync(object, "corrupt prepared proof");
    const charge = (durationMs: number, selectedWindow = windowId) => [
      { revision: 1, kind: "budget.reservation.settled", causalId: crypto.randomUUID(), payload: {
        reservationId, resource: "active-time-ms", knownCharge: durationMs, unknownCharge: 0, released: 0,
      } },
      { revision: 1, kind: "mission.active.window.checkpointed", causalId: crypto.randomUUID(), payload: {
        windowId: selectedWindow, reservationId, durationMs, cumulativeKnownMs: durationMs, measured: true,
      } },
    ];
    const before = store.readActiveTimeAccounting(mission.id);
    expect(() => store.appendTransition(mission.id, before.version, { events: charge(10, crypto.randomUUID()) }))
      .toThrow(/current owned window/);
    expect(() => store.appendTransition(mission.id, before.version, { events: charge(1000) }))
      .toThrow(/current owned window/);
    const recorded = store.appendTransition(mission.id, before.version, { events: charge(10) });
    expect(recorded.map(({ kind }) => kind)).toEqual(["budget.reservation.settled", "mission.active.window.checkpointed"]);
    const after = store.readActiveTimeAccounting(mission.id);
    expect(after.reservations.find(({ id }) => id === reservationId)).toMatchObject({
      grantAmount: 1000, knownCharge: 10, unknownCharge: 0, released: 0, remainingHold: 990,
    });
    expect(() => store.appendTransition(mission.id, before.version, { events: charge(20) })).toThrow(/version conflict/);
    expect(() => store.inspectMission(mission.id)).toThrow(/SHA-256 check/);
    expect(() => store.appendTransition(mission.id, after.version, { events: [
      { revision: 1, kind: "mission.input.visible", causalId: crypto.randomUUID(), payload: {} },
    ] })).toThrow(/SHA-256 check/);
    expect(store.readActiveTimeAccounting(mission.id).version).toBe(after.version);
    writeFileSync(object, bytes);
    expect(store.inspectMission(mission.id).snapshot.preparedHash).toBe(preparedHash);
  } finally {
    writeFileSync(object, bytes);
    store.close();
    rmSync(sample.fixture.base, { recursive: true, force: true });
  }
});

test("reserved worker brief retains setup instructions and proof reference, not the host manifest", async () => {
  const sample = await setupMission(undefined, "check");
  const delivered: string[] = [];
  const engine = new MissionEngine({
    store: sample.store, missionId: sample.mission.id,
    sessionsDirectory: path.join(sample.fixture.base, "sessions"),
    runRole: async ({ brief }) => {
      delivered.push(brief);
      throw new Error("fixture stops after observing the reserved brief; no provider request");
    },
  });
  try {
    engine.start();
    await engine.waitForIdle();
    expect(delivered.length).toBeGreaterThan(0);
    const inspection = sample.store.inspectMission(sample.mission.id);
    const binding = inspection.events.find(({ kind }) => kind === "attempt.reserved")!.payload.binding as {
      briefArtifactHash: string; briefHash: string;
    };
    expect(sample.store.readArtifact(binding.briefArtifactHash).toString()).toBe(delivered[0]!);
    expect(sha256(Buffer.from(JSON.stringify(delivered[0]!)))).toBe(binding.briefHash);
    const contextLine = delivered[0]!.split("\n").find((line) => line.startsWith("Original frozen source and procedure: "))!;
    const context = JSON.parse(contextLine.slice("Original frozen source and procedure: ".length));
    expect(context.setup.preparedHash).toBe(inspection.snapshot.preparedHash);
    expect(context.setup.requiredBy).toEqual(inspection.prepared!.setup!.requiredBy);
    expect(context.setup.readiness.state).toBe("missing-script");
    expect(context.setup.instruction).toContain("Setup is host-owned");
    expect(context.setup.instruction).toContain("Do not repeat installation");
    expect(context.setup.contract).toBeUndefined();
    expect(context.source).toBe(inspection.prepared!.originalSource);
    expect(context.gates).toEqual(inspection.prepared!.gates);
    expect(JSON.stringify(context.setup).length).toBeLessThan(2000);
  } finally {
    await engine.close();
    sample.store.close();
    rmSync(sample.fixture.base, { recursive: true, force: true });
  }
}, 30000);

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
    expect((await sample.producer.refresh()).state).toBe("blocked");
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
    const workspace = await createMissionWorkspace({ missionId: sample.mission.id, attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceRoot: sample.executionRoot, storeRoot: sample.store.storageRoot, candidateParent: path.join(sample.fixture.base, "candidates") });
    await preflightContainment(workspace);
    const child = spawnContained(workspace, "bash", ["-c", "test \"$(cat node_modules/dependency)\" = installed && ! (printf bad > node_modules/dependency)"], { writablePaths: [] });
    child.stdin!.end();
    child.stdout!.resume(); child.stderr!.resume();
    const code = await new Promise((resolve) => child.once("close", resolve));
    expect(code).toBe(0);
    writeFileSync(path.join(sample.executionRoot, "node_modules/dependency"), "changed");
    expect((await sample.producer.refresh()).state).toBe("blocked");
    writeFileSync(path.join(sample.executionRoot, "node_modules/dependency"), "installed");
    expect((await sample.producer.refresh()).state).toBe("ready");
    for (const filename of ["bun.lock", "GATES.md"]) {
      writeFileSync(path.join(sample.executionRoot, filename), "changed recipe");
      expect((await sample.producer.refresh()).state).toBe("blocked");
      rmSync(path.join(sample.executionRoot, filename));
      expect((await sample.producer.refresh()).state).toBe("ready");
    }
    writeFileSync(path.join(sample.executionRoot, "helper.sh"), "changed recipe");
    expect((await sample.producer.refresh()).state).toBe("blocked");
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
    const deadline = performance.now() + 10_000;
    while (!sample.store.inspectMission(sample.mission.id).events.some(({ kind }) => kind === "mission.setup.invoking")) {
      if (performance.now() >= deadline) throw new Error("setup did not reach the namespace admission boundary");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
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
    expect((await sample.producer.refresh()).state).toBe("missing-script");
    expect((await sample.producer.ensure({ id: "unarmed" }, () => true)).state).toBe("missing-script");
    expect(sample.store.inspectMission(sample.mission.id).events.some(({ kind }) => kind === "mission.setup.intent")).toBe(false);
    const workspace = await createMissionWorkspace({ missionId: sample.mission.id, attemptId: crypto.randomUUID(),
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
    expect((await sample.producer.refresh()).state).toBe("blocked");
    expect(sample.producer.quiescent).toBe(true);
  } finally { sample.store.close(); rmSync(sample.fixture.base, { recursive: true, force: true }); }
}, 30000);

test("actual producer crash leaves durable invocation; physical recovery stops it without replay or success", async () => {
  const evidence = path.join(tmpdir(), `pitako-setup-interrupt-${crypto.randomUUID()}`);
  const child = spawn(process.execPath, [path.resolve("scripts/mission-setup-local.mjs"), evidence, "--interrupt"],
    { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr!.on("data", (data) => { errors = (errors + data).slice(0, 16384); });
  const code = await new Promise((resolve) => child.once("close", resolve));
  expect(code, errors).toBe(74);
  const interrupted = JSON.parse(readFileSync(path.join(evidence, "interrupted.json"), "utf8"));
  const store = await openFixtureStore(interrupted.fixture);
  let recoveredQuiescent = false;
  try {
    for (let turn = 0; turn < 200 && processesInNamespace(interrupted.process.namespace).length; turn++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(processesInNamespace(interrupted.process.namespace)).toHaveLength(0);
    const producer = new MissionSetup(store, interrupted.missionId);
    expect(producer.quiescent).toBe(false);
    expect((await producer.reconcile()).state).toBe("blocked");
    expect(producer.quiescent).toBe(true);
    recoveredQuiescent = true;
    expect((await producer.ensure({ id: "fake" }, () => true)).state).toBe("blocked");
    const events = store.inspectMission(interrupted.missionId).events;
    expect(events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
    expect(events.filter(({ kind }) => kind === "mission.setup.receipt")).toHaveLength(0);
    expect(events.filter(({ kind }) => kind === "mission.setup.reconciled")).toHaveLength(1);
    if (process.env.MISSION_T4_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T4_ARTIFACT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_T4_ARTIFACT_DIR, "setup-crash-recovery.json"), JSON.stringify({
        childExit: code, interrupted, namespaceProcesses: processesInNamespace(interrupted.process.namespace),
        quiescent: producer.quiescent, events,
      }, null, 2));
    }
  } finally {
    store.close();
    if (recoveredQuiescent) {
      rmSync(interrupted.fixture.base, { recursive: true, force: true });
      rmSync(evidence, { recursive: true, force: true });
    }
  }
}, 30000);

test("copied prepare interruption recovers owned processes without replay, publication or false readiness", async () => {
  const evidence = path.join(tmpdir(), `pitako-copy-interrupt-${crypto.randomUUID()}`);
  const child = spawn(process.execPath, [path.resolve("scripts/mission-setup-local.mjs"), evidence, "--copy-interrupt"],
    { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr!.on("data", (data) => { errors = (errors + data).slice(0, 16384); });
  const code = await new Promise((resolve) => child.once("close", resolve));
  expect(code, errors).toBe(74);
  const interrupted = JSON.parse(readFileSync(path.join(evidence, "interrupted.json"), "utf8"));
  const store = await openFixtureStore(interrupted.fixture);
  let recoveredQuiescent = false;
  try {
    for (let turn = 0; turn < 200 && processesInNamespace(interrupted.process.namespace).length; turn++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(processesInNamespace(interrupted.process.namespace)).toHaveLength(0);
    const producer = new MissionSetup(store, interrupted.missionId);
    expect(producer.quiescent).toBe(false);
    expect((await producer.reconcile()).state).toBe("blocked");
    expect(producer.quiescent).toBe(true);
    recoveredQuiescent = true;
    const engine = new MissionEngine({ store, missionId: interrupted.missionId,
      sessionsDirectory: path.join(interrupted.fixture.base, "sessions"), runRole: async () => { throw new Error("no dispatch"); } });
    expect((await engine.prepareSetup(() => {})).state).toBe("blocked");
    await expect(engine.start()).rejects.toThrow("current settled");
    const current = store.inspectMission(interrupted.missionId);
    expect(current.state).toBe("prepared");
    expect(current.events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
    expect(current.events.filter(({ kind }) => kind === "mission.setup.receipt")).toHaveLength(0);
    expect(current.events.filter(({ kind }) => kind === "mission.setup.reconciled")).toHaveLength(1);
    expect(existsSync(path.join(interrupted.destination, "published/node_modules"))).toBe(false);
    expect(current.events.some(({ kind }) => kind === "mission.activated" || kind === "attempt.reserved")).toBe(false);
    if (process.env.MISSION_T4_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T4_ARTIFACT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_T4_ARTIFACT_DIR, "copied-setup-recovery.json"), JSON.stringify({
        childExit: code, interrupted, setup: current.prepared?.setup,
        namespaceProcesses: processesInNamespace(interrupted.process.namespace),
        quiescent: producer.quiescent, state: current.state, events: current.events,
        published: existsSync(path.join(interrupted.destination, "published/node_modules")),
      }, null, 2));
    }
    await engine.retireForShutdown("quit");
  } finally {
    store.close();
    if (recoveredQuiescent) {
      rmSync(interrupted.fixture.base, { recursive: true, force: true });
      rmSync(interrupted.destination, { recursive: true, force: true });
      rmSync(evidence, { recursive: true, force: true });
    }
  }
}, 60000);

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
    expect((await reopened.refresh()).state).toBe("blocked");
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
    expect(result.status).toBe("technical-unresolved");
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "unsupported-observer", owner: "author" }));
    const budget = structuredClone(proposal);
    budget.definition.budget.roleLaunches = 1;
    const blocked = validatePreparation({ request, proposal: budget });
    expect(blocked.state).toBe("needs-input");
    expect(blocked.status).toBe("technical-unresolved");
    expect(blocked.issues).toContainEqual(expect.objectContaining({ code: "insufficient-grant", owner: "author" }));
  } finally { rmSync(fixture.base, { recursive: true, force: true }); }
});
