import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkpointGit } from "./agent/checkpoints.ts";
import { checkpointGitPolicy, digest, localGitEnv, raw } from "./agent/head/inventory.ts";
import { assertGitCommitOwner, captureCallContext, checkCallContext, currentCallContext, guardDefinition, reserveEffect, type CallContext } from "./workflow-engine.ts";
import { verifyExecutionBinding, type ExecutionBinding } from "./workflow.ts";
import { executionForSession } from "./execution-identity.ts";
import { currentInstanceId } from "./agent/scope.ts";
import { packageRoot } from "./stack.ts";

const strict = { additionalProperties: false } as const;
const inspectSchema = Type.Union([
  Type.Object({ operation: Type.Literal("status") }, strict),
  Type.Object({ operation: Type.Literal("diff"), target: Type.Union([Type.Literal("worktree"), Type.Literal("index")]) }, strict),
  Type.Object({ operation: Type.Literal("log"), limit: Type.Integer({ minimum: 1, maximum: 100 }) }, strict),
  Type.Object({ operation: Type.Literal("config-get"), key: Type.Literal("core.hooksPath") }, strict),
]);
const commitSchema = Type.Object({ paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 256 }),
  message: Type.String({ minLength: 1, maxLength: 16384 }),
  author: Type.Object({ name: Type.String({ minLength: 1, maxLength: 256 }), email: Type.String({ minLength: 1, maxLength: 256 }) }, strict) }, strict);
type CommitInput = Static<typeof commitSchema>;
const fixed = ["--no-pager", "--no-replace-objects", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
  "-c", "submodule.recurse=false", "-c", "diff.submodule=short", "-c", "core.quotePath=true"];
function environment(): NodeJS.ProcessEnv {
  const inherited = localGitEnv(), env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "XDG_CONFIG_HOME", "LANG", "LC_ALL", "TMPDIR", "SystemRoot"]) if (inherited[name]) env[name] = inherited[name];
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_ATTR_NOSYSTEM: "1" };
}
function git(root: string, args: string[], input?: string | Buffer, extra?: NodeJS.ProcessEnv): Buffer {
  return checkpointGit(root, [...fixed, ...args], input, { ...environment(), ...extra });
}
function inspectionGit(root: string, args: string[]) {
  let keys = "";
  try { keys = git(root, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]).toString(); }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  // status/diff may otherwise run clean/process filters even with --no-textconv.
  const drivers = new Set(keys.split("\0").filter(Boolean).map(key => key.replace(/\.(clean|smudge|process|required)$/i, "")));
  const overrides = [...drivers].flatMap(driver => ["-c", `${driver}.clean=`, "-c", `${driver}.smudge=`, "-c", `${driver}.process=`, "-c", `${driver}.required=false`]);
  return git(root, [...overrides, ...args]);
}
const text = (root: string, args: string[]) => git(root, args).toString("utf8").replace(/\n$/, "");
const bytesHash = (file: string) => existsSync(file) ? digest(readFileSync(file)) : "absent";
function physicalRepository(cwd: string) {
  cwd = realpathSync(cwd);
  if (cwd === path.parse(cwd).root) throw new Error("Git requires an implicit non-root working directory");
  const root = realpathSync(text(cwd, ["rev-parse", "--show-toplevel"]));
  if (text(root, ["rev-parse", "--is-bare-repository"]) !== "false") throw new Error("bare repository unsupported");
  return { root, gitDir: realpathSync(text(root, ["rev-parse", "--absolute-git-dir"])),
    commonDir: realpathSync(text(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) };
}
function inspect(cwd: string, input: Static<typeof inspectSchema>) {
  const { root } = physicalRepository(cwd);
  if (input.operation !== "config-get") {
    let policy = "";
    try { policy = git(root, ["config", "--null", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor)$"]).toString(); }
    catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
    for (const record of policy.split("\0").filter(Boolean)) {
      const at = record.indexOf("\n");
      if (record.slice(0, at).toLowerCase() === "extensions.partialclone" || !["false", "0"].includes(record.slice(at + 1)))
        throw new Error("Git inspection does not support promisor/partial-clone object reads");
    }
  }
  switch (input.operation) {
    case "status": return { root, output: inspectionGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]).toString() };
    case "diff": return { root, output: inspectionGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--ignore-submodules=all",
      ...(input.target === "index" ? ["--cached"] : []), "--"]).toString() };
    case "log": return { root, output: git(root, ["log", `--max-count=${input.limit}`, "--format=%H%x00%P%x00%an%x00%aI%x00%s", "--no-show-signature", "--no-decorate", "--"]).toString() };
    case "config-get":
      try { return { root, present: true, value: git(root, ["config", "--get", "core.hooksPath"]).toString().replace(/\n$/, "") }; }
      catch (error) { if ((error as { status?: number }).status === 1) return { root, present: false }; throw error; }
  }
}

export interface GitCommitProposal {
  proposalId: string; root: string; gitDir: string; commonDir: string; ref: string; parent: string;
  indexPath: string; indexHash: string; policy: { fingerprint: string; hooks: "none"; filters: "none"; signing: "none"; staging: "clean index, exact raw selection" };
  paths: Array<{ path: string; deleted: boolean; mode?: number; hash?: string; bytes?: string }>;
  message: string; author: CommitInput["author"]; date: string;
}
/** Grants never cross the tool boundary, persist, or derive authority from JSON. */
interface GitCommitGrant { readonly proposalId: string }
const grants = new WeakMap<GitCommitGrant, { proposal: GitCommitProposal; context: CallContext; manager: object; sessionId: string; used: boolean }>();
function capture(cwd: string, input: CommitInput, proposalId: string = randomUUID(), date = new Date().toISOString()): GitCommitProposal {
  const repo = physicalRepository(cwd), { root } = repo;
  if (!input.message.trim() || input.message.includes("\0") || !/^[^<>\r\n\0]+$/.test(input.author.name) || !/^[^<>\s\0]+@[^<>\s\0]+$/.test(input.author.email))
    throw new Error("invalid commit message/author");
  if (new Set(input.paths).size !== input.paths.length || input.paths.some(name => !name || name.includes("\0") || path.isAbsolute(name) ||
      path.normalize(name) !== name || name === "." || name.startsWith("../") || name.split("/").some(part => part.toLowerCase() === ".git"))) throw new Error("select distinct literal repository paths");
  // Reuse the checkpoint policy observer, never its contribution or authorization contract.
  const fingerprint = checkpointGitPolicy(root, environment());
  for (const key of ["core.autocrlf", "core.splitIndex"]) {
    let value: string;
    try { value = text(root, ["config", "--get", key]); } catch (error) { if ((error as { status?: number }).status === 1) continue; throw error; }
    if (!["false", "0"].includes(value)) throw new Error(`unsupported mandatory Git policy: ${key}=${value}`);
  }
  const parent = text(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const ref = text(root, ["symbolic-ref", "-q", "HEAD"]);
  if (!ref.startsWith("refs/heads/")) throw new Error("commit requires a local branch ref");
  const physicalTarget = (file: string) => {
    let existing = file;
    while (!existsSync(existing)) {
      try { lstatSync(existing); throw new Error(`unsupported dangling Git target: ${file}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      existing = path.dirname(existing);
    }
    if (realpathSync(existing) !== existing) throw new Error(`unsupported symlinked Git target: ${file}`);
  };
  const objects = path.join(repo.commonDir, "objects");
  physicalTarget(objects);
  for (const entry of readdirSync(objects)) physicalTarget(path.join(objects, entry));
  physicalTarget(path.join(repo.commonDir, ref));
  physicalTarget(path.join(repo.commonDir, "logs", ref));
  const indexPath = text(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (realpathSync(indexPath) !== indexPath || !lstatSync(indexPath).isFile()) throw new Error("unsupported real index path");
  const indexBytes = git(root, ["ls-files", "--stage", "-z"]), treeBytes = git(root, ["ls-tree", "-r", "-z", parent]);
  if (!isUtf8(indexBytes) || !isUtf8(treeBytes)) throw new Error("unsupported non-UTF8 index/tree paths");
  const index = indexBytes.toString(), tree = treeBytes.toString();
  const stages = index.split("\0").filter(Boolean);
  if (stages.some(entry => !/^100(?:644|755) [a-f0-9]+ 0\t/.test(entry)) ||
      git(root, ["ls-files", "-v", "-z"]).toString().split("\0").some(entry => entry && !entry.startsWith("H ")))
    throw new Error("unsupported modes, conflicts or index flags");
  const normalized = tree.split("\0").filter(Boolean).map(record => record.replace(/^(100(?:644|755)) blob ([a-f0-9]+)\t/, "$1 $2 0\t")).sort();
  if (JSON.stringify(normalized) !== JSON.stringify([...stages].sort())) throw new Error("real index must be clean against HEAD; foreign staged entries refused");
  const attrs = git(root, ["check-attr", "--all", "-z", "--stdin"], input.paths.join("\0") + "\0").toString().split("\0");
  for (let i = 0; i + 2 < attrs.length; i += 3) if (["filter", "working-tree-encoding", "text", "eol", "ident"].includes(attrs[i + 1]!) &&
      !["unset", "unspecified"].includes(attrs[i + 2]!)) throw new Error(`unsupported mandatory attribute: ${attrs[i]} ${attrs[i + 1]}=${attrs[i + 2]}`);
  let size = 0;
  const paths = input.paths.map(name => {
    const file = raw(root, name);
    if (file && file.kind !== "file") throw new Error(`unsupported selected raw file: ${name}`);
    if (!file && !stages.some(record => record.slice(record.indexOf("\t") + 1) === name)) throw new Error(`selected path absent from source and HEAD: ${name}`);
    const bytes = file && readFileSync(path.join(root, name));
    if (bytes) { size += bytes.length; if (digest(bytes) !== file.digest) throw new Error(`selected bytes drift: ${name}`); }
    if (size > 8 * 1024 * 1024) throw new Error("selected raw bytes exceed 8 MiB");
    return { path: name, deleted: !file, ...(file ? { mode: file.mode, hash: file.digest, bytes: bytes!.toString("base64") } : {}) };
  });
  return { proposalId, ...repo, ref, parent, indexPath, indexHash: bytesHash(indexPath), paths, message: input.message,
    author: { ...input.author }, date, policy: { fingerprint, hooks: "none", filters: "none", signing: "none", staging: "clean index, exact raw selection" } };
}
function checkPins(context: CallContext, proposal: GitCommitProposal) {
  for (const pin of checkCallContext(context).store.gitPins()) {
    if (pin.root !== proposal.root) continue;
    for (const { component, expected } of pin.components) {
      if (component === "source") {
        try { verifyExecutionBinding(JSON.parse(expected) as ExecutionBinding); }
        catch (cause) { throw new Error(`Git pin conflict bindingId=${pin.bindingId} component=source expected=${expected} operation=commit`, { cause }); }
      } else if (component === "HEAD" || component === "index") {
        throw new Error(`Git pin conflict bindingId=${pin.bindingId} component=${component} expected=${expected} operation=commit`);
      } else {
        const actual = component === "policy" ? proposal.policy.fingerprint : proposal[component];
        if (actual !== expected) throw new Error(`Git pin conflict bindingId=${pin.bindingId} component=${component} expected=${expected} operation=commit`);
      }
    }
  }
}
function current(context: CallContext, ctx: ExtensionToolContext, sessionId: string, signal?: AbortSignal) {
  assertGitCommitOwner(context, ctx.sessionManager);
  if (currentCallContext(ctx.sessionManager) !== context || ctx.sessionManager.getSessionId() !== sessionId || signal?.aborted) throw new Error("Git owner/session retired or cancelled");
  if (ctx.mode !== "tui" || currentInstanceId() || executionForSession(sessionId) || process.env.PITAKO_INSTANCE_ID)
    throw new Error("Git commit requires foreground TUI native proposal consent; RPC/headless unsupported");
}
async function consent(proposal: GitCommitProposal, context: CallContext, ctx: ExtensionToolContext, definitionCurrent: () => void, signal?: AbortSignal): Promise<GitCommitGrant> {
  const sessionId = ctx.sessionManager.getSessionId();
  definitionCurrent();
  current(context, ctx, sessionId, signal);
  // No existing host producer captures matching Git consent. Neither prompts nor command invocation are captures.
  const { paths, ...basis } = proposal;
  const approved = await ctx.ui.confirm("Commit exact local Git proposal?", JSON.stringify({ ...basis,
    paths: paths.map(({ bytes: _bytes, ...file }) => file) }, null, 2), { signal });
  definitionCurrent();
  current(context, ctx, sessionId, signal);
  if (ctx.mode !== "tui" || approved !== true) throw new Error("Git commit denied or cancelled");
  const grant = Object.freeze({ proposalId: proposal.proposalId });
  grants.set(grant, { proposal, context, manager: ctx.sessionManager, sessionId, used: false });
  return grant;
}
function executeCommit(grant: GitCommitGrant, context: CallContext, ctx: ExtensionToolContext, definitionCurrent: () => void, signal?: AbortSignal) {
  const issued = grants.get(grant);
  if (!issued || issued.used || issued.context !== context || issued.manager !== ctx.sessionManager) throw new Error("Git grant unavailable, consumed or foreign");
  issued.used = true; // Never replay an uncertain effect.
  const proposal = issued.proposal, store = checkCallContext(context).store;
  const revalidate = () => {
    definitionCurrent();
    current(context, ctx, issued.sessionId, signal);
    const now = capture(proposal.root, { paths: proposal.paths.map(file => file.path), message: proposal.message, author: proposal.author }, proposal.proposalId, proposal.date);
    if (JSON.stringify(now) !== JSON.stringify(proposal)) throw new Error(`Git proposal drift: ${proposal.proposalId}`);
    checkPins(context, proposal);
  };
  revalidate();
  const scratchRoot = path.join(realpathSync(tmpdir()), `pitako-git-index-${proposal.proposalId}`);
  const scopes = [...new Set([proposal.gitDir, proposal.commonDir, proposal.indexPath, scratchRoot,
    ...proposal.paths.map(file => path.join(proposal.root, file.path))])];
  const reservation = reserveEffect(context, { reservationId: proposal.proposalId, kind: "checkpoint", paths: scopes });
  const producer = reservation.register("git-commit", ["host-operation"]);
  let temporary: string | undefined, lock: number | undefined, lockOwned = false, effects = false;
  let commit: string | undefined, tree: string | undefined;
  let outcome: { status: string; diagnostic?: string; closureDiagnostic?: string; [key: string]: unknown } | undefined;
  const lockPath = proposal.indexPath + ".lock";
  const record = (phase: string, body: unknown) => store.enqueue(`git-commit:${proposal.proposalId}`, JSON.stringify(producer.ref), { phase, body });
  const observe = () => {
    let ref: string | undefined, head: string | undefined, indexHash: string | undefined, observationError: string | undefined;
    try { ref = text(proposal.root, ["rev-parse", "--verify", proposal.ref]); head = text(proposal.root, ["rev-parse", "--verify", "HEAD"]); indexHash = bytesHash(proposal.indexPath); }
    catch (error) { observationError = String(error); }
    return { ref, head, indexHash, commit, tree, observationError };
  };
  try {
    producer.enter();
    record("prepared", proposal);
    revalidate();
    // Existing checkpoint exclusion coordinates Pitako writers; index.lock excludes native index writers.
    lock = openSync(lockPath, "wx", 0o600); lockOwned = true;
    revalidate();
    record("effects-starting", { paths: scopes, operations: ["raw blobs", "private index/tree", "commit object", "ref CAS", "real index replacement"] });
    effects = true;
    mkdirSync(scratchRoot, { mode: 0o700 }); temporary = scratchRoot;
    const env = { GIT_INDEX_FILE: path.join(temporary, "index"), GIT_AUTHOR_NAME: proposal.author.name, GIT_AUTHOR_EMAIL: proposal.author.email,
      GIT_COMMITTER_NAME: proposal.author.name, GIT_COMMITTER_EMAIL: proposal.author.email, GIT_AUTHOR_DATE: proposal.date, GIT_COMMITTER_DATE: proposal.date };
    git(proposal.root, ["read-tree", proposal.parent], undefined, env);
    for (const file of proposal.paths) {
      revalidate();
      if (file.bytes === undefined) git(proposal.root, ["update-index", "--force-remove", "--", file.path], undefined, env);
      else {
        const blob = git(proposal.root, ["hash-object", "-w", "--no-filters", "--stdin"], Buffer.from(file.bytes, "base64"), env).toString().trim();
        git(proposal.root, ["update-index", "--add", "--cacheinfo", `${file.mode!.toString(8)},${blob},${file.path}`], undefined, env);
      }
    }
    tree = git(proposal.root, ["write-tree"], undefined, env).toString().trim();
    if (tree === text(proposal.root, ["rev-parse", `${proposal.parent}^{tree}`])) throw new Error("selected paths produce no change");
    revalidate();
    commit = git(proposal.root, ["-c", "commit.gpgSign=false", "commit-tree", tree, "-p", proposal.parent], proposal.message + "\n", env).toString().trim();
    revalidate();
    writeFileSync(lock, readFileSync(env.GIT_INDEX_FILE)); fsyncSync(lock); closeSync(lock); lock = undefined;
    record("ref-updating", { commit, parent: proposal.parent, ref: proposal.ref });
    revalidate();
    git(proposal.root, ["-c", "core.hooksPath=/dev/null", "update-ref", "--no-deref", proposal.ref, commit, proposal.parent]);
    record("ref-updated", observe());
    // Do not overwrite a third-party index change that bypassed index.lock.
    if (bytesHash(proposal.indexPath) !== proposal.indexHash) throw new Error("real index drift after ref update");
    current(context, ctx, issued.sessionId, signal);
    definitionCurrent();
    checkPins(context, proposal);
    if (JSON.stringify(physicalRepository(proposal.root)) !== JSON.stringify({ root: proposal.root, gitDir: proposal.gitDir, commonDir: proposal.commonDir }) ||
        text(proposal.root, ["symbolic-ref", "-q", "HEAD"]) !== proposal.ref ||
        text(proposal.root, ["rev-parse", "--verify", proposal.ref]) !== commit) throw new Error("repository/ref drift after ref update");
    renameSync(lockPath, proposal.indexPath); lockOwned = false;
    const observed = observe();
    if (observed.ref !== commit || observed.head !== commit || observed.indexHash !== bytesHash(env.GIT_INDEX_FILE)) throw new Error("Git final observation mismatch");
    record("completed", observed);
    outcome = { status: "committed", proposalId: proposal.proposalId, observed };
    return outcome;
  } catch (error) {
    outcome = { status: effects ? "partial" : "refused", proposalId: proposal.proposalId, diagnostic: String(error), observed: observe(), replay: "unsupported" };
    try { record("failed", outcome); } catch { /* The returned observation remains explicit if the journal is unavailable. */ }
    return outcome;
  } finally {
    const cleanupDiagnostics: { operation: string; path: string; diagnostic: string }[] = [], retainedPaths: string[] = [];
    if (lock !== undefined) {
      try { closeSync(lock); lock = undefined; }
      catch (error) { cleanupDiagnostics.push({ operation: "close-index-lock", path: lockPath, diagnostic: String(error) }); }
    }
    if (lockOwned) {
      // Preserve the native lock if its descriptor may still be live; scratch cleanup is independent.
      if (lock !== undefined) retainedPaths.push(lockPath);
      else try { rmSync(lockPath); }
      catch (error) { cleanupDiagnostics.push({ operation: "remove-index-lock", path: lockPath, diagnostic: String(error) }); retainedPaths.push(lockPath); }
    }
    if (temporary) {
      try { rmSync(temporary, { recursive: true, force: true }); }
      catch (error) { cleanupDiagnostics.push({ operation: "remove-private-index", path: temporary, diagnostic: String(error) }); retainedPaths.push(temporary); }
    }
    if (cleanupDiagnostics.length && outcome) {
      outcome.status = effects ? "partial" : "refused";
      Object.assign(outcome, { cleanupDiagnostics, retainedPaths, replay: "unsupported" });
    }
    // Synchronous children have settled. Inert artifacts do not keep a writer live, but an uncertain fd does.
    try { producer.observe("host-operation", lock === undefined ? "closed" : "unknown", true); }
    catch (error) {
      if (!outcome) throw error;
      outcome.status = effects ? "partial" : "refused";
      outcome.closureDiagnostic = String(error);
    }
    if (cleanupDiagnostics.length) {
      try { record("cleanup-failed", outcome); } catch { /* Preserve the returned diagnostics if the journal is unavailable. */ }
    }
  }
}

export function registerGitTools(pi: ExtensionAPI) {
  const register = (name: string, schema: typeof inspectSchema | typeof commitSchema, effect: "read" | "git") => {
    let definition: ToolDefinition<any, any>;
    definition = guardDefinition({ name, label: name === "git_inspect" ? "Inspect local Git" : "Propose local commit",
      description: name === "git_inspect" ? "Structured local status, worktree/index diff, bounded log, or actual core.hooksPath. No shell or external Git helpers. Available during planning; logical reads may create Git sidecars. CWD is implicit."
        : "Prepare an exact raw-file local commit proposal and ask foreground native TUI consent. Requires clean real index and compatible pins/policy; no hooks, filters, signatures or publication. Unsupported in RPC/headless. No authorization boolean or Head contribution.",
      parameters: schema,
      async execute(_id, params, signal, _update, ctx) {
        const definitionCurrent = () => {
          const info = pi.getAllTools().find(tool => tool.name === name);
          if (!info || info.parameters !== definition.parameters || realpathSync(info.sourceInfo.path) !== realpathSync(path.join(packageRoot(), "extensions/index.ts")))
            throw new Error("Git definition generation/physical owner unavailable");
        };
        definitionCurrent();
        if (!Value.Check(schema, params)) throw new Error("invalid structured Git input");
        const context = captureCallContext(ctx.cwd, ctx.sessionManager);
        checkCallContext(context);
        if (signal?.aborted) throw new Error("Git cancelled");
        let result: unknown;
        if (name === "git_inspect") result = inspect(ctx.cwd, params as Static<typeof inspectSchema>);
        else {
          const proposal = capture(ctx.cwd, params as CommitInput);
          checkPins(context, proposal);
          const grant = await consent(proposal, context, ctx, definitionCurrent, signal);
          result = executeCommit(grant, context, ctx, definitionCurrent, signal);
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }, effect);
    pi.registerTool(definition);
  };
  register("git_inspect", inspectSchema, "git");
  register("git_commit", commitSchema, "git");
}
