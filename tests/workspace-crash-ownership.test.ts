import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("workspace crash ownership settles exceptions or fails stop before fixture deletion", () => {
  const evidence = process.env.WORKSPACE_CRASH_EVIDENCE;
  const root = evidence ? path.resolve(evidence) : mkdtempSync(path.join(tmpdir(), "pitako-workspace-guard-"));
  mkdirSync(root, { recursive: true });
  const child = path.resolve(import.meta.dir, "fixtures/workspace-crash-ownership-child.ts");
  const receipts: unknown[] = [];
  try {
    for (const mode of ["callback-pending", "cleanup-pending", "complete", "body-error", "spawn-error", "cleanup-error"]) {
      const cwd = path.join(root, mode);
      mkdirSync(cwd);
      const entry = path.join(cwd, "ownership.test.ts");
      writeFileSync(entry, `import ${JSON.stringify(child)};\n`);
      const result = spawnSync(process.execPath, ["test", entry], {
        cwd, env: { ...process.env, WORKSPACE_CRASH_MODE: mode, WORKSPACE_CRASH_ROOT: cwd },
        encoding: "utf8", timeout: 10_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const markers = output.split("\n");
      const retained = existsSync(path.join(cwd, "owned"));
      receipts.push({ mode, status: result.status, signal: result.signal, error: result.error?.message, retained });
      if (evidence) {
        writeFileSync(path.join(cwd, "process.log"), output);
        writeFileSync(path.join(root, "receipts.json"), JSON.stringify(receipts, null, 2));
      }
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      const unsafe = ["callback-pending", "cleanup-pending", "cleanup-error"].includes(mode);
      expect(result.status).toBe(mode === "complete" ? 0 : 1);
      expect(retained).toBe(unsafe);
      if (unsafe) {
        expect(output).toContain("WORKSPACE CRASH FAIL-STOP:");
        expect(output).toContain(path.join(cwd, "owned"));
        for (const marker of ["AFTER_GUARD", "DELETED", "NEXT_CASE"]) expect(markers).not.toContain(marker);
        if (mode === "callback-pending") expect(markers).toContain("CALLBACK_PENDING");
        else {
          expect(markers).toContain("CLEANUP_ONE");
          expect(markers).toContain("CLEANUP_TWO");
        }
        if (mode === "cleanup-error") {
          expect(output).toContain("first cleanup failed");
          expect(output).toContain("original callback failed");
        }
      } else {
        expect(output).not.toContain("WORKSPACE CRASH FAIL-STOP:");
        for (const marker of ["ACTUAL_CLOSE", "STORE_CLOSED", "AFTER_GUARD", "DELETED", "NEXT_CASE"]) expect(markers).toContain(marker);
        expect(markers.indexOf("STORE_CLOSED")).toBeGreaterThan(markers.indexOf("ACTUAL_CLOSE"));
        if (mode === "body-error") expect(output).toContain("body failed with live child");
        if (mode === "spawn-error") expect(output).toContain("ENOENT");
      }
    }
  } finally {
    if (!evidence) rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
