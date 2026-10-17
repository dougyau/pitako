import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionHistory } from "./history.ts";
import type { createPublicProducer } from "./public-conversation.ts";

export interface ActivityReadOptions {
  after?: number;
  limit?: number;
  briefOffset?: number;
}
export interface ActivityEventRecord {
  sequence: number; kind: string; text: string;
  source: "event-only"; nativeLeafId: string | null;
}
export interface TerminalActivitySnapshot {
  historyId: string; sessionId: string;
  native: { sessionId: string; historyId: string; leafId: string | null; persisted: boolean };
  sequence: number;
  dropped: number; interactionsDropped: number;
  activity: ActivityEventRecord[];
  interactions: Record<string, unknown>[];
  gaps: string[];
  teamWrapper?: string;
}
export interface ResultBriefPage {
  text: string; offset: number; nextOffset: number | null;
  source: "original WorkBrief" | "invocation task";
}
export interface ActivityPage {
  historyId: string; sessionId: string; active: boolean;
  native: TerminalActivitySnapshot["native"];
  workbrief: ResultBriefPage;
  teamWrapper?: string;
  activity: ActivityEventRecord[];
  interactions: Record<string, unknown>[];
  gaps: string[]; cursor: number; more: boolean;
}

export interface LiveHandle {
  publicConversation?: ReturnType<typeof createPublicProducer>;
  historyId: string;
  sessionId: string;
  observe(options?: ActivityReadOptions): Record<string, unknown>;
  input(input: { historyId: string; sessionId: string; intent: "query" | "steer"; text: string; decisionId?: string }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  onTerminalCapture?: (snapshot: TerminalActivitySnapshot) => void;
  onTerminalCaptureFailed?: (reason: "close_failed" | "capture_failed") => void;
  onChange?: () => void;
}

function clip(text: string, bytes: number): string {
  const data = Buffer.from(text);
  return data.length > bytes ? data.subarray(0, bytes).toString("utf8") + "\n[clipped]" : text;
}

/** Event cursors do not paginate receipts or establish native transcript completeness. */
export function readActivitySnapshot(
  snapshot: TerminalActivitySnapshot, originalBrief: string, options: ActivityReadOptions = {},
  briefSource: ResultBriefPage["source"] = "original WorkBrief",
): ActivityPage {
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  const after = options.after ?? Math.max(0, snapshot.sequence - limit);
  const offset = options.briefOffset ?? 0;
  if (!Number.isFinite(limit) || !Number.isSafeInteger(offset) || offset < 0 || offset > originalBrief.length ||
      !Number.isSafeInteger(after) || after < 0 || after > snapshot.sequence) throw new Error("invalid observation cursor");
  // JSON copying also keeps nested receipt/candidate-answer data private.
  const copy: TerminalActivitySnapshot = JSON.parse(JSON.stringify(snapshot));
  const selected = copy.activity.filter(item => item.sequence > after).slice(0, limit);
  const page: ActivityPage = {
    historyId: copy.historyId, sessionId: copy.sessionId, active: false, native: copy.native,
    workbrief: { text: originalBrief.slice(offset, offset + 1024), offset, nextOffset: null, source: briefSource },
    teamWrapper: copy.teamWrapper, activity: selected, interactions: copy.interactions.slice(-limit),
    gaps: [
      ...copy.gaps,
      ...(copy.dropped || (copy.activity[0]?.sequence ?? 0) > after + 1
        ? [`Earlier activity omitted; ring dropped ${copy.dropped} events (including storage omissions).`] : []),
      ...(copy.interactionsDropped ? [`Earlier interactions omitted; ring dropped ${copy.interactionsDropped} receipts (including storage omissions).`] : []),
      ...(copy.activity.some(item => item.text.endsWith("\n[clipped]")) ? ["Activity text clipped to 768-byte event excerpts."] : []),
      ...(copy.interactions.some(item => JSON.stringify(item).includes("[clipped]")) ? ["Interaction receipt excerpts clipped; native markers remain authoritative."] : []),
      ...(copy.teamWrapper?.endsWith("\n[clipped]") ? ["Team wrapper excerpt clipped."] : []),
      ...(briefSource === "invocation task" ? ["Original WorkBrief provenance unavailable; showing invocation task."] : []),
    ],
    cursor: selected.at(-1)?.sequence ?? after,
    more: selected.length > 0 && selected.at(-1)!.sequence < copy.sequence,
  };
  const baseGaps = [...page.gaps];
  let omittedDiagnostics = 0;
  let wrapperClipped = false;
  for (;;) {
    page.workbrief.nextOffset = offset + page.workbrief.text.length < originalBrief.length
      ? offset + page.workbrief.text.length : null;
    page.gaps = [
      ...baseGaps,
      ...(omittedDiagnostics ? [`${omittedDiagnostics} activity diagnostics omitted to fit this page.`] : []),
      ...(copy.interactions.length > page.interactions.length
        ? [`${copy.interactions.length - page.interactions.length} retained interaction receipts omitted from this page; use agent_history for persisted markers.`] : []),
    ];
    if (Buffer.byteLength(JSON.stringify(page)) <= 31 * 1024) return page;
    if (page.activity.length > 1) {
      page.activity.pop(); page.cursor = page.activity.at(-1)!.sequence; page.more = true;
    } else if (page.interactions.length) page.interactions.shift();
    else if (page.workbrief.text.length > 1) page.workbrief.text = page.workbrief.text.slice(0, Math.ceil(page.workbrief.text.length / 2));
    else if (!wrapperClipped && page.teamWrapper && Buffer.byteLength(page.teamWrapper) > 128) {
      wrapperClipped = true;
      page.teamWrapper = clip(page.teamWrapper, 128);
      baseGaps.push("Team wrapper clipped to fit this page.");
    } else if (baseGaps.length) { baseGaps.pop(); omittedDiagnostics++; }
    // Do not truncate native identity or silently skip an event without a cursor.
    else throw new Error("observation page identity or event exceeds budget");
  }
}

/** Private to the driver's exact native session. The row receives only this capability. */
export function createLiveHandle(session: Pick<AgentSession, "sessionId" | "sessionManager" | "sessionFile" | "steer">, history: {
  historyId: string; invocation: Pick<SessionHistory["invocation"], "origin" | "task">; append: SessionHistory["append"];
}, onQueued?: () => void): {
  handle: LiveHandle; open(): void; settle(): Promise<void>; event(event: AgentSessionEvent): void;
  capture(): TerminalActivitySnapshot;
} {
  const sessionId = session.sessionId;
  const historyId = history.historyId;
  let active = false, revoked = false, sequence = 0, dropped = 0, interactionsDropped = 0, assistantObserved = false;
  let closing: Promise<void> | undefined;
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const activity: ActivityEventRecord[] = [];
  const interactions: Array<Record<string, unknown>> = [];
  const append = (kind: string, text: string) => {
    activity.push({ sequence: ++sequence, kind, text: clip(text, 768), source: "event-only", nativeLeafId: session.sessionManager.getLeafId() });
    if (activity.length > 200) { activity.shift(); dropped++; }
  };
  const marker = (receipt: Record<string, unknown>) => {
    history.append("interaction", { ...receipt, nativeEntryId: undefined });
    receipt.nativeEntryId = session.sessionManager.getLeafId();
    handle.onChange?.();
  };
  const settle = async () => {
    active = false; // synchronous admission boundary, before awaiting any hook
    await Promise.allSettled([...pending]);
  };
  const snapshot = (): TerminalActivitySnapshot => {
    const persisted = Boolean(session.sessionFile && existsSync(session.sessionFile));
    return JSON.parse(JSON.stringify({
      historyId, sessionId, sequence, dropped, interactionsDropped, activity, interactions,
      native: { sessionId: session.sessionId, historyId, leafId: session.sessionManager.getLeafId(), persisted },
      teamWrapper: history.invocation.origin?.source === "team_assign" ? clip(history.invocation.task.split("\nWorkBrief:")[0]!, 1024) : undefined,
      gaps: [
        "Activity is coalesced event-only evidence; nativeLeafId is the observed leaf, not proof that this event persisted. Use agent_history for native entries.",
        ...(session.sessionId !== sessionId ? ["Native session changed; this binding is stale and rejects input."] : []),
        ...(!persisted ? ["Before first assistant persistence: native entries may exist only in memory."] : []),
        ...(!assistantObserved ? ["No first assistant observed; file presence alone does not establish native provenance persistence or delivery."] : []),
      ],
    }));
  };
  const handle: LiveHandle = {
    historyId, sessionId,
    observe(options = {}) {
      const original = history.invocation.origin?.workbrief ?? history.invocation.task;
      const page = readActivitySnapshot(snapshot(), original, options, history.invocation.origin?.workbrief === undefined ? "invocation task" : "original WorkBrief");
      return { ...page, active: active && !revoked && session.sessionId === sessionId };
    },
    async input(input) {
      const interactionId = randomUUID();
      const receipt: Record<string, unknown> = { interactionId, historyId, sessionId, intent: input.intent,
        decisionId: input.decisionId ? clip(input.decisionId, 1024) : undefined, status: "pending" };
      if (interactions.length === 200) { interactions.shift(); interactionsDropped++; }
      interactions.push(receipt);
      const reject = (reason: string) => {
        receipt.status = "rejected"; receipt.reason = reason; marker(receipt);
        return receipt;
      };
      if (input.historyId !== historyId || input.sessionId !== sessionId || session.sessionId !== sessionId) return reject("stale native identity");
      if (!active || revoked) return reject("binding is not admitting input");
      if (!input.text.trim() || Buffer.byteLength(input.text) > 16 * 1024) return reject("text must be nonempty and at most 16KiB");
      if (input.decisionId && Buffer.byteLength(input.decisionId) > 1024) return reject("decision ID is too long");
      marker(receipt);
      // Deliberately not a command, even when the submitted text starts with '/'.
      const envelope = `Pitako interaction ${interactionId}\nintent: ${input.intent}${input.decisionId ? `\ndecision_id: ${JSON.stringify(input.decisionId)}` : ""}\nText (not a command):\n${input.text}`;
      const submission = (async () => {
        try {
          const status = await session.steer(envelope, undefined, { source: "extension" });
          receipt.status = status === "handled" ? "handled" : revoked ? "unconfirmed" : status;
          if (status === "queued" && !revoked) onQueued?.();
          receipt.delivery = status === "handled" ? "input hook consumed; not an answer" : "queued; provider delivery not yet confirmed";
        } catch (error) {
          receipt.status = "rejected"; receipt.reason = String(error);
        }
        marker(receipt);
        return { ...receipt };
      })();
      pending.add(submission);
      try { return await submission; } finally { pending.delete(submission); }
    },
    close() {
      if (closing) return closing;
      revoked = true;
      return closing = (async () => {
        await settle();
        for (const receipt of interactions) {
          if (receipt.status === "queued") { receipt.status = "unconfirmed"; receipt.delivery = "session closed; no answer or delivery guarantee"; marker(receipt); }
        }
        closed = true;
      })();
    },
  };
  return {
    handle, settle,
    capture() {
      if (!closed) throw new Error("terminal activity capture requires successful settled close");
      return snapshot();
    },
    open() { if (!revoked && session.sessionId === sessionId) { active = true; handle.onChange?.(); } },
    event(event) {
      if (event.type === "message_end") {
        const message = event.message;
        const text = "content" in message ? (typeof message.content === "string" ? message.content : message.content
          .map(part => "text" in part ? part.text : part.type === "toolCall" ? `${part.name} ${JSON.stringify(part.arguments)}` : "").join("\n"))
          : "summary" in message ? message.summary : message.role === "bashExecution" ? message.output : "";
        append(message.role, text);
        if (message.role === "assistant") {
          assistantObserved = true;
          for (const receipt of interactions) {
            if (text.includes(String(receipt.interactionId))) {
              receipt.candidateAnswer = { sequence, basis: "reply mentions interaction ID; adequacy not judged" };
            }
          }
        }
        handle.onChange?.();
      } else if (event.type === "tool_execution_start") {
        append("tool_start", event.toolName);
        handle.onChange?.();
      }
      // message_update deltas are coalesced into message_end, never accumulated.
    },
  };
}
