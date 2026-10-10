import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionHistory } from "./history.ts";

export interface LiveHandle {
  historyId: string;
  sessionId: string;
  observe(options?: { after?: number; limit?: number; briefOffset?: number }): Record<string, unknown>;
  input(input: { historyId: string; sessionId: string; intent: "query" | "steer"; text: string; decisionId?: string }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Private to the driver's exact native session. The row receives only this capability. */
export function createLiveHandle(session: Pick<AgentSession, "sessionId" | "sessionManager" | "sessionFile" | "steer">, history: SessionHistory): {
  handle: LiveHandle; open(): void; settle(): Promise<void>; event(event: AgentSessionEvent): void;
} {
  const sessionId = session.sessionId;
  const historyId = history.historyId;
  let active = false, revoked = false, sequence = 0, dropped = 0, interactionsDropped = 0, assistantObserved = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const activity: Array<{ sequence: number; kind: string; text: string; source: "event-only"; nativeLeafId: string | null }> = [];
  const interactions: Array<Record<string, unknown>> = [];
  const clip = (text: string, bytes: number) => {
    const data = Buffer.from(text);
    return data.length > bytes ? data.subarray(0, bytes).toString("utf8") + "\n[clipped]" : text;
  };
  const append = (kind: string, text: string) => {
    activity.push({ sequence: ++sequence, kind, text: clip(text, 768), source: "event-only", nativeLeafId: session.sessionManager.getLeafId() });
    if (activity.length > 200) { activity.shift(); dropped++; }
  };
  const marker = (receipt: Record<string, unknown>) => {
    history.append("interaction", { ...receipt, nativeEntryId: undefined });
    receipt.nativeEntryId = session.sessionManager.getLeafId();
  };
  const settle = async () => {
    active = false; // synchronous admission boundary, before awaiting any hook
    await Promise.allSettled([...pending]);
  };
  const handle: LiveHandle = {
    historyId, sessionId,
    observe(options = {}) {
      const limit = Math.max(1, Math.min(200, options.limit ?? 50));
      const after = options.after ?? Math.max(0, sequence - limit);
      const selected = activity.filter(item => item.sequence > after).slice(0, limit);
      // Budget the *serialized* page, not just individual strings.
      const original = history.invocation.origin?.workbrief ?? history.invocation.task;
      const offset = options.briefOffset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(after) || after < 0) throw new Error("invalid observation cursor");
      const brief = original.slice(offset, offset + 1024);
      const page = {
        historyId, sessionId, active: active && !revoked && session.sessionId === sessionId, workbrief: { text: brief, offset,
          nextOffset: offset + brief.length < original.length ? offset + brief.length : null, source: "original WorkBrief" },
        teamWrapper: history.invocation.origin?.source === "team_assign" ? clip(history.invocation.task.split("\nWorkBrief:")[0]!, 1024) : undefined,
        native: { sessionId: session.sessionId, historyId, leafId: session.sessionManager.getLeafId(),
          persisted: Boolean(session.sessionFile && existsSync(session.sessionFile)) },
        gaps: [
          "Activity is coalesced event-only evidence; nativeLeafId is the observed leaf, not proof that this event persisted. Use agent_history for native entries.",
          ...(session.sessionId !== sessionId ? ["Native session changed; this binding is stale and rejects input."] : []),
          ...(!session.sessionFile || !existsSync(session.sessionFile) ? ["Before first assistant persistence: native entries may exist only in memory."] : []),
          ...(!assistantObserved ? ["No first assistant observed; file presence alone does not establish native provenance persistence or delivery."] : []),
          ...(dropped || (activity[0]?.sequence ?? 0) > after + 1 ? [`Earlier activity omitted; ring dropped ${dropped} events.`] : []),
          ...(interactionsDropped ? [`Earlier interactions omitted; ring dropped ${interactionsDropped} receipts.`] : []),
        ],
        activity: selected,
        interactions: interactions.slice(-limit),
        cursor: selected.at(-1)?.sequence ?? after,
        more: (selected.at(-1)?.sequence ?? after) < sequence,
      };
      while (Buffer.byteLength(JSON.stringify(page)) > 31 * 1024) {
        if (page.activity.length > 1) { page.activity.pop(); page.cursor = page.activity.at(-1)!.sequence; page.more = true; }
        else if (page.interactions.length) page.interactions.shift();
        else break;
      }
      if (interactions.length > page.interactions.length) {
        page.gaps.push(`${interactions.length - page.interactions.length} retained interaction receipts omitted from this page; use agent_history for persisted markers.`);
      }
      return page;
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
      })();
    },
  };
  return {
    handle, settle,
    open() { if (!revoked && session.sessionId === sessionId) active = true; },
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
      } else if (event.type === "tool_execution_start") append("tool_start", event.toolName);
      // message_update deltas are coalesced into message_end, never accumulated.
    },
  };
}
