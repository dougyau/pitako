import { expect, test } from "bun:test";
import { copy, executeControllerFixture, gaps, nativeRunId } from "./fixtures/execute-workflow.ts";
import { commitExecute, executeEpoch, executeScope, executeStore, verifyLedger, withExecuteStore } from "../skills/execute/ledger.mjs";
import { canonicalDigest, canonicalJSON } from "../extensions/canonical.mjs";
import { readBacklog } from "../skills/execute/loop.ts";
import { PitakoStore, StoreError } from "../extensions/pitako-store.ts";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { gitFakeBootstrap } from "./fixtures/git-fake-env.ts";
import { openSqliteSync } from "../extensions/board/sqlite.ts";
import { resolveStoredGroupedInput } from "../skills/execute/loop-io.mjs";
import { readExecuteTimeoutProjection } from "../extensions/execute-progress.ts";

const { fixture: createFixture } = executeControllerFixture();
function fixture(options: Parameters<typeof createFixture>[1] = {}) {
  const host = createFixture(undefined, options);
  // These tests exercise grouped close, which is retained for tasks without journaled writes.
  host.setRespond((request, normal) => request.agent === "pitako.worker"
    ? host.result(request, { status: "complete", work: "Read-only task", remaining: [] }) : normal());
  return host;
}

function selectionReplayComparison(host: ReturnType<typeof fixture>, task: string, key: string) {
  const cursor = host.current(), { operation, ...original } = JSON.parse(task);
  const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
  const { head } = store.readRecords(scope);
  if (!key.endsWith(".d1")) expect(head).toEqual(cursor.head);
  const reconstructed = resolveStoredGroupedInput(operation, {
    root: host.root, invocation: cursor.invocation, key, storeId: cursor.storeId,
    scope, expectedHead: cursor.head, refs: { input: cursor.action.input,
      director: { key: cursor.action.key, runId: cursor.action.runId }, loop: cursor.loop.number,
      consumedLoops: cursor.budget.consumedLoops, backlogDigest: cursor.backlogDigest,
      reviewerMs: cursor.timeouts.reviewerMs,
      ...(cursor.budget.consumedLoops === cursor.budget.maxCycles ? { spec: "COMPLETE IMMUTABLE SPECS" } : {}),
    },
  });
  expect(store.readRecords(scope).head).toEqual(head);
  return [canonicalJSON(reconstructed), canonicalJSON(original)] as const;
}

test.each(["version", "busy"])("a retained reviewer timeout routes a store read failure (%s) through the writer", async defect => {
  const host = createFixture(); host.setLimit(3);
  const reviewer = "invoke-human-1.l1.t1.a1.task-reviewer";
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key !== reviewer) return result;
    const { structuredOutput, ...timeout } = result;
    return { ...timeout, ok: false, state: "complete",
      results: result.results!.map(entry => ({ ...entry, timedOut: true, exitCode: 1 })) };
  });
  const first = await host.execute();
  expect(first.status, first.reason).toBe("partial");
  const before = copy(host.current()), count = host.launches.length;
  expect(before.halt.stage).toBe("timeout");
  expect(before.action).toMatchObject({ kind: "launched", role: "reviewer", key: reviewer });
  if (defect === "version") {
    const db = openSqliteSync(new PitakoStore(host.root).file);
    try { db.exec("PRAGMA user_version=2"); } finally { db.close(); }
  } else {
    let reads = 0;
    host.setHostResponse((key, value) => key === "inspect-initial" && ++reads <= 2
      ? { ...value, timeoutDigest: undefined, retainedAnalyses: undefined,
        storeFailure: { code: "store-busy", reason: "Store remained busy." } }
      : value);
  }
  let quarantine = "";
  host.setLaunchRespond(async (request, normal) => {
    const key = `${reviewer}.store-check`;
    if (defect === "busy" && request.key === key) {
      return { ...host.result(request, {}), ok: false,
        output: JSON.stringify({ error: "loop-io", code: "store-busy", reason: "Store remained busy." }) };
    }
    if (request.key !== (defect === "busy" ? `${key}.r1` : key)) return normal();
    const child = Bun.spawn([process.execPath, "--preload", gitFakeBootstrap, path.resolve("skills/execute/loop-io.mjs")], {
      cwd: host.root, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(request.task); child.stdin.end();
    const [output, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit, stderr).toBe(defect === "busy" ? 0 : 1);
    if (defect === "version") {
      expect(JSON.parse(output).code).toBe("store-corrupt");
      quarantine = JSON.parse(output).recovery.quarantine;
    }
    const native = host.result(request, {});
    return { ...native, ok: exit === 0, output, results: native.results!.map(entry => ({ ...entry, exitCode: exit })) };
  });
  host.setStatus(ref => ({ ...host.native.get(ref), ok: true, state: "complete" }));
  const result = await host.execute(defect === "busy" ? { timeouts: { reviewerMs: before.timeouts.reviewerMs + 1 } } : {});
  expect(["partial", "complete"], result.reason).toContain(result.status);
  expect(host.launches[count]?.key).toBe(`${reviewer}.store-check`);
  if (defect === "busy") {
    expect(host.launches[count + 1]?.key).toBe(`${reviewer}.store-check.r1`);
    expect(host.launches[count + 1]?.task).toBe(host.launches[count]?.task);
    expect(host.current().storeId).toBe(before.storeId);
    expect(host.current().epoch).toBe(0);
    expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
    expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
    return;
  }
  expect(existsSync(quarantine)).toBe(true);
  expect(host.current().epoch).toBe(1);
  expect(host.current().models).toEqual(before.models);
  expect(host.current().timeouts).toEqual(before.timeouts);
  expect(host.current().budget.maxCycles).toBe(before.budget.maxCycles);
  expect(host.current().budget.consumedLoops).toBeGreaterThan(before.budget.consumedLoops);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
});

test.each(["fresh-version", "version", "replaced", "busy", "running", "stopped", "drain-version"] as const)(
  "live writer failure recovers without discarding newly admitted producers (%s)", async defect => {
    const host = fixture(); host.setLimit(3);
    const store = new PitakoStore(host.root);
    const fresh = defect === "fresh-version";
    const oldStore = fresh ? store.activate("exec:prior.e0") : null;
    if (fresh) {
      const db = openSqliteSync(store.file);
      try { db.exec("PRAGMA user_version=2"); } finally { db.close(); }
    }
    let quarantine: string | undefined;
    let intercepted = false, before: any;
    host.setLaunchRespond(async (request, normal) => {
      if (intercepted || request.agent !== "pitako.loop-io" ||
          JSON.parse(request.task).operation !== (fresh ? "advance" : defect === "drain-version" ? "drain" : "gate")) return normal();
      intercepted = true;
      before = copy(host.current());
      const result = host.result(request, {});
      if (defect === "busy") return { ...result, ok: false,
        output: JSON.stringify({ error: "loop-io", code: "store-busy", reason: "Store is locked" }) };
      if (!fresh) {
        const db = openSqliteSync(store.file);
        try {
          if (defect === "replaced") db.prepare("UPDATE meta SET value=? WHERE key='storeId'").run(randomUUID());
          else db.exec("PRAGMA user_version=2");
        } finally { db.close(); }
      }
      const child = Bun.spawn([process.execPath, "--preload", gitFakeBootstrap, path.resolve("skills/execute/loop-io.mjs")], {
        cwd: host.root, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      child.stdin.write(request.task); child.stdin.end();
      const [output, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exit, stderr).toBe(1);
      const failure = JSON.parse(output);
      expect(failure.code).toBe(defect === "replaced" ? "store-replaced" : "store-corrupt");
      quarantine = failure.recovery?.quarantine;
      return { ...result, ok: false, output,
        results: result.results!.map(entry => ({ ...entry, exitCode: exit })) };
    });
    host.setStatus(ref => {
      const value = host.native.get(ref)!;
      return intercepted && value?.agent === "pitako.worker" && ["running", "stopped"].includes(defect)
        ? { ...value, state: defect === "running" ? "running" : "complete", stopped: defect === "stopped" }
        : { ...value, state: "complete" };
    });
    const output = await host.execute();
    expect(intercepted).toBe(true);
    if (fresh) {
      expect(before).toBeUndefined();
      expect(output.status, output.reason).toBe("complete");
      expect(host.emits.some(report => report.halt || report.status === "blocked")).toBe(false);
      expect(output.loopReport.action.actor).toBe("none");
      expect(quarantine).toStartWith(`${store.file}.v2.`);
      expect(existsSync(quarantine!)).toBe(true);
      const { storeId } = store.verify();
      expect(storeId).not.toBe(oldStore?.storeId);
      expect(host.snapshots[0]).toMatchObject({ storeId, budget: { consumedLoops: 1, maxCycles: 3 } });
      expect(host.current().budget.maxCycles).toBe(3);
      expect(host.launches.slice(0, 2).map(call => call.key))
        .toEqual(["invoke-human-1.l1.advance", "invoke-human-1.l1.advance.r1"]);
      expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
    } else if (["running", "stopped"].includes(defect)) {
      expect(output.status, output.reason).toBe(defect === "stopped" ? "cancelled" : "blocked");
      expect(host.current()).toEqual(before);
      expect(host.launches.some(call => call.key.startsWith("invoke-human-1.e1."))).toBe(false);
      expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
    } else {
      expect(["partial", "complete"], output.reason).toContain(output.status);
      expect(host.current().epoch).toBe(defect === "busy" ? 0 : 1);
      expect(host.current().budget.maxCycles).toBe(before.budget.maxCycles);
      expect(host.current().budget.consumedLoops).toBeGreaterThanOrEqual(before.budget.consumedLoops);
      expect(host.current().models).toEqual(before.models);
      expect(host.current().timeouts).toEqual(before.timeouts);
      expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
      if (defect === "busy") {
        expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
        expect(host.launches.some(call => call.key === `${before.action.opKey}.r1`)).toBe(true);
      }
    }
  });

test.each([
  ["version", "complete"], ["replaced", "complete"], ["ahead", "complete"],
  ["body", "complete"], ["chain", "complete"], ["meta", "complete"],
  ["version", "running"], ["version", "stopped"], ["version", "wrong-run"],
  ["version", "wrong-agent"],
] as const)(
  "writer recovery preserves the budget and native barriers (%s, %s)", async (defect, nativeState) => {
    const host = fixture(); host.setLimit(3);
    let received = false;
    host.setLaunchRespond(async (request, normal) => {
      const result = await normal();
      if (request.agent === "pitako.worker") received = true;
      return result;
    });
    host.setFailSave(() => received);
    const first = await host.execute();
    expect(first.reason).toContain("Essential persistence failed");
    const cursor = copy(host.current());
    host.setFailSave();
    host.setLimit(5); // Recovery must not reload the admitted maximum.
    const store = new PitakoStore(host.root);
    const db = openSqliteSync(store.file);
    try {
      if (defect === "version") db.exec("PRAGMA user_version=2");
      if (defect === "replaced") db.prepare("UPDATE meta SET value=? WHERE key='storeId'").run(randomUUID());
      if (defect === "ahead") db.exec("DELETE FROM records");
      if (defect === "body") db.exec("UPDATE records SET body='null' WHERE seq=1");
      if (defect === "chain") db.exec("UPDATE records SET digest='broken' WHERE seq=1");
      if (defect === "meta") db.exec("DELETE FROM meta WHERE key='storeId'");
    } finally { db.close(); }
    let recovered = false;
    host.setStatus(ref => ({ ...host.native.get(ref)!, state: recovered && nativeState === "running" ? "running" : "complete",
      ...(recovered && nativeState === "stopped" ? { stopped: true } : {}),
      ...(recovered && nativeState === "wrong-agent" ? { agent: "pitako.reviewer" } : {}),
      ...(recovered && nativeState === "wrong-run" ? { runId: randomUUID() } : {}) }));
    host.setLaunchRespond(async (request, normal) => {
      if (recovered || request.agent !== "pitako.loop-io") return normal();
      recovered = true;
      const child = Bun.spawn([process.execPath, "--preload", gitFakeBootstrap, path.resolve("skills/execute/loop-io.mjs")], {
        cwd: host.root, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      child.stdin.write(request.task); child.stdin.end();
      const [output, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exit, stderr).toBe(1);
      expect(JSON.parse(output).code).toBe(defect === "replaced" ? "store-replaced" :
        defect === "ahead" ? "cursor-ahead" : "store-corrupt");
      const result = host.result(request, {});
      return { ...result, ok: false, output,
        results: result.results!.map(entry => ({ ...entry, exitCode: exit })) };
    });
    const cutFirstEpochSave = defect === "version" && nativeState === "complete";
    if (cutFirstEpochSave) host.setFailSave(value => value.epoch === 1);
    let output = await host.execute();
    expect(recovered).toBe(true);
    if (nativeState !== "complete") {
      expect(output.status).toBe(nativeState === "stopped" ? "cancelled" : "blocked");
      expect(host.current()).toEqual(cursor);
      expect(host.launches.some(call => call.key.startsWith("invoke-human-1.e1."))).toBe(false);
      expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
      return;
    }
    if (cutFirstEpochSave) {
      const loop = cursor.budget.consumedLoops + 1;
      const key = `invoke-human-1.e1.l${loop}.advance`;
      const epochRecords = () => store.readRecords("exec:human-1.e1", undefined, true).records;
      const committed = epochRecords().find(row => row.kind === "receipt" && (row.body as { key: string }).key === key);
      expect(committed).toBeDefined();
      expect(output.reason).toContain("Essential persistence failed");
      expect(host.current()).toEqual(cursor);
      const beforeReplay = host.launches.length;
      let firstSave: { cursor: typeof cursor; count: number } | undefined;
      host.setFailSave();
      host.advance(1000); // The replay cannot rebuild the request using the relaunch clock.
      host.setSaveObserver(value => { firstSave ??= { cursor: copy(value), count: host.launches.length }; });
      output = await host.execute();
      expect(firstSave?.cursor, output.reason).toMatchObject({ epoch: 1,
        budget: { consumedLoops: loop, maxCycles: cursor.budget.maxCycles } });
      expect(host.launches.slice(beforeReplay, firstSave!.count).map(({ key, agent }) => ({ key, agent })))
        .toEqual([{ key: `${key}.r1`, agent: "pitako.loop-io" }]);
      expect(output.reason).not.toMatch(/replay.differs|new mission|ask a human/i);
      expect(epochRecords().find(row => row.seq === committed!.seq)).toEqual(committed);
      expect(host.launches.slice(beforeReplay).some(call => call.key === `invoke-human-1.e1.l${loop}.director`)).toBe(true);
    }
    expect(["complete", "partial"], output.reason).toContain(output.status);
    const renewed = host.current();
    expect(renewed.epoch, output.reason).toBe(1);
    expect(renewed.budget.maxCycles).toBe(cursor.budget.maxCycles);
    expect(renewed.budget.consumedLoops).toBeGreaterThanOrEqual(cursor.budget.consumedLoops);
    expect(renewed.models).toEqual(cursor.models);
    expect(host.launches.some(call => call.key.startsWith("invoke-human-1.e1."))).toBe(true);
    expect(new PitakoStore(host.root).readRecords("exec:human-1.e1").head).not.toBeNull();
    expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  });

test("a recovered epoch publishes final review gaps and replays the same checkout without republishing", async () => {
  const host = createFixture(undefined, { taskCount: 0, findings: true, realCheckout: true });
  host.setLimit(4);
  const base = "invoke-human-1.e1.l2", checkoutKey = `${base}.checkout`;
  host.setRespond((request, normal) => {
    if (request.agent === "pitako.worker")
      return host.result(request, { status: "complete", work: "Read-only repair", remaining: [] });
    const result = normal();
    if (request.key === `${base}.review.director-synthesis`) {
      result.structuredOutput.screening.verdict = "material-gaps";
      result.structuredOutput.screening.assessments[0].material = true;
    }
    return result;
  });
  const runCLI = (script: string, input: string) => {
    const result = Bun.spawnSync([process.execPath, "--preload", gitFakeBootstrap, path.resolve("skills/execute", script)],
      { cwd: host.root, env: process.env, stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe" });
    return { exit: result.exitCode, output: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  const store = new PitakoStore(host.root);
  host.setLaunchRespond(async (request, normal) => {
    if (request.key === "invoke-human-1.l1.acceptance.gate") {
      const db = openSqliteSync(store.file);
      try { db.exec("PRAGMA user_version=2"); } finally { db.close(); }
      const { exit, output, stderr } = runCLI("loop-io.mjs", request.task);
      expect(exit, stderr).toBe(1);
      expect(JSON.parse(output)).toMatchObject({ code: "store-corrupt" });
      return { ...host.result(request, {}), ok: false, output };
    }
    if (request.key !== checkoutKey) return normal();
    const { exit, output, stderr } = runCLI("observe.mjs", request.task);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(output), output).toMatchObject({ ok: true,
      summaries: [expect.objectContaining({ loop: 2, status: "gaps" })] });
    return { ok: true, key: request.key, agent: request.agent, runId: nativeRunId(request.key), output,
      asyncDir: `/native/async/${request.key}`, results: [{ exitCode: 0 }],
      externalAdapter: {
        adapter: { id: "external-cli", version: 1, executionMode: "one-shot-stdin" },
        capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false,
          supervisor: "unsupported", forkContext: false, extensionBindings: false },
        handoff: { mode: "fresh" }, supervisor: { mode: "unsupported", reason: "Fixed one-shot observer" },
        nonResumableReason: "Fixed one-shot observer", outputArtifacts: {
          stdoutPath: `/native/async/${request.key}/stdout.log`, stderrPath: `/native/async/${request.key}/stderr.log`,
        },
      } };
  });
  host.setFailSave(() => host.native.has(checkoutKey));
  const interrupted = await host.execute();
  expect(interrupted.reason).toContain("Essential persistence failed");
  expect(host.current()).toMatchObject({ epoch: 1, loop: { number: 2, phase: "closing" } });
  const epochRows = () => store.readRecords("exec:human-1.e1", undefined, true).records.filter(row => row.kind === "ledger");
  const published = epochRows()[0]!;
  expect(published).toBeDefined();

  host.setFailSave();
  const checkoutRun = host.native.get(checkoutKey)!.runId;
  host.setStatus(ref => ref === checkoutKey || ref === checkoutRun
    ? { ok: true, state: "unknown" } : copy(host.native.get(ref)!));
  const resumed = await host.execute();
  expect(resumed.status, resumed.reason).toBe("complete");
  const checkouts = host.launches.filter(call => call.key === checkoutKey);
  expect(checkouts).toHaveLength(2);
  expect(checkouts[1]).toEqual(checkouts[0]!);
  expect(host.launches.some(call => call.key === `${base}.compliance`)).toBe(false);
  expect(epochRows().filter(row => row.opKey === published.opKey)).toEqual([published]);
  expect(host.history()).toContainEqual(expect.objectContaining({ number: 2, outcome: "gaps" }));

  store.activate("exec:human-1.e2");
  const stale = runCLI("observe.mjs", checkouts[0]!.task);
  expect(JSON.parse(stale.output), stale.output).toMatchObject({ ok: false, code: "superseded" });
});

test.each(["cursor-ahead", "store-replaced", "superseded"] as const)(
  "writer cursor preflight reports %s before effects and only quarantines the damaged epoch", async code => {
    const host = fixture(), invocation = "human-1", scope = executeScope(invocation);
    const store = new PitakoStore(host.root), identity = store.activate(scope);
    const body = { original: true };
    const saved = store.commit(scope, null, "original", canonicalDigest(body), () => ({ kind: "marker", body }));
    if (saved.outcome !== "appended") throw Error("Missing fixture record");
    if (code === "superseded") store.activate(executeScope("replacement"));
    const cursor = { storeId: code === "store-replaced" ? randomUUID() : identity.storeId,
      expectedHead: code === "cursor-ahead" ? { seq: saved.head!.seq + 1, hash: "f".repeat(64) } : saved.head };
    const child = Bun.spawn([process.execPath, "--preload", gitFakeBootstrap, path.resolve("skills/execute/loop-io.mjs")], {
      cwd: host.root, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ operation: "advance", root: host.root, invocation,
      key: "invoke-human-1.l1.advance", scope, ...cursor, refs: {} }));
    child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit, stderr).toBe(1);
    const failure = JSON.parse(stdout.trim());
    expect(failure.error).toBe("loop-io");
    expect(failure.code, stdout).toBe(code);
    if (code !== "superseded") expect(failure.recovery.root).toBe(host.root);
    const quarantined = readdirSync(`${host.root}/.pi/pitako`).filter(name => name.startsWith("pitako.db.v"));
    if (code === "cursor-ahead") {
      expect(failure?.recovery?.storeId).not.toBe(identity.storeId);
      expect(existsSync(failure!.recovery!.quarantine!)).toBe(true);
      expect(quarantined.length).toBeGreaterThan(0);
    } else if (code === "store-replaced") {
      expect(failure?.recovery?.storeId).toBe(identity.storeId);
      expect(failure?.recovery?.quarantine).toBeUndefined();
      expect(quarantined).toEqual([]);
      expect(store.readRecords(scope).head).toEqual(saved.head);
    } else {
      expect(failure.recovery).toBeUndefined();
      expect(quarantined).toEqual([]);
      expect(store.readRecords(scope).head).toEqual(saved.head);
    }
  });

test.each([false, true])("superseded root ends without saving or effects (worker save cut: %s)", async cut => {
  const host = fixture(); host.setLimit(1);
  let received = false;
  if (cut) {
    host.setLaunchRespond(async (request, normal) => {
      const result = await normal();
      if (request.agent === "pitako.worker") received = true;
      return result;
    });
    host.setFailSave(() => received);
    expect((await host.execute()).reason).toContain("Essential persistence failed");
    expect(host.current().action).toMatchObject({ kind: "launched", role: "worker" });
    host.setFailSave();
  }
  let before: unknown, saves = -1, intercepted = false;
  host.setLaunchRespond(async (request, normal) => {
    if (request.agent !== "pitako.loop-io" ||
        !["gate", "close"].includes(JSON.parse(request.task).operation)) return normal();
    intercepted = true;
    before = copy(host.current()); saves = host.snapshots.length;
    const store = new PitakoStore(host.root);
    store.activate(executeScope("replacement"));
    const child = Bun.spawn([process.execPath, "--preload", gitFakeBootstrap, path.resolve("skills/execute/loop-io.mjs")], {
      cwd: host.root, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(request.task); child.stdin.end();
    const [output, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit, stderr).toBe(1);
    expect(JSON.parse(output).code).toBe("superseded");
    const result = host.result(request, {});
    return { ...result, ok: false, output,
      results: result.results!.map(entry => ({ ...entry, exitCode: exit })) };
  });
  const output = await host.execute();
  expect(intercepted).toBe(true);
  expect(output.status, output.reason).toBe("partial");
  expect(output.reason).toContain("superseded");
  expect(host.current()).toEqual(before);
  expect(host.snapshots).toHaveLength(saves);
  expect(host.gateExecutions()).toBe(0);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
});

test("the active root repairs a cursor clobbered between commit and save without extra admissions", async () => {
  const ordinary = fixture(); ordinary.setLimit(1);
  const ordinaryOutput = await ordinary.execute();
  const host = fixture(); host.setLimit(1);
  let clobbered = false;
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (!clobbered && request.agent === "pitako.loop-io" &&
        JSON.parse(request.task).operation === "gate") {
      expect(JSON.parse(result.output!).head.seq).toBeGreaterThan(host.current().head.seq);
      host.storage.set("pitako-execute", { invocation: "clobbered" });
      clobbered = true;
    }
    return result;
  });
  const output = await host.execute();
  expect(clobbered).toBe(true);
  expect(output.status, output.reason).toBe(ordinaryOutput.status);
  expect(host.current().invocation).toBe("human-1");
  expect(host.current().storeId).toBe(new PitakoStore(host.root).verify().storeId);
  expect(host.launches.map(call => call.key)).toEqual(ordinary.launches.map(call => call.key));
  expect(host.gateExecutions()).toBe(1);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "loop"]);
});

test("writer cursor preflight admits a store-ahead replay at its original projection", async () => {
  const host = fixture(), invocation = "human-1";
  const first = await withExecuteStore(host.root, invocation, () =>
    commitExecute(host.root, invocation, "first", canonicalDigest(1), "marker", { value: 1 }));
  await withExecuteStore(host.root, invocation, () =>
    commitExecute(host.root, invocation, "second", canonicalDigest(2), "marker", { value: 2 }));
  const replay = await withExecuteStore(host.root, invocation, () =>
    commitExecute(host.root, invocation, "first", canonicalDigest(1), "marker", { value: 1 }),
    0, { storeId: first.identity.storeId, expectedHead: first.head });
  expect(replay.outcome).toBe("replay");
  expect(replay.head).toEqual(first.head);
  expect(replay.P).toEqual(first.P);
  expect(replay.result).toEqual(first.result);
});

test("epoch writers isolate operation replay and retain the supersession fence", async () => {
  const host = fixture();
  const invocation = "human-1", opKey = "epoch-marker", body = { result: "committed" };
  for (const epoch of [0, 1]) {
    const key = `invoke-${invocation}${epoch ? `.e${epoch}` : ""}.l1.advance`;
    await withExecuteStore(host.root, invocation, async () => {
      expect(executeScope(invocation)).toBe(`exec:${invocation}.e${epoch}`);
      const first = commitExecute(host.root, invocation, opKey, canonicalDigest(body), "marker", body);
      const replay = commitExecute(host.root, invocation, opKey, canonicalDigest(body), "marker", body);
      expect(first.outcome).toBe("appended");
      expect(replay.outcome).toBe("replay");
      expect(replay.head).toEqual(first.head);
      expect(replay.P).toEqual(first.P);
      await expect(withExecuteStore(host.root, invocation, () => undefined, epoch + 1))
        .rejects.toThrow("session identity mismatch");
    }, executeEpoch(invocation, key));
  }
  const old = executeStore(host.root, invocation, false, 0);
  const before = old.store.readRecords(old.scope);
  expect(old.store.commit(old.scope, before.head, "late-write", canonicalDigest(body),
    () => ({ kind: "marker", body })).outcome).toBe("superseded");
  expect(old.store.readRecords(old.scope).head).toEqual(before.head);
  expect(executeStore(host.root, invocation, false, 1).scope).toBe("exec:human-1.e1");
  expect(() => executeEpoch(invocation, "invoke-other.e1.l1.advance")).toThrow();
  expect(() => executeEpoch(invocation, "invoke-human-1.e0.l1.advance")).toThrow();
  expect(() => executeScope(invocation, -1)).toThrow();
});

test("a writer quarantines semantic ledger corruption even when the SQLite record hashes are valid", async () => {
  const host = fixture(), invocation = "human-1", scope = executeScope(invocation);
  const store = new PitakoStore(host.root);
  const identity = store.activate(scope);
  const entry = { seq: 0, prev: null, kind: "spec", loop: 0,
    body: { content: "original", digest: "0".repeat(64) } };
  const body = { entries: [entry] };
  store.commit(scope, null, "ledger:0", canonicalDigest(body), () => ({ kind: "ledger", body }));
  expect(() => verifyLedger(host.root, invocation, { count: 1, head: canonicalDigest(entry) }))
    .toThrow("Ledger spec digest mismatch");
  expect(store.verify().storeId).toBe(identity.storeId); // Readers did not quarantine.
  let failure: StoreError | undefined;
  try {
    await withExecuteStore(host.root, invocation, () =>
      verifyLedger(host.root, invocation, { count: 1, head: canonicalDigest(entry) }));
  } catch (error) {
    expect(error).toBeInstanceOf(StoreError);
    failure = error as StoreError;
  }
  expect(failure?.code).toBe("store-corrupt");
  expect(failure?.recovery?.storeId).not.toBe(identity.storeId);
  expect(existsSync(failure!.recovery!.quarantine!)).toBe(true);
  expect(store.verify().storeId).toBe(failure!.recovery!.storeId);
});

test.each(["close", "drain", "checkout"] as const)("a stopped %s holds with exact admission counts", async operation => {
  const checkout = operation === "checkout";
  const checkoutKey = "invoke-human-1.l1.checkout";
  const host = fixture(checkout ? { taskCount: 0 } : {}); host.setLimit(1);
  let stopped = false;
  host.setLaunchRespond(async (request, normal) => {
    if (checkout && request.key === checkoutKey) {
      // Stop settled natively, but the old cursor still records the closing action.
      host.setFailSave(() => true);
      return { ok: false, key: checkoutKey, agent: request.agent, runId: nativeRunId(checkoutKey),
        stopped: true, results: [] };
    }
    const result = await normal();
    if (!stopped && request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === operation) {
      stopped = true;
      return { ...result, ok: false, stopped: true };
    }
    return result;
  });
  let first = await host.execute();
  if (checkout) {
    expect(first.reason).toContain("Essential persistence failed");
    expect(host.current().halt).toBeNull();
    const checkoutRun = nativeRunId(checkoutKey);
    host.setStatus(ref => ref === checkoutKey
      ? { ok: true, key: ref, runId: checkoutRun, results: [], output: `Run: ${checkoutRun}\nState: stopped` }
      : host.native.get(ref) ?? { ok: false, results: [] });
    host.setFailSave();
    const launches = copy(host.launches), calls = copy(host.calls), head = copy(host.current().head);
    first = await host.execute();
    expect(first.loopReport.halt).toMatchObject({ cause: "stopped", ref: { key: checkoutKey, runId: checkoutRun } });
    expect(host.current().head).toEqual(head);
    expect(host.launches).toEqual(launches);
    expect(host.calls).toEqual(calls);
  }
  expect(first.status, first.reason).toBe("cancelled");
  const cursor = copy(host.current()), launches = copy(host.launches), calls = copy(host.calls);
  if (!checkout) expect(cursor.action).toMatchObject({ kind: "pending", op: operation });
  const replay = await host.execute();
  expect(replay.status, replay.reason).toBe("cancelled");
  expect(replay.loopReport.halt).toEqual(first.loopReport.halt);
  expect(host.launches).toEqual(launches);
  expect(host.calls).toEqual(calls);
  expect(host.current()).toEqual(cursor);
  if (checkout) {
    unlinkSync(path.join(host.root, ".pi/native-review", nativeRunId("workflow"), "workflow-children.jsonl"));
    const missing = await host.execute();
    expect(missing.status).toBe("blocked");
    expect(missing.reason).toContain("integrity failure");
    expect(host.launches).toEqual(launches);
    expect(host.calls).toEqual(calls);
    expect(host.current()).toEqual(cursor);
  }
});


test.each(["before-first-selection", "before-selection", "before-drain-save", "before-dispatch", "after-commit"] as const)(
  "final drain after two rejected selections relaunches at its original key (%s)", async cut => {
    const drainKey = "invoke-human-1.l1.finishDrain";
    const selectionKey = "invoke-human-1.l1.selectionIO.d1";
    const run = async (interrupt?: typeof cut) => {
      const host = fixture(); host.setLimit(1);
      let comparison: ReturnType<typeof selectionReplayComparison> | undefined;
      let comparisonError: unknown;
      host.setRespond((request, normal) => {
        if (request.agent !== "pitako.execution-director") return normal();
        const plan = host.plan();
        if (request.key.endsWith(".d1")) {
          for (const change of plan.changes)
            if ("task" in change) Object.assign(change.task, { dependsOn: ["missing"] });
        } else plan.select = "missing";
        return host.result(request, plan);
      });
      const interruptedDirector = interrupt === "before-first-selection" ? "invoke-human-1.l1.director"
        : "invoke-human-1.l1.director.d1";
      if (interrupt === "before-selection" || interrupt === "before-first-selection") {
        host.setSaveObserver(value => {
          if (value.action.key === interruptedDirector && value.action.runId)
            throw Error("Cut before the rejected selection writer");
        });
      } else if (interrupt === "before-dispatch") {
        host.setSaveObserver(value => {
          if (value.action.opKey === drainKey) throw Error("Cut after durable drain save, before native admission");
        });
      }
      host.setLaunchRespond(async (request, normal) => {
        if (!interrupt && request.key === selectionKey) {
          try { comparison = selectionReplayComparison(host, request.task, selectionKey); }
          catch (error) { comparisonError = error; }
        }
        const result = await normal();
        if (interrupt === "before-drain-save" && request.key === selectionKey) {
          expect(JSON.parse(result.output!).rejectedDrain).toBeDefined();
          host.setFailSave(() => true);
        }
        if (interrupt === "after-commit" && request.key === drainKey) host.setFailSave(() => true);
        return result;
      });
      const result = await host.execute();
      if (!interrupt) {
        expect(result.status, result.reason).toBe("partial");
        if (comparisonError) throw comparisonError;
        expect(comparison, result.reason).toBeDefined();
        expect(comparison![0]).toBe(comparison![1]);
        expect(host.current().action).toEqual({ kind: "terminal" });
        return host;
      }
      const saved = copy(host.current());
      expect(saved.budget.consumedLoops).toBe(1);
      const { store, scope } = executeStore(host.root, saved.invocation, false, saved.epoch);
      const intended = store.readRecords(scope).records.find(row => row.opKey === `final-drain:${drainKey}`)!;
      expect(!!intended).toBe(interrupt !== "before-selection" && interrupt !== "before-first-selection");
      if (interrupt === "before-first-selection" || interrupt === "before-selection" || interrupt === "before-drain-save") {
        expect(saved.action).toMatchObject({ kind: "launched", role: "execution-director", key: interruptedDirector });
        expect(saved.action.runId).toBe(host.native.get(saved.action.key)?.runId);
        if (intended) expect(intended.seq).toBeGreaterThan(saved.head.seq);
      } else {
        expect(saved.action).toMatchObject({ kind: "pending", op: "drain", opKey: drainKey,
          input: { seq: intended.seq, digest: intended.digest } });
        expect(saved.loop.outcome).toBe("gaps");
        expect(intended.digest).toBe(saved.head.hash);
      }
      const committed = () => store.readRecords(scope).records.find(row => row.kind === "receipt" &&
        (row.body as { key: string }).key === drainKey);
      const originalReceipt = committed();
      expect(!!originalReceipt).toBe(interrupt === "after-commit");
      const originalLaunch = host.launches.find(call => call.key === drainKey);
      expect(!!originalLaunch).toBe(interrupt === "after-commit");
      host.setSaveObserver(undefined);
      host.setFailSave();
      host.setLaunchRespond();
      const count = host.launches.length;
      const statuses = host.statusCalls.length;
      const resumed = await host.execute();
      expect(resumed.status, resumed.reason).toBe("partial");
      const resumedLaunches = host.launches.slice(count);
      expect(resumedLaunches.map(call => call.key)).toEqual(interrupt === "before-first-selection"
        ? ["invoke-human-1.l1.selectionIO.r1", "invoke-human-1.l1.director.d1", "invoke-human-1.l1.selectionIO.d1", drainKey]
        : interrupt === "before-selection" ? ["invoke-human-1.l1.selectionIO.d1.r1", drainKey] : [drainKey]);
      if (interrupt !== "before-first-selection") expect(host.statusCalls.slice(statuses)).toContain(drainKey);
      if (interrupt === "before-drain-save") expect(host.statusCalls.slice(statuses)).toContain(saved.action.runId);
      if (originalLaunch) expect(resumedLaunches[0]).toEqual(originalLaunch);
      if (originalReceipt) expect(committed()).toEqual(originalReceipt);
      expect(host.current().action).toEqual({ kind: "terminal" });
      expect(host.current().budget).toEqual(saved.budget);
      return host;
    };
    const normal = await run();
    const relaunched = await run(cut);
    expect([...new Set(relaunched.launches.map(call => call.key))]).toEqual(normal.launches.map(call =>
      (cut === "before-selection" && call.key.endsWith(".selectionIO.d1") ||
        cut === "before-first-selection" && call.key.endsWith(".selectionIO")) ? `${call.key}.r1` : call.key));
    const selectionAndDrain = (host: typeof normal) => {
      const wire = host.launches.find(call => call.key.endsWith(".finishDrain"))!.task;
      const { root, invocation, storeId, refs } = JSON.parse(wire);
      const { store, scope } = executeStore(root, invocation);
      const { records } = store.readRecords(scope);
      const marker = records.find(row => row.seq === refs.input.seq && row.digest === refs.input.digest);
      expect(marker?.opKey).toBe(`final-drain:${drainKey}`);
      const selection = records.find(row => row.opKey === `operation:${selectionKey}`);
      expect(selection?.kind).toBe("operation");
      const advance = records.find(row => row.kind === "receipt" &&
        (row.body as { key: string }).key === "invoke-human-1.l1.advance");
      expect(advance).toBeDefined();
      // Only fixture identity and digests of verified fixture records vary between roots.
      const bytes = canonicalJSON({
        wire: JSON.parse(wire), drain: (marker!.body as { request: unknown }).request,
        selection: (selection!.body as { request: unknown }).request,
      }).replaceAll(advance!.bodyDigest, "<ADVANCE RECEIPT>");
      return records.reduce((value, row) => value.replaceAll(row.digest, `<ROW:${row.seq}>`),
        bytes.replaceAll(root, "<ROOT>").replaceAll(storeId, "<STORE>"));
    };
    expect(selectionAndDrain(relaunched)).toBe(selectionAndDrain(normal));
    const retryDirector = (host: typeof normal) => host.launches.find(call => call.key.endsWith(".director.d1"))!
      .task.replaceAll(host.root, "<ROOT>");
    expect(retryDirector(relaunched)).toBe(retryDirector(normal));
    expect(relaunched.launches.filter(call => call.agent === "pitako.worker")).toEqual([]);
    for (const host of [normal, relaunched]) {
      const records = host.records();
      expect(records.map((record: { kind: string }) => record.kind)).toEqual(["spec", "loop"]);
      const rejection = records.at(-1).body.plan.rejection;
      expect(rejection.diagnostic).toBe("Unknown/self dependency for change1");
      expect(rejection.previous.diagnostic).toBe("Selected task must be pending");
      expect(readBacklog(host.root, "spec").backlog).toBeNull();
    }
  });

async function settledDirectorSelection(mode: "uninterrupted" | "cut" | "missing" | "mismatch",
    scenario: "first-task" | "later-final" | "renewed-demand" = "first-task",
    demandCut: "saved-run" | "before-dispatch" | "status-denied" = "saved-run") {
    const host = fixture();
    const loop = scenario === "first-task" ? 1 : scenario === "later-final" ? 2 : 3;
    host.setLimit(loop);
    const base = `invoke-human-1.l${loop}`;
    const director = `${base}.director`, selection = `${base}.selectionIO`;
    const demand = `${base}.demand-observation`;
    const renewedDemand = `${base}.g2.demand-observation`;
    let demandReplay: string | undefined;
    if (scenario === "renewed-demand") {
      host.setRespond((request, normal) => {
        const result = normal();
        if (request.key === "invoke-human-1.l2.compliance") return gaps(result);
        if (request.key !== demand) return result;
        const { structuredOutput, ...timeout } = result;
        return { ...timeout, ok: false, state: "complete",
          results: result.results!.map(entry => ({ ...entry, timedOut: true, exitCode: 1 })) };
      });
    }
    let wire: any, comparison: ReturnType<typeof selectionReplayComparison> | undefined;
    host.setLaunchRespond(async (request, normal) => {
      const key = mode === "uninterrupted" ? selection : `${selection}.r1`;
      if (request.key === selection && mode === "uninterrupted")
        comparison = selectionReplayComparison(host, request.task, key);
      const ret = await normal();
      if (request.key === key) wire = JSON.parse(ret.output!);
      return ret;
    });
    if (mode !== "uninterrupted") host.setSaveObserver(value => {
      if (value.action.key === renewedDemand && !!value.action.runId === (demandCut !== "before-dispatch"))
        throw Error("Cut after saving the renewed demand launch");
      if (value.action.key === director && value.action.runId) throw Error("Cut before the selection writer");
    });
    let result = await host.execute();
    if (scenario === "renewed-demand") {
      expect(host.current().action, result.reason).toMatchObject({ kind: "launched", key: demand, runId: nativeRunId(demand) });
      expect(host.current().halt.stage).toBe("timeout");
      const cursor = host.current();
      const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
      expect(JSON.stringify(readExecuteTimeoutProjection(host.root, cursor)?.P))
        .toBe(JSON.stringify(store.read(scope, cursor.head).P));
      host.setStatus(ref => ({ ...host.native.get(ref), ok: true, state: "complete" }));
      const count = host.launches.length;
      result = await host.execute({ timeouts: { reviewerMs: host.current().timeouts.reviewerMs + 1 } });
      if (mode === "cut") {
        const saved = copy(host.current());
        const admitted = demandCut !== "before-dispatch";
        expect(saved.action, result.reason).toMatchObject({ kind: "launched", key: renewedDemand,
          runId: admitted ? nativeRunId(renewedDemand) : null });
        expect(saved.halt).toBeNull();
        const keys = host.launches.map(call => call.key);
        expect(keys.includes(renewedDemand)).toBe(admitted);
        const settled = (ref: string) => {
          const native = host.native.get(ref);
          return native ? { ...native, ok: true, state: "complete" } : { ok: true, output: "", results: [] };
        };
        if (demandCut === "status-denied") {
          host.setSaveObserver(undefined);
          host.setStatus(ref => {
            if (ref === saved.action.runId) throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
            return settled(ref);
          });
          const denied = await host.execute();
          expect(denied.status).toBe("blocked");
          expect(denied.reason).toContain("native permission denial");
          expect(host.launches.map(call => call.key)).toEqual(keys);
          host.setStatus(settled);
          const statuses = host.statusCalls.length;
          const held = await host.execute();
          expect(held.status).toBe(denied.status);
          expect(held.reason).toBe(denied.reason);
          expect(host.statusCalls).toHaveLength(statuses);
          expect(host.launches.map(call => call.key)).toEqual(keys);
          return;
        }
        if (admitted) {
          host.setStatus(ref => ref === saved.action.runId ? { ...settled(ref), state: "running" } : settled(ref));
          const blocked = await host.execute();
          expect(blocked.reason).toContain("Positive native barrier: running");
          expect(host.launches.map(call => call.key)).toEqual(keys);
          expect(host.current()).toEqual(saved);
        }
        host.setStatus(settled);
        const statuses = host.statusCalls.length;
        host.setSaveObserver(value => {
          if (value.action.key === director && value.action.runId) throw Error("Cut before the selection writer");
        });
        result = await host.execute();
        expect(host.current().action, result.reason).toMatchObject({ key: director, runId: nativeRunId(director) });
        expect(host.statusCalls.slice(statuses)).toContain(saved.action.runId ?? renewedDemand);
        const resumed = host.launches.slice(keys.length).map(call => call.key);
        const allowed = [`${base}.advance.r1`, `invoke-human-1.l${loop - 1}.nextAdvance.r1`];
        expect(resumed.filter(key => !allowed.includes(key))).toEqual(admitted ? [director] : [renewedDemand, director]);
        const retries = resumed.filter(key => allowed.includes(key));
        if (admitted) expect(retries.length).toBeLessThanOrEqual(1);
        else expect(retries).toHaveLength(1);
        if (retries.length) expect(keys).not.toContain(retries[0]);
        demandReplay = retries[0];
      }
      const demands = host.launches.filter(call => call.key.endsWith(".demand-observation"));
      expect(demands.map(call => call.key), result.reason).toEqual([demand, renewedDemand]);
      expect(demands[1]).toMatchObject({
        agent: "pitako.reviewer", task: demands[0]!.task, timeoutMs: demands[0]!.timeoutMs! + 1 });
      if (mode === "uninterrupted") expect(host.launches[count]).toEqual(demands[1]!);
    }
    if (mode !== "uninterrupted") {
      host.setSaveObserver(undefined);
      const cursor = copy(host.current());
      expect(cursor.action).toMatchObject({ kind: "launched", key: director, runId: nativeRunId(director) });
      expect(readExecuteTimeoutProjection(host.root, cursor)).toBeUndefined();
      expect(host.launches.filter(call => call.key.startsWith(selection))).toEqual([]);
      const artifact = host.native.get(director)!.results![0]!.savedOutputPath!;
      if (mode === "missing") unlinkSync(artifact);
      if (mode === "mismatch") writeFileSync(artifact, JSON.stringify({ ...host.plan(), select: "wrong-task" }));
      const count = host.launches.length;
      if (mode === "cut") {
        // A running director does not license a selection writer.
        host.setStatus(ref => ({ ...host.native.get(ref), ok: true, state: "running" }));
        expect((await host.execute()).status).toBe("blocked");
        expect(host.launches).toHaveLength(count);
        host.setStatus(ref => ({ ...host.native.get(ref), ok: true, state: "complete" }));
      }
      result = await host.execute();
      expect(host.statusCalls).toContain(cursor.action.runId);
      expect(host.launches.slice(count)[0]).toMatchObject({ agent: "pitako.loop-io", key: `${selection}.r1` });
      if (mode !== "cut") {
        expect(result.status).toBe("blocked");
        expect(result.reason).toMatch(/Director selection integrity failure: .* (missing|mismatch)/);
        expect(host.launches.slice(count).map(call => call.key)).toEqual([`${selection}.r1`]);
        expect(readBacklog(host.root, "spec").backlog).toBeNull();
        return;
      }
    }
    if (mode === "uninterrupted") {
      expect(comparison, result.reason).toBeDefined();
      expect(comparison![0]).toBe(comparison![1]);
    }
    expect(result.status, result.reason).toBe(scenario === "later-final" ? "complete" : "partial");
    expect(host.launches.filter(call => call.agent === "pitako.execution-director").map(call => call.key))
      .toEqual(Array.from({ length: loop }, (_, i) => `invoke-human-1.l${i + 1}.director`));
    expect(host.launches.filter(call => call.key.startsWith(selection)).map(call => call.key)).toEqual([
      mode === "uninterrupted" ? selection : `${selection}.r1`,
    ]);
    if (scenario === "later-final") {
      expect(wire.P.prompt.selectedTask).toBeNull();
      expect(wire.P.prompt.execution.checkpoint).toBeUndefined();
      expect(wire.projection.steps.some((step: { operation: string }) => step.operation === "baseline")).toBe(false);
    } else {
      expect(wire.P.prompt.selectedTask.id).toBe(scenario === "first-task" ? "change1" :
        wire.projection.steps.find((step: { operation: string }) => step.operation === "apply").result.selected.id);
      expect(wire.P.prompt.execution.checkpoint.taskId).toBe(wire.P.prompt.selectedTask.id);
    }
    const { store, scope } = executeStore(host.root, "human-1");
    expect(JSON.stringify(wire.P)).toBe(JSON.stringify(store.read(scope, wire.head).P));
    const worker = host.launches.filter(call => call.agent === "pitako.worker");
    expect(worker.map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1",
      ...(scenario === "renewed-demand" ? [`${base}.t1.a1`] : [])]);
    const backlog = wire.projection.steps.find((step: { operation: string }) => step.operation === "apply").result.digest;
    const relative = (value: string) => {
      let bytes = value.replaceAll(host.root, "<ROOT>").replaceAll(backlog, "<BACKLOG>");
      if (wire.P.control.ledger.head) bytes = bytes.replaceAll(wire.P.control.ledger.head, "<LEDGER HEAD>");
      if (scenario === "renewed-demand") {
        const id = wire.P.prompt.selectedTask.id;
        expect(id).toMatch(/^final-[a-f0-9]{16}-compliance-1$/);
        // The final-gap ID hashes the compliance ref, which contains this temp root.
        bytes = bytes.replaceAll(id, "final-<SOURCE>-compliance-1");
      }
      return bytes;
    };
    const rows = store.readRecords(scope, wire.head).records;
    const projection = rows.reduce((bytes, row) => bytes.replaceAll(row.digest, `<ROW:${row.seq}>`),
      relative(JSON.stringify(wire.P)).replaceAll(wire.P.prompt.admission.admissionBinding, "<ADMISSION>"));
    const directorCursor = host.snapshots.find(value => value.action.key === director);
    return { projection, prompt: scenario === "later-final" ? null : relative(worker.at(-1)!.task),
      directorPrompt: scenario === "renewed-demand" ? relative(host.launches.find(call => call.key === director)!.task)
        .replaceAll(directorCursor.backlogDigest, "<DIRECTOR BACKLOG>") : null,
      keys: host.launches.filter(call => call.key !== demandReplay).map(call => [call.agent, call.key]), selection };
}

test.each(["first-task", "later-final", "renewed-demand"] as const)(
  "settled director selection (%s) resumes with the same P and worker prompt", async scenario => {
  const normal = (await settledDirectorSelection("uninterrupted", scenario))!;
  const cuts = scenario === "renewed-demand" ? ["saved-run", "before-dispatch"] as const : ["saved-run"] as const;
  for (const cut of cuts) {
    const recovered = (await settledDirectorSelection("cut", scenario, cut))!;
    expect(recovered.projection).toBe(normal.projection);
    expect(recovered.prompt).toBe(normal.prompt);
    expect(recovered.directorPrompt).toBe(normal.directorPrompt);
    expect(recovered.keys).toEqual(normal.keys.map(([agent, key]) =>
      [agent, key === normal.selection ? `${key}.r1` : key]));
  }
});

test("settled director selection (renewed-demand) holds a status permission denial at +0", async () => {
  await settledDirectorSelection("cut", "renewed-demand", "status-denied");
});

test.each(["missing", "mismatch"] as const)("settled director selection fails closed when its original is %s",
  async mode => {
    await settledDirectorSelection(mode);
  });

test("selection COMMIT with a lost cursor save restores the same worker launch using only one replay", async () => {
  const run = async (interrupt: boolean) => {
    const host = fixture(); host.setLimit(1);
    const selection = "invoke-human-1.l1.selectionIO", director = "invoke-human-1.l1.director";
    let original: any, replayed: any;
    host.setLaunchRespond(async (request, normal) => {
      if (request.key === `${selection}.r1`) {
        const child = Bun.spawn([process.execPath, "--preload", gitFakeBootstrap, path.resolve("skills/execute/loop-io.mjs")], {
          cwd: host.root, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
        });
        child.stdin.write(request.task); child.stdin.end();
        const [output, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(exit, `${stderr}\n${output}`).toBe(0);
        replayed = JSON.parse(output);
        const native = copy(host.native.get(selection)!);
        return { ...native, key: request.key, runId: nativeRunId(request.key), output };
      }
      const result = await normal();
      if (request.key === selection) {
        original = JSON.parse(result.output!);
        if (interrupt) host.setFailSave(() => true);
      }
      return result;
    });
    const result = await host.execute();
    if (interrupt) {
      const cursor = copy(host.current());
      expect(cursor.action).toMatchObject({ kind: "launched", key: director, runId: host.native.get(director)?.runId });
      const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
      expect(store.readRecords(scope).head).toEqual(original.head);
      host.setFailSave();
      const resumed = await host.execute();
      expect(resumed.status, resumed.reason).toBe("partial");
      expect(host.statusCalls).toContain(cursor.action.runId);
      expect(JSON.stringify(replayed.P)).toBe(JSON.stringify(original.P));
      expect(replayed.projection.steps.find((step: { operation: string }) => step.operation === "apply").result.selected)
        .toEqual(original.projection.steps.find((step: { operation: string }) => step.operation === "apply").result.selected);
      expect(host.current().budget.consumedLoops).toBe(cursor.budget.consumedLoops);
    } else expect(result.status, result.reason).toBe("partial");
    return { host, backlogDigest: original.projection.steps.find((step: { operation: string }) =>
      step.operation === "apply").result.digest as string };
  };
  const standard = await run(false), recovered = await run(true);
  const keys = ({ host }: typeof standard) => host.launches.map(call => call.key);
  expect(keys(recovered)).toEqual(keys(standard).flatMap(key =>
    key.endsWith(".selectionIO") ? [key, `${key}.r1`] : [key]));
  const prompt = ({ host, backlogDigest }: typeof standard) => {
    const task = host.launches.find(call => call.agent === "pitako.worker")!.task;
    expect(task).toContain(`admitted backlog digest ${backlogDigest}`);
    return task.replaceAll(host.root, "<ROOT>").replace(backlogDigest, "<ROOT-SPECIFIC BACKLOG DIGEST>");
  };
  expect(prompt(recovered)).toBe(prompt(standard));
});

test.each(["running", "permission", "capacity", "wrong-run", "wrong-agent"])(
  "grouped close recovery preserves current %s barrier without redispatch", async mode => {
    const host = fixture(); host.setLimit(1);
    host.setLaunchRespond(async (request, normal) => {
      const result = await normal();
      return request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "close"
        ? { ...result, ok: false, stopped: true } : result;
    });
    expect((await host.execute()).status).toBe("cancelled");
    const count = host.launches.length;
    host.setStatus(ref => {
      if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
      if (mode === "capacity") throw Error("Active async run capacity exhausted: 1/1 used.");
      return { ok: true, runId: mode === "wrong-run" ? "other-run" : ref,
        agent: mode === "wrong-agent" ? "pitako.worker" : "pitako.loop-io",
        state: mode === "running" ? "running" : "complete" };
    });
    const result = await host.execute();
    expect(result.status).not.toBe("complete");
    expect(host.launches).toHaveLength(count);
    expect(host.records().filter((record: any) => record.kind === "unit")).toEqual([]);
  });

test("a retained grouped permission denial cannot be erased by relaunch", async () => {
  const host = fixture(); host.setLimit(1);
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    return request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "close"
      ? { ...result, ok: false, error: "Blocked by pi-subagents permission rule: 'run' is denied." } : result;
  });
  expect((await host.execute()).status).toBe("blocked");
  const count = host.launches.length;
  host.setStatus(ref => ({ ok: true, runId: ref, state: "complete" }));
  expect((await host.execute()).status).toBe("blocked");
  expect(host.launches).toHaveLength(count);
});

test.each(["running", "permission", "capacity"])("a lost grouped dispatch receipt observes %s before any retry", async mode => {
  const host = fixture(); host.setLimit(1);
  let closeKey = "";
  host.setLaunchRespond((request, normal) => {
    if (request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "close") {
      closeKey = request.key;
      throw Error("Native transport disappeared");
    }
    return normal();
  });
  host.setStatus(ref => {
    if (ref !== closeKey) return host.native.get(ref) ?? { ok: true, state: "unknown" };
    if (mode === "permission") throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
    if (mode === "capacity") throw Error("Active async run capacity exhausted: 1/1 used.");
    return { ok: true, runId: ref, state: "running" };
  });
  expect((await host.execute()).status).not.toBe("complete");
  expect(host.statusCalls).toContain(closeKey);
  expect(host.launches.filter(call => call.key.startsWith(closeKey))).toHaveLength(1);
});

test.each(["structured", "management"])("pending grouped seal observes its exact close run with %s status", async mode => {
  const host = fixture(); host.setLimit(1);
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    return request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "close"
      ? { ...result, stopped: true } : result;
  });
  expect((await host.execute()).status).toBe("cancelled");
  const close = host.current().inFlight.find((ref: { key: string }) => ref.key === host.current().action.opKey);
  expect(close).toMatchObject({ role: "loop-io", runId: nativeRunId(host.current().action.opKey) });
  const count = host.launches.length;
  host.setStatus(ref => ref === close.runId ? mode === "structured"
    ? { ok: true, runId: ref, agent: "pitako.loop-io", state: "running" }
    : { ok: true, output: `Run: ${ref}\nState: running`, results: [] }
    : host.native.get(ref) ?? { ok: true, state: "unknown" });
  expect((await host.execute()).status).toBe("blocked");
  expect(host.statusCalls).toContain(close.runId);
  expect(host.launches).toHaveLength(count);
});

test.each(["close", "drain"])("an interrupted %s retry observes the in-flight retry rather than its failed predecessor", async operation => {
  const host = fixture(); host.setLimit(1);
  let operationKey = "";
  let retryRunning = false;
  host.setLaunchRespond((request, normal) => {
    if (request.agent !== "pitako.loop-io" || JSON.parse(request.task).operation !== operation) return normal();
    operationKey ||= request.key;
    if (request.key === operationKey) return {
      ...host.result(request, {}), ok: false, key: request.key,
      output: JSON.stringify({ error: "loop-io", reason: "Transient close failure" }),
    };
    retryRunning = true;
    throw Error("Native transport disappeared while retry is running");
  });
  host.setStatus(ref => retryRunning && [`${operationKey}.r1`, nativeRunId(`${operationKey}.r1`)].includes(ref)
    ? { ok: true, runId: nativeRunId(`${operationKey}.r1`), agent: "pitako.loop-io", state: "running" }
    : host.native.get(ref) ?? { ok: true, state: "unknown" });
  expect((await host.execute()).status).toBe("blocked");
  const count = host.launches.length;
  expect(host.current().action).toMatchObject({ kind: "pending", op: operation, opKey: operationKey });
  expect(host.launches.filter(call => call.key.startsWith(operationKey)).map(call => call.key))
    .toEqual([operationKey, `${operationKey}.r1`]);
  const observed = host.statusCalls.length;
  expect((await host.execute()).status).toBe("blocked");
  expect(host.statusCalls.slice(observed)).toContain(nativeRunId(`${operationKey}.r1`));
  expect(host.launches).toHaveLength(count);
  expect(host.records().filter((record: any) => record.kind === "unit")).toEqual([]);
});

test("a saved close transport cannot admit a candidate changed before replay", async () => {
  const host = fixture({ realCheckout: true }); host.setLimit(1);
  const closeKey = cutAfterGroupedClose(host);
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  expect(host.current().action).toMatchObject({ kind: "pending", op: "close" });
  expect((committedClose(host, closeKey()).body as { result: { steps: { operation: string }[] } })
    .result.steps.map(step => step.operation))
    .toContain("gate");
  const count = host.launches.length;
  host.setFailSave();
  host.changeCheckout();
  const result = await host.execute();
  expect(result.status, result.reason).toBe("blocked");
  expect(result.reason).toContain("Current candidate differs from the saved close gate receipt");
  expect(host.current().halt.stage).toBe("recovery");
  expect(host.launches.slice(count).map(call => call.key)).toEqual([`${closeKey()}.r1`]);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
  expect(host.current().loop.attempt.stage).not.toBe("result");
  expect(host.records()).toEqual([]);
});

function cutAfterGroupedClose(host: ReturnType<typeof fixture>) {
  let key = "";
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (!key && request.agent === "pitako.loop-io" && JSON.parse(request.task).operation === "close" && result.ok) key = request.key;
    return result;
  });
  host.setFailSave(() => !!key);
  return () => key;
}
function committedClose(host: ReturnType<typeof fixture>, key: string) {
  const cursor = host.current();
  const { store, scope } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
  const row = store.readRecords(scope).records.find(row => row.kind === "receipt" && (row.body as { key: string }).key === key);
  if (!row) throw new Error(`Missing committed close ${key}`);
  return row;
}

test("a cut after grouped sealing reuses the receipt without another close or worker", async () => {
  const host = fixture(); host.setLimit(1);
  const closeKey = cutAfterGroupedClose(host);
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const sealed = committedClose(host, closeKey());
  const count = host.launches.length;
  host.setFailSave();
  const result = await host.execute();
  expect(result.status, result.reason).toBe("partial");
  const [reconstruction, ...resumed] = host.launches.slice(count);
  expect(reconstruction).toMatchObject({ agent: "pitako.loop-io", key: `${closeKey()}.r1` });
  expect(JSON.parse(reconstruction!.task).refs.committed).toBe(true);
  expect(resumed.every(call => call.agent === "pitako.loop-io" && JSON.parse(call.task).operation === "drain")).toBe(true);
  expect(committedClose(host, closeKey())).toEqual(sealed);
  expect(host.records().map((record: any) => record.kind)).toEqual(["spec", "loop"]);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  expect(result.loopReport.work).toContainEqual(expect.objectContaining({ taskId: "change1", attempt: 1, status: "complete" }));
});
