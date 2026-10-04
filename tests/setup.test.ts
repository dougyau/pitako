import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

// Command doubles prove shell orchestration only, not installation or native SQLite.
test("setup selects its checkout, freezes install, and stops on prerequisite/install/native failures", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-setup-shell-"));
  try {
    const checkout = path.join(root, "checkout");
    const bin = path.join(root, "bin");
    mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    mkdirSync(bin);
    copyFileSync(new URL("../scripts/setup.sh", import.meta.url), path.join(checkout, "scripts/setup.sh"));
    writeFileSync(path.join(checkout, "package.json"), '{"packageManager":"bun@1.3.14","engines":{"node":">=22.19.0"}}');
    const log = path.join(root, "calls");
    for (const command of ["git", "bun", "node"]) {
      writeFileSync(path.join(bin, command), `#!/bin/bash
printf '%s|%s|%s\\n' '${command}' "$PWD" "$*" >> "$CALL_LOG"
case "${command}:$1" in
  git:*) exit "\${GIT_EXIT:-0}" ;;
  bun:--version) echo "\${BUN_VERSION:-1.3.14}" ;;
  bun:install) exit "\${INSTALL_EXIT:-0}" ;;
  node:-p) echo bun@1.3.14 ;;
  node:--input-type=module)
    source="$(</dev/stdin)"
    if [[ "$source" == *createRequire* ]]; then exit "\${NATIVE_EXIT:-0}"; fi
    exit "\${NODE_EXIT:-0}" ;;
esac
`);
      chmodSync(path.join(bin, command), 0o755);
    }
    function run(overrides: Record<string, string | undefined> = {}) {
      writeFileSync(log, "");
      const result = spawnSync("/bin/bash", [path.join(checkout, "scripts/setup.sh")], {
        cwd: root, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CALL_LOG: log, ...overrides },
        encoding: "utf8", timeout: 10000,
      });
      return { ...result, calls: readFileSync(log, "utf8") };
    }
    const success = run();
    expect(success.status).toBe(0);
    expect(success.calls).toContain(`bun|${checkout}|install --frozen-lockfile`);
    expect(success.calls.split("\n").filter(Boolean).every(line => line.split("|")[1] === checkout)).toBe(true);
    expect(success.calls).not.toMatch(/test|smoke|typecheck|--ignore-scripts/);
    for (const overrides of [{ GIT_EXIT: "12" }, { NODE_EXIT: "13" }, { BUN_VERSION: "1.0.0" }]) {
      const failed = run(overrides);
      expect(failed.status).not.toBe(0);
      expect(failed.calls).not.toContain("install --frozen-lockfile");
    }
    const install = run({ INSTALL_EXIT: "14" });
    expect(install.status).toBe(14);
    expect(install.calls.match(/node\|.*\|--input-type=module/g)).toHaveLength(1);
    expect(run({ NATIVE_EXIT: "15" }).status).toBe(15);
    rmSync(path.join(bin, "bun"));
    const missing = spawnSync("/bin/bash", [path.join(checkout, "scripts/setup.sh")], {
      cwd: root, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8", timeout: 10000,
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("setup requires bun on PATH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup rejects an unsupported actual Node before installation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-setup-node-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(new URL("../scripts/setup.sh", import.meta.url), path.join(root, "scripts/setup.sh"));
    writeFileSync(path.join(root, "package.json"), '{"packageManager":"bun@1.3.14","engines":{"node":">=99.0.0"}}');
    const result = spawnSync("/bin/bash", [path.join(root, "scripts/setup.sh")], {
      cwd: tmpdir(), encoding: "utf8", timeout: 10000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not satisfy >=99.0.0");
    expect(result.stdout).not.toContain("bun install");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
