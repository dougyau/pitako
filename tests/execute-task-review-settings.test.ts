import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeTaskReviewer, executeTaskSynthesis } from "../extensions/execute-settings.ts";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";
import { reviewModels } from "../extensions/review-settings.ts";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";

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

test.each([false, true])("final review uses admission-frozen full-review models across replay (override=%s)", async override => {
  const host = fixture(undefined, { taskCount: 0 });
  const file = path.join(host.root, ".pi/settings.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pitako: { review: override
    ? { r1: "custom/first:low", r2: "custom/second:high", synthesis: "custom/director" } : {} } }));
  const frozen = reviewModels(host.root, path.join(host.root, "private-agent"));
  let denied = false;
  host.setLaunchRespond((request, normal) => {
    if (!denied && request.key.includes(".review.independent-")) {
      denied = true;
      const error = new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: `workflow[${request.key}]`,
        used: 64, limit: 64, requested: 1, remaining: 0 });
      return { key: request.key, ok: false, error: error.message, output: error.message, artifactPaths: [] };
    }
    return normal();
  });
  expect((await host.execute()).status).toBe("budget-exhausted");
  expect(host.current().reviewModels).toEqual(frozen);
  // Invalid current settings must not be read after admission, even mid-review.
  writeFileSync(file, JSON.stringify({ pitako: { review: { r1: false, r2: false, synthesis: false } } }));
  host.setLaunchRespond();
  expect((await host.execute()).status).toBe("complete");
  const prefix = "invoke-human-1.l1.review.";
  const children = host.calls.filter(call => call.key.startsWith(prefix) && call.phase?.startsWith("review-"));
  expect(children.map(call => call.key.slice(prefix.length))).toEqual([
    "director-prepare", "independent-evidence-contract-r2", "independent-angle1-r1",
    "independent-angle1-r2", "independent-evidence-contract-r1", "director-synthesis",
  ]);
  for (const call of children) {
    const slot = call.key.endsWith("-r1") ? "r1" : call.key.endsWith("-r2") ? "r2" : "synthesis";
    expect(call.model).toBe(frozen[slot].model);
  }
  const count = host.calls.length;
  expect((await host.execute()).status).toBe("complete");
  expect(host.calls).toHaveLength(count);
});

test.each(["r1", "r2", "synthesis"] as const)("invalid full-review %s admission blocks before director", async slot => {
  for (const invalid of invalidModels) {
    const host = fixture();
    host.setHostResponse((key, value) => key === "inspect-initial" ? { ...value,
      admission: { ...value.admission, reviewModels: { ...value.admission.reviewModels,
        [slot]: { key: `pitako.review.${slot}`, model: invalid } } } } : value);
    const outcome = await host.execute();
    expect(outcome).toMatchObject({ status: "blocked", loopsConsumed: 0 });
    expect(outcome.reason).toContain(`pitako.review.${slot}`);
    expect(host.calls).toHaveLength(0);
  }
});

test.each(["director-prepare", "independent-evidence-contract-r1", "director-synthesis"])(
  "full-review model failure at %s names setting/model/native error without fallback", async suffix => {
    const host = fixture(undefined, { taskCount: 0 });
    const file = path.join(host.root, ".pi/settings.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pitako: { review: {
      r1: "custom/first", r2: "custom/second", synthesis: "custom/director",
    } } }));
    host.setRespond((request, normal) => request.key.endsWith(`.review.${suffix}`)
      ? { ok: false, error: `Unknown subagent model '${request.model}' in the active Pi model registry.` }
      : normal());
    const outcome = await host.execute();
    expect(outcome.status).toBe("blocked");
    const slot = suffix.endsWith("-r1") ? "r1" : "synthesis";
    expect(outcome.reason).toContain(`pitako.review.${slot}`);
    expect(outcome.reason).toContain(slot === "r1" ? "custom/first" : "custom/director");
    expect(outcome.reason).toContain("Unknown subagent model");
    if (suffix.startsWith("independent-")) {
      // The independent batch is admitted together; failure must stop later phases, not retry a slot.
      const independent = host.calls.filter(call => call.key.includes(".review.independent-"));
      expect(independent).toHaveLength(4);
      expect(host.calls.at(-1)!.key).toEndWith(".review.independent-angle1-r2");
      expect(host.calls.some(call => call.key.endsWith(".review.director-synthesis"))).toBe(false);
    } else expect(host.calls.at(-1)!.key).toEndWith(`.review.${suffix}`);
    const count = host.calls.length;
    expect((await host.execute()).status).toBe("blocked");
    expect(host.calls).toHaveLength(count);
  });
