import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Pi agent directory. `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`.
 * Relative values resolve against `cwd` and are canonicalized when the path exists.
 */
export function getPiAgentDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return canonicalPath(expandHome(configured.trim()), cwd);
  }
  return path.join(homedir(), ".pi", "agent");
}

export function getPitakoDataDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return path.join(getPiAgentDir(env, cwd), "pitako");
}

export function getBoardDbPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return path.join(getPitakoDataDir(env, cwd), "board.db");
}

export function getPitakoConfigPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return path.join(getPitakoDataDir(env, cwd), "config.toml");
}

export function canonicalPath(input: string, cwd = process.cwd()): string {
  const absolute = path.resolve(cwd, input);
  const existing = deepestExisting(absolute);
  if (!existing) return absolute;
  try {
    const real = realpathSync(existing);
    const suffix = path.relative(existing, absolute);
    return suffix.length > 0 ? path.join(real, suffix) : real;
  } catch {
    return absolute;
  }
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) {
    return path.join(homedir(), input.slice(2));
  }
  return input;
}

function deepestExisting(target: string): string | undefined {
  let current = target;
  while (true) {
    if (existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
