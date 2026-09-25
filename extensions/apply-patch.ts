import { lstat, realpath, readFile, open, rename, unlink, mkdir, rmdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import {
  withFileMutationQueue,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  APPLY_PATCH_GRAMMAR,
  MAX_PATCH_BYTES,
  parseApplyPatch,
  createOpenAILarkSampling,
  type ApplyPatchHunk,
  type UpdateChunk,
} from "pi-codex-tools";

const MAX_PATHS = 32;
const MAX_UPDATE_CHUNKS = 256;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_PATH_OUTPUT = 180;
const MAX_ERROR_OUTPUT = 240;
const PATCH_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const inputSchema = Type.Object(
  { patch: Type.String({ description: "Codex apply_patch input" }) },
  { additionalProperties: false },
);
type PatchInput = Static<typeof inputSchema>;

type Phase = "parse" | "preflight" | "stage" | "commit" | "complete";
type Outcome = "committed" | "pending" | "uncertain";

export interface ApplyPatchDetails {
  ok: boolean;
  phase: Phase;
  errorCode: string | null;
  inputBytes: number;
  plannedFiles: number;
  plannedHunks: number;
  filesChanged: number;
  hunksChanged: number;
  committed: string[];
  pending: string[];
  uncertain: string[];
  truncated: boolean;
  elapsedMs: number;
}

export interface PatchFileSystem {
  lstat(filePath: string): Promise<Stats>;
  realpath(filePath: string): Promise<string>;
  readFile(filePath: string): Promise<Buffer>;
  open(filePath: string, flags: "wx", mode?: number): Promise<FileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  mkdir(filePath: string, options?: { mode?: number }): Promise<void>;
  rmdir(filePath: string): Promise<void>;
}

export interface ApplyPatchDependencies {
  fileSystem?: Partial<PatchFileSystem>;
  withFileMutationQueue?: typeof withFileMutationQueue;
}

interface NormalizedPath {
  relative: string;
  display: string;
  segments: string[];
  filePath: string;
  queuePath: string;
}

interface Identity {
  dev: number;
  ino: number;
  mode: number;
  nlink?: number;
}

interface PathSnapshot {
  root: Identity;
  ancestors: Array<{ filePath: string; identity: Identity }>;
  missing: string[];
  exists: boolean;
  stat?: Stats;
}

interface PatchMarker {
  kind: "context" | "add" | "remove";
  text: string;
}

interface AnnotatedUpdateChunk extends UpdateChunk {
  markers: PatchMarker[];
}

type AnnotatedPatchHunk =
  | Exclude<ApplyPatchHunk, { kind: "update" }>
  | { kind: "update"; path: string; moveTo?: string; chunks: AnnotatedUpdateChunk[] };

interface PlannedOperation {
  kind: "add" | "update" | "delete";
  target: NormalizedPath;
  snapshot: PathSnapshot;
  source?: Buffer;
  output?: Buffer;
  mode?: number;
  changedHunks: number;
  stagedPath?: string;
  stagedIdentity?: Identity;
}

interface RunState {
  startedAt: number;
  phase: Phase;
  inputBytes: number;
  plannedFiles: number;
  plannedHunks: number;
  committedHunks: number;
  committed: string[];
  pending: string[];
  uncertain: string[];
  truncated: boolean;
}

class PatchFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const localFileSystem: PatchFileSystem = { lstat, realpath, readFile, open, rename, unlink, mkdir, rmdir };

/** Build T2's strict patch tool. Profile registration remains a T3 concern. */
export function createApplyPatchToolDefinition(
  cwd: string,
  dependencies: ApplyPatchDependencies = {},
): ToolDefinition<typeof inputSchema, ApplyPatchDetails> {
  return {
    name: "apply_patch",
    label: "apply_patch",
    description:
      "Apply strict, exact Codex patches to coherent file batches. Use edit for one or a few local replacements. Move, fuzzy matches, and unsafe paths are rejected.",
    promptSnippet: "Apply one exact patch to a coherent file batch",
    promptGuidelines: [
      "For a coherent multi-file batch, use apply_patch when the task explicitly calls for it; use edit for one or a few local replacements.",
      "Reread and regenerate a patch after any stale or ambiguous match. Move is unsupported.",
    ],
    parameters: inputSchema,
    constrainedSampling: createOpenAILarkSampling(APPLY_PATCH_GRAMMAR),
    executionMode: "sequential",
    async execute(_toolCallId, { patch }: PatchInput, signal, _onUpdate, ctx: ExtensionContext) {
      return runApplyPatch(patch, {
        cwd: ctx?.cwd || cwd,
        signal,
        fileSystem: dependencies.fileSystem,
        withFileMutationQueue: dependencies.withFileMutationQueue,
      });
    },
  };
}

export async function runApplyPatch(
  input: string,
  options: { cwd: string; signal?: AbortSignal } & ApplyPatchDependencies,
): Promise<{ content: [{ type: "text"; text: string }]; details: ApplyPatchDetails }> {
  const state: RunState = {
    startedAt: Date.now(),
    phase: "parse",
    inputBytes: typeof input === "string" ? Buffer.byteLength(input, "utf8") : 0,
    plannedFiles: 0,
    plannedHunks: 0,
    committedHunks: 0,
    committed: [],
    pending: [],
    uncertain: [],
    truncated: false,
  };
  const fs = { ...localFileSystem, ...options.fileSystem };
  const queue = options.withFileMutationQueue ?? withFileMutationQueue;
  let stages: PlannedOperation[] = [];

  try {
    if (typeof input !== "string") throw new PatchFailure("PATCH_INVALID", "Patch must be a string.");
    if (state.inputBytes > MAX_PATCH_BYTES) {
      throw new PatchFailure("PATCH_LIMIT", `Patch exceeds ${MAX_PATCH_BYTES} bytes.`);
    }
    assertUnicode(input);
    let parsed: ApplyPatchHunk[];
    try {
      parsed = parseApplyPatch(input);
    } catch {
      throw new PatchFailure("PATCH_INVALID", "Malformed apply_patch input.");
    }
    if (parsed.some((hunk) => hunk.kind === "update" && hunk.moveTo !== undefined)) {
      throw new PatchFailure("PATCH_MOVE_UNSUPPORTED", "Move operations are unsupported.");
    }
    state.pending = parsed.map(({ path: target }) => clip(target.replaceAll("\\", "/"), MAX_PATH_OUTPUT, state));
    if (input.includes("\0")) throw new PatchFailure("PATCH_UNSUPPORTED_BYTES", "NUL byte in patch input.");
    assertLosslessPatchSyntax(input);
    const hunks = annotateUpdateMarkers(input, parsed);
    const updateChunks = hunks.reduce(
      (sum, hunk) => sum + (hunk.kind === "update" ? hunk.chunks.length : 0),
      0,
    );
    if (hunks.length > MAX_PATHS) throw new PatchFailure("PATCH_LIMIT", `Patch exceeds the ${MAX_PATHS}-path limit.`);
    if (updateChunks > MAX_UPDATE_CHUNKS) {
      throw new PatchFailure("PATCH_LIMIT", `Patch exceeds the ${MAX_UPDATE_CHUNKS}-chunk limit.`);
    }

    state.phase = "preflight";
    const paths = hunks.map((hunk) => normalizePatchPath(hunk.path));
    const duplicates = new Set<string>();
    for (const target of paths) {
      if (duplicates.has(target.relative)) throw new PatchFailure("PATCH_DUPLICATE_PATH", `Duplicate target '${target.display}'.`);
      duplicates.add(target.relative);
    }
    state.pending = paths.map(({ display }) => display);

    throwIfAborted(options.signal);
    const requestedRoot = path.resolve(options.cwd);
    const root = await fs.realpath(requestedRoot);
    if (root !== requestedRoot) {
      // Built-in Pi writes using alias-spelled paths remain outside patch-only queue guarantees.
      throw new PatchFailure("PATCH_PATH", "Patch cwd must use its physical path spelling.");
    }
    const physicalPaths = paths.map((target) => ({
      ...target,
      filePath: path.resolve(root, target.relative),
      queuePath: path.resolve(root, target.relative),
    }));
    for (const target of physicalPaths) assertContained(root, target.filePath);
    const lockPaths = await mutationLockPaths(physicalPaths, fs);

    return await withLocks(queue, lockPaths, async () => {
      const createdDirs = new Map<string, Identity>();
      let failure: unknown;
      let plans: PlannedOperation[] = [];
      try {
        throwIfAborted(options.signal);
        plans = await preflight(hunks, physicalPaths, root, fs, options.signal);
        stages = plans;
        state.plannedFiles = plans.length;
        state.plannedHunks = plans.reduce((sum, operation) => sum + operation.changedHunks, 0);
        state.pending = plans.map(({ target }) => target.display);
        throwIfAborted(options.signal);

        state.phase = "stage";
        for (const operation of plans) {
          throwIfAborted(options.signal);
          if (operation.kind !== "update") continue;
          await stageUpdate(operation, fs);
          throwIfAborted(options.signal);
        }

        state.phase = "commit";
        for (const operation of plans) {
          throwIfAborted(options.signal);
          try {
            await commitOperation(operation, root, fs, options.signal, createdDirs);
            state.committed.push(operation.target.display);
            state.committedHunks += operation.changedHunks;
            state.pending.shift();
          } catch (error) {
            const outcome = await classifyOutcome(operation, root, fs);
            if (outcome === "committed") {
              state.committed.push(operation.target.display);
              state.committedHunks += operation.changedHunks;
              state.pending.shift();
            } else if (outcome === "uncertain") {
              state.uncertain.push(operation.target.display);
              state.pending.shift();
            }
            await recordUnexpectedDirectories(operation, root, fs, createdDirs, state);
            throw error;
          }
        }
        throwIfAborted(options.signal);
      } catch (error) {
        failure = error;
      }

      if (failure) state.uncertain.push(...await cleanupCreatedDirectories(createdDirs, fs, root));
      const cleanupPaths = await cleanupStages(stages, fs, root);
      if (cleanupPaths.length > 0) {
        state.uncertain.push(...cleanupPaths);
        failure = new PatchFailure("PATCH_CLEANUP", "Could not remove staged temporary files.");
      }
      return failure ? failureResult(state, failure) : successResult(state, plans);
    });
  } catch (error) {
    return failureResult(state, error);
  }
}

// Keep marker provenance; the public parser remains the syntax authority and projection check.
function annotateUpdateMarkers(input: string, parsed: ApplyPatchHunk[]): AnnotatedPatchHunk[] {
  const rawUpdates: Array<{ path: string; chunks: Array<{ context?: string; endOfFile: boolean; markers: PatchMarker[] }> }> = [];
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const updateHeader = "*** Update File: ";
  for (let index = 0; index < lines.length;) {
    const header = lines[index]!.trim();
    if (!header.startsWith(updateHeader)) {
      index++;
      continue;
    }
    const updatePath = header.slice(updateHeader.length).trim();
    index++;
    if (lines[index]?.startsWith("*** Move to: ")) index++;
    const chunks: Array<{ context?: string; endOfFile: boolean; markers: PatchMarker[] }> = [];
    let current: { context?: string; endOfFile: boolean; markers: PatchMarker[] } | undefined;
    while (index < lines.length) {
      const raw = lines[index]!;
      const line = raw.trimEnd();
      if (isUpdateBoundary(line)) break;
      if (line === "*** End of File") {
        if (!current) throw new PatchFailure("PATCH_INVALID", "Could not preserve Update markers.");
        current.endOfFile = true;
        index++;
        continue;
      }
      if (line === "@@" || line.startsWith("@@ ")) {
        if (current) chunks.push(current);
        const context = line === "@@" ? undefined : line.slice(3);
        current = { ...(context === undefined ? {} : { context }), endOfFile: false, markers: [] };
        index++;
        continue;
      }
      if (current?.endOfFile && line === "") {
        index++;
        continue;
      }
      current ??= { endOfFile: false, markers: [] };
      if (raw === "") current.markers.push({ kind: "context", text: "" });
      else if (raw.startsWith(" ")) current.markers.push({ kind: "context", text: raw.slice(1) });
      else if (raw.startsWith("+")) current.markers.push({ kind: "add", text: raw.slice(1) });
      else if (raw.startsWith("-")) current.markers.push({ kind: "remove", text: raw.slice(1) });
      else throw new PatchFailure("PATCH_INVALID", "Could not preserve Update markers.");
      index++;
    }
    if (current) chunks.push(current);
    rawUpdates.push({ path: updatePath, chunks });
  }

  let updateIndex = 0;
  const annotated = parsed.map((hunk): AnnotatedPatchHunk => {
    if (hunk.kind !== "update") return hunk;
    const raw = rawUpdates[updateIndex++];
    if (!raw || raw.path !== hunk.path || raw.chunks.length !== hunk.chunks.length) {
      throw new PatchFailure("PATCH_INVALID", "Could not preserve Update markers.");
    }
    const chunks = hunk.chunks.map((chunk, index) => {
      const source = raw.chunks[index]!;
      const oldLines = source.markers.filter(({ kind }) => kind !== "add").map(({ text }) => text);
      const newLines = source.markers.filter(({ kind }) => kind !== "remove").map(({ text }) => text);
      if (source.context !== chunk.context || source.endOfFile !== chunk.endOfFile ||
        !sameLines(oldLines, chunk.oldLines) || !sameLines(newLines, chunk.newLines)) {
        throw new PatchFailure("PATCH_INVALID", "Could not preserve Update markers.");
      }
      return { ...chunk, markers: source.markers };
    });
    return { ...hunk, chunks };
  });
  if (updateIndex !== rawUpdates.length) throw new PatchFailure("PATCH_INVALID", "Could not preserve Update markers.");
  return annotated;
}

function isUpdateBoundary(line: string): boolean {
  return line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Update File: ") || line === "*** End Patch";
}

async function preflight(
  hunks: AnnotatedPatchHunk[],
  paths: NormalizedPath[],
  root: string,
  fs: PatchFileSystem,
  signal?: AbortSignal,
): Promise<PlannedOperation[]> {
  const plans: PlannedOperation[] = [];
  const identities = new Map<string, string>();
  let rootIdentity: Identity | undefined;
  let totalBytes = 0;

  for (let index = 0; index < hunks.length; index++) {
    throwIfAborted(signal);
    const hunk = hunks[index]!;
    const target = paths[index]!;
    const snapshot = await inspectTarget(root, target, fs, rootIdentity);
    rootIdentity ??= snapshot.root;
    if (snapshot.exists && snapshot.stat) {
      const key = `${snapshot.stat.dev}:${snapshot.stat.ino}`;
      const previous = identities.get(key);
      if (previous) throw new PatchFailure("PATCH_DUPLICATE_PATH", `Targets '${previous}' and '${target.display}' resolve to the same file.`);
      identities.set(key, target.display);
    }

    if (hunk.kind === "add") {
      if (snapshot.exists) throw new PatchFailure("PATCH_ADD_EXISTS", `Cannot add over existing path '${target.display}'.`);
      const output = Buffer.from(hunk.content, "utf8");
      totalBytes += output.length;
      plans.push({ kind: "add", target, snapshot, output, changedHunks: 1 });
    } else {
      if (!snapshot.exists || !snapshot.stat?.isFile()) {
        throw new PatchFailure("PATCH_NOT_FILE", `Expected an existing regular file at '${target.display}'.`);
      }
      assertSingleLink(snapshot.stat, target.display);
      if (snapshot.stat.size > MAX_SOURCE_BYTES) {
        throw new PatchFailure("PATCH_LIMIT", `Source '${target.display}' exceeds ${MAX_SOURCE_BYTES} bytes.`);
      }
      const source = await fs.readFile(target.filePath);
      if (source.length > MAX_SOURCE_BYTES) {
        throw new PatchFailure("PATCH_LIMIT", `Source '${target.display}' exceeds ${MAX_SOURCE_BYTES} bytes.`);
      }
      await assertSourceUnchanged(target, snapshot, source, fs);
      const decoded = decodeSource(source, target.display);
      totalBytes += source.length;
      if (hunk.kind === "delete") {
        plans.push({ kind: "delete", target, snapshot, source, changedHunks: 1 });
      } else {
        const updated = applyUpdate(decoded.text, hunk.chunks, target.display);
        const output = Buffer.concat([decoded.bom ? PATCH_BOM : Buffer.alloc(0), Buffer.from(updated.text, "utf8")]);
        if (!output.equals(source)) {
          plans.push({
            kind: "update",
            target,
            snapshot,
            source,
            output,
            mode: snapshot.stat.mode & 0o7777,
            changedHunks: updated.changedHunks,
          });
          totalBytes += output.length;
        }
      }
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new PatchFailure("PATCH_LIMIT", `Patch exceeds ${MAX_TOTAL_BYTES} bytes of staged source and target data.`);
    }
  }
  return plans;
}

async function inspectTarget(
  root: string,
  target: NormalizedPath,
  fs: PatchFileSystem,
  expectedRoot?: Identity,
): Promise<PathSnapshot> {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PatchFailure("PATCH_PATH", "Execution root is not a real directory.");
  }
  const rootIdentity = identity(rootStat);
  if (expectedRoot && !sameIdentity(rootIdentity, expectedRoot)) {
    throw new PatchFailure("PATCH_PATH_DRIFT", "Execution root changed during patch preflight.");
  }

  const ancestors: PathSnapshot["ancestors"] = [{ filePath: root, identity: rootIdentity }];
  const missing: string[] = [];
  let current = root;
  let missingSeen = false;
  let stat: Stats | undefined;
  for (let index = 0; index < target.segments.length; index++) {
    current = path.join(current, target.segments[index]!);
    const isLeaf = index === target.segments.length - 1;
    if (missingSeen) {
      missing.push(current);
      continue;
    }
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isMissing(error)) {
        missingSeen = true;
        missing.push(current);
        stat = undefined;
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new PatchFailure("PATCH_LINK", `Symbolic links are not allowed in '${target.display}'.`);
    if (!isLeaf && !stat.isDirectory()) {
      throw new PatchFailure("PATCH_PATH", `Parent of '${target.display}' is not a directory.`);
    }
    const canonical = await fs.realpath(current);
    assertContained(root, canonical);
    if (!isLeaf) ancestors.push({ filePath: current, identity: identity(stat) });
  }
  return { root: rootIdentity, ancestors, missing, exists: Boolean(stat), ...(stat ? { stat } : {}) };
}

async function assertSourceUnchanged(
  target: NormalizedPath,
  snapshot: PathSnapshot,
  source: Buffer,
  fs: PatchFileSystem,
): Promise<void> {
  const latest = await fs.lstat(target.filePath);
  if (!snapshot.stat || !sameIdentity(identity(latest, true), identity(snapshot.stat, true))) {
    throw new PatchFailure("PATCH_STALE", `Source '${target.display}' changed during preflight.`);
  }
  const reread = await fs.readFile(target.filePath);
  if (!reread.equals(source)) throw new PatchFailure("PATCH_STALE", `Source '${target.display}' changed during preflight.`);
}

function decodeSource(source: Buffer, display: string): { text: string; bom: boolean } {
  if (source.length >= 2 && ((source[0] === 0xff && source[1] === 0xfe) || (source[0] === 0xfe && source[1] === 0xff))) {
    throw new PatchFailure("PATCH_UNSUPPORTED_BYTES", `UTF-16 source '${display}' is unsupported.`);
  }
  const bom = source.subarray(0, 3).equals(PATCH_BOM);
  const body = bom ? source.subarray(3) : source;
  if (body.includes(0)) throw new PatchFailure("PATCH_UNSUPPORTED_BYTES", `NUL byte in source '${display}'.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new PatchFailure("PATCH_UNSUPPORTED_BYTES", `Source '${display}' is not valid UTF-8.`);
  }
  return { text, bom };
}

function applyUpdate(
  source: string,
  chunks: AnnotatedUpdateChunk[],
  display: string,
): { text: string; changedHunks: number } {
  const lines = splitLines(source);
  const anchors = anchorPositions(lines, chunks);
  const edits: Array<{ start: number; end: number; chunk: AnnotatedUpdateChunk }> = [];
  let cursor = 0;
  let insertedAt = -1;

  for (const chunk of chunks) {
    const hasOld = chunk.oldLines.length > 0;
    let start: number;
    if (!hasOld) {
      if (chunk.context === undefined && !chunk.endOfFile) {
        throw new PatchFailure("PATCH_STALE", `Unanchored insertion in '${display}' is ambiguous.`);
      }
      if (chunk.context !== undefined) {
        const matches = anchors.get(chunk.context) ?? [];
        if (matches.length !== 1) throw new PatchFailure("PATCH_STALE", `Anchor in '${display}' is missing or ambiguous.`);
        start = matches[0]! + 1;
      } else {
        start = lines.length;
      }
      if (chunk.endOfFile && start !== lines.length) {
        throw new PatchFailure("PATCH_STALE", `EOF insertion in '${display}' does not target end of file.`);
      }
    } else if (chunk.endOfFile) {
      start = lines.length - chunk.oldLines.length;
      if (start < 0 || !matchesAt(lines, start, chunk.oldLines)) {
        throw new PatchFailure("PATCH_STALE", `EOF hunk in '${display}' does not match the source suffix.`);
      }
      if (chunk.context !== undefined) {
        const matches = anchors.get(chunk.context) ?? [];
        if (matches.length !== 1 || matches[0]! >= start) {
          throw new PatchFailure("PATCH_STALE", `Anchor in '${display}' is missing or ambiguous.`);
        }
      }
    } else {
      let floor = cursor;
      if (chunk.context !== undefined) {
        const matches = anchors.get(chunk.context) ?? [];
        if (matches.length !== 1) throw new PatchFailure("PATCH_STALE", `Anchor in '${display}' is missing or ambiguous.`);
        floor = Math.max(floor, matches[0]! + 1);
      }
      const matches = findMatches(lines, chunk.oldLines, floor);
      if (matches.length !== 1) {
        const reason = matches.length === 0 ? "stale" : "ambiguous";
        throw new PatchFailure("PATCH_STALE", `Hunk in '${display}' is ${reason}; reread and regenerate it.`);
      }
      start = matches[0]!;
    }

    const end = start + chunk.oldLines.length;
    if (start < cursor || (start === insertedAt && !hasOld)) {
      throw new PatchFailure("PATCH_STALE", `Overlapping hunks in '${display}' are unsupported.`);
    }
    if (chunk.endOfFile && end !== lines.length) {
      throw new PatchFailure("PATCH_STALE", `EOF hunk in '${display}' does not end at end of file.`);
    }
    edits.push({ start, end, chunk });
    if (hasOld) cursor = end;
    else {
      cursor = start;
      insertedAt = start;
    }
  }

  const finalNewline = lines.at(-1)?.ending !== undefined && lines.at(-1)?.ending !== "";
  const fallbackEnding = lines.find((line) => line.ending !== "")?.ending ?? "\n";
  const output: OutputLine[] = [];
  let sourceCursor = 0;
  for (const edit of edits) {
    output.push(...lines.slice(sourceCursor, edit.start));
    const replaced = lines.slice(edit.start, edit.end);
    let consumed = 0;
    for (const marker of edit.chunk.markers) {
      if (marker.kind !== "add") {
        const original = replaced[consumed++];
        if (!original || original.text !== marker.text) {
          throw new PatchFailure("PATCH_STALE", `Hunk in '${display}' changed during planning.`);
        }
        if (marker.kind === "context") output.push(original);
        continue;
      }
      const separator = insertedEnding(replaced, consumed, lines, edit.start, fallbackEnding);
      output.push({ text: marker.text, ending: separator, inserted: true, separatorBefore: separator });
    }
    if (consumed !== replaced.length) throw new PatchFailure("PATCH_INVALID", "Update markers do not cover parsed source lines.");
    sourceCursor = edit.end;
  }
  output.push(...lines.slice(sourceCursor));

  if (output.length === 0 && finalNewline) return { text: fallbackEnding, changedHunks: changedHunkCount(edits) };
  return { text: renderOutput(output, finalNewline, fallbackEnding, display), changedHunks: changedHunkCount(edits) };
}

interface TextLine { text: string; ending: string }
interface OutputLine extends TextLine { inserted?: boolean; separatorBefore?: string }

function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n") continue;
    const crlf = index > start && text[index - 1] === "\r";
    const end = crlf ? index - 1 : index;
    lines.push({ text: text.slice(start, end), ending: crlf ? "\r\n" : "\n" });
    start = index + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: "" });
  return lines;
}

function insertedEnding(
  replaced: TextLine[],
  consumed: number,
  lines: TextLine[],
  start: number,
  fallback: string,
): string {
  const previous = consumed > 0 ? replaced[consumed - 1] : lines[start - 1];
  const next = replaced[consumed] ?? lines[start + consumed];
  return previous?.ending || next?.ending || fallback;
}

function renderOutput(lines: OutputLine[], finalNewline: boolean, fallback: string, display: string): string {
  let output = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    output += line.text;
    const isLast = index === lines.length - 1;
    if (isLast) {
      if (finalNewline) {
        if (line.ending) output += line.ending;
        else if (line.inserted) output += fallback;
        else throw new PatchFailure("PATCH_STALE", `Cannot preserve final newline in '${display}'.`);
      } else if (line.ending && !line.inserted) {
        throw new PatchFailure("PATCH_STALE", `Cannot preserve final newline state in '${display}'.`);
      }
      continue;
    }
    if (line.ending) output += line.ending;
    else if (lines[index + 1]!.inserted) output += lines[index + 1]!.separatorBefore ?? fallback;
    else throw new PatchFailure("PATCH_STALE", `Cannot preserve line endings in '${display}'.`);
  }
  return output;
}

function matchesAt(lines: TextLine[], start: number, oldLines: string[]): boolean {
  return oldLines.every((line, index) => lines[start + index]?.text === line);
}

function findMatches(lines: TextLine[], pattern: string[], floor: number): number[] {
  const prefix = new Array<number>(pattern.length).fill(0);
  for (let index = 1, matched = 0; index < pattern.length; index++) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = prefix[matched - 1]!;
    if (pattern[index] === pattern[matched]) matched++;
    prefix[index] = matched;
  }
  const matches: number[] = [];
  for (let index = floor, matched = 0; index < lines.length; index++) {
    while (matched > 0 && lines[index]!.text !== pattern[matched]) matched = prefix[matched - 1]!;
    if (lines[index]!.text === pattern[matched]) matched++;
    if (matched === pattern.length) {
      matches.push(index - pattern.length + 1);
      if (matches.length === 2) break;
      matched = prefix[matched - 1]!;
    }
  }
  return matches;
}

function anchorPositions(lines: TextLine[], chunks: UpdateChunk[]): Map<string, number[]> {
  const wanted = new Set(chunks.flatMap(({ context }) => context === undefined ? [] : [context]));
  const positions = new Map<string, number[]>();
  for (let index = 0; index < lines.length && wanted.size > 0; index++) {
    const text = lines[index]!.text;
    if (!wanted.has(text)) continue;
    const found = positions.get(text) ?? [];
    if (found.length < 2) found.push(index);
    positions.set(text, found);
    if (found.length === 2) wanted.delete(text);
  }
  return positions;
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function changedHunkCount(edits: Array<{ chunk: UpdateChunk }>): number {
  return edits.filter(({ chunk }) => !sameLines(chunk.oldLines, chunk.newLines)).length;
}

async function stageUpdate(operation: PlannedOperation, fs: PatchFileSystem): Promise<void> {
  const directory = path.dirname(operation.target.filePath);
  const temp = path.join(directory, `.pitako-patch-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temp, "wx", operation.mode);
  operation.stagedPath = temp;
  let failure: unknown;
  try {
    await handle.writeFile(operation.output!);
    await handle.chmod(operation.mode!);
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  const stat = await fs.lstat(temp);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    await fs.unlink(temp);
    throw new PatchFailure("PATCH_STAGE", "Staged update is not a private regular file.");
  }
  const bytes = await fs.readFile(temp);
  if (!bytes.equals(operation.output!)) {
    await fs.unlink(temp);
    throw new PatchFailure("PATCH_STAGE", "Staged update changed before commit.");
  }
  operation.stagedPath = temp;
  operation.stagedIdentity = identity(stat, true);
}

async function commitOperation(
  operation: PlannedOperation,
  root: string,
  fs: PatchFileSystem,
  signal: AbortSignal | undefined,
  createdDirs: Map<string, Identity>,
): Promise<void> {
  if (operation.kind === "add") {
    await verifyAddSnapshot(root, operation, fs, createdDirs);
    for (const directory of operation.snapshot.missing.slice(0, -1)) {
      if (createdDirs.has(directory)) continue;
      throwIfAborted(signal);
      await verifyAddSnapshot(root, operation, fs, createdDirs);
      await fs.mkdir(directory, { mode: 0o777 });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new PatchFailure("PATCH_PATH_DRIFT", `New parent of '${operation.target.display}' is unsafe.`);
      }
      const canonical = await fs.realpath(directory);
      assertContained(root, canonical);
      createdDirs.set(directory, identity(stat));
    }
    throwIfAborted(signal);
    await verifyAddSnapshot(root, operation, fs, createdDirs);
    await writeAddExclusive(operation, fs);
    return;
  }

  if (operation.kind === "update") {
    const staged = await fs.lstat(operation.stagedPath!);
    if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1 ||
      !sameIdentity(identity(staged, true), operation.stagedIdentity!)) {
      throw new PatchFailure("PATCH_STAGE", `Staged update for '${operation.target.display}' changed before commit.`);
    }
    if (!(await fs.readFile(operation.stagedPath!)).equals(operation.output!)) {
      throw new PatchFailure("PATCH_STAGE", `Staged update for '${operation.target.display}' changed before commit.`);
    }
  }
  await verifyExistingSnapshot(root, operation, fs, createdDirs);
  const latest = await fs.readFile(operation.target.filePath);
  if (!latest.equals(operation.source!)) {
    throw new PatchFailure("PATCH_STALE", `Source '${operation.target.display}' changed before commit.`);
  }
  throwIfAborted(signal);
  if (operation.kind === "delete") {
    await fs.unlink(operation.target.filePath);
  } else {
    await fs.rename(operation.stagedPath!, operation.target.filePath);
    operation.stagedPath = undefined;
  }
}

async function writeAddExclusive(operation: PlannedOperation, fs: PatchFileSystem): Promise<void> {
  let handle: FileHandle | undefined;
  let owned: Identity | undefined;
  try {
    handle = await fs.open(operation.target.filePath, "wx", 0o666);
    owned = identity(await handle.stat(), true);
    await handle.writeFile(operation.output!);
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* Keep original failure. */ }
    }
    if (owned) {
      try {
        const current = await fs.lstat(operation.target.filePath);
        if (current.isFile() && sameIdentity(identity(current, true), owned)) await fs.unlink(operation.target.filePath);
      } catch { /* Outcome classification reports any remaining partial file. */ }
    }
    throw error;
  }
}

async function verifyExistingSnapshot(
  root: string,
  operation: PlannedOperation,
  fs: PatchFileSystem,
  createdDirs: Map<string, Identity>,
): Promise<void> {
  const current = await inspectTarget(root, operation.target, fs, operation.snapshot.root);
  if (!current.exists || !current.stat || !operation.snapshot.stat ||
    !sameIdentity(identity(current.stat, true), identity(operation.snapshot.stat, true)) ||
    !sameAncestors(current.ancestors, operation.snapshot.ancestors, createdDirs)) {
    throw new PatchFailure("PATCH_STALE", `Source '${operation.target.display}' changed before commit.`);
  }
}

async function verifyAddSnapshot(
  root: string,
  operation: PlannedOperation,
  fs: PatchFileSystem,
  createdDirs: Map<string, Identity>,
): Promise<void> {
  const current = await inspectTarget(root, operation.target, fs, operation.snapshot.root);
  if (current.exists || !sameAncestors(current.ancestors, operation.snapshot.ancestors, createdDirs)) {
    throw new PatchFailure("PATCH_PATH_DRIFT", `Add target '${operation.target.display}' changed before commit.`);
  }
}

function sameAncestors(
  current: PathSnapshot["ancestors"],
  expected: PathSnapshot["ancestors"],
  createdDirs: Map<string, Identity>,
): boolean {
  return expected.every(({ filePath, identity: initial }) => {
    const actual = current.find((entry) => entry.filePath === filePath)?.identity;
    return Boolean(actual && sameIdentity(actual, initial));
  }) && current.every(({ filePath, identity: actual }) => {
    if (expected.some((entry) => entry.filePath === filePath)) return true;
    const created = createdDirs.get(filePath);
    return Boolean(created && sameIdentity(actual, created));
  });
}

async function classifyOutcome(
  operation: PlannedOperation,
  root: string,
  fs: PatchFileSystem,
): Promise<Outcome> {
  try {
    const current = await inspectTarget(root, operation.target, fs, operation.snapshot.root);
    if (operation.kind === "delete") {
      if (!current.exists) return "committed";
      if (current.stat && operation.snapshot.stat && sameIdentity(identity(current.stat, true), identity(operation.snapshot.stat, true)) &&
        (await fs.readFile(operation.target.filePath)).equals(operation.source!)) return "pending";
      return "uncertain";
    }
    if (current.exists && current.stat?.isFile() && current.stat.nlink === 1) {
      const bytes = await fs.readFile(operation.target.filePath);
      if (bytes.equals(operation.output!)) return "committed";
      if (operation.kind === "update" && operation.snapshot.stat &&
        sameIdentity(identity(current.stat, true), identity(operation.snapshot.stat, true)) && bytes.equals(operation.source!)) return "pending";
      return "uncertain";
    }
    if (!current.exists && operation.kind === "add") return "pending";
  } catch { /* A changed or unreadable target is uncertain. */ }
  return "uncertain";
}

async function recordUnexpectedDirectories(
  operation: PlannedOperation,
  root: string,
  fs: PatchFileSystem,
  createdDirs: Map<string, Identity>,
  state: RunState,
): Promise<void> {
  if (operation.kind !== "add") return;
  try {
    const current = await inspectTarget(root, operation.target, fs, operation.snapshot.root);
    for (const ancestor of current.ancestors) {
      const expected = operation.snapshot.ancestors.find(({ filePath }) => filePath === ancestor.filePath)?.identity;
      if (!expected && !createdDirs.has(ancestor.filePath)) state.uncertain.push(relativePath(root, ancestor.filePath));
    }
  } catch { /* The target path itself is already reported as uncertain. */ }
}

async function cleanupStages(
  operations: PlannedOperation[],
  fs: PatchFileSystem,
  root: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const operation of operations) {
    const stagedPath = operation.stagedPath;
    if (!stagedPath) continue;
    try {
      await fs.unlink(stagedPath);
      operation.stagedPath = undefined;
    } catch (error) {
      if (!isMissing(error)) failures.push(relativePath(root, stagedPath));
    }
  }
  return failures;
}

async function cleanupCreatedDirectories(
  createdDirs: Map<string, Identity>,
  fs: PatchFileSystem,
  root: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const directory of [...createdDirs.keys()].sort((a, b) => b.length - a.length)) {
    try {
      await fs.rmdir(directory);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") failures.push(relativePath(root, directory));
    }
  }
  return failures;
}

function successResult(state: RunState, plans: PlannedOperation[]): { content: [{ type: "text"; text: string }]; details: ApplyPatchDetails } {
  state.phase = "complete";
  const paths = plans.map(({ target }) => target.display);
  const text = `Applied patch: ${plans.length} file(s), ${state.plannedHunks} hunk(s). Changed: ${renderPaths(paths, state)}.`;
  return { content: [{ type: "text", text }], details: details(state, true, null) };
}

function failureResult(state: RunState, error: unknown): { content: [{ type: "text"; text: string }]; details: ApplyPatchDetails } {
  const failure = error instanceof PatchFailure ? error : new PatchFailure("PATCH_IO", safeIoError(error));
  const message = clip(failure.message, MAX_ERROR_OUTPUT, state);
  const text = `apply_patch failed during ${state.phase} (${failure.code}): ${message} Committed: ${renderPaths(state.committed, state)}; pending: ${renderPaths(state.pending, state)}; uncertain: ${renderPaths(state.uncertain, state)}.`;
  return { content: [{ type: "text", text }], details: details(state, false, failure.code) };
}

function details(state: RunState, ok: boolean, errorCode: string | null): ApplyPatchDetails {
  return {
    ok,
    phase: state.phase,
    errorCode,
    inputBytes: state.inputBytes,
    plannedFiles: state.plannedFiles,
    plannedHunks: state.plannedHunks,
    filesChanged: state.committed.length,
    hunksChanged: state.committedHunks,
    committed: state.committed.map((item) => clip(item, MAX_PATH_OUTPUT, state)),
    pending: state.pending.map((item) => clip(item, MAX_PATH_OUTPUT, state)),
    uncertain: state.uncertain.map((item) => clip(item, MAX_PATH_OUTPUT, state)),
    truncated: state.truncated,
    elapsedMs: Math.max(0, Date.now() - state.startedAt),
  };
}

function renderPaths(paths: string[], state: RunState): string {
  return paths.length === 0 ? "none" : paths.map((item) => clip(item, MAX_PATH_OUTPUT, state)).join(", ");
}

function clip(value: string, max: number, state: RunState): string {
  if (value.length <= max) return value;
  state.truncated = true;
  return `${value.slice(0, max - 1)}…`;
}

function normalizePatchPath(raw: string): { relative: string; display: string; segments: string[] } {
  if (!raw || raw.includes("\0")) throw new PatchFailure("PATCH_PATH", "Patch paths must be nonempty and contain no NUL.");
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith("//")) {
    throw new PatchFailure("PATCH_PATH", `Absolute path '${clipPath(raw)}' is not allowed.`);
  }
  if (process.platform !== "win32" && raw.includes("\\")) {
    throw new PatchFailure("PATCH_PATH", `Backslash path separators are unsupported in '${clipPath(raw)}'.`);
  }
  const segments = raw.replaceAll("\\", "/").split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "..") throw new PatchFailure("PATCH_PATH", `Parent traversal in '${clipPath(raw)}' is not allowed.`);
    if (!segment || segment === ".") continue;
    const protectedName = segment.toLowerCase();
    if (protectedName === ".git" || protectedName === "node_modules" || protectedName.startsWith(".env")) {
      throw new PatchFailure("PATCH_PATH", `Protected path '${clipPath(raw)}' is not allowed.`);
    }
    normalized.push(segment);
  }
  if (normalized.length === 0) throw new PatchFailure("PATCH_PATH", "Patch path must name a file.");
  return {
    relative: normalized.join(path.sep),
    display: normalized.join("/"),
    segments: normalized,
  };
}

function assertLosslessPatchSyntax(input: string): void {
  for (const line of input.replace(/\r\n?/g, "\n").split("\n")) {
    if ((line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) && line.slice(1).trimEnd() !== line.slice(1)) {
      throw new PatchFailure("PATCH_INVALID", "Trailing whitespace in patch change lines is unsupported.");
    }
    if (line.startsWith("@@ ") && line.trimEnd() !== line) {
      throw new PatchFailure("PATCH_INVALID", "Trailing whitespace in patch anchors is unsupported.");
    }
    for (const header of ["*** Add File: ", "*** Update File: ", "*** Delete File: "]) {
      if (line.startsWith(header) && line.slice(header.length).trim() !== line.slice(header.length)) {
        throw new PatchFailure("PATCH_INVALID", "Whitespace around patch paths is unsupported.");
      }
    }
  }
}

function assertUnicode(text: string): void {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new PatchFailure("PATCH_INVALID", "Patch contains invalid Unicode.");
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new PatchFailure("PATCH_INVALID", "Patch contains invalid Unicode.");
    }
  }
}

// Path checks reject links and traversal, not hostile concurrent parent-directory renames.
function assertContained(root: string, filePath: string): void {
  const rel = path.relative(root, filePath);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PatchFailure("PATCH_PATH", "Target resolves outside the execution workspace.");
  }
}

function identity(stat: Stats, includeLinks = false): Identity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    ...(includeLinks ? { nlink: stat.nlink } : {}),
  };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    (left.nlink === undefined || right.nlink === undefined || left.nlink === right.nlink);
}

function assertSingleLink(stat: Stats, display: string): void {
  if (stat.nlink !== 1) throw new PatchFailure("PATCH_HARDLINK", `Multiply-linked file '${display}' is not allowed.`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PatchFailure("PATCH_ABORTED", "Operation aborted.");
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "ENOENT"));
}

function safeIoError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return `Filesystem operation failed (${error.code}).`;
  }
  return "Filesystem operation failed.";
}

function clipPath(value: string): string {
  return value.length > MAX_PATH_OUTPUT ? `${value.slice(0, MAX_PATH_OUTPUT - 1)}…` : value;
}

async function mutationLockPaths(targets: NormalizedPath[], fs: PatchFileSystem): Promise<string[]> {
  const keys = new Map<string, string>();
  for (const target of targets) {
    let key = target.queuePath;
    try {
      key = await fs.realpath(target.queuePath);
    } catch (error) {
      if (!isQueueKeyMissing(error)) throw error;
    }
    const current = keys.get(key);
    if (!current || target.queuePath < current) keys.set(key, target.queuePath);
  }
  return [...keys.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, target]) => target);
}

function isQueueKeyMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR"));
}

function relativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function withLocks<T>(
  queue: typeof withFileMutationQueue,
  paths: string[],
  operation: () => Promise<T>,
  index = 0,
): Promise<T> {
  if (index === paths.length) return operation();
  return queue(paths[index]!, () => withLocks(queue, paths, operation, index + 1));
}
