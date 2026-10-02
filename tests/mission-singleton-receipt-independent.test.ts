import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { MissionEngine } from "../extensions/mission/engine.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";

test("receipt-before-seal denies singleton without relaunch while independent unit progresses on Node", async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  const sample = createMissionFixture("pitako-singleton-independent-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  try {
    mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const provider = await installMissionLocalProvider({ agentDir });
    const definition = missionDefinition();
    definition.units[0]!.inputs = ["evidence:a"];
    definition.units.push({ id: "audit", dependencies: [], kind: "check", role: "reviewer", inputs: [], outputs: ["note"],
      acceptance: [{ id: "audit-present", kind: "artifact_hash", target: "note" }], risk: "low", retryLimit: 0 });
    definition.finalization.requiredPredicates = ["snapshot-present", "audit-present"];
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
    definition.authority.rolePolicies.reviewer = { hash: "b".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
    definition.budget = { roleLaunches: 18, providerRequests: 18, tokens: 18000, activeTimeMs: 1080000, artifactBytes: 2_500_000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    await new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      runRole: async () => { throw new Error("prepared owner cannot launch"); } }).retireForShutdown("quit");
    store = undefined;
    const trace = path.join(sample.base, "trace.json");
    const killed = spawnSync(process.execPath, ["tests/fixtures/mission-singleton-crash-child.mjs",
      sample.dbPath, sample.objectDir, mission.id, sample.root, agentDir, trace, "receipt"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 40000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
    if (killed.signal !== "SIGKILL") throw new Error(`receipt not committed: ${killed.status} ${killed.stderr}`);
    expect(JSON.parse(readFileSync(trace, "utf8")).trace).toHaveLength(1);
    const node = spawnSync("node", ["scripts/mission-singleton-recovery-node.mjs", sample.dbPath, sample.objectDir,
      mission.id, sample.root, "independent"], { cwd: process.cwd(), encoding: "utf8", timeout: 40000 });
    if (node.status !== 0) throw new Error(node.stderr);
    const reopened = await openFixtureStore(sample);
    try {
      const events = reopened.inspectMission(mission.id).events;
      expect(events.filter(({ kind, unitId }) => kind === "attempt.reserved" && unitId === "snapshot")).toHaveLength(1);
      expect(events.find(({ kind, unitId }) => kind === "team.consultation.denied" && unitId === "snapshot")?.payload.reason)
        .toContain("terminal host proof is unavailable");
      expect(events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "snapshot")).toBe(false);
      expect(events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "audit")).toBe(true);
      expect(events.some(({ kind }) => kind === "team.consultation.admitted" || kind === "mission.completed")).toBe(false);
      expect(events.some(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation")).toBe(false);
    } finally { reopened.close(); }
  } finally {
    store?.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete (globalThis as Record<string, unknown>).__pitako_mission_local;
    rmSync(sample.base, { recursive: true, force: true });
  }
}, 90000);
