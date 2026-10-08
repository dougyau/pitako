import { spawnSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./model.ts";

export const NESTED_PROFILE = "sealed-nested-verification-v1";
export const NESTED_SCRATCH = "/verification/scratch";
export const NESTED_EVIDENCE = "/verification/evidence";
type Row = { path: string; identity: string; size: number; hash: string };
export interface NestedCapsule {
  root: string;
  identity: string;
  scratchIdentity: string;
  evidenceIdentity: string;
  closure: Row[];
  closureHash: string;
  closureBytes: number;
  artifactBytes: number;
}
export const physicalIdentity = (file: string) => {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`verification identity is a link: ${file}`);
  return `${stat.dev}:${stat.ino}`;
};

/** Copy before release. Nothing here grants execution authority. */
export function copyNestedCapsule(parent: string, runtimes: string[], dependencies: string | undefined, artifactBytes: number): NestedCapsule {
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes <= 2 * 1024 * 1024)
    throw new Error("nested verification has insufficient finite artifact grant");
  const root = mkdtempSync(path.join(parent, "verification-"));
  const closure: Row[] = [];
  let closureBytes = 0;
  const copyFile = (source: string, relative: string) => {
    const target = path.join(root, relative);
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) throw new Error(`verification runtime input is not regular: ${source}`);
      closureBytes += before.size;
      if (closureBytes + 2 * 1024 * 1024 >= artifactBytes) throw new Error("copied verification closure exceeds finite artifact grant");
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        physicalIdentity(source) !== `${before.dev}:${before.ino}`) throw new Error("verification input changed during copy");
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: before.mode & 0o555, flag: "wx" });
      closure.push({ path: relative, identity: physicalIdentity(target), size: bytes.length, hash: sha256(bytes) });
    } finally { closeSync(fd); }
  };
  try {
    for (const name of ["scratch", "evidence", "closure/usr", "closure/bin", "closure/sbin", "closure/lib", "closure/lib64",
      "closure/etc", "closure/runtime/node-prefix/bin", "closure/runtime/bun-prefix/bin", "closure/dependencies", "store"])
      mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
    const programs = ["sh", "bash", "git", "bwrap", "readlink", "sleep", "setsid", "mount", "mkdir", "rm", "env", "true"];
    const executables = new Set<string>(runtimes.map((file) => realpathSync(file)));
    const resolve = (name: string) => {
      for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        try { return realpathSync(path.join(dir, name)); } catch { /* next configured directory */ }
      }
      throw new Error(`nested verification runtime unavailable: ${name}`);
    };
    for (const name of programs) {
      const file = resolve(name);
      executables.add(file);
      copyFile(file, `closure/usr/bin/${name}`);
      copyFile(file, `closure/bin/${name}`);
    }
    const gitExecutable = resolve("git");
    for (const name of ["git-upload-pack", "git-receive-pack"]) {
      copyFile(gitExecutable, `closure/usr/lib/git-core/${name}`);
      copyFile(gitExecutable, `closure/usr/bin/${name}`);
    }
    mkdirSync(path.join(root, "closure/usr/share/git-core/templates"), { recursive: true, mode: 0o700 });
    for (const file of runtimes) {
      const name = path.basename(file);
      copyFile(realpathSync(file), `closure/runtime/${name}-prefix/bin/${name}`);
      copyFile(realpathSync(file), `closure/runtime/${name}`);
    }
    const libraries = new Set<string>();
    for (const file of executables) {
      const result = spawnSync("ldd", [file], { encoding: "utf8", timeout: 10000 });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (result.error || /not found/.test(output)) throw new Error(`nested runtime closure unavailable: ${file}`);
      for (const match of output.matchAll(/(?:=>\s+|^\s*)(\/[^\s(]+)/gm)) libraries.add(match[1]!);
    }
    for (const file of libraries) copyFile(realpathSync(file), `closure${file}`);
    // Recursive dependency links must remain within this disclosed local closure.
    const visit = (source: string, relative: string, ancestors: Set<string>) => {
      const resolved = realpathSync(source);
      if (!dependencies || !within(realpathSync(dependencies), resolved)) throw new Error("dependency closure escapes its bound root");
      const stat = lstatSync(resolved);
      if (stat.isDirectory()) {
        if (ancestors.has(resolved)) throw new Error("dependency closure is cyclic");
        mkdirSync(path.join(root, relative), { recursive: true, mode: 0o700 });
        for (const name of readdirSync(resolved).sort()) visit(path.join(resolved, name), `${relative}/${name}`, new Set([...ancestors, resolved]));
      } else copyFile(resolved, relative);
    };
    if (dependencies) visit(dependencies, "closure/dependencies", new Set());
    const capsule = { root, identity: physicalIdentity(root), scratchIdentity: physicalIdentity(path.join(root, "scratch")),
      evidenceIdentity: physicalIdentity(path.join(root, "evidence")), closure, closureHash: sha256(Buffer.from(JSON.stringify(closure))),
      closureBytes, artifactBytes };
    assertNestedCapsule(capsule);
    return capsule;
  } catch (error) {
    // No code has been released and no process can own this failed copy.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function assertNestedCapsule(capsule: NestedCapsule): void {
  if (physicalIdentity(capsule.root) !== capsule.identity ||
    physicalIdentity(path.join(capsule.root, "scratch")) !== capsule.scratchIdentity ||
    physicalIdentity(path.join(capsule.root, "evidence")) !== capsule.evidenceIdentity)
    throw new Error("nested verification scratch/evidence identity changed");
  for (const row of capsule.closure) {
    const file = path.join(capsule.root, row.path);
    if (physicalIdentity(file) !== row.identity || lstatSync(file).nlink !== 1 || sha256(readFileSync(file)) !== row.hash)
      throw new Error("copied nested verification runtime/dependency closure changed");
  }
}

export function importNestedEvidence(capsule: NestedCapsule, rawLogBytes: number): {
  manifest: Row[]; hash: string; artifacts: Array<{ bytes: Uint8Array; mediaType: string }>;
} {
  assertNestedCapsule(capsule);
  const root = path.join(capsule.root, "evidence");
  const manifest: Row[] = [], artifacts: Array<{ bytes: Uint8Array; mediaType: string }> = [];
  let total = capsule.closureBytes + rawLogBytes + 2;
  const visit = (directory: string, relative = "") => {
    for (const name of readdirSync(directory).sort()) {
      if (!name || name === "." || name === ".." || name.includes("\\") || name.includes("\0"))
        throw new Error("invalid verification export path");
      const target = path.join(directory, name), rel = relative ? `${relative}/${name}` : name;
      const before = lstatSync(target);
      if (before.isSymbolicLink()) throw new Error("verification export is a link");
      if (before.isDirectory()) { visit(target, rel); continue; }
      if (!before.isFile() || before.nlink !== 1) throw new Error("verification export is special or aliased");
      const row = { path: rel, identity: `${before.dev}:${before.ino}`, size: before.size, hash: "0".repeat(64) };
      const charge = before.size + Buffer.byteLength(JSON.stringify(row)) + 1;
      if (total + charge > capsule.artifactBytes) throw new Error("verification output grant exhausted");
      const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd), bytes = readFileSync(fd), after = lstatSync(target);
        if (opened.dev !== before.dev || opened.ino !== before.ino || after.dev !== before.dev ||
          after.ino !== before.ino || bytes.length !== before.size || after.mtimeMs !== before.mtimeMs)
          throw new Error("verification export identity changed");
        total += charge;
        row.hash = sha256(bytes);
        manifest.push(row);
        artifacts.push({ bytes, mediaType: "application/octet-stream" });
      } finally { closeSync(fd); }
    }
  };
  visit(root);
  if (physicalIdentity(root) !== capsule.evidenceIdentity) throw new Error("verification evidence root changed during import");
  return { manifest, hash: sha256(Buffer.from(JSON.stringify(manifest))), artifacts };
}

function within(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}
