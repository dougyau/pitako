// Adapted from nredd/pi-harness; MIT (Redd). See docs/provenance.json for source commits and test origins.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
	formatDiffFiles,
	parsePytest,
	parseRuffConcise,
	parseTyConcise,
	renderDiagnostics,
} from "../../extensions/dev-tools/py/parse.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "py", name), "utf8");

describe("parseRuffConcise (ruff 0.16.10)", () => {
	it("parses diagnostics, fixable markers and trailers with nothing unparsed", () => {
		const p = parseRuffConcise(fixture("ruff-concise.txt"));
		expect(p.unparsed).toEqual([]);
		expect(p.diagnostics).toHaveLength(4);
		expect(p.diagnostics[1]).toEqual({
			file: "src/pt/bad.py",
			line: 1,
			col: 8,
			code: "F401",
			fixable: true,
			message: "`os` imported but unused",
		});
		expect(p.trailer.some((t) => t.startsWith("Found 4 errors"))).toBe(true);
	});
	it("parses ruff's invalid-syntax pseudo-code", () => {
		const p = parseRuffConcise("/x/bad.py:1:7: invalid-syntax: Expected a parameter\nFound 1 error.\n");
		expect(p.diagnostics[0]).toMatchObject({ code: "invalid-syntax", line: 1, col: 7 });
		expect(p.unparsed).toEqual([]);
	});
	it("keeps unknown lines as unparsed", () => {
		const p = parseRuffConcise("warning: something new\nsrc/x.py:1:1: E501 Line too long\n");
		expect(p.diagnostics).toHaveLength(1);
		expect(p.diagnostics[0]?.fixable).toBe(false);
		expect(p.unparsed).toEqual(["warning: something new"]);
	});
});

describe("parseTyConcise (ty 0.0.85)", () => {
	it("parses severity, rule and message", () => {
		const p = parseTyConcise(fixture("ty-concise.txt"));
		expect(p.unparsed).toEqual([]);
		expect(p.diagnostics[0]).toEqual({
			file: "src/pt/bad.py",
			line: 3,
			col: 12,
			severity: "error",
			code: "invalid-return-type",
			message: "Return type does not match returned value: expected `str`, found `int`",
		});
		expect(p.trailer).toEqual(["Found 1 diagnostic"]);
	});
	it("parses warnings", () => {
		expect(parseTyConcise("a.py:1:1: warning[unused-ignore-comment] Unused\n").diagnostics[0]?.severity).toBe(
			"warning",
		);
	});
});

describe("parsePytest (pytest 9.1.1)", () => {
	it("reads the short summary and final counts", () => {
		const p = parsePytest(fixture("pytest-failures.txt"));
		expect(p.summary).toBe("2 failed, 1 passed in 0.01s");
		expect(p.counts).toEqual({ failed: 2, passed: 1 });
		expect(p.failures).toEqual([
			{ nodeid: "tests/test_a.py::test_fail", message: "AssertionError: math is hard" },
			{ nodeid: "tests/test_a.py::test_err", message: "ValueError: boom" },
		]);
	});
	it("keeps node ids that contain spaces", () => {
		const p = parsePytest(
			"=== short test summary info ===\nFAILED tests/t.py::test_p[x y] - assert 1 == 2\nERROR tests/u.py\n1 failed, 1 error in 0.1s\n",
		);
		expect(p.failures).toEqual([
			{ nodeid: "tests/t.py::test_p[x y]", message: "assert 1 == 2" },
			{ nodeid: "tests/u.py", message: "ERROR" },
		]);
	});
	it("handles no-tests and interrupted output", () => {
		expect(parsePytest("3 deselected in 0.00s\n").counts).toEqual({ deselected: 3 });
		const interrupted = parsePytest(
			"ERROR tests/test_c.py\n!!!! Interrupted: 1 error during collection !!!!\n1 error in 0.05s\n",
		);
		expect(interrupted.counts).toEqual({ error: 1 });
		expect(interrupted.summary).toBe("1 error in 0.05s");
	});
});

describe("formatDiffFiles and renderDiagnostics", () => {
	it("lists the files in a ruff format diff and ignores removed lines that look like headers", () => {
		expect(formatDiffFiles(fixture("ruff-format-diff.txt"))).toEqual(["src/pt/bad.py", "tests/test_a.py"]);
		expect(formatDiffFiles("--- a.py\n+++ a.py\n@@ -1 +1 @@\n--- foo\n+x\n")).toEqual(["a.py"]);
	});
	it("renders one line per diagnostic and caps", () => {
		const diags = parseRuffConcise(fixture("ruff-concise.txt")).diagnostics;
		const lines = renderDiagnostics(diags, 2);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("src/pt/bad.py:1:1 I001 [fixable] Import block is un-sorted or un-formatted");
		expect(lines[2]).toBe("... 2 more");
	});
});
