/** In-memory observation copy and bounded terminal evidence, plus footer binder/clock. */

import { formatFooter, nextFooterRefreshMs, type AgentUiSnapshot } from "./ui.ts";
import { readActivitySnapshot, type ActivityPage, type ActivityReadOptions, type TerminalActivitySnapshot } from "./live.ts";
import type { WorkerHandoff } from "./background.ts";

export interface TerminalActivityKey {
  ownerToken: symbol;
  coordinatorSessionId: string;
  teamOwnerToken?: symbol;
  assignmentId?: string;
  instanceId: string;
  generation: number;
  attemptId: string;
  historyId: string;
  sessionId: string;
}
export type TerminalActivityRead =
  | { state: "ready"; page: ActivityPage }
  | { state: "evicted" }
  | { state: "unavailable"; reason: "not_captured" | "close_failed" | "capture_failed" | "snapshot_oversized" | "unsupported_kind" }
  | { state: "stale_reference" }
  | { state: "invalid_cursor" };
type UnavailableReason = Extract<TerminalActivityRead, { state: "unavailable" }>["reason"];
interface RetainedActivity {
  key: TerminalActivityKey;
  epoch: number;
  state: "ready" | "evicted" | "unavailable" | "stale_reference";
  reason?: UnavailableReason;
  snapshot?: TerminalActivitySnapshot;
  bytes: number;
  retired?: boolean;
}

/**
 * Pi loads each extension with `moduleCache: false`. `extensions/index.ts` and
 * `extensions/agent/index.ts` therefore do not share a module Map. Same pattern
 * as the background bag.
 */
const OBSERVATIONS = Symbol.for("pitako.agentObservations");
const AGENT_UI = Symbol.for("pitako.agentUi");
const STATUS_KEY = "pitako.agents";

interface ObservationState {
  rows: Map<string, AgentUiSnapshot>;
  listeners: Set<() => void>;
  changes: Set<(row: AgentUiSnapshot) => void>;
  epoch: number;
  activity: Map<string, RetainedActivity>;
  retained: Map<string, number>;
  retainedBytes: number;
}

function observations(): ObservationState {
  const host = globalThis as Record<symbol, ObservationState | undefined>;
  const existing = host[OBSERVATIONS];
  if (existing) {
    existing.activity ??= new Map();
    existing.retained ??= new Map();
    existing.retainedBytes ??= 0;
    existing.changes ??= new Set();
    return existing;
  }
  const created: ObservationState = { rows: new Map(), listeners: new Set(), changes: new Set(), epoch: 0,
    activity: new Map(), retained: new Map(), retainedBytes: 0 };
  host[OBSERVATIONS] = created;
  return created;
}

/** Captured at spawn. A reload bumps the epoch so a dying worker cannot republish. */
export function observationEpoch(): number {
  return observations().epoch;
}

export type ModelLookup = (
  provider: string,
  id: string,
) => { name?: string } | undefined;

export type AgentUiScheduler = {
  setInterval: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval: (handle: { unref?: () => void }) => void;
  setTimeout?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimeout?: (handle: { unref?: () => void }) => void;
};

export type BindAgentUiOptions = {
  setStatus: (key: string, text: string | undefined) => void;
  modelLookup?: ModelLookup;
  now?: () => number;
  columns?: () => number | undefined;
  scheduler?: AgentUiScheduler;
  ownerToken?: symbol;
  coordinatorSessionId?: string;
};

type AgentUiSlot = {
  token: symbol;
  unbind: () => void;
};

export function publishObservation(row: AgentUiSnapshot, epoch = observationEpoch()): void {
  const state = observations();
  if (epoch !== state.epoch) return;
  const activity = state.activity.get(row.id);
  if (activity && !activity.retired && !matchesRow(row, activity.key)) {
    discardPayload(state, row.id);
    activity.state = "unavailable";
    activity.reason = "not_captured";
  }
  const previous = state.rows.get(row.id);
  state.rows.set(row.id, { ...row, ...(previous?.handoff ? { handoff: previous.handoff, resultTaken: previous.resultTaken } : {}) });
  changed(row);
  notify();
}

export function noteResultTaken(id: string): void {
  const state = observations();
  const row = state.rows.get(id);
  if (!row || row.resultTaken) return;
  state.rows.set(id, { ...row, resultTaken: true });
  changed(state.rows.get(id)!);
  notify();
}

export function noteHandoff(id: string, handoff: WorkerHandoff): void {
  const state = observations(), row = state.rows.get(id);
  if (!row) return;
  const next = { ...row, handoff };
  state.rows.set(id, next);
  changed(next);
  notify();
}

/** Wake read views when authoritative data changes without a new display observation. */
export function touchObservation(id: string, epoch = observationEpoch()): void {
  const state = observations(), row = state.rows.get(id);
  if (epoch === state.epoch && row) changed(row);
}

export function subscribeChanges(listener: (row: AgentUiSnapshot) => void): () => void {
  const listeners = observations().changes;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function changed(row: AgentUiSnapshot): void {
  for (const listener of observations().changes) {
    try { listener(row); } catch { /* Display observers cannot change worker behavior. */ }
  }
}

export function listObservations(ownerToken?: symbol, coordinatorSessionId?: string): AgentUiSnapshot[] {
  return [...observations().rows.values()].filter((row) =>
    (!row.teamOwnerToken || row.teamOwnerToken === ownerToken) &&
    (coordinatorSessionId === undefined || row.origin?.coordinatorSessionId === coordinatorSessionId &&
      (row.origin.source === "agent_run" || row.origin.source === "agent_spawn" ||
        row.origin.source === "team_assign" && Boolean(row.origin.assignmentId && row.teamOwnerToken && row.teamOwnerToken === ownerToken))));
}

export function removeTeamObservations(ownerToken: symbol): void {
  removeObservations((row) => row.teamOwnerToken === ownerToken);
}

export function removeObservation(instanceId: string): void {
  removeObservations((row) => row.id === instanceId);
}

export function removeUntaggedObservations(): void {
  removeObservations((row) => !row.teamOwnerToken);
}

function removeObservations(matches: (row: AgentUiSnapshot) => boolean): void {
  const state = observations();
  for (const [id, row] of state.rows) {
    if (matches(row)) {
      discardPayload(state, id);
      state.activity.delete(id);
      state.rows.delete(id);
      changed(row);
    }
  }
  notify();
}

export function subscribe(listener: () => void): () => void {
  const { listeners } = observations();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clears rows only. Does not notify; binder must clear status itself. */
export function clearObservations(): void {
  const state = observations();
  const previous = [...state.rows.values()];
  state.rows.clear();
  state.activity.clear();
  state.retained.clear();
  state.retainedBytes = 0;
  state.epoch += 1;
  for (const row of previous) changed(row);
}

function matchesRow(row: AgentUiSnapshot | undefined, key: TerminalActivityKey): boolean {
  if (!row || row.id !== key.instanceId || row.origin?.coordinatorSessionId !== key.coordinatorSessionId ||
      row.attemptId !== key.attemptId || typeof key.ownerToken !== "symbol" ||
      !Number.isSafeInteger(key.generation) || key.generation < 0 ||
      !key.historyId || !key.sessionId || !key.attemptId) return false;
  if (row.origin.source === "team_assign") return Boolean(key.teamOwnerToken &&
    row.teamOwnerToken === key.teamOwnerToken && key.assignmentId && row.origin.assignmentId === key.assignmentId);
  return (row.origin.source === "agent_spawn" || row.origin.source === "agent_run") &&
    !row.teamOwnerToken && !key.teamOwnerToken && !key.assignmentId;
}

function sameKey(a: TerminalActivityKey, b: TerminalActivityKey): boolean {
  return a.ownerToken === b.ownerToken && a.coordinatorSessionId === b.coordinatorSessionId &&
    a.teamOwnerToken === b.teamOwnerToken && a.assignmentId === b.assignmentId &&
    a.instanceId === b.instanceId && a.generation === b.generation && a.attemptId === b.attemptId &&
    a.historyId === b.historyId && a.sessionId === b.sessionId;
}

function currentActivity(state: ObservationState, key: TerminalActivityKey): RetainedActivity | undefined {
  const retained = state.activity.get(key.instanceId);
  return retained && !retained.retired && retained.epoch === state.epoch &&
    matchesRow(state.rows.get(key.instanceId), key) && sameKey(retained.key, key) ? retained : undefined;
}

function discardPayload(state: ObservationState, id: string): void {
  const bytes = state.retained.get(id);
  if (bytes !== undefined) {
    state.retainedBytes -= bytes;
    state.retained.delete(id);
  }
  const retained = state.activity.get(id);
  if (retained) { retained.snapshot = undefined; retained.bytes = 0; }
}

/** Initial owner authority is supplied by the authenticated background binder, not this read metadata. */
export function publishActivityBinding(key: TerminalActivityKey, epoch = observationEpoch()): void {
  const state = observations();
  if (epoch !== state.epoch || !matchesRow(state.rows.get(key.instanceId), key)) return;
  const previous = state.activity.get(key.instanceId);
  if (previous?.retired || previous && previous.key.ownerToken !== key.ownerToken) return;
  if (previous && (key.generation < previous.key.generation ||
      key.generation === previous.key.generation &&
      (key.sessionId !== previous.key.sessionId || key.historyId !== previous.key.historyId))) return;
  if (previous && sameKey(previous.key, key)) return;
  discardPayload(state, key.instanceId);
  state.activity.set(key.instanceId, { key: { ...key }, epoch, state: "unavailable", reason: "not_captured", bytes: 0 });
  touchObservation(key.instanceId, epoch);
}

export function terminalActivityKey(
  instanceId: string, ownerToken: symbol, coordinatorSessionId: string, teamOwnerToken?: symbol,
): TerminalActivityKey | undefined {
  const state = observations();
  const key = state.activity.get(instanceId)?.key;
  return key && key.ownerToken === ownerToken && key.coordinatorSessionId === coordinatorSessionId &&
    key.teamOwnerToken === teamOwnerToken && currentActivity(state, key) ? { ...key } : undefined;
}

export function noteTerminalActivityUnavailable(
  key: TerminalActivityKey, reason: "close_failed" | "capture_failed" | "snapshot_oversized", epoch = observationEpoch(),
): void {
  const state = observations();
  const retained = currentActivity(state, key);
  if (epoch !== state.epoch || !retained) return;
  discardPayload(state, key.instanceId);
  retained.state = "unavailable";
  retained.reason = reason;
  touchObservation(key.instanceId, epoch);
}

function clippedDiagnostic(text: string): string {
  // UTF-16 slicing preserves exact JSON escaping; diagnostic text is not native identity.
  return text.length > 768 ? text.slice(0, 768) + "\n[clipped]" : text;
}

export function retainTerminalActivity(key: TerminalActivityKey, snapshot: TerminalActivitySnapshot, epoch = observationEpoch()): void {
  const state = observations();
  const retained = currentActivity(state, key);
  if (epoch !== state.epoch || !retained) return;
  if (state.rows.get(key.instanceId)?.origin?.source === "agent_run") return;
  discardPayload(state, key.instanceId);
  if (snapshot.historyId !== key.historyId || snapshot.sessionId !== key.sessionId ||
      snapshot.native.historyId !== key.historyId || snapshot.native.sessionId !== key.sessionId) {
    retained.state = "stale_reference";
    retained.reason = undefined;
    touchObservation(key.instanceId, epoch);
    return;
  }
  let copy: TerminalActivitySnapshot;
  try { copy = JSON.parse(JSON.stringify(snapshot)); }
  catch { noteTerminalActivityUnavailable(key, "capture_failed", epoch); return; }
  const diagnosticsClipped = copy.gaps.length > 32 || copy.gaps.some(text => text.length > 768) ||
    Boolean(copy.teamWrapper && copy.teamWrapper.length > 1024);
  copy.gaps = copy.gaps.slice(0, 32).map(clippedDiagnostic);
  if (copy.teamWrapper && copy.teamWrapper.length > 1024) copy.teamWrapper = copy.teamWrapper.slice(0, 1024) + "\n[clipped]";
  if (diagnosticsClipped) copy.gaps.push("Terminal storage diagnostics/Team wrapper clipped; this is not complete transcript evidence.");
  retained.state = "ready";
  retained.reason = undefined;
  retained.snapshot = copy;
  let omittedEvents = Math.max(0, copy.activity.length - 200);
  let omittedReceipts = Math.max(0, copy.interactions.length - 200);
  copy.activity = copy.activity.slice(-200);
  copy.interactions = copy.interactions.slice(-200);
  const gaps = [...copy.gaps];
  const countBytes = () => {
    copy.gaps = [...gaps, ...(omittedEvents || omittedReceipts
      ? [`Terminal storage omitted ${omittedEvents} events and ${omittedReceipts} receipts; bounded tails only.`] : [])];
    copy.dropped = snapshot.dropped + omittedEvents;
    copy.interactionsDropped = snapshot.interactionsDropped + omittedReceipts;
    // Include identity, diagnostics, epoch and the byte counter itself (symbols serialize no bytes).
    let bytes = Buffer.byteLength(JSON.stringify(retained));
    while (bytes !== retained.bytes) {
      retained.bytes = bytes;
      bytes = Buffer.byteLength(JSON.stringify(retained));
    }
    return bytes;
  };
  let bytes = countBytes();
  while (bytes > 65536) {
    if (copy.activity.length || copy.interactions.length) {
      // Remove oldest records deterministically. Recount the complete envelope after
      // a batch, rather than serializing a large ring after every individual removal.
      let removedBytes = 0;
      const excess = bytes - 65536;
      do {
        if (copy.activity.length && copy.activity.length >= copy.interactions.length) {
          const record = copy.activity.shift()!;
          omittedEvents++;
          removedBytes += Buffer.byteLength(JSON.stringify(record)) + (copy.activity.length ? 1 : 0);
        } else {
          const record = copy.interactions.shift()!;
          omittedReceipts++;
          removedBytes += Buffer.byteLength(JSON.stringify(record)) + (copy.interactions.length ? 1 : 0);
        }
      } while (removedBytes < excess && (copy.activity.length || copy.interactions.length));
    } else if (gaps.length > 1) {
      gaps.pop();
      gaps[0] = "Terminal storage diagnostics omitted to fit the payload budget.";
    } else if (copy.teamWrapper) {
      copy.teamWrapper = undefined;
      gaps[0] = "Terminal storage Team wrapper/diagnostics omitted to fit the payload budget.";
    } else {
      noteTerminalActivityUnavailable(key, "snapshot_oversized", epoch);
      return;
    }
    bytes = countBytes();
  }
  state.retained.set(key.instanceId, retained.bytes);
  state.retainedBytes += retained.bytes;
  while (state.retained.size > 128 || state.retainedBytes > 8388608) {
    const id = state.retained.keys().next().value!;
    discardPayload(state, id);
    state.activity.get(id)!.state = "evicted";
    touchObservation(id, epoch);
  }
  touchObservation(key.instanceId, epoch);
}

export function readTerminalActivity(key: TerminalActivityKey, options?: ActivityReadOptions): TerminalActivityRead {
  const state = observations();
  const retained = currentActivity(state, key);
  if (!retained) return { state: "stale_reference" };
  const row = state.rows.get(key.instanceId)!;
  if (row.origin?.source === "agent_run") return { state: "unavailable", reason: "unsupported_kind" };
  if (retained.state === "evicted") return { state: "evicted" };
  if (retained.state === "stale_reference") return { state: "stale_reference" };
  if (!retained.snapshot) return { state: "unavailable", reason: retained.reason ?? "not_captured" };
  const original = row.origin?.workbrief;
  try {
    return { state: "ready", page: readActivitySnapshot(retained.snapshot, original ?? row.task, options,
      original === undefined ? "invocation task" : "original WorkBrief") };
  } catch (error) {
    return error instanceof Error && error.message === "invalid observation cursor"
      ? { state: "invalid_cursor" } : { state: "unavailable", reason: "snapshot_oversized" };
  }
}

/** Synchronous retirement fence. It lasts only as long as the ordinary row. */
export function removeOwnerTerminalActivity(ownerToken: symbol): void {
  const state = observations();
  for (const [id, retained] of state.activity) {
    if (retained.key.ownerToken !== ownerToken) continue;
    discardPayload(state, id);
    retained.retired = true;
    retained.state = "unavailable";
    retained.reason = "not_captured";
  }
}

function notify(): void {
  for (const listener of observations().listeners) {
    try {
      listener();
    } catch {
      // Observation listeners must not change run behavior.
    }
  }
}

/** Apply Model.name at render time. No hardcoded aliases. */
export function labelModels(rows: readonly AgentUiSnapshot[], lookup?: ModelLookup): AgentUiSnapshot[] {
  if (!lookup) return rows.map((row) => ({ ...row }));
  return rows.map((row) => {
    const slash = row.selectedModel.indexOf("/");
    if (slash < 0) return { ...row };
    const provider = row.selectedModel.slice(0, slash);
    const id = row.selectedModel.slice(slash + 1);
    const found = lookup(provider, id);
    const name = found?.name;
    if (typeof name === "string" && name.length > 0 && name !== id) {
      return { ...row, modelLabel: name };
    }
    return { ...row };
  });
}

function footerWidth(columns: number | undefined): number {
  const base = typeof columns === "number" && columns > 0 ? columns : 80;
  return Math.max(24, base - 16);
}

function defaultScheduler(): AgentUiScheduler {
  return {
    setInterval: (fn, ms) => {
      const handle = setInterval(fn, ms) as ReturnType<typeof setInterval> & { unref?: () => void };
      handle.unref?.();
      return handle;
    },
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
}

/**
 * Bind footer to observations. Stops any previous binder first.
 * One 1 Hz clock only while a running worker exists.
 */
export function bindAgentUi(options: BindAgentUiOptions): symbol {
  const prev = (globalThis as Record<symbol, AgentUiSlot | undefined>)[AGENT_UI];
  prev?.unbind();

  const setStatus = options.setStatus;
  const nowFn = options.now ?? Date.now;
  const columnsFn = options.columns ?? (() => process.stdout.columns);
  const scheduler = options.scheduler ?? defaultScheduler();
  const lookup = options.modelLookup;

  let timer: { unref?: () => void } | undefined;
  let linger: { unref?: () => void } | undefined;
  let unsub: (() => void) | undefined;
  let alive = true;
  const setTimeoutFn = scheduler.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = scheduler.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const stopTimer = () => {
    if (!timer) return;
    scheduler.clearInterval(timer);
    timer = undefined;
  };
  const stopLinger = () => {
    if (!linger) return;
    clearTimeoutFn(linger);
    linger = undefined;
  };

  const render = () => {
    if (!alive) return;
    const now = nowFn();
    let labeled: AgentUiSnapshot[] = [];
    try {
      labeled = labelModels(options.ownerToken && !options.coordinatorSessionId ? []
        : listObservations(options.ownerToken, options.coordinatorSessionId), lookup);
    } catch {
      labeled = options.ownerToken && !options.coordinatorSessionId ? []
        : listObservations(options.ownerToken, options.coordinatorSessionId);
    }
    let text = "";
    try {
      text = formatFooter(labeled, now, footerWidth(columnsFn()));
    } catch {
      text = "";
    }
    try {
      setStatus(STATUS_KEY, text === "" ? undefined : text);
    } catch {
      // setStatus must not break observation publish
    }
    const running = labeled.some((row) => row.status === "running");
    if (running) {
      stopLinger();
      if (!timer) {
        timer = scheduler.setInterval(() => {
          render();
        }, 1000);
      }
    } else {
      stopTimer();
      stopLinger();
      const wait = nextFooterRefreshMs(labeled, now);
      if (wait !== undefined) {
        linger = setTimeoutFn(() => {
          linger = undefined;
          render();
        }, wait);
        linger.unref?.();
      }
    }
  };

  const token = Symbol("pitako.agentUiBinding");
  const unbind = () => {
    if (!alive) return;
    alive = false;
    stopTimer();
    stopLinger();
    unsub?.();
    unsub = undefined;
    try {
      setStatus(STATUS_KEY, undefined);
    } catch {
      // ignore
    }
    const host = globalThis as Record<symbol, AgentUiSlot | (() => void) | undefined>;
    if ((host[AGENT_UI] as AgentUiSlot | undefined)?.unbind === unbind) {
      delete host[AGENT_UI];
    }
  };

  unsub = subscribe(() => {
    try {
      render();
    } catch {
      // swallow listener errors
    }
  });

  const slot: AgentUiSlot = { token, unbind };
  (globalThis as Record<symbol, AgentUiSlot | undefined>)[AGENT_UI] = slot;
  render();
  return token;
}

export function unbindAgentUi(token?: symbol): void {
  const slot = (globalThis as Record<symbol, AgentUiSlot | undefined>)[AGENT_UI];
  if (token === undefined || slot?.token === token) slot?.unbind();
}
