import { stubExternalFactories } from "./fixtures/offline.ts";
stubExternalFactories();
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pitako from "../extensions/index.ts";
import * as bridgeModule from "../extensions/agent/bridge/broker.ts";
import * as controllerModule from "../extensions/agent/controller.ts";
import { connect } from "../extensions/agent/bridge/client.js";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";

const fixture = agentFixtureOwnership();
async function foreground(run: (state: {
  root: string; hooks: Map<string, Function>; flags: Map<string, unknown>; ctx: {
    cwd: string; hasUI: boolean; mode: string; isIdle(): boolean;
    sessionManager: { getSessionId(): string; getEntries(): never[] }; ui: { notify(): void; setStatus(): void };
  };
}) => Promise<void>) {
  const base = mkdtempSync(path.join(tmpdir(), "pitako-bridge-foreground-"));
  const root = path.join(base, "bridge");
  mkdirSync(root, { mode: 0o700 });
  const oldDir = process.env.PI_CODING_AGENT_DIR, oldChild = process.env.PITAKO_INSTANCE_ID;
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.PITAKO_INSTANCE_ID;
  const flags = new Map<string, unknown>(), hooks = new Map<string, Function>();
  const ctx = { cwd: base, hasUI: false, mode: "rpc", isIdle: () => true,
    sessionManager: { getSessionId: () => "owner", getEntries: (): never[] => [] },
    ui: { notify() {}, setStatus() {} } };
  try {
    pitako({ registerFlag() {}, registerTool() {}, registerCommand() {},
      on(name: string, handler: Function) { hooks.set(name, handler); },
      getFlag(name: string) { return flags.get(name); }, getActiveTools: () => ["read", "edit", "write"],
      getAllTools: () => ["read", "edit", "write", "apply_patch"].map(name => ({ name })),
      setActiveTools() {}, getSessionName: () => "pitako:coding", setSessionName() {}, sendMessage() {},
    } as never);
    await run({ root, flags, hooks, ctx });
  } finally {
    await hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldChild === undefined) delete process.env.PITAKO_INSTANCE_ID; else process.env.PITAKO_INSTANCE_ID = oldChild;
    rmSync(base, { recursive: true });
  }
}

test("factory-only and disabled/interactive/print/child foregrounds create no bridge lifetime or discovery", fixture.ownedCase("bridge guarded loads", async () => {
  let starts = 0;
  const original = bridgeModule.createAgentBridge;
  const capture = spyOn(bridgeModule, "createAgentBridge").mockImplementation((...args) => { starts++; return original(...args); });
  try {
    for (const guard of ["factory-only", "disabled", "interactive", "print", "child"]) {
      await foreground(async ({ root, flags, hooks, ctx }) => {
        const before = readdirSync(root);
        flags.set("pitako-agent-bridge", root);
        if (guard === "factory-only") {
          expect(readdirSync(root)).toEqual(before); expect(starts).toBe(0); return;
        }
        if (guard === "disabled") flags.delete("pitako-agent-bridge");
        if (guard === "interactive" || guard === "print") ctx.mode = guard;
        if (guard === "child") process.env.PITAKO_INSTANCE_ID = "fixture-child";
        await hooks.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
        expect(starts).toBe(0);
        expect(readdirSync(root).some(name => name === "descriptor.json" || name.endsWith(".sock"))).toBe(false);
      });
    }
  } finally { capture.mockRestore(); }
}));

test("foreground publishes protocol 2 without permission flags or mutation capabilities", fixture.ownedCase("bridge read-only flags", async () => {
  await foreground(async ({ root, flags, hooks, ctx }) => {
    flags.set("pitako-agent-bridge", root);
    await hooks.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const file = path.join(root, "descriptor.json");
    const descriptor = JSON.parse(readFileSync(file, "utf8"));
    expect(descriptor.version).toBe(2);
    expect(descriptor).not.toHaveProperty("grants");
    const client = await connect(file, { expectedSessionId: "owner" });
    try {
      expect(client.capabilities).toEqual(["workers.list", "workers.detail", "workers.requests", "workers.activity", "workers.result", "subscribe", "unsubscribe",
        "history.list", "history.read", "route.read", "workers.detail.public-v1", "workers.activity.public-v1", "workers.result.public-v1",
        "architecture.list", "architecture.read", "architecture.public-v1"]);
      expect((await client.list()).items).toEqual([]);
    }
    finally { await client.disconnect(); }
  });
}));

test("composed pending bootstrap is assigned before readiness and shutdown joins without late publication", fixture.ownedCase("bridge interrupted foreground", async () => {
  const original = controllerModule.createAgentController;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const capture = spyOn(controllerModule, "createAgentController").mockImplementation((...args) => {
    const controller = original(...args), open = controller.openView;
    controller.openView = () => {
      const view = open();
      return { ...view, async close() { entered(); await held; await view.close(); } };
    };
    return controller;
  });
  try {
    await foreground(async ({ root, flags, hooks, ctx }) => {
      flags.set("pitako-agent-bridge", root);
      const startup = hooks.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
      let shutdown: Promise<unknown> | undefined;
      try {
        await Promise.race([started, startup.then(() => { throw Error("Bootstrap ended before the owned fixture hold"); })]);
        shutdown = hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
        expect(readdirSync(root).some(name => name === "descriptor.json")).toBe(false);
        release(); await startup; await shutdown;
        expect(readdirSync(root).some(name => name.endsWith(".sock") || name === "descriptor.json")).toBe(false);
      } finally { release(); await startup; await shutdown; }
    });
  } finally { release(); capture.mockRestore(); }
}));
