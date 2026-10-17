import { assertNoExclusive, reserveOperation } from "./operation-leases.ts";
export function assertNoCheckpointLease(root: string): void { assertNoExclusive(root); }
export function acquireCheckpointLease(root: string): () => void {
  const lease = reserveOperation(root, "checkpoint");
  return () => lease.release();
}
