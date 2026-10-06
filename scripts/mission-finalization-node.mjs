import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { openMissionStore } from "../extensions/mission/store.ts";
import { FINALIZATION_PHASES, currentWholeResultApproval, finalizationHash, finalizationInputIdentity, observeSourceMutation } from "../extensions/mission/finalization.ts";
import { assessMissionPredicate } from "../extensions/mission/checks.ts";
import { captureWorkspaceImage } from "../extensions/mission/workspace.ts";
import { missionCompletionCertificate } from "../extensions/mission/completion.ts";
import { missionInputIdentity } from "../extensions/mission/inputs.ts";
const [dbPath, objectDir, missionId, sourceRoot, mode] = process.argv.slice(2);
const store = await openMissionStore({ dbPath, objectDir, readOnly: true });
try {
  const inspection = store.inspectMission(missionId);
  const identity = missionInputIdentity(inspection, sourceRoot);
  if (inspection.snapshot.schemaVersion === 2) {
    assert.equal(identity.planFile, inspection.snapshot.sourceBinding.planSource);
    assert.equal(identity.preparedHash, inspection.snapshot.preparedHash);
    assert.equal(identity.pinHash, inspection.prepared.inventory.sourceHash);
    assert.notEqual(identity.planFile, `${sourceRoot}/.pitako/plans/${inspection.planId}.md`);
  }
  const current = currentWholeResultApproval(inspection, store, sourceRoot);
  const review = inspection.events.find((row) => row.kind === "mission.finalization.reviewed");
  assert.ok(review);
  const approval = JSON.parse(store.readArtifact(review.payload.approvalHash).toString());
  assert.equal(approval.verdict, "approve");
  const manifest = JSON.parse(store.readArtifact(approval.manifestHash).toString());
  const exactRuntime = finalizationHash(manifest.inputIdentity) === finalizationHash(finalizationInputIdentity(inspection, captureWorkspaceImage(sourceRoot).manifest, sourceRoot, store));
  assert.equal(!!current, exactRuntime, "a runtime change requires fresh current review, not silent reuse");
  const receipts = inspection.events.filter((row) => row.kind === "mission.finalization.phase.receipted")
    .map((row) => JSON.parse(store.readArtifact(row.payload.receiptHash).toString()));
  assert.deepEqual(receipts.map((row) => row.target.phase), FINALIZATION_PHASES);
  const observation = await assessMissionPredicate({ predicate: { id: "node-current", kind: "artifact_hash", target: "result", expected: manifest.resultImageHash },
    subject: { kind: "workspace", imageHash: manifest.resultImageHash } }, { store, scopeEstablished: true, inputBindingHash: approval.manifestHash });
  assert.equal(observation.verdict, "pass");
  assert.equal(missionCompletionCertificate(inspection, store), undefined);
  assert.equal(inspection.events.some((row) => row.kind === "mission.completed"), true);
  const publication = inspection.events.find((row) => row.kind === "mission.finalization.published");
  const savedCertificate = JSON.parse(store.readArtifact(publication.payload.certificateArtifactHash).toString());
  assert.equal(savedCertificate.manifestHash, approval.manifestHash);
  assert.equal(savedCertificate.approvalHash, review.payload.approvalHash);
  assert.equal(finalizationHash(savedCertificate), publication.payload.certificateArtifactHash);
  const mutations = [];
  if (inspection.snapshot.schemaVersion === 2 && mode === "mutations") {
    assert.equal(inspection.revision, 1, "this is an admitted revision-1 reopen observer, not revised recovery");
    const image = captureWorkspaceImage(sourceRoot).manifest;
    assert.equal([...image.tracked, ...image.untracked].some((row) => row.path.startsWith(".pitako/")), false);
    const binding = inspection.snapshot.sourceBinding;
    const witness = () => finalizationHash(observeSourceMutation(sourceRoot, captureWorkspaceImage(sourceRoot).manifest, inspection.planId, binding));
    // Independent fresh witnesses discriminate each fence; no fabricated approval or certificate.
    for (const relative of ["src/a", "untracked-source", ".pitako/nonignored-plan.md", binding.planSource]) {
      const file = path.resolve(sourceRoot, relative);
      const untracked = relative === "untracked-source" || relative === ".pitako/nonignored-plan.md";
      // A separate untracked local plan is explicitly outside the ignore policy.
      const ignoreFile = path.join(sourceRoot, ".gitignore");
      const ignoreBytes = readFileSync(ignoreFile);
      if (relative === ".pitako/nonignored-plan.md")
        writeFileSync(ignoreFile, ".pitako/*\n!.pitako/nonignored-plan.md\n");
      if (untracked) writeFileSync(file, "original\n");
      const bytes = readFileSync(file);
      const beforeImage = captureWorkspaceImage(sourceRoot).manifest;
      const beforeWitness = witness();
      try {
        if (untracked) assert.ok(beforeImage.untracked.some((row) => row.path === relative));
        writeFileSync(file, "mutated\n");
        if (file === binding.planSource) assert.throws(() => missionInputIdentity(inspection, sourceRoot));
        else {
          assert.notEqual(captureWorkspaceImage(sourceRoot).manifest.hash, beforeImage.hash);
          assert.notEqual(witness(), beforeWitness);
          assert.equal(missionInputIdentity(inspection, sourceRoot).planFile, binding.planSource);
        }
        assert.equal(currentWholeResultApproval(inspection, store, sourceRoot), undefined);
        assert.equal(missionCompletionCertificate(inspection, store), undefined);
        writeFileSync(file, bytes);
        assert.equal(captureWorkspaceImage(sourceRoot).manifest.hash, beforeImage.hash);
        assert.notEqual(witness(), beforeWitness, "edit-restore must not restore mutation freshness");
        assert.equal(missionInputIdentity(inspection, sourceRoot).planFile, binding.planSource);
        mutations.push({ path: relative, imageOrPinRejected: true, editRestoreRejected: true });
      } finally {
        writeFileSync(file, bytes);
        if (untracked) rmSync(file);
        if (relative === ".pitako/nonignored-plan.md") writeFileSync(ignoreFile, ignoreBytes);
      }
    }
  }
  console.log(JSON.stringify({ format: "mission-finalization-node-observation-v1", runtime: process.version, missionId,
    manifestHash: approval.manifestHash, sourceWitnessHash: manifest.sourceWitnessHash, resultImageHash: manifest.resultImageHash,
    phases: receipts.map((row) => row.target.phase), identity, observation, exactRuntime, currentApproval: !!current,
    savedCertificate, mutations, crossRuntimeCertificateRejected: true }));
} finally { store.close(); }
