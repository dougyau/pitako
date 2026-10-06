import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerMissionExtension } from "../extensions/mission/index.ts";
import { openSqlite } from "../extensions/board/sqlite.ts";
import { observationAdapters, observationFiles, observationFixture } from "../tests/mission-observation-fixture.ts";
import { installMissionLocalProvider } from "../tests/mission-local-provider.ts";
import { evidenceFile } from "../extensions/workflow.ts";

const script = fileURLToPath(import.meta.url);
const captureRoot = process.env.MISSION_T4_CAPTURE_ROOT;
function capture(name, value) {
  if (!captureRoot) return;
  const file = evidenceFile("workflow-improvements-p4", `T4/${name}`, captureRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file,
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
}
const diagnostics = (page) => page.diagnostics.map((row) => row.code);
const authorityFiles = (files) => Object.fromEntries(Object.entries(files)
  .filter(([file]) => !file.endsWith("-shm") && !file.endsWith("-wal")));
const changedFiles = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((file) => !before[file]?.equals(after[file] ?? Buffer.alloc(0)));
if (process.argv[2] === "--consult") {
  const query = JSON.parse(process.argv[4]);
  process.env.PI_CODING_AGENT_DIR = process.argv[3];
  const api = observationAdapters(process.argv[5]);
  const page = await api.toolPage(query);
  assert.deepEqual(await api.command(query), page);
  console.log(JSON.stringify(page));
} else {
  process.env.PI_OFFLINE = "1";
  const f = await observationFixture();
  let db, session;
  try {
    const query = { missionId: f.mission.id, unitId: f.unit.id, attemptId: f.earlierAttempt };
    const api = observationAdapters(f.executionRoot);
    const pages = [];
    const child = (input) => {
      const result = spawnSync(process.execPath, [...process.execArgv, script, "--consult",
        f.fixture.stateDir, JSON.stringify(input), f.executionRoot], { encoding: "utf8", timeout: 30000 });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const before = observationFiles(f.fixture.base), epoch = f.store.ownerEpoch;
    let cursor, items = [];
    do {
      const page = await api.toolPage({ ...query, cursor });
      assert.deepEqual(await api.command({ ...query, cursor }), page);
      assert.deepEqual(child({ ...query, cursor }), page, "fresh native Node consultation projection");
      pages.push(page); items.push(...page.items); cursor = page.cursor ?? undefined;
    } while (cursor);
    assert.deepEqual(authorityFiles(observationFiles(f.fixture.base)), authorityFiles(before), "DB/catalog/native/object bytes unchanged");
    assert.equal(f.store.ownerEpoch, epoch);
    const brief = items.find((item) => item.kind === "assignment").originalIntent.workBrief;
    const native = items.find((item) => item.kind === "native-history");
    const report = items.find((item) => item.action === "attempt.receipt").evidence[0];
    const reconstruct = async (reference) => {
      let cursor = reference.readCursor, chunks = [];
      do {
        const page = child({ ...query, cursor });
        assert.deepEqual(page, await api.command({ ...query, cursor }));
        pages.push(page);
        for (const item of page.items) chunks.push(Buffer.from(item.data, "base64"));
        cursor = page.cursor;
      } while (cursor);
      return Buffer.concat(chunks);
    };
    assert.deepEqual(await reconstruct(brief), Buffer.from(f.unit.originalIntent.workBrief));
    assert.deepEqual(await reconstruct(native), f.nativeBytes);
    assert.deepEqual(await reconstruct(report), f.hostReport);
    assert.deepEqual(authorityFiles(observationFiles(f.fixture.base)), authorityFiles(before));
    const warmChanges = changedFiles(before, observationFiles(f.fixture.base));
    assert(warmChanges.every((file) => file === `${f.fixture.dbPath}-shm`),
      "live WAL/main/catalog/object/native data must not change during consultation");
    capture("native-node/observation-pages.json", pages);
    capture("native-node/authority.json", { runtime: process.version, backend: "native Node SQLite",
      ownerEpochUnchanged: true, authorityFilesUnchanged: true, sqliteSideEffects: warmChanges,
      freshProcesses: true, earlierAttempt: f.earlierAttempt, currentAttempt: f.currentAttempt,
      nativeHistoryId: f.earlier.historyId });

    // Fixture-only close/checkpoint, then observe any read-side cold sidecars.
    f.store.close();
    db = await openSqlite(f.fixture.dbPath, { setWal: false });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); db = undefined;
    for (const suffix of ["-wal", "-shm"]) rmSync(`${f.fixture.dbPath}${suffix}`, { force: true });
    const coldBefore = observationFiles(f.fixture.base);
    assert.deepEqual(child(query), pages[0]);
    await reconstruct(native);
    assert.deepEqual(authorityFiles(observationFiles(f.fixture.base)), authorityFiles(coldBefore), "cold authority unchanged");
    const coldChanges = changedFiles(coldBefore, observationFiles(f.fixture.base));
    assert(coldChanges.every((file) => [`${f.fixture.dbPath}-shm`, `${f.fixture.dbPath}-wal`].includes(file)));
    assert.equal(observationFiles(f.fixture.base)[`${f.fixture.dbPath}-wal`]?.length ?? 0, 0,
      "cold sidecar is not a journaled authority write");
    capture("native-node/cold-authority.json", { noExecutionOwner: true, authorityFilesUnchanged: true,
      sqliteSideEffects: coldChanges, nativeBytes: f.nativeBytes.length });

    // Real principal SDK transport with a deterministic offline model. Its fixture policy
    // follows production cursors and bases the advisory decision on the received bytes.
    // This is wiring evidence, not a paid-model effectiveness claim.
    let next = { name: "mission_observe", arguments: query }, phase = "catalog";
    const jobs = [], observed = {}, calls = [], commandPages = [];
    let collected = [], decision = "";
    const provider = await installMissionLocalProvider({
      agentDir: f.fixture.stateDir, contextWindow: 128000, toolTurns: 200,
      toolForPrompt: () => next, responseForPrompt: () => decision || "Consulting retained evidence.",
    });
    const impl = globalThis[`__${provider.provider.replace(/\W/g, "_")}`], originalStream = impl.streamSimple;
    impl.streamSimple = (model, context, options) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") {
        const page = JSON.parse(last.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
        assert.equal(page.authority, "read-only");
        assert(!diagnostics(page).includes("mission_not_bound_to_repository"));
        calls.push({ phase, page });
        if (phase === "catalog") {
          for (const row of page.items) {
            if (row.kind === "assignment" && !jobs.some((job) => job.kind === "brief"))
              jobs.push({ kind: "brief", cursor: row.originalIntent.workBrief.readCursor });
            if (row.action === "attempt.receipt") jobs.push({ kind: "host", cursor: row.evidence[0].readCursor });
            if (row.kind === "native-history") jobs.push({ kind: "native", cursor: row.readCursor });
          }
        } else {
          for (const row of page.items) collected.push(Buffer.from(row.data, "base64"));
        }
        if (page.cursor) next = { name: "mission_observe", arguments: { ...query, cursor: page.cursor } };
        else {
          if (phase !== "catalog") { observed[phase] = Buffer.concat(collected).toString(); collected = []; }
          const job = jobs.shift();
          if (job) { phase = job.kind; next = { name: "mission_observe", arguments: { ...query, cursor: job.cursor } }; }
          else {
            assert(observed.brief.includes("setup and GATES"));
            const host = JSON.parse(observed.host);
            assert.equal(host.normal.exitCode, 0); assert.equal(host.parallel.exitCode, 1);
            assert(observed.native.includes("unsupported-premise") && observed.native.includes("grep -R callback node_modules/pi-hermes-memory"));
            decision = "Synthetic P3-shaped retained evidence: original task is setup/GATES, but attempt investigated Hermes from an unsupported dependency premise. Normal integration passed; only parallel runner failed. Stacktrace is not dependency blame. Select the same integration case under the parallel runner with Hermes enabled/disabled and identical inputs, recording runner/runtime versions and outputs. Do not repair Hermes. If repair becomes necessary, recommend an exact native /mission pause durable-fixture followed by a scoped revise decision; this observation does not pause or authorize either.";
            next = undefined;
          }
        }
      }
      return originalStream(model, context, options);
    };
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: f.executionRoot, agentDir: f.fixture.stateDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
      extensionFactories: [(pi) => { pi.registerProvider(provider.provider, impl); registerMissionExtension(pi); }],
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({ authPath: path.join(f.fixture.stateDir, "auth.json"),
      modelsPath: null, allowModelNetwork: false });
    const created = await createAgentSession({
      cwd: f.executionRoot, agentDir: f.fixture.stateDir, resourceLoader: loader, settingsManager,
      modelRuntime: runtime,
      sessionManager: SessionManager.create(f.executionRoot, path.join(f.fixture.base, "principal-sdk")),
    });
    session = created.session;
    const model = runtime.getModel(provider.provider, provider.model);
    assert(model); await session.setModel(model);
    await session.bindExtensions({ uiContext: { notify: (text) => commandPages.push(JSON.parse(text)) } });
    session.setActiveToolsByName(["mission_observe"]);
    assert(session.getActiveToolNames().includes("mission_observe"), JSON.stringify(session.getAllTools()));
    await session.prompt(`/mission inspect ${f.mission.id} --unit ${f.unit.id} --attempt ${f.earlierAttempt}`);
    assert.deepEqual(commandPages[0], pages[0]);
    const managedBeforeSdk = observationFiles(path.join(f.fixture.stateDir, "pitako"));
    await session.prompt("Inspect the earlier attempt using mission_observe, reconstruct original versus actual work, choose a discriminating check and recommend a bounded lawful decision only.");
    assert(session.getLastAssistantText()?.includes("Stacktrace is not dependency blame"),
      JSON.stringify({ decision, phase, calls: calls.length, trace: provider.trace, messages: session.state.messages.slice(-2) }));
    assert(calls.some((call) => call.phase === "native"));
    assert.deepEqual(authorityFiles(observationFiles(path.join(f.fixture.stateDir, "pitako"))), authorityFiles(managedBeforeSdk),
      "principal SDK writes its own transcript, not mission/catalog/artifact authority");
    capture("principal-sdk/observation.json", { provenance: "synthetic P3-shaped fixture; actual principal SDK, offline deterministic provider",
      availableTools: session.getActiveToolNames(), commandPages, calls, decision: session.getLastAssistantText(),
      managedAuthorityFilesUnchanged: true, sqliteSideEffects: changedFiles(managedBeforeSdk, observationFiles(path.join(f.fixture.stateDir, "pitako"))) });
    capture("principal-sdk/native.jsonl", readFileSync(session.sessionManager.getSessionFile(), "utf8"));
    console.log(JSON.stringify({ runtime: process.version, provenance: "synthetic P3-shaped captured evidence",
      earlierAttempt: true, fullBrief: true, nativeResults: true, reload: true,
      actualPrincipalSdk: true, discriminatingCheckSelected: true, advisoryOnly: true,
      authorityFilesUnchanged: true, warmSqliteSideEffects: warmChanges, coldSqliteSideEffects: coldChanges,
      modelEffectiveness: "not measured" }));
  } finally {
    session?.dispose(); db?.close(); f.store.close();
    rmSync(f.fixture.base, { recursive: true, force: true });
  }
}
