import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine } from "../extensions/mission/engine.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";

const saved = process.env.PI_CODING_AGENT_DIR;
// ponytail: fixtures share the executor's process-global agent dir/provider; serialize cases, not SDK members.
for (const soloFinding of [false, true]) test.serial(`real SDK dispatches ten team sessions (${soloFinding ? "solo finding" : "full findings"})`, async () => {
  const sample = createMissionFixture("pitako-team-sdk-");
  const agentDir = path.join(sample.base, "agent");
  const providerName = "pitako-mission-local";
  const providerKey = `__${providerName.replace(/\W/g, "_")}`;
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let engine: MissionEngine | undefined;
  try {
    const config = path.join(agentDir, "pitako", "config.toml");
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, "");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: (prompt) => {
      const bundle = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1).split("\n", 1)[0]!);
      if (bundle.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round,
        memberId: bundle.memberId, classifications: bundle.priorFindings.map(({ id, evidenceRefs }: { id: string; evidenceRefs: string[] }) => ({
          findingId: id, evidenceRefs, category: "uncertainty", reason: "Independent evidence is required",
        })) });
      if (soloFinding && (bundle.round === "independent" && bundle.memberId !== "alpha" ||
        bundle.round === "critique" && bundle.memberId === "alpha" ||
        bundle.round === "rebuttal" && bundle.memberId !== "alpha"))
        return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round,
          memberId: bundle.memberId, findings: [] });
      const peer = bundle.priorFindings?.find(({ id }: { id: string }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
      return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
        findings: [{ id: "finding", claim: "Inspect this claim", evidenceRefs: [`evidence:${bundle.memberId}`],
          detail: { criterion: "Correctness", observation: "Read-only observation" },
          ...(peer ? { respondsTo: { id: peer.id, evidenceRefs: peer.evidenceRefs } } : {}) }] });
    } });
    const definition = missionDefinition();
    definition.goal = "Review claims without making edits";
    definition.units = [{ id: "review-team", kind: "team", role: "developer", dependencies: [], inputs: ["question"], outputs: ["advice"],
      acceptance: [{ id: "review-assessed", kind: "manual", target: "host-check" }], risk: "medium", retryLimit: 0,
      team: { version: 1, phase: "review", synthesisRole: "developer", members: ["alpha", "beta", "gamma"].map((id) => ({ id, role: "developer", perspective: id })) } }];
    definition.finalization.requiredPredicates = ["review-assessed"];
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: providerName, model: "fixture", fallbacks: [] };
    definition.budget = { roleLaunches: 20, providerRequests: 20, tokens: 4000, activeTimeMs: 1200000, artifactBytes: 100000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      runRole: createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
        load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } }),
      assessPredicate: () => ({ verdict: "pass", method: "fixture host assessment" }) });
    engine.start(); await engine.waitForIdle();
    const events = store.inspectMission(mission.id).events;
    expect(events.filter(({ kind }) => kind === "team.barrier.recorded").map(({ payload }) => payload.status)).toEqual(["complete", "complete", "complete", "complete"]);
    expect(events.filter(({ kind }) => kind === "provider.request.receipt")).toHaveLength(10);
    expect(provider.trace).toHaveLength(10);
    expect(new Set(provider.trace.map(({ sessionId }) => sessionId)).size).toBe(10);
    expect(provider.trace.slice(0, 3).every(({ prompt }) => !prompt.includes("priorFindings"))).toBe(true);
    if (soloFinding) {
      expect(events.filter(({ kind, payload }) => kind === "team.member.recorded" && payload.status === "valid")).toHaveLength(10);
      const synthesis = JSON.parse(provider.trace.at(-1)!.response);
      expect(synthesis.classifications).toHaveLength(4);
      expect(synthesis.classifications.every(({ category }: { category: string }) => category === "uncertainty")).toBe(true);
      const alphaCritique = provider.trace.find(({ response }) => {
        const { round, memberId } = JSON.parse(response);
        return round === "critique" && memberId === "alpha";
      });
      expect(alphaCritique).toBeDefined();
      expect(alphaCritique!.response).toContain('"findings":[]');
    }
    expect(events.filter(({ kind }) => kind === "unit.accepted")).toHaveLength(1);
    expect(events.filter(({ kind }) => kind === "mission.completed")).toHaveLength(0);
    expect(readdirSync(path.join(sample.base, "sessions", mission.id))).toHaveLength(10);
  } finally {
    await engine?.close(); store?.close();
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    delete (globalThis as Record<string, unknown>)[providerKey];
    rmSync(sample.base, { recursive: true, force: true });
  }
}, 90000);
