import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setBackgroundExecutor, readBackgroundPending, clearBackgroundOwner, workerHandoff, bindBackgroundOwner, cancelTeamWorker, spawnBackground, teamWorkerStatus, reserveBackground, observeWorkerResults } from "../extensions/agent/background.ts";
import { AgentClosureError } from "../extensions/agent/closure.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { HeadAttachment } from "../extensions/agent/head/runtime.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";
import { WorkerHistory } from "../extensions/agent/history.ts";
import { subscribeChanges } from "../extensions/agent/observe.ts";
import { beginTeamEvaluation, reserveTeamMember, retireTeamEvaluation, teamEvaluationForSession, firstTeamReservation, createTeam, admitTeamMember, disbandTeam } from "../extensions/team.ts";
import { architectureFixture } from "./fixtures/architecture.ts";
import { openBoard } from "../extensions/board/store.ts";
import { planFile, readLedgerTeamHolds } from "../extensions/workflow.ts";
import { controlledPi } from "./fixtures/pi-factories.ts";

// Unknown reservations live for the host lifetime; never clear them to admit another case.
function unknownTest(name: string, body: () => Promise<void>) {
  test(name, async () => {
    if (process.env.PITAKO_PHYSICAL_CLOSURE_CASE === name) return body();
    const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    console.log(execFileSync(process.execPath, ["test", import.meta.path, "--test-name-pattern", pattern], {
      env: { ...process.env, PITAKO_PHYSICAL_CLOSURE_CASE: name, BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" },
      encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
    }));
  });
}

// Child hosts retain intentional unknown owners and roots, not proof of producer closure.
const retained: unknown[] = [];
const keys = ["pitako.backgroundWorkers", "pitako.teamRegistry", "pitako.agentObservations", "pitako.agentUi", "pitako.executionIdentity"].map(Symbol.for);
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-physical-closure-"));
  if (process.env.PITAKO_FIXTURE_WITNESS) console.log("PHYSICAL_CLOSURE_CREATED", root);
  const host = globalThis as Record<symbol, unknown>;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(host, key));
  for (const key of keys) Reflect.deleteProperty(host, key);
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const userConfigPath = path.join(root, "pitako", "config.toml");
  mkdirSync(path.dirname(userConfigPath), { recursive: true });
  writeFileSync(userConfigPath, '[model_policies.developer.primary]\nmodel = "fixture/selected"\nreasoning = "off"\n');
  return { root, load: { userConfigPath, env: { PI_CODING_AGENT_DIR: root } },
    release(unknown: boolean) {
      if (unknown) {
        retained.push({ root, registries: keys.map(key => host[key]) });
        console.log("PHYSICAL_CLOSURE_UNKNOWN_RETAINED", root);
      }
      keys.forEach((key, index) => {
        if (previous[index]) Object.defineProperty(host, key, previous[index]!);
        else Reflect.deleteProperty(host, key);
      });
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      if (!unknown) {
        rmSync(root, { recursive: true, force: true });
        if (process.env.PITAKO_FIXTURE_WITNESS) console.log("PHYSICAL_CLOSURE_REMOVED", root);
      }
    },
  };
}

test("reentrant retirement at startup joins the accepted worker before releasing its reservation", async () => {
  const env = setup(), evaluation = beginTeamEvaluation("reentrant-start", false)!;
  const reservation = reserveTeamMember(evaluation, "developer", "starting-assignment");
  let retirement: Promise<void> | undefined, starts = 0, heldReservation: string | undefined;
  const head = new HeadAttachment("starting-assignment", env.root);
  let lateReservationError: unknown;
  head.signal.addEventListener("abort", () => {
    try { reserveTeamMember(evaluation, "reviewer", "late-assignment"); } catch (error) { lateReservationError = error; }
  }, { once: true });
  bindBackgroundOwner({ token: evaluation.token, sessionId: evaluation.sessionId, isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} });
  const unsubscribe = subscribeChanges(() => {
    if (retirement) return;
    retirement = retireTeamEvaluation(evaluation);
    heldReservation = firstTeamReservation(evaluation, "developer");
  });
  try {
    await spawnBackground({ roleId: "developer", task: "starting", cwd: env.root, load: env.load, head,
      executor: { async start() { starts++; throw new Error("retired startup must not start"); } },
      teamOwner: { token: evaluation.token, assignmentId: "starting-assignment", onSettled: reservation.settled } });
    reservation.commit();
    await retirement;
    expect(heldReservation).toBe("starting-assignment");
    expect(String(lateReservationError)).toContain("stale Team evaluation");
    expect(starts).toBe(0);
    expect(teamWorkerStatus(evaluation.token)).toEqual([]);
    expect(firstTeamReservation(evaluation, "developer")).toBeUndefined();
  } finally {
    await (retirement ?? retireTeamEvaluation(evaluation));
    unsubscribe();
    env.release(false);
  }
});

test("ordinary SDK worker retains row and Team reservation through prompt, abort and deferred disposal", async () => {
  const env = setup(), started = Promise.withResolvers<void>(), releasePrompt = Promise.withResolvers<void>(),
    aborting = Promise.withResolvers<void>(), releaseAbort = Promise.withResolvers<void>(),
    disposing = Promise.withResolvers<void>(), releaseDispose = Promise.withResolvers<void>();
  const evaluation = beginTeamEvaluation("ordinary-closure", false)!;
  bindBackgroundOwner({ token: evaluation.token, sessionId: evaluation.sessionId, isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} });
  const reservation = reserveTeamMember(evaluation, "developer", "ordinary-assignment");
  const sdk = controlledPi(env.root, {
    prompt: async () => { started.resolve(); await releasePrompt.promise; },
    abort: async () => { aborting.resolve(); await releaseAbort.promise; },
    dispose: async () => { disposing.resolve(); await releaseDispose.promise; },
  });
  let retirement: Promise<void> | undefined, closed = false;
  try {
    const worker = await spawnBackground({ roleId: "developer", task: "ordinary", cwd: env.root, load: env.load,
      executor: createPiExecutor({ factories: sdk.factories }),
      teamOwner: { token: evaluation.token, assignmentId: "ordinary-assignment", onSettled: reservation.settled } });
    reservation.commit();
    await started.promise;
    expect(sdk.sessions[0]!.active.some(name => name.startsWith("head_"))).toBe(false);
    expect(cancelTeamWorker(evaluation.token, worker.instanceId)).toMatchObject({ status: "cancelled", closure: { state: "pending" } });
    const independent = reserveTeamMember(evaluation, "reviewer", "independent");
    expect(independent.owns()).toBe(true);
    independent.rollback();
    retirement = retireTeamEvaluation(evaluation).then(() => { closed = true; });
    await aborting.promise;
    expect(firstTeamReservation(evaluation, "developer")).toBe("ordinary-assignment");
    expect(closed).toBe(false);
    releasePrompt.resolve();
    await Promise.resolve();
    expect(sdk.sessions[0]!.events).not.toContain("dispose");
    releaseAbort.resolve();
    await disposing.promise;
    expect(teamWorkerStatus(evaluation.token, worker.instanceId)[0]?.closure).toEqual({ state: "pending" });
    expect(firstTeamReservation(evaluation, "developer")).toBe("ordinary-assignment");
    expect(() => beginTeamEvaluation(evaluation.sessionId, false)).toThrow("await retirement");
    expect(closed).toBe(false);
    releaseDispose.resolve();
    await retirement;
    expect(teamWorkerStatus(evaluation.token)).toEqual([]);
    expect(firstTeamReservation(evaluation, "developer")).toBeUndefined();
  } finally {
    releasePrompt.resolve(); releaseAbort.resolve(); releaseDispose.resolve();
    await (retirement ?? retireTeamEvaluation(evaluation));
    env.release(false);
  }
});

test("cancellation during native disposal joins the newly admitted abort before publishing closure", async () => {
  const env = setup(), controller = new AbortController(), disposing = Promise.withResolvers<void>(),
    releaseDispose = Promise.withResolvers<void>(), aborting = Promise.withResolvers<void>(), releaseAbort = Promise.withResolvers<void>();
  const sdk = controlledPi(env.root, {
    dispose: async () => { disposing.resolve(); await releaseDispose.promise; },
    abort: async () => { aborting.resolve(); await releaseAbort.promise; },
  });
  let finished = false;
  const run = runAgentInstance({ roleId: "developer", task: "cancel disposal", cwd: env.root, load: env.load,
    signal: controller.signal, executor: createPiExecutor({ factories: sdk.factories }) }).then(result => { finished = true; return result; });
  try {
    await disposing.promise;
    controller.abort();
    await aborting.promise;
    releaseDispose.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(new WorkerHistory(env.root).list()[0]?.members[0]?.native).toMatchObject({
      state: "allocated", disposition: { state: "pending" },
    });
    releaseAbort.resolve();
    await run;
    expect(new WorkerHistory(env.root).list()[0]?.members[0]?.native).toMatchObject({
      state: "allocated", disposition: { state: "disposed" },
    });
  } finally {
    releaseDispose.resolve(); releaseAbort.resolve();
    await run;
    env.release(false);
  }
});

for (const failure of ["abort", "dispose"] as const) {
  unknownTest(`rejected SDK ${failure} retains unknown row, history and outer reservation without normal release`, async () => {
    const env = setup(), started = Promise.withResolvers<void>(), releasePrompt = Promise.withResolvers<void>();
    const evaluation = beginTeamEvaluation(`unknown-${failure}`, false)!;
    const reservation = reserveTeamMember(evaluation, "developer", `assignment-${failure}`);
    let normalRelease = 0;
    bindBackgroundOwner({ token: evaluation.token, sessionId: evaluation.sessionId, isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} });
    const sdk = controlledPi(env.root, {
      prompt: async () => { started.resolve(); await releasePrompt.promise; },
      abort: async () => { if (failure === "abort") throw new Error("controlled abort rejected"); },
      dispose: async () => { if (failure === "dispose") throw new Error("controlled disposal rejected"); },
    });
    let retirement: Promise<void> | undefined;
    try {
      const worker = await spawnBackground({ roleId: "developer", task: "unknown", cwd: env.root, load: env.load,
        executor: createPiExecutor({ factories: sdk.factories }),
        teamOwner: { token: evaluation.token, assignmentId: `assignment-${failure}`, onSettled() { normalRelease++; reservation.settled(); } } });
      reservation.commit();
      await started.promise;
      cancelTeamWorker(evaluation.token, worker.instanceId);
      retirement = retireTeamEvaluation(evaluation);
      void retirement.catch(() => {});
      releasePrompt.resolve();
      await expect(retirement).rejects.toThrow(failure === "abort" ? "controlled abort rejected" : "controlled disposal rejected");
      expect(normalRelease).toBe(0);
      expect(teamWorkerStatus(evaluation.token, worker.instanceId)[0]?.closure.state).toBe("unknown");
      expect(firstTeamReservation(evaluation, "developer")).toBe(`assignment-${failure}`);
      expect(() => reserveTeamMember(evaluation, "developer", "replacement")).toThrow("stale Team evaluation");
      expect(() => beginTeamEvaluation(evaluation.sessionId, false)).toThrow("await retirement");
      const history = new WorkerHistory(env.root).list();
      expect(history[0]?.closure.state).not.toBe("closed");
      expect(history[0]?.members[0]?.native).toMatchObject({ state: "allocated", disposition: { state: "unknown" } });
      expect(sdk.sessions[0]!.events).toContain("dispose");
    } finally {
      releasePrompt.resolve();
      await Promise.allSettled([retirement ?? retireTeamEvaluation(evaluation)]);
      env.release(true);
    }
  });
}

unknownTest("Head child disposal failure blocks native delivery and leaves both assignment and parent closure unknown", async () => {
  const env = setup(), head = new HeadAttachment("unknown-head-assignment", env.root);
  const child = controlledPi(env.root, { dispose: async () => { throw new Error("controlled child disposal rejected"); } });
  let boundary: Function | undefined;
  const host = controlledPi(env.root, {
    bind: async () => {
      for (const factory of host.loaderInputs[0].extensionFactories) await factory({
        registerTool() {}, on(name: string, handler: Function) { if (name === "agent_before_settle") boundary = handler; },
      } as unknown as ExtensionAPI);
    },
    prompt: async session => {
      await expect(head.startChild("unknown-child", signal => runAgentInstance({
        roleId: "developer", task: "child", cwd: env.root, load: env.load, signal, executor: createPiExecutor({ factories: child.factories }),
      }))).rejects.toThrow("controlled child disposal rejected");
      expect(boundary?.({ outcome: "completed", context: { canContinue: true } })).toBeUndefined();
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "not publishable" }], stopReason: "stop" });
    },
  });
  try {
    await expect(runAgentInstance({ roleId: "developer", task: "Head", cwd: env.root, load: env.load, head,
      executor: createPiExecutor({ factories: host.factories }) })).rejects.toThrow("controlled child disposal rejected");
    expect(head.closure.state).toBe("unknown");
    await expect(head.close()).rejects.toThrow("controlled child disposal rejected");
    expect(host.sessions[0]!.events).toContain("dispose");
    expect(new WorkerHistory(env.root).list().some(group => group.members.some(member =>
      member.native.state === "allocated" && member.native.disposition.state === "unknown"))).toBe(true);
  } finally {
    retained.push(head);
    env.release(true);
  }
});

unknownTest("the Head's own SDK disposal failure cannot mark its attachment released", async () => {
  const env = setup(), head = new HeadAttachment("own-disposal-assignment", env.root);
  const sdk = controlledPi(env.root, { dispose: async () => { throw new Error("controlled Head disposal rejected"); } });
  try {
    await expect(runAgentInstance({ roleId: "developer", task: "Head disposal", cwd: env.root, load: env.load, head,
      executor: createPiExecutor({ factories: sdk.factories }) })).rejects.toThrow("controlled Head disposal rejected");
    expect(head.closure).toMatchObject({ state: "unknown" });
    await expect(head.close()).rejects.toThrow("controlled Head disposal rejected");
    expect(new WorkerHistory(env.root).list()[0]?.members[0]?.native).toMatchObject({
      state: "allocated", disposition: { state: "unknown" },
    });
  } finally {
    retained.push(head);
    env.release(true);
  }
});


unknownTest("unknown no-worker preparation retains its reservation despite an incorporated outcome", async () => {
  const env = setup(), delivered = Promise.withResolvers<void>();
  const evaluation = beginTeamEvaluation("unknown-preparation", false)!;
  const admission = reserveTeamMember(evaluation, "oracle", "unknown");
  const branch: unknown[] = [];
  bindBackgroundOwner({ token: evaluation.token, sessionId: evaluation.sessionId, isIdle: () => true, hasUI: false,
    notify() {}, sendMessage() {}, getBranch: () => branch, appendResult(message) {
      branch.push({ type: "custom_message", ...message }); delivered.resolve();
    } });
  try {
    const handle = reserveBackground({ roleId: "oracle", task: "unknown", coordinatorSessionId: evaluation.sessionId, owns: () => true,
      teamOwner: { token: evaluation.token, assignmentId: "unknown", onSettled() {}, noWorkerReleased: admission.noWorkerReleased },
      async prepare() { throw new AgentClosureError([new Error("unjoined resource")], "preparation"); } });
    admission.commit();
    await delivered.promise; observeWorkerResults(evaluation.token);
    expect(teamWorkerStatus(evaluation.token, handle.instanceId)[0]?.closure.state).toBe("unknown");
    expect(firstTeamReservation(evaluation, "oracle")).toBe("unknown");
    expect(readBackgroundPending({ ownerToken: evaluation.token, coordinatorSessionId: evaluation.sessionId })).toEqual({ state: "pending" });
    await expect(retireTeamEvaluation(evaluation)).rejects.toThrow("Background retirement");
  } finally { env.release(true); }
});


for (const failure of ["abort", "dispose"] as const) {
  unknownTest(`maintained Team ${failure} rejection retains exact member and blocks disband`, async () => {
    const env = setup(), current = beginTeamEvaluation(`maintained-unknown-${failure}`, false)!;
    bindBackgroundOwner({ token: current.token, sessionId: current.sessionId, isIdle: () => false, hasUI: false, notify() {}, sendMessage() {} });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const sdk = controlledPi(env.root, {
      async prompt(session, text) {
        if (text === "blocked") { entered.resolve(); await release.promise; }
        session.messages.push({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
      },
      async abort(session) { if (failure === "abort" && session.prompts.includes("blocked")) throw new Error("maintained abort unknown"); },
      async dispose(session) { if (failure === "dispose" && session.prompts.includes("blocked")) throw new Error("maintained dispose unknown"); },
    });
    const team = createTeam(current);
    const input = { roleId: "developer", task: "mandate", cwd: env.root, load: env.load, executor: createPiExecutor({ factories: sdk.factories }) };
    const blocked = admitTeamMember(team, input), healthy = admitTeamMember(team, input);
    const turn = blocked.turn("blocked");
    void turn.catch(() => {});
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      cancelTeamWorker(current.token, blocked.instanceId);
      expect(firstTeamReservation(current, "developer")).toBe(blocked.assignmentId);
      expect((await healthy.turn("independent progress")).status).toBe("completed");
      await healthy.finish();
      expect(teamWorkerStatus(current.token, healthy.instanceId)[0]?.closure.state).toBe("released");
      closing = disbandTeam(team); void closing.catch(() => {});
      release.resolve(); await Promise.allSettled([turn]);
      await expect(closing).rejects.toThrow("Team disband");
      expect(teamWorkerStatus(current.token, blocked.instanceId)[0]?.closure).toMatchObject({ state: "unknown" });
      expect(firstTeamReservation(current, "developer")).toBe(blocked.assignmentId);
      expect(() => admitTeamMember(team, input)).toThrow("admission is closed");
      expect(new WorkerHistory(env.root).list().some(group => group.closure.state !== "closed")).toBe(true);
    } finally {
      release.resolve(); await Promise.allSettled([turn, closing ?? disbandTeam(team), retireTeamEvaluation(current)]);
      env.release(true);
    }
  });
}


unknownTest("registered table replacement with rejected outgoing disposal retains root, diagnosis and hold without a replacement or private delivery", async () => {
  const env = setup(), unknown = Promise.withResolvers<void>();
  let handle: any, compositions = 0;
  const room = await architectureFixture().setup({ root: env.root,
    async prompt(_session, request, body) {
      if (request.stage === "composition") { compositions++; return body; }
      if (request.stage === "preparation") return { kind: "preparation", analysis: "independent", doubts: [] };
      if (request.stage === "contribution") return { kind: "contribution", proposal: "bounded", arguments: ["reason"], objections: [], doubts: [] };
      if (request.stage === "decision") return { kind: "decision", action: "recompose", reason: "replace member" };
    },
    async dispose(session) { if (session.model?.id === "chosen") throw new Error("table outgoing disposal rejected"); },
  });
  const changed = () => { if (handle && teamWorkerStatus(room.evaluation.token, handle.instanceId)[0]?.closure.state === "unknown") unknown.resolve(); };
  const unsubscribe = subscribeChanges(changed);
  try {
    const db = await openBoard(); const topic = db.createTopic(env.root, { title: "Unknown table closure" }); db.claimTopic(env.root, topic.id, "unknown-table"); db.close();
    const file = planFile("unknown-table", env.root); mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `---\nid: unknown-table\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\n---\nUnknown closure.\n`);
    const start = await room.invoke("architecture_start", { goal: "Unknown outgoing closure", plan: "unknown-table", unit: "T3" });
    expect(start.isError).not.toBe(true); handle = start.details; changed(); await unknown.promise;
    expect(compositions).toBe(2); expect(room.host.sessions).toHaveLength(2);
    expect(room.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    expect(firstTeamReservation(room.evaluation, "architect")).toBe(handle.assignmentId);
    expect(readLedgerTeamHolds(env.root, "unknown-table")).toHaveLength(1);
    const status = (await room.invoke("architecture_read", { roomId: handle.roomId })).details;
    expect(status.state).toBe("closure-unknown"); expect(status.closure.state).toBe("unknown");
    expect(status.closure.reason).toContain("table outgoing disposal rejected");
    const child = teamWorkerStatus(room.evaluation.token).find(row => row.instanceId !== handle.instanceId)!;
    expect(child.closure.state).toBe("unknown");
    expect(child.closure.state === "unknown" && child.closure.reason).toContain("table outgoing disposal rejected");
    expect((await room.invoke("team_result", { assignmentId: handle.assignmentId })).isError).toBe(true);
    expect(workerHandoff(handle.instanceId)).toBeUndefined();
    const observed = await room.emit("agent_before_settle", { outcome: "completed", context: { canContinue: true } });
    expect(observed?.entries ?? []).toEqual([]); expect(room.sent).toEqual([]); expect(room.branch).toEqual([]);
    const scope = { ownerToken: room.evaluation.token, coordinatorSessionId: room.evaluation.sessionId };
    expect(readBackgroundPending(scope)).toEqual({ state: "pending" });
    await expect(retireTeamEvaluation(room.evaluation)).rejects.toThrow("table outgoing disposal rejected");
    expect(readLedgerTeamHolds(env.root, "unknown-table")).toHaveLength(1);
    const replacement = room.emit("session_start");
    expect(() => readBackgroundPending(scope)).toThrow("stale_owner");
    await expect(replacement).rejects.toBeInstanceOf(AgentClosureError);
    await expect(replacement).rejects.toThrow(/^Foreground retirement: closure unknown/);
    await expect(replacement).rejects.toThrow("table outgoing disposal rejected");
    expect(readLedgerTeamHolds(env.root, "unknown-table")).toHaveLength(1);
    expect(teamEvaluationForSession(scope.coordinatorSessionId, false)).toBeUndefined();
    expect(() => readBackgroundPending({ ...scope, ownerToken: Symbol("not-admitted") })).toThrow("stale_owner");
  } finally {
    unsubscribe();
    await Promise.allSettled([room.emit("session_shutdown"), retireTeamEvaluation(room.evaluation)]);
    clearBackgroundOwner(); setBackgroundExecutor(undefined);
    retained.push(room); env.release(true);
  }
});
