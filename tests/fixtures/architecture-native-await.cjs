// Exercise the packaged script in both hosts without starting agents or a mission.
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

async function main() {
  const { runWorkflowScript } = await import("../../node_modules/pi-subagents/src/workflows/scripted-workflow.js");
  const { appendLedger } = await import("../../skills/architecture/ledger.mjs");
  const { canonicalDigest } = await import("../../extensions/canonical.mjs");
  const { verifyGate } = await import("../../extensions/access-receipts.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "pitako-architecture-await-"));
  // The named resource inlines the mission binding; the raw path alone refuses to run.
  const missionPath = path.join(root, "mission.json");
  writeFileSync(missionPath, "{}");
  const raw = readFileSync(process.argv[2], "utf8");
  const launches = [], releases = [];
  const perspectives = [
    { id: "simple", label: "Simplicity", focus: "Compare complete designs." },
    { id: "recovery", label: "Recovery", focus: "Question the same complete design." },
  ];
  const discuss = { action: "discuss", perspectives, packet: "Complete common problem", memo: "" };
  const finish = { action: "finish", perspectives: [], packet: "", memo: "Keep the simpler design." };
  try {
    for (const scenario of ["complete", "invalid-schema", "intention-failure"]) {
      const storage = new Map(), calls = [], steered = [];
      let failedWrites = 0, releasePeer, peerChallenge;
      const peer = new Promise(resolve => { releasePeer = resolve; });
      releases.push(releasePeer);
      const source = `const pitakoAccess = ${JSON.stringify({ missionPath: path.join(root, `${scenario}.json`), namespace: "architecture-await" })};\n${raw}`;
      const result = await runWorkflowScript({
        script: source, timeoutMs: 2000,
        args: {
          consultation: "await-regression", workDescription: "Compare persistence designs",
          planning: true, maxRounds: 2,
          currentDecision: {
            version: 1, brief: "Choose a complete persistence design", constraints: ["Read-only"],
            obligations: [], humanDecisions: [], provenance: "Controlled caller",
          },
        },
        state: {
          get: key => storage.get(key),
          set: (key, value) => {
            if (scenario === "intention-failure" &&
                value.cursor.dispatches.some(item => item.key === "r1-simple" && item.boundary === "intended")) {
              failedWrites++;
              throw new Error("Controlled intention write failure");
            }
            storage.set(key, structuredClone(value));
          },
        },
        launch: (key, request) => {
          if (request.agent === "pitako.architecture-ledger") return Promise.resolve({ key, ok: true, agent: request.agent,
            runId: `native-${key}`, output: JSON.stringify(appendLedger(JSON.parse(request.task))), artifactPaths: [], results: [] });
          // The real model-free verifier runs before each consuming gate's intention.
          if (request.agent === "pitako.access-verifier") return Promise.resolve({ key, ok: true, agent: request.agent,
            runId: `native-${key}`, output: JSON.stringify(verifyGate(JSON.parse(request.task))), artifactPaths: [],
            results: [{ index: 0, agent: request.agent, task: request.task, exitCode: 0,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] });
          const work = (async () => {
            calls.push(key);
            const retained = storage.get("architecture-await-regression");
            assert(retained.cursor.dispatches.some(item => item.key === key && item.boundary === "intended"),
              "Every launch must follow its persisted intention");
            if (key === "r2-recovery") await peer;
            for (const field of ["association", "delivery", "access"])
              assert(!Object.hasOwn(request.outputSchema.properties, field));
            const references = request.task.match(/VERIFIED ESSENTIAL ORIGINALS \(references; receipt [^)]*\): (.*)\n/);
            const originals = references ? JSON.parse(references[1]) : [];
            if (key === "r2-recovery") originals.push(peerChallenge);
            for (const original of originals) {
              const exact = JSON.parse(readFileSync(original.path ?? original.savedOutputPath, "utf8"));
              const admitted = storage.get("architecture-await-regression").originals.find(item => item[0] === original.id);
              const dispatch = storage.get("architecture-await-regression").cursor.dispatches.find(item => item.originalId === original.id);
              if (dispatch) assert.equal(dispatch.runId, `native-${dispatch.key}`);
              if (admitted[4]) assert.equal(JSON.parse(admitted[4])[0], "complete");
              assert.equal(canonicalDigest(exact), admitted[3]);
              assert(!Object.hasOwn(admitted, "value"));
            }
            let value;
            if (key.startsWith("director-doubts-")) value = {
              doubts: [
                { id: "fact", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
              ],
              humanContext: "Controlled factual and human questions",
            };
            else if (key.startsWith("director-")) value = key === "director-after-r2" ? finish : discuss;
            else value = {
              status: "ready", report: `Controlled report from ${key}`,
              ...(request.phase === "architecture-factual" ? { humanContext: "Controlled answer" } : {}),
            };
            if (scenario === "invalid-schema" && key === "r1-simple") value.status = "invalid";
            const structuredOutput = value;
            const savedOutputPath = path.join(root, `${scenario}-${key}.json`);
            writeFileSync(savedOutputPath, JSON.stringify(structuredOutput));
            return {
              key, ok: true, runId: `native-${key}`, output: "", artifactPaths: [], structuredOutput,
              results: [{
                index: 0, agent: request.agent ?? "pitako.architect", task: request.task,
                exitCode: 0, savedOutputPath,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
              }],
            };
          })();
          launches.push(work);
          return work;
        },
        steer: async (key, message) => {
          steered.push(key);
          peerChallenge = JSON.parse(message.match(/warrants it:\n(.*)\n/)[1]);
          releasePeer();
          return { state: "delivered" };
        },
        status: async () => { throw new Error("Unexpected status polling"); },
      });
      const outcome = result.value;
      if (scenario === "complete") {
        assert.equal(outcome.status, "completed", JSON.stringify(outcome));
        assert.equal(outcome.rounds, 2);
        assert.equal(outcome.validRounds, 2);
        assert.deepEqual(steered, ["r2-recovery"]);
        for (const round of [1, 2]) {
          assert(calls.indexOf(`doubts-r${round}-0`) < calls.indexOf(`director-after-r${round}`));
          assert(calls.includes(`director-after-r${round}`));
        }
        const retained = storage.get("architecture-await-regression");
        assert(retained.cursor.dispatches.every(item => item.boundary === "confirmed"));
      } else {
        assert.equal(outcome.status, "failed", JSON.stringify(outcome));
        assert.equal(outcome.rounds, 1);
        assert.equal(outcome.validRounds, 0);
        assert(!calls.includes("director-doubts-r1"));
        if (scenario === "invalid-schema") {
          assert.match(outcome.error, /Original completeness\/schema\/association not demonstrated/);
          assert(calls.includes("r1-recovery"));
        } else {
          assert.match(outcome.error, /Controlled intention write failure/);
          assert.equal(failedWrites, 1);
          assert.deepEqual(calls, ["director-prepare"]);
        }
      }
    }
  } finally {
    releases.forEach(release => release());
    await Promise.allSettled(launches);
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
