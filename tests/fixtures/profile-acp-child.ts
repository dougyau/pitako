// Child-process fixture: HOME, cwd, ACP configuration and every session are private.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { runToolCall } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { parseFrontmatter, parseFrontmatterList } from "../../node_modules/pi-subagents/src/agents/frontmatter.js";
import { resolvePiLaunchToolPlan } from "../../node_modules/pi-subagents/src/runs/shared/child-tool-plan.js";
import { createDefaultChildSessionFactory } from "../../node_modules/pi-subagents/src/runs/shared/child-session.js";
import { createCapturedChildHooks } from "../../node_modules/pi-subagents/src/runs/shared/child-hooks.js";
import type { ChildRuntimeConfig } from "../../node_modules/pi-subagents/src/runs/shared/child-runtime-config.js";
import { runSync } from "../../node_modules/pi-subagents/src/runs/foreground/execution.js";
import type { AgentConfig } from "../../node_modules/pi-subagents/src/agents/agents.js";
import pitako from "../../extensions/index.ts";
import fileSha256 from "../../extensions/file-sha256.ts";

const root = path.resolve(import.meta.dir, "../.."), cwd = process.cwd();
const mode = process.argv[2]!;
const acpTools = ["compress", "decompress", "search_context", "acp_status", "acp_cache"];
const mutators = [
  "file_sha256_save", "preview_export", "git_worktree_add", "git_worktree_remove", "git_worktree_prune", "git_commit",
  "ssh_exec", "ssh_pull", "ssh_push", "py_lint", "py_format", "py_typecheck", "py_test", "py_uv",
  "cargo_check", "cargo_clippy", "cargo_fmt", "cargo_test", "cargo_build", "cargo_run", "cargo_doc", "cargo_bench", "cargo_add",
];
const sha = createHash("sha256").update("child bytes\n").digest("hex");
writeFileSync(path.join(cwd, "source"), "child bytes\n");
// Project takes precedence over an explicitly disabled global config, and vice versa.
for (const base of [process.env.HOME!, cwd]) mkdirSync(path.join(base, ".pi"), { recursive: true });
writeFileSync(path.join(process.env.HOME!, ".pi/acp.json"), JSON.stringify({ enabled: mode === "disabled", autoUpdate: false }));
writeFileSync(path.join(cwd, ".pi/acp.json"), JSON.stringify({ enabled: mode !== "disabled", autoUpdate: false }));

let session!: sdk.AgentSession;
let sideEffects = 0;
const errors: string[] = [];
const factory = createDefaultChildSessionFactory({
  loadPiCodingAgent: async () => ({
    ...sdk,
    async createAgentSession(options: Parameters<typeof sdk.createAgentSession>[0]) {
      const result = await sdk.createAgentSession(options);
      session = result.session;
      return result;
    },
  }),
});
const assistant: AssistantMessage = {
  role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "fixture",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse", timestamp: Date.now(),
};
const call = async (name: string, args: JsonObject) => {
  session.agent.state.messages = [assistant];
  return runToolCall({ type: "toolCall", id: `fixture-${name}`, name, arguments: args }, {
    tools: session.agent.state.tools, assistantMessage: assistant,
    context: { messages: session.agent.state.messages, tools: session.agent.state.tools },
    beforeToolCall: session.agent.beforeToolCall, afterToolCall: session.agent.afterToolCall,
  });
};
const text = (outcome: Awaited<ReturnType<typeof call>>) =>
  outcome.result.content.map(part => part.type === "text" ? part.text : "").join("\n");
let disposed = false, state = "completed", missing: string[] = [], nativeExitCode: number | undefined;
try {
  const role = mode === "worker" ? "worker" : "researcher";
  const profile = parseFrontmatter(readFileSync(path.join(root, "agents", `${role}.md`), "utf8")).frontmatter;
  const resolve = (raw?: string) => parseFrontmatterList(raw)?.map(entry => path.resolve(root, "agents", entry));
  const plan = resolvePiLaunchToolPlan({
    cwd, agentName: `pitako.${role}`, tools: parseFrontmatterList(profile.tools), fast: false,
    extensions: resolve(profile.extensions), subagentOnlyExtensions: resolve(profile.subagentOnlyExtensions),
  });
  const runtime: ChildRuntimeConfig = {
    agent: `pitako.${role}`, fanoutChild: false, depth: 1, fast: false, waitTool: { enabled: false },
    requiredTools: plan.requiredChildTools, inheritSkills: false,
  };
  const captured = createCapturedChildHooks(runtime);
  const externalNames = plan.requiredChildTools.filter(name =>
    /^(codegraph_|lsp_|web_|fetch_|source_|get_search_|apply_patch)/.test(name));
  const controlledNavigation = { name: "controlled-navigation", factory(pi: sdk.ExtensionAPI) {
    for (const name of externalNames) pi.registerTool({
      name, label: name, description: "controlled external boundary", parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    });
    pi.registerProvider("pitako-fixture", {
      baseUrl: "https://example.invalid", api: "anthropic-messages", apiKey: "fixture",
      streamSimple() { throw new Error("No model request expected for missing ACP"); },
      models: [{ id: "model", name: "Owned fixture", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 }],
    });
  } };
  let extensionPaths = plan.extensionArgs.filter(entry =>
    entry === path.join(root, "extensions/acp.ts") ||
    entry === path.join(root, "extensions/file-sha256.ts") ||
    entry === path.join(root, "extensions/dev-tools/index.ts"));
  // A missing explicit adapter must reach the native required-tool diagnostic.
  if (mode === "unloadable") extensionPaths = extensionPaths.map(entry => entry.endsWith("/extensions/acp.ts") ? path.join(cwd, "missing-acp.ts") : entry);
  if (mode === "foreground") {
    extensionPaths = [];
    runtime.requiredTools = undefined;
  }
  const foreground = { name: "foreground-policy", factory(pi: sdk.ExtensionAPI) {
    // No real mutator executes: these owned counters reveal any boundary leak.
    pitako(pi);
    fileSha256(pi);
    for (const name of mutators.filter(name => name !== "file_sha256_save")) pi.registerTool({
      name, label: name, description: "controlled side effect", exposure: "deferred", parameters: Type.Object({}),
      execute: async () => { sideEffects++; return { content: [], details: {} }; },
    });
  } };
  if (mode === "disabled" || mode === "unloadable") {
    const agent: AgentConfig = {
      name: `pitako.${role}`, description: profile.description!, tools: plan.effectiveToolAllowlist,
      extensions: resolve(profile.extensions), subagentOnlyExtensions: resolve(profile.subagentOnlyExtensions),
      systemPrompt: "Controlled prerequisite probe.", systemPromptMode: "replace", source: "package",
      filePath: path.join(root, "agents", `${role}.md`),
      inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
    };
    let childDisposed = false;
    const result = await runSync(cwd, [agent], agent.name, "Check the required ACP prerequisite.", {
      runId: `owned-acp-${mode}`, cwd, projectTrusted: true, context: "fresh",
      modelOverride: "pitako-fixture/model",
      artifactsDir: path.join(cwd, "artifacts"), sessionDir: path.join(cwd, "sessions"),
      childSessionFactory: {
        async create(launch) {
          const child = await factory.create({
            ...launch, extensionPaths, noSkills: true, noContextFiles: true,
            hooks: [...launch.hooks, controlledNavigation],
          });
          const dispose = child.dispose.bind(child);
          child.dispose = async () => { await dispose(); childDisposed = true; };
          return child;
        },
        dispose: () => factory.dispose(),
      },
    });
    nativeExitCode = result.exitCode;
    assert.equal(result.exitCode, 1);
    assert.match(result.error!, /compress/);
    assert.match(result.error!, /acp_cache/);
    assert.equal(childDisposed, true);
    state = "prerequisite-failed";
    missing = acpTools;
    errors.push(result.error!);
  } else {
    const child = await factory.create({
      cwd, projectTrusted: true, storage: { kind: "memory" }, tools: mode === "foreground" ? undefined : plan.effectiveToolAllowlist,
      ambientExtensions: false, extensionPaths, hooks: [...captured.hooks, controlledNavigation, ...(mode === "foreground" ? [foreground] : [])],
      noSkills: true, noContextFiles: true, runtime,
      onExtensionError(error) { errors.push(String(error.error)); },
    });
    try {
      await session.extensionRunner!.emit({ type: "agent_start" });
      missing = captured.toolDiagnostic()?.missing ?? [];
      assert.deepEqual(missing, []);
      if (mode === "foreground") {
        // Pitako's actual hook must block even stale/re-enabled declarations and deferred calls.
        // Preserve codemode so the script reaches the ordinary native nested-call pipeline.
        const registered = session.getAllTools().map(tool => tool.name);
        session.setActiveToolsByName(registered);
        for (const name of mutators) {
          const args: JsonObject = name === "file_sha256_save" ? { items: [{ path: "source" }], outputFile: "forbidden" } : {};
          const direct = await call(name, args);
          assert.equal(direct.isError, true);
          assert.match(text(direct), new RegExp(`Pitako analysis forbids ${name}`));
          const nested = await call("codemode", { code: `await tools.${name}(${JSON.stringify(args)});` });
          assert.equal(nested.isError, true);
          assert.match(text(nested), new RegExp(`Pitako analysis forbids ${name}`));
        }
        assert.equal(sideEffects, 0);
        assert.equal(existsSync(path.join(cwd, "forbidden")), false);
        const read = await call("file_sha256", { items: [{ path: "source" }] });
        assert.equal(read.isError, false);
        assert.equal((read.result.structuredContent as { ok: boolean }).ok, true);
      } else {
        for (const tool of acpTools) assert(session.getActiveToolNames().includes(tool), tool);
        const original = "Owned ACP integration content. ".repeat(600);
        session.sessionManager.appendMessage({
          ...assistant, content: [{ type: "text", text: original }], stopReason: "stop",
        });
        // Age the entry beyond ACP's default recent-message and recent-token protection.
        for (let i = 0; i < 6; i++) {
          session.sessionManager.appendMessage({ role: "user", content: `Later owned turn ${i}`, timestamp: Date.now() });
          session.sessionManager.appendMessage({
            ...assistant, content: [{ type: "text", text: `Later owned reply ${i}. `.repeat(400) }], stopReason: "stop",
          });
        }
        const status = await call("acp_status", {});
        assert.equal(status.isError, false);
        assert.match(text(status), /host=billion-context-pi/);
        const cache = await call("acp_cache", {});
        assert.equal(cache.isError, false);
        const messages = await call("acp_status", { scope: "uncompressed", view: "messages", sort: "size", limit: 1 });
        assert.equal(messages.isError, false, text(messages));
        const entry = text(messages).match(/m\d+/)?.[0];
        assert(entry, text(messages));
        const compressed = await call("compress", {
          content: [{ startId: entry, endId: entry,
            summary: "Owned ACP integration content. Historical assistant entry repeated this literal marker; no user objectives or decisions were present.",
            topic: "Owned probe" }],
        });
        assert.equal(compressed.isError, false, text(compressed));
        const block = text(compressed).match(/blocks: (b\d+)=/)?.[1];
        assert(block, text(compressed)); // Refusal or zero blocks is not operational ACP.
        const context = await call("codemode", { code: `
          const found = await tools.search_context({query:"Owned ACP integration content"});
          const restored = await tools.decompress({blockId:"${block}",inline:true});
          return { found:found.includes("${block}"), restored:restored.includes("Owned ACP integration content.") };
        ` });
        assert.equal(context.isError, false, text(context));
        assert.match(text(context), /"found":true/);
        assert.match(text(context), /"restored":true/);
        const hash = await call("file_sha256", { items: [{ path: "source", expected: sha }] });
        assert.equal(hash.isError, false);
        assert.deepEqual((hash.result.structuredContent as { ok: boolean; publication: string }).ok, true);
        assert.equal((hash.result.structuredContent as { publication: string }).publication, "not_requested");
        const queries = await call("codemode", { code: `
          const hashed = await tools.file_sha256({items:[{path:"source",expected:"${sha}"}]});
          if (!hashed.ok || hashed.publication !== "not_requested") throw new Error("hash failed");
          const git = await tools.git_status({});
          if (git.error || !git.untracked.includes("source")) throw new Error("git query failed");
          const status = await tools.acp_status({});
          return { ok: hashed.ok, publication: hashed.publication, acp: status.includes("host=billion-context-pi") };
        ` });
        assert.equal(queries.isError, false, text(queries));
        assert.match(text(queries), /"acp":true/);
        if (mode === "worker") {
          const saved = await call("codemode", { code: `
            const result = await tools.file_sha256_save({items:[{path:"source"}],outputFile:"hashes.json"});
            if (!result.ok || result.publication !== "published") throw new Error("save failed");
            return { ok:result.ok, publication:result.publication };
          ` });
          assert.equal(saved.isError, false, text(saved));
          assert.match(text(saved), /"publication":"published"/);
          assert.deepEqual(JSON.parse(readFileSync(path.join(cwd, "hashes.json"), "utf8")), { items: [{ path: "source", expected: sha }] });
        } else {
          for (const name of mutators) {
            assert(!session.getAllTools().some(tool => tool.name === name), name);
            const denied = await call(name, name === "file_sha256_save"
              ? { items: [{ path: "source" }], outputFile: "forbidden" } : {});
            assert.equal(denied.isError, true, name);
            const nested = await call("codemode", {
              code: `await tools.${name}(${name === "file_sha256_save"
                ? '{items:[{path:"source"}],outputFile:"forbidden"}' : "{}"});`,
            });
            assert.equal(nested.isError, true, `${name}: ${text(nested)}`);
          }
          assert.equal(existsSync(path.join(cwd, "forbidden")), false);
        }
      }
    } finally { await child.dispose(); }
  }
} finally {
  await factory.dispose();
  disposed = true;
}
console.log(JSON.stringify({ mode, state, missing, nativeExitCode, disposed, sideEffects, errors }));
