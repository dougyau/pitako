import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAgentDir, parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveWorkflowResource } from "../node_modules/pi-subagents/src/workflows/workflow-resources.js";
import { runWorkflowScript, validateWorkflowScript } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { resolvePiLaunchToolPlan } from "../node_modules/pi-subagents/src/runs/shared/child-tool-plan.js";
import { discoverAgents, discoverAgentsAll } from "../node_modules/pi-subagents/src/agents/agents.js";
import { handleManagementAction } from "../node_modules/pi-subagents/src/agents/agent-management.js";
import { executeMaxCycles } from "../extensions/execute-settings.ts";
import planExecute, { executionResource } from "../extensions/plan-execute.ts";
import { profileNote } from "../extensions/profile.ts";
import { DEFAULT_SKILL_NAMES } from "../extensions/catalog.ts";
import { digest, inspectionSnapshot, MAX_SPEC_BYTES, SPEC_SECTIONS, specChunks, validateSpec } from "../extensions/spec-plans.ts";

const roots: string[] = [], disposers: (() => void)[] = [];
const workflowSettlements: Promise<void>[] = [];
afterEach(async () => {
  // A runner timeout does not settle a test's workflow continuation.
  await Promise.all(workflowSettlements.splice(0));
  for (const dispose of disposers.splice(0)) dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const read = (name: string) => readFileSync(path.resolve(name), "utf8");
function repository() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-workflow-resource-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"); return root;
}
function resourceWithAgentDir(agentDir: string) {
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try { return executionResource("linux"); }
  finally { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; }
}

// Controlled child boundary: actual root/review scripts execute in the native sandbox.
// Responses implement schemas only; no provider or model obedience is certified.
function childResponse(key: string, request: any, metadata: any, checkout: any, completeLoop = 1) {
  const loop = Number(key.match(/\.l(\d+)\./)?.[1] ?? 1);
  let value: any;
  const task = { id: "final", kind: "verification", goal: "Verify complete candidate", contextRefs: ["full spec"],
    sourceRefs: [metadata.selected.source], scope: [metadata.root], allowedEffects: ["checks"], expectedResult: "Current required checks",
    checks: [{ id: "final-check", requirement: "All specs", command: "bun test affected", cwd: metadata.root }] };
  if (key.endsWith(".director")) value = { status: "plan", reason: "Complete ordered work", association: {
    missionId: "native.mission-1", missionPath: "/native/actual-mission.json", invocation: "human-1", loop, maxCycles: 3, sourceRefs: [],
    root: metadata.root, commonDir: metadata.commonDir, source: metadata.selected.source, digest: metadata.selected.digest,
  }, sharedContext: { material: "Full shared context", references: [metadata.selected.source] }, tasks: [task] };
  else if (request.agent === "pitako.worker") value = { taskId: "final", attempt: 1, status: "complete", workDone: "Required checks executed",
    remaining: [], diagnosis: "No pending task work", usefulProgress: true, continuation: null,
    git: { head: checkout.head, checkpoints: [], wip: "Current WIP included" }, candidate: checkout,
    checks: task.checks.map(check => ({ ...check, output: "Controlled check passed", logPaths: ["/native/check.log"], result: "passed", before: checkout, after: checkout })) };
  else if (key.endsWith("director-prepare")) value = { status: "ready", reason: "Whole result perspectives", angles: [
    { id: "a", focus: "Correctness", skills: [] }, { id: "b", focus: "Requirements", skills: [] }] };
  else if (key.includes("independent-")) value = { status: "ready", reason: "Source inspected", coverage: "Complete candidate", findings: [] };
  else if (key.endsWith("director-synthesis")) value = { status: "ready", reason: "No material gaps", memo: "Whole-result analysis",
    dispositions: [], screening: { verdict: "clear", reason: "Current candidate inspected", assessments: [] } };
  else if (key.endsWith(".compliance")) value = { status: loop >= completeLoop ? "fulfilled" : "gaps", reason: "Complete requirement inventory",
    candidate: checkout, requirements: Array.from({ length: 17 }, (_, index) => ({ id: `criterion-${index + 1}`, source: `spec:criterion-${index + 1}`,
      reason: "Current source/check evidence", status: loop >= completeLoop ? "fulfilled" : "gap", evidence: ["src/entry.ts:1"], checks: ["/native/check.log"] })) };
  else throw Error(`Unexpected child ${key}`);
  return { key, ok: true, output: "", runId: `native-${key}`, agent: request.agent ?? "pitako.reviewer", artifactPaths: [], structuredOutput: value };
}
const checkout = { head: "a".repeat(40), fingerprint: "b".repeat(64) };

describe("plan/execute packaged composition", () => {

  test("settings admission preserves startup A relative agent dir when execute runs in B", () => {
    const operation = runSettingsAdmission();
    workflowSettlements.push(operation.then(() => {}, () => {}));
    return operation;
  });

  async function runSettingsAdmission() {
    const startup = repository(), root = repository();
    const relative = "agent config ' & %PATH% ! 雪";
    const global = path.join(startup, relative), wrongGlobal = path.join(root, relative);
    mkdirSync(global); mkdirSync(wrongGlobal); mkdirSync(path.join(root, ".pi"));
    const globalFile = path.join(global, "settings.json"), wrongFile = path.join(wrongGlobal, "settings.json");
    const projectFile = path.join(root, ".pi/settings.json");
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
    const snapshotDigest = digest(content);
    writeFileSync(globalFile, '\uFEFF{"pitako":{"execute":{"maxCycles":2}}}');
    // Real resource creation in startup cwd A, with resolution and host execution in B.
    const setup = `
      import { executionResource } from ${JSON.stringify(path.resolve("extensions/plan-execute.ts"))};
      const resources = ["linux", "win32"].map(platform => executionResource(platform));
      process.chdir(${JSON.stringify(root)});
      console.log(JSON.stringify(resources.map(resource => resource.resolve(${JSON.stringify({
        root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json",
      })}))));
    `;
    const expanded = JSON.parse(execFileSync("bun", ["-e", setup], { cwd: startup,
      env: { ...process.env, PI_CODING_AGENT_DIR: relative }, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
    for (const resource of expanded) expect(resource.hostCommands).toHaveLength(32);
    const windowsCommand = expanded[1].hostCommands.find((grant: any) => grant.key === "execute-settings").command;
    const payload = windowsCommand.match(/Buffer.from\('([A-Za-z0-9+/=]+)','base64'\)/)![1]!;
    const bootstrap = windowsCommand.match(/-e "([^"]+)"/)![1]!;
    expect(JSON.parse(execFileSync("node", ["-e", bootstrap], { cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: relative }, encoding: "utf8" }))).toEqual({ maxCycles: 2 });
    const command = expanded[0].hostCommands.find((grant: any) => grant.key === "execute-settings").command;
    for (const mode of ["wrong B absent", "wrong B present", "project override", "invalid global"]) {
      if (mode === "wrong B present") writeFileSync(wrongFile, '{"pitako":{"execute":{"maxCycles":99}}}');
      if (mode === "project override") writeFileSync(projectFile, '{"pitako":{"execute":{"maxCycles":4}}}');
      if (mode === "invalid global") {
        rmSync(projectFile);
        writeFileSync(globalFile, '{"pitako":{"execute":{"maxCycles":false}}}');
      }
      const storage = new Map<string, any>(), calls: string[] = [];
      const observed = await runWorkflowScript({ script: expanded[0].script,
        state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, value); } },
        launch: async key => { calls.push(key); throw Error("Controlled stop at first director"); },
        status: async () => { throw Error("No recovery expected"); },
        host: async key => {
          const stdout = key === "execute-settings" ? execFileSync("sh", ["-c", command], { cwd: root,
            env: { ...process.env, PI_CODING_AGENT_DIR: relative }, encoding: "utf8" }) :
            key.startsWith("input-") ? JSON.stringify({ digest: snapshotDigest, content }) :
            JSON.stringify({ root, commonDir: root, selected: { source: "/complete.md", digest: snapshotDigest, chunks: 1 }, checkout });
          return { key, kind: "command", state: "passed", ok: true, exitCode: 0,
            stdout, stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
        },
      });
      if (mode === "invalid global") {
        expect(observed.value).toMatchObject({ status: "blocked", phase: "admission", loopsConsumed: 0 });
        expect((observed.value as any).reason).toContain(globalFile);
        expect((observed.value as any).reason).toContain("pitako.execute.maxCycles");
        expect(calls).toEqual([]); expect(storage.size).toBe(0);
      } else {
        expect(storage.get("pitako-execution")?.association.maxCycles).toBe(mode === "project override" ? 4 : 2);
        expect(calls).toHaveLength(1); expect(calls[0]).toEndWith(".director");
      }
    }
    expect(JSON.parse(Buffer.from(payload, "base64").toString("utf8")).at(-1)).toBe(global);
  }

  test("read-only settings admission uses global then designated project, never sibling or launch settings", () => {
    const root = repository(), global = path.join(root, "private-global"), sibling = path.join(root, "sibling");
    mkdirSync(global); mkdirSync(path.join(root, ".pi")); mkdirSync(path.join(sibling, ".pi"), { recursive: true });
    const globalFile = path.join(global, "settings.json"), projectFile = path.join(root, ".pi/settings.json");
    writeFileSync(path.join(sibling, ".pi/settings.json"), JSON.stringify({ pitako: { execute: { maxCycles: 99 } } }));
    expect(executeMaxCycles(root, global)).toBe(3);
    writeFileSync(globalFile, JSON.stringify({ pitako: { execute: { maxCycles: 2 } }, queueMode: "all" }));
    const original = readFileSync(globalFile, "utf8");
    expect(executeMaxCycles(root, global)).toBe(2);
    writeFileSync(projectFile, JSON.stringify({ unrelated: true })); expect(executeMaxCycles(root, global)).toBe(2);
    writeFileSync(projectFile, JSON.stringify({ pitako: { execute: { maxCycles: 4 } } }));
    expect(executeMaxCycles(root, global)).toBe(4); expect(readFileSync(globalFile, "utf8")).toBe(original);
    writeFileSync(globalFile, JSON.stringify({ pitako: { execute: { maxCycles: "invalid but overridden" } } }));
    expect(executeMaxCycles(root, global)).toBe(4);
    rmSync(projectFile); writeFileSync(globalFile, "{}"); expect(executeMaxCycles(root, global)).toBe(3);
  });

  test.each([0, -1, 1.5, "4", true, false, null, Number.MAX_SAFE_INTEGER + 1])("invalid effective settings %s identify actual file and exact key without fallback", value => {
    const root = repository(), global = path.join(root, "private-global"); mkdirSync(global); mkdirSync(path.join(root, ".pi"));
    for (const file of [path.join(global, "settings.json"), path.join(root, ".pi/settings.json")]) {
      writeFileSync(file, JSON.stringify({ pitako: { execute: { maxCycles: value } } }));
      expect(() => executeMaxCycles(root, global)).toThrow(file);
      expect(() => executeMaxCycles(root, global)).toThrow("pitako.execute.maxCycles");
      rmSync(file);
    }
  });

  test.each(["global", "project"])("malformed and unreadable %s settings identify source rather than default", level => {
    const root = repository(), global = path.join(root, "private-global"); mkdirSync(global); mkdirSync(path.join(root, ".pi"));
    const file = level === "global" ? path.join(global, "settings.json") : path.join(root, ".pi/settings.json");
    writeFileSync(file, "{"); expect(() => executeMaxCycles(root, global)).toThrow(file);
    expect(() => executeMaxCycles(root, global)).toThrow("pitako.execute.maxCycles");
    rmSync(file); mkdirSync(file);
    expect(() => executeMaxCycles(root, global)).toThrow(file); expect(() => executeMaxCycles(root, global)).toThrow("pitako.execute.maxCycles");
  });

  test.each([
    { mode: "global", globalValue: 2, projectValue: undefined, expected: 2 },
    { mode: "project absent-option fallback", globalValue: 2, projectValue: {}, expected: 2 },
    { mode: "project precedence", globalValue: 2, projectValue: { pitako: { execute: { maxCycles: 4 } } }, expected: 4 },
    { mode: "default absent-option fallback", globalValue: undefined, projectValue: {}, expected: 3 },
  ])("packaged BOM settings preserve $mode", ({ globalValue, projectValue, expected }) => {
    const root = repository(), global = path.join(root, "private-global");
    mkdirSync(global); mkdirSync(path.join(root, ".pi"));
    const globalFile = path.join(global, "settings.json"), projectFile = path.join(root, ".pi/settings.json");
    const expanded = resourceWithAgentDir(global).resolve({ root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    const command = expanded.hostCommands.find(grant => grant.key === "execute-settings")!.command;
    const inspect = () => JSON.parse(execFileSync("sh", ["-c", command], { cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: global }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const globalSettings = "\uFEFF" + JSON.stringify({ pitako: { execute: { maxCycles: globalValue } }, unrelated: "preserved" });
    const projectSettings = projectValue === undefined ? undefined : "\uFEFF" + JSON.stringify(projectValue);
    writeFileSync(globalFile, globalSettings);
    if (projectSettings !== undefined) writeFileSync(projectFile, projectSettings);
    expect(inspect()).toEqual({ maxCycles: expected });
    expect(readFileSync(globalFile, "utf8")).toBe(globalSettings);
    if (projectSettings !== undefined) expect(readFileSync(projectFile, "utf8")).toBe(projectSettings);
    else expect(existsSync(projectFile)).toBe(false);
  });

  test.each(["invalid", "malformed", "read-error", "BOM-invalid", "BOM-malformed", "non-leading-BOM", "double-BOM"])(
    "packaged %s settings failure reaches admission with actual file/key and no director", async mode => {
    const root = repository(), global = path.join(root, "private-global"), file = path.join(root, ".pi/settings.json");
    mkdirSync(global); mkdirSync(path.dirname(file));
    if (mode === "read-error") mkdirSync(file);
    else {
      const invalid = '{"pitako":{"execute":{"maxCycles":false}}}';
      const content = mode === "malformed" ? "{" : mode === "BOM-malformed" ? "\uFEFF{" :
        mode === "BOM-invalid" ? "\uFEFF" + invalid : mode === "non-leading-BOM" ? " \uFEFF{}" :
        mode === "double-BOM" ? "\uFEFF\uFEFF{}" : invalid;
      writeFileSync(file, content);
    }
    const expanded = resourceWithAgentDir(global).resolve({ root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    const grants = new Map(expanded.hostCommands.map(grant => [grant.key, grant.command]));
    const storage = new Map<string, unknown>(), calls: string[] = [];
    const observed = await runWorkflowScript({ script: expanded.script,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, value); } },
      launch: async key => { calls.push(key); throw Error("No director authorized on invalid settings"); },
      status: async () => { throw Error("No recovery expected"); },
      host: async key => {
        let stdout = "", stderr = "", ok = true;
        if (key === "execute-settings") {
          try { stdout = execFileSync("sh", ["-c", grants.get(key)!], { cwd: root,
            env: { ...process.env, PI_CODING_AGENT_DIR: global }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
          catch (error) { ok = false; stderr = String((error as { stderr: unknown }).stderr); }
        } else stdout = JSON.stringify({ root, commonDir: root, selected: { source: "/complete.md", digest: "a".repeat(64), chunks: 1 }, checkout });
        return { key, kind: "command", state: ok ? "passed" : "failed", ok, exitCode: ok ? 0 : 1,
          stdout, stderr, outputPath: `/native/${key}.log`, durationMs: 0 };
      },
    });
    expect(observed.value).toMatchObject({ status: "blocked", loopsConsumed: 0, phase: "admission" });
    if (typeof observed.value !== "object" || observed.value === null ||
        !("reason" in observed.value) || typeof observed.value.reason !== "string") {
      throw Error("Expected an admission diagnostic string");
    }
    expect(observed.value.reason).toContain(file); expect(observed.value.reason).toContain("pitako.execute.maxCycles");
    if (mode === "BOM-invalid") expect(observed.value.reason).toContain("expected a positive safe integer");
    if (["malformed", "BOM-malformed", "non-leading-BOM", "double-BOM"].includes(mode))
      expect(observed.value.reason).toContain("SyntaxError");
    expect(calls).toEqual([]); expect(storage.size).toBe(0);
  });

  test("complete inherited source is hash-validated without concatenating the selected snapshot", () => {
    const root = repository(), global = path.join(root, "private-global");
    mkdirSync(global); mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    const source = path.join(root, ".pitako/plans/inherited.md");
    const content = `---\npitako-spec: 1\nid: inherited\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}${"Inherited obligations.\n".repeat(1150)}`;
    // Each source fits; their complete combined bytes deliberately do not.
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(MAX_SPEC_BYTES);
    expect(Buffer.byteLength(content) * 2).toBeGreaterThan(MAX_SPEC_BYTES);
    writeFileSync(source, content);
    const expanded = resourceWithAgentDir(global).resolve({ root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json", sourceRefs: [{ path: source, digest: digest(content) }] });
    expect(expanded.hostCommands).toHaveLength(32);
    const command = expanded.hostCommands.find(grant => grant.key === "execute-settings")!.command;
    const inspect = () => execFileSync("sh", ["-c", command], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: global },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(inspect())).toEqual({ maxCycles: 3 });
    writeFileSync(source, content + "\nChanged");
    expect(JSON.parse(inspect()).error).toContain("Complete spec source hash mismatch");
    rmSync(source); expect(JSON.parse(inspect()).error).toContain(source);
  });

  test("execute foreground binds actual mission references without retired supervision or marker-trust admission", () => {
    const skill = read("skills/execute/SKILL.md"), prompt = read("prompts/execute.md");
    for (const text of [skill, prompt]) {
      expect(text).toContain("missionPath"); expect(text).toContain("loop_plan");
      expect(text).toContain("--unblock"); expect(text).not.toContain("effective-profile preflight");
    }
    expect(skill).toContain("details.missionId"); expect(skill).toContain("details.missionPath");
    expect(skill.replace(/\s+/g, " ")).toContain("all mission management and run reconciliation calls");
    expect(skill).toContain("never derive a storage path");
    expect(skill).toContain("without polling or new");
    expect(prompt).toContain("Reject obsolete --unblock");
  });

  test.each(["missing", "wrong", "compatible", "prompt-override", "provider-override"])("optional public get diagnoses the cwd profile and effective override body: %s", mode => {
    const root = repository(), prior = process.env.PI_CODING_AGENT_DIR;
    const agentDir = path.join(root, "agents"), configDir = path.join(root, ".pi");
    mkdirSync(agentDir); mkdirSync(configDir);
    process.env.PI_CODING_AGENT_DIR = path.join(root, "private-agent-config");
    const marker = "<!-- pitako-execute-contract: execution-inspector/1 -->";
    const source = read("agents/execution-inspector.md")
      .replace("tools: read, grep, find, ls, bash", "tools: read, grep, find, ls, bash, acp_status, file_sha256, codemode")
      .replace("extensions:\n", "extensions:\n  - ../extensions/acp.ts\n")
      .replace(marker, mode === "missing" ? "" : mode === "wrong" ? "<!-- pitako-execute-contract: execution-inspector/0 -->" : marker);
    const sourcePath = path.join(agentDir, "execution-inspector.md");
    writeFileSync(sourcePath, source);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "custom-checkout", pi: { subagents: { agents: ["./agents"] } } }));
    const override = { "pitako.execution-inspector": { systemPrompt: "Configured older policy: missing proof means blocked." } };
    if (mode.endsWith("override")) writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
      subagents: mode === "provider-override" ? { agentOverridesByProvider: { controlled: override } } : { agentOverrides: override },
    }));
    try {
      // Controlled PUBLIC management action; native profile loading/formatting only,
      // no provider, extension startup, child launch or invented get-JSON response.
      const response = handleManagementAction("get", { agent: "pitako.execution-inspector", agentScope: "both" }, {
        cwd: root, model: { provider: "controlled" } as never, modelRegistry: {} as never,
        discoverAgentsAll: (cwd, provider) => {
          expect(cwd).toBe(root);
          return discoverAgentsAll(cwd, provider, { globalNpmRoot: null });
        },
      });
      expect(response.isError).toBe(false);
      const detail = response.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      expect(detail).toContain(`Path: ${sourcePath}`);
      expect(detail).toContain("Agent: pitako.execution-inspector (package)");
      expect(detail).toContain("Tools: read, grep, find, ls, bash, acp_status, file_sha256, codemode");
      expect(detail).toContain(`Extensions: ${path.join(root, "extensions/acp.ts")}`);
      const body = detail.split("\nSystem Prompt:\n")[1]!;
      expect(body).toBeDefined();
      expect(body.split("\n").includes(marker)).toBe(mode === "compatible");
      if (mode.endsWith("override")) {
        expect(readFileSync(sourcePath, "utf8")).toContain(marker);
        expect(body).toBe("Configured older policy: missing proof means blocked.");
      }
      // Public get is optional diagnosis, not a runtime admission certificate.
      // This checks the effective observation, NOT simulated model compliance.
    } finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    }
  });

  test("native profile loader preserves ordinary deadlines and read-only planning roles", () => {
    const root = repository(), prior = process.env.PI_CODING_AGENT_DIR;
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pitako", pi: { subagents: { agents: [path.resolve("agents")] } } }));
    process.env.PI_CODING_AGENT_DIR = path.join(root, "private-agent-config");
    try {
      const loaded = discoverAgents(root, "project", undefined, { globalNpmRoot: null });
      const director = loaded.agents.find(agent => agent.name === "pitako.execution-director");
      expect(director?.defaultTimeoutMs).toBe(7200000);
      expect(director?.filePath).toBe(path.resolve("agents/execution-director.md"));
      const worker = loaded.agents.find(agent => agent.name === "pitako.worker");
      expect(worker?.defaultTimeoutMs).toBe(14400000);
      expect(worker?.filePath).toBe(path.resolve("agents/worker.md"));
      for (const role of ["worker", "execution-director"]) {
        const agent = loaded.agents.find(agent => agent.name === `pitako.${role}`)!;
        expect(agent.skills).toContain("verify-behavior");
        const skill = agent.skillPath?.map(entry => path.resolve(path.dirname(agent.filePath), entry))
          .find(entry => entry === path.resolve("skills/practical/verify-behavior"));
        expect(skill).toBeDefined();
        expect(readFileSync(path.join(skill!, "SKILL.md"), "utf8")).toContain("Triage a failing check");
        expect(agent.systemPrompt).toContain("verify-behavior");
      }
      for (const role of ["execution-inspector", "reviewer"]) {
        const agent = loaded.agents.find(agent => agent.name === `pitako.${role}`);
        expect(agent).toBeDefined(); expect(agent?.defaultTimeoutMs).toBeUndefined();
      }
    } finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    }
  });

  test("documented mission creation, inspection and launch reuse the designated store from a nested foreground cwd", () => {
    const root = repository(), foreground = path.join(root, "src"); mkdirSync(foreground);
    const missionId = "explicit.native-id", stores = new Map<string, Set<string>>();
    const calls: { args?: { missionPath?: string }; action?: string; agent?: string; agentScope?: string; workflow?: string; cwd?: string; options?: { missionId?: string } }[] = [];
    // Controlled native boundary: stores are keyed by request cwd, not its enclosing Git root.
    const subagent = (input: typeof calls[number]) => {
      calls.push(input);
      const cwd = path.resolve(foreground, input.cwd ?? ".");
      expect(cwd).toBe(root);
      if (input.action === "get") {
        expect(stores.size).toBe(0); expect(input.agentScope).toBe("both");
        return;
      }
      if (input.action === "mission.create") stores.set(cwd, new Set([missionId]));
      else expect(stores.get(cwd)?.has(input.options?.missionId ?? "")).toBe(true);
      return { details: { missionId, missionPath: "/native/actual-mission.json" } };
    };
    const blocks = [...read("skills/execute/SKILL.md").matchAll(/```js\n([\s\S]*?)```/g)];
    for (const [, block] of blocks) {
      const script = block!.replaceAll("<designated-absolute-root>", root).replaceAll("<same-root>", root)
        .replaceAll("<explicit-native-mission-id>", missionId).replaceAll("<actual-returned-mission-path>", "/native/actual-mission.json");
      new Function("subagent", script)(subagent);
    }
    expect(calls.map(call => call.action ?? call.workflow)).toEqual(["mission.create", "mission.show", "pitako.execute"]);
    expect(calls.at(-1)?.args?.missionPath).toBe("/native/actual-mission.json");
    expect(read("skills/execute/SKILL.md").replace(/\s+/g, " ")).toContain("all mission management and run reconciliation calls");
  });

  test("Windows host commands transport exact arguments without cmd expansion or POSIX quoting", () => {
    const root = repository();
    const source = 'C:\\specs & %PATH% !expansion!\\quoted\'"source.md';
    const expanded = executionResource("win32").resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json", source });
    expect(expanded.hostCommands).toHaveLength(32);
    for (const grant of expanded.hostCommands) {
      if (grant.key === "execute-settings") {
        const payload = grant.command.match(/Buffer.from\('([A-Za-z0-9+/=]+)','base64'\)/)![1]!;
        expect(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))).toEqual([
          path.resolve("skills/execute/inspect.mjs"), root, "assignment", source, "settings", "[]", path.resolve(getAgentDir()),
        ]);
        continue;
      }
      const match = grant.command.match(/^node -e "([^"]+)"(?: (metadata|\d+))?$/);
      expect(match).not.toBeNull();
      const payload = match![1]!.match(/Buffer.from\('([A-Za-z0-9+/=]+)','base64'\)/)![1]!;
      expect(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))).toEqual([
        path.resolve("skills/execute/inspect.mjs"), root, "assignment", source,
      ]);
      expect(match![1]).not.toMatch(/[%!$`]/);
      if (grant.key.startsWith("input-")) expect(Number(match![2])).toBe(Number(grant.key.slice(6)));
    }
    const inspect = executionResource("win32").resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" }).hostCommands[0]!.command;
    const bootstrap = inspect.match(/-e "([^"]+)"/)![1]!;
    const result = JSON.parse(execFileSync("node", ["-e", bootstrap], { encoding: "utf8" }));
    expect(result.root).toBe(root); expect(result.selected).toBeNull();
  });

  test("POSIX host grants invoke the packaged Node entry without interpreting root metacharacters", () => {
    const main = repository(), root = path.join(main, "sibling ' & %PATH% !");
    execFileSync("git", ["worktree", "add", "-qb", "quoted", root], { cwd: main, stdio: "ignore" });
    const expanded = executionResource("linux").resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    const grant = expanded.hostCommands.find(item => item.key === "inspect-initial")!;
    const result = JSON.parse(execFileSync("sh", ["-c", grant.command], { cwd: root, encoding: "utf8" }));
    expect(result.root).toBe(root); expect(result.selected).toBeNull();
    for (const name of ["plan", "execute"]) {
      const skill = read(`skills/${name}/SKILL.md`);
      expect(skill).toContain("inspect.mjs"); expect(skill.replace(/\s+/g, " ")).toContain("Node >=22.19.0");
      expect(skill).toContain("never shell-interpolated paths");
    }
  });

  test("native session-scoped resource registration replaces/disposes on lifecycle, with exact read-only command grants", () => {
    const root = repository();
    const hooks = new Map<string, (event: unknown, context: unknown) => void>();
    planExecute({ on: (name: string, hook: (event: unknown, context: unknown) => void) => { hooks.set(name, hook); } } as unknown as ExtensionAPI);
    const first = randomUUID(), second = randomUUID();
    const ctx = (id: string) => ({ cwd: root, sessionManager: { getSessionId: () => id } });
    disposers.push(() => hooks.get("session_shutdown")!({}, ctx(second)));
    hooks.get("session_start")!({}, ctx(first));
    const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
    const resolved = resolveWorkflowResource("pitako.execute", args, first); expect(resolved.ok).toBe(true);
    expect(resolveWorkflowResource(" pitako.execute ", args, first).ok).toBe(true);
    expect(resolveWorkflowResource("pitako.execute", args, second).ok).toBe(false);
    const expanded = executionResource().resolve(args);
    expect(expanded.hostCommands).toHaveLength(32);
    expect(new Set(expanded.hostCommands.map(grant => grant.key)).size).toBe(32);
    for (const grant of expanded.hostCommands) { expect(grant.command).toContain(process.platform === "win32" ? 'node -e "' : "skills/execute/inspect.mjs"); expect(grant.command).not.toMatch(/\b(?:commit|install|push)\b/); }
    expect(validateWorkflowScript(expanded.script)).toEqual({ ok: true, errors: [] });
    expect(() => executionResource().resolve({ ...args, invocation: "../escape" })).toThrow();
    expect(() => executionResource().resolve({ ...args, approval: true })).toThrow("Unknown");
    for (const unblock of [true, false, "true", 1, {}, [], null])
      expect(() => executionResource().resolve({ ...args, unblock })).toThrow("Obsolete --unblock");
    for (const missionPath of [undefined, "", "relative/guessed", false, {}])
      expect(() => executionResource().resolve({ ...args, missionPath })).toThrow("missionPath");
    for (const missionId of [undefined, "", " ", false, {}, "../escape", "native..mission", "native/mission", "x".repeat(129)])
      expect(() => executionResource().resolve({ ...args, missionId })).toThrow("missionId");
    expect(expanded.script).toContain('"missionId":"native.mission-1"');
    // Resolver performs no Git discovery; physical validation remains launch/inspection.
    expect(() => executionResource().resolve({ ...args, root: tmpdir() })).not.toThrow();
    hooks.get("session_start")!({}, ctx(second));
    expect(resolveWorkflowResource("pitako.execute", args, first).ok).toBe(false);
    expect(resolveWorkflowResource("pitako.execute", args, second).ok).toBe(true);
    hooks.get("session_shutdown")!({}, ctx(second)); hooks.get("session_shutdown")!({}, ctx(second));
    expect(resolveWorkflowResource("pitako.execute", args, second).ok).toBe(false);
  });

  test("setup captures complete trusted sources and the bounded resolver does not discover a checkout", () => {
    const resource = executionResource();
    const root = path.join(tmpdir(), `pitako-not-created-${randomUUID()}`);
    expect(existsSync(root)).toBe(false);
    const args = { root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
    const expanded = resource.resolve(args);
    expect(expanded.script).toContain(`const pitakoReviewLibraryMode = true;\n${read("skills/review/workflow.js")}\n${read("skills/execute/workflow.js")}`);
    expect(resource.resolve(Object.freeze(args))).toEqual(expanded);
    expect(existsSync(root)).toBe(false);
    expect(expanded.hostCommands).toHaveLength(32);
  });

  test("foreground subdirectory is not treated as launch cwd; the public launch must match the designated root", () => {
    const root = repository(), nested = path.join(root, "src"); mkdirSync(nested);
    const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
    planExecute({ on: (name: string, hook: (event: unknown, context: unknown) => unknown) => { hooks.set(name, hook); } } as unknown as ExtensionAPI);
    const sessionId = randomUUID(), ctx = { cwd: nested, sessionManager: { getSessionId: () => sessionId } };
    hooks.get("session_start")!({}, ctx);
    disposers.push(() => hooks.get("session_shutdown")!({}, ctx));
    const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
    const input = { workflow: "pitako.execute", args, options: { missionId: args.missionId } };
    const call = (cwd?: string, designatedRoot = root) => hooks.get("tool_call")!({ toolName: "subagent", input: { ...input, cwd, args: { ...args, root: designatedRoot } } }, ctx);
    expect(resolveWorkflowResource("pitako.execute", args, sessionId).ok).toBe(true);
    expect(call(root)).toBeUndefined(); expect(call("..")).toBeUndefined();
    expect(call()).toMatchObject({ block: true }); expect(call(nested)).toMatchObject({ block: true });
    const sibling = path.join(root, "..", `${path.basename(root)}-sibling`); roots.push(sibling);
    execFileSync("git", ["worktree", "add", "-qb", "sibling", sibling], { cwd: root, stdio: "ignore" });
    expect(call(sibling)).toMatchObject({ block: true });
    expect(call(sibling, sibling)).toBeUndefined();
    expect(call(nested, nested)).toMatchObject({ block: true });
  });

  test.each(["siblings", "long-path"])("inspector metadata crosses a controlled 4096-byte native preview: %s", mode => {
    const operation = runPreview(mode);
    // Observe rejection immediately and await either outcome before removing roots.
    workflowSettlements.push(operation.then(() => {}, () => {}));
    return operation;
  });

  async function runPreview(mode: string) {
    const main = repository();
    const parent = path.join(main, ...(mode === "long-path" ? Array.from({ length: 12 }, (_, index) => `${index}-` + '中é"\\'.repeat(22)) : ["siblings"]));
    mkdirSync(parent, { recursive: true });
    const root = path.join(parent, "designated");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "ignore" });
    git("worktree", "add", "-qb", "designated", root);
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`;
    const locations = [];
    // Cross the preview byte limit with longer paths, not more Git worktrees.
    for (let index = 0; index < (mode === "siblings" ? 3 : 1); index++) {
      const sibling = mode === "long-path" ? root : path.join(parent, `sibling-${index}`,
        ...Array.from({ length: 8 }, (_, part) => `segment-${part}-` + 'é中"\\'.repeat(20)));
      if (sibling !== root) git("worktree", "add", "-qb", `sibling-${index}`, sibling);
      const target = path.join(sibling, ".pitako/plans/assignment.md");
      mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); locations.push(target);
    }
    const selected = locations.at(-1)!;
    const rawDiscovery = JSON.parse(execFileSync("node", [path.resolve("skills/execute/inspect.mjs"), root, "assignment", ""], { encoding: "utf8" }));
    expect(Buffer.byteLength(JSON.stringify(rawDiscovery))).toBeGreaterThan(4096);
    expect(rawDiscovery.candidates.map((item: { source: string }) => item.source).sort()).toEqual(mode === "siblings" ? [...locations].sort() : []);
    const cache = new Map<string, string>();
    async function execute(source?: string) {
      const expanded = resourceWithAgentDir(path.join(root, "private-agent-settings")).resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json", ...(source ? { source } : {}) });
      const grants = new Map(expanded.hostCommands.map(grant => [grant.key, grant.command]));
      const storage = new Map<string, unknown>(), launched: string[] = [], envelopes: string[] = [];
      const result = await runWorkflowScript({ script: expanded.script,
        state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
        launch: async (key, request) => {
          launched.push(key); expect(request.cwd).toBe(root);
          if (key.endsWith(".director")) expect(request.task).toContain(JSON.stringify(selected));
          return childResponse(key, request, { root, commonDir: rawDiscovery.commonDir, selected: { source: selected, digest: digest(content) } }, checkout);

        },
        status: async () => { throw new Error("Unexpected status"); },
        host: async (key, params) => {
          expect(params.command).toBe(grants.get(key)!);
          let stdout = cache.get(params.command);
          if (stdout === undefined) {
            if (key.startsWith("input-") && !(mode === "long-path" && key === "input-0")) {
              // Eligibility uses actual Git/CLI above; transport fragments use the owned pure boundary.
              const index = Number(key.slice(6)), initial = JSON.parse(envelopes[0]!);
              const packetMetadata = { root, commonDir: rawDiscovery.commonDir, candidates: [],
                selected: { source: selected, digest: digest(content), chunks: specChunks(content).length } };
              stdout = JSON.stringify(initial.transport ? inspectionSnapshot(packetMetadata, content).packets[index]
                : { digest: digest(content), content: specChunks(content)[index] }) + "\n";
            } else stdout = execFileSync("sh", ["-c", params.command], { cwd: root,
              env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "private-agent-settings") },
              encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            cache.set(params.command, stdout);
          }
          if (key.startsWith("inspect-")) stdout = JSON.stringify({ ...JSON.parse(stdout), checkout }) + "\n";
          envelopes.push(stdout);
          const preview = Buffer.byteLength(stdout) <= 4096 ? stdout : Buffer.from(stdout).subarray(0, 4093).toString("utf8") + "...";
          return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout: preview, stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
        },
      });
      for (const envelope of envelopes) expect(Buffer.byteLength(envelope)).toBeLessThanOrEqual(4096);
      return { value: result.value, storage, launched, envelopes };
    }
    if (mode === "siblings") {
      const ambiguous = await execute();
      expect(structuredClone(ambiguous.value)).toMatchObject({ status: "blocked", phase: "admission", loopsConsumed: 0 });
      // Discovery details stay in the cited bounded inspector envelope, not a second report.
      expect(ambiguous.value).toMatchObject({ references: [{ key: "inspect-initial", outputReference: "/native/inspect-initial.log" }] });
      const ambiguity = JSON.parse(ambiguous.envelopes[0]!) as { candidates: { source: string }[]; candidatesOmitted: number };
      expect(ambiguity.candidates.length).toBeGreaterThan(0); expect(ambiguity.candidatesOmitted).toBeGreaterThan(0);
      expect(ambiguity.candidates.length + ambiguity.candidatesOmitted).toBe(locations.length);
      for (const candidate of ambiguity.candidates) expect(locations).toContain(candidate.source);
      expect(ambiguity.candidates.map(candidate => candidate.source)).not.toContain(selected);
      expect(ambiguous.launched).toHaveLength(0);
    }
    const chosen = await execute(selected);
    expect(chosen.value).toMatchObject({ status: "complete" });
    expect(chosen.storage.get("invoke-human-1")).toMatchObject({ association: { source: selected, digest: digest(content) }, snapshot: { content } });
    expect(chosen.storage.get("pitako-execution")).toMatchObject({ version: 3, association: { root, commonDir: path.join(main, ".git") } });
    expect(chosen.envelopes.some(envelope => JSON.parse(envelope).transport)).toBe(mode === "long-path");
    const initial = JSON.parse(chosen.envelopes[0]!);
    if (mode === "siblings") { expect(initial.candidates).toEqual([]); expect(initial.selected.source).toBe(selected); }
  }

  test.each(["escaped", "multibyte"])("maximum-size specs plus selected metadata fit all three native cycles within exactly 31 host calls: %s", async kind => {
    const root = repository();
    const prefix = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`;
    const filler = kind === "escaped" ? '"\\' : "é中😀\n";
    const remaining = MAX_SPEC_BYTES - Buffer.byteLength(prefix), size = Buffer.byteLength(filler);
    const content = prefix + filler.repeat(Math.floor(remaining / size)) + "x".repeat(remaining % size);
    validateSpec(content, "assignment"); expect(Buffer.byteLength(content)).toBe(MAX_SPEC_BYTES);
    // Transport dimension fixture; real eligibility/root/path validation is covered above.
    const selected = { source: `/controlled/${'é中"\\'.repeat(750)}/assignment.md`, digest: digest(content), chunks: specChunks(content).length };
    const metadata = { root, commonDir: path.join(root, ".git"), candidates: [], selected };
    const { transport, packets } = inspectionSnapshot(metadata, content);
    expect(packets).toHaveLength(26);
    expect(packets.map(packet => packet.metadata).join("")).toBe(JSON.stringify(metadata));
    expect(packets.map(packet => packet.content).join("")).toBe(content);
    const expanded = executionResource().resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    expect(expanded.hostCommands).toHaveLength(32);
    const grants = new Map(expanded.hostCommands.map(grant => [grant.key, grant.command]));
    const storage = new Map<string, unknown>(), hostKeys: string[] = [];
    const result = await runWorkflowScript({ script: expanded.script,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async (key, request) => {
        if (key.endsWith(".director")) expect(request.task).toContain(JSON.stringify(selected.source));
        if (!request.resume) expect(request.task).toContain(content);
        return childResponse(key, request, metadata, checkout, 3);

      },
      status: async () => { throw new Error("Unexpected status"); },
      host: async (key, params) => {
        expect(params.command).toBe(grants.get(key)!); hostKeys.push(key);
        const stdout = JSON.stringify(key === "execute-settings" ? { maxCycles: 3 } : key.startsWith("input-") ? packets[Number(key.slice(6))]
          : { selected: { digest: selected.digest }, transport, checkout }) + "\n";
        expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(4096);
        return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout, stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
      },
    });
    expect(result.value).toMatchObject({ status: "complete", loopsConsumed: 3 });
    expect(hostKeys).toHaveLength(31); expect(new Set(hostKeys).size).toBe(31);
    expect(storage.get("invoke-human-1")).toMatchObject({ association: { source: selected.source, digest: selected.digest }, snapshot: { content }, loops: expect.any(Array) });
  });

  test("registered root runs complete shared review and assembles every phase without retired child supervision", async () => {
    const root = repository();
    const metadata = { root, commonDir: path.join(root, ".git"), candidates: [],
      selected: { source: `${root}/.pitako/plans/assignment.md`, digest: digest("COMPLETE SPEC SNAPSHOT"), chunks: 1 } };
    const expanded = executionResource().resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    const review = read("skills/review/workflow.js"), execute = read("skills/execute/workflow.js");
    expect(expanded.script.endsWith(`const pitakoReviewLibraryMode = true;\n${review}\n${execute}`)).toBe(true);
    const storage = new Map<string, unknown>(), calls: any[] = [], inspections: string[] = [];
    const result = await runWorkflowScript({ script: expanded.script,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async (key, request) => {
        calls.push({ key, ...request });
        expect(request.cwd).toBe(root); expect(request.outputSchema).toBeDefined();
        return childResponse(key, request, metadata, checkout);
      },
      status: async () => { throw new Error("Unexpected routine recovery"); },
      host: async (key) => {
        inspections.push(key);
        return { key, kind: "command", state: "passed", ok: true, exitCode: 0,
          stdout: JSON.stringify(key === "execute-settings" ? { maxCycles: 3 } : key.startsWith("input-") ? { digest: metadata.selected.digest, content: "COMPLETE SPEC SNAPSHOT" } : { ...metadata, checkout }),
          stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
      },
    });
    expect(result.value).toMatchObject({ status: "complete", loopsConsumed: 1, actionRequired: "none" });
    expect(calls.map(call => call.key)).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l1.t1.a1",
      "invoke-human-1.l1.review.director-prepare", "invoke-human-1.l1.review.independent-a", "invoke-human-1.l1.review.independent-b",
      "invoke-human-1.l1.review.director-synthesis", "invoke-human-1.l1.compliance"]);
    expect(inspections).toEqual(["inspect-initial", "execute-settings", "input-0", "inspect-loop-1"]);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pitako", pi: { subagents: { agents: [path.resolve("agents")] } } }));
    const prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "private-agent-config");
    let loaded;
    try { loaded = discoverAgents(root, "project", undefined, { globalNpmRoot: null }); }
    finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    }
    const bodies = new Map(loaded.agents.map(agent => [agent.name.replace("pitako.", ""), agent.systemPrompt]));
    const priorContexts = new Map<string, string>();
    for (const call of calls) {
      const role = (call.agent ?? "pitako.reviewer").replace("pitako.", "");
      const assembled = [read("AGENTS.md"), bodies.get(role), read("skills/practical/verify-behavior/SKILL.md"),
        ...(role === "worker" ? [read("node_modules/@dietrichgebert/ponytail/skills/ponytail/SKILL.md")] : []),
        call.resume ? priorContexts.get(call.resume) : "", call.task].join("\n");
      priorContexts.set(`native-${call.key}`, assembled);
      for (const obsolete of ["sole delegating cycle director", "create all known stages pending", "Prepare an implementation TODO", "reports actual spec/check/review evidence and its current-checkout association", "Only the execution director delegates"])
        expect(assembled).not.toContain(obsolete);
      expect(assembled).toContain("COMPLETE SPEC SNAPSHOT");
      if (call.key.endsWith(".compliance")) {
        expect(assembled).toContain("inventory of ALL obligations from the COMPLETE selected specs");
        expect(assembled).toMatch(/actual acceptance criteria AND obligations in expected\s+behavior, constraints, verification and other sections/);
        expect(assembled).not.toContain("EACH of the 17 acceptance criteria");
      }
    }
    expect(calls[0].task).toContain("then END");
    expect(calls[1]).toMatchObject({ reads: false, progress: false, timeoutMs: 14400000, acceptance: { level: "none" } });
    for (const instructions of [profileNote("coding"), read("skills/pitako-coding/SKILL.md"), read("prompts/execute.md"), read("skills/execute/SKILL.md")])
      expect(instructions).not.toContain("Only the execution director delegates");
    expect(bodies.get("execution-inspector")).not.toContain("Prepare\nan implementation TODO");
  });

  test("native sandbox runs initial independent read-only evidence providers, not human confirmation or product effects", async () => {
    const calls: Record<string, unknown>[] = [];
    const result = await runWorkflowScript({ script: read("skills/plan/context.js"), args: { brief: "Assignment and version-specific sources" },
      launch: async (key, request) => { calls.push(request); return { key, ok: true, output: "", artifactPaths: [], runId: key,
        structuredOutput: { status: "ready", report: `Factual evidence from ${request.agent}` } }; },
      status: async () => { throw new Error("Unexpected status"); },
    });
    expect(result.value).toMatchObject({ status: "ready" }); expect(calls.map(call => call.agent)).toEqual(["pitako.scout", "pitako.researcher"]);
    expect(calls.every(call => call.context === "fresh" && call.output === false)).toBe(true);
    for (const call of calls) expect(call.task).toContain("Human preferences belong to the foreground user");
    const skill = read("skills/plan/SKILL.md");
    for (const contract of ["ACTUAL\nHUMAN", "then wait", "ONLY", "Never implements product code", "approved: true", "ENTIRE currently unblocked frontier"])
      expect(skill).toContain(contract);
    expect(validateWorkflowScript(read("skills/architecture/workflow.js")).ok).toBe(true);
  });

  test("worker preserves upstream implementation core, explicit providers, Ponytail LITE and no delegation; all packaged children stay nondelegating", () => {
    const { frontmatter: worker, body } = parseFrontmatter(read("agents/worker.md"));
    const upstream = parseFrontmatter(read("node_modules/pi-subagents/agents/worker.md"));
    expect(`${worker.package}.${worker.name}`).toBe("pitako.worker");
    for (const field of ["acceptanceRole", "defaultContext", "inheritProjectContext", "systemPromptMode", "defaultReads", "defaultProgress"]) expect(worker[field]).toEqual(upstream.frontmatter[field]);
    const tools = String(worker.tools).split(/,\s*/);
    for (const tool of ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor", "apply_patch", "codegraph_explore", "codegraph_files", "lsp_symbols", "lsp_rename", "ast_search", "ast_rewrite"]) expect(tools).toContain(tool);
    expect(tools).not.toContain("subagent"); expect(worker.allowNestedSubagents).toBeUndefined(); expect(worker.model).toBeUndefined();
    expect(String(worker.skills).split(/,\s*/)).toEqual(["ponytail", "verify-behavior"]);
    expect(worker.skillPath).toEqual(["../node_modules/@dietrichgebert/ponytail/skills/ponytail", "../skills/practical/verify-behavior"]);
    expect(worker.extensions).toEqual(["../extensions/acp.ts"]);
    expect(worker.subagentOnlyExtensions).toEqual(["../extensions/dev-tools/index.ts", "../extensions/file-sha256.ts", "../node_modules/@vndv/pi-codegraph/extensions/codegraph.ts", "../node_modules/pi-lsp-client/src/index.ts", "../node_modules/@nicknisi/pi-ast-grep/index.ts", "../node_modules/pi-codex-tools/index.ts"]);
    for (const provider of worker.subagentOnlyExtensions as string[]) expect(existsSync(path.resolve("agents", provider))).toBe(true);
    for (const contract of ["single writer thread", "pause and escalate", "Ponytail is explicitly LITE", "Never\nreduce assigned specs or scope", "weaken project-required tests", "output schema/reporting", "edit/write"])
      expect(body).toContain(contract);
    const director = parseFrontmatter(read("agents/execution-director.md"));
    for (const tool of ["subagent", "bg_wait", "todo", "contact_supervisor", "subagent_supervisor"]) expect(String(director.frontmatter.tools).split(/,\s*/)).not.toContain(tool);
    expect(String(director.frontmatter.tools)).not.toMatch(/\b(?:bash|edit|write|apply_patch)\b/);
    expect(director.frontmatter.extensions).toEqual(["../extensions/acp.ts"]);
    expect(director.frontmatter.subagentOnlyExtensions).toEqual(["../extensions/dev-tools/index.ts", "../extensions/file-sha256.ts"]);
    for (const role of ["architect", "reviewer", "scout", "researcher", "evidence-auditor", "execution-inspector"]) {
      const profile = parseFrontmatter(read(`agents/${role}.md`)).frontmatter;
      expect(profile.acceptanceRole).toBe("read-only"); expect(profile.allowNestedSubagents).toBeUndefined();
      expect(profile.tools).not.toContain("subagent");
    }
  });

  test("director required-tool plan has no fanout or private TODO provider; interview relay retains native contact", () => {
    const { frontmatter, body } = parseFrontmatter(read("agents/execution-director.md"));
    const plan = resolvePiLaunchToolPlan({ tools: String(frontmatter.tools).split(/,\s*/), extensions: [],
      subagentOnlyExtensions: (frontmatter.subagentOnlyExtensions as string[]).map(provider => path.resolve("agents", provider)) });
    expect(plan.fanoutAuthorized).toBe(false);
    expect(plan.requiredChildTools).not.toContain("todo"); expect(plan.requiredChildTools).not.toContain("subagent");
    expect(body).toContain("then END"); expect(body).toContain("needs-decision");
    const relay = parseFrontmatter(read("agents/interview-relay.md"));
    const relayPlan = resolvePiLaunchToolPlan({ tools: String(relay.frontmatter.tools).split(/,\s*/), extensions: [] });
    expect(relayPlan.fanoutAuthorized).toBe(false); expect(relayPlan.effectiveToolAllowlist).toContain("contact_supervisor");
    expect(relay.body).toContain("ACTUAL HUMAN"); expect(relay.body).toContain("await the real supervisor reply");
  });

  test("grilling retains exact pinned primary bytes, MIT notice, source mapping and package discovery", () => {
    const provenance = JSON.parse(read("docs/provenance.json")).grilling;
    expect(provenance.revision).toBe("5beb35b040e3de97e54fa9e386d7e42d15c295c2"); expect(provenance.localModifications).toEqual([]);
    for (const destination of Object.values(provenance.sourceMapping) as string[]) expect(createHash("sha256").update(readFileSync(destination)).digest("hex")).toBe(provenance.sha256[destination]);
    expect(read("docs/licenses/mattpocock-skills-LICENSE")).toContain("Copyright (c) 2026 Matt Pocock");
    const manifest = JSON.parse(read("package.json"));
    for (const name of ["plan", "execute", "grilling"]) { expect(manifest.pi.skills).toContain(`./skills/${name}`); expect(DEFAULT_SKILL_NAMES as readonly string[]).toContain(name); }
    for (const directory of ["skills", "extensions", "agents", "prompts"]) expect(manifest.files).toContain(directory);
    for (const name of ["plan", "execute"]) expect(read(`prompts/${name}.md`)).toContain(`packaged ${name} skill`);
    expect(read("THIRD_PARTY.md")).toContain(provenance.revision);
  });
});

test("advertised execute tool entry requires explicit native binding without claiming RPC confinement", () => {
  let guard: ((event: unknown, context?: unknown) => unknown) | undefined;
  planExecute({ on: (name: string, handler: (event: unknown) => unknown) => { if (name === "tool_call") guard = handler; } } as unknown as ExtensionAPI);
  const root = repository();
  const call = (options?: unknown, args?: unknown, workflow: unknown = "pitako.execute", toolName = "subagent") => guard!({ toolName, input: { workflow, args, options } }, { cwd: root });
  const missionId = "explicit.native-id", args = { missionId, missionPath: "/native/actual-mission.json", root };
  for (const options of [undefined, {}, { mission: false }, { mission: true }, { mission: [] }, { mission: {} }, { missionId: "" }, { missionId: false }]) expect(call(options, args)).toMatchObject({ block: true });
  for (const missingOrInvalid of [undefined, {}, null, [], { missionId: "" }, { missionId: false }, { missionId: "different-id" }, { missionId: "../escape" }])
    expect(call({ missionId }, missingOrInvalid)).toMatchObject({ block: true });
  for (const mission of [{ title: "Explicit creation" }, { summary: "Explicit creation" }, false]) {
    expect(call({ mission }, args)).toMatchObject({ block: true });
    expect(call({ missionId, mission }, args)).toMatchObject({ block: true });
  }
  expect(call({ missionId }, args)).toBeUndefined();
  // Native ownership validates storage existence; matching DATA pointers are not approval or confinement.
  expect(call({ missionId: "missing-id-native-must-reject" }, { missionId: "missing-id-native-must-reject", missionPath: "/native/actual-mission.json", root })).toBeUndefined();
  expect(call({ missionId }, { ...args, missionId: "different-id" }, " pitako.execute ")).toMatchObject({ block: true });
  expect(call({ missionId }, args, " pitako.execute ")).toBeUndefined();
  expect(call(undefined, undefined, "review")).toBeUndefined(); expect(call(undefined, undefined, true)).toBeUndefined(); expect(call(undefined, undefined, "./workflow.js")).toBeUndefined(); expect(call(undefined, undefined, "pitako.execute", "read")).toBeUndefined();
});
