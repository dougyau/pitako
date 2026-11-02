import { expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveWorkflowResource } from "../../node_modules/pi-subagents/src/workflows/workflow-resources.js";
import { consumeWorkflowResourcePermit } from "../../node_modules/pi-subagents/src/shared/workflow-child-permit.js";
import { runWorkflowScript } from "../../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { digest, SPEC_SECTIONS } from "../../extensions/spec-plans.ts";
import { planExecute, missionFiles, childResponse, registeredCheckpoint, type CompositionFixture, type NativeCheckpointFixture } from "./plan-execute-composition.ts";

// Shared registered checkpoint lifecycle scenario for the two checkpoint lifecycle
// test files; each file passes its own composition and native process fixtures.
export function checkpointScenarioFixture({ repository, disposers }: CompositionFixture, { nativeCheckpointCase }: NativeCheckpointFixture) {
  // Rejects treating an intention, a sealed-but-unadmitted file, or a pause as
  // completed progress. Continuation also rejects pre-unit rollback, dispatch-only
  // "success", answer reuse after a later Stop, lost admission and duplicate writers.
  // These execute registered code and real writer bytes in Node.
  let preparedPauseInput: any;
  function checkpointScenario(mode: string, preparePause = false) {
      const work = (async () => {
      let observation: [number, string, string] | undefined;
      if (mode === "pause-status-continue" && !preparePause) {
        observation = await nativeCheckpointCase(preparedPauseInput, `async () => {
          const finish = globalThis.finishPreparedPause;
          delete globalThis.finishPreparedPause;
          if (!finish) throw Error("Missing private real paused fixture");
          return finish();
        }`);
      } else {
      const root = repository(), nativeRoot = repository(), sessionId = randomUUID();
      const { missionPath, statePath } = missionFiles(nativeRoot);
      const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
      mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
      writeFileSync(path.join(root, ".pitako/plans/assignment.md"), content);
      if (mode.startsWith("pause-status-gaps")) {
        mkdirSync(path.join(root, ".pi"), { recursive: true });
        writeFileSync(path.join(root, ".pi/settings.json"), JSON.stringify({ pitako: { execute: { maxCycles: 1 } } }));
      }
      writeFileSync(path.join(root, "owned"), "previous uncommitted WIP");
      writeFileSync(path.join(root, "unrelated"), "unrelated WIP");
      const hooks = new Map<string, any>();
      planExecute({ on: (name: string, hook: any) => hooks.set(name, hook) } as unknown as ExtensionAPI);
      const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
      const prior = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = path.join(nativeRoot, "private-agent");
      try { hooks.get("session_start")({}, ctx); }
      finally { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; }
      disposers.push(() => hooks.get("session_shutdown")({}, ctx));
      const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath };
      expect(hooks.get("tool_call")({ toolName: "subagent", input: { workflow: "pitako.execute", cwd: root, args, options: { missionId: args.missionId } } }, ctx)).toBeUndefined();
      const resource = resolveWorkflowResource("pitako.execute", args, sessionId);
      if (!resource.ok) throw Error(resource.error);
      const permit = consumeWorkflowResourcePermit(resource.resource.permit, resource.resource.script);
      if (typeof permit === "string") throw Error(permit);
      let continuationScript: string | undefined, laterScript: string | undefined;
      if (mode.startsWith("pause-") && !mode.startsWith("pause-status-")) {
        const continuationResource = resolveWorkflowResource("pitako.execute", { ...args, unblock: true,
          resolution: { loop: 1, text: "Continue the cooperative pause from its saved pending work" } }, sessionId);
        if (!continuationResource.ok) throw Error(continuationResource.error);
        continuationScript = continuationResource.resource.script;
        if (mode === "pause-later-input" || mode === "pause-twice") {
          const laterResource = resolveWorkflowResource("pitako.execute", { ...args, unblock: true,
            resolution: { loop: 1, text: "New human continuation after the recorded Stop" } }, sessionId);
          if (!laterResource.ok) throw Error(laterResource.error);
          laterScript = laterResource.resource.script;
        }
      }
      const input = { mode, root, missionPath, statePath, script: resource.resource.script, preparePause,
        continuationScript, laterScript,
        metadata: { root, commonDir: path.join(root, ".git"), selected: { source: path.join(root, ".pitako/plans/assignment.md"), digest: digest(content) } },
        module: new URL("../../extensions/execute-checkpoint.ts", import.meta.url).href,
        toolModule: path.resolve("extensions/checkpoint-create.ts"),
        loaderModule: new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url).href,
        evidence: new URL("../../extensions/spec-plans.ts", import.meta.url).href };
      const harness = async (input: any, run: typeof runWorkflowScript, response: typeof childResponse, io: any, loadCheckpoint: typeof registeredCheckpoint) => {
        const storage = new Map<string, any>(), originals = new Map<string, any>(), calls: string[] = [], snapshots: any[] = [], points: any[] = [];
        const hostObservations: any[] = [];
        let recoveryReplay = false;
        let pauseAdmissionCut = false;
        let cut = false, sealError = "", continuing = false, laterContinuing = false, baseline = "", partialRef = "";
        const pauseMode = input.mode.startsWith("pause-");
        const cooperativePause = input.mode.startsWith("pause-status-");
        const lossReentry = input.mode.endsWith("loss-reentry");
        const restorationAdmissions: any[] = [], archives: any[] = [];
        let secondPause: any;
        const unitMode = input.mode.startsWith("unit-before-capture");
        const stateCut = (value: any) => {
          if (!continuing || cut) return false;
          const l = value.loop;
          return input.mode === "pause-input-cut" && l?.resolutions?.at(-1)?.stage === "intention";
        };
        const candidate = () => { const { head, fingerprint } = io.checkoutEvidence(input.root); return { head, fingerprint }; };
        const state = { get: (key: string) => structuredClone(storage.get(key)), set: (key: string, value: any) => {
          const checkpoint = value.lastConfirmed;
          const admission = checkpoint?.taskId === "second";
          if (!cut && input.mode === "admission-cut" && admission) { cut = true; throw Error("Before checkpoint admission save"); }
          storage.set(key, structuredClone(value)); io.writeFileSync(input.statePath, JSON.stringify(Object.fromEntries(storage))); // Only the admission/cursor ordering projection is observed below;
          // retain full native state in storage/on disk, not in every IPC snapshot.
          snapshots.push({ loops: value.loop ? [value.loop].map((loop: any) => ({ cursor: loop.cursor,
            results: loop.results?.map((entry: any) => ({ taskId: entry.taskId, status: entry.status ?? value.tasks[entry.taskId]?.completed?.status ?? value.tasks[entry.taskId]?.last?.status })) })) : [] });
          if (!pauseAdmissionCut && input.mode.includes("status-") && input.mode.endsWith("admission-cut") && value.loop?.attempt?.stage === "result" && value.loop.attempt.taskId === "second") {
            pauseAdmissionCut = true; throw Error("Cut after durable pause admission before yield");
          }
          if (input.mode === "pause-status-continue" && !cut && value.loop?.attempt?.taskId === "second" &&
              value.loop.attempt.number === 3 && value.loop.attempt.stage === "launched") { cut = true; throw Error("Cut after successor loss"); }
          if (unitMode && input.mode.endsWith("reentry") && !cut && value.loop?.attempt?.restore?.undispatched) { cut = true; throw Error("Cut after durable unit recovery intention"); }
          if (stateCut(value)) { cut = true; throw Error("Controlled pause persistence cut"); }
          if (!cut && input.mode === "cursor-cut" && admission && value.loop.attempt?.stage === "result") {
            cut = true; throw Error("After checkpoint admission before cursor advance");
          }
        } };
        const firstTask = (value: any, id: string) => {
          const unit = structuredClone(value.tasks[0]);
          Object.assign(unit, { id, kind: "implementation", scope: ["owned"], allowedEffects: ["edit owned"] });
          unit.checks[0].id = id + "-check"; return unit;
        };
        const options = { script: input.script, state,
          status: async (key: string) => {
            return (originals.get(key)?.structuredOutput?.status === "plan" ||
              (recoveryReplay && input.mode === "pause-reusable-result" && originals.has(key))) ? structuredClone(originals.get(key)) : ({ key, ok: true,
            ...(continuing && !laterContinuing && input.mode === "pause-later-input" ? { stopped: true } : {}),
            state: "unknown",
            output: "No current writer observation", artifactPaths: [] });
          },
          host: async (key: string, request: any) => {
            const stdout = io.execFileSync("sh", ["-c", request.command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            const observed = JSON.parse(stdout);
            hostObservations.push({ key, replay: recoveryReplay, checkpoint: observed.checkpointObservation ?? null });
            return { key, kind: "command", state: "passed", ok: true, exitCode: 0,
              stdout, stderr: "", durationMs: 0, outputPath: input.missionPath + ".host.log" };
          },
          launch: async (key: string, request: any) => {
            calls.push(key);
            if (request.agent === "pitako.execution-ledger") archives.push(JSON.parse(request.task).record);
            const pending = storage.get("invoke-human-1")?.loop;
            if (request.agent === "pitako.worker" && pending?.attempt?.restore)
              restorationAdmissions.push(structuredClone(pending.attempt));
            // Original lifecycle modes isolate confirmation. Pause-continuation modes
            // execute the actual selective restore and pending effects.
            // The controlled native boundary denies a restoration dispatch, so
            // no extra effects occur after its failed/unsealed second unit.
            if (!unitMode && !pauseMode && input.mode !== "abrupt-continue" && request.task?.includes("CHECKPOINT FALLBACK (same pending task"))
              return { key, ok: false, output: "", artifactPaths: [], error: "Blocked by pi-subagents permission rule: restoration denied in lifecycle fixture" };
            // Director/review do not consume a candidate. Modifying workers
            // receive their real identity below, after their owned effects.
            const needsCandidate = request.agent === "pitako.checkout-observer" || key.endsWith(".compliance") || (request.agent === "pitako.worker" && key.includes(".t3."));
            const result = response(key, request, input.metadata, needsCandidate ? candidate() : undefined);
            if (key.endsWith(".director")) {
              result.structuredOutput.association = JSON.parse(request.task.split("ASSOCIATION (data): ")[1].split("\n")[0]);
              result.structuredOutput.tasks[0].dependsOn = [{ taskId: "second", reason: "Verify the completed pending unit" }];
              result.structuredOutput.tasks.unshift(firstTask(result.structuredOutput, "first"), firstTask(result.structuredOutput, "second"));
              result.structuredOutput.tasks[0].dependsOn = []; result.structuredOutput.tasks[1].dependsOn = [];

            } else if (request.agent === "pitako.worker" && !key.includes(".t3.")) {
              const invocation = storage.get("invoke-human-1"), loop = invocation.loop, intent = loop.attempt.checkpoint;
              const second = intent.taskId === "second";
              if (cooperativePause && second && intent.attempt > 1) {
                continuing = true;
                baseline = io.readFileSync(input.root + "/owned", "utf8");
              }
              if (input.mode === "pause-status-continue" && second && [3, 6].includes(intent.attempt))
                throw Error("Successor disappeared before pre-capture");
              const checkpoint = await loadCheckpoint(request, input.root, io.loadExtensions, input.toolModule, key).catch((error: unknown) => { console.error(error); throw error; });
              let restoreReceipt: any;
              if (unitMode && second && intent.attempt === 1) {
                if (input.mode.endsWith("missing")) io.unlinkSync(invocation.lastConfirmed.checkpointRef);
                if (input.mode.endsWith("unadmitted")) {
                  const point = io.readFileSync(invocation.lastConfirmed.checkpointRef, "utf8");
                  const envelope = JSON.parse(point), value = JSON.parse(envelope.data);
                  value.intent.association.invocation = "foreign-unit";
                  // A self-consistent foreign publication is still not the root's
                  // exact admitted bytes. Do not fabricate a replacement receipt.
                  const data = JSON.stringify(value);
                  io.writeFileSync(invocation.lastConfirmed.checkpointRef, JSON.stringify({sha256: io.hash(data), data}));
                }
                if (input.mode.endsWith("conflict")) io.writeFileSync(input.root + "/owned", "unattributed edit");
                if (input.mode.endsWith("corrupt")) {
                  if (input.mode.endsWith("newer-corrupt")) {
                    await checkpoint("pre", ["owned"]);
                    io.writeFileSync(input.root + "/.pi/subagents/checkpoints/" + intent.key + "/manifest.json", "corrupt newer manifest");
                  } else io.writeFileSync(invocation.lastConfirmed.checkpointRef, "corrupt confirmed seal");
                }
                throw Error("Abrupt disappearance before pre-capture");
              }
              if (loop.attempt.restore) {
                if (unitMode || input.mode === "abrupt-continue") continuing = true;
                if ((lossReentry || ["pause-equivalent-capture", "pause-successor-corrupt"].includes(input.mode)) && !recoveryReplay) {
                  if (!lossReentry) {
                    await checkpoint("pre", ["owned"]);
                    if (input.mode === "pause-successor-corrupt") io.writeFileSync(input.root + "/.pi/subagents/checkpoints/" + intent.key + "/manifest.json", "corrupt successor");
                  }
                  throw Error("Successor disappeared before useful effects");
                }
                const restore = loop.attempt.restore;
                let receipt;
                try { receipt = io.restoreCheckpoint(restore.sourceKeys.map((key: string) =>
                  invocation.taskFrame.sources.find((source: any) => source.key === key)), restore.authority); }
                catch (error) {
                  // A real worker reports its concrete helper impediment, not a
                  // transport disappearance that would invite checkpoint replay.
                  const current = candidate();
                  Object.assign(result.structuredOutput, { taskId: intent.taskId, attempt: intent.attempt,
                    candidate: current, git: { ...result.structuredOutput.git, head: current.head },
                    status: "blocked", diagnosis: String(error), remaining: ["Resolve checkpoint bytes"], checks: [{
                      id: "second-check", command: "bun test affected", cwd: input.root, output: String(error), logPaths: [],
                      result: "not-run", before: current, after: current }] });
                  return result;
                }
                baseline = io.readFileSync(input.root + "/owned", "utf8");
                partialRef = receipt.partialRef;
                restoreReceipt = { ...receipt, restoredRef: receipt.partialRef.replace(/restore\.json$/, "restored.json") };
                if (input.mode === "pause-wrong-baseline") delete restoreReceipt.confirmedPause;
                if (input.mode === "unit-before-capture-wrong-baseline") delete restoreReceipt.confirmedUnit;
                if (input.mode === "pause-repeated-publication") throw Error("Disappeared after the same durable restoration publication");
                if (input.mode === "pause-effect-cut" && !cut) { cut = true; throw Error("Cut after actual pause restoration"); }
              }
              if (!(input.mode === "pause-status-continue" && second && intent.attempt === 2))
                await checkpoint("pre", unitMode && !second ? ["owned", "created"] : ["owned"]);
              if (input.mode === "pause-status-continue" && second && [2, 4, 5].includes(intent.attempt)) {
                if (intent.attempt === 5)
                  io.applyCheckpoint(intent, [{ path: "owned", image: { bytes: Buffer.from("journaled pending WIP").toString("base64"), mode: 420 } }]);
                const current = intent.attempt === 5 ? candidate() : restoreReceipt?.candidate ?? invocation.tasks[intent.taskId].last.candidate;
                Object.assign(result.structuredOutput, { taskId: intent.taskId, attempt: intent.attempt,
                  status: "continue", usefulProgress: true, diagnosis: `Further work ${intent.attempt} requires a fresh capture for another path`,
                  remaining: ["Finish the diagnosed pending work"], continuation: "Complete the newly diagnosed work",
                  candidate: current, ...(restoreReceipt ? { restoreReceipt } : {}),
                  git: { head: current.head, checkpoints: restoreReceipt ? [restoreReceipt.partialRef, restoreReceipt.restoredRef] : [], wip: "Unchanged pause WIP" },
                  checks: [{ id: "second-check", command: "bun test affected", cwd: input.root,
                    output: "Pending implementation", logPaths: [], result: "not-run", before: current, after: current }] });
                return result;
              }
              const manifestPath = input.root + "/.pi/subagents/checkpoints/" + intent.key + "/manifest.json";
              const before = JSON.parse(JSON.parse(io.readFileSync(manifestPath, "utf8")).data);
              const bytes = second && input.mode === "pause-twice" && intent.attempt === 2 ? "new pending pause work" : second ? (continuing ? "completed pending work from pause" : "partial next-unit WIP") : "confirmed first work";
              const changes = [{ path: "owned", image: { bytes: Buffer.from(bytes).toString("base64"), mode: 420 } }];
              if (unitMode && !second) changes.push({ path: "created", image: { bytes: Buffer.from("created by confirmed unit").toString("base64"), mode: 420 } });
              io.applyCheckpoint(intent, changes);
              if (continuing && input.mode === "pause-write-cut" && !cut) { cut = true; throw Error("Cut after unconfirmed post-pause write"); }
              if (second && (input.mode === "abrupt" || input.mode === "abrupt-continue" && intent.attempt === 1)) throw Error("Abrupt transport disappearance after partial write");
              if (second && input.mode === "missing") io.unlinkSync(manifestPath);
              if (second && input.mode === "corrupt") io.writeFileSync(manifestPath, "{broken");
              if (second && input.mode === "incomplete") io.prepareCheckpoint(intent, [{ path: "owned", image: { bytes: Buffer.from("not yet written").toString("base64"), mode: 420 } }]);
              let receipt: any;
              const kind = second && (input.mode === "pause" || pauseMode) && (!continuing || input.mode === "pause-twice" && intent.attempt === 2) ? "pause" : "unit";
              const stop = new AbortController();
              if (second && input.mode === "refused") stop.abort(new Error("Native control refuses checkpoint capture"));
              const stateBeforeSeal = io.readFileSync(input.statePath, "utf8");
              try { receipt = (await checkpoint(kind, undefined, stop.signal)).checkpointReceipt; }
              catch (error) { sealError = String(error); throw error; }
              // Replay is a tool guarantee, not extra setup for every recovery cut.
              // The complete/pause cases exercise actual unit and pause replay;
              // other modes retain one real publication per reached boundary.
              if (["complete", "pause"].includes(input.mode) &&
                  JSON.stringify((await checkpoint(kind)).checkpointReceipt) !== JSON.stringify(receipt))
                throw Error("Non-idempotent tool replay");
              if (io.readFileSync(input.statePath, "utf8") !== stateBeforeSeal) throw Error("Tool changed admission/cursor state");
              points.push({ receipt, before, point: JSON.parse(JSON.parse(io.readFileSync(receipt.checkpointRef, "utf8")).data) });
              if (second && input.mode === "seal-cut") throw Error("Abrupt cut after seal before returning result");
              // No checkout effects follow the registered seal. Reuse its real
              // identity instead of hashing the same bytes again; native mission
              // persistence is outside checkoutEvidence's candidate inventory.
              const current = receipt.candidate;
              Object.assign(result.structuredOutput, { taskId: intent.taskId, attempt: intent.attempt,
                status: kind === "pause" ? (input.mode.includes("status-continue") ? "continue" : input.mode.includes("status-gaps") ? "gaps" : "blocked") : "complete", remaining: kind === "pause" && input.mode !== "pause-empty" ? ["Pending second unit"] : [],
                continuation: kind === "pause" ? "Resume pending second unit from its exact pause" : null,
                checkpointReceipt: receipt, ...(restoreReceipt ? { restoreReceipt } : {}), candidate: current,
                git: { head: current.head, checkpoints: [receipt.checkpointRef, ...(restoreReceipt ? [restoreReceipt.partialRef, restoreReceipt.restoredRef] : [])], wip: "Real owned WIP" },
                checks: [{ id: intent.taskId + "-check", command: "bun test affected", cwd: input.root,
                  output: "Observed controlled unit", logPaths: [], result: "passed", before: current, after: current }] });
              if (second && input.mode === "missing-receipt") delete result.structuredOutput.checkpointReceipt;
              if (second && input.mode === "wrong-progress") result.structuredOutput.checkpointReceipt = {
                ...receipt, progress: { ...receipt.progress, consumedLoops: 2 } };
            }
            if (request.agent === "pitako.worker" && key.includes(".t3.") && (unitMode || pauseMode || input.mode === "abrupt-continue")) {
              const l = storage.get("invoke-human-1").loop;
              const completed = storage.get("invoke-human-1").tasks.second.completed;
              if (!completed || io.readFileSync(input.root + "/owned", "utf8") !== "completed pending work from pause" ||
                  !request.task.includes(completed.ref.key)) throw Error("Final verification preceded durable pending-work admission");
            }
            originals.set(result.runId!, structuredClone(result));
            if (input.mode === "pause-reusable-result" && continuing && key.endsWith(".t2.a2")) {
              originals.set(key, structuredClone(result));
              throw Error("Transport disappeared after the complete result survived");
            }
            return result;
          },
        };
        const result = await run(options as any);
        const finish = async () => {
        const original = structuredClone(storage.get("invoke-human-1"));
        const callsAtYield = [...calls];
        let unitReplay: any;
        if (unitMode && input.mode.endsWith("reentry")) {
          recoveryReplay = true; unitReplay = await run(options as any);
        }
        let noInputReplay: any;
        if (input.mode.includes("status-")) {
          recoveryReplay = true;
          const replayed = await run(options as any);
          noInputReplay = { result: replayed.value, calls: [...calls], cursor: storage.get("invoke-human-1").loop.cursor };
          if (input.mode === "pause-status-continue") {
            const again = await run(options as any);
            noInputReplay = { ...noInputReplay, again: again.value };
          }
        }
        let resumed: any;
        if (pauseMode && !cooperativePause) {
          const checkpoint = original.lastConfirmed;
          if (input.mode === "pause-missing") io.unlinkSync(checkpoint.checkpointRef);
          if (input.mode === "pause-corrupt") io.writeFileSync(checkpoint.checkpointRef, "corrupt pause");
          if (input.mode === "pause-conflict") io.writeFileSync(input.root + "/owned", "unattributed edit");
          continuing = true;
          resumed = await run({ ...options, script: input.continuationScript } as any);
          if (input.mode === "pause-later-input") { laterContinuing = true; resumed = await run({ ...options, script: input.laterScript } as any); }
          if (input.mode === "pause-twice") {
            secondPause = { result: resumed.value, retained: structuredClone(storage.get("invoke-human-1")), calls: [...calls], archives: structuredClone(archives) };
            resumed = await run({ ...options, script: input.laterScript } as any);
          }
          if (cut || lossReentry || ["pause-replay-complete", "pause-equivalent-capture", "pause-successor-corrupt", "pause-repeated-publication", "pause-reusable-result"].includes(input.mode)) {
            recoveryReplay = true;
            // Three reentries cover discovery of a successor/publication, the
            // resulting exhausted bound, and another unchanged-evidence replay.
            // More identical entries only repeat expensive native inspections.
            for (let reentry = 0; reentry < ((lossReentry || ["pause-equivalent-capture", "pause-repeated-publication"].includes(input.mode)) ? 3 : 1); reentry++)
              resumed = await run(options as any);
          }
        }
        return { archives, secondPause, restorationAdmissions, unitReplay: unitReplay?.value, created: unitMode ? io.readFileSync(input.root + "/created", "utf8") : null, noInputReplay, callsAtYield, hostObservations, resumed: resumed?.value, original, baseline, partialRef, result: result.value, retained: storage.get("invoke-human-1"), calls, snapshots, points: points.filter(point => point.point.intent.loop === 1), sealError,
          owned: io.readFileSync(input.root + "/owned", "utf8"), unrelated: io.readFileSync(input.root + "/unrelated", "utf8") };
        };
        if (input.preparePause) {
          (globalThis as any).finishPreparedPause = finish;
          return { prepared: true };
        }
        return finish();
      };
      if (preparePause) preparedPauseInput = input;
      observation = await nativeCheckpointCase(input, harness.toString());
      if (preparePause) {
        expect(observation?.[0], observation?.[2]).toBe(0);
        expect(JSON.parse(observation![1])).toEqual({ prepared: true });
        return;
      }
      }
      if (!observation) return; // Runner teardown cancelled and joined this case.
      const [exit, output, errors] = observation;
      {
        expect(exit, errors).toBe(0); expect(errors).not.toContain("unawaited runs.run launch(es)");
        const actual = JSON.parse(output); expect(actual.retained?.loop, JSON.stringify(actual)).toBeDefined(); const loop = actual.retained.loop;
        const history = (records: any[], retained: any[], tasks: any) => [...new Map(
          [...records.flatMap(record => record.body.results ?? []), ...retained.map(entry => entry.ref ? entry : (tasks[entry.taskId].completed ?? tasks[entry.taskId].last))]
            .map(result => [`${result.taskId}:${result.attempt}`, result])).values()]
          .sort((a: any, b: any) => ["first", "second", "final"].indexOf(a.taskId) - ["first", "second", "final"].indexOf(b.taskId) || a.attempt - b.attempt);
        loop.results = history(actual.archives.filter((record: any) => record.loop === loop.number), loop.results, actual.retained.tasks);
        if (actual.secondPause) actual.secondPause.retained.loop.results =
          history(actual.secondPause.archives, actual.secondPause.retained.loop.results, actual.secondPause.retained.tasks);
        if (mode.startsWith("unit-before-capture")) {
          const success = !["conflict", "corrupt", "missing", "unadmitted", "wrong-baseline"].some(suffix => mode.endsWith(suffix));
          expect((actual.unitReplay ?? actual.result).status, JSON.stringify(actual)).toBe(success ? "complete" : "blocked");
          expect(loop.results.filter((r: any) => r.taskId === "first" && r.status === "complete")).toHaveLength(1);
          expect(actual.created).toBe("created by confirmed unit");
          expect(actual.unrelated).toBe("unrelated WIP");
          expect(actual.retained.consumedLoops).toBe(1);
          expect(actual.retained.association.maxCycles).toBe(3);
          expect(actual.calls.filter((key: string) => key.endsWith(".t1.a1"))).toHaveLength(1);
          if (success) {
            expect(actual.baseline).toBe("confirmed first work");
            expect(actual.owned).toBe("completed pending work from pause");
            const receipt = loop.results.find((r: any) => r.taskId === "second").restore.receipt;
            expect(receipt.position).toEqual({loop: 1, cursor: 1, phase: "implementation"});
            expect(receipt.confirmedUnit).toEqual({checkpointRef: actual.points[0].receipt.checkpointRef, digest: actual.points[0].receipt.digest});
            expect(receipt.checkpointRef).toBe(actual.points[0].receipt.checkpointRef.replace(/unit.json$/, "manifest.json"));
            expect(loop.cursor).toBe(3);
            for (const suffix of [".t2.a1", ".t2.a2", ".t3.a1", ".compliance"])
              expect(actual.calls.filter((key: string) => key.endsWith(suffix))).toHaveLength(1);
            expect(actual.points).toHaveLength(2);
            expect(loop.results[0].checkpoint.confirmation).toEqual(actual.points[0].receipt);
            expect(existsSync(actual.points[0].receipt.checkpointRef.replace(/t1\.a1\/unit\.json$/, "t2.a1/manifest.json"))).toBe(false);
            const partial = JSON.parse(JSON.parse(readFileSync(receipt.partialRef, "utf8")).data);
            expect(Buffer.from(partial.partial[0].image.bytes, "base64").toString()).toBe("confirmed first work");
            if (mode.endsWith("reentry")) expect(actual.hostObservations.some((o: any) => o.replay && o.checkpoint?.evidence), JSON.stringify(actual.hostObservations)).toBe(true);
          } else {
            expect(loop.cursor).toBe(1);
            expect(actual.calls).not.toContain("invoke-human-1.l1.t3.a1");
            expect(actual.owned).toBe(mode.endsWith("conflict") ? "unattributed edit" : mode.endsWith("wrong-baseline") ? "completed pending work from pause" : "confirmed first work");
          }
          return;
        }
        if (mode === "abrupt-continue") {
          expect(actual.result).toMatchObject({ status: "complete", loopsConsumed: 1 });
          expect(actual.baseline).toBe("confirmed first work");
          expect(actual.owned).toBe("completed pending work from pause");
          expect(actual.unrelated).toBe("unrelated WIP");
          const partial = JSON.parse(JSON.parse(readFileSync(actual.partialRef, "utf8")).data);
          expect(Buffer.from(partial.partial[0].image.bytes, "base64").toString()).toBe("partial next-unit WIP");
          expect(loop.results.filter((entry: any) => entry.taskId === "first" && entry.status === "complete")).toHaveLength(1);
          expect(loop.results.find((entry: any) => entry.taskId === "second")).toMatchObject({ status: "complete", attempt: 2 });
          expect(loop.cursor).toBe(3);
          expect(actual.retained.lastConfirmed).toMatchObject({ taskId: "second", attempt: 2 });
          for (const suffix of [".t1.a1", ".t2.a1", ".t2.a2", ".t3.a1", ".review.director-synthesis", ".compliance"])
            expect(actual.calls.filter((key: string) => key.endsWith(suffix))).toHaveLength(1);
          expect(actual.points).toHaveLength(2); // No post-cut seal for the interrupted attempt.
          return;
        }
        if (mode.startsWith("pause-")) {
          const originalLoop = actual.original.loop;
          originalLoop.results = originalLoop.results.map((entry: any) => entry.ref ? entry :
            (actual.original.tasks[entry.taskId].completed ?? actual.original.tasks[entry.taskId].last));
          if (mode.startsWith("pause-status-")) {
            const status = mode.includes("status-continue") ? "continue" : "gaps";
            const paused = originalLoop.results[1], pause = paused.checkpoint.confirmation;
            expect(paused.status).toBe(status);
            expect(pause).toMatchObject({ kind: "pause", position: { cursor: 1 } });
            expect(createHash("sha256").update(readFileSync(pause.checkpointRef)).digest("hex")).toBe(pause.digest);
            if (mode.endsWith("admission-cut") || mode === "pause-status-continue") expect(actual.result.status).not.toBe("complete");
            else expect(actual.result.status).toBe(status === "continue" ? "complete" : "partial");
            if (mode === "pause-status-continue") {
              expect(actual.noInputReplay.result.reason).toContain("no new checkpoint evidence");
              expect(actual.noInputReplay.calls.some((key: string) => key.endsWith(".t2.a7"))).toBe(false);
              expect(actual.noInputReplay.again.status, JSON.stringify(actual.noInputReplay.again)).toBe("complete");
            } else expect(actual.noInputReplay.result.status, JSON.stringify(actual.noInputReplay.result)).toBe(status === "continue" ? "complete" : "partial");
            expect(actual.retained.association).toEqual(actual.original.association);
            expect(actual.retained.consumedLoops).toBe(1);
            expect(loop.halt).toBeUndefined();
            expect(loop.results[1]).toEqual(paused);
            expect(actual.unrelated).toBe("unrelated WIP");
            if (mode === "pause-status-continue") {
              expect(actual.restorationAdmissions).toHaveLength(2);
              expect(actual.restorationAdmissions[0].restore.authority.confirmedPause).toEqual(pause);
              expect(loop.results[3].restore.receipt.confirmedPause).toEqual({ checkpointRef: pause.checkpointRef, digest: pause.digest });
              expect(actual.restorationAdmissions[1].restore.sourceKeys).toEqual([
                "invoke-human-1.l1.t2.a6", "invoke-human-1.l1.t2.a5", "invoke-human-1.l1.t2.a4",
                "invoke-human-1.l1.t2.a3", "invoke-human-1.l1.t2.a2", "invoke-human-1.l1.t2.a1",
              ]);
              expect(actual.restorationAdmissions[1].restore.authority.confirmedPause).toEqual(pause);
              expect(actual.archives.at(-1).body.frame.operations.map((item: any) => Number(item.key.match(/a(\d+)$/)[1]))).toEqual([4, 7]);
              expect(actual.restorationAdmissions[1].restore.evidence).toBeTruthy();
              expect(actual.restorationAdmissions[1].restore.evidence).not.toBe(actual.restorationAdmissions[0].restore.evidence);
              expect(loop.results[5].restore.receipt.checkpointRef).toEndWith(".t2.a5/manifest.json");
              const partial = JSON.parse(JSON.parse(readFileSync(loop.results[5].restore.receipt.partialRef, "utf8")).data);
              expect(Buffer.from(partial.partial[0].image.bytes, "base64").toString()).toBe("journaled pending WIP");
              expect(actual.hostObservations.some((o: any) => o.replay && o.checkpoint?.evidence)).toBe(true);
              expect(loop.results[2]).toMatchObject({ attempt: 2, status: "continue", usefulContinuation: true });
              expect(loop.results[2].checkpoint.confirmation).toBeUndefined();
              expect(existsSync(pause.checkpointRef.replace(/t2\.a1\/pause\.json$/, "t2.a2/manifest.json"))).toBe(false);
              expect(existsSync(pause.checkpointRef.replace(/t2\.a1\/pause\.json$/, "t2.a3/manifest.json"))).toBe(false);
              expect(actual.calls.filter((key: string) => key.endsWith(".t2.a3"))).toHaveLength(1);
              expect(actual.calls.filter((key: string) => key.endsWith(".t2.a4"))).toHaveLength(1);
            } else expect(actual.restorationAdmissions).toEqual([]);
            expect(actual.calls.filter((key: string) => key.endsWith(".director"))).toHaveLength(1);
            expect(actual.calls.filter((key: string) => key.endsWith(".t1.a1"))).toHaveLength(1);
            expect(actual.calls.filter((key: string) => key.endsWith(".t2.a1"))).toHaveLength(1);
            if (status === "continue") {
              expect(loop.cursor).toBe(3);
              expect(loop.results.map((r: any) => r.status)).toEqual(mode === "pause-status-continue"
                ? ["complete", "continue", "continue", "continue", "continue", "complete", "complete"]
                : ["complete", "continue", "complete", "complete"]);
              expect(actual.retained.association.maxCycles).toBe(3);
              expect(actual.baseline).toBe("partial next-unit WIP");
              expect(actual.owned).toBe("completed pending work from pause");
              expect(actual.calls.filter((key: string) => key.endsWith(".t2.a2"))).toHaveLength(1);
              expect(actual.calls.filter((key: string) => key.endsWith(".review.director-synthesis"))).toHaveLength(1);
              expect(actual.calls.filter((key: string) => key.endsWith(".compliance"))).toHaveLength(1);
            } else {
              expect(loop.cursor).toBe(1);
              expect(loop.outcome).toBe("gaps");
              expect(actual.retained.association.maxCycles).toBe(1);
              expect(actual.owned).toBe("partial next-unit WIP");
              expect(actual.calls.some((key: string) => key.endsWith(".t2.a2") || key.endsWith(".compliance"))).toBe(false);
            }
            return;
          }
          if (mode === "pause-twice") {
            const paused = actual.secondPause.retained.loop;
            expect(actual.secondPause.result.status).toBe("blocked");
            expect(paused.cursor).toBe(1);
            expect(paused.results.map((r: any) => r.status)).toEqual(["complete", "blocked", "blocked"]);
            expect(actual.secondPause.retained.lastConfirmed).toMatchObject(paused.results[2].checkpoint.confirmation);
            expect(actual.secondPause.calls).not.toContain("invoke-human-1.l1.t3.a1");
            expect(actual.resumed.status, JSON.stringify(actual.resumed)).toBe("complete");
            expect(loop.cursor).toBe(3);
            expect(loop.results.slice(0, 3)).toEqual(paused.results);
            expect(actual.retained.association).toEqual(actual.original.association);
            expect(actual.retained.consumedLoops).toBe(1);
            expect(actual.restorationAdmissions).toHaveLength(2);
            for (const [index, admission] of actual.restorationAdmissions.entries()) {
              expect(admission.restore.evidence).toMatch(/^[a-f0-9]{64}$/);
              expect(admission.restore.authority.confirmedPause).toEqual(paused.results[index + 1].checkpoint.confirmation);
            }
            expect(actual.restorationAdmissions[0].restore.evidence).not.toBe(actual.restorationAdmissions[1].restore.evidence);
            const completed = loop.results.find((r: any) => r.taskId === "second" && r.status === "complete");
            const pause = paused.results[2].checkpoint.confirmation;
            expect(completed.restore.receipt.confirmedPause).toEqual({ checkpointRef: pause.checkpointRef, digest: pause.digest });
            expect(actual.baseline).toBe("new pending pause work");
            expect(actual.owned).toBe("completed pending work from pause");
            expect(actual.unrelated).toBe("unrelated WIP");
            expect(actual.calls.filter((key: string) => /\.t2\.a[2-9]/.test(key))).toHaveLength(2);
            expect(actual.calls).toContain("invoke-human-1.l1.t3.a1");
            expect(actual.calls).toContain("invoke-human-1.l1.compliance");
            return;
          }
          expect(actual.retained.association).toEqual(actual.original.association);
          expect(actual.retained.consumedLoops).toBe(1);
          expect(loop.results[0]).toEqual(originalLoop.results[0]);
          expect(loop.results[1]).toEqual(originalLoop.results[1]);
          expect(actual.unrelated).toBe("unrelated WIP");
          expect(actual.calls.filter((key: string) => key.endsWith(".t1.a1"))).toHaveLength(1);
          expect(actual.calls.filter((key: string) => key.endsWith(".t2.a1"))).toHaveLength(1);
          expect(new Set(actual.calls).size).toBe(actual.calls.length);
          expect(actual.calls.some((key: string) => key.includes(".recover"))).toBe(false);
          expect(actual.resumed.loopsConsumed).toBe(1);
          expect(loop.plan.ref).toEqual(originalLoop.plan.ref);
          expect(loop.manifest).toEqual(originalLoop.manifest);
          // Rejects per-process bounds, equivalent-capture renewal and treating
          // repeated idempotent restoration publication as fresh material progress.
          if (mode.endsWith("loss-reentry") || ["pause-equivalent-capture", "pause-repeated-publication"].includes(mode)) {
            expect(actual.resumed.status).not.toBe("complete");
            expect(actual.calls.filter((key: string) => /\.t2\.a[2-9]/.test(key)),
              "Unchanged evidence must not renew restoration across supported script reentries").toHaveLength(mode === "pause-repeated-publication" ? 2 : 1);
            const observed = actual.hostObservations.filter((entry: any) => entry.checkpoint);
            // Both terminal reentries see exactly the same exhausted evidence
            // and successor. A process-local bound would dispatch again here.
            expect(observed.at(-1).checkpoint).toEqual(observed.at(-2).checkpoint);
            expect(new Set(observed.map((entry: any) => entry.checkpoint.evidence)).size).toBe(mode === "pause-repeated-publication" ? 2 : 1);
            expect(loop.attempt.restore.evidence).toBe(observed.at(-1).checkpoint.evidence);
            if (mode.endsWith("loss-reentry")) {
              // Rejects blocked-only initial observation and null-to-hash renewal,
              // not merely independent pause-status and disappearance tests.
              const initial = observed.find((entry: any) => entry.checkpoint.attempt === 1).checkpoint;
              expect(initial.evidence).toMatch(/^[a-f0-9]{64}$/);
              expect(observed.every((entry: any) => entry.checkpoint.evidence === initial.evidence)).toBe(true);
              expect(actual.restorationAdmissions).toHaveLength(1);
              const admitted = actual.restorationAdmissions[0];
              expect(admitted.restore.evidence).toBe(initial.evidence);
              expect(admitted.restore.authority.confirmedPause).toEqual(originalLoop.results[1].checkpoint.confirmation);
              expect(loop.attempt.restore).toEqual(admitted.restore);
              expect(loop.cursor).toBe(1);
              expect(loop.results).toEqual(originalLoop.results);
              expect(actual.retained.lastConfirmed).toEqual(actual.original.lastConfirmed);
              expect(actual.retained.taskFrame.operations).toHaveLength(1);
              expect(actual.retained.tasks.second.last).toEqual(originalLoop.results[1]);
              expect(actual.retained.association.maxCycles).toBe(3);
              expect(actual.calls).toEqual([...actual.callsAtYield, "invoke-human-1.l1.t2.a2"]);
            }
            expect(actual.resumed.action.started).toBe(false);
            const replayed = observed.find((entry: any) => entry.replay);
            expect(replayed.checkpoint.attempt).toBe(2);
            expect(replayed.replay).toBe(true);
            expect(actual.resumed.reason).toContain("no new checkpoint evidence");
            expect(actual.owned).toBe("partial next-unit WIP");
            expect(actual.calls).not.toContain("invoke-human-1.l1.t3.a1");
            return;
          }
          const blocked = ["pause-missing", "pause-corrupt", "pause-conflict", "pause-empty", "pause-wrong-baseline", "pause-successor-corrupt"].includes(mode);
          if (blocked) {
            if (mode === "pause-empty") {
              expect(actual.original.lastConfirmed.taskId).toBe("first");
              expect(originalLoop.results.some((r: any) => r.checkpoint?.confirmation?.kind === "pause")).toBe(false);
            }
            expect(actual.resumed.status, JSON.stringify(actual.resumed)).not.toBe("complete");
            expect(actual.calls).not.toContain("invoke-human-1.l1.t3.a1");
            if (mode === "pause-empty")
              expect(actual.calls).not.toContain("invoke-human-1.l1.t2.a2");
            expect(actual.owned).toBe(mode === "pause-conflict" ? "unattributed edit" : mode === "pause-wrong-baseline" ? "completed pending work from pause" : "partial next-unit WIP");
          } else {
            expect(actual.resumed.status, JSON.stringify(actual.resumed)).toBe("complete");
            expect(actual.baseline).toBe("partial next-unit WIP");
            expect(actual.owned).toBe("completed pending work from pause");
            expect(actual.calls).toContain("invoke-human-1.l1.t3.a1");
            expect(actual.calls).toContain("invoke-human-1.l1.review.director-synthesis");
            expect(actual.calls).toContain("invoke-human-1.l1.compliance");
            expect(loop.cursor).toBe(3);
            expect(loop.results.find((entry: any) => entry.taskId === "second" && entry.status === "complete")).toBeDefined();
            const admitted = actual.snapshots.findIndex((state: any) => state.loops?.[0]?.results?.some((entry: any) => entry.taskId === "second" && entry.status === "complete"));
            const advanced = actual.snapshots.findIndex((state: any) => state.loops?.[0]?.cursor === 2);
            expect(admitted).toBeLessThan(advanced);
            const partial = JSON.parse(JSON.parse(readFileSync(actual.partialRef, "utf8")).data);
            expect(partial.partial[0].image.bytes).toBe(Buffer.from(mode === "pause-write-cut" ? "completed pending work from pause" : "partial next-unit WIP").toString("base64"));
          }
          if (mode === "pause-successor-corrupt") {
            const observations = actual.hostObservations.filter((entry: any) => entry.checkpoint);
            expect(observations).toHaveLength(2);
            expect(observations[1].checkpoint.error).toContain("corrupt successor");
            expect(actual.calls).not.toContain("invoke-human-1.l1.t2.a3");
          }
          if (mode === "pause-reusable-result") {
            expect(actual.calls.filter((key: string) => /\.t2\.a[2-9]/.test(key))).toHaveLength(1);
            expect(loop.results.find((entry: any) => entry.taskId === "second" && entry.status === "complete").attempt).toBe(2);
          }
          return;
        }
        expect(actual.points[0], JSON.stringify(actual)).toBeDefined();
        expect(actual.points[0].point.files[0].image.bytes).toBe(Buffer.from("confirmed first work").toString("base64"));
        expect(actual.points[0].before.files[0].image.bytes).toBe(Buffer.from("previous uncommitted WIP").toString("base64"));
        expect(actual.unrelated).toBe("unrelated WIP");
        expect(actual.retained.association.maxCycles).toBe(3);
        // Failed/unsealed writes remain pending in the same consumed loop.
        // A restoration denied by the native boundary cannot repeat unit work.
        // An unsealed complete report is rejected instead: loop 1 ends as gaps
        // and the next director starts.
        expect(actual.retained.consumedLoops).toBe(mode === "missing-receipt" ? 3 : 1);
        if (mode === "missing-receipt") for (const item of actual.archives.filter((record: any) => record.kind === "loop").map((record: any) => record.body))
          expect(item.results.find((result: any) => result.taskId === "second")).toMatchObject({
            status: "rejected", rejection: "New implementation unit lacks required sealed file/progress checkpoint.",
          });
        if (mode === "missing-receipt") expect(loop).toMatchObject({ outcome: "gaps", results: [{ taskId: "first", status: "complete" },
          { taskId: "second", status: "rejected", rejection: "New implementation unit lacks required sealed file/progress checkpoint." }] });
        expect(actual.result.loopsConsumed).toBe(actual.retained.consumedLoops);
        const confirmed = actual.retained.lastConfirmed;
        const secondConfirmed = ["complete", "pause", "cursor-cut"].includes(mode);
        expect(confirmed.taskId).toBe(secondConfirmed ? "second" : "first");
        expect(confirmed).toMatchObject({ kind: mode === "pause" ? "pause" : "unit", position: { loop: actual.retained.consumedLoops, cursor: mode === "complete" || mode === "cursor-cut" ? 2 : 1 } });
        const point = JSON.parse(JSON.parse(readFileSync(confirmed.checkpointRef, "utf8")).data);
        expect(point.position).toEqual(confirmed.position); expect(point.progress).toEqual(confirmed.progress);
        expect(createHash("sha256").update(readFileSync(confirmed.checkpointRef)).digest("hex")).toBe(confirmed.digest);
        expect(point.progress.consumedLoops).toBe(actual.retained.consumedLoops);
        expect(loop.results.find((entry: any) => entry.taskId === confirmed.taskId).ref).toEqual(confirmed.resultRef);
        expect(point.files[0].image.bytes).toBe(Buffer.from(secondConfirmed ? "partial next-unit WIP" : "confirmed first work").toString("base64"));
        if (secondConfirmed) {
          expect(point.progress.admitted).toEqual({ first: ["complete"] });
          expect(point.progress.previous.resultRef).toEqual(loop.results[0].ref);
        }
        if (mode === "complete") { expect(actual.result.status).toBe("complete"); expect(actual.calls).toContain("invoke-human-1.l1.compliance"); }
        else expect(actual.calls).not.toContain("invoke-human-1.l1.t3.a1");
        if (["refused", "missing", "corrupt", "incomplete"].includes(mode)) {
          expect(actual.sealError).not.toBe(""); expect(actual.points).toHaveLength(1);
        }
        if (["seal-cut", "admission-cut", "missing-receipt", "wrong-progress"].includes(mode)) expect(actual.points).toHaveLength(2);
        if (mode === "cursor-cut") expect(loop.cursor).toBe(1);
        if (mode === "pause") expect(loop.results[1].status).toBe("blocked");
      }
      })();
      // Bun may abandon the returned test promise on timeout. Own its eventual
      // cancellation rejection as well as the child/stream settlement promise.
      void work.catch(() => {});
      return work;
  }
  return { checkpointScenario, releasePreparedPause() { preparedPauseInput = undefined; } };
}
