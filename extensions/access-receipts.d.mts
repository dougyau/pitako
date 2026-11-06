export const VERIFIER_STDIN_LIMIT: number;
export const VERIFIER_STDOUT_LIMIT: number;
export type AccessState = "accessible" | "contradictory" | "unavailable";
export type AccessCause = "missing-file" | "parse-error" | "content-differs" | "output-save-error" | "retained-incompatible" | "verifier-failed";
export function receiptLocation(missionPath: string, namespace: string, gate: string): { missionDirectory: string; receiptPath: string };
export function resumableNamespace(namespace: unknown): boolean;
export function accessAction(cause: AccessCause, resumable: boolean): string;
export function explainAccess(entry: { state: AccessState; cause: AccessCause; id: string; key?: string; path?: string | null; pointers?: string[]; expectedDigest?: string; digest?: string | null }, resumable?: boolean): string;
export type AccessVerifierItem = { id: string; key: string; path: string } &
  ({ admitted: unknown; digest?: never } | { digest: string; admitted?: never });
export function verifyGate(request: { missionPath: string; namespace: string; gate: string; items: AccessVerifierItem[] }): {
  v: 1; outcome: "published" | "identical" | "conflict"; receipt: { path: string; digest: string }; explanation?: string;
  items: { id: string; state: AccessState; cause: AccessCause | null; digest: string | null; explanation?: string }[];
};
export type ReceiptCheck = {
  status: "verified" | "drift" | "blocked" | "missing" | "unavailable" | "invalid";
  receipt: { path: string; digest?: string; namespace?: string; gate?: string };
  reason?: string;
  items?: { id: string; path: string; state: AccessState; current: "unchanged" | "drift" | "missing" | "unparsable" | "not-verified"; expectedDigest?: string; currentDigest?: string; explanation?: string }[];
};
export function checkReceipt(input: { receiptPath: string } | { missionPath: string; namespace: string; gate: string }): ReceiptCheck;
