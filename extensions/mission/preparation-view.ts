import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { MissionDefinition } from "./model.ts";
import type { preparationContext } from "./preparation.ts";
import type { SetupAllocation } from "./setup.ts";
import type { OperatorChoice } from "./admission.ts";

function list(values: string[]): string {
  return values.length ? values.slice(0, 3).map((value) => value.length > 100 ? `${value.slice(0, 97)}…` : value).join(", ") +
    (values.length > 3 ? ` (+${values.length - 3} more; see details)` : "") : "none";
}

function duration(ms: number): string {
  const parts: string[] = [];
  for (const [size, unit] of [[86400000, "d"], [3600000, "h"], [60000, "min"], [1000, "sec"], [1, "ms"]] as const) {
    const amount = Math.floor(ms / size);
    if (amount) parts.push(`${amount} ${unit}`);
    ms %= size;
  }
  return parts.join(" ") || "0 sec";
}

function quantity(value: number): string {
  return value >= 1000000 && value % 1000000 === 0 ? `${value / 1000000}M` : value.toLocaleString("en-US");
}

function bytes(value: number): string {
  for (const [size, unit] of [[1024 ** 3, "GiB"], [1024 ** 2, "MiB"], [1024, "KiB"]] as const) {
    if (value >= size && value % size === 0) return `${value / size} ${unit}`;
  }
  return `${quantity(value)} B`;
}

function authorityView({ authority, budget, units }: MissionDefinition): string[] {
  return [
    `Writes: ${list(authority.allowedPaths)}`,
    `Operations: ${list(authority.operations)}; external effects: ${list(authority.externalEffects)}`,
    `Mission budget: ${quantity(budget.roleLaunches)} launches; ${quantity(budget.providerRequests)} provider requests; ${quantity(budget.tokens)} tokens.`,
    `Active time: ${duration(budget.activeTimeMs)}; stored output: ${bytes(budget.artifactBytes)}. These are ceilings, not estimates.`,
    authority.verificationProfiles?.includes("sealed-nested-verification-v1")
      ? `Offline nested checker authorized for ${units.flatMap(({ acceptance }) => acceptance)
        .filter(({ profile }) => profile === "sealed-nested-verification-v1").length} selected checks only: no host writes, credentials or network. Workers remain restricted.`
      : "Verification: ordinary contained commands; no nested checker.",
  ];
}

/** Exact payloads are inspected on demand, never summarized by a model or edited into consent. */
export async function confirmMissionAction(ui: Pick<ExtensionUIContext, "select" | "editor" | "confirm">, input: {
  title: string; summary: string; acceptLabel: string; details: () => string; check: () => void;
}): Promise<boolean> {
  if (typeof ui.select !== "function" || typeof ui.editor !== "function") {
    const accepted = await ui.confirm(input.title, input.summary);
    input.check();
    return accepted === true;
  }
  for (;;) {
    input.check();
    const choice = await ui.select(`${input.title}\n\n${input.summary}`,
      [input.acceptLabel, "View details", "Cancel"]);
    input.check();
    if (choice !== "View details") return choice === input.acceptLabel;
    await ui.editor("Technical details — viewing only; edits are ignored. Esc to return.", input.details());
    input.check();
  }
}

export function missionActionView(input: {
  action: string; planId: string; revision: number; root: string; state?: string;
  definition: MissionDefinition; choice?: OperatorChoice;
}): string {
  const effects: Record<string, string> = {
    prepare: "Register this mission; no workers start.",
    start: "Start implementation workers and required verification within these limits.",
    resume: "Continue unfinished work; completed work is not restarted. Recovery checks still apply.",
    pause: "Request a pause and stop active work safely; retain progress.",
    cancel: "Cancel this mission and stop active work safely; retained evidence is not deleted.",
    revise: "Apply the specified contract change; this is not acceptance of the implementation.",
  };
  const choice = input.choice;
  return [
    `Plan: ${input.planId} @${input.revision}${input.state ? ` — ${input.state}` : ""}`,
    `Execution root: ${input.root}`,
    effects[input.action],
    ...(["prepare", "start", "resume"].includes(input.action) ? authorityView(input.definition) : []),
    ...(choice ? choice.kind === "withdraw" ? [`Withdraw question: ${choice.questionId}`]
      : choice.edits.map(({ target, before, after }) =>
        `${target.kind} ${target.id ?? "mission"}.${target.field}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`) : []),
    ...(["start", "resume"].includes(input.action)
      ? [`Resume after closing Pi: ${input.definition.authority.resumeAfterClose ? "enabled" : "disabled"}; technical amendments: ${input.definition.authority.allowTechnicalAmendments ? "allowed" : "not allowed"}.`,
        "Prepared permissions and limits are unchanged; current inputs are rechecked before execution."] : []),
  ].join("\n");
}

/** Presentation only. Callers retain and recheck the complete canonical consent bytes. */
export function preparationView(input: {
  action: string;
  context: ReturnType<typeof preparationContext>;
  definition: MissionDefinition;
  setup?: SetupAllocation;
  interpretations?: Array<{ sourceId: string; disposition: "context" | "criterion" }>;
}): string {
  const { action, context, definition, setup } = input;
  const { binding } = context;
  return [
    `Plan: ${binding.planId} @${binding.revision}`,
    `Execution root: ${binding.executionRoot}`,
    action !== "admit-prepared-mission"
      ? "Authorize preparation permissions and source decisions; no setup, provider or worker runs yet."
      : setup?.effectProfile === "execution-root-local-copy-v1"
      ? "Prepare now: run scripts/setup.sh on private copies; host inputs stay read-only, network denied. No workers start."
      : "Prepare now: validate and register; no setup, provider or worker runs.",
    `Work planned: ${definition.units.length} units.`,
    ...authorityView(definition),
    setup ? `Setup: prepare ${list(setup.writableDirectories)}; budget ${duration(setup.activeTimeMs)} / ${bytes(setup.artifactBytes)}, within the mission budget.${setup.copy ? " Private copies, network denied." : " Runs only after separate start consent."}`
      : "Setup: none.",
    ...(input.interpretations ?? []).slice(0, 3).map(({ sourceId, disposition }) => {
      const region = context.inventory.unresolved.find(({ id }) => id === sourceId);
      const text = region?.text ?? "";
      return `Source decision: ${sourceId} → ${disposition}\n${text.length > 180 ? `${text.slice(0, 177)}… (full excerpt in View details)` : text}`;
    }),
    ...((input.interpretations?.length ?? 0) > 3 ? [`${input.interpretations!.length - 3} additional source decisions — View details for every exact excerpt.`] : []),
    `Next: /mission start ${binding.planId} — separate execution consent.${setup?.copy ? " Reuses settled setup; does not bootstrap again." : ""}`,
  ].join("\n");
}
