import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { apply, backlogPath, boardView, currentHumanPostIds, gate, metricBefore, parseMetric, prepare, readBacklog, runCommand, topicOwner, updateProgress, validateBacklog, type Backlog, type GateInput, type Progress, type Task } from "../skills/execute/loop.ts";
import { openBoard, viewEntry, BINDING_BAND_BYTES, GATE_RESERVE, viewBudget } from "../extensions/board/store.ts";
import { recordContextPeak, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { repositoryIdentity } from "../extensions/board/workspace.ts";

const { canonicalDigest } = createRequire(import.meta.url)("../extensions/canonical.mjs") as { canonicalDigest(value: unknown): string };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-execute-loop-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe", env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q"); writeFileSync(path.join(root, "product"), "original"); writeFileSync(path.join(root, ".gitignore"), "cache/\n");
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial");
  return { root, previousConfirmedUnit: null, dbPath: path.join(root, ".pi/board.db"), specId: "example" };
}
const authority = { specDigest: "a".repeat(64), amendmentDigests: [] };
const empty: Progress = { nonImproving: 0, last5: [] };
function task(id = "one"): Task {
  return { id, title: `Implement ${id}`, goal: `Implement ${id}`, expectedResult: "Observable result", status: "pending", origin: { kind: "spec", ref: "spec" },
    specRefs: ["Acceptance 2"], dependsOn: [], gates: [{ id: "focused", command: "printf passed", cwd: ".", timeoutMs: 1000 }], metric: null,
    parent: null, remaining: "", progress: structuredClone(empty), history: [] };
}
function initial(root: string, tasks = [task()]) {
  return { root, specId: "example", expectedDigest: null, key: "first", invocation: "exec1", loop: 1, authority,
    acceptance: [{ id: "full", command: "true", cwd: "." }], director: { select: tasks[0]!.id, reason: "Most important", changes: tasks.map(t => ({ kind: "add" as const, task: t, reason: "From spec" })) } };
}
function attempt(f: ReturnType<typeof fixture>, overrides: Partial<GateInput> = {}): GateInput {
  return { ...f, invocation: "exec1", loop: 1, attempt: 1, key: "attempt1", task: task(), workerStatus: "complete", writerSettled: true, ...overrides };
}

test("backlog schema errors name the file, preserve bytes and never repair human edits", () => {
  const { root } = fixture(); const applied = apply(initial(root)); validateBacklog(applied.backlog);
  const invalid = structuredClone(applied.backlog); invalid.tasks[0]!.remaining = "é".repeat(513);
  writeFileSync(applied.path, JSON.stringify(invalid)); const before = readFileSync(applied.path, "utf8");
  expect(() => readBacklog(root, "example")).toThrow(applied.path);
  expect(() => readBacklog(root, "example")).toThrow("remaining"); expect(readFileSync(applied.path, "utf8")).toBe(before);
  for (const bad of [null, { ...applied.backlog, version: 2 }, { ...applied.backlog, tasks: [task(), task()] },
    { ...applied.backlog, tasks: [{ ...task(), metric: { command: "true", unit: "count", target: Infinity } }] },
    { ...applied.backlog, tasks: [{ ...task(), dependsOn: ["missing"] }] },
    { ...applied.backlog, tasks: [{ ...task(), history: Array(9).fill({ invocation: "e", loop: 1, event: "add", reason: "spec" }) }] }]) {
    expect(() => validateBacklog(bad)).toThrow();
  }
});

test.each(["spec", "director", "final-phase", "human"] as const)("new %s origins enforce a UTF-8 byte cap", kind => {
  const { root } = fixture(), value = task();
  value.origin = { kind, ref: "é".repeat(257) };
  expect(() => apply(initial(root, [value]))).toThrow("512 UTF-8 bytes");
  expect(readBacklog(root, "example").backlog).toBeNull();
  value.origin.ref = "é".repeat(256);
  const request = initial(root, [value]), applied = apply(request);
  expect(applied.selected!.origin.ref).toBe(value.origin.ref);
  expect(apply(request).replay).toBe(true);
});

test("unchanged legacy origins survive updates, but split and cancellation writers cannot exceed the cap", () => {
  const { root } = fixture(), first = apply(initial(root));
  const legacy = structuredClone(first.backlog!); legacy.tasks[0]!.origin.ref = "é".repeat(1000);
  writeFileSync(first.path, JSON.stringify(legacy));
  const current = readBacklog(root, "example");
  const request = { ...initial(root), key: "legacy", expectedDigest: current.digest,
    director: { select: "one", changes: [{ kind: "update" as const, id: "one", patch: { goal: "Updated legacy task" }, reason: "Code evidence" }], reason: "Continue legacy task" } };
  const updated = apply(request);
  expect(updated.selected!.origin).toEqual(legacy.tasks[0]!.origin);
  expect(apply(request).replay).toBe(true);
  const next = { ...initial(root), key: "next", expectedDigest: updated.digest };
  const child = task("child"); child.origin.ref = "x".repeat(513);
  expect(() => apply({ ...next, director: { select: "child", reason: "Split", changes: [{ kind: "split", id: "one", tasks: [child], reason: "Split" }] } })).toThrow("512 UTF-8 bytes");
  expect(() => apply({ ...next, director: { select: null, changes: [], reason: "Cancel" },
    cancellations: [{ taskId: "one", requestId: "é".repeat(257), origin: "main", kind: "cancel" }] })).toThrow("512 UTF-8 bytes");
  expect(readBacklog(root, "example").digest).toBe(updated.digest);
  const cancelled = apply({ ...next, director: { select: null, changes: [], reason: "Cancel" },
    cancellations: [{ taskId: "one", requestId: "é".repeat(256), origin: "main", kind: "cancel" }] });
  expect(cancelled.backlog!.tasks[0]!.origin.ref).toBe("é".repeat(256));
});

test("final-gap recording hashes the finding output, bounds the completed origin and replays without rereading it", () => {
  const { root } = fixture(), first = apply({ ...initial(root), director: { select: null, changes: [], reason: "Final phase" } });
  const file = path.join(root, "finding.json"); writeFileSync(file, '{"reason":"missing behavior"}');
  const value = task("gap"); value.origin = { kind: "final-phase", ref: "pending output hash" };
  const request = { ...initial(root), key: "gaps", expectedDigest: first.digest, recordGaps: true,
    finalGapOutputs: [{ key: "exec1.l1.review", path: file }],
    director: { select: null, changes: [{ kind: "add" as const, task: value, reason: "Missing behavior" }], reason: "Record review" } };
  expect(() => apply({ ...request, finalGapOutputs: [{ key: "é".repeat(257), path: file }] })).toThrow("512 UTF-8 bytes");
  expect(() => apply({ ...request, finalGapOutputs: [{ key: "review", path: file + ".missing" }] })).toThrow();
  expect(readBacklog(root, "example").digest).toBe(first.digest);
  const recorded = apply(request), ref = recorded.backlog!.tasks[0]!.origin.ref;
  expect(JSON.parse(ref)).toEqual({ ...request.finalGapOutputs[0], sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
  expect(Buffer.byteLength(ref)).toBeLessThanOrEqual(512);
  writeFileSync(file, "changed after recording");
  expect(apply(request)).toMatchObject({ replay: true, digest: recorded.digest });
});

test("gate and acceptance verifies accept only positive criterion integers", () => {
  const { root } = fixture(); const first = apply(initial(root));
  for (const location of ["gate", "acceptance"]) {
    for (const verifies of [[1, 3], [], [0], [-1], [1.5], ["1"], null]) {
      const backlog = structuredClone(first.backlog!);
      const command = location === "gate" ? backlog.tasks[0]!.gates[0]! : backlog.acceptance[0]!;
      Object.assign(command, { verifies });
      if (Array.isArray(verifies) && verifies.every(n => typeof n === "number" && Number.isInteger(n) && n > 0))
        expect(() => validateBacklog(backlog)).not.toThrow();
      else expect(() => validateBacklog(backlog)).toThrow("verifies");
    }
  }
});

test("keyed apply replays, halts on human edits and adopts valid human bytes on prepare", async () => {
  const f = fixture(), request = initial(f.root); const first = apply(request);
  expect(apply(request)).toMatchObject({ digest: first.digest, replay: true });
  expect(readFileSync(first.path, "utf8")).toContain('"key": "first"');
  expect(() => apply({ ...request, director: { ...request.director, reason: "Different request" } })).toThrow("backlog-conflict");
  const edited = { ...first.backlog, tasks: [{ ...first.backlog!.tasks[0]!, goal: "Human goal" }] };
  writeFileSync(first.path, JSON.stringify(edited)); const human = readFileSync(first.path, "utf8");
  expect(() => apply(request)).toThrow("backlog-conflict");
  expect(() => apply({ ...request, key: "second", expectedDigest: first.digest, director: { select: "one", changes: [], reason: "Continue" } })).toThrow("backlog-conflict");
  expect(readFileSync(first.path, "utf8")).toBe(human);
  const adopted = await prepare(f); expect(adopted.backlog!.tasks[0]!.goal).toBe("Human goal"); expect(adopted.digest).not.toBe(first.digest);
  expect(appliedTemporaryFiles(f.root)).toEqual([]);
});
function appliedTemporaryFiles(root: string) { return execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n").filter(s => s.endsWith(".tmp")); }

test("add/split/update/obsolete preserve tombstones and reject identity/status changes or reuse", () => {
  const { root } = fixture(); let state = apply(initial(root));
  const edit = (changes: Parameters<typeof apply>[0]["director"]["changes"], select: string | null) => apply({ ...initial(root), key: `k${state.digest}`, expectedDigest: state.digest, director: { changes, select, reason: "Reconcile" } });
  state = edit([{ kind: "split", id: "one", tasks: [task("two"), task("three")], reason: "Smaller seams" }], "two");
  expect(state.backlog!.tasks[0]!.status).toBe("obsolete"); expect(state.selected!.parent).toBe("one");
  state = edit([{ kind: "update", id: "two", patch: { goal: "Updated goal" }, reason: "Code evidence" }, { kind: "obsolete", id: "three", reason: "Not needed" }], "two");
  expect(state.selected!.goal).toBe("Updated goal");
  expect(() => edit([{ kind: "add", task: task("one"), reason: "Reuse" }], "one")).toThrow("never reused");
  expect(() => edit([{ kind: "update", id: "two", patch: { status: "done" } as never, reason: "Fake completion" }], "two")).toThrow("status/identity");
  expect(() => edit([{ kind: "update", id: "one", patch: { goal: "Reopen" }, reason: "No" }], "two")).toThrow("tombstone");
});

test("director apply errors reject without writes while workflow and storage errors still halt", () => {
  const { root } = fixture(), first = apply(initial(root));
  const request = { ...initial(root), key: "next", expectedDigest: first.digest };
  const before = readFileSync(first.path, "utf8");
  const rejected = (input: Parameters<typeof apply>[0], message: string, selectionRejected: boolean) => {
    let caught: any;
    try { apply(input); } catch (error) { caught = error; }
    expect(caught?.message).toContain(message);
    expect(caught?.selectionRejected === true).toBe(selectionRejected);
    expect(readFileSync(first.path, "utf8")).toBe(before);
  };
  for (const [changes, message] of [
    [[{ kind: "add", task: task(), reason: "Reuse" }], "never reused"],
    [[{ kind: "update", id: "missing", patch: { goal: "Unknown" }, reason: "Update" }], "unknown task or tombstone"],
    [[{ kind: "update", id: "one", patch: { status: "done" }, reason: "Fake completion" }], "Invalid update patch"],
    [[{ kind: "obsolete", id: "one", reason: "Obsolete" }, { kind: "update", id: "one", patch: { goal: "Reopen" }, reason: "Update tombstone" }], "unknown task or tombstone"],
    [[{ kind: "split", id: "one", tasks: [], reason: "Split" }], "Split needs children"],
    [[{ kind: "add", task: task("bad/id"), reason: "Invalid identity" }], "Invalid loop key"],
    [[{ kind: "update", id: "one", patch: { dependsOn: ["missing"] }, reason: "Invalid reference" }], "Unknown/self dependency"],
  ] as const) rejected({ ...request, director: { select: "one", changes: changes as never, reason: "Reconcile" } }, message, true);
  rejected({ ...request, authority: { ...authority, specDigest: "b".repeat(64) },
    director: { select: "one", changes: [], reason: "Continue" } }, "must reconcile", true);
  rejected({ ...request, acceptance: [], director: { select: "one", changes: [], reason: "Replace" } }, "non-empty acceptance", true);
  rejected({ ...request, acceptance: [{ id: "full", command: "", cwd: "." }],
    director: { select: "one", changes: [], reason: "Replace" } }, "Invalid gate command", true);
  rejected({ ...request, expectedDigest: null }, "backlog-conflict", false);
  rejected({ ...initial(root), director: { ...initial(root).director, reason: "Changed replay" } }, "replay differs", false);
  rejected({ ...request, settle: true, progress: { taskId: "one", progress: empty, remaining: "" },
    director: { select: null, changes: [{ kind: "add", task: task(), reason: "Not settlement" }], reason: "Settle" } }, "Settlement requires", false);
  rejected({ ...request, recordGaps: true, director: { select: null, changes: [], reason: "Gaps" } }, "finished implementation backlog", false);
  rejected({ ...request, cancellations: [{ taskId: "missing", requestId: "cancel", kind: "cancel", origin: "user" }],
    director: { select: null, changes: [], reason: "Cancel" } }, "Unknown cancelled task", false);
  const uninitialized = fixture();
  const { acceptance, ...missingAcceptance } = initial(uninitialized.root);
  let initializationError: any;
  try { apply(missingAcceptance); } catch (error) { initializationError = error; }
  expect(initializationError?.message).toContain("non-empty acceptance");
  expect(initializationError?.selectionRejected).toBe(true);
  expect(readBacklog(uninitialized.root, "example").backlog).toBeNull();
  const noAcceptance = JSON.stringify({ ...first.backlog, lastApplied: null, tasks: [], acceptance: [] });
  writeFileSync(first.path, noAcceptance);
  let finalError: any;
  try { apply({ root, specId: "example", key: "final", invocation: "exec1", loop: 1, authority,
    expectedDigest: readBacklog(root, "example").digest, director: { select: null, changes: [], reason: "Final" } }); }
  catch (error) { finalError = error; }
  expect(finalError?.message).toContain("Final phase requires non-empty acceptance");
  expect(finalError?.selectionRejected === true).toBe(false);
  expect(readFileSync(first.path, "utf8")).toBe(noAcceptance);
  const invalid = JSON.stringify({ ...first.backlog, tasks: false });
  writeFileSync(first.path, invalid);
  try { apply(request); throw new Error("Expected invalid file rejection"); }
  catch (error: any) { expect(error.message).toContain("Invalid tasks"); expect(error.selectionRejected).toBeUndefined(); }
  expect(readFileSync(first.path, "utf8")).toBe(invalid);
});

test("selection requires pending task, focused gates, done prerequisites and authority reconciliation", () => {
  const { root } = fixture(); const one = task(), two = task("two"); two.dependsOn = ["one"];
  const request = initial(root, [one, two]); request.director.select = "two";
  expect(() => apply(request)).toThrow("unfinished dependencies"); expect(readBacklog(root, "example").backlog).toBeNull();
  expect(() => apply(initial(root, [{ ...one, gates: [] }]))).toThrow("focused gates");
  const first = apply(initial(root));
  expect(() => apply({ ...initial(root), expectedDigest: first.digest, key: "second", authority: { ...authority, specDigest: "b".repeat(64) }, director: { select: "one", changes: [], reason: "Continue" } })).toThrow("reconcile");
  expect(() => apply({ ...initial(root), expectedDigest: first.digest, key: "second", director: { select: null, changes: [], reason: "Final" } })).toThrow("unfinished");
});

test("cancellation persists only the explicit task, derives dependents and replays without writes", () => {
  const f = fixture(), one = task(), two = task("two"), three = task("three");
  two.dependsOn = ["one"]; three.dependsOn = ["two"];
  const first = apply(initial(f.root, [one, two, three]));
  const request = { ...initial(f.root), key: "cancel", expectedDigest: first.digest,
    director: { select: null, changes: [], reason: "Human cancellation" },
    cancellations: [{ taskId: "one", requestId: "request-one", kind: "cancel" as const, origin: "model" }] };
  const cancelled = apply(request), before = statSync(cancelled.path).mtimeMs;
  expect(cancelled.backlog!.tasks.map(t => t.status)).toEqual(["obsolete", "pending", "pending"]);
  expect(cancelled.backlog!.tasks[0]!.origin).toEqual({ kind: "human", ref: "request-one" });
  expect(cancelled.cancelledScope.map(t => t.id)).toEqual(["one", "two", "three"]);
  expect(cancelled.cancelledScope[2]!.cancel.cascadeFrom).toBe("two");
  expect(apply(request)).toMatchObject({ replay: true, digest: cancelled.digest });
  expect(statSync(cancelled.path).mtimeMs).toBe(before);
  expect(() => apply({ ...request, key: "select", cancellations: undefined, expectedDigest: cancelled.digest,
    director: { select: "two", changes: [], reason: "Try dependent" } })).toThrow("unfinished dependencies");
  const reshaped = apply({ ...request, key: "reshape", cancellations: undefined, expectedDigest: cancelled.digest,
    director: { select: "two", changes: [{ kind: "update", id: "two", patch: { dependsOn: [] }, reason: "Independent implementation after repository inspection" }], reason: "Reshape excluded dependent" } });
  expect(reshaped.selected!.id).toBe("two"); expect(reshaped.cancelledScope.map(t => t.id)).toEqual(["one"]);
  const human = JSON.stringify({ ...cancelled.backlog, tasks: cancelled.backlog!.tasks.map(t => ({ ...t, goal: "Human edit" })) }); writeFileSync(cancelled.path, human);
  expect(() => apply(request)).toThrow("backlog-conflict");
  expect(readFileSync(cancelled.path, "utf8")).toBe(human);
});

test("only a confirmed passing unit marks done and unlocks its dependent task", async () => {
  const f = fixture(), one = task(), two = task("two"); two.dependsOn = ["one"];
  const first = apply(initial(f.root, [one, two])), receipt = await gate(attempt(f));
  const request = { ...initial(f.root), expectedDigest: first.digest, key: "second", director: { select: "two", changes: [], reason: "Next dependency" },
    confirmedUnit: { taskId: "one", kind: "unit" as const, workerStatus: "complete" as const, receipt } };
  expect(() => apply({ ...request, confirmedUnit: { ...request.confirmedUnit, receipt: { ...receipt, mutated: true } } })).toThrow("confirmed unit");
  const second = apply(request); expect(second.selected!.id).toBe("two"); expect(second.backlog!.tasks[0]!.status).toBe("done");
  expect((await prepare({ ...f, previousConfirmedUnit: "one" })).lastConfirmedUnit).toBe("one");
  expect((await prepare(f)).lastConfirmedUnit).toBeNull();
  expect((await prepare({ ...f, previousConfirmedUnit: "two" })).lastConfirmedUnit).toBeNull();
  expect((await prepare({ ...f, previousConfirmedUnit: "missing" })).lastConfirmedUnit).toBeNull();
  second.backlog!.tasks[0]!.status = "pending";
  writeFileSync(second.path, JSON.stringify(second.backlog));
  const human = readFileSync(second.path, "utf8"), adopted = await prepare({ ...f, previousConfirmedUnit: "one" });
  expect(adopted.backlog!.tasks[0]!.status).toBe("pending");
  expect(adopted.lastConfirmedUnit).toBeNull(); expect(adopted.digest).not.toBe(second.digest);
  expect(readFileSync(second.path, "utf8")).toBe(human);
});

test("metric uses the final nonempty stdout line regardless of exit code; counts best distance and stalls", async () => {
  expect(parseMetric("noise\n 0 \n\n")).toBe(0);
  for (const bad of ["", "\nNaN\n", "Infinity", "1\nno value"]) expect(parseMetric(bad)).toBeNull();
  const f = fixture(); const measured = { ...task(), metric: { command: "printf 'noise\\n0\\n\\n'; exit 1", unit: "errors", target: 0 } };
  const receipt = await gate(attempt(f, { task: measured, workerStatus: "continue" }));
  expect(receipt.metric).toEqual({ value: 0, error: null }); expect(receipt.gates).toEqual([]);
  const trailing = await runCommand(f.root, { id: "stdout", command: "printf '2\\n'; head -c 5000 /dev/zero | tr '\\0' '\\n'", cwd: ".", timeoutMs: 1000 }, path.join(f.root, ".pi/stdout.log"));
  expect(parseMetric(trailing.stdout)).toBe(2);
  const sample = (value: number | null) => ({ value, fingerprint: "a".repeat(64), gatesPassed: 0, gatesTotal: 1 });
  let progress = updateProgress(empty, sample(18), 0); progress = updateProgress(progress, sample(8), 0);
  expect(progress.nonImproving).toBe(0); progress = updateProgress(progress, sample(9), 0);
  expect(progress.nonImproving).toBe(1); progress = updateProgress(progress, sample(8), 0); progress = updateProgress(progress, sample(null), 0);
  expect(progress.nonImproving).toBe(3); expect(progress.last5.at(-1)!.best).toBe(8);
  expect(metricBefore(progress, "b".repeat(64))).toBeNull(); expect(metricBefore(receipt.progress, receipt.after.fingerprint)).toBe(0);
  // A focused timeout is a non-improving attempt even when the metric got better.
  expect(updateProgress(progress, sample(0), 0, true).nonImproving).toBe(4);
  const towardNegative = updateProgress(updateProgress(empty, sample(1), -5), sample(-4), -5); expect(towardNegative.nonImproving).toBe(0);
  let ratios = updateProgress(empty, { ...sample(null), gatesPassed: 1, gatesTotal: 2 }, null);
  ratios = updateProgress(ratios, { ...sample(null), gatesPassed: 2, gatesTotal: 2 }, null); expect(ratios.last5.at(-1)!.best).toBe(1);
});

test("Board topic is canonical per worktree and prepare/view publication is persistent and idempotent", async () => {
  const f = fixture(); const emptyPrepared = await prepare(f); expect(emptyPrepared.digest).toBeNull();
  expect(topicOwner(f.root, f.specId)).toBe(`execute:example:${createHash("sha256").update(f.root).digest("hex").slice(0, 16)}`);
  expect(topicOwner(path.join(f.root, "."), f.specId)).toBe(topicOwner(f.root, f.specId));
  expect((await prepare(f)).view.topicId).toBe(emptyPrepared.view.topicId);
  const knowledge = { findings: ["Dead end", null], handoff: "product is at repository root" };
  const first = await gate(attempt(f, { knowledge })); const replay = await gate(attempt(f, { knowledge }));
  expect(replay.view.posts.map(p => p.id)).toEqual(first.view.posts.map(p => p.id));
  expect(first.view.posts.map(p => p.type)).toEqual(["HANDOFF", "FINDING"]);
  const next = await gate(attempt(f, { attempt: 2, key: "attempt2", knowledge: { handoff: "new state" } }));
  expect(next.view.posts.filter(p => p.type === "HANDOFF").map(p => p.content)).toEqual(["new state"]);
  const director = await prepare(f); expect(director.view.posts.some(p => p.type === "HANDOFF")).toBe(false);
});

test("Board views retain HUMAN rulings and decisions, filter task findings and handoff, cap bytes with omitted count", async () => {
  const f = fixture(), prepared = await prepare(f), board = await openBoard(f.dbPath), workspace = repositoryIdentity(f.root), topicId = prepared.view.topicId;
  try {
    const human = (content: string, supersedes?: number) => {
      const child = process.env.PI_SUBAGENT_CHILD;
      try {
        delete process.env.PI_SUBAGENT_CHILD;
        return board.postHuman(workspace, { topicId, type: "HUMAN", content,
          metadata: { quote: content, saidAt: "2026-11-08T12:00:00Z", taskId: "other", supersedes } }, { hasUI: true }, "coordinator");
      } finally {
        if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
        else process.env.PI_SUBAGENT_CHILD = child;
      }
    };
    const oldHuman = human("Old human ruling");
    const currentHuman = human("Current human ruling", oldHuman.id);
    // An earlier HUMAN cannot supersede a future one, even with a forward reference.
    const forwardHuman = human("Earlier human ruling", currentHuman.id + 2);
    const futureHuman = human("Later independent ruling");
    const old = board.post(workspace, { topicId, type: "DECISION", content: "Old rule", metadata: { supersedes: currentHuman.id } });
    board.post(workspace, { topicId, type: "DECISION", content: "Current rule", metadata: { supersedes: old.id } });
    for (let i = 0; i < 110; i++) board.post(workspace, { topicId, type: "FINDING", content: `finding ${i} ${"é".repeat(100)}`, metadata: { taskId: "one" } });
    board.post(workspace, { topicId, type: "FINDING", content: "Other task", metadata: { taskId: "two" } });
    board.postOnce(workspace, "handoff-one", { topicId, type: "HANDOFF", content: "one state", metadata: { taskId: "one" } });
    for (const type of ["FINDING", "HANDOFF"] as const)
      board.post(workspace, { topicId, type, content: "Cannot override human", metadata: { supersedes: currentHuman.id } });
    const view = boardView(board, workspace, topicId, { taskId: "one", maxBytes: 2048 });
    expect(view.posts.filter(p => p.type === "HUMAN")).toEqual([futureHuman, forwardHuman, currentHuman].map(p => ({
      id: p.id, type: p.type, content: p.content, metadata: p.metadata, author: "coordinator", createdAt: p.createdAt,
    })));
    expect(view.posts.find(p => p.id === currentHuman.id)?.metadata).toMatchObject({ quote: "Current human ruling", saidAt: "2026-11-08T12:00:00Z" });
    expect(boardView(board, workspace, topicId, { doneTaskIds: ["other"] }).posts.filter(p => p.type === "HUMAN")).toEqual(view.posts.filter(p => p.type === "HUMAN"));
    expect(view.authority).toContain("current HUMAN rulings (most recent human source wins; cite it) > DECISION");
    expect((await prepare(f)).view.posts.filter(p => p.type === "HUMAN")).toHaveLength(3);
    expect(() => boardView(board, workspace, topicId, { taskId: "one", maxBytes: 256 })).toThrow("human consolidation required");
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(2048); expect(view.omitted).toBeGreaterThan(0);
    expect(view.posts.some(p => p.content === "Current rule")).toBe(true); expect(view.posts.some(p => p.content === "Old rule" || p.content === "Other task")).toBe(false);
    expect(view.posts.map(p => p.id)).toEqual(view.posts.map(p => p.id).sort((a,b) => b-a));
    board.post(workspace, { topicId, type: "DECISION", content: "Binding rule ".repeat(300).trim() });
    writeFileSync(path.join(f.root, "product"), "Human WIP");
    for (let i = 0; i < 50; i++) writeFileSync(path.join(f.root, `untracked-product-file-${i}`), "WIP");
    const receipt = await gate(attempt(f));
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(8191);
    expect(receipt.view.posts.filter(p => p.type === "DECISION").map(p => p.content)).toEqual(["Binding rule ".repeat(300).trim(), "Current rule"]);
    expect(receipt.view.posts.filter(p => p.type === "HUMAN")).toEqual(view.posts.filter(p => p.type === "HUMAN"));
    expect(receipt.mutated).toBe(false);
    for (const identity of [receipt.before, receipt.after]) expect(Object.keys(identity).sort()).toEqual(["fingerprint", "head"]);
    human("x".repeat(2500));
    // Each band member fits alone; the combined HUMAN + DECISION band must halt, not truncate.
    expect(() => boardView(board, workspace, topicId, { taskId: "one" })).toThrow("HUMAN + DECISION overflow");
    await expect(prepare(f)).rejects.toThrow("ask the human to consolidate");
  } finally { board.close(); }
});

test("director omits only done-task findings without changing worker views or stored posts", async () => {
  const f = fixture();
  const tasks = ["done", "pending", "blocked", "obsolete"].map(task);
  const applied = apply(initial(f.root, tasks));
  for (const t of applied.backlog!.tasks) t.status = t.id as Task["status"];
  writeFileSync(applied.path, JSON.stringify(applied.backlog));
  const prepared = await prepare(f), board = await openBoard(f.dbPath), workspace = repositoryIdentity(f.root), topicId = prepared.view.topicId;
  try {
    for (const t of tasks) board.post(workspace, { topicId, type: "FINDING", content: t.id, metadata: { taskId: t.id } });
    board.post(workspace, { topicId, type: "FINDING", content: "global" });
    board.post(workspace, { topicId, type: "DECISION", content: "binding", metadata: { taskId: "done" } });
    board.post(workspace, { topicId, type: "HANDOFF", content: "done state", metadata: { taskId: "done" } });
    const stored = board.readTopic(workspace, topicId);
    const worker = boardView(board, workspace, topicId, { taskId: "done" });
    expect(boardView(board, workspace, topicId, { taskId: "done", doneTaskIds: ["done"] })).toEqual(worker);
    expect(worker.posts.map(p => p.content)).toEqual(["done state", "binding", "global", "done"]);
    const director = (await prepare(f)).view;
    expect(director.posts.map(p => p.content)).toEqual(["binding", "global", "obsolete", "blocked", "pending"]);
    expect(board.readTopic(workspace, topicId)).toEqual(stored);
  } finally { board.close(); }
});

test("gate classifies failures/errors, detects product mutation, ignores metadata/build outputs and bounds logs/receipt", async () => {
  const f = fixture(); const t = task();
  t.gates = [
    { id: "pass", command: "mkdir -p cache; printf built > cache/build; printf meta > .pi/meta", cwd: ".", timeoutMs: 1000 },
    { id: "fail", command: "printf failure >&2; exit 7", cwd: ".", timeoutMs: 1000 },
    { id: "error", command: "true", cwd: "missing-dir", timeoutMs: 1000 },
    { id: "mutate", command: "printf changed > product", cwd: ".", timeoutMs: 1000 },
    { id: "large", command: "head -c 9000000 /dev/zero", cwd: ".", timeoutMs: 1000 },
  ];
  const receipt = await gate(attempt(f, { task: t, knowledge: { findings: false, handoff: 42 } }));
  expect(receipt.gates.map(g => g.status)).toEqual(["pass", "fail", "error", "pass", "pass"]);
  expect(receipt.gates[1]!.exit).toBe(7); expect(receipt.mutated).toBe(true); expect(receipt.progress.nonImproving).toBe(1);
  expect(statSync(receipt.gates[4]!.logRef).size).toBe(8 * 1024 * 1024);
  for (const g of receipt.gates) expect(Buffer.byteLength(g.tail)).toBeLessThanOrEqual(2048);
  expect(Buffer.byteLength(JSON.stringify(receipt) + "\n")).toBeLessThanOrEqual(8192);
  expect(readFileSync(receipt.gates[1]!.logRef, "utf8")).toBe("failure");
  const ignored = await gate(attempt(f)); expect(ignored.mutated).toBe(false);
  let stalledTask = { ...task(), gates: [{ id: "fail", command: "false", cwd: ".", timeoutMs: 1000 }] };
  for (let i = 1; i <= 3; i++) {
    const failed = await gate(attempt(f, { task: stalledTask, attempt: i, key: `failure${i}` }));
    expect(failed.progress.nonImproving).toBe(i); expect(failed.stalled).toBe(i === 3); stalledTask.progress = failed.progress;
  }
  const noMetric = await gate(attempt(f, { workerStatus: "continue" })); expect(noMetric.gates).toHaveLength(1);
  await expect(gate(attempt(f, { writerSettled: false as never }))).rejects.toThrow("settled worker");
});

test("a timed-out command kills its grandchild group and still produces a receipt; metric timeout stalls", async () => {
  const f = fixture(), t = task();
  t.gates = [{ id: "timeout", command: "sleep 100 & child=$!; printf '%s\\n' \"$child\"; wait", cwd: ".", timeoutMs: 100 }];
  const receipt = await gate(attempt(f, { task: t })); expect(receipt.gates[0]!.status).toBe("timeout");
  expect(receipt.progress.nonImproving).toBe(1);
  const pid = Number(readFileSync(receipt.gates[0]!.logRef, "utf8").trim()); expect(pid).toBeGreaterThan(0);
  // A reparented zombie is settled, not a surviving running command.
  let state = ""; try { state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0]!; } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ENOENT"); }
  expect(["", "Z"]).toContain(state);
  const metric = { ...task(), metric: { command: "printf 1; sleep 100", target: 0, unit: "count" }, progress: { nonImproving: 2, last5: [] } };
  const timed = await gate(attempt(f, { task: metric, workerStatus: "continue", metricTimeoutMs: 100 }));
  expect(timed.metric!.value).toBeNull(); expect(timed.metric!.error).toContain("timeout"); expect(timed.stalled).toBe(true);
});

test("SIGTERM to the real loop-io gate kills its background grandchild", async () => {
  const f = fixture(), t = task(), pidFile = path.join(f.root, "child.pid");
  t.gates = [{ id: "stop", command: "sleep 100 & child=$!; printf '%s %s\\n' \"$$\" \"$child\" > child.pid; wait", cwd: ".", timeoutMs: 30000 }];
  let shellPid = 0, grandchildPid = 0;
  let readyTimer: ReturnType<typeof setTimeout>;
  let watcher: ReturnType<typeof watch>;
  const ready = new Promise<void>((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error("Gate did not record its child pid")), 3000);
    watcher = watch(f.root, () => {
      try {
        const pids = readFileSync(pidFile, "utf8").trim();
        if (!/^\d+ \d+$/.test(pids)) return;
        [shellPid, grandchildPid] = pids.split(" ").map(Number) as [number, number];
        resolve();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") reject(error); }
    });
    watcher.on("error", reject);
  });
  const child = spawn("node", [path.resolve(import.meta.dir, "../skills/execute/loop-io.mjs")], { cwd: f.root, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject); child.on("close", resolve);
  });
  child.stdin.end(JSON.stringify({ operation: "gate", ...attempt(f, { task: t }) }));
  try {
    await Promise.race([ready, closed.then(code => { throw new Error(`loop-io exited before readiness: ${code}: ${stderr}`); })]);
    expect(grandchildPid).toBeGreaterThan(0);
    expect(child.kill("SIGTERM")).toBe(true);
    await closed;
    let state = "";
    try { state = readFileSync(`/proc/${grandchildPid}/stat`, "utf8").split(") ")[1]!.split(" ")[0]!; }
    catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ENOENT"); }
    expect(["", "Z"]).toContain(state);
  } finally {
    clearTimeout(readyTimer!); watcher!.close();
    child.kill("SIGTERM");
    await closed;
    // Keep a failing forwarding assertion from leaking the test-owned command group.
    if (shellPid) {
      try { process.kill(-shellPid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
});

test.each(["prepare", "apply", "gate", "invalid"])("Node stdin adapter loads Board and bounds its output: %s", async operation => {
  const f = fixture(), script = path.resolve(import.meta.dir, "../skills/execute/loop-io.mjs");
  const invoke = (input: object) => spawnSync("node", [script], { cwd: f.root, input: JSON.stringify(input), encoding: "utf8" });
  if (operation === "prepare" || operation === "apply") {
    const topic = (await prepare(f)).view.topicId, board = await openBoard(f.dbPath);
    try { board.post(repositoryIdentity(f.root), { topicId: topic, type: "DECISION", content: "Keep é and 日本語" }); }
    finally { board.close(); }
    const prepared = invoke(operation === "prepare" ? { operation, ...f } : { operation, ...initial(f.root), dbPath: f.dbPath });
    expect(prepared.status).toBe(0);
    const receipt = JSON.parse(prepared.stdout.trim());
    expect(receipt.view.topicId).toBeGreaterThan(0);
    expect(receipt).not.toHaveProperty("backlog");
    expect(receipt.viewDigest).toBe(canonicalDigest(receipt.view));
    expect(receipt.viewBytes).toBe(Buffer.byteLength(JSON.stringify(receipt.view)));
    expect(receipt.viewBytes).toBeGreaterThan(JSON.stringify(receipt.view).length);
    expect(receipt.view).toHaveProperty("posts");
  } else if (operation === "gate") {
    const receipt = invoke({ operation, ...attempt(f) }); expect(receipt.status).toBe(0);
    const lines = receipt.stdout.trim().split("\n"); expect(lines).toHaveLength(1); expect(Buffer.byteLength(receipt.stdout)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(lines[0]!).gates[0].status).toBe("pass");
  } else {
    const invalid = invoke({ operation: "prepare", ...f, root: tmpdir() }); expect(invalid.status).toBe(1); expect(invalid.stdout).toContain("actual cwd");
  }
});


test("acceptance initialization/replacement is reasoned and human edits are audited", async () => {
  const f = fixture(), request = initial(f.root);
  expect(() => apply({ ...request, acceptance: undefined })).toThrow("requires valid non-empty acceptance");
  const first = apply(request);
  expect(first.backlog!.acceptanceHistory).toMatchObject([{ kind: "init", reason: "Most important", invocation: "exec1", loop: 1 }]);
  const replacement = [{ id: "replacement", command: "printf checked", cwd: "." }];
  const second = apply({ ...request, acceptance: undefined, key: "replace", expectedDigest: first.digest,
    director: { select: "one", changes: [], reason: "Project procedure changed", acceptance: replacement } });
  expect(second.backlog!.acceptanceHistory.at(-1)).toMatchObject({ kind: "replace", reason: "Project procedure changed" });
  const edited = structuredClone(second.backlog!); edited.acceptance = [{ id: "human", command: "true", cwd: "." }];
  writeFileSync(second.path, JSON.stringify(edited));
  const adopted = await prepare(f);
  expect(adopted.backlog!.acceptanceHistory.at(-1)).toMatchObject({ kind: "human" });
  expect((await prepare(f)).digest).toBe(adopted.digest);
  const blank = structuredClone(adopted.backlog!); blank.acceptance = [];
  blank.tasks[0]!.status = "obsolete";
  writeFileSync(second.path, JSON.stringify(blank));
  const empty = await prepare(f);
  expect(() => apply({ ...request, acceptance: undefined, key: "final", expectedDigest: empty.digest,
    director: { select: null, changes: [], reason: "Final candidate" } })).toThrow("Final phase requires non-empty acceptance");
});

test("settlement persists a stalled task and a gated unit without selecting another task", async () => {
  const f = fixture(), first = apply(initial(f.root)), receipt = await gate(attempt(f));
  const request = { ...initial(f.root), acceptance: undefined, expectedDigest: first.digest, key: "settle", settle: true,
    director: { select: null, changes: [], reason: "Attempt settled" },
    progress: { taskId: "one", progress: { ...receipt.progress, nonImproving: 3 }, remaining: "Still pending" } };
  const paused = apply(request); expect(paused.selected).toBeNull();
  expect(paused.backlog!.tasks[0]).toMatchObject({ status: "pending", remaining: "Still pending", progress: { nonImproving: 3 } });
  expect(apply(request).replay).toBe(true);
  const done = apply({ ...request, key: "done", expectedDigest: paused.digest,
    confirmedUnit: { taskId: "one", kind: "unit", workerStatus: "complete", receipt } });
  expect(done.backlog!.tasks[0]!.status).toBe("done");
});


test("final-phase findings add new tasks atomically without reopening tombstones and replay idempotently", () => {
  const { root } = fixture();
  const first = apply(initial(root));
  const gap = { ...task("final-finding"), gates: [], origin: { kind: "final-phase" as const, ref: "/native/review/finding.json" } };
  const request = { ...initial(root), key: "final-gaps", expectedDigest: first.digest, recordGaps: true,
    director: { select: null, changes: [{ kind: "add" as const, task: gap, reason: "Missing observable result" }], reason: "Final review gaps" } };
  expect(() => apply(request)).toThrow("finished implementation backlog");
  const finished = apply({ ...initial(root), key: "obsolete", expectedDigest: first.digest,
    director: { select: null, changes: [{ kind: "obsolete", id: "one", reason: "Superseded implementation" }], reason: "Reconcile" } });
  expect(finished.completedTasks).toContainEqual({ id: "one", goal: "Implement one", status: "obsolete", reasons: ["From spec", "Superseded implementation"] });
  const next = { ...request, expectedDigest: finished.digest };
  const written = apply(next);
  expect(written.selected).toBeNull();
  expect(written.backlog!.tasks.map(t => t.status)).toEqual(["obsolete", "pending"]);
  expect(written.backlog!.tasks[1]!.origin).toEqual(gap.origin);
  expect(apply(next)).toMatchObject({ digest: written.digest, replay: true });
  expect(() => apply({ ...next, key: "another", expectedDigest: written.digest })).toThrow("finished implementation backlog");
  expect(() => apply({ ...initial(root), key: "select-gap", expectedDigest: written.digest,
    director: { select: gap.id, changes: [], reason: "Repair" } })).toThrow("focused gates");
});

function stalledSettlement(root: string, state: { digest: string | null }, loop = 1, diagnosis = "Three attempts without progress") {
  return { root, specId: "example", expectedDigest: state.digest, key: `settle${loop}`, invocation: "exec1", loop, authority,
    settle: true, director: { select: null, changes: [], reason: diagnosis },
    progress: { taskId: "one", remaining: "Still pending", progress: { nonImproving: 3,
      last5: [{ value: 8, best: 8, fingerprint: "a".repeat(64), gatesPassed: 0, gatesTotal: 1 }] } } };
}

test("stall settlement counts loops, persists definition and diagnosis, and replays idempotently", () => {
  const { root } = fixture(), first = apply(initial(root));
  // Old persisted backlogs have no counter; the next apply starts it at zero.
  const legacy = structuredClone(first.backlog!); delete legacy.tasks[0]!.progress.stalls;
  validateBacklog(legacy); writeFileSync(first.path, JSON.stringify(legacy));
  const adopted = { ...first, digest: readBacklog(root, "example").digest! };
  const request = stalledSettlement(root, adopted);
  const notStalled = apply({ ...request, key: "not-stalled", progress: { ...request.progress, progress: { nonImproving: 2, last5: [] } } });
  expect(notStalled.backlog!.tasks[0]!.progress.stalls).toBe(0);
  expect(notStalled.backlog!.tasks[0]!.history.some(h => h.event === "stall")).toBe(false);
  const settlement = { ...request, expectedDigest: notStalled.digest };
  const stalled = apply(settlement), stored = readBacklog(root, "example").backlog!.tasks[0]!;
  const { goal, expectedResult, gates, metric, dependsOn } = stored;
  expect(stored.progress.stalls).toBe(1); expect(stalled.needsDecision).toBeNull();
  expect(stored.history.at(-1)).toEqual({ invocation: "exec1", loop: 1, event: "stall", reason: request.director.reason,
    definitionDigest: canonicalDigest({ goal, expectedResult, gates, metric, dependsOn }) });
  const before = readFileSync(stalled.path, "utf8");
  expect(apply(settlement)).toMatchObject({ replay: true, digest: stalled.digest, needsDecision: null });
  expect(readFileSync(stalled.path, "utf8")).toBe(before);
  const duplicate = apply({ ...settlement, key: "same-loop", expectedDigest: stalled.digest });
  expect(duplicate.backlog!.tasks[0]!.progress.stalls).toBe(1);
  expect(duplicate.backlog!.tasks[0]!.history.filter(h => h.event === "stall")).toHaveLength(1);
  for (const stalls of [-1, 0.5, "1", null]) {
    const bad = structuredClone(stalled.backlog!); Object.assign(bad.tasks[0]!.progress, { stalls });
    expect(() => validateBacklog(bad)).toThrow("Invalid stalls");
  }
});

test("stalled selection rejects no-op, remaining-only, unrelated or reasonless updates without writes", () => {
  const { root } = fixture(), first = apply(initial(root, [task(), task("other")]));
  const stalled = apply(stalledSettlement(root, first)), before = readFileSync(stalled.path, "utf8");
  const request = { ...initial(root), expectedDigest: stalled.digest, key: "select", loop: 2 };
  for (const changes of [[],
    [{ kind: "update", id: "one", patch: { goal: task().goal }, reason: "Same definition" }],
    [{ kind: "update", id: "one", patch: { remaining: "Try again", specRefs: ["More context"] }, reason: "More detail" }],
    [{ kind: "update", id: "other", patch: { goal: "Different task" }, reason: "Not selected task" }],
    [{ kind: "update", id: "one", patch: { goal: "Changed" }, reason: "Change" },
      { kind: "update", id: "one", patch: { goal: task().goal }, reason: "Undo" }],
  ]) {
    let error: any;
    try { apply({ ...request, director: { select: "one", changes: changes as never, reason: "Select" } }); }
    catch (caught) { error = caught; }
    expect(error?.selectionRejected).toBe(true);
    expect(error?.message).toBe("stalled task re-selected without a changed definition");
    expect(readFileSync(stalled.path, "utf8")).toBe(before);
  }
  expect(() => apply({ ...request, director: { select: "one", reason: "Select", changes: [
    { kind: "update", id: "one", patch: { goal: "Changed" }, reason: "" }] } })).toThrow("needs a reason");
  const other = apply({ ...request, director: { select: "other", changes: [], reason: "Work elsewhere" } });
  expect(other.selected!.id).toBe("other"); expect(other.selected!.progress.stalls).toBe(0);
});

test.each(["goal", "expectedResult", "gates", "metric"] as const)("changed stalled %s is selectable and starts a fresh loop without losing stalls", field => {
  const { root } = fixture(), first = apply(initial(root)), stalled = apply(stalledSettlement(root, first));
  const patches = { goal: { goal: "Smaller goal" }, expectedResult: { expectedResult: "Refined outcome" },
    gates: { gates: [{ ...task().gates[0]!, command: "printf refined" }] },
    metric: { metric: { command: "printf 0", unit: "errors", target: 0 } } };
  const selected = apply({ ...initial(root), key: "changed", loop: 2, expectedDigest: stalled.digest,
    director: { select: "one", reason: "Refine stalled work", changes: [
      { kind: "update", id: "one", patch: patches[field], reason: "New definition based on stall" }] } });
  expect(selected.selected!.progress).toEqual({ stalls: 1, nonImproving: 0, last5: [] });
  expect(updateProgress(selected.selected!.progress, { value: null, fingerprint: "a".repeat(64), gatesPassed: 0, gatesTotal: 1 }, null).stalls).toBe(1);
});

test("splitting stalled work leaves its tombstone and selectable children with fresh counters", () => {
  const { root } = fixture(), first = apply(initial(root)), stalled = apply(stalledSettlement(root, first));
  const child = { ...task("child"), progress: { stalls: 1, nonImproving: 3, last5: [] } };
  const split = apply({ ...initial(root), key: "split", loop: 2, expectedDigest: stalled.digest,
    director: { select: "child", reason: "Smaller seams", changes: [
      { kind: "split", id: "one", tasks: [child], reason: "Break up stalled work" }] } });
  expect(split.backlog!.tasks[0]).toMatchObject({ id: "one", status: "obsolete", progress: { stalls: 1 } });
  expect(split.selected).toMatchObject({ id: "child", parent: "one", progress: { stalls: 0, nonImproving: 0, last5: [] } });
});

test("second stall signals needs-decision with task, metric series and both retained diagnoses, including replay", () => {
  const { root } = fixture(), first = apply(initial(root)), stalled = apply(stalledSettlement(root, first, 1, "First stall diagnosis"));
  let state = stalled;
  // Ordinary history remains bounded without evicting the diagnoses needed by the human.
  for (let i = 0; i < 9; i++) state = apply({ ...initial(root), key: `refine${i}`, loop: 2, expectedDigest: state.digest,
    director: { select: "one", reason: "Refine", changes: [
      { kind: "update", id: "one", patch: { goal: `Smaller scope ${i}` }, reason: "Refine definition" }] } });
  const request = stalledSettlement(root, state, 2, "Second stall diagnosis"), second = apply(request);
  expect(second.backlog!.tasks[0]!.progress.stalls).toBe(2);
  expect(second.backlog!.tasks[0]!.history.length).toBeLessThanOrEqual(8);
  expect(second.needsDecision).toEqual({ taskId: "one", metricSeries: request.progress.progress.last5,
    diagnoses: ["First stall diagnosis", "Second stall diagnosis"] });
  expect(apply(request)).toMatchObject({ replay: true, needsDecision: second.needsDecision });
  expect(readBacklog(root, "example").backlog!.tasks[0]!.progress.stalls).toBe(2);
});


test.each(["unit", "progress"] as const)("%s settlement after resolving two stalls does not halt again, including replay", async outcome => {
  const f = fixture(), first = apply(initial(f.root));
  const stalled = apply(stalledSettlement(f.root, first));
  const refined = apply({ ...initial(f.root), key: "refine", loop: 2, expectedDigest: stalled.digest,
    director: { select: "one", reason: "Refine stalled work", changes: [
      { kind: "update", id: "one", patch: { goal: "Smaller scope" }, reason: "First stall diagnosis" }] } });
  const second = apply(stalledSettlement(f.root, refined, 2, "Second stall diagnosis"));
  expect(second.backlog!.tasks[0]!.progress.stalls).toBe(2);
  // Cover a later loop in the same invocation and the same loop number after relaunch.
  const context = outcome === "unit" ? { invocation: "exec1", loop: 3 } : { invocation: "exec2", loop: 2 };
  const selected = apply({ ...initial(f.root), ...context, key: "resolved", expectedDigest: second.digest,
    director: { select: "one", reason: "Human resolution supplied a refined definition", changes: [
      { kind: "update", id: "one", patch: { goal: "Resolved scope" }, reason: "Apply resolution" }] } });
  expect(selected.selected!.progress).toEqual({ stalls: 2, nonImproving: 0, last5: [] });
  const receipt = await gate(attempt(f, { ...context, task: selected.selected! }));
  const request = { ...stalledSettlement(f.root, selected), ...context, key: "resolved-settle",
    progress: { taskId: "one", remaining: outcome === "unit" ? "" : "Work remains", progress: receipt.progress },
    ...(outcome === "unit" ? { confirmedUnit: { taskId: "one", kind: "unit" as const, workerStatus: "complete" as const, receipt } } : {}) };
  const settled = apply(request);
  expect(settled.needsDecision).toBeNull();
  expect(settled.backlog!.tasks[0]).toMatchObject({ status: outcome === "unit" ? "done" : "pending", progress: { stalls: 2 } });
  expect(settled.backlog!.tasks[0]!.history.filter(h => h.event === "stall")).toHaveLength(2);
  const before = readFileSync(settled.path, "utf8");
  expect(apply(request)).toMatchObject({ replay: true, digest: settled.digest, needsDecision: null });
  expect(readFileSync(settled.path, "utf8")).toBe(before);
});

test("acceptance exception shape, blocking floor and canonical history include humanRef and reason", () => {
  const f = fixture(), request = initial(f.root);
  const excepted = { id: "loader", command: "false", cwd: ".", exception: { humanRef: 1, reason: "HUMAN #1 permits failure" } };
  const acceptance = [...request.acceptance, excepted];
  for (const exception of [null, {}, { humanRef: 0, reason: "why" }, { humanRef: 1.5, reason: "why" },
    { humanRef: "1", reason: "why" }, { humanRef: 1, reason: " " }]) {
    expect(() => apply({ ...request, acceptance: [...request.acceptance, { ...excepted, exception } as never], currentHumanIds: [1] })).toThrow("Invalid acceptance exception");
  }
  expect(() => apply({ ...request, acceptance, currentHumanIds: [] })).toThrow("not a current HUMAN");
  expect(() => apply({ ...request, acceptance: [excepted], currentHumanIds: [1] })).toThrow("at least one blocking command");
  expect(readBacklog(f.root, f.specId).backlog).toBeNull();
  const first = apply({ ...request, acceptance, currentHumanIds: [1] });
  expect(first.backlog!.acceptance[1]).toEqual(excepted);
  expect(first.backlog!.acceptanceHistory.at(-1)!.digest).toBe(canonicalDigest(acceptance));
  const replacement = [acceptance[0]!, { ...excepted, exception: { humanRef: 2, reason: "HUMAN #2 replaces permission" } }];
  const second = apply({ ...request, key: "replace-exception", expectedDigest: first.digest, acceptance: undefined, currentHumanIds: [2],
    director: { select: "one", changes: [], reason: "Cite newer ruling", acceptance: replacement } });
  expect(second.backlog!.acceptanceHistory.at(-1)!.digest).toBe(canonicalDigest(replacement));
  expect(second.backlog!.acceptanceHistory.at(-1)!.digest).not.toBe(first.backlog!.acceptanceHistory.at(-1)!.digest);
});

test("Node apply injects current topic HUMAN IDs, rejects forged authority and revalidates final hand edits and replay", async () => {
  const f = fixture(), prepared = await prepare(f), board = await openBoard(f.dbPath), workspace = repositoryIdentity(f.root);
  let oldId: number, humanId: number, foreignId: number, decisionId: number;
  try {
    const previous = process.env.PI_SUBAGENT_CHILD;
    try {
      delete process.env.PI_SUBAGENT_CHILD;
      const human = (topicId: number, supersedes?: number) => board.postHuman(workspace, { topicId, type: "HUMAN", content: "Loader may fail",
        metadata: { quote: "Loader may fail", saidAt: "2026-11-08", supersedes } }, { hasUI: true });
      oldId = human(prepared.view.topicId).id;
      humanId = human(prepared.view.topicId, oldId).id;
      const foreign = board.ensureOwnedTopic(workspace, "other-topic", { title: "Other topic" });
      foreignId = human(foreign.id).id;
      decisionId = board.post(workspace, { topicId: prepared.view.topicId, type: "DECISION", content: "Not human" }).id;
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previous;
    }
  } finally { board.close(); }
  const script = path.resolve(import.meta.dir, "../skills/execute/loop-io.mjs");
  const invoke = (input: object) => {
    const result = spawnSync("node", [script], { cwd: f.root, input: JSON.stringify({ operation: "apply", dbPath: f.dbPath, ...input }), encoding: "utf8" });
    return { status: result.status, receipt: JSON.parse(result.stdout.trim()) };
  };
  const excepted = (humanRef: number) => ({ id: "loader", command: "false", cwd: ".", exception: { humanRef, reason: `HUMAN #${humanRef} permits failure` } });
  const request = initial(f.root), currentHumanIds = await currentHumanPostIds(f);
  expect(currentHumanIds).toEqual([humanId!]);
  for (const invalid of [oldId!, foreignId!, decisionId!, 99999]) {
    let rejected: any;
    try { apply({ ...request, currentHumanIds, acceptance: [...request.acceptance, excepted(invalid)] }); } catch (error) { rejected = error; }
    expect(rejected?.selectionRejected).toBe(true);
    expect(rejected?.message).toContain(`humanRef ${invalid} is not a current HUMAN of this topic`);
    expect(readBacklog(f.root, f.specId).backlog).toBeNull();
  }
  const forged = invoke({ ...request, currentHumanIds: [foreignId!], acceptance: [...request.acceptance, excepted(foreignId!)] });
  expect(forged.status).toBe(1); expect(forged.receipt.selectionRejected).toBe(true);
  expect(forged.receipt.reason).toContain("not a current HUMAN of this topic");
  // A forged empty list is overwritten too: real current permission is accepted.
  const first = invoke({ ...request, currentHumanIds: [], acceptance: [...request.acceptance, excepted(humanId!)] });
  expect(first.status).toBe(0);
  const initialized = readBacklog(f.root, f.specId);
  expect(initialized.backlog!.acceptanceHistory.at(-1)!.digest).toBe(canonicalDigest(first.receipt.acceptance));
  const edited = structuredClone(initialized.backlog!); edited.tasks[0]!.status = "obsolete";
  const finalRequest = { root: f.root, specId: f.specId, key: "final", invocation: "exec1", loop: 2, authority,
    director: { select: null, changes: [], reason: "Final candidate" } };
  for (const invalidAcceptance of [[...request.acceptance, excepted(oldId!)], [excepted(humanId!)]]) {
    edited.acceptance = invalidAcceptance;
    writeFileSync(initialized.path, JSON.stringify(edited));
    const adopted = await prepare(f), before = readFileSync(initialized.path, "utf8");
    let rejected: any;
    try { apply({ ...finalRequest, expectedDigest: adopted.digest, currentHumanIds }); } catch (error) { rejected = error; }
    expect(rejected?.selectionRejected).toBe(true);
    expect(rejected?.message).toContain(invalidAcceptance.length === 1 ? "at least one blocking command" : "not a current HUMAN");
    expect(readFileSync(initialized.path, "utf8")).toBe(before);
  }
  edited.acceptance = [...request.acceptance, excepted(humanId!)];
  writeFileSync(initialized.path, JSON.stringify(edited));
  const ready = await prepare(f), finalInput = { ...finalRequest, expectedDigest: ready.digest, currentHumanIds };
  expect(apply(finalInput).selected).toBeNull();
  expect(apply(finalInput).replay).toBe(true);
  const reopened = await openBoard(f.dbPath), previous = process.env.PI_SUBAGENT_CHILD;
  try {
    delete process.env.PI_SUBAGENT_CHILD;
    reopened.postHuman(workspace, { topicId: prepared.view.topicId, type: "HUMAN", content: "Withdraw permission",
      metadata: { quote: "Withdraw permission", saidAt: "2026-11-09", supersedes: humanId! } }, { hasUI: true });
  } finally {
    reopened.close();
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous;
  }
  const freshHumanIds = await currentHumanPostIds(f);
  expect(freshHumanIds).not.toContain(humanId!);
  for (const input of [finalInput, { ...finalRequest, key: "later-final", expectedDigest: readBacklog(f.root, f.specId).digest }]) {
    let rejected: any;
    try { apply({ ...input, currentHumanIds: freshHumanIds }); } catch (error) { rejected = error; }
    expect(rejected?.selectionRejected).toBe(true);
    expect(rejected?.message).toContain("not a current HUMAN");
    // Only the replay-after-write rejection is marked non-retryable (P6e).
    expect(rejected?.replayRejected === true).toBe(input === finalInput);
  }
});


test.each(["identical", "candidate", "command", "cwd", "timeoutMs", "id", "new-invocation"])("final acceptance reuse observes fresh state and skips spawning only on a match: %s", async mode => {
  const f = fixture(), t = task("final-acceptance");
  t.gates = [{ id: "suite", command: "mkdir -p cache; echo run >> cache/runs; printf original; exit 1", cwd: ".", timeoutMs: 1000 }];
  const first = await gate(attempt(f, { task: t }));
  expect(first.mutated).toBe(false);
  const reuse = { loop: 1, gateKey: "attempt1", candidate: first.after, exec: structuredClone(t.gates), results: first.gates };
  const board = await openBoard(f.dbPath);
  try {
    const workspace = repositoryIdentity(f.root);
    const previous = process.env.PI_SUBAGENT_CHILD;
    try {
      delete process.env.PI_SUBAGENT_CHILD;
      board.postHuman(workspace, { topicId: first.view.topicId, type: "HUMAN", content: "Suite may fail",
        metadata: { quote: "Suite may fail", saidAt: "2026-11-08" } }, { hasUI: true });
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previous;
    }
  } finally { board.close(); }
  if (mode === "candidate") writeFileSync(path.join(f.root, "product"), "changed");
  if (mode === "command") t.gates[0]!.command += "; exit 1";
  if (mode === "cwd") t.gates[0]!.cwd = "cache";
  if (mode === "timeoutMs") t.gates[0]!.timeoutMs = 2000;
  if (mode === "id") t.gates[0]!.id = "renamed";
  const next = await gate(attempt(f, { task: t, key: "attempt2", loop: 2,
    ...(mode === "new-invocation" ? { invocation: "exec2" } : { reuse }) }));
  expect(next.mutated).toBe(false);
  expect(next.view.posts.some(post => post.type === "HUMAN")).toBe(true);
  if (mode === "identical") {
    expect(next.reused).toEqual({ loop: 1, gateKey: "attempt1" });
    expect(next.gates).toEqual(first.gates);
    expect(readFileSync(path.join(f.root, "cache/runs"), "utf8")).toBe("run\n");
  } else {
    expect(next.reused).toBeUndefined();
    expect(next.gates[0]!.logRef).not.toBe(first.gates[0]!.logRef);
    if (mode !== "cwd") expect(readFileSync(path.join(f.root, "cache/runs"), "utf8")).toBe("run\nrun\n");
  }
});


test("titles preserve legacy loading and reject invalid present values", () => {
  const { root } = fixture(), applied = apply(initial(root));
  const legacy = structuredClone(applied.backlog!); delete legacy.tasks[0]!.title;
  validateBacklog(legacy);
  writeFileSync(applied.path, JSON.stringify(legacy));
  expect(readBacklog(root, "example").backlog!.tasks[0]!.title).toBeUndefined();
  for (const title of [null, 1, "", " ", "x".repeat(81)]) {
    const invalid = structuredClone(legacy); Object.assign(invalid.tasks[0]!, { title });
    expect(() => validateBacklog(invalid)).toThrow("Invalid title");
  }
  const request = { ...initial(root), expectedDigest: readBacklog(root, "example").digest, key: "legacy-update" };
  expect(() => apply({ ...request, director: { select: "one", reason: "Update", changes: [
    { kind: "update", id: "one", patch: { goal: "New goal" }, reason: "Update" }] } })).toThrow("title");
  expect(() => apply({ ...request, director: { select: "one", reason: "Update", changes: [
    { kind: "update", id: "one", patch: { title: "x".repeat(81) }, reason: "Too long" }] } })).toThrow("title");
  expect(apply({ ...request, director: { select: "one", reason: "Update", changes: [
    { kind: "update", id: "one", patch: { title: "x".repeat(80) }, reason: "Short title" }] } }).selected!.title).toHaveLength(80);
});

test("add and split require valid titles and rejected changes preserve backlog bytes", () => {
  for (const title of [undefined, "", " ", "x".repeat(81)]) {
    const { root } = fixture(), child = task("child"); child.title = title;
    expect(() => apply(initial(root, [child]))).toThrow("title");
    expect(readBacklog(root, "example").backlog).toBeNull();
    const first = apply(initial(root)), before = readFileSync(first.path, "utf8");
    expect(() => apply({ ...initial(root), expectedDigest: first.digest, key: "split", director: {
      select: "child", reason: "Split", changes: [{ kind: "split", id: "one", tasks: [child], reason: "Split" }] } })).toThrow("title");
    expect(readFileSync(first.path, "utf8")).toBe(before);
  }
  const { root } = fixture();
  expect(apply(initial(root, [{ ...task(), title: "x".repeat(80) }])).selected!.title).toHaveLength(80);
});

test("title-only edits do not change a stalled definition or reset progress", () => {
  const { root } = fixture(), first = apply(initial(root, [task(), task("other")])), stalled = apply(stalledSettlement(root, first));
  const request = { ...initial(root), key: "retitle", loop: 2, expectedDigest: stalled.digest,
    director: { select: "other", reason: "Retitle", changes: [
      { kind: "update" as const, id: "one", patch: { title: "Short revised title" }, reason: "Retitle" }] } };
  expect(() => apply({ ...request, director: { ...request.director, select: "one" } })).toThrow("without a changed definition");
  const updated = apply(request).backlog!.tasks[0]!;
  expect(updated.title).toBe("Short revised title");
  expect(updated.progress).toEqual(stalled.backlog!.tasks[0]!.progress);
  const beforeDigest = updated.history.find(h => h.event === "stall")!.definitionDigest;
  const state = readBacklog(root, "example");
  const restalled = apply(stalledSettlement(root, state, 2));
  expect(restalled.backlog!.tasks[0]!.history.filter(h => h.event === "stall").at(-1)!.definitionDigest).toBe(beforeDigest);
});


test("shared binding band rejects prepare overflow and leaves room for the gate receipt", async () => {
  expect(GATE_RESERVE).toBe(2048);
  expect(viewBudget(GATE_RESERVE)).toBe(6143);
  const f = fixture(), prepared = await prepare(f), board = await openBoard(f.dbPath);
  const workspace = repositoryIdentity(f.root), topicId = prepared.view.topicId;
  try {
    const base = board.post(workspace, { topicId, type: "DECISION", content: "x" });
    const prototype = { ...base, id: base.id + 1, metadata: { supersedes: base.id } };
    const padding = BINDING_BAND_BYTES - Buffer.byteLength(JSON.stringify([viewEntry(prototype)]));
    const binding = board.post(workspace, { topicId, type: "DECISION", content: "x".repeat(padding + 1), metadata: prototype.metadata });
    expect(Buffer.byteLength(JSON.stringify([viewEntry(binding)]))).toBe(BINDING_BAND_BYTES);
    expect((await prepare(f)).view.posts).toEqual([viewEntry(binding)]);
    const receipt = await gate(attempt(f));
    expect(receipt.view.posts).toEqual([viewEntry(binding)]);
    expect(Buffer.byteLength(JSON.stringify(receipt) + "\n")).toBeLessThanOrEqual(8192);
    const overflow = board.post(workspace, { topicId, type: "DECISION", content: binding.content + "x", metadata: { supersedes: binding.id } });
    expect(Buffer.byteLength(JSON.stringify([viewEntry(overflow)]))).toBeGreaterThan(BINDING_BAND_BYTES);
    expect(Buffer.byteLength(JSON.stringify([viewEntry(overflow)]))).toBeLessThan(8192);
    await expect(prepare(f)).rejects.toMatchObject({ viewOverflow: true });
    for (const operation of ["prepare", "gate"]) {
      const result = spawnSync("node", [path.resolve("skills/execute/loop-io.mjs")], {
        cwd: f.root, input: JSON.stringify({ operation, ...attempt(f) }), encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ error: "loop-io", viewOverflow: true });
    }
  } finally { board.close(); }
});

test("gate receipt overhead overflow is explicitly marked by loop-io", () => {
  const f = fixture(), input = attempt(f);
  input.task.gates = Array.from({ length: 60 }, (_, n) => ({ id: `gate-${n}`, command: "true", cwd: ".", timeoutMs: 1000 }));
  const result = spawnSync("node", [path.resolve("skills/execute/loop-io.mjs")], {
    cwd: f.root, input: JSON.stringify({ operation: "gate", ...input }), encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ error: "loop-io", viewOverflow: true });
});


test("gate receipt carries the attempt's durable context peak, or explicit absence", async () => {
  const f = fixture();
  const checkpoint: CheckpointIntent = { version: 2, key: "worker-attempt", taskId: "one", attempt: 1, loop: 1, cursor: 0,
    phase: "implementation", planRef: null, association: { root: f.root,
      commonDir: execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: f.root, encoding: "utf8" }).trim(),
      missionId: "mission", missionPath: path.join(f.root, ".pi/mission.json"), invocation: "exec1",
      source: path.join(f.root, "spec.md"), digest: "a".repeat(64), maxCycles: 15, sourceRefs: [] } };
  expect((await gate(attempt(f, { checkpoint }))).contextPeak).toBeNull();
  recordContextPeak(checkpoint, 1200); recordContextPeak(checkpoint, 800); recordContextPeak(checkpoint, 1500);
  const receipt = await gate(attempt(f, { checkpoint }));
  expect(receipt.contextPeak).toBe(1500);
  expect(JSON.parse(readFileSync(path.join(f.root, ".pi/subagents/execute/exec1/gates/attempt1/receipt.json"), "utf8")).contextPeak).toBe(1500);
  const next = { ...checkpoint, key: "worker-next", attempt: 2 };
  expect((await gate(attempt(f, { checkpoint: next, attempt: 2, key: "next-gate" }))).contextPeak).toBeNull();
});
