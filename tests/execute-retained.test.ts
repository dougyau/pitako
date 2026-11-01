import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundRetainedAnalyses, retainedAnalyses } from "../extensions/execute-retained.ts";

function fixture(run: (value: {
	root: string; file: string; native: string; mission: string; statePath: string;
	ref: Record<string, unknown>; original: Record<string, unknown>; load: () => unknown;
}) => void) {
	const root = mkdtempSync(path.join(os.tmpdir(), "pitako-retained-"));
	try {
		const native = path.join(root, "native", "producer-1");
		const file = path.join(native, "structured-output", "original.json");
		mkdirSync(path.dirname(file), { recursive: true });
		const original = { status: "ready", memo: "COMPLETE ORIGINAL\n" + "source evidence ".repeat(1000), findings: [] };
		const ref = { key: "invoke-human-1.l1.review.director-synthesis", runId: "producer-1", asyncDir: native,
			results: [{ structuredOutputPath: file }] };
		const mission = path.join(root, "mission.json");
		const statePath = path.join(root, "mission-1", "state.json");
		mkdirSync(path.dirname(statePath));
		writeFileSync(mission, JSON.stringify({ schemaVersion: 1, id: "mission-1", title: "Fixture mission" }));
		const context = { missionId: "mission-1", missionPath: mission, invocation: "human-1" };
		writeFileSync(file, JSON.stringify(original));
		writeFileSync(path.join(native, "status.json"), JSON.stringify({
			runId: ref.runId, workflowKey: ref.key, cwd: root, state: "complete",
			steps: [{ exitCode: 0, structuredOutput: original }],
		}));
		const association = { ...context, root, source: "/spec.md", digest: "e".repeat(64) };
		writeFileSync(statePath, JSON.stringify({ "invoke-human-1": {
			version: 4, association, loop: { number: 1, phase: "review", review: { references: [ref] } },
		} }));
		run({ root, file, native, mission, statePath, ref, original,
			load: () => retainedAnalyses(root, "/spec.md", "e".repeat(64), context) });
	} finally { rmSync(root, { recursive: true, force: true }); }
}

test("reads complete original JSON without a result in the management response or truncating it", () => fixture(f => {
	expect(f.load()).toEqual([{ key: f.ref.key, runId: f.ref.runId, ok: true, state: "complete", structuredOutput: f.original }]);
}));

test.each(["file", "native-status"])("retains the full original when optional %s is absent", absent => fixture(f => {
	rmSync(absent === "file" ? f.file : path.join(f.native, "status.json"));
	expect(f.load()).toEqual([{ key: f.ref.key, runId: f.ref.runId, ok: true,
		...(absent === "file" ? { state: "complete" } : {}), structuredOutput: f.original }]);
}));

test("compares full JSON semantics, not property order", () => fixture(f => {
	writeFileSync(f.file, JSON.stringify(Object.fromEntries(Object.entries(f.original).reverse())));
	expect(f.load()).toEqual([{ key: f.ref.key, runId: f.ref.runId, ok: true, state: "complete", structuredOutput: f.original }]);
}));

test("reports conflicting originals instead of choosing the convenient value", () => fixture(f => {
	writeFileSync(f.file, JSON.stringify({ ...f.original, memo: "different" }));
	expect(f.load()).toMatchObject([{ ok: false, error: "Conflicting complete retained analysis originals." }]);
}));

test("does not load an unrelated invocation's references", () => fixture(f => {
	const state = JSON.parse(readFileSync(f.statePath, "utf8"));
	state["invoke-human-1"].association.missionId = "other";
	writeFileSync(f.statePath, JSON.stringify(state));
	expect(f.load).toThrow("Retained analysis association differs");
}));

test("does not substitute a mismatching native producer", () => fixture(f => {
	const file = path.join(f.native, "status.json");
	const status = JSON.parse(readFileSync(file, "utf8"));
	status.workflowKey = "invoke-human-1.l2.review.director-synthesis";
	writeFileSync(file, JSON.stringify(status));
	expect(f.load()).toMatchObject([{ ok: false, error: "Retained native producer conflicts with its reference." }]);
}));

test("does not follow an original symlink outside its exact native producer", () => fixture(f => {
	const outside = path.join(f.root, "unrelated.json");
	writeFileSync(outside, JSON.stringify(f.original));
	rmSync(f.file);
	symlinkSync(outside, f.file);
	expect(f.load()).toMatchObject([{ ok: false, error: "Structured original escapes its retained native producer." }]);
}));

test.each(["failed", "stopped", "running"])("keeps a current native %s state", state => fixture(f => {
	writeFileSync(path.join(f.native, "status.json"), JSON.stringify({
		runId: f.ref.runId, workflowKey: f.ref.key, state,
	}));
	expect(f.load()).toEqual([{ key: f.ref.key, runId: f.ref.runId, ok: false, state }]);
}));

test("does not promote a stopped attempt that already emitted JSON", () => fixture(f => {
	writeFileSync(path.join(f.native, "status.json"), JSON.stringify({
		runId: f.ref.runId, state: "complete", steps: [{ exitCode: 0, stopped: true, structuredOutput: f.original }],
	}));
	expect(f.load()).toMatchObject([{ ok: false, stopped: true }]);
}));

test("a new invocation has no historical reference scan", () => fixture(f => {
	writeFileSync(f.mission, readFileSync(f.statePath));
	writeFileSync(f.statePath, "{}");
	expect(f.load()).toEqual([]);
}));

test.each(["stopped", "interrupted", "detached"])("missing status does not erase a retained %s observation", field => fixture(f => {
	rmSync(path.join(f.native, "status.json"));
	const state = JSON.parse(readFileSync(f.statePath, "utf8"));
	state["invoke-human-1"].loop.review.references[0].results[0][field] = true;
	writeFileSync(f.statePath, JSON.stringify(state));
	expect(f.load()).toMatchObject([{ ok: false, [field]: true }]);
}));

test("missing native state never substitutes metadata containing invocation-shaped data", () => fixture(f => {
	writeFileSync(f.mission, readFileSync(f.statePath));
	rmSync(f.statePath);
	expect(f.load()).toEqual([]);
}));

test("corrupt native state is not treated as a fresh invocation", () => fixture(f => {
	writeFileSync(f.statePath, "{invalid");
	expect(f.load).toThrow();
}));


test.each(["eligible", "legacy", "binding", "sources"])("bound admission recovery captures only eligible new-root originals: %s", mode => fixture(f => {
	const state = JSON.parse(readFileSync(f.statePath, "utf8")), invocation = state["invoke-human-1"];
	const binding = "b".repeat(64), commonDir = path.join(f.root, ".git");
	Object.assign(invocation, { version: mode === "legacy" ? 2 : 4, admissionBinding: mode === "binding" ? "c".repeat(64) : binding });
	Object.assign(invocation.association, { commonDir, maxCycles: 3, sourceRefs: [] });
	writeFileSync(f.statePath, JSON.stringify(state));
	const load = () => boundRetainedAnalyses(f.root, commonDir, "/spec.md", "e".repeat(64), binding,
		{ missionId: "mission-1", missionPath: f.mission, invocation: "human-1", sourceRefs: mode === "sources" ? [{ path: "/changed", digest: "f".repeat(64) }] : [] });
	if (mode !== "eligible") {
		expect(load).toThrow("Retained recovery binding differs or predates bound admission");
		expect(load).toThrow("without redispatch or automatic recapture");
	} else {
		const captured = load()!;
		expect(captured.association).toEqual(invocation.association);
		expect(captured.references).toEqual([f.ref]);
		expect(captured.originals[0]).toMatchObject({ structuredOutput: f.original });
		expect(captured.digest).toMatch(/^[a-f0-9]{64}$/);
	}
	expect(readFileSync(f.statePath, "utf8")).toBe(JSON.stringify(state));
}));

test("pending demand observation retains exact original only until director dispatch", () => fixture(f => {
  const state = JSON.parse(readFileSync(f.statePath, "utf8"));
  const loop = state["invoke-human-1"].loop;
  const ref = { ...f.ref, key: "invoke-human-1.l1.demand-observation" };
  loop.phase = "director"; delete loop.review;
  loop.analysisCalls = [{ key: ref.key, stage: "receipt", ref }];
  const statusFile = path.join(f.native, "status.json");
  const status = JSON.parse(readFileSync(statusFile, "utf8")); status.workflowKey = ref.key;
  writeFileSync(statusFile, JSON.stringify(status));
  writeFileSync(f.statePath, JSON.stringify(state));
  expect(f.load()).toMatchObject([{ key: ref.key, ok: true, structuredOutput: f.original }]);
  // No local body is needed; the retained native witness is the source.
  rmSync(statusFile);
  expect(f.load()).toMatchObject([{ key: ref.key, ok: true, structuredOutput: f.original }]);
  loop.plan = { stage: "intention", ref: { key: "invoke-human-1.l1.director" } };
  writeFileSync(f.statePath, JSON.stringify(state));
  expect(f.load()).toEqual([]);
  loop.phase = "compliance";
  writeFileSync(f.statePath, JSON.stringify(state));
  expect(f.load()).toEqual([]);
}));
