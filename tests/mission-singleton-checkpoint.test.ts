import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import agentExtension from "../extensions/agent/index.ts";
import { createPiMissionRunner, MissionEngine } from "../extensions/mission/engine.ts";
import { readSealedWorkspaceImage } from "../extensions/mission/reconcile.ts";
import { PhysicalObservation } from "../extensions/mission/physical-observation.ts";
import { currentProcessIdentity } from "../extensions/mission/workspace.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const request = JSON.stringify({ format: "mission-consultation-request-v1", question: "Review exact candidate",
  evidenceRefs: ["evidence:a"], members: ["one", "two", "three"].map((id) => ({ id, role: "developer", perspective: id })),
  synthesisRole: "developer" });

test.each(["current-ticks", "control-during-await", "result-during-await"] as const)(
  "SDK-disposed managed Developer write seals a terminal checkpoint without admitting consultation or acceptance: %s", async (scenario) => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  const sample = createMissionFixture("pitako-singleton-checkpoint-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let engine: MissionEngine | undefined;
  const observe = PhysicalObservation.prototype.request;
  let terminalObservations = 0;
  let markers = 0;
  try {
    mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
    mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src", "target.txt"), "source sentinel\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: () => request });
    const definition = missionDefinition();
    definition.units[0]!.inputs = ["evidence:a"];
    definition.authority.operations = ["write"];
    definition.authority.allowedPaths = ["src/**"];
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
    definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 2000, activeTimeMs: 240000, artifactBytes: 2_000_000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    PhysicalObservation.prototype.request = async function<T>(operation: string, input: unknown,
      signal?: AbortSignal, deadline?: number): Promise<T> {
      if (operation !== "seal" || terminalObservations ||
        !store!.inspectMission(mission.id).events.some(({ kind }) => kind === "attempt.receipt"))
        return (observe<T>).call(this, operation, input, signal, deadline);
      terminalObservations++;
      const timer = setInterval(() => { markers++; }, 1);
      try {
        const result = await (observe<T>).call(this, operation, input, signal, deadline);
        const current = store!.inspectMission(mission.id);
        store!.appendTransition(mission.id, current.version, { events: [{
          revision: current.revision, kind: scenario === "current-ticks" ? "mission.notification.delivered" :
            scenario === "control-during-await" ? "mission.import.conflict" : "mission.finalization.generation",
          causalId: randomUUID(), payload: scenario === "result-during-await"
            ? { generation: 1, reason: "concurrent result generation" } : { reason: "concurrent frontier observation" },
        }] });
        return result;
      } finally { clearInterval(timer); }
    };
    const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
      runRole: async (input, durable) => {
        expect(durable.readOnly).toBe(false);
        const effect = await durable.effects!.invoke("write", { path: "src/target.txt", content: "private candidate\n" });
        if (effect.status !== "completed") throw new Error(`effect failed: ${effect.stderr}`);
        return runner(input, durable);
      }, assessPredicate: () => { throw new Error("request cannot be assessed as predicate"); } });
    engine.start(); await engine.waitForIdle();
    const inspection = store.inspectMission(mission.id);
    const receipt = inspection.events.find(({ kind }) => kind === "attempt.receipt")!;
    const seal = inspection.events.find(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation")!;
    expect(terminalObservations).toBe(1);
    expect(markers).toBeGreaterThan(0);
    expect(provider.trace).toHaveLength(1);
    expect(receipt.payload).toMatchObject({ status: "completed", quiescent: false });
    if (scenario !== "current-ticks") {
      expect(seal).toBeUndefined();
      expect(inspection.events.some(({ kind }) => kind === "team.consultation.admitted" ||
        kind === "unit.accepted" || kind === "mission.completed")).toBe(false);
      expect(String(inspection.events.find(({ kind }) => kind === "team.consultation.denied")?.payload.reason))
        .toContain("workspace observation owner, control or result changed during await");
      return;
    }
    expect(seal).toBeDefined();
    const proofBytes = store.readArtifact(String(seal.payload.checkpointHash));
    expect(sha(proofBytes)).toBe(String(seal.payload.checkpointHash));
    const proof = JSON.parse(proofBytes.toString());
    expect(proof).toMatchObject({ format: "mission-consultation-checkpoint-v1", sourceAttemptId: receipt.attemptId,
      receiptEventId: receipt.eventId, receiptHash: sha(Buffer.from(JSON.stringify(receipt.payload))),
      requestHash: receipt.payload.artifactHash, imageHash: seal.payload.imageHash, sdkDisposed: true, effectsShutdown: true });
    expect(proof.effects).toHaveLength(1);
    expect(proof.effects[0].witnesses.map(({ kind }: { kind: string }) => kind)).toContain("effect.receipt");
    const image = readSealedWorkspaceImage(store, String(seal.payload.imageHash));
    expect(image.files.find(({ path }) => path === "src/target.txt")?.bytes?.toString()).toBe("private candidate\n");
    expect(readFileSync(path.join(sample.root, "src", "target.txt"), "utf8")).toBe("source sentinel\n");
    expect(inspection.events.find(({ kind }) => kind === "team.consultation.denied")?.payload).toMatchObject({
      checkpointHash: seal.payload.checkpointHash,
      reason: expect.stringContaining("consultation minimum"),
    });
    expect(inspection.events.some(({ kind }) => kind === "team.consultation.admitted" || kind === "unit.accepted" || kind === "mission.completed")).toBe(false);
    process.env.PI_CODING_AGENT_DIR = sample.stateDir;
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
    const result = await tools.get("team_result")!.execute("read", { assignmentId: receipt.attemptId },
      new AbortController().signal, undefined, { cwd: sample.root });
    expect(result.isError).toBe(true);
    expect(result.details.resultAvailable).toBe(false);
    expect(result.content[0].text).not.toContain("mission-consultation-request-v1");
    await engine.retireForShutdown("quit"); engine = undefined; store = undefined;
    const node = spawnSync("node", ["scripts/mission-singleton-checkpoint-node.mjs", sample.dbPath, sample.objectDir,
      mission.id, String(seal.payload.checkpointHash), sample.root], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
    expect(node.status).toBe(0);
    expect(JSON.parse(node.stdout).checkpoint).toBe(seal.payload.checkpointHash);
    const reopened = await openFixtureStore(sample);
    try {
      const persisted = reopened.inspectMission(mission.id);
      expect(persisted.events.find(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation")?.payload.checkpointHash)
        .toBe(seal.payload.checkpointHash);
      expect(readSealedWorkspaceImage(reopened, String(seal.payload.imageHash)).files.find(({ path }) => path === "src/target.txt")?.bytes?.toString())
        .toBe("private candidate\n");
      expect(persisted.events.some(({ kind }) => kind === "unit.accepted")).toBe(false);
    } finally { reopened.close(); }
  } finally {
    PhysicalObservation.prototype.request = observe;
    await engine?.retireForShutdown("quit"); store?.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete (globalThis as Record<string, unknown>).__pitako_mission_local;
    rmSync(sample.base, { recursive: true, force: true });
  }
}, 90000);

test("a sibling receipt cannot deny a live singleton while its SDK-disposed checkpoint awaits effects shutdown", async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  const sample = createMissionFixture("pitako-singleton-concurrent-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  const shutdownEntered = Promise.withResolvers<void>();
  const releaseShutdown = Promise.withResolvers<void>();
  const assessed: string[] = [];
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let engine: MissionEngine | undefined;
  try {
    mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
    mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src", "target.txt"), "source sentinel\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: () => request });
    const definition = missionDefinition();
    definition.units[0]!.id = "impl";
    definition.units[0]!.kind = "implementation";
    definition.units[0]!.inputs = ["evidence:a"];
    definition.units[0]!.acceptance[0]!.id = "impl-present";
    definition.units.push({ id: "audit", dependencies: [], kind: "check", role: "reviewer", inputs: [], outputs: ["note"],
      acceptance: [{ id: "audit-present", kind: "artifact_hash", target: "note" }], risk: "low", retryLimit: 0 });
    definition.finalization.requiredPredicates = ["impl-present", "audit-present"];
    definition.authority.operations = ["write"];
    definition.authority.allowedPaths = ["src/**"];
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
    definition.authority.rolePolicies.reviewer = { hash: "b".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
    definition.budget = { roleLaunches: 8, providerRequests: 8, tokens: 8000, activeTimeMs: 480000, artifactBytes: 4_000_000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
      runRole: async (input, durable) => {
        if (input.unit.id === "audit") {
          await shutdownEntered.promise;
          return { instanceId: input.binding.attemptId, role: "reviewer", status: "completed",
            model: { selectedModel: "fixture/local" }, result: "audit-ok" };
        }
        const result = await runner(input, durable);
        const effect = await durable.effects!.invoke("write", { path: "src/target.txt", content: "private candidate\n" });
        if (effect.status !== "completed") throw new Error(`write failed: ${effect.stderr}`);
        const shutdown = durable.effects!.shutdown.bind(durable.effects);
        durable.effects!.shutdown = async () => { shutdownEntered.resolve(); await releaseShutdown.promise; await shutdown(); };
        return result;
      }, assessPredicate: ({ unit, resultArtifact }) => {
        assessed.push(unit.id);
        return { verdict: unit.id === "audit" && resultArtifact.toString() === "audit-ok" ? "pass" : "fail", method: "independent audit" };
      } });
    engine.start();
    await shutdownEntered.promise;
    const deadline = Date.now() + 10_000;
    while (!store.inspectMission(mission.id).events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "audit")) {
      if (Date.now() > deadline) throw new Error("independent audit did not accept while checkpoint was pending");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending = store.inspectMission(mission.id).events;
    const implId = pending.find(({ kind, unitId }) => kind === "attempt.receipt" && unitId === "impl")?.attemptId;
    expect(implId).toBeDefined();
    expect(pending.some(({ kind, attemptId }) => attemptId === implId &&
      (kind === "team.consultation.denied" || kind === "attempt.settled"))).toBe(false);
    expect(pending.some(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation")).toBe(false);
    releaseShutdown.resolve();
    await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    const receipt = events.find(({ kind, unitId }) => kind === "attempt.receipt" && unitId === "impl")!;
    const seal = events.find(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation")!;
    const denied = events.find(({ kind }) => kind === "team.consultation.denied")!;
    const settled = events.find(({ kind, attemptId }) => kind === "attempt.settled" && attemptId === receipt.attemptId)!;
    expect(provider.trace).toHaveLength(1);
    expect(assessed).toEqual(["audit"]);
    expect(receipt.payload).toMatchObject({ status: "completed", quiescent: false });
    expect(seal).toBeDefined();
    expect(seal.seq).toBeLessThan(denied.seq);
    expect(denied.seq).toBeLessThan(settled.seq);
    expect(denied.payload.checkpointHash).toBe(seal.payload.checkpointHash);
    expect(readSealedWorkspaceImage(store, String(seal.payload.imageHash)).files.find(({ path }) => path === "src/target.txt")?.bytes?.toString())
      .toBe("private candidate\n");
    expect(readFileSync(path.join(sample.root, "src", "target.txt"), "utf8")).toBe("source sentinel\n");
    expect(events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "audit")).toBe(true);
    expect(events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "impl" ||
      kind === "team.consultation.admitted" || kind === "mission.completed")).toBe(false);
    process.env.PI_CODING_AGENT_DIR = sample.stateDir;
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
    const teamResult = await tools.get("team_result")!.execute("read", { assignmentId: receipt.attemptId },
      new AbortController().signal, undefined, { cwd: sample.root });
    expect(teamResult.isError).toBe(true);
    expect(teamResult.details.resultAvailable).toBe(false);
    expect(teamResult.content[0].text).not.toContain("mission-consultation-request-v1");
  } finally {
    releaseShutdown.resolve();
    await engine?.retireForShutdown("quit"); store?.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete (globalThis as Record<string, unknown>).__pitako_mission_local;
    rmSync(sample.base, { recursive: true, force: true });
  }
}, 90000);

test("callback before SDK disposal and an uncertain effect cannot mint a singleton checkpoint", async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  for (const uncertainty of [false, true]) {
    const sample = createMissionFixture("pitako-singleton-denial-");
    let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
    let engine: MissionEngine | undefined;
    try {
      const definition = missionDefinition();
      definition.units[0]!.inputs = ["evidence:a"];
      definition.authority.allowedPaths = ["src/**"];
      definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 2000, activeTimeMs: 240000, artifactBytes: 2_000_000 };
      writeFileSync(sample.definitionFile, JSON.stringify(definition));
      store = await openFixtureStore(sample);
      const mission = store.createMission(missionInput(sample));
      engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
        managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
        runRole: async ({ binding }, durable) => {
          if (uncertainty) {
            const now = store!.inspectMission(mission.id);
            store!.appendTransition(mission.id, now.version, { events: [{ revision: now.revision, kind: "effect.intent",
              causalId: randomUUID(), unitId: binding.unitId, attemptId: binding.attemptId, effectId: randomUUID(),
              payload: { operation: "bash", attemptId: binding.attemptId, recovery: "local-observation-required" } }] });
          }
          durable.onOutcome?.({ instanceId: binding.attemptId, role: "developer", status: "completed",
            model: { selectedModel: "fixture/local" }, result: request });
          throw new Error("SDK did not return a disposed session");
        } });
      engine.start(); await engine.waitForIdle();
      const events = store.inspectMission(mission.id).events;
      expect(events.some(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation")).toBe(false);
      expect(events.find(({ kind }) => kind === "team.consultation.denied")?.payload.reason).toContain("unproven");
      expect(events.some(({ kind }) => kind === "unit.accepted" || kind === "team.consultation.admitted")).toBe(false);
      await engine.retireForShutdown("quit"); engine = undefined; store = undefined;
      const node = spawnSync("node", ["scripts/mission-singleton-checkpoint-node.mjs", sample.dbPath, sample.objectDir,
        mission.id, "none"], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
      expect(node.status).toBe(0);
      expect(JSON.parse(node.stdout).checkpoint).toBeNull();
    } finally { await engine?.retireForShutdown("quit"); store?.close(); rmSync(sample.base, { recursive: true, force: true }); }
  }
}, 90000);
