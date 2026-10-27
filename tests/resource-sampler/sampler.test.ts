// Adapted from nredd/pi-harness; MIT (Redd). See docs/provenance.json for source commits and test origins.
import { type CpuInfo } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "bun:test";
import { Budget, command } from "../../extensions/resource-sampler/collect.js";
import {
	cpuSnapshot,
	darwinProcess,
	executableName,
	hostCpu,
	linuxRss,
	linuxStat,
	type ProcessCounter,
	processCpu,
	psi,
	safeName,
} from "../../extensions/resource-sampler/counters.js";
import { createResourceSampler } from "../../extensions/resource-sampler/index.js";

const core = (user: number, idle: number): CpuInfo => ({
	model: "fixture",
	speed: 1000,
	times: { user, idle, sys: 0, nice: 0, irq: 0 },
});
const proc = (cpuMs: number, at: number, identity = "12:50"): ProcessCounter => ({
	pid: 12,
	parentPid: 1,
	name: "fixture",
	identity,
	rssBytes: 1024,
	cpuMs,
	at,
});

describe("honest counters", () => {
	it("warms first sample, topology changes, rollback and non-advancing counters", () => {
		expect(hostCpu(undefined, [core(1, 1)]).state).toBe("warming");
		expect(hostCpu([core(1, 1)], [core(2, 2), core(1, 1)]).state).toBe("warming");
		expect(hostCpu([core(2, 2)], [core(1, 10)]).state).toBe("warming");
		expect(hostCpu([core(2, 2)], [core(2, 2)]).state).toBe("warming");
		expect(hostCpu([core(2, 2)], [core(Number.NaN, 2)]).state).toBe("warming");
	});
	it("normalizes aggregate CPU but preserves multi-core process CPU", () => {
		expect(hostCpu([core(0, 0), core(0, 0)], [core(100, 100), core(0, 200)])).toEqual({
			state: "available",
			value: 25,
		});
		expect(processCpu(proc(100, 100), proc(500, 200))).toEqual({ state: "available", value: 400 });
		expect(processCpu(proc(100, 100), proc(100, 200))).toEqual({ state: "available", value: 0 });
	});
	it("snapshots Bun-style lazy os.cpus() placeholders when called, not when first read", () => {
		let now = 0;
		// Mirrors Bun's lazyCpus wrapper: the first property access on any element reads native counters.
		const lazy = (): CpuInfo[] => {
			const array: CpuInfo[] = [];
			const populate = () => {
				for (let i = 0; i < 2; i++) array[i] = core(now, now);
			};
			for (let i = 0; i < 2; i++) {
				const read = (): CpuInfo => {
					if (array[i] === instance) populate();
					return array[i] as CpuInfo;
				};
				const instance: CpuInfo = {
					get model() {
						return read().model;
					},
					get speed() {
						return read().speed;
					},
					get times() {
						return read().times;
					},
				};
				array[i] = instance;
			}
			return array;
		};
		const stale = lazy();
		const before = cpuSnapshot(lazy());
		now = 100;
		const after = cpuSnapshot(lazy());
		expect(hostCpu(before, after)).toEqual({ state: "available", value: 50 });
		// The 0.1.0 failure: an unread stored array describes the later instant, never the earlier one.
		expect(hostCpu(stale, after)).toEqual({ state: "warming", reason: "CPU counters have not advanced" });
	});
	it("does not fabricate zero for PID reuse, first sample, reset or invalid time", () => {
		for (const before of [undefined, proc(100, 100, "12:49"), proc(101, 50), proc(90, 100), proc(90, Number.NaN)]) {
			expect(processCpu(before, proc(100, 100)).state).toBe("warming");
		}
	});
});

describe("privacy-safe native parsers", () => {
	it("parses Linux parentheses and exact start identity without assuming page size", () => {
		const fields = Array<string>(22).fill("0");
		fields[0] = "S";
		fields[1] = "1";
		fields[11] = "20";
		fields[12] = "30";
		fields[19] = "987654321987654321";
		const parsed = linuxStat(`12 (npm exec secret) ${fields.join(" ")}`, 100, 123);
		// User comm is process-writable (process.title, PR_SET_NAME): never reported as a name.
		expect(parsed).toMatchObject({
			pid: 12,
			parentPid: 1,
			name: "",
			identity: "12:987654321987654321",
			cpuMs: 500,
			at: 123,
		});
		expect(executableName("/usr/lib/node/bin/node (deleted)")).toBe("node");
		expect(executableName("/opt/a b/\u001b[2Jtool")).toBe("?[2Jtool");
		expect(safeName("\u{1F9A9}".repeat(200))).toHaveLength(256);
		expect(linuxRss("VmRSS:\t42 kB\n")).toBe(43008);
		expect(linuxRss("no RSS")).toBeNull();
		expect(linuxStat("12 malformed", 100, 1)).toBeNull();
		expect(linuxStat(`12 (name) ${fields.join(" ")}`, 0, 1)).toBeNull();
	});
	it("parses measured Darwin ps precision and strips control characters", () => {
		expect(darwinProcess("    1 0 Sat Oct  3 01:49:05 2026 185:32.40 17648 launchd         ", 12)).toMatchObject({
			pid: 1,
			identity: "1:Sat Oct  3 01:49:05 2026",
			rssBytes: 18071552,
			name: "launchd",
		});
		expect(darwinProcess("48488 48487 Thu Oct 22 20:28:58 2026 0:00.41 14384 ", 12)?.name).toBe("");
		expect(darwinProcess("truncated row", 1)).toBeNull();
		expect(safeName("/bin/test\u001b[2J")).toBe("test?[2J");
	});
	it("keeps native PSI semantics and rejects impossible or malformed values", () => {
		expect(
			psi("some avg10=1.25 avg60=0.00 avg300=0.05 total=42\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")?.some,
		).toEqual({ avg10: 1.25, avg60: 0, avg300: 0.05, total: 42 });
		expect(psi("some avg10=101 avg60=0 avg300=0 total=2")).toBeNull();
		expect(psi("unknown")).toBeNull();
	});
});

describe("bounded child lifecycle", () => {
	it("reaps the child on cancellation before returning", async () => {
		const controller = new AbortController();
		const budget = new Budget(performance.now() + 3000, 4096, 10, controller.signal);
		const pending = command(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"], budget);
		const readyDeadline = performance.now() + 2000;
		while (budget.bytesRead === 0 && performance.now() < readyDeadline) await delay(10);
		controller.abort();
		const result = await pending;
		const pid = Number(result.text.trim());
		expect(pid).toBeGreaterThan(0);
		expect(result.complete).toBe(false);
		expect(() => process.kill(pid, 0)).toThrow();
	});
	it("bounds bytes and duration for a noisy child", async () => {
		const budget = new Budget(performance.now() + 2000, 4096, 10, new AbortController().signal);
		const result = await command(
			process.execPath,
			["-e", "setInterval(() => process.stdout.write('x'.repeat(8192)), 1)"],
			budget,
		);
		expect(result.complete).toBe(false);
		expect(budget.bytesRead).toBe(4096);
		expect(budget.reasons.has("byte-limit")).toBe(true);
	});
	it("kills a silent child at the deadline and handles spawn failure", async () => {
		const budget = new Budget(performance.now() + 100, 4096, 10, new AbortController().signal);
		expect((await command(process.execPath, ["-e", "setInterval(() => {}, 1000)"], budget)).complete).toBe(false);
		expect(budget.reasons.has("deadline")).toBe(true);
		const failed = new Budget(performance.now() + 1000, 4096, 10, new AbortController().signal);
		expect((await command("/nonexistent-resource-sampler-fixture", [], failed)).complete).toBe(false);
		expect(failed.reasons.has("command-unavailable")).toBe(true);
	});
});

describe("sampler initialization", () => {
	it("rejects unsafe budgets before doing I/O", () => {
		for (const maxPids of [0, -1, 1.5, Number.NaN, 16385])
			expect(() => createResourceSampler({ maxPids })).toThrow(RangeError);
		expect(() => createResourceSampler({ maxBytes: 1 })).toThrow(RangeError);
		expect(() => createResourceSampler({ maxDurationMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
	});
});
