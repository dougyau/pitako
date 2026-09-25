import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession, AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createReplayCapture, isSafeReplayArtifact, t6ReplaySpec } from "../extensions/agent/replay.ts";

const roots: string[] = [];
const assignmentId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), "pitako-session-replay-"));
  roots.push(cwd);
  const sessionText = "safe π\r\nline";
  const resultText = "result café\r\nexact";
  const canary = (kind: string) => `PITAKO-REPLAY-CANARY-${kind}`;
  const entries = [
    { type: "message", id: "entry-user", parentId: null, timestamp: "2026-09-24T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: sessionText }, { type: "text", text: canary("prompt") }], timestamp: 1 } },
    { type: "message", id: "entry-assistant", parentId: "entry-user", timestamp: "2026-09-24T00:00:01.000Z", message: { role: "assistant", content: [
      { type: "text", text: canary("assistant"), textSignature: canary("signature") },
      { type: "thinking", thinking: canary("thinking"), thinkingSignature: canary("thinking-signature") },
      { type: "toolCall", id: "call-1", name: "probe_tool", arguments: { query: "café\r\nquery" }, thoughtSignature: canary("thought-signature") },
    ], api: "openai-completions", provider: "synthetic", model: "fixture", responseId: canary("response-id"), authorization: canary("auth"), environment: canary("env"), deferred: { data: canary("provider-payload") }, usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 } },
    { type: "message", id: "entry-result", parentId: "entry-assistant", timestamp: "2026-09-24T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "probe_tool", content: [{ type: "text", text: resultText }, { type: "text", text: canary("result") }, { type: "image", data: canary("binary"), mimeType: "image/png" }], isError: true, details: { payload: canary("details") }, timestamp: 3 } },
    { type: "message", id: "entry-error", parentId: "entry-result", timestamp: "2026-09-24T00:00:03.000Z", message: { role: "assistant", content: [], api: "openai-completions", provider: "synthetic", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: canary("error"), timestamp: 4 } },
    { type: "custom_message", id: "entry-custom", parentId: "entry-error", timestamp: "2026-09-24T00:00:04.000Z", customType: "fixture_note", content: canary("custom"), details: { value: canary("custom-details") }, display: true },
    { type: "custom", id: "entry-custom-state", parentId: "entry-custom", timestamp: "2026-09-24T00:00:05.000Z", customType: "fixture_state", data: { value: canary("custom-state") } },
    { type: "branch_summary", id: "entry-summary", parentId: "entry-custom-state", timestamp: "2026-09-24T00:00:06.000Z", fromId: "entry-user", summary: canary("summary"), details: { value: canary("summary-details") } },
    { type: "message", id: "entry-unknown", parentId: "entry-summary", timestamp: "2026-09-24T00:00:07.000Z", message: { role: "user", content: "safe", timestamp: 5, providerPayload: canary("unknown") } },
  ] as unknown as SessionEntry[];
  const session = {
    sessionId,
    systemPrompt: `effective prompt ${canary("forced-prompt")}`,
    model: { provider: "synthetic", id: "fixture" },
    thinkingLevel: "medium",
    getActiveToolNames: () => ["probe_tool"],
    sessionManager: { getSessionId: () => sessionId, getLeafId: () => "entry-unknown", getEntries: () => entries },
  } as unknown as AgentSession;
  return { cwd, session, sessionText, resultText, canary };
}

function approvedSpec(spec: NonNullable<ReturnType<typeof t6ReplaySpec>>, session: AgentSession, approved: string[] = []) {
  const model = session.model;
  const trusted = [spec.assignmentId, "reviewer-fixture", session.sessionId, ...session.getActiveToolNames(), model?.provider, model?.id, model?.api];
  return { ...spec, approvedStrings: new Set([...approved, ...trusted.filter((value): value is string => typeof value === "string")]) };
}

function isRedacted(value: unknown, reason = "privacy"): boolean {
  return typeof value === "object" && value !== null && (value as any).type === "redacted" && (value as any).reason === reason;
}

function filesUnder(root: string): string[] {
  if (!statExists(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

function statExists(file: string): boolean {
  try { statSync(file); return true; } catch { return false; }
}

describe("private Team session capture", () => {
  test("exports allowlisted Pi history, marks unknown/sensitive fields, and keeps benign CRLF exact", async () => {
    const { cwd, session, sessionText, resultText, canary } = fixture();
    const spec = t6ReplaySpec("reviewer", "code-intelligence", "T6-replay-baseline", assignmentId)!;
    const entries = session.sessionManager.getEntries() as any[];
    entries[0].message.content.push({ type: "text", text: `${sessionText}!` });
    const capture = createReplayCapture(approvedSpec(spec, session, [sessionText, resultText, JSON.stringify({ query: "café\r\nquery" })]), "reviewer-fixture", cwd)!;
    capture.beginPrompt(session);
    capture.observe(session, { type: "turn_start" } as AgentSessionEvent);
    capture.observe(session, { type: "tool_execution_start", toolCallId: "call-1", toolName: "probe_tool", args: { hidden: canary("event-args") } } as AgentSessionEvent);
    capture.observe(session, { type: "tool_execution_end", toolCallId: "call-1", toolName: "probe_tool", result: { details: canary("event-result") } } as AgentSessionEvent);
    const output: string[] = [];
    const oldError = console.error;
    const oldLog = console.log;
    const oldWarn = console.warn;
    console.error = (...values: unknown[]) => output.push(values.join(" "));
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    console.warn = (...values: unknown[]) => output.push(values.join(" "));
    try {
      expect(await capture.export(session)).toBe(true);
    } finally {
      console.error = oldError;
      console.log = oldLog;
      console.warn = oldWarn;
    }

    const root = path.join(cwd, ".pitako", "runs", "code-intelligence", "evidence", "T6", "session-replay", assignmentId);
    const files = filesUnder(root);
    expect(files).toHaveLength(1);
    expect(path.basename(files[0]!)).toBe(`session-${sessionId}.json`);
    expect(statSync(files[0]!).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);

    const serialized = readFileSync(files[0]!, "utf8");
    const artifact = JSON.parse(serialized);
    expect(artifact.status).toBe("redacted");
    expect(isRedacted(artifact.checkpoints[0].systemPrompt)).toBe(true);
    expect(artifact.entries[0].message.content[0].text).toBe(sessionText);
    expect(isRedacted(artifact.entries[0].message.content[1].text)).toBe(true);
    expect(isRedacted(artifact.entries[0].message.content[2].text)).toBe(true);
    expect(artifact.entries[1].message.content[2].arguments).toEqual({ query: "café\r\nquery" });
    expect(artifact.entries[2].message.content[0].text).toBe(resultText);
    expect(artifact.entries[2].message.isError).toBe(true);
    expect(artifact.events.some((event: any) => event.type === "prompt_start" && event.continuation === false)).toBe(true);
    expect(artifact.redactions.some((item: any) => item.reason === "privacy" && item.location.includes("message.content"))).toBe(true);
    expect(artifact.redactions.some((item: any) => item.reason === "binary")).toBe(true);
    expect(artifact.redactions.some((item: any) => item.reason === "unknown")).toBe(true);
    for (const kind of ["prompt", "assistant", "signature", "thinking", "thinking-signature", "thought-signature", "response-id", "auth", "env", "provider-payload", "result", "binary", "details", "error", "custom", "custom-details", "custom-state", "summary", "summary-details", "unknown", "forced-prompt", "event-args", "event-result"]) {
      expect(serialized.includes(canary(kind))).toBe(false);
    }
    expect(output.some((line) => line.includes("CANARY"))).toBe(false);
    expect(files.flatMap((file) => readFileSync(file, "utf8")).join("\n")).not.toContain("CANARY");
    expect(isSafeReplayArtifact({ text: canary("negative-control") }, new Set([sessionText, resultText]))).toBe(false);
    expect(isSafeReplayArtifact({ details: { hidden: "unknown" } })).toBe(false);
    expect(isSafeReplayArtifact({ thoughtSignature: "unknown" })).toBe(false);
  });

  test("fails closed for generated text, payloads, keys, IDs and markers", async () => {
    const { cwd, session, sessionText, resultText } = fixture();
    const hex = randomBytes(32).toString("hex");
    const words = ["alder", "violet", "harbor", "kettle", "meadow", "copper", "willow", "lantern"];
    const phrase = Array.from({ length: 3 }, () => words[randomInt(words.length)]!).join(" ");
    const unsafeKey = `sk-${randomBytes(24).toString("hex")}`;
    const entries = session.sessionManager.getEntries() as any[];
    entries[0].id = hex;
    entries[0].message.content.push({ type: "text", text: hex }, { type: "text", text: phrase }, { type: "text", text: "ordinary unlabeled prose" });
    entries[1].id = `${hex.slice(1)}a`;
    entries[1].parentId = hex;
    entries[1].message.content[0].text = hex;
    const toolCall = entries[1].message.content.find((part: any) => part.type === "toolCall");
    toolCall.id = hex;
    toolCall.arguments = { [hex]: phrase, [unsafeKey]: hex };
    entries[1].message.usage[phrase] = hex;
    entries[2].message.toolCallId = hex;
    entries[2].message.content.push({ type: "text", text: phrase });
    entries[3].message.errorMessage = hex;
    entries[4].content = phrase;
    entries[6].summary = hex;
    entries.push(
      { type: "message", id: `system-${hex}`, parentId: phrase, timestamp: "2026-09-24T00:00:08.000Z", message: { role: "system", content: phrase, sections: { [unsafeKey]: hex, preamble: hex, [session.sessionId]: hex }, timestamp: 6 } },
      { type: "compaction", id: "entry-compaction", parentId: phrase, timestamp: "2026-09-24T00:00:09.000Z", summary: phrase, firstKeptEntryId: hex, tokensBefore: 1 },
      { type: "context_edit", id: "entry-edit", parentId: phrase, timestamp: "2026-09-24T00:00:10.000Z", targetId: hex, replacement: { content: [{ type: "text", text: hex }] } },
      { type: "label", id: "entry-label", parentId: phrase, timestamp: "2026-09-24T00:00:11.000Z", targetId: hex, label: phrase },
      { type: "usage", id: "entry-usage", parentId: phrase, timestamp: "2026-09-24T00:00:12.000Z", kind: "fixture", provider: "synthetic", model: "fixture", usage: { input: 1 }, note: hex },
    );
    (session as any).systemPrompt = `${phrase} ${hex}`;
    const spec = t6ReplaySpec("reviewer", "code-intelligence", "T6-replay-baseline", assignmentId)!;
    const privateSpec = approvedSpec(spec, session, [sessionText, resultText, JSON.stringify({ query: "café\r\nquery" })]);
    const capture = createReplayCapture(privateSpec, "reviewer-fixture", cwd)!;
    const suppliedApprovals = privateSpec.approvedStrings as Set<string>;
    suppliedApprovals.add(hex);
    suppliedApprovals.add(phrase);
    suppliedApprovals.add(JSON.stringify({ [unsafeKey]: phrase }));
    const logs: string[] = [];
    const oldError = console.error;
    const oldLog = console.log;
    const oldWarn = console.warn;
    console.error = (...values: unknown[]) => logs.push(values.join(" "));
    console.log = (...values: unknown[]) => logs.push(values.join(" "));
    console.warn = (...values: unknown[]) => logs.push(values.join(" "));
    try {
      capture.beginPrompt(session);
      capture.observe(session, { type: "turn_start" } as AgentSessionEvent);
      capture.observe(session, { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: phrase } as AgentSessionEvent);
      capture.observe(session, { type: "auto_retry_end", attempt: 1, success: false, finalError: hex } as AgentSessionEvent);
      capture.observe(session, { type: "tool_execution_start", toolCallId: hex, toolName: "probe_tool", args: { [unsafeKey]: hex } } as AgentSessionEvent);
      capture.observe(session, { type: "tool_execution_end", toolCallId: hex, toolName: "probe_tool", result: { error: phrase } } as AgentSessionEvent);
      expect(await capture.export(session)).toBe(true);
    } finally {
      console.error = oldError;
      console.log = oldLog;
      console.warn = oldWarn;
    }

    const directory = path.join(cwd, ".pitako", "runs", "code-intelligence", "evidence", "T6", "session-replay", assignmentId);
    const files = filesUnder(cwd);
    const serialized = files.map((file) => readFileSync(file, "utf8")).join("\n");
    const artifact = JSON.parse(serialized);
    expect(artifact.status).toBe("redacted");
    expect(artifact.entries[8].message.sections).toMatchObject({ preamble: { type: "redacted", reason: "privacy" } });
    expect(artifact.entries[8].message.sections).not.toHaveProperty(session.sessionId);
    expect(artifact.entries[0].id === artifact.entries[1].parentId).toBe(true);
    const projectedCall = artifact.entries[1].message.content.find((part: any) => part.type === "toolCall");
    const projectedResult = artifact.entries[2].message;
    expect(projectedCall.id === projectedResult.toolCallId).toBe(true);
    expect(isRedacted(projectedCall.arguments)).toBe(true);
    expect(artifact.entries[0].message.content[0].text).toBe(sessionText);
    expect(isRedacted(artifact.entries[0].message.content[3].text)).toBe(true);
    expect(isRedacted(artifact.entries[0].message.content[4].text)).toBe(true);
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
    for (const value of [hex, phrase, unsafeKey]) {
      expect(serialized.includes(value)).toBe(false);
      expect(files.some((file) => file.includes(value))).toBe(false);
      expect(logs.some((line) => line.includes(value))).toBe(false);
      expect(JSON.stringify(artifact.redactions).includes(value)).toBe(false);
    }
    const approvals = approvedSpec(spec, session, [sessionText, resultText, JSON.stringify({ query: "café\r\nquery" })]).approvedStrings;
    const unsafeTextProjection = structuredClone(artifact);
    unsafeTextProjection.entries[0].message.content[0].text = hex;
    const unsafeKeyProjection = structuredClone(artifact);
    unsafeKeyProjection.entries[1].message.content.find((part: any) => part.type === "toolCall").arguments = { [unsafeKey]: phrase };
    const unsafeSectionProjection = structuredClone(artifact);
    unsafeSectionProjection.entries[8].message.sections = { [session.sessionId]: "safe-looking" };
    expect(isSafeReplayArtifact(unsafeTextProjection, approvals)).toBe(false);
    expect(isSafeReplayArtifact(unsafeKeyProjection, approvals)).toBe(false);
    expect(isSafeReplayArtifact(unsafeSectionProjection, approvals)).toBe(false);
    expect(isSafeReplayArtifact({ [unsafeKey]: phrase }, approvals)).toBe(false);
  });

  test("oversized text is redacted and marks the bounded capture incomplete", async () => {
    const { cwd, session } = fixture();
    const longText = "x".repeat(300_000);
    const entries = session.sessionManager.getEntries() as any[];
    entries[0].message.content = longText;
    const spec = t6ReplaySpec("reviewer", "code-intelligence", "T6-replay-baseline", assignmentId)!;
    const capture = createReplayCapture(approvedSpec(spec, session), "reviewer-fixture", cwd)!;
    expect(await capture.export(session)).toBe(true);
    const directory = path.join(cwd, ".pitako", "runs", "code-intelligence", "evidence", "T6", "session-replay", assignmentId);
    const serialized = readFileSync(path.join(directory, readdirSync(directory)[0]!), "utf8");
    const artifact = JSON.parse(serialized);
    expect(artifact.status).toBe("incomplete");
    expect(artifact.entries[0].message.content).toMatchObject({ type: "redacted", reason: "limit" });
    expect(serialized.includes(longText)).toBe(false);
  });

  test("reserved selection is exact, and rejected export leaves no temp or log payload", async () => {
    expect(t6ReplaySpec("reviewer", "code-intelligence", "T6-replay-dense", assignmentId)?.unitId).toBe("T6-replay-dense");
    expect(t6ReplaySpec("developer", "code-intelligence", "T6-replay-dense", assignmentId)).toBeUndefined();
    expect(t6ReplaySpec("reviewer", " code-intelligence", "T6-replay-dense", assignmentId)).toBeUndefined();
    expect(t6ReplaySpec("reviewer", "code-intelligence", "T6-replay-dense ", assignmentId)).toBeUndefined();
    expect(t6ReplaySpec("reviewer", "code-intelligence", "T6-replay-dense", "../bad")).toBeUndefined();

    const { cwd, session } = fixture();
    const outside = path.join(cwd, "outside");
    mkdirSync(outside);
    const replayParent = path.join(cwd, ".pitako", "runs", "code-intelligence", "evidence", "T6", "session-replay");
    mkdirSync(replayParent, { recursive: true });
    symlinkSync(outside, path.join(replayParent, assignmentId), "dir");
    const capture = createReplayCapture(approvedSpec(t6ReplaySpec("reviewer", "code-intelligence", "T6-replay-baseline", assignmentId)!, session), "reviewer-fixture", cwd)!;
    capture.beginPrompt(session);
    capture.observe(session, { type: "turn_start" } as AgentSessionEvent);
    const output: string[] = [];
    const oldError = console.error;
    const oldLog = console.log;
    const oldWarn = console.warn;
    console.error = (...values: unknown[]) => output.push(values.join(" "));
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    console.warn = (...values: unknown[]) => output.push(values.join(" "));
    try {
      expect(await capture.export(session)).toBe(false);
    } finally {
      console.error = oldError;
      console.log = oldLog;
      console.warn = oldWarn;
    }
    expect(filesUnder(outside)).toEqual([]);
    expect(output.some((line) => line.includes("CANARY"))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });
});
