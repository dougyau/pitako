import { lstatSync, readlinkSync } from "node:fs";
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

// Only root can replace a root-owned link directly under a root-owned, non-group/other-writable
// filesystem root, such as macOS /var -> private/var and /tmp -> private/tmp.
export function systemLink(link, stat) {
  const parent = path.dirname(link);
  if (parent !== path.parse(link).root || stat.uid !== 0) return false;
  const root = lstatSync(parent);
  return root.uid === 0 && (root.mode & 0o022) === 0;
}

// Walk every component, including the final one. Reject every symlink except a trusted system
// link, whose target is walked again from the root under the same rules.
export function safePath(file, trusted = systemLink) {
  const absolute = path.resolve(file);
  let walked = absolute;
  for (let hops = 0; ; hops++) {
    const link = walkUntilLink(walked);
    if (!link) return absolute;
    if (hops >= 8 || !trusted(link.path, link.stat)) throw new Error("Ledger path traverses a symlink.");
    walked = path.resolve(path.dirname(link.path), readlinkSync(link.path), ...link.rest);
  }
}

function walkUntilLink(absolute) {
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return { path: current, stat, rest: parts.slice(index + 1) };
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Ledger path parent is not a directory.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
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
