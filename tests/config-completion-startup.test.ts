import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pitako from "../extensions/index.ts";
import { agentScope } from "../extensions/agent/scope.ts";
import { registerExecution, unregisterExecution } from "../extensions/execution-identity.ts";
import { loadPitakoConfig } from "../extensions/roles/load.ts";
import { prepareRuntime, packageRoot } from "../extensions/stack.ts";
import * as history from "../extensions/agent/history-retention.ts";
import { privateStartupConfig } from "./fixtures/config-completion.ts";

let owned: ReturnType<typeof privateStartupConfig>;
const shutdowns: Array<() => Promise<void>> = [];
beforeEach(() => { owned = privateStartupConfig(); });
afterEach(async () => {
  for (const close of shutdowns.splice(0)) await close();
  owned.close();
});

function harness(sessionId: string | undefined = "config-principal") {
  const hooks = new Map<string, Function[]>(), commands = new Map<string, Function>();
  const messages: string[] = [], profiles: string[][] = [];
  const ctx = { cwd: owned.root, hasUI: true,
    sessionManager: { getSessionId: (): string | undefined => sessionId, getEntries: () => [] },
    ui: { notify(message: string) { messages.push(message); }, setStatus() {} } };
  pitako({
    registerFlag() {}, registerTool() {}, getFlag() {},
    registerCommand(name: string, command: { handler: Function }) { commands.set(name, command.handler); },
    on(event: string, hook: Function) { hooks.set(event, [...hooks.get(event) ?? [], hook]); },
    getAllTools: () => [], getActiveTools: () => [], setActiveTools: (tools: string[]) => { profiles.push(tools); },
    getSessionName() {}, setSessionName() {},
  } as never);
  const emit = async (event: string) => { for (const hook of hooks.get(event) ?? []) await hook({}, ctx); };
  shutdowns.push(() => emit("session_shutdown"));
  return { emit, ctx, messages, profiles, commands };
}
const file = () => path.join(owned.root, "pitako/config.toml");

test("principal completion precedes history/profile publication; repeated startup leaves bytes alone", async () => {
  const sample = harness();
  const prune = history.pruneWorkerHistory;
  const observe = spyOn(history, "pruneWorkerHistory").mockImplementation((...args) => {
    expect(existsSync(file())).toBe(true);
    expect(sample.profiles).toHaveLength(0);
    return prune(...args);
  });
  try {
    await sample.emit("session_start");
    expect(observe).toHaveBeenCalledTimes(1);
  } finally { observe.mockRestore(); }
  const source = readFileSync(file(), "utf8");
  expect(sample.profiles.length).toBeGreaterThan(0);
  await sample.emit("session_start");
  expect(readFileSync(file(), "utf8")).toBe(source);
});

for (const kind of ["scope", "environment", "registered", "missing-session"] as const)
  test(`${kind} worker/nonprincipal startup never creates config`, async () => {
    const sample = harness(kind === "missing-session" ? undefined : `worker-${kind}`);
    // Explicit undefined would otherwise select harness's default argument.
    if (kind === "missing-session") sample.ctx.sessionManager.getSessionId = () => undefined;
    const previous = process.env.PITAKO_INSTANCE_ID;
    if (kind === "registered") registerExecution({ instanceId: "worker", roleId: "developer", sessionId: `worker-${kind}` });
    if (kind === "environment") process.env.PITAKO_INSTANCE_ID = "worker";
    try {
      if (kind === "scope") await agentScope.run({ instanceId: "worker", roleId: "developer" }, () => sample.emit("session_start"));
      else await sample.emit("session_start");
      expect(existsSync(file())).toBe(false);
      await sample.emit("session_shutdown");
    } finally {
      if (kind === "registered") unregisterExecution(`worker-${kind}`);
      if (previous === undefined) delete process.env.PITAKO_INSTANCE_ID; else process.env.PITAKO_INSTANCE_ID = previous;
    }
  });

test("import, registration, runtime preparation, readers and inspection commands do not write config", async () => {
  const modulePath = "../extensions/index.ts";
  await import(modulePath);
  const sample = harness();
  prepareRuntime(packageRoot());
  loadPitakoConfig({ cwd: owned.root });
  for (const command of ["roles", "policies"]) await sample.commands.get("pitako")!(command, sample.ctx);
  expect(existsSync(file())).toBe(false);
  expect(readdirSync(owned.root)).toEqual([]);
});

test("invalid config startup rejects outside the history warning catch, before publication", async () => {
  mkdirSync(path.dirname(file()), { recursive: true });
  writeFileSync(file(), "[review]\ncandidates=[]\n");
  const sample = harness();
  await expect(sample.emit("session_start")).rejects.toThrow("expected nonempty candidates");
  expect(sample.messages.some(x => x.includes("Worker history maintenance failed"))).toBe(false);
  expect(sample.profiles).toEqual([]);
  expect(readFileSync(file(), "utf8")).toBe("[review]\ncandidates=[]\n");
});

test("contention warns but preserves valid independent startup", async () => {
  mkdirSync(path.dirname(file()), { recursive: true }); writeFileSync(file(), "# mine\n");
  writeFileSync(`${file()}.pitako-completion.lock`, "other");
  const sample = harness();
  await sample.emit("session_start");
  expect(sample.messages).toContainEqual(expect.stringContaining("contention or concurrent edit"));
  expect(sample.profiles.length).toBeGreaterThan(0);
  expect(readFileSync(file(), "utf8")).toBe("# mine\n");
});
