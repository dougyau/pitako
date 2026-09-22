import { formatUsage, type AgentInstance, type AgentUsage, type WatchdogSnapshot } from "./run.ts";

const TASK_CAP = 100;
const ERROR_CAP = 160;

/** First non-empty line, whitespace collapsed, never longer than 100 characters. */
export function summarizeTask(task: string): string {
  const line = task.split("\n").find((part) => part.trim().length > 0) ?? "";
  const collapsed = line.trim().replace(/\s+/g, " ");
  return collapsed.length <= TASK_CAP ? collapsed : collapsed.slice(0, TASK_CAP);
}

/** Coarse clock. Sub-minute stays seconds; do not invent a stall from this. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function liveStatus(instance: AgentInstance, watchdog?: WatchdogSnapshot): string {
  if (instance.status === "created") return "starting";
  if (instance.status === "completed") return "completed";
  if (instance.status === "cancelled") return "cancelled";
  if (watchdog?.phase === "stalled") return "stalled";
  if (instance.status === "failed") return "failed";
  if (watchdog?.phase === "suspected_stall") return "suspected_stall";
  return "working";
}

function capError(text: string): string {
  const redacted = text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
  const flat = redacted.replace(/\s+/g, " ").trim();
  return flat.length <= ERROR_CAP ? flat : flat.slice(0, ERROR_CAP);
}

/**
 * Compact live view. Status comes from AgentInstance plus the watchdog phase.
 * Active model is provenance.selectedModel only after appliedReasoning is set.
 */
export function formatAgentLive(input: {
  instance: AgentInstance;
  task: string;
  watchdog?: WatchdogSnapshot;
  usage?: AgentUsage;
  error?: string;
}): string {
  const { instance, watchdog, usage } = input;
  const model = instance.model;
  const pending = model.appliedReasoning === undefined && (instance.status === "created" || instance.status === "running");
  const lines = [
    `${instance.id} ${liveStatus(instance, watchdog)}`,
    `role: ${instance.roleId}`,
    `task: ${summarizeTask(input.task)}`,
    `requested model: ${model.requestedModel ?? "unknown"}`,
  ];
  if (pending) lines.push("activation pending");
  else if (model.appliedReasoning !== undefined) lines.push(`active model: ${model.selectedModel}`);
  lines.push(
    `reasoning requested: ${model.requestedReasoning ?? "default"}`,
    `reasoning applied: ${model.appliedReasoning ?? "unknown"}`,
  );
  if (watchdog) {
    lines.push(`activity: ${watchdog.activeTool ?? watchdog.lastActivityKind}`);
    if (usage?.turns !== undefined) lines.push(`turns: ${usage.turns}`);
    if (usage?.toolCalls !== undefined) lines.push(`tool calls: ${usage.toolCalls}`);
    lines.push(`elapsed: ${formatElapsed(watchdog.elapsedMs)}`);
    const tool = watchdog.activeTool ? `, tool ${watchdog.activeTool}` : "";
    lines.push(`watchdog: ${watchdog.phase}, inactive ${formatElapsed(watchdog.inactivityMs)}${tool}`);
  }
  if (model.fallbackOccurred) {
    lines.push(`fallback: ${model.fallbackReason ?? "unknown"} from ${model.requestedModel ?? "primary"}`);
  }
  if (input.error && input.error !== "cancelled") lines.push(`error: ${capError(input.error)}`);
  const settled = instance.status === "completed" || instance.status === "failed" || instance.status === "cancelled" || liveStatus(instance, watchdog) === "stalled";
  if (settled && usage) lines.push(formatUsage(usage));
  return lines.join("\n");
}
