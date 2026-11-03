/**
 * todo tool + /todos command — thin registration shell.
 *
 * Tool/command identity, schema, types, reducer, store, replay, response
 * envelope, selectors, and view formatters live in the layered modules under
 * `tool/`, `state/`, and `view/`. This file is the package-root registration
 * surface — it mirrors `packages/rpiv-ask-user-question/ask-user-question.ts`
 * which keeps the tool registration at the package root.
 *
 * Public re-exports below preserve the package-root import surface so that
 * `index.ts`, `todo-overlay.ts`, and the global `test/setup.ts` `beforeEach`
 * continue to import from `./todo.js`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, validateGuidanceFields } from "./config.ts";
import { formatStatusLabel, t } from "./state/i18n-bridge.ts";
import { selectTaskParent, selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./state/selectors.ts";
import { createTodoCommit, type TodoCommit } from "./state/commit.ts";
import { getRenderState, getState, sid } from "./state/store.ts";
import { prepareTodoArguments } from "./tool/normalize-params.ts";
import { buildToolResult } from "./tool/response-envelope.ts";
import {
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	MSG_NO_TODOS,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types.ts";
import { STATUS_GLYPH, formatCommandTaskLine, renderTodoCall, renderTodoResult } from "./view/format.ts";

// English fallbacks for localized /todos section headers — the box-drawing
// decoration is part of the localized string so translators can adjust spacing.
const SECTION_PENDING = "── Pending ──";
const SECTION_IN_PROGRESS = "── In Progress ──";
const SECTION_COMPLETED = "── Completed ──";

// ---------------------------------------------------------------------------
// Public re-exports — existing consumers (overlay, tests, index.ts) keep
// importing from `./todo.js`. New code may opt into deeper imports.
// ---------------------------------------------------------------------------

export { isTransitionValid } from "./state/invariants.ts";
export { applyTaskMutation } from "./state/state-reducer.ts";
export { __resetState, getNextId, getTodos, setActiveRenderSession, sid } from "./state/store.ts";
export { deriveBlocks, detectCycle } from "./state/task-graph.ts";
export type { Task, TaskAction, TaskDetails, TaskStatus } from "./tool/types.ts";
export { TOOL_NAME } from "./tool/types.ts";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. At most one in_progress task per owner.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Task status: pending → in_progress → completed, plus cancelled and deleted. completed rows are read-only except delete; cancelled and deleted are terminal. Use cancel (optional short reason) to abandon a task. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	"Only a task's owner may update it. Others may only cancel or delete it, and not when metadata.protected is true; with metadata.cancel set to \"request\", their cancel only records a cancellation request.",
	'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"To create several independent tasks at once, pass create with tasks: [{subject}, ...]. Do not also pass subject. tasks[] cannot blockedBy each other (ids do not exist until the call commits); create the prerequisite first, then the dependent with blockedBy. Dependency chains stay single-create.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

export function registerTodoTool(pi: ExtensionAPI, commit: TodoCommit = createTodoCommit(pi)): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task, or several independent tasks at once via tasks[]), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), cancel (abandon a task), delete (tombstone), clear (remove your own tasks). Status: pending → in_progress → completed, plus terminal cancelled and deleted. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		// Undo a double-encoded tasks[] before Pi validates it (#244 shape).
		prepareArguments: prepareTodoArguments,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = commit(sid(ctx), undefined, [{ action: params.action, params }]);
			if (!result.op) throw new Error("todo commit returned no operation");
			return buildToolResult(params.action, params, result.state, result.op);
		},

		// renderCall reflects the FOREGROUND slot, not the calling session's. Pi's
		// `ToolRenderContext` carries no session identity (no sessionManager/sessionId),
		// so this ctx-less hook cannot re-key by caller. For the foreground session's
		// own transcript that is exactly right. A detached/child call rendered in the
		// lane-transcript viewer whose task lives only in the child's slot misses the
		// foreground lookup and falls back to `#<id>` (see renderTodoCall). That is the
		// safe outcome: per-session ids restart at 1, so searching sibling slots could
		// surface the WRONG subject — the `#<id>` fallback is intentional, not a gap.
		renderCall(args, theme, _context) {
			return renderTodoCall(args as never, theme, getRenderState());
		},

		renderResult(result, _opts, theme, context) {
			return renderTodoResult(result, theme, context?.isError);
		},
	});
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

export function registerTodosCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show all todos on the current branch, grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE), "error");
				return;
			}
			const state = getState(sid(ctx));
			const visible = selectVisibleTasks(state);
			if (visible.length === 0) {
				ctx.ui.notify(t("command.no_todos", MSG_NO_TODOS), "info");
				return;
			}
			// Group roots by status, keeping children directly under their parent.
			const groups = selectTasksByStatus({ ...state, tasks: visible.filter((task) => !selectTaskParent(state, task)) });
			const appendTask = (task: (typeof visible)[number]) => {
				lines.push(formatCommandTaskLine(task, task.status === "completed" ? "✓" : STATUS_GLYPH[task.status]));
				for (const child of visible.filter((child) => task.parentId === undefined && child.parentId === task.id)) {
					lines.push(formatCommandTaskLine(child, child.status === "completed" ? "✓" : STATUS_GLYPH[child.status], true));
				}
			};
			const counts = selectTodoCounts(state);

			const header: string[] = [];
			if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
			if (counts.inProgress > 0) header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			if (counts.pending > 0) header.push(`${counts.pending} ${formatStatusLabel("pending")}`);

			const lines: string[] = [header.join(" · ")];
			if (groups.pending.length > 0) {
				lines.push(t("command.section.pending", SECTION_PENDING));
				for (const task of groups.pending) appendTask(task);
			}
			if (groups.inProgress.length > 0) {
				lines.push(t("command.section.in_progress", SECTION_IN_PROGRESS));
				for (const task of groups.inProgress) appendTask(task);
			}
			if (groups.completed.length > 0) {
				lines.push(t("command.section.completed", SECTION_COMPLETED));
				for (const task of groups.completed) appendTask(task);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
