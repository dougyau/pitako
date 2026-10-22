import { createAcpExtension } from "billion-context-pi";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardDefinition } from "./workflow-engine.ts";

// Defaults only: explicit upstream acp.json settings retain precedence.
const acp = createAcpExtension({ delegate: false, autoUpdate: false, toolBashDefaultTimeout: 0 });
const contextTools = new Set(["compress", "decompress", "search_context", "acp_status", "acp_cache"]);

export default function acpExtension(pi: ExtensionAPI) {
  return acp({ ...pi, registerTool(tool) {
    pi.registerTool(contextTools.has(tool.name) ? guardDefinition(tool, "read") : tool);
  } });
}
