import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, type PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createCodemodeToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js";
import fileSha256 from "../extensions/file-sha256.ts";
import { fileHashes, hashResultSchema, type HashOperations, type HashResult } from "../extensions/file-hashes.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), "pitako-file-sha256-")); roots.push(cwd);
  const put = (name: string, bytes: string | Buffer) => {
    mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    writeFileSync(path.join(cwd, name), bytes);
    return name;
  };
  put("source", "abc");
  const run = async (input: unknown, save = false, signal?: AbortSignal, io?: HashOperations) => {
    const result = await fileHashes(input, cwd, save, signal, io);
    expect(Value.Check(hashResultSchema, result)).toBe(true);
    expect(result.ok).toBe(result.status === "success");
    return result;
  };
  return { cwd, put, run, temps: () => readdirSync(cwd).filter(name => name.startsWith(".file-sha256-")) };
}
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const actual = sha("abc");
const io: HashOperations = { createReadStream, ...fs };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
function tools() {
  const registered: ToolDefinition[] = [];
  fileSha256({ registerTool(tool: ToolDefinition) { registered.push(tool); } } as ExtensionAPI);
  return registered;
}

test("original bytes: empty, binary/NUL, multibyte and newline-sensitive content, absolute paths, symlinks, order and duplicates", async () => {
  const f = fixture();
  const contents = [Buffer.alloc(0), Buffer.from([0, 255, 128, 13, 10, 0]), Buffer.from("é中\n"), Buffer.from("line\n"), Buffer.from("line\r\n"), Buffer.from("line")];
  const known = contents.map((bytes, index) => ({ path: f.put(`bytes-${index}`, bytes), expected: sha(bytes) }));
  expect(known[0]!.expected).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(actual).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  symlinkSync("source", path.join(f.cwd, "symlink"));
  const items = [...known, { path: "symlink", expected: actual.toUpperCase() }, { path: path.join(f.cwd, "source") }, { path: "source" }, { path: "source" }];
  const result = await f.run({ items });
  expect(result).toMatchObject({ ok: true, publication: "not_requested", cancelled: false });
  expect(result.items.map(item => item.path)).toEqual(items.map(item => item.path));
  expect(result.items.slice(0, known.length).map(item => item.status)).toEqual(known.map(() => "match"));
  expect(result.items[known.length]).toEqual({ path: "symlink", expected: actual.toUpperCase(), actual, status: "match" });
  expect(result.items.slice(-3)).toEqual(items.slice(-3).map(item => ({ path: item.path, actual, status: "calculated" })));
  expect(new Set(known.slice(-3).map(item => item.expected)).size).toBe(3);
});

test("mixed diagnostics continue through mismatches and filesystem failures and prevent any output preparation", async () => {
  const f = fixture();
  const result = await f.run({ items: [{ path: "source", expected: "0".repeat(64) }, { path: "missing" }, { path: "source" }, { path: "." }], outputFile: "output" }, true, undefined, {
    ...io, open: (async () => { throw new Error("must not prepare"); }) as typeof fs.open,
  });
  expect(result).toMatchObject({ ok: false, status: "hash_error", publication: "not_published" });
  expect(result.items.map(item => item.status)).toEqual(["mismatch", "read_error", "calculated", "read_error"]);
  expect(result.items[0]).toMatchObject({ expected: "0".repeat(64), actual });
  expect(result.items[1]).toMatchObject({ error: expect.stringContaining("ENOENT") });
  expect(existsSync(path.join(f.cwd, "output"))).toBe(false);
  expect(f.temps()).toEqual([]);
});

test("strict inline and itemsFile validation completes before hashing or creating output", async () => {
  const f = fixture();
  const forbidden: HashOperations = {
    ...io,
    createReadStream: (() => { throw new Error("hashed invalid input"); }) as typeof createReadStream,
    open: (async () => { throw new Error("prepared invalid input"); }) as typeof fs.open,
  };
  const invalid = [
    {}, { items: [] }, { items: [{ path: "source" }], itemsFile: "json" }, { itemsFile: "" },
    { items: [{ path: "source" }], extra: true }, { items: [{ path: "source", extra: true }] },
    { items: [{ path: "source" }, { path: "source", expected: "a".repeat(63) }] },
    { items: [{ path: "source", expected: "z".repeat(64) }] }, { items: [{ path: "source", expected: null }] },
    { items: [{ path: "source", expected: `${actual}\n` }] },
    { items: [{ path: "" }] }, { items: [{ path: "source\0" }] },
    { items: "source" }, { items: [null] }, { items: [{ path: 12 }] },
  ];
  for (const input of invalid) {
    for (const save of [false, true]) {
      const result = await f.run(save ? { ...input, outputFile: "out" } : input, save, undefined, forbidden);
      expect(result).toMatchObject({ ok: false, status: "input_error", items: [] });
    }
  }
  for (const input of [
    { items: [{ path: "source" }], outputFile: "out" },
    { items: [{ path: "source" }], overwrite: false },
  ]) expect((await f.run(input, false, undefined, forbidden)).status).toBe("input_error");
  for (const input of [
    { items: [{ path: "source" }] }, { items: [{ path: "source" }], outputFile: "out", overwrite: "true" },
  ]) expect((await f.run(input, true, undefined, forbidden)).status).toBe("input_error");

  const jsonValues = [
    "not JSON", "[]", "null", '{"items":[]}', '{"items":[{"path":"source","extra":1}]}',
    ...["itemsFile", "outputFile", "overwrite", "extra"].map(key => JSON.stringify({ items: [{ path: "source" }], [key]: "embedded-control" })),
    '{"items":[{"path":"source"},{"path":"source","expected":"bad"}]}',
  ];
  for (const json of jsonValues) {
    f.put("input.json", json);
    expect(await f.run({ itemsFile: "input.json", outputFile: "out" }, true, undefined, forbidden))
      .toMatchObject({ ok: false, status: "input_error", items: [], publication: "not_published" });
  }
  expect((await f.run({ itemsFile: "unreadable.json" })).status).toBe("input_error");
  f.put("invalid-utf8.json", Buffer.concat([Buffer.from('{"items":[{"path":"'), Buffer.from([255]), Buffer.from('"}]}')]));
  expect((await f.run({ itemsFile: "invalid-utf8.json" }, false, undefined, forbidden)).status).toBe("input_error");
  expect(existsSync(path.join(f.cwd, "out"))).toBe(false);
  expect(f.temps()).toEqual([]);
});

test("inline/file equivalence, cwd resolution for every path, original spelling and reusable only-items JSON roundtrip", async () => {
  const f = fixture(), items = [{ path: "./source" }, { path: "source", expected: actual.toUpperCase() }, { path: "./source" }];
  f.put("elsewhere/input.json", JSON.stringify({ items }));
  f.put("elsewhere/source", "not the invocation source");
  f.put("saved/keep", "");
  expect(await f.run({ itemsFile: "elsewhere/input.json" })).toEqual(await f.run({ items }));
  let reads = 0;
  const result = await f.run({ itemsFile: path.join(f.cwd, "elsewhere/input.json"), outputFile: "saved/reference.json" }, true, undefined, {
    ...io, createReadStream: ((...args) => { reads++; return createReadStream(...args); }) as typeof createReadStream,
  });
  expect(result).toMatchObject({ ok: true, publication: "published", outputFile: path.join(f.cwd, "saved/reference.json") });
  expect(reads).toBe(items.length); // Saving does not re-hash.
  const json = JSON.parse(readFileSync(path.join(f.cwd, "saved/reference.json"), "utf8"));
  expect(json).toEqual({ items: items.map(item => ({ path: item.path, expected: actual })) });
  const reused = await f.run({ itemsFile: "saved/reference.json" });
  expect(reused.ok).toBe(true);
  expect(reused.items.map(item => item.status)).toEqual(["match", "match", "match"]);
  expect(f.temps()).toEqual([]);
});

test("default publication protects existing destinations, including a concurrent creator", async () => {
  const f = fixture();
  for (const concurrent of [false, true]) {
    const name = concurrent ? "concurrent.json" : "existing.json", destination = path.join(f.cwd, name);
    if (!concurrent) f.put(name, "original");
    const result = await f.run({ items: [{ path: "source" }], outputFile: name }, true, undefined, {
      ...io, link: async (from, to) => {
        if (concurrent) await fs.writeFile(destination, "concurrent creator", { flag: "wx" });
        await fs.link(from, to);
      },
    });
    expect(result).toMatchObject({ ok: false, status: "publication_error", publication: "publication_unknown" });
    expect(result.items[0]).toMatchObject({ actual });
    expect(readFileSync(destination, "utf8")).toBe(concurrent ? "concurrent creator" : "original");
    expect(f.temps()).toEqual([]);
  }
});

test("atomic replacement exposes only the complete closed artifact, and no-clobber link is exclusive", async () => {
  const f = fixture(), destination = path.join(f.cwd, "out");
  for (const overwrite of [false, true]) {
    if (overwrite) f.put("out", "old");
    let closed = false, published = 0;
    const publish = async (from: PathLike, to: PathLike) => {
      expect(closed).toBe(true);
      expect(path.dirname(String(from))).toBe(f.cwd);
      expect(JSON.parse(readFileSync(from, "utf8"))).toEqual({ items: [{ path: "source", expected: actual }] });
      if (overwrite) {
        expect(readFileSync(destination, "utf8")).toBe("old");
        await fs.rename(from, to);
      } else {
        expect(existsSync(destination)).toBe(false);
        await fs.link(from, to);
      }
      published++;
      expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({ items: [{ path: "source", expected: actual }] });
    };
    const result = await f.run({ items: [{ path: "source" }], outputFile: destination, overwrite }, true, undefined, {
      ...io,
      open: (async (...args: Parameters<typeof fs.open>) => {
        expect(args[1]).toBe("wx");
        const handle = await fs.open(...args), close = handle.close.bind(handle);
        handle.close = async () => { await close(); closed = true; };
        return handle;
      }) as typeof fs.open,
      link: publish, rename: publish,
    });
    expect(result).toMatchObject({ ok: true, publication: "published" });
    expect(published).toBe(1);
    expect(f.temps()).toEqual([]);
    await fs.unlink(destination);
  }
});

test.each(["open", "write", "close"] as const)("preparation %s failure preserves the destination and completed diagnostics", async stage => {
  const f = fixture(); f.put("out", "previous");
  const result = await f.run({ items: [{ path: "source" }], outputFile: "out", overwrite: true }, true, undefined, {
    ...io,
    open: (async (...args: Parameters<typeof fs.open>) => {
      if (stage === "open") throw new Error("open refused");
      const handle = await fs.open(...args), close = handle.close.bind(handle);
      if (stage === "write") handle.writeFile = async () => { throw new Error("write refused"); };
      handle.close = async () => { await close(); if (stage === "close") throw new Error("close acknowledgement refused"); };
      return handle;
    }) as typeof fs.open,
    rename: async () => { throw new Error("must not publish"); },
  });
  expect(result).toMatchObject({ ok: false, status: "preparation_error", publication: "not_published", items: [{ path: "source", actual, status: "calculated" }] });
  expect(readFileSync(path.join(f.cwd, "out"), "utf8")).toBe("previous");
  if (stage === "close") {
    expect(result.retainedTemporaryFile).toBe(path.join(f.cwd, f.temps()[0]!));
    await fs.unlink(result.retainedTemporaryFile!); // Fixture closed the real handle before rejecting.
  }
  expect(f.temps()).toEqual([]);
});

test("cancellation settles current stream destruction before returning, is not read_error and retains completed diagnostics", async () => {
  const f = fixture(), controller = new AbortController(), destroyed = deferred(), release = deferred();
  let opened = 0, settled = false;
  const pending = f.run({ items: [{ path: "source" }, { path: "source" }, { path: "source" }] }, false, controller.signal, {
    ...io, createReadStream: ((...args) => {
      const stream = createReadStream(...args);
      if (++opened === 2) {
        const destroy = stream._destroy.bind(stream);
        stream._destroy = (error, callback) => {
          destroy(error, finalError => {
            destroyed.resolve();
            void release.promise.then(() => callback(finalError));
          });
        };
        stream.once("open", () => controller.abort(new Error("cancel current stream")));
      }
      return stream;
    }) as typeof createReadStream,
  }).then(result => { settled = true; return result; });
  try {
    await destroyed.promise;
    expect(settled).toBe(false);
    release.resolve();
    expect(await pending).toMatchObject({ ok: false, status: "cancelled", cancelled: true, publication: "not_requested", items: [{ path: "source", status: "calculated", actual }] });
    expect(opened).toBe(2);
  } finally { release.resolve(); await pending; }
});

test.each(["open", "write", "close"] as const)("cancellation during %s awaits owned work, closes and cleans before declining publication", async stage => {
  const f = fixture(), controller = new AbortController(), entered = deferred(), release = deferred();
  f.put("out", "old");
  let settled = false, closed = false;
  async function barrier(at: string) {
    if (stage === at) { entered.resolve(); await release.promise; }
  }
  const pending = f.run({ items: [{ path: "source" }], outputFile: "out", overwrite: true }, true, controller.signal, {
    ...io,
    open: (async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), close = handle.close.bind(handle), write = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs) => { await write(...writeArgs); await barrier("write"); };
      handle.close = async () => { await close(); await barrier("close"); closed = true; };
      await barrier("open");
      return handle;
    }) as typeof fs.open,
    rename: async () => { throw new Error("must not publish"); },
    unlink: async name => { expect(closed).toBe(true); await fs.unlink(name); },
  }).then(result => { settled = true; return result; });
  try {
    await entered.promise; controller.abort(new Error(`cancel at ${stage}`));
    expect(settled).toBe(false);
    expect(readFileSync(path.join(f.cwd, "out"), "utf8")).toBe("old");
    release.resolve();
    expect(await pending).toMatchObject({ ok: false, status: "cancelled", cancelled: true, publication: "not_published", items: [{ actual }] });
    expect(closed).toBe(true);
    expect(f.temps()).toEqual([]);
  } finally { release.resolve(); await pending; }
});

test("already-cancelled input starts no hashing/output effects", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(new Error("cancelled before start"));
  let effects = 0;
  expect(await f.run({ items: [{ path: "source" }], outputFile: "out" }, true, controller.signal, {
    ...io, createReadStream: (() => { effects++; throw new Error("must not hash"); }) as typeof createReadStream,
    open: (async () => { effects++; throw new Error("must not prepare"); }) as typeof fs.open,
  })).toMatchObject({ ok: false, status: "cancelled", items: [], publication: "not_published" });
  expect(effects).toBe(0);
});

test("cancellation during itemsFile read settles input work before returning without hash/output effects", async () => {
  const f = fixture(), controller = new AbortController(), entered = deferred(), release = deferred();
  f.put("input.json", JSON.stringify({ items: [{ path: "source" }] }));
  let settled = false, effects = 0;
  const pending = f.run({ itemsFile: "input.json", outputFile: "out" }, true, controller.signal, {
    ...io,
    readFile: (async (...args: Parameters<typeof fs.readFile>) => {
      const bytes = await fs.readFile(...args); entered.resolve(); await release.promise;
      return bytes;
    }) as typeof fs.readFile,
    createReadStream: (() => { effects++; throw new Error("must not hash"); }) as typeof createReadStream,
    open: (async () => { effects++; throw new Error("must not prepare"); }) as typeof fs.open,
  }).then(result => { settled = true; return result; });
  try {
    await entered.promise; controller.abort(new Error("input read cancelled"));
    expect(settled).toBe(false);
    release.resolve();
    expect(await pending).toMatchObject({ ok: false, status: "cancelled", cancelled: true, items: [], publication: "not_published" });
    expect(effects).toBe(0);
  } finally { release.resolve(); await pending; }
});

test("write error retains its primary diagnostic when close also rejects; unreleased temp is reported rather than deleted", async () => {
  const f = fixture();
  const result = await f.run({ items: [{ path: "source" }], outputFile: "out" }, true, undefined, {
    ...io,
    open: (async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), close = handle.close.bind(handle);
      handle.writeFile = async () => { throw new Error("primary write error"); };
      handle.close = async () => { await close(); throw new Error("additional close error"); };
      return handle;
    }) as typeof fs.open,
    unlink: async () => { throw new Error("must retain uncertain close"); },
  });
  expect(result).toMatchObject({
    ok: false, status: "preparation_error", publication: "not_published",
    error: { message: "primary write error" }, cleanupErrors: [{ category: "cleanup_error", message: "Closing temporary file: additional close error" }],
  });
  expect(result.retainedTemporaryFile).toBe(path.join(f.cwd, f.temps()[0]!));
  await fs.unlink(result.retainedTemporaryFile!); // The fixture settled the real close before rejecting.
});

test.each([false, true])("cancellation awaits in-flight publication (overwrite=%j) and retains acknowledged published truth", async overwrite => {
  const f = fixture(), controller = new AbortController(), entered = deferred(), release = deferred();
  let settled = false;
  const publish = async (from: PathLike, to: PathLike) => {
    entered.resolve(); await release.promise;
    if (overwrite) await fs.rename(from, to); else await fs.link(from, to);
  };
  const pending = f.run({ items: [{ path: "source" }], outputFile: "out", overwrite }, true, controller.signal, { ...io, link: publish, rename: publish })
    .then(result => { settled = true; return result; });
  try {
    await entered.promise; controller.abort(new Error("publication in flight"));
    expect(settled).toBe(false);
    expect(existsSync(path.join(f.cwd, "out"))).toBe(false);
    expect(f.temps()).toHaveLength(1);
    release.resolve();
    expect(await pending).toMatchObject({ ok: false, status: "cancelled", cancelled: true, publication: "published", items: [{ actual }] });
    expect(JSON.parse(readFileSync(path.join(f.cwd, "out"), "utf8"))).toEqual({ items: [{ path: "source", expected: actual }] });
    expect(f.temps()).toEqual([]);
  } finally { release.resolve(); await pending; }
});

test.each([false, true])("committed=%j ambiguous publication reports unknown without retrying/deleting destination", async committed => {
  for (const overwrite of [false, true]) {
    const f = fixture(), destination = path.join(f.cwd, "out");
    if (overwrite) f.put("out", "old");
    let attempts = 0;
    const publish = async (from: PathLike, to: PathLike) => {
      attempts++;
      if (committed) { if (overwrite) await fs.rename(from, to); else await fs.link(from, to); }
      throw new Error("ambiguous acknowledgement");
    };
    const result = await f.run({ items: [{ path: "source" }], outputFile: "out", overwrite }, true, undefined, {
      ...io, link: publish, rename: publish,
      unlink: async name => {
        expect(String(name)).not.toBe(destination);
        await fs.unlink(name);
      },
    });
    expect(result).toMatchObject({ ok: false, status: "publication_error", publication: "publication_unknown", error: { message: "ambiguous acknowledgement" }, items: [{ actual }] });
    expect(attempts).toBe(1);
    if (committed) expect(JSON.parse(readFileSync(destination, "utf8")).items[0].expected).toBe(actual);
    else if (overwrite) expect(readFileSync(destination, "utf8")).toBe("old");
    else expect(existsSync(destination)).toBe(false);
    // A rename may have consumed the temporary despite its rejected acknowledgement.
    expect(result.cleanupErrors).toEqual([]);
    expect(result.retainedTemporaryFile).toBeUndefined();
    expect(f.temps()).toEqual([]);
  }
});

test("postcommit cleanup failure reports published artifact and retained owned temp; primary errors survive additional cleanup failure", async () => {
  for (const primary of [false, true]) {
    const f = fixture();
    if (primary) f.put("out", "existing");
    const result = await f.run({ items: [{ path: "source" }], outputFile: "out" }, true, undefined, {
      ...io, unlink: async () => { throw new Error("cleanup refused"); },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(primary ? "publication_error" : "cleanup_error");
    expect(result.publication).toBe(primary ? "publication_unknown" : "published");
    expect(result.items[0]).toMatchObject({ actual });
    expect(result.retainedTemporaryFile).toBe(path.join(f.cwd, f.temps()[0]!));
    if (primary) {
      expect(result.error?.message).toContain("EEXIST");
      expect(result.cleanupErrors).toEqual([{ category: "cleanup_error", message: "cleanup refused" }]);
      expect(readFileSync(path.join(f.cwd, "out"), "utf8")).toBe("existing");
    } else expect(JSON.parse(readFileSync(path.join(f.cwd, "out"), "utf8")).items[0].expected).toBe(actual);
    await fs.unlink(result.retainedTemporaryFile!);
  }
});

test("registered SDK surfaces share the schema, mark every failure isError, and return structured failures without throwing", async () => {
  const f = fixture(), definitions = tools();
  expect(definitions.map(tool => tool.name)).toEqual(["file_sha256", "file_sha256_save"]);
  expect(definitions[0]!.annotations?.readOnlyHint).toBe(true);
  expect(definitions[1]!.annotations?.readOnlyHint).toBe(false);
  for (const tool of definitions) {
    expect(tool.outputSchema).toBe(hashResultSchema);
    for (const input of [{}, { items: [{ path: "missing" }] }, { items: [{ path: "source", expected: "0".repeat(64) }] }]) {
      const result = await tool.execute("sdk", tool.name.endsWith("_save") ? { ...input, outputFile: "out" } : input, undefined, undefined, { cwd: f.cwd } as ExtensionToolContext);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false });
      expect(Value.Check(hashResultSchema, result.structuredContent)).toBe(true);
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining((result.structuredContent as HashResult).status) });
    }
  }
});

test("native Pi codemode consumes original structured results, including returned failure, not display text", async () => {
  const f = fixture(), definitions = tools(), observed: HashResult[] = [];
  const codemode = createCodemodeToolDefinition();
  const context = {
    cwd: f.cwd,
    tools: definitions,
    sessionManager: { getBranch: () => [] },
    executeTool: async (name: string, args: unknown, options: { signal: AbortSignal }) => {
      const definition = definitions.find(tool => tool.name === name)!;
      const result = await definition.execute("nested", args, options.signal, undefined, { cwd: f.cwd } as ExtensionToolContext);
      observed.push(result.structuredContent as HashResult);
      // Original structuredContent remains intact; display text cannot be a data source.
      return { toolCall: { id: "nested", name, arguments: args }, result: { ...result, content: [{ type: "text", text: "NOT JSON / not a result" }] }, isError: result.isError };
    },
  } as unknown as ExtensionToolContext;
  const result = await codemode.execute("native-hashes", { code: `
    const calculated = await tools.file_sha256({items:[{path:"source"}]});
    if (!calculated.ok || calculated.items[0].actual !== "${actual}" || calculated.publication !== "not_requested") throw new Error("calculation contract");
    const saved = await tools.file_sha256_save({items:[{path:"source"}],outputFile:"native.json"});
    if (!saved.ok || saved.publication !== "published") throw new Error("publication contract");
    const failed = await tools.file_sha256_save({items:[{path:"source",expected:"${"0".repeat(64)}"}],outputFile:"must-not-exist"});
    if (failed.ok || failed.status !== "hash_error" || failed.publication !== "not_published") throw new Error("failure contract");
    return { calculated: calculated.items[0].actual, saved: saved.publication, failed: failed.ok, inspectedOk: true };
  ` }, undefined, undefined, context);
  expect(result.isError).not.toBe(true);
  expect(result.content.map(part => part.type === "text" ? part.text : "").join("\n")).toContain('"inspectedOk":true');
  expect(observed.map(value => value.ok)).toEqual([true, true, false]);
  expect(existsSync(path.join(f.cwd, "must-not-exist"))).toBe(false);
  expect(JSON.parse(readFileSync(path.join(f.cwd, "native.json"), "utf8")).items[0].expected).toBe(actual);
});
