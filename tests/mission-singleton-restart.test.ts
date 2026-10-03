import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { MissionEngine, type MissionAttemptBinding } from "../extensions/mission/engine.ts";
import { admitMissionChange, nextPlanBytes } from "../extensions/mission/admission.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import agentExtension from "../extensions/agent/index.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore, operatorChangeReceipt } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";

for (const cut of ["recorded", "barrier", "resolved", "reserved", "continuation-receipt", "member-receipt", "member-started", "revision", "cancelled", "paused", "unproven-chain"] as const)
  test(`singleton owner SIGKILL after ${cut} retains exact consultation lineage`, async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  const sample = createMissionFixture(`pitako-singleton-${cut}-`);
  const agentDir = path.join(sample.base, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const traceFile = path.join(sample.base, "provider-trace.json");
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  try {
    mkdirSync(path.join(agentDir, "pitako"), { recursive: true });
    writeFileSync(path.join(agentDir, "pitako", "config.toml"), "");
    mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src", "target.txt"), "source\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const provider = await installMissionLocalProvider({ agentDir });
    const definition = missionDefinition();
    definition.units[0]!.inputs = ["evidence:a"];
    if (cut === "revision") definition.units.push({ ...structuredClone(definition.units[0]!),
      id: "downstream", dependencies: ["snapshot"], inputs: [],
      acceptance: [{ id: "downstream-present", kind: "artifact_hash", target: "downstream" }] });
    definition.authority.operations = ["bash", "write"];
    definition.authority.allowedPaths = ["src/**"];
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
    definition.budget = { roleLaunches: 25, providerRequests: 25, tokens: 25000, activeTimeMs: 1500000, artifactBytes: 2_500_000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    await new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(path.dirname(sample.dbPath), "sessions"),
      runRole: async () => { throw new Error("prepared owner cannot launch"); } }).retireForShutdown("quit");
    store = undefined;
    const run = (runtime: string, script: string, args: string[], expected: "SIGKILL" | "success") => {
      const child = spawnSync(runtime, [script, sample.dbPath, sample.objectDir, mission.id, sample.root, ...args],
        { cwd: process.cwd(), encoding: "utf8", timeout: 55000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
      if (expected === "SIGKILL" ? child.signal !== "SIGKILL" : child.status !== 0)
        throw new Error(`${script} ${args.join(" ")} expected ${expected}: ${child.signal} ${child.status} ${child.stderr} ${child.stdout}`);
    };
    run(process.execPath, "tests/fixtures/mission-singleton-crash-child.mjs", [agentDir, traceFile, "admission", "bash"], "SIGKILL");
    const read = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    const parent = read.inspectMission(mission.id).events.find(({ kind, payload }) => kind === "attempt.reserved" &&
      !(payload.binding as MissionAttemptBinding).continuationOf)!;
    read.close();
    const sourceCandidate = (parent.payload.binding as MissionAttemptBinding).candidateRoot!;
    rmSync(sourceCandidate, { recursive: true, force: true });
    run(process.execPath, "tests/fixtures/mission-singleton-resume-child.mjs",
      [agentDir, traceFile, cut === "revision" ? "barrier" : cut === "cancelled" || cut === "paused" || cut === "unproven-chain" ? "resolved" : cut], "SIGKILL");
    if (cut === "revision" || cut === "cancelled" || cut === "paused") {
      const owner = await openFixtureStore(sample);
      try {
        if (cut === "revision") {
          const current = owner.inspectMission(mission.id);
          const next = structuredClone(current.definition);
          next.units[1]!.acceptance[0]!.target = "changed";
          const admitted = admitMissionChange({ store: owner, missionId: mission.id, expectedVersion: current.version,
            planBytes: nextPlanBytes(current.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)), actor: "operator",
            receipt: operatorChangeReceipt(owner, current, next) });
          expect(admitted.retained).toContain("snapshot");
          expect(admitted.impact).toEqual(["downstream"]);
        } else {
          const engine = new MissionEngine({ store: owner, missionId: mission.id,
            sessionsDirectory: path.join(path.dirname(sample.dbPath), "sessions"), ownerSessionId: "singleton-restart-owner",
            managedWorkspace: { sourceRoot: sample.root }, runRole: async () => { throw new Error("cancel must not launch"); } });
          if (cut === "paused") await engine.control("pause", { id: "operator-pause", text: "/mission pause" });
          else {
            process.env.PI_CODING_AGENT_DIR = sample.stateDir;
            const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
            agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
            const answer = await tools.get("team_cancel")!.execute("cancel", { assignmentId: parent.attemptId },
              new AbortController().signal, undefined, { cwd: sample.root });
            expect(answer.isError).toBeFalsy();
          }
          await engine.retireForShutdown("quit");
          process.env.PI_CODING_AGENT_DIR = agentDir;
        }
        if (cut === "revision") await new MissionEngine({ store: owner, missionId: mission.id,
          sessionsDirectory: path.join(path.dirname(sample.dbPath), "sessions"), runRole: async () => { throw new Error("no launch"); } }).retireForShutdown("quit");
      } finally { owner.close(); }
      run("node", "scripts/mission-singleton-recovery-node.mjs", ["run"], "success");
    } else if (cut === "unproven-chain") {
      run("node", "scripts/mission-singleton-recovery-node.mjs", ["before-use-cut"], "SIGKILL");
      run("node", "scripts/mission-singleton-recovery-node.mjs", ["before-use-cut"], "SIGKILL");
      run("node", "scripts/mission-singleton-recovery-node.mjs", ["unproven"], "success");
    } else {
      run("node", "scripts/mission-singleton-recovery-node.mjs", ["use-cut"], "SIGKILL");
      run(process.execPath, "tests/fixtures/mission-singleton-resume-child.mjs", [agentDir, traceFile, "complete"], "success");
    }
    const final = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try {
      const events = final.inspectMission(mission.id).events;
      const admitted = events.filter(({ kind }) => kind === "team.consultation.admitted");
      const resolved = events.filter(({ kind }) => kind === "team.consultation.resolved");
      const continuations = events.filter(({ kind, payload }) => kind === "attempt.reserved" &&
        (payload.binding as MissionAttemptBinding).continuationOf === parent.attemptId);
      const team = events.filter(({ kind }) => kind === "team.member.recorded");
      const trace = JSON.parse(readFileSync(traceFile, "utf8")).trace as Array<{ prompt: string; toolCount: number }>;
      const childSlots = events.filter(({ kind, payload }) => kind === "attempt.reserved" &&
        (payload.binding as MissionAttemptBinding)?.targetId === admitted[0]?.payload.targetId);
      const protectedIds = events.filter(({ kind, payload }) => kind === "reservation.created" && payload.purpose === "protected")
        .map(({ payload }) => payload.reservationId);
      expect(protectedIds).toHaveLength(5);
      expect(events.some(({ kind, payload }) => kind === "budget.reservation.adjusted" &&
        protectedIds.includes(payload.reservationId))).toBe(false);
      expect(new Set(childSlots.map(({ payload }) => `${payload.roundId}:${payload.memberId}`)).size).toBe(childSlots.length);
      expect(trace.every(({ toolCount }) => toolCount === 0)).toBe(true);
      expect(admitted).toHaveLength(1);
      if (cut !== "revision" && cut !== "cancelled" && cut !== "paused" && cut !== "unproven-chain")
        expect(events.filter(({ kind }) => kind === "team.consultation.revalidated").length).toBeGreaterThanOrEqual(1);
      expect(events.filter(({ kind, attemptId }) => kind === "attempt.reserved" && attemptId === parent.attemptId)).toHaveLength(1);
      expect(events.filter(({ kind, attemptId }) => kind === "effect.intent" && attemptId === parent.attemptId)).toHaveLength(1);
      expect(readFileSync(path.join(sample.root, "src", "target.txt"), "utf8")).toBe("source\n");
      expect(events.some(({ kind }) => kind === "mission.completed")).toBe(false);
      if (cut === "revision" || cut === "cancelled" || cut === "paused" || cut === "unproven-chain") {
        expect(continuations).toHaveLength(0);
        expect(events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "snapshot")).toBe(false);
        if (cut === "revision") {
          expect(events.find(({ kind, unitId }) => kind === "unit.blocked" && unitId === "snapshot")?.payload.reason)
            .toContain("revision");
          expect(events.filter(({ kind }) => kind === "team.consultation.resolved")).toHaveLength(0);
        } else if (cut === "cancelled") {
          expect(events.filter(({ kind }) => kind === "team.consultation.cancelled")).toHaveLength(1);
        } else if (cut === "unproven-chain") {
          expect(events.filter(({ kind, payload }) => kind === "unit.blocked" &&
            String(payload.reason).includes("predecessor checkpoint-use chain"))).toHaveLength(1);
        } else {
          expect(events.filter(({ kind }) => kind === "mission.paused")).toHaveLength(1);
          expect(events.filter(({ kind }) => kind === "team.consultation.revalidated")).toHaveLength(1);
        }
      } else if (cut === "reserved" || cut === "member-started") {
        expect(continuations).toHaveLength(cut === "reserved" ? 1 : 0);
        expect(events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "snapshot")).toBe(false);
        if (cut === "reserved") expect(trace).toHaveLength(11);
        else expect(trace.length).toBeLessThanOrEqual(3);
        if (cut === "member-started") {
          expect(events.some(({ kind, payload }) => kind === "team.barrier.recorded" && payload.status === "incomplete")).toBe(true);
          const incomplete = events.find(({ kind, payload }) => kind === "team.barrier.recorded" && payload.status === "incomplete")!;
          expect(incomplete.payload.missing).toContain("one");
          const started = childSlots.find(({ payload }) => payload.memberId === "one")!;
          expect(events.some(({ kind, attemptId }) => kind === "attempt.receipt" && attemptId === started.attemptId)).toBe(false);
          expect(events.filter(({ kind, attemptId }) => kind === "provider.request.dispatched" && attemptId === started.attemptId).length)
            .toBeLessThanOrEqual(1);
        } else {
          expect(events.filter(({ kind, attemptId }) => kind === "attempt.receipt" && attemptId === continuations[0]!.attemptId)).toHaveLength(0);
        }
      } else {
        expect(team).toHaveLength(10);
        expect(childSlots).toHaveLength(10);
        expect(resolved).toHaveLength(1);
        expect(continuations).toHaveLength(1);
        expect(events.filter(({ kind, unitId }) => kind === "unit.accepted" && unitId === "snapshot")).toHaveLength(1);
        expect((continuations[0]!.payload.binding as MissionAttemptBinding).candidateRoot).not.toBe(sourceCandidate);
        expect(events.find(({ kind, unitId }) => kind === "unit.accepted" && unitId === "snapshot")?.attemptId)
          .toBe(continuations[0]!.attemptId);
        expect((continuations[0]!.payload.binding as MissionAttemptBinding).childResultHash).toBe(String(resolved[0]!.payload.resultHash));
        expect(trace).toHaveLength(12);
      }
    } finally { final.close(); }
  } finally {
    store?.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete (globalThis as Record<string, unknown>).__pitako_mission_local;
    rmSync(sample.base, { recursive: true, force: true });
  }
}, 150000);
