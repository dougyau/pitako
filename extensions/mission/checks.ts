import { readFileSync } from "node:fs";
import { sha256, type AcceptancePredicate } from "./model.ts";
import type { MissionStore } from "./store.ts";
import type { MissionPredicateObservation } from "./engine.ts";
import { MissionEffects } from "./effects.ts";
import { captureWorkspaceImage, captureWorkspacePaths, hasContainmentProof } from "./workspace.ts";
import { assertCompleteWorkspaceImage, canonicalDeliveryManifest, missionEffectProcessesQuiescent, missionHasUnresolvedEffects, readSealedWorkspaceImage, sealWorkspaceImage } from "./reconcile.ts";

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
        Number(predicate.expected) > 255 || !Number.isSafeInteger(timeoutMs) || timeoutMs! < 1 || timeoutMs! > 30 * 60_000 ||
        !context.timeoutLimitMs || timeoutMs! > context.timeoutLimitMs || !effects || !hasContainmentProof(effects.workspace))
        throw new Error("command identity, finite admitted timeout or verification containment is missing");
      const observeSubject = () => {
        const observed = captureWorkspaceImage(effects.workspace.candidateRoot);
        assertCompleteWorkspaceImage(observed, captureWorkspacePaths(effects.workspace.candidateRoot, true));
        return { sealed: sealWorkspaceImage({ ...observed, manifest: canonicalDeliveryManifest(observed.manifest, image.manifest) }), manifest: observed.manifest };
      };
      const before = observeSubject();
      if (before.sealed.imageHash !== subject.imageHash) throw new Error("check workspace does not match the exact sealed subject");
      observation.executionInputIdentity = before.manifest;
      effects.enableVerificationOnly(true);
      const receipt = await effects.invoke("bash", { command: predicate.command, timeoutMs });
      await effects.shutdown();
      const stdout = Buffer.from(receipt.stdout ?? "");
      const stderr = Buffer.from(receipt.stderr ?? "");
      artifacts.push({ bytes: stdout, mediaType: "text/plain" }, { bytes: stderr, mediaType: "text/plain" });
      observation.command = predicate.command;
      observation.receipt = receipt;
      observation.stdoutHash = sha256(stdout);
      observation.stderrHash = sha256(stderr);
      const rows = context.store.inspectMission(effects.workspace.missionId).events.filter((row) => row.effectId === receipt.effectId);
      observation.effectWitnesses = rows.map((row) => ({ eventId: row.eventId, seq: row.seq, kind: row.kind, payloadHash: sha256(Buffer.from(JSON.stringify(row.payload))) }));
      const terminal = rows.find((row) => row.kind === "effect.receipt");
      const after = observeSubject();
      const sameImage = after.sealed.imageHash === subject.imageHash && after.manifest.hash === before.manifest.hash;
      if (!["completed", "failed"].includes(receipt.status) || !terminal || terminal.payload.termination !== "exit" ||
        !effects.quiescent || !sameImage || missionHasUnresolvedEffects(context.store, rows) ||
        !missionEffectProcessesQuiescent(rows, effects.workspace.attemptId)) throw new Error("command termination, image or effect settlement is inconclusive");
      observation.verdict = receipt.exitCode === Number(predicate.expected) ? "pass" : "inconclusive";
      observation.reason = observation.verdict === "pass" ? "contained exact command passed" : "verification command failed";
    }
  } catch (error) { observation.verdict = "inconclusive"; observation.reason = error instanceof Error ? error.message : String(error); }
  const bytes = Buffer.from(JSON.stringify(observation));
  return { verdict: observation.verdict as MissionPredicateObservation["verdict"], method: String(observation.reason),
    outputManifestHash, artifactHash: sha256(bytes), artifactBytes: bytes, artifactMediaType: "application/json", artifacts,
    authority: "production-checker" };
}
