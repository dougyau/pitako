import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pitako from "../extensions/index.ts";
import {
  isPitakoPlaceholder,
  planHeading,
  planInvocation,
  sessionDisplayName,
  sessionNameAction,
  workflowDisplayName,
} from "../extensions/session-name.ts";

describe("session name handlers", () => {
  test("syncs first user line and preserves explicit names", async () => {
    for (const scenario of [
      { current: "pitako:coding", entries: [{ type: "message", message: { role: "user", content: "Fix session titles" } }], expected: "Fix session titles", set: ["Fix session titles"] },
      { current: "auth-refactor", entries: [], expected: "auth-refactor", set: [] },
      { current: undefined, entries: [], expected: undefined, set: [] },
      { current: "pitako:analysis", entries: [], expected: undefined, set: [""] },
    ]) {
      const harness = createHandlerHarness(scenario.current, scenario.entries);
      const start = harness.events.get("session_start");
      if (!start) throw new Error("session_start was not registered");
      await start({}, harness.context);
      expect(harness.setNames).toEqual(scenario.set);
      expect(harness.statuses.find(([key]) => key === "pitako")?.[1]).toBe(scenario.expected);
    }
  });

  test("uses plan heading for pending execute and falls back when missing", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pitako-session-name-"));
    try {
      mkdirSync(path.join(cwd, ".pitako", "plans"), { recursive: true });
      writeFileSync(path.join(cwd, ".pitako", "plans", "topic-naming.md"), "---\nid: topic-naming\nrevision: 3\nstatus: frozen\n---\n\n# Session display name\n");
      const harness = createHandlerHarness(undefined, [], cwd);
      const before = harness.events.get("before_agent_start");
      if (!before) throw new Error("before_agent_start was not registered");
      await before({ prompt: "$execute topic-naming" }, harness.context);
      expect(harness.setNames).toEqual(["execute: Session display name"]);
      expect(harness.statuses.at(-1)?.[1]).toBe("execute: Session display name");

      const missing = createHandlerHarness(undefined, [], cwd);
      await missing.events.get("before_agent_start")?.({ prompt: "$execute missing-plan" }, missing.context);
      expect(missing.setNames).toEqual(["$execute missing-plan"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("new pending invocation takes precedence over older stored user text", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pitako-session-name-"));
    try {
      mkdirSync(path.join(cwd, ".pitako", "plans"), { recursive: true });
      writeFileSync(path.join(cwd, ".pitako", "plans", "topic-naming.md"), "---\nid: topic-naming\nrevision: 3\nstatus: frozen\n---\n\n# Session display name\n");
      const entries = [{ type: "message", message: { role: "user", content: "Old task" } }];
      const harness = createHandlerHarness("Old task", entries, cwd);
      await harness.events.get("before_agent_start")?.({ prompt: "$execute topic-naming" }, harness.context);
      expect(harness.setNames).toEqual(["execute: Session display name"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("ordinary pending prompt does not rescan older stored invocation", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pitako-session-name-"));
    try {
      mkdirSync(path.join(cwd, ".pitako", "plans"), { recursive: true });
      writeFileSync(path.join(cwd, ".pitako", "plans", "topic-naming.md"), "---\nid: topic-naming\nrevision: 3\nstatus: frozen\n---\n\n# Session display name\n");
      const entries = [{ type: "message", message: { role: "user", content: "$execute topic-naming" } }];
      const harness = createHandlerHarness("execute: Existing title", entries, cwd);
      await harness.events.get("before_agent_start")?.({ prompt: "Ordinary follow-up" }, harness.context);
      expect(harness.setNames).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("session start uses latest user invocation and workflow title", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pitako-session-name-"));
    try {
      mkdirSync(path.join(cwd, ".pitako", "plans"), { recursive: true });
      writeFileSync(path.join(cwd, ".pitako", "plans", "topic-naming.md"), "---\nid: topic-naming\nrevision: 3\nstatus: frozen\n---\n\n# Session display name\n");
      const entries = [
        { type: "message", message: { role: "user", content: "Initial work" } },
        { type: "message", message: { role: "assistant", content: "ignore" } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "$plan topic-naming" }] } },
      ];
      const harness = createHandlerHarness("pitako:coding", entries, cwd);
      await harness.events.get("session_start")?.({}, harness.context);
      expect(harness.setNames).toEqual(["plan: Session display name"]);
      expect(harness.statuses.find(([key]) => key === "pitako")?.[1]).toBe("plan: Session display name");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("successful exact plan write upgrades owned name only", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pitako-session-name-"));
    try {
      mkdirSync(path.join(cwd, ".pitako", "plans"), { recursive: true });
      const file = path.join(cwd, ".pitako", "plans", "topic-naming.md");
      writeFileSync(file, "---\nid: topic-naming\nrevision: 3\nstatus: frozen\n---\n\n# Session display name\n");
      const link = path.join(cwd, "repo-link");
      symlinkSync(cwd, link);
      const linkedHarness = createHandlerHarness("$plan topic-naming", [{ type: "message", message: { role: "user", content: "$plan topic-naming" } }], link);
      await linkedHarness.events.get("tool_result")?.({ toolName: "write", input: { path: path.join(link, ".pitako", "plans", "topic-naming.md") }, isError: false }, linkedHarness.context);
      expect(linkedHarness.setNames).toEqual(["plan: Session display name"]);
      for (const [current, result, expected] of [
        ["$plan topic-naming", { toolName: "write", input: { path: file }, isError: false }, ["plan: Session display name"]],
        ["$plan topic-naming", { toolName: "edit", input: { path: file }, isError: false }, ["plan: Session display name"]],
        ["$plan topic-naming", { toolName: "edit", input: { path: file }, isError: true }, []],
        ["execute: Session display name", { toolName: "write", input: { path: file }, isError: false }, []],
        ["auth-refactor", { toolName: "write", input: { path: file }, isError: false }, []],
        ["$plan topic-naming", { toolName: "write", input: { path: path.join(cwd, "outside", "topic-naming.md") }, isError: false }, []],
      ] as const) {
        const harness = createHandlerHarness(current, [{ type: "message", message: { role: "user", content: "$plan topic-naming" } }], cwd);
        await harness.events.get("tool_result")?.(result, harness.context);
        expect(harness.setNames).toEqual([...expected]);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("ignores invalid plan files and uses id when heading is absent", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pitako-session-name-"));
    try {
      mkdirSync(path.join(cwd, ".pitako", "plans"), { recursive: true });
      writeFileSync(path.join(cwd, ".pitako", "plans", "invalid-plan.md"), "not a plan");
      writeFileSync(path.join(cwd, ".pitako", "plans", "no-heading.md"), "---\nid: no-heading\nrevision: 1\nstatus: frozen\n---\n");
      const invalid = createHandlerHarness(undefined, [], cwd);
      await invalid.events.get("before_agent_start")?.({ prompt: "$plan invalid-plan" }, invalid.context);
      expect(invalid.setNames).toEqual(["$plan invalid-plan"]);
      const noHeading = createHandlerHarness(undefined, [], cwd);
      await noHeading.events.get("before_agent_start")?.({ prompt: "$plan no-heading" }, noHeading.context);
      expect(noHeading.setNames).toEqual(["plan: no-heading"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("uses pending prompt and does not rename on profile switch", async () => {
    const harness = createHandlerHarness(undefined, []);
    const before = harness.events.get("before_agent_start");
    if (!before) throw new Error("before_agent_start was not registered");
    await before({ prompt: "Fix session titles\nMore detail" }, harness.context);
    expect(harness.setNames).toEqual(["Fix session titles"]);
    expect(harness.statuses.at(-1)?.[1]).toBe("Fix session titles");

    const profile = harness.commands.get("pitako");
    if (!profile) throw new Error("/pitako was not registered");
    await profile("profile analysis", harness.context);
    expect(harness.setNames).toEqual(["Fix session titles"]);
    expect(harness.statuses.at(-1)?.[1]).toBe("Fix session titles");
  });
});

function createHandlerHarness(current: string | undefined, entries: unknown[], cwd = process.cwd()) {
  let name = current;
  const events = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const setNames: string[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const context = {
    hasUI: true,
    cwd,
    sessionManager: { getSessionId: () => "test-session", getEntries: () => entries },
    ui: { notify() {}, setStatus(key: string, value?: string) { statuses.push([key, value]); } },
  };
  const api = {
    registerFlag() {}, registerTool() {}, getFlag() { return undefined; },
    on(name: string, handler: (event: any, ctx: any) => Promise<unknown>) { events.set(name, handler); },
    registerCommand(name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, definition.handler); },
    getActiveTools() { return []; }, getAllTools() { return []; }, setActiveTools() {},
    getSessionName() { return name; }, setSessionName(value: string) { setNames.push(value); name = value || undefined; },
  };
  pitako(api as unknown as ExtensionAPI);
  return { events, commands, context, setNames, statuses };
}

describe("session display names", () => {
  test("uses first non-empty line, collapses whitespace, and caps at 60 characters", () => {
    expect(sessionDisplayName("$plan topic-naming\n\nEstoy notando")).toBe("$plan topic-naming");
    expect(sessionDisplayName(`${"x".repeat(59)}yz`)).toBe(`${"x".repeat(59)}y`);
    expect(sessionDisplayName("  Fix   session titles  ")).toBe("Fix session titles");
  });

  test("rejects only the two placeholders and worker notices", () => {
    expect(isPitakoPlaceholder("pitako:coding")).toBe(true);
    expect(isPitakoPlaceholder("pitako:analysis")).toBe(true);
    for (const text of ["pitako:coding", "pitako:analysis", "  \n ", "Pitako worker developer-ab12cd completed"]) {
      expect(sessionDisplayName(text)).toBeUndefined();
    }
    expect(sessionDisplayName("pitako:review")).toBe("pitako:review");
    expect(isPitakoPlaceholder(undefined)).toBe(false);
  });

  test("parses first valid-shape plan invocation only", () => {
    expect(planInvocation("$execute topic-naming")).toEqual({ activity: "execute", id: "topic-naming" });
    expect(planInvocation("do $plan topic-naming now")).toEqual({ activity: "plan", id: "topic-naming" });
    for (const text of ["$plan", "$plan ../escape", "$plan Foo", "$planner topic-naming", "ordinary text"]) {
      expect(planInvocation(text)).toBeUndefined();
    }
    expect(planInvocation(undefined)).toBeUndefined();
  });

  test("reads first H1 after frontmatter", () => {
    expect(planHeading("---\nid: topic\n---\n\n# Session display name\n\n## T1")).toBe("Session display name");
    expect(planHeading("---\nid: topic\n---\n\n## No H1")).toBeUndefined();
  });

  test("formats workflow name without moving its prefix", () => {
    expect(workflowDisplayName("execute", "Session display name")).toBe("execute: Session display name");
    expect(workflowDisplayName("plan", "x".repeat(70))).toBe(`plan: ${"x".repeat(54)}`);
  });
});

describe("session name decisions", () => {
  test("preserves unowned names", () => {
    expect(sessionNameAction({ current: "auth-refactor", workflow: { activity: "plan", title: "Session display name" } })).toEqual({});
  });

  test("replaces placeholders using existing text or clears empty placeholder", () => {
    expect(sessionNameAction({ current: "pitako:coding", existingUserText: "Fix session titles" })).toEqual({ set: "Fix session titles" });
    expect(sessionNameAction({ current: "pitako:coding" })).toEqual({ set: "" });
  });

  test("uses pending prompt, with workflow title taking precedence", () => {
    expect(sessionNameAction({ current: "", pendingPrompt: "$plan topic-naming" })).toEqual({ set: "$plan topic-naming" });
    expect(sessionNameAction({
      current: "",
      pendingPrompt: "$execute topic-naming",
      workflow: { activity: "execute", title: "Session display name" },
    })).toEqual({ set: "execute: Session display name" });
  });

  test("renames owned first-line title to workflow and avoids redundant writes", () => {
    expect(sessionNameAction({
      current: "$plan topic-naming",
      existingUserText: "$plan topic-naming",
      workflow: { activity: "plan", title: "Session display name" },
    })).toEqual({ set: "plan: Session display name" });
    expect(sessionNameAction({ current: "execute: Session display name", workflow: { activity: "execute", title: "Session display name" } })).toEqual({});
    expect(sessionNameAction({ current: "execute: Session display name", workflow: { activity: "plan", title: "Later", fromPlanWrite: true } })).toEqual({});
  });
});
