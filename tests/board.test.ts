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
import { boardWorkspace, currentWorkspace, repositoryIdentity } from "../extensions/board/workspace.ts";
import { ledgerFile, openExecutionPlan, planFile, readPlan } from "../extensions/workflow.ts";
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

function claimInChild(file: string, topicId: number, root: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const moduleUrl = new URL("../extensions/board/store.ts", import.meta.url).href;
  const source = `import { openBoard } from ${JSON.stringify(moduleUrl)}; const board = await openBoard(${JSON.stringify(file)}); try { board.claimTopicExecution("/repo", ${topicId}, "race-plan", { revision: 1, hash: "race-hash", executionRoot: ${JSON.stringify(root)} }); console.log("claimed"); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } finally { board.close(); }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
    child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function transitionInChild(file: string, topicId: number, status: "resolved" | "closed"): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const moduleUrl = new URL("../extensions/board/store.ts", import.meta.url).href;
  const binding = status === "resolved" ? { revision: 1, hash: "race-hash", executionRoot: "/execution" } : undefined;
  const source = `import { openBoard } from ${JSON.stringify(moduleUrl)}; const board = await openBoard(${JSON.stringify(file)}); try { board.transitionOwnedTopic("/repo", ${topicId}, "race-plan", ${JSON.stringify(status)}, ${JSON.stringify(binding)} ?? undefined); console.log("transitioned"); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } finally { board.close(); }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
    child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function gitWorktreePair(executionName = "execution"): { source: string; execution: string } {
  const base = tempDir("pitako-board-worktrees-");
  const source = path.join(base, "source");
  const execution = path.join(base, executionName);
  mkdirSync(source, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: source, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial", "-q"], { cwd: source, stdio: "ignore" });
  execFileSync("git", ["worktree", "add", "-q", "-b", "execution", execution], { cwd: source, stdio: "ignore" });
  return { source, execution };
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
    expect(repositoryIdentity(repo)).toBe(path.join(repo, ".git"));
    expect(repositoryIdentity(repo)).not.toBe(repositoryIdentity(other));
  });

  test("rejects unresolved registered worktrees before Board family migration", () => {
    const { source, execution } = gitWorktreePair();
    rmSync(execution, { recursive: true, force: true });
    expect(() => boardWorkspace(source)).toThrow(/registered worktree .* is unavailable/);
  });
});

describe("board store", () => {
  test("initializes schema v3, migrates v1 data, and refuses incomplete schemas", async () => {
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
    raw.exec("ALTER TABLE topics DROP COLUMN plan_revision");
    raw.exec("ALTER TABLE topics DROP COLUMN plan_hash");
    raw.exec("ALTER TABLE topics DROP COLUMN execution_root");
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

  test("migrates v2 topic identity columns without losing owners or posts", async () => {
    const file = path.join(tempDir("pitako-board-v2-"), "board.db");
    const initial = await openBoard(file);
    const topic = initial.createTopic("/legacy", { title: "v2" });
    initial.claimTopic("/legacy", topic.id, "v2-plan");
    initial.post("/legacy", { topicId: topic.id, type: "FINDING", content: "kept" });
    initial.close();

    const raw = await openSqlite(file);
    raw.exec("ALTER TABLE topics DROP COLUMN plan_revision");
    raw.exec("ALTER TABLE topics DROP COLUMN plan_hash");
    raw.exec("ALTER TABLE topics DROP COLUMN execution_root");
    raw.exec("PRAGMA user_version = 2");
    raw.close();

    const migrated = await openBoard(file);
    const page = migrated.readTopic("/legacy", topic.id);
    expect(page.topic.ownerPlanId).toBe("v2-plan");
    expect(page.topic.planRevision).toBeNull();
    expect(page.topic.planHash).toBeNull();
    expect(page.topic.executionRoot).toBeNull();
    expect(page.posts.map((post) => post.content)).toEqual(["kept"]);
    migrated.close();
  });

  test("family migration preserves topic IDs and rolls back owner collisions", async () => {
    const { source, execution } = gitWorktreePair();
    const other = gitRepo();
    const board = await openBoard(path.join(tempDir("pitako-board-family-"), "board.db"));
    const legacyA = board.createTopic(currentWorkspace(source), { title: "legacy A" });
    board.claimTopic(currentWorkspace(source), legacyA.id, "family-plan");
    const post = board.post(currentWorkspace(source), { topicId: legacyA.id, type: "FINDING", content: "same topic" });
    const legacyB = board.createTopic(currentWorkspace(execution), { title: "legacy B" });
    board.claimTopic(currentWorkspace(execution), legacyB.id, "family-plan");
    const unrelated = board.createTopic(currentWorkspace(other), { title: "unrelated" });

    expect(() => board.migrateLegacyWorkspaces(repositoryIdentity(source), [source, execution])).toThrow(/owns topics in multiple physical workspaces/);
    expect(board.readTopic(currentWorkspace(source), legacyA.id).posts.map((item) => item.id)).toEqual([post.id]);
    expect(board.readTopic(currentWorkspace(execution), legacyB.id).topic.title).toBe("legacy B");
    expect(board.readTopic(currentWorkspace(other), unrelated.id).topic.title).toBe("unrelated");

    board.close();
    const clean = await openBoard(path.join(tempDir("pitako-board-family-clean-"), "board.db"));
    const only = clean.createTopic(currentWorkspace(source), { title: "legacy without collision" });
    clean.post(currentWorkspace(source), { topicId: only.id, type: "INFO", content: "preserve" });
    clean.createTopic(currentWorkspace(other), { title: "unrelated" });
    clean.migrateLegacyWorkspaces(repositoryIdentity(execution), [source, execution]);
    const migrated = clean.readTopic(repositoryIdentity(source), only.id);
    expect(migrated.topic.workspace).toBe(repositoryIdentity(source));
    expect(migrated.posts.map((item) => item.content)).toEqual(["preserve"]);
    expect(clean.readTopic(currentWorkspace(other), 2).topic.workspace).toBe(currentWorkspace(other));
    clean.close();
  });

  test("claims one frozen execution identity with idempotent same-root retries", async () => {
    const file = path.join(tempDir("pitako-board-execution-claim-"), "board.db");
    const left = await openBoard(file);
    const right = await openBoard(file);
    const topic = left.createTopic("/repo", { title: "frozen claim" });
    left.claimTopic("/repo", topic.id, "plan");
    const claims = await Promise.allSettled([
      Promise.resolve().then(() => left.claimTopicExecution("/repo", topic.id, "plan", { revision: 2, hash: "frozen-hash", executionRoot: "/execution-a" })),
      Promise.resolve().then(() => right.claimTopicExecution("/repo", topic.id, "plan", { revision: 2, hash: "frozen-hash", executionRoot: "/execution-a" })),
    ]);
    expect(claims.filter((item) => item.status === "fulfilled")).toHaveLength(2);
    expect(left.readTopic("/repo", topic.id).topic).toMatchObject({ planRevision: 2, planHash: "frozen-hash", executionRoot: "/execution-a" });
    expect(() => right.claimTopicExecution("/repo", topic.id, "plan", { revision: 2, hash: "different-hash", executionRoot: "/execution-a" })).toThrow(/identity does not match/);
    expect(() => right.claimTopicExecution("/repo", topic.id, "plan", { revision: 2, hash: "frozen-hash", executionRoot: "/execution-b" })).toThrow(/pinned to execution worktree/);
    left.close();
    right.close();
  });

  test("preserves trailing spaces in a real Git worktree execution root", async () => {
    const { execution } = gitWorktreePair("execution ");
    expect(currentWorkspace(execution)).toBe(execution);
    const board = await openBoard(path.join(tempDir("pitako-board-trailing-root-"), "board.db"));
    const workspace = repositoryIdentity(execution);
    const topic = board.createTopic(workspace, { title: "trailing-space execution" });
    board.claimTopic(workspace, topic.id, "trailing-space-plan");
    const binding = { revision: 1, hash: "frozen-hash", executionRoot: execution };
    expect(board.claimTopicExecution(workspace, topic.id, "trailing-space-plan", binding).executionRoot).toBe(execution);
    expect(board.claimTopicExecution(workspace, topic.id, "trailing-space-plan", binding).executionRoot).toBe(execution);
    expect(board.transitionOwnedTopic(workspace, topic.id, "trailing-space-plan", "resolved", binding)).toMatchObject({
      status: "resolved", executionRoot: execution,
    });

    const invalid = board.createTopic(workspace, { title: "invalid execution root" });
    board.claimTopic(workspace, invalid.id, "invalid-root-plan");
    expect(() => board.claimTopicExecution(workspace, invalid.id, "invalid-root-plan", {
      revision: 1, hash: "frozen-hash", executionRoot: "relative-root",
    })).toThrow(/absolute path/);
    expect(board.readTopic(workspace, invalid.id).topic).toMatchObject({
      planRevision: null, planHash: null, executionRoot: null,
    });
    board.close();
  });

  test("concurrent processes can claim one physical execution root only", async () => {
    const file = path.join(tempDir("pitako-board-claim-race-"), "board.db");
    const board = await openBoard(file);
    const topic = board.createTopic("/repo", { title: "concurrent claim" });
    board.claimTopic("/repo", topic.id, "race-plan");
    board.close();

    const outcomes = await Promise.all([
      claimInChild(file, topic.id, "/execution-a"),
      claimInChild(file, topic.id, "/execution-b"),
    ]);
    expect(outcomes.filter((result) => result.code === 0)).toHaveLength(1);
    expect(outcomes.filter((result) => result.code !== 0)).toHaveLength(1);
    expect(outcomes.find((result) => result.code !== 0)?.stderr).toContain("pinned to execution worktree");
    const checked = await openBoard(file);
    expect(["/execution-a", "/execution-b"].includes(checked.readTopic("/repo", topic.id).topic.executionRoot ?? "")).toBe(true);
    checked.close();
  });

  test("cross-process close and resolve leave no claim when resolution loses the race", async () => {
    const file = path.join(tempDir("pitako-board-lifecycle-race-"), "board.db");
    const board = await openBoard(file);
    const topic = board.createTopic("/repo", { title: "lifecycle race" });
    board.claimTopic("/repo", topic.id, "race-plan");
    board.close();

    const [resolved, closed] = await Promise.all([
      transitionInChild(file, topic.id, "resolved"),
      transitionInChild(file, topic.id, "closed"),
    ]);
    expect(closed.code).toBe(0);
    const checked = await openBoard(file);
    const result = checked.readTopic("/repo", topic.id).topic;
    expect(result.status).toBe("closed");
    if (resolved.code === 0) {
      expect(result).toMatchObject({ planRevision: 1, planHash: "race-hash", executionRoot: "/execution" });
    } else {
      expect(resolved.stderr).toContain("cannot transition closed topic to resolved");
      expect(result).toMatchObject({ planRevision: null, planHash: null, executionRoot: null });
    }
    checked.close();
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
  details?: { error?: string; topicId?: number; postId?: number; postIds?: number[]; topics?: unknown[]; status?: string; noTopic?: boolean };
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

  test("rejected frozen resolution leaves an unclaimed closed topic unchanged", async () => {
    process.env.PI_CODING_AGENT_DIR = tempDir("pitako-board-lifecycle-rollback-");
    const repo = gitRepo();
    const planId = "closed-frozen-topic";
    const topicDb = await openBoard();
    const topic = topicDb.createTopic(repositoryIdentity(repo), { title: "closed frozen topic" });
    topicDb.claimTopic(repositoryIdentity(repo), topic.id, planId);
    topicDb.transitionOwnedTopic(repositoryIdentity(repo), topic.id, planId, "closed");
    const before = topicDb.readTopic(repositoryIdentity(repo), topic.id).topic;
    topicDb.close();

    const plan = planFile(planId, repo);
    mkdirSync(path.dirname(plan), { recursive: true });
    writeFileSync(plan, `---\nid: ${planId}\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\nexecution: expected\n---\n\nFrozen plan.\n`);
    const opened = openExecutionPlan(planId, repo);
    writeFileSync(opened.ledger, readFileSync(opened.ledger, "utf8").replace("status: running", "status: completed"));
    const planBefore = readFileSync(plan, "utf8");
    const ledgerBefore = readFileSync(opened.ledger, "utf8");

    const lifecycle = registeredBoard().tools.get("board_workflow_lifecycle");
    if (!lifecycle) throw new Error("missing workflow lifecycle tool");
    const result = await lifecycle.execute("resolve-closed", { planId, status: "resolved" }, undefined, undefined, { cwd: repo });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("cannot transition closed topic to resolved");

    const verified = await openBoard();
    expect(verified.readTopic(repositoryIdentity(repo), topic.id).topic).toEqual(before);
    verified.close();
    expect(readFileSync(plan, "utf8")).toBe(planBefore);
    expect(readFileSync(opened.ledger, "utf8")).toBe(ledgerBefore);
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
    expect(unchanged.readTopic(repositoryIdentity(repo), 1).topic.status).toBe("open");
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
    closedDb.updateTopic(repositoryIdentity(repo), closedTopic.details?.topicId as number, { status: "closed" });
    closedDb.close();
    expect((await claim.execute("closed-claim", { planId: "closed-draft", topicId: closedTopic.details?.topicId }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    expect(readFileSync(closedDraft, "utf8")).not.toContain("board_topic_id:");
    const unowned = await create.execute("unowned", { title: "frozen unowned" }, undefined, undefined, { cwd: repo });
    const frozenUnowned = planFile("frozen-unowned", repo);
    writeFileSync(frozenUnowned, `---\nid: frozen-unowned\nrevision: 1\nstatus: frozen\nboard_topic_id: ${unowned.details?.topicId}\n---\n\nFrozen.\n`);
    expect((await claim.execute("frozen-claim", { planId: "frozen-unowned", topicId: unowned.details?.topicId }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    const stillUnowned = await openBoard();
    expect(stillUnowned.readTopic(repositoryIdentity(repo), unowned.details?.topicId as number).topic.ownerPlanId).toBeNull();
    stillUnowned.close();

    const recoveredOwnerPlan = planFile("recovered-owner", repo);
    writeFileSync(recoveredOwnerPlan, "---\nid: recovered-owner\nrevision: 1\nstatus: draft\nexecution: none\n---\n\nRecovery.\n");
    const recoveryTopic = await create.execute("recovery-topic", { title: "preclaimed recovery" }, undefined, undefined, { cwd: repo });
    const recoveryTopicId = recoveryTopic.details?.topicId;
    const ownedDb = await openBoard();
    ownedDb.claimTopic(repositoryIdentity(repo), recoveryTopicId!, "recovered-owner");
    ownedDb.close();
    const recovered = await claim.execute("recover", { planId: "recovered-owner", topicId: recoveryTopicId }, undefined, undefined, { cwd: repo });
    expect(recovered.isError).toBeFalsy();
    expect(readFileSync(recoveredOwnerPlan, "utf8")).toContain(`board_topic_id: ${recoveryTopicId}`);
    const ownerRead = await openBoard();
    expect(ownerRead.readTopic(repositoryIdentity(repo), recoveryTopicId!).topic.ownerPlanId).toBe("recovered-owner");
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
    expect(missingOwner.readTopic(repositoryIdentity(repo), missingTopicId!).topic.ownerPlanId).toBeNull();
    missingOwner.close();
    expect((await lifecycle.execute("resolve-missing", { planId: "missing-execution", status: "resolved" }, undefined, undefined, { cwd: repo })).isError).toBe(true);
    const resolving = lifecycle.execute("resolve-race", { planId: "workflow-plan", status: "resolved" }, undefined, undefined, { cwd: repo });
    recordPlanTeamWork(repo, "workflow-plan", "resolve-race", "racing-dispatch", "pending");
    const racedResolve = await resolving;
    expect(racedResolve.isError).toBe(true);
    const openAfterRace = await openBoard();
    expect(openAfterRace.readTopic(repositoryIdentity(repo), 1).topic.status).toBe("open");
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
    expect(beforeCompletion.readTopic(repositoryIdentity(repo), expectedTopicId!).topic.status).toBe("open");
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

  test("sibling worktree sees legacy topic and posts under same ID without copying", async () => {
    agentDir = tempDir("pitako-board-family-tools-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const { source, execution } = gitWorktreePair();
    const unrelated = gitRepo();
    const boardDb = await openBoard();
    const legacy = boardDb.createTopic(currentWorkspace(source), { title: "A legacy topic" });
    boardDb.claimTopic(currentWorkspace(source), legacy.id, "family-plan");
    const post = boardDb.post(currentWorkspace(source), { topicId: legacy.id, type: "FINDING", content: "same post" });
    const other = boardDb.createTopic(currentWorkspace(unrelated), { title: "unrelated repo" });
    boardDb.close();

    const { tools } = registeredBoard();
    const list = tools.get("board_topic_list");
    const read = tools.get("board_topic_read");
    const create = tools.get("board_topic_create");
    if (!list || !read || !create) throw new Error("missing Board tools");
    const listed = await list.execute("list", {}, undefined, undefined, { cwd: execution });
    expect(listed.details?.topics).toEqual([expect.objectContaining({ id: legacy.id, title: "A legacy topic", postCount: 1 })]);
    const page = await read.execute("read", { topicId: legacy.id }, undefined, undefined, { cwd: execution });
    expect(textOf(page)).toContain("same post");
    expect(page.details?.postIds).toEqual([post.id]);
    const created = await create.execute("new", { title: "created in B" }, undefined, undefined, { cwd: execution });
    expect(created.details?.topicId).not.toBe(legacy.id);

    const verify = await openBoard();
    expect(verify.readTopic(repositoryIdentity(source), legacy.id).posts.map((item) => item.id)).toEqual([post.id]);
    expect(verify.readTopic(currentWorkspace(unrelated), other.id).topic.workspace).toBe(currentWorkspace(unrelated));
    verify.close();
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
