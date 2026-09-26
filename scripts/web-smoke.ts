import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { WEB_TOOLS } from "../extensions/profile.ts";
import { packageRoot } from "../extensions/stack.ts";
import { loadPitako } from "./load-pitako.ts";

const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-web-"));
const previous = process.env.PI_CODING_AGENT_DIR;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(`<html><head><title>Pitako test</title></head><body><article><h1>Pitako web fetch smoke</h1>${"<p>External evidence can be fetched without a search key. This page checks the real fetch and extraction path in an isolated local server.</p>".repeat(10)}</article></body></html>`, {
    headers: { "content-type": "text/html" },
  }),
});
try {
  // Loopback is allowed only in this isolated test config; production SSRF defaults remain unchanged.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(path.join(agentDir, "web-search.json"), JSON.stringify({ ssrf: { allowRanges: ["127.0.0.1/32"] } }));
  const loaded = await loadPitako(packageRoot());
  if (loaded.extensions.errors.length) throw new Error(JSON.stringify(loaded.extensions.errors));
  const web = loaded.extensions.extensions.find((extension) => extension.resolvedPath.endsWith("pi-web-access/dist/index.js"));
  const fetchContent = web?.tools.get("fetch_content")?.definition;
  if (!fetchContent) throw new Error("pi-web-access did not register fetch_content");
  const { session } = await createAgentSession({
    cwd: loaded.cwd,
    agentDir: loaded.agentDir,
    resourceLoader: loaded.loader,
    settingsManager: SettingsManager.create(loaded.cwd, loaded.agentDir, { projectTrusted: true }),
    sessionManager: SessionManager.inMemory(loaded.cwd),
  });
  try {
    const result = await fetchContent.execute("web-smoke", { url: `http://127.0.0.1:${server.port}/page` }, new AbortController().signal, undefined, undefined!);
    const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!text.includes("Pitako web fetch smoke")) throw new Error(`fetch_content failed: ${text}`);
    const { session: scout } = await createAgentSession({
      cwd: loaded.cwd,
      agentDir: loaded.agentDir,
      resourceLoader: loaded.loader,
      settingsManager: SettingsManager.create(loaded.cwd, loaded.agentDir, { projectTrusted: true }),
      sessionManager: SessionManager.inMemory(loaded.cwd),
      excludeTools: [...WEB_TOOLS],
    });
    try {
      scout.setActiveToolsByName([...scout.getActiveToolNames(), ...WEB_TOOLS]);
      if (scout.getAllTools().some((tool) => WEB_TOOLS.some((name) => name === tool.name)) ||
        scout.getActiveToolNames().some((name) => WEB_TOOLS.some((web) => web === name))) {
        throw new Error("Excluded web tools became available to Scout");
      }
    } finally {
      scout.dispose();
    }
    console.log("Pitako web fetch smoke passed");
  } finally {
    session.dispose();
  }
} finally {
  server.stop();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
}
