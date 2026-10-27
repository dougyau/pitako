/**
 * Build and validate a commit message in Redd's style.
 *
 *   <subject>
 *
 *   [why]
 *
 *   Changes:
 *   - ...
 */

const CONVENTIONAL_PREFIX = /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)]*\))?!?:/i;
const DASHES = /[\u2013\u2014]/;

export interface CommitMessageInput {
	subject: string;
	why?: string;
	changes?: readonly string[];
}

/** Returns a human-readable reason the subject is unacceptable, or undefined. */
export function validateSubject(subject: string): string | undefined {
	const s = subject.trim();
	if (!s) return "subject is empty";
	if (s !== subject) return "subject has leading or trailing whitespace";
	if (s.includes("\n")) return "subject must be one line";
	if (s.length > 72) return `subject is ${s.length} chars, max 72`;
	if (s.endsWith(".")) return "subject must not end with a period";
	if (CONVENTIONAL_PREFIX.test(s)) return "subject must not use a conventional-commit prefix like `feat:`";
	if (DASHES.test(s)) return "subject must not contain an em or en dash";
	// An area prefix like `rtl:` is fine; the sentence after it must still be capitalized.
	const body = s.replace(/^[a-z][a-z0-9-]*: /, "");
	const first = body[0] ?? "";
	if (first !== first.toUpperCase() || first === first.toLowerCase()) {
		return "subject must start with a capital letter (an `area:` prefix may precede it)";
	}
	return undefined;
}

export function buildCommitMessage(input: CommitMessageInput): string {
	const parts = [input.subject.trim()];
	if (DASHES.test(input.why ?? "") || input.changes?.some((c) => DASHES.test(c))) {
		throw new Error("commit body must not contain an em or en dash");
	}
	const why = input.why?.trim();
	if (why) parts.push("", why);
	const changes = (input.changes ?? []).map((c) => c.trim()).filter(Boolean);
	if (changes.length > 0) parts.push("", "Changes:", ...changes.map((c) => `- ${c.replace(/^-\s*/, "")}`));
	parts.push("");
	return parts.join("\n");
}
