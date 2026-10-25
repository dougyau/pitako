import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveWorkflowResource } from "../node_modules/pi-subagents/src/workflows/workflow-resources.js";
import { runWorkflowScript, validateWorkflowScript } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import registerFanoutChild from "../node_modules/pi-subagents/src/extension/fanout-child.js";
import { resolvePiLaunchToolPlan } from "../node_modules/pi-subagents/src/runs/shared/child-tool-plan.js";
import { discoverAgents, discoverAgentsAll } from "../node_modules/pi-subagents/src/agents/agents.js";
import { handleManagementAction } from "../node_modules/pi-subagents/src/agents/agent-management.js";
import planExecute, { executionResource } from "../extensions/plan-execute.ts";
import { DEFAULT_SKILL_NAMES } from "../extensions/catalog.ts";
import { digest, inspectionSnapshot, MAX_SPEC_BYTES, SPEC_SECTIONS, specChunks, validateSpec } from "../extensions/spec-plans.ts";

const roots: string[] = [], disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const read = (name: string) => readFileSync(path.resolve(name), "utf8");
function repository() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-workflow-resource-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"); return root;
}

describe("plan/execute packaged composition", () => {
  test("execute prompt binds foreground effective-profile checks before mission mutation or preparation, not SDK confinement", () => {
    const prompt = read("prompts/execute.md"), skill = read("skills/execute/SKILL.md");
    expect(prompt).toContain("FIRST perform the skill's effective-profile preflight");
    expect(prompt).toContain("Only after compatibility passes, bind a native mission explicitly");
    const preflight = skill.slice(skill.indexOf("## Effective-profile preflight"), skill.indexOf("List existing foreground TODOs"));
    for (const role of ["execution-inspector", "execution-director", "worker"]) {
      const marker = `<!-- pitako-execute-contract: ${role}/1 -->`;
      expect(parseFrontmatter(read(`agents/${role}.md`)).body).toContain(marker);
      expect(preflight).toContain(`action: "get", agent: "pitako.${role}", agentScope: "both"`);
      expect(preflight).toContain(marker);
    }
    for (const instruction of ["AFTER configured/provider overrides", "STOP this invocation before binding or preparation",
      "at <Path> (origin <origin>)", "Synchronize this", "preserving custom providers",
      "not a JSON profile contract", "Raw SDK/resource callers can bypass this prompt policy",
      "NOT a package version, exact body hash", "Do not change installed profiles"])
      expect(preflight).toContain(instruction);
    expect(skill).toContain("Never revive an old inspector/director");
    expect(skill).toContain("Compatibility does not override negative current preparation or native barriers");
  });

  test("execute instruction assembly permits public get and native workflow operations with opaque T3 trust", () => {
    const prompt = read("prompts/execute.md"), skill = read("skills/execute/SKILL.md");
    const instructions = `${prompt}\n${skill}`.replace(/\s+/g, " ");
    expect(prompt).toContain("Unknown or unobservable native trust is not a denial");
    expect(prompt).toContain("proceed with public get and native workflow operations under their actual policy");
    for (const instruction of [
      "Unknown or unobservable native trust, including an opaque T3 context, is not a denial",
      "Do not stop solely because projectApproved is absent, false or unknown",
      "require a trust certificate, or require leaving T3/reopening Pi CLI",
      "Continue with public action:get and native workflow operations under their actual policy",
      "Native discovery/filtering is not automatically an execution denial",
      "NOT an exact native child-selection certificate across contexts",
      "the observed and launched profiles can differ",
      "Do not infer approval OR denial from get's Path/marker or this observation limit",
      "Respect real native permission rejections, Stop and positive current activity, including for --unblock",
      "never approve trust on the user's behalf, edit trust/settings or add projectTrusted to tool args",
      "Do not add a trust probe, certificate or substitute admission gate",
    ]) expect(instructions).toContain(instruction);
    for (const removedBlock of [
      "FIRST require known foreground native project-trust approval",
      "Cannot certify execute child selection", "Rebind to a known approved foreground session",
      "Supported human rebinding", "pi --approve", "Recheck trust and profiles",
    ]) expect(instructions).not.toContain(removedBlock);
    const get = skill.indexOf('action: "get", agent: "pitako.execution-inspector"');
    expect(get).toBeGreaterThan(skill.indexOf("## Effective-profile preflight"));
    expect(skill.indexOf('action: "mission.create"')).toBeGreaterThan(get);
    // Owned instruction assembly only: no simulated model decisions, command
    // execution, trust approval or certification of native child selection.
  });

  test.each(["missing", "wrong", "compatible", "prompt-override", "provider-override"])("foreground public get exposes the cwd profile and effective body for preflight: %s", mode => {
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
      // The preceding instruction-binding test owns STOP/diagnostic ordering.
      // This checks the effective observation, NOT simulated model compliance.
    } finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    }
  });

  test("native profile loader applies the two-hour deadline only to the packaged execution director", () => {
    const root = repository(), prior = process.env.PI_CODING_AGENT_DIR;
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pitako", pi: { subagents: { agents: [path.resolve("agents")] } } }));
    process.env.PI_CODING_AGENT_DIR = path.join(root, "private-agent-config");
    try {
      const loaded = discoverAgents(root, "project", undefined, { globalNpmRoot: null });
      const director = loaded.agents.find(agent => agent.name === "pitako.execution-director");
      expect(director?.defaultTimeoutMs).toBe(7200000);
      expect(director?.filePath).toBe(path.resolve("agents/execution-director.md"));
      for (const role of ["worker", "execution-director"]) {
        const agent = loaded.agents.find(agent => agent.name === `pitako.${role}`)!;
        expect(agent.skills).toContain("verify-behavior");
        const skill = agent.skillPath?.map(entry => path.resolve(path.dirname(agent.filePath), entry))
          .find(entry => entry === path.resolve("skills/practical/verify-behavior"));
        expect(skill).toBeDefined();
        expect(readFileSync(path.join(skill!, "SKILL.md"), "utf8")).toContain("Triage a failing check");
        expect(agent.systemPrompt).toContain("verify-behavior");
      }
      for (const role of ["worker", "execution-inspector", "reviewer"]) {
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
    const calls: { action?: string; agent?: string; agentScope?: string; workflow?: string; cwd?: string; options?: { missionId?: string } }[] = [];
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
      return { details: { missionId } };
    };
    const blocks = [...read("skills/execute/SKILL.md").matchAll(/```js\n([\s\S]*?)```/g)];
    for (const [, block] of blocks) {
      const script = block!.replaceAll("<designated-absolute-root>", root).replaceAll("<same-root>", root)
        .replaceAll("<explicit-native-mission-id>", missionId);
      new Function("subagent", script)(subagent);
    }
    expect(calls.map(call => call.action ?? call.workflow)).toEqual(["get", "get", "get", "mission.create", "mission.show", "pitako.execute"]);
    expect(calls.slice(0, 3).map(call => call.agent)).toEqual(["pitako.execution-inspector", "pitako.execution-director", "pitako.worker"]);
    expect(read("skills/execute/SKILL.md")).toContain("all mission management and run reconciliation calls");
  });

  test("Windows host commands transport exact arguments without cmd expansion or POSIX quoting", () => {
    const root = repository();
    const source = 'C:\\specs & %PATH% !expansion!\\quoted\'"source.md';
    const expanded = executionResource("win32").resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", source });
    expect(expanded.hostCommands).toHaveLength(32);
    for (const grant of expanded.hostCommands) {
      const match = grant.command.match(/^node -e "([^"]+)"(?: (metadata|\d+))?$/);
      expect(match).not.toBeNull();
      const payload = match![1]!.match(/Buffer.from\('([A-Za-z0-9+/=]+)','base64'\)/)![1]!;
      expect(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))).toEqual([
        path.resolve("skills/execute/inspect.mjs"), root, "assignment", source,
      ]);
      expect(match![1]).not.toMatch(/[%!$`]/);
      if (grant.key.startsWith("input-")) expect(Number(match![2])).toBe(Number(grant.key.slice(6)));
    }
    const inspect = executionResource("win32").resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1" }).hostCommands[0]!.command;
    const bootstrap = inspect.match(/-e "([^"]+)"/)![1]!;
    const result = JSON.parse(execFileSync("node", ["-e", bootstrap], { encoding: "utf8" }));
    expect(result.root).toBe(root); expect(result.selected).toBeNull();
  });

  test("POSIX host grants invoke the packaged Node entry without interpreting root metacharacters", () => {
    const main = repository(), root = path.join(main, "sibling ' & %PATH% !");
    execFileSync("git", ["worktree", "add", "-qb", "quoted", root], { cwd: main, stdio: "ignore" });
    const expanded = executionResource("linux").resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1" });
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
    const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1" };
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
    for (const unblock of ["true", 1, {}, [], null])
      expect(() => executionResource().resolve({ ...args, unblock })).toThrow("strict boolean");
    expect(executionResource().resolve({ ...args, unblock: true }).script).toContain('"unblock":true');
    expect(executionResource().resolve({ ...args, unblock: false }).script).toContain('"unblock":false');
    for (const missionId of [undefined, "", " ", false, {}, "../escape", "native..mission", "native/mission", "x".repeat(129)])
      expect(() => executionResource().resolve({ ...args, missionId })).toThrow("missionId");
    expect(expanded.script).toContain('"missionId":"native.mission-1"');
    expect(() => executionResource().resolve({ ...args, root: tmpdir() })).toThrow();
    hooks.get("session_start")!({}, ctx(second));
    expect(resolveWorkflowResource("pitako.execute", args, first).ok).toBe(false);
    expect(resolveWorkflowResource("pitako.execute", args, second).ok).toBe(true);
    hooks.get("session_shutdown")!({}, ctx(second)); hooks.get("session_shutdown")!({}, ctx(second));
    expect(resolveWorkflowResource("pitako.execute", args, second).ok).toBe(false);
  });

  test("foreground subdirectory is not treated as launch cwd; the public launch must match the designated root", () => {
    const root = repository(), nested = path.join(root, "src"); mkdirSync(nested);
    const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
    planExecute({ on: (name: string, hook: (event: unknown, context: unknown) => unknown) => { hooks.set(name, hook); } } as unknown as ExtensionAPI);
    const sessionId = randomUUID(), ctx = { cwd: nested, sessionManager: { getSessionId: () => sessionId } };
    hooks.get("session_start")!({}, ctx);
    disposers.push(() => hooks.get("session_shutdown")!({}, ctx));
    const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1" };
    const input = { workflow: "pitako.execute", args, options: { missionId: args.missionId } };
    const call = (cwd?: string, designatedRoot = root) => hooks.get("tool_call")!({ toolName: "subagent", input: { ...input, cwd, args: { ...args, root: designatedRoot } } }, ctx);
    expect(resolveWorkflowResource("pitako.execute", args, sessionId).ok).toBe(true);
    expect(call(root)).toBeUndefined(); expect(call("..")).toBeUndefined();
    expect(call()).toMatchObject({ block: true }); expect(call(nested)).toMatchObject({ block: true });
    const sibling = path.join(root, "..", `${path.basename(root)}-sibling`); roots.push(sibling);
    execFileSync("git", ["worktree", "add", "-qb", "sibling", sibling], { cwd: root, stdio: "ignore" });
    expect(call(sibling)).toMatchObject({ block: true });
    expect(call(sibling, sibling)).toBeUndefined();
    expect(() => executionResource().resolve({ ...args, root: nested })).toThrow("subdirectory");
  });

  test.each(["siblings", "long-path"])("inspector metadata crosses a controlled 4096-byte native preview: %s", async mode => {
    const main = repository();
    const parent = path.join(main, ...(mode === "long-path" ? Array.from({ length: 12 }, (_, index) => `${index}-` + '中é"\\'.repeat(22)) : ["siblings"]));
    mkdirSync(parent, { recursive: true });
    const root = path.join(parent, "designated");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "ignore" });
    git("worktree", "add", "-qb", "designated", root);
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`;
    const locations = [];
    for (let index = 0; index < (mode === "siblings" ? 32 : 1); index++) {
      const sibling = mode === "long-path" ? root : path.join(parent, `sibling-${index}-` + 'é中"\\'.repeat(20));
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
      const expanded = executionResource("linux").resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", ...(source ? { source } : {}) });
      const grants = new Map(expanded.hostCommands.map(grant => [grant.key, grant.command]));
      const storage = new Map<string, unknown>(), launched: string[] = [], envelopes: string[] = [];
      const result = await runWorkflowScript({ script: expanded.script,
        state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
        launch: async (key, request) => {
          launched.push(key); expect(request.cwd).toBe(root); expect(request.task).toContain(selected);
          const value = key.endsWith("prepare") ? { status: "ready", nativeRefs: [], todo: "Prepared", evidence: "Git" }
            : key.endsWith("settlement") ? { evidence: "Known native refs/Git", nativeRefs: [] }
            : key.endsWith("validate") ? { status: "verified", evidence: "Current review/check evidence" }
              : { status: "complete", summary: "Done", remaining: "None", evidence: "Review/checks" };
          return { key, ok: true, output: "", runId: `native-${key}`, artifactPaths: [], structuredOutput: value };
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
            } else stdout = execFileSync("sh", ["-c", params.command], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            cache.set(params.command, stdout);
          }
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
      expect(structuredClone(ambiguous.value)).toMatchObject({ status: "blocked", candidateCount: 32, candidatesOmitted: expect.any(Number) });
      const ambiguity = ambiguous.value as { candidates: { source: string }[]; candidatesOmitted: number };
      expect(ambiguity.candidates.length).toBeGreaterThan(0); expect(ambiguity.candidatesOmitted).toBeGreaterThan(0);
      expect(ambiguity.candidates.length + ambiguity.candidatesOmitted).toBe(32);
      for (const candidate of ambiguity.candidates) expect(locations).toContain(candidate.source);
      expect(ambiguous.launched).toHaveLength(0);
    }
    const chosen = await execute(selected);
    expect(chosen.value).toMatchObject({ status: "complete" });
    expect(chosen.storage.get("invoke-human-1")).toMatchObject({ source: selected, digest: digest(content), content });
    expect(chosen.storage.get("pitako-execution")).toMatchObject({ root, commonDir: path.join(main, ".git") });
    expect(chosen.envelopes.some(envelope => JSON.parse(envelope).transport)).toBe(mode === "long-path");
    const initial = JSON.parse(chosen.envelopes[0]!);
    if (mode === "siblings") { expect(initial.candidates).toEqual([]); expect(initial.selected.source).toBe(selected); }
  });

  test.each(["escaped", "multibyte"])("maximum-size specs plus selected metadata fit all three native cycles within exactly 32 host calls: %s", async kind => {
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
    const expanded = executionResource().resolve({ root, id: "assignment", invocation: "human-1", missionId: "native.mission-1" });
    expect(expanded.hostCommands).toHaveLength(32);
    const grants = new Map(expanded.hostCommands.map(grant => [grant.key, grant.command]));
    const storage = new Map<string, unknown>(), hostKeys: string[] = [];
    const result = await runWorkflowScript({ script: expanded.script,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async (key, request) => {
        expect(request.task).toContain(selected.source); expect(request.task).toContain(content);
        const value = key.endsWith("prepare") ? { status: "ready", nativeRefs: [], todo: "Prepared", evidence: "Git" }
          : key.endsWith("settlement") ? { evidence: "Known native refs/Git", nativeRefs: [] }
          : key.endsWith("validate") ? { status: "verified", evidence: "Current review/check evidence" }
            : { status: key.endsWith("cycle-3") ? "complete" : "gaps", summary: "Bounded cycle", remaining: "Review gaps", evidence: "Review/checks" };
        return { key, ok: true, output: "", artifactPaths: [], runId: `native-${key}`, structuredOutput: value };
      },
      status: async () => { throw new Error("Unexpected status"); },
      host: async (key, params) => {
        expect(params.command).toBe(grants.get(key)!); hostKeys.push(key);
        const stdout = JSON.stringify(key.startsWith("input-") ? packets[Number(key.slice(6))]
          : { selected: { digest: selected.digest }, transport, checkout: { fingerprint: "current" } }) + "\n";
        expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(4096);
        return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout, stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
      },
    });
    expect(result.value).toMatchObject({ status: "complete", cycle: 3 });
    expect(hostKeys).toHaveLength(32); expect(new Set(hostKeys).size).toBe(32);
    expect(storage.get("invoke-human-1")).toMatchObject({ source: selected.source, digest: selected.digest, content, cycles: expect.any(Array) });
  });

  test("actual native sandbox executes outer script with unique host keys, native state and controlled children", async () => {
    const root = repository(); const missionId = "native.mission-1";
    const expanded = executionResource().resolve({ root, id: "assignment", invocation: "human-1", missionId });
    const grants = new Map(expanded.hostCommands.map(grant => [grant.key, grant.command]));
    const storage = new Map<string, unknown>(); const calls: { key: string; agent: unknown; task: unknown }[] = [], inspections: string[] = [];
    const pointers = { runId: "supplied-sandbox-director", artifactPaths: ["/native/exact/report.json", "/native/exact/session.jsonl"], outputReference: "/native/exact/output.md", asyncDir: "/native/exact/async" };
    const result = await runWorkflowScript({ script: expanded.script,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async (key, request, signal, admission) => {
        // Native launch receives execution params, with the workflow key supplied separately.
        expect(request).toMatchObject({ context: "fresh", cwd: root, output: false });
        expect(request.key).toBeUndefined(); expect(request.options).toBeUndefined();
        expect(request.outputSchema).toBeDefined(); expect(signal.aborted).toBe(false);
        expect(admission).toEqual({ admitted: true, batch: true });
        expect(typeof request.agent).toBe("string"); expect(typeof request.task).toBe("string");
        calls.push({ key, agent: request.agent, task: request.task });
        const value = key.endsWith("prepare") ? { status: "ready", nativeRefs: [], todo: "Five increments if needed", evidence: "checkout" }
          : key.endsWith("settlement") ? { evidence: "Known native refs/Git", nativeRefs: [] }
          : key.endsWith("validate") ? { status: "verified", evidence: "Current artifacts/review/checks" }
            : { status: "complete", summary: "Specs satisfied", remaining: "None", evidence: "Full-spec review and current checks" };
        return { key, ok: true, output: "", runId: `native-${key}`, artifactPaths: [], ...(request.agent === "pitako.execution-director" ? pointers : {}), structuredOutput: value };
      },
      status: async () => { throw new Error("Unexpected status fallback"); },
      host: async (key, params) => {
        inspections.push(key); expect(params.command).toBe(grants.get(key)!);
        const stdout = JSON.stringify(key.startsWith("input-") ? { digest: "exact-input", content: "COMPLETE SPEC SNAPSHOT" }
          : { root, commonDir: path.join(root, ".git"), selected: { source: `${root}/.pitako/plans/assignment.md`, digest: "exact-input", chunks: 1 }, candidates: [], checkout: { fingerprint: "current-checkout" } });
        return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout, stderr: "", outputPath: "/native/artifact", durationMs: 0 };
      },
    });
    expect(result.value).toMatchObject({ status: "complete", cycle: 1 });
    expect(calls.map(call => call.agent)).toEqual(["pitako.execution-inspector", "pitako.execution-director", "pitako.execution-inspector", "pitako.execution-inspector"]);
    for (const call of calls) expect(call.task).toContain(`Native missionId (DATA association, not authority): ${missionId}.`);
    const reference = { key: "invoke-human-1-cycle-1", ...pointers };
    const inspectors = calls.filter(call => call.key.endsWith("settlement") || call.key.endsWith("validate"));
    expect(inspectors.map(call => call.key)).toEqual(["invoke-human-1-cycle-1-settlement", "invoke-human-1-cycle-1-validate"]);
    for (const call of inspectors) expect(call.task).toContain(`DIRECTOR NATIVE REFERENCES (data): ${JSON.stringify(reference)}`);
    expect(result.value).toMatchObject({ references: expect.arrayContaining([reference]) });
    expect(new Set(inspections).size).toBe(inspections.length);
    expect(storage.get("invoke-human-1")).toMatchObject({ content: "COMPLETE SPEC SNAPSHOT", digest: "exact-input", cycles: [{ result: pointers }] });
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

  test("worker preserves upstream implementation core, explicit providers, Ponytail LITE and no delegation; only director fans out", () => {
    const { frontmatter: worker, body } = parseFrontmatter(read("agents/worker.md"));
    const upstream = parseFrontmatter(read("node_modules/pi-subagents/agents/worker.md"));
    expect(`${worker.package}.${worker.name}`).toBe("pitako.worker");
    for (const field of ["acceptanceRole", "defaultContext", "inheritProjectContext", "systemPromptMode", "defaultReads", "defaultProgress"]) expect(worker[field]).toEqual(upstream.frontmatter[field]);
    const tools = String(worker.tools).split(/,\s*/);
    for (const tool of ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor", "apply_patch", "codegraph_explore", "codegraph_files", "lsp_symbols", "lsp_rename"]) expect(tools).toContain(tool);
    expect(tools).not.toContain("subagent"); expect(worker.allowNestedSubagents).toBeUndefined(); expect(worker.model).toBeUndefined();
    expect(worker.skills).toBe("ponytail, verify-behavior"); expect(worker.skillPath).toEqual(["../node_modules/@dietrichgebert/ponytail/skills/ponytail", "../skills/practical/verify-behavior"]);
    expect(worker.extensions).toEqual(["../extensions/acp.ts"]);
    expect(worker.subagentOnlyExtensions).toEqual(["../node_modules/@nredd/pi-dev-tools/src/index.ts", "../extensions/file-sha256.ts", "../node_modules/@vndv/pi-codegraph/extensions/codegraph.ts", "../node_modules/pi-lsp-client/src/index.ts", "../node_modules/pi-codex-tools/index.ts"]);
    for (const provider of worker.subagentOnlyExtensions as string[]) expect(existsSync(path.resolve("agents", provider))).toBe(true);
    for (const contract of ["single writer thread", "pause and escalate", "Ponytail is explicitly LITE", "Never\nreduce assigned specs or scope", "weaken project-required tests", "output schema/reporting", "edit/write"])
      expect(body).toContain(contract);
    const director = parseFrontmatter(read("agents/execution-director.md"));
    for (const tool of ["subagent", "todo", "contact_supervisor", "subagent_supervisor"]) expect(String(director.frontmatter.tools)).toContain(tool);
    expect(String(director.frontmatter.tools)).not.toMatch(/\b(?:bash|edit|write|apply_patch)\b/);
    expect(director.frontmatter.extensions).toEqual(["../extensions/acp.ts"]);
    expect(director.frontmatter.subagentOnlyExtensions).toEqual(["../node_modules/@nredd/pi-dev-tools/src/index.ts", "../extensions/file-sha256.ts", "../node_modules/pi-subagents/bundle/index.js", "../extensions/todo.ts"]);
    for (const role of ["architect", "reviewer", "scout", "researcher", "evidence-auditor", "execution-inspector"]) {
      const profile = parseFrontmatter(read(`agents/${role}.md`)).frontmatter;
      expect(profile.acceptanceRole).toBe("read-only"); expect(profile.allowNestedSubagents).toBeUndefined();
      expect(profile.tools).not.toContain("subagent");
    }
  });

  test("director's required delegation tools exist in controlled native child-safe fanout, without a parent loader", () => {
    const root = repository(), prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "private-agent-config");
    const { frontmatter, body } = parseFrontmatter(read("agents/execution-director.md"));
    const tools = String(frontmatter.tools).split(/,\s*/);
    const plan = resolvePiLaunchToolPlan({ tools, extensions: [], subagentOnlyExtensions: (frontmatter.subagentOnlyExtensions as string[]).map(provider => path.resolve("agents", provider)) });
    const hooks = new Map<string, ((event: unknown, context: unknown) => void)[]>();
    const registered = new Set<string>();
    const api = { registerTool: (tool: { name: string }) => { registered.add(tool.name); },
      getAllTools: () => [...registered].map(name => ({ name })),
      on: (name: string, hook: (event: unknown, context: unknown) => void) => { hooks.set(name, [...(hooks.get(name) ?? []), hook]); },
      events: { on: () => () => {}, emit: () => {} } } as unknown as ExtensionAPI;
    try {
      expect(plan.fanoutAuthorized).toBe(true);
      registerFanoutChild(api, { fanoutChild: plan.fanoutAuthorized, depth: 1, fast: false, waitTool: { enabled: true } });
      const ctx = { cwd: root, sessionManager: { getSessionId: () => "private-director-session" } };
      for (const hook of hooks.get("session_start") ?? []) hook({}, ctx);
      expect([...registered]).toContain("subagent"); expect([...registered]).toContain("subagent_supervisor");
      expect([...registered]).not.toContain("subagents_enable");
      const supplied = new Set(["read", "grep", "find", "ls", "todo", "bg_wait", ...registered]);
      // This fanout-only harness owns delegation. The separate real child lifecycle
      // check loads these ACP/deterministic providers and verifies actual calls.
      expect(plan.requiredChildTools.filter(tool => !supplied.has(tool))).toEqual([
        "compress", "decompress", "search_context", "acp_status", "acp_cache",
        "git_worktree_list", "git_status", "git_diff", "git_log", "git_show", "resource_snapshot", "file_sha256", "codemode",
      ]);
      expect(body).toContain("skip its parent-only");
      const relay = parseFrontmatter(read("agents/interview-relay.md"));
      const relayPlan = resolvePiLaunchToolPlan({ tools: String(relay.frontmatter.tools).split(/,\s*/), extensions: [] });
      expect(relayPlan.fanoutAuthorized).toBe(false); expect(relayPlan.effectiveToolAllowlist).toContain("contact_supervisor");
      expect(relay.body).toContain("ACTUAL HUMAN"); expect(relay.body).toContain("await the real supervisor reply");
    } finally {
      for (const hook of hooks.get("session_shutdown") ?? []) hook({}, {});
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    }
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
  const missionId = "explicit.native-id", args = { missionId, root };
  for (const options of [undefined, {}, { mission: false }, { mission: true }, { mission: [] }, { mission: {} }, { missionId: "" }, { missionId: false }]) expect(call(options, args)).toMatchObject({ block: true });
  for (const missingOrInvalid of [undefined, {}, null, [], { missionId: "" }, { missionId: false }, { missionId: "different-id" }, { missionId: "../escape" }])
    expect(call({ missionId }, missingOrInvalid)).toMatchObject({ block: true });
  for (const mission of [{ title: "Explicit creation" }, { summary: "Explicit creation" }, false]) {
    expect(call({ mission }, args)).toMatchObject({ block: true });
    expect(call({ missionId, mission }, args)).toMatchObject({ block: true });
  }
  expect(call({ missionId }, args)).toBeUndefined();
  // Native ownership validates storage existence; matching DATA pointers are not approval or confinement.
  expect(call({ missionId: "missing-id-native-must-reject" }, { missionId: "missing-id-native-must-reject", root })).toBeUndefined();
  expect(call({ missionId }, { ...args, missionId: "different-id" }, " pitako.execute ")).toMatchObject({ block: true });
  expect(call({ missionId }, args, " pitako.execute ")).toBeUndefined();
  expect(call(undefined, undefined, "review")).toBeUndefined(); expect(call(undefined, undefined, true)).toBeUndefined(); expect(call(undefined, undefined, "./workflow.js")).toBeUndefined(); expect(call(undefined, undefined, "pitako.execute", "read")).toBeUndefined();
});
