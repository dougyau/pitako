import { createAcpExtension } from "billion-context-pi";

// Defaults only: explicit upstream acp.json settings retain precedence.
export default createAcpExtension({ delegate: false, autoUpdate: false });
