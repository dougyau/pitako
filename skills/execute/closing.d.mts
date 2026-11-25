import type { admitExecuteRoot } from "./ledger.mjs";

type Candidate = { head: string; fingerprint: string };
type Original = { key: string; runId: string; path: string; digest: string };
export function closingCompliance(value: unknown, original: Original, candidate: Candidate,
  cancelledScope?: { id: string; completed: boolean; cancel: { reason: string } }[]): Record<string, unknown>;
export function closingArchive(seed: { body: Record<string, unknown> }, compliance?: unknown,
  reportedUsage?: unknown): { kind: "loop"; loop: number; body: Record<string, unknown> };
export function resolveClosingPublication(root: string, request: unknown): {
  admission: Parameters<typeof admitExecuteRoot>[2];
  expected: { invocation: string; count: number; head: string | null };
  body: { record: { kind: "loop"; loop: number; body: Record<string, unknown> };
    spec?: { content: string; digest: string } };
};
