import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkoutEvidence, designatedWorkspace, digest, discoverSpec, inspectionSnapshot, MAX_SPEC_BYTES, SPEC_SECTIONS, specChunks, validateSpec } from "../extensions/spec-plans.ts";
import { boardWorkspace } from "../extensions/board/workspace.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), "pitako-spec-plans-")); roots.push(base);
  const main = path.join(base, "main"), sibling = path.join(base, "sibling"), other = path.join(base, "other");
  for (const root of [main, other]) {
    mkdirSync(root); git(root, "init", "-q");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial");
  }
  git(main, "worktree", "add", "-qb", "sibling", sibling);
  return { base, main, sibling, other };
}
function spec(id = "demo") { return `---\npitako-spec: 1\nid: ${id}\nstatus: complete\n---\n# Example\n${SPEC_SECTIONS.map(title => `## ${title}\nSubstantive agreed ${title}.`).join("\n")}\n`; }
function put(root: string, content = spec()) {
  const target = path.join(root, ".pitako/plans/demo.md"); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); return target;
}

describe("spec-plan discovery and concrete input", () => {
  test("local first, unique registered sibling, ambiguity with explicit selection, and unrelated exclusion", () => {
    const { main, sibling, other } = fixture();
    put(other);
    expect(discoverSpec(main, "demo").candidates).toEqual([]);
    const siblingSource = put(sibling);
    const selected = discoverSpec(main, "demo");
    expect(selected.selected?.source).toBe(siblingSource);
    expect(selected.root).toBe(main);
    expect(selected.commonDir).toBe(path.join(main, ".git"));
    const second = path.join(path.dirname(main), "second"); git(main, "worktree", "add", "-qb", "second", second);
    const secondSource = put(second);
    expect(discoverSpec(main, "demo").selected).toBeUndefined();
    expect(discoverSpec(main, "demo").candidates.map(item => item.source).sort()).toEqual([siblingSource, secondSource].sort());
    expect(discoverSpec(main, "demo", siblingSource).selected?.source).toBe(siblingSource);
    expect(() => discoverSpec(main, "demo", path.join(other, ".pitako/plans/demo.md"))).toThrow("not an eligible candidate");
    const local = put(main);
    expect(discoverSpec(main, "demo").selected?.source).toBe(local);
    expect(() => discoverSpec(main, "demo", siblingSource)).toThrow();
  });

  test.each([false, true])("selects a sibling spec from a bare-backed normal worktree (explicit source: %s)", (explicit) => {
    const { base, other } = fixture();
    const bare = path.join(base, "bare.git"), designated = path.join(base, "designated"), sourceRoot = path.join(base, "source");
    git(other, "clone", "--bare", "-q", other, bare);
    git(bare, "worktree", "add", "-qb", "designated", designated);
    git(bare, "worktree", "add", "-qb", "source", sourceRoot);
    const source = put(sourceRoot);
    expect(() => designatedWorkspace(bare)).toThrow("bare; no worktree");
    expect(() => discoverSpec(bare, "demo", source)).toThrow("bare; no worktree");
    expect(designatedWorkspace(designated)).toEqual({ physicalRoot: designated, identity: bare });
    const result = discoverSpec(designated, "demo", explicit ? source : undefined);
    expect(result.root).toBe(designated);
    expect(result.commonDir).toBe(bare);
    expect(result.candidates.map(item => item.source)).toEqual([source]);
    expect(result.selected?.source).toBe(source);
  });

  test("selects a valid local spec before inspecting a missing/prunable sibling without weakening Board", () => {
    const { main, sibling, other } = fixture();
    const local = put(main); put(sibling);
    rmSync(sibling, { recursive: true });
    expect(designatedWorkspace(main)).toEqual({ physicalRoot: main, identity: path.join(main, ".git") });
    expect(discoverSpec(main, "demo").selected?.source).toBe(local);
    expect(() => boardWorkspace(main)).toThrow("unavailable");
    put(main, "Invalid local document"); expect(() => discoverSpec(main, "demo")).toThrow("complete Pitako");
    rmSync(local);
    expect(discoverSpec(main, "demo").candidates).toEqual([]);
    symlinkSync(other, sibling);
    expect(() => discoverSpec(main, "demo")).toThrow("does not match");
  });

  test("rejects a registered sibling replaced by a symlink to a same-repository subdirectory before reading its spec", () => {
    const { main, sibling } = fixture();
    const legitimate = put(sibling);
    expect(discoverSpec(main, "demo").selected?.source).toBe(legitimate);
    const nested = path.join(main, "src"); mkdirSync(nested);
    put(nested);
    rmSync(sibling, { recursive: true }); symlinkSync(nested, sibling);
    expect(() => discoverSpec(main, "demo")).toThrow("not a subdirectory");
    put(nested, "Invalid nested spec must not be read before root validation");
    expect(() => discoverSpec(main, "demo")).toThrow("not a subdirectory");
    // A broken sibling still cannot override a valid or invalid present local document.
    const local = put(main);
    expect(discoverSpec(main, "demo").selected?.source).toBe(local);
    put(main, "Invalid local"); expect(() => discoverSpec(main, "demo")).toThrow("complete Pitako");
  });

  test("invalid local never falls back, and legacy frozen/header-only documents are ineligible", () => {
    const { main, sibling } = fixture(); put(sibling); put(main, "---\nstatus: frozen\n---\nold objective");
    expect(() => discoverSpec(main, "demo")).toThrow("legacy frozen");
    put(main, "---\npitako-spec: 1\nid: demo\nstatus: complete\n---\n");
    expect(() => discoverSpec(main, "demo")).toThrow("Objective");
    expect(() => validateSpec(spec("wrong"), "demo")).toThrow();
    expect(() => validateSpec(spec() + "x".repeat(MAX_SPEC_BYTES), "demo")).toThrow("snapshot boundary");
  });

  test("validates IDs, physical roots and symlink escapes before reading candidates", () => {
    const { main, sibling, other } = fixture(); put(other);
    for (const id of ["../demo", "a/b", "", "x.md", "a\n"]) expect(() => discoverSpec(main, id)).toThrow("ID");
    expect(() => designatedWorkspace(".")).toThrow("absolute");
    const nested = path.join(main, "src"); mkdirSync(nested);
    expect(() => designatedWorkspace(nested)).toThrow("not a subdirectory");
    expect(() => designatedWorkspace(path.dirname(main))).toThrow();
    mkdirSync(path.join(main, ".pitako/plans"), { recursive: true });
    symlinkSync(path.join(other, ".pitako/plans/demo.md"), path.join(main, ".pitako/plans/demo.md"));
    put(sibling);
    expect(() => discoverSpec(main, "demo")).toThrow("Invalid local");
  });

  test("rejects an unregistered copied worktree even when it has valid local specs", () => {
    const { base, sibling } = fixture();
    const copied = path.join(base, "copied"); mkdirSync(copied);
    writeFileSync(path.join(copied, ".git"), readFileSync(path.join(sibling, ".git")));
    put(copied);
    expect(git(copied, "rev-parse", "--show-toplevel")).toBe(copied);
    expect(() => designatedWorkspace(copied)).toThrow("not registered");
    expect(() => discoverSpec(copied, "demo")).toThrow("not registered");
  });

  test("planning root inspection works before the first commit without weakening execution evidence", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-plan-unborn-")); roots.push(root);
    git(root, "init", "-q");
    const script = path.resolve("skills/execute/inspect.mjs");
    const result = JSON.parse(execFileSync("node", [script, root, "demo", "", "root"], { encoding: "utf8" }));
    expect(result).toEqual({ physicalRoot: root, identity: path.join(root, ".git") });
    expect(() => checkoutEvidence(root)).toThrow();
  });

  test("installed own resources under node_modules run the shared inspector through actual Node", () => {
    const { base, main, sibling } = fixture();
    const installed = path.join(base, "install with ' quotes & %PATH% !", "node_modules", "pitako");
    // Copy only owned shipped resources; no dependency install, Pi loader or provider.
    for (const file of ["package.json", "skills/execute/inspect.mjs", "skills/execute/inspect.ts",
      "extensions/spec-plans.ts", "extensions/board/workspace.ts", "extensions/board/paths.ts", "extensions/errors.ts"]) {
      const target = path.join(installed, file); mkdirSync(path.dirname(target), { recursive: true }); cpSync(path.resolve(file), target);
    }
    const entry = path.join(installed, "skills/execute/inspect.mjs");
    const invoke = (root: string, ...extra: string[]) => JSON.parse(execFileSync("node", [entry, root, "demo", "", ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const unborn = path.join(base, "unborn"); mkdirSync(unborn); git(unborn, "init", "-q");
    expect(invoke(unborn, "root")).toEqual({ physicalRoot: unborn, identity: path.join(unborn, ".git") });
    expect(() => invoke(unborn)).toThrow(); // Root-only planning does not weaken strict execution.
    const source = put(sibling, spec() + "é中😀\n".repeat(700));
    const before = checkoutEvidence(main), selected = invoke(main);
    expect(selected.root).toBe(main); expect(selected.selected.source).toBe(source);
    let content = "";
    for (let index = 0; index < selected.selected.chunks; index++) {
      const chunk = invoke(main, String(index)); expect(chunk.digest).toBe(selected.selected.digest); content += chunk.content;
    }
    expect(content).toBe(readFileSync(source, "utf8"));
    expect(invoke(main)).toEqual(selected); expect(checkoutEvidence(main)).toEqual(before);
  });

  test("read-only helper repeats idempotently, snapshots exact UTF-8 chunks, and source edits change digest", () => {
    const { main, sibling } = fixture(); const source = put(sibling, spec() + "é中😀\n".repeat(700));
    const script = path.resolve("skills/execute/inspect.mjs");
    const inspect = (...extra: string[]) => JSON.parse(execFileSync("node", [script, main, "demo", "", ...extra], { encoding: "utf8" }));
    const before = checkoutEvidence(main);
    const first = inspect(); expect(inspect()).toEqual(first);
    expect(checkoutEvidence(main)).toEqual(before);
    let captured = "";
    for (let part = 0; part < first.selected.chunks; part++) {
      const chunk = inspect(String(part)); expect(chunk.digest).toBe(first.selected.digest); captured += chunk.content;
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(4096);
    }
    expect(captured).toBe(readFileSync(source, "utf8"));
    expect(digest(captured)).toBe(first.selected.digest);
    expect(specChunks(captured).join("")).toBe(captured);
    writeFileSync(source, spec() + "Changed objective context");
    expect(inspect().selected.digest).not.toBe(first.selected.digest);
    expect(inspect().root).toBe(main);
  });

  test("oversized combined inspection metadata fails explicitly without truncating accepted specs", () => {
    const content = spec() + '"'.repeat(MAX_SPEC_BYTES - Buffer.byteLength(spec()));
    validateSpec(content, "demo");
    const ordinary = inspectionSnapshot({ source: "/owned/spec.md" }, content);
    expect(ordinary.packets).toHaveLength(26);
    expect(ordinary.packets.map(packet => packet.content).join("")).toBe(content);
    expect(() => inspectionSnapshot({ source: '"\\'.repeat(8000) }, content)).toThrow("26-chunk native snapshot envelope");
    expect(() => inspectionSnapshot({ source: "中".repeat(14000) }, spec())).toThrow("metadata exceeds the native snapshot boundary");
  });

  test("checkout evidence recognizes gitlinks and observes submodule heads and nested dirty/untracked bytes", () => {
    const { main, other } = fixture();
    git(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", other, "module");
    git(main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qam", "Track submodule");
    const module = path.join(main, "module"), unchanged = checkoutEvidence(main);
    expect(unchanged.status).toBe(""); expect(checkoutEvidence(main)).toEqual(unchanged);
    writeFileSync(path.join(module, "tracked.txt"), "one"); git(module, "add", "tracked.txt");
    git(module, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Module identity changed");
    const changedHead = checkoutEvidence(main);
    expect(changedHead.fingerprint).not.toBe(unchanged.fingerprint);
    writeFileSync(path.join(module, "tracked.txt"), "two"); const dirty = checkoutEvidence(main);
    writeFileSync(path.join(module, "tracked.txt"), "three"); expect(checkoutEvidence(main).fingerprint).not.toBe(dirty.fingerprint);
    git(module, "-c", "protocol.file.allow=always", "submodule", "add", "-q", other, "nested");
    const nested = path.join(module, "nested", "untracked.txt");
    writeFileSync(nested, "first untracked bytes"); const before = checkoutEvidence(main);
    writeFileSync(nested, "other untracked bytes"); expect(checkoutEvidence(main).fingerprint).not.toBe(before.fingerprint);
    git(main, "submodule", "deinit", "-f", "module");
    expect(() => checkoutEvidence(main)).not.toThrow();
    expect(checkoutEvidence(main).fingerprint).not.toBe(unchanged.fingerprint);
  });

  test("checkout evidence observes actual bytes, WIP commits, dirty work and detached HEAD", () => {
    const { main } = fixture(); const before = checkoutEvidence(main);
    writeFileSync(path.join(main, "owned.ts"), "one"); const dirty = checkoutEvidence(main);
    expect(dirty.fingerprint).not.toBe(before.fingerprint);
    git(main, "add", "owned.ts"); git(main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "wip: partial");
    expect(checkoutEvidence(main).head).not.toBe(before.head);
    writeFileSync(path.join(main, "owned.ts"), "two"); expect(checkoutEvidence(main).fingerprint).not.toBe(dirty.fingerprint);
    git(main, "checkout", "--detach", "-q"); expect(checkoutEvidence(main).branch).toBe("HEAD");
    const link = path.join(main, "link"); symlinkSync("owned.ts", link); const linked = checkoutEvidence(main).fingerprint;
    rmSync(link); symlinkSync("other.ts", link); expect(checkoutEvidence(main).fingerprint).not.toBe(linked);
  });
});
