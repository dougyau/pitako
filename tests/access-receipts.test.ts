import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkReceipt, readAccessReceipt, receiptLocation, verifyGate } from "../extensions/access-receipts.mjs";
import { canonicalDigest, canonicalJSON, jsonDifferences, sha256 } from "../extensions/canonical.mjs";
import accessReceiptVerify from "../extensions/access-receipt-verify.ts";
import { openSqliteSync } from "../extensions/board/sqlite.ts";
import { MUTATING_TOOLS } from "../extensions/profile.ts";
import { PitakoStore } from "../extensions/pitako-store.ts";
import { gitFakeFixture } from "./fixtures/git-fake-fixture.ts";

const roots: string[] = [];
let git: ReturnType<typeof gitFakeFixture>;
beforeEach(() => { git = gitFakeFixture(); });
afterEach(() => { try { git.dispose(); } finally { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); } });
const script = path.resolve("extensions/access-receipts.mjs");
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-access-receipts-")); roots.push(root);
  git.fakeRepo(root);
  const missionPath = path.join(root, "missions", "mission-1.json");
  mkdirSync(path.join(root, "missions", "mission-1"), { recursive: true });
  writeFileSync(missionPath, JSON.stringify({ id: "mission-1" }));
  const admitted = { status: "ready", reason: "Checked", findings: [{ title: "A", location: "src/a.ts:1" }] };
  const file = path.join(root, "originals", "independent-a.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(admitted, null, 2));
  const request = (gate = "critique") => ({ missionPath, namespace: "review", gate,
    items: [{ id: "independent-a.v1.a1", key: "independent-a", path: file, admitted }] });
  const verify = (input = request()) => verifyGate(input, root);
  const check = (gate = "critique") => checkReceipt({ missionPath, namespace: "review", gate }, root);
  const stored = (gate = "critique") => readAccessReceipt({ missionPath, namespace: "review", gate }, root)!;
  return { root, missionPath, admitted, file, request, verify, check, stored };
}

test("canonical equality ignores key order and formatting; differences are bounded JSON pointers", () => {
  expect(canonicalJSON({ b: 1, a: [true, null, "x/y"] })).toBe('{"a":[true,null,"x/y"],"b":1}');
  expect(canonicalDigest({ a: 1, b: 2 })).toBe(canonicalDigest(JSON.parse('{\n  "b": 2,\n  "a": 1\n}')));
  expect(jsonDifferences({ a: { "x/y": 1 }, list: [1, 2] }, { a: { "x/y": 2 }, list: [1] })).toEqual(["/a/x~1y", "/list/1"]);
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${String(index).padStart(2, "0")}`, index]));
  expect(jsonDifferences(many, {}, 10)).toHaveLength(10);
  expect(() => canonicalJSON({ value: undefined })).toThrow("Canonical JSON requires JSON values only.");
  // Pre-optimization serializer is the byte/rejection oracle, not a second production path.
  const previous = (value: any): string => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + Array.from(value, previous).join(",") + "]";
    if (value && Object.getPrototypeOf(value) === Object.prototype)
      return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + previous(value[key])).join(",") + "}";
    throw new Error("Canonical JSON requires JSON values only.");
  };
  const f = fixture(), fake = gitFakeFixture();
  try {
    fake.fakeRepo(f.root, { paths: [] });
    fake.set(f.root, ["rev-parse", "--git-path", "info/exclude"],
      { stdout: ".git/info/exclude\n", stderr: "", status: 0 });
    const store = new PitakoStore(f.root), scope = "exec:canonical.e0";
    store.activate(scope);
    store.commit(scope, null, "record", canonicalDigest(f.admitted),
      () => ({ kind: "test", body: f.admitted }));
    const receipt = f.verify();
    const shared = { z: [true, null], a: "shared" };
    const array = [1, shared];
    Object.assign(array, { toJSON() { throw new Error("Array toJSON must not run"); } });
    for (const value of [null, true, false, -0, 1.5, 1e30, "\ud800", "\udfff", "😀\n\0\"\\",
      { "2": "two", "10": "ten", "01": "one", z: { "4294967294": 1, "4294967295": 2 } },
      { toJSON: "not callable" },
      JSON.parse('{"__proto__":{"a":1},"constructor":2}'),
      [shared, shared], array, { [Symbol("ignored")]: undefined, a: 1 },
      store.read(scope).records[0], receipt, f.stored().value]) {
      expect(canonicalJSON(value)).toBe(previous(value));
    }
    let toJSONCalls = 0;
    const invalid = [undefined, () => 1, Symbol("invalid"), 1n, NaN, Infinity, -Infinity,
      new Date(), new String("boxed"), Object.create(null), Object.create({ a: 1 }), new Map(),
      { toJSON() { toJSONCalls++; return "must not run"; } }, new Array(1)];
    for (const value of invalid) for (const input of [value, { nested: value }, [value]]) {
      expect(() => previous(input)).toThrow("Canonical JSON requires JSON values only.");
      expect(() => canonicalJSON(input)).toThrow("Canonical JSON requires JSON values only.");
    }
    expect(toJSONCalls).toBe(0);
    const cycle: any = {}; cycle.self = cycle;
    expect(() => previous(cycle)).toThrow(RangeError);
    expect(() => canonicalJSON(cycle)).toThrow(RangeError);
  } finally { fake.dispose(); }
});

test("reformatted, reordered publication is accessible; receipt is no-clobber and idempotent", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify(Object.fromEntries(Object.entries(f.admitted).reverse()), null, 4));
  const first = f.verify();
  const { receiptPath } = receiptLocation(f.missionPath, "review", "critique");
  expect(first).toMatchObject({ v: 1, outcome: "published", receipt: { store: { scope: "access:review", seq: 1 } },
    items: [{ id: "independent-a.v1.a1", state: "accessible", cause: null, digest: canonicalDigest(f.admitted) }] });
  expect(existsSync(receiptPath)).toBe(false);
  const bytes = canonicalJSON(f.stored().value) + "\n";
  expect(first.receipt!.digest).toBe(sha256(bytes));
  expect(bytes).toBe(canonicalJSON({ v: 1, namespace: "review", gate: "critique", items: [{
    id: "independent-a.v1.a1", key: "independent-a", path: f.file, digest: canonicalDigest(f.admitted),
    state: "accessible", cause: null, pointers: [], explanation: "Published original equals the admitted value.",
  }] }) + "\n");
  expect(JSON.parse(bytes).items[0]).toMatchObject({ digest: canonicalDigest(f.admitted), state: "accessible" });
  expect(f.verify()).toEqual({ ...first, outcome: "identical" });
  expect(canonicalJSON(f.stored().value) + "\n").toBe(bytes);
  // Different verified content under the same gate is a conflict, never an overwrite.
  writeFileSync(f.file, JSON.stringify({ ...f.admitted, reason: "Changed" }));
  const conflict = f.verify();
  expect(conflict.outcome).toBe("conflict");
  expect(conflict.explanation).toContain("already exists with different content");
  expect(canonicalJSON(f.stored().value) + "\n").toBe(bytes);
});

test("a changed field is contradictory with pointers, cause, key, path and an action", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.admitted, reason: "Edited after admission" }));
  const result = f.verify();
  expect(result.items[0]).toMatchObject({ state: "contradictory", cause: "content-differs" });
  for (const part of ["independent-a.v1.a1", "key independent-a", f.file, "/reason", "does not choose a version", "continue with a new invocation or consultation"])
    expect(result.items[0].explanation).toContain(part);
});

test("digest-only verification accepts canonical equality, explains changed digests and reports missing originals", () => {
  const f = fixture();
  const digest = canonicalDigest(f.admitted);
  const request = (gate: string) => ({ ...f.request(gate),
    items: [{ id: "independent-a.v1.a1", key: "independent-a", path: f.file, digest }] });
  writeFileSync(f.file, JSON.stringify(Object.fromEntries(Object.entries(f.admitted).reverse())));
  const matched = verifyGate(request("digest-match"), f.root);
  expect(matched.items[0]).toMatchObject({ state: "accessible", digest });
  expect(f.check("digest-match").status).toBe("verified");
  writeFileSync(f.file, "{}");
  const changed = verifyGate(request("digest-changed"), f.root);
  expect(changed.items[0]).toMatchObject({ state: "contradictory", cause: "content-differs", digest: canonicalDigest({}) });
  expect(changed.items[0].explanation).toContain(`Expected digest: ${digest}; actual digest: ${canonicalDigest({})}`);
  expect(changed.items[0].explanation).not.toContain("JSON pointers");
  expect((f.stored("digest-changed").value as any).items[0].pointers).toEqual([]);
  rmSync(f.file);
  expect(verifyGate(request("digest-missing"), f.root).items[0]).toMatchObject({ state: "unavailable", cause: "missing-file" });
  expect(() => verifyGate({ ...request("invalid"), items: [{ ...request("invalid").items[0], digest: "invalid" }] })).toThrow("Invalid access verifier request");
  expect(() => verifyGate({ ...request("ambiguous"), items: [{ ...request("ambiguous").items[0], admitted: f.admitted }] } as never)).toThrow("Invalid access verifier request");
});

test("only execute namespaces offer restore-and-resume; standalone passes direct to a new pass", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.admitted, reason: "Edited after admission" }));
  const standalone = f.verify().items[0].explanation;
  expect(standalone).toContain("This pass cannot resume: continue with a new invocation or consultation.");
  expect(standalone).not.toContain("resume execute");
  const embedded = f.verify({ ...f.request(), namespace: "execute-inv-1" }).items[0].explanation;
  expect(embedded).toContain("Return the published file to the admitted value and resume execute");
});

test.each(["missing-file", "parse-error"])("%s is unavailable with an explained recovery action", cause => {
  const f = fixture();
  if (cause === "missing-file") rmSync(f.file); else writeFileSync(f.file, "{not json");
  const result = f.verify();
  expect(result.items[0]).toMatchObject({ state: "unavailable", cause });
  expect(result.items[0].explanation).toContain(`unavailable: ${cause}`);
  expect(result.items[0].explanation).toContain("This pass cannot resume: continue with a new invocation or consultation.");
  const embedded = f.verify({ ...f.request(), namespace: "execute-inv-1" });
  expect(embedded.items[0].explanation).toContain("Restore the published original from its native run artifacts and resume execute");
});

test("the verify check is read-only and receipts survive native mission retention", () => {
  const f = fixture();
  const { receipt } = f.verify();
  const before = f.stored().value;
  expect(f.check()).toMatchObject({ status: "verified", receipt: { digest: receipt!.digest },
    items: [{ id: "independent-a.v1.a1", current: "unchanged" }] });
  writeFileSync(f.file, JSON.stringify({ ...f.admitted, reason: "Drifted" }));
  expect(f.check())
    .toMatchObject({ status: "drift", items: [{ current: "drift", expectedDigest: canonicalDigest(f.admitted) }] });
  expect(f.stored().value).toEqual(before);
  expect(f.check("other")).toMatchObject({ status: "missing" });
  rmSync(path.join(f.root, "missions", "mission-1"), { recursive: true });
  expect(f.check().status).toBe("drift");
});

test("the runtime verifier CLI reads framed stdin; the check CLI exits nonzero on drift; invalid input fails", () => {
  const f = fixture();
  const framed = `<System instructions>\nFixed verifier\n\n<Task>\n${JSON.stringify(f.request("synthesis"))}`;
  // Inject the exhausted store result at the commit boundary, without waiting for SQLite's retries.
  const preload = `data:text/javascript,${encodeURIComponent(`
    await import(${JSON.stringify(new URL("../skills/execute/loader.mjs", import.meta.url).href)});
    const { PitakoStore, StoreError } = await import(${JSON.stringify(new URL("../extensions/pitako-store.ts", import.meta.url).href)});
    PitakoStore.prototype.commit = function () { throw new StoreError("store-busy", "Store remained busy."); };
  `)}`;
  const busy = spawnSync("node", ["--import", preload, script, "--verify-stdin"], { cwd: f.root, input: framed, encoding: "utf8" });
  expect(busy.status, busy.stderr).toBe(0);
  expect(JSON.parse(busy.stdout)).toEqual({ v: 1, code: "store-busy" });
  expect(f.check("synthesis").status).toBe("missing");
  const run = spawnSync("node", [script, "--verify-stdin"], { cwd: f.root, input: framed, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  expect(output).toMatchObject({ outcome: "published", items: [{ state: "accessible" }] });
  const args = [script, "check", "--mission", f.missionPath, "--namespace", "review", "--gate", "synthesis"];
  expect(spawnSync("node", args, { cwd: f.root, encoding: "utf8" }).status).toBe(0);
  writeFileSync(f.file, "{}");
  const check = spawnSync("node", args, { cwd: f.root, encoding: "utf8" });
  expect(check.status).toBe(2);
  expect(JSON.parse(check.stdout).status).toBe("drift");
  const invalid = spawnSync("node", [script, "--verify-stdin"], { input: JSON.stringify({ ...f.request(), gate: "../escape" }), encoding: "utf8" });
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain("Invalid access receipt namespace or gate.");
  const oversized = spawnSync("node", [script, "--verify-stdin"], { input: "x".repeat(1024 * 1024 + 70000), encoding: "utf8" });
  expect(oversized.status).toBe(1);
  expect(oversized.stderr).toContain("exceeds");
});

test("the verify tool is read-only in every profile and reports through the same module", async () => {
  const f = fixture();
  f.verify();
  let tool: any;
  accessReceiptVerify({ registerTool(definition: any) { tool = definition; } } as never);
  expect(tool.name).toBe("access_receipt_verify");
  expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  expect(MUTATING_TOOLS.has("access_receipt_verify")).toBe(false);
  const inspector = readFileSync(path.resolve("agents/execution-inspector.md"), "utf8");
  expect(inspector).toMatch(/^tools: .*\baccess_receipt_verify\b/m);
  expect(inspector).toContain("../extensions/access-receipt-verify.ts");
  const before = f.stored().value;
  const call = (input: object) => tool.execute("call", input, undefined, undefined, { cwd: f.root });
  expect((await call({ missionPath: f.missionPath, namespace: "review", gate: "critique" })).details).toMatchObject({ status: "verified" });
  writeFileSync(f.file, "{}");
  const drift = await call({ missionPath: f.missionPath, namespace: "review", gate: "critique" });
  expect(drift.structuredContent).toMatchObject({ status: "drift", items: [{ id: "independent-a.v1.a1", current: "drift" }] });
  // The text names the drifted original and its path, not only the status.
  expect(drift.content[0].text).toContain(`- independent-a.v1.a1 (${f.file}): verified accessible, now drift; digest `);
  expect((await call({ receiptPath: f.file, gate: "critique" }))).toMatchObject({ isError: true, details: { status: "invalid-input" } });
  expect(f.stored().value).toEqual(before);
});

test("store items verify through the runtime and tool, and missing or corrupt rows remain read-only", async () => {
  const f = fixture(), fake = gitFakeFixture();
  const store = new PitakoStore(f.root), scope = "arch:access-test";
  const execScope = "exec:access-test.e0";
  try {
    fake.fakeRepo(f.root, { paths: [] });
    fake.set(f.root, ["rev-parse", "--git-path", "info/exclude"],
      { stdout: ".git/info/exclude\n", stderr: "", status: 0 });
    const { storeId } = store.activate(scope);
    store.activate(execScope);
    store.commit(scope, null, "original", canonicalDigest(f.admitted),
      () => ({ kind: "original", body: f.admitted }));
    const { digest } = store.readRecords(scope).records[0]!;

    const item = { id: "director", key: "director", store: { storeId, scope, seq: 1 }, digest };
    const verify = (gate: string, original = item) => {
      const request = f.request(gate);
      const run = spawnSync("node", [script, "--verify-stdin"], { cwd: f.root,
        input: JSON.stringify({ ...request, items: [...request.items, original] }), encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      return JSON.parse(run.stdout);
    };
    const valid = verify("store-valid");
    expect(valid).toMatchObject({ outcome: "published", items: [{ state: "accessible" }, { state: "accessible", digest }] });
    let tool: any;
    accessReceiptVerify({ registerTool(definition: any) { tool = definition; } } as never);
    const check = async () => (await tool.execute("check", { missionPath: f.missionPath, namespace: "review", gate: "store-valid" },
      undefined, undefined, { cwd: f.root })).structuredContent;
    expect(await check()).toMatchObject({ status: "verified",
      items: [{ path: f.file, current: "unchanged" }, { id: item.id, store: item.store, current: "unchanged" }] });

    const absent = { ...item, store: { ...item.store, seq: 2 } };
    const missing = verify("store-missing", absent);
    expect(missing.items[1]).toMatchObject({ state: "unavailable", code: "missing-record" });
    expect(missing.receipt).toBeNull();
    const deletion = openSqliteSync(store.file);
    try { deletion.prepare("DELETE FROM records WHERE scope=? AND seq=1").run(scope); }
    finally { deletion.close(); }
    expect(await check()).toMatchObject({ status: "unavailable", code: "missing-record" });
    store.commit(scope, null, "original", canonicalDigest(f.admitted), () => ({ kind: "original", body: f.admitted }));
    const wrongStore = verify("store-wrong-id", { ...absent, store: { ...absent.store, storeId: "wrong-store" } });
    expect(wrongStore.items[1]).toMatchObject({ state: "unavailable", code: "store-corrupt" });
    const wrongDigest = verify("store-wrong-digest", { ...item, digest: canonicalDigest(f.admitted) });
    expect(wrongDigest.items[1]).toMatchObject({ state: "unavailable", code: "store-corrupt" });

    const snapshot = () => ({ bytes: readFileSync(store.file), files: readdirSync(path.dirname(store.file)),
      receipt: f.stored("store-valid") });
    const db = openSqliteSync(store.file);
    try { db.prepare("UPDATE records SET body='null' WHERE scope=? AND seq=1").run(scope); }
    finally { db.close(); }
    const before = snapshot();
    const corrupt = await check();
    expect(corrupt).toMatchObject({ status: "unavailable", code: "store-corrupt",
      items: [{ current: "unchanged" }, { state: "unavailable", code: "store-corrupt" }] });
    expect(corrupt.items[1].explanation).toContain("deterministic store writer");
    expect(snapshot()).toEqual(before);

    // A missing tail needs a reference recheck, not just a chain scan.
    const repair = openSqliteSync(store.file);
    try { repair.prepare("UPDATE records SET body=? WHERE scope=? AND seq=1").run(canonicalJSON(f.admitted), scope); }
    finally { repair.close(); }
    const writer = new PitakoStore(f.root, undefined, { root: store.root, storeId });
    let recovery;
    try { writer.verifyRecordForWrite(absent.store, absent.digest, execScope); }
    catch (error) { recovery = error; }
    expect(recovery).toMatchObject({ code: "store-corrupt", recovery: { quarantine: expect.any(String) } });
  } finally { fake.dispose(); }
});
