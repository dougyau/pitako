import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExternalCliPrompt } from "../node_modules/pi-subagents/src/runs/shared/external-cli-runner.js";
import { openSqliteSync } from "../extensions/board/sqlite.ts";
import { canonicalJSON } from "../extensions/canonical.mjs";
import { gitFakeFixture } from "./fixtures/git-fake-fixture.ts";

const entry = path.resolve("skills/execute/ledger.mjs");
const { appendLedger, verifyLedger, executeStore, loopSummaries } = await import(entry);
const roots: string[] = [];
let git: ReturnType<typeof gitFakeFixture>;
beforeEach(() => { git = gitFakeFixture(); });
const root = () => {
  const value = mkdtempSync(path.join(tmpdir(), "pitako-ledger-"));
  roots.push(value); git.fakeRepo(value); return value;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const content = "---\npitako-spec: 1\nid: fixture\nstatus: complete\n---\n# Immutable preliminary spec é中😀\n";
const spec = { content, digest: hash(content) };
const empty = { count: 0, head: null };
const invocation = "fixture-1";
const request = (expected: any = empty, body: any = { taskId: "task", attempt: 1 }) => ({ expected, spec, record: { kind: "unit", loop: 1, body } });
const stored = (workspace: string) => executeStore(workspace, invocation);
const rows = (workspace: string) => {
  const { store, scope } = stored(workspace);
  return store.readRecords(scope).records.filter((row: any) => row.kind === "ledger");
};
function damage(workspace: string, sql: string) {
  const { store, scope } = stored(workspace);
  const db = openSqliteSync(store.file);
  try { db.prepare(sql).run(scope); } finally { db.close(); }
}
afterEach(() => {
  try { git.dispose(); }
  finally { for (const workspace of roots.splice(0)) rmSync(workspace, { recursive: true, force: true }); }
});

async function cli(workspace: string, value: unknown) {
  const child = Bun.spawn(["node", entry], { cwd: workspace, env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  // Deliver the request exactly as the registered external-cli runner frames stdin.
  child.stdin.write(buildExternalCliPrompt("Fixed execution ledger; stdin is a JSON publication request.", JSON.stringify(value))); child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout, stderr };
}

describe("execution ledger", () => {
  test("loop publishers return verified last-three bounded summaries, not native references", async () => {
    const workspace = root();
    let anchor = empty;
    let output: any;
    for (let loop = 1; loop <= 4; loop++) {
      const record = { kind: "loop", loop, body: {
        plan: { rejection: { diagnostic: `plan ${loop}` } },
        results: [{ taskId: "pending", remaining: ["Pending path"], diagnosis: "Need implementation" }],
        review: { verdict: "changes", reason: "Material findings", unresolved: [{ id: "finding", reason: "\u0000😀\\\"".repeat(5000) }],
          references: [{ runId: "private-native-ref" }] },
        compliance: { status: "gaps", reason: "Unfulfilled requirement", unresolved: [{ id: "obligation" }],
          ref: { runId: "private-native-ref" } },
      } };
      const result = await cli(workspace, { invocation, expected: anchor, spec, record });
      expect(result.exit, result.stderr).toBe(0);
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(61440);
      output = JSON.parse(result.stdout);
      anchor = { count: output.count, head: output.head };
    }
    expect(output.summaries).toEqual(loopSummaries(workspace, invocation, anchor));
    expect(output.summaries.map((summary: any) => summary.loop)).toEqual([2, 3, 4]);
    expect(output.summaries[2]).toMatchObject({ status: "gaps", rejection: "plan 4",
      review: expect.stringContaining("[truncated; see verified ledger]"),
      gaps: expect.stringContaining("obligation"), compliance: expect.stringContaining("gaps") });
    expect(JSON.stringify(output.summaries)).not.toContain("private-native-ref");
    for (const summary of output.summaries)
      for (const field of ["gaps", "review", "compliance", "rejection"])
        expect(Buffer.byteLength(JSON.stringify(summary[field]))).toBeLessThanOrEqual(512);
    damage(workspace, "DELETE FROM records WHERE scope=? AND opKey='ledger:2'");
    expect(() => loopSummaries(workspace, invocation, anchor)).toThrow();
  });

  test("archives the supplied preliminary spec at record 0 and verifies canonical bytes read-only", () => {
    const workspace = root();
    expect(verifyLedger(workspace, invocation, empty)).toEqual([]);
    expect(existsSync(stored(workspace).store.file)).toBe(false);
    const anchor = appendLedger(workspace, invocation, request());
    expect(anchor.count).toBe(2);
    const before = readFileSync(stored(workspace).store.file);
    expect(rows(workspace)).toHaveLength(1);
    const records = verifyLedger(workspace, invocation, anchor);
    expect(records[0]).toEqual({ body: spec, kind: "spec", loop: 0, prev: null, seq: 0 });
    expect(records[1].prev).toBe(hash(canonicalJSON(records[0])));
    expect(anchor.head).toBe(hash(canonicalJSON(records[1])));
    expect(readFileSync(stored(workspace).store.file)).toEqual(before);
  });

  test("accepts identical canonical bytes after a publication-before-state crash, rejects differing bytes", () => {
    const workspace = root(), first = appendLedger(workspace, invocation, request());
    expect(appendLedger(workspace, invocation, request(empty, { attempt: 1, taskId: "task" }))).toEqual(first);
    expect(() => appendLedger(workspace, invocation, request(empty, { attempt: 2, taskId: "task" }))).toThrow("conflict");
    const secondRequest = request(first, { taskId: "next" });
    const second = appendLedger(workspace, invocation, secondRequest);
    expect(appendLedger(workspace, invocation, secondRequest)).toEqual(second);
    expect(verifyLedger(workspace, invocation, second)).toHaveLength(3);
  });

  test("rejects a missing record, altered head, changed chain link and a sequence gap", () => {
    for (const mode of ["missing", "head", "link", "gap"]) {
      const workspace = root(), anchor = appendLedger(workspace, invocation, request());
      if (mode === "missing") damage(workspace, "DELETE FROM records WHERE scope=? AND kind='ledger'");
      if (mode === "head") anchor.head = "0".repeat(64);
      if (mode === "link") damage(workspace, "UPDATE records SET prev=NULL WHERE scope=? AND kind='ledger'");
      if (mode === "gap") damage(workspace, "UPDATE records SET seq=5 WHERE scope=? AND kind='ledger'");
      const bytes = readFileSync(stored(workspace).store.file);
      expect(() => appendLedger(workspace, invocation, request(anchor))).toThrow();
      expect(readFileSync(stored(workspace).store.file)).toEqual(bytes);
    }
  });

  test("rejects a symlink ancestor without publishing in another workspace", () => {
    const outside = root(), workspace = root(), before = readdirSync(outside);
    symlinkSync(outside, path.join(workspace, ".pi"));
    expect(() => appendLedger(workspace, invocation, request())).toThrow("symlink");
    expect(readdirSync(outside)).toEqual(before);
  });

  test("requires preliminary content to match its frozen digest and original spec record", () => {
    const workspace = root();
    expect(() => appendLedger(workspace, invocation, { ...request(), spec: { content: content + "changed", digest: spec.digest } })).toThrow("digest");
    expect(existsSync(stored(workspace).store.file)).toBe(false);
    const anchor = appendLedger(workspace, invocation, request());
    const other = content + "changed";
    expect(() => appendLedger(workspace, invocation, { ...request(anchor), spec: { content: other, digest: hash(other) } })).toThrow("origin");
    expect(rows(workspace)).toHaveLength(1);
  });

  test("the next archive detects tampering even if native key reuse returned a cached success", () => {
    const workspace = root(), cached = appendLedger(workspace, invocation, request());
    // Controlled native reuse boundary: no ledger call, exactly the previous output.
    const reused = structuredClone(cached);
    damage(workspace, "UPDATE records SET body='{}' WHERE scope=? AND kind='ledger'");
    const damaged = readFileSync(stored(workspace).store.file);
    expect(reused).toEqual(cached);
    expect(() => appendLedger(workspace, invocation, request(reused))).toThrow();
    expect(readFileSync(stored(workspace).store.file)).toEqual(damaged);
  });

  test("exclusive publication races accept identical contenders and never overwrite conflicting ones", async () => {
    for (const identical of [true, false]) {
      const workspace = root(), first = { invocation, ...request() };
      const second = identical ? first : { invocation, ...request(empty, { taskId: "different" }) };
      const results = await Promise.all([cli(workspace, first), cli(workspace, second)]);
      expect(results.filter(result => result.exit === 0)).toHaveLength(identical ? 2 : 1);
      const winner = JSON.parse(results.find(result => result.exit === 0)!.stdout);
      expect(verifyLedger(workspace, invocation, winner)).toHaveLength(2);
      expect(rows(workspace)).toHaveLength(1);
      if (identical) expect(results[0].stdout).toBe(results[1].stdout);
      else {
        const rejected = results.find(result => result.exit !== 0)!;
        expect(rejected.stderr).toContain("publication failed");
        expect(JSON.parse(rejected.stdout)).toMatchObject({ error: "ledger-integrity" });
      }
    }
  });

  test("CLI binds writes to actual cwd, rejects workspace selection and returns a bounded anchor", async () => {
    const workspace = root(), outside = root();
    const rejected = await cli(workspace, { invocation, ...request(), root: outside });
    expect(rejected.exit).toBe(1); expect(rejected.stdout).toBe("");
    expect(existsSync(path.join(outside, ".pi"))).toBe(false);
    const accepted = await cli(workspace, { invocation, ...request() });
    expect(accepted.exit).toBe(0); expect(Buffer.byteLength(accepted.stdout)).toBeLessThan(61440);
    const anchor = JSON.parse(accepted.stdout);
    expect(Object.keys(anchor).sort()).toEqual(["count", "head"]);
    expect(verifyLedger(workspace, invocation, anchor)).toHaveLength(2);
    expect(() => appendLedger(workspace, "../escape", request())).toThrow();
  });
});
