import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../scripts/verification-recipe-v1.js", import.meta.url), "utf8");
type BashResult = { output: string; truncated: boolean; exit_code: number };
type Invocation = { command: string; timeout?: number };
type Selection = { kind: "full" } | { kind: "gate"; gate: string } | { kind: "focused"; files: string[] };
type RunResult = {
  status: string;
  results: Array<{ command: string; status: string; exitCode?: number; log?: string }>;
  unrun: string[];
};
function recipe(bash: (args: Invocation) => Promise<unknown>) {
  return new Function("tools", `return ${source}`)({ bash }) as {
    version: number;
    run(args: { root: string; evidenceDir: string; selection: Selection }): Promise<RunResult>;
  };
}
const args = { root: "/owned/project", evidenceDir: "/owned/evidence", selection: { kind: "full" } as Selection };
const terminal = (code: number): BashResult => ({
  output: `PITAKO_RECIPE_START\t/owned/evidence/recipe-v1.probe\nPITAKO_RECIPE_EXIT\t/owned/evidence/recipe-v1.probe\t${code}\n`,
  truncated: false, exit_code: code,
});

describe("verification recipe v1", () => {
  test("fixed full order, no routine timeout, raw capture and preserved command exit", async () => {
    const calls: Invocation[] = [];
    const helper = recipe(async call => { calls.push(call); return terminal(0); });
    expect(helper.version).toBe(1);
    const result = await helper.run(args);
    expect(result.status).toBe("passed");
    expect(result.results.map(result => result.command)).toEqual([
      "bun run typecheck", "bun run test", "bun run test:code-intelligence-node",
    ]);
    expect(result.unrun).toEqual([]);
    for (const call of calls) {
      expect(Object.keys(call)).toEqual(["command"]);
      expect(call.command).toContain('tee "$dir/raw.log"');
      expect(call.command).toContain('code=${codes[0]}');
      expect(call.command).toContain('exit "$code"');
    }
  });

  test("stops at nonzero and names remaining obligations", async () => {
    let calls = 0;
    const result = await recipe(async () => terminal(++calls === 1 ? 0 : 7)).run(args);
    expect(calls).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.results[1]?.exitCode).toBe(7);
    expect(result.unrun).toEqual(["bun run test:code-intelligence-node"]);
  });

  test("malformed, truncated, missing terminal, capture failure and tool errors cannot pass", async () => {
    for (const observed of [undefined, "success", {}, { ...terminal(0), truncated: true },
      { ...terminal(0), exit_code: 9 }, { ...terminal(0), output: "echo success\n" },
      { ...terminal(0), exit_code: 125, output: "PITAKO_RECIPE_START\t/owned/evidence/recipe-v1.probe\n" }]) {
      let calls = 0;
      const result = await recipe(async () => { calls++; return observed; }).run(args);
      expect(result.status).toBe("incomplete");
      expect(calls).toBe(1);
      expect(result.unrun).toHaveLength(2);
    }
    const result = await recipe(async () => { throw Error("bounded timeout/tool error"); }).run(args);
    expect(result.status).toBe("incomplete");
    expect(result.unrun).toHaveLength(2);
  });

  test("quotes external paths and focused files; restricts real paths to project tests", async () => {
    let command = "";
    await recipe(async call => { command = call.command; return terminal(0); }).run({
      root: "/owned/proj'ect", evidenceDir: "/owned/evidence",
      selection: { kind: "focused", files: ["tests/a 'quoted'.test.ts", "tests/nested/b.test.ts"] },
    });
    expect(command).toContain("cd -- '/owned/proj'\\''ect'");
    expect(command).toContain("bun test './tests/a '\\''quoted'\\''.test.ts' './tests/nested/b.test.ts'");
    expect(command).toContain('case "$target" in "$scope/"*)');
    expect(command).toContain('case "$scope/" in "$project/"*)');
  });

  test("only admits explicit tests-scope files and fixed gate selections", async () => {
    let calls = 0;
    const helper = recipe(async () => { calls++; return terminal(0); });
    const invalid = [
      { kind: "full", command: "echo hacked" }, { kind: "gate", gate: "__proto__" },
      { kind: "gate", gate: "typecheck", flags: ["--help"] },
      { kind: "focused", files: [] }, { kind: "focused", files: ["tests/../evil.test.ts"] },
      { kind: "focused", files: ["src/x.test.ts"] }, { kind: "focused", files: ["tests/x.test.ts", "tests/x.test.ts"] },
      { kind: "focused", files: ["tests/x.test.ts\npwd"] },
    ];
    for (const selection of invalid) await expect(helper.run({ ...args, selection: selection as Selection })).rejects.toThrow("Invalid selection");
    for (const root of ["relative", "/owned/../other", "/owned\npwd"]) {
      await expect(helper.run({ ...args, root })).rejects.toThrow("absolute safe paths");
    }
    expect(calls).toBe(0);
    for (const gate of ["typecheck", "bun", "code-intelligence-node"]) {
      expect((await helper.run({ ...args, selection: { kind: "gate", gate } })).status).toBe("passed");
    }
  });
});
