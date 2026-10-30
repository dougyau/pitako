import todo from "@juicesharp/rpiv-todo";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function todoExtension(pi: ExtensionAPI) {
  return todo({
    ...pi,
    registerTool(tool) {
      pi.registerTool(tool.name === "todo" ? { ...tool, exposure: "model-only" } : tool);
    },
  });
}
