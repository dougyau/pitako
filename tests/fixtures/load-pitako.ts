import path from "node:path";
import { extensionPaths, loadPitako, registeredToolNames } from "../../scripts/load-pitako.ts";

const packagePath = process.argv[2];
if (!packagePath) throw new Error("Expected the Pitako package path");

const loaded = await loadPitako(path.resolve(packagePath));
console.log(`PITAKO_LOAD_RESULT=${JSON.stringify({
  errors: loaded.extensions.errors.map(({ path: extensionPath, error }) => ({
    path: extensionPath,
    message: String(error),
  })),
  names: registeredToolNames(loaded.extensions),
  paths: extensionPaths(loaded.extensions),
})}`);
