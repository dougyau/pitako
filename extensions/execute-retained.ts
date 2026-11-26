import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import { executionStatePath } from "./execute-state.ts";
import { EXECUTE_CURSOR_KEY, type ExecuteCursor } from "./execute-cursor.ts";
import { readExecuteAdmission, readExecuteProgress } from "./execute-progress.ts";
import { canonicalDigest } from "./canonical.mjs";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";
import { StoreError } from "./pitako-store.ts";
import { nativeSettlementMatchesAgent, readWorkerOriginal } from "../skills/execute/loop.ts";
import { planConflictReason, checkpointMismatchReason, settledBarrier, inspectorConflictReason, viewOverflowReason, checkpointWitnessIssue } from "../skills/execute/halt-evidence.mjs";
import type { ExecuteIntentBody } from "./execute-intent.ts";
const { safePath } = createRequire(import.meta.url)("./hash-ledger.mjs") as { safePath(file: string): string };

const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
function haltExcerpt(reason: string) {
	let result = "", remaining = 1080;
	for (const point of reason.replace(/[\uD800-\uDFFF]/gu, "\uFFFD")) {
		const bytes = Buffer.byteLength(JSON.stringify(point)) - 2;
		if (bytes > remaining || result.length + point.length > 360) break;
		result += point;
		remaining -= bytes;
	}
	return result;
}
function readJson(file: string): unknown {
	try { return JSON.parse(readFileSync(file, "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function earlyAnalysisReplayGap(cursor: ExecuteCursor, missionPath: string, missionId: string) {
	const { action, loop } = cursor;
	if (cursor.halt || cursor.hostHalt || !loop || action.kind !== "launched" || action.role !== "reviewer")
		return;
	const prefix = `invoke-${cursor.invocation}${cursor.epoch ? `.e${cursor.epoch}` : ""}`;
	const base = `${prefix}.l${loop.number}`;
	const demand = loop.phase === "director" && loop.number > 1 &&
		["", ".g2", ".g3"].some(generation => action.key === `${base}${generation}.demand-observation`);
	const review = !loop.taskId && ["implementation", "review"].includes(loop.phase) &&
		(/\.review\.(?:director-prepare|independent-[A-Za-z0-9_.-]+-r[12])$/.test(action.key) ||
			(cursor.review?.generation ?? 1) > 1 && action.runId === null && action.key.endsWith(".review.director-synthesis"));
	if (!demand && !review) return;
	const kind = demand ? "demand" : "review";
	// Demand can replay either advance form, but both use the one early replay allowance.
	const retryKeys = demand ? [`${base}.advance.r1`, `${prefix}.l${loop.number - 1}.nextAdvance.r1`]
		: [`${base}.acceptance.gate.r1`];
	const mission = readJson(missionPath);
	if (!record(mission) || mission.id !== missionId || !Array.isArray(mission.workflowChildren))
		throw new Error(`Early ${kind} replay native mission identity mismatch.`);
	const children = mission.workflowChildren;
	const admitted = retryKeys.find(key => children.some(child => record(child) && child.key === key));
	if (admitted)
		return `early-${kind}-replay-gap: early-cut class B: ${admitted} was already admitted and cannot bind the current ${kind} originals.`;
}

class NativeSettlementError extends Error {
	readonly kind: "missing" | "conflict";

	constructor(kind: "missing" | "conflict") {
		super(kind === "missing" ? "Native settlement unavailable." : "Native settlement integrity failure: conflicting records.");
		this.kind = kind;
	}
}

export function readNativeSettlement(file: string, key: string, runId: string, agent: string) {
	if (!path.isAbsolute(file) || path.basename(file) !== "workflow-children.jsonl")
		throw new Error("Invalid native settlement path.");
	const settlements = readFileSync(safePath(file), "utf8").split("\n").flatMap(line => {
		try { return [JSON.parse(line)]; } catch { return []; }
	}).filter(entry => entry.type === "settle" && entry.key === key && entry.result?.runId === runId);
	if (!settlements.length) throw new NativeSettlementError("missing");
	const settled = settlements.at(-1)?.result;
	if (!record(settled) || !nativeSettlementMatchesAgent(settled, agent) ||
		settled.key !== undefined && settled.key !== key && settled.key !== runId ||
		settlements.some(entry => !isDeepStrictEqual(entry.result, settled)))
		throw new NativeSettlementError("conflict");
	return settled;
}

function readBoundStatus(root: string, admission: ReturnType<typeof readExecuteAdmission>["admission"]["association"],
	producer: { key: string; runId: string | null }, agent: string) {
	const mission = readJson(admission.missionPath);
	const family = pitakoAgentFamily(agent);
	const children = record(mission) && mission.id === admission.missionId && Array.isArray(mission.workflowChildren)
		? mission.workflowChildren.filter(child => child.key === producer.key &&
			(producer.runId === null || child.runId === producer.runId)) : [];
	const producerAgent = children[0]?.agent;
	const runId = children.length === 1 ? children[0].runId : undefined;
	const directories = children.length === 1 && Array.isArray(children[0].artifactPaths)
		? children[0].artifactPaths.filter((file: unknown): file is string =>
			typeof file === "string" && path.isAbsolute(file) && path.basename(file) === runId) : [];
	if (typeof runId !== "string" || directories.length !== 1 || !family || pitakoAgentFamily(producerAgent) !== family)
		throw new Error("Retained halt native producer or path integrity failure.");
	const directory = directories[0];
	const status = readJson(safePath(path.join(directory, "status.json")));
	if (!record(status) || status.runId !== runId || status.workflowKey !== producer.key ||
		status.cwd !== root || typeof status.parentWorkflowRunId !== "string" ||
		path.basename(status.parentWorkflowRunId) !== status.parentWorkflowRunId ||
		Array.isArray(status.steps) && status.steps.some(step => step?.agent !== producerAgent))
		throw new Error("Retained halt native status integrity failure.");
	return { status, directory, runId, agent: producerAgent,
		journal: path.join(path.dirname(directory), status.parentWorkflowRunId, "workflow-children.jsonl") };
}

function readBoundSettlement(...args: Parameters<typeof readBoundStatus>) {
	const { status, runId, journal, agent } = readBoundStatus(...args);
	return { timeoutMs: status.timeoutMs, result: readNativeSettlement(journal, args[2].key, runId, agent) };
}

function readHaltSettlement(...args: Parameters<typeof readBoundSettlement>) {
	return readBoundSettlement(...args).result;
}

export function verifyComplianceRenewal(root: string, association: Parameters<typeof readBoundSettlement>[1],
	base: string, producer: { key: string; runId: string }) {
	const prefix = base.slice(0, -".compliance".length);
	const keys = [base, `${prefix}.g2.compliance`, `${prefix}.g3.compliance`];
	const index = keys.indexOf(producer.key);
	let deadline = 0;
	if (index < 1) throw new Error("Invalid compliance renewal key.");
	for (const key of keys.slice(0, index + 1)) {
		const prior = key !== producer.key;
		const { result, timeoutMs } = readBoundSettlement(root, association,
			{ key, runId: prior ? null : producer.runId }, "pitako.reviewer");
		const entries = [result, ...(Array.isArray(result.results) ? result.results.filter(record) : [])];
		if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= deadline ||
			timeoutMs > 86400000 || settledBarrier(result) ||
			entries.some(entry => entry.state === "cancelled" || record(entry.terminalOutcome) &&
				["cancelled", "stopped", "budget_exhausted"].includes(String(entry.terminalOutcome.reason))) ||
			(prior && !entries.some(entry => entry.timedOut === true ||
				record(entry.terminalOutcome) && entry.terminalOutcome.reason === "timeout")))
			throw new Error("Compliance renewal lacks exact terminal timeout and raised deadline evidence.");
		deadline = timeoutMs;
	}
	return deadline;
}

function nativeHaltWitness(native: Record<string, unknown>, key: string, agent: string) {
	const cause = settledBarrier(native);
	if (typeof native.runId === "string" && cause && !["running", "queued", "pending"].includes(cause))
		// The verified settlement names the producer's actual role agent.
		return { ref: { key, runId: native.runId, agent: typeof native.agent === "string" ? native.agent : agent }, cause, originalDigest: canonicalDigest(native) };
}

function readCheckpointWitness(root: string, missionPath: string, missionId: string,
	producer: { key: string; runId: string }, binding: string) {
	const mission = readJson(missionPath);
	const runs = record(mission) && mission.id === missionId && Array.isArray(mission.runs)
		? mission.runs.filter(run => run.runId === producer.runId && run.mode === "workflow") : [];
	const directory = runs.length === 1 && runs[0].asyncDir;
	if (typeof directory !== "string" || !path.isAbsolute(directory) || path.basename(directory) !== producer.runId ||
		!/^inspect-initial(?:\.r[12])?$/.test(producer.key))
		throw new Error("Checkpoint observation native workflow integrity failure.");
	const status = readJson(safePath(path.join(directory, "status.json")));
	if (!record(status) || status.runId !== producer.runId || status.cwd !== root ||
		!record(status.workflowGraph) || status.workflowGraph.runId !== producer.runId ||
		!Array.isArray(status.workflowGraph.nodes) || !status.workflowGraph.nodes.some(node =>
			node.kind === "host-step" && node.id === producer.key &&
			node.hostStep?.verdict === "pass" && node.hostStep.reportPath === `${producer.key}.log`))
		throw new Error("Checkpoint observation native host step integrity failure.");
	// Native artifact placement is session, project, or temp. Use only the
	// exact named report of this receipted root, never a newer inspection.
	const locations = new Set([
		path.join(root, ".pi/subagents/artifacts"),
		path.join(path.dirname(path.dirname(directory)), "artifacts"),
		...(typeof status.sessionId === "string" && path.isAbsolute(status.sessionId)
			? [path.join(path.dirname(status.sessionId), "subagent-artifacts")] : []),
	]);
	const logs = [...locations].flatMap(location => {
		const file = safePath(path.join(location, "outputs", producer.runId, "host", `${producer.key}.log`));
		try {
			const info = statSync(file);
			if (!info.isFile() || info.size > 61440) throw new Error("Checkpoint observation native log integrity failure.");
			return [readFileSync(file, "utf8")];
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	});
	const originals = logs[0]?.split("\n").filter(line => line.startsWith("{"));
	if (logs.length !== 1 || originals?.length !== 1 || Buffer.byteLength(originals[0]!) > 4096)
		throw new Error("Checkpoint observation native original missing, ambiguous or invalid.");
	const value = JSON.parse(originals[0]!);
	if (value.version !== 1 || value.binding !== binding || !record(value.checkpointObservation))
		throw new Error("Checkpoint observation native admission integrity mismatch.");
	return value.checkpointObservation;
}

/** Small halt witnesses from the verified prefix, not a new source of replay inputs. */
export function retainedExecuteHalt(root: string, value: ExecuteCursor) {
	const closing = !value.halt && !value.hostHalt && value.loop && value.action.kind === "launched" &&
		value.action.role === "reviewer" && (value.action.key.endsWith(".compliance") ||
			value.loop.phase === "closing" && value.action.runId && value.action.key.endsWith(".director-synthesis"));
	if (!value.halt && !closing) return;
	const { cursor, records, admission } = readExecuteAdmission(root, value);
	const { halt, loop, action } = cursor;
	const last = cursor.inFlight.at(-1);
	if (halt?.stage === "checkpoint-witness" && last?.role === "host-observation" && loop?.attempt?.intent) {
		const pointer = loop.attempt.intent;
		const row = records[pointer.seq - 1];
		const intent = row?.kind === "intent" && row.digest === pointer.digest ? row.body as ExecuteIntentBody : null;
		if (!intent) throw new Error("Checkpoint observation intent integrity failure.");
		const ref = { key: last.key, runId: last.runId };
		const witness = readCheckpointWitness(root, admission.association.missionPath, admission.association.missionId,
			ref, cursor.admissionBinding);
		const reason = checkpointWitnessIssue(witness, intent);
		if (!reason) throw new Error("Checkpoint observation native original integrity failure.");
		return { conflict: { reason: haltExcerpt(reason), ref, originalDigest: canonicalDigest(witness) } };
	}
	if (halt?.stage === "native-settlement") {
		const producer = cursor.inFlight.at(-1);
		if (!producer) throw new Error("Barrier lacks its exact native producer.");
		const { key, runId, role } = producer;
		const agent = `pitako.${role}`;
		const native = nativeHaltWitness(readHaltSettlement(root, admission.association, { key, runId }, agent), key, agent);
		if (native) return { native };
		throw new Error("Native barrier settlement integrity failure.");
	}
	if (closing && loop && action.kind === "launched") {
		const checkoutKey = `invoke-${cursor.invocation}${cursor.epoch ? `.e${cursor.epoch}` : ""}.l${loop.number}.checkout`;
		const attempt = (key: string) => key === checkoutKey ? 0 :
			key.startsWith(`${checkoutKey}.r`) && /^[1-9]\d*$/.test(key.slice(checkoutKey.length + 2))
				? Number(key.slice(checkoutKey.length + 2)) : NaN;
		// A new root's status lookup cannot resolve the prior workflow's key to a run ID.
		const checkouts = new Map<number, { key: string; runId: string }>();
		function remember(key: string, runId: string) {
			const index = attempt(key);
			if (!Number.isSafeInteger(index)) return;
			if (checkouts.has(index) && checkouts.get(index)!.runId !== runId)
				throw new Error(`Closing producer identity changed for ${key}.`);
			checkouts.set(index, { key, runId });
		}
		const mission = readJson(admission.association.missionPath);
		const analyses: { key: string; runId: string; agent: unknown }[] = [];
		if (record(mission) && mission.id === admission.association.missionId && Array.isArray(mission.workflowChildren))
			for (const child of mission.workflowChildren) {
				if (!record(child) || typeof child.key !== "string" || typeof child.runId !== "string") continue;
				if (child.agent === "pitako.checkout-observer")
					remember(child.key, child.runId);
				if (child.key === action.key && (action.runId === null || child.runId === action.runId))
					analyses.push({ key: child.key, runId: child.runId, agent: child.agent });
			}
		const closingAnalysis = analyses.length === 1 && pitakoAgentFamily(analyses[0]?.agent) === "reviewer"
			? analyses[0] : undefined;
		for (const ref of cursor.inFlight)
			if (ref.role === "checkout-observer") remember(ref.key, ref.runId);
		let next = 0, latest = -1;
		while (checkouts.has(next)) next++;
		for (const index of checkouts.keys()) latest = Math.max(latest, index);
		const checkout = checkouts.get(latest);
		function settlement(key: string, runId: string | null, agent: string) {
			try {
				return readHaltSettlement(root, admission.association, { key, runId }, agent);
			} catch {
				// Before settlement, missing evidence is normal. A reported terminal barrier must match a witness.
				return undefined;
			}
		}
		const agent = "pitako.checkout-observer";
		function checkoutEvidence(ref: { key: string; runId: string }) {
			try {
				const { status, directory, runId, journal, agent: producerAgent } = readBoundStatus(root, admission.association, ref, agent);
				try {
					return { result: readNativeSettlement(journal, ref.key, runId, producerAgent) };
				} catch (error) {
					if (error instanceof NativeSettlementError) {
						if (error.kind !== "missing") throw error;
					} else if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
					// Without a settlement, bound checkout stdout can still identify a committed publication.
					const step = Array.isArray(status.steps) && status.steps.length === 1 ? status.steps[0] : null;
					const process = step?.externalProcess;
					const stdout = process?.stdoutPath;
					if (status.state !== "complete" || step?.agent !== agent || step.runner?.type !== "external-cli" ||
						step.error || step.stopped || step.interrupted || step.timedOut || step.outputSaveError ||
						step.artifactOutputSaveFailed || step.metadataSaveError || step.transcriptError ||
						process?.exitCode !== 0 || process.processSignal ||
						typeof stdout !== "string" || path.dirname(stdout) !== directory) return;
					const file = safePath(stdout), stat = statSync(file);
					if (stat.isFile() && stat.size <= 61440) return { stdout: readFileSync(file, "utf8") };
				}
			} catch (error) {
				if (error instanceof NativeSettlementError) throw error;
				// A checkout may not have settled or published yet.
			}
		}
		const latestEvidence = checkout && checkoutEvidence(checkout);
		const latestSettlement = latestEvidence?.result;
		const producers = [{ key: checkout?.key ?? checkoutKey, runId: checkout?.runId ?? null, agent },
			...(action.runId ? [{ key: action.key, runId: action.runId, agent: "pitako.reviewer" }] : [])];
		const closingBarriers = producers.flatMap(({ key, runId, agent }) => {
			const result = agent === "pitako.checkout-observer" ? latestSettlement : settlement(key, runId, agent);
			const witness = result && nativeHaltWitness(result, key, agent);
			return witness ? [witness] : [];
		});
		const scope = `exec:${cursor.invocation}.e${cursor.epoch}`;
		// A retry after a lost save can itself fail after an earlier attempt reported COMMIT.
		const publisher = [...checkouts.entries()].sort(([a], [b]) => b - a).map(([, ref]) => ref).find(ref => {
			const evidence = ref === checkout ? latestEvidence : checkoutEvidence(ref);
			const result = evidence?.result;
			if (result && (result.ok !== true || settledBarrier(result) || result.state !== undefined || result.terminalOutcome ||
				!Array.isArray(result.results) || result.results.length !== 1 || result.results[0]?.exitCode !== 0)) return false;
			const output = result?.output ?? evidence?.stdout;
			if (typeof output !== "string" || Buffer.byteLength(output) > 61440) return false;
			try {
				const receipt = JSON.parse(output);
				const head = receipt?.store?.head, references = receipt?.store?.P?.preview?.closeReferences;
				return receipt?.ok === true && receipt.version === 1 && receipt.root === root &&
					receipt.commonDir === admission.association.commonDir && receipt.store.storeId === cursor.storeId &&
					Number.isSafeInteger(head?.seq) && head.seq > action.input.seq && /^[a-f0-9]{64}$/.test(head.hash) &&
					(head.seq > cursor.head.seq || records[head.seq - 1]?.digest === head.hash) &&
					Array.isArray(references) && references.some(ref => ref?.loop === loop.number &&
						ref.scope === scope && ref.seq === head.seq && ref.digest === head.hash);
			} catch {
				return false;
			}
		});
		return { closingCheckout: { ref: checkout ?? null, nextKey: next ? `${checkoutKey}.r${next}` : checkoutKey,
			settled: !!latestSettlement, ...(publisher ? { publisher } : {}) },
			...(closingAnalysis ? { closingAnalysis } : {}),
			...(closingBarriers.length ? { closingBarriers } : {}) };
	}
	if (halt?.stage === "plan-conflict" && last?.role === "execution-inspector") {
		const ref = { key: last.key, runId: last.runId };
		const native = readHaltSettlement(root, admission.association, ref, "pitako.execution-inspector");
		const reason = inspectorConflictReason(native, isDeepStrictEqual);
		if (!reason) throw new Error("Inspector conflict native original integrity failure.");
		return { conflict: { reason: haltExcerpt(reason), ref,
			originalDigest: canonicalDigest({ value: native.structuredOutput,
				...(native.output === undefined ? {} : { output: native.output }) }) } };
	}
	if (halt?.stage === "plan-conflict" && action.kind === "launched" &&
		action.role === "execution-director" && action.runId) {
		const ref = { key: action.key, runId: action.runId };
		const native = readHaltSettlement(root, admission.association, ref, "pitako.execution-director");
		const reason = planConflictReason(native.structuredOutput, native, ref.runId, isDeepStrictEqual);
		if (reason) return { conflict: { reason, ref,
			originalDigest: canonicalDigest({ ...(native.structuredOutput === undefined ? {} : { value: native.structuredOutput }),
				...(native.output === undefined ? {} : { output: native.output }) }) } };
	}
	if (halt && ["backlog-conflict", "view-overflow"].includes(halt.stage)) {
		const producer = [...cursor.inFlight].reverse().find(ref => ref.role === "loop-io");
		if (!producer) throw new Error(`${halt.stage} native producer integrity failure.`);
		const ref = { key: producer.key, runId: producer.runId };
		const native = readHaltSettlement(root, admission.association, ref, "pitako.loop-io");
		const line = typeof native.output === "string" ? native.output.trim().split("\n").at(-1) : undefined;
		if (!line || Buffer.byteLength(line) > 61440)
			throw new Error(`${halt.stage} native receipt integrity failure.`);
		const receipt = JSON.parse(line);
		if (halt.stage === "view-overflow" && receipt?.overflowAdmission && cursor.backlogDigest === null) {
			const { head, storeId, associationDigest, topicId, key } = receipt.overflowAdmission;
			const operation = records[cursor.head.seq - 1];
			if (!isDeepStrictEqual(head, cursor.head) || storeId !== cursor.storeId ||
				associationDigest !== cursor.associationDigest || topicId !== cursor.boardTopicId ||
				operation?.opKey !== `operation:${key}` || ref.key.replace(/\.r\d+$/, "") !== key)
				throw new Error("Board overflow committed admission integrity mismatch.");
		}
		const reason = halt.stage === "view-overflow" ? viewOverflowReason(receipt) :
			receipt?.error === "loop-io" && typeof receipt.reason === "string" && receipt.reason.startsWith("backlog-conflict:")
				? receipt.reason : null;
		if (reason) return { conflict: { reason: haltExcerpt(reason), ref, originalDigest: canonicalDigest(receipt) } };
	}
	if (halt?.stage === "checkpoint-integrity") {
		const producer = [...cursor.inFlight].reverse().find(ref => ref.role === "checkpoint-sealer" ||
			ref.role === "loop-io" && /\.close(?:\.r\d+)?$/.test(ref.key));
		if (producer) {
			const native = readHaltSettlement(root, admission.association, producer, `pitako.${producer.role}`);
			// The halt names the producer's actual role agent, as the workflow recorded it.
			const ref = { key: producer.key, runId: producer.runId, agent: native.agent };
			if (native.ok !== true || typeof native.output !== "string" || Buffer.byteLength(native.output) > 61440)
				throw new Error("Checkpoint halt native receipt integrity failure.");
			const receipt = JSON.parse(native.output.trim().split("\n").at(-1)!);
			const observed = producer.role === "checkpoint-sealer" ? receipt :
				receipt.projection?.steps.find((step: { operation: string }) => step.operation === "seal")?.result.receipt;
			if (observed?.outcome === "mismatch" && Array.isArray(observed.paths))
				return { checkpoint: { reason: checkpointMismatchReason(observed.paths), ref,
					originalDigest: canonicalDigest(observed) } };
			throw new Error("Checkpoint halt native original integrity failure.");
		}
	}
	if (!halt || !loop || action.kind !== "pending") return;
	if (halt.stage === "semantic-block" && loop.phase === "implementation" && loop.outcome === "blocked") {
		const close = records.find(row => row.seq === action.input.seq && row.digest === action.input.digest);
		const body = close?.body as { operation?: string; request: { key: string; gate: Parameters<typeof readWorkerOriginal>[0] } } | undefined;
		if (close?.kind !== "operation" || body?.operation !== "close") return;
		const input = body.request.gate;
		const receipt = [...records].reverse().find(row => row.kind === "marker" &&
			(row.body as { key?: string }).key === `${body.request.key}.gate`);
		const gate = (receipt?.body as { workerOriginal?: ReturnType<typeof readWorkerOriginal>;
			result?: { receipt?: { mutated: boolean; stalled: boolean; gates: { id: string; status: string; logRef: string; tail: string }[] } } } | undefined);
		const saved = gate?.workerOriginal;
		const original = readWorkerOriginal(input, false);
		if (!saved) throw new Error("Blocked worker committed gate original is missing.");
		const worker = original.value;
		if (!isDeepStrictEqual(saved.reference, original.reference) ||
			worker.status !== "blocked" || typeof worker.work !== "string" ||
			!Array.isArray(worker.remaining) || !worker.remaining.every(item => typeof item === "string"))
			throw new Error("Blocked worker native original integrity mismatch.");
		const observed = gate?.result?.receipt;
		const diagnosis = observed?.mutated ? "Gate commands mutated the candidate."
			: observed?.stalled ? "Three consecutive non-improving attempts; return the task to the director."
			: observed?.gates.filter(entry => entry.status !== "pass").map(entry =>
				`${entry.id}: ${entry.status}; ${entry.logRef}; ${entry.tail.slice(0, 128)}`).join("\n") ||
				worker.remaining.join("; ") || worker.work;
		const { sha256: digest, ...ref } = original.reference;
		// The root applies the same excerpt rule as ordinary worker admission.
		return { worker: { diagnosis: diagnosis.slice(0, 360), ref: { ...ref, digest } } };
	}
	if (halt.stage === "needs-decision") {
		const key = `invoke-${cursor.invocation}${cursor.epoch ? `.e${cursor.epoch}` : ""}.l${loop.number}.settlement`;
		const settled = [...records].reverse().find(row => row.kind === "marker" &&
			(row.body as { key?: string }).key === key);
		const needsDecision = (settled?.body as { result?: { needsDecision?: unknown } } | undefined)?.result?.needsDecision;
		if (record(needsDecision)) return { needsDecision };
	}
	if (["repeat-acceptance", "environment"].includes(halt.stage) && action.op === "gate") {
		const producer = cursor.inFlight.find(ref => ref.role === "loop-io" &&
			ref.key.replace(/\.r\d+$/, "") === (cursor.action.kind === "pending" && cursor.action.opKey));
		if (!producer) throw new Error("Final acceptance halt native producer integrity failure.");
		const native = readHaltSettlement(root, admission.association, producer, "pitako.loop-io");
		if (!native.ok || typeof native.output !== "string" || Buffer.byteLength(native.output) > 61440)
			throw new Error("Final acceptance halt native receipt integrity failure.");
		const saved = JSON.parse(native.output.trim().split("\n").at(-1)!);
		const { finalGate: _ref, storeId: _id, receiptDigest: _digest, ...inline } = saved;
		const gate = saved.receipt ?? inline;
		const final = records.find(row => row.opKey === `final-gate:${action.opKey}`);
		const finalBody = final?.body as { receiptDigest: string } | undefined;
		if (final?.kind !== "final-gate" || finalBody?.receiptDigest !== canonicalDigest(gate))
			throw new Error("Final acceptance halt gate record integrity mismatch.");
		type Selection = { operation: string; request: { key: string; apply?: { key: string } } };
		const selection = [...records].reverse().find(row => {
			if (row.kind !== "operation" || row.seq >= final.seq) return false;
			const { operation, request } = row.body as Selection;
			return operation === "selection" &&
				request.apply?.key.replace(/\.selection(?:\.d1)?$/, ".acceptance.gate") === action.opKey;
		});
		const selectionBody = selection?.body as Selection | undefined;
		const selectionReceipt = records.find(row => row.kind === "receipt" && row.seq > action.input.seq &&
			(row.body as { key?: string }).key === selectionBody?.request?.key);
		const receipt = selectionReceipt?.body as { result?: { steps: { operation: string;
			result: { acceptance?: { id: string; exception?: { humanRef: number } }[] } }[] } } | undefined;
		const acceptance = receipt?.result?.steps.find(step => step.operation === "apply")?.result.acceptance;
		if (selectionBody?.operation !== "selection" || !acceptance || !Array.isArray(gate.gates) || !Array.isArray(gate.view?.posts))
			throw new Error("Final acceptance halt lacks its exact gate or selection original.");
		const failed = gate.gates.filter((result: { id: string; status: string; exit: number }) => {
			const exception = acceptance.find(command => command.id === result.id)?.exception;
			return !(exception && gate.view.posts.some((post: { type: string; id: number }) =>
				post.type === "HUMAN" && post.id === exception.humanRef)) &&
				(halt.stage === "environment" ? ["timeout", "error"].includes(result.status) :
					result.status !== "pass" || result.exit !== 0);
		});
		const results = failed.map((result: { id: string; status: string; logRef: string }) =>
			`${result.id}: ${result.status} (${result.logRef})`).join("; ");
		return { acceptance: { reused: gate.reused, results: results.slice(0, 360) } };
	}
}

/** Only read-only originals already referenced by this invocation's current loop. */
export function retainedAnalyses(root: string, source: string, digest: string, context: unknown) {
	return retainedProjection(root, source, digest, context)?.originals ?? [];
}

/** Preliminary inert originals, independently compared by native admission. */
export function boundRetainedAnalyses(root: string, commonDir: string, source: string, digest: string,
	binding: string, context: unknown) {
	try {
		const projection = retainedProjection(root, source, digest, context, { commonDir, binding });
		if (!projection?.originals.length) return undefined;
		return { ...projection, digest: createHash("sha256").update(JSON.stringify(projection)).digest("hex") };
	} catch (error) {
		if (error instanceof StoreError) throw error;
		throw new Error(`${String(error instanceof Error ? error.message : error)} Selected source ${source}; expected binding ${binding}; observed recovery projection unavailable. Preserve the admitted snapshot and exact native references; inspect the linked originals and reconcile the pending subject under current native authority, without redispatch or automatic recapture.`);
	}
}
function retainedProjection(root: string, source: string, digest: string, context: unknown,
	bound?: { commonDir: string; binding: string }) {
	if (!record(context) || typeof context.missionPath !== "string" || !path.isAbsolute(context.missionPath) ||
		typeof context.invocation !== "string" || typeof context.missionId !== "string")
		throw new Error("Expected exact mission and invocation for retained analysis inspection.");
	const mission = readJson(executionStatePath({ missionPath: context.missionPath, missionId: context.missionId }));
	const value = record(mission) ? mission[EXECUTE_CURSOR_KEY] : undefined;
	if (value === undefined || record(value) && typeof value.invocation === "string" &&
		value.invocation && value.invocation !== context.invocation) return undefined;
	const { cursor, records } = readExecuteProgress(root, value);
	const loop = cursor.loop;
	if (!loop || !["director", "implementation", "review", "compliance"].includes(loop.phase)) return undefined;
	const rootKey = `invoke-${cursor.invocation}${cursor.epoch ? `.e${cursor.epoch}` : ""}`;
	const prefix = `${rootKey}.l${loop.number}.`;
	const generation = cursor.review?.generation ?? 1;
	const suffix = `.l${loop.number}.g${generation}.review.`;
	const reviewPrefix = generation === 1 ? `${prefix}review.` : `${rootKey.length + suffix.length <= 83
		? rootKey : `${rootKey.slice(0, 83 - suffix.length - 13)}-${canonicalDigest(rootKey).slice(0, 12)}`}${suffix}`;
	const subjects = new Map<string, { key: string; runId: string | null }>();
	const haltedGate = /^(?:timeout|gate-renewal-(?:stop|interrupt|permission))$/.test(cursor.halt?.stage ?? "") &&
		cursor.action.kind === "pending" &&
		cursor.action.op === "gate"
		? cursor.inFlight.find(ref => ref.role === "loop-io" && /\.gate(?:\.r\d+)?$/.test(ref.key)) : undefined;
	if (haltedGate) subjects.set(haltedGate.key, haltedGate);
	const haltedReviewSealer = cursor.action.kind === "launched" && cursor.action.role === "reviewer" &&
		/\.task-(reviewer|synthesis)$/.test(cursor.action.key) &&
		["checkpoint-integrity", "native-barrier"].includes(cursor.halt?.stage ?? "")
		? `${cursor.action.key.replace(/\.task-(reviewer|synthesis)$/, "")}.seal` : null;
	if (haltedReviewSealer) subjects.set(haltedReviewSealer, { key: haltedReviewSealer, runId: null });
	const interrupted = ["native-barrier", "native-permission"].includes(cursor.halt?.stage ?? "") && cursor.action.kind === "launched" &&
		["execution-director", "worker", "reviewer"].includes(cursor.action.role) && cursor.action.runId
		? cursor.action : cursor.action.kind === "pending" && ["native-barrier", "native-permission"].includes(cursor.halt?.stage ?? "")
			? [...cursor.inFlight].reverse().find(ref => ref.role === "loop-io" &&
				ref.key.replace(/\.r\d+$/, "") === (cursor.action.kind === "pending" && cursor.action.opKey))
			: undefined;
	if (interrupted) subjects.set(interrupted.key, interrupted);
	const timedOutWorker = cursor.halt?.stage === "timeout" && cursor.action.kind === "launched" &&
		cursor.action.role === "worker" && cursor.action.runId ? cursor.action : undefined;
	if (timedOutWorker) subjects.set(timedOutWorker.key, timedOutWorker);
	for (const ref of [...cursor.inFlight, ...(cursor.review?.slots ?? []),
		...(cursor.review?.verifier ? [cursor.review.verifier] : []),
		...(cursor.action.kind === "launched" ? [cursor.action] : [])]) {
		// A gate cursor can still carry later in-memory review slots after a lost save.
		// Those producers are not part of the operation admitted at this head.
		if (/\.task-(?:reviewer|synthesis)$/.test(ref.key) &&
			(cursor.action.kind === "launched" && cursor.action.role === "worker" ||
				cursor.action.kind === "pending" && cursor.action.op === "gate")) continue;
		if (!(ref.key.startsWith(prefix) || ref.key.startsWith(reviewPrefix)) ||
			!/(?:\.review\.[^.]+|\.task-(?:reviewer|synthesis)|\.compliance|\.demand-observation|\.recover\d+)$/.test(ref.key) ||
			ref.key.endsWith(".demand-observation") && loop.phase !== "director") continue;
		const prior = subjects.get(ref.key);
		if (prior?.runId && ref.runId && prior.runId !== ref.runId)
			throw new Error("Conflicting retained analysis producer references.");
		subjects.set(ref.key, { key: ref.key, runId: ref.runId ?? prior?.runId ?? null });
	}
	if (!subjects.size) return undefined;
	const { admission } = readExecuteAdmission(root, value);
	const association = admission.association;
	if (bound && (cursor.admissionBinding !== bound.binding || association.commonDir !== bound.commonDir ||
		!isDeepStrictEqual(association.sourceRefs, context.sourceRefs)))
		throw new Error("Retained recovery binding differs or predates bound admission. Preserve the original snapshot and native references; restore reliable exact bytes or inspect native state, never migrate or recapture this root.");
	if (association.root !== root || association.source !== source || association.digest !== digest ||
		association.invocation !== context.invocation || association.missionId !== context.missionId ||
		association.missionPath !== context.missionPath)
		throw new Error("Retained analysis association differs from the selected invocation.");
	const nativeMission = readJson(context.missionPath);
	if (!record(nativeMission) || nativeMission.id !== context.missionId)
		throw new Error("Retained native mission identity differs.");
	const action = cursor.action;
	const pendingTaskReview = !cursor.halt && !cursor.hostHalt && loop.phase === "implementation" &&
		action.kind === "launched" && action.role === "reviewer" && action.runId === null &&
		/\.task-(reviewer|synthesis)$/.test(action.key) ? action.key : null;
	if (pendingTaskReview && !Array.isArray(nativeMission.workflowChildren))
		throw new Error("Task review recovery native child inventory unavailable.");
	const children = Array.isArray(nativeMission.workflowChildren) ? nativeMission.workflowChildren.filter(record) : [];
	// Missing run ids attach only to the same native workflow as a receipted sibling.
	const parents = new Set(children.filter(child => [...subjects.values()].some(ref =>
		ref.runId && child.key === ref.key && child.runId === ref.runId)).map(child => child.workflowRunId));
	if (haltedReviewSealer) {
		// A later seal retry can belong to a relaunched root, unlike its review originals.
		const sealers = children.filter(child => typeof child.key === "string" &&
			(child.key === haltedReviewSealer || child.key.startsWith(`${haltedReviewSealer}.r`) &&
				/^[1-9]\d*$/.test(child.key.slice(haltedReviewSealer.length + 2)))).sort((a, b) =>
				Number(String(b.key).match(/\.r(\d+)$/)?.[1] ?? 0) -
				Number(String(a.key).match(/\.r(\d+)$/)?.[1] ?? 0));
		if (sealers.length) {
			subjects.delete(haltedReviewSealer);
			subjects.set(String(sealers[0]!.key), { key: String(sealers[0]!.key), runId: String(sealers[0]!.runId) });
		}
	}
	const isSealer = (key: unknown) => typeof key === "string" && haltedReviewSealer &&
		(key === haltedReviewSealer || key.startsWith(`${haltedReviewSealer}.r`));
	const isGate = (key: unknown) => key === haltedGate?.key;
	const isInterruption = (key: unknown) => key === interrupted?.key;
	const isTaskReviewFailure = (key: unknown) => cursor.halt?.stage === "task-review-model" &&
		cursor.action.kind === "launched" && cursor.action.role === "reviewer" && key === cursor.action.key &&
		/\.task-(reviewer|synthesis)$/.test(cursor.action.key);
	const synthesisHalt = cursor.halt?.stage === "semantic-block" &&
		cursor.action.kind === "launched" && cursor.action.key.endsWith(".review.director-synthesis");
	const isTimeout = (key: unknown) => ["timeout", "reviewer-renewal-barrier"].includes(cursor.halt?.stage ?? "") &&
		cursor.action.kind === "launched" && cursor.action.role === "reviewer" &&
		(/\.(?:demand-observation|compliance)$/.test(cursor.action.key) || cursor.action.key.includes(".review.") ? key === cursor.action.key :
			/\.task-(reviewer|synthesis)$/.test(cursor.action.key) &&
			typeof key === "string" && /\.task-(reviewer|synthesis)$/.test(key));
	const saved = records.flatMap(row => {
		const body = row.body as { originals?: Record<string, unknown>[];
			entries?: { kind: string; body: { result?: { taskReview?: Record<string, Record<string, unknown>> } } }[] };
		if (row.kind === "review-originals") return body.originals ?? [];
		if (row.kind === "ledger") return (body.entries ?? []).filter(entry => entry.kind === "unit")
			.flatMap(entry => Object.values(entry.body.result?.taskReview ?? {}));
		return [];
	}).reverse();
	const refs: Record<string, unknown>[] = [...subjects.values()].map(subject => {
		// A fresh root cannot look up a prior root's child by workflow key.
		// For the current task-review intention, check the exact mission key even
		// when the cursor has no receipted reviewer sibling to identify the parent.
		const pending = subject.key === pendingTaskReview && subject.runId === null;
		const matches = children.filter(child => child.key === subject.key &&
			(pending || (subject.runId ? child.runId === subject.runId : parents.has(child.workflowRunId))));
		if (pending && matches.length && (matches.length !== 1 ||
			pitakoAgentFamily(matches[0]!.agent) !== "reviewer" || typeof matches[0]!.runId !== "string" || !matches[0]!.runId))
			throw new Error("Task review recovery producer identity or settlement integrity mismatch.");
		const allowed = isInterruption(subject.key) ? [`pitako.${interrupted!.role}`] : [
			"pitako.reviewer", "pitako.execution-inspector",
			...(isSealer(subject.key) ? ["pitako.checkpoint-sealer"] : []),
			...(subject.key === timedOutWorker?.key ? ["pitako.worker"] : []),
			...(isGate(subject.key) ? ["pitako.loop-io"] : [])];
		const family = pitakoAgentFamily(matches[0]?.agent);
		if (matches.length !== 1 || !family || !allowed.map(pitakoAgentFamily).includes(family))
			return { ...subject, error: `Retained native producer unavailable or ambiguous (${matches.length} matches for ${subject.key}/${subject.runId}).` };
		const child = matches[0]!;
		const paths = Array.isArray(child.artifactPaths) ? child.artifactPaths.filter((file): file is string =>
			typeof file === "string" && path.isAbsolute(file)) : [];
		const directories = paths.filter(file => path.basename(file) === child.runId);
		const originals = paths.filter(file => path.basename(file) === `${subject.key}.json`);
		return { key: subject.key, runId: child.runId, agent: child.agent, nativeState: child.status,
			asyncDir: directories.length === 1 ? directories[0] : undefined,
			results: originals.map(file => ({ savedOutputPath: file })),
			saved: saved.find(original => original.key === subject.key && original.runId === child.runId) };
	});
	const originals = refs.filter(record).map(ref => {
		const identity = { key: ref.key, runId: ref.runId };
		try {
			if (ref.error) throw new Error(String(ref.error));
			if (typeof ref.runId !== "string" || typeof ref.agent !== "string" || typeof ref.asyncDir !== "string" ||
				!path.isAbsolute(ref.asyncDir) || path.basename(ref.asyncDir) !== ref.runId)
				throw new Error("Invalid retained analysis reference.");
			const native = readJson(path.join(ref.asyncDir, "status.json"));
			if (native !== undefined && (!record(native) || native.runId !== ref.runId ||
				(native.cwd !== undefined && native.cwd !== root) ||
				(native.workflowKey !== undefined && native.workflowKey !== ref.key) ||
				Array.isArray(native.steps) && native.steps.some(step => step?.agent !== undefined && step.agent !== ref.agent)))
				throw new Error("Retained native producer conflicts with its reference.");
			const status = record(native) ? native : {};
			const workerTimeout = ref.key === timedOutWorker?.key;
			if (isSealer(ref.key) || isGate(ref.key) || isTimeout(ref.key) || workerTimeout || isInterruption(ref.key) || isTaskReviewFailure(ref.key)) {
				if (typeof status.parentWorkflowRunId !== "string" ||
					path.basename(status.parentWorkflowRunId) !== status.parentWorkflowRunId)
					throw new Error("Native settlement reference unavailable.");
				const journal = path.join(path.dirname(ref.asyncDir), status.parentWorkflowRunId, "workflow-children.jsonl");
				const settled = readNativeSettlement(journal, String(ref.key), ref.runId, ref.agent);
				if (isInterruption(ref.key)) {
					if (settled.key !== undefined && settled.key !== ref.key && settled.key !== ref.runId)
						throw new Error("Native reviewer settlement key mismatch.");
					const entries = [settled, ...(Array.isArray(settled.results) ? settled.results.filter(record) : [])];
					const cause = entries.some(item => /^Blocked by pi-subagents permission rule:/.test(String(item.error ?? "")))
						? "native permission denial" : ["stopped", "interrupted"].find(cause => entries.some(item =>
						item[cause] === true || item.state === cause ||
						cause === "stopped" && record(item.terminalOutcome) &&
							["stopped", "cancelled"].includes(String(item.terminalOutcome.reason))));
					return { ...identity, agent: ref.agent, cause: cause ?? null, path: journal, digest: canonicalDigest(settled) };
				}
				if (isTimeout(ref.key) || workerTimeout)
					return { ...identity, settlement: settled, launchedMs: status.timeoutMs, digest: canonicalDigest(settled) };
				if (isTaskReviewFailure(ref.key))
					return { ...identity, settlement: settled, digest: canonicalDigest(settled) };
				if (isGate(ref.key)) {
					const { output, structuredOutput, ...gate } = settled;
					if (Array.isArray(gate.results)) gate.results = gate.results.map(entry => {
						const { task, output, structuredOutput, ...control } = entry;
						return control;
					});
					return { ...identity, gate, path: journal, digest: canonicalDigest(settled),
						witnessDigest: canonicalDigest(gate) };
				}
				return { ...identity, sealer: settled, digest: canonicalDigest(settled) };
			}
			if (native === undefined && ["stopped", "failed", "running", "interrupted", "detached"].includes(String(ref.nativeState)))
				return { ...identity, ok: false, state: ref.nativeState };
			if (typeof status.state === "string" && status.state !== "complete")
				return { ...identity, ok: false, state: status.state };
			const step = Array.isArray(status.steps) && status.steps.length === 1 ? status.steps[0] : undefined;
			if (record(step) && (step.stopped || step.interrupted || step.detached || step.exitCode !== undefined && step.exitCode !== 0))
				return { ...identity, ok: false, stopped: !!step.stopped, interrupted: !!step.interrupted, detached: !!step.detached };
			let original: unknown = record(step) ? step.structuredOutput : undefined;
			const saved = record(ref.saved) ? ref.saved : undefined;
			if (saved?.body !== undefined) {
				if (original !== undefined && !isDeepStrictEqual(original, saved.body))
					throw new Error("Conflicting complete retained analysis originals.");
				original = saved.body;
			}
			const witnesses = Array.isArray(ref.results) ? ref.results.filter(record) : [];
			let publishedPath: string | undefined;
			for (const witness of witnesses) {
				if (typeof witness.savedOutputPath === "string") {
					const value = readJson(safePath(witness.savedOutputPath));
					if (value !== undefined) {
						if (original !== undefined && !isDeepStrictEqual(original, value))
							throw new Error("Conflicting complete retained analysis originals.");
						original = value;
						publishedPath = witness.savedOutputPath;
					}
				}
			}
			if (!record(original)) throw new Error("Complete retained analysis original unavailable.");
			if (saved?.digest !== undefined && canonicalDigest(original) !== saved.digest)
				throw new Error("Conflicting complete retained analysis originals.");
			if (bound && saved && /\.task-(reviewer|synthesis)$/.test(String(ref.key))) return undefined;
			return { ...identity, agent: ref.agent, ok: true, ...(status.state === "complete" ? { state: "complete" } : {}),
				...((synthesisHalt || cursor.halt?.stage === "timeout") &&
					String(ref.key).includes(".review.") && publishedPath ? { path: publishedPath } : {}),
				structuredOutput: original };
		} catch (error) {
			return { ...identity, ok: false, error: String(error instanceof Error ? error.message : error) };
		}
	});
	return { version: 1, association, loop: loop.number, references: refs.map(({ key, runId }) => ({ key, runId })), originals: originals.filter(Boolean) };
}
