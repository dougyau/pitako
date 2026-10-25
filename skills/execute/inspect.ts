import { checkoutEvidence, designatedWorkspace, discoverSpec, inspectionSnapshot, specChunks, validatePlanId } from "../../extensions/spec-plans.ts";

// Planning validates only the root; execution uses the named resource's exact inspections. No writes.
const [root, id, source, part] = process.argv.slice(2);
if (!root || !id || source === undefined) throw new Error("Expected root, ID, and source selector.");
function emitBounded(value: unknown) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded + "\n") > 4096) throw new Error("Inspection envelope exceeds the native 4096-byte stdout boundary.");
  console.log(encoded);
}
if (part === "root") {
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
