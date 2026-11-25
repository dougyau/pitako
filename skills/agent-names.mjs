// Node view of the sandbox prelude's agent names, so both sides share one table.
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./workflow-canonical.js", import.meta.url), "utf8");
export const { PITAKO_REVIEWER_AGENTS, PITAKO_LOOP_OPERATIONS, pitakoReviewerAgent, pitakoLoopAgent, pitakoAgentFamily } =
  new Function(`${source}
  return { PITAKO_REVIEWER_AGENTS, PITAKO_LOOP_OPERATIONS, pitakoReviewerAgent, pitakoLoopAgent, pitakoAgentFamily };`)();
