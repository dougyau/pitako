import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { executeControllerFixture, cutAt } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const first = "invoke-human-1.l1.director";
const retry = first + ".d1";
const selection = "invoke-human-1.l1.selection";

test("first validation rejection retries in-loop without changing backlog bytes or progress", async () => {
  const host = fixture(undefined, { taskCount: 2, controlledCheckpoints: true });
  const backlog = path.join(host.root, ".pitako/backlog/spec.json");
  let before: string | undefined;
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l2.selection") before = readFileSync(backlog, "utf8");
    if (request.key === "invoke-human-1.l2.director.d1") {
      expect(readFileSync(backlog, "utf8")).toBe(before!);
      expect(host.current().currentView).not.toBeNull();
      expect(request.task).toContain("PREVIOUS SELECTION REJECTED: Selected task must be pending");
      expect(host.current().loop.directorRetry).toMatchObject({ diagnostic: "Selected task must be pending",
        rejectedRef: { key: "invoke-human-1.l2.director" } });
      expect(host.current().loop.attempt).toBeNull();
    }
    if (request.key === "invoke-human-1.l2.selection.d1") {
      expect(JSON.parse(request.task).key).toBe(request.key);
      expect(readFileSync(backlog, "utf8")).toBe(before!);
    }
    const result = (request.key.endsWith(".director.d1") ? host.result(request, host.plan()) : normal());
    if (request.key === "invoke-human-1.l2.director") result.structuredOutput.select = "unknown";
    return result;
  });
  const outcome = await host.executeNative();
  expect(outcome.status, outcome.reason).toBe("complete");
  expect(host.calls.filter(call => call.key.endsWith(".demand-observation"))).toEqual([]);
  expect(host.calls.filter(call => call.key.startsWith("invoke-human-1.l2.director")).map(call => call.key))
    .toEqual(["invoke-human-1.l2.director", "invoke-human-1.l2.director.d1"]);
  expect(host.history()[1].number).toBe(2);
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
  expect(host.current().loop).toMatchObject({ outcome: "gaps", attempt: null, plan: { stage: "rejected",
    rejection: { diagnostic: expect.any(String), previous: { diagnostic: "Selected task must be pending", rejectedRef: { key: first } } } } });
  expect(host.current().loop.plan.rejection.diagnostic).not.toBe("Selected task must be pending");
  expect(host.calls.filter(call => call.agent === "pitako.execution-director").map(call => call.key)).toEqual([first, retry]);
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toEqual([]);
  expect(existsSync(path.join(host.root, ".pitako/backlog/spec.json"))).toBe(false);
});

test("retry diagnostic is bounded before persistence and delivery", async () => {
  const host = fixture(); const diagnostic = "invalid ".repeat(500);
  host.setRespond((request, normal) => {
    if (request.key === selection) return { ...host.result(request, {}), ok: false, output: JSON.stringify({ error: "loop-io", selectionRejected: true, reason: diagnostic }) };
    if (request.key === retry) {
      expect(host.current().loop.directorRetry.diagnostic).toBe(diagnostic.slice(0, 2000));
      expect(request.task).toContain(diagnostic.slice(0, 2000));
      expect(request.task).not.toContain(diagnostic);
    }
    return (request.key.endsWith(".director.d1") ? host.result(request, host.plan()) : normal());
  });
  const outcome = await host.executeNative();
  expect(outcome.status, outcome.reason).toBe("complete");
});

test("replay observes the saved retry intention instead of redispatching the director", async () => {
  const host = fixture();
  host.setRespond((request, normal) => {
    const result = (request.key.endsWith(".director.d1") ? host.result(request, host.plan()) : normal());
    if (request.key === first) result.structuredOutput.select = "unknown";
    return result;
  });
  cutAt(host, value => value.loop?.plan?.stage === "published" && value.loop.plan.ref.key === retry);
  const outcome = await host.executeNative();
  expect(outcome.status, outcome.reason).toBe("partial");
  expect(host.current().loop.plan).toMatchObject({ stage: "intention", ref: { key: retry } });
  expect(host.current().loop.directorRetry).toBeDefined();
  host.setFailSave();
  const resumed = await host.executeNative();
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
  expect(host.current().loop).toMatchObject({ outcome: "gaps", plan: { stage: "rejected", rejection: { diagnostic: reason } } });
  expect(host.current().loop.directorRetry).toBeUndefined();
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
