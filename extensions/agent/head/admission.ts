import { validateVerification, type VerificationGrantInput } from "./gates.ts";
import { loadPitakoConfig, resolveDeveloperHeadFromConfig } from "../../roles/load.ts";
import { currentWorkspace } from "../../board/workspace.ts";
import { HeadGraph } from "./graph.ts";
import { HeadAttachment, type HeadDagOptions } from "./runtime.ts";
import type { CheckpointOrigin } from "../checkpoints.ts";

/** Public validation happens before reservations, advice, or capability creation. */
export function validateAgentMode(params: { role: string; mode?: string; writes?: string[]; checkpoint_origin?: CheckpointOrigin; verification?: VerificationGrantInput }, cwd: string,
  asynchronous = true): Omit<HeadDagOptions, "executor"> | undefined {
  if (params.role === "developer_head") throw new Error("developer_head is internal; use developer with mode head");
  const mode = params.mode ?? "single";
  if (!["single", "head"].includes(mode)) throw new Error("invalid agent mode");
  if (params.checkpoint_origin !== undefined && (!asynchronous || params.role !== "developer" || mode !== "head")) {
    throw new Error("checkpoint_origin requires asynchronous developer mode head");
  }
  if (params.verification !== undefined && (!asynchronous || params.role !== "developer" || mode !== "head")) throw new Error("verification requires asynchronous developer mode head");
  const verification = params.verification && validateVerification(params.verification);
  if (mode === "single") {
    if (params.writes !== undefined) throw new Error("writes requires developer mode head");
    return;
  }
  if (!asynchronous || params.role !== "developer" || params.writes === undefined) {
    throw new Error("Head requires asynchronous developer admission and explicit writes (including [] or ['.'])");
  }
  new HeadGraph(currentWorkspace(cwd), params.writes);
  const config = loadPitakoConfig();
  const role = resolveDeveloperHeadFromConfig(config);
  if (!role.modelPolicy.primary) throw new Error(role.modelPolicy.diagnostic ?? "developer_head primary is not configured");
  return { writes: [...params.writes], config, ...(verification ? { verification } : {}),
    ...(params.checkpoint_origin ? { checkpoint_origin: params.checkpoint_origin } : {}) };
}

export function createHead(assignmentId: string, cwd: string, options: ReturnType<typeof validateAgentMode>,
  executor: HeadDagOptions["executor"], evidenceRoot?: string): HeadAttachment | undefined {
  return options ? new HeadAttachment(assignmentId, currentWorkspace(cwd), { ...options, executor, evidenceRoot }) : undefined;
}
