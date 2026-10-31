import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

// Node >=22.19 supports these hooks. Native stripping alone rejects node_modules.
// Only the owned observation/inspector source closure is loaded here, never package dependencies.
const sources = new Set([
  "./inspect.ts",
  "./observe.ts",
  "../../extensions/spec-plans.ts",
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
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { sourceUrl: url }) };
  },
});

