/**
 * Python tools over uv: `py_lint` (ruff check), `py_format` (ruff format), `py_typecheck` (ty),
 * `py_test` (pytest), `py_uv` (sync/lock/add/remove).
 *
 * Every tool runs `uv run --frozen <tool>` from the project root so the project's own pinned
 * versions apply and `uv.lock` is never rewritten behind the caller's back. Calls on the same
 * project are serialized; uv and pytest do not like concurrent runs in one venv.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	abnormalExit,
	bound,
	failed,
	LockAbortedError,
	MUTATING,
	NETWORK,
	orFailure,
	progress,
	READ_ONLY,
	type RunResult,
	run,
	seconds,
	tailLines,
	timeoutMs,
	toolResult,
	withLock,
} from "../core/index.ts";
import {
	formatDiffFiles,
	type ParsedDiagnostics,
	parsePytest,
	parseRuffConcise,
	parseTyConcise,
	renderDiagnostics,
} from "./parse.ts";

const Cwd = Type.Optional(
	Type.String({
		description: "Directory inside the project. Default: the session cwd. Paths resolve against the project root.",
	}),
);
const Paths = Type.Optional(
	Type.Array(Type.String(), { description: "Files or directories, relative to the project root." }),
);
const Timeout = (def: number) =>
	Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: `Seconds. Default ${def}.` }));
const Limit = Type.Optional(
	Type.Integer({ minimum: 1, maximum: 500, description: "Max diagnostics shown. Default 50." }),
);
const DiagnosticSchema = Type.Object({
	file: Type.String(),
	line: Type.Integer(),
	col: Type.Integer(),
	code: Type.String(),
	message: Type.String(),
	fixable: Type.Optional(Type.Boolean()),
	severity: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warning")])),
});
const FindingsOut = orFailure(
	Type.Object({
		state: Type.Union(["clean", "findings", "unparsed"].map((s) => Type.Literal(s))),
		count: Type.Integer(),
		diagnostics: Type.Array(DiagnosticSchema),
		unparsed: Type.Array(Type.String()),
		fixed: Type.Optional(Type.Integer()),
	}),
);

/**
 * Walk up from `cwd` to the nearest `pyproject.toml`; that is the uv project root and lock key.
 * The walk stops at a `.git` boundary so a stray `~/pyproject.toml` cannot capture a repo.
 */
export function findProjectRoot(cwd: string): string | undefined {
	let dir: string;
	try {
		dir = realpathSync(resolve(cwd));
	} catch {
		return undefined;
	}
	for (;;) {
		if (existsSync(join(dir, "pyproject.toml"))) return dir;
		if (existsSync(join(dir, ".git"))) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** A value the model supplies as a positional must not be able to turn into a flag. */
function flagLike(values: readonly string[] | undefined, what: string): string | undefined {
	const bad = values?.find((v) => v.startsWith("-") || v.trim() === "");
	return bad === undefined ? undefined : `${what} '${bad}' must be a plain value`;
}

/**
 * uv itself failed (no lockfile, stale lockfile, tool not installed) rather than the tool it
 * ran. Matched on uv's own messages, not on any `error:` line: a pytest plugin can write
 * `error: ...` to stderr too.
 */
const UV_ERRORS =
	/^error: (Unable to find lockfile|The lockfile at .* needs to be updated|Failed to spawn|No `project` table|No `pyproject\.toml`|Failed to parse)/m;
function uvFailure(r: RunResult): string | undefined {
	const m = r.exitCode !== 0 ? UV_ERRORS.exec(r.stderr) : null;
	return m
		? `uv: ${m[0].replace(/^error: /, "")}${r.stderr.includes("Failed to spawn") ? " (is it in the project's dev dependencies?)" : ""}`
		: undefined;
}

export interface PyToolOptions {
	/** Test seam: the uv binary. */
	uvBin?: string;
}

interface UvRun {
	args: readonly string[];
	root: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onWait?: () => void;
}

export function registerPyTools(pi: ExtensionAPI, options: PyToolOptions = {}): void {
	const uv = options.uvBin ?? "uv";

	const uvRun = async (spec: UvRun): Promise<RunResult> => {
		try {
			return await withLock(
				`uv:${spec.root}`,
				() =>
					run({
						cmd: uv,
						args: spec.args,
						cwd: spec.root,
						env: { UV_NO_PROGRESS: "1", NO_COLOR: "1", PYTHONUNBUFFERED: "1" },
						timeoutMs: spec.timeoutMs,
						signal: spec.signal,
					}),
				{ onWait: spec.onWait, signal: spec.signal },
			);
		} catch (e) {
			if (!(e instanceof LockAbortedError)) throw e;
			return {
				exitCode: null,
				termSignal: null,
				stdout: "",
				stderr: "",
				stdoutDropped: 0,
				stderrDropped: 0,
				timedOut: false,
				aborted: true,
				durationMs: 0,
			};
		}
	};

	const project = (params: { cwd?: string }, ctx: { cwd: string }) => findProjectRoot(params.cwd ?? ctx.cwd);
	const noProject = (cwd: string) => failed(`no pyproject.toml found at or above ${cwd} (within the repository)`);
	const waiting = (update: Parameters<typeof progress>[0]) => () =>
		progress(update)("waiting for another uv run on this project");

	/** Shared shape for ruff check and ty: exit 0 clean, 1 findings, 2 tool error. */
	const findingsResult = async (
		r: RunResult,
		what: string,
		parsed: ParsedDiagnostics,
		limit: number,
		label: string,
		fixed?: number,
	) => {
		const abnormal = abnormalExit(r, what);
		if (abnormal) return failed(abnormal);
		const uvProblem = uvFailure(r);
		if (uvProblem) return failed(`${what}: ${uvProblem}`);
		if (r.exitCode !== 0 && r.exitCode !== 1) {
			const tail = await bound((r.stderr || r.stdout).trim(), { keep: "tail", label });
			return failed(`${what}: tool error (exit ${r.exitCode})\n${tail.text}`);
		}
		const extra = fixed === undefined ? {} : { fixed };
		if (r.exitCode === 1 && parsed.diagnostics.length === 0) {
			// Findings claimed but nothing parsed: the output format drifted. Show it raw, say so.
			const tail = await bound(`${r.stdout}\n${r.stderr}`.trim(), { keep: "tail", label });
			return toolResult({
				text: `${what}: exit 1 but no diagnostics could be parsed (format drift?)\n${tail.text}`,
				structured: { state: "unparsed", count: 0, diagnostics: [], unparsed: parsed.unparsed, ...extra },
				isError: true,
			});
		}
		const state = parsed.diagnostics.length === 0 ? "clean" : "findings";
		const n = parsed.diagnostics.length;
		const lines = [
			`${what}: ${state === "clean" ? "clean" : `${n} finding${n === 1 ? "" : "s"}`}${fixed !== undefined ? `, ${fixed} fixed` : ""} in ${seconds(r.durationMs)}`,
			...renderDiagnostics(parsed.diagnostics, limit),
		];
		if (parsed.unparsed.length > 0)
			lines.push(`unparsed output (${parsed.unparsed.length} lines):`, ...parsed.unparsed.slice(0, 10));
		const text = await bound(lines.join("\n"), { label, alreadyDropped: r.stdoutDropped });
		return toolResult({
			text: text.text,
			structured: { state, count: n, diagnostics: parsed.diagnostics, unparsed: parsed.unparsed, ...extra },
			isError: state !== "clean",
		});
	};

	pi.registerTool({
		name: "py_lint",
		label: "ruff check",
		description:
			"Run `ruff check` through the project's uv environment. Default is a read-only report; `fix: true` applies `--fix --ignore-noqa` (the repo gate's form) and reports what was fixed and what remains. States: clean, findings, tool error.",
		promptSnippet: "Lint Python with ruff (prefer over `bash uv run ruff check`)",
		annotations: MUTATING,
		parameters: Type.Object({
			cwd: Cwd,
			paths: Paths,
			fix: Type.Optional(Type.Boolean({ description: "Apply fixes with `--fix --ignore-noqa`. Mutates files." })),
			select: Type.Optional(Type.Array(Type.String(), { description: "Rule codes to select, e.g. `E`, `F401`." })),
			limit: Limit,
			timeout_s: Timeout(120),
		}),
		outputSchema: FindingsOut,
		async execute(_id, params, signal, update, ctx) {
			const root = project(params, ctx);
			if (!root) return noProject(params.cwd ?? ctx.cwd);
			const bad = flagLike(params.paths, "path") ?? flagLike(params.select, "rule");
			if (bad) return failed(bad);
			const args = ["run", "--frozen", "ruff", "check", "--output-format", "concise", "--no-cache"];
			if (params.fix) args.push("--fix", "--ignore-noqa");
			for (const rule of params.select ?? []) args.push(`--select=${rule}`);
			if (params.paths?.length) args.push("--", ...params.paths);
			const r = await uvRun({ args, root, timeoutMs: timeoutMs(params, 120), signal, onWait: waiting(update) });
			const parsed = parseRuffConcise(r.stdout);
			// ruff 0.16: `Found 4 errors (4 fixed, 0 remaining).`; `undefined` when the trailer is missing.
			const fixedMatch = params.fix ? /\((\d+) fixed, \d+ remaining\)/.exec(`${r.stdout}\n${r.stderr}`) : null;
			const fixed = params.fix ? (fixedMatch ? Number(fixedMatch[1]) : undefined) : undefined;
			return findingsResult(r, "ruff check", parsed, params.limit ?? 50, "py-lint", fixed);
		},
	});

	pi.registerTool({
		name: "py_format",
		label: "ruff format",
		description:
			"Check Python formatting with `ruff format`. `mode: check` lists files that would change, `diff` shows the diff, `apply` rewrites them.",
		promptSnippet: "Check or apply Python formatting (prefer over `bash uv run ruff format`)",
		annotations: MUTATING,
		parameters: Type.Object({
			cwd: Cwd,
			paths: Paths,
			mode: Type.Optional(
				Type.Union([Type.Literal("check"), Type.Literal("diff"), Type.Literal("apply")], {
					description: "Default check.",
				}),
			),
			timeout_s: Timeout(120),
		}),
		outputSchema: orFailure(
			Type.Object({
				state: Type.Union(["clean", "would-reformat", "reformatted"].map((s) => Type.Literal(s))),
				files: Type.Array(Type.String()),
				reformatted: Type.Optional(Type.Integer()),
			}),
		),
		async execute(_id, params, signal, update, ctx) {
			const root = project(params, ctx);
			if (!root) return noProject(params.cwd ?? ctx.cwd);
			const bad = flagLike(params.paths, "path");
			if (bad) return failed(bad);
			const mode = params.mode ?? "check";
			const args = ["run", "--frozen", "ruff", "format", "--no-cache"];
			if (mode !== "apply") args.push("--diff");
			if (params.paths?.length) args.push("--", ...params.paths);
			const r = await uvRun({ args, root, timeoutMs: timeoutMs(params, 120), signal, onWait: waiting(update) });
			const abnormal = abnormalExit(r, "ruff format");
			if (abnormal) return failed(abnormal);
			const uvProblem = uvFailure(r);
			if (uvProblem) return failed(`ruff format: ${uvProblem}`);
			if (r.exitCode !== 0 && r.exitCode !== 1)
				return failed(`ruff format: tool error (exit ${r.exitCode})\n${tailLines(r.stderr.trim(), 30)}`);
			if (mode === "apply") {
				const m = /^(\d+) files? reformatted/m.exec(`${r.stdout}\n${r.stderr}`);
				if (!m) {
					if (/left unchanged/.test(`${r.stdout}\n${r.stderr}`))
						return toolResult({
							text: "ruff format: nothing to reformat",
							structured: { state: "clean", files: [], reformatted: 0 },
						});
					return failed(
						`ruff format: could not read the summary line\n${tailLines(`${r.stdout}\n${r.stderr}`.trim(), 10)}`,
					);
				}
				const reformatted = Number(m[1]);
				return toolResult({
					text: `ruff format: ${reformatted} file${reformatted === 1 ? "" : "s"} reformatted`,
					structured: { state: reformatted === 0 ? "clean" : "reformatted", files: [], reformatted },
				});
			}
			const files = formatDiffFiles(r.stdout);
			if (files.length === 0)
				return toolResult({ text: "ruff format: clean", structured: { state: "clean", files: [] } });
			const head = `ruff format: ${files.length} file${files.length === 1 ? "" : "s"} would be reformatted\n${files.map((f) => `  ${f}`).join("\n")}`;
			if (mode === "check")
				return toolResult({ text: head, structured: { state: "would-reformat", files }, isError: true });
			const diff = await bound(r.stdout, { label: "py-format", alreadyDropped: r.stdoutDropped });
			return toolResult({
				text: `${head}\n\n${diff.text}`,
				structured: { state: "would-reformat", files },
				isError: true,
			});
		},
	});

	pi.registerTool({
		name: "py_typecheck",
		label: "ty check",
		description: "Type-check with `ty check` through the project's uv environment; one line per diagnostic.",
		promptSnippet: "Type-check Python with ty (prefer over `bash uv run ty check`)",
		annotations: READ_ONLY,
		parameters: Type.Object({ cwd: Cwd, paths: Paths, limit: Limit, timeout_s: Timeout(300) }),
		outputSchema: FindingsOut,
		async execute(_id, params, signal, update, ctx) {
			const root = project(params, ctx);
			if (!root) return noProject(params.cwd ?? ctx.cwd);
			const bad = flagLike(params.paths, "path");
			if (bad) return failed(bad);
			const args = ["run", "--frozen", "ty", "check", "--output-format", "concise"];
			if (params.paths?.length) args.push("--", ...params.paths);
			const r = await uvRun({ args, root, timeoutMs: timeoutMs(params, 300), signal, onWait: waiting(update) });
			return findingsResult(r, "ty check", parseTyConcise(r.stdout), params.limit ?? 50, "py-typecheck");
		},
	});

	const TestState = Type.Union(
		["passed", "failed", "interrupted", "usage-error", "no-tests"].map((s) => Type.Literal(s)),
	);
	pi.registerTool({
		name: "py_test",
		label: "pytest",
		description:
			"Run pytest through the project's uv environment (`--tb=short`, quiet). Passing tests are never listed. Exit codes become states: passed, failed, interrupted (collection error), usage-error, no-tests.",
		promptSnippet: "Run Python tests (prefer over `bash uv run pytest`)",
		annotations: READ_ONLY,
		parameters: Type.Object({
			cwd: Cwd,
			targets: Type.Optional(Type.Array(Type.String(), { description: "Files, directories or node ids." })),
			k: Type.Optional(Type.String({ description: "`-k` expression." })),
			markers: Type.Optional(Type.String({ description: "`-m` expression." })),
			maxfail: Type.Optional(Type.Integer({ minimum: 1, description: "Stop after this many failures. Default 5." })),
			last_failed: Type.Optional(Type.Boolean({ description: "`--lf` (keeps `.pytest_cache`)." })),
			coverage: Type.Optional(Type.Boolean({ description: "Add `--cov=src --cov-report=term-missing`." })),
			timeout_s: Timeout(600),
		}),
		outputSchema: orFailure(
			Type.Object({
				state: TestState,
				exit: Type.Integer(),
				counts: Type.Record(Type.String(), Type.Integer()),
				failures: Type.Array(Type.Object({ nodeid: Type.String(), message: Type.String() })),
				summary: Type.Union([Type.String(), Type.Null()]),
				stoppedEarly: Type.Boolean(),
			}),
		),
		async execute(_id, params, signal, update, ctx) {
			const root = project(params, ctx);
			if (!root) return noProject(params.cwd ?? ctx.cwd);
			const bad = flagLike(params.targets, "target");
			if (bad) return failed(bad);
			// `--verbosity=-1` is an absolute setting, so a project `addopts = "-q"` cannot push the run
			// to -qq and drop the summary line. `--lf` needs the cache plugin; otherwise keep the tree clean.
			const cache = params.last_failed ? ["--lf"] : ["-p", "no:cacheprovider"];
			const maxfail = params.maxfail ?? 5;
			const args = ["run", "--frozen", "pytest", "--verbosity=-1", "--tb=short", ...cache, `--maxfail=${maxfail}`];
			if (params.k) args.push(`-k=${params.k}`);
			if (params.markers) args.push(`-m=${params.markers}`);
			if (params.coverage) args.push("--cov=src", "--cov-report=term-missing");
			if (params.targets?.length) args.push("--", ...params.targets);
			const r = await uvRun({ args, root, timeoutMs: timeoutMs(params, 600), signal, onWait: waiting(update) });
			const abnormal = abnormalExit(r, "pytest");
			if (abnormal) return failed(`${abnormal}\n${tailLines(r.stdout, 20)}`);
			const uvProblem = uvFailure(r);
			if (uvProblem) return failed(`pytest: ${uvProblem}`);
			const parsed = parsePytest(r.stdout);
			const states: Record<number, "passed" | "failed" | "interrupted" | "usage-error" | "no-tests"> = {
				0: "passed",
				1: "failed",
				2: "interrupted",
				4: "usage-error",
				5: "no-tests",
			};
			const state = states[r.exitCode ?? -1];
			if (!state)
				return failed(`pytest: unexpected exit ${r.exitCode}\n${tailLines(`${r.stdout}\n${r.stderr}`.trim(), 30)}`);
			const stoppedEarly = (parsed.counts.failed ?? 0) >= maxfail || /stopping after \d+ failures/.test(r.stdout);
			const lines = [
				`pytest: ${state}${parsed.summary ? ` (${parsed.summary})` : ""}${stoppedEarly ? ", stopped at --maxfail" : ""} in ${seconds(r.durationMs)}`,
			];
			if (state === "passed") {
				const cov = r.stdout.match(/^TOTAL\s.*$/m);
				if (cov) lines.push(cov[0]);
			} else if (state === "failed") {
				for (const f of parsed.failures) lines.push(`  ${f.nodeid}: ${f.message}`);
				const detail = r.stdout.split(/^=+ short test summary info =+$/m)[0] ?? r.stdout;
				const tail = await bound(`${detail.trimEnd()}\n${r.stderr.trim()}`.trimEnd(), {
					keep: "tail",
					label: "py-test",
					alreadyDropped: r.stdoutDropped,
				});
				lines.push("", tail.text);
			} else {
				const tail = await bound(`${r.stdout}\n${r.stderr}`.trim(), {
					keep: "tail",
					label: "py-test",
					alreadyDropped: r.stdoutDropped,
				});
				lines.push(tail.text);
			}
			return toolResult({
				text: lines.join("\n"),
				structured: {
					state,
					exit: r.exitCode ?? -1,
					counts: parsed.counts,
					failures: parsed.failures,
					summary: parsed.summary,
					stoppedEarly,
				},
				isError: state === "failed" || state === "interrupted" || state === "usage-error",
			});
		},
	});

	pi.registerTool({
		name: "py_uv",
		label: "uv",
		description:
			"Manage the uv environment: `sync` (default `--all-extras --all-groups`), `lock`, `add`, `remove`. Reaches the network. `locked: true` fails loudly on a stale lockfile instead of re-resolving.",
		promptSnippet: "Sync or change Python dependencies with uv (prefer over `bash uv sync`)",
		annotations: NETWORK,
		parameters: Type.Object({
			cwd: Cwd,
			action: Type.Union([Type.Literal("sync"), Type.Literal("lock"), Type.Literal("add"), Type.Literal("remove")]),
			packages: Type.Optional(Type.Array(Type.String(), { description: "For add/remove." })),
			group: Type.Optional(Type.String({ description: "Dependency group for add/remove." })),
			dev: Type.Optional(Type.Boolean({ description: "`--dev` for add/remove." })),
			all_extras: Type.Optional(Type.Boolean({ description: "sync: `--all-extras`. Default true." })),
			all_groups: Type.Optional(Type.Boolean({ description: "sync: `--all-groups`. Default true." })),
			locked: Type.Optional(Type.Boolean({ description: "sync/lock: `--locked`, fail if uv.lock is stale." })),
			timeout_s: Timeout(600),
		}),
		outputSchema: orFailure(Type.Object({ action: Type.String(), state: Type.Literal("ok"), summary: Type.String() })),
		async execute(_id, params, signal, update, ctx) {
			const root = project(params, ctx);
			if (!root) return noProject(params.cwd ?? ctx.cwd);
			const args: string[] = [params.action];
			if (params.action === "sync") {
				if (params.all_extras ?? true) args.push("--all-extras");
				if (params.all_groups ?? true) args.push("--all-groups");
			}
			if ((params.action === "sync" || params.action === "lock") && params.locked) args.push("--locked");
			if (params.action === "add" || params.action === "remove") {
				if (!params.packages?.length) return failed(`${params.action} needs at least one package`);
				const bad =
					flagLike(params.packages, "package") ?? (params.group ? flagLike([params.group], "group") : undefined);
				if (bad) return failed(bad);
				if (params.dev) args.push("--dev");
				if (params.group) args.push("--group", params.group);
				args.push("--", ...params.packages);
			}
			const r = await uvRun({ args, root, timeoutMs: timeoutMs(params, 600), signal, onWait: waiting(update) });
			const abnormal = abnormalExit(r, `uv ${params.action}`);
			if (abnormal) return failed(abnormal);
			const output = `${r.stdout}\n${r.stderr}`.trim();
			if (r.exitCode !== 0) {
				const tail = await bound(output, { keep: "tail", label: "py-uv" });
				return failed(`uv ${params.action}: exit ${r.exitCode}\n${tail.text}`);
			}
			const summary = output
				.split("\n")
				.filter((l) => /^(Resolved|Installed|Uninstalled|Audited|Prepared|Added|Removed|Updated)\b/.test(l.trim()))
				.map((l) => l.trim());
			const text = `uv ${params.action}: ok in ${seconds(r.durationMs)}${summary.length ? `\n${summary.join("\n")}` : ""}`;
			return toolResult({ text, structured: { action: params.action, state: "ok", summary: summary.join("\n") } });
		},
	});
}
