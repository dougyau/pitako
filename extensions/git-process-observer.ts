import path from "node:path";
import { realpathSync } from "node:fs";

// Registrations belong to unique fixture roots, not a process-wide test counter.
const observers = new Map<string, () => void>();
export function observeGitProcesses(root: string, observe: () => void): () => void {
  root = realpathSync(root);
  if (observers.has(root)) throw new Error(`Git process observer already registered: ${root}`);
  observers.set(root, observe);
  return () => { if (observers.get(root) === observe) observers.delete(root); };
}

export function gitProcessStarted(cwd: string): void {
  if (!observers.size) return;
  // Workspace discovery canonicalizes cwd (including /var -> /private/var).
  try { cwd = realpathSync(cwd); }
  catch { cwd = path.resolve(cwd); } // Preserve the Git operation's own cwd error.
  let owner: string | undefined;
  for (const root of observers.keys())
    if ((cwd === root || cwd.startsWith(root + path.sep)) && (!owner || root.length > owner.length)) owner = root;
  if (owner) observers.get(owner)!();
}
