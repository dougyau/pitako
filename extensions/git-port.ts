import { execFileSync, spawnSync, type ExecFileSyncOptionsWithStringEncoding, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { run } from "./dev-tools/core/process.ts";

export interface GitPort {
  read(args: readonly string[], opts: ExecFileSyncOptionsWithStringEncoding): string;
  status(args: readonly string[], opts: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
  run: typeof run;
}

const realGit: GitPort = {
  read: (args, opts) => execFileSync("git", args, opts),
  status: (args, opts) => spawnSync("git", args, opts),
  run,
};
const slot = Symbol.for("pitako.git-port");
const ports = globalThis as typeof globalThis & { [slot]?: GitPort };

export function gitPort(): GitPort {
  return ports[slot] ?? realGit;
}

export function setGitPort(port: GitPort): () => void {
  const previous = ports[slot];
  ports[slot] = port;
  return () => {
    if (previous === undefined) delete ports[slot];
    else ports[slot] = previous;
  };
}
