import { expect, test } from "bun:test";
import { executeControllerFixture, gaps } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();

test("execute analysis requests get four hours, including agentless resumed final synthesis", async () => {
  const host = fixture();
  expect((await host.executeNative()).status).toBe("complete");

  for (const suffix of [
    ".task-reviewer", ".task-synthesis", ".review.director-prepare",
    ".review.independent-angle1-r1", ".review.independent-angle1-r2",
    ".review.director-synthesis", ".compliance",
  ]) {
    const requests = host.calls.filter(call => call.key.endsWith(suffix));
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.timeoutMs).toBe(14400000);
  }
  const synthesis = host.calls.find(call => call.key.endsWith(".review.director-synthesis"))!;
  expect(synthesis.resume).toBeString();
  expect(synthesis).not.toHaveProperty("agent");

  // These launch paths do not pass through execute's analysis dispatcher.
  for (const agent of ["pitako.access-verifier", "pitako.execution-director"]) {
    const requests = host.calls.filter(call => call.agent === agent);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request).not.toHaveProperty("timeoutMs");
  }
  const workers = host.calls.filter(call => call.agent === "pitako.worker");
  expect(workers.length).toBeGreaterThan(0);
  for (const request of workers) expect(request.timeoutMs).toBe(14400000);
});

test("inherited-demand observation gets the execute analysis default", async () => {
  const host = fixture(undefined, { taskCount: 0 });
  host.setRespond((request, normal) =>
    request.key === "invoke-human-1.l1.compliance" ? gaps(normal()) : normal());
  expect((await host.executeNative()).status).toBe("complete");
  const observations = host.calls.filter(call => call.key.endsWith(".demand-observation"));
  expect(observations).toHaveLength(1);
  expect(observations[0]!.timeoutMs).toBe(14400000);
});

test("execution inspector retains its existing timeout policy", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key === "invoke-human-1.l1.director") delete result.structuredOutput;
    return result;
  });
  await host.executeNative();
  const inspectors = host.calls.filter(call => call.agent === "pitako.execution-inspector");
  expect(inspectors.length).toBeGreaterThan(0);
  for (const request of inspectors) expect(request).not.toHaveProperty("timeoutMs");
});
