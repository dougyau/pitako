import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkpointGit, checkpointRef, readCheckpoint, treeDelta, treePath, MANIFEST_LIMIT, MANIFEST_MARKER,
  type CheckpointManifest, type CheckpointNative, type CheckpointOrigin,
} from "../checkpoints.ts";
import { digest, localGitEnv, raw } from "./inventory.ts";
import type { ManagedAssignment } from "./managed-tools.ts";

export interface CheckpointRequest {
  expectedRevision: number;
  paths: string[];
  summary: string;
  remaining: string[];
  limits: string[];
  evidence: string[];
}
export type CheckpointResult =
  | { status: "committed"; origin: CheckpointOrigin; ref: string; manifest: CheckpointManifest }
  | { status: "refused"; checkpointId: string; selected: string[]; omitted: string[];
      rejected: Array<{ path: string; reasons: string[] }>; reasons: string[] }
  | { status: "uncertain"; origin: CheckpointOrigin; ref: string; diagnostic: string };
export interface CheckpointHost {
  assignmentId: string;
  managed: ManagedAssignment;
  signal: AbortSignal;
  acquire(expectedRevision: number): () => void;
  check(expectedRevision: number): void;
  capture(): CheckpointNative["source"];
  graph(): unknown;
  effects(): void;
  own<T>(operation: () => Promise<T>): Promise<T>;
  append(result: CheckpointResult): void;
}

/** A single assignment's create-only chain. The lease is acquired before scheduling any work. */
export class CheckpointWriter {
  private last?: CheckpointOrigin;
  private saved: CheckpointManifest["saved"];
  constructor(private host: CheckpointHost, private adopted?: CheckpointManifest) {
    this.last = adopted && { assignmentId: adopted.assignmentId, checkpointId: adopted.checkpointId,
      commit: this.git(["rev-parse", "--verify", adopted.ref]).toString().trim() };
    this.saved = structuredClone(adopted?.saved ?? []);
  }
  private git(args: string[], input?: string | Buffer, env = localGitEnv()) {
    return checkpointGit(this.host.managed.root, args, input, env);
  }
  create(request: CheckpointRequest, signal?: AbortSignal): Promise<CheckpointResult> {
    const release = this.host.acquire(request.expectedRevision);
    const checkpointId = randomUUID();
    const combined = AbortSignal.any([this.host.signal, ...(signal ? [signal] : [])]);
    const root = this.host.managed.root, inventory = this.host.managed.inventory;
    const ref = checkpointRef(root, this.host.assignmentId, checkpointId);
    let attemptedCommit: string | undefined, temporary: string | undefined;
    const run = async (): Promise<CheckpointResult> => {
      const check = () => {
        this.host.check(request.expectedRevision);
        if (combined.aborted) throw new Error("checkpoint cancelled");
        inventory.observe();
        const snapshot = inventory.snapshot();
        if (!snapshot.admission || snapshot.gaps.length) throw new Error(snapshot.unavailable ?? snapshot.gaps.join("; "));
        return snapshot;
      };
      try {
        const observed = inventory.observe(), snapshot = inventory.snapshot();
        const admission = snapshot.admission;
        const changed = [...new Set([...observed].filter(([name, file]) =>
          JSON.stringify(file) !== JSON.stringify(admission?.paths.find(entry => entry.path === name)?.raw)).map(([name]) => name)
          .concat(admission?.paths.filter(entry => entry.eligibility !== "clean").map(entry => entry.path) ?? []))];
        const omitted = changed.filter(name => !request.paths.includes(name)).sort();
        const rejected: Array<{ path: string; reasons: string[] }> = [];
        const selected = [...request.paths];
        for (const name of request.paths) {
          const reasons: string[] = [], eligibility = inventory.eligibility(name);
          const file = eligibility.eligible ? raw(root, name) : undefined;
          if (!eligibility.eligible) reasons.push(eligibility.reason ?? "ineligible admission preimage");
          if (request.paths.filter(path => path === name).length !== 1) reasons.push("duplicate path");
          if (file && file.kind !== "file") reasons.push("current raw type is unsupported");
          if (!snapshot.contributions.some(entry => entry.changes.some(change => change.path === name)) &&
              !this.saved.some(entry => entry.path === name)) reasons.push("no managed contribution for requested path");
          if (reasons.length) rejected.push({ path: name, reasons });
        }
        const reasons = [...snapshot.gaps, ...(snapshot.unavailable ? [snapshot.unavailable] : [])];
        if (!admission) reasons.push("admission inventory unavailable");
        if (!request.paths.length || request.paths.length > 256) reasons.push("select 1..256 literal paths");
        if (!request.summary || request.summary.length > 16384 || request.remaining.length > 32 ||
            request.limits.length > 32 || request.evidence.length > 32 ||
            [...request.remaining, ...request.limits, ...request.evidence].some(value => !value || value.length > 16384)) {
          reasons.push("checkpoint text/evidence exceeds bounds");
        }
        if (rejected.length || reasons.length) return { status: "refused", checkpointId, selected, omitted, rejected, reasons };
        check();
        const head = this.host.capture(), managed = this.host.managed.snapshot();
        const captured = new Map(request.paths.map(name => [name, { raw: raw(root, name),
          bytes: raw(root, name) ? readFileSync(path.join(root, name)) : undefined }]));
        const verifyCaptured = () => {
          check();
          for (const [name, file] of captured) if (JSON.stringify(file.raw) !== JSON.stringify(raw(root, name))) {
            throw new Error(`checkpoint selected raw source drift: ${name}`);
          }
        };
        const parent = this.last?.commit ?? admission!.admissionHead;
        const inherited = this.adopted;
        const native = [
          ...(inherited?.native.map(entry => ({ ...entry, inherited: true })) ?? []),
          ...managed.native.map(entry => ({ ...entry, assignmentId: this.host.assignmentId, inherited: false,
            testedSource: "not_recorded" as const })),
        ];
        const contributors = [
          ...(inherited?.contributors.map(entry => ({ ...entry, inherited: true })) ?? []),
          ...snapshot.contributions.map(contribution => ({ assignmentId: this.host.assignmentId, contribution, inherited: false })),
        ];
        // No async native writer can enter after this acquisition. Recheck after the scheduling boundary too.
        await Promise.resolve();
        verifyCaptured();
        this.host.effects(); // Before the first object write, including writes without a surviving ref.
        temporary = mkdtempSync(path.join(tmpdir(), "pitako-checkpoint-index-"));
        const env = { ...localGitEnv(), GIT_INDEX_FILE: path.join(temporary, "index"),
          GIT_AUTHOR_NAME: "Pitako checkpoint", GIT_AUTHOR_EMAIL: "checkpoint@local.invalid",
          GIT_COMMITTER_NAME: "Pitako checkpoint", GIT_COMMITTER_EMAIL: "checkpoint@local.invalid" };
        this.git(["read-tree", parent], undefined, env);
        for (const [name, file] of captured) {
          if (file.bytes === undefined) this.git(["update-index", "--force-remove", "--", name], undefined, env);
          else {
            const blob = this.git(["hash-object", "-w", `--path=${name}`, "--stdin"], file.bytes, env).toString().trim();
            this.git(["update-index", "--add", "--cacheinfo", `${file.raw!.mode!.toString(8)},${blob},${name}`], undefined, env);
          }
        }
        const tree = this.git(["write-tree"], undefined, env).toString().trim();
        const saved = new Map(this.saved.map(entry => [entry.path, entry]));
        for (const [name, file] of captured) saved.set(name, { path: name, raw: file.raw, git: treePath(root, tree, name) });
        const cumulative = treeDelta(root, admission!.admissionHead, tree);
        for (const name of saved.keys()) if (!cumulative.includes(name)) saved.delete(name);
        if (cumulative.some(name => !saved.has(name)) || treeDelta(root, parent, tree).some(name => !selected.includes(name))) {
          throw new Error("checkpoint incremental/cumulative tree mismatch");
        }
        const manifest: CheckpointManifest = { version: 1, assignmentId: this.host.assignmentId, checkpointId, ref,
          ...(this.adopted ? { origin: { assignmentId: this.adopted.assignmentId, checkpointId: this.adopted.checkpointId,
            commit: this.git(["rev-parse", "--verify", this.adopted.ref]).toString().trim() } } : {}),
          admission: admission!, parent, tree, head, selected, omitted, rejected: [], saved: [...saved.values()],
          contributors, native, evidence: request.evidence, summary: request.summary, remaining: request.remaining,
          limits: [...request.limits, "Local private refs are not access control, acceptance or publication.",
            "Cooperative finite foreground shell; no escaped-descendant confinement or power-loss durability.",
            "Native result success is not test success; tested source identity: not_recorded."],
          graph: this.host.graph(), gaps: [...snapshot.gaps, ...native.flatMap(entry => entry.gaps),
            ...(managed.nativeOmitted ? ["Earlier native sessions omitted"] : [])] };
        const message = MANIFEST_MARKER + JSON.stringify(manifest) + "\n";
        if (Buffer.byteLength(message) > MANIFEST_LIMIT) throw new Error("checkpoint bounded manifest unavailable: exceeds limit");
        verifyCaptured();
        attemptedCommit = this.git(["commit-tree", tree, "-p", parent], message, env).toString().trim();
        verifyCaptured();
        // Empty old value means create-only for either supported object-ID format.
        this.git(["update-ref", ref, attemptedCommit, ""], undefined, env);
        const origin = { assignmentId: this.host.assignmentId, checkpointId, commit: attemptedCommit };
        // Remember a surviving publication before any fallible readback or native append.
        this.last = origin; this.saved = [...saved.values()];
        const actual = readCheckpoint(root, origin);
        if (digest(JSON.stringify(actual.manifest)) !== digest(JSON.stringify(manifest))) throw new Error("checkpoint actual manifest mismatch");
        const result: CheckpointResult = { status: "committed", origin, ref, manifest };
        this.host.append(result);
        return result;
      } catch (error) {
        // Git operations are synchronous fixed-argv children and have returned/settled here.
        // Observing the generated exact ref grants no new effects, even after cancellation.
        let surviving: string | undefined;
        try { surviving = this.git(["rev-parse", "--verify", ref]).toString().trim(); } catch { /* no ref: not a checkpoint */ }
        if (surviving) {
          const origin = { assignmentId: this.host.assignmentId, checkpointId, commit: surviving };
          this.last = origin;
          return { status: "uncertain", origin, ref, diagnostic: String(error) };
        }
        return { status: "refused", checkpointId, selected: request.paths, omitted: [], rejected: [], reasons: [String(error)] };
      } finally {
        if (temporary) rmSync(temporary, { recursive: true, force: true });
      }
    };
    const pending = this.host.own(run);
    void pending.then(release, release);
    return pending;
  }
}
