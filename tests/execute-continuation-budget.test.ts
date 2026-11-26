import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { EXECUTE_STATE_VERSION, executeContinuationScript, executionStatePath } from "../extensions/execute-state.ts";
import { readExecuteIntentContext } from "../extensions/execute-intent.ts";
import { PitakoStore, StoreError } from "../extensions/pitako-store.ts";
import { executionResource } from "../extensions/plan-execute.ts";
import { SPEC_SECTIONS } from "../extensions/spec-plans.ts";
import { executeProjection, executeStore, isLedgerIntegrityError, storedGateEvidence, withExecuteStore } from "../skills/execute/ledger.mjs";
import type { GateResult } from "../skills/execute/loop.ts";
import { closeContinuation, recordBaselineInput, resolveStoredGroupedInput, runOperation, transportOutput } from "../skills/execute/loop-io.mjs";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/jiti-loader.js";
import { runWorkflowScript } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { executeControllerFixture, executeField, executeRecord } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const a1 = "invoke-human-1.l1.t1.a1";
const a2 = "invoke-human-1.l1.t1.a2";
const a3 = "invoke-human-1.l1.t1.a3";
const acceptanceGate = "invoke-human-1.l2.acceptance.gate";
const incompatible = "execute-continuation-incompatible";
const workflow = readFileSync(new URL("../skills/execute/workflow.js", import.meta.url), "utf8");
const canonical = readFileSync(new URL("../skills/workflow-canonical.js", import.meta.url), "utf8");
function continuationCodec(script: string) {
  return new Function(`${canonical}
${script}
const config = { stateVersion: ${EXECUTE_STATE_VERSION} };
const clone = value => JSON.parse(JSON.stringify(value));
const text = value => typeof value === "string" && value.trim().length > 0;
${workflow.slice(workflow.indexOf("function same("), workflow.indexOf("// Pure policy:"))}
return { encodeContinuation, decodeLoopIOOutput, StoreError };`)();
}
const { encodeContinuation, decodeLoopIOOutput } = continuationCodec(executeContinuationScript());

const closeRequests = Array.from({ length: 20 }, (_, i) => ({
  v: 1, invocation: "human-1", requestId: "\\".repeat(240) + i,
  taskId: `unselected-${i}`, kind: "cancel", origin: "main", at: 1,
}));

const humanPosts = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1, type: "HUMAN", content: (`Accepted ruling ${i}. `).padEnd(850, "h") + `view-${i}-sentinel`,
}));

function repairFixture(pagedClose = false, failingTails?: number) {
  // An incident-size view, eight gates and two worker originals occupy separate wire fields.
  const host = fixture(undefined, {
    humanPosts,
    gateTail: failingTails === undefined ? undefined : (key, id) => {
      if (key === acceptanceGate && id === "excepted") return finalTail;
      if (key !== `${a2}.gate` && key !== `${a3}.gate`) return;
      const index = Number(id.slice("gate-".length));
      if (index < failingTails) return escapeHeavyTail(key, id);
      if (index === 7 && !failingTails) return reviewTail;
      return "Gate diagnostic";
    },
  });
  host.setLimit(failingTails === 0 ? 2 : 1);
  host.setTaskGatePass((key, gate) => {
    const index = Number(gate.slice("gate-".length));
    if (key === `${a2}.gate`) return index >= Math.max(1, failingTails ?? 0);
    if (key === `${a3}.gate`) return index >= (failingTails ?? 0);
    return !(failingTails !== undefined && key === `${a1}.gate` && index === 7);
  });
  host.setRespond((request, normal) => {
    const result = normal();
    if (pagedClose && request.agent === "pitako.request-observer") {
      const { cursor } = JSON.parse(request.task);
      if (request.key.startsWith(`${a2}.close.`) || cursor > 0) {
        const page = JSON.parse(result.output!);
        result.output = JSON.stringify({ ...page, requests: closeRequests.slice(cursor) });
      }
    }
    if (failingTails === 0 && request.key === acceptanceGate) {
      const receipt = JSON.parse(result.output!);
      Object.assign(receipt.gates[1], { status: "fail", exit: 1 });
      result.output = JSON.stringify(receipt);
    }
    if (request.agent === "pitako.execution-director") {
      const task = result.structuredOutput.changes[0]?.task;
      if (task) task.gates = Array.from({ length: 8 }, (_, i) => ({ ...task.gates[0], id: `gate-${i}` }));
      if (failingTails === 0 && result.structuredOutput.acceptance) {
        const acceptance = result.structuredOutput.acceptance;
        acceptance.push({ ...acceptance[0], id: "excepted", exception: { humanRef: 1, reason: "Accepted ruling 0" } });
      }
    }
    // Preserve the two incident-sized originals; a3 is a new synthetic worker.
    if (request.agent === "pitako.worker" && request.key !== a3) {
      const number = Number(request.key.at(-1));
      result.structuredOutput.work = `a${number}-work-sentinel`;
      result.structuredOutput.knowledge = {
        findings: Array.from({ length: 8 }, (_, i) =>
          `a${number}-finding-${i}-sentinel`.padEnd(number === 1 ? 1450 : 1030, String(i))),
        handoff: `a${number}-handoff`.padEnd(1900, "k"),
      };
    }
    if (failingTails === undefined && request.key.endsWith(".a1.task-synthesis")) {
      Object.assign(result.structuredOutput, {
        correctness: { verdict: "Required change not implemented", score: 8, findings: [{
          summary: "Required error path remains open", evidence: "src/change1.ts:1",
          introducedByDelta: false, affectsTask: true,
        }] },
        diagnosis: "Repair the error path confirmed by the synthesis",
      });
    }
    return result;
  });
  return host;
}

const escapeHeavyTail = (key: string, id: string) => `${key}/${id}: `.padEnd(2048, "\\\"\n");
// Longer than the fold prefix, but small enough for the six-post gate to stay unpacked.
const reviewTail = "Focused gate diagnostics: ".padEnd(144, "r") + "review-tail-end";
const finalTail = escapeHeavyTail(acceptanceGate, "excepted");

test.each([0, 2, 3, 4, 8])("a3 gate transports a captured a2 pause with %i escape-heavy failing tails", async k => {
  const host = repairFixture(false, k);
  const outputs = new Map<string, string>();
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (!result.ok || pitakoAgentFamily(request.agent) !== "loop-io") return result;
    const { operation } = JSON.parse(request.task);
    if (["gate", "baseline", "close"].includes(operation)) {
      // The controller fixture already serializes grouped close with transportOutput.
      const output = operation === "close" ? result.output! : transportOutput(operation, JSON.parse(result.output!));
      outputs.set(request.key, output);
      if (k > 0 && request.key === `${a3}.gate`) host.setFailSave(() => true);
      return { ...result, output };
    }
    return result;
  });
  host.setSaveObserver(value => {
    if (value.loop?.attempt?.number === 3 && value.action?.role === "worker" && value.action?.runId === null) {
      host.setSaveObserver(undefined);
      throw new Error("Controlled cut before dispatching a3");
    }
  });
  const cut = await host.execute();
  expect(cut.reason).toContain("Essential persistence failed");
  expect(host.launches.some(call => call.key === a3)).toBe(false);
  const a2Close = JSON.parse(outputs.get(`${a2}.close`)!);
  const closed = decodeLoopIOOutput(a2Close).P.prompt.execution.foldedContinuation;
  expect(closed.seal).toMatchObject({ kind: "pause", outcome: "sealed" });
  expect(closed.checkpoint.key).toBe(a3);
  const { store, scope } = executeStore(host.root, host.current().invocation);
  const marker = (key: string) => executeField(store.readRecords(scope).records.find(row =>
    row.kind === "marker" && row.opKey === `worker-gate:${key}.gate`)!.body, "result", "gates") as GateResult[];
  const a2Gates = marker(a2);
  const longFailures = (gates: GateResult[]) => gates.filter(g => g.status === "fail" && Buffer.byteLength(g.tail) === 2048);
  expect(longFailures(a2Gates).map(g => g.tail)).toEqual(Array.from({ length: k }, (_, i) => escapeHeavyTail(`${a2}.gate`, `gate-${i}`)));
  // The fold reads the close's gate marker, not the standalone gate result.
  const { records } = store.readRecords(scope, a2Close.head);
  const closeRow = records.find(row => row.kind === "receipt" && executeField(row.body, "key") === `${a2}.close`)!;
  const gateRef = executeField(closeRow.body, "continuation", "gate") as { seq: number; digest: string };
  const closeGate = records.find(row => row.kind === "marker" && row.seq === gateRef.seq && row.digest === gateRef.digest)!;
  expect(executeField(closeGate.body, "result", "receipt", "gates")).toEqual(a2Gates);
  const truncated = a2Gates.map(g => ({ ...g, tail: g.tail.slice(0, 128) }));
  expect(closed.gate.receipt.gates).toEqual(truncated);
  const outcome = await host.execute();
  if (k === 0) expect(outcome.status, outcome.reason).toBe("complete");
  else expect(outcome.reason).toContain("Essential persistence failed");
  const a3Task = host.launches.find(call => call.key === a3)!.task;
  const continuation = JSON.parse(a3Task.split("TASK CONTINUATION (data):\n")[1]!.split("\n")[0]!);
  expect(continuation.gateFailures).toBe(a2Gates.filter(g => g.status === "fail")
    .map(g => `${g.id}: fail; ${g.logRef}; ${g.tail.slice(0, 128)}`).join("\n"));
  const a3Gate = outputs.get(`${a3}.gate`)!;
  expect(a3Gate, outcome.reason).toBeDefined();
  expect(Buffer.byteLength(a3Gate)).toBeLessThanOrEqual(61_440);
  for (const attempt of [1, 2])
    for (let i = 0; i < 8; i++) {
      const sentinel = `a${attempt}-finding-${i}-sentinel`;
      expect(a3Gate.split(sentinel), sentinel).toHaveLength(2);
    }
  for (let i = 0; i < humanPosts.length; i++) {
    const sentinel = `view-${i}-sentinel`;
    expect(a3Gate.split(sentinel), sentinel).toHaveLength(2);
  }
  const wire = JSON.parse(a3Gate);
  expect(wire.view.posts).toEqual(humanPosts);
  const foldedReceipt = wire.P.prompt.execution.foldedContinuation.gate.receipt;
  expect(foldedReceipt.gates).toEqual(truncated);
  expect(longFailures(marker(a3)).map(g => g.tail)).toEqual(Array.from({ length: k }, (_, i) => escapeHeavyTail(`${a3}.gate`, `gate-${i}`)));
  expect(marker(a2)).toEqual(a2Gates);
  if (k === 8) {
    foldedReceipt.gates = a2Gates;
    expect(() => transportOutput("gate", wire)).toThrow("loop-io admission projection exceeds 61440 bytes");
  }
  if (k === 0) {
    expect(wire.gates[7].tail).toBe(reviewTail);
    expect(marker(a3)[7]!.tail).toBe(reviewTail);
    for (const phase of ["reviewer", "synthesis"])
      expect(host.launches.find(call => call.key === `${a3}.task-${phase}`)!.task).toContain(`"tail":${JSON.stringify(reviewTail)}`);
    expect(outcome.heading).toBe("Execution complete with exceptions");
    expect(JSON.parse(outputs.get(acceptanceGate)!).gates[1]).toMatchObject({ id: "excepted", status: "fail", tail: finalTail });
    for (const phase of ["review.director-prepare", "compliance"])
      expect(host.launches.find(call => call.key === `invoke-human-1.l2.${phase}`)!.task).toContain(`"tail":${JSON.stringify(finalTail)}`);
    const latest = store.readRecords(scope).records;
    const superseded = latest.map(row => row.seq === closeRow.seq ? { ...row, body: {
      ...executeRecord(row.body), continuation: noVersion(executeRecord(executeField(row.body, "continuation"))),
    } } : row);
    expect(executeProjection(superseded)).toEqual(executeProjection(latest));
  }
});

test.each(["intact", "relaunch", "paged-close", "baseline-pointer", "baseline-pointer-without-same", "gate-target"] as const)("a2 review-repair transports the pending pause through baseline, gate and close (%s)", async seam => {
  const host = repairFixture(seam === "paged-close");
  const tamperedBaseline = seam === "baseline-pointer" || seam === "baseline-pointer-without-same";
  const outputs = new Map<string, string>();
  let cut = false;
  host.setLaunchRespond(async (request, normal) => {
    const executions = host.gateExecutions();
    const result = await normal();
    if ([`${a2}.gate`, `${a2}.baseline`, `${a2}.close`, `${a2}.gate.r1`].includes(request.key) && result.ok) {
      const operation = JSON.parse(request.task).operation;
      const receipt = JSON.parse(result.output!);
      const packet = receipt.P.prompt.execution.continuation;
      if (operation === "baseline" && seam === "baseline-pointer")
        packet.intentions[0].input.record.body.result.same = ["lastConfirmed"];
      if (operation === "baseline" && seam === "baseline-pointer-without-same")
        delete packet.intentions[0].input.record.body.result.same;
      if (operation === "gate" && seam === "gate-target")
        packet.taskState.last.workDone = "Changed target";
      // Grouped close already uses transportOutput in the controller fixture.
      const wire = operation === "close" ? result.output! : transportOutput(operation, receipt);
      outputs.set(request.key, wire);
      if (seam === "relaunch" && request.key === `${a2}.gate`) cut = true;
      if (request.key.endsWith(".r1") || operation === "close") expect(host.gateExecutions()).toBe(executions);
      return { ...result, output: wire };
    }
    return result;
  });
  host.setFailSave(() => cut);
  let outcome = await host.execute();
  if (tamperedBaseline || seam === "gate-target") {
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("Execute continuation pointer integrity mismatch");
    expect([...outputs.keys()]).toEqual(tamperedBaseline ? [`${a2}.baseline`] : [`${a2}.baseline`, `${a2}.gate`]);
    const wire = outputs.get(`${a2}.${tamperedBaseline ? "baseline" : "gate"}`)!;
    expect(() => decodeLoopIOOutput(JSON.parse(wire))).toThrow(expect.objectContaining({ code: "execute-continuation-integrity" }));
    expect(host.launches.filter(call => call.key === a2)).toHaveLength(tamperedBaseline ? 0 : 1);
    expect(host.launches.some(call => call.key.startsWith(`${a2}.task-`) || call.key === `${a2}.seal`)).toBe(false);
    return;
  }
  if (seam === "relaunch") {
    expect(outcome.reason).toContain("Essential persistence failed");
    expect(host.current().action).toMatchObject({ kind: "pending", op: "gate", opKey: `${a2}.gate` });
    cut = false;
    outcome = await host.execute();
    const uninterrupted = repairFixture();
    expect((await uninterrupted.execute()).status).toBe(outcome.status);
    const units = (h: typeof host) => JSON.parse(JSON.stringify(h.records()
      .filter((row: any) => row.kind === "unit").map((row: any) => row.body)).replaceAll(h.root, "<root>"));
    expect(units(host)).toEqual(units(uninterrupted));
    const launches = host.launches.map(call => call.key);
    expect(launches.filter(key => key.endsWith(".r1"))).toEqual([`${a2}.gate.r1`]);
    expect(launches.filter(key => key !== `${a2}.gate.r1`)).toEqual(uninterrupted.launches.map(call => call.key));
    expect(host.gateExecutions()).toBe(uninterrupted.gateExecutions());

    const invocation = host.current().invocation;
    const { store, scope } = executeStore(host.root, invocation);
    const { records, identity, head } = store.readRecords(scope);
    const key = `${a2}.close`;
    const input = records.find(row => row.opKey === `operation:${key}`)!;
    const close = JSON.parse(outputs.get(key)!);
    const request = {
      root: host.root, invocation, key, storeId: identity.storeId, scope, expectedHead: close.head,
      refs: { input: { seq: input.seq, digest: input.digest }, committed: true },
    };
    expect(() => resolveStoredGroupedInput("close", { ...request, refs: {
      ...request.refs, input: { seq: input.seq, digest: "f".repeat(64) },
    } })).toThrow();
    const { replay } = resolveStoredGroupedInput("close", request);
    outputs.set(`${key}.r1`, transportOutput("close", replay as Record<string, unknown>));
    expect(store.readRecords(scope).head).toEqual(head);
  }
  expect(outcome.status, `${outcome.reason ?? ""}; transports: ${[...outputs.keys()].join(", ")}`).toBe("partial");
  expect([...outputs.keys()]).toEqual([`${a2}.baseline`, `${a2}.gate`,
    ...(seam === "relaunch" ? [`${a2}.gate.r1`] : []), `${a2}.close`,
    ...(seam === "relaunch" ? [`${a2}.close.r1`] : [])]);

  for (const [key, wire] of outputs) {
    const operation = key.split(".")[4];
    expect(Buffer.byteLength(wire)).toBeLessThan(operation === "baseline" ? 61_440 - 7_669 : 61_440);
    const receipt = JSON.parse(wire);
    const execution = receipt.P.prompt.execution;
    if (operation === "close") {
      const folded = execution.foldedContinuation;
      const step = (operation: string) => receipt.projection.steps.find((step: any) => step.operation === operation).result;
      expect(folded).not.toHaveProperty("view");
      expect(folded.gate.receipt).not.toHaveProperty("view");
      expect(folded.worker.value.knowledge.findings[0]).toContain("a2-finding-0-sentinel");
      expect(wire.split("a1-finding-0-sentinel")).toHaveLength(2);
      expect(wire.split("a2-finding-0-sentinel")).toHaveLength(2);
      expect(wire.split("view-0-sentinel")).toHaveLength(2);
      const restoredExecution = decodeLoopIOOutput(receipt).P.prompt.execution;
      if (seam === "paged-close") {
        const page = step("nextRequests");
        expect(page.next).toBeGreaterThan(0);
        expect(page.next).toBeLessThan(closeRequests.length);
        expect(page.requests).toEqual(closeRequests.slice(0, page.next));
        expect(page.observed).toEqual({ count: closeRequests.length, next: null, requested: false, taskId: "change1" });
        const { store, scope } = executeStore(host.root, host.current().invocation);
        const retained = store.read(scope, receipt.head).P.prompt.execution!.foldedContinuation;
        expect(retained).toMatchObject({ requests: { next: null, requests: closeRequests } });
      }
      for (const [field, fact, path] of [
        ["checkpoint", restoredExecution.checkpoint, ["execution", "checkpoint"]],
        ["requests", step("nextRequests"), ["projection", "steps", "nextRequests", "result"]],
        ["seal", step("seal").receipt, ["projection", "steps", "seal", "result", "receipt"]],
      ] as const) {
        expect(folded[field]).toEqual({ same: path, digest: canonicalDigest(fact) });
        expect(wire.split(JSON.stringify(fact))).toHaveLength(2);
        const restored = restoredExecution.foldedContinuation[field];
        expect(restored).toEqual(fact);
        expect(restored).not.toBe(fact);
      }
      expect(JSON.stringify(receipt)).toBe(wire);
      if (key.endsWith(".r1")) {
        expect(receipt).toEqual(JSON.parse(outputs.get(`${a2}.close`)!));
        const changed = JSON.parse(wire);
        changed.projection.steps.find((step: any) => step.operation === "nextRequests").result.next = 1;
        expect(() => decodeLoopIOOutput(changed)).toThrow("Execute continuation pointer integrity mismatch");
      }
      continue;
    }
    const packet = receipt.P.prompt.execution.continuation;
    const pending = packet.intentions[0].input.record.body;
    const source = packet.taskFrame.intents[packet.attempt.pauseSource.checkpoint.same[2]];
    expect(source.key).toBe(a2.replace(/2$/, "1"));
    expect(packet.attempt).not.toHaveProperty("checkpoint");
    const facts = [
      [pending.frame.intents, packet.taskFrame.intents],
      [pending.result, packet.taskState.last],
      [pending.checkpoint, packet.lastConfirmed],
      [packet.attempt.pauseSource.checkpoint, source],
    ];
    for (const [pointer, fact] of facts) {
      expect(pointer).toEqual({ same: expect.any(Array), digest: canonicalDigest(fact) });
      expect(wire.split(JSON.stringify(fact))).toHaveLength(2);
    }
    expect(wire.split("a1-finding-0-sentinel")).toHaveLength(2);
    if (operation === "gate") expect(wire.split("a2-finding-0-sentinel")).toHaveLength(2);
    const expanded = decodeLoopIOOutput(receipt).P.prompt.execution.continuation;
    expect(JSON.stringify(receipt)).toBe(wire);
    const restored = expanded.intentions[0].input.record.body;
    expect(restored.frame.intents).toEqual(expanded.taskFrame.intents);
    expect(restored.result).toEqual(expanded.taskState.last);
    expect(restored.result).not.toBe(expanded.taskState.last);
    expect(restored.checkpoint).toEqual(expanded.lastConfirmed);
    expect(restored.checkpoint).not.toBe(expanded.lastConfirmed);
    expect(expanded.attempt.pauseSource.checkpoint).toEqual(source);
    restored.frame.intents[source.key].progress.consumedLoops++;
    expect(expanded.taskFrame.intents[source.key]).toEqual(source);
    expect(expanded.attempt.pauseSource.checkpoint).toEqual(source);
  }
  const legacy = decodeLoopIOOutput(JSON.parse(outputs.get(`${a2}.gate`)!));
  const { continuation, checkpoint } = legacy.P.prompt.execution;
  continuation.attempt.checkpoint = checkpoint;
  expect(() => transportOutput("gate", legacy)).toThrow("loop-io admission projection exceeds 61440 bytes");

  // The pending unit must retain its frozen bytes if the corresponding live targets have changed.
  continuation.taskFrame.intents = {};
  continuation.taskState.last.workDone = "A different result";
  continuation.lastConfirmed = null;
  expect(encodeContinuation(structuredClone(continuation))).toEqual(continuation);
});

test("continuation copies reject pointer/target drift and require the same worker original", () => {
  const key = a2;
  const original = { reference: { key, runId: "same-run" }, value: {
    knowledge: { handoff: "worker-knowledge-sentinel", findings: ["Nested fact"] },
  } };
  const packet = {
    attempt: { key, launch: original.reference },
    taskFrame: { workerKnowledge: { [key]: structuredClone(original.value.knowledge) } },
  };
  for (const worker of [
    { ...original, reference: { key, runId: "different-run" } },
    { ...original, value: { knowledge: { ...original.value.knowledge, handoff: "Different content" } } },
  ]) expect(encodeContinuation(structuredClone(packet), worker)).toEqual({ ...packet, version: EXECUTE_STATE_VERSION });

  const receipt = { P: { prompt: { execution: {
    foldedContinuation: { ...encodeContinuation(structuredClone(packet), original), worker: original },
  } } } };
  const wire = JSON.stringify(receipt);
  expect(wire.split("worker-knowledge-sentinel")).toHaveLength(2);
  const restored = decodeLoopIOOutput(JSON.parse(wire)).P.prompt.execution.foldedContinuation;
  const restoredKnowledge = restored.taskFrame.workerKnowledge[key];
  expect(restoredKnowledge).toEqual(original.value.knowledge);
  restoredKnowledge.findings.push("Local edit");
  expect(restored.worker.value.knowledge).toEqual(original.value.knowledge);

  for (const tamper of [
    (folded: any) => { folded.taskFrame.workerKnowledge[key].same = ["taskState", "last"]; },
    (folded: any) => { folded.taskFrame.workerKnowledge[key].digest = "f".repeat(64); },
    (folded: any) => { folded.worker.value.knowledge.findings[0] = "Changed target"; },
    (folded: any) => { folded.worker.reference.runId = "different-run"; },
  ]) {
    const changed = JSON.parse(wire);
    tamper(changed.P.prompt.execution.foldedContinuation);
    expect(() => decodeLoopIOOutput(changed)).toThrow("Execute continuation pointer integrity mismatch");
  }
});

test("retained v10 is blocked by the registered execute resource before any host or child call", async () => {
  const spec = "---\npitako-spec: 1\nid: spec\nstatus: complete\n---\n" +
    SPEC_SECTIONS.map(section => `## ${section}\nRetain the exact admitted subject.\n`).join("\n");
  const host = fixture(spec);
  expect((await host.execute()).status).toBe("complete");
  const cursor = host.current();
  expect(cursor.version).toBe(11);
  await host.state.set("pitako-execute", { ...cursor, version: 10 });
  const { association } = host.admitted() as { association: { root: string; invocation: string; missionId: string; missionPath: string } };
  const { root, invocation, missionId, missionPath } = association;
  const statePath = executionStatePath(association);
  const retained = readFileSync(statePath, "utf8");
  const { store, scope } = executeStore(root, invocation);
  const before = store.readRecords(scope);
  const snapshots = host.snapshots.length;
  const calls: string[] = [];
  const unexpected = async (key: string) => { calls.push(key); throw new Error("Unexpected dispatch"); };
  const { script } = executionResource().resolve({ id: "spec", root, invocation, missionId, missionPath });
  const result = await runWorkflowScript({ script, state: host.state, launch: unexpected, status: unexpected, host: unexpected });
  expect(result.value).toMatchObject({ status: "blocked", code: incompatible, reason: expect.stringContaining("contract v10") });
  expect(calls).toEqual([]);
  expect(host.snapshots).toHaveLength(snapshots);
  expect(readFileSync(statePath, "utf8")).toBe(retained);
  expect(store.readRecords(scope, undefined, true)).toEqual(before);
});

function noVersion(packet: Record<string, unknown>) {
  const { version: _, ...old } = packet;
  return old;
}

function expectIncompatible(read: () => unknown) {
  let error: unknown;
  try { read(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(StoreError);
  expect(error).toMatchObject({ code: incompatible, recovery: undefined });
  expect(isLedgerIntegrityError(error)).toBe(false);
}

test("old packets fail in the baseline fold, gate evidence, close fold and stored close replay", async () => {
  const host = repairFixture();
  expect((await host.execute()).status).toBe("partial");
  const { root } = host;
  const { invocation } = host.current();
  const { store, scope } = executeStore(root, invocation);
  const before = store.readRecords(scope);
  const { records } = before;
  const projectionAt = (seq: number) => records.slice(0, seq).map(row => ({ ...row }));
  const baseline = records.find(row => row.opKey === `operation:${a2}.baseline`)!;
  const baselineRequest = executeRecord(executeField(baseline.body, "request"));
  const legacyBaseline = { ...baselineRequest, continuation: noVersion(executeRecord(baselineRequest.continuation)) };
  const baselinePrefix = projectionAt(records.find(row => row.opKey === `intent:${a2}`)!.seq);
  baselinePrefix[baseline.seq - 1]!.body = { operation: "baseline", request: legacyBaseline };
  expect(() => executeProjection(projectionAt(baselinePrefix.length))).not.toThrow();
  expectIncompatible(() => executeProjection(baselinePrefix));
  expectIncompatible(() => recordBaselineInput(legacyBaseline));

  // Gate replay independently reads the predecessor's view from the raw row.
  const gateRequest = executeRecord(executeField(records.find(row => row.opKey === `operation:${a2}.gate`)!.body, "request"));
  const gatePrefix = projectionAt(records.find(row => row.opKey === `worker-gate:${a2}.gate`)!.seq);
  expect(storedGateEvidence(gatePrefix, gateRequest).boardPostIds).toEqual(humanPosts.map(post => post.id));
  gatePrefix[baseline.seq - 1]!.body = { operation: "baseline", request: legacyBaseline };
  gatePrefix[baseline.seq - 1]!.requestDigest = canonicalDigest({ operation: "baseline", ...legacyBaseline });
  expectIncompatible(() => storedGateEvidence(gatePrefix, gateRequest));

  const close = records.find(row => row.kind === "receipt" && executeField(row.body, "key") === `${a2}.close`)!;
  const closeInput = records.find(row => row.opKey === `operation:${a2}.close`)!;
  const closeRequest = executeRecord(executeField(closeInput.body, "request"));
  const legacyClose = { ...closeRequest, continuation: noVersion(executeRecord(closeRequest.continuation)) };
  const folded = projectionAt(close.seq);
  expect(executeProjection(folded).prompt.execution!.foldedContinuation).toBeDefined();
  folded[closeInput.seq - 1]!.body = { operation: "close", request: legacyClose };
  expectIncompatible(() => executeProjection(folded));
  folded[closeInput.seq - 1]!.body = closeInput.body;
  const closeBody = executeRecord(close.body);
  folded[close.seq - 1]!.body = { ...closeBody, continuation: noVersion(executeRecord(closeBody.continuation)) };
  expectIncompatible(() => executeProjection(folded));
  expectIncompatible(() => closeContinuation(legacyClose, []));
  expect(store.readRecords(scope, undefined, true)).toEqual(before);

  // Append authenticated legacy inputs through a raw store, as a retained
  // store from a previous version would have done, then use the real readers.
  const raw = new PitakoStore(root);
  const key = `${a2}.close.old`;
  const request = { ...legacyClose, key };
  const old = raw.commit(scope, before.head, `operation:${key}`, canonicalDigest({ operation: "close", ...request }),
    () => ({ kind: "operation", body: { operation: "close", request } }));
  if (old.outcome !== "appended" || !old.head) throw new Error("Missing retained close fixture");
  const { head, identity } = old;
  const storedClose = { root, invocation, key, scope, storeId: identity.storeId, expectedHead: head,
    refs: { input: { seq: head.seq, digest: head.hash } } };
  const names = durableStoreFiles(store.file);
  await expect(withExecuteStore(root, invocation, () => resolveStoredGroupedInput("close", storedClose), 0,
    { storeId: identity.storeId, expectedHead: head })).rejects.toMatchObject({ code: incompatible, recovery: undefined });
  expect(store.readRecords(scope, undefined, true)).toMatchObject({ head, identity });
  expect(store.readRecords("exec:human-1.e1").records).toHaveLength(0);
  expect(durableStoreFiles(store.file)).toEqual(names);
});

const durableStoreFiles = (file: string) => readdirSync(path.dirname(file)).filter(name => !/-(wal|shm)$/.test(name));

test("a committed legacy baseline is rejected while active and ignored when a newer baseline supersedes it", async () => {
  const host = repairFixture();
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.key === `${a2}.gate`) host.setFailSave(() => true);
    return result;
  });
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const cursor = host.current();
  const { root } = host, { invocation } = cursor;
  const { store, scope } = executeStore(root, invocation);
  const raw = new PitakoStore(root);
  const { head, identity, records } = raw.readRecords(scope);
  const baseline = records.find(row => row.opKey === `operation:${a2}.baseline`)!;
  const baselineRequest = executeRecord(executeField(baseline.body, "request"));
  const legacyBaseline = { ...baselineRequest, continuation: noVersion(executeRecord(baselineRequest.continuation)) };
  const oldBaseline = raw.commit(scope, head, "legacy-baseline", canonicalDigest({ operation: "baseline", ...legacyBaseline }),
    () => ({ kind: "operation", body: { operation: "baseline", request: legacyBaseline } }));
  if (oldBaseline.outcome !== "appended" || !oldBaseline.head) throw new Error("Missing retained baseline fixture");
  const names = durableStoreFiles(store.file);
  expectIncompatible(() => store.read(scope, oldBaseline.head));
  expectIncompatible(() => readExecuteIntentContext(root, { ...cursor, head: oldBaseline.head }));
  // A direct gate (the restoring-worker path) cannot execute commands or
  // publish results before validating the continuation used by its commit.
  const gate = executeRecord(executeField(records.find(row => row.opKey === `operation:${a2}.gate`)!.body, "request"));
  await expect(withExecuteStore(root, invocation, () => runOperation("gate", gate))).rejects
    .toMatchObject({ code: incompatible, recovery: undefined });
  expect(store.readRecords(scope, undefined, true)).toMatchObject({ head: oldBaseline.head, identity });
  const currentBaseline = raw.commit(scope, oldBaseline.head, "current-baseline", baseline.requestDigest,
    () => ({ kind: "operation", body: baseline.body }));
  if (currentBaseline.outcome !== "appended" || !currentBaseline.head) throw new Error("Missing superseding baseline fixture");
  const retained = raw.readRecords(scope).records;
  expect(store.read(scope).P).toEqual(executeProjection(retained.filter(row => row.opKey !== "legacy-baseline")));
  expect(store.readRecords(scope, undefined, true)).toMatchObject({ head: currentBaseline.head, identity });
  expect(store.readRecords("exec:human-1.e1").records).toHaveLength(0);
  expect(durableStoreFiles(store.file)).toEqual(names);
});

test.each([true, false])("worker recovery checks the committed successor outside its cursor prefix (current: %s)", async current => {
  const host = fixture();
  let cut = false;
  host.setFailSave(() => cut);
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.key === a1) cut = true;
    return result;
  });
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const cursor = host.current();
  const { root } = host, { invocation } = cursor;
  const { store, scope } = executeStore(root, invocation);
  const { head, identity, records } = store.readRecords(scope);
  const worker = { key: a1, runId: host.native.get(a1)!.runId };
  const { seq, digest } = cursor.loop.attempt.intent;
  const source = executeRecord(records.find(row => row.seq === seq && row.digest === digest)!.body);
  const { baseline, ...unbound } = source;
  const intent = { ...unbound, key: a2, attempt: 2 };
  const key = `${a2}.baseline`;
  const request = { root, invocation, key, intent, continuation: {
    ...(current ? { version: EXECUTE_STATE_VERSION } : {}),
    attempt: { key: a2, restore: { producer: worker } }, taskFrame: { intents: { [a1]: source } },
  } };
  const raw = new PitakoStore(root);
  const operation = raw.commit(scope, head, `operation:${key}`, canonicalDigest({ operation: "baseline", ...request }),
    () => ({ kind: "operation", body: { operation: "baseline", request } }));
  if (operation.outcome !== "appended") throw new Error("Missing restoration operation");
  const committed = raw.commit(scope, operation.head, `intent:${a2}`, canonicalDigest({ ...intent, baseline }),
    () => ({ kind: "intent", body: { ...intent, baseline } }));
  if (committed.outcome !== "appended") throw new Error("Missing restoration intent");
  const { association, amendments, admissionBinding } = host.admitted() as {
    association: { missionId: string; missionPath: string; sourceRefs: unknown[] }; amendments: unknown[]; admissionBinding: string;
  };
  const replay = () => resolveStoredGroupedInput("close", {
    root, invocation, key: `${a1}.recover`, scope, storeId: identity.storeId, expectedHead: cursor.head,
    refs: { input: cursor.action.input, intent: { seq, digest }, worker, gateFloorMs: cursor.timeouts.gateFloorMs,
      request: { associationDigest: canonicalDigest(association), admissionBinding, missionId: association.missionId,
        missionPath: association.missionPath, sourceRefs: association.sourceRefs, amendments, specId: "spec" } },
  });
  const before = store.readRecords(scope, undefined, true);
  const files = durableStoreFiles(store.file);
  if (current) expect(replay()).toMatchObject({ replay: { replayOperation: "baseline", head: committed.head } });
  else expectIncompatible(replay);
  expect(store.readRecords(scope, undefined, true)).toEqual(before);
  expect(store.readRecords("exec:human-1.e1").records).toHaveLength(0);
  expect(durableStoreFiles(store.file)).toEqual(files);
});

test("sandbox rejects old baseline and folded packets with a coded StoreError under jiti", async () => {
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, tryNative: false });
  const loaded = await jiti.import<typeof import("../extensions/execute-state.ts")>("../extensions/execute-state.ts");
  const script = loaded.executeContinuationScript();
  const { decodeLoopIOOutput, StoreError } = continuationCodec(script);
  for (const field of ["continuation", "foldedContinuation"]) {
    const wire = { P: { prompt: { execution: { [field]: { attempt: { key: a2 } } } } } };
    const decode = () => decodeLoopIOOutput(wire);
    expect(decode).toThrow(StoreError);
    expect(decode).toThrow(expect.objectContaining({ code: incompatible, recovery: undefined }));
  }
});

test("old sandbox packet on a committed gate replay does not start a replacement", async () => {
  const host = repairFixture();
  let cut = false;
  host.setFailSave(() => cut);
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.key === `${a2}.gate`) cut = true;
    if (request.key !== `${a2}.gate.r1`) return result;
    const receipt = JSON.parse(result.output!);
    const execution = receipt.P.prompt.execution;
    execution.continuation = noVersion(execution.continuation);
    const { operation } = JSON.parse(request.task);
    return { ...result, output: transportOutput(operation, receipt) };
  });
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const saved = structuredClone(host.current());
  const { store, scope } = executeStore(host.root, saved.invocation);
  const before = store.readRecords(scope);
  const launches = host.launches.length;
  const gates = host.gateExecutions();
  cut = false;
  expect(await host.execute()).toMatchObject({ status: "blocked", code: incompatible });
  expect(host.launches.slice(launches).map(call => call.key)).toEqual([`${a2}.gate.r1`]);
  expect(host.gateExecutions()).toBe(gates);
  expect(host.current()).toEqual(saved);
  expect(store.readRecords(scope, undefined, true)).toEqual(before);
});
