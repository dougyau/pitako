import { describe, expect, test } from "bun:test";
import { executeControllerFixture, copy, closedInterruptedProducer, cutAt, type Result, removeCache } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();

describe("workflow-owned execute controller", () => {
  // Reject treating terminal-looking prose/labels as settlement, laundering a
  // different producer, or spending the same authorization after a new Stop.
  test.each(["missing", "terminal-missing", "run-conflict", "key-conflict", "active", "inspector-stop", "inspector-permission", "inspector-pending"])(
    "interrupted-operation observation preserves %s barrier and original", async mode => {
      const host = fixture(undefined, { readOnly: true }), target = "invoke-human-1.l1.t1.a1";
      host.setRespond((request, normal) => request.key === target ? closedInterruptedProducer(normal()) : normal());
      expect((await host.executeNative()).status).toBe("cancelled");
      const original = copy(host.native.get(target)!);
      host.setStatus(ref => ref === target || ref === `native-${target}`
        ? { ok: false, output: "Exact inventory unavailable", results: [] } : copy(host.native.get(ref)!));
      host.setRespond((request, normal) => {
        if (request.agent !== "pitako.execution-inspector") return normal();
        if (mode === "inspector-permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
        const receipt = copy(original);
        if (mode === "terminal-missing") { delete receipt.results; receipt.state = "completed"; }
        if (mode === "run-conflict") receipt.runId = "different-producer";
        if (mode === "key-conflict") receipt.key = "different-operation";
        if (mode === "active") receipt.state = "running";
        return { ...host.result(request, { status: mode === "missing" ? "unresolved" : "recovered",
          reason: "Controlled exact observation", original: mode === "missing" ? null : receipt, workerResult: null,
          originalAvailable: mode !== "missing", binding: "absent", comparison: mode === "missing" ? "neither" : "only-original",
          provenance: [original.outputReference] }),
          ...(mode === "inspector-stop" ? { ok: false, stopped: true } : {}),
          ...(mode === "inspector-pending" ? { state: "running" } : {}) };
      });
      const input = { unblock: true, resolution: { loop: 1, text: "Continue only after exact reconciliation under current policy." } };
      expect((await host.executeNative(input)).status).not.toBe("complete");
      const count = host.calls.length;
      expect(host.history()).toHaveLength(1);
      host.setRespond((_request, normal) => normal());
      expect((await host.executeNative()).status).not.toBe("complete");
      expect(host.calls).toHaveLength(count);
      expect(host.native.get(target)).toEqual(original);
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    });

  test.each(["intention", "observation", "admission", "next-slot"])(
    "interrupted-operation %s cut reconciles exactly one observer and ordinary slot", async cut => {
      const host = fixture(undefined, { readOnly: true }), target = "invoke-human-1.l1.t1.a1";
      host.setRespond((request, normal) => request.key === target ? closedInterruptedProducer(normal()) : normal());
      expect((await host.executeNative()).status).toBe("cancelled");
      const original = copy(host.native.get(target)!);
      host.setStatus(ref => ref === target || ref === `native-${target}`
        ? { ok: false, output: "Exact inventory unavailable", results: [] } : copy(host.native.get(ref)!));
      host.setRespond((request, normal) => request.agent === "pitako.execution-inspector"
        ? host.result(request, { status: "recovered", reason: "Read original complete settled native receipt at exact retained output ref",
          original, workerResult: null, originalAvailable: true, binding: "absent", comparison: "only-original", provenance: [original.outputReference] })
        : normal());
      cutAt(host, value => {
        const recovery = value.loop?.recoveries?.find((entry: any) => entry.subject === `interrupted-operation:${target}`);
        return cut === "intention" ? recovery?.stage === "intention"
          : cut === "observation" ? recovery?.stage === "observed"
          : cut === "admission" ? value.loop?.resolutions?.[0]?.stage === "applied" : value.consumedLoops === 2;
      });
      const input = { unblock: true, resolution: { loop: 1, text: "Continue pending work using current authority and existing slots." } };
      const first = await host.executeNative(input);
      expect(first.status).not.toBe("complete");
      expect(first.reason).toContain("Essential persistence failed");
      host.setFailSave();
      expect((await host.executeNative()).status).toBe("complete");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(1);
      expect(host.calls.filter(call => call.key.endsWith(".director"))).toHaveLength(2);
      expect(host.history()).toHaveLength(2);
      expect(host.history()[0].resolutions).toHaveLength(1);
      expect(host.history()[0].resolutions[0]).toMatchObject({ stage: "applied" });
      expect(host.native.get(target)).toEqual(original);
    });

  // Reject blind keyed redispatch: the second responder would turn a retained
  // barrier into fulfillment, so absence of new calls is the observable guarantee.
  test.each(["review.director-prepare", "review.independent-angle1", "compliance"])(
    "retained analysis barrier at %s is observed before replay dispatch", async phase => {
      for (const mode of ["stop", "permission", "thrown-permission", "thrown-status-stop", "pending", "unknown"]) {
        const host = fixture();
        const target = `invoke-human-1.l1.${phase}`;
        host.setRespond((request, normal) => {
          const result = normal();
          if (request.key !== target) return result;
          if (mode === "thrown-permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
          return { ...result, ok: false, ...(mode.includes("stop") ? { stopped: true }
            : { error: "Blocked by pi-subagents permission rule: 'run' is denied." }) };
        });
        const first = await host.executeNative();
        expect(first.status).toBe(mode.includes("stop") ? "cancelled" : "blocked");
        expect(host.history()[0].analysisCalls.find((call: any) => call.key === target)).toMatchObject({ stage: "receipt" });
        const calls = host.calls.length, hosts = host.hostCalls.length;
        host.setRespond((_request, normal) => normal());
        if (mode === "thrown-status-stop") host.setStatus(ref => {
          if (ref === `native-${target}`) throw Error(`Status '${ref}' failed: Run: ${ref}\nState: stopped`);
          return copy(host.native.get(ref)!);
        });
        if (mode === "pending" || mode === "unknown") host.setStatus(ref =>
          ref === `native-${target}` ? mode === "pending" ? { ok: true, state: "running" } : { ok: true, output: "", results: [] }
            : copy(host.native.get(ref)!));
        const second = await host.executeNative();
        expect(second.status).toBe(mode.includes("stop") ? "cancelled" : "blocked");
        expect(host.calls).toHaveLength(calls);
        expect(host.hostCalls.slice(hosts)).not.toContain("inspect-1");
        expect(host.history()).toHaveLength(1);
        expect(host.statusCalls).toContain(mode === "thrown-permission" ? target : `native-${target}`);
      }
    });

  test.each(["review.director-prepare", "review.independent-angle1", "compliance"].flatMap(phase =>
    ["intention", "receipt", "phase"].map(cut => ({ phase, cut }))))("analysis $phase $cut persistence cut never blindly replaces a call", async ({ phase, cut }) => {
    const host = fixture(), target = `invoke-human-1.l1.${phase}`;
    cutAt(host, value => {
      const loop = value.loop, call = loop?.analysisCalls?.find((entry: any) => entry.key === target);
      return cut === "phase" ? loop?.phase === (phase === "compliance" ? "closing" : "compliance") : call?.stage === cut;
    });
    expect((await host.executeNative()).status).toBe("partial");
    const count = host.calls.filter(call => call.key === target).length;
    expect(count).toBe(cut === "intention" ? 0 : 1);
    host.setFailSave();
    const next = await host.executeNative();
    expect(next.status, JSON.stringify(next)).toBe("complete");
    expect(host.calls.filter(call => call.key === target)).toHaveLength(1);
    if (cut !== "intention") expect(host.statusCalls).toContain(cut === "receipt" ? target : `native-${target}`);
  });

  test.each(["intact", "producer-conflict"])("completed review references survive a phase cut: %s", async mode => {
    const host = fixture();
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.phase?.startsWith("review-")) Object.assign(result.results![0]!, {
        workflowKey: request.key, runId: result.runId, agent: "pitako.reviewer",
        state: "complete",
      });
      return result;
    });
    cutAt(host, value => value.loop?.phase === "closing");
    expect((await host.executeNative()).status).toBe("partial");
    host.setFailSave();
    const retained = host.current().loop;
    // The review projection owns full witnesses; the analysis journal keeps only call identity.
    for (const call of retained.analysisCalls.filter((entry: any) => entry.key.includes(".review.")))
      expect(Object.keys(call.ref).sort().join(",")).toBe("key,runId");
    const originals = copy(retained.review.references), count = host.calls.length;
    if (mode === "producer-conflict") {
      const ref = retained.review.references[0], actual = copy(host.native.get(ref.runId)!);
      ref.runId = "different-producer";
      host.setStatus(key => key === "different-producer" ? actual : copy(host.native.get(key)!));
    }
    const replay = await host.executeNative();
    expect(replay.status).toBe(mode === "intact" ? "complete" : "blocked");
    // Only the fixed closing observer may run; no review or other child is replaced.
    expect(host.calls.slice(count).map(call => call.agent)).toEqual(mode === "intact" ? ["pitako.checkout-observer"] : []);
    if (mode === "intact") {
      expect(host.history().at(-1).review.references).toEqual(originals);
      expect(host.statusCalls).toContain(originals[0].runId);
      for (const ref of replay.loopReport.verification.adversarial.references) {
        const witness = ref.results[0], actual = host.native.get(ref.runId)!.results![0];
        expect(witness.savedOutputPath).toBe(actual.savedOutputPath);
        expect(witness.outputReference).toEqual(actual.outputReference);
        expect(witness).toMatchObject({ workflowKey: ref.key, runId: ref.runId, agent: "pitako.reviewer",
          state: "complete" });
        expect(witness).not.toHaveProperty("terminalOutcome");
      }
    } else expect(replay.reason).toMatch(/producer conflicts with analysis identity/);
  });

  test("retained analysis intention without a settled producer cannot launch a replacement", async () => {
    const host = fixture();
    cutAt(host, value => value.loop?.analysisCalls?.some((call: any) => call.stage === "receipt"));
    expect((await host.executeNative()).status).toBe("partial");
    host.setFailSave();
    host.setStatus(() => ({ ok: true, output: "", results: [] }));
    const count = host.calls.length;
    expect((await host.executeNative()).status).toBe("blocked");
    expect(host.calls).toHaveLength(count);
    expect(host.history()).toHaveLength(1);
  });

  test("current exact settled analysis supersedes a historical Stop without relaunch", async () => {
    const host = fixture(), target = "invoke-human-1.l1.review.director-prepare";
    let settled: Result;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === target) { settled = copy(result); return { ...result, ok: false, stopped: true }; }
      return result;
    });
    expect((await host.executeNative()).status).toBe("cancelled");
    host.setRespond((_request, normal) => normal());
    host.setStatus(ref => ref === `native-${target}` ? copy(settled!) : copy(host.native.get(ref)!));
    expect((await host.executeNative()).status).toBe("complete");
    expect(host.calls.filter(call => call.key === target)).toHaveLength(1);
    expect(host.statusCalls).toContain(`native-${target}`);
  });

  test.each(["running", "unknown", "mismatched"])("retained analysis %s status never becomes success", async state => {
    const host = fixture(), target = "invoke-human-1.l1.compliance";
    host.setRespond((request, normal) => request.key === target ? { ...normal(), ok: false, stopped: true } : normal());
    expect((await host.executeNative()).status).toBe("cancelled");
    host.setRespond((_request, normal) => normal());
    host.setStatus(ref => ref !== `native-${target}` ? copy(host.native.get(ref)!) : state === "running"
      ? { ok: true, state: "running" } : state === "unknown" ? { ok: true, results: [], output: "" }
      : { ...copy(host.native.get(ref)!), ok: true, stopped: false, runId: "different-producer" });
    const count = host.calls.length;
    expect((await host.executeNative()).status).not.toBe("complete");
    expect(host.calls).toHaveLength(count);
    expect(host.hostCalls).not.toContain("inspect-1");
    expect(host.history()).toHaveLength(1);
  });

  test("a legacy analysis barrier without its failed call receipt stays uncertain across replays", async () => {
    const host = fixture();
    host.setRespond((request, normal) => {
      if (request.key.endsWith(".compliance")) throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      return normal();
    });
    expect((await host.executeNative()).status).toBe("blocked");
    delete host.current().loop.analysisCalls;
    host.setRespond((_request, normal) => normal());
    const count = host.calls.length;
    for (let replay = 0; replay < 2; replay++) expect((await host.executeNative()).status).toBe("blocked");
    expect(host.calls).toHaveLength(count);
    expect(host.history()).toHaveLength(1);
  });

  test.each(["review.director-prepare", "review.independent-angle1", "compliance"])(
    "native status exceptions at %s preserve their current barrier, not the old receipt", async phase => {
      for (const mode of ["stop", "permission"]) {
        const host = fixture(), target = `invoke-human-1.l1.${phase}`;
        // Persist an ordinary successful original but interrupt its receipt write.
        // There is no old Stop to accidentally satisfy the cancellation assertion.
        cutAt(host, value => value.loop?.analysisCalls?.some((call: any) =>
          call.key === target && call.stage === "receipt"));
        expect((await host.executeNative()).status).toBe("partial");
        host.setFailSave();
        host.setStatus(ref => {
          if (ref !== target) return copy(host.native.get(ref)!);
          if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
          // runWorkflowScript turns this actual management receipt into the
          // native `Status '<ref>' failed: ...` exception.
          return { ok: false, output: `Run: ${ref}\nState: stopped`, results: [] };
        });
        const count = host.calls.length;
        expect((await host.executeNative()).status).toBe(mode === "stop" ? "cancelled" : "blocked");
        expect(host.calls).toHaveLength(count);
        expect(host.history()).toHaveLength(1);
      }
    });
});

describe("workflow-owned execute controller", () => {
  // Read-only continuation still reconciles its exact query; it has no file
  // checkpoint to restore. Modifying recovery is covered by real checkpoint
  // composition below, and must not inherit this historical-query prerequisite.
  test.each(["loop-plan", "attempt-result", "interrupted-operation"].flatMap(subject =>
    ["unavailable", "closed", "complete"].flatMap(producer =>
      ["pending", "unknown", "conflict", "binding", "unresolved", "provenance", "invalid-value", "incomplete-value", "usable",
        ...(producer === "closed" && subject === "attempt-result" ? ["cache-missing", "scope", "rejected-observed-cut", "rejected-validated-cut", "rejected-applied-cut", "rejected-next-slot-cut"] : []),
        ...(producer === "closed" && subject === "interrupted-operation" ? ["key-only", "key-only-no-run"] : []),
        ...(producer === "closed" ? ["observed-cut", "validated-cut", "applied-cut", "next-slot-cut"] : [])].map(observation =>
        ({ subject, producer, observation })))))(
    "continuation reconciles retained $subject $observation before $producer producer effects", async ({ subject, producer, observation }) => {
      const host = fixture(undefined, { readOnly: true }), workerKey = "invoke-human-1.l1.t1.a1";
      const target = subject === "loop-plan" ? "invoke-human-1.l1.director" : workerKey;
      let complete: Result;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key === target) {
          complete = copy(result);
          return subject === "interrupted-operation" ? closedInterruptedProducer(result) : { ...result, structuredOutput: undefined };
        }
        if (request.agent === "pitako.execution-inspector")
          return { ...result, ok: false, stopped: true };
        return result;
      });
      if (subject === "interrupted-operation") {
        expect((await host.executeNative()).status).toBe("cancelled");
        host.setStatus(ref => ref === target || ref === `native-${target}`
          ? { ok: false, results: [] } : copy(host.native.get(ref)!));
        await host.executeNative({ unblock: true, resolution: { loop: 1, text: "First current request; observe exact interrupted receipt." } });
      } else expect((await host.executeNative()).status).toBe("cancelled");
      if (observation.startsWith("key-only")) {
        const recovery = host.history()[0].recoveries[0];
        recovery.ref = { key: recovery.ref.key }; // durable intention / native-return-before-receipt cut
      }
      const retained = copy(host.history()[0].recoveries[0]);
      const count = host.calls.length, original = copy(host.native.get(target)!);
      const receipt = host.result({ key: retained.ref.key, agent: "pitako.execution-inspector", task: "Exact retained observation" }, {
        status: observation === "unresolved" ? "unresolved" : "recovered", reason: "Exact retained observation, no repair authority",
        original: subject === "loop-plan" ? complete!.structuredOutput
          : subject === "interrupted-operation" ? closedInterruptedProducer(complete!) : null,
        workerResult: subject === "attempt-result" ? complete!.structuredOutput : null,
        originalAvailable: true, binding: "absent", comparison: "only-original", provenance: [complete!.outputReference],
      });
      if (observation === "pending") receipt.state = "running";
      if (observation === "unknown") { receipt.ok = false; delete receipt.structuredOutput; }
      if (observation === "conflict") receipt.runId = "different-inspector";
      if (observation === "key-only-no-run") delete receipt.runId;
      if (observation === "binding") receipt.output = JSON.stringify({ ...receipt.structuredOutput, reason: "Different full value" });
      if (observation === "provenance") receipt.structuredOutput.provenance = [];
      if (observation === "invalid-value") {
        if (subject === "loop-plan") receipt.structuredOutput.original.association.invocation = "different";
        else if (subject === "attempt-result") receipt.structuredOutput.workerResult.taskId = "different";
        else receipt.structuredOutput.original.runId = "different";
      }
      if (observation === "incomplete-value" || observation.startsWith("rejected-")) {
        if (subject === "loop-plan") receipt.structuredOutput.original.tasks = [];
        else if (subject === "attempt-result") receipt.structuredOutput.workerResult.checks = [];
        else { receipt.structuredOutput.original.ok = true; receipt.structuredOutput.original.results = []; }
      }
      if (observation === "cache-missing") removeCache(host);
      if (observation === "scope") Object.assign(receipt.structuredOutput.workerResult, {
        status: "blocked", diagnosis: "Required action exceeds the authorized scope; do not perform it.",
        remaining: ["Scope expansion is required for the concrete action."],
      });
      host.setStatus(ref => ref === retained.ref.runId || ref === retained.ref.key ? copy(receipt)
        : ref === target || ref === `native-${target}` ? producer === "closed" ? closedInterruptedProducer(complete!)
          : producer === "complete" ? copy(complete!) : { ok: false, results: [] }
        : copy(host.native.get(ref)!));
      host.setRespond((_request, normal) => normal());
      let observedWrites = 0;
      const cut = observation.replace("rejected-", "");
      if (observation.endsWith("-cut")) host.setFailSave(value => {
        if (value.activePlan) return false;
        const record = value.loop;
        if (record?.recoveries?.[0]?.stage === "observed") observedWrites++;
        return cut === "observed-cut" ? observedWrites === 1
          : cut === "validated-cut" ? observedWrites === 2
          : cut === "applied-cut" ? record?.resolutions?.at(-1)?.stage === "applied" : value.consumedLoops === 2;
      });
      let output = await host.execute({ unblock: true, resolution: { loop: 1, text: "Current request after reconciling every retained intention." } });
      if (observation.endsWith("-cut")) {
        expect(output.status).not.toBe("complete");
        expect(output.reason).toContain("Essential persistence failed");
        expect(host.calls.filter(call => call.agent !== "pitako.execution-ledger")).toHaveLength(count);
        host.setFailSave();
        output = await host.execute();
      }
      // An exact recovered report that breaks the result contract no longer
      // halts reconciliation: its loop ends as gaps and the next loop repairs it.
      const rejectedReport = subject === "attempt-result" && (observation === "incomplete-value" || observation.startsWith("rejected-"));
      const canContinue = (["usable", "cache-missing", "key-only"].includes(observation) || observation.endsWith("-cut") || rejectedReport) &&
        (producer === "closed" || producer === "unavailable" && subject === "interrupted-operation");
      if (canContinue) expect(output.status, JSON.stringify({ reason: output.reason, statuses: host.statusCalls, halt: host.history()[0].halt })).toBe("complete");
      else expect(output.status).not.toBe("complete");
      expect(host.statusCalls).toContain(retained.ref.runId ?? retained.ref.key);
      expect(host.calls.slice(count).every(call => canContinue && (call.key.startsWith("invoke-human-1.l2.") || call.key === "invoke-human-1.l1.gaps"))).toBe(true);
      expect(host.history()).toHaveLength(canContinue ? 2 : 1);
      // Its incomplete checks never attest the discharged loop.
      const recoveries = canContinue
        ? host.records().find((record: any) => record.kind === "loop" && record.loop === 1).body.recoveries
        : host.history()[0].recoveries;
      if (canContinue && rejectedReport) {
        const rejected = host.history()[0].results;
        expect(rejected).toHaveLength(1);
        expect(host.history()[0].outcome).toBe("gaps");
        const reason = "Worker result lacks planned check evidence or has duplicate check IDs.";
        expect(rejected[0]).toMatchObject({ status: "rejected", taskId: "change1", attempt: 1,
          rejection: reason, diagnosis: reason,
          ref: { ...retained.source, recovery: { ref: recoveries[0].ref, field: "structuredOutput.workerResult" } } });
        expect(rejected[0].candidate).toBeUndefined();
        expect(rejected[0].checks).toBeUndefined();
        expect(rejected[0].checkpoint?.confirmation).toBeUndefined();
        expect(host.current().lastConfirmed).toBeNull();
        const next = host.calls.slice(count).find(call => call.key === "invoke-human-1.l2.director");
        expect(next?.task).toContain(reason);
        expect(next?.task).toContain("CLOSED HISTORY REFERENCE");
        expect(host.records().find((record: any) => record.kind === "loop").body.results[0].ref.runId).toBe(retained.source.runId);
        expect(recoveries[0].ref.runId).toBe(retained.ref.runId);
        expect(next?.task).toContain(JSON.stringify(host.current().loopSummaries[0]));
      }
      expect(recoveries).toHaveLength(1);
      expect(recoveries[0]).toMatchObject({
        subject: retained.subject, phase: retained.phase, association: retained.association, source: retained.source,
        ref: { key: retained.ref.key, ...(retained.ref.runId ? { runId: retained.ref.runId } : {}) },
      });
      expect(host.native.get(target)).toEqual(original);
      const after = host.calls.length;
      await host.execute();
      expect(host.calls).toHaveLength(after);
    });
});
