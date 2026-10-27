// Adapted from nredd/pi-harness; MIT (Redd). See docs/provenance.json for source commits and test origins.
import { describe, expect, it } from "bun:test";
import { formatStatus, parsePorcelainV2 } from "../../extensions/dev-tools/git/status.ts";

const NUL = "\0";
// Recorded from `git status --porcelain=v2 -b -z --untracked-files=all` on a repo with every kind.
const SAMPLE = [
	"# branch.oid 449fb9be1c3d1e4f0b1b2c3d4e5f60718293a4b5",
	"# branch.head main",
	"# branch.upstream origin/main",
	"# branch.ab +2 -1",
	"1 .M N... 100644 100644 100644 h1 h2 mod.txt",
	"2 R. N... 100644 100644 100644 h1 h2 R100 new name.txt",
	"old name.txt",
	"1 MM N... 100644 100644 100644 h1 h2 stg.txt",
	"1 A. N... 000000 100644 100644 0000 h2 added.txt",
	"u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt",
	"? .gitignore",
	"? dir/untracked file.txt",
].join(NUL);

describe("parsePorcelainV2", () => {
	it("parses branch, tracking, and every entry kind", () => {
		const s = parsePorcelainV2(SAMPLE);
		expect(s.branch).toBe("main");
		expect(s.upstream).toBe("origin/main");
		expect(s.ahead).toBe(2);
		expect(s.behind).toBe(1);
		expect(s.staged.map((e) => e.path)).toEqual(["new name.txt", "stg.txt", "added.txt"]);
		expect(s.staged[0]?.from).toBe("old name.txt");
		expect(s.unstaged.map((e) => e.path)).toEqual(["mod.txt", "stg.txt"]);
		expect(s.untracked).toEqual([".gitignore", "dir/untracked file.txt"]);
		expect(s.conflicted.map((e) => e.path)).toEqual(["conflict.txt"]);
	});

	it("handles a detached head and a repo with nothing to report", () => {
		const s = parsePorcelainV2(["# branch.oid abc", "# branch.head (detached)"].join(NUL));
		expect(s.branch).toBeNull();
		expect(s.upstream).toBeNull();
		expect(formatStatus(s)).toBe("(detached) (no upstream)\nclean");
	});

	it("says 'gone' when the upstream is configured but has no ab line", () => {
		const s = parsePorcelainV2(["# branch.oid abc", "# branch.head main", "# branch.upstream origin/main"].join(NUL));
		expect(s.tracked).toBe(false);
		expect(formatStatus(s).split("\n")[0]).toBe("main (origin/main gone)");
	});

	it("handles copies and submodules", () => {
		const s = parsePorcelainV2(
			[
				"# branch.head main",
				"2 C. N... 100644 100644 100644 h1 h2 C100 copy.txt",
				"orig.txt",
				"1 .M S.M. 160000 160000 160000 h1 h2 sub",
			].join(NUL),
		);
		expect(s.staged[0]).toEqual({ path: "copy.txt", code: "C.", from: "orig.txt" });
		expect(s.unstaged[0]?.path).toBe("sub");
	});

	it("formats compactly with rename arrows", () => {
		const text = formatStatus(parsePorcelainV2(SAMPLE));
		expect(text.split("\n")[0]).toBe("main (origin/main +2 -1)");
		expect(text).toContain("conflicted (1):\n  U conflict.txt");
		expect(text).toContain("R old name.txt -> new name.txt");
		expect(text).toContain("untracked (2):");
	});
});
