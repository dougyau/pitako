import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

// Owned writer helper, deliberately separate from the read-only host inspector.
const sources = new Set([
  "../../extensions/execute-checkpoint.ts", "../../extensions/spec-plans.ts",
  "../../extensions/board/workspace.ts", "../../extensions/board/paths.ts",
  "../../extensions/errors.ts",
].map(source => new URL(source, import.meta.url).href));
registerHooks({
  load(url, context, nextLoad) {
    if (!sources.has(url)) return nextLoad(url, context);
    return { format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { sourceUrl: url }) };
  },
});
const { captureCheckpoint, applyCheckpoint, prepareCheckpoint, completeCheckpoint, restoreCheckpoint, sealCheckpointRequest } = await import("../../extensions/execute-checkpoint.ts");
const { readRequest } = await import("./ledger.mjs");
const [operation, requestFile] = process.argv.slice(2);
// The registered sealer receives pi-subagents' framed external-cli stdin.
const request = operation === "--seal-stdin" ? readRequest(readFileSync(0, "utf8")) : JSON.parse(readFileSync(requestFile, "utf8"));
if (operation === "--seal-stdin") {
  const output = JSON.stringify(sealCheckpointRequest(request));
  if (Buffer.byteLength(output, "utf8") > 60 * 1024) throw new Error("Checkpoint sealer output exceeds 60 KiB.");
  console.log(output);
} else if (operation === "capture") console.log(JSON.stringify(captureCheckpoint(request.intent, request.paths)));
else if (operation === "apply") applyCheckpoint(request.intent, request.changes);
else if (operation === "prepare") prepareCheckpoint(request.intent, request.changes);
else if (operation === "complete") completeCheckpoint(request.intent);
else if (operation === "restore") console.log(JSON.stringify(restoreCheckpoint(request.intent, request.authority)));
else throw new Error("Expected checkpoint capture, prepare, complete, apply or restore and an associated request JSON file.");
