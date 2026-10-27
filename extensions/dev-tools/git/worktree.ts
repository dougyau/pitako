/**
 * git worktree tools: `git_worktree_list` (read-only), `git_worktree_add`, `git_worktree_remove`,
 * `git_worktree_prune`.
 *
 * Mutations run under `withLock` (same process) then `withFileLock` (other pi panes) keyed on the
 * git COMMON dir, so every worktree of one repo queues behind the same lock instead of racing on
 * `.git/worktrees`. A lock that cannot be had in time fails with `lock-timeout`; one whose owner file cannot be
 * written fails with `lock-failed`.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	abnormalExit,
	bound,
	DEFAULT_LOCK_WAIT_MS,
	FileLockAbortedError,
	FileLockFailedError,
	FileLockTimeoutError,
	failed,
	LockAbortedError,
	MUTATING,
	orFailure,
	progress,
	READ_ONLY,
	timeoutMs,
	toolResult,
	withFileLock,
	withLock,
} from "../core/index.ts";
import { assertRef, git, gitFailure } from "./run.ts";

const DEFAULT_TIMEOUT_S = 60;
const LOCK_DIR = "pi-dev-tools-worktree.lock";
const Cwd = Type.Optional(Type.String({ description: "Repository directory. Default: the session cwd." }));
const Timeout = Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "Seconds. Default 60." }));

export interface Worktree {
	path: string;
	head: string | null;
	/** Short branch name, or null when detached or bare. */
	branch: string | null;
	detached: boolean;
	bare: boolean;
	/** The first entry of `git worktree list` is always the main worktree. */
	main: boolean;
	locked: boolean;
	lockReason: string | null;
	prunable: boolean;
	prunableReason: string | null;
}

/** Parse `git worktree list --porcelain -z`: NUL-separated fields, an empty field ends a record. */
export function parseWorktrees(out: string): Worktree[] {
	const list: Worktree[] = [];
	let cur: Worktree | undefined;
	for (const field of out.split("\0")) {
		if (field === "") {
			cur = undefined;
			continue;
		}
		const space = field.indexOf(" ");
		const key = space === -1 ? field : field.slice(0, space);
		const value = space === -1 ? "" : field.slice(space + 1);
		if (key === "worktree") {
			cur = {
				path: value,
				head: null,
				branch: null,
				detached: false,
				bare: false,
				main: list.length === 0,
				locked: false,
				lockReason: null,
				prunable: false,
				prunableReason: null,
			};
			list.push(cur);
		} else if (!cur) {
		} else if (key === "HEAD") cur.head = value;
		else if (key === "branch") cur.branch = value.replace(/^refs\/heads\//, "");
		else if (key === "detached") cur.detached = true;
		else if (key === "bare") cur.bare = true;
		else if (key === "locked") {
			cur.locked = true;
			cur.lockReason = value || null;
		} else if (key === "prunable") {
			cur.prunable = true;
			cur.prunableReason = value || null;
		}
	}
	return list;
}

/** Lowercase, anything outside `[a-z0-9._-]` becomes `-`: `Feature/X y` -> `feature-x-y`. */
export function branchSlug(branch: string): string {
	return branch.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

/** One line per worktree: `path  branch|(detached)|(bare)  sha  [main] [locked] [prunable]`. */
export function formatWorktrees(list: readonly Worktree[]): string {
	return list
		.map((w) => {
			const ref = w.bare ? "(bare)" : w.detached ? "(detached)" : (w.branch ?? "(none)");
			const flags = [
				w.main ? "main" : "",
				w.locked ? `locked${w.lockReason ? `: ${w.lockReason}` : ""}` : "",
				w.prunable ? `prunable${w.prunableReason ? `: ${w.prunableReason}` : ""}` : "",
			].filter(Boolean);
			return `${w.path}  ${ref}  ${(w.head ?? "").slice(0, 7)}${flags.length ? `  [${flags.join("] [")}]` : ""}`;
		})
		.join("\n");
}

const real = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
};

type PathState = { state: "free" | "empty-dir" | "occupied" } | { error: string };

/** Classify a target path without letting EACCES or a concurrent removal escape as a throw. */
function pathState(target: string): PathState {
	try {
		if (!statSync(target).isDirectory()) return { state: "occupied" };
		return { state: readdirSync(target).length === 0 ? "empty-dir" : "occupied" };
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return { state: "free" }; // absent, or removed under us
		return { error: `path unreadable (${err.code ?? "error"}): ${target}: ${err.message}` };
	}
}

const inside = (dir: string, parentOrSelf: string): boolean =>
	dir === parentOrSelf || dir.startsWith(parentOrSelf + sep);

const WorktreeShape = Type.Object({
	path: Type.String(),
	head: Type.Union([Type.String(), Type.Null()]),
	branch: Type.Union([Type.String(), Type.Null()]),
	detached: Type.Boolean(),
	bare: Type.Boolean(),
	main: Type.Boolean(),
	locked: Type.Boolean(),
	lockReason: Type.Union([Type.String(), Type.Null()]),
	prunable: Type.Boolean(),
	prunableReason: Type.Union([Type.String(), Type.Null()]),
});

export function registerWorktreeTools(pi: ExtensionAPI): void {
	const common = { cwd: Cwd, timeout_s: Timeout };

	/** Context every tool needs: the effective cwd, its common git dir, and the timeout. */
	async function context(
		params: { cwd?: string; timeout_s?: number },
		ctx: { cwd: string },
		signal: AbortSignal | undefined,
		what: string,
	) {
		const cwd = params.cwd ?? ctx.cwd;
		const opts = { cwd, signal, timeoutMs: timeoutMs(params, DEFAULT_TIMEOUT_S) };
		const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], opts);
		const failure = gitFailure(r, what);
		if (failure) return { failure };
		return { cwd, opts, commonDir: real(r.stdout.trim()) };
	}

	/** Run `fn` under the repo's in-process and cross-process worktree locks. */
	async function locked<T>(
		commonDir: string,
		signal: AbortSignal | undefined,
		update: Parameters<typeof progress>[0],
		what: string,
		fn: () => Promise<T>,
	) {
		const wait = () => progress(update)(`${what}: waiting for another worktree operation on this repo`);
		try {
			return await withLock(
				`git-worktree:${commonDir}`,
				() =>
					withFileLock(join(commonDir, LOCK_DIR), fn, {
						signal,
						timeoutMs: DEFAULT_LOCK_WAIT_MS,
						onWait: wait,
					}),
				{ signal, onWait: wait },
			);
		} catch (e) {
			if (e instanceof LockAbortedError || e instanceof FileLockAbortedError) {
				return failed(`${what}: aborted while waiting for the worktree lock`);
			}
			if (e instanceof FileLockTimeoutError || e instanceof FileLockFailedError) return failed(`${what}: ${e.message}`);
			throw e;
		}
	}

	async function listWorktrees(opts: { cwd: string; signal?: AbortSignal; timeoutMs: number }) {
		const r = await git(["worktree", "list", "--porcelain", "-z"], opts);
		const failure = gitFailure(r, "git worktree list");
		return failure ? { failure } : { list: parseWorktrees(r.stdout) };
	}

	pi.registerTool({
		name: "git_worktree_list",
		label: "git worktree list",
		description:
			"Worktrees of this repository: path, HEAD, branch, detached, main, locked, prunable. Parsed from `--porcelain -z`, so paths with spaces are exact.",
		promptSnippet: "List git worktrees (prefer over `bash git worktree list`)",
		annotations: READ_ONLY,
		parameters: Type.Object(common),
		outputSchema: orFailure(Type.Object({ worktrees: Type.Array(WorktreeShape) })),
		async execute(_id, params, signal, _update, ctx) {
			const cwd = params.cwd ?? ctx.cwd;
			const res = await listWorktrees({ cwd, signal, timeoutMs: timeoutMs(params, DEFAULT_TIMEOUT_S) });
			if (res.failure !== undefined) return failed(res.failure);
			const text = await bound(formatWorktrees(res.list), { label: "git-worktree-list" });
			return toolResult({ text: text.text, structured: { worktrees: res.list } });
		},
	});

	pi.registerTool({
		name: "git_worktree_add",
		label: "git worktree add",
		description:
			"Create a worktree for `branch`. A new branch is created from `base` (default HEAD); an existing branch is checked out, unless another worktree has it. Default path is `<main repo>-<branch-slug>` next to the main worktree (slug: lowercase, non `[a-z0-9._-]` -> `-`). Refuses an existing non-empty path.",
		promptSnippet: "Add a git worktree on a branch (never `bash git worktree add`)",
		annotations: { ...MUTATING, idempotentHint: false },
		parameters: Type.Object({
			...common,
			branch: Type.String({ description: "Branch to create or check out. May not start with `-`." }),
			base: Type.Optional(Type.String({ description: "Start point for a NEW branch. Default HEAD." })),
			path: Type.Optional(Type.String({ description: "Worktree directory. Relative paths are from `cwd`." })),
		}),
		outputSchema: orFailure(
			Type.Object({
				path: Type.String(),
				branch: Type.String(),
				head: Type.String(),
				created: Type.Boolean({ description: "True when the branch was created." }),
			}),
		),
		async execute(_id, params, signal, update, ctx) {
			const what = "git worktree add";
			for (const [value, name] of [
				[params.branch, "branch"],
				[params.base, "base"],
			] as const) {
				if (value === undefined) continue;
				const problem = assertRef(value, name);
				if (problem) return failed(`${what}: ${problem}`);
			}
			const c = await context(params, ctx, signal, what);
			if (c.failure !== undefined) return failed(c.failure);
			const { cwd, opts, commonDir } = c;

			const fmt = await git(["check-ref-format", `refs/heads/${params.branch}`], opts);
			const fmtFailure = abnormalExit(fmt, what);
			if (fmtFailure) return failed(fmtFailure);
			if (fmt.exitCode !== 0) return failed(`${what}: invalid branch name '${params.branch}'`);

			return locked(commonDir, signal, update, what, async () => {
				const res = await listWorktrees(opts);
				if (res.failure !== undefined) return failed(res.failure);
				const main = res.list[0];
				if (!main) return failed(`${what}: no main worktree found`);
				const target = params.path
					? isAbsolute(params.path)
						? params.path
						: resolve(cwd, params.path)
					: join(dirname(main.path), `${basename(main.path)}-${branchSlug(params.branch)}`);
				const at = pathState(target);
				if ("error" in at) return failed(`${what}: ${at.error}`);
				if (at.state === "occupied") {
					return failed(`${what}: path exists and is not an empty directory: ${target}`);
				}

				// show-ref --quiet: 0 = branch exists, 1 = absent. Anything else is not an answer.
				const ref = await git(
					["show-ref", "--verify", "--quiet", "--end-of-options", `refs/heads/${params.branch}`],
					opts,
				);
				const refFailure = abnormalExit(ref, what);
				if (refFailure) return failed(refFailure);
				if (ref.exitCode !== 0 && ref.exitCode !== 1) return failed(gitFailure(ref, what) ?? what);
				const exists = ref.exitCode === 0;
				let args: string[];
				if (exists) {
					if (params.base !== undefined) {
						return failed(`${what}: branch '${params.branch}' already exists; omit base to check it out`);
					}
					const elsewhere = res.list.find((w) => w.branch === params.branch);
					if (elsewhere) {
						return failed(
							`${what}: branch checked out elsewhere: '${params.branch}' is checked out at ${elsewhere.path}`,
						);
					}
					args = ["worktree", "add", "--end-of-options", target, params.branch];
				} else {
					if (params.base !== undefined) {
						const base = await git(
							["rev-parse", "--verify", "--quiet", "--end-of-options", `${params.base}^{commit}`],
							opts,
						);
						const baseFailure = abnormalExit(base, what);
						if (baseFailure) return failed(baseFailure);
						// --verify --quiet: 1 = does not resolve. Other codes are real errors.
						if (base.exitCode === 1) return failed(`${what}: unknown revision '${params.base}'`);
						if (base.exitCode !== 0) return failed(gitFailure(base, what) ?? what);
					}
					args = [
						"worktree",
						"add",
						"-b",
						params.branch,
						"--end-of-options",
						target,
						...(params.base ? [params.base] : []),
					];
				}
				const r = await git(args, opts);
				const failure = gitFailure(r, what);
				if (failure) return failed(failure);
				const head = await git(["rev-parse", "HEAD"], { ...opts, cwd: target });
				const sha = head.stdout.trim();
				const headFailure = gitFailure(head, what) ?? (sha === "" ? `${what}: empty HEAD` : undefined);
				if (headFailure) {
					return failed(
						`${headFailure}\nhead-unreadable: the worktree WAS created at ${target}; check it with git_worktree_list`,
					);
				}
				return toolResult({
					text: `${exists ? "checked out" : "created"} ${params.branch} at ${target} (${sha.slice(0, 7)})`,
					structured: { path: real(target), branch: params.branch, head: sha, created: !exists },
				});
			});
		},
	});

	pi.registerTool({
		name: "git_worktree_remove",
		label: "git worktree remove",
		description:
			"Remove a linked worktree directory. Refuses a dirty worktree (modified or untracked files) unless `force`, a locked one, the main worktree, and the session cwd or any parent of it. The branch is kept.",
		promptSnippet: "Remove a git worktree (never `bash git worktree remove`)",
		annotations: { ...MUTATING, destructiveHint: true },
		parameters: Type.Object({
			...common,
			path: Type.String({ description: "Worktree directory, as listed by `git_worktree_list`." }),
			force: Type.Optional(Type.Boolean({ description: "Remove even when dirty. Never overrides a lock." })),
		}),
		outputSchema: orFailure(Type.Object({ path: Type.String(), branch: Type.Union([Type.String(), Type.Null()]) })),
		async execute(_id, params, signal, update, ctx) {
			const what = "git worktree remove";
			const c = await context(params, ctx, signal, what);
			if (c.failure !== undefined) return failed(c.failure);
			const { cwd, opts, commonDir } = c;

			return locked(commonDir, signal, update, what, async () => {
				const res = await listWorktrees(opts);
				if (res.failure !== undefined) return failed(res.failure);
				const wanted = real(isAbsolute(params.path) ? params.path : resolve(cwd, params.path));
				const entry = res.list.find((w) => real(w.path) === wanted);
				if (!entry) return failed(`${what}: not a worktree of this repository: ${params.path}`);
				if (entry.main) return failed(`${what}: main worktree: refusing to remove ${entry.path}`);
				for (const here of new Set([real(ctx.cwd), real(cwd)])) {
					if (inside(here, wanted)) {
						return failed(`${what}: cwd is inside ${entry.path}: refusing to remove the worktree you are in`);
					}
				}
				if (entry.locked) {
					return failed(`${what}: locked worktree${entry.lockReason ? ` (${entry.lockReason})` : ""}: unlock it first`);
				}
				if (entry.prunable) {
					return failed(`${what}: ${entry.path} is already gone from disk; use git_worktree_prune`);
				}
				if (!params.force) {
					const st = await git(["status", "--porcelain", "-z", "--untracked-files=all"], { ...opts, cwd: entry.path });
					const stFailure = gitFailure(st, what);
					if (stFailure) return failed(stFailure);
					if (st.stdout !== "") {
						const n = st.stdout.split("\0").filter(Boolean).length;
						return failed(
							`${what}: dirty worktree: ${n} modified or untracked path(s) in ${entry.path}; pass force to discard`,
						);
					}
				}
				const r = await git(
					["worktree", "remove", ...(params.force ? ["--force"] : []), "--end-of-options", entry.path],
					opts,
				);
				const failure = gitFailure(r, what);
				if (failure) return failed(failure);
				return toolResult({
					text: `removed ${entry.path}${entry.branch ? ` (branch ${entry.branch} kept)` : ""}`,
					structured: { path: entry.path, branch: entry.branch },
				});
			});
		},
	});

	pi.registerTool({
		name: "git_worktree_prune",
		label: "git worktree prune",
		description:
			"Drop administrative records of worktrees whose directory is gone. `dry_run` only reports what would go.",
		promptSnippet: "Prune stale git worktree records (never `bash git worktree prune`)",
		annotations: { ...MUTATING, destructiveHint: true },
		parameters: Type.Object({
			...common,
			dry_run: Type.Optional(Type.Boolean({ description: "Report only; change nothing." })),
		}),
		outputSchema: orFailure(
			Type.Object({
				dryRun: Type.Boolean(),
				pruned: Type.Array(Type.Object({ name: Type.String(), reason: Type.String() })),
			}),
		),
		async execute(_id, params, signal, update, ctx) {
			const what = "git worktree prune";
			const c = await context(params, ctx, signal, what);
			if (c.failure !== undefined) return failed(c.failure);
			const dryRun = params.dry_run ?? false;
			return locked(c.commonDir, signal, update, what, async () => {
				const r = await git(["worktree", "prune", "--verbose", ...(dryRun ? ["--dry-run"] : [])], c.opts);
				const failure = gitFailure(r, what);
				if (failure) return failed(failure);
				// `Removing worktrees/<name>: <reason>` (stderr in current git, stdout in older ones).
				const pruned = `${r.stdout}\n${r.stderr}`
					.split("\n")
					.map((line) => /^Removing (.+?): (.*)$/.exec(line))
					.filter((m): m is RegExpExecArray => m !== null)
					.map((m) => ({ name: m[1] ?? "", reason: m[2] ?? "" }));
				const verb = dryRun ? "would prune" : "pruned";
				const text = pruned.length
					? `${verb} ${pruned.length}:\n${pruned.map((p) => `${p.name}: ${p.reason}`).join("\n")}`
					: "nothing to prune";
				const out = await bound(text, { label: "git-worktree-prune" });
				return toolResult({ text: out.text, structured: { dryRun, pruned } });
			});
		},
	});
}
