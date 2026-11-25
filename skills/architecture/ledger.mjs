import "../execute/loader.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { safePath, readRequest, validateExpected, validateMissionPath } from "../../extensions/hash-ledger.mjs";
import { canonicalDigest, canonicalJSON, sha256 } from "../../extensions/canonical.mjs";
import { architectureNative } from "./native.mjs";

const { PitakoStore, StoreError } = await import("../../extensions/pitako-store.ts");
const { architectureOutputSchema, confirmNativeOriginal, observeSlotRefs, projectNativeOriginal } = architectureNative(canonicalDigest);

const hash = value => /^[a-f0-9]{64}$/.test(value ?? "");
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === names;
const scopeFor = consultation => {
  if (typeof consultation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(consultation))
    throw new Error("Invalid architecture consultation ID.");
  return `arch:${consultation}`;
};
const storeHead = expected => expected.count ? { seq: expected.count, hash: expected.head } : null;
const anchor = head => ({ count: head?.seq ?? 0, head: head?.hash ?? null });
const lostStore = error => ["store-replaced", "store-corrupt", "cursor-ahead"].includes(error.code);
const contextFields = ["humanAnswers", "callerEvidence", "factualRetry"];
const nativeVeto = value => value.error || value.stopped || value.interrupted || value.detached || value.timedOut ||
  value.exitCode !== undefined && value.exitCode !== 0 || value.processSignal || value.recovery || value.timeoutRecovery ||
  value.outputPartial || value.structuredOutputFailed || value.terminalOutcome || value.outputSaveError ||
  value.turnBudgetExceeded || value.toolBudgetBlocked ||
  value.state !== undefined && !["complete", "completed"].includes(value.state);

function activeContext(records, identity) {
  const context = {};
  for (const row of records) {
    if (row.kind !== "context") continue;
    const ref = { store: { storeId: identity.storeId, scope: row.scope, seq: row.seq }, digest: row.digest };
    for (const key of contextFields)
      if (Object.hasOwn(row.body.body, key)) context[key] = ref;
  }
  return context;
}

function decisionAt(records, digest) {
  const record = records.findLast(row => row.kind === "admission" || row.kind === "decision");
  const decision = record?.body.body.currentDecision;
  if (!decision || canonicalDigest(decision) !== digest)
    throw new Error("Architecture ledger integrity failure: retained decision digest mismatch.");
  return decision;
}

// The same pinned round record supplies the previous roster, previous-round
// originals and next director packet. Never use the tip for a cursor read.
function closedRoundProjection(records, identity) {
  const row = records.findLast(row => row.kind === "round" && row.body.body?.comparison !== "failed");
  const body = row?.body.body;
  if (!body?.cursor?.control?.next) return;
  const dispatch = body.cursor.dispatches.find(item => item.originalId === body.cursor.control.next);
  if (!dispatch) return;
  if (!body.originals.some(item => item.id === dispatch.originalId))
    throw new StoreError("store-corrupt", "Closed architecture round has no next packet original.");
  const retired = new Set((body.cursor.retries ?? []).flatMap(retry => retry.originalIds));
  const lastPrepare = body.originals.findLast(item => item.key === "director-prepare");
  const originals = body.originals.filter(item => item.round === body.rounds &&
    (item.delivery !== "not-delivered" || !retired.has(item.id)) &&
    (item.key !== "director-prepare" || item === lastPrepare)).map(item => {
      // Closed siblings are verifiable references, not live native controls.
      const { id, relativePath, artifactRoot, digest } = item;
      const reference = id === dispatch.originalId ? item : { id, relativePath, artifactRoot, digest };
      return Object.hasOwn(row.body.originals ?? {}, id)
        ? {...reference, store: {storeId: identity.storeId, scope: row.scope, seq: row.seq}, storeDigest: row.digest}
        : reference;
    });
  return { dispatch, members: body.members, originals, steering: body.cursor.control.resultSteering ?? [] };
}

function validRecord(kind, round, seq) {
  return Number.isSafeInteger(round) && (seq === 1 ? kind === "admission" && round === 0 :
    ["decision", "round", "context"].includes(kind) && round >= 0);
}

function validateRecords(scope, records) {
  if (!scope.startsWith("arch:")) return;
  for (const row of records)
    if (!(keys(row.body, "body,missionPath,round") || row.kind === "round" && keys(row.body, "body,missionPath,originals,round")) ||
        !validRecord(row.kind, row.body.round, row.seq) ||
        row.opKey !== `${row.kind}:${row.seq}` ||
        canonicalDigest({ missionPath: row.body.missionPath, kind: row.kind, round: row.body.round, body: row.body.body }) !== row.requestDigest ||
        row.body.missionPath !== records[0]?.body.missionPath)
      throw new StoreError("store-corrupt", "Invalid architecture ledger record or association.");
}

function boundMission(records, missionPath) {
  if (records.length && records[0].body.missionPath !== missionPath)
    throw new Error("Architecture consultation belongs to another native mission.");
}

function humanAdoption(records, from, expectedAnswer, identity, consultation, missionPath, steering, oldHead) {
  const row = records.at(-1);
  const input = row?.kind === "context" && row.seq > from ? row.body.body : undefined;
  if (!input?.humanAnswers || !input.basis ||
      expectedAnswer !== true && canonicalDigest(input.humanAnswers) !== expectedAnswer) return;
  const {basis, basisDigest, humanAnswers} = input;
  const fail = () => new Error("Architecture ledger integrity failure: committed answers have an invalid cursor basis.");
  if (!keys(basis, "phase,slots,stage") || canonicalDigest(basis) !== basisDigest || basis.stage !== "awaiting-human" ||
      !["architecture-doubts", "architecture-factual"].includes(basis.phase) || !Array.isArray(basis.slots) ||
      basis.slots.length > 16 || basis.slots.some(slot => !keys(slot, "attempt,digest,key,runId,terminal") || !slot.runId || !hash(slot.digest)))
    throw fail();
  const round = row.body.round;
  const decision = records.findLast(item => ["admission", "decision"].includes(item.kind))?.body.body.currentDecision;
  if (!decision || humanAnswers.consultation !== consultation || humanAnswers.round !== round ||
      humanAnswers.revision !== decision.revision) throw fail();
  const closedRound = closedRoundProjection(records, identity);
  const unrounded = records.findLast(item => item.kind === "round")?.body.body;
  const native = observeSlots(missionPath, identity.root, observeSlotRefs({consultation,
    currentDecision: decision, rounds: round, cursor: {dispatches: basis.slots, control: {round, stage: basis.stage}}}));
  if (native.length !== basis.slots.length || native.some(item => item.barrier || item.dispatch.boundary !== "confirmed"))
    throw fail();
  const doubts = native.find(item => item.dispatch.key === `director-doubts-r${round}`);
  const frontier = doubts?.dispatch.controlOutput?.doubts.filter(item => ["human", "experiment"].includes(item.kind)).map(item => item.id).sort();
  if (!frontier?.length || canonicalJSON(frontier) !== canonicalJSON(humanAnswers.answers.map(item => item.id).sort()))
    throw fail();
  const next = native.find(item => item.dispatch.key === "director-prepare")?.dispatch ?? closedRound?.dispatch;
  if (next?.controlOutput?.action !== "discuss") throw fail();
  let observedSteering;
  if (round >= 2) {
    const reports = native.filter(({entry}) => entry.phase === "architecture-perspective" && entry.round === round);
    const refs = reports.map(({entry}) => ({key: entry.key, runId: entry.runId,
      path: `${entry.artifactRoot}/${entry.relativePath}`, digest: entry.digest}));
    const saved = steering?.round === round ? steering.saved : [];
    const intentions = saved.map(({key, originalId}) => {
      const original = refs.find(ref => reports.some(({entry}) => entry.id === originalId && entry.key === ref.key));
      if (!original) throw fail();
      return {key, original: original.key, digest: canonicalDigest({head: oldHead, round, key, original})};
    });
    if (refs.length) observedSteering = observeSteering(missionPath, identity.root, oldHead,
      {round, keys: refs.map(ref => ref.key), refs, intentions});
    if (observedSteering?.some(item => item.state && !saved.some(intent => intent.key === item.key && intent.state !== "intended")))
      throw new Error("Architecture ledger integrity failure: committed answers have a native steering outcome without a saved sending stage.");
  }
  return {count: row.seq, head: row.digest, decision, closedRound, native, context: activeContext(records, identity),
    steering: observedSteering,
    adoption: {basis, round, validRounds: (unrounded?.validRounds ?? 0) + 1, next: next.originalId, directorRunId: doubts.entry.runId}};
}

function nativeJSON(file) {
  return JSON.parse(readFileSync(safePath(file), "utf8"));
}

function archiveOriginals(body, prefix = []) {
  const originals = {};
  for (const item of body.originals ?? []) {
    if (!item.artifactRoot || !item.relativePath || !hash(item.digest) ||
        item.publication !== undefined && item.publication !== "published") continue;
    const archived = prefix.findLast(row => row.kind === "round" && Object.hasOwn(row.body.originals ?? {}, item.id));
    if (archived && canonicalDigest(archived.body.originals[item.id]) === item.digest) {
      originals[item.id] = archived.body.originals[item.id];
      continue;
    }
    const exactPath = `${item.artifactRoot}/${item.relativePath}`;
    let value;
    try {
      if (!path.isAbsolute(exactPath) || path.normalize(exactPath) !== exactPath)
        throw new Error("Invalid native publication path.");
      value = nativeJSON(exactPath);
    } catch (error) {
      throw new Error(`Architecture ledger integrity failure: cannot archive original ${item.id}.`, {cause: error});
    }
    if (canonicalDigest(value) !== item.digest)
      throw new Error(`Architecture ledger integrity failure: cannot archive original ${item.id}; digest differs.`);
    originals[item.id] = value;
  }
  return Object.keys(originals).length ? originals : undefined;
}

function observeSlots(missionPath, root, slots) {
  const failure = key => new Error(`Architecture ledger integrity failure: native original does not prove slot ${key}.`);
  const read = (file, parse = nativeJSON) => {
    try { return parse(file); } catch (error) { if (error.code !== "ENOENT") throw failure("journal"); }
  };
  if (!slots.length) return [];
  const mission = read(missionPath);
  if (mission?.id !== path.basename(missionPath, ".json") || mission.cwd !== root ||
      !Array.isArray(mission.runs) || !Array.isArray(mission.workflowChildren)) {
    if (slots.every(slot => slot.runId === null)) return [];
    throw failure("mission");
  }
  const journals = new Map();
  const journalFor = runId => {
    if (!journals.has(runId)) {
      const run = mission.runs.find(item => item.runId === runId);
      if (run?.mode !== "workflow" || !path.isAbsolute(run.asyncDir ?? "") || path.basename(run.asyncDir) !== runId)
        return [];
      const status = read(path.join(run.asyncDir, "status.json"));
      if (status?.runId !== runId || status.cwd !== root || status.mode !== "workflow" ||
          status.workflow?.resource?.name !== "pitako.architecture" || status.workflow.resource.invocation !== "named")
        return [];
      journals.set(runId, read(path.join(run.asyncDir, "workflow-children.jsonl"), file =>
        readFileSync(safePath(file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))) ?? []);
    }
    return journals.get(runId);
  };
  return slots.flatMap(({association, runId, terminal, digest}) => {
    const { consultation, revision, key, attempt, phase, producer } = association;
    const agents = phase === "architecture-factual"
      ? ["pitako.scout", "pitako.researcher", "pitako.evidence-auditor"] : ["pitako.architect"];
    const id = `${consultation}.v${revision}.${key}.a${attempt}`;
    const relative = `architecture/${consultation}/v${revision}/${key}-a${attempt}.json`;
    // A saved intention without a runId is ambiguous unless the native output
    // claim identifies the exact attempted publication, not just its reused key.
    const matches = [];
    for (const child of mission.workflowChildren.filter(item => item.key === key && agents.includes(item.agent) &&
        (!runId || item.runId === runId) && ["completed", "failed", "stopped"].includes(item.status))) {
      const entries = journalFor(child.workflowRunId);
      const starts = entries.filter(item => item.type === "start" && item.key === key && item.runId === child.runId && hash(item.fingerprint));
      for (const start of starts) for (const {result} of entries.filter(item => item.type === "settle" &&
        item.key === key && item.fingerprint === start.fingerprint && item.result?.runId === child.runId)) {
        const file = result.results?.find(row => row.savedOutputPath)?.savedOutputPath;
        const mapping = result.outputPathMapping;
        if (!runId && !(typeof file === "string" && (file.endsWith(`/${relative}`) ||
            mapping?.savedPath === file && mapping.requestedPath === relative))) continue;
        if (!runId && ["running", "queued", "pending", "starting"].includes(result.state)) continue;
        const {reused, ...settlement} = result;
        matches.push({result: settlement, agent: child.agent});
      }
    }
    if (!matches.length && !runId) return [];
    if (!matches.length || matches.some(other => canonicalDigest(other) !== canonicalDigest(matches[0]))) throw failure(key);
    const {result, agent} = matches[0];
    const admitted = producer === null ? {...association, producer: agent.slice("pitako.".length)} : association;
    const {entry, barrier} = projectNativeOriginal({id, association: admitted, agent, access: true,
      schema: architectureOutputSchema(phase)}, result);
    const dispatch = {...admitted, originalId: id, boundary: "intended"};
    confirmNativeOriginal(entry, dispatch, result);
    if (runId && digest === null && entry.digest)
      throw new Error(`Architecture ledger integrity failure: slot ${key} has a missing-digest witness.`);
    if (runId && (terminal !== entry.terminal || digest !== (entry.digest ?? null))) throw failure(key);
    if (entry.publication === "published" && entry.digest) {
      const file = `${entry.artifactRoot}/${entry.relativePath}`;
      const original = read(file);
      if (original === undefined || canonicalDigest(original) !== entry.digest) throw failure(key);
    }
    return [{entry, dispatch, ...(barrier ? {barrier} : {})}];
  });
}

function observeSteering(missionPath, root, head, {round, keys: peers, refs, intentions}) {
  const fail = () => new Error("Architecture ledger integrity failure: invalid or contradictory native steering evidence.");
  const read = (file, parse = nativeJSON) => {
    try { return parse(file); }
    catch (error) { if (error.code !== "ENOENT") throw fail(); }
  };
  if (!Number.isInteger(round) || round < 2 || round > 10 || !Array.isArray(peers) ||
      peers.length < 1 || peers.length > 4 || new Set(peers).size !== peers.length ||
      peers.some(key => !new RegExp(`^r${round}-[A-Za-z0-9_-]{1,32}$`).test(key)) ||
      !Array.isArray(refs) || refs.length > peers.length || new Set(refs.map(ref => ref.key)).size !== refs.length ||
      refs.some(ref => !keys(ref, "digest,key,path,runId") || !peers.includes(ref.key) || !hash(ref.digest) ||
        typeof ref.runId !== "string" || !path.isAbsolute(ref.path ?? "")) ||
      !Array.isArray(intentions) || intentions.length > 3 || new Set(intentions.map(intent => intent.key)).size !== intentions.length)
    throw fail();
  for (const intent of intentions) {
    const original = refs.find(ref => ref.key === intent.original);
    if (!keys(intent, "digest,key,original") || !original || intent.key === intent.original || !peers.includes(intent.key) ||
        intent.digest !== canonicalDigest({ head, round, key: intent.key, original })) throw fail();
  }
  if (!refs.length) return [];
  const mission = read(missionPath);
  if (mission?.id !== path.basename(missionPath, ".json") || mission.cwd !== root ||
      !Array.isArray(mission.runs) || !Array.isArray(mission.workflowChildren))
    return [];
  const evidence = new Map();
  for (const run of mission.runs) {
    const children = mission.workflowChildren.filter(child => child.workflowRunId === run.runId &&
      child.agent === "pitako.architect" && peers.includes(child.key));
    const sources = refs.filter(ref => children.some(child => child.key === ref.key && child.runId === ref.runId && child.status === "completed"));
    if (!sources.length || run.mode !== "workflow" || !path.isAbsolute(run.asyncDir ?? "") || path.basename(run.asyncDir) !== run.runId)
      continue;
    const status = read(path.join(run.asyncDir, "status.json"));
    if (status?.runId !== run.runId || status.cwd !== root || status.mode !== "workflow" ||
        status.workflow?.resource?.name !== "pitako.architecture" || status.workflow.resource.invocation !== "named")
      continue;
    const journal = read(path.join(run.asyncDir, "workflow-children.jsonl"), file =>
      readFileSync(safePath(file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))) ?? [];
    const unique = entries => {
      if (entries.length > 1) throw fail();
      return entries[0];
    };
    const startFor = (key, runId) => unique(journal.filter(entry => entry.type === "start" && entry.key === key &&
      entry.runId === runId && hash(entry.fingerprint)));
    const settled = (key, runId) => {
      const start = startFor(key, runId);
      return start && unique(journal.filter(entry => entry.type === "settle" && entry.key === key &&
        entry.fingerprint === start.fingerprint && entry.result?.runId === runId))?.result;
    };
    const witnessed = sources.filter(ref => settled(ref.key, ref.runId)?.results?.some(row => row.savedOutputPath === ref.path));
    if (!witnessed.length) continue;
    for (const key of peers) {
      const target = children.find(child => child.key === key);
      const intent = intentions.find(item => item.key === key);
      const original = witnessed.find(ref => ref.key === intent?.original);
      if (intent && !original) continue;
      const trace = (status.workflow.trace ?? []).filter(entry => entry.operation === "steer" && entry.key === key);
      const outcomes = trace.filter(entry => ["queued", "delivered", "missed", "failed"].includes(entry.state));
      if (trace.filter(entry => entry.state === "started").length > 1 || outcomes.length > 1 ||
          trace.some(entry => entry.state !== "started" && !outcomes.includes(entry))) throw fail();
      const outcome = outcomes[0], state = outcome?.state;
      if (!intent && state === undefined) continue;
      const pin = refs.find(ref => ref.key === key);
      const runId = target?.runId ?? status.steps?.find(step => step.workflowKey === key)?.runId;
      if (pin && pin.runId !== runId || outcome &&
          (trace[0].state !== "started" || !startFor(key, runId) || state === "failed" && outcome.error))
        throw fail();
      const ref = original ?? witnessed.find(ref => ref.key !== key);
      const value = ref && read(ref.path);
      if (value === undefined || canonicalDigest(value) !== ref.digest || evidence.has(key)) throw fail();
      let settlement;
      if (intent && !pin && target?.status === "completed") {
        const result = settled(key, runId), rows = result?.results;
        if (result?.ok && result.key === key && result.agent === "pitako.architect" && rows?.length === 1 &&
            rows[0].agent === result.agent && (rows[0].workflowKey === undefined || rows[0].workflowKey === key) &&
            (rows[0].key === undefined || rows[0].key === key) &&
            (rows[0].runId === undefined || rows[0].runId === runId) && ![result, ...rows].some(nativeVeto)) {
          const file = rows[0].savedOutputPath, published = typeof file === "string" && read(file);
          if (!keys(published, "report,status") || published.status !== "ready" ||
              typeof published.report !== "string" || !published.report.trim() ||
              !keys(result.structuredOutput, "report,status") ||
              canonicalDigest(result.structuredOutput) !== canonicalDigest(published)) throw fail();
          settlement = { runId, agent: result.agent, ...(result.state ? {state: result.state} : {}),
            path: file, digest: canonicalDigest(published) };
        }
      }
      // Observation is the new root's first call, before any perspective key
      // can register there. The original's journal identifies the old route;
      // even an unsettled sibling in that root is not steerable here.
      evidence.set(key, { key, ...(state ? { state } : {}), noRoute: true, ...(settlement ? { settlement } : {}) });
    }
  }
  return [...evidence.values()];
}

function ledgerDigest(scope, row) {
  const { seq, kind, prev, body } = row;
  const requestDigest = canonicalDigest({ missionPath: body.missionPath, kind, round: body.round, body: body.body });
  const bodyDigest = sha256(canonicalJSON(body));
  return canonicalDigest({ scope, seq, kind, opKey: `${kind}:${seq}`, requestDigest, bodyDigest, prev });
}

function rebindRecords(scope, chain, originalStoreId, storeId) {
  const rebound = [], priorActive = {};
  for (const original of chain) {
    const row = JSON.parse(JSON.stringify(original));
    const body = row.body.body;
    // Prove that recovery retains *all* active context, not just the subset
    // of links present in a later native request. Caller-authored data is immutable.
    if (row.kind === "context") {
      if (canonicalJSON(body.priorActive ?? {}) !== canonicalJSON(priorActive))
        throw new Error("Architecture ledger integrity failure: invalid native context link.");
      for (const ref of Object.values(body.priorActive ?? {})) {
        ref.store.storeId = storeId;
        ref.digest = rebound[ref.store.seq - 1].digest;
      }
      for (const key of contextFields) {
        if (Object.hasOwn(body, key)) priorActive[key] = {
          store: {storeId: originalStoreId, scope, seq: row.seq}, digest: original.digest,
        };
      }
    }
    row.prev = rebound.at(-1)?.digest ?? null;
    row.digest = ledgerDigest(scope, row);
    rebound.push(row);
  }
  return rebound;
}

function nativeRecoveryRecords(missionPath, scope, expected, identity, root) {
  const missing = () => new Error("Architecture ledger integrity failure: native originals do not prove the retained ledger.");
  const read = file => {
    try { return nativeJSON(file); } catch (error) { if (error.code !== "ENOENT") throw missing(); }
  };
  const mission = read(missionPath);
  if (!identity || !expected.count || mission?.id !== path.basename(missionPath, ".json") ||
      mission.cwd !== root || !Array.isArray(mission.runs) || !Array.isArray(mission.workflowChildren))
    throw missing();
  const candidates = new Map(), recoveries = new Map();
  for (const run of mission.runs) {
    if (run.mode !== "workflow" || !path.isAbsolute(run.asyncDir ?? "") || path.basename(run.asyncDir) !== run.runId)
      continue;
    const status = read(path.join(run.asyncDir, "status.json"));
    if (status?.runId !== run.runId || status.cwd !== root || status.mode !== "workflow" ||
        status.workflow?.resource?.name !== "pitako.architecture" || status.workflow.resource.invocation !== "named")
      continue;
    const completed = mission.workflowChildren.filter(child => child.workflowRunId === run.runId &&
      child.agent === "pitako.architecture-ledger" && child.status === "completed" &&
      /^ledger-(?:observe-)?\d+(?:\.r[12])?$/.test(child.key));
    if (!completed.length) continue;
    let journal;
    try { journal = readFileSync(safePath(path.join(run.asyncDir, "workflow-children.jsonl")), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw missing(); else continue; }
    const entries = journal.split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { throw missing(); }
    });
    for (const child of completed) {
      const start = entries.find(entry => entry.type === "start" && entry.key === child.key && entry.runId === child.runId);
      if (!hash(start?.fingerprint)) continue;
      const matches = entries.filter(entry => entry.type === "settle" && entry.key === child.key &&
        entry.fingerprint === start.fingerprint && entry.result?.runId === child.runId);
      for (const { result } of matches) {
        const row = result.results?.length === 1 ? result.results[0] : undefined;
        if (!result.ok || result.agent !== child.agent || result.key !== child.key || row?.agent !== child.agent ||
            row.exitCode !== 0 || [result, row].some(item => item.error || item.stopped || item.interrupted ||
              item.detached || item.timedOut || item.outputPartial || item.terminalOutcome || item.outputSaveError) ||
            typeof row.task !== "string" || typeof result.output !== "string" || Buffer.byteLength(result.output) > 61440)
          continue;
        let request, receipt;
        try { request = JSON.parse(row.task); receipt = JSON.parse(result.output); validateExpected(request.expected); }
        catch { continue; }
        if (request.missionPath !== missionPath || `arch:${request.consultation}` !== scope || receipt.stale ||
            receipt.identity?.root !== root || typeof receipt.identity.storeId !== "string" ||
            (request.identity && request.identity.root !== root))
          continue;
        const storeId = receipt.identity.storeId;
        const key = `${storeId}:${receipt.head}`;
        if (request.observe === true) {
          if (receipt.recovered === true && typeof request.identity?.storeId === "string" &&
              request.identity.storeId !== storeId && hash(receipt.head) &&
              receipt.count === request.expected.count && Number(child.key.match(/^ledger-observe-(\d+)/)?.[1]) === receipt.count)
            recoveries.set(key, { ...request.expected, storeId: request.identity.storeId });
          continue;
        }
        const seq = request.expected.count + 1, prev = request.expected.head;
        const { kind, round, body } = request.record ?? {};
        // A transition can commit its new genesis after restoring the prior scope.
        if (request.identity && request.identity.storeId !== storeId &&
            !(seq === 1 && kind === "admission" && body?.priorDecision)) continue;
        if (seq > expected.count + 1 || !validRecord(kind, round, seq) || receipt.count !== seq ||
            Number(child.key.match(/^ledger-(\d+)/)?.[1]) !== seq - 1)
          continue;
        let originals;
        try { if (kind === "round") originals = archiveOriginals(body); }
        catch { continue; } // This native request cannot prove the corresponding stored row.
        const record = { seq, kind, prev, body: { round, missionPath, body, ...(originals ? {originals} : {}) } };
        const digest = ledgerDigest(scope, record);
        if (digest === receipt.head) candidates.set(key, { ...record, digest });
      }
    }
  }
  function prove({ count, head, storeId }, visited = new Set()) {
    const suffix = [];
    for (let seq = count; seq > 0; seq--) {
      const key = `${storeId}:${head}`;
      const row = candidates.get(key);
      if (row?.seq !== seq) {
        const earlier = recoveries.get(key);
        if (earlier?.count !== seq || visited.has(key)) throw missing();
        visited.add(key);
        const prefix = rebindRecords(scope, prove(earlier, visited), earlier.storeId, storeId);
        if (prefix.at(-1)?.digest !== head) throw missing();
        return [...prefix, ...suffix.reverse()];
      }
      suffix.push(row);
      head = row.prev;
    }
    if (head !== null) throw missing();
    return suffix.reverse();
  }
  const prefix = prove({ ...expected, storeId: identity.storeId });
  // A native success may have been journaled immediately before the lost cursor save.
  const suffix = [...candidates.entries()].filter(([key, row]) =>
    key.startsWith(`${identity.storeId}:`) && row.seq === expected.count + 1 && row.prev === expected.head);
  if (suffix.length > 1) throw missing();
  return suffix.length ? [...prefix, suffix[0][1]] : prefix;
}

function recoverLedger(cwd, scope, missionPath, expected, identity, decisionDigest) {
  const store = new PitakoStore(cwd);
  const chain = nativeRecoveryRecords(missionPath, scope, expected, identity, store.root);
  if (decisionDigest !== undefined) decisionAt(chain.slice(0, expected.count), decisionDigest);
  const current = store.verifyForWrite(validateRecords);
  const records = rebindRecords(scope, chain, identity.storeId, current.storeId);
  const target = new PitakoStore(cwd, () => null, current);
  let head = null;
  for (const { seq, kind, body, digest } of records) {
    const genesis = seq === 1;
    const result = target.commit(scope, head, `${kind}:${seq}`,
      canonicalDigest({ missionPath: body.missionPath, kind, round: body.round, body: body.body }),
      () => ({ kind, body }), { admit: genesis, restore: genesis });
    if (result.outcome === "superseded") throw new StoreError("superseded", "Architecture consultation was superseded.");
    if (!["appended", "replay"].includes(result.outcome) || result.head?.hash !== digest)
      throw new Error("Architecture ledger integrity failure: native replay conflicts with the restored scope.");
    head = result.head;
  }
  const pinned = records[expected.count - 1];
  return { identity: current, head: { seq: pinned.seq, hash: pinned.digest } };
}

// Reconstruct the old pin from native originals and apply the same rebind as
// recovery. A storeId substitution alone cannot prove the historical digests.
export function memoReceiptHistory(cwd, missionPath, consultation, gate, pin, items) {
  const scope = scopeFor(consultation);
  const store = new PitakoStore(cwd);
  const { identity, records } = store.readRecords(scope, undefined, true);
  validateRecords(scope, records);
  boundMission(records, missionPath);
  const { seq, storeId } = pin.store;
  const failure = () => new Error("Architecture ledger integrity failure: memo receipt correspondence failed.");
  const row = records[seq - 1];
  const closed = row?.kind === "round" && closedRoundProjection([row], identity);
  const memo = closed?.dispatch;
  if (storeId === identity.storeId || memo?.controlOutput?.action !== "finish" ||
      gate !== `v${memo.revision}-memo-${memo.key}-a${memo.attempt}-a1` ||
      !items.some(item => item.id === memo.originalId && item.store?.seq === seq))
    throw failure();
  const chain = nativeRecoveryRecords(missionPath, scope, { count: seq, head: pin.digest }, { storeId }, identity.root).slice(0, seq);
  const rebound = rebindRecords(scope, chain, storeId, identity.storeId);
  if (rebound.some((record, index) => record.digest !== records[index].digest)) throw failure();
  return items.map(item => {
    if (!item.store) return item;
    const current = records[item.store.seq - 1], historical = chain[item.store.seq - 1];
    const original = current?.body.body.originals?.find(entry => entry.id === item.id);
    if (item.store.scope !== scope || item.store.storeId !== identity.storeId ||
        current?.digest !== item.digest || !historical || current.kind !== "round" ||
        (original?.key ?? original?.id.split(".")[2]) !== item.key ||
        !Object.hasOwn(current.body.originals ?? {}, item.id) ||
        canonicalDigest(current.body.originals[item.id]) !== original.digest)
      throw failure();
    return { ...item, store: { ...item.store, storeId }, digest: historical.digest };
  });
}

export function verifyLedger(missionPath, consultation, expected, cwd = process.cwd()) {
  validateExpected(expected);
  if (expected.count === 0) return [];
  const scope = scopeFor(consultation);
  const { records } = new PitakoStore(cwd).readRecords(scope, storeHead(expected));
  validateRecords(scope, records);
  boundMission(records, missionPath);
  return records.map(row => ({ seq: row.seq, prev: row.prev, kind: row.kind, round: row.body.round, body: row.body.body }));
}

/** Only the architecture runtime agent calls this writer; it never writes a file ledger. */
export function appendLedger(request, cwd = process.cwd()) {
  const { missionPath, consultation, expected, record, observe, memo, identity, decisionDigest, slots, steering, adoptHuman } = request;
  const scope = scopeFor(consultation);
  validateMissionPath(missionPath);
  validateExpected(expected);
  const names = `${adoptHuman === undefined ? "" : "adoptHuman,"}consultation,${decisionDigest === undefined ? "" : "decisionDigest,"}expected,${identity === undefined ? "" : "identity,"}`
    + (observe === true ? `${memo === undefined ? "" : "memo,"}missionPath,observe${slots === undefined ? "" : ",slots"}${steering === undefined ? "" : ",steering"}` : "missionPath,record");
  if (!keys(request, names) || (identity !== undefined && (!keys(identity, "root,storeId") ||
      typeof identity.root !== "string" || typeof identity.storeId !== "string")))
    throw new Error("Invalid architecture ledger request.");
  if (observe === true ? record !== undefined :
      !keys(record, "body,kind,round") || !validRecord(record.kind, record.round, expected.count + 1))
    throw new Error("Invalid architecture ledger request.");
  if (memo && (observe !== true || !keys(memo, "digest,path") || !hash(memo.digest)))
    throw new Error("Invalid memo reference.");
  if (decisionDigest !== undefined && (observe !== true || !hash(decisionDigest)))
    throw new Error("Invalid architecture decision reference.");
  if (adoptHuman !== undefined && (!decisionDigest || !(adoptHuman === true || hash(adoptHuman))))
    throw new Error("Invalid architecture answer adoption request.");
  if (steering !== undefined && (!decisionDigest || !slots || !keys(steering, "round,saved") ||
      !Array.isArray(steering.saved) || steering.saved.length > 3 ||
      steering.saved.some(item => !keys(item, "key,originalId,state"))))
    throw new Error("Invalid architecture steering observation.");
  if (slots !== undefined && (!decisionDigest || !Array.isArray(slots) || slots.length > 16 || slots.some(slot =>
      !keys(slot, "association,digest,runId,terminal") ||
      !keys(slot.association, "attempt,consultation,key,phase,producer,revision,round") ||
      slot.association.consultation !== consultation || !Number.isSafeInteger(slot.association.revision) ||
      !Number.isSafeInteger(slot.association.attempt) || !/^[\w-]{1,36}$/.test(slot.association.key) ||
      !(slot.digest === null || hash(slot.digest)) || !(slot.runId === null || typeof slot.runId === "string"))))
    throw new Error("Invalid architecture slot observation.");
  let store = new PitakoStore(cwd, () => null, identity);
  let pinned = { scope, head: storeHead(expected) }, current, recovered = false;
  const fresh = observe !== true && record.kind === "admission";
  const prior = fresh ? record.body?.priorDecision : undefined;
  let priorScope;
  if (prior !== undefined) {
    if (!identity || !keys(prior, "consultation,digest,head") || prior.consultation === consultation || !hash(prior.digest))
      throw new Error("Invalid prior architecture decision reference.");
    validateExpected(prior.head);
    if (prior.head.count === 0) throw new Error("Invalid prior architecture decision reference.");
    priorScope = scopeFor(prior.consultation);
    // The cursor-bound constructor already checked cwd. Verify the actual
    // store even on replacement, including a possible committed admission.
    store = new PitakoStore(cwd);
  }
  try {
    current = store.verifyForWrite(validateRecords, fresh ? undefined : pinned);
  } catch (error) {
    if (!lostStore(error)) throw error;
    if (priorScope && error.recovery) current = error.recovery;
    else {
      if (!observe || memo || !identity) throw error;
      const restored = recoverLedger(cwd, scope, missionPath, expected, identity, decisionDigest);
      current = restored.identity;
      pinned = { scope, head: restored.head };
      store = new PitakoStore(cwd, () => null, current);
      recovered = true;
    }
  }
  if (priorScope) store = new PitakoStore(cwd, () => null, current);
  const tip = store.readRecords(scope, undefined, !fresh);
  boundMission(tip.records, missionPath);
  if (observe) {
    const pendingKind = tip.records[expected.count]?.kind;
    const prefix = tip.records.slice(0, expected.count);
    if (adoptHuman !== undefined) {
      decisionAt(prefix, decisionDigest);
      const adopted = humanAdoption(tip.records, expected.count, adoptHuman, current, consultation, missionPath, steering, expected.head);
      if (adopted) return {...adopted, identity: current, ...(recovered ? {recovered: true} : {})};
    }
    const context = activeContext(prefix, current);
    const closedRound = decisionDigest === undefined ? undefined : closedRoundProjection(prefix, current);
    const native = slots === undefined ? undefined : observeSlots(missionPath, current.root, slots);
    const decisionRecord = prefix.findLast(row => ["admission", "decision"].includes(row.kind));
    const carried = decisionRecord?.kind === "decision" && !prefix.slice(decisionRecord.seq).some(row => row.kind === "round")
      ? decisionRecord.body.body.prior?.originals?.filter(item => item.round === decisionRecord.body.round) : undefined;
    const retry = prefix.findLast(row => row.kind === "context" && row.body.body.factualRetry)?.body.body.factualRetry;
    let steeringResult, inferredSteering;
    if (steering !== undefined) {
      const peers = slots.filter(slot => slot.association.phase === "architecture-perspective" && slot.association.round === steering.round);
      const reports = peers.flatMap(slot => native.filter(({entry}) => entry.key === slot.association.key && entry.round === steering.round && entry.runId && entry.digest && entry.relativePath));
      const refs = reports.map(({entry}) => ({key: entry.key, runId: entry.runId,
        path: `${entry.artifactRoot}/${entry.relativePath}`, digest: entry.digest}));
      const confirmed = reports.filter(({entry}) => peers.some(slot => slot.runId === entry.runId));
      const source = confirmed.length === 1 && confirmed[0].entry.sufficient && confirmed[0];
      const saved = steering.saved.length ? steering.saved : source
        ? peers.filter(({association}) => association.key !== source.entry.key)
          .map(({association}) => ({key: association.key, originalId: source.entry.id})) : [];
      if (!steering.saved.length && saved.length)
        inferredSteering = saved.map(item => ({...item, round: steering.round, state: "intended"}));
      const intentions = saved.map(({key, originalId}) => {
        const original = refs.find(ref => reports.some(({entry}) => entry.id === originalId && entry.key === ref.key));
        if (!original) throw new Error("Architecture ledger integrity failure: invalid steering intention.");
        return {key, original: original.key, digest: canonicalDigest({head: expected.head, round: steering.round, key, original})};
      });
      if (peers.length) steeringResult = observeSteering(missionPath, current.root, expected.head,
        {round: steering.round, keys: peers.map(slot => slot.association.key), refs, intentions});
    }
    let excerpt;
    if (memo) {
      const value = JSON.parse(readFileSync(safePath(memo.path), "utf8"));
      if (canonicalDigest(value) !== memo.digest || typeof value.memo !== "string") throw new Error("Memo digest/content mismatch.");
      excerpt = value.memo.slice(0, 240);
    }
    return { ...anchor(pinned.head), identity: current, ...(recovered ? { recovered: true } : {}),
      ...(Object.keys(context).length ? { context } : {}),
      ...(decisionDigest !== undefined ? { decision: decisionAt(prefix, decisionDigest) } : {}),
      ...(closedRound === undefined ? {} : { closedRound }),
      ...(native === undefined ? {} : { native }),
      ...(carried === undefined ? {} : {carried}),
      ...(retry === undefined ? {} : {retry: {consultation: retry.consultation, revision: retry.revision, originalIds: retry.originalIds, authorization: true}}),
      ...(inferredSteering === undefined ? {} : {inferredSteering}),
      ...(steeringResult === undefined ? {} : { steering: steeringResult }),
      ...(pendingKind ? { pendingKind } : {}), ...(excerpt !== undefined ? { excerpt } : {}) };
  }
  const { kind, round, body } = record;
  // On replay the verified genesis and its request digest already pin this
  // admission. Do not try to restore a prior scope that it has superseded.
  if (priorScope && !tip.records.length) {
    let priorHead = storeHead(prior.head), records;
    if (current.storeId === identity.storeId) {
      try {
        records = store.readRecords(priorScope, priorHead).records;
      } catch (error) {
        if (!lostStore(error)) throw error;
        // Only a writer may quarantine a missing pin or a damaged chain.
        try {
          store.verifyForWrite(validateRecords, { scope: priorScope, head: priorHead });
          records = store.readRecords(priorScope, priorHead).records;
        } catch (failure) {
          if (!lostStore(failure)) throw failure;
        }
      }
    }
    if (!records) {
      const restored = recoverLedger(cwd, priorScope, missionPath, prior.head, identity, prior.digest);
      store = new PitakoStore(cwd, () => null, restored.identity);
      records = store.readRecords(priorScope, restored.head).records;
    }
    boundMission(records, missionPath);
    if (decisionAt(records, prior.digest).snapshot.brief.trim() === body.currentDecision.snapshot.brief.trim())
      throw new Error("A continuation cannot reset the same decision.");
  }
  const opKey = `${kind}:${expected.count + 1}`;
  const originals = kind === "round" && !tip.records.some(row => row.seq === expected.count + 1)
    ? archiveOriginals(body, tip.records) : undefined;
  const committed = store.commit(scope, pinned.head, opKey, canonicalDigest({ missionPath, kind, round, body }),
    () => ({ kind, body: { round, missionPath, body, ...(originals === undefined ? {} : {originals}) } }), { admit: fresh });
  if (committed.outcome === "superseded")
    throw new StoreError("superseded", "Architecture consultation was superseded.");
  if (committed.outcome === "replay-differs") throw new Error("Architecture ledger publication conflict.");
  if (committed.outcome === "stale") {
    const {records} = store.readRecords(scope, committed.head, true);
    const suffix = records.slice(expected.count);
    const latest = suffix.findLast(row => row.kind === "decision" || row.kind === "round");
    const body = latest?.body.body;
    const recoveredDecision = records.findLast(row => row.kind === "decision" || row.kind === "admission")?.body.body.currentDecision;
    const closed = latest?.kind === "round" && body.comparison !== "failed" ? closedRoundProjection(records, committed.identity) : undefined;
    const source = latest?.kind === "decision" ? body.prior : body;
    const changes = suffix.filter(row => row.seq > (latest?.seq ?? 0) && row.kind === "context");
    const retry = changes.findLast(row => row.body.body.factualRetry)?.body.body;
    const answered = changes.findLast(row => row.body.body.humanAnswers)?.body.body.humanAnswers;
    return { ...anchor(committed.head), identity: committed.identity, stale: true, P: {
      ...(recoveredDecision ? { decision: {revision: recoveredDecision.revision, digest: canonicalDigest(recoveredDecision)} } : {}),
      ...(source ? { rounds: source.rounds, validRounds: source.validRounds, directorRunId: source.directorRunId,
        prepareAttempt: source.cursor?.prepareAttempt, closed } : {}),
      context: activeContext(records, committed.identity),
      ...(answered ? { answered: {round: answered.round, revision: answered.revision} } : {}),
      contextRound: Math.max(0, ...changes.map(row => row.body.round)),
      callerEvidence: changes.some(row => row.body.body.callerEvidence),
      ...(retry ? { retry: retry.superseded.map(({key, attempt}) => ({key, attempt})) } : {}),
    } };
  }
  const closedRound = kind === "round" ? closedRoundProjection([{
    kind, body: committed.result, scope, seq: committed.head.seq, digest: committed.head.hash,
  }], committed.identity) : undefined;
  return { ...anchor(committed.head), identity: committed.identity,
    ...(closedRound === undefined ? {} : { closedRound }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const output = JSON.stringify(appendLedger(readRequest(readFileSync(0, "utf8"))));
    if (Buffer.byteLength(output) > 61440) throw new Error("Architecture ledger receipt exceeds 61440 bytes.");
    process.stdout.write(output + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: "ledger-integrity", reason: String(error.message).slice(0, 1024),
      ...(error instanceof StoreError ? { code: error.code, recovery: error.recovery } : {}) }) + "\n");
    // A busy response is part of the writer protocol; native failures still veto retry.
    if (!(error instanceof StoreError && error.code === "store-busy")) process.exitCode = 1;
  }
}
