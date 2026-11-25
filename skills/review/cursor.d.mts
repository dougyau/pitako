export function reviewCursorContract(): {
  key: string;
  schema: any;
  validate(key: string, value: unknown): {
    identity: string; scopeId: string; parentScope: string | null; prefix: string;
    terminal: {outcome: "completed" | "blocked" | "failed"; storeId: string; head: {seq: 1; hash: string}} | string | null;
    models: Record<"r1" | "r2" | "synthesis", {key: string; model: string}>;
  };
  witness(result: unknown): unknown;
};
export const reviewCursorScript: string;
