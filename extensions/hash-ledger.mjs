import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJSON, sha256 as digest } from "./canonical.mjs";

const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === names;

function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Walk every component, including the final one; never resolve a symlink.
export function safePath(file, createDirectories = false) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("Ledger path traverses a symlink.");
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Ledger path parent is not a directory.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (createDirectories) {
        try { mkdirSync(current); syncDirectory(path.dirname(current)); }
        catch (creation) { if (creation.code !== "EEXIST") throw creation; }
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe ledger directory.");
      }
    }
  }
  return absolute;
}

const recordPath = (directory, seq) => safePath(path.join(directory, `${String(seq).padStart(6, "0")}.json`));

function readBytes(file) {
  safePath(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Ledger record is not a regular file.");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
export function validateExpected(expected) {
  if (!keys(expected, "count,head") || !Number.isSafeInteger(expected.count) || expected.count < 0 ||
      (expected.count === 0 ? expected.head !== null : !isHash(expected.head))) throw new Error("Invalid ledger anchor.");
}
/** Read-only verification; an unanchored suffix may be an identical publication retry. */
export function verifyChain(directory, expected, validateRecord) {
  validateExpected(expected);
  const records = [];
  let head = null;
  for (let seq = 0; seq < expected.count; seq++) {
    const bytes = readBytes(recordPath(directory, seq)), record = JSON.parse(bytes);
    validateRecord(record, seq, head);
    if (canonicalJSON(record) !== bytes) throw new Error("Noncanonical ledger record.");
    head = digest(bytes); records.push(record);
  }
  if (head !== expected.head) throw new Error("Ledger head mismatch.");
  return records;
}

/** Only the next unpublished record may already exist. */
export function prepareAppend(directory, next) {
  safePath(directory, true);
  for (const name of readdirSync(directory)) {
    if (/^\d+\.json$/.test(name) && (Number(name.slice(0, -5)) > next || name !== `${String(Number(name.slice(0, -5))).padStart(6, "0")}.json`))
      throw new Error("Ledger has a gap or unexpected record.");
  }
}

export function publish(directory, record) {
  const file = recordPath(directory, record.seq), bytes = canonicalJSON(record);
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    safePath(file);
    try { linkSync(temporary, file); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (readBytes(file) !== bytes) throw new Error("Ledger publication conflict.");
    syncDirectory(directory);
  } finally { unlinkSync(temporary); }
  return { count: record.seq + 1, head: digest(bytes) };
}

// pi-subagents external-cli stdin is "<System instructions>\n...\n\n<Task>\n<task>".
// The JSON task cannot contain a raw newline, so the first frame marker is unambiguous.
export function readRequest(input) {
  const marker = "\n<Task>\n", at = input.indexOf(marker);
  return JSON.parse(at === -1 ? input : input.slice(at + marker.length));
}

