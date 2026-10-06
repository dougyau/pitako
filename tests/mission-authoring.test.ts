import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerMissionExtension } from "../extensions/mission/index.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import { authoringProposal, authoringSource } from "./mission-authoring-fixture.ts";
import { createMissionFixture } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { packageRoot } from "../extensions/stack.ts";

const oldDir = process.env.PI_CODING_AGENT_DIR, bases: string[] = [];
afterEach(() => {
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  delete (globalThis as Record<string, unknown>).__pitako_mission_local;
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});
function fixture() {
  const f = createMissionFixture("authoring-"); bases.push(f.base);
  rmSync(f.definitionFile); writeFileSync(f.planFile, authoringSource);
  mkdirSync(path.join(f.stateDir, "pitako"), { recursive: true });
  writeFileSync(path.join(f.stateDir, "pitako/config.toml"), '[model_policies.developer]\nprimary={model="test/developer",reasoning="high",fast=false}\n[model_policies.reviewer]\nprimary={model="test/reviewer",reasoning="high",fast=false}\n');
  process.env.PI_CODING_AGENT_DIR = f.stateDir;
  return f;
}
function contextFromMessage(message: string) {
  return JSON.parse(message.split("\n")[1]!);
}
function host(f: ReturnType<typeof fixture>) {
  const handlers = new Map<string, Function[]>(), tools = new Map<string, any>(), messages: string[] = [], notices: string[] = [];
  let command!: Function, confirm: (title: string, text: string) => Promise<boolean> = async () => true;
  registerMissionExtension({
    on: (name: string, fn: Function) => handlers.set(name, [...handlers.get(name) ?? [], fn]),
    registerCommand: (_name: string, value: { handler: Function }) => { command = value.handler; },
    registerTool: (value: any) => tools.set(value.name, value),
    sendUserMessage: (text: string, options: unknown) => { expect(options).toEqual({ deliverAs: "followUp" }); messages.push(text); },
  } as any);
  let session = "principal";
  const ctx = { mode: "tui", hasUI: true, cwd: f.root, sessionManager: { getSessionId: () => session },
    ui: { notify: (text: string) => notices.push(text), confirm: (title: string, text: string) => confirm(title, text) } };
  return { ctx, messages, notices, tools, command: (text: string) => command(text, ctx), session: (id: string) => { session = id; },
    confirm: (fn: typeof confirm) => { confirm = fn; },
    emit: async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({ reason: "reload" }, ctx); },
    submit: (params: unknown) => tools.get("mission_prepare").execute("author", params, undefined, undefined, ctx) };
}

test.each(["request", "session", "root", "source", "config", "omission", "replace", "dismiss", "shutdown", "switch",
  "reload", "source-wait", "config-wait", "source-identity"] as const)(
  "assisted preparation rejects %s without setup/start/worker effects", async (scenario) => {
    const f = fixture(), h = host(f);
    await h.command("prepare durable-fixture");
    expect(h.messages).toHaveLength(1);
    const context = contextFromMessage(h.messages[0]!);
    const params = { id: "durable-fixture", requestId: context.requestId, proposal: authoringProposal(context) };
    if (scenario === "request") params.requestId = "wrong";
    if (scenario === "session") h.session("other");
    if (scenario === "root") h.ctx.cwd = f.base;
    if (scenario === "source") writeFileSync(f.planFile, authoringSource + "\nchanged");
    if (scenario === "config") writeFileSync(path.join(f.stateDir, "pitako/config.toml"), '[model_policies.developer]\nprimary="test/changed"\n');
    if (scenario === "omission") params.proposal.mappings.pop();
    let admissionPrompts = 0;
    h.confirm(async (title) => {
      if (title.startsWith("Confirm exact")) {
        admissionPrompts++;
        if (scenario === "shutdown") await h.emit("session_shutdown");
        if (scenario === "switch") await h.emit("session_before_switch");
        if (scenario === "reload") await h.emit("session_start");
        if (scenario === "source-wait") writeFileSync(f.planFile, authoringSource + "\nchanged");
        if (scenario === "source-identity") { writeFileSync(`${f.planFile}.new`, authoringSource); renameSync(`${f.planFile}.new`, f.planFile); }
        if (scenario === "config-wait") writeFileSync(path.join(f.stateDir, "pitako/config.toml"), "");
        if (scenario === "replace") {
          h.confirm(async () => false);
          await h.submit({ ...params, proposal: { definition: params.proposal.definition, mappings: [] } });
        }
        if (scenario === "dismiss") return undefined as unknown as boolean;
      }
      return true;
    });
    try {
      if (!["dismiss", "omission"].includes(scenario))
        await expect(h.submit(params)).rejects.toThrow();
      else {
        const result = JSON.parse((await h.submit(params)).content[0].text);
        expect(result.state).toBe(scenario === "dismiss" ? "dismissed" : "needs-input");
      }
      expect(admissionPrompts).toBe(["replace", "dismiss", "shutdown", "switch", "reload", "source-wait", "config-wait", "source-identity"].includes(scenario) ? 1 : 0);
      if (scenario === "dismiss") await expect(h.submit(params)).rejects.toThrow("current host request");
      expect(existsSync(f.dbPath)).toBe(false);
      expect(existsSync(path.join(f.stateDir, "pitako/console"))).toBe(false);
    } finally { await h.emit("session_shutdown"); }
  });

test("authority refusal is no grant; grouped source interpretation is explicitly bound and retained", async () => {
  const f = fixture(), h = host(f);
  writeFileSync(f.planFile, authoringSource + "\n## Ambiguous notes\n- Preserve diagnostics unless incompatible.\n");
  try {
    await h.command("prepare durable-fixture");
    let context = contextFromMessage(h.messages.at(-1)!);
    expect(context.inventory.unresolved.length).toBeGreaterThan(0);
    const params = () => ({ id: "durable-fixture", requestId: context.requestId, proposal: authoringProposal(context),
      interpretations: context.inventory.unresolved.map(({ id }: { id: string }) => ({ sourceId: id, disposition: "context" })) });
    h.confirm(async (title, text) => {
      expect(title).toContain("Preparation questions");
      expect(text).toContain("Preserve diagnostics unless incompatible");
      expect(text).toContain("preparation-interpretation");
      expect(text).toContain("providerRequests");
      return false;
    });
    expect(JSON.parse((await h.submit(params())).content[0].text).state).toBe("dismissed");
    expect(existsSync(f.dbPath)).toBe(false);
    await h.command("prepare durable-fixture");
    context = contextFromMessage(h.messages.at(-1)!);
    const prompts: string[] = [];
    h.confirm(async (_title, text) => { prompts.push(text); return true; });
    const diagnostic = JSON.parse((await h.submit(params())).content[0].text);
    expect(diagnostic.authority).toBe("proposal-only");
    expect(diagnostic.operatorReceipt).toBeUndefined();
    const db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
    try {
      expect(db.findManagedMission(f.root)?.prepared?.answers).toHaveLength(context.inventory.unresolved.length);
      const preview = JSON.parse(prompts.at(-1)!);
      expect(preview.prepared.definition.authority.rolePolicies.developer.primaryTarget).toEqual(context.roles.developer.primary);
      expect(preview.prepared.originalSource).toContain("Preserve diagnostics unless incompatible");
    } finally { db.close(); }
  } finally { await h.emit("session_shutdown"); }
});

test("supported busy SDK command → queued foreground provider → author tool → native decisions → immutable prepared reload", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = await installMissionLocalProvider({ agentDir: f.stateDir,
    responseGate: async (prompt, signal) => {
      if (prompt !== "Unrelated principal work") return;
      entered(); await gate;
      expect(signal?.aborted).not.toBe(true);
    },
    toolForPrompt: (prompt) => {
      if (!prompt.startsWith("Mission preparation request")) return;
      const context = contextFromMessage(prompt);
      return { name: "mission_prepare", arguments: { id: "durable-fixture", requestId: context.requestId,
        proposal: authoringProposal(context) } };
    } });
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.stateDir, extensionFactories: [registerMissionExtension],
    noSkills: true, noPromptTemplates: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: f.root, agentDir: f.stateDir, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(f.root), noTools: "builtin" });
  const previews: string[] = [], notices: string[] = [];
  const ui = { notify: (text: string) => notices.push(text), confirm: async (_title: string, text: string) => {
    previews.push(text); return true;
  } };
  try {
    await session.bindExtensions({ mode: "tui", uiContext: ui as any });
    await session.setModel(session.modelRuntime.getModel(provider.provider, provider.model)!);
    const ordinary = session.prompt("Unrelated principal work");
    await waiting;
    const started = performance.now();
    await session.prompt("/mission prepare durable-fixture");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(provider.trace.some(({ prompt }) => prompt.startsWith("Mission preparation request"))).toBe(false);
    expect(existsSync(f.dbPath)).toBe(false);
    release(); await ordinary;
    for (let i = 0; i < 500 && !notices.some((text) => text.startsWith("Prepared ")); i++) await Bun.sleep(10);
    await session.waitForIdle();
    if (!provider.trace.length) throw new Error(`foreground message not dispatched: ${JSON.stringify(notices)}`);
    expect(provider.trace.some(({ prompt }) => prompt.startsWith("Mission preparation request"))).toBe(true);
    expect(previews).toHaveLength(2);
    expect(previews[0]).toContain("preparation-authority");
    expect(previews[1]).toContain("preparedHash");
    const db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
    try {
      const mission = db.findManagedMission(f.root)!;
      expect(mission.state).toBe("prepared");
      expect(mission.prepared?.originalSource).toBe(authoringSource);
      expect(mission.events.some(({ kind }) => /setup|attempt|activated|provider/.test(kind))).toBe(false);
      expect(existsSync(f.definitionFile)).toBe(false);
      await session.reload();
      await session.prompt("/mission status");
      expect(db.findManagedMission(f.root)?.snapshot.preparedHash).toBe(mission.snapshot.preparedHash);
      expect(db.ownershipIdentity.claimId).toBe("");
      expect(notices.some((text) => text.includes('"state":"prepared"'))).toBe(true);
      if (process.env.MISSION_T3_ARTIFACT_DIR) {
        mkdirSync(process.env.MISSION_T3_ARTIFACT_DIR, { recursive: true });
        writeFileSync(path.join(process.env.MISSION_T3_ARTIFACT_DIR, "sdk-authoring.json"), JSON.stringify({
          fixtureAuthority: true, userApproval: false, provider: provider.provider, model: provider.model,
          mission, previews: previews.map((text) => JSON.parse(text)), notices, trace: provider.trace,
        }, null, 2));
      }
    } finally { db.close(); }
  } finally { release(); await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
}, 60000);

test("supported SDK reload invalidates a pending exact confirmation callback before any admission", async () => {
  const f = fixture();
  const provider = await installMissionLocalProvider({ agentDir: f.stateDir, toolForPrompt: (prompt) => {
    if (!prompt.startsWith("Mission preparation request")) return;
    const context = contextFromMessage(prompt);
    return { name: "mission_prepare", arguments: { id: "durable-fixture", requestId: context.requestId,
      proposal: authoringProposal(context) } };
  } });
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.stateDir,
    extensionFactories: [registerMissionExtension], noSkills: true, noPromptTemplates: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: f.root, agentDir: f.stateDir, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(f.root), noTools: "builtin" });
  let answer!: (accepted: boolean) => void;
  try {
    await session.bindExtensions({ mode: "tui", uiContext: {
      notify: () => {}, confirm: async (title: string) => title.startsWith("Confirm exact")
        ? new Promise<boolean>((resolve) => { answer = resolve; }) : true,
    } as any });
    await session.setModel(session.modelRuntime.getModel(provider.provider, provider.model)!);
    await session.prompt("/mission prepare durable-fixture");
    for (let i = 0; i < 500 && !answer; i++) await Bun.sleep(10);
    expect(answer).toBeFunction();
    await session.reload();
    answer(true);
    await session.waitForIdle();
    expect(existsSync(f.dbPath)).toBe(false);
    expect(provider.trace.some(({ prompt }) => prompt.startsWith("Mission preparation request"))).toBe(true);
  } finally {
    answer?.(false);
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
  }
}, 60000);

test("actual Pi PTY foreground author tool receives native questions and exact prepared confirmation", async () => {
  const f = fixture(), extension = path.join(f.stateDir, "authoring.ts");
  writeFileSync(extension, `
import { registerMissionExtension } from ${JSON.stringify(path.join(packageRoot(), "extensions/mission/index.ts"))};
import { authoringProposal } from ${JSON.stringify(path.join(packageRoot(), "tests/mission-authoring-fixture.ts"))};
import { createAssistantMessageEventStream } from ${JSON.stringify(path.join(packageRoot(), "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"))};
export default function(pi) {
 registerMissionExtension(pi);
 pi.registerProvider("authoring-offline", { api:"openai-completions", apiKey:"fixture", baseUrl:"http://127.0.0.1",
  models:[{id:"fixture",name:"Offline authoring wiring",reasoning:false,input:["text"],contextWindow:200000,maxTokens:8192,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
  streamSimple(model, context) {
    const prompt=[...context.messages].reverse().find(m=>m.role==="user")?.content.filter(p=>p.type==="text").map(p=>p.text).join("\\n") ?? "";
    const host=prompt.startsWith("Mission preparation request") ? JSON.parse(prompt.split("\\n")[1]) : undefined;
    const tool=host && context.messages.at(-1)?.role==="user";
    const message={role:"assistant",api:"openai-completions",provider:model.provider,model:model.id,timestamp:Date.now(),
      usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
      stopReason:tool?"toolUse":"stop",
      content:tool?[{type:"toolCall",id:"author-call",name:"mission_prepare",arguments:{id:"durable-fixture",requestId:host.requestId,proposal:authoringProposal(host)}}]:[{type:"text",text:"Offline wiring; no product execution."}]};
    const stream=createAssistantMessageEventStream();
    queueMicrotask(()=>{stream.push({type:"done",reason:message.stopReason,message});stream.end(message)});
    return stream;
  }
 });
}`);
  const child = spawn("script", ["-q", "-e", "-c",
    `${JSON.stringify(path.join(packageRoot(), "node_modules/.bin/pi"))} --no-extensions --no-session --approve -e ${JSON.stringify(extension)} --provider authoring-offline --model fixture`,
    "/dev/null"], { cwd: f.root, detached: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color" } });
  let output = "";
  child.stdout.on("data", (part) => { output += part.toString(); });
  child.stderr.on("data", (part) => { output += part.toString(); });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 1500; i++) {
      if (predicate()) return;
      if (child.exitCode !== null) throw new Error(`PTY exited ${child.exitCode}: ${output.slice(-4000)}`);
      await Bun.sleep(20);
    }
    throw new Error(`PTY timeout: ${output.slice(-4000)}`);
  };
  try {
    await wait(() => output.includes("Pi") || output.includes("pi v"));
    child.stdin.write("/mission prepare durable-fixture\r");
    await wait(() => output.includes("Preparation questions"));
    expect(existsSync(f.dbPath)).toBe(false);
    child.stdin.write("\r");
    await wait(() => output.includes("Confirm exact prepared mission"));
    expect(existsSync(f.dbPath)).toBe(false);
    child.stdin.write("\r");
    await wait(() => output.includes("Prepared "));
    const db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
    try {
      const mission = db.findManagedMission(f.root)!;
      expect(mission.state).toBe("prepared");
      expect(mission.events[0]?.payload.operatorReceipt).toMatchObject({ source: "native-confirmation" });
      expect(mission.events.some(({ kind }) => /activated|attempt|setup/.test(kind))).toBe(false);
      expect(mission.prepared?.inventory.criteria).toHaveLength(3);
      if (process.env.MISSION_T3_ARTIFACT_DIR) {
        writeFileSync(path.join(process.env.MISSION_T3_ARTIFACT_DIR, "pty-authoring.json"), JSON.stringify({
          fixtureAuthority: true, userApproval: false, provider: "authoring-offline/fixture", mission,
        }, null, 2));
      }
    } finally { db.close(); }
    child.stdin.write("/quit\r");
    await wait(() => child.exitCode !== null);
    expect(child.exitCode).toBe(0);
  } finally {
    if (child.exitCode === null) {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
      await Promise.race([new Promise((resolve) => child.once("close", resolve)), Bun.sleep(5000)]);
      if (child.exitCode === null) try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
    if (process.env.MISSION_T3_ARTIFACT_DIR)
      writeFileSync(path.join(process.env.MISSION_T3_ARTIFACT_DIR, "pty-output.txt"), output);
  }
}, 60000);
