import type { createAgentController } from "../../agent/controller.ts";
import type { HerdrPresence } from "../presence.ts";
import { createAgentBroker, type PaneGrants } from "./broker.ts";
import { openAgentPane, type AgentPane } from "./launcher.ts";

/** Owned by one foreground controller; every late launch is joined using its returned panel ID. */
export function createPaneSession(controller: ReturnType<typeof createAgentController>,
  presence: HerdrPresence, cwd: string, env?: NodeJS.ProcessEnv) {
  let retired = false, generation = 0;
  let broker: Awaited<ReturnType<typeof createAgentBroker>> | undefined;
  let pane: AgentPane | undefined, grants: PaneGrants | undefined;
  let operation: Promise<unknown> | undefined;
  const cleanup = async () => {
    broker?.revoke();
    // A failed Herdr close retains the private runtime for diagnosis. Never rediscover another panel.
    await pane?.close();
    pane = undefined;
    await broker?.close();
    broker = undefined; grants = undefined;
  };
  const own = <T>(work: () => Promise<T>) => {
    if (operation) throw new Error("Agent pane launch/focus/close is outstanding; wait for settlement");
    const accepted = work();
    operation = accepted;
    accepted.then(() => { if (operation === accepted) operation = undefined; },
      () => { if (operation === accepted) operation = undefined; });
    return accepted;
  };
  return {
    launch(requested: PaneGrants) {
      if (retired) throw new Error("Agent pane owner is retired");
      if (!presence.present || !presence.socketPath || !presence.paneId)
        throw new Error("Agent pane requires a running Herdr caller; no auto-start or install");
      return own(async () => {
        if (pane) {
          if (grants?.control !== requested.control || grants.rawHistory !== requested.rawHistory)
            throw new Error("Agent pane access flags changed; explicitly close and reopen");
          await pane.focus(); return pane.paneId;
        }
        const admitted = generation;
        grants = { ...requested };
        try {
          broker = await createAgentBroker(controller, grants);
          if (retired || generation !== admitted) { await cleanup(); return null; }
          pane = await openAgentPane({ presence, descriptorPath: broker.descriptorPath, cwd, env });
          if (retired || generation !== admitted) { await cleanup(); return null; }
          return pane.paneId;
        } catch (error) { await cleanup(); throw error; }
      });
    },
    revoke() { retired = true; ++generation; broker?.revoke(); },
    async close() {
      ++generation; broker?.revoke();
      await operation?.catch(() => {});
      await own(cleanup);
    },
  };
}
