import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const observer = path.resolve("skills/execute/observe.mjs");
const record = (index = 1, kind = "cancel") => ({ v: 1, requestId: `request-${index}`, invocation: "test-run",
  taskId: `task${index}`, kind, origin: "model", at: "2026-11-03T00:00:00.000Z" });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-request-observer-"));
  const directory = path.join(root, ".pi/subagents/execute/test-run");
  const file = path.join(directory, "requests.jsonl");
  const write = (records: unknown[]) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, records.map(value => JSON.stringify(value)).join("\n") + "\n");
  };
  const observe = (cursor = 0, invocation = "test-run") => {
    const stdout = execFileSync("node", [observer, "--requests"], { cwd: root,
      input: JSON.stringify({ invocation, cursor }), encoding: "utf8" });
    expect(Buffer.byteLength(stdout)).toBeLessThan(60 * 1024);
    return JSON.parse(stdout);
  };
  return { root, directory, file, write, observe, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("request observer reads cancel/delete records without changing request or ledger bytes", () => {
  const host = fixture();
  try {
    expect(host.observe()).toEqual({ version: 1, ok: true, invocation: "test-run", requests: [], next: null });
    const requests = [record(), record(2, "delete")];
    host.write(requests);
    const ledger = path.join(host.directory, "000000.json");
    writeFileSync(ledger, "owned ledger sentinel");
    const before = readFileSync(host.file);
    expect(host.observe()).toEqual({ version: 1, ok: true, invocation: "test-run", requests, next: null });
    expect(host.observe().requests).toEqual(requests);
    expect(readFileSync(host.file)).toEqual(before);
    expect(readFileSync(ledger, "utf8")).toBe("owned ledger sentinel");
  } finally { host.close(); }
});

test("request observer paginates 1000 tasks without truncating or losing records", () => {
  const host = fixture();
  try {
    const requests = Array.from({ length: 1000 }, (_, index) => ({ ...record(index), requestId: "r".repeat(250) + index }));
    host.write(requests);
    const observed: unknown[] = [];
    let cursor = 0;
    for (;;) {
      const page = host.observe(cursor);
      expect(page.ok).toBe(true);
      observed.push(...page.requests);
      if (page.next === null) break;
      expect(page.next).toBeGreaterThan(cursor);
      cursor = page.next;
    }
    expect(observed).toEqual(requests);
    expect(cursor).toBeGreaterThan(0);
  } finally { host.close(); }
});

test.each(["malformed", "wrong-invocation", "invalid-kind", "invalid-origin", "invalid-cursor", "traversal", "symlink"])(
  "request observer fails closed on %s", mode => {
    const host = fixture();
    try {
      host.write([record()]);
      if (mode === "malformed") writeFileSync(host.file, '{"v":1');
      if (mode === "wrong-invocation") host.write([{ ...record(), invocation: "another-run" }]);
      if (mode === "invalid-kind") host.write([record(1, "complete")]);
      if (mode === "invalid-origin") host.write([{ ...record(), origin: "human intent" }]);
      if (mode === "symlink") {
        const target = path.join(host.root, "other-file");
        writeFileSync(target, readFileSync(host.file)); rmSync(host.file); symlinkSync(target, host.file);
      }
      const result = host.observe(mode === "invalid-cursor" ? 2 : 0, mode === "traversal" ? "../outside" : "test-run");
      expect(result.ok).toBe(false);
      expect(result.reason).toBeString();
      expect(result).not.toHaveProperty("requests");
    } finally { host.close(); }
  });
