import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { resolveWorkflowResource } from "../node_modules/pi-subagents/src/workflows/workflow-resources.js";
import { consumeWorkflowResourcePermit } from "../node_modules/pi-subagents/src/shared/workflow-child-permit.js";
import { runWorkflowScript } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { executionResource } from "../extensions/plan-execute.ts";
import { digest, preliminarySpec, SPEC_SECTIONS, checkoutEvidence, MAX_SPEC_BYTES } from "../extensions/spec-plans.ts";
import { planExecute, checkout, missionFiles, childResponse, registeredCheckpoint, compositionFixture, nativeCheckpointFixture, assignmentSpec, resourceWithAgentDir } from "./fixtures/plan-execute-composition.ts";
import { prepare, apply, readBacklog, updateProgress, reviewOriginals } from "../skills/execute/loop.ts";
import { captureBaseline, captureCheckpoint, restoreCheckpoint } from "../extensions/execute-checkpoint.ts";

const composition = compositionFixture();
const deterministicScripts = composition.scripts;
const { disposers, workflowSettlements, repository, checkpointLifecycle } = composition;
const native = nativeCheckpointFixture(composition);
const { startNativeCheckpoint, nativeCheckpointCase } = native;

describe("plan/execute packaged composition", () => {
  // SDK/Node loader preparation is file-owned setup, not checkpoint-case work.
  beforeAll(async () => { if (!native.nativeCheckpoint) await startNativeCheckpoint(); });

  // Wrong implementations rejected: prompt-only rollback, ignoring current writer
  // barriers, discarding a prior source on dispatch cuts, or restoring a foreign unit.
  test.each(["restored", "missing", "incomplete", "foreign", "conflict", "stop", "permission", "active", "unsettled", "unknown", "unavailable", "inconclusive", "current-stop", "observer-permission", "observer-capacity", "later-stop-input", "intention-cut", "result-cut", "missing-receipt", "stale-producer", "dispatch-intention-cut", "successor-capture-cut", "corrupt-successor", "retained-stop", "retained-permission", "retained-permission-input", "retained-permission-accepted-cut", "retained-stop-input", "retained-stop-input-applied-cut", "retained-unknown", "retained-stop-new-stop", "retained-stop-new-permission", "retained-stop-observer-permission", "retained-stop-observer-permission-accepted-cut", "retained-stop-observer-permission-observed-cut"].map(mode => [mode.startsWith("retained-") ? "retained barrier replay" : "checkpoint fallback actually restores the pending unit", mode]))(
    "bound admission recovery %s: %s", async (_label, mode) => {
      const root = repository(), nativeRoot = repository(), sessionId = randomUUID();
      const { missionPath, statePath } = missionFiles(nativeRoot);
      const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
      mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
      writeFileSync(path.join(root, ".pitako/plans/assignment.md"), content);
      writeFileSync(path.join(root, "owned"), "prior owned WIP");
      writeFileSync(path.join(root, "earlier"), "earlier independent WIP");
      const hooks = new Map<string, any>();
      planExecute({ on: (name: string, hook: any) => hooks.set(name, hook) } as unknown as ExtensionAPI);
      const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
      const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = path.join(nativeRoot, "private-agent");
      try { hooks.get("session_start")({}, ctx); }
      finally { if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir; }
      disposers.push(() => hooks.get("session_shutdown")({}, ctx));
      const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath };
      expect(hooks.get("tool_call")({ toolName: "subagent", input: { workflow: "pitako.execute", cwd: root, args, options: { missionId: args.missionId } } }, ctx)).toBeUndefined();
      const resource = resolveWorkflowResource("pitako.execute", args, sessionId);
      if (!resource.ok) throw Error(resource.error);
      const permit = consumeWorkflowResourcePermit(resource.resource.permit, resource.resource.script);
      if (typeof permit === "string") throw Error(permit);
      const metadata = { ...deterministicScripts, root, commonDir: path.join(root, ".git"), selected: { source: path.join(root, ".pitako/plans/assignment.md"), digest: digest(content) } };
      const script = resource.resource.script;
      const input = { mode, root, nativeRoot, missionPath, statePath, metadata, script,
        loopLoader: new URL("../skills/execute/loader.mjs", import.meta.url).href,
        loopModule: new URL("../skills/execute/loop.ts", import.meta.url).href,
        toolModule: path.resolve("extensions/checkpoint-create.ts"),
        loaderModule: new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url).href,
        grants: permit.authority.host, checkpointModule: new URL("../extensions/execute-checkpoint.ts", import.meta.url).href, evidenceModule: new URL("../extensions/spec-plans.ts", import.meta.url).href };
      const harness = async (input: any, run: typeof runWorkflowScript, response: typeof childResponse, io: any, loadCheckpoint: typeof registeredCheckpoint) => {
        if (!process.versions.bun) await import(input.loopLoader);
        const loopIo = await import(input.loopModule);
        const directors = new Map<string, any>();
        const legacyResponse = response;
        response = ((key: string, request: any, metadata: any, checkout: any) => {
          return legacyResponse(key, request, metadata, checkout, 1, request.agent === "pitako.worker"
            ? { status: "complete", work: "Restored and completed owned unit", remaining: [], knowledge: { findings: [], handoff: "Owned unit is complete" } } : undefined);
        }) as typeof response;
        const storage = new Map<string, any>(), calls: string[] = [], observations: any[] = [], witnesses: any[] = [];
        let interrupted: any, cut = false, restores = 0, beforeRestore = "", originalManifest = "";
        const retainedMode = input.mode.startsWith("retained-");
        const statusCalls: string[] = [];
        const restoreAuthorities: any[] = [], archives: any[] = [];
        const file = (name: string) => input.root + "/" + name;
        const candidate = () => { const { head, fingerprint } = io.checkoutEvidence(input.root); return { head, fingerprint }; };
        // Load owned functions once in this private Node process. Repeated loader
        // processes add no boundary coverage; registered host inspections stay real.
        const helper = (operation: string, request: any) => JSON.stringify(
          operation === "restore" ? io.restoreCheckpoint(request.intent, request.authority) :
          io.applyCheckpoint(request.intent, request.changes) ?? null);
        const options = { script: input.script,
          state: { get: (key: string) => structuredClone(storage.get(key)), set: (key: string, value: any) => {
            storage.set(key, structuredClone(value));
            io.writeFileSync(input.statePath, JSON.stringify(Object.fromEntries(storage)));
            if (!cut && (["intention-cut", "stale-producer"].includes(input.mode) && value.loop?.attempt?.restore?.undispatched ||
                input.mode === "dispatch-intention-cut" && value.loop?.attempt?.restore &&
                  !value.loop.attempt.restore.undispatched && !value.loop.attempt.launch ||
                input.mode === "query-admission-cut" && value.loop?.recoveries?.[0]?.stage === "observed" ||
                input.mode === "result-cut" && value.loop?.attempt?.restore && value.loop.attempt.stage === "result" ||
                ["retained-permission-accepted-cut", "retained-stop-observer-permission-accepted-cut"].includes(input.mode) && value.loop?.resolutions?.[0]?.stage === "accepted" ||
                input.mode === "retained-stop-observer-permission-observed-cut" && value.loop?.resolutions?.[0]?.currentBarrier?.cause === "native permission denial" ||
                input.mode === "retained-stop-input-applied-cut" && value.loop?.resolutions?.[0]?.stage === "applied" && !value.loop.halt)) {
              cut = true; throw Error("Controlled post-save fallback cut");
            }
          } },
          host: async (key: string, request: any) => {
            const stdout = key === "fixture-closing" ? JSON.stringify({ ...input.metadata, checkout: candidate() })
              : io.execFileSync("sh", ["-c", request.command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            const value = JSON.parse(stdout); if (value.admission) value.admission.maxCycles = 1; if (value.checkpoint) observations.push(value.checkpoint);
            if (value.checkpointObservation) witnesses.push(value.checkpointObservation);
            return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout: JSON.stringify(value), stderr: "", durationMs: 0, outputPath: input.nativeRoot + "/" + key + ".log" };
          },
          status: async (ref: string) => {
            statusCalls.push(ref);
            if (retainedMode && ref.includes(".t1.a2")) return undefined;
            if (interrupted && [interrupted.key, interrupted.runId].includes(ref)) {
              if (input.mode === "unavailable") throw Error("Public writer observer unavailable");
              if (retainedMode) {
                if (input.mode.startsWith("retained-stop-observer-permission")) throw Error("Blocked by pi-subagents permission rule: status denied during reconciliation.");
                // Management no longer repeating the saved Stop/denial cannot discharge it.
                return undefined;
              }
              if (input.mode === "current-stop") return { ...structuredClone(interrupted), ok: true, state: "stopped", stopped: true };
              if (input.mode === "observer-permission") throw Error("Blocked by pi-subagents permission rule: 'status' is denied.");
              if (input.mode === "observer-capacity") throw Error("Active async run capacity exhausted: 1/1 used.");
              if (input.mode === "unknown") return undefined;
              if (input.mode === "inconclusive") return { ok: false, runId: interrupted.runId, output: "Status inconclusive" };
              return input.mode === "stale-producer" && cut ? { ...structuredClone(interrupted), ok: true, state: "running" } : { ...structuredClone(interrupted), ok: true };
            }
            if (input.mode === "dispatch-intention-cut" && ref.includes(".t1.a2")) return undefined;
            if (ref.includes(".recover1")) {
              const entry = observations.find(entry => entry.key === "invoke-human-1.l1.recover1");
              return input.mode === "query-pending" ? { ...entry, structuredOutput: undefined, state: "running" } : structuredClone(entry);
            }
            if (ref.endsWith(".director")) return director(ref);
            if (ref.includes(".t2.a1")) return response("invoke-human-1.l1.t2.a1", { agent: "pitako.worker" }, input.metadata, candidate());
            throw Error("No exact controlled producer " + ref);
          },
          launch: async (key: string, request: any) => {
            if (request.agent === "pitako.execution-ledger") archives.push(JSON.parse(request.task).record);
            calls.push(key);
            if (request.agent === "pitako.loop-io") {
              const { operation, ...data } = JSON.parse(request.task);
              if (["advance", "selection", "close", "drain"].includes(operation)) {
                input.metadata.groupedHooks = { afterStep: (step: string) => {
                  const intention = data.intentions?.find((entry: any) => entry.key === step && entry.operation === "ledger");
                  if (intention) archives.push(structuredClone(intention.input.record));
                } };
                return await response(key, request, input.metadata, candidate());
              }
              const value = operation === "baseline" ? io.captureBaseline(data) : await loopIo[operation](data);
              if (operation === "apply") value.view = (await loopIo.prepare({ ...data, taskId: value.selected?.id, previousConfirmedUnit: null })).view;
              const { backlog, ...receipt } = value;
              if (backlog) receipt.acceptance = backlog.acceptance;
              return { key, ok: true, agent: request.agent, runId: `native-${key}`, output: JSON.stringify(receipt), results: [{ exitCode: 0 }] };
            }
            if (request.resume && key.includes(".t1.")) throw Error("Non-resumable producer must not be resumed");
            if (key.endsWith(".director")) return director(key);
            if (request.agent === "pitako.execution-inspector") throw Error("Checkpoint recovery must not require an inspector chain");
            // Only final checks/compliance consume the candidate; restored unit
            // results get their actual post-write identity below.
            const needsCandidate = request.agent === "pitako.checkpoint-sealer" || request.agent === "pitako.checkout-observer" || key.endsWith(".compliance") || request.agent === "pitako.worker" && key.includes(".t2.");
            const result = await response(key, request, input.metadata, needsCandidate ? candidate() : undefined);
            if (request.agent === "pitako.worker" && key.endsWith(".t1.a1")) {
              const intent = storage.get("invoke-human-1").loop.attempt.checkpoint;
              if (input.mode !== "missing") {
                const checkpoint = await loadCheckpoint(request, input.root, io.loadExtensions, input.toolModule, key).catch((error: unknown) => { console.error(error); throw error; });
                const capture = await checkpoint("pre", ["owned"]);
                originalManifest = capture.manifestRef;
                if (input.mode === "incomplete") io.writeFileSync(originalManifest, "{");
                else if (input.mode === "foreign") {
                  const envelope = JSON.parse(io.readFileSync(originalManifest, "utf8"));
                  const value = JSON.parse(envelope.data); value.intent.taskId = "other";
                  const data = JSON.stringify(value); io.writeFileSync(originalManifest, JSON.stringify({ data, sha256: io.hash(data) }));
                } else helper("apply", { intent, changes: [{ path: "owned", image: { bytes: Buffer.from("partial pending work").toString("base64"), mode: 420 } }] });
              }
              if (input.mode === "conflict") io.writeFileSync(file("owned"), "foreign edit");
              interrupted = { ...result, ok: false, interrupted: true, structuredOutput: undefined,
                processTerminal: { version: 1, runId: result.runId, runnerProcessInstanceId: "writer-1", state: "observed", observedAt: 1,
                  resumeDisposition: "unavailable", instances: [{ kind: "pi-writer", processInstanceId: "writer-1", attempt: 1,
                    closeObservedAt: 1, exitCode: 1, signal: null, processTree: { state: input.mode === "unsettled" ? "unknown" : "observed", mechanism: "posix-process-group", pgid: 123, verifiedAt: 1 } }],
                  canonicalSession: { canonicalSessionId: "original", leaseDisposition: "released", freeAtObservation: true } } };
              if (["stop", "later-stop-input"].includes(input.mode) || input.mode.startsWith("retained-stop")) Object.assign(interrupted, { stopped: true });
              if (["unknown", "unavailable", "inconclusive"].includes(input.mode)) delete interrupted.processTerminal;
              if (input.mode === "permission" || input.mode.startsWith("retained-permission")) Object.assign(interrupted, { error: "Blocked by pi-subagents permission rule: 'run' is denied." });
              if (input.mode === "active") Object.assign(interrupted, { state: "running" });
              return structuredClone(interrupted);
            }
            if (request.agent === "pitako.worker" && /\.t1\.a[23]$/.test(key)) {
              const attempt = storage.get("invoke-human-1").loop.attempt;
              const restore = attempt.restore;
              if (["retained-stop-new-stop", "retained-stop-new-permission"].includes(input.mode))
                return { ...result, ok: false, structuredOutput: undefined,
                  ...(input.mode.endsWith("new-stop") ? { stopped: true } : { error: "Blocked by pi-subagents permission rule: replacement denied." }) };
              if (!request.task.includes(`"sourceKeys":${JSON.stringify(restore.sourceKeys)}`)) throw Error("Missing exact fallback delivery");
              beforeRestore = io.readFileSync(file("owned"), "utf8");
              restoreAuthorities.push(structuredClone(restore.authority));
              let restored: any;
              try { restored = JSON.parse(helper("restore", { intent: restore.sourceKeys.map((key: string) => storage.get("invoke-human-1").taskFrame.sources.find((source: any) => source.key === key)), authority: restore.authority })); }
              catch (error) { return { ...result, ok: true, structuredOutput: { ...result.structuredOutput, taskId: "unit", attempt: attempt.number,
                status: "blocked", diagnosis: "Checkpoint restore not performed: " + String(error), candidate: candidate(),
                remaining: ["Resolve restoration"], checks: [{ id: "unit-check", command: "bun test affected", cwd: input.root,
                  output: String(error), logPaths: [], result: "not-run", before: candidate(), after: candidate() }],
                git: { wip: "Foreign bytes retained" } } }; }
              restores++;
              if (io.readFileSync(file("owned"), "utf8") !== "prior owned WIP") throw Error("Earlier WIP not restored");
              // Replay helper before later work is idempotent, and retains original partial bytes.
              helper("restore", { intent: restore.sourceKeys.map((key: string) => storage.get("invoke-human-1").taskFrame.sources.find((source: any) => source.key === key)), authority: restore.authority });
              const checkpoint = await loadCheckpoint(request, input.root, io.loadExtensions, input.toolModule, key).catch((error: unknown) => { console.error(error); throw error; });
              await checkpoint("pre", ["owned"]);
              if (key.endsWith(".t1.a2") && ["successor-capture-cut", "corrupt-successor"].includes(input.mode)) {
                helper("apply", { intent: attempt.checkpoint, changes: [{ path: "owned", image: { bytes: Buffer.from("partial successor work").toString("base64"), mode: 420 } }] });
                if (input.mode === "corrupt-successor") io.writeFileSync(file(".pi/subagents/checkpoints/" + attempt.key + "/manifest.json"), "{");
                return { ...result, ok: false, interrupted: true, structuredOutput: undefined };
              }
              helper("apply", { intent: attempt.checkpoint, changes: [{ path: "owned", image: { bytes: Buffer.from("finished task").toString("base64"), mode: 420 } }] });
              const current = candidate();
              Object.assign(result.structuredOutput, { git: { wip: "Earlier WIP preserved" } });
              if (input.mode === "missing-receipt") io.unlinkSync(restored.partialRef.replace("restore.json", "restored.json"));
              result.structuredOutput.checks = [{ id: "unit-check", command: "bun test affected", cwd: input.root,
                output: "Controlled current check", logPaths: [], result: "passed", before: current, after: current }];
            }
            return result;
          },
        };
        function director(key: string) {
          key = key.replace(/^native-/, "");
          if (directors.has(key)) return structuredClone(directors.get(key));
          const task = { id: "unit", title: "unit", goal: "Recover owned unit", expectedResult: "Owned unit completed without losing earlier WIP",
            status: "pending", origin: { kind: "spec", ref: input.metadata.selected.source }, specRefs: [input.metadata.selected.source],
            dependsOn: [], gates: [{ id: "unit-check", command: "test \"$(cat owned)\" = \"finished task\"", cwd: input.root, timeoutMs: 30000 }],
            metric: null, parent: null, remaining: "", progress: { nonImproving: 0, last5: [] }, history: [] };
          const exists = io.existsSync(file(".pitako/backlog/assignment.json"));
          const result = legacyResponse(key, { agent: "pitako.execution-director" }, input.metadata, undefined, 1,
            { select: exists ? null : "unit", changes: exists ? [] : [{ kind: "add", task, reason: "Spec requires owned unit" }],
              reason: "Select the pending recovery unit", ...(!exists ? { acceptance: [{ id: "full", command: "true", cwd: input.root }] } : {}) });
          directors.set(key, structuredClone(result));
          return result;
        }
        const first = await run(options as any);
        const firstRetained = structuredClone(storage.get("invoke-human-1"));
        const withInput = input.mode === "later-stop-input" || retainedMode && input.mode !== "retained-stop" && input.mode !== "retained-permission" && input.mode !== "retained-unknown";
        const continuationScript = withInput ? input.script.replace(
          '"checkpointHelper":', '"unblock":true,"resolution":{"loop":1,"text":"Actual later human request to continue from checkpoint"},"checkpointHelper":') : input.script;
        // Native keys cannot be reobserved inside one script. A disappeared
        // restoration successor retains its operation until supported reentry.
        if (["successor-capture-cut", "corrupt-successor"].includes(input.mode) && (first.value as { status: string }).status !== "partial")
          throw Error("Lost restoration did not yield a bounded technical suspension");
        const second = cut || retainedMode || ["later-stop-input", "successor-capture-cut", "corrupt-successor"].includes(input.mode) ? await run({ ...options, script: continuationScript } as any) : null;
        const secondRetained = structuredClone(storage.get("invoke-human-1"));
        const third = retainedMode && (cut || input.mode.includes("-new-") || input.mode.startsWith("retained-stop-observer-permission")) ? await run(options as any) : null;
        return { archives, first: first.value, second: second?.value, third: third?.value, firstRetained, secondRetained, statusCalls, calls, restores, beforeRestore, observations, restoreAuthorities,
          witnesses, retained: storage.get("invoke-human-1"), owned: io.readFileSync(file("owned"), "utf8"), earlier: io.readFileSync(file("earlier"), "utf8"), originalManifest };
      };
      const observation = await nativeCheckpointCase(input, harness.toString());
      if (!observation) return;
      const [exit, output, errors] = observation;
      {
        expect(exit, errors).toBe(0); expect(errors).not.toContain("unawaited runs.run launch(es)");
        const actual = JSON.parse(output);
        const success = ["restored", "unsettled", "unknown", "unavailable", "inconclusive", "later-stop-input", "intention-cut", "result-cut", "dispatch-intention-cut", "successor-capture-cut", "retained-stop-input", "retained-stop-input-applied-cut", "retained-unknown"].includes(mode);
        expect(actual.third ?? actual.second ?? actual.first).toMatchObject({ status: success ? "partial" : mode === "observer-capacity" ? "partial" : ["stop", "current-stop", "retained-stop", "retained-stop-new-stop"].includes(mode) ? "cancelled" : "blocked", loopsConsumed: 1 });
        expect(actual.earlier).toBe("earlier independent WIP");
        if (mode.startsWith("retained-") && mode !== "retained-unknown" || ["intention-cut", "dispatch-intention-cut", "successor-capture-cut"].includes(mode)) {
          expect(actual.witnesses.length).toBeGreaterThan(0);
          expect(actual.witnesses[0]).toMatchObject({ key: expect.stringContaining("invoke-human-1.l1.t1.a"), taskId: "unit", loop: 1, cursor: 0 });
          expect(actual.witnesses[0].evidence).toMatch(/^[a-f0-9]{64}$/);
        }
        expect(actual.calls.filter((key: string) => key.endsWith(".t1.a1"))).toHaveLength(1);
        expect(actual.calls.filter((key: string) => key.endsWith(".t1.a2"))).toHaveLength(mode === "dispatch-intention-cut" ? 0 : success || ["missing", "incomplete", "foreign", "conflict", "missing-receipt", "corrupt-successor", "retained-stop-new-stop", "retained-stop-new-permission"].includes(mode) ? 1 : 0);
        expect(actual.calls.filter((key: string) => key.endsWith(".t1.a3"))).toHaveLength(["dispatch-intention-cut", "successor-capture-cut"].includes(mode) ? 1 : 0);
        expect(actual.restores).toBe(mode === "successor-capture-cut" ? 2 : success || ["missing-receipt", "corrupt-successor"].includes(mode) ? 1 : 0);
        expect(actual.calls.filter((key: string) => key.includes(".recover") || key.endsWith(".resume"))).toHaveLength(0);
        expect(actual.retained.association.maxCycles).toBe(1);
        for (const authority of actual.restoreAuthorities) {
          expect(authority.activeWriter).toBeNull();
          expect(authority).not.toHaveProperty("settled");
          expect(authority).not.toHaveProperty("continuationUnavailable");
        }
        if (["missing", "incomplete", "foreign"].includes(mode)) {
          expect(actual.owned).toBe("prior owned WIP");
          if (actual.originalManifest) expect(existsSync(actual.originalManifest.replace("manifest.json", "restore.json"))).toBe(false);
        }
        if (success) {
          expect(actual.owned).toBe("finished task");
          expect(actual.beforeRestore).toBe(mode === "successor-capture-cut" ? "partial successor work" : "partial pending work");
          expect(actual.calls).not.toContain("invoke-human-1.l1.t2.a1");
          expect(actual.calls.some((key: string) => key.includes(".review.") || key.endsWith(".compliance"))).toBe(false);
          const repeat = ["dispatch-intention-cut", "successor-capture-cut"].includes(mode);
          expect(actual.archives.find((entry: any) => entry.body.frame)?.body.frame.operations).toHaveLength(repeat ? 2 : 1);
          expect(actual.retained.taskFrame).toBeNull();
          expect(actual.retained.tasks.unit.completed).toMatchObject({ taskId: "unit", attempt: repeat ? 3 : 2, status: "complete" });
          if (repeat) {
            const restored = actual.retained.tasks.unit.completed.restore.receipt;
            expect(restored.checkpointRef).toContain(mode === "dispatch-intention-cut" ? ".t1.a1/manifest.json" : ".t1.a2/manifest.json");
          }
          const partial = JSON.parse(JSON.parse(readFileSync(actual.originalManifest.replace("manifest.json", "restore.json"), "utf8")).data);
          expect(Buffer.from(partial.partial[0].image.bytes, "base64").toString()).toBe("partial pending work");
        } else expect(actual.calls).not.toContain("invoke-human-1.l1.compliance");
        if (mode.startsWith("retained-")) {
          const firstLoop = actual.firstRetained.loop, finalLoop = actual.retained.loop;
          if (mode !== "retained-unknown") expect(firstLoop.halt).toMatchObject({ code: "native-barrier",
            cause: mode.startsWith("retained-permission") ? "native permission denial" : "stopped" });
          if (!success) {
            expect(actual.owned).toBe("partial pending work");
            expect(finalLoop.cursor).toBe(0); expect(finalLoop.phase).toBe("implementation");
            expect(finalLoop.halt).toMatchObject({ code: "native-barrier", cause:
              mode.includes("permission") ? "native permission denial" : "stopped" });
            expect(actual.calls).not.toContain("invoke-human-1.l1.t2.a1");
            expect(existsSync(actual.originalManifest.replace("manifest.json", "restore.json"))).toBe(false);
          }
          if (mode === "retained-permission-accepted-cut")
            expect(actual.secondRetained.loop).toMatchObject({ halt: { cause: "native permission denial" }, resolutions: [{ stage: "accepted" }] });
          if (mode.includes("-new-") || mode.startsWith("retained-stop-observer-permission"))
            expect(finalLoop.resolutions[0].currentBarrier.cause).toBe(mode.includes("permission") ? "native permission denial" : "stopped");
        }
        if (mode === "conflict") expect(actual.owned).toBe("foreign edit");
        if (mode === "corrupt-successor") {
          expect(actual.owned).toBe("partial successor work");
          expect(actual.retained.loop.halt).toMatchObject({ status: "blocked", code: "checkpoint-integrity",
            reason: expect.stringContaining("Checkpoint observation unavailable:") });
        }
      }
    });

  test("checkpoint intention persistence failure prevents modifying dispatch", async () => {
    const root = repository();
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
    const metadata = { ...deterministicScripts, root, commonDir: path.join(root, ".git"),
      selected: { source: path.join(root, ".pitako/plans/assignment.md"), digest: digest(content), chunks: 1 } };
    mkdirSync(path.dirname(metadata.selected.source), { recursive: true });
    writeFileSync(metadata.selected.source, content);
    const resource = executionResource("linux").resolve({ root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath: "/native/actual-mission.json" });
    const binding = preliminarySpec(root, "assignment").binding;
    const storage = new Map<string, any>(), calls: string[] = [];
    const operation = runWorkflowScript({ script: resource.script,
      state: { get: (key: string) => structuredClone(storage.get(key)), set: (key: string, value: any) => {
        if (value.loop?.attempt?.checkpoint) throw Error("checkpoint intention persistence unavailable");
        storage.set(key, structuredClone(value));
      } },
      host: async (key: string) => ({ key, kind: "command" as const, state: "passed" as const, ok: true, exitCode: 0,
        stdout: JSON.stringify({ version: 1, binding, checkout, admission: { maxCycles: 3 } }),
        stderr: "", durationMs: 0, outputPath: "/controlled/inspection.json" }),
      launch: async (key: string, request: any) => {
        calls.push(key);
        if (request.agent === "pitako.loop-io") {
          const { operation, ...data } = JSON.parse(request.task);
          if (["advance", "selection", "close", "drain"].includes(operation)) {
            return await childResponse(key, request, metadata, checkout);
          }
          const input = { ...data, dbPath: path.join(root, ".pi/test-board.db") };
          let value;
          if (operation === "prepare") value = await prepare(input);
          else {
            const applied = apply(input);
            value = { ...applied, view: (await prepare({ ...input, taskId: applied.selected?.id, previousConfirmedUnit: null })).view };
          }
          const { backlog, ...fields } = value;
          const receipt = { ...fields, ...(backlog ? { acceptance: backlog.acceptance } : {}) };
          return { key, ok: true, agent: request.agent, runId: `native-${key}`, output: JSON.stringify(receipt), results: [{ exitCode: 0 }] };
        }
        const task = { id: "unit", title: "unit", goal: "Implement unit", expectedResult: "Implementation completed", status: "pending",
          origin: { kind: "spec", ref: metadata.selected.source }, specRefs: [metadata.selected.source], dependsOn: [],
          gates: [{ id: "unit-check", command: "true", cwd: root, timeoutMs: 30000 }], metric: null, parent: null,
          remaining: "", progress: { nonImproving: 0, last5: [] }, history: [] };
        return childResponse(key, request, metadata, checkout, 1, { select: "unit",
          changes: [{ kind: "add", task, reason: "Derive implementation from spec" }], reason: "Implement the unit",
          acceptance: [{ id: "full", command: "true", cwd: root }] });
      },
      status: async () => { throw Error("No status query expected before modifying dispatch"); },
    });
    workflowSettlements.push(operation.then(() => {}, () => {}));
    const result = await operation;
    expect((result.value as any).status, (result.value as any).reason).toBe("partial");
    expect((result.value as any).reason).toContain("persistence");
    expect(calls.filter(key => !key.includes(".requests-") && !key.includes(".review.verify-") && !/\.seal(?:\.r\d+)?$/.test(key))).toEqual(["invoke-human-1.l1.advance", "invoke-human-1.l1.director", "invoke-human-1.l1.selectionIO"]);
    expect(storage.get("invoke-human-1").consumedLoops).toBe(1);
  });
});

describe("plan/execute packaged composition", () => {
  test.each(["missing", "inconclusive", "unavailable", "absent-result", "failed-result"])("registered writer checkpoint-first restoration advances with %s status", async observation => {
    const root = repository(), nativeRoot = repository(), missionPath = path.join(nativeRoot, "mission.json");
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
    mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    const source = path.join(root, ".pitako/plans/assignment.md"); writeFileSync(source, content);
    writeFileSync(path.join(root, "earlier"), "valid earlier WIP");
    writeFileSync(path.join(root, "owned"), "valid prior WIP");
    writeFileSync(path.join(root, "deleted"), "prior deletion target");
    const metadata = { ...deterministicScripts, root, commonDir: path.join(root, ".git"), selected: { source, digest: digest(content) } };
    const resource = resourceWithAgentDir(path.join(nativeRoot, "agent")).resolve({
      root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath });
    const harness = async (input: any, run: typeof runWorkflowScript, response: typeof childResponse, io: any) => {
      if (!process.versions.bun) await import(input.loopLoader);
      const loopIo = await import(input.loopModule);
      const legacyResponse = response;
      response = ((key: string, request: any, metadata: any, candidate: any) => legacyResponse(key, request, metadata, candidate, 1,
        request.agent === "pitako.worker" ? { work: "Recovered pending unit", status: "complete", remaining: [],
          knowledge: { findings: [], handoff: "Owned file contains completed pending work" } } : undefined)) as typeof response;
      let director: any;
      const { root, nativeRoot, missionPath, metadata, script, hostCommands, observation, helper } = input;
      const grants = new Map<string, string>(hostCommands.map((grant: any) => [grant.key, grant.command]));
      const { writeFileSync, readFileSync, existsSync, execFileSync, captureCheckpoint, applyCheckpoint, restoreCheckpoint, checkoutEvidence } = io;
      const path = await import("node:path");
      let initial: any, restored: any;
      const storage = new Map<string, any>(), calls: string[] = [];
      let intention: any, checkpointRef = "", beforeRestore: any, restoreReceipt: any, archivedFrame: any;
      const observedCandidate = () => { const { head, fingerprint } = checkoutEvidence(root); return { head, fingerprint }; };
      const request = path.join(nativeRoot, "request.json");
      const invoke = (operation: string, data: any) => {
        // One case covers the full CLI transport; the other status variants use
        // the same real helpers without repeating six Node startups each.
        if (operation !== "apply" && observation === "missing") {
          writeFileSync(request, JSON.stringify(data));
          return execFileSync("node", [helper, operation, request], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        }
        if (operation === "capture") return JSON.stringify(captureCheckpoint(data.intent, data.paths));
        if (operation === "apply") { applyCheckpoint(data.intent, data.changes); return ""; }
        if (operation === "restore") return JSON.stringify(restoreCheckpoint(data.intent, data.authority));
        throw Error("Unexpected checkpoint operation: " + operation);
    };
    const operation = run({ script,
      state: { get: (key: string) => structuredClone(storage.get(key)), set: (key: string, value: any) => { storage.set(key, structuredClone(value)); } },
      status: async key => {
        if (key.endsWith(".director")) return structuredClone(director);
        if (observation === "unavailable") throw Error("Public status unavailable");
        return { key, ok: false, output: observation === "inconclusive" ? "No current writer inventory" : "", artifactPaths: [] };
      },
      host: async (key: string) => {
        const value = JSON.parse(execFileSync("sh", ["-c", grants.get(key)!], { cwd: root, encoding: "utf8" }));
        if (value.admission) value.admission.maxCycles = 1;
        return { key, kind: "command" as const, state: "passed" as const, ok: true, exitCode: 0,
          stdout: JSON.stringify(value), stderr: "", outputPath: path.join(nativeRoot, key + ".log"), durationMs: 0 };
      },
      launch: async (key: string, request: any) => {
        calls.push(key);
        if (request.agent === "pitako.loop-io") {
          const { operation, ...data } = JSON.parse(request.task);
          if (["advance", "selection", "close", "drain"].includes(operation)) {
            metadata.groupedHooks = { afterStep: (step: string) => {
              const intention = data.intentions?.find((entry: any) => entry.key === step && entry.operation === "ledger");
              if (intention?.input.record.body.frame) archivedFrame = structuredClone(intention.input.record.body.frame);
            } };
            return await response(key, request, metadata, observedCandidate());
          }
          const value = operation === "baseline" ? io.captureBaseline(data) : await loopIo[operation](data);
          if (operation === "apply") value.view = (await loopIo.prepare({ ...data, taskId: value.selected?.id, previousConfirmedUnit: null })).view;
          const { backlog, ...receipt } = value;
              if (backlog) receipt.acceptance = backlog.acceptance;
          return { key, ok: true, agent: request.agent, runId: `native-${key}`, output: JSON.stringify(receipt), results: [{ exitCode: 0 }] };
        }
        if (request.agent === "pitako.execution-ledger" && JSON.parse(request.task).record.body.frame) archivedFrame = JSON.parse(request.task).record.body.frame;
        if (request.agent === "pitako.worker" && request.resume) return { key, ok: false, output: "Controlled native resume unavailable",
          error: "Controlled native resume unavailable", artifactPaths: [] };
        const needsCandidate = request.agent === "pitako.checkpoint-sealer" || request.agent === "pitako.checkout-observer" || key.endsWith(".compliance") ||
          (request.agent === "pitako.worker" && key.includes(".t2."));
        const child = await response(key, request, metadata, needsCandidate ? observedCandidate() : undefined);
        if (key.endsWith(".director")) {
          const task = { id: "unit", title: "unit", goal: "Recover owned unit", expectedResult: "Restore owned paths and complete the unit",
            status: "pending", origin: { kind: "spec", ref: metadata.selected.source }, specRefs: [metadata.selected.source],
            dependsOn: [], gates: [{ id: "unit-check", command: 'test "$(cat owned)" = "completed pending work"', cwd: root, timeoutMs: 30000 }],
            metric: null, parent: null, remaining: "", progress: { nonImproving: 0, last5: [] }, history: [] };
          director = legacyResponse(key, request, metadata, undefined, 1, { select: "unit",
            changes: [{ kind: "add", task, reason: "Implement the spec unit" }], reason: "Recover the pending unit",
            acceptance: [{ id: "full", command: "true", cwd: root }] });
          return structuredClone(director);
        }
        if (request.agent === "pitako.worker" && key.includes(".t1.")) {
          const descriptor = storage.get("invoke-human-1").loop.attempt;
          if (descriptor.restore) {
            restored = { activeWriter: descriptor.restore.authority.activeWriter };
            restoreReceipt = JSON.parse(invoke("restore", { intent: descriptor.restore.sourceKeys.map((key: string) => storage.get("invoke-human-1").taskFrame.sources.find((source: any) => source.key === key)), authority: descriptor.restore.authority }));
            Object.assign(restored, { owned: readFileSync(path.join(root, "owned"), "utf8"),
              deleted: readFileSync(path.join(root, "deleted"), "utf8"), newExists: existsSync(path.join(root, "new")),
              earlier: readFileSync(path.join(root, "earlier"), "utf8") });
            invoke("capture", { intent: descriptor.checkpoint, paths: ["owned"] });
            invoke("apply", { intent: descriptor.checkpoint, changes: [
              { path: "owned", image: { bytes: Buffer.from("completed pending work").toString("base64"), mode: 420 } },
            ] });
            return child;
          }
          const stored = structuredClone(storage.get("invoke-human-1"));
          intention = stored.loop.attempt.checkpoint;
          initial = { association: stored.association, task: request.task };
          const captured = JSON.parse(invoke("capture", { intent: intention, paths: ["owned", "deleted", "new"] }));
          checkpointRef = path.join(captured.directory, "manifest.json");
          Object.assign(initial, { captured: existsSync(checkpointRef), owned: readFileSync(path.join(root, "owned"), "utf8") });
          invoke("apply", { intent: intention, changes: [
            { path: "owned", image: { bytes: Buffer.from("interrupted partial").toString("base64"), mode: 420 } },
            { path: "deleted", image: null },
            { path: "new", image: { bytes: Buffer.from("interrupted new").toString("base64"), mode: 420 } },
          ] });
          beforeRestore = stored;
          // Controlled settled external interruption; no worker result admitted.
          const missingResult = ["absent-result", "failed-result"].includes(observation);
          return { ...child, ok: observation === "absent-result", interrupted: !missingResult, structuredOutput: undefined,
            error: missingResult ? "Controlled unit returned without a complete result" : "controlled interrupted unit" };
        }
        return child;
      },
    });
    const completed = await operation;
    return { completed, calls, persisted: storage.get("invoke-human-1"), restoreReceipt, checkpointRef,
      beforeRestore, archivedFrame, intention, initial, restored };
    };
    return nativeCheckpointCase({ root, nativeRoot, missionPath, metadata, script: resource.script,
      loopLoader: new URL("../skills/execute/loader.mjs", import.meta.url).href,
      loopModule: new URL("../skills/execute/loop.ts", import.meta.url).href,
      hostCommands: resource.hostCommands, observation, helper: path.resolve("skills/execute/checkpoint.mjs"),
      module: new URL("../extensions/execute-checkpoint.ts", import.meta.url).href,
      evidence: new URL("../extensions/spec-plans.ts", import.meta.url).href }, harness.toString(), ([exit, stdout, stderr]) => {
      expect(exit, stderr).toBe(0);
      const { completed, calls, persisted, restoreReceipt, checkpointRef, beforeRestore, archivedFrame, intention, initial, restored } = JSON.parse(stdout);
      expect(restored.activeWriter).toBeNull();
      expect(restored.owned).toBe("valid prior WIP");
      expect(restored.deleted).toBe("prior deletion target");
      expect(restored.newExists).toBe(false);
      expect(restored.earlier).toBe("valid earlier WIP");
      expect(intention).toMatchObject({ taskId: "unit", loop: 1, cursor: 0, phase: "implementation" });
      expect(intention.association).toEqual(initial.association);
      expect(initial.task).toContain(JSON.stringify(intention));
      expect(initial.task).toContain(path.resolve("skills/execute/checkpoint.mjs"));
      expect(initial.captured).toBe(true);
      expect(initial.owned).toBe("valid prior WIP");
      expect((completed.value as any).status, (completed.value as any).reason).toBe("partial");
      expect(persisted.tasks.unit.completed).toMatchObject({ taskId: "unit", status: "complete", attempt: 2 });
      expect(calls.filter((key: string) => key.endsWith(".resume"))).toHaveLength(0);
      expect(calls.filter((key: string) => key.includes(".recover"))).toHaveLength(0);
      expect(restoreReceipt.position).toEqual({ loop: 1, cursor: 0, phase: "implementation" });
      expect(restoreReceipt.checkpointRef).toBe(checkpointRef);
      expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("completed pending work");
      expect(readFileSync(path.join(root, "deleted"), "utf8")).toBe("prior deletion target");
      expect(existsSync(path.join(root, "new"))).toBe(false);
      expect(readFileSync(path.join(root, "earlier"), "utf8")).toBe("valid earlier WIP");
      expect(persisted.association).toEqual(beforeRestore.association);
      expect(persisted.consumedLoops).toBe(1);
      expect(persisted.loop.cursor).toBe(1);
      expect(persisted.loop.results.filter((result: any) => persisted.tasks[result.taskId].completed?.attempt === result.attempt)).toHaveLength(1);
      expect(archivedFrame.sources.find((source: any) => source.key === intention.key)).toEqual(intention);
      expect(persisted.taskFrame).toBeNull();
      expect(calls.filter((key: string) => /\.t\d+\.a\d+$/.test(key))).toHaveLength(2);
      expect(calls).not.toContain("invoke-human-1.l1.t2.a1");
      expect(calls.some((key: string) => key.includes(".review."))).toBe(false);
      expect(calls).not.toContain("invoke-human-1.l1.compliance");
      expect(resource.hostCommands).toHaveLength(3);
    });
  });

  test.each(["complete", "recovered", "unresolved-plan", "rejected-plan", "decision-overflow", "mismatched-association", "stopped", "permission",
    "analysis-prepare-stop", "analysis-prepare-permission", "analysis-later-stop", "analysis-later-permission",
    "analysis-compliance-stop", "analysis-compliance-permission", "analysis-prepare-thrown-permission",
    "host-opening-stop", "host-opening-identical-failure",
    "host-opening-timeout", "host-opening-command-failure", "host-opening-similar-text", "host-opening-persistence-failure"])(
    "registered Node root settles native calls without changing the %s outcome", async mode => {
      const root = repository(), spec = assignmentSpec(root);
      const { head, fingerprint } = checkoutEvidence(root), checkout = { head, fingerprint };
      const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
      planExecute({ on: (name: string, hook: (event: unknown, context: unknown) => unknown) => { hooks.set(name, hook); } } as unknown as ExtensionAPI);
      const sessionId = randomUUID(), ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
      hooks.get("session_start")!({}, ctx);
      disposers.push(() => hooks.get("session_shutdown")!({}, ctx));
      const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
      const resolved = resolveWorkflowResource("pitako.execute", args, sessionId);
      if (!resolved.ok) throw Error(resolved.error);
      const content = spec.content;
      const metadata = { ...deterministicScripts, root, commonDir: path.join(root, ".git"), candidates: [],
        selected: { source: `${root}/.pitako/plans/assignment.md`, digest: digest(content), chunks: 1 } };
      const storage = new Map<string, any>(), children: Record<string, any> = {}, hosts: Record<string, any> = {};
      const calls: string[] = [], inspections: string[] = [], originals: any[] = [], publications: any[] = [];
      let recoveredWorker: any;
      const permission = "Blocked by pi-subagents permission rule: 'run' is denied.";
      const hostTarget = !mode.startsWith("host-") ? null : mode.includes("-capture-") ? "input-0"
        : mode.includes("-closing-") ? "inspect-loop-1" : "inspect-initial";
      const ambiguousHost = !!hostTarget && !["timeout", "command-failure", "similar-text"].some(kind => mode.endsWith(kind));
      const hostFailure = (key: string, response: any) => key !== hostTarget ? response : { ...response,
        state: mode.endsWith("timeout") ? "timed-out" : mode.endsWith("stop") || mode.endsWith("persistence-failure") ? "stopped" : "failed",
        ok: false, exitCode: null, stdout: "", error: mode.endsWith("timeout") ? "Command timed out after 86400000ms."
          : mode.endsWith("command-failure") ? "Command exited with code 1."
          : mode.endsWith("similar-text") ? "Model said: Command stopped because the workflow was aborted."
          : "Command stopped because the workflow was aborted." };
      const analysisTarget = !mode.startsWith("analysis-") ? null : `invoke-human-1.l2.${mode.includes("-prepare-")
        ? "review.director-prepare" : mode.includes("-later-") ? "review.independent-a" : "compliance"}`;
      const expected = await runWorkflowScript({ script: resolved.resource.script,
        state: { get: key => structuredClone(storage.get(key)), set: (key, value) => {
          if (mode.endsWith("persistence-failure") && (value as any).hostHalt) throw Error("Controlled essential persistence failure");
          storage.set(key, structuredClone(value));
        } },
        launch: async (key, request) => {
          calls.push(key);
          if (request.agent === "pitako.checkout-observer") publications.push(JSON.parse(String(request.task)));
          if (request.agent === "pitako.loop-io") {
            const input = JSON.parse(String(request.task));
            if (["advance", "selection", "close", "drain"].includes(input.operation)) {
              const response = input.operation === "advance" && mode === "decision-overflow"
                ? { key, agent: request.agent, runId: `native-${key}`, ok: false, output: JSON.stringify({
                  error: "loop-io", reason: "Current DECISIONs exceed 8 KiB; ask the human to consolidate them.", viewOverflow: true }), results: [{ exitCode: 1 }] }
                : await childResponse(key, request, metadata, checkout);
              children[key] = structuredClone(response);
              originals.push({ response, original: structuredClone(response) });
              return response;
            }
            const view = { topicId: 1, authority: "spec and frozen amendments > DECISION > FINDING > HANDOFF; code wins over any map", posts: [], omitted: 0 };
            let value: any;
            try {
              if (input.operation === "prepare" && mode === "decision-overflow") throw Error("Current DECISIONs exceed 8 KiB; ask the human to consolidate them.");
              if (input.operation === "prepare") value = { ...readBacklog(root, "assignment"), view, lastConfirmedUnit: null };
              else if (input.operation === "apply") value = { ...apply(input), view };
              else if (input.operation === "reviewOriginals") value = reviewOriginals(input);
              else if (input.operation === "baseline") value = captureBaseline(input);
              else {
                const progress = updateProgress(input.task.progress, { value: null, fingerprint: checkout.fingerprint,
                  gatesPassed: input.task.gates.length, gatesTotal: input.task.gates.length }, null);
                value = { before: checkout, after: checkout, mutated: false, metric: null, progress, stalled: false, view,
                  gates: input.task.gates.map((gate: any) => ({ id: gate.id, status: "pass", exit: 0, ms: 1,
                    tail: "Controlled gate passed", logRef: `/native/gates/${key}/${gate.id}.log` })) };
              }
            } catch (error) {
              value = { error: "loop-io", reason: (error as Error).message, selectionRejected: (error as any).selectionRejected === true };
            }
            const { backlog, ...receipt } = value;
            if (backlog) receipt.acceptance = backlog.acceptance;
            const response = { key, agent: request.agent, runId: `native-${key}`, ok: !value.error,
              output: JSON.stringify(receipt), results: [{ exitCode: value.error ? 1 : 0 }] };
            children[key] = structuredClone(response);
            originals.push({ response, original: structuredClone(response) });
            return response;
          }
          const pending = readBacklog(root, "assignment").backlog;
          const selected = { id: "final", title: "final", goal: "Verify complete candidate", expectedResult: "Focused verification passes", status: "pending",
            origin: { kind: "spec", ref: spec.source }, specRefs: [spec.source], dependsOn: [],
            gates: [{ id: "final-check", command: "true", cwd: root, timeoutMs: 1800000 }], metric: null,
            parent: null, remaining: "", progress: { nonImproving: 0, last5: [] }, history: [] };
          const selection = { select: pending ? pending.tasks.find(task => task.status === "pending")?.id ?? null : selected.id,
            changes: pending ? [] : [{ kind: "add", task: selected, reason: "From admitted spec" }],
            reason: "Most important eligible task", ...(!pending ? { acceptance: [{ id: "full", command: "true", cwd: root }] } : {}) };
          const response = request.agent === "pitako.execution-inspector"
            ? { key, ok: true, output: "", runId: `native-${key}`, agent: request.agent, artifactPaths: [],
              structuredOutput: { status: "recovered", reason: "Exact settled original recovered without edits",
                original: null, workerResult: structuredClone(recoveredWorker), originalAvailable: true,
                binding: "absent", comparison: "only-original", provenance: ["/native/original-worker.json"] } }
            : await childResponse(key, request, metadata, checkout, 2,
              request.agent === "pitako.execution-director" ? selection : request.agent === "pitako.worker"
                ? { status: "complete", work: "Required task verified", remaining: [], knowledge: { findings: [], handoff: "Current candidate verified" } } : undefined);
          if (request.agent === "pitako.worker") {
            const saved = storage.get("invoke-human-1"), attempt = saved.loop.attempt;
            if (attempt.restore) restoreCheckpoint(attempt.restore.sourceKeys.map((key: string) =>
              saved.taskFrame.sources.find((source: any) => source.key === key)), attempt.restore.authority);
            captureCheckpoint(attempt.checkpoint, ["owned"]);
          }
          if (request.agent === "pitako.worker" && ["complete", "recovered"].includes(mode)) {
            const value = response.structuredOutput;
            // Malformed advisory knowledge never invalidates an otherwise complete result.
            value.knowledge = { findings: [null, 42, "Current controlled observation"], handoff: { invalid: true } };
            const schema = request.outputSchema as TSchema;
            expect(validateToolArguments({ name: "worker_result", description: "Result", parameters: schema },
              { type: "toolCall", id: "worker", name: "worker_result", arguments: value })).toEqual(value);
            if (mode === "recovered" && key.endsWith(".a1")) {
              recoveredWorker = structuredClone(value);
              delete (response as { structuredOutput?: unknown }).structuredOutput;
            }
          }
          if (mode === "unresolved-plan") {
            if (key.endsWith(".director")) delete (response as { structuredOutput?: unknown }).structuredOutput;
            if (request.agent === "pitako.execution-inspector") Object.assign(response.structuredOutput, {
              status: "unresolved", reason: "Actor: artifact owner. Expansion needed: read access to exact binding.",
              original: null, workerResult: null, originalAvailable: false, binding: "unavailable", comparison: "neither",
            });
          }
          if (request.agent === "pitako.execution-inspector" && mode !== "unresolved-plan") {
            expect(storage.get("invoke-human-1").loop.recoveries[0]).toMatchObject({
              stage: "intention", subject: "attempt-result:final:1",
            });
            expect(request.task).toContain("specific scope/effects expansion needed");
          }
          if (request.agent === "pitako.execution-director" && mode !== "unresolved-plan") {
            const plan = response.structuredOutput;
            const schema = request.outputSchema as TSchema;
            expect((schema as any).properties).not.toHaveProperty("association");
            const tool = { name: "selection", description: "Backlog selection", parameters: schema };
            const validate = (value: any) => validateToolArguments(tool, { type: "toolCall", id: "plan", name: tool.name, arguments: value });
            expect(validate(plan)).toEqual(plan);
            if (mode === "mismatched-association") plan.association = { missionPath: "/wrong" };
            if (mode === "rejected-plan") {
              if (Number(key.match(/\.l(\d+)\./)![1]) === 1) plan.select = "missing";
              else if (Number(key.match(/\.l(\d+)\./)![1]) === 2) {
                expect(storage.get("invoke-human-1").planRejections).toEqual([{ loop: 1, diagnostic: expect.stringContaining("Selected task must be pending") }]);
                expect(request.task).toContain("VERIFIED RETAINED LOOP SUMMARIES");
                expect(request.task).toContain("Selected task must be pending");
              }
            }
          }
          if (request.agent === "pitako.worker" && mode === "stopped") Object.assign(response, { ok: false, stopped: true });
          if (key === analysisTarget) Object.assign(response, { ok: false,
            ...(mode.endsWith("-stop") ? { stopped: true } : { error: permission }) });
          children[key] = structuredClone(response);
          originals.push({ response, original: structuredClone(response) });
          if (request.agent === "pitako.worker" && mode === "permission") throw Error(permission);
          if (key === analysisTarget && mode.includes("-thrown-")) throw Error(permission);
          return response;
        },
        status: async ref => {
          if (mode === "unresolved-plan") return { key: "director", ok: true, output: "", artifactPaths: [] };
          const original = children[ref] ?? Object.values(children).find(child => child.runId === ref);
          if (!original) throw Error("No exact producer " + ref);
          return structuredClone(original);
        },
        host: async key => {
          inspections.push(key);
          const response = { key, kind: "command" as const, state: "passed" as const, ok: true, exitCode: 0,
            stdout: JSON.stringify({ version: 1, binding: spec.binding, checkout, admission: { maxCycles: 3 } }),
            stderr: "", outputPath: `/native/${key}.log`, durationMs: 0 };
          hosts[key] = structuredClone(response);
          return hostFailure(key, response);
        },
      });
      const recoveredHost = mode === "host-opening-timeout";
      expect(expected.value).toMatchObject({ status: ["complete", "recovered", "rejected-plan", "mismatched-association"].includes(mode) || recoveredHost ? "complete" : mode === "stopped" || mode.endsWith("-stop") ? "cancelled" : "blocked",
        ...hostTarget && !recoveredHost ? { status: "blocked" } : {},
        loopsConsumed: recoveredHost ? 2 : hostTarget && hostTarget !== "inspect-loop-1" ? 0 : ["complete", "recovered", "mismatched-association"].includes(mode) || analysisTarget ? 2 : mode === "rejected-plan" ? 3 : 1 });
      expect(calls.filter(key => !key.includes(".requests-") && !/\.(prepare|selection|settlement|gate|baseline)(?:\.d1)?(?:\.r\d+)?$/.test(key) && !key.includes(".review.verify-") && !/\.seal(?:\.r\d+)?$/.test(key))).toHaveLength(analysisTarget ? mode.includes("-prepare-") ? 9 : mode.includes("-later-") ? 11 : 14
        : recoveredHost ? 16 : hostTarget ? hostTarget === "inspect-loop-1" ? 7 : 0
        : mode === "decision-overflow" ? 1 : ["complete", "mismatched-association"].includes(mode) ? 16 : mode === "recovered" ? 17 : mode === "rejected-plan" ? 21 : ["stopped", "permission"].includes(mode) ? 4 : mode === "unresolved-plan" ? 3 : 1);
      if (mode === "decision-overflow") {
        expect((expected.value as any).reason).toContain("human to consolidate");
        expect(calls).toEqual(["invoke-human-1.l1.advance"]);
      }
      if (ambiguousHost) {
        expect((expected.value as any).reason).toContain("ambiguous");
        expect((expected.value as any).action.actor).toBe(mode.endsWith("persistence-failure") ? "persistence operator" : "native run operator");
        expect((expected.value as any).action.started).toBe(false);
        if (mode.endsWith("persistence-failure")) expect((expected.value as any).reason).toContain("could not be retained");
        else expect(storage.get("invoke-human-1").hostHalt).toMatchObject({ ref: { key: hostTarget },
          observedError: `Host command '${hostTarget}' failed: Command stopped because the workflow was aborted.` });
      } else if (recoveredHost) {
        expect(inspections).toEqual(["inspect-initial", "inspect-initial.r1"]);
        expect(storage.get("invoke-human-1").hostHalt).toBeUndefined();
      } else if (hostTarget) expect(storage.get("invoke-human-1")?.hostHalt).toMatchObject({ ref: { key: hostTarget } });
      if (mode === "unresolved-plan") {
        expect(expected.value).toMatchObject({ reason: expect.stringContaining("Expansion needed: read access"),
          action: { actor: "evidence owner", started: false } });
        expect(storage.get("invoke-human-1").loop.recoveries[0].disposition).toBe("unresolved");
        expect(calls.filter(key => !key.endsWith(".advance"))).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l1.recover1"]);
      }
      if (mode === "recovered") {
        expect(readBacklog(root, "assignment").backlog!.tasks.find(task => task.id === "final")!.status).toBe("done");
        expect(calls).toContain("invoke-human-1.l1.t1.a2.close");
        expect(calls.filter(key => /\.t1\.a\d+$/.test(key))).toHaveLength(2);
        expect(calls.filter(key => key.includes(".recover"))).toHaveLength(0);
      }
      for (const { response, original } of originals) expect(response).toEqual(original);
      const child = Bun.spawn(["node", "-e", `
        const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        import(${JSON.stringify(new URL("../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href)})
          .then(async ({ runWorkflowScript }) => {
            const storage = new Map(), calls = [], inspections = [];
            let replay = false;
            const statuses = [];
            const options = {
              script: input.script,
              state: { get: async key => structuredClone(storage.get(key)),
                set: async (key, value) => {
                  if (input.mode.endsWith("persistence-failure") && value.hostHalt) throw Error("Controlled essential persistence failure");
                  storage.set(key, structuredClone(value));
                } },
              launch: async (key, request) => {
                calls.push(key);
                if (request.agent === "pitako.request-observer") return (${childResponse.toString()})(key, request, input.metadata, input.checkout);
                if (!input.children[key]) throw Error("Unexpected child " + key);
                if (input.mode === "permission" && input.children[key].agent === "pitako.worker") throw Error(input.permission);
                if (!replay && key === input.analysisTarget && input.mode.includes("-thrown-")) throw Error(input.permission);
                // A replacement is prepared to succeed. Replay must not call it.
                if (replay) return { ...structuredClone(input.children[key]), ok: true, stopped: false, error: undefined };
                return structuredClone(input.children[key]);
              },
              status: async ref => {
                statuses.push(ref);
                if (input.analysisTarget || ref.includes("director")) {
                  const result = Object.values(input.children).find(child => child.runId === ref || child.key === ref);
                  if (!result) throw Error("Missing exact producer " + ref);
                  return structuredClone(result);
                }
                if (input.mode === "unresolved-plan") return { key: "director", ok: true, output: "", artifactPaths: [] };
                throw Error("Unexpected recovery");
              },
              host: async key => {
                inspections.push(key);
                if (!input.hosts[key]) throw Error("Unexpected host " + key);
                if (key === input.hostTarget) return input.hostFailure;
                return structuredClone(input.hosts[key]);
              },
            };
            const observed = await runWorkflowScript(options);
            const before = calls.length;
            let repeated;
            if (input.analysisTarget || input.ambiguousHost && !input.mode.endsWith("persistence-failure")) {
              replay = true;
              const hostCount = inspections.length;
              repeated = await runWorkflowScript(options);
              if (calls.length !== before) throw Error("Analysis was blindly redispatched");
              if (input.ambiguousHost) {
                const boundedCount = inspections.length;
                await runWorkflowScript(options);
                if (inspections.length !== boundedCount) throw Error("Failed bounded host reconstruction was blindly repeated");
                if (boundedCount <= hostCount) throw Error("Unknown host cause became a permanent veto");
              }
            }
            console.log(JSON.stringify({ value: observed.value, repeated: repeated?.value, statuses, calls, inspections,
              retained: storage.get("invoke-human-1")?.hostHalt }));
          }).catch(error => { console.error(error); process.exitCode = 1; });
      `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "private-agent") },
        stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
      try {
        child.stdin.write(JSON.stringify({ script: resolved.resource.script, children, hosts, mode, permission, analysisTarget,
          hostTarget, ambiguousHost, hostFailure: hostTarget ? hostFailure(hostTarget, hosts[hostTarget]) : null }));
        child.stdin.end();
        const [exit, output, errors] = await Promise.all([child.exited, stdout, stderr]);
        expect(errors).not.toContain("unawaited runs.run launch(es)");
        expect(exit, errors).toBe(0);
        const actual = JSON.parse(output);
        expect(actual.value).toMatchObject({ status: (expected.value as any).status, reason: (expected.value as any).reason,
          loopsConsumed: (expected.value as any).loopsConsumed });
        expect(actual.calls).toEqual(calls);
        if (ambiguousHost && !mode.endsWith("persistence-failure")) {
          expect(actual.repeated).toMatchObject({ status: "blocked", loopsConsumed: (expected.value as any).loopsConsumed });
          expect(actual.retained).toEqual(storage.get("invoke-human-1").hostHalt);
        }
        if (analysisTarget) {
          expect(actual.repeated).toMatchObject({ status: (expected.value as any).status, loopsConsumed: 2 });
          expect(actual.statuses).toContain(mode.includes("-thrown-") ? analysisTarget : `native-${analysisTarget}`);
          expect(actual.inspections.filter((key: string) => key === "inspect-loop-1")).toHaveLength(0);
        } else if (ambiguousHost && !mode.endsWith("persistence-failure")) {
          expect(actual.inspections.slice(0, inspections.length)).toEqual(inspections);
          expect(actual.inspections.length).toBeGreaterThan(inspections.length);
        } else expect(actual.inspections).toEqual(inspections);
      } finally {
        child.kill();
        await Promise.all([child.exited, stdout, stderr]);
      }
    });

  // The actual registered expansion and authorized Node admission run here;
  // model work and native child rejections remain controlled boundaries.
  test.each(["fresh", "reentry", "legacy", "interrupted-admission", "exhausted", "capacity", "stop", "permission", "active"])(
    "registered Node capacity closes host-free without an indexed grant: %s", async mode => {
      const root = repository(), nativeRoot = repository(), sessionId = randomUUID();
      const global = path.join(nativeRoot, "agent"), { missionPath, statePath } = missionFiles(nativeRoot);
      mkdirSync(global);
      const spec = assignmentSpec(root);
      const content = mode === "fresh" ? spec.content + '"'.repeat(MAX_SPEC_BYTES - Buffer.byteLength(spec.content)) : spec.content;
      writeFileSync(spec.source, content); writeFileSync(path.join(root, "owned"), "existing WIP");
      writeFileSync(path.join(global, "settings.json"), JSON.stringify({ pitako: { execute: { maxCycles: 10 } } }));
      const hooks = new Map<string, any>();
      planExecute({ on: (name: string, hook: any) => hooks.set(name, hook) } as unknown as ExtensionAPI);
      const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = global;
      try { hooks.get("session_start")({}, ctx); }
      finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
      disposers.push(() => hooks.get("session_shutdown")({}, ctx));
      const resolved = resolveWorkflowResource("pitako.execute", { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath }, sessionId);
      if (!resolved.ok) throw Error(resolved.error);
      const permit = consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script);
      if (typeof permit === "string") throw Error(permit);
      expect(permit.authority.host).toHaveLength(3);
      expect(permit.authority.host![0]!.key).toBe("inspect-initial");
      const metadata = { ...deterministicScripts, root, commonDir: spec.commonDir, selected: { source: spec.source, digest: digest(content) } };
      const harness = async (input: any, runWorkflowScript: any, respond: any, io: any) => {
          const fs = io;
          const storage=new Map<string, any>(),calls: string[]=[],hosts: string[]=[],originals=new Map<string, any>(),closings=new Map<number, any>();let checkout=input.checkout;
          if(input.mode==="legacy") storage.set("invoke-human-1",{version:2,association:{...input.metadata,invocation:"human-1"},snapshot:{content:input.content},loops:[]});
          const options={script:input.script,state:{get:(key: string)=>structuredClone(storage.get(key)),set:(key: string,value: any)=>{storage.set(key,structuredClone(value));if(value.loop?.closing)closings.set(value.loop.number,structuredClone(value.loop));}},
            status:async (key: string)=>originals.get(key),
            host:async(key: string,params: any)=>{
              if(key!==input.grant.key || params.command!==input.grant.command)throw Error("Unexpected host operation "+key);
              hosts.push(key);
              if(input.mode==="interrupted-admission")return {key,kind:"command",state:"failed",ok:false,exitCode:1,stdout:"",stderr:"Controlled admission read failed",durationMs:0};
              fs.writeFileSync(input.statePath,JSON.stringify(Object.fromEntries(storage)));
              const stdout=io.execFileSync("sh",["-c",params.command],{cwd:input.root,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
              if(Buffer.byteLength(stdout)>4096)throw Error("Invalid admission envelope");
              const receipt=JSON.parse(stdout);if(receipt.checkout)checkout=receipt.checkout;
              return {key,kind:"command",state:"passed",ok:true,exitCode:0,stdout,stderr:"",durationMs:0,outputPath:input.missionPath+".admission.log"};
            },
            launch:async(key: string,request: any)=>{
              calls.push(key);const loop=Number(key.match(/\.l(\d+)\./)?.[1]??1);
              if(loop===7 && key.endsWith(".director")){
                if(input.mode==="capacity")throw Error("Active async run capacity exhausted: 4/4 used.");
                if(input.mode==="permission")throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
                if(input.mode==="stop")return {key,ok:false,stopped:true,output:"Stopped",artifactPaths:[]};
                if(input.mode==="active")return {key,ok:true,state:"running",output:"",artifactPaths:[]};
              }
              let result;
              if(request.agent==="pitako.worker")io.captureCheckpoint(storage.get("invoke-human-1").loop.attempt.checkpoint,["owned"]);
              result=await respond(key,request,input.metadata,checkout,input.mode==="exhausted"?11:8);
              // This test owns capacity/closing accounting, not gate subprocesses.
              if(key.endsWith(".compliance"))result.structuredOutput.requirements=result.structuredOutput.requirements.slice(0,1);
              originals.set(key,result);originals.set(result.runId,result);return result;
            }};
          const first=await runWorkflowScript(options);let second;
          if(input.mode==="reentry"){
            fs.writeFileSync(input.global+"/settings.json",'{"pitako":{"execute":{"maxCycles":false}}}');
            second=await runWorkflowScript(options);
          }
          return {first:first.value,second:second?.value,calls,hosts,closings:[...closings.values()],saved:storage.get("invoke-human-1")};
      };
      const identity = checkoutEvidence(root);
      await nativeCheckpointCase({ root, global, missionPath, statePath, content, mode,
        metadata: { ...metadata, inlineLoopIO: true, inlineSealer: true }, script: resolved.resource.script,
        grant: permit.authority.host![0], checkout: { head: identity.head, fingerprint: identity.fingerprint },
        module: new URL("../extensions/execute-checkpoint.ts", import.meta.url).href,
        evidence: new URL("../extensions/spec-plans.ts", import.meta.url).href }, harness.toString(), ([exit, output, errors]) => {
        expect(exit, errors).toBe(0);
        const observed = JSON.parse(output), saved = observed.saved;
        // Final gaps alternate with repair tasks; the first final candidate after loop 8 is loop 9.
        const success = ["fresh", "reentry"].includes(mode), early = ["legacy", "interrupted-admission"].includes(mode);
        expect(observed.first).toMatchObject({ status: success ? "complete" : mode === "stop" ? "cancelled" : ["exhausted", "capacity"].includes(mode) ? "partial" : "blocked",
          loopsConsumed: early ? 0 : success ? 9 : mode === "exhausted" ? 10 : 7 });
        expect(observed.hosts).toHaveLength(mode === "legacy" ? 0 : mode === "reentry" ? 2 : 1);
        const closing = observed.closings;
        // Only final loops dispatch a closing observer; repair loops seal their task instead.
        expect(closing.map((loop: any) => loop.number)).toEqual(early ? [] : success || mode === "exhausted" ? [1, 3, 5, 7, 9] : [1, 3, 5]);
        if (!early) {
          expect(saved.association.maxCycles).toBe(10); expect(saved.association.digest).toBe(digest(content));
          expect(new Set(closing.map((loop: any) => loop.closing.ref.asyncDir)).size).toBe(closing.length);
          for (const loop of closing) {
            expect(loop.closing.ref.key).toBe(`invoke-human-1.l${loop.number}.checkout`);
            expect(loop.closing.ref.externalAdapter.outputArtifacts.stdoutPath).toBe(`/native/async/invoke-human-1.l${loop.number}.checkout/stdout.log`);
            expect(loop.closing.candidate).toEqual({ head: identity.head, fingerprint: identity.fingerprint });
          }
        }
        if (mode === "reentry") {
          expect(observed.second.status).toBe("complete");
          expect(observed.calls.filter((key: string) => key.endsWith(".checkout"))).toHaveLength(5);
        }
        if (mode === "capacity") expect(observed.first.reason).toContain("capacity exhausted");
        if (mode === "legacy") expect(observed.calls).toEqual([]);
        expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("existing WIP");
      });

    });

  test.each(["partial-association", "foreign", "partial-without-association", "legacy-conflict", "v4"])(
    "conditional initial admission never replaces incompatible retained state: %s", async mode => {
      const root = repository(), nativeRoot = repository();
    assignmentSpec(root);
      const { missionPath, statePath } = missionFiles(nativeRoot);
      const global = path.join(nativeRoot, "agent"); mkdirSync(global);
      writeFileSync(path.join(global, "settings.json"), '{"pitako":{"execute":{"maxCycles":false}}}');
      const resource = resourceWithAgentDir(global).resolve({ root, id: "assignment", invocation: "human-1",
        missionId: "native.mission-1", missionPath });
      const association = { root, missionId: "native.mission-1", missionPath, invocation: "human-1", maxCycles: 5, sourceRefs: [] };
      const retained = { version: mode === "v4" ? 4 : 6, ...(mode === "partial-without-association" ? { snapshot: { content: "partial" } } :
        { association: mode === "partial-association" ? {} : { ...association, ...(mode === "foreign" ? { missionId: "other" } : {}) } }) };
      const state: Record<string, any> = { "invoke-human-1": retained,
        ...(mode === "legacy-conflict" ? { "pitako-execution": { version: 6, association: { ...association, invocation: "other" } } } : {}) };
      const original = JSON.stringify(state); writeFileSync(statePath, original);
      const command = resource.hostCommands.find(grant => grant.key === "inspect-initial")!.command;
      // The inspector itself must not hide the conflict behind invalid settings.
      let failure = "";
      try { failure = execFileSync("sh", ["-c", command], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { failure = String((error as { stderr: unknown }).stderr); }
      expect(failure).toMatch(mode === "v4" ? /created by an incompatible Pitako contract v4; start a new mission/
        : /retained (invocation|association)|predates bound native admission/i);
      expect(failure).not.toContain("pitako.execute.maxCycles");
      const calls: string[] = [];
      const result = await runWorkflowScript({ script: resource.script,
        state: { get: key => structuredClone(state[key]), set: () => { throw Error("No association replacement permitted"); } },
        launch: async key => { calls.push(key); throw Error("No dispatch permitted"); },
        status: async () => { throw Error("No producer to reconcile"); },
        host: async key => {
          throw Error(`Conflicting request must not read settings: ${key}`);
        } });
      expect(result.value).toMatchObject({ status: "blocked", loopsConsumed: 0 });
      expect(calls).toEqual([]);
      expect(readFileSync(statePath, "utf8")).toBe(original);
    });
});

// A v6 read-only task still owns a captured checkpoint. Interrupted work uses
// checkpoint-first fallback, never a verification-kind legacy native resume.
test.each(["complete", "receipt-save-cut", "result-save-cut", "seal-save-cut", "cursor-save-cut", "pending", "pending-settled"])(
  "registered Node interrupted check continuation retains task ownership: %s", async mode => {
    const root = repository(), nativeRoot = repository(), spec = assignmentSpec(root);
    writeFileSync(path.join(root, "owned"), "Existing interrupted-unit WIP");
    const { missionPath, statePath } = missionFiles(nativeRoot);
    const { head, fingerprint } = checkoutEvidence(root), checkout = { head, fingerprint };
    const resource = resourceWithAgentDir(path.join(nativeRoot, "agent")).resolve({ root, id: "assignment", invocation: "human-1",
      missionId: "native.mission-1", missionPath });
    const metadata = { ...deterministicScripts, root, commonDir: path.join(root, ".git"), candidates: [],
      selected: { source: path.join(root, ".pitako/plans/assignment.md"), digest: digest(spec.content), chunks: 1 } };
    const child = Bun.spawn(["node", "--disable-warning=ExperimentalWarning", "-e", `
      const fs = require("node:fs"), path = require("node:path"), {pathToFileURL} = require("node:url");
      const input = JSON.parse(fs.readFileSync(0, "utf8"));
      (async () => {
        await import(pathToFileURL(input.packageRoot + "/skills/execute/loader.mjs"));
        const {runWorkflowScript} = await import(pathToFileURL(input.packageRoot + "/node_modules/pi-subagents/src/workflows/scripted-workflow.js"));
        const {captureBaseline,captureCheckpoint,restoreCheckpoint} = await import(pathToFileURL(input.packageRoot + "/extensions/execute-checkpoint.ts"));
        const loopIo = await import(pathToFileURL(input.packageRoot + "/skills/execute/loop.ts"));
        const response = eval('(' + input.response + ')');
        const storage = new Map(), calls = [], statuses = [], originals = new Map();
        let cut = input.mode.includes("cut"), pendingResult;
        const options = { script: input.script,
          state: { get: key => structuredClone(storage.get(key)), set: (key, value) => {
            storage.set(key, structuredClone(value));
            fs.writeFileSync(input.statePath, JSON.stringify(Object.fromEntries(storage)));
            const attempt = value.loop?.attempt;
            if (cut && ((attempt?.number === 2 && (
                input.mode === "receipt-save-cut" && attempt.gate?.stage === "receipt" ||
                input.mode === "result-save-cut" && attempt.stage === "result" ||
                input.mode === "seal-save-cut" && attempt.seal)) ||
                input.mode === "cursor-save-cut" && value.loop?.cursor === 1)) {
              cut = false; throw Error("Controlled continuation save cut");
            }
          } },
          launch: async (key, request) => {
            calls.push({key, resume:request.resume, agent:request.agent});
            if (request.resume) throw Error("v6 backlog task must use checkpoint-first continuation");
            let result;
            if (request.agent === "pitako.loop-io") {
              const {operation,...payload} = JSON.parse(request.task);
              if (["advance","selection","close","drain"].includes(operation)) {
                result = await response(key, request, {...input.metadata, loopIO:input.packageRoot+"/skills/execute/loop-io.mjs"}, input.checkout);
              } else {
                const value = operation === "baseline" ? captureBaseline(payload) : await loopIo[operation](payload);
                if (operation === "apply") value.view = (await loopIo.prepare({...payload,previousConfirmedUnit:null,taskId:value.selected?.id})).view;
                const {backlog,...receipt} = value;
                if (backlog) receipt.acceptance = backlog.acceptance;
                result = {key,ok:true,agent:request.agent,runId:"native-"+key,output:JSON.stringify(receipt),results:[{exitCode:0}]};
              }
            } else {
              result = await response(key, request, input.metadata, input.checkout);
              if (request.agent === "pitako.execution-director") {
                const task = {id:"repair",title:"repair",goal:"Verify authorized behavior without writes",expectedResult:"Focused verification passes",
                  status:"pending",origin:{kind:"spec",ref:input.metadata.selected.source},specRefs:[input.metadata.selected.source],
                  dependsOn:[],gates:[{id:"repair-check",command:"true",cwd:input.root,timeoutMs:30000}],metric:null,
                  parent:null,remaining:"",progress:{nonImproving:0,last5:[]},history:[]};
                result.structuredOutput = {select:"repair",changes:[{kind:"add",task,reason:"Spec requires verification"}],
                  reason:"Select remaining work",acceptance:[{id:"full",command:"true",cwd:input.root}]};
              }
              if (request.agent === "pitako.worker") {
                const task = JSON.parse(request.task.split("COMPLETE SELECTED TASK:\\n")[1].split("\\n")[0]);
                const attempt = storage.get("invoke-human-1").loop.attempt;
                if (task.id !== "repair" || attempt.taskId !== "repair") throw Error("Task ownership changed");
                if (attempt.restore) {
                  const frame = storage.get("invoke-human-1").taskFrame;
                  restoreCheckpoint(attempt.restore.sourceKeys.map(key => frame.sources.find(source => source.key === key)),attempt.restore.authority);
                }
                captureCheckpoint(attempt.checkpoint,["owned"]);
                result.structuredOutput = {work:"Verified authorized behavior",status:"complete",remaining:[],knowledge:{findings:[],handoff:""}};
                if (attempt.number === 1) result = {...result,ok:false,interrupted:true,structuredOutput:undefined,results:[]};
                else if (input.mode.startsWith("pending")) {
                  pendingResult = structuredClone(result);
                  result = {...result,ok:true,state:"running",structuredOutput:undefined,results:[]};
                  originals.set(key,result); originals.set(result.runId,result);
                  throw Error("Controlled post-launch transport loss");
                }
              }
            }
            originals.set(key,result); originals.set(result.runId,result);
            return result;
          },
          status: async ref => { statuses.push(ref); const found = originals.get(ref); if (!found) throw Error("Unknown exact native reference " + ref); return structuredClone(found); },
          host: async (key,request) => {
            const stdout = require("node:child_process").execFileSync("sh",["-c",request.command],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
            const value = JSON.parse(stdout); if (value.admission) value.admission.maxCycles = 1;
            return {key,kind:"command",ok:true,state:"passed",exitCode:0,stderr:"",durationMs:0,outputPath:"/native/"+key+".log",stdout:JSON.stringify(value)};
          },
        };
        const first = await runWorkflowScript(options);
        cut = false;
        if (input.mode === "pending-settled" && pendingResult) {
          originals.set(pendingResult.key,pendingResult); originals.set(pendingResult.runId,pendingResult);
        }
        const second = input.mode === "complete" ? null : await runWorkflowScript(options);
        const third = input.mode === "pending" ? null : await runWorkflowScript(options);
        console.log(JSON.stringify({third:third?.value,first:first.value,second:second?.value,calls,statuses,
          invocation:storage.get("invoke-human-1"),backlog:fs.existsSync(input.root+"/.pitako/backlog/assignment.json") ? JSON.parse(fs.readFileSync(input.root+"/.pitako/backlog/assignment.json","utf8")) : null}));
      })().catch(error => {console.error(error);process.exitCode=1;});
    `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(nativeRoot, "private-agent") }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
    child.stdin.write(JSON.stringify({script:resource.script,metadata,checkout,mode,root,statePath,packageRoot:path.resolve("."),response:childResponse.toString()}));
    child.stdin.end();
    const [exit, output, errors] = await Promise.all([child.exited, stdout, stderr]);
    expect(exit, errors).toBe(0);
    expect(errors).not.toContain("unawaited runs.run launch(es)");
    const observed = JSON.parse(output);
    const workers = observed.calls.filter((call: any) => call.agent === "pitako.worker");
    expect(workers.map((call: any) => call.key), JSON.stringify(observed)).toEqual(["invoke-human-1.l1.t1.a1", "invoke-human-1.l1.t1.a2"]);
    expect(observed.calls.some((call: any) => call.resume)).toBe(false);
    expect(observed.invocation.consumedLoops).toBe(1);
    expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("Existing interrupted-unit WIP");
    const gates = observed.calls.filter((call: any) => call.key.endsWith(".close"));
    if (mode === "pending") {
      expect(observed.second.status).not.toBe("complete");
      expect(observed.backlog.tasks[0].status).toBe("pending");
      expect(gates).toHaveLength(0);
    } else {
      expect((observed.second ?? observed.first).status, JSON.stringify(observed)).toBe("partial");
      expect(gates).toHaveLength(1);
      expect(observed.invocation.loop.cursor).toBe(1);
      expect(observed.backlog.tasks[0]).toMatchObject({id:"repair",status:"done"});
      expect(observed.invocation.tasks.repair.completed).toMatchObject({status:"complete",attempt:2,ref:{runId:"native-invoke-human-1.l1.t1.a2"}});
      expect(observed.third.status).toBe("partial");
    }
    expect(observed.calls.filter((call: any) => call.key.endsWith(".director"))).toHaveLength(1);
    expect(observed.calls.some((call: any) => call.key.endsWith("director-synthesis") || call.key.endsWith(".compliance"))).toBe(false);
  });

// Rejects a prompt-only resume claim or a replacement root that loses the saved
// invocation. The public native resume dispatcher and mission state remain real;
// only host checks and model-facing child responses are controlled.
test("registered Node public root resume consumes durable results and closes the same invocation", async () => {
  const root = repository(), spec = assignmentSpec(root);
  writeFileSync(path.join(root, ".git/info/exclude"), "private-agent/\nnative/\nsessions/\nartifacts/\n");
  const {head,fingerprint} = checkoutEvidence(root), candidate = {head,fingerprint};
  const child = Bun.spawn(["node", "--disable-warning=ExperimentalWarning", "-e", `
    const fs = require("node:fs"), path = require("node:path"), {pathToFileURL} = require("node:url");
    const {registerHooks, stripTypeScriptTypes} = require("node:module");
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    const base = input.packageRoot + "/node_modules/pi-subagents/src/";
    const workflowURL = pathToFileURL(fs.realpathSync(base + "workflows/scripted-workflow.js")).href;
    registerHooks({load(url, context, next) {
      if (url === workflowURL) return {format:"module", shortCircuit:true, source:
        'export * from ' + JSON.stringify(url + '?original') + '; import {runWorkflowScript as run} from ' + JSON.stringify(url + '?original') +
        '; export function runWorkflowScript(options) { return run({...options, ...globalThis.controlledBoundary}); }'};
      if (url.startsWith(pathToFileURL(input.packageRoot + "/extensions/").href) && url.endsWith(".ts"))
        return {format:"module", shortCircuit:true, source:stripTypeScriptTypes(fs.readFileSync(new URL(url), "utf8"), {sourceUrl:url})};
      return next(url, context);
    }});
    (async () => {
      const {createSubagentExecutor} = await import(pathToFileURL(base + "runs/foreground/subagent-executor.js"));
      const {runWorkflowScript} = await import(workflowURL + '?original');
      const {prepareMissionLaunch} = await import(pathToFileURL(base + "missions/lifecycle.js"));
      const {createMissionWorkflowState, missionStatePath} = await import(pathToFileURL(base + "missions/workflow-state.js"));
      const {missionRecordPath} = await import(pathToFileURL(base + "missions/store.js"));
      const {writeWorkflowLaunchRecord} = await import(pathToFileURL(base + "workflows/workflow-launch-record.js"));
      const {workflowScriptDigest} = await import(pathToFileURL(base + "workflows/workflow-reuse.js"));
      const {DIRS} = await import(pathToFileURL(base + "shared/types.js"));
      const {resolveWorkflowResource} = await import(pathToFileURL(base + "workflows/workflow-resources.js"));
      const {default: planExecute} = await import(pathToFileURL(input.packageRoot + "/extensions/plan-execute.ts"));
      const sessionId = require("node:crypto").randomUUID(), sourceId = require("node:crypto").randomUUID();
      const mission = prepareMissionLaunch({params:{mission:{title:"Controlled root resume"}}, projectRoot:input.root, ownerSessionId:sessionId});
      const missionPath = missionRecordPath(mission.location, mission.missionId);
      const statePath = missionStatePath(mission.location, mission.missionId);
      const args = {root:input.root, id:"assignment", invocation:"human-1", missionId:mission.missionId, missionPath};
      const hooks = new Map(), ctx = {cwd:input.root, sessionManager:{getSessionId:()=>sessionId, getSessionFile:()=>null}, hasUI:false};
      planExecute({on:(name, hook)=>hooks.set(name, hook), events:{emit:(_name, request)=>{request.result={ok:true,registration:{dispose(){}}};}}});
      hooks.get("session_start")({},ctx);
      const resolved = resolveWorkflowResource("pitako.execute", args, sessionId);
      if (!resolved.ok) throw Error(resolved.error);
      const script = resolved.resource.script, calls = [], content = input.content;
      const metadata = {root:input.root, commonDir:path.join(input.root,".git"), candidates:[],
        verifier:input.packageRoot + "/extensions/access-receipts.mjs", sealer:input.packageRoot + "/skills/execute/checkpoint.mjs",
        selected:{source:path.join(input.root,".pitako/plans/assignment.md"), digest:input.digest, chunks:1}};
      const response = eval('(' + input.response + ')');
      const {captureBaseline,captureCheckpoint} = await import(pathToFileURL(input.packageRoot + "/extensions/execute-checkpoint.ts"));
      await import(pathToFileURL(input.packageRoot + "/skills/execute/loader.mjs"));
      const loopIo = await import(pathToFileURL(input.packageRoot + "/skills/execute/loop.ts"));
      const originals = new Map();
      const boundary = {
        resolveResume:async ref=>{if (!originals.has(ref)) throw Error("Unknown controlled child " + ref); return ref;},
        launch:async (key, request)=>{
          calls.push(key);
          let result;
          if (request.agent === "pitako.loop-io") {
            const {operation,...payload} = JSON.parse(request.task);
            if (["advance","selection","close","drain"].includes(operation)) {
              result = await response(key, request, {...metadata, loopIO:input.packageRoot+"/skills/execute/loop-io.mjs"}, input.checkout);
            } else {
              const value = operation === "baseline" ? captureBaseline(payload) : await loopIo[operation](payload);
              if (operation === "apply") value.view = (await loopIo.prepare({...payload,previousConfirmedUnit:null,taskId:value.selected?.id})).view;
              const {backlog,...receipt} = value;
              if (backlog) receipt.acceptance = backlog.acceptance;
              const output = JSON.stringify(receipt);
              result = {key,ok:true,agent:request.agent,runId:"native-"+key,output,results:[{exitCode:0,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,turns:0}}]};
            }
          } else {
            result = await response(key, request, metadata, input.checkout);
            if (request.agent === "pitako.execution-director") {
              const exists = fs.existsSync(path.join(input.root,".pitako/backlog/assignment.json"));
              const task = {id:"unit",title:"unit",goal:"Verify authorized behavior",expectedResult:"Focused verification passes",
                status:"pending",origin:{kind:"spec",ref:metadata.selected.source},specRefs:[metadata.selected.source],
                dependsOn:[],gates:[{id:"unit-check",command:"true",cwd:input.root,timeoutMs:30000}],metric:null,
                parent:null,remaining:"",progress:{nonImproving:0,last5:[]},history:[]};
              result.structuredOutput = {select:exists?null:"unit",changes:exists?[]:[{kind:"add",task,reason:"Spec requires verification"}],
                reason:"Select remaining work",...(!exists?{acceptance:[{id:"full",command:"true",cwd:input.root}]}:{})};
            }
            if (request.agent === "pitako.worker") {
              captureCheckpoint(state.get("invoke-human-1").loop.attempt.checkpoint,["owned"]);
              result.structuredOutput = {work:"Verified authorized behavior",status:"complete",remaining:[],knowledge:{findings:[],handoff:""}};
            }
          }
          for (const entry of result.results ?? []) entry.usage ??= {input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,turns:0};
          originals.set(key,result); originals.set(result.runId,result);
          return result;
        },
        status:async ref=>{const result = originals.get(ref); if (!result) throw Error("Unexpected retained query " + ref); return structuredClone(result);},
        host:async key=>({key,kind:"command",ok:true,state:"passed",exitCode:0,stderr:"",durationMs:0,outputPath:"/controlled/"+key+".log",
          stdout:JSON.stringify({version:1,binding:input.binding,checkout:input.checkout,admission:{maxCycles:1}})}),
      };
      const state = createMissionWorkflowState(mission.location, mission.missionId);
      let cut = false;
      const seeded = await runWorkflowScript({script, ...boundary, state:{get:key=>state.get(key),set:(key,value)=>{
        state.set(key,value);
        if (!cut && value.loop?.attempt?.stage === "result") {cut=true;throw Error("Controlled root interruption after durable result");}
      }}});
      if (!cut) throw Error("Did not reach durable cut: " + JSON.stringify(seeded.value));
      const before = JSON.parse(fs.readFileSync(statePath,"utf8"))["invoke-human-1"];
      const params = {workflow:"pitako.execute",args,cwd:input.root,async:true,missionId:mission.missionId};
      const sourceDir = path.join(DIRS.async,sourceId);
      fs.mkdirSync(sourceDir,{recursive:true});
      fs.writeFileSync(path.join(sourceDir,"status.json"),JSON.stringify({runId:sourceId,sessionId,mode:"workflow",state:"stopped",cwd:input.root,
        workflow:{scriptDigest:workflowScriptDigest(script),stopCause:"owner-exited"}}));
      writeWorkflowLaunchRecord(sourceDir,{version:1,source:"resource",params,scriptDigest:workflowScriptDigest(script)});
      let settle;
      const settled = new Promise(resolve=>settle=resolve);
      globalThis.controlledBoundary = {...boundary};
      // Observe settlement without replacing the executor's native state adapter.
      const nativeState = {asyncJobs:new Map(),foregroundRuns:new Map(),foregroundControls:new Map(),currentSessionId:sessionId};
      const pi = {sendMessage:()=>{},events:{emit:()=>{}}};
      const executor = createSubagentExecutor({pi,state:nativeState,config:{defaultSessionDir:path.join(input.root,"sessions")},asyncByDefault:true,
        tempArtifactsDir:path.join(input.root,"artifacts"),getSubagentSessionRoot:()=>path.join(input.root,"sessions"),expandTilde:p=>p,
        discoverAgents:()=>({agents:[]}),refreshResultDelivery:()=>{
          const claim = JSON.parse(fs.readFileSync(path.join(sourceDir,"resumed-by.1.json"),"utf8"));
          const file = path.join(DIRS.async,claim.newRunId,"status.json");
          if (fs.existsSync(file) && ["complete","failed","stopped"].includes(JSON.parse(fs.readFileSync(file,"utf8")).state)) settle();
        }});
      const resumed = await executor.executePublic("public-resume",{action:"resume",id:sourceId},new AbortController().signal,undefined,ctx);
      if (resumed.isError) throw Error(JSON.stringify(resumed));
      await settled;
      const claim = JSON.parse(fs.readFileSync(path.join(sourceDir,"resumed-by.1.json"),"utf8"));
      const successor = JSON.parse(fs.readFileSync(path.join(DIRS.async,claim.newRunId,"status.json"),"utf8"));
      const final = JSON.parse(fs.readFileSync(statePath,"utf8"))["invoke-human-1"];
      const again = await executor.executePublic("public-resume-again",{action:"resume",id:sourceId},new AbortController().signal,undefined,ctx);
      hooks.get("session_shutdown")({},ctx);
      console.log(JSON.stringify({before,final,calls,resumed,again,sourceId,successor,claim,backlog:JSON.parse(fs.readFileSync(path.join(input.root,".pitako/backlog/assignment.json"),"utf8")),seeded:seeded.value}));
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root,"private-agent"), PI_SUBAGENTS_TEMP_ROOT:path.join(root,"native") }, stdin:"pipe",stdout:"pipe",stderr:"pipe" });
  const lifecycle = checkpointLifecycle(child, ([exit, output, errors]) => {
    expect(exit,errors).toBe(0);
    expect(errors).not.toContain("unawaited runs.run launch(es)");
    const observed = JSON.parse(output);
    expect(observed.before.loop.attempt.stage).toBe("result");
    // One task consumes the frozen slot; final acceptance belongs to a later loop.
    expect(observed.final.loop.outcome).toBe("gaps");
    expect(observed.final.association.maxCycles).toBe(1);
    expect(observed.successor.state, observed.successor.error).toBe("complete");
    expect(observed.successor.workflow.value.invocation).toBe("human-1");
    expect(observed.successor.workflow.value.loopsConsumed).toBe(1);
    expect(observed.final.consumedLoops).toBe(1);
    expect(observed.final.loop.cursor).toBe(1);
    expect(observed.calls.filter((key:string)=>key.endsWith(".t1.a1"))).toHaveLength(1);
    expect(observed.calls.filter((key:string)=>key.endsWith("director-synthesis"))).toHaveLength(0);
    expect(observed.calls.filter((key:string)=>key.endsWith(".compliance"))).toHaveLength(0);
    expect(observed.successor.workflow.resumeOrigin).toMatchObject({sourceRunId:observed.sourceId,attempt:1});
    expect(observed.successor.workflow.value.status).toBe("partial");
    expect(observed.backlog.tasks[0]).toMatchObject({id:"unit",status:"done"});
    expect(observed.calls.filter((key:string)=>key.endsWith(".close"))).toHaveLength(1);
    expect(observed.again.isError).toBe(true);
    expect(JSON.stringify(observed.again.content)).toContain(observed.claim.newRunId);
  });
  try {
    child.stdin.write(JSON.stringify({packageRoot:path.resolve("."),root,response:childResponse.toString(),checkout:candidate,digest:digest(spec.content),content:spec.content,binding:spec.binding}));
    child.stdin.end();
    await lifecycle.result;
  } finally {
    lifecycle.cancel();
    await lifecycle.settled;
  }
  // Cold Node/SDK loading measured ~2.5s, plus ~2s for durable seed and public resume.
}, 10000);
