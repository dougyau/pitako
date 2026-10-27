/**
 * No-shell process runner shared by every tool.
 *
 * - argv array, never a shell string
 * - stdin is either closed or fed a fixed script
 * - the child runs in its own process group so a timeout or abort kills the whole tree
 * - SIGTERM first, SIGKILL after a grace period, then a hard resolve so a grandchild that
 *   keeps the pipes open cannot hang the caller
 * - remaining group members are killed when the command settles, including normal leader exit
 * - stdout and stderr are kept separate, each capped in memory with a dropped-byte count
 *
 * macOS and Linux only: process-group kill relies on `detached` + `kill(-pid)`.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RunOptions {
	cmd: string;
	args: readonly string[];
	cwd?: string;
	env?: Readonly<Record<string, string | undefined>>;
	/** Written to stdin then closed. Omit to close stdin immediately. */
	stdin?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** In-memory cap per stream. Bytes past it are counted and dropped. */
	maxBytes?: number;
	/** Called for each complete stderr line while the process runs. Exceptions are swallowed. */
	onStderrLine?: (line: string) => void;
}

export interface RunResult {
	exitCode: number | null;
	/** Signal that ended the process, if any. */
	termSignal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	stdoutDropped: number;
	stderrDropped: number;
	/** We sent a kill because the timeout elapsed while the child was still alive. */
	timedOut: boolean;
	/** We sent a kill, or never started, because the caller aborted. */
	aborted: boolean;
	durationMs: number;
	/** Set when the process could not be spawned at all, e.g. binary missing. */
	spawnError?: string;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_STREAM_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
/** After SIGKILL, how long to wait for `close` before resolving with what we have. */
const CLOSE_GRACE_MS = 1_000;

class StreamBuffer {
	private readonly chunks: Buffer[] = [];
	private size = 0;
	dropped = 0;
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";
	private pendingDropped = false;
	private readonly max: number;
	private readonly onLine?: (line: string) => void;

	constructor(max: number, onLine?: (line: string) => void) {
		this.max = max;
		this.onLine = onLine;
	}

	push(chunk: Buffer): void {
		if (this.onLine) this.feedLines(this.decoder.write(chunk));
		const room = this.max - this.size;
		if (room <= 0) {
			this.dropped += chunk.length;
			return;
		}
		const take = Math.min(room, chunk.length);
		this.chunks.push(chunk.subarray(0, take));
		this.size += take;
		this.dropped += chunk.length - take;
	}

	/** Flush any partial last line to `onLine` and return the capped text. */
	finish(): string {
		if (this.onLine) {
			this.feedLines(this.decoder.end());
			if (this.pending && !this.pendingDropped) this.emit(this.pending);
			this.pending = "";
		}
		return Buffer.concat(this.chunks).toString("utf8");
	}

	private feedLines(text: string): void {
		if (!text) return;
		let start = 0;
		while (start < text.length) {
			const nl = text.indexOf("\n", start);
			const end = nl < 0 ? text.length : nl;
			// Cap each line, not the entire chunk: later lines in this chunk may still fit.
			if (!this.pendingDropped) {
				if (this.pending.length + end - start > this.max) {
					this.pending = "";
					this.pendingDropped = true;
				} else {
					this.pending += text.slice(start, end);
				}
			}
			if (nl < 0) return;
			if (!this.pendingDropped) {
				this.emit(this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending);
			}
			this.pending = "";
			this.pendingDropped = false;
			start = nl + 1;
		}
	}

	private emit(line: string): void {
		try {
			this.onLine?.(line);
		} catch {
			// a listener failure must never take down the runner
		}
	}
}

/** Signal only the owned process group; a reaped leader's bare pid may already have been reused. */
function killTree(pid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(-pid, sig);
	} catch {
		// The group is already gone; never fall back to an unrelated process with the old leader pid.
	}
}

export function run(opts: RunOptions): Promise<RunResult> {
	const start = Date.now();
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_STREAM_BYTES;
	const out = new StreamBuffer(maxBytes);
	const err = new StreamBuffer(maxBytes, opts.onStderrLine);

	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let groupId: number | undefined;
		const timers: NodeJS.Timeout[] = [];

		const finish = (exitCode: number | null, termSignal: NodeJS.Signals | null, spawnError?: string) => {
			if (settled) return;
			settled = true;
			for (const t of timers) clearTimeout(t);
			if (groupId !== undefined) killTree(groupId, "SIGKILL");
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({
				exitCode,
				termSignal,
				stdout: out.finish(),
				stderr: err.finish(),
				stdoutDropped: out.dropped,
				stderrDropped: err.dropped,
				timedOut,
				aborted,
				durationMs: Date.now() - start,
				spawnError,
			});
		};

		if (opts.signal?.aborted) {
			aborted = true;
			finish(null, null);
			return;
		}

		const child = spawn(opts.cmd, opts.args, {
			cwd: opts.cwd,
			env: opts.env ? { ...process.env, ...opts.env } : process.env,
			stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			detached: true,
		});
		groupId = child.pid;

		const alive = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;

		/**
		 * Kill the tree. Returns true when the child itself was still running, which is the only
		 * case that counts as a timeout or abort of the command; a grandchild holding the pipes
		 * after the child exited is just cleanup.
		 */
		const terminate = (): boolean => {
			if (child.pid === undefined) return false;
			const wasAlive = alive();
			killTree(child.pid, "SIGTERM");
			timers.push(
				setTimeout(() => {
					if (child.pid === undefined || settled) return;
					killTree(child.pid, "SIGKILL");
					timers.push(setTimeout(() => finish(child.exitCode, child.signalCode), CLOSE_GRACE_MS));
				}, KILL_GRACE_MS),
			);
			return wasAlive;
		};

		function onAbort() {
			if (terminate()) aborted = true;
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (timeoutMs > 0) {
			timers.push(
				setTimeout(() => {
					if (terminate()) timedOut = true;
				}, timeoutMs),
			);
		}

		child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (e) => finish(null, null, e.message));
		child.on("close", (code, sig) => finish(code, sig));

		if (opts.stdin !== undefined && child.stdin) {
			child.stdin.on("error", () => {
				// EPIPE when the child exits before reading; the close event still fires
			});
			child.stdin.end(opts.stdin);
		}
	});
}
