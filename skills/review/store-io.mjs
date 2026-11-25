// Standalone-review final writer and read-only settlement recovery.
import "../execute/loader.mjs";
import {readFileSync, realpathSync} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {canonicalDigest} from "../../extensions/canonical.mjs";
import {provePathReceipt, readAccessReceipt} from "../../extensions/access-receipts.mjs";
import {readRequest, safePath, validateMissionPath} from "../../extensions/hash-ledger.mjs";
import {reviewCursorContract, reviewCursorScript} from "./cursor.mjs";
import {reviewSynthesisScript} from "./synthesis.mjs";
import {pitakoAgentFamily, pitakoReviewerAgent} from "../agent-names.mjs";

const {PitakoStore, StoreError} = await import("../../extensions/pitako-store.ts");
const {key: cursorKey, validate, witness, barrier, verifierRetry} = reviewCursorContract();
const source = file => readFileSync(new URL(file, import.meta.url), "utf8");
const {rebuildReview, reviewVerifierStoreFailure} = new Function(
  `${source("../workflow-canonical.js")}\n${reviewSynthesisScript}${reviewCursorScript}
  const pitakoReviewLibraryMode = true;\n${source("./workflow.js")}
  return {rebuildReview: reviewPhase, reviewVerifierStoreFailure};`)();
const hash = value => /^[a-f0-9]{64}$/.test(value ?? "");
const integrity = (reason, code) => Object.assign(new Error(`Standalone review integrity failure: ${reason}`),
  {reviewIntegrity: true, code});
const readJSON = file => JSON.parse(readFileSync(safePath(file), "utf8"));
const canonicalFile = file => typeof file === "string" && path.isAbsolute(file) && path.normalize(file) === file;

function journalStatus(run) {
  if (run?.mode !== "workflow" || !canonicalFile(run.asyncDir) || path.basename(run.asyncDir) !== run.runId)
    throw integrity("missing native workflow journal.");
  return readJSON(path.join(run.asyncDir, "status.json"));
}
function namedReview(status, runId, root) {
  return status.runId === runId && status.mode === "workflow" && canonicalFile(status.cwd) && realpathSync(status.cwd) === root &&
    status.workflow?.resource?.name === "pitako.review" && status.workflow.resource.invocation === "named";
}
function journalEntries(run) {
  return readFileSync(safePath(path.join(run.asyncDir, "workflow-children.jsonl")), "utf8")
    .split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function reusableSettlements(mission, cursor, root) {
  const observePrefix = `${cursor.prefix}store-review.observe.r`;
  const observers = mission.workflowChildren.filter(child => pitakoAgentFamily(child.agent) === "review-store" && child.status === "running" &&
    typeof child.key === "string" && child.key.startsWith(observePrefix) && /^\d+$/.test(child.key.slice(observePrefix.length)));
  const settlements = new Map(), seen = new Set();
  if (observers.length !== 1) return settlements;
  const scopedRun = id => {
    const run = mission.runs.find(run => run.runId === id);
    if (!run) return;
    const status = journalStatus(run);
    if (namedReview(status, id, root) && status.workflow.emits?.some(entry => entry?.reviewScope === cursor.scopeId))
      return {run, status};
  };
  const active = scopedRun(observers[0].workflowRunId)?.status;
  // Native named workflows inline input in the resolved script and omit argsDigest.
  if (active?.state !== "running" || !hash(active.workflow.scriptDigest)) return settlements;
  let id = active.workflow.reusedFrom;
  // Native reuse takes the newest journal mentioning a key, including start-only entries.
  for (let links = 0; id && links < 17 && id !== active.runId && !seen.has(id); links++) {
    seen.add(id);
    const source = scopedRun(id);
    if (!source || source.status.workflow.scriptDigest !== active.workflow.scriptDigest ||
        source.status.workflow.argsDigest !== active.workflow.argsDigest ||
        (!links && !["runtime-replaced", "owner-exited"].includes(source.status.workflow.stopCause))) break;
    const layer = new Map();
    for (const entry of journalEntries(source.run)) {
      if (entry.type === "settle") layer.set(entry.key, entry);
      else if (entry.type === "start" && !layer.has(entry.key)) layer.set(entry.key, null);
    }
    for (const [key, entry] of layer) if (!settlements.has(key)) settlements.set(key, entry);
    id = source.status.workflow.reusedFrom;
  }
  return settlements;
}

function nativeResults(mission, refs, root) {
  const journals = new Map(), remaining = new Map(refs.map(ref => [ref.key, ref]));
  const access = new Map();
  function journalFor(id) {
    if (journals.has(id)) return journals.get(id);
    const run = mission.runs.find(run => run.runId === id);
    if (!namedReview(journalStatus(run), id, root))
      throw integrity("invalid native workflow journal binding.");
    const entries = journalEntries(run);
    journals.set(id, entries);
    return entries;
  }
  return {
    remaining, access,
    // This adapter returns whole exact native results, never runs.status or a preview.
    async all(requests) {
      return requests.map(({key, agent, resume, task}) => {
        const ref = remaining.get(key);
        if (!ref) throw integrity(`missing witnessed settlement for ${key}.`);
        remaining.delete(key);
        if (!ref.runId) {
          const {ok, error, rejected} = ref.unbound;
          if (canonicalDigest(ref.unbound) !== ref.digest) throw integrity(`invalid dispatch witness for ${key}.`);
          if (rejected) throw new Error(error || "Native dispatch rejected.");
          return {ok, ...(error ? {error} : {})};
        }
        const producer = resume ? pitakoReviewerAgent(key) : agent;
        const matches = mission.workflowChildren.filter(child => child.key === key && child.runId === ref.runId &&
          pitakoAgentFamily(child.agent) === pitakoAgentFamily(producer) && ["completed", "failed", "stopped"].includes(child.status));
        const witnesses = [];
        for (const child of matches) {
          const entries = journalFor(child.workflowRunId);
          const starts = entries.filter(entry => entry.type === "start" && entry.key === key &&
            entry.runId === ref.runId && hash(entry.fingerprint));
          for (const {fingerprint} of starts)
            for (const entry of entries)
              if (entry.type === "settle" && entry.key === key && entry.fingerprint === fingerprint && entry.result?.runId === ref.runId)
                witnesses.push(witness(producer === "pitako.originals-verifier"
                  ? {...entry.result, agent: entry.result.agent ?? child.agent} : entry.result));
        }
        if (!witnesses.length || witnesses.some(result => canonicalDigest(result) !== ref.digest))
          throw integrity(`original ${key} does not match its key/runId/digest.`);
        if (producer === "pitako.originals-verifier" && witnesses[0].ok && !barrier(witnesses[0])) {
          const request = JSON.parse(task), observed = JSON.parse(witnesses[0].output);
          if (!reviewVerifierStoreFailure(witnesses[0], observed)) access.set(request.gate, {request, observed});
        }
        return witnesses[0];
      });
    },
  };
}

function retainedAccess(request, observed, root, authorize) {
  const reference = observed.receipt;
  if (reference?.store?.scope !== `access:${request.namespace}` ||
      !Number.isSafeInteger(reference.store.seq) || reference.store.seq < 1 ||
      !/^[a-f0-9-]{36}$/.test(reference.store.storeId ?? "") || !hash(reference.digest))
    throw integrity("invalid native access receipt reference.");
  try {
    if (new PitakoStore(root).readIdentity()?.storeId !== reference.store.storeId) return null;
    const found = readAccessReceipt(request, root);
    if (found && canonicalDigest(found.receipt) === canonicalDigest(reference)) return found.value;
  } catch (error) {
    if (!(error instanceof StoreError) || !["store-corrupt", "store-unavailable", "store-replaced"].includes(error.code)) throw error;
  }
  if (!authorize) return null; // Observation leaves receipt repair and path proof to the final save.
  try { return readAccessReceipt(request, root, {reference, authorize}).value; }
  catch (error) {
    if (!(error instanceof StoreError) || !error.recovery || error.recovery.storeId === reference.store.storeId) throw error;
    return null; // The same-store receipt failed its writer recheck, or another writer replaced the store.
  }
}

function verifyOriginals(missionPath, scopeId, originals, receipts, access, root, authorizeAccess) {
  const unavailable = new Set();
  const namespace = `review-${scopeId}`;
  for (const receipt of receipts) {
    const {request, observed} = access.get(receipt.gate) ?? {};
    if (request?.missionPath !== missionPath || request.namespace !== namespace || observed?.receipt?.digest !== receipt.digest)
      throw integrity("native access receipt binding differs.");
    const value = retainedAccess(request, observed, root, authorizeAccess) ?? provePathReceipt(request, receipt.digest, root);
    if (value.namespace !== namespace || value.gate !== receipt.gate || !Array.isArray(value.items))
      throw integrity("access receipt binding differs.");
    for (const item of value.items) {
      const entry = originals.find(original => original.id === item.id && original.key === item.key &&
        original.results?.some(result => result.savedOutputPath === item.path));
      if (!entry || (item.state === "accessible" && item.digest !== entry.digest))
        throw integrity("access original binding differs.");
      if (item.state !== "accessible") unavailable.add(item.id);
    }
  }
  for (const original of originals) {
    if (!original.digest || unavailable.has(original.id)) continue;
    const file = original.results?.find(item => item.savedOutputPath && !item.outputSaveError)?.savedOutputPath;
    if (!canonicalFile(file)) throw integrity(`invalid published path for ${original.key}.`);
    let digest;
    try { digest = canonicalDigest(readJSON(file)); }
    catch (error) { throw integrity(`${original.key}: ${error.code === "ENOENT" ? "missing-file" : "invalid original"}.`); }
    if (digest !== original.digest) throw integrity(`${original.key}: content-differs.`);
  }
}

function reviewMission(missionPath, cwd) {
  validateMissionPath(missionPath);
  const root = realpathSync(cwd);
  const mission = readJSON(missionPath);
  if (mission.id !== path.basename(missionPath, ".json") || !Array.isArray(mission.runs) || !Array.isArray(mission.workflowChildren))
    throw integrity("invalid native mission record.");
  if (!canonicalFile(mission.cwd) || realpathSync(mission.cwd) !== root)
    throw new StoreError("wrong-cwd", "Standalone review wrong-cwd: use the mission's designated worktree.");
  const stateFile = path.join(path.dirname(missionPath), mission.id, "state.json");
  return {mission, root, current: () => readJSON(stateFile)[cursorKey]};
}

export function observeReview(request, cwd = process.cwd()) {
  const {missionPath, cursor} = request;
  if (Object.keys(request).sort().join(",") !== "cursor,missionPath,op" || request.op !== "observe-review")
    throw integrity("invalid recovery request.");
  validate(cursorKey, cursor);
  if (cursor.terminal !== null || cursor.phase === "save") throw integrity("review is not awaiting settlements.");
  const {mission, root, current} = reviewMission(missionPath, cwd);
  const authorize = () => {
    const active = current();
    if (active?.scopeId !== cursor.scopeId) throw new StoreError("superseded", "Standalone review was superseded.");
    if (canonicalDigest(active) !== canonicalDigest(cursor)) throw integrity("recovery cursor changed.");
  };
  authorize();
  const confirmed = new Map([...cursor.slots, ...(cursor.verifier ? [cursor.verifier] : [])].map(ref => [ref.key, ref]));
  const gate = `${cursor.prefix}synthesis`, verifierBase = `${cursor.prefix}verify-synthesis`;
  const retryOf = key => verifierRetry(key, verifierBase);
  const isVerifier = key => retryOf(key) >= 0;
  const familyFor = key => isVerifier(key) ? "originals-verifier" : "reviewer";
  const candidates = mission.workflowChildren.filter(child => typeof child.key === "string" && child.key.startsWith(cursor.prefix) &&
    (/^(director-prepare|director-synthesis|independent-[A-Za-z0-9][A-Za-z0-9_-]{0,28}-r[12])$/.test(child.key.slice(cursor.prefix.length)) ||
      isVerifier(child.key)));
  const selected = new Map(), open = new Set(), starts = new Map(), scopedRuns = [];
  const terminal = new Set(["completed", "failed", "stopped", "paused"]);
  for (const id of new Set(candidates.map(child => child.workflowRunId))) {
    const run = mission.runs.find(run => run.runId === id);
    const status = journalStatus(run);
    if (!namedReview(status, id, root) || !status.workflow.emits?.some(entry => entry?.reviewScope === cursor.scopeId)) continue;
    scopedRuns.push(run);
    for (const child of candidates.filter(child => child.workflowRunId === id)) {
      const {key, runId} = child;
      const ref = confirmed.get(key);
      if (ref && ref.runId !== runId) throw integrity(`conflicting native producers for ${key}.`);
      if (starts.has(key) && starts.get(key) !== runId) throw integrity(`conflicting native producers for ${key}.`);
      starts.set(key, runId);
      if (!terminal.has(child.status)) { open.add(key); continue; }
      const entry = selected.get(key) ?? {key, runId, agent: child.agent, statuses: new Set(), fingerprints: new Set(), settlements: []};
      if (!runId || pitakoAgentFamily(child.agent) !== familyFor(key))
        throw integrity(`invalid native producer for ${key}.`);
      entry.statuses.add(child.status);
      selected.set(key, entry);
    }
  }
  // A successful native reuse can journal a settle without a new start.
  if (selected.size) for (const run of scopedRuns) {
    for (const record of journalEntries(run)) {
      const entry = selected.get(record.key);
      if (!entry) continue;
      if (!hash(record.fingerprint)) throw integrity(`invalid native fingerprint for ${entry.key}.`);
      if (record.type === "start" && record.runId === entry.runId) entry.fingerprints.add(record.fingerprint);
      if (record.type === "settle" && record.result?.runId === entry.runId) {
        const verifier = isVerifier(entry.key);
        const result = witness(verifier ? {...record.result, agent: record.result.agent ?? entry.agent} : record.result);
        entry.settlements.push({fingerprint: record.fingerprint, result});
      }
    }
  }
  const retryable = new Set();
  const settlements = [...selected.values()].map(({key, runId, statuses, fingerprints, settlements}) => {
    const result = settlements[0]?.result;
    const controlled = result && barrier(result);
    if (!result || typeof result.ok !== "boolean" || result.key !== key ||
        fingerprints.size !== 1 || settlements.some(entry => !fingerprints.has(entry.fingerprint) ||
          canonicalDigest(entry.result) !== canonicalDigest(result)) ||
        [...statuses].some(status => status === "completed" ? !result.ok : status === "failed" ? result.ok && !controlled : !controlled))
      throw integrity(`unproved native settlement for ${key}.`);
    if ([result, ...(result.results ?? [])].some(item => [item.key, item.nativeKey, item.workflowKey].some(value => value !== undefined && value !== key) ||
        item.runId !== undefined && item.runId !== runId ||
        item.agent !== undefined && pitakoAgentFamily(item.agent) !== familyFor(key)))
      throw integrity(`conflicting native settlement identity for ${key}.`);
    if (result.structuredOutput !== undefined) for (const file of result.results ?? []) {
      if (!file.savedOutputPath || file.outputSaveError) continue;
      if (!canonicalFile(file.savedOutputPath) || canonicalDigest(readJSON(file.savedOutputPath)) !== canonicalDigest(result.structuredOutput))
        throw integrity(`published native original differs for ${key}.`);
    }
    if (isVerifier(key) && result.ok && !controlled) {
      const observed = JSON.parse(result.output);
      const failure = reviewVerifierStoreFailure(result, observed);
      if (failure) {
        if (!["wrong-cwd", "superseded"].includes(failure.code)) retryable.add(key);
      }
      else retainedAccess({missionPath, namespace: `review-${cursor.scopeId}`, gate}, observed, root);
    }
    open.delete(key);
    const digest = canonicalDigest(result), ref = confirmed.get(key);
    if (ref && ref.digest !== digest) throw integrity(`retained native settlement differs for ${key}.`);
    confirmed.delete(key);
    return {key, digest, result};
  }).filter(({key}) => !retryable.has(key) || !starts.has(`${verifierBase}.r${retryOf(key) + 1}`));
  // Only a proved transient settlement can be superseded, keeping one verifier slot.
  for (const key of starts.keys()) {
    const retry = retryOf(key);
    if (retry > 0 && !retryable.has(retry === 1 ? verifierBase : `${verifierBase}.r${retry - 1}`))
      throw integrity("access verifier retry lacks a preceding retryable store settlement.");
  }
  if (confirmed.size) throw integrity("missing native settlement referenced by the recovery cursor.");
  authorize();
  const response = {scopeId: cursor.scopeId, settlements, pending: [...open]};
  if (settlements.length > 7 || open.size > 7) throw integrity("recovery receipt exceeds its settlement limit.");
  const size = () => Buffer.byteLength(JSON.stringify(response)) + 1;
  const fullBytes = size();
  if (fullBytes <= 61440) return response;
  // A retained barrier holds without consuming any successful bodies.
  const stopped = settlements.find(({result}) => barrier(result) === "stop") ??
    settlements.find(({result}) => barrier(result));
  if (stopped) {
    response.settlements = [stopped];
  } else {
    const reused = reusableSettlements(mission, cursor, root);
    const compactable = settlements.flatMap(({key, digest, result}, index) => {
      const entry = reused.get(key);
      if (!result.ok || !entry?.result?.ok || !selected.get(key).fingerprints.has(entry.fingerprint) ||
          canonicalDigest(witness(isVerifier(key)
            ? {...entry.result, agent: entry.result.agent ?? selected.get(key).agent} : entry.result)) !== digest) return [];
      const ref = {key, runId: result.runId, digest};
      return [{index, ref, savings: Buffer.byteLength(JSON.stringify(settlements[index])) - Buffer.byteLength(JSON.stringify(ref))}];
    });
    let bytes = fullBytes;
    for (const {index, ref, savings} of compactable.sort((a, b) => b.savings - a.savings)) {
      if (bytes <= 61440) break;
      settlements[index] = ref;
      bytes -= savings;
    }
  }
  const receiptBytes = size();
  if (receiptBytes > 61440)
    throw integrity(`review-recovery-overflow: ${receiptBytes} bytes for ${response.settlements.length} settled slots (limit 61440).`,
      "review-recovery-overflow");
  authorize();
  return response;
}

export async function saveReview(request, cwd = process.cwd()) {
  const {input, missionPath, prefix, cursor} = request;
  if (Object.keys(request).sort().join(",") !== "cursor,input,missionPath,op,prefix" || request.op !== "save-review")
    throw integrity("invalid write request.");
  validate(cursorKey, cursor);
  if (cursor.identity !== canonicalDigest(input) || cursor.prefix !== prefix || cursor.phase !== "save" || cursor.terminal !== null)
    throw integrity("cursor does not authorize a final save.");
  const {mission, root, current} = reviewMission(missionPath, cwd);
  const authorize = () => {
    const active = current();
    if (active?.scopeId !== cursor.scopeId) throw new StoreError("superseded", "Standalone review was superseded.");
    if (canonicalDigest({...active, terminal: null}) !== canonicalDigest(cursor))
      throw integrity("current cursor and save intention differ.");
  };
  const scope = `review:${cursor.scopeId}`;
  const admitIf = ([active]) => {
    if (!active || typeof active.body?.missionPath !== "string") throw integrity("review fence has no owner.");
    // A prior pass may have committed but lost its terminal cursor save.
    return active.body.missionPath !== missionPath || active.scope === `review:${cursor.parentScope}` ||
      cursor.scopeId === canonicalDigest({missionPath, identity: cursor.identity, prefix, priorScope: active.scope.slice(7)});
  };
  const authorizeAccess = active => {
    authorize();
    if (active.length && active[0].scope !== scope && !admitIf(active))
      throw new StoreError("superseded", "Standalone review was superseded.");
  };
  authorize();
  const refs = [...cursor.slots, ...(cursor.verifier ? [cursor.verifier] : [])];
  const runs = nativeResults(mission, refs, root);
  const body = await rebuildReview(input, runs, {prefix, models: cursor.models, access: {missionPath},
    rebuild: {scopeId: cursor.scopeId, verifierKey: cursor.verifier?.key, result(result, originals, receipts) {
      if (runs.remaining.size) throw integrity("the native review did not consume every witnessed settlement.");
      verifyOriginals(missionPath, cursor.scopeId, originals, receipts, runs.access, root, authorizeAccess);
      return {result, originals, receipts, missionPath, identity: cursor.identity, models: cursor.models,
        decision: {brief: input.brief, target: input.target}};
    }}});
  const digest = canonicalDigest(request);
  const response = (outcome, head, storeId, result) => ({outcome, head, storeId, scopeId: cursor.scopeId, result});
  // Never commit a result whose receipt the root cannot consume.
  if (Buffer.byteLength(JSON.stringify(response("appended", {seq: 1, hash: "a".repeat(64)}, "0".repeat(36), body.result))) + 1 > 61440)
    throw integrity("result receipt exceeds 61440 bytes.");
  const commit = () => {
    authorize();
    return new PitakoStore(root, () => null).commit(scope, null, "save-review", digest, () => {
      authorize();
      return {kind: "review", body};
    }, {admit: true, admitIf});
  };
  let saved;
  try { saved = commit(); }
  catch (error) {
    if (!(error instanceof StoreError) || !["store-corrupt", "cursor-ahead", "store-replaced"].includes(error.code)) throw error;
    // The complete native reconstruction is the recovery basis, not a second history.
    saved = commit();
  }
  if (saved.outcome === "superseded") throw new StoreError("superseded", "Standalone review was superseded.");
  if (!["appended", "replay"].includes(saved.outcome)) throw integrity("final store operation conflicts with its committed result.");
  return response(saved.outcome, saved.head, saved.identity.storeId, saved.result.result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      if ((bytes += chunk.length) > 1024 * 1024) throw integrity("stdin limit exceeded.");
      chunks.push(chunk);
    }
    const request = readRequest(Buffer.concat(chunks).toString("utf8"));
    process.stdout.write(JSON.stringify(request.op === "observe-review" ? observeReview(request) : await saveReview(request)) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({code: error instanceof StoreError || error.reviewIntegrity && error.code ? error.code : "review-integrity",
      error: String(error.message ?? error).slice(0, 1200)}) + "\n");
  }
}
