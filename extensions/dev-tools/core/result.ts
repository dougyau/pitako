/**
 * One result shape for every tool.
 *
 * `content` is the compact text the model reads. `structuredContent` carries the same facts for
 * codemode scripts and must match the tool's `outputSchema`. `details` is what the transcript row
 * discloses on click. `isError` is set on red so the model sees failure while scripts keep the data.
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { RunResult } from "./process.ts";

export interface ToolOutcome<D = unknown> {
	text: string;
	/** Plain JSON data matching the tool's `outputSchema`. Interfaces are fine; no class instances. */
	structured: unknown;
	details?: D;
	isError?: boolean;
}

export function toolResult<D>(o: ToolOutcome<D>): AgentToolResult<D> {
	return {
		content: [{ type: "text", text: o.text }],
		structuredContent: o.structured as AgentToolResult<D>["structuredContent"],
		details: o.details as D,
		isError: o.isError ?? false,
	};
}

/**
 * Explain a process that did not finish normally. Returns undefined when the process ran to
 * completion and the caller should interpret the exit code itself.
 */
export function abnormalExit(r: RunResult, what: string): string | undefined {
	if (r.aborted) return `${what}: aborted after ${seconds(r.durationMs)}`;
	if (r.spawnError) return `${what}: could not start: ${r.spawnError}`;
	if (r.timedOut) return `${what}: timed out after ${seconds(r.durationMs)}`;
	if (r.exitCode === null) return `${what}: killed by ${r.termSignal ?? "signal"}`;
	return undefined;
}

export function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}
