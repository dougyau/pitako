import { closeSync, readFileSync } from "node:fs";
import { sha256, type AcceptancePredicate } from "./model.ts";
import type { MissionStore } from "./store.ts";
import type { MissionPredicateObservation } from "./engine.ts";
import { MissionEffects } from "./effects.ts";
import { assertCommandTime } from "./command-time.ts";
import { captureWorkspaceImage, captureWorkspacePaths, hasContainmentProof } from "./workspace.ts";
import { assertCompleteWorkspaceImage, canonicalDeliveryManifest, missionEffectProcessesQuiescent, missionHasUnresolvedEffects, readSealedWorkspaceImage, sealWorkspaceImage } from "./reconcile.ts";
import { assertNestedCapsule, copyNestedCapsule, importNestedEvidence, NESTED_PROFILE, type NestedCapsule } from "./nested-verification.ts";
import { missionWorkspaceDependencyBacking, openSeccompFilter, type MissionWorkspace } from "./workspace.ts";

// The implementation bytes, not a callback's name or worker claim, identify this checker.
export const MISSION_CHECK_IDENTITY = sha256(readFileSync(new URL("./checks.ts", import.meta.url)));
export const missionCheckRuntime = () => process.versions.bun ? `bun:${process.versions.bun}` : `node:${process.version}`;
export type BoundPredicateSubject = { kind: "artifact"; artifactHash: string } | { kind: "workspace"; imageHash: string };
export interface ContainedCheckContext {
  store: MissionStore;
  inputBindingHash: string;
  scopeEstablished: boolean;
  effects?: MissionEffects;
  timeoutLimitMs?: number;
  artifactLimitBytes?: number;
}

interface NestedGrant {
  capsule: NestedCapsule;
  workspace: MissionWorkspace;
  command: string;
  timeoutMs: number;
  binding: Record<string, unknown>;
  current: () => void;
  effectId?: string;
}
// Only this checker issues admissions. Serialized arguments, flags and cloned objects cannot enter this map.
const nestedAdmissions = new WeakMap<object, NestedGrant>();
export function readNestedVerificationAdmission(token: unknown, workspace: MissionWorkspace, command?: string, effectId?: string): NestedGrant {
  const grant = typeof token === "object" && token !== null ? nestedAdmissions.get(token) : undefined;
  if (!grant || grant.workspace !== workspace || command !== undefined && command !== grant.command ||
    effectId && grant.effectId && effectId !== grant.effectId) throw new Error("checker-only nested verification admission is absent or mismatched");
  grant.current();
  assertNestedCapsule(grant.capsule);
  if (effectId) grant.effectId = effectId;
  return grant;
}

/** Closed host assessment. Unsupported addresses and containment never fall back to prose or a host shell. */
export async function assessMissionPredicate(
  input: { predicate: AcceptancePredicate; subject: BoundPredicateSubject }, context: ContainedCheckContext,
): Promise<MissionPredicateObservation> {
  const { predicate, subject } = input;
  const artifacts: Array<{ bytes: Uint8Array; mediaType: string }> = [];
  const observation: Record<string, unknown> = {
    format: "mission-predicate-observation-v1", predicate, predicateHash: sha256(Buffer.from(JSON.stringify(predicate))),
    subject, inputBindingHash: context.inputBindingHash, checkerIdentity: MISSION_CHECK_IDENTITY,
    runtimeIdentity: missionCheckRuntime(), verdict: "inconclusive", reason: "unsupported predicate or unestablished scope",
  };
  let outputManifestHash: string | undefined;
  let copiedClosureBytes = 0;
  try {
    if (!context.scopeEstablished || !/^[0-9a-f]{64}$/.test(context.inputBindingHash)) throw new Error("check input scope is unestablished");
    const image = subject.kind === "workspace" ? readSealedWorkspaceImage(context.store, subject.imageHash) : undefined;
    if (image) assertCompleteWorkspaceImage(image);
    const artifact = subject.kind === "artifact" ? context.store.readArtifact(subject.artifactHash) : undefined;
    if (artifact && sha256(artifact) !== (subject as { artifactHash: string }).artifactHash) throw new Error("bound artifact is corrupt");
    outputManifestHash = image?.manifest.hash ?? (subject as { artifactHash?: string }).artifactHash;
    if (predicate.kind === "artifact_hash") {
      if (!predicate.expected || !/^[0-9a-f]{64}$/.test(predicate.expected)) throw new Error("frozen expected SHA-256 is missing");
      let observedHash: string;
      if (predicate.target === "result") observedHash = subject.kind === "artifact" ? subject.artifactHash : subject.imageHash;
      else if (image && /^path:(?!\/)[^\0\\]+$/.test(predicate.target)) {
        const name = predicate.target.slice(5);
        if (name.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) throw new Error("unsupported workspace path address");
        const file = image.files.find((row) => row.path === name);
        if (!file?.bytes || !["file", "symlink"].includes(file.kind)) throw new Error("addressed path bytes are absent");
        observedHash = sha256(file.bytes);
      } else throw new Error("legacy or unsupported target address");
      observation.observedHash = observedHash;
      observation.verdict = observedHash === predicate.expected ? "pass" : "fail";
      observation.reason = "bound bytes compared with frozen expected SHA-256";
    } else if (predicate.kind === "command_exit") {
      const effects = context.effects;
      const timeoutMs = predicate.timeoutMs;
      if (!image || subject.kind !== "workspace" || predicate.target !== "result" || !predicate.command || !/^(0|[1-9][0-9]{0,2})$/.test(predicate.expected ?? "") ||
        Number(predicate.expected) > 255 || !effects || !hasContainmentProof(effects.workspace))
        throw new Error("command identity or verification containment is missing");
      assertCommandTime(timeoutMs);
      if (!context.timeoutLimitMs || timeoutMs > context.timeoutLimitMs)
        throw new Error(`command timeout ${timeoutMs} ms exceeds remaining admitted active-time capacity ${context.timeoutLimitMs ?? 0} ms`);
      const observeSubject = () => {
        const observed = captureWorkspaceImage(effects.workspace.candidateRoot);
        assertCompleteWorkspaceImage(observed, captureWorkspacePaths(effects.workspace.candidateRoot, true));
        return { sealed: sealWorkspaceImage({ ...observed, manifest: canonicalDeliveryManifest(observed.manifest, image.manifest) }), manifest: observed.manifest };
      };
      const before = observeSubject();
      if (before.sealed.imageHash !== subject.imageHash) throw new Error("check workspace does not match the exact sealed subject");
      observation.executionInputIdentity = before.manifest;
      effects.enableVerificationOnly(true);
      let nestedToken: object | undefined;
      if (predicate.profile === NESTED_PROFILE) {
        const current = context.store.inspectMission(effects.workspace.missionId);
        const prepared = current.prepared;
        const ownerEpoch = context.store.ownerEpoch;
        if (!prepared || !ownerEpoch || !current.definition.authority.verificationProfiles?.includes(NESTED_PROFILE) ||
          !current.definition.units.some((unit) => unit.acceptance.some((row) => JSON.stringify(row) === JSON.stringify(predicate))))
          throw new Error("explicit native nested verification authority is missing");
        const authority = JSON.parse(prepared.authorityDecision.text);
        if (authority.action !== "preparation-authority" ||
          JSON.stringify(authority.values) !== JSON.stringify({ authority: current.definition.authority, budget: current.definition.budget }))
          throw new Error("native nested verification authority does not match the frozen definition");
        const artifactBytes = context.artifactLimitBytes;
        if (!artifactBytes || artifactBytes > current.definition.budget.artifactBytes)
          throw new Error("current finite nested verification artifact grant is missing");
        const filter = openSeccompFilter(NESTED_PROFILE);
        let policyIdentity: string;
        try { policyIdentity = sha256(readFileSync(filter)); } finally { closeSync(filter); }
        const capsule = copyNestedCapsule(effects.workspace.candidateArenaRoot,
          [effects.workspace.runtimeNode, ...(effects.workspace.runtimeBun ? [effects.workspace.runtimeBun] : [])],
          missionWorkspaceDependencyBacking(effects.workspace), artifactBytes);
        copiedClosureBytes = capsule.closureBytes;
        nestedToken = Object.freeze({});
        const binding = { profile: NESTED_PROFILE, policyIdentity, missionId: current.id, revision: current.revision,
          predicateHash: observation.predicateHash, subject, inputBindingHash: context.inputBindingHash,
          authorityReceiptId: prepared.authorityDecision.receiptId, preparedHash: current.snapshot.preparedHash,
          runtimeClosureHash: capsule.closureHash, timeoutMs, artifactBytes,
          capsuleRoot: capsule.root, capsuleIdentity: capsule.identity,
          runtimeId: context.store.runtimeId, ownerEpoch, candidateIdentity: effects.workspace.candidateIdentity,
          candidateGitIdentity: effects.workspace.candidateGitIdentity, scratchIdentity: capsule.scratchIdentity,
          evidenceIdentity: capsule.evidenceIdentity };
        nestedAdmissions.set(nestedToken, { capsule, workspace: effects.workspace, command: predicate.command,
          timeoutMs, binding, current: () => {
            const fresh = context.store.inspectMission(effects.workspace.missionId);
            if (fresh.revision !== current.revision || fresh.snapshot.preparedHash !== current.snapshot.preparedHash ||
              context.store.ownerEpoch !== ownerEpoch || ["cancelled", "failed", "closed"].includes(fresh.state))
              throw new Error("nested verification grant is stale or fenced");
          } });
        effects.enableNestedVerification(nestedToken);
        observation.nestedVerification = binding;
      }
      const receipt = await effects.invoke("bash", { command: predicate.command, timeoutMs });
      await effects.shutdown();
      const stdout = Buffer.from(receipt.stdout ?? "");
      const stderr = Buffer.from(receipt.stderr ?? "");
      artifacts.push({ bytes: stdout, mediaType: "text/plain" }, { bytes: stderr, mediaType: "text/plain" });
      observation.command = predicate.command;
      if (nestedToken) {
        const { stdout: _stdout, stderr: _stderr, ...identity } = receipt;
        const summarize = (bytes: Buffer) => bytes.length <= 8192 ? bytes.toString() :
          `${bytes.subarray(0, 4096).toString()}\n[full bounded raw log stored separately]\n${bytes.subarray(-4096).toString()}`;
        observation.receipt = { ...identity, stdoutSummary: summarize(stdout), stderrSummary: summarize(stderr) };
      } else observation.receipt = receipt;
      observation.stdoutHash = sha256(stdout);
      observation.stderrHash = sha256(stderr);
      const rows = context.store.inspectMission(effects.workspace.missionId).events.filter((row) => row.effectId === receipt.effectId);
      observation.effectWitnesses = rows.map((row) => ({ eventId: row.eventId, seq: row.seq, kind: row.kind, payloadHash: sha256(Buffer.from(JSON.stringify(row.payload))) }));
      const terminal = rows.find((row) => row.kind === "effect.receipt");
      const after = observeSubject();
      const sameImage = after.sealed.imageHash === subject.imageHash && after.manifest.hash === before.manifest.hash;
      if (nestedToken) observation.executionOutputIdentity = { imageHash: after.sealed.imageHash, manifestHash: after.manifest.hash, unchanged: sameImage };
      if (!["completed", "failed"].includes(receipt.status) || !terminal || terminal.payload.termination !== "exit" ||
        (nestedToken && (terminal.payload.outputDrained !== true || terminal.payload.outputTruncated === true || terminal.payload.outputIncomplete === true)) ||
        !effects.quiescent || !sameImage || missionHasUnresolvedEffects(context.store, rows) ||
        !missionEffectProcessesQuiescent(rows, effects.workspace.attemptId)) throw new Error("command termination, image or effect settlement is inconclusive");
      if (nestedToken) {
        const grant = readNestedVerificationAdmission(nestedToken, effects.workspace, predicate.command, receipt.effectId);
        if (receipt.process?.outerInitRetired !== true) throw new Error("outer namespace init retirement is unproved");
        const exported = importNestedEvidence(grant.capsule, stdout.length + stderr.length);
        artifacts.push(...exported.artifacts);
        observation.exportManifest = exported.manifest;
        observation.exportManifestHash = exported.hash;
        observation.cleanupWitness = receipt.process;
      }
      observation.verdict = receipt.exitCode === Number(predicate.expected) ? "pass" : "inconclusive";
      observation.reason = observation.verdict === "pass" ? "contained exact command passed" : "verification command failed";
    }
  } catch (error) { observation.verdict = "inconclusive"; observation.reason = error instanceof Error ? error.message : String(error); }
  let bytes = Buffer.from(JSON.stringify(observation));
  if (predicate.profile === NESTED_PROFILE && context.artifactLimitBytes &&
    copiedClosureBytes + artifacts.reduce((n, artifact) => n + artifact.bytes.byteLength, 0) + bytes.byteLength > context.artifactLimitBytes) {
    observation.verdict = "inconclusive";
    observation.reason = "complete nested verification outputs exceed the admitted artifact budget";
    bytes = Buffer.from(JSON.stringify(observation));
  }
  return { verdict: observation.verdict as MissionPredicateObservation["verdict"], method: String(observation.reason),
    outputManifestHash, artifactHash: sha256(bytes), artifactBytes: bytes, artifactMediaType: "application/json", artifacts,
    authority: "production-checker" };
}
