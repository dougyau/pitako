import { randomUUID } from "node:crypto";
import { admitTeamMember, disbandTeam, teamAssignments, type createTeam } from "../team.ts";
import { backgroundExecutor, cancelTeamWorker, intermediateReceipts, publishIntermediate, teamWorkerStatus, turnTeamWorker } from "../agent/background.ts";
import type { AgentRunResult } from "../agent/run.ts";
import type { HistoryOrigin } from "../agent/history.ts";
import { AgentClosureError } from "../agent/closure.ts";
import { resolveRoleFromConfig } from "../roles/load.ts";
import type { ModelTarget, PitakoConfig, ResolvedRole } from "../roles/types.ts";
import { participant, type Body, type Message, type Stage } from "./types.ts";

type Team = ReturnType<typeof createTeam>;
type Member = ReturnType<typeof admitTeamMember>;
export function createConsultation(input: { team: Team; config: PitakoConfig; mode?: "consultation" | "table"; goal: string; topic?: string;
  root: { assignmentId: string; memberId: string; instanceId: string }; origin: HistoryOrigin; cwd: string; owns: () => boolean }) {
  const snapshotId = randomUUID(), messages: Message[] = [], controls: { action: string; text?: string }[] = [];
  const mode = input.mode ?? "consultation";
  let round = 0, ordinal = 0, sharedId = snapshotId;
  const failures: { memberId: string; stage: Stage; round: number; error: string }[] = [];
  const appliedControls: { action: string; text?: string }[] = [];
  const record = (message: Message) => { messages.push(structuredClone(message)); return message; };
  const candidates = input.config.architecture!;
  const snapshot = { id: snapshotId, general: candidates.candidates.map((candidate, index) => ({ ref: `general:${index}`, ...candidate })),
    topics: candidates.topics.map((topic, index) => ({ topic: topic.topic, ref: `topic:${index}`,
      candidates: topic.candidates.map((candidate, candidateIndex) => ({ ref: `topic:${index}:${candidateIndex}`, ...candidate })) })) };
  let state = "starting", stage: Stage | "waiting" | "closing" = "composition", stopping = false, finishing = false;
  let wake: (() => void) | undefined, signal: AbortSignal | undefined;
  const check = () => { if (!input.owns() || stopping || signal?.aborted) throw new Error("architecture authority retired or stopped"); };
  const current = () => input.owns() && !stopping && !signal?.aborted;
  const capability = (identity: { assignmentId: string; memberId: string }, author: string) => {
    let publication: { ordinal: number; snapshotId: string; round?: number };
    const attached = participant({ current, publish(message) {
      check();
      return structuredClone({ ...message, ...identity, roomId: input.team.teamId, author, id: randomUUID(), ...publication });
    } });
    const open = attached.open;
    attached.open = kind => {
      open(kind);
      publication = { ordinal: ++ordinal, snapshotId: sharedId, ...(round ? { round } : {}) };
    };
    return attached;
  };
  const director = capability(input.root, "architect");
  const rootRole = resolveRoleFromConfig(input.config, "architect");
  const strictRole = (role: ResolvedRole): ResolvedRole => ({ ...role, modelPolicy: { ...role.modelPolicy,
    primary: role.modelPolicy.primary && strictTarget(role.modelPolicy.primary), fallbacks: role.modelPolicy.fallbacks.map(strictTarget) } });
  const rootArchitecture = { config: input.config, role: strictRole(rootRole), participant: director };
  const rootTurn = async (kind: Stage, context: unknown) => {
    check(); stage = kind; director.open(kind);
    const result = await turnTeamWorker(input.team.evaluation.token, input.root.instanceId, prompt(kind, context));
    check();
    return { result, message: record(director.settle(result.status === "completed")) };
  };
  const origin = () => {
    const caller = director.caller;
    caller.check();
    return { ...input.origin, entrypoint: "architecture_start" as const, parentAssignmentId: input.root.assignmentId,
      callerSessionId: caller.sessionId, callerSessionFile: caller.sessionFile,
      toolCallId: messages.filter(message => message.author === "architect").at(-1)?.native.toolCallId };
  };
  const internal = (role: ResolvedRole, mandate: string, author = role.id) => {
    const caller = origin();
    // Admission happens only after a settled, authorized Architect turn.
    director.caller.append("pitako.architecture.dispatch", { roomId: input.team.teamId, parentAssignmentId: input.root.assignmentId,
      role: role.id, mandate, callerSessionId: caller.callerSessionId });
    let member: Member;
    const attached = capability({ get assignmentId() { return member.assignmentId; }, get memberId() { return member.memberId; } }, author);
    member = admitTeamMember(input.team, { roleId: role.id, task: mandate, cwd: input.cwd, historyOrigin: caller,
      executor: backgroundExecutor(), architecture: { config: input.config, role: strictRole(role), participant: attached },
      recipient: { kind: "protocol", settle() {} } });
    return { member, attached };
  };
  const memberTurn = async (target: ReturnType<typeof internal>, kind: Stage, context: unknown) => {
    check(); stage = kind; target.attached.open(kind);
    const result = await target.member.turn(prompt(kind, context));
    check();
    return target.attached.settle(result.status === "completed");
  };
  let pendingDoubts: Message["doubts"] = [];
  const resolveDoubts = async (sources: Message[], phase = "consultation") => {
    const doubts = [...new Map([...pendingDoubts, ...sources.flatMap(message => message.doubts)].map(doubt => [doubt.id, doubt])).values()];
    pendingDoubts = [];
    const plan = (await rootTurn("consultation-plan", { phase, sources, doubts })).message;
    if (plan.body.kind !== "consultation-plan") throw new Error("invalid consultation plan");
    const known = new Set(doubts.map(doubt => doubt.id));
    const validateRefs = (refs: string[]) => { if (new Set(refs).size !== refs.length || refs.some(ref => !known.has(ref))) throw new Error("unknown or duplicate doubt reference"); };
    validateRefs(plan.body.resolutions.map(resolution => resolution.doubtId));
    const requests = plan.body.support;
    requests.forEach((request, index) => {
      validateRefs(request.doubtIds);
      if (!request.brief.trim() || !request.doubtIds.length || new Set(request.prerequisites).size !== request.prerequisites.length || request.prerequisites.some(prerequisite => prerequisite >= requests.length || prerequisite === index))
        throw new Error("invalid support prerequisite");
    });
    const covered = [...plan.body.resolutions.map(item => item.doubtId), ...requests.flatMap(item => item.doubtIds)];
    if (known.size !== new Set(covered).size || covered.length !== new Set(covered).size) throw new Error("each doubt requires exactly one resolution or support request");
    const pending = new Set(requests.map((_, index) => index));
    const ordered: number[][] = [];
    const planned = new Set<number>();
    while (pending.size) {
      const ready = [...pending].filter(index => requests[index]!.prerequisites.every(value => planned.has(value))).slice(0, 2);
      if (!ready.length) throw new Error("cyclic support prerequisites");
      ordered.push(ready);
      for (const index of ready) { pending.delete(index); planned.add(index); }
    }
    const responses: { id: string; status: string; message?: Message; error?: string }[] = [];
    // Topological batches: at most two admitted supports; output remains request ordered.
    for (const batch of ordered) {
      const settled = await joined(batch.map(async ordinal => {
        const request = requests[ordinal]!;
        if (request.prerequisites.some(prerequisite => responses[prerequisite]?.status !== "completed"))
          return { id: `support:${ordinal}`, status: "failed", error: "prerequisite failed" };
        const target = internal(resolveRoleFromConfig(input.config, request.role), request.brief);
        try {
          const message = await memberTurn(target, "consultation-response", { request, prerequisites: request.prerequisites.map(value => responses[value]) });
          if (message.body.kind !== "consultation-response") throw new Error("invalid support response");
          validateRefs(message.body.doubtIds);
          if (JSON.stringify([...message.body.doubtIds].sort()) !== JSON.stringify([...request.doubtIds].sort())) throw new Error("support answered unauthorized doubts");
          return { id: target.member.assignmentId, status: "completed", message };
        } catch (error) {
          if (error instanceof AgentClosureError || !current()) throw error;
          return { id: target.member.assignmentId, status: "failed", error: String(error) };
        } finally { target.attached.revoke(); await target.member.finish(); }
      }));
      settled.forEach((response, index) => { responses[batch[index]!] = response; if (response.message) { record(response.message); pendingDoubts.push(...response.message.doubts); } });
    }
    const knowledge = (await rootTurn("knowledge", { phase, doubts, plan, responses })).message;
    if (knowledge.body.kind !== "knowledge") throw new Error("invalid knowledge");
    validateRefs(knowledge.body.resolutions.map(item => item.doubtId));
    if (knowledge.body.resolutions.length !== known.size) throw new Error("knowledge omitted doubts");
    for (const resolution of knowledge.body.resolutions) {
      if (resolution.supportIds.some(id => !responses.some(item => item.id === id))) throw new Error("unknown support reference");
      const requestIndex = requests.findIndex(request => request.doubtIds.includes(resolution.doubtId));
      if (requestIndex >= 0 && responses[requestIndex]?.status !== "completed" && resolution.status === "answered")
        throw new Error("failed prerequisite or support cannot produce answered knowledge");
    }
    return knowledge;
  };
  type Specialist = { target: ReturnType<typeof internal>; choice: Extract<Body, { kind: "composition" }>["specialists"][number]; active: boolean };
  let limitReached = false;
  const compose = async (outgoing: Specialist[] = []): Promise<Specialist[]> => {
    const composition = (await rootTurn("composition", { requestedTopic: input.topic, replacing: outgoing.map(item => item.target.member.memberId) })).message;
    if (composition.body.kind !== "composition" || composition.body.snapshotId !== snapshotId) throw new Error("composition snapshot mismatch");
    if (mode === "consultation" && composition.body.specialists.length !== 1) throw new Error("direct consultation requires one specialist");
    // Validate the entire composition before retiring any current member or admitting replacements.
    const choices = composition.body.specialists.map(choice => {
      if (!choice.mandate.trim() || !choice.reason.trim()) throw new Error("empty specialist mandate or reason");
      const general = snapshot.general.find(candidate => candidate.ref === choice.candidateRef);
      const topic = snapshot.topics.find(topic => topic.candidates.some(candidate => candidate.ref === choice.candidateRef));
      const selected = general ?? topic?.candidates.find(candidate => candidate.ref === choice.candidateRef);
      if (!selected) throw new Error("candidate must reference the captured snapshot");
      const seen = new Set<string>();
      const targets = [selected, ...topic?.candidates ?? [], ...snapshot.general].filter(candidate => {
        if (seen.has(candidate.model)) return false; seen.add(candidate.model); return true;
      }).map(({ model, reasoning }) => ({ model, reasoning }));
      return { choice, targets };
    });
    await joined(outgoing.map(async item => { item.target.attached.revoke(); await item.target.member.finish(); }));
    check();
    if (mode === "table" && finishing) return [];
    return choices.map(({ choice, targets }) => ({ choice, active: true,
      target: internal({ ...rootRole, modelPolicy: { ...rootRole.modelPolicy, primary: targets[0]!, fallbacks: targets.slice(1) } }, choice.mandate, "specialist") }));
  };
  const frontier = () => {
    appliedControls.push(...controls.splice(0));
    sharedId = randomUUID();
    return { id: sharedId, round, controls: structuredClone(appliedControls), failures: structuredClone(failures),
      messages: structuredClone(messages.filter(message => ["preparation", "contribution", "knowledge"].includes(message.stage))) };
  };
  const specialistStage = async (specialists: Specialist[], kind: "preparation" | "contribution", shared: ReturnType<typeof frontier>) => {
    const stageFailures: typeof failures = [];
    const outcomes = await joined(specialists.filter(item => item.active).map(async (item, index) => {
      try {
        const message = await memberTurn(item.target, kind, { mandate: item.choice.mandate, reason: item.choice.reason, shared: kind === "preparation" ? { ...shared, messages: [] } : shared });
        if (message.body.kind === "contribution") for (const objection of message.body.objections) {
          if (!objection.argument.trim() || objection.memberId === message.memberId || !shared.messages.some(prior => prior.id === objection.messageId && prior.memberId === objection.memberId && prior.author === "specialist"))
            throw new Error("objection must reference another specialist message in this snapshot");
        }
        return message;
      } catch (error) {
        item.target.attached.revoke();
        await item.target.member.finish();
        if (error instanceof AgentClosureError || !current()) throw error;
        item.active = false;
        stageFailures[index] = { memberId: item.target.member.memberId, stage: kind, round, error: String(error) };
        return undefined;
      }
    }));
    failures.push(...stageFailures.filter(Boolean));
    const published = outcomes.flatMap(message => message ? [record(message)] : []);
    pendingDoubts.push(...published.flatMap(message => message.doubts));
    return published;
  };
  const table = async () => {
    let specialists = await compose();
    if (finishing) return;
    let sources = await specialistStage(specialists, "preparation", frontier());
    if (finishing) return;
    await resolveDoubts(sources, "initial"); // An empty batch still publishes a common knowledge boundary.
    while (!finishing) {
      if (!specialists.some(item => item.active)) return;
      ++round;
      sources = await specialistStage(specialists, "contribution", frontier());
      if (finishing) return;
      const decision = (await rootTurn("decision", { round, sources, failures, finalRound: round === 5,
        allowed: round === 5 ? ["consult", "synthesize"] : ["continue", "consult", "synthesize", "recompose"] })).message;
      if (decision.body.kind !== "decision") throw new Error("invalid table decision");
      if (finishing || decision.body.action === "synthesize") return;
      if (round === 5) {
        if (decision.body.action === "consult") await resolveDoubts(sources, "final-clarification");
        else limitReached = true;
        return;
      }
      if (decision.body.action === "consult") await resolveDoubts(sources, "between-rounds");
      if (decision.body.action === "recompose") {
        specialists = await compose(specialists);
        if (finishing) return;
        sources = await specialistStage(specialists, "preparation", frontier());
        if (finishing) return;
        await resolveDoubts(sources, "replacement");
      }
    }
  };
  const prompt = (kind: Stage, context: unknown) => JSON.stringify({ protocol: "Pitako architecture", mode, stage: kind, round: round || undefined,
    instructions: "Analysis only. No product edits. Submit exactly one body for this stage using local architecture_submit. Final prose is not a submission. Do not dispatch agents.",
    snapshot, goal: input.goal, topic: input.topic, controls: appliedControls, context });
  return {
    snapshot, architecture: rootArchitecture,
    control(action: "context" | "priorities" | "finish" | "stop", text?: string) {
      if (state === "finished" || state === "failed" || state === "cancelled") throw new Error("architecture room is terminal");
      if (action === "stop") { stopping = true; director.revoke(); cancelTeamWorker(input.team.evaluation.token, input.root.instanceId); }
      else { check(); if (action === "finish") finishing = true; else if (!text?.trim()) throw new Error("architecture context must not be empty"); controls.push({ action, text }); }
      wake?.();
      return { roomId: input.team.teamId, state: stopping ? "stopping" : state };
    },
    read(cursor?: string) {
      let cut = messages.length, index = 0, offset = 0;
      if (cursor) {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { throw new Error("invalid architecture cursor"); }
        if (!Array.isArray(parsed) || parsed.length !== 5 || parsed[0] !== snapshotId || parsed[4] !== 1 || !parsed.slice(1).every(Number.isSafeInteger)) throw new Error("invalid architecture cursor");
        [, cut, index, offset] = parsed as [string, number, number, number, number];
        if (cut < 0 || cut > messages.length || index < 0 || index > cut || offset < 0) throw new Error("invalid architecture cursor");
      }
      const fragments: { messageId: string; offset: number; text: string; complete: boolean }[] = [];
      let budget = 16384;
      while (index < cut && budget > 0) {
        const message = messages[index]!, serialized = JSON.stringify(message);
        if (offset > serialized.length) throw new Error("invalid architecture cursor");
        const text = serialized.slice(offset, offset + budget), complete = offset + text.length === serialized.length;
        fragments.push({ messageId: message.id, offset, text, complete }); budget -= text.length;
        if (complete) { ++index; offset = 0; } else offset += text.length;
      }
      const root = teamWorkerStatus(input.team.evaluation.token, input.root.instanceId)[0];
      return { roomId: input.team.teamId, state, stage, round, pendingDoubts: structuredClone(pendingDoubts), failures: structuredClone(failures), snapshot: structuredClone(snapshot), cut, fragments,
        cursor: index < cut ? Buffer.from(JSON.stringify([snapshotId, cut, index, offset, 1])).toString("base64url") : null,
        members: teamAssignments(input.team.evaluation).filter(member => member.teamId === input.team.teamId), closure: root?.closure,
        delivery: intermediateReceipts(input.team.evaluation.token, input.root.instanceId) };
    },
    async run(lifetime: AbortSignal): Promise<AgentRunResult> {
      signal = lifetime;
      const aborted = () => {
        stopping = true; director.revoke();
        // Abort children now; the driver may be awaiting them. Finally joins this idempotent disband.
        void disbandTeam(input.team).catch(() => {});
        wake?.();
      };
      signal.addEventListener("abort", aborted, { once: true });
      let result: AgentRunResult = { instanceId: input.root.instanceId, role: "architect", status: "failed", model: { selectedModel: "unknown" }, result: "architecture did not finish" };
      try {
        check(); state = "running";
        if (mode === "table") await table();
        else {
          const specialists = await compose();
          const specialist = specialists[0]!;
          let context: unknown = { mandate: specialist.choice.mandate, reason: specialist.choice.reason, controls: controls.splice(0) };
          while (true) {
            const answer = record(await memberTurn(specialist.target, "answer", context));
            const knowledge = await resolveDoubts([answer]);
            check();
            publishIntermediate(input.team.evaluation.token, input.root.instanceId, input.team.teamId, answer.turnId, JSON.stringify({ answer, knowledge }));
            stage = "waiting"; state = "waiting";
            while (!controls.length && !finishing && !stopping && !signal.aborted) await new Promise<void>(resolve => { wake = resolve; });
            wake = undefined; check();
            if (finishing) break;
            state = "running"; context = { controls: controls.splice(0), knowledge };
          }
        }
        const synthesis = await rootTurn("synthesis", { messages, failures, pendingDoubts, round, controls: [...appliedControls, ...controls.splice(0)],
          limit: limitReached ? "Round six is forbidden. Redesign remains pending; synthesis must be partial." : undefined });
        if (synthesis.message.body.kind !== "synthesis") throw new Error("invalid synthesis");
        const body = synthesis.message.body;
        if ((limitReached || failures.length) && body.status === "complete") {
          body.status = "partial";
          body.pending.push(limitReached ? "Round limit reached; redesign remains pending" : "One or more member turns failed");
        }
        result = { ...synthesis.result, status: body.status === "complete" ? "completed" : "failed", result: JSON.stringify(body) };
      } catch (error) {
        result = { ...result, status: stopping || signal.aborted ? "cancelled" : "failed", result: String(error) };
        if (error instanceof AgentClosureError) throw error;
      } finally {
        stage = "closing"; director.revoke();
        try { await disbandTeam(input.team).catch(error => { state = "closure-unknown"; throw error; }); }
        finally { signal.removeEventListener("abort", aborted); }
      }
      state = result.status === "completed" ? "finished" : result.status;
      return result;
    },
  };
}
function strictTarget(target: ModelTarget): ModelTarget { return { ...target, ...(target.reasoning ? { directReasoning: true } : {}) }; }
export type Consultation = ReturnType<typeof createConsultation>;

/** Join every owned turn/callback, including siblings of a failed operation. */
async function joined<T>(operations: Promise<T>[]): Promise<T[]> {
  const outcomes = await Promise.allSettled(operations);
  const failed = outcomes.find(outcome => outcome.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return outcomes.map(outcome => (outcome as PromiseFulfilledResult<T>).value);
}
