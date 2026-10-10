import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { InvocationHistory, SessionHistory } from "../extensions/agent/history.ts";
import { createLiveHandle } from "../extensions/agent/live.ts";

const roots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(brief = "original WorkBrief", steer: (text: string) => Promise<"queued" | "handled"> = async () => "queued") {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-live-"));
  roots.push(root);
  process.env.PI_CODING_AGENT_DIR = root;
  const invocation = new InvocationHistory(root, { source: "agent_spawn", workbrief: brief }, brief);
  const history = new SessionHistory(invocation, "history", { model: "fixture/model" });
  const manager = SessionManager.inMemory(root);
  history.manager = manager;
  const session = { sessionId: manager.getSessionId(), sessionManager: manager, sessionFile: undefined, steer };
  return { ...createLiveHandle(session, history), manager, identity: { historyId: "history", sessionId: session.sessionId } };
}

test("settlement synchronously rejects new input, joins admitted hooks, and persists immutable receipts", async () => {
  let finish: () => void = () => {};
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const texts: string[] = [];
  const live = setup("original", async text => { texts.push(text); await gate; return "queued"; });
  live.open();
  const admitted = live.handle.input({ ...live.identity, intent: "query", text: "/must-not-run" });
  let joined = false;
  const settlement = live.settle().then(() => { joined = true; });
  const closed = await live.handle.input({ ...live.identity, intent: "steer", text: "too late" });
  expect(closed).toMatchObject({ status: "rejected", reason: "binding is not admitting input" });
  expect(joined).toBe(false);
  expect(texts).toHaveLength(1);
  expect(texts[0]).toStartWith("Pitako interaction ");
  expect(texts[0]).toContain("intent: query\nText (not a command):\n/must-not-run");
  finish();
  const receipt = await admitted;
  await settlement;
  expect(receipt).toMatchObject({ status: "queued" });
  await live.handle.close();
  const data = live.manager.getEntries().filter(entry => entry.type === "custom")
    .map(entry => entry.data as { event: string; data: { status: string } });
  expect(data.filter(entry => entry.event === "interaction").map(entry => entry.data.status))
    .toEqual(["pending", "rejected", "queued", "unconfirmed"]);
  live.open();
  expect(await live.handle.input({ ...live.identity, intent: "query", text: "revoked" })).toMatchObject({ status: "rejected" });
});

test("revocation joins admitted input and preserves explicit hook consumption without claiming an answer", async () => {
  let finish: () => void = () => {};
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const live = setup("original", async () => { await gate; return "handled"; });
  live.open();
  const admitted = live.handle.input({ ...live.identity, intent: "query", text: "consume" });
  const closing = live.handle.close();
  expect(live.handle.close()).toBe(closing);
  expect(await live.handle.input({ ...live.identity, intent: "query", text: "closed" })).toMatchObject({ status: "rejected" });
  finish();
  expect(await admitted).toMatchObject({ status: "handled", delivery: "input hook consumed; not an answer" });
  await closing;
});

test("observation bounds serialized pages, pages original brief and reports ring and persistence gaps", async () => {
  const brief = "😀\u0000".repeat(7000);
  const live = setup(brief);
  for (let i = 0; i < 205; i++) live.event({ type: "message_end", message: { role: "user", content: `${i}:${"\u0000".repeat(1000)}`, timestamp: i } });
  type Page = { workbrief: { text: string; nextOffset: number | null }; activity: Array<{ sequence: number; source: string }>; gaps: string[]; cursor: number; more: boolean };
  const first = live.handle.observe() as Page;
  expect(first.activity.length).toBeLessThanOrEqual(50);
  expect(first.gaps.join("\n")).toContain("No first assistant");
  expect(first.gaps.join("\n")).toContain("ring dropped 5");
  let offset: number | null = 0, reconstructed = "";
  while (offset !== null) {
    const page = live.handle.observe({ briefOffset: offset }) as Page;
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32 * 1024);
    reconstructed += page.workbrief.text;
    offset = page.workbrief.nextOffset;
  }
  expect(reconstructed).toBe(brief);
  let after = 0;
  const sequences: number[] = [];
  do {
    const page = live.handle.observe({ after, limit: 200 }) as Page;
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32 * 1024);
    expect(page.activity.every(item => item.source === "event-only")).toBe(true);
    sequences.push(...page.activity.map(item => item.sequence));
    after = page.cursor;
    if (!page.more) break;
  } while (true);
  expect(sequences).toEqual(Array.from({ length: 200 }, (_, index) => index + 6));
  await live.handle.close();
});
