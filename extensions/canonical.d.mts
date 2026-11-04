export function sha256(bytes: string | Uint8Array): string;
export function canonicalJSON(value: unknown): string;
export function canonicalDigest(value: unknown): string;
export function jsonDifferences(left: unknown, right: unknown, limit?: number): string[];
