import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { checkoutEvidence, checkoutSnapshot, type CheckoutDigest, designatedWorkspace, gitRead, withIndexReads } from "./spec-plans.ts";

type Image = { bytes: string; mode: number } | null;
export type CheckpointIntent = {
  version: 2; association: { root: string; commonDir: string; missionId: string; missionPath: string; invocation: string; source: string; digest: string; maxCycles: number; sourceRefs: unknown[] };
  key: string; taskId: string; attempt: number; loop: number; cursor: number;
  phase: "implementation"; planRef: unknown;
  progress?: CheckpointProgress;
  baseline?: { head: string; fingerprint: string };
};
export type CheckpointProgress = { consumedLoops: number; admitted: Record<string, string[]>;
  previous: { taskId: string; attempt: number; resultRef: unknown; checkpointRef: string; digest: string } | null };
type Entry = { path: string; before: Image; after: Image };
type Manifest = { intent: CheckpointIntent; base: ReturnType<typeof checkoutEvidence>; index: string; files: { path: string; image: Image }[] };
export type RestoreAuthority = {
  settled?: boolean; continuationUnavailable?: boolean; pending: boolean;
  stop: boolean; permissionDenied: boolean; activeWriter: boolean | null;
  references: string[];
  confirmedUnit?: ConfirmedUnit;
  confirmedPause?: { kind: "pause"; checkpointRef: string; digest: string; candidate: unknown; position: unknown; progress: unknown };
};
type ConfirmedUnit = { kind: "unit"; checkpointRef: string; digest: string;
  candidate: unknown; position: unknown; progress: unknown; taskId: string; attempt: number; resultRef: unknown };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = isDeepStrictEqual;
// Each public operation is synchronous and never changes HEAD, the index or
// worktree registration. Validate the worktree and read HEAD/index once per
// operation, not once per checkpoint path or internal check.
let workspaces: Map<string, ReturnType<typeof designatedWorkspace>> | undefined;
function operation<A extends unknown[], R>(run: (...args: A) => R, stableCheckout = false) {
  return (...args: A): R => {
    if (workspaces) return run(...args);
    workspaces = new Map();
    try { return withIndexReads(() => run(...args), stableCheckout); } finally { workspaces = undefined; }
  };
}
function syncDirectory(directory: string) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableDirectory(directory: string) {
  if (existsSync(directory)) return;
  const parent = path.dirname(directory);
  durableDirectory(parent);
  mkdirSync(directory);
  syncDirectory(parent);
}
function safePath(root: string, relative: string, artifacts = false) {
  if (!relative || relative.includes("\0") || relative.includes("\\") || path.isAbsolute(relative) ||
      relative.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("Invalid checkpoint relative path.");
  if (!artifacts && relative.split("/").some(part =>
    [".git", ".pi", "node_modules"].includes(part) || part === ".env" || part.startsWith(".env.")))
    throw new Error("Checkpoint cannot restore protected metadata or environment files.");
  if (!artifacts && relative.startsWith(".pitako/plans/"))
    throw new Error("Checkpoint cannot restore immutable spec sources.");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Checkpoint path traverses a symlink."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}
function image(root: string, relative: string): Image {
  const file = safePath(root, relative);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new Error("Checkpoint supports regular files or absence only.");
    return { bytes: readFileSync(file).toString("base64"), mode: stat.mode & 0o777 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function validateImage(value: Image) {
  if (value === null) return;
  if (!value || Object.keys(value).sort().join(",") !== "bytes,mode" ||
      typeof value.bytes !== "string" || Buffer.from(value.bytes, "base64").toString("base64") !== value.bytes ||
      !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777)
    throw new Error("Invalid checkpoint file image.");
}
function atomic(file: string, value: unknown) {
  if (existsSync(file)) throw new Error(`Checkpoint artifact already exists: ${file}`);
  const data = JSON.stringify(value), temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ sha256: hash(data), data })); fsyncSync(fd); }
  finally { closeSync(fd); }
  // No-clobber publication; even a competing writer cannot replace an original.
  linkSync(temporary, file); unlinkSync(temporary); syncDirectory(path.dirname(file));
}
function read<T>(file: string): T {
  const envelope = JSON.parse(readFileSync(file, "utf8"));
  if (typeof envelope.data !== "string" || envelope.sha256 !== hash(envelope.data))
    throw new Error("Checkpoint artifact digest mismatch.");
  return JSON.parse(envelope.data);
}
export function checkpointDirectory(intent: CheckpointIntent) {
  if (intent.version !== 2 || !/^[A-Za-z0-9._-]+$/.test(intent.key) || intent.key.includes("..") ||
      !intent.taskId || !Number.isSafeInteger(intent.attempt) || intent.attempt < 1 ||
      !Number.isSafeInteger(intent.loop) || intent.loop < 1 ||
      !Number.isSafeInteger(intent.cursor) || intent.cursor < 0 || intent.phase !== "implementation")
    throw new Error("Invalid checkpoint intention.");
  const workspace = workspaces?.get(intent.association.root) ?? designatedWorkspace(intent.association.root);
  workspaces?.set(intent.association.root, workspace);
  if (workspace.physicalRoot !== intent.association.root || workspace.identity !== intent.association.commonDir)
    throw new Error("Checkpoint worktree association mismatch.");
  return safePath(workspace.physicalRoot, `.pi/subagents/checkpoints/${intent.key}`, true);
}
// Append only new maxima; original samples remain durable across interruption.
export function readContextPeak(intent: CheckpointIntent): number | null {
  const directory = checkpointDirectory(intent);
  if (!existsSync(directory)) return null;
  let peak: number | null = null;
  for (const name of readdirSync(directory).filter(name => /^context-peak-\d+\.json$/.test(name))) {
    const sample = read<{ intent: CheckpointIntent; tokens: number }>(path.join(directory, name));
    if (!equal(sample.intent, intent) || !Number.isSafeInteger(sample.tokens) || sample.tokens < 0)
      throw new Error("Invalid attempt context peak metadata.");
    peak = Math.max(peak ?? 0, sample.tokens);
  }
  return peak;
}
export function recordContextPeak(intent: CheckpointIntent, tokens: number | null | undefined): void {
  if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) return;
  const peak = readContextPeak(intent);
  if (peak !== null && peak >= tokens) return;
  const directory = checkpointDirectory(intent);
  durableDirectory(directory);
  atomic(path.join(directory, `context-peak-${tokens}.json`), { intent, tokens });
}
type Baseline = { index: string; intent: CheckpointIntent; files: Record<string, CheckoutDigest>; candidate: { head: string; fingerprint: string } };
export function captureBaseline({ intent }: { intent: CheckpointIntent }) {
  const directory = checkpointDirectory(intent), file = path.join(directory, "baseline.json");
  const snapshot = checkoutSnapshot(intent.association.root);
  const candidate = { head: snapshot.evidence.head, fingerprint: snapshot.evidence.fingerprint };
  const baseline: Baseline = { intent: { ...intent, baseline: candidate }, index: index(intent.association.root), files: snapshot.files, candidate };
  durableDirectory(directory);
  if (existsSync(file)) {
    if (!equal(read(file), JSON.parse(JSON.stringify(baseline)))) throw new Error("Dispatch baseline conflicts with retained original.");
  } else atomic(file, baseline);
  return { candidate };
}
function imageDigest(value: Image): CheckoutDigest {
  return value === null ? null : { hash: createHash("sha256").update(Buffer.from(value.bytes, "base64")).digest("hex"), mode: 0o100000 | value.mode };
}
function attribution(intent: CheckpointIntent, files: Manifest["files"], restored: Manifest["files"] = []) {
  // Legacy manifests remain readable; all new workflow dispatches bind a baseline.
  if (!intent.baseline) return;
  const baseline = read<Baseline>(path.join(checkpointDirectory(intent), "baseline.json"));
  if (!equal(baseline.intent, intent) || !equal(baseline.candidate, intent.baseline))
    throw new Error("Dispatch baseline association mismatch.");
  if (index(intent.association.root) !== baseline.index || checkoutEvidence(intent.association.root).head !== baseline.candidate.head)
    throw new Error("Dispatch baseline HEAD/index changed.");
  const expected = new Map(Object.entries(baseline.files));
  for (const file of restored) expected.set(file.path, imageDigest(file.image));
  for (const file of files) if (!equal(imageDigest(file.image), expected.get(file.path) ?? null))
    throw Object.assign(new Error(`First-touch preimage differs from dispatch baseline: ${file.path}`), {
      attributionPaths: [{ path: file.path, journaled: expected.get(file.path)?.hash ?? null,
        actual: imageDigest(file.image)?.hash ?? null, partiallyApplied: false }] });
  const current = new Map(Object.entries(checkoutSnapshot(intent.association.root).files)), journaled = new Set(files.map(file => file.path));
  for (const file of new Set([...expected.keys(), ...current.keys()])) {
    if (!equal(expected.get(file) ?? null, current.get(file) ?? null) && !journaled.has(file))
      throw Object.assign(new Error(`Unjournaled candidate change: ${file}`), {
        attributionPaths: [{ path: file, journaled: expected.get(file)?.hash ?? null,
          actual: current.get(file)?.hash ?? null, partiallyApplied: false }] });
  }
}
function index(root: string) { return hash(gitRead(root, "ls-files", "--stage", "-z")); }
function load(intent: CheckpointIntent) {
  const directory = checkpointDirectory(intent);
  const manifest = read<Manifest>(path.join(directory, "manifest.json"));
  if (!equal(manifest.intent, intent)) throw new Error("Checkpoint intention association mismatch.");
  const captures = readdirSync(directory).filter(file => /^capture-\d{6}\.json$/.test(file)).sort();
  for (const [seq, name] of captures.entries()) {
    if (name !== `capture-${String(seq).padStart(6, "0")}.json`) throw new Error("Checkpoint capture history has a gap.");
    const capture = read<{ intent: CheckpointIntent; path: string; image: Image }>(path.join(directory, name));
    if (!equal(capture.intent, intent)) throw new Error("Hook capture intention mismatch.");
    manifest.files.push({ path: capture.path, image: capture.image });
  }
  if (!manifest.base?.fingerprint || !manifest.files?.length || !manifest.index)
    throw new Error("Checkpoint lacks reconstructible preimages.");
  if (gitRead(intent.association.root, "rev-parse", "HEAD").trim() !== manifest.base.head ||
      index(intent.association.root) !== manifest.index)
    throw new Error("Checkpoint HEAD/index changed; no Git reset is permitted.");
  const known = new Set<string>();
  for (const file of manifest.files) {
    safePath(intent.association.root, file.path); validateImage(file.image);
    if (known.has(file.path)) throw new Error("Duplicate checkpoint path.");
    known.add(file.path);
  }
  const steps = readdirSync(directory).filter(file => /^effect-\d{6}\.json$/.test(file)).sort()
    .map((file, sequence) => {
      if (file !== `effect-${String(sequence).padStart(6, "0")}.json`) throw new Error("Checkpoint effect history has a gap.");
      const entries = read<Entry[]>(path.join(directory, file));
      if (!Array.isArray(entries) || !entries.length || new Set(entries.map(entry => entry.path)).size !== entries.length)
        throw new Error("Invalid checkpoint effect entries.");
      for (const entry of entries) {
        if (!known.has(entry.path)) throw new Error("Effect outside captured checkpoint paths.");
        validateImage(entry.before); validateImage(entry.after);
      }
      return entries;
    });
  // Every journal preimage must continue the exact captured chain.
  const latest = new Map(manifest.files.map(file => [file.path, file.image]));
  for (const step of steps) for (const entry of step) {
    if (!equal(latest.get(entry.path), entry.before)) throw new Error("Checkpoint effect preimage mismatch.");
    latest.set(entry.path, entry.after);
  }
  const openPaths = new Set<string>();
  const hooks = readdirSync(directory).filter(file => /^hook-effect-\d{6}\.json$/.test(file)).sort();
  if (readdirSync(directory).some(file => /^hook-effect-\d{6}-closed\.json$/.test(file) &&
      !hooks.includes(file.replace("-closed.json", ".json")))) throw new Error("Hook closure lacks an effect intent.");
  for (const [seq, name] of hooks.entries()) {
    const effect = read<{ intent: CheckpointIntent; tool: string; seq: number; paths: string[];
      before: Manifest["files"] }>(path.join(directory, name));
    if (name !== `hook-effect-${String(seq).padStart(6, "0")}.json` || effect.seq !== seq ||
        !equal(effect.intent, intent) || !["edit", "write", "apply_patch"].includes(effect.tool) ||
        !Array.isArray(effect.paths) || !effect.paths.length || new Set(effect.paths).size !== effect.paths.length ||
        !equal(effect.before?.map(file => file.path), effect.paths)) throw new Error("Invalid hook effect intent.");
    const closed = path.join(directory, name.replace(".json", "-closed.json"));
    const after = existsSync(closed) ? read<{ after: Manifest["files"] }>(closed).after : undefined;
    if (existsSync(closed) && (!Array.isArray(after) || !equal(after.map(file => file.path), effect.paths)))
      throw new Error("Invalid hook effect postimages.");
    const entries: Entry[] = [];
    for (const [i, file] of effect.before.entries()) {
      validateImage(file.image);
      if (!known.has(file.path) || openPaths.has(file.path) || !equal(latest.get(file.path), file.image))
        throw new Error("Hook effect preimage mismatch.");
      if (after) {
        validateImage(after[i].image);
        entries.push({ path: file.path, before: file.image, after: after[i].image });
        latest.set(file.path, after[i].image);
      } else openPaths.add(file.path);
    }
    if (after) steps.push(entries);
  }
  return { directory, manifest, steps, openPaths };
}
// Bind seals to the complete append-only first-touch inventory, preserving old digests.
function manifestDigest(directory: string) {
  const files = ["manifest.json", ...readdirSync(directory).filter(file => /^capture-\d{6}\.json$/.test(file)).sort()];
  return hash(files.map(file => readFileSync(path.join(directory, file), "utf8")).join(""));
}
// The caller supplies the complete, ordered slot history, including unwritten attempts.
export const checkpointTaskDelta = operation((intents: CheckpointIntent[]) => {
  const first = intents[0];
  if (!first || first.attempt !== 1) throw new Error("Task delta requires the first slot attempt.");
  const touched = new Set<string>();
  let baseline: Baseline | undefined;
  for (const [offset, intent] of intents.entries()) {
    if (intent.attempt !== offset + 1 || intent.taskId !== first.taskId ||
        intent.loop !== first.loop || intent.cursor !== first.cursor ||
        !equal(intent.association, first.association) || !equal(intent.planRef, first.planRef))
      throw new Error("Task delta slot association mismatch.");
    const directory = checkpointDirectory(intent);
    const retained = read<Baseline>(path.join(directory, "baseline.json"));
    if (!intent.baseline || !equal(retained.intent, intent) || !equal(retained.candidate, intent.baseline))
      throw new Error("Dispatch baseline association mismatch.");
    baseline ??= retained;
    if (index(intent.association.root) !== retained.index ||
        checkoutEvidence(intent.association.root).head !== retained.candidate.head)
      throw new Error("Dispatch baseline HEAD/index changed.");
    if (existsSync(path.join(directory, "manifest.json"))) {
      const { manifest, openPaths } = load(intent);
      if (openPaths.size) {
        const partialFile = path.join(directory, "restore.json"), restoredFile = path.join(directory, "restored.json");
        if (!existsSync(restoredFile)) throw new Error("Task delta requires settled checkpoint effects.");
        const partial = read<{ intent: CheckpointIntent }>(partialFile);
        const restored = read<{ checkpointRef: string; digest: string; partialRef: string; position: unknown }>(restoredFile);
        if (!equal(partial.intent, intent) || restored.partialRef !== partialFile ||
            restored.checkpointRef !== path.join(directory, "manifest.json") || restored.digest !== manifestDigest(directory) ||
            !equal(restored.position, { loop: intent.loop, cursor: intent.cursor, phase: intent.phase }))
          throw new Error("Checkpoint restored observation conflicts.");
      }
      for (const file of manifest.files) touched.add(file.path);
    } else if (readdirSync(directory).some(file => /^(capture-|effect-|hook-effect-)/.test(file))) {
      throw new Error("Task delta journal lacks a manifest.");
    }
  }
  const current = checkoutSnapshot(first.association.root).files;
  const netChanged = [...new Set([...Object.keys(baseline!.files), ...Object.keys(current)])]
    .filter(file => !equal(baseline!.files[file] ?? null, current[file] ?? null)).sort();
  return { touched: [...touched].sort(), netChanged };
});
export function captureCheckpoint(intent: CheckpointIntent, paths: string[]) {
  const directory = checkpointDirectory(intent), root = intent.association.root;
  if (!Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length)
    throw new Error("Checkpoint needs unique exact affected paths.");
  const manifest: Manifest = { intent, base: checkoutEvidence(root), index: index(root),
    files: paths.map(file => ({ path: file, image: image(root, file) })) };
  // No checkout effects precede the complete durable manifest.
  durableDirectory(directory);
  atomic(path.join(directory, "manifest.json"), manifest);
  return { directory, base: manifest.base, position: { loop: intent.loop, cursor: intent.cursor, phase: intent.phase } };
}
// First-touch records and effect intents are append-only, published with the shared fsync helper.
export function beginHookEffect(intent: CheckpointIntent, tool: string, paths: string[]) {
  const directory = checkpointDirectory(intent), root = intent.association.root;
  durableDirectory(directory);
  if (["unit.json", "pause.json", "restore.json"].some(file => existsSync(path.join(directory, file))))
    throw new Error("Checkpoint is sealed or restoration has started.");
  if (!existsSync(path.join(directory, "manifest.json")))
    atomic(path.join(directory, "manifest.json"), { intent, base: checkoutEvidence(root), index: index(root), files: [] });
  const files = readdirSync(directory);
  const captures = files.filter(file => /^capture-\d{6}\.json$/.test(file)).sort();
  const known = new Set<string>();
  if (existsSync(path.join(directory, "manifest.json"))) {
    const manifest = read<Manifest>(path.join(directory, "manifest.json"));
    if (!equal(manifest.intent, intent)) throw new Error("Checkpoint intention association mismatch.");
    for (const file of manifest.files) known.add(file.path);
  }
  for (const file of captures) {
    const capture = read<{ intent: CheckpointIntent; path: string; image: Image }>(path.join(directory, file));
    if (!equal(capture.intent, intent)) throw new Error("Hook capture intention mismatch.");
    known.add(capture.path);
  }
  const before = paths.map(file => ({ path: file, image: image(root, file) }));
  let count = captures.length;
  for (const file of before) if (!known.has(file.path)) {
    atomic(path.join(directory, `capture-${String(count++).padStart(6, "0")}.json`), { intent, ...file });
    known.add(file.path);
  }
  const seq = files.filter(file => /^hook-effect-\d{6}\.json$/.test(file)).length;
  atomic(path.join(directory, `hook-effect-${String(seq).padStart(6, "0")}.json`), { intent, tool, seq, paths, before });
  return seq;
}
export function closeHookEffect(intent: CheckpointIntent, seq: number) {
  const directory = checkpointDirectory(intent), name = `hook-effect-${String(seq).padStart(6, "0")}`;
  const effect = read<{ intent: CheckpointIntent; paths: string[] }>(path.join(directory, `${name}.json`));
  if (!equal(effect.intent, intent)) throw new Error("Hook effect intention mismatch.");
  const after = effect.paths.map(file => ({ path: file, image: image(intent.association.root, file) }));
  atomic(path.join(directory, `${name}-closed.json`), { after });
}
function writeImage(root: string, directory: string, relative: string, value: Image) {
  const file = safePath(root, relative);
  if (value === null) {
    if (existsSync(file)) { unlinkSync(file); syncDirectory(path.dirname(file)); }
    return;
  }
  durableDirectory(path.dirname(file));
  // Atomic replacement leaves either a recorded preimage or a recorded postimage.
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", value.mode);
  try { writeFileSync(fd, Buffer.from(value.bytes, "base64")); fchmodSync(fd, value.mode); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, file); syncDirectory(path.dirname(file));
}
export function prepareCheckpoint(intent: CheckpointIntent, changes: { path: string; image: Image }[]) {
  const { directory, manifest, steps } = load(intent), root = intent.association.root;
  if (readdirSync(directory).some(file => /^hook-effect-/.test(file)))
    throw new Error("Use edit/write/apply_patch for hook-journaled attempts.");
  if (["unit.json", "pause.json"].some(file => existsSync(path.join(directory, file))))
    throw new Error("Checkpoint unit already sealed; next work requires its own captured intention.");
  if (existsSync(path.join(directory, "restore.json"))) throw new Error("Checkpoint restoration already started.");
  if (!Array.isArray(changes) || !changes.length || new Set(changes.map(change => change.path)).size !== changes.length)
    throw new Error("Effects need unique exact paths.");
  const expected = new Map(manifest.files.map(file => [file.path, file.image]));
  for (const step of steps) for (const entry of step) expected.set(entry.path, entry.after);
  for (const [file, expectedImage] of expected)
    if (!equal(image(root, file), expectedImage)) throw new Error("Checkpoint previous effect is incomplete or conflicted.");
  const entries = changes.map(change => {
    if (!expected.has(change.path)) throw new Error("Effect outside captured checkpoint paths; capture another unit before editing.");
    validateImage(change.image);
    const before = image(root, change.path);
    if (!equal(before, expected.get(change.path))) throw new Error("Checkpoint current preimage conflict.");
    return { path: change.path, before, after: change.image };
  });
  atomic(path.join(directory, `effect-${String(steps.length).padStart(6, "0")}.json`), entries);
}
export function completeCheckpoint(intent: CheckpointIntent) {
  const { directory, manifest, steps } = load(intent), root = intent.association.root;
  if (existsSync(path.join(directory, "restore.json"))) throw new Error("Checkpoint restoration already started.");
  const latest = new Map(manifest.files.map(file => [file.path, file.image]));
  for (const step of steps) for (const entry of step) latest.set(entry.path, entry.after);
  for (const file of manifest.files) {
    const pending = steps.at(-1)?.find(entry => entry.path === file.path);
    const current = image(root, file.path);
    if (!equal(current, latest.get(file.path)) && !(pending && equal(current, pending.before)))
      throw new Error("Checkpoint effect conflict.");
  }
  for (const entry of steps.at(-1) ?? []) writeImage(root, directory, entry.path, entry.after);
}
export function applyCheckpoint(intent: CheckpointIntent, changes: { path: string; image: Image }[]) {
  prepareCheckpoint(intent, changes);
  completeCheckpoint(intent);
}
export function previousUnitMatches(pending: CheckpointIntent, unit: ConfirmedUnit): boolean {
  const position = unit.position as { loop?: number } | null;
  const progress = unit.progress as CheckpointProgress | null;
  return unit.kind === "unit" && equal(pending.progress?.previous, {
    taskId: unit.taskId, attempt: unit.attempt, resultRef: unit.resultRef,
    checkpointRef: unit.checkpointRef, digest: unit.digest,
  }) && (equal(unit.position, { loop: pending.loop, cursor: pending.cursor, phase: pending.phase }) ||
    (typeof position?.loop === "number" && position.loop < pending.loop && pending.cursor === 0 &&
      Object.keys(pending.progress?.admitted ?? {}).length === 0 &&
      pending.progress?.consumedLoops === pending.loop && progress?.consumedLoops === position.loop));
}

// Only the latest root-admitted unit can supply postimages when the pending
// writer never published its capture, including across v6 task loops.
function confirmedUnitSource(pending: CheckpointIntent, unit: ConfirmedUnit) {
  const earlierLoop = unit.position !== null && typeof unit.position === "object" &&
    "loop" in unit.position && typeof unit.position.loop === "number" && unit.position.loop < pending.loop;
  if (!previousUnitMatches(pending, unit) ||
      !/^([a-f0-9]{64})$/.test(unit.digest) || !/^([A-Za-z0-9_-][A-Za-z0-9._-]*)\/unit\.json$/.test(path.relative(path.join(pending.association.root, ".pi/subagents/checkpoints"), unit.checkpointRef).split(path.sep).join("/")) ||
      path.relative(path.join(pending.association.root, ".pi/subagents/checkpoints"), unit.checkpointRef).includes(".."))
    throw new Error("Confirmed unit lacks admitted pending-position provenance.");
  if (hash(readFileSync(unit.checkpointRef, "utf8")) !== unit.digest) throw new Error("Confirmed unit digest mismatch.");
  const point = read<{ intent: CheckpointIntent; kind: string; sourceManifest: string; files: Manifest["files"];
    candidate: { head: string; fingerprint: string }; position: unknown; progress: unknown }>(unit.checkpointRef);
  const intent = point.intent;
  if (!equal(intent.association, pending.association) ||
      (!earlierLoop && (!equal(intent.planRef, pending.planRef) || intent.loop !== pending.loop || intent.cursor + 1 !== pending.cursor)) ||
      (earlierLoop && (intent.loop >= pending.loop || intent.progress?.consumedLoops !== intent.loop ||
        !equal(unit.position, { loop: intent.loop, cursor: intent.cursor + 1, phase: intent.phase }))) ||
      intent.taskId !== unit.taskId || intent.attempt !== unit.attempt || intent.phase !== pending.phase ||
      unit.checkpointRef !== path.join(checkpointDirectory(intent), "unit.json") || point.kind !== "unit" ||
      !equal(point.position, unit.position) || !equal(point.progress, unit.progress) ||
      !equal(intent.progress, point.progress) ||
      (!earlierLoop && intent.progress!.consumedLoops !== pending.progress!.consumedLoops) ||
      !equal({ head: point.candidate.head, fingerprint: point.candidate.fingerprint }, unit.candidate))
    throw new Error("Confirmed unit association/progress mismatch.");
  const loaded = load(intent);
  if (point.sourceManifest !== manifestDigest(loaded.directory) ||
      !equal(point.files.map(file => file.path), loaded.manifest.files.map(file => file.path)))
    throw new Error("Confirmed unit manifest mismatch.");
  const latest = new Map(loaded.manifest.files.map(file => [file.path, file.image]));
  for (const step of loaded.steps) for (const entry of step) latest.set(entry.path, entry.after);
  for (const file of point.files) {
    validateImage(file.image);
    if (!equal(file.image, latest.get(file.path))) throw new Error("Confirmed unit bytes conflict with journal.");
  }
  return { intent, files: point.files };
}
function publishedSource(sources: CheckpointIntent[]) {
  for (const intent of sources) {
    const directory = checkpointDirectory(intent);
    if (existsSync(path.join(directory, "manifest.json"))) return intent;
    if (existsSync(directory) && readdirSync(directory).some(file => /^(effect-\d{6}|unit|pause|restore|restored)\.json$/.test(file)))
      throw new Error("Checkpoint lacks reconstructible preimages for retained effects.");
  }
}
// Read-only recovery witness. Keys, timestamps and renamed manifests are not
// progress: only validated file states, admitted progress and durable restoration
// publication contribute. Repeated equivalent captures therefore cannot renew it.
function evidence(sources: CheckpointIntent[], progress: Pick<CheckpointProgress, "consumedLoops" | "admitted">, confirmedUnit?: ConfirmedUnit) {
  const first = sources[0];
  if (!first || sources.some(item => !equal(item.association, first.association) ||
      item.taskId !== first.taskId || item.loop !== first.loop || item.cursor !== first.cursor))
    throw new Error("Checkpoint observation sources conflict.");
  const selected = publishedSource(sources);
  const unit = !selected && confirmedUnit ? confirmedUnitSource(first, confirmedUnit) : undefined;
  const observedSources = unit ? [unit.intent] : sources;
  const material = new Set<string>();
  let published = false;
  for (const intent of observedSources) {
    const directory = checkpointDirectory(intent);
    if (!existsSync(path.join(directory, "manifest.json"))) continue;
    const { manifest, steps, openPaths } = load(intent);
    published = true;
    const states = new Map<string, Image[]>();
    const add = (file: string, value: Image) => {
      validateImage(value);
      material.add(JSON.stringify({ path: file, image: value }));
      states.set(file, [...(states.get(file) ?? []), value]);
    };
    for (const file of manifest.files) add(file.path, file.image);
    for (const step of steps) for (const entry of step) { add(entry.path, entry.before); add(entry.path, entry.after); }

    const partialFile = path.join(directory, "restore.json");
    if (existsSync(partialFile)) {
      const partial = read<{ intent: CheckpointIntent; partial: { path: string; image: Image }[] }>(partialFile);
      if (!equal(partial.intent, intent) || !equal(partial.partial.map(file => file.path), manifest.files.map(file => file.path)))
        throw new Error("Checkpoint restoration observation conflicts.");
      for (const file of partial.partial) add(file.path, file.image);
      material.add(JSON.stringify({ preserved: partial.partial }));
      const restoredFile = path.join(directory, "restored.json");
      if (existsSync(restoredFile)) {
        const restored = read<{ checkpointRef: string; digest: string; partialRef: string; position: unknown }>(restoredFile);
        if (restored.checkpointRef !== path.join(directory, "manifest.json") || restored.partialRef !== partialFile ||
            restored.digest !== manifestDigest(directory) ||
            !equal(restored.position, { loop: first.loop, cursor: unit ? first.cursor : intent.cursor, phase: intent.phase }))
          throw new Error("Checkpoint restored observation conflicts.");
        material.add(JSON.stringify({ restored: partial.partial }));
      }
    }
    // Validate the currently selected file state, not all older unit states.
    if (published && intent === (unit?.intent ?? selected)) {
      for (const file of manifest.files) if (openPaths.has(file.path)) add(file.path, image(intent.association.root, file.path));
      for (const file of manifest.files) if (!openPaths.has(file.path) && !(unit ? [unit.files.find(entry => entry.path === file.path)!.image] : states.get(file.path)!).some(value => equal(value, image(intent.association.root, file.path))))
        throw new Error(`Unattributed checkpoint changes: ${file.path}`);
    }
  }
  if (!published) throw new Error("Checkpoint lacks reconstructible preimages.");
  // Current admitted logical progress, not the progress copied into each old
  // capture. Attempt numbers/references and equivalent repeated admissions are
  // nominal; owned file images above retain actual pending-work effects.
  const pairs = Object.entries(progress.admitted).flatMap(([taskId, states]) =>
    states.map(status => ({ taskId, status })));
  const admitted = [...new Set(pairs.map(({ taskId, status }) =>
    JSON.stringify({ taskId, status })))].sort();
  return hash(JSON.stringify({ material: [...material].sort(), consumedLoops: progress.consumedLoops, admitted }));
}
function restore(source: CheckpointIntent | CheckpointIntent[], authority: RestoreAuthority) {
  // A restoration dispatch may disappear before capturing its own unit. Keep
  // the exact older source, not a fictional backup at the new attempt key.
  const sources = Array.isArray(source) ? source : [source];
  const first = sources[0];
  if (!first || sources.some((item, index) =>
      !equal(item.association, first.association) || item.taskId !== first.taskId ||
      item.loop !== first.loop || item.cursor !== first.cursor || item.phase !== first.phase ||
      (index > 0 && item.attempt >= sources[index - 1].attempt)))
    throw new Error("Checkpoint restoration sources conflict with pending unit.");
  if (authority.confirmedPause && !sources.some(item =>
      authority.confirmedPause!.checkpointRef === path.join(checkpointDirectory(item), "pause.json")))
    throw new Error("Confirmed pause is outside retained restoration sources.");
  // Only absence permits fallback. Corrupt/conflicting newer bytes must fail
  // validation rather than hiding behind an older, apparently usable point.
  const selected = publishedSource(sources);
  const unit = !selected && authority.confirmedUnit ? confirmedUnitSource(first, authority.confirmedUnit) : undefined;
  const intent = selected ?? unit?.intent;
  if (!intent) throw new Error("Checkpoint lacks reconstructible preimages.");
  // Best-effort observations are not terminal certificates. Unknown activity stays
  // unknown; positive current activity and native barriers still forbid effects.
  if (authority.pending !== true || authority.stop !== false || authority.permissionDenied !== false ||
      ![false, null].includes(authority.activeWriter) ||
      !Array.isArray(authority.references) || !authority.references.length || authority.references.some(ref => typeof ref !== "string" || !ref.trim()))
    throw new Error("Checkpoint restore requires pending-unit authority without observed current barriers.");
  const { directory, manifest, steps, openPaths } = load(intent), root = intent.association.root;
  // A root-admitted pause advances the file baseline without completing the task.
  // Newer successor manifests already capture that baseline; only the exact
  // paused source uses its seal instead of rolling confirmed WIP back pre-unit.
  let baseline = unit?.files ?? manifest.files;
  const pause = authority.confirmedPause;
  if (pause && pause.checkpointRef === path.join(directory, "pause.json")) {
    if (pause.kind !== "pause" || hash(readFileSync(pause.checkpointRef, "utf8")) !== pause.digest)
      throw new Error("Confirmed pause digest mismatch.");
    const point = read<{ intent: CheckpointIntent; kind: string; sourceManifest: string;
      files: typeof baseline; candidate: { head: string; fingerprint: string }; position: unknown; progress: unknown }>(pause.checkpointRef);
    if (!equal(point.intent, intent) || point.kind !== "pause" ||
        point.sourceManifest !== manifestDigest(directory) ||
        !equal({ head: point.candidate.head, fingerprint: point.candidate.fingerprint }, pause.candidate) || !equal(point.position, pause.position) ||
        !equal(point.progress, pause.progress) || !equal(point.files.map(file => file.path), baseline.map(file => file.path)))
      throw new Error("Confirmed pause association/progress mismatch.");
    const latest = new Map(manifest.files.map(file => [file.path, file.image]));
    for (const step of steps) for (const entry of step) latest.set(entry.path, entry.after);
    for (const file of point.files) if (!equal(file.image, latest.get(file.path)))
      throw new Error("Confirmed pause bytes conflict with journal.");
    baseline = point.files;
  }
  const restoreFile = path.join(directory, "restore.json");
  const possible = new Map(manifest.files.map(file => [file.path, [file.image]]));
  // Only the last journal may be partially applied at interruption.
  for (const step of steps) for (const entry of step) {
    possible.set(entry.path, [entry.after]);
  }
  for (const entry of steps.at(-1) ?? []) possible.set(entry.path, [entry.before, entry.after]);
  if (unit) for (const file of unit.files) possible.set(file.path, [file.image]);
  const partial = manifest.files.map(file => ({ path: file.path, image: image(root, file.path) }));
  const retained = existsSync(restoreFile) ? read<{ intent: CheckpointIntent; partial: typeof partial }>(restoreFile) : null;
  if (retained && !equal(retained.intent, intent)) throw new Error("Restore association mismatch.");
  for (const file of partial) {
    const allowed = retained
      ? [retained.partial.find(entry => entry.path === file.path)?.image, baseline.find(entry => entry.path === file.path)!.image]
      : possible.get(file.path)!;
    if (!retained && openPaths.has(file.path)) continue;
    if (!allowed.some(value => equal(value, file.image))) throw new Error(`Unattributed checkpoint changes: ${file.path}`);
  }
  if (!retained) atomic(restoreFile, { intent, authority, partial, restored: baseline, candidate: checkoutEvidence(root) });
  // Partial bytes and intent are durable before the first restoration effect.
  for (const file of baseline) writeImage(root, directory, file.path, file.image);
  const restored = { position: { loop: first.loop, cursor: unit ? first.cursor : intent.cursor, phase: first.phase },
    candidate: checkoutEvidence(root), partialRef: restoreFile, checkpointRef: path.join(directory, "manifest.json"),
    digest: manifestDigest(directory),
    ...(pause?.checkpointRef === path.join(directory, "pause.json")
      ? { confirmedPause: { checkpointRef: pause.checkpointRef, digest: pause.digest } } : {}),
    ...(unit ? { confirmedUnit: { checkpointRef: authority.confirmedUnit!.checkpointRef, digest: authority.confirmedUnit!.digest } } : {}),
    preserve: "maxCycles, consumed slots, admitted results and attempt history; revalidate candidate-dependent checks" };
  const receipt = path.join(directory, "restored.json");
  if (!existsSync(receipt)) atomic(receipt, restored);
  return restored;
}

function admittedProgress(intent: CheckpointIntent) {
  const progress = intent.progress;
  if (!progress || !Number.isSafeInteger(progress.consumedLoops) || progress.consumedLoops < intent.loop ||
      progress.consumedLoops > intent.association.maxCycles ||
      !progress.admitted || typeof progress.admitted !== "object" || Array.isArray(progress.admitted) ||
      !Object.values(progress.admitted).every(states => Array.isArray(states) &&
        states.every(state => typeof state === "string") && new Set(states).size === states.length) ||
      !(progress.previous === null || (progress.previous && typeof progress.previous.taskId === "string" &&
        Number.isSafeInteger(progress.previous.attempt) && progress.previous.attempt > 0 &&
        typeof progress.previous.checkpointRef === "string" && /^[a-f0-9]{64}$/.test(progress.previous.digest) &&
        progress.previous.resultRef !== undefined)))
    throw new Error("Checkpoint lacks coherent admitted progress.");
  return progress;
}

// A seal contains bytes, not admission authority. Only the root's durable result
// admission confirms it as a continuation point. A pause never completes a task.
export function sealCheckpoint(intent: CheckpointIntent, kind: "unit" | "pause", controlPermitsCapture: boolean, restored: Manifest["files"] = []) {
  return seal(intent, kind, controlPermitsCapture, restored);
}
function seal(intent: CheckpointIntent, kind: "unit" | "pause", controlPermitsCapture: boolean, restored: Manifest["files"], attributedFiles?: Manifest["files"]) {
  if (controlPermitsCapture !== true) throw new Error("Native control does not permit checkpoint capture.");
  if (kind !== "unit" && kind !== "pause") throw new Error("Invalid checkpoint seal kind.");
  const { directory, manifest, steps, openPaths } = load(intent), root = intent.association.root;
  if (openPaths.size) throw new Error("Cannot seal never-closed checkpoint effects.");
  if (existsSync(path.join(directory, "restore.json"))) throw new Error("Checkpoint restoration already started.");
  // The request already attributed these exact files with the same intent/restored images.
  if (!equal(manifest.files, attributedFiles)) attribution(intent, manifest.files, restored);
  const progress = admittedProgress(intent);
  const latest = new Map(manifest.files.map(file => [file.path, file.image]));
  for (const step of steps) for (const entry of step) latest.set(entry.path, entry.after);
  const files = manifest.files.map(file => ({ path: file.path, image: image(root, file.path) }));
  for (const file of files) if (!equal(file.image, latest.get(file.path)))
    throw new Error("Cannot seal incomplete or conflicting checkpoint effects.");
  const checkpointRef = path.join(directory, `${kind}.json`);
  const point = { intent, kind, sourceManifest: manifestDigest(directory),
    candidate: checkoutEvidence(root), index: manifest.index, files,
    position: { loop: intent.loop, cursor: intent.cursor + (kind === "unit" ? 1 : 0), phase: intent.phase },
    progress };
  if (existsSync(checkpointRef)) {
    if (!equal(read(checkpointRef), point)) throw new Error("Checkpoint seal conflicts with retained original.");
  } else atomic(checkpointRef, point);
  return { kind, checkpointRef, digest: hash(readFileSync(checkpointRef, "utf8")),
    candidate: { head: point.candidate.head, fingerprint: point.candidate.fingerprint },
    position: point.position, progress };
}

export type SealerRequest = { v: 1; intent: CheckpointIntent; kind: "unit" | "pause" | null; restoreSources?: CheckpointIntent[] };
// This runtime operation writes seal metadata only; it never completes journal effects.
function sealRequest(request: SealerRequest) {
  if (!request || request.v !== 1 || ![null, "unit", "pause"].includes(request.kind) ||
      Object.keys(request).some(key => !["v", "intent", "kind", "restoreSources"].includes(key)))
    throw new Error("Invalid checkpoint sealer request.");
  const { intent, kind } = request, root = intent.association.root;
  if (process.cwd() !== root) throw new Error("Checkpoint sealer cwd must equal intent.association.root.");
  const directory = checkpointDirectory(intent);
  const observed = checkoutEvidence(root);
  const candidate = { head: observed.head, fingerprint: observed.fingerprint };
  const base = { v: 1 as const, kind, candidate, capturedPaths: 0 };
  let selected = intent;
  if (request.restoreSources) {
    if (!request.restoreSources.length || request.restoreSources.some(source =>
        !equal(source.association, intent.association) || source.taskId !== intent.taskId ||
        source.loop !== intent.loop || source.cursor !== intent.cursor))
      throw new Error("Checkpoint restoration sources conflict with pending unit.");
    const published = publishedSource(request.restoreSources);
    selected = published ?? intent;
    if (!published && intent.progress?.previous) {
      const previous = intent.progress.previous;
      const relative = path.relative(path.join(root, ".pi/subagents/checkpoints"), previous.checkpointRef).split(path.sep).join("/");
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\/unit\.json$/.test(relative) || relative.includes(".."))
        throw new Error("Confirmed unit is outside checkpoint storage.");
      const point = read<{ candidate: { head: string; fingerprint: string }; position: unknown; progress: unknown }>(previous.checkpointRef);
      selected = confirmedUnitSource(intent, { ...previous, kind: "unit", candidate: { head: point.candidate.head, fingerprint: point.candidate.fingerprint },
        position: point.position, progress: point.progress }).intent;
    }
  }
  const selectedDirectory = checkpointDirectory(selected);
  if (!existsSync(path.join(selectedDirectory, "manifest.json"))) {
    attribution(intent, []);
    return { ...base, outcome: "observed" as const };
  }
  const { manifest, steps, openPaths } = load(selected);
  base.capturedPaths = manifest.files.length;
  if (openPaths.size && !request.restoreSources)
    return { ...base, outcome: "open" as const, paths: [...openPaths].slice(0, 10) };
  let expected = new Map(manifest.files.map(file => [file.path, file.image]));
  for (const step of steps) for (const entry of step) expected.set(entry.path, entry.after);
  let restored: ReturnType<typeof restore> | undefined;
  let restoredFiles: Manifest["files"] = [];
  if (request.restoreSources) {
    const partialRef = path.join(selectedDirectory, "restore.json");
    const partial = read<{ intent: CheckpointIntent; authority: RestoreAuthority; partial: Manifest["files"]; restored?: Manifest["files"] }>(partialRef);
    restored = read<ReturnType<typeof restore>>(path.join(selectedDirectory, "restored.json"));
    if (!equal(partial.intent, selected) || restored.partialRef !== partialRef ||
        restored.checkpointRef !== path.join(selectedDirectory, "manifest.json") ||
        restored.digest !== manifestDigest(selectedDirectory) ||
        !equal(restored.position, { loop: intent.loop, cursor: intent.cursor, phase: intent.phase }))
      throw new Error("Checkpoint restoration observation conflicts.");
    let baseline = manifest.files;
    const unit = partial.authority.confirmedUnit;
    if (unit && unit.checkpointRef === path.join(selectedDirectory, "unit.json"))
      baseline = confirmedUnitSource(intent, unit).files;
    const pause = partial.authority.confirmedPause;
    if (pause && pause.checkpointRef === path.join(selectedDirectory, "pause.json")) {
      if (hash(readFileSync(pause.checkpointRef, "utf8")) !== pause.digest)
        throw new Error("Confirmed pause digest mismatch.");
      const point = read<{ intent: CheckpointIntent; files: Manifest["files"] }>(pause.checkpointRef);
      if (!equal(point.intent, selected)) throw new Error("Confirmed pause association mismatch.");
      baseline = point.files;
    }
    if (partial.restored && !equal(partial.restored, baseline)) throw new Error("Restored baseline conflicts with source images.");
    restoredFiles = baseline;
    expected = new Map(baseline.map(file => [file.path, file.image]));
  }
  // Restoration attests to the historical baseline. New task effects belong to
  // the current attempt's journal, not to that historical candidate.
  const current = selected.key === intent.key ? { manifest, steps, openPaths } :
    existsSync(path.join(directory, "manifest.json")) ? load(intent) : undefined;
  base.capturedPaths = current?.manifest.files.length ?? 0;
  if (current?.openPaths.size && selected.key !== intent.key)
    return { ...base, outcome: "open" as const, paths: [...current.openPaths].slice(0, 10) };
  if (restored && current && selected.key !== intent.key) {
    if (!equal(current.manifest.base, restored.candidate))
      throw new Error("Current checkpoint does not capture the restored baseline.");
    for (const file of current.manifest.files) expected.set(file.path, file.image);
    for (const step of current.steps) for (const entry of step) expected.set(entry.path, entry.after);
  }
  const sha256 = (value: Image) => value === null ? null : createHash("sha256").update(Buffer.from(value.bytes, "base64")).digest("hex");
  const paths = [...expected.keys()].flatMap(filePath => {
    const file = { path: filePath };
    const actual = image(root, file.path), journaled = expected.get(file.path)!;
    const pending = (current?.steps ?? steps).at(-1)?.find(entry => entry.path === file.path);
    return equal(actual, journaled) ? [] : [{ path: file.path, journaled: sha256(journaled), actual: sha256(actual),
      partiallyApplied: !!pending && equal(actual, pending.before) && !equal(pending.before, pending.after) }];
  });
  if (paths.length) return { ...base, outcome: "mismatch" as const, paths: paths.slice(0, 10) };
  const restoration = restored ? { restored: { ...restored, restoredRef: path.join(selectedDirectory, "restored.json") } } : {};
  if (restored && (!current || selected.key === intent.key)) {
    if (!equal({ head: restored.candidate.head, fingerprint: restored.candidate.fingerprint }, candidate))
      throw new Error("Restored checkpoint candidate conflicts with current checkout.");
    return { ...base, outcome: "observed" as const, ...restoration };
  }
  attribution(intent, current?.manifest.files ?? [], restoredFiles);
  // A retained seal of this attempt is identified, never rewritten: identical
  // sealed content is idempotent (its sealing candidate stays the admitted one);
  // different content is an integrity conflict naming the differing files.
  if (kind !== null) for (const retainedKind of ["unit", "pause"]) {
    const ref = path.join(directory, `${retainedKind}.json`);
    if (!existsSync(ref)) continue;
    const point = read<{ intent: CheckpointIntent; candidate: typeof observed; files: Manifest["files"]; sourceManifest: string;
      position: { loop: number; cursor: number; phase: string } }>(ref);
    if (point.sourceManifest !== manifestDigest(directory) ||
        !equal(point.files.map(file => file.path), current?.manifest.files.map(file => file.path)))
      throw new Error("Checkpoint seal manifest mismatch.");
    const activeFiles = current?.manifest.files ?? manifest.files;
    const differing = activeFiles.filter(file =>
      !equal(point.files.find(entry => entry.path === file.path)?.image, image(root, file.path)));
    if (kind === retainedKind && !differing.length && equal(point.intent, intent))
      return { ...base, candidate: { head: point.candidate.head, fingerprint: point.candidate.fingerprint },
        outcome: "sealed" as const, checkpointRef: ref, digest: hash(readFileSync(ref, "utf8")), position: point.position, ...restoration };
    return { ...base, outcome: "mismatch" as const, paths: (differing.length ? differing : activeFiles).slice(0, 10).map(file => ({
      path: file.path, journaled: sha256(point.files.find(entry => entry.path === file.path)?.image ?? null),
      actual: sha256(image(root, file.path)), partiallyApplied: false })) };
  }
  if (kind === null) return { ...base, outcome: "observed" as const, ...restoration };
  const sealed = seal(intent, kind, true, restoredFiles, current?.manifest.files);
  return { ...base, outcome: "sealed" as const, checkpointRef: sealed.checkpointRef, digest: sealed.digest, position: sealed.position, ...restoration };
}
// No writer is active during sealing. Its only write is the final seal under
// .pi, excluded from the fingerprint by :(top,exclude).pi and made after the
// stored candidate is taken (status has no pathspec), so the stored candidate,
// including status/branch, is exactly the observation attribution verified.
// Restoration writes checkout paths and must never opt into this scope.
export const sealCheckpointRequest = operation((request: SealerRequest) => {
  try { return sealRequest(request); }
  catch (error) {
    if (!(error instanceof Error) || !("attributionPaths" in error)) throw error;
    const observed = checkoutEvidence(request.intent.association.root);
    return { v: 1 as const, kind: request.kind, outcome: "mismatch" as const,
      candidate: { head: observed.head, fingerprint: observed.fingerprint },
      paths: error.attributionPaths as { path: string; journaled: string | null; actual: string | null; partiallyApplied: boolean }[] };
  }
}, true);

// Public pre-write capture over the same storage used by the CLI. Sealing is
// root-owned; publication is not root admission and never changes mission state.
function create(intent: CheckpointIntent, kind: "pre", paths?: string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (kind !== "pre") throw new Error("Invalid checkpoint point kind.");
  const progress = admittedProgress(intent);
  const directory = checkpointDirectory(intent), manifestRef = path.join(directory, "manifest.json");
  const existed = existsSync(manifestRef);
  if (!paths?.length || new Set(paths).size !== paths.length) throw new Error("Checkpoint needs unique exact affected paths.");
  if (existed) {
    const { manifest, steps } = load(intent);
    if (steps.length || !equal(manifest.files.map(file => file.path), paths) ||
        !equal(manifest.files, paths.map(file => ({ path: file, image: image(intent.association.root, file) }))) ||
        manifest.base.fingerprint !== checkoutEvidence(intent.association.root).fingerprint)
      throw new Error("Checkpoint operation conflicts with retained original content.");
  } else {
    signal?.throwIfAborted();
    captureCheckpoint(intent, paths);
  }
  const { manifest } = load(intent);
  return { ok: true, status: existed ? "existing" : "created", kind, directory, checkpointRef: manifestRef,
    digest: hash(readFileSync(manifestRef, "utf8")), manifestRef,
    files: manifest.files.map(file => ({ path: file.path, exists: file.image !== null,
      sha256: file.image === null ? null : createHash("sha256").update(Buffer.from(file.image.bytes, "base64")).digest("hex"),
      mode: file.image?.mode ?? null })),
    position: { loop: intent.loop, cursor: intent.cursor, phase: intent.phase },
    progress, candidate: { head: manifest.base.head, fingerprint: manifest.base.fingerprint }, confirmed: false };
}
export const checkpointEvidence = operation(evidence);
export const restoreCheckpoint = operation(restore);
export const createCheckpoint = operation(create);
