/**
 * Bound what the model sees and spill the rest to disk.
 *
 * Pi's built-in tools cap at DEFAULT_MAX_BYTES / DEFAULT_MAX_LINES. Custom tools must do the same.
 * When output is cut, the full text goes to one temp dir per process and the returned text,
 * notice included, stays within the limits.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";

export interface Bounded {
	text: string;
	truncated: boolean;
	fullOutputPath?: string;
}

export interface BoundOptions {
	/** Keep the start (head) or the end (tail) of the text. Tail suits build and test logs. */
	keep?: "head" | "tail";
	maxBytes?: number;
	maxLines?: number;
	/** Temp file name hint, e.g. "cargo-check". */
	label?: string;
	/** Bytes the producer already dropped before this text, so the notice does not call it "full". */
	alreadyDropped?: number;
}

/** Room reserved for the truncation notice inside the byte and line limits. */
const NOTICE_BYTES = 256;
const NOTICE_LINES = 2;

let spillDir: Promise<string> | undefined;
let spillSeq = 0;

function spillDirectory(): Promise<string> {
	spillDir ??= mkdtemp(join(tmpdir(), "pi-dev-tools-"));
	return spillDir;
}

export async function bound(text: string, opts: BoundOptions = {}): Promise<Bounded> {
	const limits = {
		maxBytes: Math.max(1, (opts.maxBytes ?? DEFAULT_MAX_BYTES) - NOTICE_BYTES),
		maxLines: Math.max(1, (opts.maxLines ?? DEFAULT_MAX_LINES) - NOTICE_LINES),
	};
	const result: TruncationResult = opts.keep === "tail" ? truncateTail(text, limits) : truncateHead(text, limits);
	if (!result.truncated) return { text, truncated: false };
	const dir = await spillDirectory();
	spillSeq += 1;
	const fullOutputPath = join(dir, `${opts.label ?? "output"}-${spillSeq}.txt`);
	await writeFile(fullOutputPath, text, "utf8");
	const where = opts.keep === "tail" ? "start" : "end";
	const partial = opts.alreadyDropped ? ` (producer dropped ${opts.alreadyDropped} more bytes)` : "";
	return {
		text: `${result.content}\n[output truncated at the ${where}; rest in ${fullOutputPath}${partial}]`,
		truncated: true,
		fullOutputPath,
	};
}

/** Keep the last `n` lines of a string. `n <= 0` yields an empty string. */
export function tailLines(text: string, n: number): string {
	if (n <= 0) return "";
	const lines = text.split("\n");
	return lines.length <= n ? text : lines.slice(-n).join("\n");
}

/** Keep the first `n` items and say how many were dropped. */
export function capList<T>(items: readonly T[], n: number): { kept: readonly T[]; dropped: number } {
	return items.length <= n ? { kept: items, dropped: 0 } : { kept: items.slice(0, n), dropped: items.length - n };
}
