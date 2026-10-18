import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** File-local environment ownership; callers settle their hooks before release. */
export function privateStartupConfig() {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(path.join(tmpdir(), "pitako-config-"));
  process.env.PI_CODING_AGENT_DIR = root;
  return {
    root,
    close() {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
