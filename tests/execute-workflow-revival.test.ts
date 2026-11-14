import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeRevivalContextPeak } from "../extensions/execute-settings.ts";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";

const source = readFileSync(new URL("../skills/execute/workflow.js", import.meta.url), "utf8");
const decideRevival = new Function("const text = value => typeof value === 'string' && value.trim().length > 0;\n" +
  source.slice(source.indexOf("function same("), source.indexOf("function continuationIdentity(")) + "\nreturn decideRevival;")();
const candidate = { head: "a".repeat(40), fingerprint: "b".repeat(64) };
const previous = () => ({ taskId: "task", checkpoint: { loop: 1 }, launch: { runId: "retained" },
  result: { status: "continue", revival: { opinion: "resume" } },
  gate: { receipt: { after: candidate, stalled: false, progress: { nonImproving: 0 } } },
  revival: { decision: "fresh" } });
const cfg = () => ({ taskId: "task", loop: 1, candidate });

test("decideRevival accepts the inclusive default/configured threshold without mutating inputs", () => {
  const prev = previous(), config = cfg(), before = structuredClone({ prev, config });
  expect(decideRevival(prev, config, 120000)).toEqual({ decision: "resume", code: "eligible" });
  expect(decideRevival(prev, { ...config, revivalContextPeak: 140000 }, 140000)).toHaveProperty("decision", "resume");
  prev.revival.decision = "resume";
  expect(decideRevival(prev, config, 100)).toHaveProperty("decision", "resume");
  prev.revival.decision = "fresh";
  expect({ prev, config }).toEqual(before);
});

test.each([
  ["opinion-fresh", (prev: any) => { delete prev.result.revival; }],
  ["opinion-fresh", (prev: any) => { prev.result.revival.opinion = "fresh"; }],
  ["different-task", (prev: any) => { prev.taskId = "other"; }],
  ["different-loop", (prev: any) => { prev.checkpoint.loop = 2; }],
  ["not-continue", (prev: any) => { prev.result.status = "complete"; }],
  ["stalled", (prev: any) => { prev.gate.receipt.stalled = true; }],
  ["stalled", (prev: any) => { prev.gate.receipt.progress.nonImproving = 3; }],
  ["halted", (prev: any) => { prev.halt = { code: "stop" }; }],
  ["restore", (prev: any) => { prev.restore = {}; }],
  ["candidate-changed", (prev: any) => { prev.gate.receipt.after = { ...candidate, fingerprint: "c".repeat(64) }; }],
  ["candidate-changed", (prev: any) => { delete prev.gate.receipt.after; }],
  ["missing-run", (prev: any) => { delete prev.launch.runId; }],
  ["revived-no-improvement", (prev: any) => { prev.revival.decision = "resume"; prev.gate.receipt.progress.nonImproving = 1; }],
] as const)("decideRevival selects fresh: %s", (code, change) => {
  const prev = previous(); change(prev);
  expect(decideRevival(prev, cfg(), 100)).toEqual({ decision: "fresh", code });
});

test("missing/invalid peak and context, halt or candidate limits select fresh", () => {
  for (const peak of [undefined, null, NaN, -1])
    expect(decideRevival(previous(), cfg(), peak)).toEqual({ decision: "fresh", code: "missing-peak" });
  expect(decideRevival(previous(), cfg(), 120001)).toEqual({ decision: "fresh", code: "context-peak" });
  expect(decideRevival(previous(), { ...cfg(), revivalContextPeak: 99 }, 100)).toHaveProperty("code", "context-peak");
  expect(decideRevival(previous(), { ...cfg(), halt: {} }, 100)).toHaveProperty("code", "halted");
  expect(decideRevival(previous(), { ...cfg(), candidate: { ...candidate, head: "d".repeat(40) } }, 100)).toHaveProperty("code", "candidate-changed");
});

const { fixture } = executeControllerFixture();
const lastAttempt = (host: ReturnType<typeof fixture>) => [...host.snapshots].reverse().find(s => s.loop?.attempt?.taskId === "change1").loop.attempt;
function continuingHost(options: { realCheckout?: boolean; reject?: boolean; missingPeak?: boolean; stagnant?: boolean; drift?: boolean; refusal?: string } = {}) {
  const host = fixture(undefined, { realCheckout: options.realCheckout || options.drift, humanPosts: [{ id: 2, type: "FINDING", content: "Already loaded" }] });
  let workers = 0, gates = 0;
  host.setRespond((request, normal) => {
    if (request.resume && /\.t\d+\.a\d+$/.test(request.key)) {
      if (options.reject || options.refusal) return { ok: false, key: request.key,
        error: options.refusal ?? "Run not found. Provide id or runId.", output: options.refusal ?? "Run not found. Provide id or runId.", artifactPaths: [] };
      const value = host.worker(request);
      workers++;
      return host.result(request, { ...value, ...(options.stagnant && workers === 2 ? {
        status: "continue", remaining: ["Finish work"], continuation: { mode: "resume", reason: "Retain context" },
      } : {}) });
    }
    if (request.agent === "pitako.worker") {
      const value = host.worker(request);
      return host.result(request, { ...value, ...(workers++ === 0 ? {
        status: "continue", remaining: ["Finish work"], continuation: { mode: "resume", reason: "Retain context" },
      } : {}) });
    }
    if (options.drift && request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "baseline" && workers === 1)
      host.changeCheckout();
    const result = normal();
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "gate") {
      const receipt = JSON.parse(result.output!);
      if (!options.missingPeak) receipt.contextPeak = 100;
      if (gates++ === 0) receipt.view.posts = [{ id: 2, type: "FINDING", content: "Already loaded" }, { id: 7, type: "FINDING", content: "New useful fact" }];
      if (options.stagnant && gates === 2) receipt.progress.nonImproving = 1;
      result.output = JSON.stringify(receipt);
    }
    return result;
  });
  return host;
}

test("controller resumes a new keyed attempt without bindings and sends only deltas", async () => {
  const host = continuingHost({ realCheckout: true });
  expect((await host.execute()).status).toBe("complete");
  const first = host.calls.find(request => request.agent === "pitako.worker")!;
  const resumed = host.calls.find(request => request.resume && request.key.includes(".t1."))!;
  expect(resumed.key).toBe("invoke-human-1.l1.t1.a2");
  expect(resumed.resume).toBe(`native-${first.key}`);
  expect(resumed).not.toHaveProperty("extensionBindings");
  expect(resumed).not.toHaveProperty("agent");
  for (const label of ["ATTEMPT:", "GATE FAILURES:", "METRIC SERIES:", "NEW BOARD POSTS:", "PREVIOUS RESULT:", "checkpoint hook"])
    expect(resumed.task).toContain(label);
  expect(resumed.task).toContain("New useful fact");
  expect(resumed.task).not.toContain("Already loaded");
  for (const state of host.snapshots) {
    const attempt = state.loop?.attempt;
    if (attempt?.gate?.receipt && attempt.close?.admitted) {
      expect(attempt.gate.receipt).not.toHaveProperty("view");
      expect(attempt.close.receipt.projection).not.toHaveProperty("view");
    }
  }
  for (const repeated of ["COMPLETE IMMUTABLE SPECS", "COMPLETE SELECTED TASK", '"goal":', "PRE-WRITE CHECKPOINT INTENTION"])
    expect(resumed.task).not.toContain(repeated);
  const attempt = lastAttempt(host);
  expect(attempt).toMatchObject({ key: resumed.key, number: 2, bindingKey: first.key,
    checkpoint: { key: resumed.key, attempt: 2 }, revival: { decision: "resume", code: "eligible" } });
  expect(attempt.gate.ref.key).toContain("a2");
  const directory = path.join(host.root, ".pi/subagents/checkpoints", resumed.key);
  expect(existsSync(path.join(directory, "unit.json"))).toBe(true);
  const manifest = JSON.parse(JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")).data);
  expect(manifest.intent.key).toBe(resumed.key);
  expect(host.emits.some(row => row.schema === "pitako.execute-todo" && row.tasks.some((task: any) => task.subject.includes("↻") && task.subject.includes("paths 1")))).toBe(true);
});

test("close replay keeps fresh Board delivery after its transient view is transferred", async () => {
  const host = continuingHost({ realCheckout: true });
  host.setFailSave(state => state.loop?.attempt?.gate?.stage === "receipt" &&
    !!state.loop.attempt.close && !state.loop.attempt.close.receipt.projection.view);
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  host.setFailSave();
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  const resumed = host.calls.filter(request => request.resume && request.key.includes(".t1."));
  expect(resumed).toHaveLength(1);
  expect(resumed[0]!.task).toContain("New useful fact");
  expect(host.calls.filter(request => request.key === "invoke-human-1.l1.t1.a1.gate")).toHaveLength(1);
});

test("explicit rejected resume records refusal and dispatches a fresh new key/binding", async () => {
  const host = continuingHost({ reject: true });
  const outcome = await host.execute();
  expect(outcome.status, outcome.reason).toBe("complete");
  const workers = host.calls.filter(request => request.agent === "pitako.worker");
  expect(workers.map(request => request.key)).toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a3"]);
  expect((workers[1] as any).extensionBindings["pitako.checkpoint/1"].key).toBe(workers[1].key);
  expect(workers[1].task).toContain("COMPLETE SELECTED TASK");
  expect(lastAttempt(host)).toMatchObject({ number: 3, bindingKey: workers[1].key,
    revival: { decision: "fresh", code: "resume-rejected" }, resumeRejection: { reason: "Run not found. Provide id or runId." } });
});

test.each(["missingPeak", "drift"] as const)("controller keeps fresh on %s", async mode => {
  const host = continuingHost({ [mode]: true });
  await host.execute();
  expect(host.calls.some(request => request.resume && request.key.includes(".t1."))).toBe(false);
  expect(host.calls.filter(request => request.agent === "pitako.worker")).toHaveLength(2);
  expect(lastAttempt(host).revival.code).toBe(mode === "missingPeak" ? "missing-peak" : "candidate-changed");
});

test("a revived non-improving worker is not revived twice", async () => {
  const host = continuingHost({ stagnant: true });
  expect((await host.execute()).status).toBe("complete");
  expect(host.calls.filter(request => request.resume && request.key.includes(".t1."))).toHaveLength(1);
  expect(lastAttempt(host).revival.code).toBe("revived-no-improvement");
});

test.each(["Blocked by pi-subagents permission rule: 'run' is denied.", "Uncertain native transport failure"])("resume refusal never bypasses barriers or uncertainty: %s", async refusal => {
  const host = continuingHost({ refusal });
  expect((await host.execute()).status).not.toBe("complete");
  expect(host.calls.filter(request => request.agent === "pitako.worker")).toHaveLength(1);
});

test("revival context setting follows global/project precedence with strict admission diagnostics", () => {
  const host = fixture(), agentDir = path.join(host.root, "private-agent"); mkdirSync(agentDir);
  expect(executeRevivalContextPeak(host.root, agentDir)).toBe(120000);
  const settings = (root: string, value: unknown) => writeFileSync(path.join(root, "settings.json"), JSON.stringify({ pitako: { execute: { revivalContextPeak: value } } }));
  settings(agentDir, 80000);
  expect(executeRevivalContextPeak(host.root, agentDir)).toBe(80000);
  mkdirSync(path.join(host.root, ".pi"), { recursive: true });
  settings(path.join(host.root, ".pi"), 90000);
  expect(executeRevivalContextPeak(host.root, agentDir)).toBe(90000);
  settings(path.join(host.root, ".pi"), "invalid");
  expect(() => executeRevivalContextPeak(host.root, agentDir)).toThrow("pitako.execute.revivalContextPeak");
});


test("admitted context setting controls dispatch and remains retained", async () => {
  const host = continuingHost();
  host.setHostResponse((key, value) => key.startsWith("inspect-initial") && value.admission
    ? { ...value, admission: { ...value.admission, revivalContextPeak: 50 } } : value);
  expect((await host.execute()).status).toBe("complete");
  expect(host.current().revivalContextPeak).toBe(50);
  expect(host.calls.some(request => request.resume && request.key.includes(".t1."))).toBe(false);
  expect(lastAttempt(host).revival.code).toBe("context-peak");
});
