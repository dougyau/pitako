import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import * as acp from "billion-context-pi";
import * as rpivTodo from "@juicesharp/rpiv-todo";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
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

function readRepo(relative: string): string {
  return readFileSync(path.join(packageRoot(), relative), "utf8");
}

describe("engineering-layer composition", () => {
  test("TODO composition preserves upstream registration except for model-only exposure", async () => {
    const todo: ToolDefinition = {
      name: "todo", label: "TODO", description: "controlled upstream tool",
      parameters: Type.Object({}), execute: async () => ({ content: [], details: { tasks: [] } }),
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
      expect(tools).toEqual([{ ...todo, exposure: "model-only" }, other]);
      expect(tools[0]?.execute).toBe(todo.execute);
      expect(tools[1]).toBe(other);
      expect(todo.exposure).toBeUndefined();
    } finally {
      registration.mockRestore();
    }
  });

  test("ACP defaults disable implicit bash deadlines without starting the external runtime", async () => {
    const factory = () => {};
    const registration = spyOn(acp, "createAcpExtension").mockReturnValue(factory);
    try {
      const extension = await import("../extensions/acp.ts");
      expect(registration).toHaveBeenCalledTimes(1);
      expect(registration).toHaveBeenCalledWith({
        delegate: false, autoUpdate: false, toolBashDefaultTimeout: 0,
      });
      expect(extension.default).toBe(factory);
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

  test("always-on profile note stays small and does not embed third-party bodies", () => {
    const note = profileNote("coding");
    expect(note.startsWith("Pitako profile: coding.")).toBe(true);
    expect(note).toContain("Load a specialized skill only when it applies.");
    expect(note).toContain("Research or design does not authorize implementation.");
    // Include the shared TODO policy without embedding the workflow skills.
    expect(note.length).toBeLessThan(1200);
    for (const marker of THIRD_PARTY_ALWAYS_ON_MARKERS) {
      expect(note).not.toContain(marker);
    }
    expect(note).not.toContain("The ladder");
    expect(note).not.toContain("wenyan");
    expect(note).not.toContain("Encode the real domain in a data structure");
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
    const architect = readRepo("skills/practical/architect/SKILL.md");
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
      "does not settle a Team hold", "waive independent final review", "change ModelPolicy",
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
