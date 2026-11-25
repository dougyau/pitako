import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

type Trusted = (link: string, stat: Stats) => boolean;
const { safePath, systemLink } = createRequire(import.meta.url)("../extensions/hash-ledger.mjs") as {
  safePath(file: string, trusted?: Trusted): string; systemLink: Trusted;
};

// The physical path keeps fixture links independent of system links such as macOS /var.
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pitako-safe-path-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(name: string) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "real", "runs"), { recursive: true });
  writeFileSync(path.join(dir, "real", "runs", "status.json"), "{}");
  return dir;
}
const only = (link: string): Trusted => candidate => candidate === link;

describe("safePath", () => {
  test("returns the absolute path when no component is a symlink", () => {
    const dir = fixture("plain");
    const file = path.join(dir, "real", "runs", "status.json");
    expect(safePath(path.relative(process.cwd(), file))).toBe(file);
  });

  test("rejects a symlink that is not a system link", () => {
    const dir = fixture("untrusted");
    symlinkSync("real", path.join(dir, "alias"));
    expect(() => safePath(path.join(dir, "alias", "runs", "status.json"))).toThrow("Ledger path traverses a symlink.");
    expect(() => safePath(path.join(dir, "alias"))).toThrow("Ledger path traverses a symlink.");
  });

  test("follows a trusted link and returns the path as given", () => {
    const dir = fixture("trusted");
    const link = path.join(dir, "alias");
    symlinkSync("real", link);
    const file = path.join(link, "runs", "status.json");
    expect(safePath(file, only(link))).toBe(file);
    expect(safePath(path.join(link, "runs", "absent.json"), only(link))).toBe(path.join(link, "runs", "absent.json"));
  });

  test("walks the trusted link's target under the same rules", () => {
    const dir = fixture("target");
    symlinkSync(path.join(dir, "real"), path.join(dir, "inner"));
    const link = path.join(dir, "alias");
    symlinkSync("inner", link);
    expect(() => safePath(path.join(link, "runs", "status.json"), only(link))).toThrow("Ledger path traverses a symlink.");
    writeFileSync(path.join(dir, "file"), "");
    const toFile = path.join(dir, "toFile");
    symlinkSync("file", toFile);
    expect(() => safePath(path.join(toFile, "x.json"), only(toFile))).toThrow("Ledger path parent is not a directory.");
  });

  test("stops a trusted link cycle", () => {
    const dir = fixture("cycle");
    const link = path.join(dir, "loop");
    symlinkSync("loop", link);
    expect(() => safePath(path.join(link, "x.json"), () => true)).toThrow("Ledger path traverses a symlink.");
  });
});

describe("systemLink", () => {
  test("does not trust a link below the filesystem root", () => {
    const dir = fixture("system");
    const link = path.join(dir, "alias");
    symlinkSync("real", link);
    expect(systemLink(link, { uid: 0 } as Stats)).toBe(false);
  });

  test("trusts only a root-owned link directly under a root-owned filesystem root", () => {
    const top = path.join(path.parse(root).root, "var");
    const rootStat = (uid: number) => ({ uid } as Stats);
    expect(systemLink(top, rootStat(1000))).toBe(false);
    // The filesystem root is root-owned and not group/other-writable on supported hosts.
    expect(systemLink(top, rootStat(0))).toBe(true);
  });
});
