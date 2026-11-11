import { expect, test } from "bun:test";
import { gitFakeFixture } from "../fixtures/git-fake-fixture.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGitTools } from "../../extensions/dev-tools/git/index.ts";
import { createMockPi } from "./support.ts";

test("git_diff exposes patches in structured results for working, staged and base comparisons", async () => {
	const root = mkdtempSync(join(tmpdir(), "pitako-git-diff-"));
	const fake = gitFakeFixture();
	const set = (args: string[], stdout: string, status = 0, stderr = "") => fake.set(root, ["--no-pager", "--literal-pathspecs", ...args], { stdout, stderr, status });
	try {
		fake.fakeRepo(root);
		set(["diff", "--no-color", "--no-ext-diff", "--stat=100"], "");
		const mock = createMockPi();
		registerGitTools(mock.pi);
		const clean = await mock.call("git_diff", {}, root);
		expect(clean.isError).toBe(false);
		expect(clean.structuredContent).toEqual({ changed: false, stat: "", diff: "", truncated: false });


		const paths = ["tracked file.txt"];
		for (const [options, removed, added] of [
			[{}, "staged", "working"],
			[{ staged: true }, "first", "staged"],
			[{ base: "HEAD" }, "first", "working"],
		] as const) {
			const common = ["diff", "--no-color", "--no-ext-diff", ...("staged" in options ? ["--cached"] : [])];
			const tail = [...("base" in options ? ["--end-of-options", "HEAD"] : []), "--", ...paths];
			set([...common, "--stat=100", ...tail], " tracked file.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
			set([...common, "-U0", ...tail], `diff --git a/tracked file.txt b/tracked file.txt\n--- a/tracked file.txt\n+++ b/tracked file.txt\n@@ -1 +1 @@\n-${removed}\n+${added}\n`);
			const result = await mock.call("git_diff", { ...options, paths, context: 0 }, root);
			expect(result.isError).toBe(false);
			expect(structuredClone(result.structuredContent)).toMatchObject({
				changed: true, truncated: false,
				stat: expect.stringContaining("tracked file.txt"),
				diff: expect.stringContaining(`-${removed}\n+${added}\n`),
			});
			expect(result.structuredContent).toHaveProperty("diff", expect.not.stringContaining("unrelated.txt"));
			expect(result.structuredContent).toHaveProperty("diff", expect.not.stringContaining("\n shared"));
			expect(mock.text(result)).toContain(`-${removed}\n+${added}\n`);
		}
		const statOnly = await mock.call("git_diff", { paths, stat: true }, root);
		expect(statOnly.isError).toBe(false);
		expect(statOnly.structuredContent).toMatchObject({
			changed: true, diff: "", truncated: false, stat: mock.text(statOnly),
		});
		set(["diff", "--no-color", "--no-ext-diff", "--stat=100", "--end-of-options", "does-not-exist"], "", 128, "fatal: unknown revision does-not-exist");
		const invalid = await mock.call("git_diff", { base: "does-not-exist" }, root);
		expect(invalid.isError).toBe(true);
		expect(invalid.structuredContent).toMatchObject({ error: expect.stringContaining("unknown revision") });
	} finally {
		try { fake.dispose(); } finally { rmSync(root, { recursive: true, force: true }); }
	}
});

test("git_diff retains the bounded patch and spill path in structured results", async () => {
	const root = mkdtempSync(join(tmpdir(), "pitako-git-diff-large-"));
	let spillPath: string | undefined;
	const fake = gitFakeFixture();
	try {
		fake.fakeRepo(root);
		fake.set(root, ["--no-pager", "--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--stat=100"], { stdout: " large.txt | 2401 +++-\n", stderr: "", status: 0 });
		fake.set(root, ["--no-pager", "--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "-U3"], { stdout: "diff --git a/large.txt b/large.txt\n--- a/large.txt\n+++ b/large.txt\n@@ -1 +1,2400 @@\n-original\n" + Array.from({ length: 2400 }, (_, i) => `+new-line-${i}\n`).join(""), stderr: "", status: 0 });
		const mock = createMockPi();
		registerGitTools(mock.pi);
		const result = await mock.call("git_diff", {}, root);
		const data = result.structuredContent;
		if (!data || typeof data !== "object" || !("fullOutputPath" in data) || typeof data.fullOutputPath !== "string")
			throw new Error("Missing structured spill path");
		spillPath = data.fullOutputPath;
		expect(result.isError).toBe(false);
		expect(structuredClone(result.structuredContent)).toMatchObject({
			changed: true, truncated: true,
			diff: expect.stringContaining("+new-line-0"),
			fullOutputPath: expect.any(String),
		});
		expect(result.structuredContent).toHaveProperty("diff", expect.not.stringContaining("+new-line-2399"));
		expect(readFileSync(spillPath, "utf8")).toContain("+new-line-2399");
		expect(mock.text(result)).toContain(spillPath);
	} finally {
		try { fake.dispose(); } finally {
			if (spillPath) rmSync(spillPath, { force: true });
			rmSync(root, { recursive: true, force: true });
		}
	}
});
