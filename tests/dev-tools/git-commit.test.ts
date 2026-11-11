// Adapted from nredd/pi-harness packages/dev-tools/test/scenarios/git.test.ts and
// test/git/commit-message.test.ts; MIT (Redd). See docs/provenance.json.
import { expect, test } from "bun:test";
import { gitFakeFixture } from "../fixtures/git-fake-fixture.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGitTools } from "../../extensions/dev-tools/git/index.ts";
import { buildCommitMessage, validateSubject } from "../../extensions/dev-tools/git/commit-message.ts";
import { createMockPi } from "./support.ts";

test("Git requests preserve user text, hooks/signing failures, named paths and push policy", async () => {
	const root = mkdtempSync(join(tmpdir(), "pitako-owned-git-"));
	const repo = join(root, "repo"), worktree = join(root, "repo-other");
	const fake = gitFakeFixture();
	const set = (cwd: string, args: string[], stdout = "", status = 0, stderr = "") =>
		fake.set(cwd, ["--no-pager", "--literal-pathspecs", ...args], { stdout, stderr, status });
	const commitArgs = ["commit", "-q", "-F", "-", "--", "owned"];
	const head = "2".repeat(40);
	try {
		fake.fakeRepo(repo, { branch: "feature" });
		set(repo, ["add", "--", "owned"]);
		set(repo, commitArgs, "", 1, "pre-commit hook rejected the commit");
		const mock = createMockPi(); registerGitTools(mock.pi);
		const call = (args: object) => mock.call("git_commit", { subject: "Preserve messages", paths: ["owned"], push: false, ...args }, repo);
		expect((await call({ subject: "feat: bad" })).isError).toBe(true);
		expect((await call({ paths: ["."] })).isError).toBe(true);
		expect(fake.calls).toHaveLength(0);
		const rejected = await call({});
		expect(rejected.isError).toBe(true);
		expect(rejected.structuredContent).toMatchObject({ stage: "commit", sha: null, pushed: false });
		expect(mock.text(rejected)).toContain("pre-commit hook rejected");
		expect(fake.calls.map(c => c.args.slice(2))).toEqual([["add", "--", "owned"], commitArgs]);
		// Controlled Git answers preserve error handling without running user hooks or a signer.
		set(repo, commitArgs, "", 1, "error: gpg failed to sign the data");
		const signing = await call({});
		expect(signing.isError).toBe(true);
		expect(mock.text(signing)).toContain("gpg failed to sign");
		expect(signing.structuredContent).toMatchObject({ stage: "commit", sha: null, pushed: false });
		set(repo, commitArgs);
		set(repo, ["log", "-1", "--format=%H%x09%G?"], head + "\tN\n");
		const before = fake.calls.length;
		const result = await call({ why: "Keep explicit text.", changes: ["Only the named file"] });
		expect(result.isError).toBe(false);
		expect(result.structuredContent).toMatchObject({ stage: "done", sha: head, pushed: false, signed: false });
		const calls = fake.calls.slice(before);
		expect(calls.map(c => c.args.slice(2))).toEqual([["add", "--", "owned"], commitArgs, ["log", "-1", "--format=%H%x09%G?"]]);
		expect(calls[1]!.stdin).toBe("Preserve messages\n\nKeep explicit text.\n\nChanges:\n- Only the named file\n");
		expect(fake.calls.every(c => c.args.slice(2).every(arg => !arg.startsWith("--no-") && arg !== "-c"))).toBe(true);
		const explicit = "Co-Authored-By: User Supplied <user@example.invalid>";
		set(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], "", 128, "no upstream");
		set(repo, ["push", "-q", "-u", "origin", "HEAD"]);
		const pushed = await mock.call("git_commit", { subject: "Keep deliberate attribution", why: explicit, paths: ["owned"] }, repo);
		expect(pushed.isError).toBe(false);
		expect(pushed.structuredContent).toMatchObject({ pushed: true });
		expect(fake.calls.filter(c => c.args[2] === "commit").at(-1)!.stdin).toBe(`Keep deliberate attribution\n\n${explicit}\n`);
		expect(fake.calls.at(-1)!.args.slice(2)).toEqual(["push", "-q", "-u", "origin", "HEAD"]);

		set(repo, ["check-ref-format", "refs/heads/feature"]);
		set(repo, ["show-ref", "--verify", "--quiet", "--end-of-options", "refs/heads/feature"]);
		expect((await mock.call("git_worktree_add", { branch: "feature" }, repo)).isError).toBe(true);
		set(repo, ["check-ref-format", "refs/heads/Other"]);
		set(repo, ["show-ref", "--verify", "--quiet", "--end-of-options", "refs/heads/Other"], "", 1);
		set(repo, ["worktree", "add", "-b", "Other", "--end-of-options", worktree]);
		mkdirSync(worktree);
		set(worktree, ["rev-parse", "HEAD"], head + "\n");
		const added = await mock.call("git_worktree_add", { branch: "Other" }, repo);
		expect(added.structuredContent).toMatchObject({ path: worktree, branch: "Other", head, created: true });
		set(repo, ["worktree", "list", "--porcelain", "-z"], `worktree ${repo}\0HEAD ${head}\0branch refs/heads/feature\0\0worktree ${worktree}\0HEAD ${head}\0branch refs/heads/Other\0\0`);
		writeFileSync(join(worktree, "dirty"), "must retain");
		set(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"], "?? dirty\0");
		expect((await mock.call("git_worktree_remove", { path: worktree }, repo)).isError).toBe(true);
		expect(readFileSync(join(worktree, "dirty"), "utf8")).toBe("must retain");
		rmSync(join(worktree, "dirty"));
		set(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]);
		set(repo, ["worktree", "remove", "--end-of-options", worktree]);
		expect((await mock.call("git_worktree_remove", { path: worktree }, repo)).isError).toBe(false);
		expect(fake.calls.at(-1)!.args.slice(2)).toEqual(["worktree", "remove", "--end-of-options", worktree]);
		expect(mock.tools.get("git_commit")?.description).not.toContain("Claude");
		expect(mock.toolCall("bash", { command: "git commit --no-verify -m x" })).toBeDefined();
		expect(mock.toolCall("bash", { command: "git push --force" })).toBeDefined();
		expect(mock.toolCall("bash", { command: "git commit --no-gpg-sign -m x" })).toBeDefined();
	} finally {
		try { fake.dispose(); } finally { rmSync(root, { recursive: true, force: true }); }
	}
});

test("message style validation is unchanged and no synthetic footer is generated", () => {
	for (const subject of ["", "lowercase", "Add thing.", "feat: Add thing", "Add\nthing", "A".repeat(73), " Add thing", "Add \u2014 thing"])
		expect(validateSubject(subject)).toBeDefined();
	expect(validateSubject("area: Add thing")).toBeUndefined();
	expect(buildCommitMessage({ subject: "Do it", changes: [" "] })).toBe("Do it\n");
	expect(() => buildCommitMessage({ subject: "Do it", why: "a \u2014 b" })).toThrow("dash");
});
