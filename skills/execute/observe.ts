import { checkoutEvidence, designatedWorkspace } from "../../extensions/spec-plans.ts";

// Leave headroom below the native external CLI's 65,536-byte stdout capture.
const MAX_OBSERVATION_BYTES = 60 * 1024;
export function observationOutput(value: unknown): string {
  const output = JSON.stringify(value) + "\n";
  return Buffer.byteLength(output, "utf8") <= MAX_OBSERVATION_BYTES ? output :
    JSON.stringify({ version: 1, ok: false, reason: "Checkout observation exceeds the stdout boundary.",
      nextStep: "Inspect the designated checkout directly; retain this failure, not truncated evidence." }) + "\n";
}
export function observeCheckout() {
  try {
    // No arguments, prompt, plan, or stdin can select the workspace.
    const workspace = designatedWorkspace(process.cwd());
    return { version: 1, ok: true, root: workspace.physicalRoot, commonDir: workspace.identity,
      checkout: checkoutEvidence(workspace.physicalRoot) };
  } catch (error) {
    return { version: 1, ok: false,
      reason: String(error instanceof Error ? error.message : error).slice(0, 2048),
      nextStep: "Inspect the actual child cwd and Git registration; reconcile the designated checkout before another observation." };
  }
}
