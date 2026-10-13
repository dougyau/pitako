import { stubExternalFactories } from "./fixtures/offline.ts";
stubExternalFactories();
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as net from "node:net";
import { createAgentController } from "../extensions/agent/controller.ts";
import { bindBackgroundOwner, clearBackgroundOwner, spawnBackground, revokeBackgroundOwner } from "../extensions/agent/background.ts";
import { createLiveHandle } from "../extensions/agent/live.ts";
import { clearObservations, listObservations, terminalActivityKey, readTerminalActivity } from "../extensions/agent/observe.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { connect } from "../extensions/agent/bridge/client.js";
import { isReply, replyBytes, type WorkerReadReference, type WorkerReadCursor } from "../extensions/agent/bridge/protocol.js";
import type { Attempt, AttemptExecutor, AttemptSession } from "../extensions/agent/run.ts";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";

const fixture = agentFixtureOwnership();
afterEach(() => { fixture.requireReleasedFixture(); clearBackgroundOwner(); clearObservations(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { resolve, promise };
}
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-bridge-read-"));
  fixture.directories.push(root);
  const config = path.join(root, "config.toml");
  writeFileSync(config, `[model_policies.researcher.primary]
model = "fixture/selected"
reasoning = "off"
[[model_policies.researcher.fallbacks]]
model = "fixture/fallback"
reasoning = "off"
`);
  const owner = { sessionId: '"\\'.repeat(400), token: Symbol() }, settled = deferred<void>();
  bindBackgroundOwner({ token: owner.token, isIdle() { settled.resolve(); return true; },
    hasUI: false, notify() {}, sendMessage() {} });
  const controller = createAgentController(owner, () => owner);
  const bridgeRoot = path.join(root, "b");
  mkdirSync(bridgeRoot, { mode: 0o700 });
  const bridge = createAgentBridge(controller, bridgeRoot, () => true);
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  fixture.beforeRelease(async () => { await client?.disconnect(); bridge.revoke(); controller.revoke();
    await bridge.settle(); await controller.settle(); });
  return { root, owner, controller, bridge, settled,
    load: { userConfigPath: config, env: { PI_CODING_AGENT_DIR: root } },
    async client() { await bridge.ready; return client = await connect(path.join(bridgeRoot, "descriptor.json"),
      { expectedSessionId: owner.sessionId }); } };
}
const completed: Attempt = { status: "completed", result: "finished", sideEffects: false };

test("complete escaped wire pages, request digest refresh, bound cursors and retirement preserve independent reads",
  fixture.ownedCase("bound wire pages", async () => {
    const env = setup(), began = deferred<void>(), finish = deferred<Attempt>();
    const brief = '😀\u0000"\\\ud800'.repeat(1500);
    let input!: Parameters<AttemptExecutor["start"]>[0];
    let live!: ReturnType<typeof createLiveHandle>, unbind!: () => void;
    const peer = await env.client();
    const worker = await spawnBackground({ roleId: "researcher", task: brief, cwd: env.root, load: env.load,
      historyOrigin: { source: "agent_spawn", coordinatorSessionId: env.owner.sessionId, workbrief: brief },
      executor: { capturesHistory: true, async start(attempt) {
        input = attempt;
        const history = attempt.history!.admit(attempt.instanceId, attempt.role.id, attempt.target), manager = history.create();
        live = createLiveHandle({ sessionManager: manager, sessionId: '"\\'.repeat(200), sessionFile: manager.getSessionFile(),
          async steer() { return "queued"; } }, { historyId: '"\\'.repeat(200), invocation: history.invocation,
            append: history.append.bind(history) });
        live.open(); unbind = attempt.bindLive!(live.handle);
        for (let index = 0; index < 200; index++)
          live.event({ type: "message_end", message: { role: "user", content: "\u0000".repeat(768), timestamp: index } });
        began.resolve();
        const result = await fixture.acquire(finish.promise);
        return { ...result, session: { async continueWith() { throw Error("unexpected continuation"); },
          async dispose() { await live.handle.close(); live.handle.onTerminalCapture?.(live.capture()); unbind();
            history.result(result); history.disposition(); } } };
      } } });
    fixture.finishOnCleanup(() => finish.resolve(completed));
    await began.promise;
    const detail = await peer.detail(worker.instanceId);
    const replies: { method: string; bytes: number }[] = [];
    const original = net.Socket.prototype.write;
    const capture = spyOn(net.Socket.prototype, "write").mockImplementation(function(this: net.Socket, ...args) {
      const raw = args[0].toString();
      if (raw.startsWith("{")) {
        const reply = JSON.parse(raw);
        if (reply.ok === true && reply.result?.state) {
          const method = reply.result.page?.activity ? "workers.activity" : reply.result.workbrief ? "workers.detail"
            : reply.result.page?.text !== undefined ? "workers.requests" : "workers.result";
          expect(isReply(reply, method)).toBe(true);
          const bytes = Buffer.byteLength(raw) - 1;
          expect(bytes).toBeLessThanOrEqual(replyBytes); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(65536);
          replies.push({ method, bytes });
        }
      }
      return Reflect.apply(original, this, args);
    });
    try {
      let metadataText = detail.metadata.text, metadataPage = detail;
      while (metadataPage.nextMetadata) {
        metadataPage = await peer.detail(worker.instanceId, metadataPage.nextMetadata);
        metadataText += metadataPage.metadata.text;
      }
      const metadata = JSON.parse(metadataText);
      expect(metadata.selected.fast.state).toBe("unavailable");
      const noRequests = await peer.requests(worker.instanceId);
      expect(JSON.parse(noRequests.page.text).missingReason).toContain("No SDK-observed");
      for (let index = 0; index < 51; index++) input.onRequest?.({
        model: `fixture/observed-${index}`, sdkOptions: { reasoning: "\u0000😀".repeat(200), maxTokens: 99 },
        fast_requested: false, returned_service_tier: "unavailable", time_to_first_model_output_ms: "unavailable" });
      const first = await peer.requests(worker.instanceId);
      expect(first.next).not.toBeNull();
      input.onRequest?.({ model: "fixture/last", fast_requested: true, requested_service_tier: "priority",
        returned_service_tier: "unavailable", time_to_first_model_output_ms: "unavailable" });
      await expect(peer.requests(worker.instanceId, first.next!)).rejects.toMatchObject({ code: "stale_cursor" });
      let page = await peer.requests(worker.instanceId), projection = page.page.text;
      while (page.next) { page = await peer.requests(worker.instanceId, page.next); projection += page.page.text; }
      const requests = JSON.parse(projection);
      expect(requests.requests).toHaveLength(50); expect(requests.dropped).toBe(2);
      expect(requests.requests.at(-1).model).toBe("fixture/last");
      expect(requests.requests.at(-1).sdkOptions).toBeUndefined();
      expect(requests.requests.at(-1).returned_service_tier).toBe("unavailable");
      let detailPage = await peer.detail(worker.instanceId), exactBrief = detailPage.workbrief.text;
      while (detailPage.nextBrief) { detailPage = await peer.detail(worker.instanceId, detailPage.nextBrief);
        exactBrief += detailPage.workbrief.text; }
      expect(exactBrief).toBe(brief);
      let cursor: WorkerReadCursor = { ref: detail.ref, section: "activity", after: 0 };
      const sequences: number[] = [];
      for (;;) {
        const activity = await peer.activity(detail.ref, cursor);
        if (activity.state !== "ready") throw Error(JSON.stringify(activity));
        expect(Buffer.byteLength(JSON.stringify(activity.page))).toBeLessThanOrEqual(31 * 1024);
        sequences.push(...activity.page.activity.map(item => item.sequence)); cursor = activity.next;
        if (!activity.page.more) break;
      }
      expect(sequences).toEqual(Array.from({ length: 200 }, (_, index) => index + 1));
      await expect(peer.activity(detail.ref, { ref: detail.ref, section: "activity", after: 201 }))
        .rejects.toMatchObject({ code: "invalid_cursor" });
      await expect(peer.result(detail.ref, { ref: detail.ref, section: "activity", after: 0 }))
        .rejects.toMatchObject({ code: "invalid_request" });
      finish.resolve({ ...completed, result: brief.repeat(2) }); await env.settled.promise;
      const terminal = await peer.activity(detail.ref, cursor);
      expect(terminal.state).toBe("ready");
      if (terminal.state !== "ready") throw Error(JSON.stringify(terminal));
      expect(terminal.page.active).toBe(false); expect(terminal.page.gaps.join("\n")).toContain("Terminal storage omitted");
      const result = await peer.result(detail.ref);
      if (result.state !== "ready") throw Error(JSON.stringify(result));
      let resultPage = result, exact = result.text.text;
      while (resultPage.nextText) {
        const next = await peer.result(detail.ref, resultPage.nextText);
        if (next.state !== "ready") throw Error(JSON.stringify(next));
        resultPage = next; exact += next.text.text;
      }
      expect(exact).toBe(brief.repeat(2));
      expect(Math.max(...replies.filter(item => item.method === "workers.activity").map(item => item.bytes))).toBeGreaterThan(30 * 1024);
      console.log("complete reply bytes", JSON.stringify(replies));
    } finally { capture.mockRestore(); }
    await expect(peer.detail("absent")).rejects.toMatchObject({ code: "unknown_target" });
    const key = terminalActivityKey(worker.instanceId, env.owner.token, env.owner.sessionId)!;
    revokeBackgroundOwner(env.owner.token);
    expect(readTerminalActivity(key).state).toBe("stale_reference");
    live.handle.onTerminalCapture?.(live.capture());
    expect(readTerminalActivity(key).state).toBe("stale_reference");
    await expect(peer.detail(worker.instanceId)).rejects.toMatchObject({ code: "stale_owner" });
    expect(listObservations().find(row => row.id === worker.instanceId)?.resultTaken).not.toBe(true);
  }));

test("native replacement and same-native logical continuation invalidate old refs/cursors and old capture callbacks",
  fixture.ownedCase("read identity", async () => {
    const env = setup(), firstReady = deferred<void>(), replace = deferred<void>(), replaced = deferred<void>(),
      continueGate = deferred<Attempt>(), continuing = deferred<void>(), finish = deferred<Attempt>();
    const peer = await env.client();
    let oldRef!: WorkerReadReference, newRef!: WorkerReadReference, staleCapture!: () => void;
    const worker = await spawnBackground({ roleId: "researcher", task: "bound", cwd: env.root, load: env.load,
      historyOrigin: { source: "agent_spawn", coordinatorSessionId: env.owner.sessionId, workbrief: "bound" },
      executor: { capturesHistory: true, async start(input) {
        const history = input.history!.admit(input.instanceId, input.role.id, input.target), native = history.create();
        const make = (sessionId: string) => createLiveHandle({ sessionId, sessionManager: native,
          sessionFile: native.getSessionFile(), async steer() { return "queued"; } }, history);
        const original = make("first-native"); original.open();
        const originalUnbind = input.bindLive!(original.handle);
        staleCapture = () => original.handle.onTerminalCapture?.({ ...original.capture(), sequence: 999 });
        firstReady.resolve(); await replace.promise;
        const replacement = make("replacement-native"); replacement.open();
        const unbind = input.bindLive!(replacement.handle);
        await original.handle.close(); originalUnbind();
        replaced.resolve();
        const session: AttemptSession = { async continueWith() {
          continuing.resolve(); return await fixture.acquire(finish.promise);
        }, async dispose() { await replacement.handle.close(); replacement.handle.onTerminalCapture?.(replacement.capture());
          unbind(); history.disposition(); } };
        return { ...await fixture.acquire(continueGate.promise), session };
      } } });
    fixture.finishOnCleanup(() => { replace.resolve(); continueGate.resolve(completed); finish.resolve(completed); });
    await firstReady.promise;
    oldRef = (await peer.detail(worker.instanceId)).ref;
    replace.resolve(); await replaced.promise;
    newRef = (await peer.detail(worker.instanceId)).ref;
    expect(newRef.native?.generation).toBe(oldRef.native!.generation + 1);
    staleCapture();
    await expect(peer.activity(oldRef)).rejects.toMatchObject({ code: "stale_reference" });
    await expect(peer.detail(worker.instanceId, { ref: oldRef, section: "brief", offset: 0 }))
      .rejects.toMatchObject({ code: "stale_reference" });
    continueGate.resolve({ status: "failed", result: "", error: "503 service unavailable", sideEffects: true });
    await continuing.promise;
    const continued = (await peer.detail(worker.instanceId)).ref;
    expect(continued.native).toEqual(newRef.native); expect(continued.attemptId).not.toBe(newRef.attemptId);
    await expect(peer.result(newRef)).rejects.toMatchObject({ code: "stale_reference" });
    await expect(peer.activity(continued, { ref: newRef, section: "activity", after: 0 }))
      .rejects.toMatchObject({ code: "stale_reference" });
    expect((await peer.activity(continued)).state).toBe("ready");
    finish.resolve(completed); await env.settled.promise;
    expect((await peer.activity(continued)).state).toBe("ready");
    expect((await peer.result(continued)).state).toBe("ready");
  }));
