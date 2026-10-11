import { stubExternalFactories } from "./fixtures/offline.ts";
stubExternalFactories();
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import codegraphRaw from "../extensions/code-intelligence/codegraph-raw.ts";
import { CODE_INTELLIGENCE_TOOL_NAMES } from "../extensions/code-intelligence/metrics.ts";
import { toolsForProfile } from "../extensions/profile.ts";

function readRepo(relative: string): string {
  return readFileSync(path.join(packageRoot(), relative), "utf8");
}

describe("engineering-layer composition", () => {
  test("declares curated resources without executing external extensions", () => {
    const manifest = JSON.parse(readRepo("package.json")).pi;
    expect(readRepo("skills/pre-pr/SKILL.md")).toContain("Prepare the current worktree");
    expect(manifest.extensions[0]).toBe("./extensions/index.ts");
    for (const entry of ["./extensions/board/index.ts", "./extensions/agent/index.ts",
      "./extensions/code-intelligence/codegraph-raw.ts", "./node_modules/pi-lsp-client/src/index.ts",
      "./node_modules/@juicesharp/rpiv-todo/index.ts"]) expect(manifest.extensions).toContain(entry);
    expect(manifest.extensions.some((entry: string) => entry.includes("ponytail"))).toBe(false);
    const skills = manifest.skills.filter((entry: string) => !entry.includes("node_modules"));
    expect(skills).toEqual(expect.arrayContaining(["./skills/pitako-coding", "./skills/practical", "./skills/principles"]));
    for (const name of ["pitako-coding", "ponytail", "caveman", "verify-behavior"]) expect(DEFAULT_SKILL_NAMES as readonly string[]).toContain(name);
    for (const name of [...EXCLUDED_SKILL_NAMES, ...OPTIONAL_LANGUAGE_SKILLS]) expect(DEFAULT_SKILL_NAMES as readonly string[]).not.toContain(name);
    const active = toolsForProfile({ available: [...CODE_INTELLIGENCE_TOOL_NAMES, "read", "grep", "bash", "edit", "write"], profile: "coding" });
    expect(active).toEqual(expect.arrayContaining([...CODE_INTELLIGENCE_TOOL_NAMES, "read", "grep", "bash", "edit", "write"]));
  });

  test("CodeGraph facade keeps raw tools but skips only its conflicting prompt hook", () => {
    const hooks: string[] = [];
    const tools: string[] = [];
    codegraphRaw({
      on(event: string) { hooks.push(event); return () => {}; },
      registerTool(tool: { name: string }) { tools.push(tool.name); },
    } as never);
    expect(hooks).not.toContain("before_agent_start");
    expect(tools).toContain("codegraph_search");
    expect(tools).toContain("codegraph_impact");
  });

  test("always-on profile note stays small and does not embed third-party bodies", () => {
    const note = profileNote("coding");
    expect(note.startsWith("Pitako profile: coding.")).toBe(true);
    expect(note).toContain("Load a specialized skill only when it applies.");
    expect(note).toContain("Research or design does not authorize implementation.");
    expect(note.length).toBeLessThan(800);
    for (const marker of THIRD_PARTY_ALWAYS_ON_MARKERS) {
      expect(note).not.toContain(marker);
    }
    expect(note).not.toContain("The ladder");
    expect(note).not.toContain("wenyan");
    expect(note).not.toContain("Encode the real domain in a data structure");
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

  test("loaded execute and evidence guidance distinguish observation, input, and optional advice", async () => {
    const skillText = (name: string) => readRepo(name === "verify-behavior"
      ? "skills/practical/verify-behavior/SKILL.md" : `skills/${name}/SKILL.md`);
    const execute = skillText("execute");
    expect(execute).not.toContain("There is no steer into a running worker");
    for (const contract of [
      "Keep at most one Developer role active, without exception",
      "original WorkBrief", "foreground-only", 'intent: "query"', 'intent: "steer"',
      "historyId", "sessionId", "never interrupts a running command",
      "queued", "handled", "rejected", "unconfirmed", "not a live controllable target",
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
