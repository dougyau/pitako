import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import rpivTodo from "@juicesharp/rpiv-todo";
import { guardDefinition } from "./workflow-engine.ts";

export default function todoExtension(pi: ExtensionAPI) {
  return rpivTodo({
    ...pi,
    registerTool(tool) {
      // Nested calls omit the result snapshot needed by TODO replay and readers.
      pi.registerTool(tool.name === "todo"
        ? guardDefinition({ ...tool, exposure: "model-only" }, "read") : tool);
    },
  });
}
