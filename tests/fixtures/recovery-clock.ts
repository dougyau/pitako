import type { RecoveryScheduler } from "../../extensions/agent/delivery.ts";

/** Private captured callbacks: no real clock, process timer or global replacement. */
export function recoveryClock(options: { suppressReady?: boolean } = {}) {
  const callbacks = new Map<{ unref(): void }, () => void>();
  const delays: number[] = [];
  let unrefs = 0;
  const scheduler: RecoveryScheduler = {
    notifyReady(callback) { if (!options.suppressReady) callback(); },
    schedule(callback, delay) {
      delays.push(delay);
      const handle = { unref() { unrefs++; } };
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) { callbacks.delete(handle); },
  };
  const take = () => {
    const entry = callbacks.entries().next().value;
    if (!entry) throw new Error("no owned recovery timer");
    callbacks.delete(entry[0]);
    return entry[1];
  };
  return { scheduler, delays, get unrefs() { return unrefs; }, get pending() { return callbacks.size; },
    take, fire() { take()(); } };
}
