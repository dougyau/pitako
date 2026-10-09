import { randomUUID } from "node:crypto";
import { parsePlanDocument } from "../workflow.ts";
import { sha256, validateMissionDefinitionBytes, type MissionDefinition, type MissionEvent } from "./model.ts";
import type { MissionEngine } from "./engine.ts";
import type { MissionInspection, MissionStore } from "./store.ts";

const encoder = new TextEncoder();
type ChoiceTarget = { kind: "predicate" | "unit" | "mission"; id?: string; field: string };
type ChoiceEdit = { target: ChoiceTarget; before: unknown; after: unknown };
export type OperatorChoice = { kind: "revise" | "answer"; questionId?: string; edits: ChoiceEdit[] } |
  { kind: "withdraw"; questionId: string };
export type OperatorSource = "console" | "native-confirmation";
export type OperatorReceipt = Readonly<{ id: string; source: OperatorSource; sessionId: string; text: string; instruction: string; receivedAt: number;
  missionId?: string; ownerEpoch?: number; base?: Readonly<{ revision: number; planHash: string; definitionHash: string }>; choice?: Readonly<OperatorChoice>; format?: "mission-operator-choice-v1" }>;
const issued = new WeakSet<OperatorReceipt>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Host adapter only: authenticated console submission or an exact native UI confirmation. */
export function recordOperatorInput(source: OperatorSource, sessionId: string, text: string, causalId: ReturnType<typeof randomUUID> = randomUUID(), instruction = text): OperatorReceipt | undefined {
  if (!["console", "native-confirmation"].includes(source) || !sessionId || !text.trim()) return undefined;
  const receipt = Object.freeze({ id: causalId, source, sessionId, text, instruction, receivedAt: performance.now() });
  issued.add(receipt);
  return receipt;
}

export function consumeOperatorInput(receipt: OperatorReceipt, sessionId: string, text: string): void {
  if (!issued.has(receipt) || receipt.sessionId !== sessionId || receipt.text !== text)
    throw new Error("current one-use host-issued operator receipt required");
  issued.delete(receipt);
}

function editSource(definition: MissionDefinition, target: ChoiceTarget): unknown {
  if (target.kind === "mission") {
    if (target.id !== undefined) throw new Error("mission edit has no ID");
    return definition;
  }
  if (typeof target.id !== "string" || !target.id) throw new Error("edit needs an exact semantic ID");
  if (target.kind === "unit") {
    const unit = definition.units.find(({ id }) => id === target.id);
    if (!unit) throw new Error("unknown unit ID");
    return unit;
  }
  const predicates = definition.units.flatMap(({ acceptance }) => acceptance).filter(({ id }) => id === target.id);
  if (predicates.length !== 1) throw new Error("unknown or ambiguous predicate ID");
  return predicates[0];
}

export function editValue(definition: MissionDefinition, target: ChoiceTarget): unknown {
  const segments = target.field.split("/");
  if (target.kind === "mission" && segments[0] === "units" && segments.length !== 1 ||
    target.kind === "unit" && segments[0] === "acceptance" && segments.length !== 1 ||
    !target.field || segments.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part) ||
    !/^[a-zA-Z0-9_-]+$/.test(part))) throw new Error("invalid choice field");
  let value = editSource(definition, target);
  for (const segment of segments) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) throw new Error("unknown choice field");
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

export function parseChoice(detail: string, definition: MissionDefinition): OperatorChoice {
  const withdraw = /^withdraw\s+([0-9a-f-]{36})$/i.exec(detail);
  if (withdraw && uuid.test(withdraw[1]!)) return { kind: "withdraw", questionId: withdraw[1]! };
  const command = /^(?:set\s+([\s\S]+)|answer\s+([0-9a-f-]{36})\s+([\s\S]+))$/.exec(detail);
  const natural = /^Change (predicate|unit|mission) ([a-z0-9_-]+) ([a-zA-Z0-9_/-]+) to ([\s\S]+)$/.exec(command?.[2] ? command[3]! : detail);
  if (!command && !natural) throw new Error("operator choice requires exact typed command: set <edits-json> or answer <question-id> <edits-json>");
  if (command?.[2] && !uuid.test(command[2])) throw new Error("invalid question ID");
  let edits: unknown;
  if (natural) {
    let after: unknown;
    try { after = JSON.parse(natural[4]!); } catch { throw new Error("choice value must be JSON"); }
    const target: ChoiceTarget = { kind: natural[1] as ChoiceTarget["kind"], ...(natural[1] === "mission" ? {} : { id: natural[2] }), field: natural[1] === "mission" ? `${natural[2]}/${natural[3]}` : natural[3]! };
    edits = [{ target, before: editValue(definition, target), after }];
  } else {
    try { edits = JSON.parse(command![1] ?? command![3]!); } catch { throw new Error("choice edits must be JSON"); }
  }
  if (!Array.isArray(edits) || !edits.length || edits.length > 32) throw new Error("choice requires bounded edits");
  const seen: ChoiceTarget[] = [];
  for (const edit of edits) {
    if (!object(edit) || !exactKeys(edit, ["target", "before", "after"]) || !object(edit.target) ||
      typeof edit.target.kind !== "string" || !["predicate", "unit", "mission"].includes(edit.target.kind) ||
      !exactKeys(edit.target, edit.target.kind === "mission" ? ["kind", "field"] : ["kind", "id", "field"]) ||
      typeof edit.target.field !== "string" || (edit.target.kind !== "mission" && typeof edit.target.id !== "string"))
      throw new Error("choice edit requires exact target/before/after");
    const target = edit.target as ChoiceTarget;
    const value = editValue(definition, target);
    if (!same(value, edit.before)) throw new Error("choice preimage mismatch");
    if (same(value, edit.after)) throw new Error("choice edit must change value");
    if (seen.some((prior) => prior.kind === target.kind && prior.id === target.id &&
      (prior.field === target.field || prior.field.startsWith(`${target.field}/`) || target.field.startsWith(`${prior.field}/`)) ||
      prior.kind === "mission" && prior.field === "units" && target.kind !== "mission" ||
      target.kind === "mission" && target.field === "units" && prior.kind !== "mission"))
      throw new Error("overlapping choice edits");
    seen.push(target);
  }
  return command?.[2] ? { kind: "answer", questionId: command[2], edits } : { kind: "revise", edits };
}

/** Only a host admission adapter calls this with its revalidated mission snapshot. */
export function recordOperatorChoice(store: MissionStore, mission: MissionInspection, sessionId: string, text: string,
  detail: string, causalId: ReturnType<typeof randomUUID> = randomUUID(), source: OperatorSource = "console"): OperatorReceipt {
  if (!sessionId || store.ownerEpoch === null || text !== `/mission revise ${mission.planId} ${detail}`)
    throw new Error("host admission and exact mission command required; use /mission revise <plan-id> in this session");
  const choice = parseChoice(detail, mission.definition);
  const receipt = freezeDeep({ id: causalId, source, sessionId, text, instruction: detail,
    receivedAt: performance.now(), format: "mission-operator-choice-v1" as const, missionId: mission.id,
    ownerEpoch: store.ownerEpoch, base: { revision: mission.revision, planHash: mission.snapshot.planHash,
      definitionHash: mission.snapshot.definitionHash }, choice: structuredClone(choice) });
  issued.add(receipt);
  return receipt;
}

export function chosenDefinition(definition: MissionDefinition, edits: readonly ChoiceEdit[]): MissionDefinition {
  const next = structuredClone(definition);
  for (const { target, before, after } of edits) {
    const segments = target.field.split("/");
    let value = editSource(next, target) as Record<string, unknown>;
    for (const segment of segments.slice(0, -1)) value = value[segment] as Record<string, unknown>;
    const field = segments.at(-1)!;
    if (!same(value[field], before)) throw new Error("choice preimage mismatch");
    value[field] = structuredClone(after);
  }
  return validateMissionDefinitionBytes(encoder.encode(JSON.stringify(next))).definition;
}

export function classifyIntervention(event: { kind: string; payload: Record<string, unknown> }): "operator_choice" | "operational_rescue" | "unknown" {
  if (typeof event.payload.operatorText !== "string" || typeof event.payload.operatorInputId !== "string") return "unknown";
  if (event.kind === "mission.input.recorded" && event.payload.intervention === "operational_rescue") return "operational_rescue";
  if (["mission.created", "mission.activated", "mission.revised", "mission.paused", "mission.resumed", "mission.cancelled"].includes(event.kind)) return "operator_choice";
  return "unknown";
}

export function classifyMissionInput(text: string): "question" | "hypothetical" | "instruction" | "ambiguous" {
  const value = text.trim();
  if (/^(what if|suppose|imagine|hypothetically|if we|could we|would it|what would)\b/i.test(value)) return "hypothetical";
  if (/^(what|why|how|when|where|who|is|are|does|do|can|which|status|show|tell)\b/i.test(value) || value.endsWith("?")) return "question";
  if (/^(change|add|remove|replace|pause|resume|cancel|start|prioritize|revise|use|require|do not|don't|stop)\b/i.test(value)) return "instruction";
  return "ambiguous";
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

type ChoiceBinding = { kind: "predicate" | "unit" | "mission"; id: string; owner: string; field: string; value: unknown };
type PendingChoice = { id: string; roots: string[]; paths: string[]; bindings: ChoiceBinding[]; askDefinitionHash: string };

function choiceBinding(definition: MissionDefinition, path: string): ChoiceBinding | undefined {
  const parts = path.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  const unit = parts[0] === "units" ? definition.units[Number(parts[1])] : undefined;
  if (unit) {
    if (parts[2] === "acceptance" && (parts.length === 4 || parts.length === 5)) {
      const predicate = unit.acceptance[Number(parts[3])];
      if (!predicate || parts.length === 5 && !Object.hasOwn(predicate, parts[4]!)) return undefined;
      return { kind: "predicate", id: predicate.id, owner: unit.id, field: parts[4] ?? "",
        value: structuredClone(parts.length === 4 ? predicate : (predicate as unknown as Record<string, unknown>)[parts[4]!]) };
    }
    if (parts.length < 3) return undefined;
    const field = parts.slice(2).join("/");
    const value = parts.slice(2).reduce<unknown>((target, key) => target && typeof target === "object"
      ? (target as Record<string, unknown>)[key] : undefined, unit);
    return value === undefined ? undefined : { kind: "unit", id: unit.id, owner: unit.id, field, value: structuredClone(value) };
  }
  return parts[0] && Object.hasOwn(definition, parts[0])
    ? { kind: "mission", id: parts[0], owner: "", field: parts.join("/"), value: structuredClone(definition[parts[0] as keyof MissionDefinition]) } : undefined;
}

function bindingOwner(binding: ChoiceBinding, definition: MissionDefinition): string | undefined {
  if (binding.kind === "predicate") return definition.units.find((unit) => unit.acceptance.some(({ id }) => id === binding.id))?.id;
  if (binding.kind === "unit") return definition.units.find(({ id }) => id === binding.id)?.id;
  return undefined;
}

function bindingValue(binding: ChoiceBinding, definition: MissionDefinition): unknown {
  const source = binding.kind === "predicate" ? definition.units.flatMap((unit) => unit.acceptance).find(({ id }) => id === binding.id) :
    binding.kind === "unit" ? definition.units.find(({ id }) => id === binding.id) : definition;
  if (!binding.field) return source;
  const fields = binding.field.split("/");
  return fields.reduce<unknown>((value, field) => value && typeof value === "object"
    ? (value as Record<string, unknown>)[field] : undefined, source);
}

function questionTargets(question: PendingChoice, edits: readonly ChoiceEdit[]): boolean {
  return question.bindings.length > 0 && question.bindings.every((binding) => edits.some(({ target }) =>
    binding.kind === target.kind && binding.id === (target.id ?? binding.id) && binding.field === target.field));
}

function exactAnswer(question: PendingChoice, edits: readonly ChoiceEdit[]): boolean {
  return question.bindings.length === edits.length && questionTargets(question, edits);
}

function choiceCovered(question: PendingChoice, old: MissionDefinition, next: MissionDefinition): boolean {
  return question.bindings.length > 0 && question.bindings.every((binding) =>
    (binding.kind === "mission" || bindingOwner(binding, old) && bindingOwner(binding, next)) &&
    bindingValue(binding, next) !== undefined &&
    !same(bindingValue(binding, old), bindingValue(binding, next)));
}

function choiceRoots(question: PendingChoice, old: MissionDefinition, next: MissionDefinition): string[] {
  if (!question.paths.length) return question.roots;
  const mapped = question.bindings.flatMap((binding) => binding.kind === "mission"
    ? next.units.map(({ id }) => id) : bindingOwner(binding, next) ? [bindingOwner(binding, next)!] : []);
  if (question.bindings.length && mapped.length === question.bindings.length &&
    !question.bindings.some(({ kind }) => kind === "mission")) return [...new Set(mapped)];
  // A missing selector stays pending. Stable independent units remain free; changed units may be successors.
  const previous = new Map(old.units.map((unit) => [unit.id, unit]));
  const surviving = question.roots.filter((id) => next.units.some((unit) => unit.id === id));
  return [...new Set([...mapped, ...surviving, ...next.units.filter((unit) =>
    !same(previous.get(unit.id), unit)).map(({ id }) => id)])];
}

function receiptValid(receipt: Record<string, unknown>, event: MissionEvent, snapshot: unknown): boolean {
  if (!object(snapshot) || !object(receipt.base)) return false;
  return receipt.format === "mission-operator-choice-v1" && (receipt.source === "console" || receipt.source === "native-confirmation") &&
    receipt.id === event.causalId && receipt.id === event.payload.operatorInputId &&
    receipt.missionId === event.missionId && typeof receipt.sessionId === "string" && !!receipt.sessionId &&
    typeof receipt.ownerEpoch === "number" && typeof receipt.receivedAt === "number" &&
    receipt.base.revision === snapshot.revision && receipt.base.planHash === snapshot.planHash &&
    receipt.base.definitionHash === snapshot.definitionHash &&
    receipt.text === `/mission revise ${snapshot.planId} ${receipt.instruction}` &&
    receipt.text === event.payload.operatorText && receipt.instruction === event.payload.operatorInstruction;
}

function definitionAt(event: MissionEvent, events: readonly MissionEvent[], store: MissionStore): { definition: MissionDefinition; hash: string } | undefined {
  const snapshot = [...events].reverse().find((row) => row.seq <= event.seq &&
    (row.kind === "mission.created" || row.kind === "mission.revised"))?.payload.snapshot as { definitionHash?: string } | undefined;
  if (!snapshot?.definitionHash) return undefined;
  try { return { definition: validateMissionDefinitionBytes(store.readArtifact(snapshot.definitionHash)).definition, hash: snapshot.definitionHash }; }
  catch { return undefined; }
}

/** Derive impact from actual definition bytes, never from a proposal's claimed list. */
export function revisionImpact(old: MissionDefinition, next: MissionDefinition): string[] {
  const before = new Map(old.units.map((unit) => [unit.id, unit]));
  const after = new Map(next.units.map((unit) => [unit.id, unit]));
  const all = new Set([...before.keys(), ...after.keys()]);
  if (!same(old.goal, next.goal) || !same(old.scope, next.scope) || !same(old.nonGoals, next.nonGoals) ||
    !same(old.invariants, next.invariants) || !same(old.authority, next.authority) ||
    !same(old.budget, next.budget) || !same(old.resourcePolicy, next.resourcePolicy) || !same(old.finalization, next.finalization)) return [...all].sort();
  const changed = new Set([...all].filter((id) => !same(before.get(id), after.get(id))));
  let prior = -1;
  while (prior !== changed.size) {
    prior = changed.size;
    for (const unit of next.units) if (unit.dependencies.some((id) => changed.has(id))) changed.add(unit.id);
  }
  return [...changed].sort();
}

function selectChoiceQuestions(current: MissionDefinition, definition: MissionDefinition,
  choice: Readonly<OperatorChoice> | undefined, pending: PendingChoice[]): PendingChoice[] {
  const edits = choice && choice.kind !== "withdraw" ? choice.edits : [];
  if (choice?.kind === "answer" && !pending.some(({ id }) => id === choice.questionId)) throw new Error("no pending question with this ID");
  const covered = pending.filter((question) => questionTargets(question, edits) && choiceCovered(question, current, definition));
  const selected = choice?.kind === "answer" ? covered.filter(({ id }) => id === choice.questionId) : covered;
  if (choice?.kind === "answer" && (selected.length !== 1 || !exactAnswer(selected[0]!, edits)))
    throw new Error("operator answer must cover exactly its question bindings");
  if (choice?.kind === "revise" && selected.length > 1) throw new Error("ambiguous operator choice: name the question ID");
  if (choice && pending.some((question) => choiceCovered(question, current, definition) &&
    !selected.some((chosen) => chosen.id === question.id ||
      chosen.bindings.length === question.bindings.length && questionTargets(question, edits)) &&
    question.bindings.every((binding) => bindingValue(binding, definition) !== undefined)))
    throw new Error("operator choice changes an unresolved field without exact selection");
  return selected;
}

/** Read-only preflight shared by confirmation and committing choice admission. */
export function validateOperatorChoice(store: MissionStore, mission: MissionInspection, choice: Readonly<OperatorChoice>) {
  const pending = pendingMissionQuestions(mission.events, store);
  if (choice.kind === "withdraw") {
    if (!pending.some(({ id }) => id === choice.questionId)) throw new Error("no pending question with this ID");
    return { definition: mission.definition, pending };
  }
  const definition = chosenDefinition(mission.definition, choice.edits);
  selectChoiceQuestions(mission.definition, definition, choice, pending);
  return { definition, pending };
}

export function admitMissionChange(input: {
  store: MissionStore; engine?: MissionEngine; missionId: string; expectedVersion: number;
  planBytes: Uint8Array; definitionBytes: Uint8Array; receipt?: OperatorReceipt;
  actor: "operator" | "model"; claimedImpact?: string[];
}): { revision: number; impact: string[]; retained: string[] } {
  const current = input.store.inspectMission(input.missionId);
  if (current.version !== input.expectedVersion) throw new Error("revision version conflict");
  const plan = parsePlanDocument(new TextDecoder("utf-8", { fatal: true }).decode(input.planBytes));
  const { definition } = validateMissionDefinitionBytes(input.definitionBytes);
  if (plan.id !== current.planId || plan.revision !== current.revision + 1 || plan.status !== "frozen") throw new Error("revision requires next frozen plan snapshot");
  if (input.actor === "operator") {
    const receipt = input.receipt;
    if (!receipt || !issued.has(receipt) || receipt.format !== "mission-operator-choice-v1" ||
      !receipt.choice || receipt.choice.kind === "withdraw" || receipt.missionId !== current.id ||
      receipt.ownerEpoch !== input.store.ownerEpoch || receipt.base?.revision !== current.revision ||
      receipt.base.planHash !== current.snapshot.planHash || receipt.base.definitionHash !== current.snapshot.definitionHash ||
      receipt.text !== `/mission revise ${current.planId} ${receipt.instruction}`) throw new Error("revision requires a current host-bound operator choice");
    const chosen = chosenDefinition(current.definition, receipt.choice.edits);
    if (!same(chosen, definition) || !Buffer.from(input.planBytes).equals(Buffer.from(nextPlanBytes(current.planBytes))))
      throw new Error("operator choice does not equal complete revision bytes");
  } else {
    if (!current.definition.authority.allowTechnicalAmendments) throw new Error("technical amendments are not authorized");
    for (const key of ["goal", "scope", "nonGoals", "invariants", "authority", "budget", "resourcePolicy", "finalization"] as const) {
      if (!same(current.definition[key], definition[key])) throw new Error(`model amendment cannot change ${key}`);
    }
    // The v1 executable schema has no separate method/substep field. Do not infer permission to edit gates or DAG edges.
    if (!same(current.definition.units, definition.units)) throw new Error("model amendment cannot edit executable unit contracts");
    if (!same(Buffer.from(nextPlanBytes(current.planBytes)).toString("utf8"), Buffer.from(input.planBytes).toString("utf8"))) throw new Error("model amendment cannot rewrite plan authority");
  }
  const impact = revisionImpact(current.definition, definition);
  const pending = pendingMissionQuestions(current.events, input.store);
  const choice = input.actor === "operator" ? input.receipt!.choice! : undefined;
  const selected = selectChoiceQuestions(current.definition, definition, choice, pending);
  const resolutions = selected.map(({ id }) => id);
  const questionMappings = pending.filter(({ id }) => !resolutions.includes(id)).map((question) => {
    const roots = choiceRoots(question, current.definition, definition);
    return { id: question.id, roots, heldUnits: pendingQuestionClosure([{ ...question, roots }], definition) };
  });
  const retained = current.definition.units.map(({ id }) => id).filter((id) => !impact.includes(id) && definition.units.some((unit) => unit.id === id));
  const admitted = input.store.admitRevision({ missionId: input.missionId, expectedVersion: input.expectedVersion,
    planBytes: input.planBytes, definitionBytes: input.definitionBytes,
    receiptId: input.receipt?.id ?? randomUUID(), actor: input.actor, impact, retained,
    operatorText: input.receipt?.text, operatorInstruction: input.receipt?.instruction,
    operatorReceipt: input.actor === "operator" ? input.receipt : undefined,
    resolvesInputIds: resolutions, questionMappings });
  if (input.receipt) issued.delete(input.receipt);
  input.engine?.fenceRevisedUnits(impact);
  return { revision: admitted.revision, impact, retained };
}

export function askMissionChoice(input: {
  store: MissionStore; engine: MissionEngine; missionId: string; expectedVersion: number;
  receipt: OperatorReceipt; delta?: string;
}): { question: string; impact: string[] } {
  const current = input.store.inspectMission(input.missionId);
  if (current.version !== input.expectedVersion) throw new Error("revision version conflict");
  if (!issued.has(input.receipt) || classifyMissionInput(input.receipt.instruction) !== "ambiguous" ||
    !input.receipt.text.toLowerCase().includes(current.planId.toLowerCase())) throw new Error("ambiguous choice requires the authenticated mission input");
  let impact: string[] = [];
  let roots: string[] = [];
  let paths: string[] = [];
  let bindings: ChoiceBinding[] = [];
  if (input.delta) {
    try {
      const bytes = applyOperatorDelta(current.definition, input.delta);
      const next = validateMissionDefinitionBytes(bytes).definition;
      impact = revisionImpact(current.definition, next);
      roots = current.definition.units.filter((unit, index) => !same(unit, next.units[index])).map((unit) => unit.id);
      if (impact.length && !roots.length) roots = current.definition.units.map((unit) => unit.id);
      paths = (JSON.parse(input.delta) as Array<{ path: string }>).map(({ path }) => path);
      bindings = paths.map((path) => choiceBinding(current.definition, path)).filter((value): value is ChoiceBinding => !!value);
      if (bindings.length !== paths.length) bindings = [];
      if (bindings.length) roots = [...new Set(bindings.flatMap((binding) => binding.kind === "mission"
        ? current.definition.units.map(({ id }) => id) : [binding.owner]))];
    } catch { /* No reliable impact: ask for the missing delta without a broad hold. */ }
  }
  const question = paths.length
    ? `What exact change do you want for ${paths.join(", ")}? Give a clear instruction with the explicit delta, or withdraw this choice.`
    : "What exact delta do you want? Give a clear instruction with an explicit delta, or withdraw this choice.";
  input.store.appendTransition(current.id, current.version, { events: [{ revision: current.revision,
    kind: "mission.input.recorded", causalId: input.receipt.id,
    payload: { operatorInputId: input.receipt.id, operatorText: input.receipt.text, classification: "ambiguous",
      question, questionImpact: impact, questionRoots: roots, deltaPaths: paths,
      askDefinitionHash: current.snapshot.definitionHash, choiceBindings: bindings },
  }] });
  issued.delete(input.receipt);
  input.engine.fenceQuestionUnits(impact);
  return { question, impact };
}

export async function withdrawMissionChoice(input: {
  store: MissionStore; engine: MissionEngine; missionId: string; receipt: OperatorReceipt;
}): Promise<string[]> {
  const current = input.store.inspectMission(input.missionId);
  const choice = input.receipt.choice;
  if (!issued.has(input.receipt) || input.receipt.format !== "mission-operator-choice-v1" || choice?.kind !== "withdraw" ||
    input.receipt.missionId !== current.id || input.receipt.ownerEpoch !== input.store.ownerEpoch ||
    input.receipt.base?.revision !== current.revision || input.receipt.base.planHash !== current.snapshot.planHash ||
    input.receipt.base.definitionHash !== current.snapshot.definitionHash) throw new Error("withdraw requires current host-bound operator choice");
  const pending = pendingMissionQuestions(current.events, input.store);
  const question = pending.find(({ id }) => id === choice.questionId);
  if (!question) throw new Error("no pending operator choice or ambiguous withdrawal target");
  const impact = pendingQuestionClosure([question], current.definition);
  input.store.appendTransition(current.id, current.version, { events: [{ revision: current.revision,
    kind: "mission.input.recorded", causalId: input.receipt.id,
    payload: { operatorInputId: input.receipt.id, operatorText: input.receipt.text,
      classification: "instruction", resolvesInputId: question.id, disposition: "withdrawn", operatorReceipt: input.receipt,
      operatorInstruction: input.receipt.instruction },
  }] });
  issued.delete(input.receipt);
  await input.engine.releaseQuestionUnits(impact);
  return impact;
}

export function pendingMissionQuestions(events: readonly MissionEvent[], store: MissionStore): PendingChoice[] {
  const pending = new Map<string, PendingChoice>();
  for (const event of events) {
    if (event.kind === "mission.revised") {
      const mapping = event.payload.questionMappings as Array<{ id: string; roots: string[] }> | undefined;
      const before = events.filter((row) => row.seq < event.seq && (row.kind === "mission.created" || row.kind === "mission.revised")).at(-1);
      const old = before && definitionAt(before, events, store)?.definition;
      const next = definitionAt(event, events, store)?.definition;
      // Legacy unbound resolvesInputIds are not authority. Replay only a fully checked typed receipt.
      const receipt = event.payload.operatorReceipt;
      if (old && next && object(receipt) && receiptValid(receipt, event, before?.payload.snapshot)) {
        try {
          const choice = parseChoice(String(receipt.instruction), old);
          if (same(choice, receipt.choice) && choice.kind !== "withdraw" &&
            same(chosenDefinition(old, choice.edits), next)) {
            const covered = [...pending.values()].filter((question) => questionTargets(question, choice.edits) && choiceCovered(question, old, next));
            const selected = choice.kind === "answer" ? covered.filter(({ id }) => id === choice.questionId) : covered.length === 1 ? covered : [];
            for (const question of selected) if (choice.kind !== "answer" || exactAnswer(question, choice.edits)) {
              if ((event.payload.resolvesInputIds as string[] | undefined)?.includes(question.id)) pending.delete(question.id);
            }
          }
        } catch { /* Unsupported or invalid historical receipt leaves question pending. */ }
      }
      if (pending.size) {
        if (old && next) for (const question of pending.values()) question.roots = choiceRoots(question, old, next);
        else for (const question of pending.values()) question.roots = [...new Set([...question.roots,
          ...(mapping?.find(({ id }) => id === question.id)?.roots ?? []),
          ...((event.payload.impact as string[] | undefined) ?? [])])];
      }
    }
    if (event.kind !== "mission.input.recorded") continue;
    if (event.payload.resolvesInputId && object(event.payload.operatorReceipt)) {
      const receipt = event.payload.operatorReceipt;
      const choice = receipt.choice;
      const snapshot = [...events].reverse().find((row) => row.seq <= event.seq &&
        (row.kind === "mission.created" || row.kind === "mission.revised"))?.payload.snapshot;
      if (object(choice) && choice.kind === "withdraw" && choice.questionId === event.payload.resolvesInputId &&
        receiptValid(receipt, event, snapshot) && receipt.instruction === `withdraw ${choice.questionId}`)
        pending.delete(choice.questionId as string);
    }
    if (event.payload.classification === "ambiguous" && Array.isArray(event.payload.questionImpact)) {
      const ask = definitionAt(event, events, store);
      const paths = Array.isArray(event.payload.deltaPaths) ? event.payload.deltaPaths.map(String) : [];
      const bindings = Array.isArray(event.payload.choiceBindings) ? event.payload.choiceBindings as ChoiceBinding[] :
        ask ? paths.map((path) => choiceBinding(ask.definition, path)).filter((value): value is ChoiceBinding => !!value) : [];
      pending.set(String(event.payload.operatorInputId), {
        id: String(event.payload.operatorInputId),
        roots: Array.isArray(event.payload.questionRoots) ? event.payload.questionRoots.map(String) : event.payload.questionImpact.map(String),
        paths, bindings: bindings.length === paths.length ? bindings : [],
        askDefinitionHash: typeof event.payload.askDefinitionHash === "string" ? event.payload.askDefinitionHash : ask?.hash ?? "",
      });
    }
  }
  return [...pending.values()];
}

export function pendingQuestionClosure(questions: readonly PendingChoice[], definition: MissionDefinition): string[] {
  const blocked = new Set(questions.flatMap(({ roots }) => roots));
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of definition.units) {
      if (blocked.has(unit.id) || !unit.dependencies.some((id) => blocked.has(id))) continue;
      blocked.add(unit.id); changed = true;
    }
  }
  return [...blocked];
}

export function applyOperatorDelta(current: MissionDefinition, raw: string): Uint8Array {
  const patches: unknown = JSON.parse(raw);
  if (!Array.isArray(patches) || patches.length === 0 || patches.length > 32) throw new Error("revision needs a bounded explicit delta");
  const next = structuredClone(current);
  for (const patch of patches) {
    if (!patch || typeof patch !== "object" || patch.op !== "replace" || typeof patch.path !== "string" ||
      !Object.hasOwn(patch, "before") || !Object.hasOwn(patch, "after")) throw new Error("revision requires replace/path/before/after");
    const segments = patch.path.split("/").slice(1).map((part: string) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (!patch.path.startsWith("/") || !segments.length || segments.some((part: string) => !part || ["__proto__", "prototype", "constructor"].includes(part))) {
      throw new Error("invalid revision path");
    }
    let target: any = next;
    for (const part of segments.slice(0, -1)) {
      if (!target || !Object.hasOwn(target, part)) throw new Error("revision path does not exist");
      target = target[part];
    }
    const key = segments.at(-1)!;
    if (!target || !Object.hasOwn(target, key) || !same(target[key], patch.before)) throw new Error("revision preimage mismatch");
    target[key] = patch.after;
  }
  return encoder.encode(JSON.stringify(next));
}

export function nextPlanBytes(current: Uint8Array): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(current);
  const plan = parsePlanDocument(text);
  return encoder.encode(text.replace(/^(revision:\s*)\d+(\s*)$/m, (_, prefix: string, suffix: string) => `${prefix}${plan.revision + 1}${suffix}`));
}

export function definitionDigest(bytes: Uint8Array): string { return sha256(bytes); }
