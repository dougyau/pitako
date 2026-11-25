import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyCheckpoint, restoreCheckpoint, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { readExecuteIntentContext } from "../extensions/execute-intent.ts";
import { SPEC_SECTIONS } from "../extensions/spec-plans.ts";
import { inspect } from "../skills/execute/inspect.ts";
import { executeControllerFixture, copy, closedInterruptedProducer, cutAt, gaps, type Result } from "./fixtures/execute-workflow.ts";
import { gitFakeBootstrap } from "./fixtures/git-fake-env.ts";
const { executeStore } = await import("../skills/execute/ledger.mjs");

const { fixture } = executeControllerFixture();

function restoreAttempt(host: ReturnType<typeof fixture>) {
  const { intent, records } = readExecuteIntentContext(host.root, host.current());
  const baseline = [...records].reverse().find(row => row.kind === "operation" &&
    (row.body as { request?: { intent?: CheckpointIntent } }).request?.intent?.key === intent.key);
  const { restore } = (baseline?.body as { request: { continuation: { attempt: {
    restore: { sourceKeys: string[]; authority: Parameters<typeof restoreCheckpoint>[1] };
  } } } }).request.continuation.attempt;
  const sources = restore.sourceKeys.map(key => records.find(row =>
    row.kind === "intent" && (row.body as CheckpointIntent).key === key)!.body as CheckpointIntent);
  return restoreCheckpoint(sources, restore.authority);
}

describe("workflow-owned execute controller", () => {
  // Reject treating terminal-looking prose/labels as settlement, laundering a
  // different producer, or spending the same authorization after a new Stop.
  // Exercise read-only operations in a final loop, with no implementation pending.




  // Reject blind keyed redispatch: the second responder would turn a retained
  // barrier into fulfillment, so absence of new calls is the observable guarantee.
  test.each(["review.director-prepare", "review.independent-angle1-r1", "compliance"].flatMap(phase =>
    ["stop", "permission", "thrown-permission", "thrown-status-stop", "pending", "unknown"].map(mode => ({ phase, mode }))))(
    "retained analysis barrier at $phase ($mode) is observed before replay dispatch", async ({ phase, mode }) => {
      const host = fixture(undefined, { taskCount: 0 });
      const target = `invoke-human-1.l1.${phase}`;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key !== target) return result;
        if (mode === "thrown-permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
        return closedInterruptedProducer(result, mode.includes("stop") ? "stopped" : "permission");
      });
      const first = await host.executeNative();
      expect(first.status).toBe(mode.includes("stop") ? "cancelled" : "blocked");
      const retained = copy(host.current());
      expect(retained.action).toMatchObject({ kind: "launched", role: "reviewer", key: target });
      expect(retained.halt.digest).toMatch(/^[a-f0-9]{64}$/);
      const producer = retained.action.runId;
      const calls = host.calls.length, hosts = host.hostCalls.length;
      host.setRespond((_request, normal) => normal());
      if (mode === "thrown-status-stop") host.setStatus(ref => {
        if (ref === producer) throw Error(`Status '${ref}' failed: Run: ${ref}\nState: stopped`);
        return copy(host.native.get(ref)!);
      });
      if (mode === "pending" || mode === "unknown") host.setStatus(ref =>
        ref === producer ? mode === "pending" ? { ok: true, state: "running" } : { ok: true, output: "", results: [] }
          : copy(host.native.get(ref)!));
      const second = await host.executeNative();
      expect(second.status, second.reason).toBe(mode.includes("stop") ? "cancelled" : "blocked");
      expect(host.calls).toHaveLength(calls);
      expect(host.hostCalls.slice(hosts)).not.toContain("inspect-1");
      expect(host.current()).toEqual(retained);
      if (producer) expect(host.statusCalls).toContain(producer);
    });

  test.each(["review.director-prepare", "review.independent-angle1-r1", "compliance"].flatMap(phase =>
    ["intention", "receipt", "phase", ...(phase === "review.director-prepare" ? ["early-first", "gate-first"] : [])]
      .map(cut => ({ phase, cut }))))("analysis $phase $cut persistence cut never blindly replaces a call", async ({ phase, cut }) => {
    const host = fixture(undefined, { taskCount: 0 }), target = `invoke-human-1.l1.${phase}`;
    const gate = "invoke-human-1.l1.acceptance.gate";
    if (cut === "gate-first") {
      const launchCount = () => host.launches.filter(call => call.key === `${gate}.r1`).length;
      host.setFailSave(value => launchCount() === 0 && host.native.has(gate));
      expect((await host.executeNative()).status).toBe("partial");
      expect(host.current().action).toMatchObject({ kind: "pending", opKey: gate });
    }
    cutAt(host, value => {
      const slot = value.review?.slots.find((entry: any) => entry.key === target);
      if (cut === "phase") return value.loop?.phase === (phase === "compliance" ? "closing" : "compliance");
      if (cut === "intention") return value.action.key === target && value.action.runId === null;
      return (value.action.key === target && !!value.action.runId) || !!slot?.runId;
    });
    expect((await host.executeNative()).status).toBe("partial");
    const count = host.calls.filter(call => call.key === target).length;
    expect(count).toBe(cut === "intention" ? 0 : 1);
    host.setFailSave();
    if (cut === "early-first" || cut === "gate-first") {
      if (cut === "early-first") {
        const nextTarget = "invoke-human-1.l1.review.independent-angle1-r1";
        cutAt(host, value => value.action.key === nextTarget && !!value.action.runId ||
          value.review?.slots.some((slot: any) => slot.key === nextTarget && !!slot.runId));
        expect((await host.executeNative()).status).toBe("partial");
        expect(host.calls.filter(call => call.key === nextTarget)).toHaveLength(1);
        host.setFailSave();
      }
      const cursor = copy(host.current()), launches = copy(host.launches);
      expect(launches.filter(call => call.key === `${gate}.r1`)).toHaveLength(1);
      let writes = 0;
      host.setFailSave(() => { writes++; return false; });
      const blocked = await host.executeNative();
      expect(blocked.status, blocked.reason).toBe("blocked");
      expect(blocked.reason).toContain(`early-review-replay-gap: early-cut class B: ${gate}.r1`);
      expect(host.launches).toEqual(launches);
      expect(writes).toBe(0);
      expect(host.current()).toEqual(cursor);
      return;
    }
    const next = await host.executeNative();
    expect(next.status, next.reason).toBe("complete");
    expect(host.calls.filter(call => call.key === target)).toHaveLength(1);
    if (cut !== "intention") {
      const producer = cut === "phase" && phase !== "compliance"
        ? "invoke-human-1.l1.review.director-synthesis" : target;
      expect(host.statusCalls).toContain(host.native.get(producer)!.runId!);
    }
    if (phase !== "compliance") {
      const replay = cut === "phase" ? "invoke-human-1.l1.reviewOriginals.r1" : "invoke-human-1.l1.acceptance.gate.r1";
      expect(host.launches.filter(call => call.key.endsWith(".r1")).map(call => call.key)).toEqual([replay]);
    }
  });

  test("early demand recovery does not reuse an advance retry admitted for store-busy", async () => {
    const host = fixture(undefined, { taskCount: 0 });
    const advance = "invoke-human-1.l2.advance";
    const retryKey = `${advance}.r1`;
    const demand = "invoke-human-1.l2.demand-observation";
    host.setRespond((request, normal) =>
      request.key === "invoke-human-1.l1.compliance" ? gaps(normal()) : normal());
    host.setLaunchRespond(async (request, normal) => request.key === advance
      ? { ...host.result(request, {}), ok: false,
        output: JSON.stringify({ error: "loop-io", code: "store-busy", reason: "Store is locked" }) }
      : normal());
    cutAt(host, value => value.action.key === demand && !!value.action.runId);
    const first = await host.executeNative();
    expect(first.status).toBe("partial");
    expect(first.reason).toContain("Essential persistence failed");
    const cursor = copy(host.current()), launches = copy(host.launches);
    expect(cursor.action).toMatchObject({ kind: "launched", role: "reviewer", key: demand, runId: null });
    expect(host.native.get(demand)?.ok).toBe(true);
    expect(launches.filter(call => call.key === retryKey)).toHaveLength(1);
    let writes = 0;
    host.setFailSave(() => { writes++; return false; });
    host.setLaunchRespond();

    const blocked = await host.executeNative();
    expect(blocked.status, blocked.reason).toBe("blocked");
    expect(blocked.reason).toContain(`early-demand-replay-gap: early-cut class B: ${retryKey}`);
    expect(host.launches).toEqual(launches);
    expect(writes).toBe(0);
    expect(host.current()).toEqual(cursor);
  });

  test("early demand recovery lets the writer quarantine a cursor-ahead store", async () => {
    const spec = `---\npitako-spec: 1\nid: spec\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`;
    const host = fixture(spec, { taskCount: 0 });
    const demand = "invoke-human-1.l2.demand-observation", retry = "invoke-human-1.l2.advance.r1";
    host.setRespond((request, normal) =>
      request.key === "invoke-human-1.l1.compliance" ? gaps(normal()) : normal());
    cutAt(host, value => value.action.key === demand && !!value.action.runId);
    expect((await host.executeNative()).reason).toContain("Essential persistence failed");
    host.setFailSave();
    const { association } = host.admitted();
    const before = copy(host.current()), launches = host.launches.length, gates = host.gateExecutions();
    expect(before.action).toMatchObject({ kind: "launched", key: demand });
    expect(host.native.get(demand)?.ok).toBe(true);
    const ahead = { ...before, head: { seq: before.head.seq + 1, hash: "f".repeat(64) } };
    await host.state.set("pitako-execute", ahead);
    const observation = JSON.parse(await inspect([host.root, "spec", association.source, "admission",
      JSON.stringify({ ...association, amendments: [], admission: { sourceRefs: [], agentDir: host.root } })]));
    expect(observation.storeFailure?.code, JSON.stringify(observation)).toBe("cursor-ahead");
    host.setHostResponse((key, value) => key === "inspect-initial" ? observation : value);
    let quarantine: string | undefined;
    host.setLaunchRespond(async (request, normal) => {
      if (request.key === "invoke-human-1.e1.l3.director")
        throw new Error("Controlled cut after new epoch admission");
      if (request.key !== retry) return normal();
      const child = Bun.spawn([process.execPath, "--preload", gitFakeBootstrap, path.resolve("skills/execute/loop-io.mjs")], {
        cwd: host.root, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      child.stdin.write(request.task);
      child.stdin.end();
      const [output, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exit, stderr).toBe(1);
      const failure = JSON.parse(output);
      expect(failure.code, output).toBe("cursor-ahead");
      quarantine = failure.recovery?.quarantine;
      const native = host.result(request, {});
      return { ...native, ok: false, output, results: native.results!.map(item => ({ ...item, exitCode: exit })) };
    });

    const recovered = await host.executeNative();
    expect(quarantine && existsSync(quarantine), recovered.reason).toBe(true);
    expect(host.current(), recovered.reason).toMatchObject({
      epoch: 1, budget: { consumedLoops: before.budget.consumedLoops + 1, maxCycles: before.budget.maxCycles },
    });
    expect(host.current().storeId).not.toBe(before.storeId);
    expect(host.launches.slice(launches).filter(call => call.key.startsWith("invoke-human-1.l")).map(call => call.key))
      .toEqual([retry]);
    expect(host.gateExecutions()).toBe(gates);
  });

  test.each(["intact", "producer-conflict"])("completed review references survive a phase cut: %s", async mode => {
    const host = fixture(undefined, { taskCount: 0 });
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.phase?.startsWith("review-")) Object.assign(result.results![0]!, {
        workflowKey: request.key, runId: result.runId,
        state: "complete",
      });
      return result;
    });
    cutAt(host, value => value.loop?.phase === "closing");
    expect((await host.executeNative()).status).toBe("partial");
    host.setFailSave();
    const cursor = host.current(), { store, scope } = executeStore(host.root, cursor.invocation);
    const { records } = store.readRecords(scope, cursor.head);
    const publication = [...records].reverse().find(row => row.kind === "review-originals" &&
      Object.hasOwn(row.body as object, "archiveSeed"))!;
    const originals = copy((publication.body as { archiveSeed: { body: { review: { references: any[] } } } })
      .archiveSeed.body.review.references);
    const count = host.launches.length;
    if (mode === "producer-conflict") {
      const ref = cursor.action, actual = copy(host.native.get(ref.runId)!);
      host.setStatus(key => key === ref.runId ? { ...actual, runId: "different-producer" } : copy(host.native.get(key)!));
    }
    const replay = await host.executeNative();
    expect(replay.status).toBe(mode === "intact" ? "complete" : "blocked");
    expect(host.launches.slice(count).map(call => [call.agent, call.key])).toEqual(mode === "intact" ? [
      ["pitako.checkout-observer", "invoke-human-1.l1.checkout"],
      ["pitako.loop-drain", "invoke-human-1.l1.finishDrain"],
    ] : []);
    if (mode === "intact") {
      expect(host.history().at(-1).review.references).toEqual(originals);
      for (const ref of replay.loopReport.verification.adversarial.references) {
        const witness = ref.results[0], actual = host.native.get(ref.runId)!.results![0];
        expect(witness.savedOutputPath).toBe(actual.savedOutputPath);
        expect(witness.outputReference).toEqual(actual.outputReference);
        expect(ref).toMatchObject({ key: actual.workflowKey, runId: actual.runId, agent: host.native.get(ref.runId)!.agent });
        expect(witness.structuredOutputPath).toBe(actual.structuredOutputPath);
        expect(witness).not.toHaveProperty("terminalOutcome");
      }
    } else expect(replay.reason).toMatch(/producer.*integrity|producer identity/);
  });

  test("retained analysis intention without a settled producer cannot launch a replacement", async () => {
    const host = fixture(undefined, { taskCount: 0 });
    const key = "invoke-human-1.l1.review.director-prepare";
    cutAt(host, value => value.action.key === key && !!value.action.runId);
    expect((await host.executeNative()).status).toBe("partial");
    host.setFailSave();
    host.setStatus(() => ({ ok: true, output: "", results: [] }));
    const count = host.launches.length, cursor = copy(host.current());
    expect((await host.executeNative()).status).toBe("blocked");
    expect(host.launches.slice(count).map(call => call.key)).toEqual(["invoke-human-1.l1.acceptance.gate.r1"]);
    expect(host.current()).toEqual(cursor);
  });

  test("current apparent success cannot supersede a committed Stop", async () => {
    const host = fixture(undefined, { taskCount: 0 }), target = "invoke-human-1.l1.review.director-prepare";
    let settled: Result;
    host.setRespond((request, normal) => {
      const result = normal();
      if (request.key === target) { settled = copy(result); return closedInterruptedProducer(result); }
      return result;
    });
    expect((await host.executeNative()).status).toBe("cancelled");
    host.setRespond((_request, normal) => normal());
    const cursor = copy(host.current()), count = host.launches.length;
    host.setStatus(ref => ref === settled!.runId ? { ...copy(settled!), state: "complete" } : copy(host.native.get(ref)!));
    const replay = await host.executeNative();
    expect(replay.status).toBe("blocked");
    expect(replay.reason).toMatch(/integrity mismatch/);
    expect(host.calls.filter(call => call.key === target)).toHaveLength(1);
    expect(host.statusCalls).toContain(settled!.runId!);
    expect(host.launches).toHaveLength(count);
    expect(host.current()).toEqual(cursor);
  });

  test.each(["running", "unknown", "mismatched"])("retained analysis %s status never becomes success", async state => {
    const host = fixture(undefined, { taskCount: 0 }), target = "invoke-human-1.l1.compliance";
    host.setRespond((request, normal) => request.key === target ? closedInterruptedProducer(normal()) : normal());
    expect((await host.executeNative()).status).toBe("cancelled");
    host.setRespond((_request, normal) => normal());
    const cursor = copy(host.current());
    host.setStatus(ref => ref !== cursor.action.runId ? copy(host.native.get(ref)!) : state === "running"
      ? { ok: true, state: "running" } : state === "unknown" ? { ok: true, results: [], output: "" }
      : { ...copy(host.native.get(ref)!), ok: true, stopped: false, runId: "different-producer" });
    const count = host.calls.length;
    expect((await host.executeNative()).status).not.toBe("complete");
    expect(host.calls).toHaveLength(count);
    expect(host.hostCalls).not.toContain("inspect-1");
    expect(host.current()).toEqual(cursor);
  });

  test("a permission throw before a runId remains a bounded terminal halt", async () => {
    const host = fixture(undefined, { taskCount: 0 });
    host.setRespond((request, normal) => {
      if (request.key.endsWith(".compliance")) throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      return normal();
    });
    expect((await host.executeNative()).status).toBe("blocked");
    const cursor = copy(host.current());
    expect(cursor.action.runId).toBeNull();
    expect(cursor.halt.reason).toContain("native permission denial");
    host.setRespond((_request, normal) => normal());
    const count = host.calls.length;
    for (let replay = 0; replay < 2; replay++) expect((await host.executeNative()).status).toBe("blocked");
    expect(host.calls).toHaveLength(count);
    expect(host.current()).toEqual(cursor);
  });

  test.each(["review.director-prepare", "review.independent-angle1-r1", "compliance"])(
    "native status exceptions at %s preserve their current barrier, not the old receipt", async phase => {
      for (const mode of ["stop", "permission"]) {
        const host = fixture(undefined, { taskCount: 0 }), target = `invoke-human-1.l1.${phase}`;
        // Persist an ordinary successful original but interrupt its receipt write.
        // There is no old Stop to accidentally satisfy the cancellation assertion.
        cutAt(host, value => value.action.key === target && !!value.action.runId ||
          value.review?.slots.some((slot: any) => slot.key === target && !!slot.runId));
        expect((await host.executeNative()).status).toBe("partial");
        host.setFailSave();
        host.setStatus(ref => {
          if (![target, host.native.get(target)?.runId].includes(ref)) {
            const observed = host.native.get(ref);
            return observed ? { ...copy(observed), state: "complete" } : { ok: true, results: [] };
          }
          if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
          // runWorkflowScript turns this actual management receipt into the
          // native `Status '<ref>' failed: ...` exception.
          return { ok: false, output: `Run: ${ref}\nState: stopped`, results: [] };
        });
        const count = host.launches.length;
        expect((await host.executeNative()).status).toBe(mode === "stop" ? "cancelled" : "blocked");
        expect(host.launches.slice(count).map(call => call.key)).toEqual(
          phase === "compliance" ? [] : ["invoke-human-1.l1.acceptance.gate.r1"]);
      }
    });
});

describe("workflow-owned execute controller", () => {
  // Read-only continuation still reconciles its exact query; it has no file
  // checkpoint to restore. Modifying recovery is covered by real checkpoint
  // composition below, and must not inherit this historical-query prerequisite.

});

// Worker payload/inspector observations were replaced by checkpoint-first v6
// recovery: producer conflicts and native barriers remain barriers; missing
// payload/provenance uses the durable journal, never an invented inspector report.
describe("checkpoint-first modifying recovery", () => {
  test.each(["running", "queued", "pending", "paused", "detached", "recovery", "capacity", "permission", "stop", "run-conflict", "agent-conflict"])(
    "producer %s prevents a replacement writer and survives replay", async mode => {
      const host = fixture(), target = "invoke-human-1.l1.t1.a1";
      let original!: Result;
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key !== target) return result;
        delete result.structuredOutput;
        original = { ...result, ...(mode === "permission" ? { ok: false, error: "Blocked by pi-subagents permission rule: worker denied." }
          : mode === "stop" ? { ok: false, stopped: true }
          : mode === "capacity" ? { toolBudgetBlocked: true }
          : mode === "run-conflict" ? { ok: false, stopped: true }
          : mode === "agent-conflict" ? { agent: "pitako.reviewer" }
          : { state: mode }) };
        return original;
      });
      const output = await host.executeNative();
      expect(output.status).not.toBe("complete");
      expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
      const count = host.calls.length;
      host.setRespond((_request, normal) => normal());
      host.setStatus(ref => ref === target || ref === `native-${target}` ? mode === "run-conflict" ? { ...copy(original), runId: "different-writer" } : copy(original) : copy(host.native.get(ref)!));
      expect((await host.executeNative()).status).not.toBe("complete");
      expect(host.calls).toHaveLength(count);
      expect(host.calls.some(call => call.key.endsWith(".a2.baseline"))).toBe(false);
      expect(host.native.get(target)).toEqual(original);
    });

  test.each(["missing", "interrupted", "key-only"].flatMap(mode =>
    ["none", "restoration-intent", "new-checkpoint", "result", "next-loop"].map(cut => ({ mode, cut })) ))(
    "$mode restores before capture across $cut cut and replays idempotently", async ({ mode, cut }) => {
      const host = fixture(undefined, { realCheckout: true }), target = "invoke-human-1.l1.t1.a1";
      let source: CheckpointIntent, restored: ReturnType<typeof restoreCheckpoint>;
      host.setRespond((request, normal) => {
        if (request.key === target) {
          const result = normal(); source = readExecuteIntentContext(host.root, host.current()).intent;
          applyCheckpoint(source, [{ path: "src/change1.ts", image: { bytes: Buffer.from("interrupted owned bytes").toString("base64"), mode: 0o644 } }]);
          delete result.structuredOutput;
          if (mode === "interrupted") { result.ok = false; result.interrupted = true; result.state = "interrupted"; }
          if (mode === "key-only") delete result.runId;
          return result;
        }
        if (request.key === "invoke-human-1.l1.t1.a2") {
          expect(request.task).toContain("CHECKPOINT FALLBACK");
          expect(request.task).toContain(source.key);
          expect(readFileSync(path.join(host.root, "src/change1.ts"), "utf8")).toBe("interrupted owned bytes");
          restored = restoreAttempt(host);
          expect(existsSync(path.join(host.root, "src/change1.ts"))).toBe(false);
          expect(existsSync(path.join(host.root, ".pi/subagents/checkpoints", request.key, "manifest.json"))).toBe(false);
          return host.result(request, { ...host.worker(request),
            restoreReceipt: { ...restored, restoredRef: restored.partialRef.replace(/restore\.json$/, "restored.json") } });
        }
        return normal();
      });
      if (cut !== "none") cutAt(host, value => cut === "next-loop" ? value.loop?.number === 2
        : value.loop?.attempt?.number === 2 && (cut === "restoration-intent" ? value.action.kind === "pending" && value.action.op === "baseline"
          : cut === "new-checkpoint" ? value.action.kind === "launched" &&
            value.action.key === "invoke-human-1.l1.t1.a2" && value.action.runId === null
            : host.native.has("invoke-human-1.l1.t1.a2")));
      let output = await host.executeNative();
      const saved = copy(host.current());
      const launched = host.launches.length;
      if (cut !== "none") {
        expect(output.status).not.toBe("complete");
        expect(output.reason).toContain("Essential persistence failed");
        host.setFailSave();
        if (mode === "key-only")
          host.setStatus(ref => ref === target ? { ok: false, results: [] } : copy(host.native.get(ref)!));
        if (mode === "interrupted")
          host.setStatus(ref => {
            const original = host.native.get(ref);
            if (original?.interrupted) return { ...copy(original), output: `Run: ${original.runId}\nState: interrupted\n` };
            return original ? { ...copy(original), state: "complete" } : { ok: true, results: [] };
          });
        output = await host.executeNative();
      }
      expect(output.status, `${output.reason}\n${JSON.stringify({ action: saved.action, loop: saved.loop,
        replay: host.launches.slice(launched).map(call => call.key) })}`).toBe("complete");
      expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
      expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual([target, "invoke-human-1.l1.t1.a2"]);
      if (["restoration-intent", "new-checkpoint"].includes(cut)) {
        const baselineKey = "invoke-human-1.l1.t1.a2.baseline";
        expect(host.launches.filter(call => call.key === baselineKey)).toHaveLength(1);
        const [recovery] = host.launches.slice(launched);
        expect(recovery.key).toMatch(/\.r1$/);
        expect(recovery.agent).toBe(cut === "new-checkpoint" ? "pitako.loop-baseline"
          : mode === "missing" ? "pitako.loop-close" : "pitako.loop-selection");
        const cursor = host.current();
        const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
        const { records } = store.readRecords(scope, cursor.head);
        expect(records.filter((row: any) => row.opKey === `operation:${baselineKey}`)).toHaveLength(1);
        expect(records.filter((row: any) => row.kind === "intent" &&
          row.body.key === "invoke-human-1.l1.t1.a2")).toHaveLength(1);
      }
      const partial = JSON.parse(JSON.parse(readFileSync(restored!.partialRef, "utf8")).data).partial;
      expect(partial[0].image.bytes).toBe(Buffer.from("interrupted owned bytes").toString("base64"));
      expect(host.records().find((record: any) => record.kind === "unit" && record.body.attempt === 2).body.result)
        .toMatchObject({ status: "complete", attempt: 2,
        checkpoint: { confirmation: { kind: "unit" } } });
      const count = host.calls.length;
      expect((await host.executeNative()).status).toBe("complete");
      expect(host.calls).toHaveLength(count);
    });

  test.each(["missing", "corrupt"])("%s checkpoint is refused by the restoring worker before capture", async mode => {
    const host = fixture(undefined, { realCheckout: true });
    host.setRespond((request, normal) => {
      if (request.key === "invoke-human-1.l1.t1.a2") {
        expect(() => restoreAttempt(host)).toThrow();
        expect(existsSync(path.join(host.root, ".pi/subagents/checkpoints", request.key, "manifest.json"))).toBe(false);
        throw new Error("Cannot restore corrupt or incomplete checkpoint; no capture or edits performed");
      }
      const result = normal();
      if (request.key === "invoke-human-1.l1.t1.a1") {
        const file = path.join(host.root, ".pi/subagents/checkpoints", request.key, "manifest.json");
        // Missing bytes and mismatched manifest binding are both integrity gaps.
        writeFileSync(file, mode === "missing" ? "" : "{}");
        delete result.structuredOutput;
      }
      return result;
    });
    expect((await host.executeNative()).status).not.toBe("complete");
    expect(host.calls.filter(call => call.agent === "pitako.worker").map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
    expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
    expect(host.records().some((row: any) => row.kind === "unit" &&
      row.body.result.status === "complete")).toBe(false);
    const count = host.calls.length;
    expect((await host.executeNative()).status).not.toBe("complete");
    expect(host.calls.slice(count).map(call => call.key)).toEqual([]);
  });
});


test.each(["binding", "invalid-value", "incomplete-value", "blocked"])("settled worker %s preserves result authority without inspector payload rescue", async mode => {
  const host = fixture();
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key === "invoke-human-1.l1.t1.a1") {
      if (mode === "binding") result.output = JSON.stringify({ ...result.structuredOutput, work: "Conflicting complete binding" });
      if (mode === "invalid-value") result.structuredOutput.status = "different";
      if (mode === "incomplete-value") delete result.structuredOutput.work;
      if (mode === "blocked") Object.assign(result.structuredOutput, { status: "blocked", remaining: ["Required scope expansion remains unapproved"] });
    }
    return result;
  });
  const output = await host.executeNative();
  expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(0);
  if (["invalid-value", "incomplete-value"].includes(mode)) {
    expect(output.status, output.reason).toBe("complete");
    expect(host.history()[0].results[0]).toMatchObject({ status: "rejected", taskId: "change1", attempt: 1 });
    expect(host.history()[0].results[0].checkpoint?.confirmation).toBeUndefined();
    expect(host.calls.find(call => call.key === "invoke-human-1.l2.director")!.task).toContain("Worker returned an invalid work/status/remaining contract.");
  } else {
    expect(output.status).toBe("blocked");
    if (mode === "binding") expect(output.reason).toContain("Changed/conflicting worker binding");
    else expect(host.records().findLast((row: any) => row.kind === "unit")?.body.checkpoint.kind).toBe("pause");
    const count = host.calls.filter(call => call.agent === "pitako.worker").length;
    expect((await host.executeNative()).status).toBe("blocked");
    expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(count);
  }
});
