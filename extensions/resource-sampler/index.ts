import { type CpuInfo, cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { Budget, command, darwinProcesses, linuxProcesses, pressure } from "./collect.js";
import { cpuSnapshot, hostCpu, type ProcessCounter, processCpu } from "./counters.js";
import type { ResourceSampler, ResourceSnapshot, SamplerOptions } from "./types.js";

export type { Metric, ProcessSample, PsiLine, ResourceSampler, ResourceSnapshot, SamplerOptions } from "./types.js";

/** Validate bounded integers before collecting any host information. */
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
	const result = value ?? fallback;
	if (!Number.isInteger(result) || result < min || result > max)
		throw new RangeError(`Sampler bound must be an integer from ${min} to ${max}`);
	return result;
}

/** Create an isolated, passive sampler. No timers or child processes exist until sample(). */
export function createResourceSampler(options: SamplerOptions = {}): ResourceSampler {
	const duration = bounded(options.maxDurationMs, 250, 10, 5000);
	const maxPids = bounded(options.maxPids, 2048, 1, 16384);
	const maxBytes = bounded(options.maxBytes, 2_097_152, 4096, 16_777_216);
	const host = platform();
	let previousCpus: CpuInfo[] | undefined;
	let previousTime: number | undefined;
	let previousProcesses = new Map<number, ProcessCounter>();
	let hz: number | undefined;
	let active: Promise<ResourceSnapshot> | undefined;
	let controller: AbortController | undefined;
	let disposed = false;

	async function collect(signal: AbortSignal): Promise<ResourceSnapshot> {
		const start = performance.now();
		const wallTimeMs = Date.now();
		const budget = new Budget(start + duration, maxBytes, maxPids, signal);
		signal.throwIfAborted();
		const currentCpus = cpuSnapshot(cpus());
		const cpu =
			previousTime !== undefined && start <= previousTime
				? { state: "warming" as const, reason: "invalid monotonic interval" }
				: hostCpu(previousCpus, currentCpus);
		const nativePressure = await pressure(budget, host);
		let counters: ProcessCounter[] = [];
		try {
			if (host === "linux") {
				if (hz === undefined) {
					const result = await command("/usr/bin/getconf", ["CLK_TCK"], budget);
					const value = Number(result.text.trim());
					if (result.complete && Number.isSafeInteger(value) && value > 0) hz = value;
				}
				if (hz !== undefined && budget.ready()) counters = await linuxProcesses(budget, hz);
				else budget.reasons.add("clock-ticks-unavailable");
			} else if (host === "darwin") counters = await darwinProcesses(budget);
			else budget.reasons.add("unsupported-platform");
		} catch {
			signal.throwIfAborted();
			budget.reasons.add("process-collection-unavailable");
		}
		signal.throwIfAborted();
		const processes = counters.map((counter) => ({
			pid: counter.pid,
			parentPid: counter.parentPid,
			name: counter.name,
			identity: counter.identity,
			rssBytes: counter.rssBytes,
			cpu:
				host === "darwin"
					? {
							state: "unavailable" as const,
							reason: "ps start identity precision is one second; PID reuse cannot be excluded",
						}
					: processCpu(previousProcesses.get(counter.pid), counter),
		}));
		// Only successfully completed scans advance baselines. Missing processes lose their baselines.
		previousCpus = currentCpus;
		previousTime = start;
		previousProcesses = new Map(counters.map((counter) => [counter.pid, counter]));
		if (performance.now() > budget.deadline) budget.reasons.add("deadline");
		return {
			version: 1,
			platform: host,
			wallTimeMs,
			monotonicTimeMs: start,
			durationMs: performance.now() - start,
			cpu,
			logicalCpus: currentCpus.length,
			loadAverage: host === "win32" ? [] : loadavg(),
			memory: { totalBytes: totalmem(), freeBytes: freemem() },
			processes,
			coverage: {
				complete: budget.reasons.size === 0,
				enumerated: budget.enumerated,
				sampled: processes.length,
				skipped: budget.skipped,
				bytesRead: budget.bytesRead,
				reasons: [...budget.reasons],
			},
			pressure: nativePressure,
		};
	}
	return {
		sample(signal) {
			if (disposed) return Promise.reject(new Error("Resource sampler is disposed"));
			if (active) return Promise.reject(new Error("Resource sampler already has an active sample"));
			controller = new AbortController();
			const local = controller;
			const abort = () => local.abort(signal?.reason);
			if (signal?.aborted) abort();
			signal?.addEventListener("abort", abort, { once: true });
			active = collect(local.signal).finally(() => {
				signal?.removeEventListener("abort", abort);
				active = undefined;
				controller = undefined;
			});
			return active;
		},
		async dispose() {
			disposed = true;
			controller?.abort();
			try {
				await active;
			} catch {
				/* The sample caller receives the cancellation. Disposal waits for cleanup. */
			}
			previousCpus = undefined;
			previousProcesses.clear();
		},
	};
}
