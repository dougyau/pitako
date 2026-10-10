import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

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
