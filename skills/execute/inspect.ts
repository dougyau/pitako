import { checkoutEvidence, designatedWorkspace, discoverSpec, inspectionSnapshot, specChunks, validatePlanId, validateSpec } from "../../extensions/spec-plans.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

// Planning validates only the root; execution uses the named resource's exact inspections. No writes.
const [root, id, source, part] = process.argv.slice(2);
if (!root || !id || source === undefined) throw new Error("Expected root, ID, and source selector.");
function emitBounded(value: unknown) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded + "\n") > 4096) throw new Error("Inspection envelope exceeds the native 4096-byte stdout boundary.");
  console.log(encoded);
}
if (part === "settings") {
  try {
    const { executeMaxCycles } = await import("../../extensions/execute-settings.ts");
    const agentDir = process.argv[7];
    if (!agentDir || !path.isAbsolute(agentDir)) throw new Error("Expected absolute host agent directory for settings admission.");
    const sourceRefs = JSON.parse(process.argv[6] ?? "[]") as { path: string; digest: string }[];
    for (const ref of sourceRefs) {
      const content = readFileSync(ref.path, "utf8");
      validateSpec(content, path.basename(ref.path, ".md"));
      if (createHash("sha256").update(content).digest("hex") !== ref.digest)
        throw new Error(`Complete spec source hash mismatch: ${ref.path}`);
    }
    emitBounded({ maxCycles: executeMaxCycles(root, agentDir) });
  } catch (error) {
    // Native failed-command summaries truncate at 200 characters. Transport the
    // complete admission diagnostic; this successful read is NOT admission.
    emitBounded({ error: String(error instanceof Error ? error.message : error) });
  }
} else if (part === "root") {
  validatePlanId(id);
  console.log(JSON.stringify(designatedWorkspace(root)));
} else {
  const found = discoverSpec(root, id, source || undefined);
  const candidates = found.selected ? [] : found.candidates.map(({ source, digest }) => ({ source, digest }));
  const metadata = { root: found.root, commonDir: found.commonDir, candidates,
    selected: found.selected ? { source: found.selected.source, digest: found.selected.digest, chunks: specChunks(found.selected.content).length } : null };
  if (part === undefined) console.log(JSON.stringify({ ...metadata, checkout: checkoutEvidence(found.root) }));
  else if (!found.selected) {
    if (part !== "metadata") throw new Error("Invalid snapshot chunk request.");
    // Only ambiguity needs locations. Foreground inspection above retains the complete list.
    const ambiguity = { root: found.root as string | undefined, selected: null, candidates: [] as typeof candidates,
      candidateCount: candidates.length, candidatesOmitted: candidates.length };
    if (Buffer.byteLength(JSON.stringify(ambiguity) + "\n") > 4096) ambiguity.root = undefined;
    for (const candidate of candidates) {
      const next = { ...ambiguity, candidates: [...ambiguity.candidates, candidate], candidatesOmitted: ambiguity.candidatesOmitted - 1 };
      if (Buffer.byteLength(JSON.stringify(next) + "\n") > 4096) break;
      ambiguity.candidates = next.candidates; ambiguity.candidatesOmitted = next.candidatesOmitted;
    }
    emitBounded(ambiguity);
  } else {
    const checkout = checkoutEvidence(found.root);
    const inline = { ...metadata, checkout };
    const content = specChunks(found.selected.content);
    if (Buffer.byteLength(JSON.stringify(inline) + "\n") <= 4096) {
      if (part === "metadata") emitBounded(inline);
      else {
        if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= content.length) throw new Error("Invalid snapshot chunk request.");
        emitBounded({ digest: found.selected.digest, content: content[Number(part)] });
      }
    } else {
      // Share the existing 26 snapshot grants: spec text stays unencoded, while metadata
      // uses only the remaining measured bytes of each complete JSON envelope.
      const { transport, packets } = inspectionSnapshot(metadata, found.selected.content);
      if (part === "metadata") emitBounded({ selected: { digest: found.selected.digest }, transport, checkout });
      else {
        if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= packets.length) throw new Error("Invalid snapshot chunk request.");
        emitBounded(packets[Number(part)]);
      }
    }
  }
}
