import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { createMissionFixture, missionDefinition, openFixtureStore } from "./mission-fixtures.ts";
import { packageRoot } from "../extensions/stack.ts";

const fixtures: string[] = [];
afterEach(() => { for (const base of fixtures.splice(0)) rmSync(base, { recursive: true, force: true }); });

function installSlowProvider(agentDir: string, abortReleaseFile?: string) {
  const dir = path.join(agentDir, "extensions");
  mkdirSync(dir, { recursive: true });
  const streamModule = path.join(packageRoot(), "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js");
  writeFileSync(path.join(dir, "slow-provider.js"), `import { createAssistantMessageEventStream } from ${JSON.stringify(streamModule)};
import { existsSync } from "node:fs";
export default function(pi) { pi.registerProvider("mission-slow-local", {
  baseUrl: "http://127.0.0.1", apiKey: "fixture", api: "openai-completions",
  models: [{ id: "fixture", name: "Slow fixture", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 }],
  streamSimple(_model, _context, options) { const stream = createAssistantMessageEventStream();
    const timer = setTimeout(() => { const message = { role: "assistant", content: [{ type: "text", text: "local fixture result" }],
      api: "openai-completions", provider: "mission-slow-local", model: "fixture", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const partial = { ...message, content: [{ type: "text", text: "" }] };
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      partial.content[0].text = "local fixture result";
      stream.push({ type: "text_delta", contentIndex: 0, delta: "local fixture result", partial });
      stream.push({ type: "text_end", contentIndex: 0, content: "local fixture result", partial });
      stream.push({ type: "done", reason: "stop", message }); stream.end(message); }, 20000);
    const abort = async () => {
      clearTimeout(timer);
      const release = ${JSON.stringify(abortReleaseFile ?? null)};
      if (release) {
        for (let i = 0; i < 1000 && !existsSync(release); i++)
          await new Promise(resolve => setTimeout(resolve, 10));
      }
      const error = { role: "assistant", content: [], api: "openai-completions", provider: "mission-slow-local",
        model: "fixture", stopReason: "aborted", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "error", reason: "aborted", error }); stream.end(error);
    };
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    return stream; }
}); }
`);
}

function rpc(cwd: string, agentDir: string) {
  const provider = path.join(agentDir, "extensions", "slow-provider.js");
  const child = spawn(path.join(packageRoot(), "node_modules/.bin/pi"), ["--mode", "rpc", "--no-extensions", "--approve", "--no-session", "-e", packageRoot(), ...(existsSync(provider) ? ["-e", provider] : [])], {
    cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const events: any[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { events.push(JSON.parse(line)); } catch { /* only JSON frames are protocol events */ }
    }
  });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 1500; i++) {
      if (predicate()) return;
      if (child.exitCode !== null) throw new Error(`pi exited ${child.exitCode}: ${stderr}`);
      await Bun.sleep(20);
    }
    throw new Error(`pi RPC timeout: ${stderr}; events: ${JSON.stringify(events.slice(-8))}`);
  };
  return {
    child, events, wait,
    async request(type: string, extra: Record<string, unknown> = {}) {
      const id = randomUUID();
      child.stdin.write(JSON.stringify({ type, ...extra, id }) + "\n");
      await wait(() => events.some((event) => event.type === "response" && event.id === id));
      return events.find((event) => event.type === "response" && event.id === id);
    },
    async graceful() {
      child.stdin.end();
      await Promise.race([new Promise<void>((resolve) => child.once("close", () => resolve())), Bun.sleep(15_000).then(() => { throw new Error(`Pi RPC did not close cleanly: ${stderr}`); })]);
    },
    async close(signal: NodeJS.Signals = "SIGTERM") {
      child.kill(signal);
      await Promise.race([new Promise<void>((resolve) => child.once("close", () => resolve())), Bun.sleep(5_000).then(() => { child.kill("SIGKILL"); })]);
    },
  };
}

async function consoleInput(socket: string, text: string, proof = readFileSync(`${socket}.key`).toString("hex")) {
  return await new Promise<{ ok: boolean; message: string; causalId: string; responseMs: number }>((resolve, reject) => {
    const peer = connect(socket); let data = "";
    peer.on("connect", () => peer.write(JSON.stringify({ proof, text }) + "\n"));
    peer.on("data", (chunk) => { data += chunk; });
    peer.on("end", () => data ? resolve(JSON.parse(data)) : reject(new Error(`console returned no response: ${socket}`)));
    peer.on("error", reject);
  });
}

test("real Pi 0.87 TUI keeps an active worker while console answers and fences a revised dependency", async () => {
  const fixture = createMissionFixture("pitako-t5-tui-"); fixtures.push(fixture.base);
  mkdirSync(path.join(fixture.stateDir, "pitako"), { recursive: true });
  writeFileSync(path.join(fixture.stateDir, "pitako", "config.toml"), "");
  const abortReleaseFile = path.join(fixture.stateDir, "release-provider-abort");
  // Keep the actual SDK cancellation in flight through the foreground revision.
  installSlowProvider(fixture.stateDir, abortReleaseFile);
  const definition = missionDefinition();
  definition.units[0]!.kind = "consultation";
  definition.units.push({
    ...structuredClone(definition.units[0]!), id: "consumer", dependencies: ["snapshot"],
    outputs: ["consumer"], acceptance: [{ id: "consumer-present", kind: "artifact_hash", target: "consumer" }],
  });
  definition.finalization.requiredPredicates.push("consumer-present");
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: "mission-slow-local", model: "fixture", fallbacks: [] };
  definition.budget = { roleLaunches: 6, providerRequests: 8, tokens: 1600, activeTimeMs: 120000, artifactBytes: 1024 * 1024 };
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const child = spawn("script", ["-q", "-e", "-c",
    `${JSON.stringify(path.join(packageRoot(), "node_modules/.bin/pi"))} --no-extensions --approve --no-session -e ${JSON.stringify(packageRoot())}`,
    "/dev/null"], {
    cwd: fixture.root, detached: true,
    env: { ...process.env, PI_CODING_AGENT_DIR: fixture.stateDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 1000; i++) {
      if (predicate()) return;
      if (child.exitCode !== null) throw new Error(`Pi TUI exited ${child.exitCode}: ${output.slice(-2000)}`);
      await Bun.sleep(20);
    }
    throw new Error(`Pi TUI timed out: ${output.slice(-2000)}`);
  };
  const socketDir = path.join(fixture.stateDir, "pitako", "console");
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  try {
    await wait(() => output.includes("Mission operator console:") && existsSync(socketDir) && readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    const socket = path.join(socketDir, readdirSync(socketDir).find((name) => name.endsWith(".sock"))!);
    const prepare = await consoleInput(socket, "/mission prepare durable-fixture");
    const start = await consoleInput(socket, "/mission start durable-fixture");
    expect(prepare.ok).toBe(true);
    expect(start.ok).toBe(true);
    store = await openFixtureStore(fixture);
    const missionId = store.findManagedMission(fixture.root)!.id;
    await wait(() => store!.inspectMission(missionId).events.some(({ kind }) => kind === "attempt.started"));
    const before = store.inspectMission(missionId);
    const active = before.events.find(({ kind }) => kind === "attempt.started")!;
    expect(before.events.some(({ kind }) => kind === "attempt.receipt")).toBe(false);
    const question = await consoleInput(socket, "/mission status durable-fixture");
    const hypothetical = await consoleInput(socket, "/mission revise durable-fixture What if we change durable-fixture predicate? -- []");
    const unchanged = store.inspectMission(missionId);
    expect(question.ok).toBe(true);
    expect(question.responseMs).toBeLessThan(1_000);
    expect(JSON.parse(question.message).state).toBe("running");
    expect(hypothetical.ok).toBe(false);
    expect(unchanged.revision).toBe(1);
    expect(unchanged.snapshot.definitionHash).toBe(before.snapshot.definitionHash);
    expect(unchanged.events.some(({ kind }) => kind === "attempt.receipt")).toBe(false);
    const predicate = before.definition.units[0]!.acceptance[0]!;
    const changed = { ...predicate, target: "revised predicate" };
    const delta = JSON.stringify([{ op: "replace", path: "/units/0/acceptance/0/target", before: predicate.target, after: changed.target }]);
    const ambiguous = await consoleInput(socket, `/mission revise durable-fixture the snapshot predicate should be stricter -- ${delta}`);
    const held = store.inspectMission(missionId);
    const choice = held.events.find(({ kind, payload }) => kind === "mission.input.recorded" && payload.operatorInputId === ambiguous.causalId);
    expect(ambiguous.ok).toBe(true);
    expect(ambiguous.message).toContain("/units/0/acceptance/0/target");
    expect(choice?.payload.questionImpact).toEqual(["consumer", "snapshot"]);
    expect(held.revision).toBe(1);
    expect(held.events.some(({ kind, revision }) => kind === "unit.accepted" && revision === 1)).toBe(false);
    expect(held.events.some(({ kind }) => kind === "attempt.receipt")).toBe(false);
    const instruction = `/mission revise durable-fixture Change predicate snapshot-present target to "revised predicate"`;
    const revise = await consoleInput(socket, instruction);
    expect(revise.ok).toBe(true);
    expect(revise.message).toContain("impacted: consumer, snapshot");
    const after = store.inspectMission(missionId);
    expect(after.revision).toBe(2);
    expect(after.definition.units[0]!.acceptance[0]).toEqual(changed);
    expect(after.events.some(({ kind, revision }) => kind === "unit.accepted" && revision === 1)).toBe(false);
    expect(after.events.some(({ kind }) => kind === "attempt.receipt")).toBe(false);
    expect(store.readArtifact(before.snapshot.definitionHash).equals(before.definitionBytes)).toBe(true);
    writeFileSync(abortReleaseFile, "release");
    await wait(() => store!.inspectMission(missionId).events.some(({ kind }) => kind === "attempt.receipt" || kind === "attempt.interrupted"));
    const settled = store.inspectMission(missionId);
    expect(settled.events.some(({ kind, revision }) => kind === "unit.accepted" && revision === 1)).toBe(false);
    const revisedEvent = after.events.find(({ kind }) => kind === "mission.revised")!;
    expect(revisedEvent.payload.operatorInputId).toBe(revise.causalId);
    if (process.env.MISSION_T5_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "host-tui-worker-observed.json"), JSON.stringify({
        runtime: "Pi 0.87.0 TUI under PTY", pid: child.pid, missionId,
        input: { prepare, start, question, hypothetical, ambiguous, instruction, revise },
        ambiguousHold: { choice, revision: held.revision,
          priorAccepted: held.events.filter(({ kind, revision }) => kind === "unit.accepted" && revision === 1).length },
        worker: { attemptStartedSeq: active.seq, activeAtQuestion: !unchanged.events.some(({ kind }) => kind === "attempt.receipt"),
          activeAtChoice: !held.events.some(({ kind }) => kind === "attempt.receipt"),
          activeAtRevision: !after.events.some(({ kind }) => kind === "attempt.receipt"), oldAttemptId: active.attemptId },
        before: { revision: before.revision, eventSeq: before.latestSeq, definitionHash: before.snapshot.definitionHash },
        unchanged: { revision: unchanged.revision, eventSeq: unchanged.latestSeq, definitionHash: unchanged.snapshot.definitionHash },
        after: { revision: after.revision, eventSeq: after.latestSeq, definitionHash: after.snapshot.definitionHash,
          oldDefinitionArtifactHash: createHash("sha256").update(store.readArtifact(before.snapshot.definitionHash)).digest("hex"),
          revisionEvent: revisedEvent, oldAccepted: settled.events.filter(({ kind, revision }) => kind === "unit.accepted" && revision === 1).length,
          oldAttemptEvents: settled.events.filter(({ kind, attemptId }) => attemptId === active.attemptId && ["attempt.receipt", "attempt.interrupted"].includes(kind)) },
      }, null, 2));
    }
  } finally {
    writeFileSync(abortReleaseFile, "release");
    store?.close();
    if (child.pid && child.exitCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }
}, 60_000);

test("real Pi RPC never transfers active worker on /new; startup reconciles saved authority", async () => {
  const fixture = createMissionFixture("pitako-t5-active-"); fixtures.push(fixture.base);
  mkdirSync(path.join(fixture.stateDir, "pitako"), { recursive: true });
  writeFileSync(path.join(fixture.stateDir, "pitako", "config.toml"), "");
  installSlowProvider(fixture.stateDir);
  const definition = missionDefinition();
  definition.units[0]!.kind = "consultation";
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: "mission-slow-local", model: "fixture", fallbacks: [] };
  definition.budget = { roleLaunches: 6, providerRequests: 8, tokens: 1600, activeTimeMs: 120000, artifactBytes: 1024 * 1024 };
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const socketDir = path.join(fixture.stateDir, "pitako", "console");
  const activeSocket = () => path.join(socketDir, readdirSync(socketDir).find((name) => name.endsWith(".sock"))!);
  const first = rpc(fixture.root, fixture.stateDir);
  let second: ReturnType<typeof rpc> | undefined;
  try {
    await first.request("get_commands");
    await first.wait(() => existsSync(socketDir) && readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    const prepared = await consoleInput(activeSocket(), "/mission prepare durable-fixture");
    expect(prepared.ok).toBe(true);
    const started = await consoleInput(activeSocket(), "/mission start durable-fixture");
    expect(started.ok).toBe(true);
    const store = await openFixtureStore(fixture);
    const id = store.findManagedMission(fixture.root)!.id;
    await first.wait(() => store.inspectMission(id).events.some(({ kind }) => kind === "attempt.started"));
    const active = store.inspectMission(id).events.find(({ kind }) => kind === "attempt.started")!;
    await first.wait(() => store.inspectMission(id).events.some(({ kind, attemptId }) => kind === "provider.request.dispatched" && attemptId === active.attemptId));
    expect(store.inspectMission(id).events.some(({ kind, attemptId }) => kind === "attempt.receipt" && attemptId === active.attemptId)).toBe(false);
    const statusStart = performance.now();
    const status = await consoleInput(activeSocket(), "/mission status durable-fixture");
    const statusMs = performance.now() - statusStart;
    expect(status.ok).toBe(true);
    expect(JSON.parse(status.message).state).toBe("running");
    expect(statusMs).toBeLessThan(1_000);
    const switched = await first.request("new_session");
    expect(switched.success).toBe(true);
    await first.wait(() => store.inspectMission(id).events.some(({ kind }) => kind === "mission.owner.released"));
    await first.wait(() => readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    const after = store.inspectMission(id);
    expect(after.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
    expect(after.state).toBe("paused");
    const attached = await consoleInput(activeSocket(), "/mission attach durable-fixture");
    expect(attached.ok).toBe(true);
    expect(store.inspectMission(id).events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
    await first.close("SIGKILL");
    store.close();
    second = rpc(fixture.root, fixture.stateDir);
    await second.request("get_commands");
    await second.wait(() => existsSync(socketDir) && readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    const reopened = await openFixtureStore(fixture);
    expect(reopened.inspectMission(id).state).toBe("paused");
    expect(reopened.inspectMission(id).events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
    if (process.env.MISSION_T5_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "host-active-new-observed.json"), JSON.stringify({
        firstPid: first.child.pid, secondPid: second.child.pid, missionId: id, statusMs,
        status: JSON.parse(status.message), attached, switched,
        beforeSwitchAttemptCount: 1, afterSwitchAttemptCount: after.events.filter(({ kind }) => kind === "attempt.reserved").length,
        afterReloadAttemptCount: reopened.inspectMission(id).events.filter(({ kind }) => kind === "attempt.reserved").length,
        state: reopened.inspectMission(id).state,
        navigationPause: after.events.some(({ kind, payload }) => kind === "mission.paused" && String(payload.reason).includes("Pi session new")),
      }, null, 2));
    }
    reopened.close();
  } finally {
    if (first.child.exitCode === null) await first.close("SIGKILL");
    if (second && second.child.exitCode === null) await second.close();
  }
}, 90_000);

test("real Pi RPC SIGKILL of active worker reconciles on startup without operator retry", async () => {
  const fixture = createMissionFixture("pitako-t5-crash-"); fixtures.push(fixture.base);
  mkdirSync(path.join(fixture.stateDir, "pitako"), { recursive: true });
  writeFileSync(path.join(fixture.stateDir, "pitako", "config.toml"), "");
  installSlowProvider(fixture.stateDir);
  const definition = missionDefinition();
  definition.units[0]!.kind = "consultation";
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: "mission-slow-local", model: "fixture", fallbacks: [] };
  definition.budget = { roleLaunches: 6, providerRequests: 8, tokens: 1600, activeTimeMs: 120000, artifactBytes: 1024 * 1024 };
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const socketDir = path.join(fixture.stateDir, "pitako", "console");
  const first = rpc(fixture.root, fixture.stateDir);
  let second: ReturnType<typeof rpc> | undefined;
  try {
    await first.request("get_commands");
    await first.wait(() => existsSync(socketDir) && readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    const socket = path.join(socketDir, readdirSync(socketDir).find((name) => name.endsWith(".sock"))!);
    expect((await consoleInput(socket, "/mission prepare durable-fixture")).ok).toBe(true);
    expect((await consoleInput(socket, "/mission start durable-fixture")).ok).toBe(true);
    const store = await openFixtureStore(fixture);
    const id = store.findManagedMission(fixture.root)!.id;
    await first.wait(() => store.inspectMission(id).events.some(({ kind }) => kind === "attempt.started"));
    const attemptBefore = store.inspectMission(id).events.filter(({ kind }) => kind === "attempt.reserved").length;
    await first.close("SIGKILL");
    store.close();
    second = rpc(fixture.root, fixture.stateDir);
    await second.request("get_commands");
    const recovered = await openFixtureStore(fixture);
    await second.wait(() => recovered.inspectMission(id).events.some(({ kind }) => kind === "mission.recovery.recorded"));
    const inspection = recovered.inspectMission(id);
    expect(inspection.events.some(({ kind }) => kind === "attempt.settled")).toBe(true);
    expect(inspection.events.filter(({ kind }) => kind === "attempt.reserved").length).toBeGreaterThan(attemptBefore);
    expect(inspection.state).toBe("running");
    await second.wait(() => recovered.inspectMission(id).events.some(({ kind }) => kind === "attempt.receipt"));
    expect(recovered.inspectMission(id).events.some(({ kind, payload }) => kind === "attempt.receipt" && payload.status === "completed")).toBe(true);
    const completed = recovered.inspectMission(id);
    if (process.env.MISSION_T5_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "host-active-crash-observed.json"), JSON.stringify({
        firstPid: first.child.pid, secondPid: second.child.pid, missionId: id, attemptBefore,
        attemptAfter: inspection.events.filter(({ kind }) => kind === "attempt.reserved").length,
        recoveryEvents: inspection.events.filter(({ kind }) => kind === "mission.recovery.recorded"),
        interrupted: inspection.events.filter(({ kind }) => kind === "attempt.interrupted").length,
        completedReceipts: completed.events.filter(({ kind, payload }) => kind === "attempt.receipt" && payload.status === "completed").length,
        state: inspection.state,
      }, null, 2));
    }
    recovered.close();
  } finally {
    if (first.child.exitCode === null) await first.close("SIGKILL");
    if (second && second.child.exitCode === null) await second.close("SIGKILL");
  }
}, 90_000);

test("real Pi RPC admits authenticated console actions, not forged prompts, across crash and reload", async () => {
  const fixture = createMissionFixture("pitako-t5-host-"); fixtures.push(fixture.base);
  mkdirSync(path.join(fixture.stateDir, "pitako"), { recursive: true });
  writeFileSync(path.join(fixture.stateDir, "pitako", "config.toml"), "");
  const sockets = path.join(fixture.stateDir, "pitako", "console");
  const first = rpc(fixture.root, fixture.stateDir);
  let second: ReturnType<typeof rpc> | undefined;
  try {
    await first.request("get_commands");
    await first.wait(() => existsSync(sockets) && readdirSync(sockets).some((file) => file.endsWith(".sock")));
    const socket = path.join(sockets, readdirSync(sockets).find((file) => file.endsWith(".sock"))!);
    const forged = await first.request("prompt", { message: "/mission start durable-fixture" });
    expect(forged.success).toBe(true);
    const denied = await consoleInput(socket, "/mission prepare durable-fixture", "0".repeat(64));
    expect(denied.ok).toBe(false);
    const prepared = await consoleInput(socket, "/mission prepare durable-fixture");
    expect(prepared.ok).toBe(true);
    const store = await openFixtureStore(fixture);
    const mission = store.findManagedMission(fixture.root)!;
    expect(mission.revision).toBe(1);
    expect(mission.events.some((event) => event.kind === "mission.activated")).toBe(false);
    store.close();
    await first.close("SIGKILL");
    second = rpc(fixture.root, fixture.stateDir);
    await second.request("get_commands");
    await second.wait(() => existsSync(sockets) && readdirSync(sockets).some((file) => file.endsWith(".sock") && file !== path.basename(socket)));
    const reloadedSocket = path.join(sockets, readdirSync(sockets).find((file) => file.endsWith(".sock") && file !== path.basename(socket))!);
    const attached = await consoleInput(reloadedSocket, "/mission attach durable-fixture");
    const status = await consoleInput(reloadedSocket, "/mission status durable-fixture");
    expect(attached.ok).toBe(true);
    expect(status.ok).toBe(true);
    expect(JSON.parse(status.message).id).toBe(mission.id);
    const switched = await second.request("new_session");
    await second.wait(() => readdirSync(sockets).some((file) => file.endsWith(".sock.key") && file !== `${path.basename(socket)}.key` && file !== `${path.basename(reloadedSocket)}.key`));
    const switchedSocket = path.join(sockets, readdirSync(sockets).find((file) => file.endsWith(".sock.key") && file !== `${path.basename(socket)}.key` && file !== `${path.basename(reloadedSocket)}.key`)!.slice(0, -4));
    const afterSwitch = await consoleInput(switchedSocket, "/mission attach durable-fixture");
    expect(switched.success).toBe(true);
    expect(switched.data.cancelled).toBe(false);
    expect(afterSwitch.ok).toBe(true);
    const paused = await consoleInput(switchedSocket, "/mission pause durable-fixture");
    const recoveryDenied = await consoleInput(switchedSocket, "/mission recover durable-fixture");
    const pausedStatus = await consoleInput(switchedSocket, "/mission status durable-fixture");
    expect(paused.ok).toBe(true);
    expect(recoveryDenied.ok).toBe(false);
    expect(JSON.parse(pausedStatus.message).state).toBe("paused");
    const cancelled = await consoleInput(switchedSocket, "/mission cancel durable-fixture");
    const resumeDenied = await consoleInput(switchedSocket, "/mission resume durable-fixture");
    expect(cancelled.ok).toBe(true);
    expect(resumeDenied.ok).toBe(false);
    const persisted = await openFixtureStore(fixture);
    const after = persisted.inspectMission(mission.id);
    persisted.close();
    expect(after.events.some((event) => event.kind === "mission.cancelled" && event.payload.operatorInputId === cancelled.causalId)).toBe(true);
    const observed = { runtime: "pi --mode rpc", firstPid: first.child.pid, secondPid: second.child.pid,
      forgedRpcPrompt: forged, denied, prepared, attached, status, switched, afterSwitch, paused, recoveryDenied, pausedStatus, cancelled, resumeDenied,
      persistedMissionId: mission.id, controlEvents: after.events.filter((event) => ["mission.paused", "mission.cancelled"].includes(event.kind)) };
    if (process.env.MISSION_T5_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "host-rpc-observed.json"), JSON.stringify(observed, null, 2));
    }
  } finally {
    if (first.child.exitCode === null) await first.close("SIGKILL");
    if (second && second.child.exitCode === null) await second.close();
  }
}, 60_000);

test("real Pi RPC clean close drains active owner, startup resumes saved authority, manual controls stay terminal", async () => {
  const fixture = createMissionFixture("t5-c-"); fixtures.push(fixture.base);
  mkdirSync(path.join(fixture.stateDir, "pitako"), { recursive: true });
  writeFileSync(path.join(fixture.stateDir, "pitako", "config.toml"), "");
  installSlowProvider(fixture.stateDir);
  const definition = missionDefinition();
  definition.units[0]!.kind = "consultation";
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: "mission-slow-local", model: "fixture", fallbacks: [] };
  definition.budget = { roleLaunches: 6, providerRequests: 8, tokens: 1600, activeTimeMs: 120000, artifactBytes: 1024 * 1024 };
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const socketDir = path.join(fixture.stateDir, "pitako", "console");
  const socket = () => path.join(socketDir, readdirSync(socketDir).find((name) => name.endsWith(".sock"))!);
  const first = rpc(fixture.root, fixture.stateDir);
  let second: ReturnType<typeof rpc> | undefined;
  let third: ReturnType<typeof rpc> | undefined;
  let fourth: ReturnType<typeof rpc> | undefined;
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  try {
    await first.request("get_commands");
    await first.wait(() => existsSync(socketDir) && readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    expect((await consoleInput(socket(), "/mission prepare durable-fixture")).ok).toBe(true);
    const start = await consoleInput(socket(), "/mission start durable-fixture");
    expect(start.ok).toBe(true);
    store = await openFixtureStore(fixture);
    const id = store.findManagedMission(fixture.root)!.id;
    await first.wait(() => store!.inspectMission(id).events.some(({ kind }) => kind === "attempt.started"));
    const before = store.inspectMission(id);
    const oldAttempt = before.events.find(({ kind }) => kind === "attempt.started")!;
    const oldEpoch = (before.events.find(({ kind }) => kind === "attempt.reserved")!.payload.binding as { ownerEpoch: number }).ownerEpoch;
    expect(before.events.some(({ kind }) => kind === "attempt.receipt")).toBe(false);
    await first.graceful();
    const closed = store.inspectMission(id);
    const release = [...closed.events].reverse().find(({ kind }) => kind === "mission.owner.released");
    expect(release?.payload.reason).toBe("quit");
    expect(closed.events.some(({ kind, attemptId }) => ["attempt.receipt", "attempt.settled", "attempt.interrupted"].includes(kind) && attemptId === oldAttempt.attemptId)).toBe(true);
    expect(closed.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
    store.close(); store = undefined;
    second = rpc(fixture.root, fixture.stateDir);
    await second.request("get_commands");
    store = await openFixtureStore(fixture);
    await second.wait(() => store!.inspectMission(id).events.filter(({ kind }) => kind === "attempt.reserved").length > 1);
    const resumed = store.inspectMission(id);
    const nextAttempt = resumed.events.filter(({ kind }) => kind === "attempt.reserved").at(-1)!;
    expect(nextAttempt.attemptId).not.toBe(oldAttempt.attemptId);
    const nextEpoch = (nextAttempt.payload.binding as { ownerEpoch: number }).ownerEpoch;
    expect(nextEpoch).toBeGreaterThan(oldEpoch);
    expect(resumed.events.some(({ kind, attemptId }) => ["attempt.settled", "attempt.interrupted"].includes(kind) && attemptId === oldAttempt.attemptId)).toBe(true);
    await second.wait(() => existsSync(socketDir) && readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    const paused = await consoleInput(socket(), "/mission pause durable-fixture");
    expect(store.inspectMission(id).events.some(({ kind, payload }) => kind === "mission.paused" && payload.operatorInputId === paused.causalId)).toBe(true);
    const pausedCount = store.inspectMission(id).events.filter(({ kind }) => kind === "attempt.reserved").length;
    await second.graceful();
    store.close(); store = undefined;
    third = rpc(fixture.root, fixture.stateDir);
    await third.request("get_commands");
    store = await openFixtureStore(fixture);
    const stillPaused = store.inspectMission(id);
    expect(stillPaused.state).toBe("paused");
    expect(stillPaused.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(pausedCount);
    await third.wait(() => existsSync(socketDir) && readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    const cancelled = await consoleInput(socket(), "/mission cancel durable-fixture");
    expect(cancelled.ok).toBe(true);
    await third.graceful();
    store.close(); store = undefined;
    fourth = rpc(fixture.root, fixture.stateDir);
    await fourth.request("get_commands");
    store = await openFixtureStore(fixture);
    const terminal = store.inspectMission(id);
    expect(terminal.state).toBe("cancelled");
    expect(terminal.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(pausedCount);
    if (process.env.MISSION_T5_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "host-clean-close-observed.json"), JSON.stringify({
        runtime: "Pi 0.87.0 RPC", missionId: id, pids: [first.child.pid, second.child.pid, third.child.pid, fourth.child.pid],
        start, paused, cancelled, oldAttemptId: oldAttempt.attemptId, oldEpoch,
        release, closedState: closed.state, closedEvents: closed.events.filter(({ kind }) => ["attempt.receipt", "attempt.settled", "attempt.interrupted", "mission.blocked"].includes(kind)),
        nextAttemptId: nextAttempt.attemptId, nextEpoch,
        recoveryEvents: resumed.events.filter(({ kind }) => kind === "mission.recovery.recorded"),
        pausedCount, pausedState: stillPaused.state, terminalState: terminal.state,
        controlEvents: terminal.events.filter(({ kind }) => ["mission.paused", "mission.cancelled"].includes(kind)),
        terminalCount: terminal.events.filter(({ kind }) => kind === "attempt.reserved").length,
      }, null, 2));
    }
  } catch (error) {
    if (store && process.env.MISSION_T5_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
      const mission = store.findManagedMission(fixture.root);
      if (mission) writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "host-clean-close-failed.json"),
        JSON.stringify(store.inspectMission(mission.id), null, 2));
    }
    throw error;
  } finally {
    store?.close();
    for (const host of [first, second, third, fourth]) if (host && host.child.exitCode === null) await host.close("SIGKILL");
  }
}, 90_000);

test("real Pi RPC fork does not acquire a running mission or launch a replacement", async () => {
  const fixture = createMissionFixture("t5-f-"); fixtures.push(fixture.base);
  mkdirSync(path.join(fixture.stateDir, "pitako"), { recursive: true });
  writeFileSync(path.join(fixture.stateDir, "pitako", "config.toml"), "");
  installSlowProvider(fixture.stateDir);
  const definition = missionDefinition();
  definition.units[0]!.kind = "consultation";
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: "mission-slow-local", model: "fixture", fallbacks: [] };
  definition.budget = { roleLaunches: 6, providerRequests: 8, tokens: 1600, activeTimeMs: 120000, artifactBytes: 1024 * 1024 };
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const socketDir = path.join(fixture.stateDir, "pitako", "console");
  const host = rpc(fixture.root, fixture.stateDir);
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  try {
    await host.request("get_commands");
    await host.wait(() => existsSync(socketDir) && readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    const socket = () => path.join(socketDir, readdirSync(socketDir).find((name) => name.endsWith(".sock"))!);
    const model = await host.request("set_model", { provider: "mission-slow-local", modelId: "fixture" });
    expect(model.success).toBe(true);
    expect((await consoleInput(socket(), "/mission prepare durable-fixture")).ok).toBe(true);
    expect((await consoleInput(socket(), "/mission start durable-fixture")).ok).toBe(true);
    store = await openFixtureStore(fixture);
    const id = store.findManagedMission(fixture.root)!.id;
    await host.wait(() => store!.inspectMission(id).events.some(({ kind }) => kind === "attempt.started"));
    const before = store.inspectMission(id);
    const oldAttempt = before.events.find(({ kind }) => kind === "attempt.started")!;
    const prompt = await host.request("prompt", { message: "foreground fork marker" });
    expect(prompt.success).toBe(true);
    const entries = await host.request("get_entries");
    const userEntry = entries.data?.entries?.find((entry: any) => entry.type === "message" && entry.message?.role === "user");
    expect(userEntry?.id).toBeTruthy();
    const fork = await host.request("fork", { entryId: userEntry.id });
    expect(fork.success).toBe(true);
    expect(fork.data.cancelled).toBe(false);
    const after = store.inspectMission(id);
    expect(after.state).toBe("paused");
    expect(after.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
    expect(after.events.some(({ kind, payload }) => kind === "mission.owner.released" && payload.reason === "fork")).toBe(true);
    const releasedEpoch = (before.events.find(({ kind }) => kind === "attempt.reserved")!.payload.binding as { ownerEpoch: number }).ownerEpoch;
    await host.wait(() => existsSync(socketDir) && readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    const attached = await consoleInput(socket(), "/mission attach durable-fixture");
    expect(attached.ok).toBe(true);
    const attachedState = store.inspectMission(id);
    expect(attachedState.state).toBe("paused");
    expect(attachedState.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(1);
    expect((await consoleInput(socket(), "/mission start durable-fixture")).ok).toBe(false);
    if (process.env.MISSION_T5_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "host-fork-observed.json"), JSON.stringify({
        runtime: "Pi 0.87.0 RPC", pid: host.child.pid, missionId: id, userEntryId: userEntry.id, prompt, fork,
        oldAttemptId: oldAttempt.attemptId, oldEpoch: releasedEpoch,
        release: after.events.filter(({ kind }) => kind === "mission.owner.released"),
        pause: after.events.filter(({ kind }) => kind === "mission.paused"),
        attached, stateAfterFork: after.state, stateAfterAttach: attachedState.state,
        attemptsAfterFork: after.events.filter(({ kind }) => kind === "attempt.reserved").map(({ attemptId, payload }) => ({ attemptId, epoch: (payload.binding as { ownerEpoch: number }).ownerEpoch })),
      }, null, 2));
    }
  } finally {
    store?.close();
    if (host.child.exitCode === null) await host.close("SIGKILL");
  }
}, 60_000);

test("real Pi TUI reload retires active owner before restarting saved work", async () => {
  const fixture = createMissionFixture("t5-r-"); fixtures.push(fixture.base);
  mkdirSync(path.join(fixture.stateDir, "pitako"), { recursive: true });
  writeFileSync(path.join(fixture.stateDir, "pitako", "config.toml"), "");
  installSlowProvider(fixture.stateDir);
  const definition = missionDefinition();
  definition.units[0]!.kind = "consultation";
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: "mission-slow-local", model: "fixture", fallbacks: [] };
  definition.budget = { roleLaunches: 6, providerRequests: 8, tokens: 1600, activeTimeMs: 120000, artifactBytes: 1024 * 1024 };
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const host = spawn("script", ["-q", "-e", "-c",
    `${JSON.stringify(path.join(packageRoot(), "node_modules/.bin/pi"))} --no-extensions --approve --no-session -e ${JSON.stringify(packageRoot())}`,
    "/dev/null"], { cwd: fixture.root, detached: true,
    env: { ...process.env, PI_CODING_AGENT_DIR: fixture.stateDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"] });
  let screen = "";
  host.stdout!.on("data", (part) => { screen += part.toString(); });
  host.stderr!.on("data", (part) => { screen += part.toString(); });
  const wait = async (condition: () => boolean) => {
    for (let i = 0; i < 1500; i++) {
      if (condition()) return;
      if (host.exitCode !== null) throw new Error(`Pi TUI exited ${host.exitCode}`);
      await Bun.sleep(20);
    }
    throw new Error(`Pi TUI reload timeout: ${screen.slice(-600)}`);
  };
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  try {
    const socketDir = path.join(fixture.stateDir, "pitako", "console");
    await wait(() => screen.includes("Mission operator console:") && existsSync(socketDir) &&
      readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    const socket = path.join(socketDir, readdirSync(socketDir).find((name) => name.endsWith(".sock"))!);
    expect((await consoleInput(socket, "/mission prepare durable-fixture")).ok).toBe(true);
    const start = await consoleInput(socket, "/mission start durable-fixture");
    expect(start.ok).toBe(true);
    store = await openFixtureStore(fixture);
    const id = store.findManagedMission(fixture.root)!.id;
    await wait(() => store!.inspectMission(id).events.some(({ kind }) => kind === "attempt.started"));
    const initial = store.inspectMission(id);
    const attemptId = initial.events.find(({ kind }) => kind === "attempt.started")!.attemptId;
    const oldEpoch = (initial.events.find(({ kind }) => kind === "attempt.reserved")!.payload.binding as { ownerEpoch: number }).ownerEpoch;
    expect(initial.events.some(({ kind }) => kind === "attempt.receipt")).toBe(false);
    host.stdin!.write("/reload\r");
    await wait(() => store!.inspectMission(id).events.some(({ kind, payload }) => kind === "mission.owner.released" && payload.reason === "reload"));
    const released = store.inspectMission(id);
    const release = released.events.find(({ kind, payload }) => kind === "mission.owner.released" && payload.reason === "reload")!;
    expect(released.events.some(({ kind, attemptId: observed }) =>
      observed === attemptId && ["attempt.receipt", "attempt.interrupted", "attempt.settled"].includes(kind))).toBe(true);
    await wait(() => store!.inspectMission(id).events.filter(({ kind }) => kind === "attempt.reserved").length > 1);
    const reopened = store.inspectMission(id);
    const next = reopened.events.filter(({ kind }) => kind === "attempt.reserved").at(-1)!;
    const nextEpoch = (next.payload.binding as { ownerEpoch: number }).ownerEpoch;
    expect(next.attemptId).not.toBe(attemptId);
    expect(nextEpoch).toBeGreaterThan(oldEpoch);
    expect(reopened.events.some(({ kind }) => kind === "mission.recovery.recorded")).toBe(true);
    if (process.env.MISSION_T5_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "host-tui-reload-observed.json"), JSON.stringify({
        runtime: "Pi 0.87.0 TUI under PTY", pid: host.pid, command: "/reload", missionId: id, start,
        oldAttemptId: attemptId, oldEpoch, release,
        priorOutcome: released.events.filter(({ attemptId: observed }) => observed === attemptId),
        newAttemptId: next.attemptId, newEpoch: nextEpoch, state: reopened.state,
        recoveryEvents: reopened.events.filter(({ kind }) => kind === "mission.recovery.recorded"),
      }, null, 2));
    }
  } catch (error) {
    if (store && process.env.MISSION_T5_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
      const mission = store.findManagedMission(fixture.root);
      if (mission) writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "host-tui-reload-failed.json"),
        JSON.stringify(store.inspectMission(mission.id), null, 2));
    }
    throw error;
  } finally {
    store?.close();
    if (host.pid && host.exitCode === null) {
      try { process.kill(-host.pid, "SIGKILL"); } catch { /* already exited */ }
      await new Promise<void>((resolve) => host.once("close", () => resolve()));
    }
  }
}, 60_000);

test("real Pi console records display only after PTY render; missed UI and duplicate acknowledgement do not dispatch", async () => {
  const fixture = createMissionFixture("t5-d-"); fixtures.push(fixture.base);
  mkdirSync(path.join(fixture.stateDir, "pitako"), { recursive: true });
  writeFileSync(path.join(fixture.stateDir, "pitako", "config.toml"), "");
  installSlowProvider(fixture.stateDir);
  const definition = missionDefinition();
  definition.units[0]!.kind = "consultation";
  definition.authority.rolePolicies.developer = { hash: "a".repeat(64), provider: "mission-slow-local", model: "fixture", fallbacks: [] };
  definition.budget = { roleLaunches: 6, providerRequests: 8, tokens: 1600, activeTimeMs: 120000, artifactBytes: 1024 * 1024 };
  writeFileSync(fixture.definitionFile, JSON.stringify(definition));
  const socketDir = path.join(fixture.stateDir, "pitako", "console");
  const host = rpc(fixture.root, fixture.stateDir);
  let terminal: ReturnType<typeof spawn> | undefined;
  let store: Awaited<ReturnType<typeof openFixtureStore>> | undefined;
  try {
    await host.request("get_commands");
    await host.wait(() => existsSync(socketDir) && readdirSync(socketDir).some((name) => name.endsWith(".sock")));
    const socket = path.join(socketDir, readdirSync(socketDir).find((name) => name.endsWith(".sock"))!);
    expect((await consoleInput(socket, "/mission prepare durable-fixture")).ok).toBe(true);
    expect((await consoleInput(socket, "/mission start durable-fixture")).ok).toBe(true);
    store = await openFixtureStore(fixture);
    const id = store.findManagedMission(fixture.root)!.id;
    await host.wait(() => store!.inspectMission(id).events.some(({ kind }) => kind === "attempt.started"));
    const active = store.inspectMission(id);
    const attemptId = active.events.find(({ kind }) => kind === "attempt.started")!.attemptId;
    const predicate = active.definition.units[0]!.acceptance[0]!;
    const edits = JSON.stringify([{ target: { kind: "unit", id: "snapshot", field: "acceptance" },
      before: active.definition.units[0]!.acceptance, after: [{ ...predicate, expected: "display-revision" }] }]);
    const revised = await consoleInput(socket, `/mission revise durable-fixture set ${edits}`);
    expect(revised.ok).toBe(true);
    const missed = await consoleInput(socket, "/mission status durable-fixture");
    expect(JSON.parse(missed.message).notifications).toContain("mission.revised: durable-fixture @2");
    await host.wait(() => store!.inspectMission(id).events.some(({ kind, attemptId: observedId }) =>
      kind === "attempt.receipt" && observedId === attemptId));
    await host.wait(() => store!.inspectMission(id).events.some(({ kind, revision }) => kind === "attempt.started" && revision === 2));
    const beforeDisplay = store.inspectMission(id);
    expect(beforeDisplay.events.some(({ kind, attemptId: idOfAttempt }) => kind === "attempt.receipt" && idOfAttempt === attemptId)).toBe(true);
    expect(beforeDisplay.events.filter(({ kind }) => kind === "mission.input.visible")).toHaveLength(0);
    expect(beforeDisplay.events.filter(({ kind }) => kind === "mission.notification.delivered")).toHaveLength(0);
    const count = beforeDisplay.events.filter(({ kind }) => kind === "attempt.reserved").length;
    terminal = spawn("script", ["-q", "-e", "-c",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(packageRoot(), "scripts/mission-console.ts"))} ${JSON.stringify(socket)}`,
      "/dev/null"], { cwd: fixture.root, stdio: ["pipe", "pipe", "pipe"] });
    let screen = "";
    terminal.stdout!.on("data", (data) => { screen += data.toString(); });
    terminal.stderr!.on("data", (data) => { screen += data.toString(); });
    await host.wait(() => screen.includes("mission> "));
    terminal.stdin!.write("/mission status durable-fixture\n");
    try {
      await host.wait(() => screen.includes("mission.revised: durable-fixture @2") &&
        store!.inspectMission(id).events.some(({ kind }) => kind === "mission.input.visible"));
    } catch (error) { throw new Error(`${error}; console screen: ${screen.slice(-1800)}`); }
    const displayed = store.inspectMission(id);
    const visible = displayed.events.find(({ kind }) => kind === "mission.input.visible")!;
    const delivery = displayed.events.find(({ kind }) => kind === "mission.notification.delivered")!;
    expect(delivery.payload.operatorInputId).toBe(visible.payload.operatorInputId);
    expect(Number(visible.payload.responseMs)).toBeGreaterThan(0);
    expect((delivery.payload.eventIds as string[]).includes(
      displayed.events.find(({ kind }) => kind === "mission.revised")!.eventId)).toBe(true);
    const duplicate = await new Promise<any>((resolve, reject) => {
      const peer = connect(socket); let data = "";
      peer.on("connect", () => peer.write(JSON.stringify({ proof: readFileSync(`${socket}.key`).toString("hex"),
        visibleId: visible.payload.operatorInputId }) + "\n"));
      peer.on("data", (part) => { data += part; });
      peer.on("end", () => resolve(JSON.parse(data)));
      peer.on("error", reject);
    });
    expect(duplicate.ok).toBe(false);
    const final = store.inspectMission(id);
    expect(final.events.filter(({ kind }) => kind === "mission.input.visible")).toHaveLength(1);
    expect(final.events.filter(({ kind }) => kind === "mission.notification.delivered")).toHaveLength(1);
    expect(final.events.filter(({ kind }) => kind === "attempt.reserved")).toHaveLength(count);
    if (process.env.MISSION_T5_ARTIFACT_DIR) {
      mkdirSync(process.env.MISSION_T5_ARTIFACT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MISSION_T5_ARTIFACT_DIR, "host-causal-display-observed.json"), JSON.stringify({
        runtime: "Pi 0.87.0 RPC plus operator PTY", hostPid: host.child.pid, terminalPid: terminal.pid,
        missionId: id, attemptId, revised, missed: { causalId: missed.causalId, notifications: JSON.parse(missed.message).notifications },
        beforeDisplay: { revision: beforeDisplay.revision, attempts: count,
          workerReceipt: beforeDisplay.events.some(({ kind, attemptId: observedId }) => kind === "attempt.receipt" && observedId === attemptId),
          deliveryCount: beforeDisplay.events.filter(({ kind }) => kind === "mission.notification.delivered").length,
          visibleCount: beforeDisplay.events.filter(({ kind }) => kind === "mission.input.visible").length },
        screen: screen.includes("mission.revised: durable-fixture @2"), visible, delivery, duplicate,
        finalAttemptIds: final.events.filter(({ kind }) => kind === "attempt.reserved").map(({ attemptId }) => attemptId),
      }, null, 2));
    }
  } finally {
    store?.close();
    if (terminal && terminal.exitCode === null) { terminal.stdin!.write("/exit\n"); await Promise.race([
      new Promise<void>((resolve) => terminal!.once("close", () => resolve())),
      Bun.sleep(1_000).then(() => terminal!.kill("SIGKILL")),
    ]); }
    if (host.child.exitCode === null) await host.close("SIGKILL");
  }
}, 60_000);
