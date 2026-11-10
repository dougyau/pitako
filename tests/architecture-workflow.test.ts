import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, statSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWorkflowScript, validateWorkflowScript, type WorkflowScriptChildResult } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { normalizeWorkflowArgs } from "../node_modules/pi-subagents/src/workflows/workflow-resources.js";
import type { WorkflowTerminalOutcome } from "../node_modules/pi-subagents/src/shared/types.js";
const { appendLedger, ledgerPath, verifyLedger } = await import(new URL("../skills/architecture/ledger.mjs", import.meta.url).href);
import { canonicalJSON, canonicalDigest } from "../extensions/canonical.mjs";
import { verifyGate } from "../extensions/access-receipts.mjs";

const rawSource = readFileSync(new URL("../skills/workflow-canonical.js", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../skills/architecture/workflow.js", import.meta.url), "utf8");
const compactFunctions = rawSource.slice(rawSource.indexOf("function compactConsultation("), rawSource.indexOf("function retainedConsultation("));
const nativeFlagsSource = rawSource.slice(rawSource.indexOf("const nativeFlags ="), rawSource.indexOf("const retained ="));
const {compactConsultation, expandConsultation} = new Function("function utf8Bytes(s) {return unescape(encodeURIComponent(s)).length;}" + nativeFlagsSource + compactFunctions + ";return {compactConsultation, expandConsultation};")();
// Callbacks/storage expose logical controls for fault injection; state files and
// the VM boundary always use the actual compact persistence representation.
const physical = (value: any) => value?.version === 4 && !value.originals?.some(Array.isArray) && value.cursor?.dispatches?.every((d: any) => !d.a) ? compactConsultation(value) : value;
const logical = (value: any) => value?.version === 4 && (value.originals?.some(Array.isArray) || value.cursor?.dispatches?.some((d: any) => d.a)) ? expandConsultation(value) : value;


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
  delivery: string; publication: string; sufficient: boolean; accessibility?: string; diagnostic?: string; artifactRoot?: string; relativePath?: string; savedOutputPath?: string; failedOriginal?: Record<string, unknown>;
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
function verifierResult(key: string, request: Request): Result & { output: string } {
  return { ok: true, agent: "pitako.access-verifier", runId: `native-${key}`, output: JSON.stringify(verifyGate(JSON.parse(request.task))),
    results: [{ exitCode: 0 }] };
}
function originalValue(original: Original): Record<string, unknown> {
  if (original.failedOriginal) return original.failedOriginal;
  const saved = (original.relativePath ? path.join(original.artifactRoot ?? originalsRoot, original.relativePath) : undefined) ?? original.savedOutputPath ?? original.results?.find(child => child.savedOutputPath)?.savedOutputPath;
  if (!saved) throw new Error(`No publication for ${original.id}. ${original.diagnostic ?? "Original not delivered."}`);
  const value = JSON.parse(readFileSync(saved, "utf8"));
  expect(value).not.toHaveProperty("association");
  expect(value).not.toHaveProperty("delivery");
  expect(value).not.toHaveProperty("access");
  if (!original.id.startsWith("context-") && original.producer !== undefined && original.producer !== "director-doubts" && !original.key.startsWith("director-")) {
    expect(["ready", "blocked"]).toContain(value.status);
    expect(typeof value.report).toBe("string");
  }
  return value;
}
function evidenceText(request: Request) {
  return request.task + essentials(request).map(item => JSON.stringify(originalValue(item))).join("\n");
}
function published(result: Result, request: Request, root = originalsRoot): Result {
  if (request.agent === "pitako.architecture-ledger") return result;
  if (result.raw) { const { raw, ...value } = result; return value; }
  if (result.structuredOutput === undefined) return result;
  for (const original of essentials(request)) originalValue(original);
  const value = { ...(result.structuredOutput as object) };
  if (request.phase === "architecture-factual") Object.assign(value, { humanContext: `Brief factual frontier from ${request.key}: material facts, reasons, contrary claims, limits and sources.`, ...(result.structuredOutput as object) });
  if (request.phase === "architecture-doubts") Object.assign(value, { humanContext: "Material facts, rationale, contrary evidence and limits for the actual human frontier.", ...(result.structuredOutput as object) });
  const savedOutputPath = path.join(root, root !== originalsRoot && typeof request.output === "string" ? request.output : `${++publicationSequence}.json`);
  mkdirSync(path.dirname(savedOutputPath), {recursive: true});
  const serialized = JSON.stringify(value, null, 2);
  writeFileSync(savedOutputPath, serialized);
  return { ...result, structuredOutput: value, outputReference: savedOutputPath,
    results: [{ savedOutputPath, outputReference: { path: savedOutputPath, bytes: Buffer.byteLength(serialized, "utf8"),
      lines: serialized.split("\n").length, message: "Read this exact original if needed" }, exitCode: result.ok ? 0 : 1 }] };
}
// Controlled launch boundary using the real model-free ledger, including its gap rule.
const fixtureLedger = appendLedger;
type NativeInput = Parameters<typeof runWorkflowScript>[0];
function nativeScript(input: Omit<NativeInput, "launch"> & {
  launch: (...args: Parameters<NativeInput["launch"]>) => Promise<Omit<WorkflowScriptChildResult, "results"> & { results?: Record<string, unknown>[] }>;
}) {
  return runWorkflowScript({ ...input, launch: async (key, request, signal, admission) => {
    const result = request.agent === "pitako.architecture-ledger" ? {
      ok: true, runId: `native-${key}`, artifactPaths: [], terminalOutcome: undefined, agent: String(request.agent), output: JSON.stringify(fixtureLedger(JSON.parse(String(request.task)))),
    } : await input.launch(key, request, signal, admission);
    const projected = published(result, request as unknown as Request);
    return { ...result, ...projected, key, terminalOutcome: result.terminalOutcome, results: projected.results?.map((row, index) => ({
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
  frontier?: { consultation: string; revision: number; round: number; original: {path: string; digest: string}; questions: { id: string; kind: string; dependsOn: string[]; prerequisiteFacts: { id: string; original: {path: string; digest: string} }[] }[] };
  memo?: {path: string; digest: string};
  excerpt?: string;
  error?: string;
  rounds: number;
  validRounds: number;
  steering: { round: number; key: string; state: string }[];
  continuation: Continuation | null;
}
function readFrontier(outcome: Outcome) {
  const frontier = outcome.frontier!;
  const readVerified = (ref: {path: string; digest: string}) => {
    const value = JSON.parse(readFileSync(ref.path, "utf8"));
    expect(canonicalDigest(value)).toBe(ref.digest);
    return value;
  };
  const original = readVerified(frontier.original);
  return {...outcome, frontier: {...frontier, humanContext: original.humanContext,
    questions: frontier.questions.map(item => ({...original.doubts.find((doubt: {id: string}) => doubt.id === item.id), ...item,
      prerequisiteFacts: item.prerequisiteFacts.map(fact => ({...fact, humanContext: readVerified(fact.original).humanContext}))}))}};
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
const fixtureMissions = new WeakMap<Map<string, unknown>, string>();
function fixture(
  respond: (key: string, request: Request) => Result | Promise<Result> = key => child(key),
  steer: (key: string) => { state: string } | Promise<{ state: string }> = () => ({ state: "missed" }),
  beforeWrite: (value: DurableConsultation) => void = () => {},
  afterWrite: (value: DurableConsultation) => void = () => {},
  clock: Pick<typeof Date, "now"> = Date,
  invocationRoots = false,
) {
  let invocationRoot = originalsRoot;
  const calls: { key: string; request: Request }[] = [];
  const batches: Request[][] = [];
  const steered: { key: string; message: string; options: unknown }[] = [];
  const launches = new Map<string, {fingerprint: string; result: Promise<Result>}>();
  const verifications: { key: string; request: Request }[] = [];
  function launch(key: string, request: Request): Promise<Result> {
    const fingerprint = canonicalJSON(request);
    const prior = launches.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error(`Duplicate workflow key '${key}' used with incompatible launch params.`);
      return prior.result;
    }
    const result = Promise.resolve().then(() => {
      if (request.agent === "pitako.architecture-ledger") return {ok: true,
        runId: `native-${key}`, agent: request.agent, output: JSON.stringify(fixtureLedger(JSON.parse(request.task)))};
      if (request.agent === "pitako.access-verifier") {
        verifications.push({key, request});
        return verifierResult(key, request);
      }
      calls.push({key, request});
      return Promise.resolve().then(() => respond(key, request)).then(result => published(result, request, invocationRoot)).catch(error => ({ok: false, error: String(error)}));
    });
    launches.set(key, {fingerprint, result});
    return result;
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
      if (requests.every(request => !["pitako.access-verifier", "pitako.architecture-ledger"].includes(request.agent ?? ""))) batches.push(requests);
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

  const execute = async (args: unknown = { currentDecision: snapshot("Choose a complete persistence design") }, storage: Map<string, unknown> = privateState) => {
    launches.clear();
    if (invocationRoots) { invocationRoot = path.join(originalsRoot, `artifacts-${++publicationSequence}`, "outputs", `run-${publicationSequence}`); mkdirSync(invocationRoot, {recursive: true}); }
    let missionPath = fixtureMissions.get(storage);
    if (!missionPath) { missionPath = path.join(originalsRoot, `fixture-${++publicationSequence}.json`); fixtureMissions.set(storage, missionPath); writeFileSync(missionPath, "{}"); }
    const missionState = path.join(missionPath.slice(0, -5), "state.json");
    mkdirSync(path.dirname(missionState), { recursive: true });
    writeFileSync(missionState, JSON.stringify(Object.fromEntries([...storage].map(([k,v]) => [k,physical(v)])), null, 2));
    const fixtureSource = `const pitakoAccess = ${JSON.stringify({ missionPath, namespace: `architecture-${(args as { consultation?: string })?.consultation ?? "decision"}` })};\n${rawSource}`;
    const normalized = normalizeWorkflowArgs(JSON.parse(JSON.stringify(args)));
    if ("error" in normalized && (args as Record<string, unknown>).humanAnswers !== undefined) throw new Error(normalized.error);
    return new AsyncFunction("args", "runs", "state", "Date", fixtureSource)({ consultation: "decision", workDescription: "Choose persistence architecture", ...(args as object) }, runs, storage && {
      get: async (key: string) => physical(structuredClone(storage.get(key))),
      set: async (key: string, value: unknown) => {
        const merged = { mission: "owned-test-mission", state: { ...Object.fromEntries([...storage].map(([k,v]) => [k,physical(v)])), [key]: value } };
        const serialized = JSON.stringify(merged, null, 2);
        const write = { bytes: Buffer.byteLength(serialized, "utf8"), persisted: false };
        stateWrites.push(write);
        expect(physical(logical(value))).toEqual(value);
        beforeWrite(logical(value) as DurableConsultation);
        if (write.bytes > 256 * 1024) throw new Error("Native whole mission capacity exceeded (256 KiB)");
        writeFileSync(stateFile, serialized);
        writeFileSync(missionState, serialized);
        storage.set(key, logical(structuredClone(value)));
        write.persisted = true;
        afterWrite(logical(value) as DurableConsultation);
      },
    }, clock);
  };
  return { execute, calls, verifications, batches, steered, storage: privateState, stateWrites, stateFile };
}

interface LedgerRecord { kind: string; round: number; body: any }
function ledgerRecords(storage: Map<string, unknown>, consultation = "decision"): LedgerRecord[] {
  const retained = storage.get(`architecture-${consultation}`) as { ledger: { count: number; head: string } };
  return verifyLedger(fixtureMissions.get(storage)!, consultation, retained.ledger);
}
function history(storage: Map<string, unknown>, consultation = "decision"): { originals: Original[]; cursor: DurableConsultation["cursor"] } {
  const retained = storage.get(`architecture-${consultation}`) as Record<string, any>;
  const archived = ledgerRecords(storage, consultation).filter(record => record.kind === "round").map(record => logical(record.body));
  return { ...retained,
    originals: [...new Map([...retained.originals, ...archived.flatMap(body => body.originals)].sort((a, b) => Number(Boolean(a.key)) - Number(Boolean(b.key))).map(item => [item.id, {
      ...item, savedOutputPath: item.relativePath ? path.join(item.artifactRoot, item.relativePath) : item.savedOutputPath,
    }])).values()],
    cursor: { ...retained.cursor, dispatches: [...new Map([...archived.flatMap(body => body.cursor.dispatches), ...retained.cursor.dispatches].map(item => [item.originalId, item])).values()] },
  };
}
describe("architecture dynamic perspective roles", () => {
  const ids = ["scout", "researcher", "evidence-auditor", "preferences"];
  const roster = ids.map(id => ({ id, label: id + " perspective", focus: "Compare the whole decision" }));
  const decision = { ...discuss, perspectives: roster };
  const continuation = { version: 4, consultation: "decision" };

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
      : key === "doubts-r1-0" ? { ...child(key), ok: false, error: "Terminal factual failure", structuredOutput: { status: "blocked", report: "Insufficient fact" } }
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
    expect(JSON.parse(readFileSync(result.memo!.path, "utf8")).memo).toBe(finish.memo);
    expect(result.excerpt).toBe(finish.memo);
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

  test.each(["queued", "delivered", "missed", "failed"])(
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

  test("a planning pause after queued steering accepts human answers on reentry", async () => {
    const late = deferred<Result>();
    const scope = { id: "scope", kind: "human", dependsOn: [], question: "Use scope A?", decision: "Scope", recommendation: "Use scope A" };
    const first = fixture(
      async key => {
        if (key === "director-doubts-r1") return { ...child(key), structuredOutput: { doubts: [] } };
        if (key === "director-after-r1") return child(key, discuss);
        if (key === "director-doubts-r2") return { ...child(key), structuredOutput: { doubts: [scope] } };
        if (key === "r2-recover") return late.promise;
        return child(key);
      },
      key => {
        late.resolve(child(key));
        return { state: "queued" };
      },
    );
    const paused = await first.execute({ planning: true, currentDecision: snapshot("Decision") });
    expect(paused).toMatchObject({ status: "needs-human", rounds: 2, validRounds: 2 });
    expect(first.steered.map(item => item.key)).toEqual(["r2-recover"]);
    const { consultation, revision, round } = paused.frontier!;
    const resumed = fixture();
    const result = await resumed.execute({ planning: true, continuation: paused.continuation, humanAnswers: { consultation, revision, round,
      answers: [{ id: "scope", disposition: "answer", content: "Use scope A", provenance: "Actual human message" }] } }, first.storage);
    expect(result).toMatchObject({ status: "completed", rounds: 2, validRounds: 2 });
    expect(resumed.calls.map(call => call.key)).toEqual(["director-after-r2"]);
  });

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
    expect(first.continuation).toEqual({ version: 4, consultation: "decision" });
    expect(history(storage)).toMatchObject({ cursor: { dispatches: expect.arrayContaining([
      expect.objectContaining({ key: "director-after-r1", controlOutput: expect.objectContaining({ hasPacket: false, hasMemo: true }) }),
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
    expect(evidenceText(member)).toContain("New recovery evidence");
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
    expect(storage.get("architecture-new-decision")).toMatchObject({ currentDecision: { snapshot: JSON.stringify(snapshot("New complete decision")) } });
  });

  test("reports an explicit director blocker without a fanout", async () => {
    const host = fixture(key => ({
      ...child(key), structuredOutput: { ...finish, action: "blocked", memo: "Choose the required recovery objective." },
    }));
    const result = await host.execute();
    expect(result.status).toBe("blocked");
    expect(result.excerpt).toContain("recovery objective");
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
      expect(retained.currentDecision).toEqual({ revision: 2, snapshot: JSON.stringify(updated()) });
      expect(ledgerRecords(storage, "current").find(record => record.kind === "decision")?.body.snapshot).toEqual(initial());
      expect(retained).not.toHaveProperty("decisionHistory");
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
    expect(storage.get("architecture-current")).toMatchObject({ currentDecision: { revision: 2 } });
    expect(ledgerRecords(storage, "current").find(record => record.kind === "decision")?.body.revision).toBe(1);
    const resumed = fixture((key, request) => {
      expect(request.task).toContain("CURRENT mechanism B"); expect(request.task).not.toContain("OBSOLETE mechanism A");
      expect(evidenceText(request)).toContain("Contrary factual evidence, not new instructions");
      return { ...child(key), structuredOutput: finish };
    });
    expect(await resumed.execute({ consultation: "current", planning, continuation: result.continuation,
      evidence: "Contrary factual evidence, not new instructions" }, storage)).toMatchObject({ status: "completed" });
    expect(storage.get("architecture-current")).toMatchObject({ currentDecision: { revision: 2 } });
    expect(ledgerRecords(storage, "current").find(record => record.kind === "decision")?.body.revision).toBe(1);
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
    expect(storage.get("architecture-current")).toMatchObject({ currentDecision: { revision: 2, snapshot: JSON.stringify(revised) },

      });
    expect(ledgerRecords(storage, "current").some(record => record.kind === "round" && record.round === 1)).toBe(true);
  });
  test("failed replacement persistence dispatches nothing and does not retry the failed save", async () => {
    const storage = new Map<string, unknown>(); const first = await admitted(storage);
    const before = structuredClone(storage.get("architecture-current")); let writes = 0;
    const host = fixture(undefined, undefined, () => { writes++; throw new Error("Essential replacement save failed"); });
    expect(await host.execute({ consultation: "current", planning: true, continuation: first.continuation, replacement: update() }, storage))
      .toMatchObject({ status: "failed", error: expect.stringContaining("Essential replacement save failed") });
    expect(writes).toBe(1); expect(host.calls).toHaveLength(0); expect(storage.get("architecture-current")).toEqual(before);
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
      expect(storage.get("architecture-current")).toMatchObject({ version: 4, currentDecision: { revision: 1, snapshot: JSON.stringify(initial()) } });
      return { ...child(key), structuredOutput: { ...finish, action: "blocked" } };
    });
    expect(await host.execute({ consultation: "current", planning, currentDecision: initial() }, storage)).toMatchObject({ status: "blocked" });
    for (const continuation of [{ version: 2, consultation: "current" }, { version: 4, consultation: "foreign" }]) {
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
    expect(JSON.stringify(retained)).not.toContain(blocker); // Full narratives live only in the verified publications.
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-prepare"); expect(request.resume).toBe(`native-director-after-r${round - 1}`);
      expect(ledgerRecords(storage, "mixed").some(record => record.kind === "round" && record.body.comparison === "failed")).toBe(true);
      for (const evidence of [objection, blocker]) expect(evidenceText(request)).not.toContain(evidence);
      expect(request.task).toContain(`Consumed rounds: ${round}/10`);
      expect(essentials(request).some(item => item.id.includes(`r${round}-simple`))).toBe(false);
      expect(essentials(request).some(item => item.id.includes(`r${round}-recover`))).toBe(false);
      expect(request.task.includes("finish or blocked only")).toBe(round === 10);
      return { ok: true, runId: "native-reconciled", structuredOutput: { ...finish, action: "blocked", memo: blocker } };
    });
    expect(await resumed.execute({ evidence: "Reconcile mixed failed round", planning: true, consultation: "mixed", continuation: failed.continuation }, storage))
      .toMatchObject({ status: "blocked", rounds: round, validRounds: round - 1 });
    expect(resumed.calls).toHaveLength(1);
    expect(storage.get("architecture-mixed")).toMatchObject({ members: perspectives.map(({id, label}) => ({ id, label, runId: `native-r${round}-${id}` })) });
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
    expect(readFrontier(blocked).frontier.questions[0]?.question).toBe("Prefer scope A?");
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
    const previous = { ledger: { count: 0, head: null }, originals: [], version: 4, consultation: "cap", currentDecision: { revision: 1, snapshot: JSON.stringify(snapshot("Original decision")) }, decisionHistory: [], rounds: 10, validRounds: 10, maxRounds: 10, directorRunId: "native-doubts-r10", members: [], cursor: { version: 3, phase: "concluded", dispatches: [], control: { version: 1, planning: true, start: 0, stage: "prepare", next: null, round: null } }, evidence: [{ round: 10, question: "Prefer scope A?" }] };
    const storage = new Map<string, unknown>([["architecture-cap", previous]]);
    const host = fixture((key, request) => {
      expect(key).toBe("director-prepare"); expect(request.task).toContain("Actual human answered A");
      expect(request.task).toContain("finish or blocked only");
      return { ok: true, runId: "native-synthesis", structuredOutput: finish };
    });
    const result = await host.execute({ replacement: replacement("cap", 1, snapshot("Original decision; Actual human answered A", { humanDecisions: [{ id: "scope", content: "A", provenance: "Actual foreground human answer" }] })), planning: true, consultation: "cap", continuation: { version: 4, consultation: "cap" } }, storage);
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
    const retained = history(storage, "large");
    expect(JSON.stringify(retained)).not.toContain("x".repeat(4090));
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
        expect(evidenceText(request)).toContain(JSON.stringify(doubts[2]));
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
    const result = await resumed.execute({ planning: true, continuation: { version: 4, consultation: "decision" } }, first.storage);
    expect(readFrontier(result)).toMatchObject({ status: "needs-human", rounds: 1, validRounds: 1, frontier: { round: 1, questions: [
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
    expect(await host.execute()).toMatchObject({ status: "completed", excerpt: finish.memo });
    const retained = history(host.storage);
    expect(JSON.stringify(retained)).not.toContain(contrary);
    expect(originalValue(retained.originals.find(item => item.producer === "recover")!).report).toBe(contrary);
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
      const entry = history(host.storage).originals.find(item => item.producer === "simple")!;
      if (witness === "optional-error" || witness === "top-optional-error") {
        expect(result.status).toBe("completed");
        expect(entry).toMatchObject({ publication: "published", sufficient: true });
        expect(entry.failedOriginal).toBeUndefined();
      } else {
        expect(result).toMatchObject({ status: "failed", validRounds: 0 });
        expect(entry).toMatchObject({ publication: "unpublished", sufficient: false, delivery: "complete" });
        expect(entry).toMatchObject({ failedDelivery: true });
        expect(entry.failedOriginal).toBeUndefined();
        expect(JSON.stringify(host.storage.get("architecture-decision")).split("Private report from r1-simple")).toHaveLength(1);
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
    const original = history(host.storage).originals.find(item => item.key === "r1-simple")!;
    expect(original).not.toHaveProperty("terminalOutcome");
    expect(original).toMatchObject({ sufficient: true,
      relativePath: path.basename(exact!.results![0]!.savedOutputPath as string), digest: expect.any(String) });
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
    const retained = history(host.storage);
    const original = retained.originals.find(item => item.producer === "simple")!;
    expect(original).toMatchObject({ key: "r1-simple", runId: returned!.runId, sufficient: false });
    if (fault.startsWith("top-save")) {
      expect(original).toMatchObject({ publication: "unpublished", delivery: "complete", failedDelivery: true });
      expect(outcome.error).toContain(returned!.outputSaveError!);
      expect(JSON.stringify(retained).split("Private report from r1-simple")).toHaveLength(1);
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
    const original = history(host.storage).originals.find(item => item.key === failedKey)!;
    expect(original).toMatchObject({ sufficient: false, terminal: "failed" });
    if (control === "stopped") expect(original).toHaveProperty("stopped", true);
    if (control === "child-stopped") expect(original).toHaveProperty("stopped", true);
    if (control === "recovery") expect(original).toHaveProperty("recovery", true);
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
    const retained = history(host.storage);
    for (const original of retained.originals) {
      expect(original).toMatchObject({ id: expect.any(String), delivery: "complete",
        consultation: "decision", revision: 1, key: original.key, producer: original.producer,
        relativePath: expect.any(String), digest: expect.any(String) });
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
    const before = structuredClone(history(storage).originals);
    const host = fixture((key, request) => {
      if (key === "director-prepare") {
        expect(request.resume).toBe("native-director-after-r1");
        const old = essentials(request);
        expect(old.map(item => item.id)).toEqual(["decision.v1.r1-simple.a1", "decision.v1.r1-recover.a1", "context-callerEvidence"]);
        for (const item of old.filter(item => !item.id.startsWith("context-"))) expect(originalValue(item).report).toBe(`Private report from ${item.id.split(".")[2]}`);
        return { ...child(key), structuredOutput: { ...discuss, perspectives: [perspectives[0], { id: "new", label: "New whole-problem view", focus: "Reevaluate the full decision" }] } };
      }
      if (key === "r2-simple" || key === "r2-new") {
        expect(request.resume ?? request.context).toBe(key === "r2-simple" ? "native-r1-simple" : "fresh");
        expect(essentials(request)).toHaveLength(5);
        expect(request.task).toContain("after compaction reread missing essentials");
        expect(request.task).not.toContain("Private report");
        for (const item of essentials(request)) expect(originalValue(item)).toBeTruthy();
      }
      return child(key);
    });
    expect(await host.execute({ evidence: "New factual evidence, not a replacement", continuation: first.continuation }, storage))
      .toMatchObject({ status: "completed", rounds: 2, validRounds: 2 });
    // Consumers got verified references; retained originals keep their producer run IDs.
    const retainedOriginals = (storage.get("architecture-decision") as {originals: Original[]}).originals;
    for (const item of before as Original[]) expect(item.runId).toBe(`native-${item.key}`);
    expect(retainedOriginals.every(item => !item.id.includes(".r1-"))).toBe(true);
    const after = history(storage).originals as Original[];
    expect(after.some(item => item.key.startsWith("r2-"))).toBe(true);
    expect(after.filter(item => item.producer === "simple").sort((a: any,b: any) => a.round - b.round).map(item => item.runId)).toEqual(["native-r1-simple", "native-r2-simple"]);
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
      const retained = history(host.storage);
      const entry = retained.originals.find(item => item.producer === "simple")!;
      expect(entry.sufficient).toBe(false);
      expect(entry.publication).toBe("unpublished");
      if (delivery === "complete-blocked") {
        expect(entry).toMatchObject({ delivery: "complete", failedDelivery: true });
        expect(entry.failedOriginal).toBeUndefined();
        expect(entry.diagnostic).toContain("Mandatory output save failed");
        expect(JSON.stringify(retained).split("Partial analysis, fully delivered:")).toHaveLength(1);
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

  test("admission includes unrelated whole-mission bytes and blocks before any model child", async () => {
    const storage = new Map<string, unknown>([["unrelated-state", "u".repeat(200000)]]);
    const before = structuredClone(storage);
    const host = fixture();
    expect(await host.execute(undefined, storage)).toMatchObject({ status: "blocked", rounds: 0, validRounds: 0,
      error: expect.stringContaining("108306 bytes > 262144 bytes. Use a new mission") });
    expect(host.calls).toHaveLength(0);
    expect(host.stateWrites).toHaveLength(0);
    expect(storage).toEqual(before);
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
  const prior = history(first.storage);
  const original = prior.originals.find(item => item.key === "r1-simple")!;
  // Compacted history retains only the digest-pinned publication, not inline/context fallbacks.
  const compact = (first.storage.get("architecture-decision") as any).originals.find((item: Original) => item.id === original.id);
  compact.failedOriginal = originalValue(original);
  compact.accessibility = source;
  rmSync(original.savedOutputPath!);
  const host = fixture();
  expect(await host.execute({ continuation: result.continuation, evidence: "Consume retained originals" }, first.storage)).toMatchObject({
    status: "failed", error: expect.stringContaining("missing-file"),
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
    expect(await host.execute()).toMatchObject({ status: "failed", error: expect.stringContaining("Controlled admission cut") });
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

  test.each([1, 2, 3, 99])("rejects incompatible state and continuation v%i before writes or dispatch", async version => {
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
    if (fault === "evidence") retained.cursor.dispatches[0]!.runId = "r".repeat(97);
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
    expect(unsavedDiagnostics).toContain("unsaved failed evidence diagnostics");
    expect(barriers).toContain("Permission denied; Stop observed");
    expect(host.stateWrites).toHaveLength(writesAtFailure);
    expect(host.calls.some(call => call.key === "director-after-r1")).toBe(false);
  });
});


describe("architecture confirmed phase advancement", () => {
  const continuation = { version: 4, consultation: "decision" };
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
          : boundary === "round-index" ? (value as unknown as { evidence: { originalId?: string }[] }).evidence.some(item => item.originalId) && value.validRounds === 0
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
      expect(history(first.storage).cursor.dispatches.filter(item => item.key.startsWith("r1-")).map(item => item.key).sort()).toEqual(["r1-recover", "r1-simple"]);
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
  const continuation = { version: 4, consultation: "decision" };
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
    const state = {...(first.storage.get("architecture-decision") as any), originals: history(first.storage).originals};
    expect(state.currentDecision.revision).toBe(1);
    expect(state.originals.filter((item: Original) => item.key === "doubts-r1-0")).toHaveLength(1);
    expect(state.originals.filter((item: Original) => item.key === "doubts-r1-1")).toHaveLength(1);
    expect(state.originals.find((item: Original) => item.id === original.id)).toBeUndefined();
    expect(state.cursor.retries).toEqual([]);
    expect(ledgerRecords(first.storage).find(record => record.kind === "context")?.body.factualRetry).toEqual(retry);
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
    expect(retained.originals.find(item => item.id === original.id)).toBeUndefined();
    expect(ledgerRecords(first.storage).find(record => record.kind === "context")?.body.superseded).toContainEqual(original);
    const continued = fixture(key => ({...child(key), structuredOutput: finish}));
    expect(await continued.execute({ planning: true, continuation, evidence: "Continue after retry" }, first.storage)).toMatchObject({ status: "completed" });
    expect(original).toMatchObject({ delivery: "not-delivered", sufficient: false, publication: "unpublished" });
    expect(original.failedOriginal).toBeUndefined();
  });
  test.each(["unproved", "running", "permission", "published-missing"])("does not bypass %s evidence or native barriers with retry authorization", async fault => {
    const first = fixture((key, request) => {
      if (key !== "doubts-r1-1") return reply(key);
      if (fault === "running") return { ok: false, runId: "active-fact", state: "running" };
      if (fault === "permission") return { ok: false, runId: "denied-fact", error: "Permission denied; Stop" };
      if (fault === "published-missing") return { ok: false, runId: "saved-fact", results: [{ savedOutputPath: path.join(originalsRoot, "missing-original") }] };
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
    for (let attempt = 3; attempt <= 5; attempt++) {
      const state = first.storage.get("architecture-decision") as any;
      const latest = state.originals.find((item: Original) => item.key === "doubts-r1-1")!;
      const failedAgain = fixture(reply);
      expect(await failedAgain.execute({planning: true, continuation, factualRetry: {...retry, originalIds: [latest.id],
        authorization: {content: `Retry attempt ${attempt}`, provenance: "Actual human"}}}, first.storage)).toMatchObject({status: "failed", rounds: 1, validRounds: 1});
      const retained = first.storage.get("architecture-decision") as any;
      expect(retained.cursor.dispatches.length).toBeLessThanOrEqual(16);
      expect(retained.cursor.retries).toHaveLength(1);
      expect(retained.originals.length).toBeLessThanOrEqual(16);
      expect(failedAgain.stateWrites.every(write => write.persisted && write.bytes <= stateBound.bytes)).toBe(true);
    }
    const state = first.storage.get("architecture-decision") as { originals: Original[] };
    const latest = [...state.originals].reverse().find(item => item.key === "doubts-r1-1")!;
    const fourth = fixture();
    expect(await fourth.execute({ planning: true, continuation, factualRetry: { ...retry, originalIds: [latest.id],
      authorization: { content: "Retry failed second attempt", provenance: "Actual human message 56" } } }, first.storage))
      .toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
    expect(fourth.calls[0]!.request.output).toContain("a6.json");
    expect(history(first.storage).originals.filter(item => item.key === "doubts-r1-0")).toHaveLength(1);
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
        input.originalIds = [state.originals.find((item: Original) => item.key === (fault === "perspective" ? "r1-simple" : "doubts-r1-0"))!.id];
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
      await expect(second.execute({ planning: true, continuation: { version: 4, consultation: "decision" } }, first.storage))
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
      expect(outcome).toMatchObject({ status: "failed", rounds: 2, validRounds: 1, error: expect.stringContaining("Essential access incomplete for a delivered peer challenge") });
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
    expect(retained.currentDecision).toMatchObject({ revision: 2, snapshot: JSON.stringify(snapshot("CURRENT whole mechanism B")) });
    expect(request.task).not.toContain("OBSOLETE mechanism A");
    expect(request.task).toContain("CURRENT whole mechanism B");
    return child(key);
  });
  const result = await second.execute({ continuation: interrupted.continuation,
    replacement: replacement("decision", 1, snapshot("CURRENT whole mechanism B")) }, first.storage);
  expect(result).toMatchObject({ status: "completed", rounds: 2, validRounds: 1 });
  expect(second.calls.some(call => call.key.startsWith("r1-"))).toBe(false);
  expect(first.storage.get("architecture-decision")).toMatchObject({ currentDecision: { revision: 2 } });
  expect(ledgerRecords(first.storage).find(record => record.kind === "decision")?.body).toMatchObject({ revision: 1, snapshot: { brief: "OBSOLETE mechanism A" } });
});

describe("architecture paused human answers", () => {
  const continuation = { version: 4, consultation: "decision" };
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
  test("blocked facts preserve the human and experiment frontier and flow unresolved into evaluation", async () => {
    const experiment = { id: "probe", kind: "experiment", dependsOn: ["needed"],
      question: "Run Bun in a disposable directory?", decision: "Runtime compatibility",
      recommendation: "Run the authorized Bun probe outside the repo; expect the API to return success." };
    const first = fixture((key, request) => {
      if (key === "director-doubts-r1") {
        expect(request.task).toContain("providers are read-only");
        expect(request.task).toContain("MUST be an experiment");
        expect(JSON.stringify(request.outputSchema)).toContain('"experiment"');
        return { ...child(key), structuredOutput: { doubts: [...questions, experiment] } };
      }
      if (key === "doubts-r1-1") return { ...child(key), structuredOutput: {
        status: "blocked", report: "Execution is unavailable", humanContext: "Cannot run Bun: read-only provider. Runtime fact unresolved.",
      } };
      return respond(key);
    });
    const result = await first.execute({ planning: true, currentDecision: snapshot("Decision") });
    expect(readFrontier(result)).toMatchObject({ status: "needs-human", rounds: 1, validRounds: 1, frontier: { questions: [
      { id: "scope", kind: "human" },
      { id: "reuse", kind: "human", prerequisiteFacts: [{ id: "needed", status: "blocked", humanContext: expect.stringContaining("Runtime fact unresolved") }] },
      { ...experiment, prerequisiteFacts: [{ id: "needed", status: "blocked" }] },
    ] } });
    expect(first.calls.filter(call => call.request.phase === "architecture-factual").map(call => call.key))
      .toEqual(["doubts-r1-0", "doubts-r1-1"]);
    const restarted = fixture();
    expect(await restarted.execute(reentry, first.storage)).toEqual(result);
    expect(restarted.calls).toHaveLength(0);
    const input = answers(result);
    input.answers[2] = { id: "probe", disposition: "answer",
      content: "Bun probe returned success in /tmp/authorized-probe", provenance: "Foreground authorized probe, Bun 1.4.4, command and output log /tmp/probe.log" };
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-after-r1");
      expect(request.task).toContain('"status":"blocked"');
      expect(evidenceText(request)).toContain("Runtime fact unresolved");
      expect(request.task).toContain("blocked means an unresolved fact");
      expect(evidenceText(request)).toContain(input.answers[2]!.provenance);
      expect(evidenceText(request)).toContain(input.answers[2]!.content);
      return child(key);
    });
    expect(await resumed.execute({ ...reentry, humanAnswers: input }, first.storage))
      .toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
  });
  test("blocked facts without human questions reach evaluation instead of aborting", async () => {
    const first = fixture((key, request) => {
      if (key === "director-doubts-r1") return { ...child(key), structuredOutput: { doubts: questions.slice(0, 2) } };
      if (key === "doubts-r1-1") return { ...child(key), structuredOutput: {
        status: "blocked", report: "No execution", humanContext: "Unresolved runtime fact",
      } };
      if (key === "director-after-r1") {
        expect(request.task).toContain('"status":"blocked"');
        expect(evidenceText(request)).toContain("Unresolved runtime fact");
      }
      return child(key);
    });
    expect(await first.execute({ planning: true, currentDecision: snapshot("Decision") }))
      .toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
  });
  test("experiment requires a recommendation before any factual dispatch", async () => {
    const first = fixture(key => key === "director-doubts-r1" ? { ...child(key), structuredOutput: { doubts: [
      { id: "probe", kind: "experiment", dependsOn: [], question: "Run Bun?", decision: "Runtime" },
    ] } } : child(key));
    expect(await first.execute({ planning: true, currentDecision: snapshot("Decision") }))
      .toMatchObject({ status: "failed", error: expect.stringContaining("Invalid doubts") });
    expect(first.calls.some(call => call.request.phase === "architecture-factual")).toBe(false);
  });
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
    expect(readFrontier(result!)).toMatchObject({ status: "needs-human", rounds: 1, validRounds: 1, continuation,
      frontier: { consultation: "decision", revision: 1, round: 1, humanContext: expect.stringContaining("Material facts"), questions: [
        { ...questions[2], prerequisiteFacts: [] },
        { ...questions[3], prerequisiteFacts: [{ id: "needed", key: "doubts-r1-1", originalId: expect.any(String), humanContext: expect.stringContaining("Brief factual frontier") }] },
      ] } });
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
        expect(evidenceText(request)).toContain(phrase);
      return child(key);
    }, undefined, value => {
      firstWrite ??= structuredClone(value);
    }, undefined, clock);
    const done = await resumed.execute({ ...reentry, humanAnswers: input }, first.storage);
    expect(firstWrite).toMatchObject({ cursor: { control: { stage: "evaluate", context: {humanAnswers: {seq: expect.any(Number), digest: expect.any(String)}} } } });
    expect(JSON.stringify(firstWrite)).not.toContain("approve implementation");
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
      if (fault === "state-capacity") expect(await resumed.execute(args, first.storage)).toMatchObject({ status: "blocked", error: expect.stringContaining("Use a new mission") });
      else await expect(resumed.execute(args, first.storage)).rejects.toThrow();
      expect(JSON.stringify([...first.storage])).toBe(before);
      expect(readFileSync(first.stateFile, "utf8")).toBe(persisted);
      expect(resumed.calls).toHaveLength(0);
      expect(resumed.stateWrites.filter(write => write.persisted)).toHaveLength(0);
      expect(resumed.stateWrites).toHaveLength(0);
    });
  test.each(["defer", "unknown"])("accepts %s without content as unresolved decision context", async disposition => {
    const { first, result } = await pause();
    const input = answers(result);
    const humanAnswers = { ...input, answers: input.answers.map(({ content: _content, ...answer }) => ({ ...answer, disposition })) };
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-after-r1");
      expect(evidenceText(request)).toContain(`"disposition":"${disposition}"`);
      expect(request.task).toContain("defer and unknown remain unresolved questions");
      return { ...child(key), structuredOutput: { ...finish, action: "blocked", memo: "Human question remains unresolved" } };
    });
    expect(await resumed.execute({ ...reentry, humanAnswers }, first.storage)).toMatchObject({ status: "blocked", rounds: 1, validRounds: 1 });
    expect(ledgerRecords(first.storage).find(record => record.kind === "context")?.body.humanAnswers.answers).toEqual(humanAnswers.answers);
  });
  test("replacement discards pending at prepare with counters and human snapshot provenance preserved", async () => {
    const { first } = await pause();
    const prior = { id: "earlier", content: "Use A", provenance: "Actual human message 54" };
    const retained = first.storage.get("architecture-decision") as { currentDecision: { snapshot: DecisionSnapshot } };
    const priorSnapshot = JSON.parse(retained.currentDecision.snapshot as unknown as string);
    priorSnapshot.humanDecisions = [prior];
    retained.currentDecision.snapshot = JSON.stringify(priorSnapshot) as unknown as DecisionSnapshot;
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-prepare"); expect(request.task).toContain(prior.provenance);
      return { ...child(key), structuredOutput: { ...finish, action: "blocked" } };
    }, undefined, value => {
      if ((value.cursor as any).ledgerPending || (value as any).currentDecision.revision !== 2 || value.cursor.dispatches.length !== 0) return;
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
    const first = fixture(key => key === "doubts-r1-1" ? { ...child(key), ok: false, error: "Terminal factual failure", structuredOutput: { status: "blocked", report: "Missing prerequisite" } } : respond(key));
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
  test("more than 64 combined human and experiment IDs fails explicitly instead of truncating", async () => {
    const first = fixture(key => key.startsWith("director-doubts-") ? { ...child(key), structuredOutput: {
      doubts: Array.from({ length: 65 }, (_, index) => ({
        ...questions[2], id: `q${index}`, kind: index % 2 ? "experiment" : "human",
      })),
    } } : child(key));
    expect(await first.execute({ planning: true, currentDecision: snapshot("Decision") }))
      .toMatchObject({ status: "failed", error: expect.stringContaining("64 pending IDs") });
    expect(first.calls.some(call => call.key === "director-after-r1")).toBe(false);
    expect(first.storage.get("architecture-decision")).toMatchObject({ cursor: { dispatches: expect.arrayContaining([expect.objectContaining({invalid: "factual-count", boundary: "incomplete"})]) } });
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
    expect(host.verifications.map(entry => entry.key)).toEqual(["verify-v1-r1-simple-a1", "verify-v1-director-after-r1-a1", "verify-v1-memo-director-after-r1-a1-a1"]);
    const request = JSON.parse(host.verifications.find(entry => entry.key === "verify-v1-director-after-r1-a1")!.request.task);
    expect(request).toMatchObject({ namespace: "architecture-decision", gate: "v1-director-after-r1-a1" });
    expect(request.items.every((item: object) => "digest" in item && !("admitted" in item))).toBe(true);
    const pins = host.verifications.filter(entry => entry.key.startsWith("verify-pin-"));
    expect(pins).toEqual([]);
    expect(request.items.map((item: { id: string }) => item.id)).toEqual(["decision.v1.r1-simple.a1", "decision.v1.r1-recover.a1"]);
    const consumer = host.calls.find(call => call.key === "director-after-r1")!.request;
    expect(essentials(consumer).map(item => (item as unknown as { id: string }).id)).toEqual(request.items.map((item: { id: string }) => item.id));
  });

  test("a contradictory published original blocks the consumer before dispatch with an explanation", async () => {
    // Rewrite the published file after its admission is saved, before the evaluation gate verifies it.
    const watched = fixture(undefined, undefined, undefined, value => {
      const recover = (value as unknown as { originals?: Original[] }).originals?.find(item => item.key === "r1-recover");
      const saved = recover?.relativePath ? path.join((recover as any).artifactRoot, recover.relativePath) : recover?.savedOutputPath;
      if (saved && value.cursor.dispatches.some(item => item.key === "r1-recover" && item.boundary === "confirmed"))
        writeFileSync(saved, JSON.stringify({ status: "ready", report: "Edited after admission" }));
    });
    const outcome = await watched.execute();
    expect(outcome.status).toBe("failed");
    for (const part of ["Access gate v1-director-after-r1-a1 blocked before dispatch", "is contradictory: content-differs", "does not choose a version"])
      expect(outcome.error).toContain(part);
    expect(watched.calls.map(call => call.key)).not.toContain("director-after-r1");
  });
});

describe("architecture v4 bounded mission state", () => {
  test("ten realistic planning rounds retain only adjacent-round references and constant pretty-printed state", async () => {
    const roundPeaks = new Map<number, number>();
    const host = fixture((key, request) => {
      const round = Number(key.match(/(?:after-r|doubts-r|^r)(\d+)/)?.[1] ?? 0);
      if (round > 1 && ["architecture-perspective", "architecture-doubts", "architecture-factual"].includes(request.phase ?? "")) {
        expect(evidenceText(request)).toContain("Actual foreground human");
        expect(evidenceText(request)).toContain("Keep the baseline");
        expect(request.task).not.toContain("Actual foreground human");
      }
      if (request.phase === "architecture-perspective") {
        const required = essentials(request);
        expect(required.length).toBeGreaterThan(0);
        for (const item of required.filter(item => !item.id.startsWith("context-"))) {
          // Fresh perspectives see the previous round plus the current director packet, never older rounds.
          if (round > 1) expect(item.id).toMatch(new RegExp(`(?:r${round - 1}(?:-|\\.)|director-prepare)`));
          else expect(item.id).toContain("director-prepare");
        }
        expect(request.task).toContain("VERIFIABLE HISTORY");
        return { ...child(key), structuredOutput: { status: "ready", report: "Original report: " + "x".repeat(5000) } };
      }
      if (request.phase === "architecture-doubts") return { ...child(key), structuredOutput: {
        doubts: [
          ...Array.from({ length: 8 }, (_, index) => ({ id: `fact${index}`, kind: "scout", dependsOn: [],
            question: "q".repeat(990), decision: "d".repeat(990) })),
          ...Array.from({ length: 4 }, (_, index) => ({ id: `human${index}`, kind: "human", dependsOn: [`fact${index}`],
            question: "Confirm the proposed baseline?", decision: "Scope and tradeoffs", recommendation: "Keep the smallest adequate option." })),
        ], humanContext: "h".repeat(7900),
      } };
      if (request.phase === "architecture-factual") return { ...child(key), structuredOutput: {
        status: "ready", report: "Factual report: " + "f".repeat(5000), humanContext: "c".repeat(2500),
      } };
      return { ...child(key), structuredOutput: round === 10 ? { ...finish, memo: "m".repeat(11900) } : {
        ...discuss, packet: "p".repeat(11800), memo: "m".repeat(4000),
        perspectives: Array.from({ length: 4 }, (_, index) => ({ id: `p${round + 1}-${index}`,
          label: "l".repeat(64), focus: "f".repeat(1400) })),
      } };
    }, undefined, value => {
      const bytes = Buffer.byteLength(JSON.stringify({ ["architecture-decision"]: value }, null, 2));
      roundPeaks.set(value.rounds, Math.max(roundPeaks.get(value.rounds) ?? 0, bytes));
      expect(bytes).toBeLessThan(256 * 1024);
      expect(bytes).toBeLessThan(108306);
      const retained = value as unknown as { originals: Original[]; decisionHistory?: unknown; evidence: object[] };
      expect(retained.originals.every(item => !Object.hasOwn(item, "value") && !Object.hasOwn(item, "results"))).toBe(true);
      expect(retained.decisionHistory).toBeUndefined();
      expect(retained.originals.length).toBeLessThanOrEqual(31);
    });
    let result = await host.execute({ planning: true, currentDecision: snapshot("Realistic planning load"), maxRounds: 10 });
    for (let round = 1; round <= 10; round++) {
      expect(result).toMatchObject({ status: "needs-human", rounds: round, validRounds: round });
      result = await host.execute({ planning: true, continuation: result.continuation, humanAnswers: {
        consultation: "decision", revision: 1, round,
        answers: result.frontier!.questions.map(({ id }) => ({ id, disposition: "answer", content: "Keep the baseline", provenance: "Actual foreground human" })),
      } });
    }
    expect(result).toMatchObject({ status: "completed", rounds: 10, validRounds: 10 });
    const steady = Array.from({ length: 9 }, (_, index) => roundPeaks.get(index + 2)!);
    expect(Math.max(...steady)).toBeLessThan(roundPeaks.get(2)! + 1024);
    expect(Math.max(...steady.slice(0, -1)) - Math.min(...steady.slice(0, -1))).toBeLessThan(1024);
    expect(ledgerRecords(host.storage).filter(record => record.kind === "round")).toHaveLength(10);
    expect(host.stateWrites.every(write => write.persisted && write.bytes <= 262144)).toBe(true);
    console.log(`architecture v4 ten-round pretty-state peak ${Math.max(...roundPeaks.values())} bytes; steady range ${Math.min(...steady)}..${Math.max(...steady)}`);
  });

  test("large schema-valid prose is published by reference without compaction or pin children", async () => {
    const host = fixture((key, request) => {
      if (key === "director-prepare") return {...child(key), structuredOutput: {...discuss, packet: "中".repeat(40000), perspectives: perspectives.map(p => ({...p, focus: "focus".repeat(4000)}))}};
      if (request.phase === "architecture-doubts") return {...child(key), structuredOutput: {doubts: [{id: "fact", kind: "scout", dependsOn: [], question: "q".repeat(20000), decision: "d".repeat(20000)}], humanContext: "context".repeat(10000)}};
      if (request.phase === "architecture-factual") return {...child(key), structuredOutput: {status: "blocked", report: "Unresolved", humanContext: "中".repeat(20000)}};
      return child(key);
    });
    expect(await host.execute({planning: true, currentDecision: snapshot("Large published prose")})).toMatchObject({status: "completed"});
    expect(host.calls.some(call => call.key.includes("compact"))).toBe(false);
    expect(host.verifications.some(call => call.key.includes("pin-"))).toBe(false);
    const state = JSON.stringify(host.storage.get("architecture-decision"));
    expect(state).not.toContain("中");
    expect(state).not.toContain("focusfocus");
  });
});

test.each([false, true])("round publication before a failed anchor save reconciles identical bytes, never skips a conflict (tamper=%s)", async tamper => {
  let cut = false;
  const first = fixture(undefined, undefined, value => {
    if (!cut && value.rounds === 1 && (value as any).ledger.count === 2) { cut = true; throw new Error("Anchor save cut after publication"); }
  });
  const result = await first.execute();
  expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("Anchor save cut") });
  expect(cut).toBe(true);
  const prior = structuredClone(first.storage.get("architecture-decision")) as any;
  expect(prior.ledger.count).toBe(1);
  const file = path.join(ledgerPath(fixtureMissions.get(first.storage)!, "decision"), "000001.json");
  const bytes = readFileSync(file, "utf8");
  if (tamper) {
    expect(bytes).not.toContain(finish.memo);
    writeFileSync(file, bytes.replace("director-after-r1", "director-after-r9"));
  }
  if (!tamper) {
    const blocked = fixture();
    expect(await blocked.execute({continuation: result.continuation, replacement: replacement("decision", 1, snapshot("Replacement after round replay"))}, first.storage))
      .toMatchObject({status: "blocked", error: expect.stringContaining("re-enter without replacement first")});
    expect(blocked.calls).toEqual([]); expect(blocked.stateWrites).toEqual([]);
    expect(first.storage.get("architecture-decision")).toEqual(prior);
  }
  const resumed = fixture();
  const outcome = await resumed.execute({ continuation: result.continuation }, first.storage);
  expect(resumed.calls).toHaveLength(0);
  if (tamper) {
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringContaining("conflict") });
    expect(first.storage.get("architecture-decision")).toEqual(prior);
  } else {
    expect(outcome).toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(ledgerRecords(first.storage)).toHaveLength(2);
    expect(await fixture().execute({continuation: result.continuation, replacement: replacement("decision", 1, snapshot("Replacement after round replay"))}, first.storage))
      .toMatchObject({status: "completed"});
  }
});

test.each(["omitted", "identical", "different"])("write-ahead replacement survives append/save cut with %s reentry", async kind => {
  const storage = new Map<string, unknown>();
  const first = await fixture().execute(undefined, storage);
  const update = replacement("decision", 1, snapshot("New complete decision"));
  const interrupted = fixture(undefined, undefined, value => {
    if ((value as any).currentDecision.revision === 2) throw new Error("Replacement anchor save cut");
  });
  const cut = await interrupted.execute({ continuation: first.continuation, replacement: update }, storage);
  expect(cut).toMatchObject({ status: "failed", error: expect.stringContaining("Replacement anchor save cut") });
  expect(interrupted.calls).toHaveLength(0);
  const pending = structuredClone(storage.get("architecture-decision")) as any;
  expect(pending).toMatchObject({ currentDecision: { revision: 1 }, cursor: { ledgerPending: { kind: "decision", expectedRevision: 1, digest: canonicalDigest(update) } } });
  const resumed = fixture(key => {
    expect((storage.get("architecture-decision") as any).cursor.ledgerPending).toBeUndefined();
    expect(storage.get("architecture-decision")).toMatchObject({ currentDecision: { revision: 2 } });
    return { ...child(key), structuredOutput: finish };
  });
  const result = await resumed.execute({ continuation: first.continuation,
    ...(kind === "identical" ? { replacement: Object.fromEntries(Object.entries(update).reverse()) }
      : kind === "different" ? { replacement: replacement("decision", 1, snapshot("Other decision")) } : {}),
  }, storage);
  if (kind !== "identical") {
    expect(result).toMatchObject({ status: "blocked", error: expect.stringContaining("earlier architecture replacement is still pending") });
    expect(storage.get("architecture-decision")).toEqual(pending);
    expect(resumed.calls).toHaveLength(0);
  } else {
    expect(result).toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
    expect(resumed.calls.map(call => call.key)).toEqual(["director-prepare"]);
    expect(ledgerRecords(storage).filter(record => record.kind === "decision")).toHaveLength(1);
    expect((storage.get("architecture-decision") as any).cursor.ledgerPending).toBeUndefined();
  }
});

test("prose is uncapped and more than eight factual doubts fails before confirmation and provider dispatch", async () => {
  const host = fixture((key, request) => {
    const schema = request.outputSchema as any;
    if (key === "director-prepare") {
      expect(schema.properties.packet.maxLength).toBeUndefined();
      expect(schema.properties.memo.maxLength).toBeUndefined();
      expect(schema.properties.perspectives.maxItems).toBe(4);
      expect(schema.properties.perspectives.items.properties.label.maxLength).toBe(64);
      expect(schema.properties.perspectives.items.properties.focus.maxLength).toBeUndefined();
    }
    if (request.phase === "architecture-doubts") {
      expect(schema.properties.humanContext.maxLength).toBeUndefined();
      const doubt = schema.properties.doubts.items.properties;
      for (const field of ["question", "decision", "recommendation"]) expect(doubt[field].maxLength).toBeUndefined();
      return { ...child(key), structuredOutput: { doubts: Array.from({ length: 9 }, (_, index) => ({
        id: `f${index}`, kind: "scout", dependsOn: [], question: "Local contract?", decision: "Choose implementation",
      })) } };
    }
    return child(key);
  });
  expect(await host.execute({ planning: true, currentDecision: snapshot("Bound factual fanout") }))
    .toMatchObject({ status: "failed", error: expect.stringContaining("At most 8 factual doubts") });
  expect(host.calls.filter(call => call.request.phase === "architecture-factual")).toHaveLength(0);
});

const digestFunctions = readFileSync(new URL("../skills/workflow-canonical.js", import.meta.url), "utf8");
const scriptDigest = new Function(digestFunctions + "; return canonicalDigest;")() as (value: unknown) => string;
const stateBound = new Function(nativeFlagsSource + "function utf8Bytes(value) { return unescape(encodeURIComponent(value)).length; }\n" +
  rawSource.slice(rawSource.indexOf("function architectureStateBound("), rawSource.indexOf("function retainedConsultation(")) +
  "; return architectureStateBound();")() as {bytes: number; skeleton: any};

test("workflow canonical digest matches canonical.mjs across UTF-8, escapes, blocks and nested numeric key ordering", () => {
  for (const value of [null, true, false, 0, -0, 1.25, "", "\u0000\n\r\t\"\\", "漢字 😀 𝄞 é", "\ud800",
    {"2": "two", "10": "ten", z: [{b: false, a: null}, "🐎"], a: {y: 3, x: [1, "é"]}},
    ...[55, 56, 63, 64, 65, 127, 128, 10000].map(size => ({z: "😀漢\\\n".repeat(size), a: [size]}))])
    expect(scriptDigest(value)).toBe(canonicalDigest(value));
});

test.each(["finish", "blocked"])("continuation-only %s returns the identical verified memo reference and excerpt without model dispatch or saves", async action => {
  const host = fixture(key => child(key, {...finish, action}));
  const result = await host.execute();
  expect(result.status).toBe(action === "finish" ? "completed" : "blocked");
  const continued = fixture();
  expect(await continued.execute({continuation: result.continuation}, host.storage)).toEqual(result);
  expect(continued.calls).toEqual([]);
  expect(continued.stateWrites).toEqual([]);
  expect(canonicalDigest(JSON.parse(readFileSync(result.memo!.path, "utf8")))).toBe(result.memo!.digest);
});

test("a missing admitted digest is diagnosed separately from publication failure", async () => {
  const host = fixture();
  const result = await host.execute();
  const retained = host.storage.get("architecture-decision") as any;
  delete retained.originals.find((item: Original) => item.id === "decision.v1.r1-simple.a1").digest;
  const continued = fixture();
  const failure = await continued.execute({continuation: result.continuation, evidence: "New caller evidence"}, host.storage);
  expect(failure.status).toBe("failed");
  expect(failure.error).toContain("missing-digest");
  expect(failure.error).not.toContain("output-save-error");
  expect(continued.calls).toEqual([]);
});

test("caller-context append/save cut diagnoses missing input and reconciles the identical human answers", async () => {
  let cut = false;
  const questions = [{id: "scope", kind: "human", dependsOn: [], question: "Keep baseline?", decision: "Scope", recommendation: "Keep it"}];
  const host = fixture(key => key.startsWith("director-doubts-") ? {...child(key), structuredOutput: {doubts: questions}} : child(key), undefined,
    value => { if (!cut && (value as any).cursor.control.context?.humanAnswers) {cut = true; throw new Error("Context anchor save cut");} });
  const paused = await host.execute({planning: true, currentDecision: snapshot("Context crash safety")});
  const input = {planning: true, continuation: paused.continuation, humanAnswers: {consultation: "decision", revision: 1, round: 1,
    answers: [{id: "scope", disposition: "answer", content: "Keep the human baseline", provenance: "Actual human message 72"}]}};
  expect(await host.execute(input)).toMatchObject({status: "failed", error: expect.stringContaining("Context anchor save cut")});
  const restarted = fixture();
  await expect(restarted.execute({planning: true, continuation: paused.continuation}, host.storage)).rejects.toThrow("Replay the identical caller input");
  expect(restarted.calls).toEqual([]);
  const resumed = fixture((key, request) => {
    expect(evidenceText(request)).toContain("Actual human message 72");
    expect(request.task).not.toContain("Keep the human baseline");
    return child(key);
  });
  expect(await resumed.execute(input, host.storage)).toMatchObject({status: "completed"});
  expect(ledgerRecords(host.storage).filter(record => record.kind === "context")).toHaveLength(1);
});

test("every save-point component fits the derived maximal skeleton with all components filled simultaneously", async () => {
  expect(compactConsultation(expandConsultation(stateBound.skeleton))).toEqual(stateBound.skeleton);
  expect(stateBound.bytes).toBe(108306);
  expect(stateBound.bytes).toBeLessThanOrEqual(112 * 1024);
  const measure = (value: any) => Buffer.byteLength(JSON.stringify({state: {["architecture-" + "x".repeat(64)]: value}}, null, 2));
  const maximize = (actual: any, maximum: any, path: string[] = []): any => {
    if (actual && typeof actual === "object" && !Array.isArray(actual)) {
      const result: any = {};
      for (const [key, value] of Object.entries(actual)) {
        expect(Object.hasOwn(maximum, key)).toBe(true);
        result[key] = maximize(value, maximum[key], [...path, key]);
      }
      return result;
    }
    // Each saved component must fit when ALL other components are maximal.
    if (Array.isArray(actual)) expect(actual.length).toBeLessThanOrEqual(maximum.length);
    const substituted = structuredClone(stateBound.skeleton);
    let parent = substituted;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)!] = actual;
    expect(measure(substituted)).toBeLessThanOrEqual(stateBound.bytes);
    return structuredClone(maximum);
  };
  let saves = 0;
  const ids = Array.from({length: 8}, (_, i) => `fact${i}`.padEnd(32, "f"));
  const humanIds = Array.from({length: 64}, (_, i) => `human${i}`.padEnd(32, "h"));
  const allDoubts = [
    ...ids.map(id => ({id, kind: "scout", dependsOn: [], question: "q".repeat(10000), decision: "d".repeat(10000)})),
    ...humanIds.map(id => ({id, kind: "human", dependsOn: ids, question: "Keep scope?", decision: "Scope", recommendation: "Keep baseline"})),
    ...Array.from({length: 8}, (_, i) => ({id: `weigh${i}`.padEnd(32, "w"), kind: "deliberation", dependsOn: ids, question: "Compare complete alternatives", decision: "Design"})),
  ];
  let failEvaluation = false;
  const host = fixture((key, request) => {
    const result = key === "director-prepare" ? {...child(key), structuredOutput: {...discuss, perspectives: Array.from({length: 4}, (_, i) => ({id: `view${i}`.padEnd(32, "v"), label: "\\".repeat(63), focus: "focus".repeat(10000)}))}}
      : request.phase === "architecture-doubts" ? {...child(key), structuredOutput: {doubts: allDoubts}}
      : request.phase === "architecture-factual" ? {...child(key), structuredOutput: {status: "blocked", report: "Unresolved fact"}}
      : failEvaluation && request.phase === "architecture-evaluate" ? {...child(key), ok: false, error: "Terminal failed evaluation"}
      : child(key);
    const value = published({...result, runId: `native-${key}`.padEnd(94, "r")}, request);
    const short = value.results![0]!.savedOutputPath as string;
    // Exercise the actual relative path bound, including escaping below.
    const leaf = `${++publicationSequence}.json`;
    const directory = path.join(originalsRoot, "p".repeat(158 - leaf.length - 1));
    mkdirSync(directory, {recursive: true});
    const file = path.join(directory, leaf);
    expect(Buffer.byteLength(JSON.stringify(path.relative(originalsRoot, file)))).toBe(160);
    writeFileSync(file, readFileSync(short));
    value.results![0]!.savedOutputPath = key === "director-prepare" ? path.join(originalsRoot, String(request.output)) : file;
    mkdirSync(path.dirname(value.results![0]!.savedOutputPath as string), {recursive: true});
    writeFileSync(value.results![0]!.savedOutputPath as string, readFileSync(short));
    return {...value, raw: true};
  }, undefined, value => {
    saves++;
    const logical = value as any;
    expect(logical.cursor.dispatches.filter((item: any) => item.controlOutput?.perspectives?.length).length).toBeLessThanOrEqual(1);
    // The skeleton reserves three director control slots (prior after-rN, prepare, current after-rN).
    expect(logical.cursor.dispatches.filter((item: any) => item.controlOutput?.action).length).toBeLessThanOrEqual(3);
    expect(logical.originals.filter((item: any) => item.diagnostic).length).toBeLessThanOrEqual(9);
    const saved = physical(value);
    const filled = maximize(saved, stateBound.skeleton);
    expect(measure(filled)).toBeLessThanOrEqual(stateBound.bytes);
    expect(measure(saved)).toBeLessThanOrEqual(stateBound.bytes);
  });
  const paused = await host.execute({planning: true, currentDecision: snapshot("Large caller snapshot " + "\\".repeat(7500)), maxRounds: 2});
  expect(paused.status).toBe("needs-human");
  expect(paused.frontier!.questions).toHaveLength(64);
  expect(paused.frontier!.questions.every(item => JSON.stringify(item.dependsOn) === JSON.stringify(ids))).toBe(true);
  expect(await host.execute({planning: true, continuation: paused.continuation, humanAnswers: {consultation: "decision", revision: 1, round: 1,
    answers: humanIds.map(id => ({id, disposition: "answer", content: "Keep baseline", provenance: "Actual human"}))}})).toMatchObject({status: "completed"});
  failEvaluation = true;
  const again = await host.execute({planning: true, continuation: paused.continuation, evidence: "Reconsider the same decision"});
  expect(again).toMatchObject({status: "needs-human", rounds: 2});
  expect(await host.execute({planning: true, continuation: again.continuation, humanAnswers: {consultation: "decision", revision: 1, round: 2,
    answers: humanIds.map(id => ({id, disposition: "answer", content: "Keep baseline", provenance: "Actual human"}))}})).toMatchObject({status: "failed"});
  const retained = host.storage.get("architecture-decision") as any;
  expect(retained.originals.filter((item: any) => item.diagnostic)).toHaveLength(9);
  expect(saves).toBeGreaterThan(30);
  expect(host.stateWrites.every(write => write.persisted && write.bytes <= 262144)).toBe(true);
});


test("plan initial-context at maximal admitted reference sizes coexists with a maximal consultation", async () => {
  // Run the real /plan producer script: it stores native reference envelopes, not
  // report prose. Fill every documented native reference slot at architecture's
  // admitted path/runId limits, including escaped bytes and the output mapping.
  const contextSource = readFileSync(new URL("../skills/plan/context.js", import.meta.url), "utf8");
  const storage = new Map<string, unknown>();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const initial = await new AsyncFunction("args", "runs", "state", contextSource)(
    {brief: "Choose persistence", workDescription: "Choose persistence architecture"},
    {all: async (requests: Request[]) => requests.map(request => {
      const association = Object.fromEntries(Object.entries((request.outputSchema as any).properties.association.properties).map(([key, schema]: [string, any]) => [key, schema.const]));
      const file = "/" + "p".repeat(1021);
      return {ok: true, runId: "r".repeat(94), agent: request.agent,
        outputReference: file, outputArtifactPath: file, artifactPaths: [file], state: "complete",
        structuredOutput: {association, delivery: "complete", status: "ready", report: "Unbounded report stays outside mission state",
          briefing: Object.fromEntries(["facts", "reasons", "contradictions", "limits", "questions", "sources", "essentialReasons"].map(key => [key, ["Initial provider context"]]))},
        results: [{index: 0, agent: request.agent, runId: "r".repeat(94), workflowKey: request.key, savedOutputPath: file,
          outputReference: {path: file, bytes: Number.MAX_SAFE_INTEGER, lines: Number.MAX_SAFE_INTEGER, message: "Output saved to: " + file},
          structuredOutputPath: file, artifactPaths: [file], exitCode: 0, state: "complete"}]};
    })}, {set: async (key: string, value: unknown) => storage.set(key, value)});
  expect(initial.status).toBe("ready");
  const initialBytes = Buffer.byteLength(JSON.stringify({state: Object.fromEntries(storage)}, null, 2));
  expect(initialBytes).toBeGreaterThan(7000);
  expect(Buffer.byteLength(JSON.stringify({state: {...Object.fromEntries(storage), ["architecture-" + "x".repeat(64)]: stateBound.skeleton}}, null, 2))).toBeLessThan(262144);
  const host = fixture();
  expect(await host.execute(undefined, storage)).toMatchObject({status: "completed"});
  expect(host.calls.length).toBeGreaterThan(0);
  expect(host.stateWrites.every(write => write.persisted && write.bytes < 262144)).toBe(true);
  console.log(`plan maximal reference-envelope initial-context ${initialBytes} bytes; maximal consultation ${stateBound.bytes} bytes`);
});

test.each(["../outside.json", "/outside-root.json", "sub/../outside.json"])("published path %s with traversal or an empty derived root is rejected before dependent dispatch", async file => {
  const host = fixture((key, request) => {
    const value = published(child(key), request);
    if (key === "r1-simple") value.results![0]!.savedOutputPath = file.startsWith("/") ? file : originalsRoot + "/" + file;
    return {...value, raw: true};
  });
  const result = await host.execute();
  expect(result.status).toBe("failed");
  expect(result.error).toContain("path traversal/outside-root");
  expect(host.calls.some(call => call.key === "director-after-r1")).toBe(false);
  expect(history(host.storage).originals.some(original => original.key === "r1-recover")).toBe(true);
});

test.each(["deliberation", "id"])("doubt structural %s bound fails before any factual child", async fault => {
  const host = fixture((key, request) => request.phase === "architecture-doubts" ? {...child(key), structuredOutput: {
    doubts: fault === "deliberation" ? Array.from({length: 9}, (_, i) => ({id: `d${i}`, kind: "deliberation", dependsOn: [], question: "Compare?", decision: "Design"}))
      : [{id: "d".repeat(33), kind: "scout", dependsOn: [], question: "Which seam?", decision: "Reuse"}],
  }} : child(key));
  expect(await host.execute({planning: true, currentDecision: snapshot("Structural bound")})).toMatchObject({status: "failed"});
  expect(host.calls.some(call => call.request.phase === "architecture-factual")).toBe(false);
});

test.each([false, true])("failed-comparison archive survives append/anchor cut, and retains native barriers (barrier=%s)", async barrier => {
  const storage = new Map<string, unknown>();
  const first = fixture(key => key === "r1-simple" ? {...child(key), ok: false, ...(barrier ? {stopped: true} : {}), error: barrier ? "Stop" : "Terminal inadequate comparison"} : child(key));
  const failed = await first.execute(undefined, storage);
  expect(failed.status).toBe("failed");
  let cut = false;
  const interrupted = fixture(undefined, undefined, value => {
    if ((value as any).ledger.count === 2) {cut = true; throw new Error("Failed archive anchor cut");}
  });
  const input = {continuation: failed.continuation, evidence: "Explicitly request another prepare"};
  expect(await interrupted.execute(input, storage)).toMatchObject({status: "failed"});
  expect(interrupted.calls).toEqual([]);
  expect(cut).toBe(!barrier);
  const resumed = fixture((key, request) => {
    expect(essentials(request).some(original => original.id.includes(".r1-"))).toBe(false);
    return {...child(key), structuredOutput: {...finish, action: "blocked"}};
  });
  const result = await resumed.execute(input, storage);
  expect(result).toMatchObject({status: barrier ? "failed" : "blocked", rounds: 1, validRounds: 0});
  const archived = ledgerRecords(storage).filter(record => record.kind === "round" && record.body.comparison === "failed");
  expect(archived).toHaveLength(barrier ? 0 : 1);
  if (!barrier) {
    const comparison = logical(archived[0]!.body);
    expect(comparison).toMatchObject({rounds: 1, validRounds: 0});
    expect(comparison.originals.find((original: Original) => original.key === "r1-simple").diagnostic).toContain("Terminal inadequate comparison");
  } else expect(resumed.calls).toEqual([]);
});

test("ten failed comparisons, replacement, then repeated ceiling synthesis never accumulate live controls", async () => {
  const storage = new Map<string, unknown>();
  const roster = Array.from({length: 4}, (_, i) => ({id: `view${i}`.padEnd(32, "v"), label: "Perspective", focus: "Whole problem"}));
  let continuation: Continuation | null = null;
  for (let round = 1; round <= 10; round++) {
    const host = fixture((key, request) => key === "director-prepare" ? {...child(key), structuredOutput: {...discuss, perspectives: roster}}
      : request.phase === "architecture-perspective" ? {...child(key), structuredOutput: {status: "blocked", report: "Insufficient comparison"}} : child(key), undefined,
      value => {
        expect(value.cursor.dispatches.length).toBeLessThanOrEqual(16);
        expect(Buffer.byteLength(JSON.stringify({state: {"architecture-decision": physical(value)}}, null, 2))).toBeLessThanOrEqual(stateBound.bytes);
      });
    const result = await host.execute(round === 1 ? {currentDecision: snapshot("Bound failed comparisons"), maxRounds: 10} : {continuation, evidence: `New facts for round ${round}`}, storage);
    expect(result).toMatchObject({status: "failed", rounds: round, validRounds: 0});
    continuation = result.continuation;
  }
  const ceiling = fixture((key, request) => {
    expect(key).toBe("director-prepare");
    expect(essentials(request).every(original => original.id.startsWith("context-"))).toBe(true);
    return {...child(key), structuredOutput: {...finish, action: "blocked"}};
  });
  expect(await ceiling.execute({continuation, replacement: replacement("decision", 1, snapshot("Replacement after failed comparison"))}, storage)).toMatchObject({status: "blocked", rounds: 10, validRounds: 0});
  expect(ledgerRecords(storage).filter(record => record.kind === "round" && record.body.comparison === "failed")).toHaveLength(10);
  for (let i = 0; i < 12; i++) {
    const host = fixture(key => ({...child(key), structuredOutput: {...finish, action: "blocked"}}));
    const result = await host.execute({continuation, evidence: `Ceiling synthesis ${i}`}, storage);
    expect(result).toMatchObject({status: "blocked", rounds: 10, validRounds: 0});
    const continued = fixture();
    expect(await continued.execute({continuation: result.continuation}, storage)).toEqual(result);
    expect(continued.calls).toEqual([]);
    expect(continued.stateWrites).toEqual([]);
    const memoItems = (host: ReturnType<typeof fixture>) => JSON.parse([...host.verifications].reverse().find(call => JSON.parse(call.request.task).gate.includes("memo-"))!.request.task).items;
    expect(memoItems(continued)).toEqual(memoItems(host));
    const retained = storage.get("architecture-decision") as any;
    expect(retained.cursor.dispatches).toHaveLength(1);
    expect(retained.originals.length).toBeLessThanOrEqual(2);
    expect(host.stateWrites.every(write => write.persisted && write.bytes <= stateBound.bytes)).toBe(true);
  }
});


test("continuation-only failed comparison replays its confirmed reports and diagnostic, not a memo", async () => {
  const host = fixture(key => key === "r1-simple" ? {...child(key), structuredOutput: {status: "blocked", report: "Cannot compare"}} : child(key));
  const result = await host.execute();
  expect(result).toMatchObject({status: "failed", error: expect.stringContaining("No adequate report from simple")});
  const continued = fixture();
  expect(await continued.execute({continuation: result.continuation}, host.storage)).toEqual(result);
  expect(continued.calls).toEqual([]);
  expect(result.memo).toBeUndefined();
});

test("round-zero blocked conclusions close and remain constant across evidence continuations", async () => {
  const host = fixture(key => ({...child(key), structuredOutput: {...finish, action: "blocked", perspectives}}));
  let result = await host.execute();
  expect(result).toMatchObject({status: "blocked", rounds: 0, validRounds: 0});
  const continued = fixture();
  expect(await continued.execute({continuation: result.continuation}, host.storage)).toEqual(result);
  expect(continued.calls).toEqual([]);
  const sizes: number[] = [];
  for (let i = 0; i < 6; i++) {
    result = await host.execute({continuation: result.continuation, evidence: `Caller evidence ${i}`});
    expect(result).toMatchObject({status: "blocked", rounds: 0});
    const saved = host.storage.get("architecture-decision") as any;
    expect(saved.cursor.dispatches).toHaveLength(1);
    expect(saved.originals).toHaveLength(1);
    expect(saved.cursor.dispatches[0].controlOutput.perspectives).toEqual([]);
    sizes.push(Buffer.byteLength(JSON.stringify(physical(saved))));
  }
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(32);
  expect(host.calls).toHaveLength(7);
  expect(ledgerRecords(host.storage).filter(record => record.kind === "round")).toHaveLength(7);
});

test("two paused rounds keep earlier human answers and caller evidence ACTIVE through pinned priorActive context", async () => {
  const question = {id: "scope", kind: "human", dependsOn: [], question: "Keep baseline?", decision: "Scope", recommendation: "Keep it"};
  const host = fixture((key, request) => request.phase === "architecture-doubts"
    ? {...child(key), structuredOutput: {doubts: key === "director-doubts-r3" ? [] : [question]}}
    : key.startsWith("director-after-r") ? child(key, key === "director-after-r3" ? finish : discuss) : child(key));
  let result = await host.execute({planning: true, currentDecision: snapshot("Active human context"), evidence: "Initial caller fact provenance 10"});
  for (let round = 1; round <= 2; round++) {
    expect(result).toMatchObject({status: "needs-human", rounds: round});
    result = await host.execute({planning: true, continuation: result.continuation, humanAnswers: {consultation: "decision", revision: 1, round,
      answers: [{id: "scope", disposition: "answer", content: `Human answer ${round}`, provenance: `Actual human message ${round}`} ]}});
  }
  expect(result.status).toBe("completed");
  const readContext = (ref: {path: string; digest: string}): string => {
    const value = JSON.parse(readFileSync(ref.path, "utf8"));
    expect(canonicalDigest(value)).toBe(ref.digest);
    // Follow only the path the record gives its consumer; never rebuild the filename convention.
    const prior = Object.values(value.body.priorActive ?? {}) as {path: string; digest: string}[];
    return JSON.stringify(value) + prior.map(item => readContext({path: item.path, digest: item.digest})).join("\n");
  };
  const prompts = host.calls.filter(call => call.request.phase === "architecture-perspective" && call.key.startsWith("r3-"));
  expect(prompts).toHaveLength(2);
  for (const {request} of prompts) {
    expect(request.task).toContain("ACTIVE decision context");
    const active = essentials(request).filter(item => item.id.startsWith("context-"));
    const contents = active.map(item => readContext({path: item.results![0]!.savedOutputPath!, digest: (item as any).digest})).join("\n");
    for (const text of ["Actual human message 1", "Actual human message 2", "Initial caller fact provenance 10"]) expect(contents).toContain(text);
  }
});

test("original references survive new workflow run roots and changed artifacts directories across human and evidence reentry", async () => {
  const question = {id: "scope", kind: "human", dependsOn: [], question: "Keep scope?", decision: "Scope", recommendation: "Keep it"};
  const host = fixture((key, request) => request.phase === "architecture-doubts"
    ? {...child(key), structuredOutput: {doubts: [question]}} : child(key), undefined, undefined, undefined, Date, true);
  const first = await host.execute({planning: true, currentDecision: snapshot("Cross-session originals")});
  expect(first.status).toBe("needs-human");
  const answer = (round: number) => ({consultation: "decision", revision: 1, round,
    answers: [{id: "scope", disposition: "answer", content: "Keep it", provenance: "Actual human"}]});
  const done = await host.execute({planning: true, continuation: first.continuation, humanAnswers: answer(1)});
  expect(done.status).toBe("completed");
  expect(done.memo!.path.split("/outputs/")[0]).not.toBe(first.frontier!.original.path.split("/outputs/")[0]);
  const next = await host.execute({planning: true, continuation: done.continuation, evidence: "New observation with actual provenance"});
  expect(next.status).toBe("needs-human");
  expect(next.frontier!.original.path.split("/outputs/")[0]).not.toBe(done.memo!.path.split("/outputs/")[0]);
  readFrontier(first); readFrontier(next);
  expect(canonicalDigest(JSON.parse(readFileSync(done.memo!.path, "utf8")))).toBe(done.memo!.digest);
});

test("pending caller context blocks replacement without an intention, then identical context replay permits replacement", async () => {
  const storage = new Map<string, unknown>();
  const first = await fixture().execute(undefined, storage);
  const input = {continuation: first.continuation, evidence: "Actual observation provenance 91"};
  const interrupted = fixture(undefined, undefined, value => {
    if ((value as any).cursor.control.context?.callerEvidence) throw new Error("Context anchor cut");
  });
  expect(await interrupted.execute(input, storage)).toMatchObject({status: "failed"});
  const prior = structuredClone(storage.get("architecture-decision"));
  const update = replacement("decision", 1, snapshot("Replacement after reconciliation"));
  const blocked = fixture();
  expect(await blocked.execute({continuation: first.continuation, replacement: update}, storage)).toMatchObject({status: "blocked", error: expect.stringContaining("re-enter without replacement first")});
  expect(blocked.calls).toEqual([]); expect(blocked.stateWrites).toEqual([]);
  expect(storage.get("architecture-decision")).toEqual(prior);
  expect(await fixture().execute(input, storage)).toMatchObject({status: "completed"});
  expect(await fixture().execute({continuation: first.continuation, replacement: update}, storage)).toMatchObject({status: "completed"});
});

test.each([
  ["admission", false], ["replacement", false], ["newDecision", false],
  ["admission", true], ["replacement", true],
] as const)("%s plus evidence anchors each append and reconciles a cut (after context: %s)", async (kind, afterContext) => {
  const storage = new Map<string, unknown>();
  const first = kind !== "admission" ? await fixture().execute(undefined, storage) : undefined;
  const consultation = kind === "newDecision" ? "new-decision" : "decision";
  const input = kind === "replacement"
    ? {continuation: first!.continuation, replacement: replacement("decision", 1, snapshot("Changed decision")), evidence: "New fact provenance 92"}
    : kind === "newDecision"
    ? {consultation, newDecision: true, continuation: first!.continuation, currentDecision: snapshot("Genuinely new decision"), evidence: "New fact provenance 92"}
    : {currentDecision: snapshot("Initial with evidence"), evidence: "New fact provenance 92"};
  let cut = false;
  const interrupted = fixture(undefined, undefined, value => {
    if (!cut && !(value as any).cursor.ledgerPending && (afterContext
        ? !!(value as any).cursor.control.context?.callerEvidence
        : ((kind !== "replacement" && (value as any).ledger.count === 1) ||
          (kind === "replacement" && (value as any).currentDecision.revision === 2)))) {
      cut = true; throw new Error("Append anchor cut");
    }
  });
  expect(await interrupted.execute(input, storage)).toMatchObject({status: "failed", error: expect.stringContaining("Append anchor cut")});
  expect(cut).toBe(true);
  if (afterContext) {
    await expect(fixture().execute({...input, continuation: {version: 4, consultation}}, storage)).rejects.toThrow(
      `If ${kind} was already applied, re-enter with continuation plus the remaining caller input (e.g. evidence) and provenance, without ${kind === "admission" ? "currentDecision" : "replacement"}.`);
  }
  const replay = afterContext ? {continuation: {version: 4, consultation}, evidence: input.evidence} : input;
  expect(await fixture().execute(replay, storage)).toMatchObject({status: "completed"});
  expect(ledgerRecords(storage, consultation).filter(record => record.kind === "context")).toHaveLength(1);
});
