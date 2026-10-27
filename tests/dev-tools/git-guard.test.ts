// Adapted from nredd/pi-harness; MIT (Redd). See docs/provenance.json for source commits and test origins.
import { describe, expect, it } from "bun:test";
import { findGuardViolation } from "../../extensions/dev-tools/git/guard.ts";

const blocked: [string, string][] = [
	["git commit --no-verify -m x", "no-verify"],
	["git commit -m x --no-verify", "no-verify"],
	["git push --no-verify", "no-verify"],
	["git merge --no-verify topic", "no-verify"],
	["git rebase --no-verify main", "no-verify"],
	["git cherry-pick --no-verify abc", "no-verify"],
	["git am --no-verify < p", "no-verify"],
	["git commit -n -m x", "no-verify-short"],
	["git commit -anm x", "no-verify-short"],
	["git commit -sn -m x", "no-verify-short"],
	["git commit -m x 2>&1 --no-verify", "no-verify"],
	["echo $(git commit --no-verify -m x)", "no-verify"],
	["x=`git commit -n -m x`", "no-verify-short"],
	["(git commit --no-verify -m x)", "no-verify"],
	["cd repo && git commit -m x --no-verify", "no-verify"],
	["git -C ~/code/x commit --no-verify -q -F -", "no-verify"],
	["git push --force", "force-push"],
	["git push --force origin main", "force-push"],
	["git push -f origin main", "force-push"],
	["git push origin +main", "force-push"],
	["git push origin main --force", "force-push"],
	["git push -fu origin main", "force-push"],
	["git push -uf origin main", "force-push"],
	["git push origin HEAD:+main", "force-push"],
	["git push --force-with-lease=main --force", "force-push"],
	["git commit --no-gpg-sign -m x", "no-gpg-sign"],
	["git merge --no-gpg-sign topic", "no-gpg-sign"],
	["git tag --no-gpg-sign v1", "no-gpg-sign"],
	["git -c commit.gpgsign=false commit -m x", "no-gpg-sign"],
];

const allowed = [
	"git commit -m x",
	"git commit -q -F -",
	"git commit -am x",
	"git commit --amend --no-edit",
	"git push",
	"git push -u origin main",
	"git push --force-with-lease",
	"git push --force-with-lease=main origin main",
	"git push --force-if-includes --force-with-lease",
	"git push -n origin main",
	"git push --dry-run",
	"git push -u origin main",
	"git commit -m x -- -n",
	"git commit -m x -- notes/-n.txt",
	"git commit -c HEAD~1",
	"git merge --no-ff topic",
	"git merge -n topic",
	"git cherry-pick -n abc",
	"git revert -n abc",
	"git rebase --onto main a b",
	"git log -n 5",
	"git status; echo --no-verify",
	"echo 'git commit --no-verify' > notes.txt",
	"git diff | grep -n commit",
	"git commit -m 'Fix node -n handling'",
	"git tag -n",
	"git push origin main && git log -n 1",
	"git commit -m x; git push --force-with-lease",
];

describe("bash guard", () => {
	it.each(blocked)("blocks %s", (command, rule) => {
		expect(findGuardViolation(command)?.name).toBe(rule);
	});
	it.each(allowed)("allows %s", (command) => {
		expect(findGuardViolation(command)).toBeUndefined();
	});
});
