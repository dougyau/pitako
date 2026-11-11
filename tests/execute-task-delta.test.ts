import { beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beginHookEffect, captureBaseline, checkpointDirectory, checkpointTaskDelta, closeHookEffect, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { canonicalDigest, sha256 } from "../extensions/canonical.mjs";
import { processBudget, expectProcessBudget } from "./fixtures/process-budget.ts";
import { realCheckoutCompositionFixture, nativeCheckpointFixture } from "./fixtures/plan-execute-composition.ts";

const composition = realCheckoutCompositionFixture();
const { roots } = composition;
const runtime = nativeCheckpointFixture(composition);
beforeAll(() => runtime.startNativeCheckpoint());
const entry = path.resolve("skills/execute/loop-io.mjs");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-task-delta-")); roots.push(root);
  const budget = processBudget();
  composition.fake.fakeRepo(root, { paths: ["product", "zeta", "alpha", "prior-wip",
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
  expect(await f.delta()).toEqual({ touched: ["alpha", "product", "zeta"], netChanged: ["alpha", "zeta"], overflow: null });
  expect(await f.delta()).toEqual(await f.delta());
  // Measured 87: 47 parent Git + 39 IPC Git + one shared runtime; plus nine.
  expectProcessBudget(f.processes(), 96);
});

test("unwritten and write-then-revert attempts have distinct touched evidence", async () => {
  const f = fixture(), first = f.attempt();
  expect(await f.delta()).toEqual({ touched: [], netChanged: [], overflow: null });
  f.edit(first, ["product"], () => writeFileSync(path.join(f.root, "product"), "temporary"));
  f.edit(first, ["product"], () => writeFileSync(path.join(f.root, "product"), "original"));
  expect(await f.delta()).toEqual({ touched: ["product"], netChanged: [], overflow: null });
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
