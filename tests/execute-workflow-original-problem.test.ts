import { expect, test } from "bun:test";
import { executeControllerFixture, gaps } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const snapshots = (host: ReturnType<typeof fixture>) => host.emits.filter(value => value.schema === "pitako.execute-todo");
// Marks planned checks the way an anchored director would; the root never requires it.
function marking(host: ReturnType<typeof fixture>, verifies: Record<string, number[]>, failing: string[] = []) {
  const prompts: string[] = [];
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director") {
      prompts.push(request.task);
      for (const task of result.structuredOutput.tasks ?? [])
        for (const check of task.checks) if (verifies[check.id]) check.verifies = verifies[check.id];
    }
    if (request.agent === "pitako.worker" && failing.includes(result.structuredOutput.taskId)) {
      const value = result.structuredOutput;
      value.status = "gaps"; value.remaining = ["Repair the failing designated check"];
      value.checks = value.checks.map((check: any) => ({ ...check, result: "failed", output: "Observed failure: 1 test" }));
    }
    return result;
  });
  return prompts;
}

test("every named criterion must pass before the notice reports the original problem fulfilled", async () => {
  const host = fixture(undefined, { readOnly: true });
  const prompts = marking(host, { "change1-check": [3], "final-check": [5] });
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
    { criterion: 5, status: "passed", loop: 1, taskId: "final", check: { id: "final-check" } }] });
  expect(outcome.loopReport.originalProblem.status).toBe("fulfilled");
});

test("a later failing designated check turns the notice unfulfilled without changing the loop", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(1);
  marking(host, { "change1-check": [3], "final-check": [3] }, ["final"]);
  const outcome = await host.execute({ originalProblem: { criteria: [3] } });
  expect(outcome.status).toBe("partial");
  const rows = snapshots(host).map(value => value.originalProblem?.subject).filter(Boolean);
  expect(rows.some(subject => subject.includes("· cumplido"))).toBe(true);
  expect(rows.at(-1)).toContain("no cumplido");
  expect(snapshots(host).at(-1).originalProblem.status).toBe("pending");
  expect(outcome.originalProblem).toMatchObject({ status: "unfulfilled",
    criteria: [{ criterion: 3, status: "failed", taskId: "final" }] });
  // Advisory only: no extra phase, gate or analysis call beyond the ordinary loop.
  expect(snapshots(host).every(value => value.phases.length <= 3)).toBe(true);
});

test("specs without a criteria anchor keep the director prompt and view unchanged", async () => {
  for (const anchor of [undefined, null, { spec: "fix-spec" }]) {
    const host = fixture(undefined, { readOnly: true });
    const prompts = marking(host, { "final-check": [1] });
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
  const host = fixture(undefined, { readOnly: true }); host.setLimit(2);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director") {
      if (request.key.includes(".l2.")) {
        result.structuredOutput.status = "needs-decision"; result.structuredOutput.reason = "Choose remaining scope";
      } else result.structuredOutput.tasks.at(-1).checks[0].verifies = [1];
    }
    return request.key.endsWith(".compliance") ? gaps(result) : result;
  });
  const outcome = await host.execute({ originalProblem: { criteria: [1] } });
  expect(outcome.status).toBe("blocked");
  expect(outcome.loopsConsumed).toBe(2);
  expect(outcome.originalProblem).toMatchObject({ status: "fulfilled", criteria: [{ criterion: 1, loop: 1, taskId: "final" }] });
  expect(snapshots(host).filter(value => value.loop === 2).at(-1).originalProblem.subject).toContain("· cumplido");
});
