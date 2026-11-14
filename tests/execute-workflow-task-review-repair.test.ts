import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { readBacklog } from "../skills/execute/loop.ts";
import { digest } from "../extensions/spec-plans.ts";
import { executeControllerFixture, type Result } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
function reject(result: Result, conflict = false) {
  Object.assign(result.structuredOutput, {
    correctness: { verdict: "Unfinished required path", score: 8, findings: [{
      summary: "Required error path remains broken", evidence: "src/change1.ts:1",
      introducedByDelta: false, affectsTask: true,
    }] },
    conflict, remaining: ["Fix the required error path"], diagnosis: "Synthesis diagnosis",
    revival: "Repair the source-evidenced error path",
  });
  writeFileSync(result.results![0]!.savedOutputPath!, JSON.stringify(result.structuredOutput));
  return result;
}

test.each(["admit", "reject", "gate-failure", "incomplete", "conflict", "stalled"])(
  "one same-slot repair: %s", async outcome => {
    const host = fixture(); host.setLimit(1);
    let workers = 0, reviews = 0;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.agent === "pitako.worker") {
        workers++;
        if (workers === 2 && outcome === "incomplete") {
          result.structuredOutput.status = "continue";
          result.structuredOutput.remaining = ["Still incomplete"];
        }
      }
      if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "gate") {
        const receipt = JSON.parse(result.output!);
        if (workers === 2 && outcome === "gate-failure") {
          receipt.gates[0].status = "fail"; receipt.gates[0].exit = 1;
          receipt.gates[0].tail = "Repair assertion failed";
        }
        if (workers === 1 && outcome === "stalled") {
          receipt.stalled = true; receipt.progress.nonImproving = 3;
        }
        result.output = JSON.stringify(receipt);
      }
      if (request.key.endsWith(".task-synthesis")) {
        reviews++;
        if (reviews === 1 || outcome === "reject") reject(result, outcome === "conflict");
      }
      return result;
    });
    const output = await host.execute();
    expect(output.status, output.reason).toBe("partial");
    const admitted = outcome === "admit" || outcome === "stalled";
    expect(workers).toBe(outcome === "conflict" ? 1 : 2);
    expect(reviews).toBe(["gate-failure", "incomplete", "conflict"].includes(outcome) ? 1 : 2);
    const task = readBacklog(host.root, "spec").backlog!.tasks[0]!;
    expect(task.status).toBe(admitted ? "done" : "pending");
    expect(host.current().consumedLoops).toBe(1);
    expect(host.current().tasks.change1.completed === null).toBe(!admitted);
    const seals = host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind);
    expect(seals).toEqual(outcome === "conflict" ? ["pause"] : ["pause", admitted ? "unit" : "pause"]);
    if (outcome !== "conflict") {
      const repair = host.launches.filter(call => call.agent === "pitako.worker")[1]!;
      expect(repair.key).toBe("invoke-human-1.l1.t1.a2");
      expect(repair.task).toContain("Required error path remains broken");
      expect(repair.task).toContain("invoke-human-1.l1.t1.a1.task-synthesis.json");
      expect(repair.task).toContain("Synthesis diagnosis");
      expect(repair.task).toContain("Repair the source-evidenced error path");
      expect(host.calls.some(call => call.key === "invoke-human-1.l1.t1.a2.baseline")).toBe(true);
    }
    if (!admitted) {
      expect(host.history()[0].outcome).toBe("gaps");
      expect(host.snapshots.some(value => value.taskFrame?.reviewRepair?.exhausted)).toBe(true);
      expect(host.current().lastConfirmed?.kind).not.toBe("unit");
      if (outcome === "gate-failure") {
        const diagnosis = host.history()[0].results.at(-1).diagnosis;
        expect(diagnosis).toContain("change1-check: fail");
        expect(diagnosis).toContain("Required error path remains broken");
      }
    }
    if (reviews === 2) {
      const brief = host.launches.find(call => call.key === "invoke-human-1.l1.t1.a2.task-reviewer")!.task;
      expect(brief).toContain("verify every prior blocking finding is closed");
      expect(brief).toContain("Required error path remains broken");
      expect(brief).toContain('"src/change1.ts"');
    }
  },
);

test.each([false, true])("carried task inheritance requires evidenced provenance: %s", async predatesTask => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director")
      result.structuredOutput.changes[0].task.remaining = "Earlier-loop partial work";
    if (request.key.endsWith(".task-synthesis")) {
      result.structuredOutput.scope = { verdict: "Inherited issue", score: 9, findings: [{
        summary: "Pre-existing unrelated issue", introducedByDelta: false, affectsTask: false,
        predatesTask, evidence: predatesTask ? "Authenticated baseline before task" : "Provenance unknown",
      }] };
      writeFileSync(result.results![0]!.savedOutputPath!, JSON.stringify(result.structuredOutput));
    }
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(host.launches.find(call => call.key.endsWith(".task-reviewer"))!.task).toContain("carried: true");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe(predatesTask ? "done" : "pending");
});

test("saved rejection survives a result-save cut without renewing the repair", async () => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key.endsWith(".task-synthesis")) reject(result);
    return result;
  });
  host.setFailSave(value => value.loop?.attempt?.number === 1 && value.loop.attempt.stage === "result");
  await host.execute();
  expect(host.current().taskFrame.reviewProjections[host.current().loop.attempt.taskReview.synthesis.key].admitted).toBe(false);
  expect(host.current().taskFrame.reviewRepair.exhausted).toBe(false);
  host.setFailSave();
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(host.launches.filter(call => call.key.endsWith(".task-synthesis")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.task-synthesis", "invoke-human-1.l1.t1.a2.task-synthesis"]);
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(2);
  expect(host.current().tasks.change1.completed).toBeNull();
  expect(host.history()[0].outcome).toBe("gaps");
});

test("interrupted repair fallback retains the single repair allowance", async () => {
  // This asserts repair accounting, not restored bytes; checkpoint-sealer's
  // never-closed-effect case retains the real restoring-worker integration.
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    const descriptor = host.current().loop?.attempt;
    if (request.agent === "pitako.checkpoint-sealer" && descriptor.restore) {
      const manifest = descriptor.restore.observations[0].manifest;
      const directory = manifest.replace(/\/manifest\.json$/, "");
      const observed = JSON.parse(result.output!);
      observed.restored = { checkpointRef: manifest, digest: digest(descriptor.key),
        partialRef: `${directory}/restore.json`, restoredRef: `${directory}/restored.json`,
        position: { loop: 1, cursor: 0, phase: "implementation" }, candidate: host.observedCandidate() };
      for (const field of ["confirmedPause", "confirmedUnit"]) {
        const confirmed = descriptor.restore.authority[field];
        if (confirmed?.checkpointRef.startsWith(directory + "/"))
          observed.restored[field] = { checkpointRef: confirmed.checkpointRef, digest: confirmed.digest };
      }
      result.output = JSON.stringify(observed);
    }
    if (request.key.endsWith(".task-synthesis")) reject(result);
    return result;
  });
  host.setFailSave(value => value.loop?.attempt?.number === 2 && !!value.loop.attempt.launch);
  await host.execute();
  expect(host.current().taskFrame.reviewRepair.attempt).toBe(2);
  host.setFailSave();
  host.setStatus(ref => ref.includes(".t1.a2")
    ? { ok: false, interrupted: true, results: [] } : host.native.get(ref)!);
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2", "invoke-human-1.l1.t1.a3"]);
  expect(host.launches.filter(call => call.key.endsWith(".task-synthesis")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1.task-synthesis", "invoke-human-1.l1.t1.a3.task-synthesis"]);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
  expect(host.current().tasks.change1.completed).toBeNull();
  expect(host.current().lastConfirmed.kind).toBe("pause");
  expect(host.current().consumedLoops).toBe(1);
  expect(host.history()[0].outcome).toBe("gaps");
  host.expectProcessBudget(2); // Measured zero, plus two.
});
