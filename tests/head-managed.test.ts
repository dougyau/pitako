import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, openSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { createBashToolDefinition, createWriteToolDefinition, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { OwnedGates } from "../extensions/agent/head/gates.ts";
import { reserveOperation } from "../extensions/agent/head/operation-leases.ts";
import { AgentClosureError } from "../extensions/agent/closure.ts";
import { AdmissionInventory, localGitEnv } from "../extensions/agent/head/inventory.ts";
import { ManagedAssignment, ManagedProducer, foregroundBash, managedGuard, managedTools } from "../extensions/agent/head/managed-tools.ts";
import { ownProcess } from "../extensions/agent/head/owned-process.ts";

function controlledProcess() {
  const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdout: new EventEmitter(), stderr: new EventEmitter() });
  let now = 0, group: "visible" | "ESRCH" | "EPERM" = "visible", probes = 0;
  const signals: Array<{ signal: NodeJS.Signals; at: number }> = [];
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
  const host = {
    kill(_pid: number, signal: NodeJS.Signals | 0) {
      if (signal === 0) {
        probes++;
        if (group !== "visible") throw Object.assign(new Error(group), { code: group });
      } else signals.push({ signal, at: now });
      return true;
    },
    schedule(callback: () => void, ms: number) {
      const timer = {} as ReturnType<typeof setTimeout>;
      timers.set(timer, { at: now + ms, callback }); return timer;
    },
    clear(timer: ReturnType<typeof setTimeout>) { timers.delete(timer); },
  };
  return { child: child as unknown as ChildProcess, stdout: child.stdout, stderr: child.stderr, host, signals,
    get pending() { return timers.size; }, get probes() { return probes; },
    get scheduled() { return [...timers.values()].map(timer => timer.callback); },
    group(value: typeof group) { group = value; },
    close(code = 0, signal: NodeJS.Signals | null = null) {
      child.exitCode = code; child.signalCode = signal;
      child.stdout.emit("close"); child.stderr.emit("close"); child.emit("close", code, signal);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = target;
    },
  };
}

function controlledGate(root: string, options: {
  write?: typeof writeSync; close?: typeof closeSync; captureBytes?: number;
} = {}) {
  const process = controlledProcess(), binding = {}, entered = Promise.withResolvers<void>();
  let operation: Promise<unknown> | undefined, starts = 0, exits = 0;
  const gates = new OwnedGates({ assignmentId: "controlled-gates", executionRoot: root, signal: new AbortController().signal,
    check() {}, admitted() {}, gateIdle() {}, gateUnknown() {}, gateChanged() {},
    gateEpoch: () => ({ epoch: "epoch", revision: 0 }),
    own<T>(_binding: object, run: () => Promise<T>) { const pending = run(); operation = pending; return pending; },
  }, { durationMs: 60000, captureBytes: options.captureBytes ?? 65536, invocations: 1,
    artifactRoots: [], scratchRoots: [] }, undefined, {
    write: options.write ?? writeSync, close: options.close, groupClosed: () => false, processHost: process.host,
    spawn: (() => { starts++; entered.resolve(); return process.child; }) as typeof import("node:child_process").spawn,
    leaderExit() { exits++; },
  });
  return { process, gates, binding, entered: entered.promise, get starts() { return starts; }, get exits() { return exits; },
    request(timeoutMs = 1000, commands = ["first", "later"]) { return gates.request(binding, { epoch: "epoch", expectedRevision: 0, coverage: "controlled ownership",
      commands: commands.map(id => ({ id, shell: id, cwd: ".", env: {}, timeoutMs })) }); },
    async result() { await operation; return gates.outcomes(binding)[0]!; },
    async settle() { process.group("ESRCH"); process.close(); process.advance(5000); await operation; },
  };
}

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

test("process owner reobserves transient groups at 25 ms without intervention or false unknown", async () => {
  const owned = controlledProcess();
  const operation = ownProcess(owned.child, { onData() {} }, owned.host);
  owned.close();
  expect(owned.pending).toBe(1);
  owned.advance(24);
  expect(owned.signals).toEqual([]);
  owned.group("ESRCH"); owned.advance(1);
  expect(await operation).toEqual({ exitCode: 0 });
  expect(owned.signals).toEqual([]);
  expect(owned.pending).toBe(0);
});

test("process cancellation sends TERM once and KILL at 250 ms, holding original streams and close", async () => {
  const owned = controlledProcess(), abort = new AbortController();
  const operation = ownProcess(owned.child, { signal: abort.signal, onData() {}, timeoutMs: 100 }, owned.host);
  const caught = operation.catch(error => error);
  owned.child.emit("exit", 0, null);
  abort.abort(); owned.stderr.emit("error", new Error("stream failed"));
  expect(owned.signals).toEqual([{ signal: "SIGTERM", at: 0 }]);
  owned.advance(249);
  expect(owned.signals).toHaveLength(1);
  owned.advance(1);
  expect(owned.signals).toEqual([{ signal: "SIGTERM", at: 0 }, { signal: "SIGKILL", at: 250 }]);
  owned.group("ESRCH");
  let finished = false;
  void caught.then(() => { finished = true; });
  owned.advance(25); await Promise.resolve();
  expect(finished).toBe(false); // Leader/group absence alone does not prove owned handles.
  owned.stdout.emit("close"); owned.stderr.emit("close");
  owned.advance(25); await Promise.resolve();
  expect(finished).toBe(false);
  owned.child.emit("close", null, "SIGKILL");
  expect(await caught).toEqual(new Error("stream failed"));
  expect(owned.pending).toBe(0);
});

test("persistent normal-close group intervenes, never silently succeeds, and retains its KILL timer", async () => {
  const owned = controlledProcess();
  const operation = ownProcess(owned.child, { onData() {} }, owned.host).catch(error => error);
  owned.close(); owned.advance(25);
  expect(owned.signals).toEqual([{ signal: "SIGTERM", at: 25 }]);
  owned.advance(249); expect(owned.signals).toHaveLength(1);
  owned.advance(1);
  expect(owned.signals[1]).toEqual({ signal: "SIGKILL", at: 275 });
  owned.group("ESRCH"); owned.advance(25);
  const error = await operation;
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(AgentClosureError);
  expect(error.message).toContain("remained after close");
  expect(owned.pending).toBe(0);
});

test("unknown owner stops callbacks, polling and signals; late proof needs ESRCH, streams, original close and callbacks", async () => {
  const owned = controlledProcess(), abort = new AbortController(), callback = Promise.withResolvers<void>();
  let calls = 0, callbackClosed = false;
  const operation = ownProcess(owned.child, { signal: abort.signal, onData() { calls++; return callback.promise; } }, owned.host)
    .catch(error => error);
  owned.stdout.emit("data", Buffer.from("accepted"));
  abort.abort();
  const stale = owned.scheduled;
  owned.advance(1499);
  expect(owned.pending).toBeGreaterThan(0);
  owned.advance(1);
  const error = await operation as AgentClosureError;
  expect(error).toBeInstanceOf(AgentClosureError);
  expect(owned.pending).toBe(0);
  const probes = owned.probes, signals = [...owned.signals];
  for (const callback of stale) callback(); // Even a callback already queued at the deadline is inert.
  owned.stdout.emit("data", Buffer.from("discarded"));
  owned.stderr.emit("error", new Error("late stream error"));
  owned.child.emit("error", new Error("late process error"));
  owned.child.emit("exit", 0, null);
  owned.advance(5000);
  expect(calls).toBe(1);
  expect(owned.probes).toBe(probes);
  expect(owned.signals).toEqual(signals);
  expect(error.observation!.observe()).toBe("unknown");
  owned.group("ESRCH"); owned.child.emit("close", 0, null);
  expect(error.observation!.observe()).toBe("unknown");
  owned.stdout.emit("close"); owned.stderr.emit("close");
  expect(error.observation!.observe()).toBe("unknown");
  callback.reject(new AgentClosureError([], "late callback obligation", { observe: () => callbackClosed ? "closed" : "unknown" }));
  await callback.promise.catch(() => {});
  expect(error.observation!.observe()).toBe("unknown");
  callbackClosed = true;
  owned.group("EPERM");
  expect(error.observation!.observe()).toBe("unknown");
  owned.group("visible");
  expect(error.observation!.observe()).toBe("unknown");
  owned.group("ESRCH");
  expect(error.observation!.observe()).toBe("closed");
  expect(owned.pending).toBe(0);
});

test("gates share transient group observation without intervention", () => temporaryRoot(async root => {
  const h = controlledGate(root);
  const handle = h.request(1000, ["first"]);
  try {
    await h.entered;
    h.process.stdout.emit("data", Buffer.from("out")); h.process.stderr.emit("data", Buffer.from("err"));
    h.process.close(); h.process.advance(24);
    expect(h.starts).toBe(1);
    expect(h.gates.status(h.binding, handle.runId).available).toBe(false);
    expect(h.process.signals).toEqual([]);
    h.process.group("ESRCH"); h.process.advance(1);
    const envelope = await h.result();
    expect(envelope.outcome).toBe("passed"); expect(envelope.closure).toBe("released");
    expect(envelope.commands.map(command => command.state)).toEqual(["passed"]);
    expect(envelope.artifacts.slice(0, 2).map(artifact => artifact.tail)).toEqual(["out", "err"]);
    expect(h.starts).toBe(1);
    expect(h.process.signals).toEqual([]); expect(h.process.pending).toBe(0);
    reserveOperation(root, "writer").release();
  } finally { await h.settle(); }
}));

test("gate normal-close intervention cannot silently pass or execute the next command", () => temporaryRoot(async root => {
  const h = controlledGate(root);
  h.request();
  try {
    await h.entered; h.process.close();
    h.process.advance(25);
    expect(h.process.signals).toEqual([{ signal: "SIGTERM", at: 25 }]);
    h.process.advance(250);
    expect(h.process.signals[1]).toEqual({ signal: "SIGKILL", at: 275 });
    h.process.group("ESRCH"); h.process.advance(25);
    const envelope = await h.result();
    expect(envelope).toMatchObject({ outcome: "incomplete", closure: "released", complete: false });
    expect(envelope.diagnostic).toContain("owned process group remained after close");
    expect(envelope.commands.map(command => command.state)).toEqual(["incomplete", "unrun"]);
    expect(h.starts).toBe(1); expect(h.process.pending).toBe(0);
    expect(() => h.request()).toThrow("grant exhausted");
    reserveOperation(root, "writer").release();
  } finally { await h.settle(); }
}));

for (const deadline of [false, true]) test(`gates ${deadline ? "deadline" : "capture cap"} cancellation joins process proof and stops later commands without renewing grant`, () => temporaryRoot(async root => {
  const h = controlledGate(root, { captureBytes: 4 });
  const handle = h.request(100);
  try {
    await h.entered;
    if (deadline) h.process.advance(100);
    else h.process.stdout.emit("data", Buffer.from("too much output"));
    const start = deadline ? 100 : 0;
    expect(h.process.signals).toEqual([{ signal: "SIGTERM", at: start }]);
    h.gates.cancel(h.binding, handle.runId);
    h.process.advance(249); expect(h.process.signals).toHaveLength(1);
    h.process.advance(1); expect(h.process.signals[1]).toEqual({ signal: "SIGKILL", at: start + 250 });
    h.process.group("ESRCH");
    h.process.child.emit("exit", null, "SIGKILL");
    h.process.advance(25); await Promise.resolve();
    expect(h.gates.status(h.binding, handle.runId).available).toBe(false);
    h.process.close(137, "SIGKILL");
    const envelope = await h.result();
    expect(envelope.outcome).toBe(deadline ? "timed-out" : "incomplete");
    expect(envelope.closure).toBe("released");
    expect(envelope.commands.map(command => command.state)).toEqual([envelope.outcome, "unrun"]);
    expect(envelope.bytes).toBe(deadline ? 0 : 4);
    expect(h.starts).toBe(1); expect(h.process.pending).toBe(0);
    reserveOperation(root, "checkpoint").release();
    expect(() => h.request()).toThrow("grant exhausted");
  } finally { await h.settle(); }
}));

test("unknown gate envelope and capture bytes stay immutable while original close alone recovers exclusion", () => temporaryRoot(async root => {
  let writes = 0, closes = 0;
  const h = controlledGate(root, {
    write: ((...args: Parameters<typeof writeSync>) => { writes++; return writeSync(...args); }) as typeof writeSync,
    close(fd) { closes++; closeSync(fd); },
  });
  const handle = h.request(100);
  try {
    await h.entered;
    h.process.stdout.emit("data", Buffer.from("published")); h.process.stderr.emit("data", Buffer.from("diagnostic"));
    h.process.advance(1600);
    const envelope = await h.result(), before = JSON.stringify(envelope);
    const reads = envelope.artifacts.map(a => h.gates.read(h.binding, handle.runId, a.id));
    expect(envelope.outcome).toBe("unknown"); expect(envelope.closure).toBe("unknown");
    expect(envelope.commands.map(command => command.state)).toEqual(["unknown", "unrun"]);
    expect(h.starts).toBe(1); expect(writes).toBe(2); expect(closes).toBe(2); expect(h.process.pending).toBe(0);
    const probes = h.process.probes, signals = [...h.process.signals];
    h.process.stdout.emit("data", Buffer.from("late")); h.process.stderr.emit("data", Buffer.from("late"));
    h.process.child.emit("exit", 0, null); h.process.advance(5000);
    expect(h.exits).toBe(0); expect(writes).toBe(2);
    expect(h.process.probes).toBe(probes); expect(h.process.signals).toEqual(signals);
    expect(() => reserveOperation(root, "writer")).toThrow();
    h.process.group("ESRCH"); h.process.stdout.emit("close"); h.process.stderr.emit("close");
    expect(() => reserveOperation(root, "checkpoint")).toThrow(); // Needs original child close too.
    h.process.child.emit("close", 0, null);
    h.process.group("EPERM"); expect(() => reserveOperation(root, "writer")).toThrow();
    h.process.group("ESRCH"); reserveOperation(root, "writer").release();
    expect(JSON.stringify((await h.result()))).toBe(before);
    expect(envelope.artifacts.map(a => h.gates.read(h.binding, handle.runId, a.id))).toEqual(reads);
    expect(closes).toBe(2); expect(writes).toBe(2); expect(h.process.pending).toBe(0);
  } finally { await h.settle(); reserveOperation(root, "checkpoint").release(); }
}));

const descriptorCase = "uncertain gate capture close is never retried or recovered by process proof";
test(descriptorCase, async () => {
  if (!process.env.PITAKO_CAPTURE_CLOSE_HOST) {
    console.log(execFileSync(process.execPath, ["test", import.meta.path, "--test-name-pattern", `^${descriptorCase}$`], {
      env: { ...process.env, PITAKO_CAPTURE_CLOSE_HOST: "1", BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" },
      encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
    }));
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), "pitako-gate-descriptor-"));
  let closes = 0;
  const h = controlledGate(root, { close(fd) {
    closeSync(fd); // Close only this fixture's owned descriptor before reporting uncertain close.
    if (++closes === 1) throw new Error("local close observation lost");
  } });
  const handle = h.request();
  try {
    await h.entered; h.process.group("ESRCH"); h.process.close();
    const envelope = await h.result(), before = JSON.stringify(envelope);
    expect(envelope.outcome).toBe("unknown");
    expect(envelope.diagnostic).toContain("Capture descriptor closure unknown");
    expect(envelope.commands.map(command => command.state)).toEqual(["passed", "unrun"]);
    expect(h.starts).toBe(1); expect(closes).toBe(2);
    expect(() => reserveOperation(root, "writer")).toThrow();
    h.process.close(); h.process.advance(5000);
    expect(() => reserveOperation(root, "checkpoint")).toThrow();
    expect(JSON.stringify(h.gates.outcomes(h.binding)[0])).toBe(before);
    expect(h.gates.status(h.binding, handle.runId).closure).toBe("unknown");
    expect(closes).toBe(2); expect(h.process.pending).toBe(0);
  } finally {
    await h.settle();
    console.log("GATE_DESCRIPTOR_UNKNOWN_RETAINED", root);
  }
});

const finalizationCase = "managed Bash preserves executor uncertainty when native output finalization replaces it";
test(finalizationCase, async () => {
  if (!process.env.PITAKO_MANAGED_FINALIZATION_HOST) {
    console.log(execFileSync(process.execPath, ["test", import.meta.path, "--test-name-pattern", `^${finalizationCase}$`], {
      env: { ...process.env, PITAKO_MANAGED_FINALIZATION_HOST: "1", BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" },
      timeout: 20000, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
    }));
    return;
  }
  // Private host: native output responses are controlled; unsupported synthetic obligations
  // never escape into the suite's lease registry. No native process or output file is created.
  const { OutputAccumulator } = await import(new URL("./core/tools/output-accumulator.js",
    import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  for (const mode of ["physical", "callback", "missing", "mixed", "ordinary"]) await repository(async root => {
    const assignment = new ManagedAssignment(root, [root]), managed = producer(assignment), owned = controlledProcess();
    const abort = new AbortController(), entered = Promise.withResolvers<void>();
    const finalizing = Promise.withResolvers<void>(), finalize = Promise.withResolvers<void>(), callback = Promise.withResolvers<void>();
    const finalizationError = new Error("controlled native output finalization failed");
    const ordinaryError = new Error("settled executor failed");
    const missing = new AgentClosureError([], "executor obligation without proof");
    let original: unknown, physical: AgentClosureError | undefined, callbackClosed = false;
    const callbackError = mode === "callback"
      ? new AgentClosureError([], "independent callback obligation", { observe: () => callbackClosed ? "closed" : "unknown" })
      : new Error("settled callback failed");
    const output = spyOn(OutputAccumulator.prototype, "closeTempFile").mockImplementation(async () => {
      finalizing.resolve(); await finalize.promise; throw finalizationError;
    });
    const executor = spyOn(foregroundBash, "exec").mockImplementation(async (_command, _cwd, options) => {
      entered.resolve();
      try { await ownProcess(owned.child, options, owned.host); }
      catch (error) {
        physical = error as AgentClosureError;
        original = mode === "missing" ? missing : mode === "mixed"
          ? new AggregateError([error, missing], "mixed executor obligations") : error;
        throw original;
      }
      original = ordinaryError; throw original;
    });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory() });
    const bash = managedTools(loader, managed).find(tool => tool.name === "bash")!;
    const operation = bash.execute("finalization", { command: "controlled" }, abort.signal, () => callback.promise,
      { ...context(root), sessionManager: SessionManager.inMemory(root) }).catch(error => error);
    try {
      await awaitEntered(entered.promise, operation);
      if (mode === "ordinary") { owned.group("ESRCH"); owned.close(); }
      else { abort.abort(); owned.advance(1500); }
      await awaitEntered(finalizing.promise, operation);
      if (mode !== "ordinary") {
        expect(physical).toBeInstanceOf(AgentClosureError);
        expect(physical!.observation!.observe()).toBe("unknown");
        expect(() => reserveOperation(root, "writer")).toThrow("unknown");
        owned.group("ESRCH"); owned.stdout.emit("close"); owned.stderr.emit("close");
        expect(() => reserveOperation(root, "writer")).toThrow("unknown");
        owned.child.emit("close", 0, null);
        expect(physical!.observation!.observe()).toBe("closed");
        expect(() => reserveOperation(root, "writer")).toThrow("unknown"); // Native finalization still owned.
      }
      finalize.resolve();
      expect(() => reserveOperation(root, "checkpoint")).toThrow(); // Accepted callback still owned.
      if (mode !== "ordinary") expect(() => reserveOperation(root, "writer")).toThrow("unknown");
      callback.reject(callbackError);
      const error = await operation;
      expect(error).toBeInstanceOf(mode === "ordinary" ? AggregateError : AgentClosureError);
      expect(error.errors).toContain(finalizationError);
      expect(error.errors).toContain(callbackError);
      if (mode !== "ordinary") {
        expect(error.errors).toContain(original);
        expect(() => assignment.assertWritable()).toThrow(AgentClosureError);
      } else assignment.assertIdle();
      if (["callback", "missing", "mixed"].includes(mode)) expect(() => reserveOperation(root, "writer")).toThrow("unknown");
      callbackClosed = true;
      if (mode === "missing" || mode === "mixed") {
        expect(() => reserveOperation(root, "writer")).toThrow("unknown"); // Physical proof cannot discharge missing proof.
      } else {
        const fresh = producer(new ManagedAssignment(root, [root])).wrap(createWriteToolDefinition(root));
        await fresh.execute("recovered", { path: "clean", content: "fresh writer\n" }, undefined, undefined, context(root));
        expect(readFileSync(path.join(root, "clean"), "utf8")).toBe("fresh writer\n");
        if (mode !== "ordinary") expect(() => assignment.assertIdle()).toThrow(AgentClosureError);
      }
      expect(owned.pending).toBe(0);
    } finally {
      finalize.resolve(); callback.resolve(); callbackClosed = true;
      owned.group("ESRCH"); owned.close(); owned.advance(1500);
      await operation; await managed.settle();
      executor.mockRestore(); output.mockRestore();
    }
  });
});

for (const uncertainCallback of [false, true]) test(`managed native wrapper joins ${uncertainCallback ? "uncertain" : "ordinary failing"} callbacks without reviving assignment authority`, () => repository(async root => {
  const assignment = new ManagedAssignment(root, [root]), managed = producer(assignment), owned = controlledProcess();
  const abort = new AbortController(), callback = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let callbackClosed = false;
  const callbackError = uncertainCallback ? new AgentClosureError([new Error("callback resource pending")], "callback",
    { observe: () => callbackClosed ? "closed" : "unknown" }) : new Error("settled callback failure");
  const native = createBashToolDefinition(root, { exposeSessionEnvironment: false, operations: { exec(_command, _cwd, options) {
    entered.resolve();
    return ownProcess(owned.child, options, owned.host);
  } } });
  const wrapped = managed.wrap(native);
  const operation = wrapped.execute("owned", { command: "controlled" }, abort.signal, () => callback.promise, context(root))
    .catch(error => error);
  try {
    await entered.promise;
    abort.abort(); owned.advance(1500);
    owned.group("ESRCH"); owned.close();
    expect(() => reserveOperation(root, "checkpoint")).toThrow(); // Still owns accepted callback work.
    callback.reject(callbackError);
    const error = await operation as AgentClosureError;
    expect(error).toBeInstanceOf(AgentClosureError);
    expect(error.errors).toContain(callbackError);
    if (uncertainCallback) expect(() => reserveOperation(root, "writer")).toThrow("unknown");
    callbackClosed = true;
    reserveOperation(root, "checkpoint").release();
    expect(() => assignment.assertWritable()).toThrow(AgentClosureError);
    expect(() => assignment.assertIdle()).toThrow(AgentClosureError);
    expect(owned.pending).toBe(0);
  } finally {
    abort.abort(); callback.resolve(); callbackClosed = true;
    owned.group("ESRCH"); owned.close(); owned.advance(1500);
    await operation;
    reserveOperation(root, "checkpoint").release();
  }
}));

const unknownProducerCase = "unknown producer closure blocks new work while a known pre-start refusal does not";
test(unknownProducerCase, async () => {
  if (!process.env.PITAKO_UNKNOWN_PRODUCER_HOST) {
    console.log(execFileSync(process.execPath, ["test", import.meta.path, "--test-name-pattern", `^${unknownProducerCase}$`], {
      env: { ...process.env, PITAKO_UNKNOWN_PRODUCER_HOST: "1", BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" },
      encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
    }));
    return;
  }
  await repository(async root => {
    const assignment = new ManagedAssignment(root, [root]), managed = producer(assignment);
    const failed = managed.wrap({ name: "write", label: "write", description: "unknown native closure", parameters: Type.Object({ path: Type.String() }),
      async execute() { throw new AgentClosureError([new Error("unjoined resource")], "native"); } });
    await expect(failed.execute("failed", { path: "clean" }, undefined, undefined, context(root))).rejects.toBeInstanceOf(AgentClosureError);
    expect(() => assignment.assertIdle()).toThrow(AgentClosureError);
    expect(() => producer(assignment).wrap(createWriteToolDefinition(root)).execute("new", { path: "clean", content: "no" }, undefined, undefined, context(root)))
      .toThrow(AgentClosureError);
  });
  for (const aggregate of [false, true]) await repository(async root => {
    const managed = producer(new ManagedAssignment(root, [root]));
    const processError = new AgentClosureError([], "proven process", { observe: () => "closed" });
    const generic = new AgentClosureError([], "unobserved callback");
    const failed = managed.wrap({ name: "write", label: "write", description: "mixed uncertainty",
      parameters: Type.Object({ path: Type.String() }), async execute(_id, _params, _signal, onUpdate) {
        onUpdate?.(result);
        if (aggregate) throw new AggregateError([processError, generic], "arbitrary aggregate");
        throw processError;
      } });
    await expect(failed.execute("mixed", { path: "clean" }, undefined, () => { if (!aggregate) throw generic; }, context(root)))
      .rejects.toBeInstanceOf(AgentClosureError);
    expect(() => reserveOperation(root, "writer")).toThrow("unknown");
    expect(() => reserveOperation(root, "checkpoint")).toThrow("unknown");
    // No actual process was created. The child host owns the synthetic unknown leases.
  });
});

test("loaded known patch keeps native schema, grammar, rendering and output; replacements are unsupported", () => repository(async root => {
  const entry = new URL("../index.ts", import.meta.resolve("pi-codex-tools"));
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
  const owner = (resolvedPath: string) => ({ resolvedPath, tools: new Map([["apply_patch", { definition: patch }]]) });
  const registrations = (extensions: ReturnType<typeof owner>[]) => ({ getExtensions: () => ({ extensions }) }) as any;
  const loader = (resolvedPath: string) => registrations([owner(resolvedPath)]);
  const tools = managedTools(loader(fileURLToPath(entry)), managed);
  const wrapped = tools.find(definition => definition.name === "apply_patch")!;
  expect(wrapped.parameters).toBe(patch.parameters); expect(wrapped.renderCall).toBe(patch.renderCall);
  expect(wrapped.renderResult).toBe(patch.renderResult); expect(wrapped).toMatchObject({ promptSnippet: patch.promptSnippet });
  expect((wrapped as any).constrainedSampling).toBe((patch as any).constrainedSampling);
  const applied = await wrapped.execute("patch", { patch: "*** Begin Patch\n*** Add File: patched\n+native\n*** End Patch\n" }, undefined, undefined, {
    ...context(root), model: { api: "openai-responses", compat: { supportsOpenAIGrammarTools: true } } as any,
  });
  expect(applied.details).toEqual({ changes: [{ kind: "added", path: "patched" }] });
  expect(readFileSync(path.join(root, "patched"), "utf8")).toBe("native\n");
  expect(() => wrapped.execute("outside", { patch: "*** Begin Patch\n*** Add File: ../outside\n+no\n*** End Patch\n" },
    undefined, undefined, context(root))).toThrow("launch root");
  const publicPath = fileURLToPath(entry);
  const internalPath = fileURLToPath(new URL("../extensions/index.ts", import.meta.resolve("pi-codex-tools")));
  const copy = path.join(root, "index.ts"); writeFileSync(copy, "// distinct physical producer\n");
  for (const owners of [[], [owner(import.meta.filename)], [owner(internalPath)],
    [owner(fileURLToPath(import.meta.resolve("pi-codex-tools")))], [owner(copy)],
    [owner(publicPath), owner(publicPath)], [owner(publicPath), owner(copy)]]) {
    const unsupported = managedTools(registrations(owners), managed).map(definition => definition.name);
    expect(unsupported).not.toContain("apply_patch");
    expect(unsupported).toEqual(expect.arrayContaining(["edit", "write"]));
  }
  let guard!: Function;
  await managedGuard(new Set(tools.map(definition => definition.name)))({
    on(_name: string, hook: Function) { guard = hook; },
    getAllTools: () => [...tools.map(definition => ({ name: definition.name, parameters: definition.parameters, sourceInfo: { path: "captured" } })),
      { name: "read", sourceInfo: { path: "builtin:read" } }],
  } as any);
  for (const name of ["codemode", "mcp_write", "apply_patch_replacement"]) expect(guard({ toolName: name }).block).toBe(true);
  for (const name of ["read", "bash", "apply_patch"]) expect(guard({ toolName: name })).toBeUndefined();
  for (const name of ["todo", "head_plan"]) expect(guard({ toolName: name }).block).toBe(true);
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
        commands: [{ id: "replacement", shell: "printf forbidden", cwd: ".", env: {}, timeoutMs: 100 }] })).toThrow("closure unknown");
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
      expect(outcome.diagnostic).toContain("owned process group remained after close");
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
