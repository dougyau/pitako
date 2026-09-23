import { afterEach, describe, expect, test } from "bun:test";
import {
  bindAgentUi,
  clearObservations,
  listObservations,
  observationEpoch,
  publishObservation,
  unbindAgentUi,
  type AgentUiScheduler,
} from "../extensions/agent/observe.ts";
import type { AgentUiSnapshot } from "../extensions/agent/ui.ts";
import pitako from "../extensions/index.ts";

type StatusCall = { key: string; text: string | undefined };

function baseRow(patch: Partial<AgentUiSnapshot> & Pick<AgentUiSnapshot, "id">): AgentUiSnapshot {
  return {
    roleId: "developer",
    status: "running",
    phase: "working",
    task: "Fix lifecycle",
    acceptedAt: 1_000_000,
    selectedModel: "cursor/composer-2.5",
    lastActivityKind: "model_stream",
    ...patch,
  };
}

function fakeClock() {
  let now = 1_000_000;
  const ticks: Array<() => void> = [];
  let timerCount = 0;
  const scheduler: AgentUiScheduler = {
    setInterval(fn) {
      timerCount += 1;
      ticks.push(fn);
      return { unref() {} };
    },
    clearInterval() {
      timerCount = Math.max(0, timerCount - 1);
      ticks.length = 0;
    },
  };
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const tick of [...ticks]) tick();
    },
    timerCount: () => timerCount,
    scheduler,
  };
}

afterEach(() => {
  unbindAgentUi();
  clearObservations();
});

describe("agent UI lifecycle", () => {
  test("a publish from before reload cannot add an unseen worker", () => {
    const staleEpoch = observationEpoch();
    clearObservations();
    publishObservation(baseRow({ id: "never-seen" }), staleEpoch);
    expect(listObservations()).toEqual([]);
  });

  test("a publish from before reload does not resurrect a worker", () => {
    publishObservation(baseRow({ id: "reviewer-dead" }));
    const epoch = observationEpoch();
    clearObservations();
    publishObservation(baseRow({ id: "reviewer-dead", status: "running" }), epoch);
    expect(listObservations().map((row) => row.id)).not.toContain("reviewer-dead");
    publishObservation(baseRow({ id: "reviewer-live", status: "cancelled" }));
    expect(listObservations().map((row) => row.id)).toEqual(["reviewer-live"]);
  });

  test("observations are process-shared across extension copies", () => {
    publishObservation(baseRow({ id: "reviewer-shared" }));
    const slot = (globalThis as Record<symbol, { rows: Map<string, AgentUiSnapshot> }>)[
      Symbol.for("pitako.agentObservations")
    ];
    expect(slot?.rows.get("reviewer-shared")?.status).toBe("running");
  });

  test("accepted worker calls setStatus; activity and terminal update again", () => {
    const statuses: StatusCall[] = [];
    const sendMessageCalls: unknown[] = [];
    const clock = fakeClock();

    bindAgentUi({
      setStatus: (key, text) => statuses.push({ key, text }),
      now: clock.now,
      columns: () => 120,
      scheduler: clock.scheduler,
      modelLookup: (provider, id) =>
        provider === "cursor" && id === "composer-2.5" ? { name: "Composer 2.5" } : undefined,
    });

    expect(statuses.at(-1)).toEqual({ key: "pitako.agents", text: undefined });
    const before = statuses.length;

    publishObservation(
      baseRow({
        id: "dev-1",
        appliedReasoning: "medium",
        outputTokens: 100,
        streamMs: 2000,
      }),
    );
    expect(statuses.length).toBeGreaterThan(before);
    expect(statuses.at(-1)?.key).toBe("pitako.agents");
    expect(statuses.at(-1)?.text).toContain("●");
    expect(statuses.at(-1)?.text).toContain("Composer 2.5");
    expect(clock.timerCount()).toBe(1);

    const afterAccept = statuses.length;
    publishObservation(
      baseRow({
        id: "dev-1",
        appliedReasoning: "medium",
        activeTool: { name: "bash", startedAt: clock.now() - 1500 },
        lastActivityKind: "tool",
      }),
    );
    expect(statuses.length).toBeGreaterThan(afterAccept);
    expect(statuses.at(-1)?.text).toContain("bash");

    const afterActivity = statuses.length;
    publishObservation(
      baseRow({
        id: "dev-1",
        status: "completed",
        resultTaken: false,
        terminalAt: clock.now(),
        appliedReasoning: "medium",
        lastActivityKind: "end",
      }),
    );
    expect(statuses.length).toBeGreaterThan(afterActivity);
    expect(statuses.at(-1)?.text).toContain("✓");
    expect(statuses.at(-1)?.text).toContain("result ready");
    expect(clock.timerCount()).toBe(0);
    expect(sendMessageCalls).toEqual([]);
  });

  test("a finished worker leaves the footer when its linger timer fires", () => {
    const statuses: StatusCall[] = [];
    let now = 1_000_000;
    let linger: (() => void) | undefined;
    let lingerMs = 0;
    bindAgentUi({
      setStatus: (key, text) => statuses.push({ key, text }),
      now: () => now,
      columns: () => 80,
      scheduler: {
        setInterval: () => ({ unref() {} }),
        clearInterval() {},
        setTimeout(fn, ms) {
          linger = fn;
          lingerMs = ms;
          return { unref() {} };
        },
        clearTimeout() {
          linger = undefined;
        },
      },
    });
    publishObservation(
      baseRow({
        id: "dev-linger",
        status: "failed",
        terminalAt: now,
        lastActivityKind: "model_stream",
        failureKind: "model_stream",
      }),
    );
    expect(statuses.at(-1)?.text).toContain("failed");
    expect(lingerMs).toBe(8_000);
    now += 8_000;
    linger?.();
    expect(statuses.at(-1)).toEqual({ key: "pitako.agents", text: undefined });
  });

  test("last running worker finishing stops the clock", () => {
    const clock = fakeClock();
    const statuses: StatusCall[] = [];
    bindAgentUi({
      setStatus: (key, text) => statuses.push({ key, text }),
      now: clock.now,
      columns: () => 80,
      scheduler: clock.scheduler,
    });

    publishObservation(baseRow({ id: "a" }));
    publishObservation(baseRow({ id: "b", roleId: "reviewer" }));
    expect(clock.timerCount()).toBe(1);

    publishObservation(
      baseRow({
        id: "a",
        status: "completed",
        resultTaken: true,
        terminalAt: clock.now(),
      }),
    );
    expect(clock.timerCount()).toBe(1);

    publishObservation(
      baseRow({
        id: "b",
        roleId: "reviewer",
        status: "failed",
        terminalAt: clock.now(),
        failureKind: "model_stream",
      }),
    );
    expect(clock.timerCount()).toBe(0);
  });

  test("shutdown or unbind clears pitako.agents", () => {
    const statuses: StatusCall[] = [];
    const clock = fakeClock();
    bindAgentUi({
      setStatus: (key, text) => statuses.push({ key, text }),
      now: clock.now,
      columns: () => 80,
      scheduler: clock.scheduler,
    });
    publishObservation(baseRow({ id: "x" }));
    expect(statuses.at(-1)?.text).toBeTruthy();
    expect(clock.timerCount()).toBe(1);

    unbindAgentUi();
    expect(statuses.at(-1)).toEqual({ key: "pitako.agents", text: undefined });
    expect(clock.timerCount()).toBe(0);
    expect(listObservations().length).toBe(1); // unbind does not clear observations
  });

  test("second bind does not leave two timers", () => {
    const clock = fakeClock();
    const statuses: StatusCall[] = [];
    const opts = {
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      now: clock.now,
      columns: () => 80,
      scheduler: clock.scheduler,
    };

    bindAgentUi(opts);
    publishObservation(baseRow({ id: "one" }));
    expect(clock.timerCount()).toBe(1);

    bindAgentUi(opts);
    // previous unbind cleared timer; new bind re-renders existing observation and starts one timer
    expect(clock.timerCount()).toBe(1);
    clock.advance(1000);
    expect(clock.timerCount()).toBe(1);
  });

  test("render records zero sendMessage calls", () => {
    const sendMessage = (..._args: unknown[]) => {
      throw new Error("sendMessage must not be called from renderer");
    };
    void sendMessage;
    const sendMessageCalls: unknown[] = [];
    const clock = fakeClock();
    bindAgentUi({
      setStatus: () => {},
      now: clock.now,
      columns: () => 80,
      scheduler: clock.scheduler,
      modelLookup: () => ({ name: "Composer 2.5" }),
    });
    publishObservation(
      baseRow({
        id: "sm",
        appliedReasoning: "high",
        outputTokens: 50,
        streamMs: 1000,
      }),
    );
    clock.advance(1000);
    publishObservation(
      baseRow({
        id: "sm",
        status: "completed",
        resultTaken: false,
        terminalAt: clock.now(),
        appliedReasoning: "high",
      }),
    );
    expect(sendMessageCalls).toHaveLength(0);
  });

  test("production session binding preserves profile status across workers and reload", async () => {
    const statuses = new Map<string, string>();
    const handlers = new Map<string, Function>();
    const commands = new Map<string, Function>();
    const pi = {
      registerFlag() {},
      registerCommand(name: string, command: { handler: Function }) { commands.set(name, command.handler); },
      registerTool() {},
      on(event: string, handler: Function) { handlers.set(event, handler); },
      getFlag() { return undefined; },
      getAllTools() { return [{ name: "read" }]; },
      getActiveTools() { return ["read"]; },
      setActiveTools() {},
      getSessionName() { return "pitako:coding"; },
      setSessionName() {},
      sendMessage() { throw new Error("not expected"); },
    };
    const ctx = {
      hasUI: true,
      ui: {
        notify() {},
        setStatus(key: string, text: string | undefined) {
          if (text === undefined) statuses.delete(key);
          else statuses.set(key, text);
        },
      },
    };
    pitako(pi as never);
    const start = handlers.get("session_start");
    const shutdown = handlers.get("session_shutdown");
    expect(start).toBeDefined();
    await start?.({}, ctx);
    expect(statuses.get("pitako")).toBe("pitako:coding");

    publishObservation(baseRow({ id: "production-worker" }));
    expect(statuses.get("pitako")).toBe("pitako:coding");
    expect(statuses.get("pitako.agents")).toContain("● dev");
    const visibleStatusLine = [...statuses.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, text]) => text)
      .join(" ");
    expect(visibleStatusLine).toContain("pitako:coding");
    expect(visibleStatusLine).toContain("● dev");
    expect(visibleStatusLine.length).toBeLessThanOrEqual(80);

    await commands.get("pitako")?.("profile analysis", ctx);
    expect(statuses.get("pitako")).toBe("pitako:analysis");
    publishObservation(baseRow({ id: "production-worker", task: "Still running" }));
    expect(statuses.get("pitako")).toBe("pitako:analysis");

    await start?.({}, ctx);
    expect(statuses.get("pitako")).toBe("pitako:coding");
    expect(statuses.get("pitako.agents")).toContain("● dev");

    await shutdown?.();
    expect(statuses.get("pitako")).toBe("pitako:coding");
    expect(statuses.has("pitako.agents")).toBe(false);
  });

  test("empty relevant set clears status key", () => {
    const statuses: StatusCall[] = [];
    const clock = fakeClock();
    bindAgentUi({
      setStatus: (key, text) => statuses.push({ key, text }),
      now: clock.now,
      columns: () => 80,
      scheduler: clock.scheduler,
    });
    publishObservation(
      baseRow({
        id: "gone",
        status: "completed",
        resultTaken: true,
        terminalAt: clock.now() - 9_000,
      }),
    );
    expect(statuses.at(-1)).toEqual({ key: "pitako.agents", text: undefined });
  });
});
