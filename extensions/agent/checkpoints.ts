import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { WorkerHistory, type HistoryGroup } from "./history.ts";
import { assertCheckpointWorkersReleased } from "./background.ts";
import { executionForSession } from "../execution-identity.ts";
import { ledgerFile, parseLedgerBinding, readLedgerTeamHolds, verifyExecutionBinding } from "../workflow.ts";
import { contains } from "./head/graph.ts";
import { AdmissionInventory, checkpointGitPolicy, digest, localGitEnv, raw, type Contribution, type RawFile, type SourceInventory } from "./head/inventory.ts";
import type { ManagedAssignment } from "./head/managed-tools.ts";

export interface CheckpointOrigin { assignmentId: string; checkpointId: string; commit: string }
export type CheckpointNative = ReturnType<ManagedAssignment["snapshot"]>["native"][number];
export interface CheckpointManifest {
  version: 1;
  assignmentId: string;
  checkpointId: string;
  ref: string;
  origin?: CheckpointOrigin;
  admission: SourceInventory;
  parent: string;
  tree: string;
  head: CheckpointNative["source"];
  selected: string[];
  omitted: string[];
  rejected: Array<{ path: string; reasons: string[] }>;
  saved: Array<{ path: string; raw?: RawFile; git?: string }>;
  contributors: Array<{ assignmentId: string; contribution: Contribution; inherited: boolean }>;
  native: Array<CheckpointNative & { assignmentId: string; inherited: boolean; testedSource: "not_recorded" }>;
  evidence: string[];
  summary: string;
  remaining: string[];
  limits: string[];
  graph: unknown;
  gaps: string[];
}
export const CHECKPOINT_PREFIX = "refs/pitako/checkpoints/";
export const MANIFEST_LIMIT = 512 * 1024;
export const MANIFEST_MARKER = "Pitako local checkpoint v1\n\n";
const id = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("invalid checkpoint identity");
  return value;
};
export function checkpointRef(root: string, assignmentId: string, checkpointId: string): string {
  return `${CHECKPOINT_PREFIX}${digest(root)}/${id(assignmentId)}/${id(checkpointId)}`;
}
export function checkpointGit(root: string, args: string[], input?: string | Buffer, env = localGitEnv()): Buffer {
  return execFileSync("git", args, { cwd: root, env, input, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}
const textGit = (root: string, args: string[]) => checkpointGit(root, args).toString().trim();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const literal = (name: unknown): name is string => typeof name === "string" && !!name && !name.includes("\0") &&
  !path.isAbsolute(name) && path.normalize(name) === name && name !== "." && !name.startsWith("../") &&
  name !== ".git" && !name.startsWith(".git/");

function treePaths(root: string, tree: string): Map<string, string> {
  const bytes = checkpointGit(root, ["ls-tree", "-r", "-z", tree]), text = bytes.toString();
  if (!Buffer.from(text).equals(bytes)) throw new Error("non-UTF-8 checkpoint tree");
  return new Map(text.split("\0").filter(Boolean).map(record => {
    const at = record.indexOf("\t");
    return [record.slice(at + 1), record.slice(0, at)];
  }));
}
export function treeDelta(root: string, before: string, after: string): string[] {
  const a = treePaths(root, before), b = treePaths(root, after);
  return [...new Set([...a.keys(), ...b.keys()])].filter(name => a.get(name) !== b.get(name)).sort();
}
export function treePath(root: string, tree: string, name: string): string | undefined { return treePaths(root, tree).get(name); }

function checkoutObservation(root: string) {
  try {
    checkpointGitPolicy(root);
    if (checkpointGit(root, ["ls-files", "--stage", "-z"]).toString().split("\0").some(entry => entry.startsWith("160000 "))) {
      throw new Error("unsupported submodule checkout observation");
    }
    const names = checkpointGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    const attributes = checkpointGit(root, ["check-attr", "--all", "-z", "--stdin"], names).toString().split("\0");
    for (let i = 0; i + 2 < attributes.length; i += 3) {
      if (["filter", "working-tree-encoding"].includes(attributes[i + 1]!) &&
          !["unset", "unspecified"].includes(attributes[i + 2]!)) throw new Error("unsupported checkout attributes");
    }
    const status = checkpointGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).toString();
    return { checkoutDirt: status.split("\0").filter(Boolean), checkoutObservationGaps: [] as string[] };
  } catch (error) { return { checkoutDirt: [], checkoutObservationGaps: [String(error)] }; }
}

/** Commit data is untrusted: bound it and verify its relationships against actual Git objects. */
export function readCheckpoint(root: string, origin: CheckpointOrigin, agentDir = getAgentDir()) {
  root = realpathSync(root);
  const ref = checkpointRef(root, origin.assignmentId, origin.checkpointId);
  const commit = textGit(root, ["rev-parse", "--verify", ref]);
  if (commit !== origin.commit) throw new Error("checkpoint ref/commit mismatch");
  const object = checkpointGit(root, ["cat-file", "commit", commit]).toString();
  if (Buffer.byteLength(object) > MANIFEST_LIMIT + 16384) throw new Error("checkpoint manifest exceeds limit");
  const separator = object.indexOf("\n\n"), headers = object.slice(0, separator).split("\n"), message = object.slice(separator + 2);
  if (!message.startsWith(MANIFEST_MARKER)) throw new Error("unsupported checkpoint message");
  const value: unknown = JSON.parse(message.slice(MANIFEST_MARKER.length));
  const m = validateManifest(value);
  if (m.assignmentId !== origin.assignmentId || m.checkpointId !== origin.checkpointId || m.ref !== ref ||
      m.admission.root !== root || m.admission.gitDir !== realpathSync(textGit(root, ["rev-parse", "--absolute-git-dir"])) ||
      m.admission.repository !== realpathSync(textGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) ||
      headers.filter(header => header.startsWith("parent ")).join() !== `parent ${m.parent}` ||
      !headers.includes(`tree ${m.tree}`)) throw new Error("checkpoint repository, parent, tree or identity mismatch");
  if (!m.selected.every(literal) || !m.saved.every(entry => literal(entry.path)) ||
      new Set(m.selected).size !== m.selected.length || new Set(m.saved.map(entry => entry.path)).size !== m.saved.length) {
    throw new Error("invalid checkpoint path inventory");
  }
  const cumulative = treeDelta(root, m.admission.admissionHead, m.tree);
  if (!same(cumulative, m.saved.map(entry => entry.path).sort()) ||
      treeDelta(root, m.parent, m.tree).some(name => !m.selected.includes(name))) throw new Error("checkpoint tree inventory mismatch");
  for (const saved of m.saved) {
    const actual = treePath(root, m.tree, saved.path);
    if (actual !== saved.git || actual && (!/^100(644|755) blob [a-f0-9]+$/.test(actual) || saved.raw?.kind !== "file" ||
        Number.parseInt(actual.slice(0, 6), 8) !== saved.raw.mode) ||
        !actual && saved.raw !== undefined) throw new Error("checkpoint saved Git/raw identity mismatch");
  }
  const history = checkpointHistory(m, agentDir);
  const current = m.saved.map(entry => {
    const current = raw(root, entry.path);
    return { path: entry.path, saved: entry.raw, current, matches: same(entry.raw, current) };
  });
  return { origin, ref, commit, manifest: m, current, ...checkoutObservation(root),
    historicalEvidence: { native: m.native, evidence: m.evidence, testedSource: "not_recorded" as const, ...history } };
}

// Validate the complete authority-bearing shape, not arbitrary extra prose/graph fields.
function validateManifest(value: unknown): CheckpointManifest {
  if (!value || typeof value !== "object") throw new Error("invalid checkpoint manifest");
  const m = value as CheckpointManifest;
  if (m.version !== 1 || typeof m.assignmentId !== "string" || typeof m.checkpointId !== "string" ||
      typeof m.ref !== "string" || typeof m.parent !== "string" || typeof m.tree !== "string" ||
      !/^[a-f0-9]+$/.test(m.parent) || !/^[a-f0-9]+$/.test(m.tree) ||
      !m.admission || typeof m.admission.root !== "string" || typeof m.admission.repository !== "string" ||
      typeof m.admission.gitDir !== "string" || typeof m.admission.admissionHead !== "string" ||
      !/^[a-f0-9]+$/.test(m.admission.admissionHead) ||
      typeof m.admission.indexPath !== "string" || typeof m.admission.indexDigest !== "string" ||
      !["configuration", "policy", "flags", "attributes"].every(key => typeof m.admission[key as keyof SourceInventory] === "string") ||
      !Array.isArray(m.admission.paths) || !m.admission.paths.every(entry => entry && literal(entry.path) &&
        ["clean", "foreign", "unsupported"].includes(entry.eligibility) && validRaw(entry.raw)) ||
      !Array.isArray(m.admission.ignored) || !m.admission.ignored.every(name => typeof name === "string") ||
      !validSource(m.head) || !Number.isSafeInteger(m.head.observedRevision) || m.head.observedRevision < 0 ||
      !Array.isArray(m.selected) || !Array.isArray(m.omitted) || !m.omitted.every(literal) ||
      !Array.isArray(m.saved) || !m.saved.every(entry => entry && literal(entry.path) && validRaw(entry.raw) &&
        (entry.git === undefined || typeof entry.git === "string")) ||
      !Array.isArray(m.contributors) || !m.contributors.every(entry => entry && typeof entry.assignmentId === "string" &&
        typeof entry.inherited === "boolean" && entry.contribution && ["returned", "threw"].includes(entry.contribution.outcome) &&
        validSource(entry.contribution.source) &&
        Number.isSafeInteger(entry.contribution.source.effectiveRevision) && entry.contribution.source.effectiveRevision >= 0 &&
        Array.isArray(entry.contribution.changes) && entry.contribution.changes.every(change => literal(change.path) &&
          validRaw(change.before) && validRaw(change.after))) ||
      !Array.isArray(m.native) || !m.native.every(entry => validSource(entry.source) && typeof entry.assignmentId === "string" &&
        Number.isSafeInteger(entry.source.observedRevision) && entry.source.observedRevision >= 0 &&
        Array.isArray(entry.entries) && entry.entries.every(result => result && ["entryId", "toolCallId", "toolName", "digest", "excerpt"]
          .every(key => typeof result[key as keyof typeof result] === "string") && typeof result.isError === "boolean") &&
        typeof entry.inherited === "boolean" && entry.testedSource === "not_recorded" &&
        ["observed", "released", "unknown"].includes(entry.closure) &&
        Array.isArray(entry.gaps) && entry.gaps.every(gap => typeof gap === "string")) ||
      !Array.isArray(m.gaps) || !m.gaps.every(gap => typeof gap === "string") ||
      !Array.isArray(m.evidence) || !m.evidence.every(entry => typeof entry === "string")) throw new Error("invalid checkpoint manifest");
  return m;
}
function validRaw(value: RawFile | undefined): boolean {
  return value === undefined || !!value && ["symlink", "unsupported"].includes(value.kind) || !!value && value.kind === "file" && typeof value.digest === "string" &&
    /^[a-f0-9]{64}$/.test(value.digest) && [0o100644, 0o100755].includes(value.mode!);
}
function validSource(value: Pick<Contribution["source"], "kind" | "instanceId" | "groupId" | "historyId" | "sessionId" | "runId"> | undefined): boolean {
  return !!value && ["head", "leaf"].includes(value.kind) &&
    ["instanceId", "groupId", "historyId", "sessionId"].every(key => typeof value[key as keyof typeof value] === "string") &&
    (value.kind !== "leaf" || typeof value.runId === "string");
}

export function listCheckpoints(root: string, assignmentId?: string) {
  root = realpathSync(root);
  const prefix = `${CHECKPOINT_PREFIX}${digest(root)}/${assignmentId ? `${id(assignmentId)}/` : ""}`;
  return checkpointGit(root, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]).toString().trim().split("\n").filter(Boolean)
    .map(record => {
      const [ref, commit] = record.split(" "), pieces = ref!.split("/");
      return { ref: ref!, assignmentId: pieces.at(-2)!, checkpointId: pieces.at(-1)!, commit: commit! };
    });
}

/** Exact linked members, including sealed leaf invocation groups; group completion is not required. */
function checkpointHistory(manifest: CheckpointManifest, agentDir: string) {
  const gaps: string[] = [], records: Array<{ group: HistoryGroup; historyId: string }> = [];
  let store: WorkerHistory;
  try { store = new WorkerHistory(agentDir, { initialize: false }); }
  catch (error) { return { closureGaps: [`Worker history unavailable: ${String(error)}`], members: [] }; }
  const sources = [{ assignmentId: manifest.assignmentId, source: manifest.head },
    ...manifest.contributors.map(entry => ({ assignmentId: entry.assignmentId, source: entry.contribution.source }))];
  const seen = new Set<string>();
  for (const { assignmentId, source } of sources) {
    const key = `${source.groupId}/${source.historyId}`;
    const identity = JSON.stringify([assignmentId, source]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    try {
      const group = store.read(source.groupId);
      const member = group.members.find(member => member.historyId === source.historyId);
      const captured = manifest.native.find(entry => entry.assignmentId === assignmentId &&
        entry.source.groupId === source.groupId && entry.source.historyId === source.historyId)?.source;
      if (group.workspace !== manifest.admission.root || !member || member.assignmentId !== assignmentId ||
          member.instanceId !== source.instanceId || member.native.state !== "allocated" ||
          member.native.sessionId !== source.sessionId || !captured || captured.sessionId !== source.sessionId ||
          captured.instanceId !== source.instanceId || source.kind === "leaf" &&
          (member.head?.assignmentId !== assignmentId || member.head.runId !== source.runId ||
           member.head.headInstanceId !== manifest.native.find(entry => entry.assignmentId === assignmentId && entry.source.kind === "head")?.source.instanceId ||
           member.head.effectiveRevision !== captured.observedRevision ||
           "effectiveRevision" in source && source.effectiveRevision > captured.observedRevision)) throw new Error("mismatched linked history member");
      records.push({ group, historyId: source.historyId });
      if (!member.terminal || !["completed", "failed", "cancelled"].includes(member.terminal.status) ||
          typeof member.terminal.at !== "string" || member.native.disposition.state !== "disposed" ||
          typeof member.native.disposition.at !== "string" || !["unclosed", "closed"].includes(group.closure.state) ||
          !["invocation", "execution"].includes(group.identity.kind) ||
          group.cleanup || group.prunedAt) gaps.push(`No positive terminal/disposed closure: ${key}`);
      if (executionForSession(source.sessionId)) gaps.push(`Live native owner: ${key}`);
      assertCheckpointWorkersReleased(source.instanceId, assignmentId);
      // The durable catalog points to the native stream; never initialize/resume it here.
      if (!existsSync(member.native.path) || !lstatSync(member.native.path).isFile()) {
        gaps.push(`Missing native history: ${key}`);
      } else {
        const native = readFileSync(member.native.path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
        if (!native.some(entry => entry.type === "session" && entry.id === source.sessionId)) gaps.push(`Native session mismatch: ${key}`);
        for (const capture of manifest.native.filter(entry => entry.source.historyId === source.historyId)) {
          for (const result of capture.entries) {
            const entry = native.find(entry => entry.id === result.entryId);
            if (entry?.type !== "message" || entry.message?.role !== "toolResult" ||
                entry.message.toolCallId !== result.toolCallId || entry.message.toolName !== result.toolName ||
                Boolean(entry.message.isError) !== result.isError ||
                digest(JSON.stringify({ content: entry.message.content, details: entry.message.details })) !== result.digest) {
              gaps.push(`Unpersisted or mismatched native result: ${key}/${result.entryId}`);
            }
          }
        }
      }
      if (group.identity.kind === "execution") {
        const match = /^(.+)@(\d+):([a-f0-9]+)$/.exec(group.identity.executionRef);
        if (!match) throw new Error("invalid execution history identity");
        const saved = parseLedgerBinding(readFileSync(ledgerFile(match[1]!, group.identity.executionRoot), "utf8"));
        if (!saved.planSource || saved.executionRoot !== group.identity.executionRoot ||
            saved.revision !== Number(match[2]) || saved.hash !== match[3]) throw new Error("execution ledger/history mismatch");
        const binding = { planId: match[1]!, revision: Number(match[2]), hash: match[3]!, executionRoot: group.identity.executionRoot,
          planSource: saved.planSource };
        verifyExecutionBinding(binding);
        if (readLedgerTeamHolds(group.identity.executionRoot, match[1]!, binding).some(hold => hold.assignmentId === assignmentId)) {
          gaps.push(`Unreconciled execution hold: ${assignmentId}`);
        }
      }
    } catch (error) { gaps.push(`${key}: ${String(error)}`); }
  }
  return { closureGaps: gaps, members: records.map(record => ({ groupId: record.group.groupId, historyId: record.historyId,
    historyGaps: record.group.members.find(member => member.historyId === record.historyId)?.gaps ?? [] })) };
}

export function adoptCheckpoint(root: string, origin: CheckpointOrigin, envelope: readonly string[], agentDir = getAgentDir()): CheckpointManifest {
  const read = readCheckpoint(root, origin, agentDir), m = read.manifest;
  if (read.historicalEvidence.closureGaps.length) throw new Error(`checkpoint adoption closure unavailable: ${read.historicalEvidence.closureGaps.join("; ")}`);
  if (read.current.some(entry => !entry.matches)) throw new Error("checkpoint adoption saved raw content/mode mismatch");
  if (!m.saved.every(entry => envelope.some(write => contains(write, path.join(root, entry.path))))) throw new Error("checkpoint adoption envelope omits saved paths");
  const inventory = new AdmissionInventory(root, envelope), current = inventory.snapshot();
  if (!current.admission || current.gaps.length || m.gaps.length ||
      !["root", "repository", "gitDir", "admissionHead", "indexPath", "indexDigest", "configuration", "policy", "flags"]
        .every(key => current.admission![key as keyof SourceInventory] === m.admission[key as keyof SourceInventory])) {
    throw new Error("checkpoint adoption admission HEAD/index/configuration/policy mismatch");
  }
  return m;
}
