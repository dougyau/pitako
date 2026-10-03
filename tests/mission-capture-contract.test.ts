import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFixtureRejectionCapture } from "./mission-fixtures.ts";

test("fixture callback retains exact rejection, reports owned write failure, and stays silent when disabled", () => {
  const base = mkdtempSync(path.join(tmpdir(), "pitako-capture-contract-"));
  const retainedRoot = process.env.PITAKO_CAPTURE_CONTRACT_ARTIFACTS;
  const stderr = spyOn(process.stderr, "write");
  try {
    const before = stderr.mock.calls.length;
    expect(createFixtureRejectionCapture(undefined, "disabled")).toBeUndefined();
    expect(stderr.mock.calls.length).toBe(before);
    expect(readdirSync(base)).toEqual([]);

    // Synthetic private diagnostic; no engine, process observer or SDK invocation.
    const payload = { boundary: "singleton-checkpoint", missionId: "simulation", attemptId: "fixture",
      checkpointHash: "a".repeat(64), failedPredicate: "unresolved-effects",
      proof: { effectCutSeq: 7 }, effectRows: [{ seq: 7, kind: "effect.registered" }], processes: [] };
    const success = createFixtureRejectionCapture(path.join(retainedRoot ?? base, "success"), "capture-success")!;
    const result = success.captureRejection(payload);
    expect(result.status).toBe("written");
    if (result.status !== "written") throw new Error("capture did not retain simulation");
    expect(readFileSync(result.path, "utf8")).toBe(JSON.stringify(payload, null, 2));
    expect(success.outcomes).toEqual([result]);
    success.restore();

    const invalid = path.join(base, "not-a-directory");
    writeFileSync(invalid, "owned destination obstruction");
    const failure = createFixtureRejectionCapture(path.join(invalid, "rejections"), "capture-failure")!;
    let failed: ReturnType<typeof failure.captureRejection> | undefined;
    expect(() => { failed = failure.captureRejection(payload); }).not.toThrow();
    expect(failed?.status).toBe("failed");
    if (failed?.status !== "failed") throw new Error("owned invalid destination did not fail");
    expect(failed.error.length).toBeGreaterThan(0);
    expect(failure.outcomes).toEqual([failed]);
    expect(stderr.mock.calls.some(([line]) => String(line).includes('"status":"failed"'))).toBe(true);
    failure.restore();
    rmSync(base, { recursive: true, force: true });
    expect(failure.outcomes).toEqual([failed]); // Independent of destination/fixture teardown.
    for (const capture of [success, failure]) {
      expect(capture.trace.map(({ event }) => event)).toEqual(["install", "capture", "restore"]);
      expect(capture.trace.every(({ pid }) => pid === process.pid)).toBe(true);
      expect(capture.trace.every((entry, index) => !index || entry.monotonicMs >= capture.trace[index - 1]!.monotonicMs)).toBe(true);
      expect(JSON.stringify(capture.trace)).not.toContain("failedPredicate");
    }
    if (retainedRoot) {
      mkdirSync(retainedRoot, { recursive: true });
      writeFileSync(path.join(retainedRoot, "outcomes.json"), JSON.stringify({ success: success.trace, failure: failure.trace }, null, 2));
    }
  } finally {
    stderr.mockRestore();
    rmSync(base, { recursive: true, force: true });
  }
});
