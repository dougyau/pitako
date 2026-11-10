import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { checkpointScenarioFixture } from "./fixtures/plan-execute-checkpoint-scenario.ts";
import { realCheckoutCompositionFixture, nativeCheckpointFixture } from "./fixtures/plan-execute-composition.ts";

const composition = realCheckoutCompositionFixture();
const { roots, disposers, checkpointCancellations, settleWorkflows } = composition;
const native = nativeCheckpointFixture(composition);
const { nativeCheckpointExits, startNativeCheckpoint, nativeCheckpointCase, nativeCheckpointInput } = native;
const { checkpointScenario, releasePreparedPause } = checkpointScenarioFixture(composition, native);
// Fixture settlement cases do not use the SDK; scenario cases below load it.
const settlementInput = () => ({ ...nativeCheckpointInput(), sdk: false });
const startSettlementChild = () => startNativeCheckpoint({ sdk: false });

test("native checkpoint fixture owns cancellation and consumer before startup settles", async () => {
  let consumed = false;
  const pending = nativeCheckpointCase({ root: process.cwd(), missionPath: "/unused/mission.json", sdk: false },
    "async () => 'must not dispatch'", () => { consumed = true; });
  expect(checkpointCancellations.size).toBe(1);
  [...checkpointCancellations][0]!();
  await settleWorkflows();
  expect(await pending).toBeUndefined();
  expect(consumed).toBe(false);
  expect(native.nativeCheckpoint).toBeUndefined();
  expect((await nativeCheckpointExits.at(-1)!.promise)[0]).toBe(143);
});

test("native checkpoint fixture cancellation joins process, streams and case continuation", async () => {
  await startSettlementChild();
  const pending = nativeCheckpointCase(settlementInput(), "async () => new Promise(() => {})");
  const cancel = [...checkpointCancellations][0]!;
  cancel(); cancel();
  await settleWorkflows();
  expect(await pending).toBeUndefined();
  expect(native.nativeCheckpoint).toBeUndefined();
  expect((await nativeCheckpointExits.at(-1)!.promise)[0]).toBe(143);
  cancel(); // Already closed: no new signal or disposal.
});

test("native checkpoint fixture cancellation after IPC disconnect joins late continuation and streams", async () => {
  if (!native.nativeCheckpoint) await startSettlementChild();
  const child = native.nativeCheckpoint!;
  const disconnected = new Promise<void>(resolve => child.once("disconnect", resolve));
  const pending = nativeCheckpointCase(settlementInput(), `async () => {
    // Keep the disconnected process alive until the controlled cancellation, not a sleep.
    const keepAlive = setInterval(() => {}, 60000);
    process.disconnect();
    await new Promise(resolve => process.once('SIGTERM', resolve));
    clearInterval(keepAlive);
    process.stdout.write('settled stdout');
    process.stderr.write('settled stderr');
    return 'must not become a successful cancelled case';
  }`);
  let finished = false;
  const continuation = pending.then(value => { finished = true; return value; });
  await disconnected;
  expect(child.connected).toBe(false);
  expect(finished).toBe(false);
  expect(existsSync(native.nativeCheckpointRoot)).toBe(true);
  const cancel = [...checkpointCancellations][0]!;
  cancel(); cancel();
  await settleWorkflows();
  expect(await continuation).toBeUndefined();
  expect(finished).toBe(true);
  expect(native.nativeCheckpoint).toBeUndefined();
  const [exit, output, errors] = await nativeCheckpointExits.at(-1)!.promise;
  expect(exit, errors).toBe(143);
  expect(output).toContain("settled stdout");
  expect(errors).toContain("settled stderr");
  expect(errors).not.toContain("ERR_IPC_DISCONNECTED");
  expect(checkpointCancellations.size).toBe(0);
  expect(existsSync(native.nativeCheckpointRoot)).toBe(true);
  cancel();
  await startSettlementChild();
  expect(await nativeCheckpointCase(settlementInput(), "async () => 'fresh case'"))
    .toEqual([0, JSON.stringify("fresh case"), ""]);
});

test("native checkpoint fixture preserves genuine failure and subsequent normal completion", async () => {
  if (!native.nativeCheckpoint) await startSettlementChild();
  const failure = await nativeCheckpointCase(settlementInput(), "async () => { throw Error('controlled case failure'); }");
  expect(failure?.[0]).toBe(1);
  expect(failure?.[2]).toContain("controlled case failure");
  expect(await nativeCheckpointCase(settlementInput(), "async () => 'completed'"))
    .toEqual([0, JSON.stringify("completed"), ""]);
});

test("native checkpoint fixture close without a reply is not a successful case", async () => {
  if (!native.nativeCheckpoint) await startSettlementChild();
  const outcome = await nativeCheckpointCase(settlementInput(), "async () => { process.disconnect(); return 'lost reply'; }");
  expect(outcome?.[0]).toBe(1);
  expect(outcome?.[2]).toContain("closed before replying");
  expect((await nativeCheckpointExits.at(-1)!.promise)[0]).toBe(0);
  expect(native.nativeCheckpoint).toBeUndefined();
});

describe("plan/execute packaged composition", () => {
  // Controlled process preparation is file-owned, not checkpoint-case work.
  beforeAll(async () => { if (!native.nativeCheckpoint) await startNativeCheckpoint(); });
  for (const mode of ["unit-before-capture", "unit-before-capture-reentry", "unit-before-capture-reentry-mismatched-previous", "unit-before-capture-conflict", "unit-before-capture-corrupt", "unit-before-capture-newer-corrupt", "unit-before-capture-missing", "unit-before-capture-unadmitted", "unit-before-capture-wrong-baseline", "complete", "pause", "abrupt", "refused", "missing", "corrupt", "incomplete", "seal-cut", "admission-cut", "cursor-cut", "missing-receipt", "wrong-progress", "pause-continue", "pause-twice", "pause-status-continue", "pause-status-gaps", "pause-status-continue-admission-cut", "pause-status-gaps-admission-cut", "pause-missing", "pause-corrupt", "pause-conflict"]) {
    if (["pause-status-continue", "pause-corrupt", "pause-twice"].includes(mode)) {
      describe("private real paused fixture", () => {
        const ownedRoots: string[] = [], ownedDisposers: (() => void)[] = [];
        beforeAll(async () => {
          const started = performance.now();
          const firstRoot = roots.length, firstDisposer = disposers.length;
          try { await checkpointScenario(mode, true); }
          finally {
            ownedRoots.push(...roots.splice(firstRoot));
            ownedDisposers.push(...disposers.splice(firstDisposer));
          }
          console.info(`${mode} beforeAll ${(performance.now() - started).toFixed(2)}ms`);
        });
        afterAll(async () => {
          await settleWorkflows();
          for (const dispose of ownedDisposers) dispose();
          for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
          releasePreparedPause();
        });
        test(`registered checkpoint lifecycle confirms bytes with progress: ${mode}`, () => checkpointScenario(mode));
      });
      continue;
    }
    test(`registered checkpoint lifecycle confirms bytes with progress: ${mode}`, async () => {
      await checkpointScenario(mode);
      // Measured 179 (178 Git + one opaque runtime), plus 18.
      if (mode === "unit-before-capture") composition.expectProcessBudget(197);
    });
  }
});

describe("plan/execute packaged composition", () => {
  // Controlled process preparation is file-owned, not checkpoint-case work.
  beforeAll(async () => { if (!native.nativeCheckpoint) await startNativeCheckpoint(); });
  for (const mode of ["pause-later-input", "pause-input-cut", "pause-effect-cut", "pause-write-cut", "pause-empty", "pause-replay-complete", "pause-wrong-baseline", "pause-loss-reentry", "pause-equivalent-capture", "pause-successor-corrupt", "pause-repeated-publication", "pause-reusable-result"]) {
    // Explicit human budget calibration for this multi-reentry integration case;
    // the other scenarios retain Bun's existing default deadline.
    test(`registered checkpoint lifecycle confirms bytes with progress: ${mode}`,
      () => checkpointScenario(mode), mode === "pause-write-cut" ? 10000 : undefined);
  }
});

// One real Node/SDK case covers registration, capture, selective restore and seal.
describe("native SDK checkpoint wiring", () => {
  beforeAll(async () => {
    if (native.nativeCheckpoint?.connected) native.nativeCheckpoint.disconnect();
    await nativeCheckpointExits.at(-1)?.promise;
    await startNativeCheckpoint({ native: true });
    await checkpointScenario("abrupt-continue", false, true);
  });
  test("registered loader restores an interrupted unit and completes the workflow", () => checkpointScenario("abrupt-continue"));
});
