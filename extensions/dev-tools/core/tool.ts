/**
 * Bits every tool group repeats: annotation presets, the `{ error }` failure shape, and the
 * `tool_execution_update` progress payload.
 */

import { type TSchema, Type } from "typebox";
import { toolResult } from "./result.ts";

/** Reads nothing but the environment it inspects; Plan mode admits these. */
export const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;
/** Rewrites files in the workspace (even if only in one mode). */
export const MUTATING = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;
/** Reaches the network or another machine and changes state there. */
export const NETWORK = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;

/** Every tool's `structuredContent` is either its success shape or `{ error }`. */
export const Failure = Type.Object({ error: Type.String() });
export const orFailure = (ok: TSchema) => Type.Union([ok, Failure]);
export const failed = (error: string) => toolResult({ text: error, structured: { error }, isError: true });

type Update = ((update: { content: { type: "text"; text: string }[]; details: undefined }) => void) | undefined;
/** Wrap pi's `onUpdate` into a plain progress-line callback. */
export const progress = (update: Update) => (text: string) =>
	update?.({ content: [{ type: "text", text }], details: undefined });

/** `timeout_s` param to milliseconds with a default. */
export const timeoutMs = (params: { timeout_s?: number }, defaultS: number) => (params.timeout_s ?? defaultS) * 1000;
