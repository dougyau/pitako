import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  accessSync, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SANDBOX_ROOT = "/tmp/pitako";
const WORKSPACE_MOUNT = `${SANDBOX_ROOT}/workspace`;
const PRODUCT_MOUNT = `${SANDBOX_ROOT}/product`;
const SOURCE_MOUNT = `${SANDBOX_ROOT}/source`;
const STORE_MOUNT = `${SANDBOX_ROOT}/store`;
const SOURCE_GIT_MOUNT = `${SANDBOX_ROOT}/source-git`;
const UUID = /^[0-9a-f-]{36}$/i;

export interface ManifestPath {
  path: string;
  kind: "file" | "symlink" | "directory" | "missing";
  mode: number | null;
  hash: string | null;
}

export interface WorkspaceManifest {
  schemaVersion: 1;
  head: string;
  branch: string | null;
  indexHash: string;
  indexEntries: Array<{ path: string; mode: string; objectId: string; stage: number }>;
  statusHash: string;
  tracked: ManifestPath[];
  untracked: ManifestPath[];
  diffHash: string;
  cachedDiffHash: string;
  hash: string;
}

export interface WorkspaceImageFile {
  path: string;
  kind: ManifestPath["kind"];
  mode: number | null;
  bytes: Buffer | null;
}

export interface WorkspaceImage {
  manifest: WorkspaceManifest;
  files: WorkspaceImageFile[];
}

export interface MissionWorkspace {
  missionId: string;
  attemptId: string;
  sourceRoot: string;
  sourceGitDir: string;
  storeRoot: string;
  allowedPaths: string[];
  candidateId: string;
  candidateRoot: string;
  candidateGitDir: string;
  candidateArenaRoot: string;
  candidateArenaIdentity: string;
  candidateIdentity: string;
  candidateGitIdentity: string;
  otherCandidates: string[];
  productRoot: string;
  adapterScript: string;
  manifest: WorkspaceManifest;
  bwrapPath: string;
  runtimeNode: string;
  runtimeBun?: string;
  containmentProof?: ContainmentProof;
  quarantined: boolean;
}

export interface CandidateRegistration {
  missionId: string;
  repositoryId: string;
  attemptId: string;
  owner: ProcessIdentity;
  candidateId: string;
  root: string;
  rootIdentity: string;
  gitDir: string;
  gitIdentity: string;
  arenaRoot: string;
  arenaIdentity: string;
  sourceManifestHash: string;
}

export interface ContainmentProof {
  readonly id: string;
  readonly bwrapVersion: string;
  readonly candidateIdentity: string;
  readonly candidateGitIdentity: string;
  readonly pidNamespace: string;
  readonly networkNamespace: string;
  readonly sourceReadOnly: true;
  readonly storeReadOnly: true;
  readonly candidateGitReadOnly: true;
  readonly networkDisabled: true;
  readonly privateHomeAndTemp: true;
}

const validProofs = new WeakSet<object>();
const dependencyBackings = new WeakMap<MissionWorkspace, { root: string; identity: string }>();

export function hasContainmentProof(workspace: MissionWorkspace): workspace is MissionWorkspace & { containmentProof: ContainmentProof } {
  return Boolean(workspace.containmentProof && validProofs.has(workspace.containmentProof) && !workspace.quarantined);
}

export function createMissionWorkspace(input: {
  missionId: string;
  attemptId: string;
  sourceRoot: string;
  storeRoot: string;
  candidateParent: string;
  otherCandidates?: string[];
  allowedPaths?: string[];
  productRoot?: string;
  bwrapPath?: string;
}): MissionWorkspace {
  if (process.platform !== "linux") throw new Error(`managed workspace containment is unsupported on ${process.platform}; no writer launched`);
  if (!UUID.test(input.missionId) || !UUID.test(input.attemptId)) throw new Error("mission and attempt ids must be UUIDs");
  const sourceRoot = verifiedGitRoot(input.sourceRoot);
  const sourceGitDir = git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const storeRoot = realpathSync(input.storeRoot);
  const candidateParent = ensurePrivateDirectory(input.candidateParent);
  const productRoot = realpathSync(input.productRoot ?? PRODUCT_ROOT);
  const otherCandidates = (input.otherCandidates ?? []).map((candidate) => realpathSync(candidate));
  const nestedCandidates = otherCandidates.filter((root) => isWithin(candidateParent, path.resolve(root)) && path.resolve(root) !== candidateParent);
  if (otherCandidates.some((root) => path.resolve(root) === candidateParent)) throw new Error("candidate arena cannot be exposed as another candidate");
  const externalCandidates = otherCandidates.filter((root) => !nestedCandidates.includes(root));
  assertDistinctRoots([sourceRoot, storeRoot, candidateParent, productRoot, ...externalCandidates]);
  assertDistinctRoots([sourceRoot, storeRoot, productRoot, ...otherCandidates]);
  if (sourceRoot === productRoot) {
    // The tool adapter is read-only-mounted separately; this alias is intentional.
  }

  const manifest = createWorkspaceManifest(sourceRoot);
  const candidateRoot = mkdtempSync(path.join(candidateParent, `${input.missionId}-${input.attemptId}-`));
  chmodSync(candidateRoot, 0o700);
  try {
    git(sourceRoot, ["-c", "core.hooksPath=/dev/null", "clone", "--no-hardlinks", "--no-local", "--no-checkout", "--", sourceRoot, candidateRoot]);
    git(candidateRoot, ["-c", "core.hooksPath=/dev/null", "checkout", "--force", ...(manifest.branch ? ["-B", manifest.branch] : ["--detach"]), manifest.head]);
    try { git(candidateRoot, ["remote", "remove", "origin"]); } catch { /* clone may not create a remote */ }
    if (gitlinks(manifest.indexEntries).length) throw new Error("managed candidates with Git submodules are not supported");
    copyIndexObjects(sourceRoot, candidateRoot, manifest.indexEntries);
    for (const entry of [...manifest.tracked, ...manifest.untracked]) copyInputPath(sourceRoot, candidateRoot, entry.path);
    const candidateInputs = [...manifest.tracked, ...manifest.untracked].map(({ path: name }) => fileManifest(candidateRoot, name));
    if (JSON.stringify(candidateInputs) !== JSON.stringify([...manifest.tracked, ...manifest.untracked])) {
      throw new Error("candidate input files differ from the source manifest; candidate quarantined");
    }
    const candidateGitDir = realpathSync(path.join(candidateRoot, ".git"));
    if (candidateGitDir !== path.join(candidateRoot, ".git") || !lstatSync(candidateGitDir).isDirectory()) {
      throw new Error("candidate Git directory is not private to the candidate");
    }
    if (existsSync(path.join(candidateGitDir, "commondir")) || existsSync(path.join(candidateGitDir, "objects", "info", "alternates"))) {
      throw new Error("candidate Git metadata contains a linked common directory or alternate object store");
    }
    const candidateTop = git(candidateRoot, ["rev-parse", "--show-toplevel"]);
    const candidateCommon = git(candidateRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (candidateTop !== candidateRoot || candidateCommon !== candidateGitDir) throw new Error("candidate Git discovery escaped its private root");
    assertNoSharedInodes(sourceRoot, sourceGitDir, candidateRoot, [...manifest.tracked, ...manifest.untracked]);
    if (createWorkspaceManifest(sourceRoot).hash !== manifest.hash) throw new Error("source changed while candidate was being constructed; candidate quarantined");
    const workspace: MissionWorkspace = {
      missionId: input.missionId,
      attemptId: input.attemptId,
      sourceRoot,
      sourceGitDir,
      storeRoot,
      allowedPaths: [...new Set((input.allowedPaths ?? []).map(normalizeAllowedPath))],
      candidateId: `${input.missionId}:${input.attemptId}`,
      candidateRoot,
      candidateGitDir,
      candidateArenaRoot: candidateParent,
      candidateArenaIdentity: identity(candidateParent),
      candidateIdentity: identity(candidateRoot),
      candidateGitIdentity: identity(candidateGitDir),
      otherCandidates,
      productRoot,
      adapterScript: path.join(productRoot, "extensions/mission/sandbox-adapter.mjs"),
      manifest,
      bwrapPath: resolveBwrap(input.bwrapPath),
      runtimeNode: resolveRuntime("node"),
      runtimeBun: optionalRuntime("bun"),
      quarantined: false,
    };
    const dependencies = path.join(sourceRoot, "node_modules");
    if (existsSync(dependencies) && !existsSync(path.join(candidateRoot, "node_modules"))) {
      const state = lstatSync(dependencies);
      if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("source dependency backing must be a physical directory");
      dependencyBackings.set(workspace, { root: dependencies, identity: identity(dependencies) });
    }
    return workspace;
  } catch (error) {
    // Keep failed candidates for reconciliation. Never reuse this writable path.
    try { writeFileSync(path.join(candidateRoot, ".pitako-quarantined"), String(error), { mode: 0o600 }); } catch { /* candidate may already be inaccessible */ }
    throw error;
  }
}

export async function preflightContainment(workspace: MissionWorkspace): Promise<ContainmentProof> {
  assertWorkspaceIdentity(workspace);
  const version = command(workspace.bwrapPath, ["--version"]);
  if (!/^bubblewrap\s+\d/.test(version)) throw new Error(`unsupported bwrap implementation: ${version}`);
  syscallTable();
  const pidNamespace = namespaceId("pid");
  const networkNamespace = namespaceId("net");
  const marker = `.pitako-preflight-${randomUUID()}`;
  const sourceMarkerHost = path.join(workspace.sourceRoot, marker);
  const productMarkerHost = path.join(workspace.productRoot, marker);
  const storeMarkerHost = path.join(workspace.storeRoot, marker);
  const otherMarkersHost = workspace.otherCandidates.map((candidate, index) => path.join(candidate, `${marker}-${index}`));
  const candidateProbe = `${WORKSPACE_MOUNT}/${marker}`;
  const sourceMarker = `${SOURCE_MOUNT}/${marker}`;
  const productMarker = `${PRODUCT_MOUNT}/${marker}`;
  const sourceGitMarker = `${SOURCE_GIT_MOUNT}/${marker}`;
  const storeMarker = `${STORE_MOUNT}/${marker}`;
  const otherMarkers = workspace.otherCandidates.map((_, index) => `${SANDBOX_ROOT}/other-${index}/${marker}-${index}`);
  const paths = [sourceMarkerHost, productMarkerHost, path.join(workspace.sourceGitDir, marker), storeMarkerHost, ...otherMarkersHost];
  for (const target of [workspace.sourceRoot, workspace.productRoot, workspace.sourceGitDir, workspace.storeRoot, ...workspace.otherCandidates]) {
    try { accessSync(target, fsConstants.W_OK); } catch { throw new Error(`cannot prove read-only mount for host-writable path ${target}`); }
  }
  const shell = [
    "set -eu",
    `printf ok > ${shellQuote(candidateProbe)}`,
    `test -f ${shellQuote(candidateProbe)}`,
    `if printf bad > ${shellQuote(sourceMarker)} 2>/dev/null; then rm -f ${shellQuote(sourceMarker)}; exit 81; fi`,
    `if printf bad > ${shellQuote(productMarker)} 2>/dev/null; then rm -f ${shellQuote(productMarker)}; exit 80; fi`,
    `if printf bad > ${shellQuote(sourceGitMarker)} 2>/dev/null; then rm -f ${shellQuote(sourceGitMarker)}; exit 82; fi`,
    `if printf bad > ${shellQuote(storeMarker)} 2>/dev/null; then rm -f ${shellQuote(storeMarker)}; exit 84; fi`,
    ...otherMarkers.map((target, index) => `if printf bad > ${shellQuote(target)} 2>/dev/null; then rm -f ${shellQuote(target)}; exit ${83 + index}; fi`),
    `if printf bad > ${shellQuote(`${WORKSPACE_MOUNT}/.git/${marker}`)} 2>/dev/null; then rm -f ${shellQuote(`${WORKSPACE_MOUNT}/.git/${marker}`)}; exit 90; fi`,
    `test "$(readlink /proc/self/ns/pid)" != '${pidNamespace}'`,
    `test "$(readlink /proc/self/ns/net)" != '${networkNamespace}'`,
    `network_error=$(/bin/bash --noprofile --norc -c 'exec 3<>/dev/tcp/127.0.0.1/1' 2>&1 || true); case "$network_error" in *'Operation not permitted'*) ;; *) exit 91 ;; esac`,
    `test ! -e ${shellQuote(path.join(os.userInfo().homedir, ".ssh"))}`,
    `test -d '${WORKSPACE_MOUNT}' && test -d '${PRODUCT_MOUNT}' && test -d '${SOURCE_MOUNT}' && test -d '${SOURCE_GIT_MOUNT}' && test -d '${STORE_MOUNT}'`,
  ].join("; ");
  let result: ReturnType<typeof spawnSync>;
  const seccompFd = openSeccompFilter();
  let plan: { args: string[]; descriptors: number[] } | undefined;
  try {
    plan = baseBwrapPlan(workspace, ["."]);
    result = spawnSync(workspace.bwrapPath, [
      ...plan.args, "--chdir", WORKSPACE_MOUNT, "--", "/bin/sh", "-c", shell,
    ], { encoding: "utf8", timeout: 15_000, env: cleanLauncherEnvironment(), stdio: ["ignore", "pipe", "pipe", seccompFd, ...plan.descriptors] });
  } finally {
    closeSync(seccompFd);
    for (const fd of plan?.descriptors ?? []) closeSync(fd);
    for (const target of [...paths, path.join(workspace.candidateRoot, marker)])
      try { rmSync(target, { force: true }); } catch { /* only preflight markers */ }
  }
  if (result.error || result.status !== 0) {
    workspace.quarantined = true;
    throw new Error(`bwrap containment preflight failed; no writer launched: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
  const proof: ContainmentProof = Object.freeze({
    id: randomUUID(), bwrapVersion: version, candidateIdentity: workspace.candidateIdentity,
    candidateGitIdentity: workspace.candidateGitIdentity, pidNamespace, networkNamespace,
    sourceReadOnly: true, storeReadOnly: true, candidateGitReadOnly: true,
    networkDisabled: true, privateHomeAndTemp: true,
  });
  validProofs.add(proof);
  workspace.containmentProof = proof;
  return proof;
}

export function sandboxProductPath(workspace: MissionWorkspace, target: string): string {
  const resolved = path.resolve(target);
  if (!isWithin(workspace.productRoot, resolved)) throw new Error("contained product target is outside the read-only product mount");
  const relative = path.relative(workspace.productRoot, resolved).split(path.sep).join("/");
  return relative ? `${PRODUCT_MOUNT}/${relative}` : PRODUCT_MOUNT;
}

export function spawnContained(workspace: MissionWorkspace, commandName: string, args: string[], options: {
  signal?: AbortSignal;
  timeoutMs?: number;
  writablePaths?: string[];
  verificationSubject?: boolean;
} = {}) {
  const commandPath = commandName === "node" ? sandboxRuntimePath(workspace.runtimeNode)
    : commandName === "bun" && workspace.runtimeBun
      ? (path.basename(path.dirname(workspace.runtimeBun)) === "bin"
        ? `${SANDBOX_ROOT}/runtime/bun-prefix/bin/${path.basename(workspace.runtimeBun)}`
        : `${SANDBOX_ROOT}/runtime/bun`)
      : commandName;
  if (!commandPath) throw new Error(`contained runtime is unavailable: ${commandName}`);
  const seccompFd = openSeccompFilter();
  let plan: { args: string[]; descriptors: number[] } | undefined;
  try {
    plan = baseBwrapPlan(workspace, options.writablePaths ?? workspace.allowedPaths, options.verificationSubject);
    return spawn(workspace.bwrapPath, [
      ...plan.args, "--chdir", WORKSPACE_MOUNT, "--", commandPath, ...args,
    ], {
      stdio: ["pipe", "pipe", "pipe", seccompFd, ...plan.descriptors],
      env: cleanLauncherEnvironment(),
      signal: options.signal,
    });
  } finally {
    closeSync(seccompFd);
    for (const fd of plan?.descriptors ?? []) closeSync(fd);
  }
}

export function quarantineWorkspace(workspace: MissionWorkspace, reason: string): string {
  workspace.quarantined = true;
  const quarantine = `${workspace.candidateRoot}.quarantine-${randomUUID()}`;
  try {
    writeFileSync(path.join(workspace.candidateRoot, ".pitako-quarantine-reason"), reason.slice(0, 2048), { mode: 0o600 });
    return quarantine;
  } catch {
    return workspace.candidateRoot;
  }
}

export function quarantineCandidateRoot(root: string, sourceRoot: string, identity: string, gitIdentity: string, reason: string): void {
  const candidate = verifyPrivateCandidate(root, sourceRoot);
  if (candidate.identity !== identity || candidate.gitIdentity !== gitIdentity) throw new Error("candidate identity changed before quarantine");
  const marker = path.join(candidate.root, ".pitako-quarantine-reason");
  let fd: number;
  try {
    fd = openSync(marker, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const state = lstatSync(marker);
    if (!state.isFile() || state.isSymbolicLink()) throw new Error("candidate quarantine marker is not a regular file");
    return;
  }
  try { writeFileSync(fd, reason.slice(0, 2048)); fsyncSync(fd); }
  finally { closeSync(fd); }
}

export interface ProcessIdentity {
  hostId: string;
  bootId: string;
  pid: number;
  birthTicks: number;
  runtimeId: string;
  epoch: number;
}

export function currentProcessIdentity(runtimeId: string, epoch: number): ProcessIdentity {
  const pid = process.pid;
  return {
    hostId: hostIdentity(),
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    pid,
    birthTicks: processBirthTicks(pid),
    runtimeId,
    epoch,
  };
}

export function ownerProcessState(owner: ProcessIdentity): "live" | "dead" | "unknown" {
  if (owner.hostId !== hostIdentity()) return "unknown";
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (owner.bootId !== bootId) return "dead";
  try {
    return processBirthTicks(owner.pid) === owner.birthTicks ? "live" : "dead";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
    return "unknown";
  }
}

export function processBirthTicks(pid: number): number {
  return processStat(pid).birthTicks;
}

export function processParentPid(pid: number): number {
  return processStat(pid).parentPid;
}

export function processIsDescendantOf(pid: number, ancestorPid: number): boolean {
  let current = pid;
  const seen = new Set<number>();
  for (let depth = 0; depth < 128 && current > 1 && !seen.has(current); depth += 1) {
    if (current === ancestorPid) return true;
    seen.add(current);
    current = processParentPid(current);
  }
  return current === ancestorPid;
}

export function processNamespaceId(pid: number): string {
  return readlinkSync(`/proc/${pid}/ns/pid`);
}

export function readOwnedNamespaceInit(
  namespace: string,
  root: { pid: number; birthTicks: number; parentPid: number },
  launcher: ProcessIdentity,
): Pick<ProcessIdentity, "pid" | "birthTicks"> {
  if (ownerProcessState(launcher) !== "live") throw new Error("namespace launcher identity is unproved");
  const launcherBefore = processStat(launcher.pid);
  const before = processStat(root.pid);
  const namespaceBefore = processNamespaceId(root.pid);
  const status = readFileSync(`/proc/${root.pid}/status`, "utf8");
  const ids = /^NSpid:\s+([\d \t]+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number);
  const namespaceAfter = processNamespaceId(root.pid);
  const after = processStat(root.pid);
  const launcherAfter = processStat(launcher.pid);
  if (!ids || ids.length < 2 || ids[0] !== root.pid || ids.at(-1) !== 1 ||
      namespaceBefore !== namespace || namespaceAfter !== namespace || namespace === processNamespaceId(launcher.pid) ||
      before.birthTicks !== root.birthTicks || after.birthTicks !== root.birthTicks ||
      before.parentPid !== launcher.pid || after.parentPid !== launcher.pid || root.parentPid !== launcher.pid ||
      launcherBefore.birthTicks !== launcher.birthTicks || launcherAfter.birthTicks !== launcher.birthTicks ||
      launcherBefore.parentPid !== launcherAfter.parentPid || ownerProcessState(launcher) !== "live") {
    throw new Error("owned namespace PID 1 identity is unproved");
  }
  return { pid: root.pid, birthTicks: root.birthTicks };
}

export function processesInNamespace(namespace: string): Array<{ pid: number; birthTicks: number; parentPid: number }> {
  const processes: Array<{ pid: number; birthTicks: number; parentPid: number }> = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const before = processStat(pid);
      if (processNamespaceId(pid) !== namespace) continue;
      const after = processStat(pid);
      if (before.birthTicks === after.birthTicks && before.parentPid === after.parentPid) {
        processes.push({ pid, ...after });
      }
    } catch { /* process exited during inventory */ }
  }
  return processes;
}

function processStat(pid: number): { birthTicks: number; parentPid: number } {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error(`invalid /proc/${pid}/stat`);
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  const birthTicks = Number(fields[19]);
  if (!Number.isSafeInteger(parentPid) || parentPid < 0 || !Number.isSafeInteger(birthTicks) || birthTicks < 0) {
    throw new Error(`invalid process identity for PID ${pid}`);
  }
  return { birthTicks, parentPid };
}

export function captureWorkspacePaths(root: string, includeRootDependencies = false, files: ManifestPath[] = []): ManifestPath[] {
  const visit = (relative = "") => {
    const directory = relative ? path.join(root, relative) : root;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!relative && (entry.name === ".git" || entry.name === "node_modules" && !includeRootDependencies)) continue;
      if (files.length >= 20_000) throw new Error("candidate exceeds effect observation file limit");
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const item = fileManifest(root, name);
      files.push(item);
      if (item.kind === "directory") visit(name);
    }
  };
  visit();
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function captureWorkspacePath(root: string, relative: string): ManifestPath {
  return fileManifest(root, safeGitPath(relative));
}

export function captureWorkspaceImage(root: string): WorkspaceImage {
  const manifest = createWorkspaceManifest(root);
  const files = [...manifest.tracked, ...manifest.untracked]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry): WorkspaceImageFile => {
      const file = path.join(root, entry.path);
      return {
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        bytes: entry.kind === "file" ? readFileSync(file) : entry.kind === "symlink" ? Buffer.from(readlinkSync(file)) : null,
      };
    });
  return { manifest, files };
}

export function filterWorkspaceImage(image: WorkspaceImage, allowedPaths: readonly string[]): WorkspaceImage {
  return {
    manifest: image.manifest,
    files: image.files.filter(({ path: name }) => allowedPaths.some((allowed) => {
      const root = allowed === "." || allowed === "*" || allowed === "/" ? "." : allowed.replaceAll("\\", "/").replace(/\/\*\*$/, "");
      return root === "." || name === root || name.startsWith(`${root}/`);
    })),
  };
}

export function restoreWorkspaceImage(workspace: MissionWorkspace, files: readonly WorkspaceImageFile[]): void {
  assertWorkspaceIdentity(workspace);
  applyWorkspaceImageToRoot(workspace.candidateRoot, files);
  if (files.some(({ path: name, kind }) => kind !== "missing" && (name === "node_modules" || name.startsWith("node_modules/")))) {
    dependencyBackings.delete(workspace);
  }
}

export function applyWorkspaceImageToRoot(root: string, files: readonly WorkspaceImageFile[]): void {
  const candidateRoot = realpathSync(root);
  const seen = new Set<string>();
  for (const entry of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    safeGitPath(entry.path);
    if (seen.has(entry.path)) throw new Error(`workspace image contains duplicate path ${entry.path}`);
    seen.add(entry.path);
    const destination = path.join(candidateRoot, entry.path);
    assertSafePath(candidateRoot, entry.path);
    if (entry.kind === "missing") {
      rmSync(destination, { recursive: true, force: true });
      continue;
    }
    if (entry.kind === "directory") {
      rmSync(destination, { recursive: true, force: true });
      ensureParentDirectories(candidateRoot, entry.path);
      mkdirSync(destination, { recursive: false, mode: entry.mode ?? 0o700 });
      continue;
    }
    if (!entry.bytes) throw new Error(`workspace image has no bytes for ${entry.path}`);
    ensureParentDirectories(candidateRoot, path.dirname(entry.path));
    rmSync(destination, { recursive: true, force: true });
    if (entry.kind === "symlink") {
      symlinkSync(entry.bytes.toString("utf8"), destination);
    } else {
      const fd = openSync(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, entry.mode ?? 0o600);
      try {
        writeFileSync(fd, entry.bytes);
        chmodSync(destination, entry.mode ?? 0o600);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
  }
}

export function registerCandidateWorkspace(
  workspace: MissionWorkspace,
  identity: { repositoryId: string; owner: ProcessIdentity },
): CandidateRegistration {
  return {
    missionId: workspace.missionId,
    repositoryId: identity.repositoryId,
    attemptId: workspace.attemptId,
    owner: identity.owner,
    candidateId: workspace.candidateId,
    root: workspace.candidateRoot,
    rootIdentity: workspace.candidateIdentity,
    gitDir: workspace.candidateGitDir,
    gitIdentity: workspace.candidateGitIdentity,
    arenaRoot: workspace.candidateArenaRoot,
    arenaIdentity: workspace.candidateArenaIdentity,
    sourceManifestHash: workspace.manifest.hash,
  };
}

export function discoverPrivateCandidate(registration: CandidateRegistration, sourceRoot: string): string | undefined {
  try {
    if (registration.owner.hostId !== hostIdentity()) return undefined;
    if (realpathSync(registration.arenaRoot) !== registration.arenaRoot || identity(registration.arenaRoot) !== registration.arenaIdentity) return undefined;
    const matches = readdirSync(registration.arenaRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const candidateRoot = path.join(registration.arenaRoot, entry.name);
        try {
          const candidate = verifyPrivateCandidate(candidateRoot, sourceRoot);
          return candidate.identity === registration.rootIdentity && candidate.gitIdentity === registration.gitIdentity
            ? [candidate.root] : [];
        } catch { return []; }
      });
    return matches.length === 1 ? matches[0] : undefined;
  } catch { return undefined; }
}

export function verifyPrivateCandidate(rootInput: string, sourceRoot?: string): { root: string; gitDir: string; identity: string; gitIdentity: string } {
  const root = realpathSync(rootInput);
  const gitDir = realpathSync(path.join(root, ".git"));
  if (!lstatSync(gitDir).isDirectory() || existsSync(path.join(gitDir, "commondir")) || existsSync(path.join(gitDir, "objects", "info", "alternates"))) {
    throw new Error("candidate Git metadata is not private");
  }
  if (git(root, ["rev-parse", "--show-toplevel"]) !== root ||
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== gitDir) {
    throw new Error("candidate Git discovery escaped its private root");
  }
  if (sourceRoot) {
    const manifest = createWorkspaceManifest(root);
    const sourceGitDir = git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    assertNoSharedInodes(sourceRoot, sourceGitDir, root, [...manifest.tracked, ...manifest.untracked]);
  }
  return { root, gitDir, identity: identity(root), gitIdentity: identity(gitDir) };
}

function createWorkspaceManifest(root: string): WorkspaceManifest {
  const indexOutput = gitBytes(root, ["ls-files", "--stage", "-z"]);
  const indexEntries = nulRecords(indexOutput).map((record) => {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("Git index returned malformed stage entry");
    const head = decodeUtf8(record.subarray(0, tab));
    const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d)$/.exec(head);
    if (!match) throw new Error("Git index returned unsupported entry");
    return { mode: match[1]!, objectId: match[2]!, stage: Number(match[3]), path: safeGitPath(decodeUtf8(record.subarray(tab + 1))) };
  });
  const trackedPaths = [...new Set(indexEntries.map(({ path: name }) => name))].sort();
  const untrackedPaths = nulRecords(gitBytes(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .map((record) => safeGitPath(decodeUtf8(record))).sort();
  for (const name of untrackedPaths) {
    const status = safeLstatAt(root, name);
    if (status?.isDirectory()) throw new Error(`untracked nested repository or directory input is unsupported: ${name}`);
  }
  const tracked = trackedPaths.map((name) => fileManifest(root, name));
  const untracked = untrackedPaths.map((name) => fileManifest(root, name));
  const indexPath = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const diff = gitBytes(root, ["diff", "--binary", "HEAD"]);
  const cachedDiff = gitBytes(root, ["diff", "--binary", "--cached"]);
  const status = gitBytes(root, ["status", "--porcelain=v2", "--untracked-files=all", "-z"]);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const body = {
    schemaVersion: 1 as const,
    head: git(root, ["rev-parse", "HEAD"]),
    branch: branch === "HEAD" ? null : branch,
    indexHash: hash(readFileSync(indexPath)),
    indexEntries,
    statusHash: hash(status),
    tracked,
    untracked,
    diffHash: hash(diff),
    cachedDiffHash: hash(cachedDiff),
  };
  return { ...body, hash: hash(Buffer.from(JSON.stringify(body))) };
}

function fileManifest(root: string, name: string): ManifestPath {
  const file = path.join(root, name);
  const stat = safeLstatAt(root, name);
  if (!stat) return { path: name, kind: "missing", mode: null, hash: null };
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) return { path: name, kind: "symlink", mode, hash: hash(Buffer.from(readlinkSync(file))) };
  if (stat.isDirectory()) return { path: name, kind: "directory", mode, hash: null };
  if (!stat.isFile()) throw new Error(`unsupported special file in workspace input: ${name}`);
  return { path: name, kind: "file", mode, hash: hash(readStableFile(root, name, stat)) };
}

function copyInputPath(source: string, candidate: string, name: string): void {
  const from = path.join(source, name);
  const to = path.join(candidate, name);
  assertSafePath(candidate, name);
  const stat = safeLstatAt(source, name);
  if (!stat) {
    rmSync(to, { recursive: true, force: true });
    return;
  }
  if (stat.isDirectory()) throw new Error(`directory input is unsupported: ${name}`);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`special input is unsupported: ${name}`);
  ensureParentDirectories(candidate, path.dirname(name));
  rmSync(to, { recursive: true, force: true });
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else {
    const bytes = readStableFile(source, name, stat);
    const fd = openSync(to, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, stat.mode & 0o7777);
    try {
      writeFileSync(fd, bytes);
      chmodSync(to, stat.mode & 0o7777);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
}

function assertNoSharedInodes(source: string, sourceGitDir: string, candidate: string, paths: ManifestPath[]): void {
  for (const { path: name } of paths) {
    const from = lstatMaybe(path.join(source, name));
    const to = lstatMaybe(path.join(candidate, name));
    if (from?.isFile() && to?.isFile() && from.dev === to.dev && from.ino === to.ino) {
      throw new Error(`candidate contains a source hard link: ${name}`);
    }
  }
  const objectSource = path.join(sourceGitDir, "objects");
  const objectCandidate = path.join(candidate, ".git", "objects");
  if (existsSync(objectSource) && existsSync(objectCandidate)) {
    const visit = (directory: string, relative = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = relative ? path.join(relative, entry.name) : entry.name;
        const from = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(from, child);
        else {
          const a = lstatMaybe(from);
          const b = lstatMaybe(path.join(objectCandidate, child));
          if (a?.isFile() && b?.isFile() && a.dev === b.dev && a.ino === b.ino) throw new Error("candidate Git objects share source hard links");
        }
      }
    };
    visit(objectSource);
  }
}

function baseBwrapPlan(workspace: MissionWorkspace, writablePaths: string[], verificationSubject = false): { args: string[]; descriptors: number[] } {
  assertWorkspaceIdentity(workspace);
  const backing = dependencyBackings.get(workspace);
  if (backing) {
    const state = lstatSync(backing.root);
    if (!state.isDirectory() || state.isSymbolicLink() || identity(backing.root) !== backing.identity) {
      throw new Error("source dependency backing identity changed");
    }
    const mountpoint = path.join(workspace.candidateRoot, "node_modules");
    mkdirSync(mountpoint, { recursive: true });
    const target = lstatSync(mountpoint);
    if (!target.isDirectory() || target.isSymbolicLink() || readdirSync(mountpoint).length) {
      throw new Error("source dependency mountpoint contains unexpected candidate content");
    }
  }
  const args = [
    "--tmpfs", "/",
    "--dir", "/bin", "--dir", "/sbin", "--dir", "/usr", "--dir", "/lib", "--dir", "/lib64",
    "--dir", "/etc", "--dir", "/tmp", "--dir", "/home", "--dir", "/root", "--dir", "/run",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/sbin", "/sbin",
    "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
    "--unshare-user", "--unshare-pid", "--die-with-parent", "--unshare-net", "--disable-userns", "--assert-userns-disabled", "--seccomp", "3",
    "--dev", "/dev", "--proc", "/proc",
    "--tmpfs", "/tmp", "--tmpfs", "/home", "--tmpfs", "/root", "--tmpfs", "/run",
    "--dir", "/tmp/pitako",
    "--dir", PRODUCT_MOUNT, "--dir", SOURCE_MOUNT, "--dir", STORE_MOUNT, "--dir", SOURCE_GIT_MOUNT,
    "--dir", WORKSPACE_MOUNT, "--dir", `${SANDBOX_ROOT}/runtime`,
    "--ro-bind", verificationSubject && workspace.productRoot === workspace.sourceRoot ? workspace.candidateRoot : workspace.productRoot, PRODUCT_MOUNT,
    "--ro-bind", verificationSubject ? workspace.candidateRoot : workspace.sourceRoot, SOURCE_MOUNT,
    "--ro-bind", verificationSubject ? workspace.candidateGitDir : workspace.sourceGitDir, SOURCE_GIT_MOUNT,
    "--ro-bind", workspace.storeRoot, STORE_MOUNT,
    "--ro-bind", workspace.candidateRoot, WORKSPACE_MOUNT,
  ];
  const descriptors: number[] = [];
  try {
    for (const grant of writablePaths) {
      const target = writableMountTarget(workspace, grant);
      const fd = openSync(target.hostPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      descriptors.push(fd);
      const opened = fstatSync(fd);
      const observed = lstatSync(target.hostPath);
      if (opened.dev !== observed.dev || opened.ino !== observed.ino || !observed.isDirectory() || observed.isSymbolicLink()) {
        throw new Error(`managed write mount changed during setup: ${grant}`);
      }
      args.push("--bind-fd", String(3 + descriptors.length), target.sandboxPath);
    }
  } catch (error) {
    for (const fd of descriptors) closeSync(fd);
    throw error;
  }
  args.push(
    "--ro-bind", workspace.candidateGitDir, `${WORKSPACE_MOUNT}/.git`,
    "--ro-bind", runtimePrefix(workspace.runtimeNode), `${SANDBOX_ROOT}/runtime/node-prefix`,
    "--ro-bind", workspace.runtimeNode, `${SANDBOX_ROOT}/runtime/node`,
    "--clearenv",
    "--setenv", "PATH", `${SANDBOX_ROOT}/runtime:${SANDBOX_ROOT}/runtime/node-prefix/bin:${SANDBOX_ROOT}/runtime/bun-prefix/bin:/usr/local/bin:/usr/bin:/bin`,
    "--setenv", "HOME", "/tmp",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "GIT_CONFIG_NOSYSTEM", "1",
    "--setenv", "GIT_CONFIG_GLOBAL", "/dev/null",
    "--setenv", "GIT_TERMINAL_PROMPT", "0",
    "--setenv", "LC_ALL", "C.UTF-8",
  );
  if (workspace.runtimeBun) args.push("--ro-bind", runtimePrefix(workspace.runtimeBun), `${SANDBOX_ROOT}/runtime/bun-prefix`);
  for (const file of ["ld.so.cache", "passwd", "group", "nsswitch.conf"]) {
    const source = path.join("/etc", file);
    if (existsSync(source)) args.push("--ro-bind", source, `${path.posix.join("/etc", file)}`);
  }
  if (existsSync("/etc/ssl/certs")) {
    args.push("--dir", "/etc/ssl", "--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs");
  }
  if (backing) args.push("--ro-bind", backing.root, `${WORKSPACE_MOUNT}/node_modules`);
  for (const [index, other] of workspace.otherCandidates.entries()) {
    const mount = `${SANDBOX_ROOT}/other-${index}`;
    args.push("--dir", mount, "--ro-bind", other, mount);
    if (existsSync(path.join(other, ".git")) && lstatSync(path.join(other, ".git")).isDirectory()) {
      args.push("--ro-bind", path.join(other, ".git"), `${mount}/.git`);
    }
  }
  return { args, descriptors };
}

function normalizeAllowedPath(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("allowedPaths entries must be non-empty strings");
  if (value === "." || value === "*" || value === "/") return ".";
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const subtree = normalized.endsWith("/**");
  const relative = subtree ? normalized.slice(0, -3) : normalized;
  if (!relative || path.posix.isAbsolute(relative) || relative.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) {
    throw new Error(`invalid managed write path grant: ${value}`);
  }
  return subtree ? `${relative}/**` : relative;
}

function writableMountTarget(workspace: MissionWorkspace, input: string): { hostPath: string; sandboxPath: string } {
  const grant = normalizeAllowedPath(input);
  if (grant === ".") return { hostPath: workspace.candidateRoot, sandboxPath: WORKSPACE_MOUNT };
  const relative = grant.endsWith("/**") ? grant.slice(0, -3) : grant;
  const stat = safeLstatAt(workspace.candidateRoot, relative);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`managed shell write grant must name a directory subtree: ${grant}`);
  }
  if (!stat) ensureParentDirectories(workspace.candidateRoot, relative);
  const hostPath = path.join(workspace.candidateRoot, relative);
  const opened = lstatSync(hostPath);
  if (!opened.isDirectory() || opened.isSymbolicLink()) throw new Error(`managed write mount is not a real directory: ${grant}`);
  return { hostPath, sandboxPath: `${WORKSPACE_MOUNT}/${relative}` };
}

function assertWorkspaceIdentity(workspace: MissionWorkspace): void {
  if (workspace.quarantined) throw new Error("managed candidate is quarantined and cannot be reused");
  if (identity(workspace.candidateRoot) !== workspace.candidateIdentity || identity(workspace.candidateGitDir) !== workspace.candidateGitIdentity) {
    workspace.quarantined = true;
    throw new Error("candidate identity changed; refusing to launch");
  }
}

function verifiedGitRoot(input: string): string {
  const requested = realpathSync(input);
  const root = git(requested, ["rev-parse", "--show-toplevel"]);
  if (root !== requested) throw new Error(`workspace must use Git toplevel path: ${root}`);
  const common = git(requested, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!path.isAbsolute(common)) throw new Error("Git common directory is not absolute");
  return requested;
}

function ensurePrivateDirectory(input: string): string {
  mkdirSync(path.resolve(input), { recursive: true, mode: 0o700 });
  const target = realpathSync(input);
  chmodSync(target, 0o700);
  return target;
}

function assertDistinctRoots(roots: string[]): void {
  const resolved = roots.map((root) => path.resolve(root));
  for (let i = 0; i < resolved.length; i += 1) for (let j = i + 1; j < resolved.length; j += 1) {
    if (resolved[i] === resolved[j] || isWithin(resolved[i]!, resolved[j]!) || isWithin(resolved[j]!, resolved[i]!)) {
      if (roots[i] === roots[j]) continue;
      throw new Error(`workspace roots overlap: ${roots[i]} and ${roots[j]}`);
    }
  }
}

function assertSafePath(root: string, relative: string): void {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === ".." || part === ".git")) {
    throw new Error(`unsafe Git input path: ${relative}`);
  }
  const resolved = path.resolve(root, relative);
  if (!isWithin(root, resolved)) throw new Error(`Git input escaped workspace: ${relative}`);
}

function ensureParentDirectories(root: string, relative: string): void {
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = lstatMaybe(cursor);
    if (!stat) mkdirSync(cursor, { mode: 0o700 });
    else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`candidate parent is not a real directory: ${cursor}`);
  }
}

function safeGitPath(value: string): string {
  if (!value || value.includes("\0") || path.isAbsolute(value) || value.split("/").some((part) => part === ".." || part === ".git")) {
    throw new Error(`unsafe Git path: ${JSON.stringify(value)}`);
  }
  return value;
}

function gitlinks(entries: WorkspaceManifest["indexEntries"]): string[] {
  return entries.filter(({ mode }) => mode === "160000").map(({ path: name }) => name);
}

function copyIndexObjects(source: string, candidate: string, entries: WorkspaceManifest["indexEntries"]): void {
  const objectIds = new Set(entries.map(({ objectId }) => objectId).filter((oid) => !/^0+$/.test(oid)));
  for (const objectId of objectIds) {
    const bytes = gitBytes(source, ["cat-file", "blob", objectId]);
    const copied = decodeUtf8(gitBytes(candidate, ["hash-object", "-w", "--stdin"], bytes)).trim();
    if (copied !== objectId) throw new Error(`candidate staged blob differs from source index object ${objectId}`);
  }
  const indexInfo = Buffer.concat(entries.map(({ mode, objectId, stage, path: name }) =>
    Buffer.from(`${mode} ${objectId} ${stage}\t${name}\0`)));
  gitBytes(candidate, ["read-tree", "--empty"]);
  gitBytes(candidate, ["update-index", "-z", "--index-info"], indexInfo);
}

function git(cwd: string, args: string[]): string {
  return decodeUtf8(gitBytes(cwd, args)).trimEnd();
}

function gitBytes(cwd: string, args: string[], input?: Buffer): Buffer {
  return execFileSync("git", args, { cwd, encoding: "buffer", env: cleanGitEnvironment(), stdio: ["pipe", "pipe", "pipe"], input, maxBuffer: 32 * 1024 * 1024 });
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

function cleanLauncherEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C.UTF-8" };
}

function nulRecords(buffer: Buffer): Buffer[] {
  return buffer.length === 0 ? [] : buffer.subarray(0, buffer.length - 1).toString("binary").split("\0").map((entry) => Buffer.from(entry, "binary"));
}

function decodeUtf8(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function identity(target: string): string {
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`workspace mount is not a real directory: ${target}`);
  return `${stat.dev}:${stat.ino}`;
}

function lstatMaybe(target: string) {
  try { return lstatSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function safeLstatAt(root: string, relative: string) {
  assertSafePath(root, relative);
  const parts = relative.split(path.sep);
  let cursor = root;
  for (const [index, segment] of parts.entries()) {
    cursor = path.join(cursor, segment);
    const stat = lstatMaybe(cursor);
    if (!stat) return undefined;
    if (index < parts.length - 1 && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`workspace input has a symlink or non-directory parent: ${relative}`);
    }
    if (index < parts.length - 1) continue;
    return stat;
  }
  return undefined;
}

function readStableFile(root: string, relative: string, expected: Stats): Buffer {
  const target = path.join(root, relative);
  const fd = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error(`workspace input changed while reading: ${relative}`);
    }
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveBwrap(input?: string): string {
  const candidate = input ?? "/usr/bin/bwrap";
  const resolved = realpathSync(candidate);
  accessSync(resolved, fsConstants.X_OK);
  return resolved;
}

function resolveRuntime(commandName: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const target = path.join(directory, commandName);
    try {
      accessSync(target, fsConstants.X_OK);
      return realpathSync(target);
    } catch { /* try the next configured executable directory */ }
  }
  throw new Error(`required runtime is unavailable: ${commandName}`);
}

function optionalRuntime(commandName: string): string | undefined {
  try { return resolveRuntime(commandName); } catch { return undefined; }
}

function runtimePrefix(runtime: string): string {
  const parent = path.dirname(runtime);
  return path.basename(parent) === "bin" ? path.dirname(parent) : parent;
}

function sandboxRuntimePath(runtime: string): string {
  return path.basename(path.dirname(runtime)) === "bin"
    ? `${SANDBOX_ROOT}/runtime/node-prefix/bin/${path.basename(runtime)}`
    : `${SANDBOX_ROOT}/runtime/node`;
}

function namespaceId(name: "pid" | "net"): string {
  return readlinkSync(`/proc/self/ns/${name}`);
}

function openSeccompFilter(): number {
  const syscalls = syscallTable();
  const rules: Array<[number, number]> = [];
  const instruction = (code: number, jumpTrue = 0, jumpFalse = 0, value = 0) => rules.push([code | (jumpTrue << 8) | (jumpFalse << 16), value]);
  instruction(0x20, 0, 0, 0); // BPF_LD | BPF_W | BPF_ABS, seccomp_data.nr
  for (const syscall of syscalls.blocked) {
    instruction(0x15, 0, 1, syscall); // BPF_JMP | BPF_JEQ | BPF_K
    instruction(0x06, 0, 0, 0x00050001); // BPF_RET | SECCOMP_RET_ERRNO | EPERM
  }
  instruction(0x06, 0, 0, 0x7fff0000); // SECCOMP_RET_ALLOW
  const bytes = Buffer.alloc(rules.length * 8);
  rules.forEach(([code, value], index) => {
    bytes.writeUInt16LE(code & 0xffff, index * 8);
    bytes.writeUInt8((code >>> 8) & 0xff, index * 8 + 2);
    bytes.writeUInt8((code >>> 16) & 0xff, index * 8 + 3);
    bytes.writeUInt32LE(value, index * 8 + 4);
  });
  const directory = mkdtempSync(path.join(os.tmpdir(), "pitako-seccomp-"));
  const file = path.join(directory, "filter");
  writeFileSync(file, bytes, { mode: 0o600 });
  const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  rmSync(directory, { recursive: true, force: true });
  return fd;
}

function syscallTable(): { blocked: number[] } {
  const tables: Record<string, number[]> = {
    x64: [41, 42, 43, 44, 46, 48, 49, 50, 53, 288, 299, 307, 425, 426, 427,
      101, 155, 165, 166, 169, 172, 173, 175, 176, 246, 248, 249, 250, 272, 298, 304, 308, 313, 321, 323,
      105, 106, 113, 114, 116, 117, 119, 122, 123, 126, 428, 429, 430, 431, 432, 442],
    arm64: [198, 199, 200, 201, 202, 203, 206, 210, 211, 425, 426, 427,
      39, 40, 41, 97, 104, 105, 106, 117, 142, 143, 144, 145, 146, 147, 149, 151, 152, 159,
      217, 218, 219, 241, 265, 268, 273, 280, 282, 428, 429, 430, 431, 432, 442],
  };
  const blocked = tables[process.arch];
  if (!blocked) throw new Error(`managed containment is unsupported on CPU architecture ${process.arch}; no writer launched`);
  return { blocked: [...new Set(blocked)] };
}

function hostIdentity(): string {
  let machine = "";
  try { machine = readFileSync("/etc/machine-id", "utf8").trim(); } catch { /* hostname still distinguishes hosts */ }
  return createHash("sha256").update(`${os.hostname()}\0${machine}`).digest("hex");
}

function command(commandName: string, args: string[]): string {
  const output = spawnSync(commandName, args, { encoding: "utf8", timeout: 10_000, env: cleanLauncherEnvironment() });
  if (output.error || output.status !== 0) throw new Error(output.error?.message ?? output.stderr ?? `${commandName} exited ${output.status}`);
  return output.stdout.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
