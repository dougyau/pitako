import { expect, test } from "bun:test";
import path from "node:path";
import type { CheckpointTaskRecord } from "../extensions/execute-checkpoint.ts";
import { sha256 } from "../extensions/canonical.mjs";
const { renderSlotDiff } = await import(path.resolve("skills/execute/loop-io.mjs")) as {
  renderSlotDiff(records: CheckpointTaskRecord[], current: Map<string, Buffer>): { bytes: Buffer; lines: number; omitted: number };
};

function record(file: string, before: Buffer, after: Buffer, status: CheckpointTaskRecord["status"] = "verified") {
  return { path: file, status, before, listed: true,
    pre: { hash: sha256(before), mode: 0o100644 }, post: { hash: sha256(after), mode: 0o100644 } };
}
function render(before: string, after: string, file = "text") {
  const pre = Buffer.from(before), post = Buffer.from(after);
  return renderSlotDiff([record(file, pre, post)], new Map([[file, post]]));
}
function sections(bytes: Buffer) {
  const text = bytes.toString();
  return text.slice(text.indexOf("--- ")).split("\n")
    .filter(line => /^[ +-]|\||^\\/.test(line) && !line.startsWith("--- ") && !line.startsWith("+++ "));
}

test("golden logical lines preserve CRLF, no-newline, UTF-8 and the 4096-byte boundary", () => {
  const line = "x".repeat(4095) + "é" + "z";
  const result = render("old\r\n", line + "\r\nlast");
  const text = result.bytes.toString();
  expect(text.slice(text.indexOf("--- a/text"))).toBe(
    "--- a/text\n+++ b/text\n@@ -1,1 +1,2 @@\n-old\n\\ CRLF\n+" +
    "x".repeat(4095) + "\n|éz\n\\ CRLF\n+last\n\\ No newline at end of file\n");
  const boundary = render("", "x".repeat(4096) + "\n");
  expect(boundary.bytes.toString()).toContain("+" + "x".repeat(4096) + "\n");
  expect(boundary.bytes.toString()).not.toContain("\n|");
  for (const physical of result.bytes.toString().split("\n"))
    expect(Buffer.byteLength(physical)).toBeLessThanOrEqual(4097);
  expect(text).not.toContain("\r");
});

// Parse the reader grammar independently, reconstructing both hunk sides.
function reconstruct(bytes: Buffer) {
  const result = { before: "", after: "" };
  let prefix = "", content = "", ending = "\n";
  const flush = () => {
    if (prefix === " " || prefix === "-") result.before += content + ending;
    if (prefix === " " || prefix === "+") result.after += content + ending;
  };
  for (const line of sections(bytes)) {
    if (line.startsWith("|")) content += line.slice(1);
    else if (line === "\\ CRLF") ending = "\r\n";
    else if (line === "\\ No newline at end of file") ending = "";
    else { flush(); prefix = line[0]!; content = line.slice(1); ending = "\n"; }
  }
  flush();
  return result;
}

test("parse-back reconstructs original bytes including BOM, contexts and multi-chunk lines", () => {
  for (const [before, after] of [
    ["\ufeffstart\r\nsame\n" + "🙂".repeat(2050) + "\r\nend", "\ufeffchanged\r\nsame\n" + "é".repeat(5000) + "\r\nend"],
    ["no newline", "new\n"], ["", "added"], ["deleted\r\n", ""],
  ]) {
    const result = reconstruct(render(before!, after!).bytes);
    expect(Buffer.from(result.before)).toEqual(Buffer.from(before!));
    expect(Buffer.from(result.after)).toEqual(Buffer.from(after!));
  }
});

test("index declares every unavailable status and binary precedes invalid UTF-8 and unchanged", () => {
  const records: ReturnType<typeof record>[] = [], current = new Map<string, Buffer>();
  for (const status of ["protected", "gitlink", "symlink", "unjournaled", "preimage-mismatch"] as const) {
    records.push(record(status, Buffer.from("secret"), Buffer.from("changed"), status));
  }
  const inputs: [string, Buffer, string][] = [
    ["nul", Buffer.from([0, 0xff]), "binary"], ["cr", Buffer.from("lone\r"), "binary"],
    ["control", Buffer.from([1]), "binary"], ["utf8", Buffer.from([0xff]), "invalid-utf8"],
    ["reverted", Buffer.from("same"), "unchanged"], ["reverted-binary", Buffer.from([0]), "binary"],
  ];
  for (const [file, bytes] of inputs) {
    const unchanged = file.startsWith("reverted");
    records.push(record(file, unchanged ? bytes : Buffer.from("old"), bytes, unchanged ? "unchanged" : "verified"));
    current.set(file, bytes);
  }
  const result = renderSlotDiff(records, current), text = result.bytes.toString();
  for (const [file, , status] of inputs)
    expect(text).toMatch(new RegExp(`${status}\\t-\\t[^\\n]+\\t"${file}"\\n`));
  for (const status of ["protected", "gitlink", "symlink", "unjournaled", "preimage-mismatch"])
    expect(text).toContain(`${status}\t-\t`);
  expect(text).not.toContain("secret");
  expect(text).not.toContain("--- ");
  expect(result.omitted).toBe(9);
  expect(render("", "tab\tand\n").bytes.toString()).toContain("+tab\tand\n");
});

test("first-fit section cap preserves later small sections and too-large retains digests", () => {
  const huge = Buffer.from("x".repeat(510 * 1024) + "\n"), medium = Buffer.from("y".repeat(4096) + "\n");
  const small = Buffer.from("z\n"), old = Buffer.from(Array.from({ length: 1001 }, (_, i) => `old-${i}\n`).join(""));
  const replacement = Buffer.from(Array.from({ length: 1001 }, (_, i) => `new-${i}\n`).join(""));
  const records = [
    record("a", Buffer.alloc(0), huge), record("b", Buffer.alloc(0), medium),
    record("c", Buffer.alloc(0), small), record("d", old, replacement),
  ];
  const result = renderSlotDiff(records, new Map([["a", huge], ["b", medium], ["c", small], ["d", replacement]]));
  const text = result.bytes.toString(), lines = text.split("\n");
  expect(text).toMatch(/rendered\t\d+\t[^\n]+\t"a"\n/);
  expect(text).toMatch(/omitted-cap\t-\t[^\n]+\t"b"\n/);
  expect(text).toMatch(/rendered\t\d+\t[^\n]+\t"c"\n/);
  expect(text).toContain(`too-large\t-\t100644 -> 100644\t${sha256(old)}\t${sha256(replacement)}\t"d"\n`);
  expect(result.omitted).toBe(2);
  for (const line of lines.filter(line => line.startsWith("rendered\t"))) {
    const fields = line.split("\t");
    expect(lines[Number(fields[1]) - 1]).toBe(`--- a/${JSON.parse(fields[5]!)}`);
  }
  expect(Buffer.byteLength(text.slice(text.indexOf("--- a/a")))).toBeLessThanOrEqual(512 * 1024);
});

test("headers quote a single path and handle addition, deletion and mode-only changes", () => {
  expect(render("a\n", "b\n", 'white space/"name').bytes.toString())
    .toContain('--- "a/white space/\\"name"\n+++ "b/white space/\\"name"\n');
  const bytes = Buffer.from("same\n"), base = record("mode", bytes, bytes);
  base.post.mode = 0o100755;
  const added = { ...record("added", Buffer.alloc(0), bytes), pre: null };
  const deleted = { ...record("deleted", bytes, Buffer.alloc(0)), post: null };
  const result = renderSlotDiff([added, deleted, base], new Map([
    ["added", bytes], ["deleted", Buffer.alloc(0)], ["mode", bytes],
  ]));
  expect(result.bytes.toString()).toContain("--- /dev/null\n+++ b/added\n");
  expect(result.bytes.toString()).toContain("--- a/deleted\n+++ /dev/null\n");
  expect(result.bytes.toString()).toContain("--- a/mode\n+++ b/mode\n");
  expect(result.omitted).toBe(1);
});
