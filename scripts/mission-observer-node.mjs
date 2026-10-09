import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = mkdtempSync(path.join(tmpdir(), "pitako-observer-"));
async function probe(bootstrap) {
  const worker = new Worker(bootstrap, { workerData: { loaderRoot: fixture } });
  const timer = setTimeout(() => worker.terminate(), 15_000);
  try {
    await new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.on("exit", code => reject(new Error(`observer exited ${code} before proof`)));
      worker.on("message", row => {
        if (row.kind === "error") reject(new Error(row.error));
        if (row.kind === "ready") worker.postMessage({ id: "probe", operation: "probe" });
        if (row.kind === "result") {
          assert.deepEqual(row.value, { bridge: "physical-observer-v1" });
          resolve();
        }
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}
async function treeProof() {
  const tree = path.join(fixture, "tree");
  mkdirSync(tree);
  const entries = 12_000;
  for (let i = 0; i < entries; i++) writeFileSync(path.join(tree, `entry-${i}`), `${i}\n`);
  const bootstrap = new URL("../extensions/mission/physical-observer.mjs", import.meta.url);
  for (const cancel of [false, true]) {
    const worker = new Worker(bootstrap, { workerData: { loaderRoot: fixture } });
    let markers = 0, result = false;
    const timer = setTimeout(() => worker.terminate(), 15_000);
    let marker;
    try {
      await new Promise((resolve, reject) => {
        worker.on("error", reject);
        worker.on("exit", code => cancel ? resolve() : reject(new Error(`tree worker exited ${code}`)));
        worker.on("message", row => {
          if (row.kind === "error") reject(new Error(row.error));
          if (row.kind === "ready") {
            marker = setInterval(() => markers++, 1);
            worker.postMessage({ id: "tree", operation: "paths", input: { root: tree } });
            if (cancel) setTimeout(() => worker.terminate(), 5);
          }
          if (row.kind === "result") {
            result = true;
            assert.equal(row.value.length, entries);
            resolve();
          }
        });
      });
      assert.ok(markers > 0, "host event loop did not overlap the physical read");
      assert.equal(result, !cancel);
      console.log(JSON.stringify({ entries, cancel, result, markers, node: process.version }));
    } finally {
      clearTimeout(timer);
      clearInterval(marker);
      await worker.terminate();
    }
  }
}
try {
  await probe(new URL("../extensions/mission/physical-observer.mjs", import.meta.url));
  const packaged = path.join(fixture, "package");
  mkdirSync(path.join(packaged, "extensions/mission"), { recursive: true });
  cpSync(path.join(root, "extensions"), path.join(packaged, "extensions"), { recursive: true });
  symlinkSync(path.join(root, "node_modules"), path.join(packaged, "node_modules"), "dir");
  await probe(new URL(`file://${packaged}/extensions/mission/physical-observer.mjs`));
  await treeProof();
  console.log(JSON.stringify({ node: process.version, publicLoader: "pass", packagedLoader: "pass" }));
} finally {
  rmSync(fixture, { recursive: true, force: true });
  console.log("owned observer fixture removed");
}
