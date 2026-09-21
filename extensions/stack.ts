import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PitakoConfigError } from "./errors.ts";
import { normalizePathList } from "./paths.ts";

export interface StackExtension {
  id: string;
  spec: string;
  entry: string;
  bin?: string;
  tools: string[];
}

export interface StackFile {
  profiles: string[];
  defaultProfile: string;
  pitakoExtension: string;
  required: StackExtension[];
  optional: Array<{
    id: string;
    status: string;
    suggestedPackage?: string;
    reason: string;
  }>;
}

export function packageRootFrom(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

export function packageRoot(): string {
  return packageRootFrom(import.meta.url);
}

export function readStack(root: string): StackFile {
  const stackPath = path.join(root, "config", "stack.json");
  if (!existsSync(stackPath)) {
    throw new PitakoConfigError(
      `Pitako configuration error: config/stack.json is missing under ${root}. This checkout is incomplete.`,
    );
  }
  let parsed: StackFile;
  try {
    parsed = JSON.parse(readFileSync(stackPath, "utf8")) as StackFile;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PitakoConfigError(`Pitako configuration error: config/stack.json is not valid JSON (${detail}).`);
  }
  if (!Array.isArray(parsed.required) || parsed.required.length === 0) {
    throw new PitakoConfigError("Pitako configuration error: config/stack.json has no required extensions.");
  }
  return parsed;
}

export function commandOnPath(bin: string, envPath: string | undefined, platform = process.platform): boolean {
  const names = platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
  for (const directory of normalizePathList(envPath)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return true;
    }
  }
  return false;
}

export interface PreparedRuntime {
  stack: StackFile;
  path: string;
  codegraph: "path" | "bundled";
}

/**
 * Confirm required extension entries exist and that `codegraph` can be spawned.
 * Prepends this package's node_modules/.bin only when the CLI is not already on PATH.
 */
export function prepareRuntime(root: string, env: NodeJS.ProcessEnv = process.env): PreparedRuntime {
  const stack = readStack(root);
  const missing: string[] = [];
  for (const extension of stack.required) {
    const entry = path.join(root, extension.entry);
    if (!existsSync(entry)) {
      missing.push(
        `Required extension "${extension.id}" was not found at ${extension.entry}. Install Pitako dependencies from the package root (\`bun install\`), then restart Pi.`,
      );
    }
  }
  if (missing.length > 0) {
    throw new PitakoConfigError(`Pitako configuration error:\n${missing.join("\n")}`);
  }

  const bundledBinDir = path.join(root, "node_modules", ".bin");
  let codegraph: PreparedRuntime["codegraph"] = "path";
  const needsCodegraph = stack.required.some((extension) => extension.bin === "codegraph");
  if (needsCodegraph && !commandOnPath("codegraph", env.PATH)) {
    const bundled = path.join(bundledBinDir, process.platform === "win32" ? "codegraph.cmd" : "codegraph");
    if (!existsSync(bundled)) {
      throw new PitakoConfigError(
        "Pitako configuration error: required program \"codegraph\" was not found on PATH, and Pitako's bundled binary is missing at node_modules/.bin/codegraph. Install dependencies with `bun install` (the package depends on @colbymchenry/codegraph) or install the codegraph CLI and put it on PATH.",
      );
    }
    env.PATH = [bundledBinDir, env.PATH ?? ""].filter((entry) => entry.length > 0).join(path.delimiter);
    codegraph = "bundled";
  }

  return { stack, path: env.PATH ?? "", codegraph };
}
