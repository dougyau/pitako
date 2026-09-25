import path from "node:path";
import { canonicalPath } from "../board/paths.ts";

export const QUERY_BUDGETS = {
  responseBytes: 12 * 1024,
  candidates: 8,
  relations: 8,
  sourceLines: 120,
} as const;

export const LANGUAGES = ["Html", "JavaScript", "Tsx", "Css", "TypeScript"] as const;
export type Language = (typeof LANGUAGES)[number];

const EXTENSIONS: Record<string, Language> = {
  ".html": "Html",
  ".css": "Css",
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".ts": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".tsx": "Tsx",
};
const KNOWN_UNSUPPORTED_EXTENSIONS = new Set([".md", ".py"]);

export type LanguageResolution =
  | { status: "resolved"; language: Language }
  | { status: "ambiguous"; candidates: readonly Language[] }
  | { status: "unsupported"; requested: string };

export function resolveLanguage(file?: string, requested?: string): LanguageResolution {
  if (requested !== undefined) {
    const language = requested === "typescript" ? "TypeScript" : requested;
    return LANGUAGES.includes(language as Language)
      ? { status: "resolved", language: language as Language }
      : { status: "unsupported", requested };
  }
  const extension = file && path.extname(file).toLowerCase();
  const language = extension && EXTENSIONS[extension];
  if (language) return { status: "resolved", language };
  if (extension && KNOWN_UNSUPPORTED_EXTENSIONS.has(extension)) return { status: "unsupported", requested: extension.slice(1) };
  return { status: "ambiguous", candidates: LANGUAGES };
}

/** Resolve symlinks before containment checks, including existing parent paths. */
export function workspacePath(workspace: string, input: string): string {
  const root = canonicalPath(workspace);
  const resolved = canonicalPath(input, root);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path escapes workspace: ${input}`);
  }
  return resolved;
}
