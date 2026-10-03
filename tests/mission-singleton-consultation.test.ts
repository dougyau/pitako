import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import agentExtension from "../extensions/agent/index.ts";
import { createPiMissionRunner, MissionEngine, type MissionAttemptBinding } from "../extensions/mission/engine.ts";
import { managedAttemptRows } from "../extensions/agent/managed-mission.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const request = JSON.stringify({ format: "mission-consultation-request-v1", question: "Review private candidate",
  evidenceRefs: ["evidence:a"], members: ["one", "two", "three"].map((id) => ({ id, role: "developer", perspective: id })),
  synthesisRole: "developer" });

for (const scenario of ["accepted", "source-drift", "child-invalid", "child-self-review", "predicate-drift",
  "cancel-during-assessment", "bounded-retry", "retry-no-slack"] as const)
  test(`live SDK singleton ${scenario}`, async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  const sample = createMissionFixture("pitako-singleton-live-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let engine: MissionEngine | undefined;
  try {
    mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
    mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src", "target.txt"), "source\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let ordinaryResponses = 0;
    const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: (prompt) => {
      if (prompt.includes('"format":"mission-singleton-continuation-v1"')) return "continuation result";
      if (!prompt.startsWith("Read-only ")) {
        ordinaryResponses++;
        return scenario === "bounded-retry" && ordinaryResponses === 1 ? "initial failed result" : request;
      }
      const bundle = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1).split("\n", 1)[0]!);
      if (bundle.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase,
        round: bundle.round, memberId: bundle.memberId, classifications: (scenario === "child-invalid" ? [] : bundle.priorFindings)
          .map(({ id, evidenceRefs }: { id: string; evidenceRefs: string[] }) =>
          ({ findingId: id, evidenceRefs, category: "uncertainty", reason: "Host verification required" })) });
      const target = scenario === "child-self-review" && bundle.round === "critique" && bundle.memberId === "one"
        ? bundle.priorFindings?.find(({ id }: { id: string }) => id.startsWith("independent:one:"))
        : bundle.priorFindings?.find(({ id }: { id: string }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
      return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
        findings: [{ id: "f", claim: "Inspect", evidenceRefs: ["evidence:a"], detail: { recommendation: "Check", impact: "Bound" },
          ...(target ? { respondsTo: { id: target.id, evidenceRefs: target.evidenceRefs } } : {}) }] });
    } });
    const definition = missionDefinition();
    definition.units[0]!.id = "impl";
    definition.units[0]!.kind = "implementation";
    definition.units[0]!.inputs = ["evidence:a"];
    definition.units[0]!.retryLimit = scenario === "bounded-retry" || scenario === "retry-no-slack" ? 2 : 0;
    definition.authority.operations = ["write"];
    definition.authority.allowedPaths = ["src/**"];
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
    const slots = scenario === "retry-no-slack" ? 14 : 25;
    definition.budget = { roleLaunches: slots, providerRequests: slots, tokens: slots * 1000,
      activeTimeMs: slots * 60000, artifactBytes: 2_500_000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
    const assessed: string[] = [];
    const ordinaryBriefs = new Map<string, string>();
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
      runRole: async (input, durable) => {
        expect(hash(Buffer.from(JSON.stringify(input.brief)))).toBe(input.binding.briefHash);
        const reservation = store!.inspectMission(mission.id).events.find(({ kind, attemptId }) =>
          kind === "attempt.reserved" && attemptId === input.binding.attemptId)!;
        expect((reservation.payload.binding as MissionAttemptBinding).briefHash).toBe(input.binding.briefHash);
        if (input.binding.teamBundleHash) {
          expect(durable.readOnly).toBe(true); expect(durable.effects).toBeUndefined();
          const result = await runner(input, durable);
          if (scenario === "source-drift" && input.binding.roundId === "synthesis")
            writeFileSync(path.join(sample.root, "src", "target.txt"), "external drift\n");
          return result;
        } else {
          ordinaryBriefs.set(input.binding.attemptId, input.brief);
          const acceptance = JSON.parse(input.brief.split("\n").find((line) => line.startsWith("Acceptance: "))!.slice(12));
          expect(acceptance).toEqual(definition.units[0]!.acceptance);
          expect(input.brief).toContain("Return findings only. Do not claim completion, evidence, or budget authority.");
          expect(input.brief).toContain("all predicates remain current host obligations");
          if (input.binding.continuationOf) {
            const events = store!.inspectMission(mission.id).events;
            const admission = events.find(({ kind, payload }) => kind === "team.consultation.admitted" &&
              payload.parentAttemptId === input.binding.continuationOf)!;
            const previous = events.filter(({ kind, attemptId, payload }) => kind === "attempt.reserved" &&
              attemptId !== input.binding.attemptId &&
              (payload.binding as MissionAttemptBinding).continuationOf === input.binding.continuationOf).at(-1);
            expect(input.brief.split("\n").at(-1)).toBe(JSON.stringify({
              format: "mission-singleton-continuation-v1", sourceAttemptId: input.binding.continuationOf,
              checkpointHash: input.binding.checkpointHash, childTargetId: admission.payload.targetId,
              childResultHash: input.binding.childResultHash,
              childResult: store!.readArtifact(input.binding.childResultHash!).toString(),
              ...(previous ? { retryOf: previous.attemptId } : {}),
              instruction: "Continue on the fresh private candidate. Child synthesis is advice, not acceptance.",
            }));
          }
          expect(durable.readOnly).toBe(false);
          const effect = await durable.effects!.invoke("write", { path: "src/target.txt",
            content: input.binding.continuationOf ? "continued\n" : "private candidate\n" });
          expect(effect.status).toBe("completed");
        }
        const result = await runner(input, durable);
        expect(provider.trace.find(({ sessionId }) => sessionId === input.binding.attemptId)!.prompt).toContain(input.brief);
        return result;
      }, assessPredicate: ({ resultArtifact }) => {
        assessed.push(resultArtifact.toString());
        if (scenario === "predicate-drift") writeFileSync(path.join(sample.root, "src", "target.txt"), "drift during assessment\n");
        if (scenario === "cancel-during-assessment") {
          const source = store!.inspectMission(mission.id).events.find(({ kind, payload }) =>
            kind === "attempt.settled" && payload.status === "yielded")!;
          expect(engine!.cancelAttempt(source.attemptId!)).toBe(true);
        }
        return { verdict: resultArtifact.toString() === "continuation result" &&
          (!["bounded-retry", "retry-no-slack"].includes(scenario) ||
            assessed.length === (scenario === "bounded-retry" ? 3 : 2)) ? "pass" : "fail", method: "host verification" };
      } });
    engine.start(); await engine.waitForIdle();
    const missionEvents = store.inspectMission(mission.id).events;
    const admitted = missionEvents.filter(({ kind }) => kind === "team.consultation.admitted");
    const resolved = missionEvents.find(({ kind }) => kind === "team.consultation.resolved")!;
    const yielded = missionEvents.find(({ kind, payload }) => kind === "attempt.settled" && payload.status === "yielded")!;
    const reserved = missionEvents.filter(({ kind }) => kind === "attempt.reserved");
    const parent = reserved.find(({ attemptId }) => attemptId === yielded.attemptId)!;
    const continuation = reserved.find(({ payload }) => (payload.binding as MissionAttemptBinding).continuationOf === parent.attemptId)!;
    expect(admitted).toHaveLength(1);
    if (scenario === "accepted") expect(resolved).toBeDefined();
    expect(missionEvents.filter(({ kind, payload }) => kind === "attempt.reserved" && payload.targetId === admitted[0]!.payload.targetId))
      .toHaveLength(scenario === "child-self-review" ? 6 : 10);
    expect(missionEvents.some(({ kind, attemptId }) => kind === "team.member.recorded" && attemptId === parent.attemptId)).toBe(false);
    expect(missionEvents.some(({ kind }) => kind === "mission.completed")).toBe(false);
    const protectedIds = missionEvents.filter(({ kind, payload }) => kind === "reservation.created" &&
      payload.purpose === "protected").map(({ payload }) => payload.reservationId);
    expect(protectedIds.length).toBeGreaterThan(0);
    expect(missionEvents.some(({ kind, payload }) => kind === "budget.reservation.adjusted" &&
      protectedIds.includes(payload.reservationId))).toBe(false);
    process.env.PI_CODING_AGENT_DIR = sample.stateDir;
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
    const result = await tools.get("team_result")!.execute("read", { assignmentId: parent.attemptId },
      new AbortController().signal, undefined, { cwd: sample.root });
    expect(result.isError).toBe(true);
    expect(result.details.resultAvailable).toBe(false);
    expect(result.content[0].text).not.toContain("mission-consultation-request-v1");
    if (scenario === "child-invalid" || scenario === "child-self-review") {
      expect(resolved).toBeUndefined();
      expect(continuation).toBeUndefined();
      expect(assessed).toEqual([]);
      expect(missionEvents.some(({ kind }) => kind === "unit.accepted")).toBe(false);
      expect(missionEvents.find(({ kind, payload }) => kind === "team.barrier.recorded" &&
        payload.round === (scenario === "child-self-review" ? "critique" : "synthesis"))?.payload.status)
        .toBe("incomplete");
      return;
    }
    if (scenario === "source-drift") {
      expect(continuation).toBeUndefined();
      expect(assessed).toEqual([]);
      expect(missionEvents.find(({ kind, unitId }) => kind === "unit.blocked" && unitId === "impl")?.payload.reason).toContain("checkpoint");
      expect(missionEvents.some(({ kind }) => kind === "unit.accepted")).toBe(false);
      expect(readFileSync(path.join(sample.root, "src", "target.txt"), "utf8")).toBe("external drift\n");
      expect(managedAttemptRows(store.inspectMission(mission.id), parent.attemptId!)[0]).toMatchObject({
        status: resolved ? "child-complete-awaiting-continuation" : "waiting-child", resultAvailable: false,
      });
      return;
    }
    if (scenario === "predicate-drift") {
      expect(continuation).toBeDefined();
      expect(assessed).toEqual(["continuation result"]);
      expect(missionEvents.some(({ kind }) => kind === "unit.accepted")).toBe(false);
      expect(missionEvents.find(({ kind, attemptId }) => kind === "attempt.settled" && attemptId === continuation.attemptId)?.payload)
        .toMatchObject({ status: "failed", reason: "singleton checkpoint, child result or source changed" });
      expect(readFileSync(path.join(sample.root, "src", "target.txt"), "utf8")).toBe("drift during assessment\n");
      return;
    }
    if (scenario === "cancel-during-assessment") {
      expect(continuation).toBeDefined();
      expect(assessed).toEqual(["continuation result"]);
      expect(missionEvents.some(({ kind }) => kind === "unit.accepted")).toBe(false);
      expect(missionEvents.find(({ kind, attemptId }) => kind === "attempt.settled" && attemptId === continuation.attemptId)?.payload.status)
        .toBe("failed");
      expect(managedAttemptRows(store.inspectMission(mission.id), parent.attemptId!)[0]).toMatchObject({
        status: "cancelled", resultAvailable: false,
      });
      return;
    }
    if (scenario === "bounded-retry") {
      const continuations = reserved.filter(({ payload }) => (payload.binding as MissionAttemptBinding).continuationOf === parent.attemptId);
      expect(continuations).toHaveLength(2);
      expect(assessed).toEqual(["initial failed result", "continuation result", "continuation result"]);
      expect(continuations.map(({ payload }) => (payload.binding as MissionAttemptBinding).attemptNo)).toEqual([3, 4]);
      const failed = reserved.find(({ attemptId }) => ordinaryBriefs.has(attemptId!) && attemptId !== parent.attemptId &&
        !continuations.some((continuation) => continuation.attemptId === attemptId))!;
      expect(failed.attemptId).not.toBe(parent.attemptId);
      for (const [index, predecessor] of [failed, continuations[0]!].entries()) {
        const brief = ordinaryBriefs.get(continuations[index]!.attemptId!)!;
        const json = (label: string) => JSON.parse(brief.split("\n").find((line) => line.startsWith(`${label}: `))!.slice(label.length + 2));
        expect(json("Previous attempt")).toEqual({ attemptId: predecessor.attemptId, revision: 1, status: "failed" });
        const rows = engine.snapshot().evidence.filter((row) => row.attemptId === predecessor.attemptId);
        expect(rows).toHaveLength(1);
        expect(json("Previous observations")).toEqual(rows.map((row) => ({
          predicateId: row.predicateId, observations: [{ revision: row.revision, verdict: row.verdict,
            method: row.method, evidenceId: row.id, artifactHash: row.artifactHash }],
        })));
        const appendix = JSON.parse(brief.split("\n").at(-1)!);
        expect(appendix).toMatchObject({ format: "mission-singleton-continuation-v1", sourceAttemptId: parent.attemptId,
          childResultHash: resolved.payload.resultHash,
          instruction: "Continue on the fresh private candidate. Child synthesis is advice, not acceptance." });
        expect(appendix.retryOf).toBe(index === 0 ? undefined : continuations[0]!.attemptId);
      }
      expect((continuations[0]!.payload.binding as MissionAttemptBinding).candidateRoot)
        .not.toBe((continuations[1]!.payload.binding as MissionAttemptBinding).candidateRoot);
      expect(missionEvents.find(({ kind }) => kind === "unit.accepted")?.attemptId).toBe(continuations[1]!.attemptId);
      expect(managedAttemptRows(store.inspectMission(mission.id), parent.attemptId!)[0]).toMatchObject({
        continuationAssignmentId: continuations[1]!.attemptId, resultAvailable: false,
      });
      return;
    }
    if (scenario === "retry-no-slack") {
      expect(reserved.filter(({ payload }) => (payload.binding as MissionAttemptBinding).continuationOf === parent.attemptId)).toHaveLength(1);
      expect(assessed).toEqual(["continuation result"]);
      expect(missionEvents.some(({ kind }) => kind === "unit.accepted")).toBe(false);
      expect(missionEvents.find(({ kind, unitId }) => kind === "unit.blocked" && unitId === "impl")?.payload.reason)
        .toContain("ordinary role-launches is reserved");
      return;
    }
    const parentBinding = parent.payload.binding as MissionAttemptBinding;
    expect(continuation).toBeDefined();
    const continuationBinding = continuation.payload.binding as MissionAttemptBinding;

    expect(assessed).toEqual(["continuation result"]);
    expect(provider.trace).toHaveLength(12);
    expect(provider.trace.every(({ toolCount }) => toolCount === 0)).toBe(true);
    expect(continuationBinding).toMatchObject({ roundId: "main", memberId: "solo", continuationOf: parent.attemptId,
      checkpointHash: admitted[0]!.payload.checkpointHash, childResultHash: resolved.payload.resultHash, attemptNo: 2 });
    expect(continuationBinding.candidateRoot).not.toBe(parentBinding.candidateRoot);
    expect(readFileSync(path.join(continuationBinding.candidateRoot!, "src/target.txt"), "utf8")).toBe("continued\n");
    expect(readFileSync(path.join(sample.root, "src/target.txt"), "utf8")).toBe("source\n");
    expect(missionEvents.find(({ kind }) => kind === "unit.accepted")?.attemptId).toBe(continuation.attemptId);
    expect(managedAttemptRows(store.inspectMission(mission.id), parent.attemptId!)[0]).toMatchObject({ status: "continued", resultAvailable: false,
      childResultHash: resolved.payload.resultHash, continuationAssignmentId: continuation.attemptId });
    expect(hash(store.readArtifact(String(admitted[0]!.payload.checkpointHash)))).toBe(String(admitted[0]!.payload.checkpointHash));
    expect(missionEvents.some(({ kind, attemptId }) => kind === "mission.completed" ||
      kind === "team.member.recorded" && attemptId === parent.attemptId)).toBe(false);
  } finally {
    await engine?.retireForShutdown("quit"); store?.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete (globalThis as Record<string, unknown>).__pitako_mission_local;
    rmSync(sample.base, { recursive: true, force: true });
  }
}, 120000);

test("live SDK singleton waits for an unrelated Developer before continuing", async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  const sample = createMissionFixture("pitako-singleton-occupied-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let engine: MissionEngine | undefined;
  let releaseOther!: () => void;
  const otherHeld = new Promise<void>((resolve) => { releaseOther = resolve; });
  let otherStarted!: () => void;
  const otherRunning = new Promise<void>((resolve) => { otherStarted = resolve; });
  const continuationWrites = new Map<string, string>();
  try {
    mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
    mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src", "target.txt"), "source\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: (prompt) => {
      if (prompt.includes('"format":"mission-singleton-continuation-v1"')) return "continuation result";
      if (prompt.includes("Unit: other (")) return "other result";
      if (!prompt.startsWith("Read-only ")) return request;
      const bundle = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1).split("\n", 1)[0]!);
      if (bundle.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase,
        round: bundle.round, memberId: bundle.memberId, classifications: bundle.priorFindings.map(
          ({ id, evidenceRefs }: { id: string; evidenceRefs: string[] }) =>
            ({ findingId: id, evidenceRefs, category: "uncertainty", reason: "Host verification required" })) });
      const target = bundle.priorFindings?.find(({ id }: { id: string }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
      return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
        findings: [{ id: "f", claim: "Inspect", evidenceRefs: ["evidence:a"], detail: { recommendation: "Check", impact: "Bound" },
          ...(target ? { respondsTo: { id: target.id, evidenceRefs: target.evidenceRefs } } : {}) }] });
    } });
    const definition = missionDefinition();
    const impl = definition.units[0]!;
    impl.id = "impl"; impl.kind = "implementation"; impl.inputs = ["evidence:a"]; impl.retryLimit = 0;
    const other = structuredClone(impl);
    other.id = "other"; other.inputs = []; other.acceptance = [{ id: "other-present", kind: "artifact_hash", target: "other" }];
    definition.units = [impl, other];
    definition.authority.operations = ["write"];
    definition.authority.allowedPaths = ["src/**"];
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
    const slots = 40;
    definition.budget = { roleLaunches: slots, providerRequests: slots, tokens: slots * 1000,
      activeTimeMs: slots * 60000, artifactBytes: 2_500_000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
    const assessed: Array<{ unitId: string; result: string }> = [];
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      maxConcurrent: 3,
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
      runRole: async (input, durable) => {
        if (input.unit.id === "other") { otherStarted(); await otherHeld; }
        if (input.binding.teamBundleHash && input.binding.roundId === "independent" && input.binding.memberId !== "one")
          await otherRunning;
        if (input.unit.id === "impl" && !input.binding.teamBundleHash) {
          const effect = await durable.effects!.invoke("write", { path: "src/target.txt",
            content: input.binding.continuationOf ? "continued\n" : "private candidate\n" });
          if (input.binding.continuationOf) continuationWrites.set(input.binding.attemptId, effect.status);
          expect(effect.status).toBe("completed");
        }
        return runner(input, durable);
      }, assessPredicate: ({ unit, resultArtifact }) => {
        assessed.push({ unitId: unit.id, result: resultArtifact.toString() });
        return { verdict: "pass", method: "host verification" };
      } });
    engine.start();
    const deadline = Date.now() + 30000;
    while (!store.inspectMission(mission.id).events.some(({ kind }) => kind === "team.consultation.resolved")) {
      if (Date.now() > deadline) throw new Error("child did not resolve while other Developer was active");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const mid = store.inspectMission(mission.id).events;
    const admitted = mid.find(({ kind }) => kind === "team.consultation.admitted")!;
    const resolved = mid.find(({ kind }) => kind === "team.consultation.resolved")!;
    const yielded = mid.find(({ kind, payload }) => kind === "attempt.settled" && payload.status === "yielded")!;
    const source = mid.find(({ kind, attemptId }) => kind === "attempt.reserved" && attemptId === yielded.attemptId)!;
    expect(mid.filter(({ kind, payload, attemptId }) => kind === "attempt.reserved" &&
      (payload.binding as MissionAttemptBinding).candidate === "managed" &&
      !mid.some((event) => event.kind === "attempt.settled" && event.attemptId === attemptId))
      .map(({ unitId }) => unitId)).toEqual(["other"]);
    const minimum = mid.find(({ kind, payload }) => kind === "reservation.created" &&
      payload.resource === "role-launches" && payload.purpose === "ordinary" && payload.amount === 11)!;
    const otherAttempt = mid.find(({ kind, unitId }) => kind === "attempt.reserved" && unitId === "other")!;
    expect(store.inspectMission(mission.id).reservations.find(({ id }) => id === minimum.payload.reservationId)?.amount).toBe(1);
    expect(mid.some(({ kind, unitId }) => kind === "unit.blocked" && unitId === "impl")).toBe(false);
    expect(mid.some(({ kind, payload }) => kind === "attempt.reserved" && (payload.binding as MissionAttemptBinding)?.continuationOf === yielded.attemptId)).toBe(false);
    expect(assessed.some(({ unitId }) => unitId === "impl")).toBe(false);
    releaseOther();
    await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    const continuations = events.filter(({ kind, payload }) => kind === "attempt.reserved" &&
      (payload.binding as MissionAttemptBinding)?.continuationOf === yielded.attemptId);
    expect(continuations).toHaveLength(1);
    const otherSettled = events.find(({ kind, attemptId }) => kind === "attempt.settled" && attemptId === otherAttempt.attemptId)!;
    expect(otherSettled.payload.status).toBe("succeeded");
    expect(continuations[0]!.seq).toBeGreaterThan(otherSettled.seq);
    expect(events.filter(({ seq, kind, payload }) => seq > resolved.seq && seq < otherSettled.seq &&
      (kind === "attempt.reserved" && (payload.binding as MissionAttemptBinding)?.continuationOf === yielded.attemptId ||
        kind === "budget.reservation.adjusted" && payload.reservationId === minimum.payload.reservationId))).toEqual([]);
    const consumed = events.filter(({ kind, payload }) => kind === "budget.reservation.adjusted" &&
      payload.reservationId === minimum.payload.reservationId && payload.amount === 0);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]!.attemptId).toBe(continuations[0]!.attemptId);
    expect(consumed[0]!.seq).toBeGreaterThan(otherSettled.seq);
    const bound = continuations[0]!.payload.binding as MissionAttemptBinding;
    expect(events.find(({ kind, attemptId }) => kind === "attempt.receipt" && attemptId === bound.attemptId)?.payload)
      .toMatchObject({ status: "completed" });
    expect(events.find(({ kind, attemptId }) => kind === "attempt.settled" && attemptId === bound.attemptId)?.payload)
      .toMatchObject({ status: "succeeded" });
    expect(events.filter(({ kind, unitId }) => kind === "unit.accepted" && unitId === "impl").map(({ attemptId }) => attemptId))
      .toEqual([bound.attemptId]);
    expect(continuationWrites.get(bound.attemptId)).toBe("completed");
    expect(bound).toMatchObject({ roundId: "main", memberId: "solo", attemptNo: 2,
      checkpointHash: admitted.payload.checkpointHash, childResultHash: resolved.payload.resultHash,
      consultationId: admitted.payload.requestId });
    expect(bound.candidateRoot !== (source.payload.binding as MissionAttemptBinding).candidateRoot).toBe(true);
    expect(readFileSync(path.join(bound.candidateRoot!, "src/target.txt"), "utf8")).toBe("continued\n");
    expect(readFileSync(path.join(sample.root, "src/target.txt"), "utf8")).toBe("source\n");
    expect(assessed).toEqual([{ unitId: "other", result: "other result" }, { unitId: "impl", result: "continuation result" }]);
    expect(events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "other")).toBe(true);
    expect(events.some(({ kind, unitId }) => kind === "unit.blocked" && unitId === "impl")).toBe(false);
    expect(hash(store.readArtifact(String(admitted.payload.checkpointHash)))).toBe(String(admitted.payload.checkpointHash));
    const protectedIds = events.filter(({ kind, payload }) => kind === "reservation.created" && payload.purpose === "protected")
      .map(({ payload }) => payload.reservationId);
    expect(events.some(({ kind, payload }) => kind === "budget.reservation.adjusted" &&
      protectedIds.includes(payload.reservationId))).toBe(false);
    expect(events.some(({ kind }) => kind === "mission.completed")).toBe(false);
  } finally {
    releaseOther();
    try { await engine?.retireForShutdown("quit"); }
    finally {
      store?.close();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      delete (globalThis as Record<string, unknown>).__pitako_mission_local;
      rmSync(sample.base, { recursive: true, force: true });
    }
  }
}, 120000);
