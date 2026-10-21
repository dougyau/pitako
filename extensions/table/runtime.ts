import { architecturePublication, architectureProgress, architectureMember, architectureControl, architectureControlApplied,
  architectureCandidate, architectureMembersClosed, architectureFailure, architectureKnowledge, type ArchitectureRoom } from "../architecture/rooms.ts";
import { randomUUID } from "node:crypto";
import { admitTeamMember, disbandTeam, teamAssignments, type createTeam } from "../team.ts";
import { backgroundExecutor, cancelTeamWorker, intermediateReceipts, teamWorkerRetainable, teamWorkerStatus, turnTeamWorker } from "../agent/background.ts";
import type { AgentRunResult } from "../agent/run.ts";
import type { HistoryOrigin } from "../agent/history.ts";
import { AgentClosureError } from "../agent/closure.ts";
import { resolveRoleFromConfig } from "../roles/load.ts";
import type { ModelTarget, PitakoConfig, ResolvedRole } from "../roles/types.ts";
import { submitSchema as architectureSchema, type Message as ArchitectureMessage, type Stage } from "../architecture/types.ts";
import { planComposition, type CompositionChoiceRef, type SpecialistChoice } from "./composition.ts";
import { createParticipant } from "./participant.ts";
import { submitSchema as reviewSchema, type TableBody, type TableMessage as Message } from "../review/types.ts";
import { validateReview, type ReviewGrant, type ReviewPolicy } from "../review/policy.ts";
import { describeObject } from "../review/object.ts";
import type { TableSemanticReport } from "./results.ts";
import { immutable, mergeKnowledge, validateSubmission, type StageGrant, type KnowledgeBoundary, type StageRules, type ConsultationResponse, type Plan, type Knowledge } from "../architecture/protocol.ts";

type Team = ReturnType<typeof createTeam>;
type Member = ReturnType<typeof admitTeamMember>;
export function createTable(input: { team: Team; config: PitakoConfig; goal: string; topic?: string; review?: ReviewPolicy;
  consultedSource?: { identity: string; text: string };
  root: { assignmentId: string; memberId: string; instanceId: string }; origin: HistoryOrigin; cwd: string; owns: () => boolean; observation?: ArchitectureRoom }) {
  const snapshotId = randomUUID(), messages: Message[] = [], controls: { action: string; text?: string; captureId?: string }[] = [];
  const boundaries: KnowledgeBoundary[] = [], publications: (Message | KnowledgeBoundary)[] = [];
  const modelObservations: { memberId: string; model: AgentRunResult["model"]; status: AgentRunResult["status"] }[] = [];
  let lastRootResult: AgentRunResult | undefined;
  let round = 0, ordinal = 0, sharedId = snapshotId;
  const failures: { memberId: string; stage: Stage; round: number; error: string }[] = [];
  const appliedControls: { action: string; text?: string }[] = [];
  const protocol = input.review ? "review" : "architecture", rootId = input.review ? "reviewer" : "architect";
  let authorizedSynthesis = false;
  let reportReasons: string[] = [];
  const resultMessage = (message: Message) => {
    const body = { ...message.body,
      ...("doubts" in message.body ? { doubts: message.doubts } : {}),
      ...(input.review && "findings" in message.body ? {
        findings: input.review.findings.filter(finding => finding.messageId === message.id) } : {}) };
    return structuredClone({ id: message.id, author: message.author, memberId: message.memberId,
      stage: message.stage, round: message.round, body });
  };
  const supportResult = (response: ConsultationResponse) => ({ id: response.id, status: response.status,
    ...(response.message ? { message: resultMessage(response.message) } : {}), ...(response.error ? { error: response.error } : {}) });
  const record = (message: Message) => {
    messages.push(structuredClone(message)); publications.push(structuredClone(message));
    if (input.review) input.review.publish(message);
    else architecturePublication(input.observation, message as ArchitectureMessage);
    return message;
  };
  const candidates = (input.review ? input.config.review : input.config.architecture) ?? { candidates: [], topics: [] };
  const snapshot = immutable({ id: snapshotId, general: candidates.candidates.map((candidate, index) => ({ ref: `general:${index}`, ...candidate })),
    topics: candidates.topics.map((topic, index) => ({ topic: topic.topic, ref: `topic:${index}`,
      candidates: topic.candidates.map((candidate, candidateIndex) => ({ ref: `topic:${index}:${candidateIndex}`, ...candidate })) })) });
  let state = "starting", stage: Stage | "closing" = "composition", stopping = false, finishing = false;
  let signal: AbortSignal | undefined;
  const check = () => { if (!input.owns() || stopping || signal?.aborted) throw new Error(`${protocol} authority retired or stopped`); };
  const progress = () => architectureProgress(input.observation, stage, round, state as ArchitectureRoom["lifecycle"]["protocolState"], pendingDoubts.map(doubt => doubt.id));
  const consumeControls = () => {
    const accepted = controls.splice(0);
    architectureControlApplied(input.observation, accepted.map(control => control.captureId), stage, round);
    return accepted.map(({ action, text }) => ({ action, text }));
  };
  const current = () => input.owns() && !stopping && !signal?.aborted;
  const capability = (identity: { assignmentId: string; memberId: string }, author: string) => {
    let publication: { ordinal: number; snapshotId: string; round?: number };
    const attached = createParticipant<TableBody, StageGrant | ReviewGrant, Message>({ protocol, schema: input.review ? reviewSchema : architectureSchema,
      validate: (grant: StageGrant | ReviewGrant, value: unknown) => input.review ? validateReview(grant as ReviewGrant, value) : validateSubmission(grant, value),
      current, publish(message): Message {
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
  const director = capability(input.root, rootId);
  const rootRole = resolveRoleFromConfig(input.config, rootId);
  const strictRole = (role: ResolvedRole): ResolvedRole => ({ ...role, modelPolicy: { ...role.modelPolicy,
    primary: role.modelPolicy.primary && strictTarget(role.modelPolicy.primary), fallbacks: role.modelPolicy.fallbacks.map(strictTarget) } });
  const rootArchitecture = { config: input.config, role: strictRole(rootRole), participant: director };
  const authorization = (rules: StageRules) => ({ roomId: input.team.teamId, memberId: input.root.memberId, assignmentId: input.root.assignmentId, snapshotId: sharedId, round, rules });
  const rootTurn = async (rules: StageRules, context: Record<string, unknown>, publish = true) => {
    const kind = rules.kind;
    check(); stage = kind; progress();
    const grant = authorization(rules);
    director.open(input.review ? input.review.grant(grant, rules.kind === "preparation" ? [] : messages, rules.kind === "synthesis" ? rules.partialReasons : []) : grant);
    const result = await turnTeamWorker(input.team.evaluation.token, input.root.instanceId, prompt(rules, context));
    lastRootResult = result;
    modelObservations.push({ memberId: input.root.memberId, model: structuredClone(result.model), status: result.status });
    check();
    const message = director.settle(result.status === "completed");
    return { result, message: publish ? record(message) : message };
  };
  const origin = () => {
    const caller = director.caller;
    caller.check();
    return { ...input.origin, entrypoint: input.review ? "review_start" as const : "architecture_start" as const, parentAssignmentId: input.root.assignmentId,
      callerSessionId: caller.sessionId, callerSessionFile: caller.sessionFile,
      toolCallId: messages.filter(message => message.author === rootId).at(-1)?.native.toolCallId };
  };
  const internal = (role: ResolvedRole, mandate: string, author = role.id) => {
    const caller = origin();
    // Admission happens only after a settled, authorized director turn.
    director.caller.append(`pitako.${protocol}.dispatch`, { roomId: input.team.teamId, parentAssignmentId: input.root.assignmentId,
      role: role.id, mandate, callerSessionId: caller.callerSessionId, toolCallId: caller.toolCallId });
    let member: Member;
    const attached = capability({ get assignmentId() { return member.assignmentId; }, get memberId() { return member.memberId; } }, author);
    try { member = admitTeamMember(input.team, { roleId: role.id, task: mandate, cwd: input.cwd, historyOrigin: caller,
      executor: backgroundExecutor(), table: { config: input.config, role: strictRole(role), participant: attached },
      recipient: { kind: "protocol", settle() {} } }); }
    catch (error) { architectureFailure(input.observation, "admission", error, { stage: stage === "closing" ? undefined : stage, round }); throw error; }
    architectureMember(input.observation, member.memberId, author === "specialist" ? "specialist" : "support");
    return { member, attached };
  };
  const memberTurn = async (target: ReturnType<typeof internal>, rules: StageRules, context: Record<string, unknown>) => {
    check(); stage = rules.kind; progress();
    const grant = { ...authorization(rules), memberId: target.member.memberId, assignmentId: target.member.assignmentId };
    target.attached.open(input.review ? input.review.grant(grant, rules.kind === "preparation" ? [] : messages, []) : grant);
    const result = await target.member.turn(prompt(rules, context));
    modelObservations.push({ memberId: target.member.memberId, model: structuredClone(result.model), status: result.status });
    check();
    if (!teamWorkerRetainable(input.team.evaluation.token, target.member.instanceId))
      throw new Error("member authority lost before publication");
    return target.attached.settle(result.status === "completed");
  };
  let pendingDoubts: Message["doubts"] = [];
  const resolveDoubts = async (sources: Message[], phase = "consultation") => {
    const doubts = immutable(structuredClone([...new Map([...pendingDoubts, ...sources.flatMap(message => message.doubts)].map(doubt => [doubt.id, doubt])).values()]));
    // Preserve the entire original queue until a confirmed merge commits this cycle.
    pendingDoubts = structuredClone(doubts);
    const cycleId = randomUUID();
    const origins = messages.filter(message => sources.some(source => source.id === message.id) ||
      message.doubts.some(doubt => doubts.some(pending => pending.id === doubt.id)));
    const plan = (await rootTurn({ kind: "consultation-plan", doubts }, { phase, cycleId,
      sources: origins.map(resultMessage), doubts: doubts.map(({ id }) => ({ id })),
      knowledgeBoundaries: confirmedKnowledge(origins.map(message => message.id)) })).message;
    if (plan.body.kind !== "consultation-plan") throw new Error("invalid consultation plan");
    const requests = plan.body.support;
    const responses: ConsultationResponse[] = requests.map(() => ({ id: randomUUID(), status: "failed", error: "not executed" }));
    const pending = new Set(requests.map((_, index) => index)), settled = new Set<number>();
    while (pending.size) {
      const batch = [...pending].filter(index => requests[index]!.prerequisites.every(value => settled.has(value))).slice(0, 2);
      const outcomes = await Promise.allSettled(batch.map(async index => {
        const request = requests[index]!, id = responses[index]!.id;
        if (request.prerequisites.some(prerequisite => responses[prerequisite]!.status !== "completed"))
          return { response: { id, status: "failed" as const, error: "prerequisite failed" } as ConsultationResponse, fatal: undefined };
        let target: ReturnType<typeof internal> | undefined, response: ConsultationResponse | undefined;
        let fatal: unknown;
        try {
          target = internal(resolveRoleFromConfig(input.config, request.role), request.brief);
          const prerequisites = new Set<number>();
          const include = (index: number) => {
            if (prerequisites.has(index)) return;
            prerequisites.add(index);
            requests[index]!.prerequisites.forEach(include);
          };
          request.prerequisites.forEach(include);
          const relevantDoubtIds = new Set(request.doubtIds);
          for (const prerequisite of prerequisites) {
            const body = responses[prerequisite]!.message?.body;
            if (body?.kind === "consultation-response") for (const doubtId of body.doubtIds) relevantDoubtIds.add(doubtId);
          }
          const message = await memberTurn(target, { kind: "consultation-response", doubtIds: request.doubtIds },
            { mandate: request.brief, cycleId, consultationId: id, request,
              doubts: doubts.filter(doubt => relevantDoubtIds.has(doubt.id)),
              prerequisites: [...prerequisites].map(value => supportResult(responses[value]!)) });
          response = { id, assignmentId: target.member.assignmentId, status: "completed", message: message as ArchitectureMessage };
        } catch (error) {
          if (error instanceof AgentClosureError || !current()) fatal = error;
          else architectureFailure(input.observation, target ? "turn" : "admission", error,
            { memberId: target?.member.memberId, assignmentId: target?.member.assignmentId, stage: "consultation-response", round });
          response = { id, assignmentId: target?.member.assignmentId, status: "failed", error: String(error) };
        } finally {
          if (target) {
            target.attached.revoke();
            try { await target.member.finish(); } catch (error) {
              fatal ??= error;
              response = { id, assignmentId: target.member.assignmentId, status: "failed", error: String(error) };
            }
          }
        }
        return { response: response!, fatal };
      }));
      outcomes.forEach((outcome, offset) => {
        if (outcome.status !== "fulfilled") return;
        const response = outcome.value.response;
        const index = batch[offset]!; responses[index] = response; settled.add(index); pending.delete(index);
        if (response.message) { record(response.message); pendingDoubts.push(...response.message.doubts); }
      });
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
        if ("fatal" in outcome.value && outcome.value.fatal) throw outcome.value.fatal;
      }
    }
    const delegatedDoubts = doubts.filter(doubt => requests.some(request => request.doubtIds.includes(doubt.id)));
    const deferredDoubts = pendingDoubts.filter(doubt => !doubts.some(original => original.id === doubt.id));
    let knowledge: (Message & { body: Knowledge }) | undefined;
    if (requests.length) {
      const message = (await rootTurn({ kind: "knowledge", plan: plan.body, responses },
        { phase, cycleId, doubts, delegatedDoubtIds: delegatedDoubts.map(doubt => doubt.id), plan: resultMessage(plan),
          responses: responses.map((response, index) => ({ ...supportResult(response),
            prerequisites: requests[index]!.prerequisites.map(value => responses[value]!.id) })),
          deferredDoubtIds: deferredDoubts.map(doubt => doubt.id) })).message;
      if (message.body.kind !== "knowledge") throw new Error("invalid knowledge");
      knowledge = { ...message, body: message.body };
    }
    check();
    const boundary = immutable(mergeKnowledge({ id: randomUUID(), ordinal: ++ordinal, roomId: input.team.teamId, cycleId, doubts,
      plan: { ...plan, body: plan.body }, knowledge: knowledge as (ArchitectureMessage & { body: Knowledge }) | undefined, responses }));
    boundaries.push(boundary); publications.push(boundary); architectureKnowledge(input.observation, boundary);
    pendingDoubts = deferredDoubts;
    progress();
    return boundary;
  };
  type SpecialistState = "preparing" | "active" | "closing" | "closed" | "closure-unknown";
  type Specialist = { target: ReturnType<typeof internal>; choice: SpecialistChoice; state: SpecialistState;
    admittedBy: CompositionChoiceRef; selectedBy: CompositionChoiceRef };
  const roster: Specialist[] = [];
  const projection = (item: Specialist) => ({ memberId: item.target.member.memberId,
    mandate: item.choice.mandate, reason: item.choice.reason });
  const observeMember = (item: Specialist, supersededBy?: string) => architectureMember(input.observation, item.target.member.memberId, "specialist",
    item.admittedBy.compositionMessageId, supersededBy, { compositionChoiceIndex: item.admittedBy.choiceIndex,
      selection: item.selectedBy, mandate: item.choice.mandate, state: item.state });
  const closeSpecialist = async (item: Specialist, supersededBy?: string) => {
    item.state = "closing"; observeMember(item, supersededBy); item.target.attached.revoke();
    try { await item.target.member.finish(); item.state = "closed"; }
    catch (error) { item.state = "closure-unknown"; throw error; }
    finally { observeMember(item, supersededBy); }
  };
  const eligible = (item: Specialist) => item.state === "active" &&
    teamWorkerRetainable(input.team.evaluation.token, item.target.member.instanceId);
  const compose = async (): Promise<Specialist[]> => {
    const basis = immutable({ snapshotId,
      candidateRefs: [...snapshot.general, ...snapshot.topics.flatMap(topic => topic.candidates)].map(candidate => candidate.ref),
      retainableMemberIds: roster.filter(eligible).map(item => item.target.member.memberId) });
    const shared = frontier();
    const composition = (await rootTurn({ kind: "composition", ...basis }, { requestedTopic: input.topic,
      roster: roster.filter(eligible).map(projection), ...(messages.length ? { shared } : { controls: shared.controls }) })).message;
    if (composition.body.kind !== "composition") throw new Error("invalid composition");
    const plan = planComposition(composition.body, basis);
    check();
    if (basis.retainableMemberIds.some(id => !roster.some(item => item.target.member.memberId === id && eligible(item))))
      throw new Error("composition realization lost member authority");
    const outgoing = roster.filter(item => item.state !== "closed" &&
      !plan.retained.some(retained => retained.memberId === item.target.member.memberId));
    await joined(outgoing.map(item => closeSpecialist(item, composition.id)));
    check();
    if (plan.retained.some(retained => !roster.some(item => item.target.member.memberId === retained.memberId && eligible(item))))
      throw new Error("composition realization lost member authority");
    if (roster.some(item => item.state === "closure-unknown" || item.state === "closing"))
      throw new Error("composition blocked by unconfirmed specialist closure");
    if (finishing) return [];
    const added: Specialist[] = [];
    for (const [choiceIndex, choice] of composition.body.specialists.entries()) {
      const selection = { compositionMessageId: composition.id, choiceIndex };
      if (choice.kind === "retain") {
        const item = roster.find(item => item.target.member.memberId === choice.memberId)!;
        item.choice = choice; item.selectedBy = selection; observeMember(item);
        continue;
      }
      if (roster.filter(item => item.state !== "closed").length >= 5) throw new Error("specialist capacity exhausted");
      const general = snapshot.general.find(candidate => candidate.ref === choice.candidateRef);
      const topic = snapshot.topics.find(topic => topic.candidates.some(candidate => candidate.ref === choice.candidateRef));
      const selected = general ?? topic?.candidates.find(candidate => candidate.ref === choice.candidateRef);
      if (!selected) throw new Error("validated candidate unavailable");
      const seen = new Set<string>();
      const targets = [selected, ...topic?.candidates ?? [], ...snapshot.general].filter(candidate => {
        if (seen.has(candidate.model)) return false; seen.add(candidate.model); return true;
      }).map(({ model, reasoning }) => ({ model, reasoning }));
      const target = internal({ ...rootRole, modelPolicy: { ...rootRole.modelPolicy, primary: targets[0]!, fallbacks: targets.slice(1) } }, choice.mandate, "specialist");
      const item: Specialist = { choice, target, state: "preparing", admittedBy: selection, selectedBy: selection };
      roster.push(item); added.push(item); observeMember(item);
    }
    return added;
  };
  const confirmedKnowledge = (excluded: string[] = []) => boundaries.map(boundary => {
    const author = messages.find(message => message.id === (boundary.knowledgeMessageId ?? boundary.planMessageId))!;
    return { id: boundary.id, cycleId: boundary.cycleId, planMessageId: boundary.planMessageId,
      knowledgeMessageId: boundary.knowledgeMessageId, author: author.author, memberId: author.memberId, stage: author.stage, round: author.round,
      resolutions: boundary.resolutions.map(resolution => ({ ...structuredClone(resolution),
        provenance: resolution.provenance.kind === "direct" ? { ...resolution.provenance } : { ...resolution.provenance,
          responses: resolution.provenance.responses.map(({ consultationId, messageId, status }) => ({ consultationId, messageId, status })) } })),
      responses: messages.filter(message => !excluded.includes(message.id) && boundary.resolutions.some(resolution => resolution.provenance.kind === "delegated" &&
        resolution.provenance.responses.some(response => response.messageId === message.id))).map(resultMessage) };
  });
  const frontier = () => {
    appliedControls.push(...consumeControls());
    sharedId = randomUUID();
    return immutable({ id: sharedId, round, controls: structuredClone(appliedControls), failures: structuredClone(failures),
      knowledgeBoundaries: confirmedKnowledge(), pendingDoubts: pendingDoubts.map(({ id }) => ({ id })),
      messages: messages.filter(message => ["preparation", "contribution"].includes(message.stage)).map(resultMessage) });
  };
  const specialistStage = async (specialists: Specialist[], kind: "preparation" | "contribution", shared: ReturnType<typeof frontier>, includeDirector = true) => {
    const stageFailures: typeof failures = [];
    const rulesFor = (memberId: string): StageRules => kind === "preparation" ? { kind } : { kind,
      objections: shared.messages.filter(prior => prior.memberId !== memberId && ["preparation", "contribution"].includes(prior.stage))
        .map(prior => ({ memberId: prior.memberId, messageId: prior.id })) };
    const operations = specialists.map(async (item, index) => {
      try {
        const context = kind === "preparation" ? { mandate: item.choice.mandate } : { mandate: item.choice.mandate, reason: item.choice.reason, shared };
        const message = await memberTurn(item.target, rulesFor(item.target.member.memberId), context);
        item.state = "active"; observeMember(item);
        return message;
      } catch (error) {
        stageFailures[index] = { memberId: item.target.member.memberId, stage: kind, round, error: String(error) };
        await closeSpecialist(item);
        if (error instanceof AgentClosureError || !current()) throw error;
        return undefined;
      }
    });
    if (includeDirector) operations.push(rootTurn(rulesFor(input.root.memberId),
       kind === "preparation" ? { mandate: directorMandate } : { mandate: directorMandate, shared }, false).then(value => value.message, error => {
        director.revoke();
        if (error instanceof AgentClosureError || !current()) throw error;
        stageFailures[specialists.length] = { memberId: input.root.memberId, stage: kind, round, error: String(error) };
        return undefined;
      }));
    const outcomes = await Promise.allSettled(operations);
    failures.push(...stageFailures.filter(Boolean));
    for (const failure of stageFailures.filter(Boolean)) architectureFailure(input.observation, "turn", failure.error, { memberId: failure.memberId, stage: failure.stage, round: failure.round });
    const published = outcomes.flatMap(outcome => outcome.status === "fulfilled" && outcome.value ? [record(outcome.value)] : []);
    pendingDoubts.push(...published.flatMap(message => message.doubts));
    const fatal = outcomes.find(outcome => outcome.status === "rejected");
    if (fatal?.status === "rejected") throw fatal.reason;
    return published;
  };
  const table = async () => {
    const specialists = await compose();
    if (finishing) return;
    let sources = await specialistStage(specialists, "preparation", frontier());
    if (finishing) return;
    await resolveDoubts(sources, "initial"); // An empty batch still publishes a common knowledge boundary.
    while (!finishing) {
      ++round;
      sources = await specialistStage(roster.filter(item => item.state === "active")
        .sort((a, b) => a.selectedBy.choiceIndex - b.selectedBy.choiceIndex), "contribution", frontier());
      if (finishing) return;
      const decision = (await rootTurn({ kind: "decision", allowed: round === 5 ? ["consult", "synthesize"] : ["continue", "consult", "synthesize", "recompose"] },
        { sources: sources.map(resultMessage), failures: structuredClone(failures),
          limits: messages.filter(message => !sources.some(source => source.id === message.id))
            .flatMap(message => "limits" in message.body ? message.body.limits : []),
          pendingDoubtIds: pendingDoubts.map(doubt => doubt.id),
          pendingDoubts: pendingDoubts.filter(doubt => !sources.some(message => message.doubts.some(own => own.id === doubt.id))),
          controls: structuredClone(appliedControls), finalRound: round === 5 })).message;
      if (decision.body.kind !== "decision") throw new Error("invalid table decision");
      if (finishing || decision.body.action === "synthesize") return;
      if (round === 5) {
        if (decision.body.action === "consult") await resolveDoubts(sources, "final-clarification");
        return;
      }
      if (decision.body.action === "consult") await resolveDoubts(sources, "between-rounds");
      if (decision.body.action === "recompose") {
        const newcomers = await compose();
        if (finishing) return;
        if (newcomers.length) {
          sources = await specialistStage(newcomers, "preparation", frontier(), false);
          if (finishing) return;
          await resolveDoubts(sources, "replacement");
        }
      }
    }
  };
  const directorMandate = input.review ? "Independently review the complete object against every criterion" : "Independently analyze the complete architectural goal";
  // Rules with result bodies stay host-private; their contents occur only in the selected stage inputs.
  const prompt = (rules: StageRules, context: Record<string, unknown>) => JSON.stringify({
    protocol: `Pitako ${protocol}`, stage: rules.kind, round: round || undefined,
    authorization: rules.kind === "consultation-plan" ? { kind: rules.kind, doubtIds: rules.doubts.map(doubt => doubt.id) }
      : rules.kind === "knowledge" ? { kind: rules.kind }
      : rules.kind === "synthesis" ? { kind: rules.kind, pendingDoubtIds: rules.pendingDoubts.map(doubt => doubt.id) } : rules,
    instructions: `Analysis only. No product edits. Explore privately from the effective root using existing analysis tools. Independently examine the complete task. Submit one valid body using local ${protocol}_submit. Contextual rejections allow one correction (two distinct candidates total) in this prompt; use a new submissionId for correction. Identical retries are idempotent; an accepted provisional cannot be replaced. Knowledge covers only delegatedDoubtIds; defer new support doubts. Synthesis must be partial if ${input.review ? "scheduled work or failures remain" : "pending doubts, limits or failures remain"}. Final prose is not a submission. Do not dispatch agents. ${input.review ? "Review the complete object against all criteria independently. Mandates focus, never restrict judgment. Findings require reachable evidence or indispensable missing observation with effect and next authorized capture. Supports supply knowledge, never judge findings. Only authors modify or withdraw; use the published finding id, not its messageId. Synthesis must dispose every published finding exactly once and preserve dissent. Completion is work, never product acceptance." : ""}`,
    goal: input.goal, topic: input.topic, root: input.cwd,
    ...(input.consultedSource ? { consultedSource: input.consultedSource } : {}),
    ...(input.review ? { object: describeObject(input.review.object), criteria: input.review.criteria } : {}),
    ...(rules.kind === "composition" ? { snapshot } : {}),
    context,
  });
  return {
    snapshot, architecture: rootArchitecture, table: rootArchitecture,
    semantic(): TableSemanticReport {
      if (input.review) {
        const { synthesis, dispositions, completion, verdict, ...facts } =
          input.review.report(messages, reportReasons, stopping, pendingDoubts, boundaries);
        return { ...facts, protocol: "review", modelObservations: structuredClone(modelObservations),
          judgment: authorizedSynthesis ? { synthesis, dispositions, completion, verdict } : null };
      }
      return { protocol: "architecture", goal: input.goal,
        ...(input.consultedSource ? { source: input.consultedSource } : {}),
        objections: messages.flatMap(message => message.body.kind === "contribution" && "objections" in message.body ?
          message.body.objections.map((objection, index) => ({ id: `${message.id}:${index}`, ...objection })) : []),
        judgment: authorizedSynthesis ? messages.filter(message => message.body.kind === "synthesis").at(-1)!.body : null,
        failures: structuredClone(failures), pending: structuredClone(pendingDoubts),
        limits: messages.flatMap(message => "limits" in message.body ? message.body.limits : []),
        observations: structuredClone(modelObservations) };
    },
    control(action: "context" | "priorities" | "finish" | "stop", text?: string, toolCallId?: string) {
      if (state === "finished" || state === "failed" || state === "cancelled") throw new Error(`${protocol} room is terminal`);
      if (action === "stop") { stopping = true; director.revoke(); cancelTeamWorker(input.team.evaluation.token, input.root.instanceId); }
      else { check(); if (action === "finish") finishing = true; else if (!text?.trim()) throw new Error(`${protocol} context must not be empty`); controls.push({ action, text, captureId: undefined }); }
      const id = toolCallId ? architectureControl(input.observation, action, text, toolCallId) : undefined;
      if (action === "stop" || action === "finish") architectureControlApplied(input.observation, [id], stage, round);
      else if (controls.length) controls[controls.length - 1]!.captureId = id;
      return { roomId: input.team.teamId, state: stopping ? "stopping" : state };
    },
    diagnostic() {
      return { roomId: input.team.teamId, state, stage, round, pending: structuredClone(pendingDoubts),
        failures: structuredClone(failures), snapshot: structuredClone(snapshot), messages: structuredClone(publications),
        controls: structuredClone(appliedControls),
        members: teamAssignments(input.team.evaluation).filter(member => member.teamId === input.team.teamId),
        delivery: intermediateReceipts(input.team.evaluation.token, input.root.instanceId) };
    },
    async run(lifetime: AbortSignal): Promise<AgentRunResult> {
      signal = lifetime;
      const aborted = () => {
        stopping = true; director.revoke();
        // Abort children now; the driver may be awaiting them. Finally joins this idempotent disband.
        void disbandTeam(input.team).catch(() => {});
      };
      signal.addEventListener("abort", aborted, { once: true });
      let result: AgentRunResult = { instanceId: input.root.instanceId, role: rootId, status: "failed", model: { selectedModel: "unknown" }, result: `${protocol} did not finish` };
      let reviewReasons: string[] = [];
      try {
        check(); state = "running"; progress();
        await table();
        const partialReasons = [
          ...(finishing ? [`Finish truncated scheduled ${protocol} work`] : []),
          ...failures.map(item => item.error),
          ...boundaries.flatMap(boundary => boundary.resolutions.flatMap(item => item.provenance.kind === "delegated" ? item.provenance.responses.filter(response => response.status === "failed").map(response => `Failed consultation: ${response.consultationId}`) : [])),
          ...boundaries.flatMap(boundary => boundary.resolutions.filter(item => item.status !== "answered" && item.status !== "rejected").map(item => `Unresolved knowledge: ${item.doubtId}`)),
          ...messages.flatMap(message => "limits" in message.body ? message.body.limits : [])];
        reviewReasons = partialReasons;
        const synthesis = await rootTurn({ kind: "synthesis", pendingDoubts, partialReasons }, {
          messages: messages.filter(message => ["preparation", "contribution"].includes(message.stage)).map(resultMessage),
          knowledgeBoundaries: confirmedKnowledge(), failures: structuredClone(failures),
          pendingDoubts: pendingDoubts.map(({ id }) => ({ id })), partialReasons,
          controls: [...appliedControls, ...consumeControls()] });
        if (synthesis.message.body.kind !== "synthesis") throw new Error("invalid synthesis");
        const body = synthesis.message.body;
        authorizedSynthesis = true;
        if (input.review && "completion" in body) {
          input.review.reobserve();
          const report = input.review.report(messages, reviewReasons, false, pendingDoubts, boundaries);
          result = { ...synthesis.result, status: report.completion === "complete" ? "completed" : "failed", result: JSON.stringify({ ...report, modelObservations }) };
        } else if ("status" in body) {
          result = { ...synthesis.result, status: body.status === "complete" ? "completed" : "failed", result: JSON.stringify(body) };
          architectureCandidate(input.observation, result, body);
        } else throw new Error("host table synthesis policy mismatch");
      } catch (error) {
        architectureFailure(input.observation, "turn", error, { stage: stage === "closing" ? undefined : stage, round });
        if (stage !== "closing") failures.push({ memberId: input.root.memberId, stage, round, error: String(error) });
        result = { ...lastRootResult ?? result, status: stopping || signal.aborted ? "cancelled" : "failed", result: String(error) };
        reviewReasons.push(String(error));
        if (input.review) result.result = JSON.stringify({ ...input.review.report(messages, [...reviewReasons, ...failures.map(item => item.error)],
          result.status === "cancelled", pendingDoubts, boundaries), modelObservations });
        if (error instanceof AgentClosureError) throw error;
      } finally {
        stage = "closing"; progress(); director.revoke();
        try { await disbandTeam(input.team).then(() => {
          for (const item of roster) { item.state = "closed"; observeMember(item); }
          architectureMembersClosed(input.observation);
        }, error => {
          for (const item of roster.filter(item => item.state !== "closed")) {
            item.state = teamWorkerStatus(input.team.evaluation.token, item.target.member.instanceId)[0]?.closure.state === "released" ? "closed" : "closure-unknown";
            observeMember(item);
          }
          architectureMembersClosed(input.observation, error); state = "closure-unknown"; throw error;
        }); }
        finally { signal.removeEventListener("abort", aborted); }
      }
      state = result.status === "completed" ? "finished" : result.status;
      reportReasons = reviewReasons;
      progress();
      return result;
    },
  };
}
function strictTarget(target: ModelTarget): ModelTarget { return { ...target, ...(target.reasoning ? { directReasoning: true } : {}) }; }
export type Consultation = ReturnType<typeof createTable>;

/** Join every owned turn/callback, including siblings of a failed operation. */
async function joined<T>(operations: Promise<T>[]): Promise<T[]> {
  const outcomes = await Promise.allSettled(operations);
  const failed = outcomes.find(outcome => outcome.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return outcomes.map(outcome => (outcome as PromiseFulfilledResult<T>).value);
}
