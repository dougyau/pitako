import { beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beginHookEffect, captureBaseline, checkpointDirectory, checkpointTaskDelta, closeHookEffect, readCheckpointTaskBytes, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { canonicalDigest, sha256 } from "../extensions/canonical.mjs";
import { processBudget, expectProcessBudget } from "./fixtures/process-budget.ts";
import { realCheckoutCompositionFixture, nativeCheckpointFixture } from "./fixtures/plan-execute-composition.ts";

const composition = realCheckoutCompositionFixture();
const { roots } = composition;
const runtime = nativeCheckpointFixture(composition);
beforeAll(() => runtime.startNativeCheckpoint({ extension: false }));
const entry = path.resolve("skills/execute/loop-io.mjs");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-task-delta-")); roots.push(root);
  const budget = processBudget();
  composition.fake.fakeRepo(root, { paths: ["product", "zeta", "alpha", "prior-wip", ".env.local",
    ...Array.from({ length: 205 }, (_, index) => `new-${String(index).padStart(3, "0")}`)] });
  writeFileSync(path.join(root, "product"), "original");
  const intents: CheckpointIntent[] = [];
  function attempt() {
    const number = intents.length + 1;
    const intent: CheckpointIntent = { version: 2, key: `worker.a${number}`, taskId: "one", attempt: number,
      loop: 1, cursor: 0, phase: "implementation", planRef: { key: "director" },
      association: { root, commonDir: path.join(root, ".git"),
        missionId: "mission", missionPath: path.join(root, ".pi/mission.json"), invocation: "delta",
        source: path.join(root, "spec.md"), digest: "a".repeat(64), maxCycles: 30, sourceRefs: [] } };
    intent.baseline = captureBaseline({ intent }).candidate;
    intents.push(intent);
    return intent;
  }
  function edit(intent: CheckpointIntent, files: string[], effect: () => void) {
    const seq = beginHookEffect(intent, "write", files);
    effect();
    closeHookEffect(intent, seq);
  }
  function deltaCLI() {
    budget.counts.loopIO++;
    return JSON.parse(execFileSync("node", [entry], { cwd: root, encoding: "utf8",
      input: JSON.stringify({ operation: "taskDelta", invocation: "delta", intents }) }));
  }
  async function delta() {
    const observed = await runtime.nativeCheckpointCase({ ...runtime.nativeCheckpointInput(), root,
      missionPath: path.join(root, ".pi/mission.json"), intents,
      loopIO: new URL("../skills/execute/loop-io.mjs", import.meta.url).href },
    `async input => (await import(input.loopIO)).taskDelta({ root: input.root, invocation: "delta", intents: input.intents })`);
    expect(observed?.[0], observed?.[2]).toBe(0);
    return JSON.parse(observed![1]);
  }
  return { root, intents, attempt, edit, delta, deltaCLI,
    processes: () => [budget.processes(), composition.processes()] };
}

test("slot delta retains touched paths across attempts but excludes reverted content", async () => {
  const f = fixture(), first = f.attempt();
  f.edit(first, ["product", "zeta"], () => {
    writeFileSync(path.join(f.root, "product"), "changed");
    writeFileSync(path.join(f.root, "zeta"), "new");
  });
  const second = f.attempt();
  f.edit(second, ["product", "alpha"], () => {
    writeFileSync(path.join(f.root, "product"), "original");
    writeFileSync(path.join(f.root, "alpha"), "new");
  });
  const delta = await f.delta();
  expect(delta).toEqual({ touched: ["alpha", "product", "zeta"], netChanged: ["alpha", "zeta"], overflow: null,
    diff: expect.objectContaining({ omitted: 0 }) });
  const bytes = readFileSync(delta.diff.path);
  expect(delta.diff.path).toBe(path.join(f.root, ".pi/subagents/execute/delta/task-deltas", `diff-${sha256(bytes)}.patch`));
  expect(delta.diff.sha256).toBe(sha256(bytes));
  expect(delta.diff.bytes).toBe(bytes.length);
  expect(delta.diff.lines).toBe(bytes.toString().split("\n").length - 1);
  expect(bytes.toString()).toContain("--- /dev/null\n+++ b/alpha\n@@ -0,0 +1,1 @@\n+new\n\\ No newline at end of file\n");
  expect(bytes.toString()).toMatch(/unchanged\t-\t100[0-7]{3} -> 100[0-7]{3}/);
  expect(await f.delta()).toEqual(await f.delta());
  expect(readdirSync(path.dirname(delta.diff.path))).toEqual([path.basename(delta.diff.path)]);
  // Measured 87: 47 parent Git + 39 IPC Git + one shared runtime; plus nine.
  expectProcessBudget(f.processes(), 96);
});

test("unwritten and write-then-revert attempts have distinct touched evidence", async () => {
  const f = fixture(), first = f.attempt();
  expect(await f.delta()).toEqual({ touched: [], netChanged: [], overflow: null, diff: null });
  f.edit(first, ["product"], () => writeFileSync(path.join(f.root, "product"), "temporary"));
  f.edit(first, ["product"], () => writeFileSync(path.join(f.root, "product"), "original"));
  expect(await f.delta()).toEqual({ touched: ["product"], netChanged: [], overflow: null,
    diff: expect.objectContaining({ omitted: 0 }) });
});

test("net delta includes deletions and mode-only changes relative to dispatch WIP", () => {
  const f = fixture();
  writeFileSync(path.join(f.root, "prior-wip"), "untracked");
  const first = f.attempt();
  f.edit(first, ["prior-wip", "product"], () => {
    rmSync(path.join(f.root, "prior-wip"));
    chmodSync(path.join(f.root, "product"), 0o755);
  });
  // This case retains real stdin/stdout CLI transport; repeated cases reuse IPC.
  expect(f.deltaCLI().netChanged).toEqual(["prior-wip", "product"]);
});

test("more than 200 net changes publish a deterministic digest-verified overflow reference", async () => {
  const f = fixture(), first = f.attempt();
  const files = Array.from({ length: 205 }, (_, index) => `new-${String(index).padStart(3, "0")}`);
  f.edit(first, [...files].reverse(), () => {
    for (const file of files) writeFileSync(path.join(f.root, file), file);
  });
  const delta = await f.delta();
  expect(delta.touched).toEqual(files);
  expect(delta.netChanged).toEqual(files.slice(0, 200));
  expect(Object.keys(delta.overflow).sort()).toEqual(["digest", "path"]);
  const bytes = readFileSync(delta.overflow.path, "utf8"), overflow = JSON.parse(bytes);
  expect(sha256(bytes)).toBe(delta.overflow.digest);
  expect(overflow.result).toEqual(files.slice(200));
  expect(overflow.resultDigest).toBe(canonicalDigest(overflow.result));
  expect(await f.delta()).toEqual(delta);
  expect(readFileSync(delta.diff.path, "utf8")).toContain("index 205\n");
  expect(Buffer.byteLength(JSON.stringify(delta))).toBeLessThan(61440);
});

test("slot delta fails closed on missing, mismatched or corrupt baseline and open journal effects", () => {
  const f = fixture(), first = f.attempt();
  expect(() => checkpointTaskDelta([])).toThrow("first slot attempt");
  expect(() => checkpointTaskDelta([{ ...first, attempt: 2 }])).toThrow("first slot attempt");
  const baseline = path.join(checkpointDirectory(first), "baseline.json"), bytes = readFileSync(baseline, "utf8");
  writeFileSync(baseline, bytes.replace("product", "corrupt"));
  expect(() => checkpointTaskDelta(f.intents)).toThrow("digest mismatch");
  writeFileSync(baseline, bytes);
  expect(() => checkpointTaskDelta([{ ...first, baseline: { ...first.baseline!, fingerprint: "b".repeat(64) } }]))
    .toThrow("baseline association mismatch");
  const second = f.attempt();
  expect(() => checkpointTaskDelta([first, { ...second, cursor: 1 }])).toThrow("slot association mismatch");
  beginHookEffect(second, "write", ["product"]);
  expect(() => checkpointTaskDelta(f.intents)).toThrow("settled checkpoint effects");
  rmSync(baseline);
  expect(() => checkpointTaskDelta(f.intents)).toThrow();
});

test("slot records and artifact select first-touch bytes against dispatch WIP across attempts", async () => {
  const f = fixture();
  writeFileSync(path.join(f.root, "product"), "prior WIP");
  writeFileSync(path.join(f.root, "prior-wip"), "unrelated earlier work");
  writeFileSync(path.join(f.root, "alpha"), "later baseline");
  const first = f.attempt();
  f.edit(first, ["product", "zeta"], () => {
    writeFileSync(path.join(f.root, "product"), "first change");
    writeFileSync(path.join(f.root, "zeta"), "temporary");
  });
  const second = f.attempt();
  f.edit(second, ["product", "alpha", "zeta"], () => {
    writeFileSync(path.join(f.root, "product"), "second change");
    writeFileSync(path.join(f.root, "alpha"), "later change");
    rmSync(path.join(f.root, "zeta"));
  });
  const delta = checkpointTaskDelta(f.intents);
  expect(delta.touched).toEqual(["alpha", "product", "zeta"]);
  expect(delta.netChanged).toEqual(["alpha", "product"]);
  expect(delta.records.map(({ path, status, before }) => [path, status, before?.toString()]))
    .toEqual([["alpha", "verified", "later baseline"], ["product", "verified", "prior WIP"], ["zeta", "unchanged", ""]]);
  expect(delta.records.map(({ path, pre, post }) => [path, pre?.hash ?? null, post?.hash ?? null]))
    .toEqual([["alpha", sha256("later baseline"), sha256("later change")],
      ["product", sha256("prior WIP"), sha256("second change")], ["zeta", null, null]]);
  const current = readCheckpointTaskBytes(f.root, delta.records);
  expect([...current].map(([file, bytes]) => [file, bytes.toString()]))
    .toEqual([["alpha", "later change"], ["product", "second change"], ["zeta", ""]]);
  const receipt = await f.delta(), patch = readFileSync(receipt.diff.path, "utf8");
  expect(patch).toContain("--- a/product\n+++ b/product\n@@ -1,1 +1,1 @@\n-prior WIP\n\\ No newline at end of file\n+second change\n");
  expect(patch).toContain("-later baseline\n");
  expect(patch).toContain("+later change\n");
  expect(patch).not.toContain("original");
  expect(patch).not.toContain("first change");
  expect(patch).not.toContain("unrelated earlier work");
  expect(patch).not.toContain('"prior-wip"');
  writeFileSync(path.join(f.root, "zeta"), "concurrent creation");
  expect(() => readCheckpointTaskBytes(f.root, delta.records))
    .toThrow("digest mismatch: zeta (concurrent writer)");
  rmSync(path.join(f.root, "zeta"));
  symlinkSync("alpha", path.join(f.root, "zeta"));
  expect(() => readCheckpointTaskBytes(f.root, delta.records))
    .toThrow("digest mismatch: zeta (concurrent writer)");
});

test("taskDelta publishes index-only evidence for a journaled gitignored path present on disk", async () => {
  const f = fixture();
  composition.fake.fakeRepo(f.root, { paths: ["product"], ignored: ["ignored"] });
  const first = f.attempt();
  f.edit(first, ["ignored"], () => writeFileSync(path.join(f.root, "ignored"), "ignored content"));
  const snapshot = checkpointTaskDelta(f.intents);
  expect(snapshot.records).toEqual([{ path: "ignored", status: "unchanged", pre: null, post: null,
    listed: false, unlistedHash: sha256("ignored content"), before: Buffer.alloc(0) }]);
  expect(readCheckpointTaskBytes(f.root, snapshot.records).get("ignored"))
    .toEqual(Buffer.alloc(0));
  const receipt = await f.delta(), patch = readFileSync(receipt.diff.path);
  expect(receipt).toEqual({ touched: ["ignored"], netChanged: [], overflow: null,
    diff: expect.objectContaining({ sha256: sha256(patch), omitted: 0 }) });
  expect(patch.toString()).toContain('unchanged\t-\t- -> -\t-\t-\t"ignored"\n');
  expect(patch.toString()).not.toContain("ignored content");
});

test("taskDelta publishes a deletion for a baseline-visible journaled file ignored during the slot", async () => {
  const f = fixture();
  composition.fake.fakeRepo(f.root, { paths: ["product", "ignored"] });
  writeFileSync(path.join(f.root, "ignored"), "visible baseline\n");
  const first = f.attempt();
  f.edit(first, ["ignored", ".gitignore"], () => {
    writeFileSync(path.join(f.root, "ignored"), "ignored candidate\n");
    writeFileSync(path.join(f.root, ".gitignore"), "ignored\n");
  });
  // The declared Git boundary now excludes the untracked file via .gitignore.
  composition.fake.fakeRepo(f.root, { paths: ["product", ".gitignore"], ignored: ["ignored"] });
  const snapshot = checkpointTaskDelta(f.intents);
  expect(snapshot.records.find(record => record.path === "ignored")).toEqual({
    path: "ignored", status: "verified", pre: { hash: sha256("visible baseline\n"), mode: expect.any(Number) },
    post: null, listed: false, unlistedHash: sha256("ignored candidate\n"), before: Buffer.from("visible baseline\n"),
  });
  expect(readCheckpointTaskBytes(f.root, snapshot.records).get("ignored")).toEqual(Buffer.alloc(0));
  expect(readFileSync(path.join(f.root, "ignored"), "utf8")).toBe("ignored candidate\n");
  const receipt = await f.delta(), patch = readFileSync(receipt.diff.path);
  expect(receipt).toEqual({ touched: [".gitignore", "ignored"], netChanged: [".gitignore", "ignored"], overflow: null,
    diff: expect.objectContaining({ sha256: sha256(patch), omitted: 0 }) });
  expect(patch.toString()).toContain("--- a/ignored\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-visible baseline\n");
  expect(patch.toString()).not.toContain("ignored candidate");
});

test("taskDelta publishes a deletion when a journaled untracked file is replaced by a directory", async () => {
  const f = fixture();
  writeFileSync(path.join(f.root, "zeta"), "untracked baseline");
  const first = f.attempt();
  f.edit(first, ["zeta"], () => rmSync(path.join(f.root, "zeta")));
  mkdirSync(path.join(f.root, "zeta"));
  // Git no longer lists the untracked file once only an empty directory remains.
  composition.fake.fakeRepo(f.root, { paths: ["product"] });
  const receipt = await f.delta(), patch = readFileSync(receipt.diff.path);
  expect(receipt).toEqual({ touched: ["zeta"], netChanged: ["zeta"], overflow: null,
    diff: expect.objectContaining({ sha256: sha256(patch), omitted: 0 }) });
  expect(patch.toString()).toContain("--- a/zeta\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-untracked baseline\n");
});

test.each(["listed change", "unlisted recreation"])("taskDelta halts on %s after its snapshot without publishing a diff", kind => {
  const f = fixture(), file = kind === "listed change" ? "product" : "prior-wip";
  if (kind === "unlisted recreation") writeFileSync(path.join(f.root, file), "untracked baseline");
  const first = f.attempt();
  f.edit(first, [file], () => {
    if (kind === "unlisted recreation") rmSync(path.join(f.root, file));
    else writeFileSync(path.join(f.root, file), "candidate");
  });
  if (kind === "unlisted recreation")
    composition.fake.fakeRepo(f.root, { paths: ["product"] });
  const snapshot = checkpointTaskDelta(f.intents);
  if (kind === "unlisted recreation")
    expect(snapshot.records).toEqual([expect.objectContaining({
      path: file, status: "verified", listed: false, post: null, unlistedHash: null,
    })]);
  const output = composition.execFileSync("node", ["--input-type=module", "-e", `
      const input = JSON.parse(process.argv[1]);
      const runtime = await import(${JSON.stringify(new URL("../skills/execute/loop-io.mjs", import.meta.url).href)});
      const fs = (await import("node:fs")).default;
      const { syncBuiltinESMExports } = await import("node:module");
      const original = fs.lstatSync, limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 100;
      fs.lstatSync = function(file, ...args) {
        if (String(file) === input.root + "/" + input.file && new Error().stack.includes("readCheckpointTaskBytes"))
          fs.writeFileSync(file, "concurrent");
        return original.call(this, file, ...args);
      };
      syncBuiltinESMExports();
      try {
        runtime.taskDelta({ root: input.root, invocation: "delta", intents: input.intents });
        console.log("unexpected success");
      } catch (error) { console.log(error.message); }
      finally { fs.lstatSync = original; Error.stackTraceLimit = limit; syncBuiltinESMExports(); }
    `, JSON.stringify({ root: f.root, intents: f.intents, file })], { cwd: f.root, encoding: "utf8" });
  expect(output.trim()).toBe(`digest mismatch: ${file} (concurrent writer)`);
  expect(existsSync(path.join(f.root, ".pi/subagents/execute/delta/task-deltas"))).toBe(false);
});

test("mismatched preimages and unjournaled or protected changes expose only digests and are not read", () => {
  const f = fixture(), first = f.attempt();
  writeFileSync(path.join(f.root, "product"), "unjournaled before capture");
  f.edit(first, ["product"], () => writeFileSync(path.join(f.root, "product"), "captured change"));
  writeFileSync(path.join(f.root, "zeta"), "unjournaled");
  writeFileSync(path.join(f.root, ".env.local"), "secret");
  const delta = checkpointTaskDelta(f.intents);
  expect(delta.records.map(({ path, status, before }) => [path, status, before]))
    .toEqual([[".env.local", "protected", undefined], ["product", "preimage-mismatch", undefined],
      ["zeta", "unjournaled", undefined]]);
  // If any excluded path were read, its changed hash (or rejected safePath) would fail.
  for (const file of [".env.local", "product", "zeta"]) writeFileSync(path.join(f.root, file), "changed again");
  expect(readCheckpointTaskBytes(f.root, delta.records).size).toBe(0);
});

test("current-bytes reader compares hash and absence, ignores modes, and halts concurrent changes", () => {
  const f = fixture();
  composition.fake.fakeRepo(f.root, { paths: ["product", "alpha", "dir/file", "dir/gone"] });
  mkdirSync(path.join(f.root, "dir"));
  const first = f.attempt();
  f.edit(first, ["product", "alpha", "dir/file", "dir/gone"], () => {
    writeFileSync(path.join(f.root, "product"), "candidate");
    writeFileSync(path.join(f.root, "alpha"), "added");
    writeFileSync(path.join(f.root, "dir/file"), "nested candidate");
  });
  const delta = checkpointTaskDelta(f.intents);
  chmodSync(path.join(f.root, "product"), 0o755);
  expect(readCheckpointTaskBytes(f.root, delta.records).get("product")?.toString()).toBe("candidate");
  writeFileSync(path.join(f.root, "product"), "concurrent");
  expect(() => readCheckpointTaskBytes(f.root, delta.records))
    .toThrow("digest mismatch: product (concurrent writer)");
  writeFileSync(path.join(f.root, "product"), "candidate");
  rmSync(path.join(f.root, "alpha"));
  expect(() => readCheckpointTaskBytes(f.root, delta.records))
    .toThrow("digest mismatch: alpha (concurrent writer)");
  writeFileSync(path.join(f.root, "alpha"), "added");
  rmSync(path.join(f.root, "product"));
  symlinkSync("alpha", path.join(f.root, "product"));
  expect(() => readCheckpointTaskBytes(f.root, delta.records))
    .toThrow("digest mismatch: product (concurrent writer)");
  rmSync(path.join(f.root, "dir"), { recursive: true });
  writeFileSync(path.join(f.root, "dir"), "replaced parent");
  expect(readCheckpointTaskBytes(f.root, delta.records.filter(record => record.path === "dir/gone")).get("dir/gone"))
    .toEqual(Buffer.alloc(0));
  expect(() => readCheckpointTaskBytes(f.root, delta.records))
    .toThrow("digest mismatch: dir/file (concurrent writer)");
});

test("slot records classify snapshot directory digests as gitlinks without reading content", () => {
  const f = fixture();
  composition.fake.fakeRepo(f.root, { paths: ["product", "zeta"],
    stage: `160000 ${"2".repeat(40)} 0\tzeta\0` });
  f.attempt();
  mkdirSync(path.join(f.root, "zeta"));
  const delta = checkpointTaskDelta(f.intents);
  expect(delta.touched).toEqual([]);
  expect(delta.netChanged).toEqual(["zeta"]);
  expect(delta.records).toEqual([{ path: "zeta", status: "gitlink", pre: null, listed: true,
    post: { hash: expect.stringMatching(/^[a-f0-9]{64}$/), mode: expect.any(Number) } }]);
  expect(delta.records[0]!.post!.mode & 0o170000).toBe(0o040000);
  expect(readCheckpointTaskBytes(f.root, delta.records).size).toBe(0);
});
