import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readlinkSync, readFileSync } from "node:fs";
import path from "node:path";
import { sha256, type MissionDefinition } from "./model.ts";
import type { MissionInspection, MissionStore } from "./store.ts";
import { captureWorkspaceImage, type WorkspaceManifest } from "./workspace.ts";
import { MISSION_CHECK_IDENTITY, missionCheckRuntime } from "./checks.ts";
import { missionInputIdentity } from "./inputs.ts";
import { verifyExecutionBinding, type ExecutionBinding } from "../workflow.ts";

// Binding.finalization distinguishes this engine-owned target from user units.
export const FINALIZATION_OWNER = "mission-finalization";
export const FINALIZATION_PHASES = ["integrate", "integrated-checks", "ponytail", "affected-checks", "cleanup", "final-gates", "whole-review"] as const;
export type FinalizationPhase = typeof FINALIZATION_PHASES[number];
export interface FinalizationTarget {
  version: 1;
  kind: "finalization";
  generation: number;
  phase: FinalizationPhase;
  inputArtifactHash: string;
  acceptedInputHash: string;
  sourceWitnessHash: string;
  inputIdentityHash: string;
  manifestHash?: string;
}
export interface FinalizationPhaseReceipt {
  format: "mission-finalization-phase-v1";
  missionId: string;
  revision: number;
  target: FinalizationTarget;
  outputGeneration: number;
  outputArtifactHash: string;
  attemptId: string;
  sessionId: string | null;
  instanceId: string | null;
  rolePolicyHash: string | null;
  evidenceHashes: string[];
}
export interface MissionFinalManifest {
  format: "mission-final-manifest-v1";
  missionId: string;
  revision: number;
  generation: number;
  planHash: string;
  definitionHash: string;
  originalBaseImageHash: string;
  deliveryBaseImageHash: string;
  resultImageHash: string;
  resultManifestHash: string;
  acceptedInputHash: string;
  sourceWitnessHash: string;
  inputIdentity: unknown;
  phaseReceiptHashes: string[];
  producerAttempts: string[];
}
export interface WholeResultResponse {
  format: "mission-whole-result-response-v1";
  scope: "whole-result";
  missionId: string;
  revision: number;
  generation: number;
  manifestHash: string;
  rolePolicyHash: string;
  evidenceHashes: string[];
  verdict: "approve" | "reject" | "inconclusive";
}
export interface WholeResultApproval extends Omit<WholeResultResponse, "format"> {
  format: "mission-whole-result-approval-v1";
  attemptId: string;
  sessionId: string;
  instanceId: string;
  reviewArtifactHash: string;
  sourceWitnessHash: string;
}
export const finalizationHash = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));

export function compileFinalizationGrants(definition: MissionDefinition) {
  const launches = definition.units.reduce((sum, unit) => sum + (unit.team ? unit.team.members.length * 3 + 1 : 1), 0);
  const versioned = definition.finalization.contractVersion === 1;
  const roleLaunches = versioned ? 3 : 1 + Number(definition.finalization.independentReview);
  const providerRequests = roleLaunches + Number(versioned);
  const stages = versioned ? 7 : roleLaunches;
  const requestTokens = Math.max(1, Math.ceil(definition.budget.tokens / definition.budget.providerRequests));
  // Two shares per launch is an allocation convention, not a provider input estimate.
  const tokens = versioned ? Math.max(requestTokens, Math.ceil(definition.budget.tokens / (2 * definition.budget.roleLaunches))) : requestTokens;
  const active = Math.max(1, Math.floor(definition.budget.activeTimeMs / (definition.budget.roleLaunches + (versioned ? 4 : 0))));
  const artifacts = Math.max(1, Math.floor(definition.budget.artifactBytes / (definition.budget.roleLaunches + (versioned ? 4 : 0))));
  const protectedAmounts = { "role-launches": roleLaunches, "provider-requests": providerRequests,
    tokens: providerRequests * tokens, "active-time-ms": stages * active, "artifact-bytes": stages * artifacts };
  const ordinary = { "role-launches": launches, "provider-requests": launches,
    tokens: launches * requestTokens, "active-time-ms": launches * active, "artifact-bytes": launches * artifacts };
  const caps = { "role-launches": definition.budget.roleLaunches, "provider-requests": definition.budget.providerRequests,
    tokens: definition.budget.tokens, "active-time-ms": definition.budget.activeTimeMs, "artifact-bytes": definition.budget.artifactBytes };
  for (const resource of Object.keys(caps) as Array<keyof typeof caps>)
    if (ordinary[resource] + protectedAmounts[resource] > caps[resource])
      throw new Error(`mandatory path plus protected finalization needs ${ordinary[resource] + protectedAmounts[resource]} ${resource}; budget allows ${caps[resource]}`);
  return { protectedAmounts, active, artifacts, tokens, requestTokens,
    stages: FINALIZATION_PHASES.map((phase) => ({ phase, activeTimeMs: active, artifactBytes: artifacts,
      roleLaunches: Number(["ponytail", "cleanup", "whole-review"].includes(phase)),
      providerRequests: phase === "ponytail" ? 2 : Number(["cleanup", "whole-review"].includes(phase)) })) };
}

export function acceptedFinalizationInput(inspection: MissionInspection): string {
  return finalizationHash(inspection.definition.units.map(({ id }) => {
    const event = [...inspection.events].reverse().find((row) => row.kind === "unit.accepted" && row.unitId === id &&
      row.revision === inspection.revision);
    if (!event?.payload.outputBindingHash) throw new Error(`current accepted output missing: ${id}`);
    return { id, eventId: event.eventId, outputBindingHash: event.payload.outputBindingHash };
  }));
}

export interface SourceMutationWitness {
  format: "mission-linux-source-witness-v1";
  root: string;
  planId?: string;
  sourceBinding?: ExecutionBinding;
  manifestHash: string;
  paths: Array<{ path: string; present: boolean; dev?: string; ino?: string; ctimeNs?: string; mode?: string; target?: string }>;
}

/** Separate from byte identity: Linux ctime detects ordinary edit-then-restore. No watcher or same-UID forgery promise. */
export function observeSourceMutation(root: string, manifest: WorkspaceManifest, planId?: string, sourceBinding?: ExecutionBinding): SourceMutationWitness {
  if (process.platform !== "linux") throw new Error("reliable Linux lstat mutation witness unavailable");
  const names = new Set<string>([".", ".git"]);
  if (sourceBinding) {
    verifyExecutionBinding(sourceBinding);
    if (sourceBinding.executionRoot !== path.resolve(root)) throw new Error("source witness execution root differs from pin");
    names.add(sourceBinding.planSource);
  } else if (planId) for (const name of [".pitako", ".pitako/plans", `.pitako/plans/${planId}.md`, `.pitako/plans/${planId}.mission.json`]) names.add(name);
  for (const entry of [...manifest.tracked, ...manifest.untracked]) {
    names.add(entry.path);
    for (let parent = path.dirname(entry.path); parent !== "."; parent = path.dirname(parent)) names.add(parent);
  }
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const gitPath = (name: string) => path.resolve(root, git(["rev-parse", "--git-path", name]));
  for (const name of ["HEAD", "index", "packed-refs", "refs"]) names.add(gitPath(name));
  const walkRefs = (directory: string) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const name = path.join(directory, entry.name); names.add(name);
      if (entry.isDirectory()) walkRefs(name);
    }
  };
  walkRefs(gitPath("refs"));
  const rows = [...names].sort().map((name) => {
    const absolute = path.resolve(root, name);
    try {
      const stat = lstatSync(absolute, { bigint: true });
      if (stat.ctimeNs <= 0n || stat.ino <= 0n) throw new Error(`unreliable change witness: ${name}`);
      return { path: name, present: true, dev: String(stat.dev), ino: String(stat.ino), ctimeNs: String(stat.ctimeNs),
        mode: String(stat.mode), ...(stat.isSymbolicLink() ? { target: readlinkSync(absolute) } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: name, present: false };
      throw error;
    }
  });
  return { format: "mission-linux-source-witness-v1", root: path.resolve(root), ...(planId ? { planId } : {}),
    ...(sourceBinding ? { sourceBinding } : {}), manifestHash: manifest.hash, paths: rows };
}

export function sourceWitnessCurrent(store: MissionStore, hash: string, root: string): boolean {
  try {
    const saved = JSON.parse(store.readArtifact(hash).toString()) as SourceMutationWitness;
    const current = captureWorkspaceImage(root).manifest;
    return saved.format === "mission-linux-source-witness-v1" &&
      finalizationHash(observeSourceMutation(root, current, saved.planId, saved.sourceBinding)) === hash;
  } catch { return false; }
}

export function finalizationInputIdentity(inspection: MissionInspection, source: WorkspaceManifest, sourceRoot: string, store: MissionStore) {
  const { planHash, definitionHash, ...pin } = missionInputIdentity(inspection, sourceRoot);
  const setup = inspection.prepared?.setup ? new MissionSetup(store, inspection.id).observe(inspection) : undefined;
  if (setup?.state === "blocked") throw new Error(`setup prerequisite: ${setup.reason}`);
  return { source, predicates: inspection.definition.units.map(({ id, inputs, acceptance }) => ({ id, inputs, acceptance })),
    planHash, definitionHash, ...(inspection.prepared ? { pin, prepared: inspection.prepared } : {}), ...(setup ? { setup } : {}),
    rolePolicies: inspection.definition.authority.rolePolicies, checkerIdentity: MISSION_CHECK_IDENTITY, runtimeIdentity: missionCheckRuntime() };
}

export function parseFinalizationResponse(text: string) {
  const body = text.trim();
  const fence = /^```json\r?\n([\s\S]*?)\r?\n```$/.exec(body);
  return JSON.parse(fence ? fence[1]! : body);
}

export function parseWholeResultResponse(text: string, expected: Omit<WholeResultResponse, "verdict">): WholeResultResponse {
  const value = parseFinalizationResponse(text) as WholeResultResponse;
  if (!value || Object.keys(value).sort().join() !== [...Object.keys(expected), "verdict"].sort().join() ||
    !["approve", "reject", "inconclusive"].includes(value.verdict) ||
    Object.entries(expected).some(([key, item]) => finalizationHash(value[key as keyof WholeResultResponse]) !== finalizationHash(item)))
    throw new Error("whole-result response does not bind the exact current manifest, generation, policy and evidence");
  return value;
}

export function currentWholeResultApproval(inspection: MissionInspection, store: MissionStore, sourceRoot: string): WholeResultApproval | undefined {
  try {
    const event = [...inspection.events].reverse().find((row) => row.kind === "mission.finalization.reviewed" && row.revision === inspection.revision);
    const outstanding = new Set<string>();
    for (const row of inspection.events) {
      if (row.attemptId && ["attempt.reserved", "attempt.started"].includes(row.kind)) outstanding.add(row.attemptId);
      if (row.attemptId && row.kind === "attempt.settled") outstanding.delete(row.attemptId);
    }
    if (outstanding.size) return;
    if (!event || inspection.events.some((row) => row.seq > event.seq &&
      ["mission.finalization.generation", "mission.finalization.invalidated", "mission.revised", "evidence.invalidated", "unit.accepted", "mission.result.integrated"].includes(row.kind))) return;
    const approval = JSON.parse(store.readArtifact(String(event.payload.approvalHash)).toString()) as WholeResultApproval;
    if (approval.format !== "mission-whole-result-approval-v1" || approval.verdict !== "approve" ||
      approval.revision !== inspection.revision || approval.missionId !== inspection.id ||
      !sourceWitnessCurrent(store, approval.sourceWitnessHash, sourceRoot)) return;
    const manifest = JSON.parse(store.readArtifact(approval.manifestHash).toString()) as MissionFinalManifest;
    if (manifest.acceptedInputHash !== acceptedFinalizationInput(inspection) ||
      manifest.generation !== approval.generation || manifest.sourceWitnessHash !== approval.sourceWitnessHash ||
      finalizationHash(manifest.inputIdentity) !== finalizationHash(finalizationInputIdentity(inspection, captureWorkspaceImage(sourceRoot).manifest, sourceRoot, store))) return;
    return approval;
  } catch { return; }
}
import { MissionSetup } from "./setup.ts";
