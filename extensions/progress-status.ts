import type { ExecuteTodoSnapshot } from "./execute-todo-projection.ts";

const OUTCOMES: Record<string, string> = { complete: "completo", blocked: "bloqueado", gaps: "con huecos" };
const EXECUTE_PHASES: Record<string, string> = { plan: "plan", review: "review final", compliance: "compliance" };
const ARCHITECTURE_PHASES: Record<string, string> = {
  "architecture-perspective": "perspectivas", "architecture-doubts": "dudas",
  "architecture-factual": "contexto", "architecture-evaluate": "evaluación",
};

/** One glanceable line; the TODO list and subagent views carry the detail. */
export function executeProgress(snapshot: ExecuteTodoSnapshot): string {
  const parts = [`execute · loop ${snapshot.loop}/${snapshot.maxLoops}`];
  if (snapshot.outcome) return [...parts, OUTCOMES[snapshot.outcome] ?? snapshot.outcome].join(" · ");
  if (snapshot.halted) return [...parts, "detenido"].join(" · ");
  const counted = snapshot.tasks.filter(task => task.status !== "cancelled");
  if (counted.length) parts.push(`tareas ${counted.filter(task => task.status === "completed").length}/${counted.length}`);
  const phase = snapshot.phases.find(row => row.status === "in_progress");
  if (snapshot.active) parts.push(`${snapshot.active.taskId}${snapshot.active.attempt > 1 ? ` (intento ${snapshot.active.attempt})` : ""}`);
  else if (phase) parts.push(EXECUTE_PHASES[phase.name] ?? phase.name);
  return parts.join(" · ");
}

type WorkflowStep = { status?: unknown; phase?: unknown; label?: unknown };

/** Progress of a live Pitako review or architecture workflow from its pi-subagents status file. */
export function workflowProgress(run: { state?: unknown; workflow?: { resource?: { name?: unknown } }; steps?: unknown }): string | undefined {
  const steps: WorkflowStep[] = Array.isArray(run.steps) ? run.steps.filter(step => step && typeof step === "object") : [];
  const latest = (match: (step: WorkflowStep) => boolean) => [...steps].reverse().find(match);
  const name = run.workflow?.resource?.name;
  if (name === "pitako.review") {
    const phase = (latest(step => step.status === "running" && typeof step.phase === "string")
      ?? latest(step => typeof step.phase === "string"))?.phase;
    if (phase === "review-synthesis") return "review · síntesis";
    const angles = steps.filter(step => step.phase === "review-independent");
    if (!angles.length) return "review · preparando";
    return `review · ángulos ${angles.filter(step => step.status === "completed").length}/${angles.length}`;
  }
  if (name === "pitako.architecture") {
    const step = latest(step => typeof step.phase === "string" && step.phase.startsWith("architecture-"));
    const round = typeof step?.label === "string" ? /^Round (\d+)/.exec(step.label)?.[1] : undefined;
    if (!step || !round) return "architecture";
    return `architecture · ronda ${round} · ${ARCHITECTURE_PHASES[String(step.phase)] ?? String(step.phase).slice(13)}`;
  }
  return undefined;
}

/** T3 joins extension statuses with " · ", so separate runs differently and cap the width. */
export function progressStatusLine(items: readonly string[]): string | undefined {
  if (!items.length) return undefined;
  const shown = items.slice(0, 2).join(" | ");
  return items.length > 2 ? `${shown} | +${items.length - 2}` : shown;
}
