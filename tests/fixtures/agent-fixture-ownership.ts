import { spyOn } from "bun:test";
import * as agentRun from "../../extensions/agent/run.ts";
import { cancelAllWorkers } from "../../extensions/agent/background.ts";
import { PitakoConfigError } from "../../extensions/errors.ts";
import { providerFixtureOwnership } from "./provider-fixture-ownership.ts";

// Background cancellation changes status before runAgentInstance's callback
// settles. Track that actual promise; fake executor gates must also be released.
export function agentFixtureOwnership(options: { deferDirectories?: boolean } = {}) {
  const fixture = providerFixtureOwnership(options);
  const run = agentRun.runAgentInstance;
  let finishers: Array<() => void> = [];
  let controllers: AbortController[] = [];
  let runs: Promise<unknown>[] = [];
  return {
    ...fixture,
    async settleRuns() { await Promise.all(runs); },
    finishOnCleanup(finish: () => void) { finishers.push(finish); },
    pendingAttempt(register: (finish: (attempt: agentRun.Attempt) => void) => void) {
      return new Promise<agentRun.Attempt>((resolve) => {
        finishers.push(() => resolve({ status: "cancelled", result: "fixture cleanup", sideEffects: false }));
        register(resolve);
      });
    },
    ownedCase(name: string, body: () => void | Promise<void>) {
      return async () => {
        const tracking = spyOn(agentRun, "runAgentInstance").mockImplementation((input) => {
          const controller = new AbortController();
          controllers.push(controller);
          const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
          let accepted = false;
          let acceptError: unknown;
          const pending = run({ ...input, signal, onAccepted(instance) {
            try { input.onAccepted?.(instance); } catch (error) { acceptError = error; throw error; }
            accepted = true;
          } });
          // Validation or the synchronous accept hook rejects before any SDK owner.
          // Preserve that rejection for the caller's negative-path assertions.
          const tracked = fixture.run(pending.catch((error) => {
            if (!accepted && (error instanceof PitakoConfigError || error === acceptError)) return;
            throw error;
          }));
          runs.push(tracked);
          void tracked.catch(() => {});
          return pending;
        });
        try {
          await fixture.ownedCase(name, async () => {
            finishers = [];
            controllers = [];
            runs = [];
            fixture.beforeRelease(async () => {
              const retirement = cancelAllWorkers();
              for (const controller of controllers) controller.abort();
              for (const finish of finishers) finish();
              await retirement;
            });
            await body();
          })();
        } finally {
          fixture.requireReleasedFixture();
          tracking.mockRestore();
        }
      };
    },
  };
}
