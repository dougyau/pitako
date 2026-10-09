import { parentPort, workerData } from "node:worker_threads";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

// This is the only TS loading boundary. Do not rely on Node stripping TS or Pi internals.
try {
  const loader = new DefaultResourceLoader({
    cwd: workerData.loaderRoot,
    agentDir: workerData.loaderRoot,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [new URL("./physical-observer.ts", import.meta.url).pathname],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length || loaded.extensions.length !== 1)
    throw new Error(`observation bridge loading failed: ${JSON.stringify(loaded.errors)}`);
  parentPort.postMessage({ kind: "ready" });
} catch (error) {
  parentPort.postMessage({ kind: "error", error: String(error) });
}
