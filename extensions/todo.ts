import { registerExecuteTodoProjection } from "./execute-todo-projection.ts";
import todo, { type TodoCommit } from "../vendor/rpiv-todo/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type TodoProjectionRegistration = (pi: ExtensionAPI, commit: TodoCommit) => void;

// Register projections here, in the tool's module graph, rather than in another Pi entry.
export default function todoExtension(pi: ExtensionAPI, registerProjection: TodoProjectionRegistration = registerExecuteTodoProjection): TodoCommit {
  const commit = todo(pi);
  registerProjection(pi, commit);
  return commit;
}
