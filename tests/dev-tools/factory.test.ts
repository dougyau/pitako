import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import defaultFactory, { createDevTools, type DevToolsOptions } from "../../extensions/dev-tools/index.ts";
import { createMockPi } from "./support.ts";

test("both factories register all groups, schemas and hooks; options reach controlled commands", async () => {
	const root = mkdtempSync(join(tmpdir(), "pitako-dev-factory-"));
	try {
		const uv = join(root, "uv"), cargo = join(root, "cargo"), rustup = join(root, "rustup");
		for (const bin of [uv, cargo, rustup]) {
			writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\n');
			chmodSync(bin, 0o755);
		}
		const ssh = join(root, "ssh"), scp = join(root, "scp");
		for (const [name, bin] of [["fake-ssh", ssh], ["fake-scp", scp]]) {
			copyFileSync(join(import.meta.dirname, "fixtures/ssh", name!), bin!);
			chmodSync(bin!, 0o755);
		}
		writeFileSync(join(root, "pyproject.toml"), "[project]\nname='fixture'\nversion='0.0.0'\n");
		writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
		const options: DevToolsOptions = {
			ssh: { knownHosts: () => new Set(["fixture"]), sshBin: ssh, scpBin: scp },
			py: { uvBin: uv },
			cargo: { cargoBin: cargo, rustupBin: rustup },
			resource: { createSampler: () => { throw Error("owned initialization seam"); } },
		};
		const mock = createMockPi();
		createDevTools(options)(mock.pi);
		const defaults = createMockPi();
		defaultFactory(defaults.pi);
		expect([...defaults.tools.keys()]).toEqual([...mock.tools.keys()]);
		expect([...mock.tools.keys()].sort()).toEqual([
			"git_status", "git_diff", "git_log", "git_show", "git_commit",
			"git_worktree_list", "git_worktree_add", "git_worktree_remove", "git_worktree_prune",
			"ssh_exec", "ssh_pull", "ssh_push",
			"py_lint", "py_format", "py_typecheck", "py_test", "py_uv",
			"cargo_check", "cargo_clippy", "cargo_fmt", "cargo_test", "cargo_build", "cargo_run",
			"cargo_doc", "cargo_bench", "cargo_add", "resource_snapshot",
		].sort());
		for (const tool of mock.tools.values()) {
			expect(tool.parameters).toBeDefined();
			expect(tool.outputSchema).toBeDefined();
			expect(tool.annotations?.readOnlyHint).toBeBoolean();
		}
		expect(mock.hooks.get("tool_call")).toHaveLength(1);
		expect(mock.hooks.get("before_agent_start")).toHaveLength(1);
		expect(mock.toolCall("bash", { command: "git push --force" })).toBeDefined();
		const hook = mock.hooks.get("before_agent_start")![0]!;
		expect(await hook({ systemPrompt: "original" }, {})).toMatchObject({
			systemPrompt: expect.stringContaining("original"),
		});
		expect((await mock.call("ssh_exec", { host: "fixture", command: "exit 7" }, root)).structuredContent)
			.toMatchObject({ state: "command-failed", remoteExit: 7 });
		expect((await mock.call("ssh_exec", { host: "not-known", command: "exit 0" }, root)).isError).toBe(true);
		writeFileSync(join(root, "source"), "payload");
		expect((await mock.call("ssh_pull", { host: "fixture", remote_path: join(root, "source"), local_path: "copy" }, root)).isError).toBe(false);
		expect(readFileSync(join(root, "copy"), "utf8")).toBe("payload");
		expect((await mock.call("py_lint", {}, root)).structuredContent).toMatchObject({ state: "clean" });
		expect(readFileSync(`${uv}.args`, "utf8").split("\n")).toContain("--frozen");
		expect((await mock.call("cargo_check", {}, root)).structuredContent).toMatchObject({ state: "clean" });
		expect(readFileSync(`${cargo}.args`, "utf8").split("\n")).toEqual([
			"check", "--message-format=json-diagnostic-short", "--all-features", "--all-targets", "",
		]);
		await mock.call("cargo_check", { toolchain: "stable", all_features: false, all_targets: false }, root);
		expect(readFileSync(`${rustup}.args`, "utf8").split("\n")).toEqual([
			"run", "stable", "cargo", "check", "--message-format=json-diagnostic-short", "",
		]);
		const outcome = mock.call("resource_snapshot", {}, root).then(() => undefined, error => error);
		expect(await outcome).toHaveProperty("message", "owned initialization seam");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
