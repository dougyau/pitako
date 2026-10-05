import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type ProcessIdentity = { pid: number; ppid: number; bootId: string; startTicks: string };
type DirectoryIdentity = { device: string; inode: string };
type Step = "unacquired" | "pending" | "ok" | "failed";
export type HistoryChildReceipt = {
  attemptId: string; rootIdentity: DirectoryIdentity; child: ProcessIdentity;
  phase: string; fixtureBase?: string; resources: Record<string, string>;
  assertions: Step; engineClose: Step; storeClose: Step; errors: string[];
};
export type HistoryFixtureOwner = {
  attemptId: string; root: string; temporaryDirectory: string;
  command: { executable: string; arguments: string[] };
  identity?: DirectoryIdentity; parent?: ProcessIdentity;
  state: "owned" | "released"; errors: string[];
  native: unknown; child?: HistoryChildReceipt; originalAssertion?: Step;
};
export type HistoryNativeOutcome =
  | { kind: "returned"; result: SpawnSyncReturns<string> }
  | { kind: "threw"; error: unknown };
type Stop = (code: number) => never;
const stopRunner: Stop = (code) => process.exit(code);
const describe = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function directoryIdentity(root: string): DirectoryIdentity {
  const stat = lstatSync(root, { bigint: true });
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "history root is not a directory");
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function processIdentity(pid = process.pid): ProcessIdentity {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  assert(fields[19] && /^\d+$/.test(fields[19]), "missing process birth identity");
  return { pid, ppid: Number(fields[1]), startTicks: fields[19],
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
}

function writeReceipt(root: string, name: string, receipt: unknown) {
  const file = path.join(root, `${name}.json`);
  writeFileSync(`${file}.pending`, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  renameSync(`${file}.pending`, file);
}

// Register immediately: failure to finish acquisition does not authorize deletion.
export function acquireHistoryFixture(register: (owner: HistoryFixtureOwner) => void): HistoryFixtureOwner {
  const attemptId = randomUUID();
  const root = mkdtempSync(path.join(tmpdir(), "pitako-history-attempt-"));
  const owner: HistoryFixtureOwner = { root, attemptId, state: "owned",
    command: { executable: "node", arguments: ["--experimental-transform-types", "--import",
      "./scripts/sdk-node-loader.mjs", "scripts/managed-history-node.mjs", "--reuse-fallback", root, attemptId] },
    temporaryDirectory: path.join(root, "tmp"), native: { kind: "pending" }, errors: [] };
  register(owner);
  try {
    owner.identity = directoryIdentity(root);
    owner.parent = processIdentity();
    mkdirSync(owner.temporaryDirectory, { mode: 0o700 });
    writeReceipt(root, "parent", owner);
  } catch (error) {
    owner.errors.push(describe(error));
    requireReleasedHistoryFixture(owner);
  }
  return owner;
}

export function openHistoryChild(root: string, attemptId: string) {
  assert(path.isAbsolute(root) && attemptId, "missing private history ownership arguments");
  const parent = JSON.parse(readFileSync(path.join(root, "parent.json"), "utf8"));
  const identity = directoryIdentity(root);
  assert.equal(parent.root, root);
  assert.equal(parent.attemptId, attemptId);
  assert.equal(parent.state, "owned");
  assert.equal(parent.native.kind, "pending");
  assert.deepEqual(parent.identity, identity);
  assert.deepEqual(parent.parent, processIdentity(process.ppid));
  assert.equal(parent.temporaryDirectory, path.join(root, "tmp"));
  const receipt: HistoryChildReceipt = { attemptId, rootIdentity: identity, child: processIdentity(),
    phase: "ready", resources: {}, assertions: "pending", engineClose: "unacquired",
    storeClose: "unacquired", errors: [] };
  const record = () => writeReceipt(root, "child", receipt);
  record(); // Before any fixture, Git, store or SDK acquisition.
  return { receipt, record };
}

export function requireReleasedHistoryFixture(owner?: HistoryFixtureOwner, stop: Stop = stopRunner): void {
  if (!owner || owner.state === "released") return;
  // A synchronous native return is not a JS close event or descendant proof.
  try { writeSync(2, `HISTORY FIXTURE FAIL-STOP: ${JSON.stringify(owner)}\n`); }
  catch (error) { owner.errors.push(describe(error)); }
  stop(1);
}

export function finishHistoryFixture(
  owner: HistoryFixtureOwner,
  outcome: HistoryNativeOutcome,
  assertOriginalResult: (result: SpawnSyncReturns<string>) => void,
  stop: Stop = stopRunner,
): void {
  const check = (action: () => void) => {
    try { action(); } catch (error) { owner.errors.push(describe(error)); }
  };
  const persistParent = () => {
    assert.deepEqual(directoryIdentity(owner.root), owner.identity, "owned root identity changed");
    writeReceipt(owner.root, "parent", owner);
  };
  if (outcome.kind === "threw") {
    owner.native = { kind: "threw", error: describe(outcome.error) };
    owner.errors.push(describe(outcome.error));
  } else {
    const result = outcome.result;
    owner.native = { kind: "returned", pid: result.pid, status: result.status, signal: result.signal,
      error: result.error && { name: result.error.name, message: result.error.message,
        code: (result.error as NodeJS.ErrnoException).code },
      stdout: result.stdout, stderr: result.stderr, output: result.output };
  }
  // Keep the terminal native data even when assertion/receipt validation fails.
  check(persistParent);
  if (outcome.kind === "returned") {
    const result = outcome.result;
    if (result.error) owner.errors.push(describe(result.error));
    if (result.signal !== null) owner.errors.push(`native signal: ${result.signal}`);
    if (result.status !== 0) owner.errors.push(`native status: ${result.status}`);
    check(() => {
      owner.originalAssertion = "failed";
      assertOriginalResult(result);
      owner.originalAssertion = "ok";
    });
    check(() => {
      const child: HistoryChildReceipt = JSON.parse(readFileSync(path.join(owner.root, "child.json"), "utf8"));
      owner.child = child;
      assert.equal(child.attemptId, owner.attemptId, "child attempt mismatch");
      assert.deepEqual(child.rootIdentity, owner.identity, "child root identity mismatch");
      assert.equal(child.child.pid, result.pid, "native/child PID mismatch");
      assert.equal(child.child.ppid, owner.parent?.pid, "child parent mismatch");
      assert.equal(child.child.bootId, owner.parent?.bootId, "child boot identity mismatch");
      assert.match(child.child.startTicks, /^\d+$/, "missing child birth identity");
      assert.equal(child.phase, "complete", "child lifecycle incomplete");
      assert.equal(child.assertions, "ok", "child assertions incomplete");
      assert.equal(child.engineClose, "ok", "engine cleanup incomplete");
      assert.equal(child.storeClose, "ok", "store cleanup incomplete");
      assert.deepEqual(child.errors, [], "child primary/cleanup errors");
    });
  }
  check(() => assert.deepEqual(directoryIdentity(owner.root), owner.identity, "owned root identity changed"));
  check(persistParent);
  if (!owner.errors.length) {
    // Emit the correlated receipts before removing them; stdout is never authority.
    check(() => writeSync(2, `HISTORY FIXTURE RELEASE-READY: ${JSON.stringify(owner)}\n`));
    if (!owner.errors.length) check(() => rmSync(owner.root, { recursive: true }));
    if (!owner.errors.length) {
      owner.state = "released";
      writeSync(2, `HISTORY FIXTURE RELEASED: ${JSON.stringify(owner)}\n`);
    }
  }
  if (owner.state !== "released") {
    // Recursive removal can fail partway through. Preserve the correlated receipts
    // again, but only in the same still-owned directory, never a replacement.
    check(() => {
      assert.deepEqual(directoryIdentity(owner.root), owner.identity);
      if (owner.child) writeReceipt(owner.root, "child", owner.child);
      writeReceipt(owner.root, "parent", owner);
    });
  }
  requireReleasedHistoryFixture(owner, stop);
}
