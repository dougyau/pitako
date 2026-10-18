/** In-memory resource-owner proof. Never reconstruct this from a result or a PID. */
export interface ClosureObservation {
  observe(): "closed" | "unknown";
}

/** A terminal outcome cannot release ownership when physical closure is uncertain. */
export class AgentClosureError extends AggregateError {
  constructor(errors: unknown[], context: string, readonly observation?: ClosureObservation) {
    super(errors, `${context}: closure unknown (${errors.map(String).join("; ")})`);
    this.name = "AgentClosureError";
  }
}

export function hasUnknownClosure(error: unknown): boolean {
  return error instanceof AgentClosureError || error instanceof AggregateError && error.errors.some(hasUnknownClosure);
}

/** Only explicit owner capabilities cross our aggregation boundaries. */
export function joinedClosureObservation(errors: readonly unknown[]): ClosureObservation | undefined {
  const observations: ClosureObservation[] = [];
  for (const error of errors.filter(hasUnknownClosure)) {
    if (!(error instanceof AgentClosureError) || !error.observation) return;
    observations.push(error.observation);
  }
  if (observations.length) return { observe: () =>
    observations.every(observation => observation.observe() === "closed") ? "closed" : "unknown" };
}

export type AgentClosure =
  | { state: "pending" }
  | { state: "released" }
  | { state: "unknown"; reason: string };
