import { lstatSync } from "node:fs";
import path from "node:path";

const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === names;

export const safeSegment = value => typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) && !value.includes("..");

export function validateMissionPath(missionPath) {
  if (typeof missionPath !== "string" || !path.isAbsolute(missionPath) || missionPath.includes("\0") ||
      !missionPath.endsWith(".json") || !safeSegment(path.basename(missionPath, ".json")))
    throw new Error("Access receipts require the absolute native mission record path.");
}

// Walk every component, including the final one; never resolve a symlink.
export function safePath(file) {
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
    }
  }
  return absolute;
}

export function validateExpected(expected) {
  if (!keys(expected, "count,head") || !Number.isSafeInteger(expected.count) || expected.count < 0 ||
      (expected.count === 0 ? expected.head !== null : !isHash(expected.head))) throw new Error("Invalid ledger anchor.");
}

// pi-subagents external-cli stdin is "<System instructions>\n...\n\n<Task>\n<task>".
// The JSON task cannot contain a raw newline, so the first frame marker is unambiguous.
export function readRequest(input) {
  const marker = "\n<Task>\n", at = input.indexOf(marker);
  return JSON.parse(at === -1 ? input : input.slice(at + marker.length));
}
