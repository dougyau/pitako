import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registerHooks, stripTypeScriptTypes } from "node:module";
// Node's native loader refuses third-party .ts. This fixture uses Node's own stripper, not a product fallback.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && context.parentURL?.includes("/node_modules/pi-lsp-client/") &&
      specifier.startsWith(".") && specifier.endsWith(".js") && existsSync(new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL)))
      return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
    throw error;
  }
}, load(url, context, nextLoad) {
  if (url.includes("/node_modules/") && url.endsWith(".ts"))
    return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true };
  return nextLoad(url, context);
} });
const { createPiExecutor } = await import("../extensions/agent/pi.ts");
import { createPiMissionRunner, MissionEngine } from "../extensions/mission/engine.ts";
import { missionCompletionCertificate } from "../extensions/mission/completion.ts";
import { captureWorkspaceImage } from "../extensions/mission/workspace.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "../tests/mission-fixtures.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";

const cases = [
  { name: "pass", command: "test \"$(cat src/a)\" = accepted", timeoutMs: 2000, verdict: "pass", termination: "exit" },
  { name: "subject-alias", command: "test \"$(cat /tmp/pitako/source/src/a)\" = accepted", timeoutMs: 2000, verdict: "pass", termination: "exit" },
  { name: "failure", command: "exit 7", timeoutMs: 2000, verdict: "inconclusive", termination: "exit" },
  { name: "timeout", command: "sleep 2", timeoutMs: 20, verdict: "inconclusive", termination: "timeout" },
  { name: "writable-denied", command: "echo forbidden > src/a", timeoutMs: 2000, verdict: "inconclusive", termination: "exit" },
];
for (const scenario of cases) test(`production Node SDK checker ${scenario.name}`, async () => {
  const sample = createMissionFixture(`pitako-node-check-${scenario.name}-`);
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
  mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src/a"), "source\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: () => "PASS" });
  const definition = missionDefinition();
  definition.finalization.contractVersion = 1;
  definition.authority.allowedPaths = ["src/**"];
  definition.authority.operations = ["write", "bash"];
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
  definition.units[0].kind = "implementation";
  definition.units[0].inputs = ["."];
  definition.units[0].acceptance = [{ id: "snapshot-present", kind: "command_exit", target: "result", expected: "0", command: scenario.command, timeoutMs: scenario.timeoutMs }];
  definition.budget = { roleLaunches: 8, providerRequests: 8, tokens: 8000, activeTimeMs: 480000, artifactBytes: 16_000_000 };
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(sample);
  let engine;
  try {
    const mission = store.createMission(missionInput(sample));
    const source = captureWorkspaceImage(sample.root).manifest.hash;
    const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(), load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
      runRole: async (input, durable) => {
        assert.equal((await durable.effects.invoke("write", { path: "src/a", content: "accepted\n" })).status, "completed");
        return runner(input, durable);
      } });
    engine.start(); await engine.waitForIdle();
    const inspection = store.inspectMission(mission.id);
    const evidence = inspection.events.find((event) => event.kind === "evidence.recorded");
    assert.ok(evidence, JSON.stringify(inspection.events.filter((event) => event.kind === "unit.blocked")));
    assert.equal(evidence.payload.assessmentAuthority, "production-checker");
    const observation = JSON.parse(store.readArtifact(evidence.payload.artifactHash).toString());
    assert.equal(observation.runtimeIdentity, `node:${process.version}`);
    assert.equal(observation.verdict, scenario.verdict);
    assert.equal(observation.receipt.termination, scenario.termination);
    assert.equal(observation.command, scenario.command);
    assert.ok(observation.executionInputIdentity.indexHash);
    assert.ok(observation.executionInputIdentity.hash);
    assert.equal(observation.receipt.process.namespaceEmptyAfterExit, true);
    assert.ok(store.readArtifact(observation.stdoutHash));
    assert.ok(store.readArtifact(observation.stderrHash));
    assert.equal(inspection.events.some((event) => event.kind === "unit.accepted"), scenario.verdict === "pass");
    assert.equal(inspection.events.some((event) => event.kind === "mission.result.integrated"), scenario.verdict === "pass");
    assert.equal(inspection.events.some((event) => event.kind === "mission.completed"), false);
    assert.equal(missionCompletionCertificate(inspection, store), undefined);
    assert.equal(captureWorkspaceImage(sample.root).manifest.hash, source);
    if (process.env.PITAKO_SLICE4A_EVIDENCE) {
      const out = path.join(process.env.PITAKO_SLICE4A_EVIDENCE, `node-${scenario.name}`);
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "observation.json"), JSON.stringify(observation, null, 2));
      writeFileSync(path.join(out, "journal.json"), JSON.stringify(inspection, null, 2));
      provider.flush(path.join(out, "provider.json"));
      await store.exportMission(mission.id, path.join(out, "export"));
    }
  } finally {
    await engine?.retireForShutdown("quit"); store.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__pitako_mission_local;
    rmSync(sample.base, { recursive: true, force: true });
  }
});
