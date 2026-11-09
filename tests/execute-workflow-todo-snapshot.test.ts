import { expect, test } from "bun:test";
import { readBacklog } from "../skills/execute/loop.ts";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const snapshots = (host: ReturnType<typeof fixture>) => host.emits.filter(value => value.schema === "pitako.execute-todo");

test("execute todo transitions expose only validated tasks and retain awaited worker admission", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setRespond((request, normal) => {
    const latest = snapshots(host).at(-1);
    if (request.agent === "pitako.execution-director" && request.key.includes(".l1.")) {
      expect(latest).toMatchObject({ v: 1, seq: 1, invocation: "human-1", loop: 1, tasks: [], active: null,
        phases: [{ name: "plan", subject: "Loop 1/3 · Plan", status: "in_progress", metadata: { protected: true } }] });
    }
    if (request.agent === "pitako.worker") {
      expect(request.label).toBe(`Title ${latest.active.taskId}`);
      expect(request.task).toContain(`"goal":"Goal ${latest.active.taskId}"`);
      expect(JSON.stringify(latest)).not.toContain(`Goal ${latest.active.taskId}`);
      expect(request.async).not.toBe(true); // Explicit async would return a receipt, not the authoritative result.
      expect(latest.phases[0].status).toBe("completed");
      expect(latest.tasks.find((task: any) => task.id === latest.active.taskId)).toMatchObject({
        status: "in_progress", metadata: { cancel: "request" }, blockedBy: [],
        subject: `Title ${latest.active.taskId} (intento 1) · paths 0 · gates 0/1 · stall 0/3 · stalls 0/2`,
      });
      expect(latest.active).toMatchObject({ attempt: 1, workflowKey: request.key });
    }
    const result = normal();
    return result;
  });
  expect((await host.executeNative()).status).toBe("complete");
  const values = snapshots(host);
  const admitted = values.find(value => value.tasks.length);
  expect(admitted.phases[0].status).toBe("completed");
  expect(admitted.tasks.map((task: any) => task.subject)).toEqual([
    "Title change1 · gates 0/1 · stall 0/3 · stalls 0/2",
  ]);
  expect(admitted.tasks[0].blockedBy).toEqual([]);
  expect(values.some(value => value.tasks.some((task: any) => task.id === "change1" && task.status === "completed" && task.subject.endsWith("gates 1/1 · stall 0/3 · stalls 0/2") && !task.subject.includes("metric")))).toBe(true);
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

test.each(["missing selection", "missing focused gates"])("execute todo cancels Plan without draft rows on %s", async mode => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director") {
      if (mode === "missing selection") { result.structuredOutput.select = "missing"; result.structuredOutput.reason = "Decision needed\nChoose scope"; }
      else result.structuredOutput.changes[0].task.gates = [];
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
      status: "continue", remaining: ["Finish the assigned check"] });
    return normal();
  });
  expect((await host.execute()).status).toBe("complete");
  expect(snapshots(host).some(value => value.active?.attempt === 2 && value.tasks[0].subject.includes("(intento 2)"))).toBe(true);
});

test("execute todo renders saved metric series, gate receipts and stall through continuation", async () => {
  const host = fixture(); host.setLimit(1);
  let gates = 0;
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director") {
      const task = result.structuredOutput.changes[0].task;
      task.metric = {command:"echo 8",unit:"remaining",target:0};
      task.gates = Array.from({length:5}, (_,index)=>({...task.gates[0],id:`focused-${index}`}));
      task.progress.last5 = [{value:18,best:18,fingerprint:"0".repeat(64),gatesPassed:0,gatesTotal:5}];
    }
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "gate" && gates++ === 0) {
      const receipt = JSON.parse(result.output!);
      receipt.metric = {value:8,error:null};
      receipt.gates.forEach((gate: any,index: number)=>{gate.status=index<3?"pass":"fail";gate.exit=index<3?0:1;});
      receipt.progress = {nonImproving:1,last5:[
        {value:18,best:8,fingerprint:receipt.before.fingerprint,gatesPassed:0,gatesTotal:5},
        {value:8,best:8,fingerprint:receipt.after.fingerprint,gatesPassed:3,gatesTotal:5},
      ]};
      result.output = JSON.stringify(receipt);
    }
    return result;
  });
  await host.execute();
  const rows = snapshots(host).flatMap(value=>value.tasks);
  expect(rows.some(task=>task.subject.endsWith("metric 18→8/0 · gates 3/5 · stall 1/3 · stalls 0/2"))).toBe(true);
  expect(rows.some(task=>task.subject.includes("(intento 2) · paths 0 · metric 18→8/0 · gates 3/5 · stall 1/3 · stalls 0/2"))).toBe(true);
});


test("legacy selected tasks use their ID in todo subjects and worker labels", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "apply") {
      const receipt = JSON.parse(result.output!);
      if (receipt.selected) { delete receipt.selected.title; result.output = JSON.stringify(receipt); }
    }
    if (request.agent === "pitako.worker") {
      expect(request.label).toBe("change1");
      expect(snapshots(host).at(-1).tasks[0].subject).toBe("change1 (intento 1) · paths 0 · gates 0/1 · stall 0/3 · stalls 0/2");
      expect(request.task).toContain('"goal":"Goal change1"');
    }
    return result;
  });
  expect((await host.execute()).status).toBe("complete");
});

test("director requires capped titles and workflow-generated final gaps have deterministic titles", async () => {
  const host = fixture(undefined, { taskCount: 0, readOnly: true }); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director") {
      const schema = request.outputSchema.properties.changes.items.anyOf[0].properties.task;
      expect(schema.required).toContain("title");
      expect(schema.properties.title).toEqual({ type: "string", minLength: 1, maxLength: 80 });
      result.structuredOutput.acceptance[0].command = "false";
    }
    return result;
  });
  await host.execute();
  const tasks = readBacklog(host.root, "spec").backlog!.tasks;
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ title: "final acceptance gap 1", origin: { kind: "final-phase" } });
});
