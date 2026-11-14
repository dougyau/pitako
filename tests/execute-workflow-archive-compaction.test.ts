import { expect, test } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { copy, executeControllerFixture, source, type ControllerHost } from "./fixtures/execute-workflow.ts";
import { retainedAnalyses, boundRetainedAnalyses } from "../extensions/execute-retained.ts";
import { executionStatePath, expandWorkerReferences, compactWorkerReferences } from "../extensions/execute-state.ts";
import { checkpointEvidence, previousUnitMatches } from "../extensions/execute-checkpoint.ts";

const { fixture } = executeControllerFixture();
const observedSource = source.replace("if (archived) compactArchivedLoop();", `if (archived) {
  emit({ archiveBefore: clone(invocation) });
  compactArchivedLoop();
  emit({ archiveAfter: clone(invocation) });
}`);
const libraryStart = source.indexOf("\ntry {\n  if (config.timeouts");
if (libraryStart < 0) throw new Error("Execute workflow entry point not found.");
const library = source.slice(0, libraryStart);
const inspectSource = readFileSync(new URL("../skills/execute/inspect.ts", import.meta.url), "utf8");
// Exercise the actual private inspector reader without running unrelated Git/settings discovery.
const observerJS = new Bun.Transpiler({ loader: "ts" }).transformSync(
  inspectSource.slice(inspectSource.indexOf("function observeCheckpoint(")));
const observeCheckpoint = new Function("readFileSync", "executionStatePath", "EXECUTE_STATE_VERSION",
  "incompatibleExecuteState", "isDeepStrictEqual", "checkpointEvidence", "previousUnitMatches", "expandWorkerReferences",
  `${observerJS}; return observeCheckpoint;`);
const { isDeepStrictEqual } = await import("node:util");
const { EXECUTE_STATE_VERSION, incompatibleExecuteState } = await import("../extensions/execute-state.ts");

function archivePair(host: ControllerHost) {
  const before = host.emits.find(value => value.archiveBefore)?.archiveBefore;
  const after = host.emits.find(value => value.archiveAfter)?.archiveAfter;
  expect(before).toBeDefined();
  expect(after).toBeDefined();
  return { before, after };
}

function archiveFixture(status: "complete" | "gaps" = "complete") {
  const host = fixture(undefined, { taskCount: 1, realCheckout: true });
  host.setLimit(2);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker" || /\.t\d+\.a\d+$/.test(request.key)) {
      if (request.key.includes(".l2.")) Object.assign(result.structuredOutput,
        { status: "blocked", remaining: ["Work remains"] });
      else Object.assign(result.structuredOutput, {
        status, remaining: status === "gaps" ? ["Scoped work remains"] : [],
        knowledge: { findings: ["Complete native evidence"], handoff: "Full retained handoff" },
      });
    }
    return result;
  });
  return host;
}

async function readers(host: ControllerHost, archivedState: any) {
  return host.execute({ archivedState }, library + `
    invocation = clone(config.archivedState); loop = invocation.loop;
    const report = loopReport("gaps", "Pending work");
    const todo = clone(lastTodoSnapshot);
    const budget = await finishBudgetExhaustion();
    return { report, todo, budget, marker: invocation.lastBudgetProgress,
      unsettledLaunch: !!(loop.attempt?.launch && !loop.attempt.result) };
  `);
}

function inspectReaders(host: ControllerHost, value: any) {
  const originalContext = value.association;
  const checkpointReader = observeCheckpoint((file: string, encoding: any) =>
    file === executionStatePath(originalContext) ? JSON.stringify({ "invoke-human-1": compactWorkerReferences(value) })
      : readFileSync(file, encoding), executionStatePath, EXECUTE_STATE_VERSION,
    incompatibleExecuteState, isDeepStrictEqual, checkpointEvidence, previousUnitMatches, expandWorkerReferences);
  const statePath = path.join(host.root, "inspection-mission", "state.json");
  const context = { missionPath: path.join(host.root, "mission.json"), missionId: "inspection-mission",
    invocation: "human-1", sourceRefs: value.association.sourceRefs };
  const invocation = copy(value);
  Object.assign(invocation.association, context);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ "invoke-human-1": compactWorkerReferences(invocation) }));
  const found = { root: host.root, commonDir: invocation.association.commonDir,
    selected: { source: invocation.association.source, digest: invocation.association.digest } };
  return {
    checkpoint: checkpointReader(found, originalContext),
    retained: retainedAnalyses(host.root, found.selected.source, found.selected.digest, context),
    bound: boundRetainedAnalyses(host.root, found.commonDir, found.selected.source, found.selected.digest,
      invocation.admissionBinding, context),
  };
}

test.each(["complete", "gaps"] as const)(
  "admitted %s archive preserves reports, todo, budget and both inspection readers", async status => {
    const host = archiveFixture(status);
    await host.execute({}, observedSource);
    const { before, after } = archivePair(host);
    expect(await readers(host, after)).toEqual(await readers(host, before));
    expect(inspectReaders(host, after)).toEqual(inspectReaders(host, before));
    if (status === "complete") {
      expect(after.loop.attempt).not.toHaveProperty("checkpoint");
      expect(after.loop.attempt?.result).toEqual(before.loop.attempt?.result
        ? { status: before.loop.attempt.result.status } : undefined);
      expect(after.tasks.change1.completed).toEqual({ taskId: "change1", attempt: 1 });
      expect(inspectReaders(host, after).checkpoint).toBeUndefined();
    } else {
      expect(after.loop.attempt.checkpoint).toEqual(before.loop.attempt.checkpoint);
      expect(inspectReaders(host, after).checkpoint).toBeDefined();
      expect(inspectReaders(host, after).checkpoint.error).toBeUndefined();
    }
    expect(Buffer.byteLength(JSON.stringify(after))).toBeLessThan(Buffer.byteLength(JSON.stringify(before)));
  });

test.each(["settled-failure", "blocked", "continue", "complete-result", "no-checkpoint-source", "other-phase"] as const)(
  "inspection and compaction preserve the %s checkpoint predicate", async mode => {
    const host = archiveFixture("gaps");
    await host.execute({}, observedSource);
    const { before } = archivePair(host);
    if (mode === "settled-failure") {
      // The native !result.ok branch retains a settled producer, not an admitted result.
      before.loop.attempt.stage = "settled";
      delete before.loop.attempt.result;
      before.loop.attempt.restore = { checkpoint: copy(before.loop.attempt.checkpoint), sourceKeys: [],
        authority: { confirmedUnit: null, confirmedPause: copy(before.lastConfirmed), unrelated: "discard" },
        producer: { key: "not-read-by-inspection" } };
    } else if (mode === "no-checkpoint-source") {
      delete before.loop.attempt.checkpoint;
      delete before.loop.attempt.restore;
    } else if (mode === "other-phase") before.loop.phase = "review";
    else before.loop.attempt.result.status = mode === "complete-result" ? "complete" : mode;
    const after = await host.execute({ archivedState: before }, library + `
      invocation = clone(config.archivedState); loop = invocation.loop;
      compactArchivedLoop(); return clone(invocation);
    `);
    expect(inspectReaders(host, after)).toEqual(inspectReaders(host, before));
    expect(await readers(host, after)).toEqual(await readers(host, before));
    const observing = ["settled-failure", "blocked", "continue"].includes(mode);
    if (observing) {
      expect(after.loop.attempt.checkpoint).toEqual(before.loop.attempt.checkpoint);
      expect(after.loop.attempt.result).toEqual(before.loop.attempt.result
        ? { status: before.loop.attempt.result.status, checkpoint: before.loop.attempt.result.checkpoint } : undefined);
      expect(inspectReaders(host, after).checkpoint).toBeDefined();
      expect(inspectReaders(host, after).checkpoint.error).toBeUndefined();
    } else {
      expect(after.loop.attempt).not.toHaveProperty("checkpoint");
      expect(after.loop.attempt).not.toHaveProperty("restore");
      expect(after.loop.attempt.result).toEqual({ status: before.loop.attempt.result.status });
      expect(after.loop.results.every((result: any) => !result.checkpoint)).toBe(true);
      expect(inspectReaders(host, after).checkpoint).toBeUndefined();
    }
    if (mode === "settled-failure") {
      expect(after.loop.attempt.restore).toEqual({ checkpoint: before.loop.attempt.checkpoint,
        sourceKeys: [], authority: { confirmedUnit: null } });
    }
  });

test("ledger publication keeps full closed bodies and final-close archives stay whole", async () => {
  const host = archiveFixture();
  let publication: any;
  host.setLaunchRespond(async (request, normal) => {
    if (request.key === "invoke-human-1.l1.nextAdvance") {
      const input = JSON.parse(request.task);
      publication = copy(input.intentions.find((item: any) => item.operation === "ledger" && item.input.record.kind === "loop").input.record.body);
      expect(host.current().loop.archived).not.toBe(true);
      expect(host.current().tasks.change1.completed.checkpoint).toBeDefined();
    }
    return await normal();
  });
  const output = await host.execute({}, observedSource);
  const record = host.records().find((entry: any) => entry.kind === "loop" && entry.loop === 1);
  expect(record.body).toEqual(publication);
  expect(record.body.results[0].checkpoint).toBeDefined();
  expect(record.body.plan.association).toBeDefined();
  expect(record.body.results[0].knowledge).toBeDefined();
  const current = host.current().loop;
  expect(current.archived, output.reason).toBe(true);
  expect(current.kind).toBe("final");
  expect(current.finalAttempt.gate.receipt.view).toBeDefined();
  expect(current.plan.association).toBeDefined();
  expect(host.emits.filter(value => value.archiveAfter)).toHaveLength(1);
});

test.each(["invalid-admission", "save-cut"] as const)("archive %s restores the uncompacted admission state", async mode => {
  const host = archiveFixture("gaps");
  let original: any;
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.key === "invoke-human-1.l1.nextAdvance") {
      original = copy(host.current());
      if (mode === "invalid-admission") {
        const receipt = JSON.parse(result.output!);
        // Settlement precedes the ledger; reject its actual result after admission has begun.
        receipt.projection.steps[0].result.projection.steps.at(-1).result.summaries = [];
        result.output = JSON.stringify(receipt);
      }
    }
    return result;
  });
  if (mode === "save-cut") host.setFailSave(value => value.loop?.nextAdvance?.admitted && value.loop.archived);
  const failureSource = observedSource.replace('function finish(status, reason, drained = false) {',
    'function finish(status, reason, drained = false) { emit({ finishState: clone(invocation) });');
  const first = await host.execute({}, failureSource);
  expect(first.reason).toContain(mode === "save-cut" ? "Essential persistence failed" : "Invalid drained loop summaries");
  expect(host.current().loop.archived).not.toBe(true);
  expect(host.current().loop.attempt.checkpoint).toEqual(original.loop.attempt.checkpoint);
  expect(host.current().tasks).toEqual(original.tasks);
  const inMemory = host.emits.filter(value => value.finishState).at(-1).finishState;
  expect(inMemory.loop.archived).not.toBe(true);
  expect(inMemory.loop.attempt.checkpoint).toEqual(original.loop.attempt.checkpoint);
  expect(inMemory.tasks).toEqual(original.tasks);
  expect(inMemory.ledger).toEqual(host.current().ledger);
  if (mode === "save-cut") {
    host.setFailSave();
    await host.execute({}, observedSource);
    expect(host.current().loop.number).toBe(2);
    expect(host.records().filter((entry: any) => entry.kind === "loop" && entry.loop === 1)).toHaveLength(1);
  }
});
