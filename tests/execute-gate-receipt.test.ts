import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { gate, type GateInput } from "../skills/execute/loop.ts";
import { openBoard } from "../extensions/board/store.ts";
import { repositoryIdentity } from "../extensions/board/workspace.ts";

const { canonicalDigest } = createRequire(import.meta.url)("../extensions/canonical.mjs") as { canonicalDigest(value: unknown): string };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): GateInput {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-gate-receipt-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe",
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  writeFileSync(path.join(root, "product"), "original");
  writeFileSync(path.join(root, ".gitignore"), "cache/\n");
  mkdirSync(path.join(root, "cache"));
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial");
  return { root, specId: "example", invocation: "exec1", loop: 1, attempt: 1, key: "worker.gate",
    writerSettled: true, workerStatus: "complete", dbPath: path.join(root, ".pi/board.db"),
    task: { id: "one", gates: [{ id: "focused", command: "echo gate >> cache/runs; printf passed", cwd: ".", timeoutMs: 1000 }],
      metric: { command: "echo metric >> cache/runs; printf 3", unit: "count", target: 0 },
      progress: { nonImproving: 0, last5: [] } } };
}
const directory = (input: GateInput, suffix = "") => path.join(input.root, ".pi/subagents/execute", input.invocation, `gates/worker.gate${suffix}`);
const receiptFile = (input: GateInput, suffix = "") => path.join(directory(input, suffix), "receipt.json");
const runs = (input: GateInput) => readFileSync(path.join(input.root, "cache/runs"), "utf8");

test.each(["same-key", "transport-retry"])("identical %s replay spawns neither metric nor gates and preserves receipt bytes", async mode => {
  const input = fixture(), first = await gate(input), original = readFileSync(receiptFile(input), "utf8");
  const saved = JSON.parse(original), { receiptDigest, ...body } = saved;
  expect(receiptDigest).toBe(canonicalDigest(body));
  expect(saved.identity).toMatchObject({ attemptKey: "worker", workerStatus: "complete", after: first.after });
  expect(saved.identity.commandsDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(saved.identity.progressInputDigest).toMatch(/^[a-f0-9]{64}$/);
  const replay = await gate({ ...input, key: mode === "transport-retry" ? "worker.gate.r1" : input.key });
  expect(replay).toEqual(first);
  expect(runs(input)).toBe("metric\ngate\n");
  expect(readFileSync(receiptFile(input), "utf8")).toBe(original);
  expect(readdirSync(directory(input)).sort()).toEqual(["0.log", "metric.log", "receipt.json"]);
});

test.each(["id", "command", "cwd", "timeoutMs", "metric-command", "metric-timeout", "worker-status", "progress", "target",
  "candidate-fingerprint", "candidate-head", "corrupt", "malformed", "whitespace",
  "identity-attemptKey", "identity-after"] as const)("changed %s runs fresh into .rN without overwriting", async mode => {
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
  if (mode === "candidate-head") execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--allow-empty", "-qm", "New head"], { cwd: input.root, stdio: "pipe",
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  if (mode === "malformed") writeFileSync(receiptFile(input), "{");
  if (mode === "whitespace") writeFileSync(receiptFile(input), readFileSync(receiptFile(input), "utf8") + " ");
  if (mode === "corrupt" || mode.startsWith("identity-")) {
    const saved = JSON.parse(readFileSync(receiptFile(input), "utf8"));
    if (mode === "corrupt") saved.gates[0].tail = "damaged";
    else {
      if (mode === "identity-attemptKey") saved.identity.attemptKey = "another-worker";
      else saved.identity.after.head = "0".repeat(40);
      const { receiptDigest: _, ...body } = saved;
      saved.receiptDigest = canonicalDigest(body);
    }
    writeFileSync(receiptFile(input), JSON.stringify(saved) + "\n");
  }
  const original = readFileSync(receiptFile(input), "utf8");
  const fresh = await gate(input);
  expect(runs(input)).toBe(mode === "worker-status" ? "metric\ngate\nmetric\n" : "metric\ngate\nmetric\ngate\n");
  expect(readFileSync(receiptFile(input), "utf8")).toBe(original);
  expect(JSON.parse(readFileSync(receiptFile(input, ".r1"), "utf8")).after).toMatchObject(fresh.after);
  if (fresh.gates.length) expect(fresh.gates[0]!.logRef).not.toBe(first.gates[0]!.logRef);
  await gate(input);
  expect(runs(input)).toBe(mode === "worker-status" ? "metric\ngate\nmetric\n" : "metric\ngate\nmetric\ngate\n");
});

test("replay refreshes the Board view and bounds diagnostic tails without changing saved evidence", async () => {
  const input = fixture();
  input.task.gates[0]!.command += "; head -c 12000 /dev/zero | tr '\\0' x";
  const first = await gate(input), original = readFileSync(receiptFile(input), "utf8");
  expect(readFileSync(first.gates[0]!.logRef, "utf8").length).toBeGreaterThan(12000);
  const board = await openBoard(input.dbPath);
  try {
    board.post(repositoryIdentity(input.root), { topicId: first.view.topicId, type: "DECISION", content: "Current rule" });
  } finally { board.close(); }
  const replay = await gate(input);
  expect(replay.view.posts.some(post => post.content === "Current rule")).toBe(true);
  expect(Buffer.byteLength(replay.gates[0]!.tail)).toBeLessThanOrEqual(2048);
  expect(Buffer.byteLength(JSON.stringify(replay) + "\n")).toBeLessThanOrEqual(8192);
  expect(runs(input)).toBe("metric\ngate\n");
  expect(readFileSync(receiptFile(input), "utf8")).toBe(original);
});

test("interrupted directory is retained; receipt appears only after commands settle", async () => {
  const input = fixture();
  mkdirSync(directory(input), { recursive: true });
  writeFileSync(path.join(directory(input), "metric.log"), "interrupted");
  input.task.metric = null;
  input.task.gates[0]!.command = `test ! -e '${receiptFile(input, ".r1")}'; result=$?; echo gate >> cache/runs; exit $result`;
  const receipt = await gate(input);
  expect(receipt.gates[0]!.status).toBe("pass");
  expect(readFileSync(path.join(directory(input), "metric.log"), "utf8")).toBe("interrupted");
  expect(readdirSync(directory(input))).toEqual(["metric.log"]);
  expect(readdirSync(directory(input, ".r1")).sort()).toEqual(["0.log", "receipt.json"]);
  const original = readFileSync(receiptFile(input, ".r1"), "utf8");
  input.task.progress.nonImproving++;
  input.task.gates[0]!.command = "echo gate >> cache/runs";
  expect((await gate(input)).gates[0]!.status).toBe("pass");
  expect(readFileSync(receiptFile(input, ".r1"), "utf8")).toBe(original);
  expect(JSON.parse(readFileSync(receiptFile(input, ".r2"), "utf8")).progress).toBeDefined();
});
