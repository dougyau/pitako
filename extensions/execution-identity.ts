/** Process-shared so separately loaded extension copies see the same map. */
const REGISTRY_KEY = Symbol.for("pitako.executionIdentity");

export interface ExecutionIdentity {
  instanceId: string;
  roleId: string;
  sessionId: string;
}

interface IdentityRegistry {
  bySession: Map<string, ExecutionIdentity>;
}

function registry(): IdentityRegistry {
  const host = globalThis as Record<symbol, IdentityRegistry | undefined>;
  const existing = host[REGISTRY_KEY];
  if (existing) return existing;
  const created: IdentityRegistry = { bySession: new Map() };
  host[REGISTRY_KEY] = created;
  return created;
}

export function registerExecution(identity: ExecutionIdentity): void {
  registry().bySession.set(identity.sessionId, identity);
}

export function unregisterExecution(sessionId: string): void {
  registry().bySession.delete(sessionId);
}

export function executionForSession(sessionId: string | undefined): ExecutionIdentity | undefined {
  if (!sessionId) return undefined;
  return registry().bySession.get(sessionId);
}

/** Foreground sessions have no registration and stay "pi". */
export function resolveBoardAuthor(sessionId: string | undefined): string {
  return executionForSession(sessionId)?.instanceId ?? "pi";
}
