/**
 * Bash guard for git invocations that bypass review or rewrite history on a shared remote.
 *
 * Always on, not only in Plan mode. It is a seatbelt, not the policy: Plan mode owns the policy.
 * Each pattern scans one shell segment (no `;`, `&`, `|` or newline inside the match), so a `git`
 * earlier in a pipeline cannot excuse a flag later on.
 */

const SEGMENT = String.raw`[^;&|\n]*`;
/** `git` as the command word of a segment or substitution, allowing leading env assignments. */
const GIT = String.raw`(?:^|[;&|\n(\x60])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git\b`;
/** Quoted strings are arguments, never flags; blank them before matching. */
const QUOTED = /'[^']*'|"[^"]*"/g;
/** `2>&1` and friends contain `&` but do not end a segment. */
const FD_REDIRECT = /\d*>&\d+|&>\S*/g;
/** A clustered short-flag group containing `letter`, e.g. `-am` for `a`. */
const cluster = (letter: string) => String.raw`\s-[a-zA-Z]*${letter}[a-zA-Z]*(?=\s|$)`;

export interface GuardRule {
	name: string;
	pattern: RegExp;
	reason: string;
}

export const GUARD_RULES: readonly GuardRule[] = [
	{
		name: "no-verify",
		pattern: new RegExp(
			String.raw`${GIT}${SEGMENT}\b(commit|push|merge|rebase|cherry-pick|am|revert)\b${SEGMENT}\s--no-verify\b`,
		),
		reason:
			"`--no-verify` skips the repo's hooks. Fix the hook or the change; use `git_commit`, which never skips them.",
	},
	{
		// `-n` is `--no-verify` only for commit (push's `-n` is `--dry-run`; elsewhere it is `--no-commit`).
		// Anything after a bare `--` is a pathspec, not a flag.
		name: "no-verify-short",
		pattern: new RegExp(String.raw`${GIT}${SEGMENT}\bcommit\b(?:(?!\s--(?:\s|$))[^;&|\n])*${cluster("n")}`),
		reason: "`-n` skips the repo's hooks. Fix the hook or the change; use `git_commit`, which never skips them.",
	},
	{
		name: "force-push",
		pattern: new RegExp(
			String.raw`${GIT}${SEGMENT}\bpush\b${SEGMENT}(?:\s--force(?!-with-lease|-if-includes)\b|${cluster("f")}|[\s:]\+\S+)`,
		),
		reason:
			"plain force push rewrites shared history. Use `--force-with-lease` after confirming with the user; `git_commit` pushes normally.",
	},
	{
		name: "no-gpg-sign",
		pattern: new RegExp(
			String.raw`${GIT}${SEGMENT}(?:\b(commit|merge|rebase|cherry-pick|revert|am|tag)\b${SEGMENT}\s--no-gpg-sign\b|\s-c\s*commit\.gpgsign=false\b${SEGMENT}\bcommit\b)`,
		),
		reason: "commits are signed in this setup; do not disable signing. `git_commit` keeps signing on.",
	},
];

/** The first rule a command trips, or undefined when the command is fine. */
export function findGuardViolation(command: string): GuardRule | undefined {
	const stripped = command.replace(QUOTED, '""').replace(FD_REDIRECT, "");
	return GUARD_RULES.find((rule) => rule.pattern.test(stripped));
}
