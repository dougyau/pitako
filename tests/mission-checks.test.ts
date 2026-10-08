import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync, symlinkSync, linkSync, unlinkSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { assessMissionPredicate } from "../extensions/mission/checks.ts";
import { sha256 } from "../extensions/mission/model.ts";
import { createMissionFixture, fixtureCommandTime, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { rmSync } from "node:fs";
import path from "node:path";
import { assertCompleteWorkspaceImage, sealWorkspaceImage } from "../extensions/mission/reconcile.ts";
import { captureWorkspaceImage, createMissionWorkspace, filterWorkspaceImage, ownerProcessState, preflightContainment } from "../extensions/mission/workspace.ts";
import { MissionEffects } from "../extensions/mission/effects.ts";
import { validateMissionDefinitionBytes } from "../extensions/mission/model.ts";
import { missionDefinition } from "./mission-fixtures.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";
import { importNestedEvidence, physicalIdentity } from "../extensions/mission/nested-verification.ts";

test.each(["capture", "snapshot"] as const)(
  "production checker rejects success when post-exit %s exhausts the invocation deadline", async (phase) => {
  const fixture = createMissionFixture();
  const store = await openFixtureStore(fixture);
  let effects: MissionEffects | undefined;
  try {
    const mission = store.createMission(missionInput(fixture));
    const workspace = createMissionWorkspace({ missionId: mission.id, attemptId: randomUUID(), sourceRoot: fixture.root,
      storeRoot: store.storageRoot, candidateParent: path.join(fixture.base, "candidates"), allowedPaths: ["."] });
    await preflightContainment(workspace);
    const sealed = sealWorkspaceImage(captureWorkspaceImage(workspace.candidateRoot));
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{
      revision: 1, kind: "mission.input.visible", causalId: randomUUID(), payload: {},
    }], artifacts: sealed.artifacts });
    const candidateRoot = workspace.candidateRoot;
    let delayed = false;
    let postExitReads = 0;
    Object.defineProperty(workspace, "candidateRoot", { get() {
      const registered = store.inspectMission(mission.id).events.find(row => row.kind === "effect.process.registered");
      const identity = registered?.payload.identity as Parameters<typeof ownerProcessState>[0] | undefined;
      if (identity && ownerProcessState(identity) === "dead") postExitReads++;
      if (!delayed && postExitReads === (phase === "capture" ? 1 : 2)) {
        delayed = true;
        const until = performance.now() + 2100;
        while (performance.now() < until) { /* bounded post-exit host capture cost */ }
      }
      return candidateRoot;
    } });
    effects = new MissionEffects({ store, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!, allowedOperations: ["bash"],
      commandTime: fixtureCommandTime(10000) });
    const observation = await assessMissionPredicate({ predicate: { id: "expiry", kind: "command_exit", target: "result",
      command: "printf CHILD_EXIT_ZERO", expected: "0", timeoutMs: 2000 },
      subject: { kind: "workspace", imageHash: sealed.imageHash } },
      { store, effects, inputBindingHash: "a".repeat(64), scopeEstablished: true, timeoutLimitMs: 10000 });
    const proof = JSON.parse(Buffer.from(observation.artifactBytes!).toString());
    expect(delayed).toBe(true);
    expect(proof.receipt.stdout).toBe("CHILD_EXIT_ZERO");
    expect(proof.receipt.process).toMatchObject({ descendantsQuiescent: true, namespaceEmptyAfterExit: true });
    expect(observation.verdict).toBe("inconclusive");
    expect(proof.receipt).toMatchObject({ status: "failed", exitCode: 124, termination: "timeout" });
    expect(effects.quiescent).toBe(true);
    if (process.env.MISSION_TIME_EVIDENCE) {
      mkdirSync(process.env.MISSION_TIME_EVIDENCE, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_TIME_EVIDENCE, `post-exit-${phase}-expiry.json`),
        JSON.stringify({ observation, proof, events: store.inspectMission(mission.id).events }, null, 2));
    }
  } finally { await effects?.shutdown(); store.close(); rmSync(fixture.base, { recursive: true, force: true }); }
}, 15000);

test("ordinary production checker cannot admit nested bubblewrap", async () => {
  const fixture = createMissionFixture();
  const store = await openFixtureStore(fixture);
  let effects: MissionEffects | undefined;
  try {
    const mission = store.createMission(missionInput(fixture));
    const workspace = createMissionWorkspace({ missionId: mission.id, attemptId: randomUUID(), sourceRoot: fixture.root,
      storeRoot: store.storageRoot, candidateParent: path.join(fixture.base, "candidates"), allowedPaths: ["."] });
    await preflightContainment(workspace);
    const sealed = sealWorkspaceImage(captureWorkspaceImage(workspace.candidateRoot));
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{
      revision: 1, kind: "mission.input.visible", causalId: randomUUID(), payload: {},
    }], artifacts: sealed.artifacts });
    effects = new MissionEffects({ store, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!, allowedOperations: ["bash"],
      commandTime: fixtureCommandTime() });
    expect(() => effects!.enableNestedVerification({ profile: "sealed-nested-verification-v1" })).toThrow(/checker-only/);
    const absent = await assessMissionPredicate({ predicate: { id: "nested", kind: "command_exit", target: "result",
      command: "exit 0", expected: "0", timeoutMs: 10000, profile: "sealed-nested-verification-v1" },
      subject: { kind: "workspace", imageHash: sealed.imageHash } },
      { store, effects, inputBindingHash: "a".repeat(64), scopeEstablished: true, timeoutLimitMs: 15000, artifactLimitBytes: 10000000 });
    expect(absent.verdict).toBe("inconclusive");
    expect(absent.method).toMatch(/explicit native/);
    expect(store.inspectMission(mission.id).events.some(({ kind }) => kind === "effect.invoking")).toBe(false);
    const observation = await assessMissionPredicate({ predicate: { id: "nested", kind: "command_exit", target: "result",
      command: "/usr/bin/bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc -- /bin/true",
      expected: "0", timeoutMs: 10000 }, subject: { kind: "workspace", imageHash: sealed.imageHash } },
      { store, effects, inputBindingHash: "a".repeat(64), scopeEstablished: true, timeoutLimitMs: 15000 });
    expect(observation.verdict).toBe("inconclusive");
    const proof = JSON.parse(Buffer.from(observation.artifactBytes!).toString());
    expect(proof.receipt.termination).toBe("exit");
    expect(proof.receipt.exitCode).not.toBe(0);
    expect(proof.receipt.stderr).toMatch(/namespace|Operation not permitted/);
    expect(effects.quiescent).toBe(true);
  } finally { await effects?.shutdown(); store.close(); rmSync(fixture.base, { recursive: true, force: true }); }
}, 30000);

test("explicit completion contract cannot opt out of whole review; legacy bytes stay legacy", () => {
  const definition = missionDefinition();
  definition.finalization.independentReview = false;
  const legacy = Buffer.from(JSON.stringify(definition));
  expect(validateMissionDefinitionBytes(legacy).definition.finalization.contractVersion).toBeUndefined();
  definition.finalization.contractVersion = 1;
  expect(() => validateMissionDefinitionBytes(Buffer.from(JSON.stringify(definition)))).toThrow(/whole-result independent review/);
});

test("verification selector is closed and omission preserves legacy definition bytes", () => {
  const definition = missionDefinition();
  const bytes = Buffer.from(JSON.stringify(definition));
  const parsed = validateMissionDefinitionBytes(bytes);
  expect(parsed.hash).toBe(sha256(bytes));
  expect(parsed.definition.authority.verificationProfiles).toBeUndefined();
  expect(parsed.definition.units[0]!.acceptance[0]!.profile).toBeUndefined();
  const candidate = { ...definition, units: definition.units.map((unit) => ({ ...unit,
    acceptance: unit.acceptance.map((predicate) => ({ ...predicate, profile: "host-shell" })) })) };
  expect(() => validateMissionDefinitionBytes(Buffer.from(JSON.stringify(candidate)))).toThrow(/unsupported command verification profile/);
});

test("owned evidence import binds bytes and rejects links, special files, changed roots and exhausted grants", () => {
  const fixture = createMissionFixture();
  try {
    const root = path.join(fixture.base, "exports");
    const evidence = path.join(root, "evidence");
    mkdirSync(evidence, { recursive: true }); mkdirSync(path.join(root, "scratch"));
    const capsule = { root, identity: physicalIdentity(root), scratchIdentity: physicalIdentity(path.join(root, "scratch")),
      evidenceIdentity: physicalIdentity(evidence), closure: [], closureHash: sha256(Buffer.from("[]")), closureBytes: 0, artifactBytes: 4096 };
    writeFileSync(path.join(evidence, "raw"), "owned");
    const imported = importNestedEvidence(capsule, 5);
    expect(imported.manifest[0]).toMatchObject({ path: "raw", size: 5, hash: sha256(Buffer.from("owned")) });
    expect(Buffer.from(imported.artifacts[0]!.bytes).toString()).toBe("owned");
    expect(() => importNestedEvidence({ ...capsule, artifactBytes: 5 }, 5)).toThrow(/grant exhausted/);
    symlinkSync(fixture.root, path.join(evidence, "escape"));
    expect(() => importNestedEvidence(capsule, 5)).toThrow(/link/);
    unlinkSync(path.join(evidence, "escape"));
    linkSync(path.join(evidence, "raw"), path.join(evidence, "alias"));
    expect(() => importNestedEvidence(capsule, 5)).toThrow(/aliased/);
    unlinkSync(path.join(evidence, "alias"));
    execFileSync("/usr/bin/mkfifo", [path.join(evidence, "fifo")]);
    expect(() => importNestedEvidence(capsule, 5)).toThrow(/special/);
    unlinkSync(path.join(evidence, "fifo"));
    renameSync(evidence, `${evidence}-old`); mkdirSync(evidence);
    expect(() => importNestedEvidence(capsule, 5)).toThrow(/identity changed/);
  } finally { rmSync(fixture.base, { recursive: true, force: true }); }
});

test("unreceipted actor cannot turn matching worker text into production acceptance", async () => {
  const fixture = createMissionFixture();
  const definition = missionDefinition();
  definition.finalization.contractVersion = 1;
  definition.budget.roleLaunches = 4;
  // Ordinary request + Ponytail's two requests + cleanup + whole-result review.
  definition.budget.providerRequests = 5;
  definition.budget.artifactBytes = 3_000_000;
  definition.units[0]!.role = "reviewer";
  definition.units[0]!.acceptance[0] = { id: "snapshot-present", kind: "artifact_hash", target: "result", expected: sha256(Buffer.from("PASS")) };
  definition.authority.rolePolicies.reviewer = definition.authority.rolePolicies.developer!;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  let engine: MissionEngine | undefined;
  try {
    const mission = store.createMission(missionInput(fixture));
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
      managedWorkspace: { sourceRoot: fixture.root }, runRole: async () => ({ instanceId: "uncertain", role: "reviewer", status: "completed",
        model: { selectedModel: "fixture/local" }, result: "PASS" }) });
    engine.start(); await engine.waitForIdle();
    const journal = store.inspectMission(mission.id).events;
    expect(journal.find((event) => event.kind === "evidence.recorded")?.payload.verdict).toBe("inconclusive");
    expect(journal.some((event) => event.kind === "unit.accepted" || event.kind === "mission.result.integrated")).toBe(false);
  } finally { await engine?.retireForShutdown("quit"); store.close(); rmSync(fixture.base, { recursive: true, force: true }); }
});

test("production checker binds immutable result bytes, not worker PASS or manual evidence", async () => {
  const fixture = createMissionFixture();
  const store = await openFixtureStore(fixture);
  try {
    const mission = store.createMission(missionInput(fixture));
    const bytes = Buffer.from("FAIL");
    const artifactHash = sha256(bytes);
    store.appendTransition(mission.id, mission.version, { events: [{ revision: 1, kind: "mission.input.visible", causalId: randomUUID(), payload: {} }], artifacts: [{ bytes, mediaType: "text/plain" }] });
    const subject = { kind: "artifact" as const, artifactHash };
    const context = { store, inputBindingHash: "a".repeat(64), scopeEstablished: true };
    const assess = (kind: "artifact_hash" | "manual", target: string, expected?: string) =>
      assessMissionPredicate({ predicate: { id: "actual", kind, target, expected }, subject }, context);
    expect((await assess("artifact_hash", "result", sha256(Buffer.from("PASS")))).verdict).toBe("fail");
    expect((await assess("artifact_hash", "result", artifactHash)).verdict).toBe("pass");
    for (const [kind, target, expected] of [["manual", "result", artifactHash], ["artifact_hash", "legacy", artifactHash],
      ["artifact_hash", "result", undefined]] as const)
      expect((await assess(kind, target, expected)).verdict).toBe("inconclusive");
    expect((await assessMissionPredicate({ predicate: { id: "actual", kind: "artifact_hash", target: "result", expected: artifactHash }, subject },
      { ...context, scopeEstablished: false })).verdict).toBe("inconclusive");
    const full = captureWorkspaceImage(fixture.root);
    const filtered = filterWorkspaceImage(full, []);
    expect(() => assertCompleteWorkspaceImage(full)).not.toThrow();
    expect(() => assertCompleteWorkspaceImage(filtered)).toThrow(/incomplete/);
    const sealed = sealWorkspaceImage(filtered);
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{ revision: 1, kind: "mission.input.visible", causalId: randomUUID(), payload: {} }], artifacts: sealed.artifacts });
    expect((await assessMissionPredicate({ predicate: { id: "partial", kind: "artifact_hash", target: "result", expected: sealed.imageHash },
      subject: { kind: "workspace", imageHash: sealed.imageHash } }, context)).verdict).toBe("inconclusive");
    const workspace = createMissionWorkspace({ missionId: mission.id, attemptId: randomUUID(), sourceRoot: fixture.root,
      storeRoot: store.storageRoot, candidateParent: path.join(fixture.base, "candidates"), allowedPaths: ["."] });
    const effects = new MissionEffects({ store, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!, allowedOperations: ["bash"] });
    const completeSeal = sealWorkspaceImage(full);
    store.appendTransition(mission.id, store.inspectMission(mission.id).version, { events: [{ revision: 1, kind: "mission.input.visible", causalId: randomUUID(), payload: {} }], artifacts: completeSeal.artifacts });
    expect((await assessMissionPredicate({ predicate: { id: "contained", kind: "command_exit", target: "result", command: "exit 0", expected: "0", timeoutMs: 20 },
      subject: { kind: "workspace", imageHash: completeSeal.imageHash } }, { ...context, effects, timeoutLimitMs: 100 })).verdict).toBe("inconclusive");
    expect(store.inspectMission(mission.id).events.some((event) => event.kind === "effect.invoking")).toBe(false);
    expect(readFileSync(fixture.planFile).equals(fixture.planBytes)).toBe(true);
  } finally { store.close(); rmSync(fixture.base, { recursive: true, force: true }); }
});
