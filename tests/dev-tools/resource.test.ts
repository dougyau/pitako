// Adapted from nredd/pi-harness; MIT (Redd). See docs/provenance.json for source commits and test origins.
import { describe, expect, it } from "bun:test";
import type { ProcessSample, ResourceSampler, ResourceSnapshot, SamplerOptions } from "../../extensions/resource-sampler/index.ts";
import type { RunOptions, RunResult } from "../../extensions/dev-tools/core/index.ts";
import { resourceSnapshot, registerResourceTools, type ResourceSnapshotOptions } from "../../extensions/dev-tools/resource/index.ts";
import { createMockPi } from "./support.ts";
const INTERVAL_MS = 100;
function completed(stdout: string): RunResult {
	return {
		exitCode: 0,
		termSignal: null,
		stdout,
		stderr: "",
		stdoutDropped: 0,
		stderrDropped: 0,
		timedOut: false,
		aborted: false,
		durationMs: 1,
	};
}

function proc(pid: number, rssBytes: number, cpu: ProcessSample["cpu"], name = "node"): ProcessSample {
	return { pid, parentPid: 1, name, identity: `${pid}:1`, rssBytes, cpu };
}

const measured = (value: number): ProcessSample["cpu"] => ({ state: "available", value });
const warming: ProcessSample["cpu"] = { state: "warming", reason: "initial sample or PID reused" };
const darwinCpu: ProcessSample["cpu"] = { state: "unavailable", reason: "ps start identity precision is one second" };

function fixture(platform: string, processes: ProcessSample[], overrides: Partial<ResourceSnapshot> = {}) {
	return (monotonicTimeMs: number): ResourceSnapshot => ({
		version: 1,
		platform,
		wallTimeMs: 1_700_000_000_000 + monotonicTimeMs,
		monotonicTimeMs,
		durationMs: 5,
		cpu: monotonicTimeMs === 0 ? { state: "warming", reason: "initial" } : { state: "available", value: 37.5 },
		logicalCpus: 8,
		loadAverage: platform === "win32" ? [] : [1.25, 2.5, 3.75],
		memory: { totalBytes: 16_000, freeBytes: 4_000 },
		processes,
		coverage: {
			complete: true,
			enumerated: processes.length,
			sampled: processes.length,
			skipped: 0,
			bytesRead: 10,
			reasons: [],
		},
		pressure:
			platform === "linux"
				? {
						source: "linux-psi",
						memory: {
							state: "available",
							value: { some: { avg10: 0.42, avg60: 0.1, avg300: 0.01, total: 1 }, full: null },
						},
					}
				: { source: "unsupported", reason: "no comparable native PSI metric on this platform" },
		...overrides,
	});
}

/** Fake sampler recording its options, sample signals and disposal; `disposeFailure` makes disposal reject. */
function fakeSampler(
	make: (monotonicTimeMs: number) => ResourceSnapshot,
	fail?: Error,
	disposeFailure?: Error,
	disposeThrowsSync = false,
) {
	const state = { options: undefined as SamplerOptions | undefined, samples: 0, disposed: 0 };
	const createSampler = (options: SamplerOptions): ResourceSampler => {
		state.options = options;
		return {
			async sample(signal) {
				signal?.throwIfAborted();
				if (fail && state.samples === 1) throw fail;
				return make(state.samples++ * 120);
			},
			dispose() {
				state.disposed++;
				if (disposeFailure && disposeThrowsSync) throw disposeFailure;
				return disposeFailure ? Promise.reject(disposeFailure) : Promise.resolve();
			},
		};
	};
	return { state, createSampler };
}

function options(make: (monotonicTimeMs: number) => ResourceSnapshot, extra: ResourceSnapshotOptions = {}) {
	const fake = fakeSampler(make);
	const calls: RunOptions[] = [];
	const resolved: ResourceSnapshotOptions = {
		createSampler: fake.createSampler,
		readFile: async (path) => {
			if (path === "/proc/meminfo") return "MemAvailable:       9 kB\n";
			throw new Error("unexpected path");
		},
		run: async (runOptions) => {
			calls.push(runOptions);
			return completed("System-wide memory free percentage: 37%\n");
		},
		...extra,
	};
	return { fake, calls, resolved };
}

describe("resource_snapshot mapping", () => {
	it("maps a Linux sample: interval CPU first, warming never ranked as zero, PSI and MemAvailable", async () => {
		const { fake, resolved } = options(
			fixture("linux", [
				proc(7, 100, measured(12.5), "tester"),
				proc(8, 1_000_000, warming),
				proc(9, 200, measured(0)),
				proc(10, 300, measured(0)),
			]),
		);
		const snapshot = await resourceSnapshot(4, resolved, undefined, INTERVAL_MS);
		expect(fake.state.options).toEqual({ maxDurationMs: 1_000 });
		expect(fake.state.disposed).toBe(1);
		expect(snapshot).toMatchObject({
			platform: "linux",
			interval: { requestedMs: INTERVAL_MS, measuredMs: 120 },
			cpu: { logicalCpus: 8, loadAverage: [1.25, 2.5, 3.75], utilization: { state: "available", value: 37.5 } },
			memory: {
				status: "available",
				totalBytes: 16_000,
				freeBytes: 4_000,
				availableBytes: 9 * 1024,
				pressure: { source: "linux-psi", value: 0.42 },
			},
			processes: { status: "available", limit: 4, ranking: "interval-cpu", truncated: false },
		});
		if (snapshot.processes.status !== "available") throw new Error("missing metadata");
		expect(snapshot.processes.entries.map((entry) => entry.pid)).toEqual([7, 10, 9, 8]);
		expect(snapshot.processes.entries[0]).toEqual({
			pid: 7,
			parentPid: 1,
			cpu: { state: "available", value: 12.5 },
			rssBytes: 100,
			executable: "tester",
		});
		expect(snapshot.processes.cpuSemantics).toContain("interval CPU");
	});

	it('keeps an unknown executable as "" and never fills it in', async () => {
		const mock = createMockPi();
		const { resolved } = options(fixture("linux", [proc(7, 200, measured(3), ""), proc(8, 100, measured(1), "bash")]));
		registerResourceTools(mock.pi, resolved);
		const result = await mock.call("resource_snapshot", { process_limit: 2, interval_ms: INTERVAL_MS }, "/tmp");
		expect(result.structuredContent).toMatchObject({
			processes: {
				entries: [
					{ pid: 7, executable: "" },
					{ pid: 8, executable: "bash" },
				],
			},
		});
		expect(mock.text(result)).toContain("\n7 1 3.0% 200 (unknown)\n8 1 1.0% 100 bash");
	});

	it("bounds 60 entries to the limit and reports incomplete coverage as truncated", async () => {
		const processes = Array.from({ length: 60 }, (_, i) => proc(i + 1, 10, measured(i)));
		const coverage = {
			complete: false,
			enumerated: 61,
			sampled: 60,
			skipped: 1,
			bytesRead: 10,
			reasons: ["process-unreadable-or-changed"],
		};
		const { resolved } = options(fixture("linux", processes, { coverage }));
		const snapshot = await resourceSnapshot(50, resolved, undefined, INTERVAL_MS);
		if (snapshot.processes.status !== "available") throw new Error("missing metadata");
		expect(snapshot.processes.entries).toHaveLength(50);
		expect(snapshot.processes.entries[0]?.pid).toBe(60);
		expect(snapshot.processes).toMatchObject({ truncated: true, coverage });
	});

	it("ranks Darwin by RSS and labels unavailable interval CPU without any average", async () => {
		const { calls, resolved } = options(
			fixture("darwin", [proc(5, 50, darwinCpu, "Activity Monitor"), proc(6, 500, darwinCpu)]),
		);
		const controller = new AbortController();
		const snapshot = await resourceSnapshot(2, resolved, controller.signal, INTERVAL_MS);
		expect(snapshot.memory).toMatchObject({ availableBytes: null, pressure: { source: "memory_pressure", value: 37 } });
		expect(calls).toEqual([
			expect.objectContaining({
				cmd: "memory_pressure",
				args: ["-Q"],
				env: { LC_ALL: "C" },
				signal: controller.signal,
			}),
		]);
		expect(snapshot.processes).toMatchObject({
			ranking: "rss",
			entries: [{ pid: 6 }, { pid: 5, executable: "Activity Monitor", cpu: darwinCpu }],
		});
		if (snapshot.processes.status !== "available") throw new Error("missing metadata");
		expect(snapshot.processes.cpuSemantics).toContain("never a ps lifetime or decaying average");
	});

	it.each([{ timedOut: true }, { aborted: true }, { spawnError: "missing" }, { stdoutDropped: 1 }, { exitCode: 1 }])(
		"rejects Darwin pressure from unsuccessful commands: %j",
		async (failure) => {
			const { resolved } = options(fixture("darwin", [proc(5, 50, darwinCpu)]), {
				run: async () => ({ ...completed("System-wide memory free percentage: 37%\n"), ...failure }),
			});
			const snapshot = await resourceSnapshot(1, resolved, undefined, INTERVAL_MS);
			expect(snapshot.memory.pressure).toBeNull();
		},
	);

	it("keeps base memory figures when optional probes throw", async () => {
		const linux = options(fixture("linux", [proc(5, 50, warming)]), {
			readFile: async () => {
				throw new Error("EACCES");
			},
		});
		expect((await resourceSnapshot(1, linux.resolved, undefined, INTERVAL_MS)).memory).toMatchObject({
			totalBytes: 16_000,
			freeBytes: 4_000,
			availableBytes: null,
			pressure: { source: "linux-psi", value: 0.42 },
		});
		const darwin = options(fixture("darwin", [proc(5, 50, darwinCpu)]), {
			run: async () => {
				throw new Error("missing");
			},
		});
		expect((await resourceSnapshot(1, darwin.resolved, undefined, INTERVAL_MS)).memory.pressure).toBeNull();
	});

	it("keeps unavailable PSI absent, not zero", async () => {
		const { resolved } = options(
			fixture("linux", [proc(5, 50, warming)], {
				pressure: { source: "linux-psi", memory: { state: "unavailable", reason: "PSI absent" } },
			}),
		);
		expect((await resourceSnapshot(1, resolved, undefined, INTERVAL_MS)).memory.pressure).toBeNull();
	});

	it("is explicit about unavailable Windows load and process metadata", async () => {
		const coverage = {
			complete: false,
			enumerated: 0,
			sampled: 0,
			skipped: 0,
			bytesRead: 0,
			reasons: ["unsupported-platform"],
		};
		const { resolved } = options(fixture("win32", [], { coverage }));
		const snapshot = await resourceSnapshot(12, resolved, undefined, INTERVAL_MS);
		expect(snapshot.cpu.loadAverage).toBeNull();
		expect(snapshot.processes).toEqual({
			status: "unavailable",
			reason: "bounded process metadata is unsupported on win32",
		});
	});

	it("reports failed process collection as unavailable with its finite reasons", async () => {
		const coverage = {
			complete: false,
			enumerated: 0,
			sampled: 0,
			skipped: 0,
			bytesRead: 0,
			reasons: ["command-failed"],
		};
		const { resolved } = options(fixture("darwin", [], { coverage }));
		expect((await resourceSnapshot(1, resolved, undefined, INTERVAL_MS)).processes).toEqual({
			status: "unavailable",
			reason: "process metadata unavailable (command-failed)",
		});
	});

	it("propagates sampler failures and always disposes", async () => {
		const fake = fakeSampler(fixture("linux", []), new Error("sampler exploded"));
		await expect(resourceSnapshot(1, { createSampler: fake.createSampler }, undefined, INTERVAL_MS)).rejects.toThrow(
			"sampler exploded",
		);
		expect(fake.state.disposed).toBe(1);
	});

	it("rejects a Darwin cancellation that lands during the pressure probe after the second sample", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled after sampling");
		const { fake, resolved } = options(fixture("darwin", [proc(5, 50, darwinCpu)]), {
			run: async () => {
				controller.abort(reason);
				return { ...completed(""), aborted: true, exitCode: null, termSignal: "SIGTERM" };
			},
		});
		await expect(resourceSnapshot(1, resolved, controller.signal, INTERVAL_MS)).rejects.toBe(reason);
		expect(fake.state.samples).toBe(2);
		expect(fake.state.disposed).toBe(1);
	});

	it("rejects a Linux cancellation that lands during the MemAvailable read after the second sample", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled after sampling");
		const { fake, resolved } = options(fixture("linux", [proc(5, 50, warming)]), {
			readFile: async () => {
				controller.abort(reason);
				throw new Error("read interrupted");
			},
		});
		await expect(resourceSnapshot(1, resolved, controller.signal, INTERVAL_MS)).rejects.toBe(reason);
		expect(fake.state.samples).toBe(2);
		expect(fake.state.disposed).toBe(1);
	});

	it("keeps the sampler failure, not a later disposal failure", async () => {
		const fake = fakeSampler(fixture("linux", []), new Error("sampler exploded"), new Error("dispose exploded"));
		await expect(resourceSnapshot(1, { createSampler: fake.createSampler }, undefined, INTERVAL_MS)).rejects.toThrow(
			"sampler exploded",
		);
		expect(fake.state.disposed).toBe(1);
	});

	it("keeps the sampler failure when an injected dispose throws synchronously", async () => {
		const fake = fakeSampler(fixture("linux", []), new Error("sampler exploded"), new Error("dispose exploded"), true);
		await expect(resourceSnapshot(1, { createSampler: fake.createSampler }, undefined, INTERVAL_MS)).rejects.toThrow(
			"sampler exploded",
		);
		expect(fake.state.disposed).toBe(1);
	});

	it("keeps the cancellation, not a later disposal failure", async () => {
		const fake = fakeSampler(fixture("linux", []), undefined, new Error("dispose exploded"));
		const controller = new AbortController();
		const reason = new Error("cancelled by caller");
		controller.abort(reason);
		await expect(
			resourceSnapshot(1, { createSampler: fake.createSampler }, controller.signal, INTERVAL_MS),
		).rejects.toBe(reason);
		expect(fake.state.disposed).toBe(1);
	});

	it("rejects with the disposal failure when the snapshot itself succeeded", async () => {
		const fake = fakeSampler(fixture("linux", [proc(5, 50, warming)]), undefined, new Error("dispose exploded"));
		const { resolved } = options(fixture("linux", []), { createSampler: fake.createSampler });
		await expect(resourceSnapshot(1, resolved, undefined, INTERVAL_MS)).rejects.toThrow("dispose exploded");
		expect(fake.state.disposed).toBe(1);
	});

	it.each([
		[0, INTERVAL_MS],
		[-1, INTERVAL_MS],
		[51, INTERVAL_MS],
		[1.5, INTERVAL_MS],
		[Number.NaN, INTERVAL_MS],
		[Number.POSITIVE_INFINITY, INTERVAL_MS],
		[1, 99],
		[1, 5_001],
		[1, 150.5],
	])("rejects invalid direct limit %s or interval %s before sampling", async (limit, interval) => {
		await expect(
			resourceSnapshot(
				limit,
				{
					createSampler: () => {
						throw new Error("must not sample");
					},
				},
				undefined,
				interval,
			),
		).rejects.toThrow(RangeError);
	});

	it("registers a read-only tool with bounded input and privacy guidance", async () => {
		const mock = createMockPi();
		const { resolved } = options(fixture("linux", [proc(7, 102_400, measured(12.5), "tester")]));
		registerResourceTools(mock.pi, resolved);
		const tool = mock.tools.get("resource_snapshot");
		expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		expect(tool?.description).toContain(
			"never command arguments, process titles, Linux comm or environments. Whoever names the executable file chooses it",
		);
		expect(tool?.description).toContain("cannot attribute OS processes to agents");
		const result = await mock.call("resource_snapshot", { process_limit: 1, interval_ms: INTERVAL_MS }, "/tmp");
		expect(result.isError).toBe(false);
		expect(mock.text(result)).toContain("7 1 12.5% 102400 tester");
		expect(mock.text(result)).toContain("interval utilization 37.5% over 120ms");
		expect(mock.text(result)).toContain(
			"Executables are untrusted kernel-reported basenames ((unknown) when unreadable), never arguments, titles or environments; no process-to-agent attribution",
		);
		for (const params of [{ process_limit: 51 }, { process_limit: 0 }, { interval_ms: 99 }, { interval_ms: 5_001 }]) {
			await expect(mock.call("resource_snapshot", params, "/tmp")).rejects.toThrow("params rejected");
		}
	});

	it("injects awareness guidance without forcing activation", () => {
		const mock = createMockPi();
		registerResourceTools(mock.pi);
		const [hook] = mock.hooks.get("before_agent_start") ?? [];
		const result = hook?.({ systemPrompt: "base" }, {}) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("Before knowingly starting a large test or compile");
		expect(result.systemPrompt).toContain("not a lock, serialization rule, or fixed threshold");
	});
});
