import { describe, expect, spyOn, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentScreen, compatibilityView, type AgentView, type AgentScreenView } from "../extensions/agent/screen.ts";

describe("shared compatibility screen", () => {
  test("selection, detail/back/close and resize use the same inert component", async () => {
    let closed = 0;
    const screen = new AgentScreen(compatibilityView(), () => {}, () => closed++, () => 40);
    expect(screen.render(100).join("\n")).toContain("> fixture-alpha");
    screen.handleInput("\x1b[B");
    screen.handleInput("\r");
    expect(screen.render(100).join("\n")).toContain("Identity: fixture-beta");
    expect(screen.render(9).every((line) => visibleWidth(line) <= 9)).toBe(true);
    screen.handleInput("\x1b");
    expect(screen.render(100).join("\n")).toContain("Agents · list");
    screen.handleInput("\x1b");
    screen.handleInput("\x1b");
    await screen.finish();
    expect(closed).toBe(1);
    const empty = new AgentScreen(compatibilityView([]), () => {}, () => {}, () => 40);
    empty.handleInput("\x1b[B");
    empty.handleInput("\r");
    expect(empty.render(100).join("\n")).toContain("No workers");
    const hostile = new AgentScreen(compatibilityView([{ id: "\x1b]0;title\x07", role: "\x9b31m", state: "idle" }]), () => {}, () => {}, () => 40);
    expect(hostile.render(100).join("\n")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    await empty.finish(); await hostile.finish();
  });
});

test("bounded pages, sensitive acknowledgements, hostile text and unavailable controls remain explicit under resize", async () => {
  let height = 10;
  const fetches: unknown[] = [], acknowledgements: string[] = [];
  const base = compatibilityView();
  const view: AgentView = { ...base,
    detail(id, offset) {
      const detail = base.detail(id);
      return { ...detail, workbrief: { text: offset ? "next page" : "\x1b]0;title\x07\x1b]8;;https://evil\x1b\\raw\x1b]8;;\x1b\\\n" + "😀 text\n".repeat(30),
        offset: offset ?? 0, nextOffset: offset ? null : 1024, source: "original WorkBrief" } };
    },
    acknowledge(kind) { acknowledgements.push(kind); },
    route(id, offset = 0) {
      expect(acknowledgements).toContain("route"); fetches.push({ id, offset });
      return { text: offset ? "raw-next" : "raw-first", offset, nextOffset: offset ? null : 1024 };
    },
    async history(query, worker) {
      fetches.push({ query, worker });
      if (query.action === "read") {
        expect(acknowledgements).toContain("history");
        return { items: [{ encoding: "base64", data: Buffer.from("\x1b]0;native-title\x07native raw").toString("base64") }],
          diagnostics: [{ code: "partial_tail" }], cursor: query.cursor ? null : "next" };
      }
      return { items: [{ historyId: "native-id" }], diagnostics: [], cursor: null };
    },
  };
  const screen = new AgentScreen(view, () => {}, () => {}, () => height, "fixture-alpha");
  try {
    const first = screen.render(30).join("\n");
    expect(first).toContain("Controls unavailable");
    expect(first).not.toMatch(/\x1b|[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    screen.handleInput("\x1b[6~");
    expect(screen.render(30).join("\n")).not.toBe(first);
    screen.handleInput("n");
    expect(screen.render(30).join("\n")).toContain("next page");
    screen.handleInput("q");
    expect(screen.render(80).join("\n")).toContain("read-only");
    screen.handleInput("3");
    expect(fetches).toHaveLength(0);
    screen.handleInput("a"); screen.handleInput("\x1b");
    expect(fetches).toHaveLength(0);
    screen.handleInput("a"); screen.handleInput("yes"); screen.handleInput("\r");
    expect(fetches).toHaveLength(1);
    screen.handleInput("n"); expect(fetches).toHaveLength(2);
    screen.handleInput("5");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(fetches).toHaveLength(3); // metadata only
    screen.handleInput("\r");
    expect(fetches).toHaveLength(3);
    screen.handleInput("yes"); screen.handleInput("\r");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(fetches).toHaveLength(4);
    screen.render(80); // the host lays out the newly fetched page before scrolling it
    screen.handleInput("\x1b[6~");
    expect(screen.render(80).join("\n")).toContain("partial_tail");
    expect(screen.render(80).join("\n")).not.toContain("\x1b");
    for (const width of [1, 9, 80, 120]) {
      height = 5;
      const lines = screen.render(width);
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    }
  } finally { await screen.finish(); }
});

test("switching and closing during a sensitive read discard stale content and join work without cancelling workers", async () => {
  let release!: (page: { items: unknown[]; diagnostics: []; cursor: null }) => void;
  const pending = new Promise<{ items: unknown[]; diagnostics: []; cursor: null }>(resolve => { release = resolve; });
  let paints = 0, closes = 0, hostClosed = 0, cancels = 0;
  const base = compatibilityView();
  const timers = new Set<unknown>();
  const token = { unref() { timers.add(token); } };
  const timeout = spyOn(globalThis, "setTimeout").mockReturnValue(token as never);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(token => { timers.delete(token); });
  let clock = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  let observations = 0;
  const view: AgentView = { ...base, detail(id) {
    observations++;
    return { ...base.detail(id), controls: { available: true, selection: { processId: "fixture", epoch: "fixture",
      coordinatorSessionId: "fixture", instanceId: id, generation: 1, historyId: "fixture-history", sessionId: "fixture-session",
      target: { kind: "background", instanceId: id } } } };
  }, history: async () => pending, cancel() { cancels++; throw Error("must not cancel"); },
    async close() { closes++; await pending; } };
  const screen = new AgentScreen(view, () => { paints++; }, () => { hostClosed++; }, () => 20, "fixture-alpha");
  try {
    expect(timers.size).toBe(1);
    const [tick, delay] = timeout.mock.calls[0]!;
    expect(delay).toBe(1000);
    if (typeof tick !== "function") throw new Error("Expected a timer callback");
    screen.handleInput("r"); screen.handleInput("r");
    expect(observations).toBe(1);
    clock = 1000;
    tick(); expect(observations).toBe(2); expect(timers.size).toBe(1);
    screen.handleInput("5"); expect(timers.size).toBe(0);
    screen.handleInput("1");
    expect(screen.render(80).join("\n")).toContain("Brief");
    expect(timers.size).toBe(0);
    screen.handleInput("\x1b"); screen.handleInput("\x1b");
    const closing = screen.finish(), count = paints;
    expect(hostClosed).toBe(0);
    release({ items: ["stale sensitive history"], diagnostics: [], cursor: null });
    await closing;
    tick(); // even an already-dispatched callback cannot paint or restart a closed view
    expect(paints).toBe(count);
    expect(timers.size).toBe(0);
    expect(screen.render(80).join("\n")).not.toContain("stale sensitive history");
    expect(closes).toBe(1); expect(hostClosed).toBe(1); expect(cancels).toBe(0);
  } finally {
    release({ items: [], diagnostics: [], cursor: null });
    await screen.finish();
    timeout.mockRestore(); clear.mockRestore(); now.mockRestore();
  }
});

test("asynchronous screen paging resets the selected producer without a competing detail request", async () => {
  const base = compatibilityView(), offsets: number[] = [];
  let details = 0, rendered: (() => void) | undefined;
  const view: AgentScreenView = { ...base,
    async detail(id) { details++; return base.detail(id); },
    async requests(_id, offset = 0) {
      offsets.push(offset);
      return { text: offset ? "SDK-next" : "SDK-first", offset, nextOffset: offset ? null : 1024 };
    },
  };
  const screen = new AgentScreen(view, () => rendered?.(), () => {}, () => 40, "fixture-alpha");
  const show = (action: () => void, text: string) => new Promise<void>(resolve => {
    rendered = () => {
      const lines = screen.render(100).join("\n");
      if (lines.includes(text) && !lines.includes("Outstanding work")) { rendered = undefined; resolve(); }
    };
    action(); rendered?.();
  });
  try {
    await show(() => {}, "Identity: fixture-alpha");
    await show(() => screen.handleInput("4"), "SDK-first");
    await show(() => screen.handleInput("n"), "SDK-next");
    await show(() => screen.handleInput("p"), "SDK-first");
    expect(offsets).toEqual([0, 1024, 0]);
    expect(details).toBe(1);
  } finally { await screen.finish(); }
});

test("mutation uncertainty survives post-error, manual and periodic reads plus explicit reconnect without replay", async () => {
  const unknown = "Unknown mutation outcome: acknowledgment lost; do not replay. Reobserve markers; absence is not non-delivery.";
  let clock = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const timeout = spyOn(globalThis, "setTimeout").mockReturnValue({ unref() {} } as never);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  try {
    for (const form of ["q", "c"]) {
      let disconnected = false, mutations = 0, reconnects = 0, reads = 0;
      let painted: (() => void) | undefined;
      const base = compatibilityView();
      const view: AgentScreenView = { ...base,
        detail(id) {
          reads++;
          if (disconnected) return Promise.reject(Error("Agent view is disconnected; explicit reconnect required"));
          return { ...base.detail(id), controls: { available: true, selection: { processId: "fixture", epoch: "fixture",
            coordinatorSessionId: "fixture", instanceId: id, generation: 1, historyId: "history", sessionId: "session",
            target: { kind: "background", instanceId: id } } } };
        },
        connection: () => disconnected ? "STALE · owner fixture / epoch · last reply 2000-01-01 · controls disabled · R reconnect" : "",
        async input() { mutations++; disconnected = true; throw Error(unknown); },
        async cancel() { mutations++; disconnected = true; throw Error(unknown); },
        async reconnect() { reconnects++; disconnected = false; },
      };
      const screen = new AgentScreen(view, () => painted?.(), () => {}, () => 40, "fixture-alpha");
      const settled = (action: () => void) => new Promise<string>(resolve => {
        painted = () => {
          const rendered = screen.render(160).join("\n");
          if (!rendered.includes("Outstanding work")) { painted = undefined; resolve(rendered); }
        };
        action(); painted?.();
      });
      try {
        screen.handleInput(form);
        clock += 2000; // The form outlives the refresh throttle, exposing the original overwrite.
        screen.handleInput(form === "c" ? "yes" : "lost query");
        const after = await settled(() => screen.handleInput("\r"));
        expect(after).toContain(unknown);
        expect(after).toContain("STALE · owner fixture");
        expect(after).toContain("last reply 2000-01-01");
        expect(after).toContain("controls disabled");
        const readCount = reads;
        clock += 2000;
        const refreshed = await settled(() => screen.handleInput("r"));
        expect(reads).toBeGreaterThan(readCount);
        expect(refreshed).toContain("explicit reconnect required");
        expect(refreshed).toContain(unknown);
        const [tick] = timeout.mock.calls.at(-1)!;
        expect(typeof tick).toBe("function");
        clock += 2000;
        const periodic = await settled(() => { if (typeof tick === "function") tick(); });
        expect(periodic).toContain("explicit reconnect required");
        expect(periodic).toContain(unknown);
        screen.handleInput("q");
        expect(screen.render(160).join("\n")).toContain("controls disabled");
        expect(mutations).toBe(1); expect(reconnects).toBe(0);
        const connected = await settled(() => screen.handleInput("R"));
        expect(connected).toContain("Reconnected and reobserved");
        expect(connected).toContain(unknown);
        expect(connected).not.toContain("STALE");
        expect(mutations).toBe(1); expect(reconnects).toBe(1);
      } finally { await screen.finish(); }
    }
  } finally { now.mockRestore(); timeout.mockRestore(); clear.mockRestore(); }
});
