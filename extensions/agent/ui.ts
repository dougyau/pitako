/** Pure agent footer/detail projection. No Pi, bag, ledger, ANSI, or timers. */

export type AgentUiStatus = "created" | "running" | "completed" | "failed" | "cancelled";
export type AgentUiPhase = "working" | "idle" | "suspected_stall" | "stalled";

export interface AgentUiSnapshot {
  id: string;
  roleId: string;
  status: AgentUiStatus;
  phase: AgentUiPhase;
  task: string;
  acceptedAt: number;
  terminalAt?: number;
  planId?: string;
  unitId?: string;
  selectedModel: string;
  requestedModel?: string;
  modelLabel?: string;
  appliedReasoning?: string;
  requestedReasoning?: string;
  fallbackOccurred?: boolean;
  fallbackReason?: string;
  activeTool?: { name: string; startedAt: number };
  lastActivityKind: string;
  outputTokens?: number;
  streamMs?: number;
  /** Assistant turns seen so far. Omit when unknown. */
  turns?: number;
  /** Tool starts seen so far. Omit when unknown. */
  toolCalls?: number;
  resultTaken?: boolean;
  failureKind?: string;
  /** Watchdog inactivity; used for `no stream · mm:ss`. */
  inactivityMs?: number;
  /** Internal foreground lease; omitted for untagged AgentInstances. */
  teamOwnerToken?: symbol;
}

const ROLE_ABBREV: Record<string, string> = {
  developer: "dev",
  reviewer: "rev",
  architect: "arch",
  researcher: "res",
  coordinator: "coord",
};

const EFFORT_LABELS = new Set(["low", "med", "medium", "high", "xhigh", "min", "max", "off"]);
const FOOTER_TASK_CAP = 42;
const DETAIL_TASK_CAP = 100;
const TERMINAL_LINGER_MS = 8_000;

function roleAbbrev(roleId: string): string {
  if (ROLE_ABBREV[roleId]) return ROLE_ABBREV[roleId]!;
  return roleId.length > 6 ? roleId.slice(0, 4) : roleId;
}

/** First non-empty line, whitespace collapsed, optional Objective: strip, capped. */
function summarize(task: string, cap: number): string {
  const line = task.split("\n").find((part) => part.trim().length > 0) ?? "";
  let collapsed = line.trim().replace(/\s+/g, " ");
  if (collapsed.toLowerCase().startsWith("objective:")) {
    collapsed = collapsed.slice("objective:".length).trim();
  }
  return collapsed.length <= cap ? collapsed : collapsed.slice(0, cap);
}

/** mm:ss under 1h, h:mm:ss at or above. */
export function formatUiClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h >= 1) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

function elapsedMs(row: AgentUiSnapshot, now: number): number {
  return Math.max(0, now - row.acceptedAt);
}

function isResultReady(row: AgentUiSnapshot): boolean {
  return row.status === "completed" && !row.resultTaken;
}

function isGrouped(row: AgentUiSnapshot): boolean {
  return Boolean(row.planId && row.unitId);
}

function groupKey(row: AgentUiSnapshot): string {
  return `${row.planId}\0${row.unitId}`;
}

function compareRows(a: AgentUiSnapshot, b: AgentUiSnapshot): number {
  const ag = isGrouped(a);
  const bg = isGrouped(b);
  if (ag !== bg) return ag ? -1 : 1;
  if (ag && bg) {
    const plan = (a.planId ?? "").localeCompare(b.planId ?? "");
    if (plan !== 0) return plan;
    const unit = (a.unitId ?? "").localeCompare(b.unitId ?? "");
    if (unit !== 0) return unit;
  }
  if (a.acceptedAt !== b.acceptedAt) return a.acceptedAt - b.acceptedAt;
  return a.id.localeCompare(b.id);
}

function sortRows(rows: readonly AgentUiSnapshot[]): AgentUiSnapshot[] {
  return rows.slice().sort(compareRows);
}

function failureCompactKey(row: AgentUiSnapshot): string {
  return `${groupKey(row)}\0${row.roleId}\0${row.failureKind ?? ""}`;
}

export function projectSnapshots(rows: readonly AgentUiSnapshot[], now: number): AgentUiSnapshot[] {
  const runningGroups = new Set(
    rows.filter((r) => r.status === "running" && isGrouped(r)).map(groupKey),
  );
  // Compacted failure: same planId+unitId+roleId+failureKind, count >= 2, running sibling in group.
  const failureCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== "failed" || !isGrouped(row) || !row.failureKind) continue;
    if (!runningGroups.has(groupKey(row))) continue;
    const key = failureCompactKey(row);
    failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
  }
  const compactedFailures = new Set(
    [...failureCounts.entries()].filter(([, n]) => n >= 2).map(([key]) => key),
  );
  const relevant = rows.filter((row) => {
    if (row.status === "running") return true;
    if (row.status === "completed" && !row.resultTaken) return true;
    if (
      (row.status === "completed" || row.status === "failed" || row.status === "cancelled") &&
      row.terminalAt !== undefined &&
      now - row.terminalAt < TERMINAL_LINGER_MS
    ) {
      return true;
    }
    if (
      row.status === "failed" &&
      isGrouped(row) &&
      row.failureKind &&
      compactedFailures.has(failureCompactKey(row))
    ) {
      return true;
    }
    return false;
  });
  return sortRows(relevant);
}

function glyphFor(row: AgentUiSnapshot): string {
  if (row.status === "cancelled") return "⊘";
  if (row.status === "failed") return "×";
  if (row.status === "completed") return "✓";
  if (row.phase === "idle") return "○";
  return "●";
}

/** Priority: running, result-ready, failed, cancelled, completed. Lower wins. */
function stateRank(row: AgentUiSnapshot): number {
  if (row.status === "running" || row.status === "created") return 0;
  if (isResultReady(row)) return 1;
  if (row.status === "failed") return 2;
  if (row.status === "cancelled") return 3;
  if (row.status === "completed") return 4;
  return 5;
}

function countGlyph(rows: readonly AgentUiSnapshot[]): string {
  let best = 5;
  let glyph = "●";
  for (const row of rows) {
    const rank = stateRank(row);
    if (rank < best) {
      best = rank;
      if (rank === 0) glyph = row.phase === "idle" ? "○" : "●";
      else if (rank === 1 || rank === 4) glyph = "✓";
      else if (rank === 2) glyph = "×";
      else if (rank === 3) glyph = "⊘";
    }
  }
  return glyph;
}

function stripProvider(model: string): string {
  const i = model.indexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

function effortLabel(value: string): string | undefined {
  if (!EFFORT_LABELS.has(value)) return undefined;
  return value === "medium" ? "med" : value;
}

function effortFooter(row: AgentUiSnapshot): string | undefined {
  if (row.appliedReasoning !== undefined) return effortLabel(row.appliedReasoning);
  if (row.requestedReasoning !== undefined) {
    const label = effortLabel(row.requestedReasoning);
    return label ? `${label}?` : undefined;
  }
  return undefined;
}

function effortDetail(row: AgentUiSnapshot): string | undefined {
  if (row.appliedReasoning !== undefined) {
    const label = effortLabel(row.appliedReasoning);
    return label ? `${label} applied` : undefined;
  }
  if (row.requestedReasoning !== undefined) {
    const label = effortLabel(row.requestedReasoning);
    return label ? `${label} requested` : undefined;
  }
  return undefined;
}

/** Active model only after appliedReasoning. Else requested compact id or model…. */
function modelFooter(row: AgentUiSnapshot): string {
  if (row.appliedReasoning === undefined) {
    if (row.requestedModel) return stripProvider(row.requestedModel);
    return "model…";
  }
  if (row.modelLabel) return row.modelLabel;
  return stripProvider(row.selectedModel);
}

function modelDetail(row: AgentUiSnapshot): string {
  if (row.appliedReasoning === undefined) {
    return row.requestedModel ?? "model…";
  }
  return row.selectedModel;
}

function tokensPerSec(row: AgentUiSnapshot): number | undefined {
  if (row.activeTool) return undefined;
  if (row.phase === "suspected_stall" || row.phase === "stalled") return undefined;
  const tokens = row.outputTokens;
  const streamMs = row.streamMs;
  if (tokens === undefined || !(tokens > 0)) return undefined;
  if (streamMs === undefined || streamMs < 1000) return undefined;
  const n = Math.round(tokens / (streamMs / 1000));
  if (n < 1) return undefined;
  return n;
}

function toolDisplayName(name: string): string {
  return name === "cursor-native" ? "cursor" : name;
}

function activityText(row: AgentUiSnapshot, now: number): string {
  if (isResultReady(row)) return "result ready";

  if (row.activeTool) {
    const name = toolDisplayName(row.activeTool.name);
    const age = now - row.activeTool.startedAt;
    if (age >= 1000) return `${name} · ${formatUiClock(age)}`;
    return name;
  }

  if (row.status === "running" && (row.phase === "suspected_stall" || row.phase === "stalled")) {
    const inactive = row.inactivityMs ?? 0;
    return `no stream · ${formatUiClock(inactive)}`;
  }

  if (row.status === "failed") {
    const kind = row.failureKind ?? row.lastActivityKind;
    const last = row.lastActivityKind;
    if (
      kind === "model_stream" ||
      kind === "stall" ||
      last === "model_stream" ||
      last === "created" ||
      last === "prompt" ||
      last === "turn"
    ) {
      return "no model_stream";
    }
  }

  const rate = tokensPerSec(row);
  if (rate !== undefined) return `${rate} t/s`;

  if (
    row.status === "running" &&
    !(row.outputTokens && row.outputTokens > 0) &&
    (row.lastActivityKind === "created" || row.lastActivityKind === "prompt" || row.lastActivityKind === "turn")
  ) {
    return "model…";
  }

  return "—";
}

function joinParts(parts: string[]): string {
  return parts.filter((p) => p.length > 0).join(" · ");
}

function providerOf(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  return model.slice(0, slash);
}

/** Active provider after activation. Requested provider before that. */
function providerFooter(row: AgentUiSnapshot): string {
  const id = row.appliedReasoning === undefined ? row.requestedModel : row.selectedModel;
  return providerOf(id) ?? "";
}

function workFooter(row: AgentUiSnapshot): string {
  const parts: string[] = [];
  if (row.turns !== undefined && row.turns > 0) parts.push(`${row.turns}t`);
  if (row.toolCalls !== undefined && row.toolCalls > 0) parts.push(`${row.toolCalls} tools`);
  return parts.join(" · ");
}

/** Explicit state word. Waiting is model-start with no tokens and no tool, not a guessed stall. */
export function statusWord(row: AgentUiSnapshot): string {
  if (row.status === "cancelled") return "cancelled";
  if (row.status === "failed") return "failed";
  if (row.status === "completed") return isResultReady(row) ? "ready" : "done";
  if (row.phase === "suspected_stall" || row.phase === "stalled") return "stalled";
  if (row.phase === "idle") return "idle";
  if (
    !row.activeTool &&
    !(row.outputTokens && row.outputTokens > 0) &&
    (row.status === "created" ||
      row.lastActivityKind === "created" ||
      row.lastActivityKind === "prompt" ||
      row.lastActivityKind === "turn")
  ) {
    return "waiting";
  }
  return "running";
}

function oneWorkerParts(row: AgentUiSnapshot, now: number): {
  prefix: string;
  role: string;
  status: string;
  task: string;
  provider: string;
  model: string;
  effort: string;
  elapsed: string;
  activity: string;
  work: string;
} {
  return {
    prefix: "Pitako",
    role: `${glyphFor(row)} ${roleAbbrev(row.roleId)}`,
    status: statusWord(row),
    task: summarize(row.task, FOOTER_TASK_CAP),
    provider: providerFooter(row),
    model: modelFooter(row),
    effort: effortFooter(row) ?? "",
    elapsed: formatUiClock(elapsedMs(row, now)),
    activity: activityText(row, now),
    work: workFooter(row),
  };
}

function renderOneWorker(row: AgentUiSnapshot, now: number, width: number): string {
  const p = oneWorkerParts(row, now);
  const head = `${p.prefix} ${p.role}`;
  // Keep the status word with the role. Drop work, activity, elapsed, effort, model, then provider.
  const attempts: string[] = [
    joinParts([head, p.status, p.task, p.provider, p.model, p.effort, p.elapsed, p.work, p.activity]),
    joinParts([head, p.status, p.task, p.provider, p.model, p.effort, p.elapsed, p.work]),
    joinParts([head, p.status, p.task, p.provider, p.model, p.effort, p.elapsed]),
    joinParts([head, p.status, p.task, p.provider, p.model, p.effort]),
    joinParts([head, p.status, p.task, p.provider, p.model]),
    joinParts([head, p.status, p.task, p.provider]),
    joinParts([head, p.status, p.task]),
    joinParts([head, p.status, summarize(row.task, 12)]),
  ];
  const roleStatus = joinParts([p.role, p.status]);
  const room = width - roleStatus.length - 3;
  const frag = room >= 1 ? summarize(row.task, Math.min(12, room)) : "";
  const withFrag = frag.length > 0 ? joinParts([roleStatus, frag]) : roleStatus;
  if (withFrag !== roleStatus) attempts.push(withFrag);
  attempts.push(roleStatus);
  attempts.push(p.role);

  for (const line of attempts) {
    if (line.length <= width) return line;
  }
  const fallback = withFrag !== p.role ? withFrag : p.role;
  return fallback.length <= width ? fallback : fallback.slice(0, width);
}

function multiItem(row: AgentUiSnapshot): { withUnit: string; roleOnly: string } {
  const role = roleAbbrev(row.roleId);
  return {
    withUnit: row.unitId ? `${role}:${row.unitId}` : role,
    roleOnly: role,
  };
}

function renderMulti(rows: readonly AgentUiSnapshot[], width: number): string {
  const glyph = countGlyph(rows);
  const n = rows.length;
  const status = statusWord(rows.slice().sort((a, b) => stateRank(a) - stateRank(b))[0] ?? rows[0]!);
  const items = rows.map(multiItem);
  const withUnits = items.map((i) => i.withUnit);
  const rolesOnly = items.map((i) => i.roleOnly);

  const candidates: string[] = [
    `Pitako ${glyph} ${n} · ${status} · ${withUnits.join(" · ")}`,
    `Pitako ${glyph} ${n} · ${status} · ${rolesOnly.join(" · ")}`,
    `Pitako ${glyph} ${n} · ${withUnits.join(" · ")}`,
    `Pitako ${glyph} ${n} · ${rolesOnly.join(" · ")}`,
    `Pitako ${glyph} ${n} · ${status}`,
  ];
  // Drop extra roles gradually
  for (let keep = rolesOnly.length - 1; keep >= 1; keep--) {
    candidates.push(`Pitako ${glyph} ${n} · ${rolesOnly.slice(0, keep).join(" · ")}`);
  }
  candidates.push(`Pitako ${glyph} ${n}`);
  candidates.push(`${glyph} ${n}`);

  for (const line of candidates) {
    if (line.length <= width) return line;
  }
  return `${glyph} ${n}`.slice(0, width);
}

/** Ms until a linger row should leave the footer. Undefined if nothing will expire. */
export function nextFooterRefreshMs(rows: readonly AgentUiSnapshot[], now: number): number | undefined {
  let wait: number | undefined;
  for (const row of rows) {
    if (row.status === "running" || row.status === "created" || row.terminalAt === undefined) continue;
    const left = row.terminalAt + TERMINAL_LINGER_MS - now;
    if (left <= 0) continue;
    if (wait === undefined || left < wait) wait = left;
  }
  return wait;
}

export function formatFooter(rows: readonly AgentUiSnapshot[], now: number, width: number): string {
  const relevant = projectSnapshots(rows, now);
  if (relevant.length === 0) return "";
  const w = Math.max(1, width);
  if (relevant.length === 1) return renderOneWorker(relevant[0]!, now, w);
  return renderMulti(relevant, w);
}

function detailLine(row: AgentUiSnapshot, now: number): string {
  const parts = [
    `${glyphFor(row)} ${row.id}`,
    statusWord(row),
    row.roleId,
    summarize(row.task, DETAIL_TASK_CAP),
    modelDetail(row),
  ];
  const provider = providerFooter(row);
  if (provider) parts.push(provider);
  const effort = effortDetail(row);
  if (effort) parts.push(effort);
  const turns = row.turns !== undefined && row.turns > 0 ? `${row.turns} turns` : "";
  const tools = row.toolCalls !== undefined && row.toolCalls > 0 ? `${row.toolCalls} tools` : "";
  if (turns) parts.push(turns);
  if (tools) parts.push(tools);
  parts.push(formatUiClock(elapsedMs(row, now)));
  parts.push(activityText(row, now));
  if (row.fallbackOccurred) {
    const from = row.requestedModel ? `from ${row.requestedModel}` : "from primary";
    const reason = row.fallbackReason ? ` ${row.fallbackReason}` : "";
    parts.push(`${from}${reason}`);
  }
  return joinParts(parts);
}

type DetailEntry = AgentUiSnapshot | { compact: true; roleId: string; count: number; kind: string };

function compactFailures(rows: readonly AgentUiSnapshot[]): DetailEntry[] {
  const failed = new Map<string, AgentUiSnapshot[]>();
  for (const row of rows) {
    if (row.status !== "failed" || !row.failureKind) continue;
    const key = `${row.roleId}\0${row.failureKind}`;
    const list = failed.get(key) ?? [];
    list.push(row);
    failed.set(key, list);
  }

  const out: DetailEntry[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    if (row.status === "failed" && row.failureKind) {
      const key = `${row.roleId}\0${row.failureKind}`;
      const list = failed.get(key)!;
      if (list.length >= 2) {
        if (emitted.has(key)) continue;
        emitted.add(key);
        out.push({ compact: true, roleId: row.roleId, count: list.length, kind: row.failureKind });
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

function formatDetailEntry(entry: DetailEntry, now: number): string {
  if ("compact" in entry) {
    return `× ${entry.roleId} ×${entry.count} · ${entry.kind}`;
  }
  return detailLine(entry, now);
}

export function formatAgentsDetail(rows: readonly AgentUiSnapshot[], now: number): string {
  if (rows.length === 0) return "";
  const sorted = sortRows(rows);
  const grouped = new Map<string, AgentUiSnapshot[]>();
  const ungrouped: AgentUiSnapshot[] = [];

  for (const row of sorted) {
    if (isGrouped(row)) {
      const key = groupKey(row);
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    } else {
      ungrouped.push(row);
    }
  }

  const lines: string[] = [];
  // Preserve planId/unitId order from sorted
  const seen = new Set<string>();
  for (const row of sorted) {
    if (!isGrouped(row)) continue;
    const key = groupKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    const members = grouped.get(key)!;
    lines.push(row.unitId!);
    const entries = compactFailures(members);
    for (let i = 0; i < entries.length; i++) {
      const branch = i === entries.length - 1 ? "└─" : "├─";
      lines.push(`${branch} ${formatDetailEntry(entries[i]!, now)}`);
    }
  }

  // Compaction is only inside one planId+unitId group.
  for (const row of ungrouped) {
    lines.push(detailLine(row, now));
  }

  return lines.join("\n");
}
