import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  test("initializes schema v1, enforces foreign keys, and refuses to discard unknown data", async () => {
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
    await expect(openBoard(kept)).rejects.toThrow(/not supported/);
    const still = await openSqlite(kept);
    expect(still.prepare("SELECT note FROM topics").get()?.note).toBe("keep");
    still.close();

    const corrupt = path.join(tempDir("pitako-board-corrupt-"), "board.db");
    writeFileSync(corrupt, "not sqlite");
    await expect(openBoard(corrupt)).rejects.toThrow(/initialization failed/);
    expect(readFileSync(corrupt, "utf8")).toBe("not sqlite");
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
  details?: { error?: string; topicId?: number; postId?: number; status?: string };
  isError?: boolean;
}

interface ToolRunner {
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ): Promise<ToolResult>;
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .map((part) => part.text ?? "")
    .join("\n");
}

function registeredBoard(): {
  tools: Map<string, ToolRunner>;
  command: (args: string, ctx: { cwd: string; hasUI: boolean; ui: { notify(message: string, kind?: string): void } }) => Promise<void>;
  events: string[];
} {
  const tools = new Map<string, ToolRunner>();
  let command: (args: string, ctx: { cwd: string; hasUI: boolean; ui: { notify(message: string, kind?: string): void } }) => Promise<void> =
    async () => {
      throw new Error("/board was not registered");
    };
  const events: string[] = [];
  const pi = {
    on(event: string) {
      events.push(event);
    },
    registerTool(definition: { name: string; execute: ToolRunner["execute"] }) {
      tools.set(definition.name, definition);
    },
    registerCommand(_name: string, spec: { handler: typeof command }) {
      command = spec.handler;
    },
  };
  board(pi as unknown as ExtensionAPI);
  return { tools, command, events };
}

describe("board tools", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let agentDir = "";

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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
