import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkoutEvidence, designatedWorkspace, digest, discoverSpec, executionAmendments, inspectionSnapshot, MAX_SPEC_BYTES, preliminarySpec, specBinding, SPEC_SECTIONS, specChunks, validateSpec } from "../extensions/spec-plans.ts";
import { boardWorkspace } from "../extensions/board/workspace.ts";
import { applyCheckpoint, captureCheckpoint, checkpointDirectory, completeCheckpoint, prepareCheckpoint, restoreCheckpoint, type CheckpointIntent } from "../extensions/execute-checkpoint.ts";

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
  test("admission amendment paths stay inside the designated worktree, including symlinks", () => {
    const { main, other } = fixture(), source = path.join(main, "human.md");
    const content = "# Human amendment\nFull source.\n";
    writeFileSync(source, content); writeFileSync(path.join(other, "outside.md"), content);
    const ref = { path: "human.md", sha256: digest(content), provenance: "human message h1 at 2026-10-31T06:12:50Z" };
    expect(executionAmendments(main)).toEqual([]);
    expect(executionAmendments(main, [ref], true)).toEqual([{ ...ref, path: source }]);
    expect(() => executionAmendments(main, [{ ...ref, path: "../other/outside.md" }])).toThrow("inside designated worktree");
    symlinkSync(path.join(other, "outside.md"), path.join(main, "link.md"));
    expect(() => executionAmendments(main, [{ ...ref, path: "link.md" }], true)).toThrow("Physical path escapes");
    expect(() => executionAmendments(main, [{ ...ref, sha256: "0".repeat(64) }], true)).toThrow("Full source hash mismatch");
    for (const invalidContent of ["", " \n", "# Invalid\0text"]) {
      writeFileSync(source, invalidContent);
      expect(() => executionAmendments(main, [{ ...ref, sha256: digest(invalidContent) }], true)).toThrow("Expected complete nonempty Markdown text");
    }
    for (const invalid of [null, {}, [{ ...ref, sha256: "" }], [{ ...ref, provenance: "" }],
      [{ ...ref, path: "human.txt" }], [{ ...ref, extra: true }]]) {
      expect(() => executionAmendments(main, invalid)).toThrow();
    }
  });
  function checkpoint(root: string): CheckpointIntent {
    return { version: 2, association: { root, commonDir: designatedWorkspace(root).identity,
      missionId: "mission", missionPath: "/native/mission.json", invocation: "run",
      source: "/immutable/spec.md", digest: "a".repeat(64), maxCycles: 5, sourceRefs: [] },
      key: "run.l2.t2.a1", taskId: "unit", attempt: 1, loop: 2, cursor: 1,
      phase: "implementation", planRef: { runId: "plan" } };
  }
  const authority = { settled: true, continuationUnavailable: true, pending: true,
    stop: false, permissionDenied: false, activeWriter: false, references: ["native:exact-settled-run"] };
  const bytes = (value: string) => ({ bytes: Buffer.from(value).toString("base64"), mode: 0o644 });
  test("checkpoint restores modified/deleted/new files to prior WIP, retaining partial bytes and position", () => {
    const { main } = fixture(), intent = checkpoint(main);
    writeFileSync(path.join(main, "modified"), "earlier WIP");
    writeFileSync(path.join(main, "deleted"), "earlier deletion target");
    writeFileSync(path.join(main, "unrelated"), "other WIP");
    const before = checkoutEvidence(main);
    captureCheckpoint(intent, ["modified", "deleted", "new"]);
    expect(checkoutEvidence(main).fingerprint).toBe(before.fingerprint);
    applyCheckpoint(intent, [{ path: "modified", image: bytes("partial") }, { path: "deleted", image: null },
      { path: "new", image: bytes("new partial") }]);
    const result = restoreCheckpoint(intent, authority);
    expect(result.position).toEqual({ loop: 2, cursor: 1, phase: "implementation" });
    expect(result.candidate.fingerprint).toBe(before.fingerprint);
    expect(readFileSync(path.join(main, "unrelated"), "utf8")).toBe("other WIP");
    const partial = JSON.parse(JSON.parse(readFileSync(result.partialRef, "utf8")).data);
    expect(partial.partial).toEqual([{ path: "modified", image: bytes("partial") }, { path: "deleted", image: null },
      { path: "new", image: bytes("new partial") }]);
    expect(restoreCheckpoint(intent, authority).candidate.fingerprint).toBe(before.fingerprint);
  });
  test("checkpoint refuses unrecorded edits, missing images, escapes and HEAD-only backups without overwriting WIP", () => {
    const { main, other } = fixture(), intent = checkpoint(main);
    writeFileSync(path.join(main, "owned"), "before");
    const captured = captureCheckpoint(intent, ["owned"]);
    expect(() => applyCheckpoint(intent, [{ path: "outside", image: bytes("bad") }])).toThrow("outside captured");
    writeFileSync(path.join(main, "owned"), "third party");
    expect(() => restoreCheckpoint(intent, authority)).toThrow("Unattributed");
    expect(readFileSync(path.join(main, "owned"), "utf8")).toBe("third party");
    expect(() => restoreCheckpoint({ ...intent, taskId: "another" }, authority)).toThrow("association");
    const manifest = path.join(captured.directory, "manifest.json"), envelope = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, JSON.stringify({ ...envelope, data: envelope.data + " " }));
    expect(() => restoreCheckpoint(intent, authority)).toThrow("digest mismatch");
    rmSync(manifest);
    writeFileSync(manifest, JSON.stringify({ sha256: digest(JSON.stringify({ intent, base: captured.base })),
      data: JSON.stringify({ intent, base: captured.base }) }));
    expect(() => restoreCheckpoint(intent, authority)).toThrow("preimages");
    const fresh = { ...intent, key: "fresh" };
    expect(() => captureCheckpoint(fresh, ["../escape"])).toThrow("Invalid");
    expect(() => captureCheckpoint(fresh, [".git/config"])).toThrow("protected");
    symlinkSync(other, path.join(main, "linked"));
    expect(() => captureCheckpoint(fresh, ["linked/file"])).toThrow("symlink");
    expect(() => captureCheckpoint(fresh, [".pitako/plans/spec.md"])).toThrow("immutable");
  });
  test("capture publication cuts cannot license writes or overwrite an existing preimage", () => {
    const { main } = fixture(), intent = checkpoint(main);
    writeFileSync(path.join(main, "owned"), "prior WIP");
    // A failed publication leaves no authoritative manifest and no file effects.
    const directory = checkpointDirectory(intent);
    mkdirSync(path.join(directory, "manifest.json"), { recursive: true });
    expect(() => captureCheckpoint(intent, ["owned"])).toThrow("already exists");
    expect(() => applyCheckpoint(intent, [{ path: "owned", image: bytes("partial") }])).toThrow();
    expect(readFileSync(path.join(main, "owned"), "utf8")).toBe("prior WIP");
    rmSync(directory, { recursive: true });
    captureCheckpoint(intent, ["owned"]);
    const original = readFileSync(path.join(directory, "manifest.json"), "utf8");
    expect(() => captureCheckpoint(intent, ["owned"])).toThrow("already exists");
    expect(readFileSync(path.join(directory, "manifest.json"), "utf8")).toBe(original);
    applyCheckpoint(intent, [{ path: "owned", image: bytes("partial") }]);
    rmSync(path.join(directory, "manifest.json"));
    expect(() => restoreCheckpoint(intent, authority)).toThrow();
    expect(readFileSync(path.join(main, "owned"), "utf8")).toBe("partial");
  });
  test.each(["stop", "permissionDenied", "activeWriter", "pending"])(
    "checkpoint restoration respects current %s observation", field => {
      const { main } = fixture(), intent = checkpoint(main);
      writeFileSync(path.join(main, "owned"), "before"); captureCheckpoint(intent, ["owned"]);
      applyCheckpoint(intent, [{ path: "owned", image: bytes("partial") }]);
      const observed = { ...authority, [field]: !authority[field as keyof typeof authority] };
      expect(() => restoreCheckpoint(intent, observed)).toThrow("authority");
      expect(readFileSync(path.join(main, "owned"), "utf8")).toBe("partial");
    });
  test.each(["absent", "inconclusive", "historically-settled"])(
    "checkpoint restoration does not require %s writer settlement metadata", mode => {
      const { main } = fixture(), intent = checkpoint(main);
      writeFileSync(path.join(main, "owned"), "prior WIP"); captureCheckpoint(intent, ["owned"]);
      applyCheckpoint(intent, [{ path: "owned", image: bytes("partial") }]);
      const { settled, continuationUnavailable, ...current } = authority;
      const observation = mode === "absent" ? current : { ...current,
        settled: mode === "historically-settled", continuationUnavailable: mode === "historically-settled" };
      const restored = restoreCheckpoint(intent, observation);
      expect(readFileSync(path.join(main, "owned"), "utf8")).toBe("prior WIP");
      expect(readFileSync(restored.partialRef, "utf8")).toContain(Buffer.from("partial").toString("base64"));
      expect(restored.position).toEqual({ loop: 2, cursor: 1, phase: "implementation" });
      expect(observation).toEqual(mode === "absent" ? current : { ...current,
        settled: mode === "historically-settled", continuationUnavailable: mode === "historically-settled" });
    });
  test("checkpoint restore reconciles a cut after effect publication and during partial restoration", () => {
    const { main } = fixture(), intent = checkpoint(main);
    writeFileSync(path.join(main, "a"), "prior a", { mode: 0o644 }); writeFileSync(path.join(main, "b"), "prior b", { mode: 0o644 });
    captureCheckpoint(intent, ["a", "b"]);
    prepareCheckpoint(intent, [{ path: "a", image: bytes("after a") }, { path: "b", image: bytes("after b") }]);
    expect(readFileSync(path.join(main, "a"), "utf8")).toBe("prior a");
    completeCheckpoint(intent);
    // Model a cut between atomic effects using an exact recorded preimage.
    writeFileSync(path.join(main, "b"), "prior b");
    const restored = restoreCheckpoint(intent, authority);
    expect(readFileSync(path.join(main, "a"), "utf8")).toBe("prior a");
    // The retained partial-state record permits replay of an interrupted
    // restoration; it never licenses an unrelated byte sequence.
    writeFileSync(path.join(main, "a"), "after a");
    expect(restoreCheckpoint(intent, authority).candidate.fingerprint).toBe(restored.candidate.fingerprint);
    expect(checkpointDirectory(intent)).toContain(".pi/subagents/checkpoints");
  });
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
    for (const file of ["package.json", "skills/execute/inspect.mjs", "skills/execute/ledger.mjs", "skills/execute/loader.mjs", "skills/execute/inspect.ts",
      "extensions/spec-plans.ts", "extensions/execute-retained.ts", "extensions/execute-checkpoint.ts", "extensions/execute-state.ts", "extensions/board/workspace.ts", "extensions/board/paths.ts", "extensions/errors.ts"]) {
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
    expect(() => inspectionSnapshot({ source: "中".repeat(40000) }, spec())).toThrow("metadata exceeds the native snapshot boundary");
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


describe("preliminary capture", () => {
  test("preserves maximum bytes as inert escaped data and binds all physical selectors", () => {
    const { main, sibling } = fixture();
    const prefix = spec() + "中😀\n'; throw Error('not code'); //\n";
    const content = prefix + '"'.repeat(MAX_SPEC_BYTES - Buffer.byteLength(prefix));
    const source = put(sibling, content);
    const preliminary = preliminarySpec(main, "demo", source);
    expect(Buffer.byteLength(content)).toBe(39936);
    expect(Buffer.byteLength(JSON.stringify(preliminary))).toBeGreaterThan(65536);
    expect(JSON.parse(JSON.stringify(preliminary)).content).toBe(content);
    expect(preliminary).toMatchObject({ root: main, commonDir: path.join(main, ".git"), source, digest: digest(content), version: 1 });
    const { binding } = preliminary;
    for (const changed of [specBinding("other", main, preliminary.commonDir, preliminary),
      specBinding("demo", sibling, preliminary.commonDir, preliminary),
      specBinding("demo", main, sibling, preliminary),
      specBinding("demo", main, preliminary.commonDir, { ...preliminary, source: source + "x" }),
      specBinding("demo", main, preliminary.commonDir, { ...preliminary, digest: "f".repeat(64) })])
      expect(changed.binding).not.toBe(binding);
    put(main, spec());
    expect(() => preliminarySpec(main, "demo", source)).toThrow("local-first");
    expect(preliminarySpec(main, "demo").source).toBe(path.join(main, ".pitako/plans/demo.md"));
  });
  test("invalid oversized local candidates are bounded and cannot fall back to a valid sibling", () => {
    const { main, sibling } = fixture(); put(sibling); put(main, spec() + "x".repeat(MAX_SPEC_BYTES * 2));
    expect(() => preliminarySpec(main, "demo")).toThrow("size exceeds 39936");
    expect(() => preliminarySpec(main, "demo")).toThrow("explicitly prepare admission");
    put(main, "invalid");
    expect(() => preliminarySpec(main, "demo")).toThrow("Not a complete");
  });
  test("missing and ambiguous inputs identify the correction instead of a hash mismatch", () => {
    const { main, sibling, base } = fixture();
    expect(() => preliminarySpec(main, "demo")).toThrow("Missing complete spec-plan");
    put(sibling);
    const third = path.join(base, "third"); git(main, "worktree", "add", "-qb", "third", third); const source = put(third);
    expect(() => preliminarySpec(main, "demo")).toThrow("Ambiguous spec-plan");
    expect(preliminarySpec(main, "demo", source).source).toBe(source);
  });
});
