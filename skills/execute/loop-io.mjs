import "./loader.mjs";
import { readFileSync } from "node:fs";
import { readRequest } from "./ledger.mjs";
const { prepare, apply, gate, currentHumanPostIds, reviewOriginals } = await import("./loop.ts");

try {
  const { operation, ...input } = readRequest(readFileSync(0, "utf8"));
  if (input.root !== undefined && input.root !== process.cwd()) throw new Error("loop-io root must be its actual cwd");
  input.root = process.cwd();
  const operations = { prepare, apply, gate, reviewOriginals };
  if (!Object.hasOwn(operations, operation)) throw new Error("Expected loop-io prepare, apply, gate or reviewOriginals");
  if (operation === "apply") input.currentHumanIds = await currentHumanPostIds(input);
  const value = await operations[operation](input);
  if (operation === "apply") {
    const prepared = await prepare({ root: input.root, specId: input.specId, previousConfirmedUnit: null,
      taskId: value.selected?.id, invocation: input.invocation, loop: input.loop, dbPath: input.dbPath });
    if (prepared.digest !== value.digest) throw new Error(`backlog-conflict: ${prepared.path}`);
    value.view = prepared.view;
  }
  const { backlog, ...receipt } = value;
  if (backlog) {
    receipt.acceptance = backlog.acceptance;
    receipt.acceptanceHistory = backlog.acceptanceHistory;
  }
  const output = JSON.stringify(receipt);
  if (operation === "gate" && Buffer.byteLength(output + "\n") > 8192) throw new Error("Gate receipt exceeds 8 KiB");
  process.stdout.write(output + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ error: "loop-io", reason: error instanceof Error ? error.message : String(error), selectionRejected: error?.selectionRejected === true }) + "\n");
  process.exitCode = 1;
}
