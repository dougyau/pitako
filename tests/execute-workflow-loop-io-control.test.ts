import { expect, test } from "bun:test";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();

test("only loop-io requests carry the fixed idle control, including transport and director retries", async () => {
  const host = fixture();
  const failed = new Set<string>();
  let workers = 0;
  host.setLaunchRespond(async (request, normal) => {
    if (request.agent === "pitako.loop-io" && ["advance", "close"].includes(JSON.parse(request.task).operation) &&
        !failed.has(JSON.parse(request.task).operation)) {
      failed.add(JSON.parse(request.task).operation);
      return { ...await normal(), output: "invalid transport receipt" };
    }
    return normal();
  });
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.worker" && workers++ === 0) {
      result.structuredOutput.status = "continue";
      result.structuredOutput.remaining = ["Finish assigned implementation"];
    }
    if (request.key === "invoke-human-1.l1.director") result.structuredOutput.select = "unknown";
    return result;
  });
  const outcome = await host.executeNative();
  expect(outcome.status, outcome.reason).toBe("complete");
  const io = host.launches.filter(call => call.agent === "pitako.loop-io");
  expect(io.map(call => call.key)).toEqual(expect.arrayContaining([
    "invoke-human-1.l1.advance.r1", "invoke-human-1.l1.selectionIO.d1", "invoke-human-1.l1.t1.a1.close.r1",
  ]));
  expect(io.map(call => JSON.parse(call.task).operation)).toEqual(expect.arrayContaining(["advance", "selection", "close"]));
  for (const call of io) expect(call).toHaveProperty("control", { needsAttentionAfterMs: 1_800_000 });
  for (const call of io.filter(call => ["gate", "close"].includes(JSON.parse(call.task).operation)))
    expect(call.timeoutMs).toBe(14_400_000);
  for (const agent of ["pitako.execution-director", "pitako.worker"]) {
    const calls = host.launches.filter(call => call.agent === agent);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toHaveProperty("control");
  }
});
