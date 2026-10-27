import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Type, type Static, type TProperties } from "typebox";
import { Value } from "typebox/value";

const digestSchema = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-fA-F0-9]{64}$" });
const actualSchema = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" });
const pathSchema = Type.String({ minLength: 1, pattern: "^[^\\u0000]+$" });
const itemSchema = Type.Object({
  path: pathSchema, expected: Type.Optional(digestSchema),
}, { additionalProperties: false });
const itemsSchema = Type.Array(itemSchema, { minItems: 1 });
const reusableSchema = Type.Object({ items: itemsSchema }, { additionalProperties: false });
function inputSchema(save: boolean) {
  const output: TProperties = save ? { outputFile: pathSchema, overwrite: Type.Optional(Type.Boolean({ default: false })) } : {};
  return Type.Union([
    Type.Object({ items: itemsSchema, ...output }, { additionalProperties: false }),
    Type.Object({ itemsFile: pathSchema, ...output }, { additionalProperties: false }),
  ]);
}
export const hashInputSchema = inputSchema(false);
export const hashSaveInputSchema = inputSchema(true);
const categorySchema = Type.Union([
  Type.Literal("input_error"), Type.Literal("hash_error"), Type.Literal("preparation_error"),
  Type.Literal("publication_error"), Type.Literal("cancelled"), Type.Literal("cleanup_error"),
]);
const errorSchema = Type.Object({ category: categorySchema, message: Type.String() }, { additionalProperties: false });
export const hashResultSchema = Type.Object({
  ok: Type.Boolean(),
  status: Type.Union([Type.Literal("success"), categorySchema]),
  cancelled: Type.Boolean(),
  items: Type.Array(Type.Union([
    Type.Object({ path: Type.String(), status: Type.Literal("calculated"), actual: actualSchema }, { additionalProperties: false }),
    Type.Object({ path: Type.String(), status: Type.Union([Type.Literal("match"), Type.Literal("mismatch")]), actual: actualSchema, expected: digestSchema }, { additionalProperties: false }),
    Type.Object({ path: Type.String(), status: Type.Literal("read_error"), expected: Type.Optional(digestSchema), error: Type.String() }, { additionalProperties: false }),
  ])),
  publication: Type.Union([
    Type.Literal("not_requested"), Type.Literal("not_published"),
    Type.Literal("published"), Type.Literal("publication_unknown"),
  ]),
  outputFile: Type.Optional(Type.String()),
  error: Type.Optional(errorSchema),
  cleanupErrors: Type.Array(errorSchema),
  retainedTemporaryFile: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type HashResult = Static<typeof hashResultSchema>;

// Narrow filesystem seams allow settlement/acknowledgement failures to be controlled in tests.
const operations = { createReadStream, readFile, open, link, rename, unlink };
export type HashOperations = typeof operations;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function fileHashes(
  input: unknown, cwd: string, save: boolean, signal?: AbortSignal,
  io: HashOperations = operations,
): Promise<HashResult> {
  const result: HashResult = {
    ok: true, status: "success", cancelled: false, items: [],
    publication: save ? "not_published" : "not_requested", cleanupErrors: [],
  };
  function fail(category: Static<typeof categorySchema>, error: unknown) {
    result.ok = false;
    result.status = category;
    result.error = { category, message: message(error) };
  }
  function checkCancellation() { signal?.throwIfAborted(); }
  let items: Static<typeof itemsSchema>;
  let outputFile: string | undefined, overwrite = false;
  try {
    if (!Value.Check(save ? hashSaveInputSchema : hashInputSchema, input))
      throw new Error("Expected exactly one nonempty items array or itemsFile, valid paths and 64-hex expectations; unknown keys are forbidden. Saving requires outputFile and optional boolean overwrite.");
    const args = input as { items?: Static<typeof itemsSchema>; itemsFile?: string; outputFile?: string; overwrite?: boolean };
    checkCancellation();
    if (args.itemsFile !== undefined) {
      const bytes = await io.readFile(path.resolve(cwd, args.itemsFile), { signal });
      const json: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!Value.Check(reusableSchema, json))
        throw new Error('itemsFile must contain only {"items":[{"path":"...", "expected":"optional 64-hex"}]} with nonempty items and no unknown keys.');
      items = json.items;
    } else items = args.items!;
    if (save) {
      outputFile = path.resolve(cwd, args.outputFile!);
      overwrite = args.overwrite ?? false;
      result.outputFile = outputFile;
    }
  } catch (error) {
    fail(signal?.aborted ? "cancelled" : "input_error", error);
    result.cancelled = !!signal?.aborted;
    return result;
  }

  for (const item of items) {
    try {
      checkCancellation();
      const hash = createHash("sha256");
      // pipeline awaits destruction/close of the current stream, including on abort.
      await pipeline(io.createReadStream(path.resolve(cwd, item.path)), hash, { signal });
      const actual = hash.digest("hex");
      result.items.push(item.expected === undefined
        ? { path: item.path, status: "calculated", actual }
        : { path: item.path, status: actual === item.expected.toLowerCase() ? "match" : "mismatch", actual, expected: item.expected });
    } catch (error) {
      if (signal?.aborted) {
        fail("cancelled", error);
        break;
      }
      result.items.push({ ...item, status: "read_error", error: message(error) });
    }
  }
  if (result.ok && result.items.some(item => item.status === "mismatch" || item.status === "read_error"))
    fail("hash_error", "One or more files could not be read or did not match the expected SHA-256.");
  if (signal?.aborted && result.ok) fail("cancelled", signal.reason);
  if (!save || !result.ok) {
    result.cancelled = !!signal?.aborted;
    return result;
  }

  let temporary: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let closeFailed = false;
  try {
    checkCancellation();
    const candidate = path.join(path.dirname(outputFile!), `.file-sha256-${randomUUID()}.tmp`);
    handle = await io.open(candidate, "wx", 0o600);
    temporary = candidate; // Only an acknowledged exclusive creation establishes ownership.
    checkCancellation();
    const json = { items: result.items.map(item => {
      if (!("actual" in item)) throw new Error("Cannot publish an unreadable item.");
      return { path: item.path, expected: item.actual };
    }) };
    await handle.writeFile(`${JSON.stringify(json, null, 2)}\n`, "utf8");
  } catch (error) {
    fail(signal?.aborted ? "cancelled" : "preparation_error", error);
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch (error) {
        closeFailed = true;
        if (result.ok) fail("preparation_error", error);
        else result.cleanupErrors.push({ category: "cleanup_error", message: `Closing temporary file: ${message(error)}` });
      }
    }
  }
  if (result.ok) {
    try { checkCancellation(); }
    catch (error) { fail("cancelled", error); }
  }
  if (result.ok) {
    // There is no await between the last cancellation check and starting publication.
    try {
      if (overwrite) await io.rename(temporary!, outputFile!);
      else await io.link(temporary!, outputFile!);
      result.publication = "published";
      if (overwrite) temporary = undefined; // rename consumed the owned directory entry.
    } catch (error) {
      // A rejection alone does not prove non-commitment (notably with remote
      // filesystem retransmission). Never inspect, retry or delete the destination.
      result.publication = "publication_unknown";
      fail("publication_error", error);
    }
  }
  if (signal?.aborted && result.ok) fail("cancelled", signal.reason);
  if (temporary) {
    if (closeFailed) {
      // A rejected close does not establish release of the handle. Retain evidence.
      result.retainedTemporaryFile = temporary;
    } else {
      try { await io.unlink(temporary); }
      catch (error) {
        // A rejected rename acknowledgement may still have consumed this entry.
        // ENOENT establishes that no temporary path remains to clean up.
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          result.retainedTemporaryFile = temporary;
          if (result.ok) fail("cleanup_error", error);
          else result.cleanupErrors.push({ category: "cleanup_error", message: message(error) });
        }
      }
    }
  }
  result.cancelled = !!signal?.aborted;
  if (result.cancelled && result.ok) fail("cancelled", signal?.reason);
  return result;
}
