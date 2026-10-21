/** Agent-facing port uses the common workflow reducer; no parallel mutable controller. */
export {
  recordObligation, recordDisposition, waitForProducer,
  type Obligation, type Disposition, type WaitResult,
} from "../workflow-engine.ts";
