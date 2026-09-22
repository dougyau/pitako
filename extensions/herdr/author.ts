import { registerExecution, unregisterExecution } from "../execution-identity.ts";
import { readHerdrPresence } from "./presence.ts";

let capturedSessionId: string | undefined;

/** Register only a supervised child inside Herdr. Foreground and outside-Herdr stay unregistered. */
export function registerSupervisedSession(
  sessionId: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const instanceId = env.PITAKO_INSTANCE_ID;
  const roleId = env.PITAKO_ROLE_ID;
  if (!instanceId || !roleId || !sessionId || !readHerdrPresence(env).present) return;
  registerExecution({ instanceId, roleId, sessionId });
  capturedSessionId = sessionId;
}

export function unregisterSupervisedSession(): void {
  if (!capturedSessionId) return;
  const sessionId = capturedSessionId;
  capturedSessionId = undefined;
  unregisterExecution(sessionId);
}
