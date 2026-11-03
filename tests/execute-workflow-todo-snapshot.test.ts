import { expect, test } from "bun:test";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const snapshots = (host: ReturnType<typeof fixture>) => host.emits.filter(value => value.schema === "pitako.execute-todo");

test("execute todo transitions expose only validated tasks and retain awaited worker admission", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setRespond((request, normal) => {
    const latest = snapshots(host).at(-1);
    if (request.agent === "pitako.execution-director") {
      expect(latest).toMatchObject({ v: 1, seq: 1, invocation: "human-1", loop: 1, tasks: [], active: null,
        phases: [{ name: "plan", subject: "Loop 1/3 · Plan", status: "in_progress", metadata: { protected: true } }] });
    }
    if (request.agent === "pitako.worker") {
      expect(request.async).not.toBe(true); // Explicit async would return a receipt, not the authoritative result.
      expect(latest.phases[0].status).toBe("completed");
      expect(latest.tasks.find((task: any) => task.id === latest.active.taskId)).toMatchObject({
        status: "in_progress", metadata: { cancel: "request" }, blockedBy: [],
        subject: expect.stringContaining("(pasos en vivo no disponibles)"),
      });
      expect(latest.active).toMatchObject({ attempt: 1, workflowKey: request.key });
    }
    const result = normal();
    if (request.agent === "pitako.execution-director") result.structuredOutput.tasks[1].dependsOn = [{ taskId: "change1", reason: "Verify implementation" }];
    return result;
  });
  expect((await host.executeNative()).status).toBe("complete");
  const values = snapshots(host);
  const admitted = values.find(value => value.tasks.length);
  expect(admitted.phases[0].status).toBe("completed");
  expect(admitted.tasks.map((task: any) => task.subject)).toEqual([
    "change1 Goal change1 (pasos en vivo no disponibles)", "final Goal final (pasos en vivo no disponibles)",
  ]);
  expect(admitted.tasks[1].blockedBy).toEqual(["change1"]);
  expect(values.some(value => value.tasks.some((task: any) => task.id === "change1" && task.status === "completed"))).toBe(true);
  expect(values.some(value => value.phases.some((phase: any) => phase.name === "review" && phase.status === "in_progress"))).toBe(true);
  expect(values.some(value => value.phases.some((phase: any) => phase.name === "compliance" && phase.status === "in_progress"))).toBe(true);
  expect(values.at(-1)).toMatchObject({ outcome: "complete", active: null });
  values.forEach((value, index) => {
    expect(value.seq).toBe(index + 1);
    expect(JSON.stringify(value).length).toBeLessThan(4096);
    expect(value).not.toHaveProperty("elapsedMs");
    if (index) { const { seq: _, ...previous } = values[index - 1]; const { seq: __, ...current } = value; expect(current).not.toEqual(previous); }
    for (const phase of value.phases) expect(phase.metadata.protected).toBe(true);
  });
});

test.each(["needs-decision", "rejected"])("execute todo cancels Plan without draft rows on %s", async mode => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director") {
      if (mode === "needs-decision") { result.structuredOutput.status = mode; result.structuredOutput.reason = "Decision needed\nChoose scope"; }
      else result.structuredOutput.tasks[0].scope = [];
    }
    return result;
  });
  await host.execute();
  expect(host.calls.some(request => request.agent === "pitako.worker")).toBe(false);
  const values = snapshots(host);
  expect(values.length).toBeGreaterThan(1);
  expect(values.every(value => value.tasks.length === 0 && value.active === null)).toBe(true);
  expect(values.at(-1).phases[0]).toMatchObject({ name: "plan", status: "cancelled", metadata: { protected: true } });
  expect(values.at(-1).phases[0].reason).not.toMatch(/[\r\n]/);
});

test("execute todo updates the attempt subject on a useful same-task continuation", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setRespond((request, normal) => {
    if (request.key.endsWith(".t1.a1")) return host.result(request, { ...host.worker(request),
      status: "continue", remaining: ["Finish the assigned check"], continuation: "Run the diagnosed pending check" });
    return normal();
  });
  expect((await host.execute()).status).toBe("complete");
  expect(snapshots(host).some(value => value.active?.attempt === 2 && value.tasks[0].subject.includes("(intento 2)"))).toBe(true);
});
