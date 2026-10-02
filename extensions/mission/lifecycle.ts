interface RetirableMissionOwner {
  cancelAttempt(attemptId: string): boolean;
  retireForShutdown(reason: string): Promise<void>;
}

interface RegisteredOwner {
  missionId: string;
  owner: RetirableMissionOwner;
}

const owners = new Map<string, Set<RegisteredOwner>>();

export function registerMissionOwner(sessionId: string, missionId: string, owner: RetirableMissionOwner): () => void {
  if (!sessionId) throw new Error("mission owner session id is required");
  const current = owners.get(sessionId) ?? new Set<RegisteredOwner>();
  const registration = { missionId, owner };
  current.add(registration);
  owners.set(sessionId, current);
  return () => {
    current.delete(registration);
    if (current.size === 0) owners.delete(sessionId);
  };
}

export function cancelManagedMissionAttempt(missionId: string, attemptId: string): boolean {
  for (const current of owners.values()) {
    for (const { missionId: ownerMissionId, owner } of current) {
      if (ownerMissionId === missionId) return owner.cancelAttempt(attemptId);
    }
  }
  return false;
}

export async function shutdownManagedMissions(sessionId: string | undefined, reason: string): Promise<boolean> {
  if (!sessionId) return false;
  const current = owners.get(sessionId);
  if (!current?.size) return false;
  for (const { owner } of [...current]) await owner.retireForShutdown(reason);
  return true;
}
