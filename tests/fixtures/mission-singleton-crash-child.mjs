import path from "node:path";
import { createPiExecutor } from "../../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine } from "../../extensions/mission/engine.ts";
import { openMissionStore } from "../../extensions/mission/store.ts";
import { installMissionLocalProvider } from "../mission-local-provider.ts";

const [dbPath, objectDir, missionId, root, agentDir, traceFile, cut = "receipt", operation = "none"] = process.argv.slice(2);
const request = JSON.stringify({ format: "mission-consultation-request-v1", question: "Inspect", evidenceRefs: ["evidence:a"],
  members: ["one", "two", "three"].map((id) => ({ id, role: "developer", perspective: id })), synthesisRole: "developer" });
const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: () => request });
const store = await openMissionStore({ dbPath, objectDir });
const append = store.appendTransition.bind(store);
store.appendTransition = (id, version, transition) => {
  const committed = append(id, version, transition);
  if (transition.events.some(({ kind, payload }) => cut === "receipt" && kind === "attempt.receipt" ||
    cut === "seal" && kind === "workspace.snapshot.sealed" && payload.purpose === "consultation" ||
    cut === "admission" && kind === "team.consultation.admitted")) process.kill(process.pid, "SIGKILL");
  return committed;
};
const runner = createPiMissionRunner({ cwd: root, executor: createPiExecutor(),
  load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: path.join(agentDir, "pitako", "config.toml") } });
const engine = new MissionEngine({ store, missionId, maxConcurrent: 1, sessionsDirectory: path.join(path.dirname(dbPath), "sessions"),
  managedWorkspace: { sourceRoot: root, candidateParent: path.join(path.dirname(path.dirname(path.dirname(dbPath))), "candidates") },
  runRole: async (input, durable) => {
    if (operation.startsWith("bash")) {
      const effect = await durable.effects.invoke("bash", {
        command: operation === "bash-failed" ? "exit 1" : "printf 'private candidate\\n' > src/target.txt",
      });
      if (effect.status !== (operation === "bash-failed" ? "failed" : "completed"))
        throw new Error(`unexpected Bash disposition: ${effect.status} ${effect.stderr}`);
    }
    const result = await runner(input, durable);
    provider.flush(traceFile);
    return result;
  } });
engine.start();
await engine.waitForIdle();
throw new Error("worker unexpectedly survived receipt cut");
