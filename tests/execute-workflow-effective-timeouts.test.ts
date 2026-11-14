import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeControllerFixture, gaps } from "./fixtures/execute-workflow.ts";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";

const { fixture } = executeControllerFixture();

function commands(host: ReturnType<typeof fixture>, timeouts: number[], metric = false) {
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director" && request.key.includes(".l1.")) {
      const task = result.structuredOutput.changes[0]?.task;
      if (task) {
        task.gates = timeouts.map((timeoutMs, index) => ({ id: `gate${index}`, command: "true", cwd: host.root, timeoutMs }));
        task.metric = metric ? { command: "echo 0", target: 0, unit: "failures" } : null;
      }
      result.structuredOutput.acceptance = timeouts.map((timeoutMs, index) =>
        ({ id: `final${index}`, command: "true", cwd: host.root, timeoutMs }));
    }
    return result;
  });
}

test("overrides reach workers, all analyses and task/final gates without rewriting backlog commands", async () => {
  const host = fixture();
  commands(host, [1000, 5000000]);
  const output = await host.executeNative({ timeouts: { reviewerMs: 20000000, workerMs: 21000000, gateFloorMs: 4000000 } });
  expect(output.status, output.reason).toBe("complete");
  for (const request of host.launches.filter(request => request.agent === "pitako.worker"))
    expect(request.timeoutMs).toBe(21000000);
  const analysis = host.launches.filter(request => /\.task-(reviewer|synthesis)$|\.review\.|\.compliance$/.test(request.key) && request.agent !== "pitako.access-verifier");
  expect(analysis.length).toBeGreaterThan(5);
  for (const request of analysis) expect(request.timeoutMs).toBe(20000000);
  const gates = host.launches.filter(request => request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "gate");
  expect(gates).toHaveLength(2);
  for (const request of gates) {
    expect(JSON.parse(request.task).task.gates.map((gate: any) => gate.timeoutMs)).toEqual([4000000, 5000000]);
    expect(request.timeoutMs).toBe(14400000);
  }
  const backlog = JSON.parse(readFileSync(path.join(host.root, ".pitako/backlog/spec.json"), "utf8"));
  expect(backlog.tasks[0].gates.map((gate: any) => gate.timeoutMs)).toEqual([1000, 5000000]);
  expect(backlog.acceptance.map((gate: any) => gate.timeoutMs)).toEqual([1000, 5000000]);
  const selected = host.snapshots.find(value => value.loop?.task)?.loop.task;
  expect(selected.gates.map((gate: any) => gate.timeoutMs)).toEqual([1000, 5000000]);
  expect(output.timeouts.values).toEqual({ reviewerMs: 20000000, workerMs: 21000000, gateFloorMs: 4000000 });
  const calls = host.snapshots.flatMap(value => value.loop?.analysisCalls ?? []);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call.timeoutMs).toBe(20000000);
});

test.each([
  { ms: [5400000, 5400000], metric: false, expected: 14400000 },
  { ms: [5400000, 5400001], metric: false, expected: 14400001 },
  { ms: [5400000, 5400000], metric: true, expected: 16200000 },
  { ms: [2147483647], metric: false, expected: 2147483647 },
])("gate and grouped close derive totals from frozen commands: %j", async ({ ms, metric, expected }) => {
  // A continuing worker exercises the grouped-close construction rather than
  // the completed-worker gate path covered by the override test.
  for (const continuing of [false, true]) {
    const host = fixture();
    host.setLimit(1);
    const respond = (request: any, normal: () => any) => {
      const result = normal();
      if (request.agent === "pitako.execution-director") {
        const task = result.structuredOutput.changes[0]?.task;
        if (task) {
          task.gates = ms.map((timeoutMs, index) => ({ id: `gate${index}`, command: "true", cwd: host.root, timeoutMs }));
          task.metric = metric ? { command: "echo 0", target: 0, unit: "failures" } : null;
        }
      }
      if (continuing && request.agent === "pitako.worker") {
        result.structuredOutput.status = "gaps";
        result.structuredOutput.remaining = ["Concrete remaining task work"];
      }
      return result;
    };
    host.setRespond(respond);
    const output = await host.execute();
    const request = host.launches.find(request => request.agent === "pitako.loop-io" &&
      JSON.parse(request.task).operation === (continuing ? "close" : "gate"));
    expect(request, output.reason).toBeDefined();
    expect(request!.timeoutMs).toBe(expected);
  }
});

test.each(["worker", "gate", "close", "analysis", "final"])("raising values after a saved %s intention preserves it on replay", async phase => {
  const host = fixture();
  const original = { reviewerMs: 15000000, workerMs: 16000000, gateFloorMs: 17000000 };
  if (phase === "close") host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker") {
      result.structuredOutput.status = "gaps";
      result.structuredOutput.remaining = ["Concrete remaining task work"];
    }
    return result;
  });
  let cut = false;
  host.setAdmission(calls => {
    const key = calls[0]!.key;
    const matches = phase === "worker" ? /\.t1\.a1$/.test(key) : phase === "gate" ? /\.t1\.a1\.gate$/.test(key)
      : phase === "close" ? /\.t1\.a1\.close$/.test(key) : phase === "analysis" ? key.endsWith(".task-reviewer")
      : key.endsWith(".acceptance.gate");
    if (!cut && matches) {
      cut = true;
      throw new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: `workflow[${key}]`,
        used: 64, limit: 64, requested: 1, remaining: 0 });
    }
  });
  expect((await host.executeNative({ timeouts: original })).status).toBe("budget-exhausted");
  expect(cut).toBe(true);
  const before = structuredClone(host.current());
  const launchCount = host.launches.length;
  host.setAdmission();
  const output = await host.executeNative({ timeouts: { reviewerMs: 25000000, workerMs: 26000000, gateFloorMs: 27000000 } });
  const launched = host.launches.slice(launchCount);
  if (phase === "worker") {
    const request = launched.find(request => request.key === before.loop.attempt.key)!;
    expect(request, output.reason).toBeDefined();
    expect(request.timeoutMs).toBe(16000000);
  } else if (phase === "analysis") {
    const pending = before.loop.analysisCalls[0];
    const request = launched.find(request => request.key === pending.key)!;
    expect(request, output.reason).toBeDefined();
    expect(request.timeoutMs).toBe(15000000);
  } else {
    const pending = phase === "final" ? before.loop.finalAttempt.gate : before.loop.attempt[phase];
    const request = launched.find(request => request.key === pending.key)!;
    expect(request, output.reason).toBeDefined();
    const input = JSON.parse(request.task);
    const task = phase === "close" ? input.gate.task : input.task;
    expect(task.gates[0].timeoutMs).toBe(17000000);
    expect(request.timeoutMs).toBe(20600000);
  }
  expect(output.timeouts.values.workerMs).toBe(26000000);
  if (phase !== "final" && phase !== "close") {
    const later = launched.filter(request => request.agent === "pitako.loop-io" &&
      JSON.parse(request.task).operation === "gate" && request.key.endsWith(".acceptance.gate"));
    expect(later.length).toBeGreaterThan(0);
    expect(JSON.parse(later[0]!.task).task.gates[0].timeoutMs).toBe(27000000);
  }
});

test("completed children are observed, not relaunched, when overrides change", async () => {
  const host = fixture();
  expect((await host.executeNative()).status).toBe("complete");
  const count = host.launches.length;
  const output = await host.executeNative({ timeouts: { reviewerMs: 24000000, workerMs: 25000000, gateFloorMs: 26000000 } });
  expect(output.status, output.reason).toBe("complete");
  expect(host.launches).toHaveLength(count);
  expect(output.timeouts.values).toEqual({ reviewerMs: 24000000, workerMs: 25000000, gateFloorMs: 26000000 });
});

test("raising the floor between final loops disables acceptance reuse", async () => {
  const host = fixture(undefined, { taskCount: 0 });
  host.setRespond((request, normal) => request.key === "invoke-human-1.l1.compliance" ? gaps(normal()) : normal());
  host.setFailSave(value => value.loop?.number === 2);
  const interrupted = await host.execute();
  expect(interrupted.reason).toContain("Essential persistence failed");
  expect(host.current().lastFinalAcceptance.exec[0].timeoutMs).toBe(1800000);
  const acceptance = JSON.parse(readFileSync(path.join(host.root, ".pitako/backlog/spec.json"), "utf8")).acceptance;
  host.setFailSave();
  const output = await host.execute({ timeouts: { gateFloorMs: 20000000 } });
  expect(output.status, output.reason).toBe("complete");
  const request = host.launches.find(request => request.key === "invoke-human-1.l3.acceptance.gate")!;
  expect(request).toBeDefined();
  const input = JSON.parse(request.task);
  expect(input).not.toHaveProperty("reuse");
  expect(input.task.gates[0].timeoutMs).toBe(20000000);
  expect(request.timeoutMs).toBe(23600000);
  expect(JSON.parse(readFileSync(path.join(host.root, ".pitako/backlog/spec.json"), "utf8")).acceptance).toEqual(acceptance);
});

test("a fresh acceptance intention uses reset timeouts after a reused-receipt persistence cut", async () => {
  const host = fixture(undefined, { taskCount: 0 });
  host.setLimit(5);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key === "invoke-human-1.l1.acceptance.gate") {
      const receipt = JSON.parse(result.output!);
      const logRef = path.join(host.root, ".pi/acceptance-failure.log");
      writeFileSync(logRef, "Controlled acceptance failure");
      receipt.gates[0] = { ...receipt.gates[0], status: "fail", exit: 1, logRef };
      result.output = JSON.stringify(receipt);
    }
    return result;
  });
  const initial = await host.execute({ timeouts: { gateFloorMs: 20000000 } });
  expect(initial.status, initial.reason).toBe("blocked");
  expect(host.current().loop.halt.code, initial.reason).toBe("repeat-acceptance");
  const previous = structuredClone(host.current().lastFinalAcceptance);
  host.setFailSave(value => value.loop?.finalAttempt?.freshAuthorized &&
    value.loop.finalAttempt.gate.stage === "intention");
  const interrupted = await host.execute({
    unblock: true, resolution: { loop: 3, text: "Run acceptance fresh once" },
  });
  expect(interrupted.reason).toContain("Essential persistence failed");
  const saved = structuredClone(host.current());
  expect(saved.freshAcceptanceAuthorized).toBe(true);
  expect(saved.loop.finalAttempt.gate.receipt.reused).toEqual({ loop: previous.loop, gateKey: previous.gateKey });
  expect(saved.loop.finalAttempt.gate.task.gates[0].timeoutMs).toBe(20000000);
  const acceptance = JSON.parse(readFileSync(path.join(host.root, ".pitako/backlog/spec.json"), "utf8")).acceptance;

  host.setFailSave();
  const output = await host.execute({ timeouts: {} });
  expect(output.status, output.reason).toBe("complete");
  const fresh = host.launches.filter(request => request.key === `${saved.loop.finalAttempt.key}.fresh.gate`);
  expect(fresh).toHaveLength(1);
  const input = JSON.parse(fresh[0]!.task);
  expect(input).not.toHaveProperty("reuse");
  expect(input.task.gates[0].timeoutMs).toBe(1800000);
  expect(fresh[0]!.timeoutMs).toBe(14400000);
  expect(host.current().lastFinalAcceptance.exec[0].timeoutMs).toBe(1800000);
  expect(saved.loop.finalAttempt.gate.task.gates[0].timeoutMs).toBe(20000000);
  expect(JSON.parse(readFileSync(path.join(host.root, ".pitako/backlog/spec.json"), "utf8")).acceptance).toEqual(acceptance);
});
