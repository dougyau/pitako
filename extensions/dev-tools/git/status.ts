/**
 * Parse `git status --porcelain=v2 -b -z --untracked-files=all`.
 *
 * NUL-separated so paths with spaces are safe. Rename entries carry the original path as a
 * second NUL token.
 */

export interface StatusEntry {
	path: string;
	/** Two-char XY code from porcelain v2, `.` meaning unchanged on that side. */
	code: string;
	/** Original path for renames and copies. */
	from?: string;
}

export interface GitStatus {
	branch: string | null;
	upstream: string | null;
	/** False when the upstream is configured but gone, so ahead/behind are unknown. */
	tracked: boolean;
	ahead: number;
	behind: number;
	staged: StatusEntry[];
	unstaged: StatusEntry[];
	untracked: string[];
	conflicted: StatusEntry[];
}

export function parsePorcelainV2(text: string): GitStatus {
	const tokens = text.split("\0");
	const status: GitStatus = {
		branch: null,
		upstream: null,
		tracked: false,
		ahead: 0,
		behind: 0,
		staged: [],
		unstaged: [],
		untracked: [],
		conflicted: [],
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		if (token.startsWith("# ")) {
			const [key, ...rest] = token.slice(2).split(" ");
			const value = rest.join(" ");
			if (key === "branch.head") status.branch = value === "(detached)" ? null : value;
			else if (key === "branch.upstream") status.upstream = value;
			else if (key === "branch.ab") {
				const m = /^\+(\d+) -(\d+)$/.exec(value);
				if (m) {
					status.tracked = true;
					status.ahead = Number(m[1]);
					status.behind = Number(m[2]);
				}
			}
			continue;
		}
		const kind = token[0];
		if (kind === "?") {
			status.untracked.push(token.slice(2));
			continue;
		}
		if (kind === "!") continue;
		if (kind === "1" || kind === "2" || kind === "u") {
			const fieldCount = kind === "1" ? 8 : kind === "2" ? 9 : 10;
			const parts = token.split(" ");
			const path = parts.slice(fieldCount).join(" ");
			const code = parts[1] ?? "..";
			const entry: StatusEntry = { path, code };
			if (kind === "2") {
				entry.from = tokens[i + 1] ?? undefined;
				i += 1;
			}
			const [x = ".", y = "."] = code;
			if (kind === "u" || x === "U" || y === "U" || code === "AA" || code === "DD") {
				status.conflicted.push(entry);
				continue;
			}
			if (x !== ".") status.staged.push(entry);
			if (y !== ".") status.unstaged.push(entry);
		}
	}
	return status;
}

export function formatStatus(s: GitStatus): string {
	const head = s.branch ?? "(detached)";
	const track =
		s.upstream === null
			? "no upstream"
			: !s.tracked
				? `${s.upstream} gone`
				: `${s.upstream}${s.ahead || s.behind ? ` +${s.ahead} -${s.behind}` : " in sync"}`;
	const lines = [`${head} (${track})`];
	const section = (label: string, entries: readonly StatusEntry[], side: 0 | 1) => {
		if (entries.length === 0) return;
		lines.push(`${label} (${entries.length}):`);
		for (const e of entries) {
			const letter = e.code[side] ?? "?";
			lines.push(`  ${letter} ${e.from ? `${e.from} -> ${e.path}` : e.path}`);
		}
	};
	section("conflicted", s.conflicted, 0);
	section("staged", s.staged, 0);
	section("unstaged", s.unstaged, 1);
	if (s.untracked.length > 0) {
		lines.push(`untracked (${s.untracked.length}):`);
		for (const p of s.untracked) lines.push(`  ? ${p}`);
	}
	if (lines.length === 1) lines.push("clean");
	return lines.join("\n");
}
