/** In-memory observation copy for display, plus footer binder/clock (T3). */

import { formatFooter, nextFooterRefreshMs, type AgentUiSnapshot } from "./ui.ts";

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
  epoch: number;
}

function observations(): ObservationState {
  const host = globalThis as Record<symbol, ObservationState | undefined>;
  const existing = host[OBSERVATIONS];
  if (existing) return existing;
  const created: ObservationState = { rows: new Map(), listeners: new Set(), epoch: 0 };
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
};

type AgentUiSlot = {
  unbind: () => void;
};

export function publishObservation(row: AgentUiSnapshot, epoch = observationEpoch()): void {
  const state = observations();
  if (epoch !== state.epoch) return;
  state.rows.set(row.id, { ...row });
  notify();
}

export function noteResultTaken(id: string): void {
  const state = observations();
  const row = state.rows.get(id);
  if (!row || row.resultTaken) return;
  state.rows.set(id, { ...row, resultTaken: true });
  notify();
}

export function listObservations(): AgentUiSnapshot[] {
  return [...observations().rows.values()];
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
  state.rows.clear();
  state.epoch += 1;
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
export function bindAgentUi(options: BindAgentUiOptions): { unbind: () => void } {
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
      labeled = labelModels(listObservations(), lookup);
    } catch {
      labeled = listObservations();
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

  const slot: AgentUiSlot = { unbind };
  (globalThis as Record<symbol, AgentUiSlot | undefined>)[AGENT_UI] = slot;
  render();
  return slot;
}

export function unbindAgentUi(): void {
  const slot = (globalThis as Record<symbol, AgentUiSlot | undefined>)[AGENT_UI];
  slot?.unbind();
}
