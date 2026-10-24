import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pitako from "../extensions/index.ts";
import { isPitakoPlaceholder, sessionDisplayName, sessionNameAction } from "../extensions/session-name.ts";

function harness(current: string | undefined, entries: unknown[] = []) {
  let name = current;
  const events = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const setNames: string[] = [];
  const statuses: Array<string | undefined> = [];
  const context = {
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "test-session", getEntries: () => entries },
    ui: { notify() {}, setStatus(_key: string, value?: string) { statuses.push(value); } },
  };
  pitako({
    registerFlag() {}, getFlag() { return "coding"; },
    on(event: string, handler: (event: any, ctx: any) => unknown) { events.set(event, handler); },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command.handler);
    },
    getActiveTools() { return []; }, getAllTools() { return []; }, setActiveTools() {},
    getSessionName() { return name; },
    setSessionName(value: string) { setNames.push(value); name = value || undefined; },
  } as unknown as ExtensionAPI);
  return {
    setNames, statuses,
    emit(event: string, value: unknown = {}) { return events.get(event)?.(value, context); },
    profile(value: string) { return commands.get("pitako")?.(`profile ${value}`, context); },
  };
}

describe("session name handlers", () => {
  test("uses first saved user text, including text blocks, and preserves custom names", async () => {
    for (const content of ["  Repair   titles\nDetails", [{ type: "text", text: "  Repair   titles\nDetails" }]]) {
      const entries = [{ type: "message", message: { role: "user", content } }];
      const host = harness("pitako:coding", entries);
      try {
        await host.emit("session_start");
        expect(host.setNames).toEqual(["Repair titles"]);
        expect(host.statuses.at(-1)).toBe("Repair titles");
      } finally { await host.emit("session_shutdown"); }
    }
    const custom = harness("Manual title");
    try {
      await custom.emit("session_start");
      await custom.emit("before_agent_start", { messageType: "user", prompt: "New title", systemPrompt: "" });
      expect(custom.setNames).toEqual([]);
    } finally { await custom.emit("session_shutdown"); }
  });

  test("names from pending human input but not a worker wake; profile changes do not rename", async () => {
    const host = harness(undefined);
    try {
      await host.emit("session_start");
      const result = await host.emit("before_agent_start", {
        messageType: "custom", message: { customType: "subagent-notify", content: "Worker result" },
        systemPrompt: "Base instructions",
      }) as { systemPrompt: string };
      expect(host.setNames).toEqual([]);
      expect(result.systemPrompt).toContain("Base instructions");
      expect(result.systemPrompt).toContain("Pitako profile: coding.");
      await host.emit("before_agent_start", { messageType: "user", prompt: "Fix titles\nDetails", systemPrompt: "" });
      expect(host.setNames).toEqual(["Fix titles"]);
      await host.profile("analysis");
      expect(host.setNames).toEqual(["Fix titles"]);
    } finally { await host.emit("session_shutdown"); }
  });

  test("treats deferred workflow syntax as plain text without inspecting old plans", async () => {
    const host = harness(undefined);
    try {
      await host.emit("before_agent_start", { messageType: "user", prompt: "$execute old-plan", systemPrompt: "" });
      expect(host.setNames).toEqual(["$execute old-plan"]);
    } finally { await host.emit("session_shutdown"); }
  });
});

describe("session display names", () => {
  test("normalizes the first nonempty line and caps its length", () => {
    expect(sessionDisplayName("\n  Fix   session titles  \nDetails")).toBe("Fix session titles");
    expect(sessionDisplayName("x".repeat(61))).toBe("x".repeat(60));
    expect(sessionDisplayName("$plan topic\nDetails")).toBe("$plan topic");
  });

  test("rejects empty names and the two profile placeholders", () => {
    for (const text of [undefined, "", " \n ", "pitako:coding", "pitako:analysis"])
      expect(sessionDisplayName(text)).toBeUndefined();
    expect(isPitakoPlaceholder("pitako:coding")).toBe(true);
    expect(isPitakoPlaceholder("pitako:analysis")).toBe(true);
    expect(isPitakoPlaceholder("pitako:review")).toBe(false);
    expect(sessionDisplayName("pitako:review")).toBe("pitako:review");
  });

  test("preserves custom names, clears empty placeholders and prefers saved user input", () => {
    expect(sessionNameAction({ current: "Manual", pendingPrompt: "New task" })).toEqual({});
    expect(sessionNameAction({ current: "pitako:coding" })).toEqual({ set: "" });
    expect(sessionNameAction({ current: undefined })).toEqual({});
    expect(sessionNameAction({ current: "pitako:analysis", existingUserText: "Saved task", pendingPrompt: "New task" }))
      .toEqual({ set: "Saved task" });
    expect(sessionNameAction({ current: undefined, pendingPrompt: "New task" })).toEqual({ set: "New task" });
  });
});
