import assert from "node:assert/strict";
import { openMissionStore } from "../extensions/mission/store.ts";
import { FINALIZATION_PHASES, currentWholeResultApproval, finalizationHash, finalizationInputIdentity } from "../extensions/mission/finalization.ts";
import { assessMissionPredicate } from "../extensions/mission/checks.ts";
import { captureWorkspaceImage } from "../extensions/mission/workspace.ts";
import { missionCompletionCertificate } from "../extensions/mission/completion.ts";
const [dbPath, objectDir, missionId, sourceRoot] = process.argv.slice(2);
const store = await openMissionStore({ dbPath, objectDir, readOnly: true });
try {
  const inspection = store.inspectMission(missionId);
  const current = currentWholeResultApproval(inspection, store, sourceRoot);
  const review = inspection.events.find((row) => row.kind === "mission.finalization.reviewed");
  assert.ok(review);
  const approval = JSON.parse(store.readArtifact(review.payload.approvalHash).toString());
  assert.equal(approval.verdict, "approve");
  const manifest = JSON.parse(store.readArtifact(approval.manifestHash).toString());
  const exactRuntime = finalizationHash(manifest.inputIdentity) === finalizationHash(finalizationInputIdentity(inspection, captureWorkspaceImage(sourceRoot).manifest, sourceRoot));
  assert.equal(!!current, exactRuntime, "a runtime change requires fresh current review, not silent reuse");
  const receipts = inspection.events.filter((row) => row.kind === "mission.finalization.phase.receipted")
    .map((row) => JSON.parse(store.readArtifact(row.payload.receiptHash).toString()));
  assert.deepEqual(receipts.map((row) => row.target.phase), FINALIZATION_PHASES);
  const observation = await assessMissionPredicate({ predicate: { id: "node-current", kind: "artifact_hash", target: "result", expected: manifest.resultImageHash },
    subject: { kind: "workspace", imageHash: manifest.resultImageHash } }, { store, scopeEstablished: true, inputBindingHash: approval.manifestHash });
  assert.equal(observation.verdict, "pass");
  assert.equal(missionCompletionCertificate(inspection, store), undefined);
  assert.equal(inspection.events.some((row) => row.kind === "mission.completed"), true);
  console.log(JSON.stringify({ format: "mission-finalization-node-observation-v1", runtime: process.version, missionId,
    manifestHash: approval.manifestHash, sourceWitnessHash: manifest.sourceWitnessHash, resultImageHash: manifest.resultImageHash,
    phases: receipts.map((row) => row.target.phase), observation, exactRuntime, currentApproval: !!current, crossRuntimeCertificateRejected: true }));
} finally { store.close(); }
