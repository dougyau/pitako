import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { verifyExecutionBinding } from "../workflow.ts";
import { sha256 } from "./model.ts";
import type { MissionInspection } from "./store.ts";

/** Original physical pin and current admitted store revision are distinct identities. */
export function missionInputIdentity(inspection: MissionInspection, sourceRoot: string) {
  if (inspection.snapshot.schemaVersion === 2) {
    const binding = inspection.snapshot.sourceBinding;
    if (!binding || !inspection.prepared || realpathSync(sourceRoot) !== binding.executionRoot)
      throw new Error("generated mission execution root does not match physical source binding");
    const observed = verifyExecutionBinding(binding);
    if (observed.text !== inspection.prepared.originalSource ||
      sha256(inspection.planBytes) !== inspection.snapshot.planHash ||
      sha256(inspection.definitionBytes) !== inspection.snapshot.definitionHash)
      throw new Error("generated source pin or admitted revision objects changed");
    return { planFile: binding.planSource, pinHash: binding.hash, pinRevision: binding.revision,
      binding, planHash: inspection.snapshot.planHash, definitionHash: inspection.snapshot.definitionHash,
      preparedHash: inspection.snapshot.preparedHash };
  }
  const planFile = path.join(sourceRoot, ".pitako/plans", `${inspection.planId}.md`);
  const planHash = sha256(readFileSync(planFile));
  const definitionHash = sha256(readFileSync(path.join(sourceRoot, ".pitako/plans", `${inspection.planId}.mission.json`)));
  if (planHash !== inspection.snapshot.planHash || definitionHash !== inspection.snapshot.definitionHash)
    throw new Error("current plan or definition bytes differ from the frozen revision");
  return { planFile, pinHash: planHash, pinRevision: inspection.revision, planHash, definitionHash };
}
