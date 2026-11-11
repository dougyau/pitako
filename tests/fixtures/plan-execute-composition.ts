import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowScriptChildResult } from "../../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import registerPlanExecute, { executionResource } from "../../extensions/plan-execute.ts";
import { preliminarySpec, SPEC_SECTIONS } from "../../extensions/spec-plans.ts";
import { expectProcessBudget, type Processes } from "./process-budget.ts";
import { gitFakeFixture } from "./git-fake-fixture.ts";
import { gitFakeBootstrap } from "./git-fake-env.ts";

// Controller tests control external dispatch; native wiring cases retain the real SDK runner.
export async function controlledWorkflow(options: any) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const emits: any[] = [];
  const runs = {
    all: (requests: any[]) => Promise.all(requests.map(async ({ key, ...request }) => {
      try { return await options.launch(key, request); }
      catch (error) { const text = error instanceof Error ? error.message : String(error); return { key, ok: false, output: text, error: text, artifactPaths: [] }; }
    })),
    status: (ref: string) => options.status(ref),
    host: async (key: string, request: any) => {
      const result = await options.host(key, request);
      if (!result.ok) {
        const detail = [result.error, result.stderr.trim() || result.stdout.trim()].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
        throw Error("Host command '" + key + "' failed: " + (detail || result.error || "exit code " + (result.exitCode ?? "unknown")));
      }
      return result;
    },
  };
  const value = await new AsyncFunction("runs", "state", "emit", options.script)(runs,
    { get: async (key: string) => options.state.get(key), set: async (key: string, value: unknown) => options.state.set(key, value) },
    (value: unknown) => { emits.push(value); options.onEmit?.(emits); });
  return { value, emits };
}

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

// Absolute script paths survive stringified childResponse use in subprocesses with another cwd.
export const deterministicScripts = { verifier: path.resolve("extensions/access-receipts.mjs"), sealer: path.resolve("skills/execute/checkpoint.mjs"), loopIO: path.resolve("skills/execute/loop-io.mjs"), loopModule: path.resolve("skills/execute/loop.ts") };
// Controlled child boundary: actual root/review scripts execute in the native sandbox.
// Responses implement schemas only; no provider or model obedience is certified.
export function childResponse(key: string, request: any, metadata: any, checkout: any, completeLoop = 1, suppliedValue?: any): any {
  const loop = Number(key.match(/\.l(\d+)\./)?.[1] ?? 1);
  if (request.agent === "pitako.request-observer") return { key, ok: true, agent: request.agent,
    runId: `native-${key}`, artifactPaths: [], output: JSON.stringify({ version: 1, ok: true,
      invocation: JSON.parse(request.task).invocation, requests: [], next: null }), results: [{ index: 0, agent: request.agent!, task: request.task, exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] } as WorkflowScriptChildResult;
  if (request.agent === "pitako.access-verifier") {
    // The real verifier over the actual published originals. Fixture mission
    // records under /native are relocated beside the owned checkout metadata.
    const input = JSON.parse(request.task), path = require("node:path"), fs = require("node:fs");
    const missionPath = path.join(metadata.root, ".pi/subagents/native-missions", path.basename(input.missionPath));
    fs.mkdirSync(path.dirname(missionPath), { recursive: true });
    // The verifier uses absolute paths; no cold process or cwd change is needed.
    return (async () => {
      const { verifyGate } = await import(require("node:url").pathToFileURL(metadata.verifier ?? path.resolve("extensions/access-receipts.mjs")).href);
      return { key, ok: true, agent: request.agent, runId: `native-${key}`,
        output: JSON.stringify(verifyGate({ ...input, missionPath })), results: [{ index: 0, agent: request.agent!, task: request.task, exitCode: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] };
    })();
  }
  if (request.agent === "pitako.loop-io") {
    const input = JSON.parse(request.task);
    if (input.operation === "taskDelta" && process.cwd() !== metadata.root && metadata.runDeterministic)
      return metadata.runDeterministic(key, request, metadata, checkout);
    if (["advance", "selection", "close", "drain"].includes(input.operation)) return (async () => {
      if (process.cwd() !== metadata.root && metadata.runDeterministic)
        return metadata.runDeterministic(key, request, metadata, checkout);
      const { operation, ...params } = input;
      const dbPath = metadata.boardPath ?? metadata.root + "/.pi/board.db";
      for (const name of ["prepare", "apply", "gate"]) if (params[name]) params[name].dbPath = dbPath;
      for (const intention of params.intentions ?? []) if (intention.operation === "apply") intention.input.dbPath = dbPath;
      const artifacts = { asyncDir: `/native/async/${key}`, externalAdapter: {
        outputArtifacts: { stdoutPath: `/native/async/${key}/stdout.log`, stderrPath: `/native/async/${key}/stderr.log` } } };
      if (process.cwd() !== metadata.root) {
        const command = require("node:child_process").spawnSync("node", [metadata.loopIO ?? require("node:path").resolve("skills/execute/loop-io.mjs")], {
          cwd: metadata.root, input: JSON.stringify({ operation, ...params }), encoding: "utf8",
          env: { ...process.env, NODE_COMPILE_CACHE: metadata.root + "/.pi/node-compile-cache" },
        });
        return { key, ok: command.status === 0, agent: request.agent, runId: `native-${key}`, ...artifacts,
          output: command.stdout, results: [{ exitCode: command.status }] };
      }
      const runtime = await import(require("node:url").pathToFileURL(metadata.loopIO).href);
      try {
        const reference = operation === "drain" ? await runtime.drain(params, metadata.groupedHooks)
          : await runtime.grouped(operation, params, metadata.groupedHooks);
        return { key, ok: true, agent: request.agent, runId: `native-${key}`, ...artifacts,
          output: JSON.stringify(runtime.receiptTransport(reference)), results: [{ exitCode: 0 }] };
      } catch (error: any) {
        return { key, ok: false, agent: request.agent, runId: `native-${key}`, ...artifacts, results: [{ exitCode: 1 }],
          output: JSON.stringify({ error: "loop-io", reason: error.message, selectionRejected: error.selectionRejected === true,
            replayRejected: error.replayRejected === true, viewOverflow: error.viewOverflow === true }) };
      }
    })();
    // Reuse actual persistence/Board operations without a Node/TypeScript startup per call.
    if (input.operation === "taskDelta" && process.cwd() !== metadata.root && metadata.runDeterministic)
      return metadata.runDeterministic(key, request, metadata, checkout);
    if (input.operation === "taskDelta" && process.cwd() === metadata.root) return (async () => {
      const runtime = await import(require("node:url").pathToFileURL(metadata.loopIO ?? require("node:path").resolve("skills/execute/loop-io.mjs")).href);
      const { operation, ...params } = input;
      try {
        return { key, ok: true, agent: request.agent, runId: `native-${key}`,
          output: JSON.stringify(runtime.taskDelta(params)), results: [{ exitCode: 0 }] };
      } catch (error: any) {
        return { key, ok: false, agent: request.agent, runId: `native-${key}`,
          output: JSON.stringify({ error: "loop-io", reason: error.message }), results: [{ exitCode: 1 }] };
      }
    })();
    if (input.operation !== "gate" && metadata.loopOperations?.[input.operation]) return (async () => {
      try {
        const { operation, ...params } = input;
        params.dbPath = metadata.boardPath ?? metadata.root + "/.pi/board.db";
        const value = await metadata.loopOperations[operation](params);
        if (operation === "apply") {
          const prepared = await metadata.loopOperations.prepare({ root: params.root, specId: params.specId,
            previousConfirmedUnit: null, taskId: value.selected?.id, invocation: params.invocation, loop: params.loop, dbPath: params.dbPath });
          if (prepared.digest !== value.digest) throw Error("backlog-conflict: " + prepared.path);
          value.view = prepared.view;
        }
        const { backlog, ...receipt } = value;
        if (backlog) receipt.acceptance = backlog.acceptance;
        return { key, ok: true, agent: request.agent, runId: `native-${key}`,
          output: JSON.stringify(receipt), results: [{ exitCode: 0 }] };
      } catch (error: any) {
        return { key, ok: false, agent: request.agent, runId: `native-${key}`, results: [{ exitCode: 1 }],
          output: JSON.stringify({ error: "loop-io", reason: error.message, selectionRejected: error.selectionRejected === true }) };
      }
    })();
    if (input.operation !== "gate") {
      const command = require("node:child_process").spawnSync("node", [metadata.loopIO ?? require("node:path").resolve("skills/execute/loop-io.mjs")], {
        cwd: metadata.root, input: JSON.stringify({ ...input, dbPath: metadata.boardPath ?? metadata.root + "/.pi/board.db" }), encoding: "utf8",
      });
      return { key, ok: command.status === 0, agent: request.agent, runId: `native-${key}`,
        output: command.stdout, results: [{ exitCode: command.status }] } as WorkflowScriptChildResult;
    }
    // Controlled command boundary; loop module tests own gate command execution.
    const gates = input.workerStatus === "complete" || !input.task.metric ? input.task.gates.map((gate: any) => ({
      id: gate.id, status: "pass", exit: 0, ms: 1, tail: "Controlled gate passed", logRef: `/native/gates/${key}/${gate.id}.log`,
    })) : [];
    const sample = { value: input.task.metric?.target ?? null, best: input.task.metric?.target ?? null,
      fingerprint: checkout.fingerprint, gatesPassed: gates.length, gatesTotal: input.task.gates.length };
    return { key, ok: true, agent: request.agent, runId: `native-${key}`,
      output: JSON.stringify({ before: checkout, after: checkout, mutated: false, gates,
        metric: input.task.metric ? { value: input.task.metric.target, error: null } : null,
        progress: { nonImproving: 0, last5: [...input.task.progress.last5, sample].slice(-5) }, stalled: false,
        view: { topicId: 1, authority: "spec and frozen amendments > DECISION > FINDING > HANDOFF; code wins over any map", posts: [], omitted: 0 } }),
      results: [{ exitCode: 0 }] } as WorkflowScriptChildResult;
  }
  if (request.agent === "pitako.checkpoint-sealer") {
    const input = JSON.parse(request.task);
    const manifest = metadata.root + "/.pi/subagents/checkpoints/" + input.intent.key + "/manifest.json";
    if (process.cwd() !== metadata.root && metadata.runDeterministic &&
        (require("node:fs").existsSync(manifest) || input.restoreSources))
      return metadata.runDeterministic(key, request, { ...metadata, inlineSealer: true }, checkout);
    const output = metadata.sealCheckpointRequest ? JSON.stringify(metadata.sealCheckpointRequest(input))
      : require("node:fs").existsSync(manifest) || input.restoreSources ?
      require("node:child_process").execFileSync("node", [metadata.sealer ?? require("node:path").resolve("skills/execute/checkpoint.mjs"), "--seal-stdin"], {
        cwd: metadata.root, input: request.task, encoding: "utf8",
      }) : JSON.stringify({ v: 1, kind: input.kind, outcome: "observed", candidate: checkout });
    return { key, ok: true, agent: request.agent, runId: `native-${key}`, asyncDir: `/native/async/${key}`,
      output,
      externalAdapter: { outputArtifacts: { stdoutPath: `/native/async/${key}/stdout.log`, stderrPath: `/native/async/${key}/stderr.log` } },
      results: [{ exitCode: 0 }] } as WorkflowScriptChildResult;
  }
  if (request.agent === "pitako.execution-ledger") {
    const pending = JSON.parse(request.task);
    return { key, ok: true, agent: request.agent, runId: `native-${key}`, asyncDir: `/native/async/${key}`,
      output: JSON.stringify({ count: Math.max(1, pending.expected.count) + 1, head: "c".repeat(64), ...(pending.record.kind === "loop" ? { summaries: [{ loop, status: "gaps", gaps: "", review: "", compliance: "", rejection: pending.record.body.plan?.rejection?.diagnostic ?? "" }] } : {}) }),
      externalAdapter: { outputArtifacts: { stdoutPath: `/native/async/${key}/stdout.log`, stderrPath: `/native/async/${key}/stderr.log` } },
      results: [{ exitCode: 0 }] } as WorkflowScriptChildResult;
  }
  if (request.agent === "pitako.checkout-observer") {
    const observation = (ledger: any, summaries: any[]) => ({ key, ok: true,
    agent: request.agent, runId: `native-${key}`, asyncDir: `/native/async/${key}`, artifactPaths: [],
    output: JSON.stringify({ version: 1, ok: true, ledger, root: metadata.root, commonDir: metadata.commonDir,
      summaries, checkout: { ...checkout } }), results: [{ index: 0, agent: request.agent, task: request.task ?? "", exitCode: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }],
    externalAdapter: {
      adapter: { id: "external-cli", version: 1, executionMode: "one-shot-stdin" },
      capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false,
        supervisor: "unsupported", forkContext: false, extensionBindings: false },
      handoff: { mode: "fresh" }, supervisor: { mode: "unsupported", reason: "Fixed one-shot observer" },
      nonResumableReason: "Fixed one-shot observer", outputArtifacts: { stdoutPath: `/native/async/${key}/stdout.log`, stderrPath: `/native/async/${key}/stderr.log` } } } satisfies WorkflowScriptChildResult);
    if (!request.task) return observation({ count: 2, head: "c".repeat(64) }, [{ loop, status: "gaps", gaps: "", review: "", compliance: "", rejection: "" }]);
    return (async () => {
      const input = JSON.parse(request.task), { invocation, ...expected } = input.expected;
      const ledgerModule = await import(require("node:url").pathToFileURL(
        require("node:path").join(require("node:path").dirname(metadata.loopIO ?? require("node:path").resolve("skills/execute/loop-io.mjs")), "ledger.mjs")).href);
      const ledger = ledgerModule.appendLedger(metadata.root, invocation, { expected, ...input.body });
      return observation(ledger, ledgerModule.loopSummaries(metadata.root, invocation, ledger));
    })();
  }
  let value: any;
  if (suppliedValue) value = suppliedValue;
  else if (/\.director(?:\.d1)?$/.test(key)) {
    const file = metadata.root + "/.pitako/backlog/assignment.json";
    const backlog = require("node:fs").existsSync(file) ? JSON.parse(require("node:fs").readFileSync(file, "utf8")) : null;
    const initial = { id: "change", title: "Implement scoped behavior", goal: "Implement scoped behavior", expectedResult: "Required behavior implemented",
      status: "pending", origin: { kind: "spec", ref: metadata.selected.source }, specRefs: [metadata.selected.source], dependsOn: [],
      gates: [{ id: "focused", command: "true", cwd: metadata.root, timeoutMs: 1800000 }], metric: null,
      parent: null, remaining: "", progress: { nonImproving: 0, last5: [] }, history: [] };
    const pending = backlog?.tasks.filter((task: any) => task.status === "pending") ?? (metadata.withTask ? [initial] : []);
    value = { select: pending[0]?.id ?? null,
      changes: !backlog && metadata.withTask ? [{ kind: "add", task: initial, reason: "Implement the spec" }] : pending.filter((task: any) => !task.gates.length).map((task: any) => ({ kind: "update", id: task.id,
        patch: { gates: [{ id: "repair", command: "true", cwd: metadata.root, timeoutMs: 1800000 }] }, reason: "Assign focused repair gate" })),
      reason: "Most important pending task, otherwise final verification",
      ...(!backlog ? { acceptance: [{ id: "final-check", command: "true", cwd: metadata.root }] } : {}) };
  }
  else if (request.agent === "pitako.worker") value = { status: "complete", work: "Scoped behavior implemented",
    remaining: [], knowledge: { findings: [], handoff: "Current scoped source implements the required behavior." } };
  else if (/\.task-(reviewer|synthesis)$/.test(key)) value = {
    completeness: { verdict: "Complete", score: 10, findings: [] },
    correctness: { verdict: "Correct", score: 10, findings: [] },
    scope: { verdict: "In scope", score: 10, findings: [] }, conflict: false,
  };
  else if (key.endsWith(".demand-observation")) value = { memo: "Inherited demands remain advisory",
    evidenceLimits: ["Controlled source evidence only"], observations: [] };
  else if (key.endsWith("director-prepare")) value = { status: "ready", reason: "Whole result perspectives", angles: [
    { id: "a", focus: "Correctness", skills: [] }] };
  else if (key.includes("independent-")) value = { status: "ready", reason: "Source inspected", coverage: "Complete candidate", findings: [] };
  else if (key.endsWith("director-synthesis")) value = { status: "ready", reason: "No material gaps", memo: "Whole-result analysis",
    dispositions: [], screening: { verdict: "clear", reason: "Current candidate inspected", assessments: [] } };
  else if (key.endsWith(".compliance")) value = { status: loop >= completeLoop ? "fulfilled" : "gaps", reason: "Complete requirement inventory",
    candidate: checkout, requirements: Array.from({ length: 17 }, (_, index) => ({ id: `criterion-${index + 1}`, source: `spec:criterion-${index + 1}`,
      reason: "Current source/check evidence", status: loop >= completeLoop ? "fulfilled" : "gap", evidence: ["src/entry.ts:1"], checks: ["/native/check.log"] })) };
  else throw Error(`Unexpected child ${key}`);
  const results: any[] = [];
  if (request.phase?.startsWith("review-") || /\.task-(reviewer|synthesis)$/.test(key)) {
    // The harness passes its file-owned fs boundary, including in Node children.
    const fs = require("node:fs");
    const required = request.phase?.startsWith("review-")
      ? JSON.parse(request.task.split("ESSENTIAL ORIGINALS (data): ")[1].split("\n")[0]) : [];
    for (const entry of required) {
      const original = JSON.parse(fs.readFileSync(entry.results.find((item: any) => item.savedOutputPath).savedOutputPath, "utf8"));
      if (entry.association.key !== entry.key || entry.delivery !== "complete" || entry.runId !== `native-${entry.key}`)
        throw Error("Wrong exact original envelope");
      const path = require("node:path");
      const canonical = new Function(fs.readFileSync(path.resolve(path.dirname(metadata.verifier ?? path.resolve("extensions/access-receipts.mjs")), "../skills/workflow-canonical.js"), "utf8") + ";return canonicalDigest;")();
      require("node:assert/strict").equal(canonical(original), entry.digest, "Published original differs from admitted digest");
    }
    const savedOutputPath = metadata.root + "/.pi/subagents/review-originals/" + key + ".json";
    fs.mkdirSync(metadata.root + "/.pi/subagents/review-originals", { recursive: true });
    fs.writeFileSync(savedOutputPath, JSON.stringify(value));
    results.push({ savedOutputPath, outputReference: { path: savedOutputPath }, exitCode: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } });
  }
  if (key.endsWith(".compliance")) {
    const fs = require("node:fs");
    const structuredOutputPath = metadata.root + "/.pi/subagents/" + key + ".json";
    fs.mkdirSync(metadata.root + "/.pi/subagents", { recursive: true });
    fs.writeFileSync(structuredOutputPath, JSON.stringify(value));
    results.push({ structuredOutputPath, exitCode: 0 });
  }
  return { key, ok: true, output: "", runId: `native-${key}`, agent: request.agent ?? "pitako.reviewer", artifactPaths: [], results, structuredOutput: value };
}
// Controlled child loading boundary: use the launch binding emitted by the real root,
// never construct an intention or tool result. Factory registration and publication are real.
export async function registeredCheckpoint(request: any, root: string, loadExtensions: any, toolPath: string, key: string) {
  if (!request.task.includes('Write code with edit, write or apply_patch') ||
      request.task.includes('checkpoint_create({kind:"unit"})') ||
      request.task.includes('checkpoint_create({kind:"pause"})') ||
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

// Registered composition scenarios keep real captures and writer bytes, with declared Git identity.
export function realCheckoutCompositionFixture() {
  const fake = gitFakeFixture();
  const roots: string[] = [], disposers: (() => void)[] = [];
  const opaqueChildren = new Set<unknown>();
  let directChildren = 0;
  const countedExecFileSync = ((...args: Parameters<typeof execFileSync>) => {
    directChildren++;
    return execFileSync(...args);
  }) as typeof execFileSync;
  // Shared native runtimes are charged once per test they serve; descendants remain opaque.
  const recordOpaque = (child: unknown) => { opaqueChildren.add(child); };
  const processes = (): Processes => ({ sealer: 0, loopIO: 0, gates: 0, other: directChildren + opaqueChildren.size });
  const workflowSettlements: Promise<void>[] = [];
  const checkpointCancellations = new Set<() => void>();
  function ownWorkflow<T>(work: () => Promise<T>): Promise<T> {
    const result = work();
    workflowSettlements.push(result.then(() => {}, () => {}));
    return result;
  }
  async function settleWorkflows() {
    // A runner timeout does not settle a test's workflow continuation.
    do {
      for (const cancel of checkpointCancellations) cancel();
      await Promise.all(workflowSettlements.splice(0));
    } while (workflowSettlements.length);
  }
  afterAll(async () => { await settleWorkflows(); fake.dispose(); });
  afterEach(async () => {
    await settleWorkflows();
    for (const dispose of disposers.splice(0)) dispose();
    opaqueChildren.clear(); directChildren = 0;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function checkpointLifecycle<T>(child: Bun.Subprocess<"pipe", "pipe", "pipe">,
    consume: (observation: [number, string, string]) => T,
    release?: { marker: string; roots: string[] }) {
    directChildren++;
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
        return await consume(observation);
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
  function repository(options: Parameters<typeof fake.fakeRepo>[1] = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-workflow-resource-")); roots.push(root);
    fake.fakeRepo(root, { paths: ["owned", "unrelated", "earlier", "deleted", "created", "new", "product", "wip", "package.json"], ...options });
    mkdirSync(path.join(root, ".git/info"), { recursive: true });
    return root;
  }
  // Reuse a file-owned process: grouped operations require their real cwd,
  // but repeated cold loader processes are not part of the behavior under test.
  const runtime = nativeCheckpointFixture({ workflowSettlements, checkpointCancellations, settleWorkflows, recordOpaque });
  let useRuntime = false;
  beforeAll(async () => { if (useRuntime) await runtime.startNativeCheckpoint({ extension: false }); });
  const scripts = { ...deterministicScripts,
    runDeterministic: async (key: string, request: any, metadata: any, checkout: any) => {
      const result = await runtime.nativeCheckpointCase({ ...runtime.nativeCheckpointInput(),
        root: metadata.root, key, request, metadata, checkout }, `async (input, _, respond) =>
          respond(input.key, input.request, input.metadata, input.checkout)`);
      if (!result || result[0] !== 0) throw Error(result?.[2] ?? "Deterministic fixture cancelled");
      return JSON.parse(result[1]);
    } };
  return { fake, roots, disposers, workflowSettlements, checkpointCancellations, settleWorkflows, ownWorkflow, checkpointLifecycle, repository, processes, recordOpaque, runtime,
    execFileSync: countedExecFileSync,
    expectProcessBudget: (maximum: number) => expectProcessBudget(processes(), maximum),
    get scripts() { useRuntime = true; return scripts; } };
}
export type CompositionFixture = ReturnType<typeof realCheckoutCompositionFixture>;

// One file-owned process runs controlled boundaries; one case retains native SDK loading. Each message
// still creates fresh storage, roots and launch-bound tool registrations. Cases
// are awaited by the file's normal test order; other files remain parallel.
export function nativeCheckpointFixture({ workflowSettlements, checkpointCancellations, settleWorkflows, recordOpaque }: Pick<CompositionFixture, "workflowSettlements" | "checkpointCancellations" | "settleWorkflows" | "recordOpaque">) {
  let nativeCheckpoint: ReturnType<typeof spawn> | undefined;
  let nativeCheckpointRoot: string;
  let nativeCheckpointExit: Promise<[number, string, string]>;
  let nativeCheckpointReply: ((value: [number, string, string] | undefined) => void) | undefined;
  let startupOptions: Parameters<typeof startNativeCheckpoint>[0];
  const nativeCheckpointExits: { promise: Promise<[number, string, string]>; cancelled: boolean }[] = [];
  // Bun loads controlled TypeScript factories directly; native SDK wiring keeps Node.
  async function startNativeCheckpoint({
    sdk = true, native = false, extension = true, executable = native ? "node" : process.execPath,
  }: { sdk?: boolean; native?: boolean; extension?: boolean; executable?: string } = {}) {
    if (nativeCheckpoint) throw Error("Checkpoint fixture already running");
    startupOptions = { sdk, native, extension, executable };
    nativeCheckpointRoot ??= mkdtempSync(path.join(tmpdir(), "pitako-checkpoint-node-"));
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const child = spawn(executable, ["-e", `
      if(process.versions.bun)Bun.plugin({
        name:'controlled-typescript-loader',
        setup(build){
          // Bun already loads this source closure; Node's registerHooks is not available.
          build.onLoad({filter:/\\/skills\\/execute\\/loader\\.mjs$/},()=>({contents:'',loader:'js'}));
        },
      });
      const disconnect=()=>{if(process.connected)process.disconnect();};
      // Node can receive the peer's disconnect while SIGTERM is closing IPC.
      process.on('error',error=>{
        if(error.code==='ERR_IPC_DISCONNECTED' && !process.connected)return;
        console.error(error);process.exitCode=1;
      });
      process.on('SIGTERM',()=>{
        process.exitCode ||= 143;
        // Runner timeout cleanup can signal an idle file-owned child without its case owner.
        if(process.connected)process.send({cancelled:true},disconnect);
        else disconnect();
      });
      const send=value=>{
        if(process.connected)process.send(value,error=>{
          if(error){console.error(error);process.exitCode=1;disconnect();}
        });
      };
      let loaded;
      const sdk=()=>loaded??=(async()=>{
        await import(${JSON.stringify(new URL("../../skills/execute/loader.mjs", import.meta.url).href)});
        let runWorkflowScript, loadExtensions;
        if(${native}) {
          const {runWorkflowScript:nativeRun}=await import(${JSON.stringify(new URL("../../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href)});
          const nativeLoad=(await import(${JSON.stringify(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url).href)})).loadExtensionsCached;
          runWorkflowScript = nativeRun;
          loadExtensions = nativeLoad;
        } else {
          // Controlled cases exercise the owned factory, not Pi's SDK loader.
          // The explicit native case above retains real SDK loading and dispatch.
          runWorkflowScript = ${controlledWorkflow.toString()};
          loadExtensions = async paths => {
            const extensions=[], errors=[];
            for(const file of paths) {
              try {
                const {default:factory}=await import(require('node:url').pathToFileURL(file).href), tools=new Map();
                await factory({on(){},registerTool:definition=>tools.set(definition.name,{definition})});
                extensions.push({tools});
              } catch(error) {errors.push({path:file,error:String(error.stack??error)});}
            }
            return {extensions,errors};
          };
        }
        return {runWorkflowScript,loadExtensions};
      })();
      (async()=>{
        await import(${JSON.stringify(gitFakeBootstrap)});
        if(${sdk}) {
          const {loadExtensions}=await sdk();
          if(${extension})await loadExtensions([${JSON.stringify(path.resolve("extensions/checkpoint-create.ts"))}],process.cwd());
          // File-owned extension and persistence loading must finish before ready.
          if(!${native})await Promise.all([
            import(${JSON.stringify(new URL("../../extensions/execute-checkpoint.ts", import.meta.url).href)}),
            import(${JSON.stringify(new URL("../../extensions/spec-plans.ts", import.meta.url).href)}),
            import(${JSON.stringify(new URL("../../skills/execute/loop.ts", import.meta.url).href)}),
            import(${JSON.stringify(new URL("../../skills/execute/loop-io.mjs", import.meta.url).href)}),
            import(${JSON.stringify(new URL("../../skills/execute/inspect.ts", import.meta.url).href)}),
          ]);
        }
        process.on('message',async ({input,harness})=>{
          const prior=process.env.PI_CODING_AGENT_DIR, cwd=process.cwd();
          try {
            if(input.metadata){input.metadata.sealer=${JSON.stringify(path.resolve("skills/execute/checkpoint.mjs"))};input.metadata.loopIO=${JSON.stringify(path.resolve("skills/execute/loop-io.mjs"))};input.metadata.verifier=${JSON.stringify(path.resolve("extensions/access-receipts.mjs"))};}
            process.chdir(input.root);process.env.PI_CODING_AGENT_DIR=input.agentDir;
            const {runWorkflowScript,loadExtensions}=input.sdk===false?{}:await sdk();
            if(input.metadata?.inlineSealer && input.sdk!==false)input.metadata.sealCheckpointRequest=(await import(input.module??input.checkpointModule)).sealCheckpointRequest;
            if(input.metadata?.inlineLoopIO && input.sdk!==false){if(${native})await import(${JSON.stringify(new URL("../../skills/execute/loader.mjs", import.meta.url).href)});input.metadata.loopOperations={...await import(${JSON.stringify(new URL("../../skills/execute/loop.ts", import.meta.url).href)}),baseline:(await import(${JSON.stringify(new URL("../../extensions/execute-checkpoint.ts", import.meta.url).href)})).captureBaseline};}
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
    recordOpaque(child);
    let output = "", errors = "";
    child.stdout!.on("data", chunk => { output += chunk; });
    child.stderr!.on("data", chunk => { errors += chunk; });
    child.on("error", error => { errors += String(error.stack ?? error); });
    child.on("message", (message: any) => {
      if (message.ready) ready();
      else if (message.cancelled) operation.cancelled = true;
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
    const operation = { promise: nativeCheckpointExit, cancelled: false };
    nativeCheckpointExits.push(operation);
    const cancel = () => {
      operation.cancelled = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const ownsStartup = checkpointCancellations.size === 0;
    if (ownsStartup) checkpointCancellations.add(cancel);
    const startup = (async () => {
      try {
        await started;
        if (!operation.cancelled) expect(nativeCheckpoint, errors).toBeDefined();
      } finally { if (ownsStartup) checkpointCancellations.delete(cancel); }
    })();
    workflowSettlements.push(startup.then(() => {}, () => {}));
    await startup;
  }
  afterAll(async () => {
    await settleWorkflows();
    if (nativeCheckpoint?.connected) nativeCheckpoint.disconnect();
    for (const operation of nativeCheckpointExits) {
      const [exit, , errors] = await operation.promise;
      expect(exit, errors).toBe(operation.cancelled ? 143 : 0);
      expect(errors).not.toContain("unawaited runs.run launch(es)");
    }
    if (nativeCheckpointRoot) rmSync(nativeCheckpointRoot, { recursive: true, force: true });
  });
  function nativeCheckpointCase(input: any, harness: string): Promise<[number, string, string] | undefined>;
  function nativeCheckpointCase<T>(input: any, harness: string, consume: (value: [number, string, string]) => T): Promise<T | undefined>;
  function nativeCheckpointCase(input: any, harness: string, consume: (value: [number, string, string]) => unknown = value => value) {
    let cancelled = false;
    let child: ReturnType<typeof spawn> | undefined;
    let operation: typeof nativeCheckpointExits[number] | undefined;
    // Own cancellation before startup can yield, including an abandoned first case.
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      child ??= nativeCheckpoint;
      operation ??= nativeCheckpointExits.at(-1);
      if (operation) operation.cancelled = true;
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    };
    checkpointCancellations.add(cancel);
    const result = (async () => {
      try {
        // A cancelled preceding case can still be draining synchronous host work.
        const preceding = nativeCheckpointExits.at(-1);
        if (preceding?.cancelled) await preceding.promise;
        if (cancelled) return;
        if (!nativeCheckpoint) await startNativeCheckpoint(startupOptions);
        child ??= nativeCheckpoint;
        operation ??= nativeCheckpointExits.at(-1);
        if (cancelled) { await operation?.promise; return; }
        if (!child || nativeCheckpointReply) throw Error("Native checkpoint fixture unavailable or busy");
        recordOpaque(child);
        const response = new Promise<[number, string, string] | undefined>(resolve => {
          const reply = (value: [number, string, string] | undefined) => resolve(cancelled ? undefined : value);
          nativeCheckpointReply = reply;
          child!.send({input:{...input,agentDir:path.join(path.dirname(input.missionPath),"private-agent")},harness}, error => {
            if (error) {
              if (nativeCheckpointReply === reply) nativeCheckpointReply = undefined;
              resolve(cancelled ? undefined : [1, "", String(error.stack ?? error)]);
            }
          });
        });
        const value = await response;
        if (cancelled || !child.connected) await operation!.promise; // Joins this child and both streams.
        if (!cancelled && value) return await consume(value);
      } finally {
        if (cancelled) await operation?.promise;
        checkpointCancellations.delete(cancel);
      }
    })();
    // Own the assertion consumer as well as IPC, even if the caller times out.
    workflowSettlements.push(result.then(() => {}, () => {}));
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
