import { sessionNameAction } from "./session-name.ts";

type Event = "session_start" | "before_agent_start";
type HookEvent = { prompt?: string; entries?: readonly unknown[] };

export interface PitakoExtensionAPI {
  on(event: Event, handler: (event: HookEvent) => void): void;
  registerCommand(name: string, definition: { handler: (args: string) => void }): void;
  getSessionName(): string | undefined;
  setSessionName(name: string): void;
}

export default function registerPitako(pi: PitakoExtensionAPI): void {
  let profile = "coding";

  const assignDefaultName = () => {
    const action = sessionNameAction({ current: pi.getSessionName() });
    if (action.set !== undefined) pi.setSessionName(action.set);
  };

  pi.on("session_start", assignDefaultName);
  pi.on("before_agent_start", assignDefaultName);
  pi.registerCommand("pitako", {
    handler(args) {
      const [command, value] = args.trim().split(/\s+/, 2);
      if (command !== "profile" || (value !== "coding" && value !== "analysis")) return;
      profile = value;
      pi.setSessionName(`pitako:${profile}`);
    },
  });
}
