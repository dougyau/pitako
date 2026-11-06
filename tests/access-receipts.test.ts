import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkReceipt, receiptLocation, verifyGate } from "../extensions/access-receipts.mjs";
import { canonicalDigest, canonicalJSON, jsonDifferences } from "../extensions/canonical.mjs";
import accessReceiptVerify from "../extensions/access-receipt-verify.ts";
import { MUTATING_TOOLS } from "../extensions/profile.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const script = path.resolve("extensions/access-receipts.mjs");
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-access-receipts-")); roots.push(root);
  const missionPath = path.join(root, "missions", "mission-1.json");
  mkdirSync(path.join(root, "missions", "mission-1"), { recursive: true });
  writeFileSync(missionPath, JSON.stringify({ id: "mission-1" }));
  const admitted = { status: "ready", reason: "Checked", findings: [{ title: "A", location: "src/a.ts:1" }] };
  const file = path.join(root, "originals", "independent-a.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(admitted, null, 2));
  const request = (gate = "critique") => ({ missionPath, namespace: "review", gate,
    items: [{ id: "independent-a.v1.a1", key: "independent-a", path: file, admitted }] });
  return { root, missionPath, admitted, file, request };
}

test("canonical equality ignores key order and formatting; differences are bounded JSON pointers", () => {
  expect(canonicalJSON({ b: 1, a: [true, null, "x/y"] })).toBe('{"a":[true,null,"x/y"],"b":1}');
  expect(canonicalDigest({ a: 1, b: 2 })).toBe(canonicalDigest(JSON.parse('{\n  "b": 2,\n  "a": 1\n}')));
  expect(jsonDifferences({ a: { "x/y": 1 }, list: [1, 2] }, { a: { "x/y": 2 }, list: [1] })).toEqual(["/a/x~1y", "/list/1"]);
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${String(index).padStart(2, "0")}`, index]));
  expect(jsonDifferences(many, {}, 10)).toHaveLength(10);
  expect(() => canonicalJSON({ value: undefined })).toThrow("Canonical JSON requires JSON values only.");
});

test("reformatted, reordered publication is accessible; receipt is no-clobber and idempotent", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify(Object.fromEntries(Object.entries(f.admitted).reverse()), null, 4));
  const first = verifyGate(f.request());
  const { receiptPath } = receiptLocation(f.missionPath, "review", "critique");
  expect(first).toMatchObject({ v: 1, outcome: "published", receipt: { path: receiptPath },
    items: [{ id: "independent-a.v1.a1", state: "accessible", cause: null, digest: canonicalDigest(f.admitted) }] });
  expect(receiptPath).toBe(path.join(f.root, "missions", "mission-1", "receipts", "review", "critique.json"));
  const bytes = readFileSync(receiptPath, "utf8");
  expect(JSON.parse(bytes).items[0]).toMatchObject({ digest: canonicalDigest(f.admitted), state: "accessible" });
  expect(verifyGate(f.request())).toEqual({ ...first, outcome: "identical" });
  expect(readFileSync(receiptPath, "utf8")).toBe(bytes);
  // Different verified content under the same gate is a conflict, never an overwrite.
  writeFileSync(f.file, JSON.stringify({ ...f.admitted, reason: "Changed" }));
  const conflict = verifyGate(f.request());
  expect(conflict.outcome).toBe("conflict");
  expect(conflict.explanation).toContain("already exists with different content");
  expect(readFileSync(receiptPath, "utf8")).toBe(bytes);
});

test("a changed field is contradictory with pointers, cause, key, path and an action", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.admitted, reason: "Edited after admission" }));
  const result = verifyGate(f.request());
  expect(result.items[0]).toMatchObject({ state: "contradictory", cause: "content-differs" });
  for (const part of ["independent-a.v1.a1", "key independent-a", f.file, "/reason", "does not choose a version", "start a new consultation/mission"])
    expect(result.items[0].explanation).toContain(part);
});

test("digest-only verification accepts canonical equality, explains changed digests and reports missing originals", () => {
  const f = fixture();
  const digest = canonicalDigest(f.admitted);
  const request = (gate: string) => ({ ...f.request(gate),
    items: [{ id: "independent-a.v1.a1", key: "independent-a", path: f.file, digest }] });
  writeFileSync(f.file, JSON.stringify(Object.fromEntries(Object.entries(f.admitted).reverse())));
  const matched = verifyGate(request("digest-match"));
  expect(matched.items[0]).toMatchObject({ state: "accessible", digest });
  expect(checkReceipt({ receiptPath: matched.receipt.path }).status).toBe("verified");
  writeFileSync(f.file, "{}");
  const changed = verifyGate(request("digest-changed"));
  expect(changed.items[0]).toMatchObject({ state: "contradictory", cause: "content-differs", digest: canonicalDigest({}) });
  expect(changed.items[0].explanation).toContain(`Expected digest: ${digest}; actual digest: ${canonicalDigest({})}`);
  expect(changed.items[0].explanation).not.toContain("JSON pointers");
  expect(JSON.parse(readFileSync(changed.receipt.path, "utf8")).items[0].pointers).toEqual([]);
  rmSync(f.file);
  expect(verifyGate(request("digest-missing")).items[0]).toMatchObject({ state: "unavailable", cause: "missing-file" });
  expect(() => verifyGate({ ...request("invalid"), items: [{ ...request("invalid").items[0], digest: "invalid" }] })).toThrow("Invalid access verifier request");
  expect(() => verifyGate({ ...request("ambiguous"), items: [{ ...request("ambiguous").items[0], admitted: f.admitted }] } as never)).toThrow("Invalid access verifier request");
});

test("only execute namespaces offer restore-and-resume; standalone passes direct to a new pass", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.admitted, reason: "Edited after admission" }));
  const standalone = verifyGate(f.request()).items[0].explanation;
  expect(standalone).toContain("This pass cannot resume: start a new consultation/mission.");
  expect(standalone).not.toContain("resume execute");
  const embedded = verifyGate({ ...f.request(), namespace: "execute-inv-1" }).items[0].explanation;
  expect(embedded).toContain("Return the published file to the admitted value and resume execute");
});

test.each(["missing-file", "parse-error"])("%s is unavailable with an explained recovery action", cause => {
  const f = fixture();
  if (cause === "missing-file") rmSync(f.file); else writeFileSync(f.file, "{not json");
  const result = verifyGate(f.request());
  expect(result.items[0]).toMatchObject({ state: "unavailable", cause });
  expect(result.items[0].explanation).toContain(`unavailable: ${cause}`);
  expect(result.items[0].explanation).toContain("This pass cannot resume: start a new consultation/mission.");
  const embedded = verifyGate({ ...f.request(), namespace: "execute-inv-1" });
  expect(embedded.items[0].explanation).toContain("Restore the published original from its native run artifacts and resume execute");
});

test("the verify check is read-only, reports drift and a pruned mission", () => {
  const f = fixture();
  const { receipt } = verifyGate(f.request());
  const before = readFileSync(receipt.path, "utf8");
  expect(checkReceipt({ receiptPath: receipt.path })).toMatchObject({ status: "verified", receipt: { digest: receipt.digest },
    items: [{ id: "independent-a.v1.a1", current: "unchanged" }] });
  writeFileSync(f.file, JSON.stringify({ ...f.admitted, reason: "Drifted" }));
  expect(checkReceipt({ missionPath: f.missionPath, namespace: "review", gate: "critique" }))
    .toMatchObject({ status: "drift", items: [{ current: "drift", expectedDigest: canonicalDigest(f.admitted) }] });
  expect(readFileSync(receipt.path, "utf8")).toBe(before);
  expect(checkReceipt({ missionPath: f.missionPath, namespace: "review", gate: "other" })).toMatchObject({ status: "missing" });
  rmSync(path.join(f.root, "missions", "mission-1"), { recursive: true });
  expect(checkReceipt({ receiptPath: receipt.path })).toMatchObject({ status: "unavailable", reason: "receipt unavailable (mission pruned)" });
});

test("the runtime verifier CLI reads framed stdin; the check CLI exits nonzero on drift; invalid input fails", () => {
  const f = fixture();
  const framed = `<System instructions>\nFixed verifier\n\n<Task>\n${JSON.stringify(f.request("synthesis"))}`;
  const run = spawnSync("node", [script, "--verify-stdin"], { input: framed, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  expect(output).toMatchObject({ outcome: "published", items: [{ state: "accessible" }] });
  expect(spawnSync("node", [script, "check", output.receipt.path], { encoding: "utf8" }).status).toBe(0);
  writeFileSync(f.file, "{}");
  const check = spawnSync("node", [script, "check", "--mission", f.missionPath, "--namespace", "review", "--gate", "synthesis"], { encoding: "utf8" });
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
  const { receipt } = verifyGate(f.request());
  let tool: any;
  accessReceiptVerify({ registerTool(definition: any) { tool = definition; } } as never);
  expect(tool.name).toBe("access_receipt_verify");
  expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  expect(MUTATING_TOOLS.has("access_receipt_verify")).toBe(false);
  const inspector = readFileSync(path.resolve("agents/execution-inspector.md"), "utf8");
  expect(inspector).toMatch(/^tools: .*\baccess_receipt_verify\b/m);
  expect(inspector).toContain("../extensions/access-receipt-verify.ts");
  const before = readFileSync(receipt.path, "utf8");
  const call = (input: object) => tool.execute("call", input, undefined, undefined, { cwd: f.root });
  expect((await call({ receiptPath: receipt.path })).details).toMatchObject({ status: "verified" });
  writeFileSync(f.file, "{}");
  const drift = await call({ missionPath: f.missionPath, namespace: "review", gate: "critique" });
  expect(drift.structuredContent).toMatchObject({ status: "drift", items: [{ id: "independent-a.v1.a1", current: "drift" }] });
  // The text names the drifted original and its path, not only the status.
  expect(drift.content[0].text).toContain(`- independent-a.v1.a1 (${f.file}): verified accessible, now drift; digest `);
  expect((await call({ receiptPath: receipt.path, gate: "critique" }))).toMatchObject({ isError: true, details: { status: "invalid-input" } });
  expect(readFileSync(receipt.path, "utf8")).toBe(before);
});
