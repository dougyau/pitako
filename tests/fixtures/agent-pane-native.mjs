import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Socket } from "node:net";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installLocalProvider } from "../local-provider.ts";
import { createPiExecutor } from "../../extensions/agent/pi.ts";
import { createAgentController } from "../../extensions/agent/controller.ts";
import { bindBackgroundOwner, cancelWorker, clearBackgroundOwner, spawnBackground, resolveLiveTarget } from "../../extensions/agent/background.ts";
import { createAgentBroker } from "../../extensions/herdr/agents-ui/broker.ts";
import { connectAgentPane } from "../../extensions/herdr/agents-ui/client.ts";
import { readHerdrPresence } from "../../extensions/herdr/presence.ts";
import { AgentScreen } from "../../extensions/agent/screen.ts";
import pitako from "../../extensions/index.ts";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const root = process.argv[2];
assert(root && path.isAbsolute(root));
const host = process.argv.includes("--host");
const held = deferred(), release = deferred(), replyHeld = deferred();
const attempts = [], receipts = [];
let worker, controller, broker, client, coordinator, screen;
globalThis.__paneFixture = { held, release };
let restoreWrite = () => {};
const save = (name, value) => writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
try {
  mkdirSync(root, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(path.join(root, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const config = path.join(root, "pitako/config.toml");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, '[model_policies.researcher.primary]\nmodel = "pitako-local/fixture"\nreasoning = "off"\n');
  writeFileSync(path.join(root, "sample.txt"), "real offline worker context\n");
  const provider = await installLocalProvider({ agentDir: root,
    toolForPrompt: (_prompt, completed) => completed === 0 ? { name: "read", arguments: { path: "sample.txt" } } : undefined,
    responseForPrompt: prompt => "candidate: " + prompt });
  writeFileSync(path.join(root, "extensions/pane-hooks.js"), `export default function(pi) {
    pi.on("tool_call", async event => {
      if (event.toolName === "read") { globalThis.__paneFixture.held.resolve(); await globalThis.__paneFixture.release.promise; }
    });
  }`);
  const notices = [];
  if (host) {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
      noContextFiles: true, noSkills: true, noThemes: true, extensionFactories: [pitako, pi => {
        pi.registerCommand("t4-stop", { description: "Settle private offline worker", handler: async () => {
          release.resolve(); await Promise.allSettled(attempts); save("worker-settled.json", { attempts: attempts.length });
        } });
      }] });
    await loader.reload();
    const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
    coordinator = (await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager,
      modelRuntime: runtime, sessionManager: SessionManager.create(root, path.join(root, "foreground-native")) })).session;
    await coordinator.bindExtensions({ mode: "tui",
      uiContext: { ...coordinator.extensionRunner.getUIContext(), notify(text, kind) { notices.push({ text, kind }); } },
      onError: error => save("command-error.json", error) });
  }
  const token = Symbol("pane fixture owner"), owner = { sessionId: coordinator?.sessionId ?? "pane-coordinator", token };
  bindBackgroundOwner({ token, isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} });
  controller = createAgentController(owner, () => owner);
  const driver = createPiExecutor();
  worker = await spawnBackground({ roleId: "researcher", task: "Original packed pane WorkBrief", cwd: root,
    historyOrigin: { source: "agent_spawn", coordinatorSessionId: owner.sessionId, workbrief: "Original packed pane WorkBrief" },
    load: { userConfigPath: config, env: { PI_CODING_AGENT_DIR: root } },
    executor: { capturesHistory: driver.capturesHistory, start(input) {
      const work = driver.start(input); attempts.push(work); return work;
    } } });
  await Promise.race([held.promise, attempts[0].then(result => { throw Error("Worker settled before hold: " + JSON.stringify(result)); })]);
  if (host) {
    save("pi-ready.json", { presence: readHerdrPresence(), sessionId: coordinator.sessionId, worker,
      native: resolveLiveTarget({ kind: "background", instanceId: worker.instanceId }, owner.sessionId).observe() });
    // Shell stdin is an owned PTY. Each line is dispatched through Pi's actual registered command path.
    let text = "", sequence = 0;
    for await (const chunk of process.stdin) {
      text += chunk.toString();
      let end;
      while ((end = text.indexOf("\n")) >= 0) {
        const command = text.slice(0, end).trim(); text = text.slice(end + 1);
        if (command === "/t4-exit") break;
        await coordinator.prompt(command);
        save(`command-${++sequence}.json`, { command, notices: notices.splice(0) });
      }
      if (chunk.toString().includes("/t4-exit")) break;
    }
    save("host-observed.json", { worker, trace: provider.trace, paidCalls: 0 });
  } else {
    broker = await createAgentBroker(controller, { control: true, rawHistory: true }, path.dirname(root));
    client = await connectAgentPane(broker.descriptorPath);
    const detail = await client.detail(worker.instanceId), selection = detail.controls.selection;
    assert(selection);
    const positive = await client.input(selection, { intent: "query", text: "native positive query" });
    assert.equal(positive.status, "queued");
    let painted;
    const snapshots = [];
    screen = new AgentScreen(client, () => painted?.(), () => {}, () => 50, worker.instanceId);
    const show = (label, action, expected) => new Promise(resolve => {
      painted = () => {
        const lines = screen.render(180), rendered = lines.join("\n");
        if ((!expected || rendered.includes(expected)) && !rendered.includes("Outstanding work")) {
          snapshots.push({ label, lines }); painted = undefined; resolve(rendered);
        }
      };
      action(); painted?.();
    });
    await show("live", () => {}, "Original packed pane WorkBrief");
    screen.handleInput("s");
    // Child-owned clock: the form can outlive the detail refresh window without sleeping.
    const clock = performance.now.bind(performance);
    performance.now = () => clock() + 2000;
    // Drop only the actual production server's second queued response, after native
    // admission. Everything else uses the real Unix socket, broker and SDK producer.
    // The isolated child owns this patch; no controller/live acceptance is mocked.
    const write = Socket.prototype.write;
    let admitted, withheld;
    Socket.prototype.write = function(chunk, ...args) {
      let reply;
      try { reply = JSON.parse(chunk.toString()); } catch {}
      if (reply?.result?.status === "queued" && reply.result.interactionId !== positive.interactionId) {
        withheld = reply;
        admitted = structuredClone(resolveLiveTarget(selection.target, owner.sessionId).observe());
        replyHeld.resolve();
        this.destroy();
        const callback = args.at(-1);
        if (typeof callback === "function") queueMicrotask(() => callback(Error("Fixture dropped admitted acknowledgment")));
        return false;
      }
      return write.call(this, chunk, ...args);
    };
    restoreWrite = () => { Socket.prototype.write = write; };
    screen.handleInput("lost-ack-native correction");
    const unknown = show("post-error-refresh", () => screen.handleInput("\r"));
    await replyHeld.promise; // native queued marker and actual broker reply exist BEFORE EOF
    assert.equal(admitted.interactions.at(-1).status, "queued");
    assert.equal(admitted.interactions.length, 2);
    assert.equal(withheld.result.interactionId, admitted.interactions.at(-1).interactionId);
    const lostResponse = await unknown;
    restoreWrite();
    assert(lostResponse.includes("Unknown mutation outcome"));
    assert(lostResponse.includes("STALE") && lostResponse.includes("controls disabled"));
    assert(client.connection().includes("STALE"));
    performance.now = () => clock() + 4000;
    const refreshed = await show("visible-refresh", () => screen.handleInput("r"));
    assert(refreshed.includes("explicit reconnect required"));
    assert(refreshed.includes("Unknown mutation outcome") && refreshed.includes("do not replay"));
    await controller.settle();
    const reconnected = await show("explicit-reconnect", () => screen.handleInput("R"), "Reconnected and reobserved");
    performance.now = clock;
    assert(reconnected.includes("Unknown mutation outcome") && !reconnected.includes("STALE"));
    const reobserved = await client.detail(worker.instanceId);
    assert.equal(reobserved.controls.selection.sessionId, selection.sessionId);
    assert.equal(reobserved.observation.interactions.length, 2); // no reconnect replay
    const queuedLost = reobserved.observation.interactions.at(-1);
    assert.equal(queuedLost.status, "queued");
    assert.equal(queuedLost.interactionId, admitted.interactions.at(-1).interactionId);
    release.resolve();
    await Promise.allSettled(attempts);
    const local = controller.openView();
    local.acknowledge("history");
    const fragments = [];
    let cursor;
    do {
      const page = await local.history({ action: "read", historyId: selection.historyId, cursor, limit: 20 }, { instanceId: worker.instanceId });
      fragments.push(...page.items.map(item => Buffer.from(item.data, "base64"))); cursor = page.cursor ?? undefined;
    } while (cursor);
    await local.close();
    const native = Buffer.concat(fragments).toString();
    const entries = native.trim().split("\n").map(JSON.parse);
    const markers = entries.filter(e => e.type === "custom" && e.customType === "pitako.worker-history" && e.data.event === "interaction");
    for (const receipt of [positive, queuedLost]) {
      assert(markers.some(e => e.data.data.interactionId === receipt.interactionId && e.data.data.status === "pending"));
      assert(markers.some(e => e.data.data.interactionId === receipt.interactionId && e.data.data.status === "queued"));
      assert(entries.some(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e).includes(receipt.interactionId)));
      assert(provider.trace.some(row => row.prompt.includes(receipt.interactionId)));
    }
    const result = { positive, admitted, withheld, lostResponse, snapshots, reobserved, queuedLost, markers, native, trace: provider.trace,
      fault: "Isolated child dropped actual queued server response before socket write; server socket closed only after production native admission.",
      paidCalls: 0, joinedAttempts: attempts.length, uncertainty: "At lost acknowledgment client could not infer delivery; later native evidence observed delivery, not adequacy." };
    save("native-ipc.json", result);
    controller.revoke(); broker.revoke();
    await client.disconnect();
    await assert.rejects(client.reconnect());
    console.log(JSON.stringify({ ...result, noReplay: true }));
  }
} finally {
  restoreWrite(); release.resolve();
  if (worker) { try { cancelWorker(worker.instanceId); } catch {} }
  await Promise.allSettled(attempts);
  await screen?.finish();
  if (coordinator) await coordinator.prompt("/pitako agents pane close");
  controller?.revoke();
  await controller?.settle();
  await client?.close();
  await broker?.close();
  await coordinator?.dispose();
  clearBackgroundOwner();
  delete globalThis.__paneFixture; delete globalThis.__pitako_local;
  save("closure.json", { joinedAttempts: attempts.length, workerSettled: true, brokerClosed: true, paidCalls: 0 });
}
