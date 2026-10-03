import assert from "node:assert/strict";
import { openMissionStore } from "../extensions/mission/store.ts";
import { assertCompleteWorkspaceImage, readContributionInput, readSealedWorkspaceImage } from "../extensions/mission/reconcile.ts";
import { assessMissionPredicate } from "../extensions/mission/checks.ts";
import { missionCompletionCertificate } from "../extensions/mission/completion.ts";
const [dbPath, objectDir, missionId] = process.argv.slice(2);
const store = await openMissionStore({ dbPath, objectDir, readOnly: true });
try {
  const inspection = store.inspectMission(missionId);
  const integrated = inspection.events.find((event) => event.kind === "mission.result.integrated");
  const report = integrated && JSON.parse(store.readArtifact(integrated.payload.reportHash).toString());
  if (report) {
    const image = readSealedWorkspaceImage(store, report.resultImageHash);
    assertCompleteWorkspaceImage(image);
    const observation = await assessMissionPredicate({ predicate: { id: "exact", kind: "artifact_hash", target: "result", expected: report.resultImageHash },
      subject: { kind: "workspace", imageHash: report.resultImageHash } }, { store, scopeEstablished: true, inputBindingHash: report.acceptedInputHash });
    assert.equal(observation.verdict, "pass");
    for (const contribution of report.contributions) {
      const output = JSON.parse(store.readArtifact(contribution.outputHash).toString());
      assert.equal(output.sdkDisposed, true);
      const input = readContributionInput(store, inspection, output.binding);
      assert.deepEqual(input, contribution.contributionInput);
      assertCompleteWorkspaceImage(readSealedWorkspaceImage(store, input.baseImageHash));
      for (const hash of output.evidenceHashes) store.readArtifact(hash);
    }
  }
  assert.equal(missionCompletionCertificate(inspection, store), undefined);
  assert.equal(inspection.events.some((event) => event.kind === "mission.completed"), false);
  console.log(JSON.stringify({ format: "mission-output-node-observation-v1", runtime: process.version, missionId,
    acceptedUnits: inspection.events.filter((event) => event.kind === "unit.accepted").map((event) => event.unitId), reportHash: integrated?.payload.reportHash ?? null,
    resultImageHash: report?.resultImageHash ?? null, completionDisabled: true }));
} finally { store.close(); }
