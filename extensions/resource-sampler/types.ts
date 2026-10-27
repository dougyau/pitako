/** An absent measurement is never encoded as a zero. */
export type Metric<T> = { state: "available"; value: T } | { state: "warming" | "unavailable"; reason: string };

/** One process observed without command arguments, environment or agent attribution. */
export interface ProcessSample {
	pid: number;
	parentPid: number;
	/**
	 * Executable basename from kernel metadata, never argv, environment, process title or Linux comm:
	 * Darwin `p_comm` (at most 16 bytes), Linux `/proc/PID/exe` basename. "" means unavailable,
	 * e.g. another user's Linux process. Untrusted display text: whoever names the file chooses it, and
	 * a Linux process can exec a `memfd_create` file it named itself.
	 */
	name: string;
	identity: string;
	rssBytes: number;
	/** Interval utilization: 100 is one logical core, values may exceed 100. */
	cpu: Metric<number>;
}

/** Linux pressure stall information, not memory utilization or a universal pressure score. */
export interface PsiLine {
	avg10: number;
	avg60: number;
	avg300: number;
	/** Cumulative microseconds stalled. */
	total: number;
}

/** Snapshot captured over a bounded, non-atomic scan. */
export interface ResourceSnapshot {
	version: 1;
	platform: string;
	wallTimeMs: number;
	monotonicTimeMs: number;
	durationMs: number;
	/** Aggregate host interval utilization, 0..100. */
	cpu: Metric<number>;
	logicalCpus: number;
	loadAverage: number[];
	memory: { totalBytes: number; freeBytes: number };
	processes: ProcessSample[];
	coverage: {
		complete: boolean;
		/** Entries encountered, not a claimed host-wide process count when incomplete. */
		enumerated: number;
		sampled: number;
		skipped: number;
		bytesRead: number;
		reasons: string[];
	};
	pressure:
		| { source: "linux-psi"; memory: Metric<{ some: PsiLine; full: PsiLine | null }> }
		| { source: "unsupported"; reason: string };
}

/** Bounds per sample; filesystem/kernel scheduling can delay completion past the deadline. */
export interface SamplerOptions {
	/** Default 250ms, range 10..5000. No new work after this monotonic deadline. */
	maxDurationMs?: number;
	/** Default 2048, range 1..16384. Sequential Linux reads (concurrency one). */
	maxPids?: number;
	/** Default 2MiB, range 4096..16MiB, includes helper stdout/stderr and proc contents. */
	maxBytes?: number;
}

/** Caller owns cadence. No background polling, caching across instances or Pi dependency. */
export interface ResourceSampler {
	/** Rejects concurrent calls, disposal and caller cancellation. */
	sample(signal?: AbortSignal): Promise<ResourceSnapshot>;
	/** Aborts and awaits any collection and child reaping. Idempotent. */
	dispose(): Promise<void>;
}
