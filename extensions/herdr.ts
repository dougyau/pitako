import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse, type TomlTable } from "smol-toml";
import { currentWorkspace } from "./board/workspace.ts";

const setup = "bash scripts/setup-worktree.sh";
const recommendation = `[scripts]\nsetup = "${setup}"`;

/** Advisory only: never execute setup, edit configuration, or grant host trust. */
export function herdrSetupNotice(cwd: string): string | undefined {
  let root: string;
  try {
    root = currentWorkspace(cwd);
  } catch {
    return "Herdr detected. Could not locate this checkout to review .herdr/worktree.toml; no configuration changed.";
  }
  // Other projects own their preparation; do not recommend a nonexistent script.
  if (!existsSync(path.join(root, "scripts/setup-worktree.sh"))) return;

  let source: string;
  try {
    source = readFileSync(path.join(root, ".herdr/worktree.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return "Herdr detected. Could not read .herdr/worktree.toml; review it manually. No configuration changed.";
    }
    return `Herdr detected. Add .herdr/worktree.toml at this checkout's root for strict preparation of new worktrees:\n${recommendation}\nHerdr owns execution and human trust approval; this does not prepare the current checkout.`;
  }

  let config: TomlTable;
  try {
    config = parse(source);
  } catch {
    return "Herdr detected. Could not parse .herdr/worktree.toml; review its TOML before configuring strict setup. No configuration changed.";
  }
  const scripts = config.scripts;
  const configured = scripts && typeof scripts === "object" && !Array.isArray(scripts)
    && "setup" in scripts ? scripts.setup : undefined;
  if (typeof configured === "string" && configured.trim() === setup) return;
  return `Herdr detected. Review .herdr/worktree.toml for strict worktree preparation. Recommended entry:\n${recommendation}\nPreserve existing settings and merge into the existing [scripts] table. Custom setup may already provide this preparation; it has not been evaluated. Herdr owns execution and human trust approval. No configuration changed.`;
}
