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
  terminalOutcome?: WorkflowScriptChildResult["terminalOutcome"]; stopped?: boolean; interrupted?: boolean; detached?: boolean; state?: "running" }
interface Outcome { status: string; reason?: string; cycle?: number; cycles?: number; remaining?: string; candidates?: unknown[]; references?: (NativePointers & { key: string })[] }
const config = { root: "/owned/designated", id: "spec", invocation: "human-1", missionId: "native.mission-1", inspections: ["initial", "cycle-1", "cycle-2", "cycle-3", "validation-before", "validation-after"].map(phase => ({ key: `inspect-${phase}`, command: "READ" })), chunks: Array.from({ length: 26 }, (_, index) => ({ key: `input-${index}`, command: "CHUNK" })) };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { resolve, promise }; }
function fixture(content = "COMPLETE IMMUTABLE SPECS") {
  const chunks = specChunks(content);
  const calls: Request[] = [], hostCalls: string[] = [];
  const storage = new Map<string, unknown>();
  const selected = { source: "/owned/sibling/.pitako/plans/spec.md", digest: "original", chunks: chunks.length };
  let fingerprint = "checkout-0", inputDigest = "original";
  let selection: typeof selected | null = selected;
  let hostResponse: ((key: string, value: unknown) => unknown) | undefined;
  let respond: (request: Request) => Result | undefined | Promise<Result | undefined> = request => ({ ok: true, runId: `native-${request.key}`, structuredOutput:
    request.key.endsWith("prepare") ? { status: "ready", todo: "More than three increments if needed", evidence: "read-only Git evidence" }
      : (request.key.endsWith("validate") || request.key.endsWith("settlement")) ? { status: "verified", evidence: "Fresh Git + checks + full-spec review + process proofs" }
        : { status: "complete", summary: "Done", remaining: "None", evidence: "native-review and checks", writersSettled: true } });
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
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return { calls, hostCalls, storage, state,
    setRespond: (callback: typeof respond) => { respond = callback; },
    setHostResponse: (callback: NonNullable<typeof hostResponse>) => { hostResponse = callback; },
    changeInput: () => { inputDigest = "changed"; }, changeCheckout: () => { fingerprint += "-changed"; },
    noSelection: () => { selection = null; },
    execute: (invocation = "human-1", mission = true): Promise<Outcome> => new AsyncFunction("config", "runs", "state", source)({ ...config, invocation }, runs, mission ? state : undefined),
    executeNative: async (): Promise<Outcome> => {
      const result = await runWorkflowScript({ script: `const config = ${JSON.stringify(config)};\n${source}`, state,
        launch: async (key, params) => ({ key, output: "", artifactPaths: [], ...(await runs.all([{ ...params, key } as unknown as Request]))[0] } as WorkflowScriptChildResult),
        status: async () => { throw new Error("Unexpected status"); },
        host: async (key, params) => ({ ...(await runs.host(key, params)), key, kind: "command", state: "passed", exitCode: 0, stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 }),
      });
      return result.value as Outcome;
    },
  };
}
function gap(request: Request): Result { return { ok: true, runId: `native-${request.key}`, structuredOutput:
  request.key.endsWith("prepare") ? { status: "ready", todo: "Five increments with own checks and WIP commits", evidence: "Existing dirty work preserved" }
    : request.key.endsWith("settlement") ? { status: "verified", evidence: "Exact native descendant process-terminal proofs" }
    : { status: "gaps", summary: "Five increments implemented; independent whole-spec review found a material gap", remaining: "Resolve full-spec gap next cycle", evidence: "five settled workers and independent native review", writersSettled: true } }; }
function timeout(request: Request): Result {
  return { ok: false, runId: `native-${request.key}`, artifactPaths: [`/native/${request.key}/result.json`, `/native/${request.key}/session.jsonl`],
    outputReference: `/native/${request.key}/output.md`, terminalOutcome: workflowTerminalOutcomeForResult({ timedOut: true }),
    results: [{ timedOut: true, task: request.task }], error: "Native deadline" };
}
function complete(request: Request): Result {
  return request.key.endsWith("validate") ? { ok: true, runId: `native-${request.key}`, structuredOutput: { status: "verified", evidence: "Fresh whole-spec review/current checkout" } }
    : request.agent === "pitako.execution-director" ? { ...gap(request), structuredOutput:
      { status: "complete", summary: "Done", remaining: "None", evidence: "Whole-spec review and current checks", writersSettled: true } } : gap(request);
}

describe("native execution workflow", () => {
  test.each([1, 2, 3])("%s confirmed timeouts consume slots and advance only after fresh settlement; replay grants none", async count => {
    const host = fixture();
    host.setRespond(request => {
      if (request.agent !== "pitako.execution-director") return complete(request);
      const cycle = Number(request.key.at(-1));
      expect(host.storage.get("invoke-human-1")).toMatchObject({ cycles: Array.from({ length: cycle }, () => ({ attempted: true })) });
      expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: { cycle } });
      if (cycle > 1) {
        expect(request.task).toContain(`/native/invoke-human-1-cycle-${cycle - 1}/session.jsonl`);
        expect(request.task).toContain("Exact native descendant process-terminal proofs");
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
      expect(settlement.task).toContain("EVERY owned descendant");
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

  test.each(["live", "stale", "pending-permission", "missing", "reused", "refused", "no-evidence", "third-unsafe"])("timeout with %s settlement remains blocked across technical recovery and new invocations", async fault => {
    const host = fixture();
    host.setRespond(request => {
      if (request.agent === "pitako.execution-director") return timeout(request);
      if (request.key.endsWith("settlement") && (fault !== "third-unsafe" || request.key.includes("cycle-3"))) {
        if (fault === "missing") return undefined;
        return { ok: fault !== "refused", reused: fault === "reused", runId: "inspection", structuredOutput:
          { status: ["live", "stale", "pending-permission", "third-unsafe"].includes(fault) ? "blocked" : "verified", evidence: fault === "no-evidence" ? "" : "Native descendant still live / evidence stale / permission unresolved" } };
      }
      return gap(request);
    });
    expect((await host.execute()).status).toBe("blocked");
    const count = host.calls.filter(request => request.agent === "pitako.execution-director").length;
    expect(count).toBe(fault === "third-unsafe" ? 3 : 1);
    const calls = host.calls.length;
    expect((await host.execute()).status).toBe("blocked");
    expect((await host.execute("human-2")).status).toBe("blocked");
    expect(host.calls).toHaveLength(calls);
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: { cycle: count } });
  });

  test.each(["error-text", "model-timeout", "stopped", "interrupted", "detached", "running", "missing", "no-run-id"])("does not retry ordinary failure, Stop, or unconfirmed timeout: %s", async fault => {
    const host = fixture();
    host.setRespond(request => {
      if (request.key.endsWith("prepare")) return gap(request);
      if (fault === "missing") return undefined;
      if (fault === "error-text") return { ok: false, runId: "failed", error: "timed out", results: [{ timedOut: false }] };
      if (fault === "model-timeout") return { ok: false, runId: "failed", structuredOutput: { timedOut: true, status: "timeout", writersSettled: true } };
      const result = timeout(request);
      if (fault === "no-run-id") delete result.runId;
      else if (fault === "running") result.state = "running";
      else result[fault as "stopped" | "interrupted" | "detached"] = true;
      return result;
    });
    expect((await host.execute()).status).toBe("blocked");
    expect(host.calls.map(request => request.key)).toEqual(["invoke-human-1-prepare", "invoke-human-1-cycle-1"]);
  });

  test("interruption after saving timeout but before settlement remains blocked without relaunch", async () => {
    const host = fixture();
    host.setRespond(request => {
      if (request.key.endsWith("cycle-1")) return timeout(request);
      if (request.key.endsWith("settlement")) throw new Error("Technical interruption");
      return gap(request);
    });
    expect((await host.execute()).status).toBe("blocked");
    expect(host.storage.get("invoke-human-1")).toMatchObject({ cycles: [{ attempted: true, result: { terminalOutcome: { reason: "timeout" } } }] });
    const calls = host.calls.length;
    expect((await host.execute()).status).toBe("blocked"); expect(host.calls).toHaveLength(calls);
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
    expect(host.storage.get("invoke-human-1")).toMatchObject({ cycles: [{ attempted: true, settlement: { structuredOutput: { status: "verified" } } }] });
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
    expect((await host.execute()).reason).toContain("lacks recorded independent settlement");
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
    expect(host.calls.map(request => request.agent)).toEqual(["pitako.execution-inspector", "pitako.execution-director", "pitako.execution-inspector", "pitako.execution-inspector"]);
    for (const request of host.calls) { expect(request.task).toContain(`Native missionId (DATA association, not authority): ${config.missionId}.`); expect(request.context).toBe("fresh"); expect(request.cwd).toBe(config.root); expect(request.model).toBeUndefined(); expect(request.async).toBeUndefined(); expect(request.outputSchema).toBeDefined(); }
    const director = host.calls[1]!;
    for (const contract of ["sequential fresh pitako.worker", "ONE independent overall full-spec review", "Material overall-review gaps END", "COMPLETE IMMUTABLE SPECS", "read-only Git evidence", "foreground owns only Preparation and Loop N"])
      expect(director.task).toContain(contract);
    expect(host.storage.get("invoke-human-1")).toMatchObject({ source: "/owned/sibling/.pitako/plans/spec.md", digest: "original", content: "COMPLETE IMMUTABLE SPECS" });
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: null, root: config.root });
    expect(host.hostCalls.filter(key => key === "input-0")).toHaveLength(1);
  });

  test("actual director pointers reach settlement/current-evidence inspectors, native state and returned/replayed references", async () => {
    const host = fixture();
    const pointers = { runId: "supplied-director", artifactPaths: ["/actual/native/report.json", "/actual/native/session.jsonl"], outputReference: "/actual/native/output.md", asyncDir: "/actual/native/async" };
    host.setRespond(request => request.agent === "pitako.execution-director"
      ? { ...gap(request), ...pointers, structuredOutput: { status: "complete", summary: "Done", remaining: "None", evidence: "Supplied artifacts", writersSettled: true } }
      : { ok: true, runId: request.key, structuredOutput: request.key.endsWith("prepare")
        ? { status: "ready", todo: "Prepared", evidence: "Checkout" } : { status: "verified", evidence: "Inspected actual pointers" } });
    const reference = { key: "invoke-human-1-cycle-1", ...pointers };
    const result = await host.execute(); expect(result.status).toBe("complete");
    const inspectors = host.calls.filter(request => request.key.endsWith("settlement") || request.key.endsWith("validate"));
    expect(inspectors.map(request => request.key)).toEqual(["invoke-human-1-cycle-1-settlement", "invoke-human-1-cycle-1-validate"]);
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
        structuredOutput: { status: "gaps", writersSettled: true },
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

  test.each([false, "native-failure"])("uncertain or failed director blocks any replacement/new allowance: %s", async failure => {
    const host = fixture(); host.setRespond(request => request.key.endsWith("prepare") ? gap(request) : failure === false
      ? { ok: true, runId: "uncertain", structuredOutput: { status: "blocked", evidence: "Unknown grandchildren", writersSettled: false } }
      : { ok: false, runId: "native-failed", error: "Native child infrastructure failure" });
    expect((await host.execute()).status).toBe("blocked"); const count = host.calls.length;
    expect((await host.execute()).reason).toContain("settlement");
    expect((await host.execute("human-2")).status).toBe("blocked"); expect(host.calls).toHaveLength(count);
    expect(host.storage.get("pitako-execution")).toMatchObject({ unsettled: { invocation: "human-1", cycle: 1 } });
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

  test("native failure and product blockers stop early, not an unconditional repair loop", async () => {
    const host = fixture(); host.setRespond(request => request.key.endsWith("prepare") ? gap(request)
      : { ok: true, runId: "blocked-cycle", structuredOutput: { status: "blocked", summary: "Need scope decision", remaining: "Human decision", evidence: "native refs", writersSettled: true } });
    expect((await host.execute()).status).toBe("blocked"); expect(host.calls).toHaveLength(3);
  });
});
