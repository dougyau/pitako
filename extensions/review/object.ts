import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { isUtf8 } from "node:buffer";
import { readPlan, workflowWorkspace, verifyExecutionBinding, type ExecutionBinding } from "../workflow.ts";
import { candidateFingerprint } from "../agent/head/gates.ts";
import type { FreezeCandidate } from "../workflow-planning.ts";

const text = Type.String({ minLength: 1 }), strict = { additionalProperties: false } as const;
export const objectSchema = Type.Union([
  Type.Object({ kind: Type.Literal("plan"), planId: text }, strict),
  Type.Object({ kind: Type.Literal("diff"), base: text }, strict),
  Type.Object({ kind: Type.Literal("brief"), text }, strict),
]);
export type ObjectSelector = Static<typeof objectSchema>;
export interface ReviewObject {
  selector: ObjectSelector; root: string; identity: string; scope: unknown;
  limits: string[];
  source?: CapturedReviewSource;
}
export type CapturedReviewSource = { kind: "local-selector"; selector: ObjectSelector } |
  { kind: "managed-candidate"; candidate: FreezeCandidate } | { kind: "managed-execution"; binding: ExecutionBinding };
export const executionExclusions = [".git", "node_modules", ".codegraph", ".pitako/runs", ".pitako/gates", ".pitako/sessions", ".pitako/table-results"];
export const executionFingerprint = (root: string) => candidateFingerprint(root, executionExclusions);
export function captureExecutionObject(binding: ExecutionBinding): ReviewObject {
  verifyExecutionBinding(binding);
  return { selector: { kind: "brief", text: `Whole execution review of frozen plan ${binding.planId}@${binding.revision}:${binding.hash}.
Explore the complete local implementation and tests at this root against the frozen plan. No Git, base, credentials or publication required.
Exclude only ${executionExclusions.join(", ")}. Review all relevant files, not only a result summary.` },
    root: binding.executionRoot, identity: executionFingerprint(binding.executionRoot), scope: { binding },
    source: { kind: "managed-execution", binding },
    limits: ["Complete local execution root, not a Git diff. Endpoint fingerprints do not promise transactional or immutable exploration."] };
}
export function captureReviewSource(source: CapturedReviewSource, cwd: string): ReviewObject {
  if (source.kind === "local-selector") return captureObject(source.selector, cwd);
  if (source.kind === "managed-execution") return captureExecutionObject(source.binding);
  const candidate = source.candidate;
  return { selector: { kind: "plan", planId: candidate.expectedDraft.meta!.id }, root: realpathSync(workflowWorkspace(cwd)),
    identity: candidate.objectHash, scope: { file: candidate.expectedDraft.file, revision: candidate.expectedDraft.revision,
      text: candidate.consultedText }, source,
    limits: ["Immutable host FreezeCandidate; paths are provenance, not a mutable source.",
      "Operational Planning workers are excluded; the frozen status transformation was precomputed."] };
}
/** Exploration coordinates from the private capture, never captured document or patch bytes. */
export function describeObject(object: ReviewObject) {
  const common = { selector: structuredClone(object.selector), root: object.root, identity: object.identity, limits: [...object.limits] };
  if (object.selector.kind === "plan") {
    const { file, revision } = object.scope as { file: string; revision: number };
    if (object.source?.kind === "managed-candidate") {
      const candidate = object.source.candidate;
      return { ...common, file, revision, candidateId: candidate.candidateId, text: candidate.consultedText,
        expectedDraft: { fileHash: candidate.expectedDraft.fileHash, objectHash: candidate.expectedDraft.objectHash, revision: candidate.expectedDraft.revision },
        frozenHash: candidate.fileHash, transformations: candidate.transformations };
    }
    return { ...common, file, revision,
      exploration: "Read the plan locally. Exclude only the actual ATX H2 Planning workers section through the next H1/H2 (ATX or Setext). Ignore headings inside fenced code or HTML comments; preserve frontmatter and all other content." };
  }
  if (object.selector.kind === "diff") {
    const { base, mergeBase, head } = object.scope as { base: string; mergeBase: string; head: string };
    return { ...common, base, mergeBase, head,
      exploration: "Explore locally without fetch: committed changes from mergeBase to head, staged changes against head, and current raw working bytes, deletions and untracked files. This is not git diff HEAD alone. Do not apply external diff, textconv or clean/smudge filters. The endpoint fingerprint does not promise immutable exploration." };
  }
  return common; // The brief selector itself carries the assignment text.
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Headings inside comments or fenced code do not delimit operational sections. */
export function consultedPlan(text: string): string {
  let fence: { marker: string; length: number } | undefined, omit = false, comment = false;
  let frontmatter = /^---\r?\n/.test(text);
  return text.split(/(?<=\n)/).filter((line, index, lines) => {
    if (frontmatter) {
      if (index && /^---\r?\n?$/.test(line)) frontmatter = false;
      return true;
    }
    const marker = !comment && line.match(/^ {0,3}(`{3,}|~{3,})(.*)/);
    if (marker) {
      if (!fence) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      return !omit;
    }
    if (fence) return !omit;
    // Mask comments for boundary detection only; retain the original Markdown bytes.
    let heading = line;
    for (let offset = 0; offset < line.length;) {
      const start = comment ? offset : line.indexOf("<!--", offset);
      if (start < 0) break;
      const close = line.indexOf("-->", start + (comment ? 0 : 4));
      const end = close < 0 ? line.length : close + 3;
      heading = heading.slice(0, start) + line.slice(start, end).replace(/[^\r\n]/g, " ") + heading.slice(end);
      comment = close < 0;
      offset = end;
    }
    if (/^ {0,3}#{1,2}(?:\s|$)/.test(heading)) {
      omit = /^ {0,3}##[ \t]+Planning workers(?:[ \t]+#+)?[ \t]*\r?\n?$/.test(heading);
    }
    // Setext H1/H2 also ends this section; retain its title, not just its underline.
    if (!comment && /^ {0,3}[^ \t\r\n#>*+-]/.test(heading) && !/^ {0,3}\d+[.)]\s/.test(heading) &&
      /^ {0,3}(?:=+|-+)[ \t]*\r?\n?$/.test(lines[index + 1] ?? "")) omit = false;
    return !omit;
  }).join("");
}

/** Fixed local read commands only. No external diff, textconv, filters, network or lazy fetch. */
export function captureObject(selector: ObjectSelector, cwd: string): ReviewObject {
  const root = realpathSync(workflowWorkspace(cwd));
  const limits = ["Endpoint fingerprints are not transactional, ABA-proof, or a guarantee during disposal or after delivery."];
  let scope: unknown;
  if (selector.kind === "brief") {
    if (!selector.text.trim()) throw new Error("review brief must not be empty");
    scope = { text: selector.text };
    limits.push("A bounded brief is not whole-plan critique or final whole-diff review.");
  } else if (selector.kind === "plan") {
    const { file, text, meta } = readPlan(selector.planId, root);
    scope = { file, planId: meta.id, revision: meta.revision, text: consultedPlan(text) };
    limits.push("Only the actual Planning workers section is excluded; workflow execution hashes remain unchanged.");
  } else {
    const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" };
    for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_KEY_|CONFIG_VALUE_)/.test(key)) delete env[key as keyof typeof env];
    const git = (args: string[]) => {
      const bytes = execFileSync("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.quotePath=true",
        ...args], { cwd: root, env, maxBuffer: 32 * 1024 * 1024, timeout: 10000 });
      if (!isUtf8(bytes)) throw new Error("review capture unsupported scope: non-UTF8 Git path/output");
      return bytes.toString("utf8");
    };
    if (!selector.base.trim()) throw new Error("review diff requires explicit local base");
    const base = git(["rev-parse", "--verify", "--end-of-options", `${selector.base}^{commit}`]).trim();
    const head = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    const mergeBase = git(["merge-base", base, head]).trim();
    const diff = (args: string[]) => git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index", "--no-renames", ...args, "--"]);
    const tracked = git(["ls-files", "--stage", "-z"]);
    if (tracked.split("\0").some(entry => entry.startsWith("160000 "))) throw new Error("review capture unsupported scope: submodules");
    if (tracked.split("\0").some(entry => entry && !/^\d+ [a-f0-9]+ 0\t/.test(entry))) throw new Error("review capture unsupported scope: unmerged index");
    if (git(["ls-files", "-v", "-z"]).split("\0").some(entry => /^[sS] /.test(entry))) throw new Error("review capture unsupported scope: sparse/skip-worktree index");
    const manifest = (text: string, index: boolean) => new Map(text.split("\0").filter(Boolean).map(entry => {
      const match = entry.match(index ? /^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/ : /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/);
      if (!match) throw new Error("review capture unsupported scope: non-blob tree or index entry");
      return [match[3]!, { mode: match[1]!, oid: match[2]! }];
    }));
    const original = manifest(git(["ls-tree", "-r", "-z", mergeBase]), false);
    const currentHead = manifest(git(["ls-tree", "-r", "-z", head]), false);
    const index = manifest(tracked, true);
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    const names = [...new Set([...original.keys(), ...currentHead.keys(), ...index.keys(), ...untracked])].sort();
    if (names.length > 20000) throw new Error("review capture exceeds 20000 paths");
    const files = names.map(name => {
      const absolute = path.join(root, name);
      try {
        // Never follow a symlinked parent out of the canonical root.
        const parent = realpathSync(path.dirname(absolute));
        if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error(`review capture escapes root: ${name}`);
        const stat = lstatSync(absolute);
        if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`review capture unsupported file: ${name}`);
        if (stat.size > 16 * 1024 * 1024) throw new Error(`review capture oversized file: ${name}`);
        const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
        const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
        const oid = createHash(head.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        const unchanged = [original.get(name), currentHead.get(name), index.get(name)].every(entry => entry?.mode === mode && entry.oid === oid);
        if (unchanged) return undefined;
        return { path: name, mode, hash: digest(bytes), contentBase64: bytes.toString("base64"), ...(isUtf8(bytes) ? { text: bytes.toString("utf8") } : {}) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: name, deleted: true };
        throw error;
      }
    }).filter(Boolean);
    scope = { base, mergeBase, head, committed: diff([`${mergeBase}..${head}`]),
      staged: diff(["--cached", head]), files };
    limits.push("Working bytes are captured raw, without clean/smudge filters or text conversion. Binary contents use base64.");
  }
  return { selector: structuredClone(selector), root, scope, identity: digest(JSON.stringify({ selector, root, scope })), limits };
}
