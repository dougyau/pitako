import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, mock, spyOn, test } from "bun:test";
import * as acp from "billion-context-pi";
import * as rpivTodo from "@juicesharp/rpiv-todo";
import { parseFrontmatter, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_SKILL_NAMES,
  EXCLUDED_SKILL_NAMES,
  OPTIONAL_LANGUAGE_SKILLS,
  THIRD_PARTY_ALWAYS_ON_MARKERS,
  skillStatusLines,
} from "../extensions/catalog.ts";
import pitako from "../extensions/index.ts";
import { profileNote } from "../extensions/profile.ts";
import { packageRoot } from "../extensions/stack.ts";
import { toolsForProfile } from "../extensions/profile.ts";
import { captureCallContext, hasReadDefinitionGuard } from "../extensions/workflow-engine.ts";

function readRepo(relative: string): string {
  return readFileSync(path.join(packageRoot(), relative), "utf8");
}

describe("engineering-layer composition", () => {
  test("TODO composition delegates upstream execution and keeps native model-only exposure", async () => {
    const upstream = { content: [], details: { tasks: [], nextId: 1 } };
    const execute = mock(async (..._args: unknown[]) => {
      return upstream;
    });
    const todo: ToolDefinition = {
      name: "todo", label: "TODO", description: "controlled upstream tool",
      parameters: Type.Object({}), execute,
    };
    const other = { ...todo, name: "other", exposure: "codemode" as const };
    const tools: ToolDefinition[] = [];
    const pi = {
      registerTool(tool: ToolDefinition) { tools.push(tool); },
      on() { return () => {}; },
      registerCommand() {},
    };
    let forwarded: ExtensionAPI | undefined;
    const registration = spyOn(rpivTodo, "default").mockImplementation(api => {
      forwarded = api;
      api.registerTool(todo);
      api.registerTool(other);
    });
    const root = mkdtempSync(path.join(tmpdir(), "pitako-todo-composition-"));
    try {
      const extension = await import("../extensions/todo.ts");
      extension.default(pi as unknown as ExtensionAPI);
      expect(registration).toHaveBeenCalledTimes(1);
      expect(forwarded?.on).toBe(pi.on);
      expect(forwarded?.registerCommand).toBe(pi.registerCommand);
      expect(tools[0]).toMatchObject({ name: todo.name, label: todo.label, description: todo.description, exposure: "model-only" });
      expect(tools[0]!.parameters).toEqual(todo.parameters);
      expect(hasReadDefinitionGuard(tools[0]!.parameters)).toBe(true);
      const controller = new AbortController(), update = () => {};
      const ctx = { cwd: root, sessionManager: {} } as unknown as ExtensionToolContext, args = {};
      const result = await tools[0]!.execute("native-id", args, controller.signal, update, ctx);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith("native-id", args, controller.signal, update, ctx);
      expect(result).toBe(upstream);
      expect(tools[1]).toBe(other);
      expect(todo.exposure).toBeUndefined();
    } finally {
      registration.mockRestore();
      const context = captureCallContext(root);
      if (context.kind === "ordinary") context.guard.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ACP defaults disable implicit bash deadlines without starting the external runtime", async () => {
    const tools: ToolDefinition[] = [];
    const known = ["compress", "decompress", "search_context", "acp_status", "acp_cache"];
    const definitions = [...known, "delegate", "execute", "future_context"].map(name => ({
      name, label: name, description: name, parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    }));
    const factory = (pi: ExtensionAPI) => { for (const tool of definitions) pi.registerTool(tool); };
    const registration = spyOn(acp, "createAcpExtension").mockReturnValue(factory);
    try {
      const extension = await import("../extensions/acp.ts");
      expect(registration).toHaveBeenCalledTimes(1);
      expect(registration).toHaveBeenCalledWith({
        delegate: false, autoUpdate: false, toolBashDefaultTimeout: 0,
      });
      extension.default({ registerTool(tool: ToolDefinition) { tools.push(tool); } } as unknown as ExtensionAPI);
      for (const [index, tool] of tools.entries()) {
        expect(hasReadDefinitionGuard(tool.parameters)).toBe(known.includes(tool.name));
        expect(hasReadDefinitionGuard({ ...tool.parameters })).toBe(false);
        if (!known.includes(tool.name)) expect(tool).toBe(definitions[index]);
      }
    } finally {
      registration.mockRestore();
    }
  });

  test("declares curated resources without executing external extensions", () => {
    const manifest = JSON.parse(readRepo("package.json")).pi;
    expect(readRepo("skills/pre-pr/SKILL.md")).toContain("Prepare the current worktree");
    expect(manifest.extensions[0]).toBe("./extensions/index.ts");
    for (const entry of ["./extensions/board/index.ts", "./extensions/agent/index.ts",
      "./node_modules/@vndv/pi-codegraph/extensions/codegraph.ts", "./node_modules/pi-lsp-client/src/index.ts",
      "./extensions/todo.ts"]) expect(manifest.extensions).toContain(entry);
    expect(manifest.extensions.filter((entry: string) => entry === "./extensions/todo.ts")).toHaveLength(1);
    expect(manifest.extensions).not.toContain("./node_modules/@juicesharp/rpiv-todo/index.ts");
    expect(manifest.extensions.some((entry: string) => entry.includes("ponytail"))).toBe(false);
    const skills = manifest.skills.filter((entry: string) => !entry.includes("node_modules"));
    expect(skills).toEqual(expect.arrayContaining(["./skills/pitako-coding", "./skills/practical", "./skills/principles"]));
    for (const name of ["pitako-coding", "ponytail", "caveman", "verify-behavior"]) expect(DEFAULT_SKILL_NAMES as readonly string[]).toContain(name);
    for (const name of [...EXCLUDED_SKILL_NAMES, ...OPTIONAL_LANGUAGE_SKILLS]) expect(DEFAULT_SKILL_NAMES as readonly string[]).not.toContain(name);
    const tools = ["codegraph_search", "codegraph_impact", "lsp_symbols", "read", "grep", "bash", "edit", "write"];
    const active = toolsForProfile({ available: tools, profile: "coding" });
    expect(active).toEqual(expect.arrayContaining(tools));
  });

  test("architecture discussion ships separately from managed tables", () => {
    const manifest = JSON.parse(readRepo("package.json"));
    expect(manifest.files).toContain("skills");
    expect(manifest.pi.skills).toContain("./skills/architecture");
    expect(DEFAULT_SKILL_NAMES as readonly string[]).toContain("architecture");
    const skill = readRepo("skills/architecture/SKILL.md");
    expect(skill).toMatch(/^---\nname: architecture\ndescription: .+\n---/);
    for (const contract of [
      "same complete problem", "Use only `pi-subagents`",
      "Never exceed five rounds", "Do not split the work",
      "resume: lastRunId", "does not replace a required managed",
    ]) expect(skill).toContain(contract);
    for (const contract of ["async: true", "advanced-rolling-child-runs", "steering-a-workflow-child", "continuation"])
      expect(skill).toContain(contract);
    expect(readRepo("skills/architecture/workflow.js")).toContain("runs.steer");
    expect(readRepo("README.md")).toContain("/skill:architecture <decision>");
    expect(readRepo("skills/pitako-coding/SKILL.md")).toContain("`architecture`");
  });

  test("ships a task-assigned architect with explicit read-only navigation and selected principles", async () => {
    const manifest = JSON.parse(readRepo("package.json"));
    expect(manifest.files).toContain("agents");
    expect(manifest.pi.subagents.agents).toEqual(["./agents"]);
    const source = readRepo("agents/architect.md");
    const { frontmatter: profile, body } = parseFrontmatter(source);
    // The agent adapter's scalar/list parser differs from Pi's YAML parser.
    const agentParser = await import(path.join(packageRoot(), "node_modules/pi-subagents/src/agents/frontmatter.js"));
    const nativeProfile = agentParser.parseFrontmatter(source).frontmatter;
    expect(agentParser.parseFrontmatterList(nativeProfile.extensions)).toEqual([]);
    expect(`${profile.package}.${profile.name}`).toBe("pitako.architect");
    expect(profile).toMatchObject({
      acceptanceRole: "read-only", defaultContext: "fresh", systemPromptMode: "replace",
      inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: false,
    });
    expect(profile.tools).toEqual([
      "read", "grep", "find", "ls",
      "codegraph_search", "codegraph_callers", "codegraph_callees", "codegraph_impact",
      "codegraph_explore", "codegraph_node", "codegraph_status", "codegraph_files",
      "lsp_diagnostics", "lsp_goto_definition", "lsp_find_references", "lsp_symbols",
    ]);
    const providers = [
      "../node_modules/@vndv/pi-codegraph/extensions/codegraph.ts",
      "../node_modules/pi-lsp-client/src/index.ts",
    ];
    expect(profile.subagentOnlyExtensions).toEqual(providers);
    for (const provider of providers)
      expect(readRepo(path.join("agents", provider)).length).toBeGreaterThan(0);
    expect(profile.skillPath).toEqual(["../skills/principles", "../skills/practical"]);
    const practical = ["architecture-design", "how", "why", "blast-radius"];
    const principles = [
      "principle-foundational-thinking", "principle-boundary-discipline",
      "principle-type-system-discipline", "principle-minimize-reader-load",
    ];
    expect(profile.skills).toEqual([...practical, ...principles]);
    for (const [directory, names] of [["practical", practical], ["principles", principles]] as const)
      for (const name of names) {
        const source = readRepo(`skills/${directory}/${name}/SKILL.md`);
        expect(parseFrontmatter(source).frontmatter.name).toBe(name);
      }
    expect(body).toContain("The task defines your responsibility");
    expect(body).toContain("The workflow owns dispatch");
    expect(body).toContain("Do not impose a merge verdict");
    expect(readRepo("skills/architecture/SKILL.md")).toContain("`pitako.architect`");
  });

  test("always-on profile note stays small and does not embed third-party bodies", () => {
    const note = profileNote("coding");
    expect(note.startsWith("Pitako profile: coding.")).toBe(true);
    expect(note).toContain("Load a specialized skill only when it applies.");
    expect(note).toContain("Research or design does not authorize implementation.");
    // Include authority/provenance and shared TODO policy, not workflow bodies.
    expect(note.length).toBeLessThan(3200);
    for (const marker of THIRD_PARTY_ALWAYS_ON_MARKERS) {
      expect(note).not.toContain(marker);
    }
    expect(note).not.toContain("The ladder");
    expect(note).not.toContain("wenyan");
    expect(note).not.toContain("Encode the real domain in a data structure");
  });

  test("ships advisory Reviewer resources without changing managed review", () => {
    const manifest = JSON.parse(readRepo("package.json"));
    expect(manifest.pi.skills).toContain("./skills/review");
    expect(manifest.pi.skills).toContain("./node_modules/@dietrichgebert/ponytail/skills/ponytail-review");
    for (const name of ["review", "ponytail-review"])
      expect(DEFAULT_SKILL_NAMES as readonly string[]).toContain(name);
    const { frontmatter: profile, body } = parseFrontmatter(readRepo("agents/reviewer.md"));
    const architect = parseFrontmatter(readRepo("agents/architect.md")).frontmatter;
    expect(`${profile.package}.${profile.name}`).toBe("pitako.reviewer");
    expect(profile).toMatchObject({
      acceptanceRole: "read-only", defaultContext: "fresh", systemPromptMode: "replace",
      inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: false,
      skills: ["verify-behavior"],
    });
    expect(profile.model).toBeUndefined();
    if (!Array.isArray(architect.tools) || !Array.isArray(architect.subagentOnlyExtensions) ||
      !Array.isArray(profile.subagentOnlyExtensions) ||
      !Array.isArray(profile.skillPath)) throw new Error("Expected profile resource lists");
    expect(profile.tools).toEqual([...architect.tools.slice(0, 4), "watchdog_diff", ...architect.tools.slice(4)]);
    expect(profile.subagentOnlyExtensions).toEqual(architect.subagentOnlyExtensions);
    for (const provider of profile.subagentOnlyExtensions)
      expect(readRepo(path.join("agents", provider)).length).toBeGreaterThan(0);
    for (const directory of profile.skillPath)
      expect(statSync(path.join(packageRoot(), "agents", directory)).isDirectory()).toBe(true);
    expect(profile.skillPath).toContain("../node_modules/@dietrichgebert/ponytail/skills/ponytail-review");
    expect(parseFrontmatter(readRepo("node_modules/@dietrichgebert/ponytail/skills/ponytail-review/SKILL.md"))
      .frontmatter.name).toBe("ponytail-review");
    const skill = readRepo("skills/review/SKILL.md");
    expect(parseFrontmatter(skill).frontmatter.name).toBe("review");
    expect(skill).toContain("does not replace required");
    expect(skill).toContain("managed `review_start`");
    expect(skill).toContain("pitako.reviewer");
    expect(skill).toContain("No extra rounds");
    expect(body).toContain("pi-subagents `agents/reviewer.md`");
    expect(body).toContain("Do not claim to have reviewed unavailable bytes");
    expect(readRepo("skills/pitako-coding/SKILL.md")).toContain("`review`");
    expect(readRepo("README.md")).toContain("/skill:review <target and requirements>");
  });

  test("ordinary delegation ships directly while managed routes remain explicit", () => {
    const manifest = JSON.parse(readRepo("package.json"));
    const stack = JSON.parse(readRepo("config/stack.json"));
    expect(manifest.dependencies["pi-subagents"]).toBe("0.81.0");
    expect(manifest.bundledDependencies).toContain("pi-subagents");
    const piPackages = new Set([...Object.keys(manifest.devDependencies), ...Object.keys(manifest.peerDependencies)]);
    for (const name of piPackages) {
      if (!name.startsWith("@earendil-works/")) continue;
      expect(manifest.devDependencies[name]).toBe("1.4.0");
      expect(manifest.peerDependencies[name]).toBe(">=1.4.0");
    }
    expect(manifest.pi.extensions.filter((entry: string) => entry.includes("pi-subagents")))
      .toEqual(["./node_modules/pi-subagents/bundle/index.js"]);
    expect(stack.required.find((entry: { id: string }) => entry.id === "pi-subagents"))
      .toEqual({ id: "pi-subagents", spec: "pi-subagents@0.81.0", entry: "node_modules/pi-subagents/bundle/index.js",
        tools: ["subagent", "subagents_enable", "bg_wait", "subagent_supervisor", "contact_supervisor"] });
    for (const resources of [manifest.pi.skills, manifest.pi.prompts])
      expect(resources.some((entry: string) => entry.includes("pi-subagents"))).toBe(false);
    for (const text of [profileNote("coding"), profileNote("analysis"), readRepo("roles/coordinator.md"), readRepo("skills/pitako-coding/SKILL.md")]) {
      for (const boundary of ["pi-subagents", "subagent", "subagents_enable", "$plan", "$execute", "/task", "Head", "Architect/Reviewer", "ModelPolicy", "T3 agent bridge"])
        expect(text).toContain(boundary);
    }
  });

  test("review documentation ships through existing package resources", () => {
    const manifest = JSON.parse(readRepo("package.json"));
    for (const resource of ["extensions", "skills", "docs"]) expect(manifest.files).toContain(resource);
    expect(manifest.pi.extensions.filter((entry: string) => entry === "./extensions/agent/index.ts")).toHaveLength(1);
    expect(manifest.pi.extensions.some((entry: string) => entry.includes("/review/"))).toBe(false);
    const documentation = readRepo("docs/review.md");
    const examples = [...documentation.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!));
    expect(examples).toHaveLength(2);
    expect(examples[0]).toMatchObject({ object: { kind: "plan", planId: "storage-design" }, plan: "storage-design", unit: "reviewer-critique" });
    expect(examples[1].object).toEqual(examples[0].object);
    for (const key of ["plan", "unit", "boardTopicId"]) expect(examples[1][key]).toBeUndefined();
    expect(readRepo("README.md")).toContain("[Reviewer tables](docs/review.md)");
    expect(readRepo("docs/architecture.md")).toContain("[Reviewer tables](review.md)");
  });

  test("startup completion sources and guidance ship through existing package resources", () => {
    const manifest = JSON.parse(readRepo("package.json"));
    for (const resource of ["config", "extensions", "docs"]) expect(manifest.files).toContain(resource);
    for (const resource of ["config/completion-examples.toml", "extensions/roles/config-completion.ts",
      "extensions/roles/complete.ts", "docs/configuration.md"]) expect(readRepo(resource).length).toBeGreaterThan(0);
    expect(readRepo("README.md")).toContain("[Startup configuration completion](docs/configuration.md)");
    expect(readRepo("docs/review.md")).toContain("[Startup configuration completion](configuration.md)");
    expect(readRepo("docs/architecture.md")).toContain("[Startup configuration completion](configuration.md)");
  });

  test("pitako-coding routes without duplicating specialized bodies", () => {
    const router = readRepo("skills/pitako-coding/SKILL.md");
    expect(router).toContain("This skill is the router.");
    expect(router).toContain("`ponytail`");
    expect(router).toContain("`how`");
    expect(router).toContain("`blast-radius`");
    expect(router).toContain("`verify-behavior`");
    expect(router).toContain("`/skill:gates` only");
    expect(router).toContain("app-driving verification skill and feature map");
    expect(router).toContain("does not invoke `gates` maintenance");
    expect(router).not.toContain("ACTIVE EVERY RESPONSE");
    expect(router).not.toContain("Respond terse like smart caveman");
    expect(router).not.toContain("subagent_type");
  });

  test("specialized skills keep single-agent and contextual contracts", () => {
    const architect = readRepo("skills/practical/architecture-design/SKILL.md");
    expect(parseFrontmatter(architect).frontmatter.name).toBe("architecture-design");
    expect(DEFAULT_SKILL_NAMES as readonly string[]).toContain("architecture-design");
    expect(DEFAULT_SKILL_NAMES as readonly string[]).not.toContain("architect");
    expect(() => readRepo("skills/practical/architect/SKILL.md")).toThrow();
    expect(architect).toContain("Do not run arena");
    expect(architect).toContain("does not authorize implementation");
    expect(architect).toContain("Routine edits do not need this skill");

    const how = readRepo("skills/practical/how/SKILL.md");
    expect(how).toContain("codegraph_explore");
    expect(how).toContain("Do not spawn subagents");

    const blast = readRepo("skills/practical/blast-radius/SKILL.md");
    expect(blast).toContain("codegraph_impact");
    expect(blast).toContain("Do not run an arena");
    expect(blast).toContain("bounded static reachability argument supports that static claim");
    expect(blast).toContain("Compatible prior execution supports what it actually observed");
    expect(blast).toContain("Neither static reachability nor prior execution proves unobserved dynamic behavior");
    expect(blast).toContain("new execution for a concrete dynamic uncertainty or required gate");
    expect(blast).not.toContain("Any safety fact that does not reach step 4 is unproven");

    const rootCause = readRepo("skills/principles/principle-fix-root-causes/SKILL.md");
    expect(rootCause).toContain("do not fix symptoms");

    const caveman = readRepo("skills/caveman/SKILL.md");
    expect(caveman).toContain("Use **lite** unless the user asks");
    expect(caveman).not.toContain("Must always apply.");
  });

  test("loaded shared evidence policy preserves assignment and required boundaries", async () => {
    const verify = readRepo("skills/practical/verify-behavior/SKILL.md");
    for (const contract of [
      "scripts/verification-recipe-v1.js",
      "binding.executionRoot",
      "evidenceFile(planId, uniqueRelative, binding.executionRoot)",
      "advertised installed `SKILL.md` path",
      "principal coordinator owns the final complete invocation directly",
      "never delegate it to an AgentInstance or Team",
      "Projects without the asset retain ordinary discovery",
      "Inspect the artifact, not a prior worker's summary",
      "A handoff, role change, or no-op cleanup does not itself invalidate evidence",
      "Missing, conflicting, incomplete, or invalidated evidence requires the appropriate check",
      "assigned authority and any required structured responses, receipts, affected-checks phases",
      "current phase and binding evidence",
      "isolation, ownership, disposal, coordinator acceptance, completion checks, or final independent review",
      "Completing an assigned observation or consultation is not acceptance",
      "Continue useful authorized diagnosis",
    ]) expect(verify).toContain(contract);
  });

  test("loaded workflows and evidence guidance distinguish background dependencies, input, and optional advice", async () => {
    const skillText = (name: string) => readRepo(name === "verify-behavior"
      ? "skills/practical/verify-behavior/SKILL.md" : `skills/${name}/SKILL.md`);
    const execute = skillText("execute");
    expect(execute).not.toContain("There is no steer into a running worker");
    for (const workflow of [skillText("plan"), execute]) {
      for (const contract of [
        "use only `architecture_start` and `review_start`",
        "required start is unavailable", "blocked",
        "No individual, synchronous or inline fallback and no waived review",
        "original WorkBrief", "foreground-only", 'intent: "query"', 'intent: "steer"',
        "historyId", "sessionId", "never interrupts a running command",
        "queued", "handled", "rejected", "unconfirmed",
        "Neither `queued` nor `handled` proves correction or replaces a new consultation",
      ]) expect(workflow).toContain(contract);
      expect(workflow).toMatch(/reobserve after native replacement/i);
    }
    for (const contract of [
      "Keep at most one Developer role active, without exception",
      "not a live controllable target",
      "does not establish physical closure, release an incompatible effect reservation, accept a result",
      "waive independent final review", "change ModelPolicy",
    ]) expect(execute).toContain(contract);
    const verify = skillText("verify-behavior");
    for (const contract of [
      "for the entire source (no offset/limit)", "require `version === 1`", "proposal you had before advice",
      "Keep the original probabilities", "separate invocations", "recordDecision", "recordObservation",
      "staged decision is not dispatch", "exact retained advice ID", "Retain older IDs",
      "never block ordinary action, gates, or review", 'source: "coordinator"',
      "Worker retention does not own or delete coordinator bytes", "record no sample or unavailable advice",
    ]) expect(verify).toContain(contract);
  });

  test("/pitako status lists the catalog without loading the Ponytail extension", async () => {
    const notifications: string[] = [];
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<unknown>>();
    const pi = {
      registerFlag() {},
      registerTool() {},
      getFlag() {
        return undefined;
      },
      on() {},
      registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<unknown> }) {
        commands.set(name, spec.handler);
      },
      getActiveTools() {
        return ["read", "bash", "edit", "write"];
      },
      getAllTools() {
        return ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name }));
      },
      setActiveTools() {},
      getSessionName() {
        return undefined;
      },
      setSessionName() {},
    };
    pitako(pi as unknown as ExtensionAPI);
    const handler = commands.get("pitako");
    if (!handler) throw new Error("/pitako was not registered");
    await handler("", {
      hasUI: true,
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        setStatus() {},
      },
    });
    expect(notifications.join("\n")).toContain("Default skills");
    expect(notifications.join("\n")).toContain("ponytail");
    expect(notifications.join("\n")).toContain("poteto-mode");
    expect(skillStatusLines().some((line) => line.includes("typescript-best-practices"))).toBe(true);
  });
});
