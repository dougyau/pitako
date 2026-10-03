import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { MissionEngine, createPiMissionRunner } from "../extensions/mission/engine.ts";
import { admitMissionChange, nextPlanBytes } from "../extensions/mission/admission.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore, operatorChangeReceipt } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";
import { registerMissionExtension } from "../extensions/mission/index.ts";
import { calculateMissionMetrics, captureMetricMission, METRIC_VERSION } from "../extensions/mission/metrics.ts";

for (const scenario of [
  { name: "omitted JSON pricing", usage: {}, expectedCost: null, tokens: 25 },
  { name: "positive JSON pricing", usage: {}, rates: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 }, expectedCost: .000068, tokens: 25 },
  { name: "fully observed zero consumption", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, expectedCost: 0, tokens: 0 },
  { name: "cache-only consumption", usage: { input: 0, output: 0, cacheRead: 2, cacheWrite: 0, totalTokens: 2 }, expectedCost: null, tokens: 0 },
  { name: "partial zero usage", usage: { input: 0, output: undefined, cacheRead: 0, cacheWrite: 0 }, terminalCost: 0, expectedCost: null, tokens: null },
  { name: "missing cache usage with zero tokens", usage: { input: 0, output: 0, cacheRead: undefined, cacheWrite: 0 }, terminalCost: 0, expectedCost: null, tokens: 0 },
  { name: "invalid cost", usage: {}, terminalCost: NaN, expectedCost: null, tokens: 25 },
  { name: "negative cost", usage: {}, terminalCost: -1, expectedCost: null, tokens: 25 },
  { name: "unavailable terminal usage", usage: {}, unavailable: true, expectedCost: null, tokens: null },
]) test(`durable SDK receipt preserves price uncertainty: ${scenario.name}`, async () => {
  const fixture = createMissionFixture("pricing-pi-"); dirs.push(fixture.base);
  const agentDir = path.join(fixture.base, "agent"), config = path.join(agentDir, "pitako", "config.toml");
  mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const provider = await installMissionLocalProvider({
    agentDir, modelFromJson: scenario.rates ? { cost: scenario.rates } : {},
    usage: scenario.usage, terminalCost: scenario.terminalCost, omitUsage: scenario.unavailable,
    responseForPrompt: () => "Local pricing fixture result",
  });
  const definition = missionDefinition();
  definition.units[0]!.kind = "consultation";
  definition.budget = { roleLaunches: 6, providerRequests: 8, tokens: 1600, activeTimeMs: 120000, artifactBytes: 1024 * 1024 };
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(fixture.stateDir, "sessions"),
    runRole: createPiMissionRunner({ cwd: fixture.root, executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } }),
    assessPredicate: () => ({ verdict: "pass", method: "local fixture, not effectiveness evidence" }) });
  try {
    engine.start(); await engine.waitForIdle();
    const inspected = store.inspectMission(mission.id);
    const receipts = inspected.events.filter((e) => e.kind === "provider.request.receipt");
    expect(receipts.length).toBeGreaterThan(0);
    expect(inspected.events.filter((e) => e.kind === "provider.request.dispatched")).toHaveLength(receipts.length);
    for (const receipt of receipts) {
      if (scenario.expectedCost === null) {
        expect(receipt.payload.estimatedCost).toBeNull();
        expect(receipt.payload.pricingBasis).toContain("unknown pricing");
      } else expect(receipt.payload.estimatedCost).toBeCloseTo(scenario.expectedCost, 12);
      const measurement = inspected.measurements.find((m) => m.id && m.inputTokens === receipt.payload.inputTokens);
      expect(measurement?.value).toBe(scenario.tokens);
      const grant = inspected.events.find((e) => e.kind === "budget.reservation.settled" &&
        e.payload.reservationId === receipt.payload.tokenReservationId)!.payload;
      const grantAmount = inspected.events.find((e) => e.kind === "reservation.created" &&
        e.payload.reservationId === receipt.payload.tokenReservationId)!.payload.amount as number;
      if (scenario.tokens === null) {
        expect(grant.unknownCharge).toBe(grantAmount);
        expect(grant.knownCharge).toBe(0);
        expect(receipt.payload.usageUnknownReason).toBeTruthy();
      } else {
        expect(grant.knownCharge).toBe(scenario.tokens);
        expect(grant.unknownCharge).toBe(0);
        expect(grant.released).toBe(grantAmount - scenario.tokens);
        expect(receipt.payload.usageUnknownReason).toBeUndefined();
      }
      expect(receipt.payload.inputTokens).toBe(scenario.unavailable ? null : scenario.usage.input ?? 17);
      expect(receipt.payload.outputTokens).toBe(scenario.unavailable || scenario.name === "partial zero usage" ? null : scenario.usage.output ?? 8);
    }
    if (!scenario.unavailable && scenario.terminalCost === undefined)
      expect(provider.trace.every((row) => row.cost === (scenario.expectedCost ?? 0))).toBe(true);
    const captured = captureMetricMission(store, inspected, "pricing-fixture");
    const report = calculateMissionMetrics({ format: "mission-metric-cohort-v1", metricVersion: METRIC_VERSION,
      population: "deterministic-fixture", label: scenario.name, missions: [captured] });
    expect(report.costs.unknownCost).toBe(scenario.expectedCost === null ? receipts.length : 0);
    expect(report.costs.estimatedUSD).toBeCloseTo((scenario.expectedCost ?? 0) * receipts.length, 12);
    expect(report.costs.unknownUsage).toBe(scenario.tokens === null ? receipts.length : 0);
    expect(report.costs.inputTokens).toBe(scenario.unavailable ? 0 : (scenario.usage.input ?? 17) * receipts.length);
  } finally { await engine.close(); store.close(); }
}, 60000);

const oldDir = process.env.PI_CODING_AGENT_DIR;
const dirs: string[] = [];
afterEach(() => {
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldDir;
  delete (globalThis as Record<string, unknown>).__pitako_mission_local;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("extension-origin and model tool cannot forge operator start, status remains callable", async () => {
  const events = new Map<string, Function[]>();
  const commands = new Map<string, Function>();
  const tools = new Map<string, any>();
  registerMissionExtension({
    on: (name: string, handler: Function) => { const list = events.get(name) ?? []; list.push(handler); events.set(name, list); },
    registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command.handler),
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
  } as any);
  const ctx = { mode: "tui", cwd: "/tmp", hasUI: true, sessionManager: { getSessionId: () => "foreground" },
    ui: { notify: (message: string) => messages.push(message) } };
  const messages: string[] = [];
  for (const handler of events.get("input") ?? []) await handler({ source: "extension", text: "/mission start durable-fixture" }, ctx);
  await commands.get("mission")!("start durable-fixture", ctx);
  expect(messages.at(-1)).toContain("native Pi input is advisory");
  await commands.get("mission")!("metrics --import-observations /tmp/worker-assessment.json", ctx);
  expect(messages.at(-1)).toContain("observation import requires the operator console");
  expect(tools.has("mission_start")).toBe(true);
  await expect(tools.get("mission_start").execute("call", { id: "durable-fixture" }, undefined, undefined, ctx))
    .rejects.toThrow("model tool cannot mint start authority");
});

test("local operator socket admits once; forged Pi content and hypothetical cannot mutate", async () => {
  const fixture = createMissionFixture("t5-console-"); dirs.push(fixture.base);
  process.env.PI_CODING_AGENT_DIR = fixture.stateDir;
  const events = new Map<string, Function[]>();
  const commands = new Map<string, Function>();
  const notices: string[] = [];
  registerMissionExtension({
    on: (name: string, handler: Function) => events.set(name, [...events.get(name) ?? [], handler]),
    registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command.handler),
    registerTool: () => {},
  } as any);
  const ctx = { mode: "rpc", cwd: fixture.root, hasUI: true, sessionManager: { getSessionId: () => "console-session" },
    ui: { notify: (text: string) => notices.push(text) } };
  const emit = async (name: string, data: unknown = {}) => {
    for (const handler of events.get(name) ?? []) await handler(data, ctx);
  };
  await emit("session_start");
  const socket = notices.find((text) => text.startsWith("Mission operator console:"))?.split(" ").at(-1);
  expect(socket).toBeTruthy();
  const proof = readFileSync(`${socket}.key`).toString("hex");
  const send = async (text: string, credential?: string, visibleId?: string): Promise<{ ok: boolean; message: string; causalId: string; responseMs: number }> => {
    const raw = await new Promise<string>((resolve, reject) => {
      const peer = connect(socket!); let data = "";
      peer.setEncoding("utf8");
      peer.on("connect", () => peer.write(JSON.stringify({ text, proof: credential ?? proof, ...(visibleId ? { visibleId } : {}) }) + "\n"));
      peer.on("data", (part: string) => { data += part; });
      peer.on("end", () => resolve(data)); peer.on("error", reject);
    });
    return JSON.parse(raw);
  };
  try {
    await emit("input", { source: "interactive", text: "/mission prepare durable-fixture" });
    await commands.get("mission")!("prepare durable-fixture", ctx);
    expect(notices.at(-1)).toContain("native Pi input is advisory");
    const credentialDenial = await send("/mission prepare durable-fixture", "0".repeat(64));
    expect(credentialDenial.ok).toBe(false);
    const preparedReply = await send("/mission prepare durable-fixture");
    expect(preparedReply.ok).toBe(true);
    expect(preparedReply.causalId).toMatch(/^[a-f0-9-]{36}$/);
    expect(preparedReply.responseMs).toBeGreaterThanOrEqual(0);
    const store = await openFixtureStore(fixture);
    try {
      const prepared = store.findManagedMission(fixture.root)!;
      expect(prepared.snapshot.admissionProvenance.kind).toBe("operator");
      writeFileSync(fixture.definitionFile, JSON.stringify({ ...missionDefinition(), goal: "unapproved file drift" }));
      const before = prepared.definition.units[0]!.acceptance[0]!;
      const exact = JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0", before, after: { ...before, expected: "changed" } }]);
      const hypotheticalDenial = await send(`/mission revise durable-fixture What if we change durable-fixture predicate? -- ${exact}`);
      expect(hypotheticalDenial.ok).toBe(false);
      for (const instruction of ["do not change the snapshot predicate", "reorder snapshot unit and set target date"]) {
        const denied = await send(`/mission revise durable-fixture Change durable-fixture ${instruction} -- ${exact}`);
        expect(denied.ok).toBe(false);
        expect(denied.message).toContain("exact typed command");
      }
      expect(store.inspectMission(prepared.id).revision).toBe(1);
      const edits = JSON.stringify([{ target: { kind: "unit", id: "snapshot", field: "acceptance" },
        before: prepared.definition.units[0]!.acceptance, after: [{ ...before, expected: "changed" }] }]);
      const replies = await Promise.all(Array.from({ length: 3 }, () => send(`/mission revise durable-fixture set ${edits}`)));
      expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
      const revised = store.inspectMission(prepared.id);
      expect(revised.revision).toBe(2);
      expect(revised.definition.goal).toBe(prepared.definition.goal);
      expect(revised.events.filter((event) => event.kind === "mission.revised")).toHaveLength(1);
      expect(revised.events.find((event) => event.kind === "mission.revised")?.payload.operatorText)
        .toContain(`set ${edits}`);
      await Bun.sleep(350);
      expect(store.inspectMission(prepared.id).events.filter((event) => event.kind === "mission.notification.delivered")).toHaveLength(0);
      const visibleStatus = await send("/mission status durable-fixture");
      expect(JSON.parse(visibleStatus.message).notifications).toContain("mission.revised: durable-fixture @2");
      expect(store.inspectMission(prepared.id).events.filter((event) => event.kind === "mission.notification.delivered")).toHaveLength(0);
      expect((await send("", undefined, visibleStatus.causalId)).ok).toBe(true);
      expect((await send("", undefined, visibleStatus.causalId)).ok).toBe(false);
      const deliveries = store.inspectMission(prepared.id).events.filter((event) => event.kind === "mission.notification.delivered");
      expect(deliveries.some((row) => (row.payload.eventIds as string[]).includes(
        revised.events.find((event) => event.kind === "mission.revised")!.eventId))).toBe(true);
      expect(notices.filter((text) => text.includes("mission.revised: durable-fixture @2"))).toHaveLength(1);
      await Bun.sleep(350);
      expect(notices.filter((text) => text.includes("mission.revised: durable-fixture @2"))).toHaveLength(1);
      await emit("session_shutdown");
      await emit("session_start");
      await Bun.sleep(350);
      expect(notices.filter((text) => text.includes("mission.revised: durable-fixture @2"))).toHaveLength(1);
      if (process.env.MISSION_T5_ARTIFACT_DIR) {
        mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
        writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "console-observed.json"), JSON.stringify({
          missionId: prepared.id, originalInputCausalId: preparedReply.causalId,
          originalText: prepared.events[0]?.payload.operatorText,
          deniedCredential: !credentialDenial.ok, deniedNativePi: notices.some((text) => text.includes("native Pi input is advisory")),
          deniedHypothetical: !hypotheticalDenial.ok,
          revision: store.inspectMission(prepared.id).revision,
          revisionEvents: store.inspectMission(prepared.id).events.filter((event) => event.kind === "mission.revised").length,
          notificationEvents: store.inspectMission(prepared.id).events.filter((event) => event.kind === "mission.notification.delivered")
            .map((event) => ({ throughSeq: event.payload.throughSeq, eventIds: event.payload.eventIds })),
          displayedRevisionCount: notices.filter((text) => text.includes("mission.revised: durable-fixture @2")).length,
          unauthorizedFileGoalIgnored: revised.definition.goal === prepared.definition.goal,
        }, null, 2));
      }
    } finally { store.close(); }
  } finally { await emit("session_shutdown"); }
});

test("foreground inspection and authorized revision interleave with a real local Pi SDK attempt", async () => {
  const fixture = createMissionFixture("t5-pi-"); dirs.push(fixture.base);
  const agentDir = path.join(fixture.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: () => "Local fixture result" });
  const definition = missionDefinition();
  definition.goal = "SDK interleaving fixture";
  definition.units[0]!.kind = "consultation";
  definition.budget = { roleLaunches: 6, providerRequests: 8, tokens: 1600, activeTimeMs: 120000, artifactBytes: 1024 * 1024 };
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  let assessed = 0;
  const runner = createPiMissionRunner({ cwd: fixture.root, executor: createPiExecutor(),
    load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
  const engine = new MissionEngine({ store, missionId: mission.id,
    sessionsDirectory: path.join(fixture.stateDir, "sessions"), runRole: async (input, durable) => {
      entered(); await gate; return runner(input, durable);
    }, assessPredicate: () => { assessed++; return { verdict: "pass", method: "local fixture" }; } });
  try {
    engine.start(); await waiting;
    const began = performance.now();
    const observed = engine.snapshot();
    const responseMs = performance.now() - began;
    expect(observed.units.snapshot?.status).toBe("running");
    expect(responseMs).toBeLessThan(1000);
    const before = store.inspectMission(mission.id);
    expect(before.revision).toBe(1);
    const revised = structuredClone(definition);
    revised.units[0]!.acceptance[0]!.expected = "new predicate";
    const receipt = operatorChangeReceipt(store, before, revised);
    const change = admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: before.version,
      planBytes: nextPlanBytes(before.planBytes), definitionBytes: Buffer.from(JSON.stringify(revised)), actor: "operator", receipt, claimedImpact: [] });
    expect(change.impact).toEqual(["snapshot"]);
    unblock();
    await engine.waitForIdle();
    const after = store.inspectMission(mission.id);
    expect(after.revision).toBe(2);
    expect(after.events.filter(({ kind }) => kind === "mission.revised")).toHaveLength(1);
    expect(after.events.some(({ kind, revision }) => kind === "unit.accepted" && revision === 1 && after.revision === 2)).toBe(false);
    expect(assessed).toBeLessThanOrEqual(1);
    if (process.env.MISSION_T5_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "sdk-revision-observed.json"), JSON.stringify({
        missionId: mission.id, foregroundResponseMs: responseMs, previousRevision: before.revision,
        currentRevision: after.revision, engineDerivedImpact: change.impact,
        staleAcceptanceCount: after.events.filter(({ kind, revision }) => kind === "unit.accepted" && revision === 1).length,
        oldDefinitionHash: before.snapshot.definitionHash,
        newDefinitionHash: after.snapshot.definitionHash,
        providerRequests: provider.trace.length, paidRequests: 0,
        priorSnapshotPreserved: store.readArtifact(before.snapshot.definitionHash).equals(before.definitionBytes),
      }, null, 2));
    }
  } finally { unblock(); await engine.close(); store.close(); }
}, 60000);
