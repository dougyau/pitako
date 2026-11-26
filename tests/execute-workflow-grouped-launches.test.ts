import { expect, test } from "bun:test";
import { expectProcessBudget } from "./fixtures/process-budget.ts";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { executeControllerFixture, nativeRunId } from "./fixtures/execute-workflow.ts";
import { realCheckoutCompositionFixture } from "./fixtures/plan-execute-composition.ts";
import { executeStore } from "../skills/execute/ledger.mjs";
import { readExecuteIntentContext } from "../extensions/execute-intent.ts";
import { canonicalDigest, canonicalJSON } from "../extensions/canonical.mjs";
import { checkoutEvidence } from "../extensions/spec-plans.ts";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";

const composition = realCheckoutCompositionFixture();
const scripts = composition.scripts;
const { fixture } = executeControllerFixture(composition.fake);

test("an incomplete attempt keeps grouped close and a folded baseline before reviewed completion", async () => {
  const host = fixture();
  host.setLimit(1);
  let workers = 0;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker" && workers++ === 0) {
      result.structuredOutput.status = "continue";
      result.structuredOutput.remaining = ["Finish assigned implementation"];
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  const workersCalls = host.launches.filter(call => call.agent === "pitako.worker");
  expect(workersCalls[1]!.task).toContain('"attempt":2');
  const second = host.snapshots.find(state => state.loop?.attempt?.number === 2 && state.loop.attempt.intent);
  const { intent } = readExecuteIntentContext(host.root, second);
  expect(intent.progress!.admitted.change1).toEqual(["continue"]);
  expect(intent.progress!.previous).toBeNull();
  for (const call of host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io")) {
    const input = JSON.parse(call.task), gate = input.operation === "close" ? input.gate : input.operation === "gate" ? input : null;
    if (!gate?.checkpoint) continue;
    expect(gate).not.toHaveProperty("knowledge");
    expect(gate.worker).toEqual({ key: gate.checkpoint.key, runId: nativeRunId(gate.checkpoint.key) });
  }
});

test("an observed no-journal pause keeps the previous unit in its next baseline", async () => {
  const host = fixture(undefined, { taskCount: 2 });
  host.setLimit(2);
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker" && request.key.includes(".l2.") && request.key.endsWith(".a1"))
      return host.result(request, { status: "continue", work: "No writes yet", remaining: ["Implement assigned task"] });
    return normal();
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  const second = host.snapshots.find(state => state.loop?.number === 2 && state.loop.attempt?.number === 2 && state.loop.attempt.intent);
  const { intent } = readExecuteIntentContext(host.root, second);
  expect(intent.progress!.admitted.change2).toEqual(["continue"]);
  expect(intent.progress!.previous).toMatchObject({ taskId: "change1", attempt: 1 });
  // Measured zero controller processes + one shared runtime, plus two.
  expectProcessBudget([host.processes(), composition.processes()], 3);
});

test.each(["step-order", "seal-kind", "after-candidate", "baseline-variant", "request-count", "native-artifacts"])("workflow rejects damaged %s close evidence before admission", async damage => {
  const host = fixture();
  host.setLimit(1);
  host.setRespond((request, normal) => request.agent === "pitako.worker"
    ? host.result(request, { status: "complete", work: "Confirmed no file changes", remaining: [] }) : normal());
  host.setLaunchRespond(async (request, normal) => {
    const response = await normal();
    if (pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "close") {
      const transport = JSON.parse(response.output!);
      const steps = transport.projection.steps;
      if (damage === "step-order") [steps[1], steps[2]] = [steps[2], steps[1]];
      if (damage === "seal-kind") steps.find((step: any) => step.operation === "seal").result.kind = "pause";
      if (damage === "after-candidate") steps.find((step: any) => step.operation === "seal").result.after.fingerprint = "f".repeat(64);
      if (damage === "baseline-variant") steps.find((step: any) => step.operation === "nextBaseline").result.variant = "sealed";
      if (damage === "request-count") steps.find((step: any) => step.operation === "requests").result.count = 1;
      response.output = JSON.stringify(transport);
      if (damage === "native-artifacts") delete response.externalAdapter;
    }
    return response;
  });
  expect((await host.execute()).status).toBe("blocked");
  expect(host.records().filter((entry: any) => entry.kind === "unit")).toEqual([]);
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
});

test("capacity and positive activity prevent grouped redispatch", async () => {
  const capacity = fixture();
  capacity.setLaunchRespond((request, normal) => pitakoAgentFamily(request.agent) === "loop-io"
    ? { ok: false, key: request.key, error: "Active async run capacity exhausted: 1/1 used.", output: "", results: [] }
    : normal());
  const exhausted = await capacity.execute();
  expect(exhausted.status).toBe("partial");
  expect(exhausted.reason).toContain("Active async run capacity exhausted");
  expect(capacity.launches).toHaveLength(1);

  const host = fixture();
  host.setLimit(1);
  host.setRespond((request, normal) => request.agent === "pitako.worker"
    ? host.result(request, { status: "complete", work: "Confirmed no file changes", remaining: [] }) : normal());
  host.setLaunchRespond(async (request, normal) => {
    const response = await normal();
    if (pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "close")
      response.output = "missing transport receipt";
    return response;
  });
  host.setStatus(ref => ref.includes(".close") ? { ok: true, state: "running", runId: ref }
    : host.native.get(ref) ?? { ok: true, state: "unknown" });
  expect((await host.execute()).status).toBe("blocked");
  expect(host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io" && JSON.parse(call.task).operation === "close")).toHaveLength(1);
});

async function groupedScenario(continuation: boolean, uninterrupted?: { root: string; launches: any[] }) {
  const host = fixture(undefined, { realCheckout: true });
  host.setLimit(1);
  const storedInputs = new Map<string, any>();
  host.setSaveObserver(() => {
    const value = host.current();
    const pending = value.action;
    if (pending.kind === "pending" && ["advance", "selection", "close"].includes(pending.op))
      storedInputs.set(pending.opKey, { operation: pending.op, key: pending.opKey,
        root: value.root, invocation: value.invocation, storeId: value.storeId,
        scope: `exec:${value.invocation}.e${value.epoch}`, expectedHead: value.head,
        refs: { input: pending.input } });
  });
  let workers = 0;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director")
      for (const change of result.structuredOutput.changes) for (const gate of change.task.gates) gate.command = "true";
    if (request.agent === "pitako.worker" && workers++ === 0 && continuation) {
      result.structuredOutput.status = "continue";
      result.structuredOutput.remaining = ["Finish assigned task"];
    }
    return result;
  });
  const entry = path.resolve("skills/execute/loop-io.mjs");
  const metadata = { ...scripts, root: host.root, missionPath: path.join(host.root, ".pi/native-mission.json") };
  const closeKey = "invoke-human-1.l1.t1.a1.close";
  let replayedClose = false;
  host.setLaunchRespond(async (request, normal) => {
    if (request.agent === "pitako.checkpoint-sealer" ||
        pitakoAgentFamily(request.agent) === "loop-io" && JSON.parse(request.task).operation === "taskDelta")
      return scripts.runDeterministic(request.key, request, { ...metadata, inlineSealer: true }, undefined);
    if (pitakoAgentFamily(request.agent) !== "loop-io") return normal();
    const input = JSON.parse(request.task), dbPath = path.join(host.root, ".pi/board.db");
    if (!["advance", "selection", "close", "drain"].includes(input.operation)) return normal();
    const originalClose = request.key === `${closeKey}.r1` ? host.native.get(closeKey) : null;
    const retained = executeStore(host.root, "human-1");
    const before = originalClose ? { checkout: checkoutEvidence(host.root),
      ledger: canonicalJSON(host.records()), head: retained.store.readRecords(retained.scope).head } : null;
    for (const name of ["prepare", "apply", "gate"]) if (input[name]) input[name].dbPath = dbPath;
    for (const intention of input.intentions ?? []) if (intention.operation === "apply") intention.input.dbPath = dbPath;
    // Exercise stdin/stdout on advance and on both sides of the close cut.
    // The uninterrupted close control uses the same operations in the warm fixture runtime.
    let observation: [number, string, string] | undefined;
    if ((!continuation && input.operation === "advance") ||
        (uninterrupted && (request.key === closeKey || request.key === `${closeKey}.r1`))) {
      const child = Bun.spawn(["node", entry], { cwd: host.root,
        env: { ...process.env, PI_CODING_AGENT_DIR: path.join(host.root, ".pi/private-agent"),
          NODE_COMPILE_CACHE: path.join(host.root, ".pi/node-compile-cache") },
        stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const lifecycle = composition.checkpointLifecycle(child, value => value);
      child.stdin.write(JSON.stringify(input)); child.stdin.end();
      observation = await lifecycle.result;
    } else {
      const response = await scripts.runDeterministic(request.key, { ...request, task: JSON.stringify(input) },
        metadata, undefined);
      observation = [response.results[0].exitCode, response.output + "\n", ""];
    }
    expect(observation).toBeDefined();
    const [exit, stdout, stderr] = observation!;
    expect(exit, stdout + stderr).toBe(0);
    const transport = JSON.parse(stdout);
    if (originalClose) {
      const original = JSON.parse(originalClose.output!);
      expect(transport.digest).toBe(original.digest);
      expect(transport.head).toEqual(original.head);
      const committed = retained.store.read(retained.scope, original.head);
      const decoded = structuredClone(transport.P);
      const folded = decoded.prompt.execution.foldedContinuation;
      if (folded) {
        const step = (operation: string) => transport.projection.steps.find((value: any) => value.operation === operation).result;
        for (const [field, fact, same] of [
          ["requests", step("nextRequests"), ["projection", "steps", "nextRequests", "result"]],
          ["seal", step("seal").receipt, ["projection", "steps", "seal", "result", "receipt"]],
        ] as const) {
          expect(folded[field]).toEqual({ same, digest: canonicalDigest(fact) });
          folded[field] = fact;
        }
      }
      expect(canonicalJSON(decoded)).toBe(canonicalJSON(committed.P));
      expect(checkoutEvidence(host.root)).toEqual(before!.checkout);
      expect(canonicalJSON(host.records())).toBe(before!.ledger);
      expect(retained.store.readRecords(retained.scope).head).toEqual(before!.head);
      replayedClose = true;
    }
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(61441);
    const row = retained.store.readRecords(retained.scope, transport.head).records.at(-1)!;
    expect(row.kind).toBe("receipt");
    expect(canonicalDigest(row.body)).toBe(transport.digest);
    const asyncDir = path.join(host.root, ".pi/native-groups", request.key);
    mkdirSync(asyncDir, { recursive: true });
    const stdoutPath = path.join(asyncDir, "stdout.log"), stderrPath = path.join(asyncDir, "stderr.log");
    writeFileSync(stdoutPath, stdout); writeFileSync(stderrPath, stderr);
    return { ok: true, key: request.key, agent: request.agent, runId: `cli-${request.key}`,
      asyncDir, externalAdapter: { outputArtifacts: { stdoutPath, stderrPath } },
      output: stdout.slice(-65536), results: [{ exitCode: exit }] } as any;
  });
  // This case owns the CLI transport; native sandbox dispatch is covered by composition.
  if (uninterrupted) host.setFailSave(() => host.native.has(closeKey));
  let output = await host.execute();
  if (uninterrupted) {
    expect(output.reason).toContain("Essential persistence failed");
    expect(host.launches.at(-1)!.key).toBe(closeKey);
    expect(host.native.get(closeKey)?.ok).toBe(true);
    const cut = host.launches.length;
    host.setFailSave();
    output = await host.execute();
    const resumed = host.launches.slice(cut);
    expect(resumed[0]?.key).toBe(`${closeKey}.r1`);
    expect(JSON.parse(resumed[0]!.task)).toMatchObject({ key: closeKey, operation: "close", refs: { committed: true } });
    expect(resumed.filter(call => /\.r\d+$/.test(call.key)).map(call => call.key)).toEqual([`${closeKey}.r1`]);
    expect(replayedClose).toBe(true);
    const originalIndex = uninterrupted.launches.findIndex(call => call.key === closeKey);
    const normalize = (calls: any[], root: string) => {
      const { store, scope } = executeStore(root, "human-1");
      return canonicalJSON(calls).replaceAll(root, "<root>")
        .replaceAll(store.readRecords(scope).identity.storeId, "<store-id>")
        .replace(/[a-f0-9]{64}/g, "<root-bound-digest>");
    };
    expect(normalize(resumed.slice(1), host.root))
      .toBe(normalize(uninterrupted.launches.slice(originalIndex + 1), uninterrupted.root));
    expect(host.launches).toHaveLength(uninterrupted.launches.length + 1);
    expect(host.launches.filter(call => ["worker", "reviewer"].includes(pitakoAgentFamily(call.agent) ?? "")).map(call => call.key))
      .toEqual(uninterrupted.launches.filter(call => ["worker", "reviewer"].includes(pitakoAgentFamily(call.agent) ?? "")).map(call => call.key));
  }
  expect(output.status, output.reason).toBe("partial");
  expect(output.reason).toContain("1 authorized loops consumed");
  expect(host.records().map((record: any) => record.kind)).toEqual(continuation ? ["spec", "unit", "unit", "loop"] : ["spec", "unit", "loop"]);
  const { store, scope } = executeStore(host.root, host.current().invocation);
  const control = store.read(scope, host.current().head).P.control;
  if (!("finishDrain" in control)) throw new Error("Expected committed final drain.");
  expect(control.finishDrain).toEqual({
    key: `invoke-human-1.l1.finishDrain${continuation ? ".v1" : ""}`, generation: continuation ? 1 : 0,
  });
  expect(new Set([...storedInputs.values()].map(input => input.operation)))
    .toEqual(new Set(continuation ? ["advance", "selection", "close"] : ["advance", "selection"]));
  for (const input of storedInputs.values()) {
    expect(Object.keys(input).sort()).toEqual([
      "expectedHead", "invocation", "key", "operation", "refs", "root", "scope", "storeId",
    ]);
    const prefix = store.read(scope, input.expectedHead);
    expect(input.storeId).toBe(prefix.identity.storeId);
    expect(input.scope).toBe(scope);
    const row = prefix.records.find(row => row.seq === input.refs.input.seq);
    expect(row?.digest).toBe(input.refs.input.digest);
    expect(row?.kind).toBe("operation");
    const body = row?.body;
    if (!body || typeof body !== "object" || !("operation" in body) ||
        !("request" in body) || !body.request || typeof body.request !== "object" || !("key" in body.request))
      throw new Error("Expected committed operation request.");
    expect(body.operation).toBe(input.operation);
    expect(body.request.key).toBe(input.key);
  }
  return { root: host.root, launches: host.launches };
}

test.each([false, true])("workflow admits actual grouped CLI projections and drains linked intentions (continuation: %s)", continuation => composition.ownWorkflow(async () => {
  const uninterrupted = await groupedScenario(continuation);
  if (continuation) await groupedScenario(true, uninterrupted);
}));
