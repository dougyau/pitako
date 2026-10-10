import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("provider fixture fails stop before unsafe restoration and permits safe cleanup", () => {
  const evidence = process.env.PROVIDER_FIXTURE_EVIDENCE;
  const root = evidence
    ? path.resolve(evidence)
    : mkdtempSync(path.join(tmpdir(), "pitako-fixture-guard-"));
  mkdirSync(root, { recursive: true });
  const child = path.resolve(import.meta.dir, "fixtures/provider-fixture-child.ts");
  const receipts: unknown[] = [];
  try {
    // Timeout first: a failed consequential guard check stops all further checks.
    for (const mode of ["timeout", "complete", "disposal-failure", "start-failure", "run-rejection", "directory-failure"]) {
      const cwd = path.join(root, mode);
      mkdirSync(cwd);
      const entry = path.join(cwd, "ownership.test.ts");
      writeFileSync(entry, `import ${JSON.stringify(child)};\n`);
      const started = performance.now();
      const result = spawnSync(process.execPath, ["test", entry], {
        cwd,
        env: { ...process.env, PROVIDER_FIXTURE_MODE: mode, PROVIDER_FIXTURE_ROOT: cwd },
        encoding: "utf8",
        timeout: 10_000,
      });
      const elapsedMs = performance.now() - started;
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const markers = output.split("\n");
      const retained = existsSync(path.join(cwd, "owned"));
      receipts.push({ mode, status: result.status, signal: result.signal, error: result.error?.message, elapsedMs, retained });
      if (evidence) {
        writeFileSync(path.join(cwd, "process.log"), output);
        writeFileSync(path.join(root, "receipts.json"), JSON.stringify(receipts, null, 2));
      }
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      if (["timeout", "disposal-failure", "run-rejection"].includes(mode)) {
        expect(result.status).toBe(1);
        expect(output).toContain("PROVIDER FIXTURE FAIL-STOP");
        expect(output).toContain(path.join(cwd, "owned"));
        expect(markers).not.toContain("NEXT_CASE");
        expect(markers).not.toContain("RESTORATION");
        expect(markers).not.toContain("AFTER_GUARD");
        expect(markers).not.toContain("BODY_FINALLY");
        expect(markers).not.toContain("DIRECTORY_RELEASE");
        expect(retained).toBe(true);
        if (mode === "timeout") expect(markers).toContain("ENTER_UNSETTLED");
        if (mode === "disposal-failure") {
          expect(markers).toContain("DISPOSE_ONE");
          expect(markers).toContain("DISPOSE_TWO");
          expect(output).toContain("first disposal failed");
          expect(output).toContain("original assertion failure");
        }
        if (mode === "run-rejection") expect(output).toContain("run-owned disposal failed");
      } else if (mode === "directory-failure") {
        expect(result.status).toBe(1);
        expect(output).toContain("PROVIDER FIXTURE FAIL-STOP");
        expect(output).toContain("owned directory release failed");
        expect(markers).toContain("DISPOSE_COMPLETE");
        expect(markers).toContain("RESTORATION");
        expect(markers).toContain("DIRECTORY_RELEASE");
        expect(markers).not.toContain("AFTER_GUARD");
        expect(markers).not.toContain("NEXT_CASE");
        expect(retained).toBe(true);
      } else {
        expect(result.status).toBe(mode === "complete" ? 0 : 1);
        expect(output).not.toContain("PROVIDER FIXTURE FAIL-STOP");
        expect(markers).toContain("RESTORATION");
        expect(markers).toContain("AFTER_GUARD");
        expect(markers).toContain("NEXT_CASE");
        expect(markers).toContain("DIRECTORY_RELEASE");
        const disposal = mode === "complete" ? "DISPOSE_COMPLETE" : "DISPOSE_LATE_HANDLE";
        expect(markers.indexOf("DIRECTORY_RELEASE")).toBeGreaterThan(markers.indexOf(disposal));
        expect(retained).toBe(false);
        expect(markers).toContain(mode === "complete" ? "DISPOSE_COMPLETE" : "DISPOSE_LATE_HANDLE");
        if (mode === "start-failure") expect(output).toContain("first start failed");
      }
    }
  } finally {
    // Only the parent owns this root; all child processes have exited.
    if (!evidence) rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
