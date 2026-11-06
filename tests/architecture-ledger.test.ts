import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExternalCliPrompt } from "../node_modules/pi-subagents/src/runs/shared/external-cli-runner.js";
import { canonicalJSON, canonicalDigest, sha256 } from "../extensions/canonical.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const empty = { count: 0, head: null };
const entry = path.resolve("skills/architecture/ledger.mjs");
const { appendLedger, ledgerPath, verifyLedger } = await import(entry);
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-architecture-ledger-")); roots.push(root);
  const missionPath = path.join(root, "missions", "mission-1.json"), consultation = "parser";
  const directory = ledgerPath(missionPath, consultation);
  const missionDirectory = path.join(root, "missions", "mission-1");
  const request = (expected: any = empty, kind = "admission", round = 0, body: any = { decision: "Initial é中😀" }) =>
    ({ missionPath, consultation, expected, record: { kind, round, body } });
  const file = (seq: number) => path.join(directory, `${String(seq).padStart(6, "0")}.json`);
  return { root, missionPath, consultation, directory, missionDirectory, request, file };
}
function cli(request: unknown) {
  return spawnSync("node", [entry], { input: buildExternalCliPrompt("Fixed architecture ledger.", JSON.stringify(request)), encoding: "utf8" });
}
const anchor = ({ count, head }: any) => ({ count, head });

test("architecture ledger archives canonical admission, decision replacements and rounds outside the checkout", () => {
  const f = fixture();
  expect(verifyLedger(f.missionPath, f.consultation, empty)).toEqual([]);
  expect(existsSync(f.directory)).toBe(false);
  let saved = appendLedger(f.request());
  expect(saved.stateBytes).toBe(0);
  const bytes = readFileSync(f.file(0), "utf8");
  expect(bytes).toBe(canonicalJSON({ seq: 0, prev: null, ...f.request().record }));
  expect(saved.head).toBe(sha256(bytes));
  saved = appendLedger(f.request(anchor(saved), "decision", 0, { decision: "Replacement" }));
  saved = appendLedger(f.request(anchor(saved), "round", 0, { originals: ["verified reference"] }));
  saved = appendLedger(f.request(anchor(saved), "context", 0, {humanAnswers: "Actual human", priorActive: {}}));
  const before = readdirSync(f.directory);
  const records = verifyLedger(f.missionPath, f.consultation, anchor(saved));
  expect(records.map((record: any) => record.kind)).toEqual(["admission", "decision", "round", "context"]);
  expect(records[1].prev).toBe(sha256(bytes));
  expect(readdirSync(f.directory)).toEqual(before);
  expect(f.directory).toBe(path.join(f.missionDirectory, "ledger", "architecture-parser"));
  expect(existsSync(path.join(f.root, ".pi"))).toBe(false);
});

test("framed CLI returns current state file byte size, accepts identical retries and reports conflicts", () => {
  const f = fixture();
  mkdirSync(f.missionDirectory, { recursive: true });
  const state = JSON.stringify({ otherWorkflow: "é中😀" }, null, 2);
  const stateFile = path.join(f.missionDirectory, "state.json");
  writeFileSync(stateFile, state);
  const first = cli(f.request());
  expect(first.status, first.stderr).toBe(0);
  const saved = JSON.parse(first.stdout);
  expect(Object.keys(saved).sort()).toEqual(["count", "head", "stateBytes"]);
  expect(saved.stateBytes).toBe(Buffer.byteLength(state));
  expect(cli(f.request()).stdout).toBe(first.stdout);
  writeFileSync(stateFile, state + "\n");
  expect(JSON.parse(cli(f.request()).stdout)).toEqual({ ...saved, stateBytes: Buffer.byteLength(state) + 1 });
  expect(readFileSync(stateFile, "utf8")).toBe(state + "\n");
  const conflict = cli(f.request(empty, "admission", 0, { decision: "Changed" }));
  expect(conflict.status).toBe(1);
  expect(JSON.parse(conflict.stdout)).toMatchObject({ error: "ledger-integrity", reason: expect.stringContaining("conflict") });
  expect(verifyLedger(f.missionPath, f.consultation, anchor(saved))).toHaveLength(1);
  const next = f.request(anchor(saved), "round", 1, { memo: "Closed" });
  const second = appendLedger(next);
  expect(appendLedger(next)).toEqual(second);
  expect(verifyLedger(f.missionPath, f.consultation, anchor(second))).toHaveLength(2);
});

test.each(["gap", "head", "link", "noncanonical", "future"])("rejects %s without appending", damage => {
  const f = fixture();
  const saved = appendLedger(f.request());
  if (damage === "gap") unlinkSync(f.file(0));
  if (damage === "head") saved.head = "0".repeat(64);
  if (damage === "link") {
    const record = JSON.parse(readFileSync(f.file(0), "utf8")); record.prev = "0".repeat(64);
    writeFileSync(f.file(0), canonicalJSON(record));
  }
  if (damage === "noncanonical") writeFileSync(f.file(0), readFileSync(f.file(0), "utf8") + "\n");
  if (damage === "future") writeFileSync(f.file(3), "{}");
  const rejected = cli(f.request(anchor(saved), "round", 1, {}));
  expect(rejected.status).toBe(1);
  expect(JSON.parse(rejected.stdout).error).toBe("ledger-integrity");
  expect(existsSync(f.file(1))).toBe(false);
});

test.each(["ancestor", "record", "next", "state"])("rejects a symlink at %s without altering its target", component => {
  const f = fixture(), outside = fixture();
  const target = path.join(outside.root, "target");
  writeFileSync(target, "untouched");
  if (component === "ancestor") {
    symlinkSync(outside.root, path.join(f.root, "missions"));
    expect(() => appendLedger(f.request())).toThrow("symlink");
    expect(readdirSync(outside.root)).toEqual(["target"]);
  } else {
    const saved = appendLedger(f.request());
    const file = component === "state" ? path.join(f.missionDirectory, "state.json") : f.file(component === "record" ? 0 : 1);
    if (component === "record") unlinkSync(file);
    symlinkSync(target, file);
    expect(() => appendLedger(f.request(anchor(saved), "round", 1, {}))).toThrow("symlink");
  }
  expect(readFileSync(target, "utf8")).toBe("untouched");
});

test("rejects unsafe identities and invalid record order before publication", () => {
  const f = fixture();
  for (const request of [
    { ...f.request(), consultation: "../escape" }, { ...f.request(), missionPath: "relative.json" },
    f.request(empty, "round", 1), f.request(empty, "admission", 1), f.request(empty, "unknown", 0),
  ]) expect(() => appendLedger(request)).toThrow();
  expect(existsSync(f.directory)).toBe(false);
  const saved = appendLedger(f.request());
  expect(() => appendLedger(f.request(anchor(saved), "admission", 0))).toThrow();
  expect(existsSync(f.file(1))).toBe(false);
});

test("observe verifies the retained chain and reports state bytes without publishing or changing files", () => {
  const f = fixture();
  const saved = appendLedger(f.request());
  const stateFile = path.join(f.missionDirectory, "state.json");
  writeFileSync(stateFile, JSON.stringify({ unrelated: "中".repeat(100) }, null, 2));
  const before = readdirSync(f.directory), bytes = readFileSync(f.file(0), "utf8");
  const request = { missionPath: f.missionPath, consultation: f.consultation, expected: anchor(saved), observe: true };
  const observed = cli(request);
  expect(observed.status, observed.stderr).toBe(0);
  expect(JSON.parse(observed.stdout)).toEqual({ ...anchor(saved), stateBytes: Buffer.byteLength(readFileSync(stateFile)) });
  expect(readdirSync(f.directory)).toEqual(before);
  expect(readFileSync(f.file(0), "utf8")).toBe(bytes);
  const memoPath = path.join(f.root, "memo.json"), memo = {memo: "Verified memo. ".repeat(30)};
  writeFileSync(memoPath, JSON.stringify(memo));
  const memoRequest = {...request, memo: {path: memoPath, digest: canonicalDigest(memo)}};
  expect(JSON.parse(cli(memoRequest).stdout)).toEqual({...anchor(saved), stateBytes: Buffer.byteLength(readFileSync(stateFile)), excerpt: memo.memo.slice(0, 240)});
  writeFileSync(memoPath, JSON.stringify({memo: "Tampered"}));
  const mismatch = cli(memoRequest);
  expect(mismatch.status).toBe(1);
  expect(JSON.parse(mismatch.stdout)).toMatchObject({error: "ledger-integrity", reason: "Memo digest/content mismatch."});
  appendLedger(f.request(anchor(saved), "context", 1, {callerEvidence: "Unanchored"}));
  expect(JSON.parse(cli(request).stdout)).toEqual({...anchor(saved), stateBytes: Buffer.byteLength(readFileSync(stateFile)), pendingKind: "context"});
  const withPending = readdirSync(f.directory);
  writeFileSync(f.file(0), bytes.replace("Initial", "Changed"));
  const damaged = cli(request);
  expect(damaged.status).toBe(1);
  expect(JSON.parse(damaged.stdout)).toMatchObject({ error: "ledger-integrity", reason: expect.stringContaining("head mismatch") });
  expect(readdirSync(f.directory)).toEqual(withPending);
});
