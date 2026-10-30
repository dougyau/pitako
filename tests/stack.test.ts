import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { PitakoConfigError } from "../extensions/errors.ts";
import { commandOnPath, packageRoot, prepareRuntime, readStack } from "../extensions/stack.ts";

const roots: string[] = [];
const requiredBins = ["typescript-language-server", "pyright-langserver", "intelephense", "codegraph", "ast-grep"];
function fixtureRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function runtimeRoot(): string {
  const root = fixtureRoot("pitako-runtime-");
  mkdirSync(path.join(root, "config"), { recursive: true });
  const stack = readStack(packageRoot());
  writeFileSync(path.join(root, "config", "stack.json"), JSON.stringify(stack));
  for (const extension of stack.required) {
    const entry = path.join(root, extension.entry);
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "export {};\n");
  }
  return root;
}
function addBin(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, process.platform === "win32" ? `${name}.cmd` : name), "");
}
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("stack configuration", () => {
  test("selected release identities match every declared and installed direct dependency", () => {
    const root = packageRoot();
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const identities = JSON.parse(readFileSync(path.join(root, "docs/dependency-releases.json"), "utf8"));
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(identities).sort()).toEqual(Object.keys(dependencies).sort());
    for (const [name, spec] of Object.entries(dependencies)) {
      const identity = identities[name];
      expect(spec).toBe(name === "pi-lsp-client"
        ? `github:code-yeongyu/pi-lsp-client#${identity.revision}`
        : name === "typescript-compiler" ? `npm:typescript@${identity.version}` : identity.version);
      expect(JSON.parse(readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version)
        .toBe(identity.version);
    }
    expect(manifest.engines).toEqual({ node: ">=22.19.0", bun: ">1.4.2" });
    expect(manifest.scripts.typecheck).toBe("node node_modules/typescript-compiler/bin/tsc --noEmit");
    expect(manifest.devDependencies["typescript-compiler"]).toBe("npm:typescript@7.0.2");
    expect(existsSync(path.join(root, "node_modules/typescript/lib/tsserver.js"))).toBe(true);
    for (const name of ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"]) {
      expect(manifest.devDependencies[`@earendil-works/${name}`]).toBe("1.4.0");
      expect(manifest.peerDependencies[`@earendil-works/${name}`]).toBe(">=1.4.0");
    }
  });

  test("package manifest entries match config/stack.json and stay relative", () => {
    const root = packageRoot();
    const stack = readStack(root);
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      pi: { extensions: string[]; skills: string[] };
      dependencies: Record<string, string>;
      bundledDependencies: string[];
      trustedDependencies: string[];
    };
    const expected = [
      `./${stack.pitakoExtension}`,
      ...stack.required.map((extension) => `./${extension.entry}`),
    ];
    expect(manifest.pi.extensions).toEqual(expected);
    const rooted = (name: string) => `${path.sep}${name}${path.sep}`;
    for (const entry of manifest.pi.extensions) {
      expect(path.isAbsolute(entry)).toBe(false);
      expect(entry.includes(rooted("home"))).toBe(false);
      expect(entry.includes(rooted("Users"))).toBe(false);
    }
    const lsp = stack.required.find(({ id }) => id === "pi-lsp-client");
    if (!lsp) throw new Error("pi-lsp-client is missing from the required stack");
    expect(manifest.dependencies["pi-lsp-client"]).toBe(lsp.spec);
    expect(Object.keys(manifest.dependencies)).toEqual(expect.arrayContaining([
      "@ast-grep/cli", "@colbymchenry/codegraph", "@vndv/pi-codegraph", "@dietrichgebert/ponytail",
      "@juicesharp/rpiv-todo", "billion-context-pi", "pi-codex-tools",
      "pi-hermes-memory", "pi-lsp-client", "pi-subagents", "pi-web-access", "smol-toml",
      "typescript", "typescript-language-server", "pyright", "intelephense",
    ]));
    expect(lsp.bins).toEqual(["typescript-language-server", "pyright-langserver", "intelephense"]);
    expect(stack.required.flatMap(({ bins }) => bins ?? [])).toEqual(requiredBins);
    for (const bin of requiredBins)
      expect(commandOnPath(bin, path.join(root, "node_modules", ".bin"))).toBe(true);
    expect(manifest.dependencies["rust-analyzer"]).toBeUndefined();
    expect(manifest.bundledDependencies).not.toContain("intelephense");
    for (const [id, version] of Object.entries(manifest.dependencies)) {
      if (id !== "pi-lsp-client") expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    for (const extension of stack.required) {
      const version = manifest.dependencies[extension.id];
      if (version && extension.id !== "pi-lsp-client")
        expect(extension.spec).toBe(`${extension.id}@${version}`);
    }
    expect(stack.required.find(({ id }) => id === "@vndv/pi-codegraph")).toMatchObject({
      entry: "node_modules/@vndv/pi-codegraph/extensions/codegraph.ts",
      bins: ["codegraph"],
    });
    expect(stack.required.some(({ id }) => id === "pitako-code-intelligence")).toBe(false);
    expect(manifest.pi.extensions.some((entry) => entry.includes("extensions/code-intelligence/"))).toBe(false);
    expect(manifest.dependencies["@ast-grep/napi"]).toBeUndefined();
    expect(manifest.bundledDependencies).not.toContain("@ast-grep/napi");
    expect(manifest.dependencies["@nicknisi/pi-ast-grep"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.bundledDependencies).toContain("@nicknisi/pi-ast-grep");
    expect(manifest.bundledDependencies).toContain("@ast-grep/cli");
    expect(manifest.trustedDependencies).toContain("@ast-grep/cli");
    expect(stack.required.find(({ id }) => id === "@nicknisi/pi-ast-grep")).toEqual({
      id: "@nicknisi/pi-ast-grep", spec: `@nicknisi/pi-ast-grep@${manifest.dependencies["@nicknisi/pi-ast-grep"]}`,
      entry: "node_modules/@nicknisi/pi-ast-grep/index.ts",
      bins: ["ast-grep"],
      tools: ["ast_search", "ast_rewrite"],
    });
    for (const name of ["@nredd/pi-dev-tools", "@nredd/pi-resource-sampler"]) {
      expect(manifest.dependencies[name]).toBeUndefined();
      expect(manifest.bundledDependencies).not.toContain(name);
      expect(manifest.pi.extensions.some(entry => entry.includes(name))).toBe(false);
    }
    expect(stack.required.find(({ id }) => id === "pitako-dev-tools")).toEqual({
      id: "pitako-dev-tools", spec: "pitako",
      entry: "extensions/dev-tools/index.ts",
      tools: [
        "git_worktree_list", "git_worktree_add", "git_worktree_remove", "git_worktree_prune",
        "git_status", "git_diff", "git_log", "git_show", "git_commit",
        "ssh_exec", "ssh_pull", "ssh_push",
        "py_lint", "py_format", "py_typecheck", "py_test", "py_uv",
        "cargo_check", "cargo_clippy", "cargo_fmt", "cargo_test", "cargo_build",
        "cargo_run", "cargo_doc", "cargo_bench", "cargo_add", "resource_snapshot",
      ],
    });
    expect(stack.required.find(({ id }) => id === "@juicesharp/rpiv-todo")).toEqual({
      id: "@juicesharp/rpiv-todo", spec: `@juicesharp/rpiv-todo@${manifest.dependencies["@juicesharp/rpiv-todo"]}`,
      entry: "extensions/todo.ts", tools: ["todo"],
    });
    expect(stack.required.find(({ id }) => id === "pitako-file-sha256")).toEqual({
      id: "pitako-file-sha256", spec: "pitako", entry: "extensions/file-sha256.ts",
      tools: ["file_sha256", "file_sha256_save"],
    });
    expect(manifest.bundledDependencies).toContain("pi-hermes-memory");
    expect(manifest.bundledDependencies).toContain("billion-context-pi");
    expect(stack.required.find(({ id }) => id === "billion-context-pi")).toEqual({
      id: "billion-context-pi", spec: `billion-context-pi@${manifest.dependencies["billion-context-pi"]}`, entry: "extensions/acp.ts",
      tools: ["compress", "search_context", "decompress", "acp_status", "acp_cache"],
    });
    expect(stack.required.findIndex(({ id }) => id === "billion-context-pi")).toBeLessThan(stack.required.findIndex(({ id }) => id === "pi-hermes-memory"));
    expect(stack.required.find(({ id }) => id === "pi-hermes-memory")).toEqual({
      id: "pi-hermes-memory",
      spec: `pi-hermes-memory@${manifest.dependencies["pi-hermes-memory"]}`,
      entry: "node_modules/pi-hermes-memory/src/index.ts",
      tools: ["memory_add", "memory_replace", "memory_remove", "memory_search", "session_search", "skill_manage"],
    });
    expect(manifest.bundledDependencies).toContain("pi-web-access");
    for (const extension of [
      { id: "pi-markdown-preview", tools: ["preview_export"] },
      { id: "@juicesharp/rpiv-ask-user-question", tools: ["ask_user_question"] },
    ]) {
      const version = manifest.dependencies[extension.id];
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest.bundledDependencies).toContain(extension.id);
      expect(stack.required.find(({ id }) => id === extension.id)).toEqual({
        id: extension.id, spec: `${extension.id}@${version}`,
        entry: `node_modules/${extension.id}/index.ts`, tools: extension.tools,
      });
      expect(manifest.pi.extensions.filter(entry => entry === `./node_modules/${extension.id}/index.ts`)).toHaveLength(1);
      expect(existsSync(path.join(root, "node_modules", extension.id, "index.ts"))).toBe(true);
    }
    expect(stack.required.find(({ id }) => id === "pi-web-access")).toEqual({
      id: "pi-web-access",
      spec: `pi-web-access@${manifest.dependencies["pi-web-access"]}`,
      entry: "node_modules/pi-web-access/dist/index.js",
      tools: ["web_search", "fetch_content", "source_check", "get_search_content", "web_enable"],
    });
    expect(stack.required.find(({ id }) => id === "pi-codex-tools")).toEqual({
      id: "pi-codex-tools", spec: `pi-codex-tools@${manifest.dependencies["pi-codex-tools"]}`,
      entry: "node_modules/pi-codex-tools/index.ts", tools: ["apply_patch"],
    });
    expect(manifest.bundledDependencies).toContain("pi-codex-tools");
    expect(manifest.pi.skills).toContain("./node_modules/@dietrichgebert/ponytail/skills/ponytail");
    expect(manifest.pi.skills).not.toContain("./skills");
    expect(stack.optional).toEqual([]);
  });

  test("missing extension entry explains how to fix the install", () => {
    const root = fixtureRoot("pitako-missing-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    const stack = readStack(packageRoot());
    writeFileSync(path.join(root, "config", "stack.json"), JSON.stringify(stack));
    expect(() => prepareRuntime(root, { PATH: "" })).toThrow(PitakoConfigError);
    try {
      prepareRuntime(root, { PATH: "" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Required extension "pi-codex-tools"');
      expect(message).toContain("bun install");
      const homePrefix = ["", "home", ""].join("/");
      expect(message.includes(homePrefix)).toBe(false);
    }
  });

  test("missing pi-web-access entry explains how to fix the install", () => {
    const root = fixtureRoot("pitako-missing-web-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    const stack = readStack(packageRoot());
    writeFileSync(path.join(root, "config", "stack.json"), JSON.stringify(stack));
    for (const extension of stack.required.filter(({ id }) => id !== "pi-web-access")) {
      const entry = path.join(root, extension.entry);
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, "export {};\n");
    }
    expect(() => prepareRuntime(root, { PATH: "" })).toThrow(PitakoConfigError);
    try {
      prepareRuntime(root, { PATH: "" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Required extension "pi-web-access"');
      expect(message).toContain("node_modules/pi-web-access/dist/index.js");
      expect(message).toContain("bun install");
    }
  });

  test("required CLIs on PATH are accepted without bundled binaries", () => {
    const root = runtimeRoot();
    const binDir = fixtureRoot("pitako-path-");
    for (const bin of requiredBins) addBin(binDir, bin);
    const env = { PATH: binDir };
    const prepared = prepareRuntime(root, env);
    expect(prepared.codegraph).toBe("path");
    for (const bin of requiredBins) expect(commandOnPath(bin, env.PATH)).toBe(true);
    expect(env.PATH).toBe(binDir);
  });

  test.each(requiredBins)("installed %s fills a missing PATH entry", (bin) => {
    const root = runtimeRoot();
    const binDir = fixtureRoot("pitako-path-");
    for (const other of requiredBins.filter(name => name !== bin)) addBin(binDir, other);
    const bundledBinDir = path.join(root, "node_modules", ".bin");
    addBin(bundledBinDir, bin);
    const env = { PATH: binDir };
    prepareRuntime(root, env);
    expect(env.PATH).toBe([bundledBinDir, binDir].join(path.delimiter));
    for (const name of requiredBins) expect(commandOnPath(name, env.PATH)).toBe(true);
    prepareRuntime(root, env);
    expect(env.PATH).toBe([bundledBinDir, binDir].join(path.delimiter));
  });

  test("all installed CLIs need only one PATH entry", () => {
    const root = runtimeRoot();
    const bundledBinDir = path.join(root, "node_modules", ".bin");
    for (const bin of requiredBins) addBin(bundledBinDir, bin);
    const env = { PATH: "" };
    expect(prepareRuntime(root, env).codegraph).toBe("bundled");
    expect(env.PATH).toBe(bundledBinDir);
  });

  test("installed ast-grep runs outside the package without fallback diagnostics", async () => {
    const root = fixtureRoot("pitako-ast-cli-");
    writeFileSync(path.join(root, "sample.ts"), "console.log(42);\n");
    const env = { ...process.env };
    prepareRuntime(packageRoot(), env);
    const cli = path.join(packageRoot(), "node_modules", ".bin",
      process.platform === "win32" ? "ast-grep.cmd" : "ast-grep");
    const child = Bun.spawn([cli, "run", "--pattern=absentFunction()", "sample.ts"], {
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test.each(requiredBins)("missing %s explains how to fix the install", (bin) => {
    const root = runtimeRoot();
    const binDir = fixtureRoot("pitako-path-");
    for (const other of requiredBins.filter(name => name !== bin)) addBin(binDir, other);
    const env = { PATH: binDir };
    expect(() => prepareRuntime(root, env)).toThrow(`required program "${bin}"`);
    expect(() => prepareRuntime(root, env)).toThrow(`node_modules/.bin/${bin}`);
    expect(() => prepareRuntime(root, env)).toThrow("bun install");
    expect(env.PATH).toBe(binDir);
  });
});
