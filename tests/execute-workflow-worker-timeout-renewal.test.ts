import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beginHookEffect, restoreCheckpoint } from "../extensions/execute-checkpoint.ts";
import { digest } from "../extensions/spec-plans.ts";
import { copy, cutAt, executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const initialMs = 14400000;
async function timedOutRestoration(timeout = true, receiptCut = false) {
  const host = fixture(undefined, { realCheckout: true });
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker") {
      beginHookEffect(host.current().loop.attempt.checkpoint, "write", ["src/change1.ts"]);
      mkdirSync(path.join(host.root, "src"), { recursive: true });
      writeFileSync(path.join(host.root, "src/change1.ts"), "uncertain partial bytes");
    }
    return result;
  });
  cutAt(host, value => !!value.loop?.attempt?.launch);
  expect((await host.execute()).status).toBe("partial");
  host.setFailSave();
  host.setHostResponse((key, value) => {
    const loop = host.current()?.loop, attempt = loop?.attempt;
    return !key.startsWith("inspect-") || !attempt ? value : { ...value, checkpointObservation: {
      key: attempt.key, taskId: attempt.taskId, attempt: attempt.number, loop: loop.number, cursor: loop.cursor,
      evidence: digest("unchanged checkpoint observation"),
    } };
  });
  host.setStatus(ref => ref.includes(".t1.a1") ? { ok: true, results: [] }
    : { ok: true, runId: ref, results: [], output: `Nested run: ${ref}\nState: failed` });
  host.setRespond((request, normal) => {
    if (request.agent !== "pitako.worker") return normal();
    const result = host.result(request, null);
    return { ...result, ok: false,
      ...(timeout ? { results: result.results!.map(item => ({ ...item, timedOut: true, exitCode: 1 })) }
        : { interrupted: true }) };
  });
  if (receiptCut) host.setSaveObserver(value => {
    if (value.loop?.attempt?.key.endsWith(".a2") && value.loop.attempt.launch?.results?.[0]?.timedOut &&
        value.loop.halt?.code !== "timeout") throw Error("Controlled first worker timeout receipt cut");
  });
  const outcome = await host.execute();
  host.setSaveObserver(undefined);
  if (receiptCut) await host.execute();
  expect(workers(host).map(call => call.key.split(".").at(-1))).toEqual(["a1", "a2"]);
  expect(host.current().loop.halt.code, outcome.reason).toBe(timeout ? "timeout" : "recovery");
  return host;
}
const workers = (host: ReturnType<typeof fixture>) => host.launches.filter(call => call.agent === "pitako.worker");
function finishRestoration(host: ReturnType<typeof fixture>) {
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker") {
      const saved = host.current(), restore = saved.loop.attempt.restore;
      restoreCheckpoint(restore.sourceKeys.map((key: string) => saved.taskFrame.intents[key]), restore.authority);
    }
    return normal();
  });
}

test.each([false, true])("a raised worker timeout retires the exact terminal restoring writer (receipt cut: %s)", async receiptCut => {
  const host = await timedOutRestoration(true, receiptCut);
  const old = copy(host.current().loop.attempt);
  expect(old.launch.launchedMs).toBe(initialMs);
  expect(old.launch.results).toEqual([{ agent: "pitako.worker",
    structuredOutputPath: `/native/witness/${old.key}.json`, timedOut: true, exitCode: 1 }]);
  expect(readFileSync(path.join(host.root, "src/change1.ts"), "utf8")).toBe("uncertain partial bytes");
  finishRestoration(host);
  let atLaunch: any;
  host.setLaunchRespond(async (request, normal) => {
    if (request.agent === "pitako.worker") atLaunch = copy(host.current().loop);
    return normal();
  });
  const outcome = await host.execute({ timeouts: { workerMs: initialMs + 1 } });
  expect(outcome.status, outcome.reason).toBe("complete");
  expect(workers(host).map(call => call.key.split(".").at(-1))).toEqual(["a1", "a2", "a3"]);
  expect(workers(host).at(-1)!.timeoutMs).toBe(initialMs + 1);
  expect(atLaunch.retired).toContainEqual(old.launch);
  expect(atLaunch.attempt.timeoutGeneration).toBe(2);
  expect(atLaunch.attempt.restore.sourceKeys).toContain(old.checkpoint.key);
  expect(atLaunch.halt).toBeUndefined();
  expect(existsSync(path.join(host.root, "src/change1.ts"))).toBe(false);
  const retained = JSON.parse(JSON.parse(readFileSync(path.join(host.root,
    ".pi/subagents/checkpoints/invoke-human-1.l1.t1.a1/restore.json"), "utf8")).data);
  expect(Buffer.from(retained.partial[0].image.bytes, "base64").toString()).toBe("uncertain partial bytes");
});

test.each([initialMs, initialMs - 1])("worker timeout %s cannot renew the restoring writer", async workerMs => {
  const host = await timedOutRestoration(), count = workers(host).length;
  expect((await host.execute({ timeouts: { workerMs } })).status).toBe("partial");
  expect(workers(host)).toHaveLength(count);
  expect(host.current().loop.halt.code).toBe("timeout");
});

test.each(["missing-timeout", "foreign-evidence", "foreign-child", "foreign-run", "foreign-key", "foreign-agent", "unknown", "running", "stopped", "denied"])(
  "%s evidence cannot authorize worker timeout renewal", async mode => {
    const host = await timedOutRestoration(), old = copy(host.current().loop.attempt), count = workers(host).length;
    if (mode === "missing-timeout") {
      delete host.current().loop.attempt.launch.results;
    }
    if (mode === "foreign-evidence") host.current().loop.attempt.launch.key = "other-worker";
    if (mode === "foreign-child") {
      host.current().loop.attempt.launch.results[0].agent = "pitako.reviewer";
      host.current().loop.halt.ref = copy(host.current().loop.attempt.launch);
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
    expect(host.current().loop.attempt.key).toBe(old.key);
    if (["stopped", "denied", "running"].includes(mode))
      expect(host.current().loop.halt.code).toBe("native-barrier");
    if (["missing-timeout", "foreign-evidence", "foreign-child", "foreign-key", "unknown"].includes(mode)) {
      expect(outcome.reason).toContain("reconcile the retained writer");
      expect(outcome.reason).toContain("No replacement dispatched");
      expect(host.current().loop.halt.reason).toBe(outcome.reason);
      expect(outcome.reason).not.toContain("Relaunch with args.timeouts.workerMs");
    }
  });

test("non-timeout restoration with no new evidence remains human-only", async () => {
  const host = await timedOutRestoration(false);
  expect((await host.execute({ timeouts: { workerMs: initialMs + 1 } })).status).toBe("partial");
  expect(workers(host)).toHaveLength(2);
  expect(host.current().loop.halt.code).toBe("recovery");
});

test.each(["before", "after"])("a cut %s durable retirement replays one fresh worker intention", async when => {
  const host = await timedOutRestoration();
  const retiring = (value: any) => value.loop?.attempt?.key.endsWith(".a3") && value.loop.retired?.length === 1;
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
  expect(host.current().loop.attempt.timeoutGeneration).toBe(3);
  const outcome = await host.execute({ timeouts: { workerMs: initialMs + 3 } });
  expect(outcome.status).toBe("partial");
  expect(outcome.reason).toContain("use a new invocation");
  expect(workers(host)).toHaveLength(4);
});
