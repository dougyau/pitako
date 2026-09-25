import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { disposeDefaultLspManager } from "pi-lsp-client/src/lsp/manager.js";
import { findServerForExtension } from "pi-lsp-client/src/lsp/server-resolution.js";
import { CODE_INTELLIGENCE_TOOLS } from "../extensions/code-intelligence/tools.ts";
import codeIntelligence from "../extensions/code-intelligence/index.ts";

const lspRegistryKey = Symbol.for("pitako.code-intelligence.lsp-registry");
const globals = globalThis as typeof globalThis & { [key: symbol]: Promise<any> | undefined };
beforeEach(() => codeIntelligence({ registerTool() {} } as never));
const bindTestLsp = (findWorkspaceRoot: (file: string) => string, clientForFile: (file: string) => Record<string, unknown>) => {
  globals[lspRegistryKey] = Object.assign(Promise.resolve({
    findWorkspaceRoot,
    withLspClient: async (file: string, run: (client: any) => Promise<unknown>) => run(clientForFile(file)),
    manager: { stopAll: async () => {} },
    queues: new Map(),
  }), { findServerForExtension });
};

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-code-query-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  const sharedLsp = globals[lspRegistryKey];
  if (sharedLsp) {
    await (await sharedLsp).manager.stopAll();
    delete globals[lspRegistryKey];
  }
  await disposeDefaultLspManager();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const invoke = async (name: string, cwd: string, params: Record<string, unknown> = {}, signal = new AbortController().signal) => {
  const tool = CODE_INTELLIGENCE_TOOLS.find((item) => item.name === name)!;
  const result = await tool.execute("test", params, signal, () => {}, { cwd });
  return JSON.parse(result.content[0]!.text);
};

test("terminal output fallback omits the rejected project preview", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const scripts = Object.fromEntries(Array.from({ length: 180 }, (_, index) => [`script-${String(index).padStart(3, "0")}-${"x".repeat(80)}`, "fallback-secret"]));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fallback", scripts }));

  const tool = CODE_INTELLIGENCE_TOOLS.find((item) => item.name === "project_report")!;
  const result = await tool.execute("terminal-fallback", {}, new AbortController().signal, () => {}, { cwd: dir });
  const text = result.content[0]!.text;
  const report = JSON.parse(text);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
  expect(report.originalBytes).toBeGreaterThan(12 * 1024);
  expect(report).toMatchObject({ status: "partial", truncated: true, limitBytes: 12 * 1024 });
  expect(report.evidence).toBeUndefined();
  expect(text).not.toContain("fallback-secret");
});

test("six direct query definitions return bounded AST and real working-diff evidence", async () => {
  const dir = tempDir();
  const file = path.join(dir, "src", "sample.ts");
  const initial = [
    'import { value } from "./dep";',
    "export function café() {",
    "  return value + 1;",
    "}",
    "export function outer() {",
    "  function inner() { return 2; }",
    "  return inner();",
    "}",
    "function duplicate() { return 1; }",
    "function duplicate() { return 2; }",
    "",
  ].join("\n");
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(file, initial);
  writeFileSync(path.join(dir, "src", "dep.ts"), "export const value = 4;\n");
  writeFileSync(path.join(dir, "src", "delete.ts"), "export const removed = true;\n");
  writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2]));
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  const before = readFileSync(file);

  const report = await invoke("project_report", dir);
  expect(report.workspace).toBe(dir);
  expect(report.manifests).toBeArray();
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "large-report", scripts: { fixture: "x".repeat(16_000) } }));
  const projectTool = CODE_INTELLIGENCE_TOOLS.find((item) => item.name === "project_report")!;
  const boundedReport = await projectTool.execute("test", {}, new AbortController().signal, () => {}, { cwd: dir });
  expect(Buffer.byteLength(boundedReport.content[0]!.text)).toBeLessThanOrEqual(12 * 1024);
  const boundedReportText = boundedReport.content[0]!.text;
  const boundedReportValue = JSON.parse(boundedReportText);
  expect(boundedReportValue.status).toBe("partial");
  expect((boundedReport.details.codeIntelligence as any).truncated).toBe(true);
  expect(boundedReportValue.truncated).toBe(true);
  expect(boundedReportValue.originalBytes).toBeGreaterThan(12 * 1024);
  expect(boundedReportValue.counts.packages).toBe(1);
  expect(boundedReportText).toContain('"workspace"');
  expect(boundedReportText).toContain('"scripts"');
  expect(boundedReportText).toContain("omitted");
  const symbol = await invoke("read_symbol", dir, { symbol: "café", file: "src/sample.ts" });
  expect(symbol.status).toBe("ok");
  expect(symbol.body.text).toContain("café");
  const noFileLookup = await invoke("read_symbol", dir, { symbol: "duplicate" });
  const noFileInspection = await invoke("inspect_symbol", dir, { symbol: "duplicate" });
  expect(noFileInspection).toEqual(noFileLookup);
  expect(["ambiguous", "unavailable"]).toContain(noFileInspection.status);
  if (noFileInspection.status === "unavailable") expect(noFileInspection.reason).toContain("supply file hint");
  expect((await invoke("read_symbol", dir, { symbol: "duplicate", file: "src/sample.ts" })).status).toBe("ambiguous");

  const enclosing = await invoke("read_enclosing", dir, { file: "src/sample.ts", line: 3, character: 4 });
  expect(enclosing.status).toBe("ok");
  expect(enclosing.range.start).toBe(2);
  expect((await invoke("read_enclosing", dir, { file: "src/sample.ts", line: 2 })).status).toBe("ok");
  const nested = await invoke("read_enclosing", dir, { file: "src/sample.ts", line: 6, character: 25 });
  expect(nested.status).toBe("ok");
  expect(nested.range.start).toBe(6);
  const module = await invoke("module_report", dir, { file: "src/sample.ts" });
  expect(module.imports.join("\n")).toContain("./dep");
  expect(module.declarations.some((item: { name?: string }) => item.name === "café")).toBe(true);

  const inspected = await invoke("inspect_symbol", dir, { symbol: "café", file: "src/sample.ts", includeBody: true });
  expect(inspected.status).toBe(inspected.graph.status === "ok" ? "ok" : "partial");
  expect(inspected.body.text).toContain("café");
  expect(inspected.diagnostics.status).toMatch(/available|unavailable/);
  expect(inspected.references.status).toMatch(/available|unavailable/);
  expect(inspected.grep.source).toContain("Pi grep");
  expect(inspected.grep.text).toContain("café");
  if (inspected.graph.status === "unavailable") expect(inspected.graph.relations).toBeNull();
  expect(Buffer.byteLength(JSON.stringify(inspected))).toBeLessThanOrEqual(12 * 1024);
  expect(readFileSync(file, "utf8")).toBe(initial);

  writeFileSync(file, initial.replace("return value + 1", "return value + 2"));
  execFileSync("git", ["add", "src/sample.ts"], { cwd: dir });
  writeFileSync(file, readFileSync(file, "utf8").replace("return 2;", "return 3;"));
  writeFileSync(path.join(dir, "src", "new.ts"), "export function added() { return 1; }\n");
  execFileSync("git", ["mv", "src/dep.ts", "src/dep-renamed.ts"], { cwd: dir });
  execFileSync("git", ["rm", "src/delete.ts"], { cwd: dir });
  writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 3]));
  const review = await invoke("review_surface", dir);
  const headTree = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
  expect(review.comparison).toBe(`HEAD (${headTree}) tree to current worktree`);
  expect(review.stagedAndUnstaged).toBe(true);
  expect(review.untrackedIncluded).toBe(true);
  expect(review.files.map((item: { file: string }) => item.file)).toContain("src/new.ts");
  expect(review.files.find((item: { file: string }) => item.file === "src/dep-renamed.ts")?.renamedFrom).toBe("src/dep.ts");
  expect(review.files.find((item: { file: string }) => item.file === "src/delete.ts")?.status).toBe("deleted");
  expect(review.files.find((item: { file: string }) => item.file === "src/delete.ts")?.enclosures.some((item: { name?: string; side?: string }) => item.name === "removed" && item.side === "base")).toBe(true);
  expect(review.files.find((item: { file: string }) => item.file === "blob.bin")?.status).toBe("binary");
  expect(["available", "unavailable"]).toContain(review.relatedGraphConsumers.status);
  if (review.relatedGraphConsumers.status === "unavailable") expect(review.relatedGraphConsumers.reason).toBeTruthy();
  const sampleSurface = review.files.find((item: { file: string }) => item.file === "src/sample.ts");
  expect(sampleSurface?.enclosures.length).toBeGreaterThan(1);
  expect(sampleSurface?.enclosures.map((item: { line: number }) => item.line)).toContain(6);
  expect(readFileSync(path.join(dir, "src", "dep-renamed.ts"), "utf8")).toBe("export const value = 4;\n");
  expect(before.toString()).toBe(initial);
  for (const tool of CODE_INTELLIGENCE_TOOLS) {
    const value = await invoke(tool.name, dir, tool.name === "project_report" ? {} : tool.name === "read_symbol" ? { symbol: "café", file: "src/sample.ts" } : { file: "src/sample.ts", symbol: "café", line: 3 });
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(12 * 1024);
  }
});

test("AST reads and positions preserve Unicode source ranges", async () => {
  const dir = tempDir();
  const file = path.join(dir, "src", "unicode.ts");
  const source = [
    "// café 😀 before",
    "export function unicodeTarget() {",
    '  const label = "café 🚀 inside";',
    "  return label.length;",
    "}",
    "",
  ].join("\n");
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(file, source);
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "unicode fixture"], { cwd: dir });

  const expectedBody = [
    "function unicodeTarget() {",
    '  const label = "café 🚀 inside";',
    "  return label.length;",
    "}",
  ].join("\n");
  const symbol = await invoke("read_symbol", dir, { symbol: "unicodeTarget", file: "src/unicode.ts" });
  expect(symbol.status).toBe("ok");
  expect(symbol.truncated).toBe(false);
  expect(symbol.body).toEqual({ text: expectedBody, totalLines: 4, showingLines: 4, truncated: false });
  expect(symbol.range).toEqual({ start: 2, end: 5, startColumn: 7, endColumn: 1, columnEncoding: "utf-16", startByte: 28, endByte: 116 });

  const alias = await invoke("read_symbol", dir, { symbol: "unicodeTarget", file: "src/unicode.ts", language: "typescript" });
  expect(alias.status).toBe("ok");
  expect(alias.body.text).toBe(expectedBody);

  const enclosing = await invoke("read_enclosing", dir, { file: "src/unicode.ts", line: 3, character: 27 });
  expect(enclosing.status).toBe("ok");
  expect(enclosing.truncated).toBe(false);
  expect(enclosing.kind).toBe("lexical_declaration");
  expect(enclosing.range).toEqual({ start: 3, end: 3, startColumn: 2, endColumn: 33, columnEncoding: "utf-16", startByte: 57, endByte: 91 });
  expect(enclosing.body).toEqual({ text: 'const label = "café 🚀 inside";', totalLines: 1, showingLines: 1, truncated: false });
});

test("symbol lookup counts only declaration names, not type and value references", async () => {
  const dir = tempDir();
  const file = path.join(dir, "sample.ts");
  writeFileSync(file, [
    "type Alias = Other;",
    "const value = Other;",
    "interface Other {}",
    "function Other() {}",
    "",
  ].join("\n"));

  const read = await invoke("read_symbol", dir, { symbol: "Other", file: "sample.ts" });
  expect(read.status).toBe("ambiguous");
  expect(read.total).toBe(2);
  expect(read.candidates.map((candidate: { kind: string }) => candidate.kind)).toEqual(["interface_declaration", "function_declaration"]);
  const inspected = await invoke("inspect_symbol", dir, { symbol: "Other", file: "sample.ts" });
  expect(inspected.status).toBe("ambiguous");
  expect(inspected.total).toBe(2);
});

test("AST declaration queries find interface members and skip unnamed bodies", async () => {
  const dir = tempDir();
  const file = path.join(dir, "sample.ts");
  writeFileSync(file, [
    "interface Box {",
    "  value: number;",
    "  run(): void;",
    "}",
    "class Empty {",
    "  // comment only",
    "}",
    "",
  ].join("\n"));

  const property = await invoke("read_symbol", dir, { symbol: "value", file: "sample.ts" });
  expect(property).toMatchObject({ status: "ok", kind: "property_signature" });
  const method = await invoke("read_symbol", dir, { symbol: "run", file: "sample.ts" });
  expect(method).toMatchObject({ status: "ok", kind: "method_signature" });
  expect((await invoke("read_enclosing", dir, { file: "sample.ts", line: 2, character: 4 })).kind).toBe("property_signature");
  expect((await invoke("read_enclosing", dir, { file: "sample.ts", line: 3, character: 4 })).kind).toBe("method_signature");
  expect((await invoke("read_enclosing", dir, { file: "sample.ts", line: 6, character: 4 })).kind).toBe("class_declaration");
});

test("project_report rejects symlinked manifests outside the physical workspace and keeps git status plain", async () => {
  const dir = tempDir();
  const outside = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "tracked.ts"), "export const value = 1;\n");
  writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "OUTSIDE-SECRET" }));
  symlinkSync(path.join(outside, "package.json"), path.join(dir, "package.json"));
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  execFileSync("git", ["config", "color.ui", "always"], { cwd: dir });
  writeFileSync(path.join(dir, "tracked.ts"), "export const value = 2;\n");

  const report = await invoke("project_report", dir);
  expect(report.packages).toContainEqual({ file: "package.json", status: "unreadable" });
  expect(JSON.stringify(report)).not.toContain("OUTSIDE-SECRET");
  expect(report.git.status.join("\n")).toMatch(/tracked.ts/);
  expect(report.git.status.join("\n")).not.toMatch(/\x1b\[/);
});

test("review_surface preserves paths, deletions, and declarations", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "café.ts"), "export function café() { return 1; }\n");
  writeFileSync(path.join(dir, "src", "a b.ts"), "export const spaced = 1;\n");
  writeFileSync(path.join(dir, "src", "remove.ts"), "export function gone() {\n  return 1;\n}\nexport function kept() { return 2; }\n");
  writeFileSync(path.join(dir, "src", "signature.ts"), "export function before() { return 1; }\n");
  writeFileSync(path.join(dir, "src", "from name.ts"), "export function moved() { return 1; }\n");
  writeFileSync(path.join(dir, "src", "replace.ts"), "export const removed = 1;\nexport const kept = 2;\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });

  writeFileSync(path.join(dir, "café.ts"), "export function café() { return 2; }\n");
  writeFileSync(path.join(dir, "src", "a b.ts"), "export const spaced = 2;\n");
  writeFileSync(path.join(dir, "src", "remove.ts"), "export function kept() { return 2; }\n");
  writeFileSync(path.join(dir, "src", "signature.ts"), "export function renamed() { return 1; }\n");
  writeFileSync(path.join(dir, "src", "replace.ts"), "export const added = 3;\n");
  writeFileSync(path.join(dir, "src", "new.ts"), "export const fresh = true;\n");
  execFileSync("git", ["mv", "src/from name.ts", "src/to name.ts"], { cwd: dir });
  execFileSync("git", ["config", "diff.renames", "false"], { cwd: dir });

  const report = await invoke("review_surface", dir);
  const file = (name: string) => report.files.find((item: { file: string }) => item.file === name);
  expect(file("café.ts")?.changedLines).toBeGreaterThan(0);
  expect(file("src/a b.ts")?.changedLines).toBeGreaterThan(0);
  expect(file("src/a b.ts\t")).toBeUndefined();
  expect(file("src/to name.ts")?.renamedFrom).toBe("src/from name.ts");
  expect(file("src/remove.ts")?.enclosures.some((item: { name?: string; side?: string }) => item.name === "gone" && item.side === "base")).toBe(true);
  expect(file("src/signature.ts")?.enclosures.some((item: { name?: string }) => item.name === "renamed")).toBe(true);
  const replacement = file("src/replace.ts");
  expect(replacement?.changedLines).toBe(3);
  expect(replacement?.enclosures).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "removed", side: "base" }),
    expect.objectContaining({ name: "kept", side: "base" }),
    expect.objectContaining({ name: "added", side: "worktree" }),
  ]));
  expect(file("src/new.ts")).toMatchObject({ change: "untracked", baseSourceStatus: "not_in_base" });
  expect(file("src/new.ts")?.enclosures[0]?.side).toBe("worktree");
  expect(report.untrackedIncluded).toBe(true);
});

test("review_surface parses diffs with git color forced on", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "sample.ts"), "export function before() { return 1; }\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });

  execFileSync("git", ["config", "color.ui", "always"], { cwd: dir });
  writeFileSync(path.join(dir, "sample.ts"), "export function after() { return 1; }\n");
  const report = await invoke("review_surface", dir);
  const file = report.files.find((item: { file: string }) => item.file === "sample.ts");
  expect(file?.changedLines).toBe(2);
  expect(file?.showingChangedLines).toBe(2);
  expect(file?.enclosures.some((item: { name?: string }) => item.name === "after")).toBe(true);
});

test("review_surface resolves refs generically and fails closed on Git ambiguity warnings", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  const file = path.join(dir, "sample.ts");
  writeFileSync(file, "export const seed = true;\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: dir });
  const seed = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const headBranch = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["branch", "unique", seed], { cwd: dir });

  const commitOnBranch = (branch: string, declaration: string) => {
    execFileSync("git", ["checkout", "-q", "-b", branch, seed], { cwd: dir });
    writeFileSync(file, `export const ${declaration} = true;\n`);
    execFileSync("git", ["add", "sample.ts"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", `${branch} target`], { cwd: dir });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  };
  const branchTarget = commitOnBranch("topic", "branchRef");
  const tagTarget = commitOnBranch("tag-target", "tagRef");
  const remoteTarget = commitOnBranch("remote-target", "remoteRef");

  execFileSync("git", ["checkout", "-q", headBranch], { cwd: dir });
  writeFileSync(file, "export const headRef = true;\n");
  execFileSync("git", ["add", "sample.ts"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "head target"], { cwd: dir });
  execFileSync("git", ["update-ref", "refs/remotes/origin/topic", remoteTarget], { cwd: dir });
  writeFileSync(file, "export const worktreeRef = true;\n");

  const treeOid = (ref: string) => execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`], { cwd: dir, encoding: "utf8" }).trim();
  const baseDeclaration = async (base: string) => {
    const report = await invoke("review_surface", dir, { base });
    expect(report.comparison).toBe(`${base} (${treeOid(base)}) tree to current worktree`);
    return report.files.find((item: { file: string }) => item.file === "sample.ts")?.enclosures.find((item: { side: string }) => item.side === "base")?.name;
  };
  const tool = CODE_INTELLIGENCE_TOOLS.find((item) => item.name === "review_surface")!;
  const assertAmbiguous = async (base: string) => {
    const warning = spawnSync("git", ["-c", "core.warnAmbiguousRefs=true", "rev-parse", "--verify", "--end-of-options", `${base}^{tree}`], { cwd: dir, encoding: "utf8" });
    expect(warning.status).toBe(0);
    expect(warning.stderr).not.toBe("");
    const result = await tool.execute("test", { base }, new AbortController().signal, () => {}, { cwd: dir });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/unavailable:.*ref.*unambiguously/i);
    expect(result.content[0]!.text).not.toMatch(/warning:|advertencia|branchRef|tagRef|remoteRef/i);
  };

  expect(await baseDeclaration("topic")).toBe("branchRef");
  expect(await baseDeclaration("unique")).toBe("seed");
  expect(await baseDeclaration("HEAD")).toBe("headRef");
  expect(await baseDeclaration("refs/heads/topic")).toBe("branchRef");
  expect(await baseDeclaration("origin/topic")).toBe("remoteRef");
  expect(await baseDeclaration("refs/remotes/origin/topic")).toBe("remoteRef");

  execFileSync("git", ["tag", "topic", tagTarget], { cwd: dir });
  execFileSync("git", ["tag", "origin/topic", tagTarget], { cwd: dir });
  expect(await baseDeclaration("refs/tags/topic")).toBe("tagRef");
  expect(await baseDeclaration("refs/tags/origin/topic")).toBe("tagRef");
  await assertAmbiguous("origin/topic");
  await assertAmbiguous("topic");

  execFileSync("git", ["tag", "-d", "origin/topic"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["branch", "origin/topic", branchTarget], { cwd: dir });
  await assertAmbiguous("origin/topic");
  expect(await baseDeclaration("refs/heads/origin/topic")).toBe("branchRef");
  expect(await baseDeclaration("refs/remotes/origin/topic")).toBe("remoteRef");

  execFileSync("git", ["tag", "refs/heads/topic", tagTarget], { cwd: dir });
  await assertAmbiguous("refs/heads/topic");
  expect(await baseDeclaration("refs/tags/refs/heads/topic")).toBe("tagRef");
});

test("review_surface shows 120 of both replacement sides and reports output truncation", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  const filePath = path.join(dir, "large.ts");
  const lines = (offset: number) => Array.from({ length: 200 }, (_, i) => `export const ${offset ? "new" : "old"}${i} = ${i};`).join("\n") + "\n";
  writeFileSync(filePath, lines(0));
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  writeFileSync(filePath, lines(1));

  const tool = CODE_INTELLIGENCE_TOOLS.find((item) => item.name === "review_surface")!;
  const result = await tool.execute("test", {}, new AbortController().signal, () => {}, { cwd: dir });
  const text = result.content[0]!.text;
  const report = JSON.parse(text);
  const file = report.files.find((item: { file: string }) => item.file === "large.ts");
  expect(file.changedLines).toBe(400);
  expect(file.showingChangedLines).toBe(120);
  expect(file.truncated).toBe(true);
  expect(file.enclosures).toHaveLength(12);
  expect(file.enclosures).toContainEqual(expect.objectContaining({ side: "base", name: "old0" }));
  expect(file.enclosures).toContainEqual(expect.objectContaining({ side: "worktree", name: "new0" }));
  expect(report.truncated).toBe(true);
  expect(report.truncatedFields["$.files[0].enclosures"]).toEqual({ totalItems: 120, showingItems: 12 });
  expect(file.lineCoverage).toEqual({
    base: { total: 200, selected: 60, showing: 6 },
    worktree: { total: 200, selected: 60, showing: 6 },
  });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
});

test("review_surface reports the unselected worktree side when one source-line slot remains", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  const removed = Array.from({ length: 119 }, (_, i) => `export const gone${i} = ${i};`).join("\n") + "\n";
  const replacement = (prefix: string) => Array.from({ length: 200 }, (_, i) => `export const ${prefix}${i} = ${i};`).join("\n") + "\n";
  writeFileSync(path.join(dir, "a-del.ts"), removed);
  writeFileSync(path.join(dir, "b-rep.ts"), replacement("old"));
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  writeFileSync(path.join(dir, "a-del.ts"), "");
  writeFileSync(path.join(dir, "b-rep.ts"), replacement("new"));

  const text = (await CODE_INTELLIGENCE_TOOLS.find((item) => item.name === "review_surface")!.execute("one-line-remainder", {}, new AbortController().signal, () => {}, { cwd: dir })).content[0]!.text;
  const report = JSON.parse(text);
  const deletion = report.files.find((item: { file: string }) => item.file === "a-del.ts");
  const replaced = report.files.find((item: { file: string }) => item.file === "b-rep.ts");
  expect(deletion.showingChangedLines).toBe(119);
  expect(replaced).toMatchObject({ changedLines: 400, showingChangedLines: 1 });
  expect(replaced.enclosures).toContainEqual(expect.objectContaining({ side: "base", name: "old0" }));
  expect(replaced.enclosures.some((item: { name?: string }) => item.name === "new0")).toBe(false);
  expect(replaced.lineCoverage).toEqual({
    base: { total: 200, selected: 1, showing: 1 },
    worktree: { total: 200, selected: 0, showing: 0 },
  });
  expect(deletion.lineCoverage.base.selected + replaced.lineCoverage.base.selected + replaced.lineCoverage.worktree.selected).toBe(120);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
});

test("resolves variable bindings, reports module truncation, and fails closed on ambiguous languages", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "symbols.ts"), [
    "export const value = 1;",
    "const arrow = () => 1;",
    "var legacy = 2;",
    "export function collision() {}",
    "export const collision = 1;",
    "function overloaded(value: string): string;",
    "function overloaded(value: number): number;",
    "function overloaded(value: string | number) { return value; }",
    "",
  ].join("\n"));
  writeFileSync(path.join(dir, "src", "module.ts"), [
    ...Array.from({ length: 25 }, (_, i) => `import { value${i} } from "./dep${i}";`),
    ...Array.from({ length: 40 }, (_, i) => `export const item${i} = ${i};`),
    "",
  ].join("\n"));
  writeFileSync(path.join(dir, "src", "ambiguous.unknown"), "def run(): pass\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });

  for (const symbol of ["value", "arrow", "legacy"]) {
    const result = await invoke("read_symbol", dir, { symbol, file: "src/symbols.ts" });
    expect(result.status).toBe("ok");
    expect(result.body.text).toContain(symbol);
  }
  expect((await invoke("read_symbol", dir, { symbol: "collision", file: "src/symbols.ts" })).status).toBe("ambiguous");
  expect((await invoke("read_symbol", dir, { symbol: "overloaded", file: "src/symbols.ts" })).total).toBe(3);
  expect((await invoke("inspect_symbol", dir, { symbol: "collision", file: "src/symbols.ts" })).status).toBe("ambiguous");

  const module = await invoke("module_report", dir, { file: "src/module.ts" });
  expect(module.importsTotal).toBe(25);
  expect(module.imports.length).toBe(8);
  expect(module.importsShowing).toBe(8);
  expect(module.importsTruncated).toBe(true);
  expect(module.truncated).toBe(true);
  const moduleResult = await CODE_INTELLIGENCE_TOOLS.find((tool) => tool.name === "module_report")!.execute("module-truncation", { file: "src/module.ts" }, new AbortController().signal, () => {}, { cwd: dir });
  expect((moduleResult.details.codeIntelligence as any).truncated).toBe(true);
  expect(module.declarationsTotal).toBe(40);
  expect(module.declarations.length).toBe(8);
  expect(module.declarationsShowing).toBe(8);
  expect(module.declarationsTruncated).toBe(true);
  const symbolsModule = await invoke("module_report", dir, { file: "src/symbols.ts" });
  expect(symbolsModule.declarations.some((item: { name?: string }) => item.name === "value")).toBe(true);
  expect(symbolsModule.declarations.some((item: { name?: string }) => item.name === "arrow")).toBe(true);
  expect(symbolsModule.declarations.some((item: { name?: string }) => item.name === "legacy")).toBe(true);

  for (const name of ["read_enclosing", "module_report", "read_symbol", "inspect_symbol"]) {
    const tool = CODE_INTELLIGENCE_TOOLS.find((item) => item.name === name)!;
    const params = name === "read_enclosing"
      ? { file: "src/ambiguous.unknown", line: 1 }
      : name === "read_symbol" || name === "inspect_symbol"
        ? { file: "src/ambiguous.unknown", symbol: "run" }
        : { file: "src/ambiguous.unknown" };
    const result = await tool.execute("ambiguous-language", params, new AbortController().signal, () => {}, { cwd: dir });
    const report = JSON.parse(result.content[0]!.text);
    expect(report.status).toBe("ambiguous");
    expect(report.languageResolution.status).toBe("ambiguous");
    if (name === "read_symbol" || name === "inspect_symbol") expect(report.candidates).toContainEqual({ language: "TypeScript" });
    expect(result.isError).toBeUndefined();
    expect((result.details.codeIntelligence as any).sources.lsp.calls).toBe(0);
  }
});

test("Bun reports the CodeGraph runtime gap without creating an index directory", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(path.join(dir, "sample.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: dir });
  for (const name of ["module_report", "review_surface", "project_report"]) {
    const report = await invoke(name, dir, name === "module_report" ? { file: "sample.ts" } : {});
    const graph = name === "module_report" ? report.graph : name === "review_surface" ? report.relatedGraphConsumers : report.sources.graph;
    expect(graph.status).toBe("unavailable");
    expect(graph.reason).toMatch(/runtime/i);
    expect(graph.reason).not.toMatch(/exports are unavailable/i);
  }
  const moduleTool = CODE_INTELLIGENCE_TOOLS.find((item) => item.name === "module_report")!;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await moduleTool.execute("runtime-metric", { file: "sample.ts" }, new AbortController().signal, () => {}, { cwd: dir });
    expect((result.details.codeIntelligence as any).graph).toMatchObject({ state: "unavailable", failures: 1, buildFailures: {} });
  }
  expect(existsSync(path.join(dir, ".codegraph"))).toBe(false);
});

test("review_surface reports omitted untracked files and truncation honestly", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "seed.ts"), "export const seed = 1;\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  for (let i = 0; i < 40; i++) writeFileSync(path.join(dir, `new-${i}.txt`), `file ${i}\n`);

  const report = await invoke("review_surface", dir);
  expect(report.totalChangedFiles).toBe(40);
  expect(report.untrackedTotal).toBe(40);
  expect(report.untrackedShowing).toBe(report.files.filter((item: { change: string }) => item.change === "untracked").length);
  expect(report.untrackedShowing).toBeLessThan(40);
  expect(report.untrackedIncluded).toBe(false);
  expect(report.truncated).toBe(true);
  expect(report.status).toBe("partial");
});

test("read_enclosing keeps ambiguous paths distinct from unsupported files and preserves LSP line endings", async () => {
  const dir = tempDir();
  const markdown = path.join(dir, "README.md");
  const extensionless = path.join(dir, "README");
  const python = path.join(dir, "sample.py");
  const javascript = path.join(dir, "sample.js");
  const markdownSource = "# Guide\r\n\r\nbody\r\n";
  writeFileSync(markdown, markdownSource);
  writeFileSync(extensionless, "untyped source\n");
  writeFileSync(python, "def answer():\r\n  return 42\r\n");
  writeFileSync(javascript, "function answer() { return 42; }\n");
  let documentCalls = 0;
  bindTestLsp(() => dir, (file) => ({
    documentSymbols: async () => {
      documentCalls++;
      return file.endsWith(".py")
        ? [{ name: "answer", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 11 } } }]
        : [{ name: "Guide", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 4 } } }];
    },
  }));

  const fallback = await invoke("read_enclosing", dir, { file: "README.md", line: 2 });
  expect(fallback).toMatchObject({ status: "ok", source: "LSP documentSymbols", name: "Guide", body: { text: "# Guide\r\n\r\nbody", totalLines: 3 } });
  expect(await invoke("read_enclosing", dir, { file: "sample.py", line: 2 })).toMatchObject({ status: "ok", source: "LSP documentSymbols", name: "answer", body: { text: "def answer():\r\n  return 42", totalLines: 2 } });
  expect((await invoke("read_enclosing", dir, { file: "README", line: 1 })).status).toBe("ambiguous");
  expect(await invoke("read_enclosing", dir, { file: "sample.js", line: 1 })).toMatchObject({ status: "ok", language: "JavaScript" });
  expect(documentCalls).toBe(2);
});

test("unsupported LSP fallbacks report unavailable when no adapter is bound", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "README.md"), "# Guide\n");
  writeFileSync(path.join(dir, "lib.rs"), "pub fn hello() {}\n");
  delete globals[lspRegistryKey];

  for (const [name, params] of [
    ["read_enclosing", { file: "README.md", line: 1 }],
    ["read_enclosing", { file: "lib.rs", line: 1 }],
    ["read_symbol", { file: "README.md", symbol: "Guide" }],
    ["inspect_symbol", { file: "README.md", symbol: "Guide" }],
  ] as const) {
    const report = await invoke(name, dir, params);
    expect(report).toMatchObject({ status: "unavailable", source: "LSP documentSymbols" });
    expect(report.reason).toContain("binding is not initialized");
  }
});

test("configured language-server extensions and file-hinted symbols use validated LSP fallbacks", async () => {
  const dir = tempDir();
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "lib.rs"), "pub fn hello() {\n    0\n}\n");
  writeFileSync(path.join(dir, "src", "main.go"), "package main\nfunc answer() int { return 42 }\n");
  writeFileSync(path.join(dir, "README.md"), "# Guide\n");
  const queried: string[] = [];
  const symbols: Record<string, any[]> = {
    "lib.rs": [{ name: "hello", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }, selectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 12 } } }],
    "main.go": [{ name: "answer", kind: 12, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 35 } }, selectionRange: { start: { line: 1, character: 5 }, end: { line: 1, character: 11 } } }],
    "README.md": [
      { name: "Guide", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, selectionRange: { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } } },
      { name: "stale", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, selectionRange: { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } } },
    ],
  };
  bindTestLsp(() => dir, (file) => ({
    documentSymbols: async () => {
      queried.push(file);
      return symbols[path.basename(file)] ?? [];
    },
  }));

  expect(await invoke("read_enclosing", dir, { file: "src/lib.rs", line: 2 })).toMatchObject({ status: "ok", source: "LSP documentSymbols", name: "hello" });
  expect(await invoke("read_enclosing", dir, { file: "src/main.go", line: 2 })).toMatchObject({ status: "ok", source: "LSP documentSymbols", name: "answer" });
  expect(await invoke("read_symbol", dir, { file: "src/lib.rs", symbol: "hello" })).toMatchObject({ status: "ok", source: "LSP documentSymbols", kind: 12, body: { text: "pub fn hello() {\n    0\n}" } });
  expect(await invoke("read_symbol", dir, { file: "README.md", symbol: "Guide" })).toMatchObject({ status: "ok", source: "LSP documentSymbols", file: "README.md", body: { text: "# Guide" } });
  expect(await invoke("inspect_symbol", dir, { file: "README.md", symbol: "Guide" })).toMatchObject({ status: "ok", source: "LSP documentSymbols", file: "README.md" });
  expect(await invoke("read_symbol", dir, { file: "README.md", symbol: "stale" })).toMatchObject({ status: "partial", source: "LSP documentSymbols", reason: "LSP symbol candidate does not match current source" });
  expect(queried.every((file) => file.startsWith(dir))).toBe(true);
  expect(queried).toContain(path.join(dir, "README.md"));
});

test("LSP name-only symbol ranges stay partial without a complete declaration body", async () => {
  const dir = tempDir();
  const source = "def shared():\n    return 7\n";
  writeFileSync(path.join(dir, "sample.py"), source);
  let range = { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } };
  const selectionRange = { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } };
  bindTestLsp(() => dir, () => ({
    documentSymbols: async () => [{ name: "shared", kind: 12, range, selectionRange }],
  }));

  const nameOnly = await invoke("read_symbol", dir, { file: "sample.py", symbol: "shared" });
  expect(nameOnly).toMatchObject({
    status: "partial",
    source: "LSP documentSymbols",
    range: { start: 1, end: 1, startColumn: 4, endColumn: 10, columnEncoding: "utf-16" },
  });
  expect(typeof nameOnly.reason).toBe("string");
  expect(nameOnly.reason === "LSP symbol range covers only its name; declaration completeness cannot be established").toBe(true);
  expect(nameOnly.body).toBeUndefined();

  const inspected = await invoke("inspect_symbol", dir, { file: "sample.py", symbol: "shared", includeBody: true });
  expect(inspected).toMatchObject({ status: "partial", source: "LSP documentSymbols", range: nameOnly.range });
  expect(inspected.reason).toBe("LSP symbol range covers only its name; declaration completeness cannot be established");
  expect(inspected.body).toBeUndefined();

  range = { start: { line: 0, character: 0 }, end: { line: 1, character: 12 } };
  expect(await invoke("read_symbol", dir, { file: "sample.py", symbol: "shared" })).toMatchObject({
    status: "ok",
    source: "LSP documentSymbols",
    range: { start: 1, end: 2 },
    body: { text: "def shared():\n    return 7", totalLines: 2, truncated: false },
  });
});

test("fileless LSP symbol lookup checks every bounded workspace and verifies current source", async () => {
  const dir = tempDir();
  const packageA = path.join(dir, "pkg-a");
  const packageB = path.join(dir, "pkg-b");
  mkdirSync(path.join(packageA, "src"), { recursive: true });
  mkdirSync(path.join(packageB, "src"), { recursive: true });
  const oneLineA = "export function shared() { return 1; }";
  const oneLineB = "export function shared() { return 2; }";
  writeFileSync(path.join(packageA, "src", "a.ts"), `${oneLineA}\n`);
  writeFileSync(path.join(packageB, "src", "b.ts"), `${oneLineB}\n`);
  writeFileSync(path.join(packageA, "package.json"), "{}");
  writeFileSync(path.join(packageB, "package.json"), "{}");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: dir });
  const queried = new Set<string>();
  let includeSecondMatch = true;
  bindTestLsp(
    (file) => file.startsWith(packageB) ? packageB : packageA,
    (file) => ({
      workspaceSymbols: async () => {
        const root = file.startsWith(packageB) ? packageB : packageA;
        queried.add(root);
        if (root === packageB && !includeSecondMatch) return [];
        const sourceFile = path.join(root, "src", root === packageB ? "b.ts" : "a.ts");
        const oneLine = root === packageB ? oneLineB : oneLineA;
        return [{ name: "shared", kind: 12, location: { uri: pathToFileURL(sourceFile).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: oneLine.length } } } }];
      },
    }),
  );

  const report = await invoke("read_symbol", dir, { symbol: "shared" });
  expect(report).toMatchObject({ status: "ambiguous", source: "LSP workspaceSymbols", total: 2 });
  expect(queried).toEqual(new Set([packageA, packageB]));
  includeSecondMatch = false;
  expect(await invoke("read_symbol", dir, { symbol: "shared" })).toMatchObject({ status: "ok", file: "pkg-a/src/a.ts", body: { text: "export function shared() { return 1; }" } });

  const staleDir = tempDir();
  const staleFile = path.join(staleDir, "stale.ts");
  writeFileSync(staleFile, "export function renamed() { return 1; }\n");
  execFileSync("git", ["init", "-q"], { cwd: staleDir });
  execFileSync("git", ["add", "."], { cwd: staleDir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: staleDir });
  bindTestLsp(() => staleDir, () => ({
    workspaceSymbols: async () => [{ name: "shared", kind: 12, location: { uri: pathToFileURL(staleFile).href, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } } } }],
  }));
  const stale = await invoke("read_symbol", staleDir, { symbol: "shared" });
  expect(stale).toMatchObject({ status: "unavailable", source: "LSP workspaceSymbols" });
  expect(stale.reason).toContain("supply file hint");
});

test("fileless LSP validates name-only and declaration-sized ranges on multiline source", async () => {
  const dir = tempDir();
  const file = path.join(dir, "src", "shared.ts");
  const source = "export function shared() {\n  return 7;\n}\n";
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: dir });
  let range = { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } };
  bindTestLsp(() => dir, () => ({
    workspaceSymbols: async () => [{ name: "shared", kind: 12, location: { uri: pathToFileURL(file).href, range } }],
  }));

  const nameOnly = await invoke("read_symbol", dir, { symbol: "shared" });
  range = { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } };
  const declarationSized = await invoke("read_symbol", dir, { symbol: "shared" });
  expect({ nameOnly, declarationSized }).toMatchObject({
    nameOnly: {
      status: "partial",
      source: "LSP workspaceSymbols",
      reason: "LSP symbol range covers only its name; declaration completeness cannot be established",
    },
    declarationSized: {
      status: "ok",
      source: "LSP workspaceSymbols",
      file: "src/shared.ts",
      range: { start: 1, end: 3 },
      body: { text: "export function shared() {\n  return 7;\n}", totalLines: 3, truncated: false },
    },
  });
  expect(nameOnly.body).toBeUndefined();
  expect(readFileSync(file, "utf8")).toBe(source);
  expect(existsSync(path.join(dir, ".codegraph"))).toBe(false);
});

test("fileless LSP symbol lookup reports a bounded incomplete scan instead of not_found or a guess", async () => {
  const dir = tempDir();
  for (let i = 0; i < 9; i++) writeFileSync(path.join(dir, `file-${i}.ts`), `export function ${i === 0 ? "shared" : `other${i}`}() {}\n`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: dir });
  const firstFile = path.join(dir, "file-0.ts");
  bindTestLsp(() => dir, () => ({
    workspaceSymbols: async () => [{ name: "shared", kind: 12, location: { uri: pathToFileURL(firstFile).href, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } } } }],
  }));

  const report = await invoke("read_symbol", dir, { symbol: "shared" });
  expect(report).toMatchObject({ status: "partial", source: "LSP workspaceSymbols", truncated: true });
  expect(report.reason).toContain("supply file hint");
  expect(report.body).toBeUndefined();
  bindTestLsp(() => dir, () => ({ workspaceSymbols: async () => [] }));
  const missing = await invoke("read_symbol", dir, { symbol: "absent" });
  expect(missing.status).toBe("unavailable");
  expect(missing.status).not.toBe("not_found");
  expect(missing.reason).toContain("supply file hint");
});

test("unsupported AST languages use LSP symbols or report unavailable", async () => {
  const dir = tempDir();
  const unknown = path.join(dir, "sample.unknown");
  writeFileSync(unknown, "function hello() {}\n");
  expect((await invoke("read_enclosing", dir, { file: "sample.unknown", line: 1 })).status).toBe("ambiguous");
  expect((await invoke("module_report", dir, { file: "sample.unknown" })).status).toBe("ambiguous");

  if (findServerForExtension(".rs").status !== "found") return;
  const rustFile = path.join(dir, "src", "lib.rs");
  mkdirSync(path.dirname(rustFile), { recursive: true });
  writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "lsp_symbols_fixture"\nversion = "0.1.0"\nedition = "2021"\n');
  writeFileSync(rustFile, "pub fn hello() {\n    println!(\"hello\");\n}\n");
  const module = await invoke("module_report", dir, { file: "src/lib.rs", language: "Rust" });
  expect(module.source).toBe("LSP documentSymbols");
  expect(module.importsStatus.status).toBe("unavailable");
  expect(module.declarations.some((item: { name?: string }) => item.name === "hello")).toBe(true);
  const enclosing = await invoke("read_enclosing", dir, { file: "src/lib.rs", line: 2, language: "Rust" });
  expect(enclosing.source).toBe("LSP documentSymbols");
  expect(enclosing.name).toBe("hello");

  const slowFile = path.join(dir, "src", "slow.rs");
  writeFileSync(slowFile, "pub fn slow() {}\n");
  const controller = new AbortController();
  const tool = CODE_INTELLIGENCE_TOOLS.find((item) => item.name === "read_enclosing")!;
  const startedAt = Date.now();
  const pending = tool.execute("cancel-lsp", { file: "src/slow.rs", line: 1, language: "Rust" }, controller.signal, () => {}, { cwd: dir });
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  const cancelled = await pending;
  expect(cancelled.isError).toBe(true);
  expect(cancelled.content[0]!.text).toMatch(/abort/i);
  expect(Date.now() - startedAt).toBeLessThan(500);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
});

test("tool execution aborts instead of returning success", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(path.join(dir, "tracked.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: dir });
  const controller = new AbortController();
  const tool = CODE_INTELLIGENCE_TOOLS.find((item) => item.name === "project_report")!;
  const pending = tool.execute("test", {}, controller.signal, () => {}, { cwd: dir });
  controller.abort();
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toMatch(/abort/i);
});

test("review_surface preserves untracked contents when tracked hunks fill the response budget", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  for (let file = 0; file < 16; file++) {
    const source = (offset: number) => Array.from({ length: 40 }, (_, line) => `export const tracked${file}_line${line} = ${line + offset};`).join("\n") + "\n";
    writeFileSync(path.join(dir, `tracked-${file}.ts`), source(0));
  }
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  for (let file = 0; file < 16; file++) {
    const source = (offset: number) => Array.from({ length: 40 }, (_, line) => `export const tracked${file}_line${line} = ${line + offset};`).join("\n") + "\n";
    writeFileSync(path.join(dir, `tracked-${file}.ts`), source(1));
  }
  writeFileSync(path.join(dir, "fresh.ts"), "export const fresh = 1;\n");

  const result = await CODE_INTELLIGENCE_TOOLS.find((item) => item.name === "review_surface")!.execute("large-review", {}, new AbortController().signal, () => {}, { cwd: dir });
  const text = result.content[0]!.text;
  const report = JSON.parse(text);
  const shownUntracked = report.files.filter((item: { change: string }) => item.change === "untracked");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
  expect(report.totalChangedFiles).toBe(17);
  expect(report.untrackedTotal).toBe(1);
  expect(shownUntracked[0]).toMatchObject({ file: "fresh.ts", content: { text: "export const fresh = 1;\n", truncated: false } });
  expect(shownUntracked[0].identityOnly).toBeUndefined();
  expect(report.untrackedShowing).toBe(1);
  expect(report.untrackedIncluded).toBe(true);
  expect(text).toContain("export const fresh");
  const gitPrefix = execFileSync("git", ["diff", "--name-only", "--find-renames", "-z", "HEAD", "--"], { cwd: dir, encoding: "utf8" }).split("\0").filter(Boolean);
  const shownTracked = report.files.filter((item: { change: string }) => item.change !== "untracked").map((item: { file: string }) => item.file);
  expect(shownTracked).toEqual(gitPrefix.slice(0, shownTracked.length));
  expect(report.truncatedFields["$.files"]).toMatchObject({
    totalItems: 17,
    showingItems: report.files.length,
    omittedItems: 17 - report.files.length,
    selection: "prefix plus first untracked file",
    replacedFile: gitPrefix[shownTracked.length],
  });
});

test("review_surface does not retain enclosure markers from a displaced file", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  for (let i = 0; i < 11; i++) writeFileSync(path.join(dir, `a${String(i).padStart(2, "0")}.md`), `before ${i}\n`);
  const replacement = (prefix: string) => Array.from({ length: 200 }, (_, i) => `export const ${prefix}${i} = ${i};`).join("\n") + "\n";
  writeFileSync(path.join(dir, "m-large.ts"), replacement("old"));
  writeFileSync(path.join(dir, "z-extra.md"), "before extra\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  for (let i = 0; i < 11; i++) writeFileSync(path.join(dir, `a${String(i).padStart(2, "0")}.md`), `after ${i}\n`);
  writeFileSync(path.join(dir, "m-large.ts"), replacement("new"));
  writeFileSync(path.join(dir, "z-extra.md"), "after extra\n");
  writeFileSync(path.join(dir, "fresh.ts"), "export const fresh = 1;\n");

  const text = (await CODE_INTELLIGENCE_TOOLS.find((item) => item.name === "review_surface")!.execute("marker-identity", {}, new AbortController().signal, () => {}, { cwd: dir })).content[0]!.text;
  const report = JSON.parse(text);
  const freshIndex = report.files.findIndex((item: { file: string }) => item.file === "fresh.ts");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
  expect(freshIndex).toBeGreaterThanOrEqual(0);
  expect(report.truncatedFields["$.files"]).toMatchObject({ selection: "prefix plus first untracked file", replacedFile: "m-large.ts" });
  expect(report.truncatedFields[`$.files[${freshIndex}].enclosures`]).toBeUndefined();
  for (const [field, marker] of Object.entries(report.truncatedFields) as Array<[string, { totalItems: number; showingItems: number }]>) {
    const match = field.match(/^\$\.files\[(\d+)\]\.enclosures$/);
    if (!match) continue;
    const file = report.files[Number(match[1])];
    expect(file).toBeDefined();
    expect(marker.showingItems).toBe(file.enclosures.length);
    expect(marker.totalItems).toBe(file.lineCoverage.base.selected + file.lineCoverage.worktree.selected);
  }
});

test("review_surface returns bounded contents for untracked text and TypeScript files", async () => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "seed.ts"), "export const seed = 1;\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  const notes = Array.from({ length: 125 }, (_, line) => `safe synthetic note line ${line}`).join("\n") + "\n";
  writeFileSync(path.join(dir, "notes.txt"), notes);
  writeFileSync(path.join(dir, "fresh.ts"), "export const fresh = 1;\n");

  const report = await invoke("review_surface", dir);
  const note = report.files.find((item: { file: string }) => item.file === "notes.txt");
  const source = report.files.find((item: { file: string }) => item.file === "fresh.ts");
  expect(note).toMatchObject({ change: "untracked", content: { totalLines: 126, showingLines: 120, truncated: true } });
  expect(note.content.text).toContain("safe synthetic note line 0");
  expect(note.content.text).not.toContain("safe synthetic note line 124");
  expect(source).toMatchObject({ change: "untracked", content: { text: "export const fresh = 1;\n", truncated: false } });
  expect(source.enclosures.some((item: { name?: string }) => item.name === "fresh")).toBe(true);
});

test("module_report marks local declarations exported through export clauses", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "api.ts"), [
    'import { remote as imported } from "./dependency";',
    "const foo = 1;",
    "function bar() { return 2; }",
    "export { foo, bar as baz };",
    "export default foo;",
    "export { imported };",
    'export { remote as exposed } from "./dependency";',
    "",
  ].join("\n"));

  const report = await invoke("module_report", dir, { file: "api.ts" });
  expect(report.declarations.map((item: { name: string; exported: boolean }) => ({ name: item.name, exported: item.exported }))).toEqual([
    { name: "foo", exported: true },
    { name: "bar", exported: true },
  ]);
});

test("destructuring declarations report only bound identifiers in TypeScript and JavaScript", async () => {
  const dir = tempDir();
  const regularSource = [
    "const { short, sourceKey: localAlias } = source;",
    "const [first,,second] = arr;",
    "export const { directObject, sourceKey: directAlias } = source;",
    "export const [directFirst,,directSecond] = arr;",
    "export { localAlias };",
    "const { nested: { inner: nestedAlias = fallbackValue }, plain = defaultValue, ...rest } = source;",
    "const [withDefault = fallback, ...arrayRest] = arr;",
  ];
  const longSource = ["const {", ...Array.from({ length: 122 }, (_, index) => `  longBound${index},`), "} = source;"].join("\n");
  for (const extension of ["ts", "js"]) {
    const file = `bindings.${extension}`;
    writeFileSync(path.join(dir, file), `${regularSource.join("\n")}\n${longSource}\n`);

    const module = await invoke("module_report", dir, { file });
    expect(module.declarations.map((item: { name: string }) => item.name)).toEqual(["short", "localAlias", "first", "second", "directObject", "directAlias", "directFirst", "directSecond"]);
    expect(module.declarations.map((item: { name: string; exported: boolean }) => [item.name, item.exported])).toEqual([
      ["short", false], ["localAlias", true], ["first", false], ["second", false],
      ["directObject", true], ["directAlias", true], ["directFirst", true], ["directSecond", true],
    ]);
    expect(module).toMatchObject({ declarationsTotal: 135, declarationsShowing: 8, declarationsTruncated: true });
    expect(Buffer.byteLength(JSON.stringify(module))).toBeLessThanOrEqual(12 * 1024);

    for (const name of ["short", "localAlias", "first", "second", "directObject", "directAlias", "directFirst", "directSecond"]) {
      expect((await invoke("read_symbol", dir, { symbol: name, file })).status).toBe("ok");
    }
    expect((await invoke("read_symbol", dir, { symbol: "short", file })).body.text).toBe(regularSource[0]);
    expect((await invoke("read_symbol", dir, { symbol: "localAlias", file })).range).toMatchObject({ start: 1, end: 1 });
    expect((await invoke("read_symbol", dir, { symbol: "first", file })).body.text).toBe(regularSource[1]);
    expect((await invoke("read_symbol", dir, { symbol: "directObject", file })).body.text).toBe(regularSource[2]!.replace(/^export /, ""));
    expect((await invoke("read_symbol", dir, { symbol: "directFirst", file })).body.text).toBe(regularSource[3]!.replace(/^export /, ""));

    const longBinding = await invoke("read_symbol", dir, { symbol: "longBound0", file });
    expect(longBinding).toMatchObject({
      status: "partial", kind: "lexical_declaration",
      range: { start: 8, end: 131 },
      body: { totalLines: 124, showingLines: 120, truncated: true },
    });
    expect(longBinding.body.text).not.toContain("longBound121");
    for (const name of ["nestedAlias", "plain", "rest", "withDefault", "arrayRest"]) {
      expect((await invoke("read_symbol", dir, { symbol: name, file })).status).toBe("ok");
    }
    for (const name of ["sourceKey", "nested", "inner", "fallbackValue", "defaultValue", "fallback", "source", "arr"]) {
      expect((await invoke("read_symbol", dir, { symbol: name, file })).status).toBe("not_found");
    }
  }
});

test("destructured names remain under the module response byte budget", async () => {
  const dir = tempDir();
  const longName = `bound${"x".repeat(13_000)}`;
  writeFileSync(path.join(dir, "large.ts"), `const { ${longName} } = source;\nconst { ${Array.from({ length: 9 }, (_, index) => `cap${index}`).join(", ")} } = source;\n`);

  const result = await CODE_INTELLIGENCE_TOOLS.find((tool) => tool.name === "module_report")!.execute("destructuring-budget", { file: "large.ts" }, new AbortController().signal, () => {}, { cwd: dir });
  const report = JSON.parse(result.content[0]!.text);
  expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(12 * 1024);
  expect(report).toMatchObject({ truncated: true, declarationsTotal: 10, declarationsShowing: 8, declarationsTruncated: true });
});

test("module_report scopes export clauses to the module", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "api.ts"), [
    "const foo = 1;",
    "const ambient = 2;",
    "const nestedDefault = 3;",
    "namespace Nested { const foo = 4; export { foo }; const nestedDefault = 5; export default nestedDefault; }",
    'declare module "other" { const ambient: number; export { ambient }; }',
    "",
  ].join("\n"));

  const report = await invoke("module_report", dir, { file: "api.ts" });
  expect(report.declarations.filter((item: { name: string }) => ["foo", "ambient", "nestedDefault"].includes(item.name)).map((item: { name: string; exported: boolean }) => [item.name, item.exported])).toEqual([
    ["foo", false],
    ["ambient", false],
    ["nestedDefault", false],
  ]);
});

test("module_report distinguishes type-only exports from value exports", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "api.ts"), [
    "class Foo {}",
    "interface Foo { value: number }",
    "export type { Foo };",
    "const baz = 1;",
    "export { type baz };",
    "class Both {}",
    "interface Both { value: number }",
    "export { Both };",
    "",
  ].join("\n"));

  const report = await invoke("module_report", dir, { file: "api.ts" });
  expect(report.declarations.filter((item: { name: string }) => ["Foo", "baz", "Both"].includes(item.name)).map((item: { kind: string; name: string; exported: boolean | null }) => [item.kind, item.name, item.exported])).toEqual([
    ["class_declaration", "Foo", null],
    ["interface_declaration", "Foo", true],
    ["lexical_declaration", "baz", false],
    ["class_declaration", "Both", true],
    ["interface_declaration", "Both", true],
  ]);
});

test("module_report treats keyword-as-alias as a value export", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "alias.ts"), [
    "const type = 1;",
    "const foo = 2;",
    "interface foo { a: number }",
    "export { /* before */ type /* around as */ as /* after as */ foo };",
    "",
  ].join("\n"));

  const report = await invoke("module_report", dir, { file: "alias.ts" });
  expect(report.declarations.map((item: { kind: string; name: string; exported: boolean | null }) => [item.kind, item.name, item.exported])).toEqual([
    ["lexical_declaration", "type", true],
    ["lexical_declaration", "foo", false],
    ["interface_declaration", "foo", false],
  ]);
});

test("module_report treats a bare type keyword as a value export", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "bare.ts"), [
    "const type = 1;",
    "export { /* before */ type /* after */ };",
    "const value = 1;",
    "export { /* before */ type /* modifier */ value };",
    "",
  ].join("\n"));

  const report = await invoke("module_report", dir, { file: "bare.ts" });
  expect(report.declarations.map((item: { name: string; exported: boolean | null }) => [item.name, item.exported])).toEqual([
    ["type", true],
    ["value", false],
  ]);
});

test("module_report honors statement-level type-only keyword exports", async () => {
  const dir = tempDir();
  const cases = [
    {
      source: ["const type = 1;", "export { /* before */ type /* after */ };"],
      expected: [["lexical_declaration", "type", true]],
    },
    {
      source: ["const type = 1;", "const foo = 2;", "interface foo { value: number }", "export { /* before */ type /* around as */ as /* after as */ foo };"],
      expected: [["lexical_declaration", "type", true], ["lexical_declaration", "foo", false], ["interface_declaration", "foo", false]],
    },
    {
      source: ["const type = 1;", "interface type { value: number }", "export type { type };"],
      expected: [["lexical_declaration", "type", false], ["interface_declaration", "type", true]],
    },
    {
      source: ["const type = 1;", "interface type { value: number }", "export type { /* before */ type /* around as */ as /* after as */ foo };"],
      expected: [["lexical_declaration", "type", false], ["interface_declaration", "type", true]],
    },
    {
      source: ["const type = 1;", "interface type { value: number }", 'export type { type as foo } from "./other";'],
      expected: [["lexical_declaration", "type", false], ["interface_declaration", "type", false]],
    },
  ];

  const actual = [];
  for (const [index, example] of cases.entries()) {
    const file = `case-${index}.ts`;
    writeFileSync(path.join(dir, file), `${example.source.join("\n")}\n`);
    const report = await invoke("module_report", dir, { file });
    actual.push(report.declarations.map((item: { kind: string; name: string; exported: boolean | null }) => [item.kind, item.name, item.exported]));
  }
  expect(actual).toEqual(cases.map((example) => example.expected));
});

test("module_report leaves unparseable export clauses unknown", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "unknown.ts"), [
    "const type = 1;",
    "const value = 2;",
    "export { type as };",
    "",
  ].join("\n"));

  const report = await invoke("module_report", dir, { file: "unknown.ts" });
  expect(report.declarations.map((item: { name: string; exported: boolean | null }) => [item.name, item.exported])).toEqual([
    ["type", null],
    ["value", null],
  ]);
});

test("module_report treats abstract classes as class declarations for type-only exports", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "abstract.ts"), [
    "abstract class Abs {}",
    "export type { Abs };",
    "",
  ].join("\n"));

  const report = await invoke("module_report", dir, { file: "abstract.ts" });
  expect(report.declarations.map((item: { kind: string; name: string; exported: boolean | null }) => [item.kind, item.name, item.exported])).toEqual([
    ["abstract_class_declaration", "Abs", null],
  ]);
});

test("module_report includes exported function signatures", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "api.ts"), "export function answer(value: string): number { return value.length; }\n");

  const report = await invoke("module_report", dir, { file: "api.ts" });
  expect(report.declarations.find((item: { name: string }) => item.name === "answer")).toMatchObject({
    kind: "function_declaration",
    exported: true,
    signature: "export function answer(value: string): number",
  });
});
