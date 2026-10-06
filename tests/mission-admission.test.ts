import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { admitMissionChange, askMissionChoice, classifyIntervention, classifyMissionInput, consumeOperatorInput, nextPlanBytes, pendingMissionQuestions, recordOperatorChoice, recordOperatorInput, revisionImpact, withdrawMissionChoice } from "../extensions/mission/admission.ts";
import { MissionEngine, reduceMissionEvents } from "../extensions/mission/engine.ts";
import { missionHasUnresolvedEffects } from "../extensions/mission/reconcile.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore, operatorChangeReceipt } from "./mission-fixtures.ts";
import type { MissionDefinition } from "../extensions/mission/model.ts";

test.each(["console", "native-confirmation"] as const)("host %s receipt preserves identity, session, payload and one-use admission", (source) => {
  const text = "/mission pause durable-fixture";
  const receipt = recordOperatorInput(source, "principal", text)!;
  expect(receipt.source).toBe(source);
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(() => consumeOperatorInput({ ...receipt }, "principal", text)).toThrow("host-issued");
  expect(() => consumeOperatorInput(JSON.parse(JSON.stringify(receipt)), "principal", text)).toThrow("host-issued");
  expect(() => consumeOperatorInput(receipt, "worker", text)).toThrow("host-issued");
  expect(() => consumeOperatorInput(receipt, "principal", "/mission cancel durable-fixture")).toThrow("host-issued");
  consumeOperatorInput(receipt, "principal", text);
  expect(() => consumeOperatorInput(receipt, "principal", text)).toThrow("one-use");
});

const dirs: string[] = [];
function withdrawReceipt(store: Awaited<ReturnType<typeof openFixtureStore>>, missionId: string, questionId: string) {
  const detail = `withdraw ${questionId}`;
  return recordOperatorChoice(store, store.inspectMission(missionId), "owner", `/mission revise durable-fixture ${detail}`, detail);
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("question and hypothetical do not authorize changes; extension origin cannot mint receipt", () => {
  expect(classifyMissionInput("What is status? ")).toBe("question");
  expect(classifyMissionInput("What if we remove the check? ")).toBe("hypothetical");
  expect(classifyMissionInput("What if we changed durable-fixture? ")).toBe("hypothetical");
  expect(classifyIntervention({ kind: "mission.revised", payload: { intervention: "operator_choice" } })).toBe("unknown");
  expect(classifyIntervention({ kind: "mission.input.recorded", payload: { intervention: "operational_rescue", operatorText: "/mission recover", operatorInputId: randomUUID() } }))
    .toBe("operational_rescue");
});

test("dishonest claimed impact cannot omit changed predicate or transitive consumer", () => {
  const old = missionDefinition();
  const next: MissionDefinition = structuredClone(old);
  next.units[0]!.acceptance[0]!.expected = "new";
  next.units.push({ ...structuredClone(old.units[0]!), id: "consumer", dependencies: ["snapshot"], acceptance: [{ id: "consumer-check", kind: "manual", target: "result" }] });
  expect(revisionImpact(old, next)).toEqual(["consumer", "snapshot"]);
});

test("revision is immutable and stale old acceptance never certifies new predicate", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const store = await openFixtureStore(fixture);
  try {
    const created = store.createMission(missionInput(fixture));
    const old = store.inspectMission(created.id);
    const next = missionDefinition();
    next.units[0]!.acceptance[0]!.expected = "changed";
    const receipt = operatorChangeReceipt(store, old, next);
    const admitted = admitMissionChange({ store, missionId: created.id, expectedVersion: old.version,
      planBytes: nextPlanBytes(old.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)),
      receipt, actor: "operator", claimedImpact: [] });
    expect(admitted).toEqual({ revision: 2, impact: ["snapshot"], retained: [] });
    expect(store.inspectMission(created.id).snapshot.parentRevision).toBe(1);
    expect(reduceMissionEvents(store.inspectMission(created.id)).units.snapshot?.status).toBe("pending");
    expect(store.readArtifact(old.snapshot.definitionHash).equals(old.definitionBytes)).toBe(true);
    expect(store.replayMission(created.id).mission.revision).toBe(2);
    expect(() => admitMissionChange({ store, missionId: created.id, expectedVersion: old.version,
      planBytes: nextPlanBytes(old.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), receipt, actor: "operator" }))
      .toThrow("version conflict");
  } finally { store.close(); }
});

test("retains independent accepted evidence but invalidates changed predicate and consumers", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "independent", outputs: ["other"],
    acceptance: [{ id: "other-check", kind: "manual", target: "other" }] });
  definition.budget.roleLaunches = 4;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  try {
    const mission = store.createMission(missionInput(fixture));
    const evidence = (unitId: string, predicateId: string) => ({
      id: randomUUID(), unitId, predicateId, revision: 1, verdict: "pass", inputManifestHash: "a".repeat(64),
      outputManifestHash: "b".repeat(64), method: "host observation", artifactHash: null, attemptId: randomUUID(),
    });
    const accepted = [evidence("snapshot", "snapshot-present"), evidence("independent", "other-check")];
    const event = (kind: string, unitId: string | null, payload: Record<string, unknown>) =>
      ({ revision: 1, kind, unitId, causalId: randomUUID(), payload });
    store.appendTransition(mission.id, mission.version, { events: [
      event("mission.activated", null, {}),
      ...accepted.flatMap((row) => [event("evidence.recorded", row.unitId, row),
        event("unit.accepted", row.unitId, { unitId: row.unitId, evidenceIds: [row.id] })]),
    ] });
    const old = store.inspectMission(mission.id);
    const next = structuredClone(definition);
    next.units[0]!.acceptance[0]!.expected = "new";
    const receipt = operatorChangeReceipt(store, old, next);
    const result = admitMissionChange({ store, missionId: mission.id, expectedVersion: old.version,
      planBytes: nextPlanBytes(old.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator", receipt });
    const state = reduceMissionEvents(store.inspectMission(mission.id));
    expect(result).toEqual({ revision: 2, impact: ["snapshot"], retained: ["independent"] });
    expect(state.units.independent?.status).toBe("accepted");
    expect(state.units.snapshot?.status).toBe("pending");
    expect(state.evidence.map(({ id }) => id)).toEqual([accepted[1]!.id]);
  } finally { store.close(); }
});

test.each(["predicate", "goal"] as const)("%s revision cannot bypass unresolved effect or shutdown block", async (change) => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => ({ instanceId: randomUUID(), role: "developer", status: "completed",
      model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
      result: "PASS", usage: { input: 1, output: 1, turns: 1, toolCalls: 0 } }),
    assessPredicate: () => ({ verdict: "pass", method: "fixture check" }),
  });
  try {
    const initial = store.inspectMission(mission.id);
    const effectId = randomUUID();
    store.appendTransition(mission.id, initial.version, { events: [
      { revision: 1, kind: "mission.activated", causalId: randomUUID(), payload: {} },
      { revision: 1, kind: "effect.intent", causalId: randomUUID(), effectId, payload: { effectId } },
      { revision: 1, kind: "effect.released", causalId: randomUUID(), effectId, payload: { effectId } },
      { revision: 1, kind: "mission.blocked", causalId: randomUUID(), payload: { reason: "shutdown recovery required" } },
    ] });
    engine.start();
    await engine.waitForIdle(); // Cache the failed recovery precondition before the revision.
    const before = store.inspectMission(mission.id);
    expect(missionHasUnresolvedEffects(store, before.events)).toBe(true);
    const next = structuredClone(before.definition);
    if (change === "predicate") next.units[0]!.acceptance[0]!.expected = "changed";
    else next.goal += " ";
    const receipt = operatorChangeReceipt(store, before, next);
    admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: before.version,
      planBytes: nextPlanBytes(before.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)),
      receipt, actor: "operator", claimedImpact: [] });
    await engine.waitForIdle();
    engine.start(); // Explicit recovery cannot dispatch while the old effect is unresolved.
    await engine.waitForIdle();
    const after = store.inspectMission(mission.id);
    expect(reduceMissionEvents(after).state).toBe("blocked");
    expect(after.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(0);
    expect(after.events.some(({ kind }) => kind === "unit.accepted")).toBe(false);
    expect(missionHasUnresolvedEffects(store, after.events)).toBe(true);
  } finally { await engine.close(); store.close(); }
});

test("ambiguous delta asks and holds only impacted worker; clear follow-up revises without approval", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "independent", outputs: ["other"],
    acceptance: [{ id: "other-check", kind: "manual", target: "other" }] });
  definition.budget.roleLaunches = 5;
  definition.budget.artifactBytes = 3 * 1024 * 1024;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  let snapshotStarts = 0;
  let releaseIndependent!: () => void;
  const independent = new Promise<void>((resolve) => { releaseIndependent = resolve; });
  const result = () => ({ instanceId: randomUUID(), role: "developer", status: "completed" as const,
    model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
    result: "PASS", usage: { input: 1, output: 1, turns: 1, toolCalls: 0 } });
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async ({ unit }, durable) => {
      if (unit.id === "independent") { await independent; return result(); }
      snapshotStarts++;
      if (snapshotStarts === 1) await new Promise<void>((resolve) => durable.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return result();
    }, assessPredicate: () => ({ verdict: "pass", method: "fixture check" }), maxConcurrent: 2 });
  try {
    engine.start();
    for (let i = 0; i < 100 && Object.keys(engine.snapshot().attempts).length < 2; i++) await Bun.sleep(10);
    expect(Object.keys(engine.snapshot().attempts)).toHaveLength(2);
    const delta = JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target",
      before: definition.units[0]!.acceptance[0]!.target, after: "stricter" }]);
    const text = `revise durable-fixture the snapshot predicate should be stricter -- ${delta}`;
    const receipt = recordOperatorInput("console", "owner", text, randomUUID(), "the snapshot predicate should be stricter")!;
    const before = store.inspectMission(mission.id);
    const asked = askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: before.version, receipt, delta });
    expect(asked.impact).toEqual(["snapshot"]);
    expect(asked.question).toContain("/units/0/acceptance/0/target");
    expect(store.inspectMission(mission.id).events.some(({ kind, payload }) => kind === "mission.input.recorded" && payload.question === asked.question)).toBe(true);
    releaseIndependent();
    await engine.waitForIdle();
    const held = store.inspectMission(mission.id);
    expect(reduceMissionEvents(held).units.independent?.status).toBe("accepted");
    expect(held.events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "snapshot")).toBe(false);
    expect(snapshotStarts).toBe(1);
    const revised = structuredClone(held.definition);
    revised.units[0]!.acceptance[0]!.target = "stricter";
    const clear = operatorChangeReceipt(store, held, revised);
    const admitted = admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: held.version,
      planBytes: nextPlanBytes(held.planBytes), definitionBytes: Buffer.from(JSON.stringify(revised)),
      receipt: clear, actor: "operator" });
    await engine.waitForIdle();
    expect(admitted.impact).toEqual(["snapshot"]);
    expect(reduceMissionEvents(store.inspectMission(mission.id)).units.snapshot?.status).toBe("accepted");
    expect(snapshotStarts).toBe(2);
  } finally { releaseIndependent(); await engine.close(); store.close(); }
}, 30000);

test("unrelated revision retains a pending choice until bound clear resolution", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "independent", outputs: ["other"],
    acceptance: [{ id: "other-check", kind: "manual", target: "other" }] });
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "consumer", dependencies: ["independent"], outputs: ["consumer"],
    acceptance: [{ id: "consumer-check", kind: "manual", target: "consumer" }] });
  definition.finalization.requiredPredicates.push("consumer-check");
  definition.budget.roleLaunches = 6;
  definition.budget.providerRequests = 6;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const launched: string[] = [];
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async ({ unit }) => { launched.push(unit.id); return { instanceId: randomUUID(), role: "developer", status: "completed",
      model: { selectedModel: "fixture/local" }, result: "PASS" }; },
    assessPredicate: () => ({ verdict: "pass", method: "fixture check" }) });
  try {
    const before = store.inspectMission(mission.id);
    const delta = JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: definition.units[0]!.acceptance[0]!.target, after: "stricter" }]);
    const ambiguous = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: before.version, receipt: ambiguous, delta });
    const current = store.inspectMission(mission.id);
    const unrelated = structuredClone(current.definition);
    unrelated.units[1]!.acceptance[0]!.target = "other revised";
    unrelated.units[2]!.dependencies = ["snapshot"];
    admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: current.version,
      planBytes: nextPlanBytes(current.planBytes), definitionBytes: Buffer.from(JSON.stringify(unrelated)), actor: "operator",
      receipt: operatorChangeReceipt(store, current, unrelated) });
    engine.start(); await engine.waitForIdle();
    expect(launched).toEqual(["independent"]);
    expect(engine.snapshot().units.snapshot?.status).not.toBe("accepted");
    expect(engine.snapshot().units.consumer?.status).not.toBe("accepted");
    expect(store.inspectMission(mission.id).events.some((event) => event.payload.resolvesInputId === ambiguous.id)).toBe(false);
    const still = store.inspectMission(mission.id);
    const resolved = structuredClone(still.definition);
    resolved.units[0]!.acceptance[0]!.target = "stricter";
    admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: still.version,
      planBytes: nextPlanBytes(still.planBytes), definitionBytes: Buffer.from(JSON.stringify(resolved)), actor: "operator",
      receipt: operatorChangeReceipt(store, still, resolved) });
    await engine.waitForIdle();
    expect(store.inspectMission(mission.id).events.some((event) => event.payload.resolvesInputId === ambiguous.id)).toBe(true);
    expect(engine.snapshot().units.snapshot?.status).toBe("accepted");
  } finally { await engine.close(); store.close(); }
});

test.each([
  ["prefix collision", "snapshot-present", "Change durable-fixture snapshot-extra target"],
  ["plan ID collision", "fixture", "Change durable-fixture independent output"],
  ["unselected field", "snapshot-present", "Change durable-fixture snapshot target"],
] as const)("rejects %s instead of changing an unresolved predicate", async (name, predicateId, instruction) => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.units[0]!.acceptance[0]!.id = predicateId;
  definition.finalization.requiredPredicates = [predicateId];
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "snapshot-extra", outputs: ["extra"],
    acceptance: [{ id: "extra-present", kind: "manual", target: "extra" }] });
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "independent", outputs: ["other"],
    acceptance: [{ id: "other-check", kind: "manual", target: "other" }] });
  definition.budget.roleLaunches = 8; definition.budget.providerRequests = 8;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => ({ instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "PASS" }) });
  try {
    const initial = store.inspectMission(mission.id);
    const question = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: initial.version, receipt: question,
      delta: JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]) });
    const before = store.inspectMission(mission.id);
    const next = structuredClone(before.definition);
    if (name === "unselected field") next.units[2]!.acceptance[0]!.target = "stricter";
    else next.units[0]!.acceptance[0]!.target = "stricter";
    expect(() => admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: before.version,
      planBytes: nextPlanBytes(before.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator",
      receipt: recordOperatorInput("console", "owner", instruction)! })).toThrow(/operator choice/);
    expect(store.inspectMission(mission.id).version).toBe(before.version);
    expect(pendingMissionQuestions(store.inspectMission(mission.id).events, store).map(({ id }) => id)).toEqual([question.id]);
  } finally { await engine.close(); store.close(); }
});

test.each([
  ["widget predicate", "Change durable-fixture widget predicate target", "retarget"],
  ["non-predicate note", "Change durable-fixture record a non-predicate note", "retarget"],
  ["owner non-predicate note", "Change durable-fixture snapshot non-predicate note", "retarget"],
  ["generic predicate", "Change durable-fixture predicate to stricter", "retarget"],
  ["rename with retarget", "Change durable-fixture rename the snapshot unit", "rename"],
  ["reorder with retarget", "Change durable-fixture reorder the snapshot unit", "reorder"],
  ["rename by question ID with retarget", "Change durable-fixture question ID rename the snapshot unit", "rename"],
  ["reorder by predicate ID with retarget", "Change durable-fixture reorder snapshot-present predicate", "reorder"],
] as const)("rejects %s without target intent", async (_, instruction, change) => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "independent", outputs: ["other"],
    acceptance: [{ id: "other-check", kind: "manual", target: "other" }] });
  definition.budget.roleLaunches = 4;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => ({ instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "PASS" }) });
  try {
    const initial = store.inspectMission(mission.id);
    const question = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: initial.version, receipt: question,
      delta: JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]) });
    const before = store.inspectMission(mission.id);
    const next = structuredClone(before.definition);
    if (change === "rename") next.units[0]!.id = "renamed";
    if (change === "reorder") next.units.reverse();
    next.units.find((unit) => unit.acceptance[0]!.id === "snapshot-present")!.acceptance[0]!.target = "stricter";
    expect(() => admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: before.version,
      planBytes: nextPlanBytes(before.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator",
      receipt: recordOperatorInput("console", "owner", instruction.replace("question ID", `question ${question.id}`))! })).toThrow(/operator choice/);
    expect(store.inspectMission(mission.id).version).toBe(before.version);
    expect(pendingMissionQuestions(store.inspectMission(mission.id).events, store).map(({ id }) => id)).toEqual([question.id]);
  } finally { await engine.close(); store.close(); }
});

test("resolves predicate choice with explicit typed answer", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => ({ instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "PASS" }) });
  try {
    const initial = store.inspectMission(mission.id);
    const question = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: initial.version, receipt: question,
      delta: JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]) });
    const before = store.inspectMission(mission.id);
    const next = structuredClone(before.definition);
    next.units[0]!.acceptance[0]!.target = "stricter";
    admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: before.version,
      planBytes: nextPlanBytes(before.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator",
      receipt: operatorChangeReceipt(store, before, next, question.id) });
    expect(pendingMissionQuestions(store.inspectMission(mission.id).events, store)).toEqual([]);
  } finally { await engine.close(); store.close(); }
});

test.each(["rename", "reorder"] as const)("structural %s naming the held owner retains its predicate question", async (change) => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "independent", outputs: ["other"],
    acceptance: [{ id: "other-check", kind: "manual", target: "other" }] });
  definition.budget.roleLaunches = 4; definition.budget.providerRequests = 4;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const launched: string[] = [];
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async ({ unit }) => { launched.push(unit.id); return { instanceId: randomUUID(), role: "developer", status: "completed",
      model: { selectedModel: "fixture/local" }, result: "PASS" }; },
    assessPredicate: () => ({ verdict: "pass", method: "fixture check" }) });
  try {
    const initial = store.inspectMission(mission.id);
    const question = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: initial.version, receipt: question,
      delta: JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]) });
    const before = store.inspectMission(mission.id);
    const next = structuredClone(before.definition);
    if (change === "rename") next.units[0]!.id = "renamed";
    else next.units.reverse();
    admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: before.version,
      planBytes: nextPlanBytes(before.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator",
      receipt: operatorChangeReceipt(store, before, next) });
    const after = store.inspectMission(mission.id);
    expect(pendingMissionQuestions(after.events, store).map(({ id, roots }) => ({ id, roots })))
      .toEqual([{ id: question.id, roots: [change === "rename" ? "renamed" : "snapshot"] }]);
    expect(after.events.some((event) => event.payload.resolvesInputId === question.id)).toBe(false);
    engine.start(); await engine.waitForIdle();
    expect(launched).toEqual(["independent"]);
    expect(engine.snapshot().units[change === "rename" ? "renamed" : "snapshot"]?.status).not.toBe("accepted");
    const held = store.inspectMission(mission.id);
    const resolved = structuredClone(held.definition);
    resolved.units.find((unit) => unit.acceptance[0]!.id === "snapshot-present")!.acceptance[0]!.target = "stricter";
    admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: held.version,
      planBytes: nextPlanBytes(held.planBytes), definitionBytes: Buffer.from(JSON.stringify(resolved)), actor: "operator",
      receipt: operatorChangeReceipt(store, held, resolved) });
    expect(pendingMissionQuestions(store.inspectMission(mission.id).events, store)).toEqual([]);
  } finally { await engine.close(); store.close(); }
});

test("exact clear target resolves one question; overlapping choices require question ID and withdrawal keeps other hold", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => ({ instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "PASS" }) });
  try {
    const delta = JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]);
    const ask = () => {
      const before = store.inspectMission(mission.id);
      const receipt = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
      askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: before.version, receipt, delta });
      return receipt.id;
    };
    const first = ask();
    const second = ask();
    const before = store.inspectMission(mission.id);
    const next = structuredClone(before.definition);
    next.units[0]!.acceptance[0]!.target = "stricter";
    const revise = (questionId?: string) => admitMissionChange({ store, engine, missionId: mission.id,
      expectedVersion: before.version, planBytes: nextPlanBytes(before.planBytes),
      definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator",
      receipt: operatorChangeReceipt(store, before, next, questionId) });
    expect(() => revise()).toThrow(/ambiguous operator choice/);
    const unrelated = structuredClone(before.definition);
    unrelated.units[0]!.outputs = ["renamed-output"];
    expect(() => admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: before.version,
      planBytes: nextPlanBytes(before.planBytes), definitionBytes: Buffer.from(JSON.stringify(unrelated)), actor: "operator",
      receipt: operatorChangeReceipt(store, before, unrelated, first) }))
      .toThrow("operator answer must cover exactly its question bindings");
    expect(store.inspectMission(mission.id).version).toBe(before.version);
    revise(first);
    expect(pendingMissionQuestions(store.inspectMission(mission.id).events, store).map(({ id }) => id)).toEqual([second]);
    await withdrawMissionChoice({ store, engine, missionId: mission.id,
      receipt: withdrawReceipt(store, mission.id, second) });
    expect(pendingMissionQuestions(store.inspectMission(mission.id).events, store)).toEqual([]);
  } finally { await engine.close(); store.close(); }
});

test.each(["insert", "reorder", "rename", "remove"] as const)("pending predicate choice survives %s across engine restart", async (change) => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "independent", outputs: ["other"],
    acceptance: [{ id: "other-check", kind: "manual", target: "other" }] });
  if (change === "rename") definition.units.push({ ...structuredClone(definition.units[0]!), id: "consumer", dependencies: ["snapshot"],
    acceptance: [{ id: "consumer-check", kind: "manual", target: "consumer" }] });
  definition.budget.roleLaunches = 8; definition.budget.providerRequests = 8; definition.budget.artifactBytes = 3 * 1024 * 1024;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const launched: string[] = [];
  const options = { store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async ({ unit }: { unit: { id: string } }) => { launched.push(unit.id); return { instanceId: randomUUID(), role: "developer", status: "completed" as const,
      model: { selectedModel: "fixture/local" }, result: "PASS" }; },
    assessPredicate: () => ({ verdict: "pass" as const, method: "fixture check" }) };
  const first = new MissionEngine(options);
  try {
    const before = store.inspectMission(mission.id);
    const delta = JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]);
    const receipt = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    askMissionChoice({ store, engine: first, missionId: mission.id, expectedVersion: before.version, receipt, delta });
    const current = store.inspectMission(mission.id);
    const next = structuredClone(current.definition);
    if (change === "insert" || change === "remove") {
      next.units.splice(0, change === "remove" ? 1 : 0, { ...structuredClone(next.units[0]!), id: "preface", outputs: ["preface"],
        acceptance: [{ id: "preface-check", kind: "manual", target: "preface" }] });
      if (change === "remove") next.finalization.requiredPredicates = ["other-check"];
    } else if (change === "reorder") next.units.reverse();
    else { next.units[0]!.id = "renamed"; next.units.find(({ id }) => id === "consumer")!.dependencies = ["renamed"]; }
    admitMissionChange({ store, engine: first, missionId: mission.id, expectedVersion: current.version,
      planBytes: nextPlanBytes(current.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator",
      receipt: operatorChangeReceipt(store, current, next) });
    expect(store.inspectMission(mission.id).events.some((event) => event.payload.resolvesInputId === receipt.id)).toBe(false);
    await first.close();
    const restarted = new MissionEngine(options);
    try {
      restarted.start(); await restarted.waitForIdle();
      expect(launched).toContain("independent");
      expect(launched).not.toContain(change === "rename" ? "renamed" : "snapshot");
      if (change === "insert") expect(launched).toContain("preface");
      if (change === "remove") expect(launched).not.toContain("preface");
      if (change === "rename") {
        expect(launched).not.toContain("consumer");
        const revision = store.inspectMission(mission.id).events.find(({ kind }) => kind === "mission.revised")!;
        expect(revision.payload.questionMappings).toEqual([{ id: receipt.id, roots: ["renamed"], heldUnits: ["renamed", "consumer"] }]);
      }
      if (change === "reorder") {
        const current = store.inspectMission(mission.id);
        const resolved = structuredClone(current.definition);
        resolved.units.find(({ id }) => id === "snapshot")!.acceptance[0]!.target = "stricter";
        admitMissionChange({ store, engine: restarted, missionId: mission.id, expectedVersion: current.version,
          planBytes: nextPlanBytes(current.planBytes), definitionBytes: Buffer.from(JSON.stringify(resolved)), actor: "operator",
          receipt: operatorChangeReceipt(store, current, resolved) });
        await restarted.waitForIdle();
        expect(restarted.snapshot().units.snapshot?.status).toBe("accepted");
      }
    } finally { await restarted.close(); }
  } finally { store.close(); }
});

test("old pointer-only question replays against ask-time snapshot, not shifted offset", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "independent", outputs: ["other"],
    acceptance: [{ id: "other-check", kind: "manual", target: "other" }] });
  definition.budget.roleLaunches = 8; definition.budget.providerRequests = 8;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => ({ instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "PASS" }) });
  try {
    const before = store.inspectMission(mission.id);
    const receipt = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: before.version, receipt,
      delta: JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]) });
    const current = store.inspectMission(mission.id);
    const next = structuredClone(current.definition);
    next.units.unshift({ ...structuredClone(next.units[0]!), id: "preface", outputs: ["preface"],
      acceptance: [{ id: "preface-check", kind: "manual", target: "preface" }] });
    admitMissionChange({ store, missionId: mission.id, expectedVersion: current.version,
      planBytes: nextPlanBytes(current.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator",
      receipt: operatorChangeReceipt(store, current, next) });
    const legacy = store.inspectMission(mission.id).events.map((event) => structuredClone(event));
    const ask = legacy.find((event) => event.payload.operatorInputId === receipt.id)!;
    delete ask.payload.choiceBindings; delete ask.payload.askDefinitionHash;
    const revise = legacy.find((event) => event.kind === "mission.revised")!;
    delete revise.payload.questionMappings;
    revise.payload.resolvesInputId = receipt.id; revise.payload.resolvesInputIds = [receipt.id];
    expect(pendingMissionQuestions(legacy, store).map(({ id, roots, bindings }) => ({ id, roots, bindings: bindings.map(({ id }) => id) })))
      .toEqual([{ id: receipt.id, roots: ["snapshot"], bindings: ["snapshot-present"] }]);
  } finally { await engine.close(); store.close(); }
});

test("legacy resolution replay cannot select a question from another identifier or delta bytes", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "snapshot-extra", outputs: ["extra"],
    acceptance: [{ id: "extra-present", kind: "manual", target: "extra" }] });
  definition.budget.roleLaunches = 5; definition.budget.providerRequests = 5;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => ({ instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "PASS" }) });
  try {
    const before = store.inspectMission(mission.id);
    const question = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: before.version, receipt: question,
      delta: JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]) });
    const held = store.inspectMission(mission.id);
    const next = structuredClone(held.definition);
    next.units[0]!.acceptance[0]!.target = "stricter";
    store.admitRevision({ missionId: mission.id, expectedVersion: held.version, planBytes: nextPlanBytes(held.planBytes),
      definitionBytes: Buffer.from(JSON.stringify(next)), receiptId: randomUUID(), actor: "operator",
      impact: ["snapshot"], retained: ["snapshot-extra"],
      operatorText: `/mission revise durable-fixture Change durable-fixture snapshot-extra target -- ${JSON.stringify(next.units[0]!.acceptance[0])}`,
      resolvesInputIds: [question.id], questionMappings: [] });
    const legacy = store.inspectMission(mission.id).events.map((event) => structuredClone(event));
    const ask = legacy.find((event) => event.payload.operatorInputId === question.id)!;
    delete ask.payload.choiceBindings; delete ask.payload.askDefinitionHash;
    expect(pendingMissionQuestions(legacy, store).map(({ id, roots }) => ({ id, roots })))
      .toEqual([{ id: question.id, roots: ["snapshot"] }]);
    const revise = legacy.find((event) => event.kind === "mission.revised")!;
    revise.payload.operatorInstruction = "Change durable-fixture widget predicate target";
    expect(pendingMissionQuestions(legacy, store).map(({ id }) => id)).toEqual([question.id]);
    revise.payload.operatorInstruction = "Change durable-fixture rename the snapshot unit";
    expect(pendingMissionQuestions(legacy, store).map(({ id }) => id)).toEqual([question.id]);
  } finally { await engine.close(); store.close(); }
});

test("overlapping questions release only after both are withdrawn; stale revision cannot resolve a choice", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition(); definition.budget.artifactBytes = 3 * 1024 * 1024;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  let launches = 0;
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => { launches++; return { instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "PASS" }; },
    assessPredicate: () => ({ verdict: "pass", method: "fixture check" }) });
  try {
    const delta = JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]);
    const ask = () => { const before = store.inspectMission(mission.id); const receipt = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
      askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: before.version, receipt, delta }); return receipt.id; };
    const first = ask(); const second = ask();
    const stale = store.inspectMission(mission.id);
    const next = structuredClone(stale.definition); next.units[0]!.acceptance[0]!.target = "stricter";
    const clear = recordOperatorInput("console", "owner", "Change durable-fixture snapshot predicate to stricter")!;
    const unrelated = store.inspectMission(mission.id);
    store.appendTransition(mission.id, unrelated.version, { events: [{ revision: unrelated.revision, kind: "mission.input.recorded", causalId: randomUUID(), payload: { classification: "question" } }] });
    expect(() => admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: stale.version, planBytes: nextPlanBytes(stale.planBytes),
      definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator", receipt: clear })).toThrow("version conflict");
    engine.start(); await engine.waitForIdle(); expect(launches).toBe(0);
    await withdrawMissionChoice({ store, engine, missionId: mission.id, receipt: withdrawReceipt(store, mission.id, second) });
    await engine.waitForIdle(); expect(launches).toBe(0);
    await withdrawMissionChoice({ store, engine, missionId: mission.id, receipt: withdrawReceipt(store, mission.id, first) });
    await engine.waitForIdle(); expect(launches).toBe(1);
  } finally { await engine.close(); store.close(); }
});

test("withdrawal releases disjoint choice without releasing another unit", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "independent", outputs: ["other"],
    acceptance: [{ id: "other-check", kind: "manual", target: "other" }] });
  definition.budget.roleLaunches = 6; definition.budget.providerRequests = 6;
  definition.budget.artifactBytes = 3 * 1024 * 1024;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const launched: string[] = [];
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async ({ unit }) => { launched.push(unit.id); return { instanceId: randomUUID(), role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "PASS" }; },
    assessPredicate: () => ({ verdict: "pass", method: "fixture check" }) });
  try {
    for (const index of [0, 1]) {
      const before = store.inspectMission(mission.id);
      const target = before.definition.units[index]!.acceptance[0]!.target;
      askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: before.version,
        receipt: recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!,
        delta: JSON.stringify([{ op: "replace", path: `/units/${index}/acceptance/0/target`, before: target, after: "stricter" }]) });
    }
    engine.start(); await engine.waitForIdle(); expect(launched).toEqual([]);
    const questions = pendingMissionQuestions(store.inspectMission(mission.id).events, store);
    expect(await withdrawMissionChoice({ store, engine, missionId: mission.id,
      receipt: withdrawReceipt(store, mission.id, questions[0]!.id) })).toEqual(["snapshot"]);
    await engine.waitForIdle(); expect(launched).toEqual(["snapshot"]);
    expect(pendingMissionQuestions(store.inspectMission(mission.id).events, store).map(({ id }) => id)).toEqual([questions[1]!.id]);
  } finally { await engine.close(); store.close(); }
});

test("unparseable ambiguous choice asks without global hold; withdrawal releases a focused hold", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.budget.artifactBytes = 3 * 1024 * 1024;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => ({ instanceId: randomUUID(), role: "developer", status: "completed",
      model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
      result: "PASS", usage: { input: 1, output: 1, turns: 1, toolCalls: 0 } }),
    assessPredicate: () => ({ verdict: "pass", method: "fixture check" }) });
  try {
    const current = store.inspectMission(mission.id);
    const receipt = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    const asked = askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: current.version, receipt, delta: "not JSON" });
    expect(asked.impact).toEqual([]);
    expect(asked.question).toContain("exact delta");
    engine.start(); await engine.waitForIdle();
    expect(engine.snapshot().units.snapshot?.status).toBe("accepted");
    const withdraw = withdrawReceipt(store, mission.id, receipt.id);
    expect(await withdrawMissionChoice({ store, engine, missionId: mission.id, receipt: withdraw })).toEqual([]);
    expect(store.inspectMission(mission.id).events.some(({ kind, payload }) => kind === "mission.input.recorded" && payload.disposition === "withdrawn")).toBe(true);
  } finally { await engine.close(); store.close(); }
});

test("withdrawal releases only the held boundary without a revision", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const definition = missionDefinition();
  definition.budget.artifactBytes = 3 * 1024 * 1024;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  let launches = 0;
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => { launches++; return { instanceId: randomUUID(), role: "developer", status: "completed",
      model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
      result: "PASS", usage: { input: 1, output: 1, turns: 1, toolCalls: 0 } }; },
    assessPredicate: () => ({ verdict: "pass", method: "fixture check" }) });
  try {
    const before = store.inspectMission(mission.id);
    const delta = JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]);
    const ambiguous = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    expect(askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: before.version, receipt: ambiguous, delta }).impact).toEqual(["snapshot"]);
    engine.start(); await engine.waitForIdle();
    expect(launches).toBe(0);
    const withdraw = withdrawReceipt(store, mission.id, ambiguous.id);
    expect(await withdrawMissionChoice({ store, engine, missionId: mission.id, receipt: withdraw })).toEqual(["snapshot"]);
    await engine.waitForIdle();
    expect(launches).toBe(1);
    expect(store.inspectMission(mission.id).revision).toBe(1);
    expect(engine.snapshot().units.snapshot?.status).toBe("accepted");
  } finally { await engine.close(); store.close(); }
});

test.each([
  "Change durable-fixture do not change the snapshot predicate",
  "Change durable-fixture reorder snapshot unit and set target date",
  "Change durable-fixture snapshot-present predicate target to stricter",
] as const)("untyped real-store instruction cannot authorize hidden retarget: %s", async (instruction) => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => { throw new Error("held worker must not launch"); } });
  try {
    const initial = store.inspectMission(mission.id);
    const delta = JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]);
    const ambiguous = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: initial.version, receipt: ambiguous, delta });
    const before = store.inspectMission(mission.id);
    const next = structuredClone(before.definition);
    next.units[0]!.acceptance[0]!.target = "stricter";
    if (instruction.includes("snapshot-present")) next.finalization.independentReview = false;
    expect(() => admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: before.version,
      planBytes: nextPlanBytes(before.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator",
      receipt: recordOperatorInput("console", "owner", instruction)! })).toThrow("host-bound operator choice");
    expect(store.inspectMission(mission.id).revision).toBe(1);
    expect(pendingMissionQuestions(store.inspectMission(mission.id).events, store).map(({ id }) => id)).toEqual([ambiguous.id]);
  } finally { await engine.close(); store.close(); }
});

test("typed choice rejects value mismatch, extra gate, stale preimage, mixed answer and unknown fields", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.base, "sessions"),
    runRole: async () => { throw new Error("held worker must not launch"); } });
  try {
    const start = store.inspectMission(mission.id);
    const delta = JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]);
    const question = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: start.version, receipt: question, delta });
    const before = store.inspectMission(mission.id);
    const next = structuredClone(before.definition); next.units[0]!.acceptance[0]!.target = "stricter";
    const receipt = operatorChangeReceipt(store, before, next);
    const proposal = (definition: MissionDefinition, choice = receipt) => () => admitMissionChange({ store, engine, missionId: mission.id,
      expectedVersion: before.version, planBytes: nextPlanBytes(before.planBytes),
      definitionBytes: Buffer.from(JSON.stringify(definition)), actor: "operator", receipt: choice });
    const wrongValue = structuredClone(next); wrongValue.units[0]!.acceptance[0]!.target = "different";
    expect(proposal(wrongValue)).toThrow("complete revision bytes");
    const extraGate = structuredClone(next); extraGate.finalization.independentReview = false;
    expect(proposal(extraGate)).toThrow("complete revision bytes");
    const extra = JSON.stringify([
      { target: { kind: "predicate", id: "snapshot-present", field: "target" }, before: "snapshot", after: "stricter" },
      { target: { kind: "mission", field: "finalization/independentReview" }, before: true, after: false },
    ]);
    const answer = `answer ${question.id} ${extra}`;
    const mixed = recordOperatorChoice(store, before, "owner", `/mission revise durable-fixture ${answer}`, answer);
    expect(proposal(extraGate, mixed)).toThrow("operator answer must cover exactly its question bindings");
    const rejected = (detail: string) => recordOperatorChoice(store, before, "owner", `/mission revise durable-fixture ${detail}`, detail);
    expect(() => rejected(`set ${JSON.stringify([{ target: { kind: "predicate", id: "snapshot-present", field: "target" }, before: "outdated", after: "stricter" }])}`))
      .toThrow("choice preimage mismatch");
    expect(() => rejected(`set ${JSON.stringify([{ target: { kind: "mission", field: "finalization/unknown" }, before: true, after: false }])}`))
      .toThrow("unknown choice field");
    expect(() => rejected(`set ${extra} trailing prose`)).toThrow("choice edits must be JSON");
    const selected = operatorChangeReceipt(store, before, next, question.id);
    expect(proposal(next, selected)().revision).toBe(2);
    expect(pendingMissionQuestions(store.inspectMission(mission.id).events, store)).toEqual([]);
    expect(() => proposal(next, selected)()).toThrow("version conflict");
  } finally { await engine.close(); store.close(); }
});

test("model cannot widen authority, budget, or weaken gates", async () => {
  const fixture = createMissionFixture(); dirs.push(fixture.base);
  const store = await openFixtureStore(fixture);
  try {
    const created = store.createMission(missionInput(fixture, { commandId: randomUUID() }));
    const old = store.inspectMission(created.id);
    const next = missionDefinition();
    next.authority.allowTechnicalAmendments = true;
    next.budget.tokens += 100;
    expect(() => admitMissionChange({ store, missionId: created.id, expectedVersion: old.version,
      planBytes: nextPlanBytes(old.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), actor: "model" }))
      .toThrow("technical amendments are not authorized");
  } finally { store.close(); }
});
