import { expect, test } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeControllerFixture, copy, gaps, source } from "./fixtures/execute-workflow.ts";
import { readBacklog } from "../skills/execute/loop.ts";
import { digest } from "../extensions/spec-plans.ts";
import { EXECUTE_CURSOR_KEY, EXECUTE_CURSOR_MAX_BYTES, validateExecuteCursor } from "../extensions/execute-cursor.ts";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";
const { executeStore, canonicalJSON, executeProjection, fullExecuteProjection } = await import("../skills/execute/ledger.mjs");

const { fixture } = executeControllerFixture();

function retainedStore(host: ReturnType<typeof fixture>, cursor = host.current()) {
  const { store, scope } = executeStore(host.root, cursor.invocation);
  return store.read(scope, cursor.head);
}

function expectFullProjection(host: ReturnType<typeof fixture>) {
  const retained = retainedStore(host);
  expect(canonicalJSON(retained.P)).toBe(canonicalJSON(fullExecuteProjection(retained.records)));
  for (let end = 0; end < retained.records.length; end++) {
    const rows = retained.records.slice(0, end);
    expect(canonicalJSON(executeProjection(rows))).toBe(canonicalJSON(fullExecuteProjection(rows)));
  }
}

test("a committed blocked pause holds without another child or effect", async () => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => request.agent === "pitako.worker"
    ? host.result(request, { ...host.worker(request, "pause"), status: "blocked", remaining: ["Human answer needed"] })
    : normal());
  const paused = await host.execute();
  expect(paused.status, paused.reason).toBe("blocked");
  const cursor = copy(host.current()), records = retainedStore(host).records;
  const launches = host.launches.length;
  const replayed = await host.execute();
  expect(replayed.status, replayed.reason).toBe("blocked");
  expect(replayed.reason).toBe(paused.reason);
  expect(host.current().budget).toEqual(cursor.budget);
  expect(host.current().halt).toEqual(cursor.halt);
  expect(retainedStore(host).records).toEqual(records);
  expect(host.launches).toHaveLength(launches);
  validateExecuteCursor(EXECUTE_CURSOR_KEY, host.current());
  expectFullProjection(host);
});

test("30 single-task loops retain constant state across recoveries", async () => {
  const host = fixture(undefined, { taskCount: 30, retainSnapshots: false }); host.setLimit(30);
  let admittedHead = 0;
  const cursorErrors = new Set<string>();
  let peakBytes = 0;
  host.setSaveObserver(value => {
    // Record failures without throwing into the root's persistence/recovery path.
    try { validateExecuteCursor(EXECUTE_CURSOR_KEY, value); }
    catch (error) { cursorErrors.add(String(error)); }
    peakBytes = Math.max(peakBytes, Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: value }, null, 2)));
    expect(value).not.toHaveProperty("loops");
    expect(value).not.toHaveProperty("tasks");
    expect(value).not.toHaveProperty("lastConfirmed");
    admittedHead = Math.max(admittedHead, value.head.seq);
  });
  const originals = new Map<number, any>();
  host.setRespond((request, normal) => {
    const number = Number(request.key.match(/\.l(\d+)\./)![1]);
    if (request.agent === "pitako.execution-inspector")
      return host.result(request, { status: "recovered", reason: "Exact original plan",
        original: originals.get(number), workerResult: null, originalAvailable: true,
        binding: "absent", comparison: "only-original", provenance: ["/native/plan"] });
    const result = normal();
    if (request.agent === "pitako.execution-director") {
      originals.set(number, copy(result.structuredOutput)); delete result.structuredOutput;
    }
    return request.key.endsWith(".compliance") ? gaps(result) : result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  const records = host.records(); // verifies every link against state's head
  expect(records.filter((record: any) => record.kind === "loop").map((record: any) => record.loop))
    .toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
  const units = records.filter((record: any) => record.kind === "unit");
  expect(units).toHaveLength(30);
  const retained = retainedStore(host);
  expect(JSON.stringify(retained.records)).not.toContain('"P":');
  expect(retained.records.filter(row => row.kind === "ledger").every(row => row.seq <= admittedHead)).toBe(true);
  expect(new Set(units.map((record: any) => `${record.loop}:${record.body.checkpoint.digest}`)).size).toBe(30);
  expect([...host.storage.keys()]).toEqual([EXECUTE_CURSOR_KEY]);
  expect([...cursorErrors]).toEqual([]);
  expect(peakBytes).toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);
  const { P } = retained;
  expect(P.preview.planRejections).toHaveLength(3);
  expect(P.preview.closeReferences).toHaveLength(3);
  expect(P.preview.loopSummaries).toHaveLength(3);
  expect(canonicalJSON(P)).toBe(canonicalJSON(fullExecuteProjection(retained.records)));
  expect(host.calls.filter(call => call.agent === "pitako.execution-inspector")).toHaveLength(30);
  // inspect-initial is the configured pre-admission host grant, before any loop exists.
  // inspect-initial.r1 repeats that fixed pure grant before any loop exists.
  // inspect-initial.r2 repeats that fixed pure grant before any loop exists.
  for (const reference of [...host.calls.map(call => call.key), ...host.statusCalls, ...host.hostCalls]) {
    if (["inspect-initial", "inspect-initial.r1", "inspect-initial.r2"].includes(reference)) continue;
    const key = host.native.has(reference)
      ? host.calls.find(call => host.native.get(call.key)?.runId === reference)?.key ?? reference : reference;
    expect(key).toMatch(/\.l\d+\./);
  }
}, 20_000); // Human decision m01583: AGENTS.md timeout exception for the 30-loop workload.

test.each([
  ["an unknown selection", (selection: any) => { selection.select = "missing"; }, "Selected task must be pending"],
  ["an unfinished dependency", (selection: any) => {
    const task = copy(selection.changes[0].task); task.id = "prerequisite";
    selection.changes.push({ kind: "add", task, reason: "Required prerequisite" });
    selection.changes[0].task.dependsOn = [task.id];
  }, "Selected task has unfinished dependencies"],
  ["premature final selection", (selection: any) => { selection.select = null; }, "Invalid final selection: unfinished tasks remain"],
] as const)("the root rejects %s before any worker runs", async (_name, mutate, rejection) => {
  const host = fixture(); host.setLimit(2);
  host.setRespond((request, normal) => {
    const result = normal();
    if (/^invoke-human-1\.l1\.director(?:\.d1)?$/.test(request.key)) mutate(result.structuredOutput);
    return result;
  });
  expect((await host.execute()).status).toBe("partial");
  expect(host.calls.some(call => call.key.startsWith("invoke-human-1.l1.t"))).toBe(false);
  expect(host.calls.find(call => call.key === "invoke-human-1.l2.director")!.task).toContain(rejection);
});

test("a gaps publisher delivers its verified rejection summary to the very next director", async () => {
  const host = fixture(undefined, { readOnly: true }); host.setLimit(2);
  host.setRespond((request, normal) => {
    const result = normal();
    if (/^invoke-human-1\.l1\.director(?:\.d1)?$/.test(request.key)) result.structuredOutput.select = "missing";
    return result;
  });
  const output = await host.execute();
  expect(output.status).toBe("partial");
  const next = host.calls.find(call => call.key === "invoke-human-1.l2.director")!;
  expect(next.task).toContain("Selected task must be pending");
  const { P } = retainedStore(host);
  expect(next.task).toContain(JSON.stringify(P.preview.loopSummaries[0]));
  expect(next.task).toContain('"ledgerPath":');
  const worker = host.calls.find(call => call.agent === "pitako.worker")!;
  expect(worker.task).toContain(JSON.stringify(P.preview.loopSummaries[0]));
  expect(worker.task).toContain('"ledgerPath":');
  expect(worker.task).toContain("ledger.mjs");
  expect(host.calls.some(call => call.key.includes(".review.") || call.key.endsWith(".compliance"))).toBe(false);
  expect(output.loopReport.history).toEqual({ summaries: P.preview.loopSummaries,
    ledgerPath: `${host.root}/.pi/subagents/execute/human-1`,
    head: digest(canonicalJSON(host.records().at(-1))) });
  expect(host.current()).not.toHaveProperty("loops");
});

test.each([4, 5])("selection rejection ring remembers three loops, not all history (repeat at %s)", async repeat => {
  // This checks the rejection ring, not checkpoint filesystem operations.
  const host = fixture(undefined, { taskCount: 6 }); host.setLimit(6);
  host.setRespond((request, normal) => {
    const number = Number(request.key.match(/\.l(\d+)\./)![1]), result = normal();
    if (request.agent === "pitako.execution-director" && [1, repeat].includes(number))
      result.structuredOutput.select = "missing";
    return result;
  });
  expect((await host.execute()).status).toBe("partial");
  const { P } = retainedStore(host);
  expect(P.preview.planRejections.map((item: any) => item.loop)).toEqual([4, 5, 6]);
  expect(P.preview.planRejections.filter((item: any) => item.diagnostic)).toEqual([
    { loop: repeat, diagnostic: "Selected task must be pending" },
  ]);
});

test.each([4, 5])("native closing references ring rejects only last three loops (reuse at %s)", async repeat => {
  const host = fixture(undefined, { taskCount: 0 }); host.setLimit(repeat);
  let original: any;
  host.setRespond((request, normal) => {
    const number = Number(request.key.match(/\.l(\d+)\./)![1]), result = normal();
    if (request.agent === "pitako.execution-director") Object.assign(result.structuredOutput, { select: null,
      changes: (readBacklog(host.root, "spec").backlog?.tasks ?? []).filter(task => task.status === "pending")
        .map(task => ({ kind: "obsolete", id: task.id, reason: "Controlled duplicate finding; exercise final closing identity" })) });
    if (request.agent === "pitako.checkout-observer") {
      if (number === 1) original = copy(result);
      if (number === repeat) Object.assign(result, { runId: original.runId, asyncDir: original.asyncDir,
        externalAdapter: original.externalAdapter });
    }
    if (request.key.endsWith(".compliance")) return gaps(result);
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe(repeat === 4 ? "blocked" : "partial");
  if (repeat === 4) expect(output.reason).toContain("reuses another loop");
  else {
    expect(retainedStore(host).P.preview.closeReferences.map((item: any) => item.loop), output.reason).toEqual([3, 4, 5]);
    // Later publications must not change the projection visible at a saved closing head.
    const closed = host.snapshots.filter(cursor => cursor.loop?.phase === "finished");
    expect(new Set(closed.map(cursor => cursor.loop.number))).toEqual(new Set([1, 2, 3, 4, 5]));
    for (const cursor of closed) {
      const { P, records } = retainedStore(host, cursor);
      expect(P.preview.closeReferences.at(-1)?.loop).toBe(cursor.loop.number);
      expect(records.at(-1)?.digest).toBe(cursor.head.hash);
    }
  }
});

const checkoutDefects = ["producer", "publication", "exit", "save", "results", "stdout", "json",
  "keys", "root", "commonDir", "closeReference"];
test.each([...[true, false].flatMap(committed =>
  ["none", "compliance-body", "compliance-missing", "compliance-producer", "compliance-settlement",
    "compliance-unsettled", "compliance-no-journal", "compliance-truncated", "review-body", "review-missing"]
    .map(mutation => ({ committed, mutation }))),
  { committed: true, mutation: "closing-unsettled" },
  ...checkoutDefects.map(defect => ({ committed: false, mutation: `checkout-${defect}` }))])(
  "closing rebuilds identical bytes after a save cut; %j", async ({ committed, mutation }) => {
  const host = fixture(undefined, { taskCount: 0 });
  host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director") Object.assign(result.structuredOutput, { select: null, changes: [] });
    return result;
  });
  host.setFailSave(value => {
    if (value.loop?.phase !== "closing") return false;
    if (!committed) return true;
    const { store, scope } = executeStore(host.root, value.invocation);
    return store.read(scope, value.head).P.preview.closeReferences.some(ref => ref.loop === value.loop.number);
  });
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const request = host.calls.find(call => call.agent === "pitako.checkout-observer")!;
  const { store, scope } = executeStore(host.root, host.current().invocation);
  const published = [...store.read(scope).records].reverse().find(row => row.kind === "ledger");
  const original = published ? canonicalJSON(published) : null;
  expect(host.current().action).toMatchObject({ kind: "launched", role: "reviewer" });
  expect(host.current().action.key).toEndWith(".compliance");
  expect(host.current().loop).not.toHaveProperty("archivePending");
  const compliance = host.native.get(host.current().action.key)!;
  const launches = host.launches.length;
  const beforeReplay = store.read(scope).records;
  const retained = copy(host.current());
  host.setFailSave();
  const invalidCheckout = mutation.startsWith("checkout-");
  const missingUsage = ["compliance-unsettled", "compliance-no-journal", "compliance-truncated",
    "closing-unsettled"].includes(mutation);
  if (invalidCheckout) host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (request.agent !== "pitako.checkout-observer") return result;
    const defect = mutation.slice("checkout-".length);
    if (defect === "producer") result.agent = "pitako.worker";
    if (defect === "publication") delete result.externalAdapter;
    if (defect === "exit") result.results![0]!.exitCode = 1;
    if (defect === "save") result.metadataSaveError = "Controlled failed publication";
    if (defect === "results") result.results = [];
    if (defect === "stdout") result.output = " ".repeat(61441);
    if (defect === "json") result.output = "{";
    if (["keys", "root", "commonDir", "closeReference"].includes(defect)) {
      const observation = JSON.parse(result.output!);
      if (defect === "keys") observation.extra = true;
      if (defect === "root") observation.root = "/another-root";
      if (defect === "commonDir") observation.commonDir = "/another-common-dir";
      if (defect === "closeReference") observation.store.P.preview.closeReferences = [];
      result.output = JSON.stringify(observation);
    }
    return result;
  });
  if (mutation === "compliance-body") writeFileSync(compliance.results![0]!.structuredOutputPath!,
    JSON.stringify({ ...compliance.structuredOutput, reason: "Changed during closing" }));
  if (mutation === "compliance-missing") unlinkSync(compliance.results![0]!.structuredOutputPath!);
  if (["none", "compliance-producer", "compliance-settlement"].includes(mutation) || missingUsage) {
    const missionPath = store.read(scope).P.prompt.admission!.association.missionPath;
    const mission = JSON.parse(readFileSync(missionPath, "utf8"));
    const child = mission.workflowChildren.find((child: any) => child.key === host.current().action.key);
    const directory = child.artifactPaths.find((file: string) => path.basename(file) === child.runId);
    const statusFile = path.join(directory, "status.json");
    const status = JSON.parse(readFileSync(statusFile, "utf8"));
    expect(status.steps[0]).not.toHaveProperty("usage");
    if (mutation === "compliance-producer")
      writeFileSync(statusFile, JSON.stringify({ ...status, workflowKey: "another-compliance" }));
    if (mutation === "compliance-settlement" || missingUsage) {
      const journal = path.join(path.dirname(directory), status.parentWorkflowRunId, "workflow-children.jsonl");
      const lines = readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
      for (const line of lines) if (line.type === "settle" && line.key === host.current().action.key) {
        if (mutation === "compliance-settlement")
          line.result.structuredOutput = { ...line.result.structuredOutput, reason: "Conflicting settlement" };
      }
      if (mutation === "compliance-no-journal") unlinkSync(journal);
      else {
        const unsettledKeys = mutation === "closing-unsettled" ? [child.key, request.key]
          : mutation === "compliance-unsettled" ? [child.key] : [];
        const removed = (line: any) => line.type === "settle" && unsettledKeys.includes(line.key);
        if (mutation === "closing-unsettled")
          expect(new Set(lines.filter(removed).map(line => line.key))).toEqual(new Set(unsettledKeys));
        writeFileSync(journal, lines.filter(line => !removed(line))
          .map(line => mutation === "compliance-truncated" && line.type === "settle" &&
            line.key === child.key ? '{"type":"settle",' : JSON.stringify(line)).join("\n") + "\n");
      }
    }
  }
  const seed = [...beforeReplay].reverse().find(row => row.kind === "review-originals" &&
    row.body !== null && typeof row.body === "object" && "archiveSeed" in row.body && row.body.archiveSeed)!.body;
  if (!seed || typeof seed !== "object" || !("archiveSeed" in seed) ||
      !seed.archiveSeed || typeof seed.archiveSeed !== "object" || !("input" in seed.archiveSeed) ||
      !seed.archiveSeed.input || typeof seed.archiveSeed.input !== "object" ||
      !("seq" in seed.archiveSeed.input) || !("digest" in seed.archiveSeed.input) ||
      !("complianceKey" in seed.archiveSeed) || !("originals" in seed) || !Array.isArray(seed.originals))
    throw new Error("Expected committed review originals and closing seed.");
  const expectedRequest = JSON.stringify({ invocation: host.current().invocation,
    storeId: host.current().storeId, input: { seq: seed.archiveSeed.input.seq, digest: seed.archiveSeed.input.digest },
    compliance: { key: seed.archiveSeed.complianceKey, runId: compliance.runId } });
  if (committed) expect(request.task).toBe(expectedRequest);
  const review = seed.originals[0];
  if (mutation === "review-body") writeFileSync(review.path, "{}");
  if (mutation === "review-missing") unlinkSync(review.path);
  const output = await host.execute();
  if (invalidCheckout) {
    expect(output.status).toBe("blocked");
    expect(output.reason).toMatch(/closing|Closing/);
    expect(host.current()).toEqual(retained);
    // The observer may have committed, but invalid terminal evidence cannot advance the root.
    expect(store.read(scope).records.filter(row => row.kind === "ledger")
      .flatMap((row: any) => row.body.entries)).toHaveLength(2);
  } else if (mutation !== "none" && !missingUsage) {
    expect(output.status).toBe("blocked");
    expect(output.reason).toContain("integrity");
    expect(store.read(scope).records).toEqual(beforeReplay);
  } else {
    expect(output.status, output.reason).toBe("complete");
    expect(host.records()).toHaveLength(2);
    const archive = host.records().find((row: any) => row.kind === "loop")!.body;
    expect(archive.usage).toContainEqual({ id: `${compliance.runId}:0`,
      tokens: missingUsage && !committed ? null : 20 });
  }
  // Board topic 208 HUMAN #3415(f): one recovery read, no model or publication replay.
  const added = host.launches.slice(launches);
  if (committed) {
    expect(added.map(call => call.agent)).toEqual(["pitako.loop-advance"]);
    expect(added[0].key).toMatch(/\.r\d+$/);
    expect(host.calls.filter(call => call.agent === "pitako.checkout-observer")).toEqual([request]);
    expect(canonicalJSON(store.read(scope).records.find(row => row.seq === published!.seq))).toBe(original!);
  } else {
    expect(added.map(call => call.agent)).toEqual(mutation === "none" || missingUsage
      ? ["pitako.checkout-observer", "pitako.loop-drain"] : ["pitako.checkout-observer"]);
    expect(added[0].key).toBe("invoke-human-1.l1.checkout");
    expect(added[0].task).toBe(expectedRequest);
    expect(added.some(call => /\.r\d+$/.test(call.key))).toBe(false);
  }
  expect(added.some(call => pitakoAgentFamily(call.agent) === "reviewer")).toBe(false);
  for (const cursor of host.snapshots) {
    validateExecuteCursor(EXECUTE_CURSOR_KEY, cursor);
    expect(Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: cursor }, null, 2)))
      .toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);
  }
});

test("admission amendments reach every phase without the director copying them into the plan", async () => {
  const host = fixture();
  const amendments = [{ path: "/worktree/.pitako/amendments/human.md", sha256: "a".repeat(64),
    provenance: "human message h1 at 2026-10-31T06:12:50Z" }];
  // The fixture director paraphrases nothing and omits amendments from sharedContext entirely.
  const output = await host.execute({ amendments });
  expect(output.status, output.reason).toBe("complete");
  const admitted = retainedStore(host).records.find(row => row.kind === "root-admission")?.body;
  if (!admitted || typeof admitted !== "object" || !("amendments" in admitted))
    throw new Error("Expected committed admission amendments.");
  expect(admitted.amendments).toEqual(amendments);
  expect(host.current()).not.toHaveProperty("amendments");
  // The model-free access verifier receives only originals to compare, not model context.
  const phases = host.calls.filter(call => /\.director$|\.t\d+\.a\d+$|\.compliance$|\.review\./.test(call.key) && call.agent !== "pitako.originals-verifier");
  for (const pattern of [/\.director$/, /\.t\d+\.a\d+$/, /\.compliance$/, /\.review\./])
    expect(phases.some(call => pattern.test(call.key))).toBe(true);
  for (const call of phases) expect(call.task, call.key).toContain(JSON.stringify(amendments));
});


test("selection keeps Board views in the store and delivers them without retaining bodies in cursors", async () => {
  const ruling = "Preserve the admitted error-path requirement.";
  const host = fixture(undefined, { humanPosts: [{ id: 1, type: "HUMAN", content: ruling }] });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  expect(host.calls.filter(call => call.key === "invoke-human-1.l1.selection")).toHaveLength(1);
  for (const agent of ["pitako.execution-director", "pitako.worker"])
    expect(host.calls.find(call => call.agent === agent)!.task).toContain(ruling);
  const selected = host.snapshots.find(cursor => cursor.loop?.taskId === "change1" &&
    cursor.loop.attempt?.stage === "launched")!;
  expect(selected).toBeDefined();
  const { P, records } = retainedStore(host, selected);
  expect(P.preview.view!.items).toContainEqual(expect.objectContaining({ type: "HUMAN", content: ruling }));
  const selection = records.find(row => row.kind === "marker" && row.body !== null &&
    typeof row.body === "object" && "operation" in row.body && row.body.operation === "apply")?.body;
  if (!selection || typeof selection !== "object" || !("result" in selection) ||
      !selection.result || typeof selection.result !== "object" || !("view" in selection.result) ||
      !selection.result.view || typeof selection.result.view !== "object" || !("posts" in selection.result.view))
    throw new Error("Expected committed selection Board view.");
  expect(selection.result.view.posts).toContainEqual(expect.objectContaining({ type: "HUMAN", content: ruling }));
  for (const cursor of host.snapshots) {
    validateExecuteCursor(EXECUTE_CURSOR_KEY, cursor);
    expect(cursor).not.toHaveProperty("currentView");
    expect(cursor.loop).not.toHaveProperty("selection");
    expect(JSON.stringify(cursor)).not.toContain(ruling);
  }
  let settlements = 0;
  // Settlement is drained with the grouped transport, not retained inline.
  for (const call of host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io")) {
    const input = JSON.parse(call.task);
    const keys = new Set((input.intentions ?? []).filter((entry: any) => entry.operation === "apply").map((entry: any) => entry.key));
    const output = host.native.get(call.key)?.output;
    if (!output || !keys.size) continue;
    const projection = JSON.parse(output).projection;
    const steps = (projection?.steps ?? []).flatMap((step: any) =>
      step.operation === "drain" ? step.result.projection.steps : [step]);
    for (const step of steps) if (keys.has(step.key)) {
      settlements++;
      expect(step.result).not.toHaveProperty("view");
    }
  }
  expect(settlements).toBeGreaterThan(0);
});

test.each(["cancellation", "finalGaps"])("%s projections discard their unused view", async slot => {
  const host = fixture(undefined, { taskCount: slot === "finalGaps" ? 0 : 1 }); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (slot === "cancellation" && request.agent === "pitako.request-observer") {
      const page = JSON.parse(result.output!);
      page.requests = [{ v: 1, requestId: "cancel-1", invocation: "human-1", taskId: "change1", kind: "cancel", origin: "model" }];
      result.output = JSON.stringify(page);
    }
    return slot === "finalGaps" && request.key.endsWith(".compliance") ? gaps(result) : result;
  });
  expect((await host.execute()).status).toBe("partial");
  // Read the published drain, not the removed inline v9 receipt slot.
  const receipts = host.launches.filter(call => pitakoAgentFamily(call.agent) === "loop-io").flatMap(call => {
    const output = host.native.get(call.key)?.output;
    if (!output) return [];
    const transport = JSON.parse(output).projection;
    if (!transport) return [];
    const steps = transport.steps.flatMap((step: any) =>
      step.operation === "drain" ? step.result.projection.steps : [step]);
    return steps.filter((step: any) => step.operation === "apply" &&
      (slot === "cancellation" ? /\.cancel-\d+$/.test(step.key) : step.key.endsWith(".final-gaps")))
      .map((step: any) => step.result);
  });
  expect(receipts.length).toBeGreaterThan(0);
  for (const receipt of receipts) expect(receipt).not.toHaveProperty("view");
  for (const cursor of host.snapshots) {
    validateExecuteCursor(EXECUTE_CURSOR_KEY, cursor);
    expect(cursor.loop).not.toHaveProperty(slot);
  }
});

test("a final review with production-sized originals and native metadata retains only a bounded execute cursor", async () => {
  // Eleven completed tasks and four mirrored reviews with large originals and native debug metadata.
  const host = fixture(undefined, { taskCount: 11, findings: true, retainSnapshots: false });
  host.setLimit(12);
  let peakBytes = 0;
  host.setSaveObserver(value => {
    peakBytes = Math.max(peakBytes, Buffer.byteLength(JSON.stringify({ [EXECUTE_CURSOR_KEY]: value }, null, 2)));
  });
  const pad = (label: string, size: number) => `${label}:` + "x".repeat(size);
  host.setRespond((request, normal) => {
    const result = normal(), value = result.structuredOutput;
    if (request.key === "invoke-human-1.l1.director")
      for (const change of value.changes) change.task.goal = pad(change.task.goal, 1600);
    if (request.key.includes(".review.independent-")) value.coverage = pad(request.key, 12 * 1024);
    if (request.key.endsWith(".review.director-synthesis")) value.memo = pad(request.key, 17 * 1024);
    return result;
  });
  const debug = (key: string) => Array.from({ length: 3 }, (_, index) =>
    `/native/sessions/--long-session-directory-name-for-a-production-sized-run--/subagent-artifacts/${key}/debug-${index}.jsonl`);
  host.setLaunchRespond(async (request, normal) => {
    const result = await normal();
    if (!request.key.includes(".review.") || pitakoAgentFamily(request.agent) !== "reviewer") return result;
    const acceptance = { status: "not-required", evidenceStatus: "not-required", explicit: false,
      effectiveAcceptance: { level: "none", explicit: false, inferredReason: ["declared read-only acceptance role"],
        criteria: [], evidence: [], verify: [], stopRules: [] },
      inferredReason: ["declared read-only acceptance role"], criteria: [], runtimeChecks: [], verifyRuns: [] };
    const [inputPath, outputPath, jsonlPath] = debug(request.key);
    return { ...result, artifactPaths: debug(request.key), results: result.results?.map(item => ({ ...item, acceptance,
      artifactPaths: { inputPath, outputPath, jsonlPath, transcriptPath: jsonlPath, metadataPath: outputPath } })) } as any;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("complete");
  expect(peakBytes).toBeLessThanOrEqual(EXECUTE_CURSOR_MAX_BYTES);
  expect([...host.storage.keys()]).toEqual([EXECUTE_CURSOR_KEY]);
  validateExecuteCursor(EXECUTE_CURSOR_KEY, host.storage.get(EXECUTE_CURSOR_KEY));
  expect(host.current().action.kind).toBe("terminal");
  const { store, scope } = executeStore(host.root, host.current().invocation);
  const rows = store.read(scope, host.current().head).records;
  const originals = rows.filter((row: any) => row.kind === "review-originals")
    .flatMap((row: any) => row.body.originals);
  expect(originals.some((original: any) => original.body.coverage?.length > 12 * 1024)).toBe(true);
  expect(originals.some((original: any) => original.body.memo?.length > 17 * 1024)).toBe(true);
  expect(JSON.stringify(host.current())).not.toContain("subagent-artifacts");
}, 20_000);
