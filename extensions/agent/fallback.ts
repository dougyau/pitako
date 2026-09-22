import { FALLBACK_REASONS, type FallbackReason } from "../roles/types.ts";

const HTTP_STATUS = "50[0-4]|520|524";

const PATTERNS: Array<{ reason: FallbackReason; pattern: RegExp }> = [
  { reason: "quota", pattern: /insufficient[_\s-]?quota|quota exceeded|usage limit|billing|credit balance|payment required|insufficient funds/i },
  { reason: "rate_limit", pattern: /rate limit|too many requests|\b429\b/i },
  { reason: "auth", pattern: /no api key|missing api key|unauthorized|invalid api key|authentication|api key|access denied|\b401\b|\b403\b/i },
  {
    reason: "unavailable",
    pattern: new RegExp(
      [
        "model .{0,40}not found",
        "model .{0,40}unavailable",
        "unknown model",
        "no such model",
        "provider unavailable",
        "overloaded",
        "service unavailable",
        "internal server error",
        "bad gateway",
        "gateway timeout",
        "fetch failed",
        "socket hang up",
        "econnreset",
        "econnrefused",
        "connection reset",
        "connection refused",
        "network error",
        "transport unavailable",
        "request timed out",
        "etimedout",
        `\\bHTTP(?:/\\d+\\.\\d+)?/?\\s*(?:${HTTP_STATUS})\\b`,
        `\\bstatus(?:\\s+code)?\\s*[:=]?\\s*(?:${HTTP_STATUS})\\b`,
        `\\b(?:${HTTP_STATUS})\\s+status(?:\\s+code)?\\b`,
        `\\((?:${HTTP_STATUS})\\)\\s*:`,
        `\\b(?:${HTTP_STATUS})\\s*:`,
        `\\b(?:${HTTP_STATUS})\\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\\b`,
      ].join("|"),
      "i",
    ),
  },
];

/** Infrastructure failures only. Unknown text does not fall back. */
export function classifyProviderFailure(message: string | undefined): FallbackReason | undefined {
  if (!message || message.trim().length === 0) return undefined;
  for (const entry of PATTERNS) {
    if (entry.pattern.test(message)) return entry.reason;
  }
  return undefined;
}

export function isFallbackReason(value: string): value is FallbackReason {
  return (FALLBACK_REASONS as readonly string[]).includes(value);
}
