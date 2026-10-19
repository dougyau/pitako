import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureObject, consultedPlan } from "../extensions/review/object.ts";
import { planHash } from "../extensions/workflow.ts";
import { loadPitakoConfig } from "../extensions/roles/load.ts";

test("plan identity excludes only actual operational section, preserves later substance, and leaves workflow hash unchanged", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-review-plan-"));
  try {
    mkdirSync(path.join(root, ".pitako/plans"), { recursive: true });
    const file = path.join(root, ".pitako/plans/example.md");
    const header = "---\nid: example\nrevision: 1\nstatus: draft\n---\n";
    const before = `${header}# Plan\n\`\`\`md\n## Planning workers\nexample text\n\`\`\`\n## Scope\nwhole object\n`;
    const workers = "## Planning workers <!-- note -->\n";
    const after = "## Acceptance <!-- frozen -->\nmust not disappear\n";
    writeFileSync(file, before + workers + "old worker\n" + after);
    const first = captureObject({ kind: "plan", planId: "example" }, root);
    expect(first.scope).toMatchObject({ text: before + after });
    const hash = planHash(readFileSync(file, "utf8"));
    writeFileSync(file, before + workers.replace("note", "updated note") + "new worker\n" + after);
    expect(captureObject(first.selector, root).identity).toBe(first.identity);
    expect(planHash(readFileSync(file, "utf8"))).not.toBe(hash);
    writeFileSync(file, before + workers + "new worker\n" + after + "changed acceptance\n");
    expect(captureObject(first.selector, root).identity).not.toBe(first.identity);
    expect(consultedPlan(before + "## Planning workers\nworker\n" + after)).toBe(before + after);
    expect(consultedPlan("<!--\n## Planning workers\n-->\nkeep\n")).toContain("keep");
    expect(consultedPlan("```\n<!--\n```\n## Planning workers\nworker\n## Acceptance\nkeep\n"))
      .toBe("```\n<!--\n```\n## Acceptance\nkeep\n");
    expect(consultedPlan("## Planning workers\nworker\n\nAcceptance\n---\nkeep\n")).toBe("Acceptance\n---\nkeep\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plan section boundaries distinguish comments in headings from headings inside comments", () => {
  for (const after of [
    "## Acceptance <!-- frozen -->\nmust review this\n## Later\nkeep\n",
    "## Acceptance <!--\nmust review this\n",
    "## Acceptance <!--\ncomment\n-->\nmust review this\n",
    "Acceptance <!-- frozen -->\n---\nmust review this\n",
  ]) expect(consultedPlan("## Planning workers\nsecret\n" + after)).toBe(after);
  expect(consultedPlan("## Planning workers <!-- note -->\nsecret\n")).toBe("");
  expect(consultedPlan("## Planning workers <!-- note --> ##\nsecret\n## Later\nkeep\n"))
    .toBe("## Later\nkeep\n");
  const different = "## Planning workers <!-- note --> policy\nkeep\n";
  expect(consultedPlan(different)).toBe(different);
  const commented = "<!--\n## Planning workers\n-->\nkeep\n";
  expect(consultedPlan(commented)).toBe(commented);
  expect(consultedPlan("## Planning workers <!-- one --> <!-- two\n## Fake\n-->\nsecret\n## Acceptance\nkeep\n"))
    .toBe("## Acceptance\nkeep\n");
  const fenced = "```md <!-- example -->\n## Planning workers\nkeep\n```\n";
  expect(consultedPlan(fenced + "## Planning workers\nsecret\n## Acceptance\nkeep\n"))
    .toBe(fenced + "## Acceptance\nkeep\n");
});

test("diff captures commits, index, raw dirty bytes, untracked, modes, symlinks and deletions without running filters", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-review-diff-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
  try {
    git("init", "-q"); git("config", "user.email", "review@test.invalid"); git("config", "user.name", "Review fixture");
    mkdirSync(path.join(root, "deleted-dir"));
    for (const [name, text] of Object.entries({ committed: "one\n", staged: "one\n", dirty: "one\n", executable: "one\n", "deleted-dir/gone": "gone\n", ".gitignore": "ignored\n", ".gitattributes": "dirty filter=tripwire\n" })) writeFileSync(path.join(root, name), text);
    git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(root, "committed"), "two\n"); git("add", "committed"); git("commit", "-qm", "committed change");
    writeFileSync(path.join(root, "staged"), "two\n"); git("add", "staged");
    git("config", "filter.tripwire.clean", "false"); git("config", "filter.tripwire.required", "true");
    writeFileSync(path.join(root, "dirty"), "two\n");
    writeFileSync(path.join(root, "new"), "new bytes\n"); writeFileSync(path.join(root, "ignored"), "not scope\n");
    chmodSync(path.join(root, "executable"), 0o755); rmSync(path.join(root, "deleted-dir"), { recursive: true });
    symlinkSync("dirty", path.join(root, "link"));
    writeFileSync(path.join(root, "binary"), Buffer.from([0, 255, 128]));
    const first = captureObject({ kind: "diff", base }, root), scope = first.scope as any;
    expect(scope.base).toBe(base); expect(scope.mergeBase).toBe(base);
    expect(scope.head).toBe(git("rev-parse", "HEAD")); expect(scope.committed).toContain("+two");
    expect(scope.staged).toContain("+two");
    expect(scope.files.find((item: any) => item.path === "dirty").text).toBe("two\n");
    expect(scope.files.find((item: any) => item.path === "new").text).toBe("new bytes\n");
    expect(scope.files.find((item: any) => item.path === "link").mode).toBe("120000");
    expect(scope.files.find((item: any) => item.path === "binary").contentBase64).toBe("AP+A");
    expect(scope.files.find((item: any) => item.path === "executable").mode).toBe("100755");
    expect(scope.files.find((item: any) => item.path === "deleted-dir/gone").deleted).toBe(true);
    expect(scope.files.some((item: any) => item.path === "ignored")).toBe(false);
    writeFileSync(path.join(root, "dirty"), "six\n"); // Same status shape, same byte length.
    expect(captureObject(first.selector, root).identity).not.toBe(first.identity);
    expect(() => captureObject({ kind: "diff", base: "does-not-exist" }, root)).toThrow();
    expect(() => captureObject({ kind: "diff", base: "--help" }, root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("independent optional review configuration shares strict candidates grammar without inheriting architecture or defaults", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-review-config-")), file = path.join(root, "config.toml");
  const load = (text: string) => { writeFileSync(file, text); return loadPitakoConfig({ userConfigPath: file, cwd: root }); };
  try {
    for (const review of ["", "[review]", "[review]\ncandidates=[]", "[review]\ntopics=[]"]) {
      expect(load(review).review).toEqual({ candidates: [], topics: [] });
      expect(load('[architecture]\ncandidates=[{model="fixture/architecture"}]\n' + review).review)
        .toEqual({ candidates: [], topics: [] });
    }
    for (const candidates of ["", "\ncandidates=[]"])
      expect(load('[review]\n[[review.topics]]\ntopic=" Security "' + candidates).review)
        .toEqual({ candidates: [], topics: [{ topic: "security", candidates: [] }] });
    const config = load('[architecture]\ncandidates=[{model="fixture/architecture"}]\n[review]\ncandidates=[{model="fixture/review"}]\n[[review.topics]]\ntopic=" Security  Audit "\ncandidates=[{model="fixture/security",reasoning="high"}]');
    expect(config.review?.candidates).toEqual([{ model: "fixture/review" }]);
    expect(config.review?.topics[0]?.topic).toBe("security audit");
    expect(config.architecture?.candidates[0]?.model).toBe("fixture/architecture");
    for (const text of [
      '[review]\ncandidates={}', '[review]\ncandidates=[{model="fixture/a",fast=true}]',
      '[review]\ncandidates=[{model="fixture/a"},{model="fixture/a"}]',
      '[review]\ncandidates=[{model="fixture/a"}]\nunknown=true',
      '[review]\ncandidates=[{model="fixture/a"}]\n[[review.topics]]\ntopic=" Security "\ncandidates=[{model="fixture/a"}]\n[[review.topics]]\ntopic="security"\ncandidates=[{model="fixture/b"}]',
    ]) expect(() => load(text)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
