import { stubExternalFactories } from "./fixtures/offline.ts";
stubExternalFactories();
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPitakoConfigPath } from "../extensions/board/paths.ts";
import pitako from "../extensions/index.ts";
import { PitakoConfigError } from "../extensions/errors.ts";
import { getModelPolicy, getRole, loadPitakoConfig, resolveDeveloperHeadFromConfig, resolveRole, resolveRoleFromConfig } from "../extensions/roles/load.ts";
import { inspectPitako } from "../extensions/roles/format.ts";
import { ROLE_IDS, DEVELOPER_PROFILES } from "../extensions/roles/types.ts";
import { packageRoot } from "../extensions/stack.ts";
import { childInstructions, skillNamesForRole } from "../extensions/agent/run.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempAgent(): { env: NodeJS.ProcessEnv; configPath: string } {
  const agent = mkdtempSync(path.join(tmpdir(), "pitako-roles-"));
  tempDirs.push(agent);
  if (!agent.startsWith(tmpdir())) throw new Error(`refusing to use agent dir ${agent}`);
  const configPath = path.join(agent, "pitako", "config.toml");
  return { env: { PI_CODING_AGENT_DIR: agent }, configPath };
}

function writeConfig(configPath: string, text: string): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, text);
}

describe("role and model policy resolution", () => {
  test("internal Head composes effective Developer instructions but has an independent model policy", () => {
    const { env, configPath } = tempAgent();
    writeConfig(configPath, `
[roles.developer]
instructions = "local-developer.md"
skills = ["ponytail", "verify-behavior"]
principles = ["principle-fix-root-causes"]
[model_policies.developer.primary]
model = "fixture/legacy"
reasoning = "medium"
[[model_policies.developer.fallbacks]]
model = "fixture/worker-fallback"
reasoning = "low"
`);
    writeFileSync(path.join(path.dirname(configPath), "local-developer.md"), "Effective Developer assignment contract.");
    const legacyOnly = loadPitakoConfig({ env });
    const missingHead = resolveDeveloperHeadFromConfig(legacyOnly);
    expect(Object.keys(legacyOnly.roles).sort()).toEqual([...ROLE_IDS].sort());
    expect(DEVELOPER_PROFILES).not.toContain("developer_head");
    expect(() => resolveRoleFromConfig(legacyOnly, "developer_head")).toThrow('unknown role "developer_head"');
    expect(missingHead.modelPolicy.primary).toBeUndefined();
    expect(missingHead.modelPolicy.fallbacks).toEqual([]);
    expect(missingHead.modelPolicy.diagnostic).toContain("[model_policies.developer_head.primary]");
    expect(missingHead.modelPolicy.diagnostic).toContain(configPath);
    expect(resolveRoleFromConfig(legacyOnly, "developer").modelPolicy.primary?.model).toBe("fixture/legacy");
    const prior = readFileSync(configPath, "utf8");
    writeConfig(configPath, prior + `
[model_policies.developer_head.primary]
model = "fixture/head"
reasoning = "high"
[[model_policies.developer_head.fallbacks]]
model = "fixture/head-fallback"
reasoning = "default"
[model_policies.developer_senior.primary]
model = "fixture/senior"
reasoning = "xhigh"
[model_policies.developer_mid.primary]
model = "fixture/mid"
reasoning = "off"
[model_policies.developer_junior.primary]
model = "fixture/junior"
`);
    const config = loadPitakoConfig({ env });
    const head = resolveDeveloperHeadFromConfig(config);
    expect(head.modelPolicy.primary).toEqual({ model: "fixture/head", reasoning: "high" });
    expect(head.modelPolicy.fallbacks).toEqual([{ model: "fixture/head-fallback" }]);
    expect(DEVELOPER_PROFILES.map(profile => resolveRoleFromConfig(config, "developer", profile).modelPolicy.primary))
      .toEqual([{ model: "fixture/senior", reasoning: "xhigh" }, { model: "fixture/mid", reasoning: "off" }, { model: "fixture/junior" }]);
    const developer = resolveRoleFromConfig(config, "developer");
    expect(head.skills).toEqual(developer.skills);
    expect(head.principles).toEqual(developer.principles);
    const delivered = childInstructions(head, "internal-head-fixture");
    expect(delivered).toContain(developer.instructions);
    for (const obligation of [
      "Effective Developer assignment contract.", "actual observations", "input receipt is not compliance",
      "expand local work", "write envelope", "escalate to the coordinator",
      "underlying observed evidence before satisfying", "Inspect the integrated diff and evidence",
      "verify-behavior", "Ponytail",
      "Choose whether to create leaves", "An empty graph, delegated work, or a combination is valid",
      "initial work, corrections, cleanup, and recovery",
      "does not change frozen units, their order, scope, permissions, or acceptance",
      "Explicit user constraints and safety or resource limits remain binding",
      "without taking over your local scheduling",
      "Do not edit product before the exclusive integration barrier, including when you choose no leaves",
      "An empty graph uses the same barrier",
    ]) expect(delivered).toContain(obligation);
    expect(delivered).not.toContain("Delegate during execution");
    expect(skillNamesForRole(head)).toContain("verify-behavior");
    expect(skillNamesForRole(head)).toContain("ponytail");
    writeConfig(configPath, prior + '[roles.developer_head]\nname = "Public Head"\n');
    expect(() => loadPitakoConfig({ env })).toThrow('unknown role "developer_head"');
  });

  test("routing identity and Head concurrency are validated configuration, not model defaults", () => {
    const { env, configPath } = tempAgent();
    const defaults = loadPitakoConfig({ env });
    expect(defaults.developerRouting).toEqual({ classifierProvider: "opencode", classifierModel: "jev-1.13-free" });
    expect(defaults.headDeveloper.maxParallel).toBe(3);
    writeConfig(configPath, `
[developer_routing]
classifier_provider = "fixture"
classifier_model = "capacity/v2"
[head_developer]
max_parallel = 7
`);
    const configured = loadPitakoConfig({ env });
    expect(configured.developerRouting).toEqual({ classifierProvider: "fixture", classifierModel: "capacity/v2" });
    expect(configured.headDeveloper.maxParallel).toBe(7);
    for (const max of ["0", "-1", "1.5", '"3"', "9007199254740992.0", "false"]) {
      writeConfig(configPath, `[head_developer]\nmax_parallel = ${max}\n`);
      expect(() => loadPitakoConfig({ env })).toThrow(`${configPath}: head_developer.max_parallel: expected a positive safe integer`);
    }
    writeConfig(configPath, "[head_developer]\nmax_parallel = 9007199254740992\n");
    expect(() => loadPitakoConfig({ env })).toThrow("integer value cannot be represented losslessly");
    for (const text of [
      '[head_developer]\nquota = 1\n',
      '[developer_routing]\nunknown = "fixture"\n',
      '[developer_routing]\nclassifier_provider = "provider/model"\n',
      '[developer_routing]\nclassifier_model = "invalid model"\n',
      '[developer_routing]\nclassifier_model = ""\n',
      '[developer_routing]\nclassifier_provider = 3\n',
    ]) {
      writeConfig(configPath, text);
      expect(() => loadPitakoConfig({ env })).toThrow(PitakoConfigError);
      expect(() => loadPitakoConfig({ env })).toThrow(configPath);
    }
  });

  test("Developer capacity policies inherit explicit legacy fields, not a second role contract", () => {
    const { env, configPath } = tempAgent();
    writeConfig(configPath, `
[roles.developer]
model_policy = "architect"
[model_policies.architect.primary]
model = "fixture/legacy"
reasoning = "medium"
fast = true
[[model_policies.architect.fallbacks]]
model = "fixture/fallback"
reasoning = "low"
[model_policies.developer_senior.primary]
model = "fixture/senior"
reasoning = "high"
[model_policies.developer_junior]
fallbacks = []
`);
    const config = loadPitakoConfig({ env });
    const developer = getRole("developer", { env });
    for (const profile of DEVELOPER_PROFILES) {
      const role = resolveRoleFromConfig(config, "developer", profile);
      expect(role.instructions).toBe(developer.instructions);
      expect(role.skills).toEqual(developer.skills);
      expect(role.principles).toEqual(developer.principles);
      expect(role.id).toBe("developer");
      expect(role.modelPolicyId).toBe(profile);
    }
    const mid = resolveRole("developer", { env });
    expect(mid.modelPolicy.primary).toEqual({ model: "fixture/legacy", reasoning: "medium", fast: true });
    expect(mid.modelPolicy.fallbacks).toEqual([{ model: "fixture/fallback", reasoning: "low" }]);
    expect(mid.modelPolicy.provenance?.primary).toBe("architect");
    expect(config.policies.developer_senior?.primary).toEqual({ model: "fixture/senior", reasoning: "high" });
    expect(config.policies.developer_senior?.fallbacks).toEqual(mid.modelPolicy.fallbacks);
    expect(config.policies.developer_junior?.fallbacks).toEqual([]);
    expect(inspectPitako("policy developer_senior", { env })).toContain("primary source: developer_senior");
    expect(inspectPitako("policy developer_senior", { env })).toContain("fallbacks source: architect");
    expect(resolveRole("architect", { env }).modelPolicyId).toBe("architect");
  });
  test("shipped roles distinguish assignment completion from independent acceptance", () => {
    const { env } = tempAgent();
    const developer = resolveRole("developer", { env }).instructions;
    for (const contract of [
      "Do not hand back an ordinary implementation problem you can resolve",
      "Verification-only work establishes the requested observations and relevant bindings",
      "not another complete semantic review",
      "Diagnosis-only work does not authorize repair",
      "cleanup may conclude with no useful edits",
      "Debugging guidance cannot turn diagnosis into permission to edit",
      "requested outcome, necessary cleanup, and evidence recording are complete",
    ]) expect(developer).toContain(contract);
    const reviewer = childInstructions(resolveRole("reviewer", { env }), "reviewer-navigation-fixture");
    for (const contract of [
      "An explicit consultation answers its question",
      "prior finding, intervening change, and affected contracts",
      "Neither is final approval",
      "unspecified change-review request requires the complete relevant diff",
      "complete agreed final diff, underlying evidence, and relevant effects",
      "does not automatically authorize causal investigation",
      "Inspect available relevant evidence before declaring a gap",
      "indispensable missing observation, its effect on the decision, and the next feasible authorized capture",
      "An inconclusive consultation does not accept an incomplete implementation",
      "A material final-review gap remains a finding",
      "Choose tools for the question you need to answer, not for a tool-use quota",
      "`codegraph_node` for source and relationships, `codegraph_callers` for consumers",
      "A partial structural result justifies a targeted follow-up",
      "When codemode is available, batch independent queries",
      "source references, errors, and limitations for each result",
      "Run dependent queries in sequence",
      "Keep a single direct tool call when it answers the question",
      "Do not batch broad file dumps merely to reduce call count",
      "Treat source returned by a navigation tool as already read",
      "retain a short evidence map in your working context",
      "Reopen source when it changed, the captured result was incomplete, or a concrete doubt needs verification",
      "If CodeGraph or LSP is unavailable, continue with raw tools",
      "do not narrow the agreed diff or replace independent inspection",
    ]) expect(reviewer).toContain(contract);
  });

  test("user instructions replace built-ins without rewriting an already resolved role", () => {
    const { env, configPath } = tempAgent();
    const delivered = resolveRole("developer", { env });
    writeConfig(configPath, '[roles.developer]\ninstructions = "custom.md"\n');
    writeFileSync(path.join(path.dirname(configPath), "custom.md"), "User-defined instructions");
    expect(resolveRole("developer", { env }).instructions).toBe("User-defined instructions");
    expect(delivered.instructions).toContain("Verification-only work");
  });

  test("testing boundaries reach resolved role and owned child instructions", () => {
    const { env } = tempAgent();
    // Observe Pitako's local assembly, not a real SDK session or model compliance.
    for (const id of ["developer", "reviewer", "researcher", "coordinator"] as const) {
      const role = resolveRole(id, { env });
      const instructions = childInstructions(role, `${id}-fixture`);
      expect(instructions).toContain(role.instructions);
      expect(instructions).toContain("active project's own behavior and declared testing scope");
      expect(instructions).toContain("Reading an external boundary does not authorize dependency certification or repair");
      expect(instructions).toContain("scope, contracts, and active guide, not Pitako's distributed stack");
      expect(skillNamesForRole(role)).toContain("verify-behavior");
      if (id === "reviewer") {
        expect(instructions).toContain("Do not demand a real replaced runtime solely because a controlled boundary double verifies an owned rule");
      }
      if (id === "coordinator") {
        expect(instructions).toContain("out-of-scope external checks into acceptance, preflight, or final gates");
        const policy = instructions.replace(/\s+/g, " ");
        for (const obligation of [
          "Under `$execute`, every new exterior Developer assignment",
          'asynchronous `role: "developer"`, `mode: "head"`, and explicit authorized relative `writes`',
          "initial implementation, implementation-related diagnosis, correction, focused in-unit verification, product cleanup edits, and recovery",
          "Small scope, short duration, or no leaves do not justify single mode",
          "`writes: []` for read-only focused work",
          "fresh Head after prior physical settlement and normal admission",
          "a no-op cleanup creates no Developer",
          "Never delegate the principal final complete procedure",
          'deliberately use `mode: "single"` without `writes`',
          "prohibition on leaves or parallelism alone still permits Head",
          "Missing `developer_head` policy, invalid envelope, occupied role, unavailable asynchronous Head support, and binding rejection remain blockers",
          "no agent or Team tools are registered",
          "cannot become Head through steering",
          "cancel only that handle and end the turn for physical settlement",
          "already-returned model-facing host proof of released closure for that exact handle, required Team hold recovery, and normal admission",
          "`team_cancel` pending receipt supplies no proof",
          "Without proof, no Head starts in this invocation",
          "preserve blockers, resources, and holds",
          "Do not recancel, poll, probe, switch transport, or add an observation API",
          "without manufacturing a Head replay",
          "foreground profile hook does not load this role file",
        ]) expect(policy).toContain(obligation);
        for (const obligation of [
          "Head decides whether to create leaves",
          "corrections, cleanup, and recovery",
          "Do not prescribe a leaf count, node allocation, no-delegation rule, or sole-writer strategy",
          "each obligation and its basis",
          "not take over Head scheduling",
          "You retain escalation and independent acceptance",
        ]) expect(instructions).toContain(obligation);
      }
    }
  });

  test("built-in roles resolve without a user config and do not read the home config", () => {
    expect(getPitakoConfigPath({})).toBe(path.join(homedir(), ".pi", "agent", "pitako", "config.toml"));
    const { env, configPath } = tempAgent();
    expect(getPitakoConfigPath(env)).toBe(configPath);
    const config = loadPitakoConfig({ env });
    expect(config.userConfigPresent).toBe(false);
    expect(Object.keys(config.roles).sort()).toEqual([...ROLE_IDS].sort());
    const architect = getRole("architect", { env });
    expect(architect.modelPolicy).toBe("architect");
    expect(architect.skills).toEqual(["architect", "how", "why", "blast-radius"]);
    expect(architect.principles).toContain("principle-foundational-thinking");
    expect(architect.instructions).toContain("You own system structure");
    expect(architect.instructionsPath.endsWith(`${path.sep}roles${path.sep}architect.md`)).toBe(true);
    for (const id of ROLE_IDS) {
      const role = resolveRole(id, { env });
      expect(role.instructions.length).toBeGreaterThan(0);
      expect(role.instructions).toContain("## Boundaries");
      expect(role.skills.filter((name) => name === "verify-behavior")).toHaveLength(id === "architect" ? 0 : 1);
      const names = [...role.skills, ...role.principles];
      for (const retired of ["tdd", "show-me-your-work", "principle-prove-it-works"]) {
        expect(names).not.toContain(retired);
      }
      expect(role.principles).not.toContain("verify-behavior");
    }
    const resolved = resolveRole("architect", { env });
    expect(resolved.modelPolicyId).toBe("architect");
    expect(resolved.modelPolicy.primary).toBeUndefined();
    expect(resolved.modelPolicy.selected).toBeUndefined();
    expect(resolved.modelPolicy.fallbackReason).toBeUndefined();
    expect(resolved.modelPolicy.diagnostic).toContain("no primary target");
    expect(resolved.modelPolicy.diagnostic).toContain(configPath);
    expect(getModelPolicy("developer", { env }).fallbacks).toEqual([]);
  });

  test("user config replaces policy targets and explicit arrays, and preserves omitted fields", () => {
    const { env, configPath } = tempAgent();
    writeConfig(
      configPath,
      `
[roles.architect]
skills = ["how"]

[roles.developer]
skills = ["ponytail", "verify-behavior"]
principles = ["principle-fix-root-causes"]

[model_policies.architect.primary]
model = "openai-codex/gpt-5.6-sol"
reasoning = "high"

[[model_policies.architect.fallbacks]]
model = "example/strong"
reasoning = "high"

[[model_policies.architect.fallbacks]]
model = "example/medium-model"
reasoning = "medium"
`,
    );
    const other = tempAgent();
    const untouched = resolveRole("architect", { env: other.env });
    expect(untouched.skills).toContain("architect");
    expect(untouched.modelPolicy.primary).toBeUndefined();

    const resolved = resolveRole("architect", { env });
    expect(resolved.skills).toEqual(["how"]);
    expect(resolved.principles).toContain("principle-model-the-domain");
    expect(resolved.instructions).toContain("You own system structure");
    expect(resolved.modelPolicy.primary).toEqual({ model: "openai-codex/gpt-5.6-sol", reasoning: "high" });
    expect(resolved.modelPolicy.fallbacks.map((target) => target.model)).toEqual(["example/strong", "example/medium-model"]);
    expect(resolved.modelPolicy.fallbacks.map((target) => target.reasoning)).toEqual(["high", "medium"]);
    expect(resolved.modelPolicy.requested).toEqual(resolved.modelPolicy.primary);
    expect(resolved.modelPolicy.selected).toEqual(resolved.modelPolicy.primary);
    expect(resolved.modelPolicy.fallbackIndex).toBeUndefined();
    expect(getRole("developer", { env }).skills).toEqual(["ponytail", "verify-behavior"]);
    expect(getRole("developer", { env }).principles).toEqual(["principle-fix-root-causes"]);
    expect(getRole("reviewer", { env }).skills).toEqual(["blast-radius", "verify-behavior"]);
  });

  test("fast is a strict target setting and part of target identity", () => {
    const { env, configPath } = tempAgent();
    writeConfig(
      configPath,
      `[model_policies.architect.primary]
model = "example/model"
reasoning = "high"
fast = true

[[model_policies.architect.fallbacks]]
model = "example/model"
reasoning = "high"
fast = false

[[model_policies.architect.fallbacks]]
model = "example/fallback"
fast = true
`,
    );
    const policy = resolveRole("architect", { env }).modelPolicy;
    expect(policy.primary).toEqual({ model: "example/model", reasoning: "high", fast: true });
    expect(policy.fallbacks).toEqual([
      { model: "example/model", reasoning: "high", fast: false },
      { model: "example/fallback", fast: true },
    ]);

    for (const command of ["role architect", "policy architect"]) {
      const output = inspectPitako(command, { env });
      expect(output).toContain("fast: true");
      expect(output).toContain("fast: false");
      expect(output).toContain("Fast is requested configuration, not a provider grant.");
    }

    writeConfig(
      configPath,
      `[model_policies.architect.primary]
model = "example/model"
reasoning = "high"

[[model_policies.architect.fallbacks]]
model = "example/model"
reasoning = "high"
fast = false
`,
    );
    expect(() => loadPitakoConfig({ env })).toThrow(/model_policies\.architect\.fallbacks\[0\].*duplicate target/);
  });

  test("invalid and misplaced fast fields report their config paths", () => {
    const { env, configPath } = tempAgent();
    writeConfig(configPath, '[model_policies.architect.primary]\nmodel = "example/model"\nfast = "true"\n');
    expect(() => loadPitakoConfig({ env })).toThrow(/model_policies\.architect\.primary\.fast: expected boolean/);

    writeConfig(configPath, '[model_policies.architect]\nfast = true\n');
    expect(() => loadPitakoConfig({ env })).toThrow(/unknown key model_policies\.architect\.fast/);
  });

  test("malformed config fails with the file and field", () => {
    const { env, configPath } = tempAgent();
    writeConfig(configPath, "[[[");
    expect(() => loadPitakoConfig({ env })).toThrow(PitakoConfigError);
    expect(() => loadPitakoConfig({ env })).toThrow(/invalid TOML/);

    writeConfig(configPath, "[roles.architect]\nmodel_policy = \"missing\"\n");
    expect(() => loadPitakoConfig({ env })).toThrow(/unknown model policy "missing"/);

    writeConfig(configPath, "[roles.nope]\nname = \"Nope\"\n");
    expect(() => loadPitakoConfig({ env })).toThrow(/unknown role "nope"/);

    writeConfig(configPath, "[roles.architect]\ninstructions = \"missing.md\"\n");
    expect(() => loadPitakoConfig({ env })).toThrow(/missing role instruction file/);

    for (const field of ["skills", "principles"]) {
      for (const retired of ["tdd", "show-me-your-work", "principle-prove-it-works"]) {
        writeConfig(configPath, `[roles.developer]\n${field} = ["${retired}"]\n`);
        expect(() => loadPitakoConfig({ env })).toThrow(`roles.developer.${field}[0]: unknown skill "${retired}"`);
      }
    }
    writeConfig(configPath, '[roles.developer]\nskills = ["verify-behavior", "verify-behavior"]\n');
    expect(() => loadPitakoConfig({ env })).toThrow(/duplicate "verify-behavior"/);

    writeConfig(
      configPath,
      "[model_policies.architect.primary]\nmodel = \"openai-codex/gpt-5.6-sol\"\nreasoning = \"turbo\"\n",
    );
    expect(() => loadPitakoConfig({ env })).toThrow(/invalid reasoning level "turbo"/);

    writeConfig(configPath, "[model_policies.developer.primary]\nmodel = \"example/coder\"\nreasoning = \"default\"\n");
    expect(resolveRole("developer", { env }).modelPolicy.primary).toEqual({ model: "example/coder" });

    writeConfig(configPath, "[model_policies.architect.primary]\nmodel = \"gpt-5\"\n");
    expect(() => loadPitakoConfig({ env })).toThrow(/invalid model id "gpt-5"/);

    writeConfig(
      configPath,
      "[[model_policies.architect.fallbacks]]\nmodel = \"example/only\"\nreasoning = \"low\"\n",
    );
    expect(() => loadPitakoConfig({ env })).toThrow(/primary target missing/);

    writeConfig(
      configPath,
      `[model_policies.architect.primary]
model = "example/one"
reasoning = "high"

[[model_policies.architect.fallbacks]]
model = "example/one"
reasoning = "high"
`,
    );
    expect(() => loadPitakoConfig({ env })).toThrow(/duplicate target/);

    writeConfig(configPath, "[model_policies.architect]\nfallback_on = [\"rate_limit\"]\n");
    expect(() => loadPitakoConfig({ env })).toThrow(/unknown key model_policies.architect.fallback_on/);
  });

  test("supplied model capabilities reject an unknown id and an unsupported reasoning level", () => {
    const { env, configPath } = tempAgent();
    writeConfig(
      configPath,
      `[model_policies.architect.primary]
model = "example/fast"
reasoning = "xhigh"
`,
    );
    const models = [
      { provider: "example", id: "fast", reasoning: true },
      { provider: "example", id: "slow", reasoning: false },
    ];
    expect(() => loadPitakoConfig({ env, availableModels: models })).toThrow(/not supported by example\/fast/);
    writeConfig(configPath, "[model_policies.architect.primary]\nmodel = \"example/missing\"\nreasoning = \"low\"\n");
    expect(() => loadPitakoConfig({ env, availableModels: models })).toThrow(/unknown model "example\/missing"/);
    writeConfig(configPath, "[model_policies.reviewer.primary]\nmodel = \"example/slow\"\nreasoning = \"high\"\n");
    expect(() => loadPitakoConfig({ env, availableModels: models })).toThrow(/not supported by example\/slow/);
    writeConfig(configPath, "[model_policies.reviewer.primary]\nmodel = \"example/slow\"\nreasoning = \"off\"\n");
    expect(resolveRole("reviewer", { env, availableModels: models }).modelPolicy.primary?.reasoning).toBe("off");
  });
});

describe("pitako role commands", () => {
  test("/pitako role architect shows the effective definition", async () => {
    const { env, configPath } = tempAgent();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
    writeConfig(
      configPath,
      `[model_policies.architect.primary]
model = "example/architect"
reasoning = "high"
`,
    );
    try {
      const notices: string[] = [];
      const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
      const pi = {
        registerFlag() {},
        registerTool() {},
        getFlag() {
          return undefined;
        },
        on() {},
        registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) {
          commands.set(name, spec.handler);
        },
        getActiveTools() {
          return [];
        },
        getAllTools() {
          return [];
        },
        setActiveTools() {},
        getSessionName() {
          return "kept";
        },
        setSessionName() {},
      };
      pitako(pi as unknown as ExtensionAPI);
      const handler = commands.get("pitako");
      if (!handler) throw new Error("/pitako was not registered");
      await handler("role architect", {
        hasUI: true,
        ui: {
          notify(message: string) {
            notices.push(message);
          },
        },
      });
      const text = notices.join("\n");
      expect(text).toContain("Architect");
      expect(text).toContain("example/architect");
      expect(text).toContain("reasoning: high");
      expect(text).toContain("blast-radius");
      expect(text).toContain("Configured fallbacks are availability targets");
      expect(text).not.toContain("not selected in this version");
      expect(text).not.toContain("api_key");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("declares Board, todo and coding resources", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")).pi;
    expect(manifest.extensions).toContain("./extensions/board/index.ts");
    expect(manifest.extensions).toContain("./extensions/todo.ts");
    expect(manifest.skills).toContain("./skills/practical");
    expect(manifest.skills).toContain("./node_modules/@dietrichgebert/ponytail/skills/ponytail");
  });
});
