import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { cancelManagedAttempt } from "../extensions/agent/managed-mission.ts";
import agentExtension from "../extensions/agent/index.ts";
import { askMissionChoice, recordOperatorChoice, recordOperatorInput, withdrawMissionChoice } from "../extensions/mission/admission.ts";
import type { DurableAttemptContext } from "../extensions/agent/run.ts";
import { createPiMissionRunner, missionCorrectionNo, MissionEngine, type MissionAttemptBinding } from "../extensions/mission/engine.ts";
import { readSealedWorkspaceImage } from "../extensions/mission/reconcile.ts";
import { captureWorkspaceImage } from "../extensions/mission/workspace.ts";
import { createFixtureRejectionCapture, createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "./mission-fixtures.ts";
import { installMissionLocalProvider, type LocalProviderFixture } from "./mission-local-provider.ts";

const request = JSON.stringify({
  format: "mission-consultation-request-v1", question: "Review private candidate", evidenceRefs: ["evidence:a"],
  members: ["one", "two", "three"].map((id) => ({ id, role: "developer", perspective: id })), synthesisRole: "developer",
});

function responseFor(prompt: string): string {
  if (prompt.includes("mission-singleton-continuation-v1") || prompt.includes("Unit: independent")) return "continuation result";
  if (!prompt.startsWith("Read-only ")) return request;
  const bundle = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1).split("\n", 1)[0]!);
  if (!bundle.targetId && bundle.round === "independent" && bundle.memberId === "alpha" && !bundle.childResultHash) return request;
  return teamResponse(bundle);
}

function teamResponse(bundle: { phase: string; round: string; memberId: string; targetId?: string; childResultHash?: string; priorFindings?: Array<{ id: string; evidenceRefs: string[] }> }) {
  if (bundle.round === "synthesis") return JSON.stringify({
    format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
    classifications: (bundle.priorFindings ?? []).map(({ id, evidenceRefs }) =>
      ({ findingId: id, evidenceRefs, category: "uncertainty", reason: "Host verification required" })),
  });
  const peer = bundle.priorFindings?.find(({ id }) => !id.includes(`:${bundle.memberId}:`)) ?? bundle.priorFindings?.[0];
  const detail = bundle.phase === "review" ? { criterion: "Correctness", observation: "Inspect" }
    : bundle.phase === "planning" ? { proposal: "Inspect", constraints: "Bound" }
    : { recommendation: "Check", impact: "Bound" };
  return JSON.stringify({
    format: "mission-team-response-v1", phase: bundle.phase, round: bundle.round, memberId: bundle.memberId,
    findings: [{ id: "f", claim: "Inspect", evidenceRefs: ["evidence:a"], detail,
      ...(peer ? { respondsTo: { id: peer.id, evidenceRefs: peer.evidenceRefs } } : {}) }],
  });
}

type HeldResponse = { started(prompt: string): void; released: Promise<void> };

async function holdStream(provider: LocalProviderFixture, select: (prompt: string, sessionId: string) => HeldResponse | undefined) {
  const globalKey = `__${provider.provider.replace(/\W/g, "_")}`;
  const installed = (globalThis as Record<string, unknown>)[globalKey] as {
    streamSimple: (selected: { id: string }, context: { messages?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>; tools?: unknown[] }, requestOptions?: { sessionId?: string }) => void;
  };
  const eventStreamModule: string = "@earendil-works/pi-ai/utils/event-stream.js";
  const eventStream = await import(eventStreamModule);
  installed.streamSimple = function (selected, context, requestOptions = {}) {
    const prompt = [...(context.messages ?? [])].reverse().find((message) => message.role === "user")?.content
      ?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
    const text = responseFor(prompt);
    provider.trace.push({
      sessionId: requestOptions.sessionId ?? "missing-session-id", provider: provider.provider, model: selected.id,
      prompt, messageCount: context.messages?.length ?? 0, response: text, cost: 0, toolCount: context.tools?.length ?? 0,
    });
    const stream = eventStream.createAssistantMessageEventStream();
    const finish = () => {
      const message = {
        role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: provider.provider,
        model: selected.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 17, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const partial = { ...message, content: [{ type: "text", text: "" }] };
      stream.push({ type: "start", partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: { ...partial, content: [{ type: "text", text }] } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    };
    const held = select(prompt, requestOptions.sessionId ?? "");
    if (held) {
      held.started(prompt);
      held.released.then(finish, finish);
    } else queueMicrotask(finish);
    return stream;
  };
}

async function reopen(sample: { dbPath: string; objectDir: string }, missionId: string) {
  const node = spawnSync("node", ["scripts/mission-pause-interruption-node.mjs", sample.dbPath, sample.objectDir, missionId],
    { cwd: process.cwd(), encoding: "utf8", timeout: 45000 });
  expect(node.status, node.stderr + node.stdout).toBe(0);
}

function writableDefinition(sample: ReturnType<typeof createMissionFixture>) {
  const definition = missionDefinition();
  definition.budget = { roleLaunches: 8, providerRequests: 8, tokens: 8000, activeTimeMs: 240000, artifactBytes: 4_000_000 };
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  return definition;
}

test("host pause error text does not grant interruption without SDK disposal", async () => {
  const sample = createMissionFixture("pitako-pause-deny-");
  const definition = writableDefinition(sample);
  definition.units[0]!.retryLimit = 1;
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  let calls = 0;
  const store = await openFixtureStore(sample);
  try {
    const mission = store.createMission(missionInput(sample));
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      runRole: async (_input, durable) => {
        calls++;
        if (calls > 1) return { instanceId: "x", role: "developer", status: "completed", model: { selectedModel: "fixture/local" }, result: "unauthorized replay" };
        release();
        const signal = durable.signal as AbortSignal;
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
        throw new Error("unreachable");
      },
    });
    engine.start();
    await started;
    await engine.control("pause", { id: "operator-pause", text: "/mission pause" });
    const events = store.inspectMission(mission.id).events;
    const receipt = events.find((event) => event.kind === "attempt.receipt");
    expect(receipt?.payload.status).toBe("failed");
    expect(String(receipt?.payload.error)).toContain("host pause");
    expect(events.some((event) => event.kind === "attempt.settled" && event.payload.status === "interrupted")).toBe(false);
    expect(events.some((event) => event.kind === "unit.blocked" || event.kind === "unit.accepted")).toBe(false);
    expect(String(events.find((event) => event.kind === "resource.wait" && event.payload.resource === "pause-interruption")?.payload.reason))
      .toContain("SDK disposal is unproven");
    await engine.control("resume");
    await engine.waitForIdle();
    expect(calls).toBe(1);
    expect(store.inspectMission(mission.id).events.filter((event) => event.kind === "attempt.reserved")).toHaveLength(1);
    await engine.close();
  } finally {
    store.close();
    rmSync(sample.base, { recursive: true, force: true });
  }
});

test("orderly close retains stopped identity without inventing SDK proof; saved policy never bypasses manual pause or navigation", async () => {
  for (const reason of ["quit", "new"]) {
    const sample = createMissionFixture("pitako-close-deny-");
    writableDefinition(sample);
    const store = await openFixtureStore(sample);
    let calls = 0;
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => { started = resolve; });
    const mission = store.createMission(missionInput(sample));
    const engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      runRole: async (_input, durable) => {
        calls++;
        started();
        const signal = durable.signal as AbortSignal;
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
        throw new Error("unreachable");
      },
    });
    engine.start();
    await dispatched;
    await engine.retireForShutdown(reason);
    const reopened = await openFixtureStore(sample);
    try {
      const inspection = reopened.inspectMission(mission.id);
      const pause = [...inspection.events].reverse().find((event) => event.kind === "mission.paused")!;
      const release = [...inspection.events].reverse().find((event) => event.kind === "mission.owner.released")!;
      const stopped = pause.payload.stoppedAttempts as Array<{ attemptId: string }>;
      expect(pause.payload.controlOrigin).toBe("lifecycle");
      expect(pause.payload.resumeAfterClose).toBe(reason === "quit");
      expect(release.payload.pauseEventId).toBe(pause.eventId);
      expect(release.payload.interruptedAttempts).toEqual(stopped.map(({ attemptId }) => attemptId));
      expect(inspection.events.some((event) => event.kind === "attempt.settled" && event.payload.status === "interrupted")).toBe(false);
      expect(String(inspection.events.find((event) => event.kind === "resource.wait" &&
        event.payload.resource === "pause-interruption")?.payload.reason)).toContain("SDK disposal is unproven");
      const successor = new MissionEngine({
        store: reopened, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
        managedWorkspace: { sourceRoot: sample.root }, runRole: async () => {
          calls++;
          throw new Error("unproven stop must not replay");
        },
      });
      if (reason === "new") await expect(successor.resumeAfterClose()).rejects.toThrow("saved close policy");
      await successor.control("pause");
      const manual = [...reopened.inspectMission(mission.id).events].reverse().find((event) => event.kind === "mission.paused")!;
      expect(manual.payload.controlOrigin).toBe("operator");
      expect(manual.payload.resumeAfterClose).toBe(false);
      await expect(successor.resumeAfterClose()).rejects.toThrow("saved close policy");
      await successor.control("cancel");
      await expect(successor.control("resume")).rejects.toThrow("terminal mission");
      expect(calls).toBe(1);
      await successor.close();
    } finally {
      reopened.close();
      rmSync(sample.base, { recursive: true, force: true });
    }
  }
});

test("cancel and a prior failed receipt do not acquire pause proof", async () => {
  const sample = createMissionFixture("pitako-pause-cancel-");
  writableDefinition(sample);
  const store = await openFixtureStore(sample);
  try {
    const mission = store.createMission(missionInput(sample));
    let mode: "cancel" | "fail" = "cancel";
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      runRole: async (_input, durable) => {
        if (mode === "fail") return { instanceId: "x", role: "developer", status: "failed", model: { selectedModel: "fixture/local" }, result: "ordinary failure" };
        release();
        const signal = durable.signal as AbortSignal;
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
        throw new Error("unreachable");
      },
      assessPredicate: () => ({ verdict: "fail", method: "host" }),
    });
    engine.start();
    await started;
    const attemptId = store.inspectMission(mission.id).events.find((event) => event.kind === "attempt.started")!.attemptId!;
    expect(engine.cancelAttempt(attemptId)).toBe(true);
    for (let i = 0; i < 50 && !store.inspectMission(mission.id).events.some((event) => event.kind === "attempt.receipt"); i++) await Bun.sleep(10);
    await engine.control("pause", { id: "operator-pause", text: "/mission pause" });
    const paused = store.inspectMission(mission.id);
    const pause = paused.events.find((event) => event.kind === "mission.paused")!;
    expect(pause.payload.stoppedAttempts).toEqual([]);
    expect(paused.events.some((event) => event.payload?.status === "interrupted" || event.payload?.format === "mission-pause-interruption-v1")).toBe(false);
    await engine.control("cancel");
    await engine.close();

    mode = "fail";
    const second = store.createMission(missionInput(sample, { commandId: crypto.randomUUID(), admissionReceiptId: crypto.randomUUID() }));
    const failed = new MissionEngine({
      store, missionId: second.id, sessionsDirectory: path.join(sample.base, "sessions"),
      runRole: async () => ({ instanceId: "x", role: "developer", status: "failed", model: { selectedModel: "fixture/local" }, result: "ordinary failure" }),
      assessPredicate: () => ({ verdict: "fail", method: "host" }),
    });
    failed.start();
    await failed.waitForIdle();
    await failed.control("pause", { id: "later-pause", text: "/mission pause" });
    const later = store.inspectMission(second.id);
    expect(later.events.find((event) => event.kind === "mission.paused")?.payload.stoppedAttempts).toEqual([]);
    expect(later.events.some((event) => event.kind === "attempt.settled" && event.payload.status === "interrupted")).toBe(false);
    expect(later.events.some((event) => event.kind === "attempt.settled" && event.payload.status === "failed")).toBe(true);
    await failed.close();
  } finally {
    store.close();
    rmSync(sample.base, { recursive: true, force: true });
  }
});

const sdkPauseCases = ["writable", "read-only", "unknown-effect", "resume-writable", "resume-read-only", "repair-writable",
    "repeat-writable", "node-writable", "node-read-only", "missing-writable", "unknown-usage-writable", "source-writable",
    "cancel-writable", "revision-writable", "input-writable", "policy-writable", "budget-writable", "capacity-writable", "crash-writable", "corrected-writable", "repair-cap-writable",
    "assessment-cancel-writable", "assessment-current-cancel-writable", "assessment-source-writable", "lost-proof-writable", "bundle-drift-read-only", "repeat-repair-cap-writable", "observation-source-writable", "provider-source-writable", "mission-cancel-writable", "death-producer"] as const;
test.each(sdkPauseCases.filter((scenario) => (!process.env.PITAKO_PAUSE_CASE || process.env.PITAKO_PAUSE_CASE === scenario) &&
  (scenario !== "death-producer" || process.env.PITAKO_PAUSE_DEATH_FILE)))(
  "live SDK pause binds restored tree and interruption controls (%s)", async (scenario) => {
    if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
    const resume = /^(resume|repair|repeat|corrected|assessment|provider)-/.test(scenario);
    const kind = scenario.endsWith("read-only") ? "read-only" : scenario === "unknown-effect" ? "unknown-effect" : "writable";
    const denied = /^(source|cancel|revision|input|policy|budget|capacity|lost-proof|bundle-drift|observation|mission-cancel)-/.test(scenario);
    const verificationBlocked = scenario === "repair-cap-writable" || scenario === "repeat-repair-cap-writable" || scenario.startsWith("assessment-") || scenario.startsWith("provider-");
    const sample = createMissionFixture(`pitako-pause-${kind}-`);
    const previous = process.env.PI_CODING_AGENT_DIR;
    const agentDir = path.join(sample.base, "agent");
    const config = path.join(agentDir, "pitako", "config.toml");
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, "");
    mkdirSync(path.join(sample.root, "src"), { recursive: true });
    writeFileSync(path.join(sample.root, "src", "target.txt"), "source\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const rejectionCapture = createFixtureRejectionCapture(process.env.PITAKO_PAUSE_EVIDENCE_DIR ?
      path.join(process.env.PITAKO_PAUSE_EVIDENCE_DIR, `${scenario}-rejections`) : undefined, scenario);
    const provider = await installMissionLocalProvider({
      agentDir, provider: `pitako-pause-${kind}`,
      responseForPrompt: responseFor,
    });
    let releaseHold = () => {};
    const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
    let mark = (_prompt: string) => {};
    const started = new Promise<string>((resolve) => { mark = resolve; });
    let releaseSecondHold = () => {};
    const secondHold = new Promise<void>((resolve) => { releaseSecondHold = resolve; });
    let secondMark = (_prompt: string) => {};
    const secondStarted = new Promise<string>((resolve) => { secondMark = resolve; });
    const heldAttempts = new Map<string, HeldResponse>();
    let firstInterruptedAttempt: string | undefined;
    let secondArmed = false;
    let phase = "first-start";
    let selectPrompt = (prompt: string) => kind !== "read-only" ? prompt.includes("mission-singleton-continuation-v1") : prompt.includes("childResultHash");
    let promptHold: HeldResponse = { started: mark, released: hold };
    await holdStream(provider, (prompt, sessionId) => {
      if (scenario !== "repeat-writable") return selectPrompt(prompt) ? promptHold : undefined;
      expect(sessionId).not.toBe("");
      return heldAttempts.get(sessionId);
    });
    const definition = missionDefinition();
    if (kind !== "read-only") {
      definition.units[0]!.id = "impl";
      definition.units[0]!.kind = "implementation";
      definition.units[0]!.inputs = ["evidence:a"];
      definition.units[0]!.retryLimit = scenario === "repeat-repair-cap-writable" ? 2 : 1;
      definition.authority.operations = ["write"];
      definition.authority.allowedPaths = ["src/**"];
    } else {
      definition.units = [{
        id: "experts", dependencies: [], kind: "team", role: "developer", inputs: ["evidence:a"], outputs: ["advice"],
        acceptance: [{ id: "advice", kind: "manual", target: "host" }], risk: "medium", retryLimit: 1,
        team: { version: 1, phase: "review", synthesisRole: "developer", members: ["alpha", "beta", "gamma"].map((id) =>
          ({ id, role: "developer", perspective: id })) },
      }];
      definition.finalization.requiredPredicates = ["advice"];
    }
    if (scenario === "capacity-writable") definition.units.push({
      ...definition.units[0]!, id: "independent", acceptance: [{ id: "independent", kind: "manual", target: "host" }],
    });
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [] };
    const launches = scenario === "budget-writable" ? 14 : scenario === "capacity-writable" ? 15 : 40;
    definition.budget = { roleLaunches: launches, providerRequests: launches, tokens: launches * 1000,
      activeTimeMs: launches * 60_000, artifactBytes: launches * 100_000 };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    const store = await openFixtureStore(sample);
    let engine: MissionEngine | undefined;
    let capturedMissionId: string | undefined;
    let receiptsCaptured = false;
    const captureReceipts = async () => {
      if (!process.env.PITAKO_PAUSE_EVIDENCE_DIR || !capturedMissionId || receiptsCaptured) return;
      const out = path.join(process.env.PITAKO_PAUSE_EVIDENCE_DIR, `${scenario}-receipts`);
      try {
        mkdirSync(out, { recursive: true });
        writeFileSync(path.join(out, "journal-before-cleanup.json"), JSON.stringify(store.inspectMission(capturedMissionId), null, 2));
        writeFileSync(path.join(out, "phase.json"), JSON.stringify({ scenario, phase, firstInterruptedAttempt, secondArmed }));
        await store.exportMission(capturedMissionId, path.join(out, "export"));
        provider.flush(path.join(out, "provider.json"));
        receiptsCaptured = true;
      } catch (error) {
        try { writeFileSync(path.join(out, "capture-error.txt"), String(error)); } catch { /* preserve original assertions and cleanup */ }
      }
    };
    let continuationEffects: DurableAttemptContext["effects"];
    try {
      const mission = store.createMission(missionInput(sample));
      capturedMissionId = mission.id;
      const runner = createPiMissionRunner({
        cwd: sample.root, executor: createPiExecutor(),
        load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config },
      });
      engine = new MissionEngine({
        store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"), ownerSessionId: `pause-${kind}`,
        managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
        ...(rejectionCapture ? { captureRejection: rejectionCapture.captureRejection } : {}),
        ...(scenario === "capacity-writable" ? { maxConcurrent: 1 } : {}),
        runRole: async (input, durable) => {
          if ((scenario === "corrected-writable" || scenario === "repair-cap-writable") && input.binding.attemptNo === 1 && !input.binding.teamBundleHash)
            return { instanceId: input.binding.attemptId, role: "developer", status: "failed", model: { selectedModel: "fixture/local" }, result: "actual ordinary failure" };
          if (scenario === "unknown-usage-writable" && input.binding.continuationOf && !input.binding.recoveryOf)
            durable.onProviderReceipt = () => {};
          if (kind === "writable" && input.unit.id !== "independent" && !input.binding.continuationOf && !input.binding.teamBundleHash) {
            const effect = await durable.effects!.invoke("write", { path: "src/parent-marker.txt", content: "parent\n" });
            expect(effect.status).toBe("completed");
          }
          if (input.binding.recoveryOf || input.binding.recoveryMode === "repair") {
            if (kind === "writable") {
              expect(readFileSync(path.join(durable.cwd!, "src/parent-marker.txt"), "utf8")).toBe("parent\n");
              expect(readFileSync(path.join(durable.cwd!, "src/target.txt"), "utf8")).toBe("continued\n");
              if (scenario === "repeat-repair-cap-writable" && input.binding.recoveryMode === "verify" && input.binding.correctionNo === 1)
                expect(readFileSync(path.join(durable.cwd!, "src/recovered-marker.txt"), "utf8")).toBe("fresh recovery\n");
              if (input.binding.recoveryMode === "repair") expect((await durable.effects!.invoke("write", {
                path: "src/recovered-marker.txt", content: "fresh recovery\n",
              })).status).toBe("completed");
            }
          } else if (input.binding.continuationOf && !input.binding.teamBundleHash) {
            continuationEffects = durable.effects;
            if (kind === "writable") {
              const effect = await durable.effects!.invoke("write", { path: "src/target.txt", content: "continued\n" });
              expect(effect.status).toBe("completed");
            }
          }
          if (input.binding.recoveryOf && scenario === "provider-source-writable") writeFileSync(path.join(sample.root, "src/target.txt"), "user drift\n");
          if (scenario === "repeat-writable") {
            expect(durable.sessionId).toBe(input.binding.attemptId);
            if (input.binding.continuationOf && !input.binding.recoveryOf && !input.binding.teamBundleHash)
              heldAttempts.set(input.binding.attemptId, { started: mark, released: hold });
            else if (!secondArmed && firstInterruptedAttempt && input.binding.recoveryOf === firstInterruptedAttempt) {
              secondArmed = true;
              heldAttempts.set(input.binding.attemptId, { started: secondMark, released: secondHold });
            }
          }
          return runner(input, durable);
        },
        assessPredicate: async ({ result }) => {
          const binding = engine!.snapshot().attempts[result.instanceId]?.binding;
          if (binding?.recoveryOf && scenario.startsWith("assessment-")) {
            await Bun.sleep(1);
            if (scenario === "assessment-cancel-writable") expect(cancelManagedAttempt(mission.id, binding.recoveryOf)).toBe(true);
            else if (scenario === "assessment-current-cancel-writable") {
              process.env.PI_CODING_AGENT_DIR = sample.stateDir;
              const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
              agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
              const cancelled = await tools.get("team_cancel")!.execute("cancel-current-recovery", { assignmentId: binding.attemptId },
                new AbortController().signal, undefined, { cwd: sample.root, sessionManager: { getSessionId: () => `pause-${kind}` } });
              process.env.PI_CODING_AGENT_DIR = agentDir;
              expect(cancelled.isError).not.toBe(true);
            } else writeFileSync(path.join(sample.root, "src/target.txt"), "user drift\n");
          }
          return { verdict: (scenario === "repair-writable" || scenario === "repair-cap-writable" || scenario === "repeat-repair-cap-writable") &&
            binding?.recoveryMode === "verify" ? "fail" : "pass", method: "host observation" };
        },
      });
      let independentQuestion: string | undefined;
      if (scenario === "capacity-writable") {
        const receipt = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", crypto.randomUUID(), "maybe stricter")!;
        const current = store.inspectMission(mission.id);
        askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: current.version, receipt,
          delta: JSON.stringify([{ op: "replace", path: "/units/1/acceptance/0/target", before: "host", after: "stricter" }]) });
        independentQuestion = receipt.id;
      }
      engine.start();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([started, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`${scenario} continuation did not start: ${JSON.stringify(store.inspectMission(mission.id).events.filter((event) => event.kind === "unit.blocked" || event.kind === "team.consultation.denied" || event.kind === "resource.wait"))}`)), 90000); })]);
      } finally { clearTimeout(timeout); }
      if (kind === "unknown-effect") {
        const effect = await continuationEffects!.invoke("write", { path: "src/credentials.txt", content: "secret\n" });
        expect(effect.status).toBe("unknown");
      }
      const before = store.inspectMission(mission.id);
      const heldReservation = before.reservations.filter((row) => row.resource !== "active-time-ms").map((row) => [row.id, row.amount]);
      const pausing = engine.control("pause", { id: "operator-pause", text: "/mission pause" });
      phase = "first-pause";
      setTimeout(releaseHold, 300);
      await pausing;
      const paused = store.inspectMission(mission.id);
      const pause = paused.events.find((event) => event.kind === "mission.paused")!;
      const continuation = paused.events.find((event) => event.kind === "attempt.reserved" &&
        (event.payload.binding as MissionAttemptBinding).continuationOf)!;
      const binding = continuation.payload.binding as MissionAttemptBinding;
      const receipt = paused.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === continuation.attemptId)!;
      const settled = paused.events.find((event) => event.kind === "attempt.settled" && event.attemptId === continuation.attemptId);
      if (kind === "unknown-effect") {
        expect(receipt.payload.status).toBe("cancelled");
        expect(settled).toBeUndefined();
        expect(paused.events.some((event) => event.kind === "effect.unknown" && event.attemptId === continuation.attemptId)).toBe(true);
        expect(String(paused.events.find((event) => event.kind === "resource.wait" && event.attemptId === continuation.attemptId &&
          event.payload.resource === "pause-interruption")?.payload.reason)).toContain("unknown or unresolved effect denies pause interruption");
        expect(paused.events.some((event) => event.kind === "unit.accepted" || event.kind === "unit.blocked" ||
          event.kind === "team.member.recorded" && event.attemptId === continuation.attemptId ||
          event.kind === "team.barrier.recorded" && event.payload.status === "incomplete")).toBe(false);
        await engine.control("pause", { id: "repeated-pause", text: "/mission pause" });
        const replay = store.inspectMission(mission.id);
        expect(replay.version).toBe(paused.version);
        expect(replay.events.some((event) => event.kind === "attempt.settled" && event.payload.status === "interrupted")).toBe(false);
        expect(replay.events.filter((event) => event.kind === "provider.request.dispatched")).toHaveLength(before.events.filter((event) => event.kind === "provider.request.dispatched").length);
        expect(readFileSync(path.join(sample.root, "src", "target.txt"), "utf8")).toBe("source\n");
        await engine.control("resume");
        await engine.waitForIdle();
        const denied = store.inspectMission(mission.id);
        expect(denied.events.filter((event) => event.kind === "attempt.reserved")).toHaveLength(before.events.filter((event) => event.kind === "attempt.reserved").length);
        expect(denied.events.filter((event) => event.kind === "unit.accepted" || event.kind === "team.barrier.recorded" && event.payload.status === "incomplete")).toHaveLength(0);
        if (process.env.PITAKO_PAUSE_EVIDENCE_DIR) {
          mkdirSync(process.env.PITAKO_PAUSE_EVIDENCE_DIR, { recursive: true });
          writeFileSync(path.join(process.env.PITAKO_PAUSE_EVIDENCE_DIR, `${scenario}.json`), JSON.stringify({
            binding, interruptionCount: denied.events.filter((event) => event.kind === "attempt.interrupted").length,
            events: denied.events, resources: denied.reservations, providerTrace: provider.trace,
          }, null, 2));
        }
        return;
      }
      const interruption = settled!.payload.interruption as { kind: string; pauseEventId: string; proofHash: string };
      const proof = JSON.parse(store.readArtifact(interruption.proofHash).toString("utf8"));
      expect(pause.payload.stoppedAttempts).toEqual([expect.objectContaining({ attemptId: continuation.attemptId, bindingHash: proof.bindingHash })]);
      expect(receipt.payload.status).toBe("cancelled");
      expect(settled!.payload.status).toBe("interrupted");
      expect(interruption).toEqual({ kind: "host-pause", pauseEventId: pause.eventId, proofHash: interruption.proofHash });
      expect(proof.format).toBe("mission-pause-interruption-v1");
      expect(proof.sdkDisposed).toBe(true);
      expect(proof.attemptId).toBe(continuation.attemptId);
      expect(proof.ownerEpoch).toBe(binding.ownerEpoch);
      expect(proof.revision).toBe(binding.revision);
      expect(proof.rolePolicyHash).toBe(binding.rolePolicyHash);
      expect(proof.inputManifestHash).toBe(binding.inputManifestHash);
      expect(proof.childResultHash).toBe(binding.childResultHash);
      expect(proof.consultationId).toBe(binding.consultationId);
      expect(paused.events.some((event) => event.kind === "unit.blocked" || event.kind === "unit.accepted")).toBe(false);
      expect(paused.events.filter((event) => event.kind === "team.barrier.recorded" && event.payload.status === "incomplete")).toHaveLength(0);
      expect(paused.events.some((event) => event.kind === "team.member.recorded" && event.attemptId === continuation.attemptId)).toBe(false);
      const ownSettlements = new Set(paused.events.filter((event) => event.kind === "budget.reservation.settled" &&
        event.attemptId === continuation.attemptId).map((event) => String(event.payload.reservationId)));
      expect(paused.reservations.filter((row) => row.resource !== "active-time-ms" && !ownSettlements.has(row.id))
        .map((row) => [row.id, row.amount])).toEqual(heldReservation.filter(([id]) => !ownSettlements.has(String(id))));
      const protectedIds = paused.events.filter((event) => event.kind === "reservation.created" && event.payload.purpose === "protected")
        .map((event) => event.payload.reservationId);
      expect(paused.events.some((event) => event.kind === "budget.reservation.adjusted" && protectedIds.includes(event.payload.reservationId))).toBe(false);
      expect(paused.events.filter((event) => event.kind === "provider.request.dispatched")).toHaveLength(before.events.filter((event) => event.kind === "provider.request.dispatched").length);
      expect(readFileSync(path.join(sample.root, "src", "target.txt"), "utf8")).toBe("source\n");
      if (kind === "writable") {
        expect(proof.candidate).toBe("managed");
        expect(proof.checkpointHash).toBe(binding.checkpointHash);
        const observed = readSealedWorkspaceImage(store, proof.observedImageHash);
        const base = readSealedWorkspaceImage(store, proof.baseImageHash);
        expect(observed.files.find((file) => file.path === "src/target.txt")?.bytes?.toString()).toBe("continued\n");
        expect(base.files.find((file) => file.path === "src/target.txt")?.bytes?.toString()).toBe("source\n");
        expect(base.files.find((file) => file.path === "src/parent-marker.txt")?.bytes?.toString()).toBe("parent\n");
        expect(observed.files.find((file) => file.path === "src/parent-marker.txt")?.bytes?.toString()).toBe("parent\n");
        const sourceBase = paused.events.find((event) => event.kind === "workspace.snapshot.sealed" &&
          event.attemptId === continuation.attemptId && event.payload.phase === "base")!;
        const sourceImage = readSealedWorkspaceImage(store, String(sourceBase.payload.imageHash));
        expect(sourceImage.files.some((file) => file.path === "src/parent-marker.txt")).toBe(false);
        expect(sourceImage.files.find((file) => file.path === "src/target.txt")?.bytes?.toString()).toBe("source\n");
        expect(sourceImage.manifest.hash).toBe(binding.workspaceManifestHash!);
        expect(proof.baseImageHash).not.toBe(sourceBase.payload.imageHash);
        const start = paused.events.find((event) => event.eventId === proof.executionStartEventId)!;
        const registration = paused.events.find((event) => event.kind === "workspace.candidate.registered" && event.attemptId === binding.attemptId)!;
        expect(start.kind).toBe("workspace.snapshot.sealed");
        expect(start.attemptId).toBe(binding.attemptId);
        expect(start.revision).toBe(binding.revision);
        expect(start.payload).toMatchObject({
          purpose: "execution-start", imageHash: proof.baseImageHash, manifestHash: base.manifest.hash,
          bindingHash: proof.bindingHash, ownerEpoch: binding.ownerEpoch, checkpointHash: binding.checkpointHash,
          recoveryImageHash: null, candidateRegistrationCausalId: registration.causalId,
          sourceBaseCausalId: sourceBase.causalId, sourceBaseImageHash: sourceBase.payload.imageHash,
        });
        const checkpoint = JSON.parse(store.readArtifact(binding.checkpointHash!).toString("utf8"));
        expect(proof.baseImageHash).toBe(checkpoint.imageHash);
        expect(start.seq).toBeLessThan(paused.events.find((event) => event.kind === "attempt.started" && event.attemptId === binding.attemptId)!.seq);
        expect(start.seq).toBeLessThan(paused.events.find((event) => event.kind === "effect.intent" && event.attemptId === binding.attemptId)!.seq);
        expect(existsSync(path.join(sample.root, "src", "parent-marker.txt"))).toBe(false);
      } else {
        expect(proof.candidate).toBe("read-only");
        expect(proof.teamBundleHash).toBe(binding.teamBundleHash);
        const witness = JSON.parse(store.readArtifact(proof.observedImageHash).toString("utf8"));
        expect(witness.format).toBe("mission-pause-readonly-image-v1");
        expect(witness.manifestHash).toBe(captureWorkspaceImage(sample.root).manifest.hash);
        expect(proof.baseImageHash).toBe(proof.observedImageHash);
      }
      if (scenario === "death-producer") {
        writeFileSync(process.env.PITAKO_PAUSE_DEATH_FILE!, JSON.stringify({ ...sample, missionId: mission.id }));
        process.kill(process.pid, "SIGKILL");
      }
      if (denied) {
        if (scenario === "source-writable") writeFileSync(path.join(sample.root, "src/target.txt"), "user drift\n");
        if (scenario === "mission-cancel-writable") await engine.control("cancel");
        if (scenario === "observation-source-writable") {
          const append = store.appendTransition.bind(store);
          store.appendTransition = (id, version, transition) => {
            const events = append(id, version, transition);
            if (events.some((event) => event.kind === "workspace.snapshot.sealed" && event.payload.phase === "recovered" && event.payload.pauseEventId))
              writeFileSync(path.join(sample.root, "src/target.txt"), "user drift\n");
            return events;
          };
        }
        if (scenario === "cancel-writable") {
          const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
          agentExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
          process.env.PI_CODING_AGENT_DIR = sample.stateDir;
          try {
            const cancelled = await tools.get("team_cancel")!.execute("cancel", { assignmentId: binding.attemptId }, new AbortController().signal,
              undefined, { cwd: sample.root, sessionManager: { getSessionId: () => `pause-${kind}` } });
            expect(cancelled.isError, cancelled.content).toBeFalsy();
          } finally { process.env.PI_CODING_AGENT_DIR = agentDir; }
        }
        if (scenario === "lost-proof-writable") rmSync(path.join(sample.objectDir, interruption.proofHash.slice(0, 2), interruption.proofHash));
        if (scenario === "bundle-drift-read-only") writeFileSync(path.join(sample.objectDir, binding.teamBundleHash!.slice(0, 2), binding.teamBundleHash!), "damaged immutable bundle");
        if (/^(revision|input|policy)-/.test(scenario)) {
          if (scenario === "input-writable") definition.units[0]!.inputs.push("new-input");
          if (scenario === "policy-writable") definition.authority.rolePolicies.developer!.hash = "b".repeat(64);
          const current = store.inspectMission(mission.id);
          store.admitRevision({ missionId: mission.id, expectedVersion: current.version,
            planBytes: Buffer.from(sample.planBytes.toString().replace("revision: 1", "revision: 2")),
            definitionBytes: Buffer.from(JSON.stringify(definition)), receiptId: crypto.randomUUID(), actor: "model", impact: ["impl"], retained: [] });
        }
        if (independentQuestion) {
          const detail = `withdraw ${independentQuestion}`;
          await withdrawMissionChoice({ store, engine, missionId: mission.id, receipt: recordOperatorChoice(store,
            store.inspectMission(mission.id), "owner", `/mission revise durable-fixture ${detail}`, detail) });
        }
        if (scenario === "mission-cancel-writable") await expect(engine.control("resume")).rejects.toThrow("terminal mission");
        else await engine.control("resume");
        await engine.waitForIdle();
        const final = store.inspectMission(mission.id);
        expect(final.events.filter((event) => event.kind === "attempt.reserved" &&
          (event.payload.binding as MissionAttemptBinding).recoveryOf === binding.attemptId)).toHaveLength(0);
        expect(final.events.filter((event) => event.kind === "unit.accepted" && event.unitId === "impl")).toHaveLength(0);
        expect(final.events.filter((event) => event.kind === "team.barrier.recorded" && event.payload.status === "incomplete")).toHaveLength(0);
        if (/^(budget|capacity)-/.test(scenario)) {
          expect(final.events.filter((event) => event.kind === "resource.wait" && event.unitId === "impl")).not.toHaveLength(0);
          expect(final.events.filter((event) => event.kind === "unit.blocked" && event.unitId === "impl")).toHaveLength(0);
          expect(final.reservations.filter((row) => row.purpose === "protected").map((row) => [row.id, row.amount]))
            .toEqual(paused.reservations.filter((row) => row.purpose === "protected").map((row) => [row.id, row.amount]));
        }
        if (scenario === "capacity-writable") expect(final.events.filter((event) => event.kind === "unit.accepted" && event.unitId === "independent")).toHaveLength(1);
        if (process.env.PITAKO_PAUSE_EVIDENCE_DIR) {
          mkdirSync(process.env.PITAKO_PAUSE_EVIDENCE_DIR, { recursive: true });
          writeFileSync(path.join(process.env.PITAKO_PAUSE_EVIDENCE_DIR, `${scenario}.json`), JSON.stringify({ binding, proof,
            producer: "Bun Pi SDK/local provider/effect adapter", events: final.events, resources: final.reservations, providerTrace: provider.trace }, null, 2));
        }
      } else if (resume || scenario === "unknown-usage-writable") {
        releaseHold();
        const completed = paused.events.filter((event) => event.kind === "team.member.recorded" || event.kind === "team.barrier.recorded" || event.kind === "team.consultation.resolved");
        let repeatedBinding: MissionAttemptBinding | undefined;
        let repeatedProof: { observedImageHash: string; baseImageHash: string } | undefined;
        if (scenario === "repeat-writable" || scenario === "repeat-repair-cap-writable") {
          firstInterruptedAttempt = binding.attemptId;
          if (scenario === "repeat-repair-cap-writable") {
            selectPrompt = (prompt) => prompt.includes("Recovery mode: the recovered candidate failed verification");
            promptHold = { started: secondMark, released: secondHold };
          }
          phase = "resume";
          await engine.control("resume");
          phase = "second-start";
          let secondTimeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([secondStarted, engine.waitForIdle().then(() => {
              throw new Error("second-start: recovery became idle before the held SDK dispatch");
            }), new Promise<never>((_resolve, reject) => {
              secondTimeout = setTimeout(() => reject(new Error("second-start: held SDK dispatch did not start within 30 seconds")), 30_000);
            })]);
          } finally { clearTimeout(secondTimeout); }
          phase = "second-pause";
          const secondPausing = engine.control("pause");
          setTimeout(releaseSecondHold, 300);
          await secondPausing;
          const again = store.inspectMission(mission.id);
          const interruption = again.events.filter((event) => event.kind === "attempt.settled" && event.payload.status === "interrupted").at(-1)!;
          repeatedBinding = engine.snapshot().attempts[interruption.attemptId!]!.binding;
          repeatedProof = JSON.parse(store.readArtifact((interruption.payload.interruption as { proofHash: string }).proofHash).toString());
          expect(repeatedProof!.baseImageHash).toBe(proof.observedImageHash);
          if (scenario === "repeat-writable") {
            expect(again.events.filter((event) => event.kind === "attempt.settled" && event.payload.status === "interrupted")).toHaveLength(2);
            expect(again.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === repeatedBinding!.attemptId)?.payload.status).toBe("cancelled");
            expect(again.events.filter((event) => event.kind === "unit.accepted")).toHaveLength(0);
            expect(provider.trace.filter(({ sessionId }) => sessionId === repeatedBinding!.attemptId)).toHaveLength(1);
          }
          expect(repeatedBinding.recoveryOf).toBe(scenario === "repeat-repair-cap-writable" ? undefined : binding.attemptId);
          expect(repeatedBinding.correctionNo).toBe(binding.correctionNo! + Number(scenario === "repeat-repair-cap-writable"));
          if (scenario === "repeat-repair-cap-writable") expect(readSealedWorkspaceImage(store, repeatedProof!.observedImageHash).files
            .find(({ path }) => path === "src/recovered-marker.txt")?.bytes?.toString()).toBe("fresh recovery\n");
          expect(again.events.filter((event) => event.kind === "unit.blocked")).toHaveLength(0);
        }
        if (scenario === "resume-writable") {
          const duplicates = await Promise.allSettled([engine.control("resume"), engine.control("resume")]);
          expect(duplicates.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        } else await engine.control("resume");
        phase = "final-idle";
        await engine.waitForIdle();
        const resumed = store.inspectMission(mission.id);
        const successors = resumed.events.filter((event) => event.kind === "attempt.reserved" &&
          (event.payload.binding as MissionAttemptBinding).recoveryOf === binding.attemptId);
        expect(successors, `${scenario}: ${JSON.stringify(resumed.events.filter((event) =>
          event.kind === "resource.wait" || event.kind === "unit.blocked").map(({ kind, payload }) => ({ kind, payload })))}`).toHaveLength(1);
        const successor = successors[0]!.payload.binding as MissionAttemptBinding;
        expect(successor.continuationOf).toBe(binding.continuationOf);
        expect(successor.correctionNo).toBe(binding.correctionNo);
        expect(successor.attemptNo).toBe(binding.attemptNo + 1);
        expect(successor.childResultHash).toBe(binding.childResultHash);
        expect(successor.checkpointHash).toBe(binding.checkpointHash);
        expect(successor.teamBundleHash).toBe(binding.teamBundleHash);
        expect(successor.candidateId).not.toBe(binding.candidateId ?? "not-a-candidate");
        if (scenario === "repair-writable") {
          const repair = Object.values(engine.snapshot().attempts).find(({ binding }) => binding.recoveryMode === "repair")!.binding;
          expect(repair.correctionNo).toBe(binding.correctionNo! + 1);
          expect(readFileSync(path.join(repair.candidateRoot!, "src/recovered-marker.txt"), "utf8")).toBe("fresh recovery\n");
          expect(resumed.events.filter((event) => event.kind === "mission.recovery.repair.authorized")).toHaveLength(1);
        }
        if (repeatedBinding) {
          const last = resumed.events.filter((event) => event.kind === "attempt.reserved" &&
            (event.payload.binding as MissionAttemptBinding).recoveryOf === repeatedBinding!.attemptId);
          expect(last).toHaveLength(1);
          const finalBinding = last[0]!.payload.binding as MissionAttemptBinding;
          expect(finalBinding.recoveryImageHash).toBe(repeatedProof!.observedImageHash);
          expect(finalBinding.correctionNo).toBe(repeatedBinding.correctionNo);
          expect(finalBinding.attemptNo).toBe(binding.attemptNo + (scenario === "repeat-repair-cap-writable" ? 3 : 2));
          expect(finalBinding.continuationOf).toBe(binding.continuationOf);
          if (scenario === "repeat-writable") {
            expect(finalBinding.checkpointHash).toBe(binding.checkpointHash);
            expect(finalBinding.childResultHash).toBe(binding.childResultHash);
            expect(resumed.events.filter((event) => event.kind === "unit.accepted").map(({ attemptId }) => attemptId))
              .toEqual([finalBinding.attemptId]);
          }
        }
        if (!verificationBlocked && !resumed.events.some((event) => event.kind === "unit.accepted")) console.error(scenario,
          JSON.stringify(resumed.events.filter((event) => /blocked|fenced|wait/.test(event.kind) || event.kind === "attempt.receipt")
            .map(({ kind, attemptId, payload }) => ({ kind, attemptId, status: payload.status, reason: payload.reason, error: payload.error })), null, 2));
        expect(resumed.events.filter((event) => event.kind === "unit.accepted")).toHaveLength(verificationBlocked ? 0 : 1);
        if (verificationBlocked) {
          expect(resumed.events.filter((event) => event.kind === "unit.blocked")).not.toHaveLength(0);
          expect(resumed.events.filter((event) => event.kind === "mission.recovery.repair.authorized")).toHaveLength(scenario === "repeat-repair-cap-writable" ? 1 : 0);
        } else expect(resumed.events.filter((event) => event.kind === "unit.blocked")).toHaveLength(0);
        for (const event of completed) {
          expect(resumed.events.find((row) => row.eventId === event.eventId)).toEqual(event);
          expect(resumed.events.filter((row) => row.kind === event.kind && row.payload.targetId === event.payload.targetId &&
            row.payload.round === event.payload.round && row.payload.memberId === event.payload.memberId)).toHaveLength(1);
        }
        expect(resumed.reservations.filter((row) => row.purpose === "protected").map((row) => [row.id, row.amount]))
          .toEqual(paused.reservations.filter((row) => row.purpose === "protected").map((row) => [row.id, row.amount]));
        expect(resumed.events.filter((event) => event.kind === "team.consultation.admitted")).toHaveLength(paused.events.filter((event) => event.kind === "team.consultation.admitted").length);
        expect(resumed.events.filter((event) => event.kind === "team.member.recorded" && event.attemptId === binding.attemptId)).toHaveLength(0);
        expect(resumed.events.find((event) => event.kind === "attempt.receipt" && event.attemptId === binding.attemptId)?.payload.status).toBe("cancelled");
        expect(readFileSync(path.join(sample.root, "src/target.txt"), "utf8")).toBe(scenario === "assessment-source-writable" || scenario === "provider-source-writable" ? "user drift\n" : "source\n");
        if (kind === "writable") {
          const fresh = scenario === "repeat-repair-cap-writable" ? 3 : scenario === "repair-writable" || scenario === "repeat-writable" ? 2 : 1;
          if (scenario === "corrected-writable" || scenario === "repair-cap-writable" || scenario === "repeat-repair-cap-writable") {
            if (scenario !== "repeat-repair-cap-writable") expect(binding.correctionNo).toBe(1);
            // Read-only legacy projection: no stored witness or authority is rewritten.
            const legacy = structuredClone(resumed.events);
            for (const event of legacy) if (event.kind === "attempt.reserved") delete (event.payload.binding as MissionAttemptBinding).correctionNo;
            const last = legacy.filter((event) => event.kind === "attempt.reserved" && event.unitId === "impl" &&
              (event.payload.binding as MissionAttemptBinding).roundId === "main").at(-1)!;
            expect(missionCorrectionNo(legacy, last.payload.binding as MissionAttemptBinding)).toBe(1);
          }
          expect(resumed.events.filter((event) => event.kind === "attempt.reserved").length - paused.events.filter((event) => event.kind === "attempt.reserved").length).toBe(fresh);
          expect(resumed.events.filter((event) => event.kind === "provider.request.dispatched").length - paused.events.filter((event) => event.kind === "provider.request.dispatched").length)
            .toBe(scenario === "provider-source-writable" ? 0 : fresh);
          if (scenario === "unknown-usage-writable") {
            expect(paused.reservations.some((row) => row.unknownCharge > 0)).toBe(true);
            expect(resumed.reservations.filter((row) => row.unknownCharge > 0).map((row) => [row.id, row.unknownCharge]))
              .toEqual(paused.reservations.filter((row) => row.unknownCharge > 0).map((row) => [row.id, row.unknownCharge]));
          }
        }
        if (process.env.PITAKO_PAUSE_EVIDENCE_DIR) {
          mkdirSync(process.env.PITAKO_PAUSE_EVIDENCE_DIR, { recursive: true });
          writeFileSync(path.join(process.env.PITAKO_PAUSE_EVIDENCE_DIR, `${scenario}.json`), JSON.stringify({
            producer: "Bun Pi SDK/local provider/effect adapter", binding, proof, events: resumed.events,
            resources: resumed.reservations, providerTrace: provider.trace,
            childResult: binding.childResultHash && store.readArtifact(binding.childResultHash).toString(),
            images: kind === "writable" ? Object.fromEntries([proof.baseImageHash, proof.observedImageHash,
              ...resumed.events.filter((event) => event.kind === "workspace.snapshot.sealed" && event.payload.purpose === "execution-start")
                .map((event) => String(event.payload.imageHash))].map((hash) => [hash, readSealedWorkspaceImage(store, hash).files
                  .map((file) => ({ path: file.path, kind: file.kind, mode: file.mode, text: file.bytes?.toString() }))])) : undefined,
          }, null, 2));
        }
      } else {
        await captureReceipts();
        await engine.retireForShutdown("quit");
        engine = undefined;
        if (scenario.startsWith("node-") || scenario.startsWith("missing-") || scenario.startsWith("crash-")) {
          if (scenario.startsWith("missing-")) rmSync(binding.candidateRoot!, { force: true, recursive: true });
          if (scenario.startsWith("crash-")) {
            const crash = spawnSync("node", ["scripts/mission-pause-recovery-node.mjs", sample.dbPath, sample.objectDir, mission.id, sample.root, "crash"],
              { cwd: process.cwd(), encoding: "utf8", timeout: 90_000 });
            expect(crash.signal, crash.stderr).toBe("SIGKILL");
          }
          const node = spawnSync("node", ["scripts/mission-pause-recovery-node.mjs", sample.dbPath, sample.objectDir, mission.id, sample.root,
            scenario.startsWith("crash-") ? "unreceipted" : kind === "writable" ? "repair" : "resume"], { cwd: process.cwd(), encoding: "utf8", timeout: 90_000 });
          expect(node.status, node.stderr + node.stdout.slice(-4000)).toBe(0);
          if (process.env.PITAKO_PAUSE_EVIDENCE_DIR) {
            mkdirSync(process.env.PITAKO_PAUSE_EVIDENCE_DIR, { recursive: true });
            writeFileSync(path.join(process.env.PITAKO_PAUSE_EVIDENCE_DIR, `${scenario}.json`), node.stdout);
          }
        } else await reopen(sample, mission.id);
      }
    } finally {
      await captureReceipts();
      releaseHold();
      releaseSecondHold();
      try { if (engine) await engine.close(); }
      finally {
        store.close();
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        delete (globalThis as Record<string, unknown>)[`__${provider.provider.replace(/\W/g, "_")}`];
        rejectionCapture?.restore();
        rmSync(sample.base, { recursive: true, force: true });
      }
    }
}, 240_000);

if (!process.env.PITAKO_PAUSE_CASE) test("production Node explicitly resumes an SDK orderly pause after positive owner death", async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  const temp = mkdtempSync(path.join(tmpdir(), "pitako-pause-owner-death-"));
  const ready = path.join(temp, "ready.json");
  let sample: { base: string; dbPath: string; objectDir: string; missionId: string; root: string } | undefined;
  try {
    const producer = spawnSync(process.execPath, ["test", "tests/mission-pause-interruption.test.ts", "-t", "live SDK"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
      env: { ...process.env, PITAKO_PAUSE_CASE: "death-producer", PITAKO_PAUSE_DEATH_FILE: ready },
    });
    expect(producer.signal, producer.stderr).toBe("SIGKILL");
    sample = JSON.parse(readFileSync(ready, "utf8"));
    const node = spawnSync("node", ["scripts/mission-pause-recovery-node.mjs", sample!.dbPath, sample!.objectDir, sample!.missionId, sample!.root, "repair"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 90_000 });
    expect(node.status, node.stderr + node.stdout.slice(-4000)).toBe(0);
    expect(JSON.parse(node.stdout).acquisition).toBe("owner-death");
    if (process.env.PITAKO_PAUSE_EVIDENCE_DIR) {
      mkdirSync(process.env.PITAKO_PAUSE_EVIDENCE_DIR, { recursive: true });
      writeFileSync(path.join(process.env.PITAKO_PAUSE_EVIDENCE_DIR, "owner-death-writable.json"), node.stdout);
    }
  } finally {
    if (sample) rmSync(sample.base, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}, 240_000);
