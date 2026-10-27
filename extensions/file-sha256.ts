import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileHashes, hashInputSchema, hashResultSchema, hashSaveInputSchema } from "./file-hashes.ts";

export default function fileSha256(pi: ExtensionAPI): void {
  for (const save of [false, true]) {
    const name = save ? "file_sha256_save" : "file_sha256";
    pi.registerTool({
      name, label: name,
      description: `Sequential original-byte SHA-256 calculation/verification. Supply exactly one of nonempty items or itemsFile (strict JSON containing only items). All paths resolve from invocation cwd. Preserves order, duplicates and original paths; expected is 64 hex, case-insensitive. ${save
        ? "Publishes reusable actual-digest JSON only for an all-good batch. Required outputFile; overwrite defaults false (atomic no-clobber link); true uses atomic replacement rename."
        : "Read-only: no output or publication controls."} Inspect structured ok and publication even when codemode returns without throwing. Digests identify bytes read, not a source snapshot or test evidence.`,
      parameters: save ? hashSaveInputSchema : hashInputSchema,
      outputSchema: hashResultSchema,
      annotations: { readOnlyHint: !save, destructiveHint: save },
      async execute(_id, input, signal, _update, ctx) {
        const result = await fileHashes(input, ctx.cwd, save, signal);
        return {
          content: [{ type: "text", text: `${name}: ${result.ok ? "success" : result.status}; ${result.items.length} item diagnostics; publication=${result.publication}${result.error ? `; ${result.error.message}` : ""}` }],
          structuredContent: result, details: result, isError: !result.ok,
        };
      },
    });
  }
}
