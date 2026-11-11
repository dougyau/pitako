import { afterEach, beforeEach, expect, test } from "bun:test";
import { gitFakeFixture } from "./fixtures/git-fake-fixture.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPatch } from "pi-codex-tools";
import checkpointCreate from "../extensions/checkpoint-create.ts";
import { checkpointDirectory, sealCheckpoint, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";
import { EXECUTE_STATE_VERSION, executionStatePath } from "../extensions/execute-state.ts";

let fake: ReturnType<typeof gitFakeFixture>;
beforeEach(() => { fake = gitFakeFixture(); });
const roots: string[] = [];
afterEach(() => { try { fake.dispose(); } finally { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); } });
const artifact = (file: string) => {
  const envelope = JSON.parse(readFileSync(file, "utf8"));
  expect(createHash("sha256").update(envelope.data).digest("hex")).toBe(envelope.sha256);
  return JSON.parse(envelope.data);
};
function fixture(bound = true) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-write-hook-")); roots.push(root);
  fake.fakeRepo(root, { paths: ["file", "new", "added", "moved", "deleted", "destination"], ignored: ["ignored/new"] });
  writeFileSync(path.join(root, "file"), "WIP");
  const association = { root, commonDir: path.join(root, ".git"), missionId: "mission", missionPath: path.join(root, "mission.json"), invocation: "hook", source: path.join(root, "spec.md"), digest: "a".repeat(64), maxCycles: 15, sourceRefs: [] };
  const intent: CheckpointIntent = { version: 2, association, key: "worker", taskId: "task", attempt: 1, loop: 1, cursor: 0, phase: "implementation", planRef: { key: "plan" }, progress: { consumedLoops: 1, admitted: {}, previous: null } };
  const attempt: any = { key: intent.key, bindingKey: intent.key, taskId: "task", number: 1, index: 0, stage: "launched", checkpoint: intent };
  const record: any = { version: EXECUTE_STATE_VERSION, association, consumedLoops: 1, tasks: {}, loop: { number: 1, cursor: 0, phase: "implementation", plan: { stage: "admitted", ref: intent.planRef }, manifest: ["task"], attempt } };
  const state = executionStatePath(association);
  mkdirSync(path.dirname(state), { recursive: true });
  const persist = () => writeFileSync(state, JSON.stringify({ "invoke-hook": record })); persist();
  const handlers: Record<string, Function> = {};
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  try {
    process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify(bound ? { "pitako.checkpoint/1": { association, key: intent.key } } : {});
    checkpointCreate({ on(name: string, fn: Function) { handlers[name] = fn; }, registerTool() {} } as unknown as ExtensionAPI);
  } finally { if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS; else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous; }
  const call = (toolName = "write", target: unknown = "file", id = "call", extra = {}) => handlers.tool_call!({ toolName, toolCallId: id, input: { path: target, ...extra } }, { cwd: root });
  const end = (id = "call", event = "tool_result", isError = false) => handlers[event]!({ toolCallId: id, isError });
  const directory = checkpointDirectory(intent);
  const artifacts = (pattern: RegExp) => existsSync(directory) ? readdirSync(directory).filter(p => pattern.test(p)).sort().map(p => artifact(path.join(directory, p))) : [];
  return { root, intent, record, attempt, persist, call, end, directory, artifacts };
}

test("direct and nested writes publish first-touch bytes and durable intent before allow; sibling overlap reserves until close", async () => {
  const f = fixture();
  const first = f.call("edit", "file", "parent/0");
  const overlap = f.call("write", "./file", "sibling");
  expect(await first).toBeUndefined();
  expect(await overlap).toMatchObject({ block: true, reason: expect.stringContaining("retry") });
  expect(f.artifacts(/^capture-/)[0].image.bytes).toBe(Buffer.from("WIP").toString("base64"));
  expect(f.artifacts(/^hook-effect-\d+\.json$/)[0]).toMatchObject({ tool: "edit", seq: 0, paths: ["file"], before: [{ path: "file" }] });
  expect(f.call("write", "new", "parent/1")).toBeUndefined();
  expect(f.artifacts(/^capture-/)[1].image).toBeNull();
  writeFileSync(path.join(f.root, "file"), "edited"); f.end("parent/0");
  expect(f.artifacts(/-closed\.json$/)[0].after[0].image.bytes).toBe(Buffer.from("edited").toString("base64"));
  expect(f.call("edit", "file", "second")).toBeUndefined();
  expect(f.artifacts(/^capture-/)).toHaveLength(2);
  f.end("second"); f.end("parent/1");
  const sealed = sealCheckpoint(f.intent, "unit", true);
  expect(artifact(sealed.checkpointRef).files).toEqual([
    { path: "file", image: { bytes: Buffer.from("edited").toString("base64"), mode: expect.any(Number) } },
    { path: "new", image: null },
  ]);
});

test.each([["tool_result", false], ["tool_result", true], ["tool_execution_end", false], ["tool_execution_end", true]] as const)("real postimages close through %s (failure=%s)", (event, isError) => {
  const f = fixture(); f.call();
  f.end("unrelated", "tool_execution_end");
  expect(f.call("write", "file", "overlap")).toHaveProperty("block", true);
  writeFileSync(path.join(f.root, "file"), "partial or successful bytes");
  f.end("call", event, isError);
  f.end("call", "tool_execution_end", isError);
  expect(f.artifacts(/-closed\.json$/)).toHaveLength(1);
  expect(Buffer.from(f.artifacts(/-closed\.json$/)[0].after[0].image.bytes, "base64").toString()).toBe("partial or successful bytes");
  expect(f.call("write", "file", "next")).toBeUndefined(); f.end("next");
});

test("without binding calls pass unchanged; outside-root, ignored files and unrelated tools create no journal", () => {
  const unbound = fixture(false);
  expect(unbound.call("lsp_rename")).toBeUndefined(); expect(unbound.call("write", "~bad")).toBeUndefined();
  const f = fixture(); writeFileSync(path.join(f.root, ".gitignore"), "ignored/\n");
  for (const target of ["../outside", "ignored/new"]) expect(f.call("write", target)).toBeUndefined();
  for (const tool of ["read", "bash", "codemode", "ast_search"]) expect(f.call(tool)).toBeUndefined();
  expect(f.call("ast_rewrite", "file", "preview", { dryRun: true })).toBeUndefined();
  expect(f.call("ast_rewrite")).toBeUndefined();
  expect(existsSync(f.directory)).toBe(false);
});

test.each(["~/file", "@file", "a\u00a0b", "a\u2009b", "file://file", "C:/file", "C:\\file", "a\\file", ".git/config", ".git/../file", ".pi/file", ".pitako/file"])("reject special/protected path: %s", target => {
  const f = fixture(); expect(f.call("edit", target)).toHaveProperty("block", true);
  for (const patch of [
    `*** Begin Patch
*** Add File: ${target}
+data
*** End Patch`,
    `*** Begin Patch
*** Update File: file
*** Move to: ${target}
@@
-WIP
+data
*** End Patch`,
  ]) expect(f.call("apply_patch", undefined, "patch", { patch })).toHaveProperty("block", true);
  expect(existsSync(f.directory)).toBe(false);
});

test("symlink components rejected, including components before ..", () => {
  const f = fixture(); mkdirSync(path.join(f.root, "dir")); symlinkSync("dir", path.join(f.root, "link"));
  for (const target of ["link/file", "link/../file"]) {
    expect(f.call("write", target)).toMatchObject({ block: true, reason: expect.stringContaining("symlink") });
    expect(f.call("apply_patch", undefined, "patch", { patch: `*** Begin Patch
*** Update File: file
*** Move to: ${target}
@@
-WIP
+data
*** End Patch` })).toMatchObject({ block: true, reason: expect.stringContaining("symlink") });
  }
});

test.each(["lineage", "stage", "result", "halt", "outcome", "intent", "association"])("re-read durable state on each call blocks stale/stopped state: %s", mode => {
  const f = fixture(); f.call(); f.end();
  if (mode === "lineage") f.attempt.bindingKey = "foreign";
  if (mode === "stage") f.attempt.stage = "intention";
  if (mode === "result") f.attempt.result = {};
  if (mode === "halt") f.record.loop.halt = { code: "stop" };
  if (mode === "outcome") f.record.outcome = "stopped";
  if (mode === "intent") f.attempt.checkpoint = { ...f.intent, cursor: 1 };
  if (mode === "association") f.record.association = { ...f.intent.association, digest: "b".repeat(64) };
  f.persist(); expect(f.call("write", "new", "next")).toHaveProperty("block", true);
  expect(f.artifacts(/^capture-/)).toHaveLength(1);
});

test("revived same-lineage attempt uses its own intent, not cached first attempt", () => {
  const f = fixture(); f.call(); f.end();
  const next = { ...f.intent, key: "revived", attempt: 2 };
  Object.assign(f.attempt, { key: next.key, number: 2, checkpoint: next }); f.persist();
  expect(f.call("write", "new", "next")).toBeUndefined(); f.end("next");
  const directory = checkpointDirectory(next);
  expect(artifact(path.join(directory, "hook-effect-000000.json")).intent).toEqual(next);
});

test("journal failure blocks without modifying product bytes", () => {
  const f = fixture(); mkdirSync(path.dirname(f.directory), { recursive: true }); writeFileSync(f.directory, "not a directory");
  expect(f.call()).toHaveProperty("block", true);
  expect(readFileSync(path.join(f.root, "file"), "utf8")).toBe("WIP");
});

test("blocked mutators and apply_patch metadata targets explain required route", () => {
  const f = fixture();
  for (const tool of ["lsp_rename", "ast_rewrite"]) expect(f.call(tool, "file", "call", { dryRun: false })).toMatchObject({ block: true, reason: expect.stringContaining("edit/write/apply_patch") });
  for (const dir of [".pi", ".pitako"]) {
    expect(f.call("write", `${dir}/file`)).toMatchObject({ block: true, reason: expect.stringContaining(dir) });
    expect(f.call("apply_patch", undefined, "patch", { patch: `*** Begin Patch\n*** Add File: ${dir}/file\n+data\n*** End Patch` })).toMatchObject({ block: true, reason: expect.stringContaining(dir) });
  }
});

test("apply_patch add, move and delete publish one effect over every source and destination before execution", async () => {
  const f = fixture(); writeFileSync(path.join(f.root, "deleted"), "old");
  const patch = `*** Begin Patch
*** Add File: added
+new
*** Update File: file
*** Move to: moved
@@
-WIP
+edited
*** Delete File: deleted
*** End Patch`;
  expect(f.call("apply_patch", undefined, "parent/patch", { patch })).toBeUndefined();
  const effects = f.artifacts(/^hook-effect-\d+\.json$/);
  expect(effects).toHaveLength(1);
  expect(effects[0]).toMatchObject({ tool: "apply_patch", seq: 0, paths: ["added", "file", "moved", "deleted"] });
  const before = [
    { path: "added", image: null },
    { path: "file", image: { bytes: Buffer.from("WIP").toString("base64"), mode: expect.any(Number) } },
    { path: "moved", image: null },
    { path: "deleted", image: { bytes: Buffer.from("old").toString("base64"), mode: expect.any(Number) } },
  ];
  expect(effects[0].before).toEqual(before);
  expect(f.artifacts(/^capture-/).map(({ path, image }) => ({ path, image }))).toEqual(before);
  for (const target of ["added", "file", "moved", "deleted"])
    expect(f.call("write", target, `sibling/${target}`)).toMatchObject({ block: true, reason: expect.stringContaining("retry") });
  await applyPatch(patch, { cwd: f.root }); f.end("parent/patch");
  const closed = f.artifacts(/-closed\.json$/);
  expect(closed).toHaveLength(1);
  expect(closed[0].after).toEqual([
    { path: "added", image: { bytes: Buffer.from("new\n").toString("base64"), mode: expect.any(Number) } },
    { path: "file", image: null },
    { path: "moved", image: { bytes: Buffer.from("edited\n").toString("base64"), mode: expect.any(Number) } },
    { path: "deleted", image: null },
  ]);
  for (const target of ["added", "file", "moved", "deleted"]) {
    expect(f.call("write", target, `next/${target}`)).toBeUndefined(); f.end(`next/${target}`);
  }
  expect(f.artifacts(/^capture-/)).toHaveLength(4);
});

test("apply_patch overlap on a move destination blocks the whole call without reserving other paths", () => {
  const f = fixture(); f.call("write", "destination", "sibling");
  const patch = `*** Begin Patch
*** Add File: added
+new
*** Update File: file
*** Move to: destination
@@
-WIP
+edited
*** End Patch`;
  expect(f.call("apply_patch", undefined, "patch", { patch })).toMatchObject({ block: true, reason: expect.stringContaining("retry") });
  expect(f.artifacts(/^capture-/).map(capture => capture.path)).toEqual(["destination"]);
  expect(f.artifacts(/^hook-effect-\d+\.json$/)).toHaveLength(1);
  expect(f.call("write", "added", "independent")).toBeUndefined(); f.end("independent"); f.end("sibling");
});

test("apply_patch parser errors block before capture; unbound patches pass through unchanged", () => {
  const f = fixture();
  const patch = "*** Begin Patch\n*** Add File: added\ninvalid\n*** End Patch";
  expect(f.call("apply_patch", undefined, "patch", { patch })).toEqual({ block: true, reason: "Invalid add hunk at patch line 3: every line must start with '+'." });
  expect(existsSync(f.directory)).toBe(false);
  expect(fixture(false).call("apply_patch", undefined, "patch", { patch })).toBeUndefined();
});

test("apply_patch excludes outside-root and ignored targets from the single effect", () => {
  const f = fixture(); writeFileSync(path.join(f.root, ".gitignore"), "ignored/\n");
  const excluded = `*** Add File: ../outside
+outside
*** Add File: ignored/new
+ignored`;
  expect(f.call("apply_patch", undefined, "excluded", { patch: `*** Begin Patch\n${excluded}\n*** End Patch` })).toBeUndefined();
  expect(existsSync(f.directory)).toBe(false);
  expect(f.call("apply_patch", undefined, "mixed", { patch: `*** Begin Patch\n${excluded}\n*** Delete File: file\n*** End Patch` })).toBeUndefined();
  expect(f.artifacts(/^hook-effect-\d+\.json$/)[0].paths).toEqual(["file"]); f.end("mixed", "tool_execution_end");
});
