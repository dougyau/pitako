import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { initLedger, ledgerFile, ledgerTemplate, openExecutionPlan, planFile, planHash, readFrozenPlan } from "../extensions/workflow.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-execution-binding-"));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial", "-q"]);
}

function addWorktree(repo: string, root: string, branch: string): void {
  mkdirSync(path.dirname(root), { recursive: true });
  git(repo, ["worktree", "add", "-q", "-b", branch, root]);
}

function writePlan(root: string, id = "execution-plan", body = "frozen source"): string {
  const file = planFile(id, root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nid: ${id}\nrevision: 1\nstatus: frozen\n---\n\n# ${body}\n`);
  return file;
}

function child(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    process.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
    process.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
    process.once("error", reject);
    process.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("frozen execution binding", () => {
  test("pins source and physical execution root using path-safe ledger fields", () => {
    const base = tempDir();
    const source = path.join(base, "source");
    const execution = path.join(base, "execution with spaces\nand newline");
    initRepo(source);
    addWorktree(source, execution, "execution");
    const sourceFile = writePlan(source);

    const opened = openExecutionPlan("execution-plan", execution);
    expect(opened.binding.executionRoot).toBe(execution);
    expect(opened.binding.planSource).toBe(sourceFile);
    const ledger = readFileSync(ledgerFile("execution-plan", execution), "utf8");
    expect(ledger).toContain(`execution_root_b64: ${Buffer.from(execution).toString("base64url")}`);
    expect(ledger).toContain(`plan_source_b64: ${Buffer.from(sourceFile).toString("base64url")}`);
  });

  test("resume reads pinned source before a new local shadow and rejects source edits", () => {
    const base = tempDir();
    const source = path.join(base, "source");
    const execution = path.join(base, "execution");
    initRepo(source);
    addWorktree(source, execution, "execution");
    const sourceFile = writePlan(source);
    const first = openExecutionPlan("execution-plan", execution);

    writePlan(execution, "execution-plan", "new local shadow");
    const resumed = openExecutionPlan("execution-plan", execution);
    expect(resumed.binding).toEqual(first.binding);
    expect(resumed.file).toBe(sourceFile);
    expect(resumed.meta.hash).toBe(planHash(readFileSync(sourceFile, "utf8")));
    writePlan(source, "execution-plan", "changed frozen source");
    expect(() => openExecutionPlan("execution-plan", execution)).toThrow(/hash does not match/);
  });

  test("adopts a valid same-root legacy ledger without losing holds or evidence", () => {
    const base = tempDir();
    const source = path.join(base, "source");
    const execution = path.join(base, "execution");
    initRepo(source);
    addWorktree(source, execution, "execution");
    const sourceFile = writePlan(source);
    mkdirSync(path.dirname(planFile("execution-plan", execution)), { recursive: true });
    symlinkSync(sourceFile, planFile("execution-plan", execution));
    const plan = readFrozenPlan("execution-plan", execution);
    const ledger = ledgerFile("execution-plan", execution);
    mkdirSync(path.dirname(ledger), { recursive: true });
    const legacy = `${ledgerTemplate(plan.meta)}\nlegacy evidence remains\n`;
    writeFileSync(ledger, legacy.replace("[]\n<!-- /pitako-team-holds -->", '[{"assignmentId":"kept","unitId":"unit","status":"failed"}]\n<!-- /pitako-team-holds -->'));

    const opened = openExecutionPlan("execution-plan", execution);
    const updated = readFileSync(ledger, "utf8");
    expect(opened.binding.planSource).toBe(sourceFile);
    expect(updated).toContain("legacy evidence remains");
    expect(updated).toContain('"assignmentId":"kept"');
    expect(updated).toContain("execution_root_b64:");
    rmSync(planFile("execution-plan", execution));
    expect(openExecutionPlan("execution-plan", execution).file).toBe(sourceFile);
  });

  test("direct initLedger refuses a second Git worktree ledger", () => {
    const base = tempDir();
    const source = path.join(base, "source");
    const executionA = path.join(base, "execution-a");
    const executionB = path.join(base, "execution-b");
    initRepo(source);
    addWorktree(source, executionA, "execution-a");
    addWorktree(source, executionB, "execution-b");
    writePlan(source);
    const opened = openExecutionPlan("execution-plan", executionB);

    expect(() => initLedger(ledgerFile("execution-plan", executionA), opened.meta)).toThrow(/competing ledger/);
    expect(existsSync(ledgerFile("execution-plan", executionA))).toBe(false);
    expect(readFileSync(ledgerFile("execution-plan", executionB), "utf8")).toContain("execution_root_b64:");
  });

  test("races direct initLedger cold starts under the Git common-directory lock", async () => {
    const base = tempDir();
    const source = path.join(base, "source");
    const executionA = path.join(base, "execution-a");
    const executionB = path.join(base, "execution-b");
    initRepo(source);
    addWorktree(source, executionA, "execution-a");
    addWorktree(source, executionB, "execution-b");
    writePlan(source);

    const moduleUrl = new URL("../extensions/workflow.ts", import.meta.url).href;
    const run = (cwd: string) => child(process.execPath, ["-e", `import { initLedger, ledgerFile, readFrozenPlan } from ${JSON.stringify(moduleUrl)}; const plan = readFrozenPlan("execution-plan", ${JSON.stringify(cwd)}); initLedger(ledgerFile("execution-plan", ${JSON.stringify(cwd)}), plan.meta);`]);
    const outcomes = await Promise.all([run(executionA), run(executionB)]);
    expect(outcomes.filter((result) => result.code === 0)).toHaveLength(1);
    expect(outcomes.filter((result) => result.stderr.includes("competing ledger"))).toHaveLength(1);
    expect(Number(existsSync(ledgerFile("execution-plan", executionA))) + Number(existsSync(ledgerFile("execution-plan", executionB)))).toBe(1);
  });

  test("rejects a copied execution ledger after worktree drift", () => {
    const base = tempDir();
    const source = path.join(base, "source");
    const execution = path.join(base, "execution");
    const drifted = path.join(base, "drifted");
    initRepo(source);
    addWorktree(source, execution, "execution");
    addWorktree(source, drifted, "drifted");
    writePlan(source);
    openExecutionPlan("execution-plan", execution);
    const original = ledgerFile("execution-plan", execution);
    mkdirSync(path.dirname(ledgerFile("execution-plan", drifted)), { recursive: true });
    cpSync(original, ledgerFile("execution-plan", drifted));
    rmSync(original);
    expect(() => openExecutionPlan("execution-plan", drifted)).toThrow(/execution worktree changed/);
  });

  test("rejects a child whose physical workspace differs from its captured root", async () => {
    const base = tempDir();
    const first = path.join(base, "first");
    const expected = path.join(base, "expected");
    initRepo(first);
    addWorktree(first, expected, "expected");
    let accepted = false;
    let started = false;
    await expect(runAgentInstance({
      roleId: "developer",
      task: "must not start",
      cwd: first,
      executionRoot: expected,
      executor: { async start() { started = true; return { status: "completed", result: "unexpected", sideEffects: false }; } },
      onAccepted() { accepted = true; },
    })).rejects.toThrow(/AgentInstance workspace drift/);
    expect(accepted).toBe(false);
    expect(started).toBe(false);
  });

  test("keeps non-Git execution roots local", () => {
    const root = tempDir();
    writePlan(root);
    const opened = openExecutionPlan("execution-plan", root);
    expect(opened.binding.executionRoot).toBe(root);
    expect(openExecutionPlan("execution-plan", root).binding).toEqual(opened.binding);
  });

  test("rejects a foreign worktree ledger and races cold starts under the Git common directory", async () => {
    const base = tempDir();
    const source = path.join(base, "source");
    const executionA = path.join(base, "execution A");
    const executionB = path.join(base, "execution B");
    initRepo(source);
    addWorktree(source, executionA, "execution-a");
    addWorktree(source, executionB, "execution-b");
    const sourceFile = writePlan(source);

    const moduleUrl = new URL("../extensions/workflow.ts", import.meta.url).href;
    const run = (cwd: string) => child(process.execPath, ["-e", `import { openExecutionPlan } from ${JSON.stringify(moduleUrl)}; openExecutionPlan("execution-plan", ${JSON.stringify(cwd)});`]);
    const outcomes = await Promise.all([run(executionA), run(executionB)]);
    expect(outcomes.filter((result) => result.code === 0)).toHaveLength(1);
    expect(outcomes.filter((result) => result.stderr.includes("competing ledger"))).toHaveLength(1);
    const ledgerA = ledgerFile("execution-plan", executionA);
    const ledgerB = ledgerFile("execution-plan", executionB);
    expect(Number(existsSync(ledgerA)) + Number(existsSync(ledgerB))).toBe(1);
    const winner = existsSync(ledgerA) ? executionA : executionB;
    const loser = winner === executionA ? executionB : executionA;
    const legacyCompetitor = readFileSync(ledgerFile("execution-plan", winner), "utf8")
      .replace(/^execution_root_b64:.*\r?\n/m, "")
      .replace(/^plan_source_b64:.*\r?\n/m, "")
      .replace(/^revision: 1$/m, "revision: 9")
      .replace(/^hash: .*$/m, `hash: ${"0".repeat(64)}`)
      .replace(/^status: running$/m, "status: completed");
    writeFileSync(ledgerFile("execution-plan", winner), legacyCompetitor);
    const conflict = (() => {
      try {
        openExecutionPlan("execution-plan", loser);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    })();
    expect(conflict).toContain(ledgerFile("execution-plan", winner));
    expect(conflict).toContain(`revision=9, hash=${"0".repeat(64)}, status=completed`);
  });
});
