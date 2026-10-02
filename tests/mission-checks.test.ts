import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assessMissionPredicate } from "../extensions/mission/checks.ts";
import { sha256 } from "../extensions/mission/model.ts";
import { createMissionFixture, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { rmSync } from "node:fs";
import path from "node:path";
import { assertCompleteWorkspaceImage, sealWorkspaceImage } from "../extensions/mission/reconcile.ts";
import { captureWorkspaceImage, createMissionWorkspace, filterWorkspaceImage } from "../extensions/mission/workspace.ts";
import { MissionEffects } from "../extensions/mission/effects.ts";
import { validateMissionDefinitionBytes } from "../extensions/mission/model.ts";
import { missionDefinition } from "./mission-fixtures.ts";
import { MissionEngine } from "../extensions/mission/engine.ts";

test("explicit completion contract cannot opt out of whole review; legacy bytes stay legacy", () => {
  const definition = missionDefinition();
  definition.finalization.independentReview = false;
  const legacy = Buffer.from(JSON.stringify(definition));
  expect(validateMissionDefinitionBytes(legacy).definition.finalization.contractVersion).toBeUndefined();
  definition.finalization.contractVersion = 1;
  expect(() => validateMissionDefinitionBytes(Buffer.from(JSON.stringify(definition)))).toThrow(/whole-result independent review/);
});

test("unreceipted actor cannot turn matching worker text into production acceptance", async () => {
  const fixture = createMissionFixture();
  const definition = missionDefinition();
  definition.finalization.contractVersion = 1;
  definition.budget.roleLaunches = 4;
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
