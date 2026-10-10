import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WorkerHistory } from "../extensions/agent/history.ts";
import { pruneWorkerHistory } from "../extensions/agent/history-retention.ts";
import { queryHistory } from "../extensions/agent/history-query.ts";

const args = ["--import", "./scripts/sdk-node-loader.mjs", "scripts/agent-history-retention-node.mjs"];
const now = Date.now() + 181 * 86400000;
if (process.argv[2] === "writer") {
  const history = new WorkerHistory();
  const groupId = process.argv[3];
  const member = history.admit(groupId, { roleId: "developer" });
  const manager = history.createSession(groupId, member.historyId, process.argv[4]);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "live writer" }],
    api: "openai-responses", provider: "local", model: "fixture", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await history.exclusive(groupId, async () => {
    console.log(JSON.stringify({ file: manager.getSessionFile(), historyId: member.historyId }));
    await once(process.stdin, "data");
  });
  history.recordTerminal(groupId, member.historyId, { status: "cancelled", beforeFirstAssistant: false });
  history.recordDisposition(groupId, member.historyId, { state: "disposed", at: new Date().toISOString() });
  history.closeInvocation(groupId);
} else if (process.argv[2] === "crash") {
  await pruneWorkerHistory(new WorkerHistory(), 180, { now, afterUnlink() { process.exit(42); } });
  throw new Error("crash boundary not reached");
} else {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-retention-process-"));
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const history = new WorkerHistory();
  const group = history.createGroup(root);
  let writer;
  let writerClosed;
  try {
    writer = spawn("node", [...args, "writer", group.groupId, root], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    // Install once, before any await; failure cleanup must not await an event
    // that already fired, and close includes the owned stdio handles.
    writerClosed = once(writer, "close");
    let errors = ""; writer.stderr.on("data", (bytes) => { errors += bytes; });
    const [ready] = await once(writer.stdout, "data");
    const member = JSON.parse(ready.toString().trim());
    const bytes = readFileSync(member.file);
    assert.equal((await pruneWorkerHistory(history, 180, { now })).groups[0].state, "busy");
    assert.deepEqual(readFileSync(member.file), bytes, "prune cannot unlink an admitted writer");
    writer.stdin.end("release\n");
    assert.equal((await writerClosed)[0], 0, errors);
    writer = undefined;
    const sentinel = path.join(root, "contract-sentinel"); writeFileSync(sentinel, "protected evidence");
    const crash = spawnSync("node", [...args, "crash"], { env: process.env, encoding: "utf8", timeout: 10000 });
    assert.equal(crash.status, 42, crash.stderr);
    assert.equal(existsSync(member.file), false);
    assert.equal(history.read(group.groupId).cleanup.state, "deleting");
    assert.equal(history.read(group.groupId).prunedAt, undefined);
    assert.ok((await queryHistory({ action: "read", historyId: member.historyId })).diagnostics.some((row) => row.code === "history_deletion_incomplete"));
    assert.equal((await pruneWorkerHistory(history, 180, { now })).groups[0].state, "busy", "dead process does not authorize lock recovery");
    // Test-only removal proves that intent alone does not confer cleanup ownership on another process.
    rmSync(path.join(history.catalogDir, `${group.groupId}.json.lock`), { recursive: true });
    const uncertain = await pruneWorkerHistory(history, 180, { now });
    assert.equal(uncertain.groups[0].state, "failed");
    assert.match(uncertain.groups[0].reason, /cleanup ownership uncertain/);
    assert.equal(history.read(group.groupId).prunedAt, undefined);
    assert.equal(readFileSync(sentinel, "utf8"), "protected evidence");
    console.log("admitted writer protected; crash intent and uncertain lock preserved");
  } finally {
    if (writer) {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
      await writerClosed;
    }
    rmSync(root, { recursive: true, force: true });
  }
}
