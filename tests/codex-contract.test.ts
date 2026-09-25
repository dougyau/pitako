import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  APPLY_PATCH_GRAMMAR,
  createOpenAILarkSampling,
  parseApplyPatch,
} from "pi-codex-tools";

describe("Pi public mutation host contract", () => {
  test("exports the shared diff generators", () => {
    expect(generateUnifiedPatch("file.ts", "old\n", "new\n")).toContain("-old\n+new");
    expect(generateDiffString("old\n", "new\n").diff).toContain("-1 old\n+1 new");
  });

  test("serializes the same missing-file queue key", async () => {
    const target = path.join(tmpdir(), `pitako-queue-${crypto.randomUUID()}.txt`);
    const events: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const first = withFileMutationQueue(target, async () => {
      events.push("first:start");
      firstStarted();
      await holdFirst;
      events.push("first:end");
    });
    await started;
    const second = withFileMutationQueue(target, async () => { events.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });
});

describe("pi-codex-tools public parser and grammar contract", () => {
  test("public entry parses the supported Add, Update, and Delete forms", () => {
    const hunks = parseApplyPatch(`*** Begin Patch
*** Update File: existing.ts
@@
-old
+new
*** Add File: added.ts
+added
*** Delete File: removed.ts
*** End Patch`);

    expect(hunks.map(({ kind, path }) => `${kind}:${path}`)).toEqual([
      "update:existing.ts",
      "add:added.ts",
      "delete:removed.ts",
    ]);
  });

  test("grammar sampling uses Pi's OpenAI Lark shape; Move remains explicit for rejection", () => {
    expect(createOpenAILarkSampling(APPLY_PATCH_GRAMMAR)).toEqual({
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_GRAMMAR },
    });

    const [move] = parseApplyPatch(`*** Begin Patch
*** Update File: before.ts
*** Move to: after.ts
@@
-before
+after
*** End Patch`);
    expect(move).toMatchObject({ kind: "update", path: "before.ts", moveTo: "after.ts" });
    expect(APPLY_PATCH_GRAMMAR).toContain('change_move: "*** Move to: " filename LF');
  });
});
