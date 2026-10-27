import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, mock, spyOn, test } from "bun:test";
import * as acp from "billion-context-pi";
import * as rpivTodo from "@juicesharp/rpiv-todo";
import { parseFrontmatter, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  DEFAULT_SKILL_NAMES,
  EXCLUDED_SKILL_NAMES,
  OPTIONAL_LANGUAGE_SKILLS,
  THIRD_PARTY_ALWAYS_ON_MARKERS,
  skillStatusLines,
} from "../extensions/catalog.ts";
import pitako from "../extensions/index.ts";
import { profileNote } from "../extensions/profile.ts";
import { packageRoot, readStack } from "../extensions/stack.ts";
import { toolsForProfile } from "../extensions/profile.ts";

function readRepo(relative: string): string {
  return readFileSync(path.join(packageRoot(), relative), "utf8");
}

describe("engineering-layer composition", () => {
  test.each(["coding", "analysis"] as const)("Pi-only %s startup delivers profile guidance without host prerequisites", profile => {
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    // Actual owned registration/builder; no client metadata or model simulation.
    pitako({
      on(event: string, handler: (event: any, ctx: any) => any) { handlers.set(event, handler); },
      registerFlag() {}, registerCommand() {},
      getFlag() { return profile; },
      getAllTools() { return []; }, getActiveTools() { return []; }, setActiveTools() {},
      getSessionName() { return "Pi-only"; },
    } as unknown as ExtensionAPI);
    const ctx = {
      cwd: packageRoot(), hasUI: false,
      sessionManager: { getSessionId() { return `pi-only-${profile}`; }, getEntries() { return []; } },
    };
    handlers.get("session_start")!({}, ctx);
    try {
      const result = handlers.get("before_agent_start")!({ systemPrompt: "Pi base", messageType: "user", prompt: "Inspect sources" }, ctx);
      expect(result.systemPrompt).toBe(`Pi base\n\n${profileNote(profile)}`);
      for (const instruction of ["Pi-native tools and codemode need no T3 client",
        "Optional-host guidance applies only when present", "unknown trust is not denial",
        "Honor actual native rejections and Stop", "never invent a trust certificate",
        "billion-context-pi ACP is mandatory", "Only the execution director delegates"])
        expect(result.systemPrompt).toContain(instruction);
      expect(handlers.get("before_agent_start")!({ systemPrompt: result.systemPrompt }, ctx)).toBeUndefined();
    } finally {
      handlers.get("session_shutdown")!({}, ctx);
    }
  });

  test("selected external LSP entry preserves the declared six-tool surface and symbol scopes", async () => {
    const tools: ToolDefinition[] = [];
    const commands: string[] = [];
    const extension = await import(path.join(packageRoot(), "node_modules/pi-lsp-client/src/index.ts"));
    const { disposeDefaultLspManager } = await import(path.join(packageRoot(), "node_modules/pi-lsp-client/src/lsp/manager.ts"));
    try {
      extension.default({
        registerTool(tool: ToolDefinition) { tools.push(tool); },
        registerCommand(name: string) { commands.push(name); },
        on() {},
      } as unknown as ExtensionAPI);
      expect(tools.map(tool => tool.name)).toEqual(
        readStack(packageRoot()).required.find(({ id }) => id === "pi-lsp-client")!.tools);
      expect(commands).toEqual(["lsp"]);
      const symbols = tools.find(tool => tool.name === "lsp_symbols")!;
      for (const scope of ["document", "workspace"]) {
        const arguments_ = { filePath: "source.ts", scope, ...(scope === "workspace" ? { query: "owned" } : {}) };
        expect(validateToolArguments(symbols, {
          type: "toolCall", id: scope, name: symbols.name, arguments: arguments_,
        })).toEqual(arguments_);
      }
      expect(tools.find(tool => tool.name === "lsp_rename")!.executionMode).toBe("sequential");
      const available = tools.map(tool => tool.name);
      expect(toolsForProfile({ profile: "analysis", available })).not.toContain("lsp_rename");
      expect(toolsForProfile({ profile: "coding", available })).toContain("lsp_rename");
    } finally {
      // Registration owns the client's idle reaper even without a server request.
      await disposeDefaultLspManager();
    }
  });

  test("all nine profiles pass the native parser and required-tool plan with explicit ACP and role ceilings", async () => {
    const parser = await import("../node_modules/pi-subagents/src/agents/frontmatter.js");
    const { resolvePiLaunchToolPlan } = await import("../node_modules/pi-subagents/src/runs/shared/child-tool-plan.js");
    const acpTools = ["compress", "decompress", "search_context", "acp_status", "acp_cache"];
    const queries = ["git_worktree_list", "git_status", "git_diff", "git_log", "git_show", "resource_snapshot", "file_sha256", "codemode"];
    const provider = readStack(packageRoot()).required.find(({ id }) => id === "pitako-dev-tools")!;
    for (const role of ["architect", "reviewer", "scout", "researcher", "evidence-auditor", "execution-inspector", "worker", "execution-director", "interview-relay"]) {
      const { frontmatter, body } = parser.parseFrontmatter(readRepo(`agents/${role}.md`));
      const resolve = (raw?: string) => parser.parseFrontmatterList(raw)?.map(entry => path.resolve(packageRoot(), "agents", entry));
      const plan = resolvePiLaunchToolPlan({
        cwd: packageRoot(), agentName: `pitako.${role}`, fast: false,
        tools: parser.parseFrontmatterList(frontmatter.tools),
        extensions: resolve(frontmatter.extensions),
        subagentOnlyExtensions: resolve(frontmatter.subagentOnlyExtensions),
      });
      expect(plan.disableAmbientExtensions).toBe(true);
      expect(plan.extensionArgs).toContain(path.join(packageRoot(), "extensions/acp.ts"));
      for (const tool of acpTools) expect(plan.requiredChildTools).toContain(tool);
      expect(body).toContain("billion-context-pi");
      expect(body).toContain("unmet prerequisite");
      expect(body).toContain("native-compaction stand-down");
      expect(plan.fanoutAuthorized).toBe(role === "execution-director");
      if (role === "interview-relay") {
        expect(plan.effectiveToolAllowlist).toEqual(["contact_supervisor", ...acpTools]);
        expect(plan.configuredExtensions).toEqual([path.join(packageRoot(), "extensions/acp.ts")]);
        continue;
      }
      for (const tool of queries) expect(plan.requiredChildTools).toContain(tool);
      expect(plan.extensionArgs).toContain(path.join(packageRoot(), provider.entry));
      expect(plan.extensionArgs).toContain(path.join(packageRoot(), "extensions/file-sha256.ts"));
      if (role === "worker") {
        for (const tool of [...provider.tools, "file_sha256_save"]) expect(plan.requiredChildTools).toContain(tool);
        for (const tool of ["subagent", "bg_wait", "subagent_supervisor"]) expect(plan.requiredChildTools).not.toContain(tool);
      } else {
        for (const tool of provider.tools.filter(tool => !queries.includes(tool))) expect(plan.effectiveToolAllowlist).not.toContain(tool);
        expect(plan.requiredChildTools).not.toContain("file_sha256_save");
      }
    }
  });

  test("dev-tools public entry registers every group and hooks and runs the owned sampler", async () => {
    const manifest = JSON.parse(readRepo("package.json"));
    const provider = readStack(packageRoot()).required.find(({ id }) => id === "pitako-dev-tools")!;
    const entry = `./${provider.entry}`;
    expect(manifest.pi.extensions.filter((value: string) => value === entry)).toEqual([entry]);
    const tools: ToolDefinition[] = [];
    const handlers = new Map<string, (event: any) => any>();
    const extension = await import(path.join(packageRoot(), entry));
    extension.default({
      registerTool(tool: ToolDefinition) { tools.push(tool); },
      on(event: string, handler: (event: any) => any) { handlers.set(event, handler); },
    } as unknown as ExtensionAPI);
    expect(tools.map(tool => tool.name)).toEqual(provider.tools);
    for (const tool of tools) {
      expect(tool.outputSchema).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
    expect([...handlers.keys()]).toEqual(["tool_call", "before_agent_start"]);
    expect(handlers.get("tool_call")!({ toolName: "bash", input: { command: "git commit -n" } }))
      .toMatchObject({ block: true });
    expect(handlers.get("tool_call")!({ toolName: "bash", input: { command: "git status" } })).toBeUndefined();
    expect(handlers.get("before_agent_start")!({ systemPrompt: "base" }).systemPrompt)
      .toContain("base\n\nBefore knowingly starting a large test or compile");

    // No sampler override: exercise the owned sampler through the public provider.
    // Assert the Pitako composition contract, not host-specific availability or process inventory.
    const observer = tools.find(tool => tool.name === "resource_snapshot")!;
    const result = await observer.execute("resource", { process_limit: 1, interval_ms: 100 }, undefined, undefined,
      { cwd: packageRoot() } as ExtensionToolContext);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      platform: process.platform,
      interval: { requestedMs: 100 },
      memory: { status: "available" },
    });
    expect(result.content[0]).toMatchObject({ type: "text" });

    const cancellation = new AbortController(), reason = new Error("owned sampler cancellation");
    cancellation.abort(reason);
    // The provider awaits sampler disposal before this rejection settles.
    await expect(observer.execute("cancelled-resource", {}, cancellation.signal, undefined,
      { cwd: packageRoot() } as ExtensionToolContext)).rejects.toBe(reason);
  });

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
    try {
      const extension = await import("../extensions/todo.ts");
      extension.default(pi as unknown as ExtensionAPI);
      expect(registration).toHaveBeenCalledTimes(1);
      expect(forwarded?.on).toBe(pi.on);
      expect(forwarded?.registerCommand).toBe(pi.registerCommand);
      expect(tools[0]).toMatchObject({ name: todo.name, label: todo.label, description: todo.description, exposure: "model-only" });
      expect(tools[0]!.parameters).toEqual(todo.parameters);
      const controller = new AbortController(), update = () => {};
      const ctx = { cwd: packageRoot(), sessionManager: {} } as unknown as ExtensionToolContext, args = {};
      const result = await tools[0]!.execute("native-id", args, controller.signal, update, ctx);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith("native-id", args, controller.signal, update, ctx);
      expect(result).toBe(upstream);
      expect(tools[1]).toBe(other);
      expect(todo.exposure).toBeUndefined();
    } finally {
      registration.mockRestore();
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
      expect(tools).toEqual(definitions);
      for (const [index, tool] of tools.entries()) expect(tool).toBe(definitions[index]);
    } finally {
      registration.mockRestore();
    }
  });

  test("declares curated resources without executing external extensions", () => {
    const manifest = JSON.parse(readRepo("package.json")).pi;
    expect(readRepo("skills/pre-pr/SKILL.md")).toContain("Prepare the current worktree");
    expect(manifest.extensions[0]).toBe("./extensions/index.ts");
    for (const entry of ["./extensions/board/index.ts",
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

  test("architecture skill ships its pi-subagents workflow", () => {
    const manifest = JSON.parse(readRepo("package.json"));
    expect(manifest.files).toContain("skills");
    expect(manifest.pi.skills).toContain("./skills/architecture");
    expect(DEFAULT_SKILL_NAMES as readonly string[]).toContain("architecture");
    const skill = readRepo("skills/architecture/SKILL.md");
    expect(skill).toMatch(/^---\nname: architecture\ndescription: .+\n---/);
    for (const contract of [
      "same complete problem", "Use only `pi-subagents`",
      "Never exceed ten rounds", "Do not split the work",
      "resume: lastRunId",
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
    expect(agentParser.parseFrontmatterList(nativeProfile.extensions)).toEqual(["../extensions/acp.ts"]);
    expect(`${profile.package}.${profile.name}`).toBe("pitako.architect");
    expect(profile).toMatchObject({
      acceptanceRole: "read-only", defaultContext: "fresh", systemPromptMode: "replace",
      inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: false,
    });
    expect(profile.tools).toEqual([
      "compress", "decompress", "search_context", "acp_status", "acp_cache",
      "git_worktree_list", "git_status", "git_diff", "git_log", "git_show", "resource_snapshot", "file_sha256", "codemode",
      "read", "grep", "find", "ls",
      "codegraph_search", "codegraph_callers", "codegraph_callees", "codegraph_impact",
      "codegraph_explore", "codegraph_node", "codegraph_status", "codegraph_files",
      "lsp_diagnostics", "lsp_goto_definition", "lsp_find_references", "lsp_symbols",
    ]);
    const providers = [
      "../extensions/dev-tools/index.ts", "../extensions/file-sha256.ts",
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

  test("ships the read-only Reviewer profile and review workflow", () => {
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
    const navigationStart = architect.tools.indexOf("codegraph_search");
    expect(profile.tools).toEqual([...architect.tools.slice(0, navigationStart), "watchdog_diff", ...architect.tools.slice(navigationStart)]);
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
    expect(skill).not.toContain("review_start");
    expect(skill).toContain("pitako.reviewer");
    expect(skill).toContain("No extra rounds");
    expect(body).toContain("pi-subagents `agents/reviewer.md`");
    expect(body).toContain("Do not claim to have reviewed unavailable bytes");
    expect(readRepo("skills/pitako-coding/SKILL.md")).toContain("`review`");
    expect(readRepo("README.md")).toContain("/skill:review <target and requirements>");
  });

  test("ordinary delegation ships directly without the Pitako runtime", () => {
    const manifest = JSON.parse(readRepo("package.json"));
    const stack = JSON.parse(readRepo("config/stack.json"));
    expect(manifest.dependencies["pi-subagents"]).toBe("0.83.0");
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
      .toEqual({ id: "pi-subagents", spec: "pi-subagents@0.83.0", entry: "node_modules/pi-subagents/bundle/index.js",
        tools: ["subagent", "subagents_enable", "bg_wait", "subagent_supervisor", "contact_supervisor"] });
    for (const resources of [manifest.pi.skills, manifest.pi.prompts])
      expect(resources.some((entry: string) => entry.includes("pi-subagents"))).toBe(false);
    for (const text of [profileNote("coding"), profileNote("analysis"), readRepo("skills/pitako-coding/SKILL.md")]) {
      for (const boundary of ["pi-subagents", "oracle"])
        expect(text).toContain(boundary);
    }
    for (const name of ["agent/index.ts", "team.ts", "roles/load.ts", "workflow.ts", "workflow-engine.ts"])
      expect(existsSync(path.join(packageRoot(), "extensions", name))).toBe(false);
    for (const entry of manifest.pi.extensions) expect(existsSync(path.join(packageRoot(), entry))).toBe(true);
    for (const skill of ["plan", "execute", "grilling"]) expect(manifest.pi.skills).toContain(`./skills/${skill}`);
    expect(manifest.exports).toBeUndefined();
    expect(manifest.files).not.toContain("roles");
    expect(manifest.dependencies["smol-toml"]).toBeUndefined();
  });

  test("review documentation ships through existing package resources", () => {
    const manifest = JSON.parse(readRepo("package.json"));
    for (const resource of ["extensions", "skills", "docs"]) expect(manifest.files).toContain(resource);
    expect(manifest.pi.extensions).not.toContain("./extensions/agent/index.ts");
    expect(manifest.pi.extensions.some((entry: string) => entry.includes("/review/"))).toBe(false);
    const documentation = readRepo("docs/review.md");
    expect(documentation).toContain("/skill:review");
    expect(readRepo("README.md")).toContain("(docs/review.md)");
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

  test("shared evidence policy preserves required checks and uses ordinary escalation", () => {
    const verify = readRepo("skills/practical/verify-behavior/SKILL.md").replace(/\s+/g, " ");
    for (const contract of [
      "scripts/verification-recipe-v1.js",
      "ordinary built-in codemode", "No plan binding, managed tool, or classifier is required",
      "ordinary discovery", "A guide cannot waive a required gate",
      "Stop the", "first failed or interrupted command", "name unrun",
      "oracle", "pi-subagents",
    ]) expect(verify).toContain(contract);
    for (const contract of ["binding.executionRoot", "evidenceFile(", "AgentInstance", "ModelPolicy"])
      expect(verify).not.toContain(contract);
  });

  test("pre-pr reuses review and keeps readiness with the coordinator", () => {
    const skill = readRepo("skills/pre-pr/SKILL.md");
    for (const contract of [
      "[review skill](../review/SKILL.md)", "existing pi-subagents workflow",
      'target.kind: "diff"', "target.reference", "target.material",
      "untracked files with their", "source files stable during review",
      'status: "completed"', "Completion is not approval",
      "The Coordinator records its own readiness assessment",
      "Failed, cancelled, blocked, partial, or drifted work",
      "Never commit, push", "required review is unavailable", "READY_TO_PUSH",
      "pi-subagents worker profile", "Do not forward",
      "distinct guarantee", "Ask the user before adding a product",
      "Request a closure review", "complete correction delta",
      "Reuse only unaffected conclusions", "interactions cannot be bounded",
      "authorize an out-of-scope fix",
    ]) expect(skill).toContain(contract);
    expect(skill).not.toContain("then review the complete updated final diff. Repeat");
    for (const contract of ["review_start", "team_result", "AgentInstance"]) expect(skill).not.toContain(contract);
    for (const name of ["plan", "execute"])
      expect(readRepo(`skills/${name}/SKILL.md`)).not.toContain("disable-model-invocation: true");
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
