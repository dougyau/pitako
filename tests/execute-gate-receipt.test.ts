import { afterEach, beforeEach, expect, test } from "bun:test";
import { gitFakeFixture } from "./fixtures/git-fake-fixture.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { PitakoStore, MAX_GATE_LOG_BYTES } from "../extensions/pitako-store.ts";
import { openSqliteSync } from "../extensions/board/sqlite.ts";
import { gate, type GateInput } from "../skills/execute/loop.ts";
import { openBoard } from "../extensions/board/store.ts";
import { repositoryIdentity } from "../extensions/board/workspace.ts";

const { canonicalDigest } = createRequire(import.meta.url)("../extensions/canonical.mjs") as { canonicalDigest(value: unknown): string };
let fake: ReturnType<typeof gitFakeFixture>;
beforeEach(() => { fake = gitFakeFixture(); });
const roots: string[] = [];
afterEach(() => { try { fake.dispose(); } finally { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); } });

function fixture(): GateInput {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-gate-receipt-")); roots.push(root);
  fake.fakeRepo(root, { paths: ["product", ".gitignore"] });
  writeFileSync(path.join(root, "product"), "original");
  writeFileSync(path.join(root, ".gitignore"), "cache/\n");
  mkdirSync(path.join(root, "cache"));

  return { root, specId: "example", invocation: "exec1", loop: 1, attempt: 1, key: "worker.gate",
    writerSettled: true, workerStatus: "complete", dbPath: path.join(root, ".pi/board.db"),
    task: { id: "one", gates: [{ id: "focused", command: "echo gate >> cache/runs; printf passed", cwd: ".", timeoutMs: 1000 }],
      metric: { command: "echo metric >> cache/runs; printf 3", unit: "count", target: 0 },
      progress: { nonImproving: 0, last5: [] } } };
}
const directory = (input: GateInput, suffix = "") => path.join(input.root, ".pi/subagents/execute", input.invocation, `gates/worker.gate${suffix}`);
const stored = (input: GateInput) => new PitakoStore(input.root).readRecords(`exec:${input.invocation}.e0`).records.filter(row => row.kind === "gate");
const receipt = (input: GateInput, suffix = "") => stored(input).find(row => row.opKey === `gate:worker.gate${suffix}`)!;
const runs = (input: GateInput) => readFileSync(path.join(input.root, "cache/runs"), "utf8");

test.each(["same-key", "transport-retry"])("identical %s replay spawns neither metric nor gates and preserves receipt bytes", async mode => {
  const input = fixture(), first = await gate(input), original = JSON.stringify(receipt(input).body);
  const saved = JSON.parse(original), { receiptDigest, ...body } = saved;
  expect(receiptDigest).toBe(canonicalDigest(body));
  expect(saved.identity).toMatchObject({ attemptKey: "worker", workerStatus: "complete", after: first.after });
  expect(saved.identity.commandsDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(saved.identity.progressInputDigest).toMatch(/^[a-f0-9]{64}$/);
  const replay = await gate({ ...input, key: mode === "transport-retry" ? "worker.gate.r1" : input.key });
  expect(replay).toEqual(first);
  expect(runs(input)).toBe("metric\ngate\n");
  expect(JSON.stringify(receipt(input).body)).toBe(original);
  expect(readdirSync(directory(input))).toEqual([]);
});

test.each(["id", "command", "cwd", "timeoutMs", "metric-command", "metric-timeout", "worker-status", "progress", "target",
  "candidate-fingerprint", "candidate-head"] as const)("changed %s runs fresh into .rN without overwriting", async mode => {
  const input = fixture(), first = await gate(input);
  if (mode === "id") input.task.gates[0]!.id = "renamed";
  if (mode === "command") input.task.gates[0]!.command += "; printf changed";
  if (mode === "cwd") input.task.gates[0]!.cwd = "./";
  if (mode === "timeoutMs") input.task.gates[0]!.timeoutMs++;
  if (mode === "metric-command") input.task.metric!.command += "; printf ' '";
  if (mode === "metric-timeout") input.metricTimeoutMs = 1000;
  if (mode === "worker-status") input.workerStatus = "continue";
  if (mode === "progress") input.task.progress.nonImproving++;
  if (mode === "target") input.task.metric!.target++;
  if (mode === "candidate-fingerprint") writeFileSync(path.join(input.root, "product"), "changed");
  if (mode === "candidate-head") {
    fake.set(input.root, ["rev-parse", "HEAD"], { stdout: "2".repeat(40) + "\n", stderr: "", status: 0 });
    fake.set(input.root, ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], { stdout: "2".repeat(40) + "\nmain\n", stderr: "", status: 0 });
  }
  const original = JSON.stringify(receipt(input).body);
  const fresh = await gate(input);
  expect(runs(input)).toBe(mode === "worker-status" ? "metric\ngate\nmetric\n" : "metric\ngate\nmetric\ngate\n");
  expect(JSON.stringify(receipt(input).body)).toBe(original);
  expect(receipt(input, ".r1").body).toMatchObject({after: fresh.after});
  if (fresh.gates.length && mode === "command") expect(fresh.gates[0]!.logRef).not.toBe(first.gates[0]!.logRef);
  await gate(input);
  expect(runs(input)).toBe(mode === "worker-status" ? "metric\ngate\nmetric\n" : "metric\ngate\nmetric\ngate\n");
});

test("replay refreshes the Board view and bounds diagnostic tails without changing saved evidence", async () => {
  const input = fixture();
  input.task.gates[0]!.command = "printf HEAD; head -c 1250000 /dev/zero | tr '\\0' x; printf TAIL; echo gate >> cache/runs";
  const first = await gate(input), original = JSON.stringify(receipt(input).body);
  const blob = new PitakoStore(input.root).readBlob(first.gates[0]!.logRef);
  expect(blob).toMatchObject({size: MAX_GATE_LOG_BYTES, originalSize: 1250008, truncated: true});
  expect(blob.bytes).toEqual(Buffer.from("HEAD" + "x".repeat(MAX_GATE_LOG_BYTES - 8) + "TAIL"));
  expect(new PitakoStore(input.root).readBlob(first.metric!.logRef)).toMatchObject({truncated: false, bytes: Buffer.from("3")});
  expect(readdirSync(directory(input))).toEqual([]);
  const board = await openBoard(input.dbPath);
  try {
    board.post(repositoryIdentity(input.root), { topicId: first.view.topicId, type: "DECISION", content: "Current rule" });
  } finally { board.close(); }
  const replay = await gate(input);
  expect(replay.view.posts.some(post => post.content === "Current rule")).toBe(true);
  expect(Buffer.byteLength(replay.gates[0]!.tail)).toBeLessThanOrEqual(2048);
  expect(Buffer.byteLength(JSON.stringify(replay) + "\n")).toBeLessThanOrEqual(8192);
  expect(runs(input)).toBe("metric\ngate\n");
  expect(JSON.stringify(receipt(input).body)).toBe(original);
});

test("interrupted directory is retained; receipt appears only after commands settle", async () => {
  const input = fixture();
  mkdirSync(directory(input), { recursive: true });
  writeFileSync(path.join(directory(input), "metric.log"), "interrupted");
  input.task.metric = null;
  input.task.gates[0]!.command = "echo gate >> cache/runs";
  const result = await gate(input);
  expect(result.gates[0]!.status).toBe("pass");
  expect(readFileSync(path.join(directory(input), "metric.log"), "utf8")).toBe("interrupted");
  expect(readdirSync(directory(input))).toEqual(["metric.log"]);
  expect(readdirSync(directory(input, ".r1"))).toEqual([]);
  const original = JSON.stringify(receipt(input, ".r1").body);
  input.task.progress.nonImproving++;
  input.task.gates[0]!.command = "echo gate >> cache/runs";
  expect((await gate(input)).gates[0]!.status).toBe("pass");
  expect(JSON.stringify(receipt(input, ".r1").body)).toBe(original);
  expect(receipt(input, ".r2").body).toHaveProperty("progress");
});

test.each(["record", "blob"])("a damaged gate %s is not replayed or rerun", async kind => {
  const input = fixture(), original = await gate(input), store = new PitakoStore(input.root);
  const db = openSqliteSync(store.file);
  try {
    if (kind === "record") db.prepare("UPDATE records SET body='null' WHERE kind='gate'").run();
    else db.prepare("UPDATE blobs SET originalSize=originalSize+1 WHERE digest=?").run(original.gates[0]!.logRef);
  } finally { db.close(); }
  // The grouped execute entry uses writer preflight; blob corruption is
  // rechecked by the gate writer itself, not overwritten with new output.
  await expect(gate(input)).rejects.toMatchObject({code: "store-corrupt"});
  expect(runs(input)).toBe("metric\ngate\n");
  expect(existsSync(directory(input, ".r1"))).toBe(false);
});
