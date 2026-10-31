import { afterEach, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureCheckpoint, sealCheckpoint } from "../../extensions/execute-checkpoint.ts";
import { checkoutEvidence, digest, inspectionSnapshot, specBinding, specChunks } from "../../extensions/spec-plans.ts";
import { MISSION_STATE_MAX_BYTES } from "../../node_modules/pi-subagents/src/missions/workflow-state.js";
import { runWorkflowScript, type WorkflowScriptChildResult } from "../../node_modules/pi-subagents/src/workflows/scripted-workflow.js";

const executeSource = readFileSync(new URL("../../skills/execute/workflow.js", import.meta.url), "utf8");
const reviewSource = readFileSync(new URL("../../skills/review/workflow.js", import.meta.url), "utf8");

// Shared by tests/execute-workflow-*.test.ts. Mutable state lives in the per-file
// factory below: each test file owns its roots and settlements, even when Bun
// loads several files in one process.
export const source = `const pitakoReviewLibraryMode = true;\n${reviewSource}\n${executeSource}`;
const globalConfig = {
  root: "/owned/designated", id: "spec", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/exact-mission",
  inspections: ["initial", "loop-1", "loop-2", "loop-3", "loop-4"].map(phase => ({ key: `inspect-${phase}`, command: "READ" })),
  settings: { key: "execute-settings", command: "SETTINGS" }, sourceRefs: [],
  chunks: Array.from({ length: 26 }, (_, index) => ({ key: `input-${index}`, command: "CHUNK" })),
};
export const config = globalConfig;
export type Candidate = { head: string; fingerprint: string };
type Request = { key: string; agent?: string; resume?: string; context?: string; cwd?: string; task: string;
  label?: string; phase?: string;
  output?: string | boolean; outputSchema?: any; timeoutMs?: number; reads?: boolean; progress?: boolean; acceptance?: any; async?: boolean };
export type Result = Omit<Partial<WorkflowScriptChildResult>, "state"> & { ok: boolean; state?: string; structuredOutput?: any; [key: string]: any };
export type Outcome = { status: string; reason: string; loopsConsumed: number; loopReport: any; tokens: any; elapsedMs: number; [key: string]: any };
export const copy = <T>(value: T): T => structuredClone(value);
export const candidate = (version = 0): Candidate => ({ head: "a".repeat(40), fingerprint: String(version).padStart(64, "0") });
const task = (id: string, kind = "implementation") => ({ id, kind, goal: `Goal ${id}`, contextRefs: ["shared"], sourceRefs: ["spec:criterion-1"],
  scope: [`src/${id}.ts`], allowedEffects: kind === "verification" ? ["read/check"] : ["edit assigned path"], expectedResult: `Result ${id}`,
  dependsOn: [] as { taskId: string; reason: string }[],
  checks: [{ id: `${id}-check`, requirement: "spec:criterion-1", command: `bun test ${id}`, cwd: config.root }] });
type FixtureOptions = { metadataPadding?: number; taskCount?: number; angles?: number; findings?: boolean; readOnly?: boolean };
type OwnedResources = { roots: string[]; settlements: Promise<unknown>[] };
export function executeControllerFixture() {
  const owned: OwnedResources = { roots: [], settlements: [] };
  afterEach(async () => {
    await Promise.all(owned.settlements.splice(0));
    for (const root of owned.roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  return { fixture: (content?: string, options?: FixtureOptions) => ownedFixture(owned, content, options) };
}
export type ControllerHost = ReturnType<typeof ownedFixture>;
function ownedFixture({ roots, settlements }: OwnedResources, content = "COMPLETE IMMUTABLE SPECS", options: FixtureOptions = {}) {
  // Controller fixtures own real preimages/seals, even when the controlled worker
  // is a no-op. Candidate-drift cases change actual WIP, never seal invented hashes.
  const root = mkdtempSync(path.join(tmpdir(), "pitako-execute-controller-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial");
  const config = { ...globalConfig, root, preliminary: undefined as any };
  const observedCandidate = (): Candidate => {
    const { head, fingerprint } = checkoutEvidence(root); return { head, fingerprint };
  };
  let checkout = observedCandidate(), clock = 1000;
  const calls: Request[] = [], hostCalls: string[] = [], statusCalls: string[] = [], emits: any[] = [];
  const storage = new Map<string, any>(), native = new Map<string, Result>();
  const snapshots: any[] = [];
  const chunks = specChunks(content);
  const selected = { source: "/owned/sibling/" + "s".repeat(options.metadataPadding ?? 0) + "/.pitako/plans/spec.md", digest: digest(content), chunks: chunks.length };
  const metadata = { root: config.root, commonDir: path.join(root, ".git"), selected, candidates: [] };
  const transported = Buffer.byteLength(JSON.stringify({ ...metadata, checkout })) > 4096 ? inspectionSnapshot(metadata, content) : null;
  config.preliminary = { ...specBinding("spec", root, metadata.commonDir, selected), content };
  let admittedLimit = 3;
  let failSave: ((value: any) => boolean) | undefined;
  let status: (ref: string) => Result | Promise<Result> = ref => copy(native.get(ref) ?? { ok: true, output: "", results: [] });
  let responder: ((request: Request, normal: () => Result) => Result | Promise<Result>) | undefined;
  let hostResponse: ((key: string, value: any) => any) | undefined;
  let observationResponse: ((key: string, value: any) => any) | undefined;
  let optionalCacheFailures = 0;
  const association = (loop: number) => ({ missionId: config.missionId, missionPath: config.missionPath, invocation: config.invocation,
    root: config.root, commonDir: metadata.commonDir, source: selected.source, digest: selected.digest, maxCycles: admittedLimit, sourceRefs: [], loop });
  const plan = (loop = 1) => ({ status: "plan", reason: "All authorized requirements mapped to ordered work", association: association(loop),
    sharedContext: { material: "FULL SHARED CONTEXT, NOT A SUMMARY", references: ["spec snapshot", "src/entry.ts"] },
    tasks: [...Array.from({ length: options.taskCount ?? 1 }, (_, index) => task(`change${index + 1}`, options.readOnly ? "verification" : "implementation")), task("final", "verification")].map(unit => ({ ...unit,
      checks: unit.checks.map(check => ({ ...check, cwd: root })) })) });
  const worker = (request: Request, checkpointKind: "unit" | "pause" = "unit") => {
    const descriptor = JSON.parse(request.task.split("FROZEN ATTEMPT:\n")[1]!.split("\n")[0]!);
    const selectedTask = JSON.parse(request.task.split("COMPLETE SELECTED TASK:\n")[1]!.split("\nFROZEN ATTEMPT")[0]!);
    let receipt;
    if (selectedTask.kind === "implementation" && descriptor.checkpoint?.progress) {
      // These controller tests model no-op workers. The registered Node cases
      // separately exercise journaled modifications and interruption cuts.
      const directory = path.join(root, ".pi/subagents/checkpoints", descriptor.key);
      if (!existsSync(path.join(directory, "manifest.json"))) captureCheckpoint(descriptor.checkpoint, ["src/" + descriptor.taskId + ".ts"]);
      receipt = sealCheckpoint(descriptor.checkpoint, checkpointKind, true);
    }
    return { taskId: descriptor.taskId, attempt: descriptor.number, status: "complete", workDone: `Implemented ${selectedTask.goal}`,
      ...(receipt ? { checkpointReceipt: receipt } : {}),
      remaining: [], diagnosis: "No pending defects after required checks", usefulProgress: true, continuation: null,
      git: { head: checkout.head, checkpoints: receipt ? [receipt.checkpointRef] : [], wip: "Assigned changes remain uncommitted" }, candidate: copy(checkout),
      checks: selectedTask.checks.map((check: any) => ({ ...check, output: "Observed pass: 1 test", logPaths: [`/native/checks/${descriptor.key}.log`],
        result: "passed", before: copy(checkout), after: copy(checkout) })) };
  };
  function result(request: Request, value: any): Result {
    return { ok: true, agent: request.agent ?? "pitako.reviewer", runId: `native-${request.key}`, output: "Output saved to: /not-the-binding/preview.md",
      outputReference: `/native/output/${request.key}.json`, outputArtifactPath: `/native/binding/${request.key}.json`,
      outputPathMapping: { requestedPath: String(request.output), savedPath: `/native/remapped/${request.key}.json` },
      artifactPaths: [`/native/debug/${request.key}/`], results: [{ index: 0, agent: request.agent ?? "pitako.reviewer",
        task: request.task, exitCode: 0, structuredOutputPath: `/native/witness/${request.key}.json`,
        usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0, turns: 1 } }], structuredOutput: value };
  }
  function normal(request: Request): Result {
    const loop = Number(request.key.match(/\.l(\d+)\./)?.[1] ?? 1);
    let value: any;
    if (request.agent === "pitako.checkout-observer") return { ok: true, key: request.key,
      agent: request.agent, runId: `native-${request.key}`, asyncDir: `/native/async/${request.key}`, artifactPaths: [],
      output: JSON.stringify(observationResponse ? observationResponse(request.key, { version: 1, ok: true, root, commonDir: metadata.commonDir, checkout: { ...checkout, branch: "test", status: "" } }) : { version: 1, ok: true, root, commonDir: metadata.commonDir, checkout: { ...checkout, branch: "test", status: "" } }),
      externalAdapter: {
        adapter: { id: "external-cli", version: 1, executionMode: "one-shot-stdin" },
        capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false,
          supervisor: "unsupported", forkContext: false, extensionBindings: false },
        handoff: { mode: "fresh" }, supervisor: { mode: "unsupported", reason: "Fixed one-shot observer" },
        nonResumableReason: "Fixed one-shot observer", outputArtifacts: { stdoutPath: `/native/async/${request.key}/stdout.log`,
        stderrPath: `/native/async/${request.key}/stderr.log` } },
      results: [{ index: 0, agent: request.agent, task: request.task, exitCode: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] } satisfies WorkflowScriptChildResult;
    if (request.key.endsWith(".director")) { value = plan(loop); value.association = JSON.parse(request.task.split("ASSOCIATION (data): ")[1]!.split("\n")[0]!); }
    else if (request.agent === "pitako.worker") value = worker(request);
    else if (request.key.includes(".recover")) {
      const original = [...native.values()].find(entry => entry.runId === `native-invoke-human-1.l${loop}.director`)?.structuredOutput ?? null;
      value = { status: original ? "recovered" : "lost", reason: "Exact full original native value observed using retained refs", original,
        workerResult: null, originalAvailable: !!original, binding: original ? "identical" : "absent",
        comparison: original ? "equal-full-json" : "neither", provenance: [`/native/binding/invoke-human-1.l${loop}.director.json`] };
    } else if (request.key.endsWith(".compliance")) value = { status: "fulfilled", reason: "Full source inventory matches current requirements and checks", candidate: copy(checkout),
      requirements: Array.from({ length: 17 }, (_, index) => ({ id: `criterion-${index + 1}`, source: `spec:Acceptance criteria:${index + 1}`,
        reason: `Reachable requirement ${index + 1} implemented in actual source`, status: "fulfilled", evidence: ["src/entry.ts:1", "/native/work-result.json"], checks: ["/native/check.log"] })) };
    else if (request.key.endsWith("director-prepare")) value = { status: "ready", reason: "Distinct whole-result risks", angles: Array.from({ length: options.angles ?? 2 }, (_, index) => ({ id: `angle${index + 1}`, focus: `Whole-result angle ${index + 1}`, skills: [] })) };
    else if (request.key.includes("independent-")) value = { status: "ready", reason: "Source checked", coverage: "Whole target", findings: options.findings ? [{ title: "Reachable issue", location: "src/a.ts:1", scenario: "Caller invokes path", evidence: "source protection missing", impact: "current scoped behavior lost", classification: "scoped-defect", requirement: "spec:criterion-1" }] : [] };
    else if (request.key.includes("critique-")) {
      const assigned = JSON.parse(request.task.split("PEER FINDINGS (data):\n")[1]!);
      value = { status: "ready", reason: "All assigned claims checked", challenges: assigned.map((entry: any) => ({ findingId: entry.id, assessment: "supported", evidence: "Concrete source confirms" })) };
    } else if (request.key.includes("defense-")) {
      const own = JSON.parse(request.task.split("YOUR FINDINGS (data):\n")[1]!.split("\nCHALLENGES")[0]!);
      value = { status: "ready", reason: "One response only", responses: own.map((entry: any) => ({ findingId: entry.id, disposition: "maintain", reason: "Source confirms bounded claim" })) };
    } else if (request.key.endsWith("director-synthesis")) {
      const findings = JSON.parse(request.task.split("FINDINGS WITH SCRIPT-ASSIGNED IDS:\n")[1]!.split("\nPEER CHALLENGES")[0]!);
      value = { status: "ready", reason: "Reasoned screening", memo: "Full-result review; include is not material by itself",
        dispositions: findings.map((entry: any) => ({ findingId: entry.id, decision: "include", reason: "Supported but bounded", classification: "scoped-defect", requirement: entry.requirement })),
        screening: { verdict: "clear", reason: "No material gaps in authorized scope", assessments: findings.map((entry: any) => ({ findingId: entry.id, requirement: entry.requirement, consequence: "Non-material bounded issue", material: false, reason: "No mandatory guarantee blocked" })) } };
    } else throw Error(`Unexpected request ${request.key}`);
    return result(request, value);
  }
  const state = {
    get: async (key: string) => copy(storage.get(key)),
    set: async (key: string, value: unknown) => {
      if (failSave?.(value)) throw Error("Controlled essential persistence cut");
      const next = { ...Object.fromEntries(storage), [key]: value };
      const bytes = Buffer.byteLength(JSON.stringify(next, null, 2));
      if (bytes > MISSION_STATE_MAX_BYTES) {
        if ((value as any)?.activePlan) optionalCacheFailures++;
        throw Error(`Mission state exceeds the 256 KiB limit (${bytes} bytes; maximum ${MISSION_STATE_MAX_BYTES} bytes).`);
      }
      storage.set(key, copy(value)); snapshots.push(copy(value));
    },
  };
  // Controlled admission boundary mirrors separate inert data and native digest;
  // the registered Node recovery cases independently exercise the real producer.
  function admissionValue() {
    const base = { version: 1, binding: config.preliminary.binding, checkout: copy(checkout),
      ...(!storage.get("invoke-human-1")?.association ? { admission: { maxCycles: admittedLimit } } : {}) };
    const value = hostResponse ? hostResponse("inspect-initial", base) : base;
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
      calls.push(copy(request)); clock += 10;
      const response = responder ? await responder(request, () => normal(request)) : normal(request);
      if (request.agent === "pitako.worker" && response.structuredOutput?.status !== "complete" && response.structuredOutput &&
          response.structuredOutput.checkpointReceipt?.kind !== "pause")
        delete response.structuredOutput.checkpointReceipt;
      if (response.runId) native.set(response.runId, copy(response)); native.set(request.key, copy(response));
      return response;
    })),
    status: async (ref: string) => { statusCalls.push(ref); return status(ref); },
    host: async (key: string, params: any) => {
      hostCalls.push(key); expect(params).toEqual({ kind: "command", command: key === "execute-settings" ? "SETTINGS" : key.startsWith("inspect-") ? "READ" : "CHUNK", timeoutMs: 86400000 });
      let value: any;
      if (key === "inspect-initial") value = admissionValue();
      else if (key === "execute-settings") value = { maxCycles: admittedLimit };
      else if (key.startsWith("inspect-")) value = transported ? { selected: { digest: selected.digest }, transport: transported.transport, checkout: copy(checkout) } : { ...metadata, checkout: copy(checkout) };
      else { const index = Number(key.slice(6)); value = transported ? transported.packets[index] : { digest: selected.digest, content: chunks[index] }; }
      return { ok: true, stdout: JSON.stringify(hostResponse && key !== "inspect-initial" ? hostResponse(key, value) : value), outputPath: `/native/host/${key}.log` };
    },
  };
  const track = <T>(promise: Promise<T>) => {
    settlements.push(promise.then(() => undefined, () => undefined)); return promise;
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const controlledDate = { now: () => clock };
  return { root, observedCandidate, calls, hostCalls, statusCalls, emits, storage, snapshots, native, plan, worker, result, state,
    setLimit: (value: number) => { admittedLimit = value; },
    optionalCacheFailures: () => optionalCacheFailures,
    setRespond: (value?: typeof responder) => { responder = value; }, setStatus: (value: typeof status) => { status = value; },
    setObservationResponse: (value?: typeof observationResponse) => { observationResponse = value; },
    setHostResponse: (value?: typeof hostResponse) => { hostResponse = value; }, setFailSave: (value?: typeof failSave) => { failSave = value; },
    changeCheckout: (version = 1) => {
      writeFileSync(path.join(root, "candidate-drift"), String(version)); checkout = observedCandidate();
    }, advance: (ms: number) => { clock += ms; },
    current: () => storage.get("invoke-human-1"),
    execute: (override = {}, script = source): Promise<Outcome> => track(new AsyncFunction("config", "runs", "state", "emit", "Date", script)(workflowConfig(override), runs, state, (value: any) => emits.push(copy(value)), controlledDate)),
    executeNative: (override = {}): Promise<Outcome> => track((async () => {
      const observed = await runWorkflowScript({ script: `const config = ${JSON.stringify(workflowConfig(override))};\n${source}`, state,
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
