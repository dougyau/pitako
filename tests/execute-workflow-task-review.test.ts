import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { beginHookEffect, closeHookEffect } from "../extensions/execute-checkpoint.ts";
import { readBacklog } from "../skills/execute/loop.ts";
import { EXECUTE_STATE_VERSION } from "../extensions/execute-state.ts";
import { EXECUTE_CURSOR_KEY, executeCursorSchema, validateExecuteCursor } from "../extensions/execute-cursor.ts";
import { reviewCursorContract } from "../skills/review/cursor.mjs";
import { copy, executeControllerFixture, maximalCursor } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();

test("the three maximal Pitako cursors fit the 49152-byte mission-state bound", () => {
  const architecture = readFileSync(new URL("../skills/architecture/workflow.js", import.meta.url), "utf8");
  const architectureMaximum = new Function(`
    const architectureVersion = 4, cursorVersion = 3, utf8Bytes = s => unescape(encodeURIComponent(s)).length;
    ${architecture.slice(architecture.indexOf("function architectureCursorSchema("), architecture.indexOf("function validateArchitectureCursor("))}
    return architectureStateBound().skeleton;`)();
  const review = reviewCursorContract();
  function maximum(schema: any): any {
    if (schema.const !== undefined) return schema.const;
    if (schema.enum) return [...schema.enum].sort((a, b) => b.length - a.length)[0];
    if (schema.anyOf) return schema.anyOf.map(maximum).sort((a: any, b: any) =>
      Buffer.byteLength(JSON.stringify(b, null, 2)) - Buffer.byteLength(JSON.stringify(a, null, 2)))[0];
    if (schema.type === "object") {
      expect(schema.additionalProperties).toBe(false);
      return Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
        expect(["status", "nextAction", "nextReadyAction"]).not.toContain(key);
        return [key, maximum(value)];
      }));
    }
    if (schema.type === "array") return Array.from({length: schema.maxItems}, () => maximum(schema.items));
    if (schema.type === "boolean") return false;
    if (schema.pattern?.includes("{8}")) return "f".repeat(8) + "-ffff".repeat(3) + "-" + "f".repeat(12);
    if (schema.pattern?.includes("[^/")) return "p/" + "\\".repeat(schema.maxLength - 2);
    return "a".repeat(schema.maxLength);
  }
  const reviewMaximum = maximum(review.schema);
  // The structural ceiling includes both nullable alternatives. Null runId on
  // unbound slots to exercise a valid maximal payload as well.
  const unbound = ({barrier: _barrier, ...item}: any) => ({...item, runId: null});
  const bound = {...reviewMaximum, phase: "save", slots: reviewMaximum.slots.map((item: any, i: number) =>
    ({...unbound(item), key: i + item.key.slice(1)})), verifier: unbound(reviewMaximum.verifier)};
  review.validate(review.key, bound);
  review.validate(review.key, {...bound, slots: bound.slots.map((item: any) =>
    ({...item, runId: reviewMaximum.slots[0].runId, unbound: null, failed: true, barrier: "native-barrier"}))});
  expect(() => review.validate("review-history", bound)).toThrow("Unknown review cursor key");
  expect(() => review.validate(review.key, {...bound, history: []})).toThrow("Invalid standalone review cursor");
  expect(() => review.validate(review.key, {...bound,
    models: {...bound.models, r1: {...bound.models.r1, model: "p/" + "é".repeat(128)}}})).toThrow("Invalid standalone review cursor");
  const execute = maximalCursor(executeCursorSchema);
  validateExecuteCursor(EXECUTE_CURSOR_KEY, execute);
  const state = {[EXECUTE_CURSOR_KEY]: execute, "pitako-architecture": architectureMaximum, [review.key]: reviewMaximum};
  for (const [key, cursor] of Object.entries(state))
    expect(Buffer.byteLength(JSON.stringify({[key]: cursor}, null, 2))).toBeLessThanOrEqual(16384);
  expect(Buffer.byteLength(JSON.stringify(state, null, 2))).toBeLessThanOrEqual(49152);
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
  const unit = host.records().find((record: any) => record.kind === "unit");
  if (count === 8) {
    expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status, output.reason).toBe("done");
    expect(unit?.body.result.taskReview.reviewer.digest).toBe(canonicalDigest(original));
  } else {
    expect(output.reason).toContain("Invalid anchored task review answer");
    expect(unit).toBeUndefined();
    expect(host.calls.some(call => call.key.endsWith(".task-synthesis"))).toBe(false);
  }
});

test.each([false, true])("file-writing task is reviewed before unit admission (native sandbox: %s)", async native => {
  const host = fixture();
  host.setLimit(1);
  let consumedWorker = false;
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "gate") {
      const input = JSON.parse(request.task), worker = input.worker ?? input.refs.worker;
      expect(host.current().inFlight).toContainEqual({ ...worker, role: "worker" });
      consumedWorker = true;
    }
    if (/\.task-(reviewer|synthesis)$/.test(request.key))
      expect(host.current().inFlight.some((ref: any) => ref.role === "worker")).toBe(false);
    return normal();
  });
  const output = await (native ? host.executeNative() : host.execute());
  expect(output.status, output.reason).toBe("partial");
  expect(consumedWorker).toBe(true);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  const children = host.launches.filter(call => /\.task-(reviewer|synthesis)$/.test(call.key));
  expect(children.map(call => [call.key, call.agent, call.model])).toEqual([
    ["invoke-human-1.l1.t1.a1.task-reviewer", "pitako.reviewer", "openai-codex/gpt-6.1-sol:xhigh"],
    ["invoke-human-1.l1.t1.a1.task-synthesis", "pitako.reviewer", "anthropic/claude-opus-5-5:high"],
  ]);
  for (const name of ["execution-director", "worker", "reviewer"]) {
    const { frontmatter } = parseFrontmatter(readFileSync(path.resolve(`agents/${name}.md`), "utf8"));
    const declared = Array.isArray(frontmatter.skills) ? frontmatter.skills : String(frontmatter.skills).split(/,\s*/);
    const launched = host.launches.filter(call => call.agent === `pitako.${name}`);
    expect(launched.length).toBeGreaterThan(0);
    for (const child of launched) {
      expect(child.skill).toEqual(expect.arrayContaining(declared));
      expect(child.skill).toContain("scope-discipline");
    }
  }
  expect(children[0]!.task).toContain("Focused gate passed");
  expect(children[0]!.task).toContain('"touched":["src/change1.ts"]');
  // The fixture captures then leaves the path absent: the net delta is empty.
  expect(children[0]!.task).toContain('"netChanged":[]');
  expect(children[0]!.task).toContain("carried: false");
  for (const child of children) {
    const diff = JSON.parse(child.task.match(/^Delta reference: (.*)\.$/m)![1]!);
    expect(diff).toMatchObject({
      store: {scope: "exec:human-1.e0", seq: expect.any(Number)}, digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/), lines: 1, omitted: 0,
    });
    for (const instruction of [
      "a/ = slot baseline before attempt 1, b/ = current candidate.",
      "Read the record with pitako_store (op: record, storeId, scope, seq); page it fully and match its digest.",
      "Read body.patch using its index start lines. Missing or mismatched evidence is a blocking finding of uncertain provenance.",
      "Non-rendered statuses are declared limits: do not claim to have reviewed unavailable bytes, and do not deduct for that alone.",
      "git_diff and watchdog_diff compare with HEAD and include earlier loops' WIP.",
      "The diff covers only this loop; for carried tasks, earlier-loop work is visible only in current source.",
      "Uncertain provenance blocks; carried task defects affecting its result block regardless of origin.",
      '"touched":["src/change1.ts"]', '"netChanged":[]',
    ]) expect(child.task).toContain(instruction);
  }
  const unit = host.records().find((record: any) => record.kind === "unit");
  for (const child of children)
    expect(unit.body.frame.reviewProjections[child.key].admitted).toBe(true);
  expect(host.snapshots.every(value => !Object.hasOwn(value, "taskFrame"))).toBe(true);
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind)).toEqual(["unit"]);
});

const invalidDiffs = [
  { name: "wrong scope", patch: { store: {scope: "exec:other.e0"} } },
  { name: "no row reference", patch: { store: undefined } },
  { name: "missing row digest", patch: { digest: "" } },
  ...["", "a".repeat(63), "a".repeat(65), "g".repeat(64), 123].map(sha256 => ({
    name: `malformed digest ${sha256}`, patch: { sha256 },
  })),
  ...["bytes", "lines", "omitted"].flatMap(field =>
    [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null].map(value => ({
      name: `${field} ${JSON.stringify(value)}`, patch: { [field]: value },
    }))),
  { name: "zero lines", patch: { lines: 0 } },
];

test.each(invalidDiffs)("invalid task delta diff: $name", async ({ patch }) => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "taskDelta") {
      const delta = JSON.parse(result.output!);
      const diff = { ...delta.diff, ...patch };

      result.output = JSON.stringify({ ...delta, diff });
    }
    return result;
  });
  const output = await host.execute();
  expect(output.reason).toContain("Invalid task delta evidence.");
  expect(host.launches.filter(call => /\.task-(reviewer|synthesis)$/.test(call.key))).toHaveLength(0);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
});

test.each(["missing", "null", "empty-touched", "empty-touched-missing"])("diff contradicts touched: %s", async contradiction => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "taskDelta") {
      const delta = JSON.parse(result.output!);
      if (contradiction === "missing") delete delta.diff;
      else if (contradiction === "null") delta.diff = null;
      else {
        delta.touched = [];
        if (contradiction === "empty-touched-missing") delete delta.diff;
      }
      result.output = JSON.stringify(delta);
    }
    return result;
  });
  const output = await host.execute();
  expect(output.reason).toContain("Invalid task delta evidence.");
  expect(host.launches.filter(call => /\.task-(reviewer|synthesis)$/.test(call.key))).toHaveLength(0);
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
  const synthesis = host.launches.find(call => call.key.endsWith(".task-synthesis"))!;
  const unit = host.records().find((record: any) => record.kind === "unit");
  const projection = unit.body.frame.reviewProjections[synthesis.key];
  expect(projection.notes.path).toContain(".task-synthesis.json");
  expect(projection.blocking).toEqual([]);
});

test("actual write then revert remains review-eligible with empty netChanged", async () => {
  const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker") {
      const intent = JSON.parse(request.task.split("PRE-WRITE CHECKPOINT INTENTION (not a backup until published):\n")[1]!.split("\n")[0]!);
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

test.each([
  { defect: "introduced", cut: false }, { defect: "unfinished", cut: false },
  { defect: "score", cut: false }, { defect: "score", cut: "terminal" },
  { defect: "score", cut: "before-dispatch" },
  { defect: "score", cut: "pending-close" },
])("synthesis $defect prevents unit admission (repair relaunch: $cut)", async ({ defect, cut }) => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (cut === "pending-close" && request.agent === "pitako.worker" && request.key.endsWith(".a2"))
      result.structuredOutput.status = "continue";
    if (request.key.endsWith(".task-synthesis")) {
      result.structuredOutput.correctness = { verdict: "Concrete defect", score: defect === "score" ? 8 : 9, findings: [{
        summary: "Source-evidenced defect", evidence: "src/change1.ts:1",
        introducedByDelta: defect === "introduced", affectsTask: defect === "unfinished",
      }] };
      writeFileSync(result.results![0]!.savedOutputPath!, JSON.stringify(result.structuredOutput));
    }
    return result;
  });
  let receivedRepair = false;
  let lostClose = false;
  let launchedCursor: any;
  if (cut) {
    host.setSaveObserver(value => {
      if (cut === "pending-close" && value.action.kind === "pending" &&
          value.action.opKey.endsWith(".a2.close") && !value.halt && value.inFlight.length)
        launchedCursor = copy(value);
      if (value.action.kind === "launched" && value.action.role === "worker" &&
          value.action.runId === null && value.loop.attempt?.number === 2 &&
          value.loop.attempt.stage === "launched" && !value.halt)
        launchedCursor = copy(value);
    });
    host.setLaunchRespond(async (request, normal) => {
      if (cut === "before-dispatch" && request.agent === "pitako.worker" && request.key.endsWith(".a2"))
        throw new Error("Controlled loss before repair dispatch");
      if (cut === "pending-close" && request.key.endsWith(".a2.close")) {
        lostClose = true;
        throw new Error("Controlled loss before repair close dispatch");
      }
      const result = await normal();
      if (request.agent === "pitako.worker" && request.key.endsWith(".a2")) receivedRepair = true;
      return result;
    });
    host.setFailSave(() => cut === "terminal" && receivedRepair || lostClose);
  }
  let output = await host.execute();
  if (cut) {
    if (cut === "before-dispatch" || cut === "pending-close") {
      expect(launchedCursor.action.op).toBe(cut === "before-dispatch" ? "baseline" : "close");
      host.storage.set(EXECUTE_CURSOR_KEY, launchedCursor);
    } else expect(output.reason).toContain("Essential persistence failed");
    const cursor = host.current();
    expect(cursor.action).toMatchObject(cut === "pending-close" ? { kind: "pending", op: "close" } : { kind: "launched", role: "worker" });
    expect(cursor.loop.attempt).toMatchObject({ number: 2, revival: "task-review-repair" });
    host.setFailSave();
    host.setSaveObserver(() => {});
    host.setLaunchRespond();
    output = await host.execute();
    expect(output.status, output.reason).toBe("partial");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(2);
    expect(host.calls.filter(call => cut === "terminal" ? /\.recover\.r\d+$/.test(call.key) :
      cut === "pending-close" ? /\.pending-close-replay\.r\d+$/.test(call.key) :
      /\.baseline-replay\.r\d+$/.test(call.key))).toHaveLength(1);
    if (cut === "pending-close") {
      const requests = host.launches.filter(call => call.key.endsWith(".a2.close"));
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
    }
    if (cut === "before-dispatch") {
      const requests = host.launches.filter(call => call.agent === "pitako.worker" && call.key.endsWith(".a2"));
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
    }
  }
  expect(output.status, output.reason).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind)).toEqual(["pause", "pause"]);
  expect(host.records().filter((record: any) => record.kind === "unit")
    .every((record: any) => record.body.checkpoint.kind === "pause")).toBe(true);
});
