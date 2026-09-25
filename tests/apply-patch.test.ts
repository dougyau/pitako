import { describe, expect, test } from "bun:test";
import { lstat as fsLstat, mkdtemp, open as fsOpen, readFile, rename as fsRename, rm, stat, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { APPLY_PATCH_GRAMMAR } from "pi-codex-tools";
import { createGrammarToolInputProperties, getJsonSchemaToolParameters, resolveGrammarConstrainedSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { createApplyPatchToolDefinition, runApplyPatch, type PatchFileSystem } from "../extensions/apply-patch.ts";

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "pitako-patch-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function patch(body: string): string {
  return `*** Begin Patch\n${body}*** End Patch`;
}

function output(result: Awaited<ReturnType<typeof runApplyPatch>>): string {
  return result.content[0].text;
}

async function apply(root: string, value: string, dependencies: Partial<Parameters<typeof runApplyPatch>[1]> = {}) {
  return runApplyPatch(value, { cwd: root, ...dependencies });
}

describe("strict apply_patch core", () => {
  test("exports one patch parameter, OpenAI grammar sampling, and sequential execution", () => {
    const tool = createApplyPatchToolDefinition(".");
    expect(tool.name).toBe("apply_patch");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.constrainedSampling).toEqual({ type: "grammar", variants: { openai_lark: APPLY_PATCH_GRAMMAR } });
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(["patch"]);
  });

  test("falls back to the normal JSON tool schema when provider grammar is unsupported", () => {
    const tool = createApplyPatchToolDefinition(".");
    const piTool = tool as never;
    expect(resolveGrammarConstrainedSampling(piTool, true)).toMatchObject({ format: "lark", inputProperty: "patch" });
    expect(resolveGrammarConstrainedSampling(piTool, false)).toBeUndefined();
    expect(createGrammarToolInputProperties([piTool], false).has("apply_patch")).toBe(false);
    expect(getJsonSchemaToolParameters(piTool, false)).toEqual(tool.parameters);
  });

  test("rejects Move before filesystem and host queue access", async () => {
    let fileIo = 0;
    let queueCalls = 0;
    const moved = patch("*** Update File: before.ts\n*** Move to: after.ts\n@@\n-before\n+after\n");
    const result = await runApplyPatch(moved, {
      cwd: "/workspace-that-does-not-exist",
      fileSystem: { realpath: async () => { fileIo++; throw new Error("unexpected"); } },
      withFileMutationQueue: async <T>(_target: string, action: () => Promise<T>) => {
        queueCalls++;
        return action();
      },
    });
    expect(result.details.errorCode).toBe("PATCH_MOVE_UNSUPPORTED");
    expect(fileIo).toBe(0);
    expect(queueCalls).toBe(0);
  });

  test("updates, adds, and deletes with BOM, mixed endings, EOF, mode, and nested Add", async () => {
    await withTempDir(async (root) => {
      const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first\r\nkeep\nlast")]);
      await writeFile(path.join(root, "mixed.txt"), original);
      await writeFile(path.join(root, "remove.txt"), "remove me\n");
      const handle = await fsOpen(path.join(root, "mixed.txt"), "r+");
      await handle.chmod(0o640);
      await handle.close();

      const input = patch(
        "*** Update File: mixed.txt\n@@\n-first\n+second\n" +
        "*** Add File: added/nested.txt\n+new file\n" +
        "*** Delete File: remove.txt\n",
      );
      const result = await apply(root, input);

      expect(result.details).toMatchObject({ ok: true, phase: "complete", plannedFiles: 3, plannedHunks: 3, filesChanged: 3, hunksChanged: 3 });
      expect(result.details.inputBytes).toBe(Buffer.byteLength(input));
      expect(result.details.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(result.details.committed).toEqual(["mixed.txt", "added/nested.txt", "remove.txt"]);
      expect(await readFile(path.join(root, "mixed.txt"))).toEqual(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("second\r\nkeep\nlast")]),
      );
      expect((await stat(path.join(root, "mixed.txt"))).mode & 0o777).toBe(0o640);
      expect(await readFile(path.join(root, "added/nested.txt"), "utf8")).toBe("new file\n");
      expect(await Bun.file(path.join(root, "remove.txt")).exists()).toBe(false);
      expect(output(result)).toContain("mixed.txt, added/nested.txt, remove.txt");
      expect((await Array.fromAsync(new Bun.Glob(".pitako-patch-*.tmp").scan({ cwd: root }))).length).toBe(0);
    });
  });

  test("rejects duplicate targets and patch limits before filesystem access", async () => {
    let fileIo = 0;
    const dependencies = { fileSystem: { realpath: async () => { fileIo++; throw new Error("unexpected"); } } };
    const duplicate = await runApplyPatch(patch(
      "*** Add File: same.txt\n+one\n*** Add File: ./same.txt\n+two\n",
    ), { cwd: "/unused", ...dependencies });
    expect(duplicate.details.errorCode).toBe("PATCH_DUPLICATE_PATH");

    const tooManyPaths = patch(Array.from({ length: 33 }, (_, index) => `*** Add File: file-${index}.txt\n+x\n`).join(""));
    expect((await runApplyPatch(tooManyPaths, { cwd: "/unused", ...dependencies })).details.errorCode).toBe("PATCH_LIMIT");

    const tooManyChunks = patch("*** Update File: file.txt\n" +
      Array.from({ length: 257 }, (_, index) => `@@\n-old-${index}\n+new-${index}\n`).join(""));
    expect((await runApplyPatch(tooManyChunks, { cwd: "/unused", ...dependencies })).details.errorCode).toBe("PATCH_LIMIT");

    const oversized = `*** Begin Patch\n*** Add File: large.txt\n+${"x".repeat(1_048_576)}\n*** End Patch`;
    expect((await runApplyPatch(oversized, { cwd: "/unused", ...dependencies })).details.errorCode).toBe("PATCH_LIMIT");

    const lossy = await runApplyPatch(patch("*** Update File: file.txt\n@@\n-old \n+new\n"), {
      cwd: "/unused",
      ...dependencies,
    });
    expect(lossy.details.errorCode).toBe("PATCH_INVALID");
    const malformed = await runApplyPatch("not a patch", { cwd: "/unused", ...dependencies });
    expect(malformed.details.errorCode).toBe("PATCH_INVALID");
    expect(fileIo).toBe(0);
  });

  test("preserves exact endings for duplicate context markers", async () => {
    await withTempDir(async (root) => {
      const target = path.join(root, "duplicate.txt");
      await writeFile(target, "a\r\na\n");
      const keepSecond = await apply(root, patch("*** Update File: duplicate.txt\n@@\n-a\n a\n"));
      expect(keepSecond.details.ok).toBe(true);
      expect(await readFile(target, "utf8")).toBe("a\n");

      await writeFile(target, "a\r\na\n");
      const keepFirst = await apply(root, patch("*** Update File: duplicate.txt\n@@\n a\n-a\n"));
      expect(keepFirst.details.ok).toBe(true);
      expect(await readFile(target, "utf8")).toBe("a\r\n");

      await writeFile(target, "a\r\nb\na\n");
      const reordered = await apply(root, patch(
        "*** Update File: duplicate.txt\n@@\n-a\n b\n a\n+a\n",
      ));
      expect(reordered.details.ok).toBe(true);
      expect(await readFile(target, "utf8")).toBe("b\na\na\n");
    });
  });

  test("preserves untouched mixed line endings inside a replaced hunk", async () => {
    await withTempDir(async (root) => {
      const target = path.join(root, "context.txt");
      await writeFile(target, "one\r\nmiddle\nthree\r\nend");
      const result = await apply(root, patch(
        "*** Update File: context.txt\n@@\n one\n-middle\n+updated\n three\n",
      ));
      expect(result.details.ok).toBe(true);
      expect(await readFile(target, "utf8")).toBe("one\r\nupdated\nthree\r\nend");
    });
  });

  test("preflights every target before changing any source", async () => {
    await withTempDir(async (root) => {
      await writeFile(path.join(root, "a.txt"), "old-a\n");
      await writeFile(path.join(root, "b.txt"), "new-b\n");
      const result = await apply(root, patch(
        "*** Add File: new/nested.txt\n+new\n" +
        "*** Update File: a.txt\n@@\n-old-a\n+changed-a\n" +
        "*** Update File: b.txt\n@@\n-old-b\n+changed-b\n",
      ));
      expect(result.details.errorCode).toBe("PATCH_STALE");
      expect(result.details.phase).toBe("preflight");
      expect(result.details.committed).toEqual([]);
      expect(result.details.pending).toEqual(["new/nested.txt", "a.txt", "b.txt"]);
      expect(await Bun.file(path.join(root, "new")).exists()).toBe(false);
      expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("old-a\n");
      expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("new-b\n");
    });
  });

  test("rejects ambiguous, unanchored insertion, and non-suffix EOF hunks", async () => {
    await withTempDir(async (root) => {
      await writeFile(path.join(root, "repeat.txt"), "dup\ndup\n");
      const ambiguous = await apply(root, patch("*** Update File: repeat.txt\n@@\n-dup\n+new\n"));
      expect(ambiguous.details.errorCode).toBe("PATCH_STALE");
      expect(await readFile(path.join(root, "repeat.txt"), "utf8")).toBe("dup\ndup\n");

      const unanchored = await apply(root, patch("*** Update File: repeat.txt\n@@\n+inserted\n"));
      expect(unanchored.details.errorCode).toBe("PATCH_STALE");
      expect(await readFile(path.join(root, "repeat.txt"), "utf8")).toBe("dup\ndup\n");

      await writeFile(path.join(root, "eof.txt"), "first\nlast\n");
      const eof = await apply(root, patch("*** Update File: eof.txt\n@@\n-first\n+tail\n*** End of File\n"));
      expect(eof.details.errorCode).toBe("PATCH_STALE");
      expect(await readFile(path.join(root, "eof.txt"), "utf8")).toBe("first\nlast\n");
    });
  });

  test("separates EOF and anchored insertions after an unterminated last line", async () => {
    await withTempDir(async (root) => {
      const eofPath = path.join(root, "eof.txt");
      await writeFile(eofPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("last")]));
      const eof = await apply(root, patch("*** Update File: eof.txt\n@@\n+new\n*** End of File\n"));
      expect(eof.details.ok).toBe(true);
      expect(await readFile(eofPath)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("last\nnew")]));

      const anchoredPath = path.join(root, "anchor.txt");
      await writeFile(anchoredPath, "last");
      const anchored = await apply(root, patch("*** Update File: anchor.txt\n@@ last\n+new\n"));
      expect(anchored.details.ok).toBe(true);
      expect(await readFile(anchoredPath, "utf8")).toBe("last\nnew");
    });
  });

  test("preserves a separator when moving an unterminated context line", async () => {
    await withTempDir(async (root) => {
      const target = path.join(root, "reordered.txt");
      await writeFile(target, "a\r\nlast");
      const result = await apply(root, patch("*** Update File: reordered.txt\n@@\n-a\n last\n+a\n"));
      expect(result.details.ok).toBe(true);
      expect(await readFile(target, "utf8")).toBe("last\r\na");

      await writeFile(target, "a\r\nb");
      const unsatisfiable = await apply(root, patch("*** Update File: reordered.txt\n@@\n a\n-b\n"));
      expect(unsatisfiable.details).toMatchObject({ ok: false, phase: "preflight", errorCode: "PATCH_STALE" });
      expect(await readFile(target, "utf8")).toBe("a\r\nb");
    });
  });

  test("uses exact anchors and suffix matches while preserving inserted line endings", async () => {
    await withTempDir(async (root) => {
      await writeFile(path.join(root, "anchor.txt"), "anchor\r\nend\n");
      const anchored = await apply(root, patch("*** Update File: anchor.txt\n@@ anchor\n+inserted\n"));
      expect(anchored.details.ok).toBe(true);
      expect(await readFile(path.join(root, "anchor.txt"), "utf8")).toBe("anchor\r\ninserted\r\nend\n");

      await writeFile(path.join(root, "eof.txt"), "head\r\nlast");
      const eof = await apply(root, patch("*** Update File: eof.txt\n@@\n-last\n+done\n*** End of File\n"));
      expect(eof.details.ok).toBe(true);
      expect(await readFile(path.join(root, "eof.txt"), "utf8")).toBe("head\r\ndone");

      await writeFile(path.join(root, "append.txt"), "last\r\n");
      const appended = await apply(root, patch("*** Update File: append.txt\n@@\n+new\n*** End of File\n"));
      expect(appended.details.ok).toBe(true);
      expect(await readFile(path.join(root, "append.txt"), "utf8")).toBe("last\r\nnew\r\n");

      await writeFile(path.join(root, "ambiguous-anchor.txt"), "mark\nbody\nmark\n");
      const ambiguous = await apply(root, patch("*** Update File: ambiguous-anchor.txt\n@@ mark\n+inserted\n"));
      expect(ambiguous.details.errorCode).toBe("PATCH_STALE");
      expect(await readFile(path.join(root, "ambiguous-anchor.txt"), "utf8")).toBe("mark\nbody\nmark\n");
    });
  });

  test("rejects traversal, protected paths, symlinks, hard links, and unsupported bytes", async () => {
    await withTempDir(async (root) => {
      for (const target of ["../escape.txt", "/tmp/escape.txt", "C:\\escape.txt", ".env.local/secret", ".git/config", "node_modules/pkg/file"]) {
        const result = await apply(root, patch(`*** Add File: ${target}\n+x\n`));
        expect(result.details.errorCode).toBe("PATCH_PATH");
      }

      await writeFile(path.join(root, "existing.txt"), "keep\n");
      const collision = await apply(root, patch("*** Add File: existing.txt\n+replace\n"));
      expect(collision.details.errorCode).toBe("PATCH_ADD_EXISTS");
      expect(await readFile(path.join(root, "existing.txt"), "utf8")).toBe("keep\n");
      await symlink("missing-target", path.join(root, "dangling"));
      const dangling = await apply(root, patch("*** Add File: dangling\n+unsafe\n"));
      expect(dangling.details.errorCode).toBe("PATCH_LINK");

      const external = await mkdtemp(path.join(tmpdir(), "pitako-external-"));
      try {
        await writeFile(path.join(external, "victim.txt"), "safe\n");
        await symlink(external, path.join(root, "link"), "dir");
        const linked = await apply(root, patch("*** Update File: link/victim.txt\n@@\n-safe\n+bad\n"));
        expect(linked.details.errorCode).toBe("PATCH_LINK");
        expect(await readFile(path.join(external, "victim.txt"), "utf8")).toBe("safe\n");
      } finally {
        await rm(external, { recursive: true, force: true });
      }

      await writeFile(path.join(root, "one.txt"), "same\n");
      await link(path.join(root, "one.txt"), path.join(root, "two.txt"));
      const hardlinked = await apply(root, patch("*** Update File: one.txt\n@@\n-same\n+changed\n"));
      expect(hardlinked.details.errorCode).toBe("PATCH_HARDLINK");
      expect(await readFile(path.join(root, "one.txt"), "utf8")).toBe("same\n");

      await writeFile(path.join(root, "binary.txt"), Buffer.from([0xff, 0xfe, 0x00, 0x00]));
      const binary = await apply(root, patch("*** Update File: binary.txt\n@@\n-old\n+new\n"));
      expect(binary.details.errorCode).toBe("PATCH_UNSUPPORTED_BYTES");
      await writeFile(path.join(root, "invalid-utf8.txt"), Buffer.from([0xff, 0x61]));
      const invalidUtf8 = await apply(root, patch("*** Update File: invalid-utf8.txt\n@@\n-old\n+new\n"));
      expect(invalidUtf8.details.errorCode).toBe("PATCH_UNSUPPORTED_BYTES");
      await writeFile(path.join(root, "nul.txt"), Buffer.from([0x61, 0, 0x62]));
      const nul = await apply(root, patch("*** Delete File: nul.txt\n"));
      expect(nul.details.errorCode).toBe("PATCH_UNSUPPORTED_BYTES");
    });
  });

  test("rejects a source over the per-file byte limit without mutation", async () => {
    await withTempDir(async (root) => {
      const target = path.join(root, "large.txt");
      const source = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
      await writeFile(target, source);
      const result = await apply(root, patch("*** Update File: large.txt\n@@\n-old\n+new\n"));
      expect(result.details).toMatchObject({ ok: false, phase: "preflight", errorCode: "PATCH_LIMIT" });
      expect(await readFile(target)).toEqual(source);
    });
  });

  test("enforces aggregate staged source and target bytes", async () => {
    await withTempDir(async (root) => {
      const source = Buffer.concat([Buffer.from("old\n"), Buffer.alloc(8 * 1024 * 1024 - 4, 0x61)]);
      await writeFile(path.join(root, "a.txt"), source);
      await writeFile(path.join(root, "b.txt"), source);
      const result = await apply(root, patch(
        "*** Add File: tiny.txt\n+x\n" +
        "*** Update File: a.txt\n@@\n-old\n+new\n" +
        "*** Update File: b.txt\n@@\n-old\n+new\n",
      ));
      expect(result.details).toMatchObject({ ok: false, phase: "preflight", errorCode: "PATCH_LIMIT" });
      expect(await readFile(path.join(root, "a.txt"))).toEqual(source);
      expect(await readFile(path.join(root, "b.txt"))).toEqual(source);
      expect(await Bun.file(path.join(root, "tiny.txt")).exists()).toBe(false);
    });
  });

  test("reports committed and pending paths after a failed commit", async () => {
    await withTempDir(async (root) => {
      await writeFile(path.join(root, "a.txt"), "old-a\n");
      await writeFile(path.join(root, "b.txt"), "old-b\n");
      const failingFs: Partial<PatchFileSystem> = {
        rename: async (from, to) => {
          if (to === path.join(root, "b.txt")) throw new Error("injected rename failure");
          await fsRename(from, to);
        },
      };
      const result = await apply(root, patch(
        "*** Update File: a.txt\n@@\n-old-a\n+new-a\n" +
        "*** Update File: b.txt\n@@\n-old-b\n+new-b\n",
      ), { fileSystem: failingFs });
      expect(result.details).toMatchObject({ ok: false, phase: "commit", errorCode: "PATCH_IO", committed: ["a.txt"], pending: ["b.txt"], uncertain: [] });
      expect(output(result)).toContain("Committed: a.txt; pending: b.txt; uncertain: none.");
      expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("new-a\n");
      expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("old-b\n");
    });
  });

  test("reports a missing update target as uncertain after failed rename", async () => {
    await withTempDir(async (root) => {
      const target = path.join(root, "a.txt");
      await writeFile(target, "old\n");
      const failingFs: Partial<PatchFileSystem> = {
        rename: async (from, to) => {
          if (to === target) {
            await rm(target);
            throw new Error("injected target loss during rename");
          }
          await fsRename(from, to);
        },
      };
      const result = await apply(root, patch("*** Update File: a.txt\n@@\n-old\n+new\n"), { fileSystem: failingFs });
      expect(result.details).toMatchObject({
        ok: false,
        phase: "commit",
        committed: [],
        pending: [],
        uncertain: ["a.txt"],
      });
      expect(await Bun.file(target).exists()).toBe(false);
    });
  });

  test("reports uncertain target when failed I/O prevents verifying its outcome", async () => {
    await withTempDir(async (root) => {
      const target = path.join(root, "a.txt");
      await writeFile(target, "old\n");
      let renamed = false;
      const failingFs: Partial<PatchFileSystem> = {
        rename: async (from, to) => {
          await fsRename(from, to);
          renamed = true;
          throw new Error("injected post-rename failure");
        },
        readFile: async (filePath) => {
          if (renamed && filePath === target) throw new Error("injected read failure");
          return readFile(filePath);
        },
      };
      const result = await apply(root, patch("*** Update File: a.txt\n@@\n-old\n+new\n"), { fileSystem: failingFs });
      expect(result.details).toMatchObject({ ok: false, phase: "commit", committed: [], pending: [], uncertain: ["a.txt"] });
      expect(await readFile(target, "utf8")).toBe("new\n");
    });
  });

  test("cancellation during staging leaves source unchanged and awaits cleanup", async () => {
    await withTempDir(async (root) => {
      const target = path.join(root, "a.txt");
      await writeFile(target, "old\n");
      const controller = new AbortController();
      const failingFs: Partial<PatchFileSystem> = {
        open: async (filePath, flags, mode) => {
          const handle = await fsOpen(filePath, flags, mode);
          if (filePath.includes(".pitako-patch-")) controller.abort();
          return handle;
        },
      };
      const result = await apply(root, patch("*** Update File: a.txt\n@@\n-old\n+new\n"), {
        signal: controller.signal,
        fileSystem: failingFs,
      });
      expect(result.details).toMatchObject({ ok: false, phase: "stage", errorCode: "PATCH_ABORTED", committed: [], pending: ["a.txt"], uncertain: [] });
      expect(await readFile(target, "utf8")).toBe("old\n");
      expect((await Array.fromAsync(new Bun.Glob(".pitako-patch-*.tmp").scan({ cwd: root }))).length).toBe(0);
    });
  });

  test("awaits a commit after abort and reports the resulting applied prefix", async () => {
    await withTempDir(async (root) => {
      const target = path.join(root, "a.txt");
      await writeFile(target, "old\n");
      const controller = new AbortController();
      const abortingFs: Partial<PatchFileSystem> = {
        rename: async (from, to) => {
          await fsRename(from, to);
          controller.abort();
        },
      };
      const result = await apply(root, patch("*** Update File: a.txt\n@@\n-old\n+new\n"), {
        signal: controller.signal,
        fileSystem: abortingFs,
      });
      expect(result.details).toMatchObject({ ok: false, phase: "commit", errorCode: "PATCH_ABORTED", committed: ["a.txt"], pending: [], uncertain: [] });
      expect(await readFile(target, "utf8")).toBe("new\n");
    });
  });

  test("rejects symlink-spelled cwd before acquiring a Pi queue", async () => {
    await withTempDir(async (root) => {
      const alias = `${root}-alias`;
      await symlink(root, alias, "dir");
      try {
        let queueCalls = 0;
        const result = await runApplyPatch(patch("*** Add File: added.txt\n+from patch\n"), {
          cwd: alias,
          withFileMutationQueue: async <T>(_target: string, action: () => Promise<T>) => {
            queueCalls++;
            return action();
          },
        });
        expect(result.details.errorCode).toBe("PATCH_PATH");
        expect(queueCalls).toBe(0);
        expect(await Bun.file(path.join(root, "added.txt")).exists()).toBe(false);
      } finally {
        await rm(alias, { force: true });
      }
    });
  });

  test("serializes Add with actual Pi writes before and after target creation", async () => {
    for (const phase of ["before-create", "after-create"] as const) {
      await withTempDir(async (root) => {
        const target = path.join(root, "added.txt");
        let signalPause!: () => void;
        let releasePause!: () => void;
        const paused = new Promise<void>((resolve) => { signalPause = resolve; });
        const gate = new Promise<void>((resolve) => { releasePause = resolve; });
        let pauseOnce = true;
        const pausedFs: Partial<PatchFileSystem> = phase === "before-create"
          ? {
            lstat: async (filePath) => {
              if (filePath === target && pauseOnce) {
                pauseOnce = false;
                signalPause();
                await gate;
              }
              return fsLstat(filePath);
            },
          }
          : {
            open: async (filePath, flags, mode) => {
              const handle = await fsOpen(filePath, flags, mode);
              if (filePath === target && pauseOnce) {
                pauseOnce = false;
                signalPause();
                await gate;
              }
              return handle;
            },
          };
        const patchRun = apply(root, patch("*** Add File: added.txt\n+from patch\n"), { fileSystem: pausedFs });
        let writeRun: Promise<unknown> | undefined;
        try {
          await paused;
          const writeTool = createWriteToolDefinition(root);
          let writeSettled = false;
          writeRun = writeTool.execute("write", { path: "added.txt", content: "from Pi" }, undefined, undefined, { cwd: root } as ExtensionContext)
            .then((result) => { writeSettled = true; return result; });
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(writeSettled).toBe(false);

          releasePause();
          const patchResult = await patchRun;
          await writeRun;
          expect(patchResult.details.ok).toBe(true);
          expect(await readFile(target, "utf8")).toBe("from Pi");
        } finally {
          releasePause();
          await Promise.allSettled([patchRun, ...(writeRun ? [writeRun] : [])]);
        }
      });
    }
  }, 10_000);

  test("holds actual Pi edit and write queue keys across the full patch", async () => {
    await withTempDir(async (root) => {
      const a = path.join(root, "a.txt");
      const b = path.join(root, "b.txt");
      await writeFile(a, "old-a\n");
      await writeFile(b, "old-b\n");
      let signalFirstRename!: () => void;
      let releaseRename!: () => void;
      const firstRename = new Promise<void>((resolve) => { signalFirstRename = resolve; });
      const gate = new Promise<void>((resolve) => { releaseRename = resolve; });
      let paused = false;
      const pausedFs: Partial<PatchFileSystem> = {
        rename: async (from, to) => {
          if (!paused) {
            paused = true;
            signalFirstRename();
            await gate;
          }
          await fsRename(from, to);
        },
      };
      const patchRun = apply(root, patch(
        "*** Update File: a.txt\n@@\n-old-a\n+patch-a\n" +
        "*** Update File: b.txt\n@@\n-old-b\n+patch-b\n",
      ), { fileSystem: pausedFs });
      await firstRename;

      const context = { cwd: root } as ExtensionContext;
      const editTool = createEditToolDefinition(root);
      const writeTool = createWriteToolDefinition(root);
      let editSettled = false;
      let writeSettled = false;
      const editRun = editTool.execute("edit", {
        path: "b.txt",
        edits: [{ oldText: "patch-b", newText: "edited-b" }],
      }, undefined, undefined, context).then((result) => { editSettled = true; return result; });
      const writeRun = writeTool.execute("write", { path: "a.txt", content: "written-a" }, undefined, undefined, context)
        .then((result) => { writeSettled = true; return result; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(editSettled).toBe(false);
      expect(writeSettled).toBe(false);

      releaseRename();
      const patchResult = await patchRun;
      await Promise.all([editRun, writeRun]);
      expect(patchResult.details.ok).toBe(true);
      expect(await readFile(a, "utf8")).toBe("written-a");
      expect(await readFile(b, "utf8")).toBe("edited-b\n");
    });
  });

  test("serializes patches with reversed target order", async () => {
    await withTempDir(async (root) => {
      await writeFile(path.join(root, "a.txt"), "old-a\n");
      await writeFile(path.join(root, "b.txt"), "old-b\n");
      const first = patch(
        "*** Update File: a.txt\n@@\n-old-a\n+first-a\n" +
        "*** Update File: b.txt\n@@\n-old-b\n+first-b\n",
      );
      const reversed = patch(
        "*** Update File: b.txt\n@@\n-old-b\n+second-b\n" +
        "*** Update File: a.txt\n@@\n-old-a\n+second-a\n",
      );
      const results = await Promise.all([apply(root, first), apply(root, reversed)]);
      expect(results.filter((result) => result.details.ok)).toHaveLength(1);
      expect(results.filter((result) => result.details.errorCode === "PATCH_STALE")).toHaveLength(1);
      const a = await readFile(path.join(root, "a.txt"), "utf8");
      const b = await readFile(path.join(root, "b.txt"), "utf8");
      expect([["first-a\n", "first-b\n"], ["second-a\n", "second-b\n"]]).toContainEqual([a, b]);
    });
  }, 5_000);
});
