import { PitakoConfigError } from "../errors.ts";

/**
 * The ~20 minute stops were the calling harness timeout around `pi --mode json`
 * (1200s), not an AgentInstance deadline. Pi's HTTP idle timeout defaults to 5
 * minutes and is a separate transport layer.
 */
export const WALL_CLOCK_TIMEOUT_SOURCE = {
  owner: "external-harness",
  detail: "Pitako AgentInstance has no fixed run deadline. Observed 20-minute stops came from the parent tool timeout, not from this package.",
} as const;

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_TOOL_STALL_TIMEOUT_MS = 45 * 60 * 1000;
export const WATCHDOG_INTERVAL_MS = 15_000;
export const STALL_CONFIRM_MS = 15_000;

export interface WatchdogConfig {
  idleTimeoutMs: number;
  toolStallTimeoutMs: number;
  /** 0 means unlimited. */
  maxRunTimeMs: number;
}

export const DEFAULT_WATCHDOG: WatchdogConfig = {
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  toolStallTimeoutMs: DEFAULT_TOOL_STALL_TIMEOUT_MS,
  maxRunTimeMs: 0,
};

export type WatchdogPhase = "working" | "idle" | "suspected_stall" | "stalled";

export interface AgentActivityState {
  startedAt: number;
  lastActivityAt: number;
  lastActivityKind: string;
  activeTool?: { name: string; startedAt: number };
  /** In-flight tools, oldest first. `activeTool` is the oldest. */
  runningTools: { id: string; name: string; startedAt: number }[];
  suspectedStallAt?: number;
  phase: WatchdogPhase;
}

export interface StallInfo {
  kind: "stalled" | "max_runtime";
  inactivityMs: number;
  lastActivityKind: string;
  activeTool?: string;
  elapsedMs: number;
}

export function parseDurationMs(value: string, field: string): number {
  const trimmed = value.trim();
  if (trimmed === "0") return 0;
  const match = /^(\d+)(ms|s|m|h)$/.exec(trimmed);
  if (!match) {
    throw new PitakoConfigError(`${field}: invalid duration "${value}". Expected 10m, 45m, 2h, or 0.`);
  }
  const amount = Number(match[1]);
  const scale = match[2] === "ms" ? 1 : match[2] === "s" ? 1000 : match[2] === "m" ? 60_000 : 3_600_000;
  return amount * scale;
}

export function mergeWatchdog(base: WatchdogConfig, value: unknown, file: string): WatchdogConfig {
  if (value === undefined) return base;
  const parsed = parseWatchdogConfig(value, file);
  const table = value as Record<string, unknown>;
  return {
    idleTimeoutMs: table.idle_timeout === undefined ? base.idleTimeoutMs : parsed.idleTimeoutMs,
    toolStallTimeoutMs: table.tool_stall_timeout === undefined ? base.toolStallTimeoutMs : parsed.toolStallTimeoutMs,
    maxRunTimeMs: table.max_run_time === undefined ? base.maxRunTimeMs : parsed.maxRunTimeMs,
  };
}

export function parseWatchdogConfig(value: unknown, file: string): WatchdogConfig {
  if (value === undefined) return { ...DEFAULT_WATCHDOG };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PitakoConfigError(`${file}: agent_runtime: expected a table`);
  }
  const table = value as Record<string, unknown>;
  const allowed = new Set(["idle_timeout", "tool_stall_timeout", "max_run_time"]);
  for (const key of Object.keys(table)) {
    if (!allowed.has(key)) throw new PitakoConfigError(`${file}: unknown key agent_runtime.${key}`);
  }
  return {
    idleTimeoutMs: table.idle_timeout === undefined ? DEFAULT_IDLE_TIMEOUT_MS : parseDurationMs(String(table.idle_timeout), `${file}: agent_runtime.idle_timeout`),
    toolStallTimeoutMs: table.tool_stall_timeout === undefined
      ? DEFAULT_TOOL_STALL_TIMEOUT_MS
      : parseDurationMs(String(table.tool_stall_timeout), `${file}: agent_runtime.tool_stall_timeout`),
    maxRunTimeMs: table.max_run_time === undefined ? 0 : parseDurationMs(String(table.max_run_time), `${file}: agent_runtime.max_run_time`),
  };
}

export function createActivity(now: number): AgentActivityState {
  return { startedAt: now, lastActivityAt: now, lastActivityKind: "created", runningTools: [], phase: "working" };
}

export function noteActivity(state: AgentActivityState, kind: string, now: number): void {
  state.lastActivityAt = now;
  state.lastActivityKind = kind;
  state.suspectedStallAt = undefined;
  state.phase = "working";
}

export function noteToolStart(state: AgentActivityState, name: string, now: number, id = name): void {
  state.runningTools.push({ id, name, startedAt: now });
  state.activeTool = { name: state.runningTools[0]!.name, startedAt: state.runningTools[0]!.startedAt };
  noteActivity(state, "tool_start", now);
}

export function noteToolEnd(state: AgentActivityState, now: number, id?: string): void {
  const index = id === undefined ? 0 : state.runningTools.findIndex((tool) => tool.id === id);
  if (index >= 0) state.runningTools.splice(index, 1);
  const oldest = state.runningTools[0];
  state.activeTool = oldest ? { name: oldest.name, startedAt: oldest.startedAt } : undefined;
  noteActivity(state, "tool_end", now);
}

export const PROVIDER_STREAM_TOOL_ID = "provider-stream";

/** Synthetic in-flight tool for provider-native work that emits no Pi tool event. */
export function syncToolHold(state: AgentActivityState, hold: { name: string } | undefined, now: number): void {
  const index = state.runningTools.findIndex((tool) => tool.id === PROVIDER_STREAM_TOOL_ID);
  if (hold) {
    if (index >= 0) {
      state.runningTools[index]!.name = hold.name;
    } else {
      state.runningTools.push({ id: PROVIDER_STREAM_TOOL_ID, name: hold.name, startedAt: now });
    }
  } else if (index >= 0) {
    state.runningTools.splice(index, 1);
  }
  const oldest = state.runningTools[0];
  state.activeTool = oldest ? { name: oldest.name, startedAt: oldest.startedAt } : undefined;
}

/** Cache warming and queue noise are not progress. */
export function activityKind(event: { type?: string; assistantMessageEvent?: { type?: string } }): string | undefined {
  const type = event.type ?? "";
  if (type === "cache_warming_decision" || type === "queue_update" || type === "session_info_changed") return undefined;
  if (type === "message_update") {
    const kind = event.assistantMessageEvent?.type;
    if (kind === "text_delta" || kind === "thinking_delta" || kind === "toolcall_delta") return "model_stream";
    return undefined;
  }
  if (type === "compaction_start" || type === "compaction_end") return "compaction";
  if (type === "tool_execution_start") return "tool_start";
  if (type === "tool_execution_update") return "tool_progress";
  if (type === "tool_execution_end") return "tool_end";
  if (type === "agent_start" || type === "turn_start" || type === "message_start" || type === "message_end") return "turn";
  if (type === "auto_retry_start") return "retry";
  return undefined;
}

export function evaluateWatchdog(state: AgentActivityState, config: WatchdogConfig, now: number): "ok" | "suspect" | "stalled" | "max_runtime" {
  if (config.maxRunTimeMs > 0 && now - state.startedAt >= config.maxRunTimeMs) {
    state.phase = "stalled";
    return "max_runtime";
  }
  const limit = state.activeTool ? config.toolStallTimeoutMs : config.idleTimeoutMs;
  const inactive = now - state.lastActivityAt;
  if (inactive < limit) {
    state.suspectedStallAt = undefined;
    state.phase = "working";
    return "ok";
  }
  if (state.suspectedStallAt === undefined) {
    state.suspectedStallAt = now;
    state.phase = "suspected_stall";
    return "suspect";
  }
  if (now - state.suspectedStallAt >= STALL_CONFIRM_MS) {
    state.phase = "stalled";
    return "stalled";
  }
  return "suspect";
}

export function stallInfo(state: AgentActivityState, now: number, kind: "stalled" | "max_runtime"): StallInfo {
  return {
    kind,
    inactivityMs: now - state.lastActivityAt,
    lastActivityKind: state.lastActivityKind,
    activeTool: state.activeTool?.name,
    elapsedMs: now - state.startedAt,
  };
}

export function startWatchdogTimer(
  tick: () => void,
  intervalMs = WATCHDOG_INTERVAL_MS,
  schedule: (fn: () => void, ms: number) => { unref?: () => void } = setInterval,
): { stop: () => void } {
  const timer = schedule(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer as ReturnType<typeof setInterval>) };
}
