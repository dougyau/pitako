/**
 * ssh tools: `ssh_exec` (annotated read-only; Plan mode re-validates the remote command through
 * the pi-plan-mode fork), `ssh_pull` (read-only) and `ssh_push` (mutating), all over the user's
 * own `ssh`/`scp` binaries and `~/.ssh/config`.
 */

import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { abnormalExit, bound, run, seconds, toolResult } from "../core/index.ts";
import { redact, remoteScript, SCP_BASE_ARGS, shellQuote, splitSentinel, sshArgs, validateRemotePath } from "./exec.ts";
import { readKnownHosts, validateHost } from "./hosts.ts";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const MUTATING = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const DEFAULT_TIMEOUT_S = 30;
const TRANSFER_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
const MAX_STDIN_BYTES = 1 << 20;

const Failure = Type.Object({ error: Type.String() });
const orFailure = (ok: TSchema) => Type.Union([ok, Failure]);
const failed = (error: string) => toolResult({ text: error, structured: { error }, isError: true });

const Host = Type.String({ description: "A `Host` alias from ~/.ssh/config, e.g. `home` or `nas`." });
const Timeout = (def: number) =>
	Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_S, description: `Seconds. Default ${def}.` }));

type ExecState = "ok" | "command-failed" | "cwd-missing" | "ssh-failed" | "timeout" | "aborted";
/** Only states where the command did not run to completion count as tool errors; `grep` exiting 1 is normal. */
const ERROR_STATES: ReadonlySet<ExecState> = new Set(["cwd-missing", "ssh-failed", "timeout", "aborted"]);

export interface SshToolOptions {
	/** Test seam: the set of known host aliases. Default: parsed from ~/.ssh/config on each call. */
	knownHosts?: () => ReadonlySet<string>;
	/** Test seam: the ssh binary. */
	sshBin?: string;
	/** Test seam: the scp binary. */
	scpBin?: string;
}

/** Keep the last 512 KiB; anything older is beyond what `bound` would show or spill anyway. */
const REDACT_CAP = 512 * 1024;
function capForRedaction(text: string): string {
	return text.length > REDACT_CAP ? text.slice(-REDACT_CAP) : text;
}

function localFile(path: string, cwd: string): { path: string; kind: "missing" | "file" | "dir" | "other" } {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	try {
		const st = lstatSync(abs);
		return { path: abs, kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other" };
	} catch {
		return { path: abs, kind: "missing" };
	}
}

export function registerSshTools(pi: ExtensionAPI, options: SshToolOptions = {}): void {
	const known = options.knownHosts ?? (() => readKnownHosts());
	const sshBin = options.sshBin ?? "ssh";
	const scpBin = options.scpBin ?? "scp";

	pi.registerTool({
		name: "ssh_exec",
		label: "ssh",
		description:
			"Run a command on a known host (a `Host` alias in ~/.ssh/config) over the user's own ssh: BatchMode, no agent or X11 forwarding, no TTY. The command runs under `sh` on the remote; multi-line scripts and heredocs work. The remote exit code is returned separately from ssh failures; a non-zero command exit is a normal result, not a tool error. Credential-shaped strings are redacted. A timeout kills the local ssh only; the remote command may keep running.",
		promptSnippet: "Run a command on `home`, `nas` or another ~/.ssh/config host (prefer over `bash ssh ...`)",
		annotations: READ_ONLY,
		parameters: Type.Object({
			host: Host,
			command: Type.String({ description: "Shell command or script for `sh` on the remote." }),
			cwd: Type.Optional(Type.String({ description: "Remote directory to `cd` into first." })),
			timeout: Timeout(DEFAULT_TIMEOUT_S),
		}),
		outputSchema: orFailure(
			Type.Object({
				host: Type.String(),
				remoteExit: Type.Union([Type.Integer(), Type.Null()]),
				sshExit: Type.Union([Type.Integer(), Type.Null()]),
				state: Type.Union(
					["ok", "command-failed", "cwd-missing", "ssh-failed", "timeout", "aborted"].map((s) => Type.Literal(s)),
				),
				truncated: Type.Boolean(),
			}),
		),
		async execute(_id, params, signal) {
			const hostProblem = validateHost(params.host, known());
			if (hostProblem) return failed(hostProblem);
			if (params.command.trim() === "") return failed("command is empty");
			if (params.command.includes("\0")) return failed("command must not contain NUL");
			const script = remoteScript(params.command, params.cwd);
			if (Buffer.byteLength(script) > MAX_STDIN_BYTES) return failed("command is too large (1 MiB max)");
			const r = await run({
				cmd: sshBin,
				args: sshArgs(params.host),
				stdin: script,
				timeoutMs: (params.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
				signal,
			});
			const { remoteExit, cwdMissing, noMktemp, stdout } = splitSentinel(r.stdout);
			const state: ExecState = r.aborted
				? "aborted"
				: r.timedOut
					? "timeout"
					: remoteExit === null || noMktemp
						? "ssh-failed"
						: cwdMissing
							? "cwd-missing"
							: remoteExit === 0
								? "ok"
								: "command-failed";
			const heads: Record<ExecState, () => string> = {
				ok: () => `${params.host}: exit 0 in ${seconds(r.durationMs)}`,
				"command-failed": () => `${params.host}: command exited ${remoteExit} in ${seconds(r.durationMs)}`,
				"cwd-missing": () => `${params.host}: cd ${params.cwd} failed; the command did not run`,
				"ssh-failed": () =>
					noMktemp
						? `${params.host}: the remote shell has no mktemp; the command did not run`
						: `${params.host}: ssh exited ${r.exitCode} before the command finished (connection failure, or the remote shell died); the command may not have run, or only partly`,
				timeout: () => `${abnormalExit(r, `ssh ${params.host}`)}; the remote command may still be running`,
				aborted: () => `${abnormalExit(r, `ssh ${params.host}`)}; the remote command may still be running`,
			};
			// Redaction is linear but not free; cap the raw text first (the spill file keeps the capped
			// text, redacted too) so a multi-megabyte stream cannot stall the tool.
			const body = await bound(redact(capForRedaction(stdout.replace(/\n$/, ""))), {
				keep: "tail",
				label: "ssh-exec",
				alreadyDropped: r.stdoutDropped,
			});
			const stderr = await bound(redact(capForRedaction(r.stderr.trim())), {
				keep: "tail",
				label: "ssh-exec-stderr",
				maxLines: 200,
				maxBytes: 16_384,
			});
			const parts = [heads[state]()];
			if (body.text) parts.push(body.text);
			if (stderr.text) parts.push(`stderr:\n${stderr.text}`);
			return toolResult({
				text: parts.join("\n"),
				structured: { host: params.host, remoteExit, sshExit: r.exitCode, state, truncated: body.truncated },
				details: { fullOutputPath: body.fullOutputPath },
				isError: ERROR_STATES.has(state),
			});
		},
	});

	const transfer = async (args: string[], what: string, timeoutS: number, signal: AbortSignal | undefined) => {
		const r = await run({
			cmd: scpBin,
			args: ["-O", "-q", ...SCP_BASE_ARGS, ...args],
			timeoutMs: timeoutS * 1000,
			signal,
		});
		const abnormal = abnormalExit(r, what);
		if (abnormal) return { ok: false, text: abnormal };
		if (r.exitCode !== 0) {
			const err = redact(r.stderr.trim());
			const state = /No such file/i.test(err)
				? "missing"
				: /Permission denied/i.test(err)
					? "permission denied"
					: /Operation timed out|Could not resolve|Connection refused/i.test(err)
						? "connection failed"
						: `scp exit ${r.exitCode}`;
			return { ok: false, text: `${what}: ${state}\n${err}` };
		}
		return { ok: true, text: `${what}: done in ${seconds(r.durationMs)}` };
	};
	const TransferOut = orFailure(
		Type.Object({ host: Type.String(), local_path: Type.String(), remote_path: Type.String() }),
	);
	/** Validation shared by pull and push; returns an error result or the resolved local path. */
	const transferPreamble = (
		host: string,
		remotePath: string,
		localPath: string,
		cwd: string,
	): { error: string; local?: never } | { error?: never; local: ReturnType<typeof localFile> } => {
		const hostProblem = validateHost(host, known());
		if (hostProblem) return { error: hostProblem };
		const pathProblem = validateRemotePath(remotePath);
		if (pathProblem) return { error: pathProblem };
		return { local: localFile(localPath, cwd) };
	};

	pi.registerTool({
		name: "ssh_pull",
		label: "scp pull",
		description:
			"Copy one file from a known host to a local path with scp. Refuses to overwrite unless `overwrite` is set. Remote paths are plain (no spaces, quotes, `~` or shell characters).",
		promptSnippet: "Fetch a remote file (prefer over `bash scp`)",
		annotations: READ_ONLY,
		parameters: Type.Object({
			host: Host,
			remote_path: Type.String(),
			local_path: Type.String({ description: "Destination file. Relative paths resolve against the session cwd." }),
			overwrite: Type.Optional(Type.Boolean()),
			timeout: Timeout(TRANSFER_TIMEOUT_S),
		}),
		outputSchema: TransferOut,
		async execute(_id, params, signal, _update, ctx) {
			const pre = transferPreamble(params.host, params.remote_path, params.local_path, ctx.cwd);
			if (pre.error !== undefined) return failed(pre.error);
			const { local } = pre;
			if (local.kind === "dir") return failed(`${local.path} is a directory; name the destination file`);
			if (local.kind !== "missing" && !params.overwrite)
				return failed(`${local.path} exists; pass overwrite: true to replace it`);
			const r = await transfer(
				["--", `${params.host}:${params.remote_path}`, local.path],
				`pull ${params.host}:${params.remote_path}`,
				params.timeout ?? TRANSFER_TIMEOUT_S,
				signal,
			);
			const structured = { host: params.host, local_path: local.path, remote_path: params.remote_path };
			return r.ok ? toolResult({ text: r.text, structured }) : failed(r.text);
		},
	});

	pi.registerTool({
		name: "ssh_push",
		label: "scp push",
		description:
			"Copy one local file to a known host with scp. Refuses to overwrite an existing remote file unless `overwrite` is set (checked with `test -e` just before the copy). Remote paths are plain (no spaces, quotes, `~` or shell characters).",
		promptSnippet: "Send a file to a remote host (prefer over `bash scp`)",
		annotations: MUTATING,
		parameters: Type.Object({
			host: Host,
			local_path: Type.String({ description: "Source file. Relative paths resolve against the session cwd." }),
			remote_path: Type.String(),
			overwrite: Type.Optional(Type.Boolean()),
			timeout: Timeout(TRANSFER_TIMEOUT_S),
		}),
		outputSchema: TransferOut,
		async execute(_id, params, signal, _update, ctx) {
			const pre = transferPreamble(params.host, params.remote_path, params.local_path, ctx.cwd);
			if (pre.error !== undefined) return failed(pre.error);
			const { local } = pre;
			if (local.kind !== "file") return failed(`${local.path} is not a regular file`);
			const timeoutS = params.timeout ?? TRANSFER_TIMEOUT_S;
			if (!params.overwrite) {
				const probe = await run({
					cmd: sshBin,
					args: sshArgs(params.host),
					stdin: remoteScript(`test -e ${shellQuote(params.remote_path)}`),
					timeoutMs: Math.min(timeoutS, 30) * 1000,
					signal,
				});
				const { remoteExit } = splitSentinel(probe.stdout);
				if (remoteExit === null)
					return failed(`push ${params.host}: could not check the remote path (ssh exit ${probe.exitCode})`);
				if (remoteExit === 0)
					return failed(`${params.host}:${params.remote_path} exists; pass overwrite: true to replace it`);
			}
			const r = await transfer(
				["--", local.path, `${params.host}:${params.remote_path}`],
				`push ${params.host}:${params.remote_path}`,
				timeoutS,
				signal,
			);
			const structured = { host: params.host, local_path: local.path, remote_path: params.remote_path };
			return r.ok ? toolResult({ text: r.text, structured }) : failed(r.text);
		},
	});
}
