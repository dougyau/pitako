import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { project_report, read_enclosing } from "../extensions/code-intelligence/tools.ts";
import { bindLspApi } from "../extensions/code-intelligence/lsp.ts";
import { openBoard } from "../extensions/board/store.ts";
import { repositoryIdentity } from "../extensions/board/workspace.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";
import { ledgerFile, openExecutionPlan, planFile } from "../extensions/workflow.ts";

const tempDirs: string[] = [];

afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("tool worktree defaults", () => {
  test("keeps frozen source and Board owner in A while Pitako child dispatch uses B", async () => {
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
          expect(cwd).toBe(execution);
          writeFileSync(path.join(cwd, "child-action.txt"), "child-B");
          return { status: "completed", result: "child action used B", sideEffects: true };
        },
      },
    });
    expect(child.status).toBe("completed");
    expect(existsSync(path.join(execution, "child-action.txt"))).toBe(true);
    expect(existsSync(path.join(source, "child-action.txt"))).toBe(false);

    expect(readFileSync(path.join(source, "src/scope.ts"), "utf8")).toContain("onlyInA");
  }, 120_000);

  test("Pitako routes graph and LSP adapter inputs to execution B and rejects outside files", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "pitako-intelligence-worktree-")); tempDirs.push(base);
    const source = path.join(base, "A"), execution = path.join(base, "B");
    for (const dir of [source, execution]) { mkdirSync(dir); writeFileSync(path.join(dir, "README.md"), "# Guide\n"); }
    const key = Symbol.for("pitako.code-intelligence.lsp-registry"), lookup = Symbol.for("pitako.code-intelligence.lsp-extension-lookup");
    const globals = globalThis as typeof globalThis & { [key: symbol]: any };
    const previous = globals[key], previousLookup = globals[lookup];
    delete globals[key]; delete globals[lookup];
    const queried: string[] = [], graphRoots: string[] = [];
    bindLspApi({
      findWorkspaceRoot: file => path.dirname(file),
      createManager: () => ({ stopAll: async () => {} }),
      findServerForExtension: () => ({ status: "configured" }),
      async withLspClient(file, run) { queried.push(file); return run({ documentSymbols: async () => [
        { name: "Guide", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } },
      ] }); },
    });
    const graphDependencies = { unsupportedRuntime: () => undefined, sdk: async () => ({
      getCodeGraphDir: (dir: string) => path.join(dir, ".controlled"),
      CodeGraph: { isInitialized(dir: string) { graphRoots.push(dir); return false; } },
    }) };
    try {
      await project_report.execute("B", {}, new AbortController().signal, undefined, { cwd: execution, graphDependencies });
      expect(graphRoots).toEqual([execution]);
      for (const file of ["README.md", path.join(execution, "README.md")]) {
        const result = await read_enclosing.execute("scope", { file, line: 1 }, new AbortController().signal, undefined, { cwd: execution });
        expect(result.details.status, JSON.stringify(result.content)).toBe("ok");
      }
      const outside = await read_enclosing.execute("outside", { file: path.join(source, "README.md"), line: 1 },
        new AbortController().signal, undefined, { cwd: execution });
      expect(outside.details.status).toBe("unavailable");
      expect(outside.content[0]?.text).toContain("path escapes workspace");
      expect(queried).toEqual([path.join(execution, "README.md"), path.join(execution, "README.md")]);
    } finally {
      const shared = await globals[key];
      await Promise.all([...shared.queues.values()]);
      await shared.manager.stopAll();
      if (previous === undefined) delete globals[key]; else globals[key] = previous;
      if (previousLookup === undefined) delete globals[lookup]; else globals[lookup] = previousLookup;
    }
  });

});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function resultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}
