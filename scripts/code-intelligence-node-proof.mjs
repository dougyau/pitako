import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import codegraph from "@colbymchenry/codegraph";

const graph = await codegraph.CodeGraph.open(process.cwd());
try {
  const state = graph.getIndexState();
  const stale = graph.isIndexStale();
  const changedFiles = graph.getChangedFiles();
  assert.equal(typeof state, "string");
  assert.equal(typeof stale, "boolean");
  assert.ok(["added", "modified", "removed"].every((key) => Array.isArray(changedFiles[key])));
  const changedCount = changedFiles.added.length + changedFiles.modified.length + changedFiles.removed.length;
  console.log(`existing index: state=${state}, stale=${stale}, changedFiles=${changedCount}`);
  console.log(`ESM default-import CodeGraph.open: ${typeof codegraph.CodeGraph.open}`);
} finally {
  await graph.close?.();
}

const missingRoot = mkdtempSync(path.join(os.tmpdir(), "pitako-cg-missing-"));
try {
  await assert.rejects(codegraph.CodeGraph.open(missingRoot), /not initialized/i);
  console.log("missing index: CodeGraph.open rejects as not initialized");
} finally {
  rmSync(missingRoot, { recursive: true, force: true });
}
