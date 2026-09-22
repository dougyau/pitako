import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPitakoConfigPath } from "../extensions/board/paths.ts";
import pitako from "../extensions/index.ts";
import { PitakoConfigError } from "../extensions/errors.ts";
import { getModelPolicy, getRole, loadPitakoConfig, resolveRole } from "../extensions/roles/load.ts";
import { ROLE_IDS } from "../extensions/roles/types.ts";
import { packageRoot } from "../extensions/stack.ts";
import { loadPitako } from "../scripts/load-pitako.ts";

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
      const role = getRole(id, { env });
      expect(role.instructions.length).toBeGreaterThan(0);
      expect(role.instructions).toContain("## Boundaries");
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
    expect(getRole("developer", { env }).skills).toContain("ponytail");
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

  test("Pi model capabilities reject an unknown id and an unsupported reasoning level", () => {
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
      expect(text).toContain("Fallback is for provider availability");
      expect(text).not.toContain("api_key");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("Board, todo, and coding skills still load", async () => {
    const loaded = await loadPitako(packageRoot());
    expect(loaded.extensions.errors).toEqual([]);
    const names: string[] = [];
    for (const extension of loaded.extensions.extensions) {
      for (const name of extension.tools.keys()) names.push(name);
    }
    expect(names).toContain("board_post");
    expect(names).toContain("todo");
    expect(names).toContain("codegraph_search");
    const skills = loaded.loader.getSkills().skills.map((skill) => skill.name);
    expect(skills).toContain("architect");
    expect(skills).toContain("ponytail");
  });
});
