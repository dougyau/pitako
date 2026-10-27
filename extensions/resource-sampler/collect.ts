import { spawn } from "node:child_process";
import { open, opendir, readlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { darwinProcess, executableName, linuxRss, linuxStat, type ProcessCounter, psi } from "./counters.js";
import type { ResourceSnapshot } from "./types.js";

/** Linux PATH_MAX: Node (libuv `pathconf`) and Bun (`PathBuffer`) readlink buffer size on Linux. */
const LINK_BUFFER_BYTES = 4096;

/** Per-scan mutable budget, never shared between sampler instances. */
export class Budget {
	bytesRead = 0;
	enumerated = 0;
	skipped = 0;
	readonly reasons = new Set<string>();
	constructor(
		readonly deadline: number,
		readonly maxBytes: number,
		readonly maxPids: number,
		readonly signal: AbortSignal,
	) {}
	remaining(): number {
		this.signal.throwIfAborted();
		return Math.max(0, this.deadline - performance.now());
	}
	ready(): boolean {
		if (this.remaining() <= 0) this.reasons.add("deadline");
		if (this.bytesRead >= this.maxBytes) this.reasons.add("byte-limit");
		return this.remaining() > 0 && this.bytesRead < this.maxBytes;
	}
	/** Fixed-size proc read: no unbounded readFile allocation, and always await handle closure. */
	async read(path: string): Promise<string> {
		if (!this.ready()) throw new Error("budget exhausted");
		const capacity = Math.min(8192, this.maxBytes - this.bytesRead);
		const file = await open(path, "r");
		try {
			if (!this.ready()) throw new Error("budget exhausted while opening proc file");
			const buffer = Buffer.alloc(capacity);
			const { bytesRead } = await file.read(buffer, 0, capacity, 0);
			this.bytesRead += bytesRead;
			this.signal.throwIfAborted();
			if (bytesRead === capacity) {
				this.reasons.add("file-byte-limit");
				throw new Error("proc file may be truncated");
			}
			return buffer.toString("utf8", 0, bytesRead);
		} finally {
			await file.close();
		}
	}
	/**
	 * Linux executable basename, or "" when the exe link is unreadable (other users' processes without
	 * ptrace read access, exited processes), over budget or possibly truncated. Errors carry no detail
	 * outward. Node and Bun cannot cap readlink below their fixed PATH_MAX buffer, so the length is only
	 * known after the syscall: a target beyond the remaining budget is charged the remainder and dropped,
	 * keeping `bytesRead <= maxBytes`. Node returns a full buffer silently truncated, so that is dropped too.
	 */
	async executable(path: string): Promise<string> {
		if (!this.ready()) return "";
		let target: Buffer;
		try {
			target = await readlink(path, { encoding: "buffer" });
		} catch {
			this.signal.throwIfAborted();
			return "";
		}
		this.signal.throwIfAborted();
		const remaining = this.maxBytes - this.bytesRead;
		if (target.length > remaining) {
			this.bytesRead = this.maxBytes;
			this.reasons.add("byte-limit");
			return "";
		}
		this.bytesRead += target.length;
		if (target.length >= LINK_BUFFER_BYTES) {
			this.reasons.add("file-byte-limit");
			return "";
		}
		return executableName(target.toString("utf8"));
	}
}

/** Fixed executable/argv only. Bound capture, kill on cancellation/deadline, await close/reaping. */
export async function command(
	executable: string,
	args: string[],
	budget: Budget,
	maxLines = Number.POSITIVE_INFINITY,
): Promise<{ text: string; complete: boolean }> {
	if (!budget.ready()) return { text: "", complete: false };
	return new Promise((resolve) => {
		const child = spawn(executable, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
		});
		const buffers: Buffer[] = [];
		let complete = true;
		let lines = 0;
		const stop = (reason: string) => {
			complete = false;
			budget.reasons.add(reason);
			child.kill("SIGKILL");
		};
		const abort = () => stop("cancelled");
		const timer = setTimeout(() => stop("deadline"), budget.remaining());
		budget.signal.addEventListener("abort", abort, { once: true });
		// Close the race between the ready check and listener registration.
		if (budget.signal.aborted) abort();
		child.stdout.on("data", (data: Buffer) => {
			if (!complete) return;
			const remaining = budget.maxBytes - budget.bytesRead;
			const kept = data.subarray(0, remaining);
			budget.bytesRead += kept.length;
			let end = kept.length;
			for (let i = 0; i < kept.length; i++) {
				if (kept[i] === 10 && ++lines > maxLines) {
					end = i + 1;
					stop("pid-limit");
					break;
				}
			}
			buffers.push(kept.subarray(0, end));
			if (data.length >= remaining) stop("byte-limit");
		});
		child.stderr.on("data", (data: Buffer) => {
			const remaining = budget.maxBytes - budget.bytesRead;
			budget.bytesRead += Math.min(remaining, data.length);
			if (data.length >= remaining) stop("byte-limit");
		});
		child.on("error", () => {
			complete = false;
			budget.reasons.add("command-unavailable");
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			budget.signal.removeEventListener("abort", abort);
			if (code !== 0 && complete) {
				complete = false;
				budget.reasons.add("command-failed");
			}
			let text = Buffer.concat(buffers).toString("utf8");
			if (!complete) text = text.slice(0, text.lastIndexOf("\n") + 1);
			resolve({ text, complete });
		});
	});
}

/** Linux scan is sequential and closes the directory even on cancellation. */
export async function linuxProcesses(budget: Budget, hz: number): Promise<ProcessCounter[]> {
	const result: ProcessCounter[] = [];
	const directory = await opendir("/proc");
	for await (const entry of directory) {
		if (!/^\d+$/.test(entry.name)) continue;
		if (!budget.ready()) break;
		if (budget.enumerated >= budget.maxPids) {
			budget.reasons.add("pid-limit");
			break;
		}
		budget.enumerated++;
		try {
			const path = `/proc/${entry.name}`;
			const first = linuxStat(await budget.read(`${path}/stat`), hz, performance.now());
			if (!first) throw new Error("process incomplete");
			const name = await budget.executable(`${path}/exe`);
			const rssBytes = linuxRss(await budget.read(`${path}/status`));
			const last = linuxStat(await budget.read(`${path}/stat`), hz, performance.now());
			// The name and RSS reads sit between two stat reads, so PID reuse rejects both.
			if (!last || first.pid !== Number(entry.name) || first.identity !== last.identity || rssBytes === null)
				throw new Error("process changed or incomplete");
			result.push({ ...last, name, rssBytes });
		} catch {
			budget.signal.throwIfAborted();
			budget.skipped++;
			budget.reasons.add("process-unreadable-or-changed");
		}
	}
	return result;
}

/**
 * Fixed metadata-only ps format. `ucomm` prints kinfo `p_comm`, never `comm`: `ps -c -o comm` shows the
 * basename of argv[0], which any launcher picks and Node's `process.title` rewrites in place.
 */
export async function darwinProcesses(budget: Budget): Promise<ProcessCounter[]> {
	const { text } = await command(
		"/bin/ps",
		["-A", "-o", "pid=,ppid=,lstart=,time=,rss=,ucomm="],
		budget,
		budget.maxPids,
	);
	const result: ProcessCounter[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		if (budget.enumerated >= budget.maxPids) {
			budget.reasons.add("pid-limit");
			break;
		}
		budget.enumerated++;
		const parsed = darwinProcess(line, performance.now());
		if (parsed) result.push(parsed);
		else {
			budget.skipped++;
			budget.reasons.add("malformed-process-row");
		}
	}
	return result;
}

/** PSI is optional and platform-specific; absence is not zero pressure. */
export async function pressure(budget: Budget, platform: string): Promise<ResourceSnapshot["pressure"]> {
	if (platform !== "linux")
		return { source: "unsupported", reason: "no comparable native PSI metric on this platform" };
	try {
		const value = psi(await budget.read("/proc/pressure/memory"));
		if (value) return { source: "linux-psi", memory: { state: "available", value } };
	} catch {
		budget.signal.throwIfAborted();
	}
	return {
		source: "linux-psi",
		memory: { state: "unavailable", reason: "PSI absent, invalid or scan budget exhausted" },
	};
}
