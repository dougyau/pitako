import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureCheckpoint, sealCheckpoint } from "../extensions/execute-checkpoint.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { checkoutEvidence, digest, inspectionSnapshot, MAX_SPEC_BYTES, specChunks } from "../extensions/spec-plans.ts";
import { MISSION_STATE_MAX_BYTES } from "../node_modules/pi-subagents/src/missions/workflow-state.js";
import { runWorkflowScript, validateWorkflowScript, type WorkflowScriptChildResult } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";

const executeSource = readFileSync(new URL("../skills/execute/workflow.js", import.meta.url), "utf8");
const reviewSource = readFileSync(new URL("../skills/review/workflow.js", import.meta.url), "utf8");
const source = `const pitakoReviewLibraryMode = true;\n${reviewSource}\n${executeSource}`;
const globalConfig = {
  root: "/owned/designated", id: "spec", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/exact-mission",
  inspections: ["initial", "loop-1", "loop-2", "loop-3", "loop-4"].map(phase => ({ key: `inspect-${phase}`, command: "READ" })),
  settings: { key: "execute-settings", command: "SETTINGS" }, sourceRefs: [],
  chunks: Array.from({ length: 26 }, (_, index) => ({ key: `input-${index}`, command: "CHUNK" })),
};
const config = globalConfig;
type Candidate = { head: string; fingerprint: string };
type Request = { key: string; agent?: string; resume?: string; context?: string; cwd?: string; task: string;
  label?: string; phase?: string;
  output?: string | boolean; outputSchema?: any; timeoutMs?: number; reads?: boolean; progress?: boolean; acceptance?: any; async?: boolean };
type Result = Omit<Partial<WorkflowScriptChildResult>, "state"> & { ok: boolean; state?: string; structuredOutput?: any; [key: string]: any };
type Outcome = { status: string; reason: string; loopsConsumed: number; loopReport: any; tokens: any; elapsedMs: number; [key: string]: any };
const copy = <T>(value: T): T => structuredClone(value);
const candidate = (version = 0): Candidate => ({ head: "a".repeat(40), fingerprint: String(version).padStart(64, "0") });
const task = (id: string, kind = "implementation") => ({ id, kind, goal: `Goal ${id}`, contextRefs: ["shared"], sourceRefs: ["spec:criterion-1"],
  scope: [`src/${id}.ts`], allowedEffects: kind === "verification" ? ["read/check"] : ["edit assigned path"], expectedResult: `Result ${id}`,
  dependsOn: [] as { taskId: string; reason: string }[],
  checks: [{ id: `${id}-check`, requirement: "spec:criterion-1", command: `bun test ${id}`, cwd: config.root }] });
const roots: string[] = [];
const settlements: Promise<unknown>[] = [];
afterEach(async () => {
  await Promise.all(settlements.splice(0));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(content = "COMPLETE IMMUTABLE SPECS", options: { metadataPadding?: number; taskCount?: number; angles?: number; findings?: boolean; readOnly?: boolean } = {}) {
  // Controller fixtures own real preimages/seals, even when the controlled worker
  // is a no-op. Candidate-drift cases change actual WIP, never seal invented hashes.
  const root = mkdtempSync(path.join(tmpdir(), "pitako-execute-controller-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial");
  const config = { ...globalConfig, root };
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
  let admittedLimit = 3;
  let failSave: ((value: any) => boolean) | undefined;
  let status: (ref: string) => Result | Promise<Result> = ref => copy(native.get(ref) ?? { ok: true, output: "", results: [] });
  let responder: ((request: Request, normal: () => Result) => Result | Promise<Result>) | undefined;
  let hostResponse: ((key: string, value: any) => any) | undefined;
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
      if (key === "execute-settings") value = { maxCycles: admittedLimit };
      else if (key.startsWith("inspect-")) value = transported ? { selected: { digest: selected.digest }, transport: transported.transport, checkout: copy(checkout) } : { ...metadata, checkout: copy(checkout) };
      else { const index = Number(key.slice(6)); value = transported ? transported.packets[index] : { digest: selected.digest, content: chunks[index] }; }
      return { ok: true, stdout: JSON.stringify(hostResponse ? hostResponse(key, value) : value), outputPath: `/native/host/${key}.log` };
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
    setHostResponse: (value?: typeof hostResponse) => { hostResponse = value; }, setFailSave: (value?: typeof failSave) => { failSave = value; },
    changeCheckout: (version = 1) => {
      writeFileSync(path.join(root, "candidate-drift"), String(version)); checkout = observedCandidate();
    }, advance: (ms: number) => { clock += ms; },
    current: () => storage.get("invoke-human-1"),
    execute: (override = {}, script = source): Promise<Outcome> => track(new AsyncFunction("config", "runs", "state", "emit", "Date", script)({ ...config, ...override }, runs, state, (value: any) => emits.push(copy(value)), controlledDate)),
    executeNative: (override = {}): Promise<Outcome> => track((async () => {
      const observed = await runWorkflowScript({ script: `const config = ${JSON.stringify({ ...config, ...override })};\n${source}`, state,
        launch: async (key, params) => ({ key, artifactPaths: [], ...(await runs.all([{ ...params, key } as Request]))[0] } as WorkflowScriptChildResult),
        status: async ref => ({ key: ref, output: "", artifactPaths: [], ...await runs.status(ref) } as WorkflowScriptChildResult),
        host: async (key, params) => ({ ...await runs.host(key, params), key, kind: "command", state: "passed", exitCode: 0, stderr: "", durationMs: 0 }),
        onEmit: values => { emits.splice(0, emits.length, ...values); },
      });
      return observed.value as Outcome;
    })()),
  };
}
function gaps(result: Result) {
  const value = copy(result); value.structuredOutput.status = "gaps";
  value.structuredOutput.reason = "Concrete full-spec gap at src/missing.ts:1";
  value.structuredOutput.requirements[0].status = "gap"; return value;
}
function closedInterruptedProducer(result: Result, cause: "stopped" | "permission" = "stopped"): Result {
  // Supported native SingleResult closure fields; not an invented stopped
  // terminalOutcome. The failure remains a failure and is never admitted as work.
  return { ...result, ok: false,
    ...(cause === "stopped" ? { stopped: true } : { error: "Blocked by pi-subagents permission rule: 'run' is denied." }),
    results: result.results?.map(item => ({ ...item, exitCode: cause === "stopped" ? -1 : 1,
      processSignal: cause === "stopped" ? "SIGTERM" : null })) };
}
function cutAt(host: ReturnType<typeof fixture>, predicate: (value: any) => boolean) {
  host.setFailSave(value => predicate(value) && !value.activePlan);
}
function removeCache(host: ReturnType<typeof fixture>) { const value = host.current(); value.activePlan = null; host.storage.set("invoke-human-1", value); }
function expectImpediment(host: ReturnType<typeof fixture>, output: Outcome, status: string, cause: string, persistence?: string) {
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

describe("workflow-owned execute controller", () => {
  // Hold the observer input fixed to test durable dispatch policy; the registered
  // Node loss-reentry case covers real inspection, journaled bytes and tool loading.
  test.each([
    { status: "blocked", retained: "current" },
    { status: "continue", retained: "current" },
    { status: "gaps", retained: "current" },
    { status: "blocked", retained: "missing-evidence" },
    { status: "blocked", retained: "missing-authority" },
    { status: "blocked", retained: "conflicting-authority" },
  ])("pause recovery does not renew a lost writer: $status / $retained", async ({ status, retained }) => {
    const host = fixture("FULL SPECS", { taskCount: 2 });
    host.setHostResponse((key, value) => {
      const loop = host.current()?.loops[0], attempt = loop?.attempt;
      return !key.startsWith("inspect-") || !attempt ? value : { ...value, checkpointObservation: {
        key: attempt.key, taskId: attempt.taskId, attempt: attempt.number, loop: loop.number, cursor: loop.cursor,
        manifest: path.join(host.root, ".pi/subagents/checkpoints", attempt.key, "manifest.json"),
        evidence: digest("unchanged checkpoint observation"),
      } };
    });
    host.setRespond((request, normal) => {
      if (request.key.endsWith(".t2.a1")) return host.result(request, {
        ...host.worker(request, "pause"), status, remaining: ["Finish pending second unit"],
        continuation: "Resume the admitted pause",
      });
      if (request.key.endsWith(".t2.a2")) return {
        ok: false, output: "", error: "Restoration transport disappeared before useful effects",
      };
      return normal();
    });
    expect((await host.execute()).status).toBe("blocked");
    const paused = copy(host.current()), point = paused.loops[0].confirmedCheckpoint;
    expect(point).toMatchObject({ kind: "pause", taskId: "change2", position: { cursor: 1 } });
    expect(paused.loops[0].results.map((result: any) => result.status)).toEqual(["complete", status]);
    const yieldedCalls = copy(host.calls);
    expect((await host.execute()).status).toBe("blocked");
    expect(host.calls).toEqual(yieldedCalls);

    expect((await host.execute({ unblock: true, resolution: { loop: 1, text: "Resume the saved pending unit" } })).status).not.toBe("complete");
    const loop = host.current().loops[0];
    expect(host.calls.filter(call => call.key.endsWith(".t2.a2"))).toHaveLength(1);
    expect(loop.attempt.restore.authority.confirmedPause).toEqual(paused.loops[0].results[1].checkpoint.confirmation);
    expect(loop.attempt.restore.evidence).toBe(digest("unchanged checkpoint observation"));
    if (retained !== "current") {
      loop.attempt.restore.evidence = null;
      if (retained === "missing-authority") delete loop.attempt.restore.authority.confirmedPause;
      if (retained === "conflicting-authority") loop.attempt.restore.authority.confirmedPause.digest = "0".repeat(64);
    }
    const pending = copy(loop.attempt.restore), calls = copy(host.calls);
    for (let reentry = 0; reentry < 2; reentry++) {
      const outcome = await host.execute();
      expect(outcome.status).not.toBe("complete");
      expect(outcome.loopsConsumed).toBe(1);
      expect(outcome.reason).toContain(retained.includes("authority") ? "Confirmed pause conflicts" : "no new checkpoint evidence");
      expect(host.calls).toEqual(calls);
      expect(host.current().association).toEqual(paused.association);
      expect(host.current().loops).toHaveLength(1);
      expect(host.current().loops[0].cursor).toBe(1);
      expect(host.current().loops[0].results).toEqual(paused.loops[0].results);
      expect(host.current().loops[0].confirmedCheckpoint).toEqual(point);
      expect(host.current().loops[0].attempt.restore).toEqual(pending);
    }
    expect(host.calls.map(call => call.key)).toEqual([...yieldedCalls.map(call => call.key), "invoke-human-1.l1.t2.a2"]);
  });

  // Rejects both retroactive checkpoint fabrication for a retained legacy
  // intention and accidental exemption of the next newly dispatched writer.
  // This is a controlled old-contract fixture, not historical-state replay.
  test.each(["sealed", "missing-receipt"])("checkpoint legacy intention replay enforces the next new unit: %s", async mode => {
    const host = fixture("FULL SPECS", { taskCount: 2 });
    const progressContract = `,
            progress: { consumedLoops: invocation.loops.length,
              admittedResults: loop.results.map(result => ({ taskId: result.taskId, attempt: result.attempt,
                status: result.status, ref: clone(result.ref) })) }`;
    expect(source.split(progressContract)).toHaveLength(2);
    const legacySource = source.replace(progressContract, "");
    cutAt(host, value => value.loops?.[0]?.attempt?.stage === "result");
    expect((await host.execute({}, legacySource)).status).toBe("partial");
    const retained = copy(host.current()), original = copy(host.native.get("native-invoke-human-1.l1.t1.a1"));
    expect(retained.loops[0].attempt.checkpoint).not.toHaveProperty("progress");
    expect(original!.structuredOutput).not.toHaveProperty("checkpointReceipt");
    host.setFailSave();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.t2.a1") {
        const intent = host.current().loops[0].attempt.checkpoint;
        expect(intent.progress).toMatchObject({ consumedLoops: 1,
          admittedResults: [{ taskId: "change1", attempt: 1, status: "complete" }] });
        expect(result.structuredOutput.checkpointReceipt).toMatchObject({ kind: "unit", progress: intent.progress });
        // The seal really exists; omission from the new result still forbids admission.
        expect(existsSync(result.structuredOutput.checkpointReceipt.checkpointRef)).toBe(true);
        if (mode === "missing-receipt") delete result.structuredOutput.checkpointReceipt;
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe(mode === "sealed" ? "complete" : "blocked");
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
    expect(host.native.get("native-invoke-human-1.l1.t1.a1")).toEqual(original);
    expect(host.current().association).toEqual(retained.association);
    expect(host.current().loops).toHaveLength(1);
    expect(host.current().loops[0].results[0].checkpoint).not.toHaveProperty("confirmation");
    if (mode === "sealed") {
      expect(host.current().loops[0].confirmedCheckpoint).toMatchObject({ taskId: "change2", kind: "unit", position: { cursor: 2 } });
      expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(true);
    } else {
      expect(output.reason).toContain("lacks required sealed file/progress checkpoint");
      expect(host.current().loops[0].results).toHaveLength(1);
      expect(host.current().loops[0].confirmedCheckpoint).toBeUndefined();
      expect(host.calls.some(call => call.key.includes(".t3."))).toBe(false);
    }
  });

  test.each(["unknown", "complete", "wrapped-complete", "native-complete"])(
    "retained file fallback requires actual settlement: %s", async mode => {
      const host = fixture();
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key.endsWith("director-prepare"))
          Object.assign(result.structuredOutput, { status: "blocked", reason: "Prior semantic impediment" });
        return result;
      });
      expect((await host.executeNative()).status).toBe("blocked");
      const prior = copy(host.current()), calls = host.calls.length;
      const ref = prior.loops[0].review.references[0];
      host.setHostResponse((key, value) => key === "inspect-initial" ? {
        ...value, retainedAnalyses: [{ key: ref.key, runId: ref.runId, ok: true,
          ...(mode === "native-complete" ? { state: "complete" } : {}),
          structuredOutput: copy(host.native.get(ref.runId)!.structuredOutput) }],
      } : value);
      host.setStatus(runId => ({ ok: true, runId, results: [], output: mode.includes("complete") && mode !== "native-complete" ?
        `${mode === "wrapped-complete" ? `Status target: run ${runId}\nSpawn budget: 1/10\nActive async capacity: 0/5\n` : ""}Run: ${runId}\nState: complete` :
        "Preview only; no settlement receipt" }));
      const result = await host.executeNative();
      expect(result.status).toBe("blocked");
      expect(result.reason).toContain(mode === "unknown" ? "Read-only producer settlement uncertain" : "Prior");
      expect(host.calls).toHaveLength(calls);
      expect(host.current().loops[0].results).toEqual(prior.loops[0].results);
      expect(host.current().loops[0].review.references).toMatchObject(prior.loops[0].review.references.map((entry: any) =>
        mode === "unknown" ? entry : { ...entry, reused: true }));
    });

  test("compliance reentry preserves original references with metadata-only management delivery", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".compliance")) result.structuredOutput.status = "blocked";
      return result;
    });
    expect((await host.executeNative()).status).toBe("blocked");
    const prior = copy(host.current()), calls = host.calls.length;
    const refs = [...prior.loops[0].review.references, prior.loops[0].compliance.ref];
    host.setHostResponse((key, value) => key === "inspect-initial" ? {
      ...value, retainedAnalyses: refs.map(ref => ({
        key: ref.key, runId: ref.runId, ok: true,
        structuredOutput: copy(host.native.get(ref.runId)!.structuredOutput),
      })),
    } : value);
    host.setStatus(ref => ({ ok: true, runId: ref, output: `Run: ${ref}\nState: complete`, results: [] }));
    expect((await host.executeNative()).status).toBe("blocked");
    expect(host.calls).toHaveLength(calls);
    expect(host.current().loops[0].compliance.ref).toEqual(prior.loops[0].compliance.ref);
    expect(host.current().loops[0].review.references).toEqual(prior.loops[0].review.references);
    expect(host.current().loops[0].results).toEqual(prior.loops[0].results);
  });

  test.each(["conflict", "escape", "stopped", "pending"])(
    "a full management body does not hide retained %s evidence", async mode => {
      const host = fixture();
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key.endsWith("director-prepare")) result.structuredOutput.status = "blocked";
        return result;
      });
      expect((await host.executeNative()).status).toBe("blocked");
      const prior = copy(host.current()), calls = host.calls.length;
      const ref = prior.loops[0].review.references[0];
      host.setHostResponse((key, value) => key === "inspect-initial" ? {
        ...value, retainedAnalyses: [{ key: ref.key, runId: ref.runId, ok: false,
          ...(mode === "conflict" ? { error: "Conflicting complete retained analysis originals." } :
            mode === "escape" ? { error: "Structured original escapes its retained native producer." } :
              { state: mode === "stopped" ? "stopped" : "pending" }) }],
      } : value);
      const result = await host.executeNative();
      expect(result.status).toBe(mode === "stopped" ? "cancelled" : "blocked");
      expect(host.calls).toHaveLength(calls);
      expect(host.current().loops[0].review.references).toEqual(prior.loops[0].review.references);
      expect(host.current().loops[0].results).toEqual(prior.loops[0].results);
      expect(result.reason).toContain(mode === "conflict" ? "Conflicting complete" :
        mode === "escape" ? "escapes its retained" : mode === "stopped" ? "Execution cancelled" : "Positive native barrier");
    });

  test.each(["stopped", "permission", "unavailable"])("current %s after a historical semantic block still prevents continuation", async mode => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith("director-prepare"))
        Object.assign(result.structuredOutput, { status: "blocked", reason: "Prior semantic impediment" });
      return result;
    });
    expect((await host.executeNative()).status).toBe("blocked");
    expect(host.current().loops[0].halt.code).toBe("semantic-block");
    const prior = copy(host.current()), calls = host.calls.length;
    host.setStatus(ref => {
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      if (mode === "unavailable") return { ok: true, output: "A preview is not the complete result", results: [] };
      return { ok: true, output: `Run: ${ref}\nState: stopped`, results: [] };
    });
    const result = await host.executeNative();
    expect(result).toMatchObject({ status: mode === "stopped" ? "cancelled" : "blocked", loopsConsumed: 1 });
    expect(host.current().association).toEqual(prior.association);
    // The current missing original is a recovery impediment, not the earlier
    // semantic verdict. It must not erase that verdict's producer references.
    expect(host.current().loops[0].halt).toMatchObject({ code: mode === "unavailable" ? "recovery" : "native-barrier" });
    if (mode === "unavailable") expect(result.reason).toContain("Complete retained analysis unavailable");
    expect(host.calls).toHaveLength(calls);
    expect(host.current().loops[0].results).toEqual(prior.loops[0].results);
    expect(host.current().loops[0].review.references).toEqual(prior.loops[0].review.references);
    expect((await host.executeNative()).status).toBe(result.status);
    expect(host.calls).toHaveLength(calls);
  });


  // Reject a replacement inspector after its result returned but admission save
  // failed. Management previews alone must not hide its exact retained original.
  test.each(["complete", "pending", "unknown-settlement", "conflict", "wrong-run", "missing", "current-stop", "current-permission", "current-run-conflict"])(
    "pending recovery receipt reconciles its retained original: %s", async mode => {
      const host = fixture(), director = "invoke-human-1.l1.director";
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.execution-inspector") return host.result(request, {
          status: "recovered", reason: "Exact associated original retained", original: host.plan(), workerResult: null,
          originalAvailable: true, binding: "absent", comparison: "only-original", provenance: ["/native/original.json"],
        });
        return request.key === director ? { ...result, structuredOutput: undefined } : result;
      });
      cutAt(host, value => value.loops?.[0]?.recoveries?.[0]?.stage === "observed");
      expect((await host.executeNative()).status).toBe("partial");
      host.setFailSave();
      const recovery = copy(host.current().loops[0].recoveries[0]), calls = host.calls.length;
      expect(recovery.stage).toBe("intention");
      expect(typeof recovery.ref.runId).toBe("string");
      const receipt = copy(host.native.get(recovery.ref.key)!);
      host.setStatus(ref => ({ key: ref, runId: ref === recovery.ref.runId && mode === "current-run-conflict" ? "other-producer" : ref, ok: true,
        ...(ref === recovery.ref.runId && mode === "current-stop" ? { stopped: true } : {}),
        ...(ref === recovery.ref.runId && mode === "current-permission" ? { error: "Blocked by pi-subagents permission rule: 'run' is denied." } : {}),
        output: mode === "unknown-settlement" && ref === recovery.ref.runId ? "No current settlement inventory" : `Run: ${ref}\nState: complete`,
        results: [] }));
      host.setHostResponse((key, value) => key === "inspect-initial" ? { ...value, retainedAnalyses: mode === "missing" ? [] : [{
        key: recovery.ref.key, runId: mode === "wrong-run" ? "other-producer" : recovery.ref.runId, ok: true,
        ...(mode === "complete" || mode === "conflict" ? { state: "complete" } : mode === "pending" ? { state: "running" } : {}),
        ...(mode === "conflict" ? { ok: false, error: "Conflicting complete retained analysis originals." } : {}),
        structuredOutput: receipt.structuredOutput,
      }] } : value);
      const result = await host.executeNative();
      expect(result.status, result.reason).toBe(mode === "complete" ? "complete" : mode === "current-stop" ? "cancelled" : "blocked");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.slice(calls).filter(call => call.key.endsWith(".director"))).toHaveLength(0);
      expect(host.current().loops).toHaveLength(1);
      expect(host.current().association.maxCycles).toBe(3);
      if (mode !== "complete") expect(host.calls).toHaveLength(calls);
      else {
        expect(host.current().loops[0].recoveries[0]).toMatchObject({ stage: "observed", disposition: "recovered" });
        expect(host.calls.slice(calls).some(call => call.key.endsWith(".compliance"))).toBe(true);
      }
    });

  // Read-only continuation still reconciles its exact query; it has no file
  // checkpoint to restore. Modifying recovery is covered by real checkpoint
  // composition below, and must not inherit this historical-query prerequisite.
  test.each(["loop-plan", "attempt-result", "interrupted-operation"].flatMap(subject =>
    ["unavailable", "closed", "complete"].flatMap(producer =>
      ["pending", "unknown", "conflict", "binding", "unresolved", "provenance", "invalid-value", "incomplete-value", "usable",
        ...(producer === "closed" && subject === "attempt-result" ? ["cache-missing", "scope"] : []),
        ...(producer === "closed" && subject === "interrupted-operation" ? ["key-only", "key-only-no-run"] : []),
        ...(producer === "closed" ? ["observed-cut", "validated-cut", "applied-cut", "next-slot-cut"] : [])].map(observation =>
        ({ subject, producer, observation })))))(
    "continuation reconciles retained $subject $observation before $producer producer effects", async ({ subject, producer, observation }) => {
      const host = fixture(undefined, { readOnly: true }), workerKey = "invoke-human-1.l1.t1.a1";
      const target = subject === "loop-plan" ? "invoke-human-1.l1.director" : workerKey;
      let complete: Result;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key === target) {
          complete = copy(result);
          return subject === "interrupted-operation" ? closedInterruptedProducer(result) : { ...result, structuredOutput: undefined };
        }
        if (request.agent === "pitako.execution-inspector")
          return { ...result, ok: false, stopped: true };
        return result;
      });
      if (subject === "interrupted-operation") {
        expect((await host.executeNative()).status).toBe("cancelled");
        host.setStatus(ref => ref === target || ref === `native-${target}`
          ? { ok: false, results: [] } : copy(host.native.get(ref)!));
        await host.executeNative({ unblock: true, resolution: { loop: 1, text: "First current request; observe exact interrupted receipt." } });
      } else expect((await host.executeNative()).status).toBe("cancelled");
      if (observation.startsWith("key-only")) {
        const recovery = host.current().loops[0].recoveries[0];
        recovery.ref = { key: recovery.ref.key }; // durable intention / native-return-before-receipt cut
      }
      const retained = copy(host.current().loops[0].recoveries[0]);
      const count = host.calls.length, original = copy(host.native.get(target)!);
      const receipt = host.result({ key: retained.ref.key, agent: "pitako.execution-inspector", task: "Exact retained observation" }, {
        status: observation === "unresolved" ? "unresolved" : "recovered", reason: "Exact retained observation, no repair authority",
        original: subject === "loop-plan" ? complete!.structuredOutput
          : subject === "interrupted-operation" ? closedInterruptedProducer(complete!) : null,
        workerResult: subject === "attempt-result" ? complete!.structuredOutput : null,
        originalAvailable: true, binding: "absent", comparison: "only-original", provenance: [complete!.outputReference],
      });
      if (observation === "pending") receipt.state = "running";
      if (observation === "unknown") { receipt.ok = false; delete receipt.structuredOutput; }
      if (observation === "conflict") receipt.runId = "different-inspector";
      if (observation === "key-only-no-run") delete receipt.runId;
      if (observation === "binding") receipt.output = JSON.stringify({ ...receipt.structuredOutput, reason: "Different full value" });
      if (observation === "provenance") receipt.structuredOutput.provenance = [];
      if (observation === "invalid-value") {
        if (subject === "loop-plan") receipt.structuredOutput.original.association.invocation = "different";
        else if (subject === "attempt-result") receipt.structuredOutput.workerResult.taskId = "different";
        else receipt.structuredOutput.original.runId = "different";
      }
      if (observation === "incomplete-value") {
        if (subject === "loop-plan") receipt.structuredOutput.original.tasks = [];
        else if (subject === "attempt-result") receipt.structuredOutput.workerResult.checks = [];
        else { receipt.structuredOutput.original.ok = true; receipt.structuredOutput.original.results = []; }
      }
      if (observation === "cache-missing") removeCache(host);
      if (observation === "scope") Object.assign(receipt.structuredOutput.workerResult, {
        status: "blocked", diagnosis: "Required action exceeds the authorized scope; do not perform it.",
        remaining: ["Scope expansion is required for the concrete action."],
      });
      host.setStatus(ref => ref === retained.ref.runId || ref === retained.ref.key ? copy(receipt)
        : ref === target || ref === `native-${target}` ? producer === "closed" ? closedInterruptedProducer(complete!)
          : producer === "complete" ? copy(complete!) : { ok: false, results: [] }
        : copy(host.native.get(ref)!));
      host.setRespond((_request, normal) => normal());
      let observedWrites = 0;
      if (observation.endsWith("-cut")) host.setFailSave(value => {
        if (value.activePlan) return false;
        const record = value.loops?.[0];
        if (record?.recoveries?.[0]?.stage === "observed") observedWrites++;
        return observation === "observed-cut" ? observedWrites === 1
          : observation === "validated-cut" ? observedWrites === 2
          : observation === "applied-cut" ? record?.resolutions?.at(-1)?.stage === "applied" : value.loops?.length === 2;
      });
      let output = await host.execute({ unblock: true, resolution: { loop: 1, text: "Current request after reconciling every retained intention." } });
      if (observation.endsWith("-cut")) {
        expect(output.status).not.toBe("complete");
        expect(output.reason).toContain("Essential persistence failed");
        expect(host.calls).toHaveLength(count);
        host.setFailSave();
        output = await host.execute();
      }
      const canContinue = (["usable", "cache-missing", "key-only"].includes(observation) || observation.endsWith("-cut")) &&
        (producer === "closed" || producer === "unavailable" && subject === "interrupted-operation");
      if (canContinue) expect(output.status, JSON.stringify({ reason: output.reason, statuses: host.statusCalls, halt: host.current().loops[0].halt })).toBe("complete");
      else expect(output.status).not.toBe("complete");
      expect(host.statusCalls).toContain(retained.ref.runId ?? retained.ref.key);
      expect(host.calls.slice(count).every(call => canContinue && call.key.startsWith("invoke-human-1.l2."))).toBe(true);
      expect(host.current().loops).toHaveLength(canContinue ? 2 : 1);
      expect(host.current().loops[0].recoveries).toHaveLength(1);
      expect(host.current().loops[0].recoveries[0]).toMatchObject({
        subject: retained.subject, phase: retained.phase, association: retained.association, source: retained.source,
        ref: { key: retained.ref.key, ...(retained.ref.runId ? { runId: retained.ref.runId } : {}) },
      });
      expect(host.native.get(target)).toEqual(original);
      const after = host.calls.length;
      await host.execute();
      expect(host.calls).toHaveLength(after);
    });

  // Reject treating an unknown transport cause as Stop or requiring --unblock
  // for ordinary technical reconstruction. Closing replay must not repeat work.
  test.each(["inspect-initial", "input-0", "inspect-loop-1"])(
    "technical host reentry reconstructs without redundant human input at %s", async target => {
      const host = fixture();
      host.setHostResponse((key, value) => {
        if (key === target) throw Error(`Host command '${target}' failed: Command stopped because the workflow was aborted.`);
        return value;
      });
      expect((await host.execute()).status).toBe("blocked");
      const original = copy(host.current().hostHalt), calls = host.calls.length;
      host.setHostResponse();
      expect((await host.execute()).status).toBe("complete");
      expect(host.current().hostHalt).toEqual(original);
      expect(host.current().hostReconstruction).toMatchObject({ source: original, stage: "admitted" });
      expect(host.current().resolutions).toBeUndefined();
      expect(host.current().loops).toHaveLength(1);
      if (target === "inspect-loop-1") expect(host.calls).toHaveLength(calls);
      const completed = host.calls.length;
      expect((await host.execute()).status).toBe("complete");
      expect(host.calls).toHaveLength(completed);
    });

  // A durable intention is not a receipt. Repeating only the fixed pure reads
  // must reconstruct state, not repeat an admitted worker or a pending query.
  test.each(["inspect-initial", "input-0", "inspect-loop-1"])(
    "technical host committed reconstruction intention resumes pure projections at %s", async target => {
      const host = fixture();
      host.setHostResponse((key, value) => {
        if (key === target) throw Error("Controlled ambiguous transport failure");
        return value;
      });
      expect((await host.execute()).status).toBe("blocked");
      const original = copy(host.current().hostHalt), priorCalls = host.calls.length;
      host.current().hostReconstruction = { source: copy(original), stage: "intention" };
      host.setHostResponse();
      expect((await host.execute()).status).toBe("complete");
      expect(host.current().hostHalt).toEqual(original);
      expect(host.current().hostReconstruction).toMatchObject({ source: original, stage: "admitted",
        observation: { ref: { key: "inspect-initial", outputReference: "/native/host/inspect-initial.log" },
          candidate: host.observedCandidate(), source: host.current().association.source,
          digest: host.current().association.digest } });
      expect(host.current().loops).toHaveLength(1);
      expect(host.current().association.maxCycles).toBe(3);
      expect(host.current().resolutions).toBeUndefined();
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
      if (target === "inspect-loop-1") expect(host.calls).toHaveLength(priorCalls);
      const completed = host.calls.length;
      expect((await host.execute()).status).toBe("complete");
      expect(host.calls).toHaveLength(completed);
    });

  test("technical host intention replay cannot replace a pending read-only model recovery", async () => {
    const host = fixture(undefined, { readOnly: true });
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") delete result.structuredOutput;
      if (request.agent === "pitako.execution-inspector") result.state = "running";
      return result;
    });
    expect((await host.execute()).status).toBe("blocked");
    const pending = copy(host.current().loops[0].recoveries[0]);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
    host.setHostResponse(() => { throw Error("Controlled host transport failure on reentry"); });
    expect((await host.execute()).status).toBe("blocked");
    host.current().hostReconstruction = { source: copy(host.current().hostHalt), stage: "intention" };
    const calls = host.calls.length;
    host.setHostResponse();
    expect((await host.execute()).status).toBe("blocked");
    expect(host.current().hostReconstruction.stage).toBe("admitted");
    expect(host.current().loops[0].recoveries[0]).toEqual(pending);
    expect(host.current().loops).toHaveLength(1);
    expect(host.calls).toHaveLength(calls);
  });

  test.each(["stopped", "pending", "permission"])(
    "technical host reentry preserves observed %s without current human input", async cause => {
      const host = fixture();
      host.setHostResponse(() => { throw Error("Controlled ambiguous host failure"); });
      await host.execute();
      const checkpoint = host.current();
      if (cause === "permission") checkpoint.hostHalt.observedBarrier = "native permission denial";
      else checkpoint.hostHalt.observedState = cause;
      host.storage.set("invoke-human-1", copy(checkpoint));
      const original = copy(host.current()), calls = host.hostCalls.length;
      host.setHostResponse();
      expect((await host.execute()).status).toBe("blocked");
      expect(host.hostCalls).toHaveLength(calls);
      expect(host.current()).toEqual(original);
      expect(host.calls).toHaveLength(0);
    });

  test.each(["intention", "failure"])("technical host reconstruction %s cannot dispatch blindly on replay", async cut => {
    const host = fixture();
    host.setHostResponse(() => { throw Error("Controlled read-only failure"); });
    await host.execute();
    if (cut === "intention") {
      host.setHostResponse();
      cutAt(host, value => value.hostReconstruction?.stage === "intention");
    }
    const second = await host.execute();
    expect(second.status).not.toBe("complete");
    const calls = host.hostCalls.length;
    host.setFailSave(); host.setHostResponse();
    // A cut before saving the intention has launched nothing, so reentry may
    // safely persist it. A failed attempted inspection cannot renew its route.
    const replay = await host.execute();
    if (cut === "failure") {
      expect(replay.status).toBe("blocked");
      expect(host.hostCalls).toHaveLength(calls);
      expect(host.current().hostReconstruction.stage).toBe("failed");
    } else expect(replay.status).toBe("complete");
  });

  // Reject a permanent historical-host veto, fabricated Stop classification,
  // repeated completed producers, and renewal/double consumption of loop slots.
  test.each(["inspect-initial", "input-0", "inspect-loop-1"])(
    "current human resolution reconstructs after historical host ambiguity at %s", async target => {
      const host = fixture();
      host.setHostResponse((key, value) => {
        if (key === target) throw Error(`Host command '${target}' failed: Command stopped because the workflow was aborted.`);
        return value;
      });
      expect((await host.execute()).status).toBe("blocked");
      const original = copy(host.current().hostHalt), count = host.calls.length;
      expect(original).not.toHaveProperty("observedState");
      expect(host.current().association === undefined).toBe(target !== "inspect-loop-1");
      const loops = host.current().loops?.length ?? 0;
      host.setHostResponse();
      const input = { unblock: true, resolution: { loop: loops, text: "Continue the same request; reconstruct state under current native policy." } };
      expect((await host.execute(input)).status).toBe("complete");
      expect(host.current().hostHalt).toEqual(original);
      const retained = loops ? host.current().loops[0].resolutions[0] : host.current().resolutions[0];
      expect(retained).toMatchObject({ text: input.resolution.text, hostHalt: original });
      expect(host.current().loops).toHaveLength(1);
      if (target === "inspect-loop-1") expect(host.calls).toHaveLength(count);
      const complete = host.calls.length;
      expect((await host.execute(input)).status).toBe("complete");
      expect(host.calls).toHaveLength(complete);
    });

  test.each(["stopped", "pending"])("checkpointed host %s is retained, not fabricated from text", async observedState => {
    const host = fixture();
    host.setHostResponse(key => { throw Error(`Host command '${key}' failed: Command stopped because the workflow was aborted.`); });
    expect((await host.execute()).status).toBe("blocked");
    // Model an already-retained checkpoint that really has a structured state;
    // the ambiguous native exception in the adjacent test does NOT supply it.
    const checkpoint = host.current();
    checkpoint.hostHalt.observedState = observedState;
    checkpoint.hostHalt.status = observedState === "stopped" ? "cancelled" : "blocked";
    host.storage.set("invoke-human-1", copy(checkpoint));
    const original = copy(checkpoint.hostHalt), calls = host.hostCalls.length;
    host.setHostResponse();
    const output = await host.execute({ unblock: true, resolution: { loop: 0, text: "Continue state reconstruction under current native authority." } });
    expect(output.status).toBe(observedState === "stopped" ? "complete" : "blocked");
    expect(host.current().hostHalt).toEqual(original);
    expect(host.current().resolutions[0].hostHalt).toEqual(original);
    if (observedState === "pending") {
      expect(host.hostCalls).toHaveLength(calls);
      expect(host.calls).toHaveLength(0);
      expect(host.current()).not.toHaveProperty("association");
    }
  });

  test.each(["accepted", "applied"])("host resolution %s cut replays without another human input", async cut => {
    const host = fixture();
    host.setHostResponse(key => { throw Error(`Host command '${key}' failed: Command stopped because the workflow was aborted.`); });
    expect((await host.execute()).status).toBe("blocked");
    const original = copy(host.current().hostHalt);
    host.setHostResponse();
    cutAt(host, value => value.resolutions?.[0]?.stage === cut);
    expect((await host.execute({ unblock: true, resolution: { loop: 0, text: "Continue bounded state reconstruction under current policy." } })).reason)
      .toContain("Essential persistence failed");
    host.setFailSave();
    expect((await host.execute()).status).toBe("complete");
    const calls = host.calls.length;
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls).toHaveLength(calls);
    expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(1);
    expect(host.current().resolutions).toHaveLength(1);
    expect(host.current().resolutions[0]).toMatchObject({ stage: "applied", hostHalt: original });
    expect(host.current().hostHalt).toEqual(original);
  });

  // A prior answer does not settle a later failure. Equally, that answer must
  // not turn an otherwise recoverable technical read into a human-only veto.
  test.each(["none", "intention", "admitted"])(
    "technical failure after applied human input reconstructs without another answer at %s", async cut => {
      const host = fixture();
      const fail = (key: string) => { throw Error(`Host command '${key}' failed: Command stopped because the workflow was aborted.`); };
      host.setHostResponse(fail);
      expect((await host.execute()).status).toBe("blocked");
      const original = copy(host.current().hostHalt);
      host.setHostResponse();
      expect((await host.execute({ unblock: true, resolution: { loop: 0, text: "Continue the interrupted read under current policy." } })).status).toBe("complete");
      host.setHostResponse(fail);
      expect((await host.execute()).status).toBe("blocked"); // identical text, NEW operation
      const later = copy(host.current().hostHalt), writers = host.calls.length;
      expect(host.current().resolutions[0]).toMatchObject({ hostHalt: original, failedHostObservation: later });
      host.setHostResponse();
      if (cut !== "none") {
        cutAt(host, value => value.hostReconstruction?.stage === cut);
        expect((await host.execute()).reason).toContain("Essential persistence failed");
        host.setFailSave();
      }
      expect((await host.execute()).status).toBe("complete");
      expect(host.current().hostReconstruction).toMatchObject({ source: later, stage: "admitted" });
      expect(host.current().resolutions).toHaveLength(1);
      expect(host.current().resolutions[0]).toMatchObject({ hostHalt: original, failedHostObservation: later });
      expect(host.current().loops).toHaveLength(1);
      expect(host.calls).toHaveLength(writers);
      expect((await host.execute()).status).toBe("complete");
      expect(host.calls).toHaveLength(writers);
    });

  test.each(["stopped", "pending", "permission", "failed-reconstruction"])(
    "later host %s after applied input remains a real barrier", async cause => {
      const host = fixture();
      const fail = () => { throw Error("Controlled ambiguous host failure"); };
      host.setHostResponse(fail);
      await host.execute();
      host.setHostResponse();
      expect((await host.execute({ unblock: true, resolution: { loop: 0, text: "Continue the original read under current policy." } })).status).toBe("complete");
      host.setHostResponse(fail);
      expect((await host.execute()).status).toBe("blocked");
      const record = host.current();
      if (cause === "failed-reconstruction") {
        expect((await host.execute()).status).toBe("blocked");
        expect(host.current().hostReconstruction.stage).toBe("failed");
      } else {
        if (cause === "permission") record.hostHalt.observedBarrier = "native permission denial";
        else record.hostHalt.observedState = cause;
        record.resolutions[0].failedHostObservation = copy(record.hostHalt);
      }
      const retained = copy(host.current()), calls = host.hostCalls.length, writers = host.calls.length;
      host.setHostResponse();
      expect((await host.execute()).status).toBe("blocked");
      expect(host.hostCalls).toHaveLength(calls);
      expect(host.calls).toHaveLength(writers);
      expect(host.current()).toEqual(retained);
    });

  test("retained resolution without an exact request match cannot clear host history", async () => {
    const host = fixture();
    host.setHostResponse(key => { throw Error(`Host command '${key}' failed: Command stopped because the workflow was aborted.`); });
    expect((await host.execute()).status).toBe("blocked");
    host.setHostResponse();
    expect((await host.execute({ unblock: true, resolution: { loop: 0, text: "Continue under current policy." } })).status).toBe("complete");
    host.current().resolutions[0].request.invocation = "unrelated-invocation";
    const retained = copy(host.current()), calls = host.hostCalls.length;
    expect((await host.execute()).status).toBe("blocked");
    expect(host.current()).toEqual(retained);
    expect(host.hostCalls).toHaveLength(calls);
  });

  test.each(["intention", "accepted", "applied", "next-slot", "none"])(
    "loop-three needs-decision resolution survives %s cut without replacing completed work", async cut => {
      const host = fixture(); host.setLimit(5);
      host.setRespond((request, normal) => {
        const value = normal();
        if (/\.l[12]\.compliance$/.test(request.key)) return gaps(value);
        if (request.key === "invoke-human-1.l3.director") {
          value.structuredOutput.status = "needs-decision";
          value.structuredOutput.reason = "Original host ambiguity question";
          value.structuredOutput.tasks = [];
        }
        return value;
      });
      expect((await host.execute()).status).toBe("blocked");
      const original = copy(host.current().loops[2]), prior = host.calls.length;
      const input = { unblock: true, resolution: { loop: 3, text: "Reconstruct independently of historical cause; continue in the next ordinary slot." } };
      if (cut !== "none") cutAt(host, value => cut === "next-slot" ? value.loops?.length === 4
        : value.loops?.[2]?.resolutions?.[0]?.stage === cut);
      const first = await host.execute(input);
      if (cut !== "none") {
        expect(first.status).toBe(["intention", "accepted"].includes(cut) ? "blocked" : "partial");
        expect(first.reason).toContain("Essential persistence failed");
      }
      host.setFailSave();
      const output = await host.execute(cut === "intention" ? input : {});
      expect(output).toMatchObject({ status: "complete", loopsConsumed: 4, maxLoops: 5 });
      const record = host.current().loops[2];
      expect(record.plan).toEqual(original.plan);
      expect(record.resolutions).toHaveLength(1);
      expect(record.resolutions[0]).toMatchObject({ ...input.resolution, stage: "applied", halt: original.halt });
      expect(host.calls.slice(prior).every(call => call.key.startsWith("invoke-human-1.l4."))).toBe(true);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(4);
      expect(host.calls.at(-1)?.task).toContain(input.resolution.text);
    });

  test("resolution cannot invent an invocation, clear a scope gap, or replace a pending writer", async () => {
    const fresh = fixture(), input = { unblock: true, resolution: { loop: 0, text: "Continue" } };
    expect((await fresh.execute(input)).status).toBe("blocked");
    expect(fresh.hostCalls).toHaveLength(0);
    const host = fixture();
    host.setRespond((request, normal) => request.agent === "pitako.worker" ? { ...normal(), ok: false, state: "running" } : normal());
    expect((await host.execute()).status).toBe("blocked");
    const count = host.calls.length;
    expect((await host.execute({ ...input, resolution: { ...input.resolution, loop: 1 } })).status).toBe("blocked");
    expect(host.calls).toHaveLength(count);
    expect(host.statusCalls.length).toBeGreaterThan(0);
    const scope = fixture();
    scope.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") Object.assign(result.structuredOutput, { status: "blocked", diagnosis: "Expansion needed: unauthorized external resource", remaining: ["Missing resource permission"] });
      return result;
    });
    expect((await scope.execute()).status).toBe("blocked");
    const before = scope.calls.length;
    expect((await scope.execute({ ...input, resolution: { ...input.resolution, loop: 1 } })).status).toBe("blocked");
    expect(scope.calls).toHaveLength(before);
  });

  // These are nonmodifying consumers: an unavailable original cannot be
  // replaced with a file rollback. A1 modifying recovery is covered separately.
  test.each(["worker", "review", "compliance"].flatMap(phase =>
    ["stopped", "permission", "unknown", "current-stop"].map(mode => ({ phase, mode }))))(
    "historical $phase $mode requires exact settlement and current authority", async ({ phase, mode }) => {
      const host = fixture(undefined, { readOnly: true });
      const target = `invoke-human-1.l1.${phase === "worker" ? "t1.a1" : phase === "review" ? "review.director-prepare" : "compliance"}`;
      host.setRespond((request, normal) => request.key !== target ? normal() : mode === "unknown"
        ? { ...normal(), ok: false, stopped: true }
        : closedInterruptedProducer(normal(), mode === "permission" ? "permission" : "stopped"));
      expect((await host.executeNative()).status).toBe(mode === "permission" ? "blocked" : "cancelled");
      const original = copy(host.current()), count = host.calls.length;
      host.setStatus(ref => {
        const response = copy(host.native.get(ref)!);
        if (response?.key === target || ref === `native-${target}` || ref === target) {
          if (mode === "unknown") return { ...response, state: "completed" }; // label alone does not establish closure
          return response;
        }
        return response;
      });
      host.setRespond((request, normal) => request.agent === "pitako.execution-inspector"
        ? host.result(request, { status: mode === "unknown" ? "unresolved" : "recovered", reason: "Exact retained operation receipt; settlement checked",
          original: mode === "unknown" ? null : copy(host.native.get(target)), workerResult: null,
          originalAvailable: mode !== "unknown", binding: "absent", comparison: mode === "unknown" ? "neither" : "only-original",
          provenance: [`/native/output/${target}.json`] })
        : mode === "current-stop" && request.key.endsWith(".l2.director") ? { ...normal(), ok: false, stopped: true } : normal());
      const input = { unblock: true, resolution: { loop: 1, text: "Continue pending work after reconciling the historical interruption." } };
      const output = await host.executeNative(input);
      expect(output.status).toBe(mode === "permission" ? "blocked" : mode === "unknown" || mode === "current-stop" ? "cancelled" : "complete");
      if (mode === "permission") {
        expect(host.calls).toHaveLength(count);
        expect(host.current().loops).toHaveLength(1);
        expect(host.current().loops[0].halt).toMatchObject({ code: "native-barrier", cause: "native permission denial" });
        expect(host.current().loops[0].resolutions[0].stage).toBe("accepted");
        expect((await host.executeNative()).status).toBe("blocked");
        expect(host.calls).toHaveLength(count);
      } else if (mode === "unknown") {
        expect(host.calls).toHaveLength(count + 1); // one exact exceptional observation, not a writer
        expect(host.current().loops).toHaveLength(1);
      } else {
        expect(host.current().loops).toHaveLength(2);
        expect(host.current().loops[0].resolutions[0]).toMatchObject({ stage: "applied", halt: original.loops[0].halt });
        expect(host.calls.slice(count).every(call => call.agent === "pitako.execution-inspector" || call.key.startsWith("invoke-human-1.l2."))).toBe(true);
        const after = host.calls.length;
        await host.executeNative();
        expect(host.calls).toHaveLength(after);
      }
    });

  test("later director Stop needs new current input without reviving an older barrier after application", async () => {
    const host = fixture(undefined, { readOnly: true }), worker = "invoke-human-1.l1.t1.a1", director = "invoke-human-1.l2.director";
    host.setRespond((request, normal) => request.key === worker ? closedInterruptedProducer(normal()) : normal());
    expect((await host.executeNative()).status).toBe("cancelled");
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.execution-inspector") {
        const target = request.task.includes(`"key":"${director}"`) ? director : worker;
        return host.result(request, { status: "recovered", reason: "Exact complete settled original operation receipt",
          original: copy(host.native.get(target)), workerResult: null, originalAvailable: true,
          binding: "absent", comparison: "only-original", provenance: [`/native/output/${target}.json`] });
      }
      return request.key === director ? closedInterruptedProducer(normal()) : normal();
    });
    expect((await host.executeNative({ unblock: true, resolution: { loop: 1, text: "Continue after the first settled interruption under current policy." } })).status).toBe("cancelled");
    const before = host.calls.length;
    expect((await host.executeNative()).status).toBe("cancelled");
    expect(host.calls).toHaveLength(before);
    expect((await host.executeNative({ unblock: true, resolution: { loop: 2, text: "New current request after the later director Stop: reconcile and continue within the original budget." } })).status).toBe("complete");
    const after = host.calls.length;
    expect((await host.executeNative()).status).toBe("complete");
    expect(host.calls).toHaveLength(after);
    expect(host.current().loops).toHaveLength(3);
    expect(host.current().association.maxCycles).toBe(3);
    expect(host.current().loops[0].resolutions[0].currentBarrier).toMatchObject({ cause: "stopped" });
    expect(host.current().loops[1].resolutions[0]).toMatchObject({ stage: "applied", halt: { cause: "stopped" } });
    expect(host.calls.filter(call => call.key === director)).toHaveLength(1);
  });

  // Reject treating terminal-looking prose/labels as settlement, laundering a
  // different producer, or spending the same authorization after a new Stop.
  test.each(["missing", "terminal-missing", "run-conflict", "key-conflict", "active", "inspector-stop", "inspector-permission", "inspector-pending"])(
    "interrupted-operation observation preserves %s barrier and original", async mode => {
      const host = fixture(undefined, { readOnly: true }), target = "invoke-human-1.l1.t1.a1";
      host.setRespond((request, normal) => request.key === target ? closedInterruptedProducer(normal()) : normal());
      expect((await host.executeNative()).status).toBe("cancelled");
      const original = copy(host.native.get(target)!);
      host.setStatus(ref => ref === target || ref === `native-${target}`
        ? { ok: false, output: "Exact inventory unavailable", results: [] } : copy(host.native.get(ref)!));
      host.setRespond((request, normal) => {
        if (request.agent !== "pitako.execution-inspector") return normal();
        if (mode === "inspector-permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
        const receipt = copy(original);
        if (mode === "terminal-missing") { delete receipt.results; receipt.state = "completed"; }
        if (mode === "run-conflict") receipt.runId = "different-producer";
        if (mode === "key-conflict") receipt.key = "different-operation";
        if (mode === "active") receipt.state = "running";
        return { ...host.result(request, { status: mode === "missing" ? "unresolved" : "recovered",
          reason: "Controlled exact observation", original: mode === "missing" ? null : receipt, workerResult: null,
          originalAvailable: mode !== "missing", binding: "absent", comparison: mode === "missing" ? "neither" : "only-original",
          provenance: [original.outputReference] }),
          ...(mode === "inspector-stop" ? { ok: false, stopped: true } : {}),
          ...(mode === "inspector-pending" ? { state: "running" } : {}) };
      });
      const input = { unblock: true, resolution: { loop: 1, text: "Continue only after exact reconciliation under current policy." } };
      expect((await host.executeNative(input)).status).not.toBe("complete");
      const count = host.calls.length;
      expect(host.current().loops).toHaveLength(1);
      host.setRespond((_request, normal) => normal());
      expect((await host.executeNative()).status).not.toBe("complete");
      expect(host.calls).toHaveLength(count);
      expect(host.native.get(target)).toEqual(original);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    });

  test.each(["intention", "observation", "admission", "next-slot"])(
    "interrupted-operation %s cut reconciles exactly one observer and ordinary slot", async cut => {
      const host = fixture(undefined, { readOnly: true }), target = "invoke-human-1.l1.t1.a1";
      host.setRespond((request, normal) => request.key === target ? closedInterruptedProducer(normal()) : normal());
      expect((await host.executeNative()).status).toBe("cancelled");
      const original = copy(host.native.get(target)!);
      host.setStatus(ref => ref === target || ref === `native-${target}`
        ? { ok: false, output: "Exact inventory unavailable", results: [] } : copy(host.native.get(ref)!));
      host.setRespond((request, normal) => request.agent === "pitako.execution-inspector"
        ? host.result(request, { status: "recovered", reason: "Read original complete settled native receipt at exact retained output ref",
          original, workerResult: null, originalAvailable: true, binding: "absent", comparison: "only-original", provenance: [original.outputReference] })
        : normal());
      cutAt(host, value => {
        const recovery = value.loops?.[0]?.recoveries?.find((entry: any) => entry.subject === `interrupted-operation:${target}`);
        return cut === "intention" ? recovery?.stage === "intention"
          : cut === "observation" ? recovery?.stage === "observed"
          : cut === "admission" ? value.loops?.[0]?.resolutions?.[0]?.stage === "applied" : value.loops?.length === 2;
      });
      const input = { unblock: true, resolution: { loop: 1, text: "Continue pending work using current authority and existing slots." } };
      const first = await host.executeNative(input);
      expect(first.status).not.toBe("complete");
      expect(first.reason).toContain("Essential persistence failed");
      host.setFailSave();
      expect((await host.executeNative()).status).toBe("complete");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(2);
      expect(host.current().loops).toHaveLength(2);
      expect(host.current().loops[0].resolutions).toHaveLength(1);
      expect(host.current().loops[0].resolutions[0]).toMatchObject({ stage: "applied" });
      expect(host.native.get(target)).toEqual(original);
    });

  // Reject blind keyed redispatch: the second responder would turn a retained
  // barrier into fulfillment, so absence of new calls is the observable guarantee.
  test.each(["review.director-prepare", "review.independent-angle1", "compliance"])(
    "retained analysis barrier at %s is observed before replay dispatch", async phase => {
      for (const mode of ["stop", "permission", "thrown-permission", "thrown-status-stop", "pending", "unknown"]) {
        const host = fixture();
        const target = `invoke-human-1.l1.${phase}`;
        host.setRespond((request, normal) => {
          const result = normal();
          if (request.key !== target) return result;
          if (mode === "thrown-permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
          return { ...result, ok: false, ...(mode.includes("stop") ? { stopped: true }
            : { error: "Blocked by pi-subagents permission rule: 'run' is denied." }) };
        });
        const first = await host.executeNative();
        expect(first.status).toBe(mode.includes("stop") ? "cancelled" : "blocked");
        expect(host.current().loops[0].analysisCalls.find((call: any) => call.key === target)).toMatchObject({ stage: "receipt" });
        const calls = host.calls.length, hosts = host.hostCalls.length;
        host.setRespond((_request, normal) => normal());
        if (mode === "thrown-status-stop") host.setStatus(ref => {
          if (ref === `native-${target}`) throw Error(`Status '${ref}' failed: Run: ${ref}\nState: stopped`);
          return copy(host.native.get(ref)!);
        });
        if (mode === "pending" || mode === "unknown") host.setStatus(ref =>
          ref === `native-${target}` ? mode === "pending" ? { ok: true, state: "running" } : { ok: true, output: "", results: [] }
            : copy(host.native.get(ref)!));
        const second = await host.executeNative();
        expect(second.status).toBe(mode.includes("stop") ? "cancelled" : "blocked");
        expect(host.calls).toHaveLength(calls);
        expect(host.hostCalls.slice(hosts)).not.toContain("inspect-1");
        expect(host.current().loops).toHaveLength(1);
        expect(host.statusCalls).toContain(mode === "thrown-permission" ? target : `native-${target}`);
      }
    });

  test.each(["review.director-prepare", "review.independent-angle1", "compliance"].flatMap(phase =>
    ["intention", "receipt", "phase"].map(cut => ({ phase, cut }))))("analysis $phase $cut persistence cut never blindly replaces a call", async ({ phase, cut }) => {
    const host = fixture(), target = `invoke-human-1.l1.${phase}`;
    cutAt(host, value => {
      const loop = value.loops?.[0], call = loop?.analysisCalls?.find((entry: any) => entry.key === target);
      return cut === "phase" ? loop?.phase === (phase === "compliance" ? "closing" : "compliance") : call?.stage === cut;
    });
    expect((await host.executeNative()).status).toBe("partial");
    const count = host.calls.filter(call => call.key === target).length;
    expect(count).toBe(cut === "intention" ? 0 : 1);
    host.setFailSave();
    const next = await host.executeNative();
    expect(next.status).toBe("complete");
    expect(host.calls.filter(call => call.key === target)).toHaveLength(1);
    if (cut !== "intention") expect(host.statusCalls).toContain(cut === "receipt" ? target : `native-${target}`);
  });

  test("retained analysis intention without a settled producer cannot launch a replacement", async () => {
    const host = fixture();
    cutAt(host, value => value.loops?.[0]?.analysisCalls?.some((call: any) => call.stage === "receipt"));
    expect((await host.executeNative()).status).toBe("partial");
    host.setFailSave();
    host.setStatus(() => ({ ok: true, output: "", results: [] }));
    const count = host.calls.length;
    expect((await host.executeNative()).status).toBe("blocked");
    expect(host.calls).toHaveLength(count);
    expect(host.current().loops).toHaveLength(1);
  });

  test("current exact settled analysis supersedes a historical Stop without relaunch", async () => {
    const host = fixture(), target = "invoke-human-1.l1.review.director-prepare";
    let settled: Result;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === target) { settled = copy(result); return { ...result, ok: false, stopped: true }; }
      return result;
    });
    expect((await host.executeNative()).status).toBe("cancelled");
    host.setRespond((_request, normal) => normal());
    host.setStatus(ref => ref === `native-${target}` ? copy(settled!) : copy(host.native.get(ref)!));
    expect((await host.executeNative()).status).toBe("complete");
    expect(host.calls.filter(call => call.key === target)).toHaveLength(1);
    expect(host.statusCalls).toContain(`native-${target}`);
  });

  test.each(["running", "unknown", "mismatched"])("retained analysis %s status never becomes success", async state => {
    const host = fixture(), target = "invoke-human-1.l1.compliance";
    host.setRespond((request, normal) => request.key === target ? { ...normal(), ok: false, stopped: true } : normal());
    expect((await host.executeNative()).status).toBe("cancelled");
    host.setRespond((_request, normal) => normal());
    host.setStatus(ref => ref !== `native-${target}` ? copy(host.native.get(ref)!) : state === "running"
      ? { ok: true, state: "running" } : state === "unknown" ? { ok: true, results: [], output: "" }
      : { ...copy(host.native.get(ref)!), ok: true, stopped: false, runId: "different-producer" });
    const count = host.calls.length;
    expect((await host.executeNative()).status).not.toBe("complete");
    expect(host.calls).toHaveLength(count);
    expect(host.hostCalls).not.toContain("inspect-1");
    expect(host.current().loops).toHaveLength(1);
  });

  test("a legacy analysis barrier without its failed call receipt stays uncertain across replays", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      if (request.key.endsWith(".compliance")) throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      return normal();
    });
    expect((await host.executeNative()).status).toBe("blocked");
    delete host.current().loops[0].analysisCalls;
    host.setRespond((_request, normal) => normal());
    const count = host.calls.length;
    for (let replay = 0; replay < 2; replay++) expect((await host.executeNative()).status).toBe("blocked");
    expect(host.calls).toHaveLength(count);
    expect(host.current().loops).toHaveLength(1);
  });

  test.each(["review.director-prepare", "review.independent-angle1", "compliance"])(
    "native status exceptions at %s preserve their current barrier, not the old receipt", async phase => {
      for (const mode of ["stop", "permission"]) {
        const host = fixture(), target = `invoke-human-1.l1.${phase}`;
        // Persist an ordinary successful original but interrupt its receipt write.
        // There is no old Stop to accidentally satisfy the cancellation assertion.
        cutAt(host, value => value.loops?.[0]?.analysisCalls?.some((call: any) =>
          call.key === target && call.stage === "receipt"));
        expect((await host.executeNative()).status).toBe("partial");
        host.setFailSave();
        host.setStatus(ref => {
          if (ref !== target) return copy(host.native.get(ref)!);
          if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
          // runWorkflowScript turns this actual management receipt into the
          // native `Status '<ref>' failed: ...` exception.
          return { ok: false, output: `Run: ${ref}\nState: stopped`, results: [] };
        });
        const count = host.calls.length;
        expect((await host.executeNative()).status).toBe(mode === "stop" ? "cancelled" : "blocked");
        expect(host.calls).toHaveLength(count);
        expect(host.current().loops).toHaveLength(1);
      }
    });

  // These cuts reject both "block on every schema error" and "retry every
  // invalid plan". Only a trustworthy never-admitted original gets replanning.
  test.each(["none", "publication", "rejection", "next-slot"])("new rejected plan is accounted once across %s cut", async cut => {
    const host = fixture();
    let original: any;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.director") {
        result.structuredOutput.tasks[0].dependsOn = [{ taskId: "missing", reason: "Needs output" }];
        original = copy(result.structuredOutput);
      }
      if (request.key === "invoke-human-1.l2.director") {
        expect(host.current().loops[0]).toMatchObject({ outcome: "gaps", plan: { stage: "rejected" } });
        expect(request.task).toContain("loop_plan dependencies require");
        expect(request.task).toContain("Publish a NEW complete plan");
        expect(request.task).toContain("native-invoke-human-1.l1.director");
      }
      return result;
    });
    if (cut !== "none") {
      cutAt(host, value => {
        const first = value.loops?.[0];
        return cut === "publication" ? first?.plan?.stage === "published"
          : cut === "rejection" ? first?.plan?.stage === "rejected"
          : value.loops?.length === 2;
      });
      expect((await host.execute()).status).toBe("partial");
      host.setFailSave();
    }
    expect((await host.execute()).status).toBe("complete");
    const first = host.current().loops[0];
    expect(first).toMatchObject({ number: 1, outcome: "gaps", cursor: 0, manifest: null, results: [],
      plan: { stage: "rejected", rejection: { diagnostic: expect.stringContaining("dependencies"), ref: { runId: "native-invoke-human-1.l1.director" } } } });
    expect(host.current().loops).toHaveLength(2);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(2);
    expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key.includes(".l1."))).toHaveLength(0);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.native.get("invoke-human-1.l1.director")!.structuredOutput).toEqual(original);
    // The publication cut deliberately failed its write; the surviving intent
    // is reconciled by exact status rather than redispatching the director.
    if (cut !== "publication") {
      const published = host.snapshots.find(value => value.loops?.[0]?.plan?.stage === "published");
      expect(published.loops[0].manifest).toBeNull();
      expect(published.loops[0].outcome).toBeUndefined();
    }
  });

  test("repeated defect has no new corrective input even with remaining budget", async () => {
    const host = fixture();
    host.setLimit(5);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) result.structuredOutput.tasks[0].dependsOn = ["obsolete"];
      return result;
    });
    const output = await host.execute();
    expect(output).toMatchObject({ status: "blocked", loopsConsumed: 2 });
    expect(output.reason).toContain("No new useful corrective input");
    expect(host.current().loops[0].plan.stage).toBe("rejected");
    expect(host.current().loops[1].plan.stage).toBe("published");
    expect(host.calls).toHaveLength(2);
  });

  // Losing optional payloads cannot renew a route already ended by the exact
  // repeated diagnosis. Reject a replay that relabels that halt as plan loss.
  test.each(["available", "lost", "unresolved"])("no-new-input halt survives optional-cache write cut with %s original", async mode => {
    const host = fixture();
    host.setLimit(5);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) result.structuredOutput.tasks[0].dependsOn = ["obsolete"];
      return result;
    });
    // Essential halt is saved, then the optional payload write is interrupted.
    host.setFailSave(value => !!value.activePlan && !!value.loops?.[1]?.halt);
    const first = await host.executeNative();
    expect(first).toMatchObject({ status: "blocked", loopsConsumed: 2 });
    expect(first.reason).toContain("No new useful corrective input");
    const retained = copy(host.current().loops[1]);
    expect(host.current().activePlan).toBeNull();
    host.setFailSave();
    if (mode !== "available") {
      for (const result of host.native.values()) delete result.structuredOutput;
      host.setRespond((request, normal) => {
        if (request.agent !== "pitako.execution-inspector") return normal();
        return host.result(request, { status: mode, reason: mode === "lost" ? "Exact original lost" :
          "Actor user must authorize outside-scope original restoration", original: null, workerResult: null,
          originalAvailable: false, binding: "unavailable", comparison: "neither", provenance: ["/native/exact-original"] });
      });
    }
    const actions = host.calls.map(call => call.key);
    const statuses = host.statusCalls.length;
    const replay = await host.executeNative();
    expect(replay).toMatchObject({ status: "blocked", loopsConsumed: 2 });
    expect(replay.reason).toContain("No new useful corrective input");
    expect(host.current().loops[1]).toEqual(retained);
    expect(host.calls.map(call => call.key)).toEqual(actions);
    expect(actions).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l2.director"]);
    expect(host.statusCalls).toHaveLength(statuses);
    expect(host.current().loops[0].plan.stage).toBe("rejected");
  });

  test("essential no-new-input halt write failure stops dispatch until exact diagnosis can be reconciled", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) result.structuredOutput.tasks[0].dependsOn = ["obsolete"];
      return result;
    });
    cutAt(host, value => !!value.loops?.[1]?.halt);
    const first = await host.executeNative();
    expect(first.reason).toContain("Essential persistence failed");
    expect(host.calls.map(call => call.key)).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l2.director"]);
    expect(host.current().loops[1].halt).toBeUndefined();
    host.setFailSave();
    expect(await host.executeNative()).toMatchObject({ status: "blocked", loopsConsumed: 2 });
    expect(host.current().loops[1].halt.reason).toContain("No new useful corrective input");
    expect(host.calls).toHaveLength(2);
    expect(host.statusCalls).toContain("native-invoke-human-1.l2.director");
  });

  test("last-slot rejection remains a durable accounted gap without another director", async () => {
    const host = fixture();
    host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      result.structuredOutput.tasks = [];
      return result;
    });
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(host.current().loops[0]).toMatchObject({ outcome: "gaps", plan: { stage: "rejected" } });
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 1 });
    expect(host.calls).toHaveLength(1);
  });

  test("a distinct diagnosed dependency defect supplies new corrective input without renewing slots", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.director") result.structuredOutput.tasks[0].dependsOn = ["obsolete"];
      if (request.key === "invoke-human-1.l2.director") result.structuredOutput.tasks[0].dependsOn = [{ taskId: "missing", reason: "Requires output" }];
      return result;
    });
    expect(await host.execute()).toMatchObject({ status: "complete", loopsConsumed: 3 });
    expect(host.current().loops.slice(0, 2).map((loop: any) => loop.plan.stage)).toEqual(["rejected", "rejected"]);
    expect(host.current().loops[0].plan.rejection.diagnostic).not.toBe(host.current().loops[1].plan.rejection.diagnostic);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(3);
    expect(host.calls.filter(call => call.agent === "pitako.worker").every(call => call.key.includes(".l3."))).toBe(true);
  });

  test.each(["producer", "association", "binding", "stopped", "permission", "pending", "schema-no-original"])(
    "structural defect cannot hide %s barrier or authority conflict", async mode => {
      const host = fixture();
      host.setRespond((request, normal) => {
        if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
        const result = normal();
        if (request.agent === "pitako.execution-inspector") {
          result.structuredOutput = { status: "lost", reason: "No usable exact original", original: null, workerResult: null,
            originalAvailable: false, binding: "absent", comparison: "neither", provenance: ["/native/original-unavailable"] };
          return result;
        }
        result.structuredOutput.tasks = [];
        if (mode === "producer") result.agent = "unrelated-producer";
        if (mode === "association") result.structuredOutput.association.missionId = "wrong";
        if (mode === "binding") result.output = JSON.stringify({ ...result.structuredOutput, reason: "Different binding" });
        if (mode === "stopped") result.stopped = true;
        if (mode === "pending") result.state = "pending";
        if (mode === "schema-no-original") { result.ok = false; delete result.structuredOutput; result.error = "Native schema rejected"; }
        return result;
      });
      const output = await host.execute();
      expect(output.status).toBe(mode === "stopped" ? "cancelled" : "blocked");
      expect(host.current().loops).toHaveLength(1);
      expect(host.current().loops[0].plan.stage).not.toBe("rejected");
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
      if (["producer", "association", "binding"].includes(mode)) {
        const calls = host.calls.length;
        host.setRespond(undefined);
        host.setStatus(() => ({ ok: true, output: "", structuredOutput: host.plan() }));
        expect((await host.execute()).status).toBe("blocked");
        expect(host.calls).toHaveLength(calls);
        expect(host.current().loops[0].plan.stage).not.toBe("rejected");
      }
    },
  );

  test.each(["capacity", "stopped", "permission", "pending"])("rejected plan does not bypass next-director %s barrier", async mode => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.director") result.structuredOutput.tasks = [];
      if (request.key === "invoke-human-1.l2.director") {
        if (mode === "capacity") Object.assign(result, { ok: false, error: "Active async run capacity exhausted: 4/4 used." });
        if (mode === "stopped") result.stopped = true;
        if (mode === "permission") Object.assign(result, { ok: false, error: "Blocked by pi-subagents permission rule: 'run' is denied." });
        if (mode === "pending") result.state = "pending";
      }
      return result;
    });
    expect((await host.execute()).status).toBe(mode === "stopped" ? "cancelled" : mode === "capacity" ? "partial" : "blocked");
    expect(host.current().loops).toHaveLength(2);
    expect(host.current().loops[0]).toMatchObject({ outcome: "gaps", plan: { stage: "rejected" } });
    expect(host.current().loops[1].plan.stage).not.toBe("rejected");
    expect(host.calls).toHaveLength(2);
    expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
  });

  test("exact recovered original can establish rejection eligibility after native schema failure", async () => {
    const host = fixture();
    let original: any;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.director") {
        original = copy(result.structuredOutput); original.tasks[0].dependsOn = ["obsolete"];
        delete result.structuredOutput; result.ok = false; result.error = "Native schema rejected";
      }
      if (request.agent === "pitako.execution-inspector") {
        result.structuredOutput = { status: "recovered", reason: "Exact settled producer original", original: copy(original),
          workerResult: null, originalAvailable: true, binding: "identical", comparison: "equal-full-json",
          provenance: ["/native/witness/invoke-human-1.l1.director.json"] };
      }
      return result;
    });
    expect((await host.execute()).status).toBe("complete");
    expect(host.current().loops[0].plan).toMatchObject({ stage: "rejected",
      rejection: { recoverySource: { comparison: "equal-full-json" } } });
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
    expect(original.tasks[0].dependsOn).toEqual(["obsolete"]);
  });

  test("native schema failure with a complete settled original uses it before optional recovery", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.director") {
        result.structuredOutput.tasks[0].dependsOn = ["obsolete"];
        result.ok = false; result.error = "Native schema rejected";
      }
      return result;
    });
    expect(await host.execute()).toMatchObject({ status: "complete", loopsConsumed: 2 });
    expect(host.current().loops[0].plan.stage).toBe("rejected");
    expect(host.statusCalls).toEqual([]);
    expect(host.calls.some(call => call.agent === "pitako.execution-inspector")).toBe(false);
  });

  test("native director binding fixes the complete actual association on each loop", async () => {
    const host = fixture();
    const sourceRefs = [{ path: "/stable/inherited.md", digest: "f".repeat(64) }];
    host.setRespond((request, normal) => request.key === "invoke-human-1.l1.compliance" ? gaps(normal()) : normal());
    expect((await host.executeNative({ sourceRefs })).status).toBe("complete");
    const directors = host.calls.filter(request => request.key.endsWith(".director"));
    expect(directors).toHaveLength(2);
    for (const [index, request] of directors.entries()) {
      const plan = host.native.get(request.key)!.structuredOutput;
      const original = copy(plan);
      const tool = { name: "loop_plan", description: "Published loop plan", parameters: request.outputSchema };
      const validate = (value: any) => validateToolArguments(tool, { type: "toolCall", id: "plan", name: tool.name, arguments: value });
      expect(plan.association).toEqual({ ...host.plan(index + 1).association, sourceRefs });
      expect(validate(plan)).toEqual(plan);
      expect(request.outputSchema.properties.association.const).toEqual(plan.association);
      // A shape-only binding accepts these plausible mis-transcriptions.
      for (const field of Object.keys(plan.association)) {
        const changed = copy(plan);
        changed.association[field] = field === "loop" || field === "maxCycles" ? 9
          : field === "sourceRefs" ? [] : "/wrong";
        expect(() => validate(changed)).toThrow();
        const omitted = copy(plan);
        delete omitted.association[field];
        expect(() => validate(omitted)).toThrow();
      }
      for (const field of ["path", "digest"]) {
        const changed = copy(plan);
        changed.association.sourceRefs[0][field] = field === "digest" ? "e".repeat(64) : "/wrong";
        expect(() => validate(changed)).toThrow();
      }
      expect(plan).toEqual(original);
    }
  });

  test.each(["missionId", "missionPath", "invocation", "root", "commonDir", "source", "digest", "loop", "maxCycles", "sourceRefs"])(
    "post-binding validation rejects conflicting %s without editing the original or launching workers", async field => {
      const host = fixture();
      let original: any, retained: any;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key.endsWith(".director")) {
          result.structuredOutput.association[field] = field === "loop" || field === "maxCycles" ? 9
            : field === "sourceRefs" ? [{ path: "/wrong", digest: "e".repeat(64) }] : "/wrong";
          original = result.structuredOutput; retained = copy(original);
        }
        return result;
      });
      const output = await host.executeNative();
      expect(output.status).toBe("blocked");
      expect(output.reason).toContain("association mismatch");
      expect(host.calls.filter(request => request.agent === "pitako.worker")).toHaveLength(0);
      expect(original).toEqual(retained);
      expect(host.native.get(host.calls[0]!.key)!.structuredOutput).toEqual(retained);
    },
  );

  test.each([false, true])("independent permutations preserve full admitted definitions, verification last (%s)", async reverse => {
    const host = fixture("FULL SPECS WITH INDEPENDENT OBLIGATIONS", { taskCount: 2 });
    let published: any;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) {
        if (reverse) result.structuredOutput.tasks = [result.structuredOutput.tasks[1], result.structuredOutput.tasks[0], result.structuredOutput.tasks[2]];
        published = copy(result.structuredOutput);
        const schema = request.outputSchema.properties.tasks.items;
        expect(schema.required).toContain("dependsOn");
        expect(schema.properties.dependsOn.items).toMatchObject({
          additionalProperties: false, required: ["taskId", "reason"],
        });
      }
      return result;
    });
    expect((await host.executeNative()).status).toBe("complete");
    const workers = host.calls.filter(call => call.agent === "pitako.worker");
    expect(workers.map(call => JSON.parse(call.task.split("COMPLETE SELECTED TASK:\n")[1]!.split("\nFROZEN ATTEMPT")[0]!).id))
      .toEqual(published.tasks.map((item: any) => item.id));
    for (const [index, call] of workers.entries()) {
      expect(JSON.parse(call.task.split("COMPLETE SELECTED TASK:\n")[1]!.split("\nFROZEN ATTEMPT")[0]!)).toEqual(published.tasks[index]);
      expect(call.task).toContain("DIRECT PREREQUISITE COMPLETED RESULTS (historical references, not current check evidence):\n[]");
    }
    expect(published.tasks.at(-1)).toMatchObject({ id: "final", kind: "verification", dependsOn: [] });
    const ref = JSON.stringify(host.current().loops[0].plan.ref);
    for (const call of host.calls.filter(call => call.key.endsWith("director-prepare") || call.key.endsWith(".compliance"))) {
      expect(call.task).toContain(ref);
      expect(call.task).toContain("FULL SPECS WITH INDEPENDENT OBLIGATIONS");
    }
  });

  test.each([
    undefined, null, {}, [null], ["change1"], [{}], [{ taskId: "change1" }],
    [{ taskId: "", reason: "required" }], [{ taskId: "unknown", reason: "required" }],
    [{ taskId: "change2", reason: "self" }], [{ taskId: "final", reason: "later" }],
    [{ taskId: "change1", reason: "  " }], [{ taskId: "change1", reason: "required", extra: true }],
    [{ taskId: "change1", reason: "one" }, { taskId: "change1", reason: "duplicate" }],
  ].map(invalid => ({ invalid })))("invalid dependency metadata %j starts no workers", async ({ invalid }) => {
    const host = fixture(undefined, { taskCount: 2 });
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) result.structuredOutput.tasks[1].dependsOn = invalid;
      return result;
    });
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    expect(output.reason).toContain("dependencies");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
  });

  test.each(["out-of-order", "cycle", "verification-not-last"])("%s cannot dispatch a writer", async mode => {
    const host = fixture(undefined, { taskCount: 2 });
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) {
        const tasks = result.structuredOutput.tasks;
        tasks[0].dependsOn = [{ taskId: "change2", reason: "needs produced API" }];
        if (mode === "cycle") tasks[1].dependsOn = [{ taskId: "change1", reason: "needs caller" }];
        if (mode === "verification-not-last") result.structuredOutput.tasks = [tasks[2], tasks[0], tasks[1]];
      }
      return result;
    });
    expect((await host.execute()).status).toBe("blocked");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
  });

  test.each(["before-result", "before-cursor"])("direct prerequisite handoff survives %s cut and excludes intermediate/unrelated attempts", async cut => {
    const host = fixture(undefined, { taskCount: 3 });
    let published: any;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) {
        result.structuredOutput.tasks[2].dependsOn = [{ taskId: "change1", reason: "Consumes the produced API" }];
        published = copy(result.structuredOutput);
      }
      if (request.key.endsWith(".t1.a1")) {
        Object.assign(result.structuredOutput, { status: "continue", remaining: ["Finish the assigned API"],
          diagnosis: "API implementation partially completed", continuation: "Finish the remaining API path" });
      }
      if (request.key.endsWith(".t3.a1")) {
        const saved = host.current().loops[0];
        expect(saved.results.filter((entry: any) => entry.taskId === "change1").map((entry: any) => entry.status)).toEqual(["continue", "complete"]);
        const completed = saved.results.find((entry: any) => entry.taskId === "change1" && entry.status === "complete");
        const references = JSON.parse(request.task.split("DIRECT PREREQUISITE COMPLETED RESULTS (historical references, not current check evidence):\n")[1]!.split("\nRead relevant")[0]!);
        expect(references).toEqual([{ taskId: "change1", attempt: 2, ref: completed.ref }]);
        expect(request.task).toContain("do not automatically repeat all prerequisite gates");
      }
      return result;
    });
    cutAt(host, value => {
      const loop = value.loops?.[0];
      return cut === "before-result"
        ? loop?.attempt?.taskId === "change1" && loop.attempt.number === 2 && loop.attempt.stage === "result"
        : loop?.cursor === 1;
    });
    expect((await host.execute()).status).toBe("partial");
    expect(host.calls.some(call => call.key.endsWith(".t3.a1"))).toBe(false);
    host.setFailSave(); host.changeCheckout(1);
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls.filter(call => call.key.endsWith(".t1.a2"))).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".t3.a1"))).toHaveLength(1);
    expect(host.current().loops[0].manifest).toEqual(published.tasks.map((item: any) => item.id));
    for (const call of host.calls.filter(call => call.agent === "pitako.worker")) {
      const selected = JSON.parse(call.task.split("COMPLETE SELECTED TASK:\n")[1]!.split("\nFROZEN ATTEMPT")[0]!);
      expect(selected).toEqual(published.tasks.find((item: any) => item.id === selected.id));
    }
  });

  test.each(["continue", "failed"])("replay cannot infer completion from cursor position or a %s prerequisite", async status => {
    const host = fixture(undefined, { taskCount: 2 });
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director"))
        result.structuredOutput.tasks[1].dependsOn = [{ taskId: "change1", reason: "Consumes output" }];
      return result;
    });
    cutAt(host, value => value.loops?.[0]?.attempt?.taskId === "change2");
    expect((await host.execute()).status).toBe("partial");
    const saved = copy(host.current());
    saved.loops[0].results[0].status = status;
    host.storage.set("invoke-human-1", saved); host.setFailSave();
    expect((await host.execute()).reason).toContain("no unique durable completed attempt");
    expect(host.calls.some(call => call.key.endsWith(".t2.a1"))).toBe(false);
  });

  test("an incompatible admitted task contract is retained, not backfilled with independence", async () => {
    const host = fixture();
    cutAt(host, value => value.loops?.[0]?.attempt?.stage === "intention");
    expect((await host.execute()).status).toBe("partial");
    host.setFailSave();
    const saved = copy(host.current());
    delete saved.activePlan.tasks[0].dependsOn;
    const original = host.native.get("invoke-human-1.l1.director")!;
    delete original.structuredOutput.tasks[0].dependsOn;
    host.native.set(original.runId!, copy(original));
    host.storage.set("invoke-human-1", saved);
    const before = copy(original.structuredOutput);
    expect((await host.execute()).reason).toContain("incompatible admitted definitions remain unchanged");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
    expect(host.native.get(original.runId!)!.structuredOutput).toEqual(before);
    expect(host.current().activePlan.tasks[0].dependsOn).toBeUndefined();
  });

  test.each([1, 2, 4])("admitted limit %s controls every gap report and dispatch, independent of later settings", async limit => {
    const host = fixture(); host.setLimit(limit);
    host.setRespond((request, normal) => request.key.endsWith(".compliance") ? gaps(normal()) : normal());
    const output = await host.execute();
    expect(output).toMatchObject({ status: "partial", loopsConsumed: limit, maxLoops: limit });
    expect(host.current().association.maxCycles).toBe(limit);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(limit);
    for (const report of host.emits) {
      expect(report.maxLoops).toBe(limit);
      if (report.type !== "execution-loop") continue;
      expect(report.next).toBe(report.loop < limit ? `continue loop ${report.loop + 1}` : "new invocation requires human authorization");
      if (report.loop === limit) for (const reason of [report.reason, report.pending[0].reason, report.actionRequired])
        expect(reason).toContain("new invocation with human authorization");
    }
    const before = copy(host.current()), dispatches = host.calls.length;
    const settingsReads = host.hostCalls.filter(key => key === "execute-settings").length;
    host.setLimit(limit + 10);
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: limit, maxLoops: limit });
    expect(host.current()).toEqual(before); expect(host.calls).toHaveLength(dispatches);
    expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(settingsReads);
  });

  test.each([1, 2, 4])("limit %s permits early fulfillment without requesting another invocation", async limit => {
    const host = fixture(); host.setLimit(limit);
    expect(await host.execute()).toMatchObject({ status: "complete", maxLoops: limit, loopsConsumed: 1, actionRequired: "none" });
    for (const report of host.emits.filter(item => item.type === "execution-loop")) {
      expect(report).toMatchObject({ status: "complete", maxLoops: limit, next: "close", actionRequired: "none", pending: [] });
    }
  });

  test("coalesced admission cannot invent a default when its required receipt is absent or invalid", async () => {
    for (const admission of [undefined, {}, { maxCycles: false }, { maxCycles: 0 }]) {
      const host = fixture();
      host.setHostResponse((key, value) => key === "inspect-initial" ? { ...value, admission } : value);
      const output = await host.execute({ settings: undefined });
      expect(output).toMatchObject({ status: "blocked", loopsConsumed: 0, phase: "admission" });
      expect(output.reason).toContain("Invalid pitako.execute.maxCycles admission receipt");
      expect(host.calls).toEqual([]);
      expect(host.storage.size).toBe(0);
      expect(host.hostCalls).toEqual(["inspect-initial"]);
    }
  });

  test("high limit is not clamped but host inspection capacity stops before an uncheckable director", async () => {
    const host = fixture(); host.setLimit(Number.MAX_SAFE_INTEGER);
    host.setRespond((request, normal) => request.key.endsWith(".compliance") ? gaps(normal()) : normal());
    const output = await host.execute();
    expect(output).toMatchObject({ status: "partial", loopsConsumed: 4, maxLoops: Number.MAX_SAFE_INTEGER });
    expect(output.reason).toContain("host inspection capacity exhausted");
    expect(output.loopReport.halt.code).toBe("capacity");
    expect(output.loopReport.next).toBe("resolve observed impediment");
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(4);
    const count = host.calls.length; expect((await host.execute()).status).toBe("partial"); expect(host.calls).toHaveLength(count);
  });

  test("new human invocation admits new settings without changing old native records", async () => {
    const host = fixture(); host.setLimit(1); expect((await host.execute()).status).toBe("complete");
    const previous = copy(host.current()), oldStore = copy(Object.fromEntries(host.storage));
    // Another explicit mission/invocation owns its own marker; original store stays intact.
    const next = fixture(); next.storage.set("prior-invocation-history", oldStore); next.setLimit(4);
    expect(await next.execute({ invocation: "human-2", missionId: "another-mission", missionPath: "/native/another-mission.json" }))
      .toMatchObject({ status: "complete", maxLoops: 4 });
    expect(next.storage.get("invoke-human-2").association.maxCycles).toBe(4);
    expect(host.current()).toEqual(previous);
    expect(next.storage.get("prior-invocation-history")).toEqual(oldStore);
  });

  test("legacy version-2 replay remains fixed-three without settings reads or backfill", async () => {
    const host = fixture();
    host.setRespond((request, normal) => request.key.endsWith(".compliance") ? gaps(normal()) : normal());
    await host.execute();
    const old = copy(host.current()); old.version = 2; delete old.association.maxCycles; delete old.association.sourceRefs;
    host.storage.set("invoke-human-1", old); host.storage.set("pitako-execution", { version: 2, association: old.association });
    const before = copy(old), reads = host.hostCalls.filter(key => key === "execute-settings").length;
    host.setLimit(1); const calls = host.calls.length;
    expect(await host.execute()).toMatchObject({ status: "partial", loopsConsumed: 3, maxLoops: 3 });
    expect(host.current()).toEqual(before); expect(host.calls).toHaveLength(calls);
    expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(reads);
  });

  test.each([0, -1, 1.5, "4", true, null, Number.MAX_SAFE_INTEGER + 1])("invalid admission receipt %s consumes no cycle or director", async invalid => {
    const host = fixture(); host.setHostResponse((key, value) => key === "execute-settings" ? { maxCycles: invalid } : value);
    expect(await host.execute()).toMatchObject({ status: "blocked", loopsConsumed: 0 });
    expect(host.calls).toHaveLength(0); expect(host.storage.size).toBe(0);
  });

  test.each(["stopped", "permission"])("halt-save failure preserves %s AND persistence across reports and replay without dispatch", async cause => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") return { ...result, ok: false,
        ...(cause === "stopped" ? { stopped: true } : { error: "Blocked by pi-subagents permission rule: fixture" }) };
      return result;
    });
    cutAt(host, value => !!value.loops?.[0]?.halt);
    const output = await host.execute();
    expect(output.status).toBe(cause === "stopped" ? "cancelled" : "blocked");
    expect(output.reason).toContain("Essential persistence failed");
    for (const report of host.emits.filter(item => item.type === "execution-loop")) {
      expect(report).toEqual(output.loopReport);
      expect(report.next).toBe("restore essential persistence; resolve observed impediment before any continuation");
      for (const reason of [report.reason, report.pending[0].reason, report.actionRequired, output.reason, output.actionRequired]) {
        expect(reason).toContain("Essential persistence failed");
        expect(reason).toContain(cause === "stopped" ? "stopped" : "permission");
        expect(reason).not.toContain("new invocation");
      }
    }
    const calls = copy(host.calls); host.setFailSave();
    const replay = await host.execute();
    expect(replay.status).toBe(output.status); expect(replay.loopReport.next).toBe("resolve observed impediment");
    expect(host.calls).toEqual(calls); expect(replay.loopsConsumed).toBe(1);
  });

  test.each([
    ["worker", "stopped", "essential"], ["worker", "permission", "essential"],
    ["review", "stopped", "essential"], ["review", "permission", "essential"],
    ["worker", "detached", "essential"], ["review", "recovery", "essential"],
    ["worker", "stopped", "optional"], ["review", "permission", "optional"],
  ])("pre-attachment %s %s survives %s save failure in every report", async (phase, cause, saveKind) => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (phase === "worker" ? request.agent === "pitako.worker" : request.key.endsWith("director-prepare"))
        return { ...result, ok: false, ...(cause === "permission"
          ? { error: "Blocked by pi-subagents permission rule: fixture" } : { [cause!]: true }) };
      return result;
    });
    host.setFailSave(value => {
      const loop = value.loops?.[0];
      const observed = phase === "worker" ? loop?.attempt?.stage === "launched" : !!loop?.review;
      return observed && (saveKind === "optional" ? !!value.activePlan : !value.activePlan);
    });
    const output = await host.execute();
    expectImpediment(host, output, cause === "stopped" ? "cancelled" : "blocked", cause!,
      saveKind === "essential" ? "Essential persistence failed" : "Optional active-plan persistence failed");
    expect(output.maxLoops).toBe(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "worker" ? 1 : 2);
    expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
    expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(1);
  });

  test.each([["decision", "essential"], ["worker", "essential"], ["decision", "optional"], ["worker", "optional"]])(
    "%s block survives pre-finish %s save failure without replacing its reason", async (phase, saveKind) => {
      const host = fixture(); host.setLimit(1);
      const reason = "Decision required: conflicting source obligations";
      host.setRespond((request, normal) => {
        const result = normal();
        if (phase === "decision" && request.key.endsWith(".director"))
          Object.assign(result.structuredOutput, { status: "needs-decision", reason, tasks: [] });
        if (phase === "worker" && request.agent === "pitako.worker")
          Object.assign(result.structuredOutput, { status: "blocked", diagnosis: reason, remaining: [reason] });
        return result;
      });
      host.setFailSave(value => value.loops?.[0]?.outcome === "blocked" &&
        (saveKind === "optional" ? !!value.activePlan : !value.activePlan));
      const output = await host.execute();
      expectImpediment(host, output, "blocked", reason,
        saveKind === "essential" ? "Essential persistence failed" : "Optional active-plan persistence failed");
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "worker" ? 1 : 0);
      const dispatches = () => host.calls.filter(call => call.agent === "pitako.worker" || call.key.endsWith(".director"));
      const calls = copy(dispatches()), reads = host.hostCalls.filter(key => key === "execute-settings").length;
      host.setFailSave(); host.setLimit(4); host.emits.length = 0;
      const replay = await host.execute();
      expectImpediment(host, replay, "blocked", reason);
      expect(replay.maxLoops).toBe(1); expect(dispatches()).toEqual(calls);
      expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(reads);
    });

  test.each([1, 2])("blocked result is atomic and old committed cut replays as blocked at limit %s", async limit => {
    const host = fixture(); host.setLimit(limit);
    const reason = "Human decision required before editing the conflicting API";
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") Object.assign(result.structuredOutput,
        { status: "blocked", diagnosis: reason, remaining: [reason] });
      return result;
    });
    expect(await host.execute()).toMatchObject({ status: "blocked", loopsConsumed: 1 });
    const committed = host.snapshots.find(value => value.loops?.[0]?.attempt?.stage === "result");
    const cut = copy(committed);
    delete cut.loops[0].outcome; delete cut.loops[0].halt; cut.activePlan = null;
    host.storage.set("invoke-human-1", cut);
    const before = copy(cut), calls = copy(host.calls), reads = host.hostCalls.filter(key => key === "execute-settings").length;
    host.setLimit(4); host.emits.length = 0;
    const replay = await host.execute();
    expectImpediment(host, replay, "blocked", reason);
    expect(replay.maxLoops).toBe(limit); expect(host.calls).toEqual(calls);
    expect(host.current()).toEqual(before);
    expect(host.hostCalls.filter(key => key === "execute-settings")).toHaveLength(reads);
    expect(committed.loops[0]).toMatchObject({ outcome: "blocked",
      halt: { status: "blocked", code: "semantic-block", reason } });
    expect(replay.loopReport.halt.ref).toEqual(committed.loops[0].attempt.result.ref);
    expect(replay.loopReport.work).toEqual(committed.loops[0].results.map((result: any) => ({
      taskId: result.taskId, attempt: result.attempt, status: result.status, reference: result.ref,
      workDone: result.workDone, remaining: result.remaining, remainingCount: result.remainingCount, diagnosis: result.diagnosis,
    })));
  });

  test("complete additional spec sources are immutable context for all fresh phases", async () => {
    const host = fixture("SELECTED SNAPSHOT INTACT");
    const sourceRefs = [{ path: "/stable/.pitako/plans/inherited.md", digest: "f".repeat(64) }];
    expect((await host.execute({ sourceRefs })).status).toBe("complete");
    expect(host.current().association.sourceRefs).toEqual(sourceRefs);
    for (const request of host.calls.filter(call => !call.resume)) {
      expect(request.task).toContain("SELECTED SNAPSHOT INTACT");
      expect(request.task).toContain(JSON.stringify(sourceRefs));
      expect(request.task).toContain("read EVERY referenced source IN FULL");
    }
    const count = host.calls.length;
    expect((await host.execute({ sourceRefs: [] })).status).toBe("blocked"); expect(host.calls).toHaveLength(count);
  });

  test("semantic block and halt-save failure both survive every report without exhaustion advice", async () => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".compliance")) Object.assign(result.structuredOutput,
        { status: "blocked", reason: "Decision required: conflicting source obligations" });
      return result;
    });
    cutAt(host, value => value.loops?.[0]?.halt?.code === "semantic-block");
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    for (const report of host.emits.filter(value => value.type === "execution-loop")) {
      expect(report.status).toBe("blocked"); expect(report.next).toContain("resolve observed impediment");
      for (const reason of [report.reason, report.pending[0].reason, report.actionRequired, output.reason, output.actionRequired]) {
        expect(reason).toContain("Decision required"); expect(reason).toContain("Essential persistence failed");
        expect(reason).not.toContain("new invocation");
      }
    }
  });
  test("full shared review assembly validates and runs through the native sandbox with sequential fresh workers", async () => {
    expect(validateWorkflowScript(`const config = ${JSON.stringify(config)};\n${source}`).ok).toBe(true);
    const host = fixture("ALL COMPLETE SPEC SECTIONS");
    const output = await host.executeNative();
    expect(output.status).toBe("complete"); expect(output.loopsConsumed).toBe(1);
    const director = host.calls[0]!;
    expect(director).toMatchObject({ key: "invoke-human-1.l1.director", label: "Plan execution work", phase: "planning" });
    expect(director.agent).toBe("pitako.execution-director"); expect(director.task).toContain("then END");
    expect(director.outputSchema.properties.status.enum).toEqual(["plan", "needs-decision"]);
    expect(host.snapshots.some(value => value.loops?.[0]?.plan?.stage === "intention")).toBe(true);
    const workers = host.calls.filter(call => call.agent === "pitako.worker"); expect(workers).toHaveLength(2);
    for (const worker of workers) {
      const selectedTask = JSON.parse(worker.task.split("COMPLETE SELECTED TASK:\n")[1]!.split("\nFROZEN ATTEMPT")[0]!);
      expect(worker).toMatchObject({ label: selectedTask.goal, phase: "implementation" });
      expect(worker).toMatchObject({ context: "fresh", cwd: host.root, timeoutMs: 14400000, reads: false, progress: false, acceptance: { level: "none" } });
      expect(worker.acceptance.reason).toContain("root owns"); expect(worker.async).toBeUndefined();
      expect(worker.task).toContain("ALL COMPLETE SPEC SECTIONS"); expect(worker.task).toContain("FULL SHARED CONTEXT");
      expect(worker.task).toContain("No delegation, next-task selection, private diary");
    }
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.calls.filter(call => call.key.endsWith(".compliance"))).toHaveLength(1);
    const compliance = host.calls.find(call => call.key.endsWith(".compliance"))!;
    expect(compliance).toMatchObject({ label: "Check whole-spec compliance", phase: "compliance" });
    for (const call of [director, ...workers, compliance]) {
      expect(call.task.startsWith(`${call.label}\n\n`)).toBe(true);
      expect(call.task).toContain("CURRENT HUMAN RESOLUTIONS (accepted input, not new permissions): ");
      expect(call.task).toContain("ASSOCIATION (data): ");
    }
    expect(host.calls.findIndex(call => call.key.endsWith(".compliance"))).toBeGreaterThan(host.calls.findIndex(call => call.key.endsWith("director-synthesis")));
    expect(host.hostCalls.filter(key => key.startsWith("inspect-"))).toEqual(["inspect-initial", "inspect-loop-1"]);
    expect(output.actionRequired).toBe("none"); expect(output.reason).toContain("No more loops");
    expect(output.loopReport.verification.checks.at(-1).current).toBe(true);
    expect(host.current().loops[0].plan.ref).toMatchObject({ agent: "pitako.execution-director", runId: "native-invoke-human-1.l1.director",
      outputReference: "/native/output/invoke-human-1.l1.director.json", outputArtifactPath: "/native/binding/invoke-human-1.l1.director.json",
      outputPathMapping: { requestedPath: "invoke-human-1.l1.director.json", savedPath: "/native/remapped/invoke-human-1.l1.director.json" },
      results: [{ structuredOutputPath: "/native/witness/invoke-human-1.l1.director.json" }] });
    expect(host.current().snapshot.content).toBe("ALL COMPLETE SPEC SECTIONS");
  });

  test("Fleet titles collapse whitespace and stay concise without truncating the selected task", async () => {
    const host = fixture();
    const goal = "  Fix recovery\n after\t timeout " + "with complete evidence ".repeat(12);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) result.structuredOutput.tasks[0].goal = goal;
      return result;
    });
    expect((await host.execute()).status).toBe("complete");
    const worker = host.calls.find(call => call.agent === "pitako.worker")!;
    expect(worker.label).toHaveLength(120);
    expect(worker.label).toStartWith("Fix recovery after timeout with complete evidence");
    expect(worker.label).toBe(worker.task.split("\n")[0]);
    expect(worker.key).toBe("invoke-human-1.l1.t1.a1");
    const selectedTask = JSON.parse(worker.task.split("COMPLETE SELECTED TASK:\n")[1]!.split("\nFROZEN ATTEMPT")[0]!);
    expect(selectedTask.goal).toBe(goal);
  });

  test.each([2, 3, 4])("real %s-angle review includes critiques, one defense and synthesis, not include=material", async angles => {
    const host = fixture("FULL SPECS", { angles, findings: true });
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls.filter(call => call.key.includes(".review."))).toHaveLength(3 * angles + 2);
    expect(host.calls.filter(call => call.key.includes(".review.") && call.resume)).toHaveLength(2 * angles + 1);
  });

  test("director has settled before first worker and no next worker starts before prior settlement", async () => {
    const host = fixture(); let active = false;
    host.setRespond(async (request, normal) => {
      expect(active).toBe(false);
      if (request.agent === "pitako.worker" || request.agent === "pitako.execution-director") {
        active = true;
        await Promise.resolve(); active = false;
      }
      return normal();
    });
    expect((await host.execute()).status).toBe("complete"); expect(active).toBe(false);
  });

  test("useful diagnosed continuation retains logical ID with new attempt; repeated evidence is not a retry loop", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker" && request.key.includes(".t1.a1")) Object.assign(result.structuredOutput, {
        status: "continue", remaining: ["Fix concrete diagnosed parser branch"], diagnosis: "Required test exposed missing parser case",
        continuation: "Correct src/change1.ts branch; run planned check", usefulProgress: true,
      });
      return result;
    });
    expect((await host.execute()).status).toBe("complete");
    const workers = host.calls.filter(call => call.agent === "pitako.worker");
    expect(workers.map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2", "invoke-human-1.l1.t2.a1"]);
    expect(workers[1]!.task).toContain("/native/output/invoke-human-1.l1.t1.a1.json");
    expect(host.current().loops[0].manifest).toEqual(["change1", "final"]);
    expect(host.current().loops[0].results[1]).toMatchObject({ taskId: "change1", attempt: 2 });
  });

  test.each(["blind", "repeat", "gaps"])("%s continuation passes concrete pending work to a new director, without arbitrary quotas", async mode => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker" && request.key.includes(".l1.")) Object.assign(result.structuredOutput, {
        status: mode === "gaps" ? "gaps" : "continue", remaining: ["Concrete pending case"], diagnosis: "Missing branch observed",
        continuation: "Repair the same scoped branch", usefulProgress: mode !== "blind",
      });
      return result;
    });
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key.includes(".l1."))).toHaveLength(mode === "repeat" ? 2 : 1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(2);
  });

  test.each(["missing-final-checks", "mismatched-association", "duplicate-id", "preview-only"])("rejects %s before any edit", async mode => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal(); if (request.key.endsWith(".director")) {
        if (mode === "missing-final-checks") result.structuredOutput.tasks.pop();
        if (mode === "mismatched-association") result.structuredOutput.association.root = "/wrong";
        if (mode === "duplicate-id") result.structuredOutput.tasks[1].id = "change1";
        if (mode === "preview-only") { result.output = "{preview...}"; delete result.structuredOutput; }
      } return result;
    });
    expect((await host.execute()).status).toBe("blocked"); expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
  });

  test("initial admission compares COMPLETE JSON binding not equal IDs", async () => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal(); if (request.key.endsWith(".director")) {
        const binding = copy(result.structuredOutput); binding.tasks[0].scope = ["unauthorized/path"];
        result.output = JSON.stringify(binding);
      } return result;
    });
    expect((await host.execute()).reason).toContain("conflicting"); expect(host.calls).toHaveLength(1);
  });

  test.each(["canonical", "descriptive", "id-only"])("worker %s requirements continue with unchanged originals", async wording => {
    const host = fixture();
    const originals: { value: any; retained: any }[] = [];
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") {
        expect(request.outputSchema.properties.checks.items.required).not.toContain("requirement");
        for (const check of result.structuredOutput.checks) {
          if (wording === "descriptive") check.requirement = "Observed scoped regression behavior";
          if (wording === "id-only") delete check.requirement;
        }
        originals.push({ value: result.structuredOutput, retained: copy(result.structuredOutput) });
      }
      return result;
    });
    expect(await host.executeNative()).toMatchObject({ status: "complete", loopsConsumed: 1 });
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(2);
    expect(host.calls.filter(call => call.key.endsWith("director-prepare"))).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    for (const { value, retained } of originals) expect(value).toEqual(retained);
    expect(host.current().loops[0].results.every((entry: any) => entry.checks.current)).toBe(true);
  });

  test("additional worker checks preserve mandatory evidence and continue in the same loop", async () => {
    const host = fixture();
    let original: any;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.t1.a1") {
        const value = result.structuredOutput, check = value.checks[0];
        value.checks.unshift({ ...copy(check), id: "typecheck", command: "bun run typecheck" });
        value.checks.push({ ...copy(check), id: "full-test", command: "bun run test" });
        original = copy(value);
      }
      return result;
    });
    const output = await host.executeNative();
    expect(output).toMatchObject({ status: "complete", loopsConsumed: 1, actionRequired: "none" });
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(2);
    expect(host.native.get("invoke-human-1.l1.t1.a1")!.structuredOutput).toEqual(original);
    expect(host.current().loops[0].results[0].checks)
      .toEqual({ current: true, count: 3, passed: 3, failed: 0, notRun: 0 });
  });

  test.each(["failed", "not-run", "stale", "unknown", "uncaptured"])("diagnostic check history does not become a mandatory %s gate", async mode => {
    const host = fixture();
    let original: any;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.t1.a1") {
        const value = result.structuredOutput;
        value.checks.push({
          ...copy(value.checks[0]), id: "diagnostic", result: mode === "stale" ? "passed" : mode === "not-run" ? "not-run" : "failed",
          before: mode === "unknown" ? null : mode === "uncaptured" ?
            { head: "not-captured", fingerprint: "temporary-defect" } : candidate(2),
          after: mode === "unknown" ? null : mode === "uncaptured" ?
            { head: "not-captured", fingerprint: "restored" } : candidate(2),
        });
        original = copy(value);
      }
      return result;
    });
    expect(await host.executeNative()).toMatchObject({ status: "complete", loopsConsumed: 1 });
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(2);
    expect(host.native.get("invoke-human-1.l1.t1.a1")!.structuredOutput).toEqual(original);
    expect(host.current().loops[0].results[0].checks).toMatchObject({ current: true, count: 2 });
  });

  test.each(["missing-mandatory", "duplicate-mandatory", "duplicate-additional", "empty-id", "empty-command",
    "empty-cwd", "empty-output", "invalid-logs", "invalid-log-entry", "invalid-result", "missing-identity",
    "changed-mandatory-command", "changed-mandatory-cwd"])("additional checks cannot hide %s evidence", async mode => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") {
        const value = result.structuredOutput;
        const extra = { ...copy(value.checks[0]), id: "typecheck", command: "bun run typecheck" };
        value.checks.push(extra);
        if (mode === "missing-mandatory") value.checks.shift();
        if (mode === "duplicate-mandatory") extra.id = value.checks[0].id;
        if (mode === "duplicate-additional") value.checks.push(copy(extra));
        if (mode === "empty-id") extra.id = "";
        if (mode === "empty-command") extra.command = "";
        if (mode === "empty-cwd") extra.cwd = "";
        if (mode === "empty-output") extra.output = "";
        if (mode === "invalid-logs") extra.logPaths = null;
        if (mode === "invalid-log-entry") extra.logPaths = [""];
        if (mode === "invalid-result") extra.result = "green";
        if (mode === "missing-identity") value.checks[0].before = null;
        if (mode === "changed-mandatory-command") value.checks[0].command = "echo green";
        if (mode === "changed-mandatory-cwd") value.checks[0].cwd = "/other";
      }
      return result;
    });
    expect((await host.executeNative()).status).toBe("blocked");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.some(call => call.key.includes(".review."))).toBe(false);
  });

  test("a failed mandatory check cannot hide malformed additional evidence", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") {
        const value = result.structuredOutput;
        value.status = "gaps";
        value.checks[0].result = "failed";
        value.checks.push({ ...copy(value.checks[0]), id: "typecheck", command: "bun run typecheck", output: "" });
      }
      return result;
    });
    expect(await host.executeNative()).toMatchObject({ status: "blocked", reason: expect.stringContaining("Check command/cwd/output/result") });
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  });


  test.each(["missing-id", "unknown-id", "duplicate-id", "null-entry", "empty-output", "bad-logs",
    "bad-log-entry", "bad-before", "bad-after", "bad-result", "bad-echo", "wrong-producer",
    "wrong-nested-producer", "failed-exit", "wrong-key", "wrong-task", "wrong-attempt", "binding-conflict", "native-ok-only"])(
    "worker %s is rejected before further worker or review dispatch", async mode => {
      const host = fixture(undefined, { readOnly: true }); host.setLimit(1);
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.worker") {
          const value = result.structuredOutput, check = value.checks[0];
          if (mode === "missing-id") delete check.id;
          if (mode === "unknown-id") check.id = "unplanned";
          if (mode === "duplicate-id") value.checks.push(copy(check));
          if (mode === "null-entry") value.checks[0] = null;
          if (mode === "empty-output") check.output = "";
          if (mode === "bad-logs") check.logPaths = "not-an-array";
          if (mode === "bad-log-entry") check.logPaths = [null];
          if (mode === "bad-before") check.before = { head: "invalid", fingerprint: candidate().fingerprint };
          if (mode === "bad-after") check.after = null;
          if (mode === "bad-result") check.result = "ok";
          if (mode === "bad-echo") check.requirement = 42;
          if (mode === "wrong-producer") result.agent = "pitako.reviewer";
          if (mode === "wrong-nested-producer") result.results![0]!.agent = "pitako.reviewer";
          if (mode === "failed-exit") result.results![0]!.exitCode = 1;
          if (mode === "wrong-key") result.key = "another-invocation.l2.t1.a1";
          if (mode === "wrong-task") value.taskId = "final";
          if (mode === "wrong-attempt") value.attempt = 2;
          if (mode === "binding-conflict") result.output = JSON.stringify({ ...value, taskId: "other" });
          if (mode === "native-ok-only") delete result.structuredOutput;
        }
        return result;
      });
      expect((await host.execute()).status).not.toBe("complete");
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
      expect(host.calls.filter(call => call.key.includes(".review.") || call.key.endsWith(".compliance"))).toHaveLength(0);
      expect(host.current().loops[0].results.every((entry: any) => !entry.checks?.current)).toBe(true);
    });

  test.each(["failed", "not-run"])("worker validates malformed later entries after %s", async firstResult => {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) {
        const checks = result.structuredOutput.tasks[0].checks;
        checks.push({ ...checks[0], id: "second-check" });
      }
      if (request.agent === "pitako.worker") {
        const value = result.structuredOutput;
        value.status = "gaps"; value.remaining = ["Functional gap"];
        value.checks[0].result = firstResult;
        value.checks[1] = { ...value.checks[0], id: "second-check", logPaths: [42] };
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    expect(output.reason).toContain("Check command/cwd/output/result");
    expect(host.current().loops[0].results).toHaveLength(0);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.some(call => call.key.includes(".review."))).toBe(false);
  });

  test.each(["wrong-command", "wrong-cwd", "stale-check", "no-diagnosis", "pending-complete",
    "failed", "not-run", "stale-wip"])("worker %s cannot satisfy current mandatory checks", async mode => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal(); if (request.agent === "pitako.worker") {
        const value = result.structuredOutput;
        if (mode === "wrong-command") value.checks[0].command = "echo green";
        if (mode === "wrong-cwd") value.checks[0].cwd = "/other";
         if (mode === "stale-check") value.checks[0].after = candidate(2);
         if (mode === "stale-wip") value.candidate = candidate(2);
         if (mode === "failed" || mode === "not-run") value.checks[0].result = mode;
        if (mode === "no-diagnosis") value.diagnosis = "";
        if (mode === "pending-complete") value.remaining = ["Not done"];
      } return result;
    });
    expect((await host.execute()).status).toBe("blocked"); expect(host.calls.some(call => call.key.includes(".review."))).toBe(false);
  });

  test("material review gaps skip compliance and all repairs until next director", async () => {
    const host = fixture("FULL SPECS", { findings: true }); host.setRespond((request, normal) => {
      const result = normal(); if (request.key.endsWith("director-synthesis") && request.key.includes(".l1.")) {
        result.structuredOutput.screening.verdict = "material-gaps";
        result.structuredOutput.screening.assessments[0].material = true;
      } return result;
    });
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls.filter(call => call.key.endsWith(".compliance")).map(call => call.key)).toEqual(["invoke-human-1.l2.compliance"]);
    const synthesis = host.calls.findIndex(call => call.key === "invoke-human-1.l1.review.director-synthesis");
    expect(host.calls[synthesis + 1]!.key).toBe("invoke-human-1.l2.director");
    const report = host.emits.find(value => value.type === "execution-loop" && value.loop === 1);
    expect(report.next).toBe("continue loop 2"); expect(report.verification.compliance.status).toBe("not-run");
  });

  test.each(["empty", "all-not-applicable", "duplicate", "missing-source", "reasonless", "green-only", "wrong-candidate"])("%s compliance never completes", async mode => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal(); if (request.key.endsWith(".compliance")) {
        const value = result.structuredOutput;
        if (mode === "empty") value.requirements = [];
        if (mode === "all-not-applicable") value.requirements.forEach((item: any) => { item.status = "not-applicable"; });
        if (mode === "duplicate") value.requirements[1].id = value.requirements[0].id;
        if (mode === "missing-source") value.requirements[0].source = "";
        if (mode === "reasonless") value.requirements[0].reason = "";
        if (mode === "green-only") value.requirements[0].evidence = [];
        if (mode === "wrong-candidate") value.candidate = candidate(3);
      } return result;
    });
    const output = await host.execute(); expect(output.status).toBe(mode === "wrong-candidate" ? "partial" : "blocked");
  });

  test.each([{ ids: ["AC-output", "constraint-no-publication"] }, { ids: ["REQ-A"] }])("complete selected specs admit their own shorter inventory: %j", async ({ ids }) => {
    const content = `# Acceptance criteria\n${ids[0]}: required output.\n# Constraints\nNo publication.\n# Verification\nCheck the output.`;
    const host = fixture(content);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".compliance")) {
        expect(request.task).toContain(content);
        expect(request.task).toContain("obligations in expected");
        expect(request.task).not.toContain("criterion-17");
        expect(request.outputSchema.properties.requirements.minItems).toBe(1);
        result.structuredOutput.requirements = ids.map((id, index) => ({
          ...result.structuredOutput.requirements[index], id,
          source: index ? "spec:Constraints,Verification" : "spec:Acceptance criteria,Constraints,Verification",
        }));
      }
      return result;
    });
    expect((await host.execute()).status).toBe("complete");
  });

  test("an analyst's identified outside-acceptance obligation remains a gap until the next loop", async () => {
    const host = fixture("# Acceptance criteria\nAC-output: output exists.\n# Constraints\nDo not publish.");
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".compliance") && request.key.includes(".l1.")) {
        result.structuredOutput.status = "gaps";
        result.structuredOutput.requirements.push({ id: "no-publication", source: "spec:Constraints",
          reason: "Publication obligation not yet evidenced", status: "gap",
          evidence: ["/native/work-result.json: publication evidence absent"], checks: [] });
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe("complete"); expect(output.loopsConsumed).toBe(2);
    expect(host.current().loops[0].compliance.status).toBe("gaps");
  });

  test.each(["compliance", "adversarial", "candidate-drift"])("three %s gaps report exhaustion on every emission and replay without renewing slots", async mode => {
    const host = fixture("FULL SPECS", { findings: true });
    host.setRespond((request, normal) => {
      const result = normal();
      if (mode === "compliance" && request.key.endsWith(".compliance")) return gaps(result);
      if (mode === "adversarial" && request.key.endsWith("director-synthesis")) {
        result.structuredOutput.screening.verdict = "material-gaps";
        result.structuredOutput.screening.assessments[0].material = true;
      }
      return result;
    });
    if (mode === "candidate-drift") host.setHostResponse((key, value) => {
      if (key.startsWith("inspect-loop-")) {
        const version = Number(key.slice("inspect-loop-".length));
        host.changeCheckout(version); return { ...value, checkout: host.observedCandidate() };
      }
      return value;
    });
    const output = await host.execute(); expect(output).toMatchObject({ status: "partial", loopsConsumed: 3 });
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(3);
    const reports = host.emits.filter(value => value.type === "execution-loop");
    expect(reports.slice(0, 2).map(value => value.next)).toEqual(["continue loop 2", "continue loop 3"]);
    expect(reports.slice(0, 2).every(value => value.status === "gaps" && value.actionRequired === "none")).toBe(true);
    expect(reports.filter(value => value.loop === 3)).toHaveLength(2);
    const count = host.calls.length; expect((await host.execute()).status).toBe("partial"); expect(host.calls).toHaveLength(count);
    expect(host.current().loops).toHaveLength(3);
    const exhausted = host.emits.filter(value => value.type === "execution-loop" && value.loop === 3);
    expect(exhausted).toHaveLength(3);
    for (const report of exhausted) {
      expect(report.status).toBe("partial");
      expect(report.next).toBe("new invocation requires human authorization");
      for (const message of [report.reason, report.pending[0].reason, report.actionRequired]) {
        expect(message).toContain("partial");
        expect(message).toContain("new invocation with human authorization");
        expect(message).not.toContain("next director");
        expect(message).not.toContain("continue loop");
      }
      if (mode === "candidate-drift") {
        expect(report.reason).toContain("stale");
        expect(report.verification.checks.every((check: any) => check.status === "stale" && !check.current)).toBe(true);
      }
    }
  });

  test.each(["compliance", "adversarial", "candidate-drift"])("third-loop %s closing persistence suspension reports recovery before exhaustion without repeating work", async mode => {
    const host = fixture("FULL SPECS", { findings: true });
    host.setRespond((request, normal) => {
      const result = normal();
      if (mode === "compliance" && request.key.endsWith(".compliance")) return gaps(result);
      if (mode === "adversarial" && request.key.endsWith("director-synthesis")) {
        result.structuredOutput.screening.verdict = "material-gaps";
        result.structuredOutput.screening.assessments[0].material = true;
      }
      return result;
    });
    if (mode === "candidate-drift") host.setHostResponse((key, value) => {
      if (!key.startsWith("inspect-loop-")) return value;
      const version = Number(key.slice("inspect-loop-".length));
      host.changeCheckout(version); return { ...value, checkout: host.observedCandidate() };
    });
    let cutObserved = false;
    cutAt(host, value => {
      const third = value.loops?.[2];
      if (third?.phase !== "finished" || third.outcome !== "gaps") return false;
      cutObserved = true; return true;
    });
    const output = await host.execute();
    expect(cutObserved).toBe(true);
    expect(output).toMatchObject({ status: "partial", phase: "closing", loopsConsumed: 3 });
    const reports = host.emits.filter(value => value.type === "execution-loop");
    expect(reports.map(value => value.loop)).toEqual([1, 2, 3]);
    expect(reports.slice(0, 2).map(value => value.next)).toEqual(["continue loop 2", "continue loop 3"]);
    expect(output.loopReport).toEqual(reports[2]);
    for (const report of reports.filter(value => value.loop === 3)) {
      expect(report).toMatchObject({ status: "partial", phase: "closing",
        next: "restore essential persistence; continuation requires supported native reconciliation" });
      for (const message of [report.reason, report.pending[0].reason, report.actionRequired, output.reason, output.actionRequired]) {
        expect(message).toContain("Essential persistence failed");
        expect(message).toContain("Controlled essential persistence cut");
        expect(message).not.toContain("new invocation");
        expect(message).not.toContain("next director");
      }
      expect(report.verification.compliance.status).toBe(mode === "adversarial" ? "not-run" : mode === "candidate-drift" ? "stale" : "gaps");
    }
    expect(host.current().loops[2]).toMatchObject({ phase: "closing" });
    expect(host.current().loops[2].outcome).toBeUndefined();
    const calls = copy(host.calls), usage = host.current().loops.map((loop: any) => copy(loop.usage));
    const startedAt = host.current().startedAt, loopStartedAt = host.current().loops[2].startedAt;
    const closes = host.hostCalls.filter(key => key === "inspect-loop-3").length;
    host.setFailSave(); host.advance(10000);
    const recovered = await host.execute();
    expect(recovered).toMatchObject({ status: "partial", loopsConsumed: 3 });
    expect(host.calls).toEqual(calls);
    expect(host.current().loops.map((loop: any) => loop.number)).toEqual([1, 2, 3]);
    expect(host.current().loops.map((loop: any) => loop.usage)).toEqual(usage);
    expect(host.current().startedAt).toBe(startedAt);
    expect(host.current().loops[2].startedAt).toBe(loopStartedAt);
    expect(recovered.tokens).toEqual(output.tokens);
    expect(recovered.elapsedMs).toBe(output.elapsedMs + 10000);
    expect(recovered.loopReport.elapsedMs).toBe(output.loopReport.elapsedMs + 10000);
    expect(host.hostCalls.filter(key => key === "inspect-loop-3")).toHaveLength(closes);
    expect(host.current().loops[2]).toMatchObject({ phase: "finished", outcome: "gaps" });
    const recoveredReports = host.emits.slice(host.emits.indexOf(reports[2]) + 1).filter(value => value.type === "execution-loop");
    expect(recoveredReports).toHaveLength(2);
    expect(recovered.loopReport).toEqual(recoveredReports[1]);
    for (const report of recoveredReports) {
      expect(report).toMatchObject({ status: "partial", next: "new invocation requires human authorization" });
      for (const message of [report.reason, report.pending[0].reason, report.actionRequired]) {
        expect(message).toContain("new invocation with human authorization");
        expect(message).not.toContain("persistence");
        expect(message).not.toContain("next director");
      }
    }
  });

  test("candidate drift at the single closing comparison invalidates checks/review/compliance and goes to next director", async () => {
    const host = fixture(); host.setHostResponse((key, value) => {
      if (key === "inspect-loop-1") { host.changeCheckout(); return { ...value, checkout: host.observedCandidate() }; } return value;
    });
    expect((await host.execute()).status).toBe("complete");
    expect(host.hostCalls.filter(key => key.startsWith("inspect-"))).toEqual(["inspect-initial", "inspect-loop-1", "inspect-loop-2"]);
    const stale = host.emits.find(value => value.type === "execution-loop");
    expect(stale.reason).toContain("stale");
    expect(stale.verification.checks.every((check: any) => check.status === "stale" && !check.current)).toBe(true);
    expect(stale.verification.adversarial.status).toBe("stale");
    expect(stale.verification.compliance.status).toBe("stale");
  });

  test.each(["published", "admitted", "result-before-cursor"])("durable %s cut recovers original values without repeated completed edits or renewed slots", async phase => {
    const host = fixture();
    cutAt(host, value => {
      const loop = value.loops?.[0];
      return phase === "published" ? loop?.plan?.stage === "published" : phase === "admitted"
        ? loop?.phase === "implementation" : loop?.cursor === 1;
    });
    const first = await host.execute(); expect(first.status).toBe("partial");
    const firstWorkers = host.calls.filter(call => call.agent === "pitako.worker").length;
    expect(firstWorkers).toBe(phase === "result-before-cursor" ? 1 : 0);
    host.setFailSave(); host.advance(10000);
    expect((await host.execute()).status).toBe("complete");
    expect(host.current().loops).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(2);
    expect(host.current().startedAt).toBe(1000);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
  });

  test.each(["direct-values", "direct-conflict", "absent-binding", "absent-witness", "cache-only", "lost-definition", "changed-binding", "changed-native", "changed-order"])("recovery distinguishes %s using full originals and exact refs", async mode => {
    const host = fixture(undefined, { readOnly: true });
    cutAt(host, value => value.loops?.[0]?.attempt?.stage === "intention");
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    // The attempt intention was never persisted: no writer launch ambiguity here.
    if (mode !== "cache-only" && mode !== "changed-native") removeCache(host);
    if (mode === "lost-definition" || mode === "cache-only") {
      host.native.delete("native-invoke-human-1.l1.director"); host.native.delete("invoke-human-1.l1.director");
    }
    if (mode === "absent-witness") for (const value of host.native.values()) delete value.results;
    if (mode.startsWith("direct-")) for (const value of host.native.values()) {
      const binding = copy(value.structuredOutput);
      if (mode === "direct-conflict") binding.tasks[0].scope = ["conflicting-native-binding"];
      value.output = JSON.stringify(binding);
    }
    // Only the unavailable-direct-value cases need the exceptional inspector.
    // A file-only preview alone is not a reason to query again.
    if (["absent-binding", "changed-binding", "changed-order"].includes(mode))
      host.setStatus(() => ({ ok: true, results: [] }));
    if (mode === "changed-native") host.setStatus(ref => {
      // An admitted complete cache does not require an optional inspector.
      // Supply the actually conflicting native original at its exact producer.
      const result = copy(host.native.get(ref)!);
      if (result?.structuredOutput?.tasks) result.structuredOutput.tasks[0].scope = ["changed-but-same-id"];
      return result;
    });
    host.setRespond((request, normal) => {
      const result = normal(); if (request.key.includes(".recover")) {
        const value = result.structuredOutput;
        if (mode === "absent-binding") Object.assign(value, { binding: "absent", comparison: "only-original" });
        if (mode === "changed-binding") Object.assign(value, { status: "conflict", binding: "changed", comparison: "different-full-json" });
        if (mode === "changed-order" && value.original) value.original.tasks.reverse();
      } return result;
    });
    const output = await host.execute();
    if (["direct-conflict", "changed-binding", "changed-native", "changed-order"].includes(mode)) {
      expect(output.status).toBe("blocked"); expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
    } else {
      expect(output.status).toBe("complete");
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(mode === "lost-definition" ? 2 : 1);
      if (mode === "absent-binding") expect(host.current().loops[0].plan.recoverySource.binding).toBe("absent");
    }
    if (mode.startsWith("direct-")) expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
  });

  test.each(["running", "queued", "pending", "detached", "recovery", "stopped", "permission", "management", "missing"])("unresolved writer %s cannot be blindly redispatched or replaced in another slot", async mode => {
    const host = fixture(undefined, { readOnly: true });
    cutAt(host, value => !!value.loops?.[0]?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    const saved = host.current().loops[0].attempt;
    expect(saved.stage).toBe("intention"); // durable dispatch cut lacks launch association
    host.setStatus(ref => {
      if (!ref.includes(".t1.a1")) return copy(host.native.get(ref) ?? { ok: true, results: [] });
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
      if (mode === "management") return { ok: true, results: [], output: `Run: ${ref}\nState: running\nMode: single` };
      if (mode === "missing") return { ok: true, results: [] };
      return { ok: true, state: ["running", "queued", "pending"].includes(mode) ? mode : undefined, [mode]: true };
    });
    const output = await host.execute(); expect(["blocked", "cancelled"]).toContain(output.status);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    expect(host.current().loops).toHaveLength(1);
  });

  test("dispatch-before-result can reconcile the exact settled original, without calling the writer key again", async () => {
    const host = fixture(); cutAt(host, value => !!value.loops?.[0]?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t2.a1"]);
    expect(host.statusCalls).toContain("invoke-human-1.l1.t1.a1");
  });

  test("native status may echo its queried run ID without changing the frozen dispatch or original report", async () => {
    const host = fixture();
    cutAt(host, value => value.loops?.[0]?.attempt?.stage === "result");
    expect((await host.executeNative()).status).toBe("partial");
    const original = copy(host.native.get("native-invoke-human-1.l1.t1.a1"));
    host.setFailSave();
    expect((await host.executeNative()).status).toBe("complete");
    expect(host.statusCalls).toContain("native-invoke-human-1.l1.t1.a1");
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.current().loops[0].results[0].ref.key).toBe("invoke-human-1.l1.t1.a1");
    expect(host.native.get("native-invoke-human-1.l1.t1.a1")).toEqual(original);
  });

  test.each(["native-original", "exact-fallback"])(
    "a new published receipt missing its value consumes the %s and really starts implementation", async mode => {
      const host = fixture();
      let original: any;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.execution-director") {
          original = copy(result);
          delete result.structuredOutput;
        }
        if (request.agent === "pitako.execution-inspector") {
          expect(request).toMatchObject({ label: "Recover complete execution plan", phase: "recovery" });
          expect(request.task.startsWith(`${request.label}\n\nEXCEPTIONAL READ-ONLY`)).toBe(true);
          expect(host.current().loops[0].recoveries[0]).toMatchObject({
            subject: "loop-plan", phase: "loop-plan", stage: "intention",
            source: { key: "invoke-human-1.l1.director" },
          });
          Object.assign(result.structuredOutput, { status: "recovered", original: copy(original.structuredOutput),
            originalAvailable: true, binding: "absent", comparison: "only-original" });
        }
        return result;
      });
      host.setStatus(() => mode === "native-original" ? copy(original) : { ok: true, results: [] });
      const output = await host.executeNative();
      expect(output.status).toBe("complete");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector"))
        .toHaveLength(mode === "native-original" ? 0 : 1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(2);
      expect(host.current().loops[0].plan.stage).toBe("admitted");
      expect(host.current().loops[0].plan.status).toBe("plan");
      expect(host.current().loops).toHaveLength(1);
      expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(true);
    },
  );

  test.each(["none", "before-intent", "before-observation", "before-result", "before-cursor", "after-cursor"])(
    "settled exact fallback advances the active root across %s without another query or writer", async cut => {
      const host = fixture(undefined, { readOnly: true });
      let original: any;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key === "invoke-human-1.l1.t1.a1") {
          original = copy(result.structuredOutput);
          original.checks.push({ id: "historical-diagnostic", command: "old replay", cwd: config.root,
            output: "Historical failure; not a current obligation", logPaths: [], result: "failed",
            before: null, after: { head: "unknown", fingerprint: "unverifiable" } });
          delete result.structuredOutput;
        }
        if (request.agent === "pitako.execution-inspector") {
          const intent = host.current().loops[0].recoveries[0];
          expect(intent).toMatchObject({ subject: "attempt-result:change1:1", phase: "attempt-result",
            association: host.plan().association, stage: "intention", disposition: "pending",
            source: { key: "invoke-human-1.l1.t1.a1", runId: "native-invoke-human-1.l1.t1.a1" } });
          expect(request.task).toContain("specific scope/effects expansion needed");
          expect(request.task).toContain("/native/binding/invoke-human-1.l1.t1.a1.json");
          Object.assign(result.structuredOutput, { status: "recovered", workerResult: copy(original), original: null });
        }
        return result;
      });
      if (cut !== "none") cutAt(host, value => {
        const loop = value.loops?.[0];
        return cut === "before-intent" ? loop?.recoveries?.[0]?.stage === "intention"
          : cut === "before-observation" ? loop?.recoveries?.[0]?.stage === "observed"
          : cut === "before-result" ? loop?.attempt?.stage === "result"
          : cut === "before-cursor" ? loop?.cursor === 1
          : loop?.attempt?.taskId === "final";
      });
      const first = await host.executeNative();
      if (cut !== "none") {
        expect(first.status).toBe("partial");
        expect(first.reason).toContain("Essential persistence failed");
        expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
        host.setFailSave();
        expect((await host.executeNative()).status).toBe("complete");
      } else expect(first.status).toBe("complete");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
        .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t2.a1"]);
      expect(host.calls.some(call => call.key.endsWith("review.director-prepare"))).toBe(true);
      expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(true);
      expect(host.current().loops).toHaveLength(1);
      expect(host.current().association.maxCycles).toBe(3);
      expect(host.current().loops[0].results[0].checks).toMatchObject({ current: true, count: 2, failed: 1 });
      expect(host.current().loops[0].results[0].ref).toMatchObject({
        key: "invoke-human-1.l1.t1.a1", runId: "native-invoke-human-1.l1.t1.a1",
        outputArtifactPath: "/native/binding/invoke-human-1.l1.t1.a1.json",
        recovery: { field: "structuredOutput.workerResult",
          ref: { runId: "native-invoke-human-1.l1.recover1" } },
      });
      expect(host.current().loops[0].recoveries[0]).toMatchObject({ stage: "observed", disposition: "recovered" });
      expect(host.current().loops[0].halt).toBeUndefined();
      expect(original.checks[1].after).toEqual({ head: "unknown", fingerprint: "unverifiable" });
    },
  );

  test("intent committed before an uncertain launch cannot authorize a replacement observation", async () => {
    const host = fixture(undefined, { readOnly: true });
    cutAt(host, value => !!value.loops?.[0]?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial");
    host.setFailSave();
    host.setStatus(ref => ref.includes(".t1.a1") ? { ok: true, results: [] } : copy(host.native.get(ref)!));
    const setter = host.state.set;
    host.state.set = async (key, value: any) => {
      await setter(key, value);
      if (value.loops?.[0]?.recoveries?.[0]?.stage === "intention")
        throw Error("Controlled interruption after committed intent");
    };
    expect((await host.execute()).status).toBe("partial");
    expect(host.current().loops[0].recoveries[0].stage).toBe("intention");
    host.state.set = setter;
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    expect(output.reason).toContain("settlement/result uncertain");
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.current().loops).toHaveLength(1);
  });

  // Rejects treating unresolved observation as ordinary loss, including the
  // admitted-definition caller and a replay with the retained inspector value.
  test.each(["published", "admitted"])("unresolved %s plan retains scope impediment without replacement dispatch", async stage => {
    const host = fixture();
    const reason = "Actor: artifact owner. Exact binding unreadable. Expansion needed: grant read access to that binding; do not change permissions here.";
    if (stage === "admitted") {
      cutAt(host, value => value.loops?.[0]?.phase === "implementation");
      expect((await host.executeNative()).status).toBe("partial");
      host.setFailSave(); removeCache(host);
    }
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") delete result.structuredOutput;
      if (request.agent === "pitako.execution-inspector") Object.assign(result.structuredOutput, {
        status: "unresolved", reason, original: null, originalAvailable: false,
        binding: "unavailable", comparison: "neither",
      });
      return result;
    });
    host.setStatus(ref => ref.includes(".recover") ? copy(host.native.get(ref)!) : { ok: true, results: [] });
    for (let replay = 0; replay < 2; replay++) {
      const output = await host.executeNative();
      expect(output).toMatchObject({ status: "blocked", loopsConsumed: 1,
        reason: expect.stringContaining(reason), actionRequired: expect.stringContaining(reason),
        action: { actor: "evidence owner", started: false,
          operation: "resolve the concrete retained impediment; no replacement dispatch" } });
      expect(output.action.references).toContainEqual(expect.objectContaining({ agent: "pitako.execution-inspector" }));
      expect(host.current().loops[0].recoveries[0]).toMatchObject({ disposition: "unresolved", stage: "observed",
        provenance: ["/native/binding/invoke-human-1.l1.director.json"] });
      expect(host.current().loops).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
    }
  });

  test.each(["pending", "missing", "outside-scope", "conflicting-binding"])(
    "the finite %s observation route retains evidence and cannot renew itself by renaming refs", async mode => {
      const host = fixture(undefined, { readOnly: true });
      let original: any;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.worker") { original = copy(result.structuredOutput); delete result.structuredOutput; }
        if (request.agent === "pitako.execution-inspector") {
          if (mode === "pending") return { ...result, state: "pending", structuredOutput: undefined };
          if (mode === "missing") return { ...result, structuredOutput: undefined };
          if (mode === "outside-scope") Object.assign(result.structuredOutput, { status: "unresolved", workerResult: null,
            reason: "Actor: artifact owner. Exact retained binding is unreadable. Expansion needed: grant read access to that binding; do not change permissions here." });
          if (mode === "conflicting-binding") {
            Object.assign(result.structuredOutput, { status: "recovered", workerResult: original });
            result.output = JSON.stringify({ ...result.structuredOutput, reason: "Different original" });
          }
        }
        return result;
      });
      const first = await host.executeNative();
      expect(first.status).toBe("blocked");
      expect(first.action.actor).not.toBe("human");
      expect(first.action.started).toBe(false);
      if (mode === "outside-scope") {
        expect(first.reason).toContain("Expansion needed: grant read access");
        expect(first.action.references).toContainEqual(expect.objectContaining({ agent: "pitako.execution-inspector" }));
        expect(first.actionRequired).not.toContain("consent");
      }
      const saved = host.current();
      saved.loops[0].recoveries[0].ref.key = "renamed-query";
      saved.loops[0].recoveries[0].source.key = "renamed-writer";
      host.storage.set("invoke-human-1", saved);
      expect((await host.executeNative()).status).toBe("blocked");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
      expect(host.current().loops[0].recoveries).toHaveLength(1);
      expect(host.current().association.maxCycles).toBe(3);
    },
  );

  test.each([
    ["running", "State: running", true],
    ["live foreground", "State: live foreground", true],
    ["queued", "State: queued", true],
    ["pending", "State: pending", true],
    ["paused", "State: paused", true],
    ["recovery", "State: recovery", true],
    ["detached", "State: remembered foreground\n1. pitako.worker detached, detached: awaiting supervisor", true],
    ["remembered running", "State: remembered foreground\n1. pitako.worker running", true],
    ["named remembered child", "State: remembered foreground\n1. Writer task one running", true],
    ["remembered paused", "State: remembered foreground\n1. pitako.worker paused, exit 0", true],
    ["pending append", "State: complete\nPending appends: 1", true],
    ["nested running", "State: complete\n  ↳ worker [native-child] running | tool bash", true],
    ["nested exact queued", "Root: native-parent\nParent: native-parent\nState: queued", true],
    ["settled historical detach", "State: remembered foreground\n1. pitako.worker completed, exit 0, detached: awaiting supervisor", false],
    ["settled prose", "State: remembered foreground\n1. pitako.worker completed, exit 0, output: worker stopped, pending recovery", false],
    ["settled async", "State: complete\nPending appends: 0", false],
    ["unrelated run", "State: running", false],
    ["unrelated body run", "State: running", false],
    ["unrelated output", "State: complete\nOutput: /native/running-stopped-recovery.txt", false],
  ])("installed wrapped status distinguishes %s from actual writer activity", async (mode, body, active) => {
    const host = fixture(undefined, { readOnly: true });
    cutAt(host, value => !!value.loops?.[0]?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    const original = copy(host.native.get("invoke-human-1.l1.t1.a1")!.structuredOutput);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.includes(".recover")) result.structuredOutput.workerResult = original;
      return result;
    });
    host.setStatus(ref => {
      if (!ref.includes(".t1.a1")) {
        const settled = copy(host.native.get(ref)!);
        return { ...settled, output: JSON.stringify(settled.structuredOutput) };
      }
      const id = mode === "unrelated run" ? "another-run" : ref;
      const header = mode === "nested exact queued" ? `Nested run: ${id}`
        : `Run: ${mode === "unrelated body run" ? "another-run" : id}`;
      return { ok: true, results: [], output: `Status target: run ${id}\nSpawn budget: unlimited\nActive async capacity: 0/unlimited used\n${header}\n${body}\nMode: single` };
    });
    const output = await host.execute();
    expect(output.status).toBe(active ? "blocked" : "complete");
    expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key.endsWith(".t1.a1"))).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
    if (active) expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.filter(call => call.key.includes(".recover"))).toHaveLength(active ? 0 : 1);
  });

  test.each([["plan", "stopped"], ["writer", "stopped"], ["plan", "interrupted"], ["writer", "interrupted"]])("observed %s recovery %s cancels without replacing work", async (phase, signal) => {
    const host = fixture(undefined, { readOnly: true });
    cutAt(host, value => !!value.loops?.[0]?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    if (phase === "plan") removeCache(host);
    host.setStatus(ref => {
      if (phase === "writer" && !ref.includes(".t1.a1")) {
        const settled = copy(host.native.get(ref)!);
        return { ...settled, output: JSON.stringify(settled.structuredOutput) };
      }
      return { ok: true, results: [] };
    });
    const kind = phase === "plan" ? "loop-plan" : "attempt-result";
    host.setRespond((request, normal) => request.phase === "recovery" && request.task.includes(`\n\nEXCEPTIONAL READ-ONLY ${kind}`)
      ? { ...normal(), ok: false, [signal]: true } : normal());
    expect((await host.execute()).status).toBe("cancelled");
    expect(host.calls.some(call => call.phase === "recovery" && call.task.includes(`\n\nEXCEPTIONAL READ-ONLY ${kind}`))).toBe(true);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
  });

  test.each(["plan", "writer"])("native rejected %s status preserves causal cancellation, not its error wording", async phase => {
    const host = fixture();
    cutAt(host, value => !!value.loops?.[0]?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    if (phase === "plan") removeCache(host);
    host.setStatus(ref => {
      if (phase === "writer" && !ref.includes(".t1.a1")) {
        const settled = copy(host.native.get(ref)!);
        return { ...settled, output: JSON.stringify(settled.structuredOutput) };
      }
      return { ok: false, results: [], output:
        `Status target: run ${ref}\nSpawn budget: unlimited\nActive async capacity: 0/unlimited used\nRun: ${ref}\nState: stopped\nMode: single` };
    });
    const output = await host.executeNative();
    expect(output.status).toBe("cancelled");
    expect(output.reason).toBe("Execution cancelled.");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
  });

  test.each(["stopped", "interrupted", "remembered-stop", "remembered-interruption", "permission"])("exact native status %s is classified without reattachment", async mode => {
    const host = fixture(undefined, { readOnly: true });
    cutAt(host, value => !!value.loops?.[0]?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    host.setStatus(ref => {
      if (!ref.includes(".t1.a1")) {
        const settled = copy(host.native.get(ref)!);
        return { ...settled, output: JSON.stringify(settled.structuredOutput) };
      }
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
      if (!mode.startsWith("remembered")) return { ok: true, [mode]: true, results: [] };
      const state = mode === "remembered-stop" ? "stopped" : "interrupted when Pi exited";
      return { ok: true, results: [], output: `Status target: run ${ref}\nSpawn budget: unlimited\nActive async capacity: 0/unlimited used\nRun: ${ref}\nState: remembered foreground\nMode: single\n1. pitako.worker ${state}, exit 1` };
    });
    const observed = await host.execute();
    const interruption = ["interrupted", "remembered-interruption"].includes(mode);
    expect(observed.status).toBe(mode === "permission" || interruption ? "blocked" : "cancelled");
    if (interruption) expect(observed.reason).toContain("Exact interrupted writer run ID unavailable");
    expect(host.calls.some(call => call.key.endsWith(".resume"))).toBe(false);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  });

  test("model reason cannot impersonate an observed native cancellation", async () => {
    const host = fixture(undefined, { readOnly: true });
    cutAt(host, value => !!value.loops?.[0]?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    host.setStatus(ref => {
      if (!ref.includes(".t1.a1")) {
        const settled = copy(host.native.get(ref)!);
        return { ...settled, output: JSON.stringify(settled.structuredOutput) };
      }
      return { ok: false, results: [], output: "Positive native barrier: stopped (model assertion only)" };
    });
    expect((await host.executeNative()).status).toBe("blocked");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.calls.some(call => call.phase === "recovery" && call.task.includes("\n\nEXCEPTIONAL READ-ONLY attempt-result"))).toBe(true);
    expect(host.calls.find(call => call.phase === "recovery")).toMatchObject({
      label: "Recover implementation result", phase: "recovery",
    });
  });

  test("a formerly active unresolved writer is re-observed, not converted into a historical universal hold", async () => {
    const host = fixture(); cutAt(host, value => !!value.loops?.[0]?.attempt?.launch);
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    host.setStatus(ref => ref.includes(".t1.a1") ? { ok: true, state: "running" } : copy(host.native.get(ref)!));
    expect((await host.execute()).status).toBe("blocked");
    const count = host.calls.filter(call => call.agent === "pitako.worker").length;
    host.setStatus(ref => copy(host.native.get(ref) ?? { ok: true, results: [] }));
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls.filter(call => call.key === "invoke-human-1.l1.t1.a1")).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(count + 1);
  });

  test.each(["same", "changed"])("reused result is phase/candidate aware for %s candidate, not an automatic veto or success", async mode => {
    const host = fixture(); host.setRespond((request, normal) => ({ ...normal(), reused: true }));
    expect((await host.execute()).status).toBe("complete");
    const count = host.calls.length, tokens = (await host.execute()).tokens;
    expect(host.calls).toHaveLength(count);
    if (mode === "changed") {
      host.changeCheckout(); expect((await host.execute()).loopsConsumed).toBe(2);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(2);
    } else expect((await host.execute()).tokens).toEqual(tokens);
  });

  test("replay of already completed review/compliance does not rerun gates or double tokens after a closing persistence cut", async () => {
    const host = fixture(); cutAt(host, value => value.loops?.[0]?.phase === "finished");
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    const count = host.calls.length, tokens = copy(host.current().loops[0].usage);
    expect((await host.execute()).status).toBe("complete"); expect(host.calls).toHaveLength(count);
    expect(host.current().loops[0].usage).toEqual(tokens);
    expect(host.hostCalls.filter(key => key === "inspect-loop-1")).toHaveLength(1);
  });

  test("candidate changed after closing persistence cut invalidates cached gates without a second close in that loop", async () => {
    const host = fixture(); cutAt(host, value => value.loops?.[0]?.phase === "finished");
    expect((await host.execute()).status).toBe("partial"); host.setFailSave(); host.changeCheckout();
    expect((await host.execute()).status).toBe("complete");
    expect(host.current().loops).toHaveLength(2);
    expect(host.hostCalls.filter(key => key === "inspect-loop-1")).toHaveLength(1);
    expect(host.current().loops[0].invalidated).toBe("candidate-changed-after-close");
  });

  test.each(["detached", "recovery"])("positive %s review observation survives the shared library boundary and blocks another writer", async field => {
    const host = fixture(); host.setRespond((request, normal) => request.key.endsWith("director-prepare")
      ? { ...normal(), [field]: true } : normal());
    const output = await host.execute();
    expect(output.status).toBe("blocked"); expect(output.reason).toContain(field);
    expect(host.calls.filter(call => call.key.endsWith(".compliance"))).toHaveLength(0);
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(2);
    expect(host.current().loops).toHaveLength(1);
  });

  test.each(["review", "compliance"])("native child capacity exhausted during %s preserves phase and refs without omitted phases, replacement mission or own budget", async phase => {
    const host = fixture("FULL SPEC", { angles: 4, findings: true });
    host.setRespond((request, normal) => {
      if (phase === "review" ? request.key.includes("critique-") : request.key.endsWith(".compliance"))
        throw Error("Run fan-out limit reached at root (64/64 used; 1 requested, 0 remaining). No children from this admission group were started. Start a new top-level run or raise config.maxSubagentSpawnsPerRun.");
      return normal();
    });
    const output = await host.execute(); expect(output.status).toBe("partial"); expect(output.loopsConsumed).toBe(1);
    expect(output.phase).toBe(phase); expect(output.reason).toContain("Run fan-out limit reached");
    expect(host.current().loops[0].halt.code).toBe("capacity");
    expect(output.loopReport.next).not.toContain("continue loop");
    expect(output.loopReport.verification.checks).toHaveLength(2);
    if (phase === "review") expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
    const count = host.calls.length, halt = copy(host.current().loops[0].halt);
    const replay = await host.execute();
    expect(replay.status).toBe("partial"); expect(replay.reason).toBe(output.reason);
    expect(replay.phase).toBe(phase); expect(replay.loopsConsumed).toBe(1);
    expect(replay.loopReport.halt).toEqual(halt);
    expect(replay.loopReport.pending[0].references).toContainEqual(halt.ref);
    expect(host.current().loops[0].halt).toEqual(halt); expect(host.calls).toHaveLength(count);
    expect(host.calls.every(call => !("maxSubagentSpawnsPerRun" in call))).toBe(true);
  });

  test.each(["director-prepare", "director-synthesis", "compliance"])("semantic %s blocking prose never becomes a native capacity halt", async phase => {
    const reason = "Cannot establish capacity, spawn, budget, timeout or deadline requirements from the spec.";
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(phase)) {
        const value = result.structuredOutput;
        if (phase === "director-synthesis") value.screening = { verdict: "blocked", reason, assessments: [] };
        else Object.assign(value, { status: "blocked", reason });
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status).toBe("blocked"); expect(output.reason).toContain(reason);
    expect(output.loopsConsumed).toBe(1);
    const halt = copy(host.current().loops[0].halt);
    expect(halt.code).toBe("semantic-block");
    const phaseRecord = phase === "compliance" ? host.current().loops[0].compliance : host.current().loops[0].review;
    const retained = JSON.stringify(phaseRecord);
    expect(retained).toContain(`/native/output/invoke-human-1.l1.${phase === "compliance" ? "" : "review."}${phase}.json`);
    const calls = host.calls.length, replay = await host.execute();
    expect(replay.reason).toBe(output.reason); expect(replay.status).toBe("blocked");
    expect(replay.phase).toBe(output.phase); expect(replay.loopsConsumed).toBe(1);
    expect(host.calls).toHaveLength(calls); expect(host.current().loops[0].halt).toEqual(halt);
  });

  test.each(["director", "worker", "review", "compliance"])("returned native capacity receipt at %s retains its actual run reference", async phase => {
    const reason = "Active async run capacity exhausted: 4/4 used.";
    const host = fixture();
    const suffix = phase === "review" ? "review.director-prepare" : phase === "worker" ? "t1.a1" : phase;
    host.setRespond((request, normal) => request.key.endsWith(suffix)
      ? { ...normal(), ok: false, error: reason } : normal());
    const output = await host.execute();
    expect(output.status).toBe("partial"); expect(output.reason).toContain(reason);
    expect(host.current().loops[0].halt).toMatchObject({ code: "capacity", reason,
      ref: { runId: `native-invoke-human-1.l1.${suffix}` } });
    const count = host.calls.length, replay = await host.execute();
    expect(replay.loopReport.halt).toEqual(host.current().loops[0].halt);
    expect(replay.loopReport.pending[0].references).toContainEqual(host.current().loops[0].halt.ref);
    expect(replay.loopsConsumed).toBe(1); expect(host.calls).toHaveLength(count);
  });

  test("native sandbox dispatch retains a thrown capacity receipt without rerunning its halted loop", async () => {
    const host = fixture();
    const reason = "Active async run capacity exhausted: 4/4 used.";
    host.setRespond((request, normal) => {
      if (request.key.endsWith(".compliance")) throw Error(reason);
      return normal();
    });
    const output = await host.executeNative();
    expect(output.status).toBe("partial"); expect(output.reason).toBe(reason);
    expect(host.current().loops[0].halt.code).toBe("capacity");
    const count = host.calls.length;
    expect((await host.executeNative()).reason).toBe(reason); expect(host.calls).toHaveLength(count);
  });

  test.each(["compliance", "director-prepare"])("even an exact capacity receipt quoted by a successful %s is a semantic block", async phase => {
    const reason = "Active async run capacity exhausted: 4/4 used.";
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(phase)) Object.assign(result.structuredOutput, { status: "blocked", reason });
      return result;
    });
    const output = await host.execute();
    expect(output.status).toBe("blocked"); expect(output.reason).toContain(reason);
    expect(host.current().loops[0].halt.code).toBe("semantic-block");
  });

  test.each(["director-prepare", "independent-angle1"])("thrown native permission receipt at %s crosses the shared review boundary as a barrier", async phase => {
    const host = fixture();
    host.setRespond((request, normal) => {
      if (request.key.endsWith(phase)) throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      return normal();
    });
    const output = await host.execute();
    expect(output.status).toBe("blocked");
    expect(host.current().loops[0].halt).toMatchObject({ code: "native-barrier", cause: "native permission denial" });
    expect(host.calls.some(call => call.key.endsWith(".compliance"))).toBe(false);
  });

  test("arbitrary native exception words are incomplete dispatch evidence, not a capacity certificate", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      if (request.key.endsWith(".compliance")) throw Error("Investigate timeout, capacity, spawn and budget diagnostics");
      return normal();
    });
    const output = await host.execute();
    expect(output.status).toBe("partial");
    expect(host.current().loops[0].halt.code).toBe("native-dispatch");
    const count = host.calls.length;
    expect((await host.execute()).reason).toBe(output.reason); expect(host.calls).toHaveLength(count);
  });

  test.each(["worker-stop", "review-stop", "permission", "timeout"])("native %s is not green or an inferred invocation timeout cancellation", async mode => {
    const host = fixture(undefined, { readOnly: true }); host.setRespond((request, normal) => {
      if (mode === "review-stop" && request.key.endsWith("director-prepare")) return { ...normal(), ok: false, stopped: true, error: "Observed Stop" };
      if (request.agent === "pitako.worker" && request.key.includes(".l1.")) {
        if (mode === "worker-stop") return { ...normal(), ok: false, stopped: true };
        if (mode === "permission") return { ...normal(), ok: false, error: "Blocked by pi-subagents permission rule: 'run' is denied." };
        if (mode === "timeout") return { ...normal(), ok: false, terminalOutcome: { state: "partial", reason: "timeout" }, error: "Native deadline" };
      } return normal();
    });
    const output = await host.execute();
    expect(output.status).toBe(mode.endsWith("stop") ? "cancelled" : mode === "timeout" ? "complete" : "blocked");
    if (mode === "timeout") expect(output.loopsConsumed).toBe(2);
    else expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(1);
  });

  test("full-file native 256 KiB envelope includes other keys, maximum multibyte/escaped spec, long metadata, huge allowed reports and three slots", async () => {
    const unit = '\\"é界';
    const content = unit.repeat(Math.floor(MAX_SPEC_BYTES / Buffer.byteLength(unit))) + "x".repeat(MAX_SPEC_BYTES % Buffer.byteLength(unit));
    expect(Buffer.byteLength(content)).toBe(39936);
    const host = fixture(content, { metadataPadding: 7000, angles: 4, findings: true });
    host.storage.set("other-owned-history", { content: "h".repeat(90000) });
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key.endsWith(".director")) result.structuredOutput.sharedContext.material = "context".repeat(25000);
      if (request.agent === "pitako.worker") {
        result.structuredOutput.workDone = "w".repeat(300000); result.structuredOutput.diagnosis = "d".repeat(300000);
        result.structuredOutput.checks[0].output = "o".repeat(300000);
      }
      return request.key.endsWith(".compliance") ? gaps(result) : result;
    });
    const output = await host.execute(); expect(output).toMatchObject({ status: "partial", loopsConsumed: 3 });
    expect(host.optionalCacheFailures()).toBeGreaterThan(0);
    const serialized = JSON.stringify(Object.fromEntries(host.storage), null, 2);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MISSION_STATE_MAX_BYTES);
    expect(serialized).not.toContain("w".repeat(1000)); expect(serialized).not.toContain("d".repeat(1000)); expect(serialized).not.toContain("o".repeat(1000));
    expect(host.current().snapshot.content).toBe(content); expect(host.storage.get("other-owned-history").content).toHaveLength(90000);
    expect(host.hostCalls).toHaveLength(31); expect(host.hostCalls.filter(key => key.startsWith("input-"))).toHaveLength(26);
    expect(host.current().loops.map((loop: any) => loop.number)).toEqual([1, 2, 3]);
  });

  test.each(["before-director", "before-worker", "after-result"])("essential state failure %s halts new dispatch and retains frozen snapshot/descriptor/history", async phase => {
    const host = fixture(); host.storage.set("history", { retained: true });
    cutAt(host, value => phase === "before-director" ? value.loops?.length === 1 : phase === "before-worker"
      ? value.loops?.[0]?.attempt?.stage === "intention" : value.loops?.[0]?.attempt?.stage === "result");
    const output = await host.execute(); expect(output.status).toBe("partial"); expect(output.reason).toContain("Essential persistence failed");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(phase === "after-result" ? 1 : 0);
    expect(host.current().snapshot.content).toBe("COMPLETE IMMUTABLE SPECS"); expect(host.storage.get("history")).toEqual({ retained: true });
    if (phase === "after-result") expect(host.current().loops[0].attempt).toMatchObject({
      taskId: "change1", index: 0, number: 1, stage: "launched",
      launch: { key: "invoke-human-1.l1.t1.a1", runId: "native-invoke-human-1.l1.t1.a1" },
    });
  });

  test("native envelope overflow in essential snapshot does not dispatch or prune unrelated state", async () => {
    const host = fixture("s".repeat(MAX_SPEC_BYTES)); host.storage.set("unrelated", { bytes: "h".repeat(230000) });
    const before = copy(host.storage.get("unrelated"));
    expect((await host.execute()).reason).toContain("Essential persistence failed"); expect(host.calls).toHaveLength(0);
    expect(host.storage.get("unrelated")).toEqual(before);
  });

  test("semantic progress preserves original elapsed waits and attributable token dedup, with missing metrics unavailable not zero", async () => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal(); if (request.key.endsWith(".director")) host.advance(5000);
      if (request.agent === "pitako.worker") delete result.results; return result;
    });
    const output = await host.execute(); expect(output.elapsedMs).toBeGreaterThanOrEqual(5000);
    expect(output.tokens.coverage).toBe("partial"); expect(output.tokens.value).toBeGreaterThan(0);
    const progress = host.emits.filter(value => value.type === "execution-progress");
    expect(progress[0]).toMatchObject({ invocation: "human-1", loop: 1, loopsConsumed: 1, phase: "director", tokens: { value: null, coverage: "unavailable" } });
    expect(progress.find(value => value.phase === "implementation")).toMatchObject({ taskId: "change1", attempt: 1 });
    const before = copy(output.tokens); host.advance(10000);
    const replay = await host.execute(); expect(replay.tokens).toEqual(before); expect(replay.elapsedMs).toBe(output.elapsedMs + 10000);
    expect(replay.loopReport.elapsedMs).toBe(output.loopReport.elapsedMs);
  });

  test("needs-decision reports concrete question, unrun analyses and no continuation announcement", async () => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal(); if (request.key.endsWith(".director")) Object.assign(result.structuredOutput, { status: "needs-decision", reason: "Which of the two conflicting public API requirements is authorized?", tasks: [] });
      return result;
    });
    const output = await host.execute(); expect(output.status).toBe("blocked"); expect(output.actionRequired).toContain("Which");
    expect(output.loopReport.verification.adversarial.status).toBe("not-run"); expect(output.loopReport.next).not.toContain("continue");
    expect(host.calls).toHaveLength(1);
  });

  test.each(["old-state", "unblock", "mission-path", "source-drift", "different-invocation"])("rejects %s without historical rewrites or slot renewal", async mode => {
    const host = fixture(); let before: any;
    if (mode === "old-state") host.storage.set("pitako-execution", { unsettled: { invocation: "old" }, root: config.root });
    if (["mission-path", "source-drift", "different-invocation"].includes(mode)) expect((await host.execute()).status).toBe("complete");
    before = copy(Object.fromEntries(host.storage)); const count = host.calls.length;
    if (mode === "source-drift") host.setHostResponse((_key, value) => ({ ...value, selected: { ...value.selected, digest: "changed" } }));
    const output = await host.execute(mode === "unblock" ? { unblock: true } : mode === "mission-path" ? { missionPath: "/guessed/path" } : mode === "different-invocation" ? { invocation: "new-ID" } : {});
    expect(output.status).toBe("blocked"); expect(host.calls).toHaveLength(count); expect(Object.fromEntries(host.storage)).toEqual(before);
  });
});


describe("bounded read-only native interrupted-attempt continuation", () => {
  // Read-only attempts have no modifying checkpoint to restore. Their exact
  // native continuation must remain finite; modifying A1 units instead exercise
  // checkpoint-first restoration in the registered real-file composition.
  test("public resume admits the actual same-attempt result and reaches final verification and compliance", async () => {
    const fx = fixture(undefined, { readOnly: true });
    fx.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return {
        ...normal(), ok: false, structuredOutput: undefined, state: "interrupted",
        results: [], // no historical terminal receipt is required for native eligibility
      };
      if (request.key.endsWith(".resume")) {
        expect(request.agent).toBeUndefined();
        expect(request.context).toBeUndefined();
        expect(request.resume).toBe("native-invoke-human-1.l1.t1.a1");
        expect(fx.current().loops[0].attempt.nativeContinuation.stage).toBe("intention");
        return fx.result({ ...request, agent: "pitako.worker" }, fx.worker(request));
      }
      return normal();
    });
    const result = await fx.executeNative();
    expect(result.status).toBe("complete");
    expect(result.loopsConsumed).toBe(1);
    expect(fx.calls.filter(call => call.key.endsWith(".resume"))).toHaveLength(1);
    expect(fx.calls.filter(call => call.key.endsWith(".t1.a1"))).toHaveLength(1);
    expect(fx.calls.some(call => call.key.endsWith(".t2.a1"))).toBe(true);
    expect(fx.calls.some(call => call.key.endsWith(".compliance"))).toBe(true);
    expect(fx.current().loops[0].results[0].ref.resumedFrom.runId).toBe("native-invoke-human-1.l1.t1.a1");
  });

  test.each(["before-result-save", "after-result-save"])("reconciles %s without another resume or repeated admitted task", async cut => {
    const fx = fixture(undefined, { readOnly: true });
    let resumeCalls = 0, cutting = true;
    fx.setFailSave(value => cutting && value.loops?.[0]?.attempt?.nativeContinuation?.stage === "receipt" &&
      (cut === "before-result-save" || value.loops[0].attempt.stage === "result"));
    fx.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return { ...normal(), ok: false, state: "interrupted", structuredOutput: undefined, results: [] };
      if (request.key.endsWith(".resume")) {
        resumeCalls++;
        return fx.result({ ...request, agent: "pitako.worker" }, fx.worker(request));
      }
      return normal();
    });
    expect((await fx.executeNative()).status).not.toBe("complete");
    cutting = false;
    const resumed = await fx.executeNative();
    expect(resumed.status).toBe("complete");
    expect(resumeCalls).toBe(1);
    expect(fx.calls.filter(call => call.key.endsWith(".t1.a1"))).toHaveLength(1);
    expect(fx.current().loops).toHaveLength(1);
  });

  test("a pending resume intention is observed, never replaced by another key", async () => {
    const fx = fixture(undefined, { readOnly: true });
    fx.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return { ...normal(), ok: false, state: "interrupted", structuredOutput: undefined, results: [] };
      if (request.key.endsWith(".resume")) throw Error("Controlled transport loss after resume launch");
      return normal();
    });
    await fx.executeNative();
    fx.setStatus(ref => ref.endsWith(".resume") ? { ok: true, state: "running", runId: "pending-successor" } :
      copy(fx.native.get(ref) ?? { ok: true, results: [] }));
    const callCount = fx.calls.length;
    const result = await fx.executeNative();
    expect(result.status).not.toBe("complete");
    expect(fx.calls).toHaveLength(callCount);
    expect(fx.calls.filter(call => call.key.endsWith(".resume"))).toHaveLength(1);
  });

  test("a previously pending successor is admitted when its exact result settles", async () => {
    const fx = fixture(undefined, { readOnly: true });
    let successor: Result | undefined;
    fx.setRespond((request, normal) => {
      if (request.key.endsWith(".t1.a1")) return { ...normal(), ok: false, state: "interrupted", structuredOutput: undefined, results: [] };
      if (request.key.endsWith(".resume")) {
        successor = fx.result({ ...request, agent: "pitako.worker" }, fx.worker(request));
        throw Error("Controlled transport loss after accepted resume");
      }
      return normal();
    });
    await fx.executeNative();
    fx.setStatus(ref => ref.endsWith(".resume") ? { ok: true, state: "running", runId: "pending-successor" } :
      copy(fx.native.get(ref) ?? { ok: true, results: [] }));
    expect((await fx.executeNative()).status).not.toBe("complete");
    fx.setStatus(ref => ref.endsWith(".resume") ? copy(successor!) :
      copy(fx.native.get(ref) ?? { ok: true, results: [] }));
    expect((await fx.executeNative()).status).toBe("complete");
    expect(fx.calls.filter(call => call.key.endsWith(".resume"))).toHaveLength(1);
    expect(fx.current().loops).toHaveLength(1);
  });

  test.each(["stopped", "running", "rejected"])("positive %s remains a barrier, not native interruption recovery", async state => {
    const fx = fixture(undefined, { readOnly: true });
    fx.setRespond((request, normal) => request.key.endsWith(".t1.a1") ?
      { ...normal(), ok: false, state, structuredOutput: undefined, results: [] } : normal());
    const result = await fx.executeNative();
    expect(result.status).not.toBe("complete");
    expect(fx.calls.some(call => call.key.endsWith(".resume"))).toBe(false);
    expect(fx.calls.some(call => call.key.endsWith(".t2.a1"))).toBe(false);
  });
});
