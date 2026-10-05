import type { ChildProcess } from "node:child_process";
import { writeSync } from "node:fs";

// Only the crash callback can release ownership; Bun teardown cannot drain it.
export function workspaceCrashOwnership(directories: string[]) {
  let released = true;
  let label = "";
  let cleanupErrors: unknown[] = [];
  let cleanups: Array<() => unknown> = [];

  function requireReleased() {
    if (released) return;
    writeSync(2, `WORKSPACE CRASH FAIL-STOP: ${JSON.stringify({
      case: label, retainedDirectories: directories, errors: cleanupErrors.map(String),
    })}\n`);
    process.exit(1);
  }

  function observeChild(child: ChildProcess) {
    let spawnError: Error | undefined;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    // Observation is installed immediately; callers may not await until later.
    void spawned.catch(() => {});
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", (error) => { spawnError = error; });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    cleanups.push(async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    });
    const result = async () => {
      const result = await closed;
      if (spawnError) throw spawnError;
      return result;
    };
    return { spawned, closed: result, settled: closed };
  }

  function ownedCase(name: string, body: () => Promise<void>) {
    return async () => {
      requireReleased();
      released = false;
      label = name;
      cleanups = [];
      cleanupErrors = [];
      const errors: unknown[] = [];
      try { await body(); } catch (error) { errors.push(error); }
      // Independent resource cleanup still runs if child settlement or store close fails.
      const results = await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()));
      for (const result of results) if (result.status === "rejected") cleanupErrors.push(result.reason);
      if (cleanupErrors.length) {
        throw new AggregateError([...errors, ...cleanupErrors], "Workspace crash release is uncertain");
      }
      released = true;
      if (errors.length) throw new AggregateError(errors, "Workspace crash callback failed");
    };
  }

  return { requireReleased, observeChild, ownedCase, cleanup: (close: () => unknown) => cleanups.push(close) };
}
