import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openMissionStore } from "../extensions/mission/store.ts";
import { assessMissionCompletion, missionCompletionCertificate } from "../extensions/mission/completion.ts";

const evidence = process.argv[2];
mkdirSync(evidence, { recursive: true });
const observed = [];
for (const boundary of ["object.after-temp-sync", "object.after-rename", "completion.after-publication", "completion.before-commit", "completion.after-commit"]) {
  const directory = path.join(evidence, boundary);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import{createJiti}from"jiti";process.argv[2]=process.env.OUT;await createJiti(import.meta.url,{tryNative:false}).import("./scripts/mission-finalization-sdk-node.mjs");'],
  { encoding: "utf8", timeout: 90000, env: { ...process.env, OUT: directory, MISSION_COMPLETION_CUT: boundary, MISSION_T6_TEAM: "0" } });
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "producer.log"), child.stdout + child.stderr);
  assert.equal(child.status, 86, child.stderr);
  const location = JSON.parse(readFileSync(path.join(directory, "crash-location.json")));
  const store = await openMissionStore({ dbPath: location.dbPath, objectDir: location.objectDir, readOnly: true });
  try {
    const inspection = store.inspectMission(location.missionId);
    const publication = inspection.events.filter((row) => row.kind === "mission.finalization.published");
    const completion = inspection.events.filter((row) => row.kind === "mission.completed");
    const committed = boundary === "completion.after-commit";
    assert.equal(publication.length, Number(committed)); assert.equal(completion.length, Number(committed));
    const certificate = missionCompletionCertificate(inspection, store);
    assert.equal(!!certificate, committed, JSON.stringify(assessMissionCompletion(inspection, store)));
    if (committed) assert.equal(publication[0].seq + 1, completion[0].seq);
    observed.push({ boundary, producerExit: child.status, committed, publicationCount: publication.length,
      completionCount: completion.length, certificate: certificate ?? null });
    writeFileSync(path.join(directory, "journal.json"), JSON.stringify(inspection, null, 2));
    await store.exportMission(location.missionId, path.join(directory, "crash-export"));
  } finally { store.close(); rmSync(location.base, { recursive: true, force: true }); }
}
writeFileSync(path.join(evidence, "observed.json"), JSON.stringify({ runtime: process.version, cuts: observed }, null, 2));
console.log(JSON.stringify(observed));
