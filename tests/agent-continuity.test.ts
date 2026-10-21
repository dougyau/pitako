import { afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import pitako from "../extensions/index.ts";
import { bindCallContext, openExecuteActivity, openPlanActivity, Producer, recordDisposition, reserveEffect, RootGuard, statusOwner, waitForProducer, type ResultObligation } from "../extensions/workflow-engine.ts";
import { snapshotPlan } from "../extensions/workflow-planning.ts";
import { WorkflowState } from "../extensions/workflow-state.ts";
import { ledgerFile, openExecutionPlan, planFile } from "../extensions/workflow.ts";
import { spawnBackground, publishIntermediate, workerHandoff, clearBackgroundOwner } from "../extensions/agent/background.ts";
import { teamEvaluationForSession } from "../extensions/team.ts";
import { agentFixtureOwnership } from "./fixtures/agent-fixture-ownership.ts";
import { privateStartupConfig } from "./fixtures/config-completion.ts";
import type { Attempt } from "../extensions/agent/run.ts";

const fixture = agentFixtureOwnership();
afterEach(() => { fixture.requireReleasedFixture(); clearBackgroundOwner(); });

async function mounted(phase: "planning" | "execution" = "execution") {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-continuity-"));
  fixture.directories.push(root);
  // This fixture observes continuity, not Git discovery (covered in workspace.test.ts).
  // Keep the real root/plan checks, without launching Git for each no-Git reread.
  const git = childProcess.execFileSync;
  const noGit = spyOn(childProcess, "execFileSync").mockImplementation(new Proxy(git, {
    apply(target, thisArg, args) {
      if (args[0] === "git" && args[2]?.cwd === root &&
          JSON.stringify(args[1]) === JSON.stringify(["rev-parse", "--is-inside-work-tree", "--is-bare-repository", "--path-format=absolute", "--git-common-dir"])) {
        throw Object.assign(new Error("controlled non-repository fixture"), { stderr: "fatal: not a git repository" });
      }
      return Reflect.apply(target, thisArg, args);
    },
  }));
  fixture.releaseDirectoriesAfterDisposal(() => noGit.mockRestore(), []);
  const config = privateStartupConfig(), file = path.join(config.root, "pitako/config.toml");
  const priorInstance = process.env.PITAKO_INSTANCE_ID;
  delete process.env.PITAKO_INSTANCE_ID;
  fixture.releaseDirectoriesAfterDisposal(() => {
    if (priorInstance === undefined) delete process.env.PITAKO_INSTANCE_ID; else process.env.PITAKO_INSTANCE_ID = priorInstance;
    config.close();
  }, [config.root]);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '[model_policies.developer.primary]\nmodel = "example/primary"\nreasoning = "off"\n');
  const handlers = new Map<string, Function[]>(), tools = new Map<string, any>();
  async function emit(event: string, input: unknown = {}) {
    let result: any;
    for (const handler of handlers.get(event) ?? []) {
      const value = await handler(input, ctx);
      if (value !== undefined) result = value;
    }
    return result;
  }
  const manager = SessionManager.inMemory(root), sends: { message: any; options: any }[] = [];
  let activeTools: string[] = [];
  let idle = false, failWake = false, afterAppend = () => {}, onWake = () => {};
  pitako({
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
    registerCommand() {}, registerFlag() {}, getFlag() {}, getSessionName: () => "pitako:coding", setSessionName() {},
    getAllTools: () => [...tools.values()].map(tool => ({ ...tool, sourceInfo: { path: "controlled:pitako" } })),
    getActiveTools: () => activeTools, setActiveTools(names: string[]) { activeTools = names; },
    sendMessage(message: any, options: any) {
      sends.push({ message, options });
      if (!options.triggerTurn) {
        manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        afterAppend();
      } else {
        onWake();
        if (failWake) throw new Error("controlled send failure after triggerTurn");
      }
    },
  } as unknown as ExtensionAPI);
  const ctx = { cwd: root, hasUI: false, isIdle: () => idle, ui: { notify() {}, setStatus() {} }, sessionManager: manager };
  await emit("session_start");
  const filePlan = planFile("continuity", root);
  mkdirSync(path.dirname(filePlan), { recursive: true });
  writeFileSync(filePlan, "---\nid: continuity\nrevision: 1\nstatus: frozen\n---\n\nControlled result continuity.\n");
  const activity = phase === "execution"
    ? openExecuteActivity(openExecutionPlan("continuity", root), manager, manager.getSessionId())
    : openPlanActivity("planning-continuity", root, snapshotPlan("planning-continuity", root), manager, manager.getSessionId());
  const unbind = bindCallContext(manager, activity.context), owner = statusOwner(activity.read);
  fixture.beforeRelease(async () => {
    await emit("session_shutdown");
    await activity.retire(); unbind(); owner.guard.close(); owner.store.close();
  });
  async function start() {
    let finish!: (value: Attempt) => void;
    const completion = fixture.pendingAttempt(resolve => { finish = resolve; });
    // pendingAttempt installs the resolver synchronously.
    const evaluation = teamEvaluationForSession(manager.getSessionId(), false)!;
    const handle = await spawnBackground({ roleId: "developer", task: "bounded controlled result", cwd: root,
      load: { userConfigPath: file, env: { PI_CODING_AGENT_DIR: config.root } },
      executor: { async start() { return completion; } },
      teamOwner: { token: evaluation.token, assignmentId: `assignment-${owner.store.all("attempts").length}`, onSettled() {} },
      context: activity.context });
    return { handle, finish: (result = "controlled terminal") => finish({ status: "completed", result, sideEffects: false }),
      intermediate: (turn = "turn-1") => publishIntermediate(evaluation.token, handle.instanceId, "room", turn, `response ${turn}`) };
  }
  return { root, manager, ctx, activity, owner, sends, start, activeTools: () => activeTools,
    idle: (value: boolean) => { idle = value; }, failWake: () => { failWake = true; },
    afterAppend: (callback: () => void) => { afterAppend = callback; },
    onWake: (callback: () => void) => { onWake = callback; },
    emit,
    async invoke(input: unknown) {
      const event = { toolName: "execution_disposition", toolCallId: "claim", input };
      const admission = await emit("tool_call", event);
      if (admission?.block) throw new Error(admission.reason);
      const tool = tools.get(event.toolName)!;
      if (!Value.Check(tool.parameters, input)) throw new Error("invalid registered disposition arguments");
      const result = await tool.execute(event.toolCallId, input, undefined, undefined, ctx);
      await emit("tool_result", { ...event, ...result });
      return result;
    },
    obligations: () => owner.store.all<ResultObligation>("obligations").filter(item => item.resultId),
  };
}

async function effectiveResult(phase: "planning" | "execution" = "execution") {
  const host = await mounted(phase), worker = await host.start();
  const anchor = host.manager.appendCustomMessageEntry("fixture.anchor", "before result", false);
  worker.finish(); await fixture.settleRuns();
  const draft = await host.emit("agent_before_settle", { outcome: "completed" });
  for (const entry of draft.entries) host.manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  await host.emit("turn_start");
  const wait = (producerRef: unknown, afterSequence = 0) => {
    const obligation = host.obligations()[0]!;
    return host.invoke({ op: "record", obligationId: obligation.obligationId, expectedVersion: obligation.version,
      reason: "Wait for the exact independent proof of already authorized work",
      choice: { kind: "wait", producerRef, afterSequence } });
  };
  return { ...host, anchor, wait };
}

for (const phase of ["execution", "planning"] as const) {
  test(`registered user-decision projects only its captured ${phase} source`, fixture.ownedCase(`${phase} user-decision`, async () => {
    const host = await effectiveResult(phase), obligation = host.obligations()[0]!;
    const ledger = ledgerFile(host.owner.run.planId, host.root);
    const source = planFile("continuity", host.root), original = readFileSync(source, "utf8");
    if (phase === "execution") {
      // Opaque existing body/holds are not a license to rewrite or clear them.
      writeFileSync(ledger, readFileSync(ledger, "utf8").replace("\n[]\n",
        '\n[{"assignmentId":"retained-hold","unitId":"other","status":"failed"}]\n') + "\nstatus: body stays untouched\n");
    }
    const before = phase === "execution" ? readFileSync(ledger, "utf8") : undefined;
    const result = await host.invoke({ op: "record", obligationId: obligation.obligationId, expectedVersion: obligation.version,
      reason: "The result requires choosing a new externally visible outcome",
      choice: { kind: "user-decision", question: "Which external outcome?", options: ["Keep current scope", "Authorize expanded scope"],
        boundary: "Changes outside the admitted result comparison", evidenceRefs: [obligation.obligationId] } });
    if (before) expect(readFileSync(ledger, "utf8")).toBe(before.replace(/^status: running$/m, "status: USER_DECISION_REQUIRED"));
    else expect(existsSync(ledger)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe(original);
    expect(result.details.userDecisionProjections).toEqual([expect.objectContaining({
      state: phase === "execution" ? "applied" : "not-applicable",
    })]);
    expect(host.owner.store.all<any>("dispositions").filter(item => item.choice?.kind === "user-decision")).toHaveLength(1);
    expect(host.obligations()[0]!.cleared).toBe(false);
  }));
}

test("registered user-decision rejects a changed captured source before committing or projecting", fixture.ownedCase("stale decision source", async () => {
  const host = await effectiveResult(), obligation = host.obligations()[0]!;
  const source = planFile("continuity", host.root), original = readFileSync(source, "utf8");
  const file = ledgerFile("continuity", host.root), ledger = readFileSync(file, "utf8");
  const before = host.owner.store.all("dispositions");
  writeFileSync(source, original + "\nMaterial drift.\n");
  try {
    await expect(host.invoke({ op: "record", obligationId: obligation.obligationId, expectedVersion: obligation.version,
      reason: "Choose an external outcome", choice: { kind: "user-decision", question: "Which outcome?",
        options: ["Stay", "Expand"], boundary: "External scope", evidenceRefs: [obligation.obligationId] } })).rejects.toThrow(/hash|changed/);
    expect(host.owner.store.all("dispositions")).toEqual(before);
    expect(readFileSync(file, "utf8")).toBe(ledger);
  } finally { writeFileSync(source, original); }
}));

for (const blocked of ["legacy-lock", "ledger-binding", "file-failure"] as const) {
  test(`registered user-decision retains commit and exposes ${blocked} projection before exact retry`, fixture.ownedCase(`${blocked} decision`, async () => {
    const host = await effectiveResult(), obligation = host.obligations()[0]!;
    const file = ledgerFile("continuity", host.root), before = readFileSync(file, "utf8");
    const input = { op: "record", obligationId: obligation.obligationId, expectedVersion: obligation.version,
      reason: "Choose an outcome outside the admitted comparison",
      choice: { kind: "user-decision", question: "Which outcome?", options: ["Remain within scope", "Expand scope"],
        boundary: "External scope decision", evidenceRefs: [obligation.obligationId] } };
    if (blocked === "legacy-lock") mkdirSync(`${file}.lock`);
    if (blocked === "ledger-binding") writeFileSync(file, before.replace(/^revision: 1$/m, "revision: 2"));
    if (blocked === "file-failure") { renameSync(file, `${file}.saved`); mkdirSync(file); }
    try {
      const result = await host.invoke(input);
      expect(result.details.userDecisionProjections).toEqual([expect.objectContaining({ state: "blocked",
        diagnostic: expect.stringMatching(blocked === "legacy-lock" ? /lock remains/ : blocked === "ledger-binding" ? /revision/ : /directory|EISDIR/) })]);
      expect(host.obligations()[0]!.version).toBe(obligation.version + 1);
      expect(host.owner.store.all<any>("dispositions").filter(item => item.choice?.kind === "user-decision")).toHaveLength(1);
      if (blocked !== "file-failure") expect(readFileSync(file, "utf8")).not.toContain("USER_DECISION_REQUIRED");
      await expect(host.invoke(input)).rejects.toThrow(/version/);
    } finally {
      if (blocked === "legacy-lock") rmSync(`${file}.lock`, { recursive: true });
      if (blocked === "file-failure") { rmSync(file, { recursive: true }); renameSync(`${file}.saved`, file); }
      if (blocked === "ledger-binding") writeFileSync(file, before);
    }
    const retried = await host.invoke({ op: "inspect" });
    expect(retried.details.userDecisionProjections).toEqual([expect.objectContaining({ state: "applied" })]);
    expect(readFileSync(file, "utf8")).toBe(before.replace(/^status: running$/m, "status: USER_DECISION_REQUIRED"));
    expect(host.owner.store.all<any>("dispositions").filter(item => item.choice?.kind === "user-decision")).toHaveLength(1);
  }));
}

test("native disposition inspection works during planning without admitting generic mutations", fixture.ownedCase("planning disposition admission", async () => {
  const host = await mounted("planning");
  expect(host.activeTools()).toContain("execution_disposition");
  expect((await host.invoke({ op: "inspect" })).details.admissionId).toBe(host.activity.authority.fence.runId);
  const blocked = await host.emit("tool_call", { toolName: "write", toolCallId: "generic", input: { path: "not-authorized", content: "no" } });
  expect(blocked.block).toBe(true);
  expect(blocked.reason).toContain("host slot writer");
}));

test("inline child defense rejects native disposition before any state write", fixture.ownedCase("child disposition defense", async () => {
  const host = await mounted();
  const before = host.owner.store.all("dispositions");
  process.env.PITAKO_INSTANCE_ID = "controlled-child";
  try { await expect(host.invoke({ op: "inspect" })).rejects.toThrow(/AgentInstances cannot control/); }
  finally { delete process.env.PITAKO_INSTANCE_ID; }
  expect(host.owner.store.all("dispositions")).toEqual(before);
}));

for (const throws of [true, false]) {
  test(`final callback attempts one queued continuation when transport ${throws ? "throws" : "succeeds"}`, fixture.ownedCase(`queued ${throws} transport`, async () => {
    const host = await mounted(), worker = await host.start();
    worker.intermediate("queued-one"); worker.intermediate("queued-two");
    worker.finish(); await fixture.settleRuns();
    const initial = await host.emit("agent_before_settle", { outcome: "completed" });
    for (const entry of initial.entries) host.manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    await host.emit("turn_start");
    const obligations = host.obligations();
    expect(obligations).toHaveLength(3);
    for (const [index, obligation] of obligations.entries()) {
      const producer = reserveEffect(host.activity.context, { reservationId: `queued-proof-${index}`, kind: "writer", paths: [host.root] })
        .register("independent-proof", ["host-operation"]);
      producer.enter();
      try {
        const inspection = (await host.invoke({ op: "inspect" })).details;
        const visible = inspection.waitProducers.find((item: any) => item.producerRef.resourceId === producer.ref.resourceId);
        expect(visible).toBeDefined();
        await host.invoke({ op: "record", obligationId: obligation.obligationId, expectedVersion: obligation.version,
          reason: "Wait for the independently owned proof of the authorized comparison",
          choice: { kind: "wait", producerRef: visible.producerRef, afterSequence: visible.afterSequence } });
        expect(producer.observe("host-operation", "closed", true)).toBeDefined();
      } finally { if (producer.live) producer.observe("host-operation", "closed", true); }
    }
    const spent = () => host.owner.store.all<any>("dispositions").filter(item => item.kind === "wake-issued" && item.transition === "producer-settled");
    expect(host.sends).toHaveLength(0);
    const terminal = await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } });
    expect(terminal.entries).toHaveLength(1);
    for (const entry of terminal.entries) host.manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    expect(spent()).toHaveLength(1);
    host.idle(true); if (throws) host.failWake();
    await host.emit("agent_settled");
    expect(host.sends.filter(item => item.options.triggerTurn)).toHaveLength(1);
    expect(spent()).toHaveLength(2);
    // A new legitimate boundary may spend the distinct producer transition,
    // but must not retry the throwing cause or silently drain it in the first callback.
    await host.emit("turn_start");
    await host.emit("agent_settled");
    expect(host.sends.filter(item => item.options.triggerTurn)).toHaveLength(2);
    expect(spent()).toHaveLength(3);
    await host.emit("agent_settled");
    expect(host.sends.filter(item => item.options.triggerTurn)).toHaveLength(2);
    expect(spent()).toHaveLength(3);
    expect(host.obligations().every(item => !item.cleared)).toBe(true);
  }));
}

for (const port of ["foreground", "host"] as const) {
  for (const mode of ["busy", "idle"] as const) {
    test(`${port} wait discovers an initial live reference and notifies its ${mode} original owner once`, fixture.ownedCase(`${port} ${mode} wait`, async () => {
      const host = await effectiveResult();
      const producer = reserveEffect(host.activity.context, { reservationId: "independent-wait", kind: "writer", paths: [host.root] })
        .register("independent-proof", ["host-operation"]);
      producer.enter();
      try {
        // The foreground positive must discover the tuple through the registered
        // public tool, not a private registry or a supplied host reference.
        const inspection = await host.invoke({ op: "inspect" });
        const visible = JSON.parse(inspection.content[0].text);
        const reference = port === "foreground"
          ? visible.waitProducers.find((item: any) => item.adapter === "independent-proof")
          : { producerRef: producer.ref, afterSequence: 0 };
        expect(reference).toBeDefined();
        const obligation = visible.obligations[0];
        const input = { op: "record", obligationId: obligation.obligationId, expectedVersion: obligation.version,
          reason: "Wait for the owned independent proof, not the current tool return",
          choice: { kind: "wait" as const, producerRef: reference.producerRef, afterSequence: reference.afterSequence } };
        if (port === "foreground") await host.invoke(input);
        else recordDisposition(host.activity.authority, { ...input, kind: "result-disposition", unitId: obligation.unitId, resultId: obligation.resultId });
        expect(host.owner.store.fence(host.activity.authority.fence).state).toBe("waiting");
        await host.emit("agent_settled");
        host.idle(mode === "idle");
        let committed = false;
        host.onWake(() => {
          const reader = new WorkflowState(host.root);
          try {
            committed = reader.fence(host.activity.authority.fence).state === "active" &&
              reader.all<any>("dispositions").some(item => item.kind === "wake-issued" && item.transition === "producer-settled" && item.credit === 0);
          } finally { reader.close(); }
        });
        producer.observe("host-operation", "closed", true);
        expect(host.owner.store.fence(host.activity.authority.fence).waitRef).toBeUndefined();
        if (mode === "busy") {
          expect(host.sends).toEqual([]);
          const resumed = await host.emit("agent_before_settle", { outcome: "completed" });
          expect(resumed.continue).toBe(true);
          expect(resumed.entries).toMatchObject([{ customType: "pitako.worker", display: false }]);
          expect(resumed.entries[0].content).toContain("producer-settled");
        } else {
          expect(host.sends.filter(send => send.options.triggerTurn)).toHaveLength(1);
          expect(committed).toBe(true);
        }
        await host.emit("context", { messages: [] }); await host.emit("turn_start");
        await host.emit("agent_settled"); await host.emit("agent_settled");
        const causes = host.owner.store.all<any>("dispositions").filter(item => item.kind === "wake-issued");
        expect(causes.filter(item => item.transition === "result-ready")).toHaveLength(1);
        expect(causes.filter(item => item.transition === "producer-settled")).toHaveLength(1);
        expect(host.owner.store.all<any>("dispositions").filter(item => item.kind === "no-progress" &&
          item.transition === "producer-settled" && item.credit === 0)).toHaveLength(1);
        expect(host.sends.filter(send => send.options.triggerTurn)).toHaveLength(mode === "idle" ? 1 : 0);
        expect(host.obligations().every(item => !item.cleared)).toBe(true);
      } finally { if (producer.live) producer.observe("host-operation", "closed", true); }
    }));
  }
}

test("wait inspection is observational and excludes absent, foreign, lost, historical and dependent producers", fixture.ownedCase("wait reference admission", async () => {
  const host = await effectiveResult();
  const independent = reserveEffect(host.activity.context, { reservationId: "wait-independent", kind: "writer", paths: [host.root] })
    .register("independent-proof", ["host-operation"]);
  const dependent = reserveEffect(host.activity.context, { reservationId: "wait-dependent", kind: "writer", paths: [host.root] })
    .register("host-return", ["host-operation"], "work", "host-return-dependent");
  const observation = host.owner.observation();
  const foreignRoot = mkdtempSync(path.join(tmpdir(), "pitako-wait-foreign-"));
  fixture.directories.push(foreignRoot);
  const guard = new RootGuard(foreignRoot);
  const foreign = reserveEffect({ kind: "ordinary", guard }, { reservationId: "foreign", kind: "writer", paths: [foreignRoot] })
    .register("foreign-proof", ["host-operation"]);
  const lostReservation = reserveEffect(host.activity.context, { reservationId: "lost-registry", kind: "writer", paths: [host.root] });
  const lost = new Producer(lostReservation.store, lostReservation.store.resource(lostReservation.reservation,
    { adapter: "historical-no-handle", scopes: ["host-operation"], purpose: "work" }), () => {});
  const producers = [independent, dependent, observation, foreign, lost];
  for (const producer of producers) producer.enter();
  try {
    const before = host.owner.store.outbox(), dispositions = host.owner.store.all("dispositions");
    const first = await host.invoke({ op: "inspect" }), second = await host.invoke({ op: "inspect" });
    expect(first.details).toEqual(second.details);
    expect(first.details.waitProducers.map((item: any) => item.adapter)).toEqual(["independent-proof"]);
    expect(Object.keys(first.details.waitProducers[0].producerRef).sort()).toEqual(["generation", "producerId", "reservationId", "resourceId"]);
    expect(host.owner.store.outbox()).toEqual(before);
    expect(host.owner.store.all("dispositions")).toEqual(dispositions);
    let ready = 0;
    const check = (ref: typeof independent.ref | undefined, cursor = 0) =>
      waitForProducer(host.activity.authority, ref, cursor, () => { ready++; });
    expect(check(undefined)).toEqual({ kind: "unavailable", reason: "no independent producer" });
    expect(check(dependent.ref)).toEqual({ kind: "deferred", reason: "host-return-dependent" });
    for (const ref of [foreign.ref, lost.ref, observation.ref, { ...independent.ref, generation: 2 },
      { ...independent.ref, producerId: "forged" }, { ...independent.ref, resourceId: "absent" }])
      expect(check(ref).kind).toBe("unavailable");
    expect(check(independent.ref, 1).kind).toBe("unavailable");
    await expect(host.wait({ ...independent.ref, generation: 2 })).rejects.toThrow(/unavailable/);
    await expect(host.wait(dependent.ref)).rejects.toThrow(/host-return-dependent/);
    expect(host.owner.store.fence(host.activity.authority.fence).state).toBe("active");
    expect(host.owner.store.all("dispositions")).toEqual(dispositions);
    // Property order is correlation syntax, not another producer or causal credit.
    const { generation, reservationId, producerId, resourceId } = independent.ref;
    await host.wait({ generation, reservationId, producerId, resourceId });
    independent.observe("host-operation", "unknown", true);
    expect(host.owner.store.fence(host.activity.authority.fence).state).toBe("waiting");
    expect(host.sends).toEqual([]);
    independent.observe("host-operation", "closed", true);
    expect(host.owner.store.fence(host.activity.authority.fence).state).toBe("active");
    expect(check(independent.ref).kind).toBe("unavailable");
    expect((await host.invoke({ op: "inspect" })).details.waitProducers).toEqual([]);
    expect(ready).toBe(0);
    expect(host.obligations().every(item => !item.cleared)).toBe(true);
  } finally {
    for (const producer of producers) {
      const resource = producer.snapshot();
      if (!resource.sealed || resource.scopes.some(scope => resource.facts[scope] !== "closed"))
        for (const scope of resource.scopes) producer.observe(scope, "closed", true);
    }
    guard.close();
  }
}));

for (const timing of ["before-listener", "after-listener", "idle-unsettled", "rejected-commit"] as const) {
  test(`wait install reread handles ${timing} without a precommit notification`, fixture.ownedCase(`wait race ${timing}`, async () => {
    const host = await effectiveResult();
    const producer = reserveEffect(host.activity.context, { reservationId: "wait-race", kind: "writer", paths: [host.root] })
      .register("race-proof", ["host-operation"]);
    producer.enter();
    if (timing !== "idle-unsettled") await host.emit("agent_settled");
    host.idle(true);
    const subscribe = producer.subscribe.bind(producer);
    let committed = false;
    host.onWake(() => {
      const reader = new WorkflowState(host.root);
      try {
        committed = reader.fence(host.activity.authority.fence).state === "active" &&
          reader.all<any>("dispositions").some(item => item.kind === "result-disposition" && item.choice.kind === "wait") &&
          reader.all<any>("dispositions").some(item => item.transition === "producer-settled" && item.credit === 0);
      } finally { reader.close(); }
    });
    producer.subscribe = listener => {
      if (timing === "before-listener") producer.observe("host-operation", "closed", true);
      const stop = subscribe(listener);
      if (timing !== "before-listener") producer.observe("host-operation", "closed", true);
      expect(host.sends).toEqual([]);
      return stop;
    };
    try {
      if (timing === "rejected-commit") {
        const obligation = host.obligations()[0]!;
        await expect(host.invoke({ op: "record", obligationId: obligation.obligationId, expectedVersion: obligation.version + 1,
          reason: "An invalid claim must not notify even if the producer settles during install",
          choice: { kind: "wait", producerRef: producer.ref, afterSequence: 0 } })).rejects.toThrow(/version/);
        expect(host.sends).toEqual([]);
        expect(host.owner.store.all<any>("dispositions").some(item => item.kind === "result-disposition")).toBe(false);
      } else {
        await host.wait(producer.ref);
        if (timing === "idle-unsettled") {
          expect(host.sends).toEqual([]);
          expect(committed).toBe(false);
          const dispositions = host.owner.store.all("dispositions");
          await host.invoke({ op: "inspect" }); await host.invoke({ op: "inspect" });
          expect(host.owner.store.all("dispositions")).toEqual(dispositions);
          expect(host.sends).toEqual([]);
          await host.emit("agent_settled");
        }
        expect(committed).toBe(true);
        expect(host.sends.filter(send => send.options.triggerTurn)).toHaveLength(1);
      }
      expect(host.owner.store.fence(host.activity.authority.fence).state).toBe("active");
      await host.emit("agent_settled");
      expect(host.sends.filter(send => send.options.triggerTurn)).toHaveLength(timing === "rejected-commit" ? 0 : 1);
    } finally {
      producer.subscribe = subscribe;
      if (producer.live) producer.observe("host-operation", "closed", true);
    }
  }));
}

test("host wait joins the outer commit and a replacement request cannot refill its settlement cause", fixture.ownedCase("host wait outer commit", async () => {
  const host = await effectiveResult();
  const producer = reserveEffect(host.activity.context, { reservationId: "wait-outer", kind: "writer", paths: [host.root] })
    .register("outer-proof", ["host-operation"]);
  producer.enter();
  try {
    const obligation = host.obligations()[0]!;
    const before = host.owner.store.all("dispositions");
    const input = { kind: "result-disposition" as const, obligationId: obligation.obligationId,
      unitId: obligation.unitId, resultId: obligation.resultId, expectedVersion: obligation.version,
      reason: "The host captures the same exact producer, without a new cause",
      choice: { kind: "wait" as const, producerRef: producer.ref, afterSequence: 0 } };
    expect(() => host.owner.store.transaction(() => {
      recordDisposition(host.activity.authority, input);
      expect(host.sends).toEqual([]);
      throw new Error("controlled outer rollback");
    })).toThrow(/controlled outer rollback/);
    expect(host.owner.store.all("dispositions")).toEqual(before);
    expect(host.owner.store.fence(host.activity.authority.fence).state).toBe("active");
    host.owner.store.transaction(() => {
      recordDisposition(host.activity.authority, input);
      expect(host.sends).toEqual([]);
    });
    // Replacing a wait for the identical live producer cannot leave the earlier
    // subscriber stealing the new request's notification.
    await host.wait(producer.ref);
    await host.emit("agent_settled"); host.idle(true); host.failWake();
    let committed = false;
    host.onWake(() => {
      const reader = new WorkflowState(host.root);
      try {
        committed = reader.fence(host.activity.authority.fence).state === "active" &&
          reader.all<any>("dispositions").some(item => item.transition === "producer-settled" && item.credit === 0);
      } finally { reader.close(); }
    });
    producer.observe("host-operation", "closed", true);
    expect(committed).toBe(true);
    expect(host.sends.filter(send => send.options.triggerTurn)).toHaveLength(1);
    await host.emit("context", { messages: [] }); await host.emit("turn_start");
    await host.emit("agent_settled"); await host.emit("agent_settled");
    expect(host.owner.store.all<any>("dispositions").filter(item => item.transition === "producer-settled" &&
      item.kind === "wake-issued")).toHaveLength(1);
    expect(host.sends.filter(send => send.options.triggerTurn)).toHaveLength(1);
    await expect(host.wait(producer.ref)).rejects.toThrow(/unavailable/);
  } finally { if (producer.live) producer.observe("host-operation", "closed", true); }
}));

for (const changed of ["retired", "epoch", "phaseEpoch", "session", "branch", "source", "aborted", "error", "superseded"] as const) {
  test(`wait settlement after ${changed} cannot notify a stale owner`, fixture.ownedCase(`stale wait ${changed}`, async () => {
    const host = await effectiveResult();
    const producer = reserveEffect(host.activity.context, { reservationId: "stale-wait", kind: "writer", paths: [host.root] })
      .register("stale-proof", ["host-operation"]);
    producer.enter();
    try {
      await host.wait(producer.ref);
      await host.emit("agent_settled"); host.idle(true);
      if (changed === "retired") await host.activity.retire();
      else if (changed === "epoch" || changed === "phaseEpoch") host.owner.store.transaction(() => {
        const run = host.owner.store.get<typeof host.owner.run>("runs", host.activity.authority.fence.runId)!;
        host.owner.store.put("runs", run.runId, { ...run, [changed]: run[changed] + 1 });
      });
      else if (changed === "session") host.manager.newSession();
      else if (changed === "branch") host.manager.branch(host.anchor);
      else if (changed === "source") {
        const receipt = host.manager.getBranch().find(entry => entry.type === "custom_message" && entry.customType === "pitako.worker.result")!;
        if (receipt.type !== "custom_message") throw new Error("missing controlled receipt");
        receipt.content = "not the captured result";
      } else if (changed === "superseded") {
        const obligation = host.obligations()[0]!;
        await host.invoke({ op: "record", obligationId: obligation.obligationId, expectedVersion: obligation.version,
          reason: "The independent producer is no longer the chosen continuation",
          choice: { kind: "diagnose", missingEvidence: "judgment", safeRemainingWork: "read only" } });
      } else await host.emit("agent_before_settle", { outcome: changed });
      producer.observe("host-operation", "closed", true);
      expect(host.sends).toEqual([]);
      expect(host.owner.store.all<any>("dispositions").filter(item => item.transition === "producer-settled")).toEqual([]);
      if (changed === "aborted" || changed === "error") {
        await host.emit("agent_settled");
        expect(host.sends).toEqual([]);
      }
    } finally { if (producer.live) producer.observe("host-operation", "closed", true); }
  }));
}

test("native inspection and diagnosis preserve unknown producer exclusion", fixture.ownedCase("unknown disposition admission", async () => {
  const host = await mounted(), worker = await host.start();
  worker.finish(); await fixture.settleRuns();
  const draft = await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } });
  for (const entry of draft.entries) host.manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  await host.emit("turn_start");
  const producer = reserveEffect(host.activity.context, { reservationId: "unknown-fixture", kind: "writer", paths: [host.root] })
    .register("controlled-unknown", ["host-operation"]);
  producer.enter(); producer.observe("host-operation", "unknown");
  try {
    const current = (await host.invoke({ op: "inspect" })).details.obligations[0];
    await host.invoke({ op: "record", obligationId: current.obligationId, expectedVersion: current.version, reason: "Unknown producer remains reserved",
      choice: { kind: "diagnose", missingEvidence: "producer closure", safeRemainingWork: "inspect existing evidence" } });
    expect(producer.snapshot().facts["host-operation"]).toBe("unknown");
    const blocked = await host.emit("tool_call", { toolName: "write", toolCallId: "conflicting", input: { path: host.root + "/conflict", content: "no" } });
    expect(blocked.block).toBe(true);
  } finally { producer.observe("host-operation", "closed", true); }
}));

for (const boundary of ["context", "turn_start"] as const) {
  test(`${boundary} enables explicit native dispositions for both channels in the first active turn`, fixture.ownedCase(`${boundary} active disposition`, async () => {
    const host = await mounted(), worker = await host.start();
    worker.intermediate(); worker.finish(); await fixture.settleRuns();
    const draft = await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } });
    for (const entry of draft.entries) host.manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    await host.emit(boundary, boundary === "context" ? { messages: [] } : {});
    const obligations = (await host.invoke({ op: "inspect" })).details.obligations;
    expect(obligations).toHaveLength(2);
    for (const current of obligations) {
      expect(current.boundary).toBe(boundary);
      expect(current.state).toBe("disposition-required");
      await host.invoke({ op: "record", obligationId: current.obligationId, expectedVersion: current.version,
        reason: "Read this named receipt; compare evidence within the current authorization",
        choice: { kind: "diagnose", missingEvidence: "independent comparison", safeRemainingWork: "read recorded evidence" } });
    }
    expect(host.owner.store.all<any>("dispositions").filter(item => item.kind === "result-disposition")).toHaveLength(2);
    expect(host.obligations().every(item => !item.cleared)).toBe(true);
    await host.emit("agent_settled"); await host.emit("agent_settled");
    expect(host.owner.store.all<any>("dispositions").filter(item => item.kind === "no-progress")).toEqual([]);
    expect(host.sends).toEqual([]);
  }));
}

for (const mode of ["idle", "busy"] as const) {
  test(`${mode} credited Worker/Intermediate turn records terminal no-progress once, without another wake`, fixture.ownedCase(`${mode} terminal no-progress`, async () => {
    const host = await mounted(), worker = await host.start();
    worker.intermediate(); worker.finish(); await fixture.settleRuns();
    if (mode === "busy") {
      const draft = await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } });
      for (const entry of draft.entries) host.manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    } else {
      host.idle(true); await host.emit("agent_settled"); await host.emit("agent_settled");
    }
    const wakes = host.sends.filter(send => send.options.triggerTurn).length;
    const diagnostics = () => host.owner.store.all<any>("dispositions").filter(item => item.kind === "no-progress");
    expect(diagnostics()).toEqual([]);
    await host.emit("context", { messages: [] }); await host.emit("turn_start");
    expect(diagnostics()).toEqual([]);
    await host.emit("agent_settled"); await host.emit("agent_settled");
    expect(diagnostics()).toHaveLength(2);
    expect(new Set(diagnostics().map(item => item.cause)).size).toBe(2);
    expect(diagnostics().every(item => item.credit === 0 && item.state === "no-progress")).toBe(true);
    const reader = new WorkflowState(host.root);
    try { expect(reader.all<any>("dispositions").filter(item => item.kind === "no-progress")).toEqual(diagnostics()); }
    finally { reader.close(); }
    expect(host.obligations().every(item => !item.cleared)).toBe(true);
    expect(host.sends.filter(send => send.options.triggerTurn)).toHaveLength(wakes);
    const independent = await host.start();
    independent.finish("independent result"); await fixture.settleRuns();
    if (mode === "busy") {
      const draft = await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } });
      expect(draft.entries).toHaveLength(1); expect(draft.continue).toBe(true);
    } else expect(host.sends.filter(send => send.options.triggerTurn)).toHaveLength(wakes + 1);
  }));
}

test("mounted Worker/Intermediate receipts require effective context, never final-only presence", fixture.ownedCase("common receipt boundaries", async () => {
  const host = await mounted(), worker = await host.start();
  const prior = host.manager.appendCustomMessageEntry("fixture.anchor", "before results", false);
  worker.intermediate(); worker.finish(); await fixture.settleRuns();
  const draft = await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } });
  expect(draft.entries).toHaveLength(2); expect(draft.continue).toBe(true);
  expect(host.obligations().map(item => item.state)).toEqual(["pending-receipt", "pending-receipt"]);
  await host.emit("context", { messages: [] }); await host.emit("turn_start");
  for (const entry of draft.entries) host.manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  await host.emit("agent_settled");
  expect(host.obligations().every(item => item.state === "receipt" && !item.boundary && !item.cleared)).toBe(true);
  const result = host.obligations()[0]!;
  await expect(host.invoke({ op: "record", obligationId: result.obligationId, expectedVersion: result.version, reason: "not yet",
    choice: { kind: "continue", admissionId: host.activity.authority.fence.runId } })).rejects.toThrow(/boundary/);
  const leaf = host.manager.getLeafId()!;
  host.manager.branch(prior);
  await host.emit("context", { messages: [] }); await host.emit("agent_settled");
  expect(host.obligations().every(item => !item.boundary)).toBe(true);
  host.manager.branch(leaf);
  const receipts = host.manager.getBranch().filter(entry => entry.type === "custom_message" &&
    ["pitako.worker.result", "pitako.architecture.response"].includes(entry.customType));
  expect(receipts).toHaveLength(2);
  for (const field of ["content", "customType", "deliveryId"] as const) {
    const restore = receipts.map(receipt => {
      if (receipt.type !== "custom_message") throw new Error("missing receipt");
      if (field === "deliveryId") {
        const original = receipt.details as { deliveryId: string };
        receipt.details = { ...original, deliveryId: `${original.deliveryId}mutated` };
        return () => { receipt.details = original; };
      }
      if (field === "customType") {
        const original = receipt.customType;
        receipt.customType = `${original}mutated`;
        return () => { receipt.customType = original; };
      }
      const original = receipt.content;
      receipt.content = `${original}mutated`;
      return () => { receipt.content = original; };
    });
    await host.emit("context", { messages: [] }); await host.emit("agent_settled");
    expect(host.obligations().every(item => !item.boundary)).toBe(true);
    restore.forEach(reset => reset());
  }
  await host.emit("context", { messages: [] }); await host.emit("turn_start"); await host.emit("agent_settled");
  expect(host.obligations().every(item => item.state === "disposition-required" && item.boundary === "turn_start" && !item.cleared)).toBe(true);
  const previous = host.obligations()[0]!;
  // A new, identical receipt appended at the final frontier cannot borrow the old entry's boundary.
  host.manager.branch(prior);
  for (const entry of draft.entries) host.manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  await expect(host.invoke({ op: "record", obligationId: previous.obligationId, expectedVersion: previous.version,
    reason: "An identical new entry has not crossed its own effective boundary",
    choice: { kind: "continue", admissionId: host.activity.authority.fence.runId } })).rejects.toThrow(/current branch/);
  await host.emit("agent_settled");
  expect(host.obligations().every(item => item.state === "receipt" && !item.boundary && !item.cleared)).toBe(true);
  expect(host.sends).toEqual([]);
}));

test("mounted reasoned dispositions fence admissions and accept only the named result", fixture.ownedCase("common reasoned disposition", async () => {
  const host = await mounted(), worker = await host.start();
  worker.intermediate(); worker.finish(); await fixture.settleRuns();
  const draft = await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } });
  for (const entry of draft.entries) host.manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  await host.emit("turn_start");
  const current = host.obligations()[0]!;
  await host.invoke({ op: "record", obligationId: current.obligationId, expectedVersion: current.version, reason: "Evidence needs comparison",
    choice: { kind: "diagnose", missingEvidence: "independent judgment", safeRemainingWork: "read the selected result" } });
  await expect(host.invoke({ op: "record", obligationId: current.obligationId, expectedVersion: current.version, reason: "stale",
    choice: { kind: "continue", admissionId: host.activity.authority.fence.runId } })).rejects.toThrow(/version/);
  const diagnosed = host.obligations().find(item => item.obligationId === current.obligationId)!;
  await expect(host.invoke({ op: "record", obligationId: diagnosed.obligationId, expectedVersion: diagnosed.version, reason: "wrong admission",
    choice: { kind: "continue", admissionId: "foreign" } })).rejects.toThrow(/admission/);
  await expect(host.invoke({ op: "record", obligationId: diagnosed.obligationId, expectedVersion: diagnosed.version, reason: "technical failure is not a human choice",
    choice: { kind: "user-decision", question: "Retry?", options: ["retry"], boundary: "outside envelope", evidenceRefs: [diagnosed.obligationId] } })).rejects.toThrow(/concrete choice/);
  await host.invoke({ op: "record", obligationId: diagnosed.obligationId, expectedVersion: diagnosed.version, reason: "Continue the admitted comparison only",
    choice: { kind: "continue", admissionId: host.activity.authority.fence.runId } });
  expect(host.obligations().every(item => !item.cleared)).toBe(true);
  await host.emit("agent_settled");
  expect(host.owner.store.all<any>("dispositions").filter(item => item.kind === "no-progress" && item.obligationId === current.obligationId)).toEqual([]);
  expect(host.sends).toEqual([]);
  const named = host.obligations().find(item => item.message.customType === "pitako.worker.result")!;
  const other = host.obligations().find(item => item.obligationId !== named.obligationId)!;
  await expect(host.invoke({ op: "record", obligationId: named.obligationId, expectedVersion: named.version, reason: "invalid evidence",
    choice: { kind: "accept", resultRefs: [named.obligationId], evidenceRefs: ["foreign"], reviewClaim: "bounded claim" } })).rejects.toThrow(/foreign result/);
  await host.invoke({ op: "record", obligationId: named.obligationId, expectedVersion: named.version,
    reason: "Compared this named result with the controlled evidence; no claim for any other obligation",
    choice: { kind: "accept", resultRefs: [named.obligationId], evidenceRefs: [other.obligationId], reviewClaim: "named-result comparison" } });
  expect(host.obligations().find(item => item.obligationId === named.obligationId)?.cleared).toBe(true);
  expect(host.obligations().find(item => item.obligationId === other.obligationId)?.cleared).toBe(false);
  expect(host.owner.run.state).toBe("active");
  const inspection = await host.invoke({ op: "inspect" });
  expect(inspection.details.obligations.every((item: object) => !("message" in item))).toBe(true);
}));

test("mounted channels share one trigger attempt per callback; send throws and new requests never refill a cause", fixture.ownedCase("common causal credit", async () => {
  const host = await mounted(), worker = await host.start();
  worker.intermediate(); worker.finish(); await fixture.settleRuns();
  host.idle(true); host.failWake();
  host.onWake(() => { host.emit("agent_settled"); });
  await host.emit("agent_settled");
  expect(host.sends.map(send => send.options.triggerTurn)).toEqual([false, true]);
  await host.emit("agent_settled");
  expect(host.sends.map(send => send.options.triggerTurn)).toEqual([false, true, false, true]);
  for (let request = 0; request < 4; request++) await host.emit("agent_settled");
  expect(host.sends).toHaveLength(4);
  const spent = host.owner.store.all<any>("dispositions").filter(item => item.kind === "wake-issued");
  expect(spent).toHaveLength(2);
  expect(spent.every(item => item.credit === 0 && item.envelope && item.unitId && item.state === "wake-issued" &&
    item.transition === "result-ready" && item.fence.runId === host.activity.authority.fence.runId)).toBe(true);
  // Failed sends and duplicate notifications alone are not a receipt-bearing turn.
  expect(host.owner.store.all<any>("dispositions").some(item => item.kind === "no-progress")).toBe(false);
  await host.emit("context", { messages: [] }); await host.emit("turn_start"); await host.emit("agent_settled");
  expect(host.owner.store.all<any>("dispositions").some(item => item.kind === "no-progress")).toBe(true);
  expect(workerHandoff(worker.handle.instanceId)?.continuationDiagnostic).toContain("no-progress");
  const independent = await host.start();
  independent.finish("genuinely new result"); await fixture.settleRuns();
  expect(host.sends.filter(send => send.options.triggerTurn)).toHaveLength(3);
}));

test("retirement inside append fences original-source wake but keeps terminal facts", fixture.ownedCase("common source retirement", async () => {
  const host = await mounted(), worker = await host.start();
  worker.finish(); await fixture.settleRuns();
  host.idle(true);
  host.afterAppend(() => { void host.activity.retire(); });
  await host.emit("agent_settled");
  await host.activity.retire();
  expect(host.sends.map(send => send.options.triggerTurn)).toEqual([false]);
  expect(host.owner.store.all<any>("attempts")[0].outcome.result).toBe("controlled terminal");
  expect(host.owner.store.all<any>("dispositions").filter(item => item.kind === "wake-issued")).toEqual([]);
}));

test("busy redelivery keeps its legacy offer budget without replaying continuation credit", fixture.ownedCase("common busy redelivery", async () => {
  const host = await mounted(), worker = await host.start();
  worker.intermediate(); worker.finish(); await fixture.settleRuns();
  const first = await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } });
  expect(first.entries).toHaveLength(2); expect(first.continue).toBe(true);
  await host.emit("agent_settled");
  const second = await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } });
  expect(second.entries).toEqual(first.entries); expect(second.continue).toBe(false);
  await host.emit("agent_settled");
  expect(await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } })).toBeUndefined();
  expect(host.sends).toEqual([]);
  expect(host.owner.store.all<any>("dispositions").filter(item => item.kind === "wake-issued")).toHaveLength(2);
}));

for (const changed of ["epoch", "phaseEpoch"] as const) {
  test(`an obsolete ${changed} cannot lend result credit to another phase`, fixture.ownedCase(`common stale ${changed}`, async () => {
    const host = await mounted(), worker = await host.start();
    worker.intermediate(); worker.finish(); await fixture.settleRuns();
    const draft = await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } });
    expect(draft.continue).toBe(true);
    host.owner.store.transaction(() => {
      const run = host.owner.store.get<typeof host.owner.run>("runs", host.activity.authority.fence.runId)!;
      host.owner.store.put("runs", run.runId, { ...run, [changed]: run[changed] + 1 });
    });
    for (const entry of draft.entries) host.manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    host.idle(true);
    await host.emit("context", { messages: [] }); await host.emit("turn_start"); await host.emit("agent_settled");
    expect(await host.emit("agent_before_settle", { outcome: "completed", context: { canContinue: false } })).toBeUndefined();
    expect(host.sends).toEqual([]);
    expect(host.owner.store.all<any>("dispositions").filter(item => item.kind === "wake-issued")).toHaveLength(2);
  }));
}
