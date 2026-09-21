import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

export interface LoadedPitako {
  cwd: string;
  agentDir: string;
  packageRoot: string;
  relativePackagePath: string;
  extensions: LoadExtensionsResult;
  loader: DefaultResourceLoader;
}

/** Load Pitako the way Pi loads a local package path from project settings. */
export async function loadPitako(packageRoot: string, cwd = mkdtempSync(path.join(tmpdir(), "pitako-project-"))): Promise<LoadedPitako> {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-agent-"));
  const settingsDir = path.join(cwd, ".pi");
  mkdirSync(settingsDir, { recursive: true });
  const relativePackagePath = path.relative(settingsDir, packageRoot);
  if (path.isAbsolute(relativePackagePath)) {
    throw new Error(`Expected a relative package path, got ${relativePackagePath}`);
  }
  writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({ packages: [relativePackagePath] }, null, 2),
  );
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noContextFiles: true,
    noThemes: true,
  });
  await loader.reload();
  return {
    cwd,
    agentDir,
    packageRoot,
    relativePackagePath,
    extensions: loader.getExtensions(),
    loader,
  };
}

export function registeredToolNames(result: LoadExtensionsResult): string[] {
  const names: string[] = [];
  for (const extension of result.extensions) {
    for (const name of extension.tools.keys()) names.push(name);
  }
  return names.sort();
}

export function extensionPaths(result: LoadExtensionsResult): string[] {
  return result.extensions.map((extension) => extension.resolvedPath);
}
