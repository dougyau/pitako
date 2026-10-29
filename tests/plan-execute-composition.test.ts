import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import path from "node:path";
import { getAgentDir, loadSkills, formatSkillsForPrompt, parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPromptTemplates, expandPromptTemplate } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
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
import planExecute, { executionResource } from "../extensions/plan-execute.ts";
import { profileNote } from "../extensions/profile.ts";
import { DEFAULT_SKILL_NAMES } from "../extensions/catalog.ts";
import { checkoutEvidence, digest, inspectionSnapshot, MAX_SPEC_BYTES, SPEC_SECTIONS, specChunks, validateSpec } from "../extensions/spec-plans.ts";

const roots: string[] = [], disposers: (() => void)[] = [];
const workflowSettlements: Promise<void>[] = [];
const checkpointCancellations = new Set<() => void>();
async function settleWorkflows() {
  // A runner timeout does not settle a test's workflow continuation.
  for (const cancel of checkpointCancellations) cancel();
  await Promise.all(workflowSettlements.splice(0));
}
afterEach(async () => {
  await settleWorkflows();
  for (const dispose of disposers.splice(0)) dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function checkpointLifecycle<T>(child: Bun.Subprocess<"pipe", "pipe", "pipe">,
  consume: (observation: [number, string, string]) => T) {
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  const pending = [child.exited, stdout, stderr] as const;
  const observed = Promise.all(pending);
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  checkpointCancellations.add(cancel);
  const result = (async () => {
    try {
      const observation = await observed;
      // Teardown joins without running assertions or rejecting an abandoned await.
      if (cancelled) return;
      return consume(observation);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      // Promise.all alone can reject before another stream or exit settles.
      await Promise.allSettled(pending);
      checkpointCancellations.delete(cancel);
    }
  })();
  // Observe rejection immediately, including when the runner abandons its await.
  // The original result still rejects for the caller; this only owns settlement.
  const settled = result.then(() => {}, () => {});
  workflowSettlements.push(settled);
  return { result, observed, settled, cancel };
}
const read = (name: string) => readFileSync(path.resolve(name), "utf8");
function repository() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-workflow-resource-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"); return root;
}
function resourceWithAgentDir(agentDir: string) {
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try { return executionResource("linux"); }
  finally { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; }
}

// Controlled child boundary: actual root/review scripts execute in the native sandbox.
// Responses implement schemas only; no provider or model obedience is certified.
function childResponse(key: string, request: any, metadata: any, checkout: any, completeLoop = 1) {
  const loop = Number(key.match(/\.l(\d+)\./)?.[1] ?? 1);
  let value: any;
  const task = { id: "final", kind: "verification", goal: "Verify complete candidate", contextRefs: ["full spec"],
    sourceRefs: [metadata.selected.source], scope: [metadata.root], allowedEffects: ["checks"], expectedResult: "Current required checks", dependsOn: [],
    checks: [{ id: "final-check", requirement: "All specs", command: "bun test affected", cwd: metadata.root }] };
  if (key.endsWith(".director")) value = { status: "plan", reason: "Complete ordered work", association: {
    missionId: "native.mission-1", missionPath: "/native/actual-mission.json", invocation: "human-1", loop, maxCycles: 3, sourceRefs: [],
    root: metadata.root, commonDir: metadata.commonDir, source: metadata.selected.source, digest: metadata.selected.digest,
  }, sharedContext: { material: "Full shared context", references: [metadata.selected.source] }, tasks: [task] };
  else if (request.agent === "pitako.worker") value = { taskId: "final", attempt: 1, status: "complete", workDone: "Required checks executed",
    remaining: [], diagnosis: "No pending task work", usefulProgress: true, continuation: null,
    git: { head: checkout?.head, checkpoints: [], wip: "Current WIP included" }, candidate: checkout,
    checks: task.checks.map(({ requirement: _requirement, ...check }) => ({ ...check, output: "Controlled check passed", logPaths: ["/native/check.log"], result: "passed", before: checkout, after: checkout })) };
  else if (key.endsWith("director-prepare")) value = { status: "ready", reason: "Whole result perspectives", angles: [
    { id: "a", focus: "Correctness", skills: [] }, { id: "b", focus: "Requirements", skills: [] }] };
  else if (key.includes("independent-")) value = { status: "ready", reason: "Source inspected", coverage: "Complete candidate", findings: [] };
  else if (key.endsWith("director-synthesis")) value = { status: "ready", reason: "No material gaps", memo: "Whole-result analysis",
    dispositions: [], screening: { verdict: "clear", reason: "Current candidate inspected", assessments: [] } };
  else if (key.endsWith(".compliance")) value = { status: loop >= completeLoop ? "fulfilled" : "gaps", reason: "Complete requirement inventory",
    candidate: checkout, requirements: Array.from({ length: 17 }, (_, index) => ({ id: `criterion-${index + 1}`, source: `spec:criterion-${index + 1}`,
      reason: "Current source/check evidence", status: loop >= completeLoop ? "fulfilled" : "gap", evidence: ["src/entry.ts:1"], checks: ["/native/check.log"] })) };
  else throw Error(`Unexpected child ${key}`);
  return { key, ok: true, output: "", runId: `native-${key}`, agent: request.agent ?? "pitako.reviewer", artifactPaths: [], structuredOutput: value };
}
// Controlled child loading boundary: use the launch binding emitted by the real root,
// never construct an intention or tool result. Factory registration and publication are real.
async function registeredCheckpoint(request: any, root: string, loadExtensions: any, toolPath: string, key: string) {
  if (!request.task.includes('checkpoint_create({kind:"pre"') ||
      !request.task.includes('checkpoint_create({kind:"unit"})') ||
      !request.task.includes('checkpoint_create({kind:"pause"})') ||
      request.task.includes("helper's capture operation") || request.task.includes("helper seal operation"))
    throw Error("Effective checkpoint consumer still requires manual capture/seal assembly");
  const binding = request.extensionBindings?.["pitako.checkpoint/1"];
  if (!binding || binding.key !== key || binding.association.root !== root)
    throw Error("Missing real native launch checkpoint binding: " + JSON.stringify({ key, binding }));
  let tool: any;
  const prior = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  try {
    process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify(request.extensionBindings);
    const loaded = await loadExtensions([toolPath], root);
    if (loaded.errors.length) throw Error(JSON.stringify(loaded.errors));
    // Cached loading still initializes a fresh tool with this launch binding.
    tool = loaded.extensions[0]?.tools.get("checkpoint_create")?.definition;
    if (!tool) throw Error("Native extension loader did not register checkpoint_create");
  } finally {
    if (prior === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = prior;
  }
  return async (kind: string, paths?: string[], signal?: AbortSignal) => {
    const result = await tool.execute("registered-checkpoint", { kind, ...(paths ? { paths } : {}) }, signal,
      undefined, { cwd: root, sessionManager: {} });
    const value = result.structuredContent;
    if (!value?.ok || value.confirmed !== false) { console.error(value); throw Error(JSON.stringify(value)); }
    return value;
  };
}

// One file-owned Node process amortizes native SDK/provider loading. Each message
// still creates fresh storage, roots and launch-bound tool registrations. Cases
// are awaited by the file's normal test order; other files remain parallel.
let nativeCheckpoint: ReturnType<typeof spawn> | undefined;
let nativeCheckpointRoot: string;
let nativeCheckpointExit: Promise<[number, string, string]>;
let nativeCheckpointReply: ((value: [number, string, string] | undefined) => void) | undefined;
const nativeCheckpointExits: { promise: Promise<[number, string, string]>; cancelled: boolean }[] = [];
async function startNativeCheckpoint() {
  nativeCheckpointRoot ??= mkdtempSync(path.join(tmpdir(), "pitako-checkpoint-node-"));
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const child = spawn("node", ["-e", `
    const disconnect=()=>{if(process.connected)process.disconnect();};
    process.on('SIGTERM',()=>{process.exitCode ||= 143;disconnect();});
    const send=value=>{
      if(process.connected)process.send(value,error=>{
        if(error){console.error(error);process.exitCode=1;disconnect();}
      });
    };
    (async()=>{
      const {runWorkflowScript}=await import(${JSON.stringify(new URL("../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href)});
      const loadExtensions=(await import(${JSON.stringify(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url).href)})).loadExtensionsCached;
      await loadExtensions([${JSON.stringify(path.resolve("extensions/checkpoint-create.ts"))}],process.cwd());
      process.on('message',async ({input,harness})=>{
        const prior=process.env.PI_CODING_AGENT_DIR, cwd=process.cwd();
        try {
          process.chdir(input.root);process.env.PI_CODING_AGENT_DIR=input.agentDir;
          const value=await (0,eval)('('+harness+')')(input,runWorkflowScript,${childResponse.toString()},
            {...require('node:fs'),...require('node:child_process'),...await import(input.module??input.checkpointModule),...await import(input.evidence??input.evidenceModule),loadExtensions,hash:data=>require('node:crypto').createHash('sha256').update(data).digest('hex')},${registeredCheckpoint.toString()});
          send({value});
        } catch(error) {
          if(process.connected)send({error:String(error.stack??error)});
          else {console.error(error);process.exitCode=1;}
        }
        finally {process.chdir(cwd);if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior;}
      });
      send({ready:true});
    })().catch(error=>{console.error(error);process.exitCode=1;disconnect();});
  `], { cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: path.join(nativeCheckpointRoot, "agent"),
    NODE_COMPILE_CACHE: path.join(nativeCheckpointRoot, "compile-cache") }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  nativeCheckpoint = child;
  let output = "", errors = "";
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { errors += chunk; });
  child.on("error", error => { errors += String(error.stack ?? error); });
  child.on("message", (message: any) => {
    if (message.ready) ready();
    else {
      const reply = nativeCheckpointReply;
      nativeCheckpointReply = undefined;
      reply?.([message.error ? 1 : 0, JSON.stringify(message.value), message.error ?? ""]);
    }
  });
  nativeCheckpointExit = new Promise(resolve => child.once("close", (code, signal) => {
    nativeCheckpoint = undefined;
    const exit = code ?? (signal ? 128 + osConstants.signals[signal] : 1);
    // Closing without a response is not a successful case, even with exit 0.
    nativeCheckpointReply?.([exit || 1, output, errors || "Native checkpoint fixture closed before replying"]);
    nativeCheckpointReply = undefined;
    ready();
    resolve([exit, output, errors]);
  }));
  nativeCheckpointExits.push({ promise: nativeCheckpointExit, cancelled: false });
  await started;
  expect(nativeCheckpoint, errors).toBeDefined();
}
beforeAll(startNativeCheckpoint);
beforeEach(async () => { if (!nativeCheckpoint) await startNativeCheckpoint(); });
afterAll(async () => {
  if (nativeCheckpoint?.connected) nativeCheckpoint.disconnect();
  for (const operation of nativeCheckpointExits) {
    const [exit, , errors] = await operation.promise;
    expect(exit, errors).toBe(operation.cancelled ? 143 : 0);
    expect(errors).not.toContain("unawaited runs.run launch(es)");
  }
  rmSync(nativeCheckpointRoot, { recursive: true, force: true });
});
function nativeCheckpointCase(input: any, harness: string) {
  if (!nativeCheckpoint || nativeCheckpointReply) throw Error("Native checkpoint fixture unavailable or busy");
  const child = nativeCheckpoint;
  let cancelled = false;
  let resolve!: (value: [number, string, string] | undefined) => void;
  const response = new Promise<[number, string, string] | undefined>(done => { resolve = done; });
  nativeCheckpointReply = value => resolve(cancelled ? undefined : value);
  const operation = nativeCheckpointExits.at(-1)!;
  const cancel = () => {
    if (cancelled || child.exitCode !== null || child.signalCode !== null) return;
    cancelled = true;
    operation.cancelled = true;
    child.kill();
  };
  checkpointCancellations.add(cancel);
  const result = response.then(async value => {
    if (cancelled || !child.connected) await operation.promise; // Joins this child and both streams.
    checkpointCancellations.delete(cancel);
    return cancelled ? undefined : value;
  });
  // Observe the original case continuation, including an abandoned caller.
  workflowSettlements.push(result.then(() => {}, () => {}));
  child.send({input:{...input,agentDir:path.join(path.dirname(input.missionPath),"private-agent")},harness}, error => {
    if (error) resolve(cancelled ? undefined : [1, "", String(error.stack ?? error)]);
  });
  return result;
}

const nativeCheckpointInput = () => ({ root: process.cwd(), missionPath: path.join(nativeCheckpointRoot, "mission.json"),
  module: new URL("../extensions/execute-checkpoint.ts", import.meta.url).href,
  evidence: new URL("../extensions/spec-plans.ts", import.meta.url).href });

test("native checkpoint fixture cancellation joins process, streams and case continuation", async () => {
  const pending = nativeCheckpointCase(nativeCheckpointInput(), "async () => new Promise(() => {})");
  const cancel = [...checkpointCancellations][0]!;
  cancel(); cancel();
  await settleWorkflows();
  expect(await pending).toBeUndefined();
  expect(nativeCheckpoint).toBeUndefined();
  expect((await nativeCheckpointExits.at(-1)!.promise)[0]).toBe(143);
  cancel(); // Already closed: no new signal or disposal.
});

test("native checkpoint fixture cancellation after IPC disconnect joins late continuation and streams", async () => {
  const child = nativeCheckpoint!;
  const disconnected = new Promise<void>(resolve => child.once("disconnect", resolve));
  const pending = nativeCheckpointCase(nativeCheckpointInput(), `async () => {
    // Keep the disconnected process alive until the controlled cancellation, not a sleep.
    const keepAlive = setInterval(() => {}, 60000);
    process.disconnect();
    await new Promise(resolve => process.once('SIGTERM', resolve));
    clearInterval(keepAlive);
    process.stdout.write('settled stdout');
    process.stderr.write('settled stderr');
    return 'must not become a successful cancelled case';
  }`);
  let finished = false;
  const continuation = pending.then(value => { finished = true; return value; });
  await disconnected;
  expect(child.connected).toBe(false);
  expect(finished).toBe(false);
  expect(existsSync(nativeCheckpointRoot)).toBe(true);
  const cancel = [...checkpointCancellations][0]!;
  cancel(); cancel();
  await settleWorkflows();
  expect(await continuation).toBeUndefined();
  expect(finished).toBe(true);
  expect(nativeCheckpoint).toBeUndefined();
  const [exit, output, errors] = await nativeCheckpointExits.at(-1)!.promise;
  expect(exit, errors).toBe(143);
  expect(output).toContain("settled stdout");
  expect(errors).toContain("settled stderr");
  expect(errors).not.toContain("ERR_IPC_DISCONNECTED");
  expect(checkpointCancellations.size).toBe(0);
  expect(existsSync(nativeCheckpointRoot)).toBe(true);
  cancel();
  await startNativeCheckpoint();
  expect(await nativeCheckpointCase(nativeCheckpointInput(), "async () => 'fresh case'"))
    .toEqual([0, JSON.stringify("fresh case"), ""]);
});

test("native checkpoint fixture preserves genuine failure and subsequent normal completion", async () => {
  const failure = await nativeCheckpointCase(nativeCheckpointInput(), "async () => { throw Error('controlled case failure'); }");
  expect(failure?.[0]).toBe(1);
  expect(failure?.[2]).toContain("controlled case failure");
  expect(await nativeCheckpointCase(nativeCheckpointInput(), "async () => 'completed'"))
    .toEqual([0, JSON.stringify("completed"), ""]);
});

test("native checkpoint fixture close without a reply is not a successful case", async () => {
  const outcome = await nativeCheckpointCase(nativeCheckpointInput(), "async () => { process.disconnect(); return 'lost reply'; }");
  expect(outcome?.[0]).toBe(1);
  expect(outcome?.[2]).toContain("closed before replying");
  expect((await nativeCheckpointExits.at(-1)!.promise)[0]).toBe(0);
  expect(nativeCheckpoint).toBeUndefined();
});

const checkout = { head: "a".repeat(40), fingerprint: "b".repeat(64) };

describe("plan/execute packaged composition", () => {
  // Rejects treating an intention, a sealed-but-unadmitted file, or a pause as
  // completed progress. Continuation also rejects pre-unit rollback, dispatch-only
  // "success", answer reuse after a later Stop, lost admission and duplicate writers.
  // These execute registered code and real writer bytes in Node.
  function checkpointScenario(mode: string) {
      const work = (async () => {
      const root = repository(), nativeRoot = repository(), sessionId = randomUUID();
      const missionPath = path.join(nativeRoot, "mission.json");
      const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
      mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
      writeFileSync(path.join(root, ".pitako/plans/assignment.md"), content);
      writeFileSync(path.join(root, "owned"), "previous uncommitted WIP");
      writeFileSync(path.join(root, "unrelated"), "unrelated WIP");
      const hooks = new Map<string, any>();
      planExecute({ on: (name: string, hook: any) => hooks.set(name, hook) } as unknown as ExtensionAPI);
      const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
      const prior = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = path.join(nativeRoot, "private-agent");
      try { hooks.get("session_start")({}, ctx); }
      finally { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; }
      disposers.push(() => hooks.get("session_shutdown")({}, ctx));
      const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath };
      expect(hooks.get("tool_call")({ toolName: "subagent", input: { workflow: "pitako.execute", cwd: root, args, options: { missionId: args.missionId } } }, ctx)).toBeUndefined();
      const resource = resolveWorkflowResource("pitako.execute", args, sessionId);
      if (!resource.ok) throw Error(resource.error);
      const permit = consumeWorkflowResourcePermit(resource.resource.permit, resource.resource.script);
      if (typeof permit === "string") throw Error(permit);
      const continuationResource = resolveWorkflowResource("pitako.execute", { ...args, unblock: true,
        resolution: { loop: 1, text: "Continue the cooperative pause from its saved pending work" } }, sessionId);
      if (!continuationResource.ok) throw Error(continuationResource.error);
      const laterResource = resolveWorkflowResource("pitako.execute", { ...args, unblock: true,
        resolution: { loop: 1, text: "New human continuation after the recorded Stop" } }, sessionId);
      if (!laterResource.ok) throw Error(laterResource.error);
      const input = { mode, root, missionPath, script: resource.resource.script,
        continuationScript: continuationResource.resource.script, laterScript: laterResource.resource.script,
        metadata: { root, commonDir: path.join(root, ".git"), selected: { source: path.join(root, ".pitako/plans/assignment.md"), digest: digest(content) } },
        module: new URL("../extensions/execute-checkpoint.ts", import.meta.url).href,
        toolModule: path.resolve("extensions/checkpoint-create.ts"),
        loaderModule: new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url).href,
        evidence: new URL("../extensions/spec-plans.ts", import.meta.url).href };
      const harness = async (input: any, run: typeof runWorkflowScript, response: typeof childResponse, io: any, loadCheckpoint: typeof registeredCheckpoint) => {
        const storage = new Map<string, any>(), originals = new Map<string, any>(), calls: string[] = [], snapshots: any[] = [], points: any[] = [];
        const hostObservations: any[] = [];
        let recoveryReplay = false;
        let pauseAdmissionCut = false;
        let cut = false, sealError = "", continuing = false, laterContinuing = false, baseline = "", partialRef = "";
        const pauseMode = input.mode.startsWith("pause-");
        const lossReentry = input.mode.endsWith("loss-reentry");
        const retainedPauseGap = ["pause-missing-evidence-loss-reentry", "pause-missing-authority-loss-reentry", "pause-conflicting-authority-loss-reentry"].includes(input.mode);
        const restorationAdmissions: any[] = [];
        let retainedPauseOperation: any;
        let secondPause: any;
        const unitMode = input.mode.startsWith("unit-before-capture");
        const stateCut = (value: any) => {
          if (!continuing || cut) return false;
          const l = value.loops?.[0];
          return (input.mode === "pause-input-cut" && l?.resolutions?.at(-1)?.stage === "intention") ||
            (input.mode === "pause-intention-cut" && l?.attempt?.restore?.undispatched) ||
            (input.mode === "pause-result-cut" && l?.attempt?.number === 2 && l.attempt.stage === "result") ||
            (input.mode === "pause-cursor-cut" && l?.cursor === 2);
        };
        const candidate = () => { const { head, fingerprint } = io.checkoutEvidence(input.root); return { head, fingerprint }; };
        const state = { get: (key: string) => structuredClone(storage.get(key)), set: (key: string, value: any) => {
          const checkpoint = value.loops?.[0]?.confirmedCheckpoint;
          const admission = checkpoint?.taskId === "second";
          if (!cut && input.mode === "admission-cut" && admission) { cut = true; throw Error("Before checkpoint admission save"); }
          if (continuing && !cut && ((input.mode === "pause-result-save-before" && value.loops?.[0]?.attempt?.number === 2 && value.loops[0].attempt.stage === "result") ||
              (input.mode === "pause-intention-save-before" && value.loops?.[0]?.attempt?.restore?.undispatched))) {
            cut = true; throw Error("Controlled pause before essential save");
          }
          storage.set(key, structuredClone(value)); io.writeFileSync(input.missionPath, JSON.stringify(Object.fromEntries(storage))); // Only the admission/cursor ordering projection is observed below;
          // retain full native state in storage/on disk, not in every IPC snapshot.
          snapshots.push({ loops: value.loops?.map((loop: any) => ({ cursor: loop.cursor,
            results: loop.results?.map(({ taskId, status }: any) => ({ taskId, status })) })) });
          if (!pauseAdmissionCut && input.mode.includes("status-") && input.mode.endsWith("admission-cut") && value.loops?.[0]?.attempt?.stage === "result" && value.loops[0].attempt.taskId === "second") {
            pauseAdmissionCut = true; throw Error("Cut after durable pause admission before yield");
          }
          if (unitMode && input.mode.endsWith("reentry") && !cut && value.loops?.[0]?.attempt?.restore?.undispatched) { cut = true; throw Error("Cut after durable unit recovery intention"); }
          if (stateCut(value)) { cut = true; throw Error("Controlled pause persistence cut"); }
          if (!cut && input.mode === "cursor-cut" && admission && value.loops[0].attempt?.stage === "result") {
            cut = true; throw Error("After checkpoint admission before cursor advance");
          }
        } };
        const firstTask = (value: any, id: string) => {
          const unit = structuredClone(value.tasks[0]);
          Object.assign(unit, { id, kind: "implementation", scope: ["owned"], allowedEffects: ["edit owned"] });
          unit.checks[0].id = id + "-check"; return unit;
        };
        const options = { script: input.script, state,
          status: async (key: string) => {
            if (continuing && input.mode === "pause-observer-denial")
              throw Error("Blocked by pi-subagents permission rule: observer denied");
            return (originals.get(key)?.structuredOutput?.status === "plan" ||
              (recoveryReplay && input.mode === "pause-reusable-result" && originals.has(key))) ? structuredClone(originals.get(key)) : ({ key, ok: true,
            ...(continuing && !laterContinuing && ["pause-stop", "pause-later-input"].includes(input.mode) ? { stopped: true } : {}),
            ...(continuing && input.mode === "pause-permission" ? { error: "Blocked by pi-subagents permission rule: current denial" } : {}),
            state: continuing && input.mode === "pause-active" ? "running" : "unknown",
            output: "No current writer observation", artifactPaths: [] });
          },
          host: async (key: string, request: any) => {
            const stdout = io.execFileSync("sh", ["-c", request.command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            const observed = JSON.parse(stdout);
            hostObservations.push({ key, replay: recoveryReplay, checkpoint: observed.checkpointObservation ?? null });
            return { key, kind: "command", state: "passed", ok: true, exitCode: 0,
              stdout, stderr: "", durationMs: 0, outputPath: input.missionPath + ".host.log" };
          },
          launch: async (key: string, request: any) => {
            calls.push(key);
            const pending = storage.get("invoke-human-1")?.loops?.[0];
            if (request.agent === "pitako.worker" && pending?.attempt?.restore)
              restorationAdmissions.push(structuredClone(pending.attempt));
            // Original lifecycle modes isolate confirmation. Pause-continuation modes
            // execute the actual selective restore and pending effects.
            // The controlled native boundary denies a restoration dispatch, so
            // no extra effects occur after its failed/unsealed second unit.
            if (!unitMode && !pauseMode && input.mode !== "abrupt-continue" && request.task?.includes("CHECKPOINT FALLBACK (same pending task"))
              return { key, ok: false, output: "", artifactPaths: [], error: "Blocked by pi-subagents permission rule: restoration denied in lifecycle fixture" };
            // Director/review do not consume a candidate. Modifying workers
            // receive their real identity below, after their owned effects.
            const needsCandidate = key.endsWith(".compliance") || (request.agent === "pitako.worker" && key.includes(".t3."));
            const result = response(key, request, input.metadata, needsCandidate ? candidate() : undefined);
            if (key.endsWith(".director")) {
              result.structuredOutput.association.missionPath = input.missionPath;
              result.structuredOutput.tasks[0].dependsOn = [{ taskId: "second", reason: "Verify the completed pending unit" }];
              result.structuredOutput.tasks.unshift(firstTask(result.structuredOutput, "first"), firstTask(result.structuredOutput, "second"));
              result.structuredOutput.tasks[0].dependsOn = []; result.structuredOutput.tasks[1].dependsOn = [];

            } else if (request.agent === "pitako.worker" && !key.includes(".t3.")) {
              const invocation = storage.get("invoke-human-1"), loop = invocation.loops[0], intent = loop.attempt.checkpoint;
              const second = intent.taskId === "second";
              const checkpoint = await loadCheckpoint(request, input.root, io.loadExtensions, input.toolModule, key).catch((error: unknown) => { console.error(error); throw error; });
              let restoreReceipt: any;
              if (unitMode && second && intent.attempt === 1) {
                if (input.mode.endsWith("missing")) io.unlinkSync(loop.confirmedCheckpoint.checkpointRef);
                if (input.mode.endsWith("unadmitted")) {
                  const point = io.readFileSync(loop.confirmedCheckpoint.checkpointRef, "utf8");
                  const envelope = JSON.parse(point), value = JSON.parse(envelope.data);
                  value.intent.association.invocation = "foreign-unit";
                  // A self-consistent foreign publication is still not the root's
                  // exact admitted bytes. Do not fabricate a replacement receipt.
                  const data = JSON.stringify(value);
                  io.writeFileSync(loop.confirmedCheckpoint.checkpointRef, JSON.stringify({sha256: io.hash(data), data}));
                }
                if (input.mode.endsWith("conflict")) io.writeFileSync(input.root + "/owned", "unattributed edit");
                if (input.mode.endsWith("corrupt")) {
                  if (input.mode.endsWith("newer-corrupt")) {
                    await checkpoint("pre", ["owned"]);
                    io.writeFileSync(input.root + "/.pi/subagents/checkpoints/" + intent.key + "/manifest.json", "corrupt newer manifest");
                  } else io.writeFileSync(loop.confirmedCheckpoint.checkpointRef, "corrupt confirmed seal");
                }
                throw Error("Abrupt disappearance before pre-capture");
              }
              if (loop.attempt.restore) {
                if (unitMode || input.mode === "abrupt-continue") continuing = true;
                if ((lossReentry || ["pause-equivalent-capture", "pause-successor-corrupt"].includes(input.mode)) && !recoveryReplay) {
                  if (!lossReentry) {
                    await checkpoint("pre", ["owned"]);
                    if (input.mode === "pause-successor-corrupt") io.writeFileSync(input.root + "/.pi/subagents/checkpoints/" + intent.key + "/manifest.json", "corrupt successor");
                  }
                  throw Error("Successor disappeared before useful effects");
                }
                if (input.mode === "pause-repeated-loss") {
                  throw Error("Repeated transport disappearance before checkpoint capture");
                }
                const restore = loop.attempt.restore;
                let receipt;
                try { receipt = io.restoreCheckpoint(restore.checkpoint, restore.authority); }
                catch (error) {
                  // A real worker reports its concrete helper impediment, not a
                  // transport disappearance that would invite checkpoint replay.
                  const current = candidate();
                  Object.assign(result.structuredOutput, { taskId: intent.taskId, attempt: intent.attempt,
                    candidate: current, git: { ...result.structuredOutput.git, head: current.head },
                    status: "blocked", diagnosis: String(error), remaining: ["Resolve checkpoint bytes"], checks: [{
                      id: "second-check", command: "bun test affected", cwd: input.root, output: String(error), logPaths: [],
                      result: "not-run", before: current, after: current }] });
                  return result;
                }
                baseline = io.readFileSync(input.root + "/owned", "utf8");
                partialRef = receipt.partialRef;
                restoreReceipt = { ...receipt, restoredRef: receipt.partialRef.replace(/restore\.json$/, "restored.json") };
                if (input.mode === "pause-wrong-baseline") delete restoreReceipt.confirmedPause;
                if (input.mode === "unit-before-capture-wrong-baseline") delete restoreReceipt.confirmedUnit;
                if (input.mode === "pause-repeated-publication") throw Error("Disappeared after the same durable restoration publication");
                if (input.mode === "pause-effect-cut" && !cut) { cut = true; throw Error("Cut after actual pause restoration"); }
              }
              await checkpoint("pre", unitMode && !second ? ["owned", "created"] : ["owned"]);
              const manifestPath = input.root + "/.pi/subagents/checkpoints/" + intent.key + "/manifest.json";
              const before = JSON.parse(JSON.parse(io.readFileSync(manifestPath, "utf8")).data);
              const bytes = second && input.mode === "pause-twice" && intent.attempt === 2 ? "new pending pause work" : second ? (continuing ? "completed pending work from pause" : "partial next-unit WIP") : "confirmed first work";
              const changes = [{ path: "owned", image: { bytes: Buffer.from(bytes).toString("base64"), mode: 420 } }];
              if (unitMode && !second) changes.push({ path: "created", image: { bytes: Buffer.from("created by confirmed unit").toString("base64"), mode: 420 } });
              io.applyCheckpoint(intent, changes);
              if (continuing && input.mode === "pause-write-cut" && !cut) { cut = true; throw Error("Cut after unconfirmed post-pause write"); }
              if (second && (input.mode === "abrupt" || input.mode === "abrupt-continue" && intent.attempt === 1)) throw Error("Abrupt transport disappearance after partial write");
              if (second && input.mode === "missing") io.unlinkSync(manifestPath);
              if (second && input.mode === "corrupt") io.writeFileSync(manifestPath, "{broken");
              if (second && input.mode === "incomplete") io.prepareCheckpoint(intent, [{ path: "owned", image: { bytes: Buffer.from("not yet written").toString("base64"), mode: 420 } }]);
              let receipt: any;
              const kind = second && (input.mode === "pause" || pauseMode) && (!continuing || input.mode === "pause-twice" && intent.attempt === 2) ? "pause" : "unit";
              const stop = new AbortController();
              if (second && input.mode === "refused") stop.abort(new Error("Native control refuses checkpoint capture"));
              const stateBeforeSeal = io.readFileSync(input.missionPath, "utf8");
              try { receipt = (await checkpoint(kind, undefined, stop.signal)).checkpointReceipt; }
              catch (error) { sealError = String(error); throw error; }
              // Replay is a tool guarantee, not extra setup for every recovery cut.
              // The complete/pause cases exercise actual unit and pause replay;
              // other modes retain one real publication per reached boundary.
              if (["complete", "pause"].includes(input.mode) &&
                  JSON.stringify((await checkpoint(kind)).checkpointReceipt) !== JSON.stringify(receipt))
                throw Error("Non-idempotent tool replay");
              if (io.readFileSync(input.missionPath, "utf8") !== stateBeforeSeal) throw Error("Tool changed admission/cursor state");
              points.push({ receipt, before, point: JSON.parse(JSON.parse(io.readFileSync(receipt.checkpointRef, "utf8")).data) });
              if (second && input.mode === "seal-cut") throw Error("Abrupt cut after seal before returning result");
              // No checkout effects follow the registered seal. Reuse its real
              // identity instead of hashing the same bytes again; native mission
              // persistence is outside checkoutEvidence's candidate inventory.
              const current = receipt.candidate;
              Object.assign(result.structuredOutput, { taskId: intent.taskId, attempt: intent.attempt,
                status: kind === "pause" ? (input.mode.includes("status-continue") || input.mode === "pause-twice" && intent.attempt === 2 ? "continue" : input.mode.includes("status-gaps") ? "gaps" : "blocked") : "complete", remaining: kind === "pause" && input.mode !== "pause-empty" ? ["Pending second unit"] : [],
                continuation: kind === "pause" ? "Resume pending second unit from its exact pause" : null,
                checkpointReceipt: receipt, ...(restoreReceipt ? { restoreReceipt } : {}), candidate: current,
                git: { head: current.head, checkpoints: [receipt.checkpointRef, ...(restoreReceipt ? [restoreReceipt.partialRef, restoreReceipt.restoredRef] : [])], wip: "Real owned WIP" },
                checks: [{ id: intent.taskId + "-check", command: "bun test affected", cwd: input.root,
                  output: "Observed controlled unit", logPaths: [], result: "passed", before: current, after: current }] });
              if (second && (input.mode === "missing-receipt" || input.mode === "pause-semantic")) delete result.structuredOutput.checkpointReceipt;
              if (second && input.mode === "wrong-progress") result.structuredOutput.checkpointReceipt = {
                ...receipt, progress: { ...receipt.progress, consumedLoops: 2 } };
            }
            if (request.agent === "pitako.worker" && key.includes(".t3.") && (unitMode || pauseMode || input.mode === "abrupt-continue")) {
              const l = storage.get("invoke-human-1").loops[0];
              const completed = l.results.find((entry: any) => entry.taskId === "second" && entry.status === "complete");
              if (!completed || io.readFileSync(input.root + "/owned", "utf8") !== "completed pending work from pause" ||
                  !request.task.includes(completed.ref.key)) throw Error("Final verification preceded durable pending-work admission");
            }
            originals.set(result.runId, structuredClone(result));
            if (input.mode === "pause-reusable-result" && continuing && key.endsWith(".t2.a2")) {
              originals.set(key, structuredClone(result));
              throw Error("Transport disappeared after the complete result survived");
            }
            return result;
          },
        };
        const result = await run(options as any);
        const original = structuredClone(storage.get("invoke-human-1"));
        const callsAtYield = [...calls];
        let unitReplay: any;
        if (unitMode && input.mode.endsWith("reentry")) {
          recoveryReplay = true; unitReplay = await run(options as any);
        }
        let noInputReplay: any;
        if (input.mode.includes("status-")) {
          const replayed = await run(options as any);
          noInputReplay = { result: replayed.value, calls: [...calls], cursor: storage.get("invoke-human-1").loops[0].cursor };
        }
        let resumed: any;
        if (pauseMode) {
          const checkpoint = original.loops[0].confirmedCheckpoint;
          if (input.mode === "pause-missing") io.unlinkSync(checkpoint.checkpointRef);
          if (input.mode === "pause-corrupt") io.writeFileSync(checkpoint.checkpointRef, "corrupt pause");
          if (input.mode === "pause-conflict") io.writeFileSync(input.root + "/owned", "unattributed edit");
          continuing = true;
          // No-input must remain pending; the other routes use the registered current input.
          resumed = await run({ ...options, script: input.mode === "pause-no-input" ? input.script : input.continuationScript } as any);
          if (input.mode === "pause-later-input") { laterContinuing = true; resumed = await run({ ...options, script: input.laterScript } as any); }
          if (input.mode === "pause-twice") {
            secondPause = { result: resumed.value, retained: structuredClone(storage.get("invoke-human-1")), calls: [...calls] };
            resumed = await run({ ...options, script: input.laterScript } as any);
          }
          if (retainedPauseGap) {
            // Seed only a private old-contract retained record after the lost
            // dispatch settles. Never rewrite a real mission or infer its
            // missing baseline from artifacts that become observable later.
            const retained = storage.get("invoke-human-1");
            retained.loops[0].attempt.restore.evidence = null;
            if (input.mode === "pause-missing-authority-loss-reentry") delete retained.loops[0].attempt.restore.authority.confirmedPause;
            if (input.mode === "pause-conflicting-authority-loss-reentry") retained.loops[0].attempt.restore.authority.confirmedPause.digest = "0".repeat(64);
            state.set("invoke-human-1", retained);
            retainedPauseOperation = structuredClone(retained.loops[0].attempt);
          }
          if (cut || lossReentry || ["pause-observer-denial", "pause-replay-complete", "pause-repeated-loss", "pause-loss-reentry", "pause-equivalent-capture", "pause-successor-corrupt", "pause-repeated-publication", "pause-reusable-result"].includes(input.mode)) {
            recoveryReplay = true;
            // Three reentries cover discovery of a successor/publication, the
            // resulting exhausted bound, and another unchanged-evidence replay.
            // More identical entries only repeat expensive native inspections.
            for (let reentry = 0; reentry < ((lossReentry || ["pause-repeated-loss", "pause-equivalent-capture", "pause-repeated-publication"].includes(input.mode)) ? 3 : 1); reentry++)
              resumed = await run(options as any);
          }
        }
        return { secondPause, retainedPauseOperation, restorationAdmissions, unitReplay: unitReplay?.value, created: unitMode ? io.readFileSync(input.root + "/created", "utf8") : null, noInputReplay, callsAtYield, hostObservations, resumed: resumed?.value, original, baseline, partialRef, result: result.value, retained: storage.get("invoke-human-1"), calls, snapshots, points: points.filter(point => point.point.intent.loop === 1), sealError,
          owned: io.readFileSync(input.root + "/owned", "utf8"), unrelated: io.readFileSync(input.root + "/unrelated", "utf8") };
      };
      const observation = await nativeCheckpointCase(input, harness.toString());
      if (!observation) return; // Runner teardown cancelled and joined this case.
      const [exit, output, errors] = observation;
      {
        expect(exit, errors).toBe(0); expect(errors).not.toContain("unawaited runs.run launch(es)");
        const actual = JSON.parse(output); expect(actual.retained?.loops, JSON.stringify(actual)).toBeDefined(); const loop = actual.retained.loops[0];
        if (mode.startsWith("unit-before-capture")) {
          const success = !["conflict", "corrupt", "missing", "unadmitted", "wrong-baseline"].some(suffix => mode.endsWith(suffix));
          expect((actual.unitReplay ?? actual.result).status, JSON.stringify(actual)).toBe(success ? "complete" : "blocked");
          expect(loop.results.filter((r: any) => r.taskId === "first" && r.status === "complete")).toHaveLength(1);
          expect(actual.created).toBe("created by confirmed unit");
          expect(actual.unrelated).toBe("unrelated WIP");
          expect(actual.retained.loops).toHaveLength(1);
          expect(actual.retained.association.maxCycles).toBe(3);
          expect(actual.calls.filter((key: string) => key.endsWith(".t1.a1"))).toHaveLength(1);
          if (success) {
            expect(actual.baseline).toBe("confirmed first work");
            expect(actual.owned).toBe("completed pending work from pause");
            const receipt = loop.results.find((r: any) => r.taskId === "second").restore.receipt;
            expect(receipt.position).toEqual({loop: 1, cursor: 1, phase: "implementation"});
            expect(receipt.confirmedUnit).toEqual({checkpointRef: actual.points[0].receipt.checkpointRef, digest: actual.points[0].receipt.digest});
            expect(receipt.checkpointRef).toBe(actual.points[0].receipt.checkpointRef.replace(/unit.json$/, "manifest.json"));
            expect(loop.cursor).toBe(3);
            for (const suffix of [".t2.a1", ".t2.a2", ".t3.a1", ".compliance"])
              expect(actual.calls.filter((key: string) => key.endsWith(suffix))).toHaveLength(1);
            expect(actual.points).toHaveLength(2);
            expect(loop.results[0].checkpoint.confirmation).toEqual(actual.points[0].receipt);
            expect(existsSync(actual.points[0].receipt.checkpointRef.replace(/t1\.a1\/unit\.json$/, "t2.a1/manifest.json"))).toBe(false);
            const partial = JSON.parse(JSON.parse(readFileSync(receipt.partialRef, "utf8")).data);
            expect(Buffer.from(partial.partial[0].image.bytes, "base64").toString()).toBe("confirmed first work");
            if (mode.endsWith("reentry")) expect(actual.hostObservations.some((o: any) => o.replay && o.checkpoint?.evidence), JSON.stringify(actual.hostObservations)).toBe(true);
          } else {
            expect(loop.cursor).toBe(1);
            expect(actual.calls).not.toContain("invoke-human-1.l1.t3.a1");
            expect(actual.owned).toBe(mode.endsWith("conflict") ? "unattributed edit" : mode.endsWith("wrong-baseline") ? "completed pending work from pause" : "confirmed first work");
          }
          return;
        }
        if (mode === "abrupt-continue") {
          expect(actual.result).toMatchObject({ status: "complete", loopsConsumed: 1 });
          expect(actual.baseline).toBe("confirmed first work");
          expect(actual.owned).toBe("completed pending work from pause");
          expect(actual.unrelated).toBe("unrelated WIP");
          const partial = JSON.parse(JSON.parse(readFileSync(actual.partialRef, "utf8")).data);
          expect(Buffer.from(partial.partial[0].image.bytes, "base64").toString()).toBe("partial next-unit WIP");
          expect(loop.results.filter((entry: any) => entry.taskId === "first" && entry.status === "complete")).toHaveLength(1);
          expect(loop.results.find((entry: any) => entry.taskId === "second")).toMatchObject({ status: "complete", attempt: 2 });
          expect(loop.cursor).toBe(3);
          expect(loop.confirmedCheckpoint).toMatchObject({ taskId: "second", attempt: 2 });
          for (const suffix of [".t1.a1", ".t2.a1", ".t2.a2", ".t3.a1", ".review.director-synthesis", ".compliance"])
            expect(actual.calls.filter((key: string) => key.endsWith(suffix))).toHaveLength(1);
          expect(actual.points).toHaveLength(2); // No post-cut seal for the interrupted attempt.
          return;
        }
        if (mode.startsWith("pause-")) {
          const originalLoop = actual.original.loops[0];
          if (mode === "pause-twice") {
            const paused = actual.secondPause.retained.loops[0];
            expect(actual.secondPause.result.status).toBe("blocked");
            expect(paused.cursor).toBe(1);
            expect(paused.results.map((r: any) => r.status)).toEqual(["complete", "blocked", "continue"]);
            expect(paused.confirmedCheckpoint).toMatchObject(paused.results[2].checkpoint.confirmation);
            expect(actual.secondPause.calls).not.toContain("invoke-human-1.l1.t3.a1");
            expect(actual.resumed.status, JSON.stringify(actual.resumed)).toBe("complete");
            expect(loop.cursor).toBe(3);
            expect(loop.results.slice(0, 3)).toEqual(paused.results);
            expect(actual.retained.association).toEqual(actual.original.association);
            expect(actual.retained.loops).toHaveLength(1);
            expect(actual.restorationAdmissions).toHaveLength(2);
            for (const [index, admission] of actual.restorationAdmissions.entries()) {
              expect(admission.restore.evidence).toMatch(/^[a-f0-9]{64}$/);
              expect(admission.restore.authority.confirmedPause).toEqual(paused.results[index + 1].checkpoint.confirmation);
            }
            expect(actual.restorationAdmissions[0].restore.evidence).not.toBe(actual.restorationAdmissions[1].restore.evidence);
            const completed = loop.results.find((r: any) => r.taskId === "second" && r.status === "complete");
            const pause = paused.results[2].checkpoint.confirmation;
            expect(completed.restore.receipt.confirmedPause).toEqual({ checkpointRef: pause.checkpointRef, digest: pause.digest });
            expect(actual.baseline).toBe("new pending pause work");
            expect(actual.owned).toBe("completed pending work from pause");
            expect(actual.unrelated).toBe("unrelated WIP");
            expect(actual.calls.filter((key: string) => /\.t2\.a[2-9]/.test(key))).toHaveLength(2);
            expect(actual.calls).toContain("invoke-human-1.l1.t3.a1");
            expect(actual.calls).toContain("invoke-human-1.l1.compliance");
            return;
          }
          if (mode.includes("status-")) {
            const status = mode.includes("status-continue") ? "continue" : "gaps";
            expect(originalLoop.cursor).toBe(1);
            expect(originalLoop.results).toHaveLength(2);
            expect(originalLoop.results[1].status).toBe(status);
            expect(originalLoop.confirmedCheckpoint).toMatchObject({ kind: "pause", position: { cursor: 1 }, resultRef: originalLoop.results[1].ref });
            expect(originalLoop.confirmedCheckpoint).toMatchObject(originalLoop.results[1].checkpoint.confirmation);
            expect(actual.result.status).toBe("blocked");
            expect(actual.noInputReplay.result.status).toBe("blocked");
            expect(actual.noInputReplay.cursor).toBe(1);
            expect(actual.noInputReplay.calls).toEqual(actual.callsAtYield);
            expect(actual.callsAtYield).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t2.a1"]);
            expect(loop.results.filter((r: any) => r.taskId === "second" && r.status === status)).toHaveLength(1);
            const pause = originalLoop.confirmedCheckpoint;
            expect(createHash("sha256").update(readFileSync(pause.checkpointRef)).digest("hex")).toBe(pause.digest);
            const completed = loop.results.find((r: any) => r.taskId === "second" && r.status === "complete");
            if (!mode.endsWith("loss-reentry"))
              expect(completed.restore.receipt.confirmedPause).toEqual({ checkpointRef: pause.checkpointRef, digest: pause.digest });
          }
          expect(actual.retained.association).toEqual(actual.original.association);
          expect(actual.retained.loops).toHaveLength(1);
          expect(loop.results[0]).toEqual(originalLoop.results[0]);
          expect(loop.results[1]).toEqual(originalLoop.results[1]);
          expect(actual.unrelated).toBe("unrelated WIP");
          expect(actual.calls.filter((key: string) => key.endsWith(".t1.a1"))).toHaveLength(1);
          expect(actual.calls.filter((key: string) => key.endsWith(".t2.a1"))).toHaveLength(1);
          expect(new Set(actual.calls).size).toBe(actual.calls.length);
          expect(actual.calls.some((key: string) => key.includes(".recover"))).toBe(false);
          expect(actual.resumed.loopsConsumed).toBe(1);
          expect(loop.plan.ref).toEqual(originalLoop.plan.ref);
          expect(loop.manifest).toEqual(originalLoop.manifest);
          // Rejects per-process bounds, equivalent-capture renewal and treating
          // repeated idempotent restoration publication as fresh material progress.
          if (mode.endsWith("loss-reentry") || ["pause-repeated-loss", "pause-equivalent-capture", "pause-repeated-publication"].includes(mode)) {
            expect(actual.resumed.status).not.toBe("complete");
            expect(actual.calls.filter((key: string) => /\.t2\.a[2-9]/.test(key)),
              "Unchanged evidence must not renew restoration across supported script reentries").toHaveLength(mode === "pause-repeated-publication" ? 2 : 1);
            const observed = actual.hostObservations.filter((entry: any) => entry.checkpoint);
            expect(observed).toHaveLength(mode.includes("status-") ? 5 : 4);
            // Both terminal reentries see exactly the same exhausted evidence
            // and successor. A process-local bound would dispatch again here.
            expect(observed.at(-1).checkpoint).toEqual(observed.at(-2).checkpoint);
            expect(new Set(observed.map((entry: any) => entry.checkpoint.evidence)).size).toBe(mode === "pause-repeated-publication" ? 2 : 1);
            expect(new Set(observed.map((entry: any) => entry.checkpoint.attempt)).size).toBe(mode === "pause-repeated-publication" ? 3 : 2);
            expect(loop.attempt.restore.evidence).toBe(actual.retainedPauseOperation ? null : observed.at(-1).checkpoint.evidence);
            if (mode.endsWith("loss-reentry")) {
              // Rejects blocked-only initial observation and null-to-hash renewal,
              // not merely independent pause-status and disappearance tests.
              const initial = observed.find((entry: any) => entry.checkpoint.attempt === 1).checkpoint;
              expect(initial.evidence).toMatch(/^[a-f0-9]{64}$/);
              expect(observed.every((entry: any) => entry.checkpoint.evidence === initial.evidence)).toBe(true);
              expect(actual.restorationAdmissions).toHaveLength(1);
              const admitted = actual.restorationAdmissions[0];
              expect(admitted.restore.evidence).toBe(initial.evidence);
              expect(admitted.restore.authority.confirmedPause).toEqual(originalLoop.results[1].checkpoint.confirmation);
              expect(loop.attempt.restore).toEqual((actual.retainedPauseOperation ?? admitted).restore);
              expect(loop.cursor).toBe(1);
              expect(loop.results).toEqual(originalLoop.results);
              expect(loop.confirmedCheckpoint).toEqual(originalLoop.confirmedCheckpoint);
              expect(loop.interruptions).toHaveLength(1);
              expect(loop.interruptions[0].result).toEqual(originalLoop.results[1]);
              expect(actual.retained.association.maxCycles).toBe(3);
              expect(actual.calls).toEqual([...actual.callsAtYield, "invoke-human-1.l1.t2.a2"]);
            }
            expect(actual.resumed.action.started).toBe(false);
            const replayed = observed.find((entry: any) => entry.replay);
            expect(replayed.checkpoint.attempt).toBe(2);
            expect(replayed.replay).toBe(true);
            expect(actual.resumed.reason).toContain(mode.includes("authority-loss") ? "Confirmed pause conflicts" : "no new checkpoint evidence");
            expect(actual.owned).toBe("partial next-unit WIP");
            expect(actual.calls).not.toContain("invoke-human-1.l1.t3.a1");
            return;
          }
          const blocked = ["pause-no-input", "pause-semantic", "pause-missing", "pause-corrupt", "pause-conflict", "pause-stop", "pause-permission", "pause-active", "pause-empty", "pause-observer-denial", "pause-wrong-baseline", "pause-successor-corrupt"].includes(mode);
          if (blocked) {
            if (mode === "pause-empty") {
              expect(originalLoop.confirmedCheckpoint.taskId).toBe("first");
              expect(originalLoop.results.some((r: any) => r.checkpoint?.confirmation?.kind === "pause")).toBe(false);
            }
            expect(actual.resumed.status, JSON.stringify(actual.resumed)).not.toBe("complete");
            expect(actual.calls).not.toContain("invoke-human-1.l1.t3.a1");
            if (["pause-no-input", "pause-semantic", "pause-stop", "pause-permission", "pause-active", "pause-empty", "pause-observer-denial"].includes(mode))
              expect(actual.calls).not.toContain("invoke-human-1.l1.t2.a2");
            expect(actual.owned).toBe(mode === "pause-conflict" ? "unattributed edit" : mode === "pause-wrong-baseline" ? "completed pending work from pause" : "partial next-unit WIP");
          } else {
            expect(actual.resumed.status, JSON.stringify(actual.resumed)).toBe("complete");
            expect(actual.baseline).toBe("partial next-unit WIP");
            expect(actual.owned).toBe("completed pending work from pause");
            expect(actual.calls).toContain("invoke-human-1.l1.t3.a1");
            expect(actual.calls).toContain("invoke-human-1.l1.review.director-synthesis");
            expect(actual.calls).toContain("invoke-human-1.l1.compliance");
            expect(loop.cursor).toBe(3);
            expect(loop.results.find((entry: any) => entry.taskId === "second" && entry.status === "complete")).toBeDefined();
            const admitted = actual.snapshots.findIndex((state: any) => state.loops?.[0]?.results?.some((entry: any) => entry.taskId === "second" && entry.status === "complete"));
            const advanced = actual.snapshots.findIndex((state: any) => state.loops?.[0]?.cursor === 2);
            expect(admitted).toBeLessThan(advanced);
            const partial = JSON.parse(JSON.parse(readFileSync(actual.partialRef, "utf8")).data);
            expect(partial.partial[0].image.bytes).toBe(Buffer.from(["pause-write-cut", "pause-result-save-before"].includes(mode) ? "completed pending work from pause" : "partial next-unit WIP").toString("base64"));
          }
          if (mode === "pause-successor-corrupt") {
            const observations = actual.hostObservations.filter((entry: any) => entry.checkpoint);
            expect(observations).toHaveLength(2);
            expect(observations[1].checkpoint.error).toContain("corrupt successor");
            expect(actual.calls).not.toContain("invoke-human-1.l1.t2.a3");
          }
          if (mode === "pause-reusable-result") {
            expect(actual.calls.filter((key: string) => /\.t2\.a[2-9]/.test(key))).toHaveLength(1);
            expect(loop.results.find((entry: any) => entry.taskId === "second" && entry.status === "complete").attempt).toBe(2);
          }
          // Each script used its one existing initial read and ordinary close;
          // the real native32-call ceiling and exact registered commands remain.
          expect(actual.hostObservations.filter((entry: any) => entry.key === "inspect-initial")).toHaveLength(
            ["pause-loss-reentry", "pause-equivalent-capture", "pause-successor-corrupt", "pause-replay-complete", "pause-later-input", "pause-observer-denial", "pause-reusable-result"].includes(mode) || (mode.includes("cut") && mode !== "pause-input-cut") || mode.endsWith("save-before") || mode.includes("status-") ? 3 : 2);
          return;
        }
        expect(actual.points[0], JSON.stringify(actual)).toBeDefined();
        expect(actual.points[0].point.files[0].image.bytes).toBe(Buffer.from("confirmed first work").toString("base64"));
        expect(actual.points[0].before.files[0].image.bytes).toBe(Buffer.from("previous uncommitted WIP").toString("base64"));
        expect(actual.unrelated).toBe("unrelated WIP");
        expect(actual.retained.association.maxCycles).toBe(3);
        // Failed/unsealed writes remain pending in the same consumed loop.
        // A restoration denied by the native boundary cannot repeat unit work.
        expect(actual.retained.loops).toHaveLength(1);
        expect(actual.result.loopsConsumed).toBe(actual.retained.loops.length);
        const confirmed = loop.confirmedCheckpoint;
        const secondConfirmed = ["complete", "pause", "cursor-cut"].includes(mode);
        expect(confirmed.taskId).toBe(secondConfirmed ? "second" : "first");
        expect(confirmed).toMatchObject({ kind: mode === "pause" ? "pause" : "unit", position: { loop: 1, cursor: mode === "complete" || mode === "cursor-cut" ? 2 : 1 } });
        const point = JSON.parse(JSON.parse(readFileSync(confirmed.checkpointRef, "utf8")).data);
        expect(point.position).toEqual(confirmed.position); expect(point.progress).toEqual(confirmed.progress);
        expect(createHash("sha256").update(readFileSync(confirmed.checkpointRef)).digest("hex")).toBe(confirmed.digest);
        expect(point.progress.consumedLoops).toBe(1);
        expect(loop.results.find((entry: any) => entry.taskId === confirmed.taskId).ref).toEqual(confirmed.resultRef);
        expect(point.files[0].image.bytes).toBe(Buffer.from(secondConfirmed ? "partial next-unit WIP" : "confirmed first work").toString("base64"));
        if (secondConfirmed) {
          expect(point.progress.admittedResults).toHaveLength(1);
          expect(point.progress.admittedResults[0].ref).toEqual(loop.results[0].ref);
        }
        if (mode === "complete") { expect(actual.result.status).toBe("complete"); expect(actual.calls).toContain("invoke-human-1.l1.compliance"); }
        else expect(actual.calls).not.toContain("invoke-human-1.l1.t3.a1");
        if (["refused", "missing", "corrupt", "incomplete"].includes(mode)) {
          expect(actual.sealError).not.toBe(""); expect(actual.points).toHaveLength(1);
        }
        if (["seal-cut", "admission-cut", "missing-receipt", "wrong-progress"].includes(mode)) expect(actual.points).toHaveLength(2);
        if (mode === "cursor-cut") expect(loop.cursor).toBe(1);
        if (mode === "pause") expect(loop.results[1].status).toBe("blocked");
      }
      })();
      // Bun may abandon the returned test promise on timeout. Own its eventual
      // cancellation rejection as well as the child/stream settlement promise.
      void work.catch(() => {});
      return work;
  }
  for (const mode of ["unit-before-capture", "unit-before-capture-reentry", "unit-before-capture-conflict", "unit-before-capture-corrupt", "unit-before-capture-newer-corrupt", "unit-before-capture-missing", "unit-before-capture-unadmitted", "unit-before-capture-wrong-baseline", "complete", "pause", "abrupt", "abrupt-continue", "refused", "missing", "corrupt", "incomplete", "seal-cut", "admission-cut", "cursor-cut", "missing-receipt", "wrong-progress", "pause-continue", "pause-twice", "pause-status-continue", "pause-status-gaps", "pause-status-continue-admission-cut", "pause-status-gaps-admission-cut", "pause-no-input", "pause-semantic", "pause-missing", "pause-corrupt", "pause-conflict", "pause-stop", "pause-later-input", "pause-permission", "pause-active", "pause-input-cut", "pause-intention-cut", "pause-effect-cut", "pause-result-cut", "pause-cursor-cut", "pause-write-cut", "pause-empty", "pause-observer-denial", "pause-replay-complete", "pause-result-save-before", "pause-intention-save-before", "pause-wrong-baseline", "pause-repeated-loss", "pause-loss-reentry", "pause-status-continue-loss-reentry", "pause-status-gaps-loss-reentry", "pause-missing-evidence-loss-reentry", "pause-missing-authority-loss-reentry", "pause-conflicting-authority-loss-reentry", "pause-equivalent-capture", "pause-successor-corrupt", "pause-repeated-publication", "pause-reusable-result"]) {
    // Explicit human budget calibration for this multi-reentry integration case;
    // the other scenarios retain Bun's existing default deadline.
    test(`registered Node checkpoint lifecycle confirms bytes with progress: ${mode}`,
      () => checkpointScenario(mode), mode === "pause-write-cut" ? 10000 : undefined);
  }

  test.each(["complete", "failure", "cancel"])("checkpoint lifecycle settlement observes exit, streams and continuation: %s", async mode => {
    const root = repository(), marker = path.join(root, "ready");
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const watcher = watch(root, (_event, name) => { if (name === "ready") ready(); });
    const child = Bun.spawn(["node", "-e", `
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
    });
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
      if (mode === "cancel") expect(child.signalCode).toBe("SIGTERM");
      else expect(child.exitCode).toBe(exit);
      expect(checkpointCancellations.size).toBe(0);
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
    const root = repository(), marker = path.join(root, "ready"), finished = path.join(root, "finished");
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const watcher = watch(root, (_event, name) => { if (name === "ready") ready(); });
    const host = `
      const fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(marker)},'ready');
      process.stdin.once('data',()=>{fs.writeFileSync(${JSON.stringify(finished)},'settled host');console.log('host settled');});
    `;
    const child = Bun.spawn(["node", "-e", `
      process.on('SIGTERM',()=>{process.exitCode=143;});
      const output=require('node:child_process').execFileSync('node',['-e',${JSON.stringify(host)}],
        {stdio:['inherit','pipe','pipe'],encoding:'utf8'});
      process.stdout.write(output);process.stderr.write('outer settled');
      setImmediate(()=>{});
    `], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let continuations = 0;
    const lifecycle = checkpointLifecycle(child, () => { continuations++; });
    try {
      await started;
      lifecycle.cancel();
      child.stdin.write("release host"); child.stdin.end();
      expect(await lifecycle.result).toBeUndefined();
      const [exit, stdout, stderr] = await lifecycle.observed;
      await lifecycle.settled;
      expect(exit).toBe(143);
      expect(stdout).toBe("host settled\n"); expect(stderr).toBe("outer settled");
      expect(readFileSync(finished, "utf8")).toBe("settled host");
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


  // Wrong implementations rejected: prompt-only rollback, ignoring current writer
  // barriers, discarding a prior source on dispatch cuts, or restoring a foreign unit.
  test.each(["restored", "missing", "incomplete", "foreign", "conflict", "stop", "permission", "active", "unsettled", "unknown", "unavailable", "inconclusive", "current-stop", "observer-permission", "observer-capacity", "later-stop-input", "intention-cut", "result-cut", "missing-receipt", "stale-producer", "dispatch-intention-cut", "successor-capture-cut", "corrupt-successor", "retained-stop", "retained-permission", "retained-permission-input", "retained-permission-accepted-cut", "retained-stop-input", "retained-stop-input-applied-cut", "retained-unknown", "retained-stop-new-stop", "retained-stop-new-permission", "retained-stop-observer-permission", "retained-stop-observer-permission-accepted-cut", "retained-stop-observer-permission-observed-cut"].map(mode => [mode.startsWith("retained-") ? "retained barrier replay" : "checkpoint fallback actually restores the pending unit", mode]))(
    "registered Node %s: %s", async (_label, mode) => {
      const root = repository(), nativeRoot = repository(), sessionId = randomUUID();
      const missionPath = path.join(nativeRoot, "mission.json");
      const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
      mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
      writeFileSync(path.join(root, ".pitako/plans/assignment.md"), content);
      writeFileSync(path.join(root, "owned"), "prior owned WIP");
      writeFileSync(path.join(root, "earlier"), "earlier independent WIP");
      const hooks = new Map<string, any>();
      planExecute({ on: (name: string, hook: any) => hooks.set(name, hook) } as unknown as ExtensionAPI);
      const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
      const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = path.join(nativeRoot, "private-agent");
      try { hooks.get("session_start")({}, ctx); }
      finally { if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir; }
      disposers.push(() => hooks.get("session_shutdown")({}, ctx));
      const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath };
      expect(hooks.get("tool_call")({ toolName: "subagent", input: { workflow: "pitako.execute", cwd: root, args, options: { missionId: args.missionId } } }, ctx)).toBeUndefined();
      const resource = resolveWorkflowResource("pitako.execute", args, sessionId);
      if (!resource.ok) throw Error(resource.error);
      const permit = consumeWorkflowResourcePermit(resource.resource.permit, resource.resource.script);
      if (typeof permit === "string") throw Error(permit);
      const metadata = { root, commonDir: path.join(root, ".git"), selected: { source: path.join(root, ".pitako/plans/assignment.md"), digest: digest(content) } };
      const input = { mode, root, nativeRoot, missionPath, metadata, script: resource.resource.script,
        toolModule: path.resolve("extensions/checkpoint-create.ts"),
        loaderModule: new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url).href,
        grants: permit.authority.host, checkpointModule: new URL("../extensions/execute-checkpoint.ts", import.meta.url).href, evidenceModule: new URL("../extensions/spec-plans.ts", import.meta.url).href };
      const harness = async (input: any, run: typeof runWorkflowScript, response: typeof childResponse, io: any, loadCheckpoint: typeof registeredCheckpoint) => {
        const storage = new Map<string, any>(), calls: string[] = [], observations: any[] = [];
        let interrupted: any, cut = false, restores = 0, beforeRestore = "", originalManifest = "";
        const retainedMode = input.mode.startsWith("retained-");
        const statusCalls: string[] = [];
        const restoreAuthorities: any[] = [];
        const file = (name: string) => input.root + "/" + name;
        const candidate = () => { const { head, fingerprint } = io.checkoutEvidence(input.root); return { head, fingerprint }; };
        // Load owned functions once in this private Node process. Repeated loader
        // processes add no boundary coverage; registered host inspections stay real.
        const helper = (operation: string, request: any) => JSON.stringify(
          operation === "restore" ? io.restoreCheckpoint(request.intent, request.authority) :
          io.applyCheckpoint(request.intent, request.changes) ?? null);
        const options = { script: input.script,
          state: { get: (key: string) => structuredClone(storage.get(key)), set: (key: string, value: any) => {
            storage.set(key, structuredClone(value));
            io.writeFileSync(input.missionPath, JSON.stringify(Object.fromEntries(storage)));
            if (!cut && (["intention-cut", "stale-producer"].includes(input.mode) && value.loops?.[0]?.attempt?.restore?.undispatched ||
                input.mode === "dispatch-intention-cut" && value.loops?.[0]?.attempt?.restore &&
                  !value.loops[0].attempt.restore.undispatched && !value.loops[0].attempt.launch ||
                input.mode === "query-admission-cut" && value.loops?.[0]?.recoveries?.[0]?.stage === "observed" ||
                input.mode === "result-cut" && value.loops?.[0]?.attempt?.restore && value.loops[0].attempt.stage === "result" ||
                ["retained-permission-accepted-cut", "retained-stop-observer-permission-accepted-cut"].includes(input.mode) && value.loops?.[0]?.resolutions?.[0]?.stage === "accepted" ||
                input.mode === "retained-stop-observer-permission-observed-cut" && value.loops?.[0]?.resolutions?.[0]?.currentBarrier?.cause === "native permission denial" ||
                input.mode === "retained-stop-input-applied-cut" && value.loops?.[0]?.resolutions?.[0]?.stage === "applied" && !value.loops[0].halt)) {
              cut = true; throw Error("Controlled post-save fallback cut");
            }
          } },
          host: async (key: string, request: any) => {
            const stdout = io.execFileSync("sh", ["-c", request.command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            const value = JSON.parse(stdout); if (value.checkpoint) observations.push(value.checkpoint);
            return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout, stderr: "", durationMs: 0, outputPath: input.nativeRoot + "/" + key + ".log" };
          },
          status: async (ref: string) => {
            statusCalls.push(ref);
            if (retainedMode && ref.includes(".t1.a2")) return undefined;
            if (interrupted && [interrupted.key, interrupted.runId].includes(ref)) {
              if (input.mode === "unavailable") throw Error("Public writer observer unavailable");
              if (retainedMode) {
                if (input.mode.startsWith("retained-stop-observer-permission")) throw Error("Blocked by pi-subagents permission rule: status denied during reconciliation.");
                // Management no longer repeating the saved Stop/denial cannot discharge it.
                return undefined;
              }
              if (input.mode === "current-stop") return { ...structuredClone(interrupted), ok: true, state: "stopped", stopped: true };
              if (input.mode === "observer-permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
              if (input.mode === "observer-capacity") throw Error("Active async run capacity exhausted: 1/1 used.");
              if (input.mode === "unknown") return undefined;
              if (input.mode === "inconclusive") return { ok: false, runId: interrupted.runId, output: "Status inconclusive" };
              return input.mode === "stale-producer" && cut ? { ...structuredClone(interrupted), ok: true, state: "running" } : { ...structuredClone(interrupted), ok: true };
            }
            if (input.mode === "dispatch-intention-cut" && ref.includes(".t1.a2")) return undefined;
            if (ref.includes(".recover1")) {
              const entry = observations.find(entry => entry.key === "invoke-human-1.l1.recover1");
              return input.mode === "query-pending" ? { ...entry, structuredOutput: undefined, state: "running" } : structuredClone(entry);
            }
            if (ref.endsWith(".director")) return director(ref);
            if (ref.includes(".t2.a1")) return response("invoke-human-1.l1.t2.a1", { agent: "pitako.worker" }, input.metadata, candidate());
            throw Error("No exact controlled producer " + ref);
          },
          launch: async (key: string, request: any) => {
            calls.push(key);
            if (request.resume && key.includes(".t1.")) throw Error("Non-resumable producer must not be resumed");
            if (key.endsWith(".director")) return director(key);
            if (request.agent === "pitako.execution-inspector") throw Error("Checkpoint recovery must not require an inspector chain");
            // Only final checks/compliance consume the candidate; restored unit
            // results get their actual post-write identity below.
            const needsCandidate = key.endsWith(".compliance") || request.agent === "pitako.worker" && key.includes(".t2.");
            const result = response(key, request, input.metadata, needsCandidate ? candidate() : undefined);
            if (request.agent === "pitako.worker" && key.endsWith(".t1.a1")) {
              const intent = storage.get("invoke-human-1").loops[0].attempt.checkpoint;
              if (input.mode !== "missing") {
                const checkpoint = await loadCheckpoint(request, input.root, io.loadExtensions, input.toolModule, key).catch((error: unknown) => { console.error(error); throw error; });
                const capture = await checkpoint("pre", ["owned"]);
                originalManifest = capture.manifestRef;
                if (input.mode === "incomplete") io.writeFileSync(originalManifest, "{");
                else if (input.mode === "foreign") {
                  const envelope = JSON.parse(io.readFileSync(originalManifest, "utf8"));
                  const value = JSON.parse(envelope.data); value.intent.taskId = "other";
                  const data = JSON.stringify(value); io.writeFileSync(originalManifest, JSON.stringify({ data, sha256: io.hash(data) }));
                } else helper("apply", { intent, changes: [{ path: "owned", image: { bytes: Buffer.from("partial pending work").toString("base64"), mode: 420 } }] });
              }
              if (input.mode === "conflict") io.writeFileSync(file("owned"), "foreign edit");
              interrupted = { ...result, ok: false, interrupted: true, structuredOutput: undefined,
                processTerminal: { version: 1, runId: result.runId, runnerProcessInstanceId: "writer-1", state: "observed", observedAt: 1,
                  resumeDisposition: "unavailable", instances: [{ kind: "pi-writer", processInstanceId: "writer-1", attempt: 1,
                    closeObservedAt: 1, exitCode: 1, signal: null, processTree: { state: input.mode === "unsettled" ? "unknown" : "observed", mechanism: "posix-process-group", pgid: 123, verifiedAt: 1 } }],
                  canonicalSession: { canonicalSessionId: "original", leaseDisposition: "released", freeAtObservation: true } } };
              if (["stop", "later-stop-input"].includes(input.mode) || input.mode.startsWith("retained-stop")) Object.assign(interrupted, { stopped: true });
              if (["unknown", "unavailable", "inconclusive"].includes(input.mode)) delete interrupted.processTerminal;
              if (input.mode === "permission" || input.mode.startsWith("retained-permission")) Object.assign(interrupted, { error: "Blocked by pi-subagents permission rule: 'run' is denied." });
              if (input.mode === "active") Object.assign(interrupted, { state: "running" });
              return structuredClone(interrupted);
            }
            if (request.agent === "pitako.worker" && /\.t1\.a[23]$/.test(key)) {
              const attempt = storage.get("invoke-human-1").loops[0].attempt;
              const restore = attempt.restore;
              if (["retained-stop-new-stop", "retained-stop-new-permission"].includes(input.mode))
                return { ...result, ok: false, structuredOutput: undefined,
                  ...(input.mode.endsWith("new-stop") ? { stopped: true } : { error: "Blocked by pi-subagents permission rule: replacement denied." }) };
              if (!request.task.includes(JSON.stringify(restore))) throw Error("Missing exact fallback delivery");
              beforeRestore = io.readFileSync(file("owned"), "utf8");
              restoreAuthorities.push(structuredClone(restore.authority));
              let restored: any;
              try { restored = JSON.parse(helper("restore", { intent: restore.checkpoint, authority: restore.authority })); }
              catch (error) { return { ...result, ok: true, structuredOutput: { ...result.structuredOutput, taskId: "unit", attempt: attempt.number,
                status: "blocked", diagnosis: "Checkpoint restore not performed: " + String(error), candidate: candidate(),
                git: { head: candidate().head, checkpoints: [], wip: "Foreign bytes retained" } } }; }
              restores++;
              if (io.readFileSync(file("owned"), "utf8") !== "prior owned WIP") throw Error("Earlier WIP not restored");
              // Replay helper before later work is idempotent, and retains original partial bytes.
              helper("restore", { intent: restore.checkpoint, authority: restore.authority });
              const checkpoint = await loadCheckpoint(request, input.root, io.loadExtensions, input.toolModule, key).catch((error: unknown) => { console.error(error); throw error; });
              await checkpoint("pre", ["owned"]);
              if (key.endsWith(".t1.a2") && ["successor-capture-cut", "corrupt-successor"].includes(input.mode)) {
                helper("apply", { intent: attempt.checkpoint, changes: [{ path: "owned", image: { bytes: Buffer.from("partial successor work").toString("base64"), mode: 420 } }] });
                if (input.mode === "corrupt-successor") io.writeFileSync(file(".pi/subagents/checkpoints/" + attempt.key + "/manifest.json"), "{");
                return { ...result, ok: false, interrupted: true, structuredOutput: undefined };
              }
              helper("apply", { intent: attempt.checkpoint, changes: [{ path: "owned", image: { bytes: Buffer.from("finished task").toString("base64"), mode: 420 } }] });
              const checkpointReceipt = (await checkpoint("unit")).checkpointReceipt;
              const current = candidate();
              Object.assign(result.structuredOutput, { taskId: "unit", attempt: attempt.number, candidate: current, checkpointReceipt,
                restoreReceipt: { checkpointRef: restored.checkpointRef, digest: restored.digest,
                  partialRef: restored.partialRef, restoredRef: restored.partialRef.replace("restore.json", "restored.json"),
                  position: restored.position, candidate: { head: restored.candidate.head, fingerprint: restored.candidate.fingerprint } },
                git: { head: current.head, checkpoints: [checkpointReceipt.checkpointRef, restored.partialRef, restored.checkpointRef, restored.partialRef.replace("restore.json", "restored.json")], wip: "Earlier WIP preserved" } });
              result.structuredOutput.checks = [{ id: "unit-check", command: "bun test affected", cwd: input.root,
                output: "Controlled current check", logPaths: [], result: "passed", before: current, after: current }];
            }
            if (input.mode === "missing-receipt" && key.endsWith(".t1.a2")) delete result.structuredOutput.restoreReceipt;
            return result;
          },
        };
        function director(key: string) {
          const result = response(key.replace(/^native-/, ""), { agent: "pitako.execution-director" }, input.metadata, undefined);
          result.structuredOutput.association.missionPath = input.missionPath;
          const unit = structuredClone(result.structuredOutput.tasks[0]);
          Object.assign(unit, { id: "unit", kind: "implementation", scope: ["owned"], allowedEffects: ["Modify owned pending unit"] });
          unit.checks[0].id = "unit-check"; result.structuredOutput.tasks.unshift(unit);
          return result;
        }
        const first = await run(options as any);
        const firstRetained = structuredClone(storage.get("invoke-human-1"));
        const withInput = input.mode === "later-stop-input" || retainedMode && input.mode !== "retained-stop" && input.mode !== "retained-permission" && input.mode !== "retained-unknown";
        const continuationScript = withInput ? input.script.replace(
          '"checkpointHelper":', '"unblock":true,"resolution":{"loop":1,"text":"Actual later human request to continue from checkpoint"},"checkpointHelper":') : input.script;
        // Native keys cannot be reobserved inside one script. A disappeared
        // restoration successor retains its operation until supported reentry.
        if (["successor-capture-cut", "corrupt-successor"].includes(input.mode) && (first.value as { status: string }).status !== "partial")
          throw Error("Lost restoration did not yield a bounded technical suspension");
        const second = cut || retainedMode || ["later-stop-input", "successor-capture-cut", "corrupt-successor"].includes(input.mode) ? await run({ ...options, script: continuationScript } as any) : null;
        const secondRetained = structuredClone(storage.get("invoke-human-1"));
        const third = retainedMode && (cut || input.mode.includes("-new-") || input.mode.startsWith("retained-stop-observer-permission")) ? await run(options as any) : null;
        return { first: first.value, second: second?.value, third: third?.value, firstRetained, secondRetained, statusCalls, calls, restores, beforeRestore, observations, restoreAuthorities,
          retained: storage.get("invoke-human-1"), owned: io.readFileSync(file("owned"), "utf8"), earlier: io.readFileSync(file("earlier"), "utf8"), originalManifest };
      };
      const observation = await nativeCheckpointCase(input, harness.toString());
      if (!observation) return;
      const [exit, output, errors] = observation;
      {
        expect(exit, errors).toBe(0); expect(errors).not.toContain("unawaited runs.run launch(es)");
        const actual = JSON.parse(output);
        const success = ["restored", "unsettled", "unknown", "unavailable", "inconclusive", "later-stop-input", "intention-cut", "result-cut", "dispatch-intention-cut", "successor-capture-cut", "retained-stop-input", "retained-stop-input-applied-cut", "retained-unknown"].includes(mode);
        expect(actual.third ?? actual.second ?? actual.first).toMatchObject({ status: success ? "complete" : mode === "observer-capacity" ? "partial" : ["stop", "current-stop", "retained-stop", "retained-stop-new-stop"].includes(mode) ? "cancelled" : "blocked", loopsConsumed: 1 });
        expect(actual.earlier).toBe("earlier independent WIP");
        expect(actual.calls.filter((key: string) => key.endsWith(".t1.a1"))).toHaveLength(1);
        expect(actual.calls.filter((key: string) => key.endsWith(".t1.a2"))).toHaveLength(mode === "dispatch-intention-cut" ? 0 : success || ["missing", "incomplete", "foreign", "conflict", "missing-receipt", "corrupt-successor", "retained-stop-new-stop", "retained-stop-new-permission"].includes(mode) ? 1 : 0);
        expect(actual.calls.filter((key: string) => key.endsWith(".t1.a3"))).toHaveLength(["dispatch-intention-cut", "successor-capture-cut"].includes(mode) ? 1 : 0);
        expect(actual.restores).toBe(mode === "successor-capture-cut" ? 2 : success || ["missing-receipt", "corrupt-successor"].includes(mode) ? 1 : 0);
        expect(actual.calls.filter((key: string) => key.includes(".recover") || key.endsWith(".resume"))).toHaveLength(0);
        expect(actual.retained.association.maxCycles).toBe(3);
        for (const authority of actual.restoreAuthorities) {
          expect(authority.activeWriter).toBeNull();
          expect(authority).not.toHaveProperty("settled");
          expect(authority).not.toHaveProperty("continuationUnavailable");
        }
        if (["missing", "incomplete", "foreign"].includes(mode)) {
          expect(actual.owned).toBe("prior owned WIP");
          if (actual.originalManifest) expect(existsSync(actual.originalManifest.replace("manifest.json", "restore.json"))).toBe(false);
        }
        if (success) {
          expect(actual.owned).toBe("finished task");
          expect(actual.beforeRestore).toBe(mode === "successor-capture-cut" ? "partial successor work" : "partial pending work");
          expect(actual.calls).toContain("invoke-human-1.l1.t2.a1"); expect(actual.calls).toContain("invoke-human-1.l1.compliance");
          expect(actual.calls.some((key: string) => key.includes(".review."))).toBe(true);
          const repeat = ["dispatch-intention-cut", "successor-capture-cut"].includes(mode);
          expect(actual.retained.loops[0].interruptions).toHaveLength(repeat ? 2 : 1);
          expect(actual.retained.loops[0].results.map((entry: any) => [entry.taskId, entry.attempt])).toEqual([["unit", repeat ? 3 : 2], ["final", 1]]);
          if (repeat) {
            const restored = actual.retained.loops[0].results[0].restore.receipt;
            expect(restored.checkpointRef).toContain(mode === "dispatch-intention-cut" ? ".t1.a1/manifest.json" : ".t1.a2/manifest.json");
          }
          const partial = JSON.parse(JSON.parse(readFileSync(actual.originalManifest.replace("manifest.json", "restore.json"), "utf8")).data);
          expect(Buffer.from(partial.partial[0].image.bytes, "base64").toString()).toBe("partial pending work");
        } else expect(actual.calls).not.toContain("invoke-human-1.l1.compliance");
        if (mode.startsWith("retained-")) {
          const firstLoop = actual.firstRetained.loops[0], finalLoop = actual.retained.loops[0];
          if (mode !== "retained-unknown") expect(firstLoop.halt).toMatchObject({ code: "native-barrier",
            cause: mode.startsWith("retained-permission") ? "native permission denial" : "stopped" });
          if (!success) {
            expect(actual.owned).toBe("partial pending work");
            expect(finalLoop.cursor).toBe(0); expect(finalLoop.phase).toBe("implementation");
            expect(finalLoop.halt).toMatchObject({ code: "native-barrier", cause:
              mode.includes("permission") ? "native permission denial" : "stopped" });
            expect(actual.calls).not.toContain("invoke-human-1.l1.t2.a1");
            expect(existsSync(actual.originalManifest.replace("manifest.json", "restore.json"))).toBe(false);
          }
          if (mode === "retained-permission-accepted-cut")
            expect(actual.secondRetained.loops[0]).toMatchObject({ halt: { cause: "native permission denial" }, resolutions: [{ stage: "accepted" }] });
          if (mode.includes("-new-") || mode.startsWith("retained-stop-observer-permission"))
            expect(finalLoop.resolutions[0].currentBarrier.cause).toBe(mode.includes("permission") ? "native permission denial" : "stopped");
        }
        if (mode === "conflict") expect(actual.owned).toBe("foreign edit");
        if (mode === "corrupt-successor") expect(actual.owned).toBe("partial successor work");
      }
    });

  test("checkpoint intention persistence failure prevents modifying dispatch", async () => {
    const root = repository();
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
    const metadata = { root, commonDir: path.join(root, ".git"),
      selected: { source: path.join(root, ".pitako/plans/assignment.md"), digest: digest(content), chunks: 1 } };
    const resource = executionResource("linux").resolve({ root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    const storage = new Map<string, any>(), calls: string[] = [];
    const operation = runWorkflowScript({ script: resource.script,
      state: { get: (key: string) => structuredClone(storage.get(key)), set: (key: string, value: any) => {
        if (value.loops?.some((loop: any) => loop.attempt?.checkpoint)) throw Error("checkpoint intention persistence unavailable");
        storage.set(key, structuredClone(value));
      } },
      host: async (key: string) => ({ key, kind: "command" as const, state: "passed" as const, ok: true, exitCode: 0,
        stdout: JSON.stringify(key === "execute-settings" ? { maxCycles: 3 } : key.startsWith("input-")
          ? { digest: metadata.selected.digest, content } : { ...metadata, checkout, admission: { maxCycles: 3 } }),
        stderr: "", durationMs: 0, outputPath: "/controlled/inspection.json" }),
      launch: async (key: string, request: any) => {
        calls.push(key);
        return childResponse(key, request, metadata, checkout);
      },
      status: async () => { throw Error("No status query expected before modifying dispatch"); },
    });
    workflowSettlements.push(operation.then(() => {}, () => {}));
    const result = await operation;
    expect((result.value as any).status).toBe("partial");
    expect((result.value as any).reason).toContain("persistence");
    expect(calls).toEqual(["invoke-human-1.l1.director"]);
    expect(storage.get("invoke-human-1").loops).toHaveLength(1);
  });

  test.each(["missing", "inconclusive", "unavailable", "absent-result", "failed-result"])("registered writer checkpoint-first restoration advances with %s status", async observation => {
    const root = repository(), nativeRoot = repository(), missionPath = path.join(nativeRoot, "mission.json");
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
    mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    const source = path.join(root, ".pitako/plans/assignment.md"); writeFileSync(source, content);
    writeFileSync(path.join(root, "earlier"), "valid earlier WIP");
    writeFileSync(path.join(root, "owned"), "valid prior WIP");
    writeFileSync(path.join(root, "deleted"), "prior deletion target");
    const metadata = { root, commonDir: path.join(root, ".git"), selected: { source, digest: digest(content) } };
    const resource = resourceWithAgentDir(path.join(nativeRoot, "agent")).resolve({
      root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath });
    const grants = new Map(resource.hostCommands.map(grant => [grant.key, grant.command]));
    const storage = new Map<string, any>(), calls: string[] = [];
    let intention: any, checkpointRef = "", beforeRestore: any, restoreReceipt: any;
    const observedCandidate = () => { const { head, fingerprint } = checkoutEvidence(root); return { head, fingerprint }; };
    const helper = path.resolve("skills/execute/checkpoint.mjs"), request = path.join(nativeRoot, "request.json");
    const invoke = (operation: string, data: any) => {
      writeFileSync(request, JSON.stringify(data));
      return execFileSync("node", [helper, operation, request], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };
    const operation = runWorkflowScript({ script: resource.script,
      state: { get: (key: string) => structuredClone(storage.get(key)), set: (key: string, value: any) => { storage.set(key, structuredClone(value)); } },
      status: async key => {
        if (observation === "unavailable") throw Error("Public status unavailable");
        return { key, ok: false, output: observation === "inconclusive" ? "No current writer inventory" : "", artifactPaths: [] };
      },
      host: async (key: string) => ({ key, kind: "command" as const, state: "passed" as const, ok: true, exitCode: 0,
        stdout: execFileSync("sh", ["-c", grants.get(key)!], { cwd: root, encoding: "utf8" }),
        stderr: "", outputPath: path.join(nativeRoot, key + ".log"), durationMs: 0 }),
      launch: async (key: string, request: any) => {
        calls.push(key);
        if (request.agent === "pitako.worker" && request.resume) return { key, ok: false, output: "Controlled native resume unavailable",
          error: "Controlled native resume unavailable", artifactPaths: [] };
        const response = childResponse(key, request, metadata, observedCandidate());
        if (key.endsWith(".director")) {
          response.structuredOutput.association.missionPath = missionPath;
          const unit = structuredClone(response.structuredOutput.tasks[0]);
          Object.assign(unit, { id: "unit", kind: "implementation", scope: ["owned", "deleted", "new"],
            allowedEffects: ["Modify only unit paths"], expectedResult: "Recoverable unit" });
          unit.checks[0].id = "unit-check";
          response.structuredOutput.tasks.unshift(unit);
        }
        if (request.agent === "pitako.worker" && key.includes(".t1.")) {
          const descriptor = JSON.parse(request.task.split("FROZEN ATTEMPT:\n")[1].split("\n")[0]);
          if (descriptor.restore) {
            expect(descriptor.restore.authority.activeWriter).toBeNull();
            restoreReceipt = JSON.parse(invoke("restore", { intent: descriptor.restore.checkpoint, authority: descriptor.restore.authority }));
            expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("valid prior WIP");
            expect(readFileSync(path.join(root, "deleted"), "utf8")).toBe("prior deletion target");
            expect(existsSync(path.join(root, "new"))).toBe(false);
            expect(readFileSync(path.join(root, "earlier"), "utf8")).toBe("valid earlier WIP");
            invoke("capture", { intent: descriptor.checkpoint, paths: ["owned"] });
            invoke("apply", { intent: descriptor.checkpoint, changes: [
              { path: "owned", image: { bytes: Buffer.from("completed pending work").toString("base64"), mode: 420 } },
            ] });
            const checkpointReceipt = JSON.parse(invoke("seal", { intent: descriptor.checkpoint, kind: "unit", controlPermitsCapture: true }));
            const current = observedCandidate();
            Object.assign(response.structuredOutput, { taskId: "unit", attempt: descriptor.number, candidate: current,
              checkpointReceipt, restoreReceipt: { ...restoreReceipt, restoredRef: path.join(path.dirname(restoreReceipt.checkpointRef), "restored.json") },
              git: { head: current.head, checkpoints: [checkpointReceipt.checkpointRef, restoreReceipt.checkpointRef, restoreReceipt.partialRef, path.join(path.dirname(restoreReceipt.checkpointRef), "restored.json")], wip: "Recovered pending work" },
              checks: [{ id: "unit-check", command: "bun test affected", cwd: root, output: "Controlled current check", logPaths: [], result: "passed", before: current, after: current }] });
            return response;
          }
          const stored = structuredClone(storage.get("invoke-human-1"));
          intention = stored.loops[0].attempt.checkpoint;
          expect(intention).toMatchObject({ taskId: "unit", loop: 1, cursor: 0, phase: "implementation" });
          expect(intention.association).toEqual(stored.association);
          expect(request.task).toContain(JSON.stringify(intention));
          expect(request.task).toContain(helper);
          const captured = JSON.parse(invoke("capture", { intent: intention, paths: ["owned", "deleted", "new"] }));
          checkpointRef = path.join(captured.directory, "manifest.json");
          expect(existsSync(checkpointRef)).toBe(true);
          expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("valid prior WIP");
          invoke("apply", { intent: intention, changes: [
            { path: "owned", image: { bytes: Buffer.from("interrupted partial").toString("base64"), mode: 420 } },
            { path: "deleted", image: null },
            { path: "new", image: { bytes: Buffer.from("interrupted new").toString("base64"), mode: 420 } },
          ] });
          beforeRestore = stored;
          // Controlled settled external interruption; no worker result admitted.
          const missingResult = ["absent-result", "failed-result"].includes(observation);
          return { ...response, ok: observation === "absent-result", interrupted: !missingResult, structuredOutput: undefined,
            error: missingResult ? "Controlled unit returned without a complete result" : "controlled interrupted unit" };
        }
        return response;
      },
    });
    workflowSettlements.push(operation.then(() => {}, () => {}));
    const completed = await operation;
    expect((completed.value as any).status, (completed.value as any).reason).toBe("complete");
    expect(calls.filter(key => key.endsWith(".resume"))).toHaveLength(0);
    expect(calls.filter(key => key.includes(".recover"))).toHaveLength(0);
    const persisted = structuredClone(storage.get("invoke-human-1"));
    expect(restoreReceipt.position).toEqual({ loop: 1, cursor: 0, phase: "implementation" });
    expect(restoreReceipt.checkpointRef).toBe(checkpointRef);
    expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("completed pending work");
    expect(readFileSync(path.join(root, "deleted"), "utf8")).toBe("prior deletion target");
    expect(existsSync(path.join(root, "new"))).toBe(false);
    expect(readFileSync(path.join(root, "earlier"), "utf8")).toBe("valid earlier WIP");
    expect(persisted.association).toEqual(beforeRestore.association);
    expect(persisted.loops).toHaveLength(1);
    expect(persisted.loops[0].cursor).toBe(2);
    expect(persisted.loops[0].results.filter((result: any) => result.status === "complete")).toHaveLength(2);
    expect(persisted.loops[0].interruptions[0].checkpoint).toEqual(intention);
    expect(calls.filter(key => /\.t\d+\.a\d+$/.test(key))).toHaveLength(3);
    expect(calls).toContain("invoke-human-1.l1.t2.a1");
    expect(calls).toContain("invoke-human-1.l1.review.director-synthesis");
    expect(calls).toContain("invoke-human-1.l1.compliance");
    expect(resource.hostCommands).toHaveLength(32);
  });

  test.each(["clear", "material-gaps"])("registered Node recovery admits retained rephrased screening: %s", verdict => {
    const operation = recoverFiles(verdict);
    workflowSettlements.push(operation.then(() => {}, () => {}));
    return operation;
  });

  test.each(["native", "file", "pending", "unknown-settlement", "conflict", "missing", "wrong-association"])(
    "registered Node pending recovery reconciles exact retained query: %s", mode => {
      const operation = recoverFiles(`query-${mode}`);
      workflowSettlements.push(operation.then(() => {}, () => {}));
      return operation;
    });

  async function recoverFiles(verdict: string) {
    const query = verdict.startsWith("query-"), queryMode = verdict.slice(6);
    let failQueryAdmission = query;
    let originalPlan: any;
    const root = repository(), nativeRoot = repository(), missionPath = path.join(nativeRoot, "mission.json");
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
    mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    const source = path.join(root, ".pitako/plans/assignment.md");
    writeFileSync(source, content);
    const observedCandidate = () => { const { head, fingerprint } = checkoutEvidence(root); return { head, fingerprint }; };
    const metadata = { root, commonDir: path.join(root, ".git"), selected: { source, digest: digest(content) } };
    const expanded = resourceWithAgentDir(path.join(nativeRoot, "private-agent")).resolve({
      root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath,
    });
    // Exercise the owned loader from its installed node_modules location as
    // well as the registered resolver, without installing dependencies.
    const installed = path.join(nativeRoot, "node_modules/pitako");
    for (const file of ["skills/execute/inspect.mjs", "skills/execute/inspect.ts",
      "extensions/spec-plans.ts", "extensions/execute-retained.ts", "extensions/execute-checkpoint.ts", "extensions/execute-settings.ts",
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
          if (failQueryAdmission && value.loops?.[0]?.recoveries?.[0]?.stage === "observed")
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
          originalPlan = structuredClone(response.structuredOutput);
        }
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
        return { ...response, ...(query && key.endsWith(".director") ? { structuredOutput: undefined } : {}), asyncDir: native, results: [{ structuredOutputPath: file }] };
      },
      status: async (runId: string) => {
        statusCalls.push(runId);
        return { key: runId, runId, ok: true, output: `Run: ${runId}\nState: complete`, artifactPaths: [], results: [] };
      },
      host: async (key: string) => {
        const stdout = execFileSync("sh", ["-c", grants.get(key)!], { cwd: root, encoding: "utf8" });
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
      script: query ? expanded.script : expanded.script.replace(marker, "entry.requirement !== synthesis.dispositions.find(item => item.findingId === entry.findingId).requirement ||") });
    expect(failed.value).toMatchObject({ status: query ? "partial" : "blocked", phase: query ? "director" : "review", loopsConsumed: 1 });
    expect((failed.value as any).reason).toContain(query ? "Essential persistence failed" : "screening contradicts");
    failQueryAdmission = false;
    const before = structuredClone(storage.get("invoke-human-1"));
    if (query) {
      const recovery = storage.get("invoke-human-1").loops[0].recoveries[0];
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
    writeFileSync(missionPath, missionBytes);
    calls.length = 0;
    const compliance = childResponse("invoke-human-1.l1.compliance", { agent: "pitako.reviewer" }, metadata, observedCandidate());
    const next = childResponse("invoke-human-1.l2.director", { agent: "pitako.execution-director" }, metadata, observedCandidate());
    Object.assign(next.structuredOutput, { status: "needs-decision", tasks: [], reason: "Intercept next ordinary director" });
    next.structuredOutput.association.missionPath = missionPath;
    const queryChildren = query ? Object.fromEntries(["t1.a1", "review.director-prepare", "review.independent-a",
      "review.independent-b", "review.director-synthesis", "compliance"].map(phase => {
        const key = `invoke-human-1.l1.${phase}`;
        return [key, childResponse(key, { agent: phase === "t1.a1" ? "pitako.worker" : "pitako.reviewer" }, metadata, observedCandidate())];
      })) : {};
    const child = Bun.spawn(["node", "-e", `(async () => {
      const { readFileSync } = require("node:fs");
      const { execFileSync } = require("node:child_process");
      const { runWorkflowScript } = await import(${JSON.stringify(new URL("../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href)});
      const input = JSON.parse(readFileSync(0, "utf8"));
      const storage = new Map(input.storage), calls = [], statuses = [], bytes = [];
      const options = { script: input.script,
        state: { get: key => structuredClone(storage.get(key)), set: (key, value) => storage.set(key, structuredClone(value)) },
        launch: async key => { calls.push(key); const value = input.children[key]; if (!value) throw Error("Forbidden relaunch: " + key); return value; },
        status: async ref => { statuses.push(ref); return { key: ref, runId: ref, ok: true, output: input.queryMode === "unknown-settlement" ? "Current settlement unavailable" : "Run: " + ref + "\\nState: complete", results: [] }; },
        host: async key => { const stdout = execFileSync("sh", ["-c", input.grants[key]], { cwd: input.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          bytes.push(Buffer.byteLength(stdout));
          return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout, stderr: "", durationMs: 0, outputPath: input.root + "/.pi/subagents/" + key + ".json" }; },
      };
      let old;
      if (["native", "file"].includes(input.queryMode)) {
        old = await runWorkflowScript({ ...options, script: input.script.replace(
          "return retainedReadOnlyOriginal(result, recovery.ref);", "return result;") });
        if (calls.length) throw Error("Old defect launched replacement work");
        storage.clear(); for (const [key, value] of input.storage) storage.set(key, structuredClone(value));
      }
      const result = await runWorkflowScript(options);
      console.log(JSON.stringify({ result, old, storage: [...storage], calls, statuses, bytes }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: root, stdin: new TextEncoder().encode(JSON.stringify({ script: expanded.script, root,
      storage: [...storage], grants: Object.fromEntries(grants), queryMode,
      children: query ? queryChildren : { [compliance.key]: compliance, [next.key]: next } })), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exit).toBe(0);
    const recovered = JSON.parse(stdout);
    if (query) {
      const succeeds = ["native", "file"].includes(queryMode);
      expect(recovered.result.value).toMatchObject({ status: succeeds ? "complete" : "blocked", loopsConsumed: 1, maxLoops: 3 });
      expect(recovered.calls).toEqual(succeeds ? Object.keys(queryChildren) : []);
      expect(recovered.calls.some((key: string) => key.includes(".recover") || key.endsWith(".director"))).toBe(false);
      const after = new Map<string, any>(recovered.storage).get("invoke-human-1");
      expect(after.association).toEqual(before.association);
      expect(after.snapshot).toEqual(before.snapshot);
      expect(after.loops[0].recoveries).toHaveLength(1);
      if (succeeds) {
        expect(recovered.old.value.status).toBe("blocked");
        expect(recovered.old.value.reason).toContain("Recovery settlement/result uncertain");
        expect(after.loops[0].recoveries[0]).toMatchObject({ stage: "observed", disposition: "recovered" });
        expect(after.loops[0].results[0].checks.current).toBe(true);
        expect(after.loops[0].review.verdict).toBe("clear");
        expect(after.loops[0].compliance.status).toBe("fulfilled");
      }
      expect(readFileSync(missionPath, "utf8")).toBe(missionBytes);
      for (const [file, original] of originals) {
        if (queryMode !== "missing") expect(readFileSync(file, "utf8")).toBe(original);
      }
      return;
    }
    expect(recovered.result.value).toMatchObject({ status: verdict === "clear" ? "complete" : "blocked", loopsConsumed: verdict === "clear" ? 1 : 2, maxLoops: 3 });
    expect(recovered.calls).toEqual([verdict === "clear" ? compliance.key : next.key]);
    expect(recovered.statuses).toHaveLength(6);
    expect(recovered.bytes.every((bytes: number) => bytes <= 4096)).toBe(true);
    for (const [key, value] of recovered.storage) storage.set(key, value);
    const after = storage.get("invoke-human-1");
    expect(after.association).toEqual(before.association);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.loops[0].results).toEqual(before.loops[0].results);
    expect(after.loops[0].review).toMatchObject({ status: "completed", verdict });
    expect(readFileSync(missionPath, "utf8")).toBe(missionBytes);
    for (const [file, original] of originals) expect(readFileSync(file, "utf8")).toBe(original);
  }


  // Registered discovery + launch hook + native script runner, not manually
  // pasted workflow bytes. The Node replay uses the same controlled boundaries.
  test.each(["post-input-transport", "post-input-stop", "post-input-permission", "post-input-pending", "post-input-repeat-failure", "automatic-opening", "automatic-capture", "automatic-closing", "automatic-stop", "automatic-pending", "automatic-permission", "automatic-failure", "automatic-intention-cut", "automatic-admission-cut", "automatic-intention-permission", "automatic-intention-pending", "opening-stopped", "opening-failed", "capture", "closing", "decision", "historical-child-stop", "historical-child-permission", "historical-child-unknown", "current-stop", "current-permission", "current-pending",
    "retained-plan-pending", "retained-worker-pending", "retained-operation-pending", "retained-operation-usable",
    "retained-operation-unresolved", "retained-operation-conflict", "retained-operation-persistence"])(
    "registered current resolution continues or preserves a current barrier: %s", async mode => {
      const root = repository(), sessionId = randomUUID();
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
      const interruptedLoop = ["closing", "automatic-closing", "decision"].includes(mode) || historicalChild || retainedRecovery ? 1 : 0;
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
      const content = "COMPLETE SPEC";
      const metadata = { root, commonDir: path.join(root, ".git"), candidates: [],
        selected: { source: `${root}/.pitako/plans/assignment.md`, digest: digest(content), chunks: 1 } };
      const children: Record<string, any> = {};
      for (const loop of [1, 2]) for (const phase of ["director", "t1.a1", "review.director-prepare", "review.independent-a", "review.independent-b", "review.director-synthesis", "compliance"]) {
        const key = `invoke-human-1.l${loop}.${phase}`;
        children[key] = childResponse(key, { agent: phase === "director" ? "pitako.execution-director" : phase === "t1.a1" ? "pitako.worker" : "pitako.reviewer" }, metadata, checkout);
      }
      if (mode === "decision") Object.assign(children["invoke-human-1.l1.director"].structuredOutput, { status: "needs-decision", reason: "Original question: reconcile historical host ambiguity", tasks: [] });
      if (historicalChild) Object.assign(children["invoke-human-1.l1.t1.a1"], { ok: false,
        ...(mode.endsWith("permission") ? { error: "Blocked by pi-subagents permission rule: 'run' is denied." } : { stopped: true }),
        ...(mode.endsWith("unknown") ? {} : { results: [{ index: 0, agent: "pitako.worker", task: "Controlled interrupted work",
          exitCode: mode.endsWith("permission") ? 1 : -1, processSignal: mode.endsWith("permission") ? null : "SIGTERM",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] }) });
      const input = { mode, initial: initial.resource.script, resumed: automatic ? initial.resource.script : resumed.resource.script, renewed: renewed.resource.script, children, metadata, checkout, content, target, interruptedLoop };
      // Keep one identical harness for Bun and the owned Node process.
      const harness = async (input: any, run: typeof runWorkflowScript) => {
        const storage = new Map<string, any>(), calls: string[] = [], hosts: string[] = [];
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
            if (replay && input.mode === "retained-operation-persistence" && value.loops?.[0]?.recoveries?.[0]?.stage === "observed")
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
              stdout: JSON.stringify(key === "execute-settings" ? { maxCycles: 3 } : key.startsWith("input-") ?
                { digest: input.metadata.selected.digest, content: input.content } : { ...input.metadata, checkout: input.checkout, admission: { maxCycles: 3 } }) };
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
        if (["automatic-opening", "automatic-capture", "automatic-closing"].includes(input.mode)) {
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
        return { first: first.value, second: second.value, third: third.value, fourth, later, oldDefect, original, retained: storage.get("invoke-human-1"), calls, hosts, statusCalls, before, after };
      };
      const expected = await harness(input, runWorkflowScript);
      if (retainedRecovery) {
        expect(expected.second).toMatchObject({ status: mode.endsWith("usable") ? "complete" : mode.endsWith("pending") ? "blocked" : "cancelled",
          loopsConsumed: mode.endsWith("usable") ? 2 : 1 });
        expect(expected.retained.loops[0].recoveries).toHaveLength(1);
        const retained = expected.original.loops[0].recoveries[0];
        expect(expected.statusCalls).toContain(retained.ref.runId ?? retained.ref.key);
        expect(expected.calls.slice(expected.before).every(key => mode.endsWith("usable") && key.startsWith("invoke-human-1.l2."))).toBe(true);
        expect(expected.retained.loops[0].recoveries[0].source).toEqual(retained.source);
      }
      const currentBarrier = mode.startsWith("current-");
      if (!retainedRecovery && !automatic) expect(expected.second).toMatchObject({ status: mode === "historical-child-unknown" ? "cancelled" : currentBarrier || mode === "historical-child-permission" ? "blocked" : "complete",
        loopsConsumed: mode === "decision" || historicalChild && !["historical-child-unknown", "historical-child-permission"].includes(mode) ? 2 : currentBarrier && mode === "current-stop" ? 0 : 1 });
      if (automatic) {
        const success = ["automatic-opening", "automatic-capture", "automatic-closing"].includes(mode);
        expect(expected.second).toMatchObject({ status: success ? "complete" : mode.endsWith("cut") || mode.startsWith("automatic-intention-") ? "partial" : "blocked" });
        expect(expected.third).toMatchObject({ status: success || ["automatic-admission-cut", "automatic-intention-cut"].includes(mode) ? "complete" : "blocked" });
        if (["automatic-intention-permission", "automatic-intention-pending"].includes(mode)) {
          expect(expected.retained.hostReconstruction).toMatchObject({ source: expected.original.hostHalt,
            stage: "failed", failure: expected.retained.hostHalt });
          expect(expected.retained.hostHalt.observedBarrier).toBe(mode.endsWith("permission") ? "native permission denial" : "running");
        } else expect(expected.retained.hostHalt).toEqual(expected.original.hostHalt);
        expect(expected.retained.resolutions).toBeUndefined();
        expect(expected.retained.loops?.length ?? 0).toBe(success || ["automatic-admission-cut", "automatic-intention-cut"].includes(mode) ? 1 : 0);
        if (success) expect(expected.oldDefect).toMatchObject({ status: "blocked", loopsConsumed: mode === "automatic-closing" ? 1 : 0 });
        if (success || ["automatic-admission-cut", "automatic-intention-cut"].includes(mode)) {
          expect(expected.retained.hostReconstruction.stage).toBe("admitted");
          expect(expected.retained.hostReconstruction.observation).toMatchObject({
            ref: { key: "inspect-initial", outputReference: "/native/inspection.log" },
            candidate: checkout, source: metadata.selected.source, digest: metadata.selected.digest,
          });
          expect(expected.calls).toContain("invoke-human-1.l1.compliance");
          expect(expected.retained.loops[0].results).toHaveLength(1);
          expect(expected.retained.association.maxCycles).toBe(3);
        } else expect(expected.calls).toHaveLength(0);
        if (["automatic-stop", "automatic-pending", "automatic-permission"].includes(mode))
          expect(expected.hosts).toEqual(["inspect-initial"]);
        if (mode === "automatic-closing") expect(expected.after).toBe(expected.before);
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
        expect(expected.retained.loops[0].results).toHaveLength(1);
        expect(expected.retained.loops[0].review.verdict).toBe("clear");
        expect(expected.retained.loops[0].compliance.status).toBe("fulfilled");
      } else expect(expected.third).toMatchObject({ status: (expected.second as any).status, loopsConsumed: (expected.second as any).loopsConsumed });
      if (!["automatic-admission-cut", "automatic-intention-cut"].includes(mode)) expect(expected.calls).toHaveLength(expected.after);
      if (mode === "closing") expect(expected.after).toBe(expected.before);
      if (mode === "decision" || historicalChild) {
        expect(expected.retained.loops[0].plan).toEqual(expected.original.loops[0].plan);
        expect(expected.retained.loops[0].resolutions[0].halt).toEqual(expected.original.loops[0].halt);
      } else if (!retainedRecovery && !automatic) {
        expect(expected.original.hostHalt).not.toHaveProperty("observedState");
        expect((expected.retained.resolutions ?? expected.retained.loops[0].resolutions)[0].hostHalt).toEqual(expected.original.hostHalt);
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
        expect(actual.retained.resolutions ?? actual.retained.loops?.[0]?.resolutions).toEqual(expected.retained.resolutions ?? expected.retained.loops?.[0]?.resolutions);
      } finally { child.kill(); await Promise.all([child.exited, stdout, stderr]); }
    });

  test.each(["complete", "recovered", "unresolved-plan", "rejected-plan", "needs-decision", "mismatched-association", "stopped", "permission",
    "analysis-prepare-stop", "analysis-prepare-permission", "analysis-later-stop", "analysis-later-permission",
    "analysis-compliance-stop", "analysis-compliance-permission", "analysis-prepare-thrown-permission",
    "host-opening-stop", "host-capture-stop", "host-closing-stop", "host-opening-identical-failure",
    "host-opening-timeout", "host-opening-command-failure", "host-opening-similar-text", "host-opening-persistence-failure"])(
    "registered Node root settles native calls without changing the %s outcome", async mode => {
      const root = repository();
      const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
      planExecute({ on: (name: string, hook: (event: unknown, context: unknown) => unknown) => { hooks.set(name, hook); } } as unknown as ExtensionAPI);
      const sessionId = randomUUID(), ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
      hooks.get("session_start")!({}, ctx);
      disposers.push(() => hooks.get("session_shutdown")!({}, ctx));
      const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
      const resolved = resolveWorkflowResource("pitako.execute", args, sessionId);
      if (!resolved.ok) throw Error(resolved.error);
      const content = "COMPLETE SPEC SNAPSHOT";
      const metadata = { root, commonDir: path.join(root, ".git"), candidates: [],
        selected: { source: `${root}/.pitako/plans/assignment.md`, digest: digest(content), chunks: 1 } };
      const storage = new Map<string, any>(), children: Record<string, any> = {}, hosts: Record<string, any> = {};
      const calls: string[] = [], inspections: string[] = [], originals: any[] = [];
      let recoveredWorker: any;
      const permission = "Blocked by pi-subagents permission rule: 'run' is denied.";
      const hostTarget = !mode.startsWith("host-") ? null : mode.includes("-capture-") ? "input-0"
        : mode.includes("-closing-") ? "inspect-loop-1" : "inspect-initial";
      const ambiguousHost = !!hostTarget && !["timeout", "command-failure", "similar-text"].some(kind => mode.endsWith(kind));
      const hostFailure = (key: string, response: any) => key !== hostTarget ? response : { ...response,
        state: mode.endsWith("timeout") ? "timed-out" : mode.endsWith("stop") || mode.endsWith("persistence-failure") ? "stopped" : "failed",
        ok: false, exitCode: null, stdout: "", error: mode.endsWith("timeout") ? "Command timed out after 86400000ms."
          : mode.endsWith("command-failure") ? "Command exited with code 1."
          : mode.endsWith("similar-text") ? "Model said: Command stopped because the workflow was aborted."
          : "Command stopped because the workflow was aborted." };
      const analysisTarget = !mode.startsWith("analysis-") ? null : `invoke-human-1.l1.${mode.includes("-prepare-")
        ? "review.director-prepare" : mode.includes("-later-") ? "review.independent-a" : "compliance"}`;
      const expected = await runWorkflowScript({ script: resolved.resource.script,
        state: { get: key => structuredClone(storage.get(key)), set: (key, value) => {
          if (mode.endsWith("persistence-failure") && (value as any).hostHalt) throw Error("Controlled essential persistence failure");
          storage.set(key, structuredClone(value));
        } },
        launch: async (key, request) => {
          calls.push(key);
          const response = request.agent === "pitako.execution-inspector"
            ? { key, ok: true, output: "", runId: `native-${key}`, agent: request.agent, artifactPaths: [],
              structuredOutput: { status: "recovered", reason: "Exact settled original recovered without edits",
                original: null, workerResult: structuredClone(recoveredWorker), originalAvailable: true,
                binding: "absent", comparison: "only-original", provenance: ["/native/original-worker.json"] } }
            : childResponse(key, request, metadata, checkout, mode === "recovered" ? 1 : 2);
          if (request.agent === "pitako.worker" && ["complete", "recovered"].includes(mode)) {
            const value = response.structuredOutput;
            value.checks.push(
              { ...structuredClone(value.checks[0]), id: "unknown-history", result: "failed", before: null, after: null },
              { ...structuredClone(value.checks[0]), id: "uncaptured-history", result: "not-run",
                before: { head: "not-captured", fingerprint: "temporary-defect" },
                after: { head: "not-captured", fingerprint: "restored" } },
            );
            const schema = request.outputSchema as TSchema;
            expect(validateToolArguments({ name: "worker_result", description: "Result", parameters: schema },
              { type: "toolCall", id: "worker", name: "worker_result", arguments: value })).toEqual(value);
            if (mode === "recovered") {
              recoveredWorker = structuredClone(value);
              delete (response as { structuredOutput?: unknown }).structuredOutput;
            }
          }
          if (mode === "unresolved-plan") {
            if (key.endsWith(".director")) delete (response as { structuredOutput?: unknown }).structuredOutput;
            if (request.agent === "pitako.execution-inspector") Object.assign(response.structuredOutput, {
              status: "unresolved", reason: "Actor: artifact owner. Expansion needed: read access to exact binding.",
              original: null, workerResult: null, originalAvailable: false, binding: "unavailable", comparison: "neither",
            });
          }
          if (request.agent === "pitako.execution-inspector" && mode !== "unresolved-plan") {
            expect(storage.get("invoke-human-1").loops[0].recoveries[0]).toMatchObject({
              stage: "intention", subject: "attempt-result:final:1",
            });
            expect(request.task).toContain("specific scope/effects expansion needed");
          }
          if (key.endsWith(".director") && mode !== "unresolved-plan") {
            const plan = response.structuredOutput;
            const schema = request.outputSchema as TSchema & { properties: { association: { const: unknown } } };
            expect(schema.properties.association.const).toEqual(plan.association);
            expect(plan.association).toEqual({
              root, invocation: args.invocation, missionId: args.missionId, missionPath: args.missionPath,
              loop: Number(key.match(/\.l(\d+)\./)![1]), commonDir: metadata.commonDir,
              source: metadata.selected.source, digest: metadata.selected.digest, maxCycles: 3, sourceRefs: [],
            });
            const tool = { name: "loop_plan", description: "Plan", parameters: schema };
            const validate = (value: any) => validateToolArguments(tool, { type: "toolCall", id: "plan", name: tool.name, arguments: value });
            expect(validate(plan)).toEqual(plan);
            for (const [field, value] of Object.entries(plan.association)) {
              const changed = structuredClone(plan);
              changed.association[field] = typeof value === "number" ? value + 1 : Array.isArray(value) ? [{ path: "/wrong", digest: "f".repeat(64) }] : "/wrong";
              expect(() => validate(changed)).toThrow();
            }
            if (mode === "needs-decision") Object.assign(plan, { status: "needs-decision", reason: "Controlled product decision", tasks: [] });
            if (mode === "mismatched-association") plan.association.missionPath = "/wrong";
            if (mode === "rejected-plan") {
              if (plan.association.loop === 1) plan.tasks[0].dependsOn = [{ taskId: "missing", reason: "Requires missing output" }];
              else {
                expect(storage.get("invoke-human-1").loops[0]).toMatchObject({
                  outcome: "gaps", plan: { stage: "rejected", rejection: { ref: { runId: "native-invoke-human-1.l1.director" } } },
                });
                expect(request.task).toContain("Publish a NEW complete plan");
                expect(request.task).toContain("loop_plan dependencies require");
              }
            }
          }
          if (request.agent === "pitako.worker" && mode === "stopped") Object.assign(response, { ok: false, stopped: true });
          if (key === analysisTarget) Object.assign(response, { ok: false,
            ...(mode.endsWith("-stop") ? { stopped: true } : { error: permission }) });
          children[key] = structuredClone(response);
          originals.push({ response, original: structuredClone(response) });
          if (request.agent === "pitako.worker" && mode === "permission") throw Error(permission);
          if (key === analysisTarget && mode.includes("-thrown-")) throw Error(permission);
          return response;
        },
        status: async () => { if (mode === "unresolved-plan") return { key: "director", ok: true, output: "", artifactPaths: [] }; throw Error("No recovery expected"); },
        host: async key => {
          inspections.push(key);
          const response = { key, kind: "command" as const, state: "passed" as const, ok: true, exitCode: 0,
            stdout: JSON.stringify(key === "execute-settings" ? { maxCycles: 3 } : key.startsWith("input-") ?
              { digest: metadata.selected.digest, content } : { ...metadata, checkout, admission: { maxCycles: 3 } }),
            stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
          hosts[key] = structuredClone(response);
          return hostFailure(key, response);
        },
      });
      expect(expected.value).toMatchObject({ status: ["complete", "recovered", "rejected-plan"].includes(mode) ? "complete" : mode === "stopped" || mode.endsWith("-stop") ? "cancelled" : "blocked",
        ...hostTarget ? { status: "blocked" } : {},
        loopsConsumed: hostTarget && hostTarget !== "inspect-loop-1" ? 0 : ["complete", "rejected-plan"].includes(mode) ? 2 : 1 });
      expect(calls).toHaveLength(analysisTarget ? mode.includes("-prepare-") ? 3 : mode.includes("-later-") ? 5 : 7
        : hostTarget ? hostTarget === "inspect-loop-1" ? 7 : 0
        : mode === "complete" ? 14 : ["recovered", "rejected-plan"].includes(mode) ? 8 : ["stopped", "permission", "unresolved-plan"].includes(mode) ? 2 : 1);
      if (ambiguousHost) {
        expect((expected.value as any).reason).toContain("ambiguous");
        expect((expected.value as any).action.actor).toBe(mode.endsWith("persistence-failure") ? "persistence operator" : "native run operator");
        expect((expected.value as any).action.started).toBe(false);
        if (mode.endsWith("persistence-failure")) expect((expected.value as any).reason).toContain("could not be retained");
        else expect(storage.get("invoke-human-1").hostHalt).toMatchObject({ ref: { key: hostTarget },
          observedError: `Host command '${hostTarget}' failed: Command stopped because the workflow was aborted.` });
      } else if (hostTarget) expect(storage.get("invoke-human-1")?.hostHalt).toMatchObject({ ref: { key: hostTarget } });
      if (mode === "unresolved-plan") {
        expect(expected.value).toMatchObject({ reason: expect.stringContaining("Expansion needed: read access"),
          action: { actor: "evidence owner", started: false } });
        expect(storage.get("invoke-human-1").loops[0].recoveries[0].disposition).toBe("unresolved");
        expect(calls).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l1.recover1"]);
      }
      if (mode === "recovered") {
        const recovered = storage.get("invoke-human-1").loops[0];
        expect(recovered.recoveries[0]).toMatchObject({ stage: "observed", disposition: "recovered" });
        expect(recovered.results[0].checks).toMatchObject({ current: true, failed: 1, notRun: 1 });
        expect(calls.filter(key => key.includes(".recover"))).toHaveLength(1);
        expect(calls.indexOf("invoke-human-1.l1.review.director-prepare")).toBeGreaterThan(calls.indexOf("invoke-human-1.l1.recover1"));
      }
      for (const { response, original } of originals) expect(response).toEqual(original);
      const child = Bun.spawn(["node", "-e", `
        const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        import(${JSON.stringify(new URL("../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href)})
          .then(async ({ runWorkflowScript }) => {
            const storage = new Map(), calls = [], inspections = [];
            let replay = false;
            const statuses = [];
            const options = {
              script: input.script,
              state: { get: async key => structuredClone(storage.get(key)),
                set: async (key, value) => {
                  if (input.mode.endsWith("persistence-failure") && value.hostHalt) throw Error("Controlled essential persistence failure");
                  storage.set(key, structuredClone(value));
                } },
              launch: async key => {
                calls.push(key);
                if (!input.children[key]) throw Error("Unexpected child " + key);
                if (input.mode === "permission" && input.children[key].agent === "pitako.worker") throw Error(input.permission);
                if (!replay && key === input.analysisTarget && input.mode.includes("-thrown-")) throw Error(input.permission);
                // A replacement is prepared to succeed. Replay must not call it.
                if (replay) return { ...structuredClone(input.children[key]), ok: true, stopped: false, error: undefined };
                return structuredClone(input.children[key]);
              },
              status: async ref => {
                statuses.push(ref);
                if (input.analysisTarget) {
                  const result = Object.values(input.children).find(child => child.runId === ref || child.key === ref);
                  if (!result) throw Error("Missing exact producer " + ref);
                  return structuredClone(result);
                }
                if (input.mode === "unresolved-plan") return { key: "director", ok: true, output: "", artifactPaths: [] };
                throw Error("Unexpected recovery");
              },
              host: async key => {
                inspections.push(key);
                if (!input.hosts[key]) throw Error("Unexpected host " + key);
                if (key === input.hostTarget) return input.hostFailure;
                return structuredClone(input.hosts[key]);
              },
            };
            const observed = await runWorkflowScript(options);
            const before = calls.length;
            let repeated;
            if (input.analysisTarget || input.ambiguousHost && !input.mode.endsWith("persistence-failure")) {
              replay = true;
              const hostCount = inspections.length;
              repeated = await runWorkflowScript(options);
              if (calls.length !== before) throw Error("Analysis was blindly redispatched");
              if (input.ambiguousHost) {
                const boundedCount = inspections.length;
                await runWorkflowScript(options);
                if (inspections.length !== boundedCount) throw Error("Failed bounded host reconstruction was blindly repeated");
                if (boundedCount <= hostCount) throw Error("Unknown host cause became a permanent veto");
              }
            }
            console.log(JSON.stringify({ value: observed.value, repeated: repeated?.value, statuses, calls, inspections,
              retained: storage.get("invoke-human-1")?.hostHalt }));
          }).catch(error => { console.error(error); process.exitCode = 1; });
      `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "private-agent") },
        stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
      try {
        child.stdin.write(JSON.stringify({ script: resolved.resource.script, children, hosts, mode, permission, analysisTarget,
          hostTarget, ambiguousHost, hostFailure: hostTarget ? hostFailure(hostTarget, hosts[hostTarget]) : null }));
        child.stdin.end();
        const [exit, output, errors] = await Promise.all([child.exited, stdout, stderr]);
        expect(errors).not.toContain("unawaited runs.run launch(es)");
        expect(exit, errors).toBe(0);
        const actual = JSON.parse(output);
        expect(actual.value).toMatchObject({ status: (expected.value as any).status, reason: (expected.value as any).reason,
          loopsConsumed: hostTarget && hostTarget !== "inspect-loop-1" ? 0 : ["complete", "rejected-plan"].includes(mode) ? 2 : 1 });
        expect(actual.calls).toEqual(calls);
        if (ambiguousHost && !mode.endsWith("persistence-failure")) {
          expect(actual.repeated).toMatchObject({ status: "blocked", loopsConsumed: (expected.value as any).loopsConsumed });
          expect(actual.retained).toEqual(storage.get("invoke-human-1").hostHalt);
        }
        if (analysisTarget) {
          expect(actual.repeated).toMatchObject({ status: (expected.value as any).status, loopsConsumed: 1 });
          expect(actual.statuses).toContain(mode.includes("-thrown-") ? analysisTarget : `native-${analysisTarget}`);
          expect(actual.inspections.filter((key: string) => key === "inspect-loop-1")).toHaveLength(0);
        } else if (ambiguousHost && !mode.endsWith("persistence-failure")) {
          expect(actual.inspections.slice(0, inspections.length)).toEqual(inspections);
          expect(actual.inspections.length).toBeGreaterThan(inspections.length);
        } else expect(actual.inspections).toEqual(inspections);
      } finally {
        child.kill();
        await Promise.all([child.exited, stdout, stderr]);
      }
    });

  // Rejects the old four-closing registration, fixture-only extra grants,
  // settings rereads on replay, and resubmitting completed producers. Models
  // and host rejection receipts are controlled. Inspector commands run on Node;
  // the maximum-size case supplies its 26 exact text packets at that boundary.
  test.each(["fresh", "reentry", "legacy", "interrupted-admission", "exhausted", "capacity", "stop", "permission", "active"])(
    "registered Node capacity closes every available loop: %s", mode => {
      const operation = registeredCapacity(mode);
      workflowSettlements.push(operation.then(() => {}, () => {}));
      return operation;
    });

  async function registeredCapacity(mode: string) {
    const root = repository(), nativeRoot = repository(), sessionId = randomUUID();
    const global = path.join(nativeRoot, "agent"), missionPath = path.join(nativeRoot, "state.json");
    mkdirSync(global); mkdirSync(path.join(root, ".pi")); mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    const base = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
    const content = mode === "fresh" ? base + "x".repeat(MAX_SPEC_BYTES - Buffer.byteLength(base)) : base;
    const source = path.join(root, ".pitako/plans/assignment.md");
    const inherited = path.join(nativeRoot, "inherited.md"), inheritedContent = base.replace("id: assignment", "id: inherited");
    writeFileSync(source, content); writeFileSync(inherited, inheritedContent); writeFileSync(path.join(root, "owned"), "existing WIP");
    const sourceRefs = mode === "legacy" ? [] : [{ path: inherited, digest: digest(inheritedContent) }];
    writeFileSync(path.join(global, "settings.json"), JSON.stringify({ pitako: { execute: { maxCycles: mode === "exhausted" ? 6 : 5 } } }));
    const hooks = new Map<string, any>();
    planExecute({ on: (name: string, hook: any) => hooks.set(name, hook) } as unknown as ExtensionAPI);
    const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = global;
    try { hooks.get("session_start")({}, ctx); }
    finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
    disposers.push(() => hooks.get("session_shutdown")({}, ctx));
    const resolved = resolveWorkflowResource("pitako.execute", { root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath, sourceRefs }, sessionId);
    if (!resolved.ok) throw Error(resolved.error);
    const permit = consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script);
    if (typeof permit === "string") throw Error(permit);
    const resource = { script: resolved.resource.script, hostCommands: permit.authority.host! };
    expect(resource.hostCommands).toHaveLength(32);
    expect(resource.hostCommands.filter(grant => grant.key.startsWith("input-"))).toHaveLength(26);
    expect(resource.hostCommands.some(grant => grant.key === "execute-settings")).toBe(false);
    const metadata = { root, commonDir: path.join(root, ".git"), selected: { source, digest: digest(content) } };
    const child = Bun.spawn(["node", "--disable-warning=ExperimentalWarning", "-e", `
      const fs = require("node:fs"), cp = require("node:child_process");
      const input = JSON.parse(fs.readFileSync(0,"utf8"));
      (async () => {
        const {runWorkflowScript} = await import(input.runner);
        const respond = eval("(" + input.response + ")");
        const state = new Map(), calls = [], hosts = [], emissions = [], stages = [], originals = new Map();
        let currentCheckout = input.checkout;
        const grants = new Map(input.resource.hostCommands.map(item => [item.key,item.command]));
        const persist = () => fs.writeFileSync(input.missionPath, JSON.stringify(Object.fromEntries(state)));
        const options = {
          state:{get:key=>structuredClone(state.get(key)),set:(key,value)=>{state.set(key,structuredClone(value));persist();}},
          status:async ref=>{if (!originals.has(ref)) throw Error("Unexpected reconciliation "+ref);return structuredClone(originals.get(ref));},
          onEmit: values=>emissions.push(...values),
          host:async (key,params)=>{
            if (!grants.has(key) || params.command !== grants.get(key)) throw Error("Fixture-only grant "+key);
            if (hosts.length >= 32) throw Error("Native host call bound exceeded");
            const stdout = input.mode === "fresh" && key.startsWith("input-")
              ? JSON.stringify({digest:input.metadata.selected.digest,content:input.chunks[Number(key.slice(6))]})+"\\n"
              : cp.execFileSync("sh",["-c",grants.get(key)],{cwd:input.root,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
            if (Buffer.byteLength(stdout)>4096) throw Error("Incomplete native envelope");
            const receipt = JSON.parse(stdout);
            if (receipt.checkout) currentCheckout = {head:receipt.checkout.head,fingerprint:receipt.checkout.fingerprint};
            hosts.push({key,bytes:Buffer.byteLength(stdout),admission:receipt.admission ?? null});
            return {key,kind:"command",state:"passed",ok:true,exitCode:0,stdout,stderr:"",outputPath:input.missionPath+"."+key+".log",durationMs:0};
          },
          launch:async (key,request)=>{
            const loop = Number(key.match(/\\.l(\\d+)\\./)?.[1] ?? 1);
            if (!grants.has("inspect-loop-"+loop)) throw Error("Dispatch without required closing capacity");
            calls.push(key);stages.push({key,phase:state.get("invoke-human-1").loops.at(-1).phase});
            if (loop === 5 && key.endsWith(".director")) {
              if (input.mode === "capacity") throw Error("Active async run capacity exhausted: 4/4 used.");
              if (input.mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
              if (input.mode === "stop") return {key,ok:false,stopped:true,output:"Stopped",artifactPaths:[]};
              if (input.mode === "active") return {key,ok:true,state:"running",output:"",artifactPaths:[]};
            }
            const result = respond(key,request,input.metadata,currentCheckout,input.mode === "legacy" ? 3 : input.mode === "exhausted" ? 7 : 5);
            if (key.endsWith(".director"))
              result.structuredOutput.association = JSON.parse(request.task.split("ASSOCIATION (data): ")[1].split("\\n")[0]);
            originals.set(key,result);originals.set(result.runId,result);
            return result;
          }
        };
        if (input.mode === "legacy") {
          const association = {missionId:"native.mission-1",missionPath:input.missionPath,invocation:"human-1",root:input.root,
            commonDir:input.metadata.commonDir,source:input.metadata.selected.source,digest:input.metadata.selected.digest};
          state.set("invoke-human-1",{version:2,association,snapshot:{content:input.content},startedAt:Date.now(),loops:[],activePlan:null});
          state.set("pitako-execution",{version:2,association});persist();
        }
        if (input.mode === "interrupted-admission") {
          const config = JSON.parse(input.resource.script.split("\\n")[0].slice("const config = ".length,-1));
          state.set("invoke-human-1",{version:3,hostHalt:{status:"blocked",code:"host-observation",reason:"Unknown host transport interruption",
            ref:{key:"inspect-initial"},command:config.inspections[0].command,request:{
              missionId:config.missionId,missionPath:config.missionPath,invocation:config.invocation,
              root:config.root,id:config.id,inspectionCommand:config.inspections[0].command,sourceRefs:config.sourceRefs}}});persist();
        }
        const replay = !["fresh","legacy","interrupted-admission","exhausted"].includes(input.mode);
        let prior = null, first = null, split = 0, hostSplit = 0;
        if (replay) {
          // Reproduce the prior registration exactly by removing its absent fifth
          // closing, never by adding fixture grants to the current registration.
          const configLine = input.resource.script.slice(0,input.resource.script.indexOf("\\n"));
          const config = JSON.parse(configLine.slice("const config = ".length,-1));
          config.inspections = config.inspections.filter(item=>item.key !== "inspect-loop-5");
          first = (await runWorkflowScript({...options,script:"const config = "+JSON.stringify(config)+";\\n"+input.resource.script.slice(configLine.length+1)})).value;
          prior = structuredClone(state.get("invoke-human-1"));split=calls.length;hostSplit=hosts.length;
          if (prior.loops.length !== 4 || prior.loops.at(-1).halt?.ref?.key !== "host-inspection-capacity")
            throw Error("Did not reproduce four-of-five own-capacity halt: "+JSON.stringify(first));
        }
        if (replay || input.mode === "legacy") {
          fs.writeFileSync(input.global+"/settings.json", '{"pitako":{"execute":{"maxCycles":false}}}');
          fs.writeFileSync(input.root+"/.pi/settings.json","{");
        }
        const observed = await runWorkflowScript({...options,script:input.resource.script});
        console.log(JSON.stringify({value:observed.value,first,prior,split,hostSplit,calls,hosts,stages,emissions,invocation:state.get("invoke-human-1"),
          wip:fs.readFileSync(input.root+"/owned","utf8")}));
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: global }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
    const identity = checkoutEvidence(root);
    child.stdin.write(JSON.stringify({ root, global, missionPath, metadata, content, chunks: specChunks(content), mode, resource,
      checkout: { head: identity.head, fingerprint: identity.fingerprint },
      response: childResponse.toString(), runner: new URL("../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href }));
    child.stdin.end();
    const [exit, output, errors] = await Promise.all([child.exited, stdout, stderr]);
    expect(exit, errors).toBe(0);
    expect(errors).not.toContain("unawaited runs.run launch(es)");
    const observed = JSON.parse(output), saved = observed.invocation;
    const success = ["fresh", "reentry", "legacy", "interrupted-admission"].includes(mode);
    expect(observed.value).toMatchObject({ status: success ? "complete" : mode === "stop" ? "cancelled" : ["capacity", "exhausted"].includes(mode) ? "partial" : "blocked",
      loopsConsumed: mode === "legacy" ? 3 : 5, maxLoops: mode === "legacy" ? 3 : mode === "exhausted" ? 6 : 5 });
    expect(saved.association).toMatchObject({ missionId: "native.mission-1", missionPath, invocation: "human-1", root,
      source, digest: digest(content), ...(mode === "legacy" ? {} : { sourceRefs, maxCycles: mode === "exhausted" ? 6 : 5 }) });
    expect(saved.snapshot.content).toBe(content);
    expect(observed.wip).toBe("existing WIP");
    // Only private settings were changed; all other tracked/untracked WIP is retained.
    expect(checkoutEvidence(root).head).toBe(identity.head);
    expect(observed.hosts.length).toBeLessThanOrEqual(32);
    expect(observed.hosts.filter((call: any) => call.admission)).toHaveLength(mode === "legacy" ? 0 : 1);
    if (mode === "fresh") {
      expect(observed.hosts).toHaveLength(32);
      expect(observed.hosts.filter((call: any) => call.key.startsWith("input-"))).toHaveLength(26);
    }
    if (observed.prior) {
      expect(observed.first).toMatchObject({ status: "partial", loopsConsumed: 4, maxLoops: 5 });
      expect(saved.association).toEqual(observed.prior.association);
      expect(saved.snapshot).toEqual(observed.prior.snapshot);
      const previous = structuredClone(saved.loops.slice(0, 4)), oldHalt = observed.prior.loops[3].halt;
      expect(previous[3].capacityHistory).toContainEqual(oldHalt);
      delete previous[3].capacityHistory; previous[3].halt = oldHalt;
      expect(previous).toEqual(observed.prior.loops);
      expect(observed.calls.slice(observed.split).every((key: string) => key.startsWith("invoke-human-1.l5."))).toBe(true);
      expect(observed.hosts.slice(observed.hostSplit).some((call: any) => call.admission || call.key.startsWith("input-"))).toBe(false);
    }
    if (success || mode === "exhausted") {
      const last = mode === "legacy" ? 3 : 5;
      expect(observed.hosts.at(-1).key).toBe(`inspect-loop-${last}`);
      expect(observed.stages).toContainEqual({ key: `invoke-human-1.l${last}.compliance`, phase: "compliance" });
      expect(observed.calls).toContain(`invoke-human-1.l${last}.review.director-synthesis`);
      expect(saved.loops.at(-1).closing.ref.key).toBe(`inspect-loop-${last}`);
      expect(saved.loops.at(-1).closing.candidate.fingerprint).toBe(checkoutEvidence(root).fingerprint);
    } else {
      expect(saved.loops[4].phase).toBe("director");
      expect(observed.calls.slice(observed.split)).toEqual(["invoke-human-1.l5.director"]);
      expect(observed.value.action.reason ?? observed.value.reason).toBeTruthy();
      expect(observed.value.references.some((ref: any) => ref.key === "invoke-human-1.l5.director")).toBe(true);
    }
    if (mode === "exhausted") {
      expect(saved.loops.at(-1).halt.ref.key).toBe("host-inspection-capacity");
      expect(observed.calls.some((key: string) => key.startsWith("invoke-human-1.l6."))).toBe(false);
      expect(observed.value.phase).toBe("finished");
    }
  }

  test.each(["partial-association", "foreign", "partial-without-association", "legacy-conflict"])(
    "conditional initial admission never replaces incompatible retained state: %s", async mode => {
      const root = repository(), nativeRoot = repository(), missionPath = path.join(nativeRoot, "state.json");
      const global = path.join(nativeRoot, "agent"); mkdirSync(global);
      writeFileSync(path.join(global, "settings.json"), '{"pitako":{"execute":{"maxCycles":false}}}');
      const resource = resourceWithAgentDir(global).resolve({ root, id: "assignment", invocation: "human-1",
        missionId: "native.mission-1", missionPath });
      const association = { root, missionId: "native.mission-1", missionPath, invocation: "human-1", maxCycles: 5, sourceRefs: [] };
      const retained = { version: 3, ...(mode === "partial-without-association" ? { snapshot: { content: "partial" } } :
        { association: mode === "partial-association" ? {} : { ...association, ...(mode === "foreign" ? { missionId: "other" } : {}) } }) };
      const state: Record<string, any> = { "invoke-human-1": retained,
        ...(mode === "legacy-conflict" ? { "pitako-execution": { version: 2, association } } : {}) };
      const original = JSON.stringify(state); writeFileSync(missionPath, original);
      const command = resource.hostCommands.find(grant => grant.key === "inspect-initial")!.command;
      // The inspector itself must not hide the conflict behind invalid settings.
      let failure = "";
      try { execFileSync("sh", ["-c", command], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { failure = String((error as { stderr: unknown }).stderr); }
      expect(failure).toMatch(/retained (invocation|association)/);
      expect(failure).not.toContain("pitako.execute.maxCycles");
      const calls: string[] = [];
      const result = await runWorkflowScript({ script: resource.script,
        state: { get: key => structuredClone(state[key]), set: () => { throw Error("No association replacement permitted"); } },
        launch: async key => { calls.push(key); throw Error("No dispatch permitted"); },
        status: async () => { throw Error("No producer to reconcile"); },
        host: async key => {
          throw Error(`Conflicting request must not read settings: ${key}`);
        } });
      expect(result.value).toMatchObject({ status: "blocked", loopsConsumed: 0 });
      expect(calls).toEqual([]);
      expect(readFileSync(missionPath, "utf8")).toBe(original);
    });

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
    for (const resource of expanded) expect(resource.hostCommands).toHaveLength(32);
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
    mkdirSync(global); mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    const source = path.join(root, ".pitako/plans/inherited.md");
    const content = `---\npitako-spec: 1\nid: inherited\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}${"Inherited obligations.\n".repeat(1150)}`;
    // Each source fits; their complete combined bytes deliberately do not.
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(MAX_SPEC_BYTES);
    expect(Buffer.byteLength(content) * 2).toBeGreaterThan(MAX_SPEC_BYTES);
    writeFileSync(source, content);
    const expanded = resourceWithAgentDir(global).resolve({ root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json", sourceRefs: [{ path: source, digest: digest(content) }] });
    expect(expanded.hostCommands).toHaveLength(32);
    const command = expanded.hostCommands.find(grant => grant.key === "inspect-initial")!.command;
    const inspect = () => execFileSync("sh", ["-c", command], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: global },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(inspect()).admission).toEqual({ maxCycles: 3 });
    writeFileSync(source, content + "\nChanged");
    expect(JSON.parse(inspect()).error).toContain("Complete spec source hash mismatch");
    rmSync(source); expect(JSON.parse(inspect()).error).toContain(source);
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
    const root = repository();
    const source = 'C:\\specs & %PATH% !expansion!\\quoted\'"source.md';
    const expanded = executionResource("win32").resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json", source });
    expect(expanded.hostCommands).toHaveLength(32);
    for (const grant of expanded.hostCommands) {
      const match = grant.command.match(/^node -e "([^"]+)"(?: (metadata|\d+))?$/);
      expect(match).not.toBeNull();
      const payload = match![1]!.match(/Buffer.from\('([A-Za-z0-9+/=]+)','base64'\)/)![1]!;
      expect(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))).toEqual([
        path.resolve("skills/execute/inspect.mjs"), root, "assignment", source,
        grant.key.startsWith("input-") ? grant.key.slice(6) : "metadata",
        JSON.stringify({
          missionId: "native.mission-1", missionPath: "/native/actual-mission.json", invocation: "human-1",
          sourceRefs: [], admissionTransport: true,
          ...(grant.key === "inspect-initial" ? { admission: { sourceRefs: [], agentDir: path.resolve(getAgentDir()) } } : {}),
        }),
      ]);
      expect(match![1]).not.toMatch(/[%!$`]/);

    }
    const inspect = executionResource("win32").resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" }).hostCommands[0]!.command;
    const bootstrap = inspect.match(/-e "([^"]+)"/)![1]!;
    const result = JSON.parse(execFileSync("node", ["-e", bootstrap], { encoding: "utf8" }));
    expect(result.root).toBe(root); expect(result.selected).toBeNull();
  });

  test("POSIX host grants invoke the packaged Node entry without interpreting root metacharacters", () => {
    const main = repository(), root = path.join(main, "sibling ' & %PATH% !");
    execFileSync("git", ["worktree", "add", "-qb", "quoted", root], { cwd: main, stdio: "ignore" });
    const expanded = executionResource("linux").resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    const grant = expanded.hostCommands.find(item => item.key === "inspect-initial")!;
    const result = JSON.parse(execFileSync("sh", ["-c", grant.command], { cwd: root, encoding: "utf8" }));
    expect(result.root).toBe(root); expect(result.selected).toBeNull();
    for (const name of ["plan", "execute"]) {
      const skill = read(`skills/${name}/SKILL.md`);
      expect(skill).toContain("inspect.mjs"); expect(skill.replace(/\s+/g, " ")).toContain("Node >=22.19.0");
      expect(skill).toContain("never shell-interpolated paths");
    }
  });

  test("native session-scoped resource registration replaces/disposes on lifecycle, with exact read-only command grants", () => {
    const root = repository();
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
    expect(expanded.hostCommands).toHaveLength(32);
    expect(new Set(expanded.hostCommands.map(grant => grant.key)).size).toBe(32);
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
    // Resolver performs no Git discovery; physical validation remains launch/inspection.
    expect(() => executionResource().resolve({ ...args, root: tmpdir() })).not.toThrow();
    hooks.get("session_start")!({}, ctx(second));
    expect(resolveWorkflowResource("pitako.execute", args, first).ok).toBe(false);
    expect(resolveWorkflowResource("pitako.execute", args, second).ok).toBe(true);
    hooks.get("session_shutdown")!({}, ctx(second)); hooks.get("session_shutdown")!({}, ctx(second));
    expect(resolveWorkflowResource("pitako.execute", args, second).ok).toBe(false);
  });

  test("setup captures complete trusted sources and the bounded resolver does not discover a checkout", () => {
    const resource = executionResource();
    const root = path.join(tmpdir(), `pitako-not-created-${randomUUID()}`);
    expect(existsSync(root)).toBe(false);
    const args = { root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
    const expanded = resource.resolve(args);
    expect(expanded.script).toContain(`const pitakoReviewLibraryMode = true;\n${read("skills/review/workflow.js")}\n${read("skills/execute/workflow.js")}`);
    expect(resource.resolve(Object.freeze(args))).toEqual(expanded);
    expect(existsSync(root)).toBe(false);
    expect(expanded.hostCommands).toHaveLength(32);
  });

  test("foreground subdirectory is not treated as launch cwd; the public launch must match the designated root", () => {
    const root = repository(), nested = path.join(root, "src"); mkdirSync(nested);
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
            if (key.startsWith("input-") && !(mode === "long-path" && key === "input-0")) {
              // Eligibility uses actual Git/CLI above; transport fragments use the owned pure boundary.
              const index = Number(key.slice(6)), initial = JSON.parse(envelopes[0]!);
              const packetMetadata = { root, commonDir: rawDiscovery.commonDir, candidates: [],
                selected: { source: selected, digest: digest(content), chunks: specChunks(content).length } };
              stdout = JSON.stringify(initial.transport ? inspectionSnapshot(packetMetadata, content).packets[index]
                : { digest: digest(content), content: specChunks(content)[index] }) + "\n";
            } else stdout = execFileSync("sh", ["-c", params.command], { cwd: root,
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
      const ambiguous = await execute();
      expect(structuredClone(ambiguous.value)).toMatchObject({ status: "blocked", phase: "admission", loopsConsumed: 0 });
      // Discovery details stay in the cited bounded inspector envelope, not a second report.
      expect(ambiguous.value).toMatchObject({ references: [{ key: "inspect-initial", outputReference: "/native/inspect-initial.log" }] });
      const ambiguity = JSON.parse(ambiguous.envelopes[0]!) as { candidates: { source: string }[]; candidatesOmitted: number };
      expect(ambiguity.candidates.length).toBeGreaterThan(0); expect(ambiguity.candidatesOmitted).toBeGreaterThan(0);
      expect(ambiguity.candidates.length + ambiguity.candidatesOmitted).toBe(locations.length);
      for (const candidate of ambiguity.candidates) expect(locations).toContain(candidate.source);
      expect(ambiguity.candidates.map(candidate => candidate.source)).not.toContain(selected);
      expect(ambiguous.launched).toHaveLength(0);
    }
    const chosen = await execute(selected);
    expect(chosen.value).toMatchObject({ status: "complete" });
    expect(chosen.storage.get("invoke-human-1")).toMatchObject({ association: { source: selected, digest: digest(content) }, snapshot: { content } });
    expect(chosen.storage.get("pitako-execution")).toMatchObject({ version: 3, association: { root, commonDir: path.join(main, ".git") } });
    expect(chosen.envelopes.some(envelope => JSON.parse(envelope).transport)).toBe(mode === "long-path");
    const initial = JSON.parse(chosen.envelopes[0]!);
    if (mode === "siblings") { expect(initial.candidates).toEqual([]); expect(initial.selected.source).toBe(selected); }
  }

  test.each(["escaped", "multibyte"])("maximum-size specs plus selected metadata fit all three native cycles within exactly 30 host calls: %s", async kind => {
    const root = repository();
    const prefix = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`;
    const filler = kind === "escaped" ? '"\\' : "é中😀\n";
    const remaining = MAX_SPEC_BYTES - Buffer.byteLength(prefix), size = Buffer.byteLength(filler);
    const content = prefix + filler.repeat(Math.floor(remaining / size)) + "x".repeat(remaining % size);
    validateSpec(content, "assignment"); expect(Buffer.byteLength(content)).toBe(MAX_SPEC_BYTES);
    // Transport dimension fixture; real eligibility/root/path validation is covered above.
    const selected = { source: `/controlled/${'é中"\\'.repeat(750)}/assignment.md`, digest: digest(content), chunks: specChunks(content).length };
    const metadata = { root, commonDir: path.join(root, ".git"), candidates: [], selected };
    const { transport, packets } = inspectionSnapshot(metadata, content);
    expect(packets).toHaveLength(26);
    expect(packets.map(packet => packet.metadata).join("")).toBe(JSON.stringify(metadata));
    expect(packets.map(packet => packet.content).join("")).toBe(content);
    const expanded = executionResource().resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    expect(expanded.hostCommands).toHaveLength(32);
    const grants = new Map(expanded.hostCommands.map(grant => [grant.key, grant.command]));
    const storage = new Map<string, unknown>(), hostKeys: string[] = [];
    const result = await runWorkflowScript({ script: expanded.script,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async (key, request) => {
        if (key.endsWith(".director")) expect(request.task).toContain(JSON.stringify(selected.source));
        if (!request.resume) expect(request.task).toContain(content);
        return childResponse(key, request, metadata, checkout, 3);

      },
      status: async () => { throw new Error("Unexpected status"); },
      host: async (key, params) => {
        expect(params.command).toBe(grants.get(key)!); hostKeys.push(key);
        const stdout = JSON.stringify(key === "execute-settings" ? { maxCycles: 3 } : key.startsWith("input-") ? packets[Number(key.slice(6))]
          : { selected: { digest: selected.digest }, transport, checkout, admission: { maxCycles: 3 } }) + "\n";
        expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(4096);
        return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout, stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
      },
    });
    expect(result.value).toMatchObject({ status: "complete", loopsConsumed: 3 });
    expect(hostKeys).toHaveLength(30); expect(new Set(hostKeys).size).toBe(30);
    expect(storage.get("invoke-human-1")).toMatchObject({ association: { source: selected.source, digest: selected.digest }, snapshot: { content }, loops: expect.any(Array) });
  });

  test.each(["canonical", "descriptive", "id-only", "unknown", "uncaptured", "missing", "failed", "not-run", "stale", "missing-identity", "invalid-identity",
    "malformed-later", "duplicate", "producer-conflict", "binding-conflict", "invalid-dependency", "invalid-dependency-lost", "invalid-dependency-unresolved"])(
    "registered normal route advances only valid mandatory evidence with retained diagnostics (%s)", async mode => {
      const root = repository();
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
        selected: { source: `${root}/.pitako/plans/assignment.md`, digest: digest("COMPLETE SPEC SNAPSHOT"), chunks: 1 } };
      const storage = new Map<string, any>(), calls: string[] = [], originals: any[] = [];
      const invalidDependency = mode.startsWith("invalid-dependency");
      const cacheCut = mode === "invalid-dependency-lost" || mode === "invalid-dependency-unresolved";
      let published: any;
      const observed = await runWorkflowScript({ script: resolved.resource.script,
        state: { get: key => structuredClone(storage.get(key)), set: (key, value: any) => {
          if (cacheCut && value.activePlan && value.loops?.[1]?.halt) throw Error("Controlled optional-cache write cut");
          storage.set(key, structuredClone(value));
        } },
        launch: async (key, request) => {
          calls.push(key);
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
              const intent = storage.get("invoke-human-1").loops[0].attempt.checkpoint;
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
              const completed = storage.get("invoke-human-1").loops[0].results[0];
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
          stdout: JSON.stringify(key === "execute-settings" ? { maxCycles: 3 } : key.startsWith("input-") ?
            { digest: metadata.selected.digest, content: "COMPLETE SPEC SNAPSHOT" } : { ...metadata, checkout, admission: { maxCycles: 3 } }),
          stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 }),
      });
      const valid = ["canonical", "descriptive", "id-only", "unknown", "uncaptured"].includes(mode);
      expect(observed.value).toMatchObject({ status: valid ? "complete" : "blocked", loopsConsumed: invalidDependency ? 2 : 1 });
      expect(calls.filter(key => /\.t\d+\.a/.test(key))).toEqual(invalidDependency ? [] : valid ?
        ["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t2.a1"] : ["invoke-human-1.l1.t1.a1"]);
      expect(calls.filter(key => key.endsWith(".director"))).toHaveLength(invalidDependency ? 2 : 1);
      if (invalidDependency) {
        expect(storage.get("invoke-human-1").loops[0].plan.stage).toBe("rejected");
        expect((observed.value as any).reason).toContain("No new useful corrective input");
      }
      expect(calls.some(key => key.includes(".review."))).toBe(valid);
      expect(calls.some(key => key.includes("recover"))).toBe(false);
      if (cacheCut) {
        const retained = structuredClone(storage.get("invoke-human-1").loops);
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
            stdout: JSON.stringify({ ...metadata, checkout, admission: { maxCycles: 3 } }), stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 }),
        });
        expect(replay.value).toMatchObject({ status: "blocked", loopsConsumed: 2, reason: expect.stringContaining("No new useful corrective input") });
        expect(storage.get("invoke-human-1").loops).toEqual(retained);
        expect(calls).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l2.director"]);
        expect(statusCalls).toEqual([]);
      }
      if (valid) expect(storage.get("invoke-human-1").loops[0].manifest).toEqual(published.tasks.map((task: any) => task.id));
      for (const { response, original } of originals) expect(response).toEqual(original);
    });

  test("registered amendment context reaches verify-behavior workers and whole-spec review/compliance assembly", async () => {
    const root = repository();
    const metadata = { root, commonDir: path.join(root, ".git"), candidates: [],
      selected: { source: `${root}/.pitako/plans/assignment.md`, digest: digest("COMPLETE SPEC SNAPSHOT"), chunks: 1 } };
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
        else expect((storage.get("invoke-human-1") as any).activePlan.sharedContext).toEqual(amendmentContext);
        return response;
      },
      status: async () => { throw new Error("Unexpected routine recovery"); },
      host: async (key) => {
        inspections.push(key);
        return { key, kind: "command", state: "passed", ok: true, exitCode: 0,
          stdout: JSON.stringify(key === "execute-settings" ? { maxCycles: 3 } : key.startsWith("input-") ? { digest: metadata.selected.digest, content: "COMPLETE SPEC SNAPSHOT" } : { ...metadata, checkout, admission: { maxCycles: 3 } }),
          stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
      },
    });
    expect(result.value).toMatchObject({ status: "complete", loopsConsumed: 1, actionRequired: "none" });
    expect(calls.map(call => call.key)).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l1.t1.a1",
      "invoke-human-1.l1.review.director-prepare", "invoke-human-1.l1.review.independent-a", "invoke-human-1.l1.review.independent-b",
      "invoke-human-1.l1.review.director-synthesis", "invoke-human-1.l1.compliance"]);
    expect(inspections).toEqual(["inspect-initial", "input-0", "inspect-loop-1"]);
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
    for (const call of calls) {
      const role = (call.agent ?? "pitako.reviewer").replace("pitako.", "");
      const assembled = [read("AGENTS.md"), bodies.get(role),
        call.resume ? priorContexts.get(call.resume) : "", call.task].join("\n");
      priorContexts.set(`native-${call.key}`, assembled);
      for (const obsolete of ["sole delegating cycle director", "create all known stages pending", "Prepare an implementation TODO", "reports actual spec/check/review evidence and its current-checkout association", "Only the execution director delegates"])
        expect(assembled).not.toContain(obsolete);
      expect(assembled).toContain("COMPLETE SPEC SNAPSHOT");
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
    expect(retained.snapshot.content).toBe("COMPLETE SPEC SNAPSHOT");
    expect(retained.loops[0].plan.ref).toBeDefined();
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

  test("worker preserves upstream implementation core, explicit providers, Ponytail LITE and no delegation; all packaged children stay nondelegating", () => {
    const { frontmatter: worker, body } = parseFrontmatter(read("agents/worker.md"));
    const upstream = parseFrontmatter(read("node_modules/pi-subagents/agents/worker.md"));
    expect(`${worker.package}.${worker.name}`).toBe("pitako.worker");
    for (const field of ["acceptanceRole", "defaultContext", "inheritProjectContext", "systemPromptMode", "defaultReads", "defaultProgress"]) expect(worker[field]).toEqual(upstream.frontmatter[field]);
    const tools = String(worker.tools).split(/,\s*/);
    for (const tool of ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor", "apply_patch", "codegraph_explore", "codegraph_files", "lsp_symbols", "lsp_rename"]) expect(tools).toContain(tool);
    expect(tools).not.toContain("subagent"); expect(worker.allowNestedSubagents).toBeUndefined(); expect(worker.model).toBeUndefined();
    expect(String(worker.skills).split(/,\s*/)).toEqual(["ponytail", "verify-behavior"]);
    expect(worker.skillPath).toEqual(["../node_modules/@dietrichgebert/ponytail/skills/ponytail", "../skills/practical/verify-behavior"]);
    expect(worker.extensions).toEqual(["../extensions/acp.ts"]);
    expect(worker.subagentOnlyExtensions).toEqual(["../extensions/dev-tools/index.ts", "../extensions/file-sha256.ts", "../extensions/checkpoint-create.ts", "../node_modules/@vndv/pi-codegraph/extensions/codegraph.ts", "../node_modules/pi-lsp-client/src/index.ts", "../node_modules/pi-codex-tools/index.ts"]);
    for (const provider of worker.subagentOnlyExtensions as string[]) expect(existsSync(path.resolve("agents", provider))).toBe(true);
    for (const contract of ["single writer thread", "pause and escalate", "Ponytail is explicitly LITE", "Never\nreduce assigned specs or scope", "weaken project-required tests", "output schema/reporting", "edit/write"])
      expect(body).toContain(contract);
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


// Rejects abandoning a pending successor, replaying an admitted writer, or
// declaring completion without the following task and final analysis connection.
// This is a read-only unit: nominal checkpoint descriptors must not require
// nonexistent modifying preimages. Implementation rollback is covered separately.
test.each(["complete", "receipt-save-cut", "result-save-cut", "cursor-save-cut", "pending", "pending-settled"])(
  "registered Node interrupted check continuation retains task ownership: %s", async mode => {
    const root = repository();
    writeFileSync(path.join(root, "owned"), "Existing interrupted-unit WIP");
    const { head, fingerprint } = checkoutEvidence(root), checkout = { head, fingerprint };
    const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
    planExecute({ on: (name: string, hook: (event: unknown, context: unknown) => unknown) => { hooks.set(name, hook); } } as unknown as ExtensionAPI);
    const sessionId = randomUUID(), ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
    hooks.get("session_start")!({}, ctx);
    disposers.push(() => hooks.get("session_shutdown")!({}, ctx));
    const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
    const resolved = resolveWorkflowResource("pitako.execute", args, sessionId);
    if (!resolved.ok) throw Error(resolved.error);
    const content = "COMPLETE SPEC SNAPSHOT";
    const metadata = { root, commonDir: path.join(root, ".git"), candidates: [],
      selected: { source: `${root}/.pitako/plans/assignment.md`, digest: digest(content), chunks: 1 } };
    // Prepare complete native originals at the controlled boundary, not another
    // copy of the root. The registered resource itself runs inside Node below.
    const templates: Record<string, any> = {};
    const seed = new Map<string, any>();
    const prepared = await runWorkflowScript({ script: resolved.resource.script,
      state: { get: key => seed.get(key), set: (key, value) => { seed.set(key, structuredClone(value)); } },
      status: async () => { throw Error("Unexpected seed status"); },
      launch: async (key, params) => {
        const response = childResponse(key, params, metadata, checkout);
        if (key.endsWith(".director")) {
          const final = response.structuredOutput.tasks[0];
          response.structuredOutput.tasks = [{ ...structuredClone(final), id: "repair", kind: "verification",
            goal: "Verify authorized behavior without writes", expectedResult: "Current verification check",
            checks: [{ ...final.checks[0], id: "repair-check" }] },
            { ...final, dependsOn: [{ taskId: "repair", reason: "Verify the completed repair" }] }];
        } else if (key.endsWith(".t1.a1")) {
          response.structuredOutput.taskId = "repair";
          response.structuredOutput.checks[0].id = "repair-check";
        }
        templates[key] = structuredClone(response);
        return response;
      },
      host: async key => ({ key, kind: "command", ok: true, state: "passed", exitCode: 0, stderr: "", durationMs: 0,
        outputPath: `/native/${key}.log`, stdout: JSON.stringify(key === "execute-settings" ? { maxCycles: 3 } :
          key.startsWith("input-") ? { digest: metadata.selected.digest, content } : { ...metadata, checkout, admission: { maxCycles: 3 } }) }),
    });
    expect(prepared.value).toMatchObject({ status: "complete" });
    const process = Bun.spawn(["node", "-e", `
      const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      import(${JSON.stringify(new URL("../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href)})
        .then(async ({runWorkflowScript}) => {
          const storage = new Map(), calls = [], statuses = [], originals = new Map();
          let cut = input.mode.includes("cut");
          const resumeKey = "invoke-human-1.l1.t1.a1.resume";
          const options = { script: input.script,
            state: { get: key => structuredClone(storage.get(key)), set: (key, value) => {
              const attempt = value.loops?.[0]?.attempt;
              if (cut && ((attempt?.nativeContinuation?.stage === "receipt" &&
                  (input.mode === "receipt-save-cut" || (input.mode === "result-save-cut" && attempt.stage === "result"))) ||
                  (input.mode === "cursor-save-cut" && value.loops?.[0]?.cursor === 1))) throw Error("Controlled continuation save cut");
              storage.set(key, structuredClone(value));
            } },
            launch: async (key, params) => {
              if (key.endsWith(".t2.a1")) {
                const stored = storage.get("invoke-human-1");
                const first = stored.loops[0].results[0];
                if (stored.loops[0].cursor !== 1 || first.status !== "complete" || first.ref.runId !== "exact-successor")
                  throw Error("Next task dispatched before durable resumed-result admission");
                const refs = JSON.parse(params.task.split("DIRECT PREREQUISITE COMPLETED RESULTS (historical references, not current check evidence):\\n")[1].split("\\n")[0]);
                if (refs[0]?.taskId !== "repair" || refs[0]?.ref?.runId !== "exact-successor") throw Error("Wrong prerequisite successor");
              }
              calls.push({key, resume: params.resume, agent: params.agent});
              let response;
              if (key.endsWith(".t1.a1")) response = { ...structuredClone(input.templates[key]),
                ok: false, state: "interrupted", structuredOutput: undefined, results: [] };
              else if (key.endsWith(".resume")) {
                if (params.agent !== undefined || params.resume !== "native-invoke-human-1.l1.t1.a1") throw Error("Wrong native resume contract");
                const frozen = JSON.parse(params.task.split("FROZEN ATTEMPT:\\n")[1].split("\\n")[0]);
                if (frozen.taskId !== "repair" || frozen.number !== 1) throw Error("Attempt contract changed");
                response = { ...structuredClone(input.templates["invoke-human-1.l1.t1.a1"]), key, runId: "exact-successor" };
                if (input.mode.startsWith("pending")) { originals.set(key, { key, runId: "exact-successor", ok: true, state: "running" }); throw Error("Controlled post-launch transport loss"); }
              } else response = structuredClone(input.templates[key]);
              if (!response) throw Error("Unplanned child " + key);
              originals.set(key, response); originals.set(response.runId, response);
              return response;
            },
            status: async ref => { statuses.push(ref); const found = originals.get(ref); if (!found) throw Error("Unknown exact native reference"); return structuredClone(found); },
            host: async key => ({ key, kind: "command", ok: true, state: "passed", exitCode: 0, stderr: "", durationMs: 0,
              outputPath: "/native/" + key + ".log", stdout: JSON.stringify(key === "execute-settings" ? {maxCycles: 3} :
                key.startsWith("input-") ? {digest: input.metadata.selected.digest, content: input.content} : {...input.metadata, checkout: input.checkout, admission: {maxCycles: 3}}) }),
          };
          const first = await runWorkflowScript(options);
          cut = false;
          if (input.mode === "pending-settled") {
            const completed = { ...structuredClone(input.templates["invoke-human-1.l1.t1.a1"]), key: resumeKey, runId: "exact-successor" };
            originals.set(resumeKey, completed); originals.set(completed.runId, completed);
          }
          const second = input.mode === "complete" ? null : await runWorkflowScript(options);
          const third = second?.value?.status === "complete" ? await runWorkflowScript(options) : null;
          console.log(JSON.stringify({third: third?.value, first: first.value, second: second?.value, calls, statuses, invocation: storage.get("invoke-human-1")}));
        }).catch(error => {console.error(error); process.exitCode=1;});
    `], { cwd: root, env: { ...globalThis.process.env, PI_CODING_AGENT_DIR: path.join(root, "private-agent") }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(process.stdout).text(), stderr = new Response(process.stderr).text();
    process.stdin.write(JSON.stringify({script: resolved.resource.script, templates, metadata, content, checkout, mode}));
    process.stdin.end();
    const [exit, output, errors] = await Promise.all([process.exited, stdout, stderr]);
    expect(exit, errors).toBe(0);
    expect(errors).not.toContain("unawaited runs.run launch(es)");
    const observed = JSON.parse(output);
    expect(observed.calls.filter((call: any) => call.key.endsWith(".resume"))).toHaveLength(1);
    expect(observed.calls.filter((call: any) => call.key.endsWith(".t1.a1"))).toHaveLength(1);
    expect(observed.invocation.loops).toHaveLength(1);
    expect(observed.calls.some((call: any) => call.key.includes(".restore"))).toBe(false);
    expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("Existing interrupted-unit WIP");
    if (mode === "pending") {
      expect(observed.second.status).not.toBe("complete");
      expect(observed.calls.some((call: any) => call.key.endsWith(".t2.a1"))).toBe(false);
      expect(observed.calls.some((call: any) => call.key.endsWith(".compliance"))).toBe(false);
    } else {
      expect((observed.second ?? observed.first).status).toBe("complete");
      expect(observed.calls.filter((call: any) => call.key.endsWith(".t2.a1"))).toHaveLength(1);
      expect(observed.calls.filter((call: any) => call.key.endsWith("director-synthesis"))).toHaveLength(1);
      expect(observed.calls.filter((call: any) => call.key.endsWith(".compliance"))).toHaveLength(1);
      expect(observed.invocation.loops[0].cursor).toBe(2);
      expect(observed.invocation.loops[0].results.map((result: any) => [result.taskId, result.status, result.attempt]))
        .toEqual([["repair", "complete", 1], ["final", "complete", 1]]);
      if (mode !== "complete") expect(observed.third.status).toBe("complete");
      expect(observed.invocation.loops[0].results[0].ref).toMatchObject({ runId: "exact-successor",
        resumedFrom: {runId: "native-invoke-human-1.l1.t1.a1"} });
    }
  });

// Rejects a prompt-only resume claim or a replacement root that loses the saved
// invocation. The public native resume dispatcher and mission state remain real;
// only host checks and model-facing child responses are controlled.
test("registered Node public root resume consumes durable results and closes the same invocation", async () => {
  const root = repository();
  const child = Bun.spawn(["node", "--disable-warning=ExperimentalWarning", "-e", `
    const fs = require("node:fs"), path = require("node:path"), {pathToFileURL} = require("node:url");
    const {registerHooks, stripTypeScriptTypes} = require("node:module");
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    const base = input.packageRoot + "/node_modules/pi-subagents/src/";
    const workflowURL = pathToFileURL(base + "workflows/scripted-workflow.js").href;
    registerHooks({load(url, context, next) {
      if (url === workflowURL) return {format:"module", shortCircuit:true, source:
        'export * from ' + JSON.stringify(url + '?original') + '; import {runWorkflowScript as run} from ' + JSON.stringify(url + '?original') +
        '; export function runWorkflowScript(options) { return run({...options, ...globalThis.controlledBoundary}); }'};
      if (url.startsWith(pathToFileURL(input.packageRoot + "/extensions/").href) && url.endsWith(".ts"))
        return {format:"module", shortCircuit:true, source:stripTypeScriptTypes(fs.readFileSync(new URL(url), "utf8"), {sourceUrl:url})};
      return next(url, context);
    }});
    (async () => {
      const {createSubagentExecutor} = await import(pathToFileURL(base + "runs/foreground/subagent-executor.js"));
      const {runWorkflowScript} = await import(workflowURL + '?original');
      const {prepareMissionLaunch} = await import(pathToFileURL(base + "missions/lifecycle.js"));
      const {createMissionWorkflowState, missionStatePath} = await import(pathToFileURL(base + "missions/workflow-state.js"));
      const {writeWorkflowLaunchRecord} = await import(pathToFileURL(base + "workflows/workflow-launch-record.js"));
      const {workflowScriptDigest} = await import(pathToFileURL(base + "workflows/workflow-reuse.js"));
      const {DIRS} = await import(pathToFileURL(base + "shared/types.js"));
      const {resolveWorkflowResource} = await import(pathToFileURL(base + "workflows/workflow-resources.js"));
      const {default: planExecute} = await import(pathToFileURL(input.packageRoot + "/extensions/plan-execute.ts"));
      const sessionId = require("node:crypto").randomUUID(), sourceId = require("node:crypto").randomUUID();
      const mission = prepareMissionLaunch({params:{mission:{title:"Controlled root resume"}}, projectRoot:input.root, ownerSessionId:sessionId});
      const missionPath = missionStatePath(mission.location, mission.missionId);
      const args = {root:input.root, id:"assignment", invocation:"human-1", missionId:mission.missionId, missionPath};
      const hooks = new Map(), ctx = {cwd:input.root, sessionManager:{getSessionId:()=>sessionId, getSessionFile:()=>null}, hasUI:false};
      planExecute({on:(name, hook)=>hooks.set(name, hook)});
      hooks.get("session_start")({},ctx);
      const resolved = resolveWorkflowResource("pitako.execute", args, sessionId);
      if (!resolved.ok) throw Error(resolved.error);
      const script = resolved.resource.script, calls = [], content = "COMPLETE SPEC SNAPSHOT";
      const metadata = {root:input.root, commonDir:path.join(input.root,".git"), candidates:[],
        selected:{source:path.join(input.root,".pitako/plans/assignment.md"), digest:input.digest, chunks:1}};
      const response = eval('(' + input.response + ')');
      const originals = new Map();
      const boundary = {
        resolveResume:async ref=>{if (!originals.has(ref)) throw Error("Unknown controlled child " + ref); return ref;},
        launch:async (key, request)=>{
          calls.push(key);
          const result = response(key, request, metadata, input.checkout);
          if (key.endsWith(".director")) Object.assign(result.structuredOutput.association,{missionId:mission.missionId, missionPath});
          originals.set(key,result); originals.set(result.runId,result);
          return result;
        },
        status:async ref=>{const result = originals.get(ref); if (!result) throw Error("Unexpected retained query " + ref); return structuredClone(result);},
        host:async key=>({key,kind:"command",ok:true,state:"passed",exitCode:0,stderr:"",durationMs:0,outputPath:"/controlled/"+key+".log",
          stdout:JSON.stringify(key === "execute-settings" ? {maxCycles:3} : key.startsWith("input-") ? {digest:input.digest,content} : {...metadata,checkout:input.checkout,admission:{maxCycles:3}})}),
      };
      const state = createMissionWorkflowState(mission.location, mission.missionId);
      let cut = false;
      const seeded = await runWorkflowScript({script, ...boundary, state:{get:key=>state.get(key),set:(key,value)=>{
        state.set(key,value);
        if (!cut && value.loops?.[0]?.attempt?.stage === "result") {cut=true;throw Error("Controlled root interruption after durable result");}
      }}});
      if (!cut) throw Error("Did not reach durable cut");
      const before = JSON.parse(fs.readFileSync(missionPath,"utf8"))["invoke-human-1"];
      const params = {workflow:"pitako.execute",args,cwd:input.root,async:true,missionId:mission.missionId};
      const sourceDir = path.join(DIRS.async,sourceId);
      fs.mkdirSync(sourceDir,{recursive:true});
      fs.writeFileSync(path.join(sourceDir,"status.json"),JSON.stringify({runId:sourceId,sessionId,mode:"workflow",state:"stopped",cwd:input.root,
        workflow:{scriptDigest:workflowScriptDigest(script),stopCause:"owner-exited"}}));
      writeWorkflowLaunchRecord(sourceDir,{version:1,source:"resource",params,scriptDigest:workflowScriptDigest(script)});
      let settle;
      const settled = new Promise(resolve=>settle=resolve);
      globalThis.controlledBoundary = {...boundary};
      // Observe settlement without replacing the executor's native state adapter.
      const nativeState = {asyncJobs:new Map(),foregroundRuns:new Map(),foregroundControls:new Map(),currentSessionId:sessionId};
      const pi = {sendMessage:()=>{},events:{emit:()=>{}}};
      const executor = createSubagentExecutor({pi,state:nativeState,config:{defaultSessionDir:path.join(input.root,"sessions")},asyncByDefault:true,
        tempArtifactsDir:path.join(input.root,"artifacts"),getSubagentSessionRoot:()=>path.join(input.root,"sessions"),expandTilde:p=>p,
        discoverAgents:()=>({agents:[]}),refreshResultDelivery:()=>{
          const claim = JSON.parse(fs.readFileSync(path.join(sourceDir,"resumed-by.1.json"),"utf8"));
          const file = path.join(DIRS.async,claim.newRunId,"status.json");
          if (fs.existsSync(file) && ["complete","failed","stopped"].includes(JSON.parse(fs.readFileSync(file,"utf8")).state)) settle();
        }});
      const resumed = await executor.executePublic("public-resume",{action:"resume",id:sourceId},new AbortController().signal,undefined,ctx);
      if (resumed.isError) throw Error(JSON.stringify(resumed));
      await settled;
      const claim = JSON.parse(fs.readFileSync(path.join(sourceDir,"resumed-by.1.json"),"utf8"));
      const successor = JSON.parse(fs.readFileSync(path.join(DIRS.async,claim.newRunId,"status.json"),"utf8"));
      const final = JSON.parse(fs.readFileSync(missionPath,"utf8"))["invoke-human-1"];
      const again = await executor.executePublic("public-resume-again",{action:"resume",id:sourceId},new AbortController().signal,undefined,ctx);
      hooks.get("session_shutdown")({},ctx);
      console.log(JSON.stringify({before,final,calls,resumed,again,sourceId,successor,claim,seeded:seeded.value}));
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root,"private-agent"), PI_SUBAGENTS_TEMP_ROOT:path.join(root,"native") }, stdin:"pipe",stdout:"pipe",stderr:"pipe" });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  child.stdin.write(JSON.stringify({packageRoot:path.resolve("."),root,response:childResponse.toString(),checkout,digest:digest("COMPLETE SPEC SNAPSHOT")}));
  child.stdin.end();
  const [exit,output,errors] = await Promise.all([child.exited,stdout,stderr]);
  expect(exit,errors).toBe(0);
  expect(errors).not.toContain("unawaited runs.run launch(es)");
  const observed = JSON.parse(output);
  expect(observed.before.loops[0].attempt.stage).toBe("result");
  expect(observed.final.loops[0].outcome, JSON.stringify(observed.successor.workflow.value)).toBe("complete");
  expect(observed.final.association.maxCycles).toBe(3);
  expect(observed.successor.workflow.value.invocation).toBe("human-1");
  expect(observed.successor.workflow.value.loopsConsumed).toBe(1);
  expect(observed.final.loops).toHaveLength(1);
  expect(observed.final.loops[0].cursor).toBe(1);
  expect(observed.calls.filter((key:string)=>key.endsWith(".t1.a1"))).toHaveLength(1);
  expect(observed.calls.filter((key:string)=>key.endsWith("director-synthesis"))).toHaveLength(1);
  expect(observed.calls.filter((key:string)=>key.endsWith(".compliance"))).toHaveLength(1);
  expect(observed.successor.workflow.resumeOrigin).toMatchObject({sourceRunId:observed.sourceId,attempt:1});
  expect(observed.successor.workflow.value.status).toBe("complete");
  expect(observed.again.isError).toBe(true);
  expect(JSON.stringify(observed.again.content)).toContain(observed.claim.newRunId);
});
