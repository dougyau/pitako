import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiExecutor } from "../agent/pi.ts";
import { currentInstanceId } from "../agent/scope.ts";
import { admitMissionChange, askMissionChoice, chosenDefinition, classifyMissionInput, nextPlanBytes, recordOperatorChoice, recordOperatorInput, withdrawMissionChoice } from "./admission.ts";
import { openMissionConsole } from "./console.ts";
import { createPiMissionRunner, MissionEngine, reduceMissionEvents } from "./engine.ts";
import { openMissionStore, type MissionStore } from "./store.ts";
import { validateMissionDefinitionBytes } from "./model.ts";
import { parsePlanDocument } from "../workflow.ts";
import { packageRoot } from "../stack.ts";
import { metricCommand } from "./metrics.ts";

function files(root: string, id: string) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("invalid mission plan id");
  const base = path.join(root, ".pitako", "plans", id);
  return { plan: `${base}.md`, definition: `${base}.mission.json` };
}

export function validateMissionFiles(root: string, id: string) {
  const names = files(root, id);
  const planBytes = readFileSync(names.plan);
  const definitionBytes = readFileSync(names.definition);
  const plan = parsePlanDocument(planBytes.toString("utf8"));
  if (plan.id !== id || plan.status !== "frozen") throw new Error("mission preparation requires matching frozen markdown plan");
  validateMissionDefinitionBytes(definitionBytes);
  return { ...names, planBytes, definitionBytes, metadata: plan };
}

export function registerMissionExtension(pi: ExtensionAPI) {
  let consoleSocket: Awaited<ReturnType<typeof openMissionConsole>> | undefined;
  let store: MissionStore | undefined;
  let engine: MissionEngine | undefined;
  let session: string | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const pendingDisplay = new Map<string, { missionId: string; throughSeq: number; eventIds: string[] }>();
  let uiCursor = 0;
  let uiMissionId: string | undefined;

  const eligible = (ctx: { mode: string; sessionManager?: { getSessionId(): string } }) =>
    (ctx.mode === "tui" || ctx.mode === "rpc") && !currentInstanceId() && !process.env.PITAKO_INSTANCE_ID && !!ctx.sessionManager?.getSessionId();
  const idOf = (ctx: { sessionManager?: { getSessionId(): string } }) => ctx.sessionManager?.getSessionId();
  const open = async () => { store ??= await openMissionStore(); return store; };
  const attach = (ctx: { cwd: string; sessionManager?: { getSessionId(): string } }, missionId?: string) => {
    if (!store || store.ownerEpoch === null) throw new Error("mission store writer is owned elsewhere; attach read-only");
    const mission = store.findManagedMission(ctx.cwd);
    if (!mission || (missionId && mission.id !== missionId && mission.planId !== missionId)) throw new Error("no managed mission is bound to this repository");
    if (session && session !== idOf(ctx)) throw new Error("mission belongs to another foreground session");
    session = idOf(ctx);
    if (!session) throw new Error("foreground session required");
    engine ??= new MissionEngine({ store, missionId: mission.id, ownerSessionId: session,
      sessionsDirectory: path.join(store.storageRoot, "sessions"),
      runRole: createPiMissionRunner({ cwd: ctx.cwd, executor: createPiExecutor() }),
      // No injectable assessor: MissionEngine uses the bound production checker.
      managedWorkspace: { sourceRoot: ctx.cwd } });
    return { mission, engine };
  };
  const status = (ctx: { cwd: string }) => {
    if (!store) throw new Error("no mission store loaded");
    const mission = store.findManagedMission(ctx.cwd);
    if (!mission) throw new Error("no mission for this repository");
    const state = reduceMissionEvents(mission);
    const integrated = [...mission.events].reverse().find((event) => event.kind === "mission.result.integrated" && event.revision === mission.revision);
    const result = integrated && JSON.parse(store.readArtifact(String(integrated.payload.reportHash)).toString("utf8"));
    const privateResult = result?.format === "mission-integrated-result-v1" ? {
      provisional: true, reportHash: integrated!.payload.reportHash, candidateRoot: result.candidateRoot,
      resultImageHash: result.resultImageHash, deliveryBaseManifestHash: result.deliveryBaseManifestHash,
      acceptedManifestHash: result.acceptedManifestHash, conditionalPatchHash: result.patchHash,
    } : undefined;
    return { id: mission.id, revision: mission.revision, state: state.state, privateResult,
      units: state.units, resumeAfterClose: mission.definition.authority.resumeAfterClose,
      owner: store.ownerEpoch === null ? "read-only" : "local", latestSeq: mission.latestSeq };
  };
  const display = (ctx: { hasUI: boolean; ui: { notify(text: string, kind?: "info" | "error"): void } }, text: string) => {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
  };
  const notifications = (ctx: { cwd: string; hasUI: boolean; ui: { notify(text: string, kind?: "info" | "error"): void } }) => {
    if (!ctx.hasUI || !store || store.ownerEpoch === null) return;
    const mission = store.findManagedMission(ctx.cwd);
    if (!mission) return;
    if (uiMissionId !== mission.id) { uiMissionId = mission.id; uiCursor = 0; }
    const sessionId = idOf(ctx as { sessionManager?: { getSessionId(): string } });
    if (!sessionId) return;
    const cursor = Math.max(uiCursor, mission.events.filter((event) => event.kind === "mission.notification.delivered")
      .reduce((seq, event) => Math.max(seq, Number(event.payload.throughSeq)), 0));
    const latest = mission.events.filter((event) => event.seq > cursor &&
      ["unit.accepted", "unit.blocked", "mission.completed", "mission.revised", "mission.blocked"].includes(event.kind));
    if (!latest.length) return;
    const visible = latest.filter((event) => event.kind !== "unit.blocked" || !latest.some((later) => later.kind === "mission.blocked" && later.seq > event.seq));
    ctx.ui.notify(visible.map((event) => `${event.kind}: ${event.unitId ?? mission.planId} @${event.revision}`).join("\n"), "info");
    // Pi notify has no display acknowledgement; only the console's post-render receipt advances the durable cursor.
    uiCursor = latest.at(-1)!.seq;
  };

  pi.on("session_start", async (event, ctx) => {
    if (!eligible(ctx)) return;
    try {
      if (!existsSync(path.join(ctx.cwd, ".git"))) return;
      await open();
      const mission = store!.findManagedMission(ctx.cwd);
      const state = mission && reduceMissionEvents(mission).state;
      const release = mission && [...mission.events].reverse().find(({ kind }) => kind === "mission.owner.released");
      const lastBlock = mission && [...mission.events].reverse().find(({ kind }) => kind === "mission.blocked");
      const shutdownBlocked = state === "blocked" && ["quit", "reload"].includes(String(release?.payload.reason)) &&
        String(lastBlock?.payload.reason).includes("SDK sessions did not settle before Pi shutdown");
      const pause = mission && [...mission.events].reverse().find(({ kind }) => kind === "mission.paused");
      const orderlyClose = state === "paused" && pause?.payload.controlOrigin === "lifecycle" &&
        pause.payload.resumeAfterClose === true && release?.payload.pauseEventId === pause.eventId;
      if (mission && store!.ownerEpoch !== null && mission.definition.authority.resumeAfterClose &&
        ["startup", "reload"].includes(event.reason) && (state === "running" || shutdownBlocked || orderlyClose)) {
        const attached = attach(ctx, mission.id);
        if (orderlyClose) await attached.engine.resumeAfterClose();
        else attached.engine.start();
      }
      consoleSocket = await openMissionConsole(path.join(store!.storageRoot, "console"),
        (text, causalId) => submitOperator(ctx, text, causalId), (causalId, responseMs) => {
          const mission = store?.findManagedMission(ctx.cwd);
          if (!mission || store?.ownerEpoch === null || mission.events.some((event) =>
            event.kind === "mission.input.visible" && event.payload.operatorInputId === causalId)) return;
          const delivery = pendingDisplay.get(causalId);
          pendingDisplay.delete(causalId);
          store!.appendTransition(mission.id, mission.version, { events: [
            { revision: mission.revision, kind: "mission.input.visible", causalId,
              payload: { operatorInputId: causalId, responseMs, sessionId: idOf(ctx) } },
            ...(delivery && delivery.missionId === mission.id ? [{ revision: mission.revision,
              kind: "mission.notification.delivered", causalId: randomUUID(),
              payload: { sessionId: idOf(ctx), operatorInputId: causalId, throughSeq: delivery.throughSeq, eventIds: delivery.eventIds } }] : []),
          ] });
        });
      if (ctx.hasUI) ctx.ui.notify(`Mission operator console: bun ${JSON.stringify(path.join(packageRoot(), "scripts/mission-console.ts"))} ${consoleSocket.path}`, "info");
      uiCursor = 0;
      uiMissionId = undefined;
      if (ctx.hasUI) {
        ticker = setInterval(() => { try { notifications(ctx); } catch { /* display cannot stop execution */ } }, 250);
        ticker.unref?.();
      }
    } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), "error"); }
  });
  pi.on("session_shutdown", async () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    if (consoleSocket) await consoleSocket.close();
    consoleSocket = undefined;
    if (store && !engine) store.close();
    engine = undefined;
    session = undefined;
    store = undefined; // Existing awaited shutdown handler retires and closes the store.
  });

  const submitOperator = async (ctx: { cwd: string; mode: string; sessionManager?: { getSessionId(): string } }, text: string, causalId: ReturnType<typeof randomUUID>): Promise<string> => {
    if (!eligible(ctx)) throw new Error("foreground mission session required");
    const match = /^\/mission\s+(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/.exec(text);
    if (!match) throw new Error("use /mission <action> <plan-id> in the operator console");
    const [, verb, id, detail] = match;
    if (verb === "metrics") {
      const db = await open();
      return JSON.stringify(metricCommand(db, [id, detail].filter(Boolean).join(" "), process.env.PITAKO_ENGINE_COMMIT ?? "unknown"));
    }
    if (verb === "prepare") {
      const parsed = validateMissionFiles(ctx.cwd, id!);
      const created = (await open()).createMission({ repositoryRoot: ctx.cwd, planId: id!, planFile: parsed.plan,
        definitionFile: parsed.definition, commandId: causalId, admissionReceiptId: causalId, operatorText: text });
      return `Prepared ${created.id} @${created.revision}; no worker started.`;
    }
    if (verb === "status" || verb === "inspect") {
      await open();
      const current = status(ctx);
      const mission = store!.inspectMission(current.id);
      const cursor = mission.events.filter((event) => event.kind === "mission.notification.delivered")
        .reduce((seq, event) => Math.max(seq, Number(event.payload.throughSeq)), 0);
      const notifications = mission.events.filter((event) => event.seq > cursor &&
        ["unit.accepted", "unit.blocked", "mission.completed", "mission.revised", "mission.blocked"].includes(event.kind));
      if (notifications.length) pendingDisplay.set(causalId, { missionId: mission.id,
        throughSeq: notifications.at(-1)!.seq, eventIds: notifications.map((event) => event.eventId) });
      return JSON.stringify({ ...current, notifications: notifications.map((event) =>
        `${event.kind}: ${event.unitId ?? mission.planId} @${event.revision}`) });
    }
    if (verb === "export") {
      const db = await open();
      const mission = db.findManagedMission(ctx.cwd);
      if (!mission) throw new Error("mission not found");
      return JSON.stringify(await db.exportMission(mission.id, id));
    }
    if (!id) throw new Error("mission id required");
    if (verb === "revise") {
      const separator = detail?.lastIndexOf(" -- ") ?? -1;
      const instruction = separator < 0 ? detail?.trim() ?? "" : detail!.slice(0, separator).trim();
      const active = attach(ctx, id);
      if (separator >= 0 && classifyMissionInput(instruction) === "ambiguous") {
        const receipt = recordOperatorInput("console", idOf(ctx)!, text, causalId, instruction)!;
        const { question } = askMissionChoice({ store: store!, engine: active.engine, missionId: active.mission.id,
          expectedVersion: active.mission.version, receipt, delta: detail!.slice(separator + 4) });
        return question;
      }
      const receipt = recordOperatorChoice(store!, active.mission, idOf(ctx)!, text, detail?.trim() ?? "", causalId);
      if (receipt.choice?.kind === "withdraw") {
        const impact = await withdrawMissionChoice({ store: store!, engine: active.engine, missionId: active.mission.id, receipt });
        return `Choice withdrawn; released: ${impact.join(", ") || "none"}`;
      }
      const result = admitMissionChange({ store: store!, engine: active.engine, missionId: active.mission.id,
        expectedVersion: active.mission.version, planBytes: nextPlanBytes(active.mission.planBytes),
        definitionBytes: Buffer.from(JSON.stringify(chosenDefinition(active.mission.definition, receipt.choice!.edits))),
        actor: "operator", receipt });
      return `Revision ${result.revision}; impacted: ${result.impact.join(", ") || "none"}`;
    }
    if (!["start", "resume", "pause", "cancel", "attach", "recover"].includes(verb!)) throw new Error(`unsupported mission action ${verb}`);
    await open();
    const active = attach(ctx, id);
    if (verb === "start" || verb === "recover") {
      const state = active.engine.snapshot().state;
      if (verb === "recover" && ["paused", "cancelled", "completed"].includes(state)) {
        throw new Error("manual pause or terminal state cannot be bypassed by recover");
      }
      if (verb === "recover") {
        const mission = store!.inspectMission(active.mission.id);
        store!.appendTransition(mission.id, mission.version, { events: [{ revision: mission.revision,
          kind: "mission.input.recorded", causalId, payload: { operatorText: text, operatorInputId: causalId, intervention: "operational_rescue" } }] });
      }
      active.engine.start(verb === "start" ? { id: causalId, text } : undefined);
      return `${verb}: ${active.mission.id}; resumeAfterClose: ${active.mission.definition.authority.resumeAfterClose}`;
    }
    if (verb === "attach") return `Attached ${active.mission.id}; ${JSON.stringify(status(ctx))}`;
    await active.engine.control(verb as "pause" | "resume" | "cancel", { id: causalId, text });
    return `${verb}: ${active.mission.id}`;
  };

  pi.registerCommand("mission", {
    description: "Inspect a durable mission; changes require the Pitako operator console",
    handler: async (args, ctx) => {
      const [verb, id] = args.trim().split(/\s+/);
      try {
        if (verb === "metrics") {
          if (args.includes("--import-observations")) throw new Error("observation import requires the operator console");
          await open();
          display(ctx, JSON.stringify(metricCommand(store!, args.trim().slice("metrics".length).trim(), process.env.PITAKO_ENGINE_COMMIT ?? "unknown")));
        } else if (verb === "status" || verb === "inspect") { await open(); display(ctx, JSON.stringify(status(ctx))); }
        else if (verb === "export") {
          const db = await open();
          const mission = db.findManagedMission(ctx.cwd);
          if (!mission) throw new Error("mission not found");
          display(ctx, JSON.stringify(await db.exportMission(mission.id, id)));
        } else throw new Error("mission mutation requires the Pitako operator console; native Pi input is advisory");
      } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), "error"); else throw error; }
    },
  });

  const tool = (name: string, parameters: any, execute: (params: any, ctx: any) => Promise<unknown>) => {
    pi.registerTool({ name, label: name, description: `Durable mission ${name.slice(8)}`, parameters,
      execute: async (_id, params, _signal, _update, ctx) => ({
        content: [{ type: "text", text: JSON.stringify(await execute(params, ctx)) }], details: undefined,
      }) });
  };
  tool("mission_prepare", Type.Object({ id: Type.String() }), async ({ id }, ctx) => {
    const validated = validateMissionFiles(ctx.cwd, id);
    return { planId: id, revision: validated.metadata.revision, definitionValid: true,
      message: "Validated only. Use the Pitako operator console to persist; no worker started." };
  });
  tool("mission_status", Type.Object({}), async (_params, ctx) => { await open(); return status(ctx); });
  tool("mission_start", Type.Object({ id: Type.String() }), async () => {
    throw new Error("model tool cannot mint start authority; use the Pitako operator console");
  });
  tool("mission_propose_change", Type.Object({ id: Type.String(), claimedImpact: Type.Optional(Type.Array(Type.String())) }), async ({ id }, ctx) => {
    const parsed = validateMissionFiles(ctx.cwd, id);
    return { candidateRevision: parsed.metadata.revision, message: "Proposal only; operator instruction or bounded technical admission required" };
  });
  tool("mission_control", Type.Object({ action: Type.String() }), async () => {
    throw new Error("model tool cannot mint operator control authority");
  });
  tool("mission_consult", Type.Object({ question: Type.String() }), async ({ question }) => ({ question, status: "advisory; no durable team authority before T6" }));
  tool("mission_submit", Type.Object({ finding: Type.String() }), async () => {
    throw new Error("worker identity requires a host-bound managed attempt; submission is unavailable outside one");
  });
}
