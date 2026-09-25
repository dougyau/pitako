import { mkdirSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BOARD_AUTHOR } from "./author.ts";
import { getBoardDbPath } from "./paths.ts";
import { openSqlite, type SqlDatabase } from "./sqlite.ts";

export const SCHEMA_VERSION = 3;
export const BOARD_AUTHOR = "pi";
export const BOARD_SCOPE = "global";

export const TOPIC_STATUSES = ["open", "resolved", "closed"] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export const POST_TYPES = ["INFO", "FINDING", "QUESTION", "ANSWER", "DECISION", "BLOCKER", "HANDOFF"] as const;
export type PostType = (typeof POST_TYPES)[number];

export const LIMITS = {
  listDefault: 20,
  listMax: 50,
  readDefault: 40,
  readMax: 100,
  queryDefault: 20,
  queryMax: 50,
} as const;

export class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardError";
  }
}

export interface Topic {
  id: number;
  workspace: string;
  scope: string;
  title: string;
  description: string | null;
  status: TopicStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  ownerPlanId: string | null;
  planRevision: number | null;
  planHash: string | null;
  executionRoot: string | null;
}

export interface TopicListItem {
  id: number;
  title: string;
  status: TopicStatus;
  updatedAt: string;
  postCount: number;
}

export interface TopicList {
  status: TopicStatus;
  topics: TopicListItem[];
  total: number;
  limit: number;
  capped: boolean;
}

export interface Post {
  id: number;
  topicId: number;
  author: string;
  type: PostType;
  subject: string | null;
  content: string;
  replyTo: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface TopicPage {
  topic: Topic;
  posts: Post[];
  total: number;
  limit: number;
  capped: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface QueryHit extends Post {
  topicTitle: string;
  topicStatus: TopicStatus;
}

export interface QueryResult {
  posts: QueryHit[];
  total: number;
  limit: number;
  capped: boolean;
}

export interface Board {
  close(): void;
  migrateLegacyWorkspaces(identity: string, physicalRoots: readonly string[]): void;
  createTopic(workspace: string, input: { title: string; description?: string }, author?: string): Topic;
  listTopics(workspace: string, filter?: { status?: TopicStatus; limit?: number }): TopicList;
  findTopicOwnedByPlan(workspace: string, planId: string): number | undefined;
  readTopic(
    workspace: string,
    topicId: number,
    page?: { limit?: number; beforePostId?: number; afterPostId?: number },
  ): TopicPage;
  updateTopic(
    workspace: string,
    topicId: number,
    patch: { status?: TopicStatus; title?: string; description?: string },
  ): Topic;
  post(
    workspace: string,
    input: {
      topicId: number;
      type: string;
      subject?: string;
      content: string;
      replyTo?: number;
      metadata?: unknown;
    },
    author?: string,
  ): Post;
  claimTopic(workspace: string, topicId: number, planId: string): Topic;
  claimTopicExecution(workspace: string, topicId: number, planId: string, binding: { revision: number; hash: string; executionRoot: string }): Topic;
  transitionOwnedTopic(
    workspace: string,
    topicId: number,
    planId: string,
    status: "resolved" | "closed",
    executionBinding?: { revision: number; hash: string; executionRoot: string },
  ): Topic;
  query(
    workspace: string,
    filter?: { topicId?: number; type?: string; author?: string; text?: string; limit?: number },
  ): QueryResult;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL,
    scope TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'closed')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_plan_id TEXT,
    plan_revision INTEGER,
    plan_hash TEXT,
    execution_root TEXT
  )`,
  `CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL REFERENCES topics(id),
    author TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('INFO', 'FINDING', 'QUESTION', 'ANSWER', 'DECISION', 'BLOCKER', 'HANDOFF')),
    subject TEXT,
    content TEXT NOT NULL,
    reply_to INTEGER REFERENCES posts(id),
    metadata_json TEXT,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX topics_workspace_status ON topics(workspace, status)",
  "CREATE INDEX posts_topic_id_id ON posts(topic_id, id)",
  "CREATE INDEX posts_type ON posts(type)",
  `CREATE TRIGGER posts_reply_same_topic
   BEFORE INSERT ON posts
   FOR EACH ROW
   WHEN NEW.reply_to IS NOT NULL
   BEGIN
     SELECT RAISE(ABORT, 'reply references another topic')
     WHERE (SELECT topic_id FROM posts WHERE id = NEW.reply_to) != NEW.topic_id;
   END`,
];

export async function openBoard(dbPath = getBoardDbPath()): Promise<Board> {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  let db: SqlDatabase;
  try {
    db = await openSqlite(dbPath);
  } catch (error) {
    throw initError(dbPath, error);
  }
  try {
    initialize(db, dbPath);
  } catch (error) {
    db.close();
    throw error instanceof BoardError ? error : initError(dbPath, error);
  }
  return new SqliteBoard(db);
}

function initialize(db: SqlDatabase, dbPath: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    let version = pragmaInteger(db, "user_version");
    if (version === 0) {
      if (tableExists(db, "topics") || tableExists(db, "posts")) {
        throw initError(dbPath, "schema version is 0 but Board tables already exist. Refusing to guess or discard data.");
      }
      for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
      db.exec("CREATE UNIQUE INDEX topics_workspace_owner_plan ON topics(workspace, owner_plan_id) WHERE owner_plan_id IS NOT NULL");
      version = SCHEMA_VERSION;
      db.exec(`PRAGMA user_version = ${version}`);
    } else if (version === 1) {
      if (!tableExists(db, "topics") || !tableExists(db, "posts")) throw initError(dbPath, "schema v1 is incomplete. Refusing to discard or recreate it.");
      db.exec("ALTER TABLE topics ADD COLUMN owner_plan_id TEXT");
      db.exec("CREATE UNIQUE INDEX topics_workspace_owner_plan ON topics(workspace, owner_plan_id) WHERE owner_plan_id IS NOT NULL");
      version = 2;
      db.exec("PRAGMA user_version = 2");
    }
    if (version === 2) {
      validateV2(db, dbPath);
      db.exec("ALTER TABLE topics ADD COLUMN plan_revision INTEGER");
      db.exec("ALTER TABLE topics ADD COLUMN plan_hash TEXT");
      db.exec("ALTER TABLE topics ADD COLUMN execution_root TEXT");
      version = 3;
      db.exec("PRAGMA user_version = 3");
    }
    if (version === SCHEMA_VERSION) validateV3(db, dbPath);
    else throw initError(dbPath, `schema version ${version} is not supported (expected ${SCHEMA_VERSION}). Refusing to migrate or discard data.`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The connection is closing or the transaction never started.
    }
    throw error;
  }
}

function validateV2(db: SqlDatabase, dbPath: string): void {
  const columns = new Set(db.prepare("PRAGMA table_info(topics)").all().map((row) => row.name));
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'topics_workspace_owner_plan'").get();
  if (!tableExists(db, "topics") || !tableExists(db, "posts") || !columns.has("owner_plan_id") || !index) {
    throw initError(dbPath, "schema v2 is incomplete. Refusing to discard or recreate it.");
  }
}

function validateV3(db: SqlDatabase, dbPath: string): void {
  const columns = new Set(db.prepare("PRAGMA table_info(topics)").all().map((row) => row.name));
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'topics_workspace_owner_plan'").get();
  if (!tableExists(db, "topics") || !tableExists(db, "posts") || !index ||
    !["owner_plan_id", "plan_revision", "plan_hash", "execution_root"].every((column) => columns.has(column))) {
    throw initError(dbPath, "schema v3 is incomplete. Refusing to discard or recreate it.");
  }
}

class SqliteBoard implements Board {
  constructor(private readonly db: SqlDatabase) {}

  close(): void {
    this.db.close();
  }

  migrateLegacyWorkspaces(identity: string, physicalRoots: readonly string[]): void {
    const workspace = requireWorkspace(identity);
    const roots = [...new Set(physicalRoots.map((root) => requireWorkspace(root)))].filter((root) => root !== workspace);
    if (roots.length === 0) return;
    const placeholders = roots.map(() => "?").join(", ");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owners = this.db.prepare(
        `SELECT owner_plan_id FROM topics WHERE (workspace IN (${placeholders}) OR workspace = ?) AND owner_plan_id IS NOT NULL`,
      ).all(...roots, workspace);
      const seen = new Set<string>();
      for (const row of owners) {
        const owner = text(row.owner_plan_id, "owner_plan_id");
        if (seen.has(owner)) throw new BoardError(`plan ${owner} owns topics in multiple physical workspaces; refusing family migration`);
        seen.add(owner);
      }
      this.db.prepare(`UPDATE topics SET workspace = ? WHERE workspace IN (${placeholders})`).run(workspace, ...roots);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      throw error instanceof BoardError ? error : new BoardError(`Board family migration failed: ${messageOf(error)}`);
    }
  }

  createTopic(workspace: string, input: { title: string; description?: string }, author = DEFAULT_BOARD_AUTHOR): Topic {
    const title = requireText(input.title, "title");
    const description = optionalText(input.description);
    const createdAt = timestamp();
    const inserted = this.db
      .prepare(
        `INSERT INTO topics (workspace, scope, title, description, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(requireWorkspace(workspace), BOARD_SCOPE, title, description, authorOrDefault(author), createdAt, createdAt);
    return this.requireTopic(workspace, inserted.lastInsertRowid);
  }

  listTopics(workspace: string, filter: { status?: TopicStatus; limit?: number } = {}): TopicList {
    const status = filter.status ?? "open";
    assertStatus(status);
    const bounded = boundLimit(filter.limit, LIMITS.listDefault, LIMITS.listMax);
    const rows = this.db
      .prepare(
        `SELECT id, title, status, updated_at,
                (SELECT COUNT(*) FROM posts WHERE topic_id = topics.id) AS post_count
         FROM topics
         WHERE workspace = ? AND status = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(requireWorkspace(workspace), status, bounded.limit);
    const total = scalar(
      this.db.prepare("SELECT COUNT(*) AS n FROM topics WHERE workspace = ? AND status = ?").get(workspace, status),
    );
    return {
      status,
      topics: rows.map((row) => ({
        id: integer(row.id, "topic id"),
        title: text(row.title, "title"),
        status: topicStatus(row.status),
        updatedAt: text(row.updated_at, "updated_at"),
        postCount: integer(row.post_count, "post count"),
      })),
      total,
      limit: bounded.limit,
      capped: bounded.capped,
    };
  }

  findTopicOwnedByPlan(workspace: string, planId: string): number | undefined {
    const row = this.db.prepare("SELECT id FROM topics WHERE workspace = ? AND owner_plan_id = ?").get(requireWorkspace(workspace), requireText(planId, "planId"));
    return row ? integer(row.id, "topic id") : undefined;
  }

  readTopic(
    workspace: string,
    topicId: number,
    page: { limit?: number; beforePostId?: number; afterPostId?: number } = {},
  ): TopicPage {
    const topic = this.requireTopic(workspace, topicId);
    if (page.beforePostId !== undefined && page.afterPostId !== undefined) {
      throw new BoardError("pass beforePostId or afterPostId, not both");
    }
    const bounded = boundLimit(page.limit, LIMITS.readDefault, LIMITS.readMax);
    const total = scalar(this.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE topic_id = ?").get(topic.id));
    let rows: Record<string, unknown>[];
    if (page.afterPostId !== undefined) {
      const afterPostId = requireId(page.afterPostId, "afterPostId");
      rows = this.db
        .prepare(`${POST_SELECT} WHERE topic_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
        .all(topic.id, afterPostId, bounded.limit);
    } else if (page.beforePostId !== undefined) {
      const beforePostId = requireId(page.beforePostId, "beforePostId");
      rows = this.db
        .prepare(`${POST_SELECT} WHERE topic_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
        .all(topic.id, beforePostId, bounded.limit)
        .reverse();
    } else {
      rows = this.db
        .prepare(`${POST_SELECT} WHERE topic_id = ? ORDER BY id DESC LIMIT ?`)
        .all(topic.id, bounded.limit)
        .reverse();
    }
    const posts = rows.map(parsePost);
    const oldest = posts[0]?.id;
    const newest = posts[posts.length - 1]?.id;
    return {
      topic,
      posts,
      total,
      limit: bounded.limit,
      capped: bounded.capped,
      hasOlder: oldest !== undefined && this.exists(topic.id, "id < ?", oldest),
      hasNewer: newest !== undefined && this.exists(topic.id, "id > ?", newest),
    };
  }

  updateTopic(
    workspace: string,
    topicId: number,
    patch: { status?: TopicStatus; title?: string; description?: string },
  ): Topic {
    const topic = this.requireTopic(workspace, topicId);
    if (patch.status !== undefined && topic.ownerPlanId !== null) throw new BoardError(`topic ${topic.id} is owned by plan ${topic.ownerPlanId}; use the workflow lifecycle operation`);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      assertStatus(patch.status);
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.title !== undefined) {
      sets.push("title = ?");
      params.push(requireText(patch.title, "title"));
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(optionalText(patch.description));
    }
    if (sets.length === 0) throw new BoardError("topic update needs status, title, or description");
    sets.push("updated_at = ?");
    params.push(timestamp(), topic.id);
    const ownerGuard = patch.status === undefined ? "" : " AND owner_plan_id IS NULL";
    const result = this.db.prepare(`UPDATE topics SET ${sets.join(", ")} WHERE id = ?${ownerGuard}`).run(...params);
    if (result.changes !== 1) throw new BoardError(`topic ${topic.id} changed ownership during update`);
    return this.requireTopic(workspace, topic.id);
  }

  claimTopicExecution(
    workspace: string,
    topicId: number,
    planId: string,
    binding: { revision: number; hash: string; executionRoot: string },
  ): Topic {
    const id = requireId(topicId, "topicId");
    const owner = requireText(planId, "planId");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const topic = this.claimTopicExecutionInTransaction(workspace, id, owner, binding);
      this.db.exec("COMMIT");
      return topic;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  claimTopic(workspace: string, topicId: number, planId: string): Topic {
    const id = requireId(topicId, "topicId");
    const owner = requireText(planId, "planId");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const topic = this.requireTopic(workspace, id);
      if (topic.status !== "open") throw new BoardError(`topic ${id} must be open before it can be claimed`);
      if (topic.ownerPlanId === owner) {
        this.db.exec("COMMIT");
        return topic;
      }
      if (topic.ownerPlanId !== null) throw new BoardError(`topic ${id} is already owned by plan ${topic.ownerPlanId}`);
      const result = this.db.prepare("UPDATE topics SET owner_plan_id = ? WHERE id = ? AND workspace = ? AND status = 'open' AND owner_plan_id IS NULL").run(owner, id, requireWorkspace(workspace));
      if (result.changes !== 1) throw new BoardError(`topic ${id} could not be claimed`);
      this.db.exec("COMMIT");
      return this.requireTopic(workspace, id);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  transitionOwnedTopic(
    workspace: string,
    topicId: number,
    planId: string,
    status: "resolved" | "closed",
    executionBinding?: { revision: number; hash: string; executionRoot: string },
  ): Topic {
    const id = requireId(topicId, "topicId");
    const owner = requireText(planId, "planId");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (executionBinding) this.claimTopicExecutionInTransaction(workspace, id, owner, executionBinding);
      const topic = this.requireTopic(workspace, id);
      if (topic.ownerPlanId !== owner) throw new BoardError(`topic ${id} is not owned by plan ${owner}`);
      if (topic.status === status) {
        this.db.exec("COMMIT");
        return topic;
      }
      const allowed = status === "resolved" ? ["open"] : ["open", "resolved"];
      if (!allowed.includes(topic.status)) throw new BoardError(`cannot transition ${topic.status} topic to ${status}`);
      const placeholders = allowed.map(() => "?").join(", ");
      const result = this.db.prepare(`UPDATE topics SET status = ?, updated_at = ? WHERE id = ? AND workspace = ? AND owner_plan_id = ? AND status IN (${placeholders})`).run(status, timestamp(), id, requireWorkspace(workspace), owner, ...allowed);
      if (result.changes !== 1) throw new BoardError(`topic ${id} lifecycle transition failed`);
      this.db.exec("COMMIT");
      return this.requireTopic(workspace, id);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  private claimTopicExecutionInTransaction(
    workspace: string,
    id: number,
    owner: string,
    binding: { revision: number; hash: string; executionRoot: string },
  ): Topic {
    const revision = requireId(binding.revision, "revision");
    const hash = requireText(binding.hash, "hash");
    const root = requireExecutionRoot(binding.executionRoot);
    const topic = this.requireTopic(workspace, id);
    if (topic.ownerPlanId !== owner) throw new BoardError(`topic ${id} is not owned by plan ${owner}`);
    const hasRevision = topic.planRevision !== null;
    const hasHash = topic.planHash !== null;
    const hasRoot = topic.executionRoot !== null;
    if (hasRevision || hasHash || hasRoot) {
      if (!(hasRevision && hasHash && hasRoot)) throw new BoardError(`topic ${id} has an incomplete frozen execution claim`);
      if (topic.executionRoot !== root) throw new BoardError(`topic ${id} is pinned to execution worktree ${topic.executionRoot}`);
      if (topic.planRevision !== revision || topic.planHash !== hash) throw new BoardError(`topic ${id} frozen plan identity does not match revision ${revision} and hash ${hash}`);
      return topic;
    }
    const result = this.db.prepare(
      "UPDATE topics SET plan_revision = ?, plan_hash = ?, execution_root = ? WHERE id = ? AND workspace = ? AND owner_plan_id = ? AND plan_revision IS NULL AND plan_hash IS NULL AND execution_root IS NULL",
    ).run(revision, hash, root, id, requireWorkspace(workspace), owner);
    if (result.changes !== 1) throw new BoardError(`topic ${id} frozen execution claim changed concurrently`);
    return this.requireTopic(workspace, id);
  }

  post(
    workspace: string,
    input: {
      topicId: number;
      type: string;
      subject?: string;
      content: string;
      replyTo?: number;
      metadata?: unknown;
    },
    author = DEFAULT_BOARD_AUTHOR,
  ): Post {
    const topic = this.requireTopic(workspace, input.topicId);
    const type = parsePostType(input.type);
    const content = requireText(input.content, "content");
    const subject = optionalText(input.subject);
    const metadata = serializeMetadata(input.metadata);
    const replyTo = input.replyTo === undefined ? null : this.requireReply(topic.id, input.replyTo);
    const createdAt = timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare(
          `INSERT INTO posts (topic_id, author, type, subject, content, reply_to, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(topic.id, authorOrDefault(author), type, subject, content, replyTo, metadata, createdAt);
      this.db.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(createdAt, topic.id);
      this.db.exec("COMMIT");
      return this.requirePost(inserted.lastInsertRowid);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw error instanceof BoardError ? error : new BoardError(`Board post failed: ${messageOf(error)}`);
    }
  }

  query(
    workspace: string,
    filter: { topicId?: number; type?: string; author?: string; text?: string; limit?: number } = {},
  ): QueryResult {
    const topicId = filter.topicId === undefined ? null : this.requireTopic(workspace, filter.topicId).id;
    const type = filter.type === undefined ? null : parsePostType(filter.type);
    const author = optionalText(filter.author);
    const needle = optionalText(filter.text);
    const bounded = boundLimit(filter.limit, LIMITS.queryDefault, LIMITS.queryMax);
    const where = `FROM posts p
      JOIN topics t ON t.id = p.topic_id
      WHERE t.workspace = ?
        AND (? IS NULL OR p.topic_id = ?)
        AND (? IS NULL OR p.type = ?)
        AND (? IS NULL OR p.author = ?)
        AND (? IS NULL OR instr(lower(p.content), lower(?)) > 0 OR instr(lower(coalesce(p.subject, '')), lower(?)) > 0)`;
    // ponytail: instr() scan. Add FTS if dogfood shows SQL text search is not enough.
    const params = [requireWorkspace(workspace), topicId, topicId, type, type, author, author, needle, needle, needle];
    const rows = this.db
      .prepare(
        `SELECT p.id, p.topic_id, p.author, p.type, p.subject, p.content, p.reply_to, p.metadata_json, p.created_at,
                t.title AS topic_title, t.status AS topic_status
         ${where}
         ORDER BY p.id DESC
         LIMIT ?`,
      )
      .all(...params, bounded.limit);
    const total = scalar(this.db.prepare(`SELECT COUNT(*) AS n ${where}`).get(...params));
    return {
      posts: rows.map((row) => ({
        ...parsePost(row),
        topicTitle: text(row.topic_title, "topic title"),
        topicStatus: topicStatus(row.topic_status),
      })),
      total,
      limit: bounded.limit,
      capped: bounded.capped,
    };
  }

  private requireTopic(workspace: string, topicId: number): Topic {
    const id = requireId(topicId, "topicId");
    const row = this.db
      .prepare(
        `SELECT id, workspace, scope, title, description, status, created_by, created_at, updated_at,
                owner_plan_id, plan_revision, plan_hash, execution_root
         FROM topics WHERE id = ?`,
      )
      .get(id);
    if (!row) throw new BoardError(`unknown topic ${id}`);
    if (text(row.workspace, "workspace") !== requireWorkspace(workspace)) {
      throw new BoardError(`topic ${id} belongs to another workspace`);
    }
    return {
      id: integer(row.id, "topic id"),
      workspace: text(row.workspace, "workspace"),
      scope: text(row.scope, "scope"),
      title: text(row.title, "title"),
      description: nullableText(row.description, "description"),
      status: topicStatus(row.status),
      createdBy: text(row.created_by, "created_by"),
      createdAt: text(row.created_at, "created_at"),
      updatedAt: text(row.updated_at, "updated_at"),
      ownerPlanId: nullableText(row.owner_plan_id, "owner_plan_id"),
      planRevision: nullableInteger(row.plan_revision, "plan_revision"),
      planHash: nullableText(row.plan_hash, "plan_hash"),
      executionRoot: nullableText(row.execution_root, "execution_root"),
    };
  }

  private requireReply(topicId: number, replyTo: number): number {
    const id = requireId(replyTo, "replyTo");
    const row = this.db.prepare("SELECT id, topic_id FROM posts WHERE id = ?").get(id);
    if (!row) throw new BoardError(`reply ${id} was not found`);
    if (integer(row.topic_id, "reply topic") !== topicId) {
      throw new BoardError(`reply ${id} references another topic`);
    }
    return id;
  }

  private requirePost(postId: number): Post {
    const row = this.db.prepare(`${POST_SELECT} WHERE id = ?`).get(postId);
    if (!row) throw new BoardError(`unknown post ${postId}`);
    return parsePost(row);
  }

  private exists(topicId: number, predicate: string, id: number): boolean {
    return this.db.prepare(`SELECT 1 AS n FROM posts WHERE topic_id = ? AND ${predicate} LIMIT 1`).get(topicId, id) !== undefined;
  }
}

const POST_SELECT =
  "SELECT id, topic_id, author, type, subject, content, reply_to, metadata_json, created_at FROM posts";

function parsePost(row: Record<string, unknown>): Post {
  const id = integer(row.id, "post id");
  return {
    id,
    topicId: integer(row.topic_id, "topic id"),
    author: text(row.author, "author"),
    type: postType(row.type),
    subject: nullableText(row.subject, "subject"),
    content: text(row.content, "content"),
    replyTo: row.reply_to === null || row.reply_to === undefined ? null : integer(row.reply_to, "reply_to"),
    metadata: parseMetadata(row.metadata_json, id),
    createdAt: text(row.created_at, "created_at"),
  };
}

function parseMetadata(value: unknown, postId: number): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new BoardError(`stored metadata for post ${postId} is corrupt`);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BoardError(`stored metadata for post ${postId} is corrupt`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError(`stored metadata for post ${postId} is corrupt`);
  }
}

function serializeMetadata(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BoardError("malformed metadata: expected an object");
  }
  try {
    return JSON.stringify(value);
  } catch {
    throw new BoardError("malformed metadata: value is not JSON-serializable");
  }
}

function parsePostType(value: string): PostType {
  if ((POST_TYPES as readonly string[]).includes(value)) return value as PostType;
  throw new BoardError(`invalid post type "${value}". Expected ${POST_TYPES.join(", ")}.`);
}

function assertStatus(value: string): asserts value is TopicStatus {
  if (!(TOPIC_STATUSES as readonly string[]).includes(value)) {
    throw new BoardError(`invalid topic status "${value}". Expected ${TOPIC_STATUSES.join(", ")}.`);
  }
}

function topicStatus(value: unknown): TopicStatus {
  const status = text(value, "status");
  assertStatus(status);
  return status;
}

function postType(value: unknown): PostType {
  const type = text(value, "type");
  return parsePostType(type);
}

function requireWorkspace(workspace: string): string {
  if (typeof workspace !== "string" || workspace.trim().length === 0) {
    throw new BoardError("workspace is required");
  }
  return workspace;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string") throw new BoardError(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new BoardError(`${label} must not be empty`);
  return trimmed;
}

function requireExecutionRoot(value: string): string {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new BoardError("executionRoot must be a nonempty absolute path");
  }
  return value;
}

function optionalText(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new BoardError("expected text");
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requireId(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BoardError(`${label} must be a positive integer`);
  }
  return value;
}

function boundLimit(requested: number | undefined, fallback: number, max: number): { limit: number; capped: boolean } {
  if (requested === undefined) return { limit: fallback, capped: false };
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
    throw new BoardError("limit must be a positive integer");
  }
  if (requested > max) return { limit: max, capped: true };
  return { limit: requested, capped: false };
}

function tableExists(db: SqlDatabase, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function pragmaInteger(db: SqlDatabase, name: "user_version"): number {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return integer(row?.[name], name);
}

function scalar(row: Record<string, unknown> | undefined): number {
  return integer(row?.n, "count");
}

function integer(value: unknown, label: string): number {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new BoardError(`${label} is too large`);
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new BoardError(`${label} was not an integer`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new BoardError(`${label} was not text`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, label);
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, label);
}

function authorOrDefault(author: string): string {
  const trimmed = author.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_BOARD_AUTHOR;
}

function timestamp(): string {
  return new Date().toISOString();
}

function initError(dbPath: string, error: unknown): BoardError {
  return new BoardError(`Board database initialization failed at ${dbPath}: ${messageOf(error)}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
