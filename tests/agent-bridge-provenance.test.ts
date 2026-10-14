import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentExtension from "../extensions/agent/index.ts";
import * as piExecutor from "../extensions/agent/pi.ts";
import { bindBackgroundOwner, clearBackgroundOwner, setBackgroundExecutor, spawnBackground } from "../extensions/agent/background.ts";
import { clearObservations, listObservations } from "../extensions/agent/observe.ts";
import { createAgentController } from "../extensions/agent/controller.ts";
import { createAgentBridge } from "../extensions/agent/bridge/broker.ts";
import { connect } from "../extensions/agent/bridge/client.js";
import { beginTeamEvaluation, retireTeamEvaluation } from "../extensions/team.ts";
import type { Attempt, AttemptExecutor } from "../extensions/agent/run.ts";
import type { PublicWorkerDetail } from "../extensions/agent/bridge/protocol.js";
import { isReply, isRequest } from "../extensions/agent/bridge/protocol.js";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { providerFixtureOwnership } from "./fixtures/provider-fixture-ownership.ts";

const fixture = agentFixtureOwnership(), oldDir = process.env.PI_CODING_AGENT_DIR, oldChild = process.env.PITAKO_INSTANCE_ID;
const catalogFixture = providerFixtureOwnership();
afterEach(() => {
  fixture.requireReleasedFixture(); catalogFixture.requireReleasedFixture();
  setBackgroundExecutor(undefined); clearBackgroundOwner(); clearObservations();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldChild === undefined) delete process.env.PITAKO_INSTANCE_ID; else process.env.PITAKO_INSTANCE_ID = oldChild;
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
const completed: Attempt = { status: "completed", result: "offline result", sideEffects: false };
function setup(ownership: Pick<typeof fixture, "directories" | "beforeRelease"> = fixture) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-provenance-"));
  ownership.directories.push(root);
  process.env.PI_CODING_AGENT_DIR = root; delete process.env.PITAKO_INSTANCE_ID;
  mkdirSync(path.join(root, "pitako"));
  writeFileSync(path.join(root, "pitako/config.toml"), ["architect", "developer", "reviewer", "researcher"]
    .map(role => `[model_policies.${role}.primary]\nmodel = "fixture/local"\nreasoning = "off"\n`).join(""));
  const owner = { sessionId: "native-coordinator", token: Symbol() }, settled = deferred<void>();
  bindBackgroundOwner({ token: owner.token, hasUI: false, isIdle() { settled.resolve(); return true; }, notify() {}, sendMessage() {} });
  let currentOwner: typeof owner | undefined = owner;
  const controller = createAgentController(owner, () => currentOwner), view = controller.openView({ control: false, policy: "bridge-read" });
  const directory = path.join(root, "b"); mkdirSync(directory, { mode: 0o700 });
  const bridge = createAgentBridge(controller, directory, () => true);
  const evaluation = beginTeamEvaluation(owner.sessionId, false, owner.token)!;
  type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
  const tools = new Map<string, Tool>();
  agentExtension({ registerTool(tool: Tool) { tools.set(tool.name, tool); }, appendEntry() {} } as unknown as ExtensionAPI);
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  ownership.beforeRelease(async () => {
    await client?.disconnect(); await view.close(); bridge.revoke(); controller.revoke();
    await bridge.settle(); await controller.settle(); await retireTeamEvaluation(evaluation);
  });
  return { root, owner, evaluation, settled, view, tools, retireOwner() { currentOwner = undefined; },
    ctx: { cwd: root, sessionManager: { getSessionId: () => owner.sessionId, getSessionFile: () => path.join(root, "coordinator.jsonl") },
      modelRegistry: {
        async getAvailableOfType() { return [{ type: "classifier", provider: "fixture", id: "local", contextWindow: 8192 }]; },
        async classify() { return { api: "fixture", provider: "fixture", model: "local", timestamp: 1, stopReason: "stop",
          answers: { capacity: { type: "choice", choice: "developer_mid",
            probabilities: { developer_mid: 1, developer_senior: 0, developer_junior: 0, indeterminate: 0 } } } }; },
      } },
    async client() { await bridge.ready; client = await connect(path.join(directory, "descriptor.json"), { expectedSessionId: owner.sessionId }); return client; },
  };
}
for (const method of ["agent_spawn", "team_assign"] as const) for (const role of ["architect", "developer", "reviewer", "researcher"]) {
  test(`${method}/${role} publishes real launch provenance before resolution and before native creation`,
    fixture.ownedCase(`${method}/${role} provenance`, async () => {
      const env = setup(), peer = await env.client(), enter = deferred<void>(), release = deferred<void>(), finish = deferred<Attempt>();
      fixture.finishOnCleanup(() => { release.resolve(); finish.resolve(completed); });
      let nativeCreated = false, resolved = false;
      const toolCallId = `${method}-${role}-actual-handler-id`, brief = " \n real original WorkBrief \n ";
      let accepted!: PublicWorkerDetail, catalog!: Record<string, unknown>, nativeOrigin!: Record<string, unknown>;
      env.view.subscribe(() => {
        if (resolved || accepted) return;
        const row = listObservations(env.evaluation.token, env.owner.sessionId).find(row => row.origin?.toolCallId === toolCallId);
        if (!row) return;
        const detail = env.view.readPublicDetail(row.id);
        if ("format" in detail) accepted = detail;
      });
      setBackgroundExecutor({ capturesHistory: true, async start(input) {
        enter.resolve(); await release.promise;
        const history = input.history!.admit(input.instanceId, input.role.id, input.target), manager = history.create();
        nativeCreated = true;
        catalog = history.invocation.store.read(history.invocation.group.groupId).members[0]! as unknown as Record<string, unknown>;
        nativeOrigin = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "pitako.worker-history")! as unknown as Record<string, unknown>;
        const outcome = await fixture.acquire(finish.promise); history.result(outcome); history.disposition();
        return outcome;
      } });
      const launch = env.tools.get(method)!.execute(toolCallId, { role, task: brief }, new AbortController().signal, undefined, env.ctx as never);
      const result = await launch; resolved = true;
      if (result.isError) throw Error(JSON.stringify(result));
      await enter.promise;
      const id = (result.details as { instanceId: string }).instanceId;
      expect(accepted.worker).toMatchObject({ source: method, instanceId: id, roleId: role, toolCallId,
        coordinatorSessionId: env.owner.sessionId, linkage: "tool" });
      expect(accepted.ref.native).toBeUndefined(); expect(Number.isFinite(accepted.worker.acceptedAt)).toBe(true);
      expect(accepted.workbrief.text).toBe(brief); expect(nativeCreated).toBe(false);
      if (method === "team_assign") expect(accepted.worker.assignmentId).toBe((result.details as { id: string }).id);
      else expect(accepted.worker.assignmentId).toBeUndefined();
      const detail = await peer.publicDetail(id);
      if (!("format" in detail)) throw Error(JSON.stringify(detail));
      expect(detail.worker).toEqual(accepted.worker); expect(detail.workbrief.text).toBe(brief);
      expect(detail.lifecycle.capture).toBe("incomplete"); expect(detail.lifecycle.captureReason).toBe("not_captured");
      expect(detail.bindings).toEqual([]); expect(nativeCreated).toBe(false);
      expect(JSON.stringify(detail)).not.toContain("coordinator.jsonl");
      expect(detail).not.toHaveProperty("routing"); expect(detail).not.toHaveProperty("controls");
      const envelope = { version: 2, owner: peer.owner, id: "test", clientId: "test", ok: true, result: detail };
      expect(isReply(envelope, "workers.detail", "public-v1")).toBe(true);
      expect(isReply(envelope, "workers.detail")).toBe(false);
      expect(isReply({ ...envelope, version: 1 }, "workers.detail", "public-v1")).toBe(false);
      for (const invalid of [
        { ...detail, controls: {} }, { ...detail, routing: {} },
        { ...detail, worker: { ...detail.worker, toolCallId: null, linkage: "tool" } },
        { ...detail, worker: { ...detail.worker, instanceId: "foreign" } },
        { ...detail, lifecycle: { ...detail.lifecycle, capture: "complete" } },
      ]) expect(isReply({ ...envelope, result: invalid }, "workers.detail", "public-v1")).toBe(false);
      expect(isRequest({ version: 1, owner: peer.owner, id: "test", clientId: "test", method: "workers.list", params: {} })).toBe(false);
      release.resolve(); finish.resolve(completed); await env.settled.promise;
      expect(catalog.toolCallId).toBe(toolCallId);
      expect(nativeOrigin).toMatchObject({ data: { event: "origin", data: { origin: { toolCallId, source: method, workbrief: brief } } } });
      const terminal = await peer.publicDetail(id);
      expect(terminal).toMatchObject({ worker: accepted.worker, lifecycle: { execution: "completed", result: "available", capture: "incomplete" } });
    }));
}

test("setup failure updates the same accepted worker; internal callers remain unlinked and agent_run has no public equivalent",
  fixture.ownedCase("failed and unlinked launches", async () => {
    const env = setup(), peer = await env.client(), fail = deferred<void>(), started = deferred<void>();
    fixture.finishOnCleanup(() => fail.resolve());
    setBackgroundExecutor({ capturesHistory: true, async start() {
      started.resolve(); await fail.promise; throw Error("offline setup failure before native allocation");
    } });
    const call = await env.tools.get("agent_spawn")!.execute("failure-tool-call", { role: "researcher", task: "failure brief" },
      new AbortController().signal, undefined, env.ctx as never);
    if (call.isError) throw Error(JSON.stringify(call));
    const id = (call.details as { instanceId: string }).instanceId;
    await started.promise;
    const initial = await peer.publicDetail(id);
    fail.resolve(); await env.settled.promise;
    expect(await peer.publicDetail(id)).toMatchObject({
      worker: "worker" in initial ? initial.worker : {},
      lifecycle: { execution: "failed", result: "available", capture: "incomplete" },
    });
    let starts = 0;
    const executor: AttemptExecutor = { async start() { starts++; return completed; } };
    const unlinked = await spawnBackground({ roleId: "researcher", task: "internal caller", cwd: env.root, executor,
      historyOrigin: { source: "agent_spawn", coordinatorSessionId: env.owner.sessionId } });
    expect(await peer.publicDetail(unlinked.instanceId)).toMatchObject({ worker: { toolCallId: null, linkage: "unlinked" } });
    const controlled = spyOn(piExecutor, "createPiExecutor").mockReturnValue(executor);
    let run: Awaited<ReturnType<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>>;
    try {
      run = await env.tools.get("agent_run")!.execute("sync-tool-call", { role: "researcher", task: "sync original" },
        new AbortController().signal, undefined, env.ctx as never);
    } finally { controlled.mockRestore(); }
    expect(run.isError).not.toBe(true);
    const sync = listObservations().find(row => row.origin?.toolCallId === "sync-tool-call")!;
    expect(sync.origin?.source).toBe("agent_run");
    expect(await peer.publicDetail(sync.id)).toEqual({ state: "unavailable", reason: "unsupported_kind" });
    const privateDetail = await peer.detail(sync.id);
    if (privateDetail.state !== "ready") throw Error(JSON.stringify(privateDetail));
    expect(privateDetail.status).toBe("completed");
    expect(privateDetail.ref.attemptId).toBe(sync.attemptId);
    expect(sync.attemptId).toBeString();
    const { attemptId, evaluationId, native, ...ref } = privateDetail.ref;
    const cursor = { ref, section: "brief" as const, offset: 0 };
    const unavailable = { state: "unavailable", reason: "unsupported_kind" } as const;
    for (const [method, params] of [
      ["workers.activity", { format: "public-v1", ref }],
      ["workers.result", { format: "public-v1", ref }],
      ["workers.detail", { format: "public-v1", id: sync.id, cursor }],
    ]) expect(isRequest({ version: 2, owner: peer.owner, id: "test", clientId: "test", method, params })).toBe(true);
    const reads = await Promise.allSettled([
      peer.publicActivity(ref), peer.publicResult(ref), peer.publicDetail(sync.id, cursor),
    ]);
    expect(reads.map(result => result.status === "fulfilled" ? result.value : { error: result.reason.code }))
      .toEqual([unavailable, unavailable, unavailable]);
    expect(env.view.readPublicActivity(ref)).toEqual(unavailable);
    expect(env.view.readPublicResult(ref)).toEqual(unavailable);
    expect(env.view.readPublicDetail(sync.id, cursor)).toEqual(unavailable);
    for (const invalid of [
      { ...ref, processId: "foreign" }, { ...ref, coordinatorSessionId: "foreign" },
      { ...ref, epoch: "retired" }, { ...ref, source: "agent_spawn" as const },
      { ...ref, source: "team_assign" as const, assignmentId: "foreign-assignment" },
    ]) {
      await expect(peer.publicActivity(invalid)).rejects.toMatchObject({ code: "stale_reference" });
      await expect(peer.publicResult(invalid)).rejects.toMatchObject({ code: "stale_reference" });
      await expect(peer.publicDetail(sync.id, { ...cursor, ref: invalid })).rejects.toMatchObject({ code: "stale_reference" });
    }
    const unknown = { ...ref, instanceId: "unknown" };
    await expect(peer.publicActivity(unknown)).rejects.toMatchObject({ code: "unknown_target" });
    await expect(peer.publicResult(unknown)).rejects.toMatchObject({ code: "unknown_target" });
    await expect(peer.publicDetail(unknown.instanceId, { ...cursor, ref: unknown })).rejects.toMatchObject({ code: "unknown_target" });
    // Public logical references do not relax private attempt validation.
    await expect(peer.activity(ref)).rejects.toMatchObject({ code: "stale_reference" });
    await expect(peer.result(ref)).rejects.toMatchObject({ code: "stale_reference" });
    await expect(peer.detail(sync.id, cursor)).rejects.toMatchObject({ code: "stale_reference" });
    expect(await peer.activity(privateDetail.ref)).toEqual(unavailable);
    expect(await peer.result(privateDetail.ref)).toEqual(unavailable);
    expect((await peer.detail(sync.id, { ...cursor, ref: privateDetail.ref })).state).toBe("ready");
    expect(listObservations().find(row => row.id === sync.id)).toEqual(sync);
    expect(starts).toBe(2);
    expect(env.view.detail(sync.id).controls.available).toBe(false);
    expect(peer).not.toHaveProperty("input"); expect(peer).not.toHaveProperty("cancel");
    await env.view.close();
    expect(() => env.view.readPublicActivity(ref)).toThrow("view is disconnected");
    expect(() => env.view.readPublicResult(ref)).toThrow("view is disconnected");
    expect(() => env.view.readPublicDetail(sync.id, cursor)).toThrow("view is disconnected");
    env.retireOwner();
    await expect(peer.publicActivity(ref)).rejects.toMatchObject({ code: "stale_owner" });
    await expect(peer.publicResult(ref)).rejects.toMatchObject({ code: "stale_owner" });
    await expect(peer.publicDetail(sync.id, cursor)).rejects.toMatchObject({ code: "stale_owner" });
  }));

test("catalog initialization failure preserves accepted provenance and settles as failed without native start",
  catalogFixture.ownedCase("history initialization failure", async () => {
    const env = setup(catalogFixture), peer = await env.client();
    const conflict = path.join(env.root, "pitako", "worker-history");
    writeFileSync(conflict, "controlled path conflict");
    catalogFixture.beforeRelease(() => unlinkSync(conflict));
    let starts = 0, accepted!: PublicWorkerDetail;
    env.view.subscribe(() => {
      if (accepted) return;
      const row = listObservations().find(row => row.origin?.toolCallId === "catalog-failure");
      if (!row) return;
      const detail = env.view.readPublicDetail(row.id);
      if ("format" in detail) accepted = detail;
    });
    setBackgroundExecutor({ capturesHistory: true, async start() { starts++; return completed; } });
    const result = await env.tools.get("agent_spawn")!.execute("catalog-failure", { role: "researcher", task: "original setup brief" },
      new AbortController().signal, undefined, env.ctx as never);
    if (result.isError) throw Error(JSON.stringify(result));
    await env.settled.promise;
    expect(starts).toBe(0);
    expect(accepted.lifecycle.execution).toBe("accepted");
    const id = (result.details as { instanceId: string }).instanceId;
    expect(await peer.publicDetail(id)).toMatchObject({ worker: accepted.worker,
      lifecycle: { execution: "failed", result: "available", capture: "incomplete" } });
    expect((await peer.detail(id)).status).toBe("failed");
  }));
