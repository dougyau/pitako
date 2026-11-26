import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundRetainedAnalyses, retainedAnalyses } from "../extensions/execute-retained.ts";
import { type ExecuteCursor } from "../extensions/execute-cursor.ts";
import { EXECUTE_STATE_VERSION } from "../extensions/execute-state.ts";
import { PitakoStore } from "../extensions/pitako-store.ts";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { gitFakeFixture } from "./fixtures/git-fake-fixture.ts";

function fixture(run: (f: ReturnType<typeof setup>) => void) {
	const root = mkdtempSync(path.join(os.tmpdir(), "pitako-retained-")), fake = gitFakeFixture();
	try {
		fake.fakeRepo(root);
		fake.set(root, ["rev-parse", "--git-path", "info/exclude"], { stdout: ".git/info/exclude\n", stderr: "", status: 0 });
		run(setup(root));
	} finally { fake.dispose(); rmSync(root, { recursive: true, force: true }); }
}
function setup(root: string) {
	const runId = "11111111-1111-4111-8111-111111111111";
	const native = path.join(root, "native", runId);
	let key = "invoke-human-1.l1.review.director-synthesis";
	const file = path.join(root, "originals", key + ".json");
	mkdirSync(native, { recursive: true }); mkdirSync(path.dirname(file), { recursive: true });
	const original = { status: "ready", memo: "COMPLETE ORIGINAL\n" + "source evidence ".repeat(1000), findings: [] };
	const mission = path.join(root, "mission.json"), statePath = path.join(root, "mission-1", "state.json");
	const context = { missionId: "mission-1", missionPath: mission, invocation: "human-1", sourceRefs: [] };
	const association = { ...context, root, source: "/spec.md", digest: "e".repeat(64), commonDir: path.join(root, ".git"), maxCycles: 3 };
	const store = new PitakoStore(root), scope = "exec:human-1.e0";
	const identity = store.activate(scope);
	const commit = (kind: string, body: unknown) => {
		const head = store.read(scope).head;
		const saved = store.commit(scope, head, kind + ":" + (head?.seq ?? 0), canonicalDigest(body), () => ({ kind, body }));
		if (saved.outcome !== "appended" || !saved.head) throw Error("Expected fixture append");
		return saved.head;
	};
	const head = commit("root-admission", { association, admissionBinding: "b".repeat(64), amendments: [] });
	const input = { seq: head.seq, digest: head.hash };
	const cursor: ExecuteCursor = {
		version: EXECUTE_STATE_VERSION, storeId: identity.storeId, root, invocation: "human-1", epoch: 0,
		associationDigest: canonicalDigest(association), admissionBinding: "b".repeat(64), head,
		action: { kind: "launched", key, runId, role: "reviewer", input },
		loop: { number: 1, phase: "review", cursor: 0, taskId: null, outcome: null, attempt: null },
		inFlight: [], halt: null, hostHalt: null,
		timeouts: { reviewerMs: 1000, workerMs: 1000, gateFloorMs: 0 },
		models: { taskReviewer: "fixture/reviewer", taskSynthesis: "fixture/synthesis", r1: "fixture/r1", r2: "fixture/r2", synthesis: "fixture/synthesis" },
		budget: { consumedLoops: 1, maxCycles: 3, rejectedKeys: [], lastProgress: null },
		backlogDigest: null, boardTopicId: 1,
		review: { generation: 1, phase: "review", slots: [{ key, runId, phase: "reviewer", digest: null }], verifier: null },
	};
	const child = { key, runId, workflowRunId: "parent", agent: "pitako.reviewer", status: "completed", artifactPaths: [native, file] };
	const status = { runId, workflowKey: key, cwd: root, state: "complete", steps: [{ exitCode: 0, structuredOutput: original }] };
	const persist = () => {
		mkdirSync(path.dirname(statePath), { recursive: true });
		writeFileSync(statePath, JSON.stringify({ "pitako-execute": cursor }));
		writeFileSync(mission, JSON.stringify({ id: "mission-1", workflowChildren: [child] }));
	};
	writeFileSync(file, JSON.stringify(original));
	writeFileSync(path.join(native, "status.json"), JSON.stringify(status));
	persist();
	const select = (nextKey: string, phase = "review") => {
		key = nextKey; child.key = key; child.artifactPaths = [native, path.join(path.dirname(file), key + ".json")];
		writeFileSync(child.artifactPaths[1]!, JSON.stringify(original));
		status.workflowKey = key; writeFileSync(path.join(native, "status.json"), JSON.stringify(status));
		cursor.loop!.phase = phase;
		cursor.action = { kind: "launched", key, runId, role: "reviewer", input };
		cursor.review!.slots = [{ key, runId, phase: "reviewer", digest: null }]; persist();
	};
	const load = () => retainedAnalyses(root, "/spec.md", "e".repeat(64), context);
	const bound = () => boundRetainedAnalyses(root, association.commonDir, "/spec.md", "e".repeat(64), "b".repeat(64), context);
	return { root, native, file, mission, statePath, original, cursor, child, status, association, store, scope, commit, persist, select, load, bound, runId };
}
test("reads full originals from a saved execute cursor without reader writes", () => fixture(f => {
	const state = readFileSync(f.statePath), database = readFileSync(f.store.file);
	expect(f.load()).toEqual([{ key: f.child.key, runId: f.runId, agent: f.child.agent,
		ok: true, state: "complete", structuredOutput: f.original }]);
	expect(readFileSync(f.statePath)).toEqual(state); expect(readFileSync(f.store.file)).toEqual(database);
	expect(f.bound()!.originals).toHaveLength(1);
}));
test.each(["file", "native-status"])("an absent optional %s does not discard a surviving full original", absent => fixture(f => {
	rmSync(absent === "file" ? f.file : path.join(f.native, "status.json"));
	expect(f.load()).toMatchObject([{ ok: true, structuredOutput: f.original }]);
}));
test.each(["task-reviewer", "task-synthesis", "demand-observation", "compliance", "review.director-synthesis"])(
	"only current generation references are read for %s", role => fixture(f => {
		f.select(`invoke-human-1.l1.${role.startsWith("task-") ? "t1.a1." : ""}g2.${role}`,
			role === "demand-observation" ? "director" : role.startsWith("task-") ? "implementation" : "review");
		expect(f.load()).toMatchObject([{ key: f.child.key, ok: true }]);
		f.cursor.review!.slots = []; f.cursor.action = { kind: "pending", op: "advance", opKey: "next", input: { seq: f.cursor.head.seq, digest: f.cursor.head.hash } }; f.persist();
		expect(f.load()).toEqual([]);
	}));
test.each(["complete", "changed", "stopped", "missing"])("bound task-review replay verifies the committed original (%s)", mode => fixture(f => {
	f.select("invoke-human-1.l1.t1.a1.task-reviewer", "implementation");
	f.cursor.head = f.commit("review-originals", { originals: [{ key: f.child.key, runId: f.runId, path: f.child.artifactPaths[1], body: f.original }] }); f.persist();
	if (mode === "changed") writeFileSync(f.child.artifactPaths[1]!, JSON.stringify({ status: "different" }));
	if (mode === "stopped") { f.status.state = "stopped"; writeFileSync(path.join(f.native, "status.json"), JSON.stringify(f.status)); }
	if (mode === "missing") { rmSync(f.child.artifactPaths[1]!); rmSync(path.join(f.native, "status.json")); }
	if (mode === "complete" || mode === "missing") expect(f.bound()).toBeUndefined();
	else expect(f.bound()!.originals).toMatchObject([{ ok: false }]);
}));
test("a committed original beyond cursor.head cannot suppress a pending review", () => fixture(f => {
	f.select("invoke-human-1.l1.t1.a1.task-reviewer", "implementation");
	f.commit("review-originals", { originals: [{ key: f.child.key, runId: f.runId, body: f.original }] });
	expect(f.bound()!.originals).toHaveLength(1);
	f.cursor.action = { kind: "pending", op: "gate", opKey: "invoke-human-1.l1.t1.a1.gate",
		input: { seq: f.cursor.head.seq, digest: f.cursor.head.hash }, gateTimeoutMs: 1000,
		gateTimeouts: [1000], gateMetricMs: 0 };
	f.persist();
	expect(f.bound()).toBeUndefined();
	expect(f.load()).toEqual([]);
}));
test("admitted task-review references suppress replay only at the saved head and with matching originals", () => fixture(f => {
	f.select("invoke-human-1.l1.t1.a1.task-reviewer", "implementation");
	const head = f.commit("ledger", { entries: [{ kind: "unit", body: { result: { taskReview: {
		reviewer: { key: f.child.key, runId: f.runId, path: f.child.artifactPaths[1], digest: canonicalDigest(f.original) },
	} } } }] });
	expect(f.bound()!.originals).toHaveLength(1);
	f.cursor.head = head; f.persist();
	expect(f.bound()).toBeUndefined();
	f.status.state = "stopped";
	writeFileSync(path.join(f.native, "status.json"), JSON.stringify(f.status));
	expect(f.bound()!.originals).toMatchObject([{ ok: false, state: "stopped" }]);
	f.status.state = "complete";
	f.status.steps[0]!.structuredOutput = { ...f.original, memo: "changed" };
	writeFileSync(path.join(f.native, "status.json"), JSON.stringify(f.status));
	writeFileSync(f.child.artifactPaths[1]!, JSON.stringify(f.status.steps[0]!.structuredOutput));
	expect(f.bound()!.originals).toMatchObject([{ ok: false }]);
}));
test("semantic comparison accepts property order but rejects conflicting complete originals", () => fixture(f => {
	writeFileSync(f.file, JSON.stringify(Object.fromEntries(Object.entries(f.original).reverse())));
	expect(f.load()).toMatchObject([{ ok: true }]);
	writeFileSync(f.file, JSON.stringify({ ...f.original, memo: "changed" }));
	expect(f.load()).toMatchObject([{ ok: false, error: "Conflicting complete retained analysis originals." }]);
}));
test.each(["association", "binding", "sources", "corrupt-state", "missing-store", "ahead"])(
	"unavailable or conflicting authority is not a fresh admission (%s)", mode => fixture(f => {
		if (mode === "association") f.association.missionId = "other";
		if (mode === "binding") f.cursor.admissionBinding = "c".repeat(64);
		if (mode === "sources") f.association.sourceRefs.push({} as never);
		if (["association", "sources"].includes(mode)) {
			f.cursor.head = f.commit("root-admission", { association: f.association, admissionBinding: f.cursor.admissionBinding });
			f.cursor.associationDigest = canonicalDigest(f.association);
		}
		if (mode === "ahead") f.cursor.head.seq++;
		f.persist();
		if (mode === "corrupt-state") writeFileSync(f.statePath, "{invalid");
		if (mode === "missing-store") rmSync(f.store.file);
		expect(f.bound).toThrow();
	}));
test.each(["failed", "stopped", "running"])("preserves current native %s state, even after status retention", state => fixture(f => {
	f.status.state = state; writeFileSync(path.join(f.native, "status.json"), JSON.stringify(f.status));
	expect(f.load()).toMatchObject([{ ok: false, state }]);
	f.child.status = state; f.persist(); rmSync(path.join(f.native, "status.json"));
	expect(f.load()).toMatchObject([{ ok: false, state }]);
}));
test("native producer conflicts and symlink escapes never supply authority", () => fixture(f => {
	f.status.workflowKey = "foreign"; writeFileSync(path.join(f.native, "status.json"), JSON.stringify(f.status));
	expect(f.load()).toMatchObject([{ ok: false, error: "Retained native producer conflicts with its reference." }]);
	f.status.workflowKey = f.child.key; writeFileSync(path.join(f.native, "status.json"), JSON.stringify(f.status));
	const outside = path.join(f.root, "outside.json"); writeFileSync(outside, JSON.stringify(f.original));
	rmSync(f.file); symlinkSync(outside, f.file);
	expect(f.load()).toMatchObject([{ ok: false }]);
}));
test.each(["stopped", "interrupted", "detached"])("emitting JSON does not erase a native %s barrier", field => fixture(f => {
	Object.assign(f.status.steps[0]!, { [field]: true });
	writeFileSync(path.join(f.native, "status.json"), JSON.stringify(f.status));
	expect(f.load()).toMatchObject([{ ok: false, [field]: true }]);
}));
test("legacy keys and missing state do not authorize a historical scan", () => fixture(f => {
	writeFileSync(f.statePath, JSON.stringify({ "invoke-human-1": { version: 9, association: f.association, loop: {} } }));
	expect(f.load()).toEqual([]);
	rmSync(f.statePath); expect(f.load()).toEqual([]);
}));
