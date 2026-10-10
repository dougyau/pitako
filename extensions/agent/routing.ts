import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPitakoConfig, resolveRoleFromConfig, type LoadOptions } from "../roles/load.ts";
import { DEVELOPER_PROFILES, type DeveloperProfile, type PitakoConfig, type ResolvedRole } from "../roles/types.ts";
import { PitakoConfigError } from "../errors.ts";

export const ROUTING_QUESTION = {
  type: "choice",
  instructions: "Choose Developer capacity for this submitted WorkBrief, not authority. Senior does not assume Architect responsibility.",
  criteria: {
    developer_senior: "Material coupled contracts, consequential uncertainty, or difficult debugging within assigned scope.",
    developer_mid: "Ordinary bounded implementation with established requirements.",
    developer_junior: "Localized, well-specified implementation with a clear observer.",
    indeterminate: "Context does not establish which profile fits.",
  },
} as const;
const RECORD_LIMIT = 262144;

export interface RoutingRecord {
  version: 1;
  rubricVersion: 1;
  dispatchId: string;
  adviceId: string;
  toolCallId: string;
  source: string;
  coordinatorSessionId?: string;
  coordinatorSessionFile?: string;
  taskReference: { toolCallId: string; field: "task" };
  request?: ClassifierContext;
  response?: ClassifierResult;
  profile: DeveloperProfile;
  reason: string;
  resolvedPolicy: ResolvedRole["modelPolicy"];
}

export interface DispatchSnapshot {
  role: ResolvedRole;
  config: PitakoConfig;
  routing: RoutingRecord;
  evidence: "physical" | "pending-native-persistence" | "unavailable";
  evidenceGap?: string;
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/** Inspect the complete map; extra labels are retained and participate in winner selection. */
export function classifyProfile(result: ClassifierResult): { profile: DeveloperProfile; reason: string } {
  const mid = (reason: string) => ({ profile: "developer_mid" as const, reason });
  if (result.stopReason !== "stop") return mid(`classifier ${result.stopReason}`);
  const answer = result.answers?.capacity;
  if (!answer || answer.type !== "choice" || !answer.probabilities || typeof answer.probabilities !== "object") return mid("malformed choice");
  const entries = Object.entries(answer.probabilities);
  if (!Object.keys(ROUTING_QUESTION.criteria).every(key => Object.hasOwn(answer.probabilities, key)) ||
    entries.some(([, value]) => !Number.isFinite(value) || value < 0 || value > 1)) return mid("malformed probabilities");
  const highest = Math.max(...entries.map(([, value]) => value));
  const winners = entries.filter(([, value]) => value === highest);
  if (winners.length !== 1 || winners[0]![0] !== answer.choice) return mid("tie or inconsistent choice");
  if (!(DEVELOPER_PROFILES as readonly string[]).includes(answer.choice)) return mid("indeterminate or unknown winner");
  return { profile: answer.choice as DeveloperProfile, reason: "unique classifier choice" };
}

/** Host preflight only. The runner never discovers or classifies. */
export async function developerPreflight(input: {
  task: string; toolCallId: string; source: string; ctx: ExtensionContext;
  pi: Pick<ExtensionAPI, "appendEntry">; signal?: AbortSignal;
  owns: () => boolean; load?: LoadOptions;
}): Promise<DispatchSnapshot> {
  if (!input.task.trim()) throw new PitakoConfigError("agent_run task must not be empty");
  const config = immutable(loadPitakoConfig(input.load));
  const sessionId = input.ctx.sessionManager?.getSessionId?.();
  const sessionFile = input.ctx.sessionManager?.getSessionFile?.();
  const check = () => {
    if (input.signal?.aborted || !input.owns() || input.ctx.sessionManager?.getSessionId?.() !== sessionId ||
      input.ctx.sessionManager?.getSessionFile?.() !== sessionFile) throw new Error("Developer dispatch cancelled before admission");
  };
  check();
  let profile: DeveloperProfile = "developer_mid";
  let reason = "classifier unavailable";
  let request: ClassifierContext | undefined;
  let response: ClassifierResult | undefined;
  let evidence: DispatchSnapshot["evidence"] = "unavailable";
  let evidenceGap: string | undefined;
  const identity = { version: 1 as const, rubricVersion: 1 as const, dispatchId: randomUUID(), adviceId: randomUUID(),
    toolCallId: input.toolCallId, source: input.source, coordinatorSessionId: sessionId,
    coordinatorSessionFile: sessionFile, taskReference: { toolCallId: input.toolCallId, field: "task" as const } };
  const context: ClassifierContext = { state: { workbrief: input.task }, questions: { capacity: ROUTING_QUESTION } };
  // Leave room for the full public result and policy. Never silently clip the submitted task.
  if (!sessionFile || typeof input.pi.appendEntry !== "function") {
    reason = "native recording unavailable; classification skipped";
    evidenceGap = reason;
  } else if (JSON.stringify(context).length > RECORD_LIMIT / 2) {
    reason = "submitted WorkBrief exceeds supported native record budget; classification skipped";
  } else {
    try {
      const available = await input.ctx.modelRegistry.getAvailableOfType("classifier", "opencode", { signal: input.signal });
      check();
      const model = available.find(model => model.id === "jev-1.13-free" && model.provider === "opencode");
      // No tokenizer is exposed by the host classifier API. Use the advertised
      // context window as a conservative UTF-8 request budget, never truncate.
      if (model && Buffer.byteLength(JSON.stringify(context), "utf8") > model.contextWindow) {
        reason = "submitted WorkBrief exceeds conservative classifier context-window budget; classification skipped";
      } else if (model) {
        request = context;
        response = await input.ctx.modelRegistry.classify(model, request, { signal: input.signal, maxRetries: 0 });
        check();
        if (response.stopReason === "aborted") throw new Error("Developer classifier aborted before admission");
        ({ profile, reason } = classifyProfile(response));
      }
    } catch (error) {
      check();
      if (response?.stopReason === "aborted") throw error;
      reason = `classifier failed: ${String(error)}`;
    }
  }
  check();
  let role = resolveRoleFromConfig(config, "developer", profile);
  let routing: RoutingRecord = { ...identity, request, response, profile, reason, resolvedPolicy: role.modelPolicy };
  if (sessionFile && typeof input.pi.appendEntry === "function") {
    try {
      if (JSON.stringify(routing).length > RECORD_LIMIT) throw new Error("complete routing record exceeds native value limit");
      input.pi.appendEntry("pitako.developer-routing", routing);
      // Native append may remain in memory before the first assistant. It is not a receipt.
      try {
        evidence = readFileSync(sessionFile, "utf8").split("\n").some(line => {
          if (!line) return false;
          const entry = JSON.parse(line);
          return entry.type === "custom" && entry.customType === "pitako.developer-routing" &&
            entry.data?.dispatchId === identity.dispatchId;
        }) ? "physical" : "pending-native-persistence";
      } catch { evidence = "pending-native-persistence"; }
      if (evidence !== "physical") evidenceGap = "Native append has no physical persistence receipt yet; coordinator/worker before-first-assistant gaps remain possible.";
    } catch (error) {
      profile = "developer_mid";
      reason = `native recording failed after advice: ${String(error)}`;
      evidence = "unavailable";
      evidenceGap = reason;
      role = resolveRoleFromConfig(config, "developer", profile);
      // Do not propagate a failed write's probabilities as retained evidence or attempt another write.
      routing = { ...identity, profile, reason, resolvedPolicy: role.modelPolicy };
    }
  }
  check();
  if (!role.modelPolicy.primary) throw new PitakoConfigError(role.modelPolicy.diagnostic!);
  return immutable({ role, config, routing, evidence, evidenceGap });
}
