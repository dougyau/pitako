import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  BoardError,
  LIMITS,
  POST_TYPES,
  TOPIC_STATUSES,
  openBoard,
  type Board,
  type Post,
  type QueryResult,
  type Topic,
  type TopicList,
  type TopicPage,
} from "./store.ts";
import { currentWorkspace } from "./workspace.ts";

const PostTypeSchema = StringEnum(POST_TYPES);
const TopicStatusSchema = StringEnum(TOPIC_STATUSES);
const noExtra = { additionalProperties: false } as const;

export function registerBoard(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "board_topic_create",
    label: "Board topic",
    description:
      "Create one global Board topic in the current workspace. A topic is a shared subject, not a TODO and not a chat thread.",
    promptSnippet: "Create a Board topic for one shared subject",
    promptGuidelines: [
      "Use board_topic_create for a new shared subject. Do not create a topic per file, command, or TODO.",
    ],
    parameters: Type.Object(
      {
        title: Type.String({ description: "Short subject title" }),
        description: Type.Optional(Type.String({ description: "Optional scope of the discussion" })),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (board, workspace) => {
        const topic = board.createTopic(workspace, params);
        return { text: formatTopicCreated(topic), details: { topicId: topic.id, title: topic.title, status: topic.status } };
      });
    },
  });

  pi.registerTool({
    name: "board_topic_list",
    label: "Board topics",
    description: `List Board topics in the current workspace. Defaults to open topics, newest activity first. Default limit ${LIMITS.listDefault}, max ${LIMITS.listMax}. Does not load post bodies.`,
    promptSnippet: "List open Board topics in this workspace",
    promptGuidelines: [
      "Use board_topic_list to see open shared subjects. Board posts are not in the prompt. Do not expect them to appear unless you query.",
    ],
    parameters: Type.Object(
      {
        status: Type.Optional(TopicStatusSchema),
        limit: Type.Optional(Type.Number({ description: `Max topics. Default ${LIMITS.listDefault}, hard max ${LIMITS.listMax}.` })),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (board, workspace) => {
        const listed = board.listTopics(workspace, params);
        return { text: formatTopicList(listed), details: { topics: listed.topics, total: listed.total, limit: listed.limit } };
      });
    },
  });

  pi.registerTool({
    name: "board_topic_read",
    label: "Read Board topic",
    description: `Read one current-workspace topic and a page of posts in chronological order. Default limit ${LIMITS.readDefault}, max ${LIMITS.readMax}. Use beforePostId or afterPostId to page.`,
    promptSnippet: "Read one Board topic, paging posts if needed",
    promptGuidelines: [
      "Use board_topic_read to page one topic. Do not read every topic when board_query can answer.",
    ],
    parameters: Type.Object(
      {
        topicId: Type.Number({ description: "Topic id" }),
        limit: Type.Optional(Type.Number({ description: `Max posts. Default ${LIMITS.readDefault}, hard max ${LIMITS.readMax}.` })),
        beforePostId: Type.Optional(Type.Number({ description: "Return posts older than this id" })),
        afterPostId: Type.Optional(Type.Number({ description: "Return posts newer than this id" })),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (board, workspace) => {
        const page = board.readTopic(workspace, params.topicId, params);
        return { text: formatTopicRead(page), details: { topicId: page.topic.id, postIds: page.posts.map((post) => post.id), total: page.total } };
      });
    },
  });

  pi.registerTool({
    name: "board_topic_update",
    label: "Update Board topic",
    description:
      "Update a current-workspace topic title, description, or status (open, resolved, closed). A DECISION post does not resolve the topic.",
    promptSnippet: "Update a Board topic title, description, or status",
    promptGuidelines: [
      "Use board_topic_update when a discussion is resolved or no longer active. A DECISION post does not change topic status by itself.",
    ],
    parameters: Type.Object(
      {
        topicId: Type.Number({ description: "Topic id" }),
        status: Type.Optional(TopicStatusSchema),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (board, workspace) => {
        const topic = board.updateTopic(workspace, params.topicId, params);
        return { text: formatTopicCreated(topic), details: { topicId: topic.id, title: topic.title, status: topic.status } };
      });
    },
  });

  pi.registerTool({
    name: "board_post",
    label: "Board post",
    description:
      "Post coordination knowledge to a current-workspace topic. Types: INFO, FINDING, QUESTION, ANSWER, DECISION, BLOCKER, HANDOFF. Not a transcript, scratchpad, or TODO.",
    promptSnippet: "Post a finding, question, answer, decision, blocker, or handoff",
    promptGuidelines: [
      "Use board_post for findings, questions, answers, decisions, blockers, and handoffs. Keep posts short and evidence-oriented. Do not post transcripts, raw reasoning, or TODO steps.",
    ],
    parameters: Type.Object(
      {
        topicId: Type.Number({ description: "Topic id" }),
        type: PostTypeSchema,
        subject: Type.Optional(Type.String({ description: "Optional short subject" })),
        content: Type.String({ description: "The finding, question, answer, decision, blocker, or handoff" }),
        replyTo: Type.Optional(Type.Number({ description: "Post id in the same topic" })),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "JSON object, for example {\"supersedes\": 17}" })),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (board, workspace) => {
        const post = board.post(workspace, params);
        return { text: formatPostLine(post), details: { postId: post.id, topicId: post.topicId, type: post.type } };
      });
    },
  });

  pi.registerTool({
    name: "board_query",
    label: "Query Board",
    description: `Search Board posts in the current workspace by topic, type, author, or text. Default limit ${LIMITS.queryDefault}, max ${LIMITS.queryMax}. SQL text match only.`,
    promptSnippet: "Search current-workspace Board posts",
    promptGuidelines: [
      "Use board_query before posting duplicate information. Do not load the entire Board when a focused query is enough.",
    ],
    parameters: Type.Object(
      {
        topicId: Type.Optional(Type.Number()),
        type: Type.Optional(PostTypeSchema),
        author: Type.Optional(Type.String()),
        text: Type.Optional(Type.String({ description: "Match subject or content" })),
        limit: Type.Optional(Type.Number({ description: `Max posts. Default ${LIMITS.queryDefault}, hard max ${LIMITS.queryMax}.` })),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (board, workspace) => {
        const result = board.query(workspace, params);
        return { text: formatQuery(result), details: { postIds: result.posts.map((post) => post.id), total: result.total, limit: result.limit } };
      });
    },
  });

  pi.registerCommand("board", {
    description: "List open Board topics, or /board <id> to read one topic",
    handler: async (args, ctx) => {
      await inspectBoard(args, ctx);
    },
  });
}

async function inspectBoard(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const text = args.trim();
  let board: Board | undefined;
  try {
    board = await openBoard();
    const workspace = currentWorkspace(ctx.cwd);
    if (text.length === 0) {
      report(ctx, formatTopicList(board.listTopics(workspace, {})));
      return;
    }
    if (!/^[1-9]\d*$/.test(text)) {
      report(ctx, "Usage: /board or /board <topicId>", "error");
      return;
    }
    report(ctx, formatTopicRead(board.readTopic(workspace, Number(text), {})));
  } catch (error) {
    report(ctx, error instanceof Error ? error.message : String(error), "error");
  } finally {
    board?.close();
  }
}

async function run(
  ctx: { cwd: string },
  action: (board: Board, workspace: string) => { text: string; details: Record<string, unknown> },
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }> {
  let board: Board | undefined;
  try {
    board = await openBoard();
    const result = action(board, currentWorkspace(ctx.cwd));
    return { content: [{ type: "text", text: result.text }], details: result.details };
  } catch (error) {
    const message = error instanceof BoardError ? error.message : error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      details: { error: message },
      isError: true,
    };
  } finally {
    board?.close();
  }
}

export function formatTopicCreated(topic: Pick<Topic, "id" | "status" | "title">): string {
  return `#${topic.id} [${topic.status}] ${topic.title}`;
}

export function formatTopicList(listed: TopicList): string {
  const cap = listed.capped ? ` Limit capped at ${listed.limit}.` : "";
  if (listed.topics.length === 0) return `No ${listed.status} topics in this workspace.${cap}`;
  const lines = listed.topics.map(
    (topic) => `#${topic.id} [${topic.status}] ${topic.title} (${topic.postCount} posts, updated ${topic.updatedAt})`,
  );
  const range = listed.total > listed.topics.length ? `Showing ${listed.topics.length} of ${listed.total} ${listed.status} topics.` : `${listed.topics.length} ${listed.status} topic${listed.topics.length === 1 ? "" : "s"}.`;
  return `${range}${cap}\n${lines.join("\n")}`;
}

export function formatTopicRead(page: TopicPage): string {
  const topic = page.topic;
  const lines = [
    formatTopicCreated(topic),
    `scope: ${topic.scope}`,
    `created by ${topic.createdBy} at ${topic.createdAt}`,
    `updated ${topic.updatedAt}`,
  ];
  if (topic.description) lines.push(topic.description);
  lines.push("");
  if (page.posts.length === 0) {
    lines.push(page.total === 0 ? "No posts." : "No posts in this page. Omit beforePostId and afterPostId to read the latest posts.");
  } else {
    const cap = page.capped ? ` Limit capped at ${page.limit}.` : "";
    lines.push(`Posts ${page.posts[0]?.id}-${page.posts[page.posts.length - 1]?.id} (${page.posts.length} of ${page.total}).${cap}`);
    for (const post of page.posts) {
      lines.push("");
      lines.push(formatPost(post));
    }
  }
  if (page.hasOlder && page.posts[0]) lines.push(`Older posts exist. Pass beforePostId ${page.posts[0].id}.`);
  const newest = page.posts[page.posts.length - 1];
  if (page.hasNewer && newest) lines.push(`Newer posts exist. Pass afterPostId ${newest.id}.`);
  return lines.join("\n");
}

export function formatQuery(result: QueryResult): string {
  const cap = result.capped ? ` Limit capped at ${result.limit}.` : "";
  if (result.posts.length === 0) return `No matching posts.${cap}`;
  const lines = [`${result.posts.length} of ${result.total} matching posts.${cap}`];
  for (const post of result.posts) {
    lines.push("");
    lines.push(`#${post.id} ${post.type} topic #${post.topicId} [${post.topicStatus}] ${post.topicTitle}`);
    lines.push(formatPost(post));
  }
  return lines.join("\n");
}

function formatPost(post: Post): string {
  const subject = post.subject ? ` ${post.subject}` : "";
  const reply = post.replyTo ? `\nreply to #${post.replyTo}` : "";
  const metadata = post.metadata ? `\nmetadata: ${JSON.stringify(post.metadata)}` : "";
  return `#${post.id} ${post.type} ${post.author} ${post.createdAt}${subject}\n${post.content}${reply}${metadata}`;
}

function formatPostLine(post: Post): string {
  const subject = post.subject ? `: ${post.subject}` : "";
  return `#${post.id} ${post.type} on topic #${post.topicId}${subject}`;
}

function report(ctx: ExtensionCommandContext, message: string, kind: "info" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, kind);
    return;
  }
  if (kind === "error") throw new Error(message);
}
