import { afterEach, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { processBudget, expectProcessBudget, type Processes } from "./process-budget.ts";
import type { createGitFake } from "./git-fake.ts";
import { gitFakeBootstrap } from "./git-fake-env.ts";
import { gitFakeFixture } from "./git-fake-fixture.ts";
const { appendLedger, verifyLedger, loopSummaries, canonicalJSON, summarizeLoops } = await import(path.resolve("skills/execute/ledger.mjs"));
import { canonicalDigest, canonicalJSON as canonicalViewJSON } from "../../extensions/canonical.mjs";
import { captureBaseline, captureCheckpoint } from "../../extensions/execute-checkpoint.ts";
import { checkoutEvidence, digest, inspectionSnapshot, specBinding, specChunks } from "../../extensions/spec-plans.ts";
import { updateProgress, apply, reviewOriginals, cancelledScope, readBacklog } from "../../skills/execute/loop.ts";
import { reviewModels } from "../../extensions/review-settings.ts";
import { EXECUTE_STATE_VERSION } from "../../extensions/execute-state.ts";
import { DEFAULT_TASK_REVIEWER, DEFAULT_TASK_SYNTHESIS } from "../../extensions/execute-settings.ts";
import { verifyGate } from "../../extensions/access-receipts.mjs";
import { MISSION_STATE_MAX_BYTES } from "../../node_modules/pi-subagents/src/missions/workflow-state.js";
import { runWorkflowScript, type WorkflowScriptChildResult } from "../../node_modules/pi-subagents/src/workflows/scripted-workflow.js";

const executeSource = readFileSync(new URL("../../skills/execute/workflow.js", import.meta.url), "utf8");
const reviewSource = readFileSync(new URL("../../skills/workflow-canonical.js", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../../skills/review/workflow.js", import.meta.url), "utf8");

// Shared by tests/execute-workflow-*.test.ts. Mutable state lives in the per-file
// factory below: each test file owns its roots and settlements, even when Bun
// loads several files in one process.
export const source = `const pitakoReviewLibraryMode = true;\n${reviewSource}\n${executeSource}`;
const globalConfig = {
  root: "/owned/designated", id: "spec", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/exact-mission",
  inspections: ["initial", "loop-1", "loop-2", "loop-3", "loop-4", "initial.r1", "initial.r2"].map(phase => ({ key: `inspect-${phase}`, command: "READ" })),
  settings: { key: "execute-settings", command: "SETTINGS" }, sourceRefs: [], stateVersion: EXECUTE_STATE_VERSION,
  chunks: Array.from({ length: 26 }, (_, index) => ({ key: `input-${index}`, command: "CHUNK" })),
};
export const config = globalConfig;
export type Candidate = { head: string; fingerprint: string };
type Request = { key: string; agent?: string; resume?: string; context?: string; cwd?: string; task: string;
  model?: string;
  label?: string; phase?: string; skill?: string[];
  output?: string | boolean; outputMode?: string; outputSchema?: any; timeoutMs?: number; reads?: boolean; progress?: boolean; acceptance?: any; async?: boolean };
export type Result = Omit<Partial<WorkflowScriptChildResult>, "state"> & { ok: boolean; state?: string; structuredOutput?: any; [key: string]: any };
export type Outcome = { status: string; reason: string; loopsConsumed: number; loopReport: any; tokens: any; elapsedMs: number; [key: string]: any };
export function resolvedLoop(state: any) {
  const loop = state.loop;
  return loop && { ...loop, results: loop.results.map((entry: any) => entry.ref ? entry
    : state.tasks[entry.taskId]?.completed ?? state.tasks[entry.taskId]?.last ?? entry) };
}
export const copy = <T>(value: T): T => structuredClone(value);
// Assert the retained review witness against the original native witness; never
// use it to manufacture child results or publication evidence.
export function publicationWitness(retained: any, native: any) {
  const witness = { ...retained };
  for (const field of Object.keys(witness)) expect(witness[field]).toEqual(native[field]);
  expect(witness.savedOutputPath).toBe(native.savedOutputPath);
  expect(witness.outputReference).toEqual(native.outputReference);
  return witness;
}
export const candidate = (version = 0): Candidate => ({ head: "a".repeat(40), fingerprint: String(version).padStart(64, "0") });
const task = (id: string, kind = "implementation") => ({ id, kind, goal: `Goal ${id}`, contextRefs: ["shared"], sourceRefs: ["spec:criterion-1"],
  scope: [`src/${id}.ts`], allowedEffects: kind === "verification" ? ["read/check"] : ["edit assigned path"], expectedResult: `Result ${id}`,
  dependsOn: [] as { taskId: string; reason: string }[],
  checks: [{ id: `${id}-check`, requirement: "spec:criterion-1", command: `bun test ${id}`, cwd: config.root }] });
type FixtureOptions = { humanPosts?: any[]; metadataPadding?: number; taskCount?: number; findings?: boolean; readOnly?: boolean;
  realCheckout?: boolean; controlledPublisher?: boolean; retainSnapshots?: boolean; rawWorkerReceipts?: boolean };
type OwnedResources = { roots: string[]; settlements: Promise<unknown>[]; disposers: (() => void)[]; controlledProcesses: (() => Processes)[] };
export function executeControllerFixture(fake?: ReturnType<typeof createGitFake>) {
  const owned: OwnedResources = { roots: [], settlements: [], disposers: [], controlledProcesses: [] };
  let ownedFake: ReturnType<typeof gitFakeFixture> | undefined;
  afterEach(async () => {
    await Promise.all(owned.settlements.splice(0));
    try {
      const total: Processes = { sealer: 0, loopIO: 0, gates: 0, other: 0 };
      for (const processes of owned.controlledProcesses.splice(0))
        for (const [key, count] of Object.entries(processes())) total[key as keyof Processes] += count;
      // All controlled fixtures in this test measured zero processes; allow +2.
      expectProcessBudget(total, 2);
    } finally {
      const disposers = owned.disposers.splice(0);
      if (ownedFake) disposers.push(ownedFake.dispose);
      ownedFake = undefined;
      const errors: unknown[] = [];
      for (const dispose of disposers) {
        try { dispose(); } catch (error) { errors.push(error); }
      }
      for (const root of owned.roots.splice(0)) {
        try { rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Controller fixture cleanup failed");
    }
  });
  return { fixture: (content?: string, options?: FixtureOptions) =>
    ownedFixture(owned, content, options, fake ?? (ownedFake ??= gitFakeFixture())) };
}
export type ControllerHost = ReturnType<typeof ownedFixture>;
function ownedFixture({ roots, settlements, disposers, controlledProcesses }: OwnedResources, content = "COMPLETE IMMUTABLE SPECS", options: FixtureOptions = {}, fake?: ReturnType<typeof createGitFake>) {
  // Controller protocol tests use controlled candidates/checkpoints. Opt into
  // realCheckout for byte, drift, restoration or command-execution assertions.
  const root = mkdtempSync(path.join(tmpdir(), "pitako-execute-controller-")); roots.push(root);
  const budget = processBudget();
  if (fake) fake.fakeRepo(root, { paths: ["src/change1.ts", "src/change2.ts", "candidate-drift", "late.ts"] });
  const config = { ...globalConfig, root, preliminary: undefined as any };
  const observedCandidate = (): Candidate => {
    if (!options.realCheckout) return copy(checkout);
    const { head, fingerprint } = checkoutEvidence(root); return { head, fingerprint };
  };
  let checkout = candidate(), clock = 1000;
  if (options.realCheckout) checkout = observedCandidate();
  if (!options.realCheckout) controlledProcesses.push(budget.processes);
  // calls observes logical operation boundaries for fault injection; launches is
  // the actual native dispatch inventory, including grouped launches only once.
  const calls: Request[] = [], launches: Request[] = [], hostCalls: string[] = [], statusCalls: string[] = [], emits: any[] = [];
  const storage = new Map<string, any>(), native = new Map<string, Result>();
  const snapshots: any[] = [];
  const published: string[] = [], publishedRecords: any[] = [];
  const publish = (request: any) => {
    if (!options.controlledPublisher) return appendLedger(root, config.invocation, request);
    // Controlled external CLI boundary, not a second ledger implementation.
    // Real canonical bytes/hashes are materialized and verified at assertion time.
    expect(request.expected).toEqual({ count: published.length, head: published.length ? digest(published.at(-1)!) : null });
    const record = (entry: any) => {
      const value = { ...entry, seq: published.length, prev: published.length ? digest(published.at(-1)!) : null };
      published.push(canonicalJSON(value)); publishedRecords.push(value);
    };
    if (!published.length) record({ kind: "spec", loop: 0, body: request.spec });
    record(request.record);
    return { count: published.length, head: digest(published.at(-1)!) };
  };
  const summaries = (anchor: any) => options.controlledPublisher
    ? summarizeLoops(publishedRecords) : loopSummaries(root, config.invocation, anchor);
  let saveObserver: ((value: any, bytes: number, serialized: string) => void) | undefined;
  const chunks = specChunks(content);
  const selected = { source: "/owned/sibling/" + "s".repeat(options.metadataPadding ?? 0) + "/.pitako/plans/spec.md", digest: digest(content), chunks: chunks.length };
  const metadata = { root: config.root, commonDir: path.join(root, ".git"), selected, candidates: [] };
  const transported = Buffer.byteLength(JSON.stringify({ ...metadata, checkout })) > 4096 ? inspectionSnapshot(metadata, content) : null;
  config.preliminary = { ...specBinding("spec", root, metadata.commonDir, selected), content };
  let admittedLimit = 3;
  let failSave: ((value: any) => boolean) | undefined;
  let status: (ref: string) => Result | Promise<Result> = ref => copy(native.get(ref) ?? { ok: true, output: "", results: [] });
  let responder: ((request: Request, normal: () => Result) => Result | Promise<Result>) | undefined;
  let launchResponder: ((request: Request, normal: () => Promise<Result>) => Result | Promise<Result>) | undefined;
  let hostResponse: ((key: string, value: any) => any) | undefined;
  let observationResponse: ((key: string, value: any) => any) | undefined;
  let admission: ((calls: { key: string }[]) => void) | undefined;
  let optionalCacheFailures = 0;
  const association = (loop: number) => ({ missionId: config.missionId, missionPath: config.missionPath, invocation: config.invocation,
    root: config.root, commonDir: metadata.commonDir, source: selected.source, digest: selected.digest, maxCycles: admittedLimit, sourceRefs: [], loop });
  const backlogTask = (id: string) => ({ id, title: `Title ${id}`, goal: `Goal ${id}`, expectedResult: `Result ${id}`, status: "pending" as const,
    origin: { kind: "spec" as const, ref: "spec:criterion-1" }, specRefs: ["spec:criterion-1"], dependsOn: [],
    gates: [{ id: `${id}-check`, command: `bun test ${id}`, cwd: root, timeoutMs: 1800000 }], metric: null,
    parent: null, remaining: "", progress: { nonImproving: 0, last5: [] }, history: [] });
  const plan = (loop = 1) => {
    const existing = readBacklog(root, "spec").backlog;
    const tasks = existing?.tasks ?? Array.from({ length: options.taskCount ?? 1 }, (_, index) => backlogTask(`change${index + 1}`));
    return { select: tasks.find(t => t.status === "pending")?.id ?? null,
      changes: existing ? tasks.filter(t => t.status === "pending" && !t.gates.length).map(t => ({ kind: "update", id: t.id, patch: { gates: backlogTask(t.id).gates }, reason: "Assign focused repair gates" })) : tasks.map(task => ({ kind: "add", task, reason: "From complete spec" })),
      reason: "Most important eligible backlog task", ...(!existing ? { acceptance: [{ id: "full", command: "true", cwd: root }] } : {}) };
  };
  const captures = new Map<string, any>();
  const verifications: { key: string; request: any; output: any }[] = [];
  const worker = (request: Request, _checkpointKind: "unit" | "pause" = "unit") => {
    const checkpoint = request.resume ? storage.get("invoke-human-1").loop.attempt.checkpoint
      : JSON.parse(request.task.split("PRE-WRITE CHECKPOINT INTENTION (not a backup until published):\n")[1]!.split("\n")[0]!);
    const descriptor = { key: checkpoint.key, taskId: checkpoint.taskId, checkpoint };
    const selectedTask = request.resume ? { kind: "implementation", ...readBacklog(root, "spec").backlog!.tasks.find(task => task.id === checkpoint.taskId)! }
      : JSON.parse(request.task.split("COMPLETE SELECTED TASK:\n")[1]!.split("\nTASK CONTINUATION")[0]!);
    if (selectedTask.kind === "implementation" && descriptor.checkpoint?.progress) {
      captures.set(descriptor.key, copy(descriptor.checkpoint));
      if (options.realCheckout && !existsSync(path.join(root, ".pi/subagents/checkpoints", descriptor.key, "manifest.json")))
        captureCheckpoint(descriptor.checkpoint, ["src/" + descriptor.taskId + ".ts"]);
    }
    return { status: "complete", work: `Implemented ${selectedTask.goal}`,
      remaining: [], knowledge: { findings: [], handoff: "Current assigned source has no pending defects." } };
  };
  function result(request: Request, value: any): Result {
    if (request.resume && /\.t\d+\.a\d+$/.test(request.key)) request = { ...request, agent: "pitako.worker" };
    let savedOutputPath: string | undefined;
    if (request.phase?.startsWith("review-")) {
      const required = JSON.parse(request.task.split("ESSENTIAL ORIGINALS (data): ")[1]!.split("\n")[0]!);
      for (const entry of required) {
        const original = JSON.parse(readFileSync(entry.results.find((item: any) => item.savedOutputPath).savedOutputPath, "utf8"));
        expect(canonicalDigest(original)).toBe(entry.digest);
      }
    }
    if (request.phase?.startsWith("review-") || request.phase?.startsWith("task-")) {
      savedOutputPath = path.join(root, ".pi/subagents/review-originals", request.key + ".json");
      mkdirSync(path.dirname(savedOutputPath), { recursive: true });
      writeFileSync(savedOutputPath, JSON.stringify(value));
    }
    let structuredOutputPath = `/native/witness/${request.key}.json`;
    if (request.key.endsWith(".compliance")) {
      structuredOutputPath = path.join(root, ".pi/subagents/compliance-originals", request.key + ".json");
      mkdirSync(path.dirname(structuredOutputPath), { recursive: true });
      writeFileSync(structuredOutputPath, JSON.stringify(value));
    }
    return { ok: true, agent: request.agent ?? "pitako.reviewer", runId: `native-${request.key}`, output: "Output saved to: /not-the-binding/preview.md",
      outputReference: `/native/output/${request.key}.json`, outputArtifactPath: `/native/binding/${request.key}.json`,
      outputPathMapping: { requestedPath: String(request.output), savedPath: `/native/remapped/${request.key}.json` },
      artifactPaths: [`/native/debug/${request.key}/`], results: [{ index: 0, agent: request.agent ?? "pitako.reviewer",
        task: request.task, exitCode: 0, ...(savedOutputPath ? { savedOutputPath, outputReference: { path: savedOutputPath, bytes: Buffer.byteLength(JSON.stringify(value)), lines: 1, message: "Saved" } } : {}), structuredOutputPath,
        usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0, turns: 1 } }], structuredOutput: value };
  }
  function normal(request: Request): Result {
    const loop = Number(request.key.match(/\.l(\d+)\./)?.[1] ?? 1);
    let value: any;
    if (/\.task-(reviewer|synthesis)$/.test(request.key)) {
      const answer = { verdict: "Satisfied", score: 10, findings: [] };
      return result(request, { completeness: answer, correctness: answer, scope: answer, conflict: false });
    }
    if (request.resume && /\.t\d+\.a\d+$/.test(request.key)) return result(request, worker(request));
    if (request.agent === "pitako.request-observer") return { ok: true, agent: request.agent,
      runId: `native-${request.key}`, output: JSON.stringify({ version: 1, ok: true,
        invocation: JSON.parse(request.task).invocation, requests: [], next: null }), results: [{ index: 0, agent: request.agent!, task: request.task, exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] };
    if (request.agent === "pitako.access-verifier") {
      // Controlled boundary: the real verifier over actual published originals; the
      // fixture mission record lives in the owned root instead of /native.
      const input = JSON.parse(request.task);
      // Real missions live outside the checkout; keep receipts out of checkout evidence.
      const missionPath = path.join(root, ".pi/subagents/native-missions/native-mission.json");
      mkdirSync(path.dirname(missionPath), { recursive: true });
      writeFileSync(missionPath, "{}");
      const observed = verifyGate({ ...input, missionPath });
      verifications.push({ key: request.key, request: input, output: observed });
      return { ok: true, key: request.key, agent: request.agent, runId: `native-${request.key}`, output: JSON.stringify(observed),
        results: [{ exitCode: 0 }] } as Result;
    }
    if (request.agent === "pitako.loop-io") {
      const input = JSON.parse(request.task);
      if (input.operation === "taskDelta") {
        let delta;
        if (!options.realCheckout) delta = {
          touched: captures.has(input.intents.at(-1).key) ? ["src/change1.ts"] : [], netChanged: [], overflow: null,
        };
        else {
          budget.counts.loopIO++;
          // Keep the real cwd/operation boundary without cold Node TypeScript transformation per review.
          const response = spawnSync(process.execPath, ["--eval", `
            Bun.plugin({name:"controlled-typescript-loader",setup(build){
              build.onLoad({filter:/\\/skills\\/execute\\/loader\\.mjs$/},()=>({contents:"",loader:"js"}));
            }});
            await import(${JSON.stringify(gitFakeBootstrap)});
            const { taskDelta } = await import(${JSON.stringify(path.resolve("skills/execute/loop-io.mjs"))});
            console.log(JSON.stringify(taskDelta(JSON.parse(await Bun.stdin.text()))));
          `],
            { cwd: root, env: process.env, input: request.task, encoding: "utf8" });
          if (response.status !== 0) throw new Error(response.stdout + response.stderr);
          delta = JSON.parse(response.stdout);
        }
        return { ok: true, key: request.key, agent: request.agent, runId: `native-${request.key}`,
          output: JSON.stringify(delta), results: [{ exitCode: 0 }] } as Result;
      }
      if (input.operation === "gate" && native.get(request.key)?.ok) return copy(native.get(request.key)!);
      const view = { topicId: 1, authority: "spec and frozen amendments > DECISION > FINDING > HANDOFF; code wins over any map", posts: options.humanPosts ?? [], omitted: 0 };
      if (input.operation !== "gate") {
        try {
          const current = readBacklog(root, "spec");
          const value = input.operation === "baseline" ? { ...(options.realCheckout ? captureBaseline(input) : { candidate: copy(checkout) }), backlog: undefined } : input.operation === "reviewOriginals" ? { ...reviewOriginals(input), backlog: undefined } : input.operation === "prepare" ? { ...current, cancelledScope: current.backlog ? cancelledScope(current.backlog) : [], view, lastConfirmedUnit: null }
            : { ...apply({ ...input, currentHumanIds: view.posts.filter(post => post.type === "HUMAN").map(post => post.id) }), view };
          const { backlog, ...receipt } = value;
          if (input.operation === "prepare" || input.operation === "apply") Object.assign(receipt, {
            viewDigest: canonicalDigest(view), viewBytes: Buffer.byteLength(canonicalViewJSON(view)),
          });
          return { ok: true, key: request.key, agent: request.agent, runId: `native-${request.key}`,
            output: JSON.stringify({ ...receipt, ...(backlog ? { acceptance: backlog.acceptance, acceptanceHistory: backlog.acceptanceHistory } : {}) }), results: [{ exitCode: 0 }] } as Result;
        } catch (error) {
          return { ok: false, key: request.key, agent: request.agent, runId: `native-${request.key}`,
            output: JSON.stringify({ error: "loop-io", reason: String((error as Error).message), selectionRejected: (error as any).selectionRejected === true }), results: [{ exitCode: 1 }] } as Result;
        }
      }
      if (input.task.id === "final-acceptance") {
        const before = observedCandidate();
        const directory = path.join(root, ".pi/subagents/execute", config.invocation, "gates", request.key);
        mkdirSync(directory, { recursive: true });
        const reused = input.reuse && input.reuse.candidate.head === before.head && input.reuse.candidate.fingerprint === before.fingerprint;
        const gates = reused ? copy(input.reuse.results) : input.task.gates.map((gate: any, index: number) => {
          if (!options.realCheckout) return { id: gate.id, status: "pass", exit: 0, ms: 1, tail: "Controlled gate passed", logRef: `/native/gates/${request.key}/${gate.id}.log` };
          const start = Date.now();
          budget.counts.gates++;
          const command = spawnSync("sh", ["-c", gate.command], { cwd: path.resolve(root, gate.cwd), env: process.env,
            encoding: "utf8", timeout: gate.timeoutMs });
          const output = (command.stdout ?? "") + (command.stderr ?? "");
          const logRef = path.join(directory, `${index}.log`);
          writeFileSync(logRef, output);
          return { id: gate.id, status: command.error ? "error" : command.status === 0 ? "pass" : "fail",
            exit: command.status, ms: Date.now() - start, tail: output.slice(-2048), logRef };
        });
        checkout = observedCandidate();
        const progress = updateProgress(input.task.progress, { value: null, fingerprint: checkout.fingerprint,
          gatesPassed: gates.filter((gate: any) => gate.status === "pass").length, gatesTotal: gates.length }, null);
        return { ok: true, key: request.key, agent: request.agent, runId: `native-${request.key}`,
          output: JSON.stringify({ before, after: copy(checkout), mutated: before.fingerprint !== checkout.fingerprint || before.head !== checkout.head,
            gates, metric: null, progress, stalled: progress.nonImproving >= 3, view,
            ...(reused ? { reused: { loop: input.reuse.loop, gateKey: input.reuse.gateKey } } : {}) }), results: [{ exitCode: 0 }] } as Result;
      }
      const previous = input.task.progress;
      const shouldRun = input.workerStatus === "complete" || !input.task.metric;
      const passed = shouldRun ? input.task.gates.length : 0;
      const progress = updateProgress(previous, { value: input.task.metric?.target ?? null,
        fingerprint: checkout.fingerprint, gatesPassed: passed, gatesTotal: input.task.gates.length }, input.task.metric?.target ?? null);
      const value = { before: copy(checkout), after: copy(checkout), mutated: false,
        gates: shouldRun ? input.task.gates.map((gate: any) => ({ id: gate.id,
          status: "pass", exit: 0, ms: 1, tail: "Focused gate passed", logRef: `/native/gates/${request.key}/${gate.id}.log` })) : [],
        metric: input.task.metric ? { value: input.task.metric.target, error: null } : null,
        progress, stalled: progress.nonImproving >= 3,
        view: { topicId: 1, authority: "spec and frozen amendments > DECISION > FINDING > HANDOFF; code wins over any map", posts: [], omitted: 0 } };
      return { ok: true, key: request.key, agent: request.agent, runId: `native-${request.key}`,
        output: JSON.stringify(value), results: [{ exitCode: 0 }] } as Result;
    }
    if (request.agent === "pitako.checkpoint-sealer") {
      const input = JSON.parse(request.task), intent = input.intent;
      let observed;
      if (!options.realCheckout) {
        observed = { v: 1, outcome: captures.has(intent.key) && input.kind ? "sealed" : "observed",
          kind: input.kind, candidate: copy(checkout),
          ...(captures.has(intent.key) && input.kind ? { checkpointRef: path.join(root, ".pi/subagents/checkpoints", intent.key, `${input.kind}.json`),
            digest: digest(intent.key), position: { loop: intent.loop, cursor: intent.cursor + (input.kind === "unit" ? 1 : 0), phase: intent.phase } } : {}) };
      } else {
        budget.counts.sealer++;
        // A private process preserves the sealer's cwd boundary without reloading Node's TS hook.
        const response = spawnSync(process.execPath, ["--eval", `
          import ${JSON.stringify(gitFakeBootstrap)};
          import { sealCheckpointRequest } from ${JSON.stringify(path.resolve("extensions/execute-checkpoint.ts"))};
          console.log(JSON.stringify(sealCheckpointRequest(JSON.parse(await Bun.stdin.text()))));
        `], { cwd: root, env: process.env, input: request.task, encoding: "utf8" });
        if (response.status !== 0) throw new Error(response.stderr);
        observed = JSON.parse(response.stdout);
      }
      return { ok: true, key: request.key, agent: request.agent, runId: `native-${request.key}`,
        asyncDir: `/native/async/${request.key}`, output: JSON.stringify(observed),
        externalAdapter: { outputArtifacts: { stdoutPath: `/native/async/${request.key}/stdout.log`, stderrPath: `/native/async/${request.key}/stderr.log` } },
        results: [{ exitCode: 0 }] } as Result;
    }
    if (request.agent === "pitako.execution-ledger") {
      const { invocation, ...append } = JSON.parse(request.task);
      return { ok: true, key: request.key, agent: request.agent, runId: `native-${request.key}`,
        asyncDir: `/native/async/${request.key}`, output: JSON.stringify((() => { const anchor = publish(append); return { ...anchor, ...(append.record.kind === "loop" ? { summaries: summaries(anchor) } : {}) }; })()),
        externalAdapter: { outputArtifacts: { stdoutPath: `/native/async/${request.key}/stdout.log`, stderrPath: `/native/async/${request.key}/stderr.log` } },
        results: [{ exitCode: 0 }] } as Result;
    }
    if (request.agent === "pitako.checkout-observer") {
      const publication = JSON.parse(request.task);
      const { invocation, ...expected } = publication.expected;
      let observation = observationResponse ? observationResponse(request.key, { version: 1, ok: true, root, commonDir: metadata.commonDir, checkout: { ...checkout } }) : { version: 1, ok: true, root, commonDir: metadata.commonDir, checkout: { ...checkout } };
      let ledger;
      try {
        ledger = observation.ok ? publish({ expected, ...publication.body,
          record: { ...publication.body.record, body: { ...publication.body.record.body, observation } } }) : undefined;
      } catch (error) {
        observation = { version: 1, ok: false, error: "ledger-integrity", reason: String(error), nextStep: "Human reconciliation required" };
      }
      return { ok: true, key: request.key,
      agent: request.agent, runId: `native-${request.key}`, asyncDir: `/native/async/${request.key}`, artifactPaths: [],
      output: JSON.stringify({ ...observation, ...(ledger ? { ledger, summaries: summaries(ledger) } : {}) }),
      externalAdapter: {
        adapter: { id: "external-cli", version: 1, executionMode: "one-shot-stdin" },
        capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false,
          supervisor: "unsupported", forkContext: false, extensionBindings: false },
        handoff: { mode: "fresh" }, supervisor: { mode: "unsupported", reason: "Fixed one-shot observer" },
        nonResumableReason: "Fixed one-shot observer", outputArtifacts: { stdoutPath: `/native/async/${request.key}/stdout.log`,
        stderrPath: `/native/async/${request.key}/stderr.log` } },
      results: [{ index: 0, agent: request.agent, task: request.task, exitCode: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] } satisfies WorkflowScriptChildResult;
    }
    if (/\.director(?:\.d1)?$/.test(request.key)) value = plan(loop);
    else if (request.agent === "pitako.worker") value = worker(request);
    else if (request.key.includes(".recover")) {
      const original = [...native.values()].find(entry => entry.runId === `native-invoke-human-1.l${loop}.director`)?.structuredOutput ?? null;
      value = { status: original ? "recovered" : "lost", reason: "Exact full original native value observed using retained refs", original,
        workerResult: null, originalAvailable: !!original, binding: original ? "identical" : "absent",
        comparison: original ? "equal-full-json" : "neither", provenance: [`/native/binding/invoke-human-1.l${loop}.director.json`] };
    } else if (request.key.endsWith(".compliance")) value = { status: "fulfilled", reason: "Full source inventory matches current requirements and checks",
      requirements: Array.from({ length: 17 }, (_, index) => ({ id: `criterion-${index + 1}`, source: `spec:Acceptance criteria:${index + 1}`,
        reason: `Reachable requirement ${index + 1} implemented in actual source`, status: "fulfilled", evidence: ["src/entry.ts:1", "/native/work-result.json"], checks: ["/native/check.log"] })) };
    else if (request.key.endsWith(".demand-observation")) value = { memo: "Advisory only", evidenceLimits: ["Controlled summaries"], observations: [] };
    else if (request.key.endsWith("director-prepare")) value = { status: "ready", reason: "Distinct whole-result risks", angles: [{ id: "angle1", focus: "Whole-result angle 1", skills: [] }] };
    else if (request.key.includes("independent-")) value = { status: "ready", reason: "Source checked", coverage: "Whole target", findings: options.findings ? [{ title: "Reachable issue", location: "src/a.ts:1", scenario: "Caller invokes path", evidence: "source protection missing", impact: "current scoped behavior lost", classification: "scoped-defect", requirement: "spec:criterion-1" }] : [] };
    else if (request.key.endsWith("director-synthesis")) {
      const findings = JSON.parse(request.task.split("FINDINGS WITH SCRIPT-ASSIGNED IDS (index only; full arguments in independent originals):\n")[1]!.split("\nRead essential originals")[0]!);
      value = { status: "ready", reason: "Reasoned screening", memo: "Full-result review; include is not material by itself",
        dispositions: findings.map((entry: any) => ({ findingId: entry.id, decision: "include", reason: "Supported but bounded", classification: "scoped-defect", requirement: "spec:criterion-1" })),
        screening: { verdict: "clear", reason: "No material gaps in authorized scope", assessments: findings.map((entry: any) => ({ findingId: entry.id, requirement: "spec:criterion-1", consequence: "Non-material bounded issue", material: false, reason: "No mandatory guarantee blocked" })) } };
    } else throw Error(`Unexpected request ${request.key}`);
    return result(request, value);
  }
  const state = {
    get: async (key: string) => copy(storage.get(key)),
    set: async (key: string, value: unknown) => {
      if (failSave?.(value)) throw Error("Controlled essential persistence cut");
      const next = { ...Object.fromEntries(storage), [key]: value };
      const serialized = JSON.stringify(next, null, 2);
      const bytes = Buffer.byteLength(serialized);
      if (bytes > MISSION_STATE_MAX_BYTES) {
        if ((value as any)?.activePlan) optionalCacheFailures++;
        throw Error(`Mission state exceeds the 256 KiB limit (${bytes} bytes; maximum ${MISSION_STATE_MAX_BYTES} bytes).`);
      }
      // Reuse the measured native JSON bytes for the isolated persisted value.
      storage.set(key, JSON.parse(serialized)[key]);
      if (options.retainSnapshots !== false) snapshots.push(copy(value));
      saveObserver?.(value, bytes, serialized);
    },
  };
  const groupSteps = new Map<string, any>();
  function transport(key: string, value: any) {
    const file = path.join(root, ".pi/subagents/execute", value.invocation, "loop-io/receipts", digest(key), "000000.json");
    const bytes = canonicalViewJSON({ seq: 0, result: value, resultDigest: canonicalDigest(value) });
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes);
    const projection = copy(value);
    for (const step of projection.steps) {
      if (step.operation === "apply" && (projection.operation !== "selection" || step.result.selected !== null))
        delete step.result.completedTasks;
      if (step.operation === "gate") for (const gate of step.result.receipt.gates) gate.tail = "";
      if (projection.operation === "close" && step.operation === "requests" &&
          projection.steps.some((step: any) => step.operation === "nextRequests")) {
        const { requests, ...page } = step.result;
        step.result = { ...page, count: requests.length };
      }
    }
    return { path: file, digest: digest(bytes), projection };
  }
  async function operation(request: Request) {
    calls.push(copy(request));
    const response = responder ? await responder(request, () => normal(request)) : normal(request);
    if (response.runId) native.set(response.runId, copy(response)); native.set(request.key, copy(response));
    return response;
  }
  async function compound(request: Request): Promise<Result> {
    const input = JSON.parse(request.task), key = request.key.replace(/\.r\d+$/, "");
    const steps: any[] = [];
    async function step(name: string, call: Request) {
      const id = `${key}.${name}`;
      let result = groupSteps.get(id);
      if (!result) {
        const cachedGate = call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "gate"
          ? native.get(call.key) : undefined;
        const response = cachedGate?.ok ? copy(cachedGate) : await operation(call);
        if (!response.ok || response.results?.[0]?.exitCode !== 0) throw response;
        result = JSON.parse(response.output!);
        groupSteps.set(id, result);
      }
      steps.push({ key: id, operation: name, result });
      return result;
    }
    const io = (key: string, input: any): Request => ({ ...request, key, task: JSON.stringify(input) });
    try {
      const drained: any[] = [], results = new Map<string, any>();
      for (const intention of input.intentions) {
        const { expectedFrom, expectedDigestFrom, ...data } = intention.input;
        if (expectedFrom) { const anchor = results.get(expectedFrom); data.expected = { count: anchor.count, head: anchor.head }; }
        if (expectedDigestFrom) data.expectedDigest = results.get(expectedDigestFrom).digest;
        let value = groupSteps.get(intention.key);
        if (!value) {
          const call = intention.operation === "ledger"
            ? { ...request, key: intention.key, agent: "pitako.execution-ledger", task: JSON.stringify({ invocation: config.invocation, ...data }) }
            : io(intention.key, data);
          const response = await operation(call);
          if (!response.ok) throw response;
          value = JSON.parse(response.output!); groupSteps.set(intention.key, value);
        }
        results.set(intention.key, value);
        drained.push({ key: intention.key, operation: intention.operation, result: value });
      }
      const drain = transport(`${key}.drain`, { invocation: input.invocation, steps: drained });
      if (input.operation === "drain") return { ...normalExternal(request), output: JSON.stringify(drain) };
      steps.push({ key: `${key}.drain`, operation: "drain", result: drain });
      if (input.operation === "advance") await step("prepare", io(`${key}.prepare`, { operation: "prepare", ...input.prepare }));
      let selected: any;
      if (input.operation === "selection") selected = await step("apply", io(input.apply.key, { operation: "apply", ...input.apply }));
      let requests = await step("requests", { ...request, key: `${key}.requests`, agent: "pitako.request-observer",
        task: JSON.stringify({ invocation: input.invocation, cursor: 0 }) } as Request);
      async function baseline(name: string, intent: any, eligible: boolean, details: any = {}) {
        const cancelled = requests.requests.some((entry: any) => entry.taskId === intent.taskId);
        if (eligible && !cancelled && requests.next === null) {
          const value = await step(name, io(`${intent.key}.baseline`, { operation: "baseline", intent }));
          Object.assign(steps.at(-1).result, { captured: true, ...details });
          return value;
        }
        steps.push({ key: `${key}.${name}`, operation: name, result: { captured: false, ...details,
          ...(details.variant !== undefined ? { variant: null } : {}), reason: cancelled ? "cancelled" : "not-eligible" } });
      }
      if (input.operation === "selection" && input.baseline) await baseline("baseline", input.baseline, selected.selected?.id === input.baseline.taskId);
      let contextPeak: any;
      if (input.operation === "close") {
        const gate = await step("gate", io(input.gate.key, { operation: "gate", ...input.gate }));
        contextPeak = gate.contextPeak ?? null;
        const kind = input.gate.workerStatus === "complete" && !gate.mutated &&
          gate.gates.length === input.gate.task.gates.length && input.gate.task.gates.every((command: any) =>
            gate.gates.some((result: any) => result.id === command.id && result.status === "pass")) ? "unit" : "pause";
        const sealed = await step("seal", { ...request, key: `${input.gate.checkpoint.key}.seal`,
          agent: "pitako.checkpoint-sealer",
          task: JSON.stringify({ ...input.seal[kind], kind }) } as Request);
        steps[steps.length - 2].result = { receipt: gate, contextPeak };
        steps.at(-1).result = { kind, workerStatus: input.gate.workerStatus, mutated: gate.mutated,
          after: gate.after, gate: { path: drain.path, digest: drain.digest }, receipt: sealed };
        if (input.nextBaseline) {
          const earlier = requests;
          requests = await step("nextRequests", { ...request, key: `${key}.nextRequests`, agent: "pitako.request-observer",
            task: JSON.stringify({ invocation: input.invocation, cursor: 0 }) } as Request);
          if (requests.requests.length < earlier.requests.length ||
              canonicalDigest(requests.requests.slice(0, earlier.requests.length)) !== canonicalDigest(earlier.requests))
            throw new Error("loop-io request snapshot integrity conflict");
          const outcome = sealed.outcome;
          const variant = kind === "pause" && input.gate.workerStatus !== "blocked" && ["sealed", "observed"].includes(outcome) ? outcome : null;
          await baseline("nextBaseline", input.nextBaseline[variant ?? "sealed"], variant !== null, { variant, sealOutcome: outcome });
        }
      }
      return { ...normalExternal(request), output: JSON.stringify(transport(key, {
        invocation: input.invocation, operation: input.operation, steps,
        ...(input.operation === "close" ? { contextPeak } : {}),
      })) };
    } catch (error) {
      const failed = error as Result;
      return { ...normalExternal(request), ok: false, ...(failed.stopped ? { stopped: true } : {}),
        ...(failed.error ? { error: failed.error } : {}), results: [{ exitCode: 1 }],
        output: failed.output ?? JSON.stringify({ error: "loop-io", reason: String(error) }) } as Result;
    }
  }
  function normalExternal(request: Request): Result {
    return { ok: true, key: request.key, agent: request.agent, runId: `native-${request.key}`,
      asyncDir: `/native/async/${request.key}`,
      externalAdapter: { outputArtifacts: { stdoutPath: `/native/async/${request.key}/stdout.log`, stderrPath: `/native/async/${request.key}/stderr.log` } },
      results: [{ exitCode: 0 }] } as Result;
  }
  // Controlled admission boundary mirrors separate inert data and native digest;
  // the registered Node recovery cases independently exercise the real producer.
  function admissionValue(key = "inspect-initial") {
    const base = { version: 1, binding: config.preliminary.binding, checkout: copy(checkout),
      ...(!storage.get("invoke-human-1")?.association ? { admission: { maxCycles: admittedLimit,
        reviewModels: reviewModels(root, path.join(root, "private-agent")),
        taskReviewer: DEFAULT_TASK_REVIEWER, taskSynthesis: DEFAULT_TASK_SYNTHESIS } } : {}) };
    const value = hostResponse ? hostResponse(key, base) : base;
    return Array.isArray(value.retainedAnalyses)
      ? { ...value, recoveryDigest: digest(JSON.stringify(value.retainedAnalyses)) } : value;
  }
  function workflowConfig(override: object) {
    let observed;
    try { observed = admissionValue(); }
    catch { return { ...config, ...override }; } // Actual failure still occurs at the host boundary.
    return { ...config, ...(observed.recoveryDigest ? { recovery: {
      originals: observed.retainedAnalyses, digest: observed.recoveryDigest,
    } } : {}), ...override };
  }
  const runs = {
    all: async (requests: Request[]) => Promise.all(requests.map(async request => {
      launches.push(copy(request)); clock += 10;
      const grouped = request.agent === "pitako.loop-io" && ["advance", "selection", "close", "drain"].includes(JSON.parse(request.task).operation);
      const run = () => grouped ? compound(request) : operation(request);
      const response = launchResponder ? await launchResponder(request, run) : await run();
      if (!options.rawWorkerReceipts && request.agent === "pitako.worker" && response.structuredOutput?.status !== "complete" && response.structuredOutput &&
          response.structuredOutput.checkpointReceipt?.kind !== "pause")
        delete response.structuredOutput.checkpointReceipt;
      // Publish the final controlled response, including caller-supplied findings.
      for (const entry of response.results ?? []) for (const file of [entry.savedOutputPath, entry.structuredOutputPath])
        if (file?.startsWith(root + "/") && existsSync(file) && response.structuredOutput)
          writeFileSync(file, JSON.stringify(response.structuredOutput));
      if (response.runId) native.set(response.runId, copy(response)); native.set(request.key, copy(response));
      return response;
    })),
    status: async (ref: string) => { statusCalls.push(ref); return status(ref); },
    host: async (key: string, params: any) => {
      hostCalls.push(key); expect(params).toEqual({ kind: "command", command: key === "execute-settings" ? "SETTINGS" : key.startsWith("inspect-") ? "READ" : "CHUNK", timeoutMs: 86400000 });
      let value: any;
      if (["inspect-initial", "inspect-initial.r1", "inspect-initial.r2"].includes(key)) value = admissionValue(key);
      else if (key === "execute-settings") value = { maxCycles: admittedLimit,
        taskReviewer: DEFAULT_TASK_REVIEWER, taskSynthesis: DEFAULT_TASK_SYNTHESIS };
      else if (key.startsWith("inspect-")) value = transported ? { selected: { digest: selected.digest }, transport: transported.transport, checkout: copy(checkout) } : { ...metadata, checkout: copy(checkout) };
      else { const index = Number(key.slice(6)); value = transported ? transported.packets[index] : { digest: selected.digest, content: chunks[index] }; }
      return { ok: true, stdout: JSON.stringify(hostResponse && !["inspect-initial", "inspect-initial.r1", "inspect-initial.r2"].includes(key) ? hostResponse(key, value) : value), outputPath: `/native/host/${key}.log` };
    },
  };
  const track = <T>(promise: Promise<T>) => {
    settlements.push(promise.then(() => undefined, () => undefined)); return promise;
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const controlledDate = { now: () => clock };
  return { root, processes: budget.processes, expectProcessBudget: (maximum: number) => expectProcessBudget(budget.processes(), maximum),
    observedCandidate, verifications, calls, launches, hostCalls, statusCalls, emits, storage, snapshots, native, plan, worker, result, state,
    setSaveObserver: (observer: typeof saveObserver) => { saveObserver = observer; },
    setLimit: (value: number) => { admittedLimit = value; },
    setAdmission: (value?: typeof admission) => { admission = value; },
    optionalCacheFailures: () => optionalCacheFailures,
    setRespond: (value?: typeof responder) => { responder = value; }, setStatus: (value: typeof status) => { status = value; },
    setLaunchRespond: (value?: typeof launchResponder) => { launchResponder = value; },
    setObservationResponse: (value?: typeof observationResponse) => { observationResponse = value; },
    setHostResponse: (value?: typeof hostResponse) => { hostResponse = value; }, setFailSave: (value?: typeof failSave) => { failSave = value; },
    changeCheckout: (version = 1) => {
      if (!options.realCheckout) throw new Error("changeCheckout requires realCheckout: true");
      writeFileSync(path.join(root, "candidate-drift"), String(version)); checkout = observedCandidate();
    }, advance: (ms: number) => { clock += ms; },
    records: () => {
      if (options.controlledPublisher) {
        const directory = path.join(root, ".pi/subagents/execute", config.invocation);
        mkdirSync(directory, { recursive: true });
        published.forEach((bytes, seq) => writeFileSync(path.join(directory, `${String(seq).padStart(6, "0")}.json`), bytes));
      }
      return verifyLedger(root, config.invocation, storage.get("invoke-human-1").ledger);
    },
    current: () => storage.get("invoke-human-1"),
    // Historical assertions use test-owned save evidence, never mission-state history.
    history: () => { const loops = new Map<number, any>(); for (const value of snapshots) if (value.loop) loops.set(value.loop.number, resolvedLoop(value));
      const current = storage.get("invoke-human-1")?.loop; if (current) loops.set(current.number, resolvedLoop(storage.get("invoke-human-1"))); return [...loops.values()]; },
    execute: (override = {}, script = source): Promise<Outcome> => track(new AsyncFunction("config", "runs", "state", "emit", "Date", script)(workflowConfig(override), runs, state, (value: any) => emits.push(copy(value)), controlledDate)),
    executeNative: (override = {}): Promise<Outcome> => track((async () => {
      const observed = await runWorkflowScript({ script: `const config = ${JSON.stringify(workflowConfig(override))};\n${source}`, state,
        admit: calls => admission?.(calls),
        launch: async (key, params) => ({ key, artifactPaths: [], ...(await runs.all([{ ...params, key } as Request]))[0] } as WorkflowScriptChildResult),
        status: async ref => ({ key: ref, output: "", artifactPaths: [], ...await runs.status(ref) } as WorkflowScriptChildResult),
        host: async (key, params) => ({ ...await runs.host(key, params), key, kind: "command", state: "passed", exitCode: 0, stderr: "", durationMs: 0 }),
        onEmit: values => { emits.splice(0, emits.length, ...values); },
      });
      return observed.value as Outcome;
    })()),
  };
}
export function gaps(result: Result) {
  const value = copy(result); value.structuredOutput.status = "gaps";
  value.structuredOutput.reason = "Concrete full-spec gap at src/missing.ts:1";
  value.structuredOutput.requirements[0].status = "gap"; return value;
}
export function closedInterruptedProducer(result: Result, cause: "stopped" | "permission" = "stopped"): Result {
  // Supported native SingleResult closure fields; not an invented stopped
  // terminalOutcome. The failure remains a failure and is never admitted as work.
  return { ...result, ok: false,
    ...(cause === "stopped" ? { stopped: true } : { error: "Blocked by pi-subagents permission rule: 'run' is denied." }),
    results: result.results?.map(item => ({ ...item, exitCode: cause === "stopped" ? -1 : 1,
      processSignal: cause === "stopped" ? "SIGTERM" : null })) };
}
export function cutAt(host: ControllerHost, predicate: (value: any) => boolean) {
  host.setFailSave(value => predicate(value) && !value.activePlan);
}
export function removeCache(host: ControllerHost) { const value = host.current(); value.activePlan = null; host.storage.set("invoke-human-1", value); }
export function expectImpediment(host: ControllerHost, output: Outcome, status: string, cause: string, persistence?: string) {
  expect(output).toMatchObject({ status, heading: `Execution ${status}`, loopsConsumed: 1 });
  const reports = host.emits.filter(item => item.type === "execution-loop");
  expect(reports.length).toBeGreaterThan(0);
  for (const report of reports) {
    expect(report).toEqual(output.loopReport);
    expect(report.status).toBe(status);
    expect(report.halt).not.toBeNull();
    expect(report.next).toBe(persistence === "Essential persistence failed"
      ? "restore essential persistence; resolve observed impediment before any continuation" : "resolve observed impediment");
    for (const reason of [report.reason, report.pending[0].reason, report.actionRequired, output.reason, output.actionRequired]) {
      expect(reason).toContain(cause);
      if (persistence) expect(reason).toContain(persistence);
      expect(reason).not.toContain("new invocation");
      expect(reason).not.toContain("authorized loops consumed");
    }
  }
}
