import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// T3 Code launches its Pi sessions in RPC mode with its own extension and sets this
// variable (t3code packages/provider-pi/src/server/mcpInjection.ts). Other RPC clients
// and the TUI keep Pi's terminal Markdown guidance.
export const T3_EXTENSION_ENV = "T3_PI_MCP_EXTENSION_PATH";

// T3 chat parses raw HTML in assistant messages and sanitizes it with the GitHub
// rehype-sanitize schema; fenced `mermaid` blocks render as diagrams.
export const T3_DISPLAY_NOTE = [
  "T3 display: assistant messages render raw HTML (sanitized, GitHub schema) and Mermaid.",
  "Write formatted output as HTML instead of Markdown: <h3>, <p>, <ul>/<ol>, <table>, <strong>/<em>, <code>, <a>, <img>, <details>/<summary>, <dl>, <kbd>, <sup>/<sub>, <blockquote>.",
  "style, class, title, script, svg and iframe are stripped; do not rely on them.",
  "Keep code and command output in fenced code blocks outside HTML elements.",
  "Draw every diagram as a fenced ```mermaid block, never as ASCII art.",
].join(" ");

export function hostDisplayNote(mode: ExtensionContext["mode"] | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (mode !== "rpc" || env.PI_SUBAGENT_CHILD === "1" || !env[T3_EXTENSION_ENV]) return undefined;
  return T3_DISPLAY_NOTE;
}
