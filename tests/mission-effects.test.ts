import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createMissionToolAdapters, MissionEffects, type MissionEffectReceipt } from "../extensions/mission/effects.ts";
import { MissionEngine, type MissionRoleRunner } from "../extensions/mission/engine.ts";
import { createMissionWorkspace, currentProcessIdentity, ownerProcessState, preflightContainment, processesInNamespace, readOwnedNamespaceInit, restoreWorkspaceImageAsync } from "../extensions/mission/workspace.ts";
import { loadPitako } from "../scripts/load-pitako.ts";
import { packageRoot } from "../extensions/stack.ts";
import { fixtureCommandTime, createMissionFixture, missionDefinition, missionInput, openFixtureStore, type MissionFixture } from "./mission-fixtures.ts";
import { missionCompletionBlockers } from "../extensions/mission/completion.ts";
import { missionHasUnresolvedEffects, reconcileMission } from "../extensions/mission/reconcile.ts";
import { openMissionStore } from "../extensions/mission/store.ts";
import type { AgentRunResult } from "../extensions/agent/run.ts";
import { PhysicalObservation } from "../extensions/mission/physical-observation.ts";

const fixtures: MissionFixture[] = [];
const temporaryDirs: string[] = [];
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
type SdkFixtureOwner = { case: "patch" | "reload"; state: "pending" | "failed" };
const sdkFixtureOwners = new Set<SdkFixtureOwner>();

async function withSdkFixtureOwner(which: SdkFixtureOwner["case"], body: () => Promise<void>): Promise<void> {
  const owner: SdkFixtureOwner = { case: which, state: "pending" };
  sdkFixtureOwners.add(owner);
  try {
    await body();
    sdkFixtureOwners.delete(owner);
  } catch (error) {
    owner.state = "failed";
    throw error;
  }
}

function requireSdkFixturesReleased(stop: (code: number) => never = (code) => process.exit(code)): void {
  if (sdkFixtureOwners.size === 0) return;
  try {
    writeSync(2, `Effects SDK fixture ownership unresolved: ${JSON.stringify({
      owners: [...sdkFixtureOwners],
      fixtures: fixtures.map(({ base }) => base),
      temporaryDirs,
    }).slice(0, 8192)}\n`);
  } finally {
    stop(1);
  }
}

afterEach(() => {
  requireSdkFixturesReleased();
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  for (const fixture of fixtures.splice(0)) rmSync(fixture.base, { recursive: true, force: true });
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function cancelledResult(): AgentRunResult {
  return {
    instanceId: "shutdown-fixture",
    role: "developer",
    status: "cancelled",
    model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
    result: "cancelled during Pi reload",
    usage: { input: 0, output: 0, turns: 0, toolCalls: 0 },
  };
}

function staleResult(): AgentRunResult {
  return {
    ...cancelledResult(),
    status: "completed",
    result: "late old-owner success",
  };
}

async function managedFixture(dependencies?: "source" | "candidate", operations = ["bash", "write"]) {
  const fixture = createMissionFixture("pitako-mission-effects-");
  fixtures.push(fixture);
  mkdirSync(path.join(fixture.root, "src"));
  writeFileSync(path.join(fixture.root, "src", "target.txt"), "source sentinel\n");
  const { execFileSync } = await import("node:child_process");
  if (dependencies) {
    writeFileSync(path.join(fixture.root, ".gitignore"), "node_modules/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: fixture.root, stdio: "ignore" });
    if (dependencies === "source") {
      mkdirSync(path.join(fixture.root, "node_modules"));
      writeFileSync(path.join(fixture.root, "node_modules", "sentinel"), "borrowed runtime\n");
    }
  }
  execFileSync("git", ["add", "src/target.txt"], { cwd: fixture.root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "source", "-q"], { cwd: fixture.root, stdio: "ignore" });
  const definition = missionDefinition();
  definition.authority.allowedPaths = dependencies ? ["src/**", "node_modules/**"] : ["src/**"];
  definition.authority.operations = operations;
  definition.budget.artifactBytes = 3_000_000;
  fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
  writeFileSync(fixture.definitionFile, fixture.definitionBytes);
  const store = await openFixtureStore(fixture);
  const mission = store.createMission(missionInput(fixture));
  const workspace = await createMissionWorkspace({
    missionId: mission.id,
    attemptId: "32345678-1234-4234-8234-123456789abc",
    sourceRoot: fixture.root,
    storeRoot: store.storageRoot,
    candidateParent: path.join(fixture.stateDir, "pitako-candidates"),
    allowedPaths: definition.authority.allowedPaths,
  });
  await preflightContainment(workspace);
  return { fixture, store, mission, workspace };
}

describe("managed mission retirement", () => {
  test("awaited host restoration preserves image modes/index and fences partial revoked work", async () => {
    const { store, workspace } = await managedFixture();
    const index = readFileSync(path.join(workspace.candidateGitDir, "index"));
    let markers = 0;
    const timer = setInterval(() => markers++, 1);
    try {
      await restoreWorkspaceImageAsync(workspace, [
        { path: "src/target.txt", kind: "missing", mode: null, bytes: null },
        { path: "src/nested", kind: "directory", mode: 0o700, bytes: null },
        { path: "src/nested/executable", kind: "file", mode: 0o755, bytes: Buffer.from("restored") },
        { path: "src/link", kind: "symlink", mode: 0o777, bytes: Buffer.from("nested/executable") },
      ], () => {});
      expect(markers).toBeGreaterThan(0);
      expect(existsSync(path.join(workspace.candidateRoot, "src/target.txt"))).toBe(false);
      expect(readFileSync(path.join(workspace.candidateRoot, "src/nested/executable"), "utf8")).toBe("restored");
      expect(lstatSync(path.join(workspace.candidateRoot, "src/nested/executable")).mode & 0o777).toBe(0o755);
      expect(readlinkSync(path.join(workspace.candidateRoot, "src/link"))).toBe("nested/executable");
      expect(readFileSync(path.join(workspace.candidateGitDir, "index")).equals(index)).toBe(true);
      await expect(restoreWorkspaceImageAsync(workspace, [
        { path: "src/link/escape", kind: "file", mode: 0o600, bytes: Buffer.from("no") },
      ], () => {})).rejects.toThrow();
      workspace.setupIndependent = true;
      await expect(restoreWorkspaceImageAsync(workspace, [
        { path: "node_modules/output", kind: "file", mode: 0o600, bytes: Buffer.from("no") },
      ], () => {})).rejects.toThrow("unresolved setup output");
      let checks = 0;
      await expect(restoreWorkspaceImageAsync(workspace, [
        { path: "src/a", kind: "file", mode: 0o600, bytes: Buffer.from("first") },
        { path: "src/z", kind: "file", mode: 0o600, bytes: Buffer.from("must not publish") },
      ], () => { if (++checks > 8) throw new Error("fixture authority revoked"); }))
        .rejects.toThrow("fixture authority revoked");
      expect(existsSync(path.join(workspace.candidateRoot, "src/z"))).toBe(false);
    } finally { clearInterval(timer); store.close(); }
  });

  test.each(["explicit-consumed", "missing", "mismatched", "revoked"] as const)(
    "production finite release rejects %s without GO or replacement authority", async scenario => {
    const { fixture, store, mission, workspace } = await managedFixture(undefined, ["bash"]);
    let clock = 0;
    let receipt: MissionEffectReceipt | undefined;
    let candidateRoot = "";
    let reservationsAtRegistration = 0;
    const engine = new MissionEngine({ store, missionId: mission.id, now: () => clock,
      sessionsDirectory: path.join(fixture.base, "sessions"),
      managedWorkspace: { sourceRoot: fixture.root, candidateParent: path.join(fixture.base, "production-candidates") },
      runRole: async (_input, durable) => {
        candidateRoot = durable.cwd!;
        receipt = await durable.effects!.invoke("bash", { command: "printf forbidden > src/release.txt",
          ...(scenario === "explicit-consumed" ? { timeoutMs: 1000 } : {}) });
        engine["activeWindow"] = undefined;
        return cancelledResult();
      } });
    const append = store.appendTransition.bind(store);
    store.appendTransition = (id, version, transition) => {
      const result = append(id, version, transition);
      if (transition.events.some(row => row.kind === "effect.process.registered")) {
        reservationsAtRegistration = store.inspectMission(mission.id).events
          .filter(row => row.kind === "reservation.created" && row.payload.resource === "active-time-ms").length;
        const grant = engine["activeWindow"]!;
        if (scenario === "explicit-consumed") clock = grant.grantAmount - 100;
        if (scenario === "missing") {
          const current = store.inspectMission(mission.id);
          append(mission.id, current.version, { events: [{
            revision: 1, kind: "budget.reservation.settled", causalId: randomUUID(), payload: {
              reservationId: grant.reservationId, resource: "active-time-ms", knownCharge: 0,
              unknownCharge: 0, released: grant.grantAmount, source: "fixture removes current reservation",
            },
          }] });
          expect(store.inspectMission(mission.id).reservations.some(row => row.id === grant.reservationId)).toBe(false);
        } else if (scenario !== "explicit-consumed") {
          const current = store.inspectMission(mission.id);
          append(mission.id, current.version, { events: [{
            revision: 1, kind: "budget.reservation.settled", causalId: randomUUID(), payload: {
              reservationId: grant.reservationId, resource: "active-time-ms",
              knownCharge: scenario === "mismatched" ? 1 : 0, unknownCharge: 0,
              released: scenario === "revoked" ? grant.grantAmount - 1 : 0, source: "fixture authority withdrawal",
            },
          }] });
        }
      }
      return result;
    };
    try {
      engine.start(); await engine.waitForIdle();
      expect(receipt?.status, JSON.stringify(receipt)).toBe("failed");
      expect(receipt?.reason).toContain(scenario === "explicit-consumed" ? "available ordinary active-time capacity" : "reservation revoked");
      const current = store.inspectMission(mission.id);
      expect(current.events.some(row => row.kind === "effect.process.registered")).toBe(true);
      expect(current.events.some(row => row.kind === "effect.released")).toBe(false);
      expect(reservationsAtRegistration).toBeGreaterThan(0);
      const registered = current.events.find(row => row.kind === "effect.process.registered")!;
      expect(current.events.filter(row => row.seq > registered.seq &&
        row.kind === "reservation.created" && row.payload.resource === "active-time-ms")).toHaveLength(0);
      expect(existsSync(path.join(candidateRoot, "src/release.txt"))).toBe(false);
      expect(missionHasUnresolvedEffects(store, current.events)).toBe(true);
    } finally {
      // This intentionally damaged reservation fixture cannot settle its accounting normally.
      engine["activeWindow"] = undefined;
      await engine.retireForShutdown("quit");
      store.close();
    }
  }, 30000);

  test.each(["control", "result", "ticks"] as const)(
    "production finalization and completion consumers fence %s during physical observation", async scenario => {
    const { fixture, store, mission } = await managedFixture(undefined, ["bash"]);
    const engine = new MissionEngine({ store, missionId: mission.id,
      sessionsDirectory: path.join(fixture.base, "sessions"),
      managedWorkspace: { sourceRoot: fixture.root, candidateParent: path.join(fixture.base, "candidates") },
      runRole: async () => cancelledResult() });
    const request = PhysicalObservation.prototype.request;
    let observations = 0;
    PhysicalObservation.prototype.request = async function<T>(operation: string, input: unknown,
      signal?: AbortSignal, deadline?: number): Promise<T> {
      const proof = await (request<T>).call(this, operation, input, signal, deadline);
      if (operation === "finalization" || operation === "completion") {
        observations++;
        const current = store.inspectMission(mission.id);
        store.appendTransition(mission.id, current.version, { events: [{
          revision: 1, kind: scenario === "control" ? "mission.import.conflict" :
            scenario === "result" ? "mission.finalization.generation" : "measurement.recorded",
          causalId: randomUUID(), payload: scenario === "ticks" ? {
            schemaVersion: 1, id: randomUUID(), missionId: mission.id, revision: 1, causalId: randomUUID(),
            metric: "active-time", value: 1, unit: "ms", source: "fixture tick",
            occurredAt: new Date().toISOString(), runtimeId: store.runtimeId, durationMs: 1,
            inputTokens: 0, outputTokens: 0,
          } : { generation: observations, reason: "concurrent relevant change" },
        }] });
      }
      return proof;
    };
    try {
      const finalization = engine["observeFinalization"](store.inspectMission(mission.id));
      if (scenario === "ticks") await finalization;
      else await expect(finalization).rejects.toThrow("finalization physical observation became stale");
      const completion = store.completeMission(mission.id, store.inspectMission(mission.id).version);
      await expect(completion).rejects.toThrow(scenario === "ticks" ?
        "mission completion blocked:" : "mission completion observation became stale");
      expect(observations).toBe(2);
      expect(store.inspectMission(mission.id).events.some(row => row.kind === "mission.completed")).toBe(false);
    } finally {
      PhysicalObservation.prototype.request = request;
      await engine.retireForShutdown("quit");
      store.close();
    }
  }, 30000);

  test("launch-release clock gives a short command its full interval after preparation", async () => {
    const { store, mission, workspace } = await managedFixture(undefined, ["bash"]);
    let released = false;
    const effects = new MissionEffects({
      store, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!,
      allowedOperations: ["bash"],
      observeFrontier: async () => { await new Promise(resolve => setTimeout(resolve, 700)); },
      commandTime: { contract: "launch-release-v2", admit: async requested => requested!,
        begin: async requested => { released = true; return { timeoutMs: requested!, reservationId: "fixture", executionAt: performance.now() }; }, remaining: () => 5000 },
    });
    try {
      const receipt = await effects.invoke("bash", { command: "sleep 0.12; printf released", timeoutMs: 500 });
      expect(released).toBe(true);
      expect(receipt).toMatchObject({ status: "completed", stdout: "released" });
      const rows = store.inspectMission(mission.id).events;
      expect(rows.find(row => row.kind === "effect.intent")!.payload.commandLifetime).toMatchObject({
        version: 2, timeoutBinding: "release-selection-v1", request: { kind: "explicit", timeoutMs: 500 },
        preparationTimeoutMs: 60000, bootstrapTimeoutMs: 10000,
      });
      expect(rows.find(row => row.kind === "effect.released")!.payload.commandLifetimeVersion).toBe(2);
    } finally { await effects.shutdown(); store.close(); }
  });

  test("mount preparation failure records a resolved denial and permits the next effect", async () => {
    if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
    const { store, mission, workspace } = await managedFixture();
    symlinkSync("target.txt", path.join(workspace.candidateRoot, "src", "alias.txt"));
    workspace.allowedPaths = ["src/alias.txt"];
    const effects = new MissionEffects({
      store, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!,
      allowedOperations: ["bash"], commandTime: fixtureCommandTime(),
    });
    try {
      const denied = await effects.invoke("bash", { command: "cat src/target.txt" });
      expect(denied.status).toBe("denied");
      expect(denied.reason).toContain("existing regular file");
      const inspection = store.inspectMission(mission.id);
      const rows = inspection.events.filter(({ effectId }) => effectId === denied.effectId);
      expect(rows.map(({ kind }) => kind)).toEqual(["effect.intent", "effect.invoking", "effect.receipt"]);
      expect(rows.at(-1)?.payload.process).toBeNull();
      expect(missionHasUnresolvedEffects(store, inspection.events)).toBe(false);
      workspace.allowedPaths = ["src/future.txt"];
      const read = await effects.invoke("bash", { command: "cat src/target.txt" });
      expect(read.status).toBe("completed");
      expect(read.stdout).toBe("source sentinel\n");
      expect(existsSync(path.join(workspace.candidateRoot, "src/future.txt"))).toBe(false);

      // A directory grant is prepared before the invalid grant; that mutation must remain unresolved.
      workspace.allowedPaths = ["src/new/**", "src/alias.txt"];
      await expect(effects.invoke("bash", { command: "true" })).rejects.toThrow("existing regular file");
      const changed = store.inspectMission(mission.id);
      expect(existsSync(path.join(workspace.candidateRoot, "src/new"))).toBe(true);
      expect(changed.events.at(-1)?.kind).toBe("effect.unknown");
      expect(missionHasUnresolvedEffects(store, changed.events)).toBe(true);
    } finally {
      await effects.shutdown();
      store.close();
    }
  }, 30_000);

  test("default launch release rejects revoked capacity without GO and retains registered-effect uncertainty", async () => {
    const { store, mission, workspace } = await managedFixture(undefined, ["bash"]);
    const effects = new MissionEffects({
      store, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!,
      allowedOperations: ["bash"], commandTime: {
        contract: "launch-release-v2", admit: async requested => requested,
        begin: async () => {
          throw new Error("effect time reservation revoked before launch release");
        },
        remaining: () => 10000,
      },
    });
    try {
      const rejected = await effects.invoke("bash", { command: "printf forbidden > src/revoked.txt" });
      expect(rejected.status).toBe("failed");
      expect(rejected.reason).toContain("reservation revoked");
      expect(existsSync(path.join(workspace.candidateRoot, "src/revoked.txt"))).toBe(false);
      const inspection = store.inspectMission(mission.id);
      expect(inspection.events.some(row => row.effectId === rejected.effectId && row.kind === "effect.released")).toBe(false);
      // Registration occurred, so this is not the closed process-null no-effect grammar.
      expect(missionHasUnresolvedEffects(store, inspection.events)).toBe(true);
    } finally { await effects.shutdown(); store.close(); }
  }, 30_000);

  test("official patch moves, fuzzy matching and failures retain private after-images and confinement", async () => {
    if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
    const { fixture, store, mission, workspace } = await managedFixture(undefined, ["apply_patch"]);
    const effects = new MissionEffects({
      store, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!,
      allowedOperations: ["apply_patch"],
      commandTime: fixtureCommandTime(),
    });
    const adapter = createMissionToolAdapters(effects).find(({ name }) => name === "apply_patch")!;
    try {
      const patch = "*** Begin Patch\n*** Update File: src/target.txt\n*** Move to: src/nested/moved.txt\n@@\n-  source sentinel  \n+moved output\n*** Add File: src/added.txt\n+first\n*** Add File: src/added.txt\n+last\n*** End Patch";
      const result = await adapter.execute("patch", { patch }, new AbortController().signal, () => {}, {} as never);
      expect((result.details as MissionEffectReceipt).status).toBe("completed");
      expect(result.content).toEqual([{ type: "text", text: "Applied patch:\nUpdated src/target.txt -> src/nested/moved.txt\nAdded src/added.txt\nAdded src/added.txt" }]);
      expect(existsSync(path.join(workspace.candidateRoot, "src/target.txt"))).toBe(false);
      expect(readFileSync(path.join(workspace.candidateRoot, "src/nested/moved.txt"), "utf8")).toBe("moved output\n");
      expect(readFileSync(path.join(workspace.candidateRoot, "src/added.txt"), "utf8")).toBe("last\n");
      const events = store.inspectMission(mission.id).events;
      const intent = events.find(({ kind }) => kind === "effect.intent")!;
      const plan = JSON.parse(store.readArtifact(String(intent.payload.effectPlanHash)).toString("utf8"));
      expect(plan.deterministic).toBe(true);
      expect(plan.targetPaths).toEqual(["src/target.txt", "src/nested/moved.txt", "src/added.txt"]);
      expect(plan.expectedAfterFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "src/target.txt", kind: "missing" }),
        expect.objectContaining({ path: "src/nested/moved.txt", bytesBase64: Buffer.from("moved output\n").toString("base64") }),
        expect.objectContaining({ path: "src/nested", kind: "directory" }),
      ]));
      const receipt = events.find(({ kind }) => kind === "effect.receipt")!;
      expect(receipt.payload.status).toBe("completed");
      expect(receipt.payload.paths).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "src/target.txt", after: expect.objectContaining({ kind: "missing" }) }),
        expect.objectContaining({ path: "src/nested/moved.txt", after: expect.objectContaining({ kind: "file" }) }),
      ]));
      const snapshot = events.find(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.phase === "effect")!;
      expect(store.readArtifact(String(snapshot.payload.imageHash)).length).toBeGreaterThan(0);
      expect(events.every(({ payload }) => payload.stdout === undefined)).toBe(true);

      const failed = await effects.invoke("apply_patch", { patch: "*** Begin Patch\n*** Add File: src/must-not-exist.txt\n+no\n*** Update File: src/added.txt\n@@\n-not present\n+no\n*** End Patch" });
      expect(failed.status).toBe("failed");
      expect(failed.stderr).toContain("Failed to find expected lines");
      expect(existsSync(path.join(workspace.candidateRoot, "src/must-not-exist.txt"))).toBe(false);
      const outside = await effects.invoke("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/added.txt\n*** Move to: forbidden.txt\n@@\n-last\n+no\n*** End Patch" });
      expect(outside.status).toBe("failed");
      expect(outside.stderr).toContain("outside mission allowedPaths");
      expect(existsSync(path.join(workspace.candidateRoot, "forbidden.txt"))).toBe(false);
      expect(readFileSync(path.join(workspace.candidateRoot, "src/added.txt"), "utf8")).toBe("last\n");

      symlinkSync("added.txt", path.join(workspace.candidateRoot, "src/alias.txt"));
      const alias = await effects.invoke("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/alias.txt\n@@\n-last\n+via alias\n*** End Patch" });
      expect(alias.status).toBe("completed");
      expect(readFileSync(path.join(workspace.candidateRoot, "src/added.txt"), "utf8")).toBe("via alias\n");
      writeFileSync(path.join(workspace.candidateRoot, "outside.txt"), "outside grant\n");
      symlinkSync("../outside.txt", path.join(workspace.candidateRoot, "src/outside-alias.txt"));
      const escape = await effects.invoke("apply_patch", { patch: "*** Begin Patch\n*** Add File: src/outside-alias.txt\n+must not escape\n*** End Patch" });
      expect(escape.status).toBe("failed");
      expect(readFileSync(path.join(workspace.candidateRoot, "outside.txt"), "utf8")).toBe("outside grant\n");
      expect(readFileSync(path.join(fixture.root, "src/target.txt"), "utf8")).toBe("source sentinel\n");
      effects.fence();
      expect((await effects.invoke("apply_patch", { patch })).status).toBe("denied");
    } finally {
      await effects.shutdown();
      store.close();
    }
  }, 30_000);

  test("managed Pi tool registry contains only the four fenced local adapters", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pitako-managed-tools-cwd-"));
    const agentDir = mkdtempSync(path.join(tmpdir(), "pitako-managed-tools-agent-"));
    temporaryDirs.push(cwd, agentDir);
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    const manager = SessionManager.inMemory(cwd);
    const effects = new MissionEffects({
      store: {} as never, workspace: {} as never, missionId: "12345678-1234-4234-8234-123456789abc",
      revision: 1, unitId: "unit", attemptId: "22345678-1234-4234-8234-123456789abc",
      runtimeId: "runtime", ownerEpoch: 1, allowedOperations: ["bash", "edit", "write", "apply_patch"],
      commandTime: fixtureCommandTime(),
    });
    const { session } = await createAgentSession({
      cwd, agentDir, sessionManager: manager, modelRuntime: runtime, customTools: createMissionToolAdapters(effects),
    });
    try {
      session.setActiveToolsByName(["bash", "edit", "write", "apply_patch"]);
      expect(session.getActiveToolNames().sort()).toEqual(["apply_patch", "bash", "edit", "write"]);
    } finally {
      session.dispose();
    }
  });

  test("never retries or accepts a completed attempt with an unresolved released effect", async () => {
    if (process.platform !== "linux" || !/^(x64|arm64)$/.test(process.arch) || !existsSync("/usr/bin/bwrap")) return;
    const { store, mission, fixture } = await managedFixture();
    const runRole: MissionRoleRunner = async ({ unit, binding }) => {
      const inspection = store.inspectMission(mission.id);
      const effectId = randomUUID();
      const owner = currentProcessIdentity(store.runtimeId, store.ownerEpoch!);
      const events = ["effect.intent", "effect.invoking", "effect.process.registered", "effect.released"].map((kind) => ({
        revision: binding.revision,
        kind,
        causalId: randomUUID(),
        effectId,
        unitId: unit.id,
        attemptId: binding.attemptId,
        payload: { effectId, operation: "write", owner, processIdentity: owner, requestHash: "a".repeat(64) },
      }));
      store.appendTransition(mission.id, inspection.version, { events: events as never });
      return {
        instanceId: "released-effect-fixture", role: "developer", status: "completed",
        model: { policyId: "developer", requestedModel: "fixture/local", selectedModel: "fixture/local" },
        result: "worker claims success despite its missing effect receipt", usage: { input: 1, output: 1, turns: 1, toolCalls: 1 },
      };
    };
    const engine = new MissionEngine({
      store,
      missionId: mission.id,
      sessionsDirectory: path.join(fixture.stateDir, "sessions"),
      runRole,
      managedWorkspace: { sourceRoot: fixture.root, candidateParent: path.join(fixture.stateDir, "pitako-candidates") },
      assessPredicate: () => ({ verdict: "pass", method: "fixture evidence" }),
    });
    try {
      engine.start();
      await engine.waitForIdle();
      const inspection = store.inspectMission(mission.id);
      expect(inspection.events.filter(({ kind }) => kind === "attempt.receipt")).toHaveLength(1);
      expect(inspection.events.filter(({ kind }) => kind === "unit.accepted")).toHaveLength(0);
      expect(inspection.events.filter(({ kind }) => kind === "unit.ready")).toHaveLength(1);
      expect(inspection.events.some(({ kind, payload }) => kind === "mission.blocked" && String(payload.reason).includes("unresolved local effect"))).toBe(true);
      expect(engine.snapshot().units.snapshot?.status).toBe("blocked");
    } finally {
      await engine.close();
      store.close();
    }
  });

  test("clean owner release records a resumable pause after confirming quiescence", async () => {
    const fixture = createMissionFixture("pitako-mission-clean-release-");
    fixtures.push(fixture);
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    const engine = new MissionEngine({
      store,
      missionId: mission.id,
      sessionsDirectory: path.join(fixture.stateDir, "sessions"),
      runRole: async () => { throw new Error("clean shutdown must not launch a worker"); },
      assessPredicate: () => ({ verdict: "pass", method: "fixture evidence" }),
    });
    await engine.retireForShutdown("clean-session-close");
    const reopened = await openFixtureStore(fixture);
    try {
      const release = reopened.inspectMission(mission.id).events.find(({ kind }) => kind === "mission.owner.released");
      expect(release?.payload).toMatchObject({ effectsQuiescent: true, resumablePause: true, reason: "clean-session-close" });
    } finally { reopened.close(); }
  });

  test("shutdown fences an effect waiting at the durable intent boundary before process launch", async () => {
    if (process.platform !== "linux" || !/^(x64|arm64)$/.test(process.arch) || !existsSync("/usr/bin/bwrap")) return;
    const { store, mission, workspace } = await managedFixture();
    let effects!: MissionEffects;
    let shutdown!: Promise<void>;
    const journal = {
      runtimeId: store.runtimeId,
      ownerEpoch: store.ownerEpoch,
      inspectMission: store.inspectMission.bind(store),
      appendTransition(id: string, expected: number, transition: Parameters<typeof store.appendTransition>[2]) {
        const inserted = store.appendTransition(id, expected, transition);
        if (transition.events.some(({ kind }) => kind === "effect.intent")) {
          queueMicrotask(() => {
            expect(effects.quiescent).toBe(false);
            shutdown = effects.shutdown();
          });
        }
        return inserted;
      },
    };
    effects = new MissionEffects({
      store: journal as never, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!, allowedOperations: ["write"],
      commandTime: fixtureCommandTime(),
    });
    try {
      const invocation = effects.invoke("write", { path: "src/target.txt", content: "must not launch" });
      expect((await invocation).status).toBe("denied");
      await shutdown;
      const events = store.inspectMission(mission.id).events.filter(({ kind }) => kind.startsWith("effect."));
      expect(events.map(({ kind }) => kind)).toEqual(["effect.intent", "effect.receipt"]);
      expect(events.at(-1)?.payload.status).toBe("denied");
      expect(events.some(({ kind }) => kind === "effect.process.registered" || kind === "effect.released")).toBe(false);
      expect(workspace.containmentProof).toBeTruthy();
    } finally {
      await effects.shutdown();
      store.close();
    }
  });

  test("real invoking-boundary fence writes a denied receipt and stays no-effect across repeated recovery", async () => {
    if (process.platform !== "linux" || !/^(x64|arm64)$/.test(process.arch) || !existsSync("/usr/bin/bwrap")) return;
    const { store, mission, workspace, fixture } = await managedFixture();
    let effects!: MissionEffects;
    let shutdown!: Promise<void>;
    const journal = {
      runtimeId: store.runtimeId,
      ownerEpoch: store.ownerEpoch,
      inspectMission: store.inspectMission.bind(store),
      appendTransition(id: string, expected: number, transition: Parameters<typeof store.appendTransition>[2]) {
        const inserted = store.appendTransition(id, expected, transition);
        if (transition.events.some(({ kind }) => kind === "effect.invoking")) {
          queueMicrotask(() => { shutdown = effects.shutdown(); });
        }
        return inserted;
      },
    };
    effects = new MissionEffects({
      store: journal as never, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!, allowedOperations: ["write"],
      commandTime: fixtureCommandTime(),
    });
    try {
      const receipt = await effects.invoke("write", { path: "src/target.txt", content: "must not launch" });
      await shutdown;
      expect(receipt).toMatchObject({ status: "denied", paths: [] });
      const events = store.inspectMission(mission.id).events.filter(({ kind }) => kind.startsWith("effect."));
      expect(events.map(({ kind }) => kind)).toEqual(["effect.intent", "effect.invoking", "effect.receipt"]);
      expect(events[2]?.payload).toMatchObject({ status: "denied", process: null, paths: [] });
      expect(readFileSync(path.join(workspace.candidateRoot, "src/target.txt"), "utf8")).toBe("source sentinel\n");
      expect(missionCompletionBlockers(store.inspectMission(mission.id), store).filter((item) => item.startsWith("effect:"))).toEqual([]);
      const current = store.inspectMission(mission.id);
      store.appendTransition(mission.id, current.version, { events: [{
        revision: current.revision, kind: "mission.owner.released", causalId: randomUUID(),
        payload: { owner: currentProcessIdentity(store.runtimeId, store.ownerEpoch!),
          effectsQuiescent: true, resumablePause: false, interruptedAttempts: [] },
      }] });
    } finally {
      await effects.shutdown();
      store.close();
    }
    const next = await openFixtureStore(fixture);
    try {
      for (const trigger of ["denied-first", "denied-second"]) {
        const report = await reconcileMission({ store: next, missionId: mission.id, sourceRoot: fixture.root,
          planFile: fixture.planFile, trigger });
        expect(report.status).toBe("resumed");
        expect(report.effects.map((effect) => effect.disposition)).toEqual(["unstarted"]);
        const inspection = next.inspectMission(mission.id);
        expect(missionHasUnresolvedEffects(next, inspection.events)).toBe(false);
        expect(missionCompletionBlockers(inspection, next).filter((item) => item.startsWith("effect:"))).toEqual([]);
      }
      const reader = await openMissionStore({ dbPath: fixture.dbPath, objectDir: fixture.objectDir, readOnly: true });
      try {
        expect(missionCompletionBlockers(reader.inspectMission(mission.id), reader)
          .filter((item) => item.startsWith("effect:"))).toEqual([]);
      } finally { reader.close(); }
    } finally { next.close(); }
  });

  test("interrupts a real partial write, retains per-path evidence, and empties the PID namespace", async () => {
    if (process.platform !== "linux" || !/^(x64|arm64)$/.test(process.arch) || !existsSync("/usr/bin/bwrap")) return;
    const { store, mission, workspace, fixture } = await managedFixture("source");
    const effects = new MissionEffects({
      store, workspace, missionId: mission.id, revision: 1, unitId: "snapshot", attemptId: workspace.attemptId,
      runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!, allowedOperations: ["bash"],
      commandTime: fixtureCommandTime(),
    });
    const controller = new AbortController();
    try {
      for (let launch = 0; launch < 2; launch++) {
        const readonly = await effects.invoke("bash", {
          command: "cat node_modules/sentinel; printf changed > node_modules/sentinel",
          timeoutMs: 5_000,
        });
        expect(readonly.status).toBe("failed");
        expect(readonly.exitCode).not.toBe(0);
        expect(readonly.stdout).toBe("borrowed runtime\n");
        expect(readonly.stderr).toContain("Read-only file system");
        expect(readonly.paths).toEqual([]);
        expect(missionHasUnresolvedEffects(store, store.inspectMission(mission.id).events)).toBe(false);
        expect(readFileSync(path.join(fixture.root, "node_modules", "sentinel"), "utf8")).toBe("borrowed runtime\n");
      }
    } catch (error) {
      await effects.shutdown();
      store.close();
      throw error;
    }
    const invocation = effects.invoke("bash", {
      command: "printf partial > /tmp/pitako/workspace/src/partial.txt; sleep 30; printf late > /tmp/pitako/workspace/src/late.txt",
      timeoutMs: 60_000,
    }, controller.signal);
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(path.join(workspace.candidateRoot, "src", "partial.txt")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(path.join(workspace.candidateRoot, "src", "partial.txt"))).toBe(true);
      controller.abort(new Error("Pi reload"));
      const receipt = await invocation;
      expect(receipt.status).toBe("failed");
      expect(receipt.termination).toBe("signal");
      expect(receipt.paths).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "src/partial.txt", after: expect.objectContaining({ kind: "file" }) }),
      ]));
      expect(existsSync(path.join(workspace.candidateRoot, "src", "partial.txt"))).toBe(true);
      expect(existsSync(path.join(workspace.candidateRoot, "src", "late.txt"))).toBe(false);
      expect(processesInNamespace(String(receipt.process?.pidNamespace))).toEqual([]);
      const failed = await effects.invoke("bash", {
        command: "printf retained > /tmp/pitako/workspace/src/nonzero.txt; exit 7",
        timeoutMs: 5_000,
      });
      expect(failed.status).toBe("failed");
      expect(failed.exitCode).toBe(7);
      expect(failed.paths).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "src/nonzero.txt", after: expect.objectContaining({ kind: "file" }) }),
      ]));
      expect(readFileSync(path.join(fixture.root, "src", "target.txt"), "utf8")).toBe("source sentinel\n");
    } finally {
      controller.abort();
      await effects.shutdown();
      store.close();
    }
    const unbacked = await managedFixture("candidate");
    const candidateEffects = new MissionEffects({
      store: unbacked.store, workspace: unbacked.workspace, missionId: unbacked.mission.id, revision: 1,
      unitId: "snapshot", attemptId: unbacked.workspace.attemptId, runtimeId: unbacked.store.runtimeId,
      ownerEpoch: unbacked.store.ownerEpoch!, allowedOperations: ["bash"],
      commandTime: fixtureCommandTime(),
    });
    let recoveredStore: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
    try {
      const ignored = await candidateEffects.invoke("bash", {
        command: "printf retained > node_modules/sentinel; exit 17", timeoutMs: 5_000,
      });
      expect(readFileSync(path.join(unbacked.workspace.candidateRoot, "node_modules", "sentinel"), "utf8")).toBe("retained");
      expect(ignored).toMatchObject({ status: "unknown", exitCode: 17, termination: "exit" });
      expect(ignored.paths).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "node_modules/sentinel", after: expect.objectContaining({ kind: "file" }) }),
      ]));
      expect(ignored.reason).toContain("node_modules/sentinel");
      expect(unbacked.workspace.quarantined).toBe(true);
      expect(processesInNamespace(String(ignored.process?.pidNamespace))).toEqual([]);
      let inspection = unbacked.store.inspectMission(unbacked.mission.id);
      expect(inspection.events.some(({ kind, effectId }) => kind === "effect.unknown" && effectId === ignored.effectId)).toBe(true);
      expect(inspection.events.some(({ kind, effectId }) => kind === "effect.receipt" && effectId === ignored.effectId)).toBe(false);
      expect(missionHasUnresolvedEffects(unbacked.store, inspection.events)).toBe(true);
      expect(missionCompletionBlockers(inspection, unbacked.store)).toContain(`effect:${ignored.effectId}`);
      await candidateEffects.shutdown();
      const retirement = new MissionEngine({
        store: unbacked.store, missionId: unbacked.mission.id,
        sessionsDirectory: path.join(unbacked.fixture.stateDir, "sessions"),
        runRole: async () => { throw new Error("retirement must not launch a worker"); },
      });
      await retirement.retireForShutdown("ignored-output-close");
      recoveredStore = await openFixtureStore(unbacked.fixture);
      for (const trigger of ["ignored-first", "ignored-second"]) {
        const report = await reconcileMission({ store: recoveredStore, missionId: unbacked.mission.id,
          sourceRoot: unbacked.fixture.root, planFile: unbacked.fixture.planFile, trigger });
        expect(report.effects.find(({ effectId }) => effectId === ignored.effectId)?.disposition).toBe("unknown");
        inspection = recoveredStore.inspectMission(unbacked.mission.id);
        expect(missionHasUnresolvedEffects(recoveredStore, inspection.events)).toBe(true);
      }
    } finally {
      await candidateEffects.shutdown();
      recoveredStore?.close();
      unbacked.store.close();
    }
  });

  test("adapter abort records actual signal termination only after physical close and namespace drain", async () => {
    if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
    const { store, mission, workspace } = await managedFixture();
    const controller = new AbortController();
    let captured = false;
    const journal = {
      runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch,
      inspectMission: store.inspectMission.bind(store),
      appendTransition(id: string, expected: number, transition: Parameters<typeof store.appendTransition>[2]) {
        const inserted = store.appendTransition(id, expected, transition);
        const released = transition.events.find(({ kind }) => kind === "effect.released");
        if (released) {
          const identity = released.payload.processIdentity as any;
          const root = identity.ancestry.find((row: { pid: number }) => row.pid === identity.namespaceInit.pid);
          expect(readOwnedNamespaceInit(identity.pidNamespace, root, identity)).toEqual(identity.namespaceInit);
          captured = true;
          queueMicrotask(() => controller.abort(new Error("adapter stop")));
        }
        return inserted;
      },
    };
    const effects = new MissionEffects({
      store: journal as never, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!,
      allowedOperations: ["write"],
      commandTime: fixtureCommandTime(),
    });
    try {
      const receipt = await effects.invoke("write", { path: "src/target.txt", content: "must not finish" }, controller.signal);
      expect(receipt.status).toBe("failed");
      expect(receipt.termination).toBe("signal");
      expect(receipt.process).toMatchObject({ descendantsQuiescent: true, namespaceEmptyAfterExit: true });
      expect(processesInNamespace(String(receipt.process?.pidNamespace))).toEqual([]);
      expect(effects.quiescent).toBe(true);
      const events = store.inspectMission(mission.id).events;
      expect(captured).toBe(true);
      const registered = events.find(({ kind }) => kind === "effect.process.registered")!.payload.identity as any;
      expect(events.find(({ kind }) => kind === "effect.released")!.payload.processIdentity).toEqual(registered);
      expect(receipt.process?.namespaceInit).toEqual(registered.namespaceInit);
      expect(ownerProcessState({ ...registered, ...registered.namespaceInit })).toBe("dead");
      expect(events.find(({ kind }) => kind === "effect.receipt")?.payload.termination).toBe("signal");
      expect(events.some(({ kind }) => kind === "effect.unknown")).toBe(false);
      expect(events.some(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.phase === "effect")).toBe(true);
    } finally {
      await effects.shutdown();
      store.close();
    }
  });

  for (const exhausted of ["invocation", "enclosing-zero", "enclosing-insufficient"] as const) {
    test(`pre-child launch denies ${exhausted} authority with a durable null-process receipt`, async () => {
      const { store, mission, workspace } = await managedFixture(undefined, ["bash"]);
      const bwrapPath = workspace.bwrapPath;
      // Reach launcher preparation after the real off-thread physical reads, then
      // expire the legacy invocation there rather than racing those reads.
      const invocationTimeMs = 2000;
      let prepared = false;
      Object.defineProperty(workspace, "bwrapPath", { get() {
        prepared = true;
        if (exhausted === "invocation") {
          const until = performance.now() + invocationTimeMs + 50;
          while (performance.now() < until) { /* synchronous launcher preparation */ }
        }
        return bwrapPath;
      } });
      const effects = new MissionEffects({ store, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
        attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!,
        allowedOperations: ["bash"], commandTime: {
          admit: async (requested) => requested!,
          remaining: () => exhausted === "invocation" ? 20000 : exhausted === "enclosing-zero" ? 0 : 1,
        } });
      try {
        const receipt = await effects.invoke("bash", { command: "printf must-not-run > src/not-launched", timeoutMs: exhausted === "invocation" ? invocationTimeMs : 10000 });
        expect(prepared).toBe(true);
        expect(receipt).toMatchObject({ status: "denied", paths: [], reason: "command timeout exceeds current remaining effect time grant" });
        const events = store.inspectMission(mission.id).events.filter(row => row.effectId === receipt.effectId);
        expect(events.map(row => row.kind)).toEqual(["effect.intent", "effect.invoking", "effect.receipt"]);
        expect(events.at(-1)!.payload.process).toBeNull();
        expect(existsSync(path.join(workspace.candidateRoot, "src/not-launched"))).toBe(false);
        expect(effects.quiescent).toBe(true);
        if (process.env.MISSION_TIME_EVIDENCE) {
          mkdirSync(process.env.MISSION_TIME_EVIDENCE, { recursive: true });
          writeFileSync(path.join(process.env.MISSION_TIME_EVIDENCE, `pre-child-${exhausted}.json`), JSON.stringify({ receipt, events }, null, 2));
        }
      } finally { await effects.shutdown(); store.close(); }
    });
  }

  test("T3 real executing command cancellation retires owned init and cannot become completed", async () => {
    const { store, mission, workspace } = await managedFixture(undefined, ["bash"]);
    const controller = new AbortController();
    const append = store.appendTransition.bind(store);
    store.appendTransition = (id, version, transition) => {
      const result = append(id, version, transition);
      if (transition.events.some(row => row.kind === "effect.released"))
        setTimeout(() => controller.abort("fixture command cancellation"), 150);
      return result;
    };
    const effects = new MissionEffects({ store, workspace, missionId: mission.id, revision: 1, unitId: "snapshot",
      attemptId: workspace.attemptId, runtimeId: store.runtimeId, ownerEpoch: store.ownerEpoch!,
      allowedOperations: ["bash"], commandTime: fixtureCommandTime(4000) });
    try {
      const receipt = await effects.invoke("bash", { command: "printf 'started\\n'; sleep 5", timeoutMs: 3000 }, controller.signal);
      expect(receipt).toMatchObject({ status: "failed", termination: "signal", stdout: "started\n",
        process: { descendantsQuiescent: true, namespaceEmptyAfterExit: true } });
      const events = store.inspectMission(mission.id).events;
      const registered = events.find(row => row.kind === "effect.process.registered")!.payload.identity as
        ReturnType<typeof currentProcessIdentity> & { namespaceInit: { pid: number; birthTicks: number }; pidNamespace: string };
      expect(processesInNamespace(registered.pidNamespace)).toEqual([]);
      expect(ownerProcessState({ ...registered, ...registered.namespaceInit })).toBe("dead");
      expect(effects.quiescent).toBe(true);
      expect(events.some(row => row.kind === "unit.accepted" || row.kind === "mission.completed")).toBe(false);
      if (process.env.MISSION_TIME_EVIDENCE) {
        mkdirSync(process.env.MISSION_TIME_EVIDENCE, { recursive: true });
        writeFileSync(path.join(process.env.MISSION_TIME_EVIDENCE, "command-cancel.json"), JSON.stringify({
          receipt, events, ownedInitState: "dead", namespaceProcesses: [],
        }, null, 2));
      }
    } finally { await effects.shutdown(); store.close(); }
  });

  test("real Pi reload awaits old owner retirement and fences its late result from the new epoch", async () => {
    if (process.platform !== "linux" || !process.arch.match(/^(x64|arm64)$/) || !existsSync("/usr/bin/bwrap")) return;
    return withSdkFixtureOwner("reload", async () => {
    const fixture = createMissionFixture("pitako-mission-reload-");
    fixtures.push(fixture);
    mkdirSync(path.join(fixture.root, "src"));
    writeFileSync(path.join(fixture.root, "src", "sentinel.txt"), "source remains untouched\n");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["add", "src/sentinel.txt"], { cwd: fixture.root, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "source", "-q"], { cwd: fixture.root, stdio: "ignore" });
    const definition = missionDefinition();
    definition.authority.allowedPaths = ["src/**"];
    definition.authority.operations = ["write"];
    definition.budget.artifactBytes = 3_000_000;
    fixture.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(fixture.definitionFile, fixture.definitionBytes);
    const store = await openFixtureStore(fixture);
    const mission = store.createMission(missionInput(fixture));
    const initialEpoch = store.ownerEpoch!;

    const loaded = await loadPitako(packageRoot(), fixture.root);
    temporaryDirs.push(loaded.agentDir);
    process.env.PI_CODING_AGENT_DIR = loaded.agentDir;
    const runtime = await ModelRuntime.create({ authPath: path.join(loaded.agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    const sessionManager = SessionManager.inMemory(fixture.root);
    const { session } = await createAgentSession({
      cwd: fixture.root,
      agentDir: loaded.agentDir,
      sessionManager,
      resourceLoader: loaded.loader,
      modelRuntime: runtime,
    });

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    let releaseLate!: (result: AgentRunResult) => void;
    const late = new Promise<AgentRunResult>((resolve) => { releaseLate = resolve; });
    const runRole: MissionRoleRunner = async (_input, durable) => {
      markStarted();
      durable.signal?.addEventListener("abort", () => markAborted(), { once: true });
      return late;
    };
    const ownerSessionId = sessionManager.getSessionId();
    if (!ownerSessionId) throw new Error("Pi session did not provide a stable owner ID");
    const engine = new MissionEngine({
      store,
      missionId: mission.id,
      sessionsDirectory: path.join(fixture.stateDir, "pitako", "sessions"),
      runRole,
      managedWorkspace: { sourceRoot: fixture.root, candidateParent: path.join(fixture.stateDir, "pitako-candidates") },
      ownerSessionId,
    });
    let reopened: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
    const originalSetTimeout = globalThis.setTimeout;
    try {
      engine.start();
      await started;
      globalThis.setTimeout = ((callback: TimerHandler, _delay?: number, ...args: unknown[]) =>
        originalSetTimeout(callback, 0, ...args)) as typeof setTimeout;
      await session.reload();
      globalThis.setTimeout = originalSetTimeout;
      await aborted;
      reopened = await openFixtureStore(fixture);
      const inspection = reopened.inspectMission(mission.id);
      const release = inspection.events.find(({ kind }) => kind === "mission.owner.released");
      expect(release?.payload.reason).toBe("reload");
      expect(release?.payload.effectsQuiescent).toBe(true);
      expect(release?.payload.owner).toMatchObject({ pid: process.pid, epoch: initialEpoch });
      expect(reopened.ownerEpoch).toBeGreaterThan(initialEpoch);
      const interrupted = inspection.events.find(({ kind }) => kind === "attempt.interrupted");
      expect(interrupted?.attemptId).toBeTruthy();
      const oldAttemptId = interrupted!.attemptId!;
      const eventCount = inspection.events.length;
      releaseLate(staleResult());
      await engine.waitForIdle();
      const afterLateResult = reopened.inspectMission(mission.id);
      expect(afterLateResult.events).toHaveLength(eventCount);
      expect(afterLateResult.events.some(({ kind, attemptId }) => kind === "attempt.receipt" && attemptId === oldAttemptId)).toBe(false);
      expect(afterLateResult.events.some(({ kind, unitId }) => kind === "unit.accepted" && unitId === "snapshot")).toBe(false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      releaseLate(cancelledResult());
      session.dispose();
      await engine.retireForShutdown("test-cleanup");
      reopened?.close();
      store.close();
    }
    });
  }, 60_000);
});
