import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalPath, getPitakoConfigPath } from "../board/paths.ts";
import { planConfigCompletion } from "./config-completion.ts";
import type { LoadOptions } from "./load.ts";

type Result = { state: "unchanged" | "completed" | "retired" } | { state: "skipped"; warning: string };
interface Snapshot {
  target: string;
  link?: fs.Stats;
  stat?: fs.Stats;
  bytes?: Buffer;
}
class ConcurrentEdit extends Error {}
class UnsafeTarget extends Error {}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function identity(a: fs.Stats | undefined, b: fs.Stats | undefined): boolean {
  return !a || !b ? a === b : ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeMs", "ctimeMs"]
    .every(key => a[key as keyof fs.Stats] === b[key as keyof fs.Stats]);
}
function snapshot(file: string): Snapshot {
  let link: fs.Stats;
  try { link = fs.lstatSync(file); }
  catch (error) {
    if (!missing(error)) throw error;
    return { target: canonicalPath(file) };
  }
  // Resolve valid symlinks but never replace the link itself. Dangling links fail here.
  const target = fs.realpathSync(file), stat = fs.statSync(target);
  if (!stat.isFile()) throw new UnsafeTarget(`${file}: config completion requires a regular target`);
  const bytes = fs.readFileSync(target);
  if (!identity(stat, fs.statSync(target)) || !identity(link, fs.lstatSync(file)))
    throw new ConcurrentEdit(`${file}: config changed while reading`);
  return { target, link, stat, bytes };
}
function same(a: Snapshot, b: Snapshot): boolean {
  return a.target === b.target && identity(a.link, b.link) && identity(a.stat, b.stat) &&
    (a.bytes === undefined ? b.bytes === undefined : b.bytes !== undefined && a.bytes.equals(b.bytes));
}
function ownedUnlink(file: string, owner: fs.Stats): void {
  let current: fs.Stats;
  try { current = fs.lstatSync(file); } catch (error) { if (missing(error)) return; throw error; }
  if (current.dev === owner.dev && current.ino === owner.ino) fs.unlinkSync(file);
}

/** Synchronous principal-only caller; readers/imports never call this writer. */
export function completePitakoConfig(options: LoadOptions, current: () => boolean): Result {
  if (!current()) return { state: "retired" };
  const file = options.userConfigPath ?? getPitakoConfigPath(options.env, options.cwd);
  const load = { ...options, userConfigPath: file };
  const skipped = (): Result => ({ state: "skipped", warning: `${file}: config completion skipped: contention or concurrent edit` });
  let initial: Snapshot;
  try { initial = snapshot(file); }
  catch (error) { if (error instanceof ConcurrentEdit) return skipped(); throw error; }
  const unchangedSnapshot = () => {
    try { return same(initial, snapshot(file)); }
    catch (error) {
      if (error instanceof ConcurrentEdit || error instanceof UnsafeTarget || missing(error)) return false;
      throw error;
    }
  };
  const source = initial.bytes?.toString("utf8");
  const proposal = planConfigCompletion(source, load);
  if (proposal === (source ?? "")) return { state: "unchanged" };
  if (!current()) return { state: "retired" };
  if (initial.bytes && !Buffer.from(source!, "utf8").equals(initial.bytes))
    throw new Error(`${file}: config completion refuses non-UTF-8 bytes`);
  if (initial.stat && initial.stat.nlink !== 1)
    throw new Error(`${file}: config completion refuses multiply linked targets`);
  fs.mkdirSync(path.dirname(initial.target), { recursive: true, mode: 0o700 });
  const lock = `${initial.target}.pitako-completion.lock`;
  let lockFd: number;
  try { lockFd = fs.openSync(lock, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return skipped(); throw error; }
  let lockOwner: fs.Stats;
  try { lockOwner = fs.fstatSync(lockFd); }
  finally { fs.closeSync(lockFd); }
  const temp = path.join(path.dirname(initial.target), `.pitako-config-${randomUUID()}.tmp`);
  let tempOwner: fs.Stats | undefined;
  try {
    if (!current()) return { state: "retired" };
    if (!unchangedSnapshot()) return skipped();
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      tempOwner = fs.fstatSync(fd);
      fs.writeFileSync(fd, proposal, "utf8");
      if (initial.stat) {
        const { uid, gid, mode } = initial.stat;
        const created = fs.fstatSync(fd);
        if (created.uid !== uid || created.gid !== gid) fs.fchownSync(fd, uid, gid);
        fs.fchmodSync(fd, mode & 0o7777);
        const preserved = fs.fstatSync(fd);
        if (preserved.uid !== uid || preserved.gid !== gid || preserved.mode !== mode)
          throw new Error(`${file}: could not preserve config ownership/mode`);
      }
      tempOwner = fs.fstatSync(fd);
    } finally { fs.closeSync(fd); }
    if (!current()) return { state: "retired" };
    if (!unchangedSnapshot()) return skipped();
    try {
      if (!identity(fs.lstatSync(lock), lockOwner) || !identity(fs.lstatSync(temp), tempOwner) ||
          !fs.readFileSync(temp).equals(Buffer.from(proposal))) return skipped();
    } catch (error) { if (missing(error)) return skipped(); throw error; }
    if (!current()) return { state: "retired" };
    if (initial.stat) fs.renameSync(temp, initial.target);
    else {
      // Hard-link publication is no-replace on this same filesystem.
      try { fs.linkSync(temp, initial.target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return skipped(); throw error; }
    }
    return { state: "completed" };
  } finally {
    try { if (tempOwner) ownedUnlink(temp, tempOwner); }
    finally { ownedUnlink(lock, lockOwner); }
  }
}
