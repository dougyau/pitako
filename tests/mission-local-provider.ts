import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";

export interface LocalProviderTraceRow {
  sessionId: string;
  provider: string;
  model: string;
  prompt: string;
  messageCount: number;
  response: string;
  cost: number;
  toolCount: number;
}

export interface LocalProviderFixture {
  provider: string;
  model: string;
  trace: LocalProviderTraceRow[];
  flush(file: string): void;
}

export async function installMissionLocalProvider(options: {
  agentDir: string;
  provider?: string;
  model?: string;
  additionalModels?: string[];
  responseForPrompt?: (prompt: string) => string;
  responseGate?: (prompt: string, signal?: AbortSignal) => Promise<void>;
  errorForRequest?: (prompt: string, model: string, afterTool: boolean, signal?: AbortSignal) => string | undefined;
  toolForPrompt?: (prompt: string) => { name: string; arguments: Record<string, unknown> } | undefined;
  modelFromJson?: { cost?: Model<"openai-completions">["cost"] };
  usage?: Partial<Usage>;
  terminalCost?: number;
  omitUsage?: boolean;
}): Promise<LocalProviderFixture> {
  const provider = options.provider ?? "pitako-mission-local";
  const model = options.model ?? "fixture";
  const modelDefinition = {
    id: model, name: "Mission fixture", reasoning: false, input: ["text"],
    contextWindow: 2048, maxTokens: 64,
  };
  if (options.modelFromJson) {
    mkdirSync(options.agentDir, { recursive: true });
    writeFileSync(path.join(options.agentDir, "models.json"), JSON.stringify({ providers: {
      [provider]: { baseUrl: "http://127.0.0.1", apiKey: "local-fixture", api: "openai-completions",
        models: [{ ...modelDefinition, ...options.modelFromJson }] },
    } }));
  }
  mkdirSync(path.join(options.agentDir, "extensions"), { recursive: true });
  writeFileSync(
    path.join(options.agentDir, "extensions", "mission-local-provider.js"),
    `export default function (pi) { pi.registerProvider(${JSON.stringify(provider)}, globalThis[${JSON.stringify(`__${provider.replace(/\W/g, "_")}`)}]); }\n`,
  );
  const trace: LocalProviderTraceRow[] = [];
  const globalKey = `__${provider.replace(/\W/g, "_")}`;
  const eventStreamModule: string = "@earendil-works/pi-ai/utils/event-stream";
  const { createAssistantMessageEventStream } = await import(eventStreamModule);
  (globalThis as Record<string, unknown>)[globalKey] = {
    baseUrl: "http://127.0.0.1",
    apiKey: "local-fixture",
    api: "openai-completions",
    ...(options.modelFromJson ? {} : { models: [model, ...options.additionalModels ?? []].map((id) => ({
      ...modelDefinition, id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })) }),
    streamSimple(
      selected: Model<"openai-completions">,
      context: { messages?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>; tools?: unknown[] },
      request: { sessionId?: string; signal?: AbortSignal } = {},
    ) {
      const prompt = [...(context.messages ?? [])].reverse().find((message) => message.role === "user")?.content
        ?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
      const text = options.responseForPrompt?.(prompt) ?? "Local fixture response. No product files changed.";
      const tool = context.messages?.at(-1)?.role === "user" ? options.toolForPrompt?.(prompt) : undefined;
      const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      const usage = { input: 17, output: 8, cacheRead: 2, cacheWrite: 0, totalTokens: 27, cost, ...options.usage };
      calculateCost(selected, usage);
      if (options.terminalCost !== undefined) usage.cost.total = options.terminalCost;
      trace.push({
        sessionId: request.sessionId ?? "missing-session-id",
        provider,
        model: selected.id,
        prompt,
        messageCount: context.messages?.length ?? 0,
        response: text,
        cost: usage.cost.total,
        toolCount: context.tools?.length ?? 0,
      });
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: tool ? [{ type: "toolCall", id: `fixture-tool-${trace.length}`, ...tool }] : [{ type: "text", text }],
        api: "openai-completions",
        provider,
        model: selected.id,
        stopReason: tool ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: options.omitUsage ? undefined : usage,
      };
      queueMicrotask(async () => {
        await options.responseGate?.(prompt, request.signal);
        const failure = options.errorForRequest?.(prompt, selected.id, context.messages?.at(-1)?.role === "toolResult", request.signal);
        if (failure) {
          const error = { ...message, content: [], stopReason: request.signal?.aborted ? "aborted" : "error", errorMessage: failure };
          stream.push({ type: "error", reason: error.stopReason, error } as never);
          stream.end(error as never);
          return;
        }
        const partial = { ...message, content: [{ type: "text", text: "" }] };
        stream.push({ type: "start", partial } as never);
        stream.push({ type: "text_start", contentIndex: 0, partial } as never);
        partial.content[0]!.text = text;
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial } as never);
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial } as never);
        stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message } as never);
        stream.end(message as never);
      });
      return stream;
    },
  };
  return {
    provider,
    model,
    trace,
    flush(file) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ format: "mission-local-provider-trace-v1", trace }, null, 2)}\n`);
    },
  };
}
