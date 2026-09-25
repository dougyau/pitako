import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { WatchdogConfig } from "../agent/watchdog.ts";

/** Pi thinking levels, plus `off`. Omitting reasoning means "use Pi's session default later." */
export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

const PI_THINKING = {
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
} as const satisfies Record<ThinkingLevel, true>;

export const ROLE_IDS = ["coordinator", "architect", "developer", "reviewer", "researcher"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/**
 * Future AgentInstance classification. Not read from config in v0.
 * Pi does not export a stable rate-limit/quota/auth taxonomy, so this stays internal.
 */
export const FALLBACK_REASONS = ["rate_limit", "quota", "unavailable", "auth"] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export interface ModelTarget {
  model: string;
  reasoning?: ReasoningLevel;
  fast?: boolean;
}

export interface ModelPolicy {
  id: string;
  primary?: ModelTarget;
  fallbacks: readonly ModelTarget[];
}

/** Fields a later AgentInstance can fill. v0 selects the primary and does not execute fallback. */
export interface ResolvedModelPolicy extends ModelPolicy {
  requested?: ModelTarget;
  selected?: ModelTarget;
  fallbackIndex?: number;
  fallbackReason?: FallbackReason;
  diagnostic?: string;
}

export interface RoleDefinition {
  id: string;
  name: string;
  description: string;
  instructionsPath: string;
  instructions: string;
  skills: readonly string[];
  principles: readonly string[];
  modelPolicy: string;
}

export interface ResolvedRole {
  id: string;
  name: string;
  description: string;
  instructionsPath: string;
  instructions: string;
  skills: readonly string[];
  principles: readonly string[];
  modelPolicyId: string;
  modelPolicy: ResolvedModelPolicy;
}

export interface PitakoConfig {
  defaultsPath: string;
  userConfigPath: string;
  userConfigPresent: boolean;
  roles: Readonly<Record<string, RoleDefinition>>;
  policies: Readonly<Record<string, ModelPolicy>>;
  watchdog: WatchdogConfig;
}

/** Fields Pi's `getSupportedThinkingLevels` reads. Not a second model registry. */
export interface ModelCapability {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ReasoningLevel, string | null>>;
}

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value) || value in PI_THINKING;
}
