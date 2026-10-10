import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { classifyProfile, developerPreflight } from "../extensions/agent/routing.ts";
import { runAgentInstance } from "../extensions/agent/run.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import { packageRoot } from "../extensions/stack.ts";

function response(choice: string, probabilities: Record<string, number>): ClassifierResult {
  return { api: "fixture", provider: "fixture", model: "fixture", timestamp: 1, stopReason: "stop",
    answers: { capacity: { type: "choice", choice, probabilities, confidence: 0.1 } } };
}
const base = { developer_senior: 0.6, developer_mid: 0.2, developer_junior: 0.1, indeterminate: 0.1 };
describe("Developer routing", () => {
  test("recording gaps, bounds, snapshot consumption and lost ownership stay explicit", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-routing-unit-"));
    const config = path.join(root, "config.toml");
    const content = (model: string) => `[model_policies.developer.primary]\nmodel = "fixture/${model}"\nreasoning = "medium"\n`;
    mkdirSync(root, { recursive: true });
    writeFileSync(config, content("mid"));
    const full = response("developer_senior", base);
    const model = { type: "classifier", provider: "opencode", id: "jev-1.13-free", api: "fixture", contextWindow: 8192 };
    let discoveries = 0, classifications = 0, writes = 0, owned = true, recordingFails = false;
    let sessionId = "coordinator";
    const ctx = {
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => path.join(root, "not-yet-persisted.jsonl") },
      modelRegistry: {
        async getAvailableOfType() { discoveries++; return [model]; },
        async classify() { classifications++; return full; },
      },
    } as unknown as ExtensionContext; // Deliberately partial host fixture; SDK behavior is observed below.
    const input = { task: "bounded WorkBrief", toolCallId: "call", source: "agent_run", ctx,
      owns: () => owned, load: { userConfigPath: config },
      pi: { appendEntry() { writes++; if (recordingFails) throw new Error("owned recording failure"); } } };
    try {
      const snapshot = await developerPreflight(input);
      expect(snapshot.routing.profile).toBe("developer_senior");
      expect(snapshot.routing.resolvedPolicy.provenance?.primary).toBe("developer");
      expect(snapshot.evidence).toBe("pending-native-persistence");
      expect(Object.isFrozen(snapshot.config.policies.developer_mid?.primary)).toBe(true);
      writeFileSync(config, content("changed"));
      const result = await runAgentInstance({ roleId: "developer", task: input.task, cwd: root, dispatch: snapshot,
        executor: { async start(request) {
          expect(request.target.model).toBe("fixture/mid");
          expect(request.role.modelPolicyId).toBe("developer_senior");
          return { status: "completed", result: "observed immutable target", sideEffects: false };
        } } });
      expect(result.status).toBe("completed");
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
  test("real Node SDK registered tool, public classifier HTTP and native linkage", () => {
    const root = packageRoot();
    const child = spawnSync("node", ["--experimental-transform-types", "--import",
      path.join(root, "scripts/sdk-node-loader.mjs"), "scripts/developer-routing-sdk-node.mjs"], {
      cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1048576,
      env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    expect(child.status, child.stderr + child.stdout).toBe(0);
  }, 100_000);
});
