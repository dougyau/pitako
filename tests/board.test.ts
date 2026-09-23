import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import board from "../extensions/board/index.ts";
import { getBoardDbPath, getPiAgentDir, getPitakoDataDir } from "../extensions/board/paths.ts";
import { openSqlite } from "../extensions/board/sqlite.ts";
import {
  BOARD_AUTHOR,
  BOARD_SCOPE,
  LIMITS,
  POST_TYPES,
  SCHEMA_VERSION,
  openBoard,
} from "../extensions/board/store.ts";
import { currentWorkspace } from "../extensions/board/workspace.ts";
import { ledgerFile, planFile, readPlan } from "../extensions/workflow.ts";
import { registerExecution, unregisterExecution } from "../extensions/execution-identity.ts";
import { recordPlanTeamWork } from "../extensions/team.ts";
import { packageRoot } from "../extensions/stack.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function gitRepo(): string {
  const dir = tempDir("pitako-board-repo-");
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("board paths", () => {
  test("default path is ~/.pi/agent/pitako/board.db and does not create it", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(getPiAgentDir(env)).toBe(path.join(homedir(), ".pi", "agent"));
    expect(getPitakoDataDir(env)).toBe(path.join(homedir(), ".pi", "agent", "pitako"));
    expect(getBoardDbPath(env)).toBe(path.join(homedir(), ".pi", "agent", "pitako", "board.db"));
    expect(getBoardDbPath(env)).not.toContain(tmpdir());
  });

  test("PI_CODING_AGENT_DIR wins, including relative and tilde paths", () => {
    const agent = tempDir("pitako-board-agent-");
    expect(getBoardDbPath({ PI_CODING_AGENT_DIR: agent })).toBe(path.join(agent, "pitako", "board.db"));

    const cwd = tempDir("pitako-board-cwd-");
    const relative = getPiAgentDir({ PI_CODING_AGENT_DIR: "agent-dir" }, cwd);
    expect(path.isAbsolute(relative)).toBe(true);
    expect(relative).toBe(path.join(cwd, "agent-dir"));

    const tilde = getPiAgentDir({ PI_CODING_AGENT_DIR: "~/pitako-board-tilde" });
    expect(tilde).toBe(path.join(homedir(), "pitako-board-tilde"));
  });
});

describe("workspace", () => {
  test("uses the git root, including from a subdirectory, and isolates other directories", () => {
    const repo = gitRepo();
    const nested = path.join(repo, "src");
    mkdirSync(nested);
    const other = gitRepo();
    const loose = tempDir("pitako-board-loose-");
    expect(currentWorkspace(nested)).toBe(currentWorkspace(repo));
    expect(currentWorkspace(repo)).not.toBe(currentWorkspace(other));
    expect(currentWorkspace(loose)).toBe(loose);

    const link = path.join(tempDir("pitako-board-link-"), "repo");
    symlinkSync(repo, link);
    expect(currentWorkspace(link)).toBe(currentWorkspace(repo));
  });
});

describe("board store", () => {
  test("initializes schema v2, migrates v1 data, and refuses incomplete schemas", async () => {
    const file = path.join(tempDir("pitako-board-db-"), "board.db");
    const boardDb = await openBoard(file);
    const other = await openSqlite(file);
    expect(other.prepare("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
    expect(other.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(other.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(other.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    boardDb.createTopic("/repo-a", { title: "persistence" });
    try {
      other.prepare("INSERT INTO posts (topic_id, author, type, content, created_at) VALUES (999, 'pi', 'INFO', 'nope', 't')").run();
      throw new Error("foreign key insert should have failed");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toMatch(/FOREIGN KEY/i);
    }
    other.close();
    boardDb.close();

    const kept = path.join(tempDir("pitako-board-keep-"), "board.db");
    const raw = await openSqlite(kept);
    raw.exec("CREATE TABLE topics (id INTEGER PRIMARY KEY, note TEXT)");
    raw.exec("INSERT INTO topics (note) VALUES ('keep')");
    raw.exec("PRAGMA user_version = 2");
    raw.close();
    await expect(openBoard(kept)).rejects.toThrow(/initialization failed/);
    await expect(openBoard(kept)).rejects.toThrow(/incomplete/);
    const still = await openSqlite(kept);
    expect(still.prepare("SELECT note FROM topics").get()?.note).toBe("keep");
    still.close();

    const corrupt = path.join(tempDir("pitako-board-corrupt-"), "board.db");
    writeFileSync(corrupt, "not sqlite");
    await expect(openBoard(corrupt)).rejects.toThrow(/initialization failed/);
    expect(readFileSync(corrupt, "utf8")).toBe("not sqlite");
  });

  test("migrates v1 rows and serializes competing claims", async () => {
    const file = path.join(tempDir("pitako-board-migrate-"), "board.db");
    const initial = await openBoard(file);
    const topic = initial.createTopic("/repo", { title: "legacy" });
    initial.post("/repo", { topicId: topic.id, type: "FINDING", content: "kept" });
    initial.close();
    const raw = await openSqlite(file);
    raw.exec("DROP INDEX topics_workspace_owner_plan");
    raw.exec("ALTER TABLE topics DROP COLUMN owner_plan_id");
    raw.exec("PRAGMA user_version = 1");
    raw.close();

    const left = await openBoard(file);
    const right = await openBoard(file);
    const migrated = left.readTopic("/repo", topic.id);
    expect(migrated.posts.map((post) => post.content)).toEqual(["kept"]);
    expect(migrated.topic.ownerPlanId).toBeNull();
    const results = await Promise.allSettled([Promise.resolve().then(() => left.claimTopic("/repo", topic.id, "plan-a")), Promise.resolve().then(() => right.claimTopic("/repo", topic.id, "plan-b"))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(["plan-a", "plan-b"]).toContain(left.readTopic("/repo", topic.id).topic.ownerPlanId ?? "");
    const owner = left.readTopic("/repo", topic.id).topic.ownerPlanId;
    const other = owner === "plan-a" ? "plan-b" : "plan-a";
    expect(() => left.claimTopic("/repo", topic.id, other)).toThrow(/already owned/);
    expect(() => left.claimTopic("/repo", topic.id, owner!)).not.toThrow();
    expect(() => left.claimTopic("/elsewhere", topic.id, owner!)).toThrow(/another workspace/);
    expect(() => left.claimTopic("/repo", 0, owner!)).toThrow(/positive integer/);
    const closed = left.createTopic("/repo", { title: "closed legacy" });
    left.updateTopic("/repo", closed.id, { status: "closed" });
    expect(() => left.claimTopic("/repo", closed.id, owner!)).toThrow(/must be open/);
    expect(() => left.claimTopic("/repo", left.createTopic("/repo", { title: "another" }).id, owner!)).toThrow();
    expect(() => left.updateTopic("/repo", topic.id, { status: "resolved" })).toThrow(/owned by plan/);
    expect(() => left.transitionOwnedTopic("/repo", topic.id, other, "resolved")).toThrow(/not owned/);
    expect(left.transitionOwnedTopic("/repo", topic.id, owner!, "resolved").status).toBe("resolved");
    expect(left.transitionOwnedTopic("/repo", topic.id, owner!, "resolved").status).toBe("resolved");
    expect(() => left.transitionOwnedTopic("/repo", topic.id, owner!, "closed")).not.toThrow();
    expect(() => left.transitionOwnedTopic("/repo", topic.id, owner!, "resolved")).toThrow(/cannot transition closed/);
    left.close();
    right.close();
  });

  test("isolates workspaces, pages posts, and round-trips every post type", async () => {
    const file = path.join(tempDir("pitako-board-work-"), "board.db");
    const db = await openBoard(file);
    const topic = db.createTopic("/repo-a", { title: "Board persistence", description: "where the file lives" });
    expect(topic).toMatchObject({ title: "Board persistence", status: "open", scope: BOARD_SCOPE, createdBy: BOARD_AUTHOR });
    db.createTopic("/repo-b", { title: "other repo" });

    const listed = db.listTopics("/repo-a");
    expect(listed.topics.map((item) => item.title)).toEqual(["Board persistence"]);
    expect(db.listTopics("/repo-b").topics.map((item) => item.title)).toEqual(["other repo"]);
    expect(() => db.readTopic("/repo-b", topic.id)).toThrow(/another workspace/);
    expect(() => db.post("/repo-a", { topicId: 999, type: "INFO", content: "missing" })).toThrow(/unknown topic/);
    expect(() => db.post("/repo-a", { topicId: topic.id, type: "HYPOTHESIS", content: "no" })).toThrow(/invalid post type/);

    const posts = POST_TYPES.map((type) =>
      db.post("/repo-a", {
        topicId: topic.id,
        type,
        subject: type === "DECISION" ? "store under the agent dir" : undefined,
        content: `${type} body`,
        metadata: type === "DECISION" ? { supersedes: 17, note: "later" } : undefined,
      }),
    );
    expect(posts.map((post) => post.type)).toEqual([...POST_TYPES]);
    const decision = posts.find((post) => post.type === "DECISION");
    if (!decision) throw new Error("missing decision");
    expect(decision.metadata).toEqual({ supersedes: 17, note: "later" });
    expect(decision.author).toBe(BOARD_AUTHOR);

    const question = posts.find((post) => post.type === "QUESTION");
    if (!question) throw new Error("missing question");
    const answer = db.post("/repo-a", {
      topicId: topic.id,
      type: "ANSWER",
      content: "yes",
      replyTo: question.id,
    });
    expect(answer.replyTo).toBe(question.id);
    const other = db.createTopic("/repo-a", { title: "second" });
    expect(() => db.post("/repo-a", { topicId: other.id, type: "INFO", content: "cross", replyTo: question.id })).toThrow(
      /references another topic/,
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => db.post("/repo-a", { topicId: topic.id, type: "INFO", content: "bad meta", metadata: cycle })).toThrow(
      /malformed metadata/,
    );

    const page = db.readTopic("/repo-a", topic.id);
    expect(page.posts.map((post) => post.id)).toEqual([...posts.map((post) => post.id), answer.id]);
    expect(page.posts.find((post) => post.id === answer.id)?.replyTo).toBe(question.id);
    expect(page.topic.description).toBe("where the file lives");

    const resolved = db.updateTopic("/repo-a", topic.id, { status: "resolved", title: "Board persistence decided" });
    expect(resolved.status).toBe("resolved");
    expect(db.listTopics("/repo-a").topics.map((item) => item.title)).toEqual(["second"]);
    expect(db.listTopics("/repo-a", { status: "resolved" }).topics.map((item) => item.title)).toEqual([
      "Board persistence decided",
    ]);

    const decisions = db.query("/repo-a", { type: "DECISION", text: "agent dir", author: BOARD_AUTHOR });
    expect(decisions.posts.map((post) => post.id)).toEqual([decision.id]);
    expect(db.query("/repo-a", { text: "yes" }).posts.map((post) => post.id)).toEqual([answer.id]);
    expect(db.query("/repo-a", { author: "someone-else" }).posts).toEqual([]);
    expect(() => db.query("/repo-b", { topicId: topic.id })).toThrow(/another workspace/);
    db.close();

    const reopened = await openBoard(file);
    expect(reopened.readTopic("/repo-a", topic.id).topic.status).toBe("resolved");
    expect(reopened.readTopic("/repo-a", topic.id).posts.find((post) => post.id === decision.id)?.metadata).toEqual({
      supersedes: 17,
      note: "later",
    });
    reopened.close();
  });

  test("bounds list, read, and query results and pages a long topic", async () => {
    expect(LIMITS).toEqual({ listDefault: 20, listMax: 50, readDefault: 40, readMax: 100, queryDefault: 20, queryMax: 50 });
    const db = await openBoard(path.join(tempDir("pitako-board-page-"), "board.db"));
    for (let index = 0; index < LIMITS.listDefault + 1; index += 1) {
      db.createTopic("/repo", { title: `topic ${index}` });
    }
    const listed = db.listTopics("/repo");
    expect(listed.topics).toHaveLength(LIMITS.listDefault);
    expect(listed.total).toBe(LIMITS.listDefault + 1);
    const capped = db.listTopics("/repo", { limit: LIMITS.listMax + 10 });
    expect(capped.topics).toHaveLength(LIMITS.listDefault + 1);
    expect(capped.capped).toBe(true);
    for (let index = listed.total; index < LIMITS.listMax + 1; index += 1) {
      db.createTopic("/repo", { title: `extra ${index}` });
    }
    const maxed = db.listTopics("/repo", { limit: 1000 });
    expect(maxed.topics).toHaveLength(LIMITS.listMax);
    expect(maxed.capped).toBe(true);
    expect(maxed.total).toBe(LIMITS.listMax + 1);

    const topic = db.createTopic("/repo", { title: "long" });
    const count = LIMITS.readDefault + 5;
    for (let index = 0; index < count; index += 1) {
      db.post("/repo", { topicId: topic.id, type: "INFO", content: `note ${index}` });
    }
    const latest = db.readTopic("/repo", topic.id);
    expect(latest.posts).toHaveLength(LIMITS.readDefault);
    expect(latest.posts[0]?.content).toBe("note 5");
    expect(latest.posts.at(-1)?.content).toBe(`note ${count - 1}`);
    expect(latest.hasOlder).toBe(true);
    expect(latest.hasNewer).toBe(false);
    const older = db.readTopic("/repo", topic.id, { beforePostId: latest.posts[0]?.id });
    expect(older.posts.map((post) => post.content)).toEqual(["note 0", "note 1", "note 2", "note 3", "note 4"]);
    expect(older.hasNewer).toBe(true);
    const forward = db.readTopic("/repo", topic.id, { afterPostId: older.posts.at(-1)?.id, limit: 2 });
    expect(forward.posts.map((post) => post.content)).toEqual(["note 5", "note 6"]);
    expect(() => db.readTopic("/repo", topic.id, { beforePostId: 1, afterPostId: 2 })).toThrow(/not both/);

    for (let index = 0; index < LIMITS.queryMax + 1; index += 1) {
      db.post("/repo", { topicId: topic.id, type: "FINDING", content: `hit ${index}` });
    }
    const found = db.query("/repo", { type: "FINDING", text: "hit", limit: 1000 });
    expect(found.posts).toHaveLength(LIMITS.queryMax);
    expect(found.capped).toBe(true);
    expect(found.total).toBe(LIMITS.queryMax + 1);
    db.close();
  });

  test("two connections can write and a new process can read the same file", async () => {
    const file = path.join(tempDir("pitako-board-concurrent-"), "board.db");
    const left = await openBoard(file);
    const right = await openBoard(file);
    const topic = left.createTopic("/repo", { title: "shared" });
    right.post("/repo", { topicId: topic.id, type: "FINDING", content: "from the other connection" });
    left.post("/repo", { topicId: topic.id, type: "INFO", content: "from the first connection" });
    expect(left.readTopic("/repo", topic.id).posts).toHaveLength(2);
    expect(right.readTopic("/repo", topic.id).posts).toHaveLength(2);
    left.close();
    right.close();

    const raw = await openSqlite(file);
    raw.exec("INSERT INTO topics (workspace, scope, title, status, created_by, created_at, updated_at) VALUES ('/repo', 'global', 'trigger-a', 'open', 'pi', 't', 't')");
    raw.exec("INSERT INTO topics (workspace, scope, title, status, created_by, created_at, updated_at) VALUES ('/repo', 'global', 'trigger-b', 'open', 'pi', 't', 't')");
    const first = raw.prepare("SELECT id FROM topics WHERE title = 'trigger-a'").get();
    const second = raw.prepare("SELECT id FROM topics WHERE title = 'trigger-b'").get();
    raw.prepare("INSERT INTO posts (topic_id, author, type, content, created_at) VALUES (?, 'pi', 'INFO', 'origin', 't')").run(first?.id);
    const origin = raw.prepare("SELECT id FROM posts WHERE content = 'origin'").get();
    expect(() =>
      raw
        .prepare("INSERT INTO posts (topic_id, author, type, content, reply_to, created_at) VALUES (?, 'pi', 'INFO', 'cross', ?, 't')")
        .run(second?.id, origin?.id),
    ).toThrow(/reply references another topic/);
    raw.close();

    const script = `
      import { openBoard } from ${JSON.stringify(path.join(packageRoot(), "extensions/board/store.ts"))};
      const board = await openBoard(process.env.BOARD_DB);
      const page = board.readTopic("/repo", ${topic.id});
      console.log(JSON.stringify(page.posts.map((post) => post.content)));
      board.close();
    `;
    const child = execFileSync("bun", ["-e", script], {
      env: { ...process.env, BOARD_DB: file },
      encoding: "utf8",
    });
    expect(JSON.parse(child)).toEqual(["from the other connection", "from the first connection"]);
  });
});

interface ToolResult {
  content?: Array<{ type?: string; text?: string }>;
  details?: { error?: string; topicId?: number; postId?: number; status?: string; noTopic?: boolean };
  isError?: boolean;
}

interface ToolRunner {
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string; sessionManager?: { getSessionId: () => string } },
  ): Promise<ToolResult>;
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .map((part) => part.text ?? "")
    .join("\n");
}

function registeredBoard(): {
  tools: Map<string, ToolRunner>;
  guidance: Map<string, { description?: string; promptGuidelines?: string[] }>;
  command: (args: string, ctx: { cwd: string; hasUI: boolean; ui: { notify(message: string, kind?: string): void } }) => Promise<void>;
  events: string[];
} {
  const tools = new Map<string, ToolRunner>();
  const guidance = new Map<string, { description?: string; promptGuidelines?: string[] }>();
  let command: (args: string, ctx: { cwd: string; hasUI: boolean; ui: { notify(message: string, kind?: string): void } }) => Promise<void> =
    async () => {
      throw new Error("/board was not registered");
    };
  const events: string[] = [];
  const pi = {
    on(event: string) {
      events.push(event);
    },
    registerTool(definition: { name: string; execute: ToolRunner["execute"]; description?: string; promptGuidelines?: string[] }) {
      tools.set(definition.name, definition);
      guidance.set(definition.name, definition);
    },
    registerCommand(_name: string, spec: { handler: typeof command }) {
      command = spec.handler;
    },
  };
  board(pi as unknown as ExtensionAPI);
  return { tools, guidance, command, events };
}

describe("board tools", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let agentDir = "";

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  test("workflow claim and lifecycle require exact plan binding and foreground ownership", async () => {
    const agentDir = tempDir("pitako-board-workflow-tools-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const repo = gitRepo();
    const plan = planFile("workflow-plan", repo);
    mkdirSync(path.dirname(plan), { recursive: true });
    writeFileSync(plan, "---\nid: workflow-plan\nrevision: 1\nstatus: draft\nexecution: none\n---\n\nPlan.\n");
    const { tools } = registeredBoard();
    const create = tools.get("board_topic_create");
    const claim = tools.get("board_workflow_claim");
    const lifecycle = tools.get("board_workflow_lifecycle");
    const update = tools.get("board_topic_update");
    const read = tools.get("board_topic_read");
    if (!create || !claim || !lifecycle || !update || !read) throw new Error("missing workflow Board tool");
    await create.execute("c", { title: "owned" }, undefined, undefined, { cwd: repo });
    registerExecution({ instanceId: "child", roleId: "developer", sessionId: "registered-child" });
    try {
      const childClaim = await claim.execute("child", { planId: "workflow-plan", topicId: 1 }, undefined, undefined, { cwd: repo, sessionManager: { getSessionId: () => "registered-child" } });
      expect(childClaim.isError).toBe(true);
    } finally { unregisterExecution("registered-child"); }
    const adopted = await claim.execute("claim", { planId: "workflow-plan", topicId: 1 }, undefined, undefined, { cwd: repo });
    expect(adopted.isError).toBeFalsy();
    expect(readFileSync(plan, "utf8")).toContain("board_topic_id: 1");
    expect((await update.execute("u", { topicId: 1, status: "resolved" }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    registerExecution({ instanceId: "registered-child", roleId: "developer", sessionId: "registered-lifecycle-child" });
    try {
      const registeredChildLifecycle = await lifecycle.execute("registered-child", { planId: "workflow-plan", status: "resolved" }, undefined, undefined, { cwd: repo, sessionManager: { getSessionId: () => "registered-lifecycle-child" } });
      expect(registeredChildLifecycle.isError).toBe(true);
    } finally { unregisterExecution("registered-lifecycle-child"); }
    const priorChildId = process.env.PITAKO_INSTANCE_ID;
    process.env.PITAKO_INSTANCE_ID = "child-id";
    try {
      expect((await lifecycle.execute("child", { planId: "workflow-plan", status: "resolved" }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    } finally {
      if (priorChildId === undefined) delete process.env.PITAKO_INSTANCE_ID;
      else process.env.PITAKO_INSTANCE_ID = priorChildId;
    }
    const otherPlan = planFile("other-plan", repo);
    writeFileSync(otherPlan, "---\nid: other-plan\nrevision: 1\nstatus: frozen\nboard_topic_id: 1\n---\n\nWrong owner.\n");
    expect((await lifecycle.execute("mismatch", { planId: "other-plan", status: "resolved" }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    const ledger = ledgerFile("workflow-plan", repo);
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, "---\nplan_id: workflow-plan\nrevision: 1\nhash: stale\nstatus: running\n---\n");
    expect((await lifecycle.execute("stale", { planId: "workflow-plan", status: "resolved" }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    const boundMeta = readPlan("workflow-plan", repo).meta;
    writeFileSync(ledger, `---\nplan_id: workflow-plan\nrevision: 1\nhash: ${boundMeta.hash}\nstatus: USER_DECISION_REQUIRED\n---\n`);
    expect((await lifecycle.execute("decision", { planId: "workflow-plan", status: "resolved" }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    const unchanged = await openBoard();
    expect(unchanged.readTopic(currentWorkspace(repo), 1).topic.status).toBe("open");
    unchanged.close();
    rmSync(ledger);
    const currentPlanMeta = readPlan("workflow-plan", repo).meta;
    writeFileSync(ledger, `---\nplan_id: workflow-plan\nrevision: 1\nhash: ${currentPlanMeta.hash}\nstatus: running\n---\n\n## Team Holds\n\n<!-- pitako-team-holds:v1 -->\n[]\n<!-- /pitako-team-holds -->\n`);
    recordPlanTeamWork(repo, "workflow-plan", "unit-a", "cancelled-without-outcome", "pending");
    expect((await lifecycle.execute("pending", { planId: "workflow-plan", status: "resolved" }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    recordPlanTeamWork(repo, "workflow-plan", "unit-a", "cancelled-without-outcome", "cancelled");
    expect((await lifecycle.execute("cancelled", { planId: "workflow-plan", status: "resolved" }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    recordPlanTeamWork(repo, "workflow-plan", "unit-b", "later-failure", "failed");
    expect((await lifecycle.execute("failed", { planId: "workflow-plan", status: "resolved" }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    recordPlanTeamWork(repo, "workflow-plan", "unit-c", "later-success", "completed");
    recordPlanTeamWork(repo, "workflow-plan", "unit-a", "cancelled-without-outcome", undefined);
    recordPlanTeamWork(repo, "workflow-plan", "unit-b", "later-failure", undefined);
    const closedTopic = await create.execute("closed", { title: "closed unowned" }, undefined, undefined, { cwd: repo });
    const closedDraft = planFile("closed-draft", repo);
    writeFileSync(closedDraft, "---\nid: closed-draft\nrevision: 1\nstatus: draft\n---\n\nClosed.\n");
    const closedDb = await openBoard();
    closedDb.updateTopic(currentWorkspace(repo), closedTopic.details?.topicId as number, { status: "closed" });
    closedDb.close();
    expect((await claim.execute("closed-claim", { planId: "closed-draft", topicId: closedTopic.details?.topicId }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    expect(readFileSync(closedDraft, "utf8")).not.toContain("board_topic_id:");
    const unowned = await create.execute("unowned", { title: "frozen unowned" }, undefined, undefined, { cwd: repo });
    const frozenUnowned = planFile("frozen-unowned", repo);
    writeFileSync(frozenUnowned, `---\nid: frozen-unowned\nrevision: 1\nstatus: frozen\nboard_topic_id: ${unowned.details?.topicId}\n---\n\nFrozen.\n`);
    expect((await claim.execute("frozen-claim", { planId: "frozen-unowned", topicId: unowned.details?.topicId }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    const stillUnowned = await openBoard();
    expect(stillUnowned.readTopic(currentWorkspace(repo), unowned.details?.topicId as number).topic.ownerPlanId).toBeNull();
    stillUnowned.close();

    const recoveredOwnerPlan = planFile("recovered-owner", repo);
    writeFileSync(recoveredOwnerPlan, "---\nid: recovered-owner\nrevision: 1\nstatus: draft\nexecution: none\n---\n\nRecovery.\n");
    const recoveryTopic = await create.execute("recovery-topic", { title: "preclaimed recovery" }, undefined, undefined, { cwd: repo });
    const recoveryTopicId = recoveryTopic.details?.topicId;
    const ownedDb = await openBoard();
    ownedDb.claimTopic(currentWorkspace(repo), recoveryTopicId!, "recovered-owner");
    ownedDb.close();
    const recovered = await claim.execute("recover", { planId: "recovered-owner", topicId: recoveryTopicId }, undefined, undefined, { cwd: repo });
    expect(recovered.isError).toBeFalsy();
    expect(readFileSync(recoveredOwnerPlan, "utf8")).toContain(`board_topic_id: ${recoveryTopicId}`);
    const ownerRead = await openBoard();
    expect(ownerRead.readTopic(currentWorkspace(repo), recoveryTopicId!).topic.ownerPlanId).toBe("recovered-owner");
    ownerRead.close();
    const duplicateTopic = await create.execute("duplicate", { title: "second owned topic" }, undefined, undefined, { cwd: repo });
    const duplicateClaim = await claim.execute("duplicate-claim", { planId: "recovered-owner", topicId: duplicateTopic.details?.topicId }, undefined, undefined, { cwd: repo });
    expect(duplicateClaim.isError).toBe(true);
    expect(readFileSync(recoveredOwnerPlan, "utf8")).toContain(`board_topic_id: ${recoveryTopicId}`);
    expect(textOf(await read.execute("read-owner", { topicId: recoveryTopicId }, undefined, undefined, { cwd: repo }))).toContain("owner plan: recovered-owner");
    const missingExecution = planFile("missing-execution", repo);
    const createdForMissing = await create.execute("c3", { title: "missing execution" }, undefined, undefined, { cwd: repo });
    const missingTopicId = createdForMissing.details?.topicId;
    writeFileSync(missingExecution, `---\nid: missing-execution\nrevision: 1\nstatus: frozen\nboard_topic_id: ${missingTopicId}\n---\n\nNo intent.\n`);
    const boundMissing = await claim.execute("claim-missing", { planId: "missing-execution", topicId: missingTopicId }, undefined, undefined, { cwd: repo });
    expect(boundMissing.isError).toBe(true);
    const missingOwner = await openBoard();
    expect(missingOwner.readTopic(currentWorkspace(repo), missingTopicId!).topic.ownerPlanId).toBeNull();
    missingOwner.close();
    expect((await lifecycle.execute("resolve-missing", { planId: "missing-execution", status: "resolved" }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    const resolving = lifecycle.execute("resolve-race", { planId: "workflow-plan", status: "resolved" }, undefined, undefined, { cwd: repo });
    recordPlanTeamWork(repo, "workflow-plan", "resolve-race", "racing-dispatch", "pending");
    const racedResolve = await resolving;
    expect(racedResolve.isError).toBe(true);
    const openAfterRace = await openBoard();
    expect(openAfterRace.readTopic(currentWorkspace(repo), 1).topic.status).toBe("open");
    openAfterRace.close();
    recordPlanTeamWork(repo, "workflow-plan", "resolve-race", "racing-dispatch", "completed");
    const resolved = await lifecycle.execute("resolve", { planId: "workflow-plan", status: "resolved" }, undefined, undefined, { cwd: repo });
    expect(resolved.details?.status).toBe("resolved");
    const abandoned = await lifecycle.execute("abandon", { planId: "workflow-plan", status: "closed" }, undefined, undefined, { cwd: repo });
    expect(abandoned.details?.status).toBe("closed");
    const noTopicRepo = gitRepo();
    const noTopicPlan = planFile("without-topic", noTopicRepo);
    mkdirSync(path.dirname(noTopicPlan), { recursive: true });
    writeFileSync(noTopicPlan, "---\nid: without-topic\nrevision: 1\nstatus: frozen\n---\n\nNo Board topic.\n");
    const emptyAgentDir = tempDir("pitako-board-no-topic-");
    process.env.PI_CODING_AGENT_DIR = emptyAgentDir;
    const noTopic = await lifecycle.execute("none", { planId: "without-topic", status: "closed" }, undefined, undefined, { cwd: noTopicRepo });
    expect(noTopic.details?.noTopic).toBe(true);
    expect(existsSync(getBoardDbPath())).toBe(false);

    process.env.PI_CODING_AGENT_DIR = agentDir;
    const expectedPlan = planFile("expected-plan", repo);
    writeFileSync(expectedPlan, "---\nid: expected-plan\nrevision: 1\nstatus: draft\nexecution: expected\n---\n\nExpected execution.\n");
    const secondTopic = await create.execute("c2", { title: "execute lifecycle" }, undefined, undefined, { cwd: repo });
    const expectedTopicId = secondTopic.details?.topicId;
    const claimed = await claim.execute("claim2", { planId: "expected-plan", topicId: expectedTopicId }, undefined, undefined, { cwd: repo });
    expect(claimed.isError).toBeFalsy();
    writeFileSync(expectedPlan, readFileSync(expectedPlan, "utf8").replace("status: draft", "status: frozen"));
    expect((await lifecycle.execute("early", { planId: "expected-plan", status: "resolved" }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    const beforeCompletion = await openBoard();
    expect(beforeCompletion.readTopic(currentWorkspace(repo), expectedTopicId!).topic.status).toBe("open");
    beforeCompletion.close();
    const expectedMeta = readPlan("expected-plan", repo).meta;
    const expectedLedger = ledgerFile("expected-plan", repo);
    mkdirSync(path.dirname(expectedLedger), { recursive: true });
    writeFileSync(expectedLedger, `---\nplan_id: expected-plan\nrevision: 1\nhash: ${expectedMeta.hash}\nstatus: completed\n---\n\n## Team Holds\n\n<!-- pitako-team-holds:v1 -->\n[]\n<!-- /pitako-team-holds -->\n`);
    const completed = await lifecycle.execute("completed", { planId: "expected-plan", status: "resolved" }, undefined, undefined, { cwd: repo });
    expect(completed.details?.status).toBe("resolved");
  });

  test("board post guidance defines every type and rejects progress logging", () => {
    const { guidance } = registeredBoard();
    const post = guidance.get("board_post");
    const text = `${post?.description ?? ""} ${(post?.promptGuidelines ?? []).join(" ")}`;
    for (const expected of [
      "FINDING for a fact or constraint",
      "DECISION for a chosen boundary",
      "QUESTION/ANSWER for cross-context coordination",
      "BLOCKER only when another context cannot correctly continue",
      "HANDOFF only for essential next-context knowledge",
      "INFO sparingly for mission context",
      "HANDOFF: T3 done, 44 tests pass",
      "Ledger and evidence own progress",
      "Board stays pull-based",
    ]) expect(text).toContain(expected);
  });

  test("tools stay pull-based and cannot see another workspace", async () => {
    agentDir = tempDir("pitako-board-tools-");
    if (!agentDir.startsWith(tmpdir())) throw new Error(`refusing to use agent dir ${agentDir}`);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const { tools, command, events } = registeredBoard();
    expect(events).toEqual([]);
    expect([...tools.keys()].sort()).toEqual([
      "board_post",
      "board_query",
      "board_topic_create",
      "board_topic_list",
      "board_topic_read",
      "board_topic_update",
      "board_workflow_claim",
      "board_workflow_lifecycle",
    ]);

    const repoA = gitRepo();
    const repoB = gitRepo();
    const create = tools.get("board_topic_create");
    const list = tools.get("board_topic_list");
    const read = tools.get("board_topic_read");
    const update = tools.get("board_topic_update");
    const post = tools.get("board_post");
    const query = tools.get("board_query");
    if (!create || !list || !read || !update || !post || !query) throw new Error("missing board tool");

    const created = await create.execute("c", { title: "Board persistence" }, undefined, undefined, { cwd: repoA });
    expect(textOf(created)).toContain("[open] Board persistence");
    expect(created.details?.topicId).toBe(1);
    const finding = await post.execute(
      "p",
      { topicId: 1, type: "FINDING", content: "Pi exposes PI_CODING_AGENT_DIR" },
      undefined,
      undefined,
      { cwd: repoA },
    );
    expect(textOf(finding)).toContain("FINDING");
    const question = await post.execute(
      "q",
      { topicId: 1, type: "QUESTION", content: "Does the file leak across repos?" },
      undefined,
      undefined,
      { cwd: repoA },
    );
    await post.execute(
      "a",
      { topicId: 1, type: "ANSWER", content: "No. Topics store the workspace.", replyTo: question.details?.postId },
      undefined,
      undefined,
      { cwd: repoA },
    );
    await post.execute(
      "d",
      { topicId: 1, type: "DECISION", subject: "path", content: "Store Board at PI_CODING_AGENT_DIR/pitako/board.db" },
      undefined,
      undefined,
      { cwd: repoA },
    );

    const hidden = await list.execute("l", {}, undefined, undefined, { cwd: repoB });
    expect(textOf(hidden)).toContain("No open topics");
    expect(textOf(hidden)).not.toContain("Board persistence");
    const denied = await read.execute("r", { topicId: 1 }, undefined, undefined, { cwd: repoB });
    expect(denied.isError).toBe(true);
    expect(denied.details?.error).toMatch(/another workspace/);

    mkdirSync(path.join(repoA, "src"));
    const visible = await read.execute("r2", { topicId: 1 }, undefined, undefined, { cwd: path.join(repoA, "src") });
    expect(textOf(visible)).toContain("FINDING");
    expect(textOf(visible)).toContain("reply to #");
    const decisions = await query.execute("s", { type: "DECISION" }, undefined, undefined, { cwd: repoA });
    expect(textOf(decisions)).toContain("Store Board at");
    expect(textOf(decisions)).not.toContain("FINDING");

    const resolved = await update.execute("u", { topicId: 1, status: "resolved" }, undefined, undefined, { cwd: repoA });
    expect(resolved.details?.status).toBe("resolved");
    const open = await list.execute("l2", {}, undefined, undefined, { cwd: repoA });
    expect(textOf(open)).toContain("No open topics");

    const notices: string[] = [];
    await command("", {
      cwd: repoA,
      hasUI: true,
      ui: {
        notify(message) {
          notices.push(message);
        },
      },
    });
    expect(notices.join("\n")).toContain("No open topics");
    notices.length = 0;
    await command("1", {
      cwd: repoA,
      hasUI: true,
      ui: {
        notify(message) {
          notices.push(message);
        },
      },
    });
    expect(notices.join("\n")).toContain("[resolved] Board persistence");
    expect(notices.join("\n")).toContain("DECISION");
  });
});

function startPi(cwd: string, agentDir: string): {
  child: ChildProcessWithoutNullStreams;
  request(command: Record<string, unknown>): Promise<unknown[]>;
  stop(): void;
} {
  const child = spawn(
    "pi",
    ["--mode", "rpc", "--no-extensions", "--approve", "--no-session", "-e", packageRoot()],
    {
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let buffer = "";
  const pending: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else pending.push(line);
    }
  });
  let nextId = 0;
  return {
    child,
    async request(command) {
      const id = `board-${nextId++}`;
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      const events: unknown[] = [];
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const line = await new Promise<string>((resolve, reject) => {
          const existing = pending.shift();
          if (existing !== undefined) {
            resolve(existing);
            return;
          }
          const timer = setTimeout(() => reject(new Error(`pi rpc timed out\nstderr:\n${stderr}`)), deadline - Date.now());
          waiters.push((value) => {
            clearTimeout(timer);
            resolve(value);
          });
        });
        if (line.trim().length === 0) continue;
        let parsed: { type?: string; id?: string; method?: string; message?: string };
        try {
          parsed = JSON.parse(line) as { type?: string; id?: string; method?: string; message?: string };
        } catch {
          continue;
        }
        events.push(parsed);
        if (parsed.type === "extension_error") throw new Error(`pi extension error: ${line}\nstderr:\n${stderr}`);
        if (parsed.type === "response" && parsed.id === id) return events;
      }
      throw new Error(`pi rpc produced no response\n${JSON.stringify(events)}\nstderr:\n${stderr}`);
    },
    stop() {
      child.kill("SIGTERM");
    },
  };
}

describe("pi process", () => {
  test("a real Pi session exposes /board and still sees the topic after reload", async () => {
    const agentDir = tempDir("pitako-board-pi-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const repo = gitRepo();
    try {
      const { tools } = registeredBoard();
      const create = tools.get("board_topic_create");
      const post = tools.get("board_post");
      if (!create || !post) throw new Error("missing board tool");
      await create.execute("c", { title: "Reload proof" }, undefined, undefined, { cwd: repo });
      await post.execute("p", { topicId: 1, type: "FINDING", content: "sqlite file survives a new Pi process" }, undefined, undefined, { cwd: repo });

      const first = startPi(repo, agentDir);
      try {
        const commands = await first.request({ type: "get_commands" });
        const response = commands.find((event) => (event as { type?: string }).type === "response") as {
          success?: boolean;
          data?: { commands?: Array<{ name?: string }> };
        };
        expect(response.success).toBe(true);
        const names = (response.data?.commands ?? []).map((command) => command.name);
        expect(names).toContain("board");
        expect(names).toContain("todos");
        expect(names).toContain("pitako");
        const listed = await first.request({ type: "prompt", message: "/board" });
        expect(JSON.stringify(listed)).toContain("Reload proof");
      } finally {
        first.stop();
      }

      const second = startPi(repo, agentDir);
      try {
        const read = await second.request({ type: "prompt", message: "/board 1" });
        const body = JSON.stringify(read);
        expect(body).toContain("Reload proof");
        expect(body).toContain("sqlite file survives a new Pi process");
      } finally {
        second.stop();
      }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  }, 60_000);
});
