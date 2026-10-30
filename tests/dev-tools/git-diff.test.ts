import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGitTools } from "../../extensions/dev-tools/git/index.ts";
import { createMockPi } from "./support.ts";

test("git_diff exposes patches in structured results for working, staged and base comparisons", async () => {
	const root = mkdtempSync(join(tmpdir(), "pitako-git-diff-"));
	const git = (...args: string[]) => execFileSync("git", args, {
		cwd: root, encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	});
	try {
		git("init", "-q", "-b", "main");
		writeFileSync(join(root, "tracked file.txt"), "first\nshared\n");
		writeFileSync(join(root, "unrelated.txt"), "other\n");
		git("add", ".");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
			"-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Initial");
		const mock = createMockPi();
		registerGitTools(mock.pi);
		const clean = await mock.call("git_diff", {}, root);
		expect(clean.isError).toBe(false);
		expect(clean.structuredContent).toEqual({ changed: false, stat: "", diff: "", truncated: false });

		writeFileSync(join(root, "tracked file.txt"), "staged\nshared\n");
		git("add", "tracked file.txt");
		writeFileSync(join(root, "tracked file.txt"), "working\nshared\n");
		writeFileSync(join(root, "unrelated.txt"), "unrelated change\n");
		const paths = ["tracked file.txt"];
		for (const [options, removed, added] of [
			[{}, "staged", "working"],
			[{ staged: true }, "first", "staged"],
			[{ base: "HEAD" }, "first", "working"],
		] as const) {
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
		const invalid = await mock.call("git_diff", { base: "does-not-exist" }, root);
		expect(invalid.isError).toBe(true);
		expect(invalid.structuredContent).toMatchObject({ error: expect.stringContaining("unknown revision") });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("git_diff retains the bounded patch and spill path in structured results", async () => {
	const root = mkdtempSync(join(tmpdir(), "pitako-git-diff-large-"));
	let spillPath: string | undefined;
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, "large.txt"), "original\n");
		execFileSync("git", ["add", "large.txt"], { cwd: root });
		writeFileSync(join(root, "large.txt"), Array.from({ length: 2400 }, (_, i) => `new-line-${i}\n`).join(""));
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
		if (spillPath) rmSync(spillPath, { force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
