import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { stateCapacity } from "../skills/execute/loop-io.mjs";
import { beginHookEffect, restoreCheckpoint } from "../extensions/execute-checkpoint.ts";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
function observeWholeFile(host: ReturnType<typeof fixture>) {
  host.setSaveObserver((_value, bytes, serialized) => {
    expect(bytes).toBe(Buffer.byteLength(serialized));
    expect(bytes).toBeLessThanOrEqual(262144);
  });
}

test.each([0, 16000, 32000, 48000, 64000, 80000, 100000])(
  "prelaunch capacity: padding sweep through multi-attempt gaps transition (%s bytes)", async padding => {
    const host = fixture(); host.setLimit(2);
    host.storage.set("unrelated", { text: "x".repeat(padding) });
    observeWholeFile(host);
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.execution-director" && request.key.includes(".l2."))
        return { ...result, ok: false, stopped: true };
      if (request.agent === "pitako.worker")
        Object.assign(result.structuredOutput, { status: "continue", remaining: ["Finish scoped work"] });
      return result;
    });
    const output = await host.execute();
    expect(output.reason).not.toContain("exceeds");
    expect(output.reason).not.toContain("Essential persistence failed");
    expect(host.storage.get("unrelated").text).toHaveLength(padding);
    const workers = host.launches.filter(call => call.agent === "pitako.worker");
    if (host.current().loop.halt?.code === "state-capacity") {
      expect(output.status).toBe("blocked");
      expect(output.action).toMatchObject({ actor: "foreground", started: false });
      expect(output.action.operation).toContain("use a new mission");
      expect(output.loopReport.action).toEqual(output.action);
      expect(host.current().loop.halt.capacity.total).toBeGreaterThan(262144);
      expect(workers.some(call => call.key === host.current().loop.attempt.key)).toBe(false);
      expect(host.current().intentions).toEqual([]);
      expect(host.current().sealPending).toBeNull();
      const launches = structuredClone(host.launches), records = host.records();
      expect((await host.execute()).reason).toBe(output.reason);
      expect(host.launches).toEqual(launches);
      expect(host.records()).toEqual(records);
    } else {
      expect(host.current().loop.number, output.reason).toBe(2);
      expect(workers.length).toBeGreaterThanOrEqual(3);
      expect(host.history()[0].outcome).toBe("gaps");
    }
    if (padding === 0) expect(host.current().loop.number).toBe(2);
    if (padding === 100000) expect(host.current().loop.halt.code).toBe("state-capacity");
  });

test.each(["initial", "continuation", "resume", "restoration", "timeout renewal"]
  .flatMap(route => [false, true].map(blocked => [route, blocked] as const)))(
  "prelaunch capacity: worker routes %s (blocked: %s)", async (route, blocked) => {
    const restoring = route === "restoration" || route === "timeout renewal";
    const host = fixture(undefined, { realCheckout: restoring });
    host.setLimit(2);
    host.storage.set("unrelated", { text: "Independent mission state" });
    observeWholeFile(host);
    if (restoring) {
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.agent === "pitako.worker") {
          beginHookEffect(host.current().loop.attempt.checkpoint, "write", ["src/change1.ts"]);
          mkdirSync(path.join(host.root, "src"), { recursive: true });
          writeFileSync(path.join(host.root, "src/change1.ts"), "uncertain partial bytes");
        }
        return result;
      });
      host.setFailSave(value => !value.activePlan && !!value.loop?.attempt?.launch);
      expect((await host.execute()).reason).toContain("Essential persistence failed");
      host.setFailSave();
      host.setHostResponse((key, value) => {
        const loop = host.current()?.loop, attempt = loop?.attempt;
        return !key.startsWith("inspect-") || !attempt ? value : { ...value, checkpointObservation: {
          key: attempt.key, taskId: attempt.taskId, attempt: attempt.number, loop: loop.number,
          cursor: loop.cursor, evidence: canonicalDigest("unchanged checkpoint observation"),
        } };
      });
      host.setStatus(ref => ref.includes(".t1.a1") ? { ok: true, results: [] }
        : { ok: true, runId: ref, results: [], output: `Nested run: ${ref}\nState: failed` });
      if (route === "timeout renewal") {
        host.setRespond((request, normal) => {
          if (request.agent !== "pitako.worker") return normal();
          const result = host.result(request, null);
          return { ...result, ok: false,
            results: result.results!.map(entry => ({ ...entry, timedOut: true, exitCode: 1 })) };
        });
        expect((await host.execute()).status).toBe("partial");
        expect(host.current().loop.halt.code).toBe("timeout");
        expect(host.current().loop.attempt.launch.launchedMs).toBe(14400000);
      }
    }
    const target = route === "initial" ? 1 : route === "timeout renewal" ? 3 : 2;
    const targetKey = `invoke-human-1.l1.t1.a${target}`;
    let atLaunch: any;
    host.setRespond((request, normal) => {
      if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "stateCapacity" &&
          request.key.startsWith(targetKey + ".") && blocked)
        host.storage.set("unrelated", { text: "x".repeat(110000) });
      if (request.key === targetKey && (request.agent === "pitako.worker" || request.resume)) {
        atLaunch = structuredClone(host.current());
        if (restoring) {
          const { restore } = atLaunch.loop.attempt;
          expect(restore.sourceKeys.length).toBeGreaterThan(0);
          restoreCheckpoint(restore.sourceKeys.map((key: string) => atLaunch.taskFrame.intents[key]), restore.authority);
        }
      }
      const result = normal();
      if (["continuation", "resume"].includes(route) && request.agent === "pitako.worker" && request.key.endsWith(".a1"))
        Object.assign(result.structuredOutput, { status: "continue", remaining: ["Finish scoped work"],
          ...(route === "resume" ? { continuation: { mode: "resume", reason: "Retain context" } } : {}) });
      if (route === "resume" && request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "gate") {
        const receipt = JSON.parse(result.output!);
        receipt.contextPeak = 100;
        result.output = JSON.stringify(receipt);
      }
      return result;
    });
    const output = await host.execute(route === "timeout renewal" ? { timeouts: { workerMs: 14400001 } } : {});
    expect(output.reason).not.toContain("exceeds");
    expect(output.reason).not.toContain("Essential persistence failed");
    const targetLaunches = host.launches.filter(call => call.key === targetKey);
    expect(targetLaunches).toHaveLength(blocked ? 0 : 1);
    if (blocked) {
      expect(output.status, output.reason).toBe("blocked");
      expect(output.reason).toContain("use a new mission");
      expect(host.current().intentions).toEqual([]);
      expect(host.current().sealPending).toBeNull();
      const records = host.records(), launches = structuredClone(host.launches);
      expect((await host.execute({ timeouts: { workerMs: 86400000 } })).reason).toBe(output.reason);
      expect(host.launches).toEqual(launches);
      expect(host.records()).toEqual(records);
      if (route === "continuation" || route === "resume")
        expect(records.filter((record: any) => record.kind === "unit")).toHaveLength(1);
      if (restoring) expect(readFileSync(path.join(host.root, "src/change1.ts"), "utf8")).toBe("uncertain partial bytes");
    } else {
      expect(output.status, output.reason).toBe("complete");
      expect(atLaunch.loop.attempt.capacityIO.receipt.unrelated).toBeGreaterThan(0);
      if (route === "resume") expect(targetLaunches[0]!.resume).toBe("native-invoke-human-1.l1.t1.a1");
      if (route === "timeout renewal") {
        expect(targetLaunches[0]!.timeoutMs).toBe(14400001);
        expect(atLaunch.loop.attempt.timeoutGeneration).toBe(2);
        expect(atLaunch.loop.retired[0].key).toBe("invoke-human-1.l1.t1.a2");
      }
    }
  });

test("capacity observation measures native whole-file UTF-8 framing including unrelated keys", () => {
  const host = fixture();
  const input = { missionPath: path.join(host.root, "missions", "mission.json"),
    missionId: "mission", invocation: "test" };
  const whole = { unrelated: { text: "界\n".repeat(100) },
    "invoke-test": { association: input, activePlan: null, loop: {} } };
  const file = path.join(host.root, "missions", "mission", "state.json");
  mkdirSync(path.dirname(file), { recursive: true });
  // Whitespace on disk does not change the native setter's framed size.
  writeFileSync(file, JSON.stringify(whole));
  const actual = stateCapacity(input);
  expect(actual.total).toBe(Buffer.byteLength(JSON.stringify(whole, null, 2)));
  expect(actual.execute).toBe(Buffer.byteLength(JSON.stringify({ "invoke-test": whole["invoke-test"] }, null, 2)));
  expect(actual.unrelated + actual.execute).toBe(actual.total);
  expect(() => stateCapacity({ ...input, invocation: "different" })).toThrow("association mismatch");
});

test("a malformed whole-file observation prevents worker launch", async () => {
  const host = fixture();
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "stateCapacity")
      result.output = JSON.stringify({ total: 10, execute: 9, unrelated: -1 });
    return result;
  });
  const output = await host.execute();
  expect(output.reason).toContain("Invalid whole-file state capacity observation");
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toEqual([]);
});

test.each(["none", "halt", "drain", "drain-stop"])("capacity admission: halt and drain is durable and idempotent (cut: %s)", async cut => {
  const host = fixture(); host.setLimit(1);
  let haltWasDurable = false;
  host.setSaveObserver((value, bytes) => {
    expect(bytes).toBeLessThanOrEqual(262144);
    if (value.loop?.halt?.code === "state-capacity") haltWasDurable = true;
  });
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker") {
      Object.assign(result.structuredOutput, { status: "continue", remaining: ["Finish scoped work"] });
      host.storage.set("unrelated", { text: "x".repeat(100000) });
    }
    if (request.agent === "pitako.execution-ledger") expect(haltWasDurable).toBe(true);
    return result;
  });
  if (cut !== "none") {
    host.setFailSave(value => value.loop?.halt?.code === "state-capacity" &&
      (cut === "halt" || value.finishDrain?.stage === (cut === "drain-stop" ? "receipt" : "intention")));
    expect((await host.execute()).reason).toContain("Essential persistence failed");
    expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(host.records().filter((record: any) => record.kind === "unit")).toHaveLength(0);
    expect(host.current().loop.halt?.code).toBe(cut === "halt" ? undefined : "state-capacity");
    host.setFailSave();
  }
  if (cut === "drain-stop") {
    const capacity = structuredClone(host.current().loop.halt);
    let stopped: any;
    host.setStatus(() => ({ ok: true, results: [] }));
    host.setLaunchRespond((request, normal) => {
      if (request.agent !== "pitako.loop-io" || JSON.parse(request.task).operation !== "drain") return normal();
      stopped = { ...host.result(request, null), key: request.key, ok: false, stopped: true };
      return stopped;
    });
    const output = await host.executeNative();
    expect(output.status, output.reason).toBe("cancelled");
    expect(stopped).toBeDefined();
    const halt = structuredClone(host.current().loop.halt);
    expect(halt).toMatchObject({ code: "native-barrier", cause: "stopped",
      ref: { key: stopped.key, runId: stopped.runId } });
    expect(halt.ref).toEqual(host.current().finishDrain.ref);
    expect(host.current().loop.attempt.interruption).toEqual(capacity);
    const launches = structuredClone(host.launches);
    host.setLaunchRespond();
    const replay = await host.executeNative();
    expect(replay.status).toBe("cancelled");
    expect(host.current().loop.halt).toEqual(halt);
    expect(host.launches).toEqual(launches);
    return;
  }
  const output = await host.execute();
  expect(output.status, output.reason).toBe("blocked");
  expect(output.reason).toContain("use a new mission");
  expect(output.reason).toContain("U + S + K + R");
  const retained = host.current(), halt = retained.loop.halt;
  expect(halt.code).toBe("state-capacity");
  expect(halt.capacity.total).toBeGreaterThan(262144);
  expect(halt.capacity.U).toBeGreaterThan(100000);
  expect(halt.capacity.K.sealBodyTwice).toBeGreaterThan(0);
  expect(halt.capacity.total).toBe(halt.capacity.U + halt.capacity.S +
    Object.values(halt.capacity.K).reduce((sum: number, bytes: any) => sum + bytes, 0) + halt.capacity.R);
  expect(retained.intentions).toEqual([]);
  expect(retained.sealPending).toBeNull();
  expect(host.records().filter((record: any) => record.kind === "unit")).toHaveLength(1);
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
  const launches = structuredClone(host.launches), records = structuredClone(host.records());
  const replay = await host.execute({ timeouts: { workerMs: 86400000, reviewerMs: 86400000, gateFloorMs: 86400000 } });
  expect(replay.status).toBe("blocked");
  expect(replay.reason).toBe(output.reason);
  expect(host.current().loop.halt).toEqual(halt);
  expect(host.launches).toEqual(launches);
  expect(host.records()).toEqual(records);
});

test.each([false, true, "divergent-routing"] as const)("over-limit received results preserve normal admission; only a pre-admission crash needs recovery (%s)", async cut => {
  const host = fixture(); host.setLimit(1);
  let replayRef: any;
  host.setSaveObserver((value, bytes) => {
    expect(bytes).toBeLessThanOrEqual(262144);
  });
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker")
      result.structuredOutput.work = "w".repeat(40000);
    return result;
  });
  if (cut) {
    host.setFailSave(value => value.loop?.attempt?.launch &&
      value.loop.attempt.stage === "launched" &&
      (cut === "divergent-routing" ? !!value.loop.attempt.gate : !value.loop.attempt.gate));
    expect((await host.execute()).reason).toContain("Essential persistence failed");
    expect(host.current().loop.attempt.received).toBeUndefined();
    host.setFailSave();
    host.setStatus(ref => {
      const original = host.native.get(ref)!;
      if (cut === "divergent-routing" && original.agent === "pitako.worker") {
        const observed = structuredClone(original);
        delete observed.agent;
        observed.outputReference = original.outputReference + ".status";
        replayRef = observed;
        return observed;
      }
      return { ok: true, key: original.key, runId: original.runId, state: "complete", results: [] };
    });
  }
  const output = await host.execute();
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(cut === true ? 2 : 1);
  if (cut === true) {
    expect(output.status, output.reason).toBe("blocked");
    expect(host.current().loop.halt.code).toBe("recovery");
  } else {
    expect(output.status, output.reason).toBe("partial");
    expect(host.current().loop.halt).toBeUndefined();
    const unit = host.records().find((record: any) => record.kind === "unit");
    expect(unit.body.result.status).toBe("complete");
    expect(unit.body.result.workDone).toBe("w".repeat(360));
    expect(host.current().loop.attempt).toBeNull();
    if (cut === "divergent-routing") {
      expect(unit.body.result.ref.outputReference).toBe(replayRef.outputReference);
      expect(unit.body.result.ref.agent).toBeUndefined();
      const saved = JSON.stringify(unit);
      await host.execute();
      expect(JSON.stringify(host.records().find((record: any) => record.kind === "unit"))).toBe(saved);
      expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    }
  }
});

test("ordinary tasks continue after repairs and timeout generations without exhausting state", async () => {
  const taskCount = 9;
  const host = fixture(undefined, { taskCount, retainSnapshots: false });
  host.setLimit(12);
  host.storage.set("unrelated", { text: "Independent mission state" });
  let peak = 0;
  host.setSaveObserver((value, bytes, serialized) => {
    expect(bytes).toBe(Buffer.byteLength(serialized));
    expect(bytes).toBeLessThanOrEqual(262144);
    peak = Math.max(peak, bytes);
  });
  host.setStatus(ref => ({ ...structuredClone(host.native.get(ref)!), state: "complete" }));
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker") delete result.agent;
    const repairLoop = /\.l(?:1|9)\./.test(request.key);
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
  const expectedGenerations = 12;
  while (host.current().loop.halt?.code === "timeout" && generations < expectedGenerations) {
    const halt = host.current().loop.halt;
    generations++;
    output = await host.execute({ timeouts: {
      [halt.class === "gate-transport" ? "gateFloorMs" : "reviewerMs"]: halt.launchedMs + 1,
    } });
  }
  expect(output.status, output.reason).toBe("complete");
  expect(generations).toBe(expectedGenerations);
  const attempts = taskCount + 4;
  expect(host.launches.filter(request => request.agent === "pitako.worker")).toHaveLength(attempts);
  expect(peak).toBeLessThanOrEqual(262144);
  expect(host.current().intentions).toEqual([]);
  expect(host.records().filter((record: any) => record.kind === "unit")).toHaveLength(attempts);
});
