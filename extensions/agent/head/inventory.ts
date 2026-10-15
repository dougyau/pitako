import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { contains } from "./graph.ts";

export const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const LIMIT = 8 * 1024 * 1024;

/** Plumbing must not invoke repository programs, signing, or interactive/network helpers. */
export function checkpointGitPolicy(root: string): string {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env: localGitEnv(), maxBuffer: LIMIT, stdio: ["pipe", "pipe", "pipe"] }).toString();
  const config = git(["config", "--null", "--list", "--show-origin"]);
  const parts = config.split("\0");
  for (let i = 1; i < parts.length; i += 2) {
    const record = parts[i]!, at = record.indexOf("\n");
    const key = record.slice(0, at).toLowerCase(), value = record.slice(at + 1);
    if ((["core.fsmonitor", "core.sparsecheckout", "commit.gpgsign", "tag.gpgsign"].includes(key) ||
         /^remote\..*\.promisor$/.test(key)) && value !== "false" && value !== "0" ||
        key === "extensions.partialclone") throw new Error("unsupported hook, signing, fsmonitor, promisor or sparse configuration");
  }
  const hooks = git(["rev-parse", "--path-format=absolute", "--git-path", "hooks"]).trim();
  const observed: unknown[] = [];
  if (existsSync(hooks)) {
    if (!lstatSync(hooks).isDirectory() || realpathSync(hooks) !== hooks) throw new Error("uncertain effective Git hook directory");
    for (const name of readdirSync(hooks).sort()) {
      if (name.endsWith(".sample")) continue;
      const file = path.join(hooks, name), stat = lstatSync(file);
      if (!stat.isFile() || stat.mode & 0o111) throw new Error("unsupported executable effective Git hook");
      observed.push([name, digest(readFileSync(file)), stat.mode]);
    }
  } else {
    // existsSync follows links; an absent target is not proof that hook resolution is safe.
    try {
      lstatSync(hooks);
      throw new Error("uncertain effective Git hook directory");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return digest(JSON.stringify([config, hooks, observed]));
}

/** Never inherit a caller's alternate repository, index, config injection or lazy fetch policy. */
export function localGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
}

export interface RawFile {
  kind: "file" | "symlink" | "unsupported";
  digest?: string;
  mode?: number;
}
export interface AdmissionPath {
  path: string;
  eligibility: "clean" | "foreign" | "unsupported";
  reason?: string;
  raw?: RawFile;
  index?: string;
}
export interface SourceInventory {
  root: string;
  repository: string;
  gitDir: string;
  admissionHead: string;
  indexPath: string;
  indexDigest: string;
  flags: string;
  configuration: string;
  attributes: string;
  policy: string;
  paths: AdmissionPath[];
  ignored: string[];
}
export interface Contribution {
  source: { kind: "head" | "leaf"; instanceId: string; groupId: string; historyId: string; sessionId: string;
    runId?: string; effectiveRevision: number; toolCallId: string; toolName: string };
  outcome: "returned" | "threw";
  changes: Array<{ path: string; before?: RawFile; after?: RawFile }>;
}

export function raw(root: string, name: string): RawFile | undefined {
  try {
    const absolute = path.join(root, name), stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return { kind: "symlink" };
    if (!stat.isFile() || stat.size > LIMIT) return { kind: "unsupported" };
    // A regular final entry under a symlinked directory is still unsupported.
    if (realpathSync(absolute) !== absolute) return { kind: "symlink" };
    return { kind: "file", digest: digest(readFileSync(absolute)), mode: stat.mode & 0o111 ? 0o100755 : 0o100644 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Immutable eligibility, mutable observations. Scans cannot promote a foreign admission preimage. */
export class AdmissionInventory {
  private baseline?: SourceInventory;
  private unavailable?: string;
  private expected = new Map<string, RawFile | undefined>();
  private contributions: Contribution[] = [];
  private gaps = new Set<string>();

  constructor(readonly root: string, readonly envelope: readonly string[], adopted?: {
    admission: SourceInventory; saved: Array<{ path: string; raw?: RawFile }>;
  }) {
    try {
      this.baseline = this.capture();
      for (const entry of this.baseline.paths) this.expected.set(entry.path, entry.raw);
      if (adopted) {
        // Keep original foreign exclusions. Saved bytes are expected observations, not a new preimage.
        const entries = new Map(this.baseline.paths.map(entry => [entry.path, entry]));
        for (const entry of adopted.admission.paths) entries.set(entry.path, structuredClone(entry));
        for (const saved of adopted.saved) {
          if (!adopted.admission.paths.some(entry => entry.path === saved.path)) {
            entries.set(saved.path, { path: saved.path, eligibility: "clean" });
          }
          this.expected.set(saved.path, saved.raw);
        }
        this.baseline.paths = [...entries.values()];
        this.baseline.ignored = [...new Set([...adopted.admission.ignored, ...this.baseline.ignored])];
      }
    } catch (error) { this.unavailable = String(error); }
  }
  private git(args: string[], input?: string | Buffer): Buffer {
    return execFileSync("git", args, { cwd: this.root, env: localGitEnv(), input, maxBuffer: LIMIT, stdio: ["pipe", "pipe", "pipe"] });
  }
  private within(name: string, writes = this.envelope): boolean {
    return writes.some(write => contains(write, path.join(this.root, name)));
  }
  private names(args: string[]): string[] {
    const bytes = this.git(args);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw new Error("inventory contains non-UTF-8 paths");
    const names = text.split("\0").filter(Boolean);
    if (names.length > 20000) throw new Error("inventory exceeds 20000 paths");
    return names;
  }
  private config(): string {
    return checkpointGitPolicy(this.root);
  }
  private policy(): string {
    const names = this.names(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
      ".gitignore", ".gitattributes", ":(glob)**/.gitignore", ":(glob)**/.gitattributes"]);
    const files = new Set(names.map(name => path.join(this.root, name)));
    for (const file of ["info/exclude", "info/attributes"]) {
      files.add(this.git(["rev-parse", "--path-format=absolute", "--git-path", file]).toString().trim());
    }
    // --get can return 1 for an unset optional file. Other failures remain unavailable.
    for (const key of ["core.excludesFile", "core.attributesFile"]) {
      try { files.add(path.resolve(this.root, this.git(["config", "--path", "--get", key]).toString().trim())); }
      catch (error) {
        if ((error as { status?: number }).status !== 1) throw error;
        files.add(path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "git",
          key === "core.excludesFile" ? "ignore" : "attributes"));
      }
    }
    return JSON.stringify([...files].sort().map(file => {
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size > LIMIT) throw new Error("unsupported ignore/attribute policy");
        return [file, digest(readFileSync(file))];
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [file, "absent"]; throw error; }
    }));
  }
  private capture(): SourceInventory {
    if (this.git(["rev-parse", "--is-bare-repository"]).toString().trim() !== "false") throw new Error("bare repository");
    const root = realpathSync(this.git(["rev-parse", "--show-toplevel"]).toString().trim());
    if (root !== this.root) throw new Error("inventory root is not the actual launch worktree");
    const configuration = this.config();
    const admissionHead = this.git(["rev-parse", "--verify", "HEAD^{commit}"]).toString().trim();
    const indexPath = this.git(["rev-parse", "--path-format=absolute", "--git-path", "index"]).toString().trim();
    const flags = this.git(["ls-files", "-v", "-z"]).toString();
    const stage = this.names(["ls-files", "--stage", "-z"]);
    const tree = new Map(this.names(["ls-tree", "-r", "-z", "HEAD"]).map(record => {
      const tab = record.indexOf("\t");
      return [record.slice(tab + 1), record.slice(0, tab).replace(" blob ", " ")];
    }));
    const indexed = new Map<string, string[]>();
    for (const record of stage) {
      const tab = record.indexOf("\t"), name = record.slice(tab + 1);
      indexed.set(name, [...(indexed.get(name) ?? []), record.slice(0, tab)]);
    }
    const untracked = this.names(["ls-files", "--others", "--exclude-standard", "-z"]);
    const ignored = this.names(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
      .filter(name => this.within(name) || this.envelope.some(write => contains(path.join(root, name), write)));
    const names = [...new Set([...indexed.keys(), ...tree.keys(), ...untracked])].filter(name => this.within(name));
    const attributes = this.git(["check-attr", "--all", "-z", "--stdin"], names.join("\0") + (names.length ? "\0" : "")).toString();
    const attrParts = attributes.split("\0"), unsupported = new Set<string>();
    for (let i = 0; i + 2 < attrParts.length; i += 3) {
      if (["filter", "working-tree-encoding"].includes(attrParts[i + 1]!) && !["unset", "unspecified"].includes(attrParts[i + 2]!)) {
        unsupported.add(attrParts[i]!);
      }
    }
    const flagMap = new Map(flags.split("\0").filter(Boolean).map(record => [record.slice(2), record[0]]));
    const paths = names.map((name): AdmissionPath => {
      const entries = indexed.get(name), file = raw(root, name);
      const index = entries?.[0], head = tree.get(name);
      if (entries?.length !== 1 || !index?.endsWith(" 0") || !/^100(644|755) /.test(index) ||
          (file && file.kind !== "file") || unsupported.has(name) || (flagMap.get(name) !== undefined && flagMap.get(name) !== "H")) {
        return { path: name, eligibility: entries ? "unsupported" : "foreign", reason: "untracked, unresolved, flagged or unsupported type", raw: file, index };
      }
      // hash-object without -w observes supported Git text/EOL semantics, never writes an object.
      const working = file?.kind === "file"
        ? this.git(["hash-object", `--path=${name}`, "--stdin"], readFileSync(path.join(root, name))).toString().trim() : undefined;
      const clean = index.slice(0, -2) === head && working === index.split(" ")[1] && file?.mode?.toString(8) === index.split(" ")[0];
      return { path: name, eligibility: clean ? "clean" : "foreign", reason: clean ? undefined : "foreign staged or working preimage", raw: file, index };
    });
    return { root, repository: realpathSync(this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim()),
      gitDir: realpathSync(this.git(["rev-parse", "--absolute-git-dir"]).toString().trim()), admissionHead, indexPath,
      indexDigest: existsSync(indexPath) ? digest(readFileSync(indexPath)) : "absent", flags, configuration, attributes,
      policy: this.policy(), paths, ignored };
  }
  snapshot() {
    return structuredClone({ admission: this.baseline, unavailable: this.unavailable,
      contributions: this.contributions, gaps: [...this.gaps] });
  }
  sources(historyId: string): Contribution["source"][] {
    return this.contributions.filter(entry => entry.source.historyId === historyId).map(entry => ({ ...entry.source }));
  }
  eligibility(name: string): { eligible: boolean; reason?: string } {
    const b = this.baseline;
    if (!b) return { eligible: false, reason: this.unavailable };
    if (!name || path.isAbsolute(name) || path.normalize(name) !== name || name.startsWith("../")) {
      return { eligible: false, reason: "invalid repository-relative path" };
    }
    if (!this.within(name)) return { eligible: false, reason: "outside envelope" };
    if (b.ignored.some(ignored => contains(path.join(this.root, ignored), path.join(this.root, name)))) {
      return { eligible: false, reason: "ignored at admission" };
    }
    if (b.paths.some(entry => entry.eligibility === "unsupported" && name.startsWith(entry.path + "/"))) {
      return { eligible: false, reason: "unsupported admission ancestor" };
    }
    try {
      for (let parent = path.join(this.root, name); parent !== this.root; parent = path.dirname(parent)) {
        try {
          if (lstatSync(parent).isSymbolicLink()) return { eligible: false, reason: "symlink path" };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } catch (error) { return { eligible: false, reason: `incomplete path observation: ${String(error)}` }; }
    const entry = b.paths.find(entry => entry.path === name);
    if (entry) return entry.eligibility === "clean" ? { eligible: true } : { eligible: false, reason: entry.reason };
    try {
      if (this.policy() !== b.policy) return { eligible: false, reason: "ignore/attribute policy drift" };
      try {
        this.git(["check-ignore", "--no-index", "--quiet", "--", name]);
        return { eligible: false, reason: "ignored at admission" };
      } catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
      const attrs = this.git(["check-attr", "-z", "filter", "working-tree-encoding", "--", name]).toString().split("\0");
      for (let i = 0; i + 2 < attrs.length; i += 3) {
        if (!["unset", "unspecified"].includes(attrs[i + 2]!)) return { eligible: false, reason: "unsupported attributes" };
      }
      return { eligible: true };
    } catch (error) { return { eligible: false, reason: `incomplete eligibility: ${String(error)}` }; }
  }
  private scan(writes: readonly string[]): Map<string, RawFile | undefined> {
    const names = new Set([...this.expected.keys(),
      ...this.names(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])]);
    return new Map([...names].filter(name => this.within(name, writes)).map(name => [name, raw(this.root, name)]));
  }
  private identity(): void {
    const b = this.baseline!;
    if (realpathSync(this.root) !== b.root || this.git(["rev-parse", "HEAD"]).toString().trim() !== b.admissionHead ||
        (existsSync(b.indexPath) ? digest(readFileSync(b.indexPath)) : "absent") !== b.indexDigest ||
        realpathSync(this.git(["rev-parse", "--absolute-git-dir"]).toString().trim()) !== b.gitDir ||
        realpathSync(this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim()) !== b.repository ||
        this.config() !== b.configuration || this.policy() !== b.policy) {
      this.gaps.add("repository, HEAD, real index, configuration or policy drift");
    }
  }
  observe(writes = this.envelope): Map<string, RawFile | undefined> {
    if (!this.baseline) return new Map();
    try {
      this.identity();
      const current = this.scan(writes);
      for (const [name, file] of current) if (!same(file, this.expected.get(name))) this.gaps.add(`unattributed change: ${name}`);
      return current;
    } catch (error) { this.gaps.add(`incomplete scan: ${String(error)}`); return new Map(); }
  }
  contributed(before: Map<string, RawFile | undefined>, source: Contribution["source"], outcome: Contribution["outcome"],
    writes: readonly string[]): void {
    if (!this.baseline) return;
    try {
      this.identity();
      const after = this.scan(writes);
      const changes = [...after].filter(([name, file]) => !same(file, before.get(name)))
        .map(([name, file]) => ({ path: name, before: before.get(name), after: file }));
      this.contributions.push({ source: structuredClone(source), outcome, changes });
      for (const [name, file] of after) this.expected.set(name, file);
      if (this.contributions.length > 2048) { this.contributions.shift(); this.gaps.add("earlier contributions omitted"); }
    } catch (error) { this.gaps.add(`incomplete contribution scan: ${String(error)}`); }
  }
}
