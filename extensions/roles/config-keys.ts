/** Shared with validation and the startup completion catalog. */
export const CONFIG_KEYS = {
  root: new Set(["roles", "model_policies", "agent_runtime", "worker_history", "developer_routing", "head_developer", "architecture", "review"]),
  role: new Set(["name", "description", "instructions", "model_policy", "skills", "principles"]),
  policy: new Set(["primary", "fallbacks"]),
  target: new Set(["model", "reasoning", "fast"]),
  candidate: new Set(["model", "reasoning"]),
  candidates: new Set(["candidates", "topics"]),
  topic: new Set(["topic", "candidates"]),
  agent_runtime: new Set(["idle_timeout", "tool_stall_timeout", "max_run_time"]),
  worker_history: new Set(["ttl_days"]),
  developer_routing: new Set(["classifier_provider", "classifier_model"]),
  head_developer: new Set(["max_parallel"]),
};
