import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentSession, AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { currentWorkspace } from "../board/workspace.ts";
import { evidenceFile } from "../workflow.ts";

const PLAN = "code-intelligence";
const UNITS = ["T6-replay-baseline", "T6-replay-dense"] as const;
const MAX_RECORDS = 10_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 26 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ROLES = new Set(["system", "user", "assistant", "toolResult"]);
const STOP_REASONS = new Set(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const COMPACTION_REASONS = new Set(["manual", "threshold", "overflow"]);
const STRUCTURAL_TYPES = new Set([
  "redacted", "text", "toolCall", "toolResult", "message", "model_change", "thinking_level_change", "usage",
  "compaction", "branch_summary", "context_edit", "custom_message", "custom", "label", "prompt_start",
  "agent_start", "agent_end", "turn_start", "turn_end", "agent_settled", "compaction_start", "compaction_end",
  "auto_retry_start", "auto_retry_end", "message_start", "message_end", "tool_execution_start", "tool_execution_end",
]);
const REDACTION_REASONS = new Set<OmissionReason>(["privacy", "unknown", "binary", "limit"]);
const SAFE_SYSTEM_SECTIONS = new Set(["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"]);
const SAFE_OBJECT_KEYS = new Set([
  "version", "status", "identity", "planId", "unitId", "assignmentId", "instanceId", "sessionId", "leafId",
  "checkpoints", "events", "entries", "redactions", "sequence", "type", "timestamp", "continuation", "turn",
  "systemPrompt", "provider", "model", "reasoning", "activeTools", "turnIndex", "role", "toolCallId", "toolName",
  "durationMs", "willRetry", "aborted", "error", "attempt", "maxAttempts", "delayMs", "success", "id", "parentId",
  "message", "content", "sections", "toolsAdded", "toolsRemoved", "api", "usage", "stopReason", "errorMessage",
  "endTurn", "isError", "input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "totalTokens", "cost", "total",
  "name", "arguments", "text", "summary", "firstKeptEntryId", "tokensBefore", "fromHook", "fromId", "replacement",
  "targetId", "customType", "display", "label", "data", "location", "reason", "thinkingLevel", "modelId", "kind", "note",
]);
const NUMERIC_KEYS = new Set([
  "version", "sequence", "turn", "turnIndex", "timestamp", "durationMs", "attempt", "maxAttempts", "delayMs",
  "input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "total", "tokensBefore",
]);
const BOOLEAN_KEYS = new Set(["continuation", "willRetry", "aborted", "success", "endTurn", "isError", "fromHook", "display"]);
const LOCATION_SEGMENTS = new Set([
  "capture", "entries", "checkpoints", "events", "leafId", "checkpoint", "event", "message", "content", "text",
  "textSignature", "thoughtSignature", "namespace", "id", "parentId", "timestamp", "type", "toolCallId", "name",
  "arguments", "toolName", "role", "sections", "toolsAdded", "toolsRemoved", "api", "provider", "model", "responseId",
  "providerThinkingLevel", "diagnostics", "usage", "stopReason", "deferred", "errorMessage", "rawStopReason", "endTurn",
  "input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost", "total", "summary",
  "firstKeptEntryId", "tokensBefore", "fromHook", "systemMessage", "fromId", "replacement", "targetId", "customType",
  "data", "display", "label", "turnIndex", "durationMs", "willRetry", "aborted", "error", "finalError", "attempt", "maxAttempts",
  "delayMs", "success", "isError",
]);

type OmissionReason = "privacy" | "unknown" | "binary" | "limit";
type Redaction = { type: "redacted"; location: string; reason: OmissionReason };
type ReplayRecord = Record<string, unknown>;

export interface T6ReplaySpec {
  planId: typeof PLAN;
  unitId: (typeof UNITS)[number];
  assignmentId: string;
  /** Private exact fixture approvals, copied before capture begins. */
  approvedStrings?: ReadonlySet<string>;
}

interface ReplaySession extends Pick<AgentSession, "sessionId" | "sessionManager" | "systemPrompt" | "model" | "thinkingLevel" | "getActiveToolNames"> {}

export function t6ReplaySpec(roleId: string, planId: string | undefined, unitId: string | undefined, assignmentId: string): T6ReplaySpec | undefined {
  if (roleId !== "reviewer" || planId !== PLAN || !UNITS.includes(unitId as (typeof UNITS)[number]) || !UUID.test(assignmentId)) return undefined;
  return { planId: PLAN, unitId: unitId as (typeof UNITS)[number], assignmentId };
}

/** Capture only for the two reserved Reviewer plan units. No source text is retained until projected. */
export function createReplayCapture(spec: T6ReplaySpec, instanceId: string, cwd: string) {
  if (!t6ReplaySpec("reviewer", spec.planId, spec.unitId, spec.assignmentId) || !ID.test(instanceId)) return undefined;
  const approvedStrings = new Set(spec.approvedStrings ?? []);
  const entryAliases = new Map<string, string>();
  const callAliases = new Map<string, string>();
  const events: ReplayRecord[] = [];
  const checkpoints: ReplayRecord[] = [];
  const redactions: { location: string; reason: OmissionReason }[] = [];
  let promptOrdinal = 0;
  let turnOrdinal = 0;
  let recordCount = 0;
  let captureBytes = 0;
  let textBudget: { used: number; limit: number } | undefined;
  let limited = false;
  let exported = false;

  const omit = (location: string, reason: OmissionReason): Redaction => {
    const at = isSafeLocation(location) ? location : "capture";
    if (reason === "limit") limited = true;
    if (redactions.length < MAX_RECORDS) redactions.push({ location: at, reason });
    else limited = true;
    return { type: "redacted", location: at, reason };
  };
  const append = (target: ReplayRecord[], record: ReplayRecord): void => {
    if (recordCount >= MAX_RECORDS || limited) {
      limited = true;
      omit("capture", "limit");
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(record));
    if (captureBytes + bytes > MAX_CAPTURE_BYTES) {
      limited = true;
      omit("capture", "limit");
      return;
    }
    target.push(record);
    recordCount += 1;
    captureBytes += bytes;
  };
  const fieldText = (value: unknown, location: string): string | Redaction => {
    if (typeof value !== "string") return omit(location, "unknown");
    const bytes = Buffer.byteLength(value);
    if (bytes > MAX_TEXT_BYTES || (textBudget && textBudget.used + bytes > textBudget.limit)) return omit(location, "limit");
    if (CONTROL_TEXT.test(value)) return omit(location, "binary");
    if (!approvedStrings.has(value)) return omit(location, "privacy");
    if (textBudget) textBudget.used += bytes;
    return value;
  };
  const alias = (value: unknown, location: string, aliases: Map<string, string>, prefix: "entry" | "call"): string | Redaction => {
    if (typeof value !== "string") return omit(location, "unknown");
    if (Buffer.byteLength(value) > 128) return omit(location, "limit");
    let safe = aliases.get(value);
    if (!safe) {
      safe = `${prefix}-${aliases.size + 1}`;
      aliases.set(value, safe);
    }
    return safe;
  };
  const entryId = (value: unknown, location: string): string | Redaction => alias(value, location, entryAliases, "entry");
  const callId = (value: unknown, location: string): string | Redaction => alias(value, location, callAliases, "call");
  const safeEnum = (value: unknown, location: string, allowed: ReadonlySet<string> = approvedStrings): string | Redaction =>
    typeof value === "string" && allowed.has(value) ? value : omit(location, "unknown");
  const safeNumber = (value: unknown, location: string): number | Redaction => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : omit(location, "unknown");
  const unknownKeys = (value: ReplayRecord, allowed: readonly string[], location: string): void => {
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++count > 256) { omit(`${location}.*`, "limit"); break; }
      if (!allowed.includes(key)) omit(`${location}.*`, "unknown");
    }
  };

  function usage(value: unknown, location: string): ReplayRecord | Redaction {
    if (!isRecord(value)) return omit(location, "unknown");
    const out: ReplayRecord = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"] as const) {
      if (key in value) out[key] = safeNumber(value[key], `${location}.${key}`);
    }
    if ("cost" in value) {
      if (!isRecord(value.cost)) out.cost = omit(`${location}.cost`, "unknown");
      else {
        const cost: ReplayRecord = {};
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
          if (key in value.cost) cost[key] = safeNumber(value.cost[key], `${location}.cost.${key}`);
        }
        unknownKeys(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"], `${location}.cost`);
        out.cost = cost;
      }
    }
    unknownKeys(value, ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost"], location);
    return out;
  }

  function args(value: unknown, location: string): unknown {
    let nodes = 0;
    let estimatedBytes = 0;
    const addBytes = (bytes: number): boolean => (estimatedBytes += bytes) <= MAX_TEXT_BYTES;
    const bounded = (item: unknown, depth: number): OmissionReason | undefined => {
      if (depth > 16 || ++nodes > 10_000) return "limit";
      if (typeof item === "string") {
        if (CONTROL_TEXT.test(item)) return "binary";
        const bytes = Buffer.byteLength(item);
        return bytes > MAX_TEXT_BYTES || !addBytes(bytes * 2 + 2) ? "limit" : undefined;
      }
      if (item === null || typeof item === "boolean") return addBytes(8) ? undefined : "limit";
      if (typeof item === "number") {
        if (!Number.isFinite(item)) return "unknown";
        return addBytes(32) ? undefined : "limit";
      }
      if (Array.isArray(item)) {
        if (item.length > 1024 || !addBytes(item.length + 2)) return "limit";
        for (const child of item) {
          const reason = bounded(child, depth + 1);
          if (reason) return reason;
        }
        return undefined;
      }
      if (!isRecord(item)) return "unknown";
      if (!addBytes(2)) return "limit";
      let count = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (++count > 1024) return "limit";
        if (CONTROL_TEXT.test(key)) return "binary";
        if (!addBytes(Buffer.byteLength(key) * 2 + 4)) return "limit";
        const reason = bounded(item[key], depth + 1);
        if (reason) return reason;
      }
      return undefined;
    };
    const reason = bounded(value, 0);
    if (reason) return omit(location, reason);
    let serialized: string | undefined;
    try { serialized = JSON.stringify(value); } catch { return omit(location, "unknown"); }
    if (serialized === undefined) return omit(location, "unknown");
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_TEXT_BYTES || (textBudget && textBudget.used + bytes > textBudget.limit)) return omit(location, "limit");
    if (!approvedStrings.has(serialized)) return omit(location, "privacy");
    if (textBudget) textBudget.used += bytes;
    try { return JSON.parse(serialized); } catch { return omit(location, "unknown"); }
  }

  function content(value: unknown, location: string, role: string): unknown {
    if (typeof value === "string") return fieldText(value, location);
    if (!Array.isArray(value)) return omit(location, "unknown");
    if (value.length > 1024) return omit(location, "limit");
    return value.map((part, index) => {
      const at = `${location}[${index}]`;
      if (!isRecord(part) || typeof part.type !== "string") return omit(at, "unknown");
      if (part.type === "text") {
        unknownKeys(part, ["type", "text", "textSignature"], at);
        if ("textSignature" in part) omit(`${at}.textSignature`, "unknown");
        return { type: "text", text: fieldText(part.text, `${at}.text`) };
      }
      if (part.type === "toolCall" && role === "assistant") {
        unknownKeys(part, ["type", "id", "name", "arguments", "thoughtSignature", "namespace"], at);
        if ("thoughtSignature" in part) omit(`${at}.thoughtSignature`, "unknown");
        if ("namespace" in part) omit(`${at}.namespace`, "unknown");
        return {
          type: "toolCall",
          id: callId(part.id, `${at}.id`),
          name: safeEnum(part.name, `${at}.name`),
          arguments: args(part.arguments, `${at}.arguments`),
        };
      }
      if (part.type === "thinking") {
        omit(at, "privacy");
        return { type: "redacted", location: at, reason: "privacy" };
      }
      if (part.type === "image") {
        omit(at, "binary");
        return { type: "redacted", location: at, reason: "binary" };
      }
      return omit(at, "unknown");
    });
  }

  function message(value: unknown, location: string): ReplayRecord | Redaction {
    if (!isRecord(value) || typeof value.role !== "string") return omit(location, "unknown");
    const role = value.role;
    const at = `${location}.message`;
    if (role === "user") {
      unknownKeys(value, ["role", "content", "timestamp"], at);
      return { role, content: content(value.content, `${at}.content`, role), timestamp: finiteTimestamp(value.timestamp, `${at}.timestamp`, omit) };
    }
    if (role === "system") {
      unknownKeys(value, ["role", "content", "sections", "toolsAdded", "toolsRemoved", "timestamp"], at);
      const sections: ReplayRecord = {};
      if (isRecord(value.sections)) {
        let count = 0;
        for (const key in value.sections) {
          if (!Object.hasOwn(value.sections, key)) continue;
          if (++count > 1024) { omit(`${at}.sections`, "limit"); break; }
          const section = value.sections[key];
          if (SAFE_SYSTEM_SECTIONS.has(key)) sections[key] = section === null ? null : fieldText(section, `${at}.sections.*`);
          else omit(`${at}.sections.*`, "privacy");
        }
      } else if (value.sections !== undefined) omit(`${at}.sections`, "unknown");
      const tools = (items: unknown, field: string): unknown => {
        if (!Array.isArray(items)) return items === undefined ? undefined : omit(`${at}.${field}`, "unknown");
        if (items.length > 1024) return omit(`${at}.${field}`, "limit");
        return items.map((item, index) => {
          if (!isRecord(item)) return omit(`${at}.${field}[${index}]`, "unknown");
          const name = safeEnum(item.name, `${at}.${field}[${index}].name`);
          omit(`${at}.${field}[${index}].*`, "unknown");
          return name;
        });
      };
      return {
        role,
        content: content(value.content, `${at}.content`, role),
        ...(Object.keys(sections).length ? { sections } : {}),
        ...(value.toolsAdded !== undefined ? { toolsAdded: tools(value.toolsAdded, "toolsAdded") } : {}),
        ...(value.toolsRemoved !== undefined ? { toolsRemoved: tools(value.toolsRemoved, "toolsRemoved") } : {}),
        timestamp: finiteTimestamp(value.timestamp, `${at}.timestamp`, omit),
      };
    }
    if (role === "assistant") {
      unknownKeys(value, ["role", "content", "api", "provider", "model", "responseModel", "responseId", "providerThinkingLevel", "diagnostics", "usage", "stopReason", "deferred", "errorMessage", "rawStopReason", "endTurn", "timestamp"], at);
      for (const key of ["responseId", "providerThinkingLevel", "diagnostics", "deferred", "rawStopReason"] as const) if (key in value) omit(`${at}.${key}`, "unknown");
      return {
        role,
        content: content(value.content, `${at}.content`, role),
        api: safeEnum(value.api, `${at}.api`),
        provider: safeEnum(value.provider, `${at}.provider`),
        model: safeEnum(value.model, `${at}.model`),
        usage: usage(value.usage, `${at}.usage`),
        stopReason: safeEnum(value.stopReason, `${at}.stopReason`, STOP_REASONS),
        ...(value.errorMessage !== undefined ? { errorMessage: fieldText(value.errorMessage, `${at}.errorMessage`) } : {}),
        ...(typeof value.endTurn === "boolean" ? { endTurn: value.endTurn } : {}),
        timestamp: finiteTimestamp(value.timestamp, `${at}.timestamp`, omit),
      };
    }
    if (role === "toolResult") {
      unknownKeys(value, ["role", "toolCallId", "toolName", "content", "details", "usage", "isError", "timestamp"], at);
      if ("details" in value) omit(`${at}.details`, "unknown");
      return {
        role,
        toolCallId: callId(value.toolCallId, `${at}.toolCallId`),
        toolName: safeEnum(value.toolName, `${at}.toolName`),
        content: content(value.content, `${at}.content`, role),
        ...(value.usage !== undefined ? { usage: usage(value.usage, `${at}.usage`) } : {}),
        isError: typeof value.isError === "boolean" ? value.isError : omit(`${at}.isError`, "unknown"),
        timestamp: finiteTimestamp(value.timestamp, `${at}.timestamp`, omit),
      };
    }
    return omit(location, "unknown");
  }

  function entry(value: SessionEntry, index: number): ReplayRecord {
    const at = `entries[${index}]`;
    const row = value as unknown as ReplayRecord;
    const base = {
      id: entryId(row.id, `${at}.id`),
      parentId: row.parentId === null ? null : entryId(row.parentId, `${at}.parentId`),
      timestamp: typeof row.timestamp === "string" && isCanonicalTimestamp(row.timestamp) ? row.timestamp : omit(`${at}.timestamp`, "unknown"),
    };
    switch (row.type) {
      case "message":
        unknownKeys(row, ["type", "id", "parentId", "timestamp", "message"], at);
        return { ...base, type: "message", message: message(row.message, at) };
      case "model_change":
        unknownKeys(row, ["type", "id", "parentId", "timestamp", "provider", "modelId"], at);
        return { ...base, type: row.type, provider: safeEnum(row.provider, `${at}.provider`), modelId: safeEnum(row.modelId, `${at}.modelId`) };
      case "thinking_level_change":
        unknownKeys(row, ["type", "id", "parentId", "timestamp", "thinkingLevel"], at);
        return { ...base, type: row.type, thinkingLevel: safeEnum(row.thinkingLevel, `${at}.thinkingLevel`, THINKING_LEVELS) };
      case "usage":
        unknownKeys(row, ["type", "id", "parentId", "timestamp", "kind", "provider", "model", "usage", "note"], at);
        return {
          ...base, type: row.type,
          kind: safeEnum(row.kind, `${at}.kind`),
          provider: safeEnum(row.provider, `${at}.provider`),
          model: safeEnum(row.model, `${at}.model`),
          usage: usage(row.usage, `${at}.usage`),
          ...(row.note !== undefined ? { note: fieldText(row.note, `${at}.note`) } : {}),
        };
      case "compaction":
        unknownKeys(row, ["type", "id", "parentId", "timestamp", "summary", "firstKeptEntryId", "tokensBefore", "usage", "fromHook", "systemMessage", "details"], at);
        if ("details" in row) omit(`${at}.details`, "unknown");
        if ("systemMessage" in row) omit(`${at}.systemMessage`, "unknown");
        return {
          ...base, type: row.type,
          summary: fieldText(row.summary, `${at}.summary`),
          firstKeptEntryId: entryId(row.firstKeptEntryId, `${at}.firstKeptEntryId`),
          tokensBefore: safeNumber(row.tokensBefore, `${at}.tokensBefore`),
          ...(row.usage !== undefined ? { usage: usage(row.usage, `${at}.usage`) } : {}),
          ...(typeof row.fromHook === "boolean" ? { fromHook: row.fromHook } : {}),
        };
      case "branch_summary":
        unknownKeys(row, ["type", "id", "parentId", "timestamp", "fromId", "summary", "details", "usage", "fromHook"], at);
        if ("details" in row) omit(`${at}.details`, "unknown");
        return {
          ...base, type: row.type, fromId: entryId(row.fromId, `${at}.fromId`),
          summary: fieldText(row.summary, `${at}.summary`),
          ...(row.usage !== undefined ? { usage: usage(row.usage, `${at}.usage`) } : {}),
          ...(typeof row.fromHook === "boolean" ? { fromHook: row.fromHook } : {}),
        };
      case "context_edit":
        unknownKeys(row, ["type", "id", "parentId", "timestamp", "targetId", "replacement"], at);
        if (row.replacement === null) return { ...base, type: row.type, targetId: entryId(row.targetId, `${at}.targetId`), replacement: null };
        if (!isRecord(row.replacement)) return { ...base, type: row.type, targetId: entryId(row.targetId, `${at}.targetId`), replacement: omit(`${at}.replacement`, "unknown") };
        unknownKeys(row.replacement, ["content"], `${at}.replacement`);
        return { ...base, type: row.type, targetId: entryId(row.targetId, `${at}.targetId`), replacement: { content: content(row.replacement.content, `${at}.replacement.content`, "context") } };
      case "custom_message":
        unknownKeys(row, ["type", "id", "parentId", "timestamp", "customType", "content", "details", "display"], at);
        if ("details" in row) omit(`${at}.details`, "unknown");
        return {
          ...base, type: row.type,
          customType: safeEnum(row.customType, `${at}.customType`),
          content: content(row.content, `${at}.content`, "custom"),
          display: typeof row.display === "boolean" ? row.display : omit(`${at}.display`, "unknown"),
        };
      case "custom":
        unknownKeys(row, ["type", "id", "parentId", "timestamp", "customType", "data"], at);
        if ("data" in row) omit(`${at}.data`, "unknown");
        return { ...base, type: row.type, customType: safeEnum(row.customType, `${at}.customType`), ...(row.data !== undefined ? { data: omit(`${at}.data`, "unknown") } : {}) };
      case "label":
        unknownKeys(row, ["type", "id", "parentId", "timestamp", "targetId", "label"], at);
        return { ...base, type: row.type, targetId: entryId(row.targetId, `${at}.targetId`), label: row.label === undefined ? omit(`${at}.label`, "unknown") : fieldText(row.label, `${at}.label`) };
      default:
        omit(at, "unknown");
        return { ...base, type: "redacted", content: omit(`${at}.content`, "unknown") };
    }
  }

  return {
    beginPrompt(session: ReplaySession): void {
      promptOrdinal += 1;
      const leafId = session.sessionManager.getLeafId();
      append(events, { sequence: recordCount, type: "prompt_start", timestamp: Date.now(), continuation: promptOrdinal > 1, leafId: leafId === null ? null : entryId(leafId, "events.leafId") });
    },
    observe(session: ReplaySession, event: AgentSessionEvent, startedAt?: number): void {
      const type = event.type;
      const timestamp = Date.now();
      if (type === "turn_start") {
        const model = session.model;
        const turn = ++turnOrdinal;
        const leafId = session.sessionManager.getLeafId();
        append(checkpoints, {
          sequence: recordCount,
          timestamp,
          turn,
          leafId: leafId === null ? null : entryId(leafId, `checkpoints[${checkpoints.length}].leafId`),
          systemPrompt: fieldText(session.systemPrompt, `checkpoints[${checkpoints.length}].systemPrompt`),
          provider: model ? safeEnum(model.provider, "checkpoint.provider") : null,
          model: model ? safeEnum(model.id, "checkpoint.model") : null,
          reasoning: safeEnum(session.thinkingLevel, "checkpoint.reasoning", THINKING_LEVELS),
          activeTools: session.getActiveToolNames().length > 1024 ? omit("checkpoint.activeTools", "limit") : session.getActiveToolNames().map((name, index) => safeEnum(name, `checkpoint.activeTools[${index}]`)),
        });
        append(events, { sequence: recordCount, type, timestamp, turnIndex: "turnIndex" in event ? safeNumber(event.turnIndex, "event.turnIndex") : turn });
        return;
      }
      if (type === "agent_start" || type === "agent_end" || type === "turn_end" || type === "agent_settled" || type === "compaction_start" || type === "compaction_end" || type === "auto_retry_start" || type === "auto_retry_end" || type === "message_start" || type === "message_end" || type === "tool_execution_start" || type === "tool_execution_end") {
        const mark: ReplayRecord = { sequence: recordCount, type, timestamp };
        if (type === "turn_end" && "message" in event) mark.role = safeEnum(event.message.role, "event.role", ROLES);
        if ((type === "message_start" || type === "message_end") && "message" in event) {
          mark.role = safeEnum(event.message.role, "event.role", ROLES);
          if (event.message.role === "assistant") {
            const leafId = session.sessionManager.getLeafId();
            mark.leafId = leafId === null ? null : entryId(leafId, "event.leafId");
          }
        }
        if ((type === "tool_execution_start" || type === "tool_execution_end") && "toolName" in event) {
          mark.toolCallId = callId(event.toolCallId, "event.toolCallId");
          mark.toolName = safeEnum(event.toolName, "event.toolName");
          if (type === "tool_execution_end" && startedAt !== undefined) mark.durationMs = Math.max(0, Math.round(performance.now() - startedAt));
        }
        if (type === "agent_end" && "willRetry" in event) mark.willRetry = event.willRetry;
        if (type === "compaction_start" && "reason" in event) mark.reason = safeEnum(event.reason, "event.reason", COMPACTION_REASONS);
        if (type === "compaction_end" && "aborted" in event) {
          mark.aborted = event.aborted;
          mark.willRetry = event.willRetry;
          if (event.errorMessage !== undefined) mark.error = fieldText(event.errorMessage, "event.errorMessage");
        }
        if (type === "auto_retry_start" && "attempt" in event) {
          mark.attempt = safeNumber(event.attempt, "event.attempt");
          mark.maxAttempts = safeNumber(event.maxAttempts, "event.maxAttempts");
          mark.delayMs = safeNumber(event.delayMs, "event.delayMs");
          mark.error = fieldText(event.errorMessage, "event.errorMessage");
        }
        if (type === "auto_retry_end" && "success" in event) {
          mark.success = event.success;
          mark.attempt = safeNumber(event.attempt, "event.attempt");
          if (event.finalError !== undefined) mark.error = fieldText(event.finalError, "event.finalError");
        }
        append(events, mark);
      }
    },
    async export(session: ReplaySession): Promise<boolean> {
      if (exported) return false;
      exported = true;
      try {
        const sessionId = session.sessionId;
        if (!UUID.test(sessionId) || session.sessionManager.getSessionId() !== sessionId) return false;
        const entries: ReplayRecord[] = [];
        let entryBytes = 0;
        const source = session.sessionManager.getEntries();
        for (let index = 0; index < source.length; index += 1) {
          if (recordCount + entries.length >= MAX_RECORDS || limited) {
            limited = true;
            omit("entries", "limit");
            break;
          }
          textBudget = { used: 0, limit: Math.max(0, MAX_ENTRY_BYTES - entryBytes - 2 * 1024 * 1024) };
          const projected = entry(source[index]!, index);
          textBudget = undefined;
          const bytes = Buffer.byteLength(JSON.stringify(projected));
          if (entryBytes + bytes > MAX_ENTRY_BYTES) {
            limited = true;
            omit("entries", "limit");
            break;
          }
          entries.push(projected);
          entryBytes += bytes;
        }
        const leafId = session.sessionManager.getLeafId();
        const document = {
          version: 1,
          status: limited ? "incomplete" : redactions.length ? "redacted" : "complete",
          identity: { planId: PLAN, unitId: spec.unitId, assignmentId: spec.assignmentId, instanceId, sessionId },
          leafId: leafId === null ? null : entryId(leafId, "leafId"),
          checkpoints,
          events,
          entries,
          redactions,
        };
        if (!isSafeReplayArtifact(document, approvedStrings)) return false;
        const data = JSON.stringify(document, null, 2) + "\n";
        if (Buffer.byteLength(data) > MAX_BYTES) return false;
        return writeArtifact(spec.assignmentId, sessionId, cwd, data);
      } catch {
        return false;
      }
    },
  };
}

/** Final in-memory negative control; no rejected payload is returned or logged. */
export function isSafeReplayArtifact(value: unknown, approvedStrings: ReadonlySet<string> = new Set()): boolean {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.identity)
    || !Array.isArray(value.checkpoints) || !Array.isArray(value.events) || !Array.isArray(value.entries) || !Array.isArray(value.redactions)) return false;
  if (value.status === "complete" && value.redactions.length > 0) return false;
  const seen = new Set<object>();
  const visit = (item: unknown, key?: string, parentKey?: string): boolean => {
    if (key === "arguments") {
      if (isRecord(item) && item.type === "redacted") return visit(item);
      try { return approvedStrings.has(JSON.stringify(item) ?? ""); } catch { return false; }
    }
    if (typeof item === "string") {
      if (CONTROL_TEXT.test(item)) return false;
      if (approvedStrings.has(item)) return true;
      switch (key) {
        case "status": return item === "complete" || item === "redacted" || item === "incomplete";
        case "planId": return item === PLAN;
        case "unitId": return UNITS.includes(item as (typeof UNITS)[number]);
        case "role": return ROLES.has(item);
        case "type": return STRUCTURAL_TYPES.has(item);
        case "reason": return REDACTION_REASONS.has(item as OmissionReason) || COMPACTION_REASONS.has(item);
        case "stopReason": return STOP_REASONS.has(item);
        case "thinkingLevel":
        case "reasoning": return THINKING_LEVELS.has(item);
        case "timestamp": return isCanonicalTimestamp(item);
        case "location": return isSafeLocation(item);
        case "id": return /^(?:entry|call)-[1-9][0-9]*$/.test(item);
        case "parentId":
        case "fromId":
        case "targetId":
        case "firstKeptEntryId":
        case "leafId": return /^entry-[1-9][0-9]*$/.test(item);
        case "toolCallId": return /^call-[1-9][0-9]*$/.test(item);
        default: return false;
      }
    }
    if (item === null) return key === "leafId" || key === "parentId" || key === "replacement" || parentKey === "sections";
    if (typeof item === "number") return Number.isFinite(item) && item >= 0 && key !== undefined && NUMERIC_KEYS.has(key);
    if (typeof item === "boolean") return key !== undefined && BOOLEAN_KEYS.has(key);
    if (Array.isArray(item)) {
      if (seen.has(item)) return false;
      seen.add(item);
      const safe = item.every((child) => visit(child, key, parentKey));
      seen.delete(item);
      return safe;
    }
    if (!isRecord(item) || seen.has(item)) return false;
    seen.add(item);
    for (const [childKey, child] of Object.entries(item)) {
      if (CONTROL_TEXT.test(childKey) || (!SAFE_OBJECT_KEYS.has(childKey) && !(key === "sections" && SAFE_SYSTEM_SECTIONS.has(childKey)))) return false;
      if (!visit(child, childKey, key)) return false;
    }
    seen.delete(item);
    return true;
  };
  return visit(value);
}

function writeArtifact(assignmentId: string, sessionId: string, cwd: string, data: string): boolean {
  if (!UUID.test(assignmentId) || !UUID.test(sessionId)) return false;
  const workspace = currentWorkspace(cwd);
  const file = evidenceFile(PLAN, `T6/session-replay/${assignmentId}/session-${sessionId}.json`, cwd);
  const directory = path.dirname(file);
  const relative = path.relative(workspace, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  secureReplayDirectory(workspace, relative);

  const temp = path.join(directory, `.session-${sessionId}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let published = false;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temp, file);
    published = true;
    unlinkSync(temp);
    const dirFd = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return true;
  } catch {
    if (published) {
      try { unlinkSync(file); } catch { /* preserve the original export failure */ }
    }
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* absent after successful publication */ }
  }
}

function secureReplayDirectory(workspace: string, relative: string): void {
  let current = workspace;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe replay path");
    if (part === "session-replay" || UUID.test(part)) chmodSync(current, 0o700);
  }
}

function finiteTimestamp(value: unknown, location: string, omit: (location: string, reason: OmissionReason) => Redaction): number | Redaction {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : omit(location, "unknown");
}

function isRecord(value: unknown): value is ReplayRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeLocation(location: string): boolean {
  return location.split(".").every((segment) => {
    if (segment === "*") return true;
    const match = /^([A-Za-z][A-Za-z0-9]*)(?:\[(?:0|[1-9][0-9]*)\])?$/.exec(segment);
    return match !== null && LOCATION_SEGMENTS.has(match[1]!);
  });
}

function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
