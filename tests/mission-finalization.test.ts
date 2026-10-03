import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../extensions/mission/model.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import { openBoard } from "../extensions/board/store.ts";
import { openSqlite } from "../extensions/board/sqlite.ts";
import { repositoryIdentity } from "../extensions/board/workspace.ts";
import { registerBoard } from "../extensions/board/tools.ts";
import { openExecutionPlan } from "../extensions/workflow.ts";
import { missionCompletionBlockers, missionCompletionCertificate } from "../extensions/mission/completion.ts";
import { nextPlanBytes, pendingMissionQuestions, recordOperatorInput, admitMissionChange, askMissionChoice } from "../extensions/mission/admission.ts";
import { MissionEngine, reduceMissionEvents } from "../extensions/mission/engine.ts";
import { captureWorkspaceImage, currentProcessIdentity, filterWorkspaceImage } from "../extensions/mission/workspace.ts";
import { missionHasUnresolvedEffects, reconcileMission, sealWorkspaceImage } from "../extensions/mission/reconcile.ts";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore, operatorChangeReceipt } from "./mission-fixtures.ts";
import { EVENT_KINDS } from "../extensions/mission/store.ts";
import { COMPLETION_AUDIT_POLICY } from "../extensions/mission/completion-evidence.ts";
import type { MissionEventDraft } from "../extensions/mission/store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const sample = createMissionFixture("mission-finalization-"); roots.push(sample.base);
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const add = (...events: Array<{ kind: string; payload?: Record<string, unknown>; effectId?: string; attemptId?: string }>) => {
    const current = store.inspectMission(mission.id);
    store.appendTransition(mission.id, current.version, { events: events.map((event): MissionEventDraft => ({
      revision: current.revision, kind: event.kind, causalId: randomUUID(), payload: event.payload ?? {},
      effectId: event.effectId, attemptId: event.attemptId,
    })) });
  };
  const complete = () => {
    const current = store.inspectMission(mission.id);
    return store.appendTransition(mission.id, current.version, { events: [{ revision: current.revision, kind: "mission.completed", causalId: randomUUID(), payload: {} }] });
  };
  return { sample, store, mission, add, complete };
}

const causeBlockers = (store: Awaited<ReturnType<typeof openFixtureStore>>, id: string, prefix: string) =>
  missionCompletionBlockers(store.inspectMission(id), store).filter((item) => item.startsWith(prefix));

test("completion audit policy covers exactly the persisted event catalog", () => {
  expect(Object.keys(COMPLETION_AUDIT_POLICY).sort()).toEqual([...EVENT_KINDS].sort());
});

test("unknown persisted event kind fails closed, including an inherited object key", async () => {
  const { store, mission } = await fixture();
  try {
    for (const kind of ["future.effect", "constructor"]) {
      const inspection = store.inspectMission(mission.id);
      const forged = { ...inspection, events: [...inspection.events, {
        ...inspection.events[0]!, kind, eventId: randomUUID(), seq: inspection.latestSeq + 1,
      }] };
      expect(missionCompletionBlockers(forged, store)).toEqual(expect.arrayContaining([
        "effect:unbound", "writer:unbound",
      ]));
    }
  } finally { store.close(); }
});

test("whole-history effect exposure survives every adjacent no-effect terminal shape", async () => {
  const baselines = [
    { name: "sole-denial", rows: [{ kind: "effect.denied", payload: { reason: "prelaunch" } }] },
    { name: "denial", rows: [
      { kind: "effect.intent", payload: { operation: "write" } },
      { kind: "effect.denied", payload: { reason: "prelaunch" } },
      { kind: "effect.receipt", payload: { status: "denied", process: null, paths: [] } },
    ] },
    { name: "producer-denied-receipt", rows: [
      { kind: "effect.intent", payload: { operation: "write" } },
      { kind: "effect.invoking", payload: { operation: "write" } },
      { kind: "effect.receipt", payload: { status: "denied", process: null, paths: [] } },
    ] },
    { name: "unstarted", rows: [
      { kind: "effect.intent", payload: { operation: "write" } },
      { kind: "effect.reconciled", payload: { disposition: "unstarted" } },
    ] },
  ];
  const adverse = [
    { name: "sealed-effect", kind: "workspace.snapshot.sealed", payload: { phase: "effect", imageHash: "a".repeat(64) } },
    { name: "observed-image", kind: "workspace.snapshot.sealed", payload: { phase: "observed", imageHash: "a".repeat(64) } },
    { name: "registered", kind: "effect.process.registered", payload: { identity: { pid: 1 } } },
    { name: "unknown", kind: "effect.observation.recorded", payload: { disposition: "unknown" } },
    { name: "outcome", kind: "effect.reconciled", payload: { disposition: "applied", probe: { proofKind: "candidate-after-image-v1" } } },
    { name: "receipt", kind: "effect.receipt", payload: { status: "completed", paths: [], process: {} } },
  ];
  for (const baseline of baselines) {
    for (const injected of adverse) {
      const { store, mission, add } = await fixture();
      try {
        const effectId = randomUUID();
        const rows = baseline.rows.map((row) => ({ ...row, effectId, payload: { effectId, ...row.payload } }));
        expect(causeBlockers(store, mission.id, "effect:")).toEqual([]);
        add(...rows);
        if (baseline.name === "unstarted") expect(causeBlockers(store, mission.id, "effect:")).toEqual([]);
        else expect(causeBlockers(store, mission.id, "effect:")).toEqual([]);
        for (const at of [0, Math.max(1, rows.length - 1), rows.length]) {
          const { store: variant, mission: vMission, add: vAdd } = await fixture();
          try {
            const claim = { ...injected, effectId, payload: { effectId, ...injected.payload } };
            vAdd(...[...rows.slice(0, at), claim, ...rows.slice(at)]);
            expect(causeBlockers(variant, vMission.id, "effect:")).toContain(`effect:${effectId}`);
            vAdd({ kind: "mission.owner.released", payload: { effectsQuiescent: true, interruptedAttempts: [] } },
              { kind: "effect.reconciled", effectId, payload: { effectId, disposition: "unstarted" } });
            expect(causeBlockers(variant, vMission.id, "effect:")).toContain(`effect:${effectId}`);
          } finally { variant.close(); }
        }
      } finally { store.close(); }
    }
  }
}, 30_000);

test("typed outcome and identity inside a terminal never turn exposure into no-effect", async () => {
  const mutations = [
    { kind: "effect.invoking", payload: { operation: "different-operation" } },
    { kind: "effect.reconciled", payload: { disposition: "unstarted", probe: { disposition: "applied" } } },
    { kind: "effect.reconciled", payload: { disposition: "unstarted", proofKind: "host-external-probe-v1" } },
    { kind: "effect.reconciled", payload: { disposition: "unstarted", resultHash: "a".repeat(64) } },
    { kind: "effect.receipt", payload: { status: "denied", process: null, paths: [], outputTruncated: false } },
    { kind: "effect.receipt", payload: { status: "denied", process: null, paths: [{ path: "changed" }] } },
  ];
  for (const row of mutations) {
    const { store, mission, add } = await fixture();
    try {
      const effectId = randomUUID();
      add({ kind: "effect.intent", effectId, payload: { effectId, operation: "write" } },
        { ...row, effectId, payload: { effectId, ...row.payload } });
      expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
    } finally { store.close(); }
  }
  const { store, mission, add } = await fixture();
  try {
    const one = randomUUID(), other = randomUUID();
    add({ kind: "effect.intent", effectId: one, payload: { effectId: other, operation: "write" } },
      { kind: "effect.reconciled", effectId: one, payload: { effectId: one, disposition: "unstarted" } });
    expect(causeBlockers(store, mission.id, "effect:")).toEqual(expect.arrayContaining([`effect:${one}`, `effect:${other}`]));
  } finally { store.close(); }
});

test("a denied receipt cannot clear a different operation or request", async () => {
  for (const mismatch of [{ operation: "bash" }, { requestHash: "b".repeat(64) }]) {
    const { store, mission, add } = await fixture();
    try {
      const effectId = randomUUID();
      add({ kind: "effect.intent", effectId, payload: { effectId, operation: "write", requestHash: "a".repeat(64) } },
        { kind: "effect.invoking", effectId, payload: { effectId, operation: "write" } },
        { kind: "effect.receipt", effectId, payload: { effectId, operation: "write",
          requestHash: "a".repeat(64), ...mismatch, status: "denied", process: null, paths: [] } });
      expect(causeBlockers(store, mission.id, "effect:")).toEqual([`effect:${effectId}`]);
      expect(missionHasUnresolvedEffects(store, store.inspectMission(mission.id).events)).toBe(true);
    } finally { store.close(); }
  }
});

test("unreserved attempts and missing typed result chain retain writer obligation", async () => {
  for (const omit of ["reservation", "start", "receipt", "settlement", "stored-result", "identity"] as const) {
    const { store, mission } = await fixture();
    try {
      const attemptId = randomUUID();
      const result = Buffer.from("opaque worker text");
      const resultHash = sha256(result);
      const binding = { attemptId, missionId: mission.id, revision: 1, unitId: "snapshot" };
      const rows = [
        { kind: "attempt.reserved", attemptId, payload: { attemptId, unitId: "snapshot", roundId: "main",
          memberId: "solo", binding } },
        { kind: "attempt.started", attemptId, payload: { attemptId, unitId: "snapshot" } },
        { kind: "attempt.receipt", attemptId, payload: { attemptId, unitId: "snapshot", status: "completed",
          artifactHash: resultHash, resultHash } },
        { kind: "attempt.settled", attemptId, payload: { attemptId, status: "succeeded", resultHash } },
      ];
      const current = store.inspectMission(mission.id);
      store.appendTransition(mission.id, current.version, {
        events: rows.filter((row) => !(omit === "reservation" && row.kind === "attempt.reserved") &&
          !(omit === "start" && row.kind === "attempt.started") &&
          !(omit === "receipt" && row.kind === "attempt.receipt") &&
          !((omit === "settlement" || omit === "reservation") && row.kind === "attempt.settled")).map((row) => ({
            ...row, revision: 1, unitId: "snapshot", causalId: randomUUID(),
            payload: omit === "identity" && row.kind === "attempt.receipt"
              ? { ...row.payload, attemptId: randomUUID() } : row.payload,
          })),
        artifacts: omit === "stored-result" ? [] : [{ bytes: result, mediaType: "text/plain" }],
      });
      expect(causeBlockers(store, mission.id, "writer:")).toContain(`writer:${attemptId}`);
    } finally { store.close(); }
  }
});

test("base image and real producer prelaunch denied receipt remain effect-clear", async () => {
  for (const terminal of [
    { kind: "effect.receipt", payload: { status: "denied", process: null, paths: [] } },
    { kind: "effect.reconciled", payload: { disposition: "unstarted" } },
  ]) {
    const { store, mission, add } = await fixture();
    try {
      const effectId = randomUUID(), attemptId = randomUUID();
      add({ kind: "effect.intent", effectId, attemptId, payload: { effectId, attemptId, operation: "write" } },
        { kind: "workspace.snapshot.sealed", effectId, attemptId, payload: {
          effectId, attemptId, phase: "base", imageHash: "a".repeat(64), manifestHash: "b".repeat(64),
        } },
        ...(terminal.kind === "effect.receipt" ? [{ kind: "effect.invoking", effectId, attemptId, payload: { effectId, operation: "write" } }] : []),
        { ...terminal, effectId, attemptId, payload: { effectId, ...terminal.payload } });
      expect(causeBlockers(store, mission.id, "effect:")).toEqual([]);
    } finally { store.close(); }
  }
});

test("invoking without denial remains uncertain after retirement; plain intent stays unstarted on repeated recovery", async () => {
  for (const invoking of [false, true]) {
    const { sample, store, mission, add } = await fixture();
    const effectId = randomUUID();
    add({ kind: "effect.intent", effectId, payload: { effectId, operation: "write" } });
    if (invoking) add({ kind: "effect.invoking", effectId, payload: { effectId, operation: "write" } });
    add({ kind: "mission.owner.released", payload: { owner: currentProcessIdentity(store.runtimeId, store.ownerEpoch!),
      effectsQuiescent: true, interruptedAttempts: [] } });
    store.close();
    const next = await openFixtureStore(sample);
    try {
      for (const trigger of ["first", "second"]) {
        const report = await reconcileMission({ store: next, missionId: mission.id, sourceRoot: sample.root,
          planFile: sample.planFile, trigger });
        expect(report.effects.map((item) => item.disposition)).toEqual([invoking ? "unknown" : "unstarted"]);
        expect(report.status).toBe(invoking ? "blocked" : "resumed");
        expect(causeBlockers(next, mission.id, "effect:")).toEqual(invoking ? [`effect:${effectId}`] : []);
      }
      const kinds = next.inspectMission(mission.id).events.filter((event) => event.effectId === effectId)
        .map((event) => event.kind);
      expect(kinds.filter((kind) => kind === "effect.observation.recorded")).toHaveLength(invoking ? 2 : 0);
      expect(kinds.filter((kind) => kind === "effect.reconciled")).toHaveLength(invoking ? 0 : 1);
      if (!invoking) {
        const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
        try { expect(causeBlockers(reader, mission.id, "effect:")).toEqual([]); }
        finally { reader.close(); }
        const current = next.inspectMission(mission.id);
        next.appendTransition(mission.id, current.version, { events: [{ revision: current.revision,
          kind: "effect.invoking", effectId, causalId: randomUUID(), payload: { effectId, operation: "write" } }] });
        expect(causeBlockers(next, mission.id, "effect:")).toEqual([`effect:${effectId}`]);
        const contrary = await reconcileMission({ store: next, missionId: mission.id, sourceRoot: sample.root,
          planFile: sample.planFile, trigger: "contrary" });
        expect(contrary.effects.map((item) => item.disposition)).toEqual(["unknown"]);
      }
    } finally { next.close(); }
  }
});

test("writer receipt only closes activity before it, never claims between receipt and settlement or after", async () => {
  const result = Buffer.from("opaque worker result");
  const resultHash = sha256(result);
  for (const [kind, position, expected] of [
    ["effect.intent", "before", false], ["effect.invoking", "between", true],
    ["effect.reconciled", "after", true], ["effect.invoking", "after-settlement", true],
    ["dispatch.observed", "after", true],
  ] as const) {
    const { store, mission } = await fixture();
    try {
      const attemptId = randomUUID(), effectId = randomUUID();
      const binding = { attemptId, missionId: mission.id, revision: 1, unitId: "snapshot" };
      const rows: Array<{ kind: string; attemptId: string; unitId: string; effectId?: string; payload: Record<string, unknown> }> = [
        { kind: "attempt.reserved", attemptId, unitId: "snapshot", payload: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo", binding } },
        { kind: "attempt.started", attemptId, unitId: "snapshot", payload: { attemptId, unitId: "snapshot" } },
        { kind: "attempt.receipt", attemptId, unitId: "snapshot",
          payload: { attemptId, unitId: "snapshot", status: "completed", artifactHash: resultHash, resultHash } },
        { kind: "attempt.settled", attemptId, unitId: "snapshot", payload: { attemptId, status: "succeeded", resultHash } },
      ];
      const claim = { kind, attemptId, unitId: "snapshot", effectId,
        payload: kind === "effect.reconciled" ? { effectId, disposition: "applied" } :
          kind === "dispatch.observed" ? { attemptId, queueWaitMs: 1 } : { effectId, operation: "write" } };
      rows.splice({ before: 2, between: 3, after: 3, "after-settlement": 4 }[position], 0, claim);
      const current = store.inspectMission(mission.id);
      store.appendTransition(mission.id, current.version, { events: rows.map((row) => ({
        ...row, revision: 1, causalId: randomUUID(),
      })), artifacts: [{ bytes: result, mediaType: "text/plain" }] });
      expect(causeBlockers(store, mission.id, "writer:")).toEqual(expected ? [`writer:${attemptId}`] : []);
    } finally { store.close(); }
  }
  for (const field of ["receipt", "settlement"] as const) {
    const { store, mission } = await fixture();
    try {
      const attemptId = randomUUID();
      const binding = { attemptId, missionId: mission.id, revision: 1, unitId: "snapshot" };
      const rows = [
        { kind: "attempt.reserved", payload: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo", binding } },
        { kind: "attempt.started", payload: { attemptId, unitId: "snapshot" } },
        { kind: "attempt.receipt", payload: { attemptId, unitId: "snapshot", status: "completed", artifactHash: resultHash,
          resultHash, ...(field === "receipt" ? { recoveryDisposition: "interrupted-without-worker-result" } : {}) } },
        { kind: "attempt.settled", payload: { attemptId, status: "succeeded", resultHash,
          ...(field === "settlement" ? { recoveryDisposition: "interrupted-without-worker-result" } : {}) } },
      ];
      const current = store.inspectMission(mission.id);
      store.appendTransition(mission.id, current.version, { events: rows.map((row) => ({
        ...row, attemptId, unitId: "snapshot", revision: 1, causalId: randomUUID(),
      })), artifacts: [{ bytes: result, mediaType: "text/plain" }] });
      expect(causeBlockers(store, mission.id, "writer:")).toEqual([`writer:${attemptId}`]);
    } finally { store.close(); }
  }
});

test("snapshot phase binds source attempt; unbound non-base observations retain both categories", async () => {
  for (const phase of ["base", "effect", "observed", "recovered"]) for (const bound of [false, true]) {
    const { sample, store, mission, add } = await fixture();
    try {
      const id = randomUUID();
      add({ kind: "workspace.snapshot.sealed", ...(bound ? { attemptId: id } : {}),
        ...(bound && phase === "effect" ? { effectId: id } : {}),
        payload: { phase, imageHash: "a".repeat(64), manifestHash: "b".repeat(64),
          ...(bound ? { attemptId: id } : {}),
          ...(bound && phase === "effect" ? { effectId: id } : {}) } });
      const expectedEffect = phase === "base" ? [] :
        phase === "effect" ? [bound ? `effect:${id}` : "effect:unbound"] : bound ? [] : ["effect:unbound"];
      const expectedWriter = phase === "base" ? [] : [bound ? `writer:${id}` : "writer:unbound"];
      expect(causeBlockers(store, mission.id, "effect:")).toEqual(expectedEffect);
      expect(causeBlockers(store, mission.id, "writer:")).toEqual(expectedWriter);
      const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
      try {
        expect(causeBlockers(reader, mission.id, "effect:")).toEqual(expectedEffect);
        expect(causeBlockers(reader, mission.id, "writer:")).toEqual(expectedWriter);
      } finally { reader.close(); }
    } finally { store.close(); }
  }
  const { store, mission, add } = await fixture();
  try {
    const source = randomUUID();
    add({ kind: "workspace.snapshot.sealed", payload: {
      phase: "observed", attemptId: source, imageHash: "a".repeat(64) } });
    expect(causeBlockers(store, mission.id, "effect:")).toContain("effect:unbound");
    expect(causeBlockers(store, mission.id, "writer:")).toEqual(expect.arrayContaining([
      "writer:unbound", `writer:${source}`,
    ]));
  } finally { store.close(); }
  const base = await fixture();
  try {
    const source = randomUUID();
    base.add({ kind: "workspace.snapshot.sealed", payload: {
      phase: "base", attemptId: source, imageHash: "a".repeat(64) } });
    expect(causeBlockers(base.store, base.mission.id, "writer:")).toEqual(expect.arrayContaining([
      "writer:unbound", `writer:${source}`,
    ]));
  } finally { base.store.close(); }
});

test("hash-checked report unstarted cannot hide typed result, process, probe or extra fields", async () => {
  for (const extra of [{}, { result: { status: "completed" } }, { process: { pid: 7 } },
    { probe: { disposition: "applied" } }, { futureOutcome: "applied" }, { reason: 7 },
    { operation: "different-operation" }]) {
    const { store, mission, add } = await fixture();
    try {
      const effectId = randomUUID();
      add({ kind: "effect.intent", effectId, payload: { effectId, operation: "write" } },
        { kind: "effect.reconciled", effectId, payload: { effectId, disposition: "unstarted" } });
      const report = { format: "mission-recovery-report-v2", missionId: mission.id, revision: 1, episodeId: randomUUID(),
        effects: [{ effectId, attemptId: null, operation: "write", disposition: "unstarted", ...extra }] };
      const bytes = Buffer.from(JSON.stringify(report));
      const current = store.inspectMission(mission.id);
      store.appendTransition(mission.id, current.version, { events: [{ revision: 1, kind: "mission.recovery.recorded",
        causalId: randomUUID(), payload: { episodeId: report.episodeId, reportHash: sha256(bytes), status: "resumed" } }],
      artifacts: [{ bytes, mediaType: "application/json" }] });
      expect(causeBlockers(store, mission.id, "effect:")).toEqual(Object.keys(extra).length ? [`effect:${effectId}`] : []);
    } finally { store.close(); }
  }
});

test("report outcome claim after a stored worker receipt reopens writer independently of effect", async () => {
  const { sample, store, mission } = await fixture();
  try {
    const attemptId = randomUUID(), effectId = randomUUID();
    const result = Buffer.from("opaque worker result");
    const resultHash = sha256(result);
    const binding = { attemptId, missionId: mission.id, revision: 1, unitId: "snapshot" };
    const current = store.inspectMission(mission.id);
    store.appendTransition(mission.id, current.version, { events: [
      { revision: 1, kind: "attempt.reserved", causalId: randomUUID(), attemptId, unitId: "snapshot",
        payload: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo", binding } },
      { revision: 1, kind: "attempt.started", causalId: randomUUID(), attemptId, unitId: "snapshot",
        payload: { attemptId, unitId: "snapshot" } },
      { revision: 1, kind: "attempt.receipt", causalId: randomUUID(), attemptId, unitId: "snapshot",
        payload: { attemptId, unitId: "snapshot", status: "completed", artifactHash: resultHash, resultHash } },
      { revision: 1, kind: "attempt.settled", causalId: randomUUID(), attemptId, unitId: "snapshot",
        payload: { attemptId, status: "succeeded", resultHash } },
    ], artifacts: [{ bytes: result, mediaType: "text/plain" }] });
    expect(causeBlockers(store, mission.id, "writer:")).toEqual([]);
    const report = { format: "mission-recovery-report-v2", missionId: mission.id, revision: 1, episodeId: "claim",
      effects: [{ effectId, attemptId, operation: "write", disposition: "unstarted", result: { status: "completed" } }] };
    const bytes = Buffer.from(JSON.stringify(report));
    const before = store.inspectMission(mission.id);
    store.appendTransition(mission.id, before.version, { events: [{ revision: 1, kind: "mission.recovery.recorded",
      causalId: randomUUID(), payload: { episodeId: report.episodeId, reportHash: sha256(bytes), status: "resumed" } }],
    artifacts: [{ bytes, mediaType: "application/json" }] });
    expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
    expect(causeBlockers(store, mission.id, "writer:")).toContain(`writer:${attemptId}`);
    const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try { expect(causeBlockers(reader, mission.id, "writer:")).toContain(`writer:${attemptId}`); }
    finally { reader.close(); }
  } finally { store.close(); }
});

test("direct, batch and SQL-replayed completion retain independent effect and writer categories", async () => {
  const { sample, store, mission } = await fixture();
  const attemptId = randomUUID(), effectId = randomUUID();
  const result = Buffer.from("opaque worker result");
  const resultHash = sha256(result);
  const binding = { attemptId, missionId: mission.id, revision: 1, unitId: "snapshot" };
  const current = store.inspectMission(mission.id);
  store.appendTransition(mission.id, current.version, { events: [
    { revision: 1, kind: "attempt.reserved", causalId: randomUUID(), attemptId, unitId: "snapshot",
      payload: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo", binding } },
    { revision: 1, kind: "attempt.started", causalId: randomUUID(), attemptId, unitId: "snapshot",
      payload: { attemptId, unitId: "snapshot" } },
    { revision: 1, kind: "attempt.receipt", causalId: randomUUID(), attemptId, unitId: "snapshot",
      payload: { attemptId, unitId: "snapshot", status: "completed", artifactHash: resultHash, resultHash } },
    { revision: 1, kind: "attempt.settled", causalId: randomUUID(), attemptId, unitId: "snapshot",
      payload: { attemptId, status: "succeeded", resultHash } },
    { revision: 1, kind: "effect.invoking", causalId: randomUUID(), attemptId, effectId,
      payload: { effectId, attemptId, operation: "write" } },
    { revision: 1, kind: "workspace.snapshot.sealed", causalId: randomUUID(),
      payload: { phase: "observed", imageHash: "a".repeat(64) } },
  ], artifacts: [{ bytes: result, mediaType: "text/plain" }] });
  const categories = [`effect:${effectId}`, "effect:unbound", `writer:${attemptId}`, "writer:unbound"];
  const assertCategories = (reader: typeof store) => {
    const inspected = reader.inspectMission(mission.id);
    expect(missionCompletionBlockers(inspected, reader)).toEqual(expect.arrayContaining(categories));
    expect(missionCompletionCertificate(inspected, reader)).toBeUndefined();
  };
  assertCategories(store);
  const before = store.inspectMission(mission.id);
  const completion = { revision: before.revision, kind: "mission.completed", causalId: randomUUID(), payload: {} };
  expect(() => store.appendTransition(mission.id, before.version, { events: [completion] }))
    .toThrow(/effect:.*writer:/);
  expect(() => store.appendTransition(mission.id, before.version, { events: [
    { revision: before.revision, kind: "mission.activated", causalId: randomUUID(), payload: {} }, completion,
  ] })).toThrow(/effect:.*writer:/);
  expect(store.inspectMission(mission.id).latestSeq).toBe(before.latestSeq);
  const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
  try { assertCategories(reader); }
  finally { reader.close(); }
  store.appendTransition(mission.id, before.version, { events: [{ revision: before.revision,
    kind: "mission.owner.released", causalId: randomUUID(), payload: {
      owner: currentProcessIdentity(store.runtimeId, store.ownerEpoch!), effectsQuiescent: true,
      resumablePause: false, interruptedAttempts: [],
    } }] });
  const released = store.inspectMission(mission.id);
  store.close();
  const db = await openSqlite(sample.dbPath);
  try {
    db.prepare(`INSERT INTO mission_events (event_id, mission_id, revision, seq, schema_version, kind, causal_id,
      occurred_at, runtime_id, monotonic_duration_ms, unit_id, attempt_id, effect_id, team_round_id, reason, provenance_json, payload_json)
      SELECT ?, mission_id, revision, ?, schema_version, 'mission.completed', ?, occurred_at, runtime_id,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}' FROM mission_events WHERE mission_id = ? AND seq = 1`)
      .run(randomUUID(), released.latestSeq + 1, completion.causalId, mission.id);
    db.prepare("UPDATE missions SET state = 'completed', version = version + 1, latest_seq = ? WHERE mission_id = ?")
      .run(released.latestSeq + 1, mission.id);
  } finally { db.close(); }
  const reopened = await openFixtureStore(sample);
  try {
    assertCategories(reopened);
    const replay = reopened.inspectMission(mission.id);
    expect(() => reopened.appendTransition(mission.id, replay.version, { events: [completion] }))
      .toThrow(/effect:.*writer:/);
  } finally { reopened.close(); }
});

test("later owner, report and revision cannot retire an earlier effect claim", async () => {
  const { sample, store, mission, add } = await fixture();
  try {
    const effectId = randomUUID(), attemptId = randomUUID();
    add({ kind: "effect.intent", effectId, payload: { effectId, operation: "write" } },
      { kind: "effect.reconciled", effectId, payload: { effectId, disposition: "unstarted",
        probe: { proofKind: "host-external-probe-v1", disposition: "applied" } } });
    const report = { format: "mission-recovery-report-v2", missionId: mission.id, revision: 1, episodeId: "claim",
      effects: [{ effectId, attemptId, operation: "write", disposition: "applied" }] };
    const bytes = Buffer.from(JSON.stringify(report));
    const current = store.inspectMission(mission.id);
    store.appendTransition(mission.id, current.version, { events: [{ revision: 1,
      kind: "mission.recovery.recorded", causalId: randomUUID(), payload: {
        episodeId: "claim", reportHash: sha256(bytes), status: "resumed" } }], artifacts: [
      { bytes, mediaType: "application/json" },
    ] });
    add({ kind: "mission.owner.released", payload: { effectsQuiescent: true, interruptedAttempts: [] } });
    const before = store.inspectMission(mission.id);
    const changed = structuredClone(before.definition);
    changed.goal = "Prove older effect claims remain visible";
    admitMissionChange({ store, missionId: mission.id, expectedVersion: before.version, actor: "operator",
      receipt: operatorChangeReceipt(store, before, changed), planBytes: nextPlanBytes(before.planBytes),
      definitionBytes: Buffer.from(JSON.stringify(changed)) });
    add({ kind: "effect.reconciled", effectId, payload: { effectId, disposition: "unstarted" } });
    const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try {
      expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
      expect(causeBlockers(reader, mission.id, "effect:")).toContain(`effect:${effectId}`);
    } finally { reader.close(); }
  } finally { store.close(); }
});

test("cross-event attempt identity conflicts block both named attempts and their effect", async () => {
  const { store, mission, add } = await fixture();
  try {
    const effectId = randomUUID(), source = randomUUID(), other = randomUUID();
    add({ kind: "effect.intent", effectId, attemptId: source, payload: {
      effectId, attemptId: other, operation: "write" } },
      { kind: "effect.reconciled", effectId, attemptId: source, payload: { effectId, disposition: "unstarted" } });
    const blockers = missionCompletionBlockers(store.inspectMission(mission.id), store);
    expect(blockers).toContain(`effect:${effectId}`);
    expect(blockers).toContain(`writer:${source}`);
    expect(blockers).toContain(`writer:${other}`);
  } finally { store.close(); }
});

test("recovery diagnosis attempt and its read-only source keep distinct roles", async () => {
  const { store, mission, add } = await fixture();
  try {
    const diagnosisId = randomUUID(), source = randomUUID();
    add({ kind: "mission.recovery.diagnosed", attemptId: diagnosisId, payload: {
      diagnosisId, attemptId: source, status: "started", admission: { attemptId: source } } });
    expect(causeBlockers(store, mission.id, "writer:")).toEqual([]);
  } finally { store.close(); }
});

test("hash-checked report observations cannot waive no-effect grammar", async () => {
  const { sample, store, mission, add } = await fixture();
  try {
    const effectId = randomUUID();
    add({ kind: "effect.intent", effectId, payload: { effectId, operation: "write" } },
      { kind: "effect.reconciled", effectId, payload: { effectId, disposition: "unstarted" } });
    const appendReport = (disposition: string, hash: string | null = null) => {
      const report = { format: "mission-recovery-report-v2", missionId: mission.id, revision: 1, episodeId: disposition,
        effects: [{ effectId, attemptId: null, operation: "write", disposition }] };
      const bytes = Buffer.from(JSON.stringify(report));
      const current = store.inspectMission(mission.id);
      store.appendTransition(mission.id, current.version, { events: [{ revision: 1, kind: "mission.recovery.recorded",
        causalId: randomUUID(), payload: { episodeId: disposition, reportHash: hash ?? sha256(bytes), status: "resumed" } }],
      artifacts: hash ? [] : [{ bytes, mediaType: "application/json" }] });
    };
    appendReport("unstarted");
    expect(causeBlockers(store, mission.id, "effect:")).toEqual([]);
    appendReport("applied");
    expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
    appendReport("missing", "a".repeat(64));
    const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try {
      expect(causeBlockers(reader, mission.id, "effect:")).toEqual(expect.arrayContaining([
        `effect:${effectId}`, "effect:unbound",
      ]));
    } finally { reader.close(); }
  } finally { store.close(); }
});

test("only exact imported hold with stored positive proof is reconciled", async () => {
  const { store, mission, add } = await fixture();
  try {
    const hold = { holdId: "h1", unitId: "snapshot", disposition: "unresolved" };
    add({ kind: "mission.hold.reconciled", payload: { holdId: "h1", importKey: "a", disposition: "unknown" } });
    add({ kind: "mission.imported", payload: { importKey: "a", holdsKnown: true, holds: [hold] } });
    expect(causeBlockers(store, mission.id, "hold:")).toContain("hold:h1");
    add({ kind: "mission.hold.reconciled", payload: { holdId: "h1", importKey: "other", disposition: "reconciled_without_outcome", proofHash: "ab".repeat(32) } });
    expect(causeBlockers(store, mission.id, "hold:")).toContain("hold:h1");
    const proofBytes = Buffer.from(JSON.stringify({ format: "legacy-hold-proof-v1", holdId: "h1", quiescent: true,
      artifacts: [{ path: "worker.txt", hash: sha256(Buffer.from("stopped")), bytesBase64: Buffer.from("stopped").toString("base64") }] }));
    const current = store.inspectMission(mission.id);
    store.recordLegacyHoldReconciled(mission.id, current.version, { importKey: "a", holdId: "h1", proofBytes, proofHash: sha256(proofBytes) });
    expect(causeBlockers(store, mission.id, "hold:")).toEqual([]);
    add({ kind: "mission.imported", payload: { importKey: "b", holdsKnown: true, holds: [hold] } });
    expect(causeBlockers(store, mission.id, "hold:")).toContain("hold:h1");
  } finally { store.close(); }
});

test("receipt without stored effect plan is not effect proof", async () => {
  const { store, mission, add } = await fixture();
  try {
    const effectId = randomUUID();
    const process = { hostId: "host", bootId: "boot", pid: 1, birthTicks: 2, containedPid: 3,
      pidNamespace: "pidns", networkNamespace: "netns", runtimeId: "runtime", epoch: 1,
      descendantsQuiescent: true, namespaceEmptyAfterExit: true };
    add({ kind: "effect.intent", effectId, payload: { effectId, owner: process } },
      { kind: "effect.process.registered", effectId, payload: { identity: process } },
      { kind: "effect.released", effectId, payload: { processIdentity: process } },
      { kind: "effect.receipt", effectId, payload: { status: "completed", paths: [], process } });
    expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
  } finally { store.close(); }
});

test("external labels never waive the stored plan for receipt-based settlement", async () => {
  for (const label of [{ operation: "external:charge" }, { operation: "bash", recovery: "external-probe-required" }]) {
    const { store, mission, add } = await fixture();
    try {
      const effectId = randomUUID();
      const process = { hostId: "host", bootId: "boot", pid: 1, birthTicks: 2, containedPid: 3,
        pidNamespace: "pidns", networkNamespace: "netns", runtimeId: "runtime", epoch: 1,
        descendantsQuiescent: true, namespaceEmptyAfterExit: true };
      add({ kind: "effect.intent", effectId, payload: { effectId, owner: process, ...label } },
        { kind: "effect.process.registered", effectId, payload: { identity: process } },
        { kind: "effect.released", effectId, payload: { processIdentity: process } },
        { kind: "effect.receipt", effectId, payload: { status: "completed", paths: [], process } });
      expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
    } finally { store.close(); }
  }
});

test("denial only proves a coherent prelaunch no-effect exit", async () => {
  const process = { hostId: "host", bootId: "boot", pid: 1, birthTicks: 2, containedPid: 3,
    pidNamespace: "pidns", networkNamespace: "netns", runtimeId: "runtime", epoch: 1,
    descendantsQuiescent: true, namespaceEmptyAfterExit: true };
  const cases = [
    { rows: [{ kind: "effect.denied" }], resolved: true },
    { rows: [{ kind: "effect.intent" }, { kind: "effect.reconciled", payload: { disposition: "unstarted" } }], resolved: true },
    { rows: [{ kind: "effect.invoking" }, { kind: "effect.denied" }], resolved: false },
    { rows: [{ kind: "effect.intent" }, { kind: "effect.invoking" }, { kind: "effect.denied" },
      { kind: "effect.receipt", payload: { status: "denied", process: null, paths: [] } }], resolved: true },
    { rows: [{ kind: "effect.denied" }, { kind: "effect.receipt", payload: { status: "completed", process, paths: [] } }], resolved: false },
    { rows: [{ kind: "effect.intent" }, { kind: "effect.denied" }, { kind: "effect.receipt", payload: { status: "failed", process: null, paths: [] } }], resolved: false },
    { rows: [{ kind: "effect.intent" }, { kind: "effect.denied" }, { kind: "effect.receipt", payload: { status: "denied", process, paths: [] } }], resolved: false },
    { rows: [{ kind: "effect.intent" }, { kind: "effect.denied" }, { kind: "effect.process.registered", payload: { identity: process } }], resolved: false },
    { rows: [{ kind: "effect.intent" }, { kind: "effect.denied" }, { kind: "effect.unknown" }], resolved: false },
    { rows: [{ kind: "effect.intent" }, { kind: "effect.denied" }, { kind: "effect.invoking" }], resolved: false },
    { rows: [{ kind: "effect.intent" }, { kind: "effect.denied" }, { kind: "effect.reconciled", payload: { disposition: "applied" } }], resolved: false },
    { rows: [{ kind: "effect.intent" }, { kind: "effect.denied" }, { kind: "effect.receipt", payload: { status: "completed", process, paths: [] } },
      { kind: "effect.reconciled", payload: { disposition: "unstarted" } }], resolved: false },
    { rows: [{ kind: "effect.intent", payload: { owner: process, operation: "external:charge" } },
      { kind: "effect.process.registered", payload: { identity: process } },
      { kind: "effect.released", payload: { processIdentity: process } },
      { kind: "effect.receipt", payload: { status: "completed", process, paths: [] } },
      { kind: "effect.reconciled", payload: { disposition: "unstarted" } }], resolved: false },
    { rows: [{ kind: "effect.intent" }, { kind: "effect.reconciled", payload: { disposition: "unstarted" } },
      { kind: "effect.released", payload: { processIdentity: process } }], resolved: false },
  ] as const;
  for (const [index, { rows, resolved }] of cases.entries()) {
    const { store, mission, add } = await fixture();
    try {
      const effectId = randomUUID();
      add(...rows.map((row) => ({ kind: row.kind, effectId, payload: "payload" in row ? row.payload : {} })));
      const blocked = causeBlockers(store, mission.id, "effect:").includes(`effect:${effectId}`);
      if (blocked !== !resolved) throw new Error(`denial case ${index}: expected blocked ${!resolved}, got ${blocked}`);
    } finally { store.close(); }
  }
});

test("self-hashed external probe is not independent host provenance for completion", async () => {
  const { store, mission, add } = await fixture();
  try {
    const effectId = randomUUID();
    const binding = { effectId, operation: "external:charge", grantId: "payments:charge", target: "account:1",
      operationKey: "op-1", requestHash: "a".repeat(64), adapterId: "payments-probe", adapterVersion: "1" };
    const evidence = { serviceReceipt: "forged" };
    add({ kind: "effect.intent", effectId, payload: { ...binding, recovery: "external-probe-required" } },
      { kind: "effect.reconciled", effectId, payload: { effectId, disposition: "applied", proofKind: "host-external-probe-v1",
        probe: { proofKind: "host-external-probe-v1", ...binding, disposition: "applied", evidence,
          evidenceHash: sha256(Buffer.from(JSON.stringify(evidence))) } } });
    expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
  } finally { store.close(); }
});

test("later unstarted cannot clear an earlier contradictory effect outcome on writer or reader", async () => {
  for (const prior of [
    { disposition: "applied", reason: "unsupported claim" },
    { disposition: "applied", probe: { proofKind: "host-external-probe-v1" } },
    { disposition: "applied", probe: { proofKind: "candidate-after-image-v1" } },
  ]) {
    const { sample, store, mission, add, complete } = await fixture();
    try {
      const effectId = randomUUID();
      const binding = { effectId, operation: "external:charge", grantId: "payments:charge", target: "account:1",
        operationKey: "op-1", requestHash: "a".repeat(64), adapterId: "payments-probe", adapterVersion: "1" };
      const evidence = { serviceReceipt: "forged" };
      const claim = prior.probe?.proofKind === "host-external-probe-v1" ? {
        disposition: "applied", probe: { proofKind: "host-external-probe-v1", ...binding, disposition: "applied",
          evidence, evidenceHash: sha256(Buffer.from(JSON.stringify(evidence))) },
      } : prior;
      add({ kind: "effect.intent", effectId, payload: { ...binding, recovery: "external-probe-required" } },
        { kind: "effect.reconciled", effectId, payload: claim });
      expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
      add({ kind: "effect.reconciled", effectId, payload: { disposition: "unstarted" } });
      expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
      expect(() => complete()).toThrow(/effect:/);
      const before = store.inspectMission(mission.id);
      expect(() => store.appendTransition(mission.id, before.version, { events: [
        { revision: before.revision, kind: "mission.activated", causalId: randomUUID(), payload: {} },
        { revision: before.revision, kind: "mission.completed", causalId: randomUUID(), payload: {} },
      ] })).toThrow(/effect:/);
      expect(store.inspectMission(mission.id).latestSeq).toBe(before.latestSeq);
      const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
      try { expect(causeBlockers(reader, mission.id, "effect:")).toContain(`effect:${effectId}`); }
      finally { reader.close(); }
    } finally { store.close(); }
  }
});

test("replayed completion retains contradictory effect outcome blocker", async () => {
  const { sample, store, mission, add } = await fixture();
  const effectId = randomUUID();
  const binding = { effectId, operation: "external:charge", grantId: "payments:charge", target: "account:1",
    operationKey: "op-1", requestHash: "a".repeat(64), adapterId: "payments-probe", adapterVersion: "1" };
  const evidence = { serviceReceipt: "forged" };
  add({ kind: "effect.intent", effectId, payload: { ...binding, recovery: "external-probe-required" } },
    { kind: "effect.reconciled", effectId, payload: { disposition: "applied",
      probe: { proofKind: "host-external-probe-v1", ...binding, disposition: "applied", evidence,
        evidenceHash: sha256(Buffer.from(JSON.stringify(evidence))) } } },
    { kind: "effect.reconciled", effectId, payload: { disposition: "unstarted" } });
  add({ kind: "mission.owner.released", payload: { owner: currentProcessIdentity(store.runtimeId, store.ownerEpoch!),
    effectsQuiescent: true, resumablePause: false, interruptedAttempts: [] } });
  const before = store.inspectMission(mission.id);
  store.close();
  const db = await openSqlite(sample.dbPath);
  try {
    const causalId = randomUUID();
    db.prepare(`INSERT INTO mission_events (event_id, mission_id, revision, seq, schema_version, kind, causal_id,
      occurred_at, runtime_id, monotonic_duration_ms, unit_id, attempt_id, effect_id, team_round_id, reason, provenance_json, payload_json)
      SELECT ?, mission_id, revision, ?, schema_version, 'mission.completed', ?, occurred_at, runtime_id,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}' FROM mission_events WHERE mission_id = ? AND seq = 1`)
      .run(randomUUID(), before.latestSeq + 1, causalId, mission.id);
    db.prepare("UPDATE missions SET state = 'completed', version = version + 1, latest_seq = ? WHERE mission_id = ?")
      .run(before.latestSeq + 1, mission.id);
  } finally { db.close(); }
  const reopened = await openFixtureStore(sample);
  try {
    const inspection = reopened.inspectMission(mission.id);
    expect(causeBlockers(reopened, mission.id, "effect:")).toContain(`effect:${effectId}`);
    expect(missionCompletionCertificate(inspection, reopened)).toBeUndefined();
    expect(() => reopened.appendTransition(mission.id, inspection.version, { events: [
      { revision: inspection.revision, kind: "mission.completed", causalId: inspection.events.at(-1)!.causalId, payload: {} },
    ] })).toThrow(/effect:/);
    expect(reopened.inspectMission(mission.id).version).toBe(inspection.version);
    const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try { expect(causeBlockers(reader, mission.id, "effect:")).toContain(`effect:${effectId}`); }
    finally { reader.close(); }
  } finally { reopened.close(); }
});

test("host reconciliation does not classify a prior bare outcome claim as never invoked", async () => {
  const { sample, store, mission, add } = await fixture();
  try {
    const effectId = randomUUID();
    add({ kind: "effect.intent", effectId, payload: { effectId, operation: "write" } },
      { kind: "effect.reconciled", effectId, payload: { disposition: "applied", reason: "unsupported claim" } });
    const report = await reconcileMission({ store, missionId: mission.id, sourceRoot: sample.root,
      planFile: sample.planFile, trigger: "contradictory-effect" });
    expect(report.effects.find((effect) => effect.effectId === effectId)?.disposition).toBe("unknown");
    expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
    expect(store.inspectMission(mission.id).events.filter((event) => event.effectId === effectId &&
      event.kind === "effect.reconciled").map((event) => event.payload.disposition)).toEqual(["applied"]);
  } finally { store.close(); }
});

test("host cannot infer unstarted from a stored effect-phase image", async () => {
  const { sample, store, mission, add, complete } = await fixture();
  try {
    const effectId = randomUUID(), attemptId = randomUUID();
    const image = filterWorkspaceImage(captureWorkspaceImage(sample.root), [path.relative(sample.root, sample.planFile)]);
    const sealed = sealWorkspaceImage(image);
    const current = store.inspectMission(mission.id);
    store.appendTransition(mission.id, current.version, { events: [
      { revision: 1, kind: "effect.intent", causalId: randomUUID(), effectId, attemptId,
        payload: { effectId, attemptId, operation: "write" } },
      { revision: 1, kind: "workspace.snapshot.sealed", causalId: randomUUID(), effectId, attemptId,
        payload: { effectId, attemptId, phase: "effect", imageHash: sealed.imageHash,
          manifestHash: image.manifest.hash } },
    ], artifacts: sealed.artifacts });
    const observed = await reconcileMission({ store, missionId: mission.id, sourceRoot: sample.root,
      planFile: sample.planFile, trigger: "sealed-image-regression" });
    expect(observed.effects.find((item) => item.effectId === effectId)?.disposition).toBe("unknown");
    expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
    expect(() => complete()).toThrow(/effect:/);
    const before = store.inspectMission(mission.id);
    expect(() => store.appendTransition(mission.id, before.version, { events: [
      { revision: before.revision, kind: "mission.activated", causalId: randomUUID(), payload: {} },
      { revision: before.revision, kind: "mission.completed", causalId: randomUUID(), payload: {} },
    ] })).toThrow(/effect:/);
    const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try { expect(causeBlockers(reader, mission.id, "effect:")).toContain(`effect:${effectId}`); }
    finally { reader.close(); }
  } finally { store.close(); }
});

test("candidate after-image claim stays completion-blocked even with a stored sealed image until guarded host proof", async () => {
  const { sample, store, mission, add } = await fixture();
  try {
    const effectId = randomUUID();
    const attemptId = randomUUID();
    const process = { hostId: "host", bootId: "boot", pid: 1, birthTicks: 2, containedPid: 3,
      pidNamespace: "pidns", networkNamespace: "netns", runtimeId: "runtime", epoch: 1,
      descendantsQuiescent: true, namespaceEmptyAfterExit: true };
    const request = { path: ".pitako/plans/durable-fixture.md", content: "changed" };
    const image = filterWorkspaceImage(captureWorkspaceImage(sample.root), [request.path]);
    const sealed = sealWorkspaceImage(image);
    const preconditions: unknown[] = [];
    const expectedAfter = image.files.map(({ path: name, kind, mode, bytes }) => ({
      path: name, kind, mode, hash: bytes ? sha256(bytes) : null,
    }));
    const candidate = { candidateId: `${mission.id}:${attemptId}`, root: "candidate", rootIdentity: "identity",
      gitDir: "git", gitIdentity: "git-identity", arenaRoot: "arena", arenaIdentity: "arena-identity" };
    const planBytes = Buffer.from(JSON.stringify({ format: "mission-effect-plan-v1", request,
      requestHash: sha256(Buffer.from(JSON.stringify(request))), preconditions, expectedAfter, expectedAfterFiles: [],
      beforeImageHash: sha256(Buffer.from(JSON.stringify(preconditions))), expectedAfterHash: sha256(Buffer.from(JSON.stringify(expectedAfter))),
      allowedPaths: [request.path], deterministic: true, candidate }));
    const intent = { effectId, missionId: mission.id, attemptId, effectPlanHash: sha256(planBytes),
      requestHash: sha256(Buffer.from(JSON.stringify(request))), owner: process, candidate: candidate.root,
      candidateId: candidate.candidateId, candidateIdentity: candidate.rootIdentity,
      candidateGitDir: candidate.gitDir, candidateGitIdentity: candidate.gitIdentity,
      candidateArenaRoot: candidate.arenaRoot, candidateArenaIdentity: candidate.arenaIdentity };
    const current = store.inspectMission(mission.id);
    store.appendTransition(mission.id, current.version, { events: [
      { revision: 1, kind: "effect.intent", causalId: randomUUID(), effectId, attemptId, payload: intent },
      { revision: 1, kind: "effect.process.registered", causalId: randomUUID(), effectId, attemptId, payload: { identity: process } },
      { revision: 1, kind: "effect.released", causalId: randomUUID(), effectId, attemptId, payload: { processIdentity: process } },
      { revision: 1, kind: "effect.reconciled", causalId: randomUUID(), effectId, attemptId, payload: {
        disposition: "applied", probe: { proofKind: "candidate-after-image-v1", effectPlanHash: intent.effectPlanHash,
          processIdentity: process, candidateId: candidate.candidateId, candidateIdentity: candidate.rootIdentity,
          candidateGitIdentity: candidate.gitIdentity, observedImageHash: sha256(Buffer.from(JSON.stringify(expectedAfter))),
          beforeImageHash: sha256(Buffer.from("[]")), expectedAfterHash: sha256(Buffer.from(JSON.stringify(expectedAfter))) },
      } },
    ], artifacts: [{ bytes: planBytes, mediaType: "application/json" }] });
    expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
    const before = store.inspectMission(mission.id);
    store.appendTransition(mission.id, before.version, { events: [{ revision: before.revision,
      kind: "workspace.snapshot.sealed", causalId: randomUUID(), effectId, attemptId, payload: {
        effectId, attemptId, phase: "effect", imageHash: sealed.imageHash, manifestHash: image.manifest.hash,
        candidateIdentity: candidate.rootIdentity, candidateGitIdentity: candidate.gitIdentity,
      } }], artifacts: sealed.artifacts });
    expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
  } finally { store.close(); }
});

test("stored effect plan and worker result do not clear exposed effect completion ceiling", async () => {
  const { store, mission, add } = await fixture();
  try {
    const attemptId = randomUUID();
    const effectId = randomUUID();
    const process = { hostId: "host", bootId: "boot", pid: 1, birthTicks: 2, containedPid: 3,
      pidNamespace: "pidns", networkNamespace: "netns", runtimeId: "runtime", epoch: 1,
      descendantsQuiescent: true, namespaceEmptyAfterExit: true };
    const request = { command: "fixture" };
    const candidate = { candidateId: `${mission.id}:${attemptId}`, root: "candidate", rootIdentity: "identity",
      gitDir: "git", gitIdentity: "git-identity", arenaRoot: "arena", arenaIdentity: "arena-identity" };
    const planBytes = Buffer.from(JSON.stringify({ format: "mission-effect-plan-v1", request,
      requestHash: sha256(Buffer.from(JSON.stringify(request))), preconditions: [],
      beforeImageHash: sha256(Buffer.from("[]")), deterministic: false, candidate }));
    const result = Buffer.from("worker result");
    const current = store.inspectMission(mission.id);
    store.appendTransition(mission.id, current.version, { events: [
      { revision: 1, kind: "attempt.reserved", causalId: randomUUID(), attemptId, unitId: "snapshot", payload: {
        attemptId, unitId: "snapshot", roundId: "main", memberId: "solo",
        binding: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo", attemptNo: 1,
          missionId: mission.id, revision: 1, ownerEpoch: store.ownerEpoch, candidate: "candidate",
          inputManifestHash: "a".repeat(64), briefHash: "b".repeat(64), rolePolicyHash: "c".repeat(64) },
      } },
      { revision: 1, kind: "attempt.started", causalId: randomUUID(), attemptId, unitId: "snapshot", payload: { attemptId, unitId: "snapshot" } },
      { revision: 1, kind: "effect.intent", causalId: randomUUID(), effectId, attemptId, payload: {
        effectId, attemptId, missionId: mission.id, effectPlanHash: sha256(planBytes),
        requestHash: sha256(Buffer.from(JSON.stringify(request))), owner: process,
        candidate: candidate.root, candidateId: candidate.candidateId, candidateIdentity: candidate.rootIdentity,
        candidateGitDir: candidate.gitDir, candidateGitIdentity: candidate.gitIdentity,
        candidateArenaRoot: candidate.arenaRoot, candidateArenaIdentity: candidate.arenaIdentity,
      } },
      { revision: 1, kind: "effect.process.registered", causalId: randomUUID(), effectId, attemptId, payload: { identity: process } },
      { revision: 1, kind: "effect.released", causalId: randomUUID(), effectId, attemptId, payload: { processIdentity: process } },
      { revision: 1, kind: "effect.receipt", causalId: randomUUID(), effectId, attemptId, payload: { status: "completed", paths: [], process } },
      { revision: 1, kind: "attempt.receipt", causalId: randomUUID(), attemptId, unitId: "snapshot", payload: {
        attemptId, unitId: "snapshot", artifactHash: sha256(result), resultHash: sha256(result), status: "completed" } },
      { revision: 1, kind: "attempt.settled", causalId: randomUUID(), attemptId, unitId: "snapshot", payload: {
        attemptId, resultHash: sha256(result), status: "succeeded" } },
    ], artifacts: [{ bytes: planBytes, mediaType: "application/json" }, { bytes: result, mediaType: "text/plain" }] });
    expect(causeBlockers(store, mission.id, "effect:")).toContain(`effect:${effectId}`);
    expect(causeBlockers(store, mission.id, "writer:")).toEqual([]);
  } finally { store.close(); }
});

test("recovery requires classified prior block and persisted owner; settlement needs outcome", async () => {
  const { sample, store, mission, add } = await fixture();
  try {
    add({ kind: "mission.blocked", payload: { reason: "global cause remains" } });
    const seq = store.inspectMission(mission.id).latestSeq + 1;
    const report = { format: "mission-recovery-report-v2", missionId: mission.id, revision: 1, status: "resumed",
      disposition: { version: 2, revision: 1, ownerEpoch: store.ownerEpoch, observedSeq: seq, causes: [] } };
    const bytes = Buffer.from(JSON.stringify(report));
    const current = store.inspectMission(mission.id);
    store.appendTransition(mission.id, current.version, { events: [{ revision: 1, kind: "mission.recovery.recorded", causalId: randomUUID(), payload: { status: "resumed", reportHash: sha256(bytes) } }],
      artifacts: [{ bytes, mediaType: "application/json" }] });
    expect(causeBlockers(store, mission.id, "recovery:")).not.toEqual([]);
    const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try { expect(causeBlockers(reader, mission.id, "recovery:")).not.toEqual([]); }
    finally { reader.close(); }
    add({ kind: "mission.owner.released", payload: { effectsQuiescent: false } });
    expect(causeBlockers(store, mission.id, "recovery:")).not.toEqual([]);
    const attemptId = randomUUID();
    add({ kind: "attempt.reserved", attemptId, payload: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo",
      binding: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo", attemptNo: 1,
        missionId: mission.id, revision: 1, ownerEpoch: store.ownerEpoch, candidate: "test",
        inputManifestHash: "a".repeat(64), briefHash: "b".repeat(64), rolePolicyHash: "c".repeat(64) } } },
      { kind: "attempt.settled", attemptId, payload: { attemptId } });
    expect(causeBlockers(store, mission.id, "writer:")).toContain(`writer:${attemptId}`);
  } finally { store.close(); }
});

test("resumed report cannot clear nonquiescent owner release or receiptless writer", async () => {
  const { sample, store, mission, add } = await fixture();
  try {
    const attemptId = randomUUID();
    add({ kind: "mission.owner.released", payload: { owner: currentProcessIdentity(store.runtimeId, store.ownerEpoch!), effectsQuiescent: false } });
    const before = store.inspectMission(mission.id);
    const report = { format: "mission-recovery-report-v2", missionId: mission.id, episodeId: "interrupted", revision: before.revision,
      status: "resumed", owner: { epoch: store.ownerEpoch },
      disposition: { version: 2, revision: before.revision, ownerEpoch: store.ownerEpoch, observedSeq: before.latestSeq, causes: [] },
      plan: { status: "unchanged", storedHash: before.snapshot.planHash, observedHash: sha256(readFileSync(before.snapshot.sourcePath)) },
      source: { root: sample.root, manifest: captureWorkspaceImage(sample.root).manifest }, blockers: [] };
    const bytes = Buffer.from(JSON.stringify(report));
    store.appendTransition(mission.id, before.version, { events: [{ revision: before.revision, kind: "mission.recovery.recorded",
      causalId: randomUUID(), payload: { episodeId: report.episodeId, status: "resumed", reportHash: sha256(bytes) } }],
      artifacts: [{ bytes, mediaType: "application/json" }] });
    add({ kind: "attempt.reserved", attemptId, payload: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo",
      binding: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo", attemptNo: 1,
        missionId: mission.id, revision: 1, ownerEpoch: store.ownerEpoch, candidate: "c",
        inputManifestHash: "a".repeat(64), briefHash: "b".repeat(64), rolePolicyHash: "c".repeat(64) } } },
      { kind: "attempt.started", attemptId, payload: { attemptId } },
      { kind: "attempt.settled", attemptId, payload: { attemptId, recoveryDisposition: "interrupted-without-worker-result", episodeId: report.episodeId } });
    expect(causeBlockers(store, mission.id, "recovery:")).toContain("recovery:owner-not-quiescent");
    expect(causeBlockers(store, mission.id, "writer:")).toContain(`writer:${attemptId}`);
    const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try {
      expect(causeBlockers(reader, mission.id, "recovery:")).toContain("recovery:owner-not-quiescent");
      expect(causeBlockers(reader, mission.id, "writer:")).toContain(`writer:${attemptId}`);
    } finally { reader.close(); }
  } finally { store.close(); }
});

test("report-linked interrupted settlement without worker result retains writer blocker", async () => {
  const { sample, store, mission, add } = await fixture();
  try {
    const attemptId = randomUUID();
    const before = store.inspectMission(mission.id);
    const report = { format: "mission-recovery-report-v2", missionId: mission.id, episodeId: "interrupted", revision: before.revision,
      status: "resumed", owner: { epoch: store.ownerEpoch },
      disposition: { version: 2, revision: before.revision, ownerEpoch: store.ownerEpoch, observedSeq: before.latestSeq, causes: [] },
      plan: { status: "unchanged", storedHash: before.snapshot.planHash, observedHash: sha256(readFileSync(before.snapshot.sourcePath)) },
      source: { root: sample.root, manifest: captureWorkspaceImage(sample.root).manifest }, blockers: [] };
    const bytes = Buffer.from(JSON.stringify(report));
    store.appendTransition(mission.id, before.version, { events: [{ revision: before.revision, kind: "mission.recovery.recorded",
      causalId: randomUUID(), payload: { episodeId: report.episodeId, status: "resumed", reportHash: sha256(bytes) } }],
      artifacts: [{ bytes, mediaType: "application/json" }] });
    add({ kind: "attempt.reserved", attemptId, payload: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo",
      binding: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo", attemptNo: 1,
        missionId: mission.id, revision: 1, ownerEpoch: store.ownerEpoch, candidate: "c",
        inputManifestHash: "a".repeat(64), briefHash: "b".repeat(64), rolePolicyHash: "c".repeat(64) } } },
      { kind: "attempt.started", attemptId, payload: { attemptId } },
      { kind: "attempt.settled", attemptId, payload: { attemptId, recoveryDisposition: "interrupted-without-worker-result", episodeId: report.episodeId } });
    expect(causeBlockers(store, mission.id, "recovery:")).toEqual([]);
    expect(causeBlockers(store, mission.id, "writer:")).toContain(`writer:${attemptId}`);
  } finally { store.close(); }
});

test("a full-shaped resumed report cannot certify a historical generic block", async () => {
  const { sample, store, mission, add, complete } = await fixture();
  try {
    add({ kind: "mission.blocked", payload: { reason: "global cause remains" } });
    const blocked = store.inspectMission(mission.id);
    const report = { format: "mission-recovery-report-v2", missionId: mission.id, episodeId: "forged",
      revision: 1, status: "resumed",
      owner: { source: store.ownerAcquisitionProof?.source, epoch: store.ownerEpoch, previousEpoch: null },
      disposition: { version: 2, revision: 1, ownerEpoch: store.ownerEpoch, observedSeq: blocked.latestSeq, causes: [] },
      plan: { status: "unchanged", storedHash: blocked.snapshot.planHash, observedHash: sha256(sample.planBytes) },
      source: { root: sample.root, manifest: captureWorkspaceImage(sample.root).manifest }, blockers: [] };
    const bytes = Buffer.from(JSON.stringify(report));
    store.appendTransition(mission.id, blocked.version, { events: [{ revision: 1, kind: "mission.recovery.recorded",
      causalId: randomUUID(), payload: { episodeId: report.episodeId, status: "resumed", reportHash: sha256(bytes) } }],
      artifacts: [{ bytes, mediaType: "application/json" }] });
    const recovery = (inspection = store.inspectMission(mission.id)) =>
      missionCompletionBlockers(inspection, store).filter((item) => item.startsWith("recovery:"));
    expect(recovery()).toContain("recovery:unproven");
    const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try { expect(causeBlockers(reader, mission.id, "recovery:")).toContain("recovery:unproven"); }
    finally { reader.close(); }
    expect(() => complete()).toThrow(/recovery:unproven/);
    const before = store.inspectMission(mission.id);
    expect(() => store.appendTransition(mission.id, before.version, { events: [
      { revision: 1, kind: "mission.activated", causalId: randomUUID(), payload: {} },
      { revision: 1, kind: "mission.completed", causalId: randomUUID(), payload: {} },
    ] })).toThrow(/recovery:unproven/);
    expect(store.inspectMission(mission.id).latestSeq).toBe(before.latestSeq);
    const forged = { ...before, events: [...before.events, { ...before.events.at(-1)!, kind: "mission.completed", seq: before.latestSeq + 1 }] };
    expect(recovery(forged)).toContain("recovery:unproven");
    expect(missionCompletionCertificate(forged, store)).toBeUndefined();
    add({ kind: "mission.activated" }, { kind: "mission.resumed" });
    expect(recovery()).toContain("recovery:unproven");
  } finally { store.close(); }
});

test("later revision, owner and recovery report do not retire an earlier generic block", async () => {
  let { sample, store, mission } = await fixture();
  try {
    const append = (kind: string, payload: Record<string, unknown> = {}) => {
      const current = store.inspectMission(mission.id);
      store.appendTransition(mission.id, current.version, { events: [{ revision: current.revision, kind, causalId: randomUUID(), payload }] });
    };
    append("mission.blocked", { reason: "historical unknown" });
    const before = store.inspectMission(mission.id);
    const next = structuredClone(before.definition);
    next.goal = "Verify durable snapshots after revision";
    admitMissionChange({ store, missionId: mission.id, expectedVersion: before.version, actor: "operator",
      receipt: operatorChangeReceipt(store, before, next), planBytes: nextPlanBytes(before.planBytes),
      definitionBytes: Buffer.from(JSON.stringify(next)) });
    expect(causeBlockers(store, mission.id, "recovery:")).toContain("recovery:unproven");
    append("mission.owner.released", { owner: currentProcessIdentity(store.runtimeId, store.ownerEpoch!),
      reason: "fixture retirement", effectsQuiescent: true, resumablePause: true, interruptedAttempts: [] });
    store.close();
    store = await openFixtureStore(sample);
    const current = store.inspectMission(mission.id);
    const report = { format: "mission-recovery-report-v2", missionId: mission.id, episodeId: "new-owner",
      revision: current.revision, status: "resumed", owner: { epoch: store.ownerEpoch },
      disposition: { version: 2, revision: current.revision, ownerEpoch: store.ownerEpoch,
        observedSeq: current.latestSeq, causes: [] },
      plan: { status: "changed", storedHash: current.snapshot.planHash, observedHash: sha256(readFileSync(sample.planFile)) },
      source: { root: sample.root, manifest: captureWorkspaceImage(sample.root).manifest }, blockers: [] };
    const bytes = Buffer.from(JSON.stringify(report));
    store.appendTransition(mission.id, current.version, { events: [{ revision: current.revision,
      kind: "mission.recovery.recorded", causalId: randomUUID(), payload: {
        episodeId: report.episodeId, status: "resumed", reportHash: sha256(bytes) } }],
      artifacts: [{ bytes, mediaType: "application/json" }] });
    append("mission.activated");
    expect(causeBlockers(store, mission.id, "recovery:")).toContain("recovery:unproven");
    const reader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try { expect(causeBlockers(reader, mission.id, "recovery:")).toContain("recovery:unproven"); }
    finally { reader.close(); }
  } finally { store.close(); }
});

test("managed Board uses canonical repository root and fresh mission certification; ad hoc path unchanged", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const sample = createMissionFixture("mission-finalization-board-"); roots.push(sample.base);
  process.env.PI_CODING_AGENT_DIR = sample.stateDir;
  try {
    const workspace = repositoryIdentity(sample.root);
    const board = await openBoard();
    const topic = board.createTopic(workspace, { title: "Managed completion" });
    board.claimTopic(workspace, topic.id, "durable-fixture");
    board.close();
    writeFileSync(sample.planFile, `---\nid: durable-fixture\nrevision: 1\nstatus: frozen\nboard_topic_id: ${topic.id}\nexecution: expected\n---\n\nManaged fixture.\n`);
    const opened = openExecutionPlan("durable-fixture", sample.root);
    writeFileSync(opened.ledger, readFileSync(opened.ledger, "utf8").replace("status: running", "status: completed"));
    const store = await openFixtureStore(sample);
    const mission = store.createMission(missionInput(sample));
    const blocked = store.appendTransition(mission.id, mission.version, { events: [{ revision: 1, kind: "mission.blocked",
      causalId: randomUUID(), payload: { reason: "unknown historical cause" } }] });
    const beforeReport = store.inspectMission(mission.id);
    const forged = { format: "mission-recovery-report-v2", missionId: mission.id, episodeId: "board-forgery",
      revision: 1, status: "resumed", owner: { epoch: store.ownerEpoch },
      disposition: { version: 2, revision: 1, ownerEpoch: store.ownerEpoch, observedSeq: blocked[0]!.seq, causes: [] },
      plan: { status: "unchanged", storedHash: mission.snapshot.planHash, observedHash: sha256(readFileSync(sample.planFile)) },
      source: { root: sample.root, manifest: captureWorkspaceImage(sample.root).manifest }, blockers: [] };
    const reportBytes = Buffer.from(JSON.stringify(forged));
    store.appendTransition(mission.id, beforeReport.version, { events: [{ revision: 1, kind: "mission.recovery.recorded",
      causalId: randomUUID(), payload: { episodeId: forged.episodeId, status: "resumed", reportHash: sha256(reportBytes) } }],
      artifacts: [{ bytes: reportBytes, mediaType: "application/json" }] });
    const boardReader = await openMissionStore({ dbPath: sample.dbPath, objectDir: sample.objectDir, readOnly: true });
    try { expect(causeBlockers(boardReader, mission.id, "recovery:")).toContain("recovery:unproven"); }
    finally { boardReader.close(); }
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    registerBoard({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {} } as any);
    const invoke = (cwd: string, status: "closed" | "resolved") => tools.get("board_workflow_lifecycle")!.execute("call",
      { planId: mission.planId, status }, new AbortController().signal, undefined, { cwd, sessionManager: { getSessionId: () => "test" } });
    const rejected = await invoke(sample.root, "resolved");
    expect(rejected.content[0].text).toContain("no valid completion certificate");
    const alias = path.join(sample.base, "alias"); symlinkSync(sample.root, alias, "dir");
    expect((await invoke(alias, "resolved")).content[0].text).toContain("no valid completion certificate");
    const other = createMissionFixture("mission-finalization-adhoc-"); roots.push(other.base);
    expect((await invoke(other.root, "resolved")).details.noTopic).toBe(true);
    const pinned = await openBoard();
    pinned.claimTopicExecution(workspace, topic.id, mission.planId, { revision: mission.revision, hash: mission.snapshot.planHash, executionRoot: sample.root });
    pinned.close();
    expect((await invoke(sample.root, "closed")).isError).toBeFalsy();
    const after = await openBoard();
    expect(after.readTopic(workspace, topic.id).topic.status).toBe("closed"); after.close();
    store.close();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("direct and batched completion reject incomplete result atomically, including replayed completion", async () => {
  const { store, mission, add, complete } = await fixture();
  try {
    expect(() => complete()).toThrow(/completion blocked/);
    const before = store.inspectMission(mission.id);
    expect(() => store.appendTransition(mission.id, before.version, { events: [
      { revision: 1, kind: "mission.activated", causalId: randomUUID(), payload: {} },
      { revision: 1, kind: "mission.completed", causalId: randomUUID(), payload: {} },
    ] })).toThrow(/completion blocked/);
    expect(store.inspectMission(mission.id).latestSeq).toBe(before.latestSeq);
    add({ kind: "mission.activated" });
    const current = store.inspectMission(mission.id);
    const forged = { ...current, events: [...current.events, { ...current.events.at(-1)!, kind: "mission.completed", seq: current.latestSeq + 1 }] };
    expect(missionCompletionCertificate(forged, store)).toBeUndefined();
    // A pre-existing completion replay must not bypass a newly discovered blocker.
    expect(missionCompletionBlockers(current, store)).toContain("finalization:complete-result-contract-missing");
    expect(missionCompletionBlockers(current, store)).toContain("predicate:snapshot-present");
  } finally { store.close(); }
});

test("unresolved import shapes, raw conflict and effect exposure block certification", async () => {
  for (const payload of [
    { holdsKnown: false, holds: [] },
    { holdsKnown: true, holds: { holdId: "bad" } },
    { holdsKnown: true, holds: [{ unitId: "snapshot", disposition: "unresolved" }] },
    { holdsKnown: true, holds: [{ holdId: "hold", unitId: "snapshot", disposition: "unresolved" }] },
  ]) {
    const { store, mission, add, complete } = await fixture();
    try {
      add({ kind: "mission.imported", payload });
      expect(missionCompletionBlockers(store.inspectMission(mission.id), store).some((item) => item.startsWith("hold:"))).toBe(true);
      expect(() => complete()).toThrow(/completion blocked/);
    } finally { store.close(); }
  }
  const { store, mission, add, complete } = await fixture();
  try {
    const effectId = randomUUID();
    add({ kind: "effect.intent", effectId, payload: { effectId } }, { kind: "effect.invoking", effectId, payload: { effectId } },
      { kind: "effect.receipt", effectId, payload: { status: "completed" } },
      { kind: "effect.unknown", effectId, payload: { reason: "outcome unproven" } },
      { kind: "mission.import.conflict", payload: { reason: "raw conflict" } });
    const blockers = missionCompletionBlockers(store.inspectMission(mission.id), store);
    expect(blockers).toContain(`effect:${effectId}`);
    expect(blockers).toContain("recovery:import-conflict");
    expect(() => complete()).toThrow(/completion blocked/);
  } finally { store.close(); }
});

test("unproven recovery report and outstanding writer deny whole-mission completion", async () => {
  const { store, mission, add, complete } = await fixture();
  try {
    const attemptId = randomUUID();
    add({ kind: "attempt.reserved", attemptId, payload: { attemptId, unitId: "snapshot", roundId: "main", memberId: "solo",
      attemptNo: 1, binding: { missionId: mission.id, revision: 1, unitId: "snapshot", roundId: "main", memberId: "solo",
        attemptId, attemptNo: 1, ownerEpoch: store.ownerEpoch, candidate: "test", inputManifestHash: "a".repeat(64),
        briefHash: "b".repeat(64), rolePolicyHash: "c".repeat(64) } } },
      { kind: "mission.recovery.recorded", payload: { status: "resumed", reportHash: "0".repeat(64) } });
    const blockers = missionCompletionBlockers(store.inspectMission(mission.id), store);
    expect(blockers).toContain(`writer:${attemptId}`);
    expect(blockers).toContain("recovery:unproven");
    expect(() => complete()).toThrow(/completion blocked/);
  } finally { store.close(); }
});

test("deleted-target question remains a completion blocker with empty roots while independent work proceeds", async () => {
  const sample = createMissionFixture("mission-finalization-choice-"); roots.push(sample.base);
  const definition = missionDefinition();
  definition.units.push({ ...structuredClone(definition.units[0]!), id: "independent", acceptance: [{ id: "other-check", kind: "manual", target: "other" }] });
  definition.budget.roleLaunches = 8; definition.budget.providerRequests = 8;
  writeFileSync(sample.definitionFile, JSON.stringify(definition));
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const launches: string[] = [];
  const engine = new MissionEngine({ store, missionId: mission.id, sessionsDirectory: `${sample.base}/sessions`,
    runRole: async ({ unit }) => { launches.push(unit.id); return { instanceId: randomUUID(), role: "developer", status: "completed",
      model: { selectedModel: "fixture/local" }, result: "PASS" }; },
    assessPredicate: () => ({ verdict: "pass", method: "fixture check" }) });
  try {
    const before = store.inspectMission(mission.id);
    const receipt = recordOperatorInput("console", "owner", "revise durable-fixture maybe stricter", randomUUID(), "maybe stricter")!;
    askMissionChoice({ store, engine, missionId: mission.id, expectedVersion: before.version, receipt,
      delta: JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: "snapshot", after: "stricter" }]) });
    const current = store.inspectMission(mission.id);
    const next = structuredClone(current.definition);
    next.units.splice(0, 1);
    next.finalization.requiredPredicates = ["other-check"];
    admitMissionChange({ store, engine, missionId: mission.id, expectedVersion: current.version,
      actor: "operator", receipt: operatorChangeReceipt(store, current, next),
      planBytes: nextPlanBytes(current.planBytes), definitionBytes: Buffer.from(JSON.stringify(next)) });
    engine.start(); await engine.waitForIdle();
    const after = store.inspectMission(mission.id);
    expect(launches).toContain("independent");
    expect(reduceMissionEvents(after).units.independent?.status).toBe("accepted");
    expect(causeBlockers(store, mission.id, "writer:")).toEqual([]);
    expect(reduceMissionEvents(after).canFinalize).toBe(true);
    expect(pendingMissionQuestions(after.events, store).map(({ roots }) => roots)).toEqual([[]]);
    expect(missionCompletionBlockers(after, store)).toContain(`question:${receipt.id}`);
    expect(() => store.appendTransition(mission.id, after.version, { events: [{ revision: after.revision,
      kind: "mission.completed", causalId: randomUUID(), payload: {} }] })).toThrow(/completion blocked/);
  } finally { await engine.close(); store.close(); }
});
