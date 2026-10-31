import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { registeredWorktrees, workspacePaths } from "./board/workspace.ts";

export const SPEC_SECTIONS = ["Objective", "Scope", "Exclusions", "Expected behavior", "Constraints", "Decisions and reasons", "Acceptance criteria", "Verification", "Source context", "Non-blocking uncertainty"] as const;
export const MAX_SPEC_BYTES = 26 * 1536;
export function validatePlanId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error("Invalid spec-plan ID.");
}
export function gitRead(root: string, ...args: string[]): string {
  const env = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_OPTIONAL_LOCKS") delete (env as NodeJS.ProcessEnv)[key];
  return execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}
export function designatedWorkspace(root: string) {
  if (!path.isAbsolute(root)) throw new Error("Designated worktree must be absolute.");
  const physical = realpathSync(root);
  // One discovery yields both root and identity. Git discovery already requires a
  // non-bare worktree; outside Git both paths are the cwd and Git reports the error.
  const { worktreeRoot, commonDir } = workspacePaths(physical);
  if (worktreeRoot !== physical || (commonDir === physical && gitRead(physical, "rev-parse", "--is-inside-work-tree").trim() !== "true")) throw new Error("Designate a registered Git worktree root, not a subdirectory.");
  const registered = gitRead(physical, "worktree", "list", "--porcelain", "-z").split("\0").some(field => {
    if (!field.startsWith("worktree ")) return false;
    try { return realpathSync(field.slice("worktree ".length)) === physical; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  });
  if (!registered) throw new Error(`Designated worktree is not registered with Git: ${physical}`);
  return { physicalRoot: physical, identity: commonDir };
}
export function validateSpec(content: string, id: string): void {
  validatePlanId(id);
  if (Buffer.byteLength(content) > MAX_SPEC_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new Error("Spec-plan exceeds the native snapshot boundary or contains control characters.");
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!header || !/^pitako-spec: 1$/m.test(header[1]!) || !new RegExp(`^id: ${id}$`, "m").test(header[1]!) || !/^status: complete$/m.test(header[1]!)) throw new Error("Not a complete Pitako spec-plan v1; legacy frozen status is insufficient.");
  const sections = content.slice(header[0].length).split(/^## /m).slice(1);
  for (const title of SPEC_SECTIONS) {
    const matches = sections.filter(section => section.split(/\r?\n/, 1)[0] === title);
    if (matches.length !== 1 || !matches[0]!.slice(title.length).trim()) throw new Error(`Spec-plan requires a nonempty '${title}' section.`);
  }
}
export function digest(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }

export type ExecutionAmendment = { path: string; sha256: string; provenance: string };
export function executionAmendments(root: string, value: unknown = [], verify = false): ExecutionAmendment[] {
  if (!Array.isArray(value)) throw new Error("Expected amendments: [{path, sha256, provenance}].");
  return value.map(ref => {
    if (!ref || Object.keys(ref).sort().join(",") !== "path,provenance,sha256" ||
        typeof ref.path !== "string" || ref.path.includes("\0") || !/\.md$/i.test(ref.path) ||
        !/^[a-f0-9]{64}$/.test(ref.sha256) || typeof ref.provenance !== "string" ||
        !ref.provenance.trim() || ref.provenance.includes("\0"))
      throw new Error("Expected Markdown amendment path, SHA-256 and human message ID/timestamp provenance.");
    let source = path.resolve(root, ref.path);
    const inside = (base: string, file: string) => {
      const relative = path.relative(base, file);
      return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const physicalRoot = realpathSync(root);
    // Rebase alias-local paths, but preserve already physical absolute paths.
    if (inside(root, source)) source = path.resolve(physicalRoot, path.relative(root, source));
    else if (!inside(physicalRoot, source)) throw new Error(`Amendment must be inside designated worktree: ${source}`);
    if (verify) {
      let actual = "unavailable";
      try {
        if (!inside(physicalRoot, realpathSync(source))) throw new Error("Physical path escapes designated worktree");
        const bytes = readFileSync(source);
        actual = digest(bytes);
        if (actual !== ref.sha256) throw new Error("Full source hash mismatch");
        if (!bytes.toString("utf8").trim() || bytes.includes(0)) throw new Error("Expected complete nonempty Markdown text");
      } catch (error) {
        throw new Error(`Amendment ${source}; expected SHA-256 ${ref.sha256}, observed ${actual}: ${String(error instanceof Error ? error.message : error)}. Reconcile this source and explicitly prepare admission with the intended hash; after admission restore reliable exact bytes and preserve frozen references. No automatic recapture.`);
      }
    }
    return { path: source, sha256: ref.sha256, provenance: ref.provenance };
  });
}
export function specChunks(content: string): string[] {
  if (Buffer.byteLength(content) > MAX_SPEC_BYTES) throw new Error("Spec-plan exceeds the native chunk snapshot boundary.");
  const chunks: string[] = [];
  let chunk = "";
  for (const character of content) {
    // Up to three bytes of UTF-8 boundary slack keep any accepted input within 26 chunks.
    if (Buffer.byteLength(chunk + character) > 1539) { chunks.push(chunk); chunk = ""; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length > 26) throw new Error("Spec-plan exceeds the native chunk snapshot boundary.");
  return chunks;
}
/** Share the native 26 input grants between exact specs and oversized selected metadata. */
export function inspectionSnapshot(metadata: unknown, content: string) {
  const encoded = JSON.stringify(metadata), characters = [...encoded];
  if (Buffer.byteLength(encoded) > 26 * 4096) throw new Error("Selected inspection metadata exceeds the native snapshot boundary.");
  const metadataDigest = digest(encoded), inputDigest = digest(content), parts = specChunks(content);
  const packets: { digest: string; metadataDigest: string; index: number; chunks: number; metadata: string; content: string }[] = [];
  let cursor = 0;
  for (let index = 0; index < 26 && (index < parts.length || cursor < characters.length); index++) {
    const packet = { digest: inputDigest, metadataDigest, index, chunks: 26, metadata: "", content: parts[index] ?? "" };
    while (cursor < characters.length) {
      const next = packet.metadata + characters[cursor];
      if (Buffer.byteLength(JSON.stringify({ ...packet, metadata: next }) + "\n") > 4096) break;
      packet.metadata = next; cursor++;
    }
    packets.push(packet);
  }
  if (cursor !== characters.length) throw new Error("Selected inspection metadata exceeds the 26-chunk native snapshot envelope; shorten paths or link shared spec context.");
  for (const packet of packets) packet.chunks = packets.length;
  return { transport: { digest: metadataDigest, chunks: packets.length, bytes: Buffer.byteLength(encoded), contentBytes: Buffer.byteLength(content) }, packets };
}
export interface SpecCandidate { source: string; sourceRoot: string; digest: string; content: string }
function candidate(root: string, id: string): SpecCandidate | undefined {
  const target = path.join(root, ".pitako", "plans", `${id}.md`);
  try { lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  // Symlinked directories/documents must not escape this registered worktree.
  const source = realpathSync(target);
  if (source !== target || !lstatSync(source).isFile()) throw new Error(`Invalid local spec-plan path: ${target}`);
  // Bound even a file that grows after stat; oversized invalid inputs never load in full.
  const fd = openSync(source, "r"), bytes = Buffer.alloc(MAX_SPEC_BYTES + 1);
  let length = 0;
  try {
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
  } finally { closeSync(fd); }
  if (length > MAX_SPEC_BYTES) throw new Error(`Spec-plan size exceeds ${MAX_SPEC_BYTES} UTF-8 bytes: ${source}`);
  const content = bytes.subarray(0, length).toString("utf8");
  validateSpec(content, id);
  return { source, sourceRoot: root, digest: digest(content), content };
}
export function discoverSpec(root: string, id: string, selectedSource?: string) {
  validatePlanId(id);
  const workspace = designatedWorkspace(root);
  const local = candidate(workspace.physicalRoot, id);
  const candidates = local ? [local] : registeredWorktrees(workspace.physicalRoot, workspace.identity).filter(other => other !== workspace.physicalRoot).flatMap(other => {
    const found = candidate(designatedWorkspace(other).physicalRoot, id); return found ? [found] : [];
  });
  if (selectedSource !== undefined && (!path.isAbsolute(selectedSource) || !candidates.some(item => item.source === selectedSource))) throw new Error("Explicit source is not an eligible candidate; local-first discovery still applies.");
  const selected = selectedSource ? candidates.find(item => item.source === selectedSource) : candidates.length === 1 ? candidates[0] : undefined;
  return { root: workspace.physicalRoot, commonDir: workspace.identity, candidates, selected };
}
/** Fixed-order comparison of preliminary and native observations, never authority. */
export function specBinding(id: string, root: string, commonDir: string, selected: Pick<SpecCandidate, "source" | "digest">) {
  const descriptor = { version: 1, id, root, commonDir, source: selected.source, digest: selected.digest };
  return { ...descriptor, binding: digest(JSON.stringify(descriptor)) };
}
export function preliminarySpec(root: string, id: string, source?: string) {
  try {
    const found = discoverSpec(root, id, source);
    if (!found.selected) throw new Error(found.candidates.length
      ? `Ambiguous spec-plan ${id}; select an explicit source from: ${found.candidates.map(item => item.source).join(", ")}`
      : `Missing complete spec-plan ${id} for designated root ${root}`);
    return { ...specBinding(id, found.root, found.commonDir, found.selected), content: found.selected.content };
  } catch (error) {
    throw new Error(`${String(error instanceof Error ? error.message : error)}. Reconcile the identified input for ${root} (selector ${source ?? id}); explicitly prepare admission with the intended version. No automatic recapture.`);
  }
}
/** Content identity, not a test receipt. Ignore only native transient workflow artifacts. */
export function checkoutEvidence(root: string) {
  const hash = createHash("sha256");
  // Ref names cannot contain newlines.
  const [head, branch] = gitRead(root, "rev-parse", "HEAD", "--abbrev-ref", "HEAD").trim().split("\n") as [string, string];
  hash.update(head).update(gitRead(root, "diff", "--cached", "--binary"));
  const gitlinks = new Map<string, string[]>();
  for (const entry of gitRead(root, "ls-files", "--stage", "-z").split("\0")) {
    const match = entry.match(/^160000 ([0-9a-f]+) ([0-3])\t([\s\S]+)$/);
    if (match) gitlinks.set(match[3]!, [...(gitlinks.get(match[3]!) ?? []), `${match[1]} ${match[2]}`]);
  }
  const files = gitRead(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean).filter(file => !file.startsWith(".pi/subagents/"));
  for (const file of [...new Set(files)].sort()) {
    const target = path.join(root, file);
    hash.update(file).update("\0");
    try {
      const info = lstatSync(target);
      if (info.isSymbolicLink()) hash.update(readlinkSync(target));
      else if (info.isFile()) hash.update(readFileSync(target)).update(String(info.mode));
      else if (info.isDirectory() && gitlinks.has(file)) {
        hash.update("gitlink").update(JSON.stringify(gitlinks.get(file)));
        // Uninitialized gitlinks have no checkout; initialized ones include nested dirt/bytes.
        let initialized = false;
        try { lstatSync(path.join(target, ".git")); initialized = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        hash.update(initialized ? JSON.stringify(checkoutEvidence(target)) : "uninitialized");
      } else throw new Error(`Unsupported checkout entry: ${file}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") hash.update("missing"); else throw error; }
  }
  return { fingerprint: hash.digest("hex"), head, branch, status: gitRead(root, "status", "--porcelain=v1", "--untracked-files=normal").slice(0, 1000) };
}
