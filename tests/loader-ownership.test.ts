import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { bindLspApi, queryLsp } from "../extensions/code-intelligence/lsp.ts";

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
