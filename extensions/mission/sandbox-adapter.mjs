import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = "/tmp/pitako/workspace";
let pendingInput = "";
let inputEnded = false;
const inputWaiters = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { pendingInput += chunk; notifyInput(); });
process.stdin.on("end", () => { inputEnded = true; notifyInput(); });
process.stdin.on("error", (error) => { for (const waiter of inputWaiters.splice(0)) waiter.reject(error); });

const request = await readJsonLine();
if (!request || typeof request !== "object" || typeof request.operation !== "string") throw new Error("invalid effect request");
process.stdout.write(`${JSON.stringify({
  kind: "ready", pid: process.pid, namespace: readlinkSync("/proc/self/ns/pid"),
  networkNamespace: readlinkSync("/proc/self/ns/net"),
})}\n`);
if (await readLine() !== "GO") process.exit(94);
process.stdin.destroy();

let receipt;
try {
  receipt = await execute(request);
} catch (error) {
  receipt = {
    kind: "receipt", status: "failed", exitCode: 1, stdout: "",
    stderr: error instanceof Error ? error.message : String(error), paths: [],
    process: { descendantsQuiescent: await reapDescendants() },
  };
}
const quiescent = await reapDescendants();
receipt.process = { ...(receipt.process ?? {}), descendantsQuiescent: quiescent };
process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exitCode = quiescent ? 0 : 95;

async function execute(input) {
  if (input.operation === "write") return runWrite(input);
  if (input.operation === "edit") return runEdit(input);
  if (input.operation === "apply_patch") return runApplyPatch(input);
  throw new Error(`unsupported managed operation: ${input.operation}`);
}

function runWrite(input) {
  const target = checkedTarget(input.path);
  if (typeof input.content !== "string") throw new Error("write content must be text");
  const before = observe(target.relative);
  const parent = path.dirname(target.absolute);
  ensureDirectory(parent);
  const stat = lstatMaybe(target.absolute);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("write target must be a regular file");
  atomicWrite(target.absolute, Buffer.from(input.content), stat ? stat.mode & 0o7777 : 0o644);
  return pathReceipt(target.relative, before);
}

function runEdit(input) {
  const target = checkedTarget(input.path);
  if (typeof input.oldText !== "string" || !input.oldText || typeof input.newText !== "string") throw new Error("edit requires oldText and newText");
  const before = observe(target.relative);
  if (before.kind !== "file") throw new Error("edit target must be an existing regular file");
  const original = readRegularFile(target.absolute);
  const from = Buffer.from(input.oldText);
  const to = Buffer.from(input.newText);
  const index = original.indexOf(from);
  if (index < 0 || original.indexOf(from, index + from.length) >= 0) throw new Error("edit oldText must match exactly once");
  const updated = Buffer.concat([original.subarray(0, index), to, original.subarray(index + from.length)]);
  atomicWrite(target.absolute, updated, before.mode ?? 0o644);
  return pathReceipt(target.relative, before);
}

async function runApplyPatch(input) {
  if (typeof input.patch !== "string" || !input.patch) throw new Error("apply_patch requires patch text");
  const { applyPatch, parseApplyPatch } = await import("pi-codex-tools");
  const targets = parseApplyPatch(input.patch).flatMap((hunk) =>
    hunk.kind === "update" && hunk.moveTo ? [hunk.path, hunk.moveTo] : [hunk.path]);
  const unique = [...new Set(targets)];
  const before = new Map(unique.map((name) => {
    const target = checkedTarget(name, true);
    return [target.relative, observe(target.relative, true)];
  }));
  const result = await applyPatch(input.patch, { cwd: ROOT });
  const paths = unique.map((name) => {
    const relative = checkedTarget(name, true).relative;
    return { path: relative, before: before.get(relative), after: observe(relative, true) };
  });
  return {
    kind: "receipt", status: "completed", exitCode: 0,
    stdout: `Applied patch:\n${result.changes.map((change) =>
      `${change.kind[0].toUpperCase()}${change.kind.slice(1)} ${change.path}${change.moveTo ? ` -> ${change.moveTo}` : ""}`).join("\n")}`,
    stderr: "",
    paths, process: { descendantsQuiescent: false },
  };
}

function pathReceipt(relative, before) {
  return { kind: "receipt", status: "completed", exitCode: 0, stdout: "", stderr: "", paths: [{ path: relative, before, after: observe(relative) }], process: { descendantsQuiescent: false } };
}

function checkedTarget(input, patchTarget = false) {
  if (typeof input !== "string" || !input || input.includes("\\") || input.includes("\0") || path.posix.isAbsolute(input)) {
    throw new Error("managed tool path must be a normalized workspace-relative path");
  }
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) throw new Error("managed tool path contains a forbidden component");
  const normalized = parts.join("/");
  if (!isAllowed(normalized)) throw new Error(`path is outside mission allowedPaths: ${normalized}`);
  let parent = ROOT;
  for (const part of patchTarget ? [] : parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const stat = lstatMaybe(parent);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("managed target has a symlink or missing parent");
  }
  return { relative: normalized, absolute: path.join(ROOT, ...parts) };
}

function isAllowed(relative) {
  return Array.isArray(request.allowedPaths) && request.allowedPaths.some((grant) => {
    if (grant === "." || grant === "*" || grant === "/") return true;
    const subtree = grant.endsWith("/**");
    const base = subtree ? grant.slice(0, -3) : grant;
    return relative === base || (subtree && relative.startsWith(`${base}/`));
  });
}

function observe(relative, patchTarget = false) {
  const target = checkedTarget(relative, patchTarget);
  const stat = lstatMaybe(target.absolute);
  if (!stat) return { kind: "missing", mode: null, hash: null };
  if (stat.isSymbolicLink()) return { kind: "symlink", mode: stat.mode & 0o7777, hash: sha256(Buffer.from(readlinkSync(target.absolute))) };
  if (stat.isDirectory()) return { kind: "directory", mode: stat.mode & 0o7777, hash: null };
  if (!stat.isFile()) throw new Error("special files cannot be observed as mission effects");
  return { kind: "file", mode: stat.mode & 0o7777, hash: sha256(readRegularFile(target.absolute, stat)) };
}

function ensureDirectory(directory) {
  const relative = path.relative(ROOT, directory);
  if (!relative || relative === ".") return;
  let cursor = ROOT;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    const stat = lstatMaybe(cursor);
    if (!stat) mkdirSync(cursor, { mode: 0o755 });
    else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("write parent is not a real directory");
  }
}

function atomicWrite(target, bytes, mode) {
  const parent = path.dirname(target);
  const temp = path.join(parent, `.pitako-effect-${randomUUID()}`);
  const fd = openSync(temp, "wx", mode);
  try {
    writeFileSync(fd, bytes);
    chmodSync(temp, mode);
    fsyncSync(fd);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort cleanup */ }
    throw error;
  } finally { closeSync(fd); }
  renameSync(temp, target);
  const dirfd = openSync(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
}

function readRegularFile(target, expected) {
  const before = expected ?? lstatSync(target);
  const fd = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("managed file changed while reading");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (bytes.length !== after.size || after.dev !== stat.dev || after.ino !== stat.ino) throw new Error("managed file changed while reading");
    return bytes;
  } finally { closeSync(fd); }
}

async function reapDescendants() {
  for (let turn = 0; turn < 20; turn += 1) {
    const children = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number).filter((pid) => pid !== 1 && pid !== process.pid);
    if (children.length === 0) return true;
    for (const pid of children) {
      try { process.kill(pid, "SIGKILL"); } catch { /* process exited */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number).every((pid) => pid === 1 || pid === process.pid);
}

async function readJsonLine() {
  const line = await readLine();
  try { return JSON.parse(line); } catch (error) { throw new Error(`invalid effect request JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function notifyInput() {
  for (const waiter of inputWaiters.splice(0)) waiter.resolve();
}

async function readLine() {
  for (;;) {
    const end = pendingInput.indexOf("\n");
    if (end >= 0) {
      const line = pendingInput.slice(0, end).replace(/\r$/, "");
      pendingInput = pendingInput.slice(end + 1);
      return line;
    }
    if (inputEnded) return pendingInput;
    await new Promise((resolve, reject) => inputWaiters.push({ resolve, reject }));
  }
}

function lstatMaybe(target) {
  try { return lstatSync(target); } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
