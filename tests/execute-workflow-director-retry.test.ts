import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { executeControllerFixture, copy, cutAt, gaps } from "./fixtures/execute-workflow.ts";
import { executeStore } from "../skills/execute/ledger.mjs";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";

const { fixture } = executeControllerFixture();
const first = "invoke-human-1.l1.director";
const retry = first + ".d1";
const selection = "invoke-human-1.l1.selection";

test.each(["admission-rejected", "before-dispatch", "inspector-rejected"])("first validation rejection retries after integrated-review gaps (%s)", async mode => {
  const inspector = mode === "inspector-rejected";
  const { host: uninterrupted } = await run(false);
  const { host, cursor } = await run(true);
  const { maxCycles, consumedLoops } = uninterrupted.current().budget;
  expect(host.current().budget).toMatchObject({ maxCycles, consumedLoops, rejectedKeys: [] });
  expect(maxCycles).toBe(cursor.budget.maxCycles);
  expect(host.current().budget.lastProgress).toBe(cursor.budget.lastProgress);

  const retryKey = "invoke-human-1.l2.director.d1";
  if (mode === "before-dispatch") {
    const retryRequest = (owner: typeof host) => {
      const request = owner.calls.find(call => call.key === retryKey)!;
      return { ...request, cwd: "<root>", task: request.task.replaceAll(owner.root, "<root>")
        .replace(/("ledgerPath":"[^"]+","head":)"[a-f0-9]{64}"/, '$1"<ledger-head>"')
        .replace(/(CURRENT BACKLOG DIGEST: )"[a-f0-9]{64}"/, '$1"<backlog-digest>"') };
    };
    expect(retryRequest(host)).toEqual(retryRequest(uninterrupted));
  }
  const demandRing = (owner: typeof host) => {
    const saved = owner.current();
    const { store, scope } = executeStore(owner.root, saved.invocation, false, saved.epoch);
    const advance = store.readRecords(scope, saved.head).records.find(row =>
      row.opKey === "operation:invoke-human-1.l2.nextAdvance");
    const { observations } = (advance!.body as { request: { demand: { observations: unknown } } }).request.demand;
    expect(observations).toMatchObject([{ loop: 2, ref: { key: "invoke-human-1.l2.demand-observation" } }]);
    return JSON.stringify(observations).replaceAll(owner.root, "<root>");
  };
  expect(demandRing(host)).toBe(demandRing(uninterrupted));
  // Separate roots bind different backlog/ledger digests. Compare the demand payload
  // itself across roots and the entire redispatched request within the same root.
  for (const key of [retryKey, "invoke-human-1.l3.director"]) {
    const prompts = [host, uninterrupted].map(owner =>
      owner.calls.find(call => call.key === key)!.task.match(/^PREVIOUS OBSERVATIONS AND EXACT ORIGINAL SOURCES: (.+)$/m)![1]!
        .replaceAll(owner.root, "<root>"));
    expect(prompts[0]).toBe(prompts[1]);
  }

  async function run(interrupt: boolean) {
    const host = fixture(undefined, { taskCount: 0, findings: true, retainSnapshots: false });
    const retryKey = "invoke-human-1.l2.director.d1";
    const inspectorKey = "invoke-human-1.l2.recover1";
    const rejectedKey = inspector ? inspectorKey : retryKey;
    const backlog = path.join(host.root, ".pitako/backlog/spec.json");
    let before: string | undefined;
    host.setRespond((request, normal) => {
      if (request.key === "invoke-human-1.l2.selection") before = readFileSync(backlog, "utf8");
      if (request.key === retryKey) {
        expect(readFileSync(backlog, "utf8")).toBe(before!);
        expect(request.task).toContain("PREVIOUS SELECTION REJECTED: Selected task must be pending");
        expect(host.current().loop.attempt).toBeNull();
      }
      if (request.key === "invoke-human-1.l2.selection.d1") {
        expect(JSON.parse(request.task).key).toBe(request.key);
        expect(readFileSync(backlog, "utf8")).toBe(before!);
      }
      if (request.key === inspectorKey)
        return host.result(request, { status: "recovered", reason: "Exact original plan", original: host.plan(),
          workerResult: null, originalAvailable: true, binding: "absent", comparison: "only-original", provenance: ["/native/plan"] });
      const result = request.key === retryKey ? host.result(request, host.plan()) : normal();
      if (request.key === retryKey && inspector) delete result.structuredOutput;
      if (request.key === "invoke-human-1.l1.review.director-synthesis") {
        result.structuredOutput.screening.verdict = "material-gaps";
        result.structuredOutput.screening.reason = "Required parser branch missing";
        result.structuredOutput.screening.assessments.forEach((entry: any) => { entry.material = true; });
      }
      if (request.key === "invoke-human-1.l2.compliance") return gaps(result);
      if (request.key === "invoke-human-1.l2.director") result.structuredOutput.select = "unknown";
      return result;
    });
    if (!interrupt) {
      // The control compares workflow output; only the cut needs native admission.
      const outcome = await host.execute();
      expect(outcome.status, outcome.reason).toBe("complete");
      return { host, cursor: host.current() };
    }
    if (mode === "before-dispatch") host.setSaveObserver((value: any) => {
      if (value.action.kind !== "launched" || value.action.key !== retryKey || value.action.runId !== null) return;
      host.setFailSave(() => true);
      throw new Error("Controlled cut after saving the retry director launch");
    });
    else host.setLaunchRespond((request, normal) => {
      if (request.key !== rejectedKey) return normal();
      const error = new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: `workflow[${rejectedKey}]`,
        used: 64, limit: 64, requested: 1, remaining: 0 }).message;
      return { key: rejectedKey, ok: false, error, output: error, artifactPaths: [] };
    });
    const interrupted = await host.executeNative();
    expect(interrupted.status, interrupted.reason).toBe(mode === "before-dispatch" ? "partial" : "budget-exhausted");
    const cursor = copy(host.current());
    expect(cursor.action).toMatchObject({ kind: "launched", key: rejectedKey, runId: null });
    expect(cursor.budget.rejectedKeys).toEqual(mode === "before-dispatch" ? [] : [canonicalDigest(rejectedKey)]);
    expect(host.native.get(rejectedKey)?.runId).toBeUndefined();
    const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
    expect(store.readRecords(scope, cursor.head).records.at(-1)).toMatchObject({
      kind: "review-originals", opKey: "review-originals:invoke-human-1.l2.demandOriginals",
    });
    const earlier = host.launches.map(call => call.key).filter(key => key !== rejectedKey);
    const rejected = host.launches.find(call => call.key === rejectedKey);
    expect(Boolean(rejected)).toBe(mode !== "before-dispatch");
    host.setLaunchRespond();
    host.setSaveObserver(undefined);
    host.setFailSave();
    host.setLimit(cursor.budget.maxCycles + 1);
    const offset = host.launches.length;
    const resumed = await host.executeNative();
    expect(resumed.status, resumed.reason).toBe("complete");
    expect(host.current().budget.rejectedKeys).toEqual([]);
    const launched = host.launches.slice(offset);
    expect(launched.some(call => earlier.includes(call.key))).toBe(false);
    const retryLaunches = launched.filter(call => call.key === rejectedKey);
    expect(retryLaunches).toHaveLength(1);
    if (rejected) expect(retryLaunches[0]).toEqual(rejected);
    expect(launched.slice(0, 2).map(call => call.key)).toEqual([`${retryKey}.advance-replay.r1`, rejectedKey]);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l2.demandOriginals")).toHaveLength(1);
    expect(host.calls.filter(call => call.key === "invoke-human-1.l2.demand-observation")).toHaveLength(1);
    expect(host.calls.filter(call => call.agent === "pitako.execution-director" && call.key.startsWith("invoke-human-1.l2.")).map(call => call.key))
      .toEqual(["invoke-human-1.l2.director", retryKey]);
    return { host, cursor };
  }
});

test("a second rejection closes gaps with both diagnostics and no third director", async () => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = (request.key.endsWith(".director.d1") ? host.result(request, host.plan()) : normal());
    if (request.key === first) result.structuredOutput.select = "unknown";
    if (request.key === retry) result.structuredOutput.changes[0].task.title = "";
    return result;
  });
  const outcome = await host.executeNative();
  expect(outcome.status, outcome.reason).toBe("partial");
  expect(host.current().loop).toMatchObject({ outcome: "gaps", attempt: null });
  expect(host.history()[0]).toMatchObject({ outcome: "gaps", plan: { stage: "rejected",
    rejection: { diagnostic: expect.any(String), previous: { diagnostic: "Selected task must be pending", rejectedRef: { key: first } } } } });
  expect(host.history()[0].plan.rejection.diagnostic).not.toBe("Selected task must be pending");
  expect(host.calls.filter(call => call.agent === "pitako.execution-director").map(call => call.key)).toEqual([first, retry]);
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toEqual([]);
  expect(existsSync(path.join(host.root, ".pitako/backlog/spec.json"))).toBe(false);
});

test("retry diagnostic is bounded before persistence and delivery", async () => {
  const host = fixture(); host.setLimit(1);
  const diagnostic = "invalid ".repeat(500);
  host.setRespond((request, normal) => {
    if (request.key === selection) return { ...host.result(request, {}), ok: false, output: JSON.stringify({ error: "loop-io", selectionRejected: true, reason: diagnostic }) };
    if (request.key === retry) {
      expect(request.task).toContain(diagnostic.slice(0, 2000));
      expect(request.task).not.toContain(diagnostic);
    }
    return (request.key.endsWith(".director.d1") ? host.result(request, host.plan()) : normal());
  });
  const outcome = await host.executeNative();
  expect(outcome.status, outcome.reason).toBe("partial");
  const cursor = host.current();
  const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
  const row = store.readRecords(scope, cursor.head).records.find(row => row.opKey === "operation:invoke-human-1.l1.selectionIO.d1");
  expect(row?.body).toMatchObject({ request: { rejectionArchive: { previous: {
    diagnostic: diagnostic.slice(0, 2000), rejectedRef: { key: first },
  } } } });
});

test.each(["complete", "stopped", "interrupted"])("retry intention replay preserves %s status without redispatching the director", async state => {
  const host = fixture();
  host.setRespond((request, normal) => {
    const result = (request.key.endsWith(".director.d1") ? host.result(request, host.plan()) : normal());
    if (request.key === first) result.structuredOutput.select = "unknown";
    return result;
  });
  cutAt(host, value => value.action.kind === "launched" && value.action.key === retry && value.action.runId !== null);
  const outcome = await host.executeNative();
  expect(outcome.status, outcome.reason).toBe("partial");
  expect(host.current().action).toMatchObject({ kind: "launched", key: retry, runId: null });
  host.setFailSave();
  let barrier = state !== "complete";
  host.setStatus(ref => {
    if (ref === retry && barrier) return { ok: false, output: `Run: ${retry}\nState: ${state}`, results: [] };
    const native = host.native.get(ref);
    return copy(native ? { ...native, output: `Run: ${native.runId}\nState: complete` } : { ok: true, output: "", results: [] });
  });
  const before = copy(host.current()), launches = host.launches.length;
  const resumed = await host.executeNative();
  if (barrier) {
    expect(resumed.status, resumed.reason).toBe("cancelled");
    expect(resumed.reason).toContain(state);
    const held = copy(host.current());
    expect(held.hostHalt).not.toBeNull();
    expect({ ...held, hostHalt: null }).toEqual(before);
    barrier = false;
    const observed = host.statusCalls.length;
    const relaunched = await host.executeNative();
    expect(relaunched.status).toBe(resumed.status);
    expect(relaunched.reason).toBe(resumed.reason);
    expect(relaunched.loopReport.halt).toEqual(resumed.loopReport.halt);
    expect(host.current()).toEqual(held);
    expect(host.launches).toHaveLength(launches);
    expect(host.statusCalls).toHaveLength(observed);
    return;
  }
  expect(resumed.status, resumed.reason).toBe("complete");
  expect(host.calls.filter(call => call.key === retry)).toHaveLength(1);
  expect(host.statusCalls).toContain(retry);
  expect(host.calls.filter(call => call.key === selection + ".d1")).toHaveLength(1);
});

test.each(["authority", "binding", "backlog-conflict", "final-requirement", "replay-after-write"])("%s rejection is not retried", async mode => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = (request.key.endsWith(".director.d1") ? host.result(request, host.plan()) : normal());
    if (request.key === first && mode === "authority") result.agent = "pitako.worker";
    if (request.key === first && mode === "binding") result.output = JSON.stringify({ ...result.structuredOutput, reason: "different binding" });
    if (request.key === selection && !["authority", "binding"].includes(mode))
      return { ...result, ok: false, output: JSON.stringify({ error: "loop-io", selectionRejected: mode === "backlog-conflict",
        reason: mode === "backlog-conflict" ? "backlog-conflict: controlled" : mode === "final-requirement"
          ? "Final phase requires non-empty acceptance commands" : "backlog-conflict: controlled (replay differs)" }) };
    return result;
  });
  const outcome = await host.executeNative();
  expect(outcome.status, outcome.reason).toBe("blocked");
  expect(host.calls.some(call => call.key === retry)).toBe(false);
  expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
});

test("replay-after-write selection rejection closes gaps without a director retry", async () => {
  const host = fixture(); host.setLimit(1);
  const reason = "Acceptance exception loader: humanRef 7 is not a current HUMAN of this topic";
  host.setRespond((request, normal) => {
    const result = (request.key.endsWith(".director.d1") ? host.result(request, host.plan()) : normal());
    if (request.key === selection)
      return { ...result, ok: false, output: JSON.stringify({ error: "loop-io", selectionRejected: true, replayRejected: true, reason }) };
    return result;
  });
  const outcome = await host.executeNative();
  expect(outcome.status, outcome.reason).toBe("partial");
  expect(host.current().loop).toMatchObject({ outcome: "gaps" });
  expect(host.history()[0]).toMatchObject({ outcome: "gaps", plan: { stage: "rejected", rejection: { diagnostic: reason } } });
  expect(host.history()[0].plan.rejection).not.toHaveProperty("previous");
  expect(host.calls.some(call => call.key === retry || call.key === selection + ".d1")).toBe(false);
  expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
});

test.each(["stopped", "permission"])("retry preserves %s barriers", async mode => {
  const host = fixture();
  host.setRespond((request, normal) => {
    if (request.key === retry) {
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      return { ...(request.key.endsWith(".director.d1") ? host.result(request, host.plan()) : normal()), ok: false, stopped: true };
    }
    const result = (request.key.endsWith(".director.d1") ? host.result(request, host.plan()) : normal());
    if (request.key === first) result.structuredOutput.select = "unknown";
    return result;
  });
  const outcome = await host.executeNative();
  expect(outcome.status, outcome.reason).toBe(mode === "stopped" ? "cancelled" : "blocked");
  expect(host.calls.filter(call => call.key === retry)).toHaveLength(1);
  expect(host.calls.some(call => call.key === selection + ".d1")).toBe(false);
  expect(host.calls.some(call => call.agent === "pitako.worker")).toBe(false);
});
