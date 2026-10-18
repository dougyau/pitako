import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

// Each case owns its checkout, commands, and log; synchronous runs settle before cleanup.
function withSetup(check: (fixture: ReturnType<typeof setupFixture>) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-setup-shell-"));
  try {
    check(setupFixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Command doubles prove shell orchestration only, not installation, SQLite, or CodeGraph indexing.
function setupFixture(root: string) {
  const checkout = path.join(root, "checkout with spaces");
  const bin = path.join(root, "bin");
  mkdirSync(path.join(checkout, "scripts"), { recursive: true });
  mkdirSync(bin);
  const nodeOnPath = Bun.which("node");
  if (!nodeOnPath) throw new Error("setup test requires Node");
  const realNode = nodeOnPath;
  copyFileSync(new URL("../scripts/setup.sh", import.meta.url), path.join(checkout, "scripts/setup.sh"));
  writeFileSync(path.join(checkout, "package.json"), '{"engines":{"node":">=22.19.0","bun":">1.4.2"}}');
  const log = path.join(root, "calls");
  for (const command of ["git", "bun", "node", "codegraph"]) {
    writeFileSync(path.join(bin, command), `#!/bin/bash
if [[ "${command}" == node && "$1" == -p && "$2" == *CODEGRAPH_DIR* ]]; then
  if [[ "\${INDEX_CHECK_EXIT:-0}" != 0 ]]; then exit "$INDEX_CHECK_EXIT"; fi
  exec "$REAL_NODE" "$@"
fi
printf '%s|%s|%s\\n' '${command}' "$PWD" "$*" >> "$CALL_LOG"
case "${command}:$1" in
  codegraph:*)
    [[ "$#" == 3 && "$1" == init && "$2" == "$PWD" && "$3" == --yes ]] || exit 99
    printf 'child-env|%s|%s|%s|%s|%s|%s\\n' "$PWD" "$CODEGRAPH_NO_WATCH" "$CODEGRAPH_FORCE_WATCH" "$CODEGRAPH_NO_DOWNLOAD" "$DO_NOT_TRACK" "\${CODEGRAPH_DIR:-}" >> "$CALL_LOG"
    exit "\${CODEGRAPH_EXIT:-0}" ;;
  git:*) exit "\${GIT_EXIT:-0}" ;;
  bun:--version) echo "\${BUN_VERSION-1.4.3}" ;;
  bun:install) exit "\${INSTALL_EXIT:-0}" ;;
  node:--input-type=module)
    source="$(</dev/stdin)"
    if [[ "$source" == *createRequire* ]]; then exit "\${NATIVE_EXIT:-0}"; fi
    if [[ "\${NODE_EXIT:-0}" != 0 ]]; then exit "$NODE_EXIT"; fi
    exec "$REAL_NODE" "$@" <<< "$source" ;;
esac
`);
    chmodSync(path.join(bin, command), 0o755);
  }
  function run(overrides: Record<string, string | undefined> = {}, args: string[] = []) {
    writeFileSync(log, "");
    const result = spawnSync("/bin/bash", [path.join(checkout, "scripts/setup.sh"), ...args], {
      cwd: root, env: {
        ...process.env, PATH: `${bin}:/usr/bin:/bin`, CALL_LOG: log, REAL_NODE: realNode,
        CODEGRAPH_DIR: "", CODEGRAPH_NO_WATCH: "1", CODEGRAPH_FORCE_WATCH: "0",
        CODEGRAPH_NO_DOWNLOAD: "0", DO_NOT_TRACK: "0", ...overrides,
      },
      encoding: "utf8", timeout: 10000,
    });
    return { ...result, calls: readFileSync(log, "utf8") };
  }
  return { checkout, bin, run };
}

test("setup prepares its checkout and initializes only missing indexes after dependencies", () =>
  withSetup(({ checkout, run }) => {
    const success = run();
    expect(success.status).toBe(0);
    expect(success.stderr).not.toContain("Warning:");
    expect(success.calls).toContain(`bun|${checkout}|install --frozen-lockfile`);
    expect(success.calls).toContain(`codegraph|${checkout}|init ${checkout} --yes`);
    expect(success.calls).toContain(`child-env|${checkout}|0|1|1|1|`);
    expect(success.calls.indexOf("codegraph|")).toBeGreaterThan(success.calls.lastIndexOf("node|"));
    expect(success.calls.split("\n").filter(Boolean).every(line => line.split("|")[1] === checkout)).toBe(true);
    expect(success.calls).not.toMatch(/test|smoke|typecheck|--ignore-scripts/);

    const indexDir = path.join(checkout, ".codegraph");
    mkdirSync(indexDir);
    const empty = run();
    expect(empty.status).toBe(0);
    expect(empty.calls).toContain("codegraph|"); // A directory alone is not initialized.
    writeFileSync(path.join(indexDir, "codegraph.db"), "existing index");
    const existing = run();
    expect(existing.status).toBe(0);
    expect(existing.calls).not.toContain("codegraph|");
    expect(readFileSync(path.join(indexDir, "codegraph.db"), "utf8")).toBe("existing index");
  }));

test("setup skips only CodeGraph preparation when requested", () =>
  withSetup(({ run }) => {
    const skipped = run({ INDEX_CHECK_EXIT: "17", CODEGRAPH_EXIT: "16" }, ["--skip-codegraph"]);
    expect(skipped.status).toBe(0);
    expect(skipped.stderr).not.toContain("Warning:");
    expect(skipped.calls).toContain("install --frozen-lockfile");
    expect(skipped.calls.match(/node\|.*\|--input-type=module/g)).toHaveLength(2);
    expect(skipped.calls).not.toMatch(/\|-p/); // Omit graph-directory lookup.
    expect(skipped.calls).not.toContain("codegraph|");
    expect(run({ INSTALL_EXIT: "14" }, ["--skip-codegraph"]).status).toBe(14);
    expect(run({ NATIVE_EXIT: "15" }, ["--skip-codegraph"]).status).toBe(15);
  }));

test("setup rejects failed prerequisites before installation or indexing", () =>
  withSetup(({ run }) => {
    for (const overrides of [{ GIT_EXIT: "12" }, { NODE_EXIT: "13" }, { BUN_VERSION: "1.0.0" }]) {
      const failed = run(overrides);
      expect(failed.status).toBeGreaterThan(0);
      expect(failed.calls).not.toContain("install --frozen-lockfile");
      expect(failed.calls).not.toContain("codegraph|");
    }
  }));

test("setup admits newer stable Bun versions", () =>
  withSetup(({ run }) => {
    for (const version of ["1.4.4", "1.5.0", "2.0.0"]) {
      const newer = run({ BUN_VERSION: version }, ["--skip-codegraph"]);
      expect(newer.status).toBe(0);
      expect(newer.stdout).toContain(`Bun ${version}`);
      expect(newer.calls).toContain("install --frozen-lockfile");
    }
  }));

test("setup rejects old, prerelease, malformed, and empty Bun versions", () =>
  withSetup(({ run }) => {
    for (const version of ["1.4.2", "1.3.14", "1.4.3-canary.1", "invalid", ""]) {
      const rejected = run({ BUN_VERSION: version }, ["--skip-codegraph"]);
      expect(rejected.status).toBeGreaterThan(0);
      expect(rejected.stderr).toContain("Bun");
      expect(rejected.calls).not.toContain("install --frozen-lockfile");
      expect(rejected.calls).not.toContain("codegraph|");
    }
  }));

test("setup preserves installation and native-load failures before indexing", () =>
  withSetup(({ run }) => {
    const install = run({ INSTALL_EXIT: "14" });
    expect(install.status).toBe(14);
    expect(install.calls.match(/node\|.*\|--input-type=module/g)).toHaveLength(1);
    expect(install.calls).not.toContain("codegraph|");
    const native = run({ NATIVE_EXIT: "15" });
    expect(native.status).toBe(15);
    expect(native.calls).not.toContain("codegraph|");
  }));

test("setup respects an overridden index directory and preserves its database", () =>
  withSetup(({ checkout, run }) => {
    const overrideDir = path.join(checkout, ".codegraph-custom");
    mkdirSync(overrideDir);
    const overridden = run({ CODEGRAPH_DIR: "  .codegraph-custom  " });
    expect(overridden.status).toBe(0);
    expect(overridden.calls).toContain("codegraph|");
    expect(overridden.calls).toContain(`child-env|${checkout}|0|1|1|1|  .codegraph-custom  `);
    writeFileSync(path.join(overrideDir, "codegraph.db"), "custom index");
    const existing = run({ CODEGRAPH_DIR: ".codegraph-custom" });
    expect(existing.status).toBe(0);
    expect(existing.calls).not.toContain("codegraph|");
    expect(readFileSync(path.join(overrideDir, "codegraph.db"), "utf8")).toBe("custom index");
  }));

test("setup falls back to the existing default index for invalid directory overrides", () =>
  withSetup(({ checkout, run }) => {
    const indexDir = path.join(checkout, ".codegraph");
    mkdirSync(indexDir);
    writeFileSync(path.join(indexDir, "codegraph.db"), "existing index");
    for (const invalid of [".", "..", "../outside", "nested/index", "nested\\index", "/absolute", "a..b", "   "]) {
      const result = run({ CODEGRAPH_DIR: invalid });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("Warning:");
      expect(result.calls).not.toContain("codegraph|");
    }
    expect(readFileSync(path.join(indexDir, "codegraph.db"), "utf8")).toBe("existing index");
  }));

test("setup warns but succeeds when optional indexing or its lookup fails", () =>
  withSetup(({ run }) => {
    const indexFailed = run({ CODEGRAPH_EXIT: "16" });
    expect(indexFailed.status).toBe(0);
    expect(indexFailed.stderr).toContain("CodeGraph initialization failed; continue with LSP/read/grep");
    const checkFailed = run({ INDEX_CHECK_EXIT: "17" });
    expect(checkFailed.status).toBe(0);
    expect(checkFailed.stderr).toContain("CodeGraph index check failed");
    expect(checkFailed.calls).not.toContain("codegraph|");
  }));

test("setup selects the PATH CLI before its checkout fallback and tolerates neither being available", () =>
  withSetup(({ checkout, bin, run }) => {
    // PATH wins over the checkout fallback; removing PATH's CLI selects only the checkout's.
    const bundledBin = path.join(checkout, "node_modules", ".bin");
    mkdirSync(bundledBin, { recursive: true });
    writeFileSync(path.join(bundledBin, "codegraph"), `#!/bin/bash
[[ "$#" == 3 && "$1" == init && "$2" == "$PWD" && "$3" == --yes ]] || exit 99
printf 'bundled-codegraph|%s|%s\\n' "$PWD" "$*" >> "$CALL_LOG"
`);
    chmodSync(path.join(bundledBin, "codegraph"), 0o755);
    const preferred = run();
    expect(preferred.status).toBe(0);
    expect(preferred.calls).toContain(`codegraph|${checkout}|init ${checkout} --yes`);
    expect(preferred.calls).not.toContain("bundled-codegraph|");
    rmSync(path.join(bin, "codegraph"));
    const bundled = run();
    expect(bundled.status).toBe(0);
    expect(bundled.stderr).not.toContain("Warning:");
    expect(bundled.calls).toContain(`bundled-codegraph|${checkout}|init ${checkout} --yes`);
    rmSync(path.join(bundledBin, "codegraph"));
    const unavailable = run();
    expect(unavailable.status).toBe(0);
    expect(unavailable.stderr).toContain("CodeGraph CLI unavailable; continue with LSP/read/grep");
    expect(unavailable.calls).not.toContain("codegraph|");
  }));

test("setup rejects missing Bun before installation", () =>
  withSetup(({ bin, run }) => {
    rmSync(path.join(bin, "bun"));
    const missing = run();
    expect(missing.status).toBeGreaterThan(0);
    expect(missing.stderr).toContain("setup requires bun on PATH");
    expect(missing.calls).not.toContain("install --frozen-lockfile");
  }));

test("setup rejects an unsupported actual Node before installation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-setup-node-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(new URL("../scripts/setup.sh", import.meta.url), path.join(root, "scripts/setup.sh"));
    writeFileSync(path.join(root, "package.json"), '{"engines":{"node":">=99.0.0","bun":">1.4.2"}}');
    const result = spawnSync("/bin/bash", [path.join(root, "scripts/setup.sh")], {
      cwd: tmpdir(), encoding: "utf8", timeout: 10000,
    });
    expect(result.status).toBeGreaterThan(0);
    expect(result.stderr).toContain("does not satisfy >=99.0.0");
    expect(result.stdout).not.toContain("bun install");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
