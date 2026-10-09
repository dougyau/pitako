import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine, type MissionAttemptBinding } from "../extensions/mission/engine.ts";
import type { MissionUnit } from "../extensions/mission/model.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore, type MissionFixture } from "./mission-fixtures.ts";
import { installMissionLocalProvider, type LocalProviderFixture } from "./mission-local-provider.ts";

const fixtures: MissionFixture[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const providerGlobals: string[] = [];
afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const key of providerGlobals.splice(0)) delete (globalThis as Record<string, unknown>)[key];
  for (const fixture of fixtures.splice(0)) rmSync(fixture.base, { recursive: true, force: true });
});

function unit(id: string, dependencies: string[], predicateId: string): MissionUnit {
  return {
    id,
    dependencies,
    kind: "consultation",
    role: "developer",
    inputs: [],
    outputs: [`${id}.result`],
    acceptance: [{ id: predicateId, kind: "manual", target: `oracle:${id}` }],
    risk: "low",
    retryLimit: 0,
  };
}

function configureFixture(): MissionFixture {
  const sample = createMissionFixture("pitako-mission-sdk-");
  fixtures.push(sample);
  const definition = missionDefinition();
  definition.goal = "Run a deterministic provider fixture through the persistent Pi SDK";
  definition.units = [unit("first", [], "first-check"), unit("second", ["first"], "second-check")];
  definition.finalization.requiredPredicates = ["first-check", "second-check"];
  definition.budget = { roleLaunches: 8, providerRequests: 12, tokens: 1200, activeTimeMs: 120000, artifactBytes: 1024 * 1024 };
  const provider = "pitako-mission-local";
  definition.authority.rolePolicies = {
    developer: { hash: "a".repeat(64), provider, model: "fixture", fallbacks: [] },
  };
  sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
  writeFileSync(sample.definitionFile, sample.definitionBytes);
  return sample;
}

describe("persistent Pi mission runner", () => {
  test("uses deterministic local SDK sessions and records provider provenance without foreground result reads", async () => {
    const sample = configureFixture();
    const agentDir = path.join(sample.base, "agent");
    const config = path.join(agentDir, "pitako", "config.toml");
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, "");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const provider: LocalProviderFixture = await installMissionLocalProvider({ agentDir });
    const globalKey = `__${provider.provider.replace(/\W/g, "_")}`;
    providerGlobals.push(globalKey);
    const store = await openFixtureStore(sample);
    const record = store.createMission(missionInput(sample));
    const evidenceDir = path.join(sample.base, "evidence");
    const runner = createPiMissionRunner({
      cwd: sample.root,
      executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config },
    });
    const engine = new MissionEngine({
      store,
      missionId: record.id,
      sessionsDirectory: path.join(sample.stateDir, "pitako", "sessions"),
      runRole: async (input, durable) => {
        expect(createHash("sha256").update(JSON.stringify(input.brief)).digest("hex")).toBe(input.binding.briefHash);
        const reservation = store.inspectMission(record.id).events.find(({ kind, attemptId }) =>
          kind === "attempt.reserved" && attemptId === input.binding.attemptId)!;
        expect((reservation.payload.binding as MissionAttemptBinding).briefHash).toBe(input.binding.briefHash);
        const json = (label: string) => JSON.parse(input.brief.split("\n").find((line) => line.startsWith(`${label}: `))!.slice(label.length + 2));
        expect(json("Acceptance")).toEqual(input.unit.acceptance);
        expect(json("Previous attempt")).toBeNull();
        expect(input.brief).toContain("all predicates remain current host obligations");
        if (input.unit.id === "second") {
          const first = engine.snapshot().units.first!;
          expect(json("Dependencies")).toEqual([{ unitId: "first", status: "accepted",
            evidence: first.evidenceIds.map((evidenceId) => ({ evidenceId, revision: 1 })) }]);
        } else expect(json("Dependencies")).toEqual([]);
        const result = await runner(input, durable);
        const prompt = provider.trace.find(({ sessionId }) => sessionId === input.binding.attemptId)!.prompt;
        expect(prompt).toContain(input.brief);
        expect(prompt).toContain(`Mission goal: ${record.definition.goal}`);
        expect(prompt).toContain("Return findings only. Do not claim completion, evidence, or budget authority.");
        return result;
      },
      assessPredicate: ({ predicate, resultArtifact }) => ({
        verdict: resultArtifact.length > 0 ? "pass" : "fail",
        method: `host fixture check for ${predicate.target}`,
      }),
    });

    engine.start();
    await engine.waitForIdle();
    provider.flush(path.join(evidenceDir, "local-provider-trace.json"));

    const inspection = store.inspectMission(record.id);
    const snapshot = engine.snapshot();
    const trace = JSON.parse(readFileSync(path.join(evidenceDir, "local-provider-trace.json"), "utf8")) as { trace: LocalProviderFixture["trace"] };
    const receipts = inspection.events.filter(({ kind }) => kind === "provider.request.receipt");
    expect(snapshot.units.first?.status).toBe("accepted");
    expect(snapshot.units.second?.status).toBe("accepted");
    expect(snapshot.canFinalize).toBe(true);
    expect(trace.trace).toHaveLength(2);
    expect(new Set(trace.trace.map(({ sessionId }) => sessionId)).size).toBe(2);
    expect(trace.trace.every(({ sessionId }) => /^[0-9a-f-]{36}$/.test(sessionId))).toBe(true);
    expect(receipts.map(({ payload }) => [payload.provider, payload.model, payload.inputTokens, payload.outputTokens])).toEqual([
      [provider.provider, provider.model, 17, 8],
      [provider.provider, provider.model, 17, 8],
    ]);
    expect(inspection.measurements).toHaveLength(2);
    expect(inspection.measurements.every(({ value, inputTokens, outputTokens, usageUnknownReason }) => value === 25 && inputTokens === 17 && outputTokens === 8 && usageUnknownReason === undefined)).toBe(true);
    const attempts = inspection.events.filter(({ kind }) => kind === "attempt.receipt");
    expect(attempts).toHaveLength(2);
    const stageArtifactDir = process.env.MISSION_STAGE_ARTIFACT_DIR;
    if (stageArtifactDir) {
      mkdirSync(stageArtifactDir, { recursive: true });
      writeFileSync(path.join(stageArtifactDir, "t2-runtime-observed.json"), `${JSON.stringify({
        format: "mission-t2-runtime-observed-v1",
        missionId: record.id,
        unitStatuses: { first: snapshot.units.first?.status, second: snapshot.units.second?.status },
        canFinalize: snapshot.canFinalize,
        executionPath: ["MissionEngine.start", "MissionEngine.waitForIdle"],
        foregroundResultTool: "not installed in this runtime harness",
        attempts: attempts.map(({ payload }) => ({ attemptId: payload.attemptId, status: payload.status })),
        providerSessions: trace.trace.map(({ sessionId }) => sessionId),
        providerReceipts: receipts.map(({ payload }) => ({ provider: payload.provider, model: payload.model, inputTokens: payload.inputTokens, outputTokens: payload.outputTokens })),
        paidRequests: 0,
      }, null, 2)}\n`);
    }
    expect(attempts.every(({ payload }) => (payload.model as { selectedModel?: string }).selectedModel === `${provider.provider}/${provider.model}`)).toBe(true);
    expect(attempts.every(({ payload }) => (payload.usage as { toolCalls?: number }).toolCalls === 0)).toBe(true);
    const firstAttempt = Object.values(snapshot.attempts).find(({ binding }) => binding.unitId === "first")!;
    for (const attempt of Object.values(snapshot.attempts)) {
      const sessionDir = path.join(sample.stateDir, "pitako", "sessions", record.id, attempt.binding.attemptId);
      const sessionFile = path.join(sessionDir, readdirSync(sessionDir).find((name) => name.endsWith(`_${attempt.binding.attemptId}.jsonl`))!);
      expect(readFileSync(sessionFile, "utf8")).toContain("Local fixture response");
      expect(path.resolve(sessionFile)).not.toContain(path.resolve(sample.root) + path.sep);
    }
    const priorMessageCount = trace.trace[0]!.messageCount;
    const resumed = await runner({
      missionId: record.id,
      unit: unit("first", [], "first-check"),
      binding: firstAttempt.binding,
      brief: "Resume the same durable Pi SDK session.",
    }, {
      attemptId: firstAttempt.binding.attemptId,
      sessionDir: path.join(sample.stateDir, "pitako", "sessions", record.id, firstAttempt.binding.attemptId),
      sessionId: firstAttempt.binding.attemptId,
      readOnly: true,
      rolePolicy: { primary: { model: `${provider.provider}/${provider.model}` }, fallbacks: [] },
      onProviderDispatch: ({ requestId }) => ({ kind: "metered", ticketId: requestId, operationId: requestId,
        resource: "tokens", revision: firstAttempt.binding.revision, ownerEpoch: firstAttempt.binding.ownerEpoch }),
      onProviderReceipt: () => {},
      onOutcome: () => {},
    });
    expect(resumed.status).toBe("completed");
    expect(provider.trace[2]?.sessionId).toBe(firstAttempt.binding.attemptId);
    expect(provider.trace[2]?.messageCount).toBeGreaterThan(priorMessageCount);
    const deniedId = randomUUID();
    let deniedReceipts = 0;
    const denied = await runner({
      missionId: record.id,
      unit: unit("first", [], "first-check"),
      binding: { ...firstAttempt.binding, attemptId: deniedId },
      brief: "The budget gate rejects this before provider dispatch.",
    }, {
      attemptId: deniedId,
      sessionDir: path.join(sample.stateDir, "pitako", "sessions", record.id, deniedId),
      sessionId: deniedId,
      readOnly: true,
      rolePolicy: { primary: { model: `${provider.provider}/${provider.model}` }, fallbacks: [] },
      onProviderDispatch: () => { throw new Error("fixture budget refused"); },
      onProviderReceipt: () => { deniedReceipts += 1; },
      onOutcome: () => {},
    });
    expect(denied.status).toBe("failed");
    expect(deniedReceipts).toBe(0);
    expect(provider.trace).toHaveLength(3);
    await engine.close();
    store.close();
  }, 60000);
});
