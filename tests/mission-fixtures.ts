import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openMissionStore, type MissionInspection, type MissionStore } from "../extensions/mission/store.ts";
import { recordOperatorChoice } from "../extensions/mission/admission.ts";
import type { MissionDefinition } from "../extensions/mission/model.ts";

// Explicit fixture-local allocation for effects exercised without a running engine.
export function fixtureCommandTime(capacityMs = 120_000) {
  return { admit: async (requestedMs?: number) => requestedMs ?? capacityMs, remaining: () => capacityMs };
}

type RejectionCaptureOutcome =
  | { status: "written"; path: string }
  | { status: "failed"; error: string };

// Fixture-owned diagnostics only: no payload in the lifecycle trace or stderr.
export function createFixtureRejectionCapture(directory: string | undefined, caseId: string) {
  if (!directory) return undefined;
  const outcomes: RejectionCaptureOutcome[] = [];
  const trace: Array<{ caseId: string; pid: number; monotonicMs: number; event: string; outcome?: RejectionCaptureOutcome }> = [];
  const record = (event: string, outcome?: RejectionCaptureOutcome) => {
    const entry = { caseId, pid: process.pid, monotonicMs: performance.now(), event, ...(outcome ? { outcome } : {}) };
    trace.push(entry);
    try { process.stderr.write(`[fixture-rejection-capture] ${JSON.stringify(entry)}\n`); } catch { /* diagnostics cannot change fixture behavior */ }
  };
  record("install");
  return {
    outcomes,
    trace,
    captureRejection(observation: Record<string, unknown>): RejectionCaptureOutcome {
      let outcome: RejectionCaptureOutcome;
      try {
        mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${randomUUID()}.json`);
        writeFileSync(file, JSON.stringify(observation, null, 2));
        outcome = { status: "written", path: file };
      } catch (error) {
        outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
      outcomes.push(outcome);
      record("capture", outcome);
      return outcome;
    },
    restore() { record("restore"); },
  };
}

export function missionDefinition(): Extract<MissionDefinition, { schemaVersion: 1 | 2 }> {
  return {
    schemaVersion: 1,
    goal: "Verify durable snapshots",
    scope: ["local fixtures"],
    nonGoals: ["schedule workers"],
    invariants: ["snapshots are immutable"],
    authority: {
      allowedPaths: [],
      operations: [],
      externalEffects: [],
      rolePolicies: { developer: { hash: "a".repeat(64), provider: "fixture", model: "local", fallbacks: [] } },
      allowTechnicalAmendments: false,
      resumeAfterClose: true,
    },
    budget: { roleLaunches: 3, providerRequests: 4, tokens: 1000, activeTimeMs: 60000, artifactBytes: 1024 * 1024 },
    finalization: { requiredPredicates: ["snapshot-present"], independentReview: true },
    units: [{
      id: "snapshot",
      dependencies: [],
      kind: "check",
      role: "developer",
      inputs: [],
      outputs: ["snapshot"],
      acceptance: [{ id: "snapshot-present", kind: "artifact_hash", target: "snapshot" }],
      risk: "low",
      retryLimit: 0,
    }],
  };
}

// Test-only compiler: name each changed schema field instead of minting prose authority.
export function operatorChangeReceipt(store: MissionStore, mission: MissionInspection, next: MissionDefinition, questionId?: string) {
  const edits: Array<{ target: { kind: "mission" | "unit" | "predicate"; id?: string; field: string }; before: unknown; after: unknown }> = [];
  const add = (target: typeof edits[number]["target"], before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) edits.push({ target, before, after });
  };
  for (const key of Object.keys(mission.definition) as Array<keyof MissionDefinition>) {
    if (key === "units") continue;
    const before = mission.definition[key], after = next[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (before && after && typeof before === "object" && !Array.isArray(before) && !Array.isArray(after)) {
      for (const field of Object.keys(before)) {
        const oldValue = (before as Record<string, unknown>)[field];
        const newValue = (after as Record<string, unknown>)[field];
        add({ kind: "mission", field: `${key}/${field}` }, oldValue, newValue);
      }
    } else add({ kind: "mission", field: key }, before, after);
  }
  if (JSON.stringify(mission.definition.units.map(({ id }) => id)) !== JSON.stringify(next.units.map(({ id }) => id)))
    add({ kind: "mission", field: "units" }, mission.definition.units, next.units);
  else for (let index = 0; index < next.units.length; index++) {
    const old = mission.definition.units[index]!, changed = next.units[index]!;
    for (const key of Object.keys(old) as Array<keyof typeof old>) {
      if (key === "acceptance") {
        if (JSON.stringify(old.acceptance.map(({ id }) => id)) !== JSON.stringify(changed.acceptance.map(({ id }) => id)))
          add({ kind: "unit", id: old.id, field: "acceptance" }, old.acceptance, changed.acceptance);
        else for (let predicate = 0; predicate < old.acceptance.length; predicate++) {
          const a = old.acceptance[predicate]!, b = changed.acceptance[predicate]!;
          if (JSON.stringify(Object.keys(a)) !== JSON.stringify(Object.keys(b)))
            add({ kind: "unit", id: old.id, field: "acceptance" }, old.acceptance, changed.acceptance);
          else for (const field of Object.keys(a) as Array<keyof typeof a>)
            add({ kind: "predicate", id: a.id, field }, a[field], b[field]);
        }
      } else add({ kind: "unit", id: old.id, field: key }, old[key], changed[key]);
    }
  }
  const detail = questionId ? `answer ${questionId} ${JSON.stringify(edits)}` : `set ${JSON.stringify(edits)}`;
  return recordOperatorChoice(store, mission, "owner", `/mission revise ${mission.planId} ${detail}`, detail);
}

export interface MissionFixture {
  base: string;
  root: string;
  planFile: string;
  definitionFile: string;
  stateDir: string;
  dbPath: string;
  objectDir: string;
  planBytes: Buffer;
  definitionBytes: Buffer;
  commandId: string;
  receiptId: string;
}

export function createMissionFixture(prefix = "pitako-mission-", parentDirectory = tmpdir()): MissionFixture {
  const base = mkdtempSync(path.join(parentDirectory, prefix));
  const root = path.join(base, "repo");
  const planDirectory = path.join(root, ".pitako", "plans");
  mkdirSync(planDirectory, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial", "-q"], { cwd: root });
  const planFile = path.join(planDirectory, "durable-fixture.md");
  const definitionFile = path.join(planDirectory, "durable-fixture.mission.json");
  const planBytes = Buffer.from("---\r\nid: durable-fixture\r\nrevision: 1\r\nstatus: frozen\r\nexecution: expected\r\n---\r\n\r\n# Exact snapshot  \r\n", "utf8");
  const definitionBytes = Buffer.from(`${JSON.stringify(missionDefinition(), null, 2)}\n`, "utf8");
  writeFileSync(planFile, planBytes);
  writeFileSync(definitionFile, definitionBytes);
  const stateDir = path.join(base, "state");
  const dataDir = path.join(stateDir, "pitako");
  const objectDir = path.join(dataDir, "missions", "objects");
  return {
    base,
    root,
    planFile,
    definitionFile,
    stateDir,
    dbPath: path.join(dataDir, "missions.db"),
    objectDir,
    planBytes,
    definitionBytes,
    commandId: randomUUID(),
    receiptId: randomUUID(),
  };
}

export async function openFixtureStore(fixture: MissionFixture, onDurabilityBoundary?: (boundary: string) => void) {
  return openMissionStore({ dbPath: fixture.dbPath, objectDir: fixture.objectDir, onDurabilityBoundary });
}

export function missionInput(fixture: MissionFixture, overrides: Record<string, unknown> = {}) {
  return {
    repositoryRoot: fixture.root,
    planId: "durable-fixture",
    planFile: fixture.planFile,
    definitionFile: fixture.definitionFile,
    commandId: fixture.commandId,
    admissionReceiptId: fixture.receiptId,
    ...overrides,
  };
}
