import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import codegraph from "@colbymchenry/codegraph";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CODE_INTELLIGENCE_TOOLS } from "../extensions/code-intelligence/tools.ts";
import { withCodeGraph } from "../extensions/code-intelligence/graph.ts";

const roots = [];
const CodeGraph = codegraph.CodeGraph;
const registryKey = Symbol.for("pitako.code-intelligence.graph-registry");
const lspRegistryKey = Symbol.for("pitako.code-intelligence.lsp-registry");

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pitako-codegraph-node-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "sample.ts"), "export function answer() { return 42; }\n");
  writeFileSync(path.join(root, ".gitignore"), ".codegraph/\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

async function invokeRaw(name, cwd, params = {}, signal = new AbortController().signal) {
  const tool = CODE_INTELLIGENCE_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute("node-integration", params, signal, () => {}, { cwd });
}

async function invoke(name, cwd, params = {}, signal) {
  const result = await invokeRaw(name, cwd, params, signal);
  if (result.isError) throw new Error(result.content[0]?.text);
  return JSON.parse(result.content[0].text);
}

function setMetadata(root, key, value) {
  const db = new DatabaseSync(codegraph.getDatabasePath(root));
  try {
    const result = db.prepare("UPDATE project_metadata SET value = ? WHERE key = ?").run(String(value), key);
    assert.equal(result.changes, 1, `metadata key ${key} exists`);
  } finally {
    db.close();
  }
}

async function waitForJoinedWaiters(count) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entries = globalThis[registryKey];
    if (entries instanceof Map && [...entries.values()].some((entry) => entry.waiters >= count)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`graph registry did not reach ${count} waiters`);
}

async function waitFor(predicate, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function createPiSession(cwd) {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), "pitako-agent-session-"));
  roots.push(agentDir);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [path.resolve("extensions/code-intelligence/index.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  return session;
}

function sessionTool(session, cwd, name) {
  assert.ok(session.getActiveToolNames().includes(name), `${name} is active in the Pi AgentSession`);
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `${name} is registered in the Pi AgentSession`);
  return (params, signal = new AbortController().signal) => tool.execute("session-integration", params, signal, () => {}, { cwd });
}

test.after(async () => {
  const sharedLsp = globalThis[lspRegistryKey];
  if (sharedLsp) await (await sharedLsp).manager.stopAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("builds a missing graph on first graph query and reuses its current index", async () => {
  const root = fixture();
  const originalIndexAll = CodeGraph.prototype.indexAll;
  let indexAllCalls = 0;
  CodeGraph.prototype.indexAll = function (options) {
    indexAllCalls += 1;
    return originalIndexAll.call(this, options);
  };
  try {
    const firstRaw = await invokeRaw("inspect_symbol", root, { symbol: "answer", file: "src/sample.ts" });
    const first = JSON.parse(firstRaw.content[0].text);

    assert.equal(firstRaw.details.codeIntelligence.tool, "inspect_symbol");
    assert.equal(firstRaw.details.codeIntelligence.outcome, "partial");
    assert.ok(firstRaw.details.codeIntelligence.outputBytes > 0);
    assert.equal(firstRaw.details.codeIntelligence.graph.failures, 0);
    assert.ok(Object.keys(firstRaw.details.codeIntelligence.graph.buildDurations).length > 0);
    assert.equal(first.status, "partial");
    assert.equal(first.graph.status, "ok");
    assert.equal(first.graph.freshness.indexState, "complete");
    assert.equal(first.graph.freshness.engineStale, false);
    assert.equal(first.graph.freshness.lifecycle.action, "built");
    assert.ok(first.graph.freshness.lifecycle.durationMs >= 0);
    assert.equal(first.references.status, "unavailable");
    assert.match(first.references.reason, /Pi extension loader binding/);

    const second = await invoke("inspect_symbol", root, { symbol: "answer", file: "src/sample.ts" });
    assert.equal(second.graph.freshness.lifecycle.action, "reused");
    assert.equal(second.graph.freshness.indexState, "complete");
    assert.equal(indexAllCalls, 1);
  } finally {
    CodeGraph.prototype.indexAll = originalIndexAll;
  }
});

test("does not choose an arbitrary same-file CodeGraph name collision", async () => {
  const root = fixture();
  const file = path.join(root, "src", "sample.ts");
  writeFileSync(file, "export const collision = 1;\nexport function collision() { return 2; }\n");
  await invoke("module_report", root, { file: "src/sample.ts" });

  const graph = await CodeGraph.open(root, { sync: false });
  const matches = graph.getNodesByName("collision").filter((node) => node.filePath === "src/sample.ts");
  graph.close();
  assert.equal(matches.length, 2);
  assert.equal((await invoke("read_symbol", root, { symbol: "collision", file: "src/sample.ts" })).status, "ambiguous");
  assert.equal((await invoke("inspect_symbol", root, { symbol: "collision", file: "src/sample.ts" })).status, "ambiguous");
});

test("Node reports destructured bindings and export aliases", async () => {
  const root = fixture();
  const file = path.join(root, "src", "bindings.ts");
  writeFileSync(file, [
    "const { short, sourceKey: localAlias } = source;",
    "const [first,,second] = values;",
    "export const { direct, sourceKey: directAlias } = source;",
    "export { localAlias };",
  ].join("\n") + "\n");

  const module = await invoke("module_report", root, { file: "src/bindings.ts" });
  assert.deepEqual(module.declarations.map(({ name, exported }) => [name, exported]), [
    ["short", false], ["localAlias", true], ["first", false], ["second", false], ["direct", true], ["directAlias", true],
  ]);
  for (const symbol of ["short", "localAlias", "first", "second", "direct", "directAlias"]) {
    assert.equal((await invoke("read_symbol", root, { symbol, file: "src/bindings.ts" })).status, "ok", symbol);
  }
  for (const symbol of ["sourceKey", "source", "values"]) {
    assert.equal((await invoke("read_symbol", root, { symbol, file: "src/bindings.ts" })).status, "not_found", symbol);
  }
});

test("project_report observes graph availability without initializing an index", async () => {
  const root = fixture();
  await invoke("project_report", root);
  assert.equal(CodeGraph.isInitialized(root), false);
});

test("reindexes an engine-stale complete index and verifies lock contention", async () => {
  const root = fixture();
  await invoke("module_report", root, { file: "src/sample.ts" });
  const graph = await CodeGraph.open(root, { sync: false });
  const oldExtractionVersion = graph.getIndexBuildInfo().extractionVersion - 1;
  graph.close();
  setMetadata(root, "indexed_with_extraction_version", oldExtractionVersion);

  const lock = new codegraph.FileLock(path.join(codegraph.getCodeGraphDir(root), "codegraph.lock"));
  lock.acquire();
  try {
    const blockedRaw = await invokeRaw("module_report", root, { file: "src/sample.ts" });
    const blocked = JSON.parse(blockedRaw.content[0].text);
    assert.equal(blocked.status, "partial");
    assert.match(blocked.graph.reason, /indexAll contention/);
    assert.equal(blockedRaw.details.codeIntelligence.graph.failures, 1);
    assert.equal(Object.keys(blockedRaw.details.codeIntelligence.graph.buildDurations).length, 1);
  } finally {
    lock.release();
  }

  const refreshed = await invoke("module_report", root, { file: "src/sample.ts" });
  assert.equal(refreshed.graph.freshness.lifecycle.action, "reindexed");
  assert.equal(refreshed.graph.freshness.indexState, "complete");
  assert.equal(refreshed.graph.freshness.engineStale, false);
  assert.equal(refreshed.graph.freshness.changedFiles.added.length + refreshed.graph.freshness.changedFiles.modified.length + refreshed.graph.freshness.changedFiles.removed.length, 0);
});

test("reports distinct CodeGraph file consumers instead of file-node edge counts", async () => {
  const root = fixture();
  writeFileSync(path.join(root, "src", "importer.ts"), 'import { answer } from "./sample";\nimport { answer as other } from "./sample";\nexport const result = answer() + other();\n');
  writeFileSync(path.join(root, "src", "other.ts"), 'import { answer } from "./sample";\nexport const result = answer();\n');
  execFileSync("git", ["add", "src/importer.ts", "src/other.ts"], { cwd: root });

  const first = await invoke("module_report", root, { file: "src/sample.ts" });
  assert.deepEqual(first.graph.consumers.map((consumer) => consumer.file).sort(), ["src/importer.ts", "src/other.ts"]);
  assert.equal(first.graph.total, 2);
  assert.equal(new Set(first.graph.consumers.map((consumer) => consumer.file)).size, 2);

  writeFileSync(path.join(root, "src", "sample.ts"), "export function answer() { return 43; }\n");
  const surface = await invoke("review_surface", root);
  const target = surface.files.find((file) => file.file === "src/sample.ts");
  assert.equal(surface.relatedGraphConsumers.status, "available", JSON.stringify(surface.relatedGraphConsumers));
  assert.equal(target.graphConsumers.status, "available");
  assert.equal(target.graphConsumers.total, 2);

  const moreConsumers = Array.from({ length: 8 }, (_, index) => `src/consumer-${index}.ts`);
  for (const file of moreConsumers) writeFileSync(path.join(root, file), 'import { answer } from "./sample";\nexport const result = answer();\n');
  execFileSync("git", ["add", ...moreConsumers], { cwd: root });
  const report = await invoke("module_report", root, { file: "src/sample.ts" });
  const consumers = report.graph.consumers.map((consumer) => consumer.file);
  assert.equal(report.graph.status, "partial");
  assert.equal(report.graph.total, 10);
  assert.equal(consumers.length, 8);
  assert.equal(new Set(consumers).size, 8);
  assert.equal(report.graph.truncated, true);
});

test("Node review_surface rejects Git ref-resolution warnings without leaking stderr", async () => {
  const root = fixture();
  const file = path.join(root, "src", "sample.ts");
  const seed = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const headBranch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
  const commitOnBranch = (branch, declaration) => {
    execFileSync("git", ["checkout", "-q", "-b", branch, seed], { cwd: root });
    writeFileSync(file, `export const ${declaration} = true;\n`);
    execFileSync("git", ["add", "src/sample.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", `${branch} target`], { cwd: root });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  };
  const branchTarget = commitOnBranch("topic", "branchRef");
  const tagTarget = commitOnBranch("tag-target", "tagRef");
  const remoteTarget = commitOnBranch("remote-target", "remoteRef");
  execFileSync("git", ["checkout", "-q", headBranch], { cwd: root });
  writeFileSync(file, "export const headRef = true;\n");
  execFileSync("git", ["add", "src/sample.ts"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "head target"], { cwd: root });
  execFileSync("git", ["update-ref", "refs/remotes/origin/topic", remoteTarget], { cwd: root });
  writeFileSync(file, "export const worktreeRef = true;\n");

  const treeOid = (ref) => execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`], { cwd: root, encoding: "utf8" }).trim();
  const baseDeclaration = async (base) => {
    const report = await invoke("review_surface", root, { base });
    assert.equal(report.comparison, `${base} (${treeOid(base)}) tree to current worktree`);
    return report.files.find((item) => item.file === "src/sample.ts")?.enclosures.find((item) => item.side === "base")?.name;
  };
  const assertAmbiguous = async (base) => {
    const warning = spawnSync("git", ["-c", "core.warnAmbiguousRefs=true", "rev-parse", "--verify", "--end-of-options", `${base}^{tree}`], { cwd: root, encoding: "utf8" });
    assert.equal(warning.status, 0);
    assert.notEqual(warning.stderr, "");
    const result = await invokeRaw("review_surface", root, { base });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unavailable:.*ref.*unambiguously/i);
    assert.doesNotMatch(result.content[0].text, /warning:|advertencia|branchRef|tagRef|remoteRef/i);
  };

  assert.equal(await baseDeclaration("HEAD"), "headRef");
  assert.equal(await baseDeclaration("topic"), "branchRef");
  assert.equal(await baseDeclaration("origin/topic"), "remoteRef");
  assert.equal(await baseDeclaration("refs/remotes/origin/topic"), "remoteRef");
  execFileSync("git", ["tag", "topic", tagTarget], { cwd: root });
  execFileSync("git", ["tag", "origin/topic", tagTarget], { cwd: root });
  await assertAmbiguous("origin/topic");
  await assertAmbiguous("topic");
  assert.equal(await baseDeclaration("refs/heads/topic"), "branchRef");
  assert.equal(await baseDeclaration("refs/tags/origin/topic"), "tagRef");

  execFileSync("git", ["tag", "-d", "origin/topic"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["branch", "origin/topic", branchTarget], { cwd: root });
  await assertAmbiguous("origin/topic");
  execFileSync("git", ["tag", "refs/heads/topic", tagTarget], { cwd: root });
  await assertAmbiguous("refs/heads/topic");
});

test("Node retains the untracked body with fresh graph evidence under the response cap", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pitako-review-node-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(path.join(root, ".gitignore"), ".codegraph/\n");
  const source = (file, offset) => Array.from({ length: 40 }, (_, line) => `export const tracked${file}_line${line} = ${line + offset};`).join("\n") + "\n";
  for (let file = 0; file < 16; file++) writeFileSync(path.join(root, `tracked-${file}.ts`), source(file, 0));
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  for (let file = 0; file < 16; file++) writeFileSync(path.join(root, `tracked-${file}.ts`), source(file, 1));
  const untrackedText = "export const fresh = 1;\n";
  writeFileSync(path.join(root, "fresh.ts"), untrackedText);

  const raw = await invokeRaw("review_surface", root);
  const text = raw.content[0].text;
  const report = JSON.parse(text);
  const fresh = report.files.find((file) => file.file === "fresh.ts");
  const gitTracked = execFileSync("git", ["diff", "--name-only", "--find-renames", "-z", "HEAD", "--"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const gitUntracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const independentOrder = [...gitTracked, ...gitUntracked];
  const shownTracked = report.files.filter((file) => file.change !== "untracked").map((file) => file.file);

  assert.ok(report.originalBytes > 12 * 1024);
  assert.ok(Buffer.byteLength(text) <= 12 * 1024);
  assert.deepEqual(fresh.content, { text: untrackedText, totalLines: 2, showingLines: 2, truncated: false });
  assert.equal(fresh.identityOnly, undefined);
  assert.equal(report.untrackedShowing, 1);
  assert.equal(report.untrackedIncluded, true);
  assert.equal(report.relatedGraphConsumers.status, "available", JSON.stringify(report.relatedGraphConsumers));
  assert.deepEqual(shownTracked, independentOrder.slice(0, shownTracked.length));
  assert.equal(report.truncatedFields["$.files"].replacedFile, independentOrder[shownTracked.length]);
  assert.equal(report.truncatedFields["$.files"].showingItems, report.files.length);
  assert.equal(report.truncatedFields["$.files"].totalItems, 17);
});

test("terminal review fallback keeps honest markers with long graph keys", async () => {
  const root = fixture();
  const names = [];
  const source = (name, value) => `export function ${name}() { return ${value}; }\n`;
  for (let index = 0; index < 31; index++) {
    const name = `tracked-${String(index).padStart(2, "0")}-${"x".repeat(220)}.ts`;
    names.push(name);
    writeFileSync(path.join(root, name), source(`tracked${index}`, 0));
  }
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "long-name fixture"], { cwd: root });
  for (let index = 0; index < names.length; index++) {
    writeFileSync(path.join(root, names[index]), source(`tracked${index}`, 1));
  }
  writeFileSync(path.join(root, "fresh.ts"), "export const fresh = 1;\n");

  const raw = await invokeRaw("review_surface", root);
  const text = raw.content[0].text;
  const report = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) <= 12 * 1024);
  assert.ok(report.originalBytes > 12 * 1024);
  assert.equal(raw.details.codeIntelligence.graph.state, "complete");
  assert.equal(report.status, "partial");
  assert.equal(report.truncated, true);
  assert.equal(report.untrackedTotal, 1);
  assert.equal(report.untrackedShowing, 0);
  assert.equal(report.untrackedIncluded, false);
  assert.deepEqual(report.files, []);
  assert.equal(report.evidence, undefined);
});

test("reindexes incomplete indexes and syncs changed files with post-sync verification", async () => {
  const root = fixture();
  await invoke("module_report", root, { file: "src/sample.ts" });
  setMetadata(root, "index_state", "partial");

  const repaired = await invoke("module_report", root, { file: "src/sample.ts" });
  assert.equal(repaired.graph.freshness.lifecycle.action, "reindexed");
  assert.equal(repaired.graph.freshness.indexState, "complete");

  writeFileSync(path.join(root, "src", "sample.ts"), "export function answer() { return 43; }\n");
  const lock = new codegraph.FileLock(path.join(codegraph.getCodeGraphDir(root), "codegraph.lock"));
  lock.acquire();
  try {
    const blocked = await invoke("module_report", root, { file: "src/sample.ts" });
    assert.equal(blocked.status, "partial");
    assert.match(blocked.graph.reason, /sync incomplete or lock contention/);
  } finally {
    lock.release();
  }

  const synced = await invoke("module_report", root, { file: "src/sample.ts" });
  assert.equal(synced.graph.freshness.lifecycle.action, "synced");
  assert.equal(synced.graph.freshness.lifecycle.sync.filesModified, 1);
  assert.equal(synced.graph.freshness.changedFiles.modified.length, 0);
});

test("project_report marks a graph observed during reindexing partial", async () => {
  const root = fixture();
  await invoke("module_report", root, { file: "src/sample.ts" });
  setMetadata(root, "index_state", "partial");
  const originalIndexAll = CodeGraph.prototype.indexAll;
  let enterIndexing;
  let releaseIndexing;
  const entered = new Promise((resolve) => { enterIndexing = resolve; });
  const gate = new Promise((resolve) => { releaseIndexing = resolve; });
  CodeGraph.prototype.indexAll = async function (options) {
    enterIndexing();
    await gate;
    return originalIndexAll.call(this, options);
  };
  const builder = withCodeGraph(root, new AbortController().signal, (graph) => ({ state: graph.getIndexState() }));
  try {
    await entered;
    const report = await invoke("project_report", root);
    assert.equal(report.sources.graph.status, "partial");
    assert.equal(report.sources.graph.freshness.indexState, "partial");
    assert.notEqual(report.sources.graph.status, "available");
  } finally {
    releaseIndexing();
    await builder;
    CodeGraph.prototype.indexAll = originalIndexAll;
  }
});

test("drains an aborted graph flight before reacquiring without a competing writer", async () => {
  const root = fixture();
  await invoke("module_report", root, { file: "src/sample.ts" });
  setMetadata(root, "index_state", "partial");
  const originalIndexAll = CodeGraph.prototype.indexAll;
  let indexAllCalls = 0;
  let activeIndexAll = 0;
  let maxActiveIndexAll = 0;
  let enterIndexing;
  let releaseIndexing;
  const entered = new Promise((resolve) => { enterIndexing = resolve; });
  const gate = new Promise((resolve) => { releaseIndexing = resolve; });
  CodeGraph.prototype.indexAll = async function (options) {
    indexAllCalls += 1;
    activeIndexAll += 1;
    maxActiveIndexAll = Math.max(maxActiveIndexAll, activeIndexAll);
    try {
      if (indexAllCalls === 1) {
        enterIndexing();
        await gate;
      }
      return await originalIndexAll.call(this, options);
    } finally {
      activeIndexAll -= 1;
    }
  };

  const firstController = new AbortController();
  const first = withCodeGraph(root, firstController.signal, (graph) => ({ state: graph.getIndexState() }));
  try {
    await entered;
    firstController.abort();
    await assert.rejects(first, /abort/i);
    const entries = globalThis[registryKey];
    const entry = [...entries.values()].find((candidate) => candidate.flight);
    assert.ok(entry?.flight?.controller.signal.aborted);

    const second = withCodeGraph(root, new AbortController().signal, (graph) => ({ state: graph.getIndexState() }));
    await waitFor(() => entry.waiters === 1, "new graph caller did not wait for the aborted flight to drain");
    assert.equal(entry.flight.waiters, 0);
    assert.equal(indexAllCalls, 1);
    assert.equal(activeIndexAll, 1);
    releaseIndexing();

    const result = await second;
    assert.equal(result.value.state, "complete");
    assert.equal(indexAllCalls, 2);
    assert.equal(maxActiveIndexAll, 1);
  } finally {
    releaseIndexing();
    CodeGraph.prototype.indexAll = originalIndexAll;
  }
});

test("fresh Pi loader finds line-only declarations and labels a nested LSP root", async () => {
  const root = fixture();
  const file = path.join(root, "pkg", "src", "nested.ts");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(path.join(root, "pkg", "package.json"), '{"name":"nested-lsp-root"}\n');
  writeFileSync(file, "export function nestedAnswer() { return 42; }\n");
  const session = await createPiSession(root);
  try {
    const enclosed = await sessionTool(session, root, "read_enclosing")({ file: "pkg/src/nested.ts", line: 1 });
    const enclosedReport = JSON.parse(enclosed.content[0].text);
    assert.equal(enclosedReport.status, "ok", enclosed.content[0].text);
    assert.match(enclosedReport.body.text, /nestedAnswer/);

    const inspected = await sessionTool(session, root, "inspect_symbol")({ symbol: "nestedAnswer", file: "pkg/src/nested.ts" });
    const report = JSON.parse(inspected.content[0].text);
    assert.equal(report.lspWorkspaceRoot, path.join(root, "pkg"));
    assert.notEqual(report.lspWorkspaceRoot, root);
  } finally {
    await session.dispose();
    const shared = globalThis[lspRegistryKey];
    if (shared) await (await shared).manager.stopAll();
    delete globalThis[lspRegistryKey];
  }
});

test("fresh Pi loader reports only call edges as inspect_symbol callers and callees", async () => {
  const root = fixture();
  writeFileSync(path.join(root, "src", "sample.ts"), [
    "export function answer() { return 42; }",
    "export function caller() { return answer(); }",
    "export function unused() {}",
    "",
  ].join("\n"));
  const session = await createPiSession(root);
  try {
    const result = await sessionTool(session, root, "inspect_symbol")({ symbol: "answer", file: "src/sample.ts" });
    const report = JSON.parse(result.content[0].text);
    assert.equal(report.graph.status, "ok", result.content[0].text);
    assert.deepEqual(report.graph.callers.map((edge) => edge.kind), ["calls"]);
    assert.equal(report.graph.totals.callers, 1);
    assert.deepEqual(report.graph.callees, []);
    assert.equal(report.graph.totals.callees, 0);
  } finally {
    await session.dispose();
    const shared = globalThis[lspRegistryKey];
    if (shared) await (await shared).manager.stopAll();
    delete globalThis[lspRegistryKey];
  }
});

test("Pi-loader LSP lease survives creator cancellation, request cancellation and sibling disposal", async () => {
  const root = fixture();
  const source = [
    "export function answer() { return 42; }",
    "export const used = answer();",
    'export const mismatch: number = "wrong";',
    "",
  ].join("\n");
  writeFileSync(path.join(root, "src", "sample.ts"), source);
  const [sessionA, sessionB] = await Promise.all([createPiSession(root), createPiSession(root)]);
  assert.notEqual(sessionA.sessionId, sessionB.sessionId);
  const shared = await globalThis[lspRegistryKey];
  assert.ok(shared, "Pi file loader bound the shared LSP manager");
  const manager = shared.manager;
  const originalFactory = manager.clientFactory;
  let enterInitialization;
  let releaseInitialization;
  let notifyReferences;
  let releaseReferences;
  let referencesEntered = new Promise((resolve) => { notifyReferences = resolve; });
  let referencesGate = new Promise((resolve) => { releaseReferences = resolve; });
  const initializationEntered = new Promise((resolve) => { enterInitialization = resolve; });
  const initializationGate = new Promise((resolve) => { releaseInitialization = resolve; });
  manager.clientFactory = function (...args) {
    const client = originalFactory.apply(this, args);
    const initialize = client.initialize.bind(client);
    client.initialize = async (...initArgs) => {
      enterInitialization();
      await initializationGate;
      return initialize(...initArgs);
    };
    const references = client.references.bind(client);
    client.references = async (...referenceArgs) => {
      const entered = notifyReferences;
      const gate = referencesGate;
      entered();
      await gate;
      return references(...referenceArgs);
    };
    return client;
  };

  let creator;
  let sibling;
  let disposedA = false;
  try {
    const warmed = await sessionTool(sessionA, root, "module_report")({ file: "src/sample.ts" });
    assert.equal(JSON.parse(warmed.content[0].text).graph.status, "available", warmed.content[0].text);
    assert.equal(manager.clientCount(), 0, "AgentSession loading does not eagerly start an LSP client");

    const creatorController = new AbortController();
    creator = sessionTool(sessionA, root, "inspect_symbol")({ symbol: "answer", file: "src/sample.ts" }, creatorController.signal);
    await initializationEntered;
    const rootKey = path.resolve(root);
    const creatorTail = shared.queues.get(rootKey);
    assert.ok(creatorTail, "creator entered the workspace LSP queue");

    let siblingSettled = false;
    sibling = sessionTool(sessionB, root, "inspect_symbol")({ symbol: "answer", file: "src/sample.ts" });
    sibling.then(() => { siblingSettled = true; }, () => { siblingSettled = true; });
    await waitFor(() => shared.queues.get(rootKey) !== creatorTail, "second AgentSession did not wait behind LSP initialization", 20_000);

    creatorController.abort();
    const cancelled = await creator;
    assert.equal(cancelled.isError, true);
    assert.match(cancelled.content[0].text, /abort/i);
    assert.equal(siblingSettled, false);
    assert.equal(manager.getSnapshot()[0]?.isInitializing, true);

    releaseInitialization();
    await referencesEntered;
    assert.equal(manager.getSnapshot()[0]?.refCount, 1, "started LSP work retains its upstream client lease after caller cancellation");
    await sessionA.dispose();
    disposedA = true;
    releaseReferences();

    const survived = await sibling;
    assert.equal(survived.isError, undefined);
    assert.ok(survived.details.codeIntelligence.sources.lsp.calls >= 2);
    assert.ok(survived.details.codeIntelligence.sources.lsp.durationMs >= 0);
    const inspection = JSON.parse(survived.content[0].text);
    assert.equal(inspection.status, "ok");
    assert.equal(inspection.symbol, "answer");
    assert.equal(inspection.graph.status, "ok");
    assert.equal(inspection.diagnostics.status, "available");
    assert.ok(inspection.diagnostics.count >= 1);
    assert.equal(inspection.references.status, "available");
    assert.ok(inspection.references.total >= 2);
    assert.ok(inspection.references.locations.some((location) => location.uri.endsWith("sample.ts")));

    let enterSecondReferences;
    let releaseSecondReferences;
    const secondReferencesEntered = new Promise((resolve) => { enterSecondReferences = resolve; });
    referencesEntered = secondReferencesEntered;
    referencesGate = new Promise((resolve) => { releaseSecondReferences = resolve; });
    releaseReferences = releaseSecondReferences;
    notifyReferences = enterSecondReferences;
    const requestController = new AbortController();
    const request = sessionTool(sessionB, root, "inspect_symbol")({ symbol: "answer", file: "src/sample.ts" }, requestController.signal);
    await secondReferencesEntered;
    assert.equal(manager.getSnapshot()[0]?.refCount, 1);
    requestController.abort();
    const requestCancelled = await request;
    assert.equal(requestCancelled.isError, true);
    assert.equal(manager.getSnapshot()[0]?.refCount, 1, "caller cancellation does not release a live LSP request lease");
    releaseSecondReferences();
    await waitFor(() => !shared.queues.has(path.resolve(root)) && manager.getSnapshot()[0]?.refCount === 0, "cancelled LSP request did not release its lease after settling");

    const ast = await sessionTool(sessionB, root, "read_enclosing")({ file: "src/sample.ts", line: 1, character: 15 });
    assert.equal(JSON.parse(ast.content[0].text).status, "ok");
    const graph = await sessionTool(sessionB, root, "module_report")({ file: "src/sample.ts" });
    assert.equal(JSON.parse(graph.content[0].text).graph.status, "available");
  } finally {
    releaseInitialization();
    releaseReferences();
    manager.clientFactory = originalFactory;
    await Promise.allSettled([...(creator ? [creator] : []), ...(sibling ? [sibling] : [])]);
    await Promise.all([...(disposedA ? [] : [sessionA.dispose()]), sessionB.dispose()]);
  }
});

test("two Pi AgentSessions isolate graph cancellation; sibling keeps AST, semantic LSP and graph", async () => {
  const root = fixture();
  await invoke("module_report", root, { file: "src/sample.ts" });
  setMetadata(root, "index_state", "partial");
  const [sessionA, sessionB] = await Promise.all([createPiSession(root), createPiSession(root)]);
  assert.notEqual(sessionA.sessionId, sessionB.sessionId);
  const originalIndexAll = CodeGraph.prototype.indexAll;
  let enterIndexing;
  let releaseIndexing;
  let calls = 0;
  const entered = new Promise((resolve) => { enterIndexing = resolve; });
  const gate = new Promise((resolve) => { releaseIndexing = resolve; });
  CodeGraph.prototype.indexAll = async function (options) {
    calls += 1;
    if (calls === 1) {
      enterIndexing();
      await gate;
    }
    return originalIndexAll.call(this, options);
  };

  const cancelledController = new AbortController();
  let disposedA = false;
  try {
    const cancelled = sessionTool(sessionA, root, "module_report")({ file: "src/sample.ts" }, cancelledController.signal);
    await entered;
    const survivor = sessionTool(sessionB, root, "module_report")({ file: "src/sample.ts" });
    await waitForJoinedWaiters(2);
    cancelledController.abort();
    releaseIndexing();

    const cancelledResult = await cancelled;
    const survived = await survivor;
    assert.equal(cancelledResult.isError, true);
    assert.match(cancelledResult.content[0].text, /abort/i);
    assert.equal(survived.isError, undefined);
    const report = JSON.parse(survived.content[0].text);
    assert.equal(report.graph.freshness.lifecycle.action, "reindexed");
    assert.equal(report.graph.freshness.indexState, "complete");
    assert.equal(calls, 1);

    await sessionA.dispose();
    disposedA = true;
    const enclosed = await sessionTool(sessionB, root, "read_enclosing")({ file: "src/sample.ts", line: 1, character: 20 });
    assert.equal(JSON.parse(enclosed.content[0].text).status, "ok");
    const inspected = await sessionTool(sessionB, root, "inspect_symbol")({ symbol: "answer", file: "src/sample.ts" });
    const inspection = JSON.parse(inspected.content[0].text);
    assert.equal(inspection.graph.status, "ok");
    assert.equal(inspection.references.status, "available");
    assert.ok(inspection.references.total >= 1);
    assert.equal(inspection.diagnostics.status, "available");
  } finally {
    releaseIndexing();
    CodeGraph.prototype.indexAll = originalIndexAll;
    await Promise.all([...(disposedA ? [] : [sessionA.dispose()]), sessionB.dispose()]);
  }
});

test("separates graph data directories selected by CODEGRAPH_DIR", async () => {
  const root = fixture();
  const originalDir = process.env.CODEGRAPH_DIR;
  try {
    process.env.CODEGRAPH_DIR = ".codegraph-t3-a";
    const first = await invoke("module_report", root, { file: "src/sample.ts" });
    assert.equal(first.graph.freshness.lifecycle.action, "built");
    assert.ok(existsSync(path.join(root, ".codegraph-t3-a", "codegraph.db")));

    process.env.CODEGRAPH_DIR = ".codegraph-t3-b";
    const second = await invoke("module_report", root, { file: "src/sample.ts" });
    assert.equal(second.graph.freshness.lifecycle.action, "built");
    assert.ok(existsSync(path.join(root, ".codegraph-t3-b", "codegraph.db")));

    process.env.CODEGRAPH_DIR = ".codegraph-t3-a";
    const reused = await invoke("module_report", root, { file: "src/sample.ts" });
    assert.equal(reused.graph.freshness.lifecycle.action, "reused");
  } finally {
    if (originalDir === undefined) delete process.env.CODEGRAPH_DIR;
    else process.env.CODEGRAPH_DIR = originalDir;
  }
});

test("does not reuse graph files across physical git worktrees", async () => {
  const root = fixture();
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-worktree`);
  roots.push(worktree);
  execFileSync("git", ["worktree", "add", "--quiet", "--detach", worktree, "HEAD"], { cwd: root });

  const first = await invoke("module_report", root, { file: "src/sample.ts" });
  const other = await invoke("module_report", worktree, { file: "src/sample.ts" });
  assert.equal(first.graph.freshness.lifecycle.action, "built");
  assert.equal(other.graph.freshness.lifecycle.action, "built");
  assert.notEqual(await import("node:fs/promises").then(({ realpath }) => realpath(root)), await import("node:fs/promises").then(({ realpath }) => realpath(worktree)));
  assert.ok(existsSync(path.join(root, ".codegraph", "codegraph.db")));
  assert.ok(existsSync(path.join(worktree, ".codegraph", "codegraph.db")));
});
