// HOME, cwd and every session are private; external providers are controlled.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import pitako from "../../extensions/index.ts";
import fileSha256 from "../../extensions/file-sha256.ts";
import { readStack } from "../../extensions/stack.ts";
import { RUNTIME_AGENT_REGISTER_EVENT, type RuntimeAgentRegistrationRequest } from "../../node_modules/pi-subagents/src/agents/runtime-agent-events.js";

const root = path.resolve(import.meta.dir, "../.."), cwd = process.cwd();
const mode = process.argv[2]!;
const mutators = [
  "ast_rewrite",
  "file_sha256_save", "preview_export", "git_worktree_add", "git_worktree_remove", "git_worktree_prune", "git_commit",
  "ssh_exec", "ssh_pull", "ssh_push", "py_lint", "py_format", "py_typecheck", "py_test", "py_uv",
  "cargo_check", "cargo_clippy", "cargo_fmt", "cargo_test", "cargo_build", "cargo_run", "cargo_doc", "cargo_bench", "cargo_add",
];
const sha = createHash("sha256").update("child bytes\n").digest("hex");
writeFileSync(path.join(cwd, "source"), "child bytes\n");

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
let disposed = false;
let observerRegistered = false;
let removeRegistrationListener = () => {};
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
  const externalTools = new Set(readStack(root).required
    .filter(entry => entry.spec !== "pitako").flatMap(entry => entry.tools));
  const externalNames = plan.requiredChildTools.filter(name => externalTools.has(name));
  const controlledProviders = { name: "controlled-providers", factory(pi: sdk.ExtensionAPI) {
    for (const name of externalNames) pi.registerTool({
      name, label: name, description: "controlled external boundary", parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    });
  } };
  let extensionPaths = plan.extensionArgs.filter(entry =>
    entry === path.join(root, "extensions/file-sha256.ts") ||
    entry === path.join(root, "extensions/checkpoint-create.ts") ||
    entry === path.join(root, "extensions/dev-tools/index.ts"));
  if (mode === "foreground") {
    extensionPaths = [];
    runtime.requiredTools = undefined;
  }
  const foreground = { name: "foreground-policy", factory(pi: sdk.ExtensionAPI) {
    // Own the excluded provider's registration listener without loading its runtime.
    removeRegistrationListener = pi.events.on(RUNTIME_AGENT_REGISTER_EVENT, raw => {
      const request = raw as RuntimeAgentRegistrationRequest;
      assert.equal(request.version, 1);
      assert.equal(request.name, "pitako.checkout-observer");
      assert.equal(observerRegistered, false);
      observerRegistered = true;
      request.result = { ok: true, registration: { dispose() {
        assert.equal(observerRegistered, true);
        observerRegistered = false;
      } } };
    });
    pitako(pi);
    fileSha256(pi);
    pi.registerTool({
      name: "ast_search", label: "AST Search", description: "controlled search", exposure: "deferred",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    });
    // No real mutator executes: these owned counters reveal any boundary leak.
    for (const name of mutators.filter(name => name !== "file_sha256_save")) pi.registerTool({
      name, label: name, description: "controlled side effect", exposure: "deferred", parameters: Type.Object({}),
      execute: async () => { sideEffects++; return { content: [], details: {} }; },
    });
  } };
  const child = await factory.create({
    cwd, projectTrusted: true, storage: { kind: "memory" }, tools: mode === "foreground" ? undefined : plan.effectiveToolAllowlist,
    ambientExtensions: false, extensionPaths, hooks: [...captured.hooks, controlledProviders, ...(mode === "foreground" ? [foreground] : [])],
    noSkills: true, noContextFiles: true, runtime,
    onExtensionError(error) { errors.push(String(error.error)); },
  });
  try {
    if (process.send) {
      process.send({ ready: true });
      assert.equal(await Bun.stdin.text(), "run");
    }
    assert.equal(observerRegistered, mode === "foreground");
    await session.extensionRunner!.emit({ type: "agent_start" });
    assert.deepEqual(captured.toolDiagnostic()?.missing ?? [], []);
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
      assert.equal((await call("ast_search", {})).isError, false);
      assert.equal((await call("codemode", { code: "await tools.ast_search({});" })).isError, false);
      assert.equal(existsSync(path.join(cwd, "forbidden")), false);
      const read = await call("file_sha256", { items: [{ path: "source" }] });
      assert.equal(read.isError, false);
      assert.equal((read.result.structuredContent as { ok: boolean }).ok, true);
    } else {
      const hash = await call("file_sha256", { items: [{ path: "source", expected: sha }] });
      assert.equal(hash.isError, false);
      assert.deepEqual((hash.result.structuredContent as { ok: boolean; publication: string }).ok, true);
      assert.equal((hash.result.structuredContent as { publication: string }).publication, "not_requested");
      const queries = await call("codemode", { code: `
        const hashed = await tools.file_sha256({items:[{path:"source",expected:"${sha}"}]});
        if (!hashed.ok || hashed.publication !== "not_requested") throw new Error("hash failed");
        const git = await tools.git_status({});
        if (git.error || !git.untracked.includes("source")) throw new Error("git query failed");
        return { ok: hashed.ok, publication: hashed.publication };
      ` });
      assert.equal(queries.isError, false, text(queries));
      assert.match(text(queries), /"ok":true/);
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
} finally {
  await factory.dispose();
  removeRegistrationListener();
  assert.equal(observerRegistered, false);
  disposed = true;
}
console.log(JSON.stringify({ mode, disposed, sideEffects, errors }));
