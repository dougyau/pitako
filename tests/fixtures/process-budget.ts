import { expect } from "bun:test";

export type Processes = { sealer: number; loopIO: number; gates: number; other: number };
// Counts direct fixture spawns, not descendants of a
// counted child. Set bounds from measured counts + ~10% (at least two processes).
export function processBudget() {
  const counts: Processes = { sealer: 0, loopIO: 0, gates: 0, other: 0 };
  return { counts, processes: () => ({ ...counts }) };
}
export function expectProcessBudget(actual: Processes | Processes[], maximum: number) {
  const counts = Array.isArray(actual) ? actual : [actual];
  expect(counts.flatMap(count => Object.values(count)).reduce((sum, count) => sum + count, 0),
    JSON.stringify(actual)).toBeLessThanOrEqual(maximum);
}
