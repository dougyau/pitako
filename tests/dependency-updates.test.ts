import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

function withUpdater(check: (fixture: ReturnType<typeof updaterFixture>) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-dependency-update-"));
  try {
    check(updaterFixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function updaterFixture(root: string) {
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(root, "config"));
  mkdirSync(path.join(root, "docs"));
  const manifest = {
    dependencies: {
      alpha: "1.0.0", "@example/unchanged": "3.1.0", lsp: "github:example/lsp#fixed",
      typescript: "5.9.3", "typescript-language-server": "5.3.0",
    },
    devDependencies: { "@earendil-works/pi-coding-agent": "1.4.0" },
    peerDependencies: { "@earendil-works/pi-coding-agent": ">=1.4.0" },
  };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  const identities = {
    alpha: { version: "1.0.0", gitHead: "oldhash", license: "MIT" },
    "@example/unchanged": { version: "3.1.0", integrity: "unchanged-integrity" },
    lsp: { version: "0.2.0", revision: "fixed", repository: "https://example.com/lsp" },
    "@earendil-works/pi-coding-agent": { version: "1.4.0", integrity: "dev-integrity" },
  };
  writeFileSync(path.join(root, "docs/dependency-releases.json"), JSON.stringify(identities));
  writeFileSync(path.join(root, "config/stack.json"), JSON.stringify({
    required: [
      { id: "alpha", spec: "alpha@1.0.0", entry: "node_modules/alpha/index.js", tools: ["example"] },
      { id: "lsp", spec: manifest.dependencies.lsp, tools: [] },
      { id: "pitako-board", spec: "pitako", tools: [] },
    ],
  }));
  writeFileSync(path.join(root, "THIRD_PARTY.md"), [
    "| [alpha](https://example.com/alpha) 1.0.0 (`oldhash`) | MIT | Tools |",
    "| [@example/unchanged](https://example.com/stable) 3.1.0 (`validhash`) | MIT | Tools |",
    "| [lsp](https://example.com/lsp) | MIT | Tools |",
    "| [vendored](https://example.com/vendor) 1.0.0 | MIT | Skills |",
    "",
  ].join("\n"));
  // This double models Bun's file outputs, not npm resolution or installation.
  writeFileSync(path.join(bin, "bun"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync("calls.json", JSON.stringify(process.argv.slice(2)));
if (process.env.UPDATE_EXIT) process.exit(Number(process.env.UPDATE_EXIT));
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
manifest.dependencies.alpha = "2.0.0";
fs.writeFileSync("package.json", JSON.stringify(manifest));
fs.writeFileSync("bun.lock", "controlled regenerated lockfile\\n");
`);
  chmodSync(path.join(bin, "bun"), 0o755);
  writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync("metadata-calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.METADATA_EXIT) process.exit(Number(process.env.METADATA_EXIT));
console.log(JSON.stringify({
  name: "alpha", version: process.env.METADATA_VERSION || "2.0.0",
  dist: { tarball: "https://registry.npmjs.org/alpha/-/alpha-2.0.0.tgz", integrity: "sha512-controlled" },
  ...(process.env.OMIT_OPTIONAL ? {} : { gitHead: "newhash", license: "Apache-2.0" }),
}));
`);
  chmodSync(path.join(bin, "npm"), 0o755);
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const run = (env: Record<string, string> = {}) => spawnSync(process.execPath, [
    path.resolve("scripts/update-dependencies.ts"),
  ], {
    cwd: root, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...env },
    encoding: "utf8", timeout: 10000,
  });
  return { root, manifest, identities, read, run };
}

test("updates only npm runtime pins, synchronizes metadata, and repeats without metadata churn", () =>
  withUpdater(({ manifest, identities, read, run }) => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(read("calls.json"))).toEqual(["update", "--latest", "--exact", "alpha", "@example/unchanged"]);
    expect(JSON.parse(read("package.json"))).toEqual({
      ...manifest, dependencies: { ...manifest.dependencies, alpha: "2.0.0" },
    });
    expect(read("bun.lock")).toContain("regenerated lockfile");
    expect(JSON.parse(read("config/stack.json")).required).toEqual([
      { id: "alpha", spec: "alpha@2.0.0", entry: "node_modules/alpha/index.js", tools: ["example"] },
      { id: "lsp", spec: manifest.dependencies.lsp, tools: [] },
      { id: "pitako-board", spec: "pitako", tools: [] },
    ]);
    const notices = read("THIRD_PARTY.md"), stack = read("config/stack.json");
    expect(notices).toContain("[alpha](https://example.com/alpha) 2.0.0 | MIT");
    expect(notices).not.toContain("oldhash");
    expect(notices).toContain("3.1.0 (`validhash`)");
    expect(notices).toContain("[vendored](https://example.com/vendor) 1.0.0");
    const releases = read("docs/dependency-releases.json");
    expect(JSON.parse(releases)).toEqual({
      ...identities,
      alpha: {
        version: "2.0.0", registry: "https://registry.npmjs.org/alpha/2.0.0",
        tarball: "https://registry.npmjs.org/alpha/-/alpha-2.0.0.tgz",
        integrity: "sha512-controlled", gitHead: "newhash", license: "Apache-2.0",
      },
    });
    const metadataCalls = read("metadata-calls.jsonl");
    expect(JSON.parse(metadataCalls)).toEqual([
      "view", "alpha@2.0.0", "--json", "--registry=https://registry.npmjs.org",
    ]);
    const manifestSource = read("package.json"), lock = read("bun.lock");
    expect(run().status).toBe(0);
    expect(read("package.json")).toBe(manifestSource);
    expect(read("bun.lock")).toBe(lock);
    expect(read("THIRD_PARTY.md")).toBe(notices);
    expect(read("config/stack.json")).toBe(stack);
    expect(read("docs/dependency-releases.json")).toBe(releases);
    expect(read("metadata-calls.jsonl")).toBe(metadataCalls);
  }));

test("does not retain old optional release provenance when npm omits it", () =>
  withUpdater(({ read, run }) => {
    expect(run({ OMIT_OPTIONAL: "1" }).status).toBe(0);
    expect(JSON.parse(read("docs/dependency-releases.json")).alpha).toEqual({
      version: "2.0.0", registry: "https://registry.npmjs.org/alpha/2.0.0",
      tarball: "https://registry.npmjs.org/alpha/-/alpha-2.0.0.tgz",
      integrity: "sha512-controlled",
    });
  }));

test("fails without synchronizing metadata on registry failure or mismatched release", () => {
  const scenarios: Record<string, string>[] = [{ METADATA_EXIT: "19" }, { METADATA_VERSION: "9.0.0" }];
  for (const env of scenarios) {
    withUpdater(({ read, run }) => {
      const files = ["docs/dependency-releases.json", "config/stack.json", "THIRD_PARTY.md"];
      const before = files.map(read);
      const result = run(env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(env.METADATA_EXIT ? "19" : "Invalid npm release metadata");
      expect(files.map(read)).toEqual(before);
    });
  }
});

test("does not synchronize or report success when the package update fails", () =>
  withUpdater(({ read, run }) => {
    const files = ["package.json", "config/stack.json", "THIRD_PARTY.md", "docs/dependency-releases.json"];
    const before = files.map(read);
    const result = run({ UPDATE_EXIT: "19" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("19");
    expect(files.map(read)).toEqual(before);
  }));

interface WorkflowStep {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
}

test("publishes only a verified candidate, without executing dependencies with a write token", () => {
  const workflow = Bun.YAML.parse(readFileSync(".github/workflows/update-dependencies.yml", "utf8")) as {
    on: { schedule: { cron: string }[]; workflow_dispatch: null };
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, {
      needs?: string; permissions?: Record<string, string>; steps: WorkflowStep[];
    }>;
  };
  expect(workflow.on.schedule).toEqual([{ cron: "17 5 * * 1" }]);
  expect("workflow_dispatch" in workflow.on).toBe(true);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency).toEqual({ group: "update-dependencies", "cancel-in-progress": false });
  const verify = workflow.jobs.verify!, publish = workflow.jobs["pull-request"]!;
  expect(verify.permissions).toBeUndefined();
  expect(verify.steps.filter(step => step.run).map(step => step.run).slice(1, -1)).toEqual([
    "bun scripts/update-dependencies.ts", "bash scripts/setup.sh --skip-codegraph",
    "bun run typecheck", "bun run test", "git diff --check",
  ]);
  expect(verify.steps[0]!.with).toMatchObject({
    ref: "${{ github.event.repository.default_branch }}", "persist-credentials": false,
  });
  expect(publish.needs).toBe("verify");
  expect(publish.permissions).toEqual({ contents: "write", "pull-requests": "write" });
  expect(publish.steps.filter(step => step.run)).toHaveLength(2);
  expect(publish.steps[0]!.with?.ref).toBe("${{ needs.verify.outputs.base-sha }}");
  const artifact = verify.steps.at(-1)!.with!;
  expect(artifact.name).toBe(publish.steps[1]!.with!.name);
  const pr = publish.steps.find(step => step.id === "pr")!.with!;
  expect(pr["add-paths"]).toBe(artifact.path);
  expect(String(artifact.path).trim().split("\n")).toEqual([
    "package.json", "bun.lock", "config/stack.json", "THIRD_PARTY.md", "docs/dependency-releases.json",
  ]);
  expect(pr.branch).toBe("automation/update-dependencies");
  expect(pr.base).toBe("${{ github.event.repository.default_branch }}");
  const candidate = verify.steps.find(step => step.id === "candidate")!;
  expect(candidate.run).toContain("git write-tree");
  expect(candidate.run).toContain("git diff --exit-code");
  expect(candidate.run).toContain("THIRD_PARTY.md docs/dependency-releases.json");
  const downloadedCandidate = publish.steps[2]!;
  expect(downloadedCandidate.run).toContain('test "$(git write-tree)" = "$VERIFIED_TREE"');
  expect(downloadedCandidate.run).toContain("THIRD_PARTY.md docs/dependency-releases.json");
  const merge = publish.steps.at(-1)!;
  expect(merge.if).toBe("steps.pr.outputs.pull-request-number != '' && steps.pr.outputs.pull-request-operation != 'closed'");
  expect(merge.env).toMatchObject({
    HEAD_SHA: "${{ steps.pr.outputs.pull-request-head-sha }}",
    VERIFIED_TREE: "${{ needs.verify.outputs.candidate-tree }}",
  });
  expect(merge.run).toContain('--match-head-commit "$HEAD_SHA"');
  expect(merge.run).not.toContain("--admin");
  for (const step of verify.steps) expect(step["continue-on-error"]).not.toBe(true);
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps)
      if (step.uses) expect(step.uses).toMatch(/^[^@]+@[a-f0-9]{40}$/);

  const root = mkdtempSync(path.join(tmpdir(), "pitako-auto-merge-"));
  try {
    writeFileSync(path.join(root, "git"), `#!/usr/bin/env node
if (process.argv[2] === "write-tree") {
  if (process.env.TREE_EXIT) process.exit(Number(process.env.TREE_EXIT));
  console.log(process.env.DOWNLOADED_TREE);
}
`);
    chmodSync(path.join(root, "git"), 0o755);
    for (const scenario of [
      { DOWNLOADED_TREE: "verified-tree", TREE_EXIT: "", passes: true },
      { DOWNLOADED_TREE: "different-tree", TREE_EXIT: "", passes: false },
      { DOWNLOADED_TREE: "verified-tree", TREE_EXIT: "19", passes: false },
    ]) {
      const result = spawnSync("bash", ["-e", "-c", downloadedCandidate.run!], {
        cwd: root, encoding: "utf8", timeout: 10000,
        env: {
          ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`,
          VERIFIED_TREE: "verified-tree", DOWNLOADED_TREE: scenario.DOWNLOADED_TREE,
          TREE_EXIT: scenario.TREE_EXIT,
        },
      });
      expect(result.status === 0).toBe(scenario.passes);
    }
    writeFileSync(path.join(root, "gh"), `#!/usr/bin/env node
const fs = require("node:fs"), args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
if (args[0] === "api") {
  if (process.env.API_EXIT) process.exit(Number(process.env.API_EXIT));
  console.log(process.env.REMOTE_TREE);
} else if (process.env.MERGE_EXIT) process.exit(Number(process.env.MERGE_EXIT));
`);
    chmodSync(path.join(root, "gh"), 0o755);
    for (const scenario of [
      { REMOTE_TREE: "verified-tree", API_EXIT: "", MERGE_EXIT: "", merges: true, passes: true },
      { REMOTE_TREE: "different-tree", API_EXIT: "", MERGE_EXIT: "", merges: false, passes: false },
      { REMOTE_TREE: "verified-tree", API_EXIT: "19", MERGE_EXIT: "", merges: false, passes: false },
      { REMOTE_TREE: "verified-tree", API_EXIT: "", MERGE_EXIT: "19", merges: true, passes: false },
    ]) {
      writeFileSync(path.join(root, "calls.jsonl"), "");
      const result = spawnSync("bash", ["-e", "-c", merge.run!], {
        cwd: root, encoding: "utf8", timeout: 10000,
        env: {
          ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`,
          GH_REPO: "example/pitako", GH_TOKEN: "controlled", PR_NUMBER: "42",
          HEAD_SHA: "verified-head", VERIFIED_TREE: "verified-tree",
          REMOTE_TREE: scenario.REMOTE_TREE, API_EXIT: scenario.API_EXIT, MERGE_EXIT: scenario.MERGE_EXIT,
        },
      });
      expect(result.status === 0).toBe(scenario.passes);
      const calls = readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(calls[0]).toEqual(["api", "repos/example/pitako/git/commits/verified-head", "--jq", ".tree.sha"]);
      expect(calls.slice(1)).toEqual(scenario.merges
        ? [["pr", "merge", "42", "--auto", "--squash", "--match-head-commit", "verified-head"]]
        : []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
