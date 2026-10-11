import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import codexTools from "../node_modules/pi-codex-tools/index.ts";

type SessionStartHook = (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>;

/** Compose official startup after foreground revocation; forward all other registrations. */
export function registerCodexTools(pi: ExtensionAPI): SessionStartHook {
  const startup: Array<{ handler: SessionStartHook }> = [];
  codexTools(new Proxy(pi, {
    get(target, property) {
      if (property === "on") {
        return (event: string, handler: SessionStartHook) => {
          if (event !== "session_start") return Reflect.apply(target.on, target, [event, handler]);
          const registration = { handler };
          startup.push(registration);
          return () => {
            const index = startup.indexOf(registration);
            if (index !== -1) startup.splice(index, 1);
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }));
  return async (event, ctx) => {
    for (const { handler } of [...startup]) await handler(event, ctx);
  };
}
