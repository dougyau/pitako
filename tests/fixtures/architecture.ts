import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pitako from "../../extensions/index.ts";
import agent from "../../extensions/agent/index.ts";
import { createPiExecutor } from "../../extensions/agent/pi.ts";
import { setBackgroundExecutor, cancelAllWorkers, clearBackgroundOwner } from "../../extensions/agent/background.ts";
import { teamEvaluationForSession, retireTeamEvaluation } from "../../extensions/team.ts";
import { controlledPi, controlledModel } from "./pi-factories.ts";
import { agentFixtureOwnership } from "./agent-fixture-ownership.ts";
import { executionForSession } from "../../extensions/execution-identity.ts";

export function architectureFixture() {
  const fixture = agentFixtureOwnership();
  const deferred = <T = void>() => Promise.withResolvers<T>();
  const policies = `[model_policies.architect]
  primary = { model = "fixture/director", reasoning = "low" }
  [model_policies.scout]
  primary = { model = "fixture/support" }
  [model_policies.researcher]
  primary = { model = "fixture/support" }
  [model_policies.oracle]
  primary = { model = "fixture/support" }
  `;
  const configuration = `[architecture]
  candidates = [{ model = "fixture/general" }]
  [[architecture.topics]]
  topic = "security"
  candidates = [{ model = "fixture/chosen", reasoning = "high" }, { model = "fixture/chosen", reasoning = "low" }, { model = "fixture/other" }]
  `;
  async function setup(extra: { root?: string; config?: string; busy?: boolean; prompt?: (session: any, request: any, body: any) => Promise<any> | any; afterSubmit?: (session: any, request: any, receipt: any) => Promise<void> | void; abort?: (session: any) => Promise<void>; dispose?: (session: any) => Promise<void>; bind?: (session: any) => Promise<void> | void; extensions?: any[] } = {}) {
    const root = extra.root ?? mkdtempSync(path.join(tmpdir(), "pitako-architecture-"));
    if (!extra.root) fixture.directories.push(root);
    process.env.PI_CODING_AGENT_DIR = root;
    mkdirSync(path.join(root, "pitako"), { recursive: true }); writeFileSync(path.join(root, "pitako/config.toml"), policies + (extra.config ?? configuration));
    const sessionId = path.basename(root), branch: any[] = [], sent: any[] = [], tools = new Map<string, any>(), hooks = new Map<string, Function[]>();
    const file = path.join(root, "coordinator.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root }) + "\n");
    let idle = !extra.busy;
    const delivered = deferred(), response = deferred();
    const pi = { registerFlag() {}, registerCommand() {}, getFlag() {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, getSessionName() {}, setSessionName() {},
      registerTool(definition: any) { tools.set(definition.name, definition); },
      on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
      sendMessage(message: any, options: any) {
        sent.push({ message, options });
        if (!options.triggerTurn) { branch.push({ type: "custom_message", ...message }); if (message.customType === "pitako.worker.result") delivered.resolve(); else response.resolve(); }
      },
    } as unknown as ExtensionAPI;
    pitako(pi); agent(pi);
    const ctx: any = { cwd: root, hasUI: false, isIdle: () => idle, ui: { notify() {}, setStatus() {} },
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file, getBranch: () => branch, getEntries: () => [] } };
    const emit = async (name: string, event: any = {}) => {
      let answer: any;
      for (const handler of hooks.get(name) ?? []) { const value = await handler(event, ctx); if (value !== undefined) answer = value; }
      return answer;
    };
    await emit("session_start");
    const evaluation = teamEvaluationForSession(sessionId, false)!;
    const knowledge: ReturnType<typeof deferred>[] = Array.from({ length: 8 }, () => deferred()); let knowledgeIndex = 0;
    const seen: { session: any; request: any; receipt: any; levels: string; model: string }[] = [];
    const host = controlledPi(root, { inlineExtensions: true, bind: extra.bind, extensions: extra.extensions,
      models: ["director", "chosen", "other", "general", "support"].map(id => controlledModel("fixture", id)),
      async prompt(session, text) {
        // controlledPi has no event loop; drive the native turn admission/settlement hooks.
        for (const handler of session.hooks.get("turn_start") ?? []) await handler({ type: "turn_start" }, { sessionManager: session.sessionManager });
        try {
          const request = JSON.parse(text.startsWith("{") ? text : [...session.prompts].reverse().find((prompt: string) => prompt.startsWith("{"))!);
          const body = request.stage === "composition" ? { kind: "composition", snapshotId: request.snapshot.id, specialists: [{ candidateRef: "topic:0:0", mandate: "Review security", reason: "Relevant expertise" }] }
            : request.stage === "answer" ? { kind: "answer", answer: "A".repeat(20000) + "🧠", evidence: ["source"], limits: [], doubts: [] }
            : request.stage === "consultation-plan" ? { kind: "consultation-plan", resolutions: [], support: [] }
            : request.stage === "knowledge" ? { kind: "knowledge", resolutions: [] }
            : { kind: "synthesis", status: "complete", recommendation: "Use the bounded design", alternatives: [], evidence: [], assumptions: [], disagreements: [], pending: [] };
          const chosen = await extra.prompt?.(session, request, body) ?? body;
          if (chosen !== false) {
            expect(executionForSession(session.sessionId)?.profile).toBe("analysis");
            expect(session.active).not.toContain("edit"); expect(session.active).not.toContain("write");
            const receipt = await session.boundTools.get("architecture_submit")!.execute("native-submit", { submissionId: `submit-${session.prompts.length}`, body: chosen }, undefined, undefined, { sessionManager: session.sessionManager });
            seen.push({ session, request, receipt, levels: session.thinkingLevel, model: session.model!.id });
            expect(receipt.isError).not.toBe(true);
            await extra.afterSubmit?.(session, request, receipt);
          }
          const message = { role: "assistant", content: [{ type: "text", text: "submitted" }], stopReason: "stop", model: session.model!.id, provider: "fixture", api: "openai-completions", timestamp: Date.now() };
          session.messages.push(message); session.sessionManager.appendMessage(message as never); session.emit({ type: "message_end", message });
          if (request.stage === "knowledge") knowledge[knowledgeIndex++]!.resolve();
        } finally {
          for (const handler of session.hooks.get("agent_before_settle") ?? []) await handler({ type: "agent_before_settle" }, { sessionManager: session.sessionManager });
        }
      }, abort: extra.abort, dispose: extra.dispose });
    host.factories.createSettings = () => ({ getModelThinkingLevel: () => "minimal", getDefaultThinkingLevel: () => "off" }) as never;
    setBackgroundExecutor(createPiExecutor({ factories: host.factories }));
    const invoke = (name: string, params: any, signal?: AbortSignal) => tools.get(name).execute(name + "-call", params, signal, undefined, ctx);
    return { root, pi, ctx, emit, invoke, tools, branch, sent, evaluation, host, seen, knowledge, delivered, response,
      setIdle(value: boolean) { idle = value; },
      async close() { await emit("session_shutdown"); await retireTeamEvaluation(evaluation); await cancelAllWorkers(); clearBackgroundOwner(); setBackgroundExecutor(undefined); } };
  }

  return { fixture, setup, policies, configuration };
}
