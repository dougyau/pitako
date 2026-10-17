import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { activateTarget, createPiExecutor, cursorProviderContext, DEFAULT_THINKING_LEVEL } from "../extensions/agent/pi.ts";
import { classifyProviderFailure } from "../extensions/agent/fallback.ts";
import { executionForSession } from "../extensions/execution-identity.ts";
import { createConversationOwner, runAgentInstance, teamExecutionSummary } from "../extensions/agent/run.ts";
import { ORCHESTRATION_TOOLS } from "../extensions/profile.ts";
import { providerFixtureOwnership } from "./fixtures/provider-fixture-ownership.ts";
import { controlledModel, controlledPi, controlledRole } from "./fixtures/pi-factories.ts";

const fixture = providerFixtureOwnership();
afterEach(fixture.requireReleasedFixture);
function setup(options: Parameters<typeof controlledPi>[1] = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-pi-policy-"));
  fixture.directories.push(root);
  process.env.PI_CODING_AGENT_DIR = root;
  const host = controlledPi(root, options);
  const input = { instanceId: "developer-controlled", role: controlledRole, cwd: root, task: "exact task",
    target: { model: "fixture/selected" }, signal: new AbortController().signal };
  const executor = createPiExecutor({ factories: host.factories });
  return { root, host, input, executor };
}

test("cursor context preserves session tools without changing other providers", () => {
  const tools = [{ name: "bash", description: "run", parameters: { type: "object" } }];
  const context = { messages: [], tools: tools as never };
  expect(cursorProviderContext({ provider: "cursor", api: "cursor-native" }, context).tools).toEqual(tools);
  expect(cursorProviderContext({ provider: "xai" }, context)).toBe(context);
});

test("activation preserves auth classification and explicit, per-model, global and SDK reasoning defaults", async () => {
  const model = controlledModel();
  const error = await activateTarget({ async setModel() { throw new Error("No API key for fixture/selected"); },
    setThinkingLevel() { throw new Error("must not activate"); } }, model, { model: "fixture/selected" });
  expect(classifyProviderFailure(error)).toBe("auth");
  let level: string | undefined;
  const session = { async setModel() {}, setThinkingLevel(next: string) { level = next; },
    settingsManager: { getModelThinkingLevel: () => "low" as const, getDefaultThinkingLevel: () => "medium" as const } };
  await activateTarget(session, model, { model: "fixture/selected", reasoning: "high" });
  expect(level).toBe("high");
  await activateTarget(session, model, { model: "fixture/selected" });
  expect(level).toBe("low");
  await activateTarget({ ...session, settingsManager: { getModelThinkingLevel() { return undefined; }, getDefaultThinkingLevel: () => "medium" as const } },
    model, { model: "fixture/selected" });
  expect(level).toBe("medium");
  await activateTarget({ ...session, settingsManager: undefined }, model, { model: "fixture/selected" });
  expect(level).toBe(DEFAULT_THINKING_LEVEL);
});

test("construction selects offline runtime, role resources and child tools before prompt; disposal retires identity once",
  fixture.ownedCase("construction", async () => {
    const { host, executor, input } = setup();
    const result = await fixture.acquire(executor.start(input));
    expect(result).toMatchObject({ status: "completed", result: "controlled result", sideEffects: false });
    expect(host.runtimeInputs).toEqual([{ allowModelNetwork: false }]);
    expect(host.sessionInputs[0]).toMatchObject({ excludeTools: [...ORCHESTRATION_TOOLS], cwd: input.cwd });
    expect(host.loaderInputs[0].appendSystemPrompt[0]).toContain(input.instanceId);
    expect(host.loaderInputs[0].skillsOverride({ skills: [{ name: "unexpected" }], diagnostics: [] }).skills).toEqual([]);
    const session = host.sessions[0]!;
    expect(session.prompts).toEqual(["exact task"]);
    expect(session.active).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
    for (const name of ORCHESTRATION_TOOLS) expect(session.active).not.toContain(name);
    expect(executionForSession(session.sessionId)).toMatchObject({ instanceId: input.instanceId });
    await result.session!.dispose(); await result.session!.dispose();
    expect(session.events).toEqual(["bind", "session_shutdown", "dispose"]);
    expect(executionForSession(session.sessionId)).toBeUndefined();
  }));

test("late registration is selected after bind; missing and unsupported targets never prompt; continuation stays on one session",
  fixture.ownedCase("availability", async () => {
    const late = controlledModel();
    const { host, input, executor } = setup({ models: [], bind() { host.models.push(late); } });
    const result = await fixture.acquire(executor.start(input));
    expect(result.status).toBe("completed");
    const next = await result.session!.continueWith({ model: "fixture/missing" }, "do not prompt", input.signal);
    expect(next).toMatchObject({ status: "failed", error: "model unavailable: fixture/missing", sideEffects: true });
    const unsupported = await result.session!.continueWith({ model: "fixture/selected", fast: true }, "do not prompt", input.signal);
    expect(unsupported).toMatchObject({ status: "failed", failureKind: "configuration", sideEffects: true });
    const continued = await result.session!.continueWith({ model: "fixture/selected" }, "literal continuation", input.signal);
    expect(continued.status).toBe("completed");
    expect(host.sessions).toHaveLength(1);
    expect(host.sessions[0]!.prompts).toEqual(["exact task", "literal continuation"]);
    expect(host.sessions[0]!.thinkingLevel).toBe(DEFAULT_THINKING_LEVEL);
    const absent = setup({ models: [] });
    const missing = await fixture.acquire(absent.executor.start(absent.input));
    expect(missing).toMatchObject({ status: "failed", error: "model unavailable: fixture/selected", sideEffects: false });
    expect(absent.host.sessions[0]!.prompts).toEqual([]);
    await missing.session!.dispose();
    expect(absent.host.sessions[0]!.events).toEqual(["bind", "session_shutdown", "dispose"]);
  }));

test("bind failure and cancellation before prompt dispose controlled sessions", fixture.ownedCase("failure cleanup", async () => {
  const broken = setup({ bind() { throw new Error("bind failure"); } });
  expect(await fixture.acquire(broken.executor.start(broken.input))).toMatchObject({ status: "failed", error: "bind failure" });
  expect(broken.host.sessions[0]!.events).toEqual(["bind", "dispose"]);
  const stop = new AbortController();
  const cancelled = setup({ bind() { stop.abort(); } });
  expect(await fixture.acquire(cancelled.executor.start({ ...cancelled.input, signal: stop.signal }))).toMatchObject({ status: "cancelled" });
  expect(cancelled.host.sessions[0]!.prompts).toEqual([]);
  expect(cancelled.host.sessions[0]!.events).toEqual(["bind", "abort", "session_shutdown", "dispose"]);
}));

for (const target of [
  { model: "openai/arbitrary", fast: true },
  { model: "openai-codex/arbitrary", fast: true },
  { model: "openai-codex/arbitrary", fast: false },
  { model: "openai-codex/arbitrary" },
  { model: "xai/grok-4.7", fast: true },
  { model: "xai/grok-4.7", fast: false },
]) {
  test("transport preserves payload hook and maps only selected target tier: " + JSON.stringify(target),
    fixture.ownedCase("target tier", async () => {
      const [provider, id] = target.model.split("/");
      const model = controlledModel(provider!, id!, provider === "openai-codex" ? "openai-codex-responses" : "openai-responses");
      const { host, input, executor } = setup({ models: [model], async prompt(session) {
        await session.agent.streamFunction(session.model, { messages: [] }, { sessionId: session.sessionId,
          onPayload: (payload: any) => ({ ...payload, hook: "retained" }) }).result();
      } });
      const bodies: unknown[] = [];
      host.runtime.streamSimple = (_model, _context, options) => {
        return (async function* () {
          bodies.push(await options?.onPayload?.({ model: id }, model));
          yield { type: "done", reason: "stop", message: { role: "assistant", content: [], stopReason: "stop" } };
        })();
      };
      const attempt = await fixture.acquire(executor.start({ ...input, target }));
      expect(attempt.status).toBe("completed");
      expect(bodies).toEqual([{ model: id, hook: "retained", ...(target.fast ? { service_tier: "priority" } : {}) }]);
      expect(attempt.requests).toMatchObject([{ fast_requested: target.fast === true, returned_service_tier: "unavailable",
        ...(target.fast ? { requested_service_tier: "priority" } : {}) }]);
    }));
}

test("unsupported fast models fail before prompt and tier rejection does not fall back", fixture.ownedCase("tier failure", async () => {
  for (const model of [controlledModel(), controlledModel("xai", "other", "openai-responses"), controlledModel("xai", "grok-4.7")]) {
    const f = setup({ models: [model] });
    const result = await fixture.acquire(f.executor.start({ ...f.input, target: { model: model.provider + "/" + model.id, fast: true } }));
    expect(result).toMatchObject({ status: "failed", failureKind: "configuration", sideEffects: false });
    expect(f.host.sessions[0]!.prompts).toEqual([]);
  }
  const f = setup({ models: [controlledModel("xai", "grok-4.7", "openai-responses")],
    prompt() { throw new Error("Unsupported service_tier: priority"); } });
  const config = path.join(f.root, "policy.toml");
  writeFileSync(config, '[model_policies.developer]\nprimary = { model = "xai/grok-4.7", fast = true }\nfallbacks = [{ model = "xai/grok-4.7", fast = false }]\n');
  const result = await fixture.run(runAgentInstance({ roleId: "developer", cwd: f.root, task: "no fallback", executor: f.executor, load: { userConfigPath: config } }));
  expect(result.status).toBe("failed");
  expect(result.model.fallbackOccurred).toBeFalsy();
  expect(f.host.sessions[0]!.prompts).toHaveLength(1);
}));

test("request attribution records first output only, ignores other session requests and reports observed usage",
  fixture.ownedCase("request attribution", async () => {
    let clock = 100;
    const f = setup({ prompt(session) {
      session.agent.streamFunction(session.model, { messages: [] }, { sessionId: "other-session" });
      session.agent.streamFunction(session.model, { messages: [] }, { sessionId: session.sessionId, reasoning: "high", temperature: 0.2, maxTokens: 31 });
      clock = 150;
      session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } });
      session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first" } });
      clock = 400;
      session.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "later" } });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "observed" }], stopReason: "stop" });
      session.stats.tokens = { input: 10, output: 3, cacheRead: 4, cacheWrite: 1, total: 18 };
      session.stats.cost = 0.0019; session.stats.assistantMessages = 1;
    } });
    const result = await fixture.acquire(createPiExecutor({ factories: f.host.factories, now: () => clock }).start(f.input));
    expect(result.requests).toHaveLength(1);
    expect(result.requests?.[0]).toMatchObject({ model: "fixture/selected", sdkOptions: { reasoning: "high", temperature: 0.2, maxTokens: 31 },
      sessionId: f.host.sessions[0]!.sessionId, time_to_first_model_output_ms: 50, returned_service_tier: "unavailable" });
    expect(result.requests?.[0]?.historyId).toBeString();
    expect(result.usage).toMatchObject({ input: 10, output: 3, cacheRead: 4, cacheWrite: 1, cost: 0.0019, contextTokens: 17 });
    const config = path.join(f.root, "policy.toml");
    writeFileSync(config, '[model_policies.developer]\nprimary = { model = "fixture/selected" }\n');
    const run = await fixture.run(runAgentInstance({ roleId: "developer", cwd: f.root, task: "usage", executor: f.executor, load: { userConfigPath: config } }));
    expect(teamExecutionSummary("assignment", run)).toMatchObject({ selectedModel: "fixture/selected", provider: "fixture", input: 10, output: 3 });
  }));

test("fallback after an owned mutation continues on one controlled session and resets reasoning",
  fixture.ownedCase("same-session fallback", async () => {
    const activations: string[] = [];
    const f = setup({ models: [controlledModel(), controlledModel("fixture", "fallback")],
      prompt(session) {
        activations.push(session.thinkingLevel);
        if (session.model?.id === "selected") {
          session.emit({ type: "tool_execution_start", toolName: "write", toolCallId: "mutation" });
          throw new Error("No API key for fixture/selected");
        }
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "continued result" }], stopReason: "stop" });
      } });
    const config = path.join(f.root, "policy.toml");
    writeFileSync(config, '[model_policies.developer]\nprimary = { model = "fixture/selected", reasoning = "xhigh" }\nfallbacks = [{ model = "fixture/fallback" }]\n');
    const result = await fixture.run(runAgentInstance({ roleId: "developer", cwd: f.root, task: "original work",
      executor: f.executor, load: { userConfigPath: config } }));
    expect(result).toMatchObject({ status: "completed", result: "continued result", model: {
      selectedModel: "fixture/fallback", fallbackOccurred: true, appliedReasoning: DEFAULT_THINKING_LEVEL,
    } });
    expect(f.host.sessions).toHaveLength(1);
    expect(activations).toEqual(["xhigh", DEFAULT_THINKING_LEVEL]);
    expect(f.host.sessions[0]!.prompts).toHaveLength(2);
    expect(f.host.sessions[0]!.prompts[1]).not.toBe("original work");
    expect(f.host.sessions[0]!.events).toEqual(["bind", "session_shutdown", "dispose"]);
  }));

test("overlapping fast and normal attempts keep payload tiers independent",
  fixture.ownedCase("concurrent tiers", async () => {
    let release!: () => void, entered!: () => void, count = 0;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const both = new Promise<void>(resolve => { entered = resolve; });
    const bodies: any[] = [];
    const f = setup({ models: [controlledModel("xai", "grok-4.7", "openai-responses")],
      async prompt(session, text) {
        if (++count === 2) entered();
        await hold;
        await session.agent.streamFunction(session.model, { messages: [] }, { sessionId: session.sessionId,
          onPayload: (payload: any) => ({ ...payload, attempt: text }) }).result();
      } });
    f.host.runtime.streamSimple = (_model, _context, options) => (async function* () {
      bodies.push(await options?.onPayload?.({}, _model));
      yield { type: "done", reason: "stop", message: { role: "assistant", content: [], stopReason: "stop" } };
    })();
    const pending = [true, false].map(fast => fixture.acquire(f.executor.start({ ...f.input, task: String(fast),
      instanceId: String(fast), target: { model: "xai/grok-4.7", fast } })));
    try {
      await both;
      expect(bodies).toEqual([]);
      release();
      const results = await Promise.all(pending);
      expect(results.map(result => result.status)).toEqual(["completed", "completed"]);
      expect(bodies).toContainEqual({ attempt: "true", service_tier: "priority" });
      expect(bodies).toContainEqual({ attempt: "false" });
      expect(bodies).toHaveLength(2);
      expect(results[0]!.requests?.[0]?.requested_service_tier).toBe("priority");
      expect(results[1]!.requests?.[0]?.requested_service_tier).toBeUndefined();
    } finally { release(); await Promise.allSettled(pending); }
  }));

test("concurrent child tool events retain independent counts, cancellation and side effects",
  fixture.ownedCase("tool events", async () => {
    const stop = new AbortController();
    const f = setup({ prompt(session, text) {
      session.stats.tokens.total = 1; session.stats.assistantMessages = 1;
      session.emit({ type: "tool_execution_start", toolName: "codegraph_search", toolCallId: "graph" });
      if (text === "cancel") stop.abort();
      session.emit({ type: "tool_execution_end", toolName: "codegraph_search", toolCallId: "graph",
        result: { content: [{ type: "text", text: "report" }], details: { status: text === "failed" ? "unavailable" : "ok" } } });
      for (let index = 0; index < 5; index++) session.emit({ type: "tool_execution_end", toolName: "read", toolCallId: String(index), result: {} });
      if (text === "failed") session.emit({ type: "tool_execution_start", toolName: "write", toolCallId: "write" });
    } });
    const results = await Promise.all(["failed", "cancel"].map(task => fixture.acquire(f.executor.start({ ...f.input, task,
      instanceId: task, signal: task === "cancel" ? stop.signal : f.input.signal }))));
    expect(results[0]!.sideEffects).toBe(true);
    expect(results[1]!.status).toBe("cancelled");
    expect(results[1]!.sideEffects).toBe(false);
    for (const result of results) {
      expect(result.usage?.tools).toEqual({ codegraph_search: 1, read: 5 });
      expect(result.usage).not.toHaveProperty("codeIntelligence");
    }
  }));

test("cancellation marks a request with no output unavailable and clears activity probe", fixture.ownedCase("cancel observation", async () => {
  const stop = new AbortController(), events: string[] = [];
  const f = setup({ prompt(session) {
    session.agent.streamFunction(session.model, { messages: [] }, { sessionId: session.sessionId });
    stop.abort();
  } });
  const result = await fixture.acquire(f.executor.start({ ...f.input, signal: stop.signal,
    bindActivityProbe(probe) { events.push(probe ? "bind" : "clear"); } }));
  expect(result.status).toBe("cancelled");
  expect(result.requests?.[0]).toMatchObject({ time_to_first_model_output_ms: "unavailable",
    time_to_first_model_output_unavailable_reason: "cancelled" });
  expect(events).toEqual(["bind", "clear"]);
}));


test("conversation owner rejects settlement callback reentry before SDK prompt and joins second cancellation",
  fixture.ownedCase("conversation reentry", async () => {
    const outer = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const callbackEntered = Promise.withResolvers<void>(), callbackRelease = Promise.withResolvers<void>();
    let callback: Promise<void> | undefined;
    const abortEntered = Promise.withResolvers<void>(), abortRelease = Promise.withResolvers<void>();
    const secondPrompt = Promise.withResolvers<void>();
    const firstSignal = new AbortController(), secondSignal = new AbortController();
    let owner: ReturnType<typeof createConversationOwner>;
    let rejection = "";
    const f = setup({ bind(session) {
      session.subscribe(event => {
        if (event.type !== "agent_settled") return;
        callback = (async () => {
          try { await owner.turn("must never be queued"); } catch (error) { rejection = String(error); }
          callbackEntered.resolve();
          await callbackRelease.promise;
        })();
      });
    }, async prompt(session, text) {
      if (text === "first") {
        // Controlled SDK boundary: settlement is emitted while the outer prompt still owns its stack.
        session.emit({ type: "agent_settled" });
        entered.resolve();
        await outer.promise;
        await callback;
      } else { secondPrompt.resolve(); await abortEntered.promise; }
      session.stats.tokens.input += 7;
      session.stats.tokens.output += 3;
      Reflect.deleteProperty(session.stats, "cost");
      session.stats.assistantMessages++;
      session.messages.push({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
    }, async abort() { abortEntered.resolve(); await abortRelease.promise; } });
    const config = path.join(f.root, "policy.toml");
    writeFileSync(config, '[model_policies.developer]\nprimary = { model = "fixture/selected" }\n');
    owner = createConversationOwner({ roleId: "developer", cwd: f.root, task: "first", executor: f.executor,
      load: { userConfigPath: config } });
    const first = owner.turn("first", { signal: firstSignal.signal });
    let second: ReturnType<typeof owner.turn> | undefined;
    try {
      await entered.promise;
      await callbackEntered.promise;
      expect(rejection).toContain("busy");
      expect(owner.busy).toBe(true);
      expect(f.host.sessions[0]!.prompts).toEqual(["first"]);
      outer.resolve();
      await Promise.resolve();
      expect(owner.busy).toBe(true);
      await expect(owner.turn("callback still joining")).rejects.toThrow("busy");
      callbackRelease.resolve();
      const result = await first;
      expect(result.usage).toMatchObject({ input: 7, output: 3 });
      expect(result.usage?.cost).toBeUndefined();
      expect(f.host.sessions[0]!.events).not.toContain("dispose");
      second = owner.turn("second", { signal: secondSignal.signal });
      await secondPrompt.promise;
      firstSignal.abort();
      expect(f.host.sessions[0]!.events).not.toContain("abort");
      secondSignal.abort();
      await abortEntered.promise;
      let settled = false;
      void second.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      abortRelease.resolve();
      const cancelled = await second;
      expect(cancelled).toMatchObject({ status: "cancelled", usage: { input: 7, output: 3 } });
      expect(cancelled.usage?.cost).toBeUndefined();
      await expect(owner.turn("terminal cancellation")).rejects.toThrow("closing");
      expect(f.host.sessions).toHaveLength(1);
      expect(f.host.sessions[0]!.prompts).toEqual(["first", "second"]);
    } finally {
      outer.resolve(); callbackRelease.resolve(); secondSignal.abort(); abortRelease.resolve();
      await Promise.allSettled([first, second]);
      await owner.close();
    }
    expect(f.host.sessions[0]!.events.filter(event => event === "dispose")).toHaveLength(1);
  }));

test("logical adapter operations do not reuse a previous resolved abort join",
  fixture.ownedCase("operation abort generations", async () => {
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const aborted = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let prompts = 0, aborts = 0;
    const f = setup({ async prompt() { const index = prompts++; entered[index]!.resolve(); await aborted[index]!.promise; },
      async abort() { const index = aborts++; aborted[index]!.resolve(); await release[index]!.promise; } });
    const one = new AbortController(), two = new AbortController();
    const first = fixture.acquire(f.executor.start({ ...f.input, signal: one.signal }));
    await entered[0]!.promise; one.abort(); await aborted[0]!.promise; release[0]!.resolve();
    const result = await first;
    const second = result.session!.turn!({ task: "new operation", target: f.input.target, signal: two.signal });
    try {
      await entered[1]!.promise; two.abort(); await aborted[1]!.promise;
      let settled = false; void second.then(() => { settled = true; }); await Promise.resolve();
      expect(aborts).toBe(2); expect(settled).toBe(false);
      release[1]!.resolve(); expect((await second).status).toBe("cancelled");
    } finally { release.forEach(gate => gate.resolve()); await second; await result.session!.dispose(); }
  }));


test("logical turn cancellation owns awaited activation as well as prompt and abort joins",
  fixture.ownedCase("activation cancellation", async () => {
    const entered = Promise.withResolvers<void>(), activationRelease = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>(), abortRelease = Promise.withResolvers<void>();
    const f = setup({ bind(session) {
      const setModel = session.setModel.bind(session);
      session.setModel = async model => {
        if (session.prompts.length) { entered.resolve(); await activationRelease.promise; }
        await setModel(model);
      };
    }, async abort() { aborted.resolve(); await abortRelease.promise; } });
    const config = path.join(f.root, "policy.toml");
    writeFileSync(config, '[model_policies.developer]\nprimary = { model = "fixture/selected" }\n');
    const owner = createConversationOwner({ roleId: "developer", cwd: f.root, task: "first", executor: f.executor,
      load: { userConfigPath: config } });
    const stop = new AbortController();
    const first = owner.turn();
    let second: ReturnType<typeof owner.turn> | undefined;
    try {
      await first;
      second = owner.turn("cancel during activation", { signal: stop.signal });
      await entered.promise;
      stop.abort();
      await Promise.resolve();
      expect(f.host.sessions[0]!.events).toContain("abort");
      await aborted.promise;
      let settled = false; void second.then(() => { settled = true; });
      activationRelease.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      abortRelease.resolve();
      expect((await second).status).toBe("cancelled");
      expect(f.host.sessions[0]!.prompts).toEqual(["first"]);
    } finally {
      activationRelease.resolve(); abortRelease.resolve(); stop.abort();
      await Promise.allSettled([first, second]); await owner.close();
    }
  }));


test("child reconciliation survives same-model external mutations, capability changes and absent patch registrations",
  fixture.ownedCase("child final profile", async () => {
    for (const included of [true, false]) for (const roleId of ["developer", "researcher"]) {
      const grammar = { ...controlledModel(), api: "openai-responses", compat: { supportsOpenAIGrammarTools: true } } as ReturnType<typeof controlledModel>;
      const unsupported = controlledModel("fixture", "unsupported");
      const f = setup({ models: [grammar, unsupported],
        extensions: included ? [{ resolvedPath: "controlled-public-registration", tools: new Map([["apply_patch", { definition: { name: "apply_patch" } }]]) }] : [],
        bind(session) {
          const setModel = session.setModel.bind(session);
          session.setModel = async model => {
            await setModel(model);
            session.setActiveToolsByName(["edit", "write", "apply_patch", "agent_run", "head_plan"]);
          };
        },
      });
      const result = await fixture.acquire(f.executor.start({ ...f.input, role: { ...controlledRole, id: roleId } }));
      const session = f.host.sessions[0]!;
      const check = (capable: boolean) => {
        expect(session.active).not.toContain("agent_run"); expect(session.active).not.toContain("head_plan");
        if (roleId === "researcher") {
          for (const name of ["edit", "write", "apply_patch"]) expect(session.active).not.toContain(name);
        } else if (included && capable) {
          expect(session.active).toContain("apply_patch"); expect(session.active).not.toContain("edit"); expect(session.active).not.toContain("write");
        } else {
          expect(session.active).toEqual(expect.arrayContaining(["edit", "write"])); expect(session.active).not.toContain("apply_patch");
        }
      };
      try {
        expect(result.status).toBe("completed"); check(true);
        expect((await result.session!.continueWith({ model: "fixture/selected" }, "same model", f.input.signal)).status).toBe("completed"); check(true);
        expect((await result.session!.continueWith({ model: "fixture/unsupported" }, "without capability", f.input.signal)).status).toBe("completed"); check(false);
        expect((await result.session!.continueWith({ model: "fixture/selected" }, "restore capability", f.input.signal)).status).toBe("completed"); check(true);
      } finally { await result.session!.dispose(); }
    }
  }));
