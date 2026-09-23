import { describe, expect, test } from "bun:test";
import {
  formatAgentsDetail,
  formatFooter,
  formatUiClock,
  projectSnapshots,
  type AgentUiSnapshot,
} from "../extensions/agent/ui.ts";

const NOW = 1_000_000;

function row(patch: Partial<AgentUiSnapshot> & Pick<AgentUiSnapshot, "id">): AgentUiSnapshot {
  return {
    roleId: "developer",
    status: "running",
    phase: "working",
    task: "Fix lifecycle",
    acceptedAt: NOW - 258_000,
    selectedModel: "cursor/composer-2.5",
    lastActivityKind: "model_stream",
    ...patch,
  };
}

describe("formatUiClock", () => {
  test("mm:ss under one hour and h:mm:ss at one hour", () => {
    expect(formatUiClock(0)).toBe("00:00");
    expect(formatUiClock(4 * 60_000 + 18_000)).toBe("04:18");
    expect(formatUiClock(3_600_000)).toBe("1:00:00");
    expect(formatUiClock(3_600_000 + 65_000)).toBe("1:01:05");
  });
});

describe("projectSnapshots / empty footer", () => {
  test("empty relevant set renders empty footer", () => {
    expect(formatFooter([], NOW, 80)).toBe("");
    expect(formatFooter([row({ id: "a", status: "completed", resultTaken: true, terminalAt: NOW - 9_000 })], NOW, 80)).toBe("");
  });

  test("consumed completed outside linger is hidden; resultTaken false stays", () => {
    const taken = row({
      id: "done",
      status: "completed",
      resultTaken: true,
      terminalAt: NOW - 9_000,
      appliedReasoning: "medium",
    });
    const ready = row({
      id: "ready",
      status: "completed",
      resultTaken: false,
      terminalAt: NOW - 60_000,
      appliedReasoning: "medium",
    });
    expect(projectSnapshots([taken], NOW)).toEqual([]);
    expect(projectSnapshots([ready], NOW).map((r) => r.id)).toEqual(["ready"]);
    expect(formatFooter([taken], NOW, 80)).toBe("");
    expect(formatFooter([ready], NOW, 120)).toContain("✓");
    expect(formatFooter([ready], NOW, 120)).toContain("result ready");
  });

  test("single old failure drops after 8s even with running sibling", () => {
    const failed = row({
      id: "f1",
      status: "failed",
      planId: "p",
      unitId: "T1",
      failureKind: "model_stream",
      terminalAt: NOW - 60_000,
      appliedReasoning: "high",
    });
    const running = row({
      id: "run",
      status: "running",
      planId: "p",
      unitId: "T1",
      appliedReasoning: "high",
    });
    expect(projectSnapshots([failed, running], NOW).map((r) => r.id)).toEqual(["run"]);
  });

  test("compacted failure stays past 8s while running sibling shares group", () => {
    const f1 = row({
      id: "f1",
      status: "failed",
      planId: "p",
      unitId: "T1",
      roleId: "developer",
      failureKind: "model_stream",
      terminalAt: NOW - 60_000,
      appliedReasoning: "high",
    });
    const f2 = row({
      id: "f2",
      status: "failed",
      planId: "p",
      unitId: "T1",
      roleId: "developer",
      failureKind: "model_stream",
      terminalAt: NOW - 90_000,
      appliedReasoning: "high",
    });
    const running = row({
      id: "run",
      status: "running",
      planId: "p",
      unitId: "T1",
      appliedReasoning: "high",
    });
    expect(projectSnapshots([f1, f2, running], NOW).map((r) => r.id).sort()).toEqual(["f1", "f2", "run"]);
  });
});

describe("one worker footer", () => {
  test("glyph, role abbrev, task, model label, applied effort, clock, exact tok/s", () => {
    const text = formatFooter(
      [
        row({
          id: "developer-1",
          appliedReasoning: "medium",
          modelLabel: "Composer 2.5",
          outputTokens: 186,
          streamMs: 2580,
        }),
      ],
      NOW,
      120,
    );
    expect(text).toBe("Pitako ● dev · running · Fix lifecycle · cursor · Composer 2.5 · med · 04:18 · 72 t/s");
    expect(text).not.toContain("\n");
    expect(text).not.toContain("~");
    expect(text).not.toContain("0 t/s");
  });

  test("shows provider and turns/tools when known", () => {
    const text = formatFooter(
      [
        row({
          id: "reviewer-1",
          roleId: "reviewer",
          appliedReasoning: "high",
          selectedModel: "xai/grok-4.7",
          modelLabel: "Grok 4.7",
          turns: 3,
          toolCalls: 5,
          outputTokens: 100,
          streamMs: 2000,
        }),
      ],
      NOW,
      160,
    );
    expect(text).toContain("xai");
    expect(text).toContain("Grok 4.7");
    expect(text).toContain("3t");
    expect(text).toContain("5 tools");
    expect(text).toContain("running");
    expect(text).not.toContain("xai/grok-4.7");
  });

  test("status word distinguishes waiting, stalled, and cancelled", () => {
    const waiting = formatFooter(
      [row({ id: "w", lastActivityKind: "prompt", outputTokens: undefined, appliedReasoning: "high", modelLabel: "M" })],
      NOW,
      80,
    );
    expect(waiting).toContain("waiting");
    expect(waiting).not.toContain("running");

    const stalled = formatFooter(
      [row({ id: "s", phase: "suspected_stall", inactivityMs: 90_000, appliedReasoning: "high", modelLabel: "M" })],
      NOW,
      80,
    );
    expect(stalled).toContain("stalled");

    const cancelled = formatFooter(
      [row({ id: "c", status: "cancelled", terminalAt: NOW - 1000, appliedReasoning: "high", modelLabel: "M" })],
      NOW,
      80,
    );
    expect(cancelled).toContain("cancelled");
    expect(cancelled).toContain("⊘");
  });

  test("tool activity replaces 0 t/s; tool time not shown as 0 t/s", () => {
    const text = formatFooter(
      [
        row({
          id: "developer-1",
          appliedReasoning: "medium",
          modelLabel: "Composer 2.5",
          outputTokens: 0,
          streamMs: 500,
          activeTool: { name: "bash", startedAt: NOW - 12_000 },
          lastActivityKind: "tool_start",
        }),
      ],
      NOW,
      120,
    );
    expect(text).toContain("bash · 00:12");
    expect(text).not.toContain("t/s");
    expect(text).not.toContain("0 t/s");
  });

  test("cursor-native displays as cursor", () => {
    const text = formatFooter(
      [
        row({
          id: "developer-1",
          appliedReasoning: "high",
          activeTool: { name: "cursor-native", startedAt: NOW - 500 },
        }),
      ],
      NOW,
      120,
    );
    expect(text).toContain("cursor");
    expect(text).not.toContain("cursor-native");
  });

  test("model… while waiting on model with no tokens", () => {
    const text = formatFooter(
      [
        row({
          id: "developer-1",
          lastActivityKind: "prompt",
          requestedModel: "cursor/composer-2.5",
          selectedModel: "cursor/composer-2.5",
        }),
      ],
      NOW,
      120,
    );
    expect(text).toContain("model…");
    expect(text).not.toContain("t/s");
  });

  test("no stream during suspected_stall", () => {
    const text = formatFooter(
      [
        row({
          id: "developer-1",
          phase: "suspected_stall",
          appliedReasoning: "high",
          modelLabel: "Composer 2.5",
          inactivityMs: 95_000,
          outputTokens: 10,
          streamMs: 5000,
        }),
      ],
      NOW,
      120,
    );
    expect(text).toContain("no stream · 01:35");
    expect(text).not.toContain("t/s");
  });

  test("idle dash activity", () => {
    const text = formatFooter(
      [
        row({
          id: "developer-1",
          phase: "idle",
          appliedReasoning: "high",
          modelLabel: "X",
          lastActivityKind: "tool_end",
        }),
      ],
      NOW,
      120,
    );
    expect(text).toContain("○");
    expect(text).toContain("—");
  });

  test("long task truncation and second line / secrets absent", () => {
    const long = `${"A".repeat(80)}\nSECRET-KEY=supersecret\nthird line`;
    const text = formatFooter(
      [
        row({
          id: "developer-1",
          task: long,
          appliedReasoning: "high",
          modelLabel: "M",
        }),
      ],
      NOW,
      200,
    );
    expect(text).toContain("A".repeat(42));
    expect(text).not.toContain("A".repeat(43));
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("third line");
    expect(text).not.toContain("\n");
  });

  test("Objective: prefix dropped", () => {
    const text = formatFooter(
      [
        row({
          id: "developer-1",
          task: "Objective: Ship the footer",
          appliedReasoning: "low",
          modelLabel: "M",
        }),
      ],
      NOW,
      120,
    );
    expect(text).toContain("Ship the footer");
    expect(text).not.toContain("Objective:");
  });

  test("narrow width keeps glyph, role, and a task fragment", () => {
    const text = formatFooter(
      [
        row({
          id: "developer-1",
          task: "Fix lifecycle boundary properly",
          appliedReasoning: "medium",
          modelLabel: "Composer 2.5",
          outputTokens: 100,
          streamMs: 2000,
        }),
      ],
      NOW,
      20,
    );
    expect(text).toContain("●");
    expect(text).toContain("dev");
    expect(text).toContain("running");
    expect(text.length).toBeLessThanOrEqual(20);
  });

  test("drop model before shortening task to 12", () => {
    const task = "Fix lifecycle boundary properly now!!!"; // 38 chars, under 42-cap
    const text = formatFooter(
      [
        row({
          id: "developer-1",
          task,
          appliedReasoning: "medium",
          modelLabel: "Composer 2.5",
          outputTokens: 100,
          streamMs: 2000,
        }),
      ],
      NOW,
      60,
    );
    expect(text).toContain("running");
    expect(text).not.toContain("Composer");
    expect(text.length).toBeLessThanOrEqual(60);
  });

  test("narrow width keeps status before the task fragment", () => {
    const text = formatFooter(
      [
        row({
          id: "developer-1",
          task: "Fix lifecycle boundary properly",
          appliedReasoning: "medium",
          modelLabel: "Composer 2.5",
        }),
      ],
      NOW,
      16,
    );
    expect(text).toContain("●");
    expect(text).toContain("dev");
    expect(text).toContain("running");
    expect(text.length).toBeLessThanOrEqual(16);
    const wider = formatFooter(
      [
        row({
          id: "developer-1",
          task: "Fix lifecycle boundary properly",
          appliedReasoning: "medium",
          modelLabel: "Composer 2.5",
        }),
      ],
      NOW,
      32,
    );
    expect(wider).toContain("running");
    expect(wider).toMatch(/Fix/);
    const budget = formatFooter(
      [
        row({
          id: "developer-1",
          task: "Fix lifecycle boundary properly",
          appliedReasoning: "medium",
          modelLabel: "Composer 2.5",
        }),
      ],
      NOW,
      24,
    );
    expect(budget).toContain("running");
    expect(budget).toMatch(/Fix/);
    expect(budget.length).toBeLessThanOrEqual(24);
  });

  test("active model wins only after appliedReasoning", () => {
    const pending = formatFooter(
      [
        row({
          id: "a",
          requestedModel: "example/primary",
          selectedModel: "example/fallback-1",
          requestedReasoning: "high",
          modelLabel: "Fallback Label",
        }),
      ],
      NOW,
      120,
    );
    expect(pending).toContain("primary");
    expect(pending).not.toContain("fallback-1");
    expect(pending).not.toContain("Fallback Label");
    expect(pending).toContain("high?");

    const active = formatFooter(
      [
        row({
          id: "a",
          requestedModel: "example/primary",
          selectedModel: "example/fallback-1",
          requestedReasoning: "high",
          appliedReasoning: "xhigh",
          modelLabel: "Fallback Label",
          fallbackOccurred: true,
          fallbackReason: "auth",
        }),
      ],
      NOW,
      120,
    );
    expect(active).toContain("Fallback Label");
    expect(active).toContain("xhigh");
    expect(active).not.toContain("xhigh?");
    expect(active).not.toContain("primary");
  });

  test("fallback does not change footer label; unused fallback absent", () => {
    const text = formatFooter(
      [
        row({
          id: "a",
          requestedModel: "example/primary",
          selectedModel: "example/primary",
          appliedReasoning: "high",
          modelLabel: "Primary",
        }),
      ],
      NOW,
      120,
    );
    expect(text).toContain("Primary");
    expect(text).not.toContain("fallback");
    expect(text).not.toContain("unused");
    expect(text).not.toContain("from ");
  });

  test("unknown effort omitted", () => {
    const text = formatFooter(
      [
        row({
          id: "a",
          appliedReasoning: "experimental-mode",
          modelLabel: "M",
        }),
      ],
      NOW,
      120,
    );
    expect(text).not.toContain("experimental");
    expect(text).toContain("M");
  });

  test("exact tok/s only; no tilde approximation", () => {
    const text = formatFooter(
      [
        row({
          id: "a",
          appliedReasoning: "med",
          modelLabel: "M",
          outputTokens: 100,
          streamMs: 1500,
        }),
      ],
      NOW,
      120,
    );
    expect(text).toContain("67 t/s");
    expect(text).not.toContain("~");

    const tooSlow = formatFooter(
      [
        row({
          id: "a",
          appliedReasoning: "med",
          modelLabel: "M",
          outputTokens: 1,
          streamMs: 5000,
        }),
      ],
      NOW,
      120,
    );
    // Math.round(1/5)=0 → omit
    expect(tooSlow).not.toContain("t/s");
    expect(tooSlow).not.toContain("0 t/s");
  });

  test("failed and cancelled glyphs", () => {
    const failed = formatFooter(
      [
        row({
          id: "f",
          status: "failed",
          terminalAt: NOW - 1000,
          failureKind: "model_stream",
          appliedReasoning: "high",
          modelLabel: "M",
        }),
      ],
      NOW,
      120,
    );
    expect(failed).toContain("×");
    expect(failed).toContain("no model_stream");

    const cancelled = formatFooter(
      [
        row({
          id: "c",
          status: "cancelled",
          terminalAt: NOW - 1000,
          appliedReasoning: "high",
          modelLabel: "M",
        }),
      ],
      NOW,
      120,
    );
    expect(cancelled).toContain("⊘");
  });

  test("failed tool_start does not say no model_stream", () => {
    const toolOnly = formatFooter(
      [
        row({
          id: "f2",
          status: "failed",
          phase: "stalled",
          terminalAt: NOW - 1000,
          lastActivityKind: "tool_start",
          appliedReasoning: "high",
          modelLabel: "M",
        }),
      ],
      NOW,
      120,
    );
    expect(toolOnly).toContain("×");
    expect(toolOnly).not.toContain("no model_stream");

    // failureKind stall still qualifies even when phase is stalled.
    const stalled = formatFooter(
      [
        row({
          id: "f",
          status: "failed",
          phase: "stalled",
          terminalAt: NOW - 1000,
          lastActivityKind: "model_stream",
          failureKind: "stall",
          appliedReasoning: "high",
          modelLabel: "M",
        }),
      ],
      NOW,
      120,
    );
    expect(stalled).toContain("no model_stream");
  });
});

describe("multi worker footer", () => {
  test("count form with role:unit", () => {
    const text = formatFooter(
      [
        row({ id: "d1", roleId: "developer", planId: "p", unitId: "T1", appliedReasoning: "med" }),
        row({ id: "r1", roleId: "reviewer", planId: "p", unitId: "T1", appliedReasoning: "high" }),
      ],
      NOW,
      120,
    );
    expect(text).toBe("Pitako ● 2 · running · dev:T1 · rev:T1");
    const tight = formatFooter(
      [
        row({ id: "d1", roleId: "developer", planId: "p", unitId: "T1" }),
        row({ id: "r1", roleId: "reviewer", planId: "p", unitId: "T1" }),
      ],
      NOW,
      24,
    );
    expect(tight).toContain("dev");
    expect(tight).toContain("rev");
    expect(tight.length).toBeLessThanOrEqual(24);
    expect(text).not.toContain("\n");
  });

  test("narrow multi drops to count", () => {
    const text = formatFooter(
      [
        row({ id: "d1", roleId: "developer", planId: "p", unitId: "T1" }),
        row({ id: "r1", roleId: "reviewer", planId: "p", unitId: "T1" }),
      ],
      NOW,
      10,
    );
    expect(text).toMatch(/● 2/);
    expect(text.length).toBeLessThanOrEqual(10);
  });
});

describe("formatAgentsDetail", () => {
  test("explicit unit tree with full role and model id", () => {
    const text = formatAgentsDetail(
      [
        row({
          id: "developer-aaa",
          roleId: "developer",
          planId: "plan-1",
          unitId: "T1",
          appliedReasoning: "medium",
          selectedModel: "cursor/composer-2.5",
          modelLabel: "Composer 2.5",
          outputTokens: 72,
          streamMs: 1000,
        }),
      ],
      NOW,
    );
    expect(text).toContain("T1\n");
    expect(text.includes("├─ ") || text.includes("└─ ")).toBe(true);
    expect(text).toContain("developer-aaa");
    expect(text).toContain("developer");
    expect(text).toContain("cursor/composer-2.5");
    expect(text).toContain("med applied");
    expect(text).toContain("72 t/s");
  });

  test("no fake hierarchy without planId+unitId", () => {
    const text = formatAgentsDetail(
      [
        row({ id: "a", roleId: "developer", appliedReasoning: "high", selectedModel: "x/y" }),
        row({ id: "b", roleId: "reviewer", appliedReasoning: "low", selectedModel: "x/z" }),
      ],
      NOW,
    );
    expect(text).not.toContain("├─");
    expect(text).not.toContain("└─");
    expect(text).toContain("developer");
    expect(text).toContain("reviewer");
  });

  test("stable order: planId, unitId, acceptedAt, id; ungrouped after grouped", () => {
    const text = formatAgentsDetail(
      [
        row({ id: "u2", acceptedAt: NOW - 100, task: "ungrouped-late" }),
        row({ id: "b", planId: "p", unitId: "T2", acceptedAt: NOW - 300, task: "second-unit" }),
        row({ id: "a2", planId: "p", unitId: "T1", acceptedAt: NOW - 200, task: "first-unit-late" }),
        row({ id: "a1", planId: "p", unitId: "T1", acceptedAt: NOW - 400, task: "first-unit-early" }),
        row({ id: "u1", acceptedAt: NOW - 500, task: "ungrouped-early" }),
      ],
      NOW,
    );
    const iT1 = text.indexOf("T1\n");
    const iT2 = text.indexOf("T2\n");
    const iEarly = text.indexOf("first-unit-early");
    const iLate = text.indexOf("first-unit-late");
    const iUngroupedEarly = text.indexOf("ungrouped-early");
    const iUngroupedLate = text.indexOf("ungrouped-late");
    expect(iT1).toBeGreaterThanOrEqual(0);
    expect(iT2).toBeGreaterThan(iT1);
    expect(iEarly).toBeGreaterThan(iT1);
    expect(iLate).toBeGreaterThan(iEarly);
    expect(iUngroupedEarly).toBeGreaterThan(iT2);
    expect(iUngroupedLate).toBeGreaterThan(iUngroupedEarly);
  });

  test("failure compaction shares group, role, failureKind", () => {
    const text = formatAgentsDetail(
      [
        row({
          id: "f1",
          status: "failed",
          planId: "p",
          unitId: "T1",
          failureKind: "model_stream",
          terminalAt: NOW - 1000,
          appliedReasoning: "high",
        }),
        row({
          id: "f2",
          status: "failed",
          planId: "p",
          unitId: "T1",
          failureKind: "model_stream",
          terminalAt: NOW - 2000,
          appliedReasoning: "high",
        }),
        row({
          id: "run",
          status: "running",
          planId: "p",
          unitId: "T1",
          appliedReasoning: "high",
          selectedModel: "x/y",
        }),
      ],
      NOW,
    );
    expect(text).toContain("× developer ×2 · model_stream");
    expect(text).not.toContain("f1");
    expect(text).not.toContain("f2");
    expect(text).toContain("run");
  });

  test("ungrouped failures do not compact", () => {
    const text = formatAgentsDetail(
      [
        row({
          id: "f1",
          status: "failed",
          failureKind: "model_stream",
          terminalAt: NOW - 1000,
          appliedReasoning: "high",
        }),
        row({
          id: "f2",
          status: "failed",
          failureKind: "model_stream",
          terminalAt: NOW - 2000,
          appliedReasoning: "high",
        }),
      ],
      NOW,
    );
    expect(text).toContain("f1");
    expect(text).toContain("f2");
    expect(text).not.toContain("×2");
    expect(text).not.toContain("× developer ×2");
  });

  test("do not compact running or result-ready rows", () => {
    const text = formatAgentsDetail(
      [
        row({
          id: "c1",
          status: "completed",
          resultTaken: false,
          planId: "p",
          unitId: "T1",
          failureKind: "model_stream",
          appliedReasoning: "high",
        }),
        row({
          id: "c2",
          status: "completed",
          resultTaken: false,
          planId: "p",
          unitId: "T1",
          failureKind: "model_stream",
          appliedReasoning: "high",
        }),
      ],
      NOW,
    );
    expect(text).toContain("c1");
    expect(text).toContain("c2");
    expect(text).toContain("result ready");
    expect(text).not.toContain("×2");
  });

  test("fallback only when occurred and applied; detail includes from+reason", () => {
    const withFb = formatAgentsDetail(
      [
        row({
          id: "a",
          appliedReasoning: "xhigh",
          selectedModel: "example/fallback-1",
          requestedModel: "example/primary",
          fallbackOccurred: true,
          fallbackReason: "auth",
        }),
      ],
      NOW,
    );
    expect(withFb).toContain("from example/primary");
    expect(withFb).toContain("auth");
    expect(withFb).toContain("example/fallback-1");

    const unused = formatAgentsDetail(
      [
        row({
          id: "a",
          appliedReasoning: "high",
          selectedModel: "example/primary",
          requestedModel: "example/primary",
        }),
      ],
      NOW,
    );
    expect(unused).not.toContain("from ");
    expect(unused).not.toContain("unused");
  });
});

describe("role abbreviations", () => {
  test("known roles abbreviate in footer; unknown short stays, long truncates to 4", () => {
    expect(formatFooter([row({ id: "1", roleId: "architect", appliedReasoning: "low", modelLabel: "M" })], NOW, 80)).toContain("arch");
    expect(formatFooter([row({ id: "1", roleId: "researcher", appliedReasoning: "low", modelLabel: "M" })], NOW, 80)).toContain("res");
    expect(formatFooter([row({ id: "1", roleId: "coordinator", appliedReasoning: "low", modelLabel: "M" })], NOW, 80)).toContain("coord");
    expect(formatFooter([row({ id: "1", roleId: "ops", appliedReasoning: "low", modelLabel: "M" })], NOW, 80)).toContain("ops");
    expect(formatFooter([row({ id: "1", roleId: "specialist", appliedReasoning: "low", modelLabel: "M" })], NOW, 80)).toContain("spec");
  });
});
