import { expect, test } from "bun:test";
import { executeControllerFixture, gaps, cutAt, copy, type ControllerHost } from "./fixtures/execute-workflow.ts";
import { MISSION_STATE_MAX_BYTES } from "../node_modules/pi-subagents/src/missions/workflow-state.js";

const { fixture } = executeControllerFixture();

test.each(["compliance", "review"])("%s gaps reaches a fresh read-only reviewer before the next director", async source => {
  const host = fixture(undefined, { findings: source === "review" });
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
  const worker = host.calls.find(call => call.key === "invoke-human-1.l1.t1.a1")!;
  expect(worker.agent).toBe("pitako.worker");
  expect(worker.skill).toContain("scope-discipline");
  expect(worker.task).toContain("Use native tool output capture; do not add tee, redirection or another shell wrapper solely for logging.");
  expect(worker.task).toContain("Sufficient captured output belongs in output; logPaths may be [] when no additional log file is needed.");
});

test.each(["first-loop", "rejected-plan"])("%s alone dispatches no observation", async mode => {
  const host = fixture();
  host.setRespond((request, normal) => {
    const result = normal();
    if (mode === "rejected-plan" && request.key === "invoke-human-1.l1.director") result.structuredOutput.tasks = [];
    return result;
  });
  expect((await host.execute()).status).toBe("complete");
  expect(host.calls.some(call => call.key.endsWith(".demand-observation"))).toBe(false);
});

test.each(["rejected-report", "unusable-failure", "candidate-change"])("%s gaps alone dispatches no observation", async mode => {
  const host = fixture(undefined, { readOnly: true });
  host.setRespond((request, normal) => {
    if (request.key === "invoke-human-1.l1.t1.a1") {
      const result = normal();
      if (mode === "rejected-report") result.structuredOutput.checks[0].command += " --altered";
      if (mode === "unusable-failure") return { ...result, ok: false, structuredOutput: undefined };
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
  const host = fixture();
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
  const host = fixture(undefined, { readOnly: true });
  host.setRespond((request, normal) => {
    if (request.key.startsWith("invoke-human-1.l1.t1.")) return host.result(request, {
      ...host.worker(request), status, remaining: [],
      diagnosis: "Required parser branch is still missing", usefulProgress: status === "continue",
      continuation: status === "continue" ? "Implement the missing parser branch" : null,
    });
    if (request.key.endsWith(".demand-observation")) {
      expect(request.task).toContain("Required parser branch is still missing");
    }
    return normal();
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
    diagnosis: "Required parser branch is still missing", continuation: "Implement the missing parser branch",
  }) : normal());
  const outcome = await host.executeNative();
  expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
  expect(host.calls.filter(call => call.key.startsWith("invoke-human-1.l1.t1.")).map(call => call.key))
    .toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
  expect(host.calls.some(call => call.key.endsWith(".demand-observation"))).toBe(false);
  expect(host.history()).toHaveLength(1);
});

test.each(["observation-receipt", "director-intention"])("%s cut recovers the existing producer without another observation", async cut => {
  const host = fixture(), target = "invoke-human-1.l2.demand-observation";
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

const synthesis = (number: number) => `native-invoke-human-1.l${number}.review.director-synthesis`;
// Every loop's review screening reports material gaps, so each next loop observes demands.
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
  const host = fixture(undefined, { findings: true, angles: 3, readOnly: true }); host.setLimit(7);
  // Realistic review witnesses: each child reference carries a sizeable native acceptance record.
  materialReviewGaps(host, { status: "not-required", evidenceStatus: "not-required", explicit: false, criteria: [],
    inferredReason: ["x".repeat(2000)], runtimeChecks: [], verifyRuns: [] });
  const saves: { value: string; loop: number; bytes: number }[] = [];
  host.setSaveObserver((value, bytes) => { if (value.loop) saves.push({ value: JSON.stringify(value), loop: value.loop.number, bytes }); });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  const observations = host.calls.filter(call => call.key.endsWith(".demand-observation"));
  expect(observations.map(call => call.key)).toEqual([2, 3, 4, 5, 6, 7].map(number => `invoke-human-1.l${number}.demand-observation`));
  for (const call of observations) {
    const number = Number(call.key.match(/\.l(\d+)\./)![1]);
    const [fresh, previous] = call.task.split("NEW CAUSAL SOURCES (exact original references): ")[1]!.split("\nPREVIOUS OBSERVATIONS AND ORIGINALS: ");
    expect(fresh).toContain(synthesis(number - 1));
    // The three-entry history still delivers each earlier observation with its exact causal originals.
    for (let earlier = Math.max(2, number - 3); earlier < number; earlier++) {
      expect(previous).toContain(`native-invoke-human-1.l${earlier}.demand-observation`);
      expect(previous).toContain(synthesis(earlier - 1));
    }
  }
  for (const save of saves) for (let closed = 1; closed < save.loop; closed++)
    expect(save.value.split(`"${synthesis(closed)}"`).length - 1, `loop ${save.loop} copies of loop ${closed}`).toBeLessThanOrEqual(1);
  const maximum = (from: number, to: number) => Math.max(...saves.filter(save => save.loop >= from && save.loop <= to).map(save => save.bytes));
  expect(maximum(6, 7)).toBeLessThanOrEqual(maximum(4, 5) + 4096);
  // Half the native envelope stays free for real reports, paths and one long open loop.
  expect(maximum(1, 7)).toBeLessThan(MISSION_STATE_MAX_BYTES / 2);
});

test.each([false, true])("legacy triplicated demand state resumes once folded; conflicting copies=%s", async conflicting => {
  const host = fixture(undefined, { findings: true, readOnly: true }); host.setLimit(4);
  materialReviewGaps(host);
  cutAt(host, value => value.loop?.number === 3 && value.loop.plan?.stage === "published");
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  host.setFailSave();
  // Rebuild the pre-fix layout: loop N-1's sources copied into all three fields.
  const state = host.current(), sources = (number: number) => copy(state.demandSources.find((item: any) => item.loop === number).sources);
  expect(state.demandSources.map((item: any) => item.loop)).toEqual([1, 2]);
  state.closedDemandSources = { loop: 2, sources: sources(2) };
  state.demandObservations = state.demandObservations.map((item: any) => ({ ...item, sources: sources(item.loop - 1) }));
  state.loop.demandObservation = { ref: copy(state.demandObservations.at(-1).ref), sources: sources(2) };
  delete state.demandSources;
  if (conflicting) state.loop.demandObservation.sources[0].reason = "Altered copy";
  const legacy = copy(state), before = host.calls.length;
  const output = await host.execute();
  if (conflicting) {
    expect(output.reason).toContain("Legacy demand observation state is inconsistent (loop.demandObservation disagrees for loop 2)");
    expect(host.calls).toHaveLength(before);
    expect(host.current()).toEqual(legacy);
    return;
  }
  expect(output.status, output.reason).toBe("partial");
  const current = host.current();
  expect(current).not.toHaveProperty("closedDemandSources");
  expect(current.demandObservations.every((item: any) => !("sources" in item))).toBe(true);
  const observation = host.calls.find(call => call.key === "invoke-human-1.l4.demand-observation")!;
  expect(observation.task).toContain(JSON.stringify(legacy.closedDemandSources.sources));
  expect(observation.task).toContain(JSON.stringify(legacy.demandObservations.map(({ loop, ref, sources }: any) => ({ loop, ref, sources }))));
});
