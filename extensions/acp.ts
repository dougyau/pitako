import { createAcpExtension } from "billion-context-pi";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Defaults only: explicit upstream acp.json settings retain precedence.
const acp = createAcpExtension({ delegate: false, autoUpdate: false, toolBashDefaultTimeout: 0 });

export default function acpExtension(pi: ExtensionAPI) {
  return acp(pi);
}
