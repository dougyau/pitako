import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPitako } from "../scripts/load-pitako.ts";
import { packageRoot } from "../extensions/stack.ts";
import { bindLspApi, queryLsp } from "../extensions/code-intelligence/lsp.ts";

test("loader release removes only defaults and is idempotent", async () => {
  const supplied = fs.mkdtempSync(path.join(tmpdir(), "pitako-loader-owner-"));
  const handles: Awaited<ReturnType<typeof loadPitako>>[] = [];
  try {
    const defaults = await loadPitako(packageRoot());
    handles.push(defaults);
    const cwdOnly = await loadPitako(packageRoot(), supplied);
    handles.push(cwdOnly);
    const suppliedBoth = await loadPitako(packageRoot(), supplied, supplied);
    handles.push(suppliedBoth);
    const agentOnly = await loadPitako(packageRoot(), undefined, supplied);
    handles.push(agentOnly);
    for (const loaded of handles) {
      expect(loaded.extensions.errors).toEqual([]);
      expect(fs.existsSync(loaded.cwd)).toBe(true);
      expect(fs.existsSync(loaded.agentDir)).toBe(true);
      loaded.releaseOwnedDirectories();
      loaded.releaseOwnedDirectories();
    }
    expect(fs.existsSync(defaults.cwd)).toBe(false);
    expect(fs.existsSync(defaults.agentDir)).toBe(false);
    expect(fs.existsSync(cwdOnly.agentDir)).toBe(false);
    expect(fs.existsSync(agentOnly.cwd)).toBe(false);
    expect(fs.existsSync(path.join(supplied, ".pi", "settings.json"))).toBe(true);
  } finally {
    for (const loaded of handles) loaded.releaseOwnedDirectories();
    fs.rmSync(supplied, { recursive: true, force: true });
  }
});

test("loader cleans partial acquisition and setup failure without removing supplied paths", async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pitako-loader-failure-"));
  const allocate = fs.mkdtempSync;
  const blockedCwd = path.join(root, "not-a-directory");
  fs.writeFileSync(blockedCwd, "caller owned");
  const allocation = spyOn(fs, "mkdtempSync")
    .mockImplementationOnce(allocate)
    .mockImplementationOnce(() => { throw new Error("second allocation failed"); });
  try {
    await expect(loadPitako(packageRoot())).rejects.toThrow("second allocation failed");
    expect(allocation.mock.calls).toHaveLength(2);
    expect(fs.existsSync(String(allocation.mock.results[0]!.value))).toBe(false);
    allocation.mockImplementation(allocate);
    await expect(loadPitako(packageRoot(), blockedCwd)).rejects.toThrow();
    expect(allocation.mock.calls).toHaveLength(3);
    expect(fs.existsSync(String(allocation.mock.results[2]!.value))).toBe(false);
    expect(fs.readFileSync(blockedCwd, "utf8")).toBe("caller owned");
  } finally {
    for (const result of allocation.mock.results) {
      if (result.type === "return") fs.rmSync(String(result.value), { recursive: true, force: true });
    }
    allocation.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LSP registration and rebinding do not acquire managers; first query acquires once", async () => {
  const key = Symbol.for("pitako.code-intelligence.lsp-registry");
  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const previous = globals[key];
  delete globals[key];
  let acquisitions = 0;
  const manager = { stopAll: async () => {} };
  const binding = {
    findWorkspaceRoot: () => tmpdir(),
    withLspClient: async (_file: string, run: (client: any) => Promise<any>, _operation: unknown, options: { manager: unknown }) => {
      expect(options.manager).toBe(manager);
      return run({});
    },
    createManager: () => { acquisitions++; return manager; },
    findServerForExtension: () => ({ status: "configured" }),
  };
  try {
    bindLspApi(binding);
    bindLspApi(binding);
    await Promise.resolve();
    expect(acquisitions).toBe(0);
    for (let i = 0; i < 2; i++) {
      expect(await queryLsp("sample.ts", new AbortController().signal, "documentSymbols", async () => "observed")).toBe("observed");
    }
    expect(acquisitions).toBe(1);
  } finally {
    await manager.stopAll();
    if (previous === undefined) delete globals[key];
    else globals[key] = previous;
  }
});
