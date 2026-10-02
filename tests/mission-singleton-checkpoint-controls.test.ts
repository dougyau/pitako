import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine } from "../extensions/mission/engine.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";

const request = JSON.stringify({ format: "mission-consultation-request-v1", question: "Examine candidate", evidenceRefs: ["evidence:a"],
  members: ["one", "two", "three"].map((id) => ({ id, role: "developer", perspective: id })), synthesisRole: "developer" });

test("SDK-disposed singleton cannot seal an unresolved, oversized, unsealable or stale terminal state", async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  for (const control of ["unresolved", "oversized", "unsealable", "stale-version", "stale-revision"] as const) {
    const sample = createMissionFixture(`pitako-checkpoint-${control}-`);
    const previous = process.env.PI_CODING_AGENT_DIR;
    const agentDir = path.join(sample.base, "agent");
    const config = path.join(agentDir, "pitako", "config.toml");
    let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
    let engine: MissionEngine | undefined;
    try {
      mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: () => request });
      const definition = missionDefinition();
      definition.units[0]!.inputs = ["evidence:a"];
      definition.authority.allowedPaths = ["src/**"];
      definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
      definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 2000,
        activeTimeMs: 240000, artifactBytes: control === "oversized" ? 5000 : 2_000_000 };
      writeFileSync(sample.definitionFile, JSON.stringify(definition));
      store = await openFixtureStore(sample);
      const mission = store.createMission(missionInput(sample));
      const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
        load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
      if (control === "stale-version") {
        const append = store.appendTransition.bind(store);
        let changed = false;
        store.appendTransition = (id, version, transition) => {
          if (!changed && transition.events.some(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation")) {
            changed = true;
            append(id, version, { events: [{ revision: 1, kind: "mission.notification.delivered", causalId: randomUUID(),
              payload: { reason: "concurrent host observation" } }] });
          }
          return append(id, version, transition);
        };
      }
      engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
        managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
        runRole: async (input, durable) => {
          const result = await runner(input, durable);
          if (control === "unsealable") {
            mkdirSync(path.join(durable.cwd!, "src"), { recursive: true });
            writeFileSync(path.join(durable.cwd!, "src", ".env"), "must not persist");
          }
          if (control === "unresolved") {
            const current = store!.inspectMission(mission.id);
            store!.appendTransition(mission.id, current.version, { events: [{ revision: current.revision,
              kind: "effect.intent", causalId: randomUUID(), unitId: input.unit.id, attemptId: input.binding.attemptId,
              effectId: randomUUID(), payload: { operation: "external:charge", recovery: "external-probe-required" } }] });
          }
          if (control === "stale-revision") {
            const current = store!.inspectMission(mission.id);
            store!.admitRevision({ missionId: mission.id, expectedVersion: current.version,
              planBytes: Buffer.from(sample.planBytes.toString().replace("revision: 1", "revision: 2")),
              definitionBytes: Buffer.from(JSON.stringify(definition)), receiptId: randomUUID(), actor: "model",
              impact: [], retained: ["snapshot"] });
          }
          return result;
        }, assessPredicate: () => { throw new Error("singleton request cannot satisfy a predicate"); } });
      engine.start(); await engine.waitForIdle();
      const events = store.inspectMission(mission.id).events;
      expect(provider.trace).toHaveLength(1);
      expect(events.some(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.purpose === "consultation")).toBe(false);
      expect(events.some(({ kind }) => kind === "team.consultation.admitted" || kind === "unit.accepted" || kind === "mission.completed")).toBe(false);
      const denied = events.find(({ kind }) => kind === "team.consultation.denied");
      expect(String(denied?.payload.reason)).toContain(control === "oversized" ? "artifact allowance" :
        control === "unsealable" ? "sensitive path" : control === "unresolved" ? "uncertain" :
          control === "stale-revision" ? "checkpoint" : "version conflict");
      if (control !== "stale-revision") {
        await engine.retireForShutdown("quit"); engine = undefined; store = undefined;
        const node = spawnSync("node", ["scripts/mission-singleton-checkpoint-node.mjs", sample.dbPath, sample.objectDir,
          mission.id, "none"], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
        expect(node.status).toBe(0);
      }
    } finally {
      await engine?.retireForShutdown("quit"); store?.close();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      delete (globalThis as Record<string, unknown>).__pitako_mission_local;
      rmSync(sample.base, { recursive: true, force: true });
    }
  }
}, 90000);
