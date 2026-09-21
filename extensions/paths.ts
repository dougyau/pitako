import path from "node:path";

const PROTECTED_DIRECTORIES = new Set([".git", "node_modules"]);

/** True when an edit/write target is a path Pitako refuses to mutate. */
export function isProtectedEditPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => PROTECTED_DIRECTORIES.has(segment))) return true;
  const base = segments.at(-1) ?? "";
  return base === ".env" || base.startsWith(".env.");
}

export function normalizePathList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(path.delimiter).filter((entry) => entry.length > 0);
}
