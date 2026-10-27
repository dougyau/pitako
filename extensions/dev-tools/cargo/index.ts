/**
 * cargo tools: `cargo_check`, `cargo_clippy`, `cargo_fmt`, `cargo_test`, `cargo_build`,
 * `cargo_run`, `cargo_doc`, `cargo_bench`, `cargo_add`.
 *
 * Defaults mirror the user's Makefile: `--all-targets --all-features`, pedantic clippy, nextest.
 * Calls on one workspace are serialized through the shared lock; concurrent cargo invocations
 * otherwise block each other on the build-directory file lock with no feedback.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	abnormalExit,
	bound,
	capList,
	failed,
	LockAbortedError,
	MUTATING,
	NETWORK,
	orFailure,
	progress,
	READ_ONLY,
	type RunOptions,
	type RunResult,
	run,
	seconds,
	tailLines,
	timeoutMs,
	toolResult,
	withLock,
} from "../core/index.ts";
import {
	type BenchEstimate,
	benchEstimate,
	type CargoMessages,
	fmtDiffFiles,
	formatNs,
	parseCargoMessages,
	parseDoctests,
	parseJunit,
} from "./parse.ts";

const Cwd = Type.Optional(Type.String({ description: "Directory inside the workspace. Default: the session cwd." }));
const Package = Type.Optional(Type.String({ description: "`-p <package>`. Default: the whole workspace." }));
const Features = Type.Optional(Type.Array(Type.String(), { description: "`--features`. Default: `--all-features`." }));
const Toolchain = Type.Optional(Type.String({ description: "Run through `rustup run <toolchain> cargo`." }));
const Timeout = (def: number) =>
	Type.Optional(Type.Integer({ minimum: 1, maximum: 7200, description: `Seconds. Default ${def}.` }));
const Limit = Type.Optional(
	Type.Integer({ minimum: 1, maximum: 500, description: "Max diagnostics shown. Default 50." }),
);
const DiagnosticSchema = Type.Object({
	level: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
	code: Type.Union([Type.String(), Type.Null()]),
	file: Type.Union([Type.String(), Type.Null()]),
	line: Type.Union([Type.Integer(), Type.Null()]),
	col: Type.Union([Type.Integer(), Type.Null()]),
	message: Type.String(),
	rendered: Type.String(),
	suggestion: Type.Union([Type.String(), Type.Null()]),
});
const DiagnosticsOut = orFailure(
	Type.Object({
		state: Type.Union(["clean", "warnings", "errors"].map((s) => Type.Literal(s))),
		errors: Type.Integer(),
		warnings: Type.Integer(),
		diagnostics: Type.Array(DiagnosticSchema),
	}),
);

const LOCK_LINE = /Blocking waiting for file lock/;
/** Package names, feature names, toolchains, bins: plain identifiers plus the path-ish characters cargo uses. */
const SAFE_ARG = /^[A-Za-z0-9_][A-Za-z0-9._+:/=,@?*-]*$/;
/** Crate specs for `cargo add` also carry version requirements: `serde@^1`, `tokio@>=1,<2`. */
const SAFE_CRATE = /^[A-Za-z0-9_][A-Za-z0-9._+:/=,@?*<>^~-]*$/;

/** Walk up from `cwd` to the outermost `Cargo.toml` with `[workspace]`, else the nearest one. */
export function findWorkspaceRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	let nearest: string | undefined;
	for (;;) {
		const manifest = join(dir, "Cargo.toml");
		if (existsSync(manifest)) {
			nearest ??= dir;
			if (/^\[workspace\]/m.test(readFileSync(manifest, "utf8"))) return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) return nearest;
		dir = parent;
	}
}

/** Values the model supplies as bare arguments must not be able to turn into flags. */
function badValue(values: readonly (string | undefined)[], what = "value", shape = SAFE_ARG): string | undefined {
	for (const v of values) if (v !== undefined && !shape.test(v)) return `${what} '${v}' is not a plain value`;
	return undefined;
}
/** Filters and positionals after `--`: anything but a leading `-` or an empty string. */
function badPositional(value: string | undefined, what: string): string | undefined {
	if (value === undefined) return undefined;
	if (value.trim() === "" || value.startsWith("-")) return `${what} must be a plain value`;
	return undefined;
}

/** A nextest filterset expression rather than a bare substring: any operator, paren, or a leading `not`. */
function isFilterset(filter: string): boolean {
	return /[()|&!]/.test(filter) || /^\s*not\s/.test(filter);
}

/** Relative `CARGO_TARGET_DIR` is relative to the invocation cwd, which is the workspace root here. */
function targetDir(root: string): string {
	const env = process.env.CARGO_TARGET_DIR;
	return env ? resolve(root, env) : join(root, "target");
}

export interface CargoToolOptions {
	/** Test seam: the cargo binary. */
	cargoBin?: string;
	/** Test seam: the rustup binary. */
	rustupBin?: string;
}

interface CargoRun {
	args: readonly string[];
	root: string;
	timeoutMs: number;
	signal?: AbortSignal;
	toolchain?: string;
	env?: Record<string, string>;
	stdin?: string;
	onProgress?: (text: string) => void;
}

export function registerCargoTools(pi: ExtensionAPI, options: CargoToolOptions = {}): void {
	const cargoBin = options.cargoBin ?? "cargo";
	const rustupBin = options.rustupBin ?? "rustup";

	const cargo = (spec: CargoRun): Promise<RunResult> => {
		const cmd = spec.toolchain ? rustupBin : cargoBin;
		const args = spec.toolchain ? ["run", spec.toolchain, "cargo", ...spec.args] : [...spec.args];
		const opts: RunOptions = {
			cmd,
			args,
			cwd: spec.root,
			env: { CARGO_TERM_COLOR: "never", NO_COLOR: "1", ...spec.env },
			timeoutMs: spec.timeoutMs,
			signal: spec.signal,
			stdin: spec.stdin,
			onStderrLine: (line) => {
				if (LOCK_LINE.test(line))
					spec.onProgress?.("waiting for cargo's build-directory lock (another cargo is running)");
				else if (/^\s+Compiling /.test(line)) spec.onProgress?.(line.trim());
			},
		};
		return withLock(`cargo:${spec.root}`, () => run(opts), {
			signal: spec.signal,
			onWait: () => spec.onProgress?.("queued behind another cargo call on this workspace"),
		}).catch((e: unknown) => {
			if (!(e instanceof LockAbortedError)) throw e;
			const aborted: RunResult = {
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
			return aborted;
		});
	};

	const workspace = (params: { cwd?: string }, ctx: { cwd: string }) => findWorkspaceRoot(params.cwd ?? ctx.cwd);
	const noWorkspace = (cwd: string) => failed(`no Cargo.toml found at or above ${cwd}`);
	const featureArgs = (p: { features?: string[]; all_features?: boolean }) =>
		p.features?.length ? ["--features", p.features.join(",")] : (p.all_features ?? true) ? ["--all-features"] : [];

	/** Shared shape for check/clippy/build/doc: compile diagnostics with warnings counted even at exit 0. */
	const diagnosticsResult = async (
		r: RunResult,
		what: string,
		parsed: CargoMessages,
		limit: number,
		label: string,
		extraText: string[] = [],
		extra: Record<string, unknown> = {},
	) => {
		const abnormal = abnormalExit(r, what);
		if (abnormal) return failed(`${abnormal}\n${tailLines(r.stderr.trim(), 20)}`);
		if (r.exitCode !== 0 && parsed.errors === 0) {
			// Manifest errors, missing toolchain, lock problems: cargo spoke on stderr, not in JSON.
			const tail = await bound(r.stderr.trim(), { keep: "tail", label });
			return failed(`${what}: cargo exited ${r.exitCode} with no compiler errors\n${tail.text}`);
		}
		const state = parsed.errors > 0 ? "errors" : parsed.warnings > 0 ? "warnings" : "clean";
		const sorted = [...parsed.diagnostics].sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
		const { kept, dropped } = capList(sorted, limit);
		const lines = [
			`${what}: ${state === "clean" ? "clean" : `${parsed.errors} error${parsed.errors === 1 ? "" : "s"}, ${parsed.warnings} warning${parsed.warnings === 1 ? "" : "s"}`} in ${seconds(r.durationMs)}`,
			...kept.map(
				(d) =>
					`${d.rendered}${d.suggestion ? `  (suggestion: ${d.suggestion.replace(/\n/g, "\\n").slice(0, 80)})` : ""}`,
			),
			...(dropped ? [`... ${dropped} more`] : []),
			...extraText,
		];
		const text = await bound(lines.join("\n"), { label });
		return toolResult({
			text: text.text,
			structured: {
				state,
				errors: parsed.errors,
				warnings: parsed.warnings,
				diagnostics: parsed.diagnostics,
				...extra,
			},
			isError: state === "errors",
		});
	};

	pi.registerTool({
		name: "cargo_check",
		label: "cargo check",
		description:
			"Compile-check the workspace (`--all-targets --all-features` by default); diagnostics deduped across targets, one line each with the first suggested fix. Warnings are counted even though cargo exits 0.",
		promptSnippet: "Type-check Rust (prefer over `bash cargo check`)",
		annotations: READ_ONLY,
		parameters: Type.Object({
			cwd: Cwd,
			package: Package,
			features: Features,
			all_features: Type.Optional(Type.Boolean({ description: "Default true." })),
			all_targets: Type.Optional(Type.Boolean({ description: "Default true." })),
			toolchain: Toolchain,
			limit: Limit,
			timeout_s: Timeout(600),
		}),
		outputSchema: DiagnosticsOut,
		async execute(_id, params, signal, update, ctx) {
			const root = workspace(params, ctx);
			if (!root) return noWorkspace(params.cwd ?? ctx.cwd);
			const bad = badValue([params.package, params.toolchain, ...(params.features ?? [])]);
			if (bad) return failed(bad);
			const args = ["check", "--message-format=json-diagnostic-short", ...featureArgs(params)];
			if (params.all_targets ?? true) args.push("--all-targets");
			if (params.package) args.push("-p", params.package);
			const r = await cargo({
				args,
				root,
				timeoutMs: timeoutMs(params, 600),
				signal,
				toolchain: params.toolchain,
				onProgress: progress(update),
			});
			return diagnosticsResult(r, "cargo check", parseCargoMessages(r.stdout), params.limit ?? 50, "cargo-check");
		},
	});

	pi.registerTool({
		name: "cargo_clippy",
		label: "cargo clippy",
		description:
			"Lint with clippy (`--all-targets --all-features -- -W clippy::pedantic`, the repo gate's form). `fix: true` applies machine-applicable fixes (`--fix --allow-dirty --allow-staged`). `deny_warnings` turns warnings into errors.",
		promptSnippet: "Lint Rust with clippy (prefer over `bash cargo clippy`)",
		annotations: MUTATING,
		parameters: Type.Object({
			cwd: Cwd,
			package: Package,
			features: Features,
			all_features: Type.Optional(Type.Boolean({ description: "Default true." })),
			pedantic: Type.Optional(Type.Boolean({ description: "Add `-W clippy::pedantic`. Default true." })),
			fix: Type.Optional(Type.Boolean({ description: "`--fix --allow-dirty`. Mutates files." })),
			deny_warnings: Type.Optional(Type.Boolean({ description: "`-D warnings`." })),
			toolchain: Toolchain,
			limit: Limit,
			timeout_s: Timeout(600),
		}),
		outputSchema: DiagnosticsOut,
		async execute(_id, params, signal, update, ctx) {
			const root = workspace(params, ctx);
			if (!root) return noWorkspace(params.cwd ?? ctx.cwd);
			const bad = badValue([params.package, params.toolchain, ...(params.features ?? [])]);
			if (bad) return failed(bad);
			const args = ["clippy", "--message-format=json-diagnostic-short", "--all-targets", ...featureArgs(params)];
			if (params.package) args.push("-p", params.package);
			if (params.fix) args.push("--fix", "--allow-dirty", "--allow-staged");
			const lints: string[] = [];
			if (params.pedantic ?? true) lints.push("-W", "clippy::pedantic");
			if (params.deny_warnings) lints.push("-D", "warnings");
			if (lints.length) args.push("--", ...lints);
			const r = await cargo({
				args,
				root,
				timeoutMs: timeoutMs(params, 600),
				signal,
				toolchain: params.toolchain,
				onProgress: progress(update),
			});
			return diagnosticsResult(r, "cargo clippy", parseCargoMessages(r.stdout), params.limit ?? 50, "cargo-clippy");
		},
	});

	pi.registerTool({
		name: "cargo_fmt",
		label: "cargo fmt",
		description: "Check formatting with `cargo fmt --all -- --check` (default) or apply it with `check: false`.",
		promptSnippet: "Check or apply Rust formatting (prefer over `bash cargo fmt`)",
		annotations: MUTATING,
		parameters: Type.Object({
			cwd: Cwd,
			package: Package,
			check: Type.Optional(Type.Boolean({ description: "Default true: report, do not write." })),
			toolchain: Toolchain,
			timeout_s: Timeout(120),
		}),
		outputSchema: orFailure(
			Type.Object({
				state: Type.Union(["clean", "would-reformat", "reformatted"].map((s) => Type.Literal(s))),
				files: Type.Array(Type.String()),
			}),
		),
		async execute(_id, params, signal, _update, ctx) {
			const root = workspace(params, ctx);
			if (!root) return noWorkspace(params.cwd ?? ctx.cwd);
			const bad = badValue([params.package, params.toolchain]);
			if (bad) return failed(bad);
			const check = params.check ?? true;
			const args = ["fmt", ...(params.package ? ["-p", params.package] : ["--all"]), "--", "--color", "never"];
			if (check) args.push("--check");
			const r = await cargo({
				args,
				root,
				timeoutMs: timeoutMs(params, 120),
				signal,
				toolchain: params.toolchain,
			});
			const abnormal = abnormalExit(r, "cargo fmt");
			if (abnormal) return failed(abnormal);
			const files = fmtDiffFiles(r.stdout);
			if (r.exitCode !== 0 && files.length === 0)
				return failed(`cargo fmt: exit ${r.exitCode}\n${tailLines(r.stderr.trim(), 30)}`);
			if (!check) {
				return toolResult({ text: "cargo fmt: applied", structured: { state: "reformatted", files: [] } });
			}
			if (files.length === 0)
				return toolResult({ text: "cargo fmt: clean", structured: { state: "clean", files: [] } });
			const diff = await bound(r.stdout, { label: "cargo-fmt", alreadyDropped: r.stdoutDropped });
			return toolResult({
				text: `cargo fmt: ${files.length} file${files.length === 1 ? "" : "s"} would be reformatted\n${files.map((f) => `  ${f}`).join("\n")}\n\n${diff.text}`,
				structured: { state: "would-reformat", files },
				isError: true,
			});
		},
	});

	pi.registerTool({
		name: "cargo_test",
		label: "cargo test",
		description:
			"Run tests with nextest (junit-parsed; passing tests are never listed), then doctests with `cargo test --doc`. Exit codes become states: passed, failed, no-tests, compile-error.",
		promptSnippet: "Run Rust tests (prefer over `bash cargo test`)",
		annotations: READ_ONLY,
		parameters: Type.Object({
			cwd: Cwd,
			package: Package,
			features: Features,
			all_features: Type.Optional(Type.Boolean({ description: "Default true." })),
			filter: Type.Optional(Type.String({ description: "nextest filter expression or test name substring." })),
			no_fail_fast: Type.Optional(Type.Boolean({ description: "Default true." })),
			doc: Type.Optional(Type.Boolean({ description: "Also run doctests. Default true." })),
			retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
			nocapture: Type.Optional(Type.Boolean()),
			toolchain: Toolchain,
			timeout_s: Timeout(900),
		}),
		outputSchema: orFailure(
			Type.Object({
				state: Type.Union(["passed", "failed", "no-tests", "compile-error"].map((s) => Type.Literal(s))),
				tests: Type.Integer(),
				failures: Type.Integer(),
				skipped: Type.Integer(),
				failed: Type.Array(Type.Object({ name: Type.String(), message: Type.String() })),
				doctests: Type.Union([
					Type.Object({ passed: Type.Integer(), failed: Type.Integer(), failedNames: Type.Array(Type.String()) }),
					Type.Null(),
				]),
			}),
		),
		async execute(_id, params, signal, update, ctx) {
			const root = workspace(params, ctx);
			if (!root) return noWorkspace(params.cwd ?? ctx.cwd);
			const bad = badValue([params.package, params.toolchain, ...(params.features ?? [])]);
			if (bad) return failed(bad);
			const filterProblem = badPositional(params.filter, "filter");
			if (filterProblem) return failed(filterProblem);
			const timeout = timeoutMs(params, 900);
			// A tool config file layers UNDER the repo's own `.config/nextest.toml` (retries, slow
			// timeouts, groups all still apply); it only adds the `pi` profile with a junit path.
			const cfgDir = mkdtempSync(join(tmpdir(), "pi-dev-tools-nextest-"));
			try {
				const cfg = join(cfgDir, "nextest.toml");
				writeFileSync(cfg, '[profile.pi-dev-tools]\n[profile.pi-dev-tools.junit]\npath = "junit.xml"\n');
				const junitPath = join(targetDir(root), "nextest", "pi-dev-tools", "junit.xml");
				rmSync(junitPath, { force: true });
				const args = [
					"nextest",
					"run",
					"--tool-config-file",
					`pi-dev-tools:${cfg}`,
					"--profile",
					"pi-dev-tools",
					...featureArgs(params),
				];
				if (params.no_fail_fast ?? true) args.push("--no-fail-fast");
				if (params.package) args.push("-p", params.package);
				if (params.retries !== undefined) args.push("--retries", String(params.retries));
				if (params.nocapture) args.push("--nocapture");
				// A filterset expression (`test(...)`, `package(...)`, `all()`) goes to `-E`; a bare string is a substring match.
				if (params.filter) args.push(isFilterset(params.filter) ? "-E" : "--", params.filter);
				const r = await cargo({
					args,
					root,
					timeoutMs: timeout,
					signal,
					toolchain: params.toolchain,
					onProgress: progress(update),
				});
				const abnormal = abnormalExit(r, "cargo nextest");
				if (abnormal) return failed(`${abnormal}\n${tailLines(r.stderr.trim(), 30)}`);
				const junit = existsSync(junitPath) ? parseJunit(readFileSync(junitPath, "utf8")) : null;
				let state: "passed" | "failed" | "no-tests" | "compile-error";
				if (r.exitCode === 0) state = "passed";
				else if (r.exitCode === 100) state = "failed";
				else if (r.exitCode === 4) state = "no-tests";
				else if (r.exitCode === 101) state = "compile-error";
				else {
					const tail = await bound(r.stderr.trim(), { keep: "tail", label: "cargo-test" });
					return failed(`cargo nextest: unexpected exit ${r.exitCode}\n${tail.text}`);
				}
				const lines: string[] = [];
				if (state === "compile-error") {
					const tail = await bound(r.stderr.trim(), { keep: "tail", label: "cargo-test" });
					lines.push(`cargo test: compile error in ${seconds(r.durationMs)}`, tail.text);
				} else if (state === "no-tests") {
					lines.push(`cargo test: no tests matched${params.filter ? ` '${params.filter}'` : ""}`);
				} else if (!junit) {
					const tail = await bound(r.stderr.trim(), { keep: "tail", label: "cargo-test" });
					lines.push(
						`cargo test: ${state} but nextest wrote no junit at ${junitPath} (a repo profile named pi-dev-tools?); raw output follows`,
						tail.text,
					);
				} else {
					const total = junit.tests;
					const bad = junit.failures + junit.errors;
					lines.push(
						`cargo test: ${state} (${total - bad}/${total} passed${junit?.skipped ? `, ${junit.skipped} skipped` : ""}${junit?.errors ? `, ${junit.errors} errored` : ""}) in ${seconds(r.durationMs)}`,
					);
					for (const f of junit?.failed ?? []) {
						lines.push(`  FAIL ${f.name}: ${f.message}`);
						const detail = tailLines(f.detail, 25);
						if (detail) lines.push(detail.replace(/^/gm, "    "));
					}
				}
				// Doctests: nextest does not run them. Skipped when a filter is set (they cannot be filtered
				// the same way) and `--no-fail-fast` so every crate's doctests run.
				let doctests: { passed: number; failed: number; failedNames: string[] } | null = null;
				if ((params.doc ?? true) && state !== "compile-error" && !params.filter) {
					const docArgs = ["test", "--doc", "--no-fail-fast", ...featureArgs(params)];
					if (params.package) docArgs.push("-p", params.package);
					const d = await cargo({
						args: docArgs,
						root,
						timeoutMs: timeout,
						signal,
						toolchain: params.toolchain,
						onProgress: progress(update),
					});
					doctests = parseDoctests(`${d.stdout}\n${d.stderr}`);
					if (/no library targets found/.test(d.stderr)) {
						doctests = null;
					} else if (d.exitCode !== 0 && doctests.failed === 0 && !abnormalExit(d, "doctests")) {
						lines.push(`doctests: cargo exited ${d.exitCode}\n${tailLines(d.stderr.trim(), 15)}`);
					} else {
						lines.push(
							`doctests: ${doctests.passed} passed, ${doctests.failed} failed${doctests.failedNames.length ? `\n  ${doctests.failedNames.join("\n  ")}` : ""}`,
						);
					}
					if (doctests && doctests.failed > 0 && state === "passed") state = "failed";
				} else if ((params.doc ?? true) && params.filter) {
					lines.push("doctests: skipped (a filter is set)");
				}
				const text = await bound(lines.join("\n"), { keep: "tail", label: "cargo-test" });
				return toolResult({
					text: text.text,
					structured: {
						state,
						tests: junit?.tests ?? 0,
						failures: junit?.failures ?? 0,
						skipped: junit?.skipped ?? 0,
						failed: (junit?.failed ?? []).map(({ name, message }) => ({ name, message })),
						doctests,
					},
					isError: state !== "passed",
				});
			} finally {
				rmSync(cfgDir, { recursive: true, force: true });
			}
		},
	});

	pi.registerTool({
		name: "cargo_build",
		label: "cargo build",
		description: "Build the workspace and return the executables produced, plus deduped diagnostics.",
		promptSnippet: "Build Rust (prefer over `bash cargo build`)",
		annotations: MUTATING,
		parameters: Type.Object({
			cwd: Cwd,
			package: Package,
			features: Features,
			all_features: Type.Optional(Type.Boolean({ description: "Default true." })),
			bin: Type.Optional(Type.String()),
			example: Type.Optional(Type.String()),
			release: Type.Optional(Type.Boolean()),
			toolchain: Toolchain,
			limit: Limit,
			timeout_s: Timeout(1800),
		}),
		outputSchema: orFailure(
			Type.Object({
				state: Type.Union(["clean", "warnings", "errors"].map((s) => Type.Literal(s))),
				errors: Type.Integer(),
				warnings: Type.Integer(),
				diagnostics: Type.Array(DiagnosticSchema),
				executables: Type.Array(Type.String()),
			}),
		),
		async execute(_id, params, signal, update, ctx) {
			const root = workspace(params, ctx);
			if (!root) return noWorkspace(params.cwd ?? ctx.cwd);
			const bad = badValue(
				[params.package, params.toolchain, params.bin, params.example, ...(params.features ?? [])].filter(
					(v): v is string => v !== undefined,
				),
				"value",
			);
			if (bad) return failed(bad);
			const args = ["build", "--message-format=json-diagnostic-short", ...featureArgs(params)];
			if (params.package) args.push("-p", params.package);
			if (params.bin) args.push("--bin", params.bin);
			if (params.example) args.push("--example", params.example);
			if (params.release) args.push("--release");
			const r = await cargo({
				args,
				root,
				timeoutMs: timeoutMs(params, 1800),
				signal,
				toolchain: params.toolchain,
				onProgress: progress(update),
			});
			const parsed = parseCargoMessages(r.stdout);
			const executables = [...new Set(parsed.executables)];
			return diagnosticsResult(
				r,
				"cargo build",
				parsed,
				params.limit ?? 50,
				"cargo-build",
				executables.length ? ["executables:", ...executables.map((e) => `  ${e}`)] : [],
				{ executables },
			);
		},
	});

	pi.registerTool({
		name: "cargo_run",
		label: "cargo run",
		description:
			"Build and run a binary or example with the given args. stdin is closed unless `stdin` is given; output is capped.",
		promptSnippet: "Run a Rust binary (prefer over `bash cargo run`)",
		annotations: MUTATING,
		parameters: Type.Object({
			cwd: Cwd,
			package: Package,
			bin: Type.Optional(Type.String()),
			example: Type.Optional(Type.String()),
			args: Type.Optional(Type.Array(Type.String(), { description: "Program arguments, after `--`." })),
			stdin: Type.Optional(Type.String({ description: "Fed to the program's stdin." })),
			release: Type.Optional(Type.Boolean()),
			features: Features,
			all_features: Type.Optional(Type.Boolean({ description: "Default true." })),
			toolchain: Toolchain,
			timeout_s: Timeout(300),
		}),
		outputSchema: orFailure(
			Type.Object({
				state: Type.Union(["ok", "nonzero-exit", "compile-error"].map((s) => Type.Literal(s))),
				exit: Type.Union([Type.Integer(), Type.Null()]),
				truncated: Type.Boolean(),
			}),
		),
		async execute(_id, params, signal, update, ctx) {
			const root = workspace(params, ctx);
			if (!root) return noWorkspace(params.cwd ?? ctx.cwd);
			const bad = badValue(
				[params.package, params.toolchain, params.bin, params.example, ...(params.features ?? [])].filter(
					(v): v is string => v !== undefined,
				),
				"value",
			);
			if (bad) return failed(bad);
			const args = ["run", "-q", ...featureArgs(params)];
			if (params.package) args.push("-p", params.package);
			if (params.bin) args.push("--bin", params.bin);
			if (params.example) args.push("--example", params.example);
			if (params.release) args.push("--release");
			if (params.args?.length) args.push("--", ...params.args);
			const r = await cargo({
				args,
				root,
				timeoutMs: timeoutMs(params, 300),
				signal,
				toolchain: params.toolchain,
				stdin: params.stdin ?? "",
				onProgress: progress(update),
			});
			const abnormal = abnormalExit(r, "cargo run");
			if (abnormal) return failed(`${abnormal}\n${tailLines(r.stdout, 30)}`);
			// Only cargo's own "could not compile" counts; a program may print `error:` and exit 101 itself.
			const compileError = r.exitCode === 101 && /could not compile/.test(r.stderr);
			const state = compileError ? "compile-error" : r.exitCode === 0 ? "ok" : "nonzero-exit";
			const out = await bound(r.stdout, { keep: "tail", label: "cargo-run", alreadyDropped: r.stdoutDropped });
			const err = await bound(r.stderr.trim(), {
				keep: "tail",
				label: "cargo-run-stderr",
				maxLines: 200,
				maxBytes: 16_384,
			});
			const parts = [
				`cargo run: ${state}${state === "nonzero-exit" ? ` (${r.exitCode})` : ""} in ${seconds(r.durationMs)}`,
			];
			if (out.text) parts.push(out.text);
			if (err.text) parts.push(`stderr:\n${err.text}`);
			return toolResult({
				text: parts.join("\n"),
				structured: { state, exit: r.exitCode, truncated: out.truncated },
				details: { fullOutputPath: out.fullOutputPath },
				isError: state === "compile-error",
			});
		},
	});

	pi.registerTool({
		name: "cargo_doc",
		label: "cargo doc",
		description:
			"Build docs with `cargo doc --no-deps --all-features` and `RUSTDOCFLAGS=-D warnings`, so a doc warning fails like the repo gate.",
		promptSnippet: "Build Rust docs with warnings denied (prefer over `bash cargo doc`)",
		annotations: READ_ONLY,
		parameters: Type.Object({
			cwd: Cwd,
			package: Package,
			features: Features,
			all_features: Type.Optional(Type.Boolean()),
			toolchain: Toolchain,
			limit: Limit,
			timeout_s: Timeout(600),
		}),
		outputSchema: DiagnosticsOut,
		async execute(_id, params, signal, update, ctx) {
			const root = workspace(params, ctx);
			if (!root) return noWorkspace(params.cwd ?? ctx.cwd);
			const bad = badValue([params.package, params.toolchain, ...(params.features ?? [])]);
			if (bad) return failed(bad);
			const args = ["doc", "--no-deps", "--message-format=json-diagnostic-short", ...featureArgs(params)];
			if (params.package) args.push("-p", params.package);
			const r = await cargo({
				args,
				root,
				timeoutMs: timeoutMs(params, 600),
				signal,
				toolchain: params.toolchain,
				env: { RUSTDOCFLAGS: "-D warnings" },
				onProgress: progress(update),
			});
			return diagnosticsResult(r, "cargo doc", parseCargoMessages(r.stdout), params.limit ?? 50, "cargo-doc");
		},
	});

	pi.registerTool({
		name: "cargo_bench",
		label: "cargo bench",
		description:
			"Run criterion benches and report mean, confidence interval and change vs the saved baseline, read from `target/criterion`. Long-running; default timeout 900s.",
		promptSnippet: "Run Rust benchmarks and get criterion numbers (prefer over `bash cargo bench`)",
		annotations: MUTATING,
		parameters: Type.Object({
			cwd: Cwd,
			package: Package,
			bench: Type.Optional(Type.String({ description: "`--bench <name>`." })),
			filter: Type.Optional(Type.String({ description: "Benchmark name filter." })),
			save_baseline: Type.Optional(Type.String()),
			baseline: Type.Optional(Type.String({ description: "Compare against this saved baseline." })),
			toolchain: Toolchain,
			timeout_s: Timeout(900),
		}),
		outputSchema: orFailure(
			Type.Object({
				state: Type.Union(["ok", "failed"].map((s) => Type.Literal(s))),
				estimates: Type.Array(
					Type.Object({
						name: Type.String(),
						meanNs: Type.Number(),
						lowerNs: Type.Number(),
						upperNs: Type.Number(),
						changePct: Type.Union([Type.Number(), Type.Null()]),
					}),
				),
			}),
		),
		async execute(_id, params, signal, update, ctx) {
			const root = workspace(params, ctx);
			if (!root) return noWorkspace(params.cwd ?? ctx.cwd);
			const bad = badValue(
				[params.package, params.toolchain, params.bench, params.filter, params.save_baseline, params.baseline].filter(
					(v): v is string => v !== undefined,
				),
				"value",
			);
			if (bad) return failed(bad);
			const started = Date.now();
			const args = ["bench"];
			if (params.package) args.push("-p", params.package);
			if (params.bench) args.push("--bench", params.bench);
			const benchArgs: string[] = [];
			if (params.save_baseline) benchArgs.push("--save-baseline", params.save_baseline);
			if (params.baseline) benchArgs.push("--baseline", params.baseline);
			// Baseline flags are criterion's; libtest harnesses (the lib target) reject them, so run bench targets only.
			if (benchArgs.length && !params.bench) args.push("--benches");
			if (params.filter) benchArgs.push(params.filter);
			if (benchArgs.length) args.push("--", ...benchArgs);
			const r = await cargo({
				args,
				root,
				timeoutMs: timeoutMs(params, 900),
				signal,
				toolchain: params.toolchain,
				onProgress: progress(update),
			});
			const abnormal = abnormalExit(r, "cargo bench");
			if (abnormal) return failed(`${abnormal}\n${tailLines(r.stdout, 30)}`);
			const estimates = readCriterion(join(targetDir(root), "criterion"), started);
			const state = r.exitCode === 0 ? "ok" : "failed";
			const lines = [`cargo bench: ${state} in ${seconds(r.durationMs)}`];
			for (const e of estimates) {
				lines.push(
					`  ${e.name}: ${formatNs(e.meanNs)} [${formatNs(e.lowerNs)} .. ${formatNs(e.upperNs)}]${e.changePct === null ? "" : ` change ${e.changePct >= 0 ? "+" : ""}${e.changePct.toFixed(2)}%`}`,
				);
			}
			if (estimates.length === 0) {
				const tail = await bound(`${r.stdout}\n${r.stderr}`.trim(), { keep: "tail", label: "cargo-bench" });
				lines.push("(no criterion estimates found; raw output follows)", tail.text);
			}
			return toolResult({ text: lines.join("\n"), structured: { state, estimates }, isError: state !== "ok" });
		},
	});

	pi.registerTool({
		name: "cargo_add",
		label: "cargo add",
		description: "Add crates with `cargo add` and return the `Cargo.toml` change. Reaches the network.",
		promptSnippet: "Add Rust dependencies (prefer over `bash cargo add`)",
		annotations: NETWORK,
		parameters: Type.Object({
			cwd: Cwd,
			package: Package,
			crates: Type.Array(Type.String(), { minItems: 1, description: "`name` or `name@version`." }),
			dev: Type.Optional(Type.Boolean()),
			build: Type.Optional(Type.Boolean()),
			features: Type.Optional(Type.Array(Type.String())),
			optional: Type.Optional(Type.Boolean()),
			dry_run: Type.Optional(Type.Boolean()),
			toolchain: Toolchain,
			timeout_s: Timeout(300),
		}),
		outputSchema: orFailure(Type.Object({ state: Type.Literal("ok"), added: Type.Array(Type.String()) })),
		async execute(_id, params, signal, update, ctx) {
			const root = workspace(params, ctx);
			if (!root) return noWorkspace(params.cwd ?? ctx.cwd);
			const bad =
				badValue([params.package, params.toolchain, ...(params.features ?? [])]) ??
				badValue(params.crates, "crate", SAFE_CRATE);
			if (bad) return failed(bad);
			const args = ["add", ...params.crates];
			if (params.package) args.push("-p", params.package);
			if (params.dev) args.push("--dev");
			if (params.build) args.push("--build");
			if (params.optional) args.push("--optional");
			if (params.features?.length) args.push("--features", params.features.join(","));
			if (params.dry_run) args.push("--dry-run");
			const r = await cargo({
				args,
				root,
				timeoutMs: timeoutMs(params, 300),
				signal,
				toolchain: params.toolchain,
				onProgress: progress(update),
			});
			const abnormal = abnormalExit(r, "cargo add");
			if (abnormal) return failed(abnormal);
			const output = `${r.stdout}\n${r.stderr}`.trim();
			if (r.exitCode !== 0) {
				const tail = await bound(output, { keep: "tail", label: "cargo-add" });
				return failed(`cargo add: exit ${r.exitCode}\n${tail.text}`);
			}
			const added = [...output.matchAll(/^\s*Adding (\S+) v(\S+)/gm)].map((m) => `${m[1]}@${m[2]}`);
			return toolResult({
				text: `cargo add: ${params.dry_run ? "dry run, " : ""}${added.length ? added.join(", ") : output.split("\n")[0]}`,
				structured: { state: "ok", added },
			});
		},
	});
}

/** Criterion results written since `since` (ms epoch). */
function readCriterion(dir: string, since: number): BenchEstimate[] {
	if (!existsSync(dir)) return [];
	const out: BenchEstimate[] = [];
	const walk = (d: string, prefix: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(d, entry.name);
			const newEst = join(path, "new", "estimates.json");
			if (existsSync(newEst)) {
				if (statSync(newEst).mtimeMs < since - 1000) continue;
				// `change/` from an older `--baseline` run would misreport; only trust one written by this run.
				const change = join(path, "change", "estimates.json");
				const fresh = existsSync(change) && statSync(change).mtimeMs >= since - 1000;
				const est = benchEstimate(
					prefix ? `${prefix}/${entry.name}` : entry.name,
					readFileSync(newEst, "utf8"),
					fresh ? readFileSync(change, "utf8") : null,
				);
				if (est) out.push(est);
			} else if (entry.name !== "report") walk(path, prefix ? `${prefix}/${entry.name}` : entry.name);
		}
	};
	walk(dir, "");
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
