import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PitakoConfigError } from "../errors.ts";
import {
  backgroundExecutor,
  cancelWorker,
  formatWorkerHandle,
  formatWorkerViews,
  interestFrom,
  spawnBackground,
  workerResult,
  workerStatus,
} from "./background.ts";
import { noteResultTaken, observationEpoch, publishObservation } from "./observe.ts";
import { currentInstanceId } from "./scope.ts";
import { createPiExecutor } from "./pi.ts";
import { formatAgentResult, runAgentInstance } from "./run.ts";

const noExtra = { additionalProperties: false } as const;

export default function agentInstance(pi: ExtensionAPI): void {
  registerBackgroundTools(pi);
  pi.registerTool({
    name: "agent_run",
    label: "Run agent",
    description:
      "Run one Pitako role in an isolated context. Returns the final result and model provenance, not the child transcript. If this fails, report the failure. Do not perform that role yourself.",
    promptSnippet: "Run an isolated Pitako role and return its final result",
    promptGuidelines: [
      "Use agent_run for a role such as architect or researcher. If agent_run fails, report the error. Do not do that role's work in the parent session.",
    ],
    parameters: Type.Object(
      {
        role: Type.String({ description: "Role id, for example architect" }),
        task: Type.String({ description: "Explicit task for the isolated agent" }),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (currentInstanceId()) {
        return errorResult("agent_run cannot be called from an AgentInstance");
      }
      try {
        let live = "";
        const epoch = observationEpoch();
        const result = await runAgentInstance({
          roleId: params.role,
          task: params.task,
          cwd: ctx.cwd,
          signal,
          executor: createPiExecutor(),
          onPresent(text) {
            live = text;
            onUpdate?.({
              content: [{ type: "text", text }],
              details: { live: text },
            });
          },
          onObserve(snapshot) {
            publishObservation(snapshot, epoch);
          },
        });
        noteResultTaken(result.instanceId);
        return {
          content: [{ type: "text", text: formatAgentResult(result) }],
          details: { ...result, live },
          isError: result.status !== "completed",
        };
      } catch (error) {
        const message = error instanceof PitakoConfigError || error instanceof Error ? error.message : String(error);
        return errorResult(message);
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("agent_run")) + theme.fg("accent", ` ${args.role}`), 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details as { live?: string } | undefined;
      const full = result.content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
      const text = options.expanded ? full : details?.live || full;
      return new Text(theme.fg("toolOutput", text), 0, 0);
    },
  });
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { error: message },
    isError: true,
  };
}

function childBlocked(tool: string) {
  if (currentInstanceId() || process.env.PITAKO_INSTANCE_ID) {
    return errorResult(`${tool} cannot be called from an AgentInstance`);
  }
  return undefined;
}

function textResult(text: string, details: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
  };
}

function registerBackgroundTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent_spawn",
    label: "Spawn agent",
    description:
      "Start one Pitako role in the background and return its instance id while it is still running. Does not wait for the result. A failure is not permission to do that role in the parent.",
    promptSnippet: "Start a background Pitako role and return before it finishes",
    promptGuidelines: [
      "Use agent_spawn for long specialist work that can continue while you stay available. Do not call agent_result in the same turn. If it fails, report the error. Do not do that role yourself.",
    ],
    parameters: Type.Object(
      {
        role: Type.String({ description: "Role id, for example developer" }),
        task: Type.String({ description: "Explicit task for the isolated agent" }),
        plan: Type.Optional(Type.String({ description: "Plan id when an execution workflow should wake on completion" })),
        unit: Type.Optional(Type.String({ description: "Unit id paired with plan" })),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const blocked = childBlocked("agent_spawn");
      if (blocked) return blocked;
      try {
        const handle = await spawnBackground({
          roleId: params.role,
          task: params.task,
          cwd: ctx.cwd,
          foreground: signal,
          watch: interestFrom(params.plan, params.unit),
          executor: backgroundExecutor(),
        });
        return textResult(formatWorkerHandle(handle), handle);
      } catch (error) {
        const message = error instanceof PitakoConfigError || error instanceof Error ? error.message : String(error);
        return errorResult(message);
      }
    },
  });

  pi.registerTool({
    name: "agent_status",
    label: "Agent status",
    description: "Return compact background worker status. Does not wait for completion and does not include the result.",
    promptSnippet: "Inspect background workers without waiting",
    promptGuidelines: ["Use agent_status to see who is running. Do not poll it in a loop."],
    parameters: Type.Object(
      { id: Type.Optional(Type.String({ description: "Instance id. Omit to list every worker." })) },
      noExtra,
    ),
    async execute(_toolCallId, params) {
      const blocked = childBlocked("agent_status");
      if (blocked) return blocked;
      try {
        const views = workerStatus(params.id);
        return textResult(formatWorkerViews(views), { workers: views });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "agent_result",
    label: "Agent result",
    description:
      "Return one finished background worker result. Errors if it is still running. Does not wait. A failure is not permission to do that role in the parent.",
    promptSnippet: "Fetch a finished background worker result",
    promptGuidelines: ["Call agent_result only after a completion signal or a terminal agent_status. Do not poll."],
    parameters: Type.Object({ id: Type.String({ description: "Instance id" }) }, noExtra),
    async execute(_toolCallId, params) {
      const blocked = childBlocked("agent_result");
      if (blocked) return blocked;
      try {
        const result = workerResult(params.id);
        return textResult(formatAgentResult(result), result, result.status !== "completed");
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "agent_cancel",
    label: "Cancel agent",
    description: "Cancel one background worker. Does not wait for the run to finish. Does not cancel other workers.",
    promptSnippet: "Cancel one background worker",
    promptGuidelines: ["Use agent_cancel only for the worker you intend to stop."],
    parameters: Type.Object({ id: Type.String({ description: "Instance id" }) }, noExtra),
    async execute(_toolCallId, params) {
      const blocked = childBlocked("agent_cancel");
      if (blocked) return blocked;
      try {
        const view = cancelWorker(params.id);
        return textResult(formatWorkerViews([view]), view);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
