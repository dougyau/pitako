import { randomUUID, createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { createMissionFixture, missionDefinition, missionInput, openFixtureStore } from "../tests/mission-fixtures.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";
import { createPiExecutor } from "../extensions/agent/pi.ts";
import { MissionEngine, createPiMissionRunner } from "../extensions/mission/engine.ts";
import type { AgentRunResult } from "../extensions/agent/run.ts";
import { MissionEffects } from "../extensions/mission/effects.ts";
import { captureWorkspacePaths, createMissionWorkspace, currentProcessIdentity, preflightContainment, processesInNamespace } from "../extensions/mission/workspace.ts";
import { ledgerTeamHolds, parseLedgerBinding, parseLedgerStatus } from "../extensions/workflow.ts";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadPitako } from "./load-pitako.ts";
import { packageRoot } from "../extensions/stack.ts";

const NODE_PHASES = ["cross-process", "replay", "crash", "schema", "identity", "authority"] as const;
const T1_CRITERIA = [
  { id: "node-cross-process-read", title: "Production Node process reads committed snapshots and export", artifacts: ["node-cross-process.log", "node-cross-process-observed.json", "scenario-export/export.json"] },
  { id: "idempotent-replay", title: "Duplicate command, reservation, and facts replay without duplicate projections", artifacts: ["node-replay.log", "node-replay-observed.json", "scenario-export/observed.json"] },
  { id: "crash-cuts", title: "Node crash cuts leave only unreferenced objects or valid committed references", artifacts: ["node-crash.log", "node-crash-observed.json"] },
  { id: "immutable-source-snapshot", title: "Changed or missing source files do not alter exact stored snapshot bytes", artifacts: ["scenario-export/observed.json", "scenario-export/export.json"] },
  { id: "fail-closed-storage", title: "Unknown schema and corrupt SQLite files remain unchanged", artifacts: ["node-schema.log", "node-schema-observed.json"] },
  { id: "legacy-preview", title: "Legacy preview preserves exact source bytes and unknown holds", artifacts: ["scenario-export/observed.json"] },
  { id: "generated-ledger-authority", title: "Node legacy authority rejects generated-ledger formats", artifacts: ["node-authority.log", "node-authority-observed.json", "scenario-export/ledger.md"] },
  { id: "repository-family-identity", title: "Copied and replaced Git identities fail closed; linked worktree identity survives deletion", artifacts: ["node-identity.log", "node-identity-observed.json"] },
  { id: "single-writer-reservation", title: "Only reserved writer mutates; orderly release permits safe reopen", artifacts: ["node-replay.log", "node-replay-observed.json"] },
  { id: "measurement-observation-replay", title: "Measurement and evaluation replay preserve one fact and explicit unknown values", artifacts: ["scenario-export/observed.json", "scenario-export/export.json", "scenario-export/missions.sqlite"] },
  { id: "stage-evidence-manifest", title: "T1 records observed criterion mappings, artifact hashes, runtime and diff identity", artifacts: ["node-cross-process-observed.json", "node-replay-observed.json", "node-crash-observed.json", "node-schema-observed.json", "node-identity-observed.json", "node-authority-observed.json", "scenario-export/observed.json"] },
] as const;

const T2_CRITERIA = [
  { id: "persistent-pi-attempt-context", title: "Real Pi SDK attempts persist isolated sessions with frozen provider provenance", artifacts: ["t2-observations.json", "t2-local-provider-trace.json", "t2-session-manifest.json", "t2-sessions/first.jsonl", "t2-sessions/second.jsonl"] },
  { id: "dependency-frontier", title: "Only dependency-ready units dispatch; accepted evidence releases the next frontier", artifacts: ["t2-observations.json", "t2-events.json"] },
  { id: "accepted-evidence-gating", title: "Acceptance uses host-observed current-revision evidence rather than worker PASS claims", artifacts: ["t2-observations.json", "t2-callback-observed.json", "t2-events.json"] },
  { id: "callback-receipt-reconciliation", title: "Duplicate and lost callbacks reconcile to one durable receipt per attempt", artifacts: ["t2-observations.json", "t2-callback-observed.json", "t2-events.json"] },
  { id: "budget-and-active-time", title: "Reservations preserve protected finalization capacity, reconcile overage debt, and active time excludes idle gaps", artifacts: ["t2-accounting-probes.json", "t2-node-accounting-replay-observed.json"] },
  { id: "writer-reservation-continuity", title: "T2 preserves explicit writer release and repository continuity", artifacts: ["t2-node-accounting-replay-observed.json"] },
  { id: "read-only-no-paid-provider", title: "Bounded SDK fixture makes no paid request or mission-owned product write", artifacts: ["t2-observations.json", "t2-local-provider-trace.json"] },
  { id: "t2-validation-gates", title: "Focused regressions, cross-runtime accounting replay, and typecheck pass", artifacts: ["focused-tests.log", "agent-runner-regressions.log", "typecheck.log", "node-accounting-replay.log"] },
  { id: "criterion-observation-evidence", title: "Every T2 criterion maps to a recorded observation and hashed artifact", artifacts: ["t2-observations.json"] },
] as const;
const T3_CRITERIA = [
  { id: "managed-candidate-containment", title: "Independent candidate inputs and real bwrap read-only/network sentinels pass", artifacts: ["t3-contained-shutdown-observed.json"] },
  { id: "fenced-adapters-and-denials", title: "Pi exposes only contained local adapters and denies escapes/native execution", artifacts: ["t3-contained-shutdown-observed.json", "t3-effects-tests.log", "t3-agent-pi-tests.log"] },
  { id: "durable-crash-boundaries", title: "Production Node subprocess crash cuts preserve effect intent/release/receipt uncertainty", artifacts: ["t3-crash-boundaries-observed.json", "t3-node-crash-observed.json"] },
  { id: "effect-settlement-safety", title: "Unknown exposure and invoking effects without bound identity cannot produce pass evidence after replay", artifacts: ["t3-node-crash-observed.json"] },
  { id: "partial-effects-and-quiescence", title: "Partial writes remain observed and detached descendants are reaped", artifacts: ["t3-contained-shutdown-observed.json"] },
  { id: "pi-reload-owner-fencing", title: "Real Pi reload awaits owner retirement and late old results cannot advance the new epoch", artifacts: ["t3-reload-observed.json", "t3-contained-shutdown-observed.json"] },
  { id: "t1-t2-regressions", title: "T1 and T2 acceptance verifiers remain green after T3", artifacts: ["t1-regression.log", "t2-regression.log", "t1-regression-evidence/verification-manifest.json", "t2-regression-evidence/verification-manifest.json"] },
  { id: "full-t3-plan-acceptance", title: "Clean shutdown pauses resumably and teardown proves detached-process ancestry/quiescence", artifacts: ["t3-clean-release-observed.json", "t3-contained-shutdown-observed.json", "t3-crash-boundaries-observed.json", "t3-reload-observed.json"] }
] as const;

interface CommandResult {
  id: string;
  command: string;
  args: string[];
  environment: Record<string, string>;
  exitCode: number;
  logPath: string;
  observationPath?: string;
}

interface ScenarioResult {
  missionId: string;
  repositoryId: string;
  planHash: string;
  definitionHash: string;
  eventSeq: number;
  replayHash: string;
  snapshotUnaffectedByChangedAndMissingSources: boolean;
  commandIdempotent: boolean;
  reservationIdempotent: boolean;
  measurementIdempotent: boolean;
  evaluationIdempotent: boolean;
  unknownUsageExplicit: boolean;
  observationUnassessed: boolean;
  generatedLedgerRejected: boolean;
  legacyPreviewPreserved: boolean;
  legacyUnknownHolds: boolean;
}

async function main(): Promise<void> {
  const { stage, evidenceDir } = parseArguments(process.argv.slice(2));
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = path.join(evidenceDir, "runs", `${Date.now()}-${randomUUID()}`);
  mkdirSync(runDir, { recursive: true });
  const runDirectory = path.relative(evidenceDir, runDir).split(path.sep).join("/");
  const previousManifest = path.join(evidenceDir, "verification-manifest.json");
  if (existsSync(previousManifest)) persistFile(path.join(runDir, "previous-verification-manifest.json"), readFileSync(previousManifest, "utf8"));
  const commands: CommandResult[] = [];
  if (stage !== "T1") {
    if (["T2", "T3", "T4"].includes(stage)) {
      await verifyLaterStage(stage, runDir, evidenceDir, commands);
      return;
    }
    if (stage === "T5") {
      await verifyT5Stage(stage, runDir, evidenceDir, commands);
      return;
    }
    if (stage === "T6") {
      await verifyT6Stage(runDir, evidenceDir, commands);
      return;
    }
    if (stage === "T7") {
      await verifyT7Stage(runDir, evidenceDir, commands);
      return;
    }
    const message = `Stage ${stage} is not implemented; this verifier covers T1-T7 only.`;
    persistFile(path.join(runDir, "prerequisite.log"), `${message}\n`);
    commands.push({ id: "stage-prerequisite", command: "verify:mission", args: [stage], environment: {}, exitCode: 1, logPath: `${runDirectory}/prerequisite.log` });
    const manifest = buildManifest(stage, "not_implemented", commands, [], message, runDir, evidenceDir);
    persistManifest(evidenceDir, manifest);
    console.error(`verify:mission: ${message}`);
    process.exitCode = 1;
    return;
  }

  await verifyT1Stage(runDir, evidenceDir, commands);
}

async function verifyT1Stage(runDir: string, evidenceDir: string, commands: CommandResult[]): Promise<void> {
  const focused = runCommand(runDir, evidenceDir, commands, "focused-tests", "bun", [
    "test", "tests/mission-model.test.ts", "tests/mission-store.test.ts", "tests/workflow.test.ts", "tests/execution-binding.test.ts",
  ]);
  const phaseResults = new Map<string, CommandResult>();
  const observations = new Map<string, unknown>();
  for (const phase of NODE_PHASES) {
    const observationPath = path.join(runDir, `node-${phase}-observed.json`);
    const command = runCommand(runDir, evidenceDir, commands, `node-${phase}`, "node", ["--test", "scripts/mission-durability-node.mjs"], {
      MISSION_DURABILITY_PHASE: phase, MISSION_DURABILITY_OBSERVATION_PATH: observationPath,
    }, observationPath);
    phaseResults.set(phase, command);
    observations.set(phase, readJson(observationPath));
  }

  let scenario: ScenarioResult | undefined;
  let scenarioError: string | undefined;
  try {
    scenario = await runScenario(runDir);
    persistFile(path.join(runDir, "scenario.log"), JSON.stringify(scenario, null, 2) + "\n");
    commands.push({ id: "bounded-stage-scenario", command: "verify-mission.ts T1 observed fixture scenario", args: [], environment: {}, exitCode: 0, logPath: rel(evidenceDir, path.join(runDir, "scenario.log")) });
  } catch (error) {
    scenarioError = errorMessage(error);
    persistFile(path.join(runDir, "scenario.log"), `${scenarioError}\n`);
    commands.push({ id: "bounded-stage-scenario", command: "verify-mission.ts T1 observed fixture scenario", args: [], environment: {}, exitCode: 1, logPath: rel(evidenceDir, path.join(runDir, "scenario.log")) });
  }

  const rows = (phase: string) => Array.isArray(observations.get(phase)) ? observations.get(phase) as Array<Record<string, any>> : undefined;
  const row = (phase: string, id: string) => rows(phase)?.find((item) => item.id === id);
  const check = (phase: string, predicate: () => boolean): boolean | undefined => {
    const command = phaseResults.get(phase);
    if (command?.exitCode !== 0) return false;
    if (!rows(phase)) return undefined;
    try { return predicate(); } catch { return false; }
  };
  const criterionChecks: Record<string, { value: boolean | undefined; observed: unknown }> = {
    "node-cross-process-read": {
      value: check("cross-process", () => {
        const item = row("cross-process", "cross-process-read");
        const f = item?.facts;
        return item?.assertionsPassed === true && f?.writerMissionId === f?.readerMissionId && f?.readerPid !== f?.verifierPid &&
          f?.planBytes?.observed === f?.planBytes?.expected && f?.planBytes?.hash === f?.planBytes?.expectedHash &&
          f?.definitionBytes?.observed === f?.definitionBytes?.expected && f?.definitionBytes?.hash === f?.definitionBytes?.expectedHash &&
          f?.manifest?.databaseHashMatches === true && f?.manifest?.objectHashesMatch === true;
      }), observed: row("cross-process", "cross-process-read"),
    },
    "idempotent-replay": {
      value: check("replay", () => {
        const replay = row("replay", "cross-process-replay")?.facts;
        const owner = row("replay", "owner-and-causal-replay")?.facts;
        return row("replay", "cross-process-replay")?.assertionsPassed === true && replay?.firstVersion === replay?.secondVersion &&
          replay?.sameProjectionHash === true && replay?.sameReservationEvent === true &&
          owner?.measurement?.count === 1 && owner?.measurement?.firstId === owner?.measurement?.replayId && Boolean(owner?.measurement?.conflictError);
      }), observed: { replay: row("replay", "cross-process-replay"), causalReplay: row("replay", "owner-and-causal-replay") },
    },
    "crash-cuts": {
      value: check("crash", () => {
        const cuts = rows("crash")?.filter((item) => item.id.startsWith("crash-cut:")) ?? [];
        const contract: Record<string, { found: boolean; refs: number; unreferenced: number }> = {
          "object.after-temp-sync": { found: false, refs: 0, unreferenced: 1 },
          "object.after-rename": { found: false, refs: 0, unreferenced: 1 },
          "mission.create.before-commit": { found: false, refs: 0, unreferenced: 2 },
          "mission.create.after-commit": { found: true, refs: 2, unreferenced: 0 },
        };
        return cuts.length === Object.keys(contract).length && cuts.every((item) => {
          const expected = contract[item.id.slice("crash-cut:".length)];
          const actual = item.facts?.observed;
          return Boolean(expected) && item.assertionsPassed === true && actual?.found === expected!.found &&
            actual?.referenceCount === expected!.refs && actual?.invalidObjectCount === 0 && actual?.unreferencedObjectCount === expected!.unreferenced;
        });
      }), observed: rows("crash")?.filter((item) => item.id.startsWith("crash-cut:")),
    },
    "immutable-source-snapshot": {
      value: passedScenario(scenario, scenarioError, (value) => value.snapshotUnaffectedByChangedAndMissingSources), observed: scenario?.snapshotUnaffectedByChangedAndMissingSources,
    },
    "fail-closed-storage": {
      value: check("schema", () => {
        const f = row("schema", "fail-closed-schema")?.facts;
        return row("schema", "fail-closed-schema")?.assertionsPassed === true && f?.unknownSchema?.observedVersion === f?.unknownSchema?.expectedVersion &&
          f?.corruptDatabase?.preserved === true && f?.emptyDatabase?.preserved === true && f?.oneByteDatabase?.preserved === true &&
          Boolean(f?.unknownSchema?.rejection) && Boolean(f?.corruptDatabase?.rejection) && Boolean(f?.emptyDatabase?.rejection) && Boolean(f?.oneByteDatabase?.rejection);
      }), observed: row("schema", "fail-closed-schema"),
    },
    "legacy-preview": {
      value: passedScenario(scenario, scenarioError, (value) => value.legacyPreviewPreserved && value.legacyUnknownHolds),
      observed: scenario && { rawBytesPreserved: scenario.legacyPreviewPreserved, unknownHolds: scenario.legacyUnknownHolds },
    },
    "generated-ledger-authority": {
      value: check("authority", () => {
        const f = row("authority", "forged-generated-ledger")?.facts;
        return row("authority", "forged-generated-ledger")?.assertionsPassed === true && f?.validLegacy?.execution?.planId === "durable-fixture" &&
          f?.cases?.length >= 9 && f.cases.every((entry: any) => ["binding", "status", "holds", "execution"].every((name) =>
            typeof entry.rejected?.[name] === "string" && entry.rejected[name].includes("generated mission ledger")) &&
            entry.preview?.generatedLedger === true && entry.preview?.holdsKnown === false);
      }), observed: row("authority", "forged-generated-ledger"),
    },
    "repository-family-identity": {
      value: check("identity", () => {
        const copied = row("identity", "repository-identity-rejections")?.facts;
        const alias = row("identity", "repository-same-path-and-alias")?.facts;
        const worktree = row("identity", "repository-worktree-reopen")?.facts;
        return row("identity", "repository-identity-rejections")?.assertionsPassed === true &&
          row("identity", "repository-same-path-and-alias")?.assertionsPassed === true &&
          Boolean(copied?.crossHost?.error) && copied?.refAndPackDrift?.expectedRepositoryId === copied?.refAndPackDrift?.observedRepositoryId &&
          Boolean(alias?.samePathCopiedMarker?.error) && alias?.samePathCopiedMarker?.commonInodePreserved === true && Boolean(alias?.sameHostAlias?.error) &&
          worktree?.linkedRepositoryId === worktree?.expectedRepositoryId && worktree?.reopenedRepositoryId === worktree?.expectedRepositoryId &&
          worktree?.reopenedPlanHash === worktree?.expectedPlanHash;
      }), observed: {
        rejection: row("identity", "repository-identity-rejections"), samePathAndAlias: row("identity", "repository-same-path-and-alias"),
        worktree: row("identity", "repository-worktree-reopen"),
      },
    },
    "single-writer-reservation": {
      value: check("replay", () => {
        const owner = row("replay", "owner-and-causal-replay")?.facts;
        const lifecycle = row("replay", "writer-reservation-lifecycle")?.facts;
        return Boolean(owner?.secondWriter?.error?.includes("read-only")) && Boolean(owner?.secondMission?.error?.includes("read-only")) &&
          lifecycle?.live?.holderPid !== lifecycle?.live?.probePid && Boolean(lifecycle?.live?.writeError?.includes("read-only")) &&
          lifecycle?.release?.message?.released === true && lifecycle?.release?.ownerEpoch === 2 &&
          lifecycle?.crash?.exitCode === 86 && lifecycle?.crash?.ownerEpoch > 1;
      }), observed: { owner: row("replay", "owner-and-causal-replay"), lifecycle: row("replay", "writer-reservation-lifecycle") },
    },
    "measurement-observation-replay": {
      value: passedScenario(scenario, scenarioError, (value) => value.measurementIdempotent && value.evaluationIdempotent && value.unknownUsageExplicit && value.observationUnassessed),
      observed: scenario && { oneMeasurement: scenario.measurementIdempotent, oneEvaluation: scenario.evaluationIdempotent, unknownUsage: scenario.unknownUsageExplicit, unassessed: scenario.observationUnassessed },
    },
  };

  const stageCriterion = T1_CRITERIA.find(({ id }) => id === "stage-evidence-manifest")!;
  const results = T1_CRITERIA.filter(({ id }) => id !== stageCriterion.id).map((criterion) => {
    const mapped = criterionChecks[criterion.id];
    const missing = criterion.artifacts.filter((relative) => !existsSync(path.join(runDir, relative)) || !statSync(path.join(runDir, relative)).isFile());
    const value = mapped.value === true && missing.length > 0 ? undefined : mapped.value;
    return makeCriterion(evidenceDir, runDir, criterion, value, { observations: mapped.observed, missingArtifacts: missing });
  });
  const implementation = implementationDiffIdentity();
  const t1Stage = results.every((item) => item.status === "pass") && commands.every((item) => item.exitCode === 0) && /^[a-f0-9]{64}$/.test(implementation);
  const criteria = [...results, makeCriterion(evidenceDir, runDir, stageCriterion, t1Stage, {
    criterionEvidence: results.map(({ id, status, evidence }) => ({ id, status, evidence: evidence.map((item) => ({ path: item.path, sha256: item.sha256 })) })),
    commandExits: commands.map(({ id, exitCode }) => ({ id, exitCode })), implementationDiffIdentity: implementation,
  })];
  const status = stageStatus(criteria);
  const manifest = buildManifest("T1", status, commands, criteria, scenarioError, runDir, evidenceDir);
  persistManifest(evidenceDir, manifest);
  console.log(`verify:mission T1 ${status}: ${path.join(evidenceDir, "verification-manifest.json")}`);
  if (status !== "pass") process.exitCode = 1;
}

function passedScenario<T>(scenario: ScenarioResult | undefined, error: string | undefined, read: (value: ScenarioResult) => boolean): boolean | undefined {
  if (error) return false;
  return scenario ? read(scenario) : undefined;
}

function makeCriterion(
  evidenceRoot: string,
  runDir: string,
  criterion: { id: string; title: string; artifacts: readonly string[] },
  check: boolean | undefined,
  observed: unknown,
) {
  const missingArtifacts = criterion.artifacts.filter((relative) => {
    const file = path.join(runDir, relative);
    return !existsSync(file) || !statSync(file).isFile();
  });
  const evidence = criterion.artifacts.flatMap((relative) => {
    const file = path.join(runDir, relative);
    return existsSync(file) && statSync(file).isFile() ? [artifact(evidenceRoot, file)] : [];
  });
  const status = check === false ? "fail" : check === true && missingArtifacts.length === 0 ? "pass" : "inconclusive";
  return { ...criterion, status, reason: JSON.stringify({ observed, missingArtifacts }), evidence };
}

function stageStatus(criteria: Array<{ status: string }>): "pass" | "fail" | "inconclusive" {
  if (criteria.some(({ status }) => status === "fail")) return "fail";
  return criteria.every(({ status }) => status === "pass") ? "pass" : "inconclusive";
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function parseArguments(args: string[]): { stage: string; evidenceDir: string } {
  const normalized = args.filter((arg) => arg !== "--");
  const stage = normalized[0];
  if (!stage) throw new Error("usage: bun run verify:mission -- T1 --evidence-dir <directory>");
  const index = normalized.indexOf("--evidence-dir");
  const directory = index < 0 ? undefined : normalized[index + 1];
  if (!directory) throw new Error("--evidence-dir <directory> is required; stage evidence must remain inspectable");
  return { stage, evidenceDir: path.resolve(directory) };
}

function runCommand(runDir: string, evidenceRoot: string, results: CommandResult[], id: string, command: string, args: string[], environment: Record<string, string> = {}, observationPath?: string): CommandResult {
  // Side logs survive termination of the verifier; only a returned child gets a receipt.
  const stdoutPath = path.join(runDir, `${id}.stdout.log`);
  const stderrPath = path.join(runDir, `${id}.stderr.log`);
  const stdout = openSync(stdoutPath, "w", 0o600);
  let outcome: ReturnType<typeof spawnSync>;
  try {
    const stderr = openSync(stderrPath, "w", 0o600);
    try {
      outcome = spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...environment }, stdio: ["ignore", stdout, stderr] });
    } finally {
      closeSync(stderr);
    }
  } finally {
    closeSync(stdout);
  }
  const exitCode = outcome.status ?? 1;
  const localLogPath = `${id}.log`;
  const logPath = path.relative(evidenceRoot, path.join(runDir, localLogPath)).split(path.sep).join("/");
  const text = readFileSync(stdoutPath, "utf8") + readFileSync(stderrPath, "utf8");
  persistFile(path.join(runDir, localLogPath), text || `exitCode=${exitCode}\n`);
  rmSync(stdoutPath);
  rmSync(stderrPath);
  const result = { id, command, args, environment, exitCode, logPath, ...(observationPath ? { observationPath: rel(evidenceRoot, observationPath) } : {}) };
  results.push(result);
  return result;
}

async function runScenario(evidenceDir: string): Promise<ScenarioResult> {
  const fixture = createMissionFixture("pitako-t1-stage-");
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  try {
    store = await openFixtureStore(fixture);
    const input = missionInput(fixture);
    const mission = store.createMission(input);
    const reservation = { id: randomUUID(), revision: 1, resource: "provider-requests", amount: 1 };
    const firstReservation = store.reserve(mission.id, reservation, 1);
    const duplicateReservation = store.reserve(mission.id, reservation, 1);
    const measurement = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      missionId: mission.id,
      revision: 1,
      causalId: randomUUID(),
      metric: "provider-input-tokens",
      value: null,
      unit: "tokens",
      source: "fixture provider receipt",
      occurredAt: new Date().toISOString(),
      runtimeId: store.runtimeId,
      durationMs: null,
      unknownReason: "local fixture has no provider usage",
      inputTokens: null,
      outputTokens: null,
      usageUnknownReason: "no provider request was made",
    };
    const firstMeasurement = store.recordMeasurement(measurement, 2);
    const duplicateMeasurement = store.recordMeasurement(measurement, 2);
    const observation = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      missionId: mission.id,
      revision: 1,
      resultManifestHash: sha256(Buffer.from(JSON.stringify({ missionId: mission.id, revision: 1, reservation: reservation.id }))),
      criterionVersion: "t1-stage-v1",
      evaluatorIdentity: "verification-script",
      method: "inspect committed fixture export",
      observedAt: new Date().toISOString(),
      windowStart: null,
      windowEnd: null,
      evidenceRefs: ["export.json"],
      verdict: "unassessed" as const,
      classification: "outcome" as const,
      supersedesId: null,
    };
    const firstObservation = store.recordEvaluationObservation(observation, 3);
    const duplicateObservation = store.recordEvaluationObservation(observation, 3);

    writeFileSync(fixture.planFile, Buffer.from("changed source plan after snapshot\n"));
    writeFileSync(fixture.definitionFile, Buffer.from("changed executable definition after snapshot\n"));
    const replayed = store.createMission({ ...input, missionId: randomUUID() });
    rmSync(fixture.planFile);
    const inspection = store.inspectMission(mission.id);
    const replay = store.replayMission(mission.id);
    const exportDir = path.join(evidenceDir, "scenario-export");
    const exported = await store.exportMission(mission.id, exportDir);
    const generatedLedger = readFileSync(path.join(exportDir, "ledger.md"), "utf8");
    const rawLedger = Buffer.from([
      "---", "plan_id: durable-fixture", "revision: 1", `hash: ${"d".repeat(64)}`, "status: completed", "---", "",
      "<!-- pitako-team-holds:v1 -->", '[{"assignmentId":"known","unitId":"T1","status":"pending"},{"assignmentId":"unknown","unitId":"T2","status":"future"}]',
      "<!-- /pitako-team-holds -->", "",
    ].join("\r\n"));
    const rawEvidence = Buffer.from([0x00, 0xff, 0x0a, 0x20]);
    const previewInput = { planId: "durable-fixture", planBytes: fixture.planBytes, ledgerBytes: rawLedger, evidence: [{ path: "T1/raw.bin", bytes: rawEvidence }] };
    const preview = store.previewLegacyImport(previewInput);
    const repeatedPreview = store.previewLegacyImport(previewInput);
    const legacyPreviewPreserved = JSON.stringify(preview) === JSON.stringify(repeatedPreview) &&
      Buffer.from(preview.rawPlanBase64, "base64").equals(fixture.planBytes) && Buffer.from(preview.rawLedgerBase64, "base64").equals(rawLedger) &&
      Buffer.from(preview.evidence[0]?.bytesBase64 ?? "", "base64").equals(rawEvidence);
    const legacyUnknownHolds = preview.holdsKnown === false && preview.holds.map(({ disposition }) => disposition).join(",") === "unresolved,unknown" &&
      preview.holds[1]?.status === "future";
    const generatedLedgerRejected = [parseLedgerBinding, parseLedgerStatus, ledgerTeamHolds].every((parse) => {
      try { parse(generatedLedger); return false; } catch (error) { return /generated mission ledger/.test(errorMessage(error)); }
    });
    const result: ScenarioResult = {
      missionId: mission.id,
      repositoryId: mission.repositoryId,
      planHash: mission.snapshot.planHash,
      definitionHash: mission.snapshot.definitionHash,
      eventSeq: inspection.latestSeq,
      replayHash: replay.projectionHash,
      snapshotUnaffectedByChangedAndMissingSources: inspection.planBytes.equals(fixture.planBytes) && inspection.definitionBytes.equals(fixture.definitionBytes) && inspection.snapshot.planHash === mission.snapshot.planHash,
      commandIdempotent: replayed.id === mission.id,
      reservationIdempotent: firstReservation.eventId === duplicateReservation.eventId && replay.reservations.length === 1,
      measurementIdempotent: firstMeasurement.id === duplicateMeasurement.id && replay.measurements.length === 1 && replay.measurements[0]?.schemaVersion === 1,
      evaluationIdempotent: firstObservation.id === duplicateObservation.id && replay.evaluations.length === 1 && replay.evaluations[0]?.schemaVersion === 1,
      unknownUsageExplicit: inspection.measurements[0]?.value === null && !!inspection.measurements[0]?.unknownReason && inspection.measurements[0]?.inputTokens === null && !!inspection.measurements[0]?.usageUnknownReason,
      observationUnassessed: inspection.evaluations[0]?.verdict === "unassessed",
      generatedLedgerRejected,
      legacyPreviewPreserved,
      legacyUnknownHolds,
    };
    if (inspection.version !== 4 || inspection.latestSeq !== 4 || exported.eventSeq !== 4) throw new Error(`scenario event/version mismatch: ${inspection.version}/${inspection.latestSeq}/${exported.eventSeq}`);
    persistFile(path.join(exportDir, "observed.json"), JSON.stringify(result, null, 2) + "\n");
    if (Object.values(result).some((value) => typeof value === "boolean" && !value)) throw new Error(`scenario acceptance failed: ${JSON.stringify(result)}`);
    return result;
  } finally {
    store?.close();
    rmSync(fixture.base, { recursive: true, force: true });
  }
}

function buildManifest(stage: string, status: string, commands: CommandResult[], criteria: unknown[], error: string | undefined, runDir: string, evidenceRoot: string) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const diffIdentity = implementationDiffIdentity();
  return {
    format: "mission-stage-evidence-v1",
    stage,
    status,
    createdAt: new Date().toISOString(),
    implementation: { commit: head, diffIdentity },
    runtime: { bun: Bun.version, node: nodeVersion(), platform: process.platform, architecture: process.arch },
    fixture: {
      id: "durable-mission-fixture-v1",
      provider: stage === "T2" || stage === "T6" ? "pitako-mission-local" : stage === "T4" ? "fixture" : "none",
      paidRequests: 0,
    },
    runDirectory: path.relative(evidenceRoot, runDir).split(path.sep).join("/"),
    evidenceManifestPath: "verification-manifest.json",
    // T7 seals only verifier-owned files, not a caller's still-open output log.
    artifacts: stage === "T7" ? listArtifacts(runDir).map((row) => ({
      ...row, path: rel(evidenceRoot, path.join(runDir, row.path)),
    })) : listArtifacts(evidenceRoot),
    commands,
    criteria,
    ...(error ? { error } : {}),
  };
}

function listArtifacts(root: string): Array<{ path: string; sha256: string; size: number }> {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && path.relative(root, target) !== "verification-manifest.json") files.push(target);
    }
  };
  visit(root);
  return files.sort().map((file) => artifact(root, file));
}

function implementationDiffIdentity(): string {
  const trackedDiff = execFileSync("git", ["diff", "--binary", "HEAD"], { encoding: "buffer" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer" }).toString("utf8").split("\0").filter(Boolean).sort();
  const hashes = untracked.map((file) => `${file}\0${sha256(readFileSync(file))}`).join("\0");
  return sha256(Buffer.concat([trackedDiff, Buffer.from(`\0${hashes}`)]));
}

function persistManifest(evidenceDir: string, manifest: unknown): void {
  persistFile(path.join(evidenceDir, "verification-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function persistFile(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "w", 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(path.dirname(file), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function artifact(root: string, file: string): { path: string; sha256: string; size: number } {
  const bytes = readFileSync(file);
  return { path: path.relative(root, file).split(path.sep).join("/"), sha256: sha256(bytes), size: bytes.byteLength };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nodeVersion(): string {
  return execFileSync("node", ["--version"], { encoding: "utf8" }).trim();
}

function passed(result: CommandResult | undefined): boolean {
  return result?.exitCode === 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function verifyT2Stage(runDir: string, evidenceDir: string, commands: CommandResult[]): Promise<void> {
  const accountingPath = path.join(runDir, "t2-accounting-probes.json");
  const focused = runCommand(runDir, evidenceDir, commands, "focused-tests", "bun", ["test",
    "tests/mission-model.test.ts", "tests/mission-store.test.ts", "tests/mission-engine.test.ts", "tests/mission-runner.test.ts", "tests/mission-accounting.test.ts"], {
    MISSION_ACCOUNTING_OBSERVATION_PATH: accountingPath,
  });
  const agentTests = runCommand(runDir, evidenceDir, commands, "agent-runner-regressions", "bun", ["test", "tests/agent.test.ts", "tests/agent-pi.test.ts"]);
  const typecheck = runCommand(runDir, evidenceDir, commands, "typecheck", "bun", ["run", "typecheck"]);
  const nodePath = path.join(runDir, "t2-node-accounting-replay-observed.json");
  const nodeReplay = runCommand(runDir, evidenceDir, commands, "node-accounting-replay", "node", ["--test", "scripts/mission-durability-node.mjs"], {
    MISSION_DURABILITY_PHASE: "replay", MISSION_DURABILITY_OBSERVATION_PATH: nodePath,
  }, nodePath);

  let sdk: Record<string, any> | undefined;
  let callbacks: Record<string, any> | undefined;
  try {
    sdk = await runT2SdkScenario(runDir);
    commands.push({ id: "bounded-real-sdk-scenario", command: "verify-mission.ts T2 local Pi SDK scenario", args: [], environment: {}, exitCode: 0, logPath: rel(evidenceDir, path.join(runDir, "t2-local-provider-trace.json")) });
  } catch (error) {
    persistFile(path.join(runDir, "t2-sdk-error.log"), `${errorMessage(error)}\n`);
    commands.push({ id: "bounded-real-sdk-scenario", command: "verify-mission.ts T2 local Pi SDK scenario", args: [], environment: {}, exitCode: 1, logPath: rel(evidenceDir, path.join(runDir, "t2-sdk-error.log")) });
  }
  try {
    callbacks = await runT2CallbackScenarios(runDir);
    commands.push({ id: "callback-and-host-artifact-scenarios", command: "verify-mission.ts T2 callback and host artifact scenarios", args: [], environment: {}, exitCode: 0, logPath: rel(evidenceDir, path.join(runDir, "t2-callback-observed.json")) });
  } catch (error) {
    persistFile(path.join(runDir, "t2-callback-error.log"), `${errorMessage(error)}\n`);
    commands.push({ id: "callback-and-host-artifact-scenarios", command: "verify-mission.ts T2 callback and host artifact scenarios", args: [], environment: {}, exitCode: 1, logPath: rel(evidenceDir, path.join(runDir, "t2-callback-error.log")) });
  }

  const accounting = readJson(accountingPath) as { probes?: Array<Record<string, any>> } | undefined;
  const accountingById = new Map((accounting?.probes ?? []).map((probe) => [probe.id, probe]));
  const nodeRows = readJson(nodePath) as Array<Record<string, any>> | undefined;
  const nodeById = new Map((Array.isArray(nodeRows) ? nodeRows : []).map((entry) => [entry.id, entry]));
  const sdkSessions = sdk?.sessions ?? [];
  const sdkReceipts = sdk?.providerReceipts ?? [];
  const sdkProviderTrace = sdk?.providerTrace ?? [];
  const sdkAttempts = sdk?.attempts ?? [];
  const firstAcceptedSeq = sdk?.acceptedFirstSeq;
  const secondReservedSeq = sdk?.secondReservedSeq;
  const sdkSafe = sdk !== undefined && sdk.unitStates?.first === "accepted" && sdk.unitStates?.second === "accepted" && sdk.canFinalize === true &&
    sdkSessions.length === 2 && sdkSessions.every((session: any) => session.persisted === true && session.insideMissionSessionRoot === true && session.containsProviderResponse === true) &&
    new Set(sdkSessions.map((session: any) => session.attemptId)).size === 2 && sdkReceipts.length === 2 &&
    sdkReceipts.every((receipt: any) => receipt.provider === "pitako-mission-local" && receipt.model === "fixture" && receipt.inputTokens === 17 && receipt.outputTokens === 8) &&
    sdkProviderTrace.length === 2 && new Set(sdkProviderTrace.map((trace: any) => trace.sessionId)).size === 2 &&
    sdkProviderTrace.every((trace: any) => trace.provider === "pitako-mission-local" && trace.model === "fixture" && trace.cost === 0 && sdkSessions.some((session: any) => session.attemptId === trace.sessionId)) &&
    sdkAttempts.length === 2 && sdkAttempts.every((attempt: any) => attempt.status === "succeeded" && attempt.selectedModel === "pitako-mission-local/fixture");
  const frontier = typeof firstAcceptedSeq === "number" && firstAcceptedSeq > 0 && typeof secondReservedSeq === "number" &&
    secondReservedSeq > firstAcceptedSeq && sdk?.dispatchUnits?.join(",") === "first,second";
  const callbacksSafe = callbacks?.lost?.unitStates?.lost === "accepted" && callbacks?.lost?.unitStates?.dependent === "accepted" &&
    callbacks?.lost?.receiptCount === 2 && callbacks?.lost?.starts?.join(",") === "lost,dependent" &&
    callbacks?.duplicate?.receiptCount === 1 && callbacks?.duplicate?.startCount === 1 && callbacks?.duplicate?.unitStatus === "accepted" &&
    callbacks?.falsePass?.workerClaim === "PASS" && callbacks?.falsePass?.hostArtifact === "FAIL" &&
    callbacks?.falsePass?.evidenceVerdict === "fail" && callbacks?.falsePass?.unitStatus === "blocked" &&
    callbacks?.falsePass?.evidenceArtifactHash === callbacks?.falsePass?.hostArtifactHash &&
    callbacks?.falsePass?.workerArtifactHash !== callbacks?.falsePass?.hostArtifactHash;
  const usage = accountingById.get("provider-usage-reconciliation")?.facts;
  const partialUsage = accountingById.get("partial-provider-usage")?.facts;
  const activeUnion = accountingById.get("active-time-union")?.facts;
  const protectedAdmission = accountingById.get("protected-admission")?.facts;
  const activeFence = accountingById.get("active-time-pre-admission-fence")?.facts;
  const recoveredBeforeReceipt = accountingById.get("owner-recovery-before-receipt")?.facts;
  const recoveredAfterReceipt = accountingById.get("owner-recovery-after-receipt")?.facts;
  const settledGrant = accountingById.get("settled-grant-immutable")?.facts;
  const accountingSafe = focused.exitCode === 0 && accounting?.probes?.length === 8 &&
    usage?.canonicalReceiptCount === 1 && usage?.measurementValues?.join(",") === "180" && usage?.protectedTokens === 50 &&
    usage?.actualTokenOccupancy === 180 && usage?.admissionFenced === true && usage?.firstAccepted === true && usage?.secondAccepted === false &&
    partialUsage?.inputTokensObserved === 8 && partialUsage?.outputTokensUnknown === true && partialUsage?.totalUsageUnknown === true && partialUsage?.retainedUnknownCharge === 100 &&
    activeUnion?.openedWindows === 1 && activeUnion?.ordinaryWindowCount === 1 && activeUnion?.measuredActiveMs > 0 && activeUnion?.occupiedActiveMs === activeUnion?.measuredActiveMs &&
    protectedAdmission?.protectedTokens === 50 && protectedAdmission?.ordinaryTokens === 50 && protectedAdmission?.overBudgetRejected === true &&
    protectedAdmission?.finalizationOverProtectedRejected === true && protectedAdmission?.committedReservations === 2 &&
    activeFence?.starts?.join(",") === "over" && activeFence?.grantAmount === 25 && activeFence?.knownCharge === 80 && activeFence?.overage === 55 &&
    activeFence?.protectedAmount === 50 && activeFence?.receiptBeforeEvidenceBeforeAcceptance === true && activeFence?.acceptanceBeforeSettlementBeforeFence === true &&
    activeFence?.laterAttemptReserved === false && activeFence?.laterAttemptStarted === false && activeFence?.admissionFenced === true &&
    recoveredBeforeReceipt?.ownerEpochChanged === true && recoveredBeforeReceipt?.activeWindowUnknownCharge === 1000 && recoveredBeforeReceipt?.tokenUnknownCharge === 100 &&
    recoveredBeforeReceipt?.missingReceiptMeasurement === true && recoveredBeforeReceipt?.independentWorkAccepted === true && recoveredBeforeReceipt?.recoveredWorkAccepted === false &&
    recoveredBeforeReceipt?.measuredActiveMs === 0 && recoveredBeforeReceipt?.replayStable === true &&
    recoveredAfterReceipt?.ownerEpochChanged === true && recoveredAfterReceipt?.activeWindowUnknownCharge === 1000 && recoveredAfterReceipt?.tokenUnknownCharge === 100 &&
    recoveredAfterReceipt?.missingReceiptMeasurement === true && recoveredAfterReceipt?.independentWorkAccepted === true && recoveredAfterReceipt?.recoveredWorkAccepted === true &&
    recoveredAfterReceipt?.measuredActiveMs === 0 && recoveredAfterReceipt?.replayStable === true &&
    settledGrant?.settlementReplayIdempotent === true && settledGrant?.grantLimitAdjustmentRejected === true && settledGrant?.wrongIdentityRejected === true &&
    settledGrant?.adjustmentRejected === true && settledGrant?.newReservationRejected === true && settledGrant?.settledAmount === 40 &&
    settledGrant?.protectedTokens === 50 && settledGrant?.versionUnchangedAfterRejectedAdjustment === true;
  const writer = nodeById.get("writer-reservation-lifecycle")?.facts;
  const ownerReplay = nodeById.get("owner-and-causal-replay")?.facts;
  const reservationReplay = nodeById.get("reservation-settlement-replay")?.facts;
  const writerSafe = nodeReplay.exitCode === 0 && nodeRows?.every((entry) => entry.assertionsPassed === true) &&
    writer?.live?.holderPid !== writer?.live?.probePid && writer?.live?.writeError?.includes("read-only") &&
    writer?.release?.message?.released === true && writer?.release?.ownerEpoch > 1 && writer?.crash?.exitCode === 86 && writer?.crash?.ownerEpoch > 1 &&
    ownerReplay?.secondWriter?.error?.includes("read-only") && ownerReplay?.secondMission?.error?.includes("read-only") &&
    ownerReplay?.measurement?.count === 1 && Boolean(ownerReplay?.measurement?.conflictError) &&
    reservationReplay?.originalGrant === 10 && reservationReplay?.actualCharge === 15 && reservationReplay?.preservedDebt === 5 &&
    reservationReplay?.occupiedCapacity === 15 && reservationReplay?.admissionFence === true && reservationReplay?.sameProjectionHash === true && reservationReplay?.sameReservations === true;
  const readOnlySafe = sdk?.outboundFetchCount === 0 && sdk?.workspaceBeforeHash === sdk?.workspaceAfterHash &&
    sdkProviderTrace.length === 2 && sdkProviderTrace.every((trace: any) => trace.provider === "pitako-mission-local" && trace.cost === 0);
  const baseCriteria = [
    { id: "persistent-pi-attempt-context", check: Boolean(sdkSafe), observed: sdk },
    { id: "dependency-frontier", check: Boolean(frontier), observed: sdk && { firstAcceptedSeq: sdk.acceptedFirstSeq, secondReservedSeq: sdk.secondReservedSeq, dispatchUnits: sdk.dispatchUnits, states: sdk.unitStates } },
    { id: "accepted-evidence-gating", check: callbacks?.falsePass?.evidenceVerdict === "fail" && callbacks?.falsePass?.unitStatus === "blocked", observed: callbacks?.falsePass },
    { id: "callback-receipt-reconciliation", check: callbacksSafe, observed: callbacks && { lost: callbacks.lost, duplicate: callbacks.duplicate } },
    { id: "budget-and-active-time", check: Boolean(accountingSafe), observed: accounting?.probes },
    { id: "writer-reservation-continuity", check: Boolean(writerSafe), observed: { writer, ownerReplay } },
    { id: "read-only-no-paid-provider", check: Boolean(readOnlySafe), observed: sdk && { outboundFetchCount: sdk.outboundFetchCount, workspaceBeforeHash: sdk.workspaceBeforeHash, workspaceAfterHash: sdk.workspaceAfterHash, providerTrace: sdk.providerTrace } },
    { id: "t2-validation-gates", check: focused.exitCode === 0 && agentTests.exitCode === 0 && typecheck.exitCode === 0 && nodeReplay.exitCode === 0, observed: commands.map(({ id, exitCode }) => ({ id, exitCode })) },
  ];
  const observation = {
    format: "mission-t2-observations-v2",
    facts: { sdk, callbacks, accountingProbes: accounting?.probes, nodeReplayObservations: nodeRows },
    mappedCriteria: baseCriteria.map(({ id, observed }) => ({ id, observed: observed !== undefined, artifacts: T2_CRITERIA.find((item) => item.id === id)?.artifacts.filter((name) => name !== "t2-observations.json") })),
    commands: commands.map(({ id, command, args, exitCode, logPath, observationPath }) => ({ id, command, args, exitCode, logPath, observationPath })),
  };
  persistFile(path.join(runDir, "t2-observations.json"), JSON.stringify(observation, null, 2) + "\n");
  if (sdk) {
    const eventRows = [...(sdk.events ?? []), ...(callbacks?.events ?? [])];
    persistFile(path.join(runDir, "t2-events.json"), JSON.stringify(eventRows, null, 2) + "\n");
  }
  const criteria = baseCriteria.map(({ id, check, observed }) => makeCriterion(evidenceDir, runDir, T2_CRITERIA.find((item) => item.id === id)!, check, observed));
  const evidenceMap = readJson(path.join(runDir, "t2-observations.json")) as Record<string, any> | undefined;
  const evidenceMappingValid = Boolean(evidenceMap?.mappedCriteria?.length === 8 && evidenceMap.mappedCriteria.every((mapping: any) =>
    mapping.observed === true && mapping.artifacts?.length > 0 && mapping.artifacts.every((name: string) => {
      const file = path.join(runDir, name);
      return existsSync(file) && statSync(file).isFile() && /^[a-f0-9]{64}$/.test(sha256(readFileSync(file)));
    })));
  criteria.push(makeCriterion(evidenceDir, runDir, T2_CRITERIA.at(-1)!, evidenceMappingValid, {
    mappedCriteria: evidenceMap?.mappedCriteria, observationHash: existsSync(path.join(runDir, "t2-observations.json")) ? sha256(readFileSync(path.join(runDir, "t2-observations.json"))) : undefined,
  }));
  const status = stageStatus(criteria);
  const failed = criteria.filter(({ status: value }) => value !== "pass").map(({ id, status: value }) => `${id}:${value}`);
  persistManifest(evidenceDir, buildManifest("T2", status, commands, criteria, failed.length ? `T2 evidence incomplete or failed: ${failed.join(", ")}` : undefined, runDir, evidenceDir));
  console.log(`verify:mission T2 ${status}: ${path.join(evidenceDir, "verification-manifest.json")}`);
  if (status !== "pass") process.exitCode = 1;
}

async function runT2SdkScenario(runDir: string): Promise<Record<string, any>> {
  const fixture = createMissionFixture("pitako-t2-sdk-stage-");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let engine: MissionEngine | undefined;
  let providerGlobal: string | undefined;
  const originalFetch = globalThis.fetch;
  let outboundFetchCount = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => { outboundFetchCount += 1; return originalFetch(...args); }) as typeof fetch;
  try {
    const agentDir = path.join(fixture.base, "agent");
    const config = path.join(agentDir, "pitako", "config.toml");
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, "");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const definition = missionDefinition();
    const sourceUnit = definition.units[0]!;
    const makeUnit = (id: string, dependencies: string[]) => ({
      ...sourceUnit, id, dependencies, outputs: [`${id}.result`],
      acceptance: [{ id: `${id}-check`, kind: "manual" as const, target: `oracle:${id}` }],
    });
    definition.units = [makeUnit("first", []), makeUnit("second", ["first"])];
    definition.finalization.requiredPredicates = ["first-check", "second-check"];
    definition.budget = { roleLaunches: 8, providerRequests: 12, tokens: 1200, activeTimeMs: 120000, artifactBytes: 1_048_576 };
    definition.authority.rolePolicies = { developer: { hash: "a".repeat(64), provider: "pitako-mission-local", model: "fixture", fallbacks: [] } };
    fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(fixture.definitionFile, fixture.definitionBytes);
    store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    const provider = await installMissionLocalProvider({ agentDir });
    providerGlobal = `__${provider.provider.replace(/\W/g, "_")}`;
    const runner = createPiMissionRunner({
      cwd: fixture.root, executor: createPiExecutor(), load: { env: { PI_CODING_AGENT_DIR: agentDir }, userConfigPath: config },
    });
    const dispatchUnits: string[] = [];
    const engineRunner = async (input: Parameters<typeof runner>[0], context: Parameters<typeof runner>[1]) => {
      dispatchUnits.push(input.unit.id);
      return runner(input, context);
    };
    const workspaceBeforeHash = hashWorkspace(fixture.root);
    engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(fixture.stateDir, "pitako", "sessions"), runRole: engineRunner,
      assessPredicate: ({ predicate, resultArtifact }) => ({ verdict: resultArtifact.length ? "pass" : "fail", method: `host fixture check ${predicate.target}` }),
    });
    engine.start();
    await engine.waitForIdle();
    const snapshot = engine.snapshot();
    const inspection = store.inspectMission(mission.id);
    provider.flush(path.join(runDir, "t2-local-provider-trace.json"));
    const providerTrace = provider.trace;
    const providerReceipts = inspection.events.filter(({ kind }) => kind === "provider.request.receipt").map(({ payload }) => ({
      provider: payload.provider, model: payload.model, inputTokens: payload.inputTokens, outputTokens: payload.outputTokens,
    }));
    const acceptedFirstSeq = inspection.events.find(({ kind, unitId }) => kind === "unit.accepted" && unitId === "first")?.seq;
    const secondReservedSeq = inspection.events.find(({ kind, unitId }) => kind === "attempt.reserved" && unitId === "second")?.seq;
    const sessions = Object.values(snapshot.attempts).map((attempt) => {
      const directory = path.join(fixture.stateDir, "pitako", "sessions", mission.id, attempt.binding.attemptId);
      const name = readdirSync(directory).find((entry) => entry.endsWith(`_${attempt.binding.attemptId}.jsonl`));
      if (!name) return { unitId: attempt.binding.unitId, attemptId: attempt.binding.attemptId, persisted: false };
      const source = path.join(directory, name);
      const text = readFileSync(source, "utf8");
      const outputName = attempt.binding.unitId === "first" ? "first.jsonl" : "second.jsonl";
      const destination = path.join(runDir, "t2-sessions", outputName);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      return {
        unitId: attempt.binding.unitId, attemptId: attempt.binding.attemptId, sessionId: name.slice(0, -".jsonl".length),
        persisted: true, insideMissionSessionRoot: path.resolve(source).startsWith(path.resolve(fixture.stateDir, "pitako", "sessions") + path.sep),
        sha256: sha256(readFileSync(destination)), containsProviderResponse: text.includes("Local fixture response"),
        selectedModel: (attempt.receipt?.model as Record<string, unknown> | undefined)?.selectedModel,
      };
    }).sort((a, b) => a.unitId.localeCompare(b.unitId));
    const workspaceAfterHash = hashWorkspace(fixture.root);
    const result = {
      missionId: mission.id, unitStates: Object.fromEntries(Object.entries(snapshot.units).map(([id, unit]) => [id, unit.status])),
      canFinalize: snapshot.canFinalize, dispatchUnits, acceptedFirstSeq, secondReservedSeq,
      attempts: Object.values(snapshot.attempts).map((attempt) => ({
        unitId: attempt.binding.unitId, attemptId: attempt.binding.attemptId, status: attempt.status,
        selectedModel: (attempt.receipt?.model as Record<string, unknown> | undefined)?.selectedModel,
      })),
      providerTrace, providerReceipts, sessions, outboundFetchCount, workspaceBeforeHash, workspaceAfterHash,
      events: inspection.events.map(({ seq, kind, unitId, attemptId, payload }) => ({ seq, kind, unitId, attemptId, payload })),
    };
    persistFile(path.join(runDir, "t2-session-manifest.json"), JSON.stringify({ format: "mission-t2-session-manifest-v1", missionId: mission.id, sessions }, null, 2) + "\n");
    return result;
  } finally {
    await engine?.close();
    store?.close();
    globalThis.fetch = originalFetch;
    if (providerGlobal) delete (globalThis as Record<string, unknown>)[providerGlobal];
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    rmSync(fixture.base, { recursive: true, force: true });
  }
}

async function runT2CallbackScenarios(runDir: string): Promise<Record<string, any>> {
  const eventRows: Array<Record<string, any>> = [];
  const workerResult = (text: string): AgentRunResult => ({
    instanceId: "stage-worker", role: "developer", status: "completed",
    model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
    result: text, usage: { input: 1, output: 1, turns: 1, toolCalls: 0 },
  });
  const createUnit = (id: string, dependencies: string[] = []) => ({
    id, dependencies, kind: "consultation" as const, role: "developer", inputs: [], outputs: [`${id}.result`],
    acceptance: [{ id: `${id}-check`, kind: "manual" as const, target: `oracle:${id}` }], risk: "low" as const, retryLimit: 0,
  });
  const execute = async (name: string, units: ReturnType<typeof createUnit>[], runRole: (unitId: string, context: Parameters<NonNullable<ConstructorParameters<typeof MissionEngine>[0]["runRole"]>>[1]) => Promise<AgentRunResult>, assessPredicate?: ConstructorParameters<typeof MissionEngine>[0]["assessPredicate"]) => {
    const fixture = createMissionFixture(`pitako-t2-${name}-`);
    let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
    let engine: MissionEngine | undefined;
    try {
      const definition = missionDefinition();
      definition.units = units;
      definition.budget = { roleLaunches: 8, providerRequests: 12, tokens: 1200, activeTimeMs: 120000, artifactBytes: 1_048_576 };
      definition.finalization.requiredPredicates = units.flatMap(({ acceptance }) => acceptance.map(({ id }) => id));
      fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
      writeFileSync(fixture.definitionFile, fixture.definitionBytes);
      store = await openFixtureStore(fixture);
      const mission = store.createMission(missionInput(fixture));
      const starts: string[] = [];
      engine = new MissionEngine({
        store, missionId: mission.id, sessionsDirectory: path.join(fixture.stateDir, "sessions"),
        runRole: (input, context) => { starts.push(input.unit.id); return runRole(input.unit.id, context); },
        assessPredicate: assessPredicate ?? (() => ({ verdict: "pass", method: "host fixture observation" })),
        maxConcurrent: 1,
      });
      engine.start();
      await engine.waitForIdle();
      const inspection = store.inspectMission(mission.id);
      const state = engine.snapshot();
      const receipts = inspection.events.filter(({ kind }) => kind === "attempt.receipt");
      const receiptResults = receipts.map(({ payload }) => {
        const hash = String(payload.artifactHash ?? "");
        return { artifactHash: hash, result: hash ? store!.readArtifact(hash).toString("utf8") : undefined };
      });
      eventRows.push(...inspection.events.map(({ seq, kind, unitId, attemptId, payload }) => ({ scenario: name, seq, kind, unitId, attemptId, payload })));
      return { missionId: mission.id, starts, receiptCount: receipts.length, receiptResults, unitStates: Object.fromEntries(Object.entries(state.units).map(([id, unit]) => [id, unit.status])), canFinalize: state.canFinalize, events: inspection.events };
    } finally {
      await engine?.close();
      store?.close();
      rmSync(fixture.base, { recursive: true, force: true });
    }
  };

  const lost = await execute("lost-callback", [createUnit("lost"), createUnit("dependent", ["lost"])], async (_unitId) => workerResult("lost callback returned result"));
  const duplicate = await execute("duplicate-callback", [createUnit("duplicate")], async (_unitId, context) => {
    context.onOutcome?.(workerResult("first callback"));
    context.onOutcome?.(workerResult("conflicting duplicate callback"));
    return workerResult("runner return wins");
  });
  const falseArtifact = path.join(runDir, "t2-host-artifact.txt");
  writeFileSync(falseArtifact, "FAIL\n");
  const actual = readFileSync(falseArtifact);
  const actualHash = sha256(actual);
  const falsePass = await execute("false-pass", [createUnit("claim")], async (_unitId, context) => {
    const claimed = workerResult("PASS");
    context.onOutcome?.(claimed);
    return claimed;
  }, ({ predicate }) => ({
    verdict: readFileSync(falseArtifact, "utf8").trim() === "PASS" ? "pass" : "fail",
    method: `read host artifact ${predicate.target}`, artifactHash: actualHash, artifactBytes: actual, artifactMediaType: "text/plain; charset=utf-8",
  }));
  const summarize = (row: Record<string, any>) => ({
    missionId: row.missionId, starts: row.starts, receiptCount: row.receiptCount, unitStates: row.unitStates,
    unitStatus: Object.values(row.unitStates).includes("blocked") ? "blocked" : Object.values(row.unitStates).every((status) => status === "accepted") ? "accepted" : "other",
    canFinalize: row.canFinalize,
    evidenceVerdict: row.events.find((event: any) => event.kind === "evidence.recorded")?.payload.verdict,
    evidenceArtifactHash: row.events.find((event: any) => event.kind === "evidence.recorded")?.payload.artifactHash,
    workerArtifactHash: row.receiptResults?.[0]?.artifactHash,
    workerClaim: row.receiptResults?.[0]?.result,
  });
  const result = {
    lost: summarize(lost),
    duplicate: { ...summarize(duplicate), startCount: duplicate.starts.length },
    falsePass: { ...summarize(falsePass), hostArtifact: readFileSync(falseArtifact, "utf8").trim(), hostArtifactHash: actualHash },
    events: eventRows,
  };
  persistFile(path.join(runDir, "t2-callback-observed.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

function hashWorkspace(root: string): string {
  return sha256(Buffer.from(JSON.stringify(captureWorkspacePaths(root))));
}

async function verifyT3Stage(runDir: string, evidenceDir: string, commands: CommandResult[]): Promise<void> {
  const focused = runCommand(runDir, evidenceDir, commands, "focused-tests", "bun", ["test",
    "tests/mission-model.test.ts", "tests/mission-store.test.ts", "tests/workflow.test.ts", "tests/execution-binding.test.ts",
    "tests/mission-accounting.test.ts", "tests/mission-engine.test.ts", "tests/mission-runner.test.ts", "tests/agent-pi.test.ts",
    "tests/mission-effects.test.ts", "tests/mission-workspace.test.ts"], { MISSION_T3_ARTIFACT_DIR: runDir });
  const effectsTests = runCommand(runDir, evidenceDir, commands, "t3-effects-tests", "bun", ["test", "tests/mission-effects.test.ts"], { MISSION_T3_ARTIFACT_DIR: runDir });
  const agentPiTests = runCommand(runDir, evidenceDir, commands, "t3-agent-pi-tests", "bun", ["test", "tests/agent-pi.test.ts"]);
  const typecheck = runCommand(runDir, evidenceDir, commands, "t3-typecheck", "bun", ["run", "typecheck"]);
  const nodePath = path.join(runDir, "t3-node-crash-observed.json");
  const nodeSuite = runCommand(runDir, evidenceDir, commands, "t3-node-crash-suite", "node", ["--test", "scripts/mission-durability-node.mjs"], {
    MISSION_DURABILITY_OBSERVATION_PATH: nodePath,
  }, nodePath);
  let contained: Record<string, any> | undefined;
  let containmentError: string | undefined;
  let crashes: Record<string, any> | undefined;
  let crashError: string | undefined;
  let reload: Record<string, any> | undefined;
  let reloadError: string | undefined;
  let cleanRelease: Record<string, any> | undefined;
  try {
    contained = await runT3ContainedScenario(runDir);
    commands.push({ id: "t3-live-containment", command: "verify-mission.ts T3 live bwrap and shutdown scenario", args: [], environment: {}, exitCode: 0, logPath: rel(evidenceDir, path.join(runDir, "t3-contained-shutdown-observed.json")) });
  } catch (error) {
    containmentError = errorMessage(error);
    persistFile(path.join(runDir, "t3-containment-error.log"), `${containmentError}\n`);
    commands.push({ id: "t3-live-containment", command: "verify-mission.ts T3 live bwrap and shutdown scenario", args: [], environment: {}, exitCode: 1, logPath: rel(evidenceDir, path.join(runDir, "t3-containment-error.log")) });
  }
  try {
    crashes = await runT3CrashBoundaries(runDir);
    commands.push({ id: "t3-crash-boundaries", command: "verify-mission.ts T3 crash-boundary scenarios", args: [], environment: {}, exitCode: 0, logPath: rel(evidenceDir, path.join(runDir, "t3-crash-boundaries-observed.json")) });
  } catch (error) {
    crashError = errorMessage(error);
    persistFile(path.join(runDir, "t3-crash-error.log"), `${crashError}\n`);
    commands.push({ id: "t3-crash-boundaries", command: "verify-mission.ts T3 crash-boundary scenarios", args: [], environment: {}, exitCode: 1, logPath: rel(evidenceDir, path.join(runDir, "t3-crash-error.log")) });
  }
  try {
    reload = await runT3ReloadScenario();
    persistFile(path.join(runDir, "t3-reload-observed.json"), JSON.stringify(reload, null, 2) + "\n");
    commands.push({ id: "t3-pi-reload", command: "verify-mission.ts T3 real Pi reload scenario", args: [], environment: {}, exitCode: 0, logPath: rel(evidenceDir, path.join(runDir, "t3-reload-observed.json")) });
  } catch (error) {
    reloadError = errorMessage(error);
    persistFile(path.join(runDir, "t3-reload-error.log"), `${reloadError}\n`);
    commands.push({ id: "t3-pi-reload", command: "verify-mission.ts T3 real Pi reload scenario", args: [], environment: {}, exitCode: 1, logPath: rel(evidenceDir, path.join(runDir, "t3-reload-error.log")) });
  }
  try {
    cleanRelease = await runT3CleanReleaseScenario();
    persistFile(path.join(runDir, "t3-clean-release-observed.json"), JSON.stringify(cleanRelease, null, 2) + "\n");
    commands.push({ id: "t3-clean-owner-release", command: "verify-mission.ts T3 clean owner-release scenario", args: [], environment: {}, exitCode: 0, logPath: rel(evidenceDir, path.join(runDir, "t3-clean-release-observed.json")) });
  } catch (error) {
    persistFile(path.join(runDir, "t3-clean-release-error.log"), `${errorMessage(error)}\n`);
    commands.push({ id: "t3-clean-owner-release", command: "verify-mission.ts T3 clean owner-release scenario", args: [], environment: {}, exitCode: 1, logPath: rel(evidenceDir, path.join(runDir, "t3-clean-release-error.log")) });
  }

  const nodeRows = readJson(nodePath) as Array<Record<string, any>> | undefined;
  const nodeById = new Map((Array.isArray(nodeRows) ? nodeRows : []).map((entry) => [entry.id, entry]));
  const settlement = nodeById.get("effect-settlement:unknown-then-receipt")?.facts;
  const invoking = nodeById.get("effect-settlement:invoking-without-identity")?.facts;
  const settlementSafe = nodeSuite.exitCode === 0 && settlement?.assessments === 0 && settlement?.evidenceRecorded === false &&
    settlement?.unitAccepted === false && settlement?.unitStatus === "blocked" &&
    invoking?.assessments === 0 && invoking?.evidenceRecorded === false && invoking?.unitAccepted === false && invoking?.unitStatus === "blocked";
  const crashCutsSafe = crashes?.cases?.length === 5 && crashes.cases.every((entry: any) => entry.exitSignal === "SIGKILL" &&
    entry.ownerProof === "owner-death" && entry.sourceHashBefore === entry.sourceHashAfter && !entry.effectKinds.includes("effect.receipt")) &&
    crashes.cases.some((entry: any) => entry.cut === "effect.receipt" && entry.candidateStarted === true && entry.candidateFinished === true);
  const containmentSafe = contained?.candidateIndependence?.sourceHash === contained?.candidateIndependence?.candidateHash &&
    contained?.candidateIndependence?.distinctFileIdentity === true && contained?.candidateIndependence?.distinctGitDirectories === true &&
    contained?.containmentProof?.networkDisabled === true && contained?.containmentProof?.sourceReadOnly === true &&
    contained?.containmentProof?.storeReadOnly === true && contained?.containmentProof?.candidateGitReadOnly === true &&
    contained?.sentinels?.length >= 6 && contained.sentinels.every((entry: any) => entry.unchanged === true && entry.beforeHash === entry.afterHash) &&
    ["bash", "write", "edit", "apply_patch"].every((operation) => contained?.adapterStatuses?.[operation] === "completed") &&
    contained?.adapterOutputs?.edit === "after edit\n" && contained?.adapterOutputs?.apply_patch === "patched\n" &&
    contained?.checks?.includes("source-read-only") && contained?.checks?.includes("source-git-read-only") &&
    contained?.checks?.includes("store-read-only") && contained?.checks?.includes("product-read-only") &&
    contained?.checks?.includes("other-candidate-read-only") && contained?.checks?.includes("candidate-git-read-only") &&
    contained?.checks?.includes("network-disabled") && contained?.process?.networkProbe?.connectionsFromContained === 0 &&
    contained?.candidateWrite === "contained write\n" && contained?.denial?.status === "denied" && contained?.denial?.event === true && contained?.denial?.launchedProcess === false;
  const processSafe = contained?.process?.registeredIdentity?.ancestry?.some((entry: any) => entry.parentPid === contained.process.registeredIdentity.pid) === true &&
    contained?.process?.namespaceEmptyAfterExit === true && contained?.process?.remainingNamespaceProcessesAfterExit === 0 &&
    contained?.process?.activeNamespaceInventory?.length > 0 && contained?.shutdown?.requestedWhileEffectActive === true &&
    contained?.shutdown?.effectsQuiescentBefore === false && contained?.shutdown?.effectsQuiescentAfter === true &&
    contained?.shutdown?.namespaceEmptyAfterShutdown === true && contained?.shutdown?.receiptStatus === "failed" && contained?.shutdown?.lateWriterObserved === false;
  const reloadSafe = reload?.release?.effectsQuiescent === true && reload?.release?.reason === "reload" &&
    reload?.oldOwnerPid === reload?.release?.ownerPid && reload?.newOwnerEpoch > reload?.oldOwnerEpoch &&
    reload?.sourceHashBefore === reload?.sourceHashAfter && reload?.lateResultEventCountUnchanged === true &&
    reload?.lateAttemptReceiptCreated === false && reload?.lateUnitAccepted === false;
  const regressionLogs = [
    { id: "t1-regression", stage: "T1" as const, directory: path.join(runDir, "t1-regression-evidence") },
    { id: "t2-regression", stage: "T2" as const, directory: path.join(runDir, "t2-regression-evidence") },
  ];
  for (const regression of regressionLogs) {
    const result = runCommand(runDir, evidenceDir, commands, regression.id, "bun", ["run", "verify:mission", "--", regression.stage, "--evidence-dir", regression.directory]);
    persistFile(path.join(runDir, `${regression.id}.log`), `exitCode=${result.exitCode}\n${result.logPath}\n`);
  }
  const t1Manifest = readJson(path.join(runDir, "t1-regression-evidence", "verification-manifest.json")) as Record<string, any> | undefined;
  const t2Manifest = readJson(path.join(runDir, "t2-regression-evidence", "verification-manifest.json")) as Record<string, any> | undefined;
  const regressionsSafe = t1Manifest?.status === "pass" && t1Manifest.criteria?.some((item: any) => item.id === "single-writer-reservation" && item.status === "pass") &&
    t1Manifest.criteria?.some((item: any) => item.id === "generated-ledger-authority" && item.status === "pass") &&
    t2Manifest?.status === "pass" && t2Manifest.criteria?.length === 9 &&
    t2Manifest.criteria?.some((item: any) => item.id === "callback-receipt-reconciliation" && item.status === "pass");

  const containmentCheck = contained ? containmentSafe : isContainmentInconclusive(containmentError) ? undefined : false;
  const processCheck = contained ? processSafe : isContainmentInconclusive(containmentError) ? undefined : false;
  const crashCheck = crashes ? crashCutsSafe : isContainmentInconclusive(crashError) ? undefined : false;
  const reloadCheck = reload ? reloadSafe : isContainmentInconclusive(reloadError) ? undefined : false;
  const cleanReleaseSafe = cleanRelease?.release?.reason === "clean-session-close" && cleanRelease?.release?.effectsQuiescent === true &&
    cleanRelease?.release?.resumablePause === true && cleanRelease?.release?.ownerPid === cleanRelease?.oldOwnerPid &&
    cleanRelease?.release?.ownerEpoch === cleanRelease?.oldOwnerEpoch && cleanRelease?.newOwnerEpoch > cleanRelease?.oldOwnerEpoch &&
    cleanRelease?.release?.interruptedAttempts?.length === 0;
  const evaluations = [
    { id: "managed-candidate-containment", check: containmentCheck, observed: contained ? { candidateIndependence: contained.candidateIndependence, containmentProof: contained.containmentProof, sentinels: contained.sentinels, candidateRoot: contained.candidateRoot } : { error: containmentError } },
    { id: "fenced-adapters-and-denials", check: combineChecks(containmentCheck, effectsTests.exitCode === 0, agentPiTests.exitCode === 0), observed: contained && { adapterStatuses: contained.adapterStatuses, denial: contained.denial, commandExits: { effects: effectsTests.exitCode, agentPi: agentPiTests.exitCode } } },
    { id: "durable-crash-boundaries", check: combineChecks(crashCheck, nodeSuite.exitCode === 0 && crashCutsSafe), observed: { cases: crashes?.cases, error: crashError, nodeSuiteExit: nodeSuite.exitCode } },
    { id: "effect-settlement-safety", check: Boolean(settlementSafe), observed: { unknownThenReceipt: settlement, invokingWithoutIdentity: invoking } },
    { id: "partial-effects-and-quiescence", check: processCheck, observed: contained ? { process: contained.process, shutdown: contained.shutdown } : { error: containmentError } },
    { id: "pi-reload-owner-fencing", check: combineChecks(reloadCheck, processCheck), observed: { reload, reloadError, activeEffectShutdown: contained?.shutdown } },
    { id: "t1-t2-regressions", check: regressionsSafe && typecheck.exitCode === 0, observed: { t1: t1Manifest?.criteria?.map((item: any) => ({ id: item.id, status: item.status })), t2: t2Manifest?.criteria?.map((item: any) => ({ id: item.id, status: item.status })) } },
    { id: "full-t3-plan-acceptance", check: combineChecks(cleanReleaseSafe, containmentCheck, crashCheck, processCheck, reloadCheck), observed: { cleanRelease, contained, crashes, reload, containmentError, crashError, reloadError } },
  ];
  const criteria = evaluations.map(({ id, check, observed }) => makeCriterion(evidenceDir, runDir, T3_CRITERIA.find((item) => item.id === id)!, check, observed));
  const status = stageStatus(criteria);
  const failed = criteria.filter(({ status: value }) => value !== "pass").map(({ id, status: value }) => `${id}:${value}`);
  persistManifest(evidenceDir, buildManifest("T3", status, commands, criteria, failed.length ? `T3 evidence incomplete or failed: ${failed.join(", ")}` : undefined, runDir, evidenceDir));
  console.log(`verify:mission T3 ${status}: ${path.join(evidenceDir, "verification-manifest.json")}`);
  if (status !== "pass") process.exitCode = 1;
}

async function runT3CleanReleaseScenario(): Promise<Record<string, any>> {
  const fixture = createMissionFixture("pitako-t3-clean-release-stage-");
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let reopened: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let engine: MissionEngine | undefined;
  try {
    store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    const oldOwnerEpoch = store.ownerEpoch;
    if (oldOwnerEpoch === null) throw new Error("clean-release fixture lacks writer ownership");
    engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(fixture.stateDir, "sessions"),
      runRole: async () => { throw new Error("clean owner release must not launch a worker"); },
    });
    await engine.retireForShutdown("clean-session-close");
    store = undefined;
    reopened = await openFixtureStore(fixture);
    const inspection = reopened.inspectMission(mission.id);
    const event = inspection.events.find(({ kind }) => kind === "mission.owner.released");
    const payload = event?.payload as Record<string, any> | undefined;
    return {
      missionId: mission.id, oldOwnerPid: process.pid, oldOwnerEpoch, newOwnerEpoch: reopened.ownerEpoch,
      release: {
        reason: payload?.reason, ownerPid: payload?.owner?.pid, ownerEpoch: payload?.owner?.epoch,
        effectsQuiescent: payload?.effectsQuiescent, resumablePause: payload?.resumablePause,
        interruptedAttempts: payload?.interruptedAttempts,
      },
      eventSeq: event?.seq, eventCount: inspection.events.length, ownerAcquisitionProof: reopened.ownerAcquisitionProof,
    };
  } finally {
    await engine?.retireForShutdown("clean-release verifier cleanup").catch(() => {});
    reopened?.close(); store?.close();
    rmSync(fixture.base, { recursive: true, force: true });
  }
}

async function runT3ContainedScenario(runDir: string): Promise<Record<string, any>> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) || !existsSync("/usr/bin/bwrap")) {
    throw new Error("inconclusive: T3 live containment requires Linux, supported architecture, and /usr/bin/bwrap");
  }
  const fixture = createMissionFixture("pitako-t3-contained-stage-");
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let server: net.Server | undefined;
  let effects: MissionEffects | undefined;
  let activeEffects: MissionEffects | undefined;
  try {
    const sourcePath = path.join(fixture.root, "src", "target.txt");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "source sentinel\n");
    execFileSync("git", ["add", "src/target.txt"], { cwd: fixture.root, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "T3 containment", "-q"], { cwd: fixture.root, stdio: "ignore" });
    const definition = missionDefinition();
    definition.authority.allowedPaths = ["src/**"];
    definition.authority.operations = ["bash", "write", "edit", "apply_patch"];
    fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(fixture.definitionFile, fixture.definitionBytes);
    store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    const storeSentinel = path.join(store.storageRoot, "t3-sentinel.txt");
    const productRoot = packageRoot();
    const productSentinel = path.join(productRoot, "extensions/mission/sandbox-adapter.mjs");
    const otherCandidate = path.join(fixture.base, "other-candidate");
    const otherSentinel = path.join(otherCandidate, "sentinel.txt");
    mkdirSync(otherCandidate, { recursive: true });
    writeFileSync(storeSentinel, "store sentinel\n");
    writeFileSync(otherSentinel, "other candidate sentinel\n");
    const attemptId = randomUUID();
    const workspace = createMissionWorkspace({
      missionId: mission.id, attemptId, sourceRoot: fixture.root, storeRoot: store.storageRoot,
      candidateParent: path.join(fixture.stateDir, "pitako-candidates"), otherCandidates: [otherCandidate],
      allowedPaths: ["src/**"], productRoot,
    });
    await preflightContainment(workspace);
    const candidateSentinel = path.join(workspace.candidateGitDir, "config");
    const candidateSourcePath = path.join(workspace.candidateRoot, "src", "target.txt");
    const sourceFileStat = statSync(sourcePath);
    const candidateFileStat = statSync(candidateSourcePath);
    const candidateIndependence = {
      sourceHash: sha256(readFileSync(sourcePath)), candidateHash: sha256(readFileSync(candidateSourcePath)),
      sourceFileIdentity: `${sourceFileStat.dev}:${sourceFileStat.ino}`, candidateFileIdentity: `${candidateFileStat.dev}:${candidateFileStat.ino}`,
      distinctFileIdentity: sourceFileStat.dev !== candidateFileStat.dev || sourceFileStat.ino !== candidateFileStat.ino,
      sourceGitDir: workspace.sourceGitDir, candidateGitDir: workspace.candidateGitDir,
      distinctGitDirectories: workspace.sourceGitDir !== workspace.candidateGitDir,
    };
    const sentinelFiles = [sourcePath, path.join(workspace.sourceGitDir, "index"), storeSentinel, productSentinel, otherSentinel, candidateSentinel];
    const sentinels = sentinelFiles.map((file) => ({ path: path.relative(fixture.base, file), beforeHash: sha256(readFileSync(file)) }));
    let connectionsFromContained = 0;
    server = net.createServer((socket) => { connectionsFromContained += 1; socket.destroy(); });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as net.AddressInfo).port;
    const ownerEpoch = store.ownerEpoch;
    if (ownerEpoch === null) throw new Error("T3 containment fixture lacks writer ownership");
    effects = new MissionEffects({
      store, workspace, missionId: mission.id, revision: 1, unitId: "snapshot", attemptId,
      runtimeId: store.runtimeId, ownerEpoch, allowedOperations: definition.authority.operations,
    });
    const adapterWrite = await effects.invoke("write", { path: "src/adapter.txt", content: "before edit\n" });
    const adapterWriteOutput = readFileSync(path.join(workspace.candidateRoot, "src", "adapter.txt"), "utf8");
    const adapterEdit = await effects.invoke("edit", { path: "src/adapter.txt", oldText: "before edit", newText: "after edit" });
    const adapterEditOutput = readFileSync(path.join(workspace.candidateRoot, "src", "adapter.txt"), "utf8");
    const adapterPatch = await effects.invoke("apply_patch", { patch: "*** Begin Patch\n*** Add File: src/adapter-patch.txt\n+patched\n*** End Patch" });
    const command = [
      "printf 'contained write\\n' > /tmp/pitako/workspace/src/contained.txt",
      "if printf bad > /tmp/pitako/source/src/target.txt; then exit 81; else echo source-read-only; fi",
      "if printf bad > /tmp/pitako/source-git/index; then exit 82; else echo source-git-read-only; fi",
      "if printf bad > /tmp/pitako/store/t3-sentinel.txt; then exit 83; else echo store-read-only; fi",
      "if printf bad > /tmp/pitako/product/extensions/mission/sandbox-adapter.mjs; then exit 84; else echo product-read-only; fi",
      "if printf bad > /tmp/pitako/other-0/sentinel.txt; then exit 85; else echo other-candidate-read-only; fi",
      "if printf bad > /tmp/pitako/workspace/.git/t3-sentinel; then exit 86; else echo candidate-git-read-only; fi",
      "setsid /bin/bash -c 'printf started > /tmp/pitako/workspace/src/detached.started; sleep 30; printf late > /tmp/pitako/workspace/src/detached.late' </dev/null >/dev/null 2>&1 & true",
      "for attempt in {1..100}; do test -e /tmp/pitako/workspace/src/detached.started && break; sleep 0.01; done",
      "test -e /tmp/pitako/workspace/src/detached.started",
      `if /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}' 2>/dev/null; then echo network-open; exit 91; else echo network-disabled; fi`,
    ].join("; ");
    const receipt = await effects.invoke("bash", { command, timeoutMs: 15_000 });
    const eventRows = store.inspectMission(mission.id).events;
    const registration = eventRows.find(({ kind }) => kind === "effect.process.registered");
    const registeredIdentity = registration?.payload.identity as Record<string, any> | undefined;
    const output = String(receipt.stdout ?? "").split(/\r?\n/).filter(Boolean);
    const afterSentinels = sentinelFiles.map((file, index) => ({ ...sentinels[index]!, afterHash: sha256(readFileSync(file)) }));
    const registeredCountBeforeDenial = store.inspectMission(mission.id).events.filter(({ kind }) => kind === "effect.process.registered").length;
    const denial = await effects.invoke("powershell", { command: "unsafe" });
    const afterDenialEvents = store.inspectMission(mission.id).events;
    const denialEvent = afterDenialEvents.find(({ kind, payload }) => kind === "effect.denied" && payload.operation === "powershell");
    const registeredCountAfterDenial = afterDenialEvents.filter(({ kind }) => kind === "effect.process.registered").length;

    const shutdownAttemptId = randomUUID();
    const shutdownWorkspace = createMissionWorkspace({
      missionId: mission.id, attemptId: shutdownAttemptId, sourceRoot: fixture.root, storeRoot: store.storageRoot,
      candidateParent: path.join(fixture.stateDir, "shutdown-candidates"), otherCandidates: [workspace.candidateRoot, otherCandidate],
      allowedPaths: ["src/**"], productRoot,
    });
    await preflightContainment(shutdownWorkspace);
    activeEffects = new MissionEffects({
      store, workspace: shutdownWorkspace, missionId: mission.id, revision: 1, unitId: "snapshot", attemptId: shutdownAttemptId,
      runtimeId: store.runtimeId, ownerEpoch, allowedOperations: ["bash"],
    });
    const activeCommand = "printf active > /tmp/pitako/workspace/src/active.started; sleep 30; printf late > /tmp/pitako/workspace/src/active.late";
    const activeJob = activeEffects.invoke("bash", { command: activeCommand, timeoutMs: 60_000 });
    await waitFor(() => existsSync(path.join(shutdownWorkspace.candidateRoot, "src", "active.started")), 10_000);
    const activeEvents = store.inspectMission(mission.id).events;
    const activeIdentity = activeEvents.filter(({ kind, attemptId: id }) => kind === "effect.process.registered" && id === shutdownAttemptId)
      .at(-1)?.payload.identity as Record<string, any> | undefined;
    const activeNamespaceInventory = activeIdentity?.pidNamespace ? processesInNamespace(String(activeIdentity.pidNamespace)) : [];
    const effectsQuiescentBefore = activeEffects.quiescent;
    const requestedWhileEffectActive = !effectsQuiescentBefore && activeNamespaceInventory.length > 0;
    await activeEffects.shutdown();
    const activeReceipt = await activeJob;
    const namespaceEmptyAfterShutdown = !activeIdentity?.pidNamespace || processesInNamespace(String(activeIdentity.pidNamespace)).length === 0;
    const lateWriterObserved = existsSync(path.join(shutdownWorkspace.candidateRoot, "src", "active.late"));
    const activeFiles = captureWorkspacePaths(shutdownWorkspace.candidateRoot).filter(({ path: name }) => name.startsWith("src/active."));
    const observation = {
      schemaVersion: 1, missionId: mission.id, candidateRoot: workspace.candidateRoot, effectId: receipt.effectId,
      candidateIndependence, containmentProof: workspace.containmentProof,
      sentinels: afterSentinels.map(({ path: name, beforeHash, afterHash }) => ({ path: name, beforeHash, afterHash, unchanged: beforeHash === afterHash })),
      adapterStatuses: { bash: receipt.status, write: adapterWrite.status, edit: adapterEdit.status, apply_patch: adapterPatch.status },
      adapterOutputs: {
        write: adapterWriteOutput,
        edit: adapterEditOutput,
        apply_patch: readFileSync(path.join(workspace.candidateRoot, "src", "adapter-patch.txt"), "utf8"),
      },
      checks: output, candidateWrite: readFileSync(path.join(workspace.candidateRoot, "src", "contained.txt"), "utf8"),
      denial: { status: denial.status, event: Boolean(denialEvent), launchedProcess: registeredCountAfterDenial > registeredCountBeforeDenial },
      process: {
        registeredIdentity, registeredAncestry: registeredIdentity?.ancestry ?? [], activeNamespaceInventory,
        descendantsOfRegisteredLauncher: Array.isArray(registeredIdentity?.ancestry) && registeredIdentity.ancestry.some((item: any) => item.parentPid === registeredIdentity.pid),
        namespaceEmptyAfterExit: receipt.process?.namespaceEmptyAfterExit === true,
        remainingNamespaceProcessesAfterExit: registeredIdentity?.pidNamespace ? processesInNamespace(String(registeredIdentity.pidNamespace)).length : null,
        receiptProcess: receipt.process, receiptPaths: receipt.paths, networkProbe: { port, hostListenerReady: server.listening, connectionsFromContained },
      },
      shutdown: {
        requestedWhileEffectActive: requestedWhileEffectActive, effectsQuiescentBefore, effectsQuiescentAfter: activeEffects.quiescent,
        receiptStatus: activeReceipt.status, namespace: activeIdentity?.pidNamespace, namespaceEmptyAfterShutdown,
        lateWriterObserved, activeFiles,
      },
    };
    persistFile(path.join(runDir, "t3-contained-shutdown-observed.json"), JSON.stringify(observation, null, 2) + "\n");
    return observation;
  } finally {
    await activeEffects?.shutdown().catch(() => {});
    await effects?.shutdown().catch(() => {});
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    store?.close();
    rmSync(fixture.base, { recursive: true, force: true });
  }
}

async function runT3CrashBoundaries(runDir: string): Promise<Record<string, any>> {
  const nodeBin = execFileSync("/bin/sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
  const kinds = ["effect.intent", "effect.invoking", "effect.process.registered", "effect.released", "effect.receipt"];
  const cases: Array<Record<string, any>> = [];
  for (const cut of kinds) {
    const fixture = createMissionFixture(`pitako-t3-crash-${cut.replaceAll(".", "-")}-`);
    let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
    let reopened: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
    try {
      const sourceFile = path.join(fixture.root, "src", "target.txt");
      mkdirSync(path.dirname(sourceFile), { recursive: true });
      writeFileSync(sourceFile, "source sentinel\n");
      const sourceHashBefore = sha256(readFileSync(sourceFile));
      execFileSync("git", ["add", "src/target.txt"], { cwd: fixture.root, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "T3 crash", "-q"], { cwd: fixture.root, stdio: "ignore" });
      const definition = missionDefinition();
      definition.authority.allowedPaths = ["src/**"];
      definition.authority.operations = ["bash"];
      fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
      writeFileSync(fixture.definitionFile, fixture.definitionBytes);
      store = await openFixtureStore(fixture);
      const mission = store.createMission(missionInput(fixture));
      const ownerEpoch = store.ownerEpoch;
      if (ownerEpoch === null) throw new Error("T3 crash fixture lacks writer ownership");
      const inspection = store.inspectMission(mission.id);
      store.appendTransition(mission.id, inspection.version, { events: [{
        revision: inspection.revision, kind: "mission.owner.released", causalId: randomUUID(),
        payload: { owner: currentProcessIdentity(store.runtimeId, ownerEpoch), reason: "T3 crash fixture prepared", effectsQuiescent: true, resumablePause: false, interruptedAttempts: [] },
      }] });
      const storeRoot = store.storageRoot;
      store.close(); store = undefined;
      const attemptId = randomUUID();
      const eventLog = path.join(fixture.base, "effect-events.jsonl");
      const metadataFile = path.join(fixture.base, "candidate.json");
      const child = spawn(nodeBin, [path.resolve("tests/fixtures/mission-effect-crash-child.mjs")], {
        cwd: process.cwd(), stdio: "ignore", env: {
          ...process.env, T3_SOURCE: fixture.root, T3_STORE: storeRoot, T3_CANDIDATES: path.join(fixture.stateDir, "pitako-candidates"),
          T3_DB: fixture.dbPath, T3_OBJECTS: fixture.objectDir, T3_MISSION: mission.id, T3_ATTEMPT: attemptId,
          T3_LOG: eventLog, T3_META: metadataFile,
          ...(cut === "effect.receipt" ? { T3_CRASH_KIND: cut } : { T3_CRASH_AFTER_KIND: cut }),
          ...(cut === "effect.receipt" ? { T3_COMMAND: "printf started > /tmp/pitako/workspace/src/started; printf finished > /tmp/pitako/workspace/src/finished" } : {}),
        },
      });
      const exit = await waitForChild(child, 30_000);
      await waitFor(() => existsSync(metadataFile), 2_000);
      const { candidateRoot } = JSON.parse(readFileSync(metadataFile, "utf8")) as { candidateRoot: string };
      reopened = await openFixtureStore(fixture);
      const durableEvents = reopened.inspectMission(mission.id).events.filter(({ kind }) => kind.startsWith("effect."));
      const registered = durableEvents.find(({ kind }) => kind === "effect.process.registered")?.payload.identity as Record<string, any> | undefined;
      const namespaceRemaining = registered?.pidNamespace ? processesInNamespace(String(registered.pidNamespace)).length : 0;
      const sourceHashAfter = sha256(readFileSync(sourceFile));
      const candidateStarted = existsSync(path.join(candidateRoot, "src", "started"));
      const candidateFinished = existsSync(path.join(candidateRoot, "src", "finished"));
      const item = {
        cut, childPid: child.pid, exitSignal: exit.signal, exitCode: exit.code, ownerProof: reopened.ownerAcquisitionProof?.source,
        effectKinds: durableEvents.map(({ kind }) => kind), registeredIdentity: registered,
        namespaceRemaining, sourceHashBefore, sourceHashAfter, candidateRoot, candidateStarted, candidateFinished,
      };
      cases.push(item);
      reopened.close(); reopened = undefined;
    } finally {
      reopened?.close(); store?.close(); rmSync(fixture.base, { recursive: true, force: true });
    }
  }
  const observation = { format: "mission-t3-crash-boundaries-v1", cases };
  persistFile(path.join(runDir, "t3-crash-boundaries-observed.json"), JSON.stringify(observation, null, 2) + "\n");
  return observation;
}

async function runT3ReloadScenario(): Promise<Record<string, any>> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) || !existsSync("/usr/bin/bwrap")) {
    throw new Error("inconclusive: real Pi reload fencing requires Linux, supported architecture, and /usr/bin/bwrap");
  }
  const fixture = createMissionFixture("pitako-t3-reload-stage-");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let reopened: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let engine: MissionEngine | undefined;
  let releaseLate!: (value: AgentRunResult) => void;
  const late = new Promise<AgentRunResult>((resolve) => { releaseLate = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let markAborted!: () => void;
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  try {
    const sourceFile = path.join(fixture.root, "src", "sentinel.txt");
    mkdirSync(path.dirname(sourceFile), { recursive: true });
    writeFileSync(sourceFile, "source remains untouched\\n");
    execFileSync("git", ["add", "src/sentinel.txt"], { cwd: fixture.root, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "T3 reload", "-q"], { cwd: fixture.root, stdio: "ignore" });
    const sourceHashBefore = sha256(readFileSync(sourceFile));
    const definition = missionDefinition();
    definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: "fixture", model: "local", fallbacks: [] };
    definition.authority.allowedPaths = ["src/**"];
    definition.authority.operations = ["write"];
    definition.budget.artifactBytes = 3_000_000;
    fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(fixture.definitionFile, fixture.definitionBytes);
    store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    const initialEpoch = store.ownerEpoch;
    const loaded = await loadPitako(packageRoot(), fixture.root);
    process.env.PI_CODING_AGENT_DIR = loaded.agentDir;
    const runtime = await ModelRuntime.create({ authPath: path.join(loaded.agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    const sessionManager = SessionManager.inMemory(fixture.root);
    const opened = await createAgentSession({ cwd: fixture.root, agentDir: loaded.agentDir, sessionManager, resourceLoader: loaded.loader, modelRuntime: runtime });
    session = opened.session;
    const ownerSessionId = sessionManager.getSessionId();
    if (!ownerSessionId) throw new Error("Pi reload fixture has no session identity");
    engine = new MissionEngine({
      store, missionId: mission.id, sessionsDirectory: path.join(fixture.stateDir, "pitako", "sessions"), ownerSessionId,
      managedWorkspace: { sourceRoot: fixture.root, candidateParent: path.join(fixture.stateDir, "pitako-candidates") },
      runRole: async (_input, durable) => {
        markStarted();
        durable.signal?.addEventListener("abort", () => markAborted(), { once: true });
        return late;
      },
    });
    engine.start();
    await withTimeout(started, 15_000, "Pi reload mission attempt to start");
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: TimerHandler, _delay?: number, ...args: unknown[]) => originalSetTimeout(callback, 0, ...args)) as typeof setTimeout;
    try { await session.reload(); } finally { globalThis.setTimeout = originalSetTimeout; }
    await withTimeout(aborted, 15_000, "old Pi owner to abort during reload");
    reopened = await openFixtureStore(fixture);
    const beforeLate = reopened.inspectMission(mission.id);
    const release = beforeLate.events.find(({ kind }) => kind === "mission.owner.released")?.payload as Record<string, any> | undefined;
    const eventCount = beforeLate.events.length;
    const oldAttemptId = beforeLate.events.find(({ kind }) => kind === "attempt.interrupted")?.attemptId;
    releaseLate({
      instanceId: "late-old-owner", role: "developer", status: "completed",
      model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
      result: "late result must be fenced", usage: { input: 0, output: 0, turns: 0, toolCalls: 0 },
    });
    await engine.waitForIdle();
    const afterLate = reopened.inspectMission(mission.id);
    const observation = {
      missionId: mission.id, oldOwnerPid: release?.owner?.pid, oldOwnerEpoch: release?.owner?.epoch,
      newOwnerEpoch: reopened.ownerEpoch, release: { reason: release?.reason, ownerPid: release?.owner?.pid, ownerEpoch: release?.owner?.epoch, effectsQuiescent: release?.effectsQuiescent, resumablePause: release?.resumablePause },
      oldAttemptId, sourceHashBefore, sourceHashAfter: sha256(readFileSync(sourceFile)),
      eventCountBeforeLateResult: eventCount, eventCountAfterLateResult: afterLate.events.length,
      lateResultEventCountUnchanged: afterLate.events.length === eventCount,
      lateAttemptReceiptCreated: afterLate.events.some(({ kind, attemptId }) => kind === "attempt.receipt" && attemptId === oldAttemptId),
      lateUnitAccepted: afterLate.events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "snapshot"),
    };
    return observation;
  } finally {
    releaseLate({
      instanceId: "reload-cleanup", role: "developer", status: "cancelled",
      model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
      result: "cleanup", usage: { input: 0, output: 0, turns: 0, toolCalls: 0 },
    });
    session?.dispose();
    await engine?.retireForShutdown("T3 verifier cleanup").catch(() => {});
    reopened?.close(); store?.close();
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    rmSync(fixture.base, { recursive: true, force: true });
  }
}

async function verifyT5Stage(stage: string, runDir: string, evidenceDir: string, commands: CommandResult[]): Promise<void> {
  const tests = runCommand(runDir, evidenceDir, commands, "t5-focused", "bun",
    ["test", "tests/mission-admission.test.ts", "tests/mission-pi.test.ts", "tests/mission-engine.test.ts"],
    { MISSION_T5_ARTIFACT_DIR: path.join(runDir, "t5-observations") });
  const typecheck = runCommand(runDir, evidenceDir, commands, "typecheck", "bun", ["run", "typecheck"]);
  const hostTest = runCommand(runDir, evidenceDir, commands, "t5-real-pi-host", "bun", ["test", "tests/mission-host.test.ts"],
    { MISSION_T5_ARTIFACT_DIR: path.join(runDir, "t5-observations") });
  const hostFile = path.join(runDir, "t5-observations", "host-rpc-observed.json");
  const hostObserved = readJson(hostFile) as Record<string, any> | undefined;
  const hostProved = passed(hostTest) && hostObserved?.runtime === "pi --mode rpc" &&
    hostObserved.firstPid !== hostObserved.secondPid && hostObserved.denied?.ok === false &&
    hostObserved.prepared?.ok === true && hostObserved.attached?.ok === true &&
    hostObserved.paused?.ok === true && hostObserved.recoveryDenied?.ok === false &&
    hostObserved.cancelled?.ok === true && hostObserved.resumeDenied?.ok === false &&
    Array.isArray(hostObserved.controlEvents) && hostObserved.controlEvents.some((event: any) =>
      event.kind === "mission.cancelled" && event.payload.operatorInputId === hostObserved.cancelled.causalId);
  const activeNewFile = path.join(runDir, "t5-observations", "host-active-new-observed.json");
  const activeCrashFile = path.join(runDir, "t5-observations", "host-active-crash-observed.json");
  const activeNew = readJson(activeNewFile) as Record<string, any> | undefined;
  const activeCrash = readJson(activeCrashFile) as Record<string, any> | undefined;
  const observedFile = path.join(runDir, "t5-observations", "sdk-revision-observed.json");
  const consoleFile = path.join(runDir, "t5-observations", "console-observed.json");
  const recoveryFile = path.join(runDir, "t5-observations", "recovery-frontier-observed.json");
  const recovery = readJson(recoveryFile) as Record<string, any> | undefined;
  const blockedReport = recovery?.blockedReport;
  const blockedEvent = recovery?.blockedReportEvent;
  const recoveryFrontier = passed(tests) && blockedEvent?.kind === "mission.recovery.recorded" &&
    blockedEvent?.missionId === blockedReport?.missionId && blockedEvent?.revision === blockedReport?.revision &&
    blockedEvent?.payload?.reportHash === recovery?.blockedReportHash &&
    blockedEvent?.payload?.status === blockedReport?.status &&
    createHash("sha256").update(JSON.stringify(blockedReport ?? null, null, 2)).digest("hex") === recovery?.blockedReportHash &&
    blockedReport?.format === "mission-recovery-report-v2" && blockedReport?.disposition?.version === 2 &&
    blockedReport?.disposition?.revision === blockedReport?.revision &&
    blockedReport?.disposition?.ownerEpoch === blockedReport?.owner?.epoch &&
    blockedReport?.disposition?.observedSeq <= blockedEvent?.seq &&
    blockedReport?.disposition?.causes?.length > 0 &&
    recovery?.blockedStatus === "blocked" && blockedReport.status === "blocked" &&
    recovery?.blockedFrontier?.includes("snapshot") && recovery.blockedAttempts === 0 &&
    recovery.blockedAcceptances === 0 && recovery.conflictUnresolved === true &&
    recovery.conflictAttempts === 0 && recovery.resumedStatus === "resumed" && recovery.resumedAcceptances > 0;
  const consoleObserved = readJson(consoleFile) as Record<string, unknown> | undefined;
  const consoleProved = passed(tests) && consoleObserved?.deniedCredential === true &&
    consoleObserved.deniedNativePi === true && consoleObserved.deniedHypothetical === true &&
    consoleObserved.unauthorizedFileGoalIgnored === true && consoleObserved.revision === 2 &&
    consoleObserved.revisionEvents === 1 && consoleObserved.displayedRevisionCount === 1 &&
    Array.isArray(consoleObserved.notificationEvents) && consoleObserved.notificationEvents.some((event: any) =>
      Array.isArray(event.eventIds) && event.eventIds.length > 0);
  const observed = readJson(observedFile) as Record<string, unknown> | undefined;
  const proven = passed(tests) && passed(typecheck) && observed?.previousRevision === 1 && observed.currentRevision === 2 &&
    Number(observed.foregroundResponseMs) < 1000 && observed.staleAcceptanceCount === 0 &&
    observed.priorSnapshotPreserved === true && Array.isArray(observed.engineDerivedImpact) &&
    observed.engineDerivedImpact.includes("snapshot") && Number(observed.providerRequests) <= 1 && observed.paidRequests === 0;
  const activeHost = passed(hostTest) && activeNew?.status?.state === "running" && activeNew?.statusMs < 1000 &&
    activeNew?.beforeSwitchAttemptCount === 1 && activeNew?.afterSwitchAttemptCount === 1 &&
    activeNew?.afterReloadAttemptCount === 1 && activeNew?.navigationPause === true && activeNew?.state === "paused" &&
    activeCrash?.firstPid !== activeCrash?.secondPid && activeCrash?.attemptAfter > activeCrash?.attemptBefore &&
    activeCrash?.recoveryEvents?.length > 0 && activeCrash?.completedReceipts > 0 && activeCrash?.state === "running";
  const tuiFile = path.join(runDir, "t5-observations", "host-tui-worker-observed.json");
  const tui = readJson(tuiFile) as Record<string, any> | undefined;
  const tuiWorker = passed(hostTest) && tui?.runtime === "Pi 0.87.0 TUI under PTY" &&
    tui?.input?.prepare?.ok === true && tui?.input?.start?.ok === true &&
    tui?.worker?.activeAtQuestion === true && tui?.worker?.activeAtRevision === true &&
    tui?.worker?.attemptStartedSeq > 0 && tui?.after?.oldAttemptEvents?.some((event: any) => event.kind === "attempt.receipt" &&
      event.revision === 1 && event.seq > tui.after.revisionEvent.seq && event.payload.status !== "completed");
  const foregroundQuestion = tuiWorker && tui?.input?.question?.ok === true &&
    JSON.parse(tui.input.question.message).state === "running" && tui.input.question.responseMs < 1000 &&
    tui?.input?.hypothetical?.ok === false && tui?.unchanged?.revision === 1 &&
    tui?.unchanged?.definitionHash === tui?.before?.definitionHash &&
    tui?.unchanged?.eventSeq >= tui?.before?.eventSeq;
  const ambiguousChoice = passed(hostTest) && tui?.worker?.activeAtChoice === true &&
    tui?.input?.ambiguous?.ok === true && tui.input.ambiguous.message.includes("/units/0/acceptance/0") &&
    tui?.ambiguousHold?.revision === 1 && tui.ambiguousHold.priorAccepted === 0 &&
    tui.ambiguousHold.choice?.payload.operatorInputId === tui.input.ambiguous.causalId &&
    tui.ambiguousHold.choice?.payload.classification === "ambiguous" &&
    tui.ambiguousHold.choice?.payload.questionImpact?.join(",") === "consumer,snapshot" &&
    tui.ambiguousHold.choice?.payload.deltaPaths?.includes("/units/0/acceptance/0/target") &&
    tui.ambiguousHold.choice?.seq < tui.after.revisionEvent.seq && tui.input.revise.ok === true;
  const foregroundRevision = foregroundQuestion && tui?.input?.revise?.ok === true &&
    tui?.input?.revise?.message?.includes("impacted: consumer, snapshot") &&
    tui?.after?.revision === 2 && tui?.after?.definitionHash !== tui?.before?.definitionHash &&
    tui?.after?.oldDefinitionArtifactHash === tui?.before?.definitionHash &&
    tui?.after?.revisionEvent?.causalId === tui?.input?.revise?.causalId &&
    tui?.after?.revisionEvent?.payload?.operatorInputId === tui?.input?.revise?.causalId &&
    tui?.after?.revisionEvent?.payload?.impact?.join(",") === "consumer,snapshot" &&
    tui?.after?.revisionEvent?.seq > tui?.unchanged?.eventSeq && tui?.after?.oldAccepted === 0;
  const cleanFile = path.join(runDir, "t5-observations", "host-clean-close-observed.json");
  const forkFile = path.join(runDir, "t5-observations", "host-fork-observed.json");
  const tuiReloadFile = path.join(runDir, "t5-observations", "host-tui-reload-observed.json");
  const displayFile = path.join(runDir, "t5-observations", "host-causal-display-observed.json");
  const clean = readJson(cleanFile) as Record<string, any> | undefined;
  const fork = readJson(forkFile) as Record<string, any> | undefined;
  const tuiReload = readJson(tuiReloadFile) as Record<string, any> | undefined;
  const display = readJson(displayFile) as Record<string, any> | undefined;
  const cleanCloseAndReload = passed(hostTest) && clean?.runtime === "Pi 0.87.0 RPC" &&
    tuiReload?.runtime === "Pi 0.87.0 TUI under PTY" && tuiReload.command === "/reload" &&
    tuiReload.start?.ok === true && tuiReload.start?.message?.includes("resumeAfterClose: true") &&
    tuiReload.release?.payload?.reason === "reload" && tuiReload.release?.payload?.owner?.epoch === tuiReload.oldEpoch &&
    tuiReload.oldAttemptId !== tuiReload.newAttemptId && tuiReload.newEpoch > tuiReload.oldEpoch &&
    tuiReload.priorOutcome?.some((event: any) => ["attempt.receipt", "attempt.interrupted", "attempt.settled"].includes(event.kind)) &&
    tuiReload.recoveryEvents?.length > 0 && tuiReload.state === "running" &&
    new Set(clean.pids).size === 4 && clean.start?.ok === true && clean.start?.message?.includes("resumeAfterClose: true") &&
    clean.release?.kind === "mission.owner.released" && clean.release?.payload?.reason === "quit" &&
    clean.closedEvents?.some((event: any) => event.attemptId === clean.oldAttemptId &&
      ["attempt.receipt", "attempt.settled", "attempt.interrupted"].includes(event.kind)) &&
    clean.nextAttemptId !== clean.oldAttemptId && clean.nextEpoch > clean.oldEpoch &&
    clean.recoveryEvents?.length > 0 && clean.pausedState === "paused" && clean.terminalState === "cancelled" &&
    clean.terminalCount === clean.pausedCount && clean.paused?.causalId !== clean.cancelled?.causalId &&
    clean.controlEvents?.some((event: any) => event.kind === "mission.paused" && event.payload.operatorInputId === clean.paused.causalId) &&
    clean.controlEvents?.some((event: any) => event.kind === "mission.cancelled" && event.payload.operatorInputId === clean.cancelled.causalId);
  const forkNoTakeover = passed(hostTest) && fork?.runtime === "Pi 0.87.0 RPC" &&
    fork.fork?.success === true && fork.fork?.data?.cancelled === false && fork.prompt?.success === true &&
    fork.release?.some((event: any) => event.payload.reason === "fork" && event.payload.owner?.epoch === fork.oldEpoch) &&
    fork.pause?.some((event: any) => String(event.payload.reason).includes("fork")) &&
    fork.stateAfterFork === "paused" && fork.stateAfterAttach === "paused" && fork.attached?.ok === true &&
    fork.attemptsAfterFork?.length === 1 && fork.attemptsAfterFork[0].attemptId === fork.oldAttemptId;
  const causalDisplayAndNoUI = passed(hostTest) && display?.runtime === "Pi 0.87.0 RPC plus operator PTY" &&
    display.screen === true && display.revised?.ok === true && display.missed?.notifications?.includes("mission.revised: durable-fixture @2") &&
    display.beforeDisplay?.deliveryCount === 0 && display.beforeDisplay?.visibleCount === 0 &&
    display.beforeDisplay?.workerReceipt === true &&
    display.visible?.kind === "mission.input.visible" && Number(display.visible.payload.responseMs) > 0 &&
    display.delivery?.kind === "mission.notification.delivered" &&
    display.delivery.payload.operatorInputId === display.visible.payload.operatorInputId &&
    display.delivery.payload.eventIds?.length > 0 && display.duplicate?.ok === false &&
    display.finalAttemptIds?.length === display.beforeDisplay.attempts &&
    display.finalAttemptIds?.includes(display.attemptId);
  // Every mandatory host predicate needs an observed artifact. In-process SDK timing is not a foreground response.
  const hostChecks = {
    activeRpcStatus: activeHost,
    rpcAdmission: hostProved,
    sdkRevision: proven,
    consoleAdmission: consoleProved,
    tuiActiveWorker: tuiWorker,
    foregroundQuestionAndHypothetical: foregroundQuestion,
    foregroundRevisionRace: foregroundRevision,
    cleanCloseAndReload,
    forkNoTakeover,
    causalDisplayAndNoUI,
    recoveryFrontier,
    ambiguousChoice,
  };
  const missingHost = Object.entries(hostChecks).filter(([, value]) => !value).map(([name]) => name);
  const criteria = [
    { id: "sdk-interleaving", title: "Local Pi SDK worker remains independent of foreground revision and status inspection",
      status: proven && activeHost ? "pass" : "fail", evidence: [observedFile, activeNewFile, activeCrashFile].filter(existsSync).map((file) => artifact(evidenceDir, file)),
      reason: activeHost ? "SDK revision and real Pi RPC active-worker status and restart were observed." : "In-process SDK timing alone does not prove foreground host response during an active worker." },
    { id: "local-console-ingress", title: "Local console rejects unauthenticated and native Pi content; one explicit delta and durable display cursor",
      status: consoleProved && hostProved ? "pass" : "fail", evidence: [consoleFile, hostFile].filter(existsSync).map((file) => artifact(evidenceDir, file)),
      reason: "Observed socket submission, false credential, native Pi denial, hypothetical denial, concurrent revision and display reload." },
    { id: "blocked-recovery-and-ambiguous-choice", title: "Blocked recovery never dispatches; ambiguous operator delta asks and selectively holds until clear follow-up",
      status: recoveryFrontier && ambiguousChoice ? "pass" : "fail",
      evidence: [recoveryFile, tuiFile].filter(existsSync).map((file) => artifact(evidenceDir, file)),
      reason: recoveryFrontier && ambiguousChoice ? "Observed blocked and resumed reports, unresolved conflict, and authenticated in-flight question and revision." : "Missing blocked-recovery or ambiguous-choice observed scenario." },
    { id: "complete-host-admission-and-delivery", title: "Real Pi TUI/RPC and worker interleaving, owner close/crash/reload, manual control precedence and causal response trace",
      status: missingHost.length === 0 ? "pass" : "fail",
      evidence: [hostFile, activeNewFile, activeCrashFile, tuiFile, cleanFile, forkFile, tuiReloadFile, displayFile].filter(existsSync).map((file) => artifact(evidenceDir, file)),
      reason: missingHost.length ? `Missing observed host predicates: ${missingHost.join(", ")}` : "All host predicates observed." },
  ];
  const complete = criteria.every(({ status }) => status === "pass") && passed(tests) && passed(typecheck) && passed(hostTest);
  const manifest = buildManifest(stage, complete ? "pass" : "fail", commands, criteria,
    complete ? "T5 observed host acceptance" : `T5 missing: ${missingHost.join(", ")}`, runDir, evidenceDir);
  persistManifest(evidenceDir, manifest);
  console.error(`verify:mission T5 ${complete ? "pass" : "fail"}: ${path.join(evidenceDir, "verification-manifest.json")}`);
  if (!complete) process.exitCode = 1;
}

async function verifyT7Stage(runDir: string, evidenceDir: string, commands: CommandResult[]): Promise<void> {
  const sdkDir = path.join(runDir, "sdk"), cohortDir = path.join(runDir, "metrics");
  const identity = implementationDiffIdentity();
  const mandatoryIds = ["sdk-integration", "tests", "typecheck", "smoke", "code-intelligence-node", "mission-node"];
  const read = (file: string): any => readJson(file);
  const passed = (id: string) => {
    const row = commands.find((row) => row.id === id);
    return row?.exitCode === 0 && existsSync(path.join(evidenceDir, row.logPath));
  };
  runCommand(runDir, evidenceDir, commands, "sdk-integration", "node", ["--input-type=module", "-e",
    'import{createJiti}from"jiti";process.argv[2]=process.env.OUT;await createJiti(import.meta.url,{tryNative:false}).import("./scripts/mission-integration-sdk-node.mjs");'],
  { OUT: sdkDir, PITAKO_ENGINE_COMMIT: identity });
  const observed = read(path.join(sdkDir, "observed.json"));
  const completed = read(path.join(sdkDir, "journal-completed.json"));
  const sdkProofFiles = ["observed.json", "journal-mid-effect.json", "journal-recovered.json", "journal-completed.json",
    "integrated-report.json", "conditional-patch.json", "output-manifest.json", "contender.json", "operator-inputs.json",
    "cohort.json", "metrics.json", "observation.json"];
  const events: any[] = Array.isArray(completed?.events) ? completed.events : [];
  const integration = passed("sdk-integration") && sdkProofFiles.every((file) => {
    const value = read(path.join(sdkDir, file));
    return value !== null && typeof value === "object";
  }) &&
    observed?.actualManagedWriteInterrupted === true &&
    observed?.revision === 2 && observed?.sourceApplied === false && observed?.publication === false &&
    ["mission.recovery.recorded", "mission.revised", "mission.completed"].every((kind) =>
      events.some((row) => row?.kind === kind));
  const ownerDenied = integration && Number.isInteger(observed?.ownerPid) && observed.ownerPid > 0 &&
    Number.isInteger(observed?.contenderPid) && observed.contenderPid > 0 && observed.ownerPid !== observed.contenderPid;
  if (integration && ownerDenied) {
    // No nested stage calls. The unknown-stage regression uses T8, never this stage.
    runCommand(runDir, evidenceDir, commands, "tests", "bun", ["test"],
      { MISSION_T7_METRICS_EVIDENCE: cohortDir });
    runCommand(runDir, evidenceDir, commands, "typecheck", "bun", ["run", "typecheck"]);
    runCommand(runDir, evidenceDir, commands, "smoke", "bun", ["run", "smoke"]);
    runCommand(runDir, evidenceDir, commands, "code-intelligence-node", "bun", ["run", "test:code-intelligence-node"]);
    runCommand(runDir, evidenceDir, commands, "mission-node", "bun", ["run", "test:mission-node"],
      { MISSION_DURABILITY_OBSERVATION_PATH: path.join(runDir, "node-observed.json") });
  }
  const cohort = read(path.join(cohortDir, "cohort.json")), report = read(path.join(cohortDir, "report.json"));
  const isolation = read(path.join(cohortDir, "failure-isolation.json"));
  const empty = read(path.join(cohortDir, "empty-report.json"));
  const baseline = read(path.join(cohortDir, "unmeasured-baseline.json"));
  const afterEvents: any[] = Array.isArray(isolation?.final?.events) ? isolation.final.events : [];
  const retry = isolation?.calls?.find((call: any) => call.unitId === "alpha" && call.attemptNo === 2);
  const beta = isolation?.calls?.find((call: any) => call.unitId === "beta");
  const isolationObserved = isolation?.action?.command === "metricCommand" && isolation?.action?.failure?.code === "EEXIST" &&
    isolation?.before?.id === isolation?.action?.missionId &&
    isolation?.before?.state === "running" &&
    isolation?.before?.events?.some((event: any) => event.kind === "provider.request.dispatched") &&
    JSON.stringify(isolation?.before) === JSON.stringify(isolation?.afterFailure) &&
    retry?.admitted === false && retry?.error?.includes("ordinary provider-requests is reserved for remaining root slots") &&
    beta?.admitted === true && beta?.error === "" &&
    afterEvents.filter((event) => event.kind === "provider.request.dispatched").length === 2 &&
    !afterEvents.some((event) => event.kind === "provider.request.dispatched" && event.payload.requestId === retry?.requestId) &&
    afterEvents.some((event) => event.kind === "unit.accepted" && event.unitId === "beta" && event.seq > isolation.before.latestSeq) &&
    afterEvents.some((event) => event.kind === "provider.request.dispatched" && event.payload.requestId === beta?.requestId &&
      event.seq > isolation.before.latestSeq) &&
    JSON.stringify(isolation?.final?.reservations?.filter((row: any) => row.purpose === "protected").map((row: any) => row.amount)) ===
      JSON.stringify([2, 2, 100, 120000, 2000]) &&
    isolation?.cohort?.missions?.[0]?.asOfSeq === isolation?.final?.latestSeq;
  // Cite the actual protocol bytes for semantic independent review; existence or keyword hits cannot judge its adequacy.
  const protocolFile = "docs/missions.md", protocolBytes = existsSync(protocolFile) ? readFileSync(protocolFile) : Buffer.alloc(0);
  const protocolText = protocolBytes.toString("utf8");
  const protocolStart = protocolText.indexOf("### Interpretation and matched baseline\n");
  const protocol = protocolStart < 0 ? "" : protocolText.slice(protocolStart).split(/\n(?=## )/)[0]!.trim();
  const isolationReason = `metricCommand export failed locally (${isolation?.action?.failure?.code ?? "missing"}), ` +
    `at sequence ${isolation?.before?.latestSeq ?? "missing"}; journal/resources unchanged at failure; ` +
    `subsequent beta dispatch/acceptance and alpha retry provider-budget denial observed in failure-isolation.json. ` +
    `Empty live cohort remains unmeasured with undefined rates; deterministic cohort is not paid/live effectiveness. ` +
    `Baseline protocol ${protocolFile} SHA256 ${sha256(protocolBytes)}:\n${protocol}\n` +
    `Protocol adequacy requires coordinator's semantic independent review; no workflow acceptance granted.`;
  const omittedCommands = mandatoryIds.filter((id) => !commands.some((row) => row.id === id));
  const allGatesPassed = mandatoryIds.every(passed);
  persistFile(path.join(runDir, "review-handoff.json"), JSON.stringify({
    format: "mission-t7-review-handoff-v1", implementationIdentity: identity,
    acceptance: "pending coordinator independent review; this verifier grants no workflow acceptance",
    liveEffectiveness: "unmeasured; no paid dogfood allowance", sdkDirectory: rel(evidenceDir, sdkDir),
    commands, scope: "Review complete final diff, migrations, source/effect safety, recovery traces, freshness and outcomes",
  }, null, 2) + "\n");
  const checks = [
    ["sdk-user-flow", "Actual SDK interruption, source edit, reconciliation, revision, checks, cleanup, review and private delivery",
      integration, [path.join(sdkDir, "observed.json"), path.join(sdkDir, "journal-mid-effect.json"),
        path.join(sdkDir, "journal-recovered.json"), path.join(sdkDir, "journal-completed.json"),
        path.join(sdkDir, "integrated-report.json"), path.join(sdkDir, "conditional-patch.json"), path.join(sdkDir, "output-manifest.json")]],
    ["live-owner-denied", "Second real SDK process cannot take over the live owner; source/evidence retained",
      ownerDenied, [path.join(sdkDir, "contender.json"), path.join(sdkDir, "operator-inputs.json")]],
    ["compatibility-reads", "Ad-hoc regression paths, package command load and non-scheduling managed reads",
      integration && passed("tests") && passed("smoke"), [path.join(runDir, "tests.log"), path.join(runDir, "smoke.log")]],
    ["mandatory-gates", "All mandatory final integration gates",
      allGatesPassed, commands.map((row) => path.join(evidenceDir, row.logPath))],
    ["independent-review-handoff", "Complete evidence prepared for coordinator's final independent review, not acceptance",
      integration && allGatesPassed, [path.join(runDir, "review-handoff.json")]],
    ["versioned-metrics-import", "Reproducible local reporting and independently attested observation without completion rewrite",
      integration && passed("tests") && existsSync(path.join(sdkDir, "observation.json")),
      [path.join(sdkDir, "cohort.json"), path.join(sdkDir, "metrics.json"), path.join(sdkDir, "observation.json")]],
    ["cohort-counterexamples", "Full denominators, unknown exposure, correction cutoff, zero success and empty cohort",
      passed("tests") && cohort?.missions?.length === 6 && report?.counts?.admitted === 6 && report?.counts?.passed === 1 &&
        report?.counts?.unassessed === 3 && report?.costs?.unknownCost === 1,
      [path.join(cohortDir, "cohort.json"), path.join(cohortDir, "report.json"), path.join(runDir, "tests.log")]],
    ["baseline-and-failure-isolation", "Baseline protocol, explicit unmeasured live status, metric failure leaves execution untouched",
      passed("tests") && isolationObserved && protocol.length > 0 &&
        baseline?.population === "live-evaluation" && baseline?.missions?.length === 0 &&
        empty?.correctness?.rate === null && empty?.costs?.estimatedCostPerSuccess === null &&
        cohort?.missions?.length === 6 && report?.counts?.admitted === 6,
      [protocolFile, path.join(cohortDir, "failure-isolation.json"), path.join(cohortDir, "cohort.json"),
        path.join(cohortDir, "report.json"), path.join(cohortDir, "unmeasured-baseline.json"), path.join(cohortDir, "empty-report.json")]],
  ] as const;
  const criteria = checks.map(([id, title, value, files]) => ({ id, title, status: value ? "pass" : "fail",
    reason: value ? (id === "baseline-and-failure-isolation" ? isolationReason :
      "Observed deterministic contract; no live-effectiveness or workflow-acceptance claim.")
      : `Required command or observation missing/failed.${omittedCommands.length ? ` Prerequisite stopped T7; omitted commands (not passes): ${omittedCommands.join(", ")}.` : ""}`,
    evidence: files.filter(existsSync).map((file) => artifact(evidenceDir, file)) }));
  const complete = criteria.every((row) => row.status === "pass");
  persistManifest(evidenceDir, { ...buildManifest("T7", complete ? "pass" : "fail", commands, criteria,
    complete ? undefined : "T7 integration evidence incomplete or failed", runDir, evidenceDir), omittedCommands });
  console.error(`verify:mission T7 ${complete ? "pass" : "fail"}: ${path.join(evidenceDir, "verification-manifest.json")}`);
  if (!complete) process.exitCode = 1;
}

async function verifyT6Stage(runDir: string, evidenceDir: string, commands: CommandResult[]): Promise<void> {
  const protocolFile = path.join(runDir, "team-protocol.json"), barrierFile = path.join(runDir, "node-barriers.json");
  const accountingFile = path.join(runDir, "accounting.json"), sdkDir = path.join(runDir, "sdk"), nodeDir = path.join(runDir, "node");
  const cutsDir = path.join(runDir, "publication-cuts");
  runCommand(runDir, evidenceDir, commands, "protocol", "bun", ["test", "tests/mission-teams.test.ts", "tests/mission-teams-sdk.test.ts"],
    { MISSION_TEAM_PROTOCOL_OBSERVATION_PATH: protocolFile });
  runCommand(runDir, evidenceDir, commands, "caps", "bun", ["test", "tests/mission-consultation.test.ts",
    "tests/mission-consultation-sdk.test.ts", "tests/mission-singleton-checkpoint-controls.test.ts", "tests/mission-store.test.ts",
    "tests/mission-accounting.test.ts"], { MISSION_ACCOUNTING_OBSERVATION_PATH: accountingFile });
  runCommand(runDir, evidenceDir, commands, "completion-negative", "bun", ["test", "tests/mission-finalization.test.ts",
    "tests/mission-managed-routing.test.ts"]);
  runCommand(runDir, evidenceDir, commands, "sdk", "bun", ["test", "tests/mission-finalization-sdk.test.ts"],
    { PITAKO_SLICE4B_EVIDENCE: sdkDir });
  runCommand(runDir, evidenceDir, commands, "node-barriers", "node", ["scripts/mission-team-node.mjs"],
    { MISSION_TEAM_EVIDENCE_PATH: barrierFile });
  runCommand(runDir, evidenceDir, commands, "node-positive", "node", ["--input-type=module", "-e",
    'import{createJiti}from"jiti";process.argv[2]=process.env.OUT;await createJiti(import.meta.url,{tryNative:false}).import("./scripts/mission-finalization-sdk-node.mjs");'],
  { OUT: nodeDir, MISSION_T6_TEAM: "1" });
  runCommand(runDir, evidenceDir, commands, "publication-cuts", "node", ["scripts/mission-completion-node.mjs", cutsDir]);
  runCommand(runDir, evidenceDir, commands, "typecheck", "bun", ["run", "typecheck"]);
  const read = (file: string): any => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  const protocols = read(protocolFile), barriers = read(barrierFile), node = read(path.join(nodeDir, "observed.json"));
  const journal = read(path.join(nodeDir, "journal.json")), provider = read(path.join(nodeDir, "provider.json"));
  const cuts = read(path.join(cutsDir, "observed.json")), accounting = read(accountingFile);
  const passed = (id: string) => commands.find((row) => row.id === id)?.exitCode === 0;
  const rows = (kind: string) => journal?.events?.filter((row: any) => row.kind === kind) ?? [];
  const sameSlots = rows("attempt.reserved").filter((row: any) => row.payload.binding.consultationId &&
    !row.payload.binding.continuationOf);
  const nodePositive = passed("node-positive") && node?.completionPublished === true &&
    node.recovery?.status === "resumed" && node.recovery.blockers?.length === 0 &&
    node.recovery.disposition?.causes?.length === 0 && rows("mission.recovery.recorded").length > 0 &&
    node.exactNodeRestart === true && node.sourcePreserved === true && node.certificate?.runtimeIdentity?.startsWith("node:") &&
    node.boardObservation?.status === "resolved" && node.boardObservation.staleRejected &&
    node.boardObservation.restoredStillRejected && node.boardObservation.interrupted &&
    rows("mission.completed").length === 1 && rows("mission.finalization.published").length === 1 &&
    rows("mission.finalization.published")[0].seq + 1 === rows("mission.completed")[0].seq;
  const protocol = passed("protocol") && ["planning", "execution", "review"].every((phase) =>
    protocols?.some((row: any) => row.phase === phase && row.accepted && row.bundles.length === 10 &&
      row.events.every((event: any) => !["effect.intent", "workspace.candidate.registered", "mission.completed"].includes(event.kind))));
  const firstRound = protocol && protocols.filter((row: any) => row.phase).every((row: any) =>
    row.bundles.slice(0, 3).every((bundle: any) => !("priorFindings" in bundle))) &&
    protocols.some((row: any) => row.negative === "peer pointer mismatch" && !row.accepted);
  const restart = passed("node-barriers") && barriers?.map((row: any) => row.slots.length).join() === "3,6,9,10" &&
    barriers.map((row: any) => row.trace.length).join() === "3,3,3,1" && new Set(barriers.at(-1).slots).size === 10 &&
    protocols?.some((row: any) => row.negative === "missing member" &&
      row.events.some((event: any) => event.kind === "team.barrier.recorded" && event.payload.status === "incomplete"));
  const attribution = nodePositive && passed("caps") && sameSlots.length === 10 &&
    new Set(sameSlots.map((row: any) => `${row.payload.binding.roundId}:${row.payload.binding.memberId}`)).size === 10 &&
    rows("provider.request.receipt").length === 15 && rows("provider.request.dispatched").length === 15 &&
    provider?.trace?.length === 15 && node.engineCompletedNotVerifiedOutcome === true &&
    node.outcomeObservations?.map((row: any) => row.verdict).join() === "unassessed,fail" &&
    node.outcomeObservations[1].supersedesId === node.outcomeObservations[0].id;
  const checks = [
    ["team-contracts", "Planning cannot implement; execution and review share protocol with distinct outputs", protocol, [protocolFile]],
    ["independent-findings", "First round isolation and exact cross-critique/rebuttal pointers", firstRound, [protocolFile, path.join(nodeDir, "provider.json")]],
    ["restart-and-incomplete", "Every barrier reopens without repeated work; required missing members stay incomplete", restart && nodePositive, [barrierFile, protocolFile, path.join(nodeDir, "journal-interruption.json")]],
    ["bounded-admission", "Nesting, session, retry and synthesis caps; waiting parent releases slots; protected quota", passed("caps") && passed("protocol") && attribution && accounting?.probes?.length > 0, [accountingFile, path.join(runDir, "caps.log"), path.join(runDir, "protocol.log")]],
    ["ordered-whole-review", "Cleanup then final production gates then whole review; mutation invalidates approval", passed("sdk") && nodePositive, [path.join(sdkDir, "changed-cleanup/journal.json"), path.join(sdkDir, "failed-second-gate/gate-observations.json"), path.join(nodeDir, "observed.json")]],
    ["atomic-current-completion", "Current predicates, full manifest and whole review; no questions/holds/effects/writers; crash atomicity and Board", passed("completion-negative") && passed("sdk") && nodePositive && passed("publication-cuts") && cuts?.cuts?.length === 5, [path.join(nodeDir, "journal.json"), path.join(nodeDir, "observed.json"), path.join(cutsDir, "observed.json"), path.join(runDir, "completion-negative.log")]],
    ["attribution-not-outcome", "Effort, corrections and acceptance attributable without duplicates; completion is not verified outcome", attribution, [path.join(nodeDir, "journal.json"), path.join(nodeDir, "provider.json"), path.join(nodeDir, "observed.json"), accountingFile]],
  ] as const;
  const criteria = checks.map(([id, title, value, files]) => ({ id, title, status: value ? "pass" : "fail",
    reason: value ? "Observed protocol and producer controls at this implementation identity; scripted judgments are not expert truth." : "Required observed predicate or command failed.",
    evidence: files.filter(existsSync).map((file) => artifact(evidenceDir, file)) }));
  const complete = criteria.every((row) => row.status === "pass") && commands.every((row) => row.exitCode === 0);
  persistManifest(evidenceDir, buildManifest("T6", complete ? "pass" : "fail", commands, criteria,
    complete ? undefined : "T6 evidence incomplete or failed", runDir, evidenceDir));
  console.error(`verify:mission T6 ${complete ? "pass" : "fail"}: ${path.join(evidenceDir, "verification-manifest.json")}`);
  if (!complete) process.exitCode = 1;
}

async function verifyLaterStage(stage: string, runDir: string, evidenceDir: string, commands: CommandResult[]): Promise<void> {
  if (stage === "T2") return verifyT2Stage(runDir, evidenceDir, commands);
  if (stage === "T3") return verifyT3Stage(runDir, evidenceDir, commands);
  const regressionTests = ["tests/mission-model.test.ts", "tests/mission-store.test.ts", "tests/workflow.test.ts", "tests/execution-binding.test.ts"];
  const stageTests = [
    ...regressionTests, "tests/mission-accounting.test.ts", "tests/mission-engine.test.ts", "tests/mission-runner.test.ts",
    "tests/agent-pi.test.ts", "tests/mission-effects.test.ts", "tests/mission-workspace.test.ts",
    "tests/mission-recovery.test.ts", "tests/mission-import.test.ts", "tests/mission-managed-routing.test.ts",
    "tests/team.test.ts", "tests/board.test.ts", "tests/agent.test.ts",
  ];
  const testLog = runCommand(runDir, evidenceDir, commands, "focused-tests", "bun", ["test", ...stageTests], {
    MISSION_T4_ARTIFACT_DIR: path.join(runDir, "t4-observations"),
  });
  const typecheck = runCommand(runDir, evidenceDir, commands, "typecheck", "bun", ["run", "typecheck"]);
  const nodeObservations = path.join(runDir, "node-suite-observed.json");
  const nodeSuite = runCommand(runDir, evidenceDir, commands, "production-node-suite", "node", ["--test", "scripts/mission-durability-node.mjs"], {
    MISSION_DURABILITY_OBSERVATION_PATH: nodeObservations,
  });
  const observed = readJson(nodeObservations);
  const nodeRuntimeProved = passed(nodeSuite) && Array.isArray(observed) && observed.length > 0 &&
    observed.every((row) => row && row.assertionsPassed === true);
  const basePass = passed(testLog) && passed(typecheck) && nodeRuntimeProved;
  const t4Directory = path.join(runDir, "t4-observations");
  const t4Artifacts = existsSync(t4Directory) ? readdirSync(t4Directory).filter((name) => name.endsWith(".json")) : [];
  const t4Rows = t4Artifacts.flatMap((name) => {
    const value = readJson(path.join(t4Directory, name));
    return value && typeof value === "object" ? [{ name, value: value as Record<string, unknown> }] : [];
  });
  const findT4 = (prefix: string) => t4Rows.find(({ name }) => name.startsWith(prefix));
  const criteria: Array<{ id: string; title: string; pass: boolean; reason: string; artifacts: string[] }> = [];
  const add = (id: string, title: string, pass: boolean, reason: string, artifacts: string[]) => {
    criteria.push({ id, title, pass: pass && basePass, reason, artifacts });
  };

  {
    const relocated = findT4("engine-relocated-");
    const missingCandidate = findT4("candidate-outside-arena-");
    const missingReceipt = findT4("missing-local-receipt-");
    const deliveryPatch = findT4("delivery-patch-");
    const overlapRecovery = findT4("recovery-conflict-");
    const effect = findT4("effect-recovery-");
    const effectAfterImage = findT4("effect-after-image-");
    const freshRepair = findT4("fresh-repair-");
    const predicateBindings = findT4("predicate-input-binding-");
    const hold = findT4("import-hold-");
    const unknown = findT4("import-unknown-");
    const ledgerConflict = findT4("conflict-");
    const sourceDrift = findT4("source-drift-");
    const evidenceDrift = findT4("evidence-drift-");
    const probedExternal = findT4("external-effect-probed-");
    const unknownExternal = findT4("external-effect-unknown-");
    const deliveryArtifact = deliveryPatch?.value as Record<string, unknown> | undefined;
    const delivery = deliveryArtifact?.exitReport as Record<string, unknown> | undefined;
    const conditionalPatch = deliveryArtifact?.conditionalPatch as Record<string, unknown> | undefined;
    const patchPreimageManifest = deliveryArtifact?.patchPreimageManifest as Record<string, unknown> | undefined;
    const patchResultManifest = deliveryArtifact?.patchResultManifest as Record<string, unknown> | undefined;
    const patchBytes = Buffer.from(String(deliveryArtifact?.patchArtifactBase64 ?? ""), "base64");
    const patchChanges = conditionalPatch?.changes as Array<Record<string, unknown>> | undefined;
    const conditionalPatchEvidence = conditionalPatch?.format === "mission-conditional-patch-v1" &&
      /^[a-f0-9]{64}$/.test(String(deliveryArtifact?.patchArtifactHash)) &&
      sha256(patchBytes) === deliveryArtifact?.patchArtifactHash && Array.isArray(patchChanges) && patchChanges.length > 0 &&
      /^[a-f0-9]{64}$/.test(String(deliveryArtifact?.patchPreimageManifestHash)) &&
      patchPreimageManifest?.hash === deliveryArtifact?.patchPreimageManifestHash &&
      /^[a-f0-9]{64}$/.test(String(deliveryArtifact?.patchResultManifestHash)) &&
      patchResultManifest?.hash === deliveryArtifact?.patchResultManifestHash &&
      conditionalPatch.acceptedManifestHash === deliveryArtifact?.patchResultManifestHash &&
      deliveryArtifact?.acceptedManifestHash === deliveryArtifact?.patchResultManifestHash &&
      patchChanges.every((change) => typeof change.path === "string" && change.before !== undefined && change.after !== undefined);
    const relocationAction = relocated?.value.actionReport as Record<string, unknown> | undefined;
    const relocationExit = relocated?.value.exitReport as Record<string, unknown> | undefined;
    const action = overlapRecovery?.value.actionReport as Record<string, unknown> | undefined;
    const effectAction = effect?.value.actionReport as Record<string, unknown> | undefined;
    const missingCandidateAction = missingCandidate?.value.actionReport as Record<string, unknown> | undefined;
    const missingReceiptAction = missingReceipt?.value.actionReport as Record<string, unknown> | undefined;
    const effectPlan = effectAfterImage?.value.effectPlan as Record<string, unknown> | undefined;
    const predicateBindingExit = predicateBindings?.value.exitReport as Record<string, unknown> | undefined;
    const unknownExit = unknown?.value.exitReport as Record<string, unknown> | undefined;
    const sourceExit = sourceDrift?.value.exitReport as Record<string, unknown> | undefined;
    const diagnosis = action?.diagnoses as Array<Record<string, unknown>> | undefined;
    const managedRouting = findT4("managed-routing-");
    const adHocRouting = findT4("ad-hoc-routing-");
    const routingCases = (managedRouting?.value.cases as Array<Record<string, unknown>> | undefined) ?? [];
    const rejectedRoute = (tool: string, target: string, requestedPlan?: string) => routingCases.some((item) =>
      item.tool === tool && item.target === target && item.rejected === true && String(item.message).includes("managed mission") &&
      (requestedPlan === undefined || item.requestedPlan === requestedPlan));
    const adHocExit = adHocRouting?.value;
    const routingObserved = managedRouting?.value.format === "mission-t4-managed-routing-v1" &&
      rejectedRoute("agent_run", "managed-source") && rejectedRoute("team_assign", "managed-source", "other-plan") &&
      rejectedRoute("agent_spawn", "managed-source", "other-plan") &&
      rejectedRoute("agent_run", "managed-source-without-locator") && rejectedRoute("agent_run", "registered-candidate") &&
      rejectedRoute("agent_spawn", "renamed-candidate-symlink", "other-plan") &&
      rejectedRoute("team_assign", "renamed-candidate-symlink") &&
      rejectedRoute("board_workflow_lifecycle", "managed-source", "other-plan") &&
      routingCases.filter((item) => ["team_status", "team_result", "team_cancel"].includes(String(item.tool))).every((item) => item.stable === true) &&
      routingCases.some((item) => item.tool === "board_workflow_lifecycle" && item.resolvedWithoutCertificateRejected === true && item.closedWithMatchingPlan === true) &&
      adHocExit?.format === "mission-t4-ad-hoc-routing-v1" && adHocExit.dispatched === true &&
      Array.isArray(adHocExit.started) && (adHocExit.started as unknown[]).includes(adHocExit.target);
    add("partial-drift-relocation", "Partial write, user drift, and relocated candidate reconcile without source overwrite",
      relocationAction?.status === "resumed" && relocationExit?.checkStatus === "completed" &&
      relocationExit?.checkOutput === "RECOVERED" && relocationExit?.preservedPartial === true &&
      relocationExit?.unitAccepted === true && relocated?.value.candidateRelocated === true &&
      Array.isArray(relocationAction.frontier) && relocationAction.frontier.includes("snapshot"),
      "Observed the persisted recovery report, registered-arena relocation event, and a fresh command result on the recovered candidate.",
      relocated ? [`t4-observations/${relocated.name}`] : []);
    add("unsafe-recovery-fail-closed", "Unregistered candidates and unbound missing-receipt effects cannot trigger unsafe retry",
      missingCandidateAction?.status === "blocked" && Array.isArray(missingCandidateAction.blockers) &&
      missingCandidateAction.blockers.some((reason) => String(reason).includes("candidate is missing")) &&
      (missingCandidate?.value.exitReport as Record<string, unknown> | undefined)?.workerRuns === 0 &&
      (missingCandidate?.value.exitReport as Record<string, unknown> | undefined)?.outsideCandidatePreserved === true &&
      missingReceiptAction?.status === "blocked" &&
      (missingReceiptAction.effects as Array<Record<string, unknown>> | undefined)?.some((row) => row.disposition === "unknown") === true &&
      Array.isArray(missingReceiptAction.frontier) && !missingReceiptAction.frontier.includes("snapshot") &&
      (missingReceipt?.value.exitReport as Record<string, unknown> | undefined)?.workerReceiptFabricated === false &&
      (missingReceipt?.value.exitReport as Record<string, unknown> | undefined)?.partialBytesPreserved === true,
      "Observed a blocked unregistered candidate, sticky unbound effect uncertainty, preserved partial bytes, and no fabricated result.",
      [missingCandidate, missingReceipt].flatMap((row) => row ? [`t4-observations/${row.name}`] : ["focused-tests.log"]));
    add("persisted-local-effect-image", "Exact local requests and per-path before/after images prove recovery without replay",
      (effectAfterImage?.value.actionReport as Record<string, unknown> | undefined)?.effects instanceof Array &&
      ((effectAfterImage?.value.actionReport as Record<string, unknown>).effects as Array<Record<string, unknown>>).some((row) => row.disposition === "applied") &&
      (effectPlan?.request as Record<string, unknown> | undefined)?.path === "src/app.ts" &&
      Array.isArray(effectPlan?.preconditions) && (effectPlan.preconditions as Array<Record<string, unknown>>).some((row) => row.path === "src/app.ts") &&
      Array.isArray(effectPlan?.expectedAfterFiles) &&
      Buffer.from(String((effectPlan.expectedAfterFiles as Array<Record<string, unknown>>)[0]?.bytesBase64 ?? ""), "base64").toString("utf8").includes("partial mission write") &&
      (effectAfterImage?.value.exitReport as Record<string, unknown> | undefined)?.afterImageProofPersisted === true,
      "Observed the content-addressed exact request, target precondition, expected postimage, and a persisted candidate-after-image proof.",
      effectAfterImage ? [`t4-observations/${effectAfterImage.name}`] : ["focused-tests.log"]);
    add("predicate-input-binding", "Per-predicate bindings retain independent evidence while invalidating changed inputs",
      predicateBindingExit?.perPredicateBindingsStored === true && predicateBindingExit?.changedInputInvalidated === true &&
      predicateBindingExit?.unaffectedInputRetained === true && predicateBindingExit?.onlyChangedUnitScheduled === true &&
      predicateBindingExit?.indexOnlyChangeInvalidated === true && predicateBindingExit?.indexOnlyChangePreservedWorktree === true,
      "Observed persisted per-predicate path, index, policy, tool, runtime, and dependency bindings with scoped invalidation.",
      predicateBindings ? [`t4-observations/${predicateBindings.name}`] : ["focused-tests.log"]);
    add("conditional-delivery-patch", "Exact conditional patch records its preimage and resulting manifest",
      conditionalPatchEvidence && delivery?.acceptedManifestHashMatches === true && delivery?.userEditPreserved === true &&
      delivery?.missionWritePreserved === true,
      "Observed the stored patch bytes, actual preimage and resulting manifests, and preserved user and mission changes.",
      deliveryPatch ? [`t4-observations/${deliveryPatch.name}`] : []);
    add("lost-receipt-no-repeat", "Lost worker receipt is recovered from the original effect without repeating mutation",
      effectAction?.status === "resumed" &&
      (effectAction.effects as Array<Record<string, unknown>> | undefined)?.some((row) => row.disposition === "applied") === true &&
      (effect?.value.exitReport as Record<string, unknown> | undefined)?.workerReceiptFabricated === false &&
      (effect?.value.exitReport as Record<string, unknown> | undefined)?.mutationDenied === true &&
      (effect?.value.exitReport as Record<string, unknown> | undefined)?.engineRecoveredAndAccepted === true,
      "Observed an applied local effect, no fabricated worker receipt, and verification-only recovery without a repeated write.",
      effect ? [`t4-observations/${effect.name}`] : []);
    const repairAction = freshRepair?.value.actionReport as Record<string, unknown> | undefined;
    const repairExit = freshRepair?.value.exitReport as Record<string, unknown> | undefined;
    const repairAttempts = repairAction?.attempts as Array<Record<string, unknown>> | undefined;
    add("verified-bounded-fresh-repair", "Failed verification admits one bounded correction on a fresh image-bound candidate",
      repairAttempts?.length === 2 && repairAttempts[0]?.mode === "verify" && repairAttempts[1]?.mode === "repair" &&
      repairAttempts[0]?.candidateRoot !== repairAttempts[1]?.candidateRoot && repairAttempts[0]?.imageHash === repairAttempts[1]?.imageHash &&
      repairExit?.originalEffectNotRepeated === true && repairExit?.repairVerified === true,
      "Observed read-only verification, one new authorized repair attempt on a fresh candidate, and predicate proof without replaying the original effect.",
      freshRepair ? [`t4-observations/${freshRepair.name}`] : ["focused-tests.log"]);
    add("bounded-overlap-diagnosis", "Developer diagnoses exact overlap; expert runs only for a genuine conflict and persists its disposition",
      diagnosis?.some((row) => row.role === "developer" && row.disposition === "genuine-conflict" && typeof row.resultHash === "string") === true &&
      diagnosis?.some((row) => row.role === "expert" && row.disposition === "compatible" && typeof row.resultHash === "string") === true &&
      (overlapRecovery?.value.exitReport as Record<string, unknown> | undefined)?.diagnosisCallsUnchanged === true,
      "Observed durable Developer and expert receipts, exact compatible patch, and no repeat consultation on unchanged evidence.",
      overlapRecovery ? [`t4-observations/${overlapRecovery.name}`, "focused-tests.log"] : ["focused-tests.log"]);
    add("drift-without-consultation", "Disjoint source, HEAD, index, and plan drift do not prompt for a semantic decision",
      sourceExit?.headRecordedSeparately === true && sourceExit?.indexRecordedSeparately === true &&
      sourceExit?.planChanged === true && sourceExit?.planMissing === true && sourceExit?.immutablePlanHashPreserved === true,
      "Observed distinct HEAD, index, changed-plan, and missing-plan outcomes while disjoint drift bypassed diagnosis.",
      sourceDrift ? [`t4-observations/${sourceDrift.name}`, "focused-tests.log"] : ["focused-tests.log"]);
    const evidenceDriftExit = evidenceDrift?.value.exitReport as Record<string, unknown> | undefined;
    const freshCheck = evidenceDriftExit?.freshCheck as Record<string, unknown> | undefined;
    const freshCommand = freshCheck?.command as Record<string, unknown> | undefined;
    const inputManifest = freshCheck?.inputManifest as Record<string, unknown> | undefined;
    const resultManifest = freshCheck?.resultManifest as Record<string, unknown> | undefined;
    const freshOutput = String(freshCheck?.output ?? "");
    const freshCheckObserved = evidenceDriftExit?.freshCheckScheduled === true &&
      freshCheck?.exitCode === 0 && typeof freshCheck?.method === "string" && freshCheck.method.length > 0 &&
      typeof freshCommand?.executable === "string" && Array.isArray(freshCommand?.args) &&
      typeof freshCheck?.candidateRoot === "string" && freshCommand?.cwd === freshCheck?.candidateRoot &&
      /^[a-f0-9]{64}$/.test(String(freshCheck?.inputManifestHash)) && inputManifest?.hash === freshCheck?.inputManifestHash &&
      /^[a-f0-9]{64}$/.test(String(freshCheck?.resultManifestHash)) && resultManifest?.hash === freshCheck?.resultManifestHash &&
      /^[a-f0-9]{64}$/.test(String(freshCheck?.outputHash)) && sha256(Buffer.from(freshOutput)) === freshCheck?.outputHash &&
      freshCheck?.candidateUnchanged === true && freshCheck?.sourceUnchanged === true;
    add("path-sensitive-evidence", "Recovery retains unaffected evidence and runs a fresh proof on its disposable candidate",
      evidenceDriftExit?.retainedUnaffected === true && evidenceDriftExit?.invalidatedAffected === true && freshCheckObserved,
      "Observed scoped evidence reuse, invalidation, and a contained focused check with command, exit, input/result manifests, and output hash.",
      evidenceDrift ? [`t4-observations/${evidenceDrift.name}`, "focused-tests.log"] : ["focused-tests.log"]);
    add("external-effect-disposition", "Ambiguous external work probes original identity; unknown proof blocks only dependent work",
      (probedExternal?.value.exitReport as Record<string, unknown> | undefined)?.originalIdentityProbed === true &&
      (probedExternal?.value.exitReport as Record<string, unknown> | undefined)?.mutationNotRepeated === true &&
      (unknownExternal?.value.exitReport as Record<string, unknown> | undefined)?.duplicateInvocationPrevented === true &&
      (unknownExternal?.value.exitReport as Record<string, unknown> | undefined)?.independentReady === true,
      "Observed a read-only probe by original operation key and unknown-effect fencing with an independent unit still ready.",
      [probedExternal, unknownExternal].flatMap((row) => row ? [`t4-observations/${row.name}`] : ["focused-tests.log"]));
    add("exact-hold-and-malformed-gates", "Exact no-outcome hold retires without result; malformed gate remains unknown",
      (hold?.value.exitReport as Record<string, unknown> | undefined)?.noOutcomeFabricated === true &&
      (hold?.value.exitReport as Record<string, unknown> | undefined)?.repeatedDispositionStable === true &&
      (hold?.value.exitReport as Record<string, unknown> | undefined)?.engineRetiredBeforeWorker === true &&
      (hold?.value.exitReport as Record<string, unknown> | undefined)?.exactHostProbeCount === 1 &&
      unknownExit?.noHoldRetired === true,
      "Observed the engine's exact host probe before frontier admission, no fabricated outcome, idempotent retirement, and malformed-ledger preservation.",
      [hold, unknown].flatMap((row) => row ? [`t4-observations/${row.name}`] : ["focused-tests.log"]));
    add("conflicting-ledger-archive", "Conflicting legacy bytes remain archived without creating a second mission",
      (ledgerConflict?.value.exitReport as Record<string, unknown> | undefined)?.oneMissionOnly === true &&
      (ledgerConflict?.value.exitReport as Record<string, unknown> | undefined)?.exactLedgerPreserved === true,
      "Observed exact conflicting ledger bytes, archived hashes, explicit blocked disposition, and one durable mission identity.",
      ledgerConflict ? [`t4-observations/${ledgerConflict.name}`] : ["focused-tests.log"]);
    add("managed-and-legacy-routing", "Managed dispatch resolves physical ownership; unrelated ad hoc dispatch remains available",
      routingObserved && passed(testLog) && readLog(path.join(runDir, "focused-tests.log")).includes("team.test.ts") &&
      readLog(path.join(runDir, "focused-tests.log")).includes("board.test.ts"),
      "Observed source, wrong-plan, candidate, renamed symlink, Board, repeatable Team reads, and unrelated ad hoc tool executions.",
      [managedRouting, adHocRouting].flatMap((row) => row ? [`t4-observations/${row.name}`] : ["focused-tests.log"]));
  }

  const mapped = criteria.map((criterion) => {
    const evidence = criterion.artifacts.flatMap((relative) => {
      const target = path.join(runDir, relative);
      return existsSync(target) && statSync(target).isFile() ? [artifact(evidenceDir, target)] : [];
    });
    return { ...criterion, status: criterion.pass && evidence.length > 0 ? "pass" : "fail", evidence };
  });
  const status = mapped.every(({ status: value }) => value === "pass") ? "pass" : "fail";
  const errors = mapped.filter(({ status: value }) => value !== "pass").map(({ id }) => id);
  const manifest = buildManifest(stage, status, commands, mapped, errors.length ? `Failed criteria: ${errors.join(", ")}` : undefined, runDir, evidenceDir);
  persistManifest(evidenceDir, manifest);
  console.log(`verify:mission ${stage} ${status}: ${path.join(evidenceDir, "verification-manifest.json")}`);
  if (status !== "pass") process.exitCode = 1;
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  if (check()) return;
  throw new Error(`timed out after ${timeoutMs}ms waiting for observed state`);
}

async function waitForChild(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child ${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function combineChecks(...checks: Array<boolean | undefined>): boolean | undefined {
  if (checks.includes(false)) return false;
  return checks.every((check) => check === true) ? true : undefined;
}

function isContainmentInconclusive(error: string | undefined): boolean {
  return error !== undefined && /^(inconclusive:|unsupported bwrap implementation:|bwrap containment preflight failed;)/.test(error);
}

function readLog(file: string): string {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}

main().catch((error) => {
  console.error(`verify:mission: ${errorMessage(error)}`);
  process.exitCode = 1;
});
