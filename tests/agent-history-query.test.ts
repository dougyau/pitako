import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentInstance from "../extensions/agent/index.ts";
import pitako from "../extensions/index.ts";
import { WorkerHistory } from "../extensions/agent/history.ts";
import { agentScope } from "../extensions/agent/scope.ts";
import type { HistoryPage, HistoryQuery } from "../extensions/agent/history-query.ts";
import { childActiveTools, toolsForProfile } from "../extensions/profile.ts";

const roots: string[] = [];
const original = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function adapters(coordinator = "current") {
  let tool: any;
  let command: any;
  const pi = {
    registerTool(def: any) { if (def.name === "agent_history") tool = def; },
    registerCommand(name: string, def: any) { if (name === "pitako") command = def.handler; },
    registerFlag() {}, on() {}, getFlag() {}, getAllTools() { return []; }, getActiveTools() { return []; },
  };
  agentInstance(pi as unknown as ExtensionAPI);
  pitako(pi as unknown as ExtensionAPI);
  const ctx = { cwd: "/removed/worktree", sessionManager: { getSessionId: () => coordinator },
    hasUI: true, ui: { notify() {} } };
  return {
    tool,
    async query(input: HistoryQuery): Promise<HistoryPage> {
      const result = await tool.execute("consult", input, undefined, undefined, ctx);
      expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(32768);
      expect(result.details).toHaveProperty("diagnostics");
      expect(result.details).toHaveProperty("cursor");
      return result.details;
    },
    async command(args: string): Promise<string> {
      let text = "";
      await command(args, { ...ctx, ui: { notify(message: string) { text = message; } } });
      return text;
    },
  };
}
function fixture(coordinator = "current") {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-query-"));
  roots.push(root);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const history = new WorkerHistory();
  const group = history.createGroup(root);
  const member = history.admit(group.groupId, { roleId: "developer", coordinatorSessionId: coordinator,
    assignmentId: "assignment", instanceId: "instance" });
  const file = path.join(root, "native.jsonl");
  history.mutate(group.groupId, (saved) => { saved.members[0]!.native = {
    state: "allocated", sessionId: "native-id", path: file, disposition: { state: "pending" },
  }; });
  return { root, history, group, member, file };
}
function codes(page: HistoryPage) { return page.diagnostics.map((row) => row.code); }

test("registered queries consult cold and committed WAL authority through Bun without logical mutation", () => {
  const result = spawnSync(process.execPath, ["scripts/agent-history-query-node.mjs", "--authority-only"], {
    cwd: path.resolve(import.meta.dir, ".."), encoding: "utf8", timeout: 30000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.trim()).logicalAndMainBytesUnchanged).toBe(true);
}, 40000);
async function reconstruct(api: ReturnType<typeof adapters>, historyId: string, limit = 50) {
  const chunks: Buffer[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.query({ action: "read", historyId, limit, cursor });
    for (const item of page.items as Array<{ encoding: string; data: string; byteOffset: number }>) {
      expect(item.encoding).toBe("base64");
      expect(item.byteOffset).toBe(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      chunks.push(Buffer.from(item.data, "base64"));
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return Buffer.concat(chunks);
}

test("registered tool and console share explicit/default filters and paginated member/group identity", async () => {
  const { history, group, member } = fixture("old-coordinator");
  history.mutate(group.groupId, (saved) => {
    for (let index = 0; index < 450; index++) saved.members.push({
      ...member, historyId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      coordinatorSessionId: index % 2 ? "current" : "old-coordinator",
    });
  });
  const api = adapters();
  expect((await api.query({ action: "list" })).items).toHaveLength(50);
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.query({ action: "list", scope: "all", limit: 17, cursor });
    expect(page.items.length).toBeLessThanOrEqual(17);
    all.push(...page.items);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  expect(all).toHaveLength(451);
  expect(new Set(all.map((row) => row.historyId)).size).toBe(451);
  expect(all.every((row) => row.group.groupId === group.groupId)).toBe(true);
  const selectors = [
    { coordinatorSessionId: "old-coordinator" }, { roleId: "developer" }, { instanceId: "instance" }, { assignmentId: "assignment" },
  ];
  for (const filter of selectors) {
    const [key, value] = Object.entries(filter)[0]!;
    const flag = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const viaTool = await api.query({ action: "list", ...filter, limit: 1 });
    const viaCommand = JSON.parse(await api.command(`history list --${flag} ${value} --limit 1`));
    expect(viaCommand).toEqual(viaTool);
    expect(viaTool.items).toHaveLength(1);
  }
  expect(codes(await api.query({ action: "list", limit: 201 }))).toContain("invalid_limit");
  expect(codes(await api.query({ action: "list", scope: "all", path: "/etc/passwd" } as any))).toContain("invalid_parameter");
  expect(await api.command("history prune --unknown")).toContain("usage: /pitako history prune");
  expect(await api.command("history list --path /etc/passwd")).toContain("invalid history flag");
  expect(JSON.stringify(api.tool.parameters)).not.toContain("prune");
});

test("all physical native branches, raw tool IDs/results/actions and a huge Unicode record reconstruct exactly", async () => {
  const { file, member } = fixture();
  const records = [
    { type: "session", id: "native-id", version: 3, timestamp: "now", cwd: "/gone" },
    { type: "message", id: "raw-user", parentId: null, timestamp: "time1", message: { role: "user", content: "branch A" } },
    { type: "message", id: "raw-call", parentId: "raw-user", timestamp: "time2",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-raw", name: "bash", arguments: { command: "printf result" } }] } },
    { type: "message", id: "raw-result", parentId: "raw-call", timestamp: "time3",
      message: { role: "toolResult", toolCallId: "call-raw", content: [{ type: "text", text: "result" }], isError: false } },
    { type: "branch_summary", id: "branch-action", parentId: "raw-user", timestamp: "time4", fromId: "raw-result", summary: "branch B" },
    { type: "compaction", id: "compressed", parentId: "branch-action", timestamp: "time5", summary: "context excludes A", firstKeptEntryId: "branch-action" },
    { type: "custom", id: "huge", parentId: "compressed", timestamp: "time6", customType: "fixture", data: "猫".repeat(150000) },
  ];
  const bytes = Buffer.from(records.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(file, bytes);
  const api = adapters();
  expect(await reconstruct(api, member.historyId, 2)).toEqual(bytes);
  const viaTool = await api.query({ action: "read", historyId: member.historyId, limit: 1 });
  expect(JSON.parse(await api.command(`history read ${member.historyId} --limit 1`))).toEqual(viaTool);
  expect(readFileSync(file)).toEqual(bytes);
});

test("read cursors freeze append cut and reject truncation, replacement and migration; malformed/partial files stay distinct", async () => {
  const { file, member } = fixture();
  const api = adapters();
  const native = '{"type":"session","id":"native-id","version":3}\n{"role":"user"}\n{"role":"assistant"}\n';
  writeFileSync(file, native);
  const first = await api.query({ action: "read", historyId: member.historyId, limit: 1 });
  appendFileSync(file, '{"role":"toolResult"}\n');
  const rest = await api.query({ action: "read", historyId: member.historyId, cursor: first.cursor! });
  const frozen = [...first.items, ...rest.items].map((item: any) => Buffer.from(item.data, "base64"));
  expect(Buffer.concat(frozen).toString()).toBe(native);
  expect((await reconstruct(api, member.historyId)).toString()).toContain("toolResult");
  truncateSync(file, 1);
  expect(codes(await api.query({ action: "read", historyId: member.historyId, cursor: first.cursor! }))).toEqual(["stale_cursor"]);
  writeFileSync(file, native);
  const next = await api.query({ action: "read", historyId: member.historyId, limit: 1 });
  renameSync(file, `${file}.old`);
  writeFileSync(file, native);
  expect(codes(await api.query({ action: "read", historyId: member.historyId, cursor: next.cursor! }))).toEqual(["stale_cursor"]);
  const migration = await api.query({ action: "read", historyId: member.historyId, limit: 1 });
  writeFileSync(file, native.replace('"version":3', '"version":4'));
  expect(codes(await api.query({ action: "read", historyId: member.historyId, cursor: migration.cursor! }))).toEqual(["stale_cursor"]);
  writeFileSync(file, 'not json\n{"broken":');
  const corrupt = await api.query({ action: "read", historyId: member.historyId });
  expect(codes(corrupt)).toContain("corrupt_entry");
  expect(codes(corrupt)).toContain("partial_tail");
  expect(codes(corrupt)).toContain("sidecar_missing");
  writeFileSync(file, `{"data":"${"x".repeat(20000)}"\n`);
  const fragment = await api.query({ action: "read", historyId: member.historyId, limit: 1 });
  expect(fragment.cursor).not.toBeNull();
  let cursor = fragment.cursor;
  const largeCodes: string[] = [];
  while (cursor) {
    const page = await api.query({ action: "read", historyId: member.historyId, cursor, limit: 1 });
    largeCodes.push(...codes(page)); cursor = page.cursor;
  }
  expect(largeCodes).toContain("corrupt_entry");
  writeFileSync(file, Buffer.from([123, 34, 100, 34, 58, 34, 255, 34, 125, 10]));
  expect(codes(await api.query({ action: "read", historyId: member.historyId }))).toContain("corrupt_entry");
  writeFileSync(`${file}.acp.json`, "{}");
  expect(codes(await api.query({ action: "read", historyId: member.historyId }))).toContain("sidecar_present_not_consulted");
  rmSync(`${file}.acp.json`);
  mkdirSync(`${file}.acp.json`);
  expect(codes(await api.query({ action: "read", historyId: member.historyId }))).toContain("sidecar_unreadable");
  rmSync(file);
  expect(codes(await api.query({ action: "read", historyId: member.historyId }))).toContain("native_missing");
});

test("registered read defaults to 50, caps requested items at 200 and rejects mismatched/invalid cursors", async () => {
  const { file, member } = fixture();
  writeFileSync(file, Array.from({ length: 500 }, (_, id) => JSON.stringify({ type: "custom", id })).join("\n") + "\n");
  const api = adapters();
  const first = await api.query({ action: "read", historyId: member.historyId });
  expect(first.items).toHaveLength(50);
  const maximum = await api.query({ action: "read", historyId: member.historyId, limit: 200 });
  expect(maximum.items.length).toBeGreaterThan(50);
  expect(maximum.items.length).toBeLessThanOrEqual(200);
  expect(codes(await api.query({ action: "read", historyId: member.historyId, limit: 201 }))).toEqual(["invalid_limit"]);
  expect(codes(await api.query({ action: "read", historyId: member.historyId, cursor: "not-a-cursor" }))).toHaveLength(1);
  expect(codes(await api.query({ action: "list", scope: "all", cursor: first.cursor! }))).toEqual(["invalid_cursor"]);
});

test("missing stores/capture do not create directories; direct child and console admission reject consultation", async () => {
  const { root, history, group, member } = fixture();
  const api = adapters();
  history.recordTerminal(group.groupId, member.historyId, { status: "cancelled", beforeFirstAssistant: true });
  expect(codes(await api.query({ action: "read", historyId: member.historyId }))).toContain("native_not_persisted_before_assistant");
  const uncaptured = history.admit(group.groupId, { roleId: "developer" });
  expect(codes(await api.query({ action: "read", historyId: uncaptured.historyId }))).toContain("native_not_created");
  expect(codes(await api.query({ action: "read", historyId: "../escape" }))).toContain("invalid_history_id");
  const blocked = await agentScope.run({ instanceId: "child" }, () =>
    api.tool.execute("child", { action: "list", scope: "all" }, undefined, undefined, {}));
  expect(blocked.isError).toBe(true);
  expect(await agentScope.run({ instanceId: "child" }, () => api.command("history list --scope all"))).toContain("cannot be called");
  for (const profile of ["coding", "analysis"] as const) {
    expect(toolsForProfile({ available: ["agent_history", "read"], profile, child: true })).not.toContain("agent_history");
  }
  expect(childActiveTools(["agent_history", "read"])).toEqual(["read"]);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "absent");
  expect((await api.query({ action: "list", scope: "all" })).items).toEqual([]);
  expect(existsSync(process.env.PI_CODING_AGENT_DIR)).toBe(false);
});
