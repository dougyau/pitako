// Owned offline public CLI fixture. The PTY driver supplies commands and dialog keys.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMissionFixture, missionDefinition } from "../tests/mission-fixtures.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";
import { FINALIZATION_PHASES } from "../extensions/mission/finalization.ts";

const out = path.resolve(process.argv[2]);
assert.equal(process.versions.bun, undefined);
assert.equal(process.env.PI_OFFLINE, "1");
mkdirSync(out, { recursive: true });
const restarting = process.argv[3] === "restart";
const f = restarting ? JSON.parse(readFileSync(path.join(out, "fixture.json"), "utf8")) :
  createMissionFixture("pitako-native-start-");
if (!restarting) {
rmSync(f.definitionFile); // Prove native discovery does not depend on the compatibility JSON sidecar.
const sourceRoot = f.root;
const executionRoot = path.join(f.base, "execution");
writeFileSync(f.planFile, `---
id: durable-fixture
revision: 1
status: frozen
execution: expected
---
# Native start fixture
## Goal
Produce a checked product using the copied dependency.
## Ordered work units
### T1 — Product
Objective: write the product, not a PASS report.
Scope: src/a
Acceptance:
- The product contains product and the copied dependency contains installed.
Expected evidence: a contained offline checker reads both actual files.
## Final verification and success
- The complete result contains product after cleanup with the same copied dependency.
`);
execFileSync("git", ["worktree", "add", "-q", "-b", "execution", executionRoot], { cwd: sourceRoot });
writeFileSync(path.join(executionRoot, ".gitignore"), ".pitako/\nnode_modules/\n");
mkdirSync(path.join(executionRoot, "src")); writeFileSync(path.join(executionRoot, "src/a"), "original\n");
mkdirSync(path.join(executionRoot, "scripts"));
writeFileSync(path.join(executionRoot, "scripts/setup.sh"),
  'set -eu\n[[ $(<node_modules/seed) == local ]]\nprintf installed > node_modules/dependency\n');
execFileSync("git", ["add", ".gitignore", "src", "scripts"], { cwd: executionRoot });
const seed = path.join(f.base, "seed"); mkdirSync(seed); writeFileSync(path.join(seed, "seed"), "local\n");
Object.assign(f, { executionRoot, seed });
writeFileSync(path.join(out, "fixture.json"), JSON.stringify(f));
}
const { executionRoot, seed } = f;
process.env.PI_CODING_AGENT_DIR = f.stateDir;
const template = missionDefinition();
delete template.budget;
template.schemaVersion = 3;
template.resourcePolicy = { limits: { roleLaunches: 8, artifactBytes: 20_000_000_000 }, estimates: { tokens: 1, activeTimeMs: 1 } };
if (process.env.PITAKO_NATIVE_CASE === "prerequisite") template.resourcePolicy.limits.tokens = 100;
template.authority.allowedPaths = ["src/**"];
template.authority.operations = ["write", "bash"];
template.authority.verificationProfiles = ["sealed-nested-verification-v1"];
template.authority.resumeAfterClose = true;
template.finalization = { contractVersion: 1, independentReview: true, requiredPredicates: ["product-present"],
  selections: { ordinary: ["product-present"], integrated: ["product-present"], affected: ["product-present"], final: ["product-present"] } };
const bounds = { paths: 100, largestFileBytes: 1000000, totalBytes: 1000000 };
const setup = { effectProfile: "execution-root-local-copy-v1", writableDirectories: ["node_modules"],
  activeTimeMs: 90000, artifactBytes: 1000000000,
  copy: { bounds, seeds: [{ source: seed, destination: "node_modules", bounds }] } };
const provider = await installMissionLocalProvider({ agentDir: f.stateDir, reasoning: true, contextWindow: 64000,
  responseGate: async (prompt, signal) => {
    if (!prompt.includes('"format":"mission-finalization-brief-v1"')) return;
    // Transport delay gives the PTY time to interrupt an actual admitted finalizer.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  },
  responseForPrompt: (prompt) => {
    if (!prompt.includes('"format":"mission-finalization-brief-v1"')) return "Product written; host must check it.";
    const brief = JSON.parse(prompt.slice(prompt.indexOf('{"format":"mission-finalization-brief-v1"')).split("\n")[0]);
    if (brief.target.phase === "whole-review") {
      const product = brief.resultFiles.find((file) => file.path === "src/a");
      const observed = product?.kind === "file" &&
        Buffer.from(product.bytesBase64, "base64").toString() === "product\n" &&
        brief.originalSource.includes("The complete result contains product after cleanup with the same copied dependency.") &&
        brief.manifest.phaseReceiptHashes.length === FINALIZATION_PHASES.length - 1;
      return JSON.stringify({ ...brief.expectedResponse, verdict: observed ? "approve" : "inconclusive" });
    }
    return JSON.stringify({ ...brief.expectedResponse, steps: brief.expectedResponse.steps.map((step) => ({
      skill: step.skill, changedPaths: [], noOpReason: "The single product write has no helper or redundant content to remove.",
    })) });
  },
  toolForPrompt: (prompt) => {
    if (prompt.includes('"format":"mission-finalization-brief-v1"')) return undefined;
    if (!prompt.startsWith("Mission preparation request"))
      return { name: "bash", arguments: { command: 'test "$(cat node_modules/dependency)" = installed && printf "product\\n" > src/a' } };
    const context = JSON.parse(prompt.split("\n")[1]);
    return { name: "codemode", arguments: { code: `
const raw = await tools.mission_prepare({id:"durable-fixture",requestId:${JSON.stringify(context.requestId)}});
const context = JSON.parse(typeof raw === "string" ? raw : raw.content[0].text).context;
const definition = ${JSON.stringify(template)};
for (const role of ["developer","reviewer"]) {
  const policy=context.roles[role];
  definition.authority.rolePolicies[role]={hash:policy.hash,provider:"pitako-mission-local",model:"fixture",fallbacks:[],
    primaryTarget:policy.primary,fallbackTargets:[]};
}
const unit=context.inventory.units[0];
definition.units=[{id:unit.engineId,role:"developer",kind:"implementation",dependencies:[],inputs:["."],outputs:["src/a"],
  risk:"low",retryLimit:0,originalIntent:{sourceId:unit.id,
    objective:context.inventory.context.filter(row=>row.role==="objective").map(row=>row.text).join(""),
    workBrief:unit.text,criteria:context.inventory.criteria.filter(row=>row.owner===unit.engineId)
      .map(row=>({sourceId:row.id,text:row.text,predicateIds:["product-present"]}))},
  acceptance:[{id:"product-present",kind:"command_exit",target:"result",expected:"0",timeoutMs:30000,
    profile:"sealed-nested-verification-v1",
    command:${JSON.stringify(`node --input-type=module -e 'import fs from "node:fs"; if(fs.readFileSync("src/a","utf8")!=="product\\n" || fs.readFileSync("node_modules/dependency","utf8")!=="installed") process.exit(2); console.log("observed product and copied dependency")'`)}}]}];
const proposal={definition,mappings:context.inventory.criteria.map(row=>({sourceId:row.id,predicateIds:["product-present"],
  explanation:"The contained command reads the actual product and dependency."}))};
text(await tools.mission_prepare({id:"durable-fixture",requestId:context.requestId,proposal,setup:${JSON.stringify(setup)}}));
` } };
  },
});
const config = path.join(f.stateDir, "pitako/config.toml");
mkdirSync(path.dirname(config), { recursive: true });
if (!restarting) writeFileSync(config, ["developer", "reviewer"].map((role) => `[model_policies.${role}]
primary = { model = "${provider.provider}/${provider.model}", reasoning = "high", fast = false }
`).join("\n"));
const extension = path.join(f.base, "native.js");
const missionModule = fileURLToPath(new URL("../extensions/mission/index.ts", import.meta.url));
writeFileSync(extension, `import {registerMissionExtension} from ${JSON.stringify(missionModule)};
import {writeFileSync} from "node:fs";
export default function(pi) { registerMissionExtension(pi);
pi.on("tool_result", event=>writeFileSync(${JSON.stringify(path.join(out, "tool-result.json"))},JSON.stringify(event)));
pi.on("session_shutdown", async()=>{ await globalThis.nativeFixtureSnapshot(); });
}
`);
process.chdir(executionRoot);
let observedMissionId = restarting ? JSON.parse(readFileSync(path.join(out, "mission.json"), "utf8")).id : undefined;
const observedArtifactHashes = new Set();
async function snapshot() {
  if (!existsSync(f.dbPath)) return;
  let db;
  try {
    db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
    const mission = observedMissionId ? db.inspectMission(observedMissionId) : db.findManagedMission(executionRoot);
    if (!mission) return;
    observedMissionId = mission.id;
    writeFileSync(path.join(out, "mission.tmp"), JSON.stringify(mission, null, 2));
    renameSync(path.join(out, "mission.tmp"), path.join(out, "mission.json"));
    // Retain actual production artifacts, including checks, checkpoints and certificate.
    mkdirSync(path.join(out, "objects"), { recursive: true });
    const hashes = new Set(JSON.stringify(mission.events).match(/[a-f0-9]{64}/g) ?? []);
    for (const hash of hashes) {
      if (observedArtifactHashes.has(hash)) continue;
      observedArtifactHashes.add(hash);
      let bytes;
      try { bytes = db.readArtifact(hash); } catch { continue; /* identity, not an artifact */ }
      writeFileSync(path.join(out, "objects", hash), bytes);
      for (const reference of bytes.toString().match(/[a-f0-9]{64}/g) ?? []) hashes.add(reference);
    }
    provider.flush(path.join(out, "provider.json"));
  } finally { db?.close(); }
}
let observing;
globalThis.nativeFixtureSnapshot = async () => {
  if (observing) await observing;
  observing = snapshot();
  try { await observing; } finally { observing = undefined; }
};
const observer = setInterval(() => { if (!observing) void globalThis.nativeFixtureSnapshot(); }, 2000);
observer.unref();
process.argv = [process.argv[0], "pi", "--offline", "--approve", "--no-extensions", "--no-context-files",
  "--no-skills", "--no-prompt-templates", "--no-themes", "-e", extension,
  "-e", path.join(f.stateDir, "extensions/mission-local-provider.js"), "-e", "builtin:codemode",
  "--tools", "codemode,mission_prepare", "--model", `${provider.provider}/${provider.model}`, "--no-session"];
// Public installed CLI entry, not an internal session/extension adapter.
await import(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
