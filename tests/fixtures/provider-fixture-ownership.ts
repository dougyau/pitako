import { rmSync, writeSync } from "node:fs";

// Test-only ownership: a runner timeout cannot safely cancel SDK initialization.
export function providerFixtureOwnership() {
  const directories: string[] = [];
  let released = true;
  let label = "";
  let unsafeErrors: unknown[] = [];
  let starts: Promise<unknown>[] = [];
  let disposals: Array<() => unknown> = [];

  function requireReleasedFixture() {
    if (released) return;
    const diagnostic = JSON.stringify({
      case: label,
      retainedDirectories: directories,
      errors: unsafeErrors.map((error) => String(error)),
    }).slice(0, 16_384);
    writeSync(2, `PROVIDER FIXTURE FAIL-STOP: unreleased callback or uncertain disposal; ${diagnostic}\n`);
    process.exit(1);
  }

  function acquire<T extends { session?: { dispose(): unknown } }>(pending: Promise<T>): Promise<T> {
    // Register before the caller awaits, including both simultaneous starts.
    const tracked = pending.then((result) => {
      if (result.session) disposals.push(() => result.session!.dispose());
      return result;
    });
    starts.push(tracked);
    return tracked;
  }

  async function run<T>(pending: Promise<T>): Promise<T> {
    // runAgentInstance owns its sessions. A rejection may include failed disposal.
    try {
      return await pending;
    } catch (error) {
      unsafeErrors.push(error);
      throw error;
    }
  }

  function ownedCase(name: string, body: () => Promise<void>): () => Promise<void> {
    return async () => {
      requireReleasedFixture();
      released = false;
      label = name;
      unsafeErrors = [];
      starts = [];
      disposals = [];
      const globals = ["fetch", "WebSocket", "setTimeout", "__pitakoLateProvider", "__pitakoTelemetryProvider", "__pitakoPayloadInputs"];
      const descriptors = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
      const agentDir = process.env.PI_CODING_AGENT_DIR;
      const errors: unknown[] = [];
      try {
        await body();
      } catch (error) {
        errors.push(error);
      }
      // This is callback cleanup, not an asynchronous teardown/drain hook.
      const acquisitions = await Promise.allSettled(starts);
      for (const result of acquisitions) {
        if (result.status === "rejected" && !errors.includes(result.reason)) errors.push(result.reason);
      }
      const cleanup = await Promise.allSettled(disposals.map(async (dispose) => dispose()));
      for (const result of cleanup) {
        if (result.status === "rejected") unsafeErrors.push(result.reason);
      }
      if (unsafeErrors.length) {
        throw new AggregateError([...errors, ...unsafeErrors], "Provider fixture release is uncertain");
      }
      // Nothing below runs while a start, callback, or disposal is still pending.
      globals.forEach((key, index) => {
        const descriptor = descriptors[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      });
      if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = agentDir;
      for (const dir of directories) rmSync(dir, { recursive: true, force: true });
      directories.length = 0;
      released = true;
      if (errors.length) throw new AggregateError(errors, "Provider fixture callback failed");
    };
  }

  return { directories, requireReleasedFixture, acquire, run, ownedCase };
}
