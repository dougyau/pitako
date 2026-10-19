import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { PitakoConfigError } from "../extensions/errors.ts";
import { packageRoot } from "../extensions/stack.ts";
import {
  bindingMismatch,
  bindPlanTopic,
  evidenceFile,
  initLedger,
  ledgerFile,
  parseLedgerBinding,
  parsePlanDocument,
  setPlanExecution,
  planFile,
  readPlan,
  requireFrozen,
  workflowWorkspace,
  readLedgerTeamHolds,
  updateLedgerTeamHold,
} from "../extensions/workflow.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function gitRepo(): string {
  const dir = tempDir("pitako-plan-repo-");
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function planText(status = "frozen", body = "body"): string {
  return `---\nid: herdr-integration\nrevision: 2\nstatus: ${status}\n---\n\n# Herdr integration\n\n${body}\n`;
}

async function runHoldWorkers(cwd: string, source: (worker: number) => string, children: ReturnType<typeof spawn>[] = []): Promise<void> {
  const workers: { child: ReturnType<typeof spawn>; ready: Promise<void>; closed: Promise<void> }[] = [];
  try {
    for (let worker = 0; worker < 4; worker++) {
      // Release all four live processes together, leaving stdin open for controlled cancellation.
      const script = `console.log("ready"); await new Promise(resolve => process.stdin.once("data", resolve)); ${source(worker)}; process.exit(0);`;
      const child = spawn(process.execPath, ["-e", script], {
        cwd, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      let error: Error | undefined;
      let stderr = "";
      child.on("error", value => { error = value; });
      child.stderr!.on("data", chunk => { stderr += chunk; });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", () => resolve());
        child.once("close", () => reject(error ?? new Error("hold worker closed before release")));
      });
      const closed = new Promise<void>((resolve, reject) => {
        child.once("close", (code, signal) => {
          if (error || code !== 0 || signal) reject(error ?? new Error(`hold worker exited ${code}/${signal}: ${stderr}`));
          else resolve();
        });
      });
      // Observe rejections immediately; finally still awaits actual close of every child.
      void ready.catch(() => {});
      void closed.catch(() => {});
      workers.push({ child, ready, closed });
    }
    await Promise.all(workers.map(worker => worker.ready));
    for (const { child } of workers) child.stdin!.write("go\n");
    await Promise.all(workers.map(worker => worker.closed));
  } finally {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.allSettled(workers.map(worker => worker.closed));
  }
}

describe("workflow paths", () => {
  test("uses the git root, and a non-git directory falls back to cwd", () => {
    const repo = gitRepo();
    const nested = path.join(repo, "src");
    mkdirSync(nested);
    const loose = tempDir("pitako-plan-loose-");
    expect(workflowWorkspace(nested)).toBe(workflowWorkspace(repo));
    expect(planFile("herdr-integration", nested)).toBe(path.join(repo, ".pitako", "plans", "herdr-integration.md"));
    expect(workflowWorkspace(loose)).toBe(loose);
    expect(planFile("bounded-fix", loose)).toBe(path.join(loose, ".pitako", "plans", "bounded-fix.md"));
  });

  test("rejects traversal and builds ledger and evidence inside the run", () => {
    const loose = tempDir("pitako-plan-paths-");
    expect(ledgerFile("alpha", loose)).toBe(path.join(loose, ".pitako", "runs", "alpha", "ledger.md"));
    expect(evidenceFile("alpha", "T1/verification.txt", loose)).toBe(
      path.join(loose, ".pitako", "runs", "alpha", "evidence", "T1", "verification.txt"),
    );
    for (const id of ["../x", "..", "/tmp/x", "foo/bar", "foo\\bar", "Foo", "", "a..b"]) {
      expect(() => planFile(id, loose)).toThrow(PitakoConfigError);
    }
    expect(() => evidenceFile("alpha", "../ledger.md", loose)).toThrow(PitakoConfigError);
    expect(() => evidenceFile("alpha", "/etc/passwd", loose)).toThrow(PitakoConfigError);
    expect(() => evidenceFile("alpha", "T1/../../plans/x.md", loose)).toThrow(PitakoConfigError);
  });
});

describe("plan binding", () => {
  test("reads frozen metadata, revision, and hash, and refuses a non-frozen plan", () => {
    const loose = tempDir("pitako-plan-meta-");
    const text = planText();
    const meta = parsePlanDocument(text);
    expect(meta.id).toBe("herdr-integration");
    expect(meta.revision).toBe(2);
    expect(meta.status).toBe("frozen");
    expect(meta.hash).toHaveLength(64);
    const file = planFile("herdr-integration", loose);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    const read = readPlan("herdr-integration", loose);
    expect(read.meta.revision).toBe(2);
    expect(read.meta.hash).toBe(meta.hash);
    expect(() => requireFrozen(parsePlanDocument(planText("draft")))).toThrow(/not frozen/);
    requireFrozen(read.meta);
  });

  test("persists an optional validated topic binding only on a draft", () => {
    const loose = tempDir("pitako-plan-topic-");
    const file = planFile("herdr-integration", loose);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, planText("draft"));
    expect(parsePlanDocument(planText("draft")).boardTopicId).toBeUndefined();
    expect(parsePlanDocument(planText("draft")).execution).toBeUndefined();
    expect(setPlanExecution("herdr-integration", "expected", loose).execution).toBe("expected");
    const body = "# execution: body must stay unchanged\n\nbody execution: old value\n";
    writeFileSync(file, planText("draft", body));
    setPlanExecution("herdr-integration", "none", loose);
    expect(readFileSync(file, "utf8")).toContain(body);
    const bound = bindPlanTopic("herdr-integration", 27, loose);
    expect(bound.boardTopicId).toBe(27);
    expect(readFileSync(file, "utf8")).toContain("board_topic_id: 27");
    expect(() => bindPlanTopic("herdr-integration", 28, loose)).toThrow(/already bound/);
    expect(() => parsePlanDocument(planText().replace("status: frozen", "status: frozen\nboard_topic_id: 1.5"))).toThrow(/positive safe integer/);
  });

  test("detects revision and hash mismatch and does not overwrite an existing ledger", () => {
    const loose = tempDir("pitako-plan-ledger-");
    const meta = parsePlanDocument(planText());
    const file = ledgerFile("herdr-integration", loose);
    expect(initLedger(file, meta)).toBe("created");
    const first = readFileSync(file, "utf8");
    writeFileSync(file, `${first}\n## Rulings\n\nKeep the seam.\n`);
    const kept = readFileSync(file, "utf8");
    expect(initLedger(file, meta)).toBe("exists");
    expect(readFileSync(file, "utf8")).toBe(kept);
    const binding = parseLedgerBinding(kept);
    expect(bindingMismatch(meta, binding)).toBeUndefined();
    expect(bindingMismatch({ ...meta, revision: 3 }, binding)).toContain("revision");
    expect(bindingMismatch({ ...meta, hash: "0".repeat(64) }, binding)).toContain("hash");
  });
});

describe("ledger Team hold locking", () => {
  test("preserves concurrent updates across processes", async () => {
    const cwd = tempDir("pitako-hold-contention-");
    const file = planFile("hold-plan", cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "---\nid: hold-plan\nrevision: 1\nstatus: frozen\nboard_topic_id: 1\n---\n\nPlan.\n");
    const meta = readPlan("hold-plan", cwd).meta;
    initLedger(ledgerFile("hold-plan", cwd), meta);
    const moduleUrl = new URL("../extensions/workflow.ts", import.meta.url).href;
    const children: ReturnType<typeof spawn>[] = [];
    // Ten distinct entries per worker retain repeated contention without a 400-write stress workload.
    await runHoldWorkers(cwd, worker => `
      import { updateLedgerTeamHold } from ${JSON.stringify(moduleUrl)};
      for (const status of ["pending", "failed"]) {
        for (let i = 0; i < 10; i++) {
          if (!updateLedgerTeamHold(${JSON.stringify(cwd)}, "hold-plan", {
            assignmentId: ${JSON.stringify(`worker-${worker}-`)} + i, unitId: "unit", status,
          })) throw new Error("hold was not updated");
        }
      }
    `, children);
    expect(children).toHaveLength(4);
    for (const child of children) expect(child.exitCode).toBe(0);
    const expected = Array.from({ length: 4 }, (_, worker) =>
      Array.from({ length: 10 }, (_, i) => ({ assignmentId: `worker-${worker}-${i}`, unitId: "unit", status: "failed" as const })),
    ).flat().sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
    expect(readLedgerTeamHolds(cwd, "hold-plan").sort((a, b) => a.assignmentId.localeCompare(b.assignmentId))).toEqual(expected);
    expect(existsSync(`${ledgerFile("hold-plan", cwd)}.lock`)).toBe(false);
  });

  test("settles every hold worker before releasing a failed fixture", async () => {
    const cwd = tempDir("pitako-hold-worker-failure-");
    const children: ReturnType<typeof spawn>[] = [];
    await expect(runHoldWorkers(cwd, worker => worker === 0
      ? `throw new Error("controlled worker failure")`
      : `await new Promise(resolve => process.stdin.once("end", resolve)); throw new Error("unexpected release")`,
      children,
    )).rejects.toThrow(/controlled worker failure/);
    expect(children).toHaveLength(4);
    for (const child of children) {
      try {
        process.kill(child.pid!, 0);
        throw new Error("hold worker survived settlement");
      } catch (error) {
        expect(error).toMatchObject({ code: "ESRCH" });
      }
    }
    expect(existsSync(cwd)).toBe(true);
  });

  test("fails closed on a planted lock without deleting it", () => {
    const cwd = tempDir("pitako-hold-stale-");
    const file = planFile("stale-plan", cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "---\nid: stale-plan\nrevision: 1\nstatus: frozen\nboard_topic_id: 1\n---\n\nPlan.\n");
    const meta = readPlan("stale-plan", cwd).meta;
    const ledger = ledgerFile("stale-plan", cwd);
    initLedger(ledger, meta);
    const lock = `${ledger}.lock`;
    mkdirSync(lock);
    try {
      expect(() => updateLedgerTeamHold(cwd, "stale-plan", { assignmentId: "a", unitId: "unit", status: "pending" })).toThrow(/verify no writer is active before manually removing the stale lock/);
      expect(existsSync(lock)).toBe(true);
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }, 10000);
});

describe("plan and execute contracts", () => {
  const plan = readFileSync(path.join(packageRoot(), "skills/plan/SKILL.md"), "utf8");
  const execute = readFileSync(path.join(packageRoot(), "skills/execute/SKILL.md"), "utf8");
  const deslop = readFileSync(path.join(packageRoot(), "skills/remove-ai-slops/SKILL.md"), "utf8");
  const prePr = readFileSync(path.join(packageRoot(), "skills/pre-pr/SKILL.md"), "utf8");
  const router = readFileSync(path.join(packageRoot(), "skills/pitako-coding/SKILL.md"), "utf8");
  const sequencing = readFileSync(path.join(packageRoot(), "skills/principles/principle-sequence-verifiable-units/SKILL.md"), "utf8");
  const architect = readFileSync(path.join(packageRoot(), "roles/architect.md"), "utf8");
  const reviewer = readFileSync(path.join(packageRoot(), "roles/reviewer.md"), "utf8");
  const verify = readFileSync(path.join(packageRoot(), "skills/practical/verify-behavior/SKILL.md"), "utf8");

  // Static policy contracts, not tests of model compliance or implementation effectiveness.
  test("TODO guidance exposes known stages and preserves them through resume", () => {
    for (const instruction of [router, plan]) {
      expect(instruction).toMatch(/all known (?:planning )?stages as `pending`/);
      expect(instruction).toMatch(/before starting the first/i);
      expect(instruction).toMatch(/[Rr]euse/);
      expect(instruction).toContain("resume");
    }
    expect(router).toContain("preserve unrelated tasks");
    expect(router).toContain("never `clear`");
    expect(router).toContain("complete it only after the work is actually done");
    expect(router).toContain("Skip TODOs for trivial tasks");
    expect(plan).toContain("authorized planning, not the future implementation units");
    expect(plan).toContain("Freezing the plan does not start those units");

    const preparation = execute.split("## Prepare the captured checkout")[1]!.split("## Decisions")[0]!;
    expect(preparation.indexOf("Register all frozen units")).toBeGreaterThan(preparation.indexOf("reconcile `## Workers`"));
    expect(preparation.indexOf("Register all frozen units")).toBeLessThan(preparation.indexOf("bash ./scripts/setup.sh"));
    const records = execute.split("## Records")[1]!.split("## Report")[0]!;
    expect(records).toContain("Before starting T1, register T1, T2, T3, and T4");
    expect(records).toContain("unit IDs and titles recognizable");
    expect(records).toContain("at most one task `in_progress`");
    expect(records).toContain("T1 is `completed`, T2 is `in_progress`, and T3 and T4 remain `pending`");
    expect(records).toContain("a worker result alone does not complete a unit");
    expect(records).toContain("Workers track only their own assignment");
    expect(records).toContain("plan, ledger, and relevant evidence");
    expect(records).toContain("Reuse existing tasks, preserve unrelated tasks, and never `clear`");
    expect(records).toContain("reconstruct their states from those records");
    expect(records).toContain("Keep accepted units completed");
    expect(records).toContain("not acceptance authority");
    expect(records).not.toContain("what you are doing now");
  });

  test("guidance selects owned behavior without reviving external certification", () => {
    const author = readFileSync(path.join(packageRoot(), "skills/practical/gates/SKILL.md"), "utf8");
    const readme = readFileSync(path.join(packageRoot(), "README.md"), "utf8");
    const engineering = readFileSync(path.join(packageRoot(), "docs/engineering.md"), "utf8");
    for (const instruction of [verify, router, plan, execute, prePr, deslop, author, readme, engineering]) {
      expect(instruction).toContain("declared testing scope");
      expect(instruction).toContain("active project");
    }
    for (const instruction of [verify, router, plan, execute, prePr, author, readme, engineering]) {
      expect(instruction).toContain("scope, contracts, and active guide");
      expect(instruction).toMatch(/not (?:from )?Pitako's distributed stack/);
    }
    for (const instruction of [verify, router, plan, execute, author, readme, engineering]) {
      expect(instruction).toMatch(/Reading (?:an external boundary|a dependency)/);
      expect(instruction).toMatch(/(?:grants no|does not authorize) (?:dependency )?certification or repair/);
    }
    for (const instruction of [plan, execute, author]) {
      expect(instruction).toContain("out-of-scope external checks into acceptance, preflight, or final gates");
    }
    expect(verify).toContain("Reviewer must not demand that runtime solely because a double was used");
    expect(verify).toContain("does not create a requirement to exercise that runtime");
    expect(verify).toContain("when it belongs to the authorized testing scope");
    expect(deslop).toContain("does not add dependency certification or revive retired external checks");
    expect(prePr).toContain("Do not add external certification as an independent default");
    expect(prePr).not.toContain("package/load or smoke obligations where warranted");
    expect(execute).not.toContain("then the real surface when it is cheap");
    for (const instruction of [readme, engineering]) {
      expect(instruction).toContain("not future model compliance");
      expect(instruction).toContain("asynchronous settlement before cleanup");
      expect(instruction).not.toMatch(/bun run smoke|scripts\/smoke\.ts|tests\/todo\.test\.ts|fixtures\/tiny-ts/);
    }
    expect(readme).not.toContain("full serial Bun suite, separate Node suites");
  });

  test("explicit GATES authoring bounds writes and preserves evidence distinctions", () => {
    const author = readFileSync(path.join(packageRoot(), "skills/practical/gates/SKILL.md"), "utf8");
    for (const contract of [
      "disable-model-invocation: true", "natural-language request",
      "creation or a bounded update", "Write only `<selected-project-root>/GATES.md`",
      "Preserve accurate content outside the requested scope", "external symlink",
      "manifests and lockfiles, CI, project documentation, wrappers, tests, and runner capabilities",
      "targeted read-only help or version probe", "label the unresolved procedure",
      "exact native commands and working directories", "source-confirmed commands from observed executions",
      "unrun or skipped check is not a pass", "No fixed headings",
      "setup, dependency or toolchain installs, broad test runs, product fixes, new test infrastructure, settings changes, or feature maps",
      "app-driving verification skills and feature maps, not project-wide gate recipes",
    ]) expect(author).toContain(contract);
    expect(verify).toContain("Do not automatically create or maintain the guide");
  });

  test("shared GATES guidance selects the active root and preserves authority", () => {
    const guidePolicy = verify.slice(verify.indexOf("## Read the project's verification guide"), verify.indexOf("## Select and observe evidence"));
    for (const contract of [
      "workflowWorkspace", "canonical cwd outside Git", "`binding.executionRoot`",
      "project being planned", "Read guidance only", "current canonical project/worktree root",
      "never the installed Pitako package, plan-source checkout, or substitute ancestors",
      "component-specific command working directories", "ordinary Markdown",
      "does not require `package.json`", "Cross-check consequential claims",
      "Missing, stale, or incomplete guidance", "uncovered obligation",
      "Do not automatically create or maintain", "frozen plan and user authority",
      "phase- and binding-compatible evidence reuse", "rather than copying the whole guide",
    ]) expect(guidePolicy).toContain(contract);
    expect(plan).toContain("shared root `GATES.md` discovery");
    expect(plan).toContain("do not run setup or product checks during planning");
    expect(execute).toContain("shared root `GATES.md` interpretation using `binding.executionRoot`");
    expect(prePr).toContain("shared root `GATES.md` interpretation for the current canonical worktree");
    expect(prePr).toContain("run `git diff --check` for publication readiness");
  });

  test("Pitako gates retain the discovered owned suite in fixed order", () => {
    const gates = readFileSync(path.join(packageRoot(), "GATES.md"), "utf8");
    const routine = gates.split("## Run the complete routine procedure")[1]!.split("### Use")[0]!;
    expect(routine.indexOf("bun run typecheck")).toBeGreaterThan(-1);
    expect(routine.indexOf("bun run test")).toBeGreaterThan(routine.indexOf("bun run typecheck"));
    expect(routine).not.toContain("--concurrent");
    const scripts = JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")).scripts;
    expect(scripts.test).toBe("bun test --parallel");
    expect(scripts.smoke).toBeUndefined();
    expect(scripts["test:code-intelligence-node"]).toBeUndefined();
    expect(gates).not.toContain("test:code-intelligence-node");
    expect(gates).toContain("CPU-derived file parallelism");
    expect(gates).toContain("Setup success does not prove");
    expect(gates).toContain("unrun checks separately from passes");
  });

  test("recipe routing binds source and evidence while the principal owns full checks", () => {
    const gates = readFileSync(path.join(packageRoot(), "GATES.md"), "utf8");
    for (const instruction of [gates, verify, execute]) {
      for (const contract of [
        "scripts/verification-recipe-v1.js", "binding.executionRoot",
        "evidenceFile(planId, uniqueRelative, binding.executionRoot)",
        "tools.read", "before evaluation", "source identity",
        "advertised installed `SKILL.md` path", "45-minute tool-stall watchdog",
        "bash timeout and codemode `timeout_ms` unset", "await nested calls",
        "first failed, interrupted or unavailable command",
        "capture failure", "unrun", "prior owned invocation",
        "detached runner, heartbeat or settings change",
      ]) expect(instruction).toContain(contract);
      expect(instruction).not.toContain("Managed workers retain findings-only authority");
    }
    expect(gates.indexOf("const source = await tools.read")).toBeLessThan(gates.indexOf("const recipe = eval(source)"));
    expect(gates.indexOf("Incomplete verification recipe source read")).toBeLessThan(gates.indexOf("const recipe = eval(source)"));
    expect(gates).toContain("recipe.version !== 1");
    expect(verify).toContain("Projects without the asset retain ordinary discovery");
    expect(execute).toContain("Projects without the asset retain ordinary discovery");
    expect(execute).toContain("does not transfer failed specialist authority or replace independent final review");
  });

  test("execute prepares only a reconciled captured checkout before dependent work", () => {
    const setup = execute.slice(execute.indexOf("## Prepare the captured checkout"), execute.indexOf("## Decisions"));
    expect(execute.indexOf("openExecutionPlan")).toBeLessThan(execute.indexOf("## Prepare the captured checkout"));
    expect(setup.indexOf("reconcile `## Workers`")).toBeLessThan(setup.indexOf("Inspect `binding.executionRoot`"));
    expect(setup.indexOf("Read the script")).toBeLessThan(setup.indexOf('bash ./scripts/setup.sh </dev/null'));
    for (const contract of [
      "running worker ends the turn", "unknown or unreconciled ownership blocks setup",
      "Unresolved holds block setup", "external symlink", "unreadable script",
      "Missing setup is supported", "failed or interrupted invocation leaves dependent work blocked",
      "root, script, dependency declarations/lockfile, runtime, and installed dependencies",
      "Missing dependencies or relevant changes invalidate it", "without an arbitrary retry budget",
      "Do not run setup during `$plan`, plan discovery, `/reload`, worker startup",
      "completion wake", "WorkBrief", "Setup success does not prove all gate-specific prerequisites",
    ]) expect(setup).toContain(contract);
    expect(setup).toContain('(cd "$executionRoot" && bash ./scripts/setup.sh </dev/null)');
    expect(setup).toContain("not an environment variable");
    expect(setup).toContain("before delegating dependent work");
    for (const contract of [
      "Project-owned setup", "missing CodeGraph index best-effort",
      "after dependency prerequisites pass", "Do not require CodeGraph, install it universally",
      "refresh an existing index", "optional CodeGraph warning in preparation evidence and the WorkBrief",
      "dependencies are ready and setup completed successfully",
      "does not relax failed or interrupted setup, evidence, or ownership rules",
    ]) expect(setup).toContain(contract);
  });

  test("planning decomposes for correctness and preserves proportional acceptance", () => {
    for (const policy of [plan, sequencing, architect]) {
      for (const criterion of ["uncertainty", "prerequisites", "contract cohesion", "meaningful feedback"]) {
        expect(policy).toContain(criterion);
      }
      expect(policy).toContain("unit quota");
    }
    expect(plan).toContain("not smaller units");
    expect(sequencing).toContain("Smallness is not the goal");
    for (const policy of [plan, sequencing]) {
      expect(policy).toContain("coupled readers and writers together");
      expect(policy).toContain("stable cohesive change");
      expect(policy).toContain("file counts, time caps, commit counts, or worker count");
    }
    expect(plan).toContain("Every meaningful unit needs acceptance criteria that name observable behavior and affected guarantees");
    expect(plan).toContain("proportional expected evidence");
    expect(sequencing).toContain("observable acceptance and affected guarantees");
    expect(sequencing).toContain("proportional evidence");
    expect(sequencing).toContain("grants no Git authority");
    expect(sequencing).not.toContain("Rebase onto clean trunk first");
  });

  test("existing architectural pass checks consequential premises without expanding authority", () => {
    expect(plan).toContain("During an architectural `$plan`");
    expect(plan).toContain("existing pass to check unit partition and ordering");
    expect(plan).toContain("Do not call Architect or Researcher for trivial work");
    expect(plan).toContain("one Architect pass");
    expect(plan).toContain("one independent Reviewer critique");
    expect(architect).toContain("existing architectural planning pass");
    expect(architect).toContain("do not require another role pass or Architect involvement in trivial work");
    for (const policy of [plan, architect]) {
      expect(policy).toContain("actual caller or integration path");
      expect(policy).toContain("repository facts");
      expect(policy).toContain("user guarantees");
      expect(policy).toContain("optional technical restrictions");
      expect(policy).toContain("architecture, scope, acceptance, or verification");
    }
    expect(architect).toContain("not a future Developer Team head's local task allocation");
    expect(plan).toContain("not Head nodes, leaf counts, or a prohibition on local subdivision");
    expect(plan).toContain("Ordered global units only. No global DAG");
    expect(plan).toContain("chooses direct implementation, decomposition, or a combination");
    expect(plan).toContain("does not change frozen scope, unit order, permissions, acceptance, or escalation requirements");
    expect(plan).toContain("not an exhaustive assumption register or a permission checkpoint");
    expect(plan).toContain("logical nonmutation does not imply that every SQLite sidecar byte must remain unchanged");
    expect(architect).toContain("Research or design does not authorize implementation");
  });

  test("planning resolves consequential producers instead of asserting guarantees", () => {
    const premises = plan.slice(plan.indexOf("## Consequential premises"), plan.indexOf("## Work units"));
    const responsibility = architect.slice(architect.indexOf("## Responsibility"), architect.indexOf("## Boundaries"));
    for (const policy of [premises, responsibility]) {
      expect(policy).toContain("source, producer, consumer, and capability or authority");
      expect(policy).toContain("supported way to produce and observe");
      expect(policy).toContain("independent completeness");
      expect(policy).toContain("contained worker");
      expect(policy).toContain("outside its permitted root");
      expect(policy).toMatch(/Resolve[\s\S]*before[\s\S]*dependent implementation/);
      expect(policy).toContain("early bounded");
      expect(policy).toContain("downstream decision it informs");
      expect(policy).toContain("known missing architecture decision");
    }
    expect(premises).toContain("failed check leaves dependent acceptance unproven");
    expect(premises).toContain("only for decision-changing premises in existing plan prose");
    expect(premises).toContain("not an exhaustive assumption register or a permission checkpoint");
  });

  test("ordinary handoffs preserve frozen intent and bounded current obligations", () => {
    const briefStart = execute.indexOf("Build a WorkBrief");
    const briefEnd = execute.indexOf("Developer implements");
    expect(briefStart).toBeGreaterThanOrEqual(0);
    expect(briefEnd).toBeGreaterThan(briefStart);
    const brief = execute.slice(briefStart, briefEnd);
    for (const field of [
      "plan id and revision", "frozen unit id, outcome, and objective", "relevant scope and invariants",
      "acceptance criteria and expected evidence", "relevant prerequisites and rulings",
      "upstream contracts or evidence references", "current unresolved obligations",
      "relevant prior failures", "consequential premise conclusions", "actual caller or integration path",
      "assigned purpose, requested result, and completion condition",
      "distinct from broader unit or final acceptance",
      "candidate and base identity, and permitted effects",
    ]) expect(brief).toContain(field);
    expect(brief).toContain("accepted, advisory, failed, or unavailable according to its actual source");
    expect(brief).toContain("A worker claim is not accepted evidence");
    expect(brief).toContain("Keep relevant valid evidence even when it is old");
    expect(brief).toContain("Exclude obsolete or unrelated context");
    expect(brief).toContain("Do not send the parent transcript");
    expect(brief).toContain("natural-language descriptions, not dispatch modes or a mandatory form");
    expect(brief).toContain("resolved references to actual reusable evidence");
    expect(brief).toContain("identify what remains uncovered");
    expect(brief).toContain("replacement report merely for a handoff");
    expect(brief).toContain("Existing required reports and identity checks remain required");
    expect(brief).toContain("Local subdivision stays local");
    expect(brief).toContain("A granted Head decides whether to create leaves");
    expect(brief).toContain("directly after the exclusive integration barrier");
    expect(brief).toContain("corrections, cleanup, and recovery");
    expect(brief).toContain("not a leaf count, node allocation, no-delegation rule, or sole-writer strategy");
    expect(brief).toContain("obligations and their basis");
    expect(brief).toContain("Do not prescribe a local strategy");
    expect(brief).toContain('explicit asynchronous `role: "developer"`, `mode: "head"` and authorized relative `writes`');
    expect(brief).toContain("including fresh follow-ups");
    expect(brief).toContain("or record the deliberate single-mode exception above");
    expect(brief).not.toContain("future Developer Team head");
    expect(brief).toContain("do not replace global acceptance or authorize replanning");
    expect(brief).toContain("Level 1 and Level 2 decision rules");
    for (const contract of [
      "decisive sources, producers, consumers, and capability or authority limits",
      "source and force of consequential restrictions within these fields",
      "User requirements, product contracts, frozen invariants, acceptance conditions, and actual authorization limits remain binding",
      "evidence with their limits and unresolved uncertainty",
      "Technical suggestions remain choices where the frozen contract permits alternatives",
      "compare the brief with the frozen unit and relevant rulings",
      "Do not omit obligations or turn an optional technical restriction into a binding prohibition",
      "Do not relabel a frozen invariant or acceptance condition as advisory because its author was the planner",
    ]) expect(brief).toContain(contract);
    expect(execute).toContain("Never ask the user to make a Level 1 or Level 2 decision");
    expect(execute).toContain("Use `verify-behavior` for diagnosis, affected regression, final gates");
    expect(execute).toContain("Mandatory gates and independent review remain required");
    expect(execute).toContain("Observation and steering do not transfer local scheduling to the coordinator");
    expect(execute).toContain("Explicit user constraints and existing safety or resource limits remain binding");
  });

  test("decision levels preserve equivalent choices and genuine binding authority", () => {
    const decisions = execute.slice(execute.indexOf("\n## Decisions\n"), execute.indexOf("\n## Workers\n"));
    expect(decisions).toContain("another equivalent technical choice within the accepted contract");
    expect(decisions).toContain("another internal design still preserves Goal, Non-goals, Scope, Invariants");
    expect(decisions).toContain("Consult Architect in background only when that uncertainty is real");
    expect(decisions).toContain("dependent decision pending until the required current-object answer is interpreted");
    expect(decisions).toContain("a change in security or privacy risk appetite");
    expect(decisions).toContain("unauthorized destructive or external side effect");
    expect(decisions).toContain("A coordinator's technical suggestion does not create a new permission requirement");
    expect(decisions).toContain("Preserve explicit frozen invariants and acceptance conditions regardless of who authored them");
    expect(decisions).toContain("Removing a binding condition still requires its existing authority");
    const loop = execute.slice(execute.indexOf("## Loop"), execute.indexOf("## Cleanup"));
    expect(loop).toContain("Known focused diagnosis and correction remain with the Developer, regardless of failure count");
    expect(loop).toContain("Architect resolves a missing design decision; Reviewer assesses an existing proposal");
    expect(loop).not.toContain("If the same underlying failure class repeats, ask Reviewer");
    expect(loop).toContain("ask Architect, record a Level 2 amendment");
  });

  test("optional advice preserves uncertainty routing, installed discovery and final authority", () => {
    const advice = verify.slice(verify.indexOf("### Optional JEV orientation"), verify.indexOf("Diagnose a concrete failure"));
    for (const boundary of [
      "advertised installed `SKILL.md` path", "tools.read({path: helperPath})",
      'helper.version !== 1',
    ]) expect(advice).toContain(boundary);
    expect(advice).toContain("Reject a failed read");
    expect(advice).toContain("Questions/categories are fixed by the helper");
    expect(advice).toContain("coordinator retains dispatch and ModelPolicy");
    expect(advice).toContain("waives or postpones mandatory independent final review");
    expect(advice).toContain("Unsent attempts have no request/response");
    expect(advice).toContain('`evidence: "staged"` is not a commitment receipt');
    expect(advice).toContain("physical native `codemode-store` entry");
    expect(advice).toContain("no credentials, retry, alternative model, installation task or mandatory consult");
    expect(execute).toContain("actual specialist question when known");
    expect(execute).toContain("Independent final review remains required and is never waived by advice");
  });

  test("verification owns diagnosis, wrapper coverage, and compatible evidence reuse", () => {
    expect(verify).toContain("Diagnose a concrete failure with a focused reproduction");
    expect(verify).toContain("run affected regression checks before repeating a broad final gate");
    expect(verify).toContain("Diagnostic success does not waive final gates or independent review");
    expect(verify).toContain("Check relevant environment prerequisites when evidence makes them material");
    expect(verify).toContain("A failed prerequisite leaves dependent checks unproven");
    expect(verify).toContain("Useful independent checks may still run");
    expect(verify).toContain("Do not impose universal fail-fast behavior, arbitrary run caps, or a preflight framework");
    expect(verify).toContain("its observed execution covers that obligation");
    expect(verify).toContain("arguments, inputs, environment, completeness, and required phase or binding");
    expect(verify).toContain("Partial logs, skipped checks, interrupted output, stale artifacts, or the same command string alone are insufficient");
    expect(verify).toContain("A final gate and a worker diagnostic command can be different obligations");
    expect(verify).toContain("Evidence from one binding does not satisfy a different required binding");
    expect(verify).toContain("inputs, environment, contract, completeness, and required phase or binding remain compatible");
    expect(verify).toContain("Do not discard valid evidence solely because it is old");
    expect(verify).toContain("Relevant edits after a pass invalidate affected conclusions, not every independent observation");
    expect(verify).toContain("It never cancels a mandatory gate or independent review");
    expect(verify).toContain("Do not run a cycle that re-enters the same verification stage or suite");
  });

  test("acceptance traces a permitted route without inventing isolation or permissions", () => {
    const units = plan.slice(plan.indexOf("## Work units"), plan.indexOf("## Critique and freeze"));
    const selection = verify.slice(verify.indexOf("## Select and observe evidence"), verify.indexOf("## Distinguish diagnosis"));
    for (const policy of [units, selection]) {
      expect(policy).toContain("compact permitted positive route from the actual entry point to the required observation");
      expect(policy).toContain("only material prerequisites: interaction driver, effective state and resource sharing, configuration, credentials, effect owner, authorization, and cleanup");
    }
    for (const contract of [
      "A worktree does not prove global-state isolation",
      "Private state is not inherently prohibited",
      "credentials symlink does not prove immutable credentials",
      "PTY or private-state route is permitted only if it preserves the required actual entry point, authorization, and resource constraints",
      "Preserve an explicit prohibition on credential persistence; do not invent one when absent",
      "Direct internal receipt creation cannot prove a native path it bypasses",
    ]) expect(selection).toContain(contract);
  });

  test("verification separates host, provider, advisory, and diagnostic claims", () => {
    const selection = verify.slice(verify.indexOf("## Select and observe evidence"), verify.indexOf("## Distinguish diagnosis"));
    for (const contract of [
      "Deterministic host checks prove their host contract or local mechanism, not an external model's completion",
      "Preserve a separately required real-provider demonstration",
      "Advisory observations, including passes, do not satisfy required acceptance checks",
      "grants no spending, external-effect, reset, or budget authority",
      "Workers retain their assigned purpose, permitted effects and completion conditions",
      "a worker result is not coordinator acceptance",
      "Standalone consumers retain their existing scope and authority",
      "requires no plan, setup, or new evidence artifact",
    ]) expect(selection).toContain(contract);
    const diagnosis = verify.slice(verify.indexOf("## Distinguish diagnosis"), verify.indexOf("## Reuse evidence"));
    for (const contract of [
      "early reachable evidence for consequential interactions",
      "persistence and fallback before the first assistant",
      "does not replace a separately required real-provider demonstration or establish that a dependency caused the defect",
      "Diagnose a dependency only as needed to locate the failing boundary of the authorized objective",
      "Report out-of-scope findings and whether they block required acceptance",
      "do not turn diagnosis into dependency maintenance",
    ]) expect(diagnosis).toContain(contract);
  });

  test("design ordering and independent checks do not change frozen execution authority", () => {
    const units = plan.slice(plan.indexOf("## Work units"), plan.indexOf("## Critique and freeze"));
    const sequenceDesign = sequencing.slice(0, sequencing.indexOf("**Execution.**"));
    for (const policy of [units, sequenceDesign]) {
      expect(policy).toContain("integration-only or approval waits after independently verifiable implementation outcomes when real dependencies permit");
      expect(policy).toContain("Do not postpone a compatibility check that could invalidate those outcomes");
    }
    expect(units).toContain("does not permit skipping or reordering frozen units during execution");
    const loop = execute.slice(execute.indexOf("## Loop"), execute.indexOf("## Cleanup"));
    const sequenceExecution = sequencing.slice(sequencing.indexOf("**Execution.**"), sequencing.indexOf("**Delivery.**"));
    const diagnosis = verify.slice(verify.indexOf("## Distinguish diagnosis"), verify.indexOf("## Reuse evidence"));
    for (const policy of [loop, sequenceExecution, diagnosis]) {
      expect(policy).toMatch(/useful independent (?:current-unit )?checks/i);
      expect(policy).toMatch(/ownership, unresolved Team holds, (?:and|or) setup restrictions/);
      expect(policy).toContain("Failed or interrupted setup permits only non-dependent read-only diagnosis, not implementation writes or dependent checks");
    }
    expect(loop).toContain("Do not start the next unit until this unit is verifiable");
    expect(loop).toContain("Independent checks do not accept the incomplete unit");
    expect(sequenceExecution).toContain("An incomplete unit still blocks the next unit");
    expect(sequenceExecution).toContain("grants no replanning, reordering, or workflow authority");
    expect(diagnosis).toContain("do not accept an incomplete unit, start a later unit, skip a required check, or waive final review");
  });

  test("realizability and interacting-contract critique stays planning-only", () => {
    const delegation = plan.slice(plan.indexOf("## Architect and Reviewer"), plan.indexOf("## Artifact"));
    expect(delegation).toContain("In that planning critique");
    expect(delegation).toContain("acceptance realizability and relevant interacting contracts, including dependency-correct ordering");
    expect(delegation).toContain("does not authorize implementation replanning or reordering");
    const responsibility = reviewer.slice(reviewer.indexOf("## Responsibility"), reviewer.indexOf("## Boundaries"));
    expect(responsibility).toContain("During the existing architectural planning critique only");
    expect(responsibility).toContain("acceptance realizability, material route prerequisites, and relevant interacting contracts");
    expect(responsibility).toContain("early invalidating compatibility checks");
    expect(responsibility).toContain("not an additional pass or an exhaustive matrix");
    const boundaries = reviewer.slice(reviewer.indexOf("## Boundaries"), reviewer.indexOf("## Output"));
    expect(boundaries).toContain("does not authorize implementation replanning or reordering");
    expect(boundaries).toContain("Implementation review judges the frozen contract and ordered units, not a replacement sequence");
    expect(boundaries).toContain("Do not edit or fix");
  });

  test("plan freezes and does not grant implementation", () => {
    expect(plan).toContain("Never implement");
    expect(plan).toContain("PLAN_FROZEN");
    expect(plan).toContain("Do not invoke $execute");
    expect(plan).toContain("Watched Team assignments inherit the exact binding automatically");
    expect(plan).toContain("execution: expected");
    expect(plan).toContain("initLedger(ledgerFile(id, cwd), meta)");
    expect(plan).not.toContain("execution: expected #");
    const sample = plan.match(/```markdown\n([\s\S]*?)\n```/)?.[1];
    expect(sample).toBeDefined();
    expect(parsePlanDocument(sample!).execution).toBe("expected");
    expect(plan).toContain("board_workflow_claim");
    expect(plan).toMatch(/After freezing[\s\S]*?initLedger\(ledgerFile\(id, cwd\), meta\)[\s\S]*?before resolving/);
    expect(plan).toContain("agent_run");
    expect(plan).toContain("design-only");
    expect(plan).not.toMatch(/openai|anthropic|gpt-|claude|grok/i);
  });

  test("execute is explicit, scoped, and does not replan", () => {
    expect(execute).toContain("status: frozen");
    expect(execute).toContain("openExecutionPlan");
    expect(execute).toContain("existing execution-root ledger first");
    expect(execute).toContain("USER_DECISION_REQUIRED");
    expect(execute).toContain("Persist `status: USER_DECISION_REQUIRED` in ledger frontmatter");
    expect(execute).toContain("execution: expected");
    expect(execute).toContain("Explicit abandonment of the whole workflow");
    expect(execute).toContain("Failed, cancelled, and no-outcome holds remain blocking across reload");
    expect(execute).toContain("WorkBrief");
    expect(execute).toContain("Do not send the parent transcript");
    expect(execute).toContain("Do not invoke $plan");
    expect(execute).toContain("Level 1");
    expect(execute).toContain("Level 2");
    expect(execute).toContain("Level 3");
    expect(execute).toContain("same Developer");
    expect(execute).toContain("Other long specialist work uses `team_assign` when registered");
    expect(execute).toContain("exterior Team assignment ID for tables or Team");
    expect(execute).toContain("Interpret complete `pitako.worker.result` messages supplied automatically in context");
    expect(execute).toContain("optional, complete, idempotent diagnostic re-reads");
    expect(execute).toContain("They neither transport the automatic result nor acknowledge incorporation");
    expect(execute).not.toContain("call `team_result` once");
    expect(execute).toContain("call `team_status` with its assignment ID");
    expect(execute).not.toContain("`agent_result` once");
    expect(execute).toContain("call `agent_status` with its instance ID");
    expect(execute).toContain("Keep at most one Developer role active, without exception.");
    expect(execute).not.toContain("unless the frozen plan already assigns non-overlapping work");
    expect(execute).toContain("agent_spawn");
    expect(execute).toContain("agent_run");
    expect(execute).toContain("## Workers");
    expect(execute).toContain("not foreground implementation");
    expect(execute).toContain("only when no agent or Team tools are registered");
    expect(execute).not.toContain("`agent_run` unavailable still means implement inline");
    expect(execute).not.toContain("If `agent_run` is unavailable, implement inline");
    expect(execute).toContain("Consult Architect in background");
    expect(execute).not.toContain("When `agent_run` is available, you coordinate");
    expect(execute).toContain("bindingMismatch");
    expect(execute).not.toMatch(/openai-codex|anthropic\/|gpt-5|claude-/);
  });

  test("Architect and Reviewer dependencies release the turn without synchronous fallback", () => {
    for (const policy of [plan, execute]) {
      for (const contract of [
        "use only `architecture_start` and `review_start`",
        "required start is unavailable", "blocked",
        "No individual, synchronous or inline fallback and no waived review",
        "assignment turn", "keep a call open",
      ]) expect(policy).toContain(contract);
      expect(policy).toMatch(/end the turn/i);
      expect(policy).not.toContain("A sync dependency uses `agent_run`");
      expect(policy).not.toContain("stays a synchronous call");
      expect(policy).not.toContain("call the Architect role with `agent_run`");
    }
    expect(plan).toContain("Do not freeze before interpreting the required current-object judgment");
    expect(execute).toContain("including Level 2 questions, judgments needed for the next action, and final independent review");
    expect(execute).toContain("Do not decide a Level 2 amendment, accept a unit, start a dependent unit, or declare `EXECUTION_COMPLETED` before interpreting");
    expect(execute).toContain("does not authorize later units or waive ordered units, independent critique, final review, or gates");
    expect(execute).toContain("frozen `plan` and relevant `unit`, preserving the existing binding and execution root");
  });

  test("planning correlation and operational checkpoints do not create or bypass Team Holds", () => {
    for (const contract of [
      "check the draft's explicit Board binding and existing ledger",
      "For a bound draft without a ledger, call `architecture_start` without `plan` or `unit`",
      "do not pass an explicit topic to bypass this rule",
      "For an unbound draft or a compatible existing ledger",
      "prospective, validated `plan` ID", "distinct, scoped `unit` ID per consultation",
      "incompatible ledger or real Team hold remains a blocker",
      "omitting correlation must not bypass it",
      "Do not create an execution ledger or Board binding during planning",
      "Record role, purpose, handle type and exact ID, pending decision, and consulted object",
      "Team assignment ID for Team", "worker instance ID for `agent_spawn`",
      "with or without correlation", "operational checkpoint, not a Team Hold or acceptance evidence",
      "Exclude `## Planning workers` from the consulted object",
      "explicitly instruct the worker to ignore that section",
    ]) expect(plan).toContain(contract);
    const freeze = plan.slice(plan.indexOf("## Critique and freeze"));
    expect(freeze.indexOf("required results are interpreted")).toBeLessThan(freeze.indexOf("remove `## Planning workers`"));
    expect(freeze.indexOf("remove `## Planning workers`")).toBeLessThan(freeze.indexOf("Set `status: frozen`"));
    expect(freeze).toContain("removal does not invalidate critique");
    expect(freeze).toContain("operational section was excluded from the consulted object");
    expect(freeze).toContain("Integrating corrections requested by critique does not itself require another consultation");
    expect(freeze).toContain("material blocker or a change outside the reviewed object");
  });

  test("review tables replace the existing pass, retaining independence and exterior report authority", () => {
    for (const policy of [plan, execute, prePr]) {
      for (const contract of [
        "Use `review_start` for the existing independent Reviewer",
        "zero to five optional specialists", "utility with reasons",
        "Selective recomposition", "knowledge, not judge findings", "Corrections remain outside the table",
        "actual returned exterior Team assignment", "physical closure and comparison with the current object",
        "top-level `completion` and `verdict`", "not nested synthesis, dispositions",
        "A final inconclusive judgment blocks approval", "not coordinator acceptance",
        "No `review_read` or result fetch is required for transport or acknowledgement",
        "Material object edits invalidate affected judgment",
      ]) expect(policy).toContain(contract);
      expect(policy).not.toContain("Ordinary Reviewer remains the default");
      expect(policy).not.toContain("one to five");
    }
    expect(plan).toContain('object: {kind: "plan", planId}');
    expect(plan).toContain("same correlation rules to `review_start`");
    expect(plan).toContain("object's `planId` still identifies the text to critique");
    expect(plan).toContain("prospective correlation without creating a ledger or Board binding");
    for (const policy of [execute, prePr]) {
      expect(policy).toContain('object: {kind: "diff", base:');
      expect(policy).toContain("staged, unstaged and applicable non-ignored untracked files");
      expect(policy).toContain("clean-tree or commits-only");
    }
    expect(execute).toContain("Pass the frozen `plan` and relevant `unit` to `review_start`");
    expect(prePr).toContain("This standalone pass omits `plan`, `unit` and `boardTopicId`");
    expect(reviewer).toContain("A mandate focuses investigation but does not forbid reporting other material defects.");
    // Instruction assertions establish assembly, not future model obedience.
  });

  test("optional planning architecture consumes only the exterior current-object judgment", () => {
    for (const contract of [
      '`architecture_start` has no `mode`',
      "Trivial work needs no table", "one substantive Architect director/root", "zero to five optional internal specialists",
      "utility", "a reason even for zero", "Selective recomposition",
      "required current-object judgment", "unit partition/order",
      "do not add a duplicate independent Architect pass",
      "Keep Reviewer separate from the designers", "not a frozen plan or its independent critique",
      "record only the exterior root assignment", "use only that root for watched completion",
      "Internal member IDs and room messages cannot close the root's hold",
      "complete terminal current-object judgment after owned closure",
      "Partial, failed and cancelled results retain applicable holds", "bookkeeping, not acceptance",
    ]) expect(plan).toContain(contract);
    expect(plan).not.toContain("extra Architects and Reviewers");
    for (const policy of [plan, execute]) expect(policy).not.toContain("If Team rejects a reserved role");
    expect(execute).toContain("execute workflow restriction, not an engine singleton reservation per role");
    const architecture = readFileSync(path.join(packageRoot(), "docs/architecture.md"), "utf8");
    const examples = [...architecture.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!));
    expect(examples).toHaveLength(2);
    expect(examples[0]).toMatchObject({ plan: "storage-design", unit: "architect-pass" });
    for (const key of ["plan", "unit", "boardTopicId"]) expect(examples[1][key]).toBeUndefined();
    for (const example of examples) {
      expect(example.mode).toBeUndefined();
      expect(example.goal).toContain("current");
      expect(example.goal.toLowerCase()).toContain("ignore ## planning workers");
      expect(example.goal).toContain("do not modify product files");
      expect(example.goal).toContain("unit partition/order");
    }
  });

  test("background checkpoints interpret full results and distinguish planning loss from execution recovery", () => {
    for (const policy of [plan, execute]) {
      for (const contract of [
        "Handles are session-local", "check each recorded handle once by type",
        "`team_status`", "assignment ID", "`agent_status`", "instance ID",
        "A wake, terminal status, steering receipt, or bookkeeping result is not the required judgment",
      ]) expect(policy.toLowerCase()).toContain(contract.toLowerCase());
    }
    expect(plan).toContain("If still active in the same session, end the turn");
    expect(plan).toContain("Only in planning, an unknown handle after reload or process loss permits one replacement consultation");
    expect(plan).toContain("record the loss, then assign a fresh current-object WorkBrief");
    expect(plan).toContain("A known failure is not an unknown handle");
    expect(plan).toContain("does not recover Team Holds or authorize execution");
    expect(plan).toContain("real holds and incompatible ledgers retain their existing recovery requirements");
    expect(execute).toContain("If the handle is unknown, record a blocker");
    expect(execute).toContain("planning-only lost-consultation replacement does not apply in execution");
    expect(execute).toContain("preserve Team Hold reconciliation and recovery");
  });

  test("object changes and admission blockers cannot reuse stale judgments or bypass ownership", () => {
    for (const policy of [plan, execute]) {
      for (const contract of [
        "Compare new user information with the consulted object and original WorkBrief",
        "If information changes the object outside the WorkBrief",
        "inapplicable to the pending decision",
        "Interpret its automatic result when supplied, but do not use it to close that decision",
        "or apply the change after accepting the old judgment",
        "Cancel the exact still-active target with `team_cancel` or `agent_cancel` according to handle type",
        "End the turn while settlement and member release are pending",
        "Only after settlement and member release, assign a fresh WorkBrief against the current object",
        "policy/resource or binding blocker from an unknown handle",
        "End the turn without polling or fallback while owned settlement is pending",
        "only after its actual blocker is resolved",
        "Another assignment's result does not answer this consultation",
        "Do not use `agent_spawn` or `agent_run` to evade admission rejection",
        "Cancellation alone proves neither settlement nor member release",
        "Neither `queued` nor `handled` proves correction or replaces a new consultation",
      ]) expect(policy).toContain(contract);
      expect(policy).not.toContain("Apply it after interpreting the supplied result, cancel the worker");
    }
    expect(execute).toContain("a new assignment does not clear a blocking hold");
  });

  test("active orchestration guidance interprets supplied results without fetching or accepting work", () => {
    const coordinator = readFileSync(path.join(packageRoot(), "roles/coordinator.md"), "utf8");
    expect(plan).toContain("complete settled results automatically supplied in context");
    expect(plan).toContain("optional exact-assignment diagnostic re-read");
    expect(plan).not.toContain("on each watched completion wake, call");
    expect(execute).toContain("Automatic collection reconciles only a successful assignment's own result hold");
    expect(execute).toContain("it does not accept work or complete a unit");
    expect(execute).toContain("Bookkeeping failure is reported separately and never hides the full result");
    expect(router).toContain("do not poll or acknowledge collection");
    expect(router).toContain("Automatic handoff is not work acceptance or unit completion");
    expect(coordinator).toContain("not transport or acknowledgement");
    expect(coordinator).toContain("does not accept the work or expand specialist authority");
  });

  test("published guidance reserves Architect and Reviewer for tables while preserving allowed synchronous runs", () => {
    const readme = readFileSync(path.join(packageRoot(), "README.md"), "utf8");
    const engineering = readFileSync(path.join(packageRoot(), "docs/engineering.md"), "utf8");
    for (const policy of [router, readme, engineering]) {
      expect(policy).toContain("use only `architecture_start` and `review_start`");
      expect(policy).toMatch(/block(?:ed)?/);
      expect(policy).toMatch(/automat(?:ic|ically)/);
      expect(policy).not.toContain("Use `team_assign` only for independent work");
      expect(policy).not.toContain("Team assignments remain independent work");
    }
    expect(readme).toContain("`agent_run` for one synchronous in-process AgentInstance");
    expect(engineering).toContain("`agent_run` stays synchronous");
    expect(router).toContain("`agent_run` executes an allowed individual instance synchronously");
  });

  test("execute selects exterior Head across implementation phases without changing the optional API", () => {
    const workers = execute.slice(execute.indexOf("Keep at most one exterior Developer"), execute.indexOf("### Reconcile an existing ordinary Developer")).replace(/\s+/g, " ");
    for (const contract of [
      "Every new exterior Developer assignment serving an execute implementation unit must use",
      'asynchronous `role: "developer"`, `mode: "head"`, and explicit authorized `writes`',
      "initial implementation, implementation-related diagnosis, correction, focused in-unit verification, product cleanup edits, and recovery",
      "use `agent_spawn` only when Team is not registered",
      "Small scope, short duration, and a no-leaf strategy are not single-mode exceptions",
      "use `[]` for no authorized product writes",
      'Do not grant `["."]` by default or derive writes from a leaf count',
      "explicit user requirement for ordinary single Developer, or prohibition of Head itself",
      'deliberately dispatch `mode: "single"` without `writes`',
      "prohibition on leaves or parallelism alone does not prohibit Head",
      "existing decision levels, not an automatic downgrade",
      "Missing `developer_head` policy, invalid envelope, conflicting exterior Developer ownership, unavailable asynchronous Head support, and execution-binding rejection are concrete blockers",
      "do not omit `mode`, call `agent_run`, switch transport to evade rejection, edit personal configuration, or take over implementation",
      "Configured Head ModelPolicy fallback is unchanged",
      "Ordinary APIs outside execute still default omitted mode to single",
      "Every asynchronous Developer Head has local checkpoint capability from admission",
      "do not withhold it or request an activation flag",
      "Let Head choose useful quiescent progress points for fast recovery",
      "Explicit `checkpoint_origin` continuation requires host-validated exact source/index/root compatibility and positive predecessor/contributor closure",
      "Unsupported repositories truthfully refuse checkpoint creation",
    ]) expect(workers).toContain(contract);
    expect(execute).not.toContain('may explicitly use `mode: "head"`');
    expect(execute).toContain("synchronous-only tools do not activate that exception");

    const correction = execute.slice(execute.indexOf("If verification fails in an implementation assignment"), execute.indexOf("## Cleanup")).replace(/\s+/g, " ");
    expect(correction).toContain("Keep ordinary in-scope correction with the responsible active Developer");
    expect(correction).toContain("select Head again for the remaining outcome");
    const cleanup = execute.slice(execute.indexOf("## Cleanup"), execute.indexOf("## Review")).replace(/\s+/g, " ");
    expect(cleanup).toContain("Product cleanup edits require a fresh asynchronous Developer Head assignment after the prior Developer has physically settled");
    expect(cleanup).toContain("A no-op cleanup creates no Developer");
    expect(cleanup).toContain("Setup, ledger and Board bookkeeping, the principal final typecheck-then-test procedure, independent review, and acceptance are non-Developer responsibilities");
    expect(cleanup).toContain("Never delegate the principal final complete procedure as cleanup or focused verification");
    for (const file of ["README.md", "docs/engineering.md"]) {
      const docs = readFileSync(path.join(packageRoot(), file), "utf8").replace(/\s+/g, " ");
      expect(docs).toContain("optional");
      expect(docs).toContain('`role: "developer"`, `mode: "head"`');
      expect(docs).toContain("`writes: []`");
      expect(docs).toContain("fresh Head after prior physical settlement");
      expect(docs).toContain("no-op cleanup creates no Developer");
      expect(docs).toContain("principal final typecheck-then-test procedure");
    }
  });

  test("execute delivers blocked ordinary-to-Head transition rather than inventing closure proof", () => {
    const transition = execute.slice(execute.indexOf("### Reconcile an existing ordinary Developer"), execute.indexOf("Compare new user information")).replace(/\s+/g, " ");
    // Instruction-delivery proof only: no fake successful replacement after a pending cancel.
    for (const contract of [
      "cannot gain Head authority through steering",
      "preserve its WorkBrief, binding, effects, and evidence",
      "policy deviation, not a runtime admission rejection",
      "Cancel only that exact assignment by its handle type",
      "End the turn for physical settlement",
      "already-returned model-facing host proof of released closure for that exact handle, required hold recovery, and normal admission",
      "Without that proof, no Head starts in this invocation",
      "preserve the blocker, affected resources, and holds",
      "A normal `team_cancel` receipt reports pending closure, not released closure",
      "Later `team_status` omits closure",
      "`agent_status` excludes Team-owned workers",
      "History seals invocation groups, not execution groups",
      "wake or automatic result content",
      "hidden tool details",
      "worker self-report do not substitute",
      "Do not recancel, poll, probe another assignment, switch transport, or add an observation API",
      "later authorized admission may assign Head only after the role is free",
      "Failed, cancelled, and no-outcome holds never clear merely because a new Head starts",
      "Retain already physically settled useful ordinary work",
      "do not replay it to manufacture a Head handoff",
      "Assign only the remaining outcome",
    ]) expect(transition).toContain(contract);
  });

  test("execute and pre-pr order cleanup before final gates and review", () => {
    const finalPonytail = execute.indexOf("one deliberate Ponytail pass over the complete finished diff");
    const preCleanupChecks = execute.indexOf("Require current sufficient passing affected-check evidence", finalPonytail);
    const deslopPass = execute.indexOf("Run `remove-ai-slops` only", preCleanupChecks);
    const postCleanupChecks = execute.indexOf("After cleanup, rerun checks invalidated by the edits", deslopPass);
    const finalGates = execute.indexOf("Run applicable final gates after all edits", postCleanupChecks);
    const finalReview = execute.indexOf("the single final review", finalGates);
    expect(finalPonytail).toBeGreaterThanOrEqual(0);
    expect(preCleanupChecks).toBeGreaterThan(finalPonytail);
    expect(deslopPass).toBeGreaterThan(preCleanupChecks);
    expect(postCleanupChecks).toBeGreaterThan(deslopPass);
    expect(finalGates).toBeGreaterThan(postCleanupChecks);
    expect(finalReview).toBeGreaterThan(finalGates);
    expect(execute).toContain("must be green before `remove-ai-slops`");
    for (const policy of [execute, prePr]) {
      expect(policy).toContain("current sufficient passing affected-check evidence");
      expect(policy.toLowerCase()).toContain("rerun only when edits or other relevant changes invalidate evidence");
      expect(policy).toContain("an applicable gate requires a new observation");
      expect(policy).toContain("A no-op pass alone does not require duplicate checks");
    }
    expect(execute).not.toContain("Run affected focused checks after that pass");
    expect(prePr).not.toContain("5. Run affected focused checks.");
    expect(execute).toContain("complete final diff");
    expect(execute).toContain("An evidenced A-only cleanup does not require a second review solely for cleanup when adequate independent review already covers it");
    expect(execute).toContain("B or uncertain changes need an independent Reviewer on the complete final diff");
    expect(execute).toContain("Any B or uncertain edit after approval invalidates that approval");
    expect(execute).toContain("rerun affected checks and applicable final gates");

    const prePrPonytail = prePr.indexOf("make one final Ponytail pass over the whole scoped diff");
    const prePrChecks = prePr.indexOf("Require current sufficient passing affected-check evidence", prePrPonytail);
    const prePrDeslop = prePr.indexOf("apply `remove-ai-slops` selectively to durable prose", prePrChecks);
    const prePrAfterChecks = prePr.indexOf("Rerun checks invalidated by prose edits", prePrDeslop);
    const prePrGates = prePr.indexOf("Run applicable final gates", prePrAfterChecks);
    expect(prePrPonytail).toBeGreaterThanOrEqual(0);
    expect(prePrChecks).toBeGreaterThan(prePrPonytail);
    expect(prePr.indexOf("Once affected checks are green", prePrChecks)).toBeLessThan(prePrDeslop);
    expect(prePrDeslop).toBeGreaterThan(prePrChecks);
    expect(prePrAfterChecks).toBeGreaterThan(prePrDeslop);
    expect(prePrGates).toBeGreaterThan(prePrAfterChecks);
    expect(prePr).toContain("B requires an independent Reviewer to assess the whole final diff");
    expect(prePr).toContain("An evidenced A does not require a second review solely for cleanup when adequate independent review already covers it");
    expect(prePr).toContain("Any B or uncertain edit after approval invalidates that approval");
    expect(prePr).toContain("rerun affected checks and applicable final gates");
    expect(prePr).toContain("does not self-review or edit the scoped diff");
    expect(prePr).toContain("If an independent Reviewer is unavailable, report `BLOCKED`");
    expect(prePr).toContain("The Reviewer does not fix findings; the Developer resolves material findings.");
    expect(prePr).toContain("This exception does not waive `$execute`'s required final review");
    expect(deslop).toContain("Standalone `$pre-pr` invokes this skill only for durable prose touched by its diff");
    expect(deslop).toContain("This prose-only restriction overrides the code cleanup ideas below");
    expect(deslop).toContain("does not change `$execute` behavior");
    expect(deslop).toContain("does not require an `$execute` ledger or `deslop.md`");
    expect(router).toContain("Prepare a local diff for publication without `$execute`");
  });

  test("final review contract covers the full diff and execute cleanup classes", () => {
    expect(execute).toContain("demonstrably nonsemantic subtraction");
    expect(execute).toContain("checks or other evidence supporting unchanged behavior and contracts");
    expect(execute).toContain("potentially semantic or uncertain");
    expect(execute).toContain("logic, state, lifecycle, concurrency, paths, security, privileges, output, or contracts");

    const prePrGates = prePr.indexOf("Run applicable final gates");
    const prePrReview = prePr.indexOf("Before reporting readiness", prePrGates);
    expect(prePrGates).toBeGreaterThanOrEqual(0);
    expect(prePrReview).toBeGreaterThan(prePrGates);
    expect(prePr).toContain("If no independent review covers the complete final diff, including when review is absent or inadequate, obtain one.");
    expect(prePr).toContain("must not create a plan, ledger, or Board topic");
  });

  test("pre-pr comparison covers missing, empty, and uncommitted changes", () => {
    expect(prePr).toContain("If the base is missing, ambiguous, unavailable locally, conflicts with other evidence, or has no merge-base with `HEAD`, ask for a base and report `BLOCKED`.");
    expect(prePr).toContain("staged and unstaged edits, and relevant non-ignored untracked files");
    expect(prePr).toContain("If the scoped diff is empty, report `BLOCKED`");
    expect(prePr).toContain("A provisional base caps status at `READY_WITH_CAVEAT`");
    expect(prePr).toContain("the base is unambiguous and non-provisional");
    expect(prePr).toContain("git rev-list --left-right --count <base>...HEAD");
    expect(prePr).toContain("report when `HEAD` is behind the base");
    expect(prePr).toContain("Inspect staged and unstaged scoped changes and relevant untracked files during cleanup; do not omit them from review.");
    expect(prePr).toContain("Any staged, unstaged, or relevant non-ignored untracked scoped changes, secrets, or generated residue block readiness.");

    const readyStart = prePr.indexOf("- `READY_TO_PUSH`:");
    const caveatStart = prePr.indexOf("- `READY_WITH_CAVEAT`:", readyStart);
    const readyToPush = prePr.slice(readyStart, caveatStart);
    expect(readyToPush).toContain("scoped Git status is clean");
    expect(readyToPush).toContain("committed push payload (`git diff <base>...HEAD`) exactly matches the reviewed final diff");
  });

  test("pre-pr stays local, standalone, and blocks unmet gates", () => {
    expect(prePr).toContain("requires no `$plan`, frozen plan, `$execute`, ledger, or Board topic");
    expect(prePr).toContain("Work only in the top level of the current process cwd's worktree.");
    expect(prePr).toContain("Do not inspect, create, add, or switch to another worktree or branch.");
    expect(prePr).toContain("Keep changes within the current diff.");
    expect(prePr).toContain("This is guidance, not enforcement.");
    expect(prePr).toContain("Never commit, push, force-push, merge, fetch, use `gh`, read or write a remote PR, create or update a PR, or perform any other remote action.");
    expect(prePr).toContain("Do not claim the skill technically prevents these actions.");
    expect(prePr).toContain("- `BLOCKED`:");
    expect(prePr).toContain("a required gate fails or is unavailable");
  });

  test("economy, resume, and cleanup stay in the skills", () => {
    expect(execute).toContain("Caveman");
    expect(execute).toContain("not for ledger");
    expect(execute).toContain("Unslop");
    expect(execute).toContain("Ponytail");
    expect(execute).toContain("no separate Ponytail agent");
    expect(execute).toContain("remove-ai-slops");
    expect(execute).toContain("not after every edit");
    expect(execute).toContain("files changed by this run");
    expect(execute).toContain("must be green before `remove-ai-slops`");
    expect(execute).toContain("verify again");
    expect(execute).toContain("read the plan and the ledger before evidence");
    expect(execute).toContain("stale conversation");
    expect(execute).toContain("Board is not a progress log");
    expect(deslop).toContain("Default scope is files changed by this execution.");
    expect(deslop).toContain("Standalone `$pre-pr` invokes this skill only for durable prose touched by its diff");
    expect(deslop).toContain("verified");
    expect(deslop).toContain("verify again");
    expect(deslop).not.toContain("250");
  });
});
