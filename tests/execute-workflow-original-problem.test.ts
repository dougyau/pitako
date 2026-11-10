import { expect, test } from "bun:test";
import { executeControllerFixture, gaps } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const snapshots = (host: ReturnType<typeof fixture>) => host.emits.filter(value => value.schema === "pitako.execute-todo");
// Only workflow-owned gates designate and attest original-problem criteria.
function marking(host: ReturnType<typeof fixture>, verifies: Record<string, number[]>, failing: string[] = []) {
  const prompts: string[] = [];
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director") {
      prompts.push(request.task);
      for (const change of result.structuredOutput.changes)
        for (const gate of change.task?.gates ?? []) if (verifies[gate.id]) gate.verifies = verifies[gate.id];
      for (const gate of result.structuredOutput.acceptance ?? [])
        if (verifies[gate.id]) gate.verifies = verifies[gate.id];
    }
    if (request.agent === "pitako.loop-io") {
      const input = JSON.parse(request.task);
      if (input.operation === "gate" && failing.includes(input.task.id)) {
        const receipt = JSON.parse(result.output!);
        receipt.gates = receipt.gates.map((gate: any) => ({ ...gate, status: "fail", exit: 1, tail: "Observed failure: 1 test" }));
        result.output = JSON.stringify(receipt);
      }
    }
    return result;
  });
  return prompts;
}

test("every named criterion must pass before the notice reports the original problem fulfilled", async () => {
  const host = fixture(undefined, { readOnly: true });
  const prompts = marking(host, { "change1-check": [3], "full": [5] });
  const outcome = await host.execute({ originalProblem: { criteria: [3, 5] } });
  expect(outcome.status).toBe("complete");
  expect(prompts[0]).toContain("criteria #3, #5");
  const values = snapshots(host);
  // After only #3 passed the notice is unknown and shows no row.
  const partial = values.find(value => value.tasks.some((task: any) => task.id === "change1" && task.status === "completed"));
  expect(partial).not.toHaveProperty("originalProblem");
  expect(values.find(value => value.originalProblem)?.originalProblem.status).toBe("pending");
  expect(values.at(-1).originalProblem).toMatchObject({ status: "completed" });
  expect(values.at(-1).originalProblem.subject).toContain("Problema original · cumplido");
  expect(outcome.originalProblem).toMatchObject({ status: "fulfilled", criteria: [
    { criterion: 3, status: "passed", loop: 1, taskId: "change1", check: { id: "change1-check" } },
    { criterion: 5, status: "passed", loop: 2, taskId: "final-acceptance", check: { id: "full" } }] });
  expect(outcome.loopReport.originalProblem.status).toBe("fulfilled");
});

test("a later failing designated check turns the notice unfulfilled without changing the loop", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(2);
  marking(host, { "change1-check": [3], "full": [3] }, ["final-acceptance"]);
  const outcome = await host.execute({ originalProblem: { criteria: [3] } });
  expect(outcome.status).toBe("partial");
  const rows = snapshots(host).map(value => value.originalProblem?.subject).filter(Boolean);
  expect(rows.some(subject => subject.includes("· cumplido"))).toBe(true);
  expect(rows.at(-1)).toContain("no cumplido");
  expect(snapshots(host).at(-1).originalProblem.status).toBe("pending");
  expect(outcome.originalProblem).toMatchObject({ status: "unfulfilled",
    criteria: [{ criterion: 3, status: "failed", taskId: "final-acceptance" }] });
  // Advisory only: no extra phase, gate or analysis call beyond the ordinary loop.
  expect(snapshots(host).every(value => value.phases.length <= 3)).toBe(true);
});

test("specs without a criteria anchor keep the director prompt and view unchanged", async () => {
  for (const anchor of [undefined, null, { spec: "fix-spec" }]) {
    const host = fixture(undefined, { readOnly: true });
    const prompts = marking(host, { "full": [1] });
    const outcome = await host.execute(anchor === undefined ? {} : { originalProblem: anchor });
    expect(outcome.status).toBe("complete");
    expect(prompts[0]).not.toContain("ORIGINAL PROBLEM");
    expect(snapshots(host).some(value => "originalProblem" in value)).toBe(false);
    expect(outcome.originalProblem.status).toBe("unknown");
    if (anchor?.spec) expect(outcome.originalProblem.reason).toContain("spec fix-spec");
    expect(host.current()).not.toHaveProperty("originalProblem");
  }
});

test("the notice survives later loops and a halted result", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(3);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director") {
      if (request.key.includes(".l3.")) {
        return { ...result, ok: false, error: "Blocked by pi-subagents permission rule: choose remaining scope" };
      } else for (const gate of result.structuredOutput.acceptance ?? []) gate.verifies = [1];
    }
    return request.key.endsWith(".compliance") ? gaps(result) : result;
  });
  const outcome = await host.execute({ originalProblem: { criteria: [1] } });
  expect(outcome.status).toBe("blocked");
  expect(outcome.loopsConsumed).toBe(3);
  expect(outcome.originalProblem).toMatchObject({ status: "fulfilled", criteria: [{ criterion: 1, loop: 2, taskId: "final-acceptance" }] });
  expect(snapshots(host).filter(value => value.loop === 3).at(-1).originalProblem.subject).toContain("· cumplido");
});


test("a missing receipt or a gate without designation cannot verify a criterion", async () => {
  for (const missing of [false, true]) {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => {
      const result = normal();
      if (missing && request.agent === "pitako.execution-director")
        result.structuredOutput.changes[0].task.gates[0].verifies = [1];
      if (missing && request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "gate")
        result.output = "No complete receipt";
      return result;
    });
    const outcome = await host.execute({ originalProblem: { criteria: [1] } });
    expect(outcome.originalProblem).toMatchObject({ status: "unknown", criteria: [{ criterion: 1, status: "not-run" }] });
    expect(host.current()).not.toHaveProperty("originalProblem");
    if (missing) expect(outcome.status).toBe("blocked");
  }
});

test("a previously passing receipt cannot verify a changed candidate", async () => {
  const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
  marking(host, { "change1-check": [1] });
  expect((await host.execute({ originalProblem: { criteria: [1] } })).originalProblem.status).toBe("fulfilled");
  host.changeCheckout();
  const outcome = await host.execute({ originalProblem: { criteria: [1] } });
  expect(outcome.originalProblem).toMatchObject({ status: "unknown", criteria: [{ criterion: 1, status: "not-run" }] });
  expect(host.calls.filter(request => request.agent === "pitako.worker")).toHaveLength(1);
});
