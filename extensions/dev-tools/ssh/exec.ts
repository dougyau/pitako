/**
 * `ssh_exec` plumbing: argv, the stdin script with its exit-code sentinel, and redaction.
 *
 * The remote command travels on stdin to `exec sh -s`, so no remote argv quoting is needed, the
 * command never shows in `ps`, and multi-line scripts work. The command text is written to a
 * remote temp file through a quoted heredoc with a per-call random delimiter and run as
 * `sh "$tmp"` inside a subshell: unbalanced quotes or parentheses in the command cannot escape
 * into the wrapper (bash 3.2 mis-parses `)` inside `$(cat <<EOF)`, so no command substitution),
 * and an `exit N` ends the command, not the shell that still has to print the sentinel. The
 * sentinel separates "the command exited 255" from "ssh itself failed", which also exits 255.
 */

import { randomBytes } from "node:crypto";

export const SSH_BASE_ARGS: readonly string[] = [
	"-T",
	"-a",
	"-x",
	"-o",
	"BatchMode=yes",
	"-o",
	"ConnectTimeout=8",
	"-o",
	"ClearAllForwardings=yes",
	"-o",
	"RequestTTY=no",
	"-o",
	"ServerAliveInterval=5",
	"-o",
	"ServerAliveCountMax=2",
];

/** scp takes the same `-o` options; `-T`/`-a`/`-x` are ssh-only flags. */
export const SCP_BASE_ARGS: readonly string[] = SSH_BASE_ARGS.filter((a) => !["-T", "-a", "-x"].includes(a));

export const SENTINEL = "__PI_RC=";
export const CWD_MARKER = "__PI_CWD_MISSING";
export const TMP_MARKER = "__PI_NO_MKTEMP";

/** POSIX single-quote a string: `'...'` with embedded quotes as `'"'"'`. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function sshArgs(host: string): string[] {
	return [...SSH_BASE_ARGS, "--", host, "exec sh -s"];
}

/** A heredoc delimiter the command text cannot contain by accident. */
function delimiter(command: string): string {
	for (;;) {
		const candidate = `__PI_CMD_${randomBytes(6).toString("hex")}`;
		if (!command.includes(candidate)) return candidate;
	}
}

/** The script sent on stdin. See the module comment for why it is shaped this way. */
export function remoteScript(command: string, cwd?: string): string {
	const eof = delimiter(command);
	const body = command.endsWith("\n") ? command : `${command}\n`;
	const prelude = cwd === undefined ? "" : `cd -- ${shellQuote(cwd)} || { printf '\\n${CWD_MARKER}'; exit 97; }; `;
	// `</dev/null`: the command must not read the rest of this script off the shared stdin.
	// The trap also removes the temp file when the local ssh dies (HUP) before the normal rm.
	return [
		`__pi_tmp=$(mktemp 2>/dev/null) || { printf '\\n${TMP_MARKER}\\n${SENTINEL}98'; exit 98; }`,
		`trap 'rm -f "$__pi_tmp"' EXIT HUP TERM`,
		`cat > "$__pi_tmp" <<'${eof}'`,
		`${body}${eof}`,
		`( ${prelude}sh "$__pi_tmp" </dev/null )`,
		"__pi_rc=$?",
		`printf '\\n${SENTINEL}%d' "$__pi_rc"`,
		"",
	].join("\n");
}

export interface RemoteOutcome {
	/** Remote command exit code; null when the sentinel never arrived (ssh failed or was killed). */
	remoteExit: number | null;
	/** The `cd` into `cwd` failed; the command never ran. */
	cwdMissing: boolean;
	/** The remote has no `mktemp`; the command never ran. */
	noMktemp: boolean;
	stdout: string;
}

/** Strip the sentinel (and any marker) off stdout and read the remote exit code. */
export function splitSentinel(stdout: string): RemoteOutcome {
	const idx = stdout.lastIndexOf(`\n${SENTINEL}`);
	if (idx < 0) return { remoteExit: null, cwdMissing: false, noMktemp: false, stdout };
	const code = Number.parseInt(stdout.slice(idx + 1 + SENTINEL.length), 10);
	let body = stdout.slice(0, idx);
	const marker = (m: string) => {
		if (!body.endsWith(`\n${m}`)) return false;
		body = body.slice(0, -(m.length + 1));
		return true;
	};
	const remoteExit = Number.isNaN(code) ? null : code;
	// A marker only counts with its own exit code, so a command cannot spoof one by printing it.
	const cwdMissing = remoteExit === 97 && marker(CWD_MARKER);
	const noMktemp = remoteExit === 98 && marker(TMP_MARKER);
	return { remoteExit, cwdMissing, noMktemp, stdout: body };
}

const REDACTIONS: readonly [RegExp, string][] = [
	// `Authorization: Bearer xxx`, any case, any length past a few chars.
	[/\b(bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi, "$1<redacted>"],
	// `token=...`, `"api_key": "..."`, `PASSWORD: ...`, any case, with or without quotes.
	[
		// Key anchored at a word start and bounded to 40 chars each side so long inputs stay linear.
		/(?<![A-Za-z0-9_])(["']?[A-Za-z0-9_]{0,40}?(?:token|secret|password|passwd|api[_-]?key)[A-Za-z0-9_]{0,40}["']?\s*[=:]\s*)["']?[^\s"',;]{4,}["']?/gi,
		"$1<redacted>",
	],
	// JWTs: keep the header and payload shape, drop the signature.
	[/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)[A-Za-z0-9_-]{10,}/g, "$1<redacted>"],
];

/** Blank the obvious credential shapes before text reaches the transcript or the spill file. */
export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
	return out;
}

/** Remote paths for scp: scp's legacy protocol hands them to the remote shell, so no metacharacters. */
const REMOTE_PATH = /^[A-Za-z0-9._/+@%:=,-]+$/;

export function validateRemotePath(path: string): string | undefined {
	if (!path) return "remote_path is empty";
	if (path.startsWith("-")) return "remote_path must not start with '-'";
	if (!REMOTE_PATH.test(path))
		return "remote_path may only contain letters, digits and ._/+@%:=,- (no spaces, quotes, `~` or shell metacharacters)";
	return undefined;
}
