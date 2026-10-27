/**
 * Git invocation shared by every git tool: fixed env, no pager, no colour, no prompts.
 */

import { abnormalExit, type RunOptions, type RunResult, run } from "../core/index.ts";

export const GIT_ENV: Readonly<Record<string, string>> = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_EDITOR: "true",
	GIT_PAGER: "cat",
	LC_ALL: "C",
};

export interface GitRunOptions {
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	stdin?: string;
	maxBytes?: number;
}

export function git(args: readonly string[], opts: GitRunOptions): Promise<RunResult> {
	const options: RunOptions = {
		cmd: "git",
		// --literal-pathspecs: `*`, `:/`, `:(glob)` and friends are file names, never patterns.
		args: ["--no-pager", "--literal-pathspecs", ...args],
		cwd: opts.cwd,
		env: GIT_ENV,
		timeoutMs: opts.timeoutMs,
		signal: opts.signal,
		stdin: opts.stdin,
		maxBytes: opts.maxBytes,
	};
	return run(options);
}

/**
 * Reject path arguments that would widen a command beyond what the caller named: the repo root
 * in any spelling, `..` segments, pathspec magic, flags. Globs are harmless because `git()` runs
 * with `--literal-pathspecs`.
 */
export function assertExplicitPaths(paths: readonly string[]): string | undefined {
	if (paths.length === 0) return "paths must name at least one file";
	for (const path of paths) {
		if (path.trim() === "") return "paths must not be empty";
		if (path.startsWith("-")) return `path '${path}' looks like a flag`;
		if (path.startsWith(":")) return `path '${path}' uses pathspec magic; name the file plainly`;
		const segments = path.split("/").filter((seg) => seg !== "" && seg !== ".");
		if (segments.length === 0) return `path '${path}' is the repository root; name the files explicitly`;
		if (segments.includes("..")) return `path '${path}' climbs with '..'; name the file from the repo root`;
		if (path === "*" || path === "**") return `path '${path}' is too broad; name the files explicitly`;
	}
	return undefined;
}

/** Refs come from the model; a leading `-` would turn one into an option. */
export function assertRef(ref: string, what: string): string | undefined {
	if (ref.trim() === "") return `${what} must not be empty`;
	if (ref.startsWith("-")) return `${what} must not start with '-'`;
	return undefined;
}

/** Named states for git exit codes, so the model never sees a bare "exit 1". */
export function gitState(r: RunResult): string {
	const err = r.stderr.trim();
	if (/not a git repository/i.test(err)) return "not a git repository";
	if (/unknown revision|bad revision|ambiguous argument/i.test(err)) return "unknown revision";
	if (/pathspec .* did not match/i.test(err)) return "path not tracked";
	if (/no upstream branch|has no upstream/i.test(err)) return "no upstream";
	if (/\[rejected\]|failed to push/i.test(err)) return "push rejected";
	// Worktree states.
	if (/is already (checked out|used by worktree) at/i.test(err)) return "branch checked out elsewhere";
	if (/contains modified or untracked files/i.test(err)) return "dirty worktree";
	if (/is locked/i.test(err)) return "locked worktree";
	if (/is a main working tree/i.test(err)) return "main worktree";
	if (/a branch named .* already exists/i.test(err)) return "branch exists";
	if (/already exists/i.test(err)) return "path exists";
	return `exit ${r.exitCode}`;
}

/** A failed git invocation as text the model can act on, or undefined when git ran normally. */
export function gitFailure(r: RunResult, what: string): string | undefined {
	const abnormal = abnormalExit(r, what);
	if (abnormal) return abnormal;
	if (r.exitCode !== 0) return `${what}: ${gitState(r)}\n${(r.stderr || r.stdout).trim()}`;
	return undefined;
}
