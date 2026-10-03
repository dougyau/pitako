import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine } from "../extensions/mission/engine.ts";
import { FINALIZATION_PHASES, currentWholeResultApproval, observeSourceMutation, sourceWitnessCurrent } from "../extensions/mission/finalization.ts";
import { captureWorkspaceImage } from "../extensions/mission/workspace.ts";
import { assessMissionCompletion, missionCompletionCertificate } from "../extensions/mission/completion.ts";
import { readSealedWorkspaceImage, reconcileMission } from "../extensions/mission/reconcile.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";
import { openMissionStore } from "../extensions/mission/store.ts";

const evidenceRoot = process.env.PITAKO_SLICE4B_EVIDENCE;

async function runCase(name: string, changed = false) {
  const twoCommands = ["two-commands", "failed-second-gate"].includes(name);
  const failedGate = ["failed-gate", "failed-second-gate"].includes(name);
  const sample = createMissionFixture(`pitako-finalization-${name}-`);
  const prior = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
  mkdirSync(path.join(sample.root, "src")); writeFileSync(path.join(sample.root, "src/a"), "original\n");
  execFileSync("git", ["add", "src"], { cwd: sample.root });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const provider = await installMissionLocalProvider({ agentDir, responseForPrompt(prompt) {
    if (!prompt.includes('"format":"mission-finalization-brief-v1"')) return "producer response";
    const brief = JSON.parse(prompt.slice(prompt.indexOf('{"format":"mission-finalization-brief-v1"')).split("\n", 1)[0]!);
    if (brief.target.phase === "whole-review") {
      return JSON.stringify({ ...brief.expectedResponse, ...(name === "wrong-manifest" ? { manifestHash: "0".repeat(64) } : {}),
        verdict: "approve" });
    }
    return JSON.stringify({ ...brief.expectedResponse, steps: brief.expectedResponse.steps.map((skill: string, index: number) => ({
      skill, changedPaths: changed && brief.target.phase === "cleanup" && index === 0 ? ["src/a"] : [],
      noOpReason: "Changed scope inspected; preserve the checked product behavior",
    })) });
  } });
  const definition = missionDefinition();
  definition.finalization.contractVersion = 1;
  definition.authority.allowedPaths = ["src/**"];
  definition.authority.operations = ["write", "bash"];
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
  definition.authority.rolePolicies.reviewer = { hash: "b".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
  definition.units = [{ id: "product", role: "developer", kind: "implementation", dependencies: [], inputs: ["."], outputs: ["src/a"],
    acceptance: twoCommands ? [
      { id: "nonempty", kind: "command_exit", target: "result", command: "printf 'first-command\\n'; test -s src/a", expected: "0", timeoutMs: 3000 },
      { id: "product-present", kind: "command_exit", target: "result", command: "printf 'second-command\\n'; grep -q product src/a", expected: "0", timeoutMs: 3000 },
    ] : [{ id: "product-present", kind: "command_exit", target: "result", command: "grep -q product src/a", expected: "0", timeoutMs: 3000 }],
    risk: "low", retryLimit: 0 }];
  definition.finalization.requiredPredicates = definition.units[0]!.acceptance.map(({ id }) => id);
  definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 10000, activeTimeMs: 120000, artifactBytes: 32_000_000 };
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  let store = await openFixtureStore(sample);
  let engine: MissionEngine | undefined;
  let reviewReady!: () => void;
  let releaseReview!: () => void;
  const ready = new Promise<void>((resolve) => { reviewReady = resolve; });
  const released = new Promise<void>((resolve) => { releaseReview = resolve; });
  try {
    const mission = store.createMission(missionInput(sample));
    let recovery: ReturnType<typeof reconcileMission> | undefined;
    if (name === "clean-report") {
      const append = store.appendTransition.bind(store);
      store.appendTransition = (id, version, transition) => {
        const result = append(id, version, transition);
        if (transition.events.some((row) => row.kind === "mission.activated"))
          recovery = reconcileMission({ store, missionId: mission.id, sourceRoot: sample.root, planFile: sample.planFile });
        return result;
      };
    }
    const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
    const options = { store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
      runRole: async (...args: Parameters<typeof runner>) => {
        const [input, durable] = args;
        if (!input.binding.finalization || changed && input.binding.finalization.phase === "cleanup") {
          const receipt = await durable.effects!.invoke("write", { path: "src/a", content: failedGate && input.binding.finalization ?
            "broken\n" : changed && input.binding.finalization ? "product\n# simplified\n" : "product\n" });
          expect(receipt.status).toBe("completed");
        }
        if (input.binding.finalization?.phase === "whole-review") {
          expect(durable.readOnly).toBe(true);
          const denied = await durable.effects!.invoke("write", { path: "src/a", content: "not authorized" });
          expect(denied.status).toBe("denied");
        }
        const result = await runner(...args);
        if (input.binding.finalization?.phase === "ponytail" && name === "ordered") {
          await expect(Promise.resolve().then(() => durable.onProviderDispatch({
            requestId: randomUUID(), provider: provider.provider, model: provider.model,
          }))).rejects.toThrow(/retaining remaining mandatory stages/);
        }
        if (input.binding.finalization?.phase === "whole-review" && ["paused-review", "cancelled-review"].includes(name)) {
          reviewReady(); await released;
        }
        return result;
      } };
    engine = new MissionEngine(options); engine.start();
    if (name === "clean-report") {
      const report = await recovery!;
      expect(report.status).toBe("resumed");
      expect(report.blockers).toEqual([]);
      expect(report.disposition.causes).toEqual([]);
    }
    if (["paused-review", "cancelled-review"].includes(name)) {
      await ready;
      engine.start();
      expect(store.inspectMission(mission.id).events.filter((row) => row.kind === "attempt.reserved" &&
        (row.payload.binding as { finalization?: { phase: string } }).finalization?.phase === "whole-review")).toHaveLength(1);
      const stopped = engine.control(name === "paused-review" ? "pause" : "cancel");
      releaseReview(); await stopped;
      expect(currentWholeResultApproval(store.inspectMission(mission.id), store, sample.root)).toBeUndefined();
      if (name === "paused-review") {
        await engine.retireForShutdown("quit");
        store = await openFixtureStore(sample);
        engine = new MissionEngine({ ...options, store });
        await engine.control("resume");
      }
    }
    await engine.waitForIdle();
    let inspection = store.inspectMission(mission.id);
    if (evidenceRoot) {
      const out = path.join(evidenceRoot, name); mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "journal-initial.json"), JSON.stringify(inspection, null, 2));
      provider.flush(path.join(out, "provider-initial.json")); await store.exportMission(mission.id, path.join(out, "export-initial"));
    }
    const phases = inspection.events.filter((event) => event.kind === "mission.finalization.phase.receipted");
    if (twoCommands) {
      const gateObservations = ["integrated-checks", "affected-checks", "final-gates"].map((phase) => {
        const start = inspection.events.find((row) => row.kind === "mission.finalization.phase.started" &&
          (row.payload.target as { phase: string }).phase === phase)!;
        const receiptRow = phases.find((row) => row.attemptId === start.attemptId);
        const hashes = receiptRow ? JSON.parse(store.readArtifact(String(receiptRow.payload.receiptHash)).toString()).evidenceHashes :
          inspection.events.find((row) => row.kind === "attempt.settled" && row.attemptId === start.attemptId)!.payload.evidenceHashes;
        const observations = (hashes as string[]).map((hash) => store.readArtifact(hash).toString())
          .filter((text) => text.startsWith("{")).map((text) => JSON.parse(text))
          .filter((row) => row.format === "mission-predicate-observation-v1");
        expect(observations.map((row) => row.predicate.id)).toEqual(["nonempty", "product-present"]);
        expect(observations.map((row) => row.verdict)).toEqual(failedGate && phase === "final-gates" ? ["pass", "inconclusive"] : ["pass", "pass"]);
        expect(new Set(observations.map((row) => row.receipt.effectId)).size).toBe(2);
        for (const [index, observation] of observations.entries()) {
          expect(observation.subject.imageHash).toBe((start.payload.target as { inputArtifactHash: string }).inputArtifactHash);
          expect(observation.receipt.status).toBe(failedGate && phase === "final-gates" && index === 1 ? "failed" : "completed");
          expect(observation.receipt.exitCode).toBe(failedGate && phase === "final-gates" && index === 1 ? 1 : 0);
          expect(store.readArtifact(observation.stdoutHash).toString()).toBe(index === 0 ? "first-command\n" : "second-command\n");
          const terminal = inspection.events.find((row) => row.kind === "effect.receipt" && row.effectId === observation.receipt.effectId);
          expect(terminal?.payload.termination).toBe("exit");
        }
        return { phase, observations };
      });
      if (evidenceRoot) writeFileSync(path.join(evidenceRoot, name, "gate-observations.json"), JSON.stringify(gateObservations, null, 2));
    }
    if (["wrong-manifest", "cancelled-review"].includes(name) || failedGate) {
      expect(phases.map((row) => (row.payload.target as { phase: string }).phase)).toEqual(FINALIZATION_PHASES.slice(0, failedGate ? -2 : -1));
      expect(currentWholeResultApproval(inspection, store, sample.root)).toBeUndefined();
      expect(inspection.events.some((row) => row.kind === "mission.finalization.reviewed")).toBe(false);
      if (name === "wrong-manifest") expect(inspection.events.some((row) => String(row.payload.reason).includes("exact current manifest"))).toBe(true);
      if (failedGate) {
        const failed = inspection.events.find((row) => row.kind === "attempt.settled" && String(row.payload.reason).includes("final-gates:product-present"));
        expect(failed).toBeDefined();
        const observations = (failed!.payload.evidenceHashes as string[]).map((hash) => store.readArtifact(hash).toString())
          .filter((text) => text.startsWith("{")).map((text) => JSON.parse(text));
        expect(observations.some((row) => row.format === "mission-predicate-observation-v1" &&
          row.verdict === "inconclusive" && row.receipt.exitCode === 1)).toBe(true);
        expect(provider.trace).toHaveLength(3);
      }
    } else {
      expect(phases.map((row) => (row.payload.target as { phase: string }).phase)).toEqual([...FINALIZATION_PHASES]);
      const approval = currentWholeResultApproval(inspection, store, sample.root);
      expect(approval?.verdict).toBe("approve");
      expect(assessMissionCompletion(inspection, store).blockers).toEqual([]);
      expect(missionCompletionCertificate(inspection, store)).toBeDefined();
      const result = readSealedWorkspaceImage(store, JSON.parse(store.readArtifact(String(phases.at(-1)!.payload.receiptHash)).toString()).outputArtifactHash);
      expect(result.files.find((row) => row.path === "src/a")?.bytes?.toString()).toBe(changed ? "product\n# simplified\n" : "product\n");
      const sessions = provider.trace.map((row) => row.sessionId);
      expect(new Set(sessions).size).toBe(4);
      expect(inspection.reservations.filter((row) => row.resource === "role-launches" && row.purpose === "finalization")).toHaveLength(3);
      expect(inspection.reservations.filter((row) => row.resource === "provider-requests" && row.purpose === "finalization")).toHaveLength(3);
      expect(inspection.events.filter((row) => row.kind === "provider.request.dispatched")).toHaveLength(4);
      const launches = inspection.events.filter((row) => row.kind === "attempt.reserved").length;
      await engine.retireForShutdown("quit");
      store = name === "clean-report"
        ? await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true })
        : await openFixtureStore(sample);
      engine = new MissionEngine({ ...options, store });
      expect(() => engine!.start()).toThrow("completed cannot start");
      if (name === "clean-report") engine = undefined;
      inspection = store.inspectMission(mission.id);
      if (name === "clean-report") {
        expect(inspection.events.at(-1)?.kind).toBe("mission.owner.released");
        expect(inspection.events.at(-1)?.payload.effectsQuiescent).toBe(true);
      }
      if (evidenceRoot) {
        writeFileSync(path.join(evidenceRoot, name, "journal-reopen.json"), JSON.stringify(inspection, null, 2));
        writeFileSync(path.join(evidenceRoot, name, "witness-reopen.json"), JSON.stringify({ before: JSON.parse(store.readArtifact(approval!.sourceWitnessHash).toString()),
          after: observeSourceMutation(sample.root, captureWorkspaceImage(sample.root).manifest, inspection.planId) }, null, 2));
      }
      expect(inspection.events.filter((row) => row.kind === "attempt.reserved")).toHaveLength(launches);
      expect(inspection.events.filter((row) => row.kind === "mission.finalization.reviewed")).toHaveLength(1);
      expect(currentWholeResultApproval(inspection, store, sample.root)?.manifestHash).toBe(approval!.manifestHash);
      if (name === "clean-report") expect(missionCompletionCertificate(inspection, store)).toBeDefined();
      const root = path.resolve(import.meta.dir, "..");
      const node = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, ["--experimental-strip-types",
        path.join(root, "scripts/mission-finalization-node.mjs"), sample.dbPath, sample.objectDir, mission.id, sample.root],
        { cwd: root, encoding: "utf8" });
      expect(node.status, node.stderr + node.stdout).toBe(0);
      if (evidenceRoot) {
        const out = path.join(evidenceRoot, name); mkdirSync(out, { recursive: true });
        writeFileSync(path.join(out, "node-observation.json"), node.stdout);
        writeFileSync(path.join(out, "journal.json"), JSON.stringify(inspection, null, 2));
        provider.flush(path.join(out, "provider.json")); await store.exportMission(mission.id, path.join(out, "export"));
      }
      const mutationPath = name === "ordered" ? sample.planFile : path.join(sample.root, "src/a");
      const originalBytes = readFileSync(mutationPath);
      const originalManifest = captureWorkspaceImage(sample.root).manifest.hash;
      expect(sourceWitnessCurrent(store, approval!.sourceWitnessHash, sample.root)).toBe(true);
      writeFileSync(mutationPath, "temporary\n");
      writeFileSync(mutationPath, originalBytes);
      expect(readFileSync(mutationPath).equals(originalBytes)).toBe(true);
      expect(captureWorkspaceImage(sample.root).manifest.hash).toBe(originalManifest);
      expect(sourceWitnessCurrent(store, approval!.sourceWitnessHash, sample.root)).toBe(false);
      expect(currentWholeResultApproval(inspection, store, sample.root)).toBeUndefined();
      expect(missionCompletionCertificate(store.inspectMission(mission.id), store)).toBeUndefined();
      if (evidenceRoot) writeFileSync(path.join(evidenceRoot, name, "journal-after-invalidation.json"),
        JSON.stringify(store.inspectMission(mission.id), null, 2));
    }
    expect(readFileSync(path.join(sample.root, "src/a"), "utf8")).toBe("original\n");
    expect(inspection.events.filter((row) => row.kind === "unit.accepted").map((row) => row.unitId)).toEqual(["product"]);
    expect(missionCompletionCertificate(inspection, store)).toBeUndefined();
    expect(inspection.events.some((row) => row.kind === "mission.completed")).toBe(!["wrong-manifest", "cancelled-review"].includes(name) && !failedGate);
    if (evidenceRoot && (["wrong-manifest", "cancelled-review"].includes(name) || failedGate)) {
      const out = path.join(evidenceRoot, name); mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "journal.json"), JSON.stringify(inspection, null, 2));
      provider.flush(path.join(out, "provider.json")); await store.exportMission(mission.id, path.join(out, "export"));
    }
  } finally {
    releaseReview();
    try { await engine?.retireForShutdown("quit"); }
    finally {
      store.close(); rmSync(sample.base, { recursive: true, force: true });
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
      delete (globalThis as Record<string, unknown>)[`__${provider.provider.replace(/\W/g, "_")}`];
    }
  }
}

test("production SDK schedules exact current seven phases, no-op cleanup, distinct Reviewer, restart reuse and ignored frozen-plan edit-restore invalidation", () => runCase("ordered"), 90000);
test("production SDK contains cleanup and checks changed result before exact whole review", () => runCase("changed-cleanup", true), 90000);
test("production SDK mismatched whole-result response never obtains approval", () => runCase("wrong-manifest"), 90000);
test("durable completed SDK review held by pause is ingested once on explicit valid resume", () => runCase("paused-review"), 90000);
test("cancellation during real Reviewer lifecycle blocks completed receipt approval", () => runCase("cancelled-review"), 90000);
test("failed post-cleanup production gate preserves its actual inconclusive receipt and never launches Reviewer", () => runCase("failed-gate", true), 90000);
test("production SDK assesses two distinct required commands through every host gate before whole review", () => runCase("two-commands"), 90000);
test("production SDK retains genuine failing second-command evidence without final gate receipt or approval", () => runCase("failed-second-gate", true), 90000);
test("clean production recovery report permits contained checks, completion and quiescent reopen", () => runCase("clean-report"), 90000);
