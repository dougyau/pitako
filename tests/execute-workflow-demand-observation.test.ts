import { expect, test } from "bun:test";
import { executeControllerFixture, gaps, cutAt } from "./fixtures/execute-workflow.ts";

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
    ? !!value.loop.demandObservation : value.loop.plan?.stage === "published"));
  const first = await host.executeNative();
  expect(first.status).toBe("partial");
  expect(first.reason).toContain("Essential persistence failed");
  const retained = host.current().loop;
  expect(retained.analysisCalls.find((call: any) => call.key === target)).toMatchObject({ stage: "receipt",
    ref: { runId: `native-${target}`, outputReference: `/native/output/${target}.json` } });
  if (cut === "observation-receipt") {
    expect(retained.demandObservation).toBeUndefined();
    expect(retained.plan).toBeNull();
  } else expect(retained.plan).toMatchObject({ stage: "intention", ref: { key: "invoke-human-1.l2.director" } });
  host.setFailSave();
  const outcome = await host.executeNative();
  expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
  expect(host.calls.filter(call => call.key === target)).toHaveLength(1);
  expect(host.calls.filter(call => call.key === "invoke-human-1.l2.director")).toHaveLength(1);
  expect(host.statusCalls).toContain(cut === "observation-receipt" ? `native-${target}` : "invoke-human-1.l2.director");
});
