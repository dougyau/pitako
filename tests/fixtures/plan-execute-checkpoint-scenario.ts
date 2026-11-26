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

import { EXECUTE_CURSOR_KEY, type ExecuteCursor } from "../../extensions/execute-cursor.ts";
import { EXECUTE_STATE_VERSION } from "../../extensions/execute-state.ts";
import { type CheckpointIntent } from "../../extensions/execute-checkpoint.ts";
import { PitakoStore } from "../../extensions/pitako-store.ts";
import { canonicalDigest } from "../../extensions/canonical.mjs";

export function committedCursor(f: { root: string; intent: CheckpointIntent; statePath: string; record?: { lastConfirmed: unknown }; bindingKey?: string }) {
  const store = new PitakoStore(f.root), scope = `exec:${f.intent.association.invocation}.e0`;
  const identity = store.activate(scope);
  let head = store.read(scope).head;
  if (f.record?.lastConfirmed || f.bindingKey) {
    const body = { operation: "baseline", request: { intent: f.intent, continuation: {
      version: EXECUTE_STATE_VERSION, lastConfirmed: f.record?.lastConfirmed ?? null, attempt: { bindingKey: f.bindingKey ?? f.intent.key } } } };
    const saved = store.commit(scope, head, `baseline:${head?.seq ?? 0}`, canonicalDigest(body),
      () => ({ kind: "operation", body }));
    if (saved.outcome !== "appended") throw new Error("Expected committed baseline");
    head = saved.head;
  }
  const committed = store.commit(scope, head, `intent:${head?.seq ?? 0}`, canonicalDigest(f.intent),
    () => ({ kind: "intent", body: f.intent }));
  if (committed.outcome !== "appended" || !committed.head) throw new Error("Expected committed intent");
  const intentRef = { seq: committed.head.seq, digest: committed.head.hash };
  const cursor: ExecuteCursor = {
    version: EXECUTE_STATE_VERSION, storeId: identity.storeId, root: f.root, invocation: f.intent.association.invocation, epoch: 0,
    associationDigest: canonicalDigest(f.intent.association), admissionBinding: "b".repeat(64),
    head: committed.head,
    action: { kind: "launched", key: f.intent.key, runId: "11111111-1111-4111-8111-111111111111",
      role: "worker", input: intentRef, gateTimeoutMs: 1000 },
    loop: { number: f.intent.loop, phase: "implementation", cursor: f.intent.cursor, taskId: f.intent.taskId, outcome: null,
      attempt: { number: f.intent.attempt, stage: "launched", intent: intentRef, revival: null } },
    inFlight: [], halt: null, hostHalt: null,
    timeouts: { reviewerMs: 1000, workerMs: 1000, gateFloorMs: 1000 },
    models: { taskReviewer: "fixture/reviewer", taskSynthesis: "fixture/synthesis",
      r1: "fixture/r1", r2: "fixture/r2", synthesis: "fixture/synthesis" },
    budget: { consumedLoops: 1, maxCycles: f.intent.association.maxCycles, rejectedKeys: [], lastProgress: null },
    backlogDigest: "c".repeat(64), boardTopicId: 1, review: null,
  };
  const persist = () => {
    mkdirSync(path.dirname(f.statePath), { recursive: true });
    writeFileSync(f.statePath, JSON.stringify({ [EXECUTE_CURSOR_KEY]: cursor }));
  };
  persist();
  return { store, scope, cursor, persist };
}

// Shared registered checkpoint lifecycle scenario for the two checkpoint lifecycle
// test files; each file passes its own composition and native process fixtures.
export function checkpointScenarioFixture({ repository, disposers, workflowSettlements }: CompositionFixture, { nativeCheckpointCase }: NativeCheckpointFixture) {
  // Rejects treating an intention, a sealed-but-unadmitted file, or a pause as
  // completed progress. Continuation also rejects pre-unit rollback, dispatch-only
  // "success", answer reuse after a later Stop, lost admission and duplicate writers.
  // These execute registered code and real writer bytes in Node.
  let preparedPauseInput: any;
  let preparedNative: { input: any; harness: string } | undefined;
  function checkpointScenario(mode: string, preparePause = false, prepareNative = false) {
      const work = (async () => {
      let observation: [number, string, string] | undefined;
      if (mode === "abrupt-continue" && preparedNative && !prepareNative) {
        observation = await nativeCheckpointCase(preparedNative.input, preparedNative.harness);
        preparedNative = undefined;
      } else if (["pause-status-continue", "pause-corrupt", "pause-twice"].includes(mode) && !preparePause) {
        expect(preparedPauseInput?.mode).toBe(mode);
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
        writeFileSync(path.join(root, ".pi/settings.json"), JSON.stringify({ pitako: { execute: { maxCycles: 2 } } }));
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
      const input = { mode, root, missionPath, statePath, script: resource.resource.script, preparePause,
        metadata: { inlineLoopIO: true, withTask: true, root, workflowRunId: sessionId, commonDir: path.join(root, ".git"), selected: { source: path.join(root, ".pitako/plans/assignment.md"), digest: digest(content) } },
        module: new URL("../../extensions/execute-checkpoint.ts", import.meta.url).href,
        progressModule: new URL("../../extensions/execute-progress.ts", import.meta.url).href,
        ledgerModule: new URL("../../skills/execute/ledger.mjs", import.meta.url).href,
        toolModule: path.resolve("extensions/checkpoint-create.ts"),
        sealer: path.resolve("skills/execute/checkpoint.mjs"),
        loaderModule: new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url).href,
        evidence: new URL("../../extensions/spec-plans.ts", import.meta.url).href,
        inspectionExecutable: process.execPath, inspectorEntry: path.resolve("skills/execute/inspect.mjs"),
        inspector: new URL("../../skills/execute/inspect.ts", import.meta.url).href,
        validator: import.meta.resolve("@earendil-works/pi-ai") };
      const harness = async (input: any, run: typeof runWorkflowScript, response: typeof childResponse, io: any, loadCheckpoint: typeof registeredCheckpoint) => {
        const { readExecuteAdmission } = await import(input.progressModule);
        const { executeProjection, commitExecute } = await import(input.ledgerModule);
        const storage = new Map<string, any>(), originals = new Map<string, any>(), calls: string[] = [], snapshots: any[] = [], points: any[] = [];
        // Fixture observations use committed originals at the saved head, not a second state key.
        function progress(value = storage.get("pitako-execute")) {
          if (!value) return;
          const { cursor, records, admission } = readExecuteAdmission(input.root, value);
          const projection = executeProjection(records);
          const ledger = records.filter((row: any) => row.kind === "ledger").flatMap((row: any) => row.body.entries);
          archives.splice(0, archives.length, ...ledger);
          const units = ledger.filter((row: any) => row.kind === "unit");
          const operations = records.filter((row: any) => row.kind === "operation").map((row: any) => row.body.request);
          const continuation = projection.prompt.execution?.continuation ??
            projection.prompt.execution?.foldedContinuation ??
            operations.findLast((request: any) => request.continuation)?.continuation;
          const frame = continuation?.taskFrame ?? operations.findLast((request: any) => request.taskFrame)?.taskFrame;
          const tasks: any = {};
          for (const unit of units) {
            const result = unit.body.result;
            const task = tasks[unit.body.taskId] ??= {};
            task.last = result;
            if (result.status === "complete") task.completed = result;
          }
          const results = units.map((unit: any) => unit.body.result);
          const intentRef = cursor.loop?.attempt?.intent;
          const intentRecord = intentRef && records.find((row: any) =>
            row.kind === "intent" && row.seq === intentRef.seq && row.digest === intentRef.digest);
          if (intentRef && !intentRecord) throw Error("Missing cursor-head intent original");
          const attempt = cursor.loop?.attempt && {
            ...(intentRecord && continuation?.attempt?.key === intentRecord.body.key ? continuation.attempt : {}),
            ...cursor.loop.attempt,
            taskId: cursor.loop.taskId, key: intentRecord?.body.key, checkpoint: intentRecord?.body };
          const lastConfirmed = units.at(-1)?.body.checkpoint ?? continuation?.lastConfirmed;
          return { ...cursor, association: admission.association, consumedLoops: cursor.budget.consumedLoops,
            lastConfirmed, tasks, taskFrame: { ...frame, intents: Object.fromEntries(
              records.filter((row: any) => row.kind === "intent").map((row: any) => [row.body.key, row.body])) },
            loop: cursor.loop && { ...cursor.loop, attempt, results,
              plan: continuation?.loop?.plan ?? projection.prompt.execution?.plan,
              manifest: continuation?.loop?.manifest ?? (projection.prompt.selectedTask ? [projection.prompt.selectedTask.id] : []),
              halt: cursor.halt ?? undefined } };
        }
        const hostObservations: any[] = [];
        let recoveryReplay = false;
        let pauseAdmissionCut = false;
        let cut = false, sealError = "", continuing = false, laterContinuing = false, baseline = "", partialRef = "";
        const pauseMode = input.mode.startsWith("pause-");
        const cooperativePause = input.mode.startsWith("pause-status-");
        const lossReentry = input.mode.endsWith("loss-reentry");
        const restorationAdmissions: any[] = [], archives: any[] = [];
        const archivedKeys = new Set<string>();
        const sealedPaths = new Set<string>();
        let secondPause: any;
        const unitMode = input.mode.startsWith("unit-before-capture");
        const candidate = () => { const { head, fingerprint } = io.checkoutEvidence(input.root); return { head, fingerprint }; };
        let gateCandidate: any;
        const state = { get: (key: string) => structuredClone(storage.get(key)), set: (key: string, value: any) => {
          // A crash cannot be repaired by another save in the same root.
          if (cut && ["admission-cut", "cursor-cut"].includes(input.mode))
            throw Error("Checkpoint crash cut remains unavailable");
          let observed: any;
          const observe = () => observed ??= progress(value);
          const admission = ["admission-cut", "cursor-cut"].includes(input.mode) ||
              input.mode.includes("status-") && input.mode.endsWith("admission-cut")
            ? observe().lastConfirmed?.taskId === "second" : false;
          if (!cut && input.mode === "admission-cut" && admission) { cut = true; throw Error("Before checkpoint admission save"); }
          storage.set(key, structuredClone(value)); io.writeFileSync(input.statePath, JSON.stringify(Object.fromEntries(storage))); // Only the admission/cursor ordering projection is observed below;
          // retain full native state in storage/on disk, not in every IPC snapshot.
          // Only advanced positions are asserted; pending saves need no history projection.
          if (value.loop?.cursor === 1) snapshots.push({ loops: [observe().loop].map((loop: any) => ({ number: loop.number, cursor: loop.cursor,
            results: loop.results?.map((entry: any) => ({ taskId: entry.taskId, status: entry.status })) })) });
          if (!pauseAdmissionCut && input.mode.includes("status-") && input.mode.endsWith("admission-cut") && admission) {
            pauseAdmissionCut = true; throw Error("Cut after durable pause admission before yield");
          }
          if (input.mode === "pause-status-continue" && !cut && value.loop?.taskId === "second" &&
              value.loop.attempt?.number === 3 && value.loop.attempt.stage === "launched" && calls.includes(observe().loop.attempt.key)) { cut = true; throw Error("Cut after successor loss"); }
          if (unitMode && input.mode.includes("reentry") && !cut && observe().loop?.attempt?.restore?.undispatched) { cut = true; throw Error("Cut after durable unit recovery intention"); }
          if (!cut && input.mode === "cursor-cut" && admission) {
            cut = true; throw Error("After durable checkpoint admission and cursor save");
          }
        } };
        const options = { script: input.script, state,
          status: async (key: string) => {
            return (originals.get(key)?.structuredOutput?.status === "plan" ||
              (recoveryReplay && input.mode === "pause-reusable-result" && originals.has(key))) ? structuredClone(originals.get(key)) : ({ key, ok: true,
            ...(continuing && !laterContinuing && input.mode === "pause-later-input" ? { stopped: true } : {}),
            state: "unknown",
            output: "No current writer observation", artifactPaths: [] });
          },
          host: async (key: string, request: any) => {
            // Run the granted inspector in this Node: the exact POSIX argument vector
            // must round-trip. Shell quoting and the Node transport are covered by the
            // fallback and settings admission tests, which spawn the real command.
            const argv = [...request.command.matchAll(/'((?:[^']|'\\'')*)'/g)].map(match => match[1].replaceAll("'\\''", "'"));
            if (argv[0] !== input.inspectionExecutable || argv[1] !== input.inspectorEntry ||
                argv.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ") !== request.command)
              throw Error("Unexpected inspection command: " + request.command);
            const stdout = await (await import(input.inspector)).inspect(argv.slice(2));
            const observed = JSON.parse(stdout);
            hostObservations.push({ key, replay: recoveryReplay, checkpoint: observed.checkpointObservation ?? null });
            return { key, kind: "command", state: "passed", ok: true, exitCode: 0,
              stdout, stderr: "", durationMs: 0, outputPath: input.missionPath + ".host.log" };
          },
          launch: async (key: string, request: any) => {
            calls.push(key);
            if (/^pitako\.loop-/.test(request.agent ?? "")) {
              let grouped = JSON.parse(request.task);
              if (grouped.operation === "close" && grouped.refs) {
                const runtime = await import(input.metadata.loopIO);
                const { operation, ...params } = grouped;
                grouped = { operation, ...runtime.resolveStoredGroupedInput(operation, params) };
              }
              input.metadata.groupedHooks = {
                afterEffect: async (step: string) => {
                  if (grouped.operation === "close" && step === `${grouped.key}.seal`) {
                    const kind = grouped.gate.workerStatus === "complete" ? "unit" : "pause";
                    const seal = { ...grouped.seal[kind], kind };
                    await options.launch(`${seal.intent.key}.seal`, { agent: "pitako.checkpoint-sealer", task: JSON.stringify(seal) });
                  }
                },
                afterStep: (step: string) => {
                  if (grouped.operation === "close" && step === `${grouped.key}.gate` &&
                      grouped.gate.checkpoint.taskId === "second" && input.mode === "refused")
                    throw Error(sealError = "Native control refuses checkpoint capture");
                  const intention = grouped.intentions?.find((entry: any) => entry.key === step && entry.operation === "ledger");
                  if (intention && !archivedKeys.has(step)) {
                    archivedKeys.add(step); archives.push(structuredClone(intention.input.record));
                  }
                },
              };
            }
            if (request.agent === "pitako.execution-ledger") archives.push(JSON.parse(request.task).record);
            const workerProgress = request.agent === "pitako.worker" ? progress() : undefined;
            const pending = workerProgress?.loop;
            if (request.agent === "pitako.checkpoint-sealer") {
              const seal = JSON.parse(request.task), second = seal.intent.taskId === "second";
              if (second && input.mode === "refused") { sealError = "Native control refuses checkpoint capture"; throw Error(sealError); }
              const stateBeforeSeal = io.readFileSync(input.statePath, "utf8");
              let observed;
              const cli = input.mode === "complete" && !second && seal.kind !== null;
              try {
                // One unit and its replay cover CLI transport; remaining observations reuse the sealer.
                observed = cli ? JSON.parse(io.execFileSync("node", [input.sealer, "--seal-stdin"], {
                  cwd: input.root, input: request.task, encoding: "utf8",
                })) : io.sealCheckpointRequest(seal);
              } catch (error) { sealError = String(error); throw error; }
              if (io.readFileSync(input.statePath, "utf8") !== stateBeforeSeal) throw Error("Sealer changed admission/cursor state");
              if (observed.outcome === "sealed") {
                const receipt = { kind: observed.kind, checkpointRef: observed.checkpointRef, digest: observed.digest,
                  candidate: observed.candidate, position: observed.position, progress: seal.intent.progress };
                const before = JSON.parse(JSON.parse(io.readFileSync(observed.checkpointRef.replace(/(unit|pause)\.json$/, "manifest.json"), "utf8")).data);
                if (!sealedPaths.has(receipt.checkpointRef)) {
                  sealedPaths.add(receipt.checkpointRef);
                  points.push({ receipt, before, point: JSON.parse(JSON.parse(io.readFileSync(receipt.checkpointRef, "utf8")).data) });
                }
                if (["complete", "pause"].includes(input.mode)) {
                  const replay = cli ? JSON.parse(io.execFileSync("node", [input.sealer, "--seal-stdin"], { cwd: input.root, input: request.task, encoding: "utf8" })) : io.sealCheckpointRequest(seal);
                  if (JSON.stringify(replay) !== JSON.stringify(observed)) throw Error("Non-idempotent root seal replay");
                }
                if (second && input.mode === "seal-cut") throw Error("Abrupt cut after seal before admission");
              }
              const id = io.hash(key);
              const runId = `${id.slice(0,8)}-${id.slice(8,12)}-4${id.slice(13,16)}-8${id.slice(17,20)}-${id.slice(20,32)}`;
              return { key, ok: true, agent: request.agent, runId, asyncDir: `/native/async/${key}`,
                output: JSON.stringify(observed), results: [{ exitCode: 0 }], externalAdapter: {
                  outputArtifacts: { stdoutPath: `/native/async/${key}/stdout.log`, stderrPath: `/native/async/${key}/stderr.log` } } };
            }
            if (request.agent === "pitako.worker" && pending?.attempt?.restore)
              restorationAdmissions.push(structuredClone(pending.attempt));
            // Original lifecycle modes isolate confirmation. Pause-continuation modes
            // execute the actual selective restore and pending effects.
            // The controlled native boundary denies a restoration dispatch, so
            // no extra effects occur after its failed/unsealed second unit.
            if (!unitMode && !pauseMode && input.mode !== "abrupt-continue" && request.task?.includes("CHECKPOINT FALLBACK (same pending task"))
              return { key, ok: false, output: "", artifactPaths: [], error: "Blocked by pi-subagents permission rule: restoration denied in lifecycle fixture" };
            // Grouped operations observe their own checkout; do not duplicate it for every launch.
            if (/^pitako\.loop-/.test(request.agent ?? "") && JSON.parse(request.task).operation === "gate")
              gateCandidate = candidate();
            // Controlled review children write only excluded metadata after the final gate.
            const needsCandidate = key.endsWith(".compliance") || request.agent === "pitako.checkout-observer" ||
              /^pitako\.loop-/.test(request.agent ?? "") && JSON.parse(request.task).operation === "gate";
            if (key.endsWith(".compliance") || /^pitako\.(?:reviewer|review-director|review-angle|task-review|task-synthesis|compliance|demand-observer)$/.test(request.agent ?? ""))
              input.metadata.association = progress().association;
            const result = await response(key, request, input.metadata, needsCandidate ? gateCandidate : undefined);
            if (/^pitako\.loop-/.test(request.agent ?? "") && ["close", "taskDelta"].includes(JSON.parse(request.task).operation) && !result.ok) {
              const failure = JSON.parse(result.output);
              if (input.mode === "corrupt") sealError = failure.reason;
            }
            if (key.endsWith(".director")) {
              const selection = result.structuredOutput;
              if (selection.changes.some((change: any) => change.kind === "add")) {
                const first = selection.changes[0].task;
                first.id = "first";
                const second = structuredClone(first);
                second.id = "second"; second.dependsOn = ["first"];
                if (input.mode === "pause-status-continue") second.metric = {
                  command: `node -e "const value=require('node:fs').readFileSync('owned','utf8'); console.log(value==='completed pending work from pause'?0:value==='journaled pending WIP'?1:2)"`,
                  unit: "remaining owned-file states", target: 0,
                };
                selection.select = "first";
                selection.changes.push({ kind: "add", task: second, reason: "Preserve the next pending unit" });
              }
            } else if (request.agent === "pitako.worker") {
              const invocation = workerProgress, loop = invocation.loop, intent = loop.attempt.checkpoint;
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
                  invocation.taskFrame.intents[key]), restore.authority); }
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
                // Project the helper receipt as instructed, including its confirmed baseline.
                restoreReceipt = { checkpointRef: receipt.checkpointRef, digest: receipt.digest, partialRef: receipt.partialRef,
                  restoredRef: receipt.partialRef.replace(/restore\.json$/, "restored.json"), position: receipt.position,
                  candidate: { head: receipt.candidate.head, fingerprint: receipt.candidate.fingerprint },
                  ...(receipt.confirmedPause ? { confirmedPause: receipt.confirmedPause } : {}),
                  ...(receipt.confirmedUnit ? { confirmedUnit: receipt.confirmedUnit } : {}) };
                if (["pause-wrong-baseline", "unit-before-capture-wrong-baseline"].includes(input.mode)) {
                  const data = JSON.parse(JSON.parse(io.readFileSync(restoreReceipt.restoredRef, "utf8")).data);
                  delete data[input.mode === "pause-wrong-baseline" ? "confirmedPause" : "confirmedUnit"];
                  const bytes = JSON.stringify(data);
                  io.writeFileSync(restoreReceipt.restoredRef, JSON.stringify({ data: bytes, sha256: io.hash(bytes) }));
                }
                if (input.mode === "pause-repeated-publication") throw Error("Disappeared after the same durable restoration publication");
                if (input.mode === "pause-effect-cut" && !cut) { cut = true; throw Error("Cut after actual pause restoration"); }
              }
              if (!(input.mode === "pause-status-continue" && second && intent.attempt === 2))
                await checkpoint("pre", unitMode && !second ? ["owned", "created"] : ["owned"]);
              if (input.mode === "pause-status-continue" && second && [2, 4, 5].includes(intent.attempt)) {
                if (intent.attempt === 5)
                  io.applyCheckpoint(intent, [{ path: "owned", image: { bytes: Buffer.from("journaled pending WIP").toString("base64"), mode: 420 } }]);
                const current = intent.attempt === 5 ? candidate() : restoreReceipt?.candidate ?? intent.baseline;
                Object.assign(result.structuredOutput, { taskId: intent.taskId, attempt: intent.attempt,
                  status: "continue", usefulProgress: true, diagnosis: `Further work ${intent.attempt} requires a fresh capture for another path`,
                  remaining: ["Finish the diagnosed pending work"], continuation: { mode: "fresh", reason: "Complete the newly diagnosed work" },
                  candidate: current, ...(restoreReceipt ? { restoreReceipt } : {}),
                  git: { head: current.head, checkpoints: restoreReceipt ? [restoreReceipt.partialRef, restoreReceipt.restoredRef] : [], wip: "Unchanged pause WIP" },
                  checks: [{ id: "second-check", command: "bun test affected", cwd: input.root,
                    output: "Pending implementation", logPaths: [], result: "not-run", before: current, after: current }] });
                const settled = await response(key, request, input.metadata, undefined, 1, {
                  work: result.structuredOutput.diagnosis, status: "continue",
                  remaining: result.structuredOutput.remaining, continuation: result.structuredOutput.continuation,
                  knowledge: { findings: [], handoff: "Pending work retains its exact pause bytes" },
                });
                originals.set(settled.runId!, structuredClone(settled));
                return settled;
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
              const paused = second && (input.mode === "pause" || pauseMode) && (!continuing || input.mode === "pause-twice" && intent.attempt === 2);
              Object.assign(result.structuredOutput, { taskId: intent.taskId, attempt: intent.attempt,
                status: paused ? (input.mode.includes("status-continue") ? "continue" : input.mode.includes("status-gaps") ? "gaps" : "blocked") : "complete", remaining: paused && input.mode !== "pause-empty" ? ["Pending second unit"] : [],
                continuation: { mode: "fresh", reason: paused ? "Resume pending second unit from its exact pause" : "Unit complete" },
                git: { wip: "Real owned WIP" } });
              if (second && input.mode === "missing-receipt") delete result.structuredOutput.checkpointReceipt;
              if (second && input.mode === "wrong-progress") result.structuredOutput.checkpointReceipt = {
                progress: { consumedLoops: 2 } };
            }
            if (request.agent === "pitako.worker") {
              const value = result.structuredOutput;
              result.structuredOutput = { work: value.diagnosis ?? "Owned checkpoint effects applied", status: value.status,
                remaining: value.remaining, ...(value.continuation ? { continuation: value.continuation } : {}),
                knowledge: { findings: [], handoff: "Owned file reflects this settled attempt" } };
            }
            if (request.agent === "pitako.worker")
              (await import(input.validator)).validateToolArguments({ name: "worker_result", description: "Result", parameters: request.outputSchema },
                { type: "toolCall", id: "worker", name: "worker_result", arguments: result.structuredOutput });
            if (request.agent === "pitako.worker")
              Object.assign(result, await response(key, request, input.metadata, undefined, 1, result.structuredOutput));
            originals.set(result.runId!, structuredClone(result));
            if (input.mode === "pause-reusable-result" && continuing && key.endsWith(".l2.t1.a2")) {
              originals.set(key, structuredClone(result));
              throw Error("Transport disappeared after the complete result survived");
            }
            return result;
          },
        };
        const launch = options.launch, launchErrors: string[] = [];
        const admissions = new Map<string, { params: string; result?: any; error?: unknown }>();
        options.launch = async (key, request) => {
          // Native runs reuse the exact key and parameters across root reentries.
          const params = JSON.stringify(request), prior = admissions.get(key);
          if (prior) {
            if (prior.params !== params) throw Error(`Conflicting native reuse parameters: ${key}`);
            if (prior.error) throw prior.error;
            return structuredClone(prior.result);
          }
          try {
            const result = await launch(key, request);
            if (result.runId) admissions.set(key, { params, result: structuredClone(result) });
            return result;
          }
          catch (error) {
            // Publication is native admission even when the first reply is lost.
            const mission = io.existsSync(input.missionPath) && JSON.parse(io.readFileSync(input.missionPath, "utf8"));
            if (mission?.workflowChildren?.some((child: any) => child.key === key && child.agent === request.agent))
              admissions.set(key, { params, error });
            launchErrors.push(`${key}: ${String(error)} ${JSON.stringify({ intent: progress()?.loop?.attempt?.checkpoint, cursor: storage.get("pitako-execute") })}`); throw error;
          }
        };
        const result = await run(options as any);
        const original = progress();
        const originalArchives = structuredClone(archives);
        const callsAtYield = [...calls];
        let unitReplay: any;
        if (unitMode && input.mode.includes("reentry")) {
          if (input.mode.endsWith("reentry-mismatched-previous")) {
            const retained = progress();
            const intent = structuredClone(retained.loop.attempt.checkpoint);
            intent.progress.previous.digest = "0".repeat(64);
            const { canonicalDigest } = await import(new URL("../../extensions/canonical.mjs", input.ledgerModule).href);
            const saved = commitExecute(input.root, retained.invocation, "fixture:mismatched-previous",
              canonicalDigest(intent), "intent", intent);
            const cursor = storage.get("pitako-execute");
            cursor.head = saved.head;
            cursor.loop.attempt.intent = { seq: saved.head.seq, digest: saved.head.hash };
            io.writeFileSync(input.statePath, JSON.stringify(Object.fromEntries(storage)));
          }
          recoveryReplay = true; unitReplay = await run(options as any);
        }
        let noInputReplay: any;
        const finish = async () => {
        if (input.mode.includes("status-")) {
          recoveryReplay = true;
          const replayed = await run(options as any);
          noInputReplay = { result: replayed.value, calls: [...calls], cursor: storage.get("pitako-execute").loop.cursor };
        }
        if (input.mode === "pause-status-continue") {
          const again = await run(options as any);
          noInputReplay = { ...noInputReplay, again: again.value };
        }
        let resumed: any;
        const collect = () => ({ launchErrors, archives, originalArchives, secondPause, restorationAdmissions, unitReplay: unitReplay?.value, created: unitMode ? io.readFileSync(input.root + "/created", "utf8") : null, noInputReplay, callsAtYield, hostObservations, resumed: resumed?.value, original, baseline, partialRef, result: result.value, retained: progress(), calls, snapshots, points, sealError,
          owned: io.readFileSync(input.root + "/owned", "utf8"), unrelated: io.readFileSync(input.root + "/unrelated", "utf8") });
        return collect();
        };
        if (input.preparePause) {
          (globalThis as any).finishPreparedPause = finish;
          return { prepared: true };
        }
        return finish();
      };
      if (prepareNative) {
        preparedNative = { input, harness: harness.toString() };
        const loaded = await nativeCheckpointCase(input, `async (input, _run, _response, io) => {
          const loaded = await io.loadExtensions([input.toolModule], input.root);
          if (loaded.errors.length) throw Error(JSON.stringify(loaded.errors));
          return "prepared";
        }`);
        expect(loaded?.[0], loaded?.[2]).toBe(0);
        return;
      }
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
        const actual = JSON.parse(output); expect(actual.retained?.loop, JSON.stringify(actual)).toBeDefined();
        // Each implementation unit now has its own loop; final verification has no worker.
        const loop = actual.retained.loop.number === 3
          ? actual.archives.find((record: any) => record.kind === "loop" && record.loop === 2).body
          : actual.retained.loop;
        const history = (records: any[], retained: any[], tasks: any) => [...new Map(
          // A unit record's own attempt is `result`; earlier sealed attempts are cited by their records.
          [...retained.flatMap(entry => entry.ref ? [entry] :
            [tasks[entry.taskId].completed, tasks[entry.taskId].last].filter(result => result?.attempt === entry.attempt)),
            ...records.flatMap(record => [...(record.body.results ?? []).filter((result: any) => !result.sealed),
            ...(record.kind === "unit" ? [record.body.result] : [])])]
            .map(result => [`${result.taskId}:${result.attempt}`, result])).values()]
          .sort((a: any, b: any) => ["first", "second", "final"].indexOf(a.taskId) - ["first", "second", "final"].indexOf(b.taskId) || a.attempt - b.attempt);
        loop.results = history(actual.archives, loop.results, actual.retained.tasks);
        if (actual.secondPause) actual.secondPause.retained.loop.results =
          history(actual.secondPause.archives, actual.secondPause.retained.loop.results, actual.secondPause.retained.tasks);
        if (mode.startsWith("unit-before-capture")) {
          const success = !["conflict", "corrupt", "missing", "unadmitted", "wrong-baseline", "mismatched-previous"].some(suffix => mode.endsWith(suffix));
          expect((actual.unitReplay ?? actual.result).status, JSON.stringify(actual)).toBe(success ? "complete" : "blocked");
          expect(loop.results.filter((r: any) => r.taskId === "first" && r.status === "complete")).toHaveLength(1);
          expect(actual.created).toBe("created by confirmed unit");
          expect(actual.unrelated).toBe("unrelated WIP");
          expect(actual.retained.consumedLoops).toBe(success ? 3 : 2);
          expect(actual.retained.association.maxCycles).toBe(3);
          expect(actual.calls.filter((key: string) => key.endsWith(".l1.t1.a1"))).toHaveLength(1);
          if (success) {
            expect(actual.baseline).toBe("confirmed first work");
            expect(actual.owned).toBe("completed pending work from pause");
            const receipt = loop.results.find((r: any) => r.taskId === "second").restore.receipt;
            expect(receipt.position).toEqual({loop: 2, cursor: 0, phase: "implementation"});
            expect(receipt.confirmedUnit).toEqual({checkpointRef: actual.points[0].receipt.checkpointRef, digest: actual.points[0].receipt.digest});
            expect(receipt.checkpointRef).toBe(actual.points[0].receipt.checkpointRef.replace(/unit.json$/, "manifest.json"));
            expect(loop.cursor).toBe(1);
            for (const suffix of [".l2.t1.a1", ".l2.t1.a2", ".l3.acceptance.gate", ".compliance"])
              expect(actual.calls.filter((key: string) => key.endsWith(suffix))).toHaveLength(1);
            expect(actual.points).toHaveLength(2);
            expect(loop.results[0].checkpoint.confirmation).toEqual(actual.points[0].receipt);
            expect(existsSync(actual.points[0].receipt.checkpointRef.replace(/l1\.t1\.a1\/unit\.json$/, "l2.t1.a1/manifest.json"))).toBe(false);
            const partial = JSON.parse(JSON.parse(readFileSync(receipt.partialRef, "utf8")).data);
            expect(Buffer.from(partial.partial[0].image.bytes, "base64").toString()).toBe("confirmed first work");
            if (mode.endsWith("reentry")) expect(actual.hostObservations.some((o: any) => o.replay && o.checkpoint?.evidence), JSON.stringify(actual.hostObservations)).toBe(true);
          } else {
            if (mode.endsWith("reentry-mismatched-previous")) {
              expect(actual.unitReplay.reason).toContain("Committed baseline intent integrity mismatch");
              expect(actual.calls).not.toContain("invoke-human-1.l2.t1.a3");
            }
            expect(loop.cursor).toBe(0);
            expect(actual.calls).not.toContain("invoke-human-1.l3.acceptance.gate");
            expect(actual.owned).toBe(mode.endsWith("conflict") ? "unattributed edit" : mode.endsWith("wrong-baseline") ? "completed pending work from pause" : "confirmed first work");
          }
          return;
        }
        if (mode === "abrupt-continue") {
          expect(actual.result).toMatchObject({ status: "complete", loopsConsumed: 3 });
          expect(actual.baseline).toBe("confirmed first work");
          expect(actual.owned).toBe("completed pending work from pause");
          expect(actual.unrelated).toBe("unrelated WIP");
          const partial = JSON.parse(JSON.parse(readFileSync(actual.partialRef, "utf8")).data);
          expect(Buffer.from(partial.partial[0].image.bytes, "base64").toString()).toBe("partial next-unit WIP");
          expect(loop.results.filter((entry: any) => entry.taskId === "first" && entry.status === "complete")).toHaveLength(1);
          expect(loop.results.find((entry: any) => entry.taskId === "second")).toMatchObject({ status: "complete", attempt: 2 });
          expect(loop.cursor).toBe(1);
          expect(actual.retained.lastConfirmed).toMatchObject({ taskId: "second", attempt: 2 });
          for (const suffix of [".l1.t1.a1", ".l2.t1.a1", ".l2.t1.a2", ".l3.acceptance.gate", ".review.director-synthesis", ".compliance"])
            expect(actual.calls.filter((key: string) => key.endsWith(suffix))).toHaveLength(1);
          expect(actual.points).toHaveLength(2); // No post-cut seal for the interrupted attempt.
          return;
        }
        if (mode.startsWith("pause-")) {
          const originalLoop = actual.original.loop;
          originalLoop.results = history(actual.originalArchives, originalLoop.results, actual.original.tasks);
          if (mode.startsWith("pause-status-")) {
            const finalBudget = mode.includes("status-continue");
            expect(originalLoop.results[1], JSON.stringify({ reason: actual.result.reason, errors: actual.launchErrors })).toBeDefined();
            const paused = originalLoop.results[1], pause = paused.checkpoint.confirmation;
            expect(paused.status).toBe("continue");
            expect(pause).toMatchObject({ kind: "pause", position: { loop: 2, cursor: 0 } });
            expect(createHash("sha256").update(readFileSync(pause.checkpointRef)).digest("hex")).toBe(pause.digest);
            if (mode.endsWith("admission-cut") || mode === "pause-status-continue") expect(actual.result.status).not.toBe("complete");
            else expect(actual.result.status).toBe(finalBudget ? "complete" : "partial");
            if (mode === "pause-status-continue") {
              expect(actual.noInputReplay.result.reason).toContain("no new checkpoint evidence");
              expect(actual.noInputReplay.calls.some((key: string) => key.endsWith(".l2.t1.a7"))).toBe(false);
              expect(actual.noInputReplay.again.status, JSON.stringify(actual.noInputReplay.again)).toBe("complete");
            } else expect(actual.noInputReplay.result.status, JSON.stringify(actual.noInputReplay.result)).toBe(finalBudget ? "complete" : "partial");
            expect(actual.retained.association).toEqual(actual.original.association);
            expect(actual.retained.consumedLoops).toBe(finalBudget ? 3 : 2);
            expect(loop.halt).toBeUndefined();
            expect(loop.results[1]).toEqual(paused);
            expect(actual.unrelated).toBe("unrelated WIP");
            if (mode === "pause-status-continue") {
              expect(actual.restorationAdmissions).toHaveLength(2);
              expect(actual.restorationAdmissions[0].restore.authority.confirmedPause).toEqual(pause);
              expect(loop.results[3].restore.receipt.confirmedPause).toEqual({ checkpointRef: pause.checkpointRef, digest: pause.digest });
              expect(actual.restorationAdmissions[1].restore.sourceKeys).toEqual([
                "invoke-human-1.l2.t1.a6", "invoke-human-1.l2.t1.a5", "invoke-human-1.l2.t1.a4",
                "invoke-human-1.l2.t1.a3", "invoke-human-1.l2.t1.a2", "invoke-human-1.l2.t1.a1",
              ]);
              // The root pause-sealed a5's journaled pending work: that newer
              // confirmed pause, not a1's, is the second restoration baseline.
              const later = actual.restorationAdmissions[1].restore.authority.confirmedPause;
              expect(later).toMatchObject({ kind: "pause", position: { loop: 2, cursor: 0, phase: "implementation" },
                progress: { admitted: { second: ["continue"] } } });
              expect(later.checkpointRef).toEndWith(".l2.t1.a5/pause.json");
              expect(createHash("sha256").update(readFileSync(later.checkpointRef)).digest("hex")).toBe(later.digest);
              expect(actual.archives.filter((record: any) => record.kind === "unit" && record.loop === 2).at(-1).body.frame.operations.map((item: any) => Number(item.key.match(/a(\d+)$/)[1]))).toEqual([4, 7]);
              expect(actual.restorationAdmissions[1].restore.evidence).toBeTruthy();
              expect(actual.restorationAdmissions[1].restore.evidence).not.toBe(actual.restorationAdmissions[0].restore.evidence);
              expect(loop.results[5].restore.receipt.checkpointRef).toEndWith(".l2.t1.a5/manifest.json");
              const partial = JSON.parse(JSON.parse(readFileSync(loop.results[5].restore.receipt.partialRef, "utf8")).data);
              expect(Buffer.from(partial.partial[0].image.bytes, "base64").toString()).toBe("journaled pending WIP");
              expect(actual.hostObservations.some((o: any) => o.replay && o.checkpoint?.evidence)).toBe(true);
              expect(loop.results[2]).toMatchObject({ attempt: 2, status: "continue", usefulContinuation: true });
              expect(loop.results[2].checkpoint.confirmation).toBeUndefined();
              expect(existsSync(pause.checkpointRef.replace(/a1\/pause\.json$/, "a2/manifest.json"))).toBe(false);
              expect(existsSync(pause.checkpointRef.replace(/a1\/pause\.json$/, "a3/manifest.json"))).toBe(false);
              expect(actual.calls.filter((key: string) => key.endsWith(".l2.t1.a3"))).toHaveLength(1);
              expect(actual.calls.filter((key: string) => key.endsWith(".l2.t1.a4"))).toHaveLength(1);
            } else expect(actual.restorationAdmissions).toEqual([]);
            expect(actual.calls.filter((key: string) => key.endsWith(".director"))).toHaveLength(finalBudget ? 3 : 2);
            expect(actual.calls.filter((key: string) => key.endsWith(".l1.t1.a1"))).toHaveLength(1);
            expect(actual.calls.filter((key: string) => key.endsWith(".l2.t1.a1"))).toHaveLength(1);
            if (finalBudget) {
              expect(loop.cursor).toBe(1);
              expect(loop.results.map((r: any) => r.status)).toEqual(mode === "pause-status-continue"
                ? ["complete", "continue", "continue", "continue", "continue", "complete"]
                : ["complete", "continue", "complete"]);
              expect(actual.retained.association.maxCycles).toBe(3);
              expect(actual.baseline).toBe(mode === "pause-status-continue" ? "journaled pending WIP" : "partial next-unit WIP");
              expect(actual.owned).toBe("completed pending work from pause");
              expect(actual.calls.filter((key: string) => key.endsWith(".l2.t1.a2"))).toHaveLength(1);
              expect(actual.calls.filter((key: string) => key.endsWith(".review.director-synthesis"))).toHaveLength(1);
              expect(actual.calls.filter((key: string) => key.endsWith(".compliance"))).toHaveLength(1);
            } else {
              expect(loop.cursor).toBe(1);
              expect(loop.results.map((r: any) => r.status)).toEqual(["complete", "continue", "complete"]);
              expect(actual.retained.association.maxCycles).toBe(2);
              expect(actual.owned).toBe("completed pending work from pause");
              expect(actual.calls.filter((key: string) => key.endsWith(".l2.t1.a2"))).toHaveLength(1);
              expect(actual.calls.some((key: string) => key.endsWith(".compliance"))).toBe(false);
            }
            return;
          }
          if (mode === "pause-twice") {
            const paused = actual.secondPause.retained.loop;
            expect(actual.secondPause.result.status).toBe("blocked");
            expect(paused.cursor).toBe(0);
            expect(paused.results.map((r: any) => r.status)).toEqual(["complete", "blocked", "blocked"]);
            expect(actual.secondPause.retained.lastConfirmed).toMatchObject(paused.results[2].checkpoint.confirmation);
            expect(actual.secondPause.calls).not.toContain("invoke-human-1.l3.acceptance.gate");
            expect(actual.resumed.status, JSON.stringify(actual.resumed)).toBe("complete");
            expect(loop.cursor).toBe(1);
            expect(loop.results.slice(0, 3)).toEqual(paused.results);
            expect(actual.retained.association).toEqual(actual.original.association);
            expect(actual.retained.consumedLoops).toBe(3);
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
            expect(actual.calls.filter((key: string) => /\.l2\.t1\.a[2-9]$/.test(key))).toHaveLength(2);
            expect(actual.calls).toContain("invoke-human-1.l3.acceptance.gate");
            expect(actual.calls).toContain("invoke-human-1.l3.compliance");
            return;
          }
          expect(actual.retained.association).toEqual(actual.original.association);
          expect(actual.retained.consumedLoops, JSON.stringify({reason: actual.resumed?.reason, calls: actual.calls, launchErrors: actual.launchErrors})).toBe([
            "pause-missing", "pause-corrupt", "pause-conflict", "pause-empty", "pause-wrong-baseline",
            "pause-successor-corrupt", "pause-loss-reentry", "pause-equivalent-capture", "pause-repeated-publication",
          ].includes(mode) ? 2 : 3);
          expect(loop.results[0]).toEqual(originalLoop.results[0]);
          expect(loop.results[1]).toEqual(originalLoop.results[1]);
          expect(actual.unrelated).toBe("unrelated WIP");
          expect(actual.calls.filter((key: string) => key.endsWith(".l1.t1.a1"))).toHaveLength(1);
          expect(actual.calls.filter((key: string) => key.endsWith(".l2.t1.a1"))).toHaveLength(1);
          expect(new Set(actual.calls).size, JSON.stringify(actual.calls.filter((key: string, index: number) => actual.calls.indexOf(key) !== index))).toBe(actual.calls.length);
          expect(actual.calls.filter((key: string) => key.includes(".recover"))).toEqual(
            mode === "pause-reusable-result" ? ["invoke-human-1.l2.t1.a2.recover.r1"] : []);
          expect(actual.resumed.loopsConsumed).toBe(actual.retained.consumedLoops);
          expect(loop.plan.ref).toEqual(originalLoop.plan.ref);
          expect(loop.manifest).toEqual(originalLoop.manifest);
          // Rejects per-process bounds, equivalent-capture renewal and treating
          // repeated idempotent restoration publication as fresh material progress.
          if (mode.endsWith("loss-reentry") || ["pause-equivalent-capture", "pause-repeated-publication"].includes(mode)) {
            expect(actual.resumed.status).not.toBe("complete");
            expect(actual.calls.filter((key: string) => /\.l2\.t1\.a[2-9]$/.test(key)),
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
              expect(loop.cursor).toBe(0);
              expect(loop.results).toEqual(originalLoop.results);
              expect(actual.retained.lastConfirmed).toEqual(actual.original.lastConfirmed);
              expect(actual.retained.taskFrame.operations).toHaveLength(1);
              expect(actual.retained.tasks.second.last).toEqual(originalLoop.results[1]);
              expect(actual.retained.association.maxCycles).toBe(3);
            }
            expect(actual.resumed.action.started).toBe(false);
            const replayed = observed.find((entry: any) => entry.replay);
            expect(replayed.checkpoint.attempt).toBe(2);
            expect(replayed.replay).toBe(true);
            expect(actual.resumed.reason).toContain("no new checkpoint evidence");
            expect(actual.owned).toBe("partial next-unit WIP");
            expect(actual.calls).not.toContain("invoke-human-1.l3.acceptance.gate");
            return;
          }
          const blocked = ["pause-missing", "pause-corrupt", "pause-conflict", "pause-empty", "pause-wrong-baseline", "pause-successor-corrupt"].includes(mode);
          if (blocked) {
            if (mode === "pause-empty") {
              expect(actual.original.lastConfirmed).toMatchObject({ taskId: "second", kind: "pause" });
              expect(originalLoop.results[1]).toMatchObject({ status: "blocked", remainingCount: 0 });
              expect(originalLoop.results[1].checkpoint.confirmation).toBeDefined();
            }
            expect(actual.resumed.status, JSON.stringify(actual.resumed)).not.toBe("complete");
            expect(actual.calls).not.toContain("invoke-human-1.l3.acceptance.gate");
            if (mode === "pause-empty")
              expect(actual.calls).not.toContain("invoke-human-1.l2.t1.a2");
            expect(actual.owned).toBe(mode === "pause-conflict" ? "unattributed edit" : mode === "pause-wrong-baseline" ? "completed pending work from pause" : "partial next-unit WIP");
          } else {
            expect(actual.resumed.status, JSON.stringify(actual.resumed)).toBe("complete");
            expect(actual.baseline).toBe("partial next-unit WIP");
            expect(actual.owned).toBe("completed pending work from pause");
            expect(actual.calls).toContain("invoke-human-1.l3.acceptance.gate");
            expect(actual.calls).toContain("invoke-human-1.l3.review.director-synthesis");
            expect(actual.calls).toContain("invoke-human-1.l3.compliance");
            expect(loop.cursor).toBe(1);
            expect(loop.results.find((entry: any) => entry.taskId === "second" && entry.status === "complete")).toBeDefined();
            const advanced = actual.snapshots.flatMap((state: any) => state.loops ?? [])
              .filter((loop: any) => loop.number === 2 && loop.cursor === 1);
            expect(advanced.length).toBeGreaterThan(0);
            for (const position of advanced)
              expect(position.results.some((entry: any) => entry.taskId === "second" && entry.status === "complete")).toBe(true);
            const partial = JSON.parse(JSON.parse(readFileSync(actual.partialRef, "utf8")).data);
            expect(partial.partial[0].image.bytes).toBe(Buffer.from(mode === "pause-write-cut" ? "completed pending work from pause" : "partial next-unit WIP").toString("base64"));
          }
          if (mode === "pause-successor-corrupt") {
            const observations = actual.hostObservations.filter((entry: any) => entry.checkpoint);
            expect(observations).toHaveLength(2);
            expect(observations[1].checkpoint.error).toContain("corrupt");
            expect(actual.calls).not.toContain("invoke-human-1.l2.t1.a3");
          }
          if (mode === "pause-reusable-result") {
            expect(actual.calls.filter((key: string) => /\.l2\.t1\.a[2-9]$/.test(key))).toHaveLength(1);
            expect(loop.results.find((entry: any) => entry.taskId === "second" && entry.status === "complete").attempt).toBe(2);
          }
          return;
        }
        expect(actual.points[0], JSON.stringify(actual)).toBeDefined();
        expect(actual.points[0].point.files[0].image.bytes).toBe(Buffer.from("confirmed first work").toString("base64"));
        expect(actual.points[0].before.files[0].image.bytes).toBe(Buffer.from("previous uncommitted WIP").toString("base64"));
        expect(actual.unrelated).toBe("unrelated WIP");
        expect(actual.retained.association.maxCycles).toBe(3);
        const complete = ["complete", "missing-receipt", "wrong-progress"].includes(mode);
        // Failed/unsealed writes remain pending in the same consumed loop.
        // A restoration denied by the native boundary cannot repeat unit work.
        // A missing second-task capture cannot inherit completion from the first loop.
        expect(actual.retained.consumedLoops, JSON.stringify({ result: actual.result, launchErrors: actual.launchErrors })).toBe(complete ? 3 : 2);
        if (mode === "missing") {
          expect(actual.result.status).toBe("blocked");
          expect(loop.halt).toBeDefined();
          expect(loop.results.some((result: any) => result.taskId === "second")).toBe(false);
          expect(actual.calls).not.toContain("invoke-human-1.l3.acceptance.gate");
        }
        expect(actual.result.loopsConsumed).toBe(actual.retained.consumedLoops);
        const confirmed = actual.retained.lastConfirmed;
        const secondConfirmed = complete || ["pause", "cursor-cut"].includes(mode);
        expect(confirmed.taskId).toBe(secondConfirmed ? "second" : "first");
        expect(confirmed).toMatchObject({ kind: mode === "pause" ? "pause" : "unit", position: { loop: secondConfirmed ? 2 : 1, cursor: mode === "pause" ? 0 : 1 } });
        const point = JSON.parse(JSON.parse(readFileSync(confirmed.checkpointRef, "utf8")).data);
        expect(point.position).toEqual(confirmed.position); expect(point.progress).toEqual(confirmed.progress);
        expect(createHash("sha256").update(readFileSync(confirmed.checkpointRef)).digest("hex")).toBe(confirmed.digest);
        expect(point.progress.consumedLoops).toBe(secondConfirmed ? 2 : 1);
        expect(loop.results.find((entry: any) => entry.taskId === confirmed.taskId).ref).toEqual(confirmed.resultRef);
        expect(point.files[0].image.bytes).toBe(Buffer.from(secondConfirmed ? "partial next-unit WIP" : "confirmed first work").toString("base64"));
        if (secondConfirmed) {
          expect(point.progress.admitted).toEqual({});
          expect(point.progress.previous.resultRef).toEqual(loop.results[0].ref);
        }
        if (complete) { expect(actual.result.status, actual.result.reason).toBe("complete"); expect(actual.calls).toContain("invoke-human-1.l3.compliance"); }
        else expect(actual.calls).not.toContain("invoke-human-1.l3.acceptance.gate");
        if (["refused", "corrupt"].includes(mode)) {
          expect(actual.sealError).not.toBe(""); expect(actual.points).toHaveLength(1);
        }
        if (mode === "incomplete") {
          expect(loop.halt).toMatchObject({ stage: "checkpoint-integrity", digest: expect.any(String) });
          expect(actual.result.loopReport.halt).toMatchObject({ code: "checkpoint-integrity",
            ref: { agent: "pitako.checkpoint-sealer", key: "invoke-human-1.l2.t1.a1.seal" } });
          expect(actual.result.loopReport.halt.reason).toContain("last step partially applied: true");
          expect(loop.results.some((entry: any) => entry.taskId === "second")).toBe(false);
          expect(actual.points).toHaveLength(1);
        }
        if (["seal-cut", "admission-cut", "missing-receipt", "wrong-progress"].includes(mode)) expect(actual.points).toHaveLength(2);
        // The workflow publishes the admitted head and next cursor together in one save.
        if (mode === "cursor-cut") expect(loop.cursor).toBe(1);
        if (mode === "pause") expect(loop.results[1].status).toBe("blocked");
      }
      })();
      // Bun may abandon the returned test promise on timeout. Own its eventual
      // cancellation rejection as well as the child/stream settlement promise.
      // Own the assertion consumer as well as the native IPC operation.
      workflowSettlements.push(work.then(() => {}, () => {}));
      return work;
  }
  return { checkpointScenario, releasePreparedPause() { preparedPauseInput = undefined; } };
}
