import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { isUtf8 } from "node:buffer";
import { readPlan, workflowWorkspace } from "../workflow.ts";

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
