import { afterAll, expect, test } from "bun:test";
import { gitFakeFixture } from "./fixtures/git-fake-fixture.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PitakoStore } from "../extensions/pitako-store.ts";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { openSqliteSync } from "../extensions/board/sqlite.ts";

const observer = path.resolve("skills/execute/observe.mjs");
const fake = gitFakeFixture();
afterAll(() => fake.dispose());
const record = (index = 1, kind = "cancel") => ({ v: 1, requestId: `request-${index}`, invocation: "test-run",
  taskId: `task${index}`, kind, origin: "model", at: "2026-11-03T00:00:00.000Z" });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-request-observer-"));
  fake.fakeRepo(root);
  const store = new PitakoStore(root, () => null), scope = "todo:test-run";
  const write = (records: unknown[]) => store.withSession(() => {
    for (const body of records) {
      const digest = canonicalDigest(body);
      store.commit(scope, undefined, digest, digest, () => ({ kind: "request", body }));
    }
  });
  const rows = () => store.readRecords(scope).records;
  const observe = (cursor = 0, invocation = "test-run") => {
    const stdout = execFileSync("node", [observer, "--requests"], { cwd: root,
      input: JSON.stringify({ invocation, cursor }), encoding: "utf8" });
    expect(Buffer.byteLength(stdout)).toBeLessThan(60 * 1024);
    return JSON.parse(stdout);
  };
  return { root, store, scope, write, rows, observe, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("request observer reads cancel/delete records without changing either input chain or ledger anchor", async () => {
  const host = fixture();
  try {
    expect(host.observe()).toEqual({ version: 1, ok: true, invocation: "test-run", requests: [], next: null });
    const requests = [record(), record(2, "delete")];
    await host.write(requests);
    const before = JSON.stringify(host.rows());
    expect(host.observe()).toEqual({ version: 1, ok: true, invocation: "test-run", requests, next: null });
    expect(host.observe().requests).toEqual(requests);
    expect(JSON.stringify(host.rows())).toBe(before);
    expect(host.store.readRecords("exec:test-run.e0").records.some(row => row.kind === "ledger")).toBe(false);
  } finally { host.close(); }
});

test("request observer paginates 1000 tasks without truncating or losing records", async () => {
  const host = fixture();
  try {
    const requests = Array.from({ length: 1000 }, (_, index) => ({ ...record(index), requestId: "r".repeat(250) + index }));
    await host.write(requests);
    // A single owned Node child runs the same observer over every page.
    const output = execFileSync("node", ["--input-type=module", "-e", `
      const {observeRequests}=await import(${JSON.stringify(new URL("../skills/execute/observe.mjs", import.meta.url).href)});
      let cursor=0;
      do { const page=observeRequests({invocation:"test-run",cursor});
        console.log(JSON.stringify(page)); cursor=page.next; } while(cursor!==null);
    `], { cwd: host.root, encoding: "utf8" });
    const observed: unknown[] = [];
    let cursor = 0, pages = 0;
    for (const line of output.trimEnd().split("\n")) {
      expect(Buffer.byteLength(line)).toBeLessThan(60 * 1024);
      const page = JSON.parse(line);
      expect(page.ok).toBe(true);
      pages++;
      observed.push(...page.requests);
      if (page.next === null) break;
      expect(page.next).toBeGreaterThan(cursor);
      cursor = page.next;
    }
    expect(observed).toEqual(requests);
    expect(pages).toBeGreaterThan(1);
    expect(cursor).toBeGreaterThan(0);
  } finally { host.close(); }
});

test.each(["malformed", "wrong-invocation", "invalid-kind", "invalid-origin", "invalid-cursor", "traversal"])(
  "request observer fails closed on %s", async mode => {
    const host = fixture();
    try {
      const request = mode === "wrong-invocation" ? {...record(), invocation: "another-run"} :
        mode === "invalid-kind" ? record(1, "complete") :
        mode === "invalid-origin" ? {...record(), origin: "human intent"} : record();
      await host.write([request]);
      if (mode === "malformed") {
        const db = openSqliteSync(host.store.file);
        try { db.prepare("UPDATE records SET body='{' WHERE scope=?").run(host.scope); }
        finally { db.close(); }
      }
      const result = host.observe(mode === "invalid-cursor" ? 2 : 0, mode === "traversal" ? "../outside" : "test-run");
      expect(result.ok).toBe(false);
      expect(result.reason).toBeString();
      expect(result).not.toHaveProperty("requests");
    } finally { host.close(); }
  });
