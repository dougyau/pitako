import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const HISTORY_BYTES = 32 * 1024;
export const HISTORY_WINDOW = 4096;
export const HISTORY_FRAGMENT = 8192;

/** Compact JSON syntax state crosses fragment cursors without retaining any string/value. */
export interface JsonState {
  stack: string[];
  root: "value" | "done";
  token?: "string" | "number" | "literal";
  key?: boolean;
  escape?: boolean;
  unicode?: number;
  scalar?: string;
  corrupt?: boolean;
  limited?: boolean;
  utf8?: { remaining: number; value: number; minimum: number };
}
export const jsonState = (): JsonState => ({ stack: [], root: "value" });
export function checkJson(state: JsonState, bytes: Buffer, final: boolean): void {
  const done = () => {
    if (!state.stack.length) state.root = "done";
    else state.stack[state.stack.length - 1] = state.stack.at(-1)!.startsWith("o") ? "oSeparator" : "aSeparator";
  };
  const scalar = () => {
    if (state.token === "number" && !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(state.scalar!) ||
        state.token === "literal" && !["true", "false", "null"].includes(state.scalar!)) state.corrupt = true;
    delete state.token; delete state.scalar; done();
  };
  for (const byte of bytes) {
    if (state.corrupt || state.limited) break;
    if (state.utf8) {
      if (byte < 0x80 || byte > 0xbf) { state.corrupt = true; break; }
      state.utf8.value = (state.utf8.value << 6) | (byte & 63);
      if (--state.utf8.remaining === 0) {
        const { value, minimum } = state.utf8;
        if (value < minimum || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) state.corrupt = true;
        delete state.utf8;
      }
    } else if (byte >= 0x80) {
      if (byte >= 0xc2 && byte <= 0xdf) state.utf8 = { remaining: 1, value: byte & 31, minimum: 0x80 };
      else if (byte >= 0xe0 && byte <= 0xef) state.utf8 = { remaining: 2, value: byte & 15, minimum: 0x800 };
      else if (byte >= 0xf0 && byte <= 0xf4) state.utf8 = { remaining: 3, value: byte & 7, minimum: 0x10000 };
      else { state.corrupt = true; break; }
    }
    const character = String.fromCharCode(byte);
    if (state.token === "string") {
      if (state.unicode) {
        if (!/[0-9a-fA-F]/.test(character)) state.corrupt = true;
        state.unicode--;
      } else if (state.escape) {
        if (character === "u") state.unicode = 4;
        else if (!'"\\/bfnrt'.includes(character)) state.corrupt = true;
        state.escape = false;
      } else if (byte === 92) state.escape = true;
      else if (byte === 34) {
        delete state.token;
        if (state.key) { state.stack[state.stack.length - 1] = "oColon"; state.key = false; }
        else done();
      } else if (byte < 32) state.corrupt = true;
      continue;
    }
    if (state.token) {
      if (/[0-9a-zA-Z.+-]/.test(character)) {
        if (state.scalar!.length >= 256) { state.limited = true; continue; }
        state.scalar += character; continue;
      }
      scalar();
    }
    if ([9, 10, 13, 32].includes(byte)) continue;
    const phase = state.stack.at(-1) ?? state.root;
    if (character === "}" && ["oKeyOrEnd", "oSeparator"].includes(phase) ||
        character === "]" && ["aValueOrEnd", "aSeparator"].includes(phase)) { state.stack.pop(); done(); continue; }
    if (phase === "oSeparator" || phase === "aSeparator") {
      if (character !== ",") state.corrupt = true;
      else state.stack[state.stack.length - 1] = phase === "oSeparator" ? "oKey" : "aValue";
    } else if (phase === "oColon") {
      if (character !== ":") state.corrupt = true;
      else state.stack[state.stack.length - 1] = "oValue";
    } else if (phase === "oKey" || phase === "oKeyOrEnd") {
      if (character !== '"') state.corrupt = true;
      else { state.token = "string"; state.key = true; }
    } else if (["value", "oValue", "aValue", "aValueOrEnd"].includes(phase)) {
      if (character === "{" || character === "[") {
        if (state.stack.length >= 32) state.limited = true;
        else state.stack.push(character === "{" ? "oKeyOrEnd" : "aValueOrEnd");
      } else if (character === '"') state.token = "string";
      else if (character === "-" || /[0-9]/.test(character)) { state.token = "number"; state.scalar = character; }
      else if ("tfn".includes(character)) { state.token = "literal"; state.scalar = character; }
      else state.corrupt = true;
    } else state.corrupt = true;
  }
  if (final && !state.limited) {
    if (state.token === "number" || state.token === "literal") scalar();
    if (state.token || state.stack.length || state.root !== "done" || state.utf8) state.corrupt = true;
  }
}

/** All reads are positional, bounded, and nonmutating. No SDK session loader. */
export function window(fd: number, offset: number, length: number): Buffer {
  const bytes = Buffer.alloc(Math.min(length, HISTORY_WINDOW));
  return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, offset));
}

export interface FileCut {
  dev: number;
  ino: number;
  birth: number;
  size: number;
  modified: number;
  edge: string;
}

function edge(fd: number, size: number): string {
  return createHash("sha256")
    .update(window(fd, 0, Math.min(size, HISTORY_WINDOW)))
    .update(window(fd, Math.max(0, size - HISTORY_WINDOW), Math.min(size, HISTORY_WINDOW)))
    .digest("hex");
}

export function fileCut(fd: number): FileCut {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw new Error("not_regular_file");
  return { dev: stat.dev, ino: stat.ino, birth: stat.birthtimeMs, size: stat.size,
    modified: stat.mtimeMs, edge: edge(fd, stat.size) };
}

export function validateCut(fd: number, cut: FileCut): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.dev !== cut.dev || stat.ino !== cut.ino || stat.birthtimeMs !== cut.birth ||
      stat.size < cut.size || stat.size === cut.size && stat.mtimeMs !== cut.modified ||
      edge(fd, cut.size) !== cut.edge) throw new Error("stale_cursor");
}

/** Discovery never reads the body. Oversized, partial or invalid headers stay uncertain. */
export function nativeHeader(file: string | number): { type?: string; id?: string; version?: number } {
  const fd = typeof file === "number" ? file : openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < 16 * 1024; offset += HISTORY_WINDOW) {
      const bytes = window(fd, offset, HISTORY_WINDOW);
      const end = bytes.indexOf(10);
      chunks.push(bytes.subarray(0, end < 0 ? bytes.length : end));
      if (end >= 0) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (bytes.length < HISTORY_WINDOW) throw new Error("partial_header");
    }
    throw new Error("header_limit");
  } finally { if (typeof file !== "number") closeSync(fd); }
}

/** Incremental catalog scanner: a member is a value, never the entire members array.
 * Metadata values have a fixed ceiling; oversized/invalid metadata fails explicitly.
 */
export function* catalogValues(fd: number): Generator<{ key: string; value: unknown; index?: number }> {
  const size = fstatSync(fd).size;
  let offset = 0;
  let bytes: Buffer = Buffer.alloc(0);
  let at = 0;
  const peek = (): number => {
    if (at === bytes.length && offset < size) {
      bytes = window(fd, offset, size - offset);
      offset += bytes.length;
      at = 0;
    }
    return at < bytes.length ? bytes[at]! : -1;
  };
  const take = () => { const next = peek(); if (next >= 0) at++; return next; };
  const whitespace = () => { while ([9, 10, 13, 32].includes(peek())) take(); };
  const expect = (byte: number) => { whitespace(); if (take() !== byte) throw new Error("corrupt_catalog"); };
  const value = (): unknown => {
    whitespace();
    const collected: number[] = [];
    let depth = 0;
    let quoted = false;
    let escaped = false;
    while (true) {
      const byte = peek();
      if (byte < 0) throw new Error("partial_catalog");
      if (!quoted && depth === 0 && collected.length && [44, 93, 125, 9, 10, 13, 32].includes(byte)) break;
      take();
      collected.push(byte);
      if (collected.length > 64 * 1024) throw new Error("metadata_value_limit");
      if (quoted) {
        if (escaped) escaped = false;
        else if (byte === 92) escaped = true;
        else if (byte === 34) quoted = false;
      } else if (byte === 34) quoted = true;
      else if (byte === 123 || byte === 91) depth++;
      else if (byte === 125 || byte === 93) depth--;
      if (!quoted && depth === 0 && [34, 125, 93].includes(byte)) break;
    }
    return JSON.parse(Buffer.from(collected).toString("utf8"));
  };
  expect(123);
  whitespace();
  const keys = new Set<string>();
  while (peek() !== 125) {
    const key = value();
    if (typeof key !== "string") throw new Error("corrupt_catalog");
    if (!["version", "groupId", "workspace", "identity", "coverage", "members", "closure", "missionStore", "cleanup", "prunedAt", "aliases"].includes(key) || keys.has(key))
      throw new Error("incompatible_catalog");
    keys.add(key);
    expect(58);
    if (key === "members") {
      expect(91);
      whitespace();
      let index = 0;
      while (peek() !== 93) {
        yield { key, value: value(), index: index++ };
        whitespace();
        if (peek() === 93) break;
        expect(44);
        whitespace();
        if (peek() === 93) throw new Error("corrupt_catalog");
      }
      expect(93);
    } else yield { key, value: value() };
    whitespace();
    if (peek() === 125) break;
    expect(44);
    whitespace();
    if (peek() === 125) throw new Error("corrupt_catalog");
  }
  expect(125);
  whitespace();
  if (peek() !== -1) throw new Error("corrupt_catalog");
  if (!["version", "groupId", "workspace", "identity", "coverage", "members", "closure"].every((key) => keys.has(key)))
    throw new Error("incompatible_catalog");
}
