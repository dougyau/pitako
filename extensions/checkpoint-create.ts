import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { createCheckpoint, previousUnitMatches, type CheckpointIntent } from "./execute-checkpoint.ts";
import { EXECUTE_STATE_VERSION, executionStatePath, incompatibleExecuteState } from "./execute-state.ts";
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
        if (bindingError) throw new Error(bindingError);
        if (!binding?.association || typeof binding.key !== "string") throw new Error("Missing native checkpoint execution context.");
        const association = binding.association;
        if (association.root !== ctx.cwd || typeof association.invocation !== "string" ||
            typeof association.missionPath !== "string") throw new Error("Checkpoint execution workspace mismatch.");
        const record = JSON.parse(readFileSync(executionStatePath(association), "utf8"))[`invoke-${association.invocation}`];
        if (record && record.version !== EXECUTE_STATE_VERSION) throw new Error(incompatibleExecuteState(record.version));
        if (!record || !equal(record.association, association))
          throw new Error("Checkpoint durable association mismatch.");
        const loop = record.loop, attempt = loop?.attempt;
        if (!loop || loop.phase !== "implementation" || loop.halt || record.outcome ||
            attempt?.key !== binding.key || attempt.index !== loop.cursor || attempt.result ||
            !["intention", "launched"].includes(attempt.stage) || loop.plan?.stage !== "admitted" ||
            loop.manifest?.[loop.cursor] !== attempt.taskId)
          throw new Error("Checkpoint execution is stale, stopped or not a pending writer unit.");
        const intent: CheckpointIntent = { version: 2, association, key: attempt.key,
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
