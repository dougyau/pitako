import { assertNoExclusive, reserveOperation } from "./operation-leases.ts";
import { captureCallContext, checkCallContext } from "../../workflow-engine.ts";
/** Lifecycle-only callers own no writer footprint; candidate/source barriers still require quiescence. */
export function assertNoCheckpointLease(root: string, lifecycleOnly = false): void {
  if (lifecycleOnly) checkCallContext(captureCallContext(root)).assertIdle([root], "non-writer");
  else assertNoExclusive(root);
}
export function acquireCheckpointLease(root: string): () => void {
  const lease = reserveOperation(root, "checkpoint");
  return () => lease.release();
}
