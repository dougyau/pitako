import { canonicalPath } from "../board/paths.ts";

type ReadOnlyOperation = "diagnostics" | "references" | "documentSymbols" | "workspaceSymbols";
type SharedLsp = {
  findWorkspaceRoot(filePath: string): string;
  withLspClient(filePath: string, run: (client: any) => Promise<any>, operation: ReadOnlyOperation, options: { manager: any }): Promise<any>;
  manager: any;
  queues: Map<string, Promise<void>>;
};
type ExtensionLookup = (extension: string) => { status: string };
type RegisteredLsp = Promise<SharedLsp> & { findServerForExtension?: ExtensionLookup };
type LspRegistry = typeof globalThis & { [key: symbol]: RegisteredLsp | undefined };
type LspBinding = Omit<SharedLsp, "queues" | "manager"> & { createManager(): any; findServerForExtension: ExtensionLookup };

const REGISTRY = Symbol.for("pitako.code-intelligence.lsp-registry");
const EXTENSION_LOOKUP = Symbol.for("pitako.code-intelligence.lsp-extension-lookup");

export function bindLspApi(binding: LspBinding): void {
  const global = globalThis as LspRegistry;
  const extensionRegistry = globalThis as typeof globalThis & { [key: symbol]: ExtensionLookup | undefined };
  extensionRegistry[EXTENSION_LOOKUP] ??= binding.findServerForExtension;
  const shared = Promise.resolve().then(() => ({
    findWorkspaceRoot: binding.findWorkspaceRoot,
    withLspClient: binding.withLspClient,
    manager: binding.createManager(),
    queues: new Map(),
  })) as RegisteredLsp;
  shared.findServerForExtension = binding.findServerForExtension;
  global[REGISTRY] ??= shared;
}

export function hasLspServerForExtension(extension: string): boolean {
  const extensionRegistry = globalThis as typeof globalThis & { [key: symbol]: ExtensionLookup | undefined };
  const lookup = extensionRegistry[EXTENSION_LOOKUP] ?? (globalThis as LspRegistry)[REGISTRY]?.findServerForExtension;
  return lookup ? lookup(extension).status !== "not_configured" : false;
}

function abortable<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (!settled) { settled = true; resolve(value); }
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (!settled) { settled = true; reject(error); }
      },
    );
  });
}

export async function lspWorkspaceRoot(filePath: string): Promise<string | undefined> {
  const shared = (globalThis as LspRegistry)[REGISTRY];
  if (!shared) return undefined;
  try { return canonicalPath((await shared).findWorkspaceRoot(filePath)); } catch { return undefined; }
}

export async function queryLsp<T>(
  filePath: string,
  signal: AbortSignal,
  operation: ReadOnlyOperation,
  run: (client: any) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const shared = (globalThis as LspRegistry)[REGISTRY];
  if (!shared) throw new Error("Pi extension loader binding is not initialized");
  const api = await shared;
  signal.throwIfAborted();

  const root = canonicalPath(api.findWorkspaceRoot(filePath));
  const previous = api.queues.get(root) ?? Promise.resolve();
  const work = previous.then(() => {
    signal.throwIfAborted();
    return api.withLspClient(filePath, run, operation, { manager: api.manager });
  });
  const tail = work.then(() => undefined, () => undefined);
  api.queues.set(root, tail);
  void tail.then(() => {
    if (api.queues.get(root) === tail) api.queues.delete(root);
  });

  return abortable(signal, work);
}
