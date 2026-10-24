export const DEFAULT_BOARD_AUTHOR = "pi";

/** Board attribution is a native session identity, not a role or execution grant. */
export function resolveBoardAuthor(sessionId?: string): string {
  return sessionId || DEFAULT_BOARD_AUTHOR;
}
