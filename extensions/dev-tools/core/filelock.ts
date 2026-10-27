/**
 * Cross-process lock: an atomic `mkdir` directory holding an owner file.
 *
 * `withLock` only queues inside one process; two pi panes are two processes. This guards the
 * shared on-disk state (e.g. a git common dir) between them. Callers should still take
 * `withLock` first so same-process waiters queue instead of polling.
 *
 * Reclaim: ONLY a lock whose recorded owner pid is dead (`ESRCH`) is ever removed, plus an
 * ownerless directory older than `OWNERLESS_GRACE_MS` (a holder that died between `mkdir` and
 * writing `owner.json`). There is NO age-based reclaim: a live pid is never broken. Because only
 * dead-owner locks are removed, a live holder's release cannot race a reclaimer.
 *
 * Residual risk: PID reuse. If the OS recycles a dead holder's pid for an unrelated process, the
 * stale lock looks live. Waiters then fail with `lock-timeout` naming that pid, and a human can
 * remove the directory. We accept that over ever auto-breaking a live pid.
 *
 * Reclaimers serialize behind a short-lived guard directory `<lock>.reclaim` (atomic `mkdir`).
 * Inside the guard the owner is re-read and must still be the SAME token and still dead before
 * the lock is removed. Guards carry an immutable PID/token filename. Only confirmed dead owners
 * are reclaimed; unknown owners require manual recovery. Age never authorizes guard removal.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_LOCK_WAIT_MS = 15_000;
const POLL_MS = 50;
/** How long a lock directory may lack an owner file before it is treated as abandoned. */
const OWNERLESS_GRACE_MS = 2_000;

export interface FileLockOptions {
	/** Give up waiting after this long. Default 15s. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Called once if the lock is held by another process when we arrive. */
	onWait?: (holder: LockOwner | undefined) => void;
	/** Writes the owner file. Injectable so tests can simulate a failing write. Default `writeFileSync`. */
	writeOwner?: (path: string, data: string) => void;
}

export interface LockOwner {
	pid: number;
	startedAt: number;
	token: string;
}

export class FileLockTimeoutError extends Error {
	readonly holder: LockOwner | undefined;
	constructor(dir: string, waitedMs: number, holder: LockOwner | undefined) {
		const who = holder ? ` held by pid ${holder.pid} for ${Math.round((Date.now() - holder.startedAt) / 1000)}s` : "";
		super(
			`lock-timeout: ${dir}${who}; waited ${Math.round(waitedMs / 1000)}s; inspect ${dir}.reclaim for a live or unknown reclaim owner before manual removal`,
		);
		this.name = "FileLockTimeoutError";
		this.holder = holder;
	}
}

export class FileLockAbortedError extends Error {
	constructor(dir: string) {
		super(`aborted while waiting for lock ${dir}`);
		this.name = "FileLockAbortedError";
	}
}

/** The lock directory was created but its owner file could not be written; the directory is removed. */
export class FileLockFailedError extends Error {
	constructor(dir: string, cause: unknown) {
		super(`lock-failed: could not write owner file in ${dir}: ${cause instanceof Error ? cause.message : cause}`);
		this.name = "FileLockFailedError";
		this.cause = cause;
	}
}

const OWNER = "owner.json";
/** Unref'd so a pending poll never keeps the process alive; jittered so waiters do not stampede. */
const sleep = (ms: number) =>
	new Promise<void>((r) => {
		setTimeout(r, ms === 0 ? 0 : ms * (0.5 + Math.random())).unref();
	});

function readOwner(dir: string): LockOwner | undefined {
	try {
		const o = JSON.parse(readFileSync(join(dir, OWNER), "utf8")) as Partial<LockOwner>;
		return Number.isInteger(o.pid) && (o.pid ?? 0) > 0 && typeof o.startedAt === "number" && typeof o.token === "string"
			? (o as LockOwner)
			: undefined;
	} catch {
		return undefined;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

const ageMs = (path: string): number | undefined => {
	try {
		return Date.now() - statSync(path).mtimeMs;
	} catch {
		return undefined; // vanished
	}
};

/** Dead owner, or an ownerless directory past the grace period. A live pid is never stale. */
function isStale(dir: string, owner: LockOwner | undefined): boolean {
	if (owner) return !pidAlive(owner.pid);
	const age = ageMs(dir);
	return age !== undefined && age > OWNERLESS_GRACE_MS;
}

/**
 * Remove a stale lock under the reclaim guard. Returns true if this call removed it. Never
 * throws for contention; the caller just polls again.
 */
function reclaim(dir: string, judged: LockOwner | undefined): boolean {
	const guard = `${dir}.reclaim`;
	const token = randomUUID();
	const ownerPath = join(guard, `${process.pid}.${token}`);
	try {
		mkdirSync(guard);
	} catch {
		try {
			const files = readdirSync(guard);
			const match = files.length === 1 ? /^(\d+)\.([a-f0-9-]+)$/.exec(files[0] ?? "") : null;
			if (match && Number(match[1]) > 0 && !pidAlive(Number(match[1]))) {
				// Unlink ONLY this immutable dead owner's file, never a replacement's file.
				unlinkSync(join(guard, files[0] as string));
				rmdirSync(guard);
			}
		} catch {
			// Contention or unknown ownership. Never age-reclaim a guard.
		}
		return false;
	}
	try {
		writeFileSync(ownerPath, "", { flag: "wx" });
	} catch {
		return false; // publication lost a race; we do not own a guard
	}
	try {
		const now = readOwner(dir);
		if (now?.token !== judged?.token || !isStale(dir, now)) return false;
		rmSync(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	} finally {
		try {
			unlinkSync(ownerPath);
			rmdirSync(guard);
		} catch {
			// A foreign guard is never removed recursively.
		}
	}
}

/** Verify the token, then remove. Never throws: a gone or foreign lock is not ours to delete. */
function release(dir: string, token: string): void {
	try {
		if (readOwner(dir)?.token !== token) return;
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// nothing useful to do; the lock is either gone or unremovable
	}
}

/** `mkdir` the lock and write the owner. false = held by someone else. */
function acquire(dir: string, token: string, writeOwner: (path: string, data: string) => void): boolean {
	try {
		mkdirSync(dir);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
	}
	try {
		const owner: LockOwner = { pid: process.pid, startedAt: Date.now(), token };
		writeOwner(join(dir, OWNER), JSON.stringify(owner));
	} catch (e) {
		rmSync(dir, { recursive: true, force: true }); // we just created it, so it is ours
		throw new FileLockFailedError(dir, e);
	}
	return true;
}

export async function withFileLock<T>(dir: string, fn: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_WAIT_MS;
	const writeOwner = opts.writeOwner ?? ((path, data) => writeFileSync(path, data));
	const started = Date.now();
	const token = randomUUID();
	let announced = false;
	for (;;) {
		if (opts.signal?.aborted) throw new FileLockAbortedError(dir);
		if (acquire(dir, token, writeOwner)) break;
		const holder = readOwner(dir);
		const reclaimed = isStale(dir, holder) && reclaim(dir, holder);
		if (!reclaimed && !announced) {
			announced = true;
			opts.onWait?.(holder);
		}
		const waited = Date.now() - started;
		if (waited >= timeoutMs) throw new FileLockTimeoutError(dir, waited, holder);
		await sleep(reclaimed ? 0 : Math.min(POLL_MS, timeoutMs - waited));
	}
	try {
		return await fn();
	} finally {
		release(dir, token);
	}
}
