import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const originalsRoot = mkdtempSync(join(tmpdir(), "pitako-review-originals-"));
let originalNumber = 0;
afterAll(() => rmSync(originalsRoot, { recursive: true, force: true }));
import { runWorkflowScript, type WorkflowScriptChildResult } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { verifyGate } from "../extensions/access-receipts.mjs";

import { readReviewOriginal, reviewOriginals } from "../skills/execute/loop.ts";
import { createHash } from "node:crypto";
import { canonicalDigest } from "../extensions/canonical.mjs";

const source = readFileSync(new URL("../skills/workflow-canonical.js", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../skills/review/workflow.js", import.meta.url), "utf8");
interface Request {
  agent?: string; resume?: string; context?: string; skill?: string[];
  model?: string; async?: boolean; task: string; label: string; phase: string; output: string; outputMode: string; outputSchema: unknown;
}
interface Result {
  ok: boolean; runId?: string; error?: string; structuredOutput?: unknown;
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
  references: { key: string; runId: string; stopped?: boolean; results?: { structuredOutputPath: string }[] }[];
  screening?: { verdict: string; reason: string; assessments: unknown[] };
}
const args = {
  workDescription: "Review record selection guards",
  brief: "Preserve the caller contract. No implementation.",
  target: { kind: "diff", reference: "candidate-17", material: "/owned/evidence/exact.patch" },
};
const angles = [
  { id: "a", focus: "Correctness and reachable callers", skills: ["blast-radius"] },
  { id: "b", focus: "Unnecessary complexity", skills: ["ponytail-review"] },
];
const finding = {
  title: "PRIVATE_FINDING", location: "src/api.ts:12", scenario: "Caller passes an empty key",
  evidence: "Guard removed by the supplied patch", impact: "Wrong record selected",
  classification: "scoped-defect", requirement: "README.md: caller keys must select the matching record",
};
const challenge = { findingId: "a-1", assessment: "refuted", evidence: "Caller rejects empty keys" };
const response = { findingId: "a-1", disposition: "withdraw", reason: "Confirmed the caller guard" };
const disposition = {
  findingId: "a-1", decision: "discard", reason: "Existing guard prevents the scenario",
  classification: finding.classification, requirement: finding.requirement,
};
function child(key: string, properties?: object): Result {
  let body: object;
  if (key === "director-prepare") body = { angles };
  else if (key.startsWith("independent-"))
    body = { coverage: "Inspected changed API and callers; no tests executed",
      findings: key.endsWith("-a") ? [finding] : [] };
  else if (key.startsWith("critique-"))
    body = { challenges: key.endsWith("-b") ? [challenge] : [] };
  else if (key.startsWith("defense-"))
    body = { responses: key.endsWith("-a") ? [response] : [] };
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
// Named-resource binding for native-sandbox runs, and the real verifier at the launch boundary.
function nativeAccess() {
  const missionPath = join(originalsRoot, `native-mission-${++originalNumber}.json`);
  writeFileSync(missionPath, "{}");
  return { prefix: `const pitakoAccess = ${JSON.stringify({ missionPath, namespace: "review" })};\n` };
}
function verifierLaunch(key: string, request: any) {
  if (request.agent !== "pitako.access-verifier") return undefined;
  return { key, ok: true, agent: request.agent, runId: `native-${key}`, output: JSON.stringify(verifyGate(JSON.parse(request.task))),
    artifactPaths: [], results: [{ exitCode: 0 }] } as any;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function fixture(
  respond: (key: string, request: Request) => Result | Promise<Result> = key => child(key),
  synchronousFailureKey?: string,
  storage?: { other?: string; failAt?: number },
) {
  const calls: { key: string; request: Request }[] = [];
  const persisted = new Map<string, any>();
  const recovered = new Map<string, Result>();
  let replaying = false;
  let saveCount = 0;
  const missionFile = join(originalsRoot, `mission-${++originalNumber}.json`);
  writeFileSync(missionFile, JSON.stringify({ other: storage?.other ?? "", workflowState: {} }));
  const state = { get: async (key: string) => persisted.get(key), set: (key: string, value: any) => {
    saveCount++;
    if (saveCount === storage?.failAt) throw new Error("Essential mission save denied after User Stop");
    const mission = JSON.parse(readFileSync(missionFile, "utf8"));
    mission.workflowState[key] = value;
    const bytes = JSON.stringify(mission);
    if (Buffer.byteLength(bytes, "utf8") > 256 * 1024) throw new Error("Whole mission exceeds 256 KiB");
    writeFileSync(missionFile, bytes);
    persisted.set(key, JSON.parse(JSON.stringify(value)));
  } };
  const access = { missionPath: missionFile, namespace: "review" };
  const verifications: { key: string; request: any; output: any }[] = [];
  function dispatch(key: string, request: Request): Promise<Result> {
    // The real model-free verifier runs over the actual published temp files.
    if (request.agent === "pitako.access-verifier") return Promise.resolve().then(() => {
      const output = verifyGate(JSON.parse(request.task));
      verifications.push({ key, request: JSON.parse(request.task), output });
      return { ok: true, agent: request.agent, runId: `native-${key}`, output: JSON.stringify(output), results: [{ exitCode: 0 } as any] };
    });
    if (replaying && recovered.has(key)) return Promise.resolve(recovered.get(key)!);
    expect(calls.some(call => call.key === key)).toBe(false);
    calls.push({ key, request });
    if (key === synchronousFailureKey) throw new Error("Synchronous dispatch rejection");
    return Promise.resolve().then(() => respond(key, request)).then(result => {
      const published = nativeOriginal(key, request, result);
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
  ) => (input: unknown, runner: typeof runs, state: unknown) => Promise<Outcome>;
  // Named-resource resolution inlines pitakoAccess; the raw source alone refuses to run.
  const bound = `const pitakoAccess = ${JSON.stringify(access)};\n`;
  return {
    calls, persisted, missionFile, verifications, recovered, saves: () => saveCount,
    reconcile: () => { replaying = true; },
    execute: (input: unknown = args) => new AsyncFunction("args", "runs", "state", bound + source)(input, runs, state),
    raw: (input: unknown = args) => new AsyncFunction("args", "runs", "state", source)(input, runs, state),
    library: <T = Outcome>(input: unknown = args, options: object = {}, tail?: string) =>
      new AsyncFunction("args", "runs", "state", `${bound}const pitakoReviewLibraryMode = true;\n${source}\n${
        tail ?? `return reviewPhase(args, runs, ${JSON.stringify(options)});`
      }`)(input, runs, state) as Promise<T>,
  };
}

describe("review scripted workflow", () => {
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

  test.each(["clear", "material-gaps", "blocked"])(
    "execute screening is reasoned independently of protocol completion: %s", async verdict => {
      const assessment = { findingId: "a-1", requirement: finding.requirement,
        material: verdict === "material-gaps", consequence: "Caller may select a wrong record",
        reason: verdict === "material-gaps" ? "Reachable violation remains" : "Existing guard bounds the risk" };
      const screening = { verdict, reason: "Requirement and current caller evidence assessed", assessments: [assessment] };
      const host = fixture(key => child(key.slice("loop1.".length), key.endsWith("director-synthesis")
        ? { dispositions: [{ ...disposition, decision: "include" }], screening } : {}));
      const result = await host.library(args, { prefix: "loop1.", mode: "execute" });
      expect(result.status).toBe("completed");
      expect(result.screening).toEqual(screening);
      // Includes fresh preparation/angles and resumed critique/defense/synthesis.
      expect(host.calls.some(call => call.request.resume)).toBe(true);
      for (const { request } of host.calls) {
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
        findingId: "a-1", requirement: "README.md: selecting a record must respect the caller's key",
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
      { findingId: "a-1", material: true, reason: "Violation", requirement: finding.requirement, consequence: "Wrong record" },
    ] },
    { verdict: "material-gaps", reason: "Gaps", assessments: [
      { findingId: "a-1", material: false, reason: "Bounded", requirement: finding.requirement, consequence: "Wrong record" },
    ] },
    { verdict: "material-gaps", reason: "Gaps", assessments: [
      { findingId: "a-1", material: true, reason: "Violation", requirement: null, consequence: "Wrong record" },
    ] },
    { verdict: "clear", reason: "No gaps", assessments: [
      { findingId: "a-1", material: false, reason: "Bounded", requirement: finding.requirement, consequence: "" },
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
          findingId: "a-1", material: true, reason: "Claimed violation",
          requirement: finalDisposition.requirement, consequence: "Wrong record",
        }] },
      } : {}));
    const result = await host.library(args, { prefix: "loop1.", mode: "execute" });
    expect(result.status).toBe("failed");
    expect(result.screening).toBeUndefined();
    if (finalDisposition.decision === "discard" || ["out-of-scope", "related-improvement"].includes(finalDisposition.classification))
      expect(result.error).toContain("Execute screening contradicts dispositions or lacks consequences. a-1");
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

  test.each([2, 3, 4])("native sandbox preserves standalone/library parity and all %i-angle phases", async count => {
    const roster = Array.from({ length: count }, (_, index) => ({ id: `r${index}`, focus: `Risk ${index}`, skills: [] }));
    const outcomes: unknown[] = [];
    for (const library of [false, true]) {
      const calls: string[] = [];
      const bound = nativeAccess().prefix;
      const result = await runWorkflowScript({
        script: library ? `${bound}const pitakoReviewLibraryMode = true;\n${source}\nreturn reviewPhase(args, runs);` : bound + source,
        args,
        state: { get: () => undefined, set: () => {} },
        launch: async (key, request) => {
          const verified = verifierLaunch(key, request);
          if (verified) return verified;
          calls.push(key);
          const id = key.slice(key.indexOf("-") + 1);
          const index = roster.findIndex(angle => angle.id === id);
          const body = key === "director-prepare" ? { angles: roster }
            : key.startsWith("independent-") ? { findings: [finding] }
              : key.startsWith("critique-") ? { challenges: [{ ...challenge, findingId: `${roster[(index + 1) % count]!.id}-1` }] }
                : key.startsWith("defense-") ? { responses: [{ ...response, findingId: `${id}-1` }] }
                  : { dispositions: roster.map(angle => ({ ...disposition, findingId: `${angle.id}-1` })) };
          if (key.startsWith("independent-")) {
            expect(request.task).toContain(JSON.stringify(args.target));
            expect(request.task).toContain(args.brief);
            expect(request.task).not.toContain(finding.title);
          }
          return { key, ...nativeOriginal(key, request as unknown as Request, child(key, body)), output: "", artifactPaths: [] } as any;
        },
        status: async () => { throw new Error("Unexpected status query"); },
      });
      expect(result.value).toMatchObject({ status: "completed", phase: "synthesis" });
      expect(calls).toEqual([
        "director-prepare", ...roster.map(angle => `independent-${angle.id}`),
        ...roster.map(angle => `critique-${angle.id}`), ...roster.map(angle => `defense-${angle.id}`),
        "director-synthesis",
      ]);
      expect(calls).toHaveLength(3 * count + 2); // 8 / 11 / 14, including preparation and synthesis.
      outcomes.push(result.value);
    }
    expect(outcomes[1]).toMatchObject({ status: "completed", phase: "synthesis" });
  });

  test("controlled capacity exhaustion in the native sandbox retains completed phases without replacement", async () => {
    const calls: string[] = [];
    const attempted: string[] = [];
    const result = await runWorkflowScript({
      script: `${nativeAccess().prefix}const pitakoReviewLibraryMode = true;\n${source}\nreturn reviewPhase(args, runs, { prefix: "loop1." });`,
      args,
      state: { get: () => undefined, set: () => {} },
      launch: async (key, request) => {
        const verified = verifierLaunch(key, request);
        if (verified) return verified;
        attempted.push(key);
        // The public sandbox delegates runtime admission to its launch boundary.
        if (calls.length === 3) throw new Error("Native spawn capacity exhausted");
        calls.push(key);
        return { key, ...nativeOriginal(key, request as unknown as Request, child(key.slice("loop1.".length))), output: "", artifactPaths: [] } as any;
      },
      status: async () => { throw new Error("Unexpected status query"); },
    });
    expect(result.value).toMatchObject({ status: "failed", phase: "critique",
      references: [
        { key: "loop1.director-prepare", runId: "native-director-prepare" },
        { key: "loop1.independent-a", runId: "native-independent-a" },
        { key: "loop1.independent-b", runId: "native-independent-b" },
        { key: "loop1.critique-b", error: "Native spawn capacity exhausted" },
      ] });
    expect(calls).toEqual(["loop1.director-prepare", "loop1.independent-a", "loop1.independent-b"]);
    expect(attempted).toEqual([...calls, "loop1.critique-b"]);
    expect(JSON.stringify(result.value)).toContain("spawn");
  });

  test("a settled stopped child is incomplete and preserves Stop evidence after siblings settle", async () => {
    const waiting = deferred<Result>(), entered = deferred<void>();
    const host = fixture(key => {
      if (key === "independent-a") return { ok: false, runId: "stopped-native", stopped: true, error: "User Stop" };
      if (key === "independent-b") { entered.resolve(); return waiting.promise; }
      return child(key);
    });
    let finished = false;
    const work = host.library().then(result => { finished = true; return result; });
    let result: Outcome;
    try {
      await entered.promise;
      expect(finished).toBe(false);
    } finally {
      waiting.resolve(child("independent-b"));
      result = await work;
    }
    expect(result.status).toBe("failed"); // A child's Stop does not certify invocation cancellation.
    expect(result.error).toContain("User Stop");
    expect(result.references).toContainEqual(expect.objectContaining({ key: "independent-a", runId: "stopped-native", stopped: true, error: "User Stop" }));
    expect(host.calls).toHaveLength(3);
  });

  test("independent angles receive the same target, selected skills, and no peer conclusions", async () => {
    const host = fixture();
    const result = await host.execute();
    expect(result.status).toBe("completed");
    const independent = host.calls.filter(call => call.key.startsWith("independent-"));
    expect(independent).toHaveLength(2);
    for (const { request } of independent) {
      expect(request.agent).toBe("pitako.reviewer");
      expect(request.context).toBe("fresh");
      expect(request.task).toContain(JSON.stringify(args.target));
      expect(request.task).toContain(args.brief);
      expect(request.task).not.toContain("PRIVATE_FINDING");
    }
    expect(independent[0]!.request.skill).toEqual(["verify-behavior", "ponytail-review", "blast-radius"]);
    expect(independent[1]!.request.skill).toEqual(["verify-behavior", "ponytail-review"]);
    for (const { request } of host.calls) {
      expect(request.skill ?? []).not.toContain("scope-discipline");
      expect(request.task).not.toContain("Read and apply scope-discipline");
      expect(request.model).toBeUndefined();
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

  test("cross-examines every finding once, preserves native conversations, and synthesizes after defense", async () => {
    const host = fixture();
    const result = await host.execute();
    expect(host.calls.map(call => call.key)).toEqual([
      "director-prepare", "independent-a", "independent-b", "critique-b",
      "defense-a", "director-synthesis",
    ]);
    const byKey = (key: string) => host.calls.find(call => call.key === key)!.request;
    expect(packet(byKey("critique-b")).map(original => JSON.parse(readFileSync(original.results[0].savedOutputPath, "utf8")).findings)).toContainEqual([finding]);
    expect(packet(byKey("critique-b"))).toHaveLength(1);
    expect(byKey("critique-b").task).toContain("Challenge both factual support and belonging");
    expect(byKey("critique-b").resume).toBe("native-independent-b");
    expect(byKey("defense-a").resume).toBe("native-independent-a");
    expect(packet(byKey("defense-a")).map(original => JSON.parse(readFileSync(original.results[0].savedOutputPath, "utf8")).challenges)).toContainEqual([challenge]);
    expect(packet(byKey("defense-a")).some(original => original.phase === "critique")).toBe(true);
    expect(byKey("director-synthesis").resume).toBe("native-director-prepare");
    expect(packet(byKey("director-synthesis")).map(original => JSON.parse(readFileSync(original.results[0].savedOutputPath, "utf8")).responses)).toContainEqual([response]);
    expect(packet(byKey("director-synthesis"))).toHaveLength(4);
    for (const { request } of host.calls.filter(call => call.request.resume)) {
      expect(request.agent).toBeUndefined();
      expect(request.skill).toBeUndefined();
    }
    expect(result.dispositions).toEqual([disposition]);
    expect(result.memo).toContain("No supported findings");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FINDING");
    expect(result.references).toHaveLength(6);
  });

  test.each([2, 3, 4])("zero findings with %i angles skips empty calls but retains synthesis", async count => {
    const roster = Array.from({ length: count }, (_, index) =>
      ({ id: `angle${index}`, focus: `Risk ${index}`, skills: [] }));
    const host = fixture(key => child(key,
      key === "director-prepare" ? { angles: roster }
        : key.startsWith("independent-") ? { findings: [] }
          : key === "director-synthesis" ? { dispositions: [] } : {}));
    const result = await host.execute();
    expect(result.status).toBe("completed");
    expect(result.dispositions).toEqual([]);
    expect(host.calls.map(call => call.key)).toEqual([
      "director-prepare", ...roster.map(angle => `independent-${angle.id}`), "director-synthesis",
    ]);
    expect(result.references).toHaveLength(count + 2);
    expect(packet(host.calls.at(-1)!.request)).toHaveLength(count);
  });

  test("sparse findings preserve the latest native run for each author", async () => {
    const roster = Array.from({ length: 4 }, (_, index) =>
      ({ id: `angle${index}`, focus: `Risk ${index}`, skills: [] }));
    const dispositions = [0, 1].map(index => ({ ...disposition, findingId: `angle${index}-1` }));
    const host = fixture(key => {
      if (key === "director-prepare") return child(key, { angles: roster });
      if (key.startsWith("independent-")) return child(key,
        { findings: ["independent-angle0", "independent-angle1"].includes(key) ? [finding] : [] });
      if (key.startsWith("critique-")) return child(key,
        { challenges: [{ ...challenge, findingId: key === "critique-angle0" ? "angle1-1" : "angle0-1" }] });
      if (key.startsWith("defense-")) return child(key,
        { responses: [{ ...response, findingId: `${key.slice("defense-".length)}-1` }] });
      return child(key, { dispositions });
    });
    const result = await host.execute();
    expect(result.status).toBe("completed");
    expect(host.calls.map(call => call.key)).toEqual([
      "director-prepare", ...roster.map(angle => `independent-${angle.id}`),
      "critique-angle0", "critique-angle3", "defense-angle0", "defense-angle1", "director-synthesis",
    ]);
    expect(host.calls.find(call => call.key === "defense-angle0")?.request.resume)
      .toBe("native-critique-angle0");
    expect(host.calls.find(call => call.key === "defense-angle1")?.request.resume)
      .toBe("native-independent-angle1");
    expect(result.dispositions).toEqual(dispositions);
  });

  test.each([2, 3, 4])("assigns every finding a distinct peer critic with %i dynamic angles", async count => {
    const roster = Array.from({ length: count }, (_, index) =>
      ({ id: `angle${index}`, focus: `Risk ${index}`, skills: [] }));
    const findingsFor = (id: string) => [1, 2].map(ordinal =>
      ({ ...finding, title: `${id} evidence ${ordinal}` }));
    const allDispositions = roster.flatMap(angle => [1, 2].map(ordinal =>
      ({ ...disposition, findingId: `${angle.id}-${ordinal}` })));
    const host = fixture((key, request) => {
      if (key === "director-prepare") return child(key, { angles: roster });
      const id = key.slice(key.indexOf("-") + 1);
      if (key.startsWith("independent-")) return child(key, { findings: findingsFor(id) });
      if (key.startsWith("critique-")) {
        const index = roster.findIndex(angle => angle.id === id);
        const peer = roster[(index + 1) % count]!.id;
        for (const entry of findingsFor(peer)) expect(readFileSync(packet(request)[0].results[0].savedOutputPath, "utf8")).toContain(entry.title);
        for (const entry of findingsFor(id)) expect(request.task).not.toContain(entry.title);
        return child(key, { challenges: [1, 2].map(ordinal =>
          ({ ...challenge, findingId: `${peer}-${ordinal}` })) });
      }
      if (key.startsWith("defense-")) return child(key, { responses: [1, 2].map(ordinal =>
        ({ ...response, findingId: `${id}-${ordinal}` })) });
      return child(key, { dispositions: allDispositions });
    });
    const result = await host.execute();
    expect(result.status).toBe("completed");
    expect(result.dispositions).toEqual(allDispositions);
    expect(host.calls).toHaveLength(2 + 3 * count);
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
      ...disposition, findingId: `a-${index + 1}`, classification: entry.classification,
      requirement: entry.requirement, decision: entry.classification === "uncertain" ? "uncertain" : "include",
    }));
    const input = { ...args, brief: `${args.brief}
Closure review of candidate-16 against candidate-17: close admitted finding a-1.
Prior report and correction delta: /owned/evidence/closure.txt. Retain unaffected coverage.` };
    const host = fixture(key => child(key,
      key === "independent-a" ? { findings }
        : key === "critique-b" ? { challenges: dispositions.map(entry =>
          ({ ...challenge, findingId: entry.findingId })) }
          : key === "defense-a" ? { responses: dispositions.map(entry =>
            ({ ...response, findingId: entry.findingId })) }
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
    for (const key of ["independent-a", "director-synthesis"]) {
      const schema = host.calls.find(call => call.key === key)!.request.outputSchema;
      const collection = key === "independent-a" ? "findings" : "dispositions";
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

  test.each(["independent", "critique", "defense"])(
    "settles all %s siblings before reporting a child failure, without replacement",
    async phase => {
      const waiting = deferred<Result>(), entered = deferred<void>();
      const host = fixture(key => {
        if (key === `${phase}-a`) throw new Error("Controlled failure");
        if (key === `${phase}-b`) { entered.resolve(); return waiting.promise; }
        return child(key, key === "independent-b" ? { findings: [finding] }
          : key === "critique-a" ? { challenges: [{ ...challenge, findingId: "b-1" }] } : {});
      });
      let finished = false;
      const execution = host.execute().then(result => { finished = true; return result; });
      await entered.promise;
      let result: Outcome;
      try {
        expect(finished).toBe(false);
        expect(host.calls.at(-1)?.key).toBe(`${phase}-b`);
      } finally {
        waiting.resolve(child(`${phase}-b`));
        result = await execution;
      }
      expect(result.status).toBe("failed");
      expect(result.phase).toBe(phase);
      expect(result.references).toContainEqual(expect.objectContaining({ key: `${phase}-b`, runId: `native-${phase}-b` }));
      expect(host.calls.at(-1)?.key).toBe(`${phase}-b`);
      expect(host.calls.some(call => call.key === "director-synthesis")).toBe(false);
    },
  );

  test.each(["director-prepare", "independent-b", "critique-b", "defense-a", "director-synthesis"])(
    "preserves a blocked outcome at %s rather than claiming review completion", async key => {
      const host = fixture(current => child(current, current === key
        ? { status: "blocked", reason: "Exact artifact unavailable" } : {}));
      const result = await host.execute();
      expect(result.status).toBe("blocked");
      expect(result.error).toContain("Exact artifact unavailable");
      expect(result.memo).toBeUndefined();
      expect(host.calls.filter(call => call.key === key)).toHaveLength(1);
    },
  );

  test("also settles siblings when dispatch throws synchronously", async () => {
    const waiting = deferred<Result>(), entered = deferred<void>();
    const host = fixture(key => {
      if (key === "independent-b") { entered.resolve(); return waiting.promise; }
      return child(key);
    }, "independent-a");
    let finished = false;
    const execution = host.execute().then(result => { finished = true; return result; });
    await entered.promise;
    let result: Outcome;
    try {
      expect(finished).toBe(false);
    } finally {
      waiting.resolve(child("independent-b"));
      result = await execution;
    }
    expect(result.status).toBe("failed");
    expect(host.calls).toHaveLength(3);
    expect(result.references).not.toContainEqual(expect.objectContaining({ key: "independent-a" }));
  });

  test.each(["director-prepare", "director-synthesis"])(
    "reports a director dispatch rejection at %s without inventing a reference", async key => {
      const host = fixture(current => child(current), key);
      const result = await host.execute();
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Synchronous dispatch rejection");
      expect(result.references).not.toContainEqual(expect.objectContaining({ key }));
      expect(host.calls.filter(call => call.key === key)).toHaveLength(1);
    },
  );

  test.each([
    ["critique-b", { challenges: [] }],
    ["critique-b", { challenges: [challenge, { ...challenge, findingId: "invented" }] }],
    ["critique-b", { challenges: [challenge, challenge] }],
    ["critique-b", { challenges: [{ ...challenge, assessment: "guess" }] }],
    ["defense-a", { responses: [] }],
    ["defense-a", { responses: [{ ...response, findingId: "invented" }] }],
    ["director-synthesis", { dispositions: [] }],
    ["director-synthesis", { dispositions: [disposition, disposition] }],
    ["director-synthesis", { dispositions: [{ ...disposition, findingId: "invented" }] }],
  ] as const)("rejects incomplete, duplicate, or invented finding accounting at %s", async (key, properties) => {
    const host = fixture(current => child(current, current === key ? properties : {}));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(result.error).toContain((properties as any).challenges?.[0]?.assessment === "guess"
      ? "completeness/schema/association" : "finding dispositions");
    expect(result.memo).toBeUndefined();
  });

  test.each([
    { angles: [] }, { angles: [angles[0]] }, { angles: [angles[0], angles[0]] },
    { angles: [...angles, ...angles, angles[0]] },
    { angles: [angles[0], { ...angles[1], skills: ["execute"] }] },
    { angles: [angles[0], { ...angles[1], id: "../escape" }] },
  ])("refuses invalid director rosters before launching reviewers: %j", async properties => {
    const host = fixture(key => child(key, properties));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(host.calls).toHaveLength(1);
  });

  test("does not treat process success as an adequate review or replace a failed resume", async () => {
    const inadequate = fixture(key => key === "independent-a"
      ? { ok: true, runId: "native-empty", structuredOutput: { status: "ready" } } : child(key));
    expect((await inadequate.execute()).status).toBe("failed");
    const resume = fixture(key => key === "critique-b" ? { ok: false } : child(key));
    expect((await resume.execute()).phase).toBe("critique");
    expect(resume.calls.filter(call => !call.request.resume)).toHaveLength(3);
  });

  test.each(["director-prepare", "independent-a", "critique-b", "defense-a", "director-synthesis"])(
    "retains a child's bounded setup failure and run reference at %s", async key => {
      const cause = "Setup failed after automatic recovery. Original error: controlled stale context";
      const host = fixture(current => current === key
        ? { ok: false, runId: `failed-${key}`, error: cause } : child(current));
      const result = await host.execute();
      expect(result.status).toBe("failed");
      expect(result.error).toContain(cause);
      expect(result.memo).toBeUndefined();
      expect(result.references).toContainEqual(expect.objectContaining({ key, runId: `failed-${key}`, error: cause }));
      expect(host.calls.filter(call => call.key === key)).toHaveLength(1);
    },
  );

  test("retains a terminal failed child's identity while joining its unfinished sibling", async () => {
    const waiting = deferred<Result>(), entered = deferred<void>();
    const host = fixture(key => {
      if (key === "independent-a")
        return { ok: false, runId: "failed-independent-a", error: "Terminal child failure" };
      if (key === "independent-b") { entered.resolve(); return waiting.promise; }
      return child(key);
    });
    let finished = false;
    const execution = host.execute().then(result => { finished = true; return result; });
    await entered.promise;
    let result: Outcome;
    try {
      expect(finished).toBe(false);
    } finally {
      waiting.resolve(child("independent-b"));
      result = await execution;
    }
    expect(result.status).toBe("failed");
    expect(result.phase).toBe("independent");
    expect(result.error).toContain("Terminal child failure");
    expect(result.references).toMatchObject([
      { key: "director-prepare", runId: "native-director-prepare" },
      { key: "independent-a", runId: "failed-independent-a" },
      { key: "independent-b", runId: "native-independent-b" },
    ]);
    expect(host.calls.map(call => call.key)).toEqual([
      "director-prepare", "independent-a", "independent-b",
    ]);
  });

  test("bounds long child diagnostics without losing their cause", async () => {
    const host = fixture(key => key === "critique-b"
      ? { ok: false, error: `Resume unavailable: ${"x".repeat(5000)}` } : child(key));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Resume unavailable:");
    expect(result.error!.length).toBeLessThanOrEqual(1200);
  });

  test.each([
    ["independent-a", { findings: [{ ...finding, evidence: "" }] }],
    ["independent-a", { findings: [{ ...finding, classification: "blocking" }] }],
    ["independent-a", { findings: [{ ...finding, requirement: null }] }],
    ["independent-a", { findings: [{ ...finding, requirement: undefined }] }],
    ["independent-a", { findings: null }],
    ["independent-a", { coverage: "" }],
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

  test("long work descriptions retain early phase and angle differentiation fresh and resumed", async () => {
    const workDescription = "Review record selection guards " + "with complete caller context ".repeat(12);
    const host = fixture();
    expect((await host.execute({ ...args, workDescription })).status).toBe("completed");
    expect(host.calls.map(call => call.key)).toEqual([
      "director-prepare", "independent-a", "independent-b", "critique-b", "defense-a", "director-synthesis",
    ]);
    for (const { key, request } of host.calls) {
      const phase = key === "director-prepare" ? "Select review angles" : key === "director-synthesis" ? "Review synthesis"
        : key.startsWith("independent-") ? "Independent review" : key.startsWith("critique-") ? "Cross-critique" : "Author defense";
      const angle = angles.find(angle => key.endsWith(`-${angle.id}`));
      expect(request.label).toStartWith(`${phase}${angle ? ` — ${angle.focus}` : ""}: `);
      expect(request.label).toEndWith(workDescription.trim());
      expect(request.task.split("\n")[0]).toBe(request.label);
      expect(request.phase).toBe(`review-${key.startsWith("director-") ? key.slice(9) === "prepare" ? "prepare" : "synthesis" : key.split("-")[0]}`);
      expect(request.task.slice(request.label.length)).toContain(args.brief);
      expect(request.task.slice(request.label.length)).toContain(JSON.stringify(args.target));
      if (key.startsWith("critique-") || key.startsWith("defense-")) {
        expect(request.resume).toBe(`native-independent-${key.split("-")[1]}`);
      } else if (key === "director-synthesis") expect(request.resume).toBe("native-director-prepare");
      else expect(request.context).toBe("fresh");
    }
    expect(host.calls[1]!.request.label.indexOf(angles[0]!.focus)).toBeLessThan(host.calls[1]!.request.label.indexOf(workDescription.trim()));
    expect(host.calls[2]!.request.label.indexOf(angles[1]!.focus)).toBeLessThan(host.calls[2]!.request.label.indexOf(workDescription.trim()));
  });

  test("current target, publication originals and access survive every fresh/resumed handoff without duplicate findings", async () => {
    const host = fixture(key => child(key, key === "independent-b"
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
        if (original.key === "independent-a") {
          expect(JSON.stringify(exact).split(finding.title)).toHaveLength(2);
          expect(JSON.parse(readFileSync(original.results[0].savedOutputPath, "utf8")).findings).toEqual([finding]);
        }
        if (key === "director-synthesis" && original.key === "independent-b")
          expect(exact.coverage).toContain("CONTRARY_NON_FINDING");
      }
    }
    const manifest = host.persisted.get("review-standalone");
    expect(manifest.originals.map((item: any) => item.runId)).toEqual(host.calls.map(call => `native-${call.key}`));
    expect(manifest.originals.find((item: any) => item.key === "independent-b").runId).toBe("native-independent-b");
    expect(manifest.originals.find((item: any) => item.key === "critique-b").runId).toBe("native-critique-b");
    expect(manifest.originals.every((item: any) => item.publication === "published" && !item.failedOriginal)).toBe(true);
    expect(manifest.originals[0].results[0].outputReference).toEqual({ path: manifest.originals[0].results[0].savedOutputPath });
    const replay = await host.execute();
    expect(replay.status).toBe("blocked");
    expect(replay.error).toContain("reconciliation");
    expect(host.calls).toHaveLength(6);
    expect(host.persisted.get("review-standalone")).toEqual(manifest);
  });

  test.each(["mandatory", "optional"])("distinguishes %s publication failure without generic-reference proof", async kind => {
    const host = fixture(key => key === "director-prepare" ? {
      ...child(key), outputReference: "/generic/not-publication", outputArtifactPath: "/debug/not-publication",
      ...(kind === "mandatory" ? { results: [{ structuredOutputPath: "/optional/structured.json" } as any] }
        : { metadataSaveError: "Optional diagnostic save failed" }),
    } : child(key));
    const result = await host.execute();
    expect(result.status).toBe(kind === "mandatory" ? "failed" : "completed");
    const original = host.persisted.get("review-standalone").originals[0];
    expect(original.publication).toBe(kind === "mandatory" ? "unpublished" : "published");
    expect(original.sufficient).toBe(kind === "optional");
    if (kind === "mandatory") {
      expect(result.error).toContain("Mandatory native publication");
      expect(host.calls).toHaveLength(1);
    } else expect(original.observability).toBe("failed");
  });

  test.each(["ready", "blocked"])("retains exactly one complete delivered failed %s original, never published or sufficient", async status => {
    const host = fixture((key, request) => {
      if (key !== "independent-a") return child(key);
      const result = nativeOriginal(key, request, { ...child(key, { status, reason: "Partial analysis: contrary evidence remains" }),
        ok: false, results: [], error: "Mandatory output save failed" });
      return { ...result, error: `Mandatory output save failed\n\nOutput:\n${JSON.stringify(result.structuredOutput, null, 2)}` };
    });
    const result = await host.execute();
    expect(result.status).toBe("failed");
    const manifest = host.persisted.get("review-standalone");
    const original = manifest.originals.find((item: any) => item.key === "independent-a");
    expect(original).toMatchObject({ delivery: "complete", publication: "unpublished", sufficient: false, terminal: "failed" });
    expect(original.failedOriginal.status).toBe(status);
    expect(original.failedOriginal.findings).toEqual([finding]);
    expect(original.diagnostic).toContain("Mandatory output save failed");
    expect(JSON.stringify(manifest).split(finding.title)).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(finding.title);
    expect(host.calls).toHaveLength(3);
  });

  test.each(["rejection", "missing", "unknown", "wrong-association", "text"])("does not retain an undemonstrated failed original: %s", async delivery => {
    const host = fixture((key, request) => {
      if (key !== "independent-a") return child(key);
      if (delivery === "rejection") throw new Error("Rejected without object");
      if (delivery === "missing") return { ok: false, runId: "missing", error: "No original delivered" };
      if (delivery === "text") return { ok: false, runId: "text", output: JSON.stringify(child(key).structuredOutput), error: "Unproved text route" };
      return { ...child(key, delivery === "unknown" ? { delivery: undefined }
        : { association: { query: "wrong" } }), ok: false, results: [], error: "Save failed" };
    });
    const result = await host.execute();
    expect(result.status).toBe("failed");
    const originals = host.persisted.get("review-standalone").originals;
    expect(originals.every((item: any) => !item.failedOriginal)).toBe(true);
    const original = originals.find((item: any) => item.key === "independent-a");
    if (delivery !== "rejection") expect(original.delivery).toBe(["missing", "text"].includes(delivery) ? "not-delivered" : "unproved");
    expect(host.calls).toHaveLength(3);
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
    expect(host.persisted.get("review-standalone").version).toBe(3);
  });

  test.each(["context", "inline"])("%s cannot replace native publication", async source => {
    const host = fixture(key => key === "independent-a"
      ? { ...child(key, { coverage: `Complete ${source} analysis available` }), results: [] } : child(key));
    expect((await host.execute()).status).toBe("failed");
    expect(host.calls.map(call => call.key)).toEqual(["director-prepare", "independent-a", "independent-b"]);
    expect(host.persisted.get("review-standalone").originals[1]).toMatchObject({
      publication: "unpublished", sufficient: false, failedOriginal: { coverage: `Complete ${source} analysis available` },
    });
  });

  test.each([undefined, 1, 2])("incompatible review state v%s blocks before dispatch", async version => {
    const host = fixture();
    host.persisted.set("review-standalone", { version, originals: [] });
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(result.error).toContain(`created by an incompatible Pitako contract v${version ?? 1}; start a new consultation/mission`);
    expect(host.calls).toEqual([]);
    expect(host.saves()).toBe(0);
  });

  test("old integrated review state cannot be superseded or reconciled", async () => {
    const host = fixture();
    host.persisted.set("review-root", { version: 1, decision: { reference: { stateKey: "root", loop: 1 } } });
    const result = await host.library(args, { prefix: "loop2.", mode: "execute",
      decisionReference: { stateKey: "root", loop: 2 } });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("incompatible Pitako contract v1");
    expect(host.calls).toEqual([]);
    expect(host.saves()).toBe(0);
  });

  test("verified referenced originals reach consumers; a later missing original blocks the next gate before dispatch", async () => {
    const host = fixture((key, request) => {
      if (key === "critique-b") {
        const original = packet(request)[0];
        expect(JSON.parse(readFileSync(original.results[0].savedOutputPath, "utf8")).findings).toEqual([finding]);
        rmSync(original.results[0].savedOutputPath);
      }
      return child(key);
    });
    const result = await host.execute();
    expect(result.status).toBe("blocked");
    expect(result.error).toContain("Access gate defense blocked before dispatch");
    expect(result.error).toContain("is unavailable: missing-file");
    expect(result.error).toContain("This pass cannot resume: start a new consultation/mission.");
    expect(host.calls.map(call => call.key)).not.toContain("defense-a");
    expect(host.verifications.map(entry => [entry.key, entry.output.items.map((item: any) => item.state)]))
      .toEqual([["verify-critique", ["accessible"]], ["verify-defense", ["unavailable", "accessible"]]]);
  });

  test("a raw script path refuses to run; only the named resource binds receipts to a mission", async () => {
    const host = fixture();
    await expect(host.raw()).rejects.toThrow("Launch pitako.review by name after mission.create");
    expect(host.calls).toEqual([]);
  });

  test("a changed published original is contradictory and stops the consumer before dispatch", async () => {
    const host = fixture((key, request) => {
      if (key === "critique-b") {
        const path = packet(request)[0].results[0].savedOutputPath;
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), coverage: "Rewritten after admission" }));
      }
      return child(key);
    });
    const result = await host.execute();
    expect(result.status).toBe("blocked");
    for (const part of ["is contradictory: content-differs", "Expected digest:", "does not choose a version"]) expect(result.error).toContain(part);
    expect(host.calls.map(call => call.key)).not.toContain("defense-a");
  });

  test("gates with no required originals dispatch no verifier; verified gates retain only receipt path and digest", async () => {
    const host = fixture();
    expect((await host.execute()).status).toBe("completed");
    expect(host.verifications.map(entry => entry.key)).toEqual(["verify-critique", "verify-defense", "verify-synthesis"]);
    expect(host.verifications.every(entry => entry.output.items.every((item: any) => item.state === "accessible"))).toBe(true);
    const receipts = host.persisted.get("review-standalone").receipts;
    expect(receipts.map((entry: any) => Object.keys(entry).sort())).toEqual(Array(3).fill(["accessible", "digest", "gate"]));
    expect(receipts.every((entry: any) => entry.accessible)).toBe(true);
    expect(host.verifications[0].output.receipt.path).toContain(join("receipts", "review", "critique.json"));
    expect(receipts[0].digest).toBe(host.verifications[0].output.receipt.digest);
  });

  test("whole-mission UTF-8 capacity includes unrelated keys and failed originals, without retrying save", async () => {
    const host = fixture(key => key === "independent-a" ? { ...child(key, {
      status: "blocked", reason: "Partial but complete original", coverage: "é".repeat(8000),
    }), ok: false, results: [], error: "Output save failed" } : child(key), undefined, { other: "é".repeat(122000) });
    const result = await host.execute() as Outcome & { persistence?: string; lastConfirmed?: any };
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Whole mission exceeds 256 KiB");
    expect(result.persistence).toBe("failed");
    expect(host.calls.map(call => call.key)).toEqual(["director-prepare", "independent-a", "independent-b"]);
    expect(host.saves()).toBe(3); // admission, preparation, failed batch save; no catch retry
    const persisted = JSON.parse(readFileSync(host.missionFile, "utf8"));
    expect(persisted.workflowState["review-standalone"].originals).toHaveLength(1);
    expect(result.lastConfirmed.originals).toHaveLength(1);
  });

  test("essential save failure stops new dispatch and retains original Stop diagnostic and confirmed state", async () => {
    const host = fixture(undefined, undefined, { failAt: 2 });
    const result = await host.execute() as Outcome & { lastConfirmed?: any };
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Essential mission save denied after User Stop");
    expect(host.calls).toHaveLength(1);
    expect(host.saves()).toBe(2);
    expect(result.lastConfirmed.originals).toEqual([]);
  });


  test("manifest ordering follows dispatch rather than asynchronous sibling completion", async () => {
    const a = deferred<Result>(), bEntered = deferred<void>();
    const host = fixture(key => {
      if (key === "independent-a") return a.promise;
      if (key === "independent-b") { bEntered.resolve(); return child(key); }
      return child(key);
    });
    const work = host.execute();
    try { await bEntered.promise; } finally { a.resolve(child("independent-a")); await work; }
    expect(host.persisted.get("review-standalone").originals.slice(0, 3).map((item: any) => item.key))
      .toEqual(["director-prepare", "independent-a", "independent-b"]);
  });

  test("published schema-valid but semantically invalid dispositions are not sufficient in durable state", async () => {
    const host = fixture(key => child(key, key === "director-synthesis" ? { dispositions: [] } : {}));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    const original = host.persisted.get("review-standalone").originals.at(-1);
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
    const original = host.persisted.get("review-standalone").originals[0];
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
      const original = host.persisted.get("review-standalone").originals[0];
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
    const original = host.persisted.get("review-standalone").originals[0];
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
      const original = host.persisted.get("review-standalone").originals[0];
      expect(original.sufficient).toBe(false);
      expect(original.terminal).not.toBe("succeeded");
      expect(original.failedOriginal).toBeUndefined();
      expect(host.calls).toHaveLength(1);
    }
  });

  test("every reviewer reserves blocked for missing context and reports severe findings as ready", async () => {
    const severe = { ...finding, title: "Defect prevents a clear whole-spec result", classification: "scoped-defect" };
    const host = fixture(key => key.startsWith("independent-a") ? child(key, { findings: [severe] }) : child(key));
    expect((await host.execute()).status).toBe("completed");
    expect(host.calls.map(call => call.key)).toContain("director-synthesis");
    for (const { request } of host.calls) {
      const task = request.task.replace(/\s+/g, " ");
      expect(task).toContain("Return status blocked only when missing material context prevents this review phase.");
      expect(task).toContain("Findings, however severe, and defects that prevent a clear result are reported with status ready.");
    }
  });

  test("terminal run-ID queries and matching optional native identity are not producer conflicts", async () => {
    const host = fixture(key => ({ ...child(key), key: `native-${key}`, workflowKey: key, agent: "pitako.reviewer",
      results: [{ key, workflowKey: key, runId: `native-${key}`, agent: "pitako.reviewer",
        savedOutputPath: "/native/mandatory/original.json", state: "complete" } as any],
    }));
    expect((await host.execute()).status).toBe("completed");
  });

  test("a partial terminalOutcome without closure cannot authorize unpublished failed-original retention", async () => {
    const host = fixture(key => key === "director-prepare" ? { ...child(key),
      terminalOutcome: { state: "partial", reason: "timeout" }, results: [],
    } : child(key));
    expect((await host.execute()).status).toBe("failed");
    expect(host.persisted.get("review-standalone").originals[0]).toMatchObject({ terminal: "unconfirmed", delivery: "unproved", sufficient: false });
    expect(host.persisted.get("review-standalone").originals[0].failedOriginal).toBeUndefined();
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
    expect(host.persisted.get("review-standalone").originals[0]).toMatchObject({ terminal: "unconfirmed", delivery: "unproved", sufficient: false });
    expect(host.persisted.get("review-standalone").originals[0].failedOriginal).toBeUndefined();
    expect(host.calls).toHaveLength(1);
  });

  test("missing native mission state blocks before any producer dispatch", async () => {
    const calls: string[] = [];
    const result = await runWorkflowScript({
      script: nativeAccess().prefix + source, args,
      launch: async key => { calls.push(key); throw new Error("Must not launch"); },
      status: async () => { throw new Error("Must not query status"); },
    });
    expect(result.value).toMatchObject({ status: "failed", phase: "prepare" });
    expect(JSON.stringify(result.value)).toContain("state is unavailable without a mission");
    expect(calls).toEqual([]);
  });

  test("a failed save reports both its original persistence cause and observed child Stop", async () => {
    const host = fixture(key => key === "independent-a"
      ? { ok: false, runId: "stopped", stopped: true, error: "User Stop during reasoning" }
      : child(key), undefined, { failAt: 3 });
    const result = await host.execute();
    expect(result.error).toContain("Essential mission save denied");
    expect(result.references).toContainEqual(expect.objectContaining({ error: "User Stop during reasoning", stopped: true }));
    expect(host.calls).toHaveLength(3);
    expect(host.saves()).toBe(3);
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

test.each(["standalone", "execute"])("v3 %s state size is independent of fourteen report bodies", async mode => {
  const sizes: number[] = [];
  for (const length of [40, 40000]) {
    const views = Array.from({ length: 4 }, (_, i) => ({ id: `v${i}`, focus: `Angle ${i}`, skills: [] }));
    const host = fixture(key => {
      const local = key.replace(/^loop1\./, "");
      const id = local.split("-").at(-1)!;
      const i = views.findIndex(view => view.id === id);
      const all = views.map(view => ({ ...disposition, findingId: `${view.id}-1` }));
      const body = local === "director-prepare" ? { angles: views }
        : local.startsWith("independent-") ? { coverage: "x".repeat(length), findings: [finding] }
        : local.startsWith("critique-") ? { challenges: [{ ...challenge, findingId: `v${(i + 1) % 4}-1` }] }
        : local.startsWith("defense-") ? { responses: [{ ...response, findingId: `${id}-1` }] }
        : { memo: "x".repeat(length), dispositions: all, screening: {
          verdict: "clear", reason: "No material gaps", assessments: all.map(item => ({
            findingId: item.findingId, requirement: finding.requirement, material: false,
            consequence: "Guard prevents the scenario", reason: "Source checked",
          })),
        } };
      if (mode === "standalone" && "screening" in body) delete body.screening;
      return child(local, { ...body, reason: "x".repeat(length) });
    });
    const options = mode === "execute" ? { mode, prefix: "loop1.", decisionReference: { stateKey: "root", loop: 1 } } : {};
    const result = await host.library(args, options);
    expect(result.status).toBe("completed");
    expect(host.calls).toHaveLength(14);
    const retained = host.persisted.get(mode === "execute" ? "review-root" : "review-standalone");
    expect(retained.version).toBe(3);
    expect(retained.originals).toHaveLength(14);
    for (const original of retained.originals) {
      expect(original).not.toHaveProperty("value");
      expect(original).not.toHaveProperty("failedOriginal");
      expect(original.digest).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const verification of host.verifications) {
      expect(verification.output.items.every((item: any) => item.state === "accessible")).toBe(true);
      for (const item of verification.request.items) {
        expect(Object.keys(item).sort()).toEqual(["digest", "id", "key", "path"]);
        expect(item.digest).toBe(canonicalDigest(JSON.parse(readFileSync(item.path, "utf8"))));
      }
    }
    const bytes = Buffer.byteLength(readFileSync(host.missionFile));
    expect(bytes).toBeLessThan(256 * 1024);
    sizes.push(bytes);
  }
  // Only temp-file counter digits may vary, never the report lengths.
  expect(Math.abs(sizes[1]! - sizes[0]!)).toBeLessThan(128);
});

test.each(["digest", "producer", "missing", "intact"])("execute replay verifies retained originals: %s", mode => {
  return (async () => {
    const host = fixture(key => child(key.slice("loop1.".length), key.endsWith("director-synthesis") ? {
      screening: { verdict: "clear", reason: "Guard checked", assessments: [{
        findingId: "a-1", requirement: finding.requirement, material: false,
        consequence: "Guard prevents wrong record", reason: "Source checked",
      }] },
    } : {}));
    const options = { mode: "execute", prefix: "loop1.", decisionReference: { stateKey: "root", loop: 1 } };
    expect((await host.library(args, options)).status).toBe("completed");
    host.persisted.set("root", { loop: { number: 1, review: { references:
      [...host.recovered].map(([key, result]) => ({ key, runId: result.runId, results: result.results })),
    } } });
    const key = "loop1.independent-a", original = host.recovered.get(key)!;
    if (mode === "digest") original.structuredOutput = { ...(original.structuredOutput as object), coverage: "Changed replay body" };
    if (mode === "producer") original.runId = "replacement-producer";
    if (mode === "missing") unlinkSync(original.results![0]!.savedOutputPath!);
    host.reconcile();
    const result = await host.library(args, options);
    expect(host.calls).toHaveLength(6); // Reconciliation never launches another reviewer.
    if (mode === "intact") expect(result.status).toBe("completed");
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
  expect((await host.execute()).status).toBe("failed");
  expect(host.calls).toHaveLength(3);
  const retained = host.persisted.get("review-standalone").originals;
  expect(retained.filter((item: any) => item.failedOriginal)).toHaveLength(length === 40000 ? 1 : 0);
  expect(Buffer.byteLength(JSON.stringify(retained))).toBeLessThan(64 * 1024);
  if (length === 80000) expect(retained[1].diagnostic).toContain("inline retention limit");
});
