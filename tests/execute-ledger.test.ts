import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.resolve("skills/execute/ledger.mjs");
const { appendLedger, verifyLedger, ledgerPath, loopSummaries } = await import(entry);
const roots: string[] = [];
const root = () => { const value = mkdtempSync(path.join(tmpdir(), "pitako-ledger-")); roots.push(value); return value; };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const content = "---\npitako-spec: 1\nid: fixture\nstatus: complete\n---\n# Immutable preliminary spec é中😀\n";
const spec = { content, digest: hash(content) };
const empty = { count: 0, head: null };
const invocation = "fixture-1";
const request = (expected: any = empty, body: any = { taskId: "task", attempt: 1 }) => ({ expected, spec, record: { kind: "unit", loop: 1, body } });
const file = (workspace: string, seq: number) => path.join(ledgerPath(workspace, invocation), `${String(seq).padStart(6, "0")}.json`);
afterEach(() => { for (const workspace of roots.splice(0)) rmSync(workspace, { recursive: true, force: true }); });

async function cli(workspace: string, value: unknown) {
  const child = Bun.spawn(["node", entry], { cwd: workspace, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(value)); child.stdin.end();
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
    unlinkSync(file(workspace, 2));
    expect(() => loopSummaries(workspace, invocation, anchor)).toThrow();
  });

  test("archives the supplied preliminary spec at record 0 and verifies canonical bytes read-only", () => {
    const workspace = root();
    expect(verifyLedger(workspace, invocation, empty)).toEqual([]);
    expect(existsSync(ledgerPath(workspace, invocation))).toBe(false);
    const anchor = appendLedger(workspace, invocation, request());
    expect(anchor.count).toBe(2);
    const initial = readFileSync(file(workspace, 0), "utf8");
    expect(initial).toBe(JSON.stringify({ body: { content, digest: spec.digest }, kind: "spec", loop: 0, prev: null, seq: 0 }));
    const records = verifyLedger(workspace, invocation, anchor);
    expect(records[0].body).toEqual(spec);
    expect(records[1].prev).toBe(hash(initial));
    expect(anchor.head).toBe(hash(readFileSync(file(workspace, 1), "utf8")));
    expect(readdirSync(ledgerPath(workspace, invocation)).sort()).toEqual(["000000.json", "000001.json"]);
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

  test("rejects a missing record, altered head, changed chain link and an unexpected future record", () => {
    for (const damage of ["gap", "head", "link", "future"]) {
      const workspace = root(), anchor = appendLedger(workspace, invocation, request());
      if (damage === "gap") unlinkSync(file(workspace, 0));
      if (damage === "head") anchor.head = "0".repeat(64);
      if (damage === "link") {
        const record = JSON.parse(readFileSync(file(workspace, 1), "utf8")); record.prev = "0".repeat(64);
        writeFileSync(file(workspace, 1), JSON.stringify(record));
      }
      if (damage === "future") writeFileSync(file(workspace, 4), "{}");
      expect(() => appendLedger(workspace, invocation, request(anchor))).toThrow();
      expect(existsSync(file(workspace, 2))).toBe(false);
    }
  });

  test("rejects symlink ancestors and final components without following them", () => {
    const outside = root();
    for (const component of [".pi", "000000.json", "000002.json"]) {
      const workspace = root();
      if (component === ".pi") {
        symlinkSync(outside, path.join(workspace, ".pi"));
        expect(() => appendLedger(workspace, invocation, request())).toThrow("symlink");
        expect(readdirSync(outside)).toEqual([]);
      } else {
        const anchor = appendLedger(workspace, invocation, request());
        const target = path.join(outside, "target"); writeFileSync(target, "untouched");
        const seq = component === "000000.json" ? 0 : 2;
        if (seq === 0) unlinkSync(file(workspace, seq));
        symlinkSync(target, file(workspace, seq));
        expect(() => appendLedger(workspace, invocation, request(anchor))).toThrow("symlink");
        expect(readFileSync(target, "utf8")).toBe("untouched");
      }
    }
  });

  test("requires preliminary content to match its frozen digest and original spec record", () => {
    const workspace = root();
    expect(() => appendLedger(workspace, invocation, { ...request(), spec: { content: content + "changed", digest: spec.digest } })).toThrow("digest");
    expect(existsSync(ledgerPath(workspace, invocation))).toBe(false);
    const anchor = appendLedger(workspace, invocation, request());
    const other = content + "changed";
    expect(() => appendLedger(workspace, invocation, { ...request(anchor), spec: { content: other, digest: hash(other) } })).toThrow("origin");
    expect(existsSync(file(workspace, 2))).toBe(false);
  });

  test("the next archive detects tampering even if native key reuse returned a cached success", () => {
    const workspace = root(), cached = appendLedger(workspace, invocation, request());
    // Controlled native reuse boundary: no ledger call, exactly the previous output.
    const reused = structuredClone(cached);
    writeFileSync(file(workspace, 1), "{}");
    expect(reused).toEqual(cached);
    expect(() => appendLedger(workspace, invocation, request(reused))).toThrow();
    expect(existsSync(file(workspace, 2))).toBe(false);
  });

  test("exclusive publication races accept identical contenders and never overwrite conflicting ones", async () => {
    for (const identical of [true, false]) {
      const workspace = root(), first = { invocation, ...request() };
      const second = identical ? first : { invocation, ...request(empty, { taskId: "different" }) };
      const results = await Promise.all([cli(workspace, first), cli(workspace, second)]);
      expect(results.filter(result => result.exit === 0)).toHaveLength(identical ? 2 : 1);
      const winner = JSON.parse(results.find(result => result.exit === 0)!.stdout);
      expect(verifyLedger(workspace, invocation, winner)).toHaveLength(2);
      expect(readdirSync(ledgerPath(workspace, invocation)).sort()).toEqual(["000000.json", "000001.json"]);
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
