import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { MissionEngine, createPiMissionRunner } from "../extensions/mission/engine.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import { admitMissionChange, nextPlanBytes, pendingMissionQuestions } from "../extensions/mission/admission.ts";
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

test("UI-unavailable command and model tool cannot forge operator start; status remains callable", async () => {
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
  expect(messages.at(-1)).toContain("usable UI");
  await commands.get("mission")!("metrics --import-observations /tmp/worker-assessment.json", ctx);
  expect(messages.at(-1)).toContain("observation import requires the operator console");
  expect(tools.has("mission_start")).toBe(true);
  await expect(tools.get("mission_start").execute("call", { id: "durable-fixture" }, undefined, undefined, ctx))
    .rejects.toThrow("model tool cannot mint start authority");
});

function nativeFixture(fixture: ReturnType<typeof createMissionFixture>) {
  const handlers = new Map<string, Function[]>();
  let command!: Function;
  const notices: string[] = [], prompts: string[] = [];
  let answer: (message: string) => Promise<boolean> = async () => true;
  registerMissionExtension({
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    registerCommand: (_name: string, value: { handler: Function }) => { command = value.handler; },
    registerTool: () => {},
  } as any);
  let sessionId = "native-principal";
  const ctx = { mode: "tui", cwd: fixture.root, hasUI: true, sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (text: string) => notices.push(text), confirm: async (_title: string, message: string) => {
      prompts.push(message); return answer(message);
    }, input: async (_title: string, _placeholder?: string) => 'Change predicate snapshot-present target to "native target"' } };
  return { ctx, notices, prompts, command: (args: string) => command(args, ctx),
    answer: (value: typeof answer) => { answer = value; }, session: (value: string) => { sessionId = value; },
    emit: async (name: string, event = { reason: "quit" }) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); } };
}

function nativeConsoleInput(host: ReturnType<typeof nativeFixture>, text: string, visibleId?: string) {
  const socket = host.notices.find((message) => message.startsWith("Mission operator console:"))!.split(" ").at(-1)!;
  return new Promise<{ ok: boolean; message: string; causalId: string }>((resolve, reject) => {
    const peer = connect(socket); let data = "";
    peer.on("connect", () => peer.write(JSON.stringify({ proof: readFileSync(`${socket}.key`).toString("hex"), text, visibleId }) + "\n"));
    peer.on("data", (part) => { data += part; });
    peer.on("end", () => resolve(JSON.parse(data))); peer.on("error", reject);
  });
}

test.each(["decline", "dismiss", "source", "source-revision", "source-identity", "definition", "definition-identity", "root", "session", "shutdown", "switch", "child", "rpc", "ui"] as const)(
  "native prepare %s cannot acquire ownership or persist a mission", async (scenario) => {
    const fixture = createMissionFixture(`native-${scenario}-`); dirs.push(fixture.base);
    process.env.PI_CODING_AGENT_DIR = fixture.stateDir;
    const host = nativeFixture(fixture);
    if (scenario === "child") process.env.PITAKO_INSTANCE_ID = "child";
    if (scenario === "rpc") host.ctx.mode = "rpc";
    if (scenario === "ui") host.ctx.hasUI = false;
    host.answer(async () => {
      if (scenario === "decline") return false;
      if (scenario === "dismiss") return undefined as unknown as boolean;
      if (scenario === "source") writeFileSync(fixture.planFile, readFileSync(fixture.planFile, "utf8") + "\nsource drift");
      if (scenario === "source-revision") writeFileSync(fixture.planFile, readFileSync(fixture.planFile, "utf8").replace("revision: 1", "revision: 2"));
      if (scenario === "definition") writeFileSync(fixture.definitionFile, JSON.stringify({ ...missionDefinition(), goal: "file drift" }));
      if (scenario === "source-identity" || scenario === "definition-identity") {
        const file = scenario === "source-identity" ? fixture.planFile : fixture.definitionFile;
        writeFileSync(`${file}.replacement`, readFileSync(file));
        renameSync(`${file}.replacement`, file);
      }
      if (scenario === "root") {
        const backup = `${fixture.root}-old`;
        renameSync(fixture.root, backup); mkdirSync(fixture.root);
        for (const entry of [".git", ".pitako"]) renameSync(path.join(backup, entry), path.join(fixture.root, entry));
      }
      if (scenario === "session") host.session("other-session");
      if (scenario === "shutdown") await host.emit("session_shutdown");
      if (scenario === "switch") await host.emit("session_before_switch");
      return true;
    });
    try {
      await host.emit("session_start");
      await host.command("help");
      expect(existsSync(path.join(fixture.stateDir, "pitako", "missions.db"))).toBe(false);
      if (scenario === "ui") await expect(host.command("prepare-file durable-fixture")).rejects.toThrow("usable UI");
      else await host.command("prepare-file durable-fixture");
      expect(existsSync(path.join(fixture.stateDir, "pitako", "missions.db"))).toBe(false);
      expect(existsSync(path.join(fixture.stateDir, "pitako", "console"))).toBe(false);
      if (!["child", "rpc", "ui"].includes(scenario)) expect(host.prompts).toHaveLength(1);
      else expect(host.prompts).toHaveLength(0);
    } finally { delete process.env.PITAKO_INSTANCE_ID; await host.emit("session_shutdown"); }
  });

test("replacement confirmation invalidates prior prompt; native prepare and typed revise preserve exact provenance", async () => {
  const fixture = createMissionFixture("native-replace-"); dirs.push(fixture.base);
  process.env.PI_CODING_AGENT_DIR = fixture.stateDir;
  const host = nativeFixture(fixture);
  let finish!: (accepted: boolean) => void;
  host.answer(() => new Promise((resolve) => { finish = resolve; }));
  const first = host.command("prepare-file durable-fixture");
  for (let i = 0; i < 100 && !finish; i++) await Bun.sleep(1);
  expect(finish).toBeFunction();
  host.answer(async () => false);
  await host.command("prepare-file durable-fixture");
  finish(true);
  await first;
  expect(existsSync(path.join(fixture.stateDir, "pitako", "missions.db"))).toBe(false);
  host.answer(async () => true);
  try {
    await host.command("prepare-file durable-fixture");
    const reader = await openFixtureStore(fixture);
    try {
      const mission = reader.findManagedMission(fixture.root)!;
      expect(mission.events.some(({ kind }) => kind === "mission.activated")).toBe(false);
      expect(mission.events[0]?.payload.operatorReceipt).toMatchObject({ source: "native-confirmation", sessionId: "native-principal" });
      const before = reader.ownershipIdentity;
      const eventCount = mission.events.length;
      await host.command("status");
      expect(reader.ownershipIdentity).toEqual(before);
      expect(reader.inspectMission(mission.id).events).toHaveLength(eventCount);
      await host.command("revise durable-fixture");
      const revised = reader.inspectMission(mission.id);
      expect(revised.revision).toBe(2);
      expect(revised.definition.units[0]!.acceptance[0]!.target).toBe("native target");
      expect(revised.events.find(({ kind }) => kind === "mission.revised")?.payload.operatorReceipt).toMatchObject({ source: "native-confirmation" });
      const preview = JSON.parse(host.prompts.at(-1)!);
      expect(preview.choice.edits[0]).toEqual({ target: { kind: "predicate", id: "snapshot-present", field: "target" },
        before: mission.definition.units[0]!.acceptance[0]!.target, after: "native target" });
      await host.command("pause durable-fixture");
      expect(reader.inspectMission(mission.id).state).toBe("paused");
      await host.command("cancel durable-fixture");
      expect(reader.inspectMission(mission.id).state).toBe("cancelled");
    } finally { reader.close(); }
  } finally { await host.emit("session_shutdown"); }
});

test.each(["revision", "prepare-revision", "telemetry"] as const)("native confirmation revalidates %s without rejecting unrelated display telemetry", async (scenario) => {
  const fixture = createMissionFixture(`native-${scenario}-`); dirs.push(fixture.base);
  process.env.PI_CODING_AGENT_DIR = fixture.stateDir;
  const host = nativeFixture(fixture);
  await host.command("prepare-file durable-fixture");
  await host.command("console");
  const send = (text: string, visibleId?: string) => nativeConsoleInput(host, text, visibleId);
  const reader = await openFixtureStore(fixture);
  const mission = reader.findManagedMission(fixture.root)!;
  const promptCount = host.prompts.length;
  host.answer(async () => {
    if (scenario !== "telemetry") expect((await send('/mission revise durable-fixture Change predicate snapshot-present target to "console target"')).ok).toBe(true);
    else {
      const reply = await send("/mission status durable-fixture");
      expect(reply.ok).toBe(true);
      expect((await send("", reply.causalId)).ok).toBe(true);
    }
    return true;
  });
  try {
    await host.command(scenario === "prepare-revision" ? "prepare-file durable-fixture" : 'revise durable-fixture Change predicate snapshot-present target to "native target"');
    const after = reader.inspectMission(mission.id);
    expect(host.prompts).toHaveLength(promptCount + 1);
    expect(after.revision).toBe(2);
    expect(after.definition.units[0]!.acceptance[0]!.target).toBe(scenario === "telemetry" ? "native target" : "console target");
    expect(after.events.filter(({ kind }) => kind === "mission.revised")).toHaveLength(1);
    expect(after.events.find(({ kind }) => kind === "mission.revised")?.payload.operatorReceipt)
      .toMatchObject({ source: scenario === "telemetry" ? "native-confirmation" : "console" });
    if (scenario !== "telemetry") expect(host.notices.at(-1)).toContain("changed");
    else expect(after.events.some(({ kind }) => kind === "mission.input.visible")).toBe(true);
  } finally { reader.close(); await host.emit("session_shutdown"); }
});

test.each([
  { action: "answer", before: "snapshot", after: "native target" },
  { action: "answer", before: "use -- flag", after: "native target" },
  { action: "answer", before: "snapshot", after: "use -- flag" },
  { action: "natural-answer", before: "snapshot", after: "native target" },
  { action: "withdraw", before: "snapshot", after: "native target" },
] as const)("native $action ($before → $after) preserves bounded pending choice rules without authored engine edits JSON", async ({ action, before, after }) => {
  const fixture = createMissionFixture(`native-${action}-`); dirs.push(fixture.base);
  process.env.PI_CODING_AGENT_DIR = fixture.stateDir;
  const definition = missionDefinition();
  definition.units[0]!.acceptance[0]!.target = before;
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const host = nativeFixture(fixture);
  await host.command("prepare-file durable-fixture");
  await host.command("console");
  const reader = await openFixtureStore(fixture);
  const mission = reader.findManagedMission(fixture.root)!;
  const delta = [{ op: "replace", path: "/units/0/acceptance/0/target",
    before: mission.definition.units[0]!.acceptance[0]!.target, after }];
  // Keep the console's delimiter unambiguous; the native UI below emits ordinary JSON spaces.
  const question = await nativeConsoleInput(host, `/mission revise durable-fixture durable-fixture review this snapshot predicate -- ${JSON.stringify(delta).replaceAll(" -- ", "\\u0020--\\u0020")}`);
  expect(question).toMatchObject({ ok: true });
  expect(pendingMissionQuestions(reader.inspectMission(mission.id).events, reader)[0]?.bindings)
    .toEqual([{ kind: "predicate", id: "snapshot-present", field: "target", owner: "snapshot", value: before }]);
  const values: string[] = [];
  host.ctx.ui.input = async (title, placeholder) => { values.push(`${title}: ${placeholder}`); return JSON.stringify(after); };
  const inputCount = reader.inspectMission(mission.id).events.filter(({ kind }) => kind === "mission.input.recorded").length;
  const promptCount = host.prompts.length;
  try {
    await host.command(`revise durable-fixture ${action === "natural-answer" ? `answer ${question.causalId} Change predicate snapshot-present target to "native target"` : `${action} ${question.causalId}`}`);
    const current = reader.inspectMission(mission.id);
    expect(pendingMissionQuestions(current.events, reader)).toHaveLength(0);
    expect(host.prompts).toHaveLength(promptCount + 1);
    expect(current.revision).toBe(action === "withdraw" ? 1 : 2);
    expect(current.events.find(({ kind, payload }) => action === "withdraw" ? kind === "mission.input.recorded" && payload.disposition === "withdrawn" : kind === "mission.revised")?.payload.operatorReceipt)
      .toMatchObject({ source: "native-confirmation", choice: { kind: action === "withdraw" ? "withdraw" : "answer", questionId: question.causalId } });
    expect(values).toHaveLength(action === "answer" ? 1 : 0);
    if (action === "answer") expect(values[0]).toContain("Current:");
    if (action !== "withdraw") {
      expect(current.definition.units[0]!.acceptance[0]!.target).toBe(after);
      expect(current.events.filter(({ kind }) => kind === "mission.input.recorded")).toHaveLength(inputCount);
      expect(current.events.filter(({ kind }) => kind === "mission.revised")).toHaveLength(1);
    }
  } finally { reader.close(); await host.emit("session_shutdown"); }
});

test("prepared native authority retires on reload; status does not reacquire or start it", async () => {
  const fixture = createMissionFixture("native-prepared-reload-"); dirs.push(fixture.base);
  process.env.PI_CODING_AGENT_DIR = fixture.stateDir;
  const host = nativeFixture(fixture);
  await host.command("prepare-file durable-fixture");
  await host.emit("session_shutdown", { reason: "reload" });
  await host.emit("session_start", { reason: "reload" });
  await host.command("status");
  const reader = await openMissionStore({ dbPath: fixture.dbPath, objectDir: fixture.objectDir, readOnly: true });
  try {
    const mission = reader.findManagedMission(fixture.root)!;
    expect(mission.state).toBe("prepared");
    expect(reader.ownershipIdentity.claimId).toBe("");
    expect(reader.ownershipIdentity.epoch).toBe(1);
    expect(mission.events.some(({ kind }) => ["mission.activated", "attempt.reserved"].includes(kind))).toBe(false);
    expect(existsSync(path.join(fixture.stateDir, "pitako", "console"))).toBe(false);
    await host.command('revise durable-fixture Change predicate snapshot-present target to "after reload"');
    expect(host.notices.at(-1)).toContain("Revision 2");
    expect(reader.inspectMission(mission.id).revision).toBe(2);
    expect(reader.ownershipIdentity.epoch).toBe(2);
  } finally { reader.close(); await host.emit("session_shutdown", { reason: "quit" }); }
});

test.each(["ownership", "generation", "state"] as const)("native action rejects changed %s before acquiring a writer", async (scenario) => {
  const fixture = createMissionFixture(`native-${scenario}-`); dirs.push(fixture.base);
  process.env.PI_CODING_AGENT_DIR = fixture.stateDir;
  const external = await openFixtureStore(fixture);
  const mission = external.createMission(missionInput(fixture));
  const engine = new MissionEngine({ store: external, missionId: mission.id, ownerSessionId: "other-principal",
    sessionsDirectory: path.join(fixture.stateDir, "sessions"), runRole: async () => { throw new Error("must not dispatch"); } });
  const host = nativeFixture(fixture);
  let replacement: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  host.answer(async () => {
    if (scenario === "ownership") {
      await engine.retireForShutdown("quit");
      replacement = await openFixtureStore(fixture);
      expect(replacement.ownerEpoch).toBeGreaterThan(1);
    } else {
      const current = external.inspectMission(mission.id);
      external.appendTransition(mission.id, current.version, { events: [{ revision: current.revision,
        kind: scenario === "generation" ? "mission.finalization.generation" : "mission.paused",
        causalId: crypto.randomUUID(), payload: scenario === "generation" ? { generation: 1 } : { reason: "other principal", controlOrigin: "operator" } }] });
    }
    return true;
  });
  try {
    await host.command('revise durable-fixture Change predicate snapshot-present target to "native target"');
    const reader = replacement ?? external;
    const current = reader.inspectMission(mission.id);
    expect(current.revision).toBe(1);
    expect(current.events.some(({ kind }) => kind === "mission.revised")).toBe(false);
    expect(host.notices.at(-1)).toContain("changed");
    expect(host.prompts).toHaveLength(1);
  } finally {
    await host.emit("session_shutdown");
    if (!replacement) await engine.close();
    replacement?.close(); external.close();
  }
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
  expect(notices.some((text) => text.startsWith("Mission operator console:"))).toBe(false);
  await commands.get("mission")!("console", ctx);
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
    expect(notices.at(-1)).toContain("principal TUI session");
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
          deniedCredential: !credentialDenial.ok, deniedNativePi: notices.some((text) => text.includes("principal TUI session")),
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
