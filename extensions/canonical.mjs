// Shared canonical JSON and SHA-256 for the execute ledger and access receipts.
// Plain ESM so model-free runtime agents can run it with Node directly.
import { createHash } from "node:crypto";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Sorted-key JSON for plain JSON values; anything else is rejected, never coerced. */
export function canonicalJSON(value) {
  let indexed = false;
  const normalize = value => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return Array.from(value, normalize);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      const sorted = Object.create(null);
      for (const key of Object.keys(value).sort()) {
        if (String(key >>> 0) === key && key !== "4294967295") indexed = true;
        sorted[key] = normalize(value[key]);
      }
      return sorted;
    }
    throw new Error("Canonical JSON requires JSON values only.");
  };
  // Copy first: native serialization must never invoke an input's toJSON.
  const normalized = normalize(value);
  if (!indexed) return JSON.stringify(normalized);
  // Native object enumeration sorts array-index keys numerically, not lexicographically.
  const serialize = value => {
    if (Array.isArray(value)) return "[" + value.map(serialize).join(",") + "]";
    if (value && typeof value === "object")
      return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + serialize(value[key])).join(",") + "}";
    return JSON.stringify(value);
  };
  return serialize(normalized);
}

/** Digest of the canonical form: reformatting and key order do not change it. */
export function canonicalDigest(value) {
  return sha256(canonicalJSON(value));
}

const pointer = parts => parts.length ? "/" + parts.map(part => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/") : "";

/** JSON pointers (RFC 6901) where two JSON values differ, at most `limit`. */
export function jsonDifferences(left, right, limit = 10) {
  const found = [];
  const visit = (a, b, parts) => {
    if (found.length >= limit) return;
    const objectLike = value => value !== null && typeof value === "object";
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let index = 0; index < Math.max(a.length, b.length) && found.length < limit; index++)
        if (index >= a.length || index >= b.length) found.push(pointer([...parts, index]));
        else visit(a[index], b[index], [...parts, index]);
      return;
    }
    if (objectLike(a) && objectLike(b) && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (found.length >= limit) return;
        if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) found.push(pointer([...parts, key]));
        else visit(a[key], b[key], [...parts, key]);
      }
      return;
    }
    if (canonicalJSON(a) !== canonicalJSON(b)) found.push(pointer(parts));
  };
  visit(left, right, []);
  return found;
}
