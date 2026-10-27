/**
 * Parsers for the Python toolchain's text output. Each one is defensive: a line that does not
 * match is kept as "unparsed" so nothing is silently lost when a tool changes its format.
 */

export interface Diagnostic {
	file: string;
	line: number;
	col: number;
	code: string;
	message: string;
	/** Ruff only: the diagnostic has an available fix. */
	fixable?: boolean;
	/** ty only. */
	severity?: "error" | "warning";
}

export interface ParsedDiagnostics {
	diagnostics: Diagnostic[];
	/** Summary or trailer lines, e.g. `Found 3 errors.` */
	trailer: string[];
	/** Lines that matched nothing. Non-empty means the format drifted. */
	unparsed: string[];
}

// `CODE` is a rule like `F401` or ruff's `invalid-syntax` pseudo-code for parse errors.
const RUFF_LINE = /^(.+?):(\d+):(\d+): ([A-Z]+\d+|invalid-syntax):? (\[\*\] )?(.*)$/;
const RUFF_TRAILER = /^(Found \d+ errors?|\[\*\] \d+ fixable|No fixes available|All checks passed!|\d+ fixable with)/;

/** `ruff check --output-format concise`. */
export function parseRuffConcise(text: string): ParsedDiagnostics {
	const out: ParsedDiagnostics = { diagnostics: [], trailer: [], unparsed: [] };
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		if (!line) continue;
		const m = RUFF_LINE.exec(line);
		if (m) {
			out.diagnostics.push({
				file: m[1] ?? "",
				line: Number(m[2]),
				col: Number(m[3]),
				code: m[4] ?? "",
				fixable: m[5] !== undefined,
				message: m[6] ?? "",
			});
		} else if (RUFF_TRAILER.test(line)) out.trailer.push(line);
		else out.unparsed.push(line);
	}
	return out;
}

const TY_LINE = /^(.+?):(\d+):(\d+): (error|warning)\[([^\]]+)\] (.*)$/;
const TY_TRAILER = /^(Found \d+ diagnostics?|All checks passed!|Hint: )/;

/** `ty check --output-format concise`. */
export function parseTyConcise(text: string): ParsedDiagnostics {
	const out: ParsedDiagnostics = { diagnostics: [], trailer: [], unparsed: [] };
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		if (!line) continue;
		const m = TY_LINE.exec(line);
		if (m) {
			out.diagnostics.push({
				file: m[1] ?? "",
				line: Number(m[2]),
				col: Number(m[3]),
				severity: m[4] as "error" | "warning",
				code: m[5] ?? "",
				message: m[6] ?? "",
			});
		} else if (TY_TRAILER.test(line)) out.trailer.push(line);
		else out.unparsed.push(line);
	}
	return out;
}

export interface PytestFailure {
	nodeid: string;
	message: string;
}

export interface PytestSummary {
	/** The final `N passed, M failed ... in Ts` line, or null when pytest never got there. */
	summary: string | null;
	counts: Record<string, number>;
	failures: PytestFailure[];
}

const PYTEST_SUMMARY = /^(?:=+ )?((?:\d+ [a-z]+(?:, )?)+) in [\d.]+s(?: \(.*\))?(?: =+)?$/;
// Node ids may contain spaces inside `[...]` parametrisation, so match up to ` - ` or the end.
const PYTEST_SHORT = /^(FAILED|ERROR) (.+?)(?: - (.*))?$/;

/** `pytest -q --tb=short`: the short summary block and the final counts line. */
export function parsePytest(text: string): PytestSummary {
	const out: PytestSummary = { summary: null, counts: {}, failures: [] };
	const lines = text.split("\n");
	const shortStart = lines.findIndex((l) => /short test summary info/.test(l));
	for (const raw of shortStart >= 0 ? lines.slice(shortStart + 1) : []) {
		const m = PYTEST_SHORT.exec(raw.trimEnd());
		if (m) out.failures.push({ nodeid: m[2] ?? "", message: m[3] ?? m[1] ?? "" });
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim() ?? "";
		const m = PYTEST_SUMMARY.exec(line);
		if (!m) continue;
		out.summary = line.replace(/^=+ | =+$/g, "");
		for (const part of (m[1] ?? "").split(", ")) {
			const [n, label] = part.trim().split(" ");
			if (n && label) out.counts[label] = Number(n);
		}
		break;
	}
	return out;
}

/** `ruff format --diff`: the files that would change, from `---`/`+++` header pairs. */
export function formatDiffFiles(diff: string): string[] {
	return [...diff.matchAll(/^--- (.+)\n\+\+\+ /gm)].map((m) => m[1] ?? "").filter((f) => f !== "");
}

/** `path:line:col CODE message` lines, capped. */
export function renderDiagnostics(diags: readonly Diagnostic[], limit: number): string[] {
	const shown = diags.slice(0, limit).map((d) => {
		const sev = d.severity ? `${d.severity}[${d.code}]` : d.code;
		return `${d.file}:${d.line}:${d.col} ${sev}${d.fixable ? " [fixable]" : ""} ${d.message}`;
	});
	if (diags.length > limit) shown.push(`... ${diags.length - limit} more`);
	return shown;
}
