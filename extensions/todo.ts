import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import rpivTodo from "@juicesharp/rpiv-todo";

export default function todoExtension(pi: ExtensionAPI) {
  return rpivTodo({
    ...pi,
    registerTool(tool) {
      // Nested calls omit the result snapshot needed by TODO replay and readers.
      pi.registerTool(tool.name === "todo"
        ? { ...tool, exposure: "model-only" } : tool);
    },
  });
}
