import { expect, test } from "bun:test";
import { copy, executeControllerFixture } from "./fixtures/execute-workflow.ts";
import { EXECUTE_STATE_VERSION } from "../extensions/execute-state.ts";
import { canonicalDigest, sha256 } from "../extensions/canonical.mjs";
import { readFileSync } from "node:fs";
const { summarizeLoops } = await import("../skills/execute/ledger.mjs");

const { fixture } = executeControllerFixture();

function transitionFixture(cancellation = false) {
  const host = fixture(undefined, {
    taskCount: cancellation ? 2 : 1,
    humanPosts: [{ id: 1, type: "HUMAN", content: "Context ".repeat(750) }] });
  host.setLimit(2);
  host.storage.set("unrelated", { content: "u".repeat(10000) });
  const saves: { bytes: number; value: any }[] = [];
  host.setSaveObserver((value, bytes, serialized) => {
    expect(bytes).toBe(Buffer.byteLength(serialized));
    saves.push({ bytes, value: copy(value) });
  });
  let cancellationRequested = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker" || request.resume) {
      Object.assign(result.structuredOutput, { status: request.key.includes(".l1.") ? "continue" : "blocked",
        work: "Useful scoped implementation", remaining: ["Finish remaining implementation"],
        knowledge: { findings: ["Scoped evidence ".repeat(150)], handoff: "Retained context ".repeat(150) } });
    }
    if (cancellation && request.key === "invoke-human-1.l1.nextAdvance.requests") cancellationRequested = true;
    if (cancellationRequested && request.agent === "pitako.request-observer") {
      const page = JSON.parse(result.output!);
      page.requests = [{ v: 1, requestId: "cancel-1", invocation: "human-1",
        taskId: "change1", kind: "cancel", origin: "model" }];
      result.output = JSON.stringify(page);
    }
    return result;
  });
  return { host, saves };
}

function diskReceipt(reference: any) {
  const bytes = readFileSync(reference.path);
  expect(sha256(bytes)).toBe(reference.digest);
  const marker = JSON.parse(bytes.toString());
  expect(canonicalDigest(marker.result)).toBe(marker.resultDigest);
  return marker.result;
}

test("at least three heavy attempts close gaps and advance within the whole-file envelope", async () => {
  const { host, saves } = transitionFixture();
  const output = await host.execute();
  console.log("transition measured whole-file peak bytes:", Math.max(...saves.map(save => save.bytes)));
  expect(host.launches.filter(call => /\.l1\.t1\.a\d+$/.test(call.key)).length).toBeGreaterThanOrEqual(3);
  expect(host.history()[0].outcome).toBe("gaps");
  expect(host.current().loop.number, output.reason).toBe(2);
  expect(Math.max(...saves.map(save => save.bytes))).toBeLessThanOrEqual(262144);
  expect(host.storage.get("unrelated").content).toHaveLength(10000);
  const prepared = saves.find(save => save.value.preparedNext)!.value;
  expect(Object.keys(prepared.loop.nextAdvance.receipt).sort()).toEqual(["digest", "path"]);
  expect(prepared.loop.nextAdvance).not.toHaveProperty("input");
  expect(prepared.preparedNext.receipt).not.toHaveProperty("view");
  for (const { value } of saves) {
    if (value.loop?.prepare) expect(value.loop.prepare.receipt).not.toHaveProperty("view");
  }
  const receipt = diskReceipt(prepared.loop.nextAdvance.receipt);
  expect(receipt.operation).toBe("advance");
  expect(host.records().some((record: any) => record.kind === "loop" && record.loop === 1)).toBe(true);
  expect(host.current().loopSummaries).toEqual(summarizeLoops(host.records()));
});

const cuts = {
  "pre-admission": (value: any) => value.loop?.nextAdvance?.stage === "receipt" && !value.loop.nextAdvance.admitted,
  admission: (value: any) => value.loop?.nextAdvance?.admitted && !value.preparedNext,
  "request-observation": (value: any) => !!value.preparedNext && !!value.lastRequestReceipt,
  "cancellation-pending": (value: any) => !!value.preparedNext && !!value.loop?.cancellationInput,
  "cancellation-input": (value: any) => !!value.preparedNext && !!value.loop?.cancellationInput &&
    value.intentions?.some((entry: any) => entry.slot === "cancellation"),
  "cancellation-drain": (value: any) => Object.entries(value.loop ?? {}).some(([slot, pending]: [string, any]) =>
    slot.startsWith("cancellationDrain") && pending.stage === "receipt" && !pending.admitted),
  "new-loop": (value: any) => value.loop?.number === 2 && !value.loop.plan,
};

test.each(Object.entries(cuts))("transition replays after the %s essential save cut", async (name, predicate) => {
  const cancellation = name.startsWith("cancellation-");
  const { host, saves } = transitionFixture(cancellation);
  host.setFailSave(predicate);
  const interrupted = await host.execute();
  expect(interrupted.reason).toContain("Essential persistence failed");
  host.setFailSave();
  const resumed = await host.execute();
  expect(host.current().loop.number, resumed.reason).toBe(2);
  if (cancellation) {
    const uninterrupted = transitionFixture(true).host;
    await uninterrupted.execute();
    expect(host.current().loop.task.id).toBe(uninterrupted.current().loop.task.id);
    expect(host.current().consumedLoops).toBe(uninterrupted.current().consumedLoops);
    expect(host.current().loop.task.id).toBe("change2");
    const director = host.launches.find(call => call.key === "invoke-human-1.l2.director")!;
    const excluded = director.task!.split("\n").find(line => line.startsWith("EXCLUDED SCOPE"))!;
    expect(JSON.parse(excluded.slice(excluded.indexOf(": ") + 2))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "change1", completed: false,
        cancel: expect.objectContaining({ origin: "model", requestId: "cancel-1" }) }),
    ]));
    expect(director.task).toContain("Report this work as unfulfilled: cancelled by main-session request, with its origin.");
    const backlog = JSON.parse(readFileSync(`${host.root}/.pitako/backlog/spec.json`, "utf8"));
    const task = backlog.tasks.find((task: any) => task.id === "change1");
    const cancellations = task.history.filter((entry: any) => entry.event === "cancel");
    expect(cancellations).toHaveLength(1);
    expect(JSON.parse(cancellations[0].reason)).toMatchObject({ requestId: "cancel-1", origin: "model", kind: "cancel" });
    expect(resumed.loopReport.cancelledScope).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "change1", completed: false, cancel: expect.objectContaining({ origin: "model" }) }),
    ]));
    const drain = host.launches.find(call => call.key.includes(".cancellationDrain"))!;
    const evidence = diskReceipt(JSON.parse(host.native.get(drain.key)!.output!));
    expect(evidence.steps.find((step: any) => step.operation === "apply").result.cancelledScope)
      .toEqual(resumed.loopReport.cancelledScope);
  }
  const transition = saves.find(save => save.value.preparedNext)!.value;
  const reference = transition.loop.nextAdvance.receipt;
  const published = JSON.parse(host.native.get("invoke-human-1.l1.nextAdvance")!.output!);
  expect(reference).toEqual({ path: published.path, digest: published.digest });
  const original = diskReceipt(reference);
  const ledger = host.records();
  expect(host.current().loopSummaries).toEqual(summarizeLoops(ledger));
  const observed = host.current().requestObservation;
  const count = host.launches.length;
  await host.execute();
  expect(host.launches).toHaveLength(count);
  expect(host.records()).toEqual(ledger);
  expect(diskReceipt(reference)).toEqual(original);
  expect(host.current().requestObservation).toBe(observed);
  expect(host.calls.filter(call => call.key === "invoke-human-1.l1.nextAdvance.requests")).toHaveLength(1);
  expect(Math.max(...saves.map(save => save.bytes))).toBeLessThanOrEqual(262144);
});

test("changed drained transition evidence is rejected before a next-loop director", async () => {
  const { host } = transitionFixture();
  host.setFailSave(cuts.admission);
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const retained = host.current();
  retained.loop.nextAdvance.receipt.projection.steps[0].result.projection.steps[0].key = "changed-evidence";
  host.setFailSave();
  const output = await host.execute();
  expect(output.reason).toContain("loop-io drain order differs");
  expect(host.launches.some(call => call.key === "invoke-human-1.l2.director")).toBe(false);
});

test("final selection retains one acceptance history and delivers it to review and compliance", async () => {
  const host = fixture(undefined, { taskCount: 0 });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  const loop = host.current().loop;
  expect(loop.acceptanceHistory).toHaveLength(1);
  expect(loop.acceptance).toHaveLength(1);
  for (const field of ["acceptance", "acceptanceHistory"]) {
    expect(loop.prepare.receipt).not.toHaveProperty(field);
    expect(loop.selection.receipt).not.toHaveProperty(field);
  }
  expect(loop.finalAttempt.gate.receipt.view.posts).toBeArray();
  const history = `Acceptance history: ${JSON.stringify(loop.acceptanceHistory)}.`;
  for (const suffix of ["director-prepare", ".compliance"]) {
    const request = host.calls.find(call => call.key.endsWith(suffix))!;
    expect(request.task).toContain(history);
  }
});

test.each(["active", "paused", "legacy-key"])("v9 refuses %s v8 state unchanged before dispatch", async mode => {
  expect(EXECUTE_STATE_VERSION).toBe(9);
  const host = fixture();
  host.storage.set(mode === "legacy-key" ? "pitako-execution" : "invoke-human-1",
    { version: 8, ...(mode === "paused" ? { loop: { halt: { code: "recovery", status: "partial" } } } : {}) });
  const before = copy(Object.fromEntries(host.storage));
  const output = await host.execute();
  expect(output.status).toBe("blocked");
  expect(output.reason).toContain("incompatible Pitako contract v8; start a new mission");
  expect(host.launches).toHaveLength(0);
  expect(Object.fromEntries(host.storage)).toEqual(before);
});
