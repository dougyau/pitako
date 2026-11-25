export function planConflictReason(value: unknown, result: { agent?: unknown; runId?: unknown; output?: unknown } | undefined,
  expectedRunId: string | null | undefined, equal: (left: unknown, right: unknown) => boolean): string | null;
export function checkpointMismatchReason(paths: { path: string; journaled: string | null; actual: string | null;
  partiallyApplied: boolean }[]): string;
export function settledBarrier(result: unknown): string | null;
export function nativeReference(childKey: string, result: unknown, timeout?: boolean): Record<string, unknown>;
export function inspectorConflictReason(result: unknown, equal: (left: unknown, right: unknown) => boolean): string | null;
export function viewOverflowReason(receipt: unknown): string | null;
export function checkpointWitnessIssue(witness: unknown, expected: { key: string; taskId: string;
  attempt: number; loop: number; cursor: number }): string | null;
