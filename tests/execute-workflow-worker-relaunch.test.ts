import { expect, test } from "bun:test";
import { readBacklog } from "../skills/execute/loop.ts";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";
import { readExecuteTimeoutProjection } from "../extensions/execute-progress.ts";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { readFileSync } from "node:fs";
import { resolveStoredGroupedInput } from "../skills/execute/loop-io.mjs";
import { PitakoStore } from "../extensions/pitako-store.ts";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";

const { fixture } = executeControllerFixture();

test.each([false, true, "divergent-routing"] as const)("large received results preserve normal admission; only a pre-admission crash needs recovery (%s)", async cut => {
  const host = fixture(); host.setLimit(1);
  let received = false, gated = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker")
      result.structuredOutput.work = "w".repeat(40000);
    return result;
  });
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.agent === "pitako.worker") received = true;
    if (request.key.endsWith(".a1.gate")) gated = true;
    return result;
  });
  if (cut) {
    host.setFailSave(() => cut === "divergent-routing" ? gated : received);
    expect((await host.execute()).reason).toContain("Essential persistence failed");
    expect(host.current().action).toMatchObject(cut === "divergent-routing"
      ? { kind: "pending", op: "gate" } : { kind: "launched", role: "worker" });
    host.setFailSave();
    host.setStatus(ref => {
      const original = host.native.get(ref)!;
      if (cut === "divergent-routing" && original.agent === "pitako.worker") {
        const observed = structuredClone(original);
        delete observed.agent;
        observed.outputReference = original.outputReference + ".status";
        return observed;
      }
      return { ok: true, key: original.key, runId: original.runId, state: "complete", results: [] };
    });
  }
  const output = await host.execute();
  // HUMAN #3434(a): recover the terminal original, never re-launch its model.
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  expect(host.launches.filter(call => call.key.endsWith(".recover.r1"))).toHaveLength(cut === true ? 1 : 0);
  expect(output.status, output.reason).toBe("partial");
  expect(host.current().halt).toBeNull();
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status, output.reason).toBe("done");
  const unit = host.records().find((record: any) => record.kind === "unit");
  expect(unit.body.result.status).toBe("complete");
  expect(unit.body.result.workDone).toBe("w".repeat(360));
  expect(host.current().loop.attempt).toBeNull();
  const saved = JSON.stringify(unit), count = host.launches.length, gates = host.gateExecutions();
  expect(gates).toBe(1);
  await host.execute();
  expect(JSON.stringify(host.records().find((record: any) => record.kind === "unit"))).toBe(saved);
  expect(host.launches).toHaveLength(count);
  expect(host.gateExecutions()).toBe(gates);
});

test.each(["before", "after"])("gate timeout generations recover %s commit without relaunching the worker", async seam => {
  const host = fixture(); host.setLimit(1);
  host.setStatus(ref => ({ ...structuredClone(host.native.get(ref)!), state: "complete" }));
  host.setLaunchRespond(async (request, normal) => {
    if (pitakoAgentFamily(request.agent) !== "loop-io" || !/\.a1(?:\.g2)?\.gate$/.test(request.key)) return normal();
    const result = seam === "after" ? await normal() : host.result(request, {});
    const failure = { ...result, ok: false, key: request.key, agent: request.agent,
      results: result.results!.map(entry => ({ ...entry, timedOut: true, exitCode: 1 })) };
    delete failure.structuredOutput;
    return failure;
  });
  let output = await host.execute();
  for (let generation = 1; generation <= 2; generation++) {
    const halt = output.loopReport?.halt;
    expect(halt?.code, output.reason).toBe("timeout");
    const count = host.launches.length;
    expect((await host.execute()).status).toBe("partial");
    expect(host.launches).toHaveLength(count);
    output = await host.execute({ timeouts: { gateFloorMs: halt.launchedMs + 1 } });
  }
  expect(output.status, output.reason).toBe("partial");
  expect(host.current().halt, output.reason).toBeNull();
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  expect(host.launches.filter(call => /\.recover/.test(call.key))).toHaveLength(0);
  expect(host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" &&
    JSON.parse(call.task).operation === "gate").map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.gate", "invoke-human-1.l1.t1.a1.g2.gate", "invoke-human-1.l1.t1.a1.g3.gate"]);
  expect(host.gateExecutions()).toBe(seam === "after" ? 3 : 1);
  expect(host.records().filter((record: any) => record.kind === "unit")).toHaveLength(1);
});

test("renewal deadlines retain per-gate inputs rather than the old aggregate", async () => {
  const deadlines: number[] = [], aggregates: number[] = [];
  for (const timeouts of [[1800000], [900000, 900000]]) {
    function setup() {
      const host = fixture(); host.setLimit(1);
      host.setStatus(ref => ({ ...structuredClone(host.native.get(ref)!), state: "complete" }));
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.execution-director") {
          const task = result.structuredOutput.changes.find((change: any) => change.kind === "add").task;
          task.gates = timeouts.map((timeoutMs, index) => ({ ...task.gates[0], id: `gate${index}`, timeoutMs }));
        }
        return result;
      });
      return host;
    }
    const host = setup();
    host.setLaunchRespond(async (request, normal) => {
      const result = await normal();
      return request.key.endsWith(".a1.gate") ? { ...result, ok: false,
        results: result.results!.map(entry => ({ ...entry, timedOut: true, exitCode: 1 })) } : result;
    });
    const output = await host.execute(), halt = output.loopReport.halt;
    aggregates.push(halt.launchedMs);
    expect(host.current().action.gateTimeouts).toEqual(timeouts);
    await host.execute({ timeouts: { gateFloorMs: halt.launchedMs + 1 } });
    const renewal = host.launches.find(call => call.key.endsWith(".g2.gate"))!;
    deadlines.push(renewal.timeoutMs!);
    const ordinary = setup();
    await ordinary.execute({ timeouts: { gateFloorMs: halt.launchedMs + 1 } });
    const normal = ordinary.launches.find(call => call.key.endsWith(".a1.gate"))!;
    expect(renewal.timeoutMs).toBe(normal.timeoutMs);
  }
  expect(aggregates[0]).toBe(aggregates[1]);
  expect(deadlines[0]).not.toBe(deadlines[1]);
});

test("ordinary tasks continue after repairs and timeout generations", async () => {
  const taskCount = 3, repairLoops = [1, taskCount];
  const host = fixture(undefined, { taskCount, retainSnapshots: false });
  host.setLimit(12);
  host.storage.set("unrelated", { text: "Independent mission state" });
  host.setStatus(ref => ({ ...structuredClone(host.native.get(ref)!), state: "complete" }));
  host.setRespond((request, normal) => {
    const result = normal();
    const repairLoop = repairLoops.some(loop => request.key.includes(`.l${loop}.`));
    if (repairLoop && request.agent === "pitako.worker" && request.key.endsWith(".a1"))
      Object.assign(result.structuredOutput, { status: "continue", remaining: ["Finish scoped implementation"],
        knowledge: { findings: ["The implementation is partly complete"], handoff: "Finish the remaining scoped branch" } });
    if (/\.a2(?:\.g[23])?\.task-(reviewer|synthesis)$/.test(request.key))
      Object.assign(result.structuredOutput, { correctness: { verdict: "Required repair", score: 8, findings: [{
        summary: "Repair the scoped branch", evidence: "src/change1.ts:1", introducedByDelta: true, affectsTask: true,
      }] }, remaining: ["Repair the scoped branch"], diagnosis: "Repair the scoped branch", revival: "Continue repairing" });
    if (/\.a2(?:\.g2)?\.(gate|task-reviewer|task-synthesis)$/.test(request.key) &&
        repairLoop) {
      const failure = { ...result, ok: false, state: "complete",
        results: result.results!.map(entry => ({ ...entry, timedOut: true, exitCode: 1 })) };
      delete failure.structuredOutput;
      return failure;
    }
    return result;
  });
  let output = await host.execute(), generations = 0;
  expect(output.loopReport.halt?.code, output.reason).toBe("timeout");
  const expectedGenerations = 12;
  while (output.loopReport?.halt?.code === "timeout" && generations < expectedGenerations) {
    const halt = output.loopReport.halt;
    generations++;
    output = await host.execute({ timeouts: {
      [halt.class === "gate-transport" ? "gateFloorMs" : "reviewerMs"]: halt.launchedMs + 1,
    } });
  }
  expect(output.status, output.reason).toBe("complete");
  expect(generations).toBe(expectedGenerations);
  expect(readBacklog(host.root, "spec").backlog!.tasks.map(task => task.status)).toEqual(["done", "done", "done"]);
  const attempts = taskCount + 4;
  expect(host.launches.filter(request => request.agent === "pitako.worker")).toHaveLength(attempts);
  expect(host.current().action.kind).toBe("terminal");
  expect(host.current().inFlight).toEqual([]);
  expect(host.storage.size).toBe(2);
  expect(host.records().filter((record: any) => record.kind === "unit")).toHaveLength(attempts);
  expect(host.launches.filter(call => /\.recover/.test(call.key))).toHaveLength(0);
  for (const number of repairLoops) for (const stage of ["task-reviewer", "task-synthesis"]) {
    const base = `invoke-human-1.l${number}.t1.a2`;
    const calls = host.launches.filter(call =>
      [1, 2, 3].some(generation => call.key === `${base}${generation === 1 ? "" : `.g${generation}`}.${stage}`));
    expect(calls).toHaveLength(3);
    for (const call of calls.slice(1))
      expect(call).toEqual({ ...calls[0], key: call.key, output: `${call.key}.json`, timeoutMs: call.timeoutMs });
  }
});

test("timeout inspection is read-only and identical to loop-io at the cursor head, not the tip", async () => {
  const host = fixture(); host.setLimit(1);
  let delta: any;
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.key.endsWith(".delta")) delta = JSON.parse(result.output!);
    if (request.key.endsWith(".task-reviewer")) {
      const failure = { ...result, ok: false,
        results: result.results!.map(entry => ({ ...entry, timedOut: true, exitCode: 1 })) };
      delete failure.structuredOutput;
      return failure;
    }
    return result;
  });
  expect((await host.execute()).loopReport.halt.code).toBe("timeout");
  const cursor = host.current(), file = `${host.root}/.pi/pitako/pitako.db`;
  const store = new PitakoStore(host.root), scope = `exec:${cursor.invocation}.e${cursor.epoch}`;
  const suffix = store.commit(scope, cursor.head, "unpublished-review", canonicalDigest({ originals: [] }),
    () => ({ kind: "review-originals", body: { originals: [] } }));
  expect(suffix.outcome).toBe("appended");
  if (suffix.outcome !== "appended") throw new Error("Expected unpublished suffix");
  const bytes = readFileSync(file);
  const packet = readExecuteTimeoutProjection(host.root, cursor)!;
  expect(JSON.stringify(packet.P)).toBe(JSON.stringify(delta.P));
  expect(packet.head).toEqual(cursor.head);
  expect(packet.head).not.toEqual(suffix.head);
  const replay = resolveStoredGroupedInput("gate", { root: host.root, invocation: cursor.invocation,
    key: packet.P.control.operation!.key, storeId: cursor.storeId, scope: `exec:${cursor.invocation}.e${cursor.epoch}`,
    expectedHead: cursor.head, refs: { input: cursor.action.input } }).replay as { P: unknown; head: unknown; [key: string]: unknown };
  const { P, head, ...gate } = replay;
  expect(packet.gate).toEqual(gate);
  expect(readFileSync(file)).toEqual(bytes);
  expect(() => readExecuteTimeoutProjection(host.root, { ...cursor,
    head: { ...cursor.head, hash: "f".repeat(64) } })).toThrow();
  expect(readExecuteTimeoutProjection(host.root, { ...cursor, halt: null })).toBeUndefined();
  const count = host.launches.length;
  const timeoutRecovery = { packet, digest: canonicalDigest(packet) };
  for (const digest of [undefined, "f".repeat(64)]) {
    host.setHostResponse((_key, value) => ({ ...value, timeoutDigest: digest }));
    const output = await host.execute({ timeoutRecovery, timeouts: { reviewerMs: cursor.timeouts.reviewerMs + 1 } });
    expect(output.reason).toContain("digest integrity mismatch");
    expect(host.launches).toHaveLength(count);
    expect(host.current()).toEqual(cursor);
  }
  host.setHostResponse();
  const ordinary = fixture(); ordinary.setLimit(1);
  expect((await ordinary.execute({ timeoutRecovery })).reason).toContain("digest integrity mismatch");
  expect(ordinary.launches).toHaveLength(0);
  const output = await host.execute({ timeoutRecovery,
    timeouts: { reviewerMs: cursor.timeouts.reviewerMs + 1 } });
  expect(output.reason).not.toContain("digest integrity mismatch");
  expect(host.launches.filter(call => /\.recover/.test(call.key))).toHaveLength(0);
  expect(host.launches.slice(count).map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1.g2.task-reviewer"]);
});
