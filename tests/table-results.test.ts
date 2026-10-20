import { expect, test } from "bun:test";
import { jsonBytes, sealPages, tableError, tableTool, type TableRead } from "../extensions/table/results.ts";

const payload = (envelope: ReturnType<typeof tableTool>) => JSON.parse(envelope.content[0]!.text);

test("canonical pages preserve giant Unicode and escaped fields within the original final envelopes", () => {
  const giant = "界😀\\\"\n\u0000".repeat(3000);
  const value = { protocol: "review", judgment: null, snapshot: { cwd: giant }, members: [{ model: giant }],
    failures: [giant], pending: [{ question: giant }], closure: { reason: giant }, delivery: { diagnostic: giant } };
  const sealed = sealPages(value);
  const canonical = JSON.stringify(value);
  value.failures.push("must not alter the immutable cut");
  const automatic = sealed.inline(tableTool);
  expect(jsonBytes(automatic)).toBeLessThanOrEqual(4096);
  expect(payload(automatic).header.complete).toBe(false);
  for (const maxBytes of [4096, 16384]) {
    let options: TableRead = { maxBytes }, reconstructed = "", pages = 0;
    while (true) {
      const envelope = sealed.read(options), page = payload(envelope);
      expect(jsonBytes(envelope)).toBeLessThanOrEqual(maxBytes);
      expect(jsonBytes(page.header)).toBeLessThanOrEqual(2048);
      expect(envelope.details).toEqual({ table: true });
      expect(page.header.end).toBeGreaterThan(page.header.offset);
      expect(Buffer.from(page.fragment).toString("utf8")).toBe(page.fragment);
      expect(sealed.read(options)).toEqual(envelope);
      reconstructed += page.fragment; ++pages;
      if (page.header.complete) { expect(page.header.cursor).toBeNull(); break; }
      options = { cursor: page.header.cursor };
    }
    expect(pages).toBeGreaterThan(1);
    expect(Buffer.from(reconstructed)).toEqual(Buffer.from(canonical));
  }
  for (const section of ["snapshot", "members", "failures", "pending", "closure", "delivery"] as const) {
    const page = payload(sealed.read({ section, maxBytes: 4096 }));
    expect(page.header.section).toBe(section); expect(page.header.complete).toBe(false);
  }
});

test("inline threshold includes wrappers; cursors bind the seal, section, position and original budget", () => {
  const sealed = sealPages({ protocol: "architecture", judgment: { recommendation: "x".repeat(4400) } });
  expect(payload(sealed.inline(tableTool)).header.complete).toBe(false);
  const page = payload(sealed.read());
  expect(page.header.complete).toBe(true); expect(page.header.maxBytes).toBe(16384);
  const first = payload(sealed.read({ maxBytes: 4096 }));
  const cursor = first.header.cursor;
  expect(typeof cursor).toBe("string");
  const second = sealed.read({ cursor });
  expect(payload(second).header.offset).toBe(first.header.end);
  expect(payload(second).header.maxBytes).toBe(4096);
  expect(sealed.read({ cursor })).toEqual(second);
  const other = sealPages({ protocol: "architecture", judgment: "other" }, sealed.id);
  for (const read of [
    () => other.read({ cursor }),
    () => sealed.read({ cursor: "x".repeat(1025) }),
    () => sealed.read({ cursor: `${cursor}x` }),
    () => sealed.read({ cursor, maxBytes: 16384 } as unknown as TableRead),
    () => sealed.read({ cursor, section: "report" } as unknown as TableRead),
    () => sealed.read({ maxBytes: 4095 }),
    () => sealed.read({ maxBytes: 16385 }),
    () => sealed.read({ maxBytes: 4096.1 }),
    () => sealed.read({ section: "arbitrary" } as unknown as TableRead),
  ]) {
    let error: unknown;
    try { read(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(jsonBytes(tableError(error))).toBeLessThanOrEqual(4096);
  }
  const small = sealPages({ protocol: "architecture", judgment: { recommendation: "small" } });
  expect(payload(small.inline(tableTool))).toMatchObject({ header: { complete: true, acceptance: false },
    report: { judgment: { recommendation: "small" } } });
  const error = tableError("\u0000😀".repeat(10000));
  expect(jsonBytes(error)).toBeLessThanOrEqual(4096);
  expect(error.isError).toBe(true); expect(payload(error).truncated).toBe(true);
});
