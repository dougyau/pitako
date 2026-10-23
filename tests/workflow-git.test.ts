import { expect, test, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as checkpoint from "../extensions/agent/checkpoints.ts";
import { digest, localGitEnv } from "../extensions/agent/head/inventory.ts";
import { HeadAttachment } from "../extensions/agent/head/runtime.ts";
import { AgentClosureError } from "../extensions/agent/closure.ts";
import { loadPitakoConfig } from "../extensions/roles/load.ts";
import { ManagedAssignment, foregroundBash } from "../extensions/agent/head/managed-tools.ts";
import { principalLeases } from "../extensions/agent/head/operation-leases.ts";
import { bindForegroundCallContext, captureCallContext, checkAuthority, checkCallContext, planningSlot, registerWorkflowCommands, withCallContext, openExecuteActivity, bindCallContext } from "../extensions/workflow-engine.ts";
import { registerGitTools } from "../extensions/workflow-git.ts";
import { WorkflowState } from "../extensions/workflow-state.ts";
import { openExecutionPlan } from "../extensions/workflow.ts";
import { executeCodemode } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute.js";
import { architectureFixture } from "./fixtures/architecture.ts";

const ownerPath = path.resolve(import.meta.dir, "../extensions/index.ts");
const git = (root: string, args: string[], input?: string | Buffer) => execFileSync("git", args,
  { cwd: root, input, env: localGitEnv(), stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const input = (paths = ["a.txt"]) => ({ paths, message: "Selected raw changes", author: { name: "Controlled Author", email: "controlled@example.invalid" } });
const payload = (value: any) => JSON.parse(value.content[0].text);
function repository(root: string) {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(root, ".gitignore"), ".pitako/\n");
  writeFileSync(path.join(root, "a.txt"), "original\n");
  writeFileSync(path.join(root, "other.txt"), "other\n");
  git(root, ["add", ".gitignore", "a.txt", "other.txt"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", "Initial private fixture"]);
}
function state(root: string) {
  const objects = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? objects(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  return { head: git(root, ["rev-parse", "HEAD"]), index: digest(readFileSync(path.join(root, ".git/index"))), objects: objects(path.join(root, ".git/objects")).sort() };
}
async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-workflow-git-")); repository(root);
  const definitions = new Map<string, any>(), commands = new Map<string, any>(), hooks = new Map<string, Function[]>();
  const sessionId = randomUUID();
  const manager = { getSessionId: () => sessionId, getSessionFile: () => undefined, getBranch: () => [], getEntries: () => [] };
  let confirmations = 0, confirm: (title: string, message: string) => Promise<boolean> = async () => true;
  const ctx: any = { cwd: root, mode: "tui", hasUI: true, sessionManager: manager, isIdle: () => true, waitForIdle: async () => {},
    ui: { notify(message: string, level: string) { if (level === "error") throw new Error(message); },
      async confirm(title: string, message: string) { confirmations++; return confirm(title, message); } } };
  const pi: any = { registerTool(definition: any) { definitions.set(definition.name, definition); },
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
    getAllTools: () => [...definitions.values()].map(definition => ({ ...definition, sourceInfo: { path: ownerPath } })),
    on(name: string, fn: Function) { hooks.set(name, [...hooks.get(name) ?? [], fn]); }, sendMessage() {} };
  principalLeases(pi, foregroundBash); registerWorkflowCommands(pi);
  const unbind = bindForegroundCallContext(root, manager);
  const emit = async (name: string, event: any = {}) => {
    for (const fn of hooks.get(name) ?? []) { const result = await fn(event, ctx); if (result?.block) throw new Error(result.reason); }
  };
  let call = 0;
  const invoke = async (name: string, args: any, signal?: AbortSignal) => {
    const id = `git-call-${++call}`;
    await emit("tool_call", { toolName: name, toolCallId: id, input: args });
    const result = await definitions.get(name).execute(id, args, signal, undefined, ctx);
    await emit("tool_result", { toolName: name, toolCallId: id, ...result });
    return result;
  };
  ctx.executeTool = async (name: string, args: any, opts: any) => {
    try { return { toolCall: { id: `nested/${call}`, name, arguments: args }, result: await invoke(name, args, opts?.signal), isError: false }; }
    catch (error) { return { toolCall: { id: `nested/${call}`, name, arguments: args }, result: { content: [{ type: "text", text: String(error) }], details: {} }, isError: true }; }
  };
  Object.defineProperty(ctx, "tools", { get: () => [...definitions.values()] });
  await commands.get("plan").handler("git-plan", ctx);
  const context = captureCallContext(root, manager);
  if (context.kind !== "managed") throw new Error("actual /plan did not admit a managed context");
  return { root, ctx, pi, definitions, context, invoke, emit, confirmations: () => confirmations,
    confirm(fn: typeof confirm) { confirm = fn; },
    async close() { await emit("session_shutdown"); unbind(); rmSync(root, { recursive: true, force: true }); } };
}

test("actual /plan guarded definition -> inspection executor, nested/codemode, no shell or forged/retired definition", async () => {
  const app = await setup();
  const original = checkpoint.checkpointGit, calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; root: string }> = [];
  const trace = spyOn(checkpoint, "checkpointGit").mockImplementation((root, args, data, env) => { calls.push({ root, args, env: env! }); return original(root, args, data, env); });
  try {
    writeFileSync(path.join(app.root, "a.txt"), "worktree\n");
    expect(payload(await app.invoke("git_inspect", { operation: "status" })).output).toContain("a.txt");
    expect(payload(await app.invoke("git_inspect", { operation: "diff", target: "worktree" })).output).toContain("+worktree");
    expect(payload(await app.invoke("git_inspect", { operation: "diff", target: "index" })).output).toBe("");
    expect(payload(await app.invoke("git_inspect", { operation: "log", limit: 1 })).output).toContain("Initial private fixture");
    expect(payload(await app.invoke("git_inspect", { operation: "config-get", key: "core.hooksPath" })).present).toBe(false);
    git(app.root, ["config", "core.hooksPath", "/literal/effective/hooks"]);
    expect(payload(await app.invoke("git_inspect", { operation: "config-get", key: "core.hooksPath" })).value).toBe("/literal/effective/hooks");
    const nested = await app.ctx.executeTool("git_inspect", { operation: "status" }); expect(nested.isError).toBe(false);
    const coded = await executeCodemode("git-code", { code: 'text(JSON.parse(await tools.git_inspect({operation:"status"})));' }, undefined, undefined, app.ctx);
    expect(coded.isError).not.toBe(true); expect(JSON.stringify(coded)).toContain("a.txt");
    const before = calls.length;
    await expect(app.invoke("bash", { command: "git status; touch forbidden" })).rejects.toThrow("generic mutations");
    await expect(app.invoke("git_inspect", { operation: "log", limit: 101 })).rejects.toThrow();
    expect(calls).toHaveLength(before);
    expect(calls.every(call => call.root === app.root && call.args.includes("--no-pager") && call.args.includes("core.fsmonitor=false") && call.env.GIT_NO_LAZY_FETCH === "1" && call.env.GIT_OPTIONAL_LOCKS === "0" && !call.env.GIT_CONFIG_COUNT)).toBe(true);
    expect(calls.flatMap(call => call.args).some(arg => arg.startsWith("core.hooksPath="))).toBe(false);
    const captured = app.definitions.get("git_inspect");
    app.definitions.set("git_inspect", { ...captured, parameters: { ...captured.parameters }, execute: captured.execute });
    await expect(Promise.resolve().then(() => withCallContext(app.context, () => captured.execute("old", { operation: "status" }, undefined, undefined, app.ctx)))).rejects.toThrow("definition generation");
    app.definitions.set("git_inspect", captured);
    const all = app.pi.getAllTools;
    app.pi.getAllTools = () => all().map((tool: any) => ({ ...tool, sourceInfo: { path: path.join(app.root, "forged.ts") } }));
    await expect(app.invoke("git_inspect", { operation: "status" })).rejects.toThrow();
    app.pi.getAllTools = all;
    await app.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
    await expect(Promise.resolve().then(() => withCallContext(app.context, () => captured.execute("retired", { operation: "status" }, undefined, undefined, app.ctx)))).rejects.toThrow("retired");
    expect(existsSync(path.join(app.root, "forbidden"))).toBe(false);
  } finally { trace.mockRestore(); await app.close(); }
});

test("inspection disables configured helpers and distinguishes absent config from actual errors", async () => {
  const app = await setup();
  try {
    const marker = path.join(app.root, "executed"), helper = path.join(app.root, "helper");
    writeFileSync(helper, `#!/bin/sh\nprintf ran > '${marker}'\n`); chmodSync(helper, 0o755);
    git(app.root, ["config", "core.fsmonitor", helper]); git(app.root, ["config", "diff.external", helper]);
    git(app.root, ["config", "diff.fixture.textconv", helper]);
    git(app.root, ["config", "filter.fixture.clean", helper]); git(app.root, ["config", "filter.fixture.process", helper]); git(app.root, ["config", "filter.fixture.required", "true"]);
    writeFileSync(path.join(app.root, ".gitattributes"), "a.txt diff=fixture filter=fixture\n");
    writeFileSync(path.join(app.root, "a.txt"), "changed\n");
    for (const args of [{ operation: "status" }, { operation: "diff", target: "worktree" }, { operation: "diff", target: "index" }, { operation: "log", limit: 1 }]) await app.invoke("git_inspect", args);
    expect(existsSync(marker)).toBe(false);
    // Keep discovery valid and fail only the config query, through the actual executor boundary.
    const original = checkpoint.checkpointGit;
    const fail = spyOn(checkpoint, "checkpointGit").mockImplementation((root, args, data, env) => {
      if (args.includes("--get")) throw Object.assign(new Error("controlled config error"), { status: 3 });
      return original(root, args, data, env);
    });
    try { await expect(app.invoke("git_inspect", { operation: "config-get", key: "core.hooksPath" })).rejects.toThrow("config error"); }
    finally { fail.mockRestore(); }
  } finally { await app.close(); }
});

for (const outcome of ["deny", "cancel", "rpc", "print", "json", "missing-mode"])
test(`commit consent ${outcome} leaves Git unchanged`, async () => {
  const app = await setup();
  try {
    writeFileSync(path.join(app.root, "a.txt"), "selected\n");
    const before = state(app.root);
    if (outcome === "rpc" || outcome === "print" || outcome === "json") app.ctx.mode = outcome;
    if (outcome === "missing-mode") delete app.ctx.mode;
    app.confirm(async () => { if (outcome === "cancel") throw new Error("dialog cancelled"); return false; });
    await expect(app.invoke("git_commit", input())).rejects.toThrow();
    expect(state(app.root)).toEqual(before);
    expect(app.confirmations()).toBe(["deny", "cancel"].includes(outcome) ? 1 : 0);
  } finally { await app.close(); }
});

test("neither an authorization boolean nor a fabricated ordinary context supplies a commit grant", async () => {
  const app = await setup();
  try {
    writeFileSync(path.join(app.root, "a.txt"), "selected\n");
    const before = state(app.root);
    await expect(app.invoke("git_commit", { ...input(), authorized: true })).rejects.toThrow("invalid structured Git input");
    const forged = { kind: "ordinary" as const, guard: checkCallContext(app.context) };
    await expect(Promise.resolve().then(() => withCallContext(forged, () => app.definitions.get("git_commit").execute("forged", input(), undefined, undefined, app.ctx)))).rejects.toThrow();
    expect(state(app.root)).toEqual(before); expect(app.confirmations()).toBe(0);
  } finally { await app.close(); }
});

test("foreground native consent commits exact raw literal selection, modes, deletion, author, parent/ref/index, preserving draft and omitted dirt", async () => {
  const app = await setup();
  try {
    const slot = planningSlot(app.context.authority), draft = slot.writeDraft(slot.read(), "# Draft\nPreserved\n").snapshot;
    const before = state(app.root), raw = Buffer.from([0, 255, 13, 10, 1]);
    const literal = ":(glob)*.bin";
    writeFileSync(path.join(app.root, literal), raw); chmodSync(path.join(app.root, literal), 0o755);
    writeFileSync(path.join(app.root, "a.txt"), "omitted\n"); rmSync(path.join(app.root, "other.txt"));
    app.confirm(async (title, message) => {
      expect(title).toContain("exact local Git proposal"); const proposal = JSON.parse(message);
      expect(proposal.root).toBe(app.root); expect(proposal.parent).toBe(before.head);
      expect(proposal.paths.map((file: any) => file.path)).toEqual([literal, "other.txt"]);
      expect(proposal.paths[0].hash).toBe(digest(raw)); expect(proposal.paths[0]).not.toHaveProperty("bytes");
      expect(proposal.policy).toMatchObject({ hooks: "none", signing: "none", filters: "none" });
      return true;
    });
    const result = payload(await app.invoke("git_commit", input([literal, "other.txt"])));
    expect(result.status).toBe("committed"); expect(app.confirmations()).toBe(1);
    const commit = git(app.root, ["rev-parse", "HEAD"]);
    expect(git(app.root, ["rev-parse", "HEAD^"])).toBe(before.head);
    expect(execFileSync("git", ["show", `HEAD:${literal}`], { cwd: app.root, env: localGitEnv() })).toEqual(raw);
    expect(git(app.root, ["--literal-pathspecs", "ls-tree", "HEAD", "--", literal])).toStartWith("100755 blob");
    expect(git(app.root, ["ls-tree", "HEAD", "--", "other.txt"])).toBe("");
    expect(git(app.root, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(app.root, ["show", "--format=%an <%ae>", "--no-patch", "HEAD"])).toBe("Controlled Author <controlled@example.invalid>");
    expect(git(app.root, ["show", "HEAD:a.txt"])).toBe("original");
    expect(readFileSync(path.join(app.root, "a.txt"), "utf8")).toBe("omitted\n");
    expect(slot.read()).toEqual(draft);
    expect(result.observed).toMatchObject({ head: commit, ref: commit, indexHash: state(app.root).index });
    const store = checkCallContext(app.context).store;
    expect(store.outbox().filter(row => row.target.startsWith("git-commit:")).map(row => (row.body as any).phase)).toEqual(["prepared", "effects-starting", "ref-updating", "ref-updated", "completed"]);
    expect(store.all<any>("reservations").filter(row => row.reservationId === result.proposalId)[0].state).toBe("released");
    app.confirm(async () => true);
    const coded = await executeCodemode("second-commit", { code: 'text(JSON.parse(await tools.git_commit({paths:["a.txt"],message:"Second selection",author:{name:"Test",email:"test@local.invalid"}})));' }, undefined, undefined, app.ctx);
    expect(coded.isError).not.toBe(true); expect(JSON.stringify(coded)).toContain("committed");
    expect(app.confirmations()).toBe(2);
  } finally { await app.close(); }
});

for (const drift of ["bytes", "index", "ref", "owner", "pin", "policy", "definition"])
test(`proposal revalidation after consent wait refuses ${drift}`, async () => {
  const app = await setup(); const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<boolean>();
  let pending: Promise<any> | undefined, assignment: ManagedAssignment | undefined;
  try {
    writeFileSync(path.join(app.root, "a.txt"), "selected\n");
    app.confirm(async () => { entered.resolve(); return release.promise; });
    pending = app.invoke("git_commit", input());
    await Promise.race([entered.promise, pending.then(() => { throw new Error("commit finished before consent wait"); })]);
    if (drift === "bytes") writeFileSync(path.join(app.root, "a.txt"), "changed while waiting\n");
    if (drift === "index") git(app.root, ["add", "a.txt"]);
    if (drift === "ref") { git(app.root, ["branch", "other", "HEAD"]); git(app.root, ["symbolic-ref", "HEAD", "refs/heads/other"]); }
    if (drift === "owner") await app.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
    if (drift === "pin") assignment = withCallContext(app.context, () => new ManagedAssignment(app.root, [app.root]));
    if (drift === "policy") git(app.root, ["config", "commit.gpgSign", "true"]);
    if (drift === "definition") registerGitTools(app.pi);
    const changedState = drift === "ref" ? { index: digest(readFileSync(path.join(app.root, ".git/index"))) } : state(app.root);
    release.resolve(true);
    await expect(pending).rejects.toThrow(drift === "pin" ? /bindingId=inventory:.*component=HEAD.*expected=.*operation=commit/ : /drift|staged|retired|unsupported|symbolic|ambiguous|unknown revision|definition/i);
    expect(drift === "ref" ? { index: digest(readFileSync(path.join(app.root, ".git/index"))) } : state(app.root)).toEqual(changedState);
  } finally { release.resolve(false); await pending?.catch(() => {}); assignment?.retireInventory(); await app.close(); }
});

for (const policy of ["staged", "conflict", "hook", "signing", "filter", "mode", "lock", "promisor"])
test(`incompatible ${policy} is refused without Git effects`, async () => {
  const app = await setup();
  try {
    writeFileSync(path.join(app.root, "a.txt"), "selected\n");
    if (policy === "staged") { writeFileSync(path.join(app.root, "other.txt"), "foreign staged\n"); git(app.root, ["add", "other.txt"]); }
    if (policy === "hook") { const hook = path.join(app.root, ".git/hooks/pre-commit"); writeFileSync(hook, "#!/bin/sh\nexit 3\n"); chmodSync(hook, 0o755); }
    if (policy === "signing") git(app.root, ["config", "commit.gpgSign", "true"]);
    if (policy === "promisor") git(app.root, ["config", "remote.fixture.promisor", "true"]);
    if (policy === "filter") { writeFileSync(path.join(app.root, ".gitattributes"), "a.txt filter=fixture\n"); git(app.root, ["config", "filter.fixture.clean", "touch never-run"]); }
    if (policy === "mode") { const oid = git(app.root, ["rev-parse", "HEAD:a.txt"]); git(app.root, ["update-index", "--cacheinfo", `120000,${oid},a.txt`]); }
    if (policy === "conflict") { const oid = git(app.root, ["rev-parse", "HEAD:a.txt"]); git(app.root, ["update-index", "--index-info"], `0 ${"0".repeat(oid.length)}\ta.txt\n100644 ${oid} 1\ta.txt\n100644 ${oid} 2\ta.txt\n`); }
    if (policy === "lock") writeFileSync(path.join(app.root, ".git/index.lock"), "foreign lock");
    const before = state(app.root);
    if (policy === "lock") {
      const result = payload(await app.invoke("git_commit", input())); expect(result.status).toBe("refused");
      expect(readFileSync(path.join(app.root, ".git/index.lock"), "utf8")).toBe("foreign lock");
    } else { await expect(app.invoke("git_commit", input())).rejects.toThrow(); expect(app.confirmations()).toBe(0); }
    expect(state(app.root)).toEqual(before); expect(existsSync(path.join(app.root, "never-run"))).toBe(false);
  } finally { await app.close(); }
});

for (const phase of ["ref-updated", "completed"])
test(`partial failure at ${phase} reports observed Git state without rollback or replay`, async () => {
  const app = await setup(); const original = WorkflowState.prototype.enqueue; let updates = 0;
  const originalGit = checkpoint.checkpointGit;
  const commands = spyOn(checkpoint, "checkpointGit").mockImplementation((root, args, data, env) => { if (args.includes("update-ref")) updates++; return originalGit(root, args, data, env); });
  const journal = spyOn(WorkflowState.prototype, "enqueue").mockImplementation(function (this: WorkflowState, target, binding, body: any) {
    if (target.startsWith("git-commit:") && body.phase === phase) throw new Error("controlled journal cut");
    return original.call(this, target, binding, body);
  });
  try {
    writeFileSync(path.join(app.root, "a.txt"), "selected\n"); const before = state(app.root);
    const result = payload(await app.invoke("git_commit", input()));
    expect(result.status).toBe("partial"); expect(result.diagnostic).toContain("journal cut"); expect(result.replay).toBe("unsupported");
    expect(result.observed.head).toBe(git(app.root, ["rev-parse", "HEAD"])); expect(result.observed.head).not.toBe(before.head);
    expect(result.observed.indexHash === before.index).toBe(phase === "ref-updated");
    expect(updates).toBe(1); expect(existsSync(path.join(app.root, ".git/index.lock"))).toBe(false);
    expect(readFileSync(path.join(app.root, "a.txt"), "utf8")).toBe("selected\n");
    if (phase === "ref-updated") await expect(app.invoke("git_commit", input())).rejects.toThrow("clean against HEAD");
    expect(updates).toBe(1);
  } finally { journal.mockRestore(); commands.mockRestore(); await app.close(); }
});

test("late cleanup failure preserves the Git result, cleans independent scratch and observes settled resources", async () => {
  const app = await setup(), store = checkCallContext(app.context).store;
  const original = WorkflowState.prototype.enqueue, originalGit = checkpoint.checkpointGit;
  const lockPath = path.join(app.root, ".git/index.lock");
  let updates = 0, temporary: string | undefined, resource: any;
  const commands = spyOn(checkpoint, "checkpointGit").mockImplementation((root, args, data, env) => {
    if (root === app.root && args.includes("update-ref")) updates++;
    return originalGit(root, args, data, env);
  });
  const journal = spyOn(WorkflowState.prototype, "enqueue").mockImplementation(function (this: WorkflowState, target, binding, body: any) {
    if (this.root === app.root && target.startsWith("git-commit:") && body.phase === "ref-updated") {
      resource = JSON.parse(binding);
      temporary = store.all<any>("reservations").find(row => row.reservationId === target.slice("git-commit:".length))
        .paths.find((file: string) => path.basename(file).startsWith("pitako-git-index-"));
      // This seam is after all synchronous Git children and the index fd have settled.
      // A directory obstruction produces a real unlink failure without mocking fs or changing shared permissions.
      rmSync(lockPath); mkdirSync(lockPath); writeFileSync(path.join(lockPath, "obstruction"), "owned fixture\n");
      throw new Error("controlled journal cut before index replacement");
    }
    return original.call(this, target, binding, body);
  });
  try {
    writeFileSync(path.join(app.root, "a.txt"), "selected\n"); const before = state(app.root);
    let result: any, rejection: string | undefined;
    try { result = payload(await app.invoke("git_commit", input())); } catch (error) { rejection = String(error); }
    const actual = state(app.root), closure = store.closureReceipt(resource);
    const savedResource = store.exactResource(resource);
    const reservation = store.all<any>("reservations").find(row => row.reservationId === savedResource.effectReservation?.reservationId);
    console.log("GIT_CLEANUP_WITNESS", JSON.stringify({ result, rejection, before, actual, resource: store.exactResource(resource), closure,
      reservation, temporary, scratchRetained: existsSync(temporary!), lockRetained: existsSync(lockPath), updates }));
    expect(rejection).toBeUndefined();
    expect(result.status).toBe("partial"); expect(result.diagnostic).toContain("journal cut before index replacement");
    expect(result.replay).toBe("unsupported");
    expect(result.cleanupDiagnostics).toEqual([expect.objectContaining({ operation: "remove-index-lock", path: lockPath, diagnostic: expect.stringMatching(/EISDIR|directory/i) })]);
    expect(result.retainedPaths).toEqual([lockPath]); expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(temporary!)).toBe(false);
    expect(actual.head).not.toBe(before.head); expect(actual.index).toBe(before.index);
    expect(result.observed).toMatchObject({ head: actual.head, ref: actual.head, commit: actual.head, tree: git(app.root, ["rev-parse", "HEAD^{tree}"]), indexHash: actual.index });
    expect(git(app.root, ["rev-parse", "HEAD^"])).toBe(before.head); expect(git(app.root, ["show", "HEAD:a.txt"])).toBe("selected");
    expect(closure).toBeDefined(); expect(store.verifyClosureReceipt(closure!)).toBe(true);
    expect(store.exactResource(resource).facts["host-operation"]).toBe("closed"); expect(reservation.state).toBe("released");
    expect(store.outbox().filter(row => row.target === `git-commit:${result.proposalId}`).at(-1)?.body).toEqual({ phase: "cleanup-failed", body: result });
    expect(updates).toBe(1);
    await expect(app.invoke("git_commit", input())).rejects.toThrow("clean against HEAD");
    expect(updates).toBe(1); expect(state(app.root)).toEqual(actual);
  } finally {
    // invoke has returned/rejected at the known settled seam; these are inert owned artifacts.
    try { await app.close(); if (temporary) rmSync(temporary, { recursive: true, force: true }); }
    finally { journal.mockRestore(); commands.mockRestore(); }
  }
});

test("real SourceInventory pin blocks HEAD/index mutation only while its owning consumer requires it", async () => {
  const app = await setup(); let managed: ManagedAssignment | undefined;
  try {
    managed = withCallContext(app.context, () => new ManagedAssignment(app.root, [app.root]));
    writeFileSync(path.join(app.root, "a.txt"), "selected\n");
    const before = state(app.root);
    await expect(app.invoke("git_commit", input())).rejects.toThrow(/bindingId=inventory:.*component=HEAD.*expected=.*operation=commit/);
    expect(app.confirmations()).toBe(0); expect(state(app.root)).toEqual(before);
    expect(payload(await app.invoke("git_inspect", { operation: "status" })).output).toContain("a.txt");
    await managed.settle(); managed.retireInventory(); managed = undefined;
    expect(payload(await app.invoke("git_commit", input())).status).toBe("committed");
  } finally { managed?.retireInventory(); await app.close(); }
});

test("a retired failed source-inventory consumer joins its callers and removes its pin without changing an unknown outcome", async () => {
  const app = await setup();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const head = withCallContext(app.context, () => new HeadAttachment("pin-lifetime", app.root, {
    writes: ["a.txt"], config: loadPitakoConfig({ userConfigPath: path.join(app.root, "absent-config.toml"), env: {} }),
    executor: { async start() { throw new Error("no provider or agent starts in this check"); } },
  }));
  head.claim("pin-instance", app.root); const binding = head.bind("pin-instance");
  const pending = head.own(binding, async () => { entered.resolve(); await release.promise; });
  try {
    await entered.promise;
    const store = checkCallContext(app.context).store;
    head.retainUnknown(new AgentClosureError([new Error("controlled historical unknown")], "pin-lifetime"));
    expect(store.gitPins().some(pin => pin.bindingId.startsWith("inventory:"))).toBe(true);
    release.resolve(); await pending;
    await expect(head.close()).rejects.toBeInstanceOf(AgentClosureError);
    expect(head.closure.state).toBe("unknown");
    expect(store.gitPins().some(pin => pin.bindingId.startsWith("inventory:"))).toBe(false);
    writeFileSync(path.join(app.root, "a.txt"), "selected\n");
    expect(payload(await app.invoke("git_commit", input())).status).toBe("committed");
  } finally { release.resolve(); await pending; await head.close().catch(() => {}); await app.close(); }
});

test("real ExecutionBinding producer pins source/revision/hash without inventing a HEAD/index pin", async () => {
  const app = await setup();
  let activity: ReturnType<typeof openExecuteActivity> | undefined, unbind: (() => void) | undefined;
  try {
    const slot = planningSlot(app.context.authority);
    const draft = slot.writeDraft(slot.read(), "# Execution source\nImmutable\n", { execution: "expected" }).snapshot;
    slot.freeze(slot.candidate(draft));
    await app.emit("session_before_switch");
    const plan = openExecutionPlan("git-plan", app.root);
    activity = openExecuteActivity(plan, app.ctx.sessionManager, app.ctx.sessionManager.getSessionId());
    unbind = bindCallContext(app.ctx.sessionManager, activity.context);
    const pins = activity.guard.store.gitPins();
    expect(pins.some(pin => pin.components.some(component => component.component === "source" && component.expected === JSON.stringify(plan.binding)))).toBe(true);
    writeFileSync(path.join(app.root, "a.txt"), "selected\n");
    expect(payload(await app.invoke("git_commit", input())).status).toBe("committed");
    expect(readFileSync(plan.binding.planSource, "utf8")).toBe(plan.text);
    await activity.retire(); expect(activity.guard.store.gitPins()).toEqual([]);
  } finally { unbind?.(); await activity?.retire(); await app.close(); }
});

const reviewFixture = architectureFixture("review");
test("actual diff-review capture owns HEAD/index pin through background cleanup, then historical review releases it", reviewFixture.fixture.ownedCase("T3 review pins", async () => {
  const app = await reviewFixture.setup({ config: "[review]\ncandidates = []\n", prompt: async (_session, request, body) => {
    if (request.stage === "composition") return { ...body, specialists: [] };
    if (request.stage === "synthesis") { entered.resolve(); await release.promise; }
  } });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  reviewFixture.fixture.finishOnCleanup(release.resolve);
  try {
    repository(app.root);
    const pi: any = { registerTool(definition: any) { app.tools.set(definition.name, definition); },
      getAllTools: () => [...app.tools.values()].map(definition => ({ ...definition, sourceInfo: { path: ownerPath } })) };
    registerGitTools(pi); app.ctx.mode = "tui"; app.ctx.ui.confirm = async () => true;
    const context = captureCallContext(app.root, app.ctx.sessionManager);
    const started = await app.invoke("review_start", { goal: "Review selected complete diff", object: { kind: "diff", base: "HEAD" }, criteria: ["correctness"] });
    expect(started.isError, JSON.stringify(started)).not.toBe(true);
    const review = payload(started).metadata;
    await Promise.race([entered.promise, app.bookkeeping(review.instanceId).then(async () => { throw new Error(`review settled before synthesis: ${JSON.stringify(await app.read("team_result", { assignmentId: review.assignmentId }))}`); })]);
    writeFileSync(path.join(app.root, "a.txt"), "selected\n");
    await expect(withCallContext(context, () => app.invoke("git_commit", input()))).rejects.toThrow(/bindingId=review:.*component=HEAD.*operation=commit/);
    expect(checkCallContext(context).store.gitPins().some(pin => pin.bindingId.startsWith("review:"))).toBe(true);
    const store = checkCallContext(context).store;
    const resource = store.gitPins().find(pin => pin.bindingId.startsWith("review:"))!.resource!;
    release.resolve(); await app.delivered.promise;
    let unsubscribe = () => {};
    try {
      await new Promise<void>(resolve => {
        const observe = () => { if (store.closureReceipt(resource)) resolve(); };
        unsubscribe = store.subscribe(observe); observe();
      });
    } finally { unsubscribe(); }
    expect(store.gitPins().some(pin => pin.bindingId.startsWith("review:"))).toBe(false);
    expect(payload(await withCallContext(context, () => app.invoke("git_commit", input()))).status).toBe("committed");
  } finally { release.resolve(); await app.close(); }
}));
