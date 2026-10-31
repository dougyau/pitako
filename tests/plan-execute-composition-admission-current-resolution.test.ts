import { beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkills, formatSkillsForPrompt, parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgent } from "pi-subagents/agents";
import { loadPromptTemplates, expandPromptTemplate } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js";
import { resolveWorkflowResource } from "../node_modules/pi-subagents/src/workflows/workflow-resources.js";
import { consumeWorkflowResourcePermit } from "../node_modules/pi-subagents/src/shared/workflow-child-permit.js";
import { runWorkflowScript, validateWorkflowScript } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { resolvePiLaunchToolPlan } from "../node_modules/pi-subagents/src/runs/shared/child-tool-plan.js";
import { discoverAgents, discoverAgentsAll } from "../node_modules/pi-subagents/src/agents/agents.js";
import { resolveSkills } from "../node_modules/pi-subagents/src/agents/skills.js";
import { buildEffectiveSystemPrompt } from "../node_modules/pi-subagents/src/runs/shared/effective-system-prompt.js";
import { handleManagementAction } from "../node_modules/pi-subagents/src/agents/agent-management.js";
import { captureCheckpoint, sealCheckpoint } from "../extensions/execute-checkpoint.ts";
import { executeMaxCycles } from "../extensions/execute-settings.ts";
import registerPlanExecute, { executionResource } from "../extensions/plan-execute.ts";
import { profileNote } from "../extensions/profile.ts";
import { DEFAULT_SKILL_NAMES } from "../extensions/catalog.ts";
import { checkoutEvidence, digest, MAX_SPEC_BYTES, preliminarySpec, SPEC_SECTIONS, validateSpec } from "../extensions/spec-plans.ts";
import { planExecute, checkout, synchronousHostRelease, read, assignmentSpec, missionFiles, resourceWithAgentDir, childResponse, compositionFixture, nativeCheckpointFixture } from "./fixtures/plan-execute-composition.ts";

const composition = compositionFixture();
const { roots, disposers, workflowSettlements, checkpointCancellations, settleWorkflows, checkpointLifecycle, repository } = composition;
const native = nativeCheckpointFixture(composition);
const { startNativeCheckpoint, nativeCheckpointCase, nativeCheckpointInput } = native;

describe("plan/execute packaged composition", () => {
  // SDK/Node loader preparation is file-owned setup, not checkpoint-case work.
  beforeAll(async () => { if (!native.nativeCheckpoint) await startNativeCheckpoint(); });

  test.each(["complete", "failure", "cancel"])("checkpoint lifecycle settlement observes exit, streams and continuation: %s", async mode => {
    const root = repository(), marker = path.join(root, "ready"), release = path.join(root, "released");
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const watcher = watch(root, (_event, name) => { if (name === "ready") ready(); });
    const child = Bun.spawn(["node", "-e", `
      ${synchronousHostRelease(release)}
      const fs=require('node:fs');
      fs.writeSync(1,'owned stdout');fs.writeSync(2,'owned stderr');
      fs.writeFileSync(process.argv[1],'ready');
      process.stdin.once('data',()=>{fs.writeFileSync(process.argv[2],'finished');process.exit(${mode === "failure" ? 7 : 0});});
    `, marker, path.join(root, "finished")], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let continuations = 0;
    const primary = new Error("Controlled checkpoint child failed");
    const lifecycle = checkpointLifecycle(child, ([exit]) => {
      continuations++;
      expect(existsSync(root)).toBe(true);
      if (exit !== 0) throw primary;
      expect(readFileSync(path.join(root, "finished"), "utf8")).toBe("finished");
    }, { marker: release, roots: [root] });
    try {
      await started;
      if (mode === "cancel") await settleWorkflows();
      else child.stdin.write("finish");
      child.stdin.end();
      if (mode === "complete") await lifecycle.result;
      else if (mode === "failure") {
        let failure: unknown;
        try { await lifecycle.result; } catch (error) { failure = error; }
        expect(failure).toBe(primary);
      } else expect(await lifecycle.result).toBeUndefined();
      await lifecycle.settled;
      const [exit, stdout, stderr] = await lifecycle.observed;
      expect(exit).toBe(mode === "complete" ? 0 : mode === "failure" ? 7 : 143);
      expect(stdout).toBe("owned stdout"); expect(stderr).toBe("owned stderr");
      expect(child.signalCode).toBeNull();
      expect(child.exitCode).toBe(exit);
      expect(checkpointCancellations.size).toBe(0);
      expect(readFileSync(release, "utf8")).toBe("released");
      expect(continuations).toBe(mode === "cancel" ? 0 : 1);
      rmSync(root, { recursive: true });
      // The registered teardown join cannot run a consumer against deleted roots.
      await lifecycle.settled;
      expect(continuations).toBe(mode === "cancel" ? 0 : 1);
    } finally {
      watcher.close();
      lifecycle.cancel();
      await lifecycle.settled;
    }
  });

  test("checkpoint lifecycle settlement waits for an owned synchronous host before cleanup", async () => {
    const root = repository(), marker = path.join(root, "ready"), finished = path.join(root, "finished"),
      release = path.join(root, "released");
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const watcher = watch(root, (_event, name) => { if (name === "ready") ready(); });
    const host = `
      const fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(marker)},'ready');
      process.stdin.once('data',()=>{fs.writeFileSync(${JSON.stringify(finished)},'settled host');console.log('host settled');});
    `;
    const child = Bun.spawn(["node", "-e", `
      ${synchronousHostRelease(release)}
      hostPending = true;
      const output=require('node:child_process').execFileSync('node',['-e',${JSON.stringify(host)}],
        {stdio:['inherit','pipe','pipe'],encoding:'utf8'});
      hostPending = false;
      process.stdout.write(output);process.stderr.write('outer settled');
      setImmediate(()=>{});
    `], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let continuations = 0;
    const lifecycle = checkpointLifecycle(child, () => { continuations++; }, { marker: release, roots: [root] });
    try {
      await started;
      lifecycle.cancel();
      expect(existsSync(finished)).toBe(false);
      expect(existsSync(release)).toBe(false);
      expect(existsSync(root)).toBe(true);
      child.stdin.write("release host"); child.stdin.end();
      expect(await lifecycle.result).toBeUndefined();
      const [exit, stdout, stderr] = await lifecycle.observed;
      await lifecycle.settled;
      expect(exit).toBe(143);
      expect(stdout).toBe("host settled\n"); expect(stderr).toBe("outer settled");
      expect(readFileSync(finished, "utf8")).toBe("settled host");
      expect(readFileSync(release, "utf8")).toBe("released");
      expect(continuations).toBe(0); expect(checkpointCancellations.size).toBe(0);
      rmSync(root, { recursive: true });
      await lifecycle.settled;
      expect(continuations).toBe(0);
    } finally {
      watcher.close();
      child.stdin.end();
      lifecycle.cancel();
      await lifecycle.settled;
    }
  });

  test("checkpoint lifecycle settlement retains roots without a descendant release witness", async () => {
    const root = repository(), release = path.join(root, "released");
    const primary = new Error("Controlled host failure");
    const child = Bun.spawn(["node", "-e", `
      ${synchronousHostRelease(release)}
      hostPending = true;
      process.exit(7);
    `], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const lifecycle = checkpointLifecycle(child, ([exit]) => {
      expect(exit).toBe(7);
      throw primary;
    }, { marker: release, roots: [root] });
    try {
      await expect(lifecycle.result).rejects.toBe(primary);
      await lifecycle.settled;
      expect(roots).not.toContain(root);
      expect(existsSync(root)).toBe(true);
      expect(existsSync(release)).toBe(false);
    } finally {
      lifecycle.cancel();
      await lifecycle.settled;
      // This controlled child launched no descendants; its exit establishes release.
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(["clear", "material-gaps"])("bound admission recovery admits retained rephrased screening: %s", verdict => {
    const operation = recoverFiles(verdict);
    workflowSettlements.push(operation.then(() => {}, () => {}));
    return operation;
  });

  test.each(["native", "file", "pending", "unknown-settlement", "conflict", "missing", "wrong-association", "changed-after-capture", "persistence"])(
    "bound admission recovery reconciles exact retained query: %s", mode => {
      const operation = recoverFiles(`query-${mode}`);
      workflowSettlements.push(operation.then(() => {}, () => {}));
      return operation;
    });

  async function recoverFiles(verdict: string) {
    const query = verdict.startsWith("query-"), queryMode = verdict.slice(6);
    let failQueryAdmission = query;
    let originalPlan: any;
    const root = repository(), nativeRoot = repository();
    const { missionPath, statePath } = missionFiles(nativeRoot);
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
    mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    const source = path.join(root, ".pitako/plans/assignment.md");
    writeFileSync(source, content);
    const observedCandidate = () => { const { head, fingerprint } = checkoutEvidence(root); return { head, fingerprint }; };
    const metadata = { root, commonDir: path.join(root, ".git"), selected: { source, digest: digest(content) } };
    const resource = resourceWithAgentDir(path.join(nativeRoot, "private-agent"));
    const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath };
    const closingScript = (value: ReturnType<typeof resource.resolve>) => value.script;
    const expanded = resource.resolve(args);
    const installed = path.join(nativeRoot, "node_modules/pitako");
    for (const file of ["skills/execute/inspect.mjs", "skills/execute/ledger.mjs", "skills/execute/loader.mjs", "skills/execute/inspect.ts",
      "extensions/spec-plans.ts", "extensions/execute-retained.ts", "extensions/execute-checkpoint.ts", "extensions/execute-settings.ts", "extensions/execute-state.ts",
      "extensions/board/workspace.ts", "extensions/board/paths.ts", "extensions/errors.ts"]) {
      const target = path.join(installed, file);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.resolve(file), target);
    }
    const grants = new Map(expanded.hostCommands.map(grant => [grant.key, grant.command.replace(
      path.resolve("skills/execute/inspect.mjs"), path.join(installed, "skills/execute/inspect.mjs"))]));
    const storage = new Map<string, any>(), calls: string[] = [], statusCalls: string[] = [];
    const originals = new Map<string, string>();
    const boundary = {
      state: { get: (key: string) => structuredClone(storage.get(key)),
        set: (key: string, value: any) => {
          if (failQueryAdmission && value.loop?.recoveries?.[0]?.stage === "observed")
            throw Error("Controlled query-admission persistence cut");
          storage.set(key, structuredClone(value));
        } },
      launch: async (key: string, request: any) => {
        calls.push(key);
        const base = { key, ok: true, output: "", runId: `native-${key}`, artifactPaths: [], agent: request.agent };
        const response: any = request.agent === "pitako.execution-inspector" ? { ...base, structuredOutput: {
          status: "recovered", reason: "Read exact complete original plan", original: originalPlan, workerResult: null,
          originalAvailable: true, binding: "absent", comparison: "only-original", provenance: ["/controlled/producer-original.json"],
        } } : key.includes("critique-") ? { ...base, structuredOutput: { status: "ready", reason: "Checked source", challenges: key.endsWith("-b") ? [{ findingId: "a-1", assessment: "supported", evidence: "Caller inspected" }] : [] } } :
          key.includes("defense-") ? { ...base, structuredOutput: { status: "ready", reason: "Checked source", responses: [{ findingId: "a-1", disposition: "maintain", reason: "Reachable caller" }] } } :
          childResponse(key, request, metadata, observedCandidate());
        if (!query && key.endsWith("independent-a")) response.structuredOutput.findings = [{
          title: "Caller behavior", location: "src/api.ts:1", scenario: "Empty key", evidence: "Caller accepts key",
          impact: "Wrong selection", classification: "scoped-defect", requirement: "spec: preserve caller key",
        }];
        if (!query && key.endsWith("director-synthesis")) Object.assign(response.structuredOutput, {
          dispositions: [{ findingId: "a-1", decision: "include", classification: "scoped-defect", requirement: "spec: preserve caller key", reason: "Source inspected" }],
          screening: { verdict, reason: "Current consequence assessed", assessments: [{ findingId: "a-1", requirement: "spec: selection respects caller input", consequence: "Wrong selection", material: verdict === "material-gaps", reason: "Current caller evidence" }] },
        });
        if (key.endsWith(".director")) {
          response.structuredOutput.association.missionPath = missionPath;
          if (query) response.structuredOutput.sharedContext.material = "中😀\"\n'; globalThis.recoveryInjected = true; //".repeat(3000);
          originalPlan = structuredClone(response.structuredOutput);
        }
        if (request.agent === "pitako.checkout-observer") return response;
        const native = path.join(nativeRoot, response.runId), file = path.join(native, "structured-output/original.json");
        mkdirSync(path.dirname(file), { recursive: true });
        const original = JSON.stringify(response.structuredOutput);
        // Clear uses only native state; material-gaps uses only the exact file.
        // Neither may silently depend on the other carrying the body.
        if (verdict !== "clear" && verdict !== "query-native") { writeFileSync(file, original); originals.set(file, original); }
        writeFileSync(path.join(native, "status.json"), JSON.stringify({
          runId: response.runId, workflowKey: key, cwd: root, state: "complete",
          steps: [{ exitCode: 0, ...(["clear", "query-native"].includes(verdict) ? { structuredOutput: response.structuredOutput } : {}) }],
        }));
        return { ...response, ...(query && key.endsWith(".director") ? { structuredOutput: undefined } : {}),
          outputReference: file, outputArtifactPath: file, outputPathMapping: { requestedPath: String(request.output), savedPath: file },
          artifactPaths: [native, file], asyncDir: native, results: [{ structuredOutputPath: file }] };
      },
      status: async (runId: string) => {
        statusCalls.push(runId);
        return { key: runId, runId, ok: true, output: `Run: ${runId}\nState: complete`, artifactPaths: [], results: [] };
      },
      host: async (key: string) => {
        const stdout = key === "fixture-closing" ? JSON.stringify({ ...metadata, checkout: observedCandidate() })
          : execFileSync("sh", ["-c", grants.get(key)!], { cwd: root, encoding: "utf8" });
        expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(4096);
        return { key, kind: "command" as const, state: "passed" as const, ok: true, exitCode: 0,
          stdout, stderr: "", outputPath: path.join(nativeRoot, key + ".log"), durationMs: 0 };
      },
    };
    // Persist an earlier owned-library rejection AFTER the original was retained.
    // State is produced by the actual root, not stipulated as an expected verdict.
    const marker = '!(text(entry.requirement) || entry.requirement === null) ||';
    expect(expanded.script).toContain(marker);
    const failed = await runWorkflowScript({ ...boundary,
      script: query ? closingScript(expanded) : closingScript(expanded).replace(marker, "entry.requirement !== synthesis.dispositions.find(item => item.findingId === entry.findingId).requirement ||") });
    expect(failed.value).toMatchObject({ status: query ? "partial" : "blocked", phase: query ? "director" : "review", loopsConsumed: 1 });
    expect((failed.value as any).reason).toContain(query ? "Essential persistence failed" : "screening contradicts");
    failQueryAdmission = false;
    const before = structuredClone(storage.get("invoke-human-1"));
    if (query) {
      const recovery = storage.get("invoke-human-1").loop.recoveries[0];
      expect(recovery.stage).toBe("intention");
      expect(typeof recovery.ref.runId).toBe("string");
      const statusFile = path.join(recovery.ref.asyncDir, "status.json");
      if (queryMode === "pending") {
        const current = JSON.parse(readFileSync(statusFile, "utf8")); current.state = "running";
        writeFileSync(statusFile, JSON.stringify(current));
      }
      if (queryMode === "unknown-settlement") rmSync(statusFile);
      if (queryMode === "missing") {
        rmSync(statusFile); rmSync(recovery.ref.results[0].structuredOutputPath);
      }
      if (queryMode === "conflict") {
        const current = JSON.parse(readFileSync(statusFile, "utf8"));
        current.steps[0].structuredOutput = { status: "different-full-value" };
        writeFileSync(statusFile, JSON.stringify(current));
      }
      if (queryMode === "wrong-association") recovery.association.invocation = "unrelated";
    }
    const missionBytes = JSON.stringify(Object.fromEntries(storage));
    writeFileSync(statePath, missionBytes);
    calls.length = 0;
    const resolver = resourceWithAgentDir(path.join(nativeRoot, "private-agent"));
    const continuationArgs = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath };
    if (queryMode === "wrong-association") {
      expect(() => resolver.resolve(continuationArgs)).toThrow("Retained recovery association/stage conflicts");
      expect(calls).toEqual([]);
      expect(readFileSync(statePath, "utf8")).toBe(missionBytes);
      return;
    }
    const continuation = resolver.resolve(continuationArgs);
    expect(continuation.hostCommands).toHaveLength(3);
    const preliminary = JSON.parse(continuation.script.split("const config = ")[1]!.split(";\nconst pitakoReviewLibraryMode")[0]!);
    expect(preliminary.recovery.originals.length).toBeGreaterThan(0);
    expect(preliminary.recovery.references).toEqual(before.loop.recoveries?.length
      ? [before.loop.recoveries[0].ref] : before.loop.review.references);
    if (query && !["missing", "conflict", "pending"].includes(queryMode)) {
      expect(Buffer.byteLength(JSON.stringify(preliminary.recovery))).toBeGreaterThan(65536);
      expect(preliminary.recovery.originals[0].structuredOutput.original).toEqual(originalPlan);
    }
    if (queryMode === "changed-after-capture") {
      const ref = before.loop.recoveries[0].ref;
      const file = ref.results[0].structuredOutputPath;
      const changed = JSON.parse(readFileSync(file, "utf8")); changed.original.sharedContext.material += " END CHANGE beyond the CLI capture limit";
      writeFileSync(file, JSON.stringify(changed)); originals.set(file, JSON.stringify(changed));
    }
    const compliance = childResponse("invoke-human-1.l1.compliance", { agent: "pitako.reviewer" }, metadata, observedCandidate());
    const next = childResponse("invoke-human-1.l2.director", { agent: "pitako.execution-director" }, metadata, observedCandidate());
    Object.assign(next.structuredOutput, { status: "needs-decision", tasks: [], reason: "Intercept next ordinary director" });
    next.structuredOutput.association.missionPath = missionPath;
    const queryChildren = query ? Object.fromEntries(["t1.a1", "review.director-prepare", "review.independent-a",
      "review.independent-b", "review.director-synthesis", "compliance"].map(phase => {
        const key = `invoke-human-1.l1.${phase}`;
        return [key, childResponse(key, { agent: phase === "t1.a1" ? "pitako.worker" : "pitako.reviewer" }, metadata, observedCandidate())];
      })) : {};
    const closing = childResponse("invoke-human-1.l1.checkout", { agent: "pitako.checkout-observer" }, metadata, observedCandidate());
    queryChildren[closing.key] = closing;
    const child = Bun.spawn(["node", "-e", `(async () => {
      const { readFileSync } = require("node:fs");
      const { execFileSync } = require("node:child_process");
      const { runWorkflowScript } = await import(${JSON.stringify(new URL("../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href)});
      const input = JSON.parse(readFileSync(0, "utf8"));
      const storage = new Map(input.storage), calls = [], statuses = [], bytes = [], publications = [];
      const options = { script: input.script,
        state: { get: key => structuredClone(storage.get(key)), set: (key, value) => {
          if (input.queryMode === "persistence" && value.loop?.recoveries?.[0]?.stage === "observed") throw Error("Controlled retained-original save failure");
          storage.set(key, structuredClone(value));
        } },
        launch: async (key, request) => { calls.push(key); if (request.agent === "pitako.checkout-observer") publications.push(JSON.parse(request.task)); const value = input.children[key]; if (!value) throw Error("Forbidden relaunch: " + key); return value; },
        status: async ref => { statuses.push(ref); return { key: ref, runId: ref, ok: true, output: input.queryMode === "unknown-settlement" ? "Current settlement unavailable" : "Run: " + ref + "\\nState: complete", results: [] }; },
        host: async key => { const stdout = key === "fixture-closing" ? JSON.stringify(input.closing)
          : execFileSync("sh", ["-c", input.grants[key]], { cwd: input.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          bytes.push(Buffer.byteLength(stdout));
          return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout, stderr: "", durationMs: 0, outputPath: input.root + "/.pi/subagents/" + key + ".json" }; },
      };
      let old;
      if (["native", "file"].includes(input.queryMode)) {
        old = await runWorkflowScript({ ...options, script: input.script.replace(
          "return retainedReadOnlyOriginal(result, recovery.ref);", "return result;") });
        if (calls.length) throw Error("Old defect launched replacement work");
        storage.clear(); for (const [key, value] of input.storage) storage.set(key, structuredClone(value));
        if (bytes.length !== 1) throw Error("Historical contrast used extra admission operations");
        bytes.length = 0;
      }
      const result = await runWorkflowScript(options);
      console.log(JSON.stringify({ result, old, storage: [...storage], calls, statuses, bytes, publications, injected: globalThis.recoveryInjected ?? false }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: root, stdin: new TextEncoder().encode(JSON.stringify({ script: closingScript(continuation), root, closing: { ...metadata, checkout: observedCandidate() },
      storage: [...storage], grants: Object.fromEntries(grants), queryMode,
      children: query ? queryChildren : { [compliance.key]: compliance, [next.key]: next, [closing.key]: closing } })), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exit).toBe(0);
    const recovered = JSON.parse(stdout);
    expect(recovered.injected).toBe(false);
    if (query) {
      const succeeds = ["native", "file"].includes(queryMode);
      expect(recovered.result.value).toMatchObject({ status: succeeds ? "complete" : queryMode === "persistence" ? "partial" : "blocked", loopsConsumed: 1, maxLoops: 3 });
      if (queryMode === "changed-after-capture") expect(recovered.result.value.reason).toContain("originals changed between preliminary capture and native admission");
      if (queryMode === "persistence") expect(recovered.result.value.reason).toContain("Essential persistence failed");
      expect(recovered.bytes).toHaveLength(1);
      expect(recovered.bytes.every((bytes: number) => bytes <= 4096)).toBe(true);
      expect(recovered.calls).toEqual(succeeds ? Object.keys(queryChildren) : []);
      expect(recovered.calls.some((key: string) => key.includes(".recover") || key.endsWith(".director"))).toBe(false);
      const after = new Map<string, any>(recovered.storage).get("invoke-human-1");
      expect(after.association).toEqual(before.association);
      expect(after.snapshot).toEqual(before.snapshot);
      const recoveries = succeeds ? recovered.publications[0].body.record.body.recoveries : after.loop.recoveries;
      expect(recoveries).toHaveLength(1);
      expect(recoveries[0].ref).toEqual(before.loop.recoveries[0].ref);
      if (queryMode === "missing") expect(preliminary.recovery.originals[0]).toMatchObject({ ok: false, error: "Complete retained analysis original unavailable." });
      if (queryMode === "conflict") expect(preliminary.recovery.originals[0]).toMatchObject({ ok: false, error: "Conflicting complete retained analysis originals." });
      if (succeeds) {
        expect(recovered.old.value.status).toBe("blocked");
        expect(recovered.old.value.reason).toContain("Recovery settlement/result uncertain");
        expect(recoveries[0]).toMatchObject({ stage: "observed", disposition: "recovered" });
        expect(after.tasks.final.completed.checks.current).toBe(true);
        expect(after.loop.review.verdict).toBe("clear");
        expect(after.loop.compliance.status).toBe("fulfilled");
      }
      expect(readFileSync(statePath, "utf8")).toBe(missionBytes);
      for (const [file, original] of originals) {
        if (queryMode !== "missing") expect(readFileSync(file, "utf8")).toBe(original);
      }
      return;
    }
    expect(recovered.result.value).toMatchObject({ status: verdict === "clear" ? "complete" : "blocked", loopsConsumed: verdict === "clear" ? 1 : 2, maxLoops: 3 });
    expect(recovered.calls).toEqual(verdict === "clear" ? [compliance.key, closing.key] : [closing.key, next.key]);
    expect(recovered.statuses).toHaveLength(6);
    expect(recovered.bytes.every((bytes: number) => bytes <= 4096)).toBe(true);
    for (const [key, value] of recovered.storage) storage.set(key, value);
    const after = storage.get("invoke-human-1");
    expect(after.association).toEqual(before.association);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(verdict === "clear" ? after.loop.results : recovered.publications[0].body.record.body.results)
      .toEqual(verdict === "clear" ? before.loop.results : [before.tasks.final.completed]);
    expect(verdict === "clear" ? after.loop.review : recovered.publications[0].body.record.body.review).toMatchObject({ status: "completed", verdict });
    expect(readFileSync(statePath, "utf8")).toBe(missionBytes);
    for (const [file, original] of originals) expect(readFileSync(file, "utf8")).toBe(original);
  }

  test("settings admission preserves startup A relative agent dir when execute runs in B", () => {
    const operation = runSettingsAdmission();
    workflowSettlements.push(operation.then(() => {}, () => {}));
    return operation;
  });

  async function runSettingsAdmission() {
    const startup = repository(), root = repository();
    const relative = "agent config ' & %PATH% ! 雪";
    const global = path.join(startup, relative), wrongGlobal = path.join(root, relative);
    mkdirSync(global); mkdirSync(wrongGlobal); mkdirSync(path.join(root, ".pi"));
    const globalFile = path.join(global, "settings.json"), wrongFile = path.join(wrongGlobal, "settings.json");
    const projectFile = path.join(root, ".pi/settings.json");
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
    const snapshotDigest = digest(content);
    mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    writeFileSync(path.join(root, ".pitako/plans/assignment.md"), content);
    writeFileSync(globalFile, '\uFEFF{"pitako":{"execute":{"maxCycles":2}}}');
    // Real resource creation in startup cwd A, with resolution and host execution in B.
    const setup = `
      import { executionResource } from ${JSON.stringify(path.resolve("extensions/plan-execute.ts"))};
      const resources = ["linux", "win32"].map(platform => executionResource(platform));
      process.chdir(${JSON.stringify(root)});
      console.log(JSON.stringify(resources.map(resource => resource.resolve(${JSON.stringify({
        root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json",
      })}))));
    `;
    const expanded = JSON.parse(execFileSync("bun", ["-e", setup], { cwd: startup,
      env: { ...process.env, PI_CODING_AGENT_DIR: relative }, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
    for (const resource of expanded) expect(resource.hostCommands).toHaveLength(3);
    const windowsCommand = expanded[1].hostCommands.find((grant: any) => grant.key === "inspect-initial").command;
    const payload = windowsCommand.match(/Buffer.from\('([A-Za-z0-9+/=]+)','base64'\)/)![1]!;
    const bootstrap = windowsCommand.match(/-e "([^"]+)"/)![1]!;
    expect(JSON.parse(execFileSync("node", ["-e", bootstrap], { cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: relative }, encoding: "utf8" })).admission).toEqual({ maxCycles: 2 });
    const command = expanded[0].hostCommands.find((grant: any) => grant.key === "inspect-initial").command;
    for (const mode of ["wrong B absent", "wrong B present", "project override", "invalid global"]) {
      if (mode === "wrong B present") writeFileSync(wrongFile, '{"pitako":{"execute":{"maxCycles":99}}}');
      if (mode === "project override") writeFileSync(projectFile, '{"pitako":{"execute":{"maxCycles":4}}}');
      if (mode === "invalid global") {
        rmSync(projectFile);
        writeFileSync(globalFile, '{"pitako":{"execute":{"maxCycles":false}}}');
      }
      const storage = new Map<string, any>(), calls: string[] = [];
      const observed = await runWorkflowScript({ script: expanded[0].script,
        state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, value); } },
        launch: async key => { calls.push(key); throw Error("Controlled stop at first director"); },
        status: async () => { throw Error("No recovery expected"); },
        host: async key => {
          const stdout = key === "inspect-initial" ? execFileSync("sh", ["-c", command], { cwd: root,
            env: { ...process.env, PI_CODING_AGENT_DIR: relative }, encoding: "utf8" }) :
            key.startsWith("input-") ? JSON.stringify({ digest: snapshotDigest, content }) :
            JSON.stringify({ root, commonDir: root, selected: { source: "/complete.md", digest: snapshotDigest, chunks: 1 }, checkout });
          return { key, kind: "command", state: "passed", ok: true, exitCode: 0,
            stdout, stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
        },
      });
      if (mode === "invalid global") {
        expect(observed.value).toMatchObject({ status: "blocked", phase: "admission", loopsConsumed: 0 });
        expect((observed.value as any).reason).toContain(globalFile);
        expect((observed.value as any).reason).toContain("pitako.execute.maxCycles");
        expect(calls).toEqual([]); expect(storage.size).toBe(0);
      } else {
        expect(storage.get("pitako-execution")?.association.maxCycles).toBe(mode === "project override" ? 4 : 2);
        expect(calls).toHaveLength(1); expect(calls[0]).toEndWith(".director");
      }
    }
    expect(JSON.parse(JSON.parse(Buffer.from(payload, "base64").toString("utf8")).at(-1)).admission.agentDir).toBe(global);
  }

  test("read-only settings admission uses global then designated project, never sibling or launch settings", () => {
    const root = repository(), global = path.join(root, "private-global"), sibling = path.join(root, "sibling");
    mkdirSync(global); mkdirSync(path.join(root, ".pi")); mkdirSync(path.join(sibling, ".pi"), { recursive: true });
    const globalFile = path.join(global, "settings.json"), projectFile = path.join(root, ".pi/settings.json");
    writeFileSync(path.join(sibling, ".pi/settings.json"), JSON.stringify({ pitako: { execute: { maxCycles: 99 } } }));
    expect(executeMaxCycles(root, global)).toBe(3);
    writeFileSync(globalFile, JSON.stringify({ pitako: { execute: { maxCycles: 2 } }, queueMode: "all" }));
    const original = readFileSync(globalFile, "utf8");
    expect(executeMaxCycles(root, global)).toBe(2);
    writeFileSync(projectFile, JSON.stringify({ unrelated: true })); expect(executeMaxCycles(root, global)).toBe(2);
    writeFileSync(projectFile, JSON.stringify({ pitako: { execute: { maxCycles: 4 } } }));
    expect(executeMaxCycles(root, global)).toBe(4); expect(readFileSync(globalFile, "utf8")).toBe(original);
    writeFileSync(globalFile, JSON.stringify({ pitako: { execute: { maxCycles: "invalid but overridden" } } }));
    expect(executeMaxCycles(root, global)).toBe(4);
    rmSync(projectFile); writeFileSync(globalFile, "{}"); expect(executeMaxCycles(root, global)).toBe(3);
  });

  test.each([0, -1, 1.5, "4", true, false, null, Number.MAX_SAFE_INTEGER + 1])("invalid effective settings %s identify actual file and exact key without fallback", value => {
    const root = repository(), global = path.join(root, "private-global"); mkdirSync(global); mkdirSync(path.join(root, ".pi"));
    for (const file of [path.join(global, "settings.json"), path.join(root, ".pi/settings.json")]) {
      writeFileSync(file, JSON.stringify({ pitako: { execute: { maxCycles: value } } }));
      expect(() => executeMaxCycles(root, global)).toThrow(file);
      expect(() => executeMaxCycles(root, global)).toThrow("pitako.execute.maxCycles");
      rmSync(file);
    }
  });

  test.each(["global", "project"])("malformed and unreadable %s settings identify source rather than default", level => {
    const root = repository(), global = path.join(root, "private-global"); mkdirSync(global); mkdirSync(path.join(root, ".pi"));
    const file = level === "global" ? path.join(global, "settings.json") : path.join(root, ".pi/settings.json");
    writeFileSync(file, "{"); expect(() => executeMaxCycles(root, global)).toThrow(file);
    expect(() => executeMaxCycles(root, global)).toThrow("pitako.execute.maxCycles");
    rmSync(file); mkdirSync(file);
    expect(() => executeMaxCycles(root, global)).toThrow(file); expect(() => executeMaxCycles(root, global)).toThrow("pitako.execute.maxCycles");
  });

  test.each([
    { mode: "global", globalValue: 2, projectValue: undefined, expected: 2 },
    { mode: "project absent-option fallback", globalValue: 2, projectValue: {}, expected: 2 },
    { mode: "project precedence", globalValue: 2, projectValue: { pitako: { execute: { maxCycles: 4 } } }, expected: 4 },
    { mode: "default absent-option fallback", globalValue: undefined, projectValue: {}, expected: 3 },
  ])("packaged BOM settings preserve $mode", ({ globalValue, projectValue, expected }) => {
    const root = repository(), global = path.join(root, "private-global");
    assignmentSpec(root);
    mkdirSync(global); mkdirSync(path.join(root, ".pi"));
    const globalFile = path.join(global, "settings.json"), projectFile = path.join(root, ".pi/settings.json");
    const expanded = resourceWithAgentDir(global).resolve({ root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    const command = expanded.hostCommands.find(grant => grant.key === "inspect-initial")!.command;
    const inspect = () => JSON.parse(execFileSync("sh", ["-c", command], { cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: global }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const globalSettings = "\uFEFF" + JSON.stringify({ pitako: { execute: { maxCycles: globalValue } }, unrelated: "preserved" });
    const projectSettings = projectValue === undefined ? undefined : "\uFEFF" + JSON.stringify(projectValue);
    writeFileSync(globalFile, globalSettings);
    if (projectSettings !== undefined) writeFileSync(projectFile, projectSettings);
    expect(inspect().admission).toEqual({ maxCycles: expected });
    expect(readFileSync(globalFile, "utf8")).toBe(globalSettings);
    if (projectSettings !== undefined) expect(readFileSync(projectFile, "utf8")).toBe(projectSettings);
    else expect(existsSync(projectFile)).toBe(false);
  });

  test.each(["invalid", "malformed", "read-error", "BOM-invalid", "BOM-malformed", "non-leading-BOM", "double-BOM"])(
    "packaged %s settings failure reaches admission with actual file/key and no director", async mode => {
    const root = repository(), global = path.join(root, "private-global"), file = path.join(root, ".pi/settings.json");
    assignmentSpec(root);
    mkdirSync(global); mkdirSync(path.dirname(file));
    if (mode === "read-error") mkdirSync(file);
    else {
      const invalid = '{"pitako":{"execute":{"maxCycles":false}}}';
      const content = mode === "malformed" ? "{" : mode === "BOM-malformed" ? "\uFEFF{" :
        mode === "BOM-invalid" ? "\uFEFF" + invalid : mode === "non-leading-BOM" ? " \uFEFF{}" :
        mode === "double-BOM" ? "\uFEFF\uFEFF{}" : invalid;
      writeFileSync(file, content);
    }
    const expanded = resourceWithAgentDir(global).resolve({ root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    const grants = new Map(expanded.hostCommands.map(grant => [grant.key, grant.command]));
    const storage = new Map<string, unknown>(), calls: string[] = [];
    const observed = await runWorkflowScript({ script: expanded.script,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, value); } },
      launch: async key => { calls.push(key); throw Error("No director authorized on invalid settings"); },
      status: async () => { throw Error("No recovery expected"); },
      host: async key => {
        let stdout = "", stderr = "", ok = true;
        if (key === "inspect-initial") {
          try { stdout = execFileSync("sh", ["-c", grants.get(key)!], { cwd: root,
            env: { ...process.env, PI_CODING_AGENT_DIR: global }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
          catch (error) { ok = false; stderr = String((error as { stderr: unknown }).stderr); }
        } else stdout = JSON.stringify({ root, commonDir: root, selected: { source: "/complete.md", digest: "a".repeat(64), chunks: 1 }, checkout });
        return { key, kind: "command", state: ok ? "passed" : "failed", ok, exitCode: ok ? 0 : 1,
          stdout, stderr, outputPath: `/native/${key}.log`, durationMs: 0 };
      },
    });
    expect(observed.value).toMatchObject({ status: "blocked", loopsConsumed: 0, phase: "admission" });
    if (typeof observed.value !== "object" || observed.value === null ||
        !("reason" in observed.value) || typeof observed.value.reason !== "string") {
      throw Error("Expected an admission diagnostic string");
    }
    expect(observed.value.reason).toContain(file); expect(observed.value.reason).toContain("pitako.execute.maxCycles");
    if (mode === "BOM-invalid") expect(observed.value.reason).toContain("expected a positive safe integer");
    if (["malformed", "BOM-malformed", "non-leading-BOM", "double-BOM"].includes(mode))
      expect(observed.value.reason).toContain("SyntaxError");
    expect(calls).toEqual([]); expect(storage.size).toBe(0);
  });

  test("complete inherited source is hash-validated without concatenating the selected snapshot", () => {
    const root = repository(), global = path.join(root, "private-global");
    assignmentSpec(root);
    mkdirSync(global); mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    const source = path.join(root, ".pitako/plans/inherited.md");
    const content = `---\npitako-spec: 1\nid: inherited\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}${"Inherited obligations.\n".repeat(1150)}`;
    // Each source fits; their complete combined bytes deliberately do not.
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(MAX_SPEC_BYTES);
    expect(Buffer.byteLength(content) * 2).toBeGreaterThan(MAX_SPEC_BYTES);
    writeFileSync(source, content);
    const expanded = resourceWithAgentDir(global).resolve({ root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json", sourceRefs: [{ path: source, digest: digest(content) }] });
    expect(expanded.hostCommands).toHaveLength(3);
    const command = expanded.hostCommands.find(grant => grant.key === "inspect-initial")!.command;
    const inspect = () => execFileSync("sh", ["-c", command], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: global },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(inspect()).admission).toEqual({ maxCycles: 3 });
    writeFileSync(source, content + "\nChanged");
    expect(JSON.parse(inspect()).error).toContain("Complete spec source hash mismatch");
    rmSync(source); expect(JSON.parse(inspect()).error).toContain(source);
  });

  test.each([0, 1, 2])("new admission delivers %s human amendments through every phase and preserves recovery", async count => {
    const root = repository(), nativeRoot = repository();
    const { missionPath, statePath } = missionFiles(nativeRoot), spec = assignmentSpec(root);
    const amendments = Array.from({ length: count }, (_, index) => {
      const source = path.join(root, `.pitako/amendments/change-${index}.md`);
      mkdirSync(path.dirname(source), { recursive: true });
      const content = `# Human amendment ${index}\nComplete distinct obligation ${index}.\n`;
      writeFileSync(source, content);
      return { path: source, sha256: digest(content), provenance: `human message human-${index} at 2026-10-31T06:12:5${index}.653Z` };
    });
    const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath, amendments };
    const resource = resourceWithAgentDir(path.join(nativeRoot, "agent"));
    const expanded = resource.resolve(args);
    const changed = resource.resolve({ ...args, amendments: count ? amendments.slice(1) :
      [{ path: ".pitako/amendments/new.md", sha256: "0".repeat(64), provenance: "human new at 2026-10-31T06:12:50Z" }] });
    const metadata = { root, commonDir: spec.commonDir, selected: { source: spec.source, digest: spec.digest } };
    const outcome = await nativeCheckpointCase({ ...nativeCheckpointInput(), ...args, statePath,
      metadata, script: expanded.script, changedScript: changed.script, grant: expanded.hostCommands[0], amendments }, `
      async (input, runWorkflowScript, respond, io) => {
        const storage=new Map(), prompts=[];
        let interruptAdmission=input.amendments.length===2;
        let candidate;
        const options={script:input.script,
          state:{get:key=>structuredClone(storage.get(key)),set:(key,value)=>storage.set(key,structuredClone(value))},
          status:async()=>{throw Error("No unresolved operations expected");},
          host:async(key,params)=>{
            if(interruptAdmission){
              interruptAdmission=false;
              return {key,kind:"command",state:"failed",ok:false,exitCode:1,stdout:"",stderr:"Controlled admission transport loss",durationMs:0,
                outputPath:input.missionPath+".failed-host.log"};
            }
            io.writeFileSync(input.statePath,JSON.stringify(Object.fromEntries(storage)));
            const stdout=io.execFileSync("sh",["-c",params.command],{cwd:input.root,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
            candidate=JSON.parse(stdout).checkout;
            return {key,kind:"command",state:"passed",ok:true,exitCode:0,stdout,stderr:"",durationMs:0,outputPath:input.missionPath+".host.log"};
          },
          launch:async(key,request)=>{
            prompts.push({agent:request.agent,key,task:request.task});
            const result=respond(key,request,input.metadata,candidate);
            if(key.endsWith(".director")){
              result.structuredOutput.association=JSON.parse(request.task.split("ASSOCIATION (data): ")[1].split("\\n")[0]);
              result.structuredOutput.sharedContext={
                material:JSON.stringify(input.amendments),references:input.amendments.map(ref=>ref.path)};
              if(!request.task.includes("tasks that may finish without edits, are verification"))
                throw Error("Missing verification classification guidance");
            }
            return result;
          }};
        const interrupted=input.amendments.length===2 ? (await runWorkflowScript(options)).value : undefined;
        const first=await runWorkflowScript(options);
        const before=structuredClone(storage.get("invoke-human-1"));
        const second=await runWorkflowScript(options);
        const mismatch=await runWorkflowScript({...options,script:input.changedScript});
        let tampered,missing;
        if(input.amendments.length){
          const ref=input.amendments[0],bytes=io.readFileSync(ref.path);
          io.writeFileSync(ref.path,"# Changed human amendment\\n");
          tampered=(await runWorkflowScript(options)).value;
          io.unlinkSync(ref.path);
          missing=(await runWorkflowScript(options)).value;
          io.writeFileSync(ref.path,bytes);
        }
        return {interrupted,first:first.value,second:second.value,mismatch:mismatch.value,tampered,missing,
          before,after:storage.get("invoke-human-1"),prompts};
      }`);
    expect(outcome?.[0], outcome?.[2]).toBe(0);
    const observed = JSON.parse(outcome![1]);
    if (count === 2) expect(observed.interrupted).toMatchObject({ status: "blocked", loopsConsumed: 0 });
    expect(observed.first.status, JSON.stringify(observed.first)).toBe("complete");
    expect(observed.second.status).toBe("complete");
    expect(observed.mismatch.status).toBe("blocked");
    expect(observed.mismatch.reason).toContain("Immutable admission amendments changed");
    expect(observed.before.amendments).toEqual(amendments);
    expect(observed.after.amendments).toEqual(amendments);
    expect(observed.before).toMatchObject({ version: 4, association: { digest: digest(spec.content) } });
    expect(observed.after.snapshot).toEqual(observed.before.snapshot);
    expect(observed.after.association).toEqual(observed.before.association);
    expect(observed.after.association.sourceRefs).toEqual([]);
    expect(observed.after.association.maxCycles).toBe(3);
    expect(observed.after.consumedLoops).toBe(1);
    for (const phase of ["director", "worker", "review", "compliance"]) {
      const prompts = observed.prompts.filter((entry: any) => phase === "compliance" ? entry.key.endsWith(".compliance") :
        phase === "review" ? entry.agent === "pitako.reviewer" && !entry.key.endsWith(".compliance") :
        entry.agent === `pitako.${phase === "director" ? "execution-director" : "worker"}`);
      expect(prompts.length).toBeGreaterThan(0);
      for (const prompt of prompts) for (const ref of amendments) {
        expect(prompt.task).toContain(ref.path);
        expect(prompt.task).toContain(ref.sha256);
        expect(prompt.task).toContain(ref.provenance);
        expect(prompt.task).toContain("read and hash the FULL source");
      }
    }
    if (count) {
      for (const failure of [observed.tampered, observed.missing]) {
        expect(failure).toMatchObject({ status: "blocked", loopsConsumed: 1 });
        expect(failure.reason).toContain(amendments[0]!.path);
        expect(failure.reason).toContain(`expected SHA-256 ${amendments[0]!.sha256}`);
        expect(failure.reason).toContain("observed");
        expect(failure.reason).toContain("Reconcile");
      }
      expect(observed.tampered.reason).toContain(digest("# Changed human amendment\n"));
      expect(observed.missing.reason).toContain("observed unavailable");
    }
  });

  test.each(["relative", "absolute", "physical-absolute"])("symlink alias root admits a local %s amendment through native admission", mode => {
    const root = repository(), nativeRoot = repository();
    const alias = path.join(nativeRoot, "checkout-alias");
    symlinkSync(root, alias, "dir");
    const spec = assignmentSpec(root), { missionPath } = missionFiles(nativeRoot);
    const source = path.join(root, "human.md"), content = "# Human amendment\nComplete local obligation.\n";
    writeFileSync(source, content);
    const ref = { path: mode === "relative" ? "human.md" : mode === "absolute" ? path.join(alias, "human.md") : source,
      sha256: digest(content), provenance: "human h1 at 2026-10-31T06:12:50Z" };
    const expanded = resourceWithAgentDir(path.join(nativeRoot, "agent")).resolve({ root: alias,
      id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath, amendments: [ref] });
    const config = JSON.parse(expanded.script.split("const config = ")[1]!.split(";\nconst pitakoReviewLibraryMode")[0]!);
    expect(config.root).toBe(root);
    expect(config.amendments).toEqual([{ ...ref, path: source }]);
    expect(expanded.hostCommands).toHaveLength(3);
    const admission = () => JSON.parse(execFileSync("sh", ["-c", expanded.hostCommands[0]!.command],
      { cwd: alias, encoding: "utf8" }));
    expect(admission()).toMatchObject({ version: 1, binding: spec.binding, admission: { maxCycles: 3 },
      checkout: { head: expect.any(String), fingerprint: expect.any(String) } });
    writeFileSync(source, "# Changed amendment\n");
    expect(admission()).toMatchObject({ error: expect.stringContaining(`expected SHA-256 ${ref.sha256}, observed ${digest("# Changed amendment\n")}`),
      next: expect.stringContaining("Reconcile") });
  });

  test.each(["changed", "missing"])("new amendment %s blocks native admission before a director", async mode => {
    const root = repository(), nativeRoot = repository();
    const { missionPath } = missionFiles(nativeRoot); assignmentSpec(root);
    const source = path.join(root, ".pitako/amendments/change.md"), original = "# Complete human amendment\n";
    mkdirSync(path.dirname(source)); writeFileSync(source, original);
    const expanded = resourceWithAgentDir(path.join(nativeRoot, "agent")).resolve({ root, id: "assignment",
      invocation: "human-1", missionId: "native.mission-1", missionPath,
      amendments: [{ path: source, sha256: digest(original), provenance: "human message h1 at 2026-10-31T06:12:50Z" }] });
    if (mode === "changed") writeFileSync(source, "# Changed\n"); else rmSync(source);
    const storage = new Map<string, any>(), calls: string[] = [];
    const result = await runWorkflowScript({ script: expanded.script,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      status: async () => { throw Error("No native child should exist before admission"); },
      host: async (key, params) => ({ key, kind: "command", state: "passed", ok: true, exitCode: 0,
        stdout: execFileSync("sh", ["-c", params.command], { cwd: root, encoding: "utf8" }), stderr: "", durationMs: 0,
        outputPath: missionPath + ".host.log" }),
      launch: async key => { calls.push(key); throw Error("Director must not start"); },
    });
    expect(result.value).toMatchObject({ status: "blocked", loopsConsumed: 0 });
    const reason = (result.value as any).reason;
    expect(reason).toContain(source); expect(reason).toContain(`expected SHA-256 ${digest(original)}`);
    expect(reason).toContain(`observed ${mode === "missing" ? "unavailable" : digest("# Changed\n")}`);
    expect(reason).toContain("Reconcile");
    expect(calls).toEqual([]);
    expect(storage.get("invoke-human-1")?.association).toBeUndefined();
  });

  // Rejects instructions that exist only in an orphan document or never identify
  // the native operation/successor. This proves delivery, not model obedience.
  test("manifest-discovered execute consumer receives native root resume and exact successor instructions", () => {
    const root = repository(), agentDir = path.join(root, "private-agent"); mkdirSync(agentDir);
    const manifest = JSON.parse(read("package.json"));
    const { skills } = loadSkills({ cwd: root, agentDir, includeDefaults: false,
      skillPaths: manifest.pi.skills.map((entry: string) => path.resolve(entry)) });
    const execute = skills.find(skill => skill.name === "execute")!;
    expect(execute).toBeDefined();
    expect(formatSkillsForPrompt(skills)).toContain(execute.filePath);
    const { templates } = loadPromptTemplates({ cwd: root, agentDir, includeDefaults: false,
      promptPaths: manifest.pi.prompts.map((entry: string) => path.resolve(entry)) });
    const expanded = expandPromptTemplate("/execute assignment", templates);
    expect(expanded).toContain("packaged execute skill");
    expect(expanded).toContain("assignment");
    const body = readFileSync(execute.filePath, "utf8");
    for (const text of [expanded, body]) {
      expect(text).toMatch(/action:\s*"resume"/);
      expect(text).toContain("<exact-root-run-id>");
      expect(text).toContain("EXACT successor");
      expect(text).toContain("--unblock");
      expect(text).toContain("consumed slots");
    }
    for (const text of [expanded, body]) {
      for (const instruction of ["checkpoint-first", "best-effort pertinent-writer", "last confirmed",
        "historical", "human-delivery provenance", "read/hash the FULL", "consumed",
        "selective restoration"])
        expect(text).toContain(instruction);
      expect(text).not.toContain("must first reconcile the\nexact native producer and prefer its result/continuation");
    }
    expect(body).toContain("consumer of this skill");
    expect(body).toContain("not the\nrunning script itself");
    expect(expanded).toContain("current human resolution");
    expect(body).toContain("missing sufficient reference");
  });

  test("execute foreground binds actual mission references without retired supervision or marker-trust admission", () => {
    const skill = read("skills/execute/SKILL.md"), prompt = read("prompts/execute.md");
    const readme = read("README.md").replace(/\s+/g, " ");
    expect(readme).toContain("/execute <spec-id> --unblock");
    expect(readme).toContain("current human resolution");
    expect(readme).toContain("same mission and invocation");
    expect(readme).toContain("original question and resolution");
    expect(readme).toContain("sources, snapshot, WIP and consumed slots");
    expect(readme).toContain("not a bypass, fresh admission or generic root restart");
    expect(readme).toContain("Technical recovery does not require `--unblock`");
    expect(readme).toContain("Stop, permissions, activity, capacity and persistence remain barriers");
    expect(readme).toContain("Obsolete supervisor replay is rejected");
    expect(readme).not.toContain("`--unblock` are rejected");
    for (const text of [skill, prompt]) {
      expect(text).toContain("missionPath"); expect(text).toContain("loop_plan");
      expect(text).toContain("--unblock"); expect(text).not.toContain("effective-profile preflight");
    }
    expect(skill).toContain("details.missionId"); expect(skill).toContain("details.missionPath");
    expect(skill.replace(/\s+/g, " ")).toContain("all mission management and run reconciliation calls");
    expect(skill).toContain("never derive a storage path");
    expect(skill).toContain("without polling or new");
    expect(prompt).toContain("resolution");
  });

  test.each(["missing", "wrong", "compatible", "prompt-override", "provider-override"])("optional public get diagnoses the cwd profile and effective override body: %s", mode => {
    const root = repository(), prior = process.env.PI_CODING_AGENT_DIR;
    const agentDir = path.join(root, "agents"), configDir = path.join(root, ".pi");
    mkdirSync(agentDir); mkdirSync(configDir);
    process.env.PI_CODING_AGENT_DIR = path.join(root, "private-agent-config");
    const marker = "<!-- pitako-execute-contract: execution-inspector/1 -->";
    const source = read("agents/execution-inspector.md")
      .replace("tools: read, grep, find, ls, bash", "tools: read, grep, find, ls, bash, acp_status, file_sha256, codemode")
      .replace("extensions:\n", "extensions:\n  - ../extensions/acp.ts\n")
      .replace(marker, mode === "missing" ? "" : mode === "wrong" ? "<!-- pitako-execute-contract: execution-inspector/0 -->" : marker);
    const sourcePath = path.join(agentDir, "execution-inspector.md");
    writeFileSync(sourcePath, source);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "custom-checkout", pi: { subagents: { agents: ["./agents"] } } }));
    const override = { "pitako.execution-inspector": { systemPrompt: "Configured older policy: missing proof means blocked." } };
    if (mode.endsWith("override")) writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
      subagents: mode === "provider-override" ? { agentOverridesByProvider: { controlled: override } } : { agentOverrides: override },
    }));
    try {
      // Controlled PUBLIC management action; native profile loading/formatting only,
      // no provider, extension startup, child launch or invented get-JSON response.
      const response = handleManagementAction("get", { agent: "pitako.execution-inspector", agentScope: "both" }, {
        cwd: root, model: { provider: "controlled" } as never, modelRegistry: {} as never,
        discoverAgentsAll: (cwd, provider) => {
          expect(cwd).toBe(root);
          return discoverAgentsAll(cwd, provider, { globalNpmRoot: null });
        },
      });
      expect(response.isError).toBe(false);
      const detail = response.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      expect(detail).toContain(`Path: ${sourcePath}`);
      expect(detail).toContain("Agent: pitako.execution-inspector (package)");
      expect(detail).toContain("Tools: read, grep, find, ls, bash, acp_status, file_sha256, codemode");
      expect(detail).toContain(`Extensions: ${path.join(root, "extensions/acp.ts")}`);
      const body = detail.split("\nSystem Prompt:\n")[1]!;
      expect(body).toBeDefined();
      expect(body.split("\n").includes(marker)).toBe(mode === "compatible");
      if (mode.endsWith("override")) {
        expect(readFileSync(sourcePath, "utf8")).toContain(marker);
        expect(body).toBe("Configured older policy: missing proof means blocked.");
      }
      // Public get is optional diagnosis, not a runtime admission certificate.
      // This checks the effective observation, NOT simulated model compliance.
    } finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    }
  });

  test("native profile loader preserves ordinary deadlines and read-only planning roles", () => {
    const root = repository(), prior = process.env.PI_CODING_AGENT_DIR;
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pitako", pi: { subagents: { agents: [path.resolve("agents")] } } }));
    process.env.PI_CODING_AGENT_DIR = path.join(root, "private-agent-config");
    try {
      const loaded = discoverAgents(root, "project", undefined, { globalNpmRoot: null });
      const director = loaded.agents.find(agent => agent.name === "pitako.execution-director");
      expect(director?.defaultTimeoutMs).toBe(7200000);
      expect(director?.filePath).toBe(path.resolve("agents/execution-director.md"));
      const worker = loaded.agents.find(agent => agent.name === "pitako.worker");
      expect(worker?.defaultTimeoutMs).toBe(14400000);
      expect(worker?.filePath).toBe(path.resolve("agents/worker.md"));
      for (const role of ["worker", "execution-director"]) {
        const agent = loaded.agents.find(agent => agent.name === `pitako.${role}`)!;
        expect(agent.skills).toContain("verify-behavior");
        const skill = agent.skillPath?.map(entry => path.resolve(path.dirname(agent.filePath), entry))
          .find(entry => entry === path.resolve("skills/practical/verify-behavior"));
        expect(skill).toBeDefined();
        expect(readFileSync(path.join(skill!, "SKILL.md"), "utf8")).toContain("Triage a failing check");
        expect(agent.systemPrompt).toContain("verify-behavior");
      }
      for (const role of ["execution-inspector", "reviewer"]) {
        const agent = loaded.agents.find(agent => agent.name === `pitako.${role}`);
        expect(agent).toBeDefined(); expect(agent?.defaultTimeoutMs).toBeUndefined();
      }
    } finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    }
  });

  test("documented mission creation, inspection and launch reuse the designated store from a nested foreground cwd", () => {
    const root = repository(), foreground = path.join(root, "src"); mkdirSync(foreground);
    const missionId = "explicit.native-id", stores = new Map<string, Set<string>>();
    const calls: { args?: { missionPath?: string }; action?: string; id?: string; agent?: string; agentScope?: string; workflow?: string; cwd?: string; options?: { missionId?: string } }[] = [];
    // Controlled native boundary: stores are keyed by request cwd, not its enclosing Git root.
    const subagent = (input: typeof calls[number]) => {
      calls.push(input);
      const cwd = path.resolve(foreground, input.cwd ?? ".");
      expect(cwd).toBe(root);
      if (input.action === "get") {
        expect(stores.size).toBe(0); expect(input.agentScope).toBe("both");
        return;
      }
      if (input.action === "resume") {
        expect(input.id).toBe("<exact-root-run-id>");
        expect(stores.get(cwd)?.has(missionId)).toBe(true);
        return;
      }
      if (input.action === "mission.create") stores.set(cwd, new Set([missionId]));
      else expect(stores.get(cwd)?.has(input.options?.missionId ?? "")).toBe(true);
      return { details: { missionId, missionPath: "/native/actual-mission.json" } };
    };
    const blocks = [...read("skills/execute/SKILL.md").matchAll(/```js\n([\s\S]*?)```/g)];
    for (const [, block] of blocks) {
      const script = block!.replaceAll("<designated-absolute-root>", root).replaceAll("<same-root>", root)
        .replaceAll("<explicit-native-mission-id>", missionId).replaceAll("<actual-returned-mission-path>", "/native/actual-mission.json");
      new Function("subagent", script)(subagent);
    }
    expect(calls.map(call => call.action ?? call.workflow)).toEqual(["mission.create", "mission.show", "pitako.execute", "resume"]);
    expect(calls.find(call => call.workflow === "pitako.execute")?.args?.missionPath).toBe("/native/actual-mission.json");
    expect(read("skills/execute/SKILL.md").replace(/\s+/g, " ")).toContain("all mission management and run reconciliation calls");
  });

  test("Windows host commands transport exact arguments without cmd expansion or POSIX quoting", () => {
    const main = repository(), root = path.join(main, 'quoted\'" & %PATH% !expansion!');
    execFileSync("git", ["worktree", "add", "-qb", "quoted", root], { cwd: main, stdio: "ignore" });
    const source = path.join(root, ".pitako/plans/assignment.md");
    mkdirSync(path.dirname(source), { recursive: true });
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}`;
    writeFileSync(source, content);
    const agentDir = path.join(main, "private-agent"); mkdirSync(agentDir);
    const prior = process.env.PI_CODING_AGENT_DIR;
    let resource;
    try { process.env.PI_CODING_AGENT_DIR = agentDir; resource = executionResource("win32"); }
    finally { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; }
    const expanded = resource.resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json", source });
    expect(expanded.hostCommands).toHaveLength(3);
    const grant = expanded.hostCommands[0]!;
    const match = grant.command.match(/^node -e "([^"]+)"$/);
    expect(match).not.toBeNull();
    const payload = match![1]!.match(/Buffer.from\('([A-Za-z0-9+/=]+)','base64'\)/)![1]!;
    expect(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))).toEqual([
      path.resolve("skills/execute/inspect.mjs"), root, "assignment", source, "admission",
      JSON.stringify({ missionId: "native.mission-1", missionPath: "/native/actual-mission.json", invocation: "human-1", sourceRefs: [],
        amendments: [], admission: { sourceRefs: [], agentDir } }),
    ]);
    expect(match![1]).not.toMatch(/[%!$`]/);
    const result = JSON.parse(execFileSync("node", ["-e", match![1]!], { encoding: "utf8" }));
    const config = JSON.parse(expanded.script.split("const config = ")[1]!.split(";\nconst pitakoReviewLibraryMode")[0]!);
    expect(result.binding).toBe(config.preliminary.binding);
    expect(result.admission).toEqual({ maxCycles: 3 });
    expect(result.checkout).toMatchObject({ head: expect.any(String), fingerprint: expect.any(String) });
  });

  test("POSIX host grants invoke the packaged Node entry without interpreting root metacharacters", () => {
    const main = repository(), root = path.join(main, "sibling ' & %PATH% !");
    execFileSync("git", ["worktree", "add", "-qb", "quoted", root], { cwd: main, stdio: "ignore" });
    const spec = assignmentSpec(root);
    const expanded = resourceWithAgentDir(path.join(main, "private-agent")).resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    const grant = expanded.hostCommands.find(item => item.key === "inspect-initial")!;
    const result = JSON.parse(execFileSync("sh", ["-c", grant.command], { cwd: root, encoding: "utf8" }));
    expect(result.binding).toBe(spec.binding); expect(result.admission).toEqual({ maxCycles: 3 });
    for (const name of ["plan", "execute"]) {
      const skill = read(`skills/${name}/SKILL.md`);
      expect(skill).toContain("inspect.mjs"); expect(skill.replace(/\s+/g, " ")).toContain("Node >=22.19.0");
      expect(skill).toContain("never shell-interpolated paths");
    }
  });

  test("preliminary capture preserves session-scoped registration lifecycle and exact native admission grant", () => {
    const root = repository();
    mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    writeFileSync(path.join(root, ".pitako/plans/assignment.md"), `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`);
    const hooks = new Map<string, (event: unknown, context: unknown) => void>();
    planExecute({ on: (name: string, hook: (event: unknown, context: unknown) => void) => { hooks.set(name, hook); } } as unknown as ExtensionAPI);
    const first = randomUUID(), second = randomUUID();
    const ctx = (id: string) => ({ cwd: root, sessionManager: { getSessionId: () => id } });
    disposers.push(() => hooks.get("session_shutdown")!({}, ctx(second)));
    hooks.get("session_start")!({}, ctx(first));
    const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
    const resolved = resolveWorkflowResource("pitako.execute", args, first); expect(resolved.ok).toBe(true);
    expect(resolveWorkflowResource(" pitako.execute ", args, first).ok).toBe(true);
    expect(resolveWorkflowResource("pitako.execute", args, second).ok).toBe(false);
    const expanded = executionResource().resolve(args);
    expect(expanded.hostCommands).toHaveLength(3);
    expect(expanded.hostCommands).toEqual(["inspect-initial", "inspect-initial.r1", "inspect-initial.r2"]
      .map(key => ({ ...expanded.hostCommands[0], key })));
    for (const grant of expanded.hostCommands) { expect(grant.command).toContain(process.platform === "win32" ? 'node -e "' : "skills/execute/inspect.mjs"); expect(grant.command).not.toMatch(/\b(?:commit|install|push)\b/); }
    expect(validateWorkflowScript(expanded.script)).toEqual({ ok: true, errors: [] });
    expect(() => executionResource().resolve({ ...args, invocation: "../escape" })).toThrow();
    expect(() => executionResource().resolve({ ...args, approval: true })).toThrow("Unknown");
    for (const unblock of [true, false, "true", 1, {}, [], null])
      expect(() => executionResource().resolve({ ...args, unblock })).toThrow("current human resolution");
    for (const resolution of [null, {}, { loop: 1 }, { loop: 1, text: " " }, { loop: -1, text: "Continue" }, { loop: 1, text: "Continue", approval: true }])
      expect(() => executionResource().resolve({ ...args, unblock: true, resolution })).toThrow("current human resolution");
    for (const missionPath of [undefined, "", "relative/guessed", false, {}])
      expect(() => executionResource().resolve({ ...args, missionPath })).toThrow("missionPath");
    for (const missionId of [undefined, "", " ", false, {}, "../escape", "native..mission", "native/mission", "x".repeat(129)])
      expect(() => executionResource().resolve({ ...args, missionId })).toThrow("missionId");
    expect(expanded.script).toContain('"missionId":"native.mission-1"');
    // Preliminary physical discovery is independently checked at native admission.
    expect(() => executionResource().resolve({ ...args, root: tmpdir() })).toThrow("explicitly prepare admission");
    hooks.get("session_start")!({}, ctx(second));
    expect(resolveWorkflowResource("pitako.execute", args, first).ok).toBe(false);
    expect(resolveWorkflowResource("pitako.execute", args, second).ok).toBe(true);
    hooks.get("session_shutdown")!({}, ctx(second)); hooks.get("session_shutdown")!({}, ctx(second));
    expect(resolveWorkflowResource("pitako.execute", args, second).ok).toBe(false);
  });

  test("preliminary capture keeps setup-preloaded complete sources and rejects unavailable discovery inputs", () => {
    const resource = executionResource();
    const missing = path.join(tmpdir(), `pitako-not-created-${randomUUID()}`);
    const root = repository();
    mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    writeFileSync(path.join(root, ".pitako/plans/assignment.md"), `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`);
    const args = { root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
    const expanded = resource.resolve(args);
    expect(expanded.script).toContain(`const pitakoReviewLibraryMode = true;\n${read("skills/review/workflow.js")}\n${read("skills/execute/workflow.js")}`);
    expect(resource.resolve(Object.freeze(args))).toEqual(expanded);
    expect(() => resource.resolve({ ...args, root: missing })).toThrow("explicitly prepare admission");
    expect(existsSync(missing)).toBe(false);
    expect(expanded.hostCommands).toHaveLength(3);
  });

  test("foreground subdirectory is not treated as launch cwd; the public launch must match the designated root", () => {
    const root = repository(), nested = path.join(root, "src"); mkdirSync(nested);
    assignmentSpec(root);
    const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
    planExecute({ on: (name: string, hook: (event: unknown, context: unknown) => unknown) => { hooks.set(name, hook); } } as unknown as ExtensionAPI);
    const sessionId = randomUUID(), ctx = { cwd: nested, sessionManager: { getSessionId: () => sessionId } };
    hooks.get("session_start")!({}, ctx);
    disposers.push(() => hooks.get("session_shutdown")!({}, ctx));
    const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
    const input = { workflow: "pitako.execute", args, options: { missionId: args.missionId } };
    const call = (cwd?: string, designatedRoot = root) => hooks.get("tool_call")!({ toolName: "subagent", input: { ...input, cwd, args: { ...args, root: designatedRoot } } }, ctx);
    expect(resolveWorkflowResource("pitako.execute", args, sessionId).ok).toBe(true);
    expect(call(root)).toBeUndefined(); expect(call("..")).toBeUndefined();
    expect(call()).toMatchObject({ block: true }); expect(call(nested)).toMatchObject({ block: true });
    const sibling = path.join(root, "..", `${path.basename(root)}-sibling`); roots.push(sibling);
    execFileSync("git", ["worktree", "add", "-qb", "sibling", sibling], { cwd: root, stdio: "ignore" });
    expect(call(sibling)).toMatchObject({ block: true });
    expect(call(sibling, sibling)).toBeUndefined();
    expect(call(nested, nested)).toMatchObject({ block: true });
  });

  test.each(["siblings", "long-path"])("inspector metadata crosses a controlled 4096-byte native preview: %s", mode => {
    const operation = runPreview(mode);
    // Observe rejection immediately and await either outcome before removing roots.
    workflowSettlements.push(operation.then(() => {}, () => {}));
    return operation;
  });

  async function runPreview(mode: string) {
    const main = repository();
    const parent = path.join(main, ...(mode === "long-path" ? Array.from({ length: 12 }, (_, index) => `${index}-` + '中é"\\'.repeat(22)) : ["siblings"]));
    mkdirSync(parent, { recursive: true });
    const root = path.join(parent, "designated");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "ignore" });
    git("worktree", "add", "-qb", "designated", root);
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`;
    const locations = [];
    // Cross the preview byte limit with longer paths, not more Git worktrees.
    for (let index = 0; index < (mode === "siblings" ? 3 : 1); index++) {
      const sibling = mode === "long-path" ? root : path.join(parent, `sibling-${index}`,
        ...Array.from({ length: 8 }, (_, part) => `segment-${part}-` + 'é中"\\'.repeat(20)));
      if (sibling !== root) git("worktree", "add", "-qb", `sibling-${index}`, sibling);
      const target = path.join(sibling, ".pitako/plans/assignment.md");
      mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); locations.push(target);
    }
    const selected = locations.at(-1)!;
    const rawDiscovery = JSON.parse(execFileSync("node", [path.resolve("skills/execute/inspect.mjs"), root, "assignment", ""], { encoding: "utf8" }));
    expect(Buffer.byteLength(JSON.stringify(rawDiscovery))).toBeGreaterThan(4096);
    expect(rawDiscovery.candidates.map((item: { source: string }) => item.source).sort()).toEqual(mode === "siblings" ? [...locations].sort() : []);
    const cache = new Map<string, string>();
    async function execute(source?: string) {
      const expanded = resourceWithAgentDir(path.join(root, "private-agent-settings")).resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json", ...(source ? { source } : {}) });
      const grants = new Map(expanded.hostCommands.map(grant => [grant.key, grant.command]));
      const storage = new Map<string, unknown>(), launched: string[] = [], envelopes: string[] = [];
      const result = await runWorkflowScript({ script: expanded.script,
        state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
        launch: async (key, request) => {
          launched.push(key); expect(request.cwd).toBe(root);
          if (key.endsWith(".director")) expect(request.task).toContain(JSON.stringify(selected));
          return childResponse(key, request, { root, commonDir: rawDiscovery.commonDir, selected: { source: selected, digest: digest(content) } }, checkout);

        },
        status: async () => { throw new Error("Unexpected status"); },
        host: async (key, params) => {
          expect(params.command).toBe(grants.get(key)!);
          let stdout = cache.get(params.command);
          if (stdout === undefined) {
            stdout = execFileSync("sh", ["-c", params.command], { cwd: root,
              env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "private-agent-settings") },
              encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            cache.set(params.command, stdout);
          }
          if (key.startsWith("inspect-")) stdout = JSON.stringify({ ...JSON.parse(stdout), checkout }) + "\n";
          envelopes.push(stdout);
          const preview = Buffer.byteLength(stdout) <= 4096 ? stdout : Buffer.from(stdout).subarray(0, 4093).toString("utf8") + "...";
          return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout: preview, stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
        },
      });
      for (const envelope of envelopes) expect(Buffer.byteLength(envelope)).toBeLessThanOrEqual(4096);
      return { value: result.value, storage, launched, envelopes };
    }
    if (mode === "siblings") {
      let error = "";
      try { await execute(); } catch (cause) { error = String(cause); }
      expect(error).toContain("Ambiguous spec-plan");
      expect(error).toContain("explicitly prepare admission");
      for (const source of locations) expect(error).toContain(source);
    }
    const chosen = await execute(selected);
    expect(chosen.value).toMatchObject({ status: "complete" });
    expect(chosen.storage.get("invoke-human-1")).toMatchObject({ association: { source: selected, digest: digest(content) }, version: 4 });
    expect(chosen.storage.get("pitako-execution")).toMatchObject({ version: 4, association: { root, commonDir: path.join(main, ".git") } });
    expect(chosen.envelopes).toHaveLength(1);
    expect(JSON.parse(chosen.envelopes[0]!).binding).toBe(preliminarySpec(root, "assignment", selected).binding);
  }

  test.each(["escaped", "multibyte"])("maximum-size escaped specs close three cycles with one initial host call: %s", async kind => {
    const root = repository();
    const prefix = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`;
    const filler = kind === "escaped" ? '"\\' : "é中😀\n";
    const remaining = MAX_SPEC_BYTES - Buffer.byteLength(prefix), size = Buffer.byteLength(filler);
    const content = prefix + filler.repeat(Math.floor(remaining / size)) + "x".repeat(remaining % size);
    validateSpec(content, "assignment"); expect(Buffer.byteLength(content)).toBe(MAX_SPEC_BYTES);
    const source = path.join(root, ".pitako/plans/assignment.md");
    mkdirSync(path.dirname(source), { recursive: true }); writeFileSync(source, content);
    const preliminary = preliminarySpec(root, "assignment");
    const selected = { source, digest: digest(content) };
    const metadata = { root, commonDir: preliminary.commonDir, selected };
    const expanded = executionResource().resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    expect(expanded.hostCommands).toHaveLength(3);
    const grants = new Map(expanded.hostCommands.map(grant => [grant.key, grant.command]));
    const storage = new Map<string, unknown>(), hostKeys: string[] = [];
    const result = await runWorkflowScript({ script: expanded.script,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async (key, request) => {
        if (key.endsWith(".director")) expect(request.task).toContain(JSON.stringify(selected.source));
        if (!request.resume && request.agent !== "pitako.checkout-observer") expect(request.task).toContain(content);
        return childResponse(key, request, metadata, checkout, 3);

      },
      status: async () => { throw new Error("Unexpected status"); },
      host: async (key, params) => {
        expect(params.command).toBe(grants.get(key)!); hostKeys.push(key);
        const stdout = JSON.stringify({ version: 1, binding: preliminary.binding, checkout, admission: { maxCycles: 3 } }) + "\n";
        expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(4096);
        return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout, stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
      },
    });
    expect(result.value).toMatchObject({ status: "complete", loopsConsumed: 3 });
    expect(hostKeys).toEqual(["inspect-initial"]);
    expect(storage.get("invoke-human-1")).toMatchObject({ association: { source: selected.source, digest: selected.digest },  consumedLoops: 3, loopSummaries: expect.any(Array) });
  });

  test.each(["canonical", "descriptive", "id-only", "unknown", "uncaptured", "missing", "failed", "not-run", "stale", "missing-identity", "invalid-identity",
    "malformed-later", "duplicate", "producer-conflict", "binding-conflict", "invalid-dependency", "invalid-dependency-lost", "invalid-dependency-unresolved"])(
    "registered normal route advances only valid mandatory evidence with retained diagnostics (%s)", async mode => {
      const root = repository();
      const spec = assignmentSpec(root);
      writeFileSync(path.join(root, "owned"), "Existing uncommitted WIP");
      const { head, fingerprint } = checkoutEvidence(root), checkout = { head, fingerprint };
      const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
      planExecute({ on: (name: string, hook: (event: unknown, context: unknown) => unknown) => { hooks.set(name, hook); } } as unknown as ExtensionAPI);
      const sessionId = randomUUID(), ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
      hooks.get("session_start")!({}, ctx);
      disposers.push(() => hooks.get("session_shutdown")!({}, ctx));
      const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
      const resolved = resolveWorkflowResource("pitako.execute", args, sessionId);
      if (!resolved.ok) throw Error(resolved.error);
      const metadata = { root, commonDir: path.join(root, ".git"), candidates: [],
        selected: { source: `${root}/.pitako/plans/assignment.md`, digest: digest(spec.content), chunks: 1 } };
      const storage = new Map<string, any>(), calls: string[] = [], originals: any[] = [], archivedLoops: any[] = [];
      const invalidDependency = mode.startsWith("invalid-dependency");
      const cacheCut = mode === "invalid-dependency-lost" || mode === "invalid-dependency-unresolved";
      const rejected = ["missing", "failed", "not-run", "stale", "missing-identity", "invalid-identity", "malformed-later", "duplicate"].includes(mode);
      let published: any;
      const observed = await runWorkflowScript({ script: resolved.resource.script,
        state: { get: key => structuredClone(storage.get(key)), set: (key, value: any) => {
          if (cacheCut && value.activePlan && value.loop?.number === 2 && value.loop?.halt) throw Error("Controlled optional-cache write cut");
          storage.set(key, structuredClone(value));
        } },
        launch: async (key, request) => {
          calls.push(key);
          if (request.agent === "pitako.execution-ledger") {
            const record = JSON.parse(String(request.task)).record;
            if (record.kind === "loop") archivedLoops.push(record.body);
          }
          const response = childResponse(key, request, metadata, checkout);
          if (key.endsWith(".director")) {
            const final = response.structuredOutput.tasks[0];
            const change = { ...structuredClone(final), id: "change", kind: "implementation", expectedResult: "Implement the scoped behavior" };
            final.dependsOn = [{ taskId: "change", reason: "Verify the implemented candidate" }];
            if (invalidDependency) change.dependsOn = [{ taskId: "final", reason: "Invalid forward prerequisite" }];
            response.structuredOutput.tasks.unshift(change);
            published = structuredClone(response.structuredOutput);
          }
          if (request.agent === "pitako.worker") {
            const task = JSON.parse(String(request.task).split("COMPLETE SELECTED TASK:\n")[1]!.split("\nFROZEN ATTEMPT")[0]!);
            expect(storage.get("invoke-human-1").activePlan).toEqual(published);
            const value = response.structuredOutput;
            value.taskId = task.id;
            if (task.kind === "implementation") {
              // New modifying dispatches require real sealed bytes, even at a
              // controlled child boundary with no additional file effects.
              const intent = storage.get("invoke-human-1").loop.attempt.checkpoint;
              captureCheckpoint(intent, ["owned"]);
              value.checkpointReceipt = sealCheckpoint(intent, "unit", true);
              value.git.checkpoints.push(value.checkpointReceipt.checkpointRef);
            }
            const mandatory = value.checks[0];
            if (mode === "descriptive") mandatory.requirement = "Observed behavior rather than canonical wording";
            if (mode === "canonical") mandatory.requirement = "All specs";
            value.checks.push(...["failed", "not-run", "passed"].map((result, index) => ({
              ...structuredClone(mandatory), id: `historical-${index}`, result,
              before: mode === "unknown" ? null : mode === "uncaptured" ?
                { head: "not-captured", fingerprint: "temporary-defect" } : { ...checkout, fingerprint: "c".repeat(64) },
              after: mode === "unknown" ? null : mode === "uncaptured" ?
                { head: "not-captured", fingerprint: "restored" } : { ...checkout, fingerprint: "c".repeat(64) },
            })));
            if (task.id === "change") {
              if (mode === "missing") value.checks.shift();
              if (mode === "failed" || mode === "not-run") mandatory.result = mode;
              if (mode === "stale") mandatory.after = { ...checkout, fingerprint: "d".repeat(64) };
              if (mode === "missing-identity") mandatory.before = null;
              if (mode === "invalid-identity") mandatory.after = { head: "not-captured", fingerprint: "restored" };
              if (mode === "duplicate") value.checks.push(structuredClone(mandatory));
              if (mode === "malformed-later") value.checks.at(-1).output = "";
              if (mode === "producer-conflict") response.agent = "pitako.reviewer";
              if (mode === "binding-conflict") response.output = JSON.stringify({ ...value, attempt: 99 });
            } else {
              const completed = storage.get("invoke-human-1").tasks.change.completed;
              expect(completed).toMatchObject({ taskId: "change", status: "complete", checks: { current: true, count: 4, passed: 2, failed: 1, notRun: 1 } });
              expect(request.task).toContain(JSON.stringify([{ taskId: "change", attempt: 1, ref: completed.ref }]));
              expect(request.task).toContain("historical references, not current check evidence");
            }
            originals.push({ response, original: structuredClone(response) });
          }
          return response;
        },
        status: async () => { throw Error("No routine recovery"); },
        host: async key => ({ key, kind: "command", state: "passed", ok: true, exitCode: 0,
          stdout: JSON.stringify({ version: 1, binding: spec.binding, checkout, admission: { maxCycles: 3 } }),
          stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 }),
      });
      const valid = ["canonical", "descriptive", "id-only", "unknown", "uncaptured"].includes(mode);
      // A report-contract violation is a rejected attempt that consumes its loop;
      // producer and binding conflicts still halt the root.
      expect(observed.value).toMatchObject({ status: valid ? "complete" : rejected ? "partial" : "blocked",
        loopsConsumed: rejected ? 3 : invalidDependency ? 2 : 1 });
      if (rejected) for (const loop of archivedLoops) expect(loop).toMatchObject({
        results: [{ taskId: "change", status: "rejected", rejection: expect.any(String) }] });
      expect(calls.filter(key => /\.t\d+\.a/.test(key))).toEqual(invalidDependency ? [] : valid ?
        ["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t2.a1"] : rejected ? [1, 2, 3].map(loop => `invoke-human-1.l${loop}.t1.a1`)
        : ["invoke-human-1.l1.t1.a1"]);
      expect(calls.filter(key => key.endsWith(".director"))).toHaveLength(rejected ? 3 : invalidDependency ? 2 : 1);
      if (invalidDependency) {
        expect(archivedLoops[0].plan.stage).toBe("rejected");
        expect((observed.value as any).reason).toContain("No new useful corrective input");
      }
      expect(calls.some(key => key.includes(".review."))).toBe(valid);
      expect(calls.some(key => key.includes("recover"))).toBe(false);
      if (cacheCut) {
        const retained = structuredClone(storage.get("invoke-human-1"));
        expect(storage.get("invoke-human-1").activePlan).toBeNull();
        const statusCalls: string[] = [];
        const replay = await runWorkflowScript({ script: resolved.resource.script,
          state: { get: key => structuredClone(storage.get(key)), set: (key, value) => { storage.set(key, structuredClone(value)); } },
          // No original survives. If replay wrongly tries recovery, let it
          // observe either full loss or an unresolved scope barrier.
          status: async key => { statusCalls.push(key); return { key, ok: true, output: "", artifactPaths: [] }; },
          launch: async (key, request) => {
            calls.push(key);
            if (request.agent !== "pitako.execution-inspector") return childResponse(key, request, metadata, checkout);
            return { key, ok: true, output: "", runId: `native-${key}`, agent: request.agent, artifactPaths: [],
              structuredOutput: { status: mode.endsWith("-lost") ? "lost" : "unresolved",
                reason: "Actor user must authorize out-of-scope original restoration", original: null, workerResult: null,
                originalAvailable: false, binding: "unavailable", comparison: "neither", provenance: ["/native/original"] } };
          },
          host: async key => ({ key, kind: "command", state: "passed", ok: true, exitCode: 0,
            stdout: JSON.stringify({ version: 1, binding: spec.binding, checkout, admission: { maxCycles: 3 } }), stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 }),
        });
        expect(replay.value).toMatchObject({ status: "blocked", loopsConsumed: 2, reason: expect.stringContaining("No new useful corrective input") });
        expect(storage.get("invoke-human-1")).toEqual(retained);
        expect(calls).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l1.gaps", "invoke-human-1.l2.director"]);
        expect(statusCalls).toEqual([]);
      }
      if (valid) expect(storage.get("invoke-human-1").loop.manifest).toEqual(published.tasks.map((task: any) => task.id));
      for (const { response, original } of originals) expect(response).toEqual(original);
    });

  test("registered amendment context reaches verify-behavior workers and whole-spec review/compliance assembly", async () => {
    const root = repository(), spec = assignmentSpec(root);
    const metadata = { root, commonDir: path.join(root, ".git"), candidates: [],
      selected: { source: `${root}/.pitako/plans/assignment.md`, digest: digest(spec.content), chunks: 1 } };
    const expanded = executionResource().resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    const review = read("skills/review/workflow.js"), execute = read("skills/execute/workflow.js");
    expect(expanded.script.endsWith(`const pitakoReviewLibraryMode = true;\n${review}\n${execute}`)).toBe(true);
    const amendmentPath = path.join(root, "human-amendment.md");
    const amendmentBody = "Complete current human amendment A1: checkpoint-first recovery.";
    writeFileSync(amendmentPath, amendmentBody);
    const amendmentContext = { material: `Current human delivered A1 before plan publication, not an old resolution.
Full source: ${amendmentPath}; SHA-256: ${digest(amendmentBody)}.
A1 supersedes native-resume-first recovery; preserve the missing historical before-copy contrast.`,
      references: [metadata.selected.source, amendmentPath] };
    const storage = new Map<string, unknown>(), calls: any[] = [], inspections: string[] = [];
    const result = await runWorkflowScript({ script: expanded.script,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async (key, request) => {
        calls.push({ key, ...request });
        expect(request.cwd).toBe(root); expect(request.outputSchema).toBeDefined();
        const response = childResponse(key, request, metadata, checkout);
        if (key.endsWith(".director")) response.structuredOutput.sharedContext = amendmentContext;
        else if (!request.resume && request.agent !== "pitako.checkout-observer" && request.agent !== "pitako.execution-ledger") {
          expect(request.task, key).toContain(amendmentPath);
          expect(request.task, key).toContain(digest(amendmentBody));
          expect(request.task, key).toContain("Current human delivered A1 before plan publication");
        }
        return response;
      },
      status: async () => { throw new Error("Unexpected routine recovery"); },
      host: async (key) => {
        inspections.push(key);
        return { key, kind: "command", state: "passed", ok: true, exitCode: 0,
          stdout: JSON.stringify({ version: 1, binding: spec.binding, checkout, admission: { maxCycles: 3 } }),
          stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
      },
    });
    expect(result.value).toMatchObject({ status: "complete", loopsConsumed: 1, actionRequired: "none" });
    expect(calls.map(call => call.key)).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l1.t1.a1",
      "invoke-human-1.l1.review.director-prepare", "invoke-human-1.l1.review.independent-a", "invoke-human-1.l1.review.independent-b",
      "invoke-human-1.l1.review.director-synthesis", "invoke-human-1.l1.compliance", "invoke-human-1.l1.checkout"]);
    expect(inspections).toEqual(["inspect-initial"]);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pitako", pi: { subagents: { agents: [path.resolve("agents")] } } }));
    const prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "private-agent-config");
    let loaded;
    try { loaded = discoverAgents(root, "project", undefined, { globalNpmRoot: null }); }
    finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    }
    const bodies = new Map(loaded.agents.map(agent => {
      const { resolved, missing } = resolveSkills(agent.skills ?? [], root, agent.skillPath, path.dirname(agent.filePath));
      expect(missing).toEqual([]);
      if (["pitako.worker", "pitako.reviewer"].includes(agent.name)) {
        expect(resolved.find((skill: any) => skill.name === "verify-behavior")?.path)
          .toBe(path.resolve("skills/practical/verify-behavior/SKILL.md"));
      }
      return [agent.name.replace("pitako.", ""), buildEffectiveSystemPrompt({ agent, resolvedSkills: resolved, cwd: root })];
    }));
    const priorContexts = new Map<string, string>();
    for (const call of calls.filter(call => call.agent !== "pitako.checkout-observer")) {
      const role = (call.agent ?? "pitako.reviewer").replace("pitako.", "");
      const assembled = [read("AGENTS.md"), bodies.get(role),
        call.resume ? priorContexts.get(call.resume) : "", call.task].join("\n");
      priorContexts.set(`native-${call.key}`, assembled);
      for (const obsolete of ["sole delegating cycle director", "create all known stages pending", "Prepare an implementation TODO", "reports actual spec/check/review evidence and its current-checkout association", "Only the execution director delegates"])
        expect(assembled).not.toContain(obsolete);
      expect(assembled).toContain(spec.content);
      if (role === "worker" || role === "reviewer") {
        // Rejects delivery only to workers, orphan announcements, or an altered
        // frozen association. Controlled child verdicts do not prove obedience.
        expect(assembled).toContain(JSON.stringify(amendmentContext));
        for (const instruction of ["read and hash the FULL source", "human-delivery provenance",
          "unchanged base sources", "missing/changed amendment", "not permission to replace frozen",
          "new checkpoint observations do not fulfill a missing historical contrast"])
          expect(assembled).toContain(instruction);
        expect(assembled).toContain(amendmentPath);
        expect(assembled).toContain(digest(amendmentBody));
        expect(assembled).toContain("load and apply verify-behavior");
        expect(assembled).toContain(`<location>${path.resolve("skills/practical/verify-behavior/SKILL.md")}</location>`);
        // Native assembly advertises a readable skill, not an injected body or model obedience.
        expect(assembled).not.toContain("## Verify the assignment before the solution");
        expect(assembled).toContain("Distinguish correctness from sufficiency");
      }
      if (call.key.endsWith(".compliance")) {
        for (const guidance of ["Before examining the solution", "not the diff, task plan",
          "current evidence and limits", "Unresolved material gaps prevent fulfillment",
          "minor uncertainty", "not test counts"])
          expect(call.task).toContain(guidance);
        expect(assembled).toContain("inventory of ALL obligations from the COMPLETE selected specs");
        expect(assembled).toMatch(/actual acceptance criteria AND obligations in expected\s+behavior, constraints, verification and other sections/);
        expect(assembled).not.toContain("EACH of the 17 acceptance criteria");
      }
    }
    const retained = storage.get("invoke-human-1") as any;
    expect(retained.association.sourceRefs).toEqual([]);
    expect(retained.association.maxCycles).toBe(3);
    expect(retained.association.digest).toBe(digest(spec.content));
    expect(retained.loop.plan.ref).toBeDefined();
    expect(readFileSync(amendmentPath, "utf8")).toBe(amendmentBody);
    expect(calls[0].task).toContain("then END");
    expect(calls[1]).toMatchObject({ reads: false, progress: false, timeoutMs: 14400000, acceptance: { level: "none" } });
    for (const instructions of [profileNote("coding"), read("skills/pitako-coding/SKILL.md"), read("prompts/execute.md"), read("skills/execute/SKILL.md")])
      expect(instructions).not.toContain("Only the execution director delegates");
    for (const role of ["worker", "execution-inspector"]) {
      const body = bodies.get(role)!;
      expect(body).toContain("checkpoint-first");
      expect(body).toContain("best-effort");
      expect(body).toContain("historical");
      expect(body).toContain("human-delivery provenance");
      expect(body).not.toContain("Restoration needs\ncurrent settled-producer observations");
    }
    expect(bodies.get("execution-inspector")).not.toContain("Prepare\nan implementation TODO");
  });

  test("native sandbox runs initial independent read-only evidence providers, not human confirmation or product effects", async () => {
    const calls: Record<string, unknown>[] = [];
    const result = await runWorkflowScript({ script: read("skills/plan/context.js"), args: { brief: "Assignment and version-specific sources" },
      launch: async (key, request) => { calls.push(request); return { key, ok: true, output: "", artifactPaths: [], runId: key,
        structuredOutput: { status: "ready", report: `Factual evidence from ${request.agent}` } }; },
      status: async () => { throw new Error("Unexpected status"); },
    });
    expect(result.value).toMatchObject({ status: "ready" }); expect(calls.map(call => call.agent)).toEqual(["pitako.scout", "pitako.researcher"]);
    expect(calls.every(call => call.context === "fresh" && call.output === false)).toBe(true);
    for (const call of calls) expect(call.task).toContain("Human preferences belong to the foreground user");
    const skill = read("skills/plan/SKILL.md");
    for (const contract of ["ACTUAL\nHUMAN", "then wait", "ONLY", "Never implements product code", "approved: true", "ENTIRE currently unblocked frontier"])
      expect(skill).toContain(contract);
    expect(validateWorkflowScript(read("skills/architecture/workflow.js")).ok).toBe(true);
  });

  test("worker preserves upstream implementation core, explicit providers, Ponytail FULL and no delegation; all packaged children stay nondelegating", () => {
    const { frontmatter: worker, body } = parseFrontmatter(read("agents/worker.md"));
    const upstream = parseFrontmatter(read("node_modules/pi-subagents/agents/worker.md"));
    expect(`${worker.package}.${worker.name}`).toBe("pitako.worker");
    for (const field of ["acceptanceRole", "defaultContext", "inheritProjectContext", "systemPromptMode", "defaultReads", "defaultProgress"]) expect(worker[field]).toEqual(upstream.frontmatter[field]);
    const tools = String(worker.tools).split(/,\s*/);
    for (const tool of ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor", "apply_patch", "codegraph_explore", "codegraph_files", "lsp_symbols", "lsp_rename", "ast_search", "ast_rewrite"]) expect(tools).toContain(tool);
    expect(tools).not.toContain("subagent"); expect(worker.allowNestedSubagents).toBeUndefined(); expect(worker.model).toBeUndefined();
    expect(String(worker.skills).split(/,\s*/)).toEqual(["ponytail", "verify-behavior", "rust-best-practices", "rust-review", "rust-port"]);
    expect(worker.skillPath).toEqual([
      "../node_modules/@dietrichgebert/ponytail/skills/ponytail",
      "../skills/practical/verify-behavior",
      "../skills/language/rust-best-practices",
      "../skills/language/rust-review",
      "../skills/language/rust-port",
    ]);
    expect(worker.extensions).toEqual(["../extensions/acp.ts"]);
    expect(worker.subagentOnlyExtensions).toEqual(["../extensions/dev-tools/index.ts", "../extensions/file-sha256.ts", "../extensions/checkpoint-create.ts", "../node_modules/@vndv/pi-codegraph/extensions/codegraph.ts", "../node_modules/pi-lsp-client/src/index.ts", "../node_modules/@nicknisi/pi-ast-grep/index.ts", "../node_modules/pi-codex-tools/index.ts"]);
    for (const provider of worker.subagentOnlyExtensions as string[]) expect(existsSync(path.resolve("agents", provider))).toBe(true);
    for (const contract of ["single writer thread", "pause and escalate", "Ponytail in FULL mode", "schema/reporting", "edit/write"])
      expect(body).toContain(contract);
    for (const role of ["architect", "execution-director", "reviewer"]) {
      const profile = parseFrontmatter(read(`agents/${role}.md`));
      expect(profile.frontmatter.skills).toContain("ponytail");
      expect(profile.body).toContain("FULL");
      if (role === "reviewer") expect(profile.frontmatter.skills).toContain("ponytail-review");
    }
    const director = parseFrontmatter(read("agents/execution-director.md"));
    for (const tool of ["subagent", "bg_wait", "todo", "contact_supervisor", "subagent_supervisor"]) expect(String(director.frontmatter.tools).split(/,\s*/)).not.toContain(tool);
    expect(String(director.frontmatter.tools)).not.toMatch(/\b(?:bash|edit|write|apply_patch)\b/);
    expect(director.frontmatter.extensions).toEqual(["../extensions/acp.ts"]);
    expect(director.frontmatter.subagentOnlyExtensions).toEqual(["../extensions/dev-tools/index.ts", "../extensions/file-sha256.ts"]);
    for (const role of ["architect", "reviewer", "scout", "researcher", "evidence-auditor", "execution-inspector"]) {
      const profile = parseFrontmatter(read(`agents/${role}.md`)).frontmatter;
      expect(profile.acceptanceRole).toBe("read-only"); expect(profile.allowNestedSubagents).toBeUndefined();
      expect(profile.tools).not.toContain("subagent");
    }
  });

  test("director required-tool plan has no fanout or private TODO provider; interview relay retains native contact", () => {
    const { frontmatter, body } = parseFrontmatter(read("agents/execution-director.md"));
    const plan = resolvePiLaunchToolPlan({ tools: String(frontmatter.tools).split(/,\s*/), extensions: [],
      subagentOnlyExtensions: (frontmatter.subagentOnlyExtensions as string[]).map(provider => path.resolve("agents", provider)) });
    expect(plan.fanoutAuthorized).toBe(false);
    expect(plan.requiredChildTools).not.toContain("todo"); expect(plan.requiredChildTools).not.toContain("subagent");
    expect(body).toContain("then END"); expect(body).toContain("needs-decision");
    const relay = parseFrontmatter(read("agents/interview-relay.md"));
    const relayPlan = resolvePiLaunchToolPlan({ tools: String(relay.frontmatter.tools).split(/,\s*/), extensions: [] });
    expect(relayPlan.fanoutAuthorized).toBe(false); expect(relayPlan.effectiveToolAllowlist).toContain("contact_supervisor");
    expect(relay.body).toContain("ACTUAL HUMAN"); expect(relay.body).toContain("await the real supervisor reply");
  });

  test("grilling retains exact pinned primary bytes, MIT notice, source mapping and package discovery", () => {
    const provenance = JSON.parse(read("docs/provenance.json")).grilling;
    expect(provenance.revision).toBe("5beb35b040e3de97e54fa9e386d7e42d15c295c2"); expect(provenance.localModifications).toEqual([]);
    for (const destination of Object.values(provenance.sourceMapping) as string[]) expect(createHash("sha256").update(readFileSync(destination)).digest("hex")).toBe(provenance.sha256[destination]);
    expect(read("docs/licenses/mattpocock-skills-LICENSE")).toContain("Copyright (c) 2026 Matt Pocock");
    const manifest = JSON.parse(read("package.json"));
    for (const name of ["plan", "execute", "grilling"]) { expect(manifest.pi.skills).toContain(`./skills/${name}`); expect(DEFAULT_SKILL_NAMES as readonly string[]).toContain(name); }
    for (const directory of ["skills", "extensions", "agents", "prompts"]) expect(manifest.files).toContain(directory);
    for (const name of ["plan", "execute"]) expect(read(`prompts/${name}.md`)).toContain(`packaged ${name} skill`);
    expect(read("THIRD_PARTY.md")).toContain(provenance.revision);
  });
});

test("advertised execute tool entry requires explicit native binding without claiming RPC confinement", () => {
  let guard: ((event: unknown, context?: unknown) => unknown) | undefined;
  planExecute({ on: (name: string, handler: (event: unknown) => unknown) => { if (name === "tool_call") guard = handler; } } as unknown as ExtensionAPI);
  const root = repository();
  const call = (options?: unknown, args?: unknown, workflow: unknown = "pitako.execute", toolName = "subagent") => guard!({ toolName, input: { workflow, args, options } }, { cwd: root });
  const missionId = "explicit.native-id", args = { missionId, missionPath: "/native/actual-mission.json", root };
  for (const options of [undefined, {}, { mission: false }, { mission: true }, { mission: [] }, { mission: {} }, { missionId: "" }, { missionId: false }]) expect(call(options, args)).toMatchObject({ block: true });
  for (const missingOrInvalid of [undefined, {}, null, [], { missionId: "" }, { missionId: false }, { missionId: "different-id" }, { missionId: "../escape" }])
    expect(call({ missionId }, missingOrInvalid)).toMatchObject({ block: true });
  for (const mission of [{ title: "Explicit creation" }, { summary: "Explicit creation" }, false]) {
    expect(call({ mission }, args)).toMatchObject({ block: true });
    expect(call({ missionId, mission }, args)).toMatchObject({ block: true });
  }
  expect(call({ missionId }, args)).toBeUndefined();
  // Native ownership validates storage existence; matching DATA pointers are not approval or confinement.
  expect(call({ missionId: "missing-id-native-must-reject" }, { missionId: "missing-id-native-must-reject", missionPath: "/native/actual-mission.json", root })).toBeUndefined();
  expect(call({ missionId }, { ...args, missionId: "different-id" }, " pitako.execute ")).toMatchObject({ block: true });
  expect(call({ missionId }, args, " pitako.execute ")).toBeUndefined();
  expect(call(undefined, undefined, "review")).toBeUndefined(); expect(call(undefined, undefined, true)).toBeUndefined(); expect(call(undefined, undefined, "./workflow.js")).toBeUndefined(); expect(call(undefined, undefined, "pitako.execute", "read")).toBeUndefined();
});

describe("compact admission and preliminary capture", () => {
  const spec = (id = "assignment") => `---\npitako-spec: 1\nid: ${id}\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`;
  function inputs() {
    const root = repository(), store = mkdtempSync(path.join(tmpdir(), "pitako-admission-settings-")); roots.push(store);
    const source = path.join(root, ".pitako/plans/assignment.md"); mkdirSync(path.dirname(source), { recursive: true });
    const prefix = spec() + "中😀\n'; globalThis.injected = true; //\n";
    const content = prefix + '"'.repeat(MAX_SPEC_BYTES - Buffer.byteLength(prefix)); writeFileSync(source, content);
    const { missionPath } = missionFiles(store);
    const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath };
    const resource = resourceWithAgentDir(store);
    return { root, store, source, content, args, resource };
  }
  const inspect = (expanded: ReturnType<ReturnType<typeof executionResource>["resolve"]>, root: string) => {
    const stdout = execFileSync("sh", ["-c", expanded.hostCommands[0]!.command], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(4096);
    return JSON.parse(stdout);
  };
  test("one compact native host admission independently binds full maximum escaped preliminary data", () => {
    const { root, store, source, content, args, resource } = inputs();
    // Neither invalid settings nor missing source-ref bytes are read by resolve.
    writeFileSync(path.join(store, "settings.json"), "invalid JSON");
    const expanded = resource.resolve(args);
    expect(expanded.hostCommands).toHaveLength(3);
    expect(expanded.hostCommands[0]!.key).toBe("inspect-initial");
    expect(expanded.script).not.toContain("function capturePacket");
    const config = JSON.parse(expanded.script.split("const config = ")[1]!.split(";\nconst pitakoReviewLibraryMode")[0]!);
    expect(config.preliminary.content).toBe(content);
    expect(config.chunks).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(config.preliminary))).toBeGreaterThan(65536);
    expect(inspect(expanded, root).error).toContain("settings.json");
    writeFileSync(path.join(store, "settings.json"), JSON.stringify({ pitako: { execute: { maxCycles: 4 } } }));
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(path.join(root, ".pi/settings.json"), JSON.stringify({ pitako: { execute: { maxCycles: 10 } } }));
    const receipt = inspect(expanded, root);
    const { head, fingerprint } = checkoutEvidence(root);
    expect(receipt).toEqual({ version: 1, binding: config.preliminary.binding, admission: { maxCycles: 10 }, checkout: { head, fingerprint } });
    expect(receipt.content).toBeUndefined(); expect(receipt.source).toBeUndefined();
    writeFileSync(source, content.slice(0, -1) + "x");
    expect(inspect(expanded, root).binding).not.toBe(config.preliminary.binding);
  });
  test("preliminary capture retains native expanded-script permit and inert executable-looking data", () => {
    const { root, args, content } = inputs();
    const hooks = new Map<string, (event: unknown, context: unknown) => void>();
    planExecute({ on: (name: string, hook: (event: unknown, context: unknown) => void) => hooks.set(name, hook) } as unknown as ExtensionAPI);
    const sessionId = randomUUID(), ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
    hooks.get("session_start")!({}, ctx);
    disposers.push(() => hooks.get("session_shutdown")!({}, ctx));
    const resolved = resolveWorkflowResource("pitako.execute", args, sessionId);
    if (!resolved.ok) throw Error(resolved.error);
    expect(validateWorkflowScript(resolved.resource.script)).toEqual({ ok: true, errors: [] });
    expect(resolved.resource.script).toContain(`const pitakoReviewLibraryMode = true;\n${read("skills/review/workflow.js")}\n${read("skills/execute/workflow.js")}`);
    const permit = consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script);
    if (typeof permit === "string") throw Error(permit);
    expect(permit.authority.host).toHaveLength(3);
    const config = JSON.parse(resolved.resource.script.split("const config = ")[1]!.split(";\nconst pitakoReviewLibraryMode")[0]!);
    expect(config.preliminary.content).toBe(content);
  });
  test("native admission rediscovers changed local-first selection and physical root", () => {
    const { root, args, resource, source } = inputs();
    const sibling = path.join(root, "../", path.basename(root) + "-sibling"); roots.push(sibling);
    execFileSync("git", ["worktree", "add", "-qb", "sibling", sibling], { cwd: root, stdio: "ignore" });
    const target = path.join(sibling, ".pitako/plans/assignment.md"); mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, spec());
    rmSync(source);
    const expanded = resource.resolve(args);
    const before = inspect(expanded, root);
    writeFileSync(source, spec());
    expect(inspect(expanded, root).binding).not.toBe(before.binding);
    const rootBinding = preliminarySpec(root, "assignment").binding;
    expect(preliminarySpec(sibling, "assignment").binding).not.toBe(rootBinding);
    const explicit = resource.resolve({ ...args, source });
    expect(inspect(explicit, root).binding).toBe(rootBinding);
  });
  test("validates every complete source hash beyond a prefix and does not read refs in resolve", () => {
    const { root, store, args, resource } = inputs();
    const ref = path.join(store, "context.md"), content = spec("context") + "x".repeat(24000);
    const sourceRefs = [{ path: ref, digest: digest(content) }];
    const expanded = resource.resolve({ ...args, sourceRefs });
    expect(inspect(expanded, root).error).toContain("ENOENT");
    writeFileSync(ref, content);
    expect(inspect(expanded, root).admission.maxCycles).toBe(3);
    writeFileSync(ref, content.slice(0, -1) + "y");
    const failed = inspect(expanded, root);
    expect(failed.error).toContain("Complete spec source hash mismatch");
    expect(failed.error).toContain(sourceRefs[0]!.digest);
    expect(failed.next).toContain("restore reliable exact originals");
  });
});


describe("deterministic observer", () => {
  test("deterministic observer registers a fixed external CLI through public events and owns session disposal", () => {
    const hooks = new Map<string, (...args: any[]) => any>();
    const requests: any[] = []; let disposed = 0;
    const pi = { on: (name: string, hook: (...args: any[]) => any) => hooks.set(name, hook), registerTool() {},
      events: { emit: (name: string, request: any) => {
        expect(name).toBe("pi-subagents:runtime-agent-register:v1"); requests.push(request);
        const registration = registerAgent({ pi: pi as unknown as ExtensionAPI, name: request.name, definition: request.definition });
        request.result = { ok: true, registration: { dispose() { disposed++; registration.dispose(); } } };
      } } };
    const otherHooks = new Map<string, (...args: any[]) => any>(); let otherDisposed = 0;
    const other = { on: (name: string, hook: (...args: any[]) => any) => otherHooks.set(name, hook),
      events: { emit: (_name: string, request: any) => { request.result = { ok: true, registration: { dispose() { otherDisposed++; } } }; } } };
    registerPlanExecute(pi as unknown as ExtensionAPI); registerPlanExecute(other as unknown as ExtensionAPI);
    const first = { sessionManager: { getSessionId: () => randomUUID() } };
    try {
      hooks.get("session_start")!({}, first); otherHooks.get("session_start")!({}, first);
      const definition = requests[0].definition;
      expect(requests[0].name).toBe("pitako.checkout-observer");
      expect(definition.runner).toEqual({ type: "external-cli", command: process.execPath,
        args: [path.resolve("skills/execute/observe.mjs")], promptDelivery: "stdin" });
      expect(path.isAbsolute(definition.runner.command)).toBe(true);
      expect(definition).toMatchObject({ tools: [], allowNestedSubagents: false, defaultContext: "fresh",
        inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, defaultAsync: false });
      expect(definition.model).toBeUndefined(); expect(definition.extensions).toBeUndefined();
      const ledger = requests[1];
      expect(ledger.name).toBe("pitako.execution-ledger");
      expect(ledger.definition.runner).toEqual({ type: "external-cli", command: process.execPath,
        args: [path.resolve("skills/execute/ledger.mjs")], promptDelivery: "stdin" });
      expect(ledger.definition).toMatchObject({ tools: [], allowNestedSubagents: false, defaultContext: "fresh",
        inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, defaultAsync: false });
      expect(ledger.definition.model).toBeUndefined(); expect(ledger.definition.outputSchema).toBeUndefined();
      expect(() => registerAgent({ pi: pi as unknown as ExtensionAPI, name: requests[0].name, definition })).toThrow();
      expect(disposed).toBe(0);
      hooks.get("session_start")!({}, first);
      expect(disposed).toBe(2); expect(otherDisposed).toBe(0);
      hooks.get("session_shutdown")!(); hooks.get("session_shutdown")!();
      expect(disposed).toBe(4); expect(otherDisposed).toBe(0);
    } finally { hooks.get("session_shutdown")!(); otherHooks.get("session_shutdown")!(); }
    expect(otherDisposed).toBe(2);
  });

  test("deterministic agents report conflicts and native rejection without fallback or replacement", () => {
    for (const rejectedAgent of [1, 2]) for (const failure of ["conflicting deterministic agent", "native registration rejected", null]) {
      const hooks = new Map<string, (...args: any[]) => any>(); let calls = 0;
      registerPlanExecute({ on: (name: string, hook: (...args: any[]) => any) => hooks.set(name, hook),
        events: { emit: (_name: string, request: any) => {
          calls++;
          if (calls < rejectedAgent) request.result = { ok: true, registration: { dispose() {} } };
          else if (failure) request.result = { ok: false, error: new Error(failure) };
        } } } as unknown as ExtensionAPI);
      const session = randomUUID();
      expect(() => hooks.get("session_start")!({}, { sessionManager: { getSessionId: () => session } })).toThrow(failure ?? "not installed");
      expect(calls).toBe(rejectedAgent);
      expect(resolveWorkflowResource("pitako.execute", {}, session).ok).toBe(false);
      hooks.get("session_shutdown")!();
    }
  });

  test("deterministic observer binds cwd, publishes last, accepts identical retries and rejects changed observations", async () => {
    const root = repository(), entry = path.resolve("skills/execute/observe.mjs");
    const spec = { content: "immutable spec", digest: digest("immutable spec") };
    let request: any = { expected: { invocation: "observer-test", count: 0, head: null },
      body: { spec, record: { kind: "loop", loop: 1, body: { review: "clear" } } } };
    const run = async (input = request) => {
      const child = Bun.spawn(["node", entry], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(typeof input === "string" ? input : JSON.stringify(input)); child.stdin.end();
      return checkpointLifecycle(child, ([exit, stdout]) => {
        expect(exit).toBe(0); expect(Buffer.byteLength(stdout)).toBeLessThan(65536);
        return JSON.parse(stdout);
      }).result;
    };
    for (const input of ["process.chdir('/');", { ...request, root: "/" },
      { ...request, expected: { ...request.expected, root: "/" } },
      { ...request, body: { ...request.body, command: "false" } }]) {
      expect(await run(input)).toMatchObject({ ok: false });
      expect(existsSync(path.join(root, ".pi/subagents/execute/observer-test/000000.json"))).toBe(false);
    }
    const initial = await run();
    expect(initial).toMatchObject({ version: 1, ok: true, root, commonDir: path.join(root, ".git"),
      checkout: { head: checkoutEvidence(root).head, fingerprint: checkoutEvidence(root).fingerprint }, ledger: { count: 2, head: initial.ledger.head } });
    expect(await run()).toEqual(initial); // Crash after link, before the root admits stdout.
    writeFileSync(path.join(root, "wip"), "fresh WIP");
    expect(await run()).toMatchObject({ ok: false, error: "ledger-integrity", reason: "Ledger publication conflict." });
    request = { expected: { invocation: "observer-test", ...initial.ledger },
      body: { record: { kind: "loop", loop: 2, body: { review: "gaps" } } } };
    const dirty = await run(); expect(dirty.ok, JSON.stringify(dirty)).toBe(true);
    expect(dirty.checkout.fingerprint).not.toBe(initial.checkout.fingerprint);
    expect(dirty.checkout.head).toBe(initial.checkout.head);
    execFileSync("git", ["add", "wip"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "changed"], { cwd: root });
    request = { expected: { invocation: "observer-test", ...dirty.ledger },
      body: { record: { kind: "loop", loop: 3, body: {} } } };
    const committed = await run(); expect(committed.checkout.head).not.toBe(initial.checkout.head);
    expect(committed.checkout).toEqual({ head: checkoutEvidence(root).head, fingerprint: checkoutEvidence(root).fingerprint });
  });

  test("deterministic observer returns complete bounded failure for invalid checkout and oversized output", async () => {
    const root = repository(), nested = path.join(root, "nested"); mkdirSync(nested);
    const invalid = mkdtempSync(path.join(tmpdir(), "pitako-observer-invalid-")); roots.push(invalid);
    for (const cwd of [nested, invalid]) {
      const child = Bun.spawn(["node", path.resolve("skills/execute/observe.mjs")], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write("ignore"); child.stdin.end();
      await checkpointLifecycle(child, ([exit, stdout]) => {
        expect(exit).toBe(0); expect(Buffer.byteLength(stdout)).toBeLessThan(65536);
        expect(JSON.parse(stdout)).toMatchObject({ version: 1, ok: false, reason: expect.any(String), nextStep: expect.any(String) });
      }).result;
    }
    // Exercise the actual producer formatter with a payload whose escaped form exceeds capture.
    const loader = new URL("../skills/execute/loader.mjs", import.meta.url).href;
    const producer = new URL("../skills/execute/observe.ts", import.meta.url).href;
    for (const ok of [true, false]) {
      const script = `import ${JSON.stringify(loader)}; const {observationOutput}=await import(${JSON.stringify(producer)}); process.stdout.write(observationOutput({version:1,ok:${ok},reason:'"\\\\😀'.repeat(20000)}));`;
      const child = Bun.spawn(["node", "--input-type=module", "-e", script], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.end();
      await checkpointLifecycle(child, ([exit, stdout]) => {
        expect(exit).toBe(0); expect(Buffer.byteLength(stdout)).toBeLessThan(65536);
        expect(JSON.parse(stdout)).toMatchObject({ version: 1, ok: false, reason: "Checkout observation exceeds the stdout boundary." });
      }).result;
    }
  });
});

describe("plan/execute packaged composition", () => {
  // Registered discovery + launch hook + native script runner, not manually
  // pasted workflow bytes. The Node replay uses the same controlled boundaries.
  test.each(["post-input-transport", "post-input-stop", "post-input-permission", "post-input-pending", "post-input-repeat-failure", "automatic-opening", "automatic-stop", "automatic-pending", "automatic-permission", "automatic-failure", "automatic-intention-cut", "automatic-admission-cut", "automatic-intention-permission", "automatic-intention-pending", "opening-stopped", "opening-failed", "decision", "historical-child-stop", "historical-child-permission", "historical-child-unknown", "current-stop", "current-permission", "current-pending",
    "retained-plan-pending", "retained-worker-pending", "retained-operation-pending", "retained-operation-usable",
    "retained-operation-unresolved", "retained-operation-conflict", "retained-operation-persistence"])(
    "registered current resolution continues or preserves a current barrier: %s", async mode => {
      const root = repository(), spec = assignmentSpec(root), sessionId = randomUUID();
      const hooks = new Map<string, (event: any, context: any) => any>();
      planExecute({ on: (name: string, hook: any) => hooks.set(name, hook) } as unknown as ExtensionAPI);
      const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
      hooks.get("session_start")!({}, ctx);
      disposers.push(() => hooks.get("session_shutdown")!({}, ctx));
      const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
      const automatic = mode.startsWith("automatic-");
      const target = mode.endsWith("capture") ? "input-0" : mode.endsWith("closing") ? "inspect-loop-1" : "inspect-initial";
      const historicalChild = mode.startsWith("historical-child-");
      const retainedRecovery = mode.startsWith("retained-");
      const interruptedLoop = ["closing", "decision"].includes(mode) || historicalChild || retainedRecovery ? 1 : 0;
      const continued = { ...args, unblock: true, resolution: { loop: interruptedLoop, text: "Current human request: reconstruct the same invocation and continue under current native policy." } };
      expect(hooks.get("tool_call")!({ toolName: "subagent", input: { workflow: "pitako.execute", cwd: root, args: continued, options: { missionId: args.missionId } } }, ctx)).toBeUndefined();
      expect(hooks.get("tool_call")!({ toolName: "subagent", input: { workflow: "pitako.execute", cwd: root, args: { ...args, unblock: true }, options: { missionId: args.missionId } } }, ctx)).toMatchObject({ block: true });
      const initial = resolveWorkflowResource("pitako.execute", args, sessionId);
      const resumed = resolveWorkflowResource("pitako.execute", continued, sessionId);
      const renewed = resolveWorkflowResource("pitako.execute", { ...continued,
        resolution: { loop: interruptedLoop, text: "Renewed current input after inspector interruption." } }, sessionId);
      if (!initial.ok || !resumed.ok || !renewed.ok) throw Error("Registered resolution failed");
      const initialAuthority = consumeWorkflowResourcePermit(initial.resource.permit, initial.resource.script);
      const resumedAuthority = consumeWorkflowResourcePermit(resumed.resource.permit, resumed.resource.script);
      const renewedAuthority = consumeWorkflowResourcePermit(renewed.resource.permit, renewed.resource.script);
      if (typeof renewedAuthority === "string") throw Error("Registered renewed authority unavailable");
      if (typeof initialAuthority === "string" || typeof resumedAuthority === "string") throw Error("Registered host authority unavailable");
      expect(initialAuthority.authority.host?.length).toBeGreaterThan(0);
      expect(resumedAuthority.authority.host).toEqual(initialAuthority.authority.host);
      const content = spec.content;
      const metadata = { root, commonDir: path.join(root, ".git"), candidates: [],
        selected: { source: `${root}/.pitako/plans/assignment.md`, digest: digest(content), chunks: 1 } };
      const children: Record<string, any> = {};
      for (const loop of [1, 2]) for (const phase of ["director", "t1.a1", "review.director-prepare", "review.independent-a", "review.independent-b", "review.director-synthesis", "compliance", "checkout"]) {
        const key = `invoke-human-1.l${loop}.${phase}`;
        children[key] = childResponse(key, { agent: phase === "director" ? "pitako.execution-director" : phase === "checkout" ? "pitako.checkout-observer" : phase === "t1.a1" ? "pitako.worker" : "pitako.reviewer" }, metadata, checkout);
      }
      if (mode === "decision") Object.assign(children["invoke-human-1.l1.director"].structuredOutput, { status: "needs-decision", reason: "Original question: reconcile historical host ambiguity", tasks: [] });
      if (historicalChild) Object.assign(children["invoke-human-1.l1.t1.a1"], { ok: false,
        ...(mode.endsWith("permission") ? { error: "Blocked by pi-subagents permission rule: 'run' is denied." } : { stopped: true }),
        ...(mode.endsWith("unknown") ? {} : { results: [{ index: 0, agent: "pitako.worker", task: "Controlled interrupted work",
          exitCode: mode.endsWith("permission") ? 1 : -1, processSignal: mode.endsWith("permission") ? null : "SIGTERM",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] }) });
      const input = { mode, binding: spec.binding, initial: initial.resource.script, resumed: automatic ? initial.resource.script : resumed.resource.script, renewed: renewed.resource.script, children, metadata, checkout, content, target, interruptedLoop };
      // Keep one identical harness for Bun and the owned Node process.
      const harness = async (input: any, run: typeof runWorkflowScript) => {
        const storage = new Map<string, any>(), calls: string[] = [], hosts: string[] = [];
        const publications: any[] = [];
        const statusCalls: string[] = [], inspectors: Record<string, any> = {};
        let replay = false, cut = false, laterHostFailure = false;
        const automatic = input.mode.startsWith("automatic-");
        const retainedRecovery = input.mode.startsWith("retained-");
        const operationRecovery = input.mode.startsWith("retained-operation-");
        const producer = input.mode.startsWith("retained-plan-") ? "invoke-human-1.l1.director" : "invoke-human-1.l1.t1.a1";
        const stopped = (value: any) => ({ ...structuredClone(value), ok: false, stopped: true,
          results: [{ index: 0, agent: value.agent, task: "Interrupted controlled operation", exitCode: -1, processSignal: "SIGTERM" }] });
        const options = {
          script: input.initial,
          state: { get: async (key: string) => structuredClone(storage.get(key)), set: async (key: string, value: any) => {
            if (replay && input.mode === "retained-operation-persistence" && value.loop?.recoveries?.[0]?.stage === "observed")
              throw Error("Controlled essential persistence cut");
            storage.set(key, structuredClone(value));
            if (replay && !cut && ((["automatic-intention-cut", "automatic-intention-permission", "automatic-intention-pending"].includes(input.mode) && value.hostReconstruction?.stage === "intention") ||
                (input.mode === "automatic-admission-cut" && value.hostReconstruction?.stage === "admitted"))) {
              cut = true;
              throw Error("Controlled post-save interruption");
            }
          } },
          launch: async (key: string, request: any) => {
            calls.push(key);
            if (request.agent === "pitako.execution-ledger") {
              const pending = JSON.parse(request.task); publications.push(pending);
              return { key, ok: true, agent: request.agent, runId: "native-" + key, asyncDir: "/native/async/" + key,
                output: JSON.stringify({ count: Math.max(1, pending.expected.count) + 1, head: "c".repeat(64),
                  ...(pending.record.kind === "loop" ? { summaries: [{ loop: pending.record.loop, status: "gaps", gaps: "", review: "", compliance: "", rejection: "" }] } : {}) }),
                externalAdapter: { outputArtifacts: { stdoutPath: "/native/async/" + key + "/stdout.log", stderrPath: "/native/async/" + key + "/stderr.log" } }, results: [{ exitCode: 0 }] };
            }
            if (request.agent === "pitako.execution-inspector") {
              if (retainedRecovery) {
                const complete = input.children[producer];
                const value = { status: "recovered", reason: "Exact retained complete observation",
                  original: operationRecovery ? stopped(complete) : input.mode.startsWith("retained-plan-") ? structuredClone(complete.structuredOutput) : null,
                  workerResult: input.mode.startsWith("retained-worker-") ? structuredClone(complete.structuredOutput) : null,
                  originalAvailable: true, binding: "absent", comparison: "only-original", provenance: [complete.runId] };
                const response = { key, runId: "native-" + key, agent: request.agent, ok: true, output: "", artifactPaths: [], structuredOutput: value };
                inspectors[key] = response;
                return stopped(response);
              }
              const original = input.children["invoke-human-1.l1.t1.a1"];
              return { key, runId: "native-" + key, agent: request.agent, ok: true, output: "", artifactPaths: [],
                structuredOutput: { status: input.mode.endsWith("unknown") ? "unresolved" : "recovered",
                  reason: "Exact complete original receipt with terminal evidence", original: input.mode.endsWith("unknown") ? null : structuredClone(original),
                  workerResult: null, originalAvailable: !input.mode.endsWith("unknown"), binding: "absent",
                  comparison: input.mode.endsWith("unknown") ? "neither" : "only-original", provenance: [original.runId] } };
            }
            const response = structuredClone(input.children[key]);
            if (!response) throw Error("Unexpected child " + key);
            if (request.agent === "pitako.checkout-observer") {
              const observation = JSON.parse(response.output);
              observation.ledger = { count: Math.max(1, JSON.parse(request.task).expected.count) + 1, head: "c".repeat(64) };
              response.output = JSON.stringify(observation);
            }
            if (retainedRecovery && !replay && key === producer)
              return operationRecovery ? stopped(response) : { ...response, structuredOutput: undefined };
            if (replay && input.mode === "current-permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
            if (replay && input.mode === "current-pending") Object.assign(response, { ok: false, state: "running" });
            if ((key.endsWith(".director") || request.agent === "pitako.worker") && replay && input.mode === "decision" && !request.task.includes("Current human request:")) throw Error("Current resolution was not delivered");
            return response;
          },
          status: async (ref: string) => {
            statusCalls.push(ref);
            const inspector = Object.values(inspectors).find((entry: any) => entry.runId === ref || entry.key === ref);
            if (inspector) {
              const value = structuredClone(inspector);
              if (input.mode.endsWith("pending")) value.state = "running";
              if (input.mode.endsWith("unresolved")) value.structuredOutput.status = "unresolved";
              if (input.mode.endsWith("conflict")) value.runId = "different-inspector";
              return value;
            }
            const value = Object.values(input.children).find((entry: any) => entry.runId === ref || entry.key === ref);
            if (!value) throw Error("No settled exact producer");
            if (retainedRecovery && (value as any).key === producer) return { key: ref, ok: true, output: "", artifactPaths: [] };
            if (input.mode.startsWith("historical-child-") && (value as any).key === "invoke-human-1.l1.t1.a1") return structuredClone(value);
            if (input.mode === "current-pending") return { ...structuredClone(value), ok: true, state: "running" };
            if (input.mode === "current-permission") return { ...structuredClone(value), ok: false, error: "Blocked by pi-subagents permission rule: 'run' is denied." };
            return structuredClone(value);
          },
          host: async (key: string) => {
            hosts.push(key);
            if (laterHostFailure) throw Error("Controlled ambiguous transport error after applied human input");
            if (cut && input.mode === "automatic-intention-permission") throw Error("Blocked by pi-subagents permission rule: 'command' is denied.");
            if (cut && input.mode === "automatic-intention-pending") return {
              key, kind: "command" as const, state: "running", ok: true, exitCode: null, stdout: "", stderr: "", durationMs: 0, outputPath: "/native/pending-inspection.log",
            };
            if ((!replay && !retainedRecovery && input.mode !== "decision" && !input.mode.startsWith("historical-child-") && key === input.target) || (replay && ["current-stop", "automatic-failure"].includes(input.mode))) return {
              key, kind: "command" as const, state: input.mode === "opening-failed" ? "failed" : "stopped",
              ok: false, exitCode: null, stdout: "", stderr: "", error: "Command stopped because the workflow was aborted.", durationMs: 0, outputPath: "/native/host-observation.log",
            };
            return { key, kind: "command" as const, state: "passed", ok: true, exitCode: 0, stderr: "", durationMs: 0, outputPath: "/native/inspection.log",
              stdout: JSON.stringify({ version: 1, binding: input.binding, checkout: input.checkout, admission: { maxCycles: 3 } }) };
          },
        };
        const first = await run(options as any);
        if (operationRecovery) {
          // Reach interrupted-operation through the public current-input route,
          // then interrupt its inspector before disposition admission.
          options.script = input.resumed;
          await run(options as any);
        }
        if (["automatic-stop", "automatic-pending", "automatic-permission"].includes(input.mode)) {
          // Actual structured observation already retained by a checkpoint; the
          // identical wrapper text alone did not establish any of these facts.
          const checkpoint = storage.get("invoke-human-1");
          if (input.mode === "automatic-permission") checkpoint.hostHalt.observedBarrier = "native permission denial";
          else checkpoint.hostHalt.observedState = input.mode === "automatic-stop" ? "stopped" : "pending";
        }
        const original = structuredClone(storage.get("invoke-human-1"));
        const before = calls.length;
        replay = true; options.script = input.resumed;
        if (operationRecovery) options.script = input.renewed;
        let oldDefect: any;
        if (["automatic-opening", "automatic-closing"].includes(input.mode)) {
          // The previous registered workflow stopped here before reconstruction.
          options.script = input.resumed.replace(/  if \(hostHalt && !resolution\) \{[\s\S]*?\n  if \(hostHalt\) return finish/, "  if (hostHalt) return finish");
          oldDefect = (await run(options as any)).value;
          if (storage.get("invoke-human-1").hostReconstruction) throw Error("Old-defect contrast did not remove reconstruction");
          options.script = input.resumed;
        }
        const second = await run(options as any);
        const after = calls.length;
        // Durable input, not repeating the public flag, owns technical replay.
        options.script = input.initial;
        let later: any;
        if (input.mode.startsWith("post-input-")) {
          laterHostFailure = true;
          later = (await run(options as any)).value;
          laterHostFailure = input.mode === "post-input-repeat-failure";
          const checkpoint = storage.get("invoke-human-1");
          if (input.mode === "post-input-stop") checkpoint.hostHalt.observedState = "stopped";
          if (input.mode === "post-input-pending") checkpoint.hostHalt.observedState = "pending";
          if (input.mode === "post-input-permission") checkpoint.hostHalt.observedBarrier = "native permission denial";
          // Model a real retained observation, not a classification from text.
          checkpoint.resolutions[0].failedHostObservation = structuredClone(checkpoint.hostHalt);
        }
        const third = await run(options as any);
        let fourth: any;
        if (input.mode.startsWith("post-input-")) {
          laterHostFailure = false;
          fourth = (await run(options as any)).value;
        }
        return { first: first.value, second: second.value, third: third.value, fourth, later, oldDefect, original, retained: storage.get("invoke-human-1"), calls, hosts, statusCalls, publications, before, after };
      };
      const expected = await harness(input, runWorkflowScript);
      if (retainedRecovery) {
        expect(expected.second).toMatchObject({ status: mode.endsWith("usable") ? "complete" : mode.endsWith("pending") ? "blocked" : "cancelled",
          loopsConsumed: mode.endsWith("usable") ? 2 : 1 });
        const recoveries = mode.endsWith("usable") ? expected.publications[0].record.body.recoveries : expected.retained.loop.recoveries;
        expect(recoveries).toHaveLength(1);
        const retained = expected.original.loop.recoveries[0];
        expect(expected.statusCalls).toContain(retained.ref.runId ?? retained.ref.key);
        expect(expected.calls.slice(expected.before).every(key => mode.endsWith("usable") && (key.startsWith("invoke-human-1.l2.") || key === "invoke-human-1.l1.gaps"))).toBe(true);
        expect(recoveries[0].source).toEqual(retained.source);
      }
      const currentBarrier = mode.startsWith("current-");
      if (!retainedRecovery && !automatic) expect(expected.second).toMatchObject({ status: mode === "historical-child-unknown" ? "cancelled" : currentBarrier || mode === "historical-child-permission" ? "blocked" : "complete",
        loopsConsumed: mode === "decision" || historicalChild && !["historical-child-unknown", "historical-child-permission"].includes(mode) ? 2 : currentBarrier && mode === "current-stop" ? 0 : 1 });
      if (automatic) {
        const success = ["automatic-opening", "automatic-closing"].includes(mode);
        expect(expected.second).toMatchObject({ status: success ? "complete" : mode.endsWith("cut") || mode.startsWith("automatic-intention-") ? "partial" : "blocked" });
        expect(expected.third).toMatchObject({ status: success || ["automatic-admission-cut", "automatic-intention-cut"].includes(mode) ? "complete" : "blocked" });
        if (["automatic-intention-permission", "automatic-intention-pending"].includes(mode)) {
          expect(expected.retained.hostReconstruction).toMatchObject({ source: expected.original.hostHalt,
            stage: "failed", failure: expected.retained.hostHalt });
          expect(expected.retained.hostHalt.observedBarrier).toBe(mode.endsWith("permission") ? "native permission denial" : "running");
        } else expect(expected.retained.hostHalt).toEqual(expected.original.hostHalt);
        expect(expected.retained.resolutions).toBeUndefined();
        expect(expected.retained.consumedLoops ?? 0).toBe(success || ["automatic-admission-cut", "automatic-intention-cut"].includes(mode) ? 1 : 0);
        if (success) expect(expected.oldDefect).toMatchObject({ status: "blocked", loopsConsumed: 0 });
        if (success || ["automatic-admission-cut", "automatic-intention-cut"].includes(mode)) {
          expect(expected.retained.hostReconstruction.stage).toBe("admitted");
          expect(expected.retained.hostReconstruction.observation).toMatchObject({
            ref: { key: "inspect-initial", outputReference: "/native/inspection.log" },
            candidate: checkout, source: metadata.selected.source, digest: metadata.selected.digest,
          });
          expect(expected.calls).toContain("invoke-human-1.l1.compliance");
          expect(expected.retained.loop.results).toHaveLength(1);
          expect(expected.retained.association.maxCycles).toBe(3);
        } else expect(expected.calls).toHaveLength(0);
        if (["automatic-stop", "automatic-pending", "automatic-permission"].includes(mode))
          expect(expected.hosts).toEqual(["inspect-initial"]);
      } else if (mode.startsWith("post-input-")) {
        expect(expected.later).toMatchObject({ status: "blocked", loopsConsumed: 1 });
        const status = mode === "post-input-transport" ? "complete" : "blocked";
        expect(expected.third).toMatchObject({ status, loopsConsumed: 1 });
        expect(expected.fourth).toMatchObject({ status, loopsConsumed: 1 });
        expect(expected.retained.resolutions).toHaveLength(1);
        expect(expected.retained.resolutions[0].hostHalt).toEqual(expected.original.hostHalt);
        if (mode === "post-input-transport") expect(expected.retained.hostReconstruction).toMatchObject({
          stage: "admitted", source: expected.retained.resolutions[0].failedHostObservation,
        });
        if (mode === "post-input-repeat-failure") expect(expected.retained.hostReconstruction.stage).toBe("failed");
        expect(expected.retained.loop.results).toHaveLength(1);
        expect(expected.retained.loop.review.verdict).toBe("clear");
        expect(expected.retained.loop.compliance.status).toBe("fulfilled");
      } else expect(expected.third).toMatchObject({ status: (expected.second as any).status, loopsConsumed: (expected.second as any).loopsConsumed });
      if (!["automatic-admission-cut", "automatic-intention-cut"].includes(mode)) expect(expected.calls).toHaveLength(expected.after);
      if (mode === "decision" || historicalChild) {
        if (expected.retained.consumedLoops > 1) {
          const prior = expected.publications.find((pending: any) => pending.record?.kind === "loop").record.body;
          expect(prior.plan).toEqual(expected.original.loop.plan);
          expect(prior.resolutions[0]).toMatchObject({ loop: 1, stage: "applied" });
          expect(expected.retained.lastClosedResolution).toBeNull();
        } else {
          expect(expected.retained.loop.plan).toEqual(expected.original.loop.plan);
          expect(expected.retained.loop.resolutions[0].halt).toEqual(expected.original.loop.halt);
        }
      } else if (!retainedRecovery && !automatic) {
        expect(expected.original.hostHalt).not.toHaveProperty("observedState");
        expect((expected.retained.resolutions ?? expected.retained.loop.resolutions)[0].hostHalt).toEqual(expected.original.hostHalt);
      }
      const child = Bun.spawn(["node", "-e", `
        const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        import(${JSON.stringify(new URL("../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href)})
          .then(async ({runWorkflowScript}) => console.log(JSON.stringify(await (${harness.toString()})(input, runWorkflowScript))))
          .catch(error => {console.error(error); process.exitCode=1;});
      `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "private-agent") }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
      try {
        child.stdin.write(JSON.stringify(input)); child.stdin.end();
        const [exit, output, errors] = await Promise.all([child.exited, stdout, stderr]);
        expect(errors).not.toContain("unawaited runs.run launch(es)");
        expect(exit, errors).toBe(0);
        const actual = JSON.parse(output);
        expect(actual.second).toMatchObject({ status: (expected.second as any).status, loopsConsumed: (expected.second as any).loopsConsumed });
        expect(actual.third).toMatchObject({ status: (expected.third as any).status, loopsConsumed: (expected.third as any).loopsConsumed });
        expect(actual.calls).toEqual(expected.calls);
        if (mode.startsWith("post-input-")) {
          expect(actual.later).toMatchObject({ status: expected.later.status, loopsConsumed: 1 });
          expect(actual.fourth).toMatchObject({ status: expected.fourth.status, loopsConsumed: 1 });
        }
        if (expected.oldDefect) expect(actual.oldDefect).toMatchObject({ status: expected.oldDefect.status, reason: expected.oldDefect.reason, loopsConsumed: expected.oldDefect.loopsConsumed });
        else expect(actual.oldDefect).toBeUndefined();
        expect(actual.retained.hostReconstruction).toEqual(expected.retained.hostReconstruction);
        expect(actual.retained.association).toEqual(expected.retained.association);
        expect(actual.retained.resolutions ?? actual.retained.lastClosedResolution ?? actual.retained.loop?.resolutions).toEqual(expected.retained.resolutions ?? expected.retained.lastClosedResolution ?? expected.retained.loop?.resolutions);
      } finally { child.kill(); await Promise.all([child.exited, stdout, stderr]); }
    });
});
