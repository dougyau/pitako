import { expect, test } from "bun:test";
import { executeControllerFixture, gaps, cutAt, copy, type ControllerHost } from "./fixtures/execute-workflow.ts";
import { MISSION_STATE_MAX_BYTES } from "../node_modules/pi-subagents/src/missions/workflow-state.js";

const { fixture } = executeControllerFixture();

test.each(["compliance", "review"])("%s gaps reaches a fresh read-only reviewer before the next director", async source => {
  const host = fixture(undefined, { taskCount: 0, findings: source === "review" });
  host.setRespond((request, normal) => {
    if (source === "compliance" && request.key === "invoke-human-1.l1.compliance") return gaps(normal());
    if (source === "review" && request.key === "invoke-human-1.l1.review.director-synthesis") {
      const result = normal();
      result.structuredOutput.screening.verdict = "material-gaps";
      result.structuredOutput.screening.reason = "Required parser branch missing";
      result.structuredOutput.screening.assessments.forEach((entry: any) => { entry.material = true; });
      return result;
    }
    if (request.key.endsWith(".demand-observation")) {
      expect(host.current().loop.plan).toBeNull();
      expect(request).toMatchObject({ agent: "pitako.reviewer", context: "fresh", phase: "director",
        skill: ["verify-behavior", "scope-discipline"] });
      expect(request).not.toHaveProperty("model");
      expect(request.task).toContain(`"kind":"${source}"`);
      expect(request.task).toContain(source === "compliance"
        ? '"key":"invoke-human-1.l1.compliance"' : '"key":"invoke-human-1.l1.review.director-synthesis"');
    }
    if (request.key === "invoke-human-1.l2.director") {
      expect(request.skill).toContain("scope-discipline");
      expect(request.task).toContain('"memo":"Advisory only"');
    }
    return normal();
  });
  expect((await host.execute()).status).toBe("complete");
  const keys = host.calls.map(call => call.key);
  expect(keys.filter(key => key.endsWith(".demand-observation"))).toEqual(["invoke-human-1.l2.demand-observation"]);
  expect(keys.indexOf("invoke-human-1.l2.demand-observation")).toBeLessThan(keys.indexOf("invoke-human-1.l2.director"));
  const worker = host.calls.find(call => call.key === "invoke-human-1.l2.t1.a1")!;
  expect(worker.agent).toBe("pitako.worker");
  expect(worker.skill).toContain("scope-discipline");
  expect(worker.task).toContain("The workflow runs the metric and gates");
  expect(worker.task).not.toContain("FROZEN ATTEMPT");
});

test.each(["first-loop", "rejected-plan"])("%s alone dispatches no observation", async mode => {
  const host = fixture();
  host.setRespond((request, normal) => {
    const result = normal();
    if (mode === "rejected-plan" && request.key === "invoke-human-1.l1.director") result.structuredOutput.select = "missing";
    return result;
  });
  expect((await host.execute()).status).toBe("complete");
  expect(host.calls.some(call => call.key.endsWith(".demand-observation"))).toBe(false);
  if (mode === "rejected-plan")
    expect(host.calls.filter(call => call.key.startsWith("invoke-human-1.l1.director")).map(call => call.key))
      .toEqual(["invoke-human-1.l1.director", "invoke-human-1.l1.director.d1"]);
});

test.each(["rejected-report", "unusable-failure", "candidate-change"])("%s gaps alone dispatches no observation", async mode => {
  const host = fixture(undefined, { readOnly: true });
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const result = normal();
      if (mode === "rejected-report") result.structuredOutput.status = "invalid";
      if (mode === "unusable-failure") delete result.structuredOutput.work;
      return result;
    }
    if (mode === "candidate-change" && request.key === "invoke-human-1.l1.checkout") host.changeCheckout();
    return normal();
  });
  const outcome = await host.executeNative();
  expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
  expect(host.history()[0].outcome).toBe("gaps");
  expect(host.calls.filter(call => call.key === "invoke-human-1.l2.director")).toHaveLength(1);
  expect(host.calls.some(call => call.key.endsWith(".demand-observation"))).toBe(false);
});

test.each(["stopped", "permission", "technical"])("demand observation preserves native %s route without director dispatch", async mode => {
  const host = fixture(undefined, { taskCount: 0 });
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.compliance") return gaps(normal());
    if (request.key.endsWith(".demand-observation")) {
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      if (mode === "stopped") return { ...normal(), ok: false, stopped: true };
      return { ...normal(), ok: false, error: "Controlled technical failure", structuredOutput: undefined };
    }
    return normal();
  });
  expect((await host.execute()).status).toBe(mode === "stopped" ? "cancelled" : "blocked");
  expect(host.calls.some(call => call.key === "invoke-human-1.l2.director")).toBe(false);
  expect(host.calls.filter(call => call.key.endsWith(".demand-observation"))).toHaveLength(1);
});

// Empty remaining lists must not erase the causal diagnosis of unfinished work.
test.each(["gaps", "continue"])("unfinished worker %s with no remaining entries triggers one observation", async status => {
  const host = fixture(undefined, { readOnly: true, controlledCheckpoints: true });
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker" && request.key.startsWith("invoke-human-1.l1.t1.")) return host.result(request, {
      ...host.worker(request), status, remaining: [],
      work: "Required parser branch is still missing",
      continuation: { mode: "fresh", reason: "Implement the missing parser branch" },
    });
    if (request.key.endsWith(".demand-observation")) {
      expect(request.task).toContain("Three consecutive non-improving attempts");
    }
    const result = normal();
    if (request.key === "invoke-human-1.l2.director")
      result.structuredOutput.changes.push({ kind: "update", id: "change1",
        patch: { expectedResult: "Implement the missing parser branch" },
        reason: "Narrow the stalled task to the parser branch identified by the worker" });
    return result;
  });
  const outcome = await host.executeNative();
  expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
  const keys = host.calls.map(call => call.key);
  expect(keys.filter(key => key.endsWith(".demand-observation"))).toEqual(["invoke-human-1.l2.demand-observation"]);
  expect(keys.indexOf("invoke-human-1.l2.demand-observation")).toBeLessThan(keys.indexOf("invoke-human-1.l2.director"));
  expect(host.history()[0].outcome).toBe("gaps");
  expect(host.native.get("invoke-human-1.l1.t1.a1")!.structuredOutput).toMatchObject({ status, remaining: [] });
});

test("an intermediate continuation completed in the same loop creates no demand observation", async () => {
  const host = fixture();
  host.setRespond((request, normal) => request.key === "invoke-human-1.l1.t1.a1" ? host.result(request, {
    ...host.worker(request, "pause"), status: "continue", remaining: ["Implement the missing parser branch"],
    diagnosis: "Required parser branch is still missing", continuation: { mode: "fresh", reason: "Implement the missing parser branch" },
  }) : normal());
  const outcome = await host.executeNative();
  expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
  expect(host.calls.filter(call => call.agent === "pitako.worker" && call.key.startsWith("invoke-human-1.l1.t1.")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
  expect(host.calls.some(call => call.key.endsWith(".demand-observation"))).toBe(false);
  expect(host.history()).toHaveLength(2);
});

test.each(["observation-receipt", "director-intention"])("%s cut recovers the existing producer without another observation", async cut => {
  const host = fixture(undefined, { taskCount: 0 }), target = "invoke-human-1.l2.demand-observation";
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.compliance") return gaps(normal());
    if (request.key === "invoke-human-1.l2.director") expect(request.task).toContain('"memo":"Advisory only"');
    return normal();
  });
  cutAt(host, value => value.loop?.number === 2 && (cut === "observation-receipt"
    ? value.demandObservations?.some((item: any) => item.loop === 2) : value.loop.plan?.stage === "published"));
  const first = await host.executeNative();
  expect(first.status).toBe("partial");
  expect(first.reason).toContain("Essential persistence failed");
  const retained = host.current().loop;
  expect(retained.analysisCalls.find((call: any) => call.key === target)).toMatchObject({ stage: "receipt",
    ref: { runId: `native-${target}`, outputReference: `/native/output/${target}.json` } });
  if (cut === "observation-receipt") {
    expect(host.current().demandObservations ?? []).toEqual([]);
    expect(retained.plan).toBeNull();
  } else expect(retained.plan).toMatchObject({ stage: "intention", ref: { key: "invoke-human-1.l2.director" } });
  host.setFailSave();
  const outcome = await host.executeNative();
  expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
  expect(host.calls.filter(call => call.key === target)).toHaveLength(1);
  expect(host.calls.filter(call => call.key === "invoke-human-1.l2.director")).toHaveLength(1);
  expect(host.statusCalls).toContain(cut === "observation-receipt" ? `native-${target}` : "invoke-human-1.l2.director");
});

const synthesis = (number: number) => `invoke-human-1.l${number}.review.director-synthesis`;
// Final loops report material gaps; the intervening task loops repair them.
function materialReviewGaps(host: ControllerHost, acceptance?: any) {
  host.setRespond((request, normal) => {
    const result = normal();
    if (acceptance && request.phase?.startsWith("review-")) result.results = result.results!.map(entry => ({ ...entry, acceptance }));
    if (request.key.endsWith(".review.director-synthesis")) {
      result.structuredOutput.screening.verdict = "material-gaps";
      result.structuredOutput.screening.reason = "Required parser branch missing";
      result.structuredOutput.screening.assessments.forEach((entry: any) => { entry.material = true; });
    }
    return result;
  });
}

test("closed demand sources persist once while observations keep every retained original", async () => {
  const host = fixture(undefined, { taskCount: 0, findings: true, angles: 3, controlledCheckpoints: true }); host.setLimit(9);
  // Realistic review witnesses: each child reference carries a sizeable native acceptance record.
  materialReviewGaps(host, { status: "not-required", evidenceStatus: "not-required", explicit: false, criteria: [],
    inferredReason: ["x".repeat(2000)], runtimeChecks: [], verifyRuns: [] });
  const saves: { value: string; loop: number; bytes: number }[] = [];
  host.setSaveObserver((value, bytes) => { if (value.loop) saves.push({ value: JSON.stringify(value), loop: value.loop.number, bytes }); });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  const observations = host.calls.filter(call => call.key.endsWith(".demand-observation"));
  expect(observations.map(call => call.key)).toEqual([2, 4, 6, 8].map(number => `invoke-human-1.l${number}.demand-observation`));
  for (const call of observations) {
    const number = Number(call.key.match(/\.l(\d+)\./)![1]);
    const [fresh, previous] = call.task.split("NEW CAUSAL SOURCES (exact original references): ")[1]!.split("\nPREVIOUS OBSERVATIONS AND ORIGINALS: ");
    expect(fresh).toContain(synthesis(number - 1));
    // The three-entry history still delivers each earlier observation with its exact causal originals.
    for (const earlier of [2, 4, 6, 8].filter(earlier => earlier < number && earlier >= number - 6)) {
      expect(previous).toContain(`native-invoke-human-1.l${earlier}.demand-observation`);
      expect(previous).toContain(synthesis(earlier - 1));
    }
  }
  for (const save of saves) {
    const sources = JSON.parse(save.value).demandSources ?? [];
    expect(new Set(sources.map((item: any) => item.loop)).size).toBe(sources.length);
    for (const entry of sources) for (const original of entry.sources)
      expect(save.value.split(JSON.stringify(original)).length - 1, `loop ${save.loop} copies of loop ${entry.loop}`).toBe(1);
  }
  const maximum = (from: number, to: number) => Math.max(...saves.filter(save => save.loop >= from && save.loop <= to).map(save => save.bytes));
  expect(maximum(8, 9)).toBeLessThanOrEqual(maximum(6, 7) + 4096);
  // Full v6 task definitions and the bounded demand ring fit the native envelope.
  expect(maximum(1, 9)).toBeLessThan(MISSION_STATE_MAX_BYTES);
});
