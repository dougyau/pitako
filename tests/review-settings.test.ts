import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewModels } from "../extensions/review-settings.ts";
import { analysisResource } from "../extensions/plan-execute.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-review-settings-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir);
  mkdirSync(path.join(root, ".pi"));
  return { root, agentDir, global: path.join(agentDir, "settings.json"), project: path.join(root, ".pi/settings.json") };
}

test("review model defaults and per-key project precedence preserve exact strings", () => {
  const f = fixture();
  expect(reviewModels(f.root, f.agentDir)).toEqual({
    r1: { key: "pitako.review.r1", model: "anthropic/claude-opus-5-5:high" },
    r2: { key: "pitako.review.r2", model: "openai-codex/gpt-6.1-sol:xhigh" },
    synthesis: { key: "pitako.review.synthesis", model: "anthropic/claude-opus-5-5:high" },
  });
  writeFileSync(f.global, '\uFEFF' + JSON.stringify({ pitako: { review: { r1: "global/a:high", r2: "global/b" } } }));
  writeFileSync(f.project, JSON.stringify({ pitako: { review: { r1: "ollama/qwen2.5-coder:7b:high", synthesis: "project/director:off" } } }));
  expect(Object.values(reviewModels(f.root, f.agentDir)).map(entry => entry.model))
    .toEqual(["ollama/qwen2.5-coder:7b:high", "global/b", "project/director:off"]);
});

test.each([null, 42, "", "provider", " provider/model", "p/m ", "p/*", "p/a,p/b", ["p/m"], "p/", "/m", "p/m?"].map(value => ({ value })))(
  "invalid review value %j fails resource resolution with file and key", ({ value }) => {
    const f = fixture();
    for (const slot of ["r1", "r2", "synthesis"]) {
      writeFileSync(f.project, JSON.stringify({ pitako: { review: { [slot]: value } } }));
      const resolve = () => analysisResource("pitako.review", f.root, f.agentDir).resolve({
        missionId: "m", missionPath: path.join(f.root, "m.json"),
      });
      expect(resolve).toThrow(f.project);
      expect(resolve).toThrow(`pitako.review.${slot}`);
    }
  },
);

test("malformed settings fail closed instead of supplying defaults", () => {
  const f = fixture();
  writeFileSync(f.global, "{broken");
  expect(() => reviewModels(f.root, f.agentDir)).toThrow(f.global);
  expect(() => reviewModels(f.root, f.agentDir)).toThrow("pitako.review");
});
