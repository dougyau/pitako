import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeTaskReviewer, executeTaskSynthesis } from "../extensions/execute-settings.ts";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const models = {
  taskReviewer: "openai-codex/gpt-6.1-sol:xhigh",
  taskSynthesis: "anthropic/claude-opus-5-5:high",
};
const readers = { taskReviewer: executeTaskReviewer, taskSynthesis: executeTaskSynthesis };
const invalidModels = [null, false, 42, [], {}, "", "model", "provider/", "/model",
  " provider/model", "provider/model ", "provider/model\n", "provider/model id",
  "provider/*", "provider/model?", "provider/model,other/model"];

test.each(["taskReviewer", "taskSynthesis"] as const)("%s reads exact models with global/project precedence", name => {
  const host = fixture(), agentDir = path.join(host.root, "agent");
  mkdirSync(agentDir); mkdirSync(path.join(host.root, ".pi"), { recursive: true });
  const read = () => readers[name](host.root, agentDir);
  const settings = (directory: string, value: unknown) => writeFileSync(path.join(directory, "settings.json"),
    "\uFEFF" + JSON.stringify({ pitako: { execute: { [name]: value } } }));
  expect(read()).toBe(models[name]);
  settings(agentDir, "openrouter/owner/model:high");
  expect(read()).toBe("openrouter/owner/model:high");
  settings(path.join(host.root, ".pi"), undefined);
  expect(read()).toBe("openrouter/owner/model:high");
  settings(path.join(host.root, ".pi"), "custom/exact-model");
  expect(read()).toBe("custom/exact-model");
  // Colons belong to exact ids too; only Pi resolves an optional thinking suffix.
  for (const value of ["ollama/qwen2.5-coder:7b", "ollama/qwen2.5-coder:7b:high",
    "bedrock/anthropic.claude-v1:0", "provider/model:unknown", "provider/model:high:low"]) {
    settings(path.join(host.root, ".pi"), value);
    expect(read()).toBe(value);
  }
  for (const value of invalidModels) {
    settings(path.join(host.root, ".pi"), value);
    expect(read).toThrow(`pitako.execute.${name}`);
    expect(read).toThrow(path.join(host.root, ".pi/settings.json"));
  }
});

test.each([undefined, { taskReviewer: "custom/reviewer:low", taskSynthesis: "custom/synthesis" },
  { taskReviewer: "ollama/qwen2.5-coder:7b", taskSynthesis: "ollama/qwen2.5-coder:7b:high" },
  { taskReviewer: "bedrock/anthropic.claude-v1:0:high", taskSynthesis: "bedrock/anthropic.claude-v1:0" },
  { taskReviewer: "provider/model:unknown", taskSynthesis: "provider/model:high:low" }])(
  "controller freezes review models at admission and retains them on replay: %j", async override => {
    const host = fixture();
    host.setHostResponse((key, value) => {
      if (key !== "inspect-initial" || !value.admission) return value;
      const { taskReviewer, taskSynthesis, ...unset } = value.admission;
      return { ...value, admission: { ...unset, ...override } };
    });
    expect((await host.execute()).status).toBe("complete");
    expect(host.current()).toMatchObject(override ?? models);
    const frozen = { taskReviewer: host.current().taskReviewer, taskSynthesis: host.current().taskSynthesis };
    host.setHostResponse((key, value) => {
      // The admission producer omits settings after association exists.
      if (key === "inspect-initial") expect(value).not.toHaveProperty("admission");
      if (key === "execute-settings") throw Error("Settings must not be re-read");
      return value;
    });
    const calls = host.calls.length;
    expect((await host.execute()).status).toBe("complete");
    expect(host.current()).toMatchObject(frozen);
    expect(host.calls).toHaveLength(calls);
    expect(host.hostCalls).not.toContain("execute-settings");
  });

test.each(["taskReviewer", "taskSynthesis"] as const)("%s invalid admission cannot dispatch a director", async name => {
  for (const invalid of invalidModels) {
    const host = fixture();
    host.setHostResponse((key, value) => key === "inspect-initial"
      ? { ...value, admission: { ...value.admission, [name]: invalid } } : value);
    const result = await host.execute();
    expect(result).toMatchObject({ status: "blocked", loopsConsumed: 0 });
    expect(result.reason).toContain(`pitako.execute.${name}`);
    expect(host.calls).toHaveLength(0);
  }
});
