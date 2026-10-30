import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runWorkflowScript, type WorkflowScriptChildResult } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";

const source = readFileSync(new URL("../skills/review/workflow.js", import.meta.url), "utf8");
interface Request {
  agent?: string; resume?: string; context?: string; skill?: string[];
  model?: string; async?: boolean; task: string; output: boolean; outputSchema: unknown;
}
interface Result {
  ok: boolean; runId?: string; error?: string; structuredOutput?: unknown;
  agent?: string; outputReference?: string; outputArtifactPath?: string;
  outputPathMapping?: { requestedPath: string; savedPath: string };
  artifactPaths?: string[]; results?: WorkflowScriptChildResult["results"];
  stopped?: boolean;
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function fixture(
  respond: (key: string, request: Request) => Result | Promise<Result> = key => child(key),
  synchronousFailureKey?: string,
) {
  const calls: { key: string; request: Request }[] = [];
  function dispatch(key: string, request: Request): Promise<Result> {
    expect(calls.some(call => call.key === key)).toBe(false);
    calls.push({ key, request });
    if (key === synchronousFailureKey) throw new Error("Synchronous dispatch rejection");
    return Promise.resolve().then(() => respond(key, request));
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
  ) => (input: unknown, runner: typeof runs) => Promise<Outcome>;
  return {
    calls,
    execute: (input: unknown = args) => new AsyncFunction("args", "runs", source)(input, runs),
    library: <T = Outcome>(input: unknown = args, options: object = {}, tail?: string) =>
      new AsyncFunction("args", "runs", `const pitakoReviewLibraryMode = true;\n${source}\n${
        tail ?? `return reviewPhase(args, runs, ${JSON.stringify(options)});`
      }`)(input, runs) as Promise<T>,
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
    expect(await host.library<Outcome>()).toEqual(await fixture().execute());
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
  });

  test("retains exact native references without copying child reports or deriving paths", async () => {
    const pointers = {
      agent: "pitako.reviewer", outputReference: "/native/exact-output",
      outputArtifactPath: "/native/published/report.json",
      outputPathMapping: { requestedPath: "/requested/report.json", savedPath: "/native/published/report.json" },
      artifactPaths: ["/native/debug/a", "/native/debug/b"],
      results: [{ index: 0, agent: "pitako.reviewer", task: "Review target", exitCode: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
        structuredOutputPath: "/native/optional/structured.json" }],
    };
    const host = fixture(key => ({ ...child(key), ...pointers }));
    const result = await host.library();
    expect(result.references[0]).toEqual({ key: "director-prepare", runId: "native-director-prepare", ...pointers,
      results: [{ structuredOutputPath: "/native/optional/structured.json" }] });
    expect(JSON.stringify(result)).not.toContain("structuredOutput\":");
  });

  test.each([2, 3, 4])("native sandbox preserves standalone/library parity and all %i-angle phases", async count => {
    const roster = Array.from({ length: count }, (_, index) => ({ id: `r${index}`, focus: `Risk ${index}`, skills: [] }));
    const outcomes: unknown[] = [];
    for (const library of [false, true]) {
      const calls: string[] = [];
      const result = await runWorkflowScript({
        script: library ? `const pitakoReviewLibraryMode = true;\n${source}\nreturn reviewPhase(args, runs);` : source,
        args,
        state: { get: () => undefined, set: () => { throw new Error("Review must not persist private state"); } },
        launch: async (key, request) => {
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
          return { key, ...child(key, body), output: "", artifactPaths: [] };
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
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  test("controlled capacity exhaustion in the native sandbox retains completed phases without replacement", async () => {
    const calls: string[] = [];
    const attempted: string[] = [];
    const result = await runWorkflowScript({
      script: `const pitakoReviewLibraryMode = true;\n${source}\nreturn reviewPhase(args, runs, { prefix: "loop1." });`,
      args,
      state: { get: () => undefined, set: () => {} },
      launch: async key => {
        attempted.push(key);
        // The public sandbox delegates runtime admission to its launch boundary.
        if (calls.length === 3) throw new Error("Native spawn capacity exhausted");
        calls.push(key);
        return { key, ...child(key.slice("loop1.".length)), output: "", artifactPaths: [] };
      },
      status: async () => { throw new Error("Unexpected status query"); },
    });
    expect(result.value).toMatchObject({ status: "failed", phase: "critique",
      references: [
        { key: "loop1.director-prepare", runId: "native-director-prepare" },
        { key: "loop1.independent-a", runId: "native-independent-a" },
        { key: "loop1.independent-b", runId: "native-independent-b" },
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
    expect(result.references).toContainEqual({ key: "independent-a", runId: "stopped-native", stopped: true });
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
      expect(request.model).toBeUndefined();
      expect(request.async).toBeUndefined();
      expect(request.output).toBe(false);
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
    expect(byKey("critique-b").task).toContain("PRIVATE_FINDING");
    expect(byKey("critique-b").task).toContain(finding.requirement);
    expect(byKey("critique-b").task).toContain("Challenge both factual support and belonging");
    expect(byKey("critique-b").resume).toBe("native-independent-b");
    expect(byKey("defense-a").resume).toBe("native-independent-a");
    expect(byKey("defense-a").task).toContain(challenge.evidence);
    expect(byKey("director-synthesis").resume).toBe("native-director-prepare");
    expect(byKey("director-synthesis").task).toContain(response.reason);
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
    expect(host.calls.at(-1)?.request.task).toContain("PEER CHALLENGES:\n[]");
    expect(host.calls.at(-1)?.request.task).toContain("AUTHOR RESPONSES:\n[]");
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
        for (const entry of findingsFor(peer)) expect(request.task).toContain(entry.title);
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
      expect(result.references).toContainEqual({ key: `${phase}-b`, runId: `native-${phase}-b` });
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
    expect(result.error).toContain("finding dispositions");
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
      expect(result.references).toContainEqual({ key, runId: `failed-${key}` });
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
    expect(result.references).toEqual([
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
  });

  test.each([
    {}, { ...args, brief: "" }, { ...args, target: null },
    { ...args, target: { ...args.target, material: "" } },
    { ...args, target: { ...args.target, kind: "unknown" } },
    { ...args, continuation: {} }, { ...args, maxRounds: 5 },
    { ...args, model: "hardcoded/model" },
  ])("rejects invalid or unsupported input before dispatch: %j", async input => {
    const host = fixture();
    await expect(host.execute(input)).rejects.toThrow();
    expect(host.calls).toHaveLength(0);
  });
});
