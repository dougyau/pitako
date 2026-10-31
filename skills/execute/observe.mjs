import "./loader.mjs";

// Ignore stdin: the external adapter's prompt is not an observation command.
try {
  const { observeCheckout, observationOutput } = await import("./observe.ts");
  process.stdout.write(observationOutput(observeCheckout()));
} catch {
  process.stdout.write(JSON.stringify({ version: 1, ok: false, reason: "Owned checkout observer could not load or produce evidence.",
    nextStep: "Inspect the native stderr artifact and package installation before another observation." }) + "\n");
}
