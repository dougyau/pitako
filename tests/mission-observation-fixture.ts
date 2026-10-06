import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WorkerHistory } from "../extensions/agent/history.ts";
import { registerMissionExtension } from "../extensions/mission/index.ts";
import { bindPreparationAuthority, openPreparationRequest, preparationAuthorityText, preparationContext,
  preparedAdmissionText, validatePreparation } from "../extensions/mission/preparation.ts";
import { nextPlanBytes, recordOperatorInput } from "../extensions/mission/admission.ts";
import { createMissionFixture, openFixtureStore, operatorChangeReceipt } from "./mission-fixtures.ts";
import { authoringProposal, authoringSource } from "./mission-authoring-fixture.ts";
import type { MissionObservationQuery } from "../extensions/mission/observation.ts";
import type { MissionStore } from "../extensions/mission/store.ts";
import { sha256 } from "../extensions/mission/model.ts";

// Synthetic retained P3-shaped evidence, NOT a historical live managed assignment.
// Preparation and consultation are real production paths. No worker, repair or assessor runs.
export async function observationFixture() {
  const fixture = createMissionFixture("pitako-observation-");
  process.env.PI_CODING_AGENT_DIR = fixture.stateDir;
  const source = authoringSource.replace("Reject empty input without changing valid input.", "Complete compatible setup and GATES; do not repair Hermes.")
    .replace("### T1 — Fix input", "### T1 — Setup and GATES")
    .replace("Objective: reject empty input.", "Objective: complete setup and GATES in the execution root.")
    .replace("Expected evidence: discriminating Node checks.",
      "Expected evidence: compare normal integration and parallel runner results.\nConstraints: do not infer Hermes dependency blame from a stack trace.\n" +
      "Retain original context 猫.\n".repeat(2500));
  writeFileSync(fixture.planFile, source);
  rmSync(fixture.definitionFile);
  const executionRoot = path.join(fixture.base, "execution");
  execFileSync("git", ["worktree", "add", "-q", "-b", "execution", executionRoot], { cwd: fixture.root });
  const configFile = path.join(fixture.base, "fixture.toml");
  writeFileSync(configFile, '[model_policies.developer]\nprimary = { model = "test/child" }\n[model_policies.reviewer]\nprimary = { model = "test/review" }\n');
  const request = openPreparationRequest("durable-fixture", executionRoot, "principal", { userConfigPath: configFile });
  const proposal = authoringProposal(preparationContext(request));
  const values = { authority: proposal.definition.authority, budget: proposal.definition.budget };
  const authorityText = preparationAuthorityText(request, values);
  bindPreparationAuthority(request, values, recordOperatorInput("native-confirmation", "principal", authorityText)!);
  const prepared = validatePreparation({ request, proposal });
  if (prepared.state !== "ready") throw new Error(JSON.stringify(prepared.issues));
  const store = await openFixtureStore(fixture);
  const text = preparedAdmissionText(prepared.prepared);
  const receipt = recordOperatorInput("native-confirmation", "principal", text)!;
  const mission = store.createMission({ repositoryRoot: executionRoot, planId: "durable-fixture",
    prepared: prepared.prepared, commandId: receipt.id, admissionReceiptId: receipt.id, operatorText: text, operatorReceipt: receipt });
  const unit = proposal.definition.units[0]!;
  const earlierAttempt = randomUUID(), currentAttempt = randomUUID();
  const append = (events: Parameters<MissionStore["appendTransition"]>[2]["events"],
    artifacts: Parameters<MissionStore["appendTransition"]>[2]["artifacts"] = []) => {
    const current = store.inspectMission(mission.id);
    store.appendTransition(mission.id, current.version, { events, artifacts });
  };
  const reserve = (attemptId: string, revision: number, attemptNo: number) => {
    const brief = Buffer.from(unit.originalIntent!.workBrief), briefArtifactHash = sha256(brief);
    append([{ revision, unitId: unit.id, attemptId, kind: "attempt.reserved", causalId: randomUUID(),
      payload: { attemptId, unitId: unit.id, roundId: "main", memberId: "solo", attemptNo,
        binding: { missionId: mission.id, revision, unitId: unit.id, attemptId, attemptNo,
        role: "developer", ownerEpoch: store.ownerEpoch, roundId: "main", memberId: "solo", briefArtifactHash,
        briefHash: briefArtifactHash, rolePolicyHash: "a".repeat(64), candidateRoot: "/synthetic/writable-handle-not-returned" } } }],
    [{ bytes: brief, mediaType: "text/plain" }]);
  };
  reserve(earlierAttempt, 1, 1);
  const hostReport = Buffer.from(JSON.stringify({
    provenance: "synthetic captured P3-shaped fixture",
    normal: { command: "node --test test/integration.test.mjs", exitCode: 0, result: "integration passes" },
    parallel: { command: "bun test --concurrent test/integration.test.mjs", exitCode: 1,
      result: "TypeError: Hermes callback unavailable in parallel runner" },
    limit: "Runner difference observed. Stacktrace does not establish dependency blame.",
  }));
  const reportHash = sha256(hostReport);
  append([{ revision: 1, unitId: unit.id, attemptId: earlierAttempt, kind: "attempt.receipt", causalId: randomUUID(),
    payload: { attemptId: earlierAttempt, status: "failed", artifactHash: reportHash } },
  { revision: 1, unitId: unit.id, attemptId: earlierAttempt, kind: "attempt.settled", causalId: randomUUID(),
    payload: { attemptId: earlierAttempt, status: "failed" } }], [{ bytes: hostReport, mediaType: "application/json" }]);
  const beforeRevision = store.inspectMission(mission.id);
  const next = structuredClone(beforeRevision.definition);
  next.units[0]!.retryLimit = 1;
  const change = operatorChangeReceipt(store, beforeRevision, next);
  store.admitRevision({ missionId: mission.id, expectedVersion: beforeRevision.version,
    planBytes: nextPlanBytes(beforeRevision.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)),
    receiptId: change.id, actor: "operator", impact: [unit.id], retained: [], operatorText: change.text, operatorReceipt: change });
  append([{ revision: 2, unitId: unit.id, kind: "unit.ready", causalId: randomUUID(), payload: { retryOf: earlierAttempt } }]);
  reserve(currentAttempt, 2, 2);
  const history = new WorkerHistory();
  const sessionsDirectory = path.join(fixture.stateDir, "pitako", "missions", "sessions");
  const group = history.missionGroup(executionRoot, mission.id, {
    dbPath: store.dbPath!, objectDir: fixture.objectDir, sessionsDirectory }, false);
  const nativeBytes = Buffer.from([
    { type: "session", id: "retained-earlier", version: 3, cwd: executionRoot },
    { type: "message", id: "original", parentId: null, message: { role: "user", content: unit.originalIntent!.workBrief } },
    { type: "message", id: "normal-call", parentId: "original", message: { role: "assistant",
      content: [{ type: "toolCall", id: "normal", name: "bash", arguments: { command: "node --test test/integration.test.mjs" } }] } },
    { type: "message", id: "normal-result", parentId: "normal-call", message: { role: "toolResult",
      toolCallId: "normal", content: [{ type: "text", text: "exit 0: integration passes" }] } },
    { type: "message", id: "parallel-call", parentId: "normal-result", message: { role: "assistant",
      content: [{ type: "toolCall", id: "parallel", name: "bash", arguments: { command: "bun test --concurrent test/integration.test.mjs" } }] } },
    { type: "message", id: "parallel-result", parentId: "parallel-call", message: { role: "toolResult",
      toolCallId: "parallel", content: [{ type: "text", text: "exit 1: TypeError: Hermes callback unavailable in parallel runner" }] } },
    { type: "message", id: "unsupported-premise", parentId: "parallel-result", message: { role: "assistant",
      content: [{ type: "text", text: "Hermes must be the broken dependency. Investigate Hermes internals." },
        { type: "toolCall", id: "drift", name: "bash", arguments: { command: "grep -R callback node_modules/pi-hermes-memory" } }] } },
    { type: "message", id: "drift-result", parentId: "unsupported-premise", message: { role: "toolResult",
      toolCallId: "drift", content: [{ type: "text", text: "callback definition found; no causal isolation or dependency proof" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const native = path.join(sessionsDirectory, "earlier.jsonl");
  mkdirSync(sessionsDirectory, { recursive: true }); writeFileSync(native, nativeBytes);
  const earlier = history.admit(group.groupId, { roleId: "developer", unitId: unit.id, attemptId: earlierAttempt,
    assignmentId: earlierAttempt, coordinatorSessionId: "original-principal" });
  history.admit(group.groupId, { roleId: "developer", unitId: unit.id, attemptId: currentAttempt,
    assignmentId: currentAttempt, coordinatorSessionId: "original-principal" });
  history.mutate(group.groupId, (saved) => {
    saved.members[0]!.native = { state: "allocated", sessionId: "retained-earlier", path: native,
      disposition: { state: "disposed", at: new Date().toISOString() } };
    saved.members[0]!.terminal = { status: "failed", at: new Date().toISOString(), beforeFirstAssistant: false };
  });
  return { fixture, executionRoot, store, mission, unit, earlierAttempt, currentAttempt, earlier, history, group,
    native, nativeBytes, hostReport, reportHash, append };
}

export function observationAdapters(root: string) {
  const tools = new Map<string, any>(), commands = new Map<string, any>();
  registerMissionExtension({
    on() {}, registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command.handler),
  } as any);
  const context = { cwd: root, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "reloaded-principal" },
    ui: { notify() {} } };
  return {
    tool: tools.get("mission_observe"),
    async toolPage(query: MissionObservationQuery) {
      const result = await tools.get("mission_observe").execute("observation", query, undefined, undefined, context);
      if (Buffer.byteLength(result.content[0].text) > 32768) throw new Error("unbounded observation page");
      return JSON.parse(result.content[0].text);
    },
    async command(query: MissionObservationQuery) {
      let text = "";
      const args = `inspect ${query.missionId}${query.unitId ? ` --unit ${query.unitId}` : ""}` +
        `${query.attemptId ? ` --attempt ${query.attemptId}` : ""}${query.cursor ? ` --cursor ${query.cursor}` : ""}`;
      await commands.get("mission")(args, { ...context, ui: { notify(message: string) { text = message; } } });
      return JSON.parse(text);
    },
  };
}

/** Exact file membership and bytes, including DB/WAL/SHM, not only logical rows. */
export function observationFiles(directory: string): Record<string, Buffer> {
  const result: Record<string, Buffer> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, observationFiles(file));
    else if (entry.isFile()) result[file] = readFileSync(file);
  }
  return result;
}
