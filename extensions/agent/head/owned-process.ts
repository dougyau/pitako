import type { ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { AgentClosureError, hasUnknownClosure, joinedClosureObservation, type ClosureObservation } from "../closure.ts";

/** The physical owner outlives an unknown result; adapters must not dispose its handles. */
export function ownProcess(child: ChildProcess, options: {
  onData(bytes: Buffer, stream: number): unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}, host = {
  kill: (pid: number, signal: NodeJS.Signals | 0): boolean => process.kill(pid, signal),
  schedule: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}) {
  let closed = false, reported = false, cancelling = false, exitCode: number | null = null;
  const failures: unknown[] = [];
  let timedOut = false;
  const callbacks = new Set<Promise<unknown>>();
  const streams = [child.stdout, child.stderr].filter(stream => stream !== null);
  const streamClosed = new Set(streams.filter(stream => stream.closed));
  let poll: ReturnType<typeof setTimeout> | undefined, kill: typeof poll, deadline: typeof poll, timeout: typeof poll;
  const groupClosed = () => {
    if (process.platform === "win32" || !child.pid) return closed;
    try { host.kill(-child.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  const localClosed = () => closed && streamClosed.size === streams.length && callbacks.size === 0;
  const observation: ClosureObservation = { observe: () => {
    if (!localClosed() || poll || kill || deadline || timeout || !groupClosed()) return "unknown";
    // An accepted callback can reveal a separate uncertain resource even after report.
    const uncertainties = failures.filter(hasUnknownClosure);
    return !uncertainties.length || joinedClosureObservation(uncertainties)?.observe() === "closed" ? "closed" : "unknown";
  } };
  const outcome = Promise.withResolvers<{ exitCode: number | null }>();
  const clearTimers = () => {
    for (const timer of [poll, kill, deadline, timeout]) if (timer !== undefined) host.clear(timer);
    poll = kill = deadline = timeout = undefined;
    options.signal?.removeEventListener("abort", cancel);
  };
  const finish = (unknown = false) => {
    if (reported) return;
    reported = true;
    clearTimers();
    if (unknown) outcome.reject(new AgentClosureError(
      failures.length ? [...failures] : [new Error("owned process group closure unknown")], "owned process", observation));
    else if (failures.length) outcome.reject(failures.length === 1 ? failures[0] :
      failures.some(hasUnknownClosure) ? new AgentClosureError(failures, "owned process callbacks", joinedClosureObservation(failures)) :
        new AggregateError(failures, "owned process failed"));
    else if (options.signal?.aborted) outcome.reject(new Error("aborted"));
    else if (timedOut) outcome.reject(new Error(`timeout:${options.timeoutMs! / 1000}`));
    else outcome.resolve({ exitCode });
  };
  const signal = (value: NodeJS.Signals) => {
    try {
      if (child.pid && process.platform !== "win32") host.kill(-child.pid, value);
      else child.kill(value);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(error); }
  };
  const schedulePoll = () => {
    if (reported || poll !== undefined) return;
    poll = host.schedule(() => {
      poll = undefined;
      if (reported) return;
      const absent = groupClosed();
      if (localClosed() && absent) { finish(); return; }
      if (!cancelling) {
        if (absent) return; // Local callbacks/streams will notify their own settlement.
        failures.push(new Error("owned process group remained after close"));
        cancel();
      } else schedulePoll();
    }, 25);
  };
  function cancel() {
    if (reported || cancelling) return;
    cancelling = true;
    if (timeout !== undefined) host.clear(timeout);
    timeout = undefined;
    kill = host.schedule(() => { kill = undefined; if (!reported) signal("SIGKILL"); }, 250);
    deadline = host.schedule(() => { deadline = undefined; finish(true); }, 1500);
    signal("SIGTERM");
    schedulePoll();
  }
  const check = () => {
    if (reported) return;
    if (!closed) return;
    if (!groupClosed()) schedulePoll();
    else if (localClosed()) finish();
  };
  const data = (bytes: Buffer, stream: number) => {
    if (reported) return; // Keep draining, but never call an adapter after reporting.
    try {
      const callback = Promise.resolve(options.onData(bytes, stream));
      callbacks.add(callback);
      void callback.then(() => { callbacks.delete(callback); check(); }, error => {
        callbacks.delete(callback); failures.push(error); cancel(); check();
      });
    } catch (error) { failures.push(error); cancel(); }
  };
  for (const [index, stream] of [child.stdout, child.stderr].entries()) {
    if (!stream) continue;
    stream.on("data", (bytes: Buffer) => data(bytes, index));
    stream.on("error", error => { if (!reported) failures.push(error); cancel(); });
    stream.once("close", () => { streamClosed.add(stream); check(); });
  }
  child.on("error", error => { if (!reported) failures.push(error); cancel(); });
  child.once("close", (code, signal) => {
    closed = true;
    exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : null);
    check();
  });
  if (options.timeoutMs !== undefined) timeout = host.schedule(() => { timedOut = true; cancel(); }, options.timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  return outcome.promise;
}
