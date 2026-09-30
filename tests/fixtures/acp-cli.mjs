import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const home = mkdtempSync(path.join(tmpdir(), "pitako-acp-cli-"));
const cwd = path.join(home, "workspace");
const agentDir = path.join(home, ".pi/agent");
mkdirSync(cwd);
mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
const probe = path.join(agentDir, "extensions/probe.ts");
writeFileSync(probe, `
import assert from "node:assert/strict";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { createPiExecutor } from ${JSON.stringify(path.join(root, "extensions/agent/pi.ts"))};
import { executionForSession } from ${JSON.stringify(path.join(root, "extensions/execution-identity.ts"))};
const key = Symbol.for("pitako.cliAcpProbe");
const state = globalThis[key] ??= { starts: new Map(), shutdowns: new Map(), childCalls: 0 };
export default function(pi) {
  pi.registerProvider("acp-cli", {
    api: "openai-responses", baseUrl: "http://127.0.0.1", apiKey: "fixture",
    models: [{ id: "supported", name: "Fixture", compat: { supportsOpenAIGrammarTools: true }, reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      assert.ok(executionForSession(options.sessionId), "only production child is prompted");
      const tools = getCurrentTools(context.messages).map(tool => tool.name);
      for (const name of ["compress", "search_context", "decompress", "acp_status", "acp_cache", "apply_patch"]) assert.equal(tools.filter(tool => tool === name).length, 1);
      assert.ok(!tools.some(name => /^(agent_|team_|acp_delegate)/.test(name)));
      state.childCalls++;
      const message = { role: "assistant", content: [{ type: "text", text: "child ready" }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { result: async () => message, async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; } };
    },
  });
  pi.on("session_start", (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    state.starts.set(sid, (state.starts.get(sid) ?? 0) + 1);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    if (executionForSession(sid)) state.shutdowns.set(sid, (state.shutdowns.get(sid) ?? 0) + 1);
  });
  pi.registerCommand("fixture-child", { description: "Package loading probe", handler: async (_args, ctx) => {
    const parentModel = ctx.model;
    const tools = pi.getAllTools().map(tool => tool.name);
    for (const name of ["compress", "search_context", "decompress", "acp_status", "acp_cache", "apply_patch"]) assert.equal(tools.filter(tool => tool === name).length, 1);
    const result = await createPiExecutor().start({ instanceId: "cli-child", role: { id: "reviewer", name: "Reviewer", description: "fixture", instructionsPath: "roles/reviewer.md", instructions: "fixture", skills: [], principles: [], modelPolicyId: "reviewer", modelPolicy: { id: "reviewer", fallbacks: [] } }, target: { model: "acp-cli/supported" }, task: "child fixture", cwd: ctx.cwd, signal: new AbortController().signal });
    assert.equal(result.status, "completed", result.error);
    await result.session.dispose();
    assert.equal(ctx.model, parentModel);
    assert.equal(state.starts.size, 2);
    assert.deepEqual([...state.starts.values()], [1, 1]);
    assert.deepEqual([...state.shutdowns.values()], [1]);
    assert.equal(state.childCalls, 1);
    console.log("ACP_CLI_OK: actual pi -e package; main/production child each starts once; upstream tools once; child shutdown once; parent model unchanged");
  } });
}
`);
try {
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PITAKO_PROFILE: "coding" };
  for (const name of ["BILLION_CONTEXT_PROXY", "BILLION_CONTEXT_NATIVE", "PITAKO_INSTANCE_ID", "PITAKO_ROLE_ID"]) delete env[name];
  const result = spawnSync("node", [path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--no-extensions", "--approve", "-e", root, "-e", probe, "--no-session", "--mode", "json", "--provider", "acp-cli", "--model", "supported", "/fixture-child"], { cwd, encoding: "utf8", timeout: 60_000, env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /ACP_CLI_OK/);
  console.log(output.split("\n").find((line) => line.startsWith("ACP_CLI_OK")));
} finally { rmSync(home, { recursive: true, force: true }); }
