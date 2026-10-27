// Adapted from nredd/pi-harness packages/dev-tools/test/scenarios/git.test.ts and
// test/git/commit-message.test.ts; MIT (Redd). See docs/provenance.json.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGitTools } from "../../extensions/dev-tools/git/index.ts";
import { buildCommitMessage, validateSubject } from "../../extensions/dev-tools/git/commit-message.ts";
import { createMockPi } from "./support.ts";

test("stored Git messages preserve user text, human identity, hooks, named paths and push policy", async () => {
	const root = mkdtempSync(join(tmpdir(), "pitako-owned-git-"));
	const repo = join(root, "repo"), remote = join(root, "remote.git");
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
		cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	});
	try {
		git(root, "init", "--bare", "-q", "-b", "main", remote);
		git(root, "clone", "-q", remote, repo);
		for (const [key, value] of [["user.name", "Human Fixture"], ["user.email", "human@example.invalid"], ["commit.gpgsign", "false"]])
			git(repo, "config", key!, value!);
		writeFileSync(join(repo, "owned"), "initial\n");
		git(repo, "add", "owned"); git(repo, "commit", "-qm", "Initial");
		git(repo, "push", "-qu", "origin", "main");
		git(repo, "checkout", "-qb", "feature");
		const initial = git(remote, "rev-parse", "main").trim();
		writeFileSync(join(repo, "owned"), "changed\n");
		writeFileSync(join(repo, "unrelated"), "keep staged\n");
		git(repo, "add", "unrelated");
		const hooks = join(root, "hooks"); mkdirSync(hooks);
		git(repo, "config", "core.hooksPath", hooks);
		const hook = join(hooks, "pre-commit");
		writeFileSync(hook, "#!/bin/sh\nprintf ran > hook-ran\nexit 1\n"); chmodSync(hook, 0o755);
		const mock = createMockPi(); registerGitTools(mock.pi);
		const call = (args: object) => mock.call("git_commit", { subject: "Preserve messages", paths: ["owned"], push: false, ...args }, repo);
		expect((await call({ subject: "feat: bad" })).isError).toBe(true);
		expect((await call({ paths: ["."] })).isError).toBe(true);
		expect((await call({})).isError).toBe(true);
		expect(readFileSync(join(repo, "hook-ran"), "utf8")).toBe("ran");
		expect(git(repo, "rev-parse", "HEAD").trim()).toBe(initial);
		writeFileSync(hook, "#!/bin/sh\nprintf ran > hook-ran\n");
		// Signing stays under the user's Git configuration. A failing controlled signer must
		// prevent a commit, not be bypassed by the tool. This does not certify a GPG installation.
		const signer = join(root, "signer");
		writeFileSync(signer, `#!/bin/sh\nprintf ran > '${join(root, "signer-ran")}'\nexit 1\n`);
		chmodSync(signer, 0o755);
		git(repo, "config", "gpg.program", signer);
		git(repo, "config", "gpg.format", "openpgp");
		git(repo, "config", "commit.gpgsign", "true");
		expect((await call({})).isError).toBe(true);
		expect(readFileSync(join(root, "signer-ran"), "utf8")).toBe("ran");
		expect(git(repo, "rev-parse", "HEAD").trim()).toBe(initial);
		git(repo, "config", "commit.gpgsign", "false");
		const result = await call({ why: "Keep explicit text.", changes: ["Only the named file"] });
		expect(result.isError).toBe(false);
		expect(result.structuredContent).toMatchObject({ stage: "done", pushed: false, signed: false });
		expect(git(repo, "log", "-1", "--format=%B").trim()).toBe("Preserve messages\n\nKeep explicit text.\n\nChanges:\n- Only the named file");
		expect(git(repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>").trim())
			.toBe("Human Fixture <human@example.invalid>|Human Fixture <human@example.invalid>");
		expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("unrelated");
		expect(git(remote, "rev-parse", "main").trim()).toBe(initial);
		expect(git(remote, "branch", "--list", "feature").trim()).toBe("");
		const explicit = "Co-Authored-By: User Supplied <user@example.invalid>";
		writeFileSync(join(repo, "owned"), "next\n");
		// Omitting push retains the upstream default, and pushes only this branch.
		const pushed = await mock.call("git_commit", { subject: "Keep deliberate attribution", why: explicit, paths: ["owned"] }, repo);
		expect(pushed.isError).toBe(false);
		expect(pushed.structuredContent).toMatchObject({ pushed: true });
		expect(git(remote, "log", "feature", "-1", "--format=%B").trim()).toBe(`Keep deliberate attribution\n\n${explicit}`);
		expect(git(remote, "rev-parse", "main").trim()).toBe(initial);
		expect((await mock.call("git_worktree_add", { branch: "feature" }, repo)).isError).toBe(true);
		const head = git(repo, "rev-parse", "HEAD").trim();
		const added = await mock.call("git_worktree_add", { branch: "Other" }, repo);
		const worktree = join(root, "repo-other");
		expect(added.structuredContent).toMatchObject({ path: worktree, branch: "Other", head, created: true });
		writeFileSync(join(worktree, "dirty"), "must retain");
		expect((await mock.call("git_worktree_remove", { path: worktree }, repo)).isError).toBe(true);
		expect(readFileSync(join(worktree, "dirty"), "utf8")).toBe("must retain");
		rmSync(join(worktree, "dirty"));
		expect((await mock.call("git_worktree_remove", { path: worktree }, repo)).isError).toBe(false);
		expect(git(repo, "rev-parse", "Other").trim()).toBe(head);
		expect(git(repo, "branch", "--show-current").trim()).toBe("feature");
		expect(mock.tools.get("git_commit")?.description).not.toContain("Claude");
		expect(mock.toolCall("bash", { command: "git commit --no-verify -m x" })).toBeDefined();
		expect(mock.toolCall("bash", { command: "git push --force" })).toBeDefined();
		expect(mock.toolCall("bash", { command: "git commit --no-gpg-sign -m x" })).toBeDefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("message style validation is unchanged and no synthetic footer is generated", () => {
	for (const subject of ["", "lowercase", "Add thing.", "feat: Add thing", "Add\nthing", "A".repeat(73), " Add thing", "Add \u2014 thing"])
		expect(validateSubject(subject)).toBeDefined();
	expect(validateSubject("area: Add thing")).toBeUndefined();
	expect(buildCommitMessage({ subject: "Do it", changes: [" "] })).toBe("Do it\n");
	expect(() => buildCommitMessage({ subject: "Do it", why: "a \u2014 b" })).toThrow("dash");
});
