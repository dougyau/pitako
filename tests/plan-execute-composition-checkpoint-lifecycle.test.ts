import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { checkpointScenarioFixture } from "./fixtures/plan-execute-checkpoint-scenario.ts";
import { realCheckoutCompositionFixture } from "./fixtures/plan-execute-composition.ts";

const composition = realCheckoutCompositionFixture();
const { roots, disposers, checkpointCancellations, settleWorkflows } = composition;
const native = composition.runtime;
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
    // Node's IPC reader can report the peer's concurrent disconnect here.
    process.emit('error', Object.assign(new Error('IPC channel is already disconnected'), {
      code: 'ERR_IPC_DISCONNECTED',
    }));
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
  // Re-entry before the old close must join it, not reuse its occupied IPC slot.
  const successor = nativeCheckpointCase(settlementInput(), "async () => 'fresh case'");
  expect(await continuation).toBeUndefined();
  expect(await successor).toEqual([0, JSON.stringify("fresh case"), ""]);
  expect(native.nativeCheckpoint?.spawnfile).toBe(child.spawnfile);
  await settleWorkflows();
  expect(finished).toBe(true);
  const [exit, output, errors] = await nativeCheckpointExits.at(-2)!.promise;
  expect(exit, errors).toBe(143);
  expect(output).toContain("settled stdout");
  expect(errors).toContain("settled stderr");
  expect(errors).not.toContain("ERR_IPC_DISCONNECTED");
  expect(checkpointCancellations.size).toBe(0);
  expect(existsSync(native.nativeCheckpointRoot)).toBe(true);
  cancel();
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

test.each(["idle", "pending"])("native checkpoint fixture records non-owner SIGTERM while %s", async mode => {
  if (!native.nativeCheckpoint) await startSettlementChild();
  let pending: Promise<[number, string, string] | undefined> | undefined;
  if (mode === "pending") {
    pending = nativeCheckpointCase(settlementInput(), "async () => { process.send({ready:true}); return new Promise(() => {}); }");
    // Observe child entry without a sleep or a case-owned cancellation.
    await new Promise<void>(resolve => native.nativeCheckpoint!.once("message", () => resolve()));
  }
  const operation = nativeCheckpointExits.at(-1)!;
  expect(operation.cancelled).toBe(false);
  native.nativeCheckpoint!.kill("SIGTERM");
  const [exit, , errors] = await operation.promise;
  expect(exit, errors).toBe(143);
  expect(operation.cancelled).toBe(true);
  if (pending) {
    const result = await pending;
    expect(result?.[0]).toBe(143);
    expect(result?.[2]).toContain("closed before replying");
  }
  await settleWorkflows();
  expect(native.nativeCheckpoint).toBeUndefined();
  expect(checkpointCancellations.size).toBe(0);
});

test("native checkpoint fixture keeps an asynchronous consumer owned until it settles", async () => {
  if (!native.nativeCheckpoint) await startSettlementChild();
  let entered!: () => void, release!: () => void;
  const consuming = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const pending = nativeCheckpointCase(settlementInput(), "async () => 'completed'", async () => {
    entered();
    await released;
    return "consumer settled";
  });
  try {
    await consuming;
    expect(checkpointCancellations.size).toBe(1);
    let settled = false;
    const settlement = settleWorkflows().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await settlement;
    expect(await pending).toBe("consumer settled");
    expect(checkpointCancellations.size).toBe(0);
  } finally {
    release();
    await settleWorkflows();
  }
});

test("composition settlement joins workflow work after the native reply", async () => {
  const root = composition.repository();
  let entered!: () => void, release!: () => void;
  const continued = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const pending = composition.ownWorkflow(async () => {
    expect(await nativeCheckpointCase(settlementInput(), "async () => 'completed'"))
      .toEqual([0, JSON.stringify("completed"), ""]);
    entered();
    await released;
    expect(existsSync(root)).toBe(true);
  });
  try {
    await continued;
    let settled = false;
    const settlement = settleWorkflows().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await settlement;
    await pending;
  } finally {
    release();
    await pending;
  }
});

test("checkpoint child lifecycle joins asynchronous assertions before releasing roots", async () => {
  const root = composition.repository();
  let entered!: () => void, release!: () => void;
  const consuming = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const child = Bun.spawn([process.execPath, "-e", ""], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.end();
  const lifecycle = composition.checkpointLifecycle(child, async () => {
    entered();
    await released;
    expect(existsSync(root)).toBe(true);
  });
  try {
    await consuming;
    expect(checkpointCancellations.size).toBe(1);
    let settled = false;
    const settlement = settleWorkflows().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await settlement;
    await lifecycle.result;
    expect(checkpointCancellations.size).toBe(0);
  } finally {
    release();
    await lifecycle.settled;
  }
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
      // Native module loading also observes Git formerly hidden by the jiti module graph.
      // Measured 177 (176 Git + one opaque runtime), plus 18.
      if (mode === "unit-before-capture") composition.expectProcessBudget(195);
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
    await startNativeCheckpoint({ native: true, extension: false });
  });
  beforeAll(() => checkpointScenario("abrupt-continue", false, true));
  test("registered loader restores an interrupted unit and completes the workflow", () => checkpointScenario("abrupt-continue"));
});
