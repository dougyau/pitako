import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findWorkspaceRoot, withLspClient } from "pi-lsp-client/src/lsp/client-wrapper.ts";
import { LspManager } from "pi-lsp-client/src/lsp/manager.ts";
import { findServerForExtension } from "pi-lsp-client/src/lsp/server-resolution.ts";
import { bindLspApi } from "./lsp.ts";
import { CODE_INTELLIGENCE_TOOLS } from "./tools.ts";

export function bindCodeIntelligenceApi(): void {
  bindLspApi({ findWorkspaceRoot, withLspClient, createManager: () => new LspManager(), findServerForExtension });
}

export default function codeIntelligence(pi: ExtensionAPI): void {
  bindCodeIntelligenceApi();
  for (const tool of CODE_INTELLIGENCE_TOOLS) pi.registerTool(tool);
}
