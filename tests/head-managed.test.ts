import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createWriteToolDefinition, SessionManager, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { OwnedGates } from "../extensions/agent/head/gates.ts";
import { reserveOperation } from "../extensions/agent/head/operation-leases.ts";
import { AgentClosureError } from "../extensions/agent/closure.ts";
import { AdmissionInventory, localGitEnv } from "../extensions/agent/head/inventory.ts";
import { ManagedAssignment, ManagedProducer, foregroundBash, managedGuard, managedTools } from "../extensions/agent/head/managed-tools.ts";

function hasUnknownClosure(error: unknown): boolean {
  return error instanceof AgentClosureError || error instanceof AggregateError && error.errors.some(hasUnknownClosure);
}
async function temporaryRoot(body: (root: string) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-managed-"));
  let remove = true;
  try { await body(root); }
  catch (error) {
    if (hasUnknownClosure(error)) {
      remove = false;
      throw new AgentClosureError([error], `Managed fixture retained at ${root}`);
    }
    throw error;
  } finally { if (remove) rmSync(root, { recursive: true, force: true }); }
}
async function repository(body: (root: string, git: (args: string[], input?: string | Buffer, extra?: NodeJS.ProcessEnv) => Buffer) => Promise<void>) {
  await temporaryRoot(async root => {
    const git = (args: string[], input?: string | Buffer, extra?: NodeJS.ProcessEnv) => execFileSync("git", args, {
      cwd: root, env: { ...localGitEnv(), ...extra }, input, stdio: ["pipe", "pipe", "pipe"],
    });
    git(["init", "--quiet"]);
    git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@invalid"]);
    for (const name of ["clean", "staged", "dirty", "flagged", "mode"]) writeFileSync(path.join(root, name), "base\n");
    writeFileSync(path.join(root, ".gitignore"), "ignored/\n*.opaque\n");
    git(["add", "."]); git(["commit", "--quiet", "-m", "admission"]);
    await body(root, git);
  });
}
async function awaitEntered(entered: Promise<void>, operation: Promise<unknown>): Promise<void> {
  await Promise.race([entered, operation.then(() => { throw new Error("operation completed before readiness"); })]);
}
function rejectsWith(operation: Promise<unknown>, message: string): Promise<void> {
  // Unlike a .rejects matcher, a normal Promise handler cannot suspend the caller.
  return operation.then(() => { throw new Error(`Expected operation to reject: ${message}`); }, error => {
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(message);
  });
}
async function withOperations(body: (own: <T>(operation: Promise<T>, source?: Promise<unknown>) => Promise<T>) => Promise<void>,
  release: () => void, assignment?: ManagedAssignment) {
  const operations: Promise<unknown>[] = [], errors: unknown[] = [];
  const own = <T>(operation: Promise<T>, source: Promise<unknown> = operation): Promise<T> => {
    operations.push(operation);
    void operation.catch(() => {}); // Join below reports failures, including derived assertions.
    const sourceObserved = source.catch(error => { if (hasUnknownClosure(error)) errors.push(error); });
    operations.push(sourceObserved);
    return operation;
  };
  try { await body(own); }
  catch (error) { errors.push(error); }
  finally {
    try { release(); } catch (error) { errors.push(error); }
    for (const outcome of await Promise.allSettled(operations)) {
      if (outcome.status === "rejected") errors.push(outcome.reason);
    }
    try { assignment?.assertIdle(); }
    catch (error) { errors.push(new AgentClosureError([error], "managed fixture release")); }
  }
  const failures = [...new Set(errors)];
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Managed fixture failed");
}
function producer(assignment: ManagedAssignment, options: { writes?: string[]; revision?: () => number;
  effects?: () => void; signal?: AbortSignal; instance?: string } = {}) {
  return new ManagedProducer(assignment, { writes: options.writes ?? [assignment.root], check: options.revision ?? (() => 0),
    effects: options.effects ?? (() => {}),
    source: () => ({ kind: "head", instanceId: options.instance ?? "instance", groupId: "group", historyId: "history", sessionId: "native" }),
  }, options.signal ?? new AbortController().signal);
}
const context = (cwd: string) => ({ cwd }) as ExtensionToolContext;
const result = { content: [{ type: "text" as const, text: "native result" }], details: undefined };

test("readiness observes early rejection and completion, and permits a live entered operation", async () => {
  const entered = Promise.withResolvers<void>(), operation = Promise.withResolvers<void>();
  const failure = new Error("before entry");
  await expect(awaitEntered(entered.promise, Promise.reject(failure))).rejects.toBe(failure);
  await expect(awaitEntered(entered.promise, Promise.resolve())).rejects.toThrow("completed before readiness");
  entered.resolve();
  await awaitEntered(entered.promise, operation.promise);
  operation.resolve();
  await operation.promise;
});

test("a synchronous second start failure still releases callbacks, joins accepted work and preserves errors", async () => {
  let directory = "", callbackSettled = false;
  const callbackFailure = new Error("deferred callback failed"), releaseFailure = new Error("release failed");
  let failure: unknown;
  try {
    await repository(async root => {
      directory = root;
      const assignment = new ManagedAssignment(root, [root]), managed = producer(assignment);
      const entered = Promise.withResolvers<void>(), callback = Promise.withResolvers<void>();
      const wrapped = managed.wrap({ name: "write", label: "write", description: "controlled callback", parameters: Type.Object({ path: Type.String() }),
        async execute(_id, _params, _signal, onUpdate) { onUpdate?.(result); entered.resolve(); return result; } });
      await withOperations(async own => {
        const first = own(wrapped.execute("first", { path: "clean" }, undefined, () => callback.promise.then(() => {
          expect(readFileSync(path.join(root, "clean"), "utf8")).toBe("base\n");
          callbackSettled = true;
          throw callbackFailure;
        }), context(root)));
        await awaitEntered(entered.promise, first);
        own(wrapped.execute("second", { path: "clean" }, undefined, undefined, context(root)));
      }, () => { callback.resolve(); throw releaseFailure; }, assignment);
    });
  } catch (error) { failure = error; }
  expect(callbackSettled).toBe(true);
  expect(existsSync(directory)).toBe(false);
  expect(failure).toBeInstanceOf(AggregateError);
  const errors = (failure as AggregateError).errors;
  expect(errors[0].message).toContain("slot is occupied");
  expect(errors[1]).toBe(releaseFailure);
  expect(errors[2]).toBeInstanceOf(AggregateError);
  expect(errors[2].errors).toContain(callbackFailure);
});

test("unknown closure retains the fixture root and reports its path even beside a primary failure", async () => {
  let directory = "";
  const primary = new Error("primary failure"), closure = new AgentClosureError([new Error("synthetic uncertainty")], "fixture");
  try {
    const run = temporaryRoot(async root => {
      directory = root;
      await withOperations(async own => { own(Promise.reject(closure)); throw primary; }, () => {});
    });
    await expect(run).rejects.toBeInstanceOf(AgentClosureError);
    await expect(run).rejects.toThrow(`retained at ${directory}`);
    expect(existsSync(directory)).toBe(true);
    const error = await run.catch(error => error);
    expect(error.errors[0].errors).toEqual(expect.arrayContaining([primary, closure]));
  } finally {
    // This synthetic closure owns no resources; only the retention decision is under test.
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

test("immutable eligibility separates staged, working, untracked, ignored and flagged admission preimages", () => repository(async (root, git) => {
  writeFileSync(path.join(root, "staged"), "staged\n"); git(["add", "staged"]);
  writeFileSync(path.join(root, "dirty"), "dirty\n");
  writeFileSync(path.join(root, "untracked"), "foreign\n");
  git(["update-index", "--skip-worktree", "flagged"]);
  symlinkSync("clean", path.join(root, "link")); git(["add", "link"]);
  mkdirSync(path.join(root, "ignored")); writeFileSync(path.join(root, "ignored", "old"), "opaque");
  const inventory = new AdmissionInventory(root, [root]);
  expect(inventory.snapshot().unavailable).toBeUndefined();
  for (const name of ["staged", "dirty", "untracked", "flagged", "link", "ignored/new", "absent.opaque"]) {
    expect(inventory.eligibility(name).eligible).toBe(false);
  }
  expect(inventory.eligibility("clean").eligible).toBe(true);
  expect(inventory.eligibility("absent").eligible).toBe(true);
  const before = inventory.observe();
  writeFileSync(path.join(root, "dirty"), "now managed\n"); chmodSync(path.join(root, "mode"), 0o755);
  inventory.contributed(before, { kind: "head", instanceId: "i", groupId: "g", historyId: "h", sessionId: "s",
    effectiveRevision: 0, toolCallId: "write", toolName: "write" }, "returned", [root]);
  expect(inventory.eligibility("dirty").eligible).toBe(false);
  expect(inventory.snapshot().contributions[0].changes.map(change => change.path)).toEqual(expect.arrayContaining(["dirty", "mode"]));
  const snapshot = inventory.snapshot(); snapshot.admission!.paths.length = 0;
  expect(inventory.eligibility("dirty").eligible).toBe(false);
  writeFileSync(path.join(root, "clean"), "external\n"); inventory.observe();
  expect(inventory.snapshot().gaps).toContain("unattributed change: clean");
  git(["add", "dirty"]); inventory.observe();
  expect(inventory.snapshot().gaps).toContain("repository, HEAD, real index, configuration or policy drift");
  writeFileSync(path.join(root, ".gitignore"), "");
  expect(inventory.eligibility("ignored/new").eligible).toBe(false);
  expect(inventory.eligibility("absent.opaque").eligible).toBe(false);
}));

test("admission uses Git text/EOL semantics without executing an external filter", () => repository(async (root, git) => {
  writeFileSync(path.join(root, ".gitattributes"), "clean text eol=crlf\n");
  git(["add", ".gitattributes"]); git(["commit", "--quiet", "-m", "EOL policy"]);
  writeFileSync(path.join(root, "clean"), "base\r\n");
  expect(new AdmissionInventory(root, [root]).eligibility("clean").eligible).toBe(true);
  writeFileSync(path.join(root, ".gitattributes"), "clean filter=external\n");
  git(["config", "filter.external.clean", "touch FILTER_EXECUTED; cat"]);
  const filtered = new AdmissionInventory(root, [root]);
  expect(filtered.eligibility("clean").eligible).toBe(false);
  expect(filtered.snapshot().admission!.paths.some(entry => entry.path === "FILTER_EXECUTED")).toBe(false);
  expect(() => readFileSync(path.join(root, "FILTER_EXECUTED"))).toThrow();
}));

test("incomplete, sparse and missing repository inventories do not invent clean preimages", () => repository(async (root, git) => {
  git(["config", "core.sparseCheckout", "true"]);
  const unsupported = new AdmissionInventory(root, [root]);
  expect(unsupported.snapshot().unavailable).toContain("sparse");
  expect(unsupported.eligibility("absent").eligible).toBe(false);
  const outside = mkdtempSync(path.join(tmpdir(), "pitako-no-git-"));
  try { expect(new AdmissionInventory(outside, [outside]).eligibility("new").eligible).toBe(false); }
  finally { rmSync(outside, { recursive: true }); }
}));

test("native reservation precedes suspension, revalidates revision, fences effects, owns async callbacks", () => repository(async root => {
  const assignment = new ManagedAssignment(root, [root]);
  let revision = 0, effects = 0, nativeCalls = 0;
  const managed = producer(assignment, { revision: () => revision, effects: () => { effects++; } });
  const entered = Promise.withResolvers<void>(), callback = Promise.withResolvers<void>();
  const definition: ToolDefinition = { name: "write", label: "Native", description: "native", parameters: Type.Object({ path: Type.String() }),
    async execute(_id, _params, _signal, onUpdate) { nativeCalls++; entered.resolve(); onUpdate?.(result); return result; } };
  const wrapped = managed.wrap(definition);
  await withOperations(async own => {
    const stale = wrapped.execute("stale", { path: "clean" }, undefined, undefined, context(root));
    const staleRejected = own(rejectsWith(stale, "revision changed"), stale);
    expect(() => assignment.assertIdle()).toThrow("still settling");
    revision++;
    await staleRejected;
    expect(nativeCalls).toBe(0); expect(effects).toBe(0);
    const movedContext = context(root);
    const moved = wrapped.execute("moved", { path: "clean" }, undefined, undefined, movedContext);
    const movedRejected = own(rejectsWith(moved, "launch root"), moved);
    movedContext.cwd = tmpdir();
    await movedRejected;
    expect(nativeCalls).toBe(0); expect(effects).toBe(0);
    const pending = own(wrapped.execute("live", { path: "clean" }, undefined, () => callback.promise, context(root)));
    await awaitEntered(entered.promise, pending);
    expect(effects).toBe(1);
    expect(() => wrapped.execute("overlap", { path: "clean" }, undefined, undefined, context(root))).toThrow("slot is occupied");
    expect(() => assignment.assertIdle()).toThrow("still settling");
    let settled = false; own(pending.then(() => { settled = true; }));
    await Promise.resolve(); expect(settled).toBe(false);
  }, () => callback.resolve(), assignment);
  assignment.assertIdle();
  managed.cancel();
  expect(() => wrapped.execute("retired", { path: "clean" }, undefined, undefined, context(root))).toThrow("retired");
}));

test("scope and symlink/move checks refuse before mutation, disjoint native producers overlap", () => repository(async root => {
  mkdirSync(path.join(root, "a")); mkdirSync(path.join(root, "b"));
  symlinkSync(path.join(root, "b"), path.join(root, "a", "escape"));
  const assignment = new ManagedAssignment(root, [root]);
  const a = producer(assignment, { writes: [path.join(root, "a")] }), b = producer(assignment, { writes: [path.join(root, "b")] });
  const write = a.wrap(createWriteToolDefinition(root));
  expect(() => write.execute("escape", { path: "a/escape/new", content: "no" }, undefined, undefined, context(root))).toThrow("write reservation");
  expect(() => write.execute("outside", { path: "../new", content: "no" }, undefined, undefined, context(root))).toThrow("launch root");
  const patch = a.wrap({ name: "apply_patch", label: "Patch", description: "native parser", parameters: Type.Object({ patch: Type.String() }),
    async execute() { throw new Error("must not invoke"); } });
  expect(() => patch.execute("move", { patch: "*** Begin Patch\n*** Update File: a/old\n*** Move to: b/new\n@@\n-x\n+y\n*** End Patch\n" },
    undefined, undefined, context(root))).toThrow("write reservation");
  const enteredA = Promise.withResolvers<void>(), enteredB = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const delayed = (entered: typeof enteredA): ToolDefinition => ({ name: "write", label: "write", description: "controlled suspension",
    parameters: Type.Object({ path: Type.String() }), async execute() { entered.resolve(); await release.promise; return result; } });
  await withOperations(async own => {
    const first = own(a.wrap(delayed(enteredA)).execute("a", { path: "a/new" }, undefined, undefined, context(root)));
    const second = own(b.wrap(delayed(enteredB)).execute("b", { path: "b/new" }, undefined, undefined, context(root)));
    await Promise.all([awaitEntered(enteredA.promise, first), awaitEntered(enteredB.promise, second)]);
    expect(assignment.snapshot().active).toBe(2);
  }, () => release.resolve(), assignment);
  assignment.assertIdle();
}));

test("owned foreground bash waits for stream/cancel settlement and reports timeout without unknown closure", () => temporaryRoot(async root => {
  const abort = new AbortController(), entered = Promise.withResolvers<void>();
  let output = "";
  await withOperations(async own => {
    const command = foregroundBash.exec("printf ready; read -r line < /dev/zero", root, {
      signal: abort.signal, onData(bytes) { output += bytes.toString(); entered.resolve(); },
    });
    const aborted = own(rejectsWith(command, "aborted"), command);
    await awaitEntered(entered.promise, command);
    abort.abort();
    await aborted;
    expect(output).toContain("ready");
    const timeout = foregroundBash.exec("read -r line < /dev/zero", root, { timeout: 0.02, onData() {} });
    await own(rejectsWith(timeout, "timeout:"), timeout);
    const invalid = foregroundBash.exec("true", root, { timeout: Infinity, onData() {} });
    await own(rejectsWith(invalid, "Invalid timeout"), invalid);
    const successful = await own(foregroundBash.exec("printf check", root, { onData(bytes) { output += bytes.toString(); } }));
    expect(successful.exitCode).toBe(0); expect(output).toContain("check");
  }, () => abort.abort());
}));

test("unknown producer closure blocks new work while a known pre-start refusal does not", () => repository(async root => {
  const assignment = new ManagedAssignment(root, [root]), managed = producer(assignment);
  const failed = managed.wrap({ name: "write", label: "write", description: "unknown native closure", parameters: Type.Object({ path: Type.String() }),
    async execute() { throw new AgentClosureError([new Error("unjoined resource")], "native"); } });
  await expect(failed.execute("failed", { path: "clean" }, undefined, undefined, context(root))).rejects.toBeInstanceOf(AgentClosureError);
  expect(() => assignment.assertIdle()).toThrow(AgentClosureError);
  expect(() => producer(assignment).wrap(createWriteToolDefinition(root)).execute("new", { path: "clean", content: "no" }, undefined, undefined, context(root)))
    .toThrow(AgentClosureError);
}));

test("loaded known patch keeps native schema, grammar, rendering and output; replacements are unsupported", () => repository(async root => {
  const entry = new URL("../extensions/index.ts", import.meta.resolve("pi-codex-tools"));
  const definitions: ToolDefinition[] = [];
  const extension = (await import(entry.href)).default;
  const offline = process.env.PI_OFFLINE;
  try {
    process.env.PI_OFFLINE = "1";
    await extension({ registerTool(definition: ToolDefinition) { definitions.push(definition); }, on() {} });
  } finally {
    if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline;
  }
  const patch = definitions.find(definition => definition.name === "apply_patch")!;
  const managed = producer(new ManagedAssignment(root, [root]));
  const loader = (resolvedPath: string) => ({ getExtensions: () => ({ extensions: [{
    resolvedPath, tools: new Map([["apply_patch", { definition: patch }]]),
  }] }) }) as any;
  const tools = managedTools(loader(entry.pathname), managed);
  const wrapped = tools.find(definition => definition.name === "apply_patch")!;
  expect(wrapped.parameters).toBe(patch.parameters); expect(wrapped.renderCall).toBe(patch.renderCall);
  expect(wrapped.renderResult).toBe(patch.renderResult); expect(wrapped).toMatchObject({ promptSnippet: patch.promptSnippet });
  expect((wrapped as any).constrainedSampling).toBe((patch as any).constrainedSampling);
  const applied = await wrapped.execute("patch", { patch: "*** Begin Patch\n*** Add File: patched\n+native\n*** End Patch\n" }, undefined, undefined, {
    ...context(root), model: { api: "openai-responses", compat: { supportsOpenAIGrammarTools: true } } as any,
  });
  expect(applied.details).toEqual({ changes: [{ kind: "added", path: "patched" }] });
  expect(readFileSync(path.join(root, "patched"), "utf8")).toBe("native\n");
  expect(managedTools(loader(import.meta.filename), managed).some(definition => definition.name === "apply_patch")).toBe(false);
  let guard!: Function;
  await managedGuard(new Set(tools.map(definition => definition.name)))({ on(_name: string, hook: Function) { guard = hook; } } as any);
  for (const name of ["codemode", "mcp_write", "apply_patch_replacement"]) expect(guard({ toolName: name }).block).toBe(true);
  for (const name of ["read", "todo", "head_plan", "bash"]) expect(guard({ toolName: name })).toBeUndefined();
}));

test("native evidence retains actual entry identities, errors, bounded excerpts and missing-result gaps", () => repository(async root => {
  const assignment = new ManagedAssignment(root, [root]), native = SessionManager.inMemory(root);
  const source = { kind: "head" as const, instanceId: "instance", groupId: "group", historyId: "history", sessionId: native.getSessionId() };
  const managed = new ManagedProducer(assignment, { writes: [root], check: () => 0, effects() {}, source: () => source }, new AbortController().signal);
  const result = await managed.wrap(createWriteToolDefinition(root)).execute("write-call", { path: "clean", content: "owned" },
    undefined, undefined, context(root));
  assignment.capture({ ...source, observedRevision: 0 }, native.getBranch());
  expect(assignment.snapshot().native[0]!.gaps).toContain("No captured native result: write/write-call");
  native.appendMessage({ role: "toolResult", toolCallId: "write-call", toolName: "write", ...result, isError: false, timestamp: Date.now() });
  native.appendMessage({ role: "toolResult", toolCallId: "check-call", toolName: "fixture_check",
    content: [{ type: "text", text: "failed ".repeat(500) }], isError: true, timestamp: Date.now() });
  assignment.capture({ ...source, observedRevision: 0 }, native.getBranch());
  const record = assignment.snapshot().native[0]!;
  expect(record.gaps).toEqual([]);
  expect(record.closure).toBe("observed"); // A result is not a closure witness.
  expect(record.entries.at(-1)).toMatchObject({ entryId: native.getLeafId(), toolCallId: "check-call", isError: true, truncated: true });
  expect(record.entries.at(-1)!.excerpt.length).toBe(2048);
}));

test("fixed argv private-index/object/commit/ref/read seam leaves branch and real index untouched", () => repository(async (root, git) => {
  const head = git(["rev-parse", "HEAD"]).toString().trim(), branch = git(["symbolic-ref", "HEAD"]).toString().trim();
  const index = readFileSync(path.join(root, ".git/index"));
  const env = { GIT_INDEX_FILE: path.join(root, ".git", "private-index") };
  git(["read-tree", head], undefined, env);
  const blob = git(["hash-object", "-w", "--stdin"], "private checkpoint\n", env).toString().trim();
  git(["update-index", "--add", "--cacheinfo", "100644", blob, "clean"], undefined, env);
  const tree = git(["write-tree"], undefined, env).toString().trim();
  const commit = git(["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", head], "private seam\n", env).toString().trim();
  git(["update-ref", "refs/pitako-fixture/one", commit, "0".repeat(head.length)], undefined, env);
  expect(git(["rev-parse", "refs/pitako-fixture/one"]).toString().trim()).toBe(commit);
  expect(git(["show", "refs/pitako-fixture/one:clean"]).toString()).toBe("private checkpoint\n");
  expect(git(["rev-parse", "HEAD"]).toString().trim()).toBe(head);
  expect(git(["symbolic-ref", "HEAD"]).toString().trim()).toBe(branch);
  expect(readFileSync(path.join(root, ".git/index"))).toEqual(index);
  expect(readFileSync(path.join(root, "clean"), "utf8")).toBe("base\n");
}));


// Unknown leases deliberately survive for the lifetime of the host. Give these cases
// their own host so they cannot block unrelated, legitimately unscoped operations.
function closureHost(name: string): boolean {
  if (process.env.PITAKO_GATE_CLOSURE_CASE === name) return true;
  const output = execFileSync(process.execPath, ["test", import.meta.path, "--test-name-pattern", `^${name}$`], {
    env: { ...process.env, PITAKO_GATE_CLOSURE_CASE: name, BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
  });
  console.log(output);
  return false;
}

const captureClosureCase = "capture write failure cancels and joins; unprovable group closure retains the gate barrier and diagnostics";
test(captureClosureCase, async () => {
  if (!closureHost(captureClosureCase)) return;
  for (const uncertain of [false, true]) {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-gate-closure-"));
    const changed = Promise.withResolvers<void>(), binding = {}, controller = new AbortController();
    const pending: Promise<unknown>[] = []; let unknown: string | undefined;
    const owner = { assignmentId: "closure-fixture", executionRoot: root, signal: controller.signal,
      check(b: object) { if (b !== binding) throw new Error("foreign binding"); }, admitted() {}, gateIdle() {},
      own<T>(_b: object, operation: () => Promise<T>) { const p = operation(); pending.push(p); return p; },
      gateEpoch: () => ({ epoch: "epoch", revision: 0 }), gateChanged() { changed.resolve(); }, gateUnknown(reason: string) { unknown = reason; } };
    const gates = new OwnedGates(owner, { durationMs: 2000, captureBytes: 1024, invocations: 2, artifactRoots: [], scratchRoots: [] }, undefined,
      { write: uncertain ? writeSync : (() => { throw new Error("ENOSPC controlled capture write failure"); }) as typeof writeSync,
        groupClosed(pid) {
          if (uncertain) return false; // Host observation failure only: never substitutes an exit/output.
          try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
        } });
    const handle = gates.request(binding, { epoch: "epoch", expectedRevision: 0, coverage: "closure failure injection; real local subprocess",
      commands: [{ id: "capture", shell: "printf real-local-output", cwd: ".", env: {}, timeoutMs: 1000 }] });
    await changed.promise; await Promise.all(pending);
    const result = gates.outcomes(binding)[0]!;
    expect(result).toMatchObject({ outcome: uncertain ? "unknown" : "incomplete", closure: uncertain ? "unknown" : "released", complete: false });
    expect(result.commands[0]!.exitCode).not.toBeUndefined();
    if (uncertain) {
      expect(unknown).toContain("closure");
      expect(() => reserveOperation(root, "writer")).toThrow("lease");
      expect(() => gates.request(binding, { epoch: "epoch", expectedRevision: 0, coverage: "no replacement",
        commands: [{ id: "replacement", shell: "printf forbidden", cwd: ".", env: {}, timeoutMs: 100 }] })).toThrow("active");
      expect(gates.status(binding, handle.runId).artifacts).toHaveLength(2);
      console.log(`Intentionally retained uncertain observation diagnostics: ${root}`);
    } else {
      expect(result.diagnostic).toContain("ENOSPC"); const lease = reserveOperation(root, "writer"); lease.release();
      rmSync(root, { recursive: true, force: true });
    }
  }
});


const tailClosureCase = "leader exit cannot release a gate while inherited stdout still has a tail";
test(tailClosureCase, async () => {
  if (!closureHost(tailClosureCase)) return;
  const root = mkdtempSync(path.join(tmpdir(), "pitako-gate-tail-")); mkdirSync(path.join(root, "scratch"));
  const fifo = path.join(root, "scratch/release"); execFileSync("mkfifo", [fifo]); const fd = openSync(fifo, "r+");
  const exited = Promise.withResolvers<void>(), changed = Promise.withResolvers<void>(), binding = {}, controller = new AbortController();
  const pending: Promise<unknown>[] = [];
  const owner = { assignmentId: "tail-fixture", executionRoot: root, signal: controller.signal,
    check(b: object) { if (b !== binding) throw new Error("foreign binding"); }, admitted() {}, gateIdle() {},
    own<T>(_b: object, operation: () => Promise<T>) { const p = operation(); pending.push(p); return p; },
    gateEpoch: () => ({ epoch: "epoch", revision: 0 }), gateChanged() { changed.resolve(); }, gateUnknown() {} };
  const gates = new OwnedGates(owner, { durationMs: 3000, captureBytes: 1024, invocations: 1, artifactRoots: [], scratchRoots: ["scratch"] }, undefined,
    { write: writeSync, leaderExit() { exited.resolve(); }, groupClosed(pid) {
      try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    } });
  let retained = true;
  try {
    const handle = gates.request(binding, { epoch: "epoch", expectedRevision: 0, coverage: "leader/tail closure",
      commands: [{ id: "tail", shell: "printf leader; (read -r release < scratch/release; printf tail) & exit 0", cwd: ".", env: {}, timeoutMs: 1500 }] });
    await exited.promise;
    expect(gates.status(binding, handle.runId)).toMatchObject({ available: false, closure: "pending" });
    expect(() => reserveOperation(root, "writer")).toThrow("lease");
    writeSync(fd, "release\n"); await changed.promise; await Promise.all(pending);
    expect(gates.read(binding, handle.runId, "0-stdout").text).toBe("leadertail");
    const outcome = gates.outcomes(binding)[0]!; retained = outcome.closure === "unknown";
    if (outcome.outcome === "incomplete") {
      expect(outcome.closure).toBe("released");
      expect(outcome.diagnostic).toContain("leader closed before owned group closure");
    } else expect(["passed", "unknown"]).toContain(outcome.outcome);
    if (retained) console.log(`Intentionally retained unprovable orphan-group diagnostics: ${root}`);
  } finally {
    controller.abort(); await Promise.allSettled(pending); closeSync(fd);
    if (!retained) rmSync(root, { recursive: true, force: true });
  }
});


test("cancellation after captured process output retains the lease through TERM/KILL and stream closure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-gate-cancel-"));
  mkdirSync(path.join(root, "scratch")); execFileSync("mkfifo", [path.join(root, "scratch/release")]);
  const entered = Promise.withResolvers<void>(), binding = {}, controller = new AbortController();
  const pending: Promise<unknown>[] = [];
  const owner = { assignmentId: "cancel-fixture", executionRoot: root, signal: controller.signal,
    check(b: object) { if (b !== binding) throw new Error("foreign binding"); }, admitted() {}, gateIdle() {},
    own<T>(_b: object, operation: () => Promise<T>) { const p = operation(); pending.push(p); return p; },
    gateEpoch: () => ({ epoch: "epoch", revision: 0 }), gateChanged() {}, gateUnknown() {} };
  const gates = new OwnedGates(owner, { durationMs: 3000, captureBytes: 1024, invocations: 1, artifactRoots: [], scratchRoots: ["scratch"] }, undefined,
    { write: ((fd: number, data: Uint8Array) => { const count = writeSync(fd, data); entered.resolve(); return count; }) as typeof writeSync,
      groupClosed(pid) { try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } } });
  let released = false;
  try {
    const handle = gates.request(binding, { epoch: "epoch", expectedRevision: 0, coverage: "cancel a real started process ignoring TERM",
      commands: [{ id: "cancel", shell: "trap '' TERM; printf started; read -r release < scratch/release", cwd: ".", env: {}, timeoutMs: 2000 }] });
    await entered.promise;
    gates.cancel(binding, handle.runId);
    expect(gates.status(binding, handle.runId).closure).toBe("pending");
    expect(() => reserveOperation(root, "writer")).toThrow("lease");
    await Promise.all(pending);
    const outcome = gates.outcomes(binding)[0]!; released = outcome.closure === "released";
    expect(outcome).toMatchObject({ outcome: "cancelled", closure: "released", complete: false, commands: [{ signal: "SIGKILL" }] });
    expect(gates.read(binding, handle.runId, "0-stdout").text).toBe("started");
    const writer = reserveOperation(root, "writer"); writer.release();
  } finally {
    controller.abort(); await Promise.allSettled(pending);
    if (released) rmSync(root, { recursive: true, force: true });
    else console.log(`Intentionally retained cancellation diagnostics: ${root}`);
  }
});
