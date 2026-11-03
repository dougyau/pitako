import { isolateTodoConfig } from "./test-isolation.ts";
isolateTodoConfig();
/**
 * Codemode replay regression (#290) — REAL Pi sessions, no mocks.
 *
 * A `todo` call made from a codemode script goes through `ctx.executeTool()`:
 * Pi records it only as a bounded `nestedCalls` summary on the outer `codemode`
 * result, never as a standalone `toolResult`, so its `details` snapshot is not on
 * the branch. Each test drives a scripted (faux) model through a real
 * `AgentSession` with Pi's built-in codemode extension and rpiv-todo's entry,
 * persists the session to disk, reopens it (what `pi -c` / `/resume` do —
 * `session_start` replays the branch), and reads the restored list with a
 * direct `todo list`. The entry goes in as a factory, not a path: a path loads
 * a second copy outside Vitest, whose coverage merges badly with this one.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import todo from "./index.ts";
import { isTaskDetails } from "./state/replay.ts";

describe("todo calls made through codemode survive session replay (#290)", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let sessionDir: string;
	let prevOffline: string | undefined;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
	let runtime: ModelRuntime;

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "rpiv-todo-codemode-"));
		agentDir = join(home, "agent");
		cwd = join(home, "cwd");
		sessionDir = join(home, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), "{}");
		// The issue's setting: the model reaches `todo` only through codemode scripts.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
		);
		prevOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		runtime.registerNativeProvider(faux.provider);
	});

	afterEach(() => {
		if (prevOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = prevOffline;
		rmSync(home, { recursive: true, force: true });
	});

	async function openSession(sessionManager: SessionManager): Promise<AgentSession> {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				{ name: "codemode", factory: createCodemodeExtension() },
				{ name: "rpiv-todo", factory: (pi) => todo(pi) },
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			resourceLoader,
			settingsManager,
			sessionManager,
			model: faux.getModel(),
		});
		await session.bindExtensions({}); // fires session_start → rpiv-todo replays the branch
		return session;
	}

	async function closeSession(session: AgentSession): Promise<void> {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}

	const toolCall = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args));
	const codemode = (code: string) => toolCall("codemode", { code });

	/** Run each turn's scripted tool calls, close, reopen from disk, and return a direct `todo list`. */
	async function listAfterResume(turns: ReturnType<typeof toolCall>[], mutations: number): Promise<string> {
		const first = await openSession(SessionManager.create(cwd, sessionDir));
		for (const step of turns) {
			faux.setResponses([step, fauxAssistantMessage("done")]);
			await first.prompt("go");
		}
		const branch = first.sessionManager.getBranch();
		const file = first.sessionFile;
		await closeSession(first);
		const snapshots = branch.filter(e => e.type === "custom" && e.customType === "pitako-todo-state");
		expect(snapshots).toHaveLength(mutations);
		expect(branch.some(e => e.type === "custom" && e.customType === "rpiv-todo-state")).toBe(false);
		for (const entry of snapshots) {
			if (entry.type !== "custom") throw new Error("not a custom entry");
			expect(entry.data).toMatchObject({version:1});
			expect(isTaskDetails(entry.data)).toBe(true);
		}
		for (let i=0; i<branch.length; i++) {
			const entry = branch[i];
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") continue;
			const details = entry.message.details;
			if (!isTaskDetails(details)) throw new Error("missing todo details");
			expect(branch.slice(0,i).some(prior => prior.type === "custom" && prior.customType === "pitako-todo-state" &&
				isTaskDetails(prior.data) && JSON.stringify(prior.data.tasks) === JSON.stringify(details.tasks) && prior.data.nextId === details.nextId)).toBe(true);
		}
		if (!file) throw new Error("session was not persisted");

		const resumed = await openSession(SessionManager.open(file, sessionDir));
		try {
			faux.setResponses([toolCall("todo", { action: "list" }), fauxAssistantMessage("ok")]);
			await resumed.prompt("list");
			const listed = resumed.sessionManager
				.getBranch()
				.filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "todo")
				.at(-1);
			if (listed?.type !== "message" || listed.message.role !== "toolResult") return "<no todo result>";
			return listed.message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		} finally {
			await closeSession(resumed);
		}
	}

	it("restores tasks created and updated only through codemode", async () => {
		const listed = await listAfterResume([
			codemode(`
await tools.todo({ action: "create", subject: "Task A" });
await tools.todo({ action: "create", subject: "Task B" });
await tools.todo({ action: "create", subject: "Task C" });
await tools.todo({ action: "update", id: 1, status: "in_progress" });
text("ok");`),
		], 4);
		expect(listed).toBe("[in_progress] #1 Task A\n[pending] #2 Task B\n[pending] #3 Task C");
	});

	it("keeps a completion made through codemode after direct create + in_progress calls", async () => {
		const listed = await listAfterResume([
			toolCall("todo", { action: "create", subject: "Completion persistence test" }),
			toolCall("todo", { action: "update", id: 1, status: "in_progress" }),
			codemode(`text(await tools.todo({ action: "update", id: 1, status: "completed" }));`),
		], 3);
		expect(listed).toBe("[completed] #1 Completion persistence test");
	});
});
