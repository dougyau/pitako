import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { packageRoot } from "../extensions/stack.ts";
import { disposeDefaultLspManager } from "../node_modules/pi-lsp-client/src/lsp/manager.ts";
import { extensionPaths, loadPitako, registeredToolNames } from "./load-pitako.ts";

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
    ctx: undefined,
  ): Promise<{ content?: Array<{ type?: string; text?: string }> }>;
}

async function executeTool(
  loadedTools: Map<string, ToolRunner>,
  name: string,
  params: Record<string, unknown>,
): Promise<string> {
  const tool = loadedTools.get(name);
  if (!tool) throw new Error(`Tool ${name} is not registered`);
  const result = await tool.execute(`smoke-${name}`, params, new AbortController().signal, undefined, undefined);
  return toolText(result);
}

export async function runSmoke(root = packageRoot()): Promise<ToolText[]> {
  const fixture = path.join(root, "fixtures", "tiny-ts");
  const project = mkdtempSync(path.join(tmpdir(), "pitako-fixture-"));
  cpSync(fixture, project, { recursive: true });
  try {
    await run("codegraph", ["init"], project);
    const loaded = await loadPitako(root, project);
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
    ]) {
      if (!names.includes(required)) throw new Error(`Smoke expected ${required} to be registered`);
    }
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

    const summary = [
      { text: `loaded ${loaded.extensions.extensions.length} extensions from ${loaded.relativePackagePath}` },
      { text: `paths ${extensionPaths(loaded.extensions).join(", ")}` },
      { text: search },
      { text: callers },
      { text: definition },
      { text: references },
    ];
    return summary;
  } finally {
    await disposeDefaultLspManager().catch(() => undefined);
    rmSync(project, { recursive: true, force: true });
  }
}

const isDirect =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirect) {
  const lines = await runSmoke();
  for (const line of lines) console.log(line.text);
  console.log("Pitako smoke passed");
}
