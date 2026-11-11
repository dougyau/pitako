import { readFileSync } from "node:fs";
import { createRequire, registerHooks, stripTypeScriptTypes } from "node:module";

// Node >=22.19 supports these hooks. Native stripping alone rejects node_modules.
// Only the owned observation/inspector source closure is loaded here, never package dependencies.
const require = createRequire(import.meta.url);
const sources = new Set([
  "./loop.ts",
  "../../extensions/board/store.ts",
  "../../extensions/board/sqlite.ts",
  "../../extensions/board/author.ts",
  "./inspect.ts",
  "./observe.ts",
  "../../extensions/spec-plans.ts",
  "../../extensions/git-port.ts",
  "../../extensions/dev-tools/core/process.ts",
  "../../extensions/execute-retained.ts",
  "../../extensions/execute-checkpoint.ts",
  "../../extensions/execute-state.ts",
  "../../extensions/board/workspace.ts",
  "../../extensions/board/paths.ts",
  "../../extensions/errors.ts",
  "../../extensions/execute-settings.ts",
].map(source => new URL(source, import.meta.url).href));
registerHooks({
  load(url, context, nextLoad) {
    if (!sources.has(url)) return nextLoad(url, context);
    return { format: "module", shortCircuit: true,
      // Board's parameter property needs transformation; Node 26 only supports stripping.
      source: url.endsWith("/board/store.ts")
        ? require("typescript").transpileModule(readFileSync(new URL(url), "utf8"), {
          compilerOptions: { target: "ES2022", module: "ESNext" }, fileName: new URL(url).pathname,
        }).outputText
        : stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { sourceUrl: url }) };
  },
});
