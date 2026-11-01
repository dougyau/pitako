import { expect, test } from "bun:test";
import { executeControllerFixture, copy, gaps, source } from "./fixtures/execute-workflow.ts";
import { digest } from "../extensions/spec-plans.ts";
import { MISSION_STATE_MAX_BYTES } from "../node_modules/pi-subagents/src/missions/workflow-state.js";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";

const { fixture } = executeControllerFixture();

test("30 loops of eight tasks retain constant state across pauses, recoveries and --unblock", async () => {
  const host = fixture(undefined, { taskCount: 7, controlledCheckpoints: true, controlledPublisher: true, retainSnapshots: false }); host.setLimit(30);
  const candidate = host.observedCandidate(), sizes: { loop: number; bytes: number }[] = [];
  const admittedSeals = new Set<string>();
  let peak: any, peakBytes = 0;
  host.setSaveObserver((value, bytes) => {
    expect(value).not.toHaveProperty("loops");
    sizes.push({ loop: value.consumedLoops, bytes });
    if (bytes > peakBytes) { peakBytes = bytes; peak = copy(value); }
    if (!value.sealPending && value.lastConfirmed)
      admittedSeals.add(`${value.lastConfirmed.position.loop}:${value.lastConfirmed.digest}`);
  });
  const originals = new Map<number, any>();
  let budgetCut = false;
  host.setRespond((request, normal) => {
    const number = Number(request.key.match(/\.l(\d+)\./)![1]);
    if (!budgetCut && number === 15 && request.key.endsWith(".t2.a1")) {
      budgetCut = true;
      const error = new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: `workflow[${request.key}]`,
        used: 64, limit: 64, requested: 1, remaining: 0 }).message;
      return { key: request.key, ok: false, error, output: error, artifactPaths: [] };
    }
    if (request.agent === "pitako.execution-inspector")
      return host.result(request, { status: "recovered", reason: "Exact original plan",
        original: originals.get(number), workerResult: null, originalAvailable: true,
        binding: "absent", comparison: "only-original", provenance: ["/native/plan"] });
    if (request.agent === "pitako.worker" && request.key.endsWith(".t1.a1"))
      return host.result(request, { ...host.worker(request, "pause"), status: "blocked",
        remaining: ["Finish pending unit"], continuation: "Resume admitted pause" });
    if (request.agent === "pitako.worker" && request.key.endsWith(".t1.a2")) {
      const descriptor = JSON.parse(request.task.split("FROZEN ATTEMPT:\n")[1]!.split("\n")[0]!);
      const observation = descriptor.restore.observations[0], pause = descriptor.restore.authority.confirmedPause;
      const restored = { checkpointRef: observation.manifest, digest: digest(descriptor.key),
        partialRef: observation.manifest.replace(/manifest\.json$/, "restore.json"),
        position: { loop: number, cursor: 0, phase: "implementation" },
        candidate, confirmedPause: { checkpointRef: pause.checkpointRef, digest: pause.digest } };
      const restoredRef = observation.manifest.replace(/manifest\.json$/, "restored.json");
      const value = host.worker(request);
      value.git.checkpoints.push(restored.partialRef, restoredRef);
      return host.result(request, { ...value, restoreReceipt: { ...restored, restoredRef } });
    }
    const result = normal();
    if (request.agent === "pitako.execution-director") {
      originals.set(number, copy(result.structuredOutput)); delete result.structuredOutput;
    }
    return request.key.endsWith(".compliance") ? gaps(result) : result;
  });
  let output = await host.execute();
  for (let number = 1; number <= 30; number++) {
    expect(output.status, output.reason).toBe("blocked");
    expect(host.current().loop.number, output.reason).toBe(number);
    output = await host.execute({ unblock: true, resolution: { loop: number, text: "Resume the pending unit." } });
    if (output.status === "budget-exhausted") {
      const before = host.current().consumedLoops;
      output = await host.execute();
      expect(host.current().consumedLoops).toBe(before + 1);
    }
  }
  expect(budgetCut).toBe(true);
  expect(output.status, output.reason).toBe("partial");
  const records = host.records(); // verifies every link against state's head
  expect(records.filter((record: any) => record.kind === "loop").map((record: any) => record.loop))
    .toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
  const units = records.filter((record: any) => record.kind === "unit");
  expect(units).toHaveLength(30 * 8); // one pause plus seven completed implementations per loop
  expect(new Set(units.map((record: any) => `${record.loop}:${record.body.checkpoint.digest}`))).toEqual(admittedSeals);
  const maximum = (from: number, to: number) => Math.max(...sizes
    .filter(value => value.loop >= from && value.loop <= to).map(value => value.bytes));
  const early = maximum(3, 5), late = maximum(25, 30), margin = 4096;
  console.log(`state bytes: loops 3-5 max=${early}; loops 25-30 max=${late}; margin=${margin}`);
  const breakdown = (value: any) => Object.fromEntries(Object.entries(value).map(([name, item]) =>
    [name, Buffer.byteLength(JSON.stringify({ [name]: item }, null, 2))]).sort((a, b) => Number(b[1]) - Number(a[1])));
  console.log("peak breakdown", JSON.stringify({ top: breakdown(peak), loop: breakdown(peak.loop),
    tasks: breakdown(peak.tasks), task: breakdown(peak.tasks.change1) }));
  expect(late).toBeLessThanOrEqual(early + margin);
  // Preserve half the native envelope for real reports, paths and one long open loop.
  expect(peakBytes).toBeLessThan(MISSION_STATE_MAX_BYTES / 2);
  expect(host.current().planRejections).toHaveLength(3);
  expect(host.current().closeReferences).toHaveLength(3);
  expect(host.current().loopSummaries).toHaveLength(3);
  expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(30);
  // inspect-initial is the configured pre-admission host grant, before any loop exists.
  // inspect-initial.r1 repeats that fixed pure grant before any loop exists.
  // inspect-initial.r2 repeats that fixed pure grant before any loop exists.
  for (const key of [...host.calls.map(call => call.key), ...host.statusCalls, ...host.hostCalls])
    if (!["inspect-initial", "inspect-initial.r1", "inspect-initial.r2"].includes(key)) expect(key).toMatch(/\.l\d+\./);
}, 20_000); // Human decision m01583: AGENTS.md timeout exception for the 30-loop workload.

test.each([1, 2])("closed dispositions never enter operation consumers, including the retained terminal loop (%s)", async number => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(2);
  host.setRespond((request, normal) => request.key.endsWith(".compliance") ? gaps(normal()) : normal());
  await host.execute();
  host.current().lastClosedResolution = { request: {
    missionId: "native.mission-1", missionPath: "/native/exact-mission", invocation: "human-1",
    root: host.root, id: "spec", inspectionCommand: "READ", sourceRefs: [],
  }, loop: number, text: "Earlier disposition", stage: "accepted" };
  const guarded = source
    .replace("function reconcileRetainedRecoveries() {", 'function reconcileRetainedRecoveries() { throw new Error("Closed recovery consumer reached");')
    .replace("function reconcileInterruptedOperations() {", 'function reconcileInterruptedOperations() { throw new Error("Closed interruption consumer reached");')
    .replace("function assertFallbackProducer(observed, ref) {", 'function assertFallbackProducer(observed, ref) { throw new Error("Closed checkpoint consumer reached");');
  const before = host.calls.length;
  const result = await host.execute({ unblock: true, resolution: { loop: number, text: "Earlier disposition" } }, guarded);
  expect(result.reason).not.toContain("consumer reached");
  expect(result.status).toBe("partial");
  expect(host.calls).toHaveLength(before);
  expect(host.current().lastClosedResolution).not.toHaveProperty("operations");
  expect(host.current().lastClosedResolution).not.toHaveProperty("halt");
});

test("a gaps publisher delivers its verified rejection summary to the very next director", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(2);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key === "invoke-human-1.l1.director") result.structuredOutput.tasks = [];
    return result;
  });
  const output = await host.execute();
  expect(output.status).toBe("complete");
  const next = host.calls.find(call => call.key === "invoke-human-1.l2.director")!;
  expect(next.task).toContain("loop_plan needs full ordered task scopes");
  expect(next.task).toContain(JSON.stringify(host.current().loopSummaries[0]));
  expect(next.task).toContain('"ledgerPath":');
  const consumers = host.calls.filter(call => call.key === "invoke-human-1.l2.review.director-prepare" ||
    call.key === "invoke-human-1.l2.compliance");
  expect(consumers).toHaveLength(2);
  for (const call of consumers) {
    expect(call.task).toContain(JSON.stringify(host.current().loopSummaries[0]));
    expect(call.task).toContain('"ledgerPath":');
    expect(call.task).toContain("ledger.mjs");
  }
  expect(output.loopReport.history).toEqual({ summaries: host.current().loopSummaries,
    ledgerPath: `${host.root}/.pi/subagents/execute/human-1`, head: host.current().ledger.head });
  expect(host.current()).not.toHaveProperty("loops");
});

test.each([4, 5])("plan rejection ring remembers three loops, not all history (repeat at %s)", async repeat => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(6);
  host.setRespond((request, normal) => {
    const number = Number(request.key.match(/\.l(\d+)\./)![1]), result = normal();
    if (request.agent === "pitako.execution-director" && [1, repeat].includes(number))
      result.structuredOutput.tasks = [];
    return request.key.endsWith(".compliance") && number < repeat ? gaps(result) : result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe(repeat === 4 ? "blocked" : "complete");
  expect(host.calls.some(call => call.key === "invoke-human-1.l6.director")).toBe(repeat === 5);
});

test.each([4, 5])("native closing references ring rejects only last three loops (reuse at %s)", async repeat => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(repeat);
  let original: any;
  host.setRespond((request, normal) => {
    const number = Number(request.key.match(/\.l(\d+)\./)![1]), result = normal();
    if (request.agent === "pitako.checkout-observer") {
      if (number === 1) original = copy(result);
      if (number === repeat) Object.assign(result, { runId: original.runId, asyncDir: original.asyncDir,
        externalAdapter: original.externalAdapter });
    }
    return request.key.endsWith(".compliance") ? gaps(result) : result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe(repeat === 4 ? "blocked" : "partial");
  if (repeat === 4) expect(output.reason).toContain("reuses another loop");
  else expect(host.current().closeReferences.map((item: any) => item.loop)).toEqual([3, 4, 5]);
});

test("unblock selects invocation, last closed, then open resolutions; older closed requests are unavailable", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(2);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director")
      Object.assign(result.structuredOutput, { status: "needs-decision", tasks: [] });
    return result;
  });
  expect((await host.execute()).status).toBe("blocked");
  const input = { unblock: true, resolution: { loop: 1, text: "Continue after answering the question." } };
  expect((await host.execute(input)).status).toBe("blocked");
  const state = host.current(), disposition = copy(state.lastClosedResolution);
  expect(disposition).toMatchObject({ ...input.resolution, stage: "applied" });
  expect(Object.keys(disposition).sort()).toEqual(["loop", "request", "stage", "text"]);
  const entry = (cause: string) => ({ ...copy(disposition), currentBarrier: { cause } });
  state.resolutions = [entry("invocation")];
  state.lastClosedResolution = entry("closed");
  state.loop.resolutions = [entry("open")];
  expect((await host.execute(input)).reason).toContain("native barrier: invocation");
  delete state.resolutions;
  expect((await host.execute(input)).reason).toContain("native barrier: closed");
  state.lastClosedResolution = null;
  expect((await host.execute(input)).reason).toContain("native barrier: open");
  delete state.loop.resolutions;
  expect((await host.execute(input)).reason).toContain("must name the retained interrupted loop");
});

test.each([false, true])("closing rebuilds identical bytes after a save cut; source mutation=%s", async mutate => {
  const host = fixture(undefined, { readOnly: true });
  host.setFailSave(value => !!value.loop?.closing);
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const request = host.calls.find(call => call.agent === "pitako.checkout-observer")!;
  const published = copy(host.native.get(`native-${request.key}`)!);
  expect(host.current().loop.archivePending.record).not.toHaveProperty("body");
  host.setFailSave();
  if (mutate) host.current().loop.compliance.reason = "Changed during closing";
  else {
    delete host.current().loop.observation.validated;
    host.setStatus(() => ({ ...published, output: "Controlled receipt loss; republish frozen body" }));
  }
  const output = await host.execute();
  if (mutate) {
    expect(output.reason).toContain("Closing archive source fields changed");
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toHaveLength(1);
  } else {
    expect(output.status, output.reason).toBe("complete");
    const publications = host.calls.filter(call => call.agent === "pitako.checkout-observer");
    expect(publications.length).toBeGreaterThan(1);
    for (const call of publications)
      expect(JSON.parse(call.task).body.record).toEqual(JSON.parse(request.task).body.record);
    expect(host.records()).toHaveLength(2);
  }
});

test("admission amendments reach every phase without the director copying them into the plan", async () => {
  const host = fixture();
  const amendments = [{ path: "/worktree/.pitako/amendments/human.md", sha256: "a".repeat(64),
    provenance: "human message h1 at 2026-10-31T06:12:50Z" }];
  // The fixture director paraphrases nothing and omits amendments from sharedContext entirely.
  const output = await host.execute({ amendments });
  expect(output.status, output.reason).toBe("complete");
  expect(host.current().amendments).toEqual(amendments);
  const phases = host.calls.filter(call => /\.director$|\.t\d+\.a\d+$|\.compliance$|\.review\./.test(call.key));
  for (const pattern of [/\.director$/, /\.t\d+\.a\d+$/, /\.compliance$/, /\.review\./])
    expect(phases.some(call => pattern.test(call.key))).toBe(true);
  for (const call of phases) expect(call.task, call.key).toContain(JSON.stringify(amendments));
});
