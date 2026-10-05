import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerHistory } from "../extensions/agent/history.ts";
import { projectManagedHistory, managedHistoryAdmission } from "../extensions/agent/managed-mission.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { createPiMissionRunner, MissionEngine } from "../extensions/mission/engine.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "../tests/mission-fixtures.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";
import { pruneWorkerHistory } from "../extensions/agent/history-retention.ts";
import { queryHistory } from "../extensions/agent/history-query.ts";
import { openHistoryChild } from "../tests/fixtures/history-fixture-ownership.ts";

const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
if (process.argv[2] === "read") {
  const history = new WorkerHistory();
  const before = history.list();
  const dbHashes = before.map((group) => hash(group.missionStore.dbPath));
  const projections = await Promise.all(before.map(projectManagedHistory));
  assert.deepEqual(before.map((group) => hash(group.missionStore.dbPath)), dbHashes);
  assert.deepEqual(history.list(), before);
  console.log(JSON.stringify(projections));
} else if (process.argv.includes("--reuse-fallback")) {
  const argument = process.argv.indexOf("--reuse-fallback");
  const owned = openHistoryChild(process.argv[argument + 1], process.argv[argument + 2]);
  const errors = [];
  const record = (phase) => {
    owned.receipt.phase = phase;
    try { owned.record(); } catch (error) {
      errors.push(error);
      owned.receipt.errors.push(`receipt: ${String(error)}`);
    }
  };
  let store;
  let engine;
  try {
    record("fixture-acquisition");
    const sample = createMissionFixture("pitako-managed-reuse-", process.argv[argument + 1]);
    owned.receipt.fixtureBase = sample.base;
    owned.receipt.resources = { repository: sample.root, agent: path.join(sample.base, "agent"),
      database: sample.dbPath, objects: sample.objectDir, sessions: path.join(sample.base, "sessions"),
      candidates: path.join(sample.base, "candidates") };
    record("fixture-acquired");
    const agentDir = path.join(sample.base, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const config = path.join(agentDir, "pitako/config.toml");
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, "");
    mkdirSync(path.join(sample.root, "src"));
    writeFileSync(path.join(sample.root, "src", "target.txt"), "source\n");
    record("provider-acquisition");
    const provider = await installMissionLocalProvider({ agentDir, errorForRequest: () => "429 rate limit exceeded" });
    const definition = missionDefinition();
    definition.units[0].retryLimit = 0;
    definition.units[0].kind = "check";
    definition.authority.allowedPaths = ["src/**"];
    definition.budget = { roleLaunches: 4, providerRequests: 4, tokens: 10000, activeTimeMs: 600000, artifactBytes: 2500000 };
    definition.authority.rolePolicies.developer = {
      hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: ["cursor/composer"],
    };
    writeFileSync(sample.definitionFile, JSON.stringify(definition));
    record("store-acquisition");
    store = await openFixtureStore(sample);
    owned.receipt.storeClose = "pending";
    record("store-acquired");
    const sdk = createPiExecutor();
    const history = new WorkerHistory(agentDir);
    const starts = [];
    const executor = { ...sdk, async start(input) {
      record(`sdk-start:${starts.length}`);
      const before = history.list()[0]?.members[0]?.native;
      const result = await sdk.start(input);
      starts.push({ attemptId: input.durable.attemptId, target: input.target.model,
        hasEffects: Boolean(input.durable.effects), before, after: history.list()[0].members[0].native,
        status: result.status, error: result.error, result: result.result, failureKind: result.failureKind,
        sideEffects: result.sideEffects, hasSession: Boolean(result.session) });
      return result;
    } };
    const mission = store.createMission(missionInput(sample));
    const runner = createPiMissionRunner({ cwd: sample.root, executor,
      load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } });
    let runnerResult;
    record("engine-acquisition");
    engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      managedWorkspace: { sourceRoot: sample.root, candidateParent: path.join(sample.base, "candidates") },
      runRole: async (...args) => { runnerResult = await runner(...args); return runnerResult; },
      assessPredicate: async () => ({ verdict: "fail", method: "fallback fixture does not accept" }),
    });
    owned.receipt.engineClose = "pending";
    record("engine-start");
    engine.start();
    await engine.waitForIdle();
    assert.equal(starts.length, 2);
    assert.equal(provider.trace.length, 1, "only local 429 reaches a provider");
    const [first, second] = starts;
    assert.equal(first.status, "failed");
    assert.equal(first.error, "429 rate limit exceeded");
    assert.equal(first.result, "");
    assert.equal(first.failureKind, undefined);
    assert.equal(first.sideEffects, false);
    assert.equal(first.hasSession, true, "real public SDK handle returned before fallback");
    assert.equal(first.after.disposition.state, "pending");
    assert.equal(second.attemptId, first.attemptId);
    assert.equal(second.target, "cursor/composer");
    assert.equal(second.hasEffects, true, "MissionEngine supplies fenced durable context");
    assert.equal(second.status, "failed");
    assert.equal(second.failureKind, "configuration");
    assert.equal(second.error, undefined);
    assert.equal(second.sideEffects, false);
    assert.equal(second.hasSession, false);
    assert.equal(second.result, "managed missions deny Cursor/provider-native execution because it bypasses fenced local adapters");
    assert.equal(second.before.disposition.state, "disposed", "loop really disposed first SDK handle");
    assert.ok(second.before.disposition.at);
    const inspection = store.inspectMission(mission.id);
    const receipt = inspection.events.find((row) => row.kind === "attempt.receipt");
    assert.equal(receipt.attemptId, first.attemptId);
    assert.equal(receipt.payload.status, "failed");
    assert.equal(runnerResult.status, "failed");
    assert.equal(runnerResult.result, "agent failed");
    assert.equal(receipt.payload.resultHash, createHash("sha256").update(runnerResult.result).digest("hex"));
    assert.equal(receipt.payload.model.selectedModel, "cursor/composer");
    assert.equal(receipt.payload.model.fallbackOccurred, true);
    assert.equal(receipt.payload.model.fallbackReason, "rate_limit");
    assert.equal(receipt.payload.model.fallbackIndex, 0);
    const projection = await projectManagedHistory(history.list()[0]);
    console.log(JSON.stringify({ starts, receipt: receipt.payload, reasons: projection.reasons, localRequests: provider.trace.length }));
    assert.deepEqual(second.after, second.before, "no-association start preserves canonical allocation and exact disposal timestamp");
    assert(!projection.reasons.includes(`SDK disposal not confirmed: ${first.attemptId}`));
    owned.receipt.assertions = "ok";
    record("assertions-complete");
  } catch (error) {
    errors.push(error);
    owned.receipt.assertions = "failed";
    owned.receipt.errors.push(`primary: ${String(error)}`);
  } finally {
    if (engine) {
      record("engine-close");
      try { await engine.close(); owned.receipt.engineClose = "ok"; }
      catch (error) {
        errors.push(error);
        owned.receipt.engineClose = "failed";
        owned.receipt.errors.push(`engine.close: ${String(error)}`);
      }
    }
    // Do not race a pending engine.close; a rejection still permits independent store cleanup.
    if (store) {
      record("store-close");
      try { store.close(); owned.receipt.storeClose = "ok"; }
      catch (error) {
        errors.push(error);
        owned.receipt.storeClose = "failed";
        owned.receipt.errors.push(`store.close: ${String(error)}`);
      }
    }
    record("complete");
    // The parent alone deletes the fixture, after native result and receipt validation.
  }
  if (errors.length) throw new AggregateError(errors, "History fixture primary/cleanup failure");
} else {
  const data = mkdtempSync(path.join(tmpdir(), "pitako-managed-history-data-"));
  const sample = createMissionFixture("pitako-managed-history-node-");
  process.env.PITAKO_DATA_DIR = data;
  const agentDir = path.join(sample.base, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const config = path.join(agentDir, "pitako/config.toml");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, "");
  const provider = await installMissionLocalProvider({ agentDir });
  const definition = missionDefinition();
  definition.units[0].retryLimit = 1;
  definition.budget = { roleLaunches: 10, providerRequests: 10, tokens: 10000, activeTimeMs: 600000, artifactBytes: 2500000 };
  definition.authority.rolePolicies.developer = {
    hash: "a".repeat(64), provider: provider.provider, model: provider.model, fallbacks: [],
  };
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(sample);
  const sdk = createPiExecutor();
  let starts = 0;
  const executor = { ...sdk, async start(input) {
    let maintenance;
    let nativeBefore;
    if (process.argv.includes("--retention") && starts === 1) {
      const history = new WorkerHistory();
      const [group] = history.list();
      assert.equal(group.members.length, 1);
      assert.equal(group.members[0].native.disposition.state, "disposed");
      nativeBefore = { file: group.members[0].native.path, bytes: readFileSync(group.members[0].native.path) };
      // The second reservation exists, but SDK admission has not happened yet.
      // Production prune must not hold the catalog lock while inspecting this live mission.
      maintenance = pruneWorkerHistory(history, 180, { now: Date.now() + 181 * 86400000 });
    }
    const starting = sdk.start(input); // SDK history admission runs before its first await.
    if (maintenance) {
      const history = new WorkerHistory();
      assert.equal(history.list()[0].members.length, 2, "live SDK admission succeeds while maintenance is pending");
      const report = await maintenance;
      assert.equal(report.groups[0].state, "protected");
      assert.deepEqual(readFileSync(nativeBefore.file), nativeBefore.bytes);
      assert.equal(history.list()[0].cleanup, undefined);
    }
    const result = await starting;
    if (maintenance) {
      assert.ok(result.session, "live SDK association and execution succeed after maintenance yields");
      console.log("maintenance-first managed race: live SDK admission and association succeed; cleaner protected; prior native bytes intact");
    }
    if (++starts !== 1) return result;
    assert.ok(result.session);
    // Existing resume handle deliberately omits durable in runTarget; history must survive that boundary.
    return result.session.continueWith(input.target, "Independent native continuation observation", input.signal);
  } };
  let engine;
  let release;
  try {
    const mission = store.createMission(missionInput(sample));
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const atAssessment = new Promise((resolve) => { entered = resolve; });
    let assessments = 0;
    engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(sample.base, "sessions"),
      runRole: createPiMissionRunner({ cwd: sample.root, executor,
        load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config } }),
      assessPredicate: async () => {
        if (++assessments === 1) return { verdict: "fail", method: "first attempt rejected" };
        entered(); await gate;
        return { verdict: "pass", method: "second attempt accepted" };
      },
    });
    engine.start();
    await atAssessment;
    const pause = engine.control("pause");
    release();
    await pause;
    await engine.waitForIdle();
    assert.equal(store.inspectMission(mission.id).state, "paused");
    const history = new WorkerHistory();
    const [group] = history.list();
    assert.equal(history.list().length, 1);
    assert.equal(group.coverage, "complete");
    assert.equal(group.members.length, 2);
    assert.equal(group.members[1].retryOf, group.members[0].attemptId);
    assert.equal(group.members[1].continuationOf, undefined);
    const reservations = store.inspectMission(mission.id).events.filter((row) => row.kind === "attempt.reserved");
    assert.deepEqual(group.members.map((member) => member.attemptId), reservations.map((row) => row.attemptId));
    for (const member of group.members) {
      assert.equal(member.native.state, "allocated");
      assert.equal(member.native.sessionId, member.attemptId);
      assert.equal(member.native.disposition.state, "disposed");
      assert.ok(existsSync(member.native.path));
      const native = readFileSync(member.native.path, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(native[0].id, member.attemptId);
      assert.ok(native.some((row) => row.type === "message" && row.message.role === "assistant"));
      const origin = native.find((row) => row.customType === "pitako.worker-history" && row.data.event === "origin");
      assert.ok(origin.data.data.workbrief);
      assert.ok(native.some((row) => row.type === "message" && row.message.role === "user"), "observed prompt remains native");
      if (member === group.members[0]) {
        assert.ok(native.some((row) => row.customType === "pitako.worker-history" && row.data.event === "continuation"));
        assert.ok(native.some((row) => row.type === "message" && row.message.role === "user" &&
          JSON.stringify(row.message.content).includes("Independent native continuation observation")));
        assert.ok(!origin.data.data.workbrief.includes("Independent native continuation observation"));
      }
    }
    const read = () => {
      const child = spawnSync("node", ["--import", "./scripts/sdk-node-loader.mjs", "scripts/managed-history-node.mjs", "read"],
        { encoding: "utf8", env: process.env, timeout: 30000 });
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout)[0];
    };
    const journal = store.inspectMission(mission.id);
    assert.equal(read().protected, true);
    if (process.argv.includes("--retention"))
      assert.equal((await pruneWorkerHistory(history, 180, { now: Date.now() + 181 * 86400000 })).groups[0].state,
        "protected", "disposed real SDK members in a paused mission remain protected");
    assert.deepEqual(store.inspectMission(mission.id), journal);
    await engine.control("resume");
    await engine.waitForIdle();
    assert.equal(provider.trace.length, 3, "resumption consumes existing receipt without another SDK attempt");
    assert.equal(new Set(provider.trace.map((row) => row.sessionId)).size, 2, "native continuation does not allocate another session");
    assert.equal(store.inspectMission(mission.id).events.filter((row) => row.kind === "unit.accepted").length, 1);
    await engine.control("cancel");
    assert.equal(read().closure.state, "closed", "confirmed terminal managed P1 history can close");
    const closed = history.read(group.groupId);
    history.mutate(group.groupId, (saved) => { saved.members[1].native.disposition = { state: "pending" }; });
    assert.equal(read().protected, true, "cancelled is not SDK disposal proof");
    if (process.argv.includes("--retention")) {
      const now = Date.now() + 181 * 86400000;
      const uncertain = await pruneWorkerHistory(history, 180, { now });
      assert.equal(uncertain.groups[0].state, "protected");
      assert.ok(closed.members.every((member) => existsSync(member.native.path)));
      history.recordDisposition(group.groupId, closed.members[1].historyId, closed.members[1].native.disposition);
      history.mutate(group.groupId, (saved) => { saved.coverage = "partial"; });
      assert.equal((await pruneWorkerHistory(history, 180, { now })).groups[0].state, "protected");
      history.mutate(group.groupId, (saved) => { saved.coverage = "complete"; saved.missionStore.dbPath += ".unreadable"; });
      assert.equal((await pruneWorkerHistory(history, 180, { now })).groups[0].state, "protected",
        "unavailable current authority never licenses deletion of disposed native files");
      assert.ok(closed.members.every((member) => existsSync(member.native.path)));
      history.mutate(group.groupId, (saved) => { saved.missionStore.dbPath = closed.missionStore.dbPath; });
      const inspection = store.inspectMission(mission.id);
      const authorityBytes = hash(store.historyLocator.dbPath);
      const contractBytes = [hash(sample.planFile), hash(sample.definitionFile)];
      const userSession = path.join(agentDir, "sessions", "user-sentinel.jsonl");
      mkdirSync(path.dirname(userSession), { recursive: true });
      writeFileSync(userSession, "user session sentinel");
      const sentinel = path.join(path.dirname(closed.members[0].native.path), "foreign.jsonl");
      writeFileSync(sentinel, "foreign native sentinel");
      const before = history.read(group.groupId);
      const dry = await pruneWorkerHistory(history, 180, { now, dryRun: true });
      assert.equal(dry.groups[0].state, "eligible", "real P1 members, native SDK and fresh read-only authority positively eligible");
      assert.deepEqual(history.read(group.groupId), before);
      assert.ok(closed.members.every((member) => existsSync(member.native.path)));
      const pruned = await pruneWorkerHistory(history, 180, { now });
      assert.equal(pruned.groups[0].state, "pruned");
      assert.ok(closed.members.every((member) => !existsSync(member.native.path)));
      assert.equal(readFileSync(sentinel, "utf8"), "foreign native sentinel");
      assert.equal(readFileSync(userSession, "utf8"), "user session sentinel");
      assert.deepEqual([hash(sample.planFile), hash(sample.definitionFile)], contractBytes);
      assert.deepEqual(store.inspectMission(mission.id), inspection, "retention does not change logical authority");
      assert.equal(hash(store.historyLocator.dbPath), authorityBytes);
      for (const member of closed.members)
        assert.ok((await queryHistory({ action: "read", historyId: member.historyId })).diagnostics.some((row) => row.code === "history_pruned"));
      console.log("managed retention Node proof: real two-member SDK disposal; cancelled uncertain protected; fresh SELECT authority eligible; owned JSONL pruned; authority and foreign sentinel unchanged");
      await engine.close(); engine = undefined;
    } else {
    history.recordDisposition(group.groupId, closed.members[1].historyId, closed.members[1].native.disposition);
    await engine.close(); engine = undefined;
    store.close();
    const paths = closed.members.map((member) => member.native.path);
    rmSync(sample.root, { recursive: true });
    assert.equal(read().closure.state, "closed", "known locator works after worktree removal");
    assert.deepEqual(read().group.members.map((member) => member.native.path), paths);
    history.mutate(group.groupId, (saved) => { saved.members = []; });
    const legacy = read();
    assert.equal(legacy.group.coverage, "partial");
    assert.equal(legacy.group.members.length, 2);
    assert.equal(legacy.protected, true);
    assert.deepEqual(legacy.group.members.map((member) => member.native.path), paths);
    assert.ok(legacy.group.members.every((member) => member.native.disposition.state === "unknown"));
    assert.equal(history.read(group.groupId).members.length, 0, "projection does not silently backfill catalog");

    const binding = reservations[1].payload.binding;
    const team = managedHistoryAdmission(journal, { ...binding, memberId: "alpha", continuationOf: "parent" });
    assert.equal(team.memberId, "alpha");
    assert.equal(team.continuationOf, "parent");
    assert.equal(team.retryOf, undefined);
    const diagnosis = managedHistoryAdmission(journal, { ...binding, recoveryOf: "prior" }, undefined,
      { roleId: "architect", sourceAttemptId: "source" });
    assert.equal(diagnosis.diagnosisId, binding.attemptId);
    assert.equal(diagnosis.diagnosisOf, "source");
    assert.equal(diagnosis.roleId, "architect");
    assert.equal(diagnosis.recoveryOf, "prior");
    console.log("managed history Node proof: retry/native identity, pause/resume, separate-process nonmutation, disposal closure, removed worktree and legacy gaps");
    }
  } finally {
    release?.();
    await engine?.close();
    store.close();
    rmSync(sample.base, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
}
