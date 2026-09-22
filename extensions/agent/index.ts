import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PitakoConfigError } from "../errors.ts";
import { currentInstanceId } from "./scope.ts";
import { createPiExecutor } from "./pi.ts";
import { formatAgentResult, runAgentInstance } from "./run.ts";

const noExtra = { additionalProperties: false } as const;

export default function agentInstance(pi: ExtensionAPI): void {
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
        });
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
