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

const composition = compositionFixture();
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
      const metadata = { root, commonDir: path.join(root, ".git"), selected: { source: path.join(root, ".pitako/plans/assignment.md"), digest: digest(content) } };
      const script = resource.resource.script;
      const input = { mode, root, nativeRoot, missionPath, statePath, metadata, script,
        toolModule: path.resolve("extensions/checkpoint-create.ts"),
        loaderModule: new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url).href,
        grants: permit.authority.host, checkpointModule: new URL("../extensions/execute-checkpoint.ts", import.meta.url).href, evidenceModule: new URL("../extensions/spec-plans.ts", import.meta.url).href };
      const harness = async (input: any, run: typeof runWorkflowScript, response: typeof childResponse, io: any, loadCheckpoint: typeof registeredCheckpoint) => {
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
            const value = JSON.parse(stdout); if (value.checkpoint) observations.push(value.checkpoint);
            if (value.checkpointObservation) witnesses.push(value.checkpointObservation);
            return { key, kind: "command", state: "passed", ok: true, exitCode: 0, stdout, stderr: "", durationMs: 0, outputPath: input.nativeRoot + "/" + key + ".log" };
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
            if (request.resume && key.includes(".t1.")) throw Error("Non-resumable producer must not be resumed");
            if (key.endsWith(".director")) return director(key);
            if (request.agent === "pitako.execution-inspector") throw Error("Checkpoint recovery must not require an inspector chain");
            // Only final checks/compliance consume the candidate; restored unit
            // results get their actual post-write identity below.
            const needsCandidate = request.agent === "pitako.checkout-observer" || key.endsWith(".compliance") || request.agent === "pitako.worker" && key.includes(".t2.");
            const result = response(key, request, input.metadata, needsCandidate ? candidate() : undefined);
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
                git: { head: candidate().head, checkpoints: [], wip: "Foreign bytes retained" } } }; }
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
              const checkpointReceipt = (await checkpoint("unit")).checkpointReceipt;
              const current = candidate();
              Object.assign(result.structuredOutput, { taskId: "unit", attempt: attempt.number, candidate: current, checkpointReceipt,
                restoreReceipt: { checkpointRef: restored.checkpointRef, digest: restored.digest,
                  partialRef: restored.partialRef, restoredRef: restored.partialRef.replace("restore.json", "restored.json"),
                  position: restored.position, candidate: { head: restored.candidate.head, fingerprint: restored.candidate.fingerprint } },
                git: { head: current.head, checkpoints: [checkpointReceipt.checkpointRef, restored.partialRef, restored.checkpointRef, restored.partialRef.replace("restore.json", "restored.json")], wip: "Earlier WIP preserved" } });
              result.structuredOutput.checks = [{ id: "unit-check", command: "bun test affected", cwd: input.root,
                output: "Controlled current check", logPaths: [], result: "passed", before: current, after: current }];
            }
            if (input.mode === "missing-receipt" && key.endsWith(".t1.a2")) delete result.structuredOutput.restoreReceipt;
            return result;
          },
        };
        function director(key: string) {
          const result = response(key.replace(/^native-/, ""), { agent: "pitako.execution-director" }, input.metadata, undefined);
          result.structuredOutput.association.missionPath = input.missionPath;
          const unit = structuredClone(result.structuredOutput.tasks[0]);
          Object.assign(unit, { id: "unit", kind: "implementation", scope: ["owned"], allowedEffects: ["Modify owned pending unit"] });
          unit.checks[0].id = "unit-check"; result.structuredOutput.tasks.unshift(unit);
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
        expect(actual.third ?? actual.second ?? actual.first).toMatchObject({ status: success ? "complete" : mode === "observer-capacity" ? "partial" : ["stop", "current-stop", "retained-stop", "retained-stop-new-stop"].includes(mode) ? "cancelled" : "blocked", loopsConsumed: 1 });
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
        expect(actual.retained.association.maxCycles).toBe(3);
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
          expect(actual.calls).toContain("invoke-human-1.l1.t2.a1"); expect(actual.calls).toContain("invoke-human-1.l1.compliance");
          expect(actual.calls.some((key: string) => key.includes(".review."))).toBe(true);
          const repeat = ["dispatch-intention-cut", "successor-capture-cut"].includes(mode);
          expect(actual.archives.at(-1).body.frame.operations).toHaveLength(repeat ? 2 : 1);
          expect(actual.retained.taskFrame).toBeNull();
          expect(actual.retained.loop.results.map((entry: any) => [entry.taskId, entry.attempt])).toEqual([["unit", repeat ? 3 : 2], ["final", 1]]);
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
        if (mode === "corrupt-successor") expect(actual.owned).toBe("partial successor work");
      }
    });

  test("checkpoint intention persistence failure prevents modifying dispatch", async () => {
    const root = repository();
    const content = `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.\n`).join("\n")}`;
    const metadata = { root, commonDir: path.join(root, ".git"),
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
        return childResponse(key, request, metadata, checkout);
      },
      status: async () => { throw Error("No status query expected before modifying dispatch"); },
    });
    workflowSettlements.push(operation.then(() => {}, () => {}));
    const result = await operation;
    expect((result.value as any).status).toBe("partial");
    expect((result.value as any).reason).toContain("persistence");
    expect(calls).toEqual(["invoke-human-1.l1.director"]);
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
    const metadata = { root, commonDir: path.join(root, ".git"), selected: { source, digest: digest(content) } };
    const resource = resourceWithAgentDir(path.join(nativeRoot, "agent")).resolve({
      root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath });
    const grants = new Map(resource.hostCommands.map(grant => [grant.key, grant.command]));
    const storage = new Map<string, any>(), calls: string[] = [];
    let intention: any, checkpointRef = "", beforeRestore: any, restoreReceipt: any, archivedFrame: any;
    const observedCandidate = () => { const { head, fingerprint } = checkoutEvidence(root); return { head, fingerprint }; };
    const helper = path.resolve("skills/execute/checkpoint.mjs"), request = path.join(nativeRoot, "request.json");
    const invoke = (operation: string, data: any) => {
      writeFileSync(request, JSON.stringify(data));
      return execFileSync("node", [helper, operation, request], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };
    const operation = runWorkflowScript({ script: resource.script,
      state: { get: (key: string) => structuredClone(storage.get(key)), set: (key: string, value: any) => { storage.set(key, structuredClone(value)); } },
      status: async key => {
        if (observation === "unavailable") throw Error("Public status unavailable");
        return { key, ok: false, output: observation === "inconclusive" ? "No current writer inventory" : "", artifactPaths: [] };
      },
      host: async (key: string) => ({ key, kind: "command" as const, state: "passed" as const, ok: true, exitCode: 0,
        stdout: execFileSync("sh", ["-c", grants.get(key)!], { cwd: root, encoding: "utf8" }),
        stderr: "", outputPath: path.join(nativeRoot, key + ".log"), durationMs: 0 }),
      launch: async (key: string, request: any) => {
        calls.push(key);
        if (request.agent === "pitako.execution-ledger") archivedFrame = JSON.parse(request.task).record.body.frame;
        if (request.agent === "pitako.worker" && request.resume) return { key, ok: false, output: "Controlled native resume unavailable",
          error: "Controlled native resume unavailable", artifactPaths: [] };
        const response = childResponse(key, request, metadata, observedCandidate());
        if (key.endsWith(".director")) {
          response.structuredOutput.association.missionPath = missionPath;
          const unit = structuredClone(response.structuredOutput.tasks[0]);
          Object.assign(unit, { id: "unit", kind: "implementation", scope: ["owned", "deleted", "new"],
            allowedEffects: ["Modify only unit paths"], expectedResult: "Recoverable unit" });
          unit.checks[0].id = "unit-check";
          response.structuredOutput.tasks.unshift(unit);
        }
        if (request.agent === "pitako.worker" && key.includes(".t1.")) {
          const descriptor = JSON.parse(request.task.split("FROZEN ATTEMPT:\n")[1].split("\n")[0]);
          if (descriptor.restore) {
            expect(descriptor.restore.authority.activeWriter).toBeNull();
            restoreReceipt = JSON.parse(invoke("restore", { intent: descriptor.restore.sourceKeys.map((key: string) => storage.get("invoke-human-1").taskFrame.sources.find((source: any) => source.key === key)), authority: descriptor.restore.authority }));
            expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("valid prior WIP");
            expect(readFileSync(path.join(root, "deleted"), "utf8")).toBe("prior deletion target");
            expect(existsSync(path.join(root, "new"))).toBe(false);
            expect(readFileSync(path.join(root, "earlier"), "utf8")).toBe("valid earlier WIP");
            invoke("capture", { intent: descriptor.checkpoint, paths: ["owned"] });
            invoke("apply", { intent: descriptor.checkpoint, changes: [
              { path: "owned", image: { bytes: Buffer.from("completed pending work").toString("base64"), mode: 420 } },
            ] });
            const checkpointReceipt = JSON.parse(invoke("seal", { intent: descriptor.checkpoint, kind: "unit", controlPermitsCapture: true }));
            const current = observedCandidate();
            Object.assign(response.structuredOutput, { taskId: "unit", attempt: descriptor.number, candidate: current,
              checkpointReceipt, restoreReceipt: { ...restoreReceipt, restoredRef: path.join(path.dirname(restoreReceipt.checkpointRef), "restored.json") },
              git: { head: current.head, checkpoints: [checkpointReceipt.checkpointRef, restoreReceipt.checkpointRef, restoreReceipt.partialRef, path.join(path.dirname(restoreReceipt.checkpointRef), "restored.json")], wip: "Recovered pending work" },
              checks: [{ id: "unit-check", command: "bun test affected", cwd: root, output: "Controlled current check", logPaths: [], result: "passed", before: current, after: current }] });
            return response;
          }
          const stored = structuredClone(storage.get("invoke-human-1"));
          intention = stored.loop.attempt.checkpoint;
          expect(intention).toMatchObject({ taskId: "unit", loop: 1, cursor: 0, phase: "implementation" });
          expect(intention.association).toEqual(stored.association);
          expect(request.task).toContain(JSON.stringify(intention));
          expect(request.task).toContain(helper);
          const captured = JSON.parse(invoke("capture", { intent: intention, paths: ["owned", "deleted", "new"] }));
          checkpointRef = path.join(captured.directory, "manifest.json");
          expect(existsSync(checkpointRef)).toBe(true);
          expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("valid prior WIP");
          invoke("apply", { intent: intention, changes: [
            { path: "owned", image: { bytes: Buffer.from("interrupted partial").toString("base64"), mode: 420 } },
            { path: "deleted", image: null },
            { path: "new", image: { bytes: Buffer.from("interrupted new").toString("base64"), mode: 420 } },
          ] });
          beforeRestore = stored;
          // Controlled settled external interruption; no worker result admitted.
          const missingResult = ["absent-result", "failed-result"].includes(observation);
          return { ...response, ok: observation === "absent-result", interrupted: !missingResult, structuredOutput: undefined,
            error: missingResult ? "Controlled unit returned without a complete result" : "controlled interrupted unit" };
        }
        return response;
      },
    });
    workflowSettlements.push(operation.then(() => {}, () => {}));
    const completed = await operation;
    expect((completed.value as any).status, (completed.value as any).reason).toBe("complete");
    expect(calls.filter(key => key.endsWith(".resume"))).toHaveLength(0);
    expect(calls.filter(key => key.includes(".recover"))).toHaveLength(0);
    const persisted = structuredClone(storage.get("invoke-human-1"));
    expect(restoreReceipt.position).toEqual({ loop: 1, cursor: 0, phase: "implementation" });
    expect(restoreReceipt.checkpointRef).toBe(checkpointRef);
    expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("completed pending work");
    expect(readFileSync(path.join(root, "deleted"), "utf8")).toBe("prior deletion target");
    expect(existsSync(path.join(root, "new"))).toBe(false);
    expect(readFileSync(path.join(root, "earlier"), "utf8")).toBe("valid earlier WIP");
    expect(persisted.association).toEqual(beforeRestore.association);
    expect(persisted.consumedLoops).toBe(1);
    expect(persisted.loop.cursor).toBe(2);
    expect(persisted.loop.results.filter((result: any) => persisted.tasks[result.taskId].completed?.attempt === result.attempt)).toHaveLength(2);
    expect(archivedFrame.sources.find((source: any) => source.key === intention.key)).toEqual(intention);
    expect(persisted.taskFrame).toBeNull();
    expect(calls.filter(key => /\.t\d+\.a\d+$/.test(key))).toHaveLength(3);
    expect(calls).toContain("invoke-human-1.l1.t2.a1");
    expect(calls).toContain("invoke-human-1.l1.review.director-synthesis");
    expect(calls).toContain("invoke-human-1.l1.compliance");
    expect(resource.hostCommands).toHaveLength(3);
  });

  test.each(["complete", "recovered", "unresolved-plan", "rejected-plan", "needs-decision", "mismatched-association", "stopped", "permission",
    "analysis-prepare-stop", "analysis-prepare-permission", "analysis-later-stop", "analysis-later-permission",
    "analysis-compliance-stop", "analysis-compliance-permission", "analysis-prepare-thrown-permission",
    "host-opening-stop", "host-opening-identical-failure",
    "host-opening-timeout", "host-opening-command-failure", "host-opening-similar-text", "host-opening-persistence-failure"])(
    "registered Node root settles native calls without changing the %s outcome", async mode => {
      const root = repository(), spec = assignmentSpec(root);
      const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
      planExecute({ on: (name: string, hook: (event: unknown, context: unknown) => unknown) => { hooks.set(name, hook); } } as unknown as ExtensionAPI);
      const sessionId = randomUUID(), ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
      hooks.get("session_start")!({}, ctx);
      disposers.push(() => hooks.get("session_shutdown")!({}, ctx));
      const args = { root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath: "/native/actual-mission.json" };
      const resolved = resolveWorkflowResource("pitako.execute", args, sessionId);
      if (!resolved.ok) throw Error(resolved.error);
      const content = spec.content;
      const metadata = { root, commonDir: path.join(root, ".git"), candidates: [],
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
      const analysisTarget = !mode.startsWith("analysis-") ? null : `invoke-human-1.l1.${mode.includes("-prepare-")
        ? "review.director-prepare" : mode.includes("-later-") ? "review.independent-a" : "compliance"}`;
      const expected = await runWorkflowScript({ script: resolved.resource.script,
        state: { get: key => structuredClone(storage.get(key)), set: (key, value) => {
          if (mode.endsWith("persistence-failure") && (value as any).hostHalt) throw Error("Controlled essential persistence failure");
          storage.set(key, structuredClone(value));
        } },
        launch: async (key, request) => {
          calls.push(key);
          if (request.agent === "pitako.checkout-observer") publications.push(JSON.parse(String(request.task)));
          const response = request.agent === "pitako.execution-inspector"
            ? { key, ok: true, output: "", runId: `native-${key}`, agent: request.agent, artifactPaths: [],
              structuredOutput: { status: "recovered", reason: "Exact settled original recovered without edits",
                original: null, workerResult: structuredClone(recoveredWorker), originalAvailable: true,
                binding: "absent", comparison: "only-original", provenance: ["/native/original-worker.json"] } }
            : childResponse(key, request, metadata, checkout, mode === "recovered" ? 1 : 2);
          if (request.agent === "pitako.worker" && ["complete", "recovered"].includes(mode)) {
            const value = response.structuredOutput;
            value.checks.push(
              { ...structuredClone(value.checks[0]), id: "unknown-history", result: "failed", before: null, after: null },
              { ...structuredClone(value.checks[0]), id: "uncaptured-history", result: "not-run",
                before: { head: "not-captured", fingerprint: "temporary-defect" },
                after: { head: "not-captured", fingerprint: "restored" } },
            );
            const schema = request.outputSchema as TSchema;
            expect(validateToolArguments({ name: "worker_result", description: "Result", parameters: schema },
              { type: "toolCall", id: "worker", name: "worker_result", arguments: value })).toEqual(value);
            if (mode === "recovered") {
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
          if (key.endsWith(".director") && mode !== "unresolved-plan") {
            const plan = response.structuredOutput;
            const schema = request.outputSchema as TSchema & { properties: { association: { const: unknown } } };
            expect(schema.properties.association.const).toEqual(plan.association);
            expect(plan.association).toEqual({
              root, invocation: args.invocation, missionId: args.missionId, missionPath: args.missionPath,
              loop: Number(key.match(/\.l(\d+)\./)![1]), commonDir: metadata.commonDir,
              source: metadata.selected.source, digest: metadata.selected.digest, maxCycles: 3, sourceRefs: [],
            });
            const tool = { name: "loop_plan", description: "Plan", parameters: schema };
            const validate = (value: any) => validateToolArguments(tool, { type: "toolCall", id: "plan", name: tool.name, arguments: value });
            expect(validate(plan)).toEqual(plan);
            for (const [field, value] of Object.entries(plan.association)) {
              const changed = structuredClone(plan);
              changed.association[field] = typeof value === "number" ? value + 1 : Array.isArray(value) ? [{ path: "/wrong", digest: "f".repeat(64) }] : "/wrong";
              expect(() => validate(changed)).toThrow();
            }
            if (mode === "needs-decision") Object.assign(plan, { status: "needs-decision", reason: "Controlled product decision", tasks: [] });
            if (mode === "mismatched-association") plan.association.missionPath = "/wrong";
            if (mode === "rejected-plan") {
              if (plan.association.loop === 1) plan.tasks[0].dependsOn = [{ taskId: "missing", reason: "Requires missing output" }];
              else {
                expect(storage.get("invoke-human-1").planRejections).toEqual([{ loop: 1, diagnostic: expect.stringContaining("loop_plan dependencies require") }]);
                expect(request.task).toContain("VERIFIED RETAINED LOOP SUMMARIES");
                expect(request.task).toContain("loop_plan dependencies require");
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
        status: async () => { if (mode === "unresolved-plan") return { key: "director", ok: true, output: "", artifactPaths: [] }; throw Error("No recovery expected"); },
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
      expect(expected.value).toMatchObject({ status: ["complete", "recovered", "rejected-plan"].includes(mode) || recoveredHost ? "complete" : mode === "stopped" || mode.endsWith("-stop") ? "cancelled" : "blocked",
        ...hostTarget && !recoveredHost ? { status: "blocked" } : {},
        loopsConsumed: recoveredHost ? 2 : hostTarget && hostTarget !== "inspect-loop-1" ? 0 : ["complete", "rejected-plan"].includes(mode) ? 2 : 1 });
      expect(calls).toHaveLength(analysisTarget ? mode.includes("-prepare-") ? 3 : mode.includes("-later-") ? 5 : 7
        : recoveredHost ? 17 : hostTarget ? hostTarget === "inspect-loop-1" ? 7 : 0
        : mode === "complete" ? 17 : mode === "recovered" ? 9 : mode === "rejected-plan" ? 10 : ["stopped", "permission", "unresolved-plan"].includes(mode) ? 2 : 1);
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
        expect(calls).toEqual(["invoke-human-1.l1.director", "invoke-human-1.l1.recover1"]);
      }
      if (mode === "recovered") {
        const recovered = storage.get("invoke-human-1").loop;
        expect(publications[0].body.record.body.recoveries[0]).toMatchObject({ stage: "observed", disposition: "recovered" });
        expect(storage.get("invoke-human-1").tasks.final.completed.checks).toMatchObject({ current: true, failed: 1, notRun: 1 });
        expect(calls.filter(key => key.includes(".recover"))).toHaveLength(1);
        expect(calls.indexOf("invoke-human-1.l1.review.director-prepare")).toBeGreaterThan(calls.indexOf("invoke-human-1.l1.recover1"));
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
              launch: async key => {
                calls.push(key);
                if (!input.children[key]) throw Error("Unexpected child " + key);
                if (input.mode === "permission" && input.children[key].agent === "pitako.worker") throw Error(input.permission);
                if (!replay && key === input.analysisTarget && input.mode.includes("-thrown-")) throw Error(input.permission);
                // A replacement is prepared to succeed. Replay must not call it.
                if (replay) return { ...structuredClone(input.children[key]), ok: true, stopped: false, error: undefined };
                return structuredClone(input.children[key]);
              },
              status: async ref => {
                statuses.push(ref);
                if (input.analysisTarget) {
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
          expect(actual.repeated).toMatchObject({ status: (expected.value as any).status, loopsConsumed: 1 });
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
      const metadata = { root, commonDir: spec.commonDir, selected: { source: spec.source, digest: digest(content) } };
      const child = Bun.spawn(["node", "--disable-warning=ExperimentalWarning", "-e", `
        (async()=>{
          const fs=require("node:fs"),cp=require("node:child_process");
          const input=JSON.parse(fs.readFileSync(0,"utf8"));
          const {runWorkflowScript}=await import(input.runner);
          const respond=eval("("+input.response+")");
          const storage=new Map(),calls=[],hosts=[],originals=new Map(),closings=new Map();let checkout=input.checkout;
          if(input.mode==="legacy") storage.set("invoke-human-1",{version:2,association:{...input.metadata,invocation:"human-1"},snapshot:{content:input.content},loops:[]});
          const options={script:input.script,state:{get:key=>structuredClone(storage.get(key)),set:(key,value)=>{storage.set(key,structuredClone(value));if(value.loop?.closing)closings.set(value.loop.number,structuredClone(value.loop));}},
            status:async key=>originals.get(key),
            host:async(key,params)=>{
              if(key!==input.grant.key || params.command!==input.grant.command)throw Error("Unexpected host operation "+key);
              hosts.push(key);
              if(input.mode==="interrupted-admission")return {key,kind:"command",state:"failed",ok:false,exitCode:1,stdout:"",stderr:"Controlled admission read failed",durationMs:0};
              fs.writeFileSync(input.statePath,JSON.stringify(Object.fromEntries(storage)));
              const stdout=cp.execFileSync("sh",["-c",params.command],{cwd:input.root,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
              if(Buffer.byteLength(stdout)>4096)throw Error("Invalid admission envelope");
              const receipt=JSON.parse(stdout);if(receipt.checkout)checkout=receipt.checkout;
              return {key,kind:"command",state:"passed",ok:true,exitCode:0,stdout,stderr:"",durationMs:0,outputPath:input.missionPath+".admission.log"};
            },
            launch:async(key,request)=>{
              calls.push(key);const loop=Number(key.match(/\\.l(\\d+)\\./)?.[1]??1);
              if(loop===7 && key.endsWith(".director")){
                if(input.mode==="capacity")throw Error("Active async run capacity exhausted: 4/4 used.");
                if(input.mode==="permission")throw Error("Blocked by pi-subagents permission rule: 'run' is denied.");
                if(input.mode==="stop")return {key,ok:false,stopped:true,output:"Stopped",artifactPaths:[]};
                if(input.mode==="active")return {key,ok:true,state:"running",output:"",artifactPaths:[]};
              }
              const result=respond(key,request,input.metadata,checkout,input.mode==="exhausted"?11:8);
              if(key.endsWith(".director"))result.structuredOutput.association=JSON.parse(request.task.split("ASSOCIATION (data): ")[1].split("\\n")[0]);
              originals.set(key,result);originals.set(result.runId,result);return result;
            }};
          const first=await runWorkflowScript(options);let second;
          if(input.mode==="reentry"){
            fs.writeFileSync(input.global+"/settings.json",'{"pitako":{"execute":{"maxCycles":false}}}');
            second=await runWorkflowScript(options);
          }
          console.log(JSON.stringify({first:first.value,second:second?.value,calls,hosts,closings:[...closings.values()],saved:storage.get("invoke-human-1")}));
        })().catch(error=>{console.error(error);process.exitCode=1;});
      `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: global }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const identity = checkoutEvidence(root);
      const lifecycle = checkpointLifecycle(child, ([exit, output, errors]) => {
        expect(exit, errors).toBe(0);
        const observed = JSON.parse(output), saved = observed.saved;
        const success = ["fresh", "reentry"].includes(mode), early = ["legacy", "interrupted-admission"].includes(mode);
        expect(observed.first).toMatchObject({ status: success ? "complete" : mode === "stop" ? "cancelled" : ["exhausted", "capacity"].includes(mode) ? "partial" : "blocked",
          loopsConsumed: early ? 0 : success ? 8 : mode === "exhausted" ? 10 : 7 });
        expect(observed.hosts).toHaveLength(mode === "legacy" ? 0 : mode === "reentry" ? 2 : 1);
        const closing = observed.closings;
        expect(closing).toHaveLength(early ? 0 : success ? 8 : mode === "exhausted" ? 10 : 6);
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
          expect(observed.calls.filter((key: string) => key.endsWith(".checkout"))).toHaveLength(8);
        }
        if (mode === "capacity") expect(observed.first.reason).toContain("capacity exhausted");
        if (mode === "legacy") expect(observed.calls).toEqual([]);
        expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("existing WIP");
      });
      try {
        child.stdin.write(JSON.stringify({ root, global, missionPath, statePath, content, mode, metadata,
          script: resolved.resource.script, grant: permit.authority.host![0], checkout: { head: identity.head, fingerprint: identity.fingerprint },
          response: childResponse.toString(), runner: new URL("../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href }));
        child.stdin.end(); await lifecycle.result;
      } finally { lifecycle.cancel(); await lifecycle.settled; }
    });

  test.each(["partial-association", "foreign", "partial-without-association", "legacy-conflict"])(
    "conditional initial admission never replaces incompatible retained state: %s", async mode => {
      const root = repository(), nativeRoot = repository();
    assignmentSpec(root);
      const { missionPath, statePath } = missionFiles(nativeRoot);
      const global = path.join(nativeRoot, "agent"); mkdirSync(global);
      writeFileSync(path.join(global, "settings.json"), '{"pitako":{"execute":{"maxCycles":false}}}');
      const resource = resourceWithAgentDir(global).resolve({ root, id: "assignment", invocation: "human-1",
        missionId: "native.mission-1", missionPath });
      const association = { root, missionId: "native.mission-1", missionPath, invocation: "human-1", maxCycles: 5, sourceRefs: [] };
      const retained = { version: 3, ...(mode === "partial-without-association" ? { snapshot: { content: "partial" } } :
        { association: mode === "partial-association" ? {} : { ...association, ...(mode === "foreign" ? { missionId: "other" } : {}) } }) };
      const state: Record<string, any> = { "invoke-human-1": retained,
        ...(mode === "legacy-conflict" ? { "pitako-execution": { version: 2, association } } : {}) };
      const original = JSON.stringify(state); writeFileSync(statePath, original);
      const command = resource.hostCommands.find(grant => grant.key === "inspect-initial")!.command;
      // The inspector itself must not hide the conflict behind invalid settings.
      let failure = "";
      try { failure = execFileSync("sh", ["-c", command], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { failure = String((error as { stderr: unknown }).stderr); }
      expect(failure).toMatch(/retained (invocation|association)|predates bound native admission/i);
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

// Rejects abandoning a pending successor, replaying an admitted writer, or
// declaring completion without the following task and final analysis connection.
// This is a read-only unit: nominal checkpoint descriptors must not require
// nonexistent modifying preimages. Implementation rollback is covered separately.
test.each(["complete", "receipt-save-cut", "result-save-cut", "cursor-save-cut", "pending", "pending-settled"])(
  "registered Node interrupted check continuation retains task ownership: %s", async mode => {
    const root = repository(), spec = assignmentSpec(root);
    writeFileSync(path.join(root, "owned"), "Existing interrupted-unit WIP");
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
    const metadata = { root, commonDir: path.join(root, ".git"), candidates: [],
      selected: { source: `${root}/.pitako/plans/assignment.md`, digest: digest(content), chunks: 1 } };
    // Prepare complete native originals at the controlled boundary, not another
    // copy of the root. The registered resource itself runs inside Node below.
    const templates: Record<string, any> = {};
    const seed = new Map<string, any>();
    const prepared = await runWorkflowScript({ script: resolved.resource.script,
      state: { get: key => seed.get(key), set: (key, value) => { seed.set(key, structuredClone(value)); } },
      status: async () => { throw Error("Unexpected seed status"); },
      launch: async (key, params) => {
        const response = childResponse(key, params, metadata, checkout);
        if (key.endsWith(".director")) {
          const final = response.structuredOutput.tasks[0];
          response.structuredOutput.tasks = [{ ...structuredClone(final), id: "repair", kind: "verification",
            goal: "Verify authorized behavior without writes", expectedResult: "Current verification check",
            checks: [{ ...final.checks[0], id: "repair-check" }] },
            { ...final, dependsOn: [{ taskId: "repair", reason: "Verify the completed repair" }] }];
        } else if (key.endsWith(".t1.a1")) {
          response.structuredOutput.taskId = "repair";
          response.structuredOutput.checks[0].id = "repair-check";
        }
        templates[key] = structuredClone(response);
        return response;
      },
      host: async key => ({ key, kind: "command", ok: true, state: "passed", exitCode: 0, stderr: "", durationMs: 0,
        outputPath: `/native/${key}.log`, stdout: JSON.stringify({ version: 1, binding: spec.binding, checkout, admission: { maxCycles: 3 } }) }),
    });
    expect(prepared.value).toMatchObject({ status: "complete" });
    const process = Bun.spawn(["node", "-e", `
      const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      import(${JSON.stringify(new URL("../node_modules/pi-subagents/src/workflows/scripted-workflow.js", import.meta.url).href)})
        .then(async ({runWorkflowScript}) => {
          const storage = new Map(), calls = [], statuses = [], originals = new Map();
          let cut = input.mode.includes("cut");
          const resumeKey = "invoke-human-1.l1.t1.a1.resume";
          const options = { script: input.script,
            state: { get: key => structuredClone(storage.get(key)), set: (key, value) => {
              const attempt = value.loop?.attempt;
              if (cut && ((attempt?.nativeContinuation?.stage === "receipt" &&
                  (input.mode === "receipt-save-cut" || (input.mode === "result-save-cut" && attempt.stage === "result"))) ||
                  (input.mode === "cursor-save-cut" && value.loop?.cursor === 1))) throw Error("Controlled continuation save cut");
              storage.set(key, structuredClone(value));
            } },
            launch: async (key, params) => {
              if (key.endsWith(".t2.a1")) {
                const stored = storage.get("invoke-human-1");
                const first = stored.tasks.repair.completed;
                if (stored.loop.cursor !== 1 || first.status !== "complete" || first.ref.runId !== "exact-successor")
                  throw Error("Next task dispatched before durable resumed-result admission");
                const refs = JSON.parse(params.task.split("DIRECT PREREQUISITE COMPLETED RESULTS (historical references, not current check evidence):\\n")[1].split("\\n")[0]);
                if (refs[0]?.taskId !== "repair" || refs[0]?.ref?.runId !== "exact-successor") throw Error("Wrong prerequisite successor");
              }
              calls.push({key, resume: params.resume, agent: params.agent});
              let response;
              if (key.endsWith(".t1.a1")) response = { ...structuredClone(input.templates[key]),
                ok: false, state: "interrupted", structuredOutput: undefined, results: [] };
              else if (key.endsWith(".resume")) {
                if (params.agent !== undefined || params.resume !== "native-invoke-human-1.l1.t1.a1") throw Error("Wrong native resume contract");
                const frozen = JSON.parse(params.task.split("FROZEN ATTEMPT:\\n")[1].split("\\n")[0]);
                if (frozen.taskId !== "repair" || frozen.number !== 1) throw Error("Attempt contract changed");
                response = { ...structuredClone(input.templates["invoke-human-1.l1.t1.a1"]), key, runId: "exact-successor" };
                if (input.mode.startsWith("pending")) { originals.set(key, { key, runId: "exact-successor", ok: true, state: "running" }); throw Error("Controlled post-launch transport loss"); }
              } else response = structuredClone(input.templates[key]);
              if (!response) throw Error("Unplanned child " + key);
              originals.set(key, response); originals.set(response.runId, response);
              return response;
            },
            status: async ref => { statuses.push(ref); const found = originals.get(ref); if (!found) throw Error("Unknown exact native reference"); return structuredClone(found); },
            host: async key => ({ key, kind: "command", ok: true, state: "passed", exitCode: 0, stderr: "", durationMs: 0,
              outputPath: "/native/" + key + ".log", stdout: JSON.stringify({ version: 1, binding: input.binding, checkout: input.checkout, admission: { maxCycles: 3 } }) }),
          };
          const first = await runWorkflowScript(options);
          cut = false;
          if (input.mode === "pending-settled") {
            const completed = { ...structuredClone(input.templates["invoke-human-1.l1.t1.a1"]), key: resumeKey, runId: "exact-successor" };
            originals.set(resumeKey, completed); originals.set(completed.runId, completed);
          }
          const second = input.mode === "complete" ? null : await runWorkflowScript(options);
          const third = second?.value?.status === "complete" ? await runWorkflowScript(options) : null;
          console.log(JSON.stringify({third: third?.value, first: first.value, second: second?.value, calls, statuses, invocation: storage.get("invoke-human-1")}));
        }).catch(error => {console.error(error); process.exitCode=1;});
    `], { cwd: root, env: { ...globalThis.process.env, PI_CODING_AGENT_DIR: path.join(root, "private-agent") }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(process.stdout).text(), stderr = new Response(process.stderr).text();
    process.stdin.write(JSON.stringify({script: resolved.resource.script, templates, metadata, content, checkout, mode, binding: spec.binding}));
    process.stdin.end();
    const [exit, output, errors] = await Promise.all([process.exited, stdout, stderr]);
    expect(exit, errors).toBe(0);
    expect(errors).not.toContain("unawaited runs.run launch(es)");
    const observed = JSON.parse(output);
    expect(observed.calls.filter((call: any) => call.key.endsWith(".resume"))).toHaveLength(1);
    expect(observed.calls.filter((call: any) => call.key.endsWith(".t1.a1"))).toHaveLength(1);
    expect(observed.invocation.consumedLoops).toBe(1);
    expect(observed.calls.some((call: any) => call.key.includes(".restore"))).toBe(false);
    expect(readFileSync(path.join(root, "owned"), "utf8")).toBe("Existing interrupted-unit WIP");
    if (mode === "pending") {
      expect(observed.second.status).not.toBe("complete");
      expect(observed.calls.some((call: any) => call.key.endsWith(".t2.a1"))).toBe(false);
      expect(observed.calls.some((call: any) => call.key.endsWith(".compliance"))).toBe(false);
    } else {
      expect((observed.second ?? observed.first).status).toBe("complete");
      expect(observed.calls.filter((call: any) => call.key.endsWith(".t2.a1"))).toHaveLength(1);
      expect(observed.calls.filter((call: any) => call.key.endsWith("director-synthesis"))).toHaveLength(1);
      expect(observed.calls.filter((call: any) => call.key.endsWith(".compliance"))).toHaveLength(1);
      expect(observed.invocation.loop.cursor).toBe(2);
      expect(observed.invocation.loop.results.map((result: any) => observed.invocation.tasks[result.taskId].completed)
        .map((result: any) => [result.taskId, result.status, result.attempt]))
        .toEqual([["repair", "complete", 1], ["final", "complete", 1]]);
      if (mode !== "complete") expect(observed.third.status).toBe("complete");
      expect(observed.invocation.tasks.repair.completed.ref).toMatchObject({ runId: "exact-successor",
        resumedFrom: {runId: "native-invoke-human-1.l1.t1.a1"} });
    }
  });

// Rejects a prompt-only resume claim or a replacement root that loses the saved
// invocation. The public native resume dispatcher and mission state remain real;
// only host checks and model-facing child responses are controlled.
test("registered Node public root resume consumes durable results and closes the same invocation", async () => {
  const root = repository(), spec = assignmentSpec(root);
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
        selected:{source:path.join(input.root,".pitako/plans/assignment.md"), digest:input.digest, chunks:1}};
      const response = eval('(' + input.response + ')');
      const originals = new Map();
      const boundary = {
        resolveResume:async ref=>{if (!originals.has(ref)) throw Error("Unknown controlled child " + ref); return ref;},
        launch:async (key, request)=>{
          calls.push(key);
          const result = response(key, request, metadata, input.checkout);
          if (key.endsWith(".director")) Object.assign(result.structuredOutput.association,{missionId:mission.missionId, missionPath});
          originals.set(key,result); originals.set(result.runId,result);
          return result;
        },
        status:async ref=>{const result = originals.get(ref); if (!result) throw Error("Unexpected retained query " + ref); return structuredClone(result);},
        host:async key=>({key,kind:"command",ok:true,state:"passed",exitCode:0,stderr:"",durationMs:0,outputPath:"/controlled/"+key+".log",
          stdout:JSON.stringify({version:1,binding:input.binding,checkout:input.checkout,admission:{maxCycles:3}})}),
      };
      const state = createMissionWorkflowState(mission.location, mission.missionId);
      let cut = false;
      const seeded = await runWorkflowScript({script, ...boundary, state:{get:key=>state.get(key),set:(key,value)=>{
        state.set(key,value);
        if (!cut && value.loop?.attempt?.stage === "result") {cut=true;throw Error("Controlled root interruption after durable result");}
      }}});
      if (!cut) throw Error("Did not reach durable cut");
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
      console.log(JSON.stringify({before,final,calls,resumed,again,sourceId,successor,claim,seeded:seeded.value}));
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root,"private-agent"), PI_SUBAGENTS_TEMP_ROOT:path.join(root,"native") }, stdin:"pipe",stdout:"pipe",stderr:"pipe" });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  child.stdin.write(JSON.stringify({packageRoot:path.resolve("."),root,response:childResponse.toString(),checkout,digest:digest(spec.content),content:spec.content,binding:spec.binding}));
  child.stdin.end();
  const [exit,output,errors] = await Promise.all([child.exited,stdout,stderr]);
  expect(exit,errors).toBe(0);
  expect(errors).not.toContain("unawaited runs.run launch(es)");
  const observed = JSON.parse(output);
  expect(observed.before.loop.attempt.stage).toBe("result");
  expect(observed.final.loop.outcome, JSON.stringify(observed.successor.workflow.value)).toBe("complete");
  expect(observed.final.association.maxCycles).toBe(3);
  expect(observed.successor.state).toBe("complete");
  expect(observed.successor.workflow.value.invocation).toBe("human-1");
  expect(observed.successor.workflow.value.loopsConsumed).toBe(1);
  expect(observed.final.consumedLoops).toBe(1);
  expect(observed.final.loop.cursor).toBe(1);
  expect(observed.calls.filter((key:string)=>key.endsWith(".t1.a1"))).toHaveLength(1);
  expect(observed.calls.filter((key:string)=>key.endsWith("director-synthesis"))).toHaveLength(1);
  expect(observed.calls.filter((key:string)=>key.endsWith(".compliance"))).toHaveLength(1);
  expect(observed.successor.workflow.resumeOrigin).toMatchObject({sourceRunId:observed.sourceId,attempt:1});
  expect(observed.successor.workflow.value.status).toBe("complete");
  expect(observed.again.isError).toBe(true);
  expect(JSON.stringify(observed.again.content)).toContain(observed.claim.newRunId);
});
