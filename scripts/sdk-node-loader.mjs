import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

// Fixture-only: Node refuses third-party .ts; use its public stripper, not a product fallback.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND" && context.parentURL?.includes("/node_modules/") &&
        specifier.startsWith(".") && specifier.endsWith(".js") && existsSync(new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL))) {
        return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.includes("/node_modules/") && url.endsWith(".ts")) {
      return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
