import { loadPitakoConfig, resolveDeveloperHeadFromConfig } from "../../roles/load.ts";
import { currentWorkspace } from "../../board/workspace.ts";
import { HeadGraph } from "./graph.ts";
import { HeadAttachment, type HeadDagOptions } from "./runtime.ts";

/** Public validation happens before reservations, advice, or capability creation. */
export function validateAgentMode(params: { role: string; mode?: string; writes?: string[] }, cwd: string,
  asynchronous = true): Omit<HeadDagOptions, "executor"> | undefined {
  if (params.role === "developer_head") throw new Error("developer_head is internal; use developer with mode head");
  const mode = params.mode ?? "single";
  if (!["single", "head"].includes(mode)) throw new Error("invalid agent mode");
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
  return { writes: [...params.writes], config };
}

export function createHead(assignmentId: string, cwd: string, options: ReturnType<typeof validateAgentMode>,
  executor: HeadDagOptions["executor"]): HeadAttachment | undefined {
  return options ? new HeadAttachment(assignmentId, currentWorkspace(cwd), { ...options, executor }) : undefined;
}
