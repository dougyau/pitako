import { createRequire } from "node:module";

let tools: Promise<typeof import("pi-codex-tools")> | undefined;

/** The published API is TS with .js imports: Bun loads it natively, Node uses Pi's declared loader. */
export function loadCodexTools(): Promise<typeof import("pi-codex-tools")> {
  return tools ??= process.versions.bun ? import("pi-codex-tools") : (async () => {
    const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { createJiti } = require("jiti") as typeof import("jiti");
    return createJiti(import.meta.url).import<typeof import("pi-codex-tools")>("pi-codex-tools");
  })();
}
