import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentViaEvents, type RuntimeAgentRegistration } from "pi-subagents/agents";
import { registerWorkflowResource, type WorkflowResourceRegistration } from "pi-subagents/workflow-resources";
import { designatedWorkspace, executionAmendments, preliminarySpec, validatePlanId, validateSpec } from "./spec-plans.ts";
import { boundRetainedAnalyses } from "./execute-retained.ts";
import { boundEpochAdvanceReplay, boundExecuteHostHalt, boundExecuteTimeoutProjection } from "./execute-progress.ts";
import { PitakoStore, StoreError } from "./pitako-store.ts";
import { EXECUTE_STATE_VERSION, executeContinuationScript, executionStatePath } from "./execute-state.ts";
import { executeCursorValidationScript } from "./execute-cursor.ts";
import { isExecuteReviewModel } from "./execute-settings.ts";
import { reviewModels } from "./review-settings.ts";
import { canonicalDigest, canonicalJSON } from "./canonical.mjs";
import { packageRoot } from "./stack.ts";
import { closingCompliance, closingArchive } from "../skills/execute/closing.mjs";
import { readTaskGateWire } from "../skills/execute/loop.ts";
import { reviewSynthesisScript } from "../skills/review/synthesis.mjs";
import { PITAKO_LOOP_OPERATIONS, pitakoLoopAgent } from "../skills/agent-names.mjs";
import { reviewCursorContract, reviewCursorScript } from "../skills/review/cursor.mjs";
import { architectureNativeSource } from "../skills/architecture/native.mjs";
import { planConflictReason, checkpointMismatchReason, settledBarrier, inspectorConflictReason, viewOverflowReason, checkpointWitnessIssue, nativeReference } from "../skills/execute/halt-evidence.mjs";

function inspectionCommand(args: string[], platform: NodeJS.Platform): string {
  if (platform !== "win32") return [process.execPath, ...args].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
  // cmd expands %variables% even inside quotes. Keep every supplied path out of shell syntax.
  const encoded = Buffer.from(JSON.stringify(args)).toString("base64");
  return `"${process.execPath}" -e "process.argv=[process.execPath,...JSON.parse(Buffer.from('${encoded}','base64').toString('utf8')),...process.argv.slice(1)];import(require('node:url').pathToFileURL(process.argv[1]).href)"`;
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
function validateMissionRecord(missionId: string, missionPath: unknown): { cwd?: unknown } {
  let record: { id?: unknown; cwd?: unknown } | null = null;
  if (typeof missionPath === "string" && path.isAbsolute(missionPath) && !missionPath.includes("\0") &&
      path.basename(missionPath) === `${missionId}.json`)
    try { record = JSON.parse(readFileSync(missionPath, "utf8")); } catch { /* invalid record */ }
  if (record?.id !== missionId)
    throw new Error(`Expected missionPath to be the existing native mission record ${missionId}.json, shown as "${RECORD_LINE.trim()}" by mission.create or mission.show. Its "State:" path or a derived path is not the record.`);
  return record;
}
function reviewWorktree({cwd}: {cwd?: unknown}): string {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0"))
    throw new Error("Standalone review wrong-cwd: the native mission has no designated worktree.");
  return realpathSync(cwd);
}
function rejectRemovedExecuteArguments(args: Readonly<Record<string, unknown>>): void {
  for (const key of ["unblock", "resolution"])
    if (Object.hasOwn(args, key)) throw new Error(`Unsupported execution argument: ${key}.`);
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
  const cursorValidationScript = executeCursorValidationScript();
  const continuationScript = executeContinuationScript();
  const canonicalScript = readFileSync(path.join(packageRoot(), "skills/workflow-canonical.js"), "utf8");
  const reviewScript = readFileSync(path.join(packageRoot(), "skills/review/workflow.js"), "utf8");
  const inspectorEntry = path.join(packageRoot(), "skills/execute/inspect.mjs");
  return { name: "pitako.execute", version: 1, resolve(args: Readonly<Record<string, unknown>>) {
    rejectRemovedExecuteArguments(args);
    validateTimeouts(args.timeouts);
    if (Object.keys(args).some(key => !["id", "root", "source", "sourceRefs", "amendments", "invocation", "missionId", "missionPath", "timeouts"].includes(key))) throw new Error("Unknown execution argument.");
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
    let recovery, timeoutRecovery, verifiedHostHalt, initialAdvance;
    let preliminaryStoreFailure;
    try {
      verifiedHostHalt = boundExecuteHostHalt(preliminary.root, context);
      if (!verifiedHostHalt) {
        initialAdvance = boundEpochAdvanceReplay(preliminary.root, context, preliminary);
        recovery = boundRetainedAnalyses(preliminary.root, preliminary.commonDir, preliminary.source,
          preliminary.digest, preliminary.binding, context);
        timeoutRecovery = boundExecuteTimeoutProjection(preliminary.root, context);
      }
    } catch (error) {
      // The native inspector reports the observation; only a deterministic writer may recover.
      if (!(error instanceof StoreError)) throw error;
      preliminaryStoreFailure = { code: error.code, reason: error.message };
    }
    const input = [inspectorEntry, preliminary.root, args.id, args.source ?? ""];
    const inspections = [{ key: "inspect-initial", command: inspectionCommand([
      ...input, "admission", JSON.stringify({ ...context, admission: { sourceRefs, agentDir } }),
    ], platform) }];
    inspections.push(...[1, 2].map(retry => ({ ...inspections[0]!, key: `inspect-initial.r${retry}` })));
    const config = { root: preliminary.root, id: args.id, invocation: args.invocation, missionId: args.missionId, missionPath: args.missionPath, sourceRefs, amendments, inspections, preliminary, ...(recovery ? { recovery } : {}), ...(timeoutRecovery ? { timeoutRecovery } : {}), ...(verifiedHostHalt ? { verifiedHostHalt } : {}),
      ...(initialAdvance ? { initialAdvance } : {}),
      ...(preliminaryStoreFailure ? { preliminaryStoreFailure } : {}),
      // Derived from the same bytes the root binds at admission; advisory only.
      originalProblem: validateSpec(preliminary.content, args.id),
      checkpointHelper: path.join(packageRoot(), "skills/execute/checkpoint.mjs"), stateVersion: EXECUTE_STATE_VERSION,
      ...(args.timeouts !== undefined ? { timeouts: args.timeouts } : {}), };
    return { script: `${closingCompliance.toString()}\n${closingArchive.toString()}\n${readTaskGateWire.toString()}\n${planConflictReason.toString()}\n${checkpointMismatchReason.toString()}\n${settledBarrier.toString()}\n${inspectorConflictReason.toString()}\n${viewOverflowReason.toString()}\n${checkpointWitnessIssue.toString()}\n${nativeReference.toString()}\n${canonicalScript}\n${cursorValidationScript}\n${continuationScript}\n${reviewSynthesisScript}const config = ${JSON.stringify(config)};\nconst pitakoReviewLibraryMode = true;\n${reviewScript}\n${rootScript}`,
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
export function analysisResource(name: keyof typeof ANALYSIS_WORKFLOWS, _root = process.cwd(), agentDir = path.resolve(getAgentDir())) {
  const workflow = ANALYSIS_WORKFLOWS[name];
  const source = readFileSync(path.join(packageRoot(), "skills/workflow-canonical.js"), "utf8") + "\n" +
    (name === "pitako.review" ? reviewSynthesisScript + reviewCursorScript : architectureNativeSource) +
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
      const root = reviewWorktree(validateMissionRecord(missionId, missionPath));
      const {key, validate} = reviewCursorContract();
      const file = executionStatePath({ missionId, missionPath });
      let retained;
      try { retained = JSON.parse(readFileSync(file, "utf8"))[key]; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (retained !== undefined) {
        const cursor = validate(key, retained);
        const newInput = cursor.identity !== canonicalDigest(input);
        const scope = `review:${cursor.scopeId}`;
        // A terminal overflow has a cursor diagnostic but no committed review.
        const committed = typeof cursor.terminal === "string" ? null : cursor.terminal;
        const store = new PitakoStore(root);
        let active;
        let unavailable = false;
        try { active = store.readActiveReview(); }
        catch (error) {
          // A different input can proceed to the writer if there is no usable old store.
          if (!(error instanceof StoreError) || error.code === "wrong-cwd" ||
              (committed !== null && !(newInput &&
                ["store-unavailable", "store-replaced", "store-corrupt"].includes(error.code))))
            throw new Error(`Standalone review integrity failure: ${scope}: ${String((error as Error).message)}`);
          unavailable = true;
        }
        const owner = active?.body as {missionPath?: string} | undefined;
        if (active && owner?.missionPath === missionPath && active.scope !== scope &&
            (committed !== null || (
              active.scope !== `review:${cursor.parentScope}` &&
              cursor.scopeId !== canonicalDigest({missionPath, identity: cursor.identity, prefix: cursor.prefix, priorScope: active.scope.slice(7)})
            )))
          throw new Error(`Standalone review integrity failure: cursor ${scope} differs from the active fence ${active.scope} at head ${active.head?.hash}.`);
        if (committed !== null && !unavailable) {
          const saved = store.readRecords(scope);
          const replaced = saved.identity.storeId !== committed.storeId;
          if (!(newInput && replaced) && (replaced || saved.head?.seq !== committed.head.seq ||
              saved.head?.hash !== committed.head.hash ||
              (saved.records[0]?.body as {missionPath?: string} | undefined)?.missionPath !== missionPath))
            throw new Error(`Standalone review integrity failure: terminal cursor ${scope} does not match its stored head.`);
        }
      }
      // Native replay checks script bytes before the workflow can read its state.
      const selected = retained?.identity === canonicalDigest(input) && retained.terminal === null
        ? validate(key, retained).models : reviewModels(root, agentDir);
      for (const slot of ["r1", "r2", "synthesis"] as const)
        if (selected?.[slot]?.key !== `pitako.review.${slot}` || !isExecuteReviewModel(selected?.[slot]?.model))
          throw new Error(`${file}: pitako.review.${slot}: invalid frozen model selection.`);
      models = `const pitakoReviewModels = ${canonicalJSON(selected)};\n`;
    }
    return { script: `const args = ${name === "pitako.review" ? canonicalJSON(input) : JSON.stringify(input)};\nconst pitakoAccess = ${JSON.stringify(access)};\n${models}${source}` };
  } };
}
const NAMED_WORKFLOWS = ["pitako.execute", ...Object.keys(ANALYSIS_WORKFLOWS)];
type RuntimeAgent = { name: string; description: string; systemPrompt: string; args: string[] };
const RUNTIME_AGENTS: RuntimeAgent[] = [
  // One loop-io runner, named per operation so hosts can show what each child does.
  ...PITAKO_LOOP_OPERATIONS.map(operation => ({ name: pitakoLoopAgent(operation),
    description: `Deterministic execute loop ${operation} (backlog, Board memory and command gates); no model execution.`,
    systemPrompt: "Fixed loop I/O; stdin is a JSON prepare, apply or gate request. Gates require a settled worker.",
    args: ["skills/execute/loop-io.mjs"] })),
  { name: "pitako.checkout-observer", description: "Deterministic actual-cwd checkout evidence; no model or prompt execution.",
    systemPrompt: "Fixed actual-cwd observer and ledger publisher; stdin is a JSON {expected, body} request, never a workspace selector.",
    args: ["skills/execute/observe.mjs"] },
  { name: "pitako.execution-ledger", description: "Deterministic hash-chained execution ledger publication; no model execution.",
    systemPrompt: "Fixed execution ledger; stdin is a JSON publication request.", args: ["skills/execute/ledger.mjs"] },
  { name: "pitako.architecture-ledger", description: "Deterministic hash-chained architecture ledger publication; no model execution.",
    systemPrompt: "Fixed architecture store writer and observer; stdin is a JSON ledger request for the actual cwd.", args: ["skills/architecture/ledger.mjs"] },
  { name: "pitako.review-store", description: "Deterministic standalone review recovery observation and final save; no model execution.",
    systemPrompt: "Fixed standalone review I/O; stdin is a JSON observe-review or save-review request for the actual cwd.", args: ["skills/review/store-io.mjs"] },
  { name: "pitako.request-observer", description: "Deterministic main-session execute request reader; no model execution.",
    systemPrompt: "Fixed execute request observer; stdin is JSON {invocation, cursor}.", args: ["skills/execute/observe.mjs", "--requests"] },
  { name: "pitako.checkpoint-sealer", description: "Deterministic checkpoint journal verification and seal metadata publication; no model execution.",
    systemPrompt: "Fixed checkpoint sealer; stdin is a JSON {v, intent, kind, restoreSources?} request.", args: ["skills/execute/checkpoint.mjs", "--seal-stdin"] },
  { name: "pitako.originals-verifier", description: "Deterministic access receipt verification of published originals; no model execution.",
    systemPrompt: "Fixed access verifier; stdin is a JSON {missionPath, namespace, gate, items} request.", args: ["extensions/access-receipts.mjs", "--verify-stdin"] },
];
export default function planExecute(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as { workflow?: unknown; cwd?: unknown; args?: { missionId?: unknown; missionPath?: unknown; root?: unknown; timeouts?: unknown }; options?: { missionId?: unknown; mission?: unknown } };
    const name = typeof input.workflow === "string" ? input.workflow.trim() : undefined;
    if (!name || !NAMED_WORKFLOWS.includes(name)) return;
    const options = input.options;
    if (name === "pitako.execute") {
      try { rejectRemovedExecuteArguments(input.args ?? {}); validateTimeouts(input.args?.timeouts); }
      catch (error) { return { block: true, reason: String(error instanceof Error ? error.message : error) }; }
    }
    if (options?.mission !== undefined || !isMissionId(input.args?.missionId) || input.args.missionId !== options?.missionId)
      return { block: true, reason: `${name} requires a mission already created via mission.create, with the same native missionId in args and options. One-step mission creation is unsupported; this is data association, not approval or confinement.` };
    try {
      const mission = validateMissionRecord(input.args.missionId, input.args.missionPath);
      if (name === "pitako.review") {
        if ((input.cwd !== undefined && typeof input.cwd !== "string") ||
            realpathSync(path.resolve(ctx.cwd, input.cwd ?? ".")) !== reviewWorktree(mission))
          throw new Error("Standalone review wrong-cwd: use the mission's designated worktree.");
      }
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
