import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyCheckpoint, restoreCheckpoint, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { readExecuteIntentContext } from "../extensions/execute-intent.ts";
import { digest } from "../extensions/spec-plans.ts";
import { copy, cutAt, executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const initialMs = 14400000;
async function timedOutRestoration(timeout = true, receiptCut = false) {
  const host = fixture(undefined, { realCheckout: true });
  host.setHostResponse((key, value) => {
    const cursor = host.current(), loop = cursor?.loop, attempt = loop?.attempt;
    return !timeout || !key.startsWith("inspect-") || !attempt?.intent || cursor.action.kind !== "launched"
      ? value : { ...value, checkpointObservation: {
      key: cursor.action.key, taskId: loop.taskId, attempt: attempt.number, loop: loop.number, cursor: loop.cursor,
      evidence: digest("unchanged checkpoint observation"),
    } };
  });
  host.setStatus(ref => {
    const original = host.native.get(ref);
    return original ? { ok: true, runId: original.runId, results: [], output: `Nested run: ${original.runId}\nState: failed` }
      : { ok: false, results: [] };
  });
  host.setRespond((request, normal) => {
    if (request.agent !== "pitako.worker") return normal();
    if (request.key.endsWith(".a1")) {
      const result = normal();
      const { intent } = readExecuteIntentContext(host.root, host.current());
      applyCheckpoint(intent, [{ path: "src/change1.ts", image: {
        bytes: Buffer.from("uncertain partial bytes").toString("base64"), mode: 0o644,
      } }]);
      delete result.structuredOutput;
      return result;
    }
    const result = host.result(request, null);
    return { ...result, ok: false,
      ...(timeout ? { results: result.results!.map(item => ({ ...item, timedOut: true, exitCode: 1 })) }
        : { interrupted: true }) };
  });
  if (receiptCut) host.setSaveObserver(value => {
    if (value.action?.key.endsWith(".a2") && value.action.runId &&
        value.halt?.stage !== "timeout") throw Error("Controlled first worker timeout receipt cut");
  });
  const outcome = await host.execute();
  host.setSaveObserver(undefined);
  if (receiptCut) await host.execute();
  expect(workers(host).map(call => call.key.split(".").at(-1))).toEqual(["a1", "a2"]);
  expect(host.current().halt?.stage, outcome.reason).toBe(timeout ? "timeout" : "recovery");
  return host;
}
const workers = (host: ReturnType<typeof fixture>) => host.launches.filter(call => call.agent === "pitako.worker");
function finishRestoration(host: ReturnType<typeof fixture>) {
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") {
      const { intent, records } = readExecuteIntentContext(host.root, host.current());
      const baseline = records.find(row => row.opKey === `operation:${intent.key}.baseline`);
      const { restore } = (baseline?.body as { request: { continuation: { attempt: {
        restore: { sourceKeys: string[]; authority: Parameters<typeof restoreCheckpoint>[1] };
      } } } }).request.continuation.attempt;
      const sources = restore.sourceKeys.map(key => records.find(row =>
        row.kind === "intent" && (row.body as CheckpointIntent).key === key)!.body as CheckpointIntent);
      const restored = restoreCheckpoint(sources, restore.authority);
      return host.result(request, { ...host.worker(request),
        restoreReceipt: { ...restored, restoredRef: restored.partialRef.replace(/restore\.json$/, "restored.json") } });
    }
    return normal();
  });
}

test.each([false, true])("a raised worker timeout retires the exact terminal restoring writer (receipt cut: %s)", async receiptCut => {
  const host = await timedOutRestoration(true, receiptCut);
  const old = copy(host.current().action);
  expect(host.current().timeouts.workerMs).toBe(initialMs);
  expect(host.native.get(old.runId)).toMatchObject({ agent: "pitako.worker", results: [{
    structuredOutputPath: `/native/witness/${old.key}.json`, timedOut: true, exitCode: 1 }] });
  expect(readFileSync(path.join(host.root, "src/change1.ts"), "utf8")).toBe("uncertain partial bytes");
  finishRestoration(host);
  let atLaunch: any;
  host.setLaunchRespond(async (request, normal) => {
    if (request.agent === "pitako.worker") atLaunch = copy(host.current());
    return normal();
  });
  const outcome = await host.execute({ timeouts: { workerMs: initialMs + 1 } });
  expect(outcome.status, outcome.reason).toBe("complete");
  expect(workers(host).map(call => call.key.split(".").at(-1))).toEqual(["a1", "a2", "a3"]);
  expect(workers(host).at(-1)!.timeoutMs).toBe(initialMs + 1);
  expect(atLaunch.action).toMatchObject({ key: old.key.replace(/\.a2$/, ".a3"), role: "worker" });
  expect(atLaunch.loop.attempt).toMatchObject({ number: 3, intent: expect.any(Object) });
  expect(atLaunch.halt).toBeNull();
  expect(existsSync(path.join(host.root, "src/change1.ts"))).toBe(false);
  const retained = JSON.parse(JSON.parse(readFileSync(path.join(host.root,
    ".pi/subagents/checkpoints/invoke-human-1.l1.t1.a1/restore.json"), "utf8")).data);
  expect(Buffer.from(retained.partial[0].image.bytes, "base64").toString()).toBe("uncertain partial bytes");
});

test.each([initialMs, initialMs - 1])("worker timeout %s cannot renew the restoring writer", async workerMs => {
  const host = await timedOutRestoration();
  const count = host.launches.length, writes = host.snapshots.length;
  const saved = JSON.stringify(host.current(), null, 2);
  const resumed = await host.execute({ timeouts: { workerMs } });
  expect(resumed.status, resumed.reason).toBe("partial");
  expect(resumed.loopReport.halt.code).toBe("timeout");
  expect(JSON.stringify(host.current(), null, 2)).toBe(saved);
  expect(host.snapshots).toHaveLength(writes);
  expect(host.launches).toHaveLength(count);
});

test.each(["missing-timeout", "foreign-evidence", "foreign-child", "foreign-run", "foreign-key", "foreign-agent", "unknown", "running", "stopped", "denied"])(
  "%s evidence cannot authorize worker timeout renewal", async mode => {
    const host = await timedOutRestoration(), old = copy(host.current().action), count = workers(host).length;
    if (["missing-timeout", "foreign-evidence", "foreign-child"].includes(mode)) {
      const { missionPath } = host.admitted().association;
      const mission = JSON.parse(readFileSync(missionPath, "utf8"));
      const child = mission.workflowChildren.find((value: any) => value.key === old.key && value.runId === old.runId);
      const directory = child.artifactPaths.find((file: string) => path.basename(file) === old.runId)!;
      const journal = path.join(path.dirname(directory), child.workflowRunId, "workflow-children.jsonl");
      const entries = readFileSync(journal, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
      const entry = entries.find(value => value.key === old.key && value.result?.runId === old.runId)!;
      if (mode === "missing-timeout") delete entry.result.results[0].timedOut;
      if (mode === "foreign-evidence") entry.result.key = "other-worker";
      if (mode === "foreign-child") entry.result.results[0].agent = "pitako.reviewer";
      writeFileSync(journal, entries.map(value => JSON.stringify(value)).join("\n") + "\n");
    }
    host.setStatus(ref => ({
      ok: mode !== "denied", runId: mode === "foreign-run" ? "other-run" : ref,
      key: mode === "foreign-key" ? "other-key" : ref,
      agent: mode === "foreign-agent" ? "pitako.reviewer" : "pitako.worker",
      state: mode === "unknown" ? "unknown" : mode === "running" ? "running" : "failed",
      ...(mode === "stopped" ? { stopped: true } : {}),
      ...(mode === "denied" ? { error: "Blocked by pi-subagents permission rule: 'run' is denied." } : {}),
      results: [],
    }));
    const outcome = await host.execute({ timeouts: { workerMs: initialMs + 1 } });
    expect(outcome.status).not.toBe("complete");
    expect(workers(host)).toHaveLength(count);
    expect(host.current().action.key).toBe(old.key);
    if (["stopped", "denied", "running"].includes(mode))
      expect(host.current().halt.stage).toBe(mode === "running" ? "worker-activity" : "native-barrier");
    if (["missing-timeout", "foreign-evidence", "foreign-child", "foreign-key", "unknown"].includes(mode)) {
      expect(outcome.reason).toContain("reconcile the retained writer");
      expect(outcome.reason).toContain("No replacement dispatched");
      if (["missing-timeout", "foreign-evidence", "foreign-child"].includes(mode)) {
        expect(outcome.status).toBe("blocked");
        expect(outcome.loopReport).toBeNull();
        expect(host.current().halt.stage).toBe("timeout");
      } else {
        expect(outcome.loopReport.halt.reason).toBe(outcome.reason);
      }
      expect(outcome.reason).not.toContain("Relaunch with args.timeouts.workerMs");
    }
  });

test("non-timeout restoration with no new evidence remains human-only", async () => {
  const host = await timedOutRestoration(false);
  expect((await host.execute({ timeouts: { workerMs: initialMs + 1 } })).status).toBe("partial");
  expect(workers(host)).toHaveLength(2);
  expect(host.current().halt.stage).toBe("recovery");
});

test.each(["before", "after"])("a cut %s durable retirement replays one fresh worker intention", async when => {
  const host = await timedOutRestoration();
  const retiring = (value: any) => value.action?.opKey?.endsWith(".a3.baseline");
  if (when === "before") cutAt(host, retiring);
  else host.setSaveObserver(value => {
    if (retiring(value)) throw Error("Controlled post-retirement save cut");
  });
  expect((await host.execute({ timeouts: { workerMs: initialMs + 1 } })).status).toBe("partial");
  expect(workers(host)).toHaveLength(2);
  host.setFailSave();
  host.setSaveObserver(undefined);
  finishRestoration(host);
  const outcome = await host.execute();
  expect(outcome.status, outcome.reason).toBe("complete");
  expect(workers(host).map(call => call.key.split(".").at(-1))).toEqual(["a1", "a2", "a3"]);
});

test("timeout renewal has three generations without bounding ordinary attempt numbers", async () => {
  const host = await timedOutRestoration();
  for (const workerMs of [initialMs + 1, initialMs + 2]) {
    const outcome = await host.execute({ timeouts: { workerMs } });
    expect(outcome.status, outcome.reason).toBe("partial");
  }
  expect(workers(host).map(call => call.key.split(".").at(-1))).toEqual(["a1", "a2", "a3", "a4"]);
  expect(host.current().action.key).toBe("invoke-human-1.l1.t1.a4");
  const outcome = await host.execute({ timeouts: { workerMs: initialMs + 3 } });
  expect(outcome.status).toBe("partial");
  expect(outcome.reason).toContain("use a new invocation");
  expect(workers(host)).toHaveLength(4);
});
