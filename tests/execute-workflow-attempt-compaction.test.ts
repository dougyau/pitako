import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { expandWorkerReferences } from "../extensions/execute-state.ts";
import { copy, executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();

test.each(["frozen", "queued", "dispatch", "receipt", "admission"])(
  "checkpoint intent sharing reconciles identical frozen bytes after the %s save cut", async cut => {
    const host = fixture(); host.setLimit(1);
    const frozen = new Map<number, string>();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === "invoke-human-1.l1.t1.a1")
        Object.assign(result.structuredOutput, { status: "continue", remaining: ["Finish implementation"] });
      return result;
    });
    let reached = false;
    host.setFailSave(raw => {
      const value = expandWorkerReferences(copy(raw));
      if (value.sealPending) frozen.set(value.sealPending.record.body.attempt, canonicalDigest(value.sealPending.record));
      const pending = value.finishDrain;
      const queued = value.intentions?.some((entry: any) => entry.input.record?.kind === "unit");
      const matches = cut === "frozen" ? !!value.sealPending
        : cut === "queued" ? queued && !value.sealPending && !value.loop.attempt.dispatched
        : cut === "dispatch" ? queued && pending?.dispatched && pending.stage !== "receipt"
        : cut === "receipt" ? queued && pending?.stage === "receipt" && !pending.admitted
        : frozen.size > 0 && pending?.admitted;
      reached ||= !!matches;
      return reached;
    });
    const interrupted = await host.execute();
    expect(reached, interrupted.reason).toBe(true);
    expect(interrupted.reason).toContain("Essential persistence failed");
    const launched = host.launches.map(call => call.key);
    host.setFailSave();
    const output = await host.execute();
    expect(output.status, output.reason).toBe("partial");
    const records = host.records();
    expect(records.filter((record: any) => record.kind === "unit").map((record: any) => record.body.attempt)).toEqual([1, 2]);
    for (const record of records.filter((record: any) => record.kind === "unit"))
      if (frozen.has(record.body.attempt)) expect(canonicalDigest({
        kind: record.kind, loop: record.loop, body: record.body,
      })).toBe(frozen.get(record.body.attempt)!);
    for (const key of launched) expect(host.launches.filter(call => call.key === key)).toHaveLength(1);
    const before = copy(host.launches);
    await host.execute();
    expect(host.launches).toEqual(before);
    expect(host.records()).toEqual(records);
  });

test("multiple attempts retain keyed intents and compact only published sealed results", async () => {
  const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
  const saves: any[] = [];
  host.setSaveObserver(value => saves.push(expandWorkerReferences(copy(value))));
  host.setRespond((request, normal) => {
    const result = normal();
    if ((request.agent === "pitako.worker" || request.resume) && !request.key.endsWith(".a3"))
      Object.assign(result.structuredOutput, { status: "continue", remaining: ["Finish the task"],
        knowledge: { findings: ["Full original evidence"], handoff: "Full handoff" } });
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(host.launches.filter(call => call.agent === "pitako.worker" || call.resume)).toHaveLength(3);
  const frames = saves.map(value => value.taskFrame).filter(frame => frame?.reviewIntents?.length);
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    for (const list of [frame.reviewIntents, frame.sources ?? []]) {
      expect(new Set(list).size).toBe(list.length);
      for (const key of list) {
        expect(typeof key).toBe("string");
        expect(frame.intents[key].key).toBe(key);
      }
    }
  }
  const delta = host.calls.find(call => call.key.endsWith(".a3.delta"))!;
  const intents = JSON.parse(delta.task).intents;
  expect(intents.map((intent: any) => intent.attempt)).toEqual([1, 2, 3]);
  const original = saves.find(value => value.tasks?.change1?.last?.attempt === 1)!.tasks.change1.last;
  const admission = saves.find(value => value.loop?.attempt?.number === 2 && value.loop.attempt.stage === "result")!;
  const compact = admission.loop.results.find((result: any) => result.attempt === 1);
  expect(compact.sealed).toEqual({ key: original.ref.key, digest: original.checkpoint.confirmation.digest });
  expect(compact.checkpoint).toEqual(original.checkpoint);
  for (const field of ["taskId", "attempt", "status", "ref", "remaining", "remainingCount",
    "workDone", "diagnosis", "candidate", "checks"])
    expect(compact[field]).toEqual(original[field]);
  expect(compact).not.toHaveProperty("knowledge");
  const published = host.records().find((record: any) => record.kind === "unit" && record.body.attempt === 1);
  expect(published.body.result.knowledge).toEqual(original.knowledge);
  expect(published.body.frame.intents[original.ref.key]).toBeDefined();
});

test("an admission-save cut replays compact results without republishing settled work", async () => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key === "invoke-human-1.l1.t1.a1")
      Object.assign(result.structuredOutput, { status: "continue", remaining: ["Finish implementation"] });
    return result;
  });
  host.setFailSave(value => value.loop?.results?.some((result: any) => result.sealed));
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const keys = host.launches.map(call => call.key);
  host.setFailSave();
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(host.records().filter((record: any) => record.kind === "unit").map((record: any) => record.body.attempt))
    .toEqual([1, 2]);
  const records = host.records();
  await host.execute();
  expect(host.records()).toEqual(records);
  for (const key of keys) expect(host.launches.filter(call => call.key === key)).toHaveLength(1);
});

test.each([8, 9])("task-review findings cap accepts %i only without dropping evidence", async count => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key.endsWith(".task-reviewer")) {
      const findings = Array.from({ length: count }, (_, index) => ({
        summary: `Inherited note ${index}`, evidence: `source.ts:${index + 1}`,
        introducedByDelta: false, affectsTask: false, predatesTask: true,
      }));
      result.structuredOutput.correctness = { verdict: "Satisfied with inherited notes", score: 9, findings };
      writeFileSync(result.results![0]!.savedOutputPath!, JSON.stringify(result.structuredOutput));
    }
    return result;
  });
  const output = await host.execute();
  const request = host.calls.find(call => call.key.endsWith(".task-reviewer"))!;
  expect(request.outputSchema.properties.correctness.properties.findings.maxItems).toBe(8);
  expect(request.task).toContain("consolidate related findings");
  const original = JSON.parse(readFileSync(host.native.get(request.key)!.results![0]!.savedOutputPath!, "utf8"));
  expect(original.correctness.findings).toHaveLength(count);
  if (count === 8) {
    expect(host.current().tasks.change1.completed, output.reason).not.toBeNull();
    expect(host.current().loop.results[0].taskReview.reviewer.digest).toBe(canonicalDigest(original));
  } else {
    expect(output.reason).toContain("Invalid anchored task review answer");
    expect(host.current().tasks.change1.completed).toBeNull();
    expect(host.calls.some(call => call.key.endsWith(".task-synthesis"))).toBe(false);
  }
});
