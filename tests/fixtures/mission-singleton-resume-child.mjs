import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPiExecutor } from "../../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine } from "../../extensions/mission/engine.ts";
import { openMissionStore } from "../../extensions/mission/store.ts";
import { installMissionLocalProvider } from "../mission-local-provider.ts";

const [dbPath, objectDir, missionId, root, agentDir, traceFile, cut = "complete"] = process.argv.slice(2);
const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: (prompt) => {
  if (prompt.includes('"format":"mission-singleton-continuation-v1"')) return "continuation result";
  if (!prompt.startsWith("Read-only ")) throw new Error("original singleton was repeated");
  const bundle = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1).split("\n", 1)[0]);
  if (bundle.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase,
    round: bundle.round, memberId: bundle.memberId, classifications: bundle.priorFindings.map(({ id, evidenceRefs }) =>
      ({ findingId: id, evidenceRefs, category: "uncertainty", reason: "Check independently" })) });
  const peer = bundle.priorFindings?.find(({ id }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
  return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
    findings: [{ id: "f", claim: "Inspect", evidenceRefs: ["evidence:a"], detail: { recommendation: "Check", impact: "Bound" },
      ...(peer ? { respondsTo: { id: peer.id, evidenceRefs: peer.evidenceRefs } } : {}) }] });
} });
const priorTrace = existsSync(traceFile) ? JSON.parse(readFileSync(traceFile, "utf8")).trace : [];
function flush() { writeFileSync(traceFile, JSON.stringify({ format: "mission-local-provider-trace-v1", trace: [...priorTrace, ...provider.trace] })); }
const store = await openMissionStore({ dbPath, objectDir });
const append = store.appendTransition.bind(store);
let cutDone = false;
store.appendTransition = (id, version, transition) => {
  const committed = append(id, version, transition);
  if (!cutDone && transition.events.some(({ kind, payload }) =>
    cut === "member-receipt" && kind === "attempt.receipt" && payload.role === "developer" &&
      store.inspectMission(id).events.filter((event) => event.kind === "attempt.receipt").length === 2 ||
    cut === "member-started" && kind === "attempt.started" &&
      store.inspectMission(id).events.some((event) => event.kind === "attempt.reserved" && event.attemptId === payload.attemptId &&
        event.payload.binding?.teamBundleHash) ||
    cut === "recorded" && kind === "team.member.recorded" ||
    cut === "barrier" && kind === "team.barrier.recorded" && payload.round === "independent" ||
    cut === "resolved" && kind === "team.consultation.resolved" ||
    cut === "reserved" && kind === "attempt.reserved" && payload.binding?.continuationOf ||
    cut === "continuation-receipt" && kind === "attempt.receipt" &&
      store.inspectMission(id).events.some((event) => event.kind === "attempt.reserved" && event.attemptId === payload.attemptId && event.payload.binding?.continuationOf))) {
    cutDone = true; flush(); process.kill(process.pid, "SIGKILL");
  }
  return committed;
};
const runner = createPiMissionRunner({ cwd: root, executor: createPiExecutor(),
  load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: path.join(agentDir, "pitako", "config.toml") } });
const engine = new MissionEngine({ store, missionId, sessionsDirectory: path.join(path.dirname(dbPath), "sessions"),
  managedWorkspace: { sourceRoot: root, candidateParent: path.join(path.dirname(path.dirname(path.dirname(dbPath))), "candidates") },
  runRole: async (input, durable) => {
    if (input.binding.continuationOf && !input.binding.teamBundleHash) {
      const effect = await durable.effects.invoke("write", { path: "src/target.txt", content: "continued\n" });
      if (effect.status !== "completed") throw new Error(`continuation effect ${effect.status}`);
    }
    const result = await runner(input, durable); flush(); return result;
  }, assessPredicate: ({ resultArtifact }) => ({ verdict: resultArtifact.toString() === "continuation result" ? "pass" : "fail",
    method: "host continuation assessment" }) });
engine.start(); await engine.waitForIdle(); flush();
await engine.retireForShutdown("quit");
