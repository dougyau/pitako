import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { gitPort } from "./git-port.ts";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { parseApplyPatch } from "pi-codex-tools";
import { beginHookEffect, closeHookEffect, recordContextPeak, createCheckpoint, previousUnitMatches, type CheckpointIntent } from "./execute-checkpoint.ts";
import { EXECUTE_STATE_VERSION, executionStatePath, incompatibleExecuteState, expandWorkerReferences } from "./execute-state.ts";
import { effectiveProfile } from "./profile.ts";

const namespace = "pitako.checkpoint/1";
type Binding = { association: CheckpointIntent["association"]; key: string };
const equal = isDeepStrictEqual;

// Native child extensionBindings is launch-scoped, not model-authored tool input.
// Capture it during factory loading: in-process children restore the environment.
export default function checkpointCreate(pi: ExtensionAPI): void {
  let binding: Binding | undefined, bindingError: string | undefined;
  try {
    binding = JSON.parse(process.env.PI_SUBAGENT_EXTENSION_BINDINGS ?? "{}")[namespace];
  } catch { bindingError = "Invalid native checkpoint extension binding."; }
  function currentIntent(cwd: string, hook = false): CheckpointIntent {
    if (bindingError) throw new Error(bindingError);
    if (!binding?.association || typeof binding.key !== "string") throw new Error("Missing native checkpoint execution context.");
    const association = binding.association;
    if (association.root !== cwd || typeof association.invocation !== "string" ||
        typeof association.missionPath !== "string") throw new Error("Checkpoint execution workspace mismatch.");
    const record = expandWorkerReferences(JSON.parse(readFileSync(executionStatePath(association), "utf8"))[`invoke-${association.invocation}`]);
    if (record && record.version !== EXECUTE_STATE_VERSION) throw new Error(incompatibleExecuteState(record.version));
    if (!record || !equal(record.association, association))
      throw new Error("Checkpoint durable association mismatch.");
    const loop = record.loop, attempt = loop?.attempt;
    if (!loop || loop.phase !== "implementation" || loop.halt || record.outcome ||
        (hook ? attempt?.bindingKey !== binding.key : attempt?.key !== binding.key) || attempt.index !== loop.cursor || attempt.result ||
        !(hook ? attempt.stage === "launched" : ["intention", "launched"].includes(attempt.stage)) || loop.plan?.stage !== "admitted" ||
        loop.manifest?.[loop.cursor] !== attempt.taskId)
      throw new Error("Checkpoint execution is stale, stopped or not a pending writer unit.");
    const intent: CheckpointIntent = { version: 2, association, key: attempt.key,
      ...(attempt.baseline ? { baseline: attempt.baseline } : {}),
      taskId: attempt.taskId, attempt: attempt.number, loop: loop.number, cursor: loop.cursor,
      phase: "implementation", planRef: loop.plan.ref,
      progress: { consumedLoops: record.consumedLoops,
        admitted: Object.fromEntries(Object.entries(record.tasks).filter(([, task]: [string, any]) => task.admitted.length)
          .map(([id, task]: [string, any]) => [id, task.admitted])),
        previous: record.lastConfirmed?.kind === "unit"
          ? (({ taskId, attempt, resultRef, checkpointRef, digest }) =>
            ({ taskId, attempt, resultRef, checkpointRef, digest }))(record.lastConfirmed) : null } };
    if (record.lastConfirmed?.kind === "unit" && record.lastConfirmed.position.loop !== loop.number &&
        !previousUnitMatches(intent, record.lastConfirmed))
      throw new Error("Confirmed unit lacks admitted pending-position provenance.");
    if (!equal(attempt.checkpoint, intent)) throw new Error("Checkpoint intention/progress differs from durable execution context.");
    return intent;
  }
  pi.on("turn_end", (_event, ctx) => {
    if (!binding && !bindingError) return;
    const intent = currentIntent(ctx.cwd, true);
    recordContextPeak(intent, ctx.getContextUsage()?.tokens);
  });
  const openPaths = new Map<string, string>();
  const effects = new Map<string, { intent: CheckpointIntent; seq: number; paths: string[] }>();
  pi.on("tool_call", (event, ctx) => {
    if (!binding && !bindingError) return;
    const { toolName, toolCallId, input } = event;
    const mutation = toolName === "lsp_rename" || (toolName === "ast_rewrite" && input.dryRun === false);
    if (!mutation && !["edit", "write", "apply_patch"].includes(toolName)) return;
    try {
      const intent = currentIntent(ctx.cwd, true);
      if (mutation) throw new Error("Use edit/write/apply_patch for journaled writes.");
      const targets = toolName === "apply_patch"
        ? parseApplyPatch(String(input.patch ?? "")).flatMap(hunk =>
          hunk.kind === "update" && hunk.moveTo ? [hunk.path, hunk.moveTo] : [hunk.path])
        : ["path" in input ? input.path : undefined];
      const paths = [...new Set(targets.map(target => hookPath(intent.association.root, ctx.cwd, target)))];
      const journaled = paths.filter((file): file is string => file !== null);
      if (journaled.some(file => openPaths.has(file))) throw new Error("Path has an open write effect; retry after that call finishes.");
      // All reservations and durable publication are synchronous, before any handler can yield.
      for (const file of journaled) openPaths.set(file, toolCallId);
      if (!journaled.length) return;
      try {
        const seq = beginHookEffect(intent, toolName, journaled);
        effects.set(toolCallId, { intent, seq, paths: journaled });
      } catch (error) {
        for (const file of journaled) openPaths.delete(file);
        throw error;
      }
    } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
  });
  function close(toolCallId: string) {
    const effect = effects.get(toolCallId);
    if (!effect) return;
    closeHookEffect(effect.intent, effect.seq);
    effects.delete(toolCallId);
    for (const file of effect.paths) openPaths.delete(file);
  }
  pi.on("tool_result", event => { close(event.toolCallId); });
  pi.on("tool_execution_end", event => { close(event.toolCallId); });
  pi.registerTool({
    name: "checkpoint_create", label: "checkpoint_create",
    description: "Capture real affected bytes and admitted progress before writes (kind=pre, exact paths required). The root seals settled journaled work; this tool never seals, confirms a task or advances the root cursor. Missing/stale execution context fails without fabricating an intention. Never call after Stop/refusal.",
    parameters: Type.Object({
      kind: Type.Literal("pre"),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })),
    }, { additionalProperties: false }),
    outputSchema: Type.Object({ ok: Type.Boolean(), status: Type.String() }, { additionalProperties: true }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    async execute(_id, input, signal, _update, ctx) {
      let result, structuredContent: JsonValue;
      try {
        if (effectiveProfile(ctx.sessionManager) === "analysis") throw new Error("Pitako analysis forbids checkpoint_create.");
        signal?.throwIfAborted();
        if (input.kind !== "pre") throw new Error("checkpoint_create accepts only kind pre; the execute root seals settled work.");
        const intent = currentIntent(ctx.cwd);
        signal?.throwIfAborted();
        result = createCheckpoint(intent, input.kind, input.paths, signal);
        structuredContent = JSON.parse(JSON.stringify(result));
      } catch (error) {
        result = { ok: false, status: "failed", error: { message: error instanceof Error ? error.message : String(error) } };
        structuredContent = result;
      }
      return { content: [{ type: "text", text: `checkpoint_create: ${result.status}${"error" in result ? `; ${result.error.message}` : ""}` }],
        structuredContent, details: result, isError: !result.ok };
    },
  });
}

function hookPath(root: string, cwd: string, input: unknown): string | null {
  if (typeof input !== "string" || !input || input.includes("\0") || input.includes("~") || input.startsWith("@") ||
      /[\p{White_Space}\uFEFF]/u.test(input.replaceAll(" ", "")) || /^file:\/\//i.test(input) || /[\\]|^[A-Za-z]:/.test(input))
    throw new Error("Unsupported write path normalization.");
  const raw = path.isAbsolute(input) ? input : path.join(cwd) + path.sep + input;
  const parts = raw.split(path.sep);
  const absolute = path.resolve(raw);
  if (parts.includes(".git")) throw new Error("Writes inside .git are forbidden.");
  for (let i = 1; i <= parts.length; i++) {
    try { if (lstatSync(parts.slice(0, i).join(path.sep) || path.sep).isSymbolicLink()) throw new Error("Write path traverses a symlink."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const protectedDirectory = relative.split(path.sep).find(part => part === ".pi" || part === ".pitako");
  if (protectedDirectory) throw new Error(`Writes inside ${protectedDirectory}/ are forbidden.`);
  const ignored = gitPort().status(["check-ignore", "--quiet", "--", relative], { cwd: root });
  if (ignored.status === 0) return null;
  if (ignored.status !== 1) throw new Error("Cannot determine whether write path is gitignored.");
  return relative.split(path.sep).join("/");
}
