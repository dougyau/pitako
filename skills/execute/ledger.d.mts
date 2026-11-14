type Candidate = { head?: string; fingerprint?: string };
type LoopBody = {
  observation?: { checkout?: Candidate };
  candidate?: Candidate;
  review?: { verdict?: string; reason?: unknown; unresolved?: unknown };
  compliance?: { status?: string; reason?: unknown; unresolved?: unknown; candidate?: Candidate };
  results?: {
    taskId?: string;
    remaining?: unknown;
    diagnosis?: unknown;
    checks?: { current?: unknown };
  }[];
  plan?: { rejection?: { diagnostic?: unknown } };
};

export function summarizeLoops(records: readonly {
  kind: string;
  loop: number;
  body: LoopBody;
}[]): {
  loop: number;
  status: "complete" | "gaps";
  gaps: string;
  review: string;
  compliance: string;
  rejection: string;
}[];
