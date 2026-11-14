import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentViaEvents, type RuntimeAgentRegistration } from "pi-subagents/agents";
import { registerWorkflowResource, type WorkflowResourceRegistration } from "pi-subagents/workflow-resources";
import { designatedWorkspace, executionAmendments, preliminarySpec, validatePlanId, validateSpec } from "./spec-plans.ts";
import { boundRetainedAnalyses } from "./execute-retained.ts";
import { EXECUTE_STATE_VERSION, executionStatePath, compactWorkerReferences, expandWorkerReferences } from "./execute-state.ts";
import { isExecuteReviewModel } from "./execute-settings.ts";
import { reviewModels } from "./review-settings.ts";
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
const RECORD_LINE = "Mission record path (args.missionPath): ";
/**
 * Checkpoints resolve execute state beside the native record (execute-state.ts), so only the
 * existing record `<store>/<missionId>.json` qualifies. Native validates options.missionId,
 * never this Pitako pointer; a wrong pointer would otherwise fail only at the first worker write.
 */
function validateMissionRecord(missionId: string, missionPath: unknown): void {
  let id: unknown;
  if (typeof missionPath === "string" && path.isAbsolute(missionPath) && !missionPath.includes("\0") &&
      path.basename(missionPath) === `${missionId}.json`)
    try { id = (JSON.parse(readFileSync(missionPath, "utf8")) as { id?: unknown } | null)?.id; } catch { id = undefined; }
  if (id !== missionId)
    throw new Error(`Expected missionPath to be the existing native mission record ${missionId}.json, shown as "${RECORD_LINE.trim()}" by mission.create or mission.show. Its "State:" path or a derived path is not the record.`);
}
function validateResolution(args: Readonly<Record<string, unknown>>): void {
  if (args.unblock === undefined && args.resolution === undefined) return;
  const value = args.resolution as { loop?: unknown; text?: unknown } | undefined;
  if (args.unblock !== true || !value || Object.keys(value).sort().join(",") !== "loop,text" ||
      !Number.isSafeInteger(value.loop) || (value.loop as number) < 0 ||
      typeof value.text !== "string" || !value.text.trim() || value.text.includes("\0"))
    throw new Error("--unblock requires current human resolution: {loop, text}; loop 0 denotes a pre-admission request.");
}
function validateTimeouts(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.entries(value).some(([key, ms]) => !["reviewerMs", "workerMs", "gateFloorMs"].includes(key) ||
        !Number.isSafeInteger(ms) || (ms as number) < 1 || (ms as number) > 86400000))
    throw new Error("Expected timeouts {reviewerMs?, workerMs?, gateFloorMs?}: safe integers in 1..86400000, no unknown keys.");
}
export function executionResource(platform: NodeJS.Platform = process.platform) {
  // Pi resolves a relative agent dir in the host, not the designated child's cwd.
  const agentDir = path.resolve(getAgentDir());
  // Trusted complete sources are loaded at setup, never discovered in resolve.
  const rootScript = readFileSync(path.join(packageRoot(), "skills/execute/workflow.js"), "utf8");
  const canonicalScript = readFileSync(path.join(packageRoot(), "skills/workflow-canonical.js"), "utf8");
  const reviewScript = readFileSync(path.join(packageRoot(), "skills/review/workflow.js"), "utf8");
  const inspectorEntry = path.join(packageRoot(), "skills/execute/inspect.mjs");
  return { name: "pitako.execute", version: 1, resolve(args: Readonly<Record<string, unknown>>) {
    validateResolution(args);
    validateTimeouts(args.timeouts);
    if (Object.keys(args).some(key => !["id", "root", "source", "sourceRefs", "amendments", "invocation", "missionId", "missionPath", "unblock", "resolution", "timeouts"].includes(key))) throw new Error("Unknown execution argument.");
    if (!isMissionId(args.missionId)) throw new Error("Expected an existing native missionId data pointer.");
    if (typeof args.missionPath !== "string" || !path.isAbsolute(args.missionPath) || args.missionPath.includes("\0"))
      throw new Error("Expected the actual absolute missionPath returned by native mission.create or mission.show.");
    validatePlanId(args.id);
    validatePlanId(args.invocation);
    if (typeof args.root !== "string" || (args.source !== undefined && typeof args.source !== "string")) throw new Error("Expected designated root and optional explicit source.");
    if (!path.isAbsolute(args.root) || args.root.includes("\0")) throw new Error("Expected absolute designated root.");
    // Physical Git/worktree validation belongs to the launch hook and inspector.
    const root = path.normalize(args.root);
    const sourceRefs = args.sourceRefs ?? [];
    if (!Array.isArray(sourceRefs) || sourceRefs.length > 2 || sourceRefs.some(ref =>
      !ref || Object.keys(ref).sort().join(",") !== "digest,path" ||
      typeof ref.path !== "string" || !path.isAbsolute(ref.path) || ref.path.includes("\0") ||
      !/^[a-f0-9]{64}$/.test(ref.digest)))
      throw new Error("Expected at most two complete spec sourceRefs with absolute path and SHA-256 digest.");
    const amendments = executionAmendments(root, args.amendments);
    const context = { missionId: args.missionId, missionPath: args.missionPath, invocation: args.invocation, sourceRefs, amendments };
    // Preliminary synchronous discovery is data capture, not native admission.
    const preliminary = preliminarySpec(root, args.id, args.source as string | undefined);
    const recovery = boundRetainedAnalyses(preliminary.root, preliminary.commonDir, preliminary.source,
      preliminary.digest, preliminary.binding, context);
    const input = [inspectorEntry, preliminary.root, args.id, args.source ?? ""];
    const inspections = [{ key: "inspect-initial", command: inspectionCommand([
      ...input, "admission", JSON.stringify({ ...context, admission: { sourceRefs, agentDir } }),
    ], platform) }];
    inspections.push(...[1, 2].map(retry => ({ ...inspections[0]!, key: `inspect-initial.r${retry}` })));
    const config = { root: preliminary.root, id: args.id, invocation: args.invocation, missionId: args.missionId, missionPath: args.missionPath, sourceRefs, amendments, inspections, preliminary, ...(recovery ? { recovery } : {}),
      // Derived from the same bytes the root binds at admission; advisory only.
      originalProblem: validateSpec(preliminary.content, args.id),
      checkpointHelper: path.join(packageRoot(), "skills/execute/checkpoint.mjs"), stateVersion: EXECUTE_STATE_VERSION,
      ...(args.timeouts !== undefined ? { timeouts: args.timeouts } : {}),
      ...(args.unblock === true ? { unblock: true, resolution: args.resolution } : {}) };
    return { script: `${compactWorkerReferences.toString()}\n${expandWorkerReferences.toString()}\n${canonicalScript}\nconst config = ${JSON.stringify(config)};\nconst pitakoReviewLibraryMode = true;\n${reviewScript}\n${rootScript}`,
      hostCommands: inspections };
  } };
}
const ANALYSIS_WORKFLOWS = {
  "pitako.review": { source: "skills/review/workflow.js", namespace: () => "review" },
  "pitako.architecture": { source: "skills/architecture/workflow.js",
    namespace: (args: Readonly<Record<string, unknown>>) => {
      if (typeof args.consultation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.consultation))
        throw new Error("Provide a stable architecture consultation ID.");
      return `architecture-${args.consultation}`;
    } },
} as const;
/**
 * Review and architecture run only as named resources with a pre-created mission:
 * receipts need the resolve-time mission record path and a receipt namespace.
 * The trusted source is read at setup; args are inlined as data.
 */
export function analysisResource(name: keyof typeof ANALYSIS_WORKFLOWS, root = process.cwd(), agentDir = path.resolve(getAgentDir())) {
  const workflow = ANALYSIS_WORKFLOWS[name];
  const source = readFileSync(path.join(packageRoot(), "skills/workflow-canonical.js"), "utf8") + "\n" +
    readFileSync(path.join(packageRoot(), workflow.source), "utf8");
  return { name, version: 1, resolve(args: Readonly<Record<string, unknown>>) {
    const { missionId, missionPath, ...input } = args;
    if (!isMissionId(missionId)) throw new Error(`${name} requires an existing native missionId from mission.create.`);
    if (typeof missionPath !== "string" || !path.isAbsolute(missionPath) || missionPath.includes("\0") ||
        path.basename(missionPath) !== `${missionId}.json`)
      throw new Error(`${name} requires the actual mission record path returned by mission.create or mission.show.`);
    const access = { missionPath, namespace: workflow.namespace(input) };
    let models = "";
    if (name === "pitako.review") {
      const file = executionStatePath({ missionId, missionPath });
      let retained;
      try { retained = JSON.parse(readFileSync(file, "utf8"))["review-standalone"]; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Native replay checks script bytes before the workflow can read its state.
      const selected = retained === undefined ? reviewModels(root, agentDir) : retained.models;
      for (const slot of ["r1", "r2", "synthesis"] as const)
        if (selected?.[slot]?.key !== `pitako.review.${slot}` || !isExecuteReviewModel(selected?.[slot]?.model))
          throw new Error(`${file}: pitako.review.${slot}: invalid frozen model selection.`);
      models = `const pitakoReviewModels = ${JSON.stringify(selected)};\n`;
    }
    return { script: `const args = ${JSON.stringify(input)};\nconst pitakoAccess = ${JSON.stringify(access)};\n${models}${source}` };
  } };
}
const NAMED_WORKFLOWS = ["pitako.execute", ...Object.keys(ANALYSIS_WORKFLOWS)];
type RuntimeAgent = { name: string; description: string; systemPrompt: string; args: string[] };
const RUNTIME_AGENTS: RuntimeAgent[] = [
  { name: "pitako.loop-io", description: "Deterministic execute backlog, Board memory and command gates; no model execution.",
    systemPrompt: "Fixed loop I/O; stdin is a JSON prepare, apply or gate request. Gates require a settled worker.",
    args: ["skills/execute/loop-io.mjs"] },
  { name: "pitako.checkout-observer", description: "Deterministic actual-cwd checkout evidence; no model or prompt execution.",
    systemPrompt: "Fixed actual-cwd observer and ledger publisher; stdin is a JSON {expected, body} request, never a workspace selector.",
    args: ["skills/execute/observe.mjs"] },
  { name: "pitako.execution-ledger", description: "Deterministic hash-chained execution ledger publication; no model execution.",
    systemPrompt: "Fixed execution ledger; stdin is a JSON publication request.", args: ["skills/execute/ledger.mjs"] },
  { name: "pitako.architecture-ledger", description: "Deterministic hash-chained architecture ledger publication; no model execution.",
    systemPrompt: "Fixed architecture ledger; stdin is a JSON publication request or {missionPath, consultation, expected, observe:true} for read-only chain and state-size observation.", args: ["skills/architecture/ledger.mjs"] },
  { name: "pitako.request-observer", description: "Deterministic main-session execute request reader; no model execution.",
    systemPrompt: "Fixed execute request observer; stdin is JSON {invocation, cursor}.", args: ["skills/execute/observe.mjs", "--requests"] },
  { name: "pitako.checkpoint-sealer", description: "Deterministic checkpoint journal verification and seal metadata publication; no model execution.",
    systemPrompt: "Fixed checkpoint sealer; stdin is a JSON {v, intent, kind, restoreSources?} request.", args: ["skills/execute/checkpoint.mjs", "--seal-stdin"] },
  { name: "pitako.access-verifier", description: "Deterministic access receipt verification of published originals; no model execution.",
    systemPrompt: "Fixed access verifier; stdin is a JSON {missionPath, namespace, gate, items} request.", args: ["extensions/access-receipts.mjs", "--verify-stdin"] },
];
export default function planExecute(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as { workflow?: unknown; cwd?: unknown; args?: { missionId?: unknown; missionPath?: unknown; root?: unknown; unblock?: unknown; timeouts?: unknown }; options?: { missionId?: unknown; mission?: unknown } };
    const name = typeof input.workflow === "string" ? input.workflow.trim() : undefined;
    if (!name || !NAMED_WORKFLOWS.includes(name)) return;
    const options = input.options;
    if (name === "pitako.execute") {
      try { validateResolution(input.args ?? {}); validateTimeouts(input.args?.timeouts); }
      catch (error) { return { block: true, reason: String(error instanceof Error ? error.message : error) }; }
    }
    if (options?.mission !== undefined || !isMissionId(input.args?.missionId) || input.args.missionId !== options?.missionId)
      return { block: true, reason: `${name} requires a mission already created via mission.create, with the same native missionId in args and options. One-step mission creation is unsupported; this is data association, not approval or confinement.` };
    try {
      validateMissionRecord(input.args.missionId, input.args.missionPath);
      if (name !== "pitako.execute") return;
      if (typeof input.args?.root !== "string" || (input.cwd !== undefined && typeof input.cwd !== "string")) throw new Error("Expected designated root and launch cwd.");
      // The resolver receives args only. The public tool call owns the actual launch cwd.
      const launch = input.cwd ? path.resolve(ctx.cwd, input.cwd) : ctx.cwd;
      if (designatedWorkspace(launch).physicalRoot !== designatedWorkspace(input.args.root).physicalRoot)
        throw new Error("Workflow cwd must be the designated worktree, not the spec's source worktree.");
    } catch (error) { return { block: true, reason: String(error instanceof Error ? error.message : error) }; }
  });
  // Native returns the record path only in details, which the model never sees.
  pi.on("tool_result", event => {
    const action = (event.input as { action?: unknown }).action;
    const details = event.details as { missionId?: unknown; missionPath?: unknown } | undefined;
    if (event.toolName !== "subagent" || event.isError || typeof action !== "string" || !action.startsWith("mission.") ||
        typeof details?.missionId !== "string" || typeof details.missionPath !== "string") return;
    const line = RECORD_LINE + details.missionPath;
    if (event.content.some(part => part.type === "text" && part.text.includes(line))) return;
    return { content: [...event.content, { type: "text", text: line }],
      ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }) };
  });
  const registrations: (RuntimeAgentRegistration | WorkflowResourceRegistration)[] = [];
  function dispose() {
    for (const registration of registrations.splice(0).reverse()) registration.dispose();
  }
  pi.on("session_start", (_event, ctx) => {
    dispose();
    try {
      for (const agent of RUNTIME_AGENTS) registrations.push(registerAgentViaEvents({ pi, name: agent.name, definition: {
        description: agent.description, systemPrompt: agent.systemPrompt,
        systemPromptMode: "replace", tools: [], allowNestedSubagents: false,
        inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
        defaultContext: "fresh", defaultAsync: false,
        // Deterministic: no inferred acceptance contract may be appended to the JSON stdin request.
        acceptanceRole: "read-only",
        runner: { type: "external-cli", command: process.execPath,
          args: [path.join(packageRoot(), agent.args[0]!), ...agent.args.slice(1)], promptDelivery: "stdin" },
      } }));
      const sessionId = ctx.sessionManager.getSessionId();
      registrations.push(registerWorkflowResource({ sessionId, definition: executionResource() }));
      for (const name of Object.keys(ANALYSIS_WORKFLOWS) as (keyof typeof ANALYSIS_WORKFLOWS)[])
        registrations.push(registerWorkflowResource({ sessionId, definition: analysisResource(name, ctx.cwd) }));
    } catch (error) {
      dispose();
      throw new Error(`Deterministic runtime agent or workflow resource registration failed: ${String(error instanceof Error ? error.message : error)}. Inspect the installed pi-subagents registration listener and conflicting agent; reconcile it before preparing execution. No fallback was registered.`);
    }
  });
  pi.on("session_shutdown", dispose);
}
