import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { classifyProfile, developerCapacityPreflight, developerPreflight, type DispatchSnapshot } from "../extensions/agent/routing.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import { loadPitakoConfig } from "../extensions/roles/load.ts";
import { createAgentController } from "../extensions/agent/controller.ts";
import { clearObservations, publishObservation } from "../extensions/agent/observe.ts";

function response(choice: string, probabilities: Record<string, number>): ClassifierResult {
  return { api: "fixture", provider: "fixture", model: "fixture", timestamp: 1, stopReason: "stop",
    answers: { capacity: { type: "choice", choice, probabilities, confidence: 0.1 } } };
}
const base = { developer_senior: 0.6, developer_mid: 0.2, developer_junior: 0.1, indeterminate: 0.1 };
describe("Developer routing", () => {
  test("recording gaps, bounds, snapshot consumption and lost ownership stay explicit", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-routing-unit-"));
    const config = path.join(root, "config.toml");
    const content = (model: string) => `[model_policies.developer.primary]\nmodel = "fixture/${model}"\nreasoning = "medium"\n
[developer_routing]
classifier_provider = "fixture"
classifier_model = "capacity/v2"
`;
    mkdirSync(root, { recursive: true });
    writeFileSync(config, content("mid"));
    const full = response("developer_senior", { ...base, developer_senior: 0.6012345678901234 });
    const model = { type: "classifier", provider: "fixture", id: "capacity/v2", api: "fixture", contextWindow: 8192 };
    const signal = new AbortController().signal;
    let discoveries = 0, classifications = 0, writes = 0, owned = true, recordingFails = false;
    let sessionId = "coordinator";
    const ctx = {
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => path.join(root, "not-yet-persisted.jsonl") },
      modelRegistry: {
        async getAvailableOfType(type: string, provider: string, options: { signal: AbortSignal }) {
          expect(type).toBe("classifier"); expect(provider).toBe("fixture"); expect(options.signal).toBe(signal);
          discoveries++;
          return [{ ...model, provider: "other" }, { ...model, id: "other" }, model];
        },
        async classify(selected: unknown, request: unknown, options: { signal: AbortSignal; maxRetries: number }) {
          expect(selected).toBe(model);
          expect(request).toMatchObject({ state: { workbrief: "bounded WorkBrief" } });
          expect(options).toMatchObject({ signal, maxRetries: 0 });
          classifications++; return full;
        },
      },
    } as unknown as ExtensionContext; // Deliberately partial host fixture; SDK behavior is observed below.
    const input = { task: "bounded WorkBrief", toolCallId: "call", source: "agent_run", ctx,
      owns: () => owned, load: { userConfigPath: config }, signal,
      pi: { appendEntry() { writes++; if (recordingFails) throw new Error("owned recording failure"); } } };
    try {
      const snapshot = await developerPreflight(input);
      expect(snapshot.routing.profile).toBe("developer_senior");
      expect(snapshot.routing.route).toBe("classify");
      expect(snapshot.routing.classifier).toEqual({ classifierProvider: "fixture", classifierModel: "capacity/v2" });
      expect(snapshot.routing.response).toEqual(full);
      expect(snapshot.routing.resolvedPolicy.provenance?.primary).toBe("developer");
      expect(snapshot.evidence).toBe("pending-native-persistence");
      expect(Object.isFrozen(snapshot.config.policies.developer_mid?.primary)).toBe(true);
      writeFileSync(config, content("changed"));
      const owner = { sessionId, token: Symbol("routing view") };
      const controller = createAgentController(owner, () => owner), view = controller.openView();
      const result = await runAgentInstance({ roleId: "developer", task: input.task, cwd: root, dispatch: snapshot,
        historyOrigin: { source: "agent_run", coordinatorSessionId: sessionId, workbrief: input.task,
          routing: snapshot.routing, routingEvidence: { state: snapshot.evidence, gap: snapshot.evidenceGap } },
        onObserve: publishObservation,
        executor: { async start(request) {
          expect(request.target.model).toBe("fixture/mid");
          expect(request.role.modelPolicyId).toBe("developer_senior");
          return { status: "completed", result: "observed immutable target", sideEffects: false };
        } } });
      expect(result.status).toBe("completed");
      const detail = view.detail(result.instanceId);
      expect(detail.route).toMatchObject({ state: "captured", profile: "developer_senior",
        evidence: { state: "pending-native-persistence" }, recommendation: { choice: "developer_senior",
          probabilities: { ...base, developer_senior: 0.6012345678901234 } } });
      detail.route.recommendation!.probabilities.developer_senior = 0;
      expect(view.detail(result.instanceId).route.recommendation?.probabilities.developer_senior).toBe(0.6012345678901234);
      expect(() => view.route(result.instanceId)).toThrow("acknowledgement");
      await view.close(); controller.revoke(); await controller.settle();
      expect(classifications).toBe(1); // Runner consumption has no second classifier call.
      recordingFails = true;
      const gap = await developerPreflight(input);
      expect(gap.routing.profile).toBe("developer_mid");
      expect(gap.evidence).toBe("unavailable");
      expect(gap.evidenceGap).toContain("owned recording failure");
      expect(gap.routing.response).toBeUndefined();
      expect(gap.routing.request).toBeUndefined();
      expect(writes).toBe(2); // No repair writer.
      recordingFails = false;
      const before = discoveries;
      const oversized = await developerPreflight({ ...input, task: "x".repeat(262144) });
      expect(discoveries).toBe(before);
      expect(oversized.routing.reason).toContain("exceeds");
      expect(oversized.routing.request).toBeUndefined();
      expect(oversized.routing.response).toBeUndefined();
      const beforeContext = classifications;
      const exceedsContext = await developerPreflight({ ...input, task: "x".repeat(8192) });
      expect(classifications).toBe(beforeContext);
      expect(exceedsContext.routing.reason).toContain("context-window budget");
      expect(exceedsContext.routing.request).toBeUndefined();
      const beforeLost = writes;
      ctx.modelRegistry.classify = async () => { owned = false; return full; };
      await expect(developerPreflight(input)).rejects.toThrow("cancelled before admission");
      expect(writes).toBe(beforeLost);
      owned = true;
      ctx.modelRegistry.classify = async () => { sessionId = "replacement"; return full; };
      await expect(developerPreflight(input)).rejects.toThrow("cancelled before admission");
      expect(writes).toBe(beforeLost);
      ctx.modelRegistry.classify = async () => ({ ...full, stopReason: "aborted" });
      await expect(developerPreflight(input)).rejects.toThrow("aborted before admission");
      expect(writes).toBe(beforeLost);
    } finally { clearObservations(); rmSync(root, { recursive: true, force: true }); }
  });
  test("direct/default bypass discovery, preserve direct choice across recording gaps, and consume captured config", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-routing-direct-"));
    const configPath = path.join(root, "config.toml");
    writeFileSync(configPath, `
[model_policies.developer.primary]
model = "fixture/mid"
reasoning = "default"
[model_policies.developer_junior.primary]
model = "fixture/junior"
reasoning = "low"
[head_developer]
max_parallel = 5
`);
    let discoveries = 0, calls = 0;
    const ctx = {
      sessionManager: { getSessionId: () => "direct", getSessionFile: () => path.join(root, "coordinator.jsonl") },
      modelRegistry: { async getAvailableOfType() { discoveries++; throw new Error("must not discover"); },
        async classify() { calls++; throw new Error("must not classify"); } },
    } as unknown as ExtensionContext;
    const config = loadPitakoConfig({ userConfigPath: configPath });
    const input = { task: "direct brief", toolCallId: "direct", source: "internal", ctx, config, owns: () => true,
      pi: { appendEntry() { throw new Error("owned diagnostic failure"); } } };
    try {
      // A captured assignment config wins over both its later mutation and changed TOML.
      const direct = await developerCapacityPreflight({ ...input, capacity: { route: "direct", profile: "developer_junior" } });
      expect(direct.routing).toMatchObject({ route: "direct", profile: "developer_junior", reason: "direct profile selection" });
      expect(direct.evidence).toBe("unavailable");
      expect(direct.evidenceGap).toContain("owned diagnostic failure");
      expect(direct.routing.request).toBeUndefined();
      expect(direct.routing.response).toBeUndefined();
      config.headDeveloper.maxParallel = 9;
      writeFileSync(configPath, "[head_developer]\nmax_parallel = 0\n"); // A reread would now reject.
      expect(direct.config.headDeveloper.maxParallel).toBe(5);
      expect(Object.isFrozen(direct.config.developerRouting)).toBe(true);
      const observed = await runAgentInstance({
        roleId: "developer", task: input.task, cwd: root, dispatch: direct,
        load: { userConfigPath: configPath },
        executor: { async start(request) {
          expect(request.target).toEqual({ model: "fixture/junior", reasoning: "low" });
          expect(request.role.modelPolicyId).toBe("developer_junior");
          return { status: "completed", result: "direct target consumed", sideEffects: false };
        } },
      });
      expect(observed.status).toBe("completed");
      const defaultRoute = await developerCapacityPreflight({ ...input, capacity: { route: "default" } });
      expect(defaultRoute.routing).toMatchObject({ route: "default", profile: "developer_mid" });
      const mid = await runAgentInstance({ roleId: "developer", task: input.task, cwd: root, dispatch: defaultRoute,
        executor: { async start(request) {
          expect(request.target).toEqual({ model: "fixture/mid" }); // Omitted/default reasoning is not rewritten.
          return { status: "completed", result: "default target consumed", sideEffects: false };
        } } });
      expect(mid.status).toBe("completed");
      const noJournal = await developerCapacityPreflight({ ...input,
        ctx: { ...ctx, sessionManager: { getSessionId: () => "direct" } } as unknown as ExtensionContext,
        capacity: { route: "direct", profile: "developer_junior" } });
      expect(noJournal.routing.profile).toBe("developer_junior");
      expect(noJournal.evidenceGap).toContain("native recording unavailable");
      expect(discoveries).toBe(0); expect(calls).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("optional registry absence/errors/invalid advice fail soft; cancellation fences preflight and ordinary start", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-routing-errors-"));
    const configPath = path.join(root, "config.toml");
    writeFileSync(configPath, '[model_policies.developer.primary]\nmodel = "fixture/mid"\n');
    const model = { type: "classifier", provider: "opencode", id: "jev-1.13-free", contextWindow: 8192 };
    let available: unknown[] = [], discoveryError = false, classifyError = false, owned = true, starts = 0;
    let reply = response("developer_senior", base);
    let duringDiscovery = () => {}, duringClassify = () => {};
    const ctx = {
      sessionManager: { getSessionId: () => "errors", getSessionFile: () => path.join(root, "coordinator.jsonl") },
      modelRegistry: {
        async getAvailableOfType() { duringDiscovery(); if (discoveryError) throw new Error("discovery offline"); return available; },
        async classify() { duringClassify(); if (classifyError) throw new Error("classification offline"); return reply; },
      },
    } as unknown as ExtensionContext;
    const input = { task: "bounded", toolCallId: "errors", source: "agent_run", ctx,
      load: { userConfigPath: configPath }, owns: () => owned, pi: { appendEntry() {} } };
    let snapshot: DispatchSnapshot | undefined;
    const run = async (signal?: AbortSignal) => {
      const dispatch = await developerPreflight({ ...input, signal });
      snapshot = dispatch; // Observe the producer before entering its runner consumer.
      const result = await runAgentInstance({ roleId: "developer", task: input.task, cwd: root, dispatch,
        executor: { async start(request) {
          starts++; expect(request.target.model).toBe("fixture/mid");
          return { status: "completed", result: "fallback observed", sideEffects: false };
        } } });
      expect(result.status).toBe("completed");
      return dispatch;
    };
    try {
      const missing = await run();
      expect(missing.routing.profile).toBe("developer_mid");
      expect(missing.routing.reason).toBe("classifier unavailable");
      available = [{ ...model, id: "not-configured" }, { ...model, provider: "not-configured" }];
      expect((await run()).routing.reason).toBe("classifier unavailable"); // No alternative identity.
      discoveryError = true;
      expect((await run()).routing.reason).toContain("discovery offline");
      discoveryError = false; available = [model]; classifyError = true;
      expect((await run()).routing.reason).toContain("classification offline");
      classifyError = false; reply = response("unknown", { ...base, unknown: 0.9 });
      const invalid = await run();
      expect(invalid.routing.reason).toBe("indeterminate or unknown winner");
      expect(invalid.routing.response).toEqual(reply); // Keep the full public advice even when invalid.
      const admitted = starts;
      for (const stage of ["discovery", "classify"] as const) {
        for (const cancellation of ["abort", "revocation"] as const) {
          const controller = new AbortController();
          const cancel = () => { if (cancellation === "abort") controller.abort(); else owned = false; };
          duringDiscovery = stage === "discovery" ? cancel : () => {};
          duringClassify = stage === "classify" ? cancel : () => {};
          snapshot = undefined;
          await expect(run(controller.signal)).rejects.toThrow("cancelled before admission");
          expect(snapshot).toBeUndefined();
          expect(starts).toBe(admitted);
          owned = true;
        }
      }
      duringDiscovery = () => {}; duringClassify = () => {};
      reply = { ...reply, stopReason: "aborted" };
      snapshot = undefined;
      await expect(run()).rejects.toThrow("aborted before admission");
      expect(snapshot).toBeUndefined();
      expect(starts).toBe(admitted);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("choice must agree with unique winner across complete unnormalized probabilities", () => {
    expect(classifyProfile(response("developer_senior", base)).profile).toBe("developer_senior");
    for (const probabilities of [
      { ...base, unknown: 0.9 }, { ...base, unknown: 0.6 }, { ...base, developer_mid: 0.6 },
      { ...base, developer_junior: NaN }, { ...base, developer_junior: Infinity },
      { ...base, developer_junior: -1 }, { ...base, developer_junior: 1.01 },
      { developer_senior: 0.6, developer_mid: 0.2 },
    ]) expect(classifyProfile(response("developer_senior", probabilities)).profile).toBe("developer_mid");
    expect(classifyProfile(response("developer_junior", base)).profile).toBe("developer_mid");
    expect(classifyProfile(response("developer_senior", { ...base, indeterminate: 0.9 })).profile).toBe("developer_mid");
    expect(classifyProfile(response("developer_junior", { ...base, developer_junior: 0.9 })).profile).toBe("developer_junior");
  });
});
