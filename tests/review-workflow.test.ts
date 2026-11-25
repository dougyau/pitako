import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
const originalsRoot = mkdtempSync(join(tmpdir(), "pitako-review-originals-"));
let originalNumber = 0;
afterAll(() => rmSync(originalsRoot, { recursive: true, force: true }));
import { runWorkflowScript, workflowRunParamsFingerprint, type WorkflowScriptChildResult } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { verifyGate } from "../extensions/access-receipts.mjs";

import { readReviewOriginal, reviewOriginals } from "../skills/execute/loop.ts";
import { createHash } from "node:crypto";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { analysisResource } from "../extensions/plan-execute.ts";
import { reviewSynthesisScript } from "../skills/review/synthesis.mjs";
import { reviewCursorScript } from "../skills/review/cursor.mjs";
import { observeReview, saveReview } from "../skills/review/store-io.mjs";
import { PitakoStore, StoreError } from "../extensions/pitako-store.ts";
import { openSqliteSync } from "../extensions/board/sqlite.ts";
import { gitFakeBootstrap } from "./fixtures/git-fake-env.ts";
import { gitFakeFixture } from "./fixtures/git-fake-fixture.ts";
import { pitakoAgentFamily, pitakoReviewerAgent } from "../skills/agent-names.mjs";

let git: ReturnType<typeof gitFakeFixture>;
beforeEach(() => { git = gitFakeFixture(); });
afterEach(() => git.dispose());

const source = readFileSync(new URL("../skills/workflow-canonical.js", import.meta.url), "utf8") + "\n" +
  reviewSynthesisScript + reviewCursorScript + readFileSync(new URL("../skills/review/workflow.js", import.meta.url), "utf8");
interface Request {
  agent?: string; resume?: string; context?: string; skill?: string[];
  model?: string; async?: boolean; task: string; label: string; phase: string; output: string; outputMode: string; outputSchema: unknown;
}
interface Result {
  ok: boolean; runId?: string; error?: string; structuredOutput?: unknown;
  reused?: boolean;
  agent?: string; outputReference?: string; outputArtifactPath?: string;
  outputPathMapping?: { requestedPath: string; savedPath: string };
  artifactPaths?: string[]; results?: WorkflowScriptChildResult["results"];
  stopped?: boolean; state?: string; output?: string; metadataSaveError?: string; outputSaveError?: string;
}
interface Outcome {
  status: string; phase: string; memo?: string; error?: string;
  dispositions?: {
    findingId: string; decision: string; reason: string;
    classification: string; requirement: string | null;
  }[];
  references: { key: string; model: string; runId: string; stopped?: boolean; reused?: boolean; results?: { structuredOutputPath: string }[] }[];
  screening?: { verdict: string; reason: string; assessments: unknown[] };
}
const args = {
  workDescription: "Review record selection guards",
  brief: "Preserve the caller contract. No implementation.",
  target: { kind: "diff", reference: "candidate-17", material: "/owned/evidence/exact.patch" },
};
const angles = [
  { id: "a", focus: "Correctness and reachable callers", skills: ["blast-radius"] },
];
function keyModel(phase: string, output: string) {
  return phase === "review-independent" && output.endsWith("-r2.json")
    ? "openai-codex/gpt-6.1-sol:xhigh" : "anthropic/claude-opus-5-5:high";
}
const reviewKeys = ["director-prepare", "independent-evidence-contract-r1", "independent-evidence-contract-r2",
  "independent-a-r1", "independent-a-r2", "director-synthesis"];
const finding = {
  title: "PRIVATE_FINDING", location: "src/api.ts:12", scenario: "Caller passes an empty key",
  evidence: "Guard removed by the supplied patch", impact: "Wrong record selected",
  classification: "scoped-defect", requirement: "README.md: caller keys must select the matching record",
};
const disposition = {
  findingId: "a-r1-1", decision: "discard", reason: "Existing guard prevents the scenario",
  classification: finding.classification, requirement: finding.requirement,
};
function child(key: string, properties?: object): Result {
  let body: object;
  if (key === "director-prepare") body = { angles };
  else if (key.startsWith("independent-"))
    body = { coverage: "Inspected changed API and callers; no tests executed",
      findings: key === "independent-a-r1" ? [finding] : [] };
  else body = { memo: "No supported findings. Existing caller guard refutes the report. Tests unrun.",
    dispositions: [disposition] };
  return { ok: true, runId: `native-${key}`,
    structuredOutput: { status: "ready", reason: "Source evidence checked", ...body, ...properties } };
}
function packet(request: Request): any[] {
  return JSON.parse(request.task.split("ESSENTIAL ORIGINALS (data): ")[1]!.split("\n")[0]!);
}
function nativeOriginal(key: string, request: Request, result: Result): Result {
  if (!result.structuredOutput) return result;
  const value = result.structuredOutput;
  const savedOutputPath = join(originalsRoot, `${++originalNumber}.json`);
  writeFileSync(savedOutputPath, JSON.stringify(value));
  if (result.results?.some(entry => entry.savedOutputPath === "/native/mandatory/original.json"))
    return { ...result, structuredOutput: value, results: [{ ...result.results[0], savedOutputPath }] };
  return { ...result, structuredOutput: value,
    results: result.results ?? [{ savedOutputPath, outputReference: { path: savedOutputPath } } as any] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function fixture(
  respond: (key: string, request: Request) => Result | Promise<Result> = key => child(key),
  synchronousFailureKey?: string,
  storage?: { other?: string; failAt?: number; runtimeCutAt?: number; cut?: "before" | "after"; reuseStore?: boolean; framedSave?: boolean },
) {
  const calls: { key: string; request: Request }[] = [];
  const persisted = new Map<string, any>();
  const recovered = new Map<string, Result>();
  const fingerprints = new Map<string, string>();
  let replaying = false;
  let storeCut = storage?.cut;
  let saveCount = 0;
  const root = mkdtempSync(join(originalsRoot, "review-cwd-"));
  git.set(root, ["rev-parse", "--git-path", "info/exclude"], {stdout: ".git/info/exclude\n", stderr: "", status: 0});
  const missionFile = join(root, "mission.json");
  let workflowRunId = "workflow";
  let asyncDir = join(root, workflowRunId);
  mkdirSync(asyncDir);
  const mission = {id: "mission", cwd: root, runs: [{runId: workflowRunId, mode: "workflow", asyncDir}], workflowChildren: [] as any[]};
  writeFileSync(missionFile, JSON.stringify(mission));
  let emissions: unknown[] = [];
  let reusedFrom: string | undefined;
  const status = (stopCause?: string, state = stopCause ? "stopped" : "running") => writeFileSync(join(asyncDir, "status.json"), JSON.stringify({runId: workflowRunId,
    state, mode: "workflow", cwd: root,
    workflow: {resource: {name: "pitako.review", invocation: "named"}, emits: emissions, stopCause, reusedFrom,
      // Named resources inline the args in the resolved script; the native status has no argsDigest.
      scriptDigest: createHash("sha256").update(source).digest("hex")}}));
  const emit = (value: unknown) => { emissions.push(value); status(); };
  status();
  const journal = () => join(asyncDir, "workflow-children.jsonl");
  function witnessed(key: string, request: Request, result: Result): Result {
    result = {key, ...result} as Result;
    if (result.runId) {
      const fingerprint = createHash("sha256").update(workflowRunParamsFingerprint({...request})).digest("hex");
      mission.workflowChildren.push({workflowRunId, key, runId: result.runId,
        status: result.ok ? "completed" : result.stopped ? "stopped" : "failed", agent: request.agent ?? pitakoReviewerAgent(key) ?? "pitako.reviewer"});
      writeFileSync(missionFile, JSON.stringify(mission));
      appendFileSync(journal(), JSON.stringify({type: "start", key, fingerprint, runId: result.runId}) + "\n" +
        JSON.stringify({type: "settle", key, fingerprint, result}) + "\n");
    }
    return result;
  }
  const stateFile = join(missionFile.slice(0, -5), "state.json");
  mkdirSync(missionFile.slice(0, -5));
  writeFileSync(stateFile, JSON.stringify({ other: storage?.other ?? "" }));
  const state = { get: async (key: string) => persisted.has(key) ? persisted.get(key) : JSON.parse(readFileSync(stateFile, "utf8"))[key], set: (key: string, value: any) => {
    saveCount++;
    if (saveCount === storage?.failAt) throw new Error("Essential mission save denied after User Stop");
    if (saveCount === storage?.runtimeCutAt) {
      status("runtime-replaced");
      throw new Error("Runtime replaced before the cursor save");
    }
    const mission = JSON.parse(readFileSync(stateFile, "utf8"));
    mission[key] = value;
    const bytes = JSON.stringify(mission);
    if (Buffer.byteLength(bytes, "utf8") > 256 * 1024) throw new Error("Whole mission exceeds 256 KiB");
    writeFileSync(stateFile, bytes);
    persisted.set(key, JSON.parse(JSON.stringify(value)));
  } };
  const access = { missionPath: missionFile, namespace: "review" };
  let beforeVerify: ((key: string, request: Request) => void | Result) | undefined;
  const verifications: { key: string; request: any; output: any }[] = [];
  const writes: {key: string; task: string; outcome?: string}[] = [];
  const observations: string[] = [];
  const reusedChildren: string[] = [];
  const storeReceipts = new Map<string, { task: string; result: Result }>();
  let beforeStore: (() => void) | undefined;
  function dispatch(key: string, request: Request): Promise<Result> {
    if (request.agent === "pitako.review-store") return Promise.resolve().then(async () => {
      const input = JSON.parse(request.task);
      if (input.op === "observe-review") {
        observations.push(key);
        const observer = {workflowRunId, key, agent: request.agent, status: "running"};
        mission.workflowChildren.push(observer);
        writeFileSync(missionFile, JSON.stringify(mission));
        let output;
        try { output = observeReview(input, root); }
        catch (error) { output = {code: (error as {code?: string}).code ?? "review-integrity", error: String((error as Error).message)}; }
        observer.status = "completed";
        writeFileSync(missionFile, JSON.stringify(mission));
        return {ok: true, agent: request.agent, runId: `native-${key}`, output: JSON.stringify(output)};
      }
      const retained = storeReceipts.get(key);
      if (storage?.reuseStore && replaying && retained?.task === request.task)
        return {...retained.result, reused: true};
      const call = {key, task: request.task, outcome: undefined as string | undefined};
      writes.push(call);
      if (storeCut === "before") { storeCut = undefined; throw new Error("Cut before SQLite"); }
      beforeStore?.();
      let output;
      if (storage?.framedSave) {
        const child = Bun.spawn([process.execPath, "--preload", gitFakeBootstrap,
          new URL("../skills/review/store-io.mjs", import.meta.url).pathname], {
          cwd: root, stdin: Buffer.from(`<System instructions>\nFixed standalone review I/O.\n\n<Task>\n${request.task}`),
          stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]).finally(() => child.exited);
        if (child.exitCode !== 0) throw new Error(`store-io CLI exited with code ${child.exitCode}:\n${stderr}`);
        try { output = JSON.parse(stdout); }
        catch (error) { throw new Error(`store-io CLI emitted invalid JSON: ${error}\n${stderr}`); }
      } else {
        try { output = await saveReview(input, root); }
        catch (error) { output = {code: error instanceof StoreError ? error.code : "review-integrity", error: String((error as Error).message)}; }
      }
      call.outcome = output.outcome;
      const result = {ok: true, agent: request.agent, runId: `native-${key}`, output: JSON.stringify(output)};
      storeReceipts.set(key, {task: request.task, result});
      if (storeCut === "after") { storeCut = undefined; throw new Error("Cut after SQLite"); }
      return result;
    });
    // The real model-free verifier runs over the actual published temp files.
    if (request.agent === "pitako.originals-verifier") return Promise.resolve().then(() => {
      if (replaying && recovered.has(key)) return {...recovered.get(key)!, reused: true};
      const failure = beforeVerify?.(key, request);
      if (failure) return witnessed(key, request, {...failure, runId: failure.runId ?? `native-${key}`});
      const output = verifyGate(JSON.parse(request.task), root);
      verifications.push({ key, request: JSON.parse(request.task), output });
      const result = witnessed(key, request, {ok: true, agent: request.agent, runId: `native-${key}-${canonicalDigest(request.task).slice(0, 10)}`,
        output: JSON.stringify(output), results: [{exitCode: 0} as any]});
      if (JSON.parse(request.task).namespace.startsWith("review-")) recovered.set(key, result);
      return result;
    });
    const fingerprint = workflowRunParamsFingerprint({ ...request });
    if (replaying && recovered.get(key)?.ok && fingerprints.get(key) === fingerprint) {
      reusedChildren.push(key);
      return Promise.resolve({ ...recovered.get(key)!, reused: true });
    }
    expect(calls.some(call => call.key === key)).toBe(false);
    calls.push({ key, request });
    fingerprints.set(key, fingerprint);
    if (key === synchronousFailureKey) throw new Error("Synchronous dispatch rejection");
    return Promise.resolve().then(() => respond(key, request)).then(result => {
      const published = witnessed(key, request, nativeOriginal(key, request, result));
      recovered.set(key, published);
      return published;
    });
  }
  const runs = {
    // The native run boundary rejects terminal child failures without a runId.
    run(key: string, request: Request): Promise<Result> {
      return dispatch(key, request).then(result => {
        if (!result.ok) throw new Error(result.error ?? "Child failed");
        return result;
      });
    },
    // Config-form all collects terminal failures with their native identities.
    all(items: (Request & { key: string })[]): Promise<Result[]> {
      return Promise.all(items.map(({ key, ...request }) => dispatch(key, request)));
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...parameters: string[]
  ) => (input: unknown, runner: typeof runs, state: unknown, emit: (value: unknown) => void) => Promise<Outcome>;
  // Named-resource resolution inlines pitakoAccess; the raw source alone refuses to run.
  const bound = `const pitakoAccess = ${JSON.stringify(access)};\n`;
  return {
    root, get journal() { return journal(); }, writes, observations, reusedChildren, state, dispatch, bound, emit,
    set beforeStore(value: (() => void) | undefined) { beforeStore = value; },
    get beforeVerify() { return beforeVerify; },
    set beforeVerify(value: typeof beforeVerify) { beforeVerify = value; },
    calls, persisted, missionFile, stateFile, verifications, recovered, saves: () => saveCount,
    archived(scope = persisted.get("pitako-review")?.scopeId): any {
      return new PitakoStore(root).readRecords(`review:${scope}`).records[0]?.body;
    },
    reconcile: (newRoot = false) => {
      replaying = newRoot ? saveCount === storage?.runtimeCutAt : saveCount !== storage?.failAt;
      if (!newRoot) return;
      if (!replaying) status(undefined, "complete"); // A caught save denial is not an interrupted native root.
      reusedFrom = replaying ? workflowRunId : undefined;
      workflowRunId = "resumed-workflow";
      asyncDir = join(root, workflowRunId);
      mkdirSync(asyncDir);
      emissions = [];
      mission.runs.push({runId: workflowRunId, mode: "workflow", asyncDir});
      writeFileSync(missionFile, JSON.stringify(mission));
      status();
    },
    nextRoot: () => { replaying = false; calls.length = 0; storeReceipts.clear(); },
    execute: (input: unknown = args) => new AsyncFunction("args", "runs", "state", "emit", bound + source)(input, runs, state, emit),
    resolved: (script: string) => new AsyncFunction("unused", "runs", "state", "emit", script)(undefined, runs, state, emit),
    raw: (input: unknown = args) => new AsyncFunction("args", "runs", "state", "emit", source)(input, runs, state, emit),
    library: <T = Outcome>(input: unknown = args, options: object = {}, tail?: string) =>
      new AsyncFunction("args", "runs", "state", "emit", `${bound}const pitakoReviewLibraryMode = true;\n${source}\n${
        tail ?? `const options = ${JSON.stringify(options)};
          if (options.mode === "execute") {
            options.decisionReference ??= { stateKey: "root", loop: 1 };
            const root = await state.get(options.decisionReference.stateKey) ?? { loop: { number: options.decisionReference.loop } };
            options.enclosingLoop = root.loop;
            options.persist = () => state.set(options.decisionReference.stateKey, root);
          }
          return reviewPhase(args, runs, options);`
      }`)(input, runs, state, emit) as Promise<T>,
  };
}

describe("review scripted workflow", () => {
  test("a native host cut before the first settlement leaves a bounded cursor and resumes to a framed CLI save", async () => {
    const host = fixture(undefined, undefined, {framedSave: true});
    const script = host.bound + source;
    const controller = new AbortController();
    const interruptedCalls: string[] = [];
    await expect(runWorkflowScript({
      script, args, state: host.state, signal: controller.signal, onEmit: values => host.emit(values.at(-1)),
      launch: async key => {
        interruptedCalls.push(key);
        controller.abort(new Error("Host user Stop"));
        return {key, ok: false, error: "Host user Stop", artifactPaths: []} as any;
      },
      status: async () => { throw new Error("Unexpected status query"); },
    })).rejects.toThrow("Host user Stop");
    expect(interruptedCalls).toEqual(["director-prepare"]);
    expect(await host.state.get("pitako-review")).toMatchObject({terminal: null, slots: []});
    expect(host.writes).toEqual([]);
    const relaunched = await runWorkflowScript({
      script, args, state: host.state, onEmit: values => host.emit(values.at(-1)),
      launch: async (key, request) => ({key, output: "",
        ...await host.dispatch(key, request as unknown as Request)}) as any,
      status: async () => { throw new Error("Unexpected status query"); },
    });
    expect(relaunched.value, (relaunched.value as Outcome).error).toMatchObject({status: "completed", phase: "synthesis"});
    expect(host.calls.map(call => call.key)).toEqual(reviewKeys);
    expect(host.writes.map(call => call.outcome)).toEqual(["appended"]);
    expect(relaunched.value).toEqual(host.archived().result);
    expect((await host.state.get("pitako-review")).terminal.outcome).toBe("completed");
  });

  test("standalone native replay freezes models and synthesis params after save interruption", async () => {
    const host = fixture(undefined, undefined, {cut: "before"});
    const root = host.root;
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    mkdirSync(join(root, ".pi"));
    const file = join(root, ".pi/settings.json");
    const configured = { r1: "custom/first:high", r2: "other/second:xhigh", synthesis: "custom/director:low" };
    writeFileSync(file, JSON.stringify({ pitako: { review: configured } }));
    const resolve = (input = args) => analysisResource("pitako.review", root, agentDir).resolve({
      ...input, missionId: "mission", missionPath: host.missionFile,
    }).script;
    const script = resolve();
    expect(resolve({target: args.target, brief: args.brief, workDescription: args.workDescription})).toBe(script);
    const first = await host.resolved(script);
    expect(first.status).toBe("failed");
    expect(host.recovered.has("director-synthesis")).toBe(true);
    writeFileSync(file, JSON.stringify({ pitako: { review: { r1: "changed/model", r2: "changed/model", synthesis: "changed/model" } } }));
    expect(resolve({...args, brief: "A different identity"})).toContain('"model":"changed/model"');
    for (const { key, request } of host.calls)
      expect(request.model).toBe(key.startsWith("independent-") ? configured[key.endsWith("-r1") ? "r1" : "r2"] : configured.synthesis);
    host.reconcile();
    const replayScript = resolve();
    // Named-resource resume and reuseFrom reject different script digests.
    expect(createHash("sha256").update(replayScript).digest("hex"))
      .toBe(createHash("sha256").update(script).digest("hex"));
    const replay = await host.resolved(replayScript);
    expect(replay).toEqual(host.archived().result);
    expect(replay.status).toBe("completed");
    for (const ref of replay.references)
      expect(ref.model).toBe(ref.key.startsWith("independent-") ? configured[ref.key.endsWith("-r1") ? "r1" : "r2"] : configured.synthesis);
    expect(host.calls).toHaveLength(6);
    expect(host.persisted.get("pitako-review").models.r1.model).toBe(configured.r1);
    expect(host.writes.map(call => call.key)).toEqual(["store-review", "store-review"]);
    expect(host.writes[1]!.task).toBe(host.writes[0]!.task);
    expect(host.writes[1]!.outcome).toBe("appended");
    expect(resolve()).toContain('"model":"changed/model"'); // A terminal cursor does not freeze settings.
  });

  test.each(["before-intent", "before-write", "after-commit", "tampered"] as const)(
    "a failed unpublished original is never redispatched across %s", async seam => {
      const host = fixture(key => key === "independent-a-r1" ? {
        ...child(key, {coverage: "Complete unpublished analysis with a native save failure."}),
        ok: false, results: [], error: "Mandatory publication failed",
      } : child(key), undefined, {
        ...(seam === "before-intent" ? {failAt: 4} : {cut: seam === "after-commit" ? "after" : "before"}),
      });
      expect((await host.execute()).status).toBe("failed");
      const pending = host.persisted.get("pitako-review");
      expect(pending.phase).toBe(seam === "before-intent" ? "independent" : "save");
      expect(pending.terminal).toBeNull();
      expect(pending.slots[3]).toMatchObject({failed: true, runId: "native-independent-a-r1"});
      if (seam === "tampered") {
        const entries = readFileSync(host.journal, "utf8");
        writeFileSync(host.journal, entries.replace("Complete unpublished analysis", "Modified unpublished analysis"));
      }
      host.reconcile();
      const resumed = await host.execute();
      expect(host.calls.map(call => call.key)).toEqual(reviewKeys.slice(0, 5));
      expect(host.verifications).toHaveLength(0);
      expect(host.writes.map(call => call.key)).toEqual(Array(seam === "before-intent" ? 1 : 2).fill("store-review"));
      if (host.writes.length === 2) expect(host.writes[1]!.task).toBe(host.writes[0]!.task);
      if (seam === "tampered") {
        expect(resumed.error).toContain("Standalone review integrity failure");
        expect(host.writes.at(-1)!.outcome).toBeUndefined();
        expect(host.persisted.get("pitako-review")).toEqual(pending);
      } else {
        expect(resumed.status).toBe("blocked");
        expect(host.writes.at(-1)!.outcome).toBe(seam === "after-commit" ? "replay" : "appended");
        expect(host.archived().originals[3].failedOriginal.coverage).toBe("Complete unpublished analysis with a native save failure.");
        expect(new PitakoStore(host.root).readRecords(`review:${pending.scopeId}`).records).toHaveLength(1);
      }
    },
  );

  test("a superseded save writes nothing; a foreign terminal cursor is refused read-only on resolve", async () => {
    let second = false;
    const host = fixture(key => ({...child(key), runId: `native-${key}${second ? "-second" : ""}`}));
    expect(await host.execute()).toEqual(host.archived().result);
    const old = host.persisted.get("pitako-review");
    const oldRequest = JSON.parse(host.writes[0]!.task);
    second = true;
    host.calls.length = 0; // Simulate a distinct native root with its own key space.
    const newInput = {...args, brief: "A new admitted standalone review"};
    expect((await host.execute(newInput)).status).toBe("completed");
    const active = new PitakoStore(host.root).readActiveReview()!;
    expect(active.scope).not.toBe(`review:${old.scopeId}`);
    await expect(saveReview(oldRequest, host.root)).rejects.toMatchObject({code: "superseded"});
    host.state.set("pitako-review", old);
    const clobbered = readFileSync(host.stateFile, "utf8");
    const resolve = () => analysisResource("pitako.review", originalsRoot, host.root).resolve({
      ...newInput, missionId: "mission", missionPath: host.missionFile,
    });
    expect(resolve).toThrow(/Standalone review integrity failure: .* differs from the active fence/);
    expect(host.calls).toHaveLength(6); // No additional model dispatch on refusal.
    expect(host.writes).toHaveLength(2);
    expect(new PitakoStore(host.root).readActiveReview()).toEqual(active);
    expect(readFileSync(host.stateFile, "utf8")).toBe(clobbered);
  });

  test("a stale uncommitted cursor cannot reclaim the SQLite fence from its successor", async () => {
    let second = false;
    const host = fixture(key => ({...child(key), runId: `native-${key}${second ? "-second" : ""}`}), undefined, {cut: "before"});
    expect((await host.execute()).status).toBe("failed");
    const pending = host.persisted.get("pitako-review");
    const oldRequest = JSON.parse(host.writes[0]!.task);
    second = true;
    host.calls.length = 0;
    expect((await host.execute({...args, brief: "A different input takes ownership"})).status).toBe("completed");
    const active = new PitakoStore(host.root).readActiveReview()!;
    host.state.set("pitako-review", pending); // Stale root's cached cursor reaches disk.
    await expect(saveReview(oldRequest, host.root)).rejects.toMatchObject({code: "superseded"});
    const store = new PitakoStore(host.root);
    expect(store.readActiveReview()).toEqual(active);
    expect(store.readRecords(`review:${pending.scopeId}`).records).toHaveLength(0);
    expect(host.persisted.get("pitako-review")).toEqual(pending);
  });

  test.each(["replaced", "tampered original after loss", "missing from same store", "corrupt in same store"])(
    "pending save verifies receipt evidence when %s", async mode => {
    let second = false;
    const host = fixture(key => ({...child(key), runId: `native-${key}${second ? "-second" : ""}`}),
      undefined, {cut: "after", reuseStore: true, failAt: 7});
    let beforeVerifier: string;
    host.beforeVerify = () => { beforeVerifier = readFileSync(host.stateFile, "utf8"); };
    expect((await host.execute()).status).toBe("failed");
    const stored = new PitakoStore(host.root).readActiveReview()!;
    host.reconcile();
    expect(await host.execute()).toMatchObject({status: "failed", error: "Essential mission save denied after User Stop"});
    expect(host.writes.map(call => [call.key, call.outcome])).toEqual([
      ["store-review", "appended"], ["store-review.r1", "replay"],
    ]);
    const receipt = host.verifications[0]!.output.receipt!.store!;
    const quarantines = () => readdirSync(join(host.root, ".pi", "pitako")).filter(name => /^pitako\.db\.v[^-]+$/.test(name));
    const damaged = mode === "missing from same store" || mode === "corrupt in same store";
    if (damaged) {
      const db = openSqliteSync(new PitakoStore(host.root).file);
      try {
        db.prepare(mode === "missing from same store" ? "DELETE FROM records WHERE scope=? AND seq=?"
          : "UPDATE records SET body='null' WHERE scope=? AND seq=?").run(receipt.scope, receipt.seq);
      }
      finally { db.close(); }
    } else {
      rmSync(join(host.root, ".pi", "pitako"), {recursive: true});
      new PitakoStore(host.root).activate("arch:replacement");
      if (mode === "tampered original after loss")
        writeFileSync(host.verifications[0]!.request.items[0].path, "{}");
    }
    if (mode === "tampered original after loss") {
      await expect(saveReview(JSON.parse(host.writes[0]!.task), host.root)).rejects.toThrow(/access receipt differs/i);
      expect(host.verifications).toHaveLength(1);
      expect(host.calls.map(call => call.key)).toEqual(reviewKeys);
      expect(new PitakoStore(host.root).readRecords(receipt.scope).records).toHaveLength(0);
      return;
    }
    const pendingSave = readFileSync(host.stateFile, "utf8");
    const store = new PitakoStore(host.root), beforeObservation = store.readIdentity();
    try {
      // Observe the same native verifier settlement from just before its cursor save.
      writeFileSync(host.stateFile, beforeVerifier!);
      const observed = observeReview({op: "observe-review", missionPath: host.missionFile,
        cursor: JSON.parse(beforeVerifier!)["pitako-review"]}, host.root);
      expect(observed.settlements).toContainEqual(expect.objectContaining({key: "verify-synthesis",
        result: expect.objectContaining({output: JSON.stringify(host.verifications[0]!.output)})}));
      expect(quarantines()).toEqual([]);
      expect(store.readIdentity()).toEqual(beforeObservation);
    } finally {
      writeFileSync(host.stateFile, pendingSave);
    }
    expect((await host.execute()).status).toBe("completed");
    const replaced = new PitakoStore(host.root).readActiveReview()!;
    expect(replaced.scope).toBe(stored.scope);
    expect(replaced.identity.storeId).not.toBe(stored.identity.storeId);
    expect(replaced.head).toEqual(stored.head);
    expect(quarantines()).toHaveLength(damaged ? 1 : 0);
    expect(new PitakoStore(host.root).readRecords(receipt.scope).records).toHaveLength(0);
    expect(host.writes[2]).toEqual({key: "store-review.r2", task: host.writes[0]!.task, outcome: "appended"});
    expect(host.calls.map(call => call.key)).toEqual(reviewKeys);
    expect(host.verifications).toHaveLength(1);
    if (damaged) return;
    await expect(saveReview(JSON.parse(host.writes[0]!.task), originalsRoot)).rejects.toMatchObject({code: "wrong-cwd"});
    const database = join(host.root, ".pi", "pitako");
    rmSync(database, {recursive: true});
    const newInput = {...args, brief: "A new review after store loss"};
    const resolve = () => analysisResource("pitako.review", originalsRoot, host.root).resolve({
      ...newInput, missionId: "mission", missionPath: host.missionFile,
    }).script;
    const oldCursor = readFileSync(host.stateFile, "utf8");
    const script = resolve();
    expect(() => new PitakoStore(host.root).readActiveReview()).toThrow("Store does not exist");
    new PitakoStore(host.root).activate("arch:independent");
    expect(resolve()).toBe(script);
    expect(readFileSync(host.stateFile, "utf8")).toBe(oldCursor);
    second = true;
    host.nextRoot();
    expect((await host.resolved(script)).status).toBe("completed");
    expect(host.calls.map(call => call.key)).toEqual(reviewKeys);
    expect(host.observations).toEqual([]);
    expect(host.writes.at(-1)).toMatchObject({key: "store-review", outcome: "appended"});
    expect(new PitakoStore(host.root).readActiveReview()?.scope).not.toBe(stored.scope);
  });

  test("the unchanged library source is inert until called and validates standalone input inside the function", async () => {
    const host = fixture();
    expect(await host.library<{ status: string; references: never[] }>({ rootExecuteArgument: true }, {}, 'return { status: "root", references: [] };'))
      .toEqual({ status: "root", references: [] });
    expect(host.calls).toHaveLength(0);
    await expect(host.library({ rootExecuteArgument: true })).rejects.toThrow("Provide a review brief");
    expect(host.calls).toHaveLength(0);
    expect((await host.library<Outcome>()).status).toEqual((await fixture().execute()).status);
  });

  test("sequential library calls own their state and prefix every child key", async () => {
    const host = fixture(key => child(key.slice(key.indexOf(".") + 1)));
    const result = await host.library(args, {}, `
      return reviewPhase(args, runs, { prefix: "loop1." }).then(first =>
        reviewPhase(args, runs, { prefix: "loop2." }).then(second => ({ first, second })));
    `) as unknown as { first: Outcome; second: Outcome };
    for (const [prefix, outcome] of [["loop1.", result.first], ["loop2.", result.second]] as const) {
      expect(outcome.status).toBe("completed");
      expect(outcome.references).toHaveLength(6);
      expect(outcome.references.every(entry => entry.key.startsWith(prefix))).toBe(true);
    }
    expect(host.calls).toHaveLength(12);
  });

  test.each(["bad/prefix", "x".repeat(85), ""] as const)(
    "rejects a non-native or missing execute prefix before dispatch: %s", async prefix => {
      const host = fixture();
      await expect(host.library(args, { prefix, mode: "execute" })).rejects.toThrow("caller prefix");
      expect(host.calls).toHaveLength(0);
    },
  );

  test("maximum execute prefix and risk angle keep mirrored keys within the native limit", async () => {
    const prefix = `invoke-${"x".repeat(64)}.l100.review.`;
    const risk = { ...angles[0], id: `risk_${"r".repeat(24)}` };
    const host = fixture(key => {
      const local = key.slice(prefix.length);
      return child(local, local === "director-prepare" ? { angles: [risk] }
        : local === "director-synthesis" ? {
          dispositions: [],
          screening: { verdict: "clear", reason: "No findings", assessments: [] },
        } : {});
    });
    const result = await host.library(args, { prefix, mode: "execute" });
    expect(prefix).toHaveLength(84);
    expect(result.status).toBe("completed");
    expect(host.calls.map(call => call.key)).toEqual([
      "director-prepare", "independent-evidence-contract-r1", "independent-evidence-contract-r2",
      `independent-${risk.id}-r1`, `independent-${risk.id}-r2`, "director-synthesis",
    ].map(key => prefix + key));
    expect(host.calls[3]!.key).toHaveLength(128);
    expect(host.calls[3]!.request.agent).toBe("pitako.review-angle");
    for (const { key } of [...host.calls, ...host.verifications])
      expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  });

  test.each(["clear", "material-gaps", "blocked"])(
    "execute screening is reasoned independently of protocol completion: %s", async verdict => {
      const assessment = { findingId: "a-r1-1", requirement: finding.requirement,
        material: verdict === "material-gaps", consequence: "Caller may select a wrong record",
        reason: verdict === "material-gaps" ? "Reachable violation remains" : "Existing guard bounds the risk" };
      const screening = { verdict, reason: "Requirement and current caller evidence assessed", assessments: [assessment] };
      const host = fixture(key => child(key.slice("loop1.".length), key.endsWith("director-synthesis")
        ? { dispositions: [{ ...disposition, decision: "include" }], screening } : {}));
      const result = await host.library(args, { prefix: "loop1.", mode: "execute" });
      expect(result.status).toBe("completed");
      expect(result.screening).toEqual(screening);
      // Synthesis resumes preparation; all independent reviewers are fresh.
      expect(host.calls.some(call => call.request.resume)).toBe(true);
      const declared = parseFrontmatter(readFileSync(new URL("../agents/reviewer.md", import.meta.url), "utf8")).frontmatter.skills;
      for (const { request } of host.calls) {
        expect(request.skill).toEqual(expect.arrayContaining(declared as string[]));
        expect(request.skill).toContain("scope-discipline");
        expect(request.task).toContain("Read and apply scope-discipline");
        expect(request.task).toContain("Trace inherited demands");
      }
      expect(result.dispositions?.[0]?.decision).toBe("include");
      expect(host.calls.at(-1)?.request.task).toContain("Clear permits a separate whole-spec compliance analysis");
      expect(host.calls.at(-1)?.request.outputSchema).toMatchObject({
        required: expect.arrayContaining(["screening"]),
      });
    },
  );

  test.each(["clear", "material-gaps"])(
    "execute screening preserves rephrased requirements and its %s verdict", async verdict => {
      const screening = { verdict, reason: "Current requirement and consequence assessed", assessments: [{
        findingId: "a-r1-1", requirement: "README.md: selecting a record must respect the caller's key",
        material: verdict === "material-gaps", consequence: "Caller may select a wrong record",
        reason: verdict === "material-gaps" ? "Reachable violation remains" : "Existing guard bounds the risk",
      }] };
      const host = fixture(key => child(key.slice("loop1.".length), key.endsWith("director-synthesis")
        ? { dispositions: [{ ...disposition, decision: "include" }], screening } : {}));
      const result = await host.library(args, { prefix: "loop1.", mode: "execute" });
      expect(result.status).toBe("completed");
      expect(result.screening).toEqual(screening);
      expect(result.dispositions?.[0]?.requirement).toBe(finding.requirement);
    },
  );

  test.each([
    undefined,
    { verdict: "clear", reason: "No gaps", assessments: [] },
    { verdict: "clear", reason: "No gaps", assessments: [
      { findingId: "a-r1-1", material: true, reason: "Violation", requirement: finding.requirement, consequence: "Wrong record" },
    ] },
    { verdict: "material-gaps", reason: "Gaps", assessments: [
      { findingId: "a-r1-1", material: false, reason: "Bounded", requirement: finding.requirement, consequence: "Wrong record" },
    ] },
    { verdict: "material-gaps", reason: "Gaps", assessments: [
      { findingId: "a-r1-1", material: true, reason: "Violation", requirement: null, consequence: "Wrong record" },
    ] },
    { verdict: "clear", reason: "No gaps", assessments: [
      { findingId: "a-r1-1", material: false, reason: "Bounded", requirement: finding.requirement, consequence: "" },
    ] },
  ])("rejects absent, incomplete, or contradictory execute screening: %j", async screening => {
    const host = fixture(key => child(key.slice("loop1.".length),
      key.endsWith("director-synthesis")
        ? { dispositions: [{ ...disposition, decision: "include" }], screening } : {}));
    const result = await host.library(args, { prefix: "loop1.", mode: "execute" });
    expect(result.status).toBe("failed");
    expect(result.screening).toBeUndefined();
  });

  test.each([
    { ...disposition, decision: "discard" },
    { ...disposition, decision: "include", classification: "related-improvement" },
    { ...disposition, decision: "include", classification: "out-of-scope" },
    { ...disposition, decision: "uncertain", classification: "uncertain", requirement: null },
  ])("does not manufacture a material scoped gap from disposition %j", async finalDisposition => {
    const host = fixture(key => child(key.slice("loop1.".length),
      key.endsWith("director-synthesis") ? {
        dispositions: [finalDisposition],
        screening: { verdict: "material-gaps", reason: "Claimed gap", assessments: [{
          findingId: "a-r1-1", material: true, reason: "Claimed violation",
          requirement: finalDisposition.requirement, consequence: "Wrong record",
        }] },
      } : {}));
    const result = await host.library(args, { prefix: "loop1.", mode: "execute" });
    expect(result.status).toBe("failed");
    expect(result.screening).toBeUndefined();
    if (finalDisposition.decision === "discard" || ["out-of-scope", "related-improvement"].includes(finalDisposition.classification))
      expect(result.error).toContain("Execute screening contradicts dispositions or lacks consequences. a-r1-1");
    expect(host.calls.find(call => call.key.endsWith("director-synthesis"))!.request.task)
      .toContain("A discarded duplicate, out-of-scope or related-improvement finding is assessed material:false; the kept finding carries its consequence.");
  });

  test("retains exact native references without copying child reports or deriving paths", async () => {
    const pointers = {
      agent: "pitako.reviewer", outputReference: "/native/exact-output",
      outputArtifactPath: "/native/published/report.json",
      outputPathMapping: { requestedPath: "/requested/report.json", savedPath: "/native/published/report.json" },
      artifactPaths: ["/native/debug/a", "/native/debug/b"],
      results: [{ index: 0, agent: "pitako.reviewer", task: "Review target", exitCode: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
        savedOutputPath: "/native/mandatory/original.json", structuredOutputPath: "/native/optional/structured.json" }],
    };
    const host = fixture(key => ({ ...child(key), ...pointers }));
    const result = await host.library();
    expect(result.references[0]).toMatchObject({ key: "director-prepare", runId: "native-director-prepare",
      outputReference: pointers.outputReference, outputPathMapping: pointers.outputPathMapping,
      results: [{ savedOutputPath: expect.stringContaining(originalsRoot), structuredOutputPath: "/native/optional/structured.json" }] });
    expect(JSON.stringify(result)).not.toContain("structuredOutput\":");
  });

  test.each(["diff", "solution", "codebase", "issue", "plan"])("native sandbox mirrors fixed and risk angles for %s", async kind => {
    for (const library of [false, true]) {
      const calls: string[] = [], fixed = kind === "plan" ? "decision-fidelity" : "evidence-contract";
      const host = fixture();
      const result = await runWorkflowScript({
        script: library ? `${host.bound}const pitakoReviewLibraryMode = true;\n${source}\nreturn reviewPhase(args, runs);` : host.bound + source,
        args: { ...args, target: { ...args.target, kind } },
        state: host.state,
        launch: async (key, request) => {
          if (pitakoAgentFamily(request.agent) === "reviewer" || request.resume) calls.push(key);
          return { key, output: "", ...await host.dispatch(key, request as unknown as Request) } as any;
        },
        status: async () => { throw new Error("Unexpected status query"); },
      });
      expect(result.value).toMatchObject({ status: "completed", phase: "synthesis" });
      expect(calls).toEqual(["director-prepare", `independent-${fixed}-r1`, `independent-${fixed}-r2`,
        "independent-a-r1", "independent-a-r2", "director-synthesis"]);
    }
  });

  test("capacity exhaustion retains completed phases without replacement", async () => {
    const host = fixture(key => key === "director-synthesis"
      ? { ok: false, error: "Native spawn capacity exhausted" } : child(key));
    const result = await host.execute();
    expect(result.status).toBe("blocked");
    expect(result.phase).toBe("synthesis");
    expect(result.error).toContain("Native spawn capacity exhausted");
    expect(host.calls).toHaveLength(6);
    expect(result.references).toHaveLength(6);
  });

  test("a settled stopped child is incomplete and preserves Stop evidence after siblings settle", async () => {
    const waiting = deferred<Result>(), entered = deferred<void>();
    const host = fixture(key => {
      if (key === "independent-a-r1") return { ok: false, runId: "stopped-native", stopped: true, error: "User Stop" };
      if (key === "independent-a-r2") { entered.resolve(); return waiting.promise; }
      return child(key);
    });
    let finished = false;
    const work = host.library().then(result => { finished = true; return result; });
    let result: Outcome;
    try {
      await entered.promise;
      expect(finished).toBe(false);
    } finally {
      waiting.resolve(child("independent-a-r2"));
      result = await work;
    }
    expect(result.status).toBe("failed"); // A child's Stop does not certify invocation cancellation.
    expect(result.error).toContain("User Stop");
    expect(result.references).toContainEqual(expect.objectContaining({ key: "independent-a-r1", runId: "stopped-native", stopped: true, error: "User Stop" }));
    expect(host.calls).toHaveLength(5);
  });

  test("independent angles receive the same target, selected skills, and no peer conclusions", async () => {
    const host = fixture();
    const result = await host.execute();
    expect(result.status).toBe("completed");
    const independent = host.calls.filter(call => call.key.startsWith("independent-"));
    expect(independent).toHaveLength(4);
    // Hosts such as T3 display the agent name, so each review role has its own.
    expect(host.calls.find(call => call.key === "director-prepare")?.request.agent).toBe("pitako.review-director");
    for (const { request } of independent) {
      expect(request.agent).toBe("pitako.review-angle");
      expect(request.context).toBe("fresh");
      expect(request.task).toContain(JSON.stringify(args.target));
      expect(request.task).toContain(args.brief);
      expect(request.task).not.toContain("PRIVATE_FINDING");
    }
    expect(independent[2]!.request.skill).toEqual(["verify-behavior", "ponytail-review", "blast-radius"]);
    expect(independent[1]!.request.skill).toEqual(["verify-behavior", "ponytail-review"]);
    for (const { request } of host.calls) {
      expect(request).not.toHaveProperty("timeoutMs");
      expect(request.skill ?? []).not.toContain("scope-discipline");
      expect(request.task).not.toContain("Read and apply scope-discipline");
      expect(request.model).toBe(keyModel(request.phase, request.output));
      expect(request.async).toBeUndefined();
      expect(request.output).toBeString();
      expect(request.outputMode).toBe("file-only");
      expect(request.label).toContain(args.workDescription);
      expect(request.phase).toStartWith("review-");
      expect(request.task.split("\n")[0]).toBe(request.label);
      expect(request.outputSchema).toBeDefined();
    }
    expect(host.calls[0]!.request.skill).toEqual(["verify-behavior", "ponytail-review"]);
  });

  test("recovers a busy verifier across a cursor cut and synthesizes four independent originals using stable slot keys", async () => {
    const host = fixture(undefined, undefined, {runtimeCutAt: 4});
    const attempts: { key: string; task: string }[] = [];
    host.beforeVerify = (key, request) => {
      attempts.push({key, task: request.task});
      if (attempts.length < 3) return {ok: true, output: JSON.stringify({v: 1, code: "store-busy"})};
    };
    expect((await host.execute()).error).toContain("Runtime replaced before the cursor save");
    host.reconcile(true);
    const result = await host.execute();
    expect(result.status, result.error).toBe("completed");
    expect(host.observations).toEqual(["store-review.observe.r1"]);
    expect(attempts.map(attempt => attempt.key)).toEqual(["verify-synthesis", "verify-synthesis.r1", "verify-synthesis.r2"]);
    expect(new Set(attempts.map(attempt => attempt.task)).size).toBe(1);
    expect(host.calls.map(call => call.key)).toEqual(reviewKeys);
    const synthesis = host.calls.at(-1)!.request;
    expect(synthesis.resume).toBe("native-director-prepare");
    expect(packet(synthesis)).toHaveLength(4);
    expect(packet(synthesis).every(original => original.phase === "independent")).toBe(true);
    expect(result.dispositions).toEqual([disposition]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FINDING");
    expect(result.references).toHaveLength(6);
    expect(host.verifications.map(entry => entry.key)).toEqual(["verify-synthesis.r2"]);
    for (const ref of result.references)
      expect(ref.model).toBe(keyModel(ref.key.startsWith("independent-") ? "review-independent" : "", `${ref.key}.json`));
  });

  test("uses each exact configured slot model without changing replay keys", async () => {
    const models = {
      r1: { key: "pitako.review.r1", model: "provider/reviewer-one:high" },
      r2: { key: "pitako.review.r2", model: "provider/reviewer-two:xhigh" },
      synthesis: { key: "pitako.review.synthesis", model: "provider/director:high" },
    };
    const host = fixture();
    const result = await host.library(args, { models });
    expect(result.status).toBe("completed");
    expect(host.calls.map(call => call.key)).toEqual(reviewKeys);
    for (const { key, request } of host.calls) {
      const slot = key.startsWith("independent-") ? key.endsWith("-r1") ? "r1" : "r2" : "synthesis";
      expect(request.model).toBe(models[slot].model);
      expect(result.references.find(ref => ref.key === key)?.model).toBe(models[slot].model);
    }
  });

  test.each(["director-prepare", "independent-a-r2", "director-synthesis"])(
    "blocks a failing configured model at %s with its setting and native cause, never a fallback", async failedKey => {
      const models = {
        r1: { key: "pitako.review.r1", model: "provider/reviewer-one:high" },
        r2: { key: "pitako.review.r2", model: "provider/unknown:xhigh" },
        synthesis: { key: "pitako.review.synthesis", model: "provider/director:high" },
      };
      const nativeError = "Unknown subagent model in the active Pi model registry.";
      const host = fixture(key => key === failedKey ? { ok: false, error: nativeError } : child(key));
      const result = await host.library(args, { models });
      const slot = failedKey.startsWith("independent-") ? "r2" : "synthesis";
      expect(result.status).toBe("blocked");
      for (const part of [models[slot].key, models[slot].model, nativeError]) expect(result.error).toContain(part);
      expect(host.calls.map(call => call.key)).toEqual(
        failedKey === "director-prepare" ? reviewKeys.slice(0, 1)
          : failedKey === "director-synthesis" ? reviewKeys : reviewKeys.slice(0, 5));
      expect(host.calls.filter(call => call.key === failedKey)).toHaveLength(1);
      expect(host.calls.find(call => call.key === failedKey)?.request.model).toBe(models[slot].model);
    },
  );

  test("zero findings retains four independent reviews and synthesis", async () => {
    const host = fixture(key => child(key, key.startsWith("independent-") ? { findings: [] }
      : key === "director-synthesis" ? { dispositions: [] } : {}));
    expect((await host.execute()).status).toBe("completed");
    expect(host.calls.map(call => call.key)).toEqual(reviewKeys);
    expect(packet(host.calls.at(-1)!.request)).toHaveLength(4);
  });

  test("every finding receives an angle-slot-ordinal identity", async () => {
    const ids = ["evidence-contract-r1", "evidence-contract-r2", "a-r1", "a-r2"].flatMap(id => [`${id}-1`, `${id}-2`]);
    const host = fixture(key => child(key, key.startsWith("independent-") ? { findings: [finding, finding] }
      : key === "director-synthesis" ? { dispositions: ids.map(findingId => ({ ...disposition, findingId })) } : {}));
    const result = await host.execute();
    expect(result.status).toBe("completed");
    expect(result.dispositions?.map(entry => entry.findingId)).toEqual(ids);
  });

  test.each(["include", "uncertain", "discard"])("allows evidence-based %s without a vote", async decision => {
    const host = fixture(key => child(key, key === "director-synthesis"
      ? { memo: "Explicit source contradiction and evidence limits.",
        dispositions: [{ ...disposition, decision,
          classification: decision === "uncertain" ? "uncertain" : "scoped-defect",
          reason: "Director cites contrary source evidence" }] } : {}));
    expect((await host.execute()).dispositions?.[0]?.decision).toBe(decision);
  });

  test("closure review preserves scope distinctions without turning supported suggestions into repair authority", async () => {
    const classifications = ["scoped-defect", "related-improvement", "out-of-scope", "uncertain"];
    const findings = classifications.map(classification => ({
      ...finding, classification,
      requirement: classification === "scoped-defect" ? finding.requirement : null,
    }));
    const dispositions = findings.map((entry, index) => ({
      ...disposition, findingId: `a-r1-${index + 1}`, classification: entry.classification,
      requirement: entry.requirement, decision: entry.classification === "uncertain" ? "uncertain" : "include",
    }));
    const input = { ...args, brief: `${args.brief}
Closure review of candidate-16 against candidate-17: close admitted finding a-r1-1.
Prior report and correction delta: /owned/evidence/closure.txt. Retain unaffected coverage.` };
    const host = fixture(key => child(key,
      key === "independent-a-r1" ? { findings }
        : key === "director-synthesis" ? { dispositions, memo: "Scoped defect and recommendations kept separate." }
              : {}));
    const result = await host.execute(input);
    expect(result.status).toBe("completed");
    expect(result.dispositions).toEqual(dispositions);
    for (const { request } of host.calls.filter(call => !call.request.resume)) {
      expect(request.task).toContain(input.brief);
      expect(request.task).toContain(JSON.stringify(input.target));
    }
    for (const { request } of host.calls) {
      expect(request.task).toContain("Honor the agreed review boundary");
      expect(request.task).toContain("not reopening an audit by default");
      expect(request.task).toContain("correction delta, admitted findings, and affected guarantees");
      expect(request.task).toContain("keep other new observations non-blocking");
      expect(request.task).toContain("the caller admits work");
      expect(request.task).toContain("name its distinct guarantee");
      expect(request.task).not.toContain("Inspect the complete target independently");
    }
    for (const key of ["independent-a-r1", "director-synthesis"]) {
      const schema = host.calls.find(call => call.key === key)!.request.outputSchema;
      const collection = key === "independent-a-r1" ? "findings" : "dispositions";
      expect(schema).toMatchObject({
        properties: {
          [collection]: {
            items: {
              required: expect.arrayContaining(["classification", "requirement"]),
              properties: {
                classification: { enum: classifications },
                requirement: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
              },
            },
          },
        },
      });
    }
  });

  test("settles all independent siblings before reporting failure", async () => {
    const waiting = deferred<Result>(), entered = deferred<void>();
    const host = fixture(key => {
      if (key === "independent-a-r1") throw new Error("Controlled failure");
      if (key === "independent-a-r2") { entered.resolve(); return waiting.promise; }
      return child(key);
    });
    let finished = false;
    const execution = host.execute().then(result => { finished = true; return result; });
    await entered.promise;
    try { expect(finished).toBe(false); }
    finally { waiting.resolve(child("independent-a-r2")); }
    const result = await execution;
    expect(result.status).toBe("blocked");
    expect(result.phase).toBe("independent");
    expect(result.references).toContainEqual(expect.objectContaining({ key: "independent-a-r2", runId: "native-independent-a-r2" }));
    expect(host.calls.some(call => call.key === "director-synthesis")).toBe(false);
  });

  test.each(["director-prepare", "independent-a-r2", "director-synthesis"])(
    "preserves a blocked outcome at %s rather than claiming review completion", async key => {
      const host = fixture(current => child(current, current === key
        ? { status: "blocked", reason: "Exact artifact unavailable" } : {}));
      const result = await host.execute();
      expect(result.status).toBe("blocked");
      expect(result.error).toContain("Exact artifact unavailable");
      expect(result.memo).toBeUndefined();
      expect(host.calls.filter(call => call.key === key)).toHaveLength(1);
      const calls = host.calls.length;
      const retainedBytes = readFileSync(host.stateFile, "utf8");
      const relaunch = await host.execute();
      expect(relaunch.status).toBe("blocked");
      expect(relaunch.error).toContain("already terminal");
      expect(host.calls).toHaveLength(calls);
      expect(readFileSync(host.stateFile, "utf8")).toBe(retainedBytes);
    },
  );

  test("also settles siblings when dispatch throws synchronously", async () => {
    const waiting = deferred<Result>(), entered = deferred<void>();
    const host = fixture(key => {
      if (key === "independent-a-r2") { entered.resolve(); return waiting.promise; }
      return child(key);
    }, "independent-a-r1");
    let finished = false;
    const execution = host.execute().then(result => { finished = true; return result; });
    await entered.promise;
    let result: Outcome;
    try {
      expect(finished).toBe(false);
    } finally {
      waiting.resolve(child("independent-a-r2"));
      result = await execution;
    }
    expect(result.status).toBe("blocked");
    expect(host.calls).toHaveLength(5);
    expect(result.references).not.toContainEqual(expect.objectContaining({ key: "independent-a-r1" }));
  });

  test.each(["director-prepare", "director-synthesis"])(
    "reports a director dispatch rejection at %s without inventing a reference", async key => {
      const host = fixture(current => child(current), key);
      const result = await host.execute();
      expect(result.status).toBe("blocked");
      expect(result.error).toContain("Synchronous dispatch rejection");
      expect(result.references).not.toContainEqual(expect.objectContaining({ key }));
      expect(host.calls.filter(call => call.key === key)).toHaveLength(1);
    },
  );

  test.each([
    ["director-synthesis", { dispositions: [] }],
    ["director-synthesis", { dispositions: [disposition, disposition] }],
    ["director-synthesis", { dispositions: [{ ...disposition, findingId: "invented" }] }],
  ] as const)("rejects incomplete, duplicate, or invented finding accounting at %s", async (key, properties) => {
    const host = fixture(current => child(current, current === key ? properties : {}));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("finding dispositions");
    expect(result.memo).toBeUndefined();
    const calls = host.calls.length;
    const retainedBytes = readFileSync(host.stateFile, "utf8");
    const relaunch = await host.execute();
    expect(relaunch.status).toBe("blocked");
    expect(relaunch.error).toContain("already terminal");
    expect(host.calls).toHaveLength(calls);
    expect(readFileSync(host.stateFile, "utf8")).toBe(retainedBytes);
  });

  test.each([
    { angles: [] }, { angles: [{ ...angles[0], id: "evidence-contract" }] }, { angles: [angles[0], angles[0]] },
    { angles: [...angles, ...angles, angles[0]] },
    { angles: [{ ...angles[0], skills: ["execute"] }] },
    { angles: [{ ...angles[0], id: "../escape" }] },
    { angles: [{ ...angles[0], id: "r".repeat(30) }] },
  ])("refuses invalid director rosters before launching reviewers: %j", async properties => {
    const host = fixture(key => child(key, properties));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(host.calls).toHaveLength(1);
    const retainedBytes = readFileSync(host.stateFile, "utf8");
    const relaunch = await host.execute();
    expect(relaunch.status).toBe("blocked");
    expect(relaunch.error).toContain("already terminal");
    expect(host.calls).toHaveLength(1);
    expect(readFileSync(host.stateFile, "utf8")).toBe(retainedBytes);
  });

  test("rejects a plan risk angle that duplicates decision-fidelity", async () => {
    const host = fixture(key => child(key, { angles: [{ ...angles[0], id: "decision-fidelity" }] }));
    const result = await host.execute({ ...args, target: { ...args.target, kind: "plan" } });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("distinct from the fixed angle");
    expect(host.calls).toHaveLength(1);
  });

  test("incomplete supplied model slots cannot silently use native defaults", async () => {
    const host = fixture();
    await expect(host.library(args, { models: { r1: { key: "pitako.review.r1" } } }))
      .rejects.toThrow("requires its settings key and exact model string");
    expect(host.calls).toHaveLength(0);
  });

  test("does not treat process success as an adequate review", async () => {
    const inadequate = fixture(key => key === "independent-a-r1"
      ? { ok: true, runId: "native-empty", structuredOutput: { status: "ready" } } : child(key));
    expect((await inadequate.execute()).status).toBe("failed");
  });

  test.each(["director-prepare", "independent-a-r1", "director-synthesis"])(
    "retains a child's bounded setup failure and run reference at %s", async key => {
      const cause = "Setup failed after automatic recovery. Original error: controlled stale context";
      const host = fixture(current => current === key
        ? { ok: false, runId: `failed-${key}`, error: cause } : child(current));
      const result = await host.execute();
      expect(result.status).toBe("blocked");
      expect(result.error).toContain(cause);
      expect(result.memo).toBeUndefined();
      expect(result.references).toContainEqual(expect.objectContaining({ key, runId: `failed-${key}`, error: cause }));
      expect(host.calls.filter(call => call.key === key)).toHaveLength(1);
    },
  );

  test("retains a terminal failed child's identity while joining its unfinished sibling", async () => {
    const waiting = deferred<Result>(), entered = deferred<void>();
    const host = fixture(key => {
      if (key === "independent-a-r1")
        return { ok: false, runId: "failed-independent-a-r1", error: "Terminal child failure" };
      if (key === "independent-a-r2") { entered.resolve(); return waiting.promise; }
      return child(key);
    });
    let finished = false;
    const execution = host.execute().then(result => { finished = true; return result; });
    await entered.promise;
    let result: Outcome;
    try {
      expect(finished).toBe(false);
    } finally {
      waiting.resolve(child("independent-a-r2"));
      result = await execution;
    }
    expect(result.status).toBe("blocked");
    expect(result.phase).toBe("independent");
    expect(result.error).toContain("Terminal child failure");
    expect(result.references).toMatchObject([
      { key: "director-prepare", runId: "native-director-prepare" },
      { key: "independent-evidence-contract-r1", runId: "native-independent-evidence-contract-r1" },
      { key: "independent-evidence-contract-r2", runId: "native-independent-evidence-contract-r2" },
      { key: "independent-a-r1", runId: "failed-independent-a-r1" },
      { key: "independent-a-r2", runId: "native-independent-a-r2" },
    ]);
    expect(host.calls.map(call => call.key)).toEqual([
      ...reviewKeys.slice(0, 5),
    ]);
  });

  test("bounds long child diagnostics without losing their cause", async () => {
    const host = fixture(key => key === "director-synthesis"
      ? { ok: false, error: `Resume unavailable: ${"x".repeat(5000)}` } : child(key));
    const result = await host.execute();
    expect(result.status).toBe("blocked");
    expect(result.error).toContain("Resume unavailable:");
    expect(result.error!.length).toBeLessThanOrEqual(1200);
  });

  test.each([
    ["independent-a-r1", { findings: [{ ...finding, evidence: "" }] }],
    ["independent-a-r1", { findings: [{ ...finding, classification: "blocking" }] }],
    ["independent-a-r1", { findings: [{ ...finding, requirement: null }] }],
    ["independent-a-r1", { findings: [{ ...finding, requirement: undefined }] }],
    ["independent-a-r1", { findings: null }],
    ["independent-a-r1", { coverage: "" }],
    ["director-synthesis", { memo: "" }],
    ["director-synthesis", { dispositions: [{ ...disposition, classification: "blocking" }] }],
    ["director-synthesis", { dispositions: [{ ...disposition, requirement: null }] }],
    ["director-synthesis", { dispositions: [{ ...disposition, requirement: undefined }] }],
    ["director-synthesis", { dispositions: [{ ...disposition, classification: "uncertain", decision: "include" }] }],
  ] as const)("rejects inadequate report evidence at %s", async (key, properties) => {
    const host = fixture(current => child(current, current === key ? properties : {}));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(result.memo).toBeUndefined();
    // The synthesis contract states every rule its validator enforces.
    if (key === "director-synthesis") expect(host.calls.find(call => call.key === key)!.request.task)
      .toContain("A disposition classified uncertain must use decision uncertain, never include.");
  });

  test.each([
    {}, { ...args, workDescription: undefined }, { ...args, workDescription: "Title\nGeneric rules" },
    { ...args, brief: "" }, { ...args, target: null },
    { ...args, target: { ...args.target, material: "" } },
    { ...args, target: { ...args.target, kind: "unknown" } },
    { ...args, continuation: {} }, { ...args, maxRounds: 5 },
    { ...args, model: "hardcoded/model" },
  ])("rejects invalid or unsupported input before dispatch: %j", async input => {
    const host = fixture();
    await expect(host.execute(input)).rejects.toThrow();
    expect(host.calls).toHaveLength(0);
  });

  test("long descriptions keep the angle before the work title", async () => {
    const workDescription = "Review selection " + "with complete caller context ".repeat(12);
    const host = fixture();
    expect((await host.execute({ ...args, workDescription })).status).toBe("completed");
    for (const { request } of host.calls) {
      expect(request.label).toEndWith(workDescription.trim());
      expect(request.task.split("\n")[0]).toBe(request.label);
    }
    expect(host.calls[3]!.request.label).toStartWith(`Independent review — ${angles[0]!.focus}: `);
  });

  test("current target, publication originals and access survive every fresh/resumed handoff without duplicate findings", async () => {
    const host = fixture(key => child(key, key === "independent-a-r2"
      ? { coverage: "CONTRARY_NON_FINDING: verified fallback; uncertainty remains" } : {}));
    const outcome = await host.execute();
    expect(outcome.status).toBe("completed");
    for (const { key, request } of host.calls) {
      expect(request.task.split("\n")[0]).toBe(request.label);
      expect(request.label).toContain(args.workDescription);
      expect(request.task).toContain(args.brief);
      expect(request.task).toContain(JSON.stringify(args.target));
      expect(request.phase).toStartWith("review-");
      if (packet(request).length === 0) expect(request.task).not.toContain(finding.title);
      for (const original of packet(request)) {
        const exact = JSON.parse(readFileSync(original.results[0].savedOutputPath, "utf8"));
        expect(canonicalDigest(exact)).toBe(original.digest);
        expect(original).not.toHaveProperty("value");
        expect(original.association.key).toBe(original.key);
        expect(original.association.phase).toBe(original.phase);
        if (original.key === "independent-a-r1") {
          expect(JSON.stringify(exact).split(finding.title)).toHaveLength(2);
          expect(JSON.parse(readFileSync(original.results[0].savedOutputPath, "utf8")).findings).toEqual([finding]);
        }
        if (key === "director-synthesis" && original.key === "independent-a-r2")
          expect(exact.coverage).toContain("CONTRARY_NON_FINDING");
      }
    }
    const manifest = host.archived();
    const cursor = host.persisted.get("pitako-review");
    expect(manifest.originals.map((item: any) => item.runId)).toEqual(host.calls.map(call => `native-${call.key}`));
    expect(manifest.originals.find((item: any) => item.key === "independent-a-r2").runId).toBe("native-independent-a-r2");
    expect(manifest.originals.every((item: any) => item.publication === "published" && !item.failedOriginal)).toBe(true);
    expect(manifest.originals[0].results[0].outputReference).toEqual({ path: manifest.originals[0].results[0].savedOutputPath });
    const retainedBytes = readFileSync(host.stateFile, "utf8");
    const sameArgs = await host.execute();
    expect(sameArgs.status).toBe("blocked");
    expect(sameArgs.error).toContain("already terminal");
    expect(host.calls).toHaveLength(6);
    expect(host.persisted.get("pitako-review")).toEqual(cursor);
    expect(readFileSync(host.stateFile, "utf8")).toBe(retainedBytes);
    const synthesis = host.calls.find(call => call.key === "director-synthesis")!.request;
    expect(synthesis.task).not.toContain("When rejecting a claim");
  });

  test.each(["mandatory", "optional"])("distinguishes %s publication failure without generic-reference proof", async kind => {
    const host = fixture(key => key === "director-prepare" ? {
      ...child(key), outputReference: "/generic/not-publication", outputArtifactPath: "/debug/not-publication",
      ...(kind === "mandatory" ? { results: [{ structuredOutputPath: "/optional/structured.json" } as any] }
        : { metadataSaveError: "Optional diagnostic save failed" }),
    } : child(key));
    const result = await host.execute();
    expect(result.status).toBe(kind === "mandatory" ? "failed" : "completed");
    const original = host.archived().originals[0];
    expect(original.publication).toBe(kind === "mandatory" ? "unpublished" : "published");
    expect(original.sufficient).toBe(kind === "optional");
    if (kind === "mandatory") {
      expect(result.error).toContain("Mandatory native publication");
      expect(host.calls).toHaveLength(1);
    } else expect(original.observability).toBe("failed");
  });

  test.each(["ready", "blocked"])("retains exactly one complete delivered failed %s original, never published or sufficient", async status => {
    const host = fixture((key, request) => {
      if (key !== "independent-a-r1") return child(key);
      const result = nativeOriginal(key, request, { ...child(key, { status, reason: "Partial analysis: contrary evidence remains" }),
        ok: false, results: [], error: "Mandatory output save failed" });
      return { ...result, error: `Mandatory output save failed\n\nOutput:\n${JSON.stringify(result.structuredOutput, null, 2)}` };
    });
    const result = await host.execute();
    expect(result.status).toBe("blocked");
    const manifest = host.archived();
    const original = manifest.originals.find((item: any) => item.key === "independent-a-r1");
    expect(original).toMatchObject({ delivery: "complete", publication: "unpublished", sufficient: false, terminal: "failed" });
    expect(original.failedOriginal.status).toBe(status);
    expect(original.failedOriginal.findings).toEqual([finding]);
    expect(original.diagnostic).toContain("Mandatory output save failed");
    expect(JSON.stringify(manifest).split(finding.title)).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(finding.title);
    expect(host.calls).toHaveLength(5);
  });

  test.each(["rejection", "missing", "unknown", "wrong-association", "text"])("does not retain an undemonstrated failed original: %s", async delivery => {
    const host = fixture((key, request) => {
      if (key !== "independent-a-r1") return child(key);
      if (delivery === "rejection") throw new Error("Rejected without object");
      if (delivery === "missing") return { ok: false, runId: "missing", error: "No original delivered" };
      if (delivery === "text") return { ok: false, runId: "text", output: JSON.stringify(child(key).structuredOutput), error: "Unproved text route" };
      return { ...child(key, delivery === "unknown" ? { delivery: "unknown" }
        : { association: { query: "wrong" } }), ok: false, results: [], error: "Save failed" };
    });
    const result = await host.execute();
    expect(result.status).toBe("blocked");
    const originals = host.archived().originals;
    expect(originals.every((item: any) => !item.failedOriginal)).toBe(true);
    const original = originals.find((item: any) => item.key === "independent-a-r1");
    if (delivery !== "rejection") expect(original.delivery).toBe(["missing", "text"].includes(delivery) ? "not-delivered" : "unproved");
    expect(host.calls).toHaveLength(5);
  });

  test("schemas and prompts request decisions only; envelopes are workflow-owned", async () => {
    const host = fixture();
    expect((await host.execute()).status).toBe("completed");
    for (const { request } of host.calls) {
      const schema = request.outputSchema as any;
      for (const field of ["association", "delivery", "access"])
        expect(schema.properties).not.toHaveProperty(field);
      expect(request.task).not.toContain("ORIGINAL CONTRACT");
      expect(request.task).not.toContain("receipt");
      for (const original of packet(request)) {
        expect(original).toMatchObject({ id: expect.any(String), association: { key: original.key },
          delivery: "complete", publication: "published", digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(original).not.toHaveProperty("access");
      }
    }
    expect(packet(host.calls[0]!.request)).toEqual([]);
    expect(packet(host.calls[1]!.request)).toEqual([]);
    expect(host.persisted.get("pitako-review").version).toBe(10);
  });

  test.each(["context", "inline"])("%s cannot replace native publication", async source => {
    const host = fixture(key => key === "independent-a-r1"
      ? { ...child(key, { coverage: `Complete ${source} analysis available` }), results: [] } : child(key));
    expect((await host.execute()).status).toBe("failed");
    expect(host.calls.map(call => call.key)).toEqual(reviewKeys.slice(0, 5));
    expect(host.archived().originals[3]).toMatchObject({
      publication: "unpublished", sufficient: false, failedOriginal: { coverage: `Complete ${source} analysis available` },
    });
  });

  test("an invalid review cursor blocks before dispatch", async () => {
    const host = fixture();
    host.persisted.set("pitako-review", {version: 1, originals: []});
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Invalid standalone review cursor");
    expect(host.calls).toEqual([]);
    expect(host.saves()).toBe(0);
  });

  test("old integrated review state cannot be superseded or reconciled", async () => {
    const host = fixture();
    host.persisted.set("root", { loop: { number: 2, integratedReview: {
      version: 1, decision: { reference: { stateKey: "root", loop: 1 } },
    } } });
    const result = await host.library(args, { prefix: "loop2.", mode: "execute",
      decisionReference: { stateKey: "root", loop: 2 } });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("incompatible Pitako contract v1");
    expect(host.calls).toEqual([]);
    expect(host.saves()).toBe(0);
  });

  test.each(["missing", "changed"])("an original %s before synthesis blocks dispatch", async fault => {
    const host = fixture();
    host.beforeVerify = () => {
      const original = host.recovered.get("independent-a-r1")!;
      const file = original.results![0]!.savedOutputPath!;
      if (fault === "missing") unlinkSync(file);
      else writeFileSync(file, JSON.stringify({ changed: true }));
    };
    const result = await host.execute();
    expect(result.status).toBe("blocked");
    expect(result.error).toContain(fault === "missing" ? "missing-file" : "content-differs");
    expect(result.error).not.toMatch(/new mission|new consultation|decide which version/i);
    expect(host.calls.some(call => call.key === "director-synthesis")).toBe(false);
  });

  test("a raw script path refuses to run; only the named resource binds receipts to a mission", async () => {
    const host = fixture();
    await expect(host.raw()).rejects.toThrow("Launch pitako.review by name after mission.create");
    expect(host.calls).toEqual([]);
  });

  test("gates with no required originals dispatch no verifier; verified gates retain only receipt path and digest", async () => {
    const host = fixture();
    expect((await host.execute()).status).toBe("completed");
    expect(host.verifications.map(entry => entry.key)).toEqual(["verify-synthesis"]);
    expect(host.verifications.every(entry => entry.output.items.every((item: any) => item.state === "accessible"))).toBe(true);
    const receipts = host.archived().receipts;
    expect(receipts.map((entry: any) => Object.keys(entry).sort())).toEqual(Array(1).fill(["accessible", "digest", "gate"]));
    expect(receipts.every((entry: any) => entry.accessible)).toBe(true);
    expect(host.verifications[0].output.receipt.store).toMatchObject({ scope: `access:review-${host.persisted.get("pitako-review").scopeId}`, seq: 1 });
    expect(receipts[0].digest).toBe(host.verifications[0].output.receipt.digest);
  });

  test("the UTF-8 failed original is archived without consuming mission state capacity", async () => {
    const host = fixture(key => key === "independent-a-r1" ? { ...child(key, {
      status: "blocked", reason: "Partial but complete original", coverage: "é".repeat(8000),
    }), ok: false, results: [], error: "Output save failed" } : child(key), undefined, { other: "é".repeat(122000) });
    const result = await host.execute() as Outcome & { persistence?: string; lastConfirmed?: any };
    expect(result.status).toBe("blocked");
    expect(host.calls.map(call => call.key)).toEqual(reviewKeys.slice(0, 5));
    const persisted = JSON.parse(readFileSync(host.stateFile, "utf8"));
    expect(Object.keys(persisted).sort()).toEqual(["other", "pitako-review"]);
    expect(persisted["pitako-review"].slots).toHaveLength(5);
    expect(host.archived().originals[3].failedOriginal.coverage).toBe("é".repeat(8000));
  });

  test("essential save failure stops new dispatch and retains original Stop diagnostic and confirmed state", async () => {
    const host = fixture(undefined, undefined, { failAt: 2 });
    const result = await host.execute() as Outcome & { lastConfirmed?: any };
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Essential mission save denied after User Stop");
    expect(host.calls).toHaveLength(1);
    expect(host.saves()).toBe(2);
    expect(result.lastConfirmed.slots).toEqual([]);
  });


  test("manifest ordering follows dispatch rather than asynchronous sibling completion", async () => {
    const a = deferred<Result>(), bEntered = deferred<void>();
    const host = fixture(key => {
      if (key === "independent-a-r1") return a.promise;
      if (key === "independent-a-r2") { bEntered.resolve(); return child(key); }
      return child(key);
    });
    const work = host.execute();
    try { await bEntered.promise; } finally { a.resolve(child("independent-a-r1")); await work; }
    expect(host.archived().originals.slice(0, 5).map((item: any) => item.key))
      .toEqual(reviewKeys.slice(0, 5));
  });

  test("published schema-valid but semantically invalid dispositions are not sufficient in durable state", async () => {
    const host = fixture(key => child(key, key === "director-synthesis" ? { dispositions: [] } : {}));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    const original = host.archived().originals.at(-1);
    expect(original).toMatchObject({ publication: "published", delivery: "complete", sufficient: false });
    expect(original.diagnostic).toContain("finding dispositions");
    expect(original.failedOriginal).toBeUndefined();
  });

  test.each(["save-error", "nonterminal", "producer", "stop"])("native %s cannot establish a sufficient original", async fault => {
    const host = fixture(key => key === "director-prepare" ? { ...child(key),
      ...(fault === "save-error" ? { results: [{ savedOutputPath: "/returned/but/save/failed", outputSaveError: "Required save denied" } as any] }
        : fault === "nonterminal" ? { state: "running" } : fault === "stop" ? { stopped: true } : { agent: "wrong-producer" }),
    } : child(key));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    const original = host.archived().originals[0];
    expect(original.sufficient).toBe(false);
    if (fault === "save-error") expect(original.publication).toBe("unpublished");
    if (fault === "nonterminal") expect(original.terminal).toBe("unconfirmed");
    if (fault === "producer") expect(original.delivery).toBe("unproved");
    expect(host.calls).toHaveLength(1);
  });


  test.each(["key", "workflowKey", "agent", "runId"])("rejects contradictory nested native %s without model identity echoes", async field => {
    for (const published of [true, false]) {
      const host = fixture(key => key === "director-prepare" ? { ...child(key),
        results: [{ [field]: "different-producer", ...(published ? { savedOutputPath: "/native/mandatory/original.json" } : {}) } as any],
      } : child(key));
      const result = await host.execute();
      expect(result.status).toBe("failed");
      expect(result.error).toContain("identity conflicts");
      expect(host.calls).toHaveLength(1);
      const original = host.archived().originals[0];
      expect(original).toMatchObject({ delivery: "unproved", sufficient: false });
      expect(original.failedOriginal).toBeUndefined();
      expect(original.results[0][field]).toBe("different-producer");
    }
  });

  test.each(["key", "workflowKey", "agent"])("rejects contradictory top-level native %s without false preservation", async field => {
    const host = fixture(key => key === "director-prepare" ? { ...child(key), [field]: "different-producer", results: [] } : child(key));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("identity conflicts");
    const original = host.archived().originals[0];
    expect(original).toMatchObject({ delivery: "unproved", sufficient: false });
    expect(original.failedOriginal).toBeUndefined();
    expect(host.calls).toHaveLength(1);
  });

  test.each([
    { state: "failed" }, { state: "cancelled" }, { state: "running" },
    { terminalOutcome: { state: "partial", reason: "timeout" } }, { terminalOutcome: { state: "partial", reason: "budget_exhausted" } },
    { stopped: true }, { interrupted: true }, { detached: true }, { recovery: { reason: "Pending recovery" } },
    { acceptance: { recovery: { reason: "Pending acceptance recovery" } } }, { toolBudgetBlocked: true },
    { exitCode: 1 }, { timedOut: true },
  ])("native terminal/control receipt %j overrides ok=true at either level", async receipt => {
    for (const nested of [false, true]) {
      const host = fixture(key => key === "director-prepare" ? { ...child(key),
        ...(nested ? { results: [{ savedOutputPath: "/native/mandatory/original.json", ...receipt } as any] } : receipt),
      } : child(key));
      const result = await host.execute();
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Native child control/terminal failure");
      const original = host.archived().originals[0];
      expect(original.sufficient).toBe(false);
      expect(original.terminal).not.toBe("succeeded");
      expect(original.failedOriginal).toBeUndefined();
      expect(host.calls).toHaveLength(1);
      expect(host.persisted.get("pitako-review").terminal.outcome).toBe("failed");
      const retainedBytes = readFileSync(host.stateFile, "utf8");
      const relaunched = await host.execute();
      expect(relaunched.status).toBe("blocked");
      expect(relaunched.error).toContain("already terminal");
      expect(host.calls).toHaveLength(1);
      expect(readFileSync(host.stateFile, "utf8")).toBe(retainedBytes);
    }
  });

  test.each([undefined, "stopped", "interrupted", "timedOut"] as const)(
    "a settled verifier failure (%s) refuses standalone relaunch without dispatch or state changes", async flag => {
      const host = fixture();
      let verifierCalls = 0;
      host.beforeVerify = () => {
        verifierCalls++;
        return { ok: false, error: "Verifier process failed", results: [{ exitCode: 1, ...(flag ? { [flag]: true } : {}) } as any] };
      };
      const result = await host.execute();
      expect(result.status).toBe("blocked");
      expect(result).toMatchObject({ nativeBarrier: flag ?? "access verifier failed" });
      expect(result.error).toContain("Verifier process failed");
      expect(host.persisted.get("pitako-review").terminal.outcome).toBe(result.status);
      const retainedBytes = readFileSync(host.stateFile, "utf8");
      const relaunched = await host.execute();
      expect(relaunched.status).toBe("blocked");
      expect(relaunched.error).toContain("already terminal");
      expect(host.calls).toHaveLength(5);
      expect(verifierCalls).toBe(1);
      expect(readFileSync(host.stateFile, "utf8")).toBe(retainedBytes);
    },
  );

  test.each(["store-busy", "store-corrupt"])("a standalone review resumes with a fresh verifier after %s", async code => {
    const host = fixture();
    const store = new PitakoStore(host.root);
    if (code === "store-corrupt") {
      store.activate("arch:existing");
      const db = openSqliteSync(store.file);
      try { db.exec("PRAGMA user_version=2"); }
      finally { db.close(); }
    }
    const attempts: string[] = [];
    const initial = code === "store-busy" ? ["verify-synthesis", "verify-synthesis.r1", "verify-synthesis.r2"] : ["verify-synthesis"];
    host.beforeVerify = (key, request) => {
      attempts.push(key);
      if (code === "store-busy" && attempts.length <= initial.length) return {ok: true, output: JSON.stringify({v: 1, code})};
      if (code === "store-corrupt" && attempts.length === 1) {
        try { verifyGate(JSON.parse(request.task), host.root); }
        catch (error) {
          if (!(error instanceof StoreError)) throw error;
          return {ok: true, output: JSON.stringify({v: 1, code: error.code, recovery: error.recovery})};
        }
        throw new Error("Expected the verifier to quarantine the version-mismatched store.");
      }
    };
    const result = await host.execute();
    expect(result).toMatchObject({status: "failed", code, error: code === "store-busy"
      ? "Access verifier store-busy after three attempts at synthesis." : "Access verifier store-corrupt at synthesis."});
    if (code === "store-corrupt")
      expect(result).toMatchObject({recovery: {quarantine: expect.any(String)}});
    expect(result).not.toHaveProperty("nativeBarrier");
    expect(attempts).toEqual(initial);
    expect(host.writes).toEqual([]);
    expect(host.persisted.get("pitako-review").terminal).toBeNull();

    host.reconcile(true);
    const resumed = await host.execute();
    expect(resumed.status, resumed.error).toBe("completed");
    expect(attempts.slice(initial.length)).toEqual([`verify-synthesis.r${initial.length}`]);
    expect(host.observations).toEqual(["store-review.observe.r1"]);
    expect(host.calls.map(call => call.key)).toEqual(reviewKeys);
    expect(host.writes.map(write => write.outcome)).toEqual(["appended"]);
    expect(host.persisted.get("pitako-review").terminal.outcome).toBe("completed");
  });

  test("every reviewer reserves blocked for missing context and reports severe findings as ready", async () => {
    const severe = { ...finding, title: "Defect prevents a clear whole-spec result", classification: "scoped-defect" };
    const host = fixture(key => key.startsWith("independent-a-r1") ? child(key, { findings: [severe] }) : child(key));
    expect((await host.execute()).status).toBe("completed");
    expect(host.calls.map(call => call.key)).toContain("director-synthesis");
    expect(host.calls.at(-1)!.request.task).toContain("Do not use votes as proof by themselves.");
    expect(host.calls.at(-1)!.request.task).not.toContain("or a reviewer's confidence");
    for (const { request } of host.calls) {
      const task = request.task.replace(/\s+/g, " ");
      expect(task).toContain("Return status blocked only when missing material context prevents this review phase.");
      expect(task).toContain("Findings, however severe, and defects that prevent a clear result are reported with status ready.");
    }
  });

  test("terminal run-ID queries and matching optional native identity are not producer conflicts", async () => {
    const host = fixture(key => ({ ...child(key), key: `native-${key}`, workflowKey: key, agent: pitakoReviewerAgent(key),
      results: [{ key, workflowKey: key, runId: `native-${key}`, agent: pitakoReviewerAgent(key),
        savedOutputPath: "/native/mandatory/original.json", state: "complete" } as any],
    }));
    expect((await host.execute()).status).toBe("completed");
  });

  test("a partial terminalOutcome without closure cannot authorize unpublished failed-original retention", async () => {
    const host = fixture(key => key === "director-prepare" ? { ...child(key),
      terminalOutcome: { state: "partial", reason: "timeout" }, results: [],
    } : child(key));
    expect((await host.execute()).status).toBe("failed");
    expect(host.archived().originals[0]).toMatchObject({ terminal: "unconfirmed", delivery: "unproved", sufficient: false });
    expect(host.archived().originals[0].failedOriginal).toBeUndefined();
    expect(host.calls).toHaveLength(1);
  });

  test("a contradictory blocked self-report cannot mask a native permission denial", async () => {
    const error = "Blocked by pi-subagents permission rule: review forbidden";
    const host = fixture(key => key === "director-prepare" ? { ...child(key, { status: "blocked", reason: "Ready to retry" }), error } : child(key));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(result.error).toContain(error);
    expect(result.references[0]).toMatchObject({ error });
    expect(host.calls).toHaveLength(1);
  });

  test.each(["running", "queued", "paused"])("unpublished nonterminal nested %s is not a failed original", async state => {
    const host = fixture(key => key === "director-prepare" ? { ...child(key), results: [{ state } as any] } : child(key));
    expect((await host.execute()).status).toBe("failed");
    expect(host.archived().originals[0]).toMatchObject({ terminal: "unconfirmed", delivery: "unproved", sufficient: false });
    expect(host.archived().originals[0].failedOriginal).toBeUndefined();
    expect(host.calls).toHaveLength(1);
  });

  test("missing native mission state blocks before any producer dispatch", async () => {
    const calls: string[] = [];
    const result = await runWorkflowScript({
      script: fixture().bound + source, args,
      launch: async key => { calls.push(key); throw new Error("Must not launch"); },
      status: async () => { throw new Error("Must not query status"); },
    });
    expect(result.value).toMatchObject({ status: "failed", phase: "prepare" });
    expect(JSON.stringify(result.value)).toContain("state is unavailable without a mission");
    expect(calls).toEqual([]);
  });

  test.each(["success", "large with reuse", "large without reuse", "failure", "stop", "tampered journal", "tampered reuse"] as const)(
    "the journal-to-cursor cut recovers %s without redispatching settled keys", async seam => {
    const nativeReuse = seam === "large with reuse" || seam === "tampered reuse";
    const large = nativeReuse || seam === "large without reuse";
    const completes = seam === "success" || seam === "large with reuse";
    const host = fixture(key => large && key.startsWith("independent-")
      ? child(key, {coverage: "x".repeat(20000)}) : key !== "independent-a-r1" ? child(key) : seam === "failure"
      ? {...child(key, {coverage: "Exact unpublished failed report"}), ok: false, results: [], error: "Output save failed"}
      : seam === "stop" ? {ok: false, runId: "stopped", stopped: true, error: "User Stop during reasoning"} : child(key),
    undefined, nativeReuse ? {runtimeCutAt: 3} : {failAt: 3});
    const result = await host.execute();
    expect(result.error).toContain(nativeReuse ? "Runtime replaced" : "Essential mission save denied");
    if (seam === "stop")
      expect(result.references).toContainEqual(expect.objectContaining({error: "User Stop during reasoning", stopped: true}));
    expect(host.calls).toHaveLength(5);
    const savesAtCut = host.saves();
    expect(savesAtCut).toBe(3);
    expect(host.observations).toEqual([]);
    expect(host.persisted.get("pitako-review").slots.map((ref: any) => ref.key)).toEqual(["director-prepare"]);
    if (seam === "tampered journal") {
      const witness = readFileSync(host.journal, "utf8");
      writeFileSync(host.journal, witness.replace("Inspected changed API and callers", "Modified native result"));
    }
    if (seam === "tampered reuse") {
      for (const [key, prior] of host.recovered)
        if (key.startsWith("independent-"))
          host.recovered.set(key, {...prior, structuredOutput: child(key, {coverage: "Changed reuse result"}).structuredOutput});
    }
    const savedAtCut = readFileSync(host.stateFile, "utf8");
    host.reconcile(true);
    const resumed = await host.execute();
    expect(host.observations).toEqual(["store-review.observe.r1"]);
    if (nativeReuse) {
      expect(host.reusedChildren).toHaveLength(2);
      expect(host.reusedChildren.every(key => key.startsWith("independent-"))).toBe(true);
    } else expect(host.reusedChildren).toEqual([]);
    if (completes || seam === "failure")
      expect(resumed.status, resumed.error).toBe(completes ? "completed" : "blocked");
    expect(host.calls.map(call => call.key)).toEqual(completes ? reviewKeys : reviewKeys.slice(0, 5));
    if (completes || seam === "failure") {
      expect(host.writes.map(call => [call.key, call.outcome])).toEqual([["store-review", "appended"]]);
      if (seam === "failure") expect(host.archived().originals[3].failedOriginal.coverage).toBe("Exact unpublished failed report");
    } else {
      expect(host.writes).toEqual([]);
      expect(host.verifications).toEqual([]);
      if (seam !== "stop") expect(resumed.error).toContain("Standalone review integrity failure");
      if (seam === "large without reuse") {
        // The diagnostic counts the full native settlements, not shortened bodies or a page.
        const { scopeId } = host.persisted.get("pitako-review");
        const settlements = [...host.recovered].map(([key, result]) => ({ key, result, digest: canonicalDigest(result) }));
        const fullBytes = Buffer.byteLength(JSON.stringify({ scopeId, settlements, pending: [] })) + 1;
        expect(fullBytes).toBeGreaterThan(61440);
        expect(resumed).toEqual({
          status: "failed", phase: expect.any(String), references: [],
          error: `Standalone review integrity failure: review-recovery-overflow: ${fullBytes} bytes for 5 settled slots (limit 61440).`,
        });
        const savesAtOverflow = host.saves();
        expect(savesAtOverflow - savesAtCut).toBe(1);
        const saved = readFileSync(host.stateFile, "utf8");
        const expected = JSON.parse(savedAtCut);
        expected["pitako-review"].terminal = resumed.error;
        expect(JSON.parse(saved)).toEqual(expected);
        expect(() => new PitakoStore(host.root).readActiveReview()).toThrow("Store does not exist");

        host.persisted.clear(); // The named relaunch starts from the durable cursor.
        const {script} = analysisResource("pitako.review", host.root, host.root).resolve({
          ...args, missionId: "mission", missionPath: host.missionFile,
        });
        expect(await host.resolved(script)).toEqual(resumed);
        expect(host.observations).toEqual(["store-review.observe.r1"]);
        expect(host.calls.map(call => call.key)).toEqual(reviewKeys.slice(0, 5));
        expect(host.reusedChildren).toEqual([]);
        expect(host.verifications).toEqual([]);
        expect(host.writes).toEqual([]);
        expect(host.saves()).toBe(savesAtOverflow);
        expect(readFileSync(host.stateFile, "utf8")).toBe(saved);
      } else if (seam === "stop") {
        expect(resumed).toMatchObject({nativeBarrier: "stopped", references: [{key: "independent-a-r1", runId: "stopped"}]});
        expect(host.persisted.get("pitako-review").slots.at(-1)).toMatchObject({barrier: "stop"});
        const saved = readFileSync(host.stateFile, "utf8");
        expect(await host.execute()).toEqual(resumed);
        expect(readFileSync(host.stateFile, "utf8")).toBe(saved);
        expect(host.observations).toEqual(["store-review.observe.r1"]);
        expect(host.calls).toHaveLength(5);
      }
    }
  });

});


test.each(["intact", "missing", "changed"])("consumed review original is read by path and verified: %s", mode => {
  const path = join(originalsRoot, `retained-${mode}.json`), value = { memo: "Complete original, not a preview" };
  writeFileSync(path, JSON.stringify(value, null, 2));
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  const ref = { id: "original", key: "review.synthesis", runId: "native-review", path, sha256 };
  expect(reviewOriginals({ originals: [{ ...ref, sha256: undefined, digest: canonicalDigest(value) }] }).originals).toEqual([ref]);
  if (mode === "missing") unlinkSync(path);
  if (mode === "changed") writeFileSync(path, JSON.stringify({ memo: "Changed" }));
  if (mode === "intact") expect(readReviewOriginal(ref)).toEqual(value);
  else expect(() => readReviewOriginal(ref)).toThrow(sha256);
});

test.each(["standalone", "execute"])("%s state size is independent of report bodies", async mode => {
  const sizes: number[] = [];
  for (const length of [40, 40000]) {
    const host = fixture(key => {
      const local = key.replace(/^loop1\./, "");
      const body: any = local.startsWith("independent-") ? { coverage: "x".repeat(length) }
        : local === "director-synthesis" ? { memo: "x".repeat(length) } : {};
      if (mode === "execute" && local === "director-synthesis") body.screening = {
        verdict: "clear", reason: "No material gaps", assessments: [{
          findingId: "a-r1-1", requirement: finding.requirement, material: false,
          consequence: "Guard prevents the scenario", reason: "Source checked",
        }],
      };
      return child(local, { ...body, reason: "x".repeat(length) });
    });
    const options = mode === "execute" ? { mode, prefix: "loop1.", decisionReference: { stateKey: "root", loop: 1 } } : {};
    expect((await host.library(args, options)).status).toBe("completed");
    expect(host.calls).toHaveLength(6);
    const retained = mode === "execute" ? host.persisted.get("root").loop.integratedReview : host.archived();
    expect([...host.persisted.keys()]).toEqual([mode === "execute" ? "root" : "pitako-review"]);
    expect(host.writes).toHaveLength(mode === "execute" ? 0 : 1);
    expect(retained.originals).toHaveLength(6);
    for (const original of retained.originals) {
      expect(original).not.toHaveProperty("value");
      expect(original).not.toHaveProperty("failedOriginal");
      expect(original.digest).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const verification of host.verifications) for (const item of verification.request.items) {
      expect(Object.keys(item).sort()).toEqual(["digest", "id", "key", "path"]);
      expect(item.digest).toBe(canonicalDigest(JSON.parse(readFileSync(item.path, "utf8"))));
    }
    const bytes = Buffer.byteLength(readFileSync(host.stateFile));
    expect(bytes).toBeLessThan(256 * 1024);
    sizes.push(bytes);
  }
  expect(Math.abs(sizes[1]! - sizes[0]!)).toBeLessThan(128);
});

test.each(["digest", "producer", "missing", "intact"])("execute replay verifies retained originals: %s", mode => {
  return (async () => {
    const host = fixture(key => child(key.slice("loop1.".length), key.endsWith("director-synthesis") ? {
      screening: { verdict: "clear", reason: "Guard checked", assessments: [{
        findingId: "a-r1-1", requirement: finding.requirement, material: false,
        consequence: "Guard prevents wrong record", reason: "Source checked",
      }] },
    } : {}));
    const options = { mode: "execute", prefix: "loop1.", decisionReference: { stateKey: "root", loop: 1 } };
    expect((await host.library(args, options)).status).toBe("completed");
    host.persisted.set("root", { loop: { ...host.persisted.get("root").loop, review: { references:
      [...host.recovered].map(([key, result]) => ({ key, runId: result.runId, results: result.results })),
    } } });
    const key = "loop1.independent-a-r1", original = host.recovered.get(key)!;
    if (mode === "digest") original.structuredOutput = { ...(original.structuredOutput as object), coverage: "Changed replay body" };
    if (mode === "producer") original.runId = "replacement-producer";
    if (mode === "missing") unlinkSync(original.results![0]!.savedOutputPath!);
    host.reconcile();
    const result = await host.library(args, options);
    expect(host.calls).toHaveLength(6); // Reconciliation never launches another reviewer.
    if (mode === "intact") expect(result.status, result.error).toBe("completed");
    else {
      expect(result.status).toBe("blocked");
      expect(result.error).toContain(mode === "missing" ? "missing-file" : "integrity conflict");
    }
  })();
});

test.each(["missing", "changed"])("digest-to-raw review references fail closed: %s", mode => {
  const path = join(originalsRoot, `canonical-${mode}.json`), value = { memo: "Pinned canonical body" };
  writeFileSync(path, JSON.stringify(value));
  const ref = { id: "original", key: "review.synthesis", runId: "native-review", path, digest: canonicalDigest(value) };
  if (mode === "missing") unlinkSync(path);
  else writeFileSync(path, JSON.stringify({ memo: "Rewritten" }));
  expect(() => reviewOriginals({ originals: [ref] })).toThrow(mode === "missing" ? "missing" : "integrity conflict");
});

test.each([40000, 80000])("unpublished failures retain at most one bounded inline original (%s bytes)", async length => {
  const host = fixture(key => key.startsWith("independent-") ? {
    ...child(key, { coverage: "x".repeat(length) }), ok: false, results: [], error: "Native publication failed",
  } : child(key));
  expect((await host.execute()).status).toBe("blocked");
  expect(host.calls).toHaveLength(5);
  const retained = host.archived().originals;
  expect(retained.filter((item: any) => item.failedOriginal)).toHaveLength(length === 40000 ? 1 : 0);
  expect(Buffer.byteLength(JSON.stringify(retained))).toBeLessThan(64 * 1024);
  if (length === 80000) expect(retained[1].diagnostic).toContain("inline retention limit");
});
