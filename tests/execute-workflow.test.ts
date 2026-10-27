import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { digest, inspectionSnapshot, MAX_SPEC_BYTES, specChunks } from "../extensions/spec-plans.ts";
import { MISSION_STATE_MAX_BYTES } from "../node_modules/pi-subagents/src/missions/workflow-state.js";
import { runWorkflowScript, validateWorkflowScript, type WorkflowScriptChildResult } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";

const executeSource = readFileSync(new URL("../skills/execute/workflow.js", import.meta.url), "utf8");
const reviewSource = readFileSync(new URL("../skills/review/workflow.js", import.meta.url), "utf8");
const source = `const pitakoReviewLibraryMode = true;\n${reviewSource}\n${executeSource}`;
const config = {
  root: "/owned/designated", id: "spec", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/exact-mission",
  inspections: ["initial", "loop-1", "loop-2", "loop-3", "loop-4"].map(phase => ({ key: `inspect-${phase}`, command: "READ" })),
  settings: { key: "execute-settings", command: "SETTINGS" }, sourceRefs: [],
  chunks: Array.from({ length: 26 }, (_, index) => ({ key: `input-${index}`, command: "CHUNK" })),
};
type Candidate = { head: string; fingerprint: string };
type Request = { key: string; agent?: string; resume?: string; context?: string; cwd?: string; task: string;
  output?: string | boolean; outputSchema?: any; timeoutMs?: number; reads?: boolean; progress?: boolean; acceptance?: any; async?: boolean };
type Result = Omit<Partial<WorkflowScriptChildResult>, "state"> & { ok: boolean; state?: string; structuredOutput?: any; [key: string]: any };
type Outcome = { status: string; reason: string; loopsConsumed: number; loopReport: any; tokens: any; elapsedMs: number; [key: string]: any };
const copy = <T>(value: T): T => structuredClone(value);
const candidate = (version = 0): Candidate => ({ head: "a".repeat(40), fingerprint: String(version).padStart(64, "0") });
const task = (id: string, kind = "implementation") => ({ id, kind, goal: `Goal ${id}`, contextRefs: ["shared"], sourceRefs: ["spec:criterion-1"],
  scope: [`src/${id}.ts`], allowedEffects: kind === "verification" ? ["read/check"] : ["edit assigned path"], expectedResult: `Result ${id}`,
  checks: [{ id: `${id}-check`, requirement: "spec:criterion-1", command: `bun test ${id}`, cwd: config.root }] });
function fixture(content = "COMPLETE IMMUTABLE SPECS", options: { metadataPadding?: number; taskCount?: number; angles?: number; findings?: boolean } = {}) {
  let checkout = candidate(), clock = 1000;
  const calls: Request[] = [], hostCalls: string[] = [], statusCalls: string[] = [], emits: any[] = [];
  const storage = new Map<string, any>(), native = new Map<string, Result>();
  const snapshots: any[] = [];
  const chunks = specChunks(content);
  const selected = { source: "/owned/sibling/" + "s".repeat(options.metadataPadding ?? 0) + "/.pitako/plans/spec.md", digest: digest(content), chunks: chunks.length };
  const metadata = { root: config.root, commonDir: "/owned/common", selected, candidates: [] };
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
    tasks: [...Array.from({ length: options.taskCount ?? 1 }, (_, index) => task(`change${index + 1}`)), task("final", "verification")] });
  const worker = (request: Request) => {
    const descriptor = JSON.parse(request.task.split("FROZEN ATTEMPT:\n")[1]!.split("\nORIGINAL COMPLETE PLAN")[0]!);
    const selectedTask = JSON.parse(request.task.split("COMPLETE SELECTED TASK:\n")[1]!.split("\nFROZEN ATTEMPT")[0]!);
    return { taskId: descriptor.taskId, attempt: descriptor.number, status: "complete", workDone: `Implemented ${selectedTask.goal}`,
      remaining: [], diagnosis: "No pending defects after required checks", usefulProgress: true, continuation: null,
      git: { head: checkout.head, checkpoints: [], wip: "Assigned changes remain uncommitted" }, candidate: copy(checkout),
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
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const controlledDate = { now: () => clock };
  return { calls, hostCalls, statusCalls, emits, storage, snapshots, native, plan, worker, result, state,
    setLimit: (value: number) => { admittedLimit = value; },
    optionalCacheFailures: () => optionalCacheFailures,
    setRespond: (value?: typeof responder) => { responder = value; }, setStatus: (value: typeof status) => { status = value; },
    setHostResponse: (value?: typeof hostResponse) => { hostResponse = value; }, setFailSave: (value?: typeof failSave) => { failSave = value; },
    changeCheckout: (version = 1) => { checkout = candidate(version); }, advance: (ms: number) => { clock += ms; },
    current: () => storage.get("invoke-human-1"),
    execute: (override = {}): Promise<Outcome> => new AsyncFunction("config", "runs", "state", "emit", "Date", source)({ ...config, ...override }, runs, state, (value: any) => emits.push(copy(value)), controlledDate),
    executeNative: async (): Promise<Outcome> => {
      const observed = await runWorkflowScript({ script: `const config = ${JSON.stringify(config)};\n${source}`, state,
        launch: async (key, params) => ({ key, artifactPaths: [], ...(await runs.all([{ ...params, key } as Request]))[0] } as WorkflowScriptChildResult),
        status: async ref => ({ key: ref, output: "", artifactPaths: [], ...await runs.status(ref) } as WorkflowScriptChildResult),
        host: async (key, params) => ({ ...await runs.host(key, params), key, kind: "command", state: "passed", exitCode: 0, stderr: "", durationMs: 0 }),
        onEmit: values => { emits.splice(0, emits.length, ...values); },
      });
      return observed.value as Outcome;
    },
  };
}
function gaps(result: Result) {
  const value = copy(result); value.structuredOutput.status = "gaps";
  value.structuredOutput.reason = "Concrete full-spec gap at src/missing.ts:1";
  value.structuredOutput.requirements[0].status = "gap"; return value;
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
    expect(director.agent).toBe("pitako.execution-director"); expect(director.task).toContain("then END");
    expect(director.outputSchema.properties.status.enum).toEqual(["plan", "needs-decision"]);
    expect(host.snapshots.some(value => value.loops?.[0]?.plan?.stage === "intention")).toBe(true);
    const workers = host.calls.filter(call => call.agent === "pitako.worker"); expect(workers).toHaveLength(2);
    for (const worker of workers) {
      expect(worker).toMatchObject({ context: "fresh", cwd: config.root, timeoutMs: 14400000, reads: false, progress: false, acceptance: { level: "none" } });
      expect(worker.acceptance.reason).toContain("root owns"); expect(worker.async).toBeUndefined();
      expect(worker.task).toContain("ALL COMPLETE SPEC SECTIONS"); expect(worker.task).toContain("FULL SHARED CONTEXT");
      expect(worker.task).toContain("No delegation, next-task selection, private diary");
    }
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.calls.filter(call => call.key.endsWith(".compliance"))).toHaveLength(1);
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

  test.each(["wrong-command", "wrong-cwd", "stale-check", "no-diagnosis", "pending-complete"])("worker %s cannot satisfy current mandatory checks", async mode => {
    const host = fixture(); host.setRespond((request, normal) => {
      const result = normal(); if (request.agent === "pitako.worker") {
        const value = result.structuredOutput;
        if (mode === "wrong-command") value.checks[0].command = "echo green";
        if (mode === "wrong-cwd") value.checks[0].cwd = "/other";
        if (mode === "stale-check") value.checks[0].after = candidate(2);
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
        host.changeCheckout(version); return { ...value, checkout: candidate(version) };
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
      host.changeCheckout(version); return { ...value, checkout: candidate(version) };
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
        next: "restore essential persistence and resume this invocation" });
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
      if (key === "inspect-loop-1") { host.changeCheckout(); return { ...value, checkout: candidate(1) }; } return value;
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
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector").length).toBeGreaterThan(0);
  });

  test.each(["direct-values", "direct-conflict", "absent-binding", "absent-witness", "cache-only", "lost-definition", "changed-binding", "changed-native", "changed-order"])("recovery distinguishes %s using full originals and exact refs", async mode => {
    const host = fixture();
    cutAt(host, value => value.loops?.[0]?.attempt?.stage === "intention");
    expect((await host.execute()).status).toBe("partial"); host.setFailSave();
    // The attempt intention was never persisted: no writer launch ambiguity here.
    if (mode !== "cache-only") removeCache(host);
    if (mode === "lost-definition" || mode === "cache-only") {
      host.native.delete("native-invoke-human-1.l1.director"); host.native.delete("invoke-human-1.l1.director");
    }
    if (mode === "absent-witness") for (const value of host.native.values()) delete value.results;
    if (mode.startsWith("direct-")) for (const value of host.native.values()) {
      const binding = copy(value.structuredOutput);
      if (mode === "direct-conflict") binding.tasks[0].scope = ["conflicting-native-binding"];
      value.output = JSON.stringify(binding);
    }
    host.setRespond((request, normal) => {
      const result = normal(); if (request.key.includes(".recover")) {
        const value = result.structuredOutput;
        if (mode === "absent-binding") Object.assign(value, { binding: "absent", comparison: "only-original" });
        if (mode === "changed-binding") Object.assign(value, { status: "conflict", binding: "changed", comparison: "different-full-json" });
        if (mode === "changed-native" && value.original) value.original.tasks[0].scope = ["changed-but-same-id"];
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
    const host = fixture();
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
    const host = fixture();
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
    const host = fixture();
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
    host.setRespond((request, normal) => request.task.startsWith(`EXCEPTIONAL READ-ONLY ${kind}`)
      ? { ...normal(), ok: false, [signal]: true } : normal());
    expect((await host.execute()).status).toBe("cancelled");
    expect(host.calls.some(call => call.task.startsWith(`EXCEPTIONAL READ-ONLY ${kind}`))).toBe(true);
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
    const host = fixture();
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
    expect((await host.execute()).status).toBe(mode === "permission" ? "blocked" : "cancelled");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  });

  test("model reason cannot impersonate an observed native cancellation", async () => {
    const host = fixture();
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
    expect(host.calls.some(call => call.task.startsWith("EXCEPTIONAL READ-ONLY attempt-result"))).toBe(true);
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
    const host = fixture(); host.setRespond((request, normal) => {
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
    if (phase === "after-result") expect(host.current().loops[0].attempt).toMatchObject({ taskId: "change1", index: 0, number: 1, stage: "intention" });
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
