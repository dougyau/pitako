import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, readlinkSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { HistoryGroup, WorkerHistory } from "./history.ts";
import { nativeHeader } from "./history-native.ts";

/** Cooperative, fail-closed exclusion. An abandoned lock is never reclaimed by PID inference. */
export function acquireHistoryExclusion(catalogFile: string): () => void {
  const lock = `${catalogFile}.lock`;
  mkdirSync(lock, { mode: 0o700 });
  return () => rmdirSync(lock);
}

const cleanupOwners = new Map<string, string>();
const DAY = 86400000;
export interface HistoryPruneResult {
  disabled: boolean;
  dryRun: boolean;
  groups: Array<{ groupId: string; state: "eligible" | "pruned" | "protected" | "busy" | "failed"; reason?: string; files?: string[] }>;
}

function canonicalDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  if (!lstatSync(absolute).isDirectory() || realpathSync(absolute) !== absolute) throw new Error("noncanonical history directory");
  return absolute;
}
function regularOrAbsent(file: string): void {
  try {
    if (!lstatSync(file).isFile() || realpathSync(file) !== file) throw new Error("unsafe history file type or symlink");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Only registered native files, adjacent ACP, and registered exact-target discovery aliases. */
function ownedFiles(history: WorkerHistory, group: HistoryGroup): NonNullable<HistoryGroup["cleanup"]>["files"] {
  const files: NonNullable<HistoryGroup["cleanup"]>["files"] = [];
  const targets = new Set<string>();
  for (const member of group.members) {
    if (member.native.state !== "allocated") continue;
    const native = member.native;
    const directory = canonicalDirectory(path.join(history.agentDir, "sessions", `--pitako-workers--${group.groupId}`));
    if (path.dirname(native.path) !== directory ||
      !(path.basename(native.path) === `${native.sessionId}.jsonl` || path.basename(native.path).endsWith(`_${native.sessionId}.jsonl`)))
      throw new Error("native file outside registered ownership");
    if (group.members.some((row) => row.coordinatorSessionFile && path.resolve(row.coordinatorSessionFile) === native.path))
      throw new Error("coordinator session is protected");
    regularOrAbsent(native.path);
    try {
      if (nativeHeader(native.path).id !== native.sessionId) throw new Error("native session header identity mismatch");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    regularOrAbsent(`${native.path}.acp.json`);
    files.push({ path: native.path, kind: "file" }, { path: `${native.path}.acp.json`, kind: "file" });
    targets.add(directory);
  }
  for (const alias of group.aliases ?? []) {
    const root = canonicalDirectory(path.join(history.agentDir, "sessions"));
    if (path.dirname(alias.path) !== root || !path.basename(alias.path).startsWith(`--pitako-workers--${group.groupId}`) ||
      !targets.has(alias.target)) throw new Error("unowned history alias");
    validateAlias(alias.path, alias.target);
    files.push({ path: alias.path, kind: "alias", target: alias.target });
  }
  return files;
}
function validateAlias(file: string, target: string): void {
  try {
    if (!lstatSync(file).isSymbolicLink() || path.resolve(path.dirname(file), readlinkSync(file)) !== target)
      throw new Error("history alias target changed");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function closure(group: HistoryGroup) {
  if (group.identity.kind === "mission") return { reason: "archived/catalog-only; current closure unknown" };
  if (group.prunedAt) return { reason: "already pruned" };
  if (group.coverage !== "complete") return { reason: "membership coverage is partial" };
  if (!group.members.length) return { reason: "no demonstrated member lifecycle" };
  if (group.identity.kind === "execution") return { reason: "execution has no durable closure proof" };
  if (group.members.some((member) => !member.terminal ||
    member.native.state === "allocated" && member.native.disposition.state !== "disposed"))
    return { reason: "terminal lifecycle or SDK disposal unconfirmed" };
  const observed = group.closure;
  if (observed.state !== "closed") return { reason: observed.state === "unknown" ? observed.reason : "group is not closed" };
  const dates = [observed.closedAt, ...group.members.flatMap((member) => [
    member.terminal!.at, ...(member.native.state === "allocated" && member.native.disposition.state === "disposed" ? [member.native.disposition.at] : []),
  ])].map(Date.parse);
  if (dates.some((date) => !Number.isFinite(date))) return { reason: "invalid closure timestamp" };
  return { closedAt: new Date(Math.max(...dates)).toISOString(), evidenceRef: observed.evidenceRef };
}

/** Preflight never excludes live work. Only expired closure candidates refresh under deletion exclusion. */
export async function pruneWorkerHistory(history: WorkerHistory, ttlDays: number | false, options: {
  dryRun?: boolean; now?: number;
  /** Test-only interruption boundary after an owned unlink. */
  afterUnlink?: (file: string) => void;
} = {}): Promise<HistoryPruneResult> {
  const result: HistoryPruneResult = { disabled: ttlDays === false, dryRun: Boolean(options.dryRun), groups: [] };
  if (ttlDays === false) return result;
  if (!Number.isSafeInteger(ttlDays) || ttlDays <= 0) throw new Error("invalid worker history TTL");
  const now = options.now ?? Date.now();
  for (const listed of history.list()) {
    const groupId = listed.groupId;
    const act = async (group: HistoryGroup, save?: () => void) => {
      const observed = await closure(group);
      if (!observed.closedAt || now - Date.parse(observed.closedAt) < ttlDays * DAY) {
        result.groups.push({ groupId, state: "protected", reason: observed.reason ?? "TTL not elapsed" }); return;
      }
      const files = ownedFiles(history, group);
      const key = path.join(history.catalogDir, groupId);
      if (group.cleanup && (cleanupOwners.get(key) !== group.cleanup.owner ||
        JSON.stringify(files) !== JSON.stringify(group.cleanup.files))) throw new Error("cleanup ownership uncertain");
      if (!save) { result.groups.push({ groupId, state: "eligible", files: files.map((row) => row.path) }); return; }
      group.closure = { state: "closed", closedAt: observed.closedAt, evidenceRef: observed.evidenceRef! };
      if (!group.cleanup) {
        const owner = randomUUID();
        cleanupOwners.set(key, owner);
        group.cleanup = { state: "deleting", owner, files, closedAt: observed.closedAt };
        save(); // Intent precedes the first unlink, never reconstructed from missing files.
      }
      for (const file of group.cleanup.files) {
        canonicalDirectory(path.dirname(file.path));
        if (file.kind === "alias") validateAlias(file.path, file.target!);
        else regularOrAbsent(file.path);
        try { unlinkSync(file.path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        options.afterUnlink?.(file.path);
      }
      group.members = group.members.map((member) => ({ historyId: member.historyId, roleId: member.roleId,
        admittedAt: member.admittedAt, native: { state: member.native.state === "not-created" ? "not-created" : "pruned" }, gaps: [],
        coordinatorSessionId: member.coordinatorSessionId, assignmentId: member.assignmentId, instanceId: member.instanceId,
        attemptId: member.attemptId }));
      delete group.cleanup; delete group.aliases;
      group.prunedAt = new Date(now).toISOString();
      save();
      cleanupOwners.delete(key);
      result.groups.push({ groupId, state: "pruned", files: files.map((row) => row.path) });
    };
    try {
      if (options.dryRun) await act(history.read(groupId));
      else {
        const lock = path.join(history.catalogDir, `${groupId}.json.lock`);
        if (existsSync(lock)) {
          result.groups.push({ groupId, state: "busy", reason: "history exclusion is held or uncertain" }); continue;
        }
        // This is rejection only, not deletion authority. A closed invocation cannot reopen;
        // refresh ordinary closure again under exclusion.
        const observed = await closure(history.read(groupId));
        if (!observed.closedAt || now - Date.parse(observed.closedAt) < ttlDays * DAY) {
          result.groups.push({ groupId, state: "protected", reason: observed.reason ?? "TTL not elapsed" }); continue;
        }
        await history.exclusive(groupId, act);
      }
    } catch (error) {
      result.groups.push({ groupId, state: (error as NodeJS.ErrnoException).code === "EEXIST" ? "busy" : "failed", reason: String(error) });
    }
  }
  return result;
}
