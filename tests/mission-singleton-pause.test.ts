import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine, type MissionAttemptBinding } from "../extensions/mission/engine.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";
import { WorkerHistory } from "../extensions/agent/history.ts";
import { projectManagedHistory } from "../extensions/agent/managed-mission.ts";

const request = JSON.stringify({ format: "mission-consultation-request-v1", question: "Review private candidate",
  evidenceRefs: ["evidence:a"], members: ["one", "two", "three"].map((id) => ({ id, role: "developer", perspective: id })),
  synthesisRole: "developer" });

// ponytail: fixtures share the executor's process-global agent dir/provider; serialize cases, not SDK members.
for (const mode of ["live", "node", "drift"] as const) test.serial(`paused singleton predicate waits for explicit ${mode} resume`, async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  const sample = createMissionFixture("pitako-singleton-pause-");
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
  mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src", "target.txt"), "source\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: (prompt) => {
    if (prompt.includes('"format":"mission-singleton-continuation-v1"')) return "continuation result";
    if (!prompt.startsWith("Read-only ")) return request;
    const bundle = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1).split("\n", 1)[0]!);
    if (bundle.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase,
      round: bundle.round, memberId: bundle.memberId, classifications: bundle.priorFindings.map(({ id, evidenceRefs }: { id: string; evidenceRefs: string[] }) =>
        ({ findingId: id, evidenceRefs, category: "uncertainty", reason: "Host verification required" })) });
    const peer = bundle.priorFindings?.find(({ id }: { id: string }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
    return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
      findings: [{ id: "f", claim: "Inspect", evidenceRefs: ["evidence:a"], detail: { recommendation: "Check", impact: "Bound" },
        ...(peer ? { respondsTo: { id: peer.id, evidenceRefs: peer.evidenceRefs } } : {}) }] });
  } });
  const definition = missionDefinition();
  definition.units[0]!.id = "impl";
  definition.units[0]!.kind = "implementation";
  definition.units[0]!.inputs = ["evidence:a"];
  definition.units[0]!.retryLimit = 0;
  definition.authority.operations = ["write"];
  definition.authority.allowedPaths = ["src/**"];
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
  definition.budget = { roleLaunches: 25, providerRequests: 25, tokens: 25000, activeTimeMs: 1_500_000, artifactBytes: 2_500_000 };
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(sample);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let engine: MissionEngine | undefined;
  let failed = false;
  try {
    const mission = store.createMission(missionInput(sample));
    const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
    let assessing!: () => void;
    const entered = new Promise<void>((resolve) => { assessing = resolve; });
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      ownerSessionId: "singleton-pause-owner", managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
      runRole: async (input, durable) => {
        if (input.binding.continuationOf && !input.binding.teamBundleHash) {
          const effect = await durable.effects!.invoke("write", { path: "src/target.txt", content: "continued\n" });
          expect(effect.status).toBe("completed");
        }
        return runner(input, durable);
      }, assessPredicate: async ({ resultArtifact }) => {
        expect(resultArtifact.toString()).toBe("continuation result");
        assessing(); await gate;
        return { verdict: "pass", method: "host continuation assessment" };
      } });
    engine.start();
    await entered;
    const beforePause = store.inspectMission(mission.id);
    const pausing = engine.control("pause", { id: "operator-pause", text: "/mission pause" })
      .then(() => "", (error: Error) => error.message);
    expect(store.inspectMission(mission.id).events.some(({ kind }) => kind === "mission.paused")).toBe(true);
    if (mode === "live") {
      const atPause = store.inspectMission(mission.id);
      const known = (inspection: typeof atPause) => inspection.reservations.filter(({ resource }) => resource === "active-time-ms")
        .reduce((sum, row) => sum + row.knownCharge, 0);
      expect(atPause.events.filter(({ kind }) => kind === "mission.active.window.closed").length)
        .toBe(beforePause.events.filter(({ kind }) => kind === "mission.active.window.closed").length + 1);
      expect(known(atPause)).toBeGreaterThan(0);
      await engine.control("pause");
      await new Promise((resolve) => setTimeout(resolve, 10300));
      expect(await pausing).toBe("mission pause is fenced; active worker still needs reconciliation");
      const idle = store.inspectMission(mission.id);
      expect(known(idle)).toBe(known(atPause));
      for (const kind of ["attempt.reserved", "provider.request.dispatched", "effect.intent", "unit.accepted", "attempt.settled",
        "mission.active.window.opened", "mission.active.window.closed"])
        expect(idle.events.filter((event) => event.kind === kind)).toHaveLength(atPause.events.filter((event) => event.kind === kind).length);
      expect(provider.trace).toHaveLength(idle.events.filter(({ kind }) => kind === "provider.request.dispatched").length);
      expect(idle.events.some(({ kind, payload }) => kind === "attempt.receipt" && payload.status === "completed")).toBe(true);
    }
    release();
    expect(await pausing).toBe(mode === "live" ? "mission pause is fenced; active worker still needs reconciliation" : "");
    await engine.waitForIdle();
    const paused = store.inspectMission(mission.id);
    const continuation = paused.events.find(({ kind, payload }) => kind === "attempt.reserved" &&
      (payload.binding as MissionAttemptBinding).continuationOf)!;
    const count = (kind: string) => paused.events.filter((event) => event.kind === kind).length;
    expect(paused.state).toBe("paused");
    expect(paused.events.find(({ kind, attemptId }) => kind === "attempt.receipt" && attemptId === continuation.attemptId)?.payload.status)
      .toBe("completed");
    expect(paused.events.filter(({ kind }) => ["unit.accepted", "unit.blocked"].includes(kind))).toHaveLength(0);
    expect(paused.events.filter(({ kind, attemptId }) => kind === "attempt.settled" && attemptId === continuation.attemptId)).toHaveLength(0);
    const paid = count("provider.request.dispatched");
    const effects = count("effect.intent");
    const launches = count("attempt.reserved");
    const protectedIds = paused.events.filter(({ kind, payload }) => kind === "reservation.created" && payload.purpose === "protected")
      .map(({ payload }) => payload.reservationId);
    expect(provider.trace).toHaveLength(paid);
    const histories = new WorkerHistory().list().filter((group) => group.identity.kind === "mission" && group.identity.missionId === mission.id);
    expect(histories).toHaveLength(1);
    const history = histories[0]!;
    expect(history.coverage).toBe("complete");
    expect(history.members).toHaveLength(launches);
    const successor = history.members.find((member) => member.attemptId === continuation.attemptId)!;
    expect(successor.continuationOf).toBe((continuation.payload.binding as MissionAttemptBinding).continuationOf);
    expect(successor.retryOf).toBeUndefined();
    expect(new Set(history.members.filter((member) => member.memberId !== "singleton").map((member) => member.memberId)).size)
      .toBeGreaterThan(2);
    expect(history.members.every((member) => member.native.state === "allocated" &&
      member.native.sessionId === member.attemptId && member.native.disposition.state === "disposed")).toBe(true);
    const seqBeforeHistory = store.inspectMission(mission.id).latestSeq;
    expect((await projectManagedHistory(history)).protected).toBe(true);
    expect(store.inspectMission(mission.id).latestSeq).toBe(seqBeforeHistory);
    if (mode === "drift") writeFileSync(path.join(sample.root, "src", "target.txt"), "external drift\n");
    if (mode === "node") {
      await engine.retireForShutdown("quit");
      const node = spawnSync("node", ["scripts/mission-singleton-pause-node.mjs", sample.dbPath, sample.objectDir,
        mission.id, sample.root, String(continuation.attemptId), String(paid), String(effects), String(launches)],
        { cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 45000 });
      expect(node.status, node.stderr + node.stdout).toBe(0);
    } else {
      await engine.control("resume", { id: "operator-resume", text: "/mission resume" });
      await engine.waitForIdle();
      const final = store.inspectMission(mission.id).events;
      expect(final.filter(({ kind, attemptId }) => kind === "unit.accepted" && attemptId === continuation.attemptId))
        .toHaveLength(mode === "drift" ? 0 : 1);
      expect(final.filter(({ kind }) => kind === "unit.blocked")).toHaveLength(mode === "drift" ? 1 : 0);
      expect(final.filter(({ kind, attemptId, payload }) => kind === "attempt.settled" && attemptId === continuation.attemptId &&
        payload.status === (mode === "drift" ? "failed" : "succeeded"))).toHaveLength(1);
      for (const kind of ["provider.request.dispatched", "effect.intent", "attempt.reserved"])
        expect(final.filter((event) => event.kind === kind)).toHaveLength(count(kind));
      expect(final.some(({ kind, payload }) => kind === "budget.reservation.adjusted" && protectedIds.includes(payload.reservationId))).toBe(false);
      expect(provider.trace).toHaveLength(paid);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    release();
    let cleanupError: unknown;
    try { await engine?.close(); } catch (error) { cleanupError = error; }
    try { store.close(); } catch (error) { cleanupError ??= error; }
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    delete (globalThis as Record<string, unknown>).__pitako_mission_local;
    try { rmSync(sample.base, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; }
    if (!failed && cleanupError !== undefined) throw cleanupError;
  }
}, 90_000);
