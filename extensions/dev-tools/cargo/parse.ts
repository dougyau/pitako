/**
 * Parsers for cargo's machine output: `--message-format=json-diagnostic-short` lines, nextest
 * junit, `cargo test --doc` text, `cargo fmt --check` diffs, and criterion estimates.
 */

export interface CargoDiagnostic {
	level: "error" | "warning";
	code: string | null;
	file: string | null;
	line: number | null;
	col: number | null;
	message: string;
	/** `rendered` from short mode: `file:line:col: level[code]: message`, one line. */
	rendered: string;
	suggestion: string | null;
}

export interface CargoMessages {
	diagnostics: CargoDiagnostic[];
	errors: number;
	warnings: number;
	/** From `build-finished`; null when cargo never got there. */
	success: boolean | null;
	/** Executable artifacts from `compiler-artifact` events. */
	executables: string[];
	/** Lines that were not JSON. */
	unparsed: string[];
}

interface Span {
	file_name: string;
	line_start: number;
	column_start: number;
	is_primary: boolean;
	suggested_replacement: string | null;
}
interface Message {
	level: string;
	message: string;
	code: { code: string } | null;
	rendered: string | null;
	spans: Span[];
	children: Message[];
}

/**
 * Key on `reason`, keep `error`/`warning`, dedupe (cargo emits one copy per target: lib, lib
 * test, bin...), drop `code.explanation`, and surface the first suggested replacement.
 */
export function parseCargoMessages(stdout: string): CargoMessages {
	const out: CargoMessages = { diagnostics: [], errors: 0, warnings: 0, success: null, executables: [], unparsed: [] };
	const seen = new Set<string>();
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		let event: { reason?: string; message?: Message; success?: boolean; executable?: string | null };
		try {
			event = JSON.parse(line);
		} catch {
			out.unparsed.push(line);
			continue;
		}
		if (event.reason === "build-finished") {
			out.success = event.success ?? null;
			continue;
		}
		if (event.reason === "compiler-artifact") {
			if (event.executable) out.executables.push(event.executable);
			continue;
		}
		if (event.reason !== "compiler-message" || !event.message) continue;
		const m = event.message;
		if (m.level !== "error" && m.level !== "warning") continue;
		const primary = m.spans.find((s) => s.is_primary) ?? m.spans[0];
		const code = m.code?.code ?? null;
		const key = `${m.level}|${code}|${primary?.file_name}|${primary?.line_start}|${primary?.column_start}|${m.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const suggestion =
			m.children.flatMap((c) => c.spans).find((s) => s.suggested_replacement !== null)?.suggested_replacement ?? null;
		const rendered = (m.rendered ?? "").trimEnd().split("\n")[0] || m.message;
		out.diagnostics.push({
			level: m.level,
			code,
			file: primary?.file_name ?? null,
			line: primary?.line_start ?? null,
			col: primary?.column_start ?? null,
			message: m.message,
			rendered,
			suggestion,
		});
		if (m.level === "error") out.errors += 1;
		else out.warnings += 1;
	}
	return out;
}

export interface TestFailure {
	name: string;
	/** `<failure message>`: the panic headline. */
	message: string;
	/** Trimmed failure body. */
	detail: string;
}

export interface JunitSummary {
	tests: number;
	failures: number;
	errors: number;
	skipped: number;
	failed: TestFailure[];
}

const decode = (s: string) =>
	s
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#10;/g, "\n")
		.replace(/&amp;/g, "&");

/** nextest's junit: `<testsuites>` totals and every `<testcase>` with a `<failure>`. */
export function parseJunit(xml: string): JunitSummary {
	const attr = (tag: string, name: string): number => {
		const m = new RegExp(`<${tag}[^>]*\\s${name}="(\\d+)"`).exec(xml);
		return m ? Number(m[1]) : 0;
	};
	const out: JunitSummary = {
		tests: attr("testsuites", "tests"),
		failures: attr("testsuites", "failures"),
		errors: attr("testsuites", "errors"),
		skipped: attr("testsuites", "skipped"),
		failed: [],
	};
	// Self-closing `<testcase .../>` entries are passes; drop them so a lazy match cannot span two cases.
	const cases = xml.replace(/<testcase\s[^>]*\/>/g, "").matchAll(/<testcase\s([^>]*)>([\s\S]*?)<\/testcase>/g);
	for (const [, attrs, body] of cases) {
		// `<failure>` is an assertion or panic, `<error>` a timeout or exec failure; both are red.
		// `<flakyFailure>` is a retry that eventually passed and does not count.
		const failure = /<(failure|error)(?:\s+message="([^"]*)")?[^>]*>([\s\S]*?)<\/\1>/.exec(body ?? "");
		if (!failure) continue;
		const name = /(?:^|\s)name="([^"]*)"/.exec(attrs ?? "")?.[1] ?? "?";
		const classname = /(?:^|\s)classname="([^"]*)"/.exec(attrs ?? "")?.[1];
		out.failed.push({
			name: classname ? `${classname} ${decode(name)}` : decode(name),
			message: decode(failure[2] ?? ""),
			detail: decode(failure[3] ?? "").trim(),
		});
	}
	return out;
}

export interface DoctestSummary {
	passed: number;
	failed: number;
	failedNames: string[];
}

/** `cargo test --doc` text: `test path - item (line N) ... ok|FAILED` and the `test result:` line. */
export function parseDoctests(text: string): DoctestSummary {
	const out: DoctestSummary = { passed: 0, failed: 0, failedNames: [] };
	for (const m of text.matchAll(/^test (.+?) \.\.\. FAILED$/gm)) out.failedNames.push(m[1] ?? "");
	for (const m of text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed;/gm)) {
		out.passed += Number(m[1]);
		out.failed += Number(m[2]);
	}
	return out;
}

/** `cargo fmt --check --color never`: the files with `Diff in <path>:<line>:` blocks. */
export function fmtDiffFiles(text: string): string[] {
	return [...new Set([...text.matchAll(/^Diff in (.+?):\d+:$/gm)].map((m) => m[1] ?? ""))];
}

export interface BenchEstimate {
	name: string;
	/** Point estimate of the mean, nanoseconds. */
	meanNs: number;
	lowerNs: number;
	upperNs: number;
	/** Fractional change of the mean vs the saved baseline, when criterion recorded one. */
	changePct: number | null;
}

interface Estimates {
	mean?: { point_estimate: number; confidence_interval: { lower_bound: number; upper_bound: number } };
}

/** `target/criterion/<id>/new/estimates.json` plus optional `change/estimates.json`. */
export function benchEstimate(name: string, newJson: string, changeJson: string | null): BenchEstimate | null {
	let est: Estimates;
	try {
		est = JSON.parse(newJson);
	} catch {
		return null;
	}
	if (!est.mean) return null;
	let changePct: number | null = null;
	if (changeJson) {
		try {
			const change = JSON.parse(changeJson) as Estimates;
			if (change.mean) changePct = change.mean.point_estimate * 100;
		} catch {
			changePct = null;
		}
	}
	return {
		name,
		meanNs: est.mean.point_estimate,
		lowerNs: est.mean.confidence_interval.lower_bound,
		upperNs: est.mean.confidence_interval.upper_bound,
		changePct,
	};
}

export function formatNs(ns: number): string {
	if (ns < 1_000) return `${ns.toFixed(2)} ns`;
	if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} us`;
	if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
	return `${(ns / 1_000_000_000).toFixed(3)} s`;
}
