import { afterAll, afterEach, expect } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowScriptChildResult } from "../../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import registerPlanExecute, { executionResource } from "../../extensions/plan-execute.ts";
import { preliminarySpec, SPEC_SECTIONS } from "../../extensions/spec-plans.ts";

// Shared by tests/plan-execute-composition-*.test.ts. Mutable state lives in the
// per-file factories below: each test file owns its roots, disposers, settlements
// and native Node process, even when Bun loads several files in one process.

// Existing workflow fixtures isolate the external agent registration boundary.
export function planExecute(pi: ExtensionAPI) {
  registerPlanExecute({ ...pi, events: pi.events ?? { emit: (_name: string, request: any) => {
    request.result = { ok: true, registration: { dispose() {} } };
  } } } as ExtensionAPI);
}

export const checkout = { head: "a".repeat(40), fingerprint: "b".repeat(64) };

// Node handles SIGTERM only after execFileSync returns. A killed parent alone
// cannot certify release; absent this witness, teardown retains the owned roots.
export function synchronousHostRelease(marker: string) {
  return `
    let hostPending = false;
    process.on('SIGTERM',()=>process.exit(143));
    process.on('exit',()=>{if(!hostPending)require('node:fs').writeFileSync(${JSON.stringify(marker)},'released');});
  `;
}
export const read = (name: string) => readFileSync(path.resolve(name), "utf8");
export function assignmentSpec(root: string) {
  const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`;
  const source = path.join(root, ".pitako/plans/assignment.md");
  mkdirSync(path.dirname(source), { recursive: true }); writeFileSync(source, content);
  return preliminarySpec(root, "assignment");
}
export function missionFiles(root: string) {
  const missionPath = path.join(root, "native.mission-1.json");
  const statePath = path.join(root, "native.mission-1", "state.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(missionPath, JSON.stringify({ schemaVersion: 1, id: "native.mission-1", title: "Fixture mission" }));
  return { missionPath, statePath };
}
export function resourceWithAgentDir(agentDir: string) {
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try { return executionResource("linux"); }
  finally { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; }
}

// Controlled child boundary: actual root/review scripts execute in the native sandbox.
// Responses implement schemas only; no provider or model obedience is certified.
export function childResponse(key: string, request: any, metadata: any, checkout: any, completeLoop = 1, suppliedValue?: any) {
  const loop = Number(key.match(/\.l(\d+)\./)?.[1] ?? 1);
  if (request.agent === "pitako.execution-ledger") {
    const pending = JSON.parse(request.task);
    return { key, ok: true, agent: request.agent, runId: `native-${key}`, asyncDir: `/native/async/${key}`,
      output: JSON.stringify({ count: Math.max(1, pending.expected.count) + 1, head: "c".repeat(64), ...(pending.record.kind === "loop" ? { summaries: [{ loop, status: "gaps", gaps: "", review: "", compliance: "", rejection: pending.record.body.plan?.rejection?.diagnostic ?? "" }] } : {}) }),
      externalAdapter: { outputArtifacts: { stdoutPath: `/native/async/${key}/stdout.log`, stderrPath: `/native/async/${key}/stderr.log` } },
      results: [{ exitCode: 0 }] } as WorkflowScriptChildResult;
  }
  if (request.agent === "pitako.checkout-observer") return { key, ok: true,
    agent: request.agent, runId: `native-${key}`, asyncDir: `/native/async/${key}`, artifactPaths: [],
    output: JSON.stringify({ version: 1, ok: true, ledger: { count: Math.max(1, (request.task ? JSON.parse(request.task).expected.count : 0)) + 1, head: "c".repeat(64) }, root: metadata.root, commonDir: metadata.commonDir,
      summaries: [{ loop, status: "gaps", gaps: "", review: "", compliance: "", rejection: "" }], checkout: { ...checkout } }), results: [{ index: 0, agent: request.agent, task: request.task ?? "", exitCode: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }],
    externalAdapter: {
      adapter: { id: "external-cli", version: 1, executionMode: "one-shot-stdin" },
      capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false,
        supervisor: "unsupported", forkContext: false, extensionBindings: false },
      handoff: { mode: "fresh" }, supervisor: { mode: "unsupported", reason: "Fixed one-shot observer" },
      nonResumableReason: "Fixed one-shot observer", outputArtifacts: { stdoutPath: `/native/async/${key}/stdout.log`, stderrPath: `/native/async/${key}/stderr.log` } } } satisfies WorkflowScriptChildResult;
  let value: any;
  const task = { id: "final", kind: "verification", goal: "Verify complete candidate", contextRefs: ["full spec"],
    sourceRefs: [metadata.selected.source], scope: [metadata.root], allowedEffects: ["checks"], expectedResult: "Current required checks", dependsOn: [],
    checks: [{ id: "final-check", requirement: "All specs", command: "bun test affected", cwd: metadata.root }] };
  if (suppliedValue) value = suppliedValue;
  else if (key.endsWith(".director")) value = { status: "plan", reason: "Complete ordered work", association: {
    missionId: "native.mission-1", missionPath: "/native/actual-mission.json", invocation: "human-1", loop, maxCycles: 3, sourceRefs: [],
    root: metadata.root, commonDir: metadata.commonDir, source: metadata.selected.source, digest: metadata.selected.digest,
  }, sharedContext: { material: "Full shared context", references: [metadata.selected.source] }, tasks: [task] };
  else if (request.agent === "pitako.worker") value = { taskId: "final", attempt: 1, status: "complete", workDone: "Required checks executed",
    remaining: [], diagnosis: "No pending task work", usefulProgress: true, continuation: null,
    git: { head: checkout?.head, checkpoints: [], wip: "Current WIP included" }, candidate: checkout,
    checks: task.checks.map(({ requirement: _requirement, ...check }) => ({ ...check, output: "Controlled check passed", logPaths: ["/native/check.log"], result: "passed", before: checkout, after: checkout })) };
  else if (key.endsWith(".demand-observation")) value = { memo: "Inherited demands remain advisory",
    evidenceLimits: ["Controlled source evidence only"], observations: [] };
  else if (key.endsWith("director-prepare")) value = { status: "ready", reason: "Whole result perspectives", angles: [
    { id: "a", focus: "Correctness", skills: [] }, { id: "b", focus: "Requirements", skills: [] }] };
  else if (key.includes("independent-")) value = { status: "ready", reason: "Source inspected", coverage: "Complete candidate", findings: [] };
  else if (key.endsWith("director-synthesis")) value = { status: "ready", reason: "No material gaps", memo: "Whole-result analysis",
    dispositions: [], screening: { verdict: "clear", reason: "Current candidate inspected", assessments: [] } };
  else if (key.endsWith(".compliance")) value = { status: loop >= completeLoop ? "fulfilled" : "gaps", reason: "Complete requirement inventory",
    candidate: checkout, requirements: Array.from({ length: 17 }, (_, index) => ({ id: `criterion-${index + 1}`, source: `spec:criterion-${index + 1}`,
      reason: "Current source/check evidence", status: loop >= completeLoop ? "fulfilled" : "gap", evidence: ["src/entry.ts:1"], checks: ["/native/check.log"] })) };
  else throw Error(`Unexpected child ${key}`);
  const results: any[] = [];
  if (request.phase?.startsWith("review-")) {
    // The harness passes its file-owned fs boundary, including in Node children.
    const fs = require("node:fs");
    const association = Object.fromEntries(Object.entries(request.outputSchema.properties.association.properties)
      .map(([name, schema]: [string, any]) => [name, schema.const]));
    const required = JSON.parse(request.task.split("ESSENTIAL ORIGINALS (data): ")[1].split("\n")[0]);
    const access = required.map((entry: any) => {
      const original = JSON.parse(fs.readFileSync(entry.results.find((item: any) => item.savedOutputPath).savedOutputPath, "utf8"));
      if (original.association.key !== entry.key || original.delivery !== "complete") throw Error("Wrong exact original");
      return { id: entry.id, state: "accessible", source: "read", reason: "Exact associated original retrieved" };
    });
    value = { ...value, association, delivery: "complete", access };
    const savedOutputPath = metadata.root + "/.pi/subagents/review-originals/" + key + ".json";
    fs.mkdirSync(metadata.root + "/.pi/subagents/review-originals", { recursive: true });
    fs.writeFileSync(savedOutputPath, JSON.stringify(value));
    results.push({ savedOutputPath, outputReference: { path: savedOutputPath }, exitCode: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } });
  }
  return { key, ok: true, output: "", runId: `native-${key}`, agent: request.agent ?? "pitako.reviewer", artifactPaths: [], results, structuredOutput: value };
}
// Controlled child loading boundary: use the launch binding emitted by the real root,
// never construct an intention or tool result. Factory registration and publication are real.
export async function registeredCheckpoint(request: any, root: string, loadExtensions: any, toolPath: string, key: string) {
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

export function compositionFixture() {
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
    consume: (observation: [number, string, string]) => T,
    release?: { marker: string; roots: string[] }) {
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
        if (release && !existsSync(release.marker)) {
          for (const root of release.roots) {
            const index = roots.indexOf(root);
            if (index !== -1) roots.splice(index, 1);
          }
          console.error("Retained checkpoint roots: descendant release unconfirmed", release.roots);
        }
        checkpointCancellations.delete(cancel);
      }
    })();
    // Observe rejection immediately, including when the runner abandons its await.
    // The original result still rejects for the caller; this only owns settlement.
    const settled = result.then(() => {}, () => {});
    workflowSettlements.push(settled);
    return { result, observed, settled, cancel };
  }
  function repository() {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-workflow-resource-")); roots.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"); return root;
  }
  return { roots, disposers, workflowSettlements, checkpointCancellations, settleWorkflows, checkpointLifecycle, repository };
}
export type CompositionFixture = ReturnType<typeof compositionFixture>;

// One file-owned Node process amortizes native SDK/provider loading. Each message
// still creates fresh storage, roots and launch-bound tool registrations. Cases
// are awaited by the file's normal test order; other files remain parallel.
export function nativeCheckpointFixture({ workflowSettlements, checkpointCancellations }: CompositionFixture) {
  let nativeCheckpoint: ReturnType<typeof spawn> | undefined;
  let nativeCheckpointRoot: string;
  let nativeCheckpointExit: Promise<[number, string, string]>;
  let nativeCheckpointReply: ((value: [number, string, string] | undefined) => void) | undefined;
  const nativeCheckpointExits: { promise: Promise<[number, string, string]>; cancelled: boolean }[] = [];
  // Settlement-only harness cases pass `sdk: false`: process, IPC and stream
  // ownership do not depend on the SDK, which otherwise loads once before ready.
  async function startNativeCheckpoint({ sdk = true } = {}) {
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
      let loaded;
      const sdk=()=>loaded??=(async()=>{
        const {runWorkflowScript}=await import(${JSON.stringify(new URL("../../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href)});
        const loadExtensions=(await import(${JSON.stringify(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url).href)})).loadExtensionsCached;
        await loadExtensions([${JSON.stringify(path.resolve("extensions/checkpoint-create.ts"))}],process.cwd());
        return {runWorkflowScript,loadExtensions};
      })();
      (async()=>{
        if(${sdk})await sdk();
        process.on('message',async ({input,harness})=>{
          const prior=process.env.PI_CODING_AGENT_DIR, cwd=process.cwd();
          try {
            process.chdir(input.root);process.env.PI_CODING_AGENT_DIR=input.agentDir;
            const {runWorkflowScript,loadExtensions}=input.sdk===false?{}:await sdk();
            const value=await (0,eval)('('+harness+')')(input,runWorkflowScript,${childResponse.toString()},
              input.sdk===false?{}:{...require('node:fs'),...require('node:child_process'),...await import(input.module??input.checkpointModule),...await import(input.evidence??input.evidenceModule),loadExtensions,hash:data=>require('node:crypto').createHash('sha256').update(data).digest('hex')},${registeredCheckpoint.toString()});
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
  afterAll(async () => {
    if (nativeCheckpoint?.connected) nativeCheckpoint.disconnect();
    for (const operation of nativeCheckpointExits) {
      const [exit, , errors] = await operation.promise;
      expect(exit, errors).toBe(operation.cancelled ? 143 : 0);
      expect(errors).not.toContain("unawaited runs.run launch(es)");
    }
    if (nativeCheckpointRoot) rmSync(nativeCheckpointRoot, { recursive: true, force: true });
  });
  async function nativeCheckpointCase(input: any, harness: string) {
    if (!nativeCheckpoint) await startNativeCheckpoint();
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
    module: new URL("../../extensions/execute-checkpoint.ts", import.meta.url).href,
    evidence: new URL("../../extensions/spec-plans.ts", import.meta.url).href });
  return {
    get nativeCheckpoint() { return nativeCheckpoint; },
    get nativeCheckpointRoot() { return nativeCheckpointRoot; },
    nativeCheckpointExits, startNativeCheckpoint, nativeCheckpointCase, nativeCheckpointInput,
  };
}
export type NativeCheckpointFixture = ReturnType<typeof nativeCheckpointFixture>;
