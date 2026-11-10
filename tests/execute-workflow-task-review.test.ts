import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beginHookEffect, closeHookEffect } from "../extensions/execute-checkpoint.ts";
import { readBacklog } from "../skills/execute/loop.ts";
import { EXECUTE_STATE_VERSION } from "../extensions/execute-state.ts";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();

test.each([false, true])("file-writing task is reviewed before unit admission (native sandbox: %s)", async native => {
  const host = fixture();
  host.setLimit(1);
  const output = await (native ? host.executeNative() : host.execute());
  expect(output.status, output.reason).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  const children = host.launches.filter(call => /\.task-(reviewer|synthesis)$/.test(call.key));
  expect(children.map(call => [call.key, call.agent, call.model])).toEqual([
    ["invoke-human-1.l1.t1.a1.task-reviewer", "pitako.reviewer", "openai-codex/gpt-6.1-sol:xhigh"],
    ["invoke-human-1.l1.t1.a1.task-synthesis", "pitako.reviewer", "anthropic/claude-opus-5-5:high"],
  ]);
  expect(children[0]!.task).toContain("Focused gate passed");
  expect(children[0]!.task).toContain('"touched":["src/change1.ts"]');
  // The fixture captures then leaves the path absent: the net delta is empty.
  expect(children[0]!.task).toContain('"netChanged":[]');
  expect(children[0]!.task).toContain("carried: false");
  const saved = host.snapshots.find(value => value.loop?.attempt?.taskReview?.synthesis);
  expect(saved.loop.attempt.seal).toBeUndefined();
  for (const stage of ["reviewer", "synthesis"]) {
    const original = saved.loop.attempt.taskReview[stage];
    expect(Object.keys(original).sort()).toEqual(["digest", "key", "path", "projection", "runId"]);
    expect(original.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(original.projection.admitted).toBe(true);
  }
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind)).toEqual(["unit"]);
});

test("inherited-only findings remain notes and do not block", async () => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key.endsWith(".task-synthesis")) {
      result.structuredOutput.scope = { verdict: "Satisfied with inherited note", score: 9, findings: [{
        summary: "Unrelated pre-existing issue", introducedByDelta: false, affectsTask: false,
        evidence: "Present in the authenticated baseline outside this task goal",
      }] };
      writeFileSync(result.results![0]!.savedOutputPath!, JSON.stringify(result.structuredOutput));
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  const result = host.history()[0].results[0];
  expect(result.status).toBe("complete");
  expect(result.diagnosis).toContain("Non-blocking inherited notes:");
  expect(result.diagnosis.length).toBeLessThanOrEqual(360);
  const projection = host.snapshots.find(value => value.loop?.attempt?.taskReview?.synthesis)?.loop.attempt.taskReview.synthesis.projection;
  expect(projection.notes.path).toContain(".task-synthesis.json");
  expect(projection.blocking).toEqual([]);
});

test("actual write then revert remains review-eligible with empty netChanged", async () => {
  const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker") {
      const intent = host.current().loop.attempt.checkpoint;
      const file = path.join(host.root, "reverted");
      let seq = beginHookEffect(intent, "write", ["reverted"]);
      writeFileSync(file, "temporary"); closeHookEffect(intent, seq);
      seq = beginHookEffect(intent, "edit", ["reverted"]);
      rmSync(file); closeHookEffect(intent, seq);
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  const brief = host.launches.find(call => call.key.endsWith(".task-reviewer"))!.task;
  expect(brief).toContain('"touched":["reverted","src/change1.ts"]');
  expect(brief).toContain('"netChanged":[]');
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
});

test.each(["complete", "continue", "blocked"])("no-write %s task dispatches no review children and keeps grouped close", async status => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => request.agent === "pitako.worker"
    ? host.result(request, { status, work: "Read only observation", remaining: [] }) : normal());
  const output = await host.execute();
  expect(output.status, output.reason).toBe(status === "blocked" ? "blocked" : "partial");
  expect(host.launches.filter(call => /\.task-(reviewer|synthesis)$/.test(call.key))).toHaveLength(0);
  expect(host.launches.filter(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "close"))
    .toHaveLength(host.launches.filter(call => call.agent === "pitako.worker").length);
});

test("previous execute contract is refused unchanged", async () => {
  const host = fixture(); host.setLimit(1);
  host.setFailSave(value => !!value.loop?.attempt?.checkpoint);
  await host.execute();
  const retained = host.current(); retained.version = EXECUTE_STATE_VERSION - 1;
  host.setFailSave();
  const before = host.launches.length;
  const output = await host.execute();
  expect(output.reason).toContain("incompatible");
  expect(host.launches.length).toBe(before);
});

test("failed gates are not reviewed before continuing to a reviewed completion", async () => {
  const host = fixture(); host.setLimit(1);
  let failed = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "gate" && !failed) {
      failed = true;
      const receipt = JSON.parse(result.output!);
      receipt.gates[0].status = "fail"; receipt.gates[0].exit = 1;
      receipt.progress.nonImproving = 1;
      result.output = JSON.stringify(receipt);
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(host.launches.filter(call => /\.a1\.task-/.test(call.key))).toHaveLength(0);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
});

test("frozen model overrides reach both children and report bodies stay off mission state", async () => {
  const host = fixture(); host.setLimit(1);
  host.setHostResponse((key, value) => key === "inspect-initial" && value.admission
    ? { ...value, admission: { ...value.admission, taskReviewer: "custom/reviewer:low", taskSynthesis: "custom/synthesis" } } : value);
  const marker = "large-task-report-evidence ".repeat(1700);
  host.setRespond((request, normal) => {
    const result = normal();
    if (/\.task-(reviewer|synthesis)$/.test(request.key)) {
      result.structuredOutput.correctness.verdict = marker;
      writeFileSync(result.results![0]!.savedOutputPath!, JSON.stringify(result.structuredOutput));
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(host.launches.filter(call => /\.task-(reviewer|synthesis)$/.test(call.key)).map(call => call.model))
    .toEqual(["custom/reviewer:low", "custom/synthesis"]);
  expect(host.snapshots.every(value => !JSON.stringify(value).includes(marker))).toBe(true);
  expect(Math.max(...host.snapshots.map(value => Buffer.byteLength(JSON.stringify(value))))).toBeLessThan(256 * 1024);
});

test.each(["introduced", "unfinished", "score"])("synthesis %s prevents unit admission", async defect => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key.endsWith(".task-synthesis")) {
      result.structuredOutput.correctness = { verdict: "Concrete defect", score: defect === "score" ? 8 : 9, findings: [{
        summary: "Source-evidenced defect", evidence: "src/change1.ts:1",
        introducedByDelta: defect === "introduced", affectsTask: defect === "unfinished",
      }] };
      writeFileSync(result.results![0]!.savedOutputPath!, JSON.stringify(result.structuredOutput));
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind)).toEqual(["pause", "pause"]);
  expect(host.current().tasks.change1.completed).toBeNull();
});
