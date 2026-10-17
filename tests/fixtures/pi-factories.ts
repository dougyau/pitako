import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createPiExecutor } from "../../extensions/agent/pi.ts";

type Factories = NonNullable<Parameters<typeof createPiExecutor>[0]>["factories"];
type Session = {
    sessionId: string; readonly sessionFile: string | undefined; sessionManager: AgentSession["sessionManager"]; messages: any[]; model?: Model<any>;
    thinkingLevel: any; isStreaming: boolean; events: string[]; prompts: string[]; active: string[];
    stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
      cost: number; assistantMessages: number; toolCalls: number; contextUsage: { tokens: number } };
    agent: { streamFunction: any };
    emit(event: any): void; prompt(text: string): Promise<void>; abort(): Promise<void>; dispose(): Promise<void>;
    tools: Map<string, { definition: any }>; boundTools: Map<string, any>; hooks: Map<string, Function[]>;
    settingsManager: any; setModel(model: Model<any>): Promise<void>; setThinkingLevel(level: any): void;
    getAllTools(): Array<{ name: string }>; setActiveToolsByName(names: string[]): void;
    subscribe(listener: (event: any) => void): () => void; getSessionStats(): any;
    bindExtensions(): Promise<void>; extensionRunner: { emit(event: any): Promise<void> };
  };
export const controlledModel = (provider = "fixture", id = "selected", api = "openai-completions"): Model<any> => ({
  provider, id, api, name: id, baseUrl: "http://controlled.invalid", reasoning: true, input: ["text"],
  contextWindow: 1000, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
export const controlledRole = {
  id: "developer", name: "Developer", description: "controlled adapter", instructionsPath: "roles/developer.md",
  instructions: "Reply exactly.", skills: [], principles: [], modelPolicyId: "developer",
  modelPolicy: { id: "developer", fallbacks: [] },
};

/** Factory responses only; tests drive callbacks/events explicitly, not a Pi event loop. */
export function controlledPi(root: string, options: {
  inlineExtensions?: boolean;
  models?: Model<any>[];
  bind?: (session: Session) => Promise<void> | void;
  prompt?: (session: Session, text: string) => Promise<void> | void;
  dispose?: (session: Session) => Promise<void> | void;
  abort?: (session: Session) => Promise<void> | void;
  extensions?: Array<{ resolvedPath: string; tools: Map<string, { definition: any }> }>;
} = {}) {
  const models = options.models ?? [controlledModel()];
  const sessions: Session[] = [];
  const loaderInputs: any[] = [], sessionInputs: any[] = [], runtimeInputs: any[] = [];
  const runtime = {
    getModel(provider: string, id: string) { return models.find(model => model.provider === provider && model.id === id); },
    streamSimple: (model: any, _context: any, _options?: any): any => (async function* () {
      yield { type: "done", reason: "stop", message: { role: "assistant", content: [], ...model, stopReason: "stop" } };
    })(),
    async prepareRequest(model: any, requestOptions: any) {
      return { model, options: requestOptions, provider: { streamSimple: runtime.streamSimple } };
    },
  };
  const loaders = new WeakMap<object, { tools: Map<string, { definition: any }>; hooks: Map<string, Function[]>; manager?: any }>();
  const factories: Required<Factories> = {
    async createRuntime(input) { runtimeInputs.push(input); return { ...runtime } as never; },
    getAgentDir: () => root,
    createSettings: () => ({ getModelThinkingLevel() {}, getDefaultThinkingLevel() {} }) as never,
    createCodemode: () => () => {},
    createLoader(input) {
      loaderInputs.push(input);
      const local = { tools: new Map<string, { definition: any }>(), hooks: new Map<string, Function[]>(), manager: undefined as any };
      const loader = {
        async reload() {
          if (options.inlineExtensions) for (const extension of input.extensionFactories ?? []) await (typeof extension === "function" ? extension : extension.factory)({
            registerTool(definition: any) { local.tools.set(definition.name, { definition }); },
            on(name: string, handler: Function) { local.hooks.set(name, [...local.hooks.get(name) ?? [], handler]); },
            appendEntry(type: string, data: unknown) { local.manager.appendCustomEntry(type, data); },
          } as never);
        },
        getExtensions: () => ({ extensions: [...options.extensions ?? [], ...(options.inlineExtensions ? [{ resolvedPath: "controlled-inline", tools: local.tools }] : [])], errors: [] }),
      };
      loaders.set(loader, local);
      return loader as never;
    },
    async createSession(input) {
      sessionInputs.push(input);
      const listeners = new Set<(event: any) => void>();
      const manager = input!.sessionManager!;
      const sessionRuntime = input!.modelRuntime!;
      const local = loaders.get(input!.resourceLoader!)!;
      local.manager = manager;
      const session: Session = {
        sessionId: manager.getSessionId(), get sessionFile() { return manager.getSessionFile(); }, sessionManager: manager, model: input!.model,
        tools: local.tools, boundTools: new Map(), hooks: local.hooks,
        messages: [], thinkingLevel: input!.thinkingLevel, isStreaming: false, events: [], prompts: [], active: [],
        stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, assistantMessages: 0, toolCalls: 0, contextUsage: { tokens: 17 } },
        agent: { streamFunction: (...args: any[]) => sessionRuntime.streamSimple(...args as [any, any, any]) },
        settingsManager: input!.settingsManager,
        async setModel(model) { session.model = model; },
        setThinkingLevel(level) { session.thinkingLevel = level; },
        getAllTools: () => ["read", "grep", "find", "ls", "bash", "edit", "write", "agent_run", ...options.extensions?.flatMap(extension => [...extension.tools.keys()]) ?? [],
          ...input!.customTools?.map(tool => tool.name) ?? [], ...local.tools.keys()].map(name => ({ name })),
        setActiveToolsByName(names) { session.active = names; },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        getSessionStats: () => session.stats,
        emit(event) { for (const listener of listeners) listener(event); },
        async bindExtensions() {
          // Native wrappers capture the definition object, not the mutable registry slot.
          for (const [name, tool] of local.tools) session.boundTools.set(name, tool.definition);
          session.events.push("bind"); await options.bind?.(session);
          if (options.inlineExtensions) for (const handler of local.hooks.get("session_start") ?? []) await handler({}, { sessionManager: manager });
        },
        async prompt(text) {
          session.prompts.push(text);
          if (options.prompt) await options.prompt(session, text);
          else session.messages.push({ role: "assistant", content: [{ type: "text", text: "controlled result" }], stopReason: "stop" });
        },
        async abort() { session.events.push("abort"); await options.abort?.(session); },
        async dispose() { session.events.push("dispose"); await options.dispose?.(session); },
        extensionRunner: { async emit(event) { session.events.push(event.type); } },
      };
      sessions.push(session);
      return { session } as never;
    },
  };
  return { factories, sessions, models, runtime, loaderInputs, sessionInputs, runtimeInputs };
}
