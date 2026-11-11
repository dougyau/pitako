import { readFileSync } from "node:fs";
import path from "node:path";
import { isExecuteReviewModel } from "./execute-settings.ts";

export function reviewModels(root: string, agentDir: string) {
  const models = {
    r1: { key: "pitako.review.r1", model: "anthropic/claude-opus-5-5:high" },
    r2: { key: "pitako.review.r2", model: "openai-codex/gpt-6.1-sol:xhigh" },
    synthesis: { key: "pitako.review.synthesis", model: "anthropic/claude-opus-5-5:high" },
  };
  const effective = new Map<string, { value: unknown; file: string }>();
  for (const file of [path.join(agentDir, "settings.json"), path.join(root, ".pi/settings.json")]) {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`${file}: pitako.review: ${String(error)}`);
    }
    let settings;
    try { settings = JSON.parse(raw.startsWith("\uFEFF") ? raw.slice(1) : raw); }
    catch (error) { throw new Error(`${file}: pitako.review: ${String(error)}`); }
    for (const slot of Object.keys(models))
      if (settings?.pitako?.review && Object.hasOwn(settings.pitako.review, slot))
        effective.set(slot, { value: settings.pitako.review[slot], file });
  }
  for (const [slot, selection] of Object.entries(models)) {
    const setting = effective.get(slot);
    if (!setting) continue;
    if (!isExecuteReviewModel(setting.value))
      throw new Error(`${setting.file}: ${selection.key}: expected one exact provider/id[:thinking] string, received ${JSON.stringify(setting.value)}.`);
    selection.model = setting.value;
  }
  return models;
}
