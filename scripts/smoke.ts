import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import childProcess, { spawn, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { packageRoot } from "../extensions/stack.ts";
import { disposeDefaultLspManager } from "../node_modules/pi-lsp-client/src/lsp/manager.ts";
import { extensionPaths, loadPitako, registeredToolNames } from "./load-pitako.ts";
import { settleOwnedCodeGraph } from "./owned-codegraph.ts";

interface ToolText {
  text: string;
}

function positionOf(source: string, needle: string): { line: number; character: number } {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`Fixture is missing ${JSON.stringify(needle)}`);
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  const lastBreak = before.lastIndexOf("\n");
  const character = lastBreak < 0 ? before.length : before.length - lastBreak - 1;
  return { line, character };
}

function toolText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

interface ToolRunner {
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string } | undefined,
  ): Promise<{ content?: Array<{ type?: string; text?: string }> }>;
}

async function executeTool(
  loadedTools: Map<string, ToolRunner>,
  name: string,
  params: Record<string, unknown>,
  cwd?: string,
): Promise<string> {
  const tool = loadedTools.get(name);
  if (!tool) throw new Error(`Tool ${name} is not registered`);
  const result = await tool.execute(`smoke-${name}`, params, new AbortController().signal, undefined, cwd ? { cwd } : undefined);
  return toolText(result);
}

export async function runSmoke(root = packageRoot()): Promise<ToolText[]> {
  const owned = mkdtempSync(path.join(tmpdir(), "pitako-smoke-"));
  // The raw CodeGraph extension does not expose an awaitable MCP close. Keep
  // dependency processes in an owned worker, not the invoking Pi/test process.
  const child = spawn("node", ["--experimental-transform-types", "--import",
    fileURLToPath(new URL("./sdk-node-loader.mjs", import.meta.url)), fileURLToPath(import.meta.url),
    "--worker", root, owned], { stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, TMPDIR: owned, PI_CODING_AGENT_DIR: path.join(owned, "web-config"), PI_OFFLINE: "1",
  } });
  let output = "";
  let errors = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { errors += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const settled = errors.split("\n").find((line) => line.startsWith("PITAKO_SMOKE_SETTLED="));
  if (!settled) throw new Error(`Smoke resource settlement unproven; retained ${owned}\n${output}\n${errors}`);
  // Close is observed before removing the worker's caller-owned roots.
  rmSync(owned, { recursive: true, force: true });
  console.error(settled);
  if (code !== 0) throw new Error(`Smoke worker exited ${code}\n${output}\n${errors}`);
  const result = output.split("\n").find((line) => line.startsWith("PITAKO_SMOKE_RESULT="));
  if (!result) throw new Error(`Smoke worker returned no result\n${output}\n${errors}`);
  return JSON.parse(result.slice("PITAKO_SMOKE_RESULT=".length));
}

async function runSmokeWorker(root: string, owned: string): Promise<ToolText[]> {
  const processes: Array<{ child: ChildProcess; closed: Promise<void>; settled: boolean }> = [];
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
    const child = originalSpawn(...args);
    const entry = { child, closed: Promise.resolve(), settled: false };
    entry.closed = new Promise<void>((resolve) => child.once("close", () => { entry.settled = true; resolve(); }));
    processes.push(entry);
    return child;
  }) as typeof spawn;
  syncBuiltinESMExports();
  const fixture = path.join(root, "fixtures", "tiny-ts");
  const project = path.join(owned, "project");
  const agentDir = path.join(owned, "agent");
  mkdirSync(path.join(owned, "web-config"));
  mkdirSync(project);
  mkdirSync(agentDir);
  let loaded: Awaited<ReturnType<typeof loadPitako>> | undefined;
  try {
    cpSync(fixture, project, { recursive: true });
    await run("codegraph", ["init"], project);
    loaded = await loadPitako(root, project, agentDir);
    if (loaded.extensions.errors.length > 0) {
      throw new Error(loaded.extensions.errors.map((error) => `${error.path}: ${error.error}`).join("\n"));
    }
    const names = registeredToolNames(loaded.extensions);
    for (const required of [
      "lsp_goto_definition",
      "lsp_find_references",
      "codegraph_search",
      "codegraph_callers",
      "todo",
      "board_topic_create",
      "board_topic_list",
      "board_topic_read",
      "board_topic_update",
      "board_post",
      "board_query",
      "web_search",
      "fetch_content",
      "source_check",
      "get_search_content",
      "web_enable",
    ]) {
      if (!names.includes(required)) throw new Error(`Smoke expected ${required} to be registered`);
    }
    if (loaded.extensions.extensions.some((extension) => extension.commands.has("mission")))
      throw new Error("Smoke must not register retired /mission");
    const tools = new Map<string, ToolRunner>();
    for (const extension of loaded.extensions.extensions) {
      for (const [name, registered] of extension.tools) {
        tools.set(name, registered.definition as unknown as ToolRunner);
      }
    }

    const mainPath = path.join(project, "src", "main.ts");
    const greetPath = path.join(project, "src", "greet.ts");
    const mainSource = readFileSync(mainPath, "utf8");
    const at = positionOf(mainSource, "greet(");
    const symbols = await executeTool(tools, "lsp_symbols", { filePath: greetPath, scope: "document" });
    if (!symbols.includes("greet")) throw new Error(`lsp_symbols did not list greet:\n${symbols}`);
    const search = await executeTool(tools, "codegraph_search", { query: "greet", projectPath: project });
    if (!search.includes("greet")) throw new Error(`codegraph_search did not mention greet:\n${search}`);
    const callers = await executeTool(tools, "codegraph_callers", { symbol: "greet", projectPath: project });
    if (!/run|main/.test(callers)) throw new Error(`codegraph_callers did not find run():\n${callers}`);
    const definition = await executeTool(tools, "lsp_goto_definition", {
      filePath: mainPath,
      line: at.line,
      character: at.character,
    });
    if (!definition.includes("greet.ts")) throw new Error(`lsp_goto_definition did not find greet.ts:\n${definition}`);
    const references = await executeTool(tools, "lsp_find_references", {
      filePath: mainPath,
      line: at.line,
      character: at.character,
    });
    if (!references.includes("greet")) throw new Error(`lsp_find_references did not mention greet:\n${references}`);
    const inspected = JSON.parse(await executeTool(tools, "inspect_symbol", {
      symbol: "greet", file: greetPath,
    }, project));
    if (inspected.references.status !== "available")
      throw new Error(`Dense LSP references unavailable:\n${JSON.stringify(inspected)}`);

    const summary = [
      { text: `loaded ${loaded.extensions.extensions.length} extensions from ${loaded.relativePackagePath}` },
      { text: `paths ${extensionPaths(loaded.extensions).join(", ")}` },
      { text: search },
      { text: callers },
      { text: definition },
      { text: references },
      { text: JSON.stringify(inspected) },
    ];
    return summary;
  } finally {
    try {
      const shared = (globalThis as typeof globalThis & {
        [key: symbol]: Promise<{ manager: { stopAll(): Promise<void> } }> | undefined;
      })[Symbol.for("pitako.code-intelligence.lsp-registry")];
      if (shared) await (await shared).manager.stopAll();
      await disposeDefaultLspManager();
    } finally {
      // Exact child handles only, including the dependency's private MCP child.
      for (const entry of processes) if (!entry.settled) entry.child.kill();
      await Promise.all(processes.map((entry) => entry.closed));
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
    const codegraph = await settleOwnedCodeGraph(project);
    loaded?.releaseOwnedDirectories();
    console.error(`PITAKO_SMOKE_SETTLED=${JSON.stringify({ owned, codegraph, processes: processes.map(({ child, settled }) => ({ pid: child.pid, settled })) })}`);
  }
}

const isDirect =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirect) {
  if (process.argv[2] === "--worker") {
    const lines = await runSmokeWorker(process.argv[3]!, process.argv[4]!);
    console.log(`PITAKO_SMOKE_RESULT=${JSON.stringify(lines)}`);
  } else {
    const lines = await runSmoke();
    for (const line of lines) console.log(line.text);
    console.log("Pitako smoke passed");
  }
}
