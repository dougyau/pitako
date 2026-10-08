import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { constants, closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, chmodSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { repositoryIdentity } from "../board/workspace.ts";
import { verifyExecutionBinding, type ExecutionBinding } from "../workflow.ts";
import { sha256 } from "./model.ts";
import { openSeccompFilter } from "./workspace.ts";
import type { PreparedSetup, SetupAllocation, SetupIdentity } from "./setup.ts";

export interface ManifestBounds { paths: number; largestFileBytes: number; totalBytes: number }
export interface CopyContract {
  bounds: ManifestBounds;
  seeds: Array<{ source: string; destination: string; bounds: ManifestBounds }>;
}
type Row = SetupIdentity["source"][number];
const digest = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));
const physical = (file: string) => { const s = lstatSync(file); return `${s.dev}:${s.ino}:${s.mode}`; };
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel === "" || !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
};
const destinations = new Map<string, string>();
const environment = { PATH: "/runtime", HOME: "/tmp/setup-home", TMPDIR: "/tmp",
  XDG_CACHE_HOME: "/tmp/xdg", BUN_INSTALL_CACHE: "/cache", BUN_INSTALL_CACHE_DIR: "/cache",
  LANG: "C.UTF-8", LC_ALL: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function bounds(value: ManifestBounds): void {
  if (!value || [value.paths, value.largestFileBytes, value.totalBytes].some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new Error("copied setup requires exact finite positive manifest bounds");
}
function safe(name: string): boolean {
  return !!name && !path.isAbsolute(name) && !name.includes("\\") &&
    !name.split("/").some((part) => !part || part === "." || part === "..") && !name.includes("\0");
}
/** Seeds permit hardlinks; published bytes do not. Link containment is never relaxed. */
function tree(root: string, limit: ManifestBounds, published = false): Row[] {
  bounds(limit);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error(`copy root is not physical: ${root}`);
  const rows: Row[] = [];
  let bytes = 0;
  const visit = (name: string) => {
    if (!safe(name) || rows.length >= limit.paths) throw new Error("copied setup manifest path bound exceeded");
    const file = path.join(root, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(file);
      if (path.isAbsolute(target) || !inside(root, realpathSync(file))) throw new Error(`external copied setup link: ${name}`);
      rows.push({ path: name, kind: "link", target, mode: stat.mode, identity: physical(file) });
    } else if (stat.isDirectory()) {
      rows.push({ path: name, kind: "directory", mode: stat.mode, identity: physical(file) });
      for (const child of readdirSync(file).sort()) visit(`${name}/${child}`);
    } else if (stat.isFile()) {
      if (published && stat.nlink !== 1) throw new Error(`published setup hardlink alias: ${name}`);
      bytes += stat.size;
      if (stat.size > limit.largestFileBytes || bytes > limit.totalBytes) throw new Error("copied setup manifest byte bound exceeded");
      rows.push({ path: name, kind: "file", mode: stat.mode, identity: physical(file),
        size: stat.size, ...(!published ? { nlink: stat.nlink, mtimeMs: stat.mtimeMs } : {}), hash: sha256(readFileSync(file)) });
    } else throw new Error(`unsupported copied setup inode: ${name}`);
  };
  for (const name of readdirSync(root).sort()) visit(name);
  return rows;
}
function resolveRuntime(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const file = path.join(dir, name);
    if (existsSync(file) && lstatSync(realpathSync(file)).isFile()) return realpathSync(file);
  }
  throw new Error(`copied setup missing local runtime: ${name}`);
}
function runtime(file: string) {
  return { path: file, identity: physical(file), hash: sha256(readFileSync(file)),
    version: execFileSync(file, ["--version"], { encoding: "utf8", timeout: 5000 }).trim() };
}
export function captureCopyIdentity(binding: ExecutionBinding, values: SetupAllocation): SetupIdentity {
  verifyExecutionBinding(binding);
  const root = binding.executionRoot, contract = values.copy;
  if (!contract || !Array.isArray(contract.seeds) || !contract.seeds.length ||
    values.writableDirectories.length !== 1 || values.writableDirectories[0] !== "node_modules" ||
    !Number.isSafeInteger(values.activeTimeMs) || values.activeTimeMs < 1 ||
    !Number.isSafeInteger(values.artifactBytes) || values.artifactBytes < 16384)
    throw new Error("copied setup requires disclosed local seeds, node_modules output and bounded allocation");
  bounds(contract.bounds);
  if (realpathSync(root) !== root) throw new Error("copied setup execution root is not physical");
  const output = path.join(root, "node_modules");
  if (existsSync(output) && (!lstatSync(output).isDirectory() || realpathSync(output) !== output))
    throw new Error("source dependency directory is an external alias");
  const seeds = contract.seeds.map((seed) => {
    if (typeof seed.source !== "string" || !path.isAbsolute(seed.source) || !safe(seed.destination) ||
      !(seed.destination === "node_modules" || seed.destination.startsWith("cache/")) ||
      contract.seeds.some((other) => other !== seed && (other.destination === seed.destination ||
        other.destination.startsWith(`${seed.destination}/`) || seed.destination.startsWith(`${other.destination}/`))))
      throw new Error("invalid or overlapping disclosed local seed");
    return { source: seed.source, destination: seed.destination, rootIdentity: physical(seed.source), rows: tree(seed.source, seed.bounds) };
  });
  if (!seeds.some(({ destination }) => destination === "node_modules"))
    throw new Error("copied setup needs a compatible disclosed installed dependency seed");
  const names = execFileSync("/usr/bin/git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { maxBuffer: 16 * 1024 * 1024 }).toString().split("\0").filter(Boolean)
    .filter((name) => !name.startsWith(".pitako/") && name !== "node_modules" && !name.startsWith("node_modules/"));
  const source: Row[] = names.sort().map((name) => {
    if (!safe(name)) throw new Error("unsafe copied source path");
    const file = path.join(root, name), s = lstatSync(file);
    if (!s.isFile() || realpathSync(file) !== file) throw new Error(`unsupported copied source inode: ${name}`);
    return { path: name, kind: "file", mode: s.mode, size: s.size, hash: sha256(readFileSync(file)) };
  });
  for (const name of ["scripts/setup.sh", "package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "GATES.md"])
    if (!source.some(({ path: file }) => file === name)) source.push({ path: name, kind: "missing" });
  const script = source.find(({ path: file }) => file === "scripts/setup.sh")!;
  const runtimes = ["bash", "git", "node", "bun", "dirname", "readlink"].map((name) => runtime(resolveRuntime(name)));
  const libraryFiles = new Set<string>();
  for (const executable of runtimes) {
    const text = execFileSync("/usr/bin/ldd", [executable.path], { encoding: "utf8", timeout: 5000 });
    for (const line of text.split("\n")) {
      const file = /(?:=>\s+)?(\/\S+)\s+\(/.exec(line)?.[1];
      if (file) libraryFiles.add(file);
      else if (line.includes("not found")) throw new Error("copied setup library closure unavailable");
    }
  }
  const libraries = [...libraryFiles].sort().map((file) => ({ path: file, identity: physical(file), hash: sha256(readFileSync(file)) }));
  const inputBytes = source.reduce((n, row) => n + (row.size ?? 0), 0) +
    seeds.flatMap(({ rows }) => rows).reduce((n, row) => n + (row.size ?? 0), 0) +
    [...runtimes, ...libraries].reduce((n, row) => n + lstatSync(row.path).size, 0);
  if (inputBytes + contract.bounds.totalBytes + Buffer.byteLength(JSON.stringify([source, seeds])) * 3 + 16384 > values.artifactBytes)
    throw new Error("copied setup closure and bounded publication exceed admitted artifact allocation");
  const key = digest([binding, values, source, seeds, runtimes, libraries]);
  let destination = destinations.get(key);
  if (!destination) { destination = path.join(realpathSync(tmpdir()), `pitako-setup-${randomUUID()}`); destinations.set(key, destination); }
  return { format: "mission-setup-input-v2", binding: structuredClone(binding), repositoryFamily: repositoryIdentity(root),
    rootIdentity: physical(root), outputDirectories: [{ path: "node_modules", identity: existsSync(output) ? physical(output) : "missing" }],
    script: script.kind === "missing" ? null : script, source, runtimes, libraries,
    platform: { os: process.platform, arch: process.arch, abi: process.versions.modules ?? "" },
    // V2 carries its own exact environment; v1's serialized environment stays unchanged.
    environment, producerHash: digest(["setup-copy-v1", sha256(readFileSync(new URL("./setup.ts", import.meta.url))),
      sha256(readFileSync(new URL("./setup-copy.ts", import.meta.url))), sha256(readFileSync(new URL("./workspace.ts", import.meta.url)))]),
    copy: { destination, seeds, bounds: structuredClone(contract.bounds) } };
}
export function assertCopyInputs(setup: Pick<PreparedSetup, "identity" | "decision">): void {
  const current = captureCopyIdentity(setup.identity.binding, setup.decision.values);
  // On restart reuse the already admitted destination, never invent a new one.
  current.copy!.destination = setup.identity.copy!.destination;
  if (digest(current) !== digest(setup.identity)) throw new Error("approved copied setup source/seed/runtime identity changed");
}
function copyRows(source: string, destination: string, rows: Row[]): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const row of rows) {
    const target = path.join(destination, row.path);
    if (!safe(row.path)) throw new Error("unsafe copied setup path");
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (row.kind === "directory") mkdirSync(target, { recursive: true, mode: (row.mode ?? 0o700) & 0o777 });
    else if (row.kind === "file") { copyFileSync(path.join(source, row.path), target, constants.COPYFILE_EXCL); chmodSync(target, row.mode! & 0o777); }
    else if (row.kind === "link") symlinkSync(row.target!, target);
  }
}
function owned(identity: SetupIdentity): string {
  const root = identity.copy!.destination;
  const registration = JSON.parse(readFileSync(path.join(root, "identity.json"), "utf8"));
  for (const [name, expected] of Object.entries(registration.directories)) {
    const file = path.join(root, name);
    if (realpathSync(file) !== file || physical(file) !== expected) throw new Error("owned setup capsule identity changed");
  }
  for (const [name, expected] of Object.entries(registration.files)) {
    const file = path.join(root, name);
    if (realpathSync(file) !== file || !lstatSync(file).isFile() || physical(file) !== expected)
      throw new Error("owned setup runtime identity changed");
  }
  return root;
}
export function initializeCopy(setup: PreparedSetup): void {
  assertCopyInputs(setup);
  const identity = setup.identity, root = identity.copy!.destination;
  mkdirSync(root, { mode: 0o700 }); // exclusive: a stale or pre-created destination cannot acquire authority
  for (const name of ["capsule", "cache", "runtime", "libraries", "published"]) mkdirSync(path.join(root, name), { mode: 0o700 });
  copyRows(identity.binding.executionRoot, path.join(root, "capsule"), identity.source);
  for (const seed of identity.copy!.seeds)
    copyRows(seed.source, path.join(root, seed.destination === "node_modules" ? "capsule/node_modules" : seed.destination), seed.rows);
  for (const seed of identity.copy!.seeds.filter(({ destination }) => destination.startsWith("cache/"))) {
    const name = seed.destination.slice("cache/".length);
    const match = /^(.*)@([^@]+@@@.*)$/.exec(name);
    if (match && !name.startsWith("@GH@")) {
      const aliases = path.join(root, "cache", match[1]!);
      mkdirSync(aliases, { recursive: true, mode: 0o700 });
      symlinkSync(path.relative(aliases, path.join(root, "cache", name)), path.join(aliases, match[2]!));
    }
  }
  for (const executable of identity.runtimes) {
    const target = path.join(root, "runtime", path.basename(executable.path));
    copyFileSync(executable.path, target, constants.COPYFILE_EXCL); chmodSync(target, 0o500);
  }
  for (const [index, library] of identity.libraries.entries()) copyFileSync(library.path, path.join(root, "libraries", String(index)));
  writeFileSync(path.join(root, "identity.json"), JSON.stringify({
    directories: Object.fromEntries(["", "capsule", "capsule/node_modules", "cache", "runtime", "libraries", "published"]
      .map((name) => [name, physical(path.join(root, name))])),
    files: Object.fromEntries([...identity.source.filter((row) => row.kind === "file").map((row) => `capsule/${row.path}`),
      ...identity.runtimes.map((row) => `runtime/${path.basename(row.path)}`),
      ...identity.libraries.map((_row, index) => `libraries/${index}`)].map((name) => [name, physical(path.join(root, name))])),
  }), { flag: "wx", mode: 0o400 });
  assertCopyInputs(setup);
}
export function launchCopy(setup: PreparedSetup): ChildProcess {
  assertCopyInputs(setup);
  const root = owned(setup.identity), descriptors: number[] = [], filter = openSeccompFilter();
  const pin = (file: string) => {
    const fd = openSync(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(fd);
    const stat = fstatSync(fd);
    if (`${stat.dev}:${stat.ino}:${stat.mode}` !== physical(file)) throw new Error("copied setup mount changed");
    return String(3 + descriptors.length);
  };
  try {
    const args = ["--tmpfs", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
      "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent", "--disable-userns", "--assert-userns-disabled",
      "--seccomp", "3", "--ro-bind-fd", pin(path.join(root, "capsule")), "/capsule",
      "--bind-fd", pin(path.join(root, "capsule/node_modules")), "/capsule/node_modules",
      "--bind-fd", pin(path.join(root, "cache")), "/cache", "--dir", environment.HOME];
    for (const executable of setup.identity.runtimes)
      args.push("--ro-bind", path.join(root, "runtime", path.basename(executable.path)), `/runtime/${path.basename(executable.path)}`);
    args.push("--ro-bind", path.join(root, "runtime", "bash"), "/bin/bash");
    for (const [index, library] of setup.identity.libraries.entries())
      args.push("--ro-bind", path.join(root, "libraries", String(index)), library.path);
    const loaderIndex = setup.identity.libraries.findIndex(({ path: file }) => path.basename(file).startsWith("ld-linux"));
    if (loaderIndex >= 0) args.push("--ro-bind", path.join(root, "libraries", String(loaderIndex)),
      process.arch === "x64" ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux-aarch64.so.1");
    args.push("--clearenv", ...Object.entries(environment).flatMap(([key, value]) => ["--setenv", key, value]),
      "--chdir", "/capsule", "--", "/bin/bash", "-c",
      `printf '{"pidNamespace":"%s","networkNamespace":"%s"}\\n' "$(readlink /proc/self/ns/pid)" "$(readlink /proc/self/ns/net)"; IFS= read -r gate || exit 94; [ "$gate" = GO ] || exit 94; exec /bin/bash ./scripts/setup.sh </dev/null`);
    return spawn("/usr/bin/bwrap", args, { stdio: ["pipe", "pipe", "pipe", filter, ...descriptors], env: environment });
  } finally { closeSync(filter); for (const fd of descriptors) closeSync(fd); }
}
export function captureCopyOutputs(identity: SetupIdentity): Row[] {
  const root = identity.copy!.destination, output = path.join(root, "published/node_modules");
  if (!existsSync(output)) return [];
  owned(identity);
  for (const row of identity.source) if (row.kind === "file" &&
    sha256(readFileSync(path.join(root, "capsule", row.path))) !== row.hash)
    throw new Error("copied setup capsule source changed");
  for (const runtime of identity.runtimes) if (sha256(readFileSync(path.join(root, "runtime", path.basename(runtime.path)))) !== runtime.hash)
    throw new Error("copied setup runtime changed");
  for (const [index, library] of identity.libraries.entries())
    if (sha256(readFileSync(path.join(root, "libraries", String(index)))) !== library.hash)
      throw new Error("copied setup library changed");
  const rows = tree(output, identity.copy!.bounds, true);
  if (rows.length + 1 > identity.copy!.bounds.paths) throw new Error("copied setup manifest path bound exceeded");
  return [{ path: "node_modules", kind: "directory", identity: physical(output), mode: lstatSync(output).mode },
    ...rows.map((row) => ({ ...row, path: `node_modules/${row.path}` }))];
}
export function publishCopy(setup: PreparedSetup): number {
  const root = owned(setup.identity), limit = setup.identity.copy!.bounds;
  // Raw staging may contain cache hardlinks; the byte-copied publication cannot.
  const source = path.join(root, "capsule/node_modules"), rows = tree(source, limit);
  if (rows.length + 1 > limit.paths) throw new Error("copied setup manifest path bound exceeded");
  if (copyStorageBytes(setup.identity) + rows.reduce((n, row) => n + (row.size ?? 0), 0) > setup.decision.values.artifactBytes)
    throw new Error("copied setup storage exceeds admitted artifact allocation");
  copyRows(source, path.join(root, "published/node_modules"), rows);
  captureCopyOutputs(setup.identity);
  const bytes = copyStorageBytes(setup.identity);
  if (bytes > setup.decision.values.artifactBytes) throw new Error("copied setup storage exceeds admitted artifact allocation");
  return bytes;
}
export function copyStorageBytes(identity: SetupIdentity): number {
  const root = identity.copy!.destination;
  if (!existsSync(root)) return 0;
  let bytes = 0;
  const measure = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name), stat = lstatSync(file);
      if (stat.isDirectory()) measure(file);
      else if (stat.isFile()) bytes += stat.size;
    }
  };
  measure(root);
  return bytes;
}
