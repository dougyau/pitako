import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { MissionEngine, type MissionAttemptBinding } from "../extensions/mission/engine.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";

test("Node owner-death recovery preserves an SDK-produced completed Bash receipt", async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  const sample = createMissionFixture("pitako-singleton-recovery-");
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  const previous = process.env.PI_CODING_AGENT_DIR;
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
    await new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(path.dirname(sample.dbPath), "sessions"),
      runRole: async () => { throw new Error("prepared owner cannot launch"); } }).retireForShutdown("quit");
    store = undefined;
    const traceFile = path.join(sample.base, "provider-trace.json");
    const killed = spawnSync(process.execPath, ["tests/fixtures/mission-singleton-crash-child.mjs",
      sample.dbPath, sample.objectDir, mission.id, sample.root, agentDir, traceFile, "seal", "bash"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 40000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
    if (killed.signal !== "SIGKILL") throw new Error(`seed did not reach seal: ${killed.status} ${killed.stderr}`);
    expect(JSON.parse(readFileSync(traceFile, "utf8")).trace).toHaveLength(1);
    const readOnly = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    const initial = readOnly.inspectMission(mission.id);
    const sourceBinding = initial.events.find(({ kind }) => kind === "attempt.reserved")!.payload.binding as MissionAttemptBinding;
    const protectedIds = initial.events.filter(({ kind, payload }) => kind === "reservation.created" &&
      payload.purpose === "protected").map(({ payload }) => payload.reservationId);
    expect(initial.events.find(({ kind }) => kind === "effect.receipt")?.payload).toMatchObject({ status: "completed", exitCode: 0 });
    expect(initial.events.some(({ kind }) => kind === "team.consultation.admitted")).toBe(false);
    expect(initial.events.some(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation")).toBe(true);
    readOnly.close();
    expect(sourceBinding.candidateRoot?.startsWith(path.join(sample.base, "candidates") + path.sep)).toBe(true);
    rmSync(sourceBinding.candidateRoot!, { recursive: true, force: true });
    const interrupted = spawnSync("node", ["scripts/mission-singleton-recovery-node.mjs", sample.dbPath, sample.objectDir,
      mission.id, sample.root, "before-use-cut"], { cwd: process.cwd(), encoding: "utf8", timeout: 40000 });
    if (interrupted.signal !== "SIGKILL") throw new Error(`recovery did not reach first use: ${interrupted.status} ${interrupted.stderr} ${interrupted.stdout}`);
    const admitted =  spawnSync("node", ["scripts/mission-singleton-recovery-node.mjs", sample.dbPath, sample.objectDir,
      mission.id, sample.root, "admit-cut"], { cwd: process.cwd(), encoding: "utf8", timeout: 40000 });
    if (admitted.signal !== "SIGKILL") throw new Error(`admission did not commit: ${admitted.status} ${admitted.stderr} ${admitted.stdout}`);
    const secondUse = spawnSync("node", ["scripts/mission-singleton-recovery-node.mjs", sample.dbPath, sample.objectDir,
      mission.id, sample.root, "use-cut"], { cwd: process.cwd(), encoding: "utf8", timeout: 40000 });
    if (secondUse.signal !== "SIGKILL") throw new Error(`second owner did not revalidate: ${secondUse.status} ${secondUse.stderr} ${secondUse.stdout}`);
    const final = await openFixtureStore(sample);
    try {
      const events = final.inspectMission(mission.id).events;
      expect(events.filter(({ kind, payload }) => kind === "effect.reconciled" && payload.disposition === "applied")).toHaveLength(1);
      expect(events.some(({ kind, payload }) => kind === "effect.observation.recorded" && payload.disposition === "unknown")).toBe(false);
      expect(events.filter(({ kind }) => kind === "team.consultation.admitted")).toHaveLength(1);
      expect(events.filter(({ kind }) => kind === "team.consultation.revalidated")).toHaveLength(2);
      expect(events.filter(({ kind, payload }) => kind === "attempt.settled" && payload.status === "yielded")).toHaveLength(1);
      const admission = events.find(({ kind }) => kind === "team.consultation.admitted")!;
      const yieldEvent = events.find(({ kind, payload }) => kind === "attempt.settled" && payload.status === "yielded")!;
      const minimum = events.filter(({ kind, seq }) => kind === "reservation.created" && seq > yieldEvent.seq && seq < admission.seq);
      expect(minimum.map(({ payload }) => payload.resource).sort()).toEqual([
        "active-time-ms", "artifact-bytes", "provider-requests", "role-launches", "tokens",
      ]);
      const minimumIds = new Set(minimum.map(({ payload }) => payload.reservationId));
      expect(events.filter(({ kind, payload }) => kind === "budget.reservation.adjusted" &&
        minimumIds.has(payload.reservationId))).toHaveLength(0);
      expect(events.filter(({ kind, payload }) => kind === "reservation.created" &&
        payload.purpose === "protected").map(({ payload }) => payload.reservationId)).toEqual(protectedIds);
      expect(events.some(({ kind, payload }) => kind === "budget.reservation.adjusted" &&
        protectedIds.includes(payload.reservationId))).toBe(false);
      expect(events.filter(({ kind }) => kind === "provider.request.dispatched")).toHaveLength(1);
      expect(events.filter(({ kind }) => kind === "effect.intent")).toHaveLength(1);
      expect(events.filter(({ kind }) => kind === "effect.receipt")).toHaveLength(1);
      expect(events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
      expect(readFileSync(path.join(sample.root, "src", "target.txt"), "utf8")).toBe("source\n");
    } finally { final.close(); }
  } finally {
    store?.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete (globalThis as Record<string, unknown>).__pitako_mission_local;
    rmSync(sample.base, { recursive: true, force: true });
  }
}, 90000);
