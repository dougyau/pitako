import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWorkflowScript, validateWorkflowScript, type WorkflowScriptChildResult } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { normalizeWorkflowArgs } from "../node_modules/pi-subagents/src/workflows/workflow-resources.js";
import type { WorkflowTerminalOutcome } from "../node_modules/pi-subagents/src/shared/types.js";
import { verifyGate } from "../extensions/access-receipts.mjs";

const rawSource = readFileSync(new URL("../skills/architecture/workflow.js", import.meta.url), "utf8");

test.each(["node", "bun"])("packaged architecture preserves awaited dispatch and failure diagnostics under %s", async runtime => {
  const child = Bun.spawn([
    runtime, path.join(import.meta.dir, "fixtures/architecture-native-await.cjs"),
    path.join(import.meta.dir, "../skills/architecture/workflow.js"),
  ], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
});

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
  outputSaveError?: string; results?: { savedOutputPath?: string }[] }
const originalsRoot = mkdtempSync(path.join(tmpdir(), "pitako-architecture-originals-"));
afterAll(() => rmSync(originalsRoot, { recursive: true, force: true }));
let publicationSequence = 0;
// Named-resource resolution inlines the mission binding; the raw path alone refuses to run.
// Each run owns its mission so receipts never collide across tests.
function boundSource() {
  const missionPath = path.join(originalsRoot, `architecture-mission-${++publicationSequence}.json`);
  writeFileSync(missionPath, "{}");
  return `const pitakoAccess = ${JSON.stringify({ missionPath, namespace: "architecture-test" })};\n${rawSource}`;
}
const source = boundSource();
// Verified references a consumer receives: {id, path, digest}.
function essentials(request: Request): Original[] {
  const references = JSON.parse(request.task.match(/VERIFIED ESSENTIAL ORIGINALS \(references; receipt [^)]*\): (.*)\n/)?.[1] ?? "[]");
  return references.map((reference: { id: string; path: string }) => ({ ...reference, results: [{ savedOutputPath: reference.path }] }));
}
// The real model-free verifier at the controlled launch boundary.
function verifierResult(key: string, request: Request): Result {
  return { ok: true, agent: "pitako.access-verifier", runId: `native-${key}`, output: JSON.stringify(verifyGate(JSON.parse(request.task))),
    results: [{ exitCode: 0 }] };
}
function originalValue(original: Original): Record<string, unknown> {
  if (original.failedOriginal) return original.failedOriginal;
  const saved = original.results?.find(child => child.savedOutputPath)?.savedOutputPath;
  if (!saved) throw new Error(`No publication for ${original.id}. ${original.diagnostic ?? "Original not delivered."}`);
  const value = JSON.parse(readFileSync(saved, "utf8"));
  expect(value).not.toHaveProperty("association");
  expect(value).not.toHaveProperty("delivery");
  expect(value).not.toHaveProperty("access");
  if (original.producer !== undefined && original.producer !== "director-doubts" && !original.key.startsWith("director-")) {
    expect(["ready", "blocked"]).toContain(value.status);
    expect(typeof value.report).toBe("string");
  }
  return value;
}
function evidenceText(request: Request) {
  return request.task + essentials(request).map(item => JSON.stringify(originalValue(item))).join("\n");
}
function published(result: Result, request: Request): Result {
  if (result.raw) { const { raw, ...value } = result; return value; }
  if (result.structuredOutput === undefined) return result;
  for (const original of essentials(request)) originalValue(original);
  const value = { ...(result.structuredOutput as object) };
  if (request.phase === "architecture-factual") Object.assign(value, { humanContext: `Brief factual frontier from ${request.key}: material facts, reasons, contrary claims, limits and sources.`, ...(result.structuredOutput as object) });
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
  status: "completed" | "blocked" | "failed" | "needs-human";
  frontier?: { consultation: string; revision: number; round: number; humanContext: string; questions: { id: string; question: string; decision: string; recommendation?: string; dependsOn: string[]; prerequisiteFacts: { id: string; humanContext: string }[] }[] };
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
  clock: Pick<typeof Date, "now"> = Date,
) {
  const calls: { key: string; request: Request }[] = [];
  const batches: Request[][] = [];
  const steered: { key: string; message: string; options: unknown }[] = [];
  const seen = new Set<string>();
  const verifications: { key: string; request: Request }[] = [];
  function launch(key: string, request: Request): Promise<Result> {
    expect(seen.has(key)).toBe(false);
    seen.add(key);
    if (request.agent === "pitako.access-verifier") {
      verifications.push({ key, request });
      return Promise.resolve().then(() => verifierResult(key, request));
    }
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
      if (requests.every(request => request.agent !== "pitako.access-verifier")) batches.push(requests);
      return Promise.all(requests.map(request => launch(request.key!, request)));
    },
    steer(key: string, message: string, options: unknown) {
      steered.push({ key, message, options });
      return Promise.resolve().then(() => steer(key));
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...parameters: string[]
  ) => (args: unknown, runner: typeof runs, state?: unknown, clock?: Pick<typeof Date, "now">) => Promise<Outcome>;
  const privateState = new Map<string, unknown>();
  const stateFile = path.join(originalsRoot, `mission-${++publicationSequence}.json`);
  const stateWrites: { bytes: number; persisted: boolean }[] = [];
  const fixtureSource = boundSource();
  const execute = async (args: unknown = { currentDecision: snapshot("Choose a complete persistence design") }, storage: Map<string, unknown> = privateState) => {
    const normalized = normalizeWorkflowArgs(JSON.parse(JSON.stringify(args)));
    if ("error" in normalized && (args as Record<string, unknown>).humanAnswers !== undefined) throw new Error(normalized.error);
    return new AsyncFunction("args", "runs", "state", "Date", fixtureSource)({ consultation: "decision", workDescription: "Choose persistence architecture", ...(args as object) }, runs, storage && {
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
    }, clock);
  };
  return { execute, calls, verifications, batches, steered, storage: privateState, stateWrites, stateFile };
}

describe("architecture dynamic perspective roles", () => {
  const ids = ["scout", "researcher", "evidence-auditor", "preferences"];
  const roster = ids.map(id => ({ id, label: id + " perspective", focus: "Compare the whole decision" }));
  const decision = { ...discuss, perspectives: roster };
  const continuation = { version: 3, consultation: "decision" };

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
        : "architecture-perspective";
      expect(request.phase).toBe(expected);
      if (key.startsWith("r")) expect(title).toContain(key.startsWith("r1-") ? "Round 1" : "Round 2");
      if (key.startsWith("director-doubts-")) return { ...child(key), structuredOutput: { doubts: [
        { id: "fact", kind: "scout", dependsOn: [], question: "Local contract?", decision: "Reuse" },
        { id: "external", kind: "researcher", dependsOn: [], question: "External contract?", decision: "Reuse" },
        { id: "conflict", kind: "evidence-auditor", dependsOn: [], question: "Contradictory claims?", decision: "Reuse" },
        { id: "human", kind: "deliberation", dependsOn: [], question: "Prefer reuse (recommended)?", decision: "Scope" },
      ] } };
      return child(key, key === "director-after-r1" ? discuss : finish);
    });
    const result = await host.execute({ workDescription: description, planning: true,
      currentDecision: snapshot("ADMINISTRATIVE PREAMBLE: whole current problem") });
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(2);
    for (const phase of ["architecture-prepare", "architecture-evaluate", "architecture-doubts", "architecture-perspective", "architecture-factual"])
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
          return result;
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
    expect(first.continuation).toEqual({ version: 3, consultation: "decision" });
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
        { id: "human", kind: "deliberation", dependsOn: [], question: "Keep scope (recommended)?", decision: "Scope" },
      ] } };
      return child(key);
    });
    const result = await host.execute({ consultation: "current", planning, continuation: first.continuation, replacement: update() }, storage);
    expect(result).toMatchObject({ status: "completed", rounds: 2 });
    expect(host.calls.find(call => call.key === "r2-simple")?.request.resume).toBe("native-r1-simple");
    expect(host.calls.find(call => call.key === "r2-new")?.request.context).toBe("fresh");
    expect(host.calls.some(call => call.request.agent !== undefined && call.request.agent !== "pitako.architect" && call.request.phase !== "architecture-factual")).toBe(false);
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
      expect(storage.get("architecture-current")).toMatchObject({ version: 3, currentDecision: { revision: 1, snapshot: initial() } });
      return { ...child(key), structuredOutput: { ...finish, action: "blocked" } };
    });
    expect(await host.execute({ consultation: "current", planning, currentDecision: initial() }, storage)).toMatchObject({ status: "blocked" });
    for (const continuation of [{ version: 2, consultation: "current" }, { version: 3, consultation: "foreign" }]) {
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
    expect(JSON.stringify(retained)).toContain(blocker); // The workflow retains the admitted envelope, not a model identity echo.
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
      { id: "scope", dependsOn: [], kind: "human", question: "Prefer scope A?", decision: "Scope boundary", recommendation: "Use scope A" },
    ] } } : child(key));
    const blocked = await first.execute({ currentDecision: snapshot("Decision"), planning: true, consultation: "same", maxRounds: 2 }, storage);
    expect(blocked.status).toBe("needs-human"); expect(blocked.rounds).toBe(1);
    expect(blocked.frontier?.questions[0]?.question).toBe("Prefer scope A?");
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

describe("architecture foreground human frontier", () => {
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
    const previous = { version: 3, consultation: "cap", currentDecision: { revision: 1, snapshot: snapshot("Original decision") }, decisionHistory: [], rounds: 10, validRounds: 10, maxRounds: 10, directorRunId: "native-doubts-r10", members: [], cursor: { version: 2, phase: "concluded", dispatches: [], control: { version: 1, planning: true, start: 0, stage: "prepare", next: null, round: null } }, evidence: [{ round: 10, question: "Prefer scope A?" }] };
    const storage = new Map<string, unknown>([["architecture-cap", previous]]);
    const host = fixture((key, request) => {
      expect(key).toBe("director-prepare"); expect(request.task).toContain("Actual human answered A");
      expect(request.task).toContain("finish or blocked only");
      return { ok: true, runId: "native-synthesis", structuredOutput: finish };
    });
    const result = await host.execute({ replacement: replacement("cap", 1, snapshot("Original decision; Actual human answered A", { humanDecisions: [{ id: "scope", content: "A", provenance: "Actual foreground human answer" }] })), planning: true, consultation: "cap", continuation: { version: 3, consultation: "cap" } }, storage);
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
    expect(JSON.stringify(storage.get("architecture-large"))).toContain("x".repeat(4090));
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
    expect(JSON.stringify(retained)).toContain("x".repeat(4090));
    for (const view of roster) expect(JSON.stringify(originalValue(retained.originals.find(item => item.producer === view.id)!)))
      .toContain(`r1-${view.id}:` + "x".repeat(4090));
  });

  test.each([
    ["deliberation", ["missing"]], ["deliberation", ["scope"]], ["deliberation", ["ask"]], ["deliberation", ["weigh"]],
    ["human", ["missing"]], ["human", ["weigh"]], ["human", ["ask"]], ["scout", ["fact"]], ["researcher", ["fact"]],
  ])("rejects a %s doubt depending on %p before dispatching any providers", async (kind, dependsOn) => {
    const host = fixture(key => key.startsWith("director-doubts-") ? { ok: true, runId: key, structuredOutput: { doubts: [
      { id: "fact", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
      { id: "ask", kind: "human", dependsOn: [], question: "Scope B?", decision: "Scope", recommendation: "Use scope B" },
      { id: "weigh", kind: "deliberation", dependsOn: [], question: "Weigh seams?", decision: "Seams" },
      { id: "scope", kind, dependsOn, question: "Scope A?", decision: "Scope", recommendation: "Use scope A" },
    ] } } : child(key));
    const result = await host.execute({ currentDecision: snapshot("Decision"), planning: true, consultation: "invalid" }, new Map());
    expect(result.status).toBe("failed"); expect(result.error).toContain("dependencies");
    expect(host.calls.some(call => call.request.phase === "architecture-factual")).toBe(false);
  });

  const layered = [
    { id: "identity", kind: "scout", dependsOn: [], question: "Identity plane limits?", decision: "SEG path" },
    { id: "edges", kind: "researcher", dependsOn: [], question: "Readmodel edges?", decision: "Critical path" },
    { id: "seams", kind: "deliberation", dependsOn: ["edges", "identity"], question: "Settle the DAG seams", decision: "Crate edges" },
    { id: "limits", kind: "human", dependsOn: ["identity"], question: "Accept limits?", decision: "Volume limits", recommendation: "Accept limits" },
  ];
  function layeredRespond(key: string): Result {
    return key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts: layered } } : child(key);
  }

  test("resolves deliberation doubts in evaluation only after their factual prerequisites", async () => {
    const doubts = layered.filter(item => item.kind !== "human");
    const host = fixture((key, request) => {
      if (key === "director-after-r1") {
        expect(request.task).toContain("Resolve deliberation doubts here");
        expect(request.task).toContain(JSON.stringify(doubts[2]));
        for (const id of ["identity", "edges"]) expect(request.task).toMatch(new RegExp(`"key":"doubts-r1-\\d","doubtId":"${id}","originalId":"decision\\.v1\\.doubts-r1-\\d\\.a1"`));
        return child(key, finish);
      }
      return key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts } } : child(key);
    });
    expect(await host.execute({ currentDecision: snapshot("Decision"), planning: true, maxRounds: 1 }))
      .toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
    const keys = host.calls.map(call => call.key);
    expect(host.calls.filter(call => call.request.phase === "architecture-factual").map(call => call.request.agent))
      .toEqual(["pitako.scout", "pitako.researcher"]);
    expect(keys.indexOf("director-after-r1")).toBeGreaterThan(keys.indexOf("doubts-r1-1"));
  });

  test("reenters a confirmed doubts stage with deliberation prerequisites without relaunching the director", async () => {
    // Reproduce the retained shape of a run rejected before this rule: doubts confirmed, stage still doubts.
    let cut = false;
    const first = fixture(layeredRespond, undefined, undefined, value => {
      const control = (value.cursor as unknown as { control: { stage: string } }).control;
      if (!cut && control.stage === "doubts" && value.cursor.dispatches.some(item => item.key === "director-doubts-r1" && item.boundary === "confirmed")) {
        cut = true; throw new Error("Cut after confirmed doubts");
      }
    });
    expect(await first.execute({ planning: true, currentDecision: snapshot("Decision"), maxRounds: 5 }))
      .toMatchObject({ status: "failed", rounds: 1, validRounds: 1 });
    expect(first.storage.get("architecture-decision")).toMatchObject({ rounds: 1, validRounds: 1,
      cursor: { control: { stage: "doubts", round: 1 } } });
    const resumed = fixture();
    const result = await resumed.execute({ planning: true, continuation: { version: 3, consultation: "decision" } }, first.storage);
    expect(result).toMatchObject({ status: "needs-human", rounds: 1, validRounds: 1, frontier: { round: 1, questions: [
      { id: "limits", dependsOn: ["identity"], prerequisiteFacts: [{ id: "identity", key: "doubts-r1-0" }] },
    ] } });
    expect(resumed.calls.map(call => call.key)).toEqual(["doubts-r1-0", "doubts-r1-1"]);
    const retained = first.storage.get("architecture-decision") as DurableConsultation;
    expect(retained.cursor.dispatches.filter(item => item.key === "director-doubts-r1").map(item => item.originalId))
      .toEqual(["decision.v1.director-doubts-r1.a1"]);
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
        const originals = essentials(request) as unknown as { id: string; path: string; digest: string }[];
        expect(originals).toHaveLength(2);
        // Consumers receive verified references only: {id, path, digest}, never metadata to transcribe.
        expect(originals.every(item => Object.keys(item).sort().join(",") === "digest,id,path,results")).toBe(true);
        expect(originals.every(item => /^[a-f0-9]{64}$/.test(item.digest) && item.id.startsWith("decision.v1."))).toBe(true);
        expect(new Set(originals.map(item => item.id)).size).toBe(2);
        expect(originals.map(item => originalValue(item as never).report)).toContain(contrary);
        expect(request.task).toContain("Read each path in full with your read tools");
      }
      return child(key);
    });
    expect(await host.execute()).toMatchObject({ status: "completed", memo: finish.memo });
    const retained = host.storage.get("architecture-decision") as { originals: Original[]; evidence: unknown[] };
    expect(JSON.stringify(retained)).toContain(contrary);
    expect(retained.originals.find(item => item.producer === "recover")).toMatchObject({ runId: "native-r1-recover", accessibility: "unverified" });
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
  test.each(["director-prepare", "r1-simple", "director-doubts-r1", "doubts-r1-0", "director-after-r1"])(`honors native ${control} at %s rather than advancing or hiding the barrier`, async failedKey => {
    const host = fixture((key, request) => {
      const value = key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts: [
        { id: "fact", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
        { id: "human", kind: "deliberation", dependsOn: [], question: "Reuse (recommended)?", decision: "Scope" },
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
    expect(exact).toMatchObject({ status: "blocked" });
    expect(exact).not.toHaveProperty("delivery");
    // The failed essential save must not claim that its inline evidence was persisted.
    const last = host.storage.get("architecture-decision") as { originals: Original[] };
    expect(last.originals).toHaveLength(1);
    expect(host.calls).toHaveLength(3);
  });

  test("requests decisions only and attaches identity envelopes after native admission", async () => {
    const host = fixture((key, request) => {
      const schema = request.outputSchema as { required: string[]; properties: Record<string, unknown> };
      for (const echo of ["association", "delivery", "access"]) {
        expect(schema.required).not.toContain(echo);
        expect(schema.properties).not.toHaveProperty(echo);
      }
      expect(request.task).not.toContain("ORIGINAL CONTRACT");
      expect(request.task).not.toContain("access receipt");
      expect(request.task).not.toContain("Return access");
      if (essentials(request).length) expect(request.task).toContain("Read each path in full with your read tools");
      return key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts: [
        { id: "local", kind: "scout", dependsOn: [], question: "Local fact?", decision: "Reuse" },
      ] } } : child(key);
    });
    expect(await host.execute({ planning: true, currentDecision: snapshot("Whole decision") })).toMatchObject({ status: "completed" });
    const retained = host.storage.get("architecture-decision") as { originals: (Original & { association: unknown; value: unknown })[] };
    for (const original of retained.originals) {
      expect(original).toMatchObject({ id: expect.any(String), delivery: "complete",
        association: { consultation: "decision", revision: 1, key: original.key, producer: original.producer },
        value: originalValue(original) });
    }
  });

  test.each(["missing", "invalid"])("a controlled reader blocks synthesis for a %s published file", async failure => {
    const host = fixture((key, request) => {
      if (key === "director-after-r1") {
        const saved = essentials(request)[0]!.results![0]!.savedOutputPath!;
        if (failure === "missing") rmSync(saved);
        else writeFileSync(saved, "not JSON");
      }
      return child(key);
    });
    expect(await host.execute()).toMatchObject({ status: "failed" });
    expect(host.calls.at(-1)?.key).toBe("director-after-r1");
  });

  test("new and resumed/compacted participants recover all essentials without replacing original producer run IDs", async () => {
    const storage = new Map<string, unknown>();
    const first = await fixture().execute(undefined, storage);
    const before = structuredClone((storage.get("architecture-decision") as { originals: Original[] }).originals);
    const host = fixture((key, request) => {
      if (key === "director-prepare") {
        expect(request.resume).toBe("native-director-after-r1");
        const old = essentials(request);
        expect(old.map(item => item.id)).toEqual(["decision.v1.r1-simple.a1", "decision.v1.r1-recover.a1"]);
        for (const item of old) expect(originalValue(item).report).toBe(`Private report from ${item.id.split(".")[2]}`);
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
    // Consumers got verified references; retained originals keep their producer run IDs.
    const retainedOriginals = (storage.get("architecture-decision") as { originals: Original[] }).originals;
    for (const key of ["r1-simple", "r1-recover"]) expect(retainedOriginals.find(item => item.key === key)?.runId).toBe(`native-${key}`);
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
        if (delivery === "unknown") delete (result.structuredOutput as Record<string, unknown>).report;
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


test("architecture accepts a published peer challenge without model access receipts", async () => {
  const late = deferred<Result>();
  const host = fixture(key => key === "r2-recover" ? late.promise : child(key, key === "director-after-r1" ? discuss : finish), key => {
    late.resolve(child(key));
    return { state: "delivered" };
  });
  expect(await host.execute()).toMatchObject({ status: "completed", rounds: 2, validRounds: 2 });
  expect(host.steered[0]!.message).toContain("read tools");
  expect(host.steered[0]!.message).not.toContain("access receipt");
});


test.each(["context", "inline"])("architecture does not treat %s as publication on reentry", async source => {
  const first = fixture();
  const result = await first.execute();
  const prior = first.storage.get("architecture-decision") as { originals: Original[] };
  const original = prior.originals.find(item => item.key === "r1-simple")!;
  original.publication = "unpublished";
  original.accessibility = source;
  original.failedOriginal = originalValue(original);
  original.results = [];
  const host = fixture();
  expect(await host.execute({ continuation: result.continuation }, first.storage)).toMatchObject({
    status: "failed", error: expect.stringContaining("Essential original is not published"),
  });
  expect(host.calls).toHaveLength(0);
});


test("architecture preserves evidence from dynamically named perspectives even when their IDs resemble the director", async () => {
  const host = fixture((key, request) => {
    if (key === "director-prepare") return { ...child(key), structuredOutput: { ...discuss,
      perspectives: [perspectives[0], { id: "director-dissent", label: "Contrary whole-problem view", focus: "Challenge the recommendation" }],
    } };
    if (key === "director-after-r1") {
      expect(essentials(request).map(item => item.id)).toEqual(["decision.v1.r1-simple.a1", "decision.v1.r1-director-dissent.a1"]);
      expect(originalValue(essentials(request)[1]!).report).toBe("Private report from r1-director-dissent");
    }
    return child(key);
  });
  expect(await host.execute()).toMatchObject({ status: "completed" });
});

describe("architecture durable dispatch boundaries", () => {
  const initial = { currentDecision: snapshot("Keep the complete current decision"), planning: true };
  function planningChild(key: string) {
    if (key === "director-doubts-r1") return { ...child(key), structuredOutput: { doubts: [
      { id: "fact", kind: "scout", dependsOn: [], question: "Which local contract applies?", decision: "Reuse" },
      { id: "human", kind: "deliberation", dependsOn: [], question: "Prefer reuse?", decision: "Scope" },
    ] } };
    return child(key);
  }
  test.each(["director-prepare", "r1-simple", "r1-recover", "director-doubts-r1", "doubts-r1-0", "director-after-r1"])
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

  test.each(["director-prepare", "r1-simple", "director-doubts-r1", "doubts-r1-0", "director-after-r1"])
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
    for (const cursor of [undefined, { version: 1, dispatches: [] }, { version: 99, dispatches: [] }]) {
      const storage = new Map(first.storage);
      const prior = storage.get("architecture-decision") as object;
      storage.set("architecture-decision", { ...prior, cursor });
      const resumed = fixture();
      await expect(resumed.execute({ continuation: result.continuation }, storage)).rejects.toThrow("created by an incompatible Pitako contract");
      expect(resumed.calls).toHaveLength(0);
    }
  });

  test.each([1, 2, 99])("rejects incompatible state and continuation v%i before writes or dispatch", async version => {
    const first = fixture(); const result = await first.execute();
    for (const target of ["state", "continuation"]) {
      const storage = new Map(structuredClone([...first.storage]));
      const continuation = { ...result.continuation! };
      if (target === "state") (storage.get("architecture-decision") as { version: number }).version = version;
      else continuation.version = version;
      const resumed = fixture();
      await expect(resumed.execute({ continuation }, storage)).rejects.toThrow(
        `created by an incompatible Pitako contract v${version}; start a new consultation/mission`);
      expect(resumed.calls).toHaveLength(0);
      expect(resumed.stateWrites).toHaveLength(0);
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
    const publicationFailure = "Unsaved factual evidence: " + "mandatory publication unavailable; ".repeat(100);
    let settled = false, failures = 0, writesAtFailure = 0;
    const host = fixture(key => {
      if (key === "doubts-r1-0") { started.resolve(); return sibling.promise.then(value => { settled = true; return value; }); }
      if (key === "doubts-r1-1") return { ...child(key), ok: false, error: "Permission denied; Stop observed", outputSaveError: publicationFailure, structuredOutput: { status: "blocked", report: "Actual human frontier remains unanswered" } };
      if (key === "director-doubts-r1") return { ...child(key), structuredOutput: { doubts: [
        { id: "first", kind: "scout", dependsOn: [], question: "First?", decision: "Design" },
        { id: "second", kind: "researcher", dependsOn: [], question: "Second?", decision: "Design" },
      ] } };
      return planningChild(key);
    }, undefined, value => {
      if (value.cursor.dispatches.some(item => item.key === "doubts-r1-1" && item.boundary === "confirmed")) {
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
  const continuation = { version: 3, consultation: "decision" };
  const decisionInput = { currentDecision: snapshot("Keep the whole decision"), planning: true, maxRounds: 2 };
  function planningResult(key: string) {
    return key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts: [
      { id: "fact", kind: "scout", dependsOn: [], question: "Local evidence?", decision: "Reuse" },
      { id: "human", kind: "deliberation", dependsOn: [], question: "Prefer reuse?", decision: "Scope" },
    ] } } : child(key);
  }
  test.each(["admission", "director-prepare", "perspective-terminal", "round-index", "validity", "director-doubts-r1", "doubts-r1-0", "director-after-r1"])
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
        if (matches) {
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
      expect(serialized).toContain("Private report from");
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
  const continuation = { version: 3, consultation: "decision" };
  function reply(key: string): Result {
    if (key.startsWith("director-doubts-")) return { ...child(key), structuredOutput: { doubts: [
      { id: "retained", kind: "scout", dependsOn: [], question: "Sufficient local fact?", decision: "Reuse" },
      { id: "missing", kind: "researcher", dependsOn: [], question: "Missing external fact?", decision: "Reuse" },
      { id: "scope", kind: "deliberation", dependsOn: [], question: "Prefer reuse?", decision: "Scope" },
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
  test("retries only the authorized terminal factual provider, retains sufficient facts, then evaluates without a new round", async () => {
    const { first, original, retry } = await failed();
    const second = fixture((key, request) => {
      expect(key).not.toBe("director-prepare"); expect(key).not.toStartWith("r2-");
      if (key === "doubts-r1-1") expect(request.output).toContain("a2.json");

      return child(key);
    });
    expect(await second.execute({ planning: true, continuation, factualRetry: retry }, first.storage))
      .toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
    expect(second.calls.map(item => item.key)).toEqual(["doubts-r1-1", "director-after-r1"]);
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
    expect(second.calls.map(call => call.key)).toEqual(["doubts-r1-1", "director-after-r1"]);
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
      delete (result.structuredOutput as Record<string, unknown>).report;
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
    test.each(["authorization", "intention", "terminal", "evaluation"])
      (`retry with missing=${missing} survives committed %s cuts without replay`, async boundary => {
        const { first, retry } = await failed(missing);
        let cut = false;
        const second = fixture(key => child(key), undefined, undefined, value => {
          const cursor = value.cursor as unknown as { retries?: unknown[]; dispatches: { key: string; boundary: string; attempt: number }[] };
          const factual = cursor.dispatches.find(item => item.key === "doubts-r1-1" && item.attempt === 2);
          const matches = boundary === "authorization" ? cursor.retries?.length === 1 && !factual
            : boundary === "intention" ? factual?.boundary === "intended"
            : boundary === "terminal" ? factual?.boundary === "confirmed"
            : cursor.dispatches.some(item => item.key === "director-after-r1" && item.boundary === "confirmed");
          if (!cut && matches) { cut = true; throw new Error("Committed retry cut " + boundary); }
        });
        try { await second.execute({ planning: true, continuation, factualRetry: retry }, first.storage); }
        catch (error) { expect(String(error)).toContain("Committed retry cut"); }
        expect(cut).toBe(true);
        const third = fixture();
        if (boundary === "intention") {
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
  test.each(["director-prepare", "r1-simple", "director-doubts-r1", "doubts-r1-0", "director-after-r1"])
    ("never redispatches after an interruption following the committed %s intention", async key => {
      let interrupted = false;
      const first = fixture(producer => producer.startsWith("director-doubts-") ? { ...child(producer), structuredOutput: { doubts: [
        { id: "fact", kind: "scout", dependsOn: [], question: "Local contract?", decision: "Reuse" },
        { id: "human", kind: "deliberation", dependsOn: [], question: "Prefer reuse?", decision: "Scope" },
      ] } } : child(producer), undefined, undefined, value => {
        if (!interrupted && value.cursor.dispatches.some(item => item.key === key && item.boundary === "intended")) {
          interrupted = true; throw new Error("Interrupted after durable intention " + key);
        }
      });
      await first.execute({ planning: true, currentDecision: snapshot("Complete problem") });
      expect(interrupted).toBe(true);
      expect(first.calls.some(call => call.key === key)).toBe(false);
      const second = fixture();
      await expect(second.execute({ planning: true, continuation: { version: 3, consultation: "decision" } }, first.storage))
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
  test.each([true, false])("uses publication rather than receipts for delivered steering after a terminal cut (published=%s)", async published => {
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
    if (!published) {
      const retained = first.storage.get("architecture-decision") as { originals: Original[] };
      retained.originals.find(item => item.key === "r2-simple")!.outputSaveError = "Publication no longer valid";
    }
    const resumed = fixture();
    const outcome = await resumed.execute({ continuation: result.continuation }, first.storage);
    if (published) {
      expect(outcome).toMatchObject({ status: "completed", rounds: 2, validRounds: 2 });
      expect(resumed.calls.map(call => call.key)).toEqual(["director-after-r2"]);
    } else {
      expect(outcome).toMatchObject({ status: "failed", rounds: 2, validRounds: 1, error: expect.stringContaining("Essential original is not published") });
      expect(resumed.calls).toHaveLength(0);
    }
    expect(resumed.steered).toHaveLength(0);
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

describe("architecture paused human answers", () => {
  const continuation = { version: 3, consultation: "decision" };
  const reentry = { planning: true, continuation };
  const questions = [
    { id: "unrelated", kind: "researcher", dependsOn: [], question: "External contract?", decision: "Adapter" },
    { id: "needed", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
    { id: "scope", kind: "human", dependsOn: [], question: "Use scope A?", decision: "Scope", recommendation: "Use scope A" },
    { id: "reuse", kind: "human", dependsOn: ["needed"], question: "Reuse seam?", decision: "Reuse", recommendation: "Reuse seam" },
  ];
  function respond(key: string): Result {
    return key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts: questions } } : child(key);
  }
  async function pause() {
    const first = fixture(respond);
    const result = await first.execute({ planning: true, currentDecision: snapshot("Decision") });
    expect(result).toMatchObject({ status: "needs-human", rounds: 1, validRounds: 1 });
    return { first, result };
  }
  function answers(result: Outcome) {
    const { consultation, revision, round, questions } = result.frontier!;
    return { consultation, revision, round, answers: questions.map(({ id }) => ({
      id, disposition: "answer", content: "approve implementation", provenance: `Actual human message 55, ${id}`,
    })) };
  }
  test("awaits one complete factual wave before pausing the entire human frontier", async () => {
    const research = deferred<Result>(), entered = deferred<void>();
    const first = fixture(key => {
      if (key === "doubts-r1-0") { entered.resolve(); return research.promise; }
      return respond(key);
    });
    let settled = false;
    const work = first.execute({ planning: true, currentDecision: snapshot("Decision") }).then(value => { settled = true; return value; });
    let result: Outcome;
    try {
      await entered.promise;
      expect(settled).toBe(false);
      expect(first.batches.find(batch => batch.some(request => request.key === "doubts-r1-0"))?.map(request => request.key))
        .toEqual(["doubts-r1-0", "doubts-r1-1"]);
      expect(first.calls.some(call => call.key === "director-after-r1")).toBe(false);
    } finally { research.resolve(child("doubts-r1-0")); result = await work; }
    expect(result!).toMatchObject({ status: "needs-human", rounds: 1, validRounds: 1, continuation,
      frontier: { consultation: "decision", revision: 1, round: 1, humanContext: expect.stringContaining("Material facts"), questions: [
        { ...questions[2], prerequisiteFacts: [] },
        { ...questions[3], prerequisiteFacts: [{ id: "needed", key: "doubts-r1-1", originalId: expect.any(String), humanContext: expect.stringContaining("Brief factual frontier") }] },
      ].map(({ kind: _kind, ...item }) => item) } });
    const retained = first.storage.get("architecture-decision") as DurableConsultation;
    expect(retained.cursor).toMatchObject({ control: { stage: "awaiting-human", pending: { round: 1, revision: 1, ids: ["scope", "reuse"] } } });
    expect(retained.cursor.dispatches.every(item => item.boundary === "confirmed")).toBe(true);
    expect(first.calls.map(call => call.request.phase)).not.toContain("architecture-human");
    expect(first.calls.some(call => call.key === "director-after-r1")).toBe(false);
  });
  test("restart after both native deadlines returns identical frontier without writes, then evaluates actual answers once", async () => {
    const { first, result } = await pause();
    const before = JSON.stringify([...first.storage]), persisted = readFileSync(first.stateFile, "utf8");
    // Pass a controlled clock as an AsyncFunction global; do not mutate the host clock.
    const late = Date.now() + 60 * 60 * 1000;
    const clock = class extends Date { static now() { return late; } };
    const restarted = fixture(undefined, undefined, undefined, undefined, clock);
    expect(await restarted.execute(reentry, first.storage)).toEqual(result);
    expect(JSON.stringify([...first.storage])).toBe(before);
    expect(restarted.calls).toHaveLength(0); expect(restarted.stateWrites).toHaveLength(0);
    expect(readFileSync(first.stateFile, "utf8")).toBe(persisted);
    let firstWrite: DurableConsultation | undefined;
    const input = answers(result);
    input.answers[1]!.disposition = "defer";
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-after-r1");
      for (const phrase of ["actual-human decision context", "never", "implementation authority or final confirmation", "defer and unknown remain unresolved", "approve implementation", "Actual human message 55"])
        expect(request.task).toContain(phrase);
      return child(key);
    }, undefined, value => {
      firstWrite ??= structuredClone(value);
    }, undefined, clock);
    const done = await resumed.execute({ ...reentry, humanAnswers: input }, first.storage);
    expect(firstWrite).toMatchObject({ cursor: { control: { stage: "evaluate" } }, evidence: expect.arrayContaining([
      expect.objectContaining({ key: "human-answers-r1", answers: input.answers }),
    ]) });
    expect(firstWrite!.cursor).not.toHaveProperty("control.pending");
    expect(done).toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
    expect(done).not.toHaveProperty("authorization"); expect(done).not.toHaveProperty("confirmation");
    expect(resumed.calls.map(call => call.key)).toEqual(["director-after-r1"]);
    const duplicate = fixture(), saved = JSON.stringify([...first.storage]);
    await expect(duplicate.execute({ ...reentry, humanAnswers: input }, first.storage)).rejects.toThrow("Invalid humanAnswers");
    expect(JSON.stringify([...first.storage])).toBe(saved);
    expect(duplicate.stateWrites).toHaveLength(0); expect(duplicate.calls).toHaveLength(0);
  });
  test.each(["missing", "extra", "duplicate", "round", "revision", "consultation", "no-pending", "missing-pending", "not-planning", "replacement", "evidence", "factualRetry", "content", "provenance", "disposition", "bytes", "items", "fields", "depth", "state-capacity"])
    ("rejects %s with byte-identical storage and no dispatch", async fault => {
      const { first, result } = await pause();
      const input = answers(result);
      const args: Record<string, unknown> = { ...reentry, humanAnswers: input };
      if (fault === "missing") input.answers.pop();
      if (fault === "extra") input.answers.push({ ...input.answers[0]!, id: "extra" });
      if (fault === "duplicate") input.answers[1]!.id = input.answers[0]!.id;
      if (fault === "round") input.round++;
      if (fault === "revision") input.revision++;
      if (fault === "consultation") input.consultation = "other";
      if (fault === "not-planning") args.planning = false;
      if (fault === "missing-pending") {
        const value = first.storage.get("architecture-decision") as { cursor: { control: { pending?: unknown } } };
        delete value.cursor.control.pending;
      }
      if (fault === "no-pending") {
        const value = first.storage.get("architecture-decision") as { cursor: { control: { stage: string; pending?: unknown } } };
        value.cursor.control.stage = "evaluate"; delete value.cursor.control.pending;
      }
      if (fault === "replacement") args.replacement = replacement("decision", 1, snapshot("Changed"));
      if (fault === "evidence" || fault === "factualRetry") { delete args.humanAnswers; args[fault] = fault === "evidence" ? "Caller fact" : {}; }
      if (fault === "content" || fault === "provenance") input.answers[0]![fault] = "";
      if (fault === "disposition") input.answers[0]!.disposition = "approve";
      if (fault === "bytes") input.answers[0]!.content = "é".repeat(9000);
      if (fault === "items") input.answers = Array.from({ length: 65 }, (_, index) => ({ ...input.answers[0]!, id: `q${index}` }));
      if (fault === "fields") Object.assign(input.answers[0]!, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`field${i}`, "x"])));
      if (fault === "depth") Object.assign(input.answers[0]!, { nested: { a: { b: { c: { d: { e: { f: { g: "deep" } } } } } } } });
      if (fault === "state-capacity") first.storage.set("unrelated", "x".repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(Object.fromEntries(first.storage))) - 100));
      const before = JSON.stringify([...first.storage]), persisted = readFileSync(first.stateFile, "utf8");
      const resumed = fixture();
      await expect(resumed.execute(args, first.storage)).rejects.toThrow();
      expect(JSON.stringify([...first.storage])).toBe(before);
      expect(readFileSync(first.stateFile, "utf8")).toBe(persisted);
      expect(resumed.calls).toHaveLength(0);
      expect(resumed.stateWrites.filter(write => write.persisted)).toHaveLength(0);
      if (fault === "state-capacity") expect(resumed.stateWrites).toEqual([{ bytes: expect.any(Number), persisted: false }]);
      else expect(resumed.stateWrites).toHaveLength(0);
    });
  test.each(["defer", "unknown"])("accepts %s without content as unresolved decision context", async disposition => {
    const { first, result } = await pause();
    const input = answers(result);
    const humanAnswers = { ...input, answers: input.answers.map(({ content: _content, ...answer }) => ({ ...answer, disposition })) };
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-after-r1");
      expect(request.task).toContain(`"disposition":"${disposition}"`);
      expect(request.task).toContain("defer and unknown remain unresolved questions");
      return { ...child(key), structuredOutput: { ...finish, action: "blocked", memo: "Human question remains unresolved" } };
    });
    expect(await resumed.execute({ ...reentry, humanAnswers }, first.storage)).toMatchObject({ status: "blocked", rounds: 1, validRounds: 1 });
    expect(first.storage.get("architecture-decision")).toMatchObject({ evidence: expect.arrayContaining([
      expect.objectContaining({ key: "human-answers-r1", answers: humanAnswers.answers }),
    ]) });
  });
  test("replacement discards pending at prepare with counters and human snapshot provenance preserved", async () => {
    const { first } = await pause();
    const prior = { id: "earlier", content: "Use A", provenance: "Actual human message 54" };
    const retained = first.storage.get("architecture-decision") as { currentDecision: { snapshot: DecisionSnapshot } };
    retained.currentDecision.snapshot.humanDecisions = [prior];
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-prepare"); expect(request.task).toContain(prior.provenance);
      return { ...child(key), structuredOutput: { ...finish, action: "blocked" } };
    }, undefined, value => {
      if (resumed.stateWrites.length !== 1) return;
      expect(value).toMatchObject({ rounds: 1, validRounds: 1, cursor: { control: { stage: "prepare", round: null } } });
      expect(value.cursor).not.toHaveProperty("control.pending");
    });
    expect(await resumed.execute({ ...reentry, replacement: replacement("decision", 1, snapshot("Changed scope", { humanDecisions: [prior] })) }, first.storage))
      .toMatchObject({ status: "blocked", rounds: 1, validRounds: 1 });
    expect(JSON.stringify([...first.storage])).not.toContain("human-answers-r1");
  });
  test.each(["finish", "blocked"])("a round-ten pause accepts answers then returns only %s", async action => {
    const first = fixture(key => key === "director-doubts-r10" ? respond(key)
      : key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: { doubts: [] } } : child(key, discuss));
    const result = await first.execute({ planning: true, currentDecision: snapshot("Decision"), maxRounds: 10 });
    expect(result).toMatchObject({ status: "needs-human", rounds: 10, validRounds: 10 });
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-after-r10"); expect(request.task).toContain("round limit is reached");
      return { ...child(key), structuredOutput: { ...finish, action } };
    });
    expect(await resumed.execute({ ...reentry, humanAnswers: answers(result) }, first.storage))
      .toMatchObject({ status: action === "finish" ? "completed" : "blocked", rounds: 10, validRounds: 10 });
    expect(resumed.calls).toHaveLength(1);
  });
  test("failed prerequisite stays frontier, then authorized factualRetry pauses without another round", async () => {
    const first = fixture(key => key === "doubts-r1-1" ? { ...child(key), structuredOutput: { status: "blocked", report: "Missing prerequisite" } } : respond(key));
    const failed = await first.execute({ planning: true, currentDecision: snapshot("Decision") });
    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("No adequate report"), rounds: 1, validRounds: 1 });
    const retained = first.storage.get("architecture-decision") as { cursor: { control: { stage: string } }; originals: Original[] };
    expect(retained.cursor.control.stage).toBe("frontier");
    const resumed = fixture();
    expect(await resumed.execute({ ...reentry, factualRetry: { consultation: "decision", revision: 1,
      originalIds: [retained.originals.find(item => item.key === "doubts-r1-1")!.id],
      authorization: { content: "Retry prerequisite", provenance: "Actual human message 56" } } }, first.storage))
      .toMatchObject({ status: "needs-human", rounds: 1, validRounds: 1 });
    expect(resumed.calls.map(call => call.key)).toEqual(["doubts-r1-1"]);
  });
  test("more than 64 pending IDs fails explicitly instead of truncating", async () => {
    const first = fixture(key => key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: {
      doubts: Array.from({ length: 65 }, (_, index) => ({ ...questions[2], id: `q${index}` })),
    } } : child(key));
    expect(await first.execute({ planning: true, currentDecision: snapshot("Decision") }))
      .toMatchObject({ status: "failed", error: expect.stringContaining("64 pending IDs") });
    expect(first.calls.some(call => call.key === "director-after-r1")).toBe(false);
    expect(first.storage.get("architecture-decision")).toMatchObject({ cursor: { control: { stage: "frontier" } } });
  });
});

describe("architecture deterministic access receipts", () => {
  test("a raw script path refuses to run before any state or dispatch", async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let touched = false;
    await expect(new AsyncFunction("args", "runs", "state", rawSource)({ consultation: "decision", workDescription: "x" },
      { all: () => { touched = true; } }, { get: () => { touched = true; } })).rejects.toThrow("Launch pitako.architecture by name after mission.create");
    expect(touched).toBe(false);
  });

  test("one verifier per consuming gate over its required originals; none when nothing is required", async () => {
    const host = fixture();
    expect(await host.execute()).toMatchObject({ status: "completed" });
    // director-prepare and round-1 perspectives have no essentials; the evaluation consumes both reports.
    expect(host.verifications.map(entry => entry.key)).toEqual(["verify-v1-director-after-r1-a1"]);
    const request = JSON.parse(host.verifications[0]!.request.task);
    expect(request).toMatchObject({ namespace: "architecture-test", gate: "v1-director-after-r1-a1" });
    expect(request.items.map((item: { id: string }) => item.id)).toEqual(["decision.v1.r1-simple.a1", "decision.v1.r1-recover.a1"]);
    const consumer = host.calls.find(call => call.key === "director-after-r1")!.request;
    expect(essentials(consumer).map(item => (item as unknown as { id: string }).id)).toEqual(request.items.map((item: { id: string }) => item.id));
  });

  test("a contradictory published original blocks the consumer before dispatch with an explanation", async () => {
    // Rewrite the published file after its admission is saved, before the evaluation gate verifies it.
    const watched = fixture(undefined, undefined, undefined, value => {
      const recover = (value as unknown as { originals?: Original[] }).originals?.find(item => item.key === "r1-recover");
      const saved = recover?.results?.find(item => item.savedOutputPath)?.savedOutputPath;
      if (saved && value.cursor.dispatches.some(item => item.key === "r1-recover" && item.boundary === "confirmed"))
        writeFileSync(saved, JSON.stringify({ status: "ready", report: "Edited after admission" }));
    });
    const outcome = await watched.execute();
    expect(outcome.status).toBe("failed");
    for (const part of ["Access gate v1-director-after-r1-a1 blocked before dispatch", "is contradictory: content-differs", "/report", "does not choose a version"])
      expect(outcome.error).toContain(part);
    expect(watched.calls.map(call => call.key)).not.toContain("director-after-r1");
  });
});
