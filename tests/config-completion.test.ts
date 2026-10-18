import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { completionCatalog, planConfigCompletion } from "../extensions/roles/config-completion.ts";
import { parsePitakoConfig } from "../extensions/roles/load.ts";
import { packageRoot } from "../extensions/stack.ts";

const options = { userConfigPath: path.join(tmpdir(), "unused-pitako-config.toml") };
describe("additive config completion", () => {
  for (const source of [
    "",
    "# User note\n[worker_history]\nttl_days = false\n",
    'agent_runtime.idle_timeout = "2m"\n[roles.developer]\nname = "Mine"\n',
    '"agent_runtime"."idle_timeout" = "2m"\n',
    'agent_runtime = { idle_timeout = "2m" }\n',
    '"agent_runtime" = { "idle_timeout" = "2m" }\n',
    'agent_runtime = { idle_timeout = "2m", }\n',
    'agent_runtime = {\nidle_timeout = "2m", # keep trailing comma\n}\n',
    'agent_runtime = { # empty inline group\n}\n',
    "agent_runtime = {}\n[worker_history]\nttl_days = 10",
    '[agent_runtime]\nidle_timeout = "2m" # mine',
    '# note\r\n["agent_runtime"]\r\n"idle_timeout" = "2m"\r\n[worker_history]\r\nttl_days = false',
    '[roles.developer]\ndescription = """\n# pitako:setting review.candidates\n[agent_runtime]\nvalue = \\"quote\\"\n"""\n',
    "[roles.developer]\ndescription = '''\n# pitako:setting review.topics\n[agent_runtime]\n'''\n",
    '[roles.developer]\nname = "escaped \\"quote\\" # not comment"\ndescription = """ends with a quote""""\n',
    '[model_policies.developer]\nprimary = { model = "fixture/model" }\nfallbacks = [{model="fixture/other"}]\n',
    '[review]\ncandidates = [{ model="fixture/model" }]\ntopics = [{ topic="security", candidates=[{model="fixture/other"}] }]\n',
  ]) {
    test(`preserves source and semantics: ${JSON.stringify(source.slice(0, 70))}`, () => {
      const proposal = planConfigCompletion(source, options);
      // Every original byte survives in order; only bounded insertions are allowed.
      let cursor = 0;
      for (const c of proposal) if (c === source[cursor]) cursor++;
      expect(cursor).toBe(source.length);
      expect(proposal.endsWith("\n")).toBe(!source || source.endsWith("\n"));
      if (source.includes("\r\n")) expect(proposal.replaceAll("\r\n", "")).not.toContain("\n");
      expect(planConfigCompletion(proposal, options)).toBe(proposal);
      expect({ ...parsePitakoConfig(source, options), userConfigPresent: true }).toEqual(parsePitakoConfig(proposal, options));
      const raw = parse(proposal);
      expect(raw.review).toEqual(parse(source).review);
      expect(raw.model_policies).toEqual(parse(source).model_policies);
    });
  }

  test("real markers suppress one example; marker strings do not", () => {
    const source = '# pitako:setting review.candidates\n[roles.developer]\nname = "# pitako:setting review.topics"\n';
    const result = planConfigCompletion(source, options);
    expect(result.match(/# pitako:setting review.candidates/g)).toHaveLength(1);
    expect(result.match(/# pitako:setting review.topics/g)).toHaveLength(2);
  });

  test("upgrades add a missing setting without rewriting existing examples or arrays", () => {
    const first = planConfigCompletion("", options);
    const old = first.replace(/^head_developer.max_parallel = 3\n/m, "")
      .replace('# roles.developer.name = "Developer"', '# roles.developer.name = "Old example"');
    const result = planConfigCompletion(old, options);
    expect(result).toContain('# roles.developer.name = "Old example"');
    expect(result).toContain("head_developer.max_parallel = 3");
    expect(parse(result)).toEqual(parse(first));
  });

  test("catalog uses actual role/policy IDs and shared nested target/topic fields", () => {
    const entries = completionCatalog(), names = entries.map(x => x.keys.join("."));
    const defaults = parse(readFileSync(path.join(packageRoot(), "config/defaults.toml"), "utf8"));
    for (const id of Object.keys(defaults.roles!))
      expect(names).toContain(`roles.${id}.instructions`);
    for (const id of Object.keys(defaults.model_policies!)) {
      expect(names).toContain(`model_policies.${id}.primary.fast`);
      expect(names).toContain(`model_policies.${id}.primary.reasoning`);
      expect(names).toContain(`model_policies.${id}.fallbacks`);
    }
    expect(entries.find(x => x.keys.join(".") === "review.topics")!.value).toEqual([
      { topic: "your topic", candidates: [{ model: "provider/model", reasoning: "default" }] },
    ]);
    const active = entries.filter(x => x.active);
    expect(active).toHaveLength(7);
    expect(active.every(x => ["agent_runtime", "worker_history", "developer_routing", "head_developer"].includes(x.keys[0]!))).toBe(true);
  });

  test("validates original/proposal at real user path, preserving instruction paths and inheritance", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-relative-"));
    try {
      const userConfigPath = path.join(root, "config.toml");
      writeFileSync(path.join(root, "custom.md"), "Private instructions");
      const source = '[roles.developer]\ninstructions = "custom.md"\n[model_policies.developer]\nprimary = { model="fixture/model" }\nfallbacks = [{model="fixture/fallback"}]\n';
      const result = planConfigCompletion(source, { userConfigPath });
      const config = parsePitakoConfig(result, { userConfigPath });
      expect(config.roles.developer!.instructionsPath).toBe(path.join(root, "custom.md"));
      expect(config.policies.developer_mid!.fallbacks).toEqual([{ model: "fixture/fallback" }]);
      expect(config.policies.developer_mid!.provenance).toEqual(parsePitakoConfig(source, { userConfigPath }).policies.developer_mid!.provenance);
      // Deliberate activation lives only in this private fixture.
      const example = completionCatalog().find(x => x.keys.join(".") === "roles.developer.instructions")!;
      writeFileSync(path.join(root, "instructions.md"), "Example instructions");
      expect(parsePitakoConfig(`roles.developer.instructions = ${JSON.stringify(example.value)}`, { userConfigPath }).roles.developer!.instructions).toBe("Example instructions");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("commented examples can be deliberately activated with private fixture choices", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-examples-"));
    try {
      const userConfigPath = path.join(root, "config.toml");
      writeFileSync(path.join(root, "instructions.md"), "Fixture example instructions");
      const complete = planConfigCompletion("", { userConfigPath });
      const activated = complete.split("\n").map(line => {
        if (!/^# (roles|model_policies|architecture|review)\./.test(line)) return line;
        const choice = line.slice(2);
        return choice.replaceAll("provider/model", choice.includes(".fallbacks =") ? "fixture/fallback" : "fixture/model");
      }).join("\n");
      const config = parsePitakoConfig(activated, { userConfigPath });
      expect(config.roles.developer!.instructions).toBe("Fixture example instructions");
      expect(config.review!.topics[0]!.topic).toBe("your topic");
      expect(config.policies.developer_head!.primary).toEqual({ model: "fixture/model", fast: false });
      expect(config.policies.developer_head!.fallbacks).toEqual([{ model: "fixture/fallback", fast: false }]);
      writeFileSync(userConfigPath, activated);
      expect(planConfigCompletion(activated, { userConfigPath })).toBe(activated);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const source of ["[broken", "unknown=1", "head_developer.max_parallel=0", '[review]\ncandidates=[]', 'roles.developer.instructions="missing.md"'])
    test(`rejects invalid original ${source}`, () => { expect(() => planConfigCompletion(source, options)).toThrow(); });
});
