import { readFileSync } from "node:fs";
import path from "node:path";

// SettingsManager 1.4.0 catches load errors and migrates known settings. Admission
// needs strict, read-only diagnostics for these extension-owned keys instead.
export const DEFAULT_TASK_REVIEWER = "openai-codex/gpt-6.1-sol:xhigh";
export const DEFAULT_TASK_SYNTHESIS = "anthropic/claude-opus-5-5:high";
export function isExecuteReviewModel(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value &&
    /^[^/\s:*?,]+\/[^\s*?,]+(?::(?:off|minimal|low|medium|high|xhigh|max))?$/.test(value);
}
export function executeTaskReviewer(root: string, agentDir: string): string {
  return executeSetting(root, agentDir, "taskReviewer", DEFAULT_TASK_REVIEWER);
}
export function executeTaskSynthesis(root: string, agentDir: string): string {
  return executeSetting(root, agentDir, "taskSynthesis", DEFAULT_TASK_SYNTHESIS);
}
export function executeMaxCycles(root: string, agentDir: string): number {
  return executeSetting(root, agentDir, "maxCycles", 3);
}
export function executeRevivalContextPeak(root: string, agentDir: string): number {
  return executeSetting(root, agentDir, "revivalContextPeak", 120000);
}
function executeSetting(root: string, agentDir: string, name: string, fallback: number): number;
function executeSetting(root: string, agentDir: string, name: string, fallback: string): string;
function executeSetting(root: string, agentDir: string, name: string, fallback: string | number): string | number {
  const key = `pitako.execute.${name}`;
  let effective: { value: unknown; file: string } | undefined;
  for (const file of [path.join(agentDir, "settings.json"), path.join(root, ".pi/settings.json")]) {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`${file}: ${key}: ${String(error)}`);
    }
    let settings;
    // Match Pi's stripBom convention without accepting any other non-JSON syntax.
    try { settings = JSON.parse(raw.startsWith("\uFEFF") ? raw.slice(1) : raw); }
    catch (error) { throw new Error(`${file}: ${key}: ${String(error)}`); }
    if (settings?.pitako?.execute && Object.hasOwn(settings.pitako.execute, name))
      effective = { value: settings.pitako.execute[name], file };
  }
  if (!effective) return fallback;
  if (typeof fallback === "string") {
    if (!isExecuteReviewModel(effective.value))
      throw new Error(`${effective.file}: ${key}: expected one exact provider/id[:thinking] string, received ${JSON.stringify(effective.value)}.`);
    return effective.value;
  }
  if (typeof effective.value !== "number" || !Number.isSafeInteger(effective.value) || effective.value < 1)
    throw new Error(`${effective.file}: ${key}: expected a positive safe integer, received ${JSON.stringify(effective.value)}.`);
  return effective.value;
}
