import { expect, test, spyOn } from "bun:test";
import { promises as fs, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as archive from "../extensions/table/archive.ts";
import { evidenceFile, ledgerFile, ledgerTemplate, openExecutionPlan, planFile, readFrozenPlan } from "../extensions/workflow.ts";
import * as agent from "../extensions/agent/index.ts";
import { architectureFixture } from "./fixtures/architecture.ts";
import { jsonBytes, sealPages } from "../extensions/table/results.ts";
import { cancelAllWorkers, clearBackgroundOwner, setBackgroundExecutor, teamWorkerStatus, workerHandoff } from "../extensions/agent/background.ts";
import { retireTeamEvaluation, hasUnsettledTeamWork } from "../extensions/team.ts";
import { assertQuiescent, reserveOperation } from "../extensions/agent/head/operation-leases.ts";
import { captureCallContext, checkCallContext, withCallContext } from "../extensions/workflow-engine.ts";
import { openSqliteSync } from "../extensions/board/sqlite.ts";

const privateRoot = () => realpathSync(mkdtempSync(path.join(tmpdir(), "pitako-table-archive-")));
const parse = (envelope: any) => JSON.parse(envelope.content[0].text);
const startArchive = archive.startTableArchive;
const prepareTeamWatch = agent.prepareTeamWatch;
// Admission now journals before preparation; it still may not adopt a ledger or archive.
const journalEntries = new Set([".pitako", ".pitako/runs", "runs",
  ...["workflow-state.sqlite", "workflow-state.sqlite-shm", "workflow-state.sqlite-wal"]
    .flatMap(file => [`.pitako/runs/${file}`, `runs/${file}`])]);
const withoutJournal = (entries: string[]) => entries.filter(entry => !journalEntries.has(entry));
// These databases provide per-plan exclusion, not a ledger, binding or archive authority.
function expectEmptyLock(file: string) {
  const db = openSqliteSync(file, { readOnly: true });
  try { expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]); }
  finally { db.close(); }
}

for (const protocol of ["architecture", "review"] as const) {
  const f = architectureFixture(protocol);
  test(`${protocol} public shutdown starts and joins the cancelled archive after released closure`, f.fixture.ownedCase(`${protocol} early retirement`, async () => {
    const disposing = Promise.withResolvers<void>(), releaseDispose = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>(), releaseWrite = Promise.withResolvers<void>();
    f.fixture.finishOnCleanup(() => { releaseDispose.resolve(); releaseWrite.resolve(); });
    const s = await f.setup({ config: "", prompt(_session, request, body) {
      return request.stage === "composition" ? { ...body, specialists: [] } : body;
    }, async dispose() { disposing.resolve(); await releaseDispose.promise; } });
    const operations: archive.TableArchive[] = [];
    let canonical: string | undefined, resultId: string | undefined;
    const capture = spyOn(archive, "startTableArchive").mockImplementation((...args) => {
      resultId = args[1]; canonical = args[2];
      const operation = startArchive(...args); operations.push(operation); return operation;
    });
    const open = fs.open.bind(fs);
    let write: ReturnType<typeof spyOn> | undefined;
    const hold = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const original = handle.writeFile.bind(handle);
        write = spyOn(handle, "writeFile").mockImplementation(async (...parameters) => {
          writing.resolve(); await releaseWrite.promise; return original(...parameters);
        });
      }
      return handle;
    });
    let retirement: Promise<void> | undefined;
    try {
      const file = planFile("retiring", s.root); mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "---\nid: retiring\nrevision: 1\nstatus: frozen\n---\nRetired owner archive.\n");
      const binding = openExecutionPlan("retiring", s.root).binding;
      const started = await s.invoke(`${protocol}_start`, { goal: "Retain cancelled diagnostic", plan: "retiring", unit: "inspect",
        ...(protocol === "review" ? { object: { kind: "brief", text: "Local" }, criteria: ["stable"] } : {}) });
      expect(started.isError).not.toBe(true);
      await disposing.promise;
      expect(s.seen.some(item => item.request.stage === "synthesis")).toBe(true);
      expect(operations).toEqual([]);
      expect(existsSync(evidenceFile("retiring", "table-results", s.root))).toBe(false);
      let retired = false;
      retirement = s.emit("session_shutdown").then(() => { retired = true; });
      expect(teamWorkerStatus(s.evaluation.token, started.details.instanceId)[0]?.closure.state).toBe("pending");
      expect(s.sent).toEqual([]);
      // Read cwd cannot replace the archive authority captured before shutdown.
      s.ctx.cwd = path.dirname(s.root);
      releaseDispose.resolve();
      expect(await Promise.race([writing.promise.then(() => "writing"), retirement.then(() => "retired")])).toBe("writing");
      expect(retired).toBe(false);
      expect(operations).toHaveLength(1);
      expect(operations[0]!.state).toEqual({ state: "pending" });
      expect(teamWorkerStatus(s.evaluation.token, started.details.instanceId)[0]?.closure.state).toBe("released");
      const report = JSON.parse(canonical!);
      expect(report).toMatchObject({ judgment: null, host: { status: "cancelled", closure: { state: "released" } } });
      const destination = evidenceFile(binding.planId, `table-results/${resultId}.json`, binding.executionRoot);
      expect(existsSync(destination)).toBe(false);
      expect(readdirSync(path.dirname(destination))).toHaveLength(1);
      expect(readdirSync(path.dirname(destination))[0]).toEndWith(".tmp");
      expect(workerHandoff(started.details.instanceId)).toBeUndefined();
      expect(s.sent).toEqual([]);
      releaseWrite.resolve(); await retirement;
      expect(retired).toBe(true);
      expect(operations[0]!.state).toEqual({ state: "written", path: destination });
      expect(readFileSync(destination, "utf8")).toBe(canonical!);
      expect(readdirSync(path.dirname(destination))).toEqual([`${resultId}.json`]);
      expect(teamWorkerStatus(s.evaluation.token)).toEqual([]);
      expect(s.sent).toEqual([]);
      expect(s.branch).toEqual([]);
      await s.emit("session_shutdown");
      expect(operations).toHaveLength(1);
    } finally {
      releaseDispose.resolve(); releaseWrite.resolve();
      if (retirement) await retirement;
      await s.close();
      await Promise.all(operations.map(operation => operation.completion));
      write?.mockRestore(); hold.mockRestore(); capture.mockRestore();
    }
  }));

  test(`${protocol} competing sibling ledger rejects admission without fallback or archive`, f.fixture.ownedCase(`${protocol} competing ledger`, async () => {
    const root = privateRoot();
    f.fixture.directories.push(root);
    let s: Awaited<ReturnType<typeof f.setup>> | undefined;
    const operations: archive.TableArchive[] = [];
    const capture = spyOn(archive, "startTableArchive").mockImplementation((...args) => {
      const operation = startArchive(...args); operations.push(operation); return operation;
    });
    const authority = path.join(root, "authority"), execution = path.join(root, "execution");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: authority, encoding: "utf8" });
    const entries = (root: string) => withoutJournal(readdirSync(root, { recursive: true }).map(String)).sort();
    let beforeAuthority: [string, Buffer<ArrayBuffer>][], beforeEntries: string[], beforeExecution: string[], beforeRegistry: string;
    let binding: ReturnType<typeof openExecutionPlan>["binding"];
    try {
      mkdirSync(authority);
      git("init", "-q", "-b", "main");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial");
      git("worktree", "add", "-q", "-b", "execution", execution);
      // Admit the actual foreground workspace, rather than changing cwd under
      // an already bound manager from an unrelated root.
      s = await f.setup({ root: execution, storageRoot: root, config: "" });
      const file = planFile("competing", authority); mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "---\nid: competing\nrevision: 1\nstatus: frozen\n---\nSibling authority.\n");
      binding = openExecutionPlan("competing", authority).binding;
      const evidence = evidenceFile("competing", "kept.txt", authority);
      mkdirSync(path.dirname(evidence), { recursive: true });
      writeFileSync(evidence, "Existing authority evidence.\n");
      const files = [file, ledgerFile("competing", authority), evidence];
      beforeAuthority = files.map(file => [file, readFileSync(file)]);
      beforeEntries = entries(path.join(authority, ".pitako"));
      beforeExecution = entries(execution);
      beforeRegistry = git("worktree", "list", "--porcelain");
      expect(existsSync(ledgerFile("competing", execution))).toBe(false);
      // Ordinary watched admission must still reject; capture must not turn this into fallback.
      expect(() => openExecutionPlan("competing", execution, { createLedger: false })).toThrow("competing ledger");
      const started = await s.invoke(`${protocol}_start`, { goal: "Reject competing execution authority", plan: "competing", unit: "inspect",
        ...(protocol === "review" ? { object: { kind: "brief", text: "Local" }, criteria: ["stable"] } : {}) });
      // C captures/validates source before reserving a Team member. There is no
      // root result to collect or archive when that admission itself is refused.
      expect(started.isError).toBe(true);
      expect(started.content[0].text).toContain("competing ledger");
      expect(started.content[0].text).toContain(ledgerFile("competing", authority));
      expect(started.details).not.toHaveProperty("assignmentId");
      expect(started.details).not.toHaveProperty("roomId");
      expect(s.host.sessions).toEqual([]);
      expect(operations).toEqual([]);
      expect(teamWorkerStatus(s.evaluation.token)).toEqual([]);
      expect(s.sent).toEqual([]);
      expect(s.branch).toEqual([]);
      const context = captureCallContext(execution);
      if (context.kind !== "ordinary") throw new Error("fixture requires ordinary context");
      expect(context.guard.store.all("attempts")).toEqual([]);
      expect(context.guard.store.all("holds")).toEqual([]);
      expect(archive.captureTableArchive(execution, "competing"))
        .toEqual({ unavailable: expect.stringContaining("competing ledger") });
    } finally {
      await s?.close();
      await Promise.all(operations.map(operation => operation.completion));
      capture.mockRestore();
    }
    // Check after retirement too: no delayed fallback, ledger, binding or registry in A.
    expect(operations).toEqual([]);
    expect(entries(execution)).toEqual(beforeExecution!);
    expect(existsSync(path.join(execution, ".pitako/table-results"))).toBe(false);
    expect(existsSync(path.join(root, ".pitako"))).toBe(false);
    for (const [file, bytes] of beforeAuthority!) expect(readFileSync(file)).toEqual(bytes);
    expect(entries(path.join(authority, ".pitako"))).toEqual(beforeEntries!);
    expect(git("worktree", "list", "--porcelain")).toBe(beforeRegistry!);
    expect(openExecutionPlan("competing", authority).binding).toEqual(binding!);
    expect(existsSync(path.join(authority, ".pitako/table-results"))).toBe(false);
    expect(existsSync(evidenceFile("competing", "table-results", authority))).toBe(false);
  }));

  for (const action of ["prepare", "cancel"] as const) test(`${protocol} legacy archive reservation stays observational through ${action} before preparation`, f.fixture.ownedCase(`${protocol} legacy ${action}`, async () => {
    const s = await f.setup({ config: "", prompt(_session, request, body) {
      return request.stage === "composition" ? { ...body, specialists: [] } : body;
    } });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.fixture.finishOnCleanup(release.resolve);
    const operations: archive.TableArchive[] = [];
    const capture = spyOn(archive, "startTableArchive").mockImplementation((...args) => {
      const operation = startArchive(...args); operations.push(operation); return operation;
    });
    // Hold the actual admission boundary, not archive capture or ledger I/O.
    const preflight = spyOn(agent, "prepareTeamWatch").mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; args[3]();
      return prepareTeamWatch(...args);
    });
    try {
      execFileSync("git", ["init", "-q", s.root]);
      const sub = path.join(s.root, "sub"); mkdirSync(sub);
      const alias = path.join(s.root, "alias"); symlinkSync(sub, alias);
      s.ctx.cwd = alias;
      const file = planFile("legacy", s.root); mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "---\nid: legacy\nrevision: 1\nstatus: frozen\n---\nLegacy archive fixture.\n");
      const ledger = ledgerFile("legacy", s.root); mkdirSync(path.dirname(ledger), { recursive: true });
      writeFileSync(ledger, `${ledgerTemplate(readFrozenPlan("legacy", s.root).meta)}\nKeep legacy evidence.\n`);
      const before = readFileSync(ledger);
      const planBefore = readFileSync(file);
      const entries = () => withoutJournal(readdirSync(path.join(s.root, ".pitako"), { recursive: true }).map(String)).sort();
      const beforeEntries = entries();
      const started = await s.invoke(`${protocol}_start`, { goal: "Observe archive without adopting execution", plan: "legacy", unit: "inspect",
        ...(protocol === "review" ? { object: { kind: "brief", text: "Local" }, criteria: ["stable"] } : {}) });
      expect(started.isError).not.toBe(true);
      await entered.promise;
      expect(s.host.sessions).toEqual([]);
      expect(readFileSync(ledger)).toEqual(before);
      expect(entries()).toEqual(beforeEntries); // No archive-enabling ledger or registry.
      if (action === "cancel") {
        expect((await s.invoke(`${protocol}_control`, { roomId: started.details.roomId, action: "stop" })).isError).not.toBe(true);
        expect(readFileSync(ledger)).toEqual(before);
        expect(entries()).toEqual(beforeEntries);
      }
      release.resolve(); await s.delivered.promise;
      await Promise.all(operations.map(operation => operation.completion));
      await s.bookkeeping(started.details.instanceId);
      const target = { assignmentId: started.details.assignmentId };
      const first = await s.invoke("team_result", target);
      const resultId = parse(first).header.id;
      const result = await s.read("team_result", target, first);
      if (action === "cancel") {
        expect(result.judgment).toBeNull();
        expect(s.host.sessions).toEqual([]);
        expect(readFileSync(ledger)).toEqual(before);
      } else {
        expect(result.judgment).not.toBeNull();
        // Only ordinary preparation adopts the ledger, after archive capture.
        const adopted = readFileSync(ledger, "utf8");
        expect(adopted).toContain("execution_root_b64:");
        expect(adopted).toContain("plan_source_b64:");
        expect(adopted).toContain("Keep legacy evidence.");
      }
      expect(operations).toHaveLength(1);
      const destination = path.join(realpathSync(s.root), ".pitako", "table-results", `${resultId}.json`);
      expect(operations[0]!.state).toEqual({ state: "written", path: destination });
      expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual(result);
      expect(readFileSync(file)).toEqual(planBefore);
      const locks = [`runs/legacy/team-holds-projection.sqlite`,
        ...(action === "prepare" ? ["runs/legacy/ledger-writer.sqlite"] : [])];
      expect(entries()).toEqual([...beforeEntries, ...locks, "table-results", `table-results/${resultId}.json`].sort());
      for (const lock of locks) expectEmptyLock(path.join(s.root, ".pitako", lock));
    } finally {
      release.resolve(); await s.close();
      await Promise.all(operations.map(operation => operation.completion));
      preflight.mockRestore(); capture.mockRestore();
    }
  }));

  for (const route of ["bound", "subdirectory", "alias"] as const) test(`${protocol} archives canonical bytes at captured ${route} destination without blocking receipt`, f.fixture.ownedCase(`${protocol} archive ${route}`, async () => {
    const s = await f.setup({ config: "", prompt(_session, request, body) {
      if (request.stage === "composition") return { ...body, specialists: [] };
      if (request.stage === "synthesis") return protocol === "architecture"
        ? { ...body, recommendation: "界😀\\\"\n".repeat(2000) } : { ...body, summary: "界😀\\\"\n".repeat(2000) };
    } });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.fixture.finishOnCleanup(release.resolve);
    const operations: archive.TableArchive[] = [];
    const capture = spyOn(archive, "startTableArchive").mockImplementation((...args) => {
      const operation = startArchive(...args); operations.push(operation); return operation;
    });
    const open = fs.open.bind(fs);
    let write: ReturnType<typeof spyOn> | undefined;
    const hold = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const original = handle.writeFile.bind(handle);
        write = spyOn(handle, "writeFile").mockImplementation(async (...parameters) => {
          entered.resolve(); await release.promise; return original(...parameters);
        });
      }
      return handle;
    });
    let binding: ReturnType<typeof openExecutionPlan>["binding"] | undefined;
    try {
      execFileSync("git", ["init", "-q", s.root]);
      const sub = path.join(s.root, "sub"); mkdirSync(sub);
      const alias = path.join(s.root, "alias"); symlinkSync(sub, alias);
      s.ctx.cwd = route === "alias" ? alias : sub;
      if (route === "bound") {
        const file = planFile("archive", s.root); mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "---\nid: archive\nrevision: 1\nstatus: frozen\n---\nArchive fixture.\n");
        binding = openExecutionPlan("archive", s.root, { createLedger: true }).binding;
      } else {
        const file = planFile("prospective", s.root); mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "---\nid: prospective\nrevision: 1\nstatus: draft\n---\nNo execution binding.\n");
      }
      const args = { goal: "Archive independently", plan: binding ? "archive" : "prospective", unit: "inspect",
        ...(protocol === "review" ? { object: { kind: "brief", text: "Local object" }, criteria: ["Stable report"] } : {}) };
      const started = await s.invoke(`${protocol}_start`, args);
      expect(started.isError).not.toBe(true);
      await entered.promise; await s.delivered.promise;
      expect(operations).toHaveLength(1);
      expect(operations[0]!.state).toEqual({ state: "pending" });
      const message = s.sent.find(item => item.message.customType === "pitako.worker.result")!.message;
      const exact = JSON.stringify(message);
      expect(jsonBytes(message)).toBeLessThanOrEqual(4096);
      expect(JSON.parse(message.content).projection.header.complete).toBe(false);
      expect(workerHandoff(started.details.instanceId)?.delivery).toBe("incorporated");
      const receipt = workerHandoff(started.details.instanceId);
      if (!receipt) throw new Error("canonical result has no handoff receipt");
      // Later read cwd must not choose another archive root.
      s.ctx.cwd = s.root;
      const resultTarget = { assignmentId: started.details.assignmentId };
      const first = await s.invoke("team_result", { ...resultTarget, maxBytes: 4096 });
      const report = await s.read("team_result", resultTarget, first);
      expect(report.judgment).not.toBeNull();
      const resultId = parse(first).header.id;
      const destination = binding ? evidenceFile(binding.planId, `table-results/${resultId}.json`, binding.executionRoot)
        : path.join(realpathSync(s.root), ".pitako", "table-results", `${resultId}.json`);
      expect(existsSync(destination)).toBe(false);
      const archiveDirectory = path.relative(s.root, path.dirname(destination)) + path.sep;
      const unrelatedEntries = () => readdirSync(s.root, { recursive: true }).map(String).filter(entry => !entry.startsWith(archiveDirectory)).sort();
      const beforeFiles = unrelatedEntries();
      const beforeLedger = binding ? readFileSync(ledgerFile(binding.planId, s.root), "utf8") : undefined;
      if (binding) expect(hasUnsettledTeamWork(s.evaluation, binding.planId, s.root, binding)).toBe(true);
      const diagnosticTarget = { roomId: started.details.roomId };
      const old = await s.invoke(`${protocol}_read`, { ...diagnosticTarget, maxBytes: 4096 });
      expect(jsonBytes(old)).toBeLessThanOrEqual(4096);
      expect(jsonBytes(parse(old).header)).toBeLessThanOrEqual(2048);
      expect((await s.read(`${protocol}_read`, diagnosticTarget, old)).archive).toEqual({ state: "pending" });
      const oldCursor = parse(old).header.cursor;
      expect(typeof oldCursor).toBe("string");
      const oldReplay = await s.invoke(`${protocol}_read`, { ...diagnosticTarget, cursor: oldCursor });
      release.resolve(); await operations[0]!.completion;
      expect(operations[0]!.state).toEqual({ state: "written", path: destination });
      expect(await s.invoke(`${protocol}_read`, { ...diagnosticTarget, cursor: oldCursor })).toEqual(oldReplay);
      expect(await s.read(`${protocol}_read`, { ...diagnosticTarget, section: "archive", maxBytes: 4096 }))
        .toEqual({ state: "written", path: destination });
      // Compare the original canonical page fragments with the existing file, not a reserialized subset.
      let page = parse(first), canonical = page.fragment;
      while (page.header.cursor) {
        const envelope = await s.invoke("team_result", { ...resultTarget, cursor: page.header.cursor });
        expect(jsonBytes(envelope)).toBeLessThanOrEqual(4096);
        page = parse(envelope); canonical += page.fragment;
      }
      expect(readFileSync(destination, "utf8")).toBe(canonical);
      expect(JSON.parse(canonical)).toEqual(report);
      expect(await s.invoke("team_result", { ...resultTarget, maxBytes: 4096 })).toEqual(first);
      expect(JSON.stringify(message)).toBe(exact);
      expect(workerHandoff(started.details.instanceId)?.delivery).toBe("incorporated");
      await s.bookkeeping(started.details.instanceId);
      expect(workerHandoff(started.details.instanceId)).toEqual({ ...receipt,
        bookkeeping: "reconciled", bookkeepingDiagnostic: undefined });
      expect(readdirSync(path.dirname(destination))).toEqual([`${resultId}.json`]);
      expect(unrelatedEntries()).toEqual(beforeFiles);
      if (binding) {
        expect(hasUnsettledTeamWork(s.evaluation, binding.planId, s.root, binding)).toBe(false);
        // This captured plan has no Board topic: its Markdown sink is N/A.
        expect(readFileSync(ledgerFile(binding.planId, s.root), "utf8")).toBe(beforeLedger!);
      }
      expect(existsSync(path.join(s.root, "sub", ".pitako"))).toBe(false);
      if (!binding) expect(existsSync(ledgerFile("prospective", s.root))).toBe(false);
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
    } finally {
      release.resolve(); await Promise.all(operations.map(operation => operation.completion));
      write?.mockRestore(); hold.mockRestore(); capture.mockRestore(); await s.close();
    }
  }));

  for (const failure of ["failed", "unavailable"] as const) test(`${protocol} archive ${failure} preserves result/receipt${failure === "failed" ? "; retirement joins I/O" : ""}`, f.fixture.ownedCase(`${protocol} archive ${failure}`, async () => {
    const s = await f.setup({ config: "", prompt(_session, request, body) {
      return request.stage === "composition" ? { ...body, specialists: [] } : body;
    } });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.fixture.finishOnCleanup(release.resolve);
    const operations: archive.TableArchive[] = [];
    const capture = spyOn(archive, "startTableArchive").mockImplementation((...args) => {
      const operation = startArchive(...args); operations.push(operation); return operation;
    });
    const open = fs.open.bind(fs);
    let write: ReturnType<typeof spyOn> | undefined;
    const hold = spyOn(fs, "open").mockImplementation(async (...args) => {
      if (failure === "unavailable" && String(args[0]).endsWith(".tmp")) {
        entered.resolve(); await release.promise;
        throw Object.assign(new Error("controlled archive permission refusal"), { code: "EACCES" });
      }
      const handle = await open(...args);
      if (String(args[0]).endsWith(".tmp")) write = spyOn(handle, "writeFile").mockImplementation(async () => {
        entered.resolve(); await release.promise; throw new Error("controlled archive write failure");
      });
      return handle;
    });
    let retiring: Promise<void> | undefined, releaseSecond = () => {};
    try {
      const started = await s.invoke(`${protocol}_start`, { goal: "Archive failure",
        ...(protocol === "review" ? { object: { kind: "brief", text: "Local" }, criteria: ["stable"] } : {}) });
      await entered.promise; await s.delivered.promise;
      const target = { assignmentId: started.details.assignmentId };
      const before = await s.invoke("team_result", target);
      expect((await s.read("team_result", target, before)).judgment).not.toBeNull();
      const exact = JSON.stringify(s.sent.find(item => item.message.customType === "pitako.worker.result")!.message);
      expect(workerHandoff(started.details.instanceId)?.delivery).toBe("incorporated");
      const receipt = workerHandoff(started.details.instanceId);
      release.resolve(); await operations[0]!.completion;
      expect(await s.invoke("team_result", target)).toEqual(before);
      expect(JSON.stringify(s.sent.find(item => item.message.customType === "pitako.worker.result")!.message)).toBe(exact);
      expect(workerHandoff(started.details.instanceId)).toEqual(receipt);
      const state = await s.read(`${protocol}_read`, { roomId: started.details.roomId, section: "archive" });
      expect(state).toMatchObject(failure === "failed" ? { state: "failed", settlement: "released" } : { state: "unavailable" });
      expect(state).not.toHaveProperty("path");
      expect(readdirSync(path.join(s.root, ".pitako/table-results"))).toEqual([]);
      if (failure === "unavailable") return;
      // A second owned archive stays pending through retirement; no cleanup races the open file.
      const held = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
      releaseSecond = finish.resolve;
      f.fixture.finishOnCleanup(finish.resolve);
      hold.mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith(".tmp")) {
          const original = handle.writeFile.bind(handle);
          write = spyOn(handle, "writeFile").mockImplementation(async (...parameters) => {
            held.resolve(); await finish.promise; return original(...parameters);
          });
        }
        return handle;
      });
      const second = await s.invoke(`${protocol}_start`, { goal: "Retire while archiving",
        ...(protocol === "review" ? { object: { kind: "brief", text: "Local" }, criteria: ["stable"] } : {}) });
      expect(second.isError).not.toBe(true); await held.promise;
      let retired = false;
      retiring = s.close().then(() => { retired = true; });
      await Promise.resolve();
      expect(retired).toBe(false);
      expect(readdirSync(path.join(s.root, ".pitako/table-results")).some(name => name.endsWith(".tmp"))).toBe(true);
      finish.resolve(); await retiring;
      expect(operations[1]!.state.state).toBe("written");
      expect(readdirSync(path.join(s.root, ".pitako/table-results")).some(name => name.endsWith(".tmp"))).toBe(false);
    } finally {
      release.resolve(); releaseSecond(); await Promise.all(operations.map(operation => operation.completion));
      if (retiring) await retiring; else await s.close();
      write?.mockRestore(); hold.mockRestore(); capture.mockRestore();
    }
  }));
}

test("archive destination capture rejects unavailable root and does not create prospective execution", () => {
  const root = privateRoot();
  try {
    expect(archive.captureTableArchive(path.join(root, "absent"))).toHaveProperty("unavailable");
    expect(archive.captureTableArchive(root, "prospective")).toEqual({ root });
    expect(existsSync(path.join(root, ".pitako"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const invalid of ["malformed", "incomplete", "foreign-root", "source-drift", "hash-mismatch", "legacy-mismatch"] as const) test(`archive capture refuses ${invalid} ledger without an alternate destination`, async () => {
  const root = privateRoot();
  try {
    const file = planFile("invalid", root); mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "---\nid: invalid\nrevision: 1\nstatus: frozen\n---\nFrozen fixture.\n");
    const opened = openExecutionPlan("invalid", root);
    const original = readFileSync(opened.ledger, "utf8");
    const wrongHash = "0".repeat(64);
    const changed = invalid === "malformed" ? "not a ledger"
      : invalid === "incomplete" ? original.replace(/^plan_source_b64:.*\n/m, "")
      : invalid === "foreign-root" ? original.replace(/^execution_root_b64:.*$/m, `execution_root_b64: ${Buffer.from(path.dirname(root)).toString("base64url")}`)
      : invalid === "hash-mismatch" ? original.replace(/^hash:.*$/m, `hash: ${wrongHash}`)
      : invalid === "legacy-mismatch" ? ledgerTemplate({ ...opened.meta, hash: wrongHash })
      : original;
    writeFileSync(opened.ledger, changed);
    if (invalid === "source-drift") writeFileSync(file, readFileSync(file, "utf8") + "Changed source.\n");
    const destination = archive.captureTableArchive(root, "invalid");
    expect(destination).toHaveProperty("unavailable");
    const operation = startArchive(destination, randomUUID(), "canonical"); await operation.completion;
    expect(operation.state.state).toBe("unavailable");
    expect(readFileSync(opened.ledger, "utf8")).toBe(changed);
    expect(existsSync(path.join(root, ".pitako/table-results"))).toBe(false);
    expect(existsSync(path.dirname(evidenceFile("invalid", "table-results", root)))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exclusive publication cannot overwrite; containment and permission have no alternate destination", async () => {
  const root = privateRoot(), outside = privateRoot(), id = randomUUID(), directory = path.join(root, ".pitako/table-results");
  try {
    mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, `${id}.json`); writeFileSync(destination, "previous");
    const collision = startArchive({ root }, id, "canonical"); await collision.completion;
    expect(collision.state).toMatchObject({ state: "failed", settlement: "released" });
    expect(collision.state).not.toHaveProperty("path");
    expect(readFileSync(destination, "utf8")).toBe("previous");
    expect(readdirSync(directory)).toEqual([`${id}.json`]);
    rmSync(directory, { recursive: true }); symlinkSync(outside, directory);
    const escape = startArchive({ root }, randomUUID(), "canonical"); await escape.completion;
    expect(escape.state.state).toBe("unavailable"); expect(readdirSync(outside)).toEqual([]);
    rmSync(directory); mkdirSync(directory);
    const denied = startArchive({ root }, randomUUID(), "canonical", { ...fs, async open() {
      throw Object.assign(new Error("controlled denied"), { code: "EACCES" });
    } });
    await denied.completion;
    expect(denied.state.state).toBe("unavailable"); expect(readdirSync(directory)).toEqual([]);
    const absent = startArchive({ root: path.join(root, "absent") }, randomUUID(), "canonical"); await absent.completion;
    expect(absent.state.state).toBe("unavailable"); expect(existsSync(path.join(root, "absent"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("written long path remains data in immutable bounded diagnostic pages", async () => {
  const owner = privateRoot(); let root = owner;
  const context = captureCallContext(owner);
  try {
    for (let i = 0; i < 42; ++i) root = path.join(root, "p".repeat(90));
    mkdirSync(root, { recursive: true });
    const operation = withCallContext(context, () => startArchive({ root }, randomUUID(), '{"judgment":"unchanged"}'));
    await operation.completion;
    expect(operation.state).toMatchObject({ state: "written" });
    const pages = sealPages({ archive: operation.state });
    let envelope = pages.read({ section: "archive", maxBytes: 4096 }), canonical = "", count = 0;
    while (true) {
      expect(jsonBytes(envelope)).toBeLessThanOrEqual(4096);
      const page = parse(envelope); expect(jsonBytes(page.header)).toBeLessThanOrEqual(2048);
      canonical += page.fragment; ++count;
      if (!page.header.cursor) break;
      envelope = pages.read({ cursor: page.header.cursor });
    }
    expect(count).toBeGreaterThan(1);
    expect(JSON.parse(canonical)).toEqual(operation.state);
    expect(readFileSync(JSON.parse(canonical).path, "utf8")).toBe('{"judgment":"unchanged"}');
    expect(existsSync(path.join(root, ".pitako/runs"))).toBe(false);
  } finally { checkCallContext(context).close(); rmSync(owner, { recursive: true, force: true }); }
});

test("archive effects share their captured owner's leases without recapturing a nested destination", async () => {
  const owner = privateRoot(), root = path.join(owner, "component");
  const other = privateRoot();
  mkdirSync(root);
  const context = captureCallContext(owner), guard = checkCallContext(context);
  const otherContext = captureCallContext(other);
  let gate: ReturnType<typeof reserveOperation> | undefined;
  let operation: archive.TableArchive | undefined;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    gate = reserveOperation(owner, "gates", context);
    const blocked = withCallContext(context, () => startArchive({ root }, randomUUID(), "blocked"));
    await blocked.completion;
    expect(blocked.state).toMatchObject({ state: "unavailable", reason: expect.stringContaining("lease") });
    expect(existsSync(path.join(root, ".pitako"))).toBe(false);
    gate.release(); gate = undefined;
    operation = withCallContext(context, () => startArchive({ root }, randomUUID(), "canonical", { ...fs, async open(...args) {
      const handle = await fs.open(...args);
      entered.resolve(); await release.promise;
      return handle;
    } }));
    await Promise.race([entered.promise, operation.completion.then(() => { throw new Error("archive ended before held open"); })]);
    expect(() => reserveOperation(owner, "gates", context)).toThrow("active");
    const independent = reserveOperation(other, "writer", otherContext); independent.release();
    release.resolve(); await operation.completion;
    expect(operation.state).toMatchObject({ state: "written" });
    expect(existsSync(path.join(root, ".pitako/runs"))).toBe(false);
    const after = reserveOperation(owner, "gates", context); after.release();
  } finally {
    release.resolve(); await operation?.completion; gate?.release();
    guard.close(); checkCallContext(otherContext).close();
    rmSync(owner, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true });
  }
});

test("uncertain file close retains temp, handle and writer reservation instead of publishing success", async () => {
  const root = privateRoot();
  let actual: Awaited<ReturnType<typeof fs.open>> | undefined;
  const operation = startArchive({ root }, randomUUID(), "canonical", { ...fs, async open(...args) {
    actual = await fs.open(...args);
    return new Proxy(actual, { get(target, key) {
      if (key === "close") return async () => { throw new Error("controlled close uncertainty"); };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } });
  await operation.completion;
  expect(operation.state).toMatchObject({ state: "failed", settlement: "unknown" });
  expect(operation.state).not.toHaveProperty("path");
  expect(operation.retainedHandle).toBeDefined();
  expect(readdirSync(path.join(root, ".pitako/table-results"))).toHaveLength(1);
  expect(() => assertQuiescent(root)).toThrow("closure unknown");
  // Test owner establishes actual descriptor closure. Production uncertainty and evidence stay retained.
  await actual!.close();
  console.log("TABLE_ARCHIVE_UNCERTAIN_RETAINED", root);
});

const retained: unknown[] = [];
for (const protocol of ["architecture", "review"] as const) test(`${protocol} retirement retains an uncertain archive without revoking the delivered judgment or blocking reads`, async () => {
  const root = privateRoot(), env = process.env.PI_CODING_AGENT_DIR;
  const keys = ["pitako.backgroundWorkers", "pitako.teamRegistry", "pitako.agentObservations", "pitako.agentUi", "pitako.executionIdentity"].map(Symbol.for);
  const host = globalThis as Record<symbol, unknown>, previous = keys.map(key => Object.getOwnPropertyDescriptor(host, key));
  for (const key of keys) Reflect.deleteProperty(host, key);
  const f = architectureFixture(protocol), s = await f.setup({ root, config: "", prompt(_session, request, body) {
    return request.stage === "composition" ? { ...body, specialists: [] } : body;
  } });
  const operations: archive.TableArchive[] = [];
  const capture = spyOn(archive, "startTableArchive").mockImplementation((...args) => {
    const operation = startArchive(...args); operations.push(operation); return operation;
  });
  const open = fs.open.bind(fs);
  let actual: Awaited<ReturnType<typeof fs.open>> | undefined, close: ReturnType<typeof spyOn> | undefined;
  const control = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      actual = handle;
      close = spyOn(handle, "close").mockImplementation(async () => { throw new Error("controlled owned close uncertainty"); });
    }
    return handle;
  });
  try {
    const args = { goal: "Preserve delivered judgment on archive uncertainty",
      ...(protocol === "review" ? { object: { kind: "brief", text: "Local" }, criteria: ["stable"] } : {}) };
    const started = await s.invoke(`${protocol}_start`, args);
    await s.delivered.promise;
    await operations[0]!.completion;
    const result = await s.read("team_result", { assignmentId: started.details.assignmentId });
    expect(result.judgment).not.toBeNull();
    expect(await s.read(`${protocol}_read`, { roomId: started.details.roomId, section: "archive" }))
      .toMatchObject({ state: "failed", settlement: "unknown" });
    // Unknown writers still fence effects, not in-memory result/diagnostic reading.
    expect((await s.invoke(`${protocol}_start`, args)).isError).toBe(true);
    expect((await s.invoke(`${protocol}_control`, { roomId: started.details.roomId, action: "stop" })).isError).toBe(true);
    expect(operations).toHaveLength(1);
    expect(await s.read("team_result", { assignmentId: started.details.assignmentId })).toEqual(result);
    const receipt = workerHandoff(started.details.instanceId);
    expect(receipt?.delivery).toBe("incorporated");
    await expect(s.close()).rejects.toThrow("table archive closure unknown");
    expect(workerHandoff(started.details.instanceId)).toEqual(receipt); // row/resources not deleted
    expect(readdirSync(path.join(root, ".pitako/table-results"))).toHaveLength(1);
    expect(() => assertQuiescent(root)).toThrow("closure unknown");
  } finally {
    await Promise.all(operations.map(operation => operation.completion));
    close?.mockRestore();
    await actual?.close(); // Only the test knows this physical descriptor finally closed.
    await Promise.allSettled([cancelAllWorkers(), retireTeamEvaluation(s.evaluation)]);
    clearBackgroundOwner(); setBackgroundExecutor(undefined);
    control.mockRestore(); capture.mockRestore();
    retained.push({ root, s, operations, registries: keys.map(key => host[key]) });
    keys.forEach((key, index) => { if (previous[index]) Object.defineProperty(host, key, previous[index]!); else Reflect.deleteProperty(host, key); });
    if (env === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = env;
    console.log("TABLE_ARCHIVE_OWNER_UNCERTAIN_RETAINED", root);
  }
});
