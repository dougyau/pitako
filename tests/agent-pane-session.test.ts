import { stubExternalFactories } from "./fixtures/offline.ts";
stubExternalFactories();
import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createPaneSession } from "../extensions/herdr/agents-ui/session.ts";
import * as paneSessions from "../extensions/herdr/agents-ui/session.ts";
import pitako from "../extensions/index.ts";
import { registerExecution, unregisterExecution } from "../extensions/execution-identity.ts";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
test("owned late open and focus subprocesses join retirement/close; flags cannot escalate an existing pane", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-pane-launch-"));
  const cli = path.join(root, "herdr"), socketPath = path.join(root, "gate");
  const opened = deferred(), releaseOpen = deferred(), focused = deferred(), releaseFocus = deferred();
  const requests: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", async data => {
      const request = JSON.parse(data.toString()); requests.push(request);
      const args = request.args as string[];
      let result: unknown = {};
      if (args.join(" ").startsWith("plugin pane open")) {
        opened.resolve(); await releaseOpen.promise;
        result = { plugin_pane: { pane: { pane_id: "owned-panel" } } };
      } else if (args.join(" ").startsWith("plugin pane focus")) {
        focused.resolve(); await releaseFocus.promise;
      }
      socket.end(JSON.stringify({ result }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  writeFileSync(cli, `#!${process.execPath}
import {createConnection} from "node:net";
const s=createConnection(process.env.TEST_LAUNCH_SOCKET);
s.on("connect",()=>s.write(JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd()})));
s.on("data",data=>process.stdout.write(data));s.on("error",()=>process.exitCode=1);
`, { mode: 0o700 });
  chmodSync(cli, 0o700);
  const owner = { sessionId: "launch-owner", token: Symbol() }, controller = createAgentController(owner, () => owner);
  const env = { ...process.env, HERDR_BIN_PATH: cli, TEST_LAUNCH_SOCKET: socketPath, HERDR_SESSION: "wrong-inherited" };
  const presence = { present: true, paneId: "caller", socketPath: path.join(root, "actual-herdr-socket") };
  let session = createPaneSession(controller, presence, root, env);
  let launch: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  try {
    launch = session.launch({ control: false, rawHistory: false });
    await opened.promise;
    const args = requests[1]!.args;
    const descriptor = args[args.indexOf("--env") + 1]!.split("=").slice(1).join("=");
    expect(existsSync(descriptor)).toBe(true);
    expect(args).toContain("--no-focus"); expect(args[args.indexOf("--target-pane") + 1]).toBe("caller");
    expect(requests.every(r => r.env.HERDR_SOCKET_PATH === presence.socketPath && !r.env.HERDR_SESSION && r.cwd === root)).toBe(true);
    controller.revoke(); session.revoke();
    let joined = false;
    closing = session.close().then(() => { joined = true; });
    expect(joined).toBe(false); expect(existsSync(descriptor)).toBe(true);
    releaseOpen.resolve();
    await launch; await closing;
    expect(requests.at(-1)!.args).toEqual(["plugin", "pane", "close", "owned-panel"]);
    expect(existsSync(descriptor)).toBe(false);
    // A fresh controller can still progress. Repeat focuses only its returned ID.
    const fresh = createAgentController(owner, () => owner);
    session = createPaneSession(fresh, presence, root, env);
    expect(await session.launch({ control: false, rawHistory: false })).toBe("owned-panel");
    await expect(session.launch({ control: true, rawHistory: false })).rejects.toThrow("explicitly close");
    launch = session.launch({ control: false, rawHistory: false });
    await focused.promise;
    let focusJoined = false;
    closing = session.close().then(() => { focusJoined = true; });
    expect(focusJoined).toBe(false);
    releaseFocus.resolve();
    expect(await launch).toBe("owned-panel"); await closing;
    expect(requests.at(-2)!.args).toEqual(["plugin", "pane", "focus", "owned-panel"]);
    expect(requests.at(-1)!.args).toEqual(["plugin", "pane", "close", "owned-panel"]);
    fresh.revoke(); await fresh.settle();
  } finally {
    releaseOpen.resolve(); releaseFocus.resolve();
    await Promise.allSettled([launch, closing]);
    session.revoke(); await session.close(); controller.revoke(); await controller.settle();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered production command keeps all pane flags, close and caller exclusions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-pane-command-"));
  const cli = path.join(root, "herdr"), log = path.join(root, "requests.jsonl");
  writeFileSync(cli, `#!${process.execPath}
import {appendFileSync} from "node:fs";
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");
console.log(JSON.stringify({result:args[2]==="open"?{plugin_pane:{pane:{pane_id:"command-owned"}}}:{}}));
`, { mode: 0o700 });
  const keys = ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PITAKO_INSTANCE_ID", "PI_CODING_AGENT_DIR", "PATH"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const grants: unknown[] = [], notices: string[] = [];
  const original = paneSessions.createPaneSession;
  const factory = spyOn(paneSessions, "createPaneSession").mockImplementation((...args) => {
    const session = original(...args);
    return { ...session, launch(requested) { grants.push({ ...requested }); return session.launch(requested); } };
  });
  const handlers = new Map<string, Function>(), commands = new Map<string, Function>();
  const pi = {
    registerFlag() {}, registerTool() {},
    registerCommand(name: string, spec: { handler: Function }) { commands.set(name, spec.handler); },
    on(name: string, handler: Function) { handlers.set(name, handler); },
    getFlag() {}, getAllTools() { return [{ name: "read" }]; }, getActiveTools() { return ["read"]; },
    setActiveTools() {}, getSessionName() { return "command fixture"; }, setSessionName() {}, sendMessage() {},
  };
  const ctx = { hasUI: true, mode: "tui", cwd: root,
    sessionManager: { getSessionId: () => "command-owner", getEntries: () => [] },
    ui: { notify(text: string) { notices.push(text); }, setStatus() {} } };
  const requests = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
  try {
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    process.env.HERDR_BIN_PATH = cli;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = path.join(root, "herdr.sock");
    process.env.HERDR_PANE_ID = "command-caller";
    delete process.env.PITAKO_INSTANCE_ID;
    pitako(pi as never);
    await handlers.get("session_start")!({}, ctx);
    const command = commands.get("pitako")!;
    for (const [tail, expected] of [
      ["", { control: false, rawHistory: false }],
      [" --control", { control: true, rawHistory: false }],
      [" --raw-history", { control: false, rawHistory: true }],
      [" --raw-history --control", { control: true, rawHistory: true }],
    ] as const) {
      await command("agents pane" + tail, ctx);
      expect(grants.at(-1)).toEqual(expected);
      const open = requests().at(-1)!;
      expect(open.slice(0, 3)).toEqual(["plugin", "pane", "open"]);
      const descriptor = open[open.indexOf("--env") + 1]!.split("=").slice(1).join("=");
      expect(existsSync(descriptor)).toBe(true);
      await command("agents pane" + tail, ctx);
      expect(requests().at(-1)).toEqual(["plugin", "pane", "focus", "command-owned"]);
      await command("agents pane close", ctx);
      expect(requests().at(-1)).toEqual(["plugin", "pane", "close", "command-owned"]);
      expect(existsSync(descriptor)).toBe(false);
    }
    const effects = requests().length, admitted = grants.length;
    for (const tail of ["--invalid", "--control --control", "--raw-history --raw-history", "close --control", "--control close"]) {
      await command("agents pane " + tail, ctx);
      expect(notices.at(-1)).toContain("Use /pitako agents pane");
    }
    await command("agents pane --control", { ...ctx, mode: "rpc" });
    expect(notices.at(-1)).toContain("interactive foreground");
    await expect(command("agents pane --control", { ...ctx, hasUI: false })).rejects.toThrow("interactive foreground");
    registerExecution({ sessionId: "command-owner", instanceId: "command-child", roleId: "developer" });
    await command("agents pane --control", ctx);
    expect(notices.at(-1)).toContain("AgentInstance");
    unregisterExecution("command-owner");
    expect(requests()).toHaveLength(effects);
    expect(grants).toHaveLength(admitted);
    await command("agents pane --control", ctx);
    const beforeChangedFlags = requests().length;
    await command("agents pane --raw-history", ctx);
    expect(notices.at(-1)).toContain("explicitly close");
    expect(requests()).toHaveLength(beforeChangedFlags);
    await command("agents pane close", ctx);
    await command("agents pane --raw-history", ctx); // independent valid progress after rejection
    expect(requests().at(-1)!.slice(0, 3)).toEqual(["plugin", "pane", "open"]);
    await command("agents pane close", ctx);
  } finally {
    unregisterExecution("command-owner");
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    factory.mockRestore();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
