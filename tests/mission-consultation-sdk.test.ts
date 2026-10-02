import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import agentExtension from "../extensions/agent/index.ts";
import { createPiMissionRunner, MissionEngine } from "../extensions/mission/engine.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";

const saved = process.env.PI_CODING_AGENT_DIR;
test("real Pi SDK yields a request without spawn tools, runs child, then only continuation satisfies parent", async () => {
  const sample = createMissionFixture("pitako-consultation-sdk-");
  const agentDir = path.join(sample.base, "agent");
  const providerName = "pitako-mission-local";
  const config = path.join(agentDir, "pitako", "config.toml");
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let engine: MissionEngine | undefined;
  try {
    mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: (prompt) => {
      const bundle = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1).split("\n", 1)[0]!);
      if (!bundle.targetId && bundle.round === "independent" && bundle.memberId === "alpha" && !bundle.childResultHash)
        return JSON.stringify({ format: "mission-consultation-request-v1", question: "Examine evidence a", evidenceRefs: ["evidence:a"],
          members: ["one", "two", "three"].map((id) => ({ id, role: "developer", perspective: id })), synthesisRole: "developer" });
      if (bundle.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase,
        round: bundle.round, memberId: bundle.memberId, classifications: bundle.priorFindings.map(({ id, evidenceRefs }: { id: string; evidenceRefs: string[] }) =>
          ({ findingId: id, evidenceRefs, category: "uncertainty", reason: "Independent verification required" })) });
      const target = bundle.priorFindings?.find(({ id }: { id: string }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
      return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
        findings: [{ id: "f", claim: "Inspect", evidenceRefs: ["evidence:a"], detail: { criterion: "Correctness", observation: "Inspect" },
          ...(target ? { respondsTo: { id: target.id, evidenceRefs: target.evidenceRefs } } : {}) }] });
    } });
    const definition = missionDefinition();
    definition.units = [{ id: "experts", dependencies: [], kind: "team", role: "developer", inputs: ["evidence:a"], outputs: ["advice"],
      acceptance: [{ id: "advice", kind: "manual", target: "host" }], risk: "medium", retryLimit: 0,
      team: { version: 1, phase: "review", synthesisRole: "developer", members: ["alpha", "beta", "gamma"].map((id) =>
        ({ id, role: "developer", perspective: id })) } }];
    definition.finalization.requiredPredicates = ["advice"];
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: providerName, model: "fixture", fallbacks: [] };
    definition.budget = { roleLaunches: 35, providerRequests: 35, tokens: 7000, activeTimeMs: 2100000, artifactBytes: 140000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      runRole: createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
        load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } }),
      assessPredicate: () => ({ verdict: "pass", method: "host observation" }) });
    engine.start(); await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    expect(provider.trace).toHaveLength(21);
    expect(provider.trace.every(({ toolCount }) => toolCount === 0)).toBe(true);
    expect(new Set(provider.trace.map(({ sessionId }) => sessionId)).size).toBe(21);
    expect(events.filter(({ kind }) => kind === "team.consultation.admitted")).toHaveLength(1);
    expect(events.filter(({ kind }) => kind === "team.consultation.resolved")).toHaveLength(1);
    expect(events.filter(({ kind, payload }) => kind === "attempt.settled" && payload.status === "yielded")).toHaveLength(1);
    expect(events.filter(({ kind }) => kind === "unit.accepted")).toHaveLength(1);
    expect(events.some(({ kind }) => kind === "mission.completed" || kind === "effect.intent")).toBe(false);
    process.env.PI_CODING_AGENT_DIR = sample.stateDir;
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
    const invoke = (name: string, assignmentId: string) => tools.get(name)!.execute("call", { assignmentId },
      new AbortController().signal, undefined, { cwd: sample.root });
    const parent = events.find((event) => event.kind === "attempt.settled" && event.payload.status === "yielded")!;
    const child = events.find((event) => event.kind === "team.consultation.admitted")!;
    const continuation = events.find((event) => event.kind === "attempt.reserved" &&
      (event.payload.binding as { continuationOf?: string }).continuationOf === parent.attemptId)!;
    const status = await invoke("team_status", parent.attemptId!);
    expect(status.details.assignments).toMatchObject([{ status: "continued", resultAvailable: false,
      childTargetId: child.payload.targetId, childResultHash: events.find((event) => event.kind === "team.consultation.resolved")?.payload.resultHash,
      continuationAssignmentId: continuation.attemptId }]);
    const result = await invoke("team_result", parent.attemptId!);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("mission-consultation-request-v1");
    const childSynthesis = events.find((event) => event.kind === "attempt.reserved" &&
      event.payload.targetId === child.payload.targetId && event.payload.roundId === "synthesis")!;
    const advice = await invoke("team_result", childSynthesis.attemptId!);
    expect(advice.details).toMatchObject({ advisory: true, resultAvailable: true, round: "synthesis", memberId: "synthesis" });
    expect(advice.content[0].text).toContain("Advisory child synthesis; not unit acceptance");
    expect((await invoke("team_result", continuation.attemptId!)).details).toMatchObject({ continuationOf: parent.attemptId, resultAvailable: true });
    expect((await invoke("team_status", parent.attemptId!)).details).toEqual(status.details);
  } finally {
    await engine?.close(); store?.close();
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    delete (globalThis as Record<string, unknown>)[`__${providerName.replace(/\W/g, "_")}`];
    rmSync(sample.base, { recursive: true, force: true });
  }
}, 180000);
