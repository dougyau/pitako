import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StackFile } from "../extensions/stack.ts";

const registryVersion = /^\d+\.\d+\.\d+$/;

function updateDependencies(root: string): void {
  const manifestPath = path.join(root, "package.json");
  const readDependencies = (): Record<string, string> =>
    JSON.parse(readFileSync(manifestPath, "utf8")).dependencies;
  // These must retain classic tsserver and Pitako's Node floor respectively.
  const manual = new Set(["typescript", "typescript-language-server"]);
  // Git revisions and Pi's dev/peer dependencies also stay under manual control.
  const previousDependencies = readDependencies();
  const names = Object.entries(previousDependencies)
    .filter(([name, version]) => !manual.has(name) && registryVersion.test(version))
    .map(([name]) => name);
  if (names.length === 0) throw new Error("No pinned npm runtime dependencies to update");
  execFileSync("bun", ["update", "--latest", "--exact", ...names], { cwd: root, stdio: "inherit" });

  const dependencies = readDependencies();
  const identitiesPath = path.join(root, "docs/dependency-releases.json");
  const identitiesSource = readFileSync(identitiesPath, "utf8");
  const identities = JSON.parse(identitiesSource);
  let identitiesChanged = false;
  for (const name of names) {
    const version = dependencies[name];
    if (version === previousDependencies[name]) continue;
    if (!version || !registryVersion.test(version)) throw new Error(`Invalid exact version for ${name}`);
    const registry = `https://registry.npmjs.org/${name}/${version}`;
    const metadata = JSON.parse(execFileSync("npm", [
      "view", `${name}@${version}`, "--json", "--registry=https://registry.npmjs.org",
    ], { cwd: root, encoding: "utf8" }));
    if (metadata.name !== name || metadata.version !== version ||
        typeof metadata.dist?.tarball !== "string" ||
        !metadata.dist.tarball.startsWith("https://registry.npmjs.org/") ||
        typeof metadata.dist?.integrity !== "string" || !metadata.dist.integrity ||
        (metadata.gitHead !== undefined && typeof metadata.gitHead !== "string") ||
        (metadata.license !== undefined && typeof metadata.license !== "string")) {
      throw new Error(`Invalid npm release metadata for ${name}@${version}`);
    }
    identities[name] = {
      version, registry, tarball: metadata.dist.tarball, integrity: metadata.dist.integrity,
      ...(metadata.gitHead === undefined ? {} : { gitHead: metadata.gitHead }),
      ...(metadata.license === undefined ? {} : { license: metadata.license }),
    };
    identitiesChanged = true;
  }
  // Retrieve all changed releases before writing any synchronized metadata.
  if (identitiesChanged) writeFileSync(identitiesPath, `${JSON.stringify(identities, null, 2)}\n`);
  const stackPath = path.join(root, "config/stack.json");
  const stackSource = readFileSync(stackPath, "utf8");
  const stack: StackFile = JSON.parse(stackSource);
  let updatedStack = stackSource;
  for (const extension of stack.required) {
    const version = dependencies[extension.id];
    if (!version || !registryVersion.test(version)) continue;
    const spec = `${extension.id}@${version}`;
    if (extension.spec === spec) continue;
    updatedStack = updatedStack.replace(JSON.stringify(extension.spec), JSON.stringify(spec));
  }
  if (updatedStack !== stackSource) writeFileSync(stackPath, updatedStack);

  const noticesPath = path.join(root, "THIRD_PARTY.md");
  const notices = readFileSync(noticesPath, "utf8");
  const updated = notices.split("\n").map(line => {
    const name = /^\| \[([^\]]+)\]\(/.exec(line)?.[1];
    const version = name && dependencies[name];
    if (!version || !registryVersion.test(version)) return line;
    return line.replace(/(\]\([^)]+\) )(\d+\.\d+\.\d+)(?: \(`[^`]+`\))?/,
      (match, prefix: string, previous: string) => previous === version ? match : `${prefix}${version}`);
  }).join("\n");
  if (updated !== notices) writeFileSync(noticesPath, updated);
}

if (import.meta.main) updateDependencies(process.cwd());
