export function runOperation(operation: string, input: Record<string, unknown>, grouped?: boolean): Promise<Record<string, unknown>>;

export function resolveStoredGroupedInput(
  operation: string,
  input: Record<string, unknown>,
): Record<string, unknown>;

export function recoverStoredWorker(input: Record<string, unknown>): Record<string, unknown>;
export function commitStoredGate(input: Record<string, unknown>, receipt: Record<string, unknown>): Record<string, unknown>;
export function commitFinalGate(input: Record<string, unknown>, receipt: Record<string, unknown>, producer?: string): Record<string, unknown>;
export function publishFinalReview(input: Record<string, unknown>, observe?: (root: string) => { head: string; fingerprint: string }): Record<string, unknown>;
export function commitTaskReviewContext(input: Record<string, unknown>, delta: Record<string, unknown>): Record<string, unknown>;

export function receiptTransport(reference: Record<string, unknown>, outer?: boolean): Record<string, unknown>;
export function transportOutput(operation: string, receipt: Record<string, unknown>): string;
export function receiptData(value: Record<string, unknown>): Record<string, unknown>;
export function recordBaselineInput(input: Record<string, unknown>): void;
export function closeContinuation(input: Record<string, unknown>, steps: Record<string, unknown>[]): Record<string, unknown> | null;
export function recordFinalDrainInput(input: {
  root: string; invocation: string; key: string; intentions: unknown[]; finalDrain?: boolean;
}): void;
export function retainSelectionRejection(input: Record<string, unknown>, error: {
  message: string; selectionRejected?: boolean; replayRejected?: boolean;
}): { key: string; head: { seq: number; hash: string }; storeId: string } | undefined;
export function replaySelectionRejection(input: Record<string, unknown>, request: Record<string, unknown>,
  error: { message: string; selectionRejected?: boolean; replayRejected?: boolean; rejectedDrain?: unknown }
): Record<string, unknown> | undefined;
