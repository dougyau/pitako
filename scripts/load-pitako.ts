import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  /** Release only this call's default directories, after settling tools and sessions. */
  releaseOwnedDirectories(): void;
}

/** Load Pitako the way Pi loads a local package path from project settings. */
export async function loadPitako(packageRoot: string, cwd?: string, agentDir?: string): Promise<LoadedPitako> {
  const owned: string[] = [];
  const allocate = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    owned.push(dir);
    return dir;
  };
  const releaseOwnedDirectories = () => {
    while (owned.length) {
      rmSync(owned[owned.length - 1]!, { recursive: true, force: true });
      owned.pop();
    }
  };
  try {
    cwd ??= allocate("pitako-project-");
    agentDir ??= allocate("pitako-agent-");
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
      releaseOwnedDirectories,
    };
  } catch (error) {
    releaseOwnedDirectories();
    throw error;
  }
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
