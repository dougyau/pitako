import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChildSafeState } from "../node_modules/pi-subagents/src/extension/fanout-child.js";
import { createNativeSupervisorChannel, registerNativeSupervisorClient } from "../node_modules/pi-subagents/src/intercom/native-supervisor-channel.js";
import { runWorkflowScript, validateWorkflowScript, type WorkflowScriptChildResult } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { normalizeWorkflowArgs } from "../node_modules/pi-subagents/src/workflows/workflow-resources.js";
import type { WorkflowTerminalOutcome } from "../node_modules/pi-subagents/src/shared/types.js";

const source = readFileSync(new URL("../skills/architecture/workflow.js", import.meta.url), "utf8");
interface Request {
  key?: string;
  agent?: string;
  resume?: string;
  context?: string;
  async?: boolean;
  task: string;
  label?: string;
  phase?: string;
  output: boolean | string;
  outputMode?: string;
  outputSchema: unknown;
}
interface Result { ok: boolean; runId?: string; structuredOutput?: unknown; error?: string;
  stopped?: boolean; interrupted?: boolean; detached?: boolean; agent?: string; key?: string;
  outputSaveError?: string; metadataSaveError?: string; terminalOutcome?: WorkflowTerminalOutcome;
  timedOut?: boolean; exitCode?: number; processSignal?: string;
  outputPartial?: boolean; structuredOutputFailed?: boolean; recovery?: WorkflowScriptChildResult["recovery"];
  outputPathMapping?: { requestedPath: string; savedPath: string };
  raw?: boolean; output?: string; results?: Record<string, unknown>[]; outputReference?: string; state?: "running" }
interface Original { id: string; producer: string; key: string; revision: number; runId?: string;
  delivery: string; publication: string; sufficient: boolean; accessibility?: string; diagnostic?: string; failedOriginal?: Record<string, unknown>;
  results?: { savedOutputPath?: string }[] }
const originalsRoot = mkdtempSync(path.join(tmpdir(), "pitako-architecture-originals-"));
afterAll(() => rmSync(originalsRoot, { recursive: true, force: true }));
let publicationSequence = 0;
function essentials(request: Request): Original[] {
  return JSON.parse(request.task.match(/ESSENTIAL ORIGINALS \(data; one authoritative representation per original\): (.*)\n/)?.[1] ?? "[]");
}
function originalValue(original: Original): Record<string, unknown> {
  if (original.failedOriginal) return original.failedOriginal;
  const saved = original.results?.find(child => child.savedOutputPath)?.savedOutputPath;
  if (!saved) throw new Error(`No publication for ${original.id}. ${original.diagnostic ?? "Original not delivered."}`);
  const value = JSON.parse(readFileSync(saved, "utf8"));
  for (const field of ["consultation", "revision", "phase", "producer", "key", "attempt"] as const)
    expect(value.association[field]).toEqual((original as unknown as Record<string, unknown>)[field]);
  expect(value.delivery).toBe("complete");
  return value;
}
function evidenceText(request: Request) {
  return request.task + essentials(request).map(item => JSON.stringify(originalValue(item))).join("\n");
}
function published(result: Result, request: Request): Result {
  if (result.raw) { const { raw, ...value } = result; return value; }
  if (result.structuredOutput === undefined) return result;
  const contract = JSON.parse(request.task.match(/ORIGINAL CONTRACT: (.*)\n/)![1]!);
  const access = (result.structuredOutput as { access?: unknown }).access ?? essentials(request).map(original => {
    originalValue(original); // Controlled reader physically retrieves and validates the exact published original.
    return { id: original.id, state: "accessible", source: original.failedOriginal ? "inline" : "read", reason: "Read and validated exact original and association" };
  });
  const value = { ...contract, access, ...(result.structuredOutput as object) };
  if (request.phase === "architecture-factual") Object.assign(value, { humanContext: `Brief factual frontier from ${contract.association.key}: material facts, reasons, contrary claims, limits and sources.`, ...(result.structuredOutput as object) });
  if (request.phase === "architecture-doubts") Object.assign(value, { humanContext: "Material facts, rationale, contrary evidence and limits for the actual human frontier.", ...(result.structuredOutput as object) });
  const savedOutputPath = path.join(originalsRoot, `${++publicationSequence}.json`);
  const serialized = JSON.stringify(value, null, 2);
  writeFileSync(savedOutputPath, serialized);
  return { ...result, structuredOutput: value, outputReference: savedOutputPath,
    results: [{ savedOutputPath, outputReference: { path: savedOutputPath, bytes: Buffer.byteLength(serialized, "utf8"),
      lines: serialized.split("\n").length, message: "Read this exact original if needed" }, exitCode: result.ok ? 0 : 1 }] };
}
type NativeInput = Parameters<typeof runWorkflowScript>[0];
function nativeScript(input: Omit<NativeInput, "launch"> & {
  launch: (...args: Parameters<NativeInput["launch"]>) => Promise<Omit<WorkflowScriptChildResult, "results"> & { results?: Record<string, unknown>[] }>;
}) {
  return runWorkflowScript({ ...input, launch: async (key, request, signal, admission) => {
    const result = await input.launch(key, request, signal, admission);
    const projected = published(result, request as unknown as Request);
    return { ...result, ...projected, terminalOutcome: result.terminalOutcome, results: projected.results?.map((row, index) => ({
      index, agent: String(request.agent ?? "pitako.architect"), task: String(request.task),
      exitCode: result.ok ? 0 : 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, ...row,
    })) };
  } });
}
interface DurableConsultation {
  rounds: number; validRounds: number;
  cursor: { version: number; phase: string; dispatches: { key: string; boundary: string; originalId: string; runId?: string; terminal?: string }[] };
}
interface DecisionRecord { id: string; content: string; provenance: string }
interface DecisionSnapshot { version: number; brief: string; constraints: string[]; obligations: DecisionRecord[]; humanDecisions: DecisionRecord[]; provenance: string }
interface Continuation { version: number; consultation: string }
interface Outcome {
  status: "completed" | "blocked" | "failed";
  memo?: string;
  error?: string;
  rounds: number;
  validRounds: number;
  steering: { round: number; key: string; state: string }[];
  continuation: Continuation | null;
}
function snapshot(brief: string, extra: Partial<DecisionSnapshot> = {}): DecisionSnapshot {
  return { version: 1, brief, constraints: ["Read-only advice"], obligations: [], humanDecisions: [], provenance: "Actual caller request", ...extra };
}
function replacement(consultation: string, expectedRevision: number, value: ReturnType<typeof snapshot>) {
  return { consultation, expectedRevision, snapshot: value, preservedObligations: [], replacedObligations: [] };
}
const perspectives = [
  { id: "simple", label: "Operational simplicity", focus: "Question complexity; compare complete designs." },
  { id: "recover", label: "Recoverability", focus: "Question recovery assumptions; compare complete designs." },
];
const discuss = { action: "discuss", perspectives, packet: "Shared decision and evidence", memo: "" };
const finish = { action: "finish", perspectives: [], packet: "", memo: "Choose the simpler design; recovery remains uncertain." };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function child(key: string, decision: unknown = finish): Result {
  return {
    ok: true, runId: `native-${key}`,
    structuredOutput: key.startsWith("director-")
      ? key === "director-prepare" ? discuss : decision
      : { status: "ready", report: `Private report from ${key}` },
  };
}
function fixture(
  respond: (key: string, request: Request) => Result | Promise<Result> = key => child(key),
  steer: (key: string) => { state: string } | Promise<{ state: string }> = () => ({ state: "missed" }),
  beforeWrite: (value: DurableConsultation) => void = () => {},
  afterWrite: (value: DurableConsultation) => void = () => {},
) {
  const calls: { key: string; request: Request }[] = [];
  const batches: Request[][] = [];
  const steered: { key: string; message: string; options: unknown }[] = [];
  const seen = new Set<string>();
  function launch(key: string, request: Request): Promise<Result> {
    expect(seen.has(key)).toBe(false);
    seen.add(key);
    calls.push({ key, request });
    return Promise.resolve().then(() => respond(key, request)).then(result => published(result, request)).catch(error => ({ ok: false, error: String(error) }));
  }
  const runs = {
    run(key: string, request: Request): Promise<Result> {
      return launch(key, request).then(result => {
        // Ordinary native terminal failures reject without carrying the result's identity.
        if (!result.ok) throw new Error(`Run '${key}' failed: ${result.error ?? "Child failed"}`);
        return result;
      });
    },
    all(requests: Request[]): Promise<Result[]> {
      batches.push(requests);
      return Promise.all(requests.map(request => launch(request.key!, request)));
    },
    steer(key: string, message: string, options: unknown) {
      steered.push({ key, message, options });
      return Promise.resolve().then(() => steer(key));
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...parameters: string[]
  ) => (args: unknown, runner: typeof runs, state?: unknown) => Promise<Outcome>;
  const privateState = new Map<string, unknown>();
  const stateFile = path.join(originalsRoot, `mission-${++publicationSequence}.json`);
  const stateWrites: { bytes: number; persisted: boolean }[] = [];
  const execute = (args: unknown = { currentDecision: snapshot("Choose a complete persistence design") }, storage: Map<string, unknown> = privateState) =>
    new AsyncFunction("args", "runs", "state", source)({ consultation: "decision", workDescription: "Choose persistence architecture", ...(args as object) }, runs, storage && {
      get: async (key: string) => structuredClone(storage.get(key)),
      set: async (key: string, value: unknown) => {
        const merged = { mission: "owned-test-mission", state: { ...Object.fromEntries(storage), [key]: value } };
        const serialized = JSON.stringify(merged);
        const write = { bytes: Buffer.byteLength(serialized, "utf8"), persisted: false };
        stateWrites.push(write);
        beforeWrite(value as DurableConsultation);
        if (write.bytes > 256 * 1024) throw new Error("Native whole mission capacity exceeded (256 KiB)");
        writeFileSync(stateFile, serialized);
        storage.set(key, structuredClone(value));
        write.persisted = true;
        afterWrite(value as DurableConsultation);
      },
    });
  return { execute, calls, batches, steered, storage: privateState, stateWrites, stateFile };
}

describe("architecture dynamic perspective roles", () => {
  const ids = ["scout", "researcher", "evidence-auditor", "human-relay"];
  const roster = ids.map(id => ({ id, label: id + " perspective", focus: "Compare the whole decision" }));
  const decision = { ...discuss, perspectives: roster };
  const continuation = { version: 2, consultation: "decision" };

  test("keeps all role-like IDs as architect perspectives fresh, resumed and after a confirmed cut", async () => {
    let cut = false;
    const respond = (key: string, request: Request): Result => {
      if (request.phase === "architecture-perspective") {
        const schema = request.outputSchema as { required: string[]; properties: Record<string, unknown> };
        expect(schema.required).not.toContain("humanContext");
        expect(schema.properties.humanContext).toBeUndefined();
        expect(request.task).not.toContain("Also return humanContext:");
        if (key.startsWith("r1-")) expect(request.agent).toBe("pitako.architect");
        else expect(request.resume).toBe("native-r1-" + key.slice(3));
      }
      if (key === "director-prepare" || key === "director-after-r1")
        return { ...child(key), agent: "pitako.architect", structuredOutput: decision };
      return { ...child(key), agent: "pitako.architect" };
    };
    const first = fixture(respond, undefined, undefined, value => {
      if (!cut && value.validRounds === 1) { cut = true; throw new Error("Committed perspective round cut"); }
    });
    await first.execute({ currentDecision: snapshot("Whole problem"), maxRounds: 2 });
    expect(cut).toBe(true);
    const second = fixture(respond);
    expect(await second.execute({ continuation }, first.storage))
      .toMatchObject({ status: "completed", rounds: 2, validRounds: 2 });
    expect(first.calls.filter(call => call.request.phase === "architecture-perspective").map(call => call.key))
      .toEqual(ids.map(id => "r1-" + id));
    expect(second.calls.filter(call => call.request.phase === "architecture-perspective").map(call => call.key))
      .toEqual(ids.map(id => "r2-" + id));
  });

  test.each(ids)("rejects a confirmed insufficient %s perspective as a factual retry target", async id => {
    const first = fixture(key => key === "director-prepare"
      ? { ...child(key), structuredOutput: decision }
      : key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts: [
        { id: "missing", kind: "scout", dependsOn: [], question: "Local fact?", decision: "Reuse" },
      ] } }
      : key === "doubts-r1-0" ? { ...child(key), structuredOutput: { status: "blocked", report: "Insufficient fact" } }
      : { ...child(key), agent: "pitako.architect" });
    expect(await first.execute({ planning: true, currentDecision: snapshot("Whole problem") }))
      .toMatchObject({ status: "failed", rounds: 1, validRounds: 1 });
    const retained = first.storage.get("architecture-decision") as { originals: Original[] };
    const original = retained.originals.find(item => item.key === "r1-" + id)!;
    // Diagnose insufficiency after the confirmed comparison, while the factual frontier is pending.
    original.sufficient = false;
    first.storage.set("architecture-decision", retained);
    const second = fixture();
    await expect(second.execute({ planning: true, continuation, factualRetry: {
      consultation: "decision", revision: 1, originalIds: [original.id],
      authorization: { content: "Retry the missing fact", provenance: "Actual human" },
    } }, first.storage)).rejects.toThrow("Invalid factual retry");
    expect(second.calls).toHaveLength(0);
  });

  test.each(ids)("does not authorize factual retry for a terminal undelivered %s perspective", async id => {
    const first = fixture((key, request) => key === "director-prepare"
      ? { ...child(key), structuredOutput: decision }
      : key === "r1-" + id ? { ok: false, runId: "failed-perspective", error: "Terminal non-delivery" }
      : { ...child(key), agent: "pitako.architect" });
    expect(await first.execute({ planning: true, currentDecision: snapshot("Whole problem") }))
      .toMatchObject({ status: "failed", rounds: 1, validRounds: 0 });
    const original = (first.storage.get("architecture-decision") as { originals: Original[] }).originals
      .find(item => item.key === "r1-" + id)!;
    expect(original).toMatchObject({ delivery: "not-delivered", publication: "unpublished" });
    const second = fixture();
    await expect(second.execute({ planning: true, continuation, factualRetry: {
      consultation: "decision", revision: 1, originalIds: [original.id],
      authorization: { content: "Retry the missing fact", provenance: "Actual human" },
    } }, first.storage)).rejects.toThrow("Unconfirmed architecture dispatch boundary");
    expect(second.calls).toHaveLength(0);
  });
});

describe("architecture scripted workflow", () => {
  test("validates the sibling-dispatching script and uses explicit work titles and phases for all fresh and resumed producers", async () => {
    expect(validateWorkflowScript(source)).toEqual({ ok: true, errors: [] });
    const description = ("Choose recovery persistence " + "with complete recovery evidence ".repeat(12)).trim();
    const host = fixture((key, request) => {
      const title = request.task.split("\n")[0]!;
      expect(request.label).toBe(title);
      expect(title).toContain(description);
      expect(title).not.toContain("Architecture design advice only");
      expect(title.indexOf(": ")).toBeLessThan(title.indexOf(description));
      expect(request.task).toContain("ADMINISTRATIVE PREAMBLE: whole current problem");
      const expected = key === "director-prepare" ? "architecture-prepare"
        : key.startsWith("director-after-") ? "architecture-evaluate"
        : key.startsWith("director-doubts-") ? "architecture-doubts"
        : key.startsWith("doubts-") ? "architecture-factual"
        : key.startsWith("human-") ? "architecture-human" : "architecture-perspective";
      expect(request.phase).toBe(expected);
      if (key.startsWith("r")) expect(title).toContain(key.startsWith("r1-") ? "Round 1" : "Round 2");
      if (key.startsWith("director-doubts-")) return { ...child(key), structuredOutput: { doubts: [
        { id: "fact", kind: "scout", dependsOn: [], question: "Local contract?", decision: "Reuse" },
        { id: "external", kind: "researcher", dependsOn: [], question: "External contract?", decision: "Reuse" },
        { id: "conflict", kind: "evidence-auditor", dependsOn: [], question: "Contradictory claims?", decision: "Reuse" },
        { id: "human", kind: "human", dependsOn: ["fact"], question: "Prefer reuse (recommended)?", decision: "Scope" },
      ] } };
      return child(key, key === "director-after-r1" ? discuss : finish);
    });
    const result = await host.execute({ workDescription: description, planning: true,
      currentDecision: snapshot("ADMINISTRATIVE PREAMBLE: whole current problem") });
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(2);
    for (const phase of ["architecture-prepare", "architecture-evaluate", "architecture-doubts", "architecture-perspective", "architecture-factual", "architecture-human"])
      expect(host.calls.some(call => call.request.phase === phase)).toBe(true);
    expect(host.calls.find(call => call.key === "director-prepare")?.request.context).toBe("fresh");
    expect(host.calls.find(call => call.key === "director-after-r1")?.request.resume).toBe("native-director-doubts-r1");
    expect(host.calls.find(call => call.key === "director-doubts-r2")?.request.resume).toBe("native-director-after-r1");
    for (const member of perspectives) {
      expect(host.calls.find(call => call.key === "r1-" + member.id)?.request.context).toBe("fresh");
      expect(host.calls.find(call => call.key === "r2-" + member.id)?.request.resume).toBe("native-r1-" + member.id);
    }
  });

  test.each([undefined, "", " ", "first\nsecond"])("rejects missing or multiline workDescription %j before dispatch", async workDescription => {
    const host = fixture();
    await expect(host.execute({ workDescription, currentDecision: snapshot("Cannot infer a title from this brief") })).rejects.toThrow("workDescription");
    expect(host.calls).toHaveLength(0);
  });

  test("keeps an independent first round fresh and returns only the final memo and references", async () => {
    const host = fixture();
    const result = await host.execute();
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(1);
    expect(result.validRounds).toBe(1);
    expect(host.batches.filter(batch => batch.length === 2)).toHaveLength(1);
    expect(host.batches.find(batch => batch.length === 2)).toHaveLength(2);
    expect(host.steered).toHaveLength(0);
    for (const request of host.batches.find(batch => batch.length === 2)!) {
      expect(request.context).toBe("fresh");
      expect(request.agent).toBe("pitako.architect");
      expect(request.task).toContain("Choose a complete persistence design");
    }
    for (const { request } of host.calls) {
      if (!request.resume) expect(request.agent).toBe("pitako.architect");
      expect(request.async).toBeUndefined();
      expect(request.output).toMatch(/^architecture\//);
      expect(request.outputMode).toBe("file-only");
      expect(request.outputSchema).toBeDefined();
    }
    expect(JSON.stringify(result)).not.toContain("Private report");
    expect(result.memo).toBe(finish.memo);
    expect(host.storage.get("architecture-decision")).toMatchObject({ directorRunId: "native-director-after-r1" });
  });

  test("enforces a ten-round maximum and preserves the director's latest native reference", async () => {
    const host = fixture(key => child(key, key === "director-after-r10" ? finish : discuss));
    const result = await host.execute();
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(10);
    expect(result.validRounds).toBe(10);
    expect(host.calls.filter(call => /^r\d+-/.test(call.key))).toHaveLength(20);
    expect(host.storage.get("architecture-decision")).toMatchObject({ directorRunId: "native-director-after-r10" });
    expect(host.calls.find(call => call.key === "director-after-r10")?.request.resume)
      .toBe("native-director-after-r9");
    expect(host.calls.some(call => call.key.startsWith("r11-"))).toBe(false);
  });

  test("refuses an extra requested round instead of reporting a false synthesis", async () => {
    const host = fixture(key => child(key, discuss));
    const result = await host.execute({ currentDecision: snapshot("Decision"), maxRounds: 1 });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("beyond the limit");
    expect(result.rounds).toBe(1);
    expect(host.calls.filter(call => /^r\d+-/.test(call.key))).toHaveLength(2);
    expect(result.memo).toBeUndefined();
  });

  test.each(["delivered", "missed", "failed"])(
    "rolls later reports into stable-key steering and records %s without a retry",
    async state => {
      const late = deferred<Result>();
      const host = fixture(
        async (key, request) => {
          if (key !== "r2-recover") return child(key, key === "director-after-r1" ? discuss : finish);
          const result = await late.promise;
          if (state !== "delivered") return result;
          const challenge = JSON.parse(host.steered[0]!.message.split("\n")[2]!) as Original;
          originalValue(challenge);
          return { ...result, structuredOutput: { ...(result.structuredOutput as object), access: [...essentials(request), challenge].map(item => ({
            id: item.id, state: "accessible", source: "read", reason: "Read and validated exact original, including newly steered challenge",
          })) } };
        },
        key => {
          late.resolve(child(key));
          expect(key).toBe("r2-recover");
          return { state };
        },
      );
      const result = await host.execute();
      expect(result.status).toBe("completed");
      expect(result.rounds).toBe(2);
      expect(host.batches.find(batch => batch.length === 2)).toHaveLength(2);
      expect(host.steered).toHaveLength(1);
      expect(host.steered[0]?.message).toContain("native-r2-simple");
      expect(host.steered[0]?.message).not.toContain("Private report from r2-simple");
      expect(result.steering).toEqual([{ round: 2, key: "r2-recover", state }]);
      const resumed = host.calls.find(call => call.key === "r2-recover")!.request;
      expect(resumed.resume).toBe("native-r1-recover");
      expect(resumed.agent).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("Private report");
    },
  );

  test("does not finish or replace a failed member before its sibling settles", async () => {
    const waiting = deferred<Result>();
    const entered = deferred<void>();
    const host = fixture(key => {
      if (key === "r1-simple") throw new Error("Controlled child failure");
      if (key === "r1-recover") { entered.resolve(); return waiting.promise; }
      return child(key);
    });
    let finished = false;
    const execution = host.execute().then(result => { finished = true; return result; });
    await entered.promise;
    let result: Outcome;
    try {
      expect(finished).toBe(false);
      expect(host.calls.map(call => call.key)).toEqual(["director-prepare", "r1-simple", "r1-recover"]);
    } finally {
      waiting.resolve(child("r1-recover"));
      result = await execution;
    }
    expect(result.status).toBe("failed");
    expect(result.error).toContain("simple");
    expect(result.validRounds).toBe(0);
    expect(host.calls).toHaveLength(3);
    expect(host.storage.get("architecture-decision")).toMatchObject({ members: [{ id: "recover", runId: "native-r1-recover" }] });
  });

  test("settles rolling siblings after a rejected child, without launching a replacement", async () => {
    const waiting = deferred<Result>();
    const entered = deferred<void>();
    const host = fixture(key => {
      if (key === "r2-simple") throw new Error("Controlled rolling failure");
      if (key === "r2-recover") { entered.resolve(); return waiting.promise; }
      return child(key, key === "director-after-r1" ? discuss : finish);
    });
    let finished = false;
    const execution = host.execute().then(result => { finished = true; return result; });
    await entered.promise;
    let result: Outcome;
    try { expect(finished).toBe(false); }
    finally { waiting.resolve(child("r2-recover")); result = await execution; }
    expect(result.status).toBe("failed");
    expect(result.rounds).toBe(2);
    expect(result.validRounds).toBe(1);
    expect(host.steered).toHaveLength(0);
    expect(host.calls.some(call => call.key === "director-after-r2")).toBe(false);
  });

  test("resends the exact compact ordinary continuation through native args validation despite retained empty control strings", async () => {
    const storage = new Map<string, unknown>();
    const first = await fixture().execute(undefined, storage);
    const host = fixture();
    expect(first.continuation).toEqual({ version: 2, consultation: "decision" });
    expect(structuredClone(storage.get("architecture-decision"))).toMatchObject({ cursor: { dispatches: expect.arrayContaining([
      expect.objectContaining({ key: "director-prepare", controlOutput: expect.objectContaining({ memo: "" }) }),
      expect.objectContaining({ key: "director-after-r1", controlOutput: expect.objectContaining({ packet: "" }) }),
    ]) } });
    const reentry = { consultation: "decision", workDescription: "Choose persistence architecture",
      evidence: "New recovery evidence", continuation: first.continuation };
    const normalized = normalizeWorkflowArgs(reentry);
    expect(normalized).toEqual({ args: reentry });
    if ("error" in normalized) throw new Error(normalized.error);
    const result = await host.execute(normalized.args, storage);
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(2);
    expect(result.validRounds).toBe(2);
    expect(host.calls[0]?.request.resume).toBe("native-director-after-r1");
    for (const { request } of host.calls) expect(request.agent).toBeUndefined();
    const member = host.calls.find(call => call.key === "r2-simple")!.request;
    expect(member.task).toContain("Choose a complete persistence design");
    expect(member.task).toContain("New recovery evidence");
    expect(member.resume).toBe("native-r1-simple");
    expect(storage.get("architecture-decision")).toMatchObject({ members: [
      { id: "simple", runId: "native-r2-simple" }, { id: "recover", runId: "native-r2-recover" },
    ] });
  });

  test("cannot complete a resumed consultation whose initial comparison failed", async () => {
    const storage = new Map<string, unknown>();
    const failed = await fixture(key => key === "r1-simple"
      ? { ...child(key), structuredOutput: { status: "blocked", report: "Missing evidence" } }
      : child(key)).execute(undefined, storage);
    expect(failed.status).toBe("failed");
    expect(failed.rounds).toBe(1);
    const resumed = fixture(key => ({ ...child(key), structuredOutput: finish }));
    const result = await resumed.execute({ evidence: "Continue", continuation: failed.continuation }, storage);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("valid multi-perspective round");
    expect(result.rounds).toBe(1);
    expect(result.validRounds).toBe(0);
    expect(resumed.calls).toHaveLength(1);
  });

  test("can recover with a valid comparison without resetting the consumed budget", async () => {
    const storage = new Map<string, unknown>();
    const failed = await fixture(key => key === "r1-simple"
      ? { ...child(key), structuredOutput: { status: "blocked", report: "Missing evidence" } }
      : child(key)).execute(undefined, storage);
    const recovered = await fixture().execute({ evidence: "Evidence supplied", continuation: failed.continuation }, storage);
    expect(recovered.status).toBe("completed");
    expect(recovered.rounds).toBe(2);
    expect(recovered.validRounds).toBe(1);
    expect(storage.get("architecture-decision")).toMatchObject({ validRounds: 1 });
  });

  test("retains a prior valid comparison when a later round fails", async () => {
    const storage = new Map<string, unknown>();
    const first = await fixture().execute(undefined, storage);
    const failed = await fixture(key => key === "r2-simple"
      ? { ...child(key), structuredOutput: { status: "blocked", report: "Missing new evidence" } }
      : child(key)).execute({ evidence: "New question", continuation: first.continuation }, storage);
    expect(failed.status).toBe("failed");
    expect(failed.rounds).toBe(2);
    expect(failed.validRounds).toBe(1);
    const stopped = await fixture(key => ({ ...child(key), structuredOutput: finish }))
      .execute({ evidence: "Synthesize existing evidence", continuation: failed.continuation }, storage);
    expect(stopped.status).toBe("completed");
    expect(stopped.rounds).toBe(2);
    expect(stopped.validRounds).toBe(1);
  });

  test("a trivial reentry cannot reset a continuation's consumed rounds", async () => {
    const storage = new Map<string, unknown>();
    const first = await fixture().execute({ currentDecision: snapshot("Old decision"), maxRounds: 1 }, storage);
    const host = fixture();
    await expect(host.execute({ currentDecision: snapshot("Old decision"), continuation: first.continuation, newDecision: true }, storage)).rejects.toThrow("cannot reset");
    const capped = await host.execute({ evidence: "Continue", continuation: first.continuation }, storage);
    expect(capped.status).toBe("failed"); expect(capped.error).toContain("beyond the limit");
    expect(host.calls).toHaveLength(1);
  });

  test("preserves ordinary explicit-new-decision director reuse without retaining old members or count", async () => {
    const storage = new Map<string, unknown>();
    const first = await fixture().execute({ currentDecision: snapshot("Old decision"), maxRounds: 1 }, storage);
    const host = fixture();
    const result = await host.execute({ consultation: "new-decision", currentDecision: snapshot("New complete decision"), continuation: first.continuation, newDecision: true }, storage);
    expect(result.status).toBe("completed"); expect(result.rounds).toBe(1); expect(result.validRounds).toBe(1);
    expect(storage.get("architecture-new-decision")).toMatchObject({ maxRounds: 10 });
    expect(host.calls[0]?.request.resume).toBe("native-director-after-r1");
    expect(host.batches.find(batch => batch.length === 2)?.every(request => request.context === "fresh")).toBe(true);
    expect(storage.get("architecture-new-decision")).toMatchObject({ currentDecision: { snapshot: { brief: "New complete decision" } } });
  });

  test("reports an explicit director blocker without a fanout", async () => {
    const host = fixture(key => ({
      ...child(key), structuredOutput: { ...finish, action: "blocked", memo: "Choose the required recovery objective." },
    }));
    const result = await host.execute();
    expect(result.status).toBe("blocked");
    expect(result.memo).toContain("recovery objective");
    expect(host.calls).toHaveLength(1);
  });

  test("does not equate process success with a usable structured decision", async () => {
    const host = fixture(key => ({ ok: true, runId: `native-${key}` }));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(host.calls).toHaveLength(1);
    expect(host.storage.get("architecture-decision")).toMatchObject({ directorRunId: null });
    expect(host.storage.get("architecture-decision")).toMatchObject({ cursor: { dispatches: [
      { key: "director-prepare", boundary: "incomplete", runId: "native-director-prepare" },
    ] } });
  });

  test("does not silently replace a director whose native resume fails", async () => {
    const storage = new Map<string, unknown>();
    const first = await fixture().execute(undefined, storage);
    const host = fixture(() => { throw new Error("Native retained session unavailable"); });
    const result = await host.execute({ evidence: "More evidence", continuation: first.continuation }, storage);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("session unavailable");
    expect(host.calls).toHaveLength(1);
    expect(storage.get("architecture-decision")).toMatchObject({ directorRunId: "native-director-after-r1" });
  });

  test.each([
    { currentDecision: snapshot("") }, { currentDecision: snapshot("Decision"), maxRounds: 11 },
    { currentDecision: snapshot("Decision"), maxRounds: 1.5 }, { currentDecision: snapshot("Decision"), newDecision: "yes" },
    { currentDecision: snapshot("Decision"), continuation: null }, { currentDecision: snapshot("Decision"), continuation: { version: 99 } },
  ])("rejects invalid input before dispatch: %j", async args => {
    const host = fixture();
    await expect(host.execute(args)).rejects.toThrow();
    expect(host.calls).toHaveLength(0);
  });
});

describe("architecture current complete decision", () => {
  const obligation = { id: "recover", content: "Retain recoverability", provenance: "Actual request paragraph 2" };
  const human = { id: "scope", content: "Keep local storage only", provenance: "Foreground human message 42" };
  const initial = () => snapshot("OBSOLETE mechanism A", { obligations: [obligation], humanDecisions: [human] });
  const updated = () => snapshot("CURRENT mechanism B is the whole problem", {
    constraints: ["Read-only advice", "Do not contact remote services"], obligations: [obligation], humanDecisions: [human],
    provenance: "Caller complete replacement, human message 43",
  });
  const update = () => ({ ...replacement("current", 1, updated()), preservedObligations: [obligation.id] });
  async function admitted(storage: Map<string, unknown>, planning = true) {
    return fixture(key => key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts: [] } } : child(key))
      .execute({ consultation: "current", planning, currentDecision: initial() }, storage);
  }
  test.each([false, true])("persists one complete replacement before all fresh/resumed producers and keeps history out of active prompts (planning=%s)", async planning => {
    const storage = new Map<string, unknown>();
    const first = await admitted(storage, planning);
    const priorEvidence = structuredClone((storage.get("architecture-current") as { evidence: unknown[] }).evidence);
    const host = fixture((key, request) => {
      const retained = storage.get("architecture-current") as { currentDecision: unknown; decisionHistory: { snapshot: unknown }[]; evidence: unknown[] };
      expect(retained.currentDecision).toEqual({ revision: 2, snapshot: updated() });
      expect(retained.decisionHistory[0]?.snapshot).toEqual(initial());
      expect(retained.evidence.slice(0, priorEvidence.length)).toEqual(priorEvidence);
      expect(request.task).not.toContain("OBSOLETE mechanism A");
      expect(request.task.split("CURRENT mechanism B is the whole problem")).toHaveLength(2);
      for (const value of [human.content, human.provenance, obligation.content, obligation.provenance, ...updated().constraints])
        expect(request.task).toContain(value);
      if (key === "director-prepare") return { ...child(key), structuredOutput: { ...discuss, perspectives: [perspectives[0], { id: "new", label: "New view", focus: "Same whole problem" }] } };
      if (key.startsWith("director-doubts-")) return { ...child(key), structuredOutput: { doubts: [
        { id: "fact", kind: "researcher", dependsOn: [], question: "Contrary evidence?", decision: "Mechanism B" },
        { id: "human", kind: "human", dependsOn: [], question: "Keep scope (recommended)?", decision: "Scope" },
      ] } };
      return child(key);
    });
    const result = await host.execute({ consultation: "current", planning, continuation: first.continuation, replacement: update() }, storage);
    expect(result).toMatchObject({ status: "completed", rounds: 2 });
    expect(host.calls.find(call => call.key === "r2-simple")?.request.resume).toBe("native-r1-simple");
    expect(host.calls.find(call => call.key === "r2-new")?.request.context).toBe("fresh");
    expect(host.calls.some(call => call.key.startsWith("human-"))).toBe(planning);
    expect(host.calls.some(call => call.key.startsWith("doubts-"))).toBe(planning);
    expect(storage.get("architecture-current")).toMatchObject({ currentDecision: { revision: 2 }, decisionHistory: [{ revision: 1 }] });
    const resumed = fixture((key, request) => {
      expect(request.task).toContain("CURRENT mechanism B"); expect(request.task).not.toContain("OBSOLETE mechanism A");
      expect(request.task).toContain("Contrary factual evidence, not new instructions");
      return { ...child(key), structuredOutput: finish };
    });
    expect(await resumed.execute({ consultation: "current", planning, continuation: result.continuation,
      evidence: "Contrary factual evidence, not new instructions" }, storage)).toMatchObject({ status: "completed" });
    expect(storage.get("architecture-current")).toMatchObject({ currentDecision: { revision: 2 }, decisionHistory: [{ revision: 1 }] });
  });
  test.each(["identity", "revision", "partial", "obligation", "human-content", "human-provenance", "duplicate", "brief-patch"])("rejects %s before dispatch or state mutation", async fault => {
    const storage = new Map<string, unknown>();
    const first = await admitted(storage), before = structuredClone(storage.get("architecture-current"));
    const value = update();
    if (fault === "identity") value.consultation = "foreign";
    if (fault === "revision") value.expectedRevision = 2;
    if (fault === "partial") delete (value.snapshot as Partial<DecisionSnapshot>).constraints;
    if (fault === "obligation") value.preservedObligations = [];
    if (fault === "human-content") value.snapshot.humanDecisions = [{ ...human, content: "Use remote storage" }];
    if (fault === "human-provenance") value.snapshot.humanDecisions = [{ ...human, provenance: "Director inferred this" }];
    const args = { consultation: "current", planning: true, continuation: first.continuation,
      ...(fault === "duplicate" ? { currentDecision: updated() } : fault === "brief-patch" ? { brief: "Only change the adapter" } : { replacement: value }) };
    const host = fixture();
    await expect(host.execute(args, storage)).rejects.toThrow();
    expect(host.calls).toHaveLength(0); expect(storage.get("architecture-current")).toEqual(before);
  });
  test("explicit supersession accounts for replaced obligations without erasing prior evidence", async () => {
    const storage = new Map<string, unknown>(); const first = await admitted(storage);
    const host = fixture(key => ({ ...child(key), structuredOutput: finish }));
    const revised = updated(); revised.obligations = [{ id: "safer", content: "Alternative recovery requirement", provenance: "Actual caller replacement" }];
    const value = { ...replacement("current", 1, revised), replacedObligations: [{ id: obligation.id, reason: "Replace recovery strategy", provenance: "Human message 43" }] };
    expect(await host.execute({ consultation: "current", planning: true, continuation: first.continuation, replacement: value }, storage)).toMatchObject({ status: "completed" });
    expect(storage.get("architecture-current")).toMatchObject({ currentDecision: { revision: 2, snapshot: revised },
      decisionHistory: [{ snapshot: initial(), replacement: { replacedObligations: value.replacedObligations } }],
      evidence: expect.arrayContaining([expect.objectContaining({ round: 1 })]) });
  });
  test("failed replacement persistence dispatches nothing and does not retry the failed save", async () => {
    const storage = new Map<string, unknown>(); const first = await admitted(storage);
    const before = structuredClone(storage.get("architecture-current")); let writes = 0, launches = 0;
    const run = new (Object.getPrototypeOf(async function () {}).constructor)("args", "runs", "state", source);
    await expect(run({ workDescription: "Choose persistence architecture", consultation: "current", planning: true, continuation: first.continuation, replacement: update() },
      { run() { launches++; }, all() { launches++; } }, {
        get: () => structuredClone(storage.get("architecture-current")), set: () => { writes++; throw new Error("Essential replacement save failed"); },
      })).rejects.toThrow("Essential replacement save failed");
    expect(writes).toBe(1); expect(launches).toBe(0); expect(storage.get("architecture-current")).toEqual(before);
  });
  test.each([false, true])("rejects duplicate initial admission and missing native continuation (planning=%s)", async planning => {
    const storage = new Map<string, unknown>(); const first = await admitted(storage, planning);
    const duplicate = fixture();
    await expect(duplicate.execute({ consultation: "current", planning, currentDecision: initial() }, storage)).rejects.toThrow("Duplicate initial");
    expect(duplicate.calls).toHaveLength(0);
    const missing = fixture();
    await expect(missing.execute({ consultation: "current", planning, continuation: first.continuation }, new Map())).rejects.toThrow("Missing retained");
    expect(missing.calls).toHaveLength(0);
  });
  test.each([undefined, { version: 1, brief: "Partial legacy brief" }, { version: 1, brief: "Incomplete", constraints: [], obligations: [], humanDecisions: [] }])("initial admission requires the complete caller snapshot: %j", async currentDecision => {
    const host = fixture(); await expect(host.execute({ consultation: "current", currentDecision })).rejects.toThrow("complete currentDecision");
    expect(host.calls).toHaveLength(0);
  });
  test.each([false, true])("initial admission is durable before the first director; incompatible state and foreign continuation reject (planning=%s)", async planning => {
    const storage = new Map<string, unknown>();
    const host = fixture(key => {
      expect(storage.get("architecture-current")).toMatchObject({ version: 2, currentDecision: { revision: 1, snapshot: initial() } });
      return { ...child(key), structuredOutput: { ...finish, action: "blocked" } };
    });
    await host.execute({ consultation: "current", planning, currentDecision: initial() }, storage);
    for (const continuation of [{ version: 1, consultation: "current" }, { version: 2, consultation: "foreign" }]) {
      const rejected = fixture(); await expect(rejected.execute({ consultation: "current", planning, continuation }, storage)).rejects.toThrow();
      expect(rejected.calls).toHaveLength(0);
    }
  });
});

describe("planning architecture evidence and doubts", () => {
  test.each([2, 10])("retains the entire mixed inadequate round before validation at round %i", async round => {
    const storage = new Map<string, unknown>();
    const objection = "New contrary evidence: recovery loses the assignment";
    const blocker = "Unanswered blocker: cannot validate ownership";
    const blockedSettled = deferred<void>();
    const pointers = { artifactPaths: ["/native/contrary.json"], outputReference: "/native/contrary.md", asyncDir: "/native/contrary" };
    const host = fixture(async key => {
      if (key === `r${round}-simple`) {
        blockedSettled.resolve();
        return { ok: false, runId: `native-${key}`, ...pointers, error: "Native failure with blocked report", structuredOutput: { status: "blocked", report: blocker } };
      }
      if (key === `r${round}-recover`) {
        await blockedSettled.promise;
        return { ok: true, runId: `native-${key}`, ...pointers, structuredOutput: { status: "ready", report: objection } };
      }
      if (key.startsWith("director-doubts-")) return { ok: true, runId: `native-${key}`, structuredOutput: { doubts: [] } };
      return child(key, discuss);
    });
    const failed = await host.execute({ currentDecision: snapshot("Decision"), planning: true, consultation: "mixed", maxRounds: 10 }, storage);
    expect(failed).toMatchObject({ status: "failed", rounds: round, validRounds: round - 1, error: expect.stringContaining("No adequate report from simple. No replacement or retry was launched.") });
    expect(host.steered.filter(item => item.message.includes(`round ${round},`))).toHaveLength(0);
    expect(host.calls.some(item => item.key === `director-doubts-r${round}`)).toBe(false);
    const retained = storage.get("architecture-mixed") as { originals: Original[] };
    const failedOriginal = retained.originals.find(item => item.key === `r${round}-simple`)!;
    expect(failedOriginal).toMatchObject({ sufficient: false, runId: `native-r${round}-simple`, publication: "published" });
    expect(originalValue(failedOriginal)).toMatchObject({ status: "blocked", report: blocker });
    expect(originalValue(retained.originals.find(item => item.key === `r${round}-recover`)!)).toMatchObject({ report: objection });
    expect(JSON.stringify(retained)).not.toContain(blocker); // Published originals are never copied into native state.
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-prepare"); expect(request.resume).toBe(`native-director-after-r${round - 1}`);
      for (const evidence of [objection, blocker, "Native failure with blocked report"]) expect(evidenceText(request)).toContain(evidence);
      expect(request.task).toContain(`Consumed rounds: ${round}/10`);
      expect(request.task).toContain(`native-r${round}-simple`); expect(request.task).toContain(`native-r${round}-recover`);
      expect(request.task.includes("finish or blocked only")).toBe(round === 10);
      return { ok: true, runId: "native-reconciled", structuredOutput: { ...finish, action: "blocked", memo: blocker } };
    });
    expect(await resumed.execute({ evidence: "Reconcile mixed failed round", planning: true, consultation: "mixed", continuation: failed.continuation }, storage))
      .toMatchObject({ status: "blocked", rounds: round, validRounds: round - 1 });
    expect(resumed.calls).toHaveLength(1);
    expect(storage.get("architecture-mixed")).toMatchObject({ members: perspectives.map(member => ({ ...member, runId: `native-r${round}-${member.id}` })) });
  });
  test.each([2, 10])("persists settled objections but blocks ambiguous doubts reentry at round %i", async (limit) => {
    const storage = new Map<string, unknown>();
    const objection = "Material objection: proposed recovery loses the assignment";
    const host = fixture((key, request) => {
      if (key === `director-doubts-r${limit}`) {
        // Fail before delivery to the retained director, not after it saw the reports.
        const retained = storage.get("architecture-failure") as { originals: Original[]; rounds: number; validRounds: number };
        expect(retained).toMatchObject({ rounds: limit, validRounds: limit });
        expect(originalValue(retained.originals.find(item => item.key === `r${limit}-recover`)!)).toMatchObject({ report: objection });
        throw new Error("Controlled dispatch failure before delivery");
      }
      if (key.startsWith("director-doubts-")) return { ok: true, runId: `native-${key}`, structuredOutput: { doubts: [] } };
      if (key === `r${limit}-recover`) return { ok: true, runId: `native-${key}`, structuredOutput: { status: "ready", report: objection } };
      return child(key, discuss);
    });
    const failed = await host.execute({ currentDecision: snapshot("Decision"), planning: true, consultation: "failure", maxRounds: limit }, storage);
    expect(failed).toMatchObject({ status: "failed", rounds: limit, validRounds: limit, error: expect.stringContaining("Controlled dispatch failure before delivery") });
    const resumed = fixture();
    await expect(resumed.execute({ evidence: "Reconcile the failed doubts delivery", planning: true, consultation: "failure", continuation: failed.continuation }, storage))
      .rejects.toThrow("Unconfirmed architecture dispatch boundary");
    expect(resumed.calls).toHaveLength(0);
    expect(storage.get("architecture-failure")).toMatchObject({ members: expect.arrayContaining([
      expect.objectContaining({ id: "recover", runId: `native-r${limit}-recover` }),
    ]) });
  });

  test("resolves actual doubts between rounds and delivers contrary evidence to the complete discussion", async () => {
    const storage = new Map<string, unknown>();
    const host = fixture((key, request) => {
      if (key.startsWith("director-doubts-")) return { ok: true, runId: `native-${key}`, structuredOutput: { doubts: key.endsWith("r1") ? [
        { id: "local", dependsOn: [], kind: "scout", question: "Where is ownership?", decision: "Reuse or replace existing seam" },
        { id: "external", dependsOn: [], kind: "researcher", question: "Does v0.82 support this?", decision: "Choose native boundary" },
        { id: "conflict", dependsOn: [], kind: "evidence-auditor", question: "Conflicting recovery claim", decision: "Fail safely" },
      ] : [] } };
      if (key.startsWith("doubts-")) return { ok: true, runId: `native-${key}`, structuredOutput: { status: "ready", report: "Contrary primary v0.82 evidence; limitation remains" } };
      if (key.startsWith("r2-")) expect(evidenceText(request)).toContain("Contrary primary v0.82 evidence");
      return child(key, key === "director-after-r1" ? discuss : finish);
    });
    const result = await host.execute({ currentDecision: snapshot("Complete decision with initial evidence"), planning: true, consultation: "same", maxRounds: 10 }, storage);
    expect(result.status).toBe("completed"); expect(result.rounds).toBe(2);
    const keys = host.calls.map(call => call.key);
    expect(keys.indexOf("director-doubts-r1")).toBeGreaterThan(keys.indexOf("r1-recover"));
    expect(keys.indexOf("director-after-r1")).toBeGreaterThan(keys.indexOf("doubts-r1-2"));
    expect(host.calls.filter(call => call.key.startsWith("doubts-")).map(call => call.request.agent))
      .toEqual(["pitako.scout", "pitako.researcher", "pitako.evidence-auditor"]);
    expect(storage.get("architecture-same")).toMatchObject({ rounds: 2, maxRounds: 10 });
  });

  test("human doubts return to foreground without asking a child to approve, then continue the same retained counter", async () => {
    const storage = new Map<string, unknown>();
    const first = fixture(key => key.startsWith("director-doubts-") ? { ok: true, runId: `native-${key}`, structuredOutput: { doubts: [
      { id: "scope", dependsOn: [], kind: "human", question: "Prefer scope A?", decision: "Scope boundary" },
    ] } } : key.startsWith("human-") ? { ok: true, runId: key, structuredOutput: { status: "blocked", report: "Prefer scope A? Awaiting actual human answer." } } : child(key));
    const blocked = await first.execute({ currentDecision: snapshot("Decision"), planning: true, consultation: "same", maxRounds: 2 }, storage);
    expect(blocked.status).toBe("blocked"); expect(blocked.memo).toContain("unanswered"); expect(blocked.rounds).toBe(1);
    expect(first.calls.find(call => call.key.startsWith("human-"))?.request.task).toContain("Prefer scope A?");
    expect(first.calls.some(call => call.key.startsWith("doubts-"))).toBe(false);
    const resumed = fixture(key => key.startsWith("director-doubts-") ? { ok: true, runId: key, structuredOutput: { doubts: [] } } : child(key));
    const done = await resumed.execute({ replacement: replacement("same", 1, snapshot("Decision; Actual human answered A", { humanDecisions: [{ id: "scope", content: "A", provenance: "Actual foreground human answer" }] })), planning: true, consultation: "same", continuation: blocked.continuation }, storage);
    expect(done.rounds).toBe(2); expect(storage.get("architecture-same")).toMatchObject({ maxRounds: 2 });
    const missing = fixture();
    await expect(missing.execute({ evidence: "Trivial reentry without a continuation", planning: true, consultation: "same" }, storage)).rejects.toThrow("missing explicit");
    expect(missing.calls).toHaveLength(0);
    const capped = await fixture().execute({ evidence: "Same continuation", planning: true, consultation: "same", continuation: done.continuation }, storage);
    expect(capped.status).toBe("failed"); expect(capped.rounds).toBe(2);
  });

  test("planning cannot use an ephemeral consultation or reset native retained rounds through a supplied continuation", async () => {
    const host = fixture();
    await expect(new (Object.getPrototypeOf(async function () {}).constructor)("args", "runs", "state", source)(
      { currentDecision: snapshot("Decision"), planning: true, consultation: "same" }, {})).rejects.toThrow("explicit native mission");
    const storage = new Map<string, unknown>();
    const finished = await fixture(key => key.startsWith("director-doubts-")
      ? { ...child(key), structuredOutput: { doubts: [] } } : child(key))
      .execute({ currentDecision: snapshot("Decision"), planning: true, consultation: "same", maxRounds: 1 }, storage);
    const capped = await host.execute({ evidence: "Reentry", planning: true, consultation: "same", continuation: { ...finished.continuation, rounds: 0 } }, storage);
    expect(capped.status).toBe("failed"); expect(capped.rounds).toBe(1);
    await expect(host.execute({ currentDecision: snapshot("Changed label"), planning: true, consultation: "same", newDecision: true }, storage)).rejects.toThrow("cannot reset");
    expect(host.calls).toHaveLength(1);
  });
});

// Controlled model boundary: drive the packaged relay's sole tool through a private
// native supervisor channel. No model/provider, detached runner, or host UI is used.
function supervisorRelay() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-architecture-interview-"));
  type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text?: string }[] }> };
  const tools = new Map<string, Tool>();
  const notices: { details: { requestId: string; requestBody: string } }[] = [];
  const first = deferred<void>(), second = deferred<void>();
  const api = { registerTool: (tool: Tool) => { tools.set(tool.name, tool); },
    getAllTools: () => [...tools.values()], on: () => {}, events: { on: () => () => {}, emit: () => {} } } as unknown as ExtensionAPI;
  const state = createChildSafeState(); state.supervisorOwnerSessionId = "owned-planning-parent";
  const channel = createNativeSupervisorChannel(api, state, { getChannelDirs: () => ({ dirs: [root] }),
    parentWake: { sendMessage: message => {
      notices.push(message as unknown as typeof notices[number]);
      (notices.length === 1 ? first : second).resolve();
      return true;
    } } });
  channel.start();
  return { notices, first: first.promise, second: second.promise,
    launch(key: string, request: Request): Promise<Result> {
      const questions = JSON.parse(request.task.match(/FRONTIER \(data\): (.+)\n/)![1]!);
      let contact!: Tool;
      registerNativeSupervisorClient({ registerTool: (tool: Tool) => { contact = tool; }, getAllTools: () => [] } as unknown as ExtensionAPI,
        { channelDir: root, runId: key, agent: "pitako.interview-relay", childIndex: 0, orchestratorSessionId: "owned-planning-parent" });
      const reply = contact.execute(key, {
        reason: "interview_request", message: JSON.stringify(questions), interview: { title: "Planning decisions", questions },
      });
      channel.activateTransport();
      return reply.then(value => ({ ok: true, runId: `native-${key}`, structuredOutput: {
        status: "ready", report: value.content.map(item => item.text ?? "").join("\n"),
      } }));
    },
    reply: (requestId: string) => tools.get("subagent_supervisor")!.execute("human-reply", {
      action: "reply", replyTo: requestId, message: "Actual human answered: yes to the recommended scope.",
    }),
    dispose: () => { channel.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
}

describe("architecture foreground human frontier", () => {
  test.each(["unrelated-provider", "prerequisite-provider", "human", "dispatch"])("retains available native %s failure evidence and settles every frontier child", async failure => {
    const storage = new Map<string, unknown>(), started = new Set<string>();
    const entered = deferred<void>(), human = deferred<void>(), research = deferred<void>(), researchSettled = deferred<void>();
    const failedKey = failure === "human" ? "human-r1-1" : failure === "prerequisite-provider" ? "doubts-r1-0" : "doubts-r1-1";
    const pointers = { runId: `native-${failedKey}`, artifactPaths: ["/native/failed/report.json"],
      outputReference: "/native/failed/report.md", asyncDir: "/native/failed" };
    const failedReport = "Contrary evidence survives the infrastructure failure";
    const infrastructureError = "Controlled child infrastructure failure";
    let finished = false;
    const work = nativeScript({
      script: source, args: { workDescription: "Choose persistence architecture", currentDecision: snapshot("Complete decision"), planning: true, consultation: "native-failure", maxRounds: 1 },
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async key => {
        if (key.startsWith("director-doubts-")) return { key, ok: true, runId: key, output: "", artifactPaths: [], structuredOutput: { doubts: [
          { id: "needed", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
          { id: "external", kind: "researcher", dependsOn: [], question: "External contract?", decision: "Adapter" },
          { id: "other", kind: "researcher", dependsOn: [], question: "Other evidence?", decision: "Other" },
          { id: "scope", kind: "human", dependsOn: [], question: "Prefer scope A (recommended)?", decision: "Scope" },
          { id: "dependent", kind: "human", dependsOn: ["needed"], question: "Reuse seam (recommended)?", decision: "Reuse" },
        ] } };
        if (key.startsWith("human-") || key.startsWith("doubts-")) {
          started.add(key);
          if (["human-r1-0", "doubts-r1-2", failedKey, ...(failure === "prerequisite-provider" ? [] : ["human-r1-1"])].every(key => started.has(key))) entered.resolve();
          if (key === failedKey) {
            if (failure === "dispatch") throw new Error(infrastructureError); // No child identity exists.
            return { key, ok: false, ...pointers, output: "Native failure output", error: infrastructureError,
              structuredOutput: { status: "blocked", report: failedReport } };
          }
          if (key.startsWith("human-")) await human.promise;
          if (key === "doubts-r1-2") { await research.promise; researchSettled.resolve(); }
        }
        return { key, ...child(key), output: "", artifactPaths: [] };
      },
      status: async () => { throw new Error("Unexpected status fallback"); },
    }).then(result => { finished = true; return result; });
    try {
      await Promise.race([entered.promise, work.then(() => { throw new Error("Workflow ended before sibling dispatch"); })]);
      expect(finished).toBe(false);
      research.resolve();
      await researchSettled.promise;
      expect(finished).toBe(false); // Independent (and, when unblocked, dependent) human answers remain pending.
    } finally {
      research.resolve(); human.resolve(); await work;
    }
    expect((await work).value).toMatchObject({ status: failure === "human" ? "blocked" : "failed", rounds: 1, validRounds: 1 });
    const retained = structuredClone(storage.get("architecture-native-failure")) as { evidence: { key?: string }[] };
    expect(retained).toMatchObject({ rounds: 1, validRounds: 1, maxRounds: 1 });
    const failed = retained.evidence.find(item => item.key === failedKey);
    expect(failed).toMatchObject({ key: failedKey, diagnostic: expect.stringContaining(infrastructureError) });
    const original = (retained as unknown as { originals: Original[] }).originals.find(item => item.key === failedKey);
    if (failure !== "dispatch") {
      expect(original).toMatchObject({ sufficient: false, publication: "published", runId: pointers.runId });
      expect(originalValue(original!)).toMatchObject({ status: "blocked", report: failedReport });
    }
    if (failure === "dispatch") {
      for (const field of ["runId", "outputReference", "asyncDir"]) expect(failed).not.toHaveProperty(field);
    }
    if (failure === "prerequisite-provider") {
      expect(started.has("human-r1-1")).toBe(false);
      expect(structuredClone(storage.get("architecture-native-failure"))).toMatchObject({ evidence: expect.arrayContaining([
        expect.objectContaining({ key: "human-r1-1", withheld: expect.arrayContaining([expect.objectContaining({ id: "dependent" })]) }),
      ]) });
    }
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-prepare"); expect(request.resume).toBe("director-doubts-r1");
      for (const value of failure === "dispatch" ? [infrastructureError] : [failedReport, infrastructureError, pointers.runId, pointers.asyncDir, ...pointers.artifactPaths]) expect(evidenceText(request)).toContain(value);
      expect(request.task).toContain("Consumed rounds: 1/1"); expect(request.task).toContain("finish or blocked only");
      return { ...child(key), structuredOutput: finish };
    });
    const reentry = { evidence: "Actual human answered; reconcile failure", planning: true, consultation: "native-failure", continuation: ((await work).value as unknown as Outcome).continuation };
    if (failure === "dispatch") {
      await expect(resumed.execute(reentry, storage)).rejects.toThrow("Unconfirmed architecture dispatch boundary");
      expect(resumed.calls).toHaveLength(0);
    } else {
      expect(await resumed.execute(reentry, storage)).toMatchObject({ status: failure === "human" ? "completed" : "failed", rounds: 1, validRounds: 1 });
      expect(resumed.calls).toHaveLength(failure === "human" ? 1 : 0);
    }
  });

  test("an overlapping smaller frontier is relayed before a larger prerequisite batch, without awaiting its human answer", async () => {
    const first = deferred<void>(), entered = deferred<void>(), next = deferred<string>(), later = deferred<void>();
    const human = deferred<void>(), facts = deferred<void>();
    const started: string[] = [], storage = new Map<string, unknown>();
    let firstSettled = false;
    const work = nativeScript({
      script: source, args: { workDescription: "Choose persistence architecture", currentDecision: snapshot("Decision"), planning: true, consultation: "overlap" }, globalConcurrencyLimit: 2,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async (key, request) => {
        let result: Result;
        if (key.startsWith("director-doubts-")) result = { ok: true, runId: key, structuredOutput: { doubts: [
          ...["a", "b", "c", "unrelated"].map(id => ({ id, kind: "scout", dependsOn: [], question: `Fact ${id}?`, decision: "Design" })),
          { id: "large", kind: "human", dependsOn: ["a", "b", "c"], question: "Use all facts (recommended)?", decision: "Design" },
          { id: "small", kind: "human", dependsOn: ["a"], question: "Accept A (recommended)?", decision: "Design" },
        ] } };
        else {
          if (key.startsWith("doubts-") || key.startsWith("human-")) {
            started.push(key);
            if (key === "doubts-r1-0") { entered.resolve(); await first.promise; }
            else {
              if (firstSettled) next.resolve(key);
              if (key.startsWith("human-")) {
                expect(request.task).toContain("Brief factual frontier from doubts-r1-0");
                expect(request.task).not.toContain("Private report from doubts-r1-0");
                await human.promise;
              } else {
                later.resolve(); await facts.promise;
              }
            }
          }
          result = child(key);
        }
        return { key, ...result, output: "", artifactPaths: [] };
      },
      status: async () => { throw new Error("Unexpected status fallback"); },
    });
    try {
      await entered.promise; firstSettled = true; first.resolve();
      expect(await Promise.race([next.promise, work.then(() => "ended")])).toBe("human-r1-1");
      await Promise.race([later.promise, work.then(() => { throw new Error("Research waited for the human answer"); })]);
    } finally {
      first.resolve(); human.resolve(); facts.resolve(); await work;
    }
    expect((await work).value).toMatchObject({ status: "completed" });
    expect(started.indexOf("human-r1-1")).toBeLessThan(started.indexOf("doubts-r1-1"));
    expect(started.indexOf("human-r1-0")).toBeLessThan(started.indexOf("doubts-r1-3"));
    expect(started.filter(key => key === "doubts-r1-0")).toHaveLength(1);
  });

  test.each([1, 2])("newly answerable frontiers precede unrelated FIFO research with %s prerequisite groups", async groupCount => {
    const scout = deferred<void>(), entered = deferred<void>(), next = deferred<string>();
    const human = deferred<void>(), research = deferred<void>(), researchBoth = deferred<void>();
    const started: string[] = [], storage = new Map<string, unknown>();
    const work = nativeScript({
      script: source, args: { workDescription: "Choose persistence architecture", currentDecision: snapshot("Decision"), planning: true, consultation: "dependent-capacity" },
      globalConcurrencyLimit: 2,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async (key, request) => {
        let result: Result;
        if (key.startsWith("director-doubts-")) result = { ok: true, runId: key, structuredOutput: { doubts: [
          { id: "needed", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
          { id: "a", kind: "researcher", dependsOn: [], question: "Unrelated A?", decision: "Other" },
          { id: "b", kind: "researcher", dependsOn: [], question: "Unrelated B?", decision: "Other" },
          { id: "scope", kind: "human", dependsOn: ["needed"], question: "Reuse seam (recommended)?", decision: "Reuse" },
          ...(groupCount === 2 ? [
            { id: "later", kind: "scout", dependsOn: [], question: "Other prerequisite?", decision: "Adapter" },
            { id: "adapter", kind: "human", dependsOn: ["needed", "later"], question: "Use adapter (recommended)?", decision: "Adapter" },
          ] : []),
        ] } };
        else {
          if (key.startsWith("doubts-") || key.startsWith("human-")) {
            started.push(key);
            if (key === "doubts-r1-0") { entered.resolve(); await scout.promise; }
            else {
              if (started.includes("doubts-r1-0") && key !== "doubts-r1-1") next.resolve(key);
              if (key === "doubts-r1-3") expect(started).toContain("human-r1-0");
              if (key.startsWith("human-")) {
                expect(request.task).toContain("SETTLED PREREQUISITE FACTS");
                await human.promise;
              } else if (key !== "doubts-r1-3") {
                if (started.includes("doubts-r1-1") && started.includes("doubts-r1-2")) researchBoth.resolve();
                await research.promise;
              }
            }
          }
          result = child(key);
        }
        return { key, ...result, output: "", artifactPaths: [] };
      },
      status: async () => { throw new Error("Unexpected status fallback"); },
    });
    try {
      await entered.promise;
      expect(started).not.toContain("human-r1-0");
      scout.resolve();
      expect(await Promise.race([next.promise, work.then(() => "ended")])).toBe("human-r1-0");
      human.resolve();
      await Promise.race([researchBoth.promise, work.then(() => { throw new Error("Independent research never overlapped"); })]);
    } finally {
      scout.resolve(); human.resolve(); research.resolve(); await work;
    }
    expect((await work).value).toMatchObject({ status: "completed" });
    expect(started.filter(key => key === "doubts-r1-0")).toHaveLength(1);
    expect(started.indexOf("human-r1-0")).toBeLessThan(started.indexOf("doubts-r1-2"));
    if (groupCount === 2) expect(started.indexOf("human-r1-1")).toBeLessThan(started.indexOf("doubts-r1-1"));
  });

  test.each([false, true])("delivers a real native interview before unrelated research settles (research fails=%s)", async fails => {
    const relay = supervisorRelay(), research = deferred<Result>();
    const host = fixture((key, request) => {
      if (key.startsWith("director-doubts-")) return { ok: true, runId: key, structuredOutput: { doubts: [
        { id: "facts", kind: "researcher", dependsOn: [], question: "Which external API exists?", decision: "Adapter" },
        { id: "scope", kind: "human", dependsOn: [], question: "Prefer scope A (recommended)?", decision: "Scope" },
        { id: "dependent", kind: "human", dependsOn: ["facts"], question: "Use the supported adapter (recommended)?", decision: "Adapter" },
      ] } };
      if (key.startsWith("doubts-")) return research.promise;
      if (key.startsWith("human-")) return relay.launch(key, request);
      return child(key);
    });
    const storage = new Map<string, unknown>();
    let finished = false;
    const work = host.execute({ currentDecision: snapshot("Complete decision"), planning: true, consultation: "frontier" }, storage).then(value => { finished = true; return value; });
    let result!: Outcome;
    try {
      await Promise.race([relay.first, work.then(() => { throw new Error("Workflow ended before the foreground interview"); })]);
      expect(finished).toBe(false);
      expect(relay.notices[0]!.details.requestBody).toContain('"scope"');
      expect(relay.notices[0]!.details.requestBody).not.toContain('"dependent"');
      expect(host.calls.filter(call => call.key.startsWith("human-"))).toHaveLength(1);
      await relay.reply(relay.notices[0]!.details.requestId);
      research.resolve(fails ? { ok: false, runId: "failed-research" } : child("facts"));
      if (!fails) { await relay.second; await relay.reply(relay.notices[1]!.details.requestId); }
      result = await work;
      expect(result.status).toBe(fails ? "failed" : "completed");
      expect(relay.notices).toHaveLength(fails ? 1 : 2);
      expect(JSON.stringify(storage.get("architecture-frontier"))).toContain("native-human-r1-0");
      if (fails) expect(JSON.stringify(storage.get("architecture-frontier"))).toContain("failed-research");
    } finally {
      research.resolve({ ok: false, runId: "cleanup-research" });
      for (const notice of relay.notices) { try { await relay.reply(notice.details.requestId); } catch {} }
      await work;
      relay.dispose();
    }
  });

  test("submits the ready human frontier before factual work occupies two launch slots", async () => {
    const release = deferred<void>(), occupied = deferred<void>();
    const started: string[] = [], storage = new Map<string, unknown>();
    const work = nativeScript({
      script: source, args: { workDescription: "Choose persistence architecture", currentDecision: snapshot("Decision"), planning: true, consultation: "launch-priority" },
      globalConcurrencyLimit: 2,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async key => {
        let result: Result;
        if (key.startsWith("director-doubts-")) result = { ok: true, runId: key, structuredOutput: { doubts: [
          { id: "first", kind: "scout", dependsOn: [], question: "First local fact?", decision: "Reuse" },
          { id: "second", kind: "researcher", dependsOn: [], question: "Second external fact?", decision: "Adapter" },
          { id: "scope", kind: "human", dependsOn: [], question: "Prefer scope A (recommended)?", decision: "Scope" },
        ] } };
        else {
          if (key.startsWith("human-") || key.startsWith("doubts-")) {
            started.push(key);
            if (started.length === 2) occupied.resolve();
            await release.promise;
          }
          result = child(key);
        }
        return { key, ...result, output: "", artifactPaths: [] };
      },
      status: async () => { throw new Error("Unexpected status fallback"); },
    });
    try {
      await Promise.race([occupied.promise, work.then(() => { throw new Error("Workflow ended before the launch slots were occupied"); })]);
      expect(started.slice(0, 2)).toContain("human-r1-0");
    } finally {
      release.resolve();
      await work;
    }
  });

  test.each(["pending", "failed"])("a dependent frontier waits only for its named facts, not %s unrelated providers", async mode => {
    const relay = supervisorRelay(), prerequisite = deferred<Result>(), unrelated = deferred<Result>();
    const storage = new Map<string, unknown>();
    const host = fixture((key, request) => {
      if (key.startsWith("director-doubts-")) return { ok: true, runId: key, structuredOutput: { doubts: [
        { id: "other", kind: "researcher", dependsOn: [], question: "Unrelated external fact?", decision: "Other" },
        { id: "needed", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
        ...(mode === "failed" ? [{ id: "other-choice", kind: "human", dependsOn: ["other"], question: "Use external option?", decision: "Other" }] : []),
        { id: "scope", kind: "human", dependsOn: ["needed"], question: "Reuse seam (recommended)?", decision: "Reuse" },
      ] } };
      if (key === "doubts-r1-1") { prerequisite.resolve(child("needed")); return prerequisite.promise; }
      if (key === "doubts-r1-0") return mode === "failed"
        ? { ok: false, runId: "native-missing-other", error: "Unrelated fact failed without original", raw: true } : unrelated.promise;
      if (key.startsWith("human-")) return relay.launch(key, request);
      return child(key);
    });
    let finished = false;
    const work = host.execute({ currentDecision: snapshot("Decision"), planning: true, consultation: "dependent" }, storage).then(value => { finished = true; return value; });
    try {
      await Promise.race([relay.first, work.then(() => { throw new Error("Interview was hidden by unrelated work"); })]);
      expect(finished).toBe(false); expect(relay.notices[0]!.details.requestBody).toContain('"scope"');
      await relay.reply(relay.notices[0]!.details.requestId);
    } finally {
      unrelated.resolve(child("other"));
      for (const notice of relay.notices) { try { await relay.reply(notice.details.requestId); } catch {} }
      await work; relay.dispose();
    }
    if (mode === "failed") {
      const retained = storage.get("architecture-dependent") as { originals: Original[]; evidence: unknown[] };
      expect(retained.originals.find(item => item.key === "doubts-r1-0")).toMatchObject({
        sufficient: false, delivery: "not-delivered", diagnostic: expect.stringContaining("Unrelated fact failed without original"),
      });
      expect(retained.originals.find(item => item.key === "doubts-r1-1")).toMatchObject({ sufficient: true });
      expect(retained.evidence).toContainEqual(expect.objectContaining({
        key: "human-r1-0", withheld: [expect.objectContaining({ id: "other-choice" })],
      }));
      expect(host.calls.some(call => call.key === "human-r1-0")).toBe(false);
      expect(relay.notices).toHaveLength(1);
    }
  });

  test("fresh continuation research receives original context, updated human choices and contrary reports", async () => {
    const storage = new Map<string, unknown>();
    const retained = await fixture(key => key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts: [] } } : child(key)).execute({ currentDecision: snapshot("Original complete assignment"), planning: true, consultation: "updated" }, storage);
    const host = fixture((key, request) => {
      if (key.startsWith("director-doubts-")) return { ok: true, runId: key, structuredOutput: { doubts: [
        { id: "adapter", kind: "researcher", dependsOn: [], question: "Does the chosen adapter support recovery?", decision: "Recovery design" },
      ] } };
      if (key.startsWith("doubts-")) {
        for (const context of ["Original complete assignment", "Human chose adapter B", "Private report from r2-recover"])
          expect(evidenceText(request)).toContain(context);
      }
      return child(key);
    });
    const result = await host.execute({ replacement: replacement("updated", 1, snapshot("Original complete assignment; Human chose adapter B; complete updated decision", { humanDecisions: [{ id: "adapter", content: "Human chose adapter B", provenance: "Actual human answer" }] })), continuation: retained.continuation, planning: true, consultation: "updated" }, storage);
    expect(result.status).toBe("completed"); expect(result.rounds).toBe(2);
  });

  test("reconciles human answers at ten consumed rounds without an eleventh comparison or counter reset", async () => {
    const previous = { version: 2, consultation: "cap", currentDecision: { revision: 1, snapshot: snapshot("Original decision") }, decisionHistory: [], rounds: 10, validRounds: 10, maxRounds: 10, directorRunId: "native-doubts-r10", members: [], cursor: { version: 1, phase: "concluded", dispatches: [], control: { version: 1, planning: true, start: 0, stage: "prepare", next: null, round: null } }, evidence: [{ round: 10, question: "Prefer scope A?" }] };
    const storage = new Map<string, unknown>([["architecture-cap", previous]]);
    const host = fixture((key, request) => {
      expect(key).toBe("director-prepare"); expect(request.task).toContain("Actual human answered A");
      expect(request.task).toContain("finish or blocked only");
      return { ok: true, runId: "native-synthesis", structuredOutput: finish };
    });
    const result = await host.execute({ replacement: replacement("cap", 1, snapshot("Original decision; Actual human answered A", { humanDecisions: [{ id: "scope", content: "A", provenance: "Actual foreground human answer" }] })), planning: true, consultation: "cap", continuation: { version: 2, consultation: "cap" } }, storage);
    expect(result.status).toBe("completed"); expect(result.rounds).toBe(10); expect(result.validRounds).toBe(10);
    expect(host.calls).toHaveLength(1); expect(storage.get("architecture-cap")).toMatchObject({ rounds: 10, directorRunId: "native-synthesis" });
    const lower = fixture();
    await expect(lower.execute({ evidence: "Same answer", planning: true, consultation: "cap", maxRounds: 9, continuation: result.continuation }, storage)).rejects.toThrow("original maximum");
    expect(lower.calls).toHaveLength(0);
    const extra = await fixture().execute({ evidence: "Same answer", planning: true, consultation: "cap", continuation: result.continuation }, storage);
    expect(extra.status).toBe("failed"); expect(extra.rounds).toBe(10); expect(extra.error).toContain("beyond the limit");
  });

  test("planning reentry fits native argument limits while retaining full reports and capped synthesis", async () => {
    const storage = new Map<string, unknown>();
    const roster = Array.from({ length: 4 }, (_, index) => ({ id: `p${index}`, label: `View ${index}`, focus: "Whole decision" }));
    const host = fixture(key => key === "director-prepare"
      ? { ok: true, runId: key, structuredOutput: { ...discuss, perspectives: roster } }
      : key.startsWith("director-doubts-") ? { ok: true, runId: key, structuredOutput: { doubts: [] } }
        : key.startsWith("r1-") ? { ok: true, runId: key, structuredOutput: { status: "ready", report: `${key}:` + "x".repeat(4090) } }
          : child(key));
    const first = await host.execute({ currentDecision: snapshot("Complete assignment"), planning: true, consultation: "large", maxRounds: 1 }, storage);
    expect(first.status).toBe("completed");
    expect(normalizeWorkflowArgs({ evidence: "x".repeat(17000) })).toMatchObject({ error: expect.stringContaining("16384") });
    expect(JSON.stringify(storage.get("architecture-large"))).not.toContain("x".repeat(4090));
    const reentry = { evidence: "Actual human answers", planning: true, consultation: "large", continuation: first.continuation };
    expect(normalizeWorkflowArgs(reentry)).toEqual({ args: reentry });
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-prepare");
      for (const view of roster) expect(evidenceText(request)).toContain(`r1-${view.id}:` + "x".repeat(4090));
      expect(request.task).toContain("finish or blocked only");
      return { ok: true, runId: "synthesis", structuredOutput: finish };
    });
    const done = await resumed.execute(reentry, storage);
    expect(done.status).toBe("completed"); expect(done.rounds).toBe(1); expect(resumed.calls).toHaveLength(1);
    const retained = storage.get("architecture-large") as { originals: Original[] };
    expect(JSON.stringify(retained)).not.toContain("x".repeat(4090));
    for (const view of roster) expect(JSON.stringify(originalValue(retained.originals.find(item => item.producer === view.id)!)))
      .toContain(`r1-${view.id}:` + "x".repeat(4090));
  });

  test("rejects unknown or nonfactual prerequisites before dispatching any providers or relay", async () => {
    for (const dependsOn of [["missing"], ["scope"]]) {
      const host = fixture(key => key.startsWith("director-doubts-") ? { ok: true, runId: key, structuredOutput: { doubts: [
        { id: "scope", kind: "human", dependsOn, question: "Scope A?", decision: "Scope" },
      ] } } : child(key));
      const result = await host.execute({ currentDecision: snapshot("Decision"), planning: true, consultation: "invalid" }, new Map());
      expect(result.status).toBe("failed"); expect(result.error).toContain("dependencies");
      expect(host.calls.some(call => call.key.startsWith("human-") || call.key.startsWith("doubts-"))).toBe(false);
    }
  });
});


describe("architecture recoverable originals", () => {
  test("publishes exact structured originals, circulates references once, and preserves contrary narrative outside the final recommendation", async () => {
    const contrary = "Contrary narrative: a rejected alternative still exposes an unmitigated restore gap.";
    const host = fixture((key, request) => {
      expect(typeof request.output).toBe("string");
      expect(request.outputMode).toBe("file-only");
      if (key === "r1-recover") return { ...child(key), structuredOutput: { status: "ready", report: contrary } };
      if (key === "director-after-r1") {
        expect(request.task).not.toContain(contrary);
        const originals = essentials(request);
        expect(originals).toHaveLength(2);
        // A publication witness is not yet evidence of physical access by a consumer.
        expect(originals.every(item => item.accessibility === "unverified")).toBe(true);
        expect(new Set(originals.map(item => item.id)).size).toBe(2);
        expect(originals.map(item => originalValue(item).report)).toContain(contrary);
        for (const original of originals) {
          expect(original.publication).toBe("published");
          expect(original.results?.[0]?.savedOutputPath).toBeTruthy();
          expect(originalValue(original).association).toMatchObject({ producer: original.producer, revision: 1 });
        }
      }
      return child(key);
    });
    expect(await host.execute()).toMatchObject({ status: "completed", memo: finish.memo });
    const retained = host.storage.get("architecture-decision") as { originals: Original[]; evidence: unknown[] };
    expect(JSON.stringify(retained)).not.toContain(contrary);
    expect(retained.originals.find(item => item.producer === "recover")).toMatchObject({ runId: "native-r1-recover", accessibility: "accessible" });
    expect(host.calls.every(call => !call.request.agent || call.request.agent === "pitako.architect")).toBe(true);
  });

  for (const witness of ["generic", "structured-only", "mandatory-error", "optional-error", "top-optional-error"]) {
    test(`distinguishes ${witness} from mandatory successful publication`, async () => {
      let delivered: Result | undefined;
      const host = fixture((key, request) => {
        if (key !== "r1-simple") return child(key);
        const result = published(child(key), request);
        delivered = result;
        if (witness === "generic") result.results = [{ artifactPaths: [result.outputReference] }];
        if (witness === "structured-only") result.results = [{ structuredOutputPath: result.outputReference }];
        if (witness === "mandatory-error") result.results![0]!.outputSaveError = "Mandatory publication denied";
        if (witness === "top-optional-error") result.metadataSaveError = "Optional metadata artifact unavailable";
        if (witness === "optional-error") result.results![0]!.metadataSaveError = "Optional metadata artifact unavailable";
        return { ...result, raw: true };
      });
      const result = await host.execute();
      const entry = (host.storage.get("architecture-decision") as { originals: Original[] }).originals.find(item => item.producer === "simple")!;
      if (witness === "optional-error" || witness === "top-optional-error") {
        expect(result.status).toBe("completed");
        expect(entry).toMatchObject({ publication: "published", sufficient: true });
        expect(entry.failedOriginal).toBeUndefined();
      } else {
        expect(result).toMatchObject({ status: "failed", validRounds: 0 });
        expect(entry).toMatchObject({ publication: "unpublished", sufficient: false, delivery: "complete" });
        expect<unknown>(entry.failedOriginal).toEqual(delivered!.structuredOutput);
        expect(JSON.stringify(host.storage.get("architecture-decision")).split("Private report from r1-simple")).toHaveLength(2);
      }
    });
  }

  test("exact publication mappings remain usable", async () => {
    let exact: Result | undefined;
    const host = fixture((key, request) => {
      const result = published(child(key), request);
      result.outputPathMapping = { requestedPath: String(request.output), savedPath: result.outputReference! };
      result.results![0] = { ...result.results![0], runId: result.runId, agent: "pitako.architect", workflowKey: key,
        outputPathMapping: result.outputPathMapping };
      if (key === "r1-simple") exact = structuredClone(result);
      return { ...result, raw: true };
    });
    expect(await host.execute()).toMatchObject({ status: "completed", validRounds: 1 });
    const original = (host.storage.get("architecture-decision") as { originals: Original[] }).originals.find(item => item.key === "r1-simple")!;
    expect(original).not.toHaveProperty("terminalOutcome");
    expect(original).toMatchObject({ sufficient: true,
      outputReference: exact!.outputReference, outputPathMapping: exact!.outputPathMapping, results: exact!.results });
    expect(original.failedOriginal).toBeUndefined();
  });

  test.each(["top-save", "top-save-partial", "stopped", "interrupted", "detached", "child-interrupted", "timedOut", "nonzero", "partial-outcome", "top-timeout", "top-nonzero", "top-signal", "top-recovery", "top-permission", "top-partial", "child-stopped", "child-detached", "child-running", "child-error", "child-partial-outcome", "child-partial", "child-schema-failure", "child-signal", "child-budget", "child-tool-budget", "child-timeout-recovery", "child-cancelled", "top-agent", "child-agent", "child-key", "child-run", "top-key"])("blocks schema-valid native %s outcomes before validity or dependent dispatch", async fault => {
    let returned: Result | undefined;
    const host = fixture((key, request) => {
      if (key !== "r1-simple") return child(key);
      const result = published(child(key), request);
      // Keep every genuine returned witness, even when a conflicting outcome makes it unusable.
      result.results![0] = { ...result.results![0], runId: result.runId, workflowKey: key, agent: "pitako.architect" };
      if (fault === "top-save-partial") Object.assign(result.structuredOutput as object, { status: "blocked", report: "Private report from r1-simple: fully delivered partial contrary analysis" });
      if (fault.startsWith("top-save")) result.outputSaveError = "Mandatory output publication failed at top level";
      if (fault === "stopped") result.stopped = true;
      if (fault === "interrupted") result.interrupted = true;
      if (fault === "detached") result.detached = true;
      if (fault === "child-interrupted") result.results![0]!.interrupted = true;
      if (fault === "timedOut") result.results![0]!.timedOut = true;
      if (fault === "nonzero") result.results![0]!.exitCode = 7;
      if (fault === "partial-outcome") result.terminalOutcome = { state: "partial", reason: "timeout" };
      if (fault === "top-timeout") result.timedOut = true;
      if (fault === "top-nonzero") result.exitCode = 9;
      if (fault === "top-signal") result.processSignal = "SIGTERM";
      if (fault === "top-recovery") result.recovery = { status: "available-for-review", reason: "acceptance-metadata-rejected", reportPath: "native-report", reportHash: "a".repeat(64) };
      if (fault === "top-permission") result.error = "Blocked by pi-subagents permission rule: 'run' is denied.";
      if (fault === "top-partial") result.outputPartial = true;
      if (fault === "child-stopped") result.results![0]!.stopped = true;
      if (fault === "child-detached") result.results![0]!.detached = true;
      if (fault === "child-running") result.results![0]!.state = "running";
      if (fault === "child-error") result.results![0]!.error = "Permission denied; Stop";
      if (fault === "child-partial-outcome") result.results![0]!.terminalOutcome = { state: "partial", reason: "budget_exhausted" };
      if (fault === "child-partial") result.results![0]!.outputPartial = true;
      if (fault === "child-schema-failure") result.results![0]!.structuredOutputFailed = true;
      if (fault === "child-signal") result.results![0]!.processSignal = "SIGTERM";
      if (fault === "child-budget") result.results![0]!.turnBudgetExceeded = true;
      if (fault === "child-tool-budget") result.results![0]!.toolBudgetBlocked = true;
      if (fault === "child-timeout-recovery") result.results![0]!.timeoutRecovery = { termination: "timed-out", changedFiles: [], recoveryNeeded: true };
      if (fault === "child-cancelled") result.results![0]!.state = "cancelled";
      if (fault === "top-agent") result.agent = "pitako.scout";
      if (fault === "child-agent") result.results![0]!.agent = "pitako.scout";
      if (fault === "child-key") result.results![0]!.workflowKey = "another-key";
      if (fault === "child-run") result.results![0]!.runId = "another-run";
      if (fault === "top-key") result.key = "another-key";
      returned = structuredClone(result);
      return { ...result, raw: true };
    });
    const outcome = await host.execute();
    expect(outcome).toMatchObject({ status: "failed", rounds: 1, validRounds: 0 });
    expect(host.calls.map(call => call.key)).toEqual(["director-prepare", "r1-simple", "r1-recover"]);
    const retained = host.storage.get("architecture-decision") as { originals: Original[] };
    const original = retained.originals.find(item => item.producer === "simple")!;
    expect(original).toMatchObject({ key: "r1-simple", runId: returned!.runId, sufficient: false, results: returned!.results });
    if (fault.startsWith("top-save")) {
      expect(original).toMatchObject({ publication: "unpublished", delivery: "complete", failedOriginal: returned!.structuredOutput });
      expect(outcome.error).toContain(returned!.outputSaveError!);
      expect(JSON.stringify(retained).split("Private report from r1-simple")).toHaveLength(2);
    } else if (fault.includes("agent") || ["child-key", "child-run", "top-key"].includes(fault)) {
      expect(original.delivery).toBe("unproved");
      expect(original.failedOriginal).toBeUndefined();
      expect(outcome.error).toContain("Native producer association mismatch");
    } else {
      expect(original).toMatchObject({ terminal: ["detached", "child-detached", "child-running"].includes(fault) ? "unconfirmed" : "failed", sufficient: false });
      const reentry = fixture();
      if (["detached", "child-detached", "child-running", "top-partial", "child-partial", "child-schema-failure"].includes(fault)) await expect(reentry.execute({ continuation: outcome.continuation }, host.storage)).rejects.toThrow("Unconfirmed");
      else expect(await reentry.execute({ continuation: outcome.continuation }, host.storage)).toMatchObject({ status: "failed", error: expect.stringContaining("barrier") });
      expect(reentry.calls).toHaveLength(0);
    }
  });

  for (const control of ["stopped", "child-stopped", "recovery", "top-timeout"]) {
  test.each(["director-prepare", "r1-simple", "director-doubts-r1", "doubts-r1-0", "human-r1-0", "director-after-r1"])(`honors native ${control} at %s rather than advancing or hiding the barrier`, async failedKey => {
    const host = fixture((key, request) => {
      const value = key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts: [
        { id: "fact", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
        { id: "human", kind: "human", dependsOn: [], question: "Reuse (recommended)?", decision: "Scope" },
      ] } } : child(key);
      if (key !== failedKey) return value;
      const result = published(value, request);
      if (control === "stopped") result.stopped = true;
      if (control === "child-stopped") result.results![0]!.stopped = true;
      if (control === "recovery") result.recovery = { status: "available-for-review", reason: "acceptance-metadata-rejected", reportPath: "native-report", reportHash: "a".repeat(64) };
      if (control === "top-timeout") result.timedOut = true;
      return { ...result, raw: true };
    });
    const outcome = await host.execute({ planning: true, currentDecision: snapshot("Complete decision") });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("Native control");
    expect(outcome.validRounds).toBe(["director-prepare", "r1-simple"].includes(failedKey) ? 0 : 1);
    const original = (host.storage.get("architecture-decision") as { originals: Original[] }).originals.find(item => item.key === failedKey)!;
    expect(original).toMatchObject({ sufficient: false, terminal: "failed" });
    if (control === "stopped") expect(original).toHaveProperty("stopped", true);
    if (control === "child-stopped") expect(original.results![0]).toHaveProperty("stopped", true);
    if (control === "recovery") expect(original).toHaveProperty("recovery.reason", "acceptance-metadata-rejected");
    if (control === "top-timeout") expect(original).toHaveProperty("timedOut", true);
    if (failedKey !== "director-after-r1") expect(host.calls.some(call => call.key === "director-after-r1")).toBe(false);
    const reentry = fixture();
    expect(await reentry.execute({ planning: true, continuation: outcome.continuation }, host.storage)).toMatchObject({ status: "failed", error: expect.stringContaining("barrier") });
    expect(reentry.calls).toHaveLength(0);
  });

  }

  test("retains a complete partial failed original and combined publication/control/save diagnostics after owned siblings settle", async () => {
    const sibling = deferred<Result>(), started = deferred<void>();
    let settled = false, returned = false, failedWrites = 0;
    let exact: unknown;
    const host = fixture((key, request) => {
      if (key === "r1-recover") { started.resolve(); return sibling.promise.then(value => { settled = true; return value; }); }
      if (key !== "r1-simple") return child(key);
      const result = published({ ...child(key), stopped: true, outputSaveError: "Mandatory publication denied", structuredOutput: {
        status: "blocked", report: "Fully delivered partial analysis: contrary evidence survives Stop.",
      } }, request);
      exact = result.structuredOutput;
      return { ...result, raw: true };
    }, undefined, value => {
      if ((value as unknown as { originals: Original[] }).originals.some(item => item.producer === "simple")) {
        failedWrites++; throw new Error("Essential persistence denied");
      }
    });
    const pending = host.execute().then(value => { returned = true; return value; });
    await started.promise;
    expect(returned).toBe(false);
    sibling.resolve(child("r1-recover"));
    const outcome = await pending;
    expect(settled).toBe(true);
    expect(failedWrites).toBe(1);
    expect(outcome).toMatchObject({ status: "failed", validRounds: 0 });
    expect(outcome.error).toContain("Essential persistence denied");
    expect(outcome.error).toContain("Mandatory publication denied");
    expect(outcome.error).toContain('\\"stopped\\":true');
    expect(exact).toMatchObject({ status: "blocked", delivery: "complete" });
    // The failed essential save must not claim that its inline evidence was persisted.
    const last = host.storage.get("architecture-decision") as { originals: Original[] };
    expect(last.originals).toHaveLength(1);
    expect(host.calls).toHaveLength(3);
  });

  for (const field of ["consultation", "revision", "producer", "phase", "key", "attempt"]) {
    test(`rejects an original with a mismatched ${field} rather than retaining a reconstructed original`, async () => {
      const host = fixture((key, request) => {
        if (key !== "r1-simple") return child(key);
        const result = published(child(key), request);
        (result.structuredOutput as { association: Record<string, unknown> }).association[field] = "wrong";
        return { ...result, raw: true };
      });
      expect(await host.execute()).toMatchObject({ status: "failed", validRounds: 0 });
      const entry = (host.storage.get("architecture-decision") as { originals: Original[] }).originals.find(item => item.producer === "simple")!;
      expect(entry).toMatchObject({ delivery: "unproved", sufficient: false });
      expect(entry.failedOriginal).toBeUndefined();
    });
  }

  for (const failure of ["missing", "contradictory", "unavailable-receipt"]) {
    test(`blocks a dependent synthesis when an essential original is ${failure}`, async () => {
      const host = fixture((key, request) => {
        if (key !== "director-after-r1") return child(key);
        const first = essentials(request)[0]!;
        if (failure === "missing") rmSync(first.results![0]!.savedOutputPath!);
        if (failure === "contradictory") {
          const saved = first.results![0]!.savedOutputPath!;
          const value = JSON.parse(readFileSync(saved, "utf8"));
          value.association.producer = "other-producer";
          writeFileSync(saved, JSON.stringify(value));
        }
        if (failure === "unavailable-receipt") {
          return { ...child(key), structuredOutput: { ...finish, access: essentials(request).map(item => ({
            id: item.id, state: "unavailable", source: "none", reason: "Exact original is no longer accessible after compaction",
          })) } };
        }
        return child(key);
      });
      const result = await host.execute();
      expect(result.status).toBe("failed");
      expect(result.error).toBeTruthy();
      expect(host.calls.at(-1)?.key).toBe("director-after-r1");
      if (failure === "unavailable-receipt") {
        const retained = host.storage.get("architecture-decision") as { originals: Original[] };
        expect(retained.originals.filter(item => ["simple", "recover"].includes(item.producer)).every(item => item.accessibility === "unavailable")).toBe(true);
      }
    });
  }

  test("new and resumed/compacted participants recover all essentials without replacing original producer run IDs", async () => {
    const storage = new Map<string, unknown>();
    const first = await fixture().execute(undefined, storage);
    const before = structuredClone((storage.get("architecture-decision") as { originals: Original[] }).originals);
    const host = fixture((key, request) => {
      if (key === "director-prepare") {
        expect(request.resume).toBe("native-director-after-r1");
        const old = essentials(request);
        expect(old.map(item => item.runId)).toEqual(["native-r1-simple", "native-r1-recover"]);
        for (const item of old) expect(originalValue(item).report).toBe(`Private report from ${item.key}`);
        return { ...child(key), structuredOutput: { ...discuss, perspectives: [perspectives[0], { id: "new", label: "New whole-problem view", focus: "Reevaluate the full decision" }] } };
      }
      if (key === "r2-simple" || key === "r2-new") {
        expect(request.resume ?? request.context).toBe(key === "r2-simple" ? "native-r1-simple" : "fresh");
        expect(essentials(request)).toHaveLength(2);
        expect(request.task).toContain("after compaction reread missing essentials");
        expect(request.task).not.toContain("Private report");
        for (const item of essentials(request)) expect(originalValue(item).report).toBeTruthy();
      }
      return child(key);
    });
    expect(await host.execute({ evidence: "New factual evidence, not a replacement", continuation: first.continuation }, storage))
      .toMatchObject({ status: "completed", rounds: 2, validRounds: 2 });
    const after = (storage.get("architecture-decision") as { originals: Original[] }).originals;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.filter(item => item.producer === "simple").map(item => item.runId)).toEqual(["native-r1-simple", "native-r2-simple"]);
  });

  for (const delivery of ["complete-blocked", "unknown", "no-original", "text-preview", "rejection", "running"]) {
    test(`preserves only genuinely delivered complete failed originals: ${delivery}`, async () => {
      let original: unknown;
      const host = fixture((key, request) => {
        if (key !== "r1-simple") return child(key);
        if (delivery === "rejection") throw new Error("Rejected before original delivery");
        const result = published({ ...child(key), ok: false, error: "Controlled terminal failure", structuredOutput: {
          status: "blocked", report: "Partial analysis, fully delivered: contrary recovery risk remains unresolved.",
        } }, request);
        result.results = [];
        delete result.outputReference;
        if (delivery === "unknown") delete (result.structuredOutput as Record<string, unknown>).delivery;
        if (delivery === "no-original" || delivery === "text-preview") delete result.structuredOutput;
        if (delivery === "text-preview") result.output = JSON.stringify({ status: "ready", report: "Not an authenticated full delivery" });
        if (delivery === "running") result.state = "running";
        original = structuredClone(result.structuredOutput);
        if (delivery === "complete-blocked") result.error = `Mandatory output save failed\n\nOutput:\n${JSON.stringify(original, null, 2)}`;
        return { ...result, raw: true };
      });
      expect(await host.execute()).toMatchObject({ status: "failed", validRounds: 0 });
      const retained = host.storage.get("architecture-decision") as { originals: Original[] };
      const entry = retained.originals.find(item => item.producer === "simple")!;
      expect(entry.sufficient).toBe(false);
      expect(entry.publication).toBe("unpublished");
      if (delivery === "complete-blocked") {
        expect(entry).toMatchObject({ delivery: "complete", failedOriginal: original });
        expect(entry.diagnostic).toContain("Mandatory output save failed");
        expect(JSON.stringify(retained).split("Partial analysis, fully delivered:")).toHaveLength(2);
      } else if (delivery === "running") {
        // A launch receipt is not evidence that a terminal original was fully delivered.
        expect(entry).toMatchObject({ delivery: "unproved", sufficient: false });
        expect(entry.failedOriginal).toBeUndefined();
      } else {
        expect(entry.delivery).toBe(delivery === "unknown" ? "unproved" : "not-delivered");
        expect(entry.failedOriginal).toBeUndefined();
      }
    });
  }

  test("enforces whole-mission UTF-8 capacity including unrelated state and fails without retrying the essential write", async () => {
    const storage = new Map<string, unknown>([["unrelated-state", "u".repeat(200000)]]);
    const huge = "反".repeat(22000);
    const host = fixture((key, request) => key === "r1-simple" ? {
      ...published({ ...child(key), ok: false, structuredOutput: { status: "blocked", report: huge } }, request),
      raw: true, results: [],
    } : child(key));
    const result = await host.execute(undefined, storage);
    expect(Buffer.byteLength(huge, "utf8")).toBe(66000);
    expect(result).toMatchObject({ status: "failed", rounds: 1, validRounds: 0, error: expect.stringContaining("256 KiB") });
    expect(host.calls.map(call => call.key)).toEqual(["director-prepare", "r1-simple", "r1-recover"]);
    expect(storage.get("unrelated-state")).toBe("u".repeat(200000));
    const confirmed = storage.get("architecture-decision") as { originals: Original[]; rounds: number; validRounds: number };
    expect(confirmed).toMatchObject({ rounds: 1, validRounds: 0 });
    expect(confirmed.originals).toHaveLength(1);
    expect(JSON.stringify(confirmed)).not.toContain(huge);
    expect(host.stateWrites.filter(write => !write.persisted)).toHaveLength(1);
    expect(host.stateWrites.at(-1)!.bytes).toBeGreaterThan(256 * 1024);
    const mission = readFileSync(host.stateFile, "utf8");
    expect(Buffer.byteLength(mission, "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.parse(mission).state["unrelated-state"]).toBe("u".repeat(200000));
  });
});


test("architecture requires access to a delivered essential peer challenge before counting the round valid", async () => {
  const late = deferred<Result>();
  const host = fixture(key => key === "r2-recover" ? late.promise : child(key, key === "director-after-r1" ? discuss : finish), key => {
    late.resolve(child(key));
    return { state: "delivered" };
  });
  const result = await host.execute();
  expect(result).toMatchObject({ status: "failed", rounds: 2, validRounds: 1 });
  expect(result.error).toContain("Essential access incomplete");
  expect(host.calls.some(call => call.key === "director-after-r2")).toBe(false);
});


test("architecture accepts exact originals still accessible in retained context without universally rereading missing files", async () => {
  const storage = new Map<string, unknown>();
  const first = await fixture().execute(undefined, storage);
  const host = fixture((key, request) => {
    expect(key).toBe("director-prepare");
    expect(request.resume).toBe("native-director-after-r1");
    const accessibleContext = new Map(essentials(request).map(item => [item.id, originalValue(item)]));
    rmSync(essentials(request)[0]!.results![0]!.savedOutputPath!);
    const access = essentials(request).map(item => {
      expect(accessibleContext.get(item.id)?.report).toBe(`Private report from ${item.key}`);
      return { id: item.id, state: "accessible", source: "context", reason: "Exact original and association remain accessible in retained conversation" };
    });
    return { ...child(key), structuredOutput: { ...finish, access } };
  });
  expect(await host.execute({ continuation: first.continuation }, storage)).toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
  expect(host.calls).toHaveLength(1);
});


test("architecture preserves evidence from dynamically named perspectives even when their IDs resemble the director", async () => {
  const host = fixture((key, request) => {
    if (key === "director-prepare") return { ...child(key), structuredOutput: { ...discuss,
      perspectives: [perspectives[0], { id: "director-dissent", label: "Contrary whole-problem view", focus: "Challenge the recommendation" }],
    } };
    if (key === "director-after-r1") {
      expect(essentials(request).map(item => item.producer)).toEqual(["simple", "director-dissent"]);
      expect(originalValue(essentials(request)[1]!).report).toBe("Private report from r1-director-dissent");
    }
    return child(key);
  });
  expect(await host.execute()).toMatchObject({ status: "completed" });
});

test("architecture does not accept an inline access claim for a published original never delivered inline", async () => {
  const host = fixture((key, request) => key === "director-after-r1" ? { ...child(key), structuredOutput: { ...finish,
    access: essentials(request).map(item => ({ id: item.id, state: "accessible", source: "inline", reason: "Assumed earlier delivery" })),
  } } : child(key));
  expect(await host.execute()).toMatchObject({ status: "failed", error: expect.stringContaining("Essential access incomplete") });
});


describe("architecture durable dispatch boundaries", () => {
  const initial = { currentDecision: snapshot("Keep the complete current decision"), planning: true };
  function planningChild(key: string) {
    if (key === "director-doubts-r1") return { ...child(key), structuredOutput: { doubts: [
      { id: "fact", kind: "scout", dependsOn: [], question: "Which local contract applies?", decision: "Reuse" },
      { id: "human", kind: "human", dependsOn: [], question: "Prefer reuse?", decision: "Scope" },
    ] } };
    return child(key);
  }
  test.each(["director-prepare", "r1-simple", "r1-recover", "director-doubts-r1", "doubts-r1-0", "human-r1-0", "director-after-r1"])
    ("persists %s intention before dispatch and blocks reentry if its terminal save fails", async key => {
      let failures = 0;
      const host = fixture((producer, request) => {
        const retained = host.storage.get("architecture-decision") as DurableConsultation;
        expect(retained.cursor.dispatches).toContainEqual(expect.objectContaining({ key: producer, boundary: "intended" }));
        if (producer.startsWith("r1-")) expect(retained.rounds).toBe(1);
        return planningChild(producer);
      }, undefined, value => {
        if (value.cursor.dispatches.some(item => item.key === key && item.boundary === "confirmed")) {
          failures++;
          throw new Error(`Controlled terminal persistence cut: ${key}`);
        }
      });
      const result = await host.execute(initial);
      expect(result.status).toBe("failed");
      expect(result.error).toContain(`Controlled terminal persistence cut: ${key}`);
      expect(failures).toBe(1); // No retry from the catch or a concurrent producer.
      expect(host.calls.some(call => call.key === key)).toBe(true);
      const saved = host.storage.get("architecture-decision") as DurableConsultation;
      expect(saved.cursor.dispatches).toContainEqual(expect.objectContaining({ key, boundary: "intended" }));
      expect(result.rounds).toBe(saved.rounds); expect(result.validRounds).toBe(saved.validRounds);
      const resumed = fixture();
      await expect(resumed.execute({ planning: true, continuation: result.continuation }, host.storage)).rejects.toThrow("Unconfirmed architecture dispatch boundary");
      expect(resumed.calls).toHaveLength(0);
    });

  test.each(["director-prepare", "r1-simple", "director-doubts-r1", "doubts-r1-0", "human-r1-0", "director-after-r1"])
    ("does not launch %s when its intention cannot be persisted", async key => {
      let failures = 0;
      const host = fixture(planningChild, undefined, value => {
        if (value.cursor.dispatches.some(item => item.key === key && item.boundary === "intended")) {
          failures++;
          throw new Error(`Controlled intention cut: ${key}`);
        }
      });
      const result = await host.execute(initial);
      expect(result.status).toBe("failed"); expect(result.error).toContain(`Controlled intention cut: ${key}`);
      expect(failures).toBe(1);
      expect(host.calls.some(call => call.key === key)).toBe(false);
      expect(host.stateWrites.at(-1)?.persisted).toBe(false);
    });

  test("does not admit validity when the validity save fails, or renew the maximum on resume", async () => {
    let failures = 0;
    const host = fixture(undefined, undefined, value => {
      if (value.validRounds === 1) { failures++; throw new Error("Controlled validity cut"); }
    });
    const result = await host.execute({ currentDecision: snapshot("Decision"), maxRounds: 2 });
    expect(result).toMatchObject({ status: "failed", rounds: 1, validRounds: 0, error: "Controlled validity cut" });
    expect(failures).toBe(1);
    expect(host.storage.get("architecture-decision")).toMatchObject({ rounds: 1, validRounds: 0, maxRounds: 2 });
    for (const maxRounds of [1, 3, 10]) {
      const resumed = fixture();
      await expect(resumed.execute({ continuation: result.continuation, maxRounds }, host.storage)).rejects.toThrow("original maximum");
      expect(resumed.calls).toHaveLength(0);
    }
  });

  test("admission failure launches nothing and is not retried", async () => {
    let writes = 0;
    const host = fixture(undefined, undefined, () => { writes++; throw new Error("Controlled admission cut"); });
    await expect(host.execute()).rejects.toThrow("Controlled admission cut");
    expect(writes).toBe(1); expect(host.calls).toHaveLength(0); expect(host.storage.size).toBe(0);
  });

  test("rejects missing/incompatible durable cursors rather than migrating legacy state", async () => {
    const first = fixture(); const result = await first.execute();
    for (const cursor of [undefined, { version: 99, dispatches: [] }, { version: 1 }]) {
      const storage = new Map(first.storage);
      const prior = storage.get("architecture-decision") as object;
      storage.set("architecture-decision", { ...prior, cursor });
      const resumed = fixture();
      await expect(resumed.execute({ continuation: result.continuation }, storage)).rejects.toThrow("cursor");
      expect(resumed.calls).toHaveLength(0);
    }
  });

  test.each(["identity", "evidence", "duplicate"])("rejects a %s-corrupted confirmed cursor before dispatch", async fault => {
    const first = fixture(); const result = await first.execute();
    const retained = structuredClone(first.storage.get("architecture-decision")) as DurableConsultation;
    if (fault === "identity") retained.cursor.dispatches[0]!.originalId = "unrelated-original";
    if (fault === "evidence") retained.cursor.dispatches[0]!.runId = "unrelated-run";
    if (fault === "duplicate") retained.cursor.dispatches.push({ ...retained.cursor.dispatches[0]! });
    first.storage.set("architecture-decision", retained);
    const resumed = fixture();
    await expect(resumed.execute({ continuation: result.continuation }, first.storage)).rejects.toThrow("cursor");
    expect(resumed.calls).toHaveLength(0);
  });

  test("waits started siblings and retains long unsaved evidence plus permission and persistence diagnostics without another write", async () => {
    const sibling = deferred<Result>(); const started = deferred<void>();
    const publicationFailure = "Unsaved relay evidence: " + "mandatory publication unavailable; ".repeat(100);
    let settled = false, failures = 0, writesAtFailure = 0;
    const host = fixture(key => {
      if (key === "doubts-r1-0") { started.resolve(); return sibling.promise.then(value => { settled = true; return value; }); }
      if (key === "human-r1-0") return { ...child(key), ok: false, error: "Permission denied; Stop observed", outputSaveError: publicationFailure, structuredOutput: { status: "blocked", report: "Actual human frontier remains unanswered" } };
      return planningChild(key);
    }, undefined, value => {
      if (value.cursor.dispatches.some(item => item.key === "human-r1-0" && item.boundary === "confirmed")) {
        writesAtFailure = host.stateWrites.length;
        failures++; throw new Error("Essential persistence unavailable");
      }
    });
    let finished = false;
    const execution = host.execute(initial).then(value => { finished = true; return value; });
    await started.promise;
    expect(finished).toBe(false);
    sibling.resolve(child("doubts-r1-0"));
    const result = await execution;
    expect(settled).toBe(true); expect(failures).toBe(1);
    expect(result.status).toBe("failed"); expect(result.error).toContain("Essential persistence unavailable");
    expect(result.error).toContain("Permission denied; Stop observed");
    expect(result.error).toContain(publicationFailure);
    const [unsavedDiagnostics, barriers] = result.error!.split("; observed native barriers: ");
    expect(unsavedDiagnostics!.length).toBeGreaterThan(2400);
    expect(barriers).toContain("Permission denied; Stop observed");
    expect(host.stateWrites).toHaveLength(writesAtFailure);
    expect(host.calls.some(call => call.key === "director-after-r1")).toBe(false);
  });
});


describe("architecture confirmed phase advancement", () => {
  const continuation = { version: 2, consultation: "decision" };
  const decisionInput = { currentDecision: snapshot("Keep the whole decision"), planning: true, maxRounds: 2 };
  function planningResult(key: string) {
    return key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts: [
      { id: "fact", kind: "scout", dependsOn: [], question: "Local evidence?", decision: "Reuse" },
      { id: "human", kind: "human", dependsOn: [], question: "Prefer reuse?", decision: "Scope" },
    ] } } : child(key);
  }
  test.each(["admission", "director-prepare", "perspective-terminal", "round-index", "validity", "director-doubts-r1", "doubts-r1-0", "human-r1-0", "director-after-r1"])
    ("advances after a committed %s cut without replaying confirmed children or validity", async boundary => {
      let cut = false;
      const first = fixture(planningResult, undefined, undefined, value => {
        if (cut) return;
        const rows = value.cursor.dispatches;
        const matches = boundary === "admission" ? rows.length === 0
          : boundary === "perspective-terminal" ? rows.some(item => item.key === "r1-simple" && item.boundary === "confirmed") && value.validRounds === 0
          : boundary === "round-index" ? (value as unknown as { evidence: { reports?: unknown }[] }).evidence.some(item => item.reports) && value.validRounds === 0
          : boundary === "validity" ? value.validRounds === 1
          : rows.some(item => item.key === boundary && item.boundary === "confirmed");
        // Frontiers run concurrently: wait for both terminals, so the durable image
        // deliberately has no ambiguous sibling when demonstrating permitted reentry.
        if (matches && (["doubts-r1-0", "human-r1-0"].includes(boundary)
            ? ["doubts-r1-0", "human-r1-0"].every(key => rows.some(item => item.key === key && item.boundary === "confirmed")) : true)) {
          cut = true; throw new Error("Interruption after committed " + boundary);
        }
      });
      try { await first.execute(decisionInput); } catch (error) { expect(String(error)).toContain("after committed"); }
      expect(cut).toBe(true);
      const retained = first.storage.get("architecture-decision") as DurableConsultation;
      const confirmedKeys = retained.cursor.dispatches.filter(item => item.boundary === "confirmed").map(item => item.key);
      const second = fixture(planningResult);
      const result = await second.execute({ planning: true, continuation }, first.storage);
      expect(result).toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
      expect(second.calls.every(call => !confirmedKeys.includes(call.key))).toBe(true);
      const final = first.storage.get("architecture-decision") as DurableConsultation;
      expect(final.cursor.dispatches.filter(item => item.key.startsWith("r1-")).map(item => item.key).sort()).toEqual(["r1-recover", "r1-simple"]);
      expect(final).toMatchObject({ rounds: 1, validRounds: 1, maxRounds: 2, currentDecision: { revision: 1 } });
      const serialized = JSON.stringify(final);
      expect(serialized).not.toContain("Private report from");
    });

  test("does not treat a committed intention without a terminal as a safe reentry point", async () => {
    let interrupted = false;
    const first = fixture(undefined, undefined, undefined, value => {
      if (!interrupted && value.cursor.dispatches.some(item => item.key === "director-prepare" && item.boundary === "intended")) {
        interrupted = true; throw new Error("Committed intention cut");
      }
    });
    await first.execute();
    expect(first.calls).toHaveLength(0);
    const second = fixture();
    await expect(second.execute({ continuation }, first.storage)).rejects.toThrow("Unconfirmed architecture dispatch boundary");
    expect(second.calls).toHaveLength(0);
  });
});


describe("architecture selective factual retry", () => {
  const continuation = { version: 2, consultation: "decision" };
  function reply(key: string): Result {
    if (key.startsWith("director-doubts-")) return { ...child(key), structuredOutput: { doubts: [
      { id: "retained", kind: "scout", dependsOn: [], question: "Sufficient local fact?", decision: "Reuse" },
      { id: "missing", kind: "researcher", dependsOn: [], question: "Missing external fact?", decision: "Reuse" },
      { id: "scope", kind: "human", dependsOn: ["retained", "missing"], question: "Prefer reuse?", decision: "Scope" },
    ] } };
    if (key === "doubts-r1-1") return { ...child(key), ok: false, error: "Terminal factual failure",
      structuredOutput: { status: "blocked", report: "Complete but insufficient contrary analysis" } };
    return child(key);
  }
  async function failed(missing = false) {
    const first = fixture(key => missing && key === "doubts-r1-1" ? { ok: false, runId: "terminal-missing-fact", error: "Terminal factual failure; no original delivered" } : reply(key));
    expect(await first.execute({ planning: true, currentDecision: snapshot("Complete problem"), maxRounds: 1 }))
      .toMatchObject({ status: "failed", rounds: 1, validRounds: 1 });
    const retained = first.storage.get("architecture-decision") as { originals: Original[] };
    const original = retained.originals.find(item => item.key === "doubts-r1-1")!;
    return { first, original, retry: { consultation: "decision", revision: 1, originalIds: [original.id],
      authorization: { content: "Actual human authorizes retry of the missing factual answer", provenance: "Foreground human message 55" } } };
  }
  test("retries only the authorized terminal factual provider, retains sufficient facts, then unblocks the human frontier without a new round", async () => {
    const { first, original, retry } = await failed();
    const second = fixture((key, request) => {
      expect(key).not.toBe("director-prepare"); expect(key).not.toStartWith("r2-");
      if (key === "doubts-r1-1") expect(request.output).toContain("a2.json");
      if (key === "human-r1-0") {
        expect(request.task).toContain("Brief factual frontier");
        expect(request.task).not.toContain("Private report from");
      }
      return child(key);
    });
    expect(await second.execute({ planning: true, continuation, factualRetry: retry }, first.storage))
      .toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
    expect(second.calls.map(item => item.key)).toEqual(["doubts-r1-1", "human-r1-0", "director-after-r1"]);
    const state = first.storage.get("architecture-decision") as { originals: Original[]; currentDecision: { revision: number }; cursor: { retries: unknown[] } };
    expect(state.currentDecision.revision).toBe(1);
    expect(state.originals.filter(item => item.key === "doubts-r1-0")).toHaveLength(1);
    expect(state.originals.filter(item => item.key === "doubts-r1-1")).toHaveLength(2);
    expect(state.originals.find(item => item.id === original.id)).toMatchObject({ sufficient: false, runId: original.runId });
    expect(state.cursor.retries).toEqual([retry]);
  });
  test("terminal non-delivery needs explicit authorization and never becomes a fabricated essential", async () => {
    const { first, original, retry } = await failed(true);
    const denied = fixture();
    await expect(denied.execute({ planning: true, continuation }, first.storage)).rejects.toThrow("Unconfirmed architecture dispatch boundary");
    expect(denied.calls).toHaveLength(0);
    const second = fixture((key, request) => {
      expect(essentials(request).some(item => item.id === original.id)).toBe(false);
      return child(key);
    });
    expect(await second.execute({ planning: true, continuation, factualRetry: retry }, first.storage))
      .toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
    expect(second.calls.map(call => call.key)).toEqual(["doubts-r1-1", "human-r1-0", "director-after-r1"]);
    const retained = first.storage.get("architecture-decision") as { originals: Original[] };
    expect(retained.originals.find(item => item.id === original.id)).toEqual(original);
    expect(original).toMatchObject({ delivery: "not-delivered", sufficient: false, publication: "unpublished" });
    expect(original.failedOriginal).toBeUndefined();
  });
  test.each(["unproved", "running", "permission", "published-missing"])("does not bypass %s evidence or native barriers with retry authorization", async fault => {
    const first = fixture((key, request) => {
      if (key !== "doubts-r1-1") return reply(key);
      if (fault === "running") return { ok: false, runId: "active-fact", state: "running" };
      if (fault === "permission") return { ok: false, runId: "denied-fact", error: "Permission denied; Stop" };
      if (fault === "published-missing") return { ok: false, runId: "saved-fact", results: [{ savedOutputPath: "/missing-original" }] };
      const result = published(reply(key), request);
      delete (result.structuredOutput as Record<string, unknown>).delivery;
      return { ...result, raw: true };
    });
    await first.execute({ planning: true, currentDecision: snapshot("Complete problem"), maxRounds: 1 });
    const original = (first.storage.get("architecture-decision") as { originals: Original[] }).originals.find(item => item.key === "doubts-r1-1")!;
    const second = fixture();
    try {
      const result = await second.execute({ planning: true, continuation, factualRetry: {
        consultation: "decision", revision: 1, originalIds: [original.id],
        authorization: { content: "Retry this fact", provenance: "Actual human" },
      } }, first.storage);
      expect(result.status).toBe("failed"); expect(result.error).toContain("barrier");
    } catch (error) { expect(String(error)).toContain("Unconfirmed architecture dispatch boundary"); }
    expect(second.calls).toHaveLength(0);
  });
  for (const missing of [false, true]) {
    test.each(["authorization", "intention", "terminal", "human-intention", "human-terminal", "evaluation"])
      (`retry with missing=${missing} survives committed %s cuts without replay`, async boundary => {
        const { first, retry } = await failed(missing);
        let cut = false;
        const second = fixture(key => child(key), undefined, undefined, value => {
          const cursor = value.cursor as unknown as { retries?: unknown[]; dispatches: { key: string; boundary: string; attempt: number }[] };
          const factual = cursor.dispatches.find(item => item.key === "doubts-r1-1" && item.attempt === 2);
          const human = cursor.dispatches.find(item => item.key === "human-r1-0");
          const matches = boundary === "authorization" ? cursor.retries?.length === 1 && !factual
            : boundary === "intention" ? factual?.boundary === "intended"
            : boundary === "terminal" ? factual?.boundary === "confirmed" && !human
            : boundary === "human-intention" ? human?.boundary === "intended"
            : boundary === "human-terminal" ? human?.boundary === "confirmed"
            : cursor.dispatches.some(item => item.key === "director-after-r1" && item.boundary === "confirmed");
          if (!cut && matches) { cut = true; throw new Error("Committed retry cut " + boundary); }
        });
        try { await second.execute({ planning: true, continuation, factualRetry: retry }, first.storage); }
        catch (error) { expect(String(error)).toContain("Committed retry cut"); }
        expect(cut).toBe(true);
        const third = fixture();
        if (["intention", "human-intention"].includes(boundary)) {
          await expect(third.execute({ planning: true, continuation }, first.storage)).rejects.toThrow("Unconfirmed architecture dispatch boundary");
          expect(third.calls).toHaveLength(0);
        } else {
          expect(await third.execute({ planning: true, continuation }, first.storage))
            .toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
          expect(third.calls.some(call => second.calls.some(prior => prior.key === call.key))).toBe(false);
        }
        expect(first.storage.get("architecture-decision")).toMatchObject({ rounds: 1, validRounds: 1, maxRounds: 1, currentDecision: { revision: 1 } });
      });
  }
  test("a terminal failed retry needs a new authorization targeting its own attempt", async () => {
    const { first, retry } = await failed();
    const second = fixture(reply);
    expect(await second.execute({ planning: true, continuation, factualRetry: retry }, first.storage)).toMatchObject({ status: "failed" });
    const third = fixture();
    await expect(third.execute({ planning: true, continuation, factualRetry: retry }, first.storage)).rejects.toThrow("Invalid factual retry");
    expect(third.calls).toHaveLength(0);
    const state = first.storage.get("architecture-decision") as { originals: Original[] };
    const latest = [...state.originals].reverse().find(item => item.key === "doubts-r1-1")!;
    const fourth = fixture();
    expect(await fourth.execute({ planning: true, continuation, factualRetry: { ...retry, originalIds: [latest.id],
      authorization: { content: "Retry failed second attempt", provenance: "Actual human message 56" } } }, first.storage))
      .toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
    expect(fourth.calls[0]!.request.output).toContain("a3.json");
    expect((first.storage.get("architecture-decision") as { originals: Original[] }).originals.filter(item => item.key === "doubts-r1-0")).toHaveLength(1);
  });
  test.each(["no-authorization", "wrong-query", "wrong-revision", "sufficient-provider", "perspective", "duplicate"])
    ("rejects %s factual retry before dispatch", async fault => {
      const { first, retry } = await failed();
      const input = structuredClone(retry);
      if (fault === "no-authorization") input.authorization.provenance = "";
      if (fault === "wrong-query") input.consultation = "other";
      if (fault === "wrong-revision") input.revision = 2;
      if (fault === "sufficient-provider" || fault === "perspective") {
        const state = first.storage.get("architecture-decision") as { originals: Original[] };
        input.originalIds = [state.originals.find(item => item.key === (fault === "perspective" ? "r1-simple" : "doubts-r1-0"))!.id];
      }
      if (fault === "duplicate") input.originalIds.push(input.originalIds[0]!);
      const second = fixture();
      await expect(second.execute({ planning: true, continuation, factualRetry: input }, first.storage)).rejects.toThrow("Invalid factual retry");
      expect(second.calls).toHaveLength(0);
    });
  test("an ambiguous factual retry blocks a further invocation even with the old authorization", async () => {
    const { first, retry } = await failed();
    const second = fixture(key => { if (key === "doubts-r1-1") throw new Error("Dispatch outcome unknown"); return child(key); });
    expect(await second.execute({ planning: true, continuation, factualRetry: retry }, first.storage)).toMatchObject({ status: "failed", rounds: 1, validRounds: 1 });
    const third = fixture();
    await expect(third.execute({ planning: true, continuation, factualRetry: retry }, first.storage)).rejects.toThrow("Unconfirmed architecture dispatch boundary");
    expect(third.calls).toHaveLength(0);
  });
  test("does not obey a director request for another comparison after selective factual retry", async () => {
    const { first, retry } = await failed();
    const second = fixture(key => child(key, discuss));
    expect(await second.execute({ planning: true, continuation, factualRetry: retry }, first.storage))
      .toMatchObject({ status: "failed", rounds: 1, validRounds: 1, error: expect.stringContaining("cannot start another comparison") });
    expect(second.calls.some(item => item.key.startsWith("r2-"))).toBe(false);
  });
});


describe("architecture committed dispatch intentions", () => {
  test.each(["director-prepare", "r1-simple", "director-doubts-r1", "doubts-r1-0", "human-r1-0", "director-after-r1"])
    ("never redispatches after an interruption following the committed %s intention", async key => {
      let interrupted = false;
      const first = fixture(producer => producer.startsWith("director-doubts-") ? { ...child(producer), structuredOutput: { doubts: [
        { id: "fact", kind: "scout", dependsOn: [], question: "Local contract?", decision: "Reuse" },
        { id: "human", kind: "human", dependsOn: [], question: "Prefer reuse?", decision: "Scope" },
      ] } } : child(producer), undefined, undefined, value => {
        if (!interrupted && value.cursor.dispatches.some(item => item.key === key && item.boundary === "intended")) {
          interrupted = true; throw new Error("Interrupted after durable intention " + key);
        }
      });
      await first.execute({ planning: true, currentDecision: snapshot("Complete problem") });
      expect(interrupted).toBe(true);
      expect(first.calls.some(call => call.key === key)).toBe(false);
      const second = fixture();
      await expect(second.execute({ planning: true, continuation: { version: 2, consultation: "decision" } }, first.storage))
        .rejects.toThrow("Unconfirmed architecture dispatch boundary");
      expect(second.calls).toHaveLength(0);
    });

  test.each(["missing", "version", "planning", "round", "next", "projection"])
    ("rejects %s phase control before writing or dispatching", async fault => {
      const first = fixture(); const result = await first.execute();
      const state = first.storage.get("architecture-decision") as { cursor: { control?: Record<string, unknown>; dispatches: { controlOutput?: unknown }[] } };
      if (fault === "missing") delete state.cursor.control;
      else if (fault === "version") state.cursor.control!.version = 99;
      else if (fault === "planning") state.cursor.control!.planning = true;
      else if (fault === "round") { state.cursor.control!.round = 99; state.cursor.control!.stage = "evaluate"; }
      else if (fault === "next") { state.cursor.control!.next = { action: "finish" }; state.cursor.control!.stage = "perspectives"; }
      else state.cursor.dispatches[0]!.controlOutput = { action: "finish" };
      // Exercise pending control, rather than asking to begin a post-conclusion cycle.
      (state.cursor as unknown as { phase: string }).phase = "architecture-evaluate";
      const second = fixture();
      await expect(second.execute({ continuation: result.continuation }, first.storage)).rejects.toThrow("phase control");
      expect(second.calls).toHaveLength(0); expect(second.stateWrites).toHaveLength(0);
    });
});


describe("architecture rolling-round durable evidence", () => {
  test("preserves delivered steering obligations across a terminal-before-validity interruption", async () => {
    const second = deferred<Result>(), receipt = deferred<{ state: string }>();
    let cut = false;
    const first = fixture(key => key === "r2-recover" ? second.promise : child(key, key === "director-after-r1" ? discuss : finish),
      key => { second.resolve(child(key)); return receipt.promise; }, undefined, value => {
        const current = value as unknown as { cursor: { dispatches: { key: string; boundary: string }[]; steering?: { state: string }[] } };
        const allConfirmed = ["r2-simple", "r2-recover"].every(key => current.cursor.dispatches.some(item => item.key === key && item.boundary === "confirmed"));
        if (allConfirmed) receipt.resolve({ state: "delivered" });
        if (!cut && allConfirmed && current.cursor.steering?.some(item => item.state === "delivered")) {
          cut = true; throw new Error("Committed challenge receipt cut");
        }
      });
    const result = await first.execute();
    expect(result).toMatchObject({ status: "failed", rounds: 2, validRounds: 1 });
    expect(cut).toBe(true);
    const resumed = fixture();
    expect(await resumed.execute({ continuation: result.continuation }, first.storage))
      .toMatchObject({ status: "failed", rounds: 2, validRounds: 1, error: expect.stringContaining("peer challenge") });
    expect(resumed.calls).toHaveLength(0); expect(resumed.steered).toHaveLength(0);
  });

  test("does not repeat steering whose delivery is unconfirmed, even when both producers are terminal", async () => {
    let cut = false;
    const first = fixture(key => child(key, key === "director-after-r1" ? discuss : finish), undefined, undefined, value => {
      const steering = (value.cursor as unknown as { steering?: { state: string }[] }).steering;
      if (!cut && steering?.some(item => item.state === "intended")) {
        cut = true; throw new Error("Committed steering intention cut");
      }
    });
    const result = await first.execute();
    expect(cut).toBe(true); expect(first.steered).toHaveLength(0);
    const resumed = fixture();
    await expect(resumed.execute({ continuation: result.continuation }, first.storage)).rejects.toThrow("Unconfirmed architecture steering boundary");
    expect(resumed.calls).toHaveLength(0); expect(resumed.steered).toHaveLength(0);
  });
});


test("architecture persists a full replacement at a confirmed mid-round boundary without treating the abandoned round as valid", async () => {
  let cut = false;
  const first = fixture(undefined, undefined, undefined, value => {
    if (!cut && value.rounds === 1 && value.validRounds === 0 && ["r1-simple", "r1-recover"].every(key =>
        value.cursor.dispatches.some(item => item.key === key && item.boundary === "confirmed"))) {
      cut = true; throw new Error("Committed comparison terminal cut");
    }
  });
  const interrupted = await first.execute({ currentDecision: snapshot("OBSOLETE mechanism A"), maxRounds: 3 });
  expect(interrupted).toMatchObject({ status: "failed", rounds: 1, validRounds: 0 });
  const second = fixture((key, request) => {
    const retained = first.storage.get("architecture-decision") as { currentDecision: { revision: number; snapshot: { brief: string } } };
    expect(retained.currentDecision).toMatchObject({ revision: 2, snapshot: { brief: "CURRENT whole mechanism B" } });
    expect(request.task).not.toContain("OBSOLETE mechanism A");
    expect(request.task).toContain("CURRENT whole mechanism B");
    return child(key);
  });
  const result = await second.execute({ continuation: interrupted.continuation,
    replacement: replacement("decision", 1, snapshot("CURRENT whole mechanism B")) }, first.storage);
  expect(result).toMatchObject({ status: "completed", rounds: 2, validRounds: 1 });
  expect(second.calls.some(call => call.key.startsWith("r1-"))).toBe(false);
  expect(first.storage.get("architecture-decision")).toMatchObject({ currentDecision: { revision: 2 }, decisionHistory: [
    { revision: 1, snapshot: { brief: "OBSOLETE mechanism A" } },
  ] });
});
