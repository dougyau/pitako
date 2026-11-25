import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { executeStore } from "../skills/execute/ledger.mjs";
import { copy, cutAt, executeControllerFixture, nativeRunId, type Result } from "./fixtures/execute-workflow.ts";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";

const { fixture } = executeControllerFixture();
const phases = [
  { step: "gate-transport", target: "invoke-human-1.l1.t1.a1.gate", taskCount: 1, launchedMs: 14400000 },
  { step: "final-acceptance", target: "invoke-human-1.l1.acceptance.gate", taskCount: 0, launchedMs: 1800000 },
];
function setup(phase: typeof phases[number], mode = "timeout") {
  const host = fixture(undefined, { taskCount: phase.taskCount });
  host.setStatus(ref => ref.includes(".gate") ? { ok: true, runId: ref, results: [],
    output: `Run: ${ref}\nState: ${phase.step === "gate-transport" ? "failed" : "complete"}` }
    : { state: "complete", ...copy(host.native.get(ref)!), ok: true });
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key !== phase.target) return result;
    if (phase.step === "gate-transport") {
      const failure: Result = { ...result, ok: false, output: "", error: "Native deadline",
        results: host.result(request, null).results!.map(item => ({ ...item, exitCode: 1, timedOut: true })) };
      if (mode === "reason") {
        failure.results = host.result(request, null).results!.map(item => ({ ...item, exitCode: 1 }));
        failure.terminalOutcome = { state: "partial", reason: "timeout" };
      }
      if (mode === "stop") failure.stopped = true;
      if (mode === "denial") failure.error = "Blocked by pi-subagents permission rule: 'run' is denied.";
      return failure;
    }
    const receipt = JSON.parse(result.output!);
    const logRef = path.join(host.root, "acceptance.log");
    writeFileSync(logRef, "Controlled acceptance result");
    receipt.gates[0] = { ...receipt.gates[0], status: "timeout", exit: null, logRef };
    if (mode === "error") receipt.gates[0].status = "error";
    if (mode === "fail") Object.assign(receipt.gates[0], { status: "fail", exit: 1 });
    if (mode === "mixed-error" || mode === "mixed-fail") {
      receipt.gates[1] = { ...receipt.gates[1], status: mode === "mixed-error" ? "error" : "fail", exit: 1, logRef };
    }
    result.output = JSON.stringify(receipt);
    return result;
  });
  return host;
}
function generation(target: string, n: number) { return target.replace(/\.gate$/, `.g${n}.gate`); }

test.each(phases)("$step: strict raise retires only the timed-out gate, not settled work", async phase => {
  const host = setup(phase);
  const first = await host.executeNative();
  expect(first.status, first.reason).toBe("partial");
  expect(first.loopReport.halt).toMatchObject({ code: "timeout", class: phase.step,
    key: phase.target, launchedMs: phase.launchedMs });
  expect(host.current().halt).toEqual({ stage: "timeout", digest: canonicalDigest(first.loopReport.halt) });
  expect(first.action).toMatchObject({ actor: "foreground", started: false });
  expect(first.action.operation).toContain(`args.timeouts.gateFloorMs strictly greater than ${phase.launchedMs}`);
  const count = host.launches.length;
  const writes = host.snapshots.length;
  const saved = JSON.stringify(host.current(), null, 2);
  const backlog = JSON.parse(readFileSync(path.join(host.root, ".pitako/backlog/spec.json"), "utf8"));
  for (const gateFloorMs of [phase.launchedMs, 1]) {
    const unchanged = await host.executeNative({ timeouts: { gateFloorMs } });
    expect(unchanged.status, unchanged.reason).toBe("partial");
    expect(unchanged.loopReport.halt).toEqual(first.loopReport.halt);
    expect(JSON.stringify(host.current(), null, 2)).toBe(saved);
    expect(host.snapshots).toHaveLength(writes);
    expect(host.launches).toHaveLength(count);
  }
  const resumed = await host.executeNative({ timeouts: { gateFloorMs: 20000000 } });
  expect(resumed.status, resumed.reason).toBe("complete");
  const fresh = host.launches.filter(call => call.key === generation(phase.target, 2));
  expect(fresh).toHaveLength(1);
  const input = JSON.parse(fresh[0]!.task);
  expect(input.refs?.gateFloorMs ?? input.task.gates[0].timeoutMs).toBe(20000000);
  expect(JSON.parse(fresh[0]!.task)).not.toHaveProperty("reuse");
  expect(host.launches.filter(call => call.key === phase.target)).toHaveLength(1);
  expect(host.launches.slice(count).some(call => call.agent === "pitako.worker" ||
    call.agent === "pitako.execution-director" && call.key.includes(".l1."))).toBe(false);
  const after = JSON.parse(readFileSync(path.join(host.root, ".pitako/backlog/spec.json"), "utf8"));
  expect(after.acceptance).toEqual(backlog.acceptance);
  expect(after.acceptanceHistory).toEqual(backlog.acceptanceHistory);
  expect(after.tasks.map((task: any) => task.gates)).toEqual(backlog.tasks.map((task: any) => task.gates));
  if (phase.step === "final-acceptance") {
    const cursor = host.current();
    const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
    const committed = store.readRecords(scope, cursor.head).records.filter(record => record.kind === "final-gate");
    expect(committed.map((record: any) => [record.body.producer, record.body.receipt.gates[0].status]))
      .toEqual([[phase.target, "timeout"], [generation(phase.target, 2), "pass"]]);
    expect(host.native.get(phase.target)?.runId).toBe(nativeRunId(phase.target));
  } else {
    expect(host.records().some((record: any) => record.body.retired?.some((ref: any) =>
      ref.key === phase.target && ref.runId === nativeRunId(phase.target)))).toBe(true);
  }
});

test.each(phases.flatMap(phase => ["before", "after"].map(cut => ({ ...phase, cut }))))(
  "$step: $cut retirement-save cuts never double launch", async phase => {
  const host = setup(phase, "reason");
  expect((await host.executeNative()).status).toBe("partial");
  const count = host.launches.length;
  const original = copy(host.current());
  const retiring = (value: any) => value.halt?.digest === original.halt.digest &&
    value.action?.opKey === phase.target && value.timeouts.gateFloorMs === 20000000;
  if (phase.cut === "before") cutAt(host, retiring);
  else host.setSaveObserver(value => {
    if (!retiring(value)) return;
    host.setFailSave(() => true);
    throw new Error("Controlled post-publication retirement cut");
  });
  expect((await host.executeNative({ timeouts: { gateFloorMs: 20000000 } })).reason).toContain("Essential persistence failed");
  expect(host.launches).toHaveLength(count);
  expect(host.current().timeouts.gateFloorMs).toBe(phase.cut === "before" ? original.timeouts.gateFloorMs : 20000000);
  host.setFailSave();
  host.setSaveObserver(undefined);
  const output = await host.executeNative(phase.cut === "before" ? { timeouts: { gateFloorMs: 20000000 } } : {});
  expect(output.status, output.reason).toBe("complete");
  expect(host.launches.filter(call => call.key === generation(phase.target, 2))).toHaveLength(1);
});

test.each(phases)("$step: no fourth generation", async phase => {
  const host = setup(phase);
  const original = phase.target;
  host.setRespond((request, normal) => {
    const result = normal();
    if (![original, generation(original, 2), generation(original, 3)].includes(request.key)) return result;
    if (phase.step === "gate-transport") return { ...result, ok: false, output: "",
      results: host.result(request, null).results!.map(item => ({ ...item, exitCode: 1, timedOut: true })) };
    const receipt = JSON.parse(result.output!);
    receipt.gates[0] = { ...receipt.gates[0], status: "timeout", exit: null };
    return { ...result, output: JSON.stringify(receipt) };
  });
  for (const gateFloorMs of [1800000, 20000000, 30000000, 40000000]) {
    const output = await host.executeNative({ timeouts: { gateFloorMs } });
    expect(output.status, output.reason).toBe("partial");
    if (gateFloorMs === 40000000) expect(output.reason).toContain("new invocation");
  }
  expect(host.current().halt.stage).toBe("timeout");
  expect(host.launches.filter(call => [original, generation(original, 2), generation(original, 3)].includes(call.key))).toHaveLength(3);
  expect(host.launches.some(call => call.key === generation(original, 4))).toBe(false);
});

test.each(["error", "fail", "mixed-error", "mixed-fail"])("final acceptance %s is not operationally renewed", async mode => {
  const phase = phases[1]!;
  const host = setup(phase, mode);
  if (mode.startsWith("mixed")) {
    // Two commands are required to distinguish all-timeout from mixed failures.
    // Director definitions are admitted through the real backlog apply boundary.
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director")
        result.structuredOutput.acceptance.push({ id: "second", command: "true", cwd: host.root });
      if (request.key === phase.target) {
        const receipt = JSON.parse(result.output!);
        const logRef = path.join(host.root, "mixed.log");
        writeFileSync(logRef, mode);
        receipt.gates[0] = { ...receipt.gates[0], status: "timeout", exit: null, logRef };
        receipt.gates[1] = { ...receipt.gates[1], status: mode === "mixed-error" ? "error" : "fail", exit: 1, logRef };
        result.output = JSON.stringify(receipt);
      }
      return result;
    });
  }
  const first = await host.executeNative();
  expect(first.status, first.reason).not.toBe("complete");
  expect(host.current().halt?.stage).not.toBe("timeout");
  if (mode !== "fail") expect(host.current().halt?.stage).toBe("environment");
  const count = host.launches.length;
  const output = await host.executeNative({ timeouts: { gateFloorMs: 86400000 } });
  expect(output.status, output.reason).not.toBe("complete");
  expect(host.launches.slice(count).some(call => call.key === generation(phase.target, 2))).toBe(false);
});

test.each(phases.flatMap(phase => ["stop", "denial", "active", "foreign"].map(mode => ({ ...phase, mode }))))(
  "$step: current $mode prevents renewal", async phase => {
    const host = setup(phase);
    expect((await host.executeNative()).status).toBe("partial");
    const count = host.launches.length;
    host.setStatus(ref => ({ ok: true, runId: phase.mode === "foreign" ? "foreign" : ref, results: [],
      ...(phase.mode === "stop" ? { stopped: true } : phase.mode === "denial"
        ? { error: "Blocked by pi-subagents permission rule: 'run' is denied." }
        : phase.mode === "active" ? { state: "running" } : { state: "complete" }) }));
    expect((await host.executeNative({ timeouts: { gateFloorMs: 20000000 } })).status).not.toBe("complete");
    expect(host.launches).toHaveLength(count);
  });

test.each(phases.flatMap(phase => ["stop", "denial"].map(mode => ({ ...phase, mode }))))(
  "$step: a status-exception $mode remains a barrier on later relaunch", async phase => {
    const host = setup(phase);
    expect((await host.executeNative()).status).toBe("partial");
    const count = host.launches.length;
    host.setStatus(ref => {
      throw new Error(phase.mode === "stop"
        ? `Status '${ref}' failed: Run: ${ref}\nState: stopped`
        : "Blocked by pi-subagents permission rule: 'status' is denied.");
    });
    const blocked = await host.executeNative({ timeouts: { gateFloorMs: 20000000 } });
    expect(blocked.status).toBe(phase.mode === "stop" ? "cancelled" : "blocked");
    expect(blocked.loopReport.halt).toMatchObject({ code: "native-barrier",
      cause: phase.mode === "stop" ? "stopped" : "native permission denial" });
    const cursor = copy(host.current());
    expect(cursor.halt).toEqual({ stage: `gate-renewal-${phase.mode === "stop" ? "stop" : "permission"}`,
      digest: canonicalDigest(blocked.loopReport.halt) });
    host.setStatus(ref => ({ ok: true, runId: ref, results: [], state: "complete" }));
    const resumed = await host.executeNative({ timeouts: { gateFloorMs: 30000000 } });
    expect(resumed.status, resumed.reason).toBe(blocked.status);
    expect(resumed.loopReport.halt).toEqual(blocked.loopReport.halt);
    expect(host.launches).toHaveLength(count);
    expect(host.current()).toEqual(cursor);
  });

test("a failed renewed task gate stays settled through grouped close", async () => {
  const phase = phases[0]!;
  const host = setup(phase);
  expect((await host.executeNative()).status).toBe("partial");
  const freshKey = generation(phase.target, 2);
  let executions = 0;
  host.setRespond();
  host.setTaskGatePass(key => {
    if (key !== freshKey && key !== phase.target) return true;
    executions++;
    // A duplicate execution would pass and incorrectly promote this attempt.
    return executions > 1;
  });
  const output = await host.executeNative({ timeouts: { gateFloorMs: 20000000 } });
  expect(executions, output.reason).toBe(1);
  const close = host.launches.find(call => call.key === "invoke-human-1.l1.t1.a1.close")!;
  expect(JSON.parse(close.task).gate.key).toBe(freshKey);
  const seal = host.calls.find(call => call.key === "invoke-human-1.l1.t1.a1.seal")!;
  expect(JSON.parse(seal.task).kind).toBe("pause");
  expect(host.launches.some(call => call.key.startsWith("invoke-human-1.l1.t1.a1.task-"))).toBe(false);
  const saved = host.current();
  const { store, scope } = executeStore(host.root, saved.invocation, false, saved.epoch);
  const rows = store.readRecords(scope, saved.head).records;
  const gate = rows.find(row => row.opKey === `worker-gate:${freshKey}`);
  const closed = rows.find(row => row.opKey === `operation:${close.key}`);
  expect(gate?.body).toMatchObject({ result: { gates: [{ status: "fail" }] } });
  expect(closed?.body).toMatchObject({ request: { gate: { key: freshKey } } });
});

test("gate transport reentry advances a spent retry instead of redispatching r2", async () => {
  const host = fixture();
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    return request.key.includes(".t1.a1.gate") ? { ...result, output: "Invalid receipt" } : result;
  });
  const first = await host.executeNative();
  expect(first.status, first.reason).not.toBe("complete");
  const keys = host.launches.filter(call => call.key.includes(".t1.a1.gate")).map(call => call.key);
  expect(keys).toEqual(["invoke-human-1.l1.t1.a1.gate", "invoke-human-1.l1.t1.a1.gate.r1", "invoke-human-1.l1.t1.a1.gate.r2"]);
  host.setStatus(ref => ({ ok: true, runId: ref, results: [], state: "failed" }));
  const count = host.launches.length;
  expect((await host.executeNative()).status).not.toBe("complete");
  expect(host.launches).toHaveLength(count);
});

test.each([1, 2])("gate reentry after a retry-%i intention save cut advances the spent key", async retry => {
  const host = fixture();
  const base = "invoke-human-1.l1.t1.a1.gate";
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    return request.key === base || retry === 2 && request.key === `${base}.r1`
      ? { ...result, output: "Invalid receipt" } : result;
  });
  cutAt(host, value => value.action?.opKey === base &&
    host.launches.filter(call => call.key.startsWith(base)).length === retry);
  expect((await host.executeNative()).reason).toContain("Essential persistence failed");
  host.setFailSave();
  host.setStatus(ref => {
    const admitted = host.native.get(ref);
    if (!admitted) throw new Error("Run not found. Provide id or runId.");
    return ref.includes(".gate") ? { ok: true, key: ref, runId: admitted.runId, agent: "pitako.loop-io",
      results: [], state: retry === 2 && ref === base ? "complete" : "failed" }
      : { state: "complete", ...copy(admitted), ok: true };
  });
  const output = await host.executeNative();
  expect(output.status, output.reason).toBe("complete");
  const keys = host.launches.filter(call => call.key.startsWith(base)).map(call => call.key);
  expect(keys).toEqual(retry === 1 ? [base, `${base}.r1`] : [base, `${base}.r1`, `${base}.r2`]);
});

test("grouped close retries retain their frozen task and derived total despite a raised floor", async () => {
  const host = fixture();
  const closeKey = "invoke-human-1.l1.t1.a1.close";
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker" && request.key.endsWith(".a1")) {
      result.structuredOutput.status = "gaps";
      result.structuredOutput.remaining = ["Concrete task work remains"];
    }
    return result;
  });
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    return request.key === closeKey ? { ...result, output: "Invalid transport" } : result;
  });
  cutAt(host, value => value.action?.opKey === closeKey &&
    host.launches.some(call => call.key === closeKey));
  expect((await host.executeNative({ timeouts: { gateFloorMs: 20000000 } })).reason).toContain("Essential persistence failed");
  const original = host.launches.find(call => call.key === closeKey)!;
  expect(original.timeoutMs).toBe(23600000);
  host.setFailSave();
  const output = await host.executeNative({ timeouts: { gateFloorMs: 30000000 } });
  const replay = host.launches.find(call => call.key === `${closeKey}.r1`)!;
  expect(replay, output.reason).toBeDefined();
  expect(replay.timeoutMs).toBe(original.timeoutMs);
  const cursor = host.current();
  const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
  const closes = store.readRecords(scope, cursor.head).records.filter(row => row.opKey === `operation:${closeKey}`);
  expect(closes).toHaveLength(1);
  const committed = closes[0]!.body as { request: { gate: { task: unknown } } };
  expect(committed.request.gate.task).toEqual(JSON.parse(original.task).gate.task);
  expect(host.launches.filter(call => call.key === closeKey)).toHaveLength(1);
  for (const call of host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" &&
    !["gate", "close"].includes(JSON.parse(call.task).operation))) expect(call).not.toHaveProperty("timeoutMs");
});
