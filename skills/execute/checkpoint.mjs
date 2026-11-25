import "./loader.mjs";
import { readFileSync } from "node:fs";
const { captureCheckpoint, prepareCheckpoint, completeCheckpoint, restoreCheckpoint, sealCheckpointRequest } = await import("../../extensions/execute-checkpoint.ts");
const { readRequest, committedSeal, executeEpoch, withExecuteStore } = await import("./ledger.mjs");
const [operation, requestFile] = process.argv.slice(2);
// The registered sealer receives pi-subagents' framed external-cli stdin.
const request = operation === "--seal-stdin" ? readRequest(readFileSync(0, "utf8")) : JSON.parse(readFileSync(requestFile, "utf8"));
if (operation === "--seal-stdin") {
  const { StoreError } = await import("../../extensions/pitako-store.ts");
  let receipt;
  try {
    receipt = sealCheckpointRequest(request);
    await withExecuteStore(request.intent.association.root, request.intent.association.invocation,
      () => committedSeal(request, receipt), executeEpoch(request.intent.association.invocation, request.intent.key));
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    receipt = error.code === "store-busy" ? { v: 1, kind: request.kind, outcome: error.code }
      : { code: error.code, reason: error.message, recovery: error.recovery };
  }
  const output = JSON.stringify(receipt);
  if (Buffer.byteLength(output, "utf8") > 60 * 1024) throw new Error("Checkpoint sealer output exceeds 60 KiB.");
  console.log(output);
} else if (operation === "capture") console.log(JSON.stringify(captureCheckpoint(request.intent, request.paths)));
else if (operation === "prepare") prepareCheckpoint(request.intent, request.changes);
else if (operation === "complete") completeCheckpoint(request.intent);
else if (operation === "restore") console.log(JSON.stringify(restoreCheckpoint(request.intent, request.authority)));
else throw new Error("Expected checkpoint capture, prepare, complete or restore and an associated request JSON file.");
