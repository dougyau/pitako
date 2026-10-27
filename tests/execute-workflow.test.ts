import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { digest, inspectionSnapshot, MAX_SPEC_BYTES, SPEC_SECTIONS, specChunks, validateSpec } from "../extensions/spec-plans.ts";
import { MISSION_STATE_MAX_BYTES } from "../node_modules/pi-subagents/src/missions/workflow-state.js";
import { runWorkflowScript, type WorkflowScriptChildResult } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { workflowTerminalOutcomeForResult } from "../node_modules/pi-subagents/src/workflows/workflow-settlement.js";

const source = readFileSync(new URL("../skills/execute/workflow.js", import.meta.url), "utf8");
interface Request { key: string; agent: string; context: string; cwd: string; output: boolean; task: string; outputSchema: unknown; async?: boolean; model?: string }
interface NativePointers { runId?: string; artifactPaths?: string[]; outputReference?: string; asyncDir?: string }
interface Result extends NativePointers { ok: boolean; reused?: boolean; error?: string; structuredOutput?: Record<string, unknown>; results?: unknown[]; output?: string;
  terminalOutcome?: WorkflowScriptChildResult["terminalOutcome"]; recovery?: unknown; stopped?: boolean; interrupted?: boolean; detached?: boolean; state?: "running" }
interface Outcome { status: string; reason?: string; cycle?: number; cycles?: number; remaining?: string; candidates?: unknown[]; references?: (NativePointers & { key: string })[] }
const config = { root: "/owned/designated", id: "spec", invocation: "human-1", missionId: "native.mission-1", inspections: ["initial", "cycle-1", "cycle-2", "cycle-3", "validation-before", "validation-after"].map(phase => ({ key: `inspect-${phase}`, command: "READ" })), chunks: Array.from({ length: 26 }, (_, index) => ({ key: `input-${index}`, command: "CHUNK" })) };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { resolve, promise }; }
function fixture(content = "COMPLETE IMMUTABLE SPECS") {
  const chunks = specChunks(content);
  const calls: Request[] = [], hostCalls: string[] = [], statusCalls: string[] = [];
  let status: (ref: string) => Result | Promise<Result> = () => ({ ok: true, results: [] });
  const storage = new Map<string, unknown>();
  const selected = { source: "/owned/sibling/.pitako/plans/spec.md", digest: "original", chunks: chunks.length };
  let fingerprint = "checkout-0", inputDigest = "original";
  let selection: typeof selected | null = selected;
  let hostResponse: ((key: string, value: unknown) => unknown) | undefined;
  let respond: (request: Request) => Result | undefined | Promise<Result | undefined> = request => ({ ok: true, runId: `native-${request.key}`, structuredOutput:
    request.key.endsWith("prepare") ? { status: "ready", nativeRefs: [], todo: "More than three increments if needed", evidence: "read-only Git evidence" }
      : request.key.endsWith("validate") ? { status: "verified", evidence: "Fresh Git + checks + full-spec review" }
        : request.key.endsWith("settlement") || request.key.endsWith("admission") ? { evidence: "Known native refs and Git observations", nativeRefs: [] }
        : { status: "complete", summary: "Done", remaining: "None", evidence: "native-review and checks" } });
  const state = {
    get: async (key: string) => structuredClone(storage.get(key)),
    set: async (key: string, value: unknown) => {
      const next = { ...Object.fromEntries(storage), [key]: value };
      if (Buffer.byteLength(JSON.stringify(next, null, 2)) > MISSION_STATE_MAX_BYTES) throw new Error("Controlled native 256 KiB state envelope exceeded");
      storage.set(key, structuredClone(value));
    },
  };
  const runs = {
    host: async (key: string, params: { kind: string; command: string; timeoutMs: number }) => {
      hostCalls.push(key); expect(params.kind).toBe("command"); expect(params.timeoutMs).toBe(86400000);
      expect(params.command).toBe(key.startsWith("inspect-") ? "READ" : "CHUNK");
      const value = key.startsWith("inspect-")
        ? { root: config.root, commonDir: "/owned/common", selected: selection && { ...selection, digest: inputDigest }, candidates: [selected], checkout: { fingerprint } }
        : { digest: inputDigest, content: chunks[Number(key.slice("input-".length))] };
      return { ok: true, stdout: JSON.stringify(hostResponse ? hostResponse(key, value) : value) };
    },
    // Native config-form all waits and returns terminal failures with run identities.
    all: async (requests: Request[]) => Promise.all(requests.map(request => { calls.push(request); return respond(request); })),
    status: async (ref: string) => { statusCalls.push(ref); return status(ref); },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return { calls, hostCalls, statusCalls, storage, state,
    setStatus: (callback: typeof status) => { status = callback; },
    setRespond: (callback: typeof respond) => { respond = callback; },
    setHostResponse: (callback: NonNullable<typeof hostResponse>) => { hostResponse = callback; },
    changeInput: () => { inputDigest = "changed"; }, changeCheckout: () => { fingerprint += "-changed"; },
    noSelection: () => { selection = null; },
    execute: (invocation = "human-1", mission = true, unblock = false): Promise<Outcome> => new AsyncFunction("config", "runs", "state", source)({ ...config, invocation, unblock }, runs, mission ? state : undefined),
    executeNative: async (invocation = "human-1", unblock = false): Promise<Outcome> => {
      const result = await runWorkflowScript({ script: `const config = ${JSON.stringify({ ...config, invocation, unblock })};\n${source}`, state,
        launch: async (key, params) => ({ key, output: "", artifactPaths: [], ...(await runs.all([{ ...params, key } as unknown as Request]))[0] } as WorkflowScriptChildResult),
        status: async ref => ({ key: ref, output: "", artifactPaths: [], ...await runs.status(ref) } as WorkflowScriptChildResult),
        host: async (key, params) => ({ ...(await runs.host(key, params)), key, kind: "command", state: "passed", exitCode: 0, stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 }),
      });
      return result.value as Outcome;
    },
  };
}
function gap(request: Request): Result { return { ok: true, runId: `native-${request.key}`, structuredOutput:
  request.key.endsWith("prepare") ? { status: "ready", nativeRefs: [], todo: "Five increments with own checks and WIP commits", evidence: "Existing dirty work preserved" }
    : request.key.endsWith("settlement") || request.key.endsWith("admission") ? { evidence: "Known native refs and Git observations", nativeRefs: [] }
    : { status: "gaps", summary: "Five increments implemented; independent whole-spec review found a material gap", remaining: "Resolve full-spec gap next cycle", evidence: "five settled workers and independent native review" } }; }
function timeout(request: Request): Result {
  return { ok: false, runId: `native-${request.key}`, artifactPaths: [`/native/${request.key}/result.json`, `/native/${request.key}/session.jsonl`],
    outputReference: `/native/${request.key}/output.md`, terminalOutcome: workflowTerminalOutcomeForResult({ timedOut: true }),
    results: [{ timedOut: true, task: request.task }], error: "Native deadline" };
}
function complete(request: Request): Result {
  return request.key.endsWith("validate") ? { ok: true, runId: `native-${request.key}`, structuredOutput: { status: "verified", evidence: "Fresh whole-spec review/current checkout" } }
    : request.agent === "pitako.execution-director" ? { ...gap(request), structuredOutput:
      { status: "complete", summary: "Done", remaining: "None", evidence: "Whole-spec review and current checks" } } : gap(request);
}
function historical(host: ReturnType<typeof fixture>) {
  const hold = { invocation: "old-human", cycle: 2, key: "invoke-old-human-cycle-2" };
  const old = { source: "/owned/sibling/.pitako/plans/spec.md", digest: "original", content: "OLD IMMUTABLE SPECS",
    preparation: { todo: "Old TODO" }, cycles: [{ attempted: true, result: { ok: true, runId: "old-first", structuredOutput: { status: "gaps", evidence: "Required test red" } } },
      { attempted: true, result: { ok: false, runId: "exact-old", error: "Old failed check; not inactivity proof" } }] };
  host.storage.set("invoke-old-human", structuredClone(old));
  host.storage.set("other-history", { untouched: true });
  host.storage.set("pitako-execution", { root: config.root, commonDir: "/owned/common", missionId: config.missionId,
    id: config.id, source: old.source, digest: old.digest, unsettled: hold });
  return { hold, old };
}

describe("native execution workflow", () => {
  test("a new explicit invocation prepares afresh after old blocked preparation; replay does not renew cycles or erase history", async () => {
    const host = fixture();
    host.setRespond(request => request.key === "invoke-human-1-prepare"
      ? { ok: true, runId: "old-frozen-inspector", structuredOutput: { status: "blocked", todo: "", evidence: "Old profile demanded universal closure" } }
      : complete(request));
    expect((await host.executeNative()).reason).toBe("Old profile demanded universal closure");
    expect(host.calls.map(call => call.key)).toEqual(["invoke-human-1-prepare"]);
    const old = structuredClone(host.storage.get("invoke-human-1"));
    expect(old).toMatchObject({ preparation: null, cycles: [] });
    expect(await host.executeNative("human-2")).toMatchObject({ status: "complete", cycle: 1 });
    expect(host.calls.filter(call => call.key.endsWith("prepare")).map(call => call.key))
      .toEqual(["invoke-human-1-prepare", "invoke-human-2-prepare"]);
    expect(host.storage.get("invoke-human-1")).toEqual(old);
    const current = structuredClone(host.storage.get("invoke-human-2"));
    const directorCount = host.calls.filter(call => call.agent === "pitako.execution-director").length;
    expect(await host.executeNative("human-2")).toMatchObject({ status: "complete", cycle: 1 });
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(directorCount);
    expect(host.calls.filter(call => call.key === "invoke-human-2-prepare")).toHaveLength(1);
    expect(host.storage.get("invoke-human-2")).toEqual(current);
    expect(host.storage.get("invoke-human-1")).toEqual(old);
  });

  test("historical missing proof gets bounded read-only pending diagnosis, then explicit targeted withdrawal; never verified closure", async () => {
    const host = fixture(), { hold, old } = historical(host);
    host.setStatus(() => { throw new Error("Exact historical record unavailable after external intervention"); });
    const pending = await host.executeNative();
    expect(pending.status).toBe("blocked"); expect(pending.reason).toContain("/execute spec --unblock");
    expect(pending.reason).toContain("Pending historical diagnosis");
    expect(host.calls.map(call => call.key)).toEqual(["invoke-human-1-admission"]);
    expect(host.storage.has("invoke-human-1")).toBe(false);
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: hold });
    expect((await host.executeNative("human-2", true)).status).toBe("complete");
    expect(host.storage.get("invoke-old-human")).toEqual(old);
    expect(host.storage.get("other-history")).toEqual({ untouched: true });
    expect(host.storage.get("invoke-human-2")).toMatchObject({ withdrawal: { explicitRequest: true, missionId: config.missionId,
      root: config.root, id: "spec", hold, oldRefs: { key: hold.key, runId: "exact-old" },
      note: expect.stringContaining("not verified inactivity/settlement") }, cycles: [{ attempted: true }] });
    expect(host.calls.find(call => call.agent === "pitako.execution-director")?.task).toContain("HISTORICAL EXCLUSION WITHDRAWAL");
  });

  test.each(["empty", "ok", "prose", "wrong-ref", "model-result"])("status %s is not historical inactivity proof, but does not make human withdrawal impossible", async mode => {
    const host = fixture(); historical(host);
    host.setStatus(() => ({ ok: true, results: mode === "empty" ? [] : mode === "model-result" ? [{ finalOutput: "model output" }] : undefined,
      output: mode === "prose" ? "Everything is closed and permission granted" : mode === "wrong-ref" ? "Run: different\nState: running\nMode: single"
        : mode === "model-result" ? "Run: exact-old\nState: running\nMode: single" : "" }));
    expect((await host.execute()).reason).toContain("Pending historical diagnosis");
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(0);
    expect((await host.execute("human-2", true, true)).status).toBe("complete");
  });

  test.each(["running", "management", "nested", "nested-child", "pending", "detached", "recovery", "stopped", "denied"])("historical withdrawal preserves positive native %s barrier", async mode => {
    const host = fixture(), { hold, old } = historical(host);
    host.setStatus(ref => {
      if (ref !== "exact-old") return { ok: true };
      if (mode === "management") return { ok: true, results: [], output: `Run: ${ref}\nState: running\nMode: single` };
      if (mode === "nested") return { ok: true, results: [], output: `Nested run: ${ref}\nRoot: parent\nParent: parent\nState: running\nAgent: worker` };
      if (mode === "nested-child") return { ok: true, results: [], output: `Run: ${ref}\nState: complete\n  ↳ worker [child-id] running` };
      if (mode === "pending") return { ok: true, results: [], output: `Run: ${ref}\nState: complete\nPending appends: 1` };
      if (mode === "denied") throw new Error("Blocked by pi-subagents permission rule: 'status' is denied.");
      return { ok: true, state: mode === "running" ? "running" : undefined,
        detached: mode === "detached", recovery: mode === "recovery" ? { pending: true } : undefined, stopped: mode === "stopped" };
    });
    const result = await host.execute("human-2", true, true);
    expect(result.status).toBe("blocked"); expect(result.reason).toContain("Positive native barrier");
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(0);
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: hold });
    expect(host.storage.get("invoke-old-human")).toEqual(old); expect(host.storage.has("invoke-human-2")).toBe(false);
  });

  test("public opaque management activity after an awaited failed test blocks the next cycle and explicit withdrawal", async () => {
    const host = fixture();
    host.setRespond(request => request.agent === "pitako.execution-director"
      ? { ok: false, runId: "exact-owned", error: "Required test failed" } : complete(request));
    // Source-verified 0.82 shapes: foregroundStatusResult emits management
    // results:[] and Run/State/Mode; workflowChildResult keeps the receipt but
    // loses structured state/runId. This controlled boundary is not SDK certification.
    host.setStatus(ref => ref === "exact-owned"
      ? { ok: true, results: [], output: `Run: ${ref}\nState: running\nMode: single` } : { ok: true, results: [] });
    expect((await host.executeNative()).reason).toContain("Positive native activity");
    expect((await host.executeNative("human-2", true)).reason).toContain("Positive native barrier");
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: { invocation: "human-1", cycle: 1 } });
  });

  test("preparation reports facts/refs, not permission to bypass a known native writer", async () => {
    const host = fixture();
    host.setRespond(() => ({ ok: true, structuredOutput: { status: "ready", todo: "Diagnose", evidence: "Current Git",
      nativeRefs: ["known-writer"] } }));
    host.setStatus(ref => ({ ok: true, results: [], output: `Run: ${ref}\nState: running\nMode: single` }));
    expect((await host.executeNative()).reason).toContain("prevents dispatch");
    expect(host.calls.map(call => call.key)).toEqual(["invoke-human-1-prepare"]);
    expect(host.storage.get("invoke-human-1")).toMatchObject({ cycles: [] });
  });

  test("new unblock invocation gets three slots; replay grants none and cannot clear a newer hold", async () => {
    const host = fixture(), { old } = historical(host); host.setRespond(gap);
    expect(await host.execute("human-2", true, true)).toMatchObject({ status: "partial", cycles: 3 });
    const saved = structuredClone(host.storage.get("invoke-human-2"));
    const count = host.calls.filter(call => call.agent === "pitako.execution-director").length;
    expect(count).toBe(3);
    expect((await host.execute("human-2", true, true)).status).toBe("partial");
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(count);
    const execution = host.storage.get("pitako-execution") as Record<string, unknown>;
    const newer = { invocation: "later-human", cycle: 1, key: "invoke-later-human-cycle-1" };
    host.storage.set("pitako-execution", { ...execution, unsettled: newer });
    expect((await host.execute("human-2", true, true)).reason).toContain("newer/unrelated hold");
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: newer });
    expect(host.storage.get("invoke-old-human")).toEqual(old); expect(host.storage.get("invoke-human-2")).toEqual(saved);
  });

  test.each(["root", "commonDir", "id", "source", "missionId", "digest"])("unblock rejects changed %s association without touching history", async field => {
    const host = fixture(); historical(host);
    const before = { ...(host.storage.get("pitako-execution") as Record<string, unknown>), [field]: "wrong" };
    host.storage.set("pitako-execution", before);
    expect((await host.execute("human-2", true, true)).status).toBe("blocked");
    expect(host.calls).toHaveLength(0); expect(host.storage.get("pitako-execution")).toEqual(before);
    expect(host.storage.has("invoke-human-2")).toBe(false);
  });

  test("an interleaved newer hold is never cleared after read-only diagnosis", async () => {
    const host = fixture(); historical(host);
    const newer = { invocation: "newer", cycle: 1, key: "newer-cycle-1" };
    host.setRespond(request => {
      if (request.key.endsWith("admission")) host.storage.set("pitako-execution", {
        ...(host.storage.get("pitako-execution") as Record<string, unknown>), unsettled: newer });
      return gap(request);
    });
    expect((await host.execute("human-2", true, true)).reason).toContain("hold changed");
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: newer });
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(0);
  });

  test("retained awaited native failure releases its hold without another historical inspector", async () => {
    const host = fixture(), { old } = historical(host);
    (old.cycles[1]!.result as Record<string, unknown>).nativeAwaited = true;
    host.storage.set("invoke-old-human", old);
    host.setRespond(request => request.key.endsWith("admission")
      ? { ok: true, structuredOutput: { status: "blocked", evidence: "Required test red; current Git diagnosis", nativeRefs: [] } }
      : complete(request));
    expect((await host.execute()).status).toBe("complete");
    expect(host.calls.some(request => request.key.endsWith("admission") || request.key.endsWith("settlement"))).toBe(false);
    expect(host.storage.get("invoke-old-human")).toMatchObject({ cycles: old.cycles });
    expect(host.storage.get("invoke-human-1")).not.toHaveProperty("withdrawal");
  });

  test("unblock does not bypass required checks or accept negative/stale final validation", async () => {
    const host = fixture(); historical(host);
    host.setRespond(request => request.key.endsWith("validate")
      ? { ok: true, structuredOutput: { status: "blocked", evidence: "Required check red; cannot complete" } } : complete(request));
    expect((await host.execute("human-2", true, true)).reason).toContain("fresh current-checkout");
    expect(host.storage.get("invoke-human-2")).toMatchObject({ cycles: [{ attempted: true }] });
  });

  test("a child cannot self-enable withdrawal and an existing invocation cannot acquire a new target", async () => {
    const host = fixture(); historical(host);
    host.setRespond(() => ({ ok: true, structuredOutput: { unblock: true, approved: true, status: "verified", evidence: "Child asks to release", nativeRefs: [] } }));
    expect((await host.execute()).reason).toContain("Pending historical diagnosis");
    expect(host.storage.has("invoke-human-1")).toBe(false);
    host.storage.set("invoke-human-1", { digest: "original", cycles: [] });
    expect((await host.execute("human-1", true, true)).reason).toContain("new explicit invocation ID");
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(0);
  });

  test("withdrawal interrupted after request persistence can replay its exact target without a fresh allowance", async () => {
    const host = fixture(), { hold, old } = historical(host);
    const save = host.state.set;
    let interrupted = false;
    host.state.set = async (key, value) => {
      if (key === "pitako-execution" && !(value as { unsettled: unknown }).unsettled && !interrupted) {
        interrupted = true; throw new Error("Interruption after recording explicit withdrawal");
      }
      return save(key, value);
    };
    expect((await host.execute("human-2", true, true)).reason).toContain("Interruption");
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: hold });
    host.setRespond(gap);
    expect(await host.execute("human-2", true, true)).toMatchObject({ status: "partial", cycles: 3 });
    const saved = structuredClone(host.storage.get("invoke-human-2"));
    expect((await host.execute("human-2", true, true)).status).toBe("partial");
    expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(3);
    expect(host.storage.get("invoke-human-2")).toEqual(saved); expect(host.storage.get("invoke-old-human")).toEqual(old);
  });

  test("unblock replay normally reconciles its own awaited timeout, never reapplies the old withdrawal to pending delegation", async () => {
    const host = fixture(), { old } = historical(host);
    host.setRespond(request => {
      if (request.agent === "pitako.execution-director") return timeout(request);
      if (request.key.endsWith("settlement")) throw new Error("Interrupted observation");
      return gap(request);
    });
    expect((await host.execute("human-2", true, true)).reason).toContain("Interrupted observation");
    const execution = host.storage.get("pitako-execution");
    const current = structuredClone(host.storage.get("invoke-human-2")) as { cycles: { result: unknown }[]; withdrawal: unknown };
    const withdrawal = structuredClone(current.withdrawal);
    const savedReceipt = structuredClone(current.cycles[0]!.result);
    // Without awaited completion of this NEW cycle, the old flag cannot release it.
    current.cycles[0]!.result = null; host.storage.set("invoke-human-2", current);
    expect((await host.execute("human-2", true, true)).reason).toContain("newer/unrelated hold");
    expect(host.storage.get("pitako-execution")).toEqual(execution);
    // Restore the actual saved native receipt, not a model settlement assertion.
    current.cycles[0]!.result = savedReceipt;
    host.storage.set("invoke-human-2", current);
    host.setRespond(request => request.agent === "pitako.execution-director" ? timeout(request) : gap(request));
    expect(await host.execute("human-2", true, true)).toMatchObject({ status: "partial", cycles: 3 });
    expect(host.calls.filter(call => call.agent === "pitako.execution-director").map(call => call.key))
      .toEqual([1, 2, 3].map(cycle => `invoke-human-2-cycle-${cycle}`));
    expect(host.storage.get("invoke-human-2")).toMatchObject({ withdrawal });
    expect(host.storage.get("invoke-old-human")).toEqual(old);
  });

  test.each([1, 2, 3])("%s confirmed timeouts consume slots and advance only after fresh settlement; replay grants none", async count => {
    const host = fixture();
    host.setRespond(request => {
      if (request.agent !== "pitako.execution-director") return complete(request);
      const cycle = Number(request.key.at(-1));
      expect(host.storage.get("invoke-human-1")).toMatchObject({ cycles: Array.from({ length: cycle }, () => ({ attempted: true })) });
      expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: { cycle } });
      if (cycle > 1) {
        expect(request.task).toContain(`/native/invoke-human-1-cycle-${cycle - 1}/session.jsonl`);
        expect(request.task).toContain("Known native refs and Git observations");
        expect(request.task).toContain("Five increments with own checks and WIP commits");
        expect(request.task).toContain("COMPLETE IMMUTABLE SPECS");
      }
      return cycle <= count ? timeout(request) : complete(request);
    });
    const result = await host.executeNative();
    expect(result).toMatchObject(count === 3 ? { status: "partial", cycles: 3 } : { status: "complete", cycle: count + 1 });
    const directors = host.calls.filter(request => request.agent === "pitako.execution-director");
    expect(directors.map(request => request.key)).toEqual(Array.from({ length: Math.min(count + 1, 3) }, (_, i) => `invoke-human-1-cycle-${i + 1}`));
    for (const request of directors) { expect(request.context).toBe("fresh"); expect(request.cwd).toBe(config.root); }
    for (let cycle = 1; cycle <= count; cycle++) {
      const settlement = host.calls.find(request => request.key === `invoke-human-1-cycle-${cycle}-settlement`)!;
      expect(settlement.task).toContain("known owned descendant references");
      expect(settlement.task).toContain("plus actual Git changes");
      expect(settlement.task).toContain("Pending permissions");
      expect(result.references).toContainEqual(expect.objectContaining({ key: `invoke-human-1-cycle-${cycle}`, runId: `native-invoke-human-1-cycle-${cycle}` }));
    }
    const saved = JSON.stringify(host.storage.get("invoke-human-1"));
    expect(saved).toContain('"terminalOutcome":{"state":"partial","reason":"timeout"}');
    expect(saved).not.toContain('"results"'); expect(saved).not.toContain('"task"');
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: null });
    if (count === 3) expect(result.remaining).toContain("recover remaining work");
    host.calls.length = 0;
    expect((await host.executeNative()).status).toBe(result.status);
    expect(host.calls.filter(request => request.agent === "pitako.execution-director")).toHaveLength(0);
    expect(host.calls.map(request => request.key)).toEqual(count === 3 ? [] : [`invoke-human-1-cycle-${count + 1}-validate`]);
  });

  test("native runs.all transports results[].timedOut and retains terminal cause if non-JSON metadata is omitted", async () => {
    for (const mode of ["single-result", "non-json-results"]) {
      const host = fixture();
      host.setRespond(request => {
        if (request.key !== "invoke-human-1-cycle-1") return complete(request);
        const result = timeout(request);
        if (mode === "single-result") delete result.terminalOutcome;
        else result.results = [{ timedOut: true, task: request.task, nonJson: () => {} }];
        return result;
      });
      expect(await host.executeNative()).toMatchObject({ status: "complete", cycle: 2 });
      expect(host.storage.get("invoke-human-1")).toMatchObject({ cycles: [{ result: { terminalOutcome: { state: "partial", reason: "timeout" } } }, {}] });
    }
  });

  test("timeout waits for independent settlement before permitting the next writer", async () => {
    const host = fixture(), entered = deferred<void>(), waiting = deferred<Result>();
    host.setRespond(request => {
      if (request.key.endsWith("cycle-1")) return timeout(request);
      if (request.key.endsWith("cycle-1-settlement")) { entered.resolve(); return waiting.promise; }
      return complete(request);
    });
    const work = host.execute(); await entered.promise;
    try {
      expect(host.calls.filter(request => request.agent === "pitako.execution-director")).toHaveLength(1);
      expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: { cycle: 1 } });
    } finally { waiting.resolve(gap(host.calls.at(-1)!)); }
    expect(await work).toMatchObject({ status: "complete", cycle: 2 });
  });

  test.each(["live", "stale", "pending-permission", "missing", "reused", "refused", "no-evidence", "third-unsafe"])("timeout with %s observations preserves barriers/pending diagnosis across recovery", async fault => {
    const host = fixture();
    host.setStatus(ref => ref === "exact-unsafe" ? { ok: true, state: "running" } : { ok: true, results: [] });
    host.setRespond(request => {
      if (request.agent === "pitako.execution-director") return timeout(request);
      if ((request.key.endsWith("settlement") || request.key.endsWith("admission")) && (fault !== "third-unsafe" || request.key.includes("cycle-3") || request.key.endsWith("admission"))) {
        if (fault === "missing") return undefined;
        return { ok: fault !== "refused", recovery: fault === "pending-permission" ? { state: "pending" } : undefined,
          reused: fault === "reused", runId: "inspection", structuredOutput:
          { evidence: ["no-evidence", "stale"].includes(fault) ? "" : "Concrete native refs / Git evidence",
            nativeRefs: ["live", "third-unsafe"].includes(fault) ? ["exact-unsafe"] : [] } };
      }
      return gap(request);
    });
    expect((await host.execute()).status).toBe("blocked");
    const count = host.calls.filter(request => request.agent === "pitako.execution-director").length;
    expect(count).toBe(fault === "third-unsafe" ? 3 : 1);
    expect((await host.execute()).status).toBe("blocked");
    expect((await host.execute("human-2")).status).toBe("blocked");
    expect(host.calls.filter(request => request.agent === "pitako.execution-director")).toHaveLength(count);
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: { cycle: count } });
  });

  test.each(["stopped", "interrupted", "detached", "running", "missing", "recovery", "permission"])("does not replace native Stop/pending/unsafe delegation: %s", async fault => {
    const host = fixture();
    host.setRespond(request => {
      if (request.key.endsWith("prepare")) return gap(request);
      if (fault === "missing") return undefined;
      const result = timeout(request);
      if (fault === "running") result.state = "running";
      else if (fault === "recovery") result.recovery = { pending: true };
      else if (fault === "permission") result.error = "Blocked by pi-subagents permission rule: 'bash' is denied.";
      else result[fault as "stopped" | "interrupted" | "detached"] = true;
      return result;
    });
    expect((await host.execute()).status).toBe("blocked");
    expect(host.calls.map(request => request.key)).toEqual(["invoke-human-1-prepare", "invoke-human-1-cycle-1"]);
  });

  test.each(["error-text", "model-timeout", "no-run-id"])("unconfirmed timeout is diagnosis, never a timeout retry or activity claim: %s", async fault => {
    const host = fixture();
    host.setRespond(request => {
      if (request.agent !== "pitako.execution-director") return complete(request);
      if (fault === "error-text") return { ok: false, runId: "failed", error: "timed out", results: [{ timedOut: false }] };
      if (fault === "model-timeout") return { ok: false, runId: "failed", structuredOutput: { timedOut: true, status: "timeout", writersSettled: true } };
      const result = timeout(request); delete result.runId; return result;
    });
    expect(await host.execute()).toMatchObject({ status: "partial", cycles: 3 });
    const saved = JSON.stringify(host.storage.get("invoke-human-1"));
    expect(saved).not.toContain('"terminalOutcome"');
    expect(host.calls.filter(request => request.agent === "pitako.execution-director").map(request => request.key))
      .toEqual([1, 2, 3].map(cycle => `invoke-human-1-cycle-${cycle}`));
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: null });
  });

  test("interruption before observations gets read-only recovery without retrying the consumed timeout", async () => {
    const host = fixture();
    host.setRespond(request => {
      if (request.key.endsWith("cycle-1")) return timeout(request);
      if (request.key.endsWith("settlement")) throw new Error("Technical interruption");
      return gap(request);
    });
    expect((await host.execute()).status).toBe("blocked");
    expect(host.storage.get("invoke-human-1")).toMatchObject({ cycles: [{ attempted: true, result: { terminalOutcome: { reason: "timeout" } } }] });
    host.setRespond(request => request.agent === "pitako.execution-director" ? timeout(request) : gap(request));
    expect(await host.execute()).toMatchObject({ status: "partial", cycles: 3 });
    expect(host.calls.filter(request => request.key === "invoke-human-1-cycle-1")).toHaveLength(1);
  });

  test("technical continuation after settled timeout uses only the next remaining slot", async () => {
    const host = fixture(); let interrupted = false;
    host.setRespond(request => request.agent === "pitako.execution-director" ? timeout(request) : gap(request));
    host.setHostResponse((key, value) => {
      if (key === "inspect-cycle-2" && !interrupted) { interrupted = true; throw new Error("Technical interruption before next attempt"); }
      return value;
    });
    expect((await host.execute()).status).toBe("blocked");
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: null });
    expect(host.storage.get("invoke-human-1")).toMatchObject({ cycles: [{ attempted: true, settlement: { structuredOutput: { evidence: "Known native refs and Git observations" } } }] });
    host.calls.length = 0;
    expect(await host.execute()).toMatchObject({ status: "partial", cycles: 3 });
    expect(host.calls.filter(request => request.agent === "pitako.execution-director").map(request => request.key))
      .toEqual(["invoke-human-1-cycle-2", "invoke-human-1-cycle-3"]);
    host.calls.length = 0;
    expect((await host.execute()).status).toBe("partial"); expect(host.calls).toHaveLength(0);
  });

  test("persisted timeout without verified settlement cannot authorize another director", async () => {
    const host = fixture();
    host.storage.set("invoke-human-1", { digest: "original", source: "/owned/sibling/.pitako/plans/spec.md", content: "snapshot",
      preparation: { todo: "prepared" }, cycles: [{ attempted: true, result: { ok: false, runId: "timed-out", terminalOutcome: { state: "partial", reason: "timeout" } } }] });
    expect((await host.execute()).reason).toContain("lacks recorded independent observations");
    expect(host.calls).toHaveLength(0);
  });

  test.each(["count-zero", "count-overflow", "byte-overflow", "bad-digest", "changed-digest", "changed-input", "wrong-index", "wrong-count", "truncated", "truncated-content", "noncanonical", "oversized-envelope"])("rejects invalid metadata transport before preparation: %s", async fault => {
    const host = fixture(), content = "COMPLETE IMMUTABLE SPECS";
    const metadata = { root: config.root, commonDir: "/owned/common", candidates: [],
      selected: { source: "/owned/spec.md", digest: digest(content), chunks: 1 } };
    const { transport, packets } = inspectionSnapshot(metadata, content);
    const packet = packets[0]!;
    host.setHostResponse(key => key.startsWith("inspect-") ? { selected: { digest: digest(content) }, transport: {
      ...transport,
      digest: fault === "bad-digest" ? "invalid" : transport.digest,
      chunks: fault === "count-zero" ? 0 : fault === "count-overflow" ? 27 : transport.chunks,
      bytes: fault === "byte-overflow" ? MAX_SPEC_BYTES + 1 : transport.bytes + (fault === "noncanonical" ? 1 : 0),
    } } : {
      ...packet,
      metadataDigest: fault === "changed-digest" ? "f".repeat(64) : packet.metadataDigest,
      digest: fault === "changed-input" ? "f".repeat(64) : packet.digest,
      chunks: fault === "wrong-count" ? 2 : packet.chunks, index: fault === "wrong-index" ? 1 : 0,
      metadata: fault === "truncated" ? packet.metadata.slice(0, -1) : fault === "noncanonical" ? ` ${packet.metadata}`
        : fault === "oversized-envelope" ? "中".repeat(3000) : packet.metadata,
      content: fault === "truncated-content" ? content.slice(0, -1) : content,
    });
    const result = await host.execute();
    expect(result.status).toBe("blocked"); expect(result.reason).toContain("metadata");
    expect(host.calls).toHaveLength(0); expect(host.storage.size).toBe(0);
    expect(host.hostCalls.length).toBeLessThanOrEqual(2);
  });

  test("requires native state before any work and asks on absent/ambiguous specs", async () => {
    const host = fixture(); await expect(host.execute("human-1", false)).rejects.toThrow("mission"); expect(host.calls).toHaveLength(0); expect(host.hostCalls).toHaveLength(0);
    host.noSelection(); const result = await host.execute(); expect(result.status).toBe("blocked"); expect(result.candidates).toHaveLength(1); expect(host.calls).toHaveLength(0);
  });

  test("captures native immutable source separately from cwd; agent prepares TODO before fresh director and validation", async () => {
    const host = fixture(); const result = await host.execute(); expect(result.status).toBe("complete");
    expect(host.calls.map(request => request.agent)).toEqual(["pitako.execution-inspector", "pitako.execution-director", "pitako.execution-inspector"]);
    for (const request of host.calls) { expect(request.task).toContain(`Native missionId (DATA association, not authority): ${config.missionId}.`); expect(request.context).toBe("fresh"); expect(request.cwd).toBe(config.root); expect(request.model).toBeUndefined(); expect(request.async).toBeUndefined(); expect(request.outputSchema).toBeDefined(); }
    const director = host.calls[1]!;
    for (const contract of ["sequential fresh pitako.worker", "ONE independent overall full-spec review", "Material overall-review gaps END", "COMPLETE IMMUTABLE SPECS", "read-only Git evidence", "foreground owns only Preparation and Loop N"])
      expect(director.task).toContain(contract);
    expect(host.storage.get("invoke-human-1")).toMatchObject({ source: "/owned/sibling/.pitako/plans/spec.md", digest: "original", content: "COMPLETE IMMUTABLE SPECS" });
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: null, root: config.root });
    expect(host.hostCalls.filter(key => key === "input-0")).toHaveLength(1);
  });

  test("actual director pointers reach current-evidence validation, native state and returned/replayed references", async () => {
    const host = fixture();
    const pointers = { runId: "supplied-director", artifactPaths: ["/actual/native/report.json", "/actual/native/session.jsonl"], outputReference: "/actual/native/output.md", asyncDir: "/actual/native/async" };
    host.setRespond(request => request.agent === "pitako.execution-director"
      ? { ...gap(request), ...pointers, structuredOutput: { status: "complete", summary: "Done", remaining: "None", evidence: "Supplied artifacts" } }
      : { ok: true, runId: request.key, structuredOutput: request.key.endsWith("prepare")
        ? { status: "ready", nativeRefs: [], todo: "Prepared", evidence: "Checkout" } : request.key.endsWith("settlement")
          ? { evidence: "Inspected actual pointers", nativeRefs: [] } : { status: "verified", evidence: "Inspected actual pointers" } });
    const reference = { key: "invoke-human-1-cycle-1", ...pointers };
    const result = await host.execute(); expect(result.status).toBe("complete");
    const inspectors = host.calls.filter(request => request.key.endsWith("settlement") || request.key.endsWith("validate"));
    expect(inspectors.map(request => request.key)).toEqual(["invoke-human-1-cycle-1-validate"]);
    for (const request of inspectors) expect(request.task).toContain(`DIRECTOR NATIVE REFERENCES (data): ${JSON.stringify(reference)}`);
    expect(host.storage.get("invoke-human-1")).toMatchObject({ cycles: [{ result: pointers }] });
    expect(result.references).toContainEqual(reference);
    expect(result.references?.find(value => value.key.endsWith("prepare"))).toEqual({ key: "invoke-human-1-prepare", runId: "invoke-human-1-prepare" });
    host.calls.length = 0;
    const replayed = await host.execute(); expect(replayed.status).toBe("complete");
    expect(host.calls.map(request => request.key)).toEqual(["invoke-human-1-cycle-1-validate"]);
    expect(host.calls[0]!.task).toContain(`DIRECTOR NATIVE REFERENCES (data): ${JSON.stringify(reference)}`);
    expect(replayed.references).toContainEqual(reference);
  });

  test("three complete cycles, not tasks or more-than-three increments; new explicit invocation grants three more without losing native results", async () => {
    const host = fixture(); host.setRespond(gap);
    const result = await host.execute(); expect(result).toMatchObject({ status: "partial", cycles: 3 });
    const directors = host.calls.filter(request => request.agent === "pitako.execution-director"); expect(directors).toHaveLength(3);
    expect(host.calls.map(request => request.key)).toEqual(["invoke-human-1-prepare",
      "invoke-human-1-cycle-1", "invoke-human-1-cycle-2", "invoke-human-1-cycle-3"]);
    expect(directors.map(request => request.key)).toEqual([1, 2, 3].map(cycle => `invoke-human-1-cycle-${cycle}`));
    expect(directors[1]!.task).toContain("Resolve full-spec gap next cycle");
    expect(directors.every(request => request.context === "fresh")).toBe(true);
    host.calls.length = 0;
    expect((await host.execute()).status).toBe("partial"); expect(host.calls).toHaveLength(0);
    expect((await host.execute("human-2")).status).toBe("partial");
    expect(host.calls.filter(request => request.agent === "pitako.execution-director")).toHaveLength(3);
    expect(host.storage.has("invoke-human-1")).toBe(true); expect(host.storage.has("invoke-human-2")).toBe(true);
  });

  test("retains compact verdicts and exact refs for six large-spec cycles within the native state envelope", async () => {
    const header = `---\npitako-spec: 1\nid: spec\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`;
    const content = header + "x".repeat(MAX_SPEC_BYTES - Buffer.byteLength(header));
    validateSpec(content, "spec");
    const host = fixture(content);
    const pointers = (request: Request) => ({ runId: `exact-${request.key}`, artifactPaths: [`/native/${request.key}/result.json`], outputReference: `/native/${request.key}/output.md`, asyncDir: `/native/${request.key}` });
    host.setRespond(request => ({ ...gap(request), ...pointers(request),
      output: `Full native payload: ${request.task}`, results: [{ task: request.task, output: content }] }));
    for (const invocation of ["human-1", "human-2"]) {
      const result = await host.execute(invocation);
      expect(result.status).toBe("partial");
      for (const request of host.calls.filter(request => request.agent === "pitako.execution-director" && request.key.startsWith(`invoke-${invocation}`)))
        expect(result.references).toContainEqual({ key: request.key, ...pointers(request) });
    }
    const serialized = JSON.stringify(Object.fromEntries(host.storage), null, 2);
    expect(Buffer.byteLength(serialized)).toBeLessThan(MISSION_STATE_MAX_BYTES);
    expect(serialized).not.toContain('"task"'); expect(serialized).not.toContain('"results"'); expect(serialized).not.toContain('"output"');
    for (const invocation of ["human-1", "human-2"])
      expect(host.storage.get(`invoke-${invocation}`)).toMatchObject({ content, cycles: [1, 2, 3].map(cycle => ({ result: {
        ...pointers({ key: `invoke-${invocation}-cycle-${cycle}` } as Request), ok: true,
        structuredOutput: { status: "gaps" },
      } })) });
    const before = host.calls.length;
    expect((await host.execute("human-2")).status).toBe("partial"); expect(host.calls).toHaveLength(before);
  });

  test("does not launch another director before current cycle settles", async () => {
    const waiting = deferred<Result>(), entered = deferred<void>(); const host = fixture();
    host.setRespond(request => { if (request.key.endsWith("cycle-1")) { entered.resolve(); return waiting.promise; } return gap(request); });
    const work = host.execute(); await entered.promise;
    try { expect(host.calls.map(request => request.key)).toEqual(["invoke-human-1-prepare", "invoke-human-1-cycle-1"]); expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: { invocation: "human-1", cycle: 1 } }); }
    finally { waiting.resolve(gap(host.calls.at(-1)!)); }
    expect((await work).status).toBe("partial");
  });

  test.each([false, "native-failure"])("negative model/native work outcome is not a historical writer veto: %s", async failure => {
    const host = fixture(); host.setRespond(request => request.agent !== "pitako.execution-director" ? gap(request) : failure === false
      ? { ok: true, runId: "uncertain", structuredOutput: { status: "gaps", evidence: "Red check; diagnose cause", writersSettled: false } }
      : { ok: false, runId: "native-failed", error: "Native child failure" });
    expect(await host.execute()).toMatchObject({ status: "partial", cycles: 3 });
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: null });
    const count = host.calls.length;
    expect((await host.execute()).status).toBe("partial"); expect(host.calls).toHaveLength(count);
    expect((await host.execute("human-2")).status).toBe("partial");
    expect(host.calls.filter(request => request.agent === "pitako.execution-director")).toHaveLength(6);
  });

  test("an interrupted recorded attempt never blindly reruns director/grandchildren", async () => {
    const host = fixture();
    host.storage.set("invoke-human-1", { digest: "original", source: "/owned/sibling/.pitako/plans/spec.md", content: "snapshot", preparation: { todo: "prepared" }, cycles: [{ attempted: true, result: null }] });
    expect((await host.execute()).reason).toContain("no durably recorded result"); expect(host.calls).toHaveLength(0);
  });

  test("input changes block without adopting/replacing the retained snapshot", async () => {
    const host = fixture(); host.setRespond(gap); await host.execute(); host.changeInput();
    const before = host.calls.length; expect((await host.execute()).reason).toContain("input changed");
    expect(host.calls).toHaveLength(before); expect(host.storage.get("invoke-human-1")).toMatchObject({ digest: "original", content: "COMPLETE IMMUTABLE SPECS" });
  });

  test("recorded success needs fresh validation; native reused validation and checkout drift cannot succeed", async () => {
    const host = fixture(); expect((await host.execute()).status).toBe("complete"); host.calls.length = 0;
    host.setRespond(request => ({ ok: true, runId: `reused-${request.key}`, reused: true, structuredOutput: { status: "verified", evidence: "Old checks" } }));
    expect((await host.execute()).reason).toContain("fresh current-checkout"); expect(host.calls).toHaveLength(1); expect(host.calls[0]!.agent).toBe("pitako.execution-inspector");
    host.setRespond(request => { host.changeCheckout(); return { ok: true, runId: request.key, structuredOutput: { status: "verified", evidence: "Raced evidence" } }; });
    expect((await host.execute()).status).toBe("blocked");
  });

  test.each(["gaps", "complete"])("interruption after an awaited %s result resumes without a recovery inspector or repeated director", async status => {
    const host = fixture(), save = host.state.set;
    let interrupted = false;
    host.state.set = async (key, value) => {
      if (key === "pitako-execution" && !(value as { unsettled: unknown }).unsettled && !interrupted &&
          host.calls.some(request => request.agent === "pitako.execution-director")) {
        interrupted = true; throw new Error("Interruption after awaited result persistence");
      }
      return save(key, value);
    };
    host.setRespond(status === "complete" ? complete : gap);
    expect((await host.executeNative()).reason).toContain("Interruption after awaited");
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: { cycle: 1 } });
    expect(await host.executeNative()).toMatchObject(status === "complete" ? { status: "complete", cycle: 1 } : { status: "partial", cycles: 3 });
    expect(host.calls.filter(request => request.key === "invoke-human-1-cycle-1")).toHaveLength(1);
    expect(host.calls.some(request => request.key.endsWith("admission") || request.key.endsWith("settlement"))).toBe(false);
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: null });
  });

  test("final validation assesses current criteria and checks without a historical closure certificate", async () => {
    const host = fixture(); historical(host);
    host.setRespond(request => {
      if (!request.key.endsWith("validate")) return complete(request);
      expect(request.task).toContain("Assess full-spec compliance, required checks, overall review");
      expect(request.task).toContain("Missing historical inventory alone is not a spec gap or a closure prerequisite");
      expect(request.task).not.toContain("Report blocked on any");
      return { ok: true, runId: "current-validation", structuredOutput:
        { status: "verified", evidence: "Current spec/check/review evidence verified; old inventory unavailable, not a product gap" } };
    });
    expect(await host.executeNative("human-2", true)).toMatchObject({ status: "complete", cycle: 1 });
  });

  test("native failure and product blockers stop early, not an unconditional repair loop", async () => {
    const host = fixture(); host.setRespond(request => request.key.endsWith("prepare") ? gap(request)
      : { ok: true, runId: "blocked-cycle", structuredOutput: { status: "blocked", summary: "Need scope decision", remaining: "Human decision", evidence: "native refs" } });
    expect((await host.execute()).status).toBe("blocked"); expect(host.calls.map(request => request.key))
      .toEqual(["invoke-human-1-prepare", "invoke-human-1-cycle-1"]);
  });
});
