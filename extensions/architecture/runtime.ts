import { architecturePublication, architectureProgress, architectureMember, architectureControl, architectureControlApplied,
  architectureCandidate, architectureMembersClosed, architectureFailure, architectureKnowledge, type ArchitectureRoom } from "./rooms.ts";
import { randomUUID } from "node:crypto";
import { admitTeamMember, disbandTeam, teamAssignments, type createTeam } from "../team.ts";
import { backgroundExecutor, cancelTeamWorker, intermediateReceipts, publishIntermediate, teamWorkerStatus, turnTeamWorker } from "../agent/background.ts";
import type { AgentRunResult } from "../agent/run.ts";
import type { HistoryOrigin } from "../agent/history.ts";
import { AgentClosureError } from "../agent/closure.ts";
import { resolveRoleFromConfig } from "../roles/load.ts";
import type { ModelTarget, PitakoConfig, ResolvedRole } from "../roles/types.ts";
import { participant, type Body, type Message, type Stage } from "./types.ts";
import { immutable, mergeKnowledge, type KnowledgeBoundary, type StageRules, type ConsultationResponse, type Plan, type Knowledge } from "./protocol.ts";

type Team = ReturnType<typeof createTeam>;
type Member = ReturnType<typeof admitTeamMember>;
export function createConsultation(input: { team: Team; config: PitakoConfig; mode?: "consultation" | "table"; goal: string; topic?: string;
  root: { assignmentId: string; memberId: string; instanceId: string }; origin: HistoryOrigin; cwd: string; owns: () => boolean; observation?: ArchitectureRoom }) {
  const snapshotId = randomUUID(), messages: Message[] = [], controls: { action: string; text?: string; captureId?: string }[] = [];
  const boundaries: KnowledgeBoundary[] = [], publications: (Message | KnowledgeBoundary)[] = [];
  const mode = input.mode ?? "consultation";
  let round = 0, ordinal = 0, sharedId = snapshotId;
  const failures: { memberId: string; stage: Stage; round: number; error: string }[] = [];
  const appliedControls: { action: string; text?: string }[] = [];
  const record = (message: Message, retain = true) => { if (retain) { messages.push(structuredClone(message)); publications.push(structuredClone(message)); } architecturePublication(input.observation, message); return message; };
  const candidates = input.config.architecture!;
  const snapshot = { id: snapshotId, general: candidates.candidates.map((candidate, index) => ({ ref: `general:${index}`, ...candidate })),
    topics: candidates.topics.map((topic, index) => ({ topic: topic.topic, ref: `topic:${index}`,
      candidates: topic.candidates.map((candidate, candidateIndex) => ({ ref: `topic:${index}:${candidateIndex}`, ...candidate })) })) };
  let state = "starting", stage: Stage | "waiting" | "closing" = "composition", stopping = false, finishing = false;
  let wake: (() => void) | undefined, signal: AbortSignal | undefined;
  const check = () => { if (!input.owns() || stopping || signal?.aborted) throw new Error("architecture authority retired or stopped"); };
  const progress = () => architectureProgress(input.observation, stage, round, state as ArchitectureRoom["lifecycle"]["protocolState"], pendingDoubts.map(doubt => doubt.id));
  const consumeControls = () => {
    const accepted = controls.splice(0);
    architectureControlApplied(input.observation, accepted.map(control => control.captureId), stage, round);
    return accepted.map(({ action, text }) => ({ action, text }));
  };
  const current = () => input.owns() && !stopping && !signal?.aborted;
  const capability = (identity: { assignmentId: string; memberId: string }, author: string) => {
    let publication: { ordinal: number; snapshotId: string; round?: number };
    const attached = participant({ current, publish(message) {
      check();
      return structuredClone({ ...message, assignmentId: identity.assignmentId, memberId: identity.memberId, roomId: input.team.teamId, author, id: randomUUID(), ...publication });
    } });
    const open = attached.open;
    attached.open = grant => {
      open({ ...grant, roomId: input.team.teamId, assignmentId: identity.assignmentId, memberId: identity.memberId, snapshotId: sharedId, round });
      publication = { ordinal: ++ordinal, snapshotId: sharedId, ...(round ? { round } : {}) };
    };
    return attached;
  };
  const director = capability(input.root, "architect");
  const rootRole = resolveRoleFromConfig(input.config, "architect");
  const strictRole = (role: ResolvedRole): ResolvedRole => ({ ...role, modelPolicy: { ...role.modelPolicy,
    primary: role.modelPolicy.primary && strictTarget(role.modelPolicy.primary), fallbacks: role.modelPolicy.fallbacks.map(strictTarget) } });
  const rootArchitecture = { config: input.config, role: strictRole(rootRole), participant: director };
  const authorization = (rules: StageRules) => ({ roomId: input.team.teamId, memberId: input.root.memberId, assignmentId: input.root.assignmentId, snapshotId: sharedId, round, rules });
  const rootTurn = async (rules: StageRules, context: unknown) => {
    const kind = rules.kind;
    check(); stage = kind; progress(); director.open(authorization(rules));
    const result = await turnTeamWorker(input.team.evaluation.token, input.root.instanceId, prompt(rules, context));
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
    try { member = admitTeamMember(input.team, { roleId: role.id, task: mandate, cwd: input.cwd, historyOrigin: caller,
      executor: backgroundExecutor(), architecture: { config: input.config, role: strictRole(role), participant: attached },
      recipient: { kind: "protocol", settle() {} } }); }
    catch (error) { architectureFailure(input.observation, "admission", error, { stage: stage === "waiting" || stage === "closing" ? undefined : stage, round }); throw error; }
    architectureMember(input.observation, member.memberId, author === "specialist" ? "specialist" : "support");
    return { member, attached };
  };
  const memberTurn = async (target: ReturnType<typeof internal>, rules: StageRules, context: unknown) => {
    check(); stage = rules.kind; progress(); target.attached.open(authorization(rules));
    const result = await target.member.turn(prompt(rules, context));
    check();
    return record(target.attached.settle(result.status === "completed"), false);
  };
  let pendingDoubts: Message["doubts"] = [];
  const resolveDoubts = async (sources: Message[], phase = "consultation") => {
    const doubts = immutable(structuredClone([...new Map([...pendingDoubts, ...sources.flatMap(message => message.doubts)].map(doubt => [doubt.id, doubt])).values()]));
    // Preserve the entire original queue until a confirmed merge commits this cycle.
    pendingDoubts = structuredClone(doubts);
    const cycleId = randomUUID();
    const plan = (await rootTurn({ kind: "consultation-plan", doubts }, { phase, cycleId, sources, doubts })).message;
    if (plan.body.kind !== "consultation-plan") throw new Error("invalid consultation plan");
    const requests = plan.body.support;
    const responses: ConsultationResponse[] = requests.map(() => ({ id: randomUUID(), status: "failed", error: "not executed" }));
    const pending = new Set(requests.map((_, index) => index)), settled = new Set<number>();
    while (pending.size) {
      const batch = [...pending].filter(index => requests[index]!.prerequisites.every(value => settled.has(value))).slice(0, 2);
      const outcomes = await joined(batch.map(async index => {
        const request = requests[index]!, id = responses[index]!.id;
        if (request.prerequisites.some(prerequisite => responses[prerequisite]!.status !== "completed"))
          return { id, status: "failed" as const, error: "prerequisite failed" };
        let target: ReturnType<typeof internal> | undefined;
        try {
          target = internal(resolveRoleFromConfig(input.config, request.role), request.brief);
          const message = await memberTurn(target, { kind: "consultation-response", doubtIds: request.doubtIds },
            { cycleId, consultationId: id, request, prerequisites: request.prerequisites.map(value => responses[value]) });
          return { id, assignmentId: target.member.assignmentId, status: "completed" as const, message };
        } catch (error) {
          if (error instanceof AgentClosureError || !current()) throw error;
          architectureFailure(input.observation, target ? "turn" : "admission", error,
            { memberId: target?.member.memberId, assignmentId: target?.member.assignmentId, stage: "consultation-response", round });
          return { id, assignmentId: target?.member.assignmentId, status: "failed" as const, error: String(error) };
        } finally { if (target) { target.attached.revoke(); await target.member.finish(); } }
      }));
      outcomes.forEach((response, offset) => {
        const index = batch[offset]!; responses[index] = response; settled.add(index); pending.delete(index);
        if (response.message) { record(response.message); pendingDoubts.push(...response.message.doubts); }
      });
    }
    const delegatedDoubts = doubts.filter(doubt => requests.some(request => request.doubtIds.includes(doubt.id)));
    const deferredDoubts = pendingDoubts.filter(doubt => !doubts.some(original => original.id === doubt.id));
    let knowledge: (Message & { body: Knowledge }) | undefined;
    if (requests.length) {
      const message = (await rootTurn({ kind: "knowledge", plan: plan.body, responses },
        { phase, cycleId, doubts, directResolutions: plan.body.resolutions, delegatedDoubts, plan, responses, deferredDoubts })).message;
      if (message.body.kind !== "knowledge") throw new Error("invalid knowledge");
      knowledge = { ...message, body: message.body };
    }
    check();
    const boundary = immutable(mergeKnowledge({ id: randomUUID(), ordinal: ++ordinal, roomId: input.team.teamId, cycleId, doubts,
      plan: { ...plan, body: plan.body }, knowledge, responses }));
    boundaries.push(boundary); publications.push(boundary); architectureKnowledge(input.observation, boundary);
    pendingDoubts = deferredDoubts;
    progress();
    return boundary;
  };
  type Specialist = { target: ReturnType<typeof internal>; choice: Extract<Body, { kind: "composition" }>["specialists"][number]; active: boolean };
  let limitReached = false;
  const compose = async (outgoing: Specialist[] = []): Promise<Specialist[]> => {
    const composition = (await rootTurn({ kind: "composition", snapshotId, candidateRefs: [...snapshot.general, ...snapshot.topics.flatMap(topic => topic.candidates)].map(candidate => candidate.ref), direct: mode === "consultation" }, { requestedTopic: input.topic, replacing: outgoing.map(item => item.target.member.memberId) })).message;
    if (composition.body.kind !== "composition") throw new Error("invalid composition");
    // Validate the entire composition before retiring any current member or admitting replacements.
    const choices = composition.body.specialists.map(choice => {
      const general = snapshot.general.find(candidate => candidate.ref === choice.candidateRef);
      const topic = snapshot.topics.find(topic => topic.candidates.some(candidate => candidate.ref === choice.candidateRef));
      const selected = general ?? topic?.candidates.find(candidate => candidate.ref === choice.candidateRef);
      if (!selected) throw new Error("validated candidate unavailable");
      const seen = new Set<string>();
      const targets = [selected, ...topic?.candidates ?? [], ...snapshot.general].filter(candidate => {
        if (seen.has(candidate.model)) return false; seen.add(candidate.model); return true;
      }).map(({ model, reasoning }) => ({ model, reasoning }));
      return { choice, targets };
    });
    for (const item of outgoing) architectureMember(input.observation, item.target.member.memberId, "specialist", undefined, composition.id);
    await joined(outgoing.map(async item => { item.target.attached.revoke(); await item.target.member.finish(); }));
    check();
    if (mode === "table" && finishing) return [];
    return choices.map(({ choice, targets }) => {
      const target = internal({ ...rootRole, modelPolicy: { ...rootRole.modelPolicy, primary: targets[0]!, fallbacks: targets.slice(1) } }, choice.mandate, "specialist");
      architectureMember(input.observation, target.member.memberId, "specialist", composition.id);
      return { choice, active: true, target };
    });
  };
  const frontier = () => {
    appliedControls.push(...consumeControls());
    sharedId = randomUUID();
    return { id: sharedId, round, controls: structuredClone(appliedControls), failures: structuredClone(failures),
      knowledgeBoundaries: structuredClone(boundaries),
      messages: structuredClone(messages.filter(message => ["preparation", "contribution", "knowledge"].includes(message.stage))) };
  };
  const specialistStage = async (specialists: Specialist[], kind: "preparation" | "contribution", shared: ReturnType<typeof frontier>) => {
    const stageFailures: typeof failures = [];
    const outcomes = await joined(specialists.filter(item => item.active).map(async (item, index) => {
      try {
        const rules: StageRules = kind === "preparation" ? { kind } : { kind, objections: shared.messages.filter(prior => prior.memberId !== item.target.member.memberId && prior.author === "specialist").map(prior => ({ memberId: prior.memberId, messageId: prior.id })) };
        const message = await memberTurn(item.target, rules, { mandate: item.choice.mandate, reason: item.choice.reason, shared: kind === "preparation" ? { ...shared, messages: [] } : shared });
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
    for (const failure of stageFailures.filter(Boolean)) architectureFailure(input.observation, "turn", failure.error, { memberId: failure.memberId, stage: failure.stage, round: failure.round });
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
      const decision = (await rootTurn({ kind: "decision", allowed: round === 5 ? ["consult", "synthesize"] : ["continue", "consult", "synthesize", "recompose"] }, { round, sources, failures, finalRound: round === 5 })).message;
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
  const prompt = (rules: StageRules, context: unknown) => JSON.stringify({ protocol: "Pitako architecture", mode, stage: rules.kind, round: round || undefined,
    authorization: rules,
    instructions: "Analysis only. No product edits. Submit one valid body using local architecture_submit. Contextual rejections allow one correction (two distinct candidates total) in this prompt; use a new submissionId for correction. Identical retries are idempotent; an accepted provisional cannot be replaced. Knowledge covers only delegatedDoubts; defer new support doubts. Synthesis must be partial if pending doubts, limits or failures remain. Final prose is not a submission. Do not dispatch agents.",
    snapshot, goal: input.goal, topic: input.topic, controls: appliedControls, context });
  return {
    snapshot, architecture: rootArchitecture,
    control(action: "context" | "priorities" | "finish" | "stop", text?: string, toolCallId?: string) {
      if (state === "finished" || state === "failed" || state === "cancelled") throw new Error("architecture room is terminal");
      if (action === "stop") { stopping = true; director.revoke(); cancelTeamWorker(input.team.evaluation.token, input.root.instanceId); }
      else { check(); if (action === "finish") finishing = true; else if (!text?.trim()) throw new Error("architecture context must not be empty"); controls.push({ action, text, captureId: undefined }); }
      const id = toolCallId ? architectureControl(input.observation, action, text, toolCallId) : undefined;
      if (action === "stop" || action === "finish") architectureControlApplied(input.observation, [id], stage, round);
      else if (controls.length) controls[controls.length - 1]!.captureId = id;
      wake?.();
      return { roomId: input.team.teamId, state: stopping ? "stopping" : state };
    },
    read(cursor?: string) {
      let cut = publications.length, index = 0, offset = 0;
      if (cursor) {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { throw new Error("invalid architecture cursor"); }
        if (!Array.isArray(parsed) || parsed.length !== 5 || parsed[0] !== snapshotId || parsed[4] !== 1 || !parsed.slice(1).every(Number.isSafeInteger)) throw new Error("invalid architecture cursor");
        [, cut, index, offset] = parsed as [string, number, number, number, number];
        if (cut < 0 || cut > publications.length || index < 0 || index > cut || offset < 0) throw new Error("invalid architecture cursor");
      }
      const fragments: { messageId: string; offset: number; text: string; complete: boolean }[] = [];
      let budget = 16384;
      while (index < cut && budget > 0) {
        const message = publications[index]!, serialized = JSON.stringify(message);
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
        check(); state = "running"; progress();
        if (mode === "table") await table();
        else {
          const specialists = await compose();
          const specialist = specialists[0]!;
          let context: unknown = { mandate: specialist.choice.mandate, reason: specialist.choice.reason, controls: consumeControls() };
          while (true) {
            const answer = record(await memberTurn(specialist.target, { kind: "answer" }, context));
            const knowledge = await resolveDoubts([answer]);
            check();
            publishIntermediate(input.team.evaluation.token, input.root.instanceId, input.team.teamId, answer.turnId, JSON.stringify({ answer, knowledge }));
            stage = "waiting"; state = "waiting"; progress();
            while (!controls.length && !finishing && !stopping && !signal.aborted) await new Promise<void>(resolve => { wake = resolve; });
            wake = undefined; check();
            if (finishing) break;
            state = "running"; context = { controls: consumeControls(), knowledge };
          }
        }
        const partialReasons = [...(limitReached ? ["Round limit reached; redesign remains pending"] : []),
          ...failures.map(item => item.error),
          ...boundaries.flatMap(boundary => boundary.resolutions.flatMap(item => item.provenance.kind === "delegated" ? item.provenance.responses.filter(response => response.status === "failed").map(response => `Failed consultation: ${response.consultationId}`) : [])),
          ...boundaries.flatMap(boundary => boundary.resolutions.filter(item => item.status !== "answered" && item.status !== "rejected").map(item => `Unresolved knowledge: ${item.doubtId}`)),
          ...messages.flatMap(message => "limits" in message.body ? message.body.limits : [])];
        const synthesis = await rootTurn({ kind: "synthesis", pendingDoubts, partialReasons }, { messages, knowledgeBoundaries: boundaries, failures, pendingDoubts, partialReasons, round, controls: [...appliedControls, ...consumeControls()] });
        if (synthesis.message.body.kind !== "synthesis") throw new Error("invalid synthesis");
        const body = synthesis.message.body;
        result = { ...synthesis.result, status: body.status === "complete" ? "completed" : "failed", result: JSON.stringify(body) };
        architectureCandidate(input.observation, result, body);
      } catch (error) {
        architectureFailure(input.observation, "turn", error, { stage: stage === "waiting" || stage === "closing" ? undefined : stage, round });
        result = { ...result, status: stopping || signal.aborted ? "cancelled" : "failed", result: String(error) };
        if (error instanceof AgentClosureError) throw error;
      } finally {
        stage = "closing"; progress(); director.revoke();
        try { await disbandTeam(input.team).then(() => architectureMembersClosed(input.observation), error => { architectureMembersClosed(input.observation, error); state = "closure-unknown"; throw error; }); }
        finally { signal.removeEventListener("abort", aborted); }
      }
      state = result.status === "completed" ? "finished" : result.status;
      progress();
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
