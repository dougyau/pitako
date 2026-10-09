import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine } from "../extensions/mission/engine.ts";
import { sha256, type AcceptancePredicate } from "../extensions/mission/model.ts";
import { assertCompleteWorkspaceImage, applyConditionalMissionPatch, missionHasUnresolvedEffects, readSealedWorkspaceImage } from "../extensions/mission/reconcile.ts";
import { captureWorkspaceImage, createMissionWorkspace } from "../extensions/mission/workspace.ts";
import { missionCompletionCertificate } from "../extensions/mission/completion.ts";
import { createFixtureRejectionCapture, createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";

const evidenceRoot = process.env.PITAKO_SLICE4A_EVIDENCE;
async function runCase(name: string, predicates: AcceptancePredicate[][], overlap = false, lineage = false) {
  const sample = createMissionFixture(`pitako-output-${name}-`);
  const dependent = name.startsWith("dependency");
  const mixedLineage = name === "dependency-lineage";
  const chain = name === "dependency-chain";
  const refinement = name === "dependency-refinement" || mixedLineage || chain;
  const prior = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(sample.base, "agent");
  const config = path.join(agentDir, "pitako", "config.toml");
  mkdirSync(path.dirname(config), { recursive: true }); writeFileSync(config, "");
  mkdirSync(path.join(sample.root, "src"));
  writeFileSync(path.join(sample.root, "src", "a"), "base-a\n");
  writeFileSync(path.join(sample.root, "src", "b"), "base-b\n");
  symlinkSync("a", path.join(sample.root, "src", "link"));
  chmodSync(path.join(sample.root, "src", "a"), 0o755);
  execFileSync("git", ["add", "src"], { cwd: sample.root });
  writeFileSync(path.join(sample.root, "src", "b"), "dirty-b\n");
  writeFileSync(path.join(sample.root, "untracked"), "keep user bytes\n");
  if (name === "ignored-output") writeFileSync(path.join(sample.root, ".gitignore"), "src/hidden\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const rejectionCapture = createFixtureRejectionCapture(evidenceRoot ? path.join(evidenceRoot, name, "rejections") : undefined, name);
  let engine: MissionEngine | undefined;
  const hold = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let held = false;
  let rootResponses = 0;
  let clock = 0;
  const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: (prompt) => {
    if (!lineage || mixedLineage && prompt.includes("Unit: first (")) return "PASS";
    if (prompt.includes("mission-singleton-continuation-v1")) return "PASS";
    if (!prompt.startsWith("Read-only ")) return rootResponses++ ? "PASS" : JSON.stringify({ format: "mission-consultation-request-v1",
      question: "Inspect checkpoint", evidenceRefs: ["evidence:a"], members: ["one", "two", "three"].map((id) => ({ id, role: "developer", perspective: id })), synthesisRole: "developer" });
    const bundle = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1).split("\n", 1)[0]!);
    if (bundle.round === "synthesis") return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase,
      round: bundle.round, memberId: bundle.memberId, classifications: bundle.priorFindings.map(({ id, evidenceRefs }: { id: string; evidenceRefs: string[] }) =>
        ({ findingId: id, evidenceRefs, category: "uncertainty", reason: "Host check required" })) });
    const peer = bundle.priorFindings?.find(({ id }: { id: string }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
    return JSON.stringify({ format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
      findings: [{ id: "f", claim: "Inspect", evidenceRefs: ["evidence:a"], detail: { recommendation: "Check", impact: "Bound" },
        ...(peer ? { respondsTo: { id: peer.id, evidenceRefs: peer.evidenceRefs } } : {}) }] });
  }, responseGate: async (prompt) => {
    if (lineage && !held && prompt.includes("mission-singleton-continuation-v1")) { held = true; entered.resolve(); await hold.promise; }
  } });
  const definition = missionDefinition();
  definition.finalization.contractVersion = 1;
  definition.authority.allowedPaths = ["src/**"];
  definition.authority.operations = ["write", "bash"];
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
  definition.units = predicates.map((acceptance, index) => ({ id: ["first", "second", "third"][index]!, role: "developer", kind: "implementation",
    dependencies: dependent && index ? [chain && index === 2 ? "second" : "first"] : [], inputs: mixedLineage && !index ? ["src/link"] : lineage ? [".", "evidence:a"] : ["."], outputs: [`src/${index && !refinement ? "b" : "a"}`], acceptance, risk: "low", retryLimit: 0 }));
  definition.finalization.requiredPredicates = predicates.flatMap((rows) => rows.map(({ id }) => id));
  definition.budget = { roleLaunches: 25, providerRequests: 25, tokens: 25000, activeTimeMs: 1_500_000, artifactBytes: 32_000_000 };
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(sample);
  try {
    const mission = store.createMission(missionInput(sample));
    const original = captureWorkspaceImage(sample.root);
    let deliverySource = original;
    const runner = createPiMissionRunner({ cwd: sample.root, executor: createPiExecutor(),
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
    engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
      ...(name.startsWith("command-window-renewal") ? { now: () => clock } : {}),
      ...(rejectionCapture ? { captureRejection: rejectionCapture.captureRejection } : {}),
      ...(name === "injected" ? { assessPredicate: () => ({ verdict: "pass" as const, method: "injected PASS", authority: "production-checker" as const }) } : {}),
      runRole: async (input, durable) => {
        if (dependent && input.unit.id !== "first" && !input.binding.teamBundleHash && !input.binding.continuationOf && !input.binding.recoveryOf)
          expect(readFileSync(path.join(durable.cwd!, "src/a"), "utf8")).toBe(input.unit.id === "third" ? "refined\n" : "first\n");
        if (!input.binding.teamBundleHash && !input.binding.recoveryOf) {
          const second = input.unit.id !== "first" || lineage && !!input.binding.continuationOf;
          const ownContinuation = !!input.binding.continuationOf;
          const receipt = await durable.effects!.invoke("write", { path: name === "unknown-effect" ? "src/credentials.txt" : `src/${second && !overlap && (!refinement || ownContinuation) ? "b" : "a"}`,
            content: chain && input.unit.id === "third" ? "final\n" : refinement && input.unit.id === "second" && !ownContinuation ? "refined\n" : second ? "second\n" : "first\n" });
          expect(receipt.status).toBe(name === "unknown-effect" ? "unknown" : "completed");
          if (name === "ignored-output") expect((await durable.effects!.invoke("write", { path: "src/hidden", content: "generated contribution\n" })).status).toBe("unknown");
        }
        if (input.binding.recoveryOf) {
          expect(durable.readOnly).toBe(true);
          expect(readFileSync(path.join(durable.cwd!, "src/a"), "utf8")).toBe(mixedLineage ? "refined\n" : "first\n");
          expect(readFileSync(path.join(durable.cwd!, "src/b"), "utf8")).toBe("second\n");
        }
        const result = await runner(input, durable);
        if (name.startsWith("command-window-renewal")) clock = name.endsWith("near-expiry") ? 55_001 : 60_001;
        if (name === "source-drift" && input.unit.id === "second") {
          writeFileSync(path.join(sample.root, "untracked"), "current user bytes\n");
          writeFileSync(path.join(sample.root, "operator.txt"), "staged current input\n");
          execFileSync("git", ["add", "operator.txt"], { cwd: sample.root });
          deliverySource = captureWorkspaceImage(sample.root);
        }
        return result;
      } });
    engine.start();
    if (lineage) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([entered.promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`continuation never entered: ${JSON.stringify(store.inspectMission(mission.id).events.filter((event) => ["team.consultation.denied", "unit.blocked", "resource.wait"].includes(event.kind)))}`)), mixedLineage ? 40000 : 20000);
        })]);
      } finally { clearTimeout(timer); }
      const pausing = engine.control("pause", { id: "pause-own-image", text: "/mission pause" });
      setTimeout(() => hold.resolve(), 100);
      await pausing;
      expect(store.inspectMission(mission.id).events.some((event) => event.kind === "attempt.settled" && event.payload.status === "interrupted")).toBe(true);
      await engine.control("resume", { id: "resume-own-image", text: "/mission resume" });
    }
    await engine.waitForIdle();
    const inspection = store.inspectMission(mission.id);
    if (name === "ignored-output") {
      const producer = inspection.events.find((event) => event.kind === "attempt.reserved")!.payload.binding as { candidateRoot: string };
      const generated = readFileSync(path.join(producer.candidateRoot, "src/hidden"), "utf8");
      const unknown = inspection.events.find((event) => event.kind === "effect.unknown" &&
        Array.isArray(event.payload.paths) && event.payload.paths.some((row: { path: string }) => row.path === "src/hidden"));
      rejectionCapture?.captureRejection({ boundary: "ignored-output", producer, generated, unknown });
      expect(generated).toBe("generated contribution\n");
      expect(unknown?.payload).toMatchObject({ status: "unknown", paths: [{
        path: "src/hidden", before: { kind: "missing" }, after: { kind: "file", hash: sha256(Buffer.from(generated)) },
      }] });
      expect(inspection.events.some((event) => event.kind === "effect.receipt" && event.effectId === unknown?.effectId)).toBe(false);
      expect(missionHasUnresolvedEffects(store, inspection.events)).toBe(true);
    }
    if (overlap) {
      const blocked = inspection.events.find((event) => event.payload.integrationConflictHash);
      expect(blocked).toBeDefined();
      const conflict = JSON.parse(store.readArtifact(String(blocked!.payload.integrationConflictHash)).toString());
      expect(readSealedWorkspaceImage(store, conflict.currentImageHash).files.find((file) => file.path === "src/a")?.bytes?.toString()).toBe("first\n");
      expect(readSealedWorkspaceImage(store, conflict.intendedImageHash).files.find((file) => file.path === "src/a")?.bytes?.toString()).toBe("second\n");
    }
    if (name === "injected") {
      expect(inspection.events.find((event) => event.kind === "unit.accepted")?.payload.outputBindingHash).toBeUndefined();
      expect(inspection.events.find((event) => event.kind === "evidence.recorded")?.payload.assessmentAuthority).toBe("injected-test");
    }
    const integrated = inspection.events.find((event) => event.kind === "mission.result.integrated");
    const report = integrated ? JSON.parse(store.readArtifact(String(integrated.payload.reportHash)).toString()) : undefined;
    expect(inspection.events.some((event) => event.kind === "mission.completed")).toBe(false);
    expect(missionCompletionCertificate(inspection, store)).toBeUndefined();
    expect(captureWorkspaceImage(sample.root).manifest.hash).toBe(deliverySource.manifest.hash);
    if (report) {
      const result = readSealedWorkspaceImage(store, report.resultImageHash);
      assertCompleteWorkspaceImage(result);
      expect(result.files.find(({ path }) => path === "src/a")?.bytes?.toString()).toBe(chain ? "final\n" : refinement ? "refined\n" : "first\n");
      expect(result.files.find(({ path }) => path === "src/b")?.bytes?.toString()).toBe((predicates.length > 1 && !refinement) || lineage ? "second\n" : "dirty-b\n");
      expect(result.files.find(({ path }) => path === "src/a")?.mode).toBe(0o755);
      expect(result.files.find(({ path }) => path === "src/link")?.bytes?.toString()).toBe("a");
      expect(result.files.find(({ path }) => path === "untracked")?.bytes?.toString()).toBe(name === "source-drift" ? "current user bytes\n" : "keep user bytes\n");
      if (name === "source-drift") {
        expect(result.files.find(({ path }) => path === "operator.txt")?.bytes?.toString()).toBe("staged current input\n");
        expect(readSealedWorkspaceImage(store, report.originalBaseImageHash).manifest.hash).toBe(original.manifest.hash);
        expect(report.deliveryBaseManifestHash).not.toBe(original.manifest.hash);
      }
      if (lineage) {
        const contribution = report.contributions[mixedLineage ? 1 : 0];
        expect(contribution.lineage).toHaveLength(3);
        expect(contribution.executionStartImageHash).toBe(contribution.terminalImageHash);
        expect(contribution.sourceBaseImageHash).not.toBe(contribution.executionStartImageHash);
      }
      for (const contribution of report.contributions) {
        const input = contribution.contributionInput;
        const origin = contribution.lineage.find((row: { attemptId: string }) => row.attemptId === input.originAttemptId);
        expect(input.baseImageHash).toBe(origin.executionStartImageHash);
        const output = JSON.parse(store.readArtifact(contribution.outputHash).toString());
        const proof = JSON.parse(store.readArtifact(output.terminalOutputHash).toString());
        expect(proof.contributionInput).toEqual(input);
        for (const dependency of input.dependencyOutputs) {
          expect(inspection.events.some((event) => event.kind === "unit.accepted" && event.unitId === dependency.unitId &&
            event.attemptId === dependency.attemptId && event.payload.outputBindingHash === dependency.outputBindingHash)).toBe(true);
        }
        if (dependent && contribution.unitId !== "first") {
          const parent = report.contributions.find((row: { unitId: string }) => row.unitId === (contribution.unitId === "third" ? "second" : "first"));
          expect(input.baseImageHash).toBe(parent.terminalImageHash);
          expect(input.baseImageHash).not.toBe(contribution.sourceBaseImageHash);
        }
      }
      expect(report.inputIdentity.source.indexHash).toBe(deliverySource.manifest.indexHash);
      expect(report.inputIdentity.source.indexEntries).toEqual(deliverySource.manifest.indexEntries);
      const disposable = await createMissionWorkspace({ missionId: mission.id, attemptId: crypto.randomUUID(), sourceRoot: sample.root,
        storeRoot: store.storageRoot, candidateParent: path.join(sample.base, "copies"), allowedPaths: [] });
      const patch = JSON.parse(store.readArtifact(report.patchHash).toString());
      expect(applyConditionalMissionPatch(patch, disposable).hash).toBe(report.acceptedManifestHash);
      writeFileSync(path.join(disposable.candidateRoot, "src", "a"), "wrong preimage");
      expect(() => applyConditionalMissionPatch(patch, disposable)).toThrow(/preimage mismatch/);
      writeFileSync(path.join(sample.root, "untracked"), "source drift");
      expect(() => applyConditionalMissionPatch(patch, disposable)).toThrow(/precondition mismatch/);
    }
    if (evidenceRoot) {
      const out = path.join(evidenceRoot, name); mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "journal.json"), JSON.stringify(inspection, null, 2));
      if (report) writeFileSync(path.join(out, "result.json"), JSON.stringify(report, null, 2));
      provider.flush(path.join(out, "provider.json"));
      await store.exportMission(mission.id, path.join(out, "export"));
    }
    const outcome = { accepted: inspection.events.filter((event) => event.kind === "unit.accepted").length,
      integrated: !!integrated, reason: inspection.events.filter((event) => event.kind === "mission.blocked").at(-1)?.payload.reason,
      observations: inspection.events.filter((event) => event.kind === "evidence.recorded").map((event) =>
        event.payload.artifactHash ? JSON.parse(store.readArtifact(String(event.payload.artifactHash)).toString()) : event.payload), sdkRequests: provider.trace.length };
    await engine.retireForShutdown("quit"); engine = undefined;
    const node = spawnSync("node", ["scripts/mission-output-node.mjs", sample.dbPath, sample.objectDir, mission.id], { encoding: "utf8", timeout: 20000 });
    if (evidenceRoot) writeFileSync(path.join(evidenceRoot, name, "node.json"), node.stdout + node.stderr);
    expect(node.status).toBe(0);
    return outcome;
  } catch (error) {
    console.error(`production output case ${name} failed before cleanup:`, error);
    if (evidenceRoot) {
      const out = path.join(evidenceRoot, `${name}-failure-${Date.now()}`); mkdirSync(out, { recursive: true });
      const current = store.findManagedMission(sample.root);
      if (current) { writeFileSync(path.join(out, "journal.json"), JSON.stringify(current, null, 2)); await store.exportMission(current.id, path.join(out, "export")); }
      provider.flush(path.join(out, "provider.json"));
    }
    throw error;
  } finally {
    await engine?.retireForShutdown("quit"); store.close();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    delete (globalThis as Record<string, unknown>).__pitako_mission_local;
    rejectionCapture?.restore();
    rmSync(sample.base, { recursive: true, force: true });
  }
}
const pathCheck = (id: string, name: string, text: string): AcceptancePredicate => ({ id, kind: "artifact_hash", target: `path:src/${name}`, expected: sha256(Buffer.from(text)) });

test("production SDK checks integrate two independent authorized deltas and prove exact-base private delivery", async () => {
  expect(await runCase("independent", [[pathCheck("a", "a", "first\n")], [pathCheck("b", "b", "second\n")]])).toMatchObject({ accepted: 2, integrated: true, sdkRequests: 2 });
}, 90000);

test("production integration binds current staged and untracked source separately from original baseline", async () => {
  expect(await runCase("source-drift", [[pathCheck("a", "a", "first\n")], [pathCheck("b", "b", "second\n")]]))
    .toMatchObject({ accepted: 2, integrated: true });
}, 90000);

test("production dependent consumes accepted output bytes before its own execution", async () => {
  expect(await runCase("dependency", [[pathCheck("a", "a", "first\n")], [pathCheck("b", "b", "second\n")]]))
    .toMatchObject({ accepted: 2, integrated: true });
}, 90000);

test("production SDK dependent refinement integrates against accepted input, not original source", async () => {
  expect(await runCase("dependency-refinement", [[pathCheck("a", "a", "first\n")], [pathCheck("b", "a", "refined\n")]]))
    .toMatchObject({ accepted: 2, integrated: true });
}, 90000);

test("production SDK transitive dependent refinements restore and integrate each accepted input once", async () => {
  expect(await runCase("dependency-chain", [[pathCheck("a", "a", "first\n")], [pathCheck("b", "a", "refined\n")], [pathCheck("c", "a", "final\n")]]))
    .toMatchObject({ accepted: 3, integrated: true });
}, 90000);

test("production SDK dependent checkpoint and paused recovery retain own earlier deltas with no final delta", async () => {
  expect(await runCase("dependency-lineage", [[pathCheck("a", "a", "first\n")], [pathCheck("b", "a", "refined\n"), pathCheck("c", "b", "second\n")]], false, true))
    .toMatchObject({ accepted: 2, integrated: true });
}, 90000);

test("production SDK output overlap is explicit, never last-writer overwrite", async () => {
  expect(await runCase("overlap", [[pathCheck("a", "a", "first\n")], [pathCheck("b", "a", "second\n")]], true))
    .toMatchObject({ accepted: 2, integrated: false, reason: expect.stringContaining("overlap: src/a") });
}, 90000);

test("production SDK checkpoint and interrupted continuation retain full ancestry even with no final delta", async () => {
  expect(await runCase("lineage", [[pathCheck("a", "a", "first\n"), pathCheck("b", "b", "second\n")]], false, true))
    .toMatchObject({ accepted: 1, integrated: true });
}, 90000);

test("production false PASS and manual evidence remain unaccepted", async () => {
  expect(await runCase("false-pass", [[pathCheck("a", "a", "WRONG")]])).toMatchObject({ accepted: 0, integrated: false });
  expect(await runCase("manual", [[{ id: "a", kind: "manual", target: "result", expected: "PASS" }]])).toMatchObject({ accepted: 0, integrated: false });
  expect(await runCase("unknown-effect", [[pathCheck("a", "a", "first\n")]])).toMatchObject({ accepted: 0, integrated: false,
    reason: expect.stringContaining("unresolved local effect") });
}, 90000);

test("production SDK ignored generated output is inconclusive, never silently dropped from a result", async () => {
  expect(await runCase("ignored-output", [[pathCheck("a", "a", "first\n")]])).toMatchObject({ accepted: 0, integrated: false });
}, 90000);

test("injected PASS cannot mint production output even when it claims checker authority", async () => {
  expect(await runCase("injected", [[pathCheck("a", "a", "WRONG")]])).toMatchObject({ accepted: 1, integrated: false });
}, 90000);

test("production contained command pass, failure and timeout retain real receipts", async () => {
  for (const [name, command, timeoutMs, verdict, termination] of [["command-pass", "test \"$(cat src/a)\" = first", 2000, "pass", "exit"],
    ["command-fail", "exit 7", 2000, "inconclusive", "exit"], ["command-timeout", "sleep 3", 2000, "inconclusive", "timeout"]] as const) {
    const result = await runCase(name, [[{ id: "a", kind: "command_exit", target: "result", command, expected: "0", timeoutMs }]]);
    expect(result.observations[0]).toMatchObject({ verdict, receipt: { termination } });
    expect(result.accepted).toBe(verdict === "pass" ? 1 : 0);
  }
}, 90000);

test("production command cannot release GO after its whole-invocation bound expires during preparation", async () => {
  const result = await runCase("command-preparation-expiry", [[{
    id: "a", kind: "command_exit", target: "result", command: "sleep 2", expected: "0", timeoutMs: 20,
  }]]);
  expect(result.observations[0]).toMatchObject({
    verdict: "inconclusive",
    receipt: { status: "denied", reason: "command timeout exceeds current remaining effect time grant" },
  });
  expect(result.accepted).toBe(0);
}, 90000);

test("production command renews an insufficient ordinary grant after SDK disposal", async () => {
  for (const name of ["command-window-renewal", "command-window-renewal-near-expiry"]) {
    const result = await runCase(name, [[{
      id: "a", kind: "command_exit", target: "result", command: 'test "$(cat src/a)" = first', expected: "0", timeoutMs: 10000,
    }]]);
    expect(result.observations[0]).toMatchObject({ verdict: "pass", receipt: { termination: "exit" } });
    expect(result.accepted).toBe(1);
  }
}, 90000);
