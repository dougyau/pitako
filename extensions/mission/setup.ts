import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryIdentity } from "../board/workspace.ts";
import { verifyExecutionBinding, type ExecutionBinding } from "../workflow.ts";
import { consumeOperatorInput, type OperatorReceipt } from "./admission.ts";
import { missionInputIdentity } from "./inputs.ts";
import { sha256, type MissionDefinition } from "./model.ts";
import type { MissionInspection, MissionStore } from "./store.ts";
import { currentProcessIdentity, openSeccompFilter, ownerProcessState, processBirthTicks, processNamespaceId, processParentPid, processesInNamespace, readOwnedNamespaceInit, type ProcessIdentity } from "./workspace.ts";
import { assertCopyInputs, captureCopyIdentity, captureCopyOutputs, copyStorageBytes, initializeCopy, launchCopy, publishCopy, type CopyContract } from "./setup-copy.ts";
import { PhysicalObservation } from "./physical-observation.ts";
import { resourceLimit } from "./resources.ts";

const hash = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));
const PRODUCER_FILE = fileURLToPath(import.meta.url);
const CONTAINMENT_FILE = fileURLToPath(new URL("./workspace.ts", import.meta.url));
const ENV = { PATH: "/tmp/setup-runtime:/usr/bin:/bin", HOME: "/tmp/setup-home", TMPDIR: "/tmp",
  XDG_CACHE_HOME: "/tmp/setup-cache", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const LAUNCH = `printf '{"pidNamespace":"%s","networkNamespace":"%s"}\\n' "$(readlink /proc/self/ns/pid)" "$(readlink /proc/self/ns/net)"; IFS= read -r gate || exit 94; [ "$gate" = GO ] || exit 94; exec /bin/bash ./scripts/setup.sh </dev/null`;

export interface SetupAllocation {
  effectProfile: "execution-root-local-v1" | "execution-root-local-copy-v1";
  writableDirectories: string[];
  activeTimeMs: number;
  artifactBytes: number;
  copy?: CopyContract;
}
interface PathRow {
  path: string;
  kind: "file" | "directory" | "link" | "missing";
  mode?: number;
  identity?: string;
  hash?: string;
  target?: string;
  size?: number;
  nlink?: number;
  mtimeMs?: number;
}
export interface SetupIdentity {
  format: "mission-setup-input-v1" | "mission-setup-input-v2";
  binding: ExecutionBinding;
  repositoryFamily: string;
  rootIdentity: string;
  outputDirectories: Array<{ path: string; identity: string }>;
  script: PathRow | null;
  source: PathRow[];
  runtimes: Array<{ path: string; identity: string; hash: string; version: string }>;
  libraries: Array<{ path: string; identity: string; hash: string }>;
  platform: { os: string; arch: string; abi: string };
  environment: typeof ENV;
  producerHash: string;
  copy?: { destination: string; seeds: Array<{ source: string; destination: string; rootIdentity: string; rows: PathRow[] }>;
    bounds: CopyContract["bounds"] };
}
export interface PreparedSetup {
  identity: SetupIdentity;
  decision: { values: SetupAllocation; receiptId: string; source: OperatorReceipt["source"]; text: string };
  requiredBy: { unitIds: string[]; predicateIds: string[] };
}

/** Only concrete host-captured files and declared result paths establish supported input requirements.
 * Broad/unknown requirements remain dependent. Candidate isolation withholds setup outputs from independent work.
 * This validates structural input provenance, not command or source-criterion semantics. */
export function setupRequiredBy(identity: SetupIdentity, definition: MissionDefinition): PreparedSetup["requiredBy"] {
  const sourceFiles = new Set(identity.source.filter((row) => row.kind === "file").map(({ path }) => path));
  const concrete = (name: string) => !name.split("/").some((part) => !part || part === "." || part === "..") &&
    !path.isAbsolute(name) && !/[\\*?\0]/.test(name) &&
    !identity.outputDirectories.some((row) => name === row.path || name.startsWith(`${row.path}/`));
  const known = (names: string[] | undefined, outputs: string[] = []) => !!names?.length &&
    names.every((name) => concrete(name) && (sourceFiles.has(name) || outputs.includes(name)));
  const units = new Set(definition.units.filter((unit) =>
    !known(unit.inputs) || unit.acceptance.some((predicate) => !known(predicate.inputPaths, unit.outputs))).map(({ id }) => id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of definition.units) if (!units.has(unit.id) && unit.dependencies.some((id) => units.has(id))) {
      units.add(unit.id); changed = true;
    }
  }
  return { unitIds: [...units].sort(), predicateIds: definition.units.flatMap((unit) => unit.acceptance
    .filter((predicate) => units.has(unit.id) || !known(predicate.inputPaths, unit.outputs)).map(({ id }) => id)).sort() };
}

export function assertSetupRequirements(setup: PreparedSetup, definition: MissionDefinition): void {
  const required = setupRequiredBy(setup.identity, definition);
  const unitIds = new Set(definition.units.map(({ id }) => id));
  const predicateIds = new Set(definition.units.flatMap(({ acceptance }) => acceptance.map(({ id }) => id)));
  for (const [key, allowed] of [["unitIds", unitIds], ["predicateIds", predicateIds]] as const) {
    const ids = setup.requiredBy[key];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some((id) => !allowed.has(id)) ||
      required[key].some((id) => !ids.includes(id)))
      throw new Error("setup prerequisite obligation references changed or are incomplete");
  }
  for (const unit of definition.units) if (unit.dependencies.some((id) => setup.requiredBy.unitIds.includes(id)) &&
    !setup.requiredBy.unitIds.includes(unit.id)) throw new Error("setup prerequisite dependency closure is incomplete");
  for (const unit of definition.units) if (setup.requiredBy.unitIds.includes(unit.id) &&
    unit.acceptance.some(({ id }) => !setup.requiredBy.predicateIds.includes(id)))
    throw new Error("setup prerequisite predicate closure is incomplete");
}
export interface SetupStartAdmission { readonly id: string }
interface StartAuthority {
  store: MissionStore;
  missionId: string;
  revision: number;
  ownerEpoch: number;
  writerIdentity: { epoch: number; claimId: string };
  preparedHash: string | undefined;
  definitionHash: string;
  recheck: () => void;
  scope: "start" | "prepare";
}
const starts = new WeakMap<SetupStartAdmission, StartAuthority>();

/** Host-only ingress. A serialized receipt, ordinary bash choice, or previous execution is not a start. */
export function setupStartText(store: MissionStore, missionId: string, sessionId: string): string {
  const inspection = store.inspectMission(missionId);
  const setup = inspection.prepared?.setup;
  if (!setup) throw new Error("no prepared setup effect contract");
  return JSON.stringify({ action: "execute-prepared-setup", sessionId, missionId,
    revision: inspection.revision, ownerEpoch: store.ownerEpoch, runtimeId: store.runtimeId,
    preparedHash: inspection.snapshot.preparedHash, definitionHash: inspection.snapshot.definitionHash,
    pin: missionInputIdentity(inspection, inspection.prepared!.binding.executionRoot),
    setup: { recipeHash: hash(setup.identity), effectDecision: setup.decision } });
}
export function admitSetupStart(store: MissionStore, missionId: string, sessionId: string,
  receipt: OperatorReceipt, recheck: () => void): SetupStartAdmission {
  recheck();
  const text = setupStartText(store, missionId, sessionId);
  if (receipt.source !== "native-confirmation") throw new Error("setup needs exact native execution admission");
  consumeOperatorInput(receipt, sessionId, text);
  if (store.ownerEpoch === null) throw new Error("setup writer is absent");
  const inspection = store.inspectMission(missionId);
  const admission = Object.freeze({ id: receipt.id });
  starts.set(admission, { store, missionId, revision: inspection.revision, ownerEpoch: store.ownerEpoch,
    writerIdentity: store.ownershipIdentity,
    preparedHash: inspection.snapshot.preparedHash, definitionHash: inspection.snapshot.definitionHash, recheck, scope: "start" });
  return admission;
}

/** The exact prepared native payload already authorizes this recipe, not activation. */
export function admitPreparedSetup(store: MissionStore, missionId: string, recheck: () => void): SetupStartAdmission {
  recheck();
  const inspection = store.inspectMission(missionId);
  if (inspection.state !== "prepared" || !inspection.prepared?.setup?.identity.copy ||
    inspection.prepared.setup.decision.source !== "native-confirmation" || store.ownerEpoch === null)
    throw new Error("prepare setup requires a current native-approved copied contract");
  const admission = Object.freeze({ id: inspection.prepared.setup.decision.receiptId });
  starts.set(admission, { store, missionId, revision: inspection.revision, ownerEpoch: store.ownerEpoch,
    writerIdentity: store.ownershipIdentity, preparedHash: inspection.snapshot.preparedHash,
    definitionHash: inspection.snapshot.definitionHash, recheck, scope: "prepare" });
  return admission;
}

/** Derive setup execution from the one durable combined native admission, never a second receipt. */
export function admitFrozenSetupStart(store: MissionStore, missionId: string, receiptId: string,
  recheck: () => void): SetupStartAdmission {
  recheck();
  const inspection = store.inspectMission(missionId);
  const receipt = inspection.events[0]?.payload.operatorReceipt as OperatorReceipt | undefined;
  const action = receipt && JSON.parse(receipt.text);
  if (inspection.state !== "prepared" || !inspection.prepared?.setup || store.ownerEpoch === null ||
    receipt?.source !== "native-confirmation" || receipt.id !== receiptId ||
    action?.action !== "admit-and-start-frozen-mission-v1" || action.preparedHash !== inspection.snapshot.preparedHash ||
    inspection.prepared.setup.decision.receiptId !== receiptId)
    throw new Error("current combined frozen-start setup admission required");
  const admission = Object.freeze({ id: receiptId });
  starts.set(admission, { store, missionId, revision: inspection.revision, ownerEpoch: store.ownerEpoch,
    writerIdentity: store.ownershipIdentity, preparedHash: inspection.snapshot.preparedHash,
    definitionHash: inspection.snapshot.definitionHash, recheck, scope: "start" });
  return admission;
}

function physical(target: string): string {
  const stat = lstatSync(target);
  return `${stat.dev}:${stat.ino}:${stat.mode}`;
}
function beneath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function grantPaths(root: string, values: SetupAllocation): string[] {
  if (values.effectProfile !== "execution-root-local-v1" || !Number.isSafeInteger(values.activeTimeMs) ||
    values.activeTimeMs < 1 || !Number.isSafeInteger(values.artifactBytes) || values.artifactBytes < 16_384 ||
    !Array.isArray(values.writableDirectories) || !values.writableDirectories.length)
    throw new Error("invalid bounded setup allocation");
  const grants = values.writableDirectories;
  for (const name of grants) {
    if (name !== "node_modules" || typeof name !== "string" || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(name) ||
      name.split("/").some((part) => part === "scripts" || part === ".git" || part === ".pitako") ||
      grants.some((other) => other !== name && (other.startsWith(`${name}/`) || name.startsWith(`${other}/`))) ||
      grants.filter((other) => other === name).length !== 1)
      throw new Error(`invalid or overlapping setup write directory: ${name}`);
    let cursor = root;
    for (const part of name.split("/")) {
      cursor = path.join(cursor, part);
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(cursor) !== cursor)
        throw new Error(`setup output needs an existing physical local directory: ${name}`);
    }
    const target = path.join(root, name);
    for (const row of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      const mount = row.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      if (mount && beneath(target, mount)) throw new Error(`setup output contains an unproved mount alias: ${name}`);
    }
  }
  return [...grants];
}

/** Conservative bounded closure. External/dangling links and writable hardlink aliases are unsupported. */
function manifest(root: string, excludes: readonly string[], outputs = false): PathRow[] {
  const rows: PathRow[] = [];
  let bytes = 0;
  const visit = (name: string) => {
    if (excludes.some((excluded) => name === excluded || name.startsWith(`${excluded}/`))) return;
    if (rows.length >= 20_000) throw new Error("setup manifest exceeds supported 20000-path closure");
    const target = path.join(root, name);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      const resolved = realpathSync(target);
      if (!outputs || !beneath(root, resolved)) throw new Error(`unsupported setup input/output link: ${name}`);
      rows.push({ path: name, kind: "link", mode: stat.mode, target: readlinkSync(target), identity: physical(target) });
    } else if (stat.isDirectory()) {
      if (name === ".pitako" && readdirSync(target).every((entry) => excludes.includes(`${name}/${entry}`))) return;
      rows.push({ path: name, kind: "directory", mode: stat.mode, ...(outputs ? { identity: physical(target) } : {}) });
      for (const entry of readdirSync(target).sort()) visit(name ? `${name}/${entry}` : entry);
    } else if (stat.isFile()) {
      if (outputs && stat.nlink !== 1) throw new Error(`setup output has an unproved hardlink alias: ${name}`);
      bytes += stat.size;
      if (stat.size > 64 * 1024 * 1024 || bytes > 512 * 1024 * 1024)
        throw new Error("setup manifest exceeds supported native-byte closure");
      rows.push({ path: name, kind: "file", mode: stat.mode, hash: sha256(readFileSync(target)),
        ...(outputs ? { identity: physical(target) } : {}) });
    } else throw new Error(`unsupported setup inode: ${name}`);
  };
  for (const name of readdirSync(root).sort()) visit(name);
  return rows;
}
function runtime(target: string) {
  const file = realpathSync(target);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`unsupported host runtime: ${target}`);
  return { path: file, identity: physical(file), hash: sha256(readFileSync(file)),
    version: execFileSync(file, ["--version"], { encoding: "utf8", timeout: 5000, env: ENV }).trim() };
}
function libraries(runtimes: SetupIdentity["runtimes"]): SetupIdentity["libraries"] {
  const files = new Set<string>();
  for (const executable of runtimes) {
    const listing = execFileSync("/usr/bin/ldd", [executable.path], { encoding: "utf8", timeout: 5000, env: ENV });
    for (const row of listing.split("\n")) {
      const file = /(?:=>\s+)?(\/\S+)\s+\(/.exec(row)?.[1];
      if (file) files.add(file);
      else if (row.includes("not found")) throw new Error("setup runtime has unavailable shared library");
    }
  }
  return [...files].sort().map((file) => ({ path: file, identity: physical(file), hash: sha256(readFileSync(file)) }));
}

export function captureSetupIdentity(binding: ExecutionBinding, values: SetupAllocation): SetupIdentity {
  if (values.effectProfile === "execution-root-local-copy-v1") return captureCopyIdentity(binding, values);
  verifyExecutionBinding(binding);
  const root = binding.executionRoot;
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error("setup needs exact physical execution root");
  if (["/usr", "/bin", "/lib", "/lib64", "/dev", "/proc", "/tmp/setup-runtime", "/tmp/setup-home", "/tmp/setup-cache"]
    .some((protectedRoot) => beneath(protectedRoot, root) || beneath(root, protectedRoot)))
    throw new Error("execution root overlaps supported setup platform mounts");
  const grants = grantPaths(root, values);
  const source = manifest(root, [".git", ".pitako/runs", ".pitako/plans", ...grants]);
  // Absence is part of the recipe, including creation of a previously absent helper/lock/procedure.
  for (const name of ["scripts/setup.sh", "package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "GATES.md"])
    if (!source.some((row) => row.path === name)) source.push({ path: name, kind: "missing" });
  const script = source.find(({ path: name }) => name === "scripts/setup.sh")!;
  if (script.kind !== "missing" && script.kind !== "file") throw new Error("setup hook must be a physical regular file");
  const runtimes = [runtime("/bin/bash"), runtime(process.execPath), runtime("/usr/bin/bwrap"),
    runtime("/usr/bin/readlink"), runtime("/usr/bin/sleep"), runtime("/usr/bin/setsid")];
  return { format: "mission-setup-input-v1", binding: structuredClone(binding), repositoryFamily: repositoryIdentity(root),
    rootIdentity: physical(root), script: script.kind === "missing" ? null : script,
    outputDirectories: grants.map((name) => ({ path: name, identity: physical(path.join(root, name)) })),
    source: source.sort((a, b) => a.path.localeCompare(b.path)),
    runtimes, libraries: libraries(runtimes),
    platform: { os: process.platform, arch: process.arch, abi: process.versions.modules ?? "" },
    environment: ENV, producerHash: hash([sha256(readFileSync(PRODUCER_FILE)), sha256(readFileSync(CONTAINMENT_FILE))]) };
}
export function captureSetupOutputs(setup: Pick<PreparedSetup, "identity" | "decision">): PathRow[] {
  if (setup.identity.copy) return captureCopyOutputs(setup.identity);
  return setup.decision.values.writableDirectories.flatMap((name) => {
    const target = path.join(setup.identity.binding.executionRoot, name);
    return [{ path: name, kind: "directory" as const, identity: physical(target), mode: lstatSync(target).mode },
      ...manifest(target, [], true).map((row) => ({ ...row, path: `${name}/${row.path}` }))];
  });
}
export function assertSetupInputs(setup: Pick<PreparedSetup, "identity" | "decision">): void {
  if (setup.identity.copy) { assertCopyInputs(setup); return; }
  if (hash(captureSetupIdentity(setup.identity.binding, setup.decision.values)) !== hash(setup.identity))
    throw new Error("approved setup source/runtime/procedure identity changed");
  captureSetupOutputs(setup);
}

export type SetupReadiness =
  | { state: "ready"; receiptHash: string; reused: boolean; reuseHash?: string }
  | { state: "blocked"; reason: string }
  | { state: "missing-script"; reason: string };

/** One-purpose host producer. It exposes no command, cwd, script, or accepting-verdict injection. */
export class MissionSetup {
  private fenced = false;
  private child?: ChildProcess;
  private namespace?: string;
  private init?: { pid: number; birthTicks: number };
  private launcher?: ProcessIdentity;
  private job?: Promise<SetupReadiness>;
  private disposed = true;
  private readonly store: MissionStore;
  private readonly missionId: string;
  private witnessed?: { generation: string; readiness: SetupReadiness };
  constructor(store: MissionStore, missionId: string) { this.store = store; this.missionId = missionId; }
  get quiescent(): boolean {
    return this.quiescentFor(this.store.inspectMission(this.missionId));
  }
  quiescentFor(inspection: MissionInspection): boolean {
    if (this.job || !this.disposed) return false;
    const events = inspection.events;
    return events.filter(({ kind }) => kind === "mission.setup.intent").every((intent) => {
      try {
        const input = JSON.parse(this.store.readArtifact(String(intent.payload.inputHash)).toString());
        if (!input.setup || input.revision !== intent.revision || input.admissionId !== intent.payload.admissionId ||
          hash(input.owner) !== hash(intent.payload.owner)) return false;
        return events.some((event) => {
          if (!["mission.setup.receipt", "mission.setup.reconciled"].includes(event.kind) ||
            event.payload.intentId !== intent.eventId || event.payload.disposed !== true) return false;
          const bytes = this.store.readArtifact(String(event.payload.receiptHash ?? event.payload.observationHash));
          const proof = JSON.parse(bytes.toString());
          return proof.intentId === intent.eventId && proof.missionId === this.missionId && proof.disposed === true &&
            (event.kind === "mission.setup.receipt" ? proof.format === (input.setup.identity.copy ? "mission-setup-receipt-v2" : "mission-setup-receipt-v1") &&
              proof.revision === intent.revision && proof.status === event.payload.status &&
              proof.admissionId === input.admissionId &&
              proof.preparedHash === input.preparedHash && proof.definitionHash === input.definitionHash &&
              hash(proof.owner) === hash(input.owner) : proof.format === "mission-setup-recovery-v1" &&
              proof.status === "stopped" && proof.producingRevision === intent.revision);
        });
      } catch { return false; }
    });
  }
  fence(): void {
    this.fenced = true;
    if (!this.namespace && this.launcher && ownerProcessState(this.launcher) === "live") {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const pid = Number(entry), parentPid = processParentPid(pid);
          if (parentPid !== this.launcher.pid) continue;
          const namespace = processNamespaceId(pid);
          const init = readOwnedNamespaceInit(namespace, { pid, parentPid, birthTicks: processBirthTicks(pid) }, this.launcher);
          this.namespace = namespace; this.init = init; break;
        } catch { /* raced exit or not the owned PID 1; disposal remains unproved */ }
      }
    }
    // Signal before awaiting the pump or any drain.
    if (this.init) {
      try {
        if (processBirthTicks(this.init.pid) === this.init.birthTicks && processNamespaceId(this.init.pid) === this.namespace)
          process.kill(this.init.pid, "SIGKILL");
      } catch { /* identity vanished; drain still proves namespace empty */ }
    }
    try { this.child?.kill("SIGKILL"); } catch { /* drain proves disposal */ }
  }
  async stop(): Promise<void> { this.fence(); await this.job; if (!this.quiescent) throw new Error("setup disposal unproved; owner release forbidden"); }
  /** Recovery observes registered physical processes; never synthesizes success or reruns the hook. */
  async reconcile(): Promise<SetupReadiness> {
    const inspection = this.store.inspectMission(this.missionId);
    for (const intent of inspection.events.filter(({ kind }) => kind === "mission.setup.intent")) {
      if (inspection.events.some((event) => ["mission.setup.receipt", "mission.setup.reconciled"].includes(event.kind) &&
        event.payload.intentId === intent.eventId && event.payload.disposed === true)) continue;
      const invoking = [...inspection.events].reverse().find((event) =>
        event.kind === "mission.setup.invoking" && event.payload.intentId === intent.eventId && event.payload.process);
      const process = invoking?.payload.process as { launcher?: ProcessIdentity; namespace?: string } | undefined;
      if (!process?.launcher || !process.namespace || ownerProcessState(process.launcher) !== "dead" ||
        processesInNamespace(process.namespace).length !== 0)
        return { state: "blocked", reason: "interrupted setup disposal remains unknown; no replay or owner release" };
      const bytes = Buffer.from(JSON.stringify({ format: "mission-setup-recovery-v1", intentId: intent.eventId,
        missionId: this.missionId,
        producingRevision: intent.revision, process, status: "stopped", disposed: true,
        observedBy: currentProcessIdentity(this.store.runtimeId, this.store.ownerEpoch!), reason: "registered launcher dead and owned namespace empty" }));
      this.append("mission.setup.reconciled", { intentId: intent.eventId, observationHash: sha256(bytes), disposed: true }, bytes);
    }
    const readiness = await this.refresh();
    if (readiness.state === "ready" && readiness.reuseHash &&
      !inspection.events.some((event) => event.kind === "mission.setup.reused" &&
        event.revision === inspection.revision && event.payload.reuseHash === readiness.reuseHash)) {
      const bytes = Buffer.from(JSON.stringify(this.reuseReference(inspection, readiness.receiptHash)));
      this.append("mission.setup.reused", { receiptHash: readiness.receiptHash, reuseHash: sha256(bytes) }, bytes);
    }
    return this.observe();
  }
  private reuseReference(inspection: MissionInspection, receiptHash: string) {
    const receipt = JSON.parse(this.store.readArtifact(receiptHash).toString());
    return { format: "mission-setup-reuse-v1", missionId: inspection.id, revision: inspection.revision,
      producingRevision: receipt.revision, producingPreparedHash: receipt.preparedHash,
      producingDefinitionHash: receipt.definitionHash,
      preparedHash: inspection.snapshot.preparedHash, definitionHash: inspection.snapshot.definitionHash,
      inputIdentity: missionInputIdentity(inspection, inspection.prepared!.binding.executionRoot),
      obligationsHash: hash(inspection.definition.units), receiptHash };
  }
  /** Read-only observer entry; never use on the native/UI thread. */
  observePhysical(inspection = this.store.inspectMission(this.missionId)): SetupReadiness {
    let readiness: SetupReadiness;
    try { readiness = this.compatibleSuccess(inspection); }
    catch (error) {
      if (!inspection.prepared?.setup?.identity.copy) throw error;
      return { state: "blocked", reason: String(error) };
    }
    if (readiness.state === "ready" && readiness.reuseHash) {
      const reference = inspection.events.find((event) => event.kind === "mission.setup.reused" &&
        event.revision === inspection.revision && event.payload.reuseHash === readiness.reuseHash &&
        event.payload.receiptHash === readiness.receiptHash);
      if (!reference || sha256(this.store.readArtifact(readiness.reuseHash)) !== readiness.reuseHash)
        return { state: "blocked", reason: "compatible setup success needs a current durable reuse reference" };
    }
    return readiness;
  }
  private generation(inspection: MissionInspection): string {
    return hash([inspection.revision, inspection.snapshot.preparedHash, inspection.snapshot.definitionHash,
      inspection.events.filter(event => event.kind.startsWith("mission.setup.") ||
        ["mission.paused", "mission.cancelled", "mission.resumed", "mission.owner.claimed"].includes(event.kind)).map(event => event.eventId)]);
  }
  /** Projection-only. Physical freshness is established explicitly at an effect frontier. */
  observe(inspection = this.store.inspectMission(this.missionId)): SetupReadiness {
    if (!inspection.prepared?.setup) return { state: "missing-script", reason: "no separately admitted setup contract" };
    if (this.witnessed?.generation === this.generation(inspection)) return this.witnessed.readiness;
    return { state: "blocked", reason: "setup physical observation is required at the current frontier" };
  }
  async refresh(observer?: PhysicalObservation, signal?: AbortSignal): Promise<SetupReadiness> {
    const inspection = this.store.inspectMission(this.missionId);
    if (!inspection.prepared?.setup) return { state: "missing-script", reason: "no separately admitted setup contract" };
    const physical = observer ?? new PhysicalObservation();
    const generation = this.generation(inspection);
    const ownerEpoch = this.store.ownerEpoch;
    try {
      if (!this.store.dbPath) throw new Error("setup observation requires a persisted read-only store");
      const readiness = await physical.request<SetupReadiness>("setupReadiness", {
        dbPath: this.store.dbPath, objectDir: this.store.objectDir, missionId: this.missionId,
      }, signal);
      const current = this.store.inspectMission(this.missionId);
      if (signal?.aborted || this.fenced || ownerEpoch !== this.store.ownerEpoch || generation !== this.generation(current))
        throw new Error("setup physical observation became stale");
      missionInputIdentity(current, current.prepared!.binding.executionRoot);
      this.witnessed = { generation, readiness };
      return readiness;
    } finally { if (!observer) await physical.dispose(); }
  }
  async observeDependencyBacking(): Promise<ReturnType<MissionSetup["dependencyBacking"]>> {
    if (this.store.inspectMission(this.missionId).prepared?.setup?.identity.copy) await this.refresh();
    return this.dependencyBacking();
  }
  dependencyBacking(): { root: string; identity: string; recheck: () => void } | undefined {
    const setup = this.store.inspectMission(this.missionId).prepared?.setup;
    if (!setup?.identity.copy) return undefined;
    if (this.observe().state !== "ready") throw new Error("copied dependency consumer requires current settled proof");
    const root = path.join(setup.identity.copy.destination, "published/node_modules");
    const stat = lstatSync(root);
    return { root, identity: `${stat.dev}:${stat.ino}`, recheck: () => {
      if (this.observe().state !== "ready") throw new Error("copied setup proof is no longer current");
    } };
  }
  private compatibleSuccess(inspection = this.store.inspectMission(this.missionId)): SetupReadiness {
    const setup = inspection.prepared?.setup;
    if (!setup) return { state: "missing-script", reason: "no separately admitted setup contract" };
    try { assertSetupRequirements(setup, inspection.definition); }
    catch (error) { return { state: "blocked", reason: String(error) }; }
    try { assertSetupInputs(setup); } catch (error) { return { state: "blocked", reason: String(error) }; }
    if (!setup.identity.script) return { state: "missing-script", reason: "optional hook physically absent; prerequisite discovery still required" };
    const intent = [...inspection.events].reverse().find((event) => event.kind === "mission.setup.intent");
    if (!intent) return { state: "blocked", reason: "setup has no successful receipt; explicit execution admission required" };
    const event = inspection.events.find((event) => event.kind === "mission.setup.receipt" && event.payload.intentId === intent.eventId);
    if (!event) return { state: "blocked", reason: "unfinished setup intent requires reconciliation; automatic replay forbidden" };
    const receipt = JSON.parse(this.store.readArtifact(String(event.payload.receiptHash)).toString("utf8"));
    const input = JSON.parse(this.store.readArtifact(String(intent.payload.inputHash)).toString());
    const released = inspection.events.find((row) => row.kind === "mission.setup.invoking" &&
      row.payload.intentId === intent.eventId && row.payload.released === true);
    if (!this.quiescentFor(inspection) || receipt.format !== (setup.identity.copy ? "mission-setup-receipt-v2" : "mission-setup-receipt-v1") || receipt.missionId !== this.missionId ||
      receipt.intentId !== intent.eventId || receipt.revision !== intent.revision || receipt.preparedHash !== input.preparedHash ||
      receipt.definitionHash !== input.definitionHash || hash(input.setup) !== hash(setup) ||
      input.revision > inspection.revision ||
      (input.revision === inspection.revision && (input.preparedHash !== inspection.snapshot.preparedHash ||
        input.definitionHash !== inspection.snapshot.definitionHash)) ||
      hash(JSON.parse(this.store.readArtifact(input.definitionHash).toString()).authority) !== hash(inspection.definition.authority) ||
      !released || hash(released.payload.process) !== hash(receipt.process) || receipt.released !== true ||
      receipt.exitCode !== 0 || receipt.truncated !== false || receipt.timedOut !== false ||
      receipt.cwd !== (setup.identity.copy ? "/capsule" : setup.identity.binding.executionRoot) || hash(receipt.argv) !== hash(["/bin/bash", "./scripts/setup.sh"]) ||
      receipt.status !== "completed" || receipt.disposed !== true || receipt.inputHash !== hash(setup.identity) ||
      receipt.decisionHash !== hash(setup.decision) || hash(receipt.after) !== hash(captureSetupOutputs(setup)))
      return { state: "blocked", reason: "setup success/input/output compatibility is absent" };
    if (setup.identity.copy && (!receipt.after.length || hash(receipt.copy) !== hash(setup.identity.copy) ||
      receipt.capsuleIdentityHash !== sha256(readFileSync(path.join(setup.identity.copy.destination, "identity.json")))))
      return { state: "blocked", reason: "copied setup capsule/output binding changed" };
    missionInputIdentity(inspection, setup.identity.binding.executionRoot);
    const receiptHash = String(event.payload.receiptHash);
    return { state: "ready", receiptHash, reused: true,
      ...(input.revision < inspection.revision ? { reuseHash: hash(this.reuseReference(inspection, receiptHash)) } : {}) };
  }
  async ensure(admission: SetupStartAdmission, consumersQuiescent: () => boolean): Promise<SetupReadiness> {
    if (this.job) throw new Error("setup mutation already active");
    if (starts.has(admission) && this.quiescent) this.fenced = false;
    const ready = await this.refresh();
    if (ready.state !== "blocked") return Promise.resolve(ready);
    const inspection = this.store.inspectMission(this.missionId);
    if (inspection.events.some((event) => event.kind === "mission.setup.intent")) return Promise.resolve(ready);
    if (starts.has(admission) && this.quiescent) this.fenced = false;
    const job = this.run(admission, consumersQuiescent);
    this.job = job;
    return job.finally(() => { this.job = undefined; }).then(async (result) => {
      if (inspection.prepared?.setup?.identity.copy && result.state === "ready") {
        const observed = await this.refresh();
        return observed.state === "ready" ? { ...observed, reused: false } : observed;
      }
      return result;
    });
  }
  private check(admission: SetupStartAdmission, quiescent: () => boolean): MissionInspection {
    const authority = starts.get(admission);
    if (!authority || authority.store !== this.store || authority.missionId !== this.missionId || this.fenced ||
      this.store.ownerEpoch !== authority.ownerEpoch || !quiescent()) throw new Error("setup live admission or root quiescence expired");
    if (hash(this.store.ownershipIdentity) !== hash(authority.writerIdentity))
      throw new Error("setup writer claim changed");
    authority.recheck();
    const inspection = this.store.inspectMission(this.missionId);
    if (inspection.revision !== authority.revision || inspection.snapshot.preparedHash !== authority.preparedHash ||
      inspection.snapshot.definitionHash !== authority.definitionHash ||
      !(authority.scope === "prepare" ? inspection.state === "prepared" : ["running", "blocked"].includes(inspection.state)))
      throw new Error("setup admitted revision/state changed");
    if (inspection.events.some(({ kind }) => kind === "budget.admission.fenced"))
      throw new Error("setup admission fenced by existing resource budget");
    const setup = inspection.prepared?.setup;
    if (!setup) throw new Error("setup effect decision absent");
    missionInputIdentity(inspection, setup.identity.binding.executionRoot);
    return inspection;
  }
  private append(kind: "mission.setup.intent" | "mission.setup.invoking" | "mission.setup.receipt" | "mission.setup.reconciled" | "mission.setup.reused", payload: Record<string, unknown>, artifact?: Buffer) {
    const inspection = this.store.inspectMission(this.missionId);
    return this.store.appendTransition(this.missionId, inspection.version, {
      ...(artifact ? { artifacts: [{ bytes: artifact, mediaType: "application/json" }] } : {}),
      events: [{ revision: inspection.revision, kind, causalId: randomUUID(), payload }] })[0]!;
  }
  private async run(admission: SetupStartAdmission, quiescent: () => boolean): Promise<SetupReadiness> {
    const observer = new PhysicalObservation();
    try { return await this.runObserved(admission, quiescent, observer); }
    catch (error) { return { state: "blocked", reason: error instanceof Error ? error.message : String(error) }; }
    finally { await observer.dispose(); }
  }
  private async runObserved(admission: SetupStartAdmission, quiescent: () => boolean, observer: PhysicalObservation): Promise<SetupReadiness> {
    const started = performance.now();
    const inspection = this.check(admission, quiescent);
    const setup = inspection.prepared!.setup!;
    const values = setup.decision.values;
    // Reuse hydration only inside this write frontier. The current version and
    // live authority are still checked after every awaited filesystem write.
    let writeInspection = inspection;
    const recheckWrite = () => {
      const authority = starts.get(admission);
      if (!authority || this.fenced || this.store.ownerEpoch !== authority.ownerEpoch || !quiescent() ||
        hash(this.store.ownershipIdentity) !== hash(authority.writerIdentity))
        throw new Error("setup live write admission expired");
      authority.recheck();
      if (this.store.readMissionControl(this.missionId).version !== writeInspection.version)
        writeInspection = this.check(admission, quiescent);
      const binding = setup.identity.binding;
      if (physical(binding.executionRoot) !== setup.identity.rootIdentity ||
        readFileSync(binding.planSource, "utf8") !== writeInspection.prepared!.originalSource)
        throw new Error("setup physical source pin changed during copy");
      if (performance.now() - started >= values.activeTimeMs) throw new Error("setup allocation expired during copy");
    };
    const before = await observer.request<PathRow[]>("setupOutputs", setup);
    this.check(admission, quiescent);
    const owner = currentProcessIdentity(this.store.runtimeId, this.store.ownerEpoch!);
    const reservations: Array<{ id: string; resource: "active-time-ms" | "artifact-bytes"; amount: number }> = [
      { id: randomUUID(), resource: "active-time-ms", amount: values.activeTimeMs },
      { id: randomUUID(), resource: "artifact-bytes", amount: values.artifactBytes },
    ];
    const input = Buffer.from(JSON.stringify({ setup, before, admissionId: admission.id, revision: inspection.revision,
      preparedHash: inspection.snapshot.preparedHash, definitionHash: inspection.snapshot.definitionHash, owner }));
    if (input.length > values.artifactBytes / 2) throw new Error("setup identity exceeds approved evidence allocation");
    const intent = this.store.appendTransition(this.missionId, this.check(admission, quiescent).version, {
      artifacts: [{ bytes: input, mediaType: "application/json" }],
      events: [...reservations.map((reservation) => resourceLimit(inspection.definition, reservation.resource) === undefined ?
        { revision: inspection.revision, kind: "resource.metered.admitted", causalId: randomUUID(),
          payload: { ticket: { kind: "metered", ticketId: reservation.id, operationId: admission.id,
            resource: reservation.resource, revision: inspection.revision, ownerEpoch: this.store.ownerEpoch } } } :
        ({ revision: inspection.revision,
        kind: "reservation.created" as const, causalId: randomUUID(),
        payload: { reservationId: reservation.id, revision: inspection.revision, resource: reservation.resource,
          amount: reservation.amount, purpose: "ordinary" } })),
        { revision: inspection.revision, kind: "mission.setup.intent", causalId: randomUUID(),
          payload: { inputHash: sha256(input), owner, admissionId: admission.id, reservationIds: reservations.map(({ id }) => id) } }],
    }).at(-1)!;
    const limit = Math.min(1024 * 1024, Math.floor((values.artifactBytes - input.length) / 16));
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let released = false, timedOut = false;
    let status = "unknown", reason = "", exitCode: number | null = null;
    let processIdentity: Record<string, unknown> | undefined;
    try {
      await observer.request("setupInputs", setup);
      this.check(admission, quiescent);
      if (setup.identity.copy) {
        await initializeCopy(setup, recheckWrite);
        await observer.request("setupInputs", setup);
        this.check(admission, quiescent);
      }
      this.child = setup.identity.copy ? launchCopy(setup) : launch(setup);
      this.disposed = false;
      const child = this.child;
      child.stdin!.on("error", () => this.fence());
      const exited = new Promise<number | null>((resolve) => { child.once("error", () => resolve(null)); child.once("close", resolve); });
      const launcher: ProcessIdentity = { ...owner, pid: child.pid!, birthTicks: processBirthTicks(child.pid!) };
      this.launcher = launcher;
      // Persist host launcher BEFORE waiting for the namespace handshake. Recovery never infers "not run" from missing receipt.
      this.append("mission.setup.invoking", { intentId: intent.eventId, launcher });
      let handshake = "";
      let resolveReady!: (value: { pidNamespace: string; networkNamespace: string }) => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<{ pidNamespace: string; networkNamespace: string }>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      child.stdout!.on("data", (chunk: Buffer) => {
        if (!released) {
          handshake += chunk.toString("utf8");
          if (handshake.length > 4096) rejectReady(new Error("setup handshake exceeded limit"));
          const end = handshake.indexOf("\n");
          if (end >= 0) { try { resolveReady(JSON.parse(handshake.slice(0, end))); } catch { rejectReady(new Error("invalid setup handshake")); } }
        }
        if (stdout.length + chunk.length > limit) truncated = true;
        stdout = Buffer.concat([stdout, chunk.subarray(0, Math.max(0, limit - stdout.length))]);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        if (stderr.length + chunk.length > limit) truncated = true;
        stderr = Buffer.concat([stderr, chunk.subarray(0, Math.max(0, limit - stderr.length))]);
      });
      timer = setTimeout(() => { timedOut = true; rejectReady(new Error("setup allocation expired")); this.fence(); },
        Math.max(1, values.activeTimeMs - (performance.now() - started)));
      const row = await Promise.race([ready, exited.then(() => { throw new Error("setup launcher exited before GO"); })]);
      await observer.request("setupInputs", setup);
      this.check(admission, quiescent);
      if (typeof row.pidNamespace !== "string" || typeof row.networkNamespace !== "string" ||
        row.pidNamespace === processNamespaceId(process.pid) || row.networkNamespace === readlinkSync("/proc/self/ns/net"))
        throw new Error("setup did not enter private namespaces");
      const root = processesInNamespace(row.pidNamespace).find((candidate) => candidate.parentPid === launcher.pid);
      if (!root) throw new Error("setup namespace ownership unproved");
      this.namespace = row.pidNamespace;
      this.init = readOwnedNamespaceInit(row.pidNamespace, root, launcher);
      processIdentity = { launcher, namespace: this.namespace, init: this.init, networkNamespace: row.networkNamespace };
      this.append("mission.setup.invoking", { intentId: intent.eventId, process: processIdentity, released: true });
      this.check(admission, quiescent);
      if (performance.now() - started >= values.activeTimeMs) throw new Error("setup allocation exhausted before GO");
      readOwnedNamespaceInit(row.pidNamespace, root, launcher);
      released = true;
      child.stdin!.end("GO\n");
      exitCode = await exited;
      await this.drain();
      this.check(admission, quiescent);
      status = exitCode === 0 && !truncated && !timedOut ? "completed" : "failed";
      reason = truncated ? "setup output truncated; evidence incomplete" : timedOut ? "setup allocation expired" : exitCode === 0 ? "" : "setup script failed";
    } catch (error) {
      reason = String(error);
      this.fence();
      try { await this.drain(); } catch (disposalError) { reason += `; ${String(disposalError)}`; }
      status = this.disposed ? "stopped" : "unknown";
    } finally { if (timer) clearTimeout(timer); await observer.dispose(); }
    let after: PathRow[] = [], outputError: string | undefined;
    let copiedBytes = 0;
    try {
      const resultObserver = new PhysicalObservation();
      try {
        if (setup.identity.copy && status === "completed") {
          const rows = await resultObserver.request<PathRow[]>("copyPublication", setup);
          this.check(admission, quiescent);
          await publishCopy(setup, rows, recheckWrite);
        }
        after = await resultObserver.request<PathRow[]>("setupOutputs", setup);
        if (setup.identity.copy) {
          copiedBytes = await resultObserver.request<number>("copyStorage", setup.identity);
          if (copiedBytes > values.artifactBytes) throw new Error("copied setup storage exceeds admitted artifact allocation");
        }
      }
      finally { await resultObserver.dispose(); }
    } catch (error) {
      outputError = String(error); status = this.disposed ? "failed" : "unknown"; reason += `; ${outputError}`;
    }
    if (setup.identity.copy && !copiedBytes) {
      const storageObserver = new PhysicalObservation();
      try { copiedBytes = await storageObserver.request<number>("copyStorage", setup.identity); }
      finally { await storageObserver.dispose(); }
    }
    if (status === "completed") {
      try {
        const resultObserver = new PhysicalObservation();
        try { await resultObserver.request("setupInputs", setup); }
        finally { await resultObserver.dispose(); }
        this.check(admission, quiescent);
      }
      catch (error) { status = this.disposed ? "stopped" : "unknown"; reason = String(error); }
    }
    const duration = Math.ceil(performance.now() - started);
    if (duration >= values.activeTimeMs && status === "completed") {
      status = "failed"; timedOut = true; reason = "setup allocation exhausted before success commit";
    }
    const detail = { format: setup.identity.copy ? "mission-setup-receipt-v2" : "mission-setup-receipt-v1", intentId: intent.eventId,
      missionId: this.missionId, revision: inspection.revision, preparedHash: inspection.snapshot.preparedHash,
      definitionHash: inspection.snapshot.definitionHash, inputHash: hash(setup.identity), decisionHash: hash(setup.decision),
      admissionId: admission.id, owner, process: processIdentity, status, reason, exitCode, released, timedOut, truncated,
      duration, disposed: this.disposed, before, after, outputError,
      ...(setup.identity.copy ? { copy: setup.identity.copy, copiedBytes,
        capsuleIdentityHash: existsSync(path.join(setup.identity.copy.destination, "identity.json")) ?
          sha256(readFileSync(path.join(setup.identity.copy.destination, "identity.json"))) : null,
        measuredOutput: { paths: after.length, largestFileBytes: after.reduce((n, row) => Math.max(n, row.size ?? 0), 0),
          totalBytes: after.reduce((n, row) => n + (row.size ?? 0), 0) } } : {}),
      argv: ["/bin/bash", "./scripts/setup.sh"], cwd: setup.identity.copy ? "/capsule" : setup.identity.binding.executionRoot,
      stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"),
      stdoutBase64: stdout.toString("base64"), stderrBase64: stderr.toString("base64") };
    let receipt = Buffer.from(JSON.stringify(detail));
    if (copiedBytes + input.length + receipt.length > values.artifactBytes) {
      status = this.disposed ? "failed" : "unknown";
      Object.assign(detail, { status, reason: "setup evidence exceeds allocation; manifests/logs omitted, no reusable success",
        outputError: "evidence allocation exhausted", truncated: true, before: [], after: [],
        stdout: "", stderr: "", stdoutBase64: "", stderrBase64: "" });
      receipt = Buffer.from(JSON.stringify(detail));
      reason = detail.reason;
    }
    if (ownerProcessState(owner) !== "live" || this.store.ownerEpoch !== owner.epoch)
      throw new Error("setup owner lost; recovery must record outcome");
    const current = this.store.inspectMission(this.missionId);
    this.store.appendTransition(this.missionId, current.version, {
      artifacts: [{ bytes: receipt, mediaType: "application/json" }],
      events: [{ revision: inspection.revision, kind: "mission.setup.receipt", causalId: randomUUID(),
        payload: { intentId: intent.eventId, receiptHash: sha256(receipt), status, disposed: this.disposed } },
        ...reservations.map((reservation) => resourceLimit(inspection.definition, reservation.resource) === undefined ?
          { revision: inspection.revision, kind: "resource.metered.settled", causalId: randomUUID(),
            payload: { ticketId: reservation.id, resource: reservation.resource,
              knownCharge: reservation.resource === "active-time-ms" ? duration : copiedBytes + input.length + receipt.length,
              unknown: !this.disposed, outstanding: !this.disposed, source: "bounded setup" } } :
          ({ revision: inspection.revision, kind: "budget.reservation.settled" as const,
          causalId: randomUUID(), payload: { reservationId: reservation.id, resource: reservation.resource,
            knownCharge: reservation.resource === "active-time-ms" ? duration : copiedBytes + input.length + receipt.length,
            unknownCharge: this.disposed ? 0 : Math.max(0, reservation.amount -
              (reservation.resource === "active-time-ms" ? duration : copiedBytes + input.length + receipt.length)),
            released: !this.disposed ? 0 : reservation.resource === "active-time-ms" ? Math.max(0, reservation.amount - duration) :
              Math.max(0, reservation.amount - copiedBytes - input.length - receipt.length), remainingHold: 0 } }))] });
    return status === "completed" ? { state: "ready", receiptHash: sha256(receipt), reused: false } : { state: "blocked", reason };
  }
  private async drain(): Promise<void> {
    if (!this.child) return;
    if (this.namespace && processesInNamespace(this.namespace).length) this.fence();
    for (let turn = 0; turn < 250; turn++) {
      if ((this.child.exitCode !== null || this.child.signalCode !== null) &&
        this.namespace && processesInNamespace(this.namespace).length === 0) {
        this.disposed = true; this.child = undefined; return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("setup launcher/descendants disposal unproved; root fence retained");
  }
}

function launch(setup: PreparedSetup): ChildProcess {
  assertSetupInputs(setup);
  const root = setup.identity.binding.executionRoot;
  const descriptors: number[] = [];
  const pin = (target: string) => {
    const fd = openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(fd);
    const opened = fstatSync(fd), observed = lstatSync(target);
    const expected = target === root ? setup.identity.rootIdentity :
      setup.identity.outputDirectories.find((row) => path.join(root, row.path) === target)?.identity;
    if (`${opened.dev}:${opened.ino}:${opened.mode}` !== expected ||
      opened.dev !== observed.dev || opened.ino !== observed.ino || !opened.isDirectory()) throw new Error("setup mount identity changed");
    return String(3 + descriptors.length);
  };
  const seccomp = openSeccompFilter();
  try {
    const args = ["--tmpfs", "/", "--dir", "/bin", "--dir", "/usr", "--dir", "/usr/bin",
      "--dir", "/lib", "--dir", "/lib64", "--dir", "/dev", "--dir", "/proc", "--dev", "/dev", "--proc", "/proc",
      "--tmpfs", "/tmp", "--dir", "/tmp/setup-home", "--dir", "/tmp/setup-cache", "--dir", "/tmp/setup-runtime",
      "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent", "--disable-userns", "--assert-userns-disabled",
      "--seccomp", "3", "--ro-bind-fd", pin(root), root];
    for (const grant of grantPaths(root, setup.decision.values)) args.push("--bind-fd", pin(path.join(root, grant)), path.join(root, grant));
    // These trees are excluded from the recipe. Do not expose them as hidden installer inputs.
    for (const name of [".git", ".pitako/plans", ".pitako/runs"]) {
      const target = path.join(root, name);
      if (!existsSync(target)) continue;
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`unsupported protected setup tree alias: ${name}`);
      if (stat.isDirectory()) args.push("--tmpfs", target, "--remount-ro", target);
      else if (stat.isFile()) args.push("--ro-bind", "/dev/null", target);
      else throw new Error(`unsupported protected setup inode: ${name}`);
    }
    const current = setup.identity.runtimes[1]!;
    args.push("--ro-bind", setup.identity.runtimes[0]!.path, "/bin/bash");
    for (const executable of setup.identity.runtimes.slice(3))
      args.push("--ro-bind", executable.path, `/usr/bin/${path.basename(executable.path)}`);
    for (const library of setup.identity.libraries) args.push("--ro-bind", library.path, library.path);
    // ldd reports the loader's realpath; ELF PT_INTERP uses this conventional alias.
    const loader = setup.identity.libraries.find(({ path: file }) => path.basename(file).startsWith("ld-linux"));
    if (loader) args.push("--ro-bind", loader.path, process.arch === "x64" ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux-aarch64.so.1");
    args.push("--ro-bind", current.path, `/tmp/setup-runtime/${process.versions.bun ? "bun" : "node"}`,
      "--clearenv", ...Object.entries(ENV).flatMap(([key, value]) => ["--setenv", key, value]),
      "--chdir", root, "--", "/bin/bash", "-c", LAUNCH);
    return spawn("/usr/bin/bwrap", args, { stdio: ["pipe", "pipe", "pipe", seccomp, ...descriptors], env: ENV });
  } finally { closeSync(seccomp); for (const fd of descriptors) closeSync(fd); }
}
