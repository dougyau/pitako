import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { boundRetainedAnalyses, retainedAnalyses } from "../extensions/execute-retained.ts";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";
import { executeControllerFixture, copy, cutAt, gaps, type Result } from "./fixtures/execute-workflow.ts";

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
function setup(phase: typeof phases[number], mode = "timeout") {
  const host = fixture(undefined, { taskCount: phase.taskCount });
  // Status-query success is distinct from the failed producer's result.
  host.setStatus(ref => ref === `native-${phase.target}`
    ? { ok: true, runId: ref, results: [], output: `Run: ${ref}\nState: failed` }
    : { state: "complete", ...copy(host.native.get(ref)!), ok: true });
  host.setRespond((request, normal) => {
    if (phase.step === "demand-observation" && request.key === "invoke-human-1.l1.compliance") return gaps(normal());
    const value = normal();
    if (request.key !== phase.target) return value;
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
  const missionPath = path.join(host.root, "native-recovery", "mission.json");
  const stateRoot = path.join(path.dirname(missionPath), "native-recovery");
  mkdirSync(stateRoot, { recursive: true });
  host.setHostResponse((key, base) => {
    if (!key.startsWith("inspect-initial")) return base;
    const invocation = copy(host.current());
    const association = invocation.association;
    association.missionPath = missionPath;
    association.missionId = "native-recovery";
    const children: any[] = [];
    for (const call of invocation.loop.analysisCalls) {
      const native = host.native.get(call.key)!;
      const runId = native.runId!;
      const asyncDir = path.join(stateRoot, runId);
      mkdirSync(asyncDir, { recursive: true });
      writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
        runId, workflowKey: call.key, cwd: host.root, state: call.timeout ? "failed" : "complete",
        steps: [{ exitCode: native.results?.[0]?.exitCode ?? 0, structuredOutput: native.structuredOutput }],
      }));
      if (call.ref.runId) call.ref.asyncDir = asyncDir;
      children.push({ workflowRunId: "old-root", key: call.key, runId, agent: "pitako.reviewer", artifactPaths: [] });
    }
    const child = children.find(child => child.key === sibling);
    if (mode === "missing-reference") children.splice(children.indexOf(child), 1);
    if (mode === "wrong-key") child.key = "foreign";
    if (mode === "wrong-agent") child.agent = "pitako.worker";
    if (mode === "missing-run") delete child.runId;
    if (mode === "conflicting-reference") children.push({ ...child, runId: "foreign" });
    writeFileSync(missionPath, JSON.stringify({ workflowChildren: children }));
    writeFileSync(path.join(stateRoot, "state.json"), JSON.stringify({ "invoke-human-1": invocation }));
    const recovery = boundRetainedAnalyses(host.root, association.commonDir, association.source,
      association.digest, invocation.admissionBinding, association);
    return { ...base, retainedAnalyses: recovery?.originals ?? [], retainedReferences: recovery?.references ?? [] };
  });
}

test("an admitted same-request host reconstruction does not suppress later timeout renewal", async () => {
  const phase = phases[5]!, host = setup(phase);
  host.setHostResponse(() => { throw new Error("Host transport unavailable"); });
  expect((await host.executeNative()).status).toBe("blocked");
  const observation = copy(host.current().hostHalt);
  host.setHostResponse();
  expect((await host.executeNative()).status).toBe("partial");
  expect(host.current().hostReconstruction).toMatchObject({ stage: "admitted", source: observation });
  expect(host.current().loop.halt.code).toBe("timeout");
  const count = host.calls.length;
  expect((await host.executeNative({ timeouts: { reviewerMs: 14400000 } })).status).toBe("partial");
  expect(host.calls).toHaveLength(count);
  host.current().lastBudgetProgress = { retained: "budget progress" };
  const resumed = await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
  expect(resumed.status, resumed.reason).toBe("complete");
  expect(host.calls.filter(call => call.key === generation(phase.target, 2))).toHaveLength(1);
  expect(host.calls.filter(call => call.key === phase.target)).toHaveLength(1);
  expect(host.current().hostHalt).toEqual(observation);
});

test.each(phases)("$target: timeout freezes launch, strict raise renews only its step", async phase => {
  const host = setup(phase);
  const first = await host.executeNative();
  expect(first.status, first.reason).toBe("partial");
  expect(host.current().loop.halt).toMatchObject({ code: "timeout", class: phase.step,
    key: phase.target, launchedMs: 14400000, status: "partial" });
  expect(first.action).toMatchObject({ actor: "foreground", started: false });
  expect(first.action.operation).toContain("args.timeouts.reviewerMs strictly greater than 14400000");
  expect(first.loopReport.action).toEqual(first.action);
  // Resolve and native admission independently project the actual retained state.
  const missionPath = path.join(host.root, "recovery-bound", "mission.json");
  const stateRoot = path.join(path.dirname(missionPath), "recovery-bound");
  mkdirSync(stateRoot, { recursive: true });
  host.setHostResponse((key, base) => {
    if (!key.startsWith("inspect-initial")) return base;
    const invocation = copy(host.current());
    const association = invocation.association;
    association.missionPath = missionPath;
    association.missionId = "recovery-bound";
    const loop = invocation.loop;
    for (const ref of [...loop.analysisCalls.map((call: any) => call.ref),
      ...(loop.review?.references ?? []), ...(loop.compliance?.ref ? [loop.compliance.ref] : [])]) {
      ref.asyncDir = path.join(stateRoot, ref.runId);
      mkdirSync(ref.asyncDir, { recursive: true });
      const native = host.native.get(ref.runId)!;
      writeFileSync(path.join(ref.asyncDir, "status.json"), JSON.stringify({
        runId: ref.runId, workflowKey: ref.key, cwd: host.root,
        state: ref.key === phase.target ? "failed" : "complete",
        steps: [{ exitCode: native.results?.[0]?.exitCode ?? 0, structuredOutput: native.structuredOutput }],
      }));
    }
    writeFileSync(path.join(stateRoot, "state.json"), JSON.stringify({ "invoke-human-1": invocation }));
    const originals = retainedAnalyses(host.root, association.source, association.digest, association);
    expect(originals).toContainEqual(expect.objectContaining({ key: phase.target, runId: `native-${phase.target}` }));
    return { ...base, retainedAnalyses: originals };
  });
  const count = host.calls.length;
  for (const reviewerMs of [14400000, 1]) {
    expect((await host.executeNative({ timeouts: { reviewerMs } })).status).toBe("partial");
    expect(host.calls).toHaveLength(count);
  }
  // The budget return must not preempt eligible timeout reentry.
  host.current().lastBudgetProgress = { retained: "budget progress" };
  const resumed = await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
  expect(resumed.status, resumed.reason).toBe("complete");
  const fresh = generation(phase.target, 2);
  expect(host.calls.filter(call => call.key === fresh)).toHaveLength(1);
  expect(host.calls.find(call => call.key === fresh)!.timeoutMs).toBe(14400001);
  expect(host.calls.filter(call => call.key === phase.target)).toHaveLength(1);
  const settledWork = new Set(host.calls.slice(0, count)
    .filter(call => call.agent === "pitako.worker" || call.agent === "pitako.execution-director").map(call => call.key));
  expect(host.calls.slice(count).some(call => settledWork.has(call.key))).toBe(false);
  const loop = host.history().find(loop => loop.number === (phase.step === "demand-observation" ? 2 : 1))!;
  expect(loop.retired).toContainEqual(expect.objectContaining({ key: phase.target, runId: `native-${phase.target}` }));
  expect(host.records().some((record: any) =>
    record.kind === "loop" && record.body.retired?.some((ref: any) => ref.key === phase.target))).toBe(true);
  if (phase.step === "task-synthesis")
    expect(host.calls.filter(call => call.key.endsWith(".task-reviewer"))).toHaveLength(1);
  if (phase.step === "final-review") {
    expect(host.storage.has("review-invoke-human-1.g2")).toBe(true);
    expect(host.calls.some(call => call.agent === "pitako.access-verifier" && call.key.includes(".g2.review."))).toBe(true);
  }
});

test.each(phases.flatMap(phase => ["error", "stop", "interrupted", "denial", "active"].map(mode => ({ ...phase, mode }))))(
  "$target: $mode is not an operational timeout", async phase => {
    const host = setup(phase, phase.mode);
    const first = await host.executeNative();
    expect(first.status).not.toBe("complete");
    expect(host.current().loop.halt?.code).not.toBe("timeout");
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
    expect(host.current().budgetRejectedKeys).toContain(sibling);
    const count = host.calls.length;
    expect((await host.executeNative({ timeouts: { reviewerMs: 14400000 } })).status).toBe("partial");
    expect(host.calls).toHaveLength(count);
    host.setStatus(ref => {
      expect(ref).not.toBe(sibling);
      expect(ref).not.toBe(`native-${sibling}`);
      return { state: "complete", ...copy(host.native.get(ref)!), ok: true };
    });
  }
  const count = host.calls.length;
  cutAt(host, value => value.loop?.retired?.some((ref: any) => ref.key === phase.target));
  const interrupted = await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
  expect(interrupted.status, interrupted.reason).toBe("partial");
  expect(host.calls).toHaveLength(count);
  host.setFailSave();
  expect((await host.executeNative()).status).toBe("complete");
  expect(host.calls.filter(call => call.key === generation(phase.target, 2))).toHaveLength(1);
  if (rejectedSibling) {
    expect(host.calls.filter(call => call.key === generation(sibling, 2))).toHaveLength(1);
    expect(host.storage.has("review-invoke-human-1.g2")).toBe(true);
    expect(host.calls.some(call => call.agent === "pitako.access-verifier" && call.key.includes(".g2.review."))).toBe(true);
    expect(host.records().some((record: any) => record.kind === "loop" &&
      record.body.retired?.some((ref: any) => ref.key === sibling && !ref.runId))).toBe(true);
  }
});

test.each([...phases, { ...phases[3]!, target: phases[3]!.target.replace("angle1-r1", "angle1-r2") }]
  .flatMap(phase => ["timeout", "reason"].map(mode => ({ ...phase, mode }))))(
  "$target: $mode survives a cut immediately after the first receipt save", async phase => {
    const host = setup(phase, phase.mode);
    let cut = false;
    host.setSaveObserver(value => {
      if (cut || value.activePlan ||
          !value.loop?.analysisCalls?.some((call: any) => call.key === phase.target && call.stage === "receipt")) return;
      cut = true;
      host.setFailSave(() => true);
      throw new Error("Controlled post-receipt persistence cut");
    });
    expect((await host.executeNative()).status).toBe("partial");
    expect(cut).toBe(true);
    const call = host.current().loop.analysisCalls.find((call: any) => call.key === phase.target);
    if (phase.target.endsWith("independent-angle1-r1"))
      expect(host.current().loop.analysisCalls).toContainEqual(expect.objectContaining({
        stage: "intention", ref: { key: phase.target.replace("angle1-r1", "angle1-r2") },
      }));
    expect(call.timeout).toBe(true);
    expect(host.current().loop.halt).toMatchObject({
      code: "timeout", class: phase.step, key: phase.target, launchedMs: 14400000, ref: call.ref,
    });
    if (phase.mode === "timeout") expect(call.ref.results[0].timedOut).toBe(true);
    else expect(call.ref.terminalOutcome.reason).toBe("timeout");
    const count = host.calls.length;
    host.setSaveObserver(undefined);
    host.setFailSave();
    if (phase.target.endsWith("independent-angle1-r1"))
      recoverSibling(host, phase.target.replace("angle1-r1", "angle1-r2"));
    host.setStatus(ref => {
      // A fresh native root cannot resolve workflow keys through its empty child map.
      expect(ref.startsWith("native-")).toBe(true);
      if (phase.step !== "final-review" && ref !== `native-${phase.target}`)
        return { state: "complete", ...copy(host.native.get(ref)!), ok: true };
      // Terminal native management receipts contain neither launch results nor an agent.
      const label = phase.mode === "timeout" ? "Nested run" : "Run";
      const state = ref === `native-${phase.target}` ? "failed" : "complete";
      return { ok: true, runId: ref, results: [], output: `${label}: ${ref}\nState: ${state}` };
    });
    expect((await host.executeNative({ timeouts: { reviewerMs: 14400000 } })).status).toBe("partial");
    expect(host.calls).toHaveLength(count);
    if (phase.target.endsWith("independent-angle1-r1")) {
      cutAt(host, value => value.loop?.retired?.some((ref: any) => ref.key === phase.target));
      expect((await host.executeNative({ timeouts: { reviewerMs: 14400001 } })).status).toBe("partial");
      expect(host.calls).toHaveLength(count);
      host.setFailSave();
    }
    const resumed = await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
    expect(resumed.status, resumed.reason).toBe("complete");
    expect(host.calls.filter(call => call.key === generation(phase.target, 2))).toHaveLength(1);
    expect(host.calls.filter(call => call.key === phase.target)).toHaveLength(1);
    if (phase.target.endsWith("independent-angle1-r1")) {
      const sibling = phase.target.replace("angle1-r1", "angle1-r2");
      expect(host.records().some((record: any) => record.kind === "loop" &&
        record.body.retired?.some((ref: any) => ref.key === sibling && ref.runId === `native-${sibling}`))).toBe(true);
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
      if (mode === "unidentified-receipt" || cut || value.activePlan || !value.loop?.halt) return;
      cut = true;
      host.setFailSave(() => true);
      throw new Error("Controlled post-receipt persistence cut");
    });
    await host.executeNative();
    expect(cut).toBe(mode !== "unidentified-receipt");
    expect(host.current().loop.analysisCalls).toContainEqual(expect.objectContaining({
      stage: mode === "unidentified-receipt" ? "receipt" : "intention",
      ref: mode === "unidentified-receipt" ? expect.objectContaining({ key: sibling }) : { key: sibling },
    }));
    host.setSaveObserver(undefined);
    host.setFailSave();
    if (mode !== "unidentified-receipt") recoverSibling(host, sibling, mode);
    host.setStatus(ref => {
      expect(ref.startsWith("native-")).toBe(true);
      const value: Result = { ok: true, runId: ref, results: [], state: "complete" };
      if (ref !== `native-${sibling}`) return value;
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
        expect(host.current().loop.halt.code).toBe("timeout");
        expect(host.calls).toHaveLength(count);
      }
    }
    const resumed = await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
    expect(resumed.status).not.toBe("complete");
    expect(host.calls).toHaveLength(count);
    expect(host.current().loop.retired ?? []).toHaveLength(0);
    if (mode === "stopped") expect(host.current().loop.halt.code).toBe("native-barrier");
    else if (["nonterminal", "wrong-key", "missing-run", "missing-reference", "unidentified-receipt"].includes(mode)) {
      expect(resumed.status).toBe("partial");
      expect(host.current().loop.halt.code).toBe("timeout");
      expect(resumed.reason).toContain("reconcile the retained producers");
      expect(resumed.reason).not.toContain("Relaunch with args.timeouts");
      expect(resumed.action.operation).toContain("reconcile the retained producers");
      expect(resumed.action.operation).toContain("No replacement dispatched");
    }
  });

test.each(phases)("$target: durable retirement replays the same generation after a launch-intention cut", async phase => {
  const host = setup(phase);
  await host.executeNative();
  const fresh = generation(phase.target, 2);
  cutAt(host, value => value.loop?.analysisCalls?.some((call: any) => call.key === fresh));
  expect((await host.executeNative({ timeouts: { reviewerMs: 14400001 } })).status).toBe("partial");
  expect(host.current().loop.retired.some((ref: any) => ref.key === phase.target)).toBe(true);
  host.setFailSave();
  const resumed = await host.executeNative();
  expect(resumed.status, resumed.reason).toBe("complete");
  expect(host.calls.filter(call => call.key === fresh)).toHaveLength(1);
  expect(host.calls.some(call => call.key === generation(phase.target, 3))).toBe(false);
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

test.each(["needs-decision", "state-capacity", "capacity", "native-barrier"])(
  "timeout overrides preserve %s halts", async code => {
    const host = setup(phases[5]!);
    await host.executeNative();
    host.current().loop.halt = { code, status: "blocked", reason: "Retained barrier" };
    const count = host.calls.length;
    const resumed = await host.executeNative({ timeouts: { reviewerMs: 86400000 } });
    expect(resumed.status).not.toBe("complete");
    expect(resumed.action.operation).not.toContain("args.timeouts");
    expect(host.current().loop.halt.code).toBe(code);
    expect(host.calls).toHaveLength(count);
  });

test.each(["currentBarrier", "hostHalt", "nonterminal", "foreign-producer", "status-stop",
  "remembered-foreground", "foreign-management-run", "failed-status-stop"])(
  "retained timeout cannot bypass %s", async mode => {
    const phase = phases[5]!, host = setup(phase);
    await host.executeNative();
    if (mode === "currentBarrier") host.current().resolutions = [{
      currentBarrier: { cause: "stopped", ref: { key: phase.target } },
    }];
    if (mode === "hostHalt") host.current().hostHalt = { request: {}, status: "blocked", reason: "Host barrier" };
    if (["nonterminal", "foreign-producer", "status-stop",
      "remembered-foreground", "foreign-management-run", "failed-status-stop"].includes(mode))
      host.setStatus(ref => {
        const result = copy(host.native.get(ref)!);
        if (ref !== `native-${phase.target}`) return result;
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
    if (["currentBarrier", "hostHalt", "status-stop", "failed-status-stop"].includes(mode)) {
      if (mode !== "status-stop") expect(resumed.action.actor).not.toBe("foreground");
      expect(resumed.action.operation).not.toContain("Relaunch with args.timeouts");
    }
    expect(host.calls).toHaveLength(count);
  });

test("a current nested native Stop is retained instead of becoming a timeout retry", async () => {
  const phase = phases[5]!, host = setup(phase);
  await host.executeNative();
  const count = host.calls.length;
  host.setStatus(ref => ({ ...copy(host.native.get(ref)!), ok: true, state: "complete",
    results: [{ ...copy(host.native.get(ref)!).results![0]!, stopped: true, exitCode: 1 }] }));
  await host.executeNative({ timeouts: { reviewerMs: 14400001 } });
  expect(host.current().loop.halt).toMatchObject({ code: "native-barrier", cause: "stopped" });
  host.setStatus(ref => ({ ...copy(host.native.get(ref)!), ok: true, state: "complete" }));
  await host.executeNative({ timeouts: { reviewerMs: 86400000 } });
  expect(host.calls).toHaveLength(count);
});

test.each(["stopped", "cancelled", "budget_exhausted"] as const)(
  "a native %s outcome wins over simultaneous timeout evidence", async reason => {
    const phase = phases[5]!, host = setup(phase);
    host.setRespond((request, normal) => request.key === phase.target
      ? Object.assign(timedOut(normal()), { terminalOutcome: { state: "partial", reason } }) : normal());
    await host.executeNative();
    expect(host.current().loop.halt.code).toBe("native-barrier");
    const count = host.calls.length;
    await host.executeNative({ timeouts: { reviewerMs: 86400000 } });
    expect(host.calls).toHaveLength(count);
  });
