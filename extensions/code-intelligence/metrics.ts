export const CODE_INTELLIGENCE_TOOL_NAMES = [
  "project_report",
  "read_symbol",
  "read_enclosing",
  "module_report",
  "inspect_symbol",
  "review_surface",
] as const;

export const CODE_SOURCES = ["ast", "lsp", "graph", "rg", "git"] as const;

export type DenseToolName = (typeof CODE_INTELLIGENCE_TOOL_NAMES)[number];
export type CodeSource = (typeof CODE_SOURCES)[number];
export type ToolOutcome = "ok" | "partial" | "unavailable" | "error" | "cancelled";

export interface SourceUsage {
  calls: number;
  durationMs: number;
}

export interface GraphCallUsage {
  state?: string;
  states?: Record<string, number>;
  buildDurations?: Record<string, number>;
  buildFailures?: Record<string, number>;
  /** Failed graph-query attempts; buildFailures is separately deduplicated by build ID. */
  failures: number;
}

export interface DenseCallUsage {
  tool: DenseToolName;
  durationMs: number;
  outputBytes: number;
  truncated: boolean;
  outcome: ToolOutcome;
  telemetryAvailable?: boolean;
  sources: Partial<Record<CodeSource, SourceUsage>>;
  graph?: GraphCallUsage;
}

export interface CodeIntelligenceUsage {
  dense: Partial<Record<DenseToolName, {
    calls: number;
    durationMs: number;
    outputBytes: number;
    truncated: number;
    outcomes: Partial<Record<ToolOutcome, number>>;
  }>>;
  sources: Partial<Record<CodeSource, SourceUsage>>;
  graph: {
    state?: string;
    states: Record<string, number>;
    buildDurations: Record<string, number>;
    buildFailures: Record<string, number>;
    failures: number;
  };
  unmeasuredCalls: number;
  raw: { read: number; grep: number };
  navigation: {
    available: boolean;
    samples: number;
    completedCalls: number;
    read: number;
    grep: number;
    remaining: number;
    abandoned: number;
  };
}

export function emptyCodeIntelligenceUsage(navigationAvailable = true): CodeIntelligenceUsage {
  return {
    dense: {},
    sources: {},
    graph: { states: {}, buildDurations: {}, buildFailures: {}, failures: 0 },
    unmeasuredCalls: 0,
    raw: { read: 0, grep: 0 },
    navigation: { available: navigationAvailable, samples: 0, completedCalls: 0, read: 0, grep: 0, remaining: 0, abandoned: 0 },
  };
}

export function isDenseToolName(name: string): name is DenseToolName {
  return (CODE_INTELLIGENCE_TOOL_NAMES as readonly string[]).includes(name);
}

function mergeGraphUsage(target: CodeIntelligenceUsage["graph"], source: GraphCallUsage | CodeIntelligenceUsage["graph"]): void {
  target.buildFailures ??= {};
  for (const [state, count] of Object.entries(source.states ?? {})) target.states[state] = (target.states[state] ?? 0) + count;
  for (const [id, durationMs] of Object.entries(source.buildDurations ?? {})) target.buildDurations[id] ??= durationMs;
  const attributedFailures = Object.values(source.buildFailures ?? {}).reduce((sum, count) => sum + count, 0);
  target.failures += Math.max(0, source.failures - attributedFailures);
  for (const [id, count] of Object.entries(source.buildFailures ?? {})) {
    if (id in target.buildFailures) continue;
    target.buildFailures[id] = count;
    target.failures += count;
  }
  target.state = source.state ?? target.state;
}

export function addDenseCall(usage: CodeIntelligenceUsage, call: DenseCallUsage): void {
  const item = usage.dense[call.tool] ??= { calls: 0, durationMs: 0, outputBytes: 0, truncated: 0, outcomes: {} };
  item.calls += 1;
  item.durationMs += call.durationMs;
  item.outputBytes += call.outputBytes;
  if (call.truncated) item.truncated += 1;
  item.outcomes[call.outcome] = (item.outcomes[call.outcome] ?? 0) + 1;

  if (call.telemetryAvailable === false || !call.graph) {
    usage.unmeasuredCalls += 1;
  } else {
    for (const [source, measured] of Object.entries(call.sources) as [CodeSource, SourceUsage][]) {
      const total = usage.sources[source] ??= { calls: 0, durationMs: 0 };
      total.calls += measured.calls;
      total.durationMs += measured.durationMs;
    }
    mergeGraphUsage(usage.graph, call.graph);
  }
  usage.navigation.samples += 1;
}

export function addRawTool(usage: CodeIntelligenceUsage, name: string): void {
  if (name === "read" || name === "grep") usage.raw[name] += 1;
}

/** Track a single non-overlapping post-dense window over the next five tool completions. */
export function completeTool(
  usage: CodeIntelligenceUsage,
  name: string,
  call: DenseCallUsage | undefined,
  navigation: { remaining: number },
): void {
  if (navigation.remaining > 0) {
    usage.navigation.completedCalls += 1;
    if (name === "read") usage.navigation.read += 1;
    if (name === "grep") usage.navigation.grep += 1;
    navigation.remaining -= 1;
  }
  if (name === "read" || name === "grep") addRawTool(usage, name);
  if (call) {
    if (navigation.remaining > 0) usage.navigation.abandoned += navigation.remaining;
    addDenseCall(usage, call);
    navigation.remaining = 5;
  }
  usage.navigation.remaining = navigation.remaining;
}

export function codeIntelligenceDelta(
  before: CodeIntelligenceUsage | undefined,
  after: CodeIntelligenceUsage | undefined,
): CodeIntelligenceUsage | undefined {
  if (!after) return undefined;
  if (!before) return structuredClone(after);
  const delta = emptyCodeIntelligenceUsage(after.navigation.available);
  for (const tool of CODE_INTELLIGENCE_TOOL_NAMES) {
    const current = after.dense[tool];
    if (!current) continue;
    const previous = before.dense[tool];
    delta.dense[tool] = {
      calls: Math.max(0, current.calls - (previous?.calls ?? 0)),
      durationMs: Math.max(0, current.durationMs - (previous?.durationMs ?? 0)),
      outputBytes: Math.max(0, current.outputBytes - (previous?.outputBytes ?? 0)),
      truncated: Math.max(0, current.truncated - (previous?.truncated ?? 0)),
      outcomes: Object.fromEntries(Object.entries(current.outcomes).flatMap(([outcome, count]) => {
        const value = count - (previous?.outcomes[outcome as ToolOutcome] ?? 0);
        return value > 0 ? [[outcome, value]] : [];
      })) as Partial<Record<ToolOutcome, number>>,
    };
  }
  for (const source of CODE_SOURCES) {
    const current = after.sources[source];
    if (!current) continue;
    const previous = before.sources[source];
    delta.sources[source] = {
      calls: Math.max(0, current.calls - (previous?.calls ?? 0)),
      durationMs: Math.max(0, current.durationMs - (previous?.durationMs ?? 0)),
    };
  }
  for (const [state, count] of Object.entries(after.graph.states)) {
    const value = count - (before.graph.states[state] ?? 0);
    if (value > 0) delta.graph.states[state] = value;
  }
  delta.graph.state = after.graph.state;
  delta.graph.buildDurations = Object.fromEntries(Object.entries(after.graph.buildDurations).filter(([id]) => !(id in before.graph.buildDurations)));
  delta.graph.buildFailures = Object.fromEntries(Object.entries(after.graph.buildFailures ?? {}).filter(([id]) => !(id in (before.graph.buildFailures ?? {}))));
  delta.graph.failures = Math.max(0, after.graph.failures - before.graph.failures);
  delta.unmeasuredCalls = Math.max(0, after.unmeasuredCalls - before.unmeasuredCalls);
  delta.raw.read = Math.max(0, after.raw.read - before.raw.read);
  delta.raw.grep = Math.max(0, after.raw.grep - before.raw.grep);
  delta.navigation.samples = Math.max(0, after.navigation.samples - before.navigation.samples);
  delta.navigation.completedCalls = Math.max(0, after.navigation.completedCalls - before.navigation.completedCalls);
  delta.navigation.read = Math.max(0, after.navigation.read - before.navigation.read);
  delta.navigation.grep = Math.max(0, after.navigation.grep - before.navigation.grep);
  delta.navigation.remaining = after.navigation.remaining;
  delta.navigation.abandoned = Math.max(0, after.navigation.abandoned - before.navigation.abandoned);
  return delta;
}

export function mergeCodeIntelligenceUsage(
  left: CodeIntelligenceUsage | undefined,
  right: CodeIntelligenceUsage | undefined,
): CodeIntelligenceUsage | undefined {
  if (!left) return right ? structuredClone(right) : undefined;
  if (!right) return structuredClone(left);
  const merged = structuredClone(left);
  for (const tool of CODE_INTELLIGENCE_TOOL_NAMES) {
    const source = right.dense[tool];
    if (!source) continue;
    const target = merged.dense[tool] ??= { calls: 0, durationMs: 0, outputBytes: 0, truncated: 0, outcomes: {} };
    target.calls += source.calls;
    target.durationMs += source.durationMs;
    target.outputBytes += source.outputBytes;
    target.truncated += source.truncated;
    for (const [outcome, count] of Object.entries(source.outcomes) as [ToolOutcome, number][]) {
      target.outcomes[outcome] = (target.outcomes[outcome] ?? 0) + count;
    }
  }
  for (const source of CODE_SOURCES) {
    const measured = right.sources[source];
    if (!measured) continue;
    const target = merged.sources[source] ??= { calls: 0, durationMs: 0 };
    target.calls += measured.calls;
    target.durationMs += measured.durationMs;
  }
  mergeGraphUsage(merged.graph, right.graph);
  merged.unmeasuredCalls += right.unmeasuredCalls;
  merged.raw.read += right.raw.read;
  merged.raw.grep += right.raw.grep;
  merged.navigation.available = left.navigation.available && right.navigation.available;
  merged.navigation.samples += right.navigation.samples;
  merged.navigation.completedCalls += right.navigation.completedCalls;
  merged.navigation.read += right.navigation.read;
  merged.navigation.grep += right.navigation.grep;
  merged.navigation.remaining = right.navigation.remaining;
  merged.navigation.abandoned += right.navigation.abandoned;
  return merged;
}

export function formatCodeIntelligenceUsage(usage: CodeIntelligenceUsage | undefined): string {
  if (!usage) return "code intelligence: unknown";
  const dense = CODE_INTELLIGENCE_TOOL_NAMES.map((tool) => {
    const value = usage.dense[tool];
    if (!value) return `${tool}=0`;
    const outcomes = Object.entries(value.outcomes).map(([name, count]) => `${name}:${count}`).join(",") || "?";
    return `${tool}=${value.calls} (${value.durationMs}ms, ${value.outputBytes}B, truncated:${value.truncated}, ${outcomes})`;
  });
  const sources = CODE_SOURCES.map((source) => {
    const value = usage.sources[source];
    return `${source}=${usage.unmeasuredCalls ? "unknown" : `${value?.calls ?? 0}/${value?.durationMs ?? 0}ms`}`;
  });
  const builds = Object.values(usage.graph.buildDurations);
  const navigation = usage.navigation.available
    ? `available; windows=${usage.navigation.samples}, completed=${usage.navigation.completedCalls}, read=${usage.navigation.read}, grep=${usage.navigation.grep}, pending_latest=${usage.navigation.remaining}, abandoned=${usage.navigation.abandoned}`
    : "unavailable";
  const states = Object.entries(usage.graph.states).map(([state, count]) => `${state}:${count}`).join(",") || "unknown";
  const graph = usage.unmeasuredCalls
    ? `state=unknown (telemetry missing for ${usage.unmeasuredCalls} dense call${usage.unmeasuredCalls === 1 ? "" : "s"}), builds=unknown, query_failures=unknown`
    : `state=${usage.graph.state ?? "unknown"} (${states}), builds=${builds.length}/${builds.reduce((sum, duration) => sum + duration, 0)}ms, query_failures=${usage.graph.failures}`;
  return [
    `code intelligence: ${dense.join("; ")}`,
    `  sources: ${sources.join("; ")}`,
    `  graph: ${graph}`,
    `  raw navigation: read=${usage.raw.read}, grep=${usage.raw.grep}; post-dense navigation=${navigation}`,
  ].join("\n");
}
