import type { StoreErrorCode, StoreRecordLocation, VerifiedStoreRecord } from "./pitako-store.ts";

export const VERIFIER_STDIN_LIMIT: number;
export const VERIFIER_STDOUT_LIMIT: number;
export type AccessState = "accessible" | "contradictory" | "unavailable";
export type AccessCause = "missing-file" | "parse-error" | "content-differs" | "output-save-error" | "retained-incompatible" | "verifier-failed" | StoreErrorCode;
export function receiptLocation(missionPath: string, namespace: string, gate: string): { missionDirectory: string; receiptPath: string };
export function accessReceiptKey(missionPath: string, gate: string): string;
export function resumableNamespace(namespace: unknown): boolean;
export function accessAction(cause: AccessCause, resumable: boolean): string;
export function explainAccess(entry: { state: AccessState; cause: AccessCause; id: string; key?: string; path?: string | null; store?: StoreRecordLocation; pointers?: string[]; expectedDigest?: string; digest?: string | null }, resumable?: boolean): string;
export type AccessVerifierItem = { id: string; key: string } & (
  | ({ path: string; store?: never } & ({ admitted: unknown; digest?: never } | { digest: string; admitted?: never }))
  | { store: StoreRecordLocation; digest: string; path?: never; admitted?: never }
);
type ReceiptReference = ({ path: string; store?: never } | { store: StoreRecordLocation; path?: never }) & { digest: string };
type AccessGate = { missionPath: string; namespace: string; gate: string };
type AccessRequest = AccessGate & { items: AccessVerifierItem[] };
export function readAccessReceipt(input: AccessGate, cwd?: string, recheck?: {
  reference: { store: StoreRecordLocation; digest: string };
  authorize(active: readonly VerifiedStoreRecord[]): void;
}): { value: unknown; receipt: ReceiptReference } | null;
export function provePathReceipt(request: AccessRequest, digest: string, cwd: string): unknown;
export function verifyGate(request: AccessRequest, cwd?: string): {
  v: 1; outcome: "published" | "identical" | "corresponding" | "conflict" | "unavailable"; receipt: ReceiptReference | null; explanation?: string;
  items: { id: string; state: AccessState; cause: AccessCause | null; code?: StoreErrorCode; digest: string | null; explanation?: string }[];
};
export type ReceiptCheck = {
  status: "verified" | "drift" | "blocked" | "missing" | "unavailable" | "invalid";
  code?: StoreErrorCode;
  receipt: (ReceiptReference & { namespace?: string; gate?: string }) | null;
  reason?: string;
  items?: (({ path: string; store?: never } | { store: StoreRecordLocation; path?: never }) & {
    id: string; state: AccessState; current: "unchanged" | "drift" | "missing" | "unparsable" | "not-verified";
    code?: StoreErrorCode; expectedDigest?: string; currentDigest?: string; explanation?: string;
  })[];
};
export function checkReceipt(input: { receiptPath: string } | { missionPath: string; namespace: string; gate: string }, cwd?: string): ReceiptCheck;
