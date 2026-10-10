import { registerExecution, unregisterExecution } from "../execution-identity.ts";
import { readHerdrPresence } from "./presence.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

let capturedSessionId: string | undefined;

/** Register only a supervised child inside Herdr. Foreground and outside-Herdr stay unregistered. */
export function registerSupervisedSession(
  sessionId: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  pi?: Pick<ExtensionAPI, "appendEntry" | "getThinkingLevel">,
  model?: ExtensionContext["model"],
): void {
  const instanceId = env.PITAKO_INSTANCE_ID;
  const roleId = env.PITAKO_ROLE_ID;
  if (!instanceId || !roleId || !sessionId || !readHerdrPresence(env).present) return;
  registerExecution({ instanceId, roleId, sessionId });
  capturedSessionId = sessionId;
  if (pi && env.PITAKO_DISPATCH_ID && env.PITAKO_NATIVE_SESSION_ID === sessionId) {
    pi.appendEntry("pitako.supervised-origin", {
      version: 1, dispatchId: env.PITAKO_DISPATCH_ID, instanceId, roleId, sessionId,
      profile: env.PITAKO_DEVELOPER_PROFILE,
      model: model ? { provider: model.provider, id: model.id } : undefined, reasoning: pi.getThinkingLevel(),
    });
  }
}

export function unregisterSupervisedSession(): void {
  if (!capturedSessionId) return;
  const sessionId = capturedSessionId;
  capturedSessionId = undefined;
  unregisterExecution(sessionId);
}
