import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createBashTool, createEditTool, createGrepTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { openBoard } from "../extensions/board/store.ts";
import { repositoryIdentity } from "../extensions/board/workspace.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";
import { ledgerFile, openExecutionPlan, planFile } from "../extensions/workflow.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tool worktree defaults", () => {
  test("keeps frozen source and Board owner in A while Pi tools and child actions use B", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pitako-physical-worktree-"));
    tempDirs.push(base);
    const source = path.join(base, "A");
    const execution = path.join(base, "B");
    mkdirSync(path.join(source, "src"), { recursive: true });
    mkdirSync(path.join(source, "test"), { recursive: true });
    writeFileSync(path.join(source, ".gitignore"), ".pitako/\n.codegraph/\n.pi/\n");
    writeFileSync(path.join(source, "package.json"), JSON.stringify({ type: "module", scripts: { test: "bun test" } }));
    writeFileSync(path.join(source, "src", "scope.ts"), 'export function onlyInA() { return "A"; }\n');
    writeFileSync(path.join(source, "test", "scope.test.ts"), 'import { expect, test } from "bun:test";\nimport { onlyInA } from "../src/scope.ts";\ntest("A source", () => expect(onlyInA()).toBe("A"));\n');
    execFileSync("git", ["init", "-q", "-b", "A"], { cwd: source, stdio: "ignore" });
    git(source, ["add", "."]);
    git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial", "-q"]);
    mkdirSync(path.dirname(execution), { recursive: true });
    git(source, ["worktree", "add", "-q", "-b", "B", execution]);
    writeFileSync(path.join(execution, "src", "scope.ts"), 'export function onlyInB() { return "B"; }\n');
    writeFileSync(path.join(execution, "test", "scope.test.ts"), 'import { expect, test } from "bun:test";\nimport { onlyInB } from "../src/scope.ts";\ntest("B source", () => expect(onlyInB()).toBe("B"));\n');

    const planId = "scope-plan";
    const boardFile = path.join(base, "board.db");
    const workspace = repositoryIdentity(source);
    const board = await openBoard(boardFile);
    const topic = board.createTopic(workspace, { title: "Source topic" });
    board.claimTopic(workspace, topic.id, planId);
    board.close();
    mkdirSync(path.dirname(planFile(planId, source)), { recursive: true });
    writeFileSync(planFile(planId, source), `---\nid: ${planId}\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\nexecution: expected\n---\n\n# Source-only plan\n`);

    const opened = openExecutionPlan(planId, execution);
    expect(opened.binding.planSource).toBe(planFile(planId, source));
    expect(opened.binding.executionRoot).toBe(execution);
    expect(opened.meta.boardTopicId).toBe(topic.id);
    expect(existsSync(planFile(planId, execution))).toBe(false);
    expect(existsSync(ledgerFile(planId, source))).toBe(false);
    expect(existsSync(ledgerFile(planId, execution))).toBe(true);
    const family = await openBoard(boardFile);
    expect(family.readTopic(repositoryIdentity(execution), topic.id).topic.ownerPlanId).toBe(planId);
    family.close();

    const execute = async (tool: { execute: (...args: any[]) => Promise<any> }, params: unknown) =>
      tool.execute("physical-worktree", params, undefined, undefined);
    const read = await execute(createReadTool(execution), { path: "src/scope.ts" });
    expect(resultText(read)).toContain("onlyInB");
    const grep = await execute(createGrepTool(execution), { pattern: "onlyInB", path: "src", literal: true });
    expect(resultText(grep)).toContain("onlyInB");
    const edit = createEditTool(execution);
    await execute(edit, { path: "src/scope.ts", edits: [{ oldText: 'return "B"', newText: 'return "B edited"' }] });
    await execute(edit, { path: "test/scope.test.ts", edits: [{ oldText: 'toBe("B")', newText: 'toBe("B edited")' }] });

    const configFile = path.join(base, "pitako.toml");
    writeFileSync(configFile, '[model_policies.developer]\nprimary = { model = "test/child" }\n');
    const child = await runAgentInstance({
      roleId: "developer",
      task: "write one marker in B",
      cwd: execution,
      executionRoot: execution,
      load: { cwd: execution, userConfigPath: configFile, env: {} },
      executor: {
        async start({ cwd }) {
          const result = await execute(createBashTool(cwd), { command: 'printf child-B > child-action.txt' });
          return result.isError
            ? { status: "failed", result: "", error: resultText(result), sideEffects: true }
            : { status: "completed", result: "child action used B", sideEffects: true };
        },
      },
    });
    expect(child.status).toBe("completed");
    expect(existsSync(path.join(execution, "child-action.txt"))).toBe(true);
    expect(existsSync(path.join(source, "child-action.txt"))).toBe(false);

    const testRun = await execute(createBashTool(execution), { command: "bun test", timeout: 120_000 });
    expect(testRun.isError).not.toBe(true);
    expect(resultText(testRun)).toContain("1 pass");
    const diff = await execute(createBashTool(execution), { command: "git diff -- src/scope.ts test/scope.test.ts" });
    expect(resultText(diff)).toContain('return "B edited"');
    expect(git(source, ["diff", "--", "src/scope.ts", "test/scope.test.ts"])).toBe("");
    expect(readFileSync(path.join(source, "src/scope.ts"), "utf8")).toContain("onlyInA");
  }, 120_000);

  test("CodeGraph and LSP use B when Pi launches in B", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pitako-intelligence-worktree-"));
    tempDirs.push(base);
    const source = path.join(base, "A");
    const execution = path.join(base, "B");
    mkdirSync(path.join(source, "src"), { recursive: true });
    writeFileSync(path.join(source, ".gitignore"), ".codegraph/\n.pi/\n");
    writeFileSync(path.join(source, "src", "scope.ts"), 'export function onlyInA() { return "A"; }\n');
    execFileSync("git", ["init", "-q", "-b", "A"], { cwd: source, stdio: "ignore" });
    git(source, ["add", "."]);
    git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial", "-q"]);
    mkdirSync(path.dirname(execution), { recursive: true });
    git(source, ["worktree", "add", "-q", "-b", "B", execution]);
    writeFileSync(path.join(execution, "src", "scope.ts"), 'export function onlyInB() { return "B"; }\n');
    mkdirSync(path.join(source, ".pi"), { recursive: true });
    writeFileSync(path.join(source, ".pi", "lsp-client.json"), JSON.stringify({ lsp: { onlyAConfig: { command: ["unused-a"], extensions: [".onlya"] } } }));
    mkdirSync(path.join(execution, ".pi"), { recursive: true });
    writeFileSync(path.join(execution, ".pi", "lsp-client.json"), JSON.stringify({ lsp: { onlyBConfig: { command: ["unused-b"], extensions: [".onlyb"] } } }));
    execFileSync("codegraph", ["init"], { cwd: source, stdio: "pipe", timeout: 120_000 });
    execFileSync("codegraph", ["init"], { cwd: execution, stdio: "pipe", timeout: 120_000 });

    const imports = {
      pitako: new URL("../extensions/index.ts", import.meta.url).href,
      codegraph: new URL("../node_modules/@vndv/pi-codegraph/extensions/codegraph.ts", import.meta.url).href,
      lsp: new URL("../node_modules/pi-lsp-client/src/index.ts", import.meta.url).href,
      manager: new URL("../node_modules/pi-lsp-client/src/lsp/manager.ts", import.meta.url).href,
      configLoader: new URL("../node_modules/pi-lsp-client/src/lsp/config-loader.ts", import.meta.url).href,
    };
    const script = `
      const tools = new Map();
      const handlers = [];
      const pi = {
        registerFlag() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
        on(name, handler) { if (name === "tool_call") handlers.push(handler); return () => {}; },
        getFlag() {}, getActiveTools() { return []; }, getAllTools() { return []; }, setActiveTools() {},
        getSessionName() {}, setSessionName() {},
      };
      const { default: codegraph } = await import(${JSON.stringify(imports.codegraph)});
      const { default: lsp } = await import(${JSON.stringify(imports.lsp)});
      const { default: pitako } = await import(${JSON.stringify(imports.pitako)});
      const { getLspManager, disposeDefaultLspManager } = await import(${JSON.stringify(imports.manager)});
      const { getConfigPaths, getMergedServers } = await import(${JSON.stringify(imports.configLoader)});
      codegraph(pi); lsp(pi); pitako(pi);
      const call = async (name, input, cwd) => {
        const event = { toolName: name, input };
        for (const handler of handlers) {
          const blocked = await handler(event, { cwd, hasUI: false, ui: { notify() {} } });
          if (blocked?.block) return { blocked: true, reason: blocked.reason, input: event.input };
        }
        const result = await tools.get(name).execute(name, event.input, undefined, undefined, { cwd });
        return {
          blocked: false,
          input: event.input,
          text: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\\n"),
          details: result.details,
        };
      };
      try {
        const a = await call("codegraph_search", { query: "onlyInA", projectPath: process.env.PITAKO_SCOPE_A }, process.cwd());
        const b = await call("codegraph_search", { query: "onlyInB" }, process.cwd());
        const lsp = await call("lsp_symbols", { filePath: "src/scope.ts", scope: "document" }, process.cwd());
        const roots = getLspManager().getSnapshot().map((client) => client.root);
        const projectConfig = getConfigPaths().project;
        const projectServers = getMergedServers().filter((server) => server.source === "project");
        console.log(JSON.stringify({ cwd: process.cwd(), a, b, lsp, roots, projectConfig, projectServers }));
      } finally {
        await disposeDefaultLspManager();
      }
    `;
    const stdout = execFileSync(process.execPath, ["-e", script], {
      cwd: execution,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PITAKO_SCOPE_A: source },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      cwd: string;
      a: { input: { projectPath?: string }; text: string };
      b: { input: { projectPath?: string }; text: string };
      lsp: { input: { filePath?: string }; text: string; details?: { filePath?: string } };
      roots: string[];
      projectConfig: string;
      projectServers: Array<{ id: string; source: string }>;
    };
    expect(result.cwd).toBe(execution);
    expect(result.a.input.projectPath).toBe(source);
    expect(result.a.text).toContain("onlyInA");
    expect(result.a.text).not.toContain("onlyInB");
    expect(result.b.input).not.toHaveProperty("projectPath");
    expect(result.b.text).toContain("onlyInB");
    expect(result.b.text).not.toContain("onlyInA");
    expect(result.lsp.input.filePath).toBe("src/scope.ts");
    expect(result.lsp.text).toContain("onlyInB");
    expect(result.lsp.text).not.toContain("onlyInA");
    expect(result.lsp.details?.filePath).toBe("src/scope.ts");
    expect(result.roots).toContain(execution);
    expect(result.projectConfig).toBe(path.join(execution, ".pi", "lsp-client.json"));
    expect(result.projectServers).toContainEqual(expect.objectContaining({ id: "onlyBConfig", source: "project" }));
    expect(result.projectServers.map((server) => server.id)).not.toContain("onlyAConfig");
  }, 150_000);
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function resultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}
