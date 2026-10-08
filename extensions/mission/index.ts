import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createPiExecutor } from "../agent/pi.ts";
import { currentInstanceId } from "../agent/scope.ts";
import { executionForSession } from "../execution-identity.ts";
import { admitMissionChange, askMissionChoice, chosenDefinition, classifyMissionInput, consumeOperatorInput, editValue, nextPlanBytes, parseChoice, pendingMissionQuestions, recordOperatorChoice, recordOperatorInput, validateOperatorChoice, withdrawMissionChoice, type OperatorReceipt } from "./admission.ts";
import { openMissionConsole } from "./console.ts";
import { createPiMissionRunner, MissionEngine, reduceMissionEvents } from "./engine.ts";
import { openMissionStore, type MissionStore } from "./store.ts";
import { sha256, validateMissionDefinitionBytes } from "./model.ts";
import { parsePlanDocument } from "../workflow.ts";
import { packageRoot } from "../stack.ts";
import { metricCommand } from "./metrics.ts";
import { getPitakoDataDir } from "../board/paths.ts";
import { admitSetupStart, assertSetupInputs, MissionSetup, setupStartText, type SetupStartAdmission } from "./setup.ts";
import { missionInputIdentity } from "./inputs.ts";
import { loadPitakoConfig } from "../roles/load.ts";
import { bindPreparationAnswer, bindPreparationAuthority, bindPreparationSetup, invalidatePreparationRequest,
  openPreparationRequest, preparationAnswerText, preparationAuthorityText, preparationContext, preparationSetupText,
  preparedAdmissionText, validatePreparation, preparationIssue, PreparationBindingError, type PreparationRequest } from "./preparation.ts";
import { preparationView } from "./preparation-view.ts";
import type { MissionDefinition } from "./model.ts";
import type { SetupAllocation } from "./setup.ts";
import { inspectManagedMission } from "../agent/managed-mission.ts";
import { parseMissionInspect, readMissionObservation } from "./observation.ts";

const usage = `Use /mission prepare|start|pause|resume|cancel <plan-id>
/mission revise <plan-id> Change predicate|unit <id> <field> to <JSON value>
/mission revise <plan-id> Change mission <object-field> <field> to <JSON value>
/mission revise <plan-id> (prompt for an exact choice)
/mission revise <plan-id> answer <question-id> (prompt for bounded values)
/mission revise <plan-id> withdraw <question-id>
/mission status; /mission inspect [mission-id|plan-id] [--unit <id>] [--attempt <id>] [--cursor <token>]
/mission prepare-details (show exact JSON alongside the next preparation confirmation)
/mission metrics; /mission export [directory]
/mission console (explicit optional compatibility socket)
Prepare queues assisted Markdown authoring to this coordinator. The mission_prepare tool submits an untrusted mapped proposal; grouped authority/semantic questions precede an exact preview and confirmation. No mission JSON is required. Confirmation leaves it prepared and runs admitted copied setup, if required; start is separate and confirms worker execution. Legacy v1 setup remains start-scoped. Dismissed or stale drafts require prepare again.
/mission prepare-file <plan-id> (explicit legacy Markdown/JSON compatibility)
Changes require native confirmation in this principal TUI session. A copied local setup contract runs its hook during prepare after exact native consent; prepare starts no worker. Legacy v1 setup remains start-scoped. Pi and installed extensions are trusted to receive confirmation, not to attest human origin.
Preparation reports a status and next action. Technical errors need author correction, not user permission; unavailable setup or verification inputs remain unresolved.
The optional sealed-nested-verification-v1 profile permits an offline checker with read-only subject and copied runtime inputs. Ordinary worker namespace, socket and tool restrictions remain unchanged. Start reuses observed copied setup; it does not bootstrap again.`;

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
  let lifecycle = 0;
  let pending: string | undefined;
  let executionAction: string | undefined;
  let draft: { request: PreparationRequest; ctx: ExtensionCommandContext; sessionId: string; root: string; epoch: number; proposal?: object; exactDetails?: boolean } | undefined;
  const discardDraft = () => { if (draft) invalidatePreparationRequest(draft.request); draft = undefined; };
  const invalidate = () => { discardDraft(); lifecycle++; pending = undefined; executionAction = undefined; engine?.invalidateSetupAdmission(); };
  const read = async <T>(operation: (db: MissionStore) => T | Promise<T>): Promise<T> => {
    const db = await openMissionStore({ readOnly: true });
    try { return await operation(db); } finally { db.close(); }
  };

  const eligible = (ctx: { mode: string; sessionManager?: { getSessionId(): string } }) =>
    (ctx.mode === "tui" || ctx.mode === "rpc") && !currentInstanceId() && !process.env.PITAKO_INSTANCE_ID && !!ctx.sessionManager?.getSessionId();
  const idOf = (ctx: { sessionManager?: { getSessionId(): string } }) => ctx.sessionManager?.getSessionId();
  const open = async (admitWriter?: (observation?: MissionStore) => void) => {
    if (!store) store = await openMissionStore({ admitWriter });
    admitWriter?.(store);
    return store;
  };
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
  const status = (ctx: { cwd: string }, db: MissionStore) => {
    const mission = db.findManagedMission(ctx.cwd);
    if (!mission) throw new Error("no mission for this repository");
    const state = reduceMissionEvents(mission);
    const integrated = [...mission.events].reverse().find((event) => event.kind === "mission.result.integrated" && event.revision === mission.revision);
    const result = integrated && JSON.parse(db.readArtifact(String(integrated.payload.reportHash)).toString("utf8"));
    const privateResult = result?.format === "mission-integrated-result-v1" ? {
      provisional: true, reportHash: integrated!.payload.reportHash, candidateRoot: result.candidateRoot,
      resultImageHash: result.resultImageHash, deliveryBaseManifestHash: result.deliveryBaseManifestHash,
      acceptedManifestHash: result.acceptedManifestHash, conditionalPatchHash: result.patchHash,
    } : undefined;
    const setup = state.state === "prepared" && mission.prepared?.setup ? new MissionSetup(db, mission.id).observe(mission) : undefined;
    const preparationStatus = state.state === "prepared" ? setup && setup.state !== "ready" ? "technical-unresolved" : "ready" : undefined;
    return { id: mission.id, revision: mission.revision, state: state.state, privateResult,
      ...(preparationStatus ? { preparationStatus, nextAction: setup && setup.state !== "ready"
        ? `Setup unresolved: ${setup.reason} ${mission.prepared?.setup?.identity.copy ? "Copied setup must settle during prepare; start cannot replay it." : `Separate /mission start ${mission.planId} consent is required by the legacy setup route; no preparation proof exists.`}`
        : `Use /mission start ${mission.planId} for separate execution consent.` } : {}),
      units: state.units, resumeAfterClose: mission.definition.authority.resumeAfterClose,
      owner: "read-only", latestSeq: mission.latestSeq };
  };
  const display = (ctx: { hasUI: boolean; ui: { notify(text: string, kind?: "info" | "error"): void } }, text: string) => {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
  };
  const observe = async (args: string, root: string) => {
    const query = parseMissionInspect(args);
    const missionId = query.missionId && /^[0-9a-f-]{36}$/i.test(query.missionId) ? query.missionId :
      (await inspectManagedMission(root, query.missionId))?.id;
    if (!missionId) throw new Error("no managed mission is bound to this repository");
    return JSON.stringify(await readMissionObservation({ ...query, missionId }, root));
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

  const activateConsole = async (ctx: ExtensionCommandContext) => {
    if (!eligible(ctx)) throw new Error("principal session required; use /mission help");
    if (!consoleSocket) {
      consoleSocket = await openMissionConsole(path.join(getPitakoDataDir(), "console"),
        (text, causalId) => submitOperator(ctx, text, recordOperatorInput("console", idOf(ctx)!, text, causalId)), (causalId, responseMs) => {
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
    }
    display(ctx, `Mission operator console: bun ${JSON.stringify(path.join(packageRoot(), "scripts/mission-console.ts"))} ${consoleSocket.path}`);
  };

  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_start", async (event, ctx) => {
    invalidate();
    if (!eligible(ctx)) return;
    try {
      if (!existsSync(path.join(ctx.cwd, ".git"))) return;
      // Read first. Only previously admitted lifecycle authority may acquire a writer here.
      const mission = existsSync(path.join(getPitakoDataDir(), "missions.db"))
        ? await read((db) => db.findManagedMission(ctx.cwd)) : undefined;
      const state = mission && reduceMissionEvents(mission).state;
      const release = mission && [...mission.events].reverse().find(({ kind }) => kind === "mission.owner.released");
      const lastBlock = mission && [...mission.events].reverse().find(({ kind }) => kind === "mission.blocked");
      const shutdownBlocked = state === "blocked" && ["quit", "reload"].includes(String(release?.payload.reason)) &&
        String(lastBlock?.payload.reason).includes("SDK sessions did not settle before Pi shutdown");
      const pause = mission && [...mission.events].reverse().find(({ kind }) => kind === "mission.paused");
      const orderlyClose = state === "paused" && pause?.payload.controlOrigin === "lifecycle" &&
        pause.payload.resumeAfterClose === true && release?.payload.pauseEventId === pause.eventId;
      if (mission && mission.definition.authority.resumeAfterClose &&
        ["startup", "reload"].includes(event.reason) && (state === "running" || shutdownBlocked || orderlyClose)) {
        await open();
        if (store!.ownerEpoch === null) return;
        const attached = attach(ctx, mission.id);
        if (orderlyClose) await attached.engine.resumeAfterClose();
        else attached.engine.start();
      }
      uiCursor = 0;
      uiMissionId = undefined;
      if (ctx.hasUI) {
        ticker = setInterval(() => { try { notifications(ctx); } catch { /* display cannot stop execution */ } }, 250);
        ticker.unref?.();
      }
    } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), "error"); }
  });
  pi.on("session_shutdown", async (event) => {
    invalidate();
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    if (consoleSocket) await consoleSocket.close();
    consoleSocket = undefined;
    if (engine) await engine.retireForShutdown(event.reason);
    else store?.close();
    engine = undefined;
    session = undefined;
    store = undefined;
  });

  const submitOperator = async (ctx: { cwd: string; mode: string; sessionManager?: { getSessionId(): string } }, text: string, operator?: OperatorReceipt,
    admitWriter?: (observation?: MissionStore) => void, setupAdmission?: SetupStartAdmission): Promise<string> => {
    if (!eligible(ctx)) throw new Error("foreground mission session required");
    if (!operator) throw new Error("host confirmation required; use /mission help");
    consumeOperatorInput(operator, idOf(ctx)!, text);
    const causalId = operator.id as ReturnType<typeof randomUUID>;
    const match = /^\/mission\s+(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/.exec(text);
    if (!match) throw new Error(usage);
    const [, verb, id, detail] = match;
    if (verb === "metrics") {
      const operation = (db: MissionStore) => JSON.stringify(metricCommand(db, [id, detail].filter(Boolean).join(" "), process.env.PITAKO_ENGINE_COMMIT ?? "unknown"));
      return text.includes("--import-observations") ? operation(await open()) : read(operation);
    }
    if (verb === "prepare") {
      const parsed = validateMissionFiles(ctx.cwd, id!);
      const db = await open(admitWriter);
      const created = db.createMission({ repositoryRoot: ctx.cwd, planId: id!, planFile: parsed.plan,
        definitionFile: parsed.definition, commandId: causalId, admissionReceiptId: causalId, operatorText: text, operatorReceipt: operator });
      // Register retirement for prepared authority too; constructing the engine never starts its pump.
      attach(ctx, created.id);
      return `Prepared ${created.id} @${created.revision}; no worker started.`;
    }
    if (verb === "inspect") return observe(text.slice("/mission ".length), ctx.cwd);
    if (verb === "status") {
      return read((db) => {
        const current = status(ctx, db);
        const mission = db.inspectMission(current.id);
        const cursor = mission.events.filter((event) => event.kind === "mission.notification.delivered")
          .reduce((seq, event) => Math.max(seq, Number(event.payload.throughSeq)), 0);
        const notifications = mission.events.filter((event) => event.seq > cursor &&
          ["unit.accepted", "unit.blocked", "mission.completed", "mission.revised", "mission.blocked"].includes(event.kind));
        if (notifications.length) pendingDisplay.set(causalId, { missionId: mission.id,
          throughSeq: notifications.at(-1)!.seq, eventIds: notifications.map((event) => event.eventId) });
        return JSON.stringify({ ...current, notifications: notifications.map((event) =>
          `${event.kind}: ${event.unitId ?? mission.planId} @${event.revision}`) });
      });
    }
    if (verb === "export") {
      return read(async (db) => {
        const mission = db.findManagedMission(ctx.cwd);
        if (!mission) throw new Error("mission not found");
        return JSON.stringify(await db.exportMission(mission.id, id));
      });
    }
    if (!id) throw new Error("mission id required");
    if (verb === "revise") {
      const separator = operator.source === "console" ? detail?.lastIndexOf(" -- ") ?? -1 : -1;
      const instruction = separator < 0 ? detail?.trim() ?? "" : detail!.slice(0, separator).trim();
      await open(admitWriter);
      const active = attach(ctx, id);
      if (separator >= 0 && classifyMissionInput(instruction) === "ambiguous") {
        const receipt = recordOperatorInput("console", idOf(ctx)!, text, causalId, instruction)!;
        const { question } = askMissionChoice({ store: store!, engine: active.engine, missionId: active.mission.id,
          expectedVersion: active.mission.version, receipt, delta: detail!.slice(separator + 4) });
        return question;
      }
      const receipt = recordOperatorChoice(store!, active.mission, idOf(ctx)!, text, detail?.trim() ?? "", causalId, operator.source);
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
    await open(admitWriter);
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
      active.engine.start(verb === "start" ? operator : undefined, setupAdmission);
      return `${verb}: ${active.mission.id}; resumeAfterClose: ${active.mission.definition.authority.resumeAfterClose}`;
    }
    if (verb === "attach") return `Attached ${active.mission.id}; ${JSON.stringify(status(ctx, store!))}`;
    await active.engine.control(verb as "pause" | "resume" | "cancel", operator, admitWriter ? () => admitWriter(store!) : undefined);
    return `${verb}: ${active.mission.id}`;
  };

  const confirmNative = async (ctx: ExtensionCommandContext, args: string): Promise<string> => {
    if (!eligible(ctx) || ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.confirm !== "function")
      throw new Error("native confirmation needs the principal TUI session and usable UI; use /mission help (or explicitly /mission console)");
    const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(args.trim());
    if (!match || !["prepare", "start", "pause", "resume", "cancel", "revise"].includes(match[1]!))
      throw new Error(usage);
    const [, verb, id] = match;
    let detail: string | undefined = match[3]?.trim();
    if (verb === "revise" && (!detail || /^answer\s+[0-9a-f-]{36}$/i.test(detail)) && typeof ctx.ui.input !== "function")
      throw new Error("native choice input is unavailable; repeat /mission revise in this principal TUI session");
    // A new command replaces an outstanding prompt, even if its dialog is still visible.
    const nonce = randomUUID();
    executionAction = nonce;
    engine?.invalidateSetupAdmission();
    pending = nonce;
    const epoch = lifecycle;
    const sessionId = idOf(ctx)!;
    const root = realpathSync(ctx.cwd);
    const live = () => {
      if (pending !== nonce || lifecycle !== epoch || idOf(ctx) !== sessionId ||
        realpathSync(ctx.cwd) !== root || !eligible(ctx) || ctx.mode !== "tui" || !ctx.hasUI)
        throw new Error("confirmation expired; repeat the exact /mission action in this session");
    };
    if (verb === "revise" && !detail) {
      detail = await ctx.ui.input("Exact mission choice", 'Change predicate <id> <field> to <JSON value> (or unit/mission)');
      live();
      if (!detail) { pending = undefined; return "Choice dismissed; nothing changed."; }
    }
    if (verb !== "revise" && detail) throw new Error(`unexpected action payload; ${usage}`);
    const answer = verb === "revise" && /^answer\s+([0-9a-f-]{36})$/i.exec(detail ?? "");
    if (answer) {
      const { mission, question } = await read((db) => {
        const mission = db.findManagedMission(root);
        if (!mission || (mission.planId !== id && mission.id !== id)) throw new Error("no matching managed mission");
        const question = pendingMissionQuestions(mission.events, db).find(({ id }) => id === answer[1]);
        if (!question || !question.bindings.length || question.bindings.length > 32 || question.bindings.some(({ field }) => !field))
          throw new Error("question has no bounded editable fields; use /mission revise <plan-id> withdraw <question-id>");
        return { mission, question };
      });
      const edits = [];
      for (const binding of question.bindings) {
        const target = { kind: binding.kind, ...(binding.kind === "mission" ? {} : { id: binding.id }), field: binding.field! };
        const before = editValue(mission.definition, target);
        const value = await ctx.ui.input(`Answer ${question.id}: ${JSON.stringify(target)}`, `Current: ${JSON.stringify(before)}; enter new JSON value`);
        live();
        if (value === undefined) { pending = undefined; return "Choice dismissed; nothing changed."; }
        let after: unknown;
        try { after = JSON.parse(value); } catch { throw new Error("choice value must be JSON; repeat /mission revise in this session"); }
        edits.push({ target, before, after });
      }
      detail = `answer ${question.id} ${JSON.stringify(edits)}`;
    }
    const text = `/mission ${verb} ${id}${detail ? ` ${detail}` : ""}`;
    const capture = (db?: MissionStore) => {
      const ownership = db?.ownershipIdentity ?? { epoch: 0, claimId: "" };
      const identity = (file: string) => { const stat = statSync(file); return `${stat.dev}:${stat.ino}`; };
      const rootStat = statSync(root), gitStat = statSync(path.join(root, ".git"));
      const physical = { root: `${rootStat.dev}:${rootStat.ino}`, git: `${gitStat.dev}:${gitStat.ino}`,
        gitFile: gitStat.isFile() ? sha256(readFileSync(path.join(root, ".git"))) : undefined };
      if (verb === "prepare") {
        const parsed = validateMissionFiles(root, id!);
        const existing = db?.findManagedMission(root);
        return { ownership, physical, root, text, source: realpathSync(parsed.plan), sourceHash: sha256(parsed.planBytes),
          sourceRevision: parsed.metadata.revision, definitionSource: realpathSync(parsed.definition),
          sourceIdentity: identity(parsed.plan), definitionIdentity: identity(parsed.definition),
          definitionHash: sha256(parsed.definitionBytes), definition: JSON.parse(parsed.definitionBytes.toString("utf8")),
          existing: existing ? { id: existing.id, revision: existing.revision, planHash: existing.snapshot.planHash,
            definitionHash: existing.snapshot.definitionHash, state: reduceMissionEvents(existing).state } : null };
      }
      const mission = db?.findManagedMission(root);
      if (!mission || (mission.id !== id && mission.planId !== id)) throw new Error("no matching managed mission; use /mission prepare <plan-id>");
      if (verb === "revise" && mission.planId !== id) throw new Error(`exact revision command uses /mission revise ${mission.planId}`);
      const state = reduceMissionEvents(mission).state;
      if (["completed", "cancelled"].includes(state) || verb === "resume" && state !== "paused" ||
        verb === "start" && state === "paused") throw new Error(`cannot ${verb} a ${state} mission; use /mission status`);
      const choice = verb === "revise" ? parseChoice(detail!, mission.definition) : undefined;
      const choiceValidation = choice && validateOperatorChoice(db!, mission, choice);
      const names = files(root, mission.planId);
      const pin = mission.prepared ? missionInputIdentity(mission, root) : undefined;
      if (verb === "start" && mission.prepared?.setup) assertSetupInputs(mission.prepared.setup);
      return { ownership, physical, root, text, missionId: mission.id, revision: mission.revision,
        currentConfigHash: sha256(Buffer.from(JSON.stringify(loadPitakoConfig({ cwd: root })))),
        planHash: mission.snapshot.planHash, definitionHash: mission.snapshot.definitionHash, state,
        preparedHash: mission.snapshot.preparedHash, pin,
        source: realpathSync(mission.snapshot.sourcePath), sourceHash: sha256(readFileSync(mission.snapshot.sourcePath)),
        sourceRevision: parsePlanDocument(readFileSync(mission.snapshot.sourcePath, "utf8")).revision,
        sourceIdentity: identity(mission.snapshot.sourcePath),
        ...(mission.prepared ? {} : { definitionIdentity: identity(names.definition),
          definitionSource: realpathSync(names.definition), fileDefinitionHash: sha256(readFileSync(names.definition)) }),
        questions: choiceValidation?.pending,
        generation: ["revise", "start", "resume"].includes(verb!) ? [...mission.events].reverse().find(({ kind }) =>
          kind === "mission.finalization.generation" || kind === "mission.result.integrated")?.eventId : undefined,
        definition: mission.definition, choice };
    };
    const observe = async () => existsSync(path.join(getPitakoDataDir(), "missions.db")) ? read(capture) : capture();
    try {
      const before = await observe();
      live();
      const accepted = await ctx.ui.confirm(`Confirm mission ${verb}`, JSON.stringify({ action: verb,
        ...("choice" in before ? { typedPayload: before.choice } : {}), ...before }, null, 2));
      live();
      if (accepted !== true) return "Confirmation declined or dismissed; nothing changed.";
      const after = await observe();
      live();
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("mission inputs, state or ownership changed; repeat /mission action to review a fresh confirmation");
      // Consume the callback before the first write. Telemetry version changes are deliberately not part of the approval.
      const receipt = recordOperatorInput("native-confirmation", sessionId, text, nonce)!;
      let claimValidated = false;
      const recheck = (db?: MissionStore) => {
        live();
        const current = capture(db);
        // Only this admission's own successful claim may advance its ownership binding.
        if (claimValidated && db === store && db?.ownerEpoch === before.ownership.epoch + 1 &&
          current.ownership.epoch === db.ownerEpoch && current.ownership.claimId === db.ownerAcquisitionProof?.claimId)
          current.ownership = before.ownership;
        if (JSON.stringify(before) !== JSON.stringify(current))
          throw new Error("confirmation expired at writer admission; repeat /mission action");
        if (db && db !== store) claimValidated = true;
      };
      // Recheck existing writers synchronously; new writers also compare their observed claim under the write lock.
      if (store) recheck(store);
      let setupAdmission: SetupStartAdmission | undefined;
      if (verb === "start" && "preparedHash" in before && before.preparedHash) {
        const db = await open(recheck);
        recheck(db);
        const mission = db.findManagedMission(root)!;
        if (mission.prepared?.setup && !mission.prepared.setup.identity.copy) {
          const setupText = setupStartText(db, mission.id, sessionId);
          const confirmed = await ctx.ui.confirm("Confirm exact setup execution", setupText);
          live();
          recheck(db);
          if (confirmed !== true) return "Setup execution declined; no setup or worker started.";
          const checkExecution = () => {
            const current = capture(db);
            if (lifecycle !== epoch || executionAction !== nonce || idOf(ctx) !== sessionId ||
              ctx.mode !== "tui" || !ctx.hasUI || !eligible(ctx) ||
              realpathSync(ctx.cwd) !== root || JSON.stringify(current.physical) !== JSON.stringify(before.physical) ||
              !("currentConfigHash" in current) || current.currentConfigHash !== before.currentConfigHash ||
              setupStartText(db, mission.id, sessionId) !== setupText)
              throw new Error("live setup execution action expired");
          };
          setupAdmission = admitSetupStart(db, mission.id, sessionId,
            recordOperatorInput("native-confirmation", sessionId, setupText)!, checkExecution);
        }
      }
      const result = await submitOperator(ctx, text, receipt, recheck, setupAdmission);
      pending = undefined;
      return result;
    } finally { if (pending === nonce) pending = undefined; }
  };

  const queuePreparation = (ctx: ExtensionCommandContext, id: string) => {
    if (!eligible(ctx) || ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.confirm !== "function")
      throw new Error("native preparation needs the principal TUI session and usable UI; use /mission help");
    discardDraft();
    pending = undefined;
    const root = realpathSync(ctx.cwd), sessionId = idOf(ctx)!;
    const request = openPreparationRequest(id, root, sessionId);
    draft = { request, ctx, sessionId, root, epoch: lifecycle };
    const context = preparationContext(request);
    // Supported foreground delivery queues behind busy work; never wait for idle or create another coordinator.
    pi.sendUserMessage(`Mission preparation request (non-authoritative):\n${JSON.stringify(context)}
Author a schemaVersion 2 {definition,mappings} proposal using mission_prepare with id ${JSON.stringify(id)} and requestId ${JSON.stringify(request.id)}.
Read repository context and extensions/mission/model.ts for the executable contract. Preserve every host source ID, full original objective/WorkBrief/criterion bytes, required dependencies and complete role targets (reasoning/fast/fallbacks). Select supported discriminating command/hash proofs and ordinary/integrated/affected/final obligations; unsupported proofs/prerequisites remain specific issues, never manual or false-PASS. GATES is source context, not a compiler.
Make supported technical choices autonomously. Propose explicit permissions and all five engine budgets, resume policy and (if needed) setup allocation; these are estimates, NOT approval. Group genuine source ambiguities with exact excerpts and proposed interpretations. The host will ask for exact native decisions and preview/admission; no implementation, setup, start, credentials, configuration edit or worker launch is authorized by this request.`, { deliverAs: "followUp" });
    return `Preparation ${request.id} queued to this coordinator; no mission admitted, setup or worker started.`;
  };

  const authorPreparation = async (params: { id: string; requestId?: string; proposal?: unknown;
    interpretations?: Array<{ sourceId: string; disposition: "context" | "criterion" }>; setup?: SetupAllocation }, ctx: ExtensionCommandContext) => {
    const current = draft;
    if (!current || params.requestId !== current.request.id) throw new PreparationBindingError("current host request required; use /mission prepare <plan-id>");
    const live = () => {
      if (draft !== current || current.epoch !== lifecycle || idOf(ctx) !== current.sessionId ||
        idOf(current.ctx) !== current.sessionId || !eligible(ctx) || ctx.mode !== "tui" || !ctx.hasUI ||
        realpathSync(ctx.cwd) !== current.root || realpathSync(current.ctx.cwd) !== current.root ||
        preparationContext(current.request).binding.planId !== params.id)
        throw new PreparationBindingError("preparation expired; reauthor with /mission prepare <plan-id>");
    };
    live();
    if (params.proposal === undefined) return { authority: "proposal-only", context: preparationContext(current.request) };
    const proposal = structuredClone(params.proposal);
    current.proposal = proposal as object;
    const check = () => { live(); if (current.proposal !== proposal) throw new PreparationBindingError("proposal replaced; confirmation expired"); };
    let result = validatePreparation({ request: current.request, proposal, setup: params.setup });
    if (result.state === "needs-input") {
      const definition = (proposal as { definition?: MissionDefinition })?.definition;
      // Only decisions with independently bound texts can be asked; structural/proof errors stay author corrections.
      if (result.status === "technical-unresolved") return { ...result, authority: "proposal-only" };
      const authority = definition && result.issues.some(({ code }) => code === "authority-choice")
        ? { authority: definition.authority, budget: definition.budget } : undefined;
      const inventory = preparationContext(current.request).inventory;
      const invalidInterpretation = (params.interpretations ?? []).find(({ sourceId, disposition }) =>
        !inventory.unresolved.some(({ id }) => id === sourceId) || !["context", "criterion"].includes(disposition));
      if (invalidInterpretation) {
        const issue = preparationIssue("invalid-proposal", "source",
          `Interpretation requires a current unresolved source ID and context/criterion disposition: ${JSON.stringify(invalidInterpretation)}`);
        return { state: "needs-input", status: "technical-unresolved", authority: "proposal-only",
          issues: [issue], nextAction: issue.nextAction };
      }
      const decisionTexts = () => [
        ...(authority ? [preparationAuthorityText(current.request, authority)] : []),
        ...(params.interpretations ?? []).map(({ sourceId, disposition }) => preparationAnswerText(current.request, sourceId, disposition)),
        ...(params.setup ? [preparationSetupText(current.request, params.setup)] : []),
      ];
      let decisions: string[];
      try {
        decisions = decisionTexts();
      } catch (error) {
        check();
        const issue = preparationIssue("missing-local-input", "prerequisite", String(error));
        return { state: "needs-input", status: "technical-unresolved", authority: "proposal-only",
          issues: [issue], nextAction: issue.nextAction };
      }
      if (!decisions.length) return { ...result, authority: "proposal-only", message: "Restore missing mappings or resolve specific unsupported issues; no confirmation or admission." };
      if (current.exactDetails) display(current.ctx, JSON.stringify({ context: preparationContext(current.request),
        issues: result.issues, decisions: decisions.map((text) => JSON.parse(text)) }, null, 2));
      const accepted = await current.ctx.ui.confirm("Preparation questions — explicit decisions, not estimate approval by default",
        preparationView({ action: "preparation-authority / source-meaning / setup effects",
          context: preparationContext(current.request), definition: definition!, setup: params.setup,
          setupDestination: decisions.map((text) => JSON.parse(text)).find(({ action }) => action === "preparation-setup-effects")
            ?.identity.copy?.destination,
          issues: result.issues, interpretations: params.interpretations }));
      check();
      if (accepted !== true) { discardDraft(); return { state: "dismissed", authority: "proposal-only", message: "Nothing admitted; repeat /mission prepare to reauthor." }; }
      if (JSON.stringify(decisions) !== JSON.stringify(decisionTexts()))
        throw new PreparationBindingError("preparation decision inputs changed; repeat /mission prepare");
      if (authority) bindPreparationAuthority(current.request, authority,
        recordOperatorInput("native-confirmation", current.sessionId, preparationAuthorityText(current.request, authority))!);
      for (const { sourceId, disposition } of params.interpretations ?? [])
        bindPreparationAnswer(current.request, sourceId, disposition,
          recordOperatorInput("native-confirmation", current.sessionId, preparationAnswerText(current.request, sourceId, disposition))!);
      if (params.setup) bindPreparationSetup(current.request, params.setup,
        recordOperatorInput("native-confirmation", current.sessionId, preparationSetupText(current.request, params.setup))!);
      result = validatePreparation({ request: current.request, proposal, setup: params.setup });
    }
    if (result.state !== "ready") return { ...result, authority: "proposal-only" };
    const prepared = result.prepared, text = preparedAdmissionText(prepared);
    const capture = (db?: MissionStore) => {
      check();
      if (preparedAdmissionText(prepared) !== text) throw new Error("prepared inputs changed");
      const existing = db?.findManagedMission(current.root);
      return { ownership: db?.ownershipIdentity ?? { epoch: 0, claimId: "" },
        existing: existing ? { id: existing.id, revision: existing.revision, state: existing.state,
          planHash: existing.snapshot.planHash, definitionHash: existing.snapshot.definitionHash, preparedHash: existing.snapshot.preparedHash } : null };
    };
    const before = existsSync(path.join(getPitakoDataDir(), "missions.db")) ? await read(capture) : capture();
    check();
    if (current.exactDetails) display(current.ctx, JSON.stringify({ action: JSON.parse(text), preparedHash: result.digest,
      prepared, observed: before }, null, 2));
    const accepted = await current.ctx.ui.confirm("Confirm exact prepared mission — not start",
      preparationView({ action: "admit-prepared-mission", context: preparationContext(current.request),
        definition: prepared.definition, setup: prepared.setup?.decision.values,
        setupDestination: prepared.setup?.identity.copy?.destination, issues: result.issues }) +
      `\nStatus: ${result.status}\nNext action: ${result.nextAction}\nExact binding: ${result.digest}\nOptional JSON: /mission prepare-details before submitting a proposal.`);
    check();
    if (accepted !== true) { discardDraft(); return { state: "dismissed", authority: "proposal-only", message: "Nothing admitted; repeat /mission prepare." }; }
    let claimValidated = false;
    const recheck = (db?: MissionStore) => {
      const now = capture(db);
      if (claimValidated && db === store && db?.ownerEpoch === before.ownership.epoch + 1 &&
        now.ownership.claimId === db.ownerAcquisitionProof?.claimId) now.ownership = before.ownership;
      if (JSON.stringify(now) !== JSON.stringify(before)) throw new PreparationBindingError("preparation ownership or mission changed; repeat /mission prepare");
      if (db && db !== store) claimValidated = true;
    };
    if (store) recheck(store);
    const db = await open(recheck);
    recheck(db);
    const receipt = recordOperatorInput("native-confirmation", current.sessionId, text)!;
    const mission = db.createMission({ repositoryRoot: current.root, planId: params.id, prepared,
      commandId: receipt.id, admissionReceiptId: receipt.id, operatorText: text, operatorReceipt: receipt });
    const active = attach(current.ctx, mission.id);
    let setupOutcome: import("./setup.ts").SetupReadiness | undefined;
    if (prepared.setup?.identity.copy) {
      const writer = db.ownershipIdentity;
      setupOutcome = await active.engine.prepareSetup(() => {
        check();
        if (JSON.stringify(db.ownershipIdentity) !== JSON.stringify(writer) ||
          preparedAdmissionText(prepared) !== text) throw new PreparationBindingError("prepare setup binding changed");
      });
    }
    discardDraft();
    const status = setupOutcome ? setupOutcome.state === "ready" ? "ready" : "technical-unresolved" : result.status;
    const nextAction = setupOutcome ? setupOutcome.state === "ready" ? `Use /mission start ${params.id}; setup will be rechecked and reused.`
      : `Setup unresolved: ${setupOutcome.reason}; no worker started, no automatic replay.` : result.nextAction;
    display(current.ctx, `Prepared ${mission.id} @${mission.revision}; status: ${status}. ${nextAction} No worker started.`);
    // Tool output is diagnostic, never a transferable operator receipt.
    return { state: "prepared", status, nextAction, issues: setupOutcome?.state === "ready" ? result.issues.filter(({ code }) => code !== "unresolved-setup") : result.issues,
      authority: "proposal-only", missionId: mission.id, preparedHash: result.digest,
      message: "Host native admission recorded; this tool result is not a confirmation receipt. Start requires /mission start." };
  };

  pi.registerCommand("mission", {
    description: "Prepare, inspect and control missions with exact native confirmation; /mission help",
    handler: async (args, ctx) => {
      const [verb, id] = args.trim().split(/\s+/);
      try {
        if (!verb || verb === "help") display(ctx, usage);
        else if (verb === "console") await activateConsole(ctx);
        else if (verb === "metrics") {
          if (args.includes("--import-observations")) throw new Error("observation import requires the operator console; explicitly request /mission console in this session");
          display(ctx, await read((db) => JSON.stringify(metricCommand(db, args.trim().slice("metrics".length).trim(), process.env.PITAKO_ENGINE_COMMIT ?? "unknown"))));
        } else if (verb === "inspect") {
          if (currentInstanceId() || process.env.PITAKO_INSTANCE_ID || executionForSession(ctx.sessionManager?.getSessionId?.()))
            throw new Error("mission inspect requires a principal session");
          display(ctx, await observe(args, ctx.cwd));
        }
        else if (verb === "status") { display(ctx, await read((db) => JSON.stringify(status(ctx, db)))); }
        else if (verb === "export") {
          display(ctx, await read(async (db) => {
            const mission = db.findManagedMission(ctx.cwd);
            if (!mission) throw new Error("mission not found");
            return JSON.stringify(await db.exportMission(mission.id, id));
          }));
        } else if (verb === "prepare-details") {
          if (!draft || args.trim() !== "prepare-details" || idOf(ctx) !== draft.sessionId)
            throw new Error("Use /mission prepare first in this session.");
          preparationContext(draft.request);
          draft.exactDetails = true;
          display(ctx, "Exact host-owned JSON will accompany the next preparation confirmation; it does not grant consent.");
        } else if (verb === "prepare") {
          if (!id || args.trim() !== `prepare ${id}`) throw new Error(usage);
          display(ctx, queuePreparation(ctx, id));
        } else if (["prepare-file", "start", "pause", "resume", "cancel", "revise"].includes(verb!)) {
          discardDraft();
          display(ctx, await confirmNative(ctx, args.replace(/^prepare-file\b/, "prepare")));
        }
        else throw new Error(`unsupported mission action ${verb}; ${usage}`);
      } catch (error) {
        const message = `${String(error)}\nUse /mission help in this session.`;
        if (ctx.hasUI) ctx.ui.notify(message, "error"); else throw new Error(message);
      }
    },
  });

  pi.registerTool({
    name: "mission_observe", label: "Mission observation",
    description: "Read retained assignment, revision, attempt, evidence and native history pages for a mission bound to this repository. Read cursors retrieve original full briefs and results. Pure consultation: no execution owner, repair, pause, approval or mutation authority. Missing history is not proof of no activity; compare original intent with actions and recommend a discriminating check or an explicit native control decision.",
    parameters: Type.Object({ missionId: Type.String(), unitId: Type.Optional(Type.String()),
      attemptId: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()) }),
    execute: async (_id, params, _signal, _update, ctx) => {
      if (currentInstanceId() || process.env.PITAKO_INSTANCE_ID || executionForSession(ctx.sessionManager?.getSessionId?.()))
        throw new Error("mission_observe requires a principal session");
      const page = await readMissionObservation(params, ctx.cwd);
      return { content: [{ type: "text" as const, text: JSON.stringify(page) }], details: page };
    },
  });

  const tool = (name: string, parameters: any, execute: (params: any, ctx: any) => Promise<unknown>) => {
    pi.registerTool({ name, label: name, description: name === "mission_prepare"
      ? "Submit an untrusted {definition,mappings} authoring proposal for the current host requestId from /mission prepare, or retrieve its source context. Optional source interpretations/setup are proposed native decisions, not approval. Questions, exact preview and native confirmation leave the mission prepared; /mission start is separate. Output is never a confirmation receipt."
      : `Durable mission ${name.slice(8)}`, parameters,
      execute: async (_id, params, _signal, _update, ctx) => ({
        content: [{ type: "text", text: JSON.stringify(await execute(params, ctx)) }], details: undefined,
      }) });
  };
  tool("mission_prepare", Type.Object({ id: Type.String(), requestId: Type.Optional(Type.String()),
    proposal: Type.Optional(Type.Unknown()), interpretations: Type.Optional(Type.Array(Type.Object({
      sourceId: Type.String(), disposition: Type.Union([Type.Literal("context"), Type.Literal("criterion")]),
    }))), setup: Type.Optional(Type.Object({ effectProfile: Type.Union([Type.Literal("execution-root-local-v1"), Type.Literal("execution-root-local-copy-v1")]),
      writableDirectories: Type.Array(Type.String()), activeTimeMs: Type.Number(), artifactBytes: Type.Number(),
      copy: Type.Optional(Type.Object({ bounds: Type.Object({ paths: Type.Number(), largestFileBytes: Type.Number(), totalBytes: Type.Number() }),
        seeds: Type.Array(Type.Object({ source: Type.String(), destination: Type.String(),
          bounds: Type.Object({ paths: Type.Number(), largestFileBytes: Type.Number(), totalBytes: Type.Number() }) })) })) })) }),
  async (params, ctx) => {
    try { return await authorPreparation(params, ctx); }
    catch (error) { discardDraft(); throw error; }
  });
  tool("mission_status", Type.Object({}), async (_params, ctx) => read((db) => status(ctx, db)));
  tool("mission_start", Type.Object({ id: Type.String() }), async () => {
    throw new Error("model tool cannot mint start authority; use /mission start <plan-id> in this principal session");
  });
  tool("mission_propose_change", Type.Object({ id: Type.String(), claimedImpact: Type.Optional(Type.Array(Type.String())) }), async ({ id }, ctx) => {
    const parsed = validateMissionFiles(ctx.cwd, id);
    return { candidateRevision: parsed.metadata.revision, message: "Proposal only; operator instruction or bounded technical admission required" };
  });
  tool("mission_control", Type.Object({ action: Type.String() }), async () => {
    throw new Error("model tool cannot mint operator control authority; use /mission pause|resume|cancel <plan-id> in this principal session");
  });
  tool("mission_consult", Type.Object({ question: Type.String() }), async ({ question }) => ({ question, status: "advisory; no durable team authority before T6" }));
  tool("mission_submit", Type.Object({ finding: Type.String() }), async () => {
    throw new Error("worker identity requires a host-bound managed attempt; submission is unavailable outside one");
  });
}
