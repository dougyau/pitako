import { expect } from "bun:test";
import { observeGitProcesses } from "../../extensions/git-process-observer.ts";

export type Processes = { git: number; sealer: number; loopIO: number; gates: number; other: number };
// Counts direct fixture spawns and owned helper Git calls, not descendants of a
// counted child. Set bounds from measured counts + ~10% (at least two processes).
export function processBudget(root: string) {
  const counts: Processes = { git: 0, sealer: 0, loopIO: 0, gates: 0, other: 0 };
  const dispose = observeGitProcesses(root, () => { counts.git++; });
  return { counts, dispose, processes: () => ({ ...counts }) };
}
export function expectProcessBudget(actual: Processes | Processes[], maximum: number) {
  const counts = Array.isArray(actual) ? actual : [actual];
  expect(counts.flatMap(count => Object.values(count)).reduce((sum, count) => sum + count, 0),
    JSON.stringify(actual)).toBeLessThanOrEqual(maximum);
}
