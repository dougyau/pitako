import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

test("sampler ownership and cancellation settle with controlled collection boundaries", () => {
	const output = execFileSync(process.execPath, [new URL("./fixtures/lifecycle.ts", import.meta.url).pathname], {
		cwd: new URL("../..", import.meta.url),
		encoding: "utf8",
		timeout: 10_000,
	});
	expect(output).toContain("independent sampler owners and disposal settled");
});
