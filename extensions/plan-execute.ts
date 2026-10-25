import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowResource, type WorkflowResourceRegistration } from "pi-subagents/workflow-resources";
import { designatedWorkspace, validatePlanId } from "./spec-plans.ts";
import { packageRoot } from "./stack.ts";

function inspectionCommand(args: string[], platform: NodeJS.Platform): string {
  if (platform !== "win32") return ["node", ...args].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
  // cmd expands %variables% even inside quotes. Keep every supplied path out of shell syntax.
  const encoded = Buffer.from(JSON.stringify(args)).toString("base64");
  return `node -e "process.argv=[process.execPath,...JSON.parse(Buffer.from('${encoded}','base64').toString('utf8')),...process.argv.slice(1)];import(require('node:url').pathToFileURL(process.argv[1]).href)"`;
}
function isMissionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..");
}
export function executionResource(platform: NodeJS.Platform = process.platform) {
  return { name: "pitako.execute", version: 1, resolve(args: Readonly<Record<string, unknown>>) {
    if (Object.keys(args).some(key => !["id", "root", "source", "invocation", "missionId"].includes(key))) throw new Error("Unknown execution argument.");
    if (!isMissionId(args.missionId)) throw new Error("Expected an existing native missionId data pointer.");
    validatePlanId(args.id);
    validatePlanId(args.invocation);
    if (typeof args.root !== "string" || (args.source !== undefined && typeof args.source !== "string")) throw new Error("Expected designated root and optional explicit source.");
    const root = designatedWorkspace(args.root).physicalRoot;
    const command = inspectionCommand([path.join(packageRoot(), "skills/execute/inspect.mjs"), root, args.id, args.source ?? ""], platform);
    const chunks = Array.from({ length: 26 }, (_, index) => ({ key: `input-${index}`, command: `${command} ${index}` }));
    const inspections = ["initial", "cycle-1", "cycle-2", "cycle-3", "validation-before", "validation-after"].map(phase => ({ key: `inspect-${phase}`, command: `${command} metadata` }));
    const config = { root, id: args.id, invocation: args.invocation, missionId: args.missionId, inspections, chunks };
    return { script: `const config = ${JSON.stringify(config)};\n${readFileSync(path.join(packageRoot(), "skills/execute/workflow.js"), "utf8")}`,
      hostCommands: [...inspections, ...chunks] };
  } };
}
export default function planExecute(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as { workflow?: unknown; cwd?: unknown; args?: { missionId?: unknown; root?: unknown }; options?: { missionId?: unknown; mission?: unknown } };
    if (typeof input.workflow !== "string" || input.workflow.trim() !== "pitako.execute") return;
    const options = input.options;
    if (options?.mission !== undefined || !isMissionId(input.args?.missionId) || input.args.missionId !== options?.missionId)
      return { block: true, reason: "pitako.execute requires a mission already created via mission.create, with the same native missionId in args and options. One-step mission creation is unsupported; this is data association, not approval or confinement." };
    try {
      if (typeof input.args?.root !== "string" || (input.cwd !== undefined && typeof input.cwd !== "string")) throw new Error("Expected designated root and launch cwd.");
      // The resolver receives args only. The public tool call owns the actual launch cwd.
      const launch = input.cwd ? path.resolve(ctx.cwd, input.cwd) : ctx.cwd;
      if (designatedWorkspace(launch).physicalRoot !== designatedWorkspace(input.args.root).physicalRoot)
        throw new Error("Workflow cwd must be the designated worktree, not the spec's source worktree.");
    } catch (error) { return { block: true, reason: String(error instanceof Error ? error.message : error) }; }
  });
  let registration: WorkflowResourceRegistration | undefined;
  pi.on("session_start", (_event, ctx) => {
    registration?.dispose();
    registration = registerWorkflowResource({ sessionId: ctx.sessionManager.getSessionId(), definition: executionResource() });
  });
  pi.on("session_shutdown", () => { registration?.dispose(); registration = undefined; });
}
