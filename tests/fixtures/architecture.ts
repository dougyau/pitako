import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pitako from "../../extensions/index.ts";
import agent from "../../extensions/agent/index.ts";
import { createPiExecutor } from "../../extensions/agent/pi.ts";
import { setBackgroundExecutor, cancelAllWorkers, clearBackgroundOwner, workerHandoff } from "../../extensions/agent/background.ts";
import { subscribeChanges } from "../../extensions/agent/observe.ts";
import { teamEvaluationForSession, retireTeamEvaluation } from "../../extensions/team.ts";
import { controlledPi, controlledModel } from "./pi-factories.ts";
import { agentFixtureOwnership } from "./agent-fixture-ownership.ts";
import { executionForSession } from "../../extensions/execution-identity.ts";
import type { describeObject } from "../../extensions/review/object.ts";
import { jsonBytes } from "../../extensions/table/results.ts";

/** Decode only our controlled context transport, not a source of host authority. */
export function tablePrompt(text: string) {
  const projection = JSON.parse(text).projection as string;
  return projection.startsWith("{") ? JSON.parse(projection) : { kind: "continuation", note: projection };
}

/** Test-only full reconstruction. Production consumers request pertinent sections, never auto-load. */
export async function readCanonical(invoke: (name: string, params: any) => Promise<any>, name: string, params: any, first?: any) {
  const { section: _section, maxBytes: _budget, cursor: _cursor, ...target } = params;
  let page = first ?? await invoke(name, params), canonical = "";
  const cut = JSON.parse(page.content[0].text).header.id;
  do {
    expect(page.isError).not.toBe(true);
    const payload = JSON.parse(page.content[0].text);
    expect(payload.header.id).toBe(cut);
    expect(jsonBytes(page)).toBeLessThanOrEqual(payload.header.maxBytes);
    expect(jsonBytes(payload.header)).toBeLessThanOrEqual(2048);
    expect(payload.header.offset).toBe(canonical.length);
    canonical += payload.fragment;
    if (!payload.header.cursor) return JSON.parse(canonical);
    page = await invoke(name, { ...target, cursor: payload.header.cursor });
  } while (true);
}

/** Read only the single projected result set, never a second host-grant copy. */
export function reviewResults(request: any) {
  const messages = request.context.shared?.messages ?? request.context.messages ?? request.context.sources ?? [];
  return {
    findings: messages.flatMap((message: any) => message.body.findings ?? []),
    responses: messages.flatMap((message: any) => (message.body.responses ?? []).map((response: any) =>
      ({ ...response, memberId: message.memberId, messageId: message.id }))),
  };
}

export function architectureFixture(protocol: "architecture" | "review" = "architecture") {
  const fixture = agentFixtureOwnership();
  const deferred = <T = void>() => Promise.withResolvers<T>();
  const policies = `[model_policies.architect]
  primary = { model = "fixture/director", reasoning = "low" }
  [model_policies.reviewer]
  primary = { model = "fixture/director", reasoning = "low" }
  [model_policies.scout]
  primary = { model = "fixture/support" }
  [model_policies.researcher]
  primary = { model = "fixture/support" }
  [model_policies.oracle]
  primary = { model = "fixture/support" }
  `;
  const configuration = `[${protocol}]
  candidates = [{ model = "fixture/general" }]
  [[${protocol}.topics]]
  topic = "security"
  candidates = [{ model = "fixture/chosen", reasoning = "high" }, { model = "fixture/chosen", reasoning = "low" }, { model = "fixture/other" }]
  `;
  async function setup(extra: { root?: string; storageRoot?: string; config?: string; policies?: string; busy?: boolean;
    configure?: (host: ReturnType<typeof controlledPi>) => void;
    explore?: (object: ReturnType<typeof describeObject>) => unknown;
    prompt?: (session: any, request: any, body: any) => Promise<any> | any; afterSubmit?: (session: any, request: any, receipt: any) => Promise<void> | void; abort?: (session: any) => Promise<void>; dispose?: (session: any) => Promise<void>; bind?: (session: any) => Promise<void> | void; extensions?: any[] } = {}) {
    const root = extra.root ?? mkdtempSync(path.join(tmpdir(), "pitako-architecture-"));
    if (!extra.root) fixture.directories.push(root);
    const storageRoot = extra.storageRoot ?? root;
    process.env.PI_CODING_AGENT_DIR = storageRoot;
    mkdirSync(path.join(storageRoot, "pitako"), { recursive: true }); writeFileSync(path.join(storageRoot, "pitako/config.toml"), (extra.policies ?? policies) + (extra.config ?? configuration));
    const sessionId = path.basename(root), branch: any[] = [], sent: any[] = [], tools = new Map<string, any>(), hooks = new Map<string, Function[]>(), commands = new Map<string, any>();
    const file = path.join(storageRoot, "coordinator.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root }) + "\n");
    let idle = !extra.busy;
    const delivered = deferred(), response = deferred();
    const pi = { registerFlag() {}, registerCommand(name: string, definition: any) { commands.set(name, definition); }, getFlag() {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, getSessionName() {}, setSessionName() {},
      registerTool(definition: any) { tools.set(definition.name, definition); },
      on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
      sendMessage(message: any, options: any) {
        sent.push({ message, options });
        branch.push({ type: "custom_message", ...message });
        if (!options.triggerTurn) { if (message.customType === "pitako.worker.result") delivered.resolve(); else response.resolve(); }
      },
    } as unknown as ExtensionAPI;
    pitako(pi); agent(pi);
    const ctx: any = { cwd: root, hasUI: false, isIdle: () => idle, waitForIdle: async () => {}, ui: { notify() {}, setStatus() {} },
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file, getBranch: () => branch, getEntries: () => [] } };
    const emit = async (name: string, event: any = {}) => {
      let answer: any;
      for (const handler of hooks.get(name) ?? []) { const value = await handler(event, ctx); if (value !== undefined) answer = value; }
      return answer;
    };
    await emit("session_start");
    const evaluation = teamEvaluationForSession(sessionId, false)!;
    const knowledge: ReturnType<typeof deferred>[] = Array.from({ length: 8 }, () => deferred()); let knowledgeIndex = 0;
    const seen: { session: any; request: any; receipt: any; levels: string; model: string; exploration?: unknown }[] = [];
    const host = controlledPi(storageRoot, { inlineExtensions: true, bind: extra.bind, extensions: extra.extensions,
      models: ["director", "chosen", "other", "general", "support"].map(id => controlledModel("fixture", id)),
      async prompt(session, text) {
        // controlledPi has no event loop; drive the native turn admission/settlement hooks.
        for (const handler of session.hooks.get("turn_start") ?? []) await handler({ type: "turn_start" }, { sessionManager: session.sessionManager });
        try {
          const request = [...session.prompts].reverse().map(tablePrompt).find(item => item.stage)!;
          const review = request.protocol === "Pitako review";
          expect(request).not.toHaveProperty("journal");
          expect(request).not.toHaveProperty("publications");
          expect(request).not.toHaveProperty("review");
          if (request.stage !== "composition") expect(request).not.toHaveProperty("snapshot");
          const privateKeys = ["snapshotId", "submissionId", "native", "attemptId", "turnId", "historyId", "sessionId", "toolCallId", "instanceId", "assignmentId", "captureId"];
          const leaked: string[] = [];
          const inspect = (value: unknown) => {
            if (!value || typeof value !== "object") return;
            for (const [key, child] of Object.entries(value)) { if (privateKeys.includes(key)) leaked.push(key); inspect(child); }
          };
          inspect(request);
          expect(leaked).toEqual([]);
          if (review) {
            expect(request.object).not.toHaveProperty("scope");
            expect(request.object).not.toHaveProperty("files");
            expect(request.object).not.toHaveProperty("contentBase64");
          }
          const exploration = review ? extra.explore?.(request.object) : undefined;
          const body = request.stage === "composition" ? { kind: "composition", reason: "Security expertise is useful",
            specialists: [{ kind: "add", candidateRef: "topic:0:0", mandate: "Review security", reason: "Relevant expertise" }] }
            : review && request.stage === "preparation" ? { kind: "preparation", analysis: "Independent whole-object review", findings: [], doubts: [] }
            : review && request.stage === "contribution" ? { kind: "contribution", analysis: "Review incoming evidence", findings: [], responses: [], doubts: [] }
            : request.stage === "preparation" ? { kind: "preparation", analysis: "Independent whole-goal architectural analysis", doubts: [] }
            : request.stage === "contribution" ? { kind: "contribution", proposal: "Use a bounded design", arguments: ["Preserve existing ownership"], objections: [], doubts: [] }
            : request.stage === "decision" ? { kind: "decision", action: "synthesize", reason: "Sufficient observations" }
            : review && request.stage === "synthesis" ? { kind: "synthesis", completion: "complete", verdict: "no-blockers", summary: "Reviewed complete object",
              dispositions: reviewResults(request).findings.map((finding: any) => ({ findingId: finding.id, status: "upheld", reason: "Reachable failure", references: [finding.messageId] })),
              newFindings: [], evidence: [], limits: [], pending: [] }
            : request.stage === "consultation-plan" ? { kind: "consultation-plan", resolutions: [], support: [] }
            : request.stage === "knowledge" ? { kind: "knowledge", resolutions: [] }
            : { kind: "synthesis", status: "complete", recommendation: "Use the bounded design", alternatives: [], evidence: [], assumptions: [], disagreements: [], pending: [] };
          const chosen = await extra.prompt?.(session, request, body) ?? body;
          if (chosen !== false) {
            expect(executionForSession(session.sessionId)?.profile).toBe("analysis");
            for (const name of ["read", "grep", "find", "ls", "bash"]) expect(session.active).toContain(name);
            expect(session.active).not.toContain("edit"); expect(session.active).not.toContain("write");
            const receipt = await session.boundTools.get(`${review ? "review" : "architecture"}_submit`)!.execute("native-submit", { body: chosen }, undefined, undefined, { sessionManager: session.sessionManager });
            seen.push({ session, request, receipt, levels: session.thinkingLevel, model: session.model!.id, exploration });
            expect(receipt.isError).not.toBe(true);
            await extra.afterSubmit?.(session, request, receipt);
          }
          const message = { role: "assistant", content: [{ type: "text", text: "submitted" }], stopReason: "stop", model: session.model!.id, provider: "fixture", api: "openai-completions", timestamp: Date.now() };
          session.messages.push(message); session.sessionManager.appendMessage(message as never); session.emit({ type: "message_end", message });
          // A cycle has no authored knowledge turn when all doubts were resolved directly.
          if (request.stage === "knowledge" || request.stage === "consultation-plan" && chosen.support?.length === 0) knowledge[knowledgeIndex++]!.resolve();
        } finally {
          for (const handler of session.hooks.get("agent_before_settle") ?? []) await handler({ type: "agent_before_settle" }, { sessionManager: session.sessionManager });
        }
      }, abort: extra.abort, dispose: extra.dispose });
    extra.configure?.(host);
    host.factories.createSettings = () => ({ getModelThinkingLevel: () => "minimal", getDefaultThinkingLevel: () => "off" }) as never;
    setBackgroundExecutor(createPiExecutor({ factories: host.factories }));
    const invoke = (name: string, params: any, signal?: AbortSignal) => tools.get(name).execute(name + "-call", params, signal, undefined, ctx);
    const read = (name: string, params: any, first?: any) => readCanonical(invoke, name, params, first);
    return { root, pi, ctx, emit, invoke, read, tools, commands, branch, sent, evaluation, host, seen, knowledge, delivered, response,
      async bookkeeping(instanceId: string) {
        let stop = () => {};
        try {
          await new Promise<void>((resolve, reject) => {
            const inspect = () => {
              const handoff = workerHandoff(instanceId);
              if (!handoff || handoff.bookkeeping === "pending") return;
              if (handoff.bookkeeping === "blocked") reject(new Error(handoff.bookkeepingDiagnostic));
              else resolve();
            };
            stop = subscribeChanges(row => { if (row.id === instanceId) inspect(); });
            inspect();
          });
        } finally { stop(); }
      },
      setIdle(value: boolean) { idle = value; },
      async close() { await emit("session_shutdown"); await retireTeamEvaluation(evaluation); await cancelAllWorkers(); clearBackgroundOwner(); setBackgroundExecutor(undefined); } };
  }

  return { fixture, setup, policies, configuration };
}
