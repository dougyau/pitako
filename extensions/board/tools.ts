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
import { resolveBoardAuthor } from "./author.ts";
import { currentWorkspace } from "./workspace.ts";
import { currentInstanceId } from "../agent/scope.ts";
import { bindPlanTopic, ledgerFile, parseLedgerBinding, parseLedgerStatus, readPlan, bindingMismatch, withLedgerTeamHoldLock } from "../workflow.ts";
import { teamEvaluationForSession, hasUnsettledTeamWork } from "../team.ts";
import { executionForSession } from "../execution-identity.ts";
import { existsSync, readFileSync } from "node:fs";

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
        const topic = board.createTopic(workspace, params, authorOf(ctx));
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
      "Update a current-workspace topic title, description, or status (open, resolved, closed). Owned topic status changes require the plan lifecycle tool. A DECISION post does not resolve the topic.",
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
    name: "board_workflow_claim",
    label: "Claim Board topic for plan",
    description: "Explicitly bind an existing open Board topic to a draft plan. Does not create or reopen topics.",
    promptSnippet: "Claim an existing Board topic for a plan",
    parameters: Type.Object({ planId: Type.String(), topicId: Type.Number() }, noExtra),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const plan = readPlan(params.planId, ctx.cwd);
        if (plan.meta.boardTopicId !== undefined && plan.meta.boardTopicId !== params.topicId) throw new BoardError("plan Board topic binding does not match requested topic");
        if (plan.meta.boardTopicId === undefined && plan.meta.status !== "draft") throw new BoardError("a frozen plan must contain its Board topic binding before claim");
        return workflowRun(ctx, (board, workspace) => {
          const current = board.readTopic(workspace, params.topicId).topic;
          const ownedTopicId = board.findTopicOwnedByPlan(workspace, plan.meta.id);
          if (ownedTopicId !== undefined && ownedTopicId !== current.id) throw new BoardError(`plan ${plan.meta.id} already owns topic ${ownedTopicId}`);
          if (current.status !== "open") throw new BoardError(`topic ${current.id} must be open before it can be claimed`);
          if (current.ownerPlanId !== null && current.ownerPlanId !== plan.meta.id) {
            throw new BoardError(`topic ${current.id} is already owned by plan ${current.ownerPlanId}`);
          }
          if (plan.meta.status === "frozen" && current.ownerPlanId !== plan.meta.id) {
            throw new BoardError("a frozen bound plan must already own its Board topic");
          }
          const topic = board.claimTopic(workspace, current.id, plan.meta.id);
          if (plan.meta.boardTopicId === undefined) bindPlanTopic(plan.meta.id, current.id, ctx.cwd);
          return { text: formatTopicCreated(topic), details: { topicId: topic.id, ownerPlanId: topic.ownerPlanId } };
        });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "board_workflow_lifecycle",
    label: "Update workflow topic lifecycle",
    description: "Resolve or close only the explicitly bound Board topic owned by a plan. Child sessions cannot call this operation.",
    promptSnippet: "Resolve or close a plan-owned Board topic",
    parameters: Type.Object({ planId: Type.String(), status: StringEnum(["resolved", "closed"] as const) }, noExtra),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (isChildSession(ctx)) return toolError("workflow Board lifecycle cannot be called from a child session");
      try {
        const plan = readPlan(params.planId, ctx.cwd);
        const boardTopicId = plan.meta.boardTopicId;
        if (boardTopicId === undefined) return toolSuccess("Plan has no Board topic; no Board changes made.", { noTopic: true });
        const ledger = ledgerFile(plan.meta.id, ctx.cwd);
        let ledgerStatus: string | undefined;
        if (existsSync(ledger)) {
          const ledgerText = readFileSync(ledger, "utf8");
          const mismatch = bindingMismatch(plan.meta, parseLedgerBinding(ledgerText));
          if (mismatch) throw new BoardError(mismatch);
          ledgerStatus = parseLedgerStatus(ledgerText);
        }
        if (params.status === "resolved") {
          if (ledgerStatus === "USER_DECISION_REQUIRED") throw new BoardError("USER_DECISION_REQUIRED in ledger prohibits resolving the Board topic");
          if (plan.meta.execution === undefined) {
            throw new BoardError("bound frozen plan must declare execution: expected or execution: none before resolving its Board topic");
          }
          if (plan.meta.execution === "expected" && ledgerStatus !== "completed") {
            throw new BoardError("expected execution can resolve its Board topic only after the ledger is completed");
          }
        }
        return run(ctx, (board, workspace) => {
          const transition = () => {
            if (params.status === "resolved") {
              const evaluation = teamEvaluationForSession(ctx.sessionManager?.getSessionId?.(), false);
              if (hasUnsettledTeamWork(evaluation, plan.meta.id, ctx.cwd)) throw new BoardError("Team work for this plan is pending, failed, or cancelled; wait for its successful result or explicitly reconcile the exact ledger hold after documented recovery");
            }
            const topic = board.transitionOwnedTopic(workspace, boardTopicId, plan.meta.id, params.status);
            return { text: formatTopicCreated(topic), details: { topicId: topic.id, status: topic.status } };
          };
          return params.status === "resolved" ? withLedgerTeamHoldLock(ctx.cwd, plan.meta.id, transition) : transition();
        });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "board_post",
    label: "Board post",
    description:
      "Post cross-context knowledge to a current-workspace topic. FINDING: fact or constraint; DECISION: chosen boundary before an authoritative artifact; QUESTION/ANSWER: unresolved cross-context issue and response; BLOCKER: condition preventing another context from continuing correctly; HANDOFF: essential context the next agent needs; INFO: sparse mission context. Not a transcript, scratchpad, TODO, or progress log.",
    promptSnippet: "Post cross-context knowledge to a Board topic",
    promptGuidelines: [
      "Use FINDING for a fact or constraint; DECISION for a chosen boundary before its authoritative artifact; QUESTION/ANSWER for cross-context coordination; BLOCKER only when another context cannot correctly continue; HANDOFF only for essential next-context knowledge; INFO sparingly for mission context.",
      "Do not post progress, status, test counts, heartbeats, or ordinary worker events: HANDOFF: T3 done, 44 tests pass is invalid. Ledger and evidence own progress; once knowledge is absorbed, the plan, code, tests, or docs are authoritative. Board stays pull-based.",
      "Do not post transcripts, raw reasoning, TODO steps, or execution-local blockers when the ledger suffices.",
    ],
    parameters: Type.Object(
      {
        topicId: Type.Number({ description: "Topic id" }),
        type: PostTypeSchema,
        subject: Type.Optional(Type.String({ description: "Optional short subject" })),
        content: Type.String({ description: "Cross-context knowledge: finding, question, answer, decision, blocker, handoff, or sparse mission context" }),
        replyTo: Type.Optional(Type.Number({ description: "Post id in the same topic" })),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "JSON object, for example {\"supersedes\": 17}" })),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (board, workspace) => {
        const post = board.post(workspace, params, authorOf(ctx));
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

function authorOf(ctx: { sessionManager?: { getSessionId(): string } }): string {
  return resolveBoardAuthor(ctx.sessionManager?.getSessionId());
}

async function run(
  ctx: { cwd: string; sessionManager?: { getSessionId?: () => string } },
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

function isChildSession(ctx: { sessionManager?: { getSessionId?: () => string } }): boolean {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  return Boolean(currentInstanceId() || process.env.PITAKO_INSTANCE_ID || executionForSession(sessionId));
}

function workflowRun(
  ctx: { cwd: string; sessionManager?: { getSessionId?: () => string } },
  action: (board: Board, workspace: string) => { text: string; details: Record<string, unknown> },
) {
  if (isChildSession(ctx)) return Promise.resolve(toolError("workflow Board operations cannot be called from a child session"));
  return run(ctx, action);
}

function toolSuccess(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: { error: message }, isError: true };
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
    `owner plan: ${topic.ownerPlanId ?? "none"}`,
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
