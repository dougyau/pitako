import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveWorkflowResource } from "../node_modules/pi-subagents/src/workflows/workflow-resources.js";
import registerPlanExecute, { analysisResource } from "../extensions/plan-execute.ts";
import { missionFiles } from "./fixtures/plan-execute-composition.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function store() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-analysis-resources-")); roots.push(root);
  return { root, ...missionFiles(root) };
}
function hooks() {
  const handlers = new Map<string, (event: any, context?: unknown) => any>();
  const disposed: string[] = [];
  registerPlanExecute({ on: (name: string, handler: (event: any) => unknown) => { handlers.set(name, handler); },
    events: { emit: (_name: string, request: any) => { request.result = { ok: true, registration: { dispose() { disposed.push(request.name); } } }; } },
  } as unknown as ExtensionAPI);
  return { handlers, disposed };
}

test.each(["pitako.review", "pitako.architecture"])("%s launches only by name with a pre-created mission", name => {
  const { root, missionPath } = store();
  const { handlers } = hooks();
  const args = { missionId: "native.mission-1", missionPath, consultation: "decision" };
  const call = (input: object) => handlers.get("tool_call")!({ toolName: "subagent", input: { workflow: name, cwd: root, ...input } }, { cwd: root });
  expect(call({ args, options: { missionId: args.missionId } })).toBeUndefined();
  for (const invalid of [
    { args, options: { mission: { title: "One-step" } } },
    { args, options: {} },
    { args: { ...args, missionId: "other" }, options: { missionId: args.missionId } },
    { args: { ...args, missionPath: path.join(root, "native.mission-1", "state.json") }, options: { missionId: args.missionId } },
  ]) expect(call(invalid)).toMatchObject({ block: true });
});

test("named resolution inlines data args and the mission binding; invalid bindings fail", () => {
  const { root, missionPath } = store();
  const review = analysisResource("pitako.review", root, root).resolve({ missionId: "native.mission-1", missionPath, brief: "B", workDescription: "W",
    target: { kind: "diff", reference: "r", material: "m" } });
  expect(review.script).toStartWith(`const args = ${JSON.stringify({ brief: "B", workDescription: "W", target: { kind: "diff", reference: "r", material: "m" } })};\nconst pitakoAccess = ${JSON.stringify({ missionPath, namespace: "review" })};\n`);
  expect(review.script).toContain('const pitakoReviewModels = {"r1":{"key":"pitako.review.r1","model":"anthropic/claude-opus-5-5:high"}');
  const architecture = analysisResource("pitako.architecture").resolve({ missionId: "native.mission-1", missionPath, consultation: "stream-parser" });
  expect(architecture.script).toContain(`const pitakoAccess = ${JSON.stringify({ missionPath, namespace: "architecture-stream-parser" })};`);
  expect(() => analysisResource("pitako.review").resolve({ missionPath })).toThrow("requires an existing native missionId");
  expect(() => analysisResource("pitako.review").resolve({ missionId: "native.mission-1", missionPath: "relative.json" })).toThrow("mission record path");
  expect(() => analysisResource("pitako.review").resolve({ missionId: "native.mission-1", missionPath: path.join(path.dirname(missionPath), "other.json") }))
    .toThrow("mission record path");
  expect(() => analysisResource("pitako.architecture").resolve({ missionId: "native.mission-1", missionPath, consultation: "../x" }))
    .toThrow("stable architecture consultation ID");
});

test("session registration adds the verifier and both named resources, disposing all together", () => {
  const { root, missionPath } = store();
  const { handlers, disposed } = hooks();
  const sessionId = randomUUID(), ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    handlers.get("session_start")!({}, ctx);
    for (const name of ["pitako.review", "pitako.architecture"])
      expect(resolveWorkflowResource(name, { missionId: "native.mission-1", missionPath, consultation: "c" }, sessionId)).toMatchObject({ ok: true });
    expect(JSON.stringify(resolveWorkflowResource("pitako.execute", {}, sessionId))).not.toContain("Unknown workflow resource");
  } finally {
    handlers.get("session_shutdown")!({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  expect(disposed).toContain("pitako.access-verifier");
  for (const name of ["pitako.review", "pitako.architecture"])
    expect(resolveWorkflowResource(name, { missionId: "native.mission-1", missionPath, consultation: "c" }, sessionId)).toMatchObject({ ok: false });
});
