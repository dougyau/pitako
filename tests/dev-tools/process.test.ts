// Adapted from packages/dev-tools/test/core/{process,process-lines}.test.ts,
// nredd/pi-harness (MIT, Redd). Owned children only; no installed CLI dependency.
import { expect, test } from "bun:test";
import { run } from "../../extensions/dev-tools/core/process.ts";

test("runner settles callbacks and pipes, caps each line, and survives callback failures", async () => {
	const lines: string[] = [];
	const result = await run({
		cmd: process.execPath, args: ["-e", `process.stderr.write("head\\n" + "z".repeat(101) + "\\ntail");`],
		maxBytes: 100,
		onStderrLine: line => { lines.push(line); throw Error("listener failure"); },
	});
	expect(result.exitCode).toBe(0);
	expect(lines).toEqual(["head", "tail"]);
	expect(result.stderr.length).toBe(100);
	expect(result.stderrDropped).toBe(11);
});

test("cancellation of one running child does not cancel an independent run", async () => {
	const controller = new AbortController();
	let cancelledPid = 0;
	let ready!: () => void;
	const started = new Promise<void>(resolve => { ready = resolve; });
	const owner = run({
		cmd: process.execPath,
		args: ["-e", "console.error(process.pid); setInterval(() => {}, 1000)"],
		signal: controller.signal,
		onStderrLine: line => { cancelledPid = Number(line); ready(); },
	});
	try {
		// The owned start, not a status or elapsed sleep, establishes readiness.
		await Promise.race([started, owner.then(() => { throw Error("child exited before readiness"); })]);
		const other = run({ cmd: process.execPath, args: ["-e", "console.log('independent')"] });
		controller.abort();
		const [cancelled, completed] = await Promise.all([owner, other]);
		expect(cancelled.aborted).toBe(true);
		expect(() => process.kill(cancelledPid, 0)).toThrow();
		expect(completed.exitCode).toBe(0);
		expect(completed.stdout.trim()).toBe("independent");
	} finally {
		controller.abort();
		await owner;
	}
});

test("failed process start and pre-cancelled starts return explicit failures", async () => {
	expect(await run({ cmd: "/nonexistent-pitako-owned-test", args: [] })).toMatchObject({ spawnError: expect.any(String), exitCode: null });
	const controller = new AbortController(); controller.abort();
	expect(await run({ cmd: process.execPath, args: ["-e", "throw Error('must not start')"], signal: controller.signal }))
		.toMatchObject({ aborted: true, exitCode: null, stdout: "", stderr: "" });
});
