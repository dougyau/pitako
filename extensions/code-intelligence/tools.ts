import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { createGrepTool } from "@earendil-works/pi-coding-agent";
import { hasLspServerForExtension } from "./lsp.ts";
import { parse, Lang, type SgNode } from "@ast-grep/napi";
import { workspacePath, resolveLanguage, QUERY_BUDGETS, type Language } from "./contracts.ts";
import { canonicalPath } from "../board/paths.ts";
import { graphBuildFailure, withCodeGraph as withGraph, withExistingCodeGraph } from "./graph.ts";
import { lspWorkspaceRoot, queryLsp } from "./lsp.ts";
import { CODE_SOURCES, type CodeSource, type DenseCallUsage, type GraphCallUsage, type SourceUsage, type ToolOutcome } from "./metrics.ts";

const noExtra = { additionalProperties: false } as const;
const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SCAN_FILES = 500;
const MAX_CHANGED_FILES = 32;
const LANG_TO_AST: Record<Language, Lang> = {
  Html: Lang.Html,
  JavaScript: Lang.JavaScript,
  Tsx: Lang.Tsx,
  Css: Lang.Css,
  TypeScript: Lang.TypeScript,
};

type Result = { content: [{ type: "text"; text: string }]; details: Record<string, unknown>; isError?: boolean };
type QueryMetrics = { sources: Partial<Record<CodeSource, SourceUsage>>; graph: GraphCallUsage & { states: Record<string, number> } };
type ToolContext = { cwd: string; queryMetrics?: QueryMetrics; nestedCodeQuery?: boolean };
type Ctx = ToolContext & { signal: AbortSignal; queryMetrics: QueryMetrics };
const errorResult = (error: unknown): Result => ({ content: [{ type: "text", text: `unavailable: ${error instanceof Error ? error.message : String(error)}` }], details: { status: "unavailable" }, isError: true });
function newQueryMetrics(): QueryMetrics {
  return { sources: Object.fromEntries(CODE_SOURCES.map((source) => [source, { calls: 0, durationMs: 0 }])) as Record<CodeSource, SourceUsage>, graph: { states: {}, buildDurations: {}, buildFailures: {}, failures: 0 } };
}
function sourceDuration(metrics: QueryMetrics, source: CodeSource, started: number): void {
  const usage = metrics.sources[source] ??= { calls: 0, durationMs: 0 };
  usage.calls += 1;
  usage.durationMs += Math.round(performance.now() - started);
}
function measure<T>(ctx: Ctx | undefined, source: CodeSource, operation: () => T): T {
  if (!ctx) return operation();
  const started = performance.now();
  try { return operation(); }
  finally { sourceDuration(ctx.queryMetrics, source, started); }
}
async function measureAsync<T>(ctx: Ctx | undefined, source: CodeSource, operation: () => Promise<T>): Promise<T> {
  if (!ctx) return operation();
  const started = performance.now();
  try { return await operation(); }
  finally { sourceDuration(ctx.queryMetrics, source, started); }
}
function isTruncated(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.some(([key, item]) => /truncated$/i.test(key) && item === true) || entries.some(([, item]) => isTruncated(item));
}
function callOutcome(result: Result, signal: AbortSignal): ToolOutcome {
  if (signal.aborted) return "cancelled";
  const status = result.details.status;
  if (status === "partial" || status === "ambiguous") return "partial";
  if (status === "unavailable" || status === "unsupported") return "unavailable";
  if (result.isError) return "error";
  return "ok";
}
function finishTelemetry(result: Result, name: string, started: number, metrics: QueryMetrics, signal: AbortSignal): Result {
  let report: unknown;
  try { report = JSON.parse(result.content.map((part) => part.text).join("\n")); } catch { report = undefined; }
  const call: DenseCallUsage = {
    tool: name as DenseCallUsage["tool"],
    durationMs: Math.round(performance.now() - started),
    outputBytes: Buffer.byteLength(result.content.map((part) => part.text).join("\n")),
    truncated: result.details.truncated === true || isTruncated(report),
    outcome: callOutcome(result, signal),
    sources: metrics.sources,
    graph: metrics.graph,
  };
  return { ...result, details: { ...result.details, codeIntelligence: call } };
}
async function graphQuery<T>(ctx: Ctx, operation: () => Promise<T>): Promise<T> {
  try {
    const result = await measureAsync(ctx, "graph", operation);
    const value = result as { value?: { freshness?: { indexState?: string | null; lifecycle?: { durationMs?: number; buildId?: number } } }; unavailable?: string };
    const failedBuild = graphBuildFailure(result);
    if (failedBuild) {
      const id = String(failedBuild.id);
      ctx.queryMetrics.graph.buildDurations![id] = failedBuild.durationMs;
      ctx.queryMetrics.graph.buildFailures![id] = 1;
    }
    const freshness = value?.value?.freshness;
    const state = freshness ? freshness.indexState ?? "unknown" : value?.unavailable === "index absent" ? "absent" : "unavailable";
    ctx.queryMetrics.graph.state = state;
    ctx.queryMetrics.graph.states[state] = (ctx.queryMetrics.graph.states[state] ?? 0) + 1;
    const lifecycle = freshness?.lifecycle;
    if (lifecycle?.buildId !== undefined) ctx.queryMetrics.graph.buildDurations![String(lifecycle.buildId)] = lifecycle.durationMs ?? 0;
    if (!freshness && state !== "absent" && !ctx.signal.aborted) ctx.queryMetrics.graph.failures += 1;
    return result;
  } catch (error) {
    const state = ctx.signal.aborted ? "cancelled" : "unavailable";
    ctx.queryMetrics.graph.state = state;
    ctx.queryMetrics.graph.states[state] = (ctx.queryMetrics.graph.states[state] ?? 0) + 1;
    if (!ctx.signal.aborted) ctx.queryMetrics.graph.failures += 1;
    throw error;
  }
}
function compactValue(value: unknown, path: string, maxStringBytes: number, maxItems: number, truncatedFields: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) <= maxStringBytes) return value;
    const characters = [...value];
    let shown = "";
    for (const character of characters) {
      if (Buffer.byteLength(shown) + Buffer.byteLength(character) > maxStringBytes) break;
      shown += character;
    }
    truncatedFields[path] = { totalBytes: Buffer.byteLength(value), showingBytes: Buffer.byteLength(shown) };
    return `${shown}…[${Buffer.byteLength(value) - Buffer.byteLength(shown)} bytes omitted]`;
  }
  if (Array.isArray(value)) {
    if (value.length > maxItems) truncatedFields[path] = { totalItems: value.length, showingItems: maxItems };
    return value.slice(0, maxItems).map((item, index) => compactValue(item, `${path}[${index}]`, maxStringBytes, maxItems, truncatedFields));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, compactValue(item, `${path}.${key}`, maxStringBytes, maxItems, truncatedFields)]));
  }
  return value;
}
function selectReviewFiles(files: Record<string, unknown>[], limit: number) {
  const prefix = files.slice(0, limit);
  const firstUntracked = files.find((file) => file.change === "untracked" && typeof file.file === "string");
  const reserve = !!firstUntracked && !prefix.includes(firstUntracked);
  const selected = reserve ? [...files.slice(0, limit - 1), firstUntracked!] : prefix;
  const replacedFile = reserve ? prefix.at(-1)?.file : undefined;
  return {
    files: selected,
    ...(files.length > selected.length ? {
      marker: {
        totalItems: files.length,
        showingItems: selected.length,
        omittedItems: files.length - selected.length,
        ...(reserve ? { selection: "prefix plus first untracked file", ...(typeof replacedFile === "string" ? { replacedFile } : {}) } : {}),
      },
    } : {}),
  };
}
function finalizeReview(view: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  if (!("untrackedTotal" in source)) return view;
  const sourceFiles = Array.isArray(source.files) ? source.files as Array<Record<string, unknown>> : [];
  const identities = new Set(sourceFiles.filter((file) => file.change === "untracked" && typeof file.file === "string").map((file) => file.file as string));
  const files = Array.isArray(view.files) ? view.files as Array<Record<string, unknown>> : [];
  const finalizedFiles = files.map((file) => {
    if (!file.lineCoverage) return file;
    const coverage = file.lineCoverage as Record<string, Record<string, unknown>>;
    const enclosures = Array.isArray(file.enclosures) ? file.enclosures as Array<Record<string, unknown>> : [];
    return {
      ...file,
      lineCoverage: Object.fromEntries((["base", "worktree"] as const).map((side) => [side, {
        ...coverage[side],
        showing: enclosures.filter((enclosure) => enclosure.side === side).length,
      }])),
    };
  });
  const shown = new Map(finalizedFiles.filter((file) => file.change === "untracked" && typeof file.file === "string" && identities.has(file.file)).map((file) => [file.file as string, file]));
  const untrackedTotal = Number(source.untrackedTotal);
  const untrackedShowing = shown.size;
  const untrackedIncluded = identities.size === untrackedTotal && untrackedShowing === untrackedTotal && [...identities].every((file) => {
    const content = shown.get(file)?.content;
    return !!content && typeof content === "object" && typeof (content as Record<string, unknown>).text === "string";
  });
  return { ...view, files: finalizedFiles, untrackedShowing, untrackedIncluded };
}
const output = (report: Record<string, unknown>): Result => {
  const truncated = isTruncated(report);
  const status = truncated && report.status === "ok" ? "partial" : report.status ?? "ok";
  const boundedReport = { ...report, status, truncated: truncated || report.truncated === true };
  const finalizedReport = finalizeReview(boundedReport, boundedReport);
  const rendered = JSON.stringify(finalizedReport, null, 2);
  const originalBytes = Buffer.byteLength(rendered);
  if (originalBytes <= QUERY_BUDGETS.responseBytes) {
    return { content: [{ type: "text", text: rendered }], details: { truncated, status } };
  }
  const counts = Object.fromEntries(Object.entries(finalizedReport).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, (value as unknown[]).length]));
  const allFiles = Array.isArray(finalizedReport.files) ? finalizedReport.files as Array<Record<string, unknown>> : [];
  let maxStringBytes = 2048;
  let maxItems = 12;
  for (let attempt = 0; attempt < 12; attempt++) {
    const truncatedFields: Record<string, unknown> = {};
    const selection = "untrackedTotal" in finalizedReport ? selectReviewFiles(allFiles, maxItems) : undefined;
    if (selection?.marker) truncatedFields["$.files"] = selection.marker;
    const attemptReport = selection ? { ...finalizedReport, files: selection.files } : finalizedReport;
    const compact = compactValue(attemptReport, "$", maxStringBytes, maxItems, truncatedFields) as Record<string, unknown>;
    const finalizedCompact = finalizeReview(compact, finalizedReport);
    const compactStatus = finalizedCompact.status === "ok" ? "partial" : finalizedCompact.status;
    const limited = JSON.stringify({ ...finalizedCompact, status: compactStatus, truncated: true, originalBytes, limitBytes: QUERY_BUDGETS.responseBytes, counts, truncatedFields }, null, 2);
    if (Buffer.byteLength(limited) <= QUERY_BUDGETS.responseBytes) {
      return { content: [{ type: "text", text: limited }], details: { truncated: true, status: compactStatus } };
    }
    maxStringBytes = Math.max(32, Math.floor(maxStringBytes / 2));
    maxItems = Math.max(1, Math.floor(maxItems / 2));
  }
  const limited = JSON.stringify({ status: status === "ok" ? "partial" : status, truncated: true, originalBytes, limitBytes: QUERY_BUDGETS.responseBytes, counts, ...("untrackedTotal" in finalizedReport ? { totalChangedFiles: finalizedReport.totalChangedFiles, untrackedTotal: finalizedReport.untrackedTotal, untrackedShowing: 0, untrackedIncluded: finalizedReport.untrackedTotal === 0, files: [] } : {}) });
  return { content: [{ type: "text", text: limited }], details: { truncated: true, status: status === "ok" ? "partial" : status } };
};
function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}
function abortable<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
async function runGit(args: string[], cwd: string, signal: AbortSignal, timeout: number, maxBuffer: number, ctx?: Ctx): Promise<string> {
  return measureAsync(ctx, "git", async () => {
    throwIfAborted(signal);
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout, maxBuffer, signal });
    throwIfAborted(signal);
    return stdout;
  });
}
async function resolveReviewTree(base: string, cwd: string, signal: AbortSignal, ctx: Ctx): Promise<string> {
  return measureAsync(ctx, "git", async () => {
    throwIfAborted(signal);
    try {
      const { stdout, stderr } = await execFileAsync("git", ["-c", "core.warnAmbiguousRefs=true", "rev-parse", "--verify", "--end-of-options", `${base}^{tree}`], { cwd, encoding: "utf8", timeout: 3000, maxBuffer: 512 * 1024, signal });
      throwIfAborted(signal);
      const tree = stdout.trim();
      if (stderr !== "" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(tree)) throw new Error();
      return tree;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error("git ref could not be resolved unambiguously to a tree");
    }
  });
}
async function workspaceRoot(cwd: string, signal: AbortSignal, ctx?: Ctx): Promise<string> {
  try { return canonicalPath((await runGit(["rev-parse", "--show-toplevel"], cwd, signal, 1500, 256 * 1024, ctx)).trim()); }
  catch (error) { if (signal.aborted) throw error; return canonicalPath(cwd); }
}
async function lspQuery<T>(ctx: Ctx, file: string, operation: "diagnostics" | "references" | "documentSymbols" | "workspaceSymbols", run: (client: any) => Promise<T>): Promise<T> {
  return queryLsp(file, ctx.signal, operation, run);
}
async function documentSymbols(file: string, ctx: Ctx): Promise<{ symbols?: any[]; reason?: string }> {
  try {
    const symbols = await lspQuery<any[]>(ctx, file, "documentSymbols", (client) => measureAsync(ctx, "lsp", () => client.documentSymbols(file)));
    const flattened: any[] = [];
    const visit = (items: any[]) => items.forEach((item) => {
      if (item && typeof item.name === "string" && item.range) {
        flattened.push(item);
        visit(item.children ?? []);
      } else if (item && typeof item.name === "string" && item.location?.range) {
        flattened.push({ ...item, range: item.location.range });
      }
    });
    visit(symbols);
    return { symbols: flattened };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return { reason: String(error) };
  }
}
function comparePosition(a: { line: number; character: number }, b: { line: number; character: number }): number {
  return a.line - b.line || a.character - b.character;
}
function lspRangeIntersectsLine(range: any, line: number): boolean {
  return range.start.line <= line && (range.end.line > line || (range.end.line === line && range.end.character > 0));
}
function lspRange(range: any) {
  return { start: range.start.line + 1, end: range.end.line + 1, startColumn: range.start.character, endColumn: range.end.character, columnEncoding: "utf-16" };
}
function sourceBody(source: string, startLine: number, endLine: number) {
  const lines = source.split(/\r?\n/).slice(startLine, endLine + 1);
  const showingLines = Math.min(lines.length, QUERY_BUDGETS.sourceLines);
  const start = lineStartIndex(source, startLine);
  const end = lineStartIndex(source, startLine + showingLines);
  const text = source.slice(start, end).replace(/\r?\n$/, "");
  return { text, totalLines: lines.length, showingLines, truncated: lines.length > QUERY_BUDGETS.sourceLines };
}
function lspRangeText(source: string, range: any): string {
  const start = lineStartIndex(source, range.start.line) + range.start.character;
  const end = lineStartIndex(source, range.end.line) + range.end.character;
  return source.slice(start, end);
}
function sourceContent(source: string) {
  const lines = source.split(/\r?\n/);
  return { text: source.split(/(?<=\n)/).slice(0, QUERY_BUDGETS.sourceLines).join(""), totalLines: lines.length, showingLines: Math.min(lines.length, QUERY_BUDGETS.sourceLines), truncated: lines.length > QUERY_BUDGETS.sourceLines };
}
function graphFileConsumers(g: any, relative: string) {
  const fileNode = g.getNodesInFile(relative).find((node: any) => node.kind === "file");
  if (!fileNode) return { status: "unavailable", reason: "indexed file node absent", consumers: null };
  if (typeof g.getFileDependents !== "function") return { status: "unavailable", reason: "CodeGraph file dependents API unavailable", consumers: null };
  const all = [...new Set(g.getFileDependents(relative) as string[])];
  const truncated = all.length > QUERY_BUDGETS.relations;
  return {
    status: truncated ? "partial" : "available",
    source: "CodeGraph resolved cross-file dependencies",
    scope: "resolved graph edges; unresolved imports are not included",
    consumers: all.slice(0, QUERY_BUDGETS.relations).map((file) => ({ file })),
    total: all.length,
    truncated,
  };
}
async function moduleGraph(root: string, file: string, ctx: Ctx) {
  const relative = path.relative(root, file);
  const graph = await graphQuery(ctx, () => withGraph(root, ctx.signal, (g) => graphFileConsumers(g, relative)));
  return graph.value ?? { status: "unavailable", reason: graph.unavailable, consumers: null };
}
function sourceFor(root: string, input: string): { file: string; source: string } {
  const file = workspacePath(root, input);
  const info = statSync(file);
  if (!info.isFile()) throw new Error("file must be a regular file");
  if (info.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte query limit`);
  return { file, source: readFileSync(file, "utf8") };
}
function lspLanguageResolution(file: string, requested?: string) {
  const resolution = resolveLanguage(file, requested);
  if (resolution.status !== "ambiguous") return resolution;
  const extension = path.extname(file).toLowerCase();
  return extension && hasLspServerForExtension(extension)
    ? { status: "unsupported" as const, requested: extension.slice(1) }
    : resolution;
}
function languageProblem(file: string, requested: string | undefined, symbol: string, root: string): Result | undefined {
  const language = resolveLanguage(file, requested);
  if (language.status === "resolved") return undefined;
  return output({
    status: language.status,
    symbol,
    file: path.relative(root, file),
    languageResolution: language,
    ...(language.status === "ambiguous" ? { candidates: language.candidates.map((candidate) => ({ language: candidate })) } : {}),
    reason: language.status === "ambiguous" ? "specify a language" : `unsupported language: ${language.requested}`,
  });
}
function currentLspSymbolRange(symbol: any, source: string, name: string): any | undefined {
  const range = symbol.range;
  const selected = symbol.selectionRange ?? range;
  if (!range?.start || !range?.end || !selected?.start || !selected?.end || comparePosition(range.start, range.end) > 0) return undefined;
  if (!lspRangeText(source, range).includes(name)) return undefined;
  if (lspRangeText(source, selected) === name) return range;
  if (!symbol.selectionRange) return range;
  return undefined;
}
async function lspSymbolResult(file: string, source: string, symbol: string, root: string, resolution: Extract<ReturnType<typeof lspLanguageResolution>, { status: "unsupported" }>, ctx: Ctx, includeBody: boolean): Promise<Result> {
  const lsp = await documentSymbols(file, ctx);
  const relative = path.relative(root, file);
  const lspRoot = await lspWorkspaceRoot(file);
  if (!lsp.symbols) return output({ status: "unavailable", symbol, file: relative, languageResolution: resolution, source: "LSP documentSymbols", lspWorkspaceRoot: lspRoot ?? null, reason: lsp.reason });
  const named = lsp.symbols.filter((candidate) => candidate.name === symbol);
  const candidates = named.flatMap((candidate) => {
    const range = currentLspSymbolRange(candidate, source, symbol);
    return range ? [{ candidate, range }] : [];
  });
  const shown = candidates.slice(0, QUERY_BUDGETS.candidates);
  if (candidates.length !== 1) {
    const status = candidates.length > 1 ? "ambiguous" : named.length ? "partial" : "not_found";
    return output({ status, symbol, file: relative, languageResolution: resolution, source: "LSP documentSymbols", lspWorkspaceRoot: lspRoot ?? null, total: candidates.length, candidates: shown.map(({ candidate, range }) => ({ kind: candidate.kind, range: lspRange(range) })), truncated: candidates.length > shown.length, ...(named.length && !candidates.length ? { reason: "LSP symbol candidate does not match current source" } : {}) });
  }
  const match = candidates[0]!;
  const nameOnlyRange = lspRangeText(source, match.range) === symbol;
  return output({ status: nameOnlyRange ? "partial" : "ok", symbol, file: relative, language: resolution.requested, languageResolution: resolution, source: "LSP documentSymbols", lspWorkspaceRoot: lspRoot ?? null, kind: match.candidate.kind, range: lspRange(match.range), ...(nameOnlyRange ? { reason: "LSP symbol range covers only its name; declaration completeness cannot be established" } : {}), ...(includeBody && !nameOnlyRange ? { body: sourceBody(source, match.range.start.line, match.range.end.line) } : {}) });
}
function ast(file: string, source: string, requested: string | undefined, ctx: Ctx) {
  const language = resolveLanguage(file, requested);
  if (language.status !== "resolved") throw new Error(`${language.status} language: ${JSON.stringify(language)}`);
  return { language: language.language, root: measure(ctx, "ast", () => parse(LANG_TO_AST[language.language], source).root()) };
}
function descendants(root: SgNode): SgNode[] {
  const result: SgNode[] = [];
  const stack = [...root.children()].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    result.push(node);
    stack.push(...node.children().reverse());
  }
  return result;
}
function location(node: SgNode, source: string) {
  const range = node.range();
  return {
    start: range.start.line + 1,
    end: range.end.line + 1,
    startColumn: range.start.column,
    endColumn: range.end.column,
    columnEncoding: "utf-16",
    startByte: Buffer.byteLength(source.slice(0, range.start.index)),
    endByte: Buffer.byteLength(source.slice(0, range.end.index)),
  };
}
function lspPosition(node: SgNode) {
  const range = node.range();
  return { line: range.start.line + 1, character: range.start.column };
}
function body(node: SgNode, source: string, limit = QUERY_BUDGETS.sourceLines) {
  const range = node.range();
  const value = source.slice(range.start.index, range.end.index);
  const lines = value.split(/\r?\n/);
  const shown = lines.length > limit ? value.split(/(?<=\n)/).slice(0, limit).join("") : value;
  return { text: shown, totalLines: lines.length, showingLines: Math.min(lines.length, limit), truncated: lines.length > limit };
}
function lineStartIndex(source: string, zeroBasedLine: number): number {
  let offset = 0;
  for (let line = 0; line < zeroBasedLine; line++) {
    const next = source.indexOf("\n", offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return offset;
}
function isDeclaration(node: SgNode): boolean {
  return /(?:declaration|definition|signature)$/.test(String(node.kind()));
}
function bindingNameNodes(pattern: SgNode): SgNode[] {
  const kind = String(pattern.kind());
  if (kind === "identifier" || kind === "type_identifier" || kind === "shorthand_property_identifier_pattern") return [pattern];
  if (kind === "pair_pattern") {
    const value = pattern.field("value");
    return value ? bindingNameNodes(value) : [];
  }
  if (kind === "assignment_pattern" || kind === "object_assignment_pattern") {
    const left = pattern.field("left");
    return left ? bindingNameNodes(left) : [];
  }
  if (kind === "rest_pattern") {
    const argument = pattern.children().filter((child) => child.kind() !== "comment").at(-1);
    return argument ? bindingNameNodes(argument) : [];
  }
  return kind === "object_pattern" || kind === "array_pattern"
    ? pattern.children().flatMap(bindingNameNodes)
    : [];
}
function declarationNameNodes(node: SgNode): SgNode[] {
  const declarations = node.kind() === "lexical_declaration" || node.kind() === "variable_declaration"
    ? node.children().filter((child) => child.kind() === "variable_declarator")
    : [node];
  return declarations.flatMap((declaration) => {
    const name = declaration.field("name");
    return name && /identifier|type_identifier/.test(String(name.kind()))
      ? [name]
      : name ? bindingNameNodes(name) : [];
  });
}
function declarationNames(node: SgNode): string[] {
  return declarationNameNodes(node).map((name) => name.text());
}
function declarationSignature(node: SgNode, source: string): string | undefined {
  if (!/function|method/.test(String(node.kind()))) return undefined;
  const parent = node.parent();
  const start = parent?.kind() === "export_statement" ? parent.range().start.index : node.range().start.index;
  return source.slice(start, node.field("body")?.range().start.index ?? node.range().end.index).trim();
}
function declarationNameNode(node: SgNode, symbol: string): SgNode | undefined {
  return declarationNameNodes(node).find((name) => name.text() === symbol);
}
function namedCandidates(root: SgNode, symbol: string) {
  return descendants(root).filter((node) => isDeclaration(node) && declarationNames(node).includes(symbol));
}
function lineEnclosure(declarations: SgNode[], source: string, line: number) {
  const start = lineStartIndex(source, line - 1);
  const end = lineStartIndex(source, line);
  return declarations.filter((node) => node.range().start.index < end && node.range().end.index > start)
    .sort((a, b) => a.range().end.index - a.range().start.index - (b.range().end.index - b.range().start.index))[0];
}
function tool(name: string, description: string, properties: Record<string, any>, handler: (params: any, ctx: Ctx) => Promise<Result>) {
  return {
    name, label: name, description, parameters: Type.Object(properties, noExtra),
    async execute(_id: string, params: any, signal: AbortSignal, _update: unknown, ctx: ToolContext) {
      const started = performance.now();
      const nested = ctx.nestedCodeQuery === true;
      const queryMetrics = ctx.queryMetrics ?? newQueryMetrics();
      let result: Result;
      try {
        throwIfAborted(signal);
        result = await handler(params, { ...ctx, signal, queryMetrics });
        throwIfAborted(signal);
      } catch (error) {
        result = errorResult(error);
      }
      return nested ? result : finishTelemetry(result, name, started, queryMetrics, signal);
    },
  };
}

export const project_report = tool("project_report", "Bounded project, worktree and available code-intelligence summary.", {}, async (_p, ctx) => {
  const root = await workspaceRoot(ctx.cwd, ctx.signal, ctx);
  const git = (args: string[]) => runGit(args, root, ctx.signal, 1500, 256 * 1024, ctx).then((text) => text.trim());
  let gitState: Record<string, unknown>;
  try {
    const status = await git(["status", "--porcelain=v1", "--untracked-files=normal"]);
    gitState = { root: await git(["rev-parse", "--show-toplevel"]), status: status.split("\n").filter(Boolean).slice(0, 40), truncated: status.split("\n").filter(Boolean).length > 40 };
  } catch (error) { if (ctx.signal.aborted) throw error; gitState = { unavailable: String(error) }; }
  let trackedFiles: string[] = [];
  try { trackedFiles = (await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean); } catch (error) { if (ctx.signal.aborted) throw error; /* project report still returns git status */ }
  const files = trackedFiles.slice(0, MAX_SCAN_FILES);
  const manifests = files.filter((f) => ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"].includes(path.basename(f))).slice(0, 20);
  const packageData = manifests.filter((f) => path.basename(f) === "package.json").slice(0, 8).map((f) => {
    try { const pkg = JSON.parse(readFileSync(workspacePath(root, f), "utf8")); return { file: f, name: pkg.name, scripts: pkg.scripts ?? {} }; } catch { return { file: f, status: "unreadable" }; }
  });
  const graph = await graphQuery(ctx, () => withExistingCodeGraph(root, ctx.signal, (g) => ({ indexedFiles: g.getFiles().length })));
  const freshness = graph.value?.freshness;
  const graphReady = freshness?.indexState === "complete" && !freshness.engineStale && !Object.values(freshness.changedFiles).some((items) => items.length > 0);
  const graphReport = graph.value
    ? { ...graph.value, status: graphReady ? "available" : "partial" }
    : { status: "unavailable", reason: graph.unavailable };
  return output({ status: "ok", workspace: root, git: gitState, scannedFiles: files.length, scanTruncated: trackedFiles.length > MAX_SCAN_FILES, languages: [...new Set(files.map((f) => path.extname(f).toLowerCase()).filter(Boolean))].sort().slice(0, 40), manifests, packages: packageData, testLocations: files.filter((f) => /(^|\/)(test|tests|__tests__|spec)(\/|\.)|\.(test|spec)\./i.test(f)).slice(0, 40), sources: { ast: "@ast-grep/napi installed", textSearch: "Pi grep", lsp: "per-file; not probed", graph: graphReport } });
});

export const read_symbol = tool("read_symbol", "Read a unique bounded symbol definition; ambiguity is reported, never guessed.", { symbol: Type.String(), file: Type.Optional(Type.String()), language: Type.Optional(Type.String()) }, async (p, ctx) => {
  const rootPath = await workspaceRoot(ctx.cwd, ctx.signal, ctx);
  if (!p.file) {
    const graph = await graphQuery(ctx, () => withGraph(rootPath, ctx.signal, (g) => {
      const candidates = g.getNodesByName(p.symbol);
      return { total: candidates.length, candidates: candidates.slice(0, QUERY_BUDGETS.candidates).map((n: any) => ({ file: n.filePath, kind: n.kind, range: { start: n.startLine, end: n.endLine } })) };
    }));
    if (!graph.value) {
      let sourceFiles: string[] = [];
      let sourceListError: string | undefined;
      try { sourceFiles = (await runGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], rootPath, ctx.signal, 1500, 256 * 1024, ctx)).split("\0").filter((f) => resolveLanguage(f).status === "resolved"); }
      catch (error) { if (ctx.signal.aborted) throw error; sourceListError = String(error); }
      const boundedFiles = sourceFiles.slice(0, QUERY_BUDGETS.candidates);
      const scanTruncated = sourceFiles.length > boundedFiles.length;
      if (!boundedFiles.length) return output({ status: "unavailable", reason: `${graph.unavailable}; LSP unavailable (${sourceListError ?? "no bounded candidate file"}); supply file hint` });

      const workspaces = new Map<string, { file: string; root?: string }>();
      for (const relative of boundedFiles) {
        const file = workspacePath(rootPath, relative);
        const root = await lspWorkspaceRoot(file);
        const key = root ?? file;
        if (!workspaces.has(key)) workspaces.set(key, { file, root });
      }
      const workspaceMatches: Array<{ candidate: any; root?: string }> = [];
      let lspFailure: string | undefined;
      for (const { file, root } of workspaces.values()) {
        try {
          const symbols = await lspQuery<any[]>(ctx, file, "workspaceSymbols", (client) => measureAsync(ctx, "lsp", () => client.workspaceSymbols(p.symbol)));
          workspaceMatches.push(...symbols.filter((candidate) => candidate?.name === p.symbol).map((candidate) => ({ candidate, root })));
        } catch (error) { if (ctx.signal.aborted) throw error; lspFailure = String(error); }
      }

      const matches: Array<{ candidate: any; file: string; source: string; root?: string; range: any; nameOnly: boolean }> = [];
      const seen = new Set<string>();
      let sourceVerificationFailed = false;
      for (const { candidate, root } of workspaceMatches) {
        const uri = candidate.location?.uri;
        const range = candidate.location?.range;
        if (typeof uri !== "string" || !range?.start || !range?.end) { sourceVerificationFailed = true; continue; }
        const key = `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const file = workspacePath(rootPath, fileURLToPath(uri));
          const source = sourceFor(rootPath, file).source;
          const currentRange = currentLspSymbolRange({ range }, source, p.symbol);
          if (!currentRange) { sourceVerificationFailed = true; continue; }
          matches.push({ candidate, file, source, root, range: currentRange, nameOnly: lspRangeText(source, currentRange) === p.symbol });
        } catch (error) { if (ctx.signal.aborted) throw error; sourceVerificationFailed = true; }
      }

      const incomplete = scanTruncated || lspFailure !== undefined || sourceVerificationFailed;
      const shown = matches.slice(0, QUERY_BUDGETS.candidates);
      const truncated = incomplete || matches.length > shown.length;
      if (matches.length !== 1 || incomplete) {
        const status = matches.length > 1 ? "ambiguous" : incomplete ? matches.length ? "partial" : "unavailable" : "not_found";
        const reason = status === "ambiguous"
          ? "symbol has multiple current LSP locations; supply file hint"
          : status === "not_found" ? undefined : `LSP workspace scan could not establish global uniqueness${lspFailure ? ` (${lspFailure})` : ""}; supply file hint`;
        return output({ status, reason, source: "LSP workspaceSymbols", lspWorkspaceRoot: workspaces.size === 1 ? [...workspaces.values()][0]!.root ?? null : null, total: matches.length, candidates: shown.map(({ candidate }) => ({ name: candidate.name, uri: candidate.location.uri, line: candidate.location.range.start.line + 1 })), truncated });
      }
      const match = matches[0]!;
      const range = match.range;
      const location = { start: range.start.line + 1, end: range.end.line + 1, startColumn: range.start.character, endColumn: range.end.character };
      if (match.nameOnly) return output({ status: "partial", symbol: p.symbol, file: path.relative(rootPath, match.file), kind: match.candidate.kind, range: location, reason: "LSP symbol range covers only its name; declaration completeness cannot be established", source: "LSP workspaceSymbols", lspWorkspaceRoot: match.root ?? null });
      return output({ status: "ok", symbol: p.symbol, file: path.relative(rootPath, match.file), kind: match.candidate.kind, range: location, body: sourceBody(match.source, range.start.line, range.end.line), source: "LSP workspaceSymbols", lspWorkspaceRoot: match.root ?? null });
    }
    const candidates = graph.value.candidates;
    if (graph.value.total !== 1 || candidates.length !== 1) {
      const changed = Object.values(graph.value.freshness.changedFiles as Record<string, string[]>).some((files) => files.length > 0);
      const status = graph.value.total ? "ambiguous" : graph.value.freshness.engineStale || changed ? "partial" : "not_found";
      return output({ status, reason: status === "partial" ? "index may not cover current source" : undefined, candidates, total: graph.value.total, truncated: graph.value.total > candidates.length, graphFreshness: graph.value.freshness });
    }
    const candidate = candidates[0]!;
    const { file, source } = sourceFor(rootPath, candidate.file);
    const languageIssue = languageProblem(file, p.language, p.symbol, rootPath);
    if (languageIssue) return languageIssue;
    const { language, root } = ast(file, source, p.language, ctx);
    const matches = namedCandidates(root, p.symbol);
    if (matches.length !== 1) return output({ status: "partial", reason: "graph candidate does not resolve uniquely in current source", file: candidate.file, graphFreshness: graph.value.freshness });
    return output({ status: "ok", symbol: p.symbol, file: candidate.file, kind: matches[0]!.kind(), language, range: location(matches[0]!, source), body: body(matches[0]!, source), source: "AST-confirmed CodeGraph candidate", graphFreshness: graph.value.freshness });
  }
  const { file, source } = sourceFor(rootPath, p.file);
  const resolution = lspLanguageResolution(file, p.language);
  if (resolution.status === "unsupported") {
    if (p.language !== undefined && resolveLanguage(file).status === "resolved") return languageProblem(file, p.language, p.symbol, rootPath)!;
    return lspSymbolResult(file, source, p.symbol, rootPath, resolution, ctx, true);
  }
  if (resolution.status === "ambiguous") return languageProblem(file, p.language, p.symbol, rootPath)!;
  const { language, root } = ast(file, source, p.language, ctx);
  const candidates = namedCandidates(root, p.symbol);
  if (candidates.length !== 1) return output({ status: candidates.length ? "ambiguous" : "not_found", candidates: candidates.slice(0, QUERY_BUDGETS.candidates).map((node) => ({ kind: node.kind(), ...location(node, source) })), total: candidates.length, truncated: candidates.length > QUERY_BUDGETS.candidates, hint: candidates.length ? "supply a narrower file" : undefined, language });
  const node = candidates[0]!;
  return output({ status: "ok", symbol: p.symbol, file: path.relative(rootPath, file), kind: node.kind(), range: location(node, source), body: body(node, source) });
});

export const read_enclosing = tool("read_enclosing", "Read the smallest named AST declaration enclosing a 1-based line and optional 0-based UTF-16 character.", { file: Type.String(), line: Type.Integer({ minimum: 1 }), character: Type.Optional(Type.Integer({ minimum: 0 })), language: Type.Optional(Type.String()) }, async (p, ctx) => {
  const rootPath = await workspaceRoot(ctx.cwd, ctx.signal, ctx);
  const { file, source } = sourceFor(rootPath, p.file);
  const lines = source.split("\n");
  const selected = lines[p.line - 1]?.replace(/\r$/, "");
  if (p.line > lines.length || selected === undefined || (p.character !== undefined && p.character > selected.length)) throw new Error("position is outside source");
  const resolution = lspLanguageResolution(file, p.language);
  if (resolution.status === "ambiguous") return output({ status: "ambiguous", file: path.relative(rootPath, file), languageResolution: resolution, source: "language resolution", reason: "specify a language before using LSP fallback" });
  if (resolution.status === "unsupported") {
    const lsp = await documentSymbols(file, ctx);
    const lspRoot = await lspWorkspaceRoot(file);
    if (!lsp.symbols) return output({ status: "unavailable", file: path.relative(rootPath, file), languageResolution: resolution, source: "LSP documentSymbols", lspWorkspaceRoot: lspRoot ?? null, reason: lsp.reason });
    const line = p.line - 1;
    const point = { line, character: p.character ?? 0 };
    const candidates = lsp.symbols.filter((symbol) => p.character === undefined
      ? lspRangeIntersectsLine(symbol.range, line)
      : comparePosition(symbol.range.start, point) <= 0 && comparePosition(point, symbol.range.end) < 0)
      .sort((a, b) => (a.range.end.line - a.range.start.line) * 1_000_000 + a.range.end.character - a.range.start.character - ((b.range.end.line - b.range.start.line) * 1_000_000 + b.range.end.character - b.range.start.character));
    const symbol = candidates[0];
    return output(symbol
      ? { status: "ok", file: path.relative(rootPath, file), language: resolution.requested, languageResolution: resolution, source: "LSP documentSymbols", lspWorkspaceRoot: lspRoot ?? null, name: symbol.name, kind: symbol.kind, range: lspRange(symbol.range), body: sourceBody(source, symbol.range.start.line, symbol.range.end.line) }
      : { status: "not_found", file: path.relative(rootPath, file), languageResolution: resolution, source: "LSP documentSymbols", lspWorkspaceRoot: lspRoot ?? null, reason: "position is not inside an LSP document symbol" });
  }
  const { language, root } = ast(file, source, p.language, ctx);
  const declarations = descendants(root).filter(isDeclaration);
  let candidates: SgNode[];
  if (p.character === undefined) {
    const enclosing = lineEnclosure(declarations, source, p.line);
    candidates = enclosing ? [enclosing] : [];
  } else {
    const sourceIndex = lineStartIndex(source, p.line - 1) + p.character;
    candidates = declarations.filter((node) => {
      const r = node.range();
      return sourceIndex >= r.start.index && sourceIndex < r.end.index;
    }).sort((a, b) => a.range().end.index - a.range().start.index - (b.range().end.index - b.range().start.index));
  }
  const node = candidates[0];
  return output(node ? { status: "ok", file: path.relative(rootPath, file), language, kind: node.kind(), range: location(node, source), body: body(node, source) } : { status: "not_found", file: path.relative(rootPath, file), language, reason: "position is not inside a named declaration" });
});

export const module_report = tool("module_report", "Bounded syntax-based module exports, imports and declarations.", { file: Type.String(), language: Type.Optional(Type.String()) }, async (p, ctx) => {
  const rootPath = await workspaceRoot(ctx.cwd, ctx.signal, ctx);
  const { file, source } = sourceFor(rootPath, p.file);
  const resolution = lspLanguageResolution(file, p.language);
  if (resolution.status === "ambiguous") return output({ status: "ambiguous", file: path.relative(rootPath, file), languageResolution: resolution, source: "language resolution", reason: "specify a language before using LSP fallback" });
  if (resolution.status === "unsupported") {
    const lsp = await documentSymbols(file, ctx);
    const lspRoot = await lspWorkspaceRoot(file);
    if (!lsp.symbols) return output({ status: "unavailable", file: path.relative(rootPath, file), languageResolution: resolution, source: "LSP documentSymbols", lspWorkspaceRoot: lspRoot ?? null, reason: lsp.reason });
    const declarations = lsp.symbols.slice(0, QUERY_BUDGETS.candidates).map((symbol) => ({ kind: String(symbol.kind), name: symbol.name, range: lspRange(symbol.range), exported: null }));
    const graph = await moduleGraph(rootPath, file, ctx);
    return output({ status: "partial", file: path.relative(rootPath, file), language: resolution.requested, languageResolution: resolution, source: "LSP documentSymbols", lspWorkspaceRoot: lspRoot ?? null, imports: [], importsTotal: 0, importsShowing: 0, importsTruncated: false, importsStatus: { status: "unavailable", reason: "documentSymbols does not provide import declarations" }, declarations, declarationsTotal: lsp.symbols.length, declarationsShowing: declarations.length, declarationsTruncated: lsp.symbols.length > declarations.length, graph });
  }
  const { language, root } = ast(file, source, p.language, ctx);
  const nodes = descendants(root);
  const importNodes = nodes.filter((n) => /import_statement|import_declaration/.test(String(n.kind())));
  const imports = importNodes.slice(0, QUERY_BUDGETS.relations).map((n) => n.text().slice(0, 300));
  const importsTruncated = importNodes.length > imports.length || imports.some((text, index) => text.length < importNodes[index]!.text().length);
  const exportedNames = new Set<string>();
  const typeOnlyExportedNames = new Set<string>();
  let hasUnknownExportClause = false;
  const hasTypeModifier = (node: SgNode) => node.children().some((child) => child.kind() === "type");
  const isBareTypeError = (node: SgNode) => node.kind() === "ERROR" && node.text() === "type" && node.children().length === 1 && node.children()[0]!.kind() === "type";
  const isTypeAsAliasError = (node: SgNode) => {
    const children = node.children().filter((child) => child.kind() !== "comment");
    const as = children[1];
    return children.length === 3 && children[0]!.kind() === "type" && as?.kind() === "ERROR" && as.text() === "as"
      && as.children().length === 1 && as.children()[0]!.kind() === "identifier" && as.children()[0]!.text() === "as"
      && children[2]!.kind() === "identifier";
  };
  const isIncompleteTypeAsAlias = (node: SgNode) => {
    const children = node.children().filter((child) => child.kind() !== "comment");
    return children.length === 2 && children[0]!.kind() === "type" && children[1]!.kind() === "identifier" && children[1]!.text() === "as";
  };
  for (const node of nodes) {
    if (node.kind() === "export_specifier") {
      const statement = node.parent()?.parent();
      const name = node.field("name");
      if (statement?.kind() === "export_statement" && statement.parent()?.kind() === root.kind() && !statement.field("source")) {
        if (isTypeAsAliasError(node)) (hasTypeModifier(statement) ? typeOnlyExportedNames : exportedNames).add("type");
        else if (isIncompleteTypeAsAlias(node) || node.children().some((child) => child.kind() === "ERROR")) hasUnknownExportClause = true;
        else if (name) {
          const typeOnly = hasTypeModifier(statement) || hasTypeModifier(node);
          (typeOnly ? typeOnlyExportedNames : exportedNames).add(name.text());
        }
      }
    } else if (node.kind() === "export_statement" && node.parent()?.kind() === root.kind()) {
      const clause = node.children().find((child) => child.kind() === "export_clause");
      if (clause && !node.field("source")) {
        for (const child of clause.children()) {
          if (isBareTypeError(child)) (hasTypeModifier(node) ? typeOnlyExportedNames : exportedNames).add("type");
          else if (child.kind() === "ERROR") hasUnknownExportClause = true;
        }
      }
      if (node.children().some((child) => child.kind() === "default")) {
        const value = node.field("value");
        if (value?.kind() === "identifier") exportedNames.add(value.text());
      }
    }
  }
  const declarationNodes = nodes.filter(isDeclaration).filter((n) => n.parent()?.kind() === root.kind() || /export/.test(String(n.parent()?.kind() ?? "")));
  const allDeclarations = declarationNodes.flatMap((n) => declarationNames(n).map((name) => {
    const directlyExported = /export/.test(String(n.parent()?.kind() ?? ""));
    const kind = String(n.kind());
    const typeOnlyExport = /^(?:abstract_)?class_declaration$|^enum_declaration$/.test(kind) ? null : /^(?:interface|type_alias)_declaration$/.test(kind);
    const exported = directlyExported || exportedNames.has(name)
      ? true
      : typeOnlyExportedNames.has(name) ? typeOnlyExport
        : hasUnknownExportClause ? null : false;
    return { kind: String(n.kind()), name, range: location(n, source), exported, ...(declarationSignature(n, source) ? { signature: declarationSignature(n, source) } : {}) };
  }));
  const declarations = allDeclarations.slice(0, QUERY_BUDGETS.candidates);
  const graph = await moduleGraph(rootPath, file, ctx);
  return output({ status: graph.status === "unavailable" || hasUnknownExportClause ? "partial" : "ok", file: path.relative(rootPath, file), language, imports, importsTotal: importNodes.length, importsShowing: imports.length, importsTruncated, declarations, declarationsTotal: allDeclarations.length, declarationsShowing: declarations.length, declarationsTruncated: allDeclarations.length > declarations.length, graph });
});

export const inspect_symbol = tool("inspect_symbol", "Inspect one symbol with bounded graph relations, references and optional body.", { symbol: Type.String(), file: Type.Optional(Type.String()), language: Type.Optional(Type.String()), includeBody: Type.Optional(Type.Boolean()) }, async (p, ctx) => {
  const rootPath = await workspaceRoot(ctx.cwd, ctx.signal, ctx);
  if (!p.file) {
    const lookup = await read_symbol.execute("inspect-symbol-lookup", { symbol: p.symbol, language: p.language }, ctx.signal, undefined, { cwd: ctx.cwd, queryMetrics: ctx.queryMetrics, nestedCodeQuery: true });
    if (lookup.isError) return lookup;
    const report = JSON.parse(lookup.content[0]!.text);
    if (report.status !== "ok") return lookup;
    p = { ...p, file: report.file };
  }
  const { file, source } = sourceFor(rootPath, p.file);
  const resolution = lspLanguageResolution(file, p.language);
  if (resolution.status === "unsupported") {
    if (p.language !== undefined && resolveLanguage(file).status === "resolved") return languageProblem(file, p.language, p.symbol, rootPath)!;
    return lspSymbolResult(file, source, p.symbol, rootPath, resolution, ctx, p.includeBody === true);
  }
  if (resolution.status === "ambiguous") return languageProblem(file, p.language, p.symbol, rootPath)!;
  const { language, root } = ast(file, source, p.language, ctx);
  const candidates = namedCandidates(root, p.symbol);
  if (candidates.length !== 1) return output({ status: candidates.length ? "ambiguous" : "not_found", candidates: candidates.slice(0, QUERY_BUDGETS.candidates).map((n) => ({ kind: n.kind(), range: location(n, source) })), total: candidates.length });
  const node = candidates[0]!;
  const graph = await graphQuery(ctx, () => withGraph(rootPath, ctx.signal, (g) => {
    const matches = g.getNodesByName(p.symbol).filter((n: any) => n.filePath === path.relative(rootPath, file));
    if (matches.length !== 1) return { status: matches.length ? "ambiguous" : "symbol_not_indexed", total: matches.length, candidates: matches.slice(0, QUERY_BUDGETS.candidates).map((match: any) => ({ kind: match.kind, range: { start: match.startLine, end: match.endLine } })), truncated: matches.length > QUERY_BUDGETS.candidates, relations: null };
    const match = matches[0]!;
    const related = (edges: any[]) => {
      const shown = edges.slice(0, QUERY_BUDGETS.relations).map((edge) => {
        const node = g.getNode(edge.source === match.id ? edge.target : edge.source);
        return { kind: edge.kind, line: edge.line, node: node?.qualifiedName ?? null };
      });
      return { items: shown, truncated: edges.length > QUERY_BUDGETS.relations, unresolved: shown.filter((edge) => edge.node === null).length };
    };
    const callerEdges = g.getIncomingEdges(match.id).filter((edge: any) => edge.kind === "calls");
    const calleeEdges = g.getOutgoingEdges(match.id).filter((edge: any) => edge.kind === "calls");
    const callers = related(callerEdges);
    const callees = related(calleeEdges);
    const impact = g.getImpactRadius(match.id, 2);
    return {
      status: callers.truncated || callees.truncated || callers.unresolved + callees.unresolved > 0 ? "partial" : "ok",
      callers: callers.items,
      callees: callees.items,
      totals: { callers: callerEdges.length, callees: calleeEdges.length },
      callersShowing: callers.items.length,
      calleesShowing: callees.items.length,
      callersTruncated: callers.truncated,
      calleesTruncated: callees.truncated,
      unresolvedEdges: callers.unresolved + callees.unresolved,
      impact: { nodes: impact.nodes.size, edges: impact.edges.length, maxDepth: 2, completeness: "partial" },
    };
  }));
  let grep: Record<string, unknown>;
  try {
    const result = await measureAsync(ctx, "rg", () => abortable(ctx.signal, createGrepTool(rootPath).execute("inspect-symbol", { pattern: p.symbol, path: path.relative(rootPath, file), literal: true, limit: QUERY_BUDGETS.relations }, ctx.signal)));
    grep = { status: "available", text: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") };
  } catch (error) { if (ctx.signal.aborted) throw error; grep = { status: "unavailable", reason: String(error) }; }
  const nameNode = declarationNameNode(node, p.symbol) ?? node;
  const position = lspPosition(nameNode);
  const lsp = await lspQuery(ctx, file, "references", async (client) => {
    let diagnostics: Record<string, unknown>;
    let references: Record<string, unknown>;
    try {
      const result = await measureAsync<any>(ctx, "lsp", () => client.diagnostics(file));
      diagnostics = { status: "available", count: result.items.length, items: result.items.slice(0, 8).map((d: any) => ({ message: d.message, severity: d.severity, line: d.range.start.line + 1 })) };
    } catch (error) {
      diagnostics = { status: "unavailable", reason: String(error) };
    }
    try {
      const result = await measureAsync<any[]>(ctx, "lsp", () => client.references(file, position.line, position.character, true));
      references = { status: "available", total: result.length, locations: result.slice(0, QUERY_BUDGETS.relations).map((r: any) => ({ uri: r.uri, line: r.range.start.line + 1, character: r.range.start.character })), truncated: result.length > QUERY_BUDGETS.relations };
    } catch (error) {
      references = { status: "unavailable", reason: String(error) };
    }
    return { diagnostics, references };
  }).catch((error) => {
    if (ctx.signal.aborted) throw error;
    return { diagnostics: { status: "unavailable", reason: String(error) }, references: { status: "unavailable", reason: String(error) } };
  });
  const complete = graph.value?.status === "ok" && lsp.diagnostics.status === "available" && lsp.references.status === "available" && grep.status === "available";
  const lspRoot = await lspWorkspaceRoot(file);
  return output({ status: complete ? "ok" : "partial", symbol: p.symbol, file: path.relative(rootPath, file), language, kind: node.kind(), range: location(node, source), ...(p.includeBody ? { body: body(node, source) } : {}), graph: graph.value ?? { status: "unavailable", reason: graph.unavailable, relations: null }, ...lsp, lspWorkspaceRoot: lspRoot ?? null, grep: { source: "Pi grep textual evidence (not parsed matches)", ...grep } });
});

export const review_surface = tool("review_surface", "Summarize bounded changes against HEAD or a validated ref, including staged, unstaged and untracked files.", { base: Type.Optional(Type.String()) }, async (p, ctx) => {
  const root = await workspaceRoot(ctx.cwd, ctx.signal, ctx);
  const run = (args: string[]) => runGit(args, root, ctx.signal, 3000, 512 * 1024, ctx);
  const base = p.base ?? "HEAD";
  if (base.startsWith("-") || base.includes("\0")) throw new Error("invalid git ref");
  try { await run(["check-ref-format", "--allow-onelevel", base]); }
  catch (error) { if (ctx.signal.aborted) throw error; throw new Error("invalid git ref"); }
  const tree = await resolveReviewTree(base, root, ctx.signal, ctx);
  const diff = await run(["diff", "--no-color", "--no-ext-diff", "--unified=0", "--find-renames", tree, "--"]);
  const nameStatus = (await run(["diff", "--name-status", "--find-renames", "-z", tree, "--"])).split("\0");
  const changed = new Map<string, { change: string; hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }>; binary: boolean; renamedFrom?: string }>();
  const patches = diff.split(/(?=^diff --git )/m).filter((patch) => patch.startsWith("diff --git "));
  for (let i = 0, patchIndex = 0; i < nameStatus.length - 1;) {
    const status = nameStatus[i++]!;
    const renamedFrom = /^[RC]/.test(status) ? nameStatus[i++] : undefined;
    const file = nameStatus[i++];
    if (!file) continue;
    const kind = status[0];
    const change = kind === "A" ? "added" : kind === "D" ? "deleted" : kind === "R" ? "renamed" : kind === "C" ? "copied" : "modified";
    const entry = { change, hunks: [] as Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }>, binary: false, ...(renamedFrom ? { renamedFrom } : {}) };
    const patch = patches[patchIndex++];
    if (patch) {
      entry.binary = /^Binary files |^GIT binary patch/m.test(patch);
      for (const line of patch.split("\n")) {
        const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunk) entry.hunks.push({ oldStart: Number(hunk[1]), oldCount: Number(hunk[2] ?? 1), newStart: Number(hunk[3]), newCount: Number(hunk[4] ?? 1) });
      }
    }
    changed.set(file, entry);
  }
  const allUntracked = (await run(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const untracked = allUntracked.slice(0, MAX_CHANGED_FILES);
  const untrackedSet = new Set(allUntracked);
  const files = [...new Set([...changed.keys(), ...untracked])].slice(0, MAX_CHANGED_FILES);
  const untrackedShowing = files.filter((file) => untrackedSet.has(file)).length;
  const totalChanged = changed.size + allUntracked.length;
  let remainingSourceLines = QUERY_BUDGETS.sourceLines;
  const surfaces: Array<Record<string, any>> = [];
  for (const relative of files) {
    const entry = changed.get(relative);
    const change = entry?.change ?? (untrackedSet.has(relative) ? "untracked" : "modified");
    let filepath: string;
    try { filepath = workspacePath(root, relative); } catch { surfaces.push({ file: relative, status: "outside_workspace", change }); continue; }
    const exists = existsSync(filepath);
    const deleted = entry?.change === "deleted";
    if (!exists && !deleted) { surfaces.push({ file: relative, status: "unavailable", change, reason: "worktree file unavailable" }); continue; }
    let worktreeSource: string | undefined;
    if (exists) {
      const info = statSync(filepath);
      if (info.size > MAX_FILE_BYTES) { surfaces.push({ file: relative, status: "source_too_large", change, bytes: info.size, truncated: true }); continue; }
      worktreeSource = readFileSync(filepath, "utf8");
    }
    if (entry?.binary || worktreeSource?.includes("\0")) { surfaces.push({ file: relative, status: "binary", change }); continue; }
    const content = change === "untracked" && worktreeSource !== undefined ? sourceContent(worktreeSource) : undefined;
    const resolution = resolveLanguage(relative);
    if (resolution.status !== "resolved") { surfaces.push({ file: relative, status: "unsupported_language", change, ...(content ? { content } : {}) }); continue; }
    const needsBase = entry?.change === "deleted" || (entry?.hunks.some((hunk) => hunk.oldCount > 0) ?? false);
    let baseSource: string | undefined;
    let baseSourceStatus: string | undefined = change === "added" || change === "untracked" ? "not_in_base" : undefined;
    if (needsBase) {
      try {
        const previous = await run(["show", `${tree}:${entry!.renamedFrom ?? relative}`]);
        if (Buffer.byteLength(previous) > MAX_FILE_BYTES) baseSourceStatus = "source_too_large";
        else { baseSource = previous; baseSourceStatus = "available"; }
      } catch (error) { if (ctx.signal.aborted) throw error; baseSourceStatus = "unavailable"; }
    }
    const declarations = worktreeSource === undefined
      ? undefined
      : descendants(measure(ctx, "ast", () => parse(LANG_TO_AST[resolution.language], worktreeSource).root())).filter(isDeclaration);
    const baseDeclarations = baseSource === undefined
      ? undefined
      : descendants(measure(ctx, "ast", () => parse(LANG_TO_AST[resolution.language], baseSource).root())).filter(isDeclaration);
    const refs: Array<{ line: number; side: "base" | "worktree" }> = [];
    const totalChangedLines = entry
      ? entry.hunks.reduce((total, hunk) => total + hunk.oldCount + hunk.newCount, 0)
      : worktreeSource!.split(/\r?\n/).length;
    const totalBySide = entry
      ? entry.hunks.reduce((total, hunk) => ({ base: total.base + hunk.oldCount, worktree: total.worktree + hunk.newCount }), { base: 0, worktree: 0 })
      : { base: 0, worktree: totalChangedLines };
    if (entry) {
      for (const hunk of entry.hunks) {
        const available = Math.max(0, remainingSourceLines - refs.length);
        let baseShowing = 0;
        let worktreeShowing = 0;
        if (hunk.oldCount > 0 && hunk.newCount > 0) {
          const half = Math.floor(available / 2);
          baseShowing = Math.min(hunk.oldCount, half);
          worktreeShowing = Math.min(hunk.newCount, half);
          let extra = available - baseShowing - worktreeShowing;
          const baseExtra = Math.min(hunk.oldCount - baseShowing, extra);
          baseShowing += baseExtra;
          extra -= baseExtra;
          worktreeShowing += Math.min(hunk.newCount - worktreeShowing, extra);
        } else if (hunk.oldCount > 0) baseShowing = Math.min(hunk.oldCount, available);
        else worktreeShowing = Math.min(hunk.newCount, available);
        const paired = Math.min(baseShowing, worktreeShowing);
        for (let i = 0; i < paired; i++) refs.push({ line: hunk.oldStart + i, side: "base" }, { line: hunk.newStart + i, side: "worktree" });
        for (let i = paired; i < baseShowing; i++) refs.push({ line: hunk.oldStart + i, side: "base" });
        for (let i = paired; i < worktreeShowing; i++) refs.push({ line: hunk.newStart + i, side: "worktree" });
      }
    } else {
      const lineCount = worktreeSource!.split(/\r?\n/).length;
      for (let i = 0; i < Math.min(lineCount, remainingSourceLines); i++) refs.push({ line: i + 1, side: "worktree" });
    }
    const showingChangedLines = refs.length;
    remainingSourceLines -= showingChangedLines;
    const selectedBySide = {
      base: refs.filter((ref) => ref.side === "base").length,
      worktree: refs.filter((ref) => ref.side === "worktree").length,
    };
    const lineCoverage = {
      base: { total: totalBySide.base, selected: selectedBySide.base, showing: selectedBySide.base },
      worktree: { total: totalBySide.worktree, selected: selectedBySide.worktree, showing: selectedBySide.worktree },
    };
    const enclosures = refs.map(({ line, side }) => {
      const enclosureSource = side === "base" ? baseSource : worktreeSource;
      const candidates = side === "base" ? baseDeclarations : declarations;
      if (enclosureSource === undefined || !candidates) return { line, side, enclosing: null, ...(side === "base" && baseSourceStatus ? { sourceStatus: baseSourceStatus } : {}) };
      const node = lineEnclosure(candidates, enclosureSource, line);
      return node ? { line, side, kind: String(node.kind()), name: declarationNames(node)[0], range: location(node, enclosureSource) } : { line, side, enclosing: null };
    });
    const truncated = totalChangedLines > showingChangedLines || (needsBase && baseSource === undefined);
    surfaces.push({ file: relative, status: deleted ? "deleted" : entry?.renamedFrom ? "renamed" : "parsed", change, renamedFrom: entry?.renamedFrom, changedLines: totalChangedLines, showingChangedLines, lineCoverage, truncated, ...(baseSourceStatus ? { baseSourceStatus } : {}), ...(content ? { content } : {}), enclosures });
  }
  const graph = await graphQuery(ctx, () => withGraph(root, ctx.signal, (g) => ({ files: Object.fromEntries(files.map((relative) => [relative, graphFileConsumers(g, relative)])) })));
  const freshness = graph.value?.freshness;
  const graphChanged = !!freshness && (freshness.engineStale || Object.values(freshness.changedFiles).some((changedFiles) => changedFiles.length > 0));
  const graphFiles = graph.value ? Object.fromEntries(Object.entries(graph.value.files).map(([file, evidence]: [string, any]) => [file, evidence.status === "available" && graphChanged ? { ...evidence, status: "partial", reason: "index changed during query" } : evidence])) : undefined;
  const graphEntries = Object.values(graphFiles ?? {}) as Array<{ status: string; truncated?: boolean }>;
  const consumerEvidencePartial = graphEntries.some((entry) => entry.status !== "available" || entry.truncated === true);
  const relatedGraphConsumers = graph.value
    ? { status: graphChanged || consumerEvidencePartial ? "partial" : "available", files: graphFiles, freshness: graph.value.freshness }
    : { status: "unavailable", reason: graph.unavailable, files: Object.fromEntries(files.map((relative) => [relative, { status: "unavailable", consumers: null }])) };
  const graphMissing = !graph.value || graphChanged || consumerEvidencePartial;
  const reviewedFiles = surfaces.map((surface) => ({ ...surface, graphConsumers: (relatedGraphConsumers.files as Record<string, unknown>)[surface.file] }));
  const surfacePartial = surfaces.some((surface) => !["parsed", "renamed", "deleted"].includes(surface.status) || surface.truncated === true);
  const truncated = totalChanged > files.length || untrackedShowing < allUntracked.length || surfaces.some((surface) => surface.truncated === true) || consumerEvidencePartial;
  return output({ status: truncated || graphMissing || surfacePartial ? "partial" : "ok", comparison: `${base} (${tree}) tree to current worktree`, stagedAndUnstaged: true, untrackedIncluded: untrackedShowing === allUntracked.length, untrackedTotal: allUntracked.length, untrackedShowing, files: reviewedFiles, totalChangedFiles: totalChanged, truncated, relatedGraphConsumers });
});

export const CODE_INTELLIGENCE_TOOLS = [project_report, read_symbol, read_enclosing, module_report, inspect_symbol, review_surface] as const;
