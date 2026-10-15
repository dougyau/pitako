const KEY = Symbol.for("pitako.head.checkpointLeases");
function leases(): Set<string> {
  const host = globalThis as Record<symbol, Set<string> | undefined>;
  host[KEY] ??= new Set();
  return host[KEY];
}
export function assertNoCheckpointLease(root: string): void {
  if (leases().has(root)) throw new Error("exclusive checkpoint lease is occupied");
}
export function acquireCheckpointLease(root: string): () => void {
  assertNoCheckpointLease(root);
  leases().add(root);
  return () => { leases().delete(root); };
}
