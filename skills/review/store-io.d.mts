export function saveReview(request: unknown, cwd?: string): Promise<{
  outcome: "appended" | "replay"; head: {seq: 1; hash: string}; storeId: string;
  scopeId: string; result: {status: "completed" | "blocked" | "failed"; [key: string]: unknown};
}>;
export function observeReview(request: unknown, cwd?: string): {
  scopeId: string; settlements: unknown[]; pending: string[];
};
