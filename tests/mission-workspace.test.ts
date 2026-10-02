import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { MissionEffects } from "../extensions/mission/effects.ts";
import { missionDefinition, missionInput, createMissionFixture, openFixtureStore } from "./mission-fixtures.ts";
import type { MissionFixture } from "./mission-fixtures.ts";
import {
  captureWorkspacePaths, createMissionWorkspace, currentProcessIdentity, ownerProcessState,
  preflightContainment, processBirthTicks, processNamespaceId, processParentPid, processesInNamespace, readOwnedNamespaceInit, type MissionWorkspace,
} from "../extensions/mission/workspace.ts";
import { missionEffectProcessesQuiescent } from "../extensions/mission/reconcile.ts";

test("owned init lifetime refuses live, unknown, malformed, mismatched and legacy identities", () => {
  const owner = currentProcessIdentity("lifetime-check", 1);
  const launcherPid = process.ppid;
  const init = { pid: owner.pid, birthTicks: owner.birthTicks };
  const identity = { ...owner, pid: launcherPid, birthTicks: processBirthTicks(launcherPid),
    containedPid: 2, pidNamespace: processNamespaceId(process.pid), networkNamespace: "net:[1]",
    namespaceInit: init, ancestry: [{ ...init, parentPid: launcherPid }] };
  const check = (registered: Record<string, unknown>, released = registered) =>
    missionEffectProcessesQuiescent([
      { kind: "effect.process.registered", effectId: "effect", attemptId: "attempt", payload: { identity: registered } },
      { kind: "effect.released", effectId: "effect", attemptId: "attempt", payload: { processIdentity: released } },
    ], "attempt");
  expect(check(identity)).toBe(false);
  expect(check({ ...identity, hostId: "different-host" })).toBe(false);
  expect(check({ ...identity, namespaceInit: { pid: 0, birthTicks: 0 } })).toBe(false);
  expect(check({ ...identity, namespaceInit: { ...init, birthTicks: init.birthTicks + 1 } })).toBe(false);
  expect(check(identity, { ...identity, namespaceInit: { ...init, birthTicks: init.birthTicks + 1 } })).toBe(false);
  const { namespaceInit: _, ...legacy } = identity;
  expect(check(legacy)).toBe(false);
  // Same textual namespace is demonstrably occupied; the original birth has retired.
  const retired = { ...init, birthTicks: init.birthTicks + 1 };
  expect(check({ ...identity, namespaceInit: retired, ancestry: [{ ...retired, parentPid: launcherPid }] })).toBe(true);
  expect(check({ ...identity, namespaceInit: retired, ancestry: [{ ...retired, parentPid: launcherPid }], hostId: "different-host" })).toBe(false);
});

test("unproved namespace PID1 capture rejects before release", () => {
  const launcher = currentProcessIdentity("capture-check", 1);
  const root = { pid: process.pid, birthTicks: launcher.birthTicks, parentPid: processParentPid(process.pid) };
  expect(() => readOwnedNamespaceInit(processNamespaceId(process.pid), root, launcher)).toThrow();
  expect(() => readOwnedNamespaceInit("pid:[wrong]", root, launcher)).toThrow();
  expect(() => readOwnedNamespaceInit(processNamespaceId(process.pid), { ...root, birthTicks: root.birthTicks + 1 }, launcher)).toThrow();
  expect(() => readOwnedNamespaceInit(processNamespaceId(process.pid), { ...root, pid: 2147483647 }, launcher)).toThrow();
  expect(() => readOwnedNamespaceInit(processNamespaceId(process.pid), root, { ...launcher, hostId: "wrong-host" })).toThrow();
});

const fixtures: string[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }); });

function preserveCrashEvents(name: string, source: string): void {
  const directory = process.env.MISSION_T3_ARTIFACT_DIR;
  if (!directory || !existsSync(source)) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), readFileSync(source));
}

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), "pitako-mission-workspace-"));
  fixtures.push(base);
  const sourceRoot = path.join(base, "source");
  const storeRoot = path.join(base, "store");
  const candidateParent = path.join(base, "candidates");
  const otherCandidate = path.join(base, "other-candidate");
  mkdirSync(sourceRoot);
  mkdirSync(storeRoot);
  mkdirSync(candidateParent);
  mkdirSync(otherCandidate);
  writeFileSync(path.join(otherCandidate, "sentinel"), "other candidate state\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: sourceRoot, env: { PATH: process.env.PATH }, stdio: "ignore" });
  git(["init", "-q", "-b", "main"]);
  mkdirSync(path.join(sourceRoot, "src"));
  writeFileSync(path.join(sourceRoot, "src", "target.txt"), "baseline\n");
  git(["add", "src/target.txt"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline", "-q"]);
  writeFileSync(path.join(sourceRoot, "src", "target.txt"), "staged\n");
  git(["add", "src/target.txt"]);
  writeFileSync(path.join(sourceRoot, "src", "target.txt"), "dirty worktree\n");
  writeFileSync(path.join(sourceRoot, "src", "untracked.txt"), "untracked\n");
  symlinkSync("target.txt", path.join(sourceRoot, "src", "link.txt"));
  writeFileSync(path.join(storeRoot, "sentinel"), "sealed state\n");
  return { base, sourceRoot, storeRoot, candidateParent, otherCandidate, git };
}

function workspace(sample: ReturnType<typeof fixture>): MissionWorkspace {
  return createMissionWorkspace({
    missionId: "12345678-1234-4234-8234-123456789abc",
    attemptId: "22345678-1234-4234-8234-123456789abc",
    sourceRoot: sample.sourceRoot,
    storeRoot: sample.storeRoot,
    candidateParent: sample.candidateParent,
    otherCandidates: [sample.otherCandidate],
    allowedPaths: ["src/**"],
  });
}

const canContain = process.platform === "linux" && existsSync("/usr/bin/bwrap") && ["x64", "arm64"].includes(process.arch);

async function crashFixture(operations = ["bash"]): Promise<{ sample: MissionFixture; missionId: string; attemptId: string; storeRoot: string; candidateParent: string }> {
  const sample = createMissionFixture("pitako-effect-crash-");
  fixtures.push(sample.base);
  const git = (args: string[]) => execFileSync("git", args, { cwd: sample.root, stdio: "ignore" });
  mkdirSync(path.join(sample.root, "src"));
  writeFileSync(path.join(sample.root, "src", "target.txt"), "source sentinel\n");
  git(["add", "src/target.txt"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "workspace", "-q"]);
  const definition = missionDefinition();
  definition.authority.allowedPaths = ["src/**"];
  definition.authority.operations = operations;
  sample.definitionBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
  writeFileSync(sample.definitionFile, sample.definitionBytes);
  const store = await openFixtureStore(sample);
  const mission = store.createMission(missionInput(sample));
  const storeRoot = store.storageRoot;
  const inspection = store.inspectMission(mission.id);
  const epoch = store.ownerEpoch;
  if (epoch === null) throw new Error("crash fixture requires writer ownership");
  store.appendTransition(mission.id, inspection.version, { events: [{
    revision: inspection.revision,
    kind: "mission.owner.released",
    causalId: randomUUID(),
    payload: {
      owner: currentProcessIdentity(store.runtimeId, epoch),
      reason: "crash fixture setup complete",
      effectsQuiescent: true,
      resumablePause: false,
      interruptedAttempts: [],
    },
  }] });
  store.close();
  return {
    sample,
    missionId: mission.id,
    attemptId: "22345678-1234-4234-8234-123456789abc",
    storeRoot,
    candidateParent: path.join(sample.stateDir, "pitako-candidates"),
  };
}

describe("managed mission candidate containment", () => {
  test("production Node persists official patch preflight and sandbox Move receipts", async () => {
    if (!canContain) return;
    const { sample, missionId, attemptId, storeRoot, candidateParent } = await crashFixture(["apply_patch"]);
    const node = execFileSync("/bin/sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
    const eventLog = path.join(sample.base, "patch-events.jsonl");
    const metadataFile = path.join(sample.base, "candidate.json");
    const patch = "*** Begin Patch\n*** Update File: src/target.txt\n*** Move to: src/moved.txt\n@@\n- source sentinel \n+Node patch output\n*** End Patch";
    execFileSync(node, [path.resolve("tests/fixtures/mission-effect-crash-child.mjs")], {
      cwd: process.cwd(), timeout: 20_000,
      env: {
        ...process.env, T3_SOURCE: sample.root, T3_STORE: storeRoot, T3_CANDIDATES: candidateParent,
        T3_DB: sample.dbPath, T3_OBJECTS: sample.objectDir, T3_MISSION: missionId, T3_ATTEMPT: attemptId,
        T3_LOG: eventLog, T3_META: metadataFile, T3_OPERATION: "apply_patch", T3_EFFECT_INPUT: JSON.stringify({ patch }),
      },
    });
    const { candidateRoot } = JSON.parse(readFileSync(metadataFile, "utf8"));
    expect(existsSync(path.join(candidateRoot, "src/target.txt"))).toBe(false);
    expect(readFileSync(path.join(candidateRoot, "src/moved.txt"), "utf8")).toBe("Node patch output\n");
    const store = await openFixtureStore(sample);
    try {
      const events = store.inspectMission(missionId).events;
      const intent = events.find(({ kind }) => kind === "effect.intent")!;
      const plan = JSON.parse(store.readArtifact(String(intent.payload.effectPlanHash)).toString("utf8"));
      expect(plan.deterministic).toBe(true);
      expect(plan.expectedAfterFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "src/target.txt", kind: "missing" }),
        expect.objectContaining({ path: "src/moved.txt", bytesBase64: Buffer.from("Node patch output\n").toString("base64") }),
      ]));
      expect(events.find(({ kind }) => kind === "effect.receipt")?.payload.status).toBe("completed");
      expect(events.find(({ kind, payload }) => kind === "workspace.snapshot.sealed" && payload.phase === "effect")).toBeDefined();
      expect(readFileSync(path.join(sample.root, "src/target.txt"), "utf8")).toBe("source sentinel\n");
    } finally { store.close(); }
  }, 30_000);

  test("copies tracked, staged, dirty and untracked inputs without shared Git state", () => {
    if (process.platform !== "linux") {
      expect(() => workspace(fixture())).toThrow(/unsupported on/);
      return;
    }
    const sample = fixture();
    const candidate = workspace(sample);
    expect(readFileSync(path.join(candidate.candidateRoot, "src/target.txt"), "utf8")).toBe("dirty worktree\n");
    expect(readFileSync(path.join(candidate.candidateRoot, "src/untracked.txt"), "utf8")).toBe("untracked\n");
    expect(lstatSync(path.join(candidate.candidateRoot, "src/link.txt")).isSymbolicLink()).toBe(true);
    expect(candidate.manifest.indexEntries.some(({ path: name }) => name === "src/target.txt")).toBe(true);
    expect(execFileSync("git", ["status", "--porcelain=v2"], { cwd: candidate.candidateRoot, encoding: "utf8" })).toContain("MM N...");
    expect(existsSync(path.join(candidate.candidateGitDir, "commondir"))).toBe(false);
    expect(existsSync(path.join(candidate.candidateGitDir, "objects", "info", "alternates"))).toBe(false);
    expect(lstatSync(path.join(candidate.candidateRoot, "src/target.txt")).ino).not.toBe(lstatSync(path.join(sample.sourceRoot, "src/target.txt")).ino);
    expect(captureWorkspacePaths(candidate.candidateRoot).map(({ path: name }) => name)).toContain("src/untracked.txt");
  });

  test("gates contained write, edit, patch and bash tools; preserves source/store/Git sentinels", async () => {
    if (!canContain) return;
    const sample = fixture();
    const candidate = workspace(sample);
    const indexBefore = readFileSync(path.join(sample.sourceRoot, ".git", "index"));
    const sourceBefore = readFileSync(path.join(sample.sourceRoot, "src", "target.txt"));
    const sealedBefore = readFileSync(path.join(sample.storeRoot, "sentinel"));
    const otherCandidateBefore = readFileSync(path.join(sample.otherCandidate, "sentinel"));
    const proof = await preflightContainment(candidate);
    expect(proof.networkDisabled).toBe(true);
    expect(proof.candidateGitReadOnly).toBe(true);

    let version = 0;
    const events: Array<{ kind: string; effectId?: string; payload: Record<string, unknown> }> = [];
    const store = {
      runtimeId: "test-runtime",
      inspectMission() { return { version }; },
      appendTransition(_missionId: string, expected: number, transition: { events: typeof events }) {
        expect(expected).toBe(version);
        version += transition.events.length;
        events.push(...transition.events);
        return [];
      },
    };
    const effects = new MissionEffects({
      store: store as never,
      workspace: candidate,
      missionId: candidate.missionId,
      revision: 1,
      unitId: "unit",
      attemptId: candidate.attemptId,
      runtimeId: "test-runtime",
      ownerEpoch: 1,
      allowedOperations: ["write", "edit", "apply_patch", "bash"],
    });
    const write = await effects.invoke("write", { path: "src/target.txt", content: "candidate write\n" });
    expect(write.status).toBe("completed");
    const edit = await effects.invoke("edit", { path: "src/target.txt", oldText: "candidate", newText: "edited" });
    expect(edit.status).toBe("completed");
    const patch = await effects.invoke("apply_patch", {
      patch: "*** Begin Patch\n*** Add File: src/new.txt\n+patch output\n*** End Patch",
    });
    expect(patch.status).toBe("completed");
    const shell = await effects.invoke("bash", {
      command: [
        "printf ' bash output' >> /tmp/pitako/workspace/src/target.txt",
        "if printf bad > /tmp/pitako/source/sentinel; then exit 81; fi",
        "if printf bad > /tmp/pitako/store/sentinel; then exit 82; fi",
        "if printf bad > /tmp/pitako/other-0/sentinel; then exit 84; fi",
        "if printf bad > /tmp/pitako/workspace/.git/forbidden; then exit 83; fi",
        "setsid /bin/bash -c '(/bin/bash -c \"printf started > /tmp/pitako/workspace/src/descendant.started; sleep 30\" </dev/null >/dev/null 2>&1 &) </dev/null >/dev/null 2>&1 &' </dev/null >/dev/null 2>&1 & true",
        "for attempt in {1..100}; do test -e /tmp/pitako/workspace/src/descendant.started && break; sleep 0.01; done",
        "test -e /tmp/pitako/workspace/src/descendant.started",
        "if /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/1' 2>/dev/null; then exit 92; fi",
      ].join("; "),
      timeoutMs: 5_000,
    });
    expect(shell.status).toBe("completed");
    expect(shell.process?.descendantsQuiescent).toBe(true);
    expect(processesInNamespace(String(shell.process?.pidNamespace))).toEqual([]);
    const registration = events.find(({ kind }) => kind === "effect.process.registered");
    const identity = registration?.payload.identity as { pid?: number; ancestry?: Array<{ pid: number; parentPid: number; birthTicks: number }> } | undefined;
    expect(identity?.ancestry?.some(({ parentPid }) => parentPid === identity.pid)).toBe(true);
    expect(identity?.ancestry?.every(({ pid, parentPid, birthTicks }) => pid > 1 && parentPid > 0 && birthTicks > 0)).toBe(true);
    expect(shell.paths.map(({ path: name }) => name)).toContain("src/target.txt");
    expect(readFileSync(path.join(candidate.candidateRoot, "src/new.txt"), "utf8")).toBe("patch output\n");
    expect(readFileSync(path.join(candidate.candidateRoot, "src/descendant.started"), "utf8")).toBe("started");
    expect(readFileSync(path.join(candidate.candidateRoot, "src/target.txt"), "utf8")).toContain("edited write\n bash output");
    expect(readFileSync(path.join(sample.sourceRoot, "src", "target.txt"))).toEqual(sourceBefore);
    expect(readFileSync(path.join(sample.sourceRoot, ".git", "index"))).toEqual(indexBefore);
    expect(readFileSync(path.join(sample.storeRoot, "sentinel"))).toEqual(sealedBefore);
    expect(readFileSync(path.join(sample.otherCandidate, "sentinel"))).toEqual(otherCandidateBefore);
    expect(existsSync(path.join(candidate.candidateGitDir, "forbidden"))).toBe(false);
    const denied = await effects.invoke("powershell", { command: "Write-Output unsafe" });
    expect(denied.status).toBe("denied");
    expect(events.filter(({ kind }) => kind === "effect.denied")).toHaveLength(1);
    expect(events.filter(({ kind }) => kind === "effect.receipt")).toHaveLength(4);
    await effects.shutdown();
  });

  test("keeps directory-FD writes inside the candidate during concurrent symlink replacement", async () => {
    if (!canContain) return;
    const sample = fixture();
    const candidate = workspace(sample);
    await preflightContainment(candidate);
    const original = readFileSync(path.join(sample.sourceRoot, "src", "target.txt"));
    let version = 0;
    const events: Array<{ kind: string }> = [];
    let interval: ReturnType<typeof setInterval> | undefined;
    let stop: ReturnType<typeof setTimeout> | undefined;
    let swaps = 0;
    const hostPath = path.join(candidate.candidateRoot, "src");
    const displaced = `${hostPath}.race`;
    const restore = () => {
      try { if (lstatSync(hostPath).isSymbolicLink()) rmSync(hostPath, { force: true }); } catch { /* raced with rename */ }
      try { if (existsSync(displaced) && !existsSync(hostPath)) renameSync(displaced, hostPath); } catch { /* cleanup retries below */ }
    };
    const store = {
      runtimeId: "test-runtime",
      inspectMission() { return { version }; },
      appendTransition(_id: string, _expected: number, transition: { events: typeof events }) {
        version += transition.events.length;
        events.push(...transition.events);
        if (transition.events.some(({ kind }) => kind === "effect.process.registered")) {
          interval = setInterval(() => {
            try {
              if (existsSync(displaced)) {
                if (lstatSync(hostPath).isSymbolicLink()) rmSync(hostPath, { force: true });
                renameSync(displaced, hostPath);
              } else if (lstatSync(hostPath).isDirectory()) {
                renameSync(hostPath, displaced);
                symlinkSync("/tmp/pitako/source", hostPath);
              }
              swaps += 1;
            } catch { /* retry while the contained writer is active */ }
          }, 2);
          stop = setTimeout(() => { if (interval) clearInterval(interval); restore(); }, 80);
        }
        return [];
      },
    };
    const effects = new MissionEffects({
      store: store as never, workspace: candidate, missionId: candidate.missionId, revision: 1,
      unitId: "unit", attemptId: candidate.attemptId, runtimeId: "test-runtime", ownerEpoch: 1,
      allowedOperations: ["bash"],
    });
    try {
      const receipt = await effects.invoke("bash", {
        command: "sleep 0.15; printf ' race-safe' >> /tmp/pitako/workspace/src/target.txt",
        timeoutMs: 5_000,
      });
      if (interval) clearInterval(interval);
      if (stop) clearTimeout(stop);
      restore();
      expect(swaps).toBeGreaterThan(0);
      expect(receipt.status).toBe("completed");
      expect(readFileSync(path.join(sample.sourceRoot, "src", "target.txt"))).toEqual(original);
      expect(readFileSync(path.join(candidate.candidateRoot, "src", "target.txt"), "utf8")).toContain("race-safe");
    } finally {
      if (interval) clearInterval(interval);
      if (stop) clearTimeout(stop);
      restore();
      await effects.shutdown();
    }
  });

  test("rejects symlink-parent writes and denies tools before successful preflight", async () => {
    const sample = fixture();
    const candidate = workspace(sample);
    let version = 0;
    const events: Array<{ kind: string }> = [];
    const store = {
      runtimeId: "test-runtime",
      inspectMission() { return { version }; },
      appendTransition(_missionId: string, _expected: number, transition: { events: typeof events }) {
        version += transition.events.length;
        events.push(...transition.events);
        return [];
      },
    };
    const uncontained = new MissionEffects({
      store: store as never, workspace: candidate, missionId: candidate.missionId, revision: 1,
      unitId: "unit", attemptId: candidate.attemptId, runtimeId: "test-runtime", ownerEpoch: 1,
      allowedOperations: ["write"],
    });
    expect((await uncontained.invoke("write", { path: "src/target.txt", content: "must not start" })).status).toBe("denied");
    expect(readFileSync(path.join(candidate.candidateRoot, "src/target.txt"), "utf8")).toBe("dirty worktree\n");
    expect(events.map(({ kind }) => kind)).toEqual(["effect.denied"]);
    if (!canContain) return;
    await preflightContainment(candidate);
    rmSync(path.join(candidate.candidateRoot, "src"), { recursive: true, force: true });
    symlinkSync(sample.sourceRoot, path.join(candidate.candidateRoot, "src"));
    const result = await uncontained.invoke("write", { path: "src/target.txt", content: "must not escape" });
    expect(result.status).toBe("failed");
    expect(readFileSync(path.join(sample.sourceRoot, "src", "target.txt"), "utf8")).toBe("dirty worktree\n");
    await uncontained.shutdown();
  });

  test("uses PID birth identity rather than PID alone", async () => {
    const node = execFileSync("/bin/sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
    const child = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    const current = currentProcessIdentity("runtime-test", 3);
    const identity = { ...current, pid: child.pid!, birthTicks: processBirthTicks(child.pid!) };
    expect(ownerProcessState(identity)).toBe("live");
    expect(ownerProcessState({ ...identity, birthTicks: identity.birthTicks + 1 })).toBe("dead");
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(ownerProcessState(identity)).toBe("dead");
  });

  test("process crashes at intent, invocation, registration and release boundaries leave no released write", async () => {
    if (!canContain) return;
    const node = execFileSync("/bin/sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
    const script = path.resolve("tests/fixtures/mission-effect-crash-child.mjs");
    for (const holdKind of ["effect.intent", "effect.invoking", "effect.process.registered", "effect.released"]) {
      const { sample, missionId, attemptId, storeRoot, candidateParent } = await crashFixture();
      const eventLog = path.join(sample.base, "effect-events.jsonl");
      const metadataFile = path.join(sample.base, "candidate.json");
      const child = spawn(node, [script], {
        cwd: process.cwd(), stdio: "ignore",
        env: {
          ...process.env, T3_SOURCE: sample.root, T3_STORE: storeRoot, T3_CANDIDATES: candidateParent,
          T3_DB: sample.dbPath, T3_OBJECTS: sample.objectDir, T3_MISSION: missionId, T3_ATTEMPT: attemptId,
          T3_LOG: eventLog, T3_META: metadataFile, T3_CRASH_AFTER_KIND: holdKind,
        },
      });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 20_000;
        while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(predicate()).toBe(true);
      };
      let reopened: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
      try {
        await until(() => existsSync(metadataFile) && existsSync(eventLog)
          && readFileSync(eventLog, "utf8").trim().split("\n").filter(Boolean).some((line) => JSON.parse(line).kind === holdKind));
        const { candidateRoot } = JSON.parse(readFileSync(metadataFile, "utf8")) as { candidateRoot: string };
        const events = readFileSync(eventLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
          kind: string; payload: { identity?: { pidNamespace?: string } };
        });
        const namespace = events.find(({ kind }) => kind === "effect.process.registered")?.payload.identity?.pidNamespace;
        preserveCrashEvents(`t3-${holdKind.replace(/[^a-z]+/g, "-")}.jsonl`, eventLog);
        expect(events.map(({ kind }) => kind)).toContain(holdKind);
        expect((await closed).signal).toBe("SIGKILL");
        if (namespace) await until(() => processesInNamespace(namespace).length === 0);
        expect(existsSync(path.join(candidateRoot, "src", "started"))).toBe(false);
        reopened = await openFixtureStore(sample);
        const persisted = reopened.inspectMission(missionId).events.filter(({ kind }) => kind.startsWith("effect."));
        expect(persisted.map(({ kind }) => kind)).toContain(holdKind);
        if (holdKind === "effect.released") expect(persisted.map(({ kind }) => kind)).toContain("effect.released");
        else expect(persisted.map(({ kind }) => kind)).not.toContain("effect.released");
        expect(persisted.map(({ kind }) => kind)).not.toContain("effect.receipt");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        reopened?.close();
      }
    }
  });

  test("process crash before receipt commit retains completed candidate bytes as an unresolved effect", async () => {
    if (!canContain) return;
    const { sample, missionId, attemptId, storeRoot, candidateParent } = await crashFixture();
    const eventLog = path.join(sample.base, "effect-events.jsonl");
    const metadataFile = path.join(sample.base, "candidate.json");
    const node = execFileSync("/bin/sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
    const child = spawn(node, [path.resolve("tests/fixtures/mission-effect-crash-child.mjs")], {
      cwd: process.cwd(), stdio: "ignore",
      env: {
        ...process.env, T3_SOURCE: sample.root, T3_STORE: storeRoot, T3_CANDIDATES: candidateParent,
        T3_DB: sample.dbPath, T3_OBJECTS: sample.objectDir, T3_MISSION: missionId, T3_ATTEMPT: attemptId,
        T3_LOG: eventLog, T3_META: metadataFile, T3_CRASH_KIND: "effect.receipt",
        T3_COMMAND: "printf started > /tmp/pitako/workspace/src/started; printf finished > /tmp/pitako/workspace/src/finished",
      },
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 20_000;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(predicate()).toBe(true);
    };
    let reopened: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
    try {
      await until(() => {
        if (!existsSync(metadataFile) || !existsSync(eventLog)) return false;
        const { candidateRoot } = JSON.parse(readFileSync(metadataFile, "utf8")) as { candidateRoot: string };
        const events = readFileSync(eventLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string });
        return events.some(({ kind }) => kind === "effect.released") && existsSync(path.join(candidateRoot, "src", "finished"));
      });
      const { candidateRoot } = JSON.parse(readFileSync(metadataFile, "utf8")) as { candidateRoot: string };
      const events = readFileSync(eventLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
        kind: string; payload: { identity?: { pidNamespace?: string } };
      });
      const namespace = events.find(({ kind }) => kind === "effect.process.registered")?.payload.identity?.pidNamespace;
      preserveCrashEvents("t3-node-receipt-crash.jsonl", eventLog);
      expect((await closed).signal).toBe("SIGKILL");
      if (namespace) await until(() => processesInNamespace(namespace).length === 0);
      expect(existsSync(path.join(candidateRoot, "src", "started"))).toBe(true);
      expect(existsSync(path.join(candidateRoot, "src", "finished"))).toBe(true);
      reopened = await openFixtureStore(sample);
      const persisted = reopened.inspectMission(missionId).events.filter(({ kind }) => kind.startsWith("effect."));
      expect(persisted.map(({ kind }) => kind)).toContain("effect.released");
      expect(persisted.map(({ kind }) => kind)).not.toContain("effect.receipt");
      expect(readFileSync(path.join(sample.root, "src", "target.txt"), "utf8")).toBe("source sentinel\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      reopened?.close();
    }
  });

  test("process crash after effect release leaves an unresolved receipt and no live namespace", async () => {
    if (!canContain) return;
    const { sample, missionId, attemptId, storeRoot, candidateParent } = await crashFixture();
    const node = execFileSync("/bin/sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
    const eventLog = path.join(sample.base, "effect-events.jsonl");
    const metadataFile = path.join(sample.base, "candidate.json");
    const script = path.resolve("tests/fixtures/mission-effect-crash-child.mjs");
    const child = spawn(node, [script], {
      cwd: process.cwd(),
      stdio: "ignore",
      env: {
        ...process.env,
        T3_SOURCE: sample.root,
        T3_STORE: storeRoot,
        T3_CANDIDATES: candidateParent,
        T3_DB: sample.dbPath,
        T3_OBJECTS: sample.objectDir,
        T3_MISSION: missionId,
        T3_ATTEMPT: attemptId,
        T3_LOG: eventLog,
        T3_META: metadataFile,
      },
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 20_000;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(predicate()).toBe(true);
    };
    try {
      await until(() => existsSync(metadataFile) && existsSync(eventLog));
      const { candidateRoot } = JSON.parse(readFileSync(metadataFile, "utf8")) as { candidateRoot: string };
      await until(() => {
        if (!existsSync(eventLog)) return false;
        const events = readFileSync(eventLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string });
        return events.some(({ kind }) => kind === "effect.released") && existsSync(path.join(candidateRoot, "src", "started"));
      });
      const events = readFileSync(eventLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
        kind: string; payload: { identity?: { pidNamespace?: string } };
      });
      const namespace = events.find(({ kind }) => kind === "effect.process.registered")?.payload.identity?.pidNamespace;
      expect(namespace).toBeTruthy();
      expect(child.kill("SIGKILL")).toBe(true);
      expect((await closed).signal).toBe("SIGKILL");
      await until(() => processesInNamespace(namespace!).length === 0);
      const finalEvents = readFileSync(eventLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string });
      preserveCrashEvents("t3-node-partial-crash.jsonl", eventLog);
      expect(finalEvents.some(({ kind }) => kind === "effect.released")).toBe(true);
      expect(finalEvents.some(({ kind }) => kind === "effect.receipt" || kind === "effect.unknown")).toBe(false);
      expect(existsSync(path.join(candidateRoot, "src", "started"))).toBe(true);
      expect(existsSync(path.join(candidateRoot, "src", "finished"))).toBe(false);
      expect(readFileSync(path.join(sample.root, "src", "target.txt"), "utf8")).toBe("source sentinel\n");
      const reopened = await openFixtureStore(sample);
      const persisted = reopened.inspectMission(missionId).events.filter(({ kind }) => kind.startsWith("effect."));
      expect(persisted.map(({ kind }) => kind)).toContain("effect.released");
      expect(persisted.map(({ kind }) => kind)).not.toContain("effect.receipt");
      reopened.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
