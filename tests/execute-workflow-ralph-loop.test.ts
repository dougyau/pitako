import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { readBacklog } from "../skills/execute/loop.ts";
import { executeControllerFixture, copy, type Result } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const isGate = (call: { agent?: string; task: string }) => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "gate";
const taskFixture = () => { const host = fixture(); host.setLimit(1); return host; };
const gateReceipt = (normal: () => Result) => {
  const result = normal();
  return { result, receipt: JSON.parse(result.output!) };
};

test("a complete worker with failed focused gates seals pause and continues the same task", async () => {
  const host = taskFixture();
  let failed = false;
  host.setRespond((request, normal) => {
    if (isGate(request) && !failed) {
      failed = true;
      const { result, receipt } = gateReceipt(normal);
      receipt.gates[0] = { ...receipt.gates[0], status: "fail", exit: 1, tail: "Observable failing assertion" };
      receipt.progress.nonImproving = 1;
      return { ...result, output: JSON.stringify(receipt) };
    }
    return normal();
  });
  const output = await host.execute();
  expect(output.status).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  const operations = host.calls.filter(call => call.agent === "pitako.loop-io").map(call => JSON.parse(call.task).operation);
  expect(operations).toEqual(["prepare", "apply", "gate", "gate", "apply"]);
  expect(output.boardTopicId).toBe(1);
  expect(host.calls.some(call => call.agent === "pitako.reviewer")).toBe(false);
  expect(host.snapshots.every(state => !state.activePlan && !state.loop?.selection?.receipt?.backlog)).toBe(true);
  const workers = host.calls.filter(call => call.agent === "pitako.worker");
  expect(workers[0]!.key).toContain(".l1.t1.a1");
  expect(workers[1]!.key).toContain(".l1.t1.a2");
  expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(1);
  const firstWorker = host.calls.indexOf(workers[0]!);
  const firstGate = host.calls.findIndex(call => isGate(call));
  const firstSeal = host.calls.findIndex(call => call.agent === "pitako.checkpoint-sealer");
  expect(firstWorker).toBeLessThan(firstGate); expect(firstGate).toBeLessThan(firstSeal);
  const seals = host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task));
  expect(seals[0].kind).toBe("pause");
  expect(seals[1].kind).toBe("unit");
  expect(workers[1]!.task).toContain("Observable failing assertion");
  expect(workers[1]!.task).toContain("TASK CONTINUATION");
  expect(workers[1]!.task).not.toContain("FROZEN ATTEMPT");
  expect(workers[1]!.task).not.toContain("checkoutEvidence before/after");
  expect(workers[1]!.task).toContain("do not ask the supervisor about concurrency");
  expect(workers[1]!.task).toContain("Current DECISIONs are binding working rules");
  expect(workers[1]!.task).toContain("COMPLETE IMMUTABLE SPEC SNAPSHOT");
  expect(host.calls.filter(call => isGate(call)).every(call => call.timeoutMs === 14400000)).toBe(true);
  expect(host.snapshots.some(value => value.loop?.attempt?.gate?.stage === "receipt" && !value.loop?.attempt.seal)).toBe(true);
});

test("malformed knowledge does not reject an otherwise valid worker result", async () => {
  const host = taskFixture();
  let workers = 0;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker") result.structuredOutput.knowledge = { findings: false,
      handoff: workers++ === 0 ? "🧵".repeat(600) + "\ud800" : 42 };
    return result;
  });
  expect((await host.execute()).status).toBe("partial");
  const request = host.calls.find(call => call.agent === "pitako.worker")!;
  expect(Object.keys(request.outputSchema.properties)).toEqual(["work", "status", "remaining", "knowledge"]);
  expect(request.outputSchema.required).not.toContain("knowledge");
  const knowledge = JSON.parse(host.calls.find(call => isGate(call))!.task).knowledge;
  expect(Buffer.byteLength(knowledge.handoff)).toBe(2048);
  expect(knowledge.findings).toEqual([]);
  expect(host.history()[0]!.results.every((value: any) => value.status === "complete")).toBe(true);
});

test("a saved gate receipt is reused after the seal intention survives a failed result save", async () => {
  const host = taskFixture();
  host.setFailSave(value => value.loop?.attempt?.stage === "result");
  const first = await host.execute();
  expect(first.status).not.toBe("complete");
  expect(host.current().loop.attempt.gate.stage).toBe("receipt");
  expect(host.current().loop.attempt.seal).toBeDefined();
  const key = host.current().loop.attempt.key;
  const gatesBefore = host.calls.filter(call => isGate(call)).length;
  host.setFailSave(undefined);
  expect((await host.execute()).status).toBe("partial");
  expect(host.calls.filter(call => isGate(call) && call.key.startsWith(key))).toHaveLength(1);
  expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key === key)).toHaveLength(1);
  expect(gatesBefore).toBe(1);
});

test("three non-improving gate attempts end the task loop", async () => {
  const host = taskFixture(); host.setLimit(1);
  let attempts = 0;
  host.setRespond((request, normal) => {
    if (isGate(request)) {
      const { result, receipt } = gateReceipt(normal); attempts++;
      receipt.gates[0] = { ...receipt.gates[0], status: "timeout", exit: null, tail: "Focused gate timed out" };
      receipt.progress.nonImproving = attempts; receipt.stalled = attempts >= 3;
      return { ...result, output: JSON.stringify(receipt) };
    }
    return normal();
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(3);
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind)).toEqual(["pause", "pause", "pause"]);
  expect(host.calls.some(call => call.key.includes(".review."))).toBe(false);
  expect(host.history()[0]!.results.at(-1)!.diagnosis).toContain("Three consecutive non-improving");
});

test("the sealer cannot admit a candidate changed after gates", async () => {
  const host = taskFixture(); let changed = false;
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.checkpoint-sealer" && !changed) { changed = true; host.changeCheckout(); }
    return normal();
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain("Sealer candidate differs from the saved gate receipt");
  expect(host.current().lastConfirmed).toBeNull();
  expect(host.calls.filter(call => isGate(call))).toHaveLength(1);
});

test("a transport retry uses a new .rN gate key and keeps the long explicit deadline", async () => {
  const host = taskFixture(); let failed = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (isGate(request) && !failed) { failed = true; return { ...result, ok: false, error: "Transport output unavailable" }; }
    return result;
  });
  expect((await host.execute()).status).toBe("partial");
  const calls = host.calls.filter(call => isGate(call));
  expect(calls[1]!.key).toBe(calls[0]!.key + ".r1");
  expect(calls.every(call => call.timeoutMs === 14400000)).toBe(true);
});

test("v5 retained state is rejected before any resume or dispatch", async () => {
  const host = taskFixture();
  expect((await host.execute()).status).toBe("partial");
  const retained = copy(host.current()); retained.version = 5;
  host.storage.set("invoke-human-1", retained);
  const count = host.calls.length;
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain("incompatible Pitako contract v5; start a new mission");
  expect(host.calls).toHaveLength(count);
});

test("a non-complete worker with passing gates still seals pause", async () => {
  const host = taskFixture(); let paused = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker" && !paused) {
      paused = true; result.structuredOutput.status = "continue";
      result.structuredOutput.knowledge.handoff = "src/change1.ts is the current implementation seam.";
    }
    return result;
  });
  expect((await host.execute()).status).toBe("partial");
  const seals = host.calls.filter(call => call.agent === "pitako.checkpoint-sealer");
  expect(JSON.parse(seals[0]!.task).kind).toBe("pause");
  const continuation = host.calls.filter(call => call.agent === "pitako.worker")[1]!;
  expect(continuation.task).toContain("src/change1.ts is the current implementation seam");
  expect(continuation.task).toContain("previousResult");
});

test.each([false, true])("a no-write complete attempt is admitted as unit (gate continuation: %s)", async continuation => {
  const host = taskFixture();
  let failed = false;
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") return host.result(request,
      { work: "Already satisfied", status: "complete", remaining: [], knowledge: null });
    if (isGate(request) && continuation && !failed) {
      failed = true;
      const { result, receipt } = gateReceipt(normal);
      receipt.gates[0] = { ...receipt.gates[0], status: "fail", exit: 1, tail: "Gate failed" };
      return { ...result, output: JSON.stringify(receipt) };
    }
    return normal();
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  expect(host.history()[0]!.results.at(-1)!.status).toBe("complete");
  expect(host.history()[0]!.cursor).toBe(1);
  const kinds = host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind);
  expect(kinds).toEqual(continuation ? ["pause", "unit"] : ["unit"]);
  // No fabricated journal receipt or confirmed checkpoint for an observed unit.
  expect(host.current().lastConfirmed).toBeNull();
});

test("the gate-before-seal controller is portable through the native workflow sandbox", async () => {
  const host = taskFixture();
  expect((await host.executeNative()).status).toBe("partial");
  expect(host.calls.some(call => isGate(call))).toBe(true);
});


test.each(["selection", "unknown-update", "reused-id"])("invalid director %s ends as gaps and the next fresh director receives its diagnosis", async mode => {
  const host = fixture(); host.setLimit(2);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key.endsWith(".l1.director")) {
      if (mode === "selection") result.structuredOutput.select = "unknown";
      else result.structuredOutput.changes.push(mode === "unknown-update"
        ? { kind: "update", id: "unknown", patch: { goal: "Unknown task" }, reason: "Reconcile" }
        : copy(result.structuredOutput.changes[0]));
    }
    return result;
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(2);
  expect(host.calls.find(call => call.key.endsWith(".l2.director"))!.task).toContain(mode === "selection" ? "Selected task must be pending"
    : mode === "unknown-update" ? "Cannot change unknown task or tombstone" : "Task ID never reused");
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual(["invoke-human-1.l2.t1.a1"]);
  expect(host.history()[0]!.plan.stage).toBe("rejected");
});

test.each(["conflict", "schema", "decisions"])("backlog %s halts without a writer", async mode => {
  const host = taskFixture();
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "prepare" && mode !== "conflict")
      return { ok: false, agent: request.agent, runId: "native-prepare", output: JSON.stringify({ error: "loop-io",
        reason: mode === "schema" ? `${host.root}/.pitako/backlog/spec.json: Invalid tasks` : "DECISION overflow: ask the human to consolidate current Board decisions" }), results: [{ index: 0, agent: request.agent, task: request.task, exitCode: 1,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] };
    const result = normal();
    if (request.agent === "pitako.execution-director" && mode === "conflict") {
      // Human edit after the director's prepared view must not be overwritten.
      const file = `${host.root}/.pitako/backlog/spec.json`;
      const input = result.structuredOutput;
      // A preceding independent human initialization is equivalent to a file appearing between prepare/apply.
      const payload = { version: 1, specId: "spec", authority: { specDigest: "a".repeat(64), amendmentDigests: [] },
        acceptance: input.acceptance, acceptanceHistory: [], lastApplied: null, tasks: input.changes.map((change: any) => change.task) };
      mkdirSync(`${host.root}/.pitako/backlog`, { recursive: true });
      writeFileSync(file, JSON.stringify(payload));
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain(mode === "conflict" ? "backlog-conflict" : mode === "schema" ? "/.pitako/backlog/spec.json: Invalid tasks" : "DECISION overflow");
  expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
});

test("a stalled task is returned to a fresh director with durable progress", async () => {
  const host = fixture(); host.setLimit(2); let attempts = 0;
  host.setRespond((request, normal) => {
    if (isGate(request) && request.key.includes(".l1.")) {
      const { result, receipt } = gateReceipt(normal);
      receipt.gates[0].status = "fail"; receipt.gates[0].exit = 1;
      receipt.progress.nonImproving = ++attempts; receipt.stalled = attempts >= 3;
      return { ...result, output: JSON.stringify(receipt) };
    }
    return normal();
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.calls.find(call => call.key.endsWith(".l2.director"))!.task).toContain("Three consecutive non-improving");
  expect(host.snapshots.some(state => state.loop?.settlement?.receipt && state.loop?.metricSeries?.nonImproving === 3)).toBe(true);
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual([
    "invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2", "invoke-human-1.l1.t1.a3", "invoke-human-1.l2.t1.a1"]);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
});


test("relaunch adopts a human backlog after a digest conflict without reusing its director", async () => {
  const host = fixture(); host.setLimit(2); let edited = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director" && !edited) {
      edited = true;
      const selection = result.structuredOutput;
      const payload = { version: 1, specId: "spec", authority: { specDigest: host.current().association.digest, amendmentDigests: [] },
        acceptance: selection.acceptance, acceptanceHistory: [], lastApplied: null,
        tasks: selection.changes.map((change: any) => ({ ...change.task, goal: "Human backlog goal" })) };
      mkdirSync(`${host.root}/.pitako/backlog`, { recursive: true });
      writeFileSync(`${host.root}/.pitako/backlog/spec.json`, JSON.stringify(payload));
    }
    return result;
  });
  expect((await host.execute()).reason).toContain("backlog-conflict");
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(0);
  expect((await host.execute()).status).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.execution-director").map(call => call.key)).toEqual([
    "invoke-human-1.l1.director", "invoke-human-1.l2.director"]);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]).toMatchObject({ goal: "Human backlog goal", status: "done" });
});


test.each(["pass", "fail", "stale"])("final acceptance %s uses workflow gates before completion", async mode => {
  const host = fixture(); host.setLimit(3);
  let acceptanceRan = false, driftVersion = 0;
  let persistedRepairs: NonNullable<ReturnType<typeof readBacklog>["backlog"]>["tasks"] = [];
  let selectedRepair = null as string | null;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director" && request.key.includes(".l1."))
      result.structuredOutput.acceptance = [{ id: "acceptance", command: mode === "fail"
        ? 'node -e "process.exit(1)"' : "node -e 0", cwd: "." }];
    if (isGate(request) && JSON.parse(request.task).task.id === "final-acceptance") {
      acceptanceRan = true;
      if (mode === "stale") host.changeCheckout(++driftVersion);
    }
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).recordGaps)
      persistedRepairs = copy(readBacklog(host.root, "spec").backlog!.tasks);
    if (request.agent === "pitako.execution-director" && request.key.includes(".l3."))
      selectedRepair = result.structuredOutput.select;
    return result;
  });
  const output = await host.execute();
  expect(acceptanceRan).toBe(true);
  expect(output.status === "complete").toBe(mode === "pass");
  const gate = host.calls.findIndex(call => isGate(call) && JSON.parse(call.task).task.id === "final-acceptance");
  const review = host.calls.findIndex(call => call.key.endsWith("review.director-prepare"));
  if (mode === "pass") expect(review).toBeGreaterThan(gate);
  const repairs = readBacklog(host.root, "spec").backlog!.tasks.filter(task => task.origin.kind === "final-phase");
  if (mode === "fail") {
    expect(review).toBe(-1);
    const pending = persistedRepairs.filter(task => task.origin.kind === "final-phase");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "pending", origin: { kind: "final-phase" },
      specRefs: ["Final acceptance gate acceptance"] });
    expect(pending[0]!.origin.ref).toContain("invoke-human-1.l2.acceptance");
    expect(pending[0]!.origin.ref).toContain("0.log");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ id: pending[0]!.id, status: "done", origin: pending[0]!.origin });
    const director = host.calls.find(call => call.key.endsWith(".l3.director"))!;
    expect(director.task).toContain(`${host.root}/.pitako/backlog/spec.json`);
    expect(selectedRepair).toBe(pending[0]!.id);
    const repair = host.calls.find(call => call.agent === "pitako.worker" && call.key.includes(".l3."))!;
    expect(repair.task).toContain(pending[0]!.id);
    const gapWrite = host.calls.findIndex(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).recordGaps);
    expect(gapWrite).toBeLessThan(host.calls.indexOf(director));
  } else expect(repairs).toEqual([]);
});


test.each(["intact", "missing", "stale"])("final acceptance %s receipt on replay cannot authorize stale completion", async mode => {
  const host = fixture(undefined, { taskCount: 0 }); host.setLimit(1);
  host.setFailSave(value => value.loop?.phase === "closing");
  expect((await host.execute()).status).toBe("partial");
  const retained = copy(host.current());
  expect(retained.loop.kind).toBe("final");
  expect(retained.loop.finalAttempt.gate.stage).toBe("receipt");
  if (mode === "missing") delete retained.loop.finalAttempt.gate.receipt;
  if (mode === "stale") {
    retained.loop.finalAttempt.gate.receipt.before.fingerprint = "f".repeat(64);
    retained.loop.finalAttempt.gate.receipt.after.fingerprint = "f".repeat(64);
  }
  host.storage.set("invoke-human-1", retained);
  host.setFailSave(undefined);
  const gates = host.calls.filter(isGate).length;
  const output = await host.execute();
  expect(output.status === "complete").toBe(mode === "intact");
  expect(host.calls.filter(isGate)).toHaveLength(gates);
  expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
});


test.each(["timeout", "error"])("final acceptance %s blocks as environment with logs and no repair task", async status => {
  const host = fixture(undefined, { taskCount: 0 }); host.setLimit(2);
  host.setRespond((request, normal) => {
    if (isGate(request)) {
      const { result, receipt } = gateReceipt(normal);
      receipt.gates[0] = { ...receipt.gates[0], status, exit: null, logRef: "/owned/final-suite.log" };
      return { ...result, output: JSON.stringify(receipt) };
    }
    return normal();
  });
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain("environment failure");
  expect(output.reason).toContain("/owned/final-suite.log");
  expect(host.current().loop.halt.code).toBe("environment");
  expect(host.calls.some(call => call.agent === "pitako.worker" || call.key.includes(".review.") || call.key.endsWith(".compliance"))).toBe(false);
  expect(readBacklog(host.root, "spec").backlog!.tasks).toEqual([]);
});

test.each(["review", "compliance"])("final-phase %s findings become durable tasks for the next director", async phase => {
  const host = fixture(undefined, { taskCount: 0, findings: true }); host.setLimit(3);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key.includes(".l1.")) {
      if (phase === "review" && request.key.endsWith("director-synthesis")) {
        result.structuredOutput.screening.verdict = "material-gaps";
        result.structuredOutput.screening.reason = "Required observable behavior missing";
        result.structuredOutput.screening.assessments[0].material = true;
      }
      if (phase === "compliance" && request.key.endsWith(".compliance")) {
        result.structuredOutput.status = "gaps";
        result.structuredOutput.reason = "Required observable behavior missing";
        result.structuredOutput.requirements[0].status = "gap";
      }
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status).toBe("complete");
  const backlog = readBacklog(host.root, "spec").backlog!;
  expect(backlog.tasks).toHaveLength(1);
  expect(backlog.tasks[0]).toMatchObject({ status: "done", origin: { kind: "final-phase" } });
  expect(backlog.tasks[0]!.origin.ref).toContain(phase === "review" ? ".review." : ".compliance");
  expect(host.calls.filter(call => call.agent === "pitako.execution-director")).toHaveLength(3);
  expect(host.calls.filter(call => call.agent === "pitako.worker").every(call => call.key.includes(".l2."))).toBe(true);
  expect(host.calls.some(call => call.key.includes(".l2.review.") || call.key === "invoke-human-1.l2.compliance")).toBe(false);
  if (phase === "review") expect(host.calls.some(call => call.key === "invoke-human-1.l1.compliance")).toBe(false);
  const repair = host.calls.find(call => call.agent === "pitako.worker")!;
  const gapWrite = host.calls.findIndex(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).recordGaps);
  expect(gapWrite).toBeLessThan(host.calls.indexOf(repair));
});

test("final review receives done and obsolete reasons, current DECISIONs, and follows acceptance", async () => {
  const host = fixture(); host.setLimit(2);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key.endsWith(".l1.director")) {
      const task = copy(result.structuredOutput.changes[0].task); task.id = "obsolete-task";
      result.structuredOutput.changes.push({ kind: "add", task, reason: "Initial requirement" },
        { kind: "obsolete", id: task.id, reason: "Superseded by selected implementation" });
    }
    if (isGate(request)) {
      const receipt = JSON.parse(result.output!);
      receipt.view.posts = [{ id: 1, type: "DECISION", content: "Keep required boundary validation" }];
      result.output = JSON.stringify(receipt);
    }
    return result;
  });
  expect((await host.execute()).status).toBe("complete");
  const review = host.calls.find(call => call.key.endsWith("review.director-prepare"))!;
  expect(review.task).toContain("Workflow-confirmed gated unit");
  expect(review.task).toContain("Superseded by selected implementation");
  expect(review.task).toContain("Keep required boundary validation");
  const gateIndex = host.calls.findIndex(call => isGate(call) && JSON.parse(call.task).task.id === "final-acceptance");
  expect(host.calls.indexOf(review)).toBeGreaterThan(gateIndex);
  expect(host.calls.findIndex(call => call.key.endsWith(".compliance"))).toBeGreaterThan(host.calls.indexOf(review));
  expect(host.current().consumedLoops).toBe(2);
});
