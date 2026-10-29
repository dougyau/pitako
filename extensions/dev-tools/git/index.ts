/**
 * git tools: `git_status`, `git_diff`, `git_log`, `git_show`, `git_commit`, the worktree tools, plus the Bash guard.
 *
 * Reads (and `git_worktree_list`) are annotated read-only so Plan mode admits them. Mutations are not.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { abnormalExit, bound, seconds, toolResult } from "../core/index.ts";
import { buildCommitMessage, validateSubject } from "./commit-message.ts";
import { findGuardViolation } from "./guard.ts";
import { assertExplicitPaths, assertRef, git, gitFailure, gitState } from "./run.ts";
import { formatStatus, parsePorcelainV2 } from "./status.ts";
import { registerWorktreeTools } from "./worktree.ts";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const Cwd = Type.Optional(Type.String({ description: "Repository directory. Default: the session cwd." }));
const Paths = Type.Optional(Type.Array(Type.String(), { description: "Limit to these paths (literal, no globs)." }));
const ReadTimeout = Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "Seconds. Default 60." }));
const MAX_LOG = 200;
const READ_TIMEOUT_MS = 60_000;

/** Every tool's `structuredContent` is either its success shape or `{ error }`. */
const Failure = Type.Object({ error: Type.String() });
const orFailure = (ok: TSchema) => Type.Union([ok, Failure]);
const failed = (error: string) => toolResult({ text: error, structured: { error }, isError: true });

const cwdOf = (params: { cwd?: string }, ctx: { cwd: string }) => params.cwd ?? ctx.cwd;
const readTimeout = (params: { timeout_s?: number }) => (params.timeout_s ? params.timeout_s * 1000 : READ_TIMEOUT_MS);

export function registerGitTools(pi: ExtensionAPI): void {
	registerWorktreeTools(pi);
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return undefined;
		const input = event.input as { command?: unknown } | undefined;
		if (typeof input?.command !== "string") return undefined;
		const violation = findGuardViolation(input.command);
		if (!violation) return undefined;
		return { block: true, reason: `pi-dev-tools blocks this git command (${violation.name}): ${violation.reason}` };
	});

	const StatusEntry = Type.Object({ path: Type.String(), code: Type.String(), from: Type.Optional(Type.String()) });
	pi.registerTool({
		name: "git_status",
		label: "git status",
		description:
			"Working tree state: branch, upstream ahead/behind, staged, unstaged, untracked and conflicted paths. Parsed from porcelain v2, so paths with spaces are exact.",
		promptSnippet: "Inspect the working tree (prefer over `bash git status`)",
		annotations: READ_ONLY,
		parameters: Type.Object({ cwd: Cwd, timeout_s: ReadTimeout }),
		outputSchema: orFailure(
			Type.Object({
				branch: Type.Union([Type.String(), Type.Null()]),
				upstream: Type.Union([Type.String(), Type.Null()]),
				tracked: Type.Boolean(),
				ahead: Type.Number(),
				behind: Type.Number(),
				staged: Type.Array(StatusEntry),
				unstaged: Type.Array(StatusEntry),
				untracked: Type.Array(Type.String()),
				conflicted: Type.Array(StatusEntry),
			}),
		),
		async execute(_id, params, signal, _update, ctx) {
			const cwd = cwdOf(params, ctx);
			const r = await git(["status", "--porcelain=v2", "-b", "-z", "--untracked-files=all"], {
				cwd,
				signal,
				timeoutMs: readTimeout(params),
			});
			const failure = gitFailure(r, "git status");
			if (failure) return failed(failure);
			const status = parsePorcelainV2(r.stdout);
			const text = await bound(formatStatus(status), { label: "git-status", alreadyDropped: r.stdoutDropped });
			return toolResult({ text: text.text, structured: status, details: { cwd } });
		},
	});

	pi.registerTool({
		name: "git_diff",
		label: "git diff",
		description:
			"Unified diff of the working tree (default), the index (`staged`), or against a base ref. Structured results include the bounded `diff` and `stat`; pass `stat: true` for the stat alone.",
		promptSnippet: "Show changes as a diff or stat (prefer over `bash git diff`)",
		annotations: READ_ONLY,
		parameters: Type.Object({
			cwd: Cwd,
			staged: Type.Optional(Type.Boolean({ description: "Diff the index against HEAD." })),
			base: Type.Optional(Type.String({ description: "Diff against this ref (or `a..b` range) instead of the tree." })),
			paths: Paths,
			context: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines. Default 3." })),
			stat: Type.Optional(Type.Boolean({ description: "Only the diffstat." })),
			timeout_s: ReadTimeout,
		}),
		outputSchema: orFailure(Type.Object({
			changed: Type.Boolean(),
			stat: Type.String(),
			diff: Type.String({ description: "Bounded unified diff. Empty for stat-only requests or no changes." }),
			truncated: Type.Boolean(),
			fullOutputPath: Type.Optional(Type.String({ description: "Saved diff output when truncated." })),
		})),
		async execute(_id, params, signal, _update, ctx) {
			const cwd = cwdOf(params, ctx);
			const timeoutMs = readTimeout(params);
			if (params.base !== undefined) {
				const problem = assertRef(params.base, "base");
				if (problem) return failed(problem);
			}
			// Options first, then `--end-of-options <base>`, then `-- <paths>`: git reads anything after
			// `--end-of-options` as a revision.
			const common = ["diff", "--no-color", "--no-ext-diff"];
			if (params.staged) common.push("--cached");
			const tail = [
				...(params.base ? ["--end-of-options", params.base] : []),
				...(params.paths?.length ? ["--", ...params.paths] : []),
			];
			const stat = await git([...common, "--stat=100", ...tail], { cwd, signal, timeoutMs });
			const failure = gitFailure(stat, "git diff");
			if (failure) return failed(failure);
			const statText = stat.stdout.trimEnd();
			if (params.stat || !statText) {
				return toolResult({
					text: statText || "no changes",
					structured: { changed: statText !== "", stat: statText, diff: "", truncated: false },
				});
			}
			const full = await git([...common, `-U${params.context ?? 3}`, ...tail], { cwd, signal, timeoutMs });
			const fullFailure = gitFailure(full, "git diff");
			if (fullFailure) return failed(fullFailure);
			const body = await bound(full.stdout, { label: "git-diff", alreadyDropped: full.stdoutDropped });
			return toolResult({
				text: `${statText}\n\n${body.text}`,
				structured: {
					changed: true, stat: statText, diff: body.text,
					truncated: body.truncated, fullOutputPath: body.fullOutputPath,
				},
				details: { fullOutputPath: body.fullOutputPath },
			});
		},
	});

	pi.registerTool({
		name: "git_log",
		label: "git log",
		description: `Recent commits, one per line: short sha, date, author, subject. Max ${MAX_LOG}.`,
		promptSnippet: "List recent commits (prefer over `bash git log`)",
		annotations: READ_ONLY,
		parameters: Type.Object({
			cwd: Cwd,
			max_count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LOG, description: "Default 20." })),
			ref: Type.Optional(Type.String({ description: "Ref or range, e.g. `main..HEAD`." })),
			paths: Paths,
			author: Type.Optional(Type.String()),
			since: Type.Optional(Type.String({ description: "e.g. `2 weeks ago` or an ISO date." })),
			oneline: Type.Optional(Type.Boolean({ description: "Default true. False adds each commit body." })),
			timeout_s: ReadTimeout,
		}),
		outputSchema: orFailure(
			Type.Object({
				commits: Type.Array(
					Type.Object({ sha: Type.String(), author: Type.String(), date: Type.String(), subject: Type.String() }),
				),
			}),
		),
		async execute(_id, params, signal, _update, ctx) {
			const cwd = cwdOf(params, ctx);
			if (params.ref !== undefined) {
				const problem = assertRef(params.ref, "ref");
				if (problem) return failed(problem);
			}
			const n = Math.min(params.max_count ?? 20, MAX_LOG);
			const oneline = params.oneline ?? true;
			const format = oneline ? "%h%x09%an%x09%aI%x09%s" : "%h%x09%an%x09%aI%x09%s%n%b%x00";
			const args = ["log", "--no-color", `--max-count=${n}`, `--format=${format}`];
			if (params.author) args.push(`--author=${params.author}`);
			if (params.since) args.push(`--since=${params.since}`);
			if (params.ref) args.push("--end-of-options", params.ref);
			if (params.paths?.length) args.push("--", ...params.paths);
			const r = await git(args, { cwd, signal, timeoutMs: readTimeout(params) });
			const failure = gitFailure(r, "git log");
			if (failure) return failed(failure);
			const records = oneline ? r.stdout.split("\n") : r.stdout.split("\0");
			const commits = records
				.map((rec) => rec.replace(/^\n/, ""))
				.filter((rec) => rec.trim() !== "")
				.map((rec) => {
					const [head = "", ...bodyLines] = rec.split("\n");
					const [sha = "", author = "", date = "", ...subject] = head.split("\t");
					return { sha, author, date, subject: subject.join("\t"), body: bodyLines.join("\n").trim() };
				});
			const lines = commits.map(
				(c) =>
					`${c.sha} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}${c.body ? `\n  ${c.body.replace(/\n/g, "\n  ")}` : ""}`,
			);
			const text = await bound(lines.join("\n") || "no commits", { label: "git-log", alreadyDropped: r.stdoutDropped });
			return toolResult({
				text: text.text,
				structured: { commits: commits.map(({ sha, author, date, subject }) => ({ sha, author, date, subject })) },
			});
		},
	});

	pi.registerTool({
		name: "git_show",
		label: "git show",
		description: "One commit: metadata, message, diffstat, and the diff unless `stat` is set.",
		promptSnippet: "Show a commit (prefer over `bash git show`)",
		annotations: READ_ONLY,
		parameters: Type.Object({
			cwd: Cwd,
			rev: Type.String({ description: "Commit, tag or ref." }),
			paths: Paths,
			stat: Type.Optional(Type.Boolean({ description: "Metadata and diffstat only." })),
			timeout_s: ReadTimeout,
		}),
		outputSchema: orFailure(Type.Object({ sha: Type.String(), subject: Type.String(), truncated: Type.Boolean() })),
		async execute(_id, params, signal, _update, ctx) {
			const cwd = cwdOf(params, ctx);
			const timeoutMs = readTimeout(params);
			const problem = assertRef(params.rev, "rev");
			if (problem) return failed(problem);
			// Resolve to a commit first: tags peel, blobs and trees fail with a clear state.
			const head = await git(["log", "-1", "--format=%H%x09%s", "--end-of-options", params.rev, "--"], {
				cwd,
				signal,
				timeoutMs,
			});
			const headFailure = gitFailure(head, "git show");
			if (headFailure) return failed(headFailure);
			const [sha = "", subject = ""] = head.stdout.trim().split("\t");
			if (!sha) return failed(`git show: '${params.rev}' is not a commit (a blob or tree has no history)`);
			const args = ["show", "--no-color", "--no-ext-diff", "--format=%H%n%an <%ae>%n%aI%n%n%B", "--stat=100"];
			if (!params.stat) args.push("--patch");
			args.push("--end-of-options", sha);
			if (params.paths?.length) args.push("--", ...params.paths);
			const r = await git(args, { cwd, signal, timeoutMs });
			const failure = gitFailure(r, "git show");
			if (failure) return failed(failure);
			const body = await bound(r.stdout, { label: "git-show", alreadyDropped: r.stdoutDropped });
			return toolResult({
				text: body.text,
				structured: { sha, subject, truncated: body.truncated },
				details: { fullOutputPath: body.fullOutputPath },
			});
		},
	});

	const Stage = Type.Union(["validate", "add", "commit", "push", "done"].map((s) => Type.Literal(s)));
	pi.registerTool({
		name: "git_commit",
		label: "git commit",
		description:
			"Stage the named paths, commit exactly those paths with a subject plus optional why and `Changes:` bullets, then push the current branch. Never skips hooks or signing. Hook failures are relayed; a hook that modified files means re-stage and call again. A push failure leaves the commit in place and says so.",
		promptSnippet: "Commit named files in house style and push (never `bash git commit`)",
		annotations: MUTATING,
		parameters: Type.Object({
			cwd: Cwd,
			subject: Type.String({
				description: "Capitalized imperative, <= 72 chars, no trailing period, no `feat:` prefix.",
			}),
			why: Type.Optional(
				Type.String({ description: "Prose paragraph before the bullets, only when the subject cannot carry it." }),
			),
			changes: Type.Optional(
				Type.Array(Type.String(), { description: "`Changes:` bullets, one concrete change each." }),
			),
			paths: Type.Array(Type.String(), {
				minItems: 1,
				description: "Files to commit. `.`, `-A` and `..` are rejected.",
			}),
			push: Type.Optional(Type.Boolean({ description: "Push after committing. Default true." })),
			timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800, description: "Per git step. Default 300." })),
		}),
		outputSchema: Type.Object({
			stage: Stage,
			sha: Type.Union([Type.String(), Type.Null()]),
			signed: Type.Boolean(),
			pushed: Type.Boolean(),
			hookModifiedFiles: Type.Boolean(),
			error: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const cwd = cwdOf(params, ctx);
			const timeoutMs = (params.timeout_s ?? 300) * 1000;
			const fail = (
				stage: "validate" | "add" | "commit" | "push",
				text: string,
				extra: Partial<{ sha: string; signed: boolean; hookModifiedFiles: boolean }> = {},
			) =>
				toolResult({
					text,
					structured: {
						stage,
						sha: extra.sha ?? null,
						signed: extra.signed ?? false,
						pushed: false,
						hookModifiedFiles: extra.hookModifiedFiles ?? false,
						error: text.split("\n")[0],
					},
					isError: true,
				});

			const subjectProblem = validateSubject(params.subject);
			if (subjectProblem) return fail("validate", `subject rejected: ${subjectProblem}`);
			const pathProblem = assertExplicitPaths(params.paths);
			if (pathProblem) return fail("validate", pathProblem);
			let message: string;
			try {
				message = buildCommitMessage({ subject: params.subject, why: params.why, changes: params.changes });
			} catch (e) {
				return fail("validate", (e as Error).message);
			}

			const add = await git(["add", "--", ...params.paths], { cwd, signal, timeoutMs });
			const addFailure = gitFailure(add, "git add");
			if (addFailure) return fail("add", addFailure);

			// `commit -- <paths>` commits exactly the named paths; anything else already in the index stays there.
			const commit = await git(["commit", "-q", "-F", "-", "--", ...params.paths], {
				cwd,
				signal,
				timeoutMs,
				stdin: message,
			});
			const commitAbnormal = abnormalExit(commit, "git commit");
			if (commit.exitCode !== 0 || commitAbnormal) {
				const output = `${commit.stdout}\n${commit.stderr}`.trim();
				const hookModified = /files were modified by this hook/i.test(output);
				const nothing = /nothing to commit|no changes added to commit|nothing added to commit/i.test(output);
				const head =
					commitAbnormal ??
					(nothing
						? "git commit: nothing to commit for the named paths"
						: `git commit: ${gitState(commit)} (hooks run before the commit; nothing was committed)`);
				const hint = hookModified
					? "\n\nA hook rewrote files. Review the changes, re-stage the same paths, and call git_commit again."
					: "";
				const shown = await bound(output, { keep: "tail", label: "git-commit" });
				return fail("commit", `${head}\n${shown.text}${hint}`, { hookModifiedFiles: hookModified });
			}

			const head = await git(["log", "-1", "--format=%H%x09%G?"], { cwd, signal, timeoutMs });
			if (gitFailure(head, "git log"))
				return fail("commit", `committed, but could not read HEAD: ${head.stderr.trim()}`);
			const [sha = "", sig = "N"] = head.stdout.trim().split("\t");
			// G good, U good but untrusted key, X/Y good but expired: all signed. N none, B bad, E unverifiable: not.
			const signed = ["G", "U", "X", "Y"].includes(sig);
			const short = sha.slice(0, 7);

			if (params.push === false) {
				return toolResult({
					text: `committed ${short}${signed ? " (signed)" : ""}, not pushed`,
					structured: { stage: "done", sha, signed, pushed: false, hookModifiedFiles: false },
				});
			}
			// Push only the current branch: to its upstream's remote when it has one, else set origin up.
			const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
				cwd,
				signal,
				timeoutMs,
			});
			const remote = upstream.exitCode === 0 ? upstream.stdout.trim().split("/")[0] : undefined;
			const pushArgs = remote ? ["push", "-q", remote, "HEAD"] : ["push", "-q", "-u", "origin", "HEAD"];
			const push = await git(pushArgs, { cwd, signal, timeoutMs });
			const pushFailure = gitFailure(push, "git push");
			if (pushFailure) {
				const shown = await bound(pushFailure, { keep: "tail", label: "git-push" });
				return fail("push", `committed ${short} but push failed; do NOT commit again, fix the push.\n${shown.text}`, {
					sha,
					signed,
				});
			}
			return toolResult({
				text: `committed ${short}${signed ? " (signed)" : ""} and pushed in ${seconds(add.durationMs + commit.durationMs + push.durationMs)}`,
				structured: { stage: "done", sha, signed, pushed: true, hookModifiedFiles: false },
			});
		},
	});
}
