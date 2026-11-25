import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExternalCliPrompt } from "../node_modules/pi-subagents/src/runs/shared/external-cli-runner.js";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { PitakoStore } from "../extensions/pitako-store.ts";
import { openSqliteSync } from "../extensions/board/sqlite.ts";
import { gitFakeFixture } from "./fixtures/git-fake-fixture.ts";

const roots: string[] = [];
let git: ReturnType<typeof gitFakeFixture>;
beforeEach(() => { git = gitFakeFixture(); });
afterEach(() => {
  try { git.dispose(); } finally { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }
});
const empty = { count: 0, head: null };
const entry = path.resolve("skills/architecture/ledger.mjs");
const { appendLedger, verifyLedger } = await import(entry);
const anchor = ({ count, head }: any) => ({ count, head });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-architecture-ledger-")); roots.push(root);
  git.fakeRepo(root);
  git.set(root, ["rev-parse", "--git-path", "info/exclude"], { stdout: ".git/info/exclude\n", stderr: "", status: 0 });
  const missionPath = path.join(root, "missions", "mission-1.json"), consultation = "parser";
  const request = (expected: any = empty, kind = "admission", round = 0, body: any = { decision: "Initial é中😀" }) =>
    ({ missionPath, consultation, expected, record: { kind, round, body } });
  const store = new PitakoStore(root);
  const append = (...args: Parameters<typeof request>) => appendLedger(request(...args), root);
  return { root, missionPath, consultation, request, append, store };
}
async function cli(cwd: string, request: unknown) {
  const child = spawn(process.execPath, [entry], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(buildExternalCliPrompt("Fixed architecture ledger.", JSON.stringify(request)));
  const status = await closed;
  return { status, stdout, stderr };
}

test("architecture ledger archives admissions, replacements, rounds and context in the cwd store", () => {
  const f = fixture();
  expect(verifyLedger(f.missionPath, f.consultation, empty, f.root)).toEqual([]);
  expect(existsSync(f.store.file)).toBe(false);
  let saved = f.append();
  const admission = saved;
  saved = f.append(anchor(saved), "decision", 0, { decision: "Replacement" });
  saved = f.append(anchor(saved), "round", 1, { originals: ["verified reference"] });
  saved = f.append(anchor(saved), "context", 1, { humanAnswers: "Actual human", priorActive: {} });
  const records = verifyLedger(f.missionPath, f.consultation, anchor(saved), f.root);
  expect(records.map((record: any) => record.kind)).toEqual(["admission", "decision", "round", "context"]);
  expect(records[1].prev).toBe(admission.head);
  expect(records[0].body).toEqual(f.request().record.body);
  expect(existsSync(path.join(f.root, "missions"))).toBe(false);
  appendLedger({ ...f.request(), consultation: "later" }, f.root);
  expect(() => f.append(anchor(saved), "round", 2, {})).toThrow("superseded");
  expect(() => f.append()).toThrow("superseded");
  expect(verifyLedger(f.missionPath, f.consultation, anchor(saved), f.root)).toEqual(records);
  const wrong = fixture();
  expect(() => appendLedger({ missionPath: f.missionPath, consultation: f.consultation,
    expected: anchor(saved), identity: saved.identity, observe: true }, wrong.root)).toThrow("Cursor root differs from cwd");
  expect(existsSync(wrong.store.file)).toBe(false);
});

test("framed CLI replays the original head without adopting the tip and rejects changed input", async () => {
  const f = fixture();
  const first = await cli(f.root, f.request());
  expect(first.status, first.stderr).toBe(0);
  const saved = JSON.parse(first.stdout);
  const next = f.append(anchor(saved), "round", 1, { memo: "Closed" });
  expect((await cli(f.root, f.request())).stdout).toBe(first.stdout);
  expect(f.append(anchor(saved), "context", 0, { callerEvidence: "Different operation at the same anchor" }))
    .toMatchObject({ stale: true, ...anchor(next) });
  const conflict = await cli(f.root, f.request(empty, "admission", 0, { decision: "Changed" }));
  expect(conflict.status).toBe(1);
  expect(JSON.parse(conflict.stdout)).toMatchObject({ error: "ledger-integrity", reason: expect.stringContaining("conflict") });
  expect(verifyLedger(f.missionPath, f.consultation, anchor(next), f.root)).toHaveLength(2);
});

test("observe detects tampering anywhere in the scope, including beyond the saved head", async () => {
  const f = fixture();
  const saved = f.append(), tip = f.append(anchor(saved), "round", 1, { memo: "Closed" });
  const db = openSqliteSync(f.store.file);
  try { db.prepare("UPDATE records SET body=body||' ' WHERE scope=? AND seq=?").run("arch:parser", tip.count); }
  finally { db.close(); }
  const rejected = await cli(f.root, { missionPath: f.missionPath, consultation: f.consultation, expected: anchor(saved), observe: true });
  expect(rejected.status).toBe(1);
  const result = JSON.parse(rejected.stdout);
  expect(result).toMatchObject({ error: "ledger-integrity", code: "store-corrupt", reason: "Record body mismatch." });
  expect(existsSync(result.recovery.quarantine)).toBe(true);
  expect(f.store.readRecords("arch:parser").head).toBeNull();
});

test("rejects unsafe identities and invalid record order before publication", () => {
  const f = fixture();
  for (const request of [
    { ...f.request(), consultation: "../escape" }, { ...f.request(), missionPath: "relative.json" },
    f.request(empty, "round", 1), f.request(empty, "admission", 1), f.request(empty, "unknown", 0),
  ]) expect(() => appendLedger(request, f.root)).toThrow();
  expect(existsSync(f.store.file)).toBe(false);
  const saved = f.append();
  expect(() => f.append(anchor(saved), "admission", 0)).toThrow();
  expect(f.store.readRecords("arch:parser").records).toHaveLength(1);
});

test("observe verifies a pinned memo and reports unanchored context without appending", async () => {
  const f = fixture();
  const saved = f.append(), request = { missionPath: f.missionPath, consultation: f.consultation, expected: anchor(saved), observe: true };
  const memoPath = path.join(f.root, "memo.json"), memo = { memo: "Verified memo. ".repeat(30) };
  writeFileSync(memoPath, JSON.stringify(memo));
  const memoRequest = { ...request, memo: { path: memoPath, digest: canonicalDigest(memo) } };
  expect(JSON.parse((await cli(f.root, memoRequest)).stdout)).toEqual({ ...saved, excerpt: memo.memo.slice(0, 240) });
  writeFileSync(memoPath, JSON.stringify({ memo: "Tampered" }));
  expect(JSON.parse((await cli(f.root, memoRequest)).stdout)).toMatchObject({ error: "ledger-integrity", reason: "Memo digest/content mismatch." });
  f.append(anchor(saved), "context", 1, { callerEvidence: "Unanchored" });
  expect(JSON.parse((await cli(f.root, request)).stdout)).toEqual({ ...saved, pendingKind: "context" });
  expect(f.store.readRecords("arch:parser").records).toHaveLength(2);
});
