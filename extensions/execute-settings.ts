import { readFileSync } from "node:fs";
import path from "node:path";

// SettingsManager 1.4.0 catches load errors and migrates known settings. Admission
// needs strict, read-only diagnostics for this extension-owned key instead.
export function executeMaxCycles(root: string, agentDir: string): number {
  return executeSetting(root, agentDir, "maxCycles", 3);
}
export function executeRevivalContextPeak(root: string, agentDir: string): number {
  return executeSetting(root, agentDir, "revivalContextPeak", 120000);
}
function executeSetting(root: string, agentDir: string, name: string, fallback: number): number {
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
  if (typeof effective.value !== "number" || !Number.isSafeInteger(effective.value) || effective.value < 1)
    throw new Error(`${effective.file}: ${key}: expected a positive safe integer, received ${JSON.stringify(effective.value)}.`);
  return effective.value;
}
