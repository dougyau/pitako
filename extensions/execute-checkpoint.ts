import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { checkoutEvidence, designatedWorkspace, gitRead } from "./spec-plans.ts";

type Image = { bytes: string; mode: number } | null;
export type CheckpointIntent = {
  version: 2; association: { root: string; commonDir: string; missionId: string; missionPath: string; invocation: string; source: string; digest: string; maxCycles: number; sourceRefs: unknown[] };
  key: string; taskId: string; attempt: number; loop: number; cursor: number;
  phase: "implementation"; planRef: unknown;
  progress?: CheckpointProgress;
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
// Each public operation is synchronous, so its designated worktree cannot be
// re-registered between internal reads. Validate it once per operation, not
// once per checkpoint path: every validation spawns Git three times.
let workspaces: Map<string, ReturnType<typeof designatedWorkspace>> | undefined;
function operation<A extends unknown[], R>(run: (...args: A) => R) {
  return (...args: A): R => {
    if (workspaces) return run(...args);
    workspaces = new Map();
    try { return run(...args); } finally { workspaces = undefined; }
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
function index(root: string) { return hash(gitRead(root, "ls-files", "--stage", "-z")); }
function load(intent: CheckpointIntent) {
  const directory = checkpointDirectory(intent);
  const manifest = read<Manifest>(path.join(directory, "manifest.json"));
  if (!equal(manifest.intent, intent)) throw new Error("Checkpoint intention association mismatch.");
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
  return { directory, manifest, steps };
}
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
// Only the exact root-admitted unit immediately preceding the pending cursor
// can supply a baseline when that pending writer never published its capture.
function confirmedUnitSource(pending: CheckpointIntent, unit: ConfirmedUnit) {
  if (unit.kind !== "unit" || !equal(pending.progress?.previous, {
      taskId: unit.taskId, attempt: unit.attempt, resultRef: unit.resultRef,
      checkpointRef: unit.checkpointRef, digest: unit.digest }) ||
      !equal(unit.position, { loop: pending.loop, cursor: pending.cursor, phase: pending.phase }) ||
      !/^([a-f0-9]{64})$/.test(unit.digest) || !/^([A-Za-z0-9_-][A-Za-z0-9._-]*)\/unit\.json$/.test(path.relative(path.join(pending.association.root, ".pi/subagents/checkpoints"), unit.checkpointRef).split(path.sep).join("/")) ||
      path.relative(path.join(pending.association.root, ".pi/subagents/checkpoints"), unit.checkpointRef).includes(".."))
    throw new Error("Confirmed unit lacks admitted pending-position provenance.");
  if (hash(readFileSync(unit.checkpointRef, "utf8")) !== unit.digest) throw new Error("Confirmed unit digest mismatch.");
  const point = read<{ intent: CheckpointIntent; kind: string; sourceManifest: string; files: Manifest["files"];
    candidate: { head: string; fingerprint: string }; position: unknown; progress: unknown }>(unit.checkpointRef);
  const intent = point.intent;
  if (!equal(intent.association, pending.association) || !equal(intent.planRef, pending.planRef) ||
      intent.taskId !== unit.taskId || intent.attempt !== unit.attempt || intent.loop !== pending.loop ||
      intent.cursor + 1 !== pending.cursor || intent.phase !== pending.phase ||
      unit.checkpointRef !== path.join(checkpointDirectory(intent), "unit.json") || point.kind !== "unit" ||
      !equal(point.position, unit.position) || !equal(point.progress, unit.progress) ||
      !equal(intent.progress, point.progress) ||
      intent.progress!.consumedLoops !== pending.progress!.consumedLoops ||
      !equal({ head: point.candidate.head, fingerprint: point.candidate.fingerprint }, unit.candidate))
    throw new Error("Confirmed unit association/progress mismatch.");
  const loaded = load(intent);
  if (point.sourceManifest !== hash(readFileSync(path.join(loaded.directory, "manifest.json"), "utf8")) ||
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
function evidence(sources: CheckpointIntent[], progress: Pick<CheckpointProgress, "consumedLoops" | "admitted"> | { consumedLoops: number; admittedResults: { taskId: string; status: string }[] }, confirmedUnit?: ConfirmedUnit) {
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
    const { manifest, steps } = load(intent);
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
            restored.digest !== hash(readFileSync(restored.checkpointRef, "utf8")) ||
            !equal(restored.position, { loop: first.loop, cursor: unit ? first.cursor : intent.cursor, phase: intent.phase }))
          throw new Error("Checkpoint restored observation conflicts.");
        material.add(JSON.stringify({ restored: partial.partial }));
      }
    }
    // Validate the currently selected file state, not all older unit states.
    if (published && intent === (unit?.intent ?? selected)) {
      for (const file of manifest.files) if (!(unit ? [unit.files.find(entry => entry.path === file.path)!.image] : states.get(file.path)!).some(value => equal(value, image(intent.association.root, file.path))))
        throw new Error(`Unattributed checkpoint changes: ${file.path}`);
    }
  }
  if (!published) throw new Error("Checkpoint lacks reconstructible preimages.");
  // Current admitted logical progress, not the progress copied into each old
  // capture. Attempt numbers/references and equivalent repeated admissions are
  // nominal; owned file images above retain actual pending-work effects.
  const pairs = "admitted" in progress ? Object.entries(progress.admitted).flatMap(([taskId, states]) =>
    states.map(status => ({ taskId, status }))) : progress.admittedResults;
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
  const { directory, manifest, steps } = load(intent), root = intent.association.root;
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
        point.sourceManifest !== hash(readFileSync(path.join(directory, "manifest.json"), "utf8")) ||
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
    if (!allowed.some(value => equal(value, file.image))) throw new Error(`Unattributed checkpoint changes: ${file.path}`);
  }
  if (!retained) atomic(restoreFile, { intent, authority, partial, candidate: checkoutEvidence(root) });
  // Partial bytes and intent are durable before the first restoration effect.
  for (const file of baseline) writeImage(root, directory, file.path, file.image);
  const restored = { position: { loop: first.loop, cursor: unit ? first.cursor : intent.cursor, phase: first.phase },
    candidate: checkoutEvidence(root), partialRef: restoreFile, checkpointRef: path.join(directory, "manifest.json"),
    digest: hash(readFileSync(path.join(directory, "manifest.json"), "utf8")),
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
export function sealCheckpoint(intent: CheckpointIntent, kind: "unit" | "pause", controlPermitsCapture: boolean) {
  if (controlPermitsCapture !== true) throw new Error("Native control does not permit checkpoint capture.");
  if (kind !== "unit" && kind !== "pause") throw new Error("Invalid checkpoint seal kind.");
  const { directory, manifest, steps } = load(intent), root = intent.association.root;
  if (existsSync(path.join(directory, "restore.json"))) throw new Error("Checkpoint restoration already started.");
  const progress = admittedProgress(intent);
  const latest = new Map(manifest.files.map(file => [file.path, file.image]));
  for (const step of steps) for (const entry of step) latest.set(entry.path, entry.after);
  const files = manifest.files.map(file => ({ path: file.path, image: image(root, file.path) }));
  for (const file of files) if (!equal(file.image, latest.get(file.path)))
    throw new Error("Cannot seal incomplete or conflicting checkpoint effects.");
  const checkpointRef = path.join(directory, `${kind}.json`);
  const point = { intent, kind, sourceManifest: hash(readFileSync(path.join(directory, "manifest.json"), "utf8")),
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

// Public writer operation over the same capture/seal storage used by the CLI.
// Publication is not root admission; this function never changes mission state.
function create(intent: CheckpointIntent, kind: "pre" | "unit" | "pause", paths?: string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!["pre", "unit", "pause"].includes(kind)) throw new Error("Invalid checkpoint point kind.");
  const progress = admittedProgress(intent);
  const directory = checkpointDirectory(intent), manifestRef = path.join(directory, "manifest.json");
  let existed = existsSync(kind === "pre" ? manifestRef : path.join(directory, `${kind}.json`));
  if (kind === "pre") {
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
  }
  const { manifest } = load(intent);
  if (paths && !equal(paths, manifest.files.map(file => file.path))) throw new Error("Checkpoint affected paths conflict with retained original.");
  signal?.throwIfAborted();
  const receipt = kind === "pre" ? undefined : sealCheckpoint(intent, kind, true);
  const checkpointRef = receipt?.checkpointRef ?? manifestRef;
  const point = read<{ files: Manifest["files"] }>(checkpointRef);
  return { ok: true, status: existed ? "existing" : "created", kind, directory, checkpointRef,
    digest: hash(readFileSync(checkpointRef, "utf8")), manifestRef,
    files: point.files.map(file => ({ path: file.path, exists: file.image !== null,
      sha256: file.image === null ? null : createHash("sha256").update(Buffer.from(file.image.bytes, "base64")).digest("hex"),
      mode: file.image?.mode ?? null })),
    position: receipt?.position ?? { loop: intent.loop, cursor: intent.cursor, phase: intent.phase },
    progress, candidate: receipt?.candidate ?? { head: manifest.base.head, fingerprint: manifest.base.fingerprint },
    ...(receipt ? { checkpointReceipt: receipt } : {}), confirmed: false };
}
export const checkpointEvidence = operation(evidence);
export const restoreCheckpoint = operation(restore);
export const createCheckpoint = operation(create);
