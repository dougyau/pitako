import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { MissionEngine } from "../extensions/mission/engine.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";

for (const condition of ["failed-receipt", "source-drift"] as const) test(`sealed singleton denies ${condition} after Node owner death`, async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  const sample = createMissionFixture(`pitako-singleton-${condition}-`);
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  try {
    mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
    mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src", "target.txt"), "source\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const provider = await installMissionLocalProvider({ agentDir });
    const definition = missionDefinition();
    definition.units[0]!.inputs = ["evidence:a"];
    definition.authority.operations = ["bash"];
    definition.authority.allowedPaths = ["src/**"];
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
    definition.budget = { roleLaunches: 18, providerRequests: 18, tokens: 18000, activeTimeMs: 1080000, artifactBytes: 2_500_000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    await new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      runRole: async () => { throw new Error("prepared owner cannot launch"); } }).retireForShutdown("quit");
    store = undefined;
    const child = spawnSync(process.execPath, ["tests/fixtures/mission-singleton-crash-child.mjs",
      sample.dbPath, sample.objectDir, mission.id, sample.root, agentDir, path.join(sample.base, "provider-trace.json"),
      "seal", condition === "failed-receipt" ? "bash-failed" : "bash"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 40000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
    if (child.signal !== "SIGKILL") throw new Error(`seed did not seal: ${child.status} ${child.stderr}`);
    if (condition === "source-drift") writeFileSync(path.join(sample.root, "src", "target.txt"), "external change\n");
    const node = spawnSync("node", ["scripts/mission-singleton-recovery-node.mjs", sample.dbPath, sample.objectDir,
      mission.id, sample.root, "run"], { cwd: process.cwd(), encoding: "utf8", timeout: 40000 });
    if (node.status !== 0) throw new Error(node.stderr);
    const final = await openFixtureStore(sample);
    try {
      const events = final.inspectMission(mission.id).events;
      expect(events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
      expect(events.filter(({ kind }) => kind === "team.consultation.admitted")).toHaveLength(0);
      expect(events.filter(({ kind }) => kind === "team.consultation.revalidated")).toHaveLength(0);
      expect(events.some(({ kind }) => kind === "unit.accepted")).toBe(false);
      expect(events.some(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation")).toBe(true);
      if (condition === "failed-receipt") {
        expect(events.find(({ kind }) => kind === "effect.receipt")?.payload.status).toBe("failed");
        expect(events.some(({ kind, payload }) => kind === "effect.observation.recorded" && payload.disposition === "unknown")).toBe(true);
      }
    } finally { final.close(); }
  } finally {
    store?.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete (globalThis as Record<string, unknown>).__pitako_mission_local;
    rmSync(sample.base, { recursive: true, force: true });
  }
}, 90000);
