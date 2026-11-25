import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openSqliteSync } from "../extensions/board/sqlite.ts";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { PitakoStore } from "../extensions/pitako-store.ts";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";
import { executeControllerFixture, closedInterruptedProducer, copy, cutAt, gaps, nativeRunId, type Result } from "./fixtures/execute-workflow.ts";
import { gitFakeBootstrap } from "./fixtures/git-fake-env.ts";

const { fixture } = executeControllerFixture();
const phases = [
  { step: "task-reviewer", target: "invoke-human-1.l1.t1.a1.task-reviewer", taskCount: 1 },
  { step: "task-synthesis", target: "invoke-human-1.l1.t1.a1.task-synthesis", taskCount: 1 },
  { step: "final-review", target: "invoke-human-1.l1.review.director-prepare", taskCount: 0 },
  { step: "final-review", target: "invoke-human-1.l1.review.independent-angle1-r1", taskCount: 0 },
  { step: "final-review", target: "invoke-human-1.l1.review.director-synthesis", taskCount: 0 },
  { step: "compliance", target: "invoke-human-1.l1.compliance", taskCount: 0 },
  { step: "demand-observation", target: "invoke-human-1.l2.demand-observation", taskCount: 0 },
];
function timedOut(result: Result): Result {
  const value = { ...result, ok: false, state: "complete", error: "Native deadline",
    results: result.results?.map(entry => ({ ...entry, timedOut: true, exitCode: 1 })) };
  delete value.structuredOutput;
  return value;
}
function generation(target: string, n: number) {
  return target.replace(/\.(task-reviewer|task-synthesis|demand-observation|compliance|review\.)/, `.g${n}.$1`);
}
function expectRetired(host: ReturnType<typeof setup>, phase: typeof phases[number], target = phase.target) {
  const ref = { key: target, runId: nativeRunId(target) };
  const records = host.records().filter((record: any) => record.kind === "loop");
  if (phase.step === "final-review" || phase.step === "compliance") {
    const record = records.find((record: any) => record.loop === 1);
    const producers = phase.step === "final-review" ? record?.body.integratedReview.originals
      : [record?.body.compliance?.original];
    expect(host.native.get(target)?.runId).toBe(ref.runId);
    expect(producers).not.toContainEqual(expect.objectContaining(ref));
    expect(producers).toContainEqual(expect.objectContaining({ key: generation(target, 2), runId: nativeRunId(generation(target, 2)) }));
    return;
  }
  expect(records.some((record: any) => record.body.retired?.some((entry: any) =>
    entry.key === ref.key && entry.runId === ref.runId))).toBe(true);
}
function setup(phase: typeof phases[number], mode = "timeout", untilGeneration = 2) {
  const host = fixture(undefined, { taskCount: phase.taskCount });
  // Status-query success is distinct from the failed producer's result.
  host.setStatus(ref => {
    if (ref === nativeRunId(phase.target))
      return { ok: true, runId: ref, results: [], output: `Run: ${ref}\nState: failed` };
    const original = host.native.get(ref);
    if (!original) throw Error("Run not found. Provide id or runId.");
    return { state: "complete", ...copy(original), ok: true };
  });
  host.setRespond((request, normal) => {
    if (phase.step === "demand-observation" && request.key === "invoke-human-1.l1.compliance") return gaps(normal());
    if (mode === "verifier-busy" && request.key === "invoke-human-1.l1.g2.review.verify-synthesis")
      return { ok: true, agent: request.agent, runId: nativeRunId(request.key),
        output: JSON.stringify({ v: 1, code: "store-busy" }), results: [{ exitCode: 0 }] } as Result;
    const value = normal();
    if (request.key !== phase.target &&
        !(untilGeneration === 3 && request.key === generation(phase.target, 2))) return value;
    const failure = timedOut(value);
    if (mode === "error") { failure.results!.forEach(entry => delete entry.timedOut); }
    if (mode === "reason") {
      failure.results!.forEach(entry => delete entry.timedOut);
      failure.terminalOutcome = { state: "partial", reason: "timeout" };
    }
    if (mode === "stop") failure.stopped = true;
    if (mode === "interrupted") failure.interrupted = true;
    if (mode === "denial") failure.error = "Blocked by pi-subagents permission rule: 'run' is denied.";
    if (mode === "active") failure.state = "running";
    return failure;
  });
  return host;
}

function recoverSibling(host: ReturnType<typeof setup>, sibling: string, mode = "") {
  const { missionPath } = host.admitted().association;
  const mission = JSON.parse(readFileSync(missionPath, "utf8"));
  const children: any[] = mission.workflowChildren;
  const child = children.find(child => child.key === sibling);
  expect(child?.runId).toBe(nativeRunId(sibling));
  if (mode === "missing-reference") children.splice(children.indexOf(child), 1);
  if (mode === "wrong-key") child.key = "foreign";
  if (mode === "wrong-agent") child.agent = "pitako.worker";
  if (mode === "missing-run") delete child.runId;
  if (mode === "conflicting-reference") children.push({ ...child, runId: nativeRunId("foreign") });
  writeFileSync(missionPath, JSON.stringify(mission));
}

test.each([
  ...phases.map(phase => ({ ...phase, renewal: "completes" })),
  { ...phases[0]!, renewal: "stops" },
])("$target: timeout freezes launch, strict raise renews only its step ($renewal)", async phase => {
  const host = setup(phase);
  const first = await host.executeNative();
  expect(first.status, first.reason).toBe("partial");
  expect(first.loopReport.halt).toMatchObject({ code: "timeout", class: phase.step,
    key: phase.target, launchedMs: 14400000, status: "partial" });
  expect(host.current().halt).toEqual({ stage: "timeout", digest: canonicalDigest(first.loopReport.halt) });
  expect(host.current().action).toMatchObject({ key: phase.target, runId: nativeRunId(phase.target) });
  expect(first.action).toMatchObject({ actor: "foreground", started: false });
  expect(first.action.operation).toContain("args.timeouts.reviewerMs strictly greater than 14400000");
  expect(first.loopReport.action).toEqual(first.action);
  const count = host.calls.length;
  const writes = host.snapshots.length;
  const saved = JSON.stringify(host.current(), null, 2);
  for (const reviewerMs of [14400000, 1]) {
    const unchanged = await host.executeNative({ timeouts: { reviewerMs } });
    expect(unchanged.status, unchanged.reason).toBe("partial");
    expect(unchanged.loopReport.halt).toEqual(first.loopReport.halt);
    expect(JSON.stringify(host.current(), null, 2)).toBe(saved);
    expect(host.snapshots).toHaveLength(writes);
    expect(host.calls).toHaveLength(count);
  }
  const fresh = generation(phase.target, 2);
  if (phase.renewal === "stops") {
    const admissions = host.launches.length;
    let launchHead: { seq: number; hash: string } | undefined;
    host.setLaunchRespond(async (request, normal) => {
      if (request.key !== fresh) return normal();
      launchHead = copy(host.current().head);
      return closedInterruptedProducer(await normal());
    });
    const stopped = await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
    expect(stopped.status, stopped.reason).toBe("cancelled");
    const held = copy(host.current());
    expect(launchHead).toBeDefined();
    expect(held.head).toEqual(launchHead);
    expect(held.action).toMatchObject({ kind: "launched", role: "reviewer", key: fresh, runId: nativeRunId(fresh) });
    expect(held.halt.digest).toBe(canonicalDigest(stopped.loopReport.halt));
    expect(host.launches.slice(admissions).map(call => call.key)).toEqual([fresh]);
    const launches = host.launches.length, calls = host.calls.length, writes = host.snapshots.length;
    const relaunched = await host.executeNative();
    expect(relaunched.status, relaunched.reason).toBe("cancelled");
    expect(relaunched.loopReport.halt).toEqual(stopped.loopReport.halt);
    expect(host.current()).toEqual(held);
    expect(host.launches).toHaveLength(launches);
    expect(host.calls).toHaveLength(calls);
    expect(host.snapshots).toHaveLength(writes);
    return;
  }
  const resumed = await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
  expect(resumed.status, resumed.reason).toBe("complete");
  expect(host.calls.filter(call => call.key === fresh)).toHaveLength(1);
  expect(host.calls.find(call => call.key === fresh)!.timeoutMs).toBe(14400001);
  expect(host.calls.filter(call => call.key === phase.target)).toHaveLength(1);
  const settledWork = new Set(host.calls.slice(0, count)
    .filter(call => call.agent === "pitako.worker" || call.agent === "pitako.execution-director").map(call => call.key));
  expect(host.calls.slice(count).some(call => settledWork.has(call.key))).toBe(false);
  const loop = host.history().find((loop: { number: number }) => loop.number === (phase.step === "demand-observation" ? 2 : 1))!;
  expectRetired(host, phase);
  if (phase.step === "task-synthesis")
    expect(host.calls.filter(call => call.key.endsWith(".task-reviewer"))).toHaveLength(1);
  if (phase.step === "final-review") {
    expect(loop.integratedReview.namespace).toContain(".g2.review.");
    expect([...host.storage.keys()].some(key => key.startsWith("review-"))).toBe(false);
    expect(host.calls.some(call => call.agent === "pitako.access-verifier" && call.key.includes(".g2.review."))).toBe(true);
  }
});

test.each(phases.flatMap(phase => ["error", "stop", "interrupted", "denial", "active"].map(mode => ({ ...phase, mode }))))(
  "$target: $mode is not an operational timeout", async phase => {
    const host = setup(phase, phase.mode);
    const first = await host.executeNative();
    expect(first.status).not.toBe("complete");
    expect(host.current().halt?.stage).not.toBe("timeout");
    const count = host.calls.length;
    expect((await host.executeNative({ timeouts: { reviewerMs: 86400000 } })).status).not.toBe("complete");
    expect(host.calls.slice(count).filter(call => call.agent !== "pitako.loop-io")).toHaveLength(0);
  });

test.each(phases)("$target: retirement save cuts preserve one fresh launch", async phase => {
  const host = setup(phase, "reason");
  const sibling = phase.target.replace("angle1-r1", "angle1-r2");
  const rejectedSibling = phase.target === phases[3]!.target;
  if (rejectedSibling) host.setLaunchRespond((request, normal) => {
    if (request.key !== sibling) return normal();
    const error = new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: `workflow[${request.key}]`,
      used: 64, limit: 64, requested: 1, remaining: 0 }).message;
    return { key: request.key, ok: false, error, output: error, artifactPaths: [] };
  });
  const first = await host.executeNative();
  expect(first.status).toBe("partial");
  if (rejectedSibling) {
    expect(first.action).toMatchObject({ actor: "foreground", started: false });
    expect(first.action.operation).toContain("args.timeouts.reviewerMs strictly greater than 14400000");
    expect(first.loopReport.action).toEqual(first.action);
    expect(host.current().budget.rejectedKeys).toContain(canonicalDigest(sibling));
    const count = host.calls.length;
    expect((await host.executeNative({ timeouts: { reviewerMs: 14400000 } })).status).toBe("partial");
    expect(host.calls).toHaveLength(count);
    host.setStatus(ref => {
      expect(ref).not.toBe(sibling);
      expect(ref).not.toBe(nativeRunId(sibling));
      return { state: "complete", ...copy(host.native.get(ref)!), ok: true };
    });
  }
  const count = host.calls.length;
  const timedOutCursor = copy(host.current());
  cutAt(host, value => value.halt?.digest === timedOutCursor.halt.digest &&
    value.timeouts.reviewerMs === 14400001);
  const interrupted = await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
  expect(interrupted.status, interrupted.reason).toBe("partial");
  expect(host.calls).toHaveLength(count);
  host.setFailSave();
  expect(host.current()).toEqual(timedOutCursor);
  expect((await host.executeNative({ timeouts: { reviewerMs: 14400001 } })).status).toBe("complete");
  expect(host.calls.filter(call => call.key === generation(phase.target, 2))).toHaveLength(1);
  if (rejectedSibling) {
    expect(host.calls.filter(call => call.key === generation(sibling, 2))).toHaveLength(1);
    expect(host.history().find((loop: { number: number }) => loop.number === 1)!.integratedReview.namespace).toContain(".g2.review.");
    expect([...host.storage.keys()].some(key => key.startsWith("review-"))).toBe(false);
    expect(host.calls.some(call => call.agent === "pitako.access-verifier" && call.key.includes(".g2.review."))).toBe(true);
    expect(host.native.get(sibling)?.runId).toBeUndefined();
    expect(host.history()[0]!.integratedReview.originals).toContainEqual(expect.objectContaining({
      key: generation(sibling, 2), runId: nativeRunId(generation(sibling, 2)),
    }));
  }
});

test.each([...phases, { ...phases[3]!, target: phases[3]!.target.replace("angle1-r1", "angle1-r2") }]
  .flatMap(phase => ["timeout", "reason"].map(mode => ({ ...phase, mode }))))(
  "$target: $mode survives a cut immediately after the first receipt save", async phase => {
    const host = setup(phase, phase.mode);
    let cut = false;
    host.setSaveObserver(value => {
      if (cut || value.halt?.stage !== "timeout" || value.action?.key !== phase.target) return;
      cut = true;
      host.setFailSave(() => true);
      throw new Error("Controlled post-receipt persistence cut");
    });
    const interrupted = await host.executeNative();
    expect(interrupted.status, interrupted.reason).toBe("partial");
    expect(cut).toBe(true);
    const cursor = copy(host.current());
    expect(cursor.action).toMatchObject({ key: phase.target, runId: nativeRunId(phase.target) });
    expect(cursor.halt.stage).toBe("timeout");
    expect(host.native.get(phase.target)).toMatchObject({
      runId: cursor.action.runId,
      ...(phase.mode === "reason" ? { terminalOutcome: { reason: "timeout" } } :
        { results: [expect.objectContaining({ timedOut: true })] }),
    });
    const count = host.calls.length;
    host.setSaveObserver(undefined);
    host.setFailSave();
    if (phase.target.endsWith("independent-angle1-r1"))
      recoverSibling(host, phase.target.replace("angle1-r1", "angle1-r2"));
    host.setStatus(ref => {
      // A fresh native root cannot resolve workflow keys through its empty child map.
      expect(ref).toMatch(/^[\da-f-]{36}$/);
      if (phase.step !== "final-review" && ref !== nativeRunId(phase.target))
        return { state: "complete", ...copy(host.native.get(ref)!), ok: true };
      // Terminal native management receipts contain neither launch results nor an agent.
      const label = phase.mode === "timeout" ? "Nested run" : "Run";
      const state = ref === nativeRunId(phase.target) ? "failed" : "complete";
      return { ok: true, runId: ref, results: [], output: `${label}: ${ref}\nState: ${state}` };
    });
    expect((await host.executeNative({ timeouts: { reviewerMs: 14400000 } })).status).toBe("partial");
    expect(host.calls).toHaveLength(count);
    if (phase.target.endsWith("independent-angle1-r1")) {
      cutAt(host, value => value.halt?.digest === cursor.halt.digest && value.timeouts.reviewerMs === 14400001);
      expect((await host.executeNative({ timeouts: { reviewerMs: 14400001 } })).status).toBe("partial");
      expect(host.calls).toHaveLength(count);
      expect(host.current()).toEqual(cursor);
      host.setFailSave();
    }
    const resumed = await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
    expect(resumed.status, resumed.reason).toBe("complete");
    expect(host.calls.filter(call => call.key === generation(phase.target, 2))).toHaveLength(1);
    expect(host.calls.filter(call => call.key === phase.target)).toHaveLength(1);
    if (phase.target.endsWith("independent-angle1-r1")) {
      const sibling = phase.target.replace("angle1-r1", "angle1-r2");
      expectRetired(host, phase, sibling);
    }
    const settled = new Set(host.calls.slice(0, count)
      .filter(call => phase.step !== "final-review" || !call.key.includes(".review."))
      .map(call => call.key));
    expect(host.calls.slice(count).some(call => settled.has(call.key))).toBe(false);
  });

  test.each(["nonterminal", "wrong-key", "wrong-agent", "missing-run", "missing-reference", "conflicting-reference", "stopped", "unidentified-receipt"])(
  "unresolved review sibling requires exact terminal producer evidence: %s", async mode => {
    const phase = phases[3]!, host = setup(phase);
    const sibling = phase.target.replace("angle1-r1", "angle1-r2");
    if (mode === "unidentified-receipt") host.setLaunchRespond((request, normal) => request.key === sibling
      ? { key: request.key, ok: false, error: "Transport lost", output: "Transport lost", artifactPaths: [] } : normal());
    let cut = false;
    host.setSaveObserver(value => {
      if (mode === "unidentified-receipt" || cut || value.halt?.stage !== "timeout") return;
      cut = true;
      host.setFailSave(() => true);
      throw new Error("Controlled post-receipt persistence cut");
    });
    await host.executeNative();
    expect(cut).toBe(mode !== "unidentified-receipt");
    const saved = copy(host.current());
    expect(saved.halt.stage).toBe("timeout");
    expect(saved.action).toMatchObject({ key: phase.target, runId: nativeRunId(phase.target) });
    expect(host.launches.filter(call => call.key === sibling)).toHaveLength(1);
    host.setSaveObserver(undefined);
    host.setFailSave();
    if (mode !== "unidentified-receipt") recoverSibling(host, sibling, mode);
    host.setStatus(ref => {
      expect(ref).toMatch(/^[\da-f-]{36}$/);
      const value: Result = { ok: true, runId: ref, results: [], state: "complete" };
      if (ref !== nativeRunId(sibling)) return value;
      if (mode === "nonterminal") value.state = "unknown";
      if (mode === "stopped") value.stopped = true;
      return value;
    });
    const count = host.calls.length;
    if (mode === "missing-run") {
      for (const reviewerMs of [14400000, 1]) {
        const unchanged = await host.executeNative({ timeouts: { reviewerMs } });
        expect(unchanged.status, unchanged.reason).toBe("partial");
        expect(unchanged.reason).toContain("Relaunch with args.timeouts");
        expect(host.current().halt).toEqual(saved.halt);
        expect(host.calls).toHaveLength(count);
      }
    }
    const resumed = await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
    expect(resumed.status).not.toBe("complete");
    expect(host.calls).toHaveLength(count);
    expect(host.launches.some(call => call.key === generation(sibling, 2))).toBe(false);
    if (mode === "stopped") expect(host.current().halt.stage).toBe("native-barrier");
    else if (["nonterminal", "wrong-key", "missing-run", "missing-reference", "unidentified-receipt"].includes(mode)) {
      expect(resumed.status).toBe("partial");
      expect(host.current().halt.stage).toBe("timeout");
      expect(resumed.reason).toContain("reconcile the retained producers");
      expect(resumed.reason).not.toContain("Relaunch with args.timeouts");
      expect(resumed.action.operation).toContain("reconcile the retained producers");
      expect(resumed.action.operation).toContain("No replacement dispatched");
    }
  });

test.each(phases.flatMap(phase =>
  (phase.step === "final-review" ? [2, 3] : [2]).map(renewal => ({ phase, renewal, target: phase.target }))))(
"$target: durable retirement replays generation $renewal after a launch-intention cut", async ({ phase, renewal }) => {
  const busyVerifier = renewal === 2 && phase.target.endsWith(".review.director-synthesis");
  const mode = busyVerifier ? "verifier-busy" : "timeout";
  const host = setup(phase, mode, renewal);
  await host.executeNative();
  if (renewal === 3)
    expect((await host.executeNative({ timeouts: { reviewerMs: 14400001 } })).status).toBe("partial");
  const fresh = generation(phase.target, renewal);
  const earlyReview = phase.step === "final-review";
  if (earlyReview) host.setSaveObserver(value => {
    if (value.action?.key !== fresh || value.action.runId !== null) return;
    host.setFailSave(() => true);
    throw Error("Controlled post-intention cut before native dispatch");
  });
  else cutAt(host, value => value.action?.key === fresh && value.action.runId === null);
  expect((await host.executeNative({ timeouts: { reviewerMs: 14399999 + renewal } })).status).toBe("partial");
  expect(host.launches.some(call => call.key === fresh)).toBe(false);
  const cursor = copy(host.current());
  const gates = host.gateExecutions();
  host.setSaveObserver(undefined);
  host.setFailSave();
  const resumed = await host.executeNative();
  expect(resumed.status, resumed.reason).toBe("complete");
  if (earlyReview) {
    const prepare = generation(phases[2]!.target, renewal);
    expect(host.native.get(prepare)?.runId).toBe(nativeRunId(prepare));
    expect(cursor.action).toMatchObject({ key: fresh, runId: null });
    expect(cursor.review.generation).toBe(renewal);
    expect(host.gateExecutions()).toBe(gates);
    // The uninterrupted control measures root dispatches; only the cut and replay need the native runner.
    const uninterrupted = setup(phase, mode, renewal);
    await uninterrupted.execute();
    for (let generation = 2; generation <= renewal; generation++) {
      const next = await uninterrupted.execute({ timeouts: { reviewerMs: 14399999 + generation } });
      expect(next.status, next.reason).toBe(generation === renewal ? "complete" : "partial");
    }
    const admissions = (host: ReturnType<typeof setup>) => host.launches.map(({ agent, key }) => `${agent}:${key}`).sort();
    expect(admissions(host)).toEqual([...admissions(uninterrupted), "pitako.loop-io:invoke-human-1.l1.acceptance.gate.r1"].sort());
    if (busyVerifier) {
      const verifier = host.launches.filter(call => call.agent === "pitako.access-verifier" && call.key.includes(".g2.review."));
      expect(verifier.map(call => call.key)).toEqual([
        "invoke-human-1.l1.g2.review.verify-synthesis", "invoke-human-1.l1.g2.review.verify-synthesis.store.r1",
      ]);
      expect(verifier[1]!.task).toBe(verifier[0]!.task);
      expect(host.launches.some(call => call.agent === "pitako.store-io")).toBe(false);
    }
    return;
  }
  expect(host.calls.filter(call => call.key === fresh)).toHaveLength(1);
  expect(host.calls.filter(call => call.key === phase.target)).toHaveLength(1);
  expect(host.calls.some(call => call.key === generation(phase.target, 3))).toBe(false);
  expectRetired(host, phase);
});

test.each(phases)("$target: no fourth generation", async phase => {
  const host = setup(phase);
  host.setRespond((request, normal) => {
    if (phase.step === "demand-observation" && request.key === "invoke-human-1.l1.compliance") return gaps(normal());
    return [phase.target, generation(phase.target, 2), generation(phase.target, 3)].includes(request.key)
      ? timedOut(normal()) : normal();
  });
  for (const reviewerMs of [14400000, 14400001, 14400002])
    expect((await host.executeNative({ timeouts: { reviewerMs } })).status).toBe("partial");
  const count = host.calls.length;
  const capped = await host.executeNative({ timeouts: { reviewerMs: 14400003 } });
  expect(capped.status).toBe("partial");
  expect(capped.reason).toContain("new invocation");
  expect(capped.action.actor).toBe("foreground");
  expect(capped.action.operation).toContain("new invocation");
  expect(host.calls).toHaveLength(count);
});

test.each(["needs-decision", "capacity", "native-barrier"])(
  "timeout overrides preserve %s halts", async code => {
    const phase = phases[5]!;
    const host = code === "needs-decision" ? fixture() : setup(phase, "stop");
    if (code === "capacity") host.setLaunchRespond((request, normal) => {
      if (request.key === phase.target) throw new Error("Active async run capacity exhausted: 1/1 used.");
      return normal();
    });
    if (code === "needs-decision") {
      const attempts = new Map<string, number>();
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key.endsWith(".l2.director")) result.structuredOutput.changes.push({
          kind: "update", id: "change1", patch: { goal: "Narrow the first stalled task" }, reason: "Address first stall",
        });
        if (/\.t1\.a\d+\.gate$/.test(request.key)) {
          const loop = request.key.split(".")[1]!;
          const n = (attempts.get(loop) ?? 0) + 1;
          attempts.set(loop, n);
          const receipt = JSON.parse(result.output!);
          Object.assign(receipt.gates[0], { status: "fail", exit: 1 });
          Object.assign(receipt, { stalled: n >= 3 });
          receipt.progress.nonImproving = n;
          result.output = JSON.stringify(receipt);
        }
        return result;
      });
    }
    const first = await host.executeNative();
    expect(first.loopReport.halt?.code, first.reason).toBe(code);
    const cursor = copy(host.current());
    expect(cursor.halt.digest).toBe(canonicalDigest(first.loopReport.halt));
    const count = host.launches.length;
    const resumed = await host.executeNative({ timeouts: { reviewerMs: 86400000 } });
    expect(resumed.status, resumed.reason).toBe(first.status);
    expect(resumed.action.operation).not.toContain("args.timeouts");
    expect(resumed.loopReport.halt).toEqual(first.loopReport.halt);
    expect(host.current()).toEqual(cursor);
    expect(host.launches).toHaveLength(count);
  });

test("timeout overrides cannot clear a verified host observation halt", async () => {
  const phase = phases[5]!, host = fixture(undefined, { taskCount: phase.taskCount });
  host.setSaveObserver(value => {
    if (value.action?.key !== phase.target || !value.action.runId) return;
    host.setFailSave(() => true);
    throw new Error("Controlled cut after compliance settlement");
  });
  expect((await host.executeNative()).reason).toContain("Essential persistence failed");
  host.setFailSave();
  host.setSaveObserver(undefined);
  const cursor = copy(host.current());
  host.setHostResponse(() => { throw new Error("Controlled host observation failure"); });
  const blocked = await host.executeNative();
  const held = copy(host.current());
  expect(blocked.status, blocked.reason).toBe("blocked");
  expect(blocked.reason).toContain("Controlled host observation failure");
  expect(held).toMatchObject({ budget: cursor.budget, hostHalt: {
    stage: "host", digest: expect.stringMatching(/^[a-f0-9]{64}$/), reason: blocked.reason,
  } });
  host.setHostResponse();
  const count = host.launches.length;
  const inspections = host.hostCalls.length;
  expect(await host.executeNative({ timeouts: { reviewerMs: 86400000 } })).toEqual(blocked);
  expect(host.current()).toEqual(held);
  expect(host.launches).toHaveLength(count);
  expect(host.hostCalls).toHaveLength(inspections);
});

test.each(["nonterminal", "foreign-producer", "status-stop",
  "remembered-foreground", "foreign-management-run", "failed-status-stop"])(
  "retained timeout cannot bypass %s", async mode => {
    const phase = phases[5]!, host = setup(phase);
    await host.executeNative();
    host.setStatus(ref => {
      const result = copy(host.native.get(ref)!);
      if (ref !== nativeRunId(phase.target)) return result;
      if (mode === "remembered-foreground")
        return { ok: true, runId: ref, results: [],
          output: `Run: ${ref}\nState: remembered foreground\n1. pitako.reviewer failed, exit 1` };
      if (mode === "foreign-management-run")
        return { ok: true, runId: ref, results: [], output: "Run: foreign\nState: failed" };
      if (mode === "failed-status-stop")
        return { ok: true, runId: ref, results: [],
          output: `Run: ${ref}\nState: failed\n1. pitako.reviewer stopped, exit 1` };
      if (mode === "foreign-producer") result.runId = "foreign";
      if (mode === "nonterminal") result.state = "unknown";
      if (mode === "nonterminal") result.results = [];
      if (mode === "status-stop") result.stopped = true;
      return result;
    });
    const count = host.calls.length;
    const resumed = await host.executeNative({ timeouts: { reviewerMs: 86400000 } });
    expect(resumed.status).not.toBe("complete");
    if (["status-stop", "failed-status-stop"].includes(mode)) {
      if (mode !== "status-stop") expect(resumed.action.actor).not.toBe("foreground");
      expect(resumed.action.operation).not.toContain("Relaunch with args.timeouts");
    }
    expect(host.calls).toHaveLength(count);
  });

test.each([
  { phase: phases[0]!, cause: "stopped", mode: "nested" },
  { phase: phases[0]!, cause: "stopped", mode: "late exception" },
  { phase: phases[0]!, cause: "status unavailable", mode: "late exception" },
  { phase: phases[1]!, cause: "native permission denial", mode: "exception" },
  { phase: phases[6]!, cause: "interrupted", mode: "exception" },
  { phase: phases[5]!, cause: "stopped", mode: "nested" },
  ...[phases[0]!, phases[1]!, phases[6]!].flatMap(phase => [
    { phase, cause: "status unavailable", mode: "exception" },
    ...["stopped", "interrupted", "native permission denial", "status unavailable"].map(cause =>
      ({ phase, cause, mode: "store failure" })),
  ]),
])("$phase.step: timeout replay retains $cause ($mode) as terminal", async ({ phase, cause, mode }) => {
  const host = setup(phase);
  const first = await host.executeNative();
  expect(first.loopReport.halt?.code).toBe("timeout");
  const timeoutCursor = copy(host.current());
  const launches = host.launches.length, calls = host.calls.length;
  const storeFailure = mode === "store failure";
  if (storeFailure) host.setHostResponse((key, value) => key === "inspect-initial"
    ? { ...value, storeFailure: { code: "store-busy", reason: "Store remained busy." } } : value);
  const status = (ref: string) => ({ ...copy(host.native.get(ref)!), ok: true, state: "complete" });
  let observations = 0;
  host.setStatus(ref => {
    const result = status(ref);
    if (ref !== nativeRunId(phase.target)) return result;
    ++observations;
    if (mode === "late exception" && observations === 1) return result;
    if (mode === "nested" || storeFailure && cause === "stopped")
      return { ...result, results: [{ ...result.results![0]!, stopped: true, exitCode: 1 }] };
    throw new Error(cause === "native permission denial"
      ? "Blocked by pi-subagents permission rule: 'status' is denied."
      : cause === "status unavailable" ? "Controlled status unavailable."
      : `Status '${ref}' failed: Run: ${ref}\nState: ${cause}`);
  });
  const held = await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
  expect(observations, held.reason).toBeGreaterThan(0);
  expect(held.status, held.reason).toBe(["stopped", "interrupted"].includes(cause) ? "cancelled" : "blocked");
  const heldCursor = copy(host.current());
  if (phase.step === "compliance") {
    expect(heldCursor.halt.stage).toMatch(/^native-(?:barrier|settlement)$/);
  } else if (storeFailure || cause === "status unavailable") {
    expect(held.loopReport?.halt).toMatchObject({ status: held.status,
      reason: expect.stringContaining(cause === "native permission denial" ? "permission denial" : cause),
      ref: { key: phase.target, runId: nativeRunId(phase.target) } });
    expect(heldCursor.hostHalt?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(heldCursor).toEqual({ ...timeoutCursor, hostHalt: heldCursor.hostHalt });
  } else {
    expect(held.loopReport?.halt).toMatchObject({ code: "native-barrier", cause,
      ref: { key: phase.target, runId: nativeRunId(phase.target) },
      timeoutDigest: timeoutCursor.halt.digest });
    expect(heldCursor.halt).toMatchObject({ digest: canonicalDigest(held.loopReport.halt) });
    expect(heldCursor).toEqual({ ...timeoutCursor, halt: heldCursor.halt });
  }
  expect(host.launches).toHaveLength(launches);
  expect(host.calls).toHaveLength(calls);
  const writes = host.snapshots.length;
  host.setStatus(status);
  host.setHostResponse();
  const resumed = await host.executeNative(phase.step === "compliance" ? { timeouts: { reviewerMs: 86400000 } } : {});
  if (phase.step !== "compliance") {
    expect(resumed).toEqual(held);
    expect(host.current()).toEqual(heldCursor);
    expect(host.snapshots).toHaveLength(writes);
    if (phase.step === "task-synthesis" && mode === "exception" && cause === "native permission denial") {
      await host.state.set("pitako-execute", { ...heldCursor, halt: { ...heldCursor.halt, digest: timeoutCursor.halt.digest } });
      const corrupt = await host.executeNative({ timeouts: { reviewerMs: 86400000 } });
      expect(corrupt.status).toBe("blocked");
      expect(corrupt.reason).toContain("Reviewer renewal barrier integrity mismatch");
      expect(host.snapshots).toHaveLength(writes + 1);
    }
  }
  expect(host.launches).toHaveLength(launches);
  expect(host.calls).toHaveLength(calls);
});

test.each(["stopped", "cancelled", "budget_exhausted"] as const)(
  "a native %s outcome wins over simultaneous timeout evidence", async reason => {
    const phase = phases[5]!, host = setup(phase);
    host.setRespond((request, normal) => request.key === phase.target
      ? Object.assign(timedOut(normal()), { terminalOutcome: { state: "partial", reason } }) : normal());
    await host.executeNative();
    expect(host.current().halt.stage).toMatch(/^native-(?:barrier|settlement)$/);
    const count = host.calls.length;
    await host.executeNative({ timeouts: { reviewerMs: 86400000 } });
    expect(host.calls).toHaveLength(count);
  });

test("integrated review resumes past exhausted verifier keys on the final authorized loop", async () => {
  const host = fixture(undefined, { taskCount: 0 });
  host.setLimit(1);
  let busy = true;
  const cached = new Map<string, { task: string; response: Result }>();
  host.setLaunchRespond((request, normal) => {
    if (request.agent !== "pitako.access-verifier") return normal();
    const prior = cached.get(request.key);
    if (prior) {
      expect(request.task).toBe(prior.task);
      return { ...prior.response, reused: true };
    }
    if (!busy) return normal();
    const response = { ok: true, agent: request.agent, runId: nativeRunId(request.key),
      output: JSON.stringify({ v: 1, code: "store-busy" }), results: [{ exitCode: 0 }] } as Result;
    cached.set(request.key, { task: request.task, response });
    return response;
  });
  const result = await host.executeNative();
  expect(result).toMatchObject({ status: "partial", loopsConsumed: 1, maxLoops: 1, phase: "review",
    reason: "Access verifier store-busy after three attempts at invoke-human-1.l1.review.synthesis.",
    action: { actor: "active root", operation: "replay" } });
  const key = "invoke-human-1.l1.review.verify-synthesis";
  expect(host.launches.filter(call => call.agent === "pitako.access-verifier").map(call => call.key))
    .toEqual([key, `${key}.store.r1`, `${key}.store.r2`]);
  expect(host.launches.some(call => call.key.endsWith(".director-synthesis") || call.key.endsWith(".compliance"))).toBe(false);
  busy = false;
  const resumed = await host.executeNative();
  expect(resumed.status, resumed.reason).toBe("complete");
  expect(host.verifications.map(call => call.key)).toEqual([`${key}.store.r3`]);
  expect(host.launches.some(call => call.agent === "pitako.store-io")).toBe(false);
});

test("after final-review replay, execute enters a new epoch when a later access verifier quarantines the store", async () => {
  const host = fixture(undefined, { taskCount: 0 });
  host.setLimit(3);
  const synthesis = "invoke-human-1.l1.review.director-synthesis";
  let retainedSynthesis = false;
  host.setSaveObserver(value => {
    if (value.action.key === synthesis && value.action.runId) retainedSynthesis = true;
  });
  host.setFailSave(() => retainedSynthesis);
  expect((await host.executeNative()).reason).toContain("Essential persistence failed");
  expect(host.current().action).toMatchObject({ key: synthesis, runId: nativeRunId(synthesis) });
  host.setFailSave();
  host.setSaveObserver(undefined);
  // A checkout change at the end of the replayed loop requires another final review.
  host.setObservationResponse((key, observation) => key === "invoke-human-1.l1.checkout"
    ? { ...observation, checkout: { ...observation.checkout, fingerprint: "f".repeat(64) } } : observation);

  const store = new PitakoStore(host.root);
  const key = "invoke-human-1.l2.review.verify-synthesis";
  let oldStoreId: string | undefined, quarantine: string | undefined;
  host.setLaunchRespond(async (request, normal) => {
    if (request.key !== key) return normal();
    expect(host.current()).toMatchObject({ epoch: 0, budget: { maxCycles: 3, consumedLoops: 2 } });
    oldStoreId = host.current().storeId;
    const db = openSqliteSync(store.file);
    try { db.exec("PRAGMA user_version=2"); } finally { db.close(); }
    const child = Bun.spawn([process.execPath, "--preload", gitFakeBootstrap, resolve("extensions/access-receipts.mjs"), "--verify-stdin"], {
      cwd: host.root, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(`<System instructions>\nFixed verifier\n\n<Task>\n${request.task}`);
    child.stdin.end();
    const [output, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const failure = JSON.parse(output);
    quarantine = failure.recovery?.quarantine;
    expect(failure).toMatchObject({ v: 1, code: "store-corrupt",
      recovery: { root: host.root, storeId: expect.any(String), quarantine: expect.any(String) } });
    return { ok: true, agent: request.agent, runId: nativeRunId(request.key), output, results: [{ exitCode }] } as Result;
  });
  const beforeReplay = host.launches.length;
  const result = await host.executeNative();
  const relaunched = host.launches.slice(beforeReplay);
  expect(relaunched[0]?.key).toBe("invoke-human-1.l1.reviewOriginals.r1");
  expect(result.status, `${result.reason} (epoch ${host.current().epoch})`).toBe("complete");
  expect(quarantine).toStartWith(`${store.file}.v2.`);
  expect(existsSync(quarantine!)).toBe(true);
  const { storeId } = store.verify();
  expect(storeId).not.toBe(oldStoreId);
  expect(host.current()).toMatchObject({ epoch: 1, storeId, halt: null, budget: { maxCycles: 3, consumedLoops: 3 } });
  expect(relaunched.some(call => call.key === "invoke-human-1.e1.l3.advance")).toBe(true);
  expect(relaunched.some(call =>
    call.key === synthesis || call.key === "invoke-human-1.l2.review.director-synthesis")).toBe(false);
  expect(host.launches.some(call => call.agent === "pitako.store-io")).toBe(false);
});
