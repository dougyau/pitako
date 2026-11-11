import { expect, test } from "bun:test";
import { expectProcessBudget } from "./fixtures/process-budget.ts";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";
import { realCheckoutCompositionFixture } from "./fixtures/plan-execute-composition.ts";

const composition = realCheckoutCompositionFixture();
const scripts = composition.scripts;
const { fixture } = executeControllerFixture(composition.fake);

test("a reviewed task uses standalone gate and seal with one trailing drain", async () => {
  const host = fixture();
  host.setLimit(1);
  const output = await host.execute();
  expect(output.status, output.reason + "\n" + host.launches.map(call => call.key).join("\n")).toBe("partial");
  expect(host.launches.map(call => call.agent === "pitako.loop-io" ? JSON.parse(call.task).operation : call.agent))
    .toEqual(["advance", "pitako.execution-director", "selection", "pitako.worker", "gate", "taskDelta",
      "pitako.reviewer", "pitako.reviewer", "pitako.request-observer", "pitako.checkpoint-sealer", "drain"]);
  const drain = JSON.parse(host.launches.at(-1)!.task);
  expect(drain.intentions.map((entry: any) => entry.operation === "ledger" ? entry.input.record.kind : "settlement"))
    .toEqual(["unit", "settlement", "loop"]);
  expect(host.current().intentions).toEqual([]);
});

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
  expect(host.launches.map(call => call.agent === "pitako.loop-io" ? JSON.parse(call.task).operation : call.agent))
    .toEqual(["advance", "pitako.execution-director", "selection", "pitako.worker", "close", "pitako.worker",
      "gate", "taskDelta", "pitako.reviewer", "pitako.reviewer", "pitako.request-observer", "drain", "pitako.checkpoint-sealer", "drain"]);
  const workersCalls = host.launches.filter(call => call.agent === "pitako.worker");
  expect(workersCalls[1]!.task).toContain('"attempt":2');
  const second = host.snapshots.find(state => state.loop?.attempt?.number === 2 && state.loop.attempt.checkpoint);
  expect(second!.loop.attempt.checkpoint.progress.admitted.change1).toEqual(["continue"]);
  expect(second!.loop.attempt.checkpoint.progress.previous).toBeNull();
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
  const second = host.snapshots.find(state => state.loop?.number === 2 && state.loop.attempt?.number === 2 && state.loop.attempt.checkpoint);
  expect(second!.loop.attempt.checkpoint.progress.admitted.change2).toEqual(["continue"]);
  expect(second!.loop.attempt.checkpoint.progress.previous).toMatchObject({ taskId: "change1", attempt: 1 });
  expect(host.launches).toHaveLength(23);
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
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "close") {
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
  expect(host.current().lastConfirmed).toBeNull();
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
});

test("capacity and positive activity prevent grouped redispatch", async () => {
  const capacity = fixture();
  capacity.setLaunchRespond((request, normal) => request.agent === "pitako.loop-io"
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
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "close")
      response.output = "missing transport receipt";
    return response;
  });
  host.setStatus(ref => ref.includes(".close") ? { ok: true, state: "running", runId: ref }
    : host.native.get(ref) ?? { ok: true, state: "unknown" });
  expect((await host.execute()).status).toBe("blocked");
  expect(host.launches.filter(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "close")).toHaveLength(1);
});

test.each([false, true])("workflow admits actual grouped CLI projections and drains linked intentions (continuation: %s)", async continuation => {
  const host = fixture(undefined, { realCheckout: true });
  host.setLimit(1);
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
  host.setLaunchRespond(async (request, normal) => {
    if (request.agent === "pitako.checkpoint-sealer" ||
        request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "taskDelta")
      return scripts.runDeterministic(request.key, request, { ...scripts, root: host.root, inlineSealer: true }, undefined);
    if (request.agent !== "pitako.loop-io") return normal();
    const input = JSON.parse(request.task), dbPath = path.join(host.root, ".pi/board.db");
    if (!["advance", "selection", "close", "drain"].includes(input.operation)) return normal();
    for (const name of ["prepare", "apply", "gate"]) if (input[name]) input[name].dbPath = dbPath;
    for (const intention of input.intentions ?? []) if (intention.operation === "apply") intention.input.dbPath = dbPath;
    // Keep stdin/stdout CLI coverage for advance and close, not a cold loader for every drain.
    let observation: [number, string, string] | undefined;
    if (input.operation === (continuation ? "close" : "advance") && workers <= 1) {
      const child = Bun.spawn(["node", entry], { cwd: host.root,
        env: { ...process.env, NODE_COMPILE_CACHE: path.join(host.root, ".pi/node-compile-cache") },
        stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const lifecycle = composition.checkpointLifecycle(child, value => value);
      child.stdin.write(JSON.stringify(input)); child.stdin.end();
      observation = await lifecycle.result;
    } else {
      const response = await scripts.runDeterministic(request.key, { ...request, task: JSON.stringify(input) },
        { ...scripts, root: host.root }, undefined);
      observation = [response.results[0].exitCode, response.output + "\n", ""];
    }
    expect(observation).toBeDefined();
    const [exit, stdout, stderr] = observation!;
    expect(exit, stdout + stderr).toBe(0);
    const transport = JSON.parse(stdout);
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(61441);
    expect(createHash("sha256").update(readFileSync(transport.path)).digest("hex")).toBe(transport.digest);
    const asyncDir = path.join(host.root, ".pi/native-groups", request.key);
    mkdirSync(asyncDir, { recursive: true });
    const stdoutPath = path.join(asyncDir, "stdout.log"), stderrPath = path.join(asyncDir, "stderr.log");
    writeFileSync(stdoutPath, stdout); writeFileSync(stderrPath, stderr);
    return { ok: true, key: request.key, agent: request.agent, runId: `cli-${request.key}`,
      asyncDir, externalAdapter: { outputArtifacts: { stdoutPath, stderrPath } },
      output: stdout.slice(-65536), results: [{ exitCode: exit }] } as any;
  });
  const output = await host.executeNative();
  expect(output.status, output.reason).toBe("partial");
  expect(output.reason).toContain("1 authorized loops consumed");
  expect(host.launches.map(call => call.agent === "pitako.loop-io" ? JSON.parse(call.task).operation : call.agent))
    .toEqual(["advance", "pitako.execution-director", "selection", "pitako.worker",
      ...(continuation ? ["close", "pitako.worker"] : []),
      "gate", "taskDelta", "pitako.reviewer", "pitako.reviewer", "pitako.request-observer",
      ...(continuation ? ["drain"] : []), "pitako.checkpoint-sealer", "drain"]);
  expect(host.records().map((record: any) => record.kind)).toEqual(continuation ? ["spec", "unit", "unit", "loop"] : ["spec", "unit", "loop"]);
  expect(host.current().intentions).toEqual([]);
});
