import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const KEY = Symbol.for("pitako.pendingDispatches");
const CLOSING = Symbol.for("pitako.settlingDispatchSessions");
type Pending = Map<AbortController, { sessionId: string | undefined; operation: Promise<unknown> }>;
function pending(): Pending {
  const host = globalThis as Record<symbol, Pending | undefined>;
  return host[KEY] ??= new Map();
}
function closing(): Map<string | undefined, number> {
  const host = globalThis as Record<symbol, Map<string | undefined, number> | undefined>;
  return host[CLOSING] ??= new Map();
}

/** Transitions wait for the actual admission work, including callbacks and rollback. */
export async function settlePendingDispatches(sessionId?: string): Promise<void> {
  closing().set(sessionId, (closing().get(sessionId) ?? 0) + 1);
  try {
    for (;;) {
      const work = [...pending()].filter(([, work]) => sessionId === undefined || work.sessionId === sessionId);
      if (!work.length) return;
      for (const [controller] of work) controller.abort();
      await Promise.allSettled(work.map(([, work]) => work.operation));
    }
  } finally {
    const remaining = closing().get(sessionId)! - 1;
    if (remaining) closing().set(sessionId, remaining);
    else closing().delete(sessionId);
  }
}

export function ownedDispatch<T>(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  owns: () => boolean,
  run: (signal: AbortSignal, check: () => void) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  ctx.signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted || ctx.signal?.aborted || closing().has(undefined) || closing().has(sessionId)) abort();
  const check = () => {
    if (controller.signal.aborted || closing().has(undefined) || closing().has(sessionId) || !owns() ||
      ctx.sessionManager?.getSessionId?.() !== sessionId ||
      ctx.sessionManager?.getSessionFile?.() !== sessionFile) {
      controller.abort();
      throw new Error("Dispatch cancelled before admission");
    }
  };
  const operation = Promise.resolve().then(() => run(controller.signal, check)).finally(() => {
    pending().delete(controller);
    signal?.removeEventListener("abort", abort);
    ctx.signal?.removeEventListener("abort", abort);
  });
  pending().set(controller, { sessionId, operation });
  return operation;
}
