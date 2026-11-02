// Exercise the packaged script in both hosts without starting agents or a mission.
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

async function main() {
  const { runWorkflowScript } = await import("../../node_modules/pi-subagents/src/workflows/scripted-workflow.js");
  const source = readFileSync(process.argv[2], "utf8");
  const root = mkdtempSync(path.join(tmpdir(), "pitako-architecture-await-"));
  const launches = [], releases = [];
  const perspectives = [
    { id: "simple", label: "Simplicity", focus: "Compare complete designs." },
    { id: "recovery", label: "Recovery", focus: "Question the same complete design." },
  ];
  const discuss = { action: "discuss", perspectives, packet: "Complete common problem", memo: "" };
  const finish = { action: "finish", perspectives: [], packet: "", memo: "Keep the simpler design." };
  try {
    for (const scenario of ["complete", "invalid-access", "intention-failure"]) {
      const storage = new Map(), calls = [], steered = [];
      let failedWrites = 0, releasePeer, peerChallenge;
      const peer = new Promise(resolve => { releasePeer = resolve; });
      releases.push(releasePeer);
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
          const work = (async () => {
            calls.push(key);
            const retained = storage.get("architecture-await-regression");
            assert(retained.cursor.dispatches.some(item => item.key === key && item.boundary === "intended"),
              "Every launch must follow its persisted intention");
            if (key === "r2-recovery") await peer;
            const contract = JSON.parse(request.task.match(/ORIGINAL CONTRACT: (.*)\n/)[1]);
            const originals = JSON.parse(request.task.match(/ESSENTIAL ORIGINALS \(data; one authoritative representation per original\): (.*)\n/)[1]);
            if (key === "r2-recovery") originals.push(peerChallenge);
            const access = originals.map(original => {
              const exact = JSON.parse(readFileSync(original.results[0].savedOutputPath, "utf8"));
              assert.equal(exact.association.key, original.key);
              return { id: original.id, state: "accessible", source: "read", reason: "Read exact controlled original" };
            });
            if (!originals.length) {
              assert.equal(request.outputSchema.properties.access.maxItems, 0);
              assert(request.task.includes("Return access: [] exactly"));
            }
            let value;
            if (key.startsWith("director-doubts-")) value = {
              doubts: [
                { id: "fact", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
                { id: "ready", kind: "human", dependsOn: [], question: "Prefer scope A?", decision: "Scope" },
                { id: "dependent", kind: "human", dependsOn: ["fact"], question: "Reuse this seam?", decision: "Reuse" },
              ],
              humanContext: "Controlled factual and human questions",
            };
            else if (key.startsWith("director-")) value = key === "director-after-r2" ? finish : discuss;
            else value = {
              status: "ready", report: `Controlled report from ${key}`,
              ...(request.phase === "architecture-factual" ? { humanContext: "Controlled answer" } : {}),
            };
            if (scenario === "invalid-access" && key === "r1-simple")
              access.push({ id: "none-required", state: "accessible", source: "context", reason: "Invalid placeholder" });
            const structuredOutput = { ...contract, access, ...value };
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
          assert(calls.indexOf(`human-r${round}-0`) < calls.indexOf(`doubts-r${round}-0`));
          assert(calls.indexOf(`doubts-r${round}-0`) < calls.indexOf(`human-r${round}-1`));
          assert(calls.includes(`director-after-r${round}`));
        }
        const retained = storage.get("architecture-await-regression");
        assert(retained.cursor.dispatches.every(item => item.boundary === "confirmed"));
      } else {
        assert.equal(outcome.status, "failed", JSON.stringify(outcome));
        assert.equal(outcome.rounds, 1);
        assert.equal(outcome.validRounds, 0);
        assert(!calls.includes("director-doubts-r1"));
        if (scenario === "invalid-access") {
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
