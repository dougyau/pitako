export const PITAKO_REVIEWER_AGENTS: readonly string[];
export const PITAKO_LOOP_OPERATIONS: readonly string[];
export function pitakoReviewerAgent(key: unknown): string | undefined;
export function pitakoLoopAgent(operation: string): string;
export function pitakoAgentFamily(agent: unknown): string | undefined;
