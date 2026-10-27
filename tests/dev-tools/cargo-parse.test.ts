// Adapted from nredd/pi-harness; MIT (Redd). See docs/provenance.json for source commits and test origins.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
	benchEstimate,
	fmtDiffFiles,
	formatNs,
	parseCargoMessages,
	parseDoctests,
	parseJunit,
} from "../../extensions/dev-tools/cargo/parse.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "cargo", name), "utf8");

describe("parseCargoMessages (cargo 1.99 json-diagnostic-short)", () => {
	it("keeps errors and warnings, reads build-finished, and surfaces suggestions", () => {
		const p = parseCargoMessages(fixture("check.jsonl"));
		expect(p.success).toBe(false);
		expect(p.errors).toBe(1);
		expect(p.warnings).toBe(1);
		expect(p.unparsed).toEqual([]);
		const err = p.diagnostics.find((d) => d.level === "error");
		expect(err).toMatchObject({ code: "E0308", file: "bad/src/lib.rs", line: 3, col: 21, suggestion: ".to_string()" });
		expect(err?.rendered).toBe("bad/src/lib.rs:3:21: error[E0308]: mismatched types: expected `String`, found integer");
		const warn = p.diagnostics.find((d) => d.level === "warning");
		expect(warn).toMatchObject({ code: "unused_variables", suggestion: "_unused" });
	});

	it("dedupes the per-target copies clippy emits", () => {
		const p = parseCargoMessages(fixture("clippy-good.jsonl"));
		expect(p.success).toBe(true);
		expect(p.diagnostics).toHaveLength(2);
		expect(p.diagnostics.map((d) => d.code)).toEqual(["unused_variables", "clippy::cast_possible_truncation"]);
	});

	it("keeps non-JSON lines as unparsed and tolerates missing fields", () => {
		const p = parseCargoMessages(
			'garbage\n{"reason":"compiler-message","message":{"level":"error","message":"x","code":null,"rendered":null,"spans":[],"children":[]}}\n',
		);
		expect(p.unparsed).toEqual(["garbage"]);
		expect(p.diagnostics[0]).toMatchObject({ code: null, file: null, rendered: "x" });
	});
});

describe("parseJunit (nextest 0.9.148)", () => {
	it("reads totals and failures with decoded messages", () => {
		const j = parseJunit(fixture("nextest-junit.xml"));
		expect(j).toMatchObject({ tests: 2, failures: 1, errors: 0, skipped: 0 });
		expect(j.failed).toHaveLength(1);
		expect(j.failed[0]?.name).toBe("good tests::fails");
		expect(j.failed[0]?.message).toMatch(/^thread 'tests::fails' .* panicked at good\/src\/lib\.rs:27:9/);
		expect(j.failed[0]?.detail).toContain("math is hard");
	});
	it("counts <error> cases separately and lists flaky retries once", () => {
		const xml = `<testsuites name="x" tests="3" failures="1" errors="1" skipped="0"><testsuite name="s">
<testcase name="a" classname="c"><failure message="m1">body</failure></testcase>
<testcase name="b" classname="c"><error message="timed out" type="timeout">t</error></testcase>
<testcase name="d" classname="c"><flakyFailure message="first try">x</flakyFailure></testcase>
</testsuite></testsuites>`;
		const j = parseJunit(xml);
		expect(j).toMatchObject({ tests: 3, failures: 1, errors: 1 });
		expect(j.failed.map((f) => f.name)).toEqual(["c a", "c b"]);
		expect(j.failed[1]?.message).toBe("timed out");
	});
	it("handles an empty suite", () => {
		expect(
			parseJunit('<testsuites name="x" tests="0" failures="0" errors="0" skipped="0"></testsuites>').failed,
		).toEqual([]);
	});
});

describe("parseDoctests", () => {
	it("counts passes and names failures", () => {
		expect(parseDoctests(fixture("doctest.txt"))).toEqual({ passed: 1, failed: 0, failedNames: [] });
		expect(
			parseDoctests(
				"test src/lib.rs - add (line 4) ... FAILED\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.1s\n",
			),
		).toEqual({
			passed: 0,
			failed: 1,
			failedNames: ["src/lib.rs - add (line 4)"],
		});
	});
});

describe("fmtDiffFiles", () => {
	it("lists each file once", () => {
		expect(fmtDiffFiles(fixture("fmt-check.txt"))).toEqual([
			"/private/tmp/ws/good/benches/b.rs",
			"/private/tmp/ws/good/src/ugly.rs",
		]);
	});
});

describe("benchEstimate and formatNs", () => {
	it("reads criterion estimates in ns and change as a fraction", () => {
		const est = benchEstimate(
			"add",
			JSON.stringify({
				mean: { point_estimate: 417.19, confidence_interval: { lower_bound: 415.99, upper_bound: 418.35 } },
			}),
			JSON.stringify({ mean: { point_estimate: 0.0033 } }),
		);
		expect(est).toMatchObject({ name: "add", meanNs: 417.19, lowerNs: 415.99, upperNs: 418.35 });
		expect(est?.changePct).toBeCloseTo(0.33);
		expect(benchEstimate("x", "not json", null)).toBeNull();
		expect(benchEstimate("x", "{}", null)).toBeNull();
	});
	it("formats durations", () => {
		expect(formatNs(417.19)).toBe("417.19 ns");
		expect(formatNs(12_345)).toBe("12.35 us");
		expect(formatNs(3_400_000)).toBe("3.40 ms");
		expect(formatNs(2_500_000_000)).toBe("2.500 s");
	});
});
