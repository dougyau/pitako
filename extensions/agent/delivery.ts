/** Receipt comparison is pure. Channel-specific callers retain all lifecycle effects. */
export function receiptInBranch(message: { customType: string; content: string; details: { deliveryId: string } }, branch: readonly unknown[]): boolean {
  return branch.some(entry => {
    if (!entry || typeof entry !== "object") return false;
    const value = entry as { type?: unknown; customType?: unknown; content?: unknown; details?: { deliveryId?: unknown } };
    return value.type === "custom_message" && value.customType === message.customType &&
      value.details?.deliveryId === message.details.deliveryId && value.content === message.content;
  });
}
export function offerEnvelope<T>(state: { deliveryAttempts: number; delivery: string; outstanding: boolean; deliveryDiagnostic?: string }, message: T): T {
  ++state.deliveryAttempts;
  state.delivery = "offered";
  state.outstanding = true;
  state.deliveryDiagnostic = "commitment not yet observed";
  return message;
}

export interface RecoveryScheduler {
  /** Immediate in production; controlled hosts can suppress a lost ready notification. */
  notifyReady?(callback: () => void): void;
  schedule(callback: () => void, delayMs: number): { unref(): void };
  cancel(handle: { unref(): void }): void;
}
const scheduler: RecoveryScheduler = {
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One captured owner's backstop, not a second producer or a prompt scheduler. */
export class OwnerRecovery {
  private timer?: { unref(): void };
  private retired = false;
  diagnostic?: string;
  constructor(private pending: () => boolean, private recover: () => void,
    private clock: RecoveryScheduler = scheduler) {}

  ready(callback: () => void): void {
    const run = () => { if (!this.retired && this.pending()) callback(); };
    try { if (this.clock.notifyReady) this.clock.notifyReady(run); else run(); }
    finally { this.refresh(); }
  }
  refresh(): void {
    let pending = false;
    try { pending = !this.retired && this.pending(); }
    catch (error) { this.retired = true; this.diagnostic = `captured recovery owner unavailable: ${String(error)}`; }
    if (!pending) {
      if (this.timer) this.clock.cancel(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer) return;
    this.timer = this.clock.schedule(() => {
      this.timer = undefined;
      if (this.retired) return;
      try { if (this.pending()) this.recover(); }
      catch (error) { this.retired = true; this.diagnostic = `recovery callback fenced: ${String(error)}`; }
      finally { this.refresh(); }
    }, 15_000);
    this.timer.unref();
  }
  close(): void { this.retired = true; this.refresh(); }
}

export interface DeliveryProgress {
  delivery: string;
  continuation: string;
  deliveryAttempts: number;
  wakeAttempts: number;
  outstanding: boolean;
  busyContinuation: boolean;
  deliveryDiagnostic?: string;
  continuationDiagnostic?: string;
}
export function recoveryPending(state: DeliveryProgress): boolean {
  if (state.continuation === "observed") return false;
  if (state.delivery !== "incorporated") {
    if (state.deliveryAttempts >= 2 && !state.outstanding) {
      state.deliveryDiagnostic = "delivery exhausted after two total offers; commitment unconfirmed";
      return false;
    }
    return true;
  }
  if (state.busyContinuation) return state.continuation !== "blocked-unconfirmed";
  if (state.wakeAttempts >= 2) {
    state.continuationDiagnostic = "continuation exhausted after two total wake requests; owning turn unconfirmed";
    return false;
  }
  return true;
}
