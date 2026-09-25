import { AsyncLocalStorage } from "node:async_hooks";

/** Set while an AgentInstance session is being created or run. Not an env var. */
export const agentScope = new AsyncLocalStorage<{ instanceId: string; roleId?: string }>();

export function currentInstanceId(): string | undefined {
  return agentScope.getStore()?.instanceId;
}

export function currentRoleId(): string | undefined {
  return agentScope.getStore()?.roleId;
}
