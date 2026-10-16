/** Receipt comparison is pure. Channel-specific callers retain all lifecycle effects. */
export function receiptInBranch(message: { customType: string; content: string; details: { deliveryId: string } }, branch: readonly unknown[]): boolean {
  return branch.some(entry => {
    if (!entry || typeof entry !== "object") return false;
    const value = entry as { type?: unknown; customType?: unknown; content?: unknown; details?: { deliveryId?: unknown } };
    return value.type === "custom_message" && value.customType === message.customType &&
      value.details?.deliveryId === message.details.deliveryId && value.content === message.content;
  });
}
export function offerEnvelope<T>(state: { deliveryAttempts: number; delivery: string; outstanding: boolean; deliveryDiagnostic?: string }, message: T): T {
  ++state.deliveryAttempts;
  state.delivery = "offered";
  state.outstanding = true;
  state.deliveryDiagnostic = "commitment not yet observed";
  return message;
}
