import path from "node:path";
import { readFileSync } from "node:fs";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { extensionPaths, loadPitako, registeredToolNames } from "../../scripts/load-pitako.ts";

const packagePath = process.argv[2];
if (!packagePath) throw new Error("Expected the Pitako package path");

const loaded = await loadPitako(path.resolve(packagePath));
try {
  console.log(`PITAKO_LOAD_RESULT=${JSON.stringify({
    errors: loaded.extensions.errors.map(({ path: extensionPath, error }) => ({
      path: extensionPath,
      message: String(error),
    })),
    names: registeredToolNames(loaded.extensions),
    paths: extensionPaths(loaded.extensions),
    skills: loaded.loader.getSkills().skills.map((skill) => ({
      name: skill.name,
      filePath: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation,
      body: skill.name === "gates" ? readFileSync(skill.filePath, "utf8") : undefined,
    })),
    skillPrompt: formatSkillsForPrompt(loaded.loader.getSkills().skills),
    skillDiagnostics: loaded.loader.getSkills().diagnostics,
  })}`);
} finally {
  loaded.releaseOwnedDirectories();
}
