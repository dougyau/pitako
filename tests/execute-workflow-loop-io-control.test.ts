import { expect, test } from "bun:test";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();

test("only loop-io requests carry the fixed idle control, including transport and director retries", async () => {
  const host = fixture();
  host.setRespond((request, normal) => {
    // Exercise both request paths: runtime operations and worker/final gates.
    if (request.key === "invoke-human-1.l1.prepare" || request.key === "invoke-human-1.l1.t1.a1.gate")
      return { ...host.result(request, {}), output: "invalid transport receipt" };
    const result = normal();
    if (request.key === "invoke-human-1.l1.director") result.structuredOutput.select = "unknown";
    return result;
  });
  const outcome = await host.executeNative();
  expect(outcome.status, outcome.reason).toBe("complete");
  const io = host.calls.filter(call => call.agent === "pitako.loop-io");
  expect(io.map(call => call.key)).toEqual(expect.arrayContaining([
    "invoke-human-1.l1.prepare.r1", "invoke-human-1.l1.selection.d1", "invoke-human-1.l1.t1.a1.gate.r1",
  ]));
  expect(io.map(call => JSON.parse(call.task).operation)).toEqual(expect.arrayContaining(["prepare", "apply", "gate"]));
  for (const call of io) expect(call).toHaveProperty("control", { needsAttentionAfterMs: 1_800_000 });
  for (const call of io.filter(call => JSON.parse(call.task).operation === "gate"))
    expect(call.timeoutMs).toBe(14_400_000);
  for (const agent of ["pitako.execution-director", "pitako.worker", "pitako.checkpoint-sealer"]) {
    const calls = host.calls.filter(call => call.agent === agent);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toHaveProperty("control");
  }
});
