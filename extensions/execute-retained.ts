import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { executionStatePath } from "./execute-state.ts";

const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
function readJson(file: string): unknown {
	try { return JSON.parse(readFileSync(file, "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
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
		throw new Error(`${String(error instanceof Error ? error.message : error)} Selected source ${source}; expected binding ${binding}; observed recovery projection unavailable. Preserve the admitted snapshot and exact native references; inspect the linked originals and reconcile the pending subject under current native authority, without redispatch or automatic recapture.`);
	}
}
function retainedProjection(root: string, source: string, digest: string, context: unknown,
	bound?: { commonDir: string; binding: string }) {
	if (!record(context) || typeof context.missionPath !== "string" || !path.isAbsolute(context.missionPath) ||
		typeof context.invocation !== "string" || typeof context.missionId !== "string")
		throw new Error("Expected exact mission and invocation for retained analysis inspection.");
	const mission = readJson(executionStatePath({ missionPath: context.missionPath, missionId: context.missionId }));
	const invocation = record(mission) ? mission[`invoke-${context.invocation}`] : undefined;
	if (!record(invocation)) return undefined;
	const association = invocation.association;
	// A failed pre-admission request has no originals. Legacy roots never acquire
	// this delivery route, and a changed bound association is not recaptured.
	if (bound && association === undefined) return undefined;
	if (bound && (invocation.version !== 4 || invocation.admissionBinding !== bound.binding ||
		!record(association) || association.commonDir !== bound.commonDir ||
		!isDeepStrictEqual(association.sourceRefs, context.sourceRefs)))
		throw new Error("Retained recovery binding differs or predates bound admission. Preserve the original snapshot and native references; restore reliable exact bytes or inspect native state, never migrate or recapture this root.");
	if (!record(association) || association.root !== root || association.source !== source ||
		association.digest !== digest || association.invocation !== context.invocation ||
		association.missionId !== context.missionId || association.missionPath !== context.missionPath)
		throw new Error("Retained analysis association differs from the selected invocation.");
	const loop = invocation.version === 4 ? invocation.loop : Array.isArray(invocation.loops) ? invocation.loops.at(-1) : undefined;
	if (!record(loop) || !["director", "implementation", "review", "compliance"].includes(String(loop.phase))) return undefined;
	const review = record(loop.review) ? loop.review : {};
	const compliance = record(loop.compliance) ? loop.compliance : {};
	const refs: unknown[] = [
		...(Array.isArray(review.references) ? review.references : []),
		...(compliance.ref ? [compliance.ref] : []),
	];
	for (const call of Array.isArray(loop.analysisCalls) ? loop.analysisCalls : []) {
		const reference = record(call) ? call.ref : undefined;
		if (record(reference) && !refs.some(ref => record(ref) && ref.key === reference.key))
			refs.push(reference);
	}
	// Recovery inspectors are read-only producers too. Pending intentions must
	// reconcile their exact original rather than launch a replacement query.
	const recoveries = Array.isArray(loop.recoveries) ? loop.recoveries.filter(record) : [];
	for (const recovery of recoveries) {
		if (!isDeepStrictEqual(recovery.association, { ...association, loop: loop.number }) ||
			!["loop-plan", "attempt-result", "interrupted-operation", "checkpoint"].includes(String(recovery.phase)) ||
			!["intention", "observed"].includes(String(recovery.stage)) || !record(recovery.ref))
			throw new Error("Retained recovery association/stage conflicts with the current loop.");
		const reference = recovery.ref;
		if (refs.some(ref => record(ref) && ref.key === reference.key))
			throw new Error("Retained read-only producer has duplicate subjects.");
		refs.push(reference);
	}
	const originals = refs.filter(record).map(ref => {
		const identity = { key: ref.key, runId: ref.runId };
		try {
			const prefix = `invoke-${context.invocation}.l${loop.number}.`;
			if (typeof ref.key !== "string" ||
				!(ref.key.startsWith(`${prefix}review.`) || ref.key === `${prefix}compliance` ||
				ref.key.startsWith(`${prefix}recover`) && recoveries.some(item => record(item.ref) &&
					item.ref.key === ref.key && isDeepStrictEqual(item.ref, ref))) ||
				typeof ref.runId !== "string" || typeof ref.asyncDir !== "string" ||
				!path.isAbsolute(ref.asyncDir) || path.basename(ref.asyncDir) !== ref.runId)
				throw new Error("Invalid retained analysis reference.");
			const native = readJson(path.join(ref.asyncDir, "status.json"));
			if (native !== undefined && (!record(native) || native.runId !== ref.runId ||
				(native.cwd !== undefined && native.cwd !== root) ||
				(native.workflowKey !== undefined && native.workflowKey !== ref.key)))
				throw new Error("Retained native producer conflicts with its reference.");
			const status = record(native) ? native : {};
			if (typeof status.state === "string" && status.state !== "complete")
				return { ...identity, ok: false, state: status.state };
			const step = Array.isArray(status.steps) && status.steps.length === 1 ? status.steps[0] : undefined;
			if (record(step) && (step.stopped || step.interrupted || step.detached || step.exitCode !== undefined && step.exitCode !== 0))
				return { ...identity, ok: false, stopped: !!step.stopped, interrupted: !!step.interrupted, detached: !!step.detached };
			let original: unknown = record(step) ? step.structuredOutput : undefined;
			const witnesses = Array.isArray(ref.results) ? ref.results.filter(record) : [];
			const priorBarrier = native === undefined && [ref, ...witnesses].find(value =>
				value.stopped || value.interrupted || value.detached);
			if (priorBarrier)
				return { ...identity, ok: false, stopped: !!priorBarrier.stopped,
					interrupted: !!priorBarrier.interrupted, detached: !!priorBarrier.detached };
			for (const witness of witnesses) {
				if (typeof witness.structuredOutputPath !== "string") continue;
				let file: string;
				try { file = realpathSync(witness.structuredOutputPath); }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
				const relative = path.relative(realpathSync(ref.asyncDir), file);
				if (!relative.startsWith(`structured-output${path.sep}`) || path.isAbsolute(relative) ||
					relative.split(path.sep).includes("..") || !file.endsWith(".json"))
					throw new Error("Structured original escapes its retained native producer.");
				const value = readJson(file);
				if (original !== undefined && !isDeepStrictEqual(original, value))
					throw new Error("Conflicting complete retained analysis originals.");
				original = value;
			}
			if (!record(original)) throw new Error("Complete retained analysis original unavailable.");
			return { ...identity, ok: true, ...(status.state === "complete" ? { state: "complete" } : {}),
				structuredOutput: original };
		} catch (error) {
			return { ...identity, ok: false, error: String(error instanceof Error ? error.message : error) };
		}
	});
	return { version: 1, association, loop: loop.number, references: refs, originals };
}
