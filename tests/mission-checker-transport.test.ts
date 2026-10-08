import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createCheckerTransport, observeCheckerEndpoints } from "../extensions/mission/checker-transport.ts";

test("checker native FIFO transport closes GO, drains trailing output, and closes endpoints", async () => {
  const trace: Array<{ event: string; facts?: Record<string, unknown> }> = [];
  const transport = createCheckerTransport((event, facts) => { trace.push({ event, facts }); });
  const child = spawn("/bin/bash", ["-c",
    "printf 'ready\\n'; IFS= read -r gate; [ \"$gate\" = GO ] || exit 91; IFS= read -r tail && exit 92; printf 'stdin-eof\\ntrailing-stdout\\n'; printf 'trailing-stderr\\n' >&2"],
  { stdio: [...transport.childEnds] });
  transport.spawned();
  const ended = new Promise<number | null>((resolve) => child.once("close", resolve));
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  transport.stdout.on("data", (bytes) => stdout.push(typeof bytes === "string" ? Buffer.from(bytes) : bytes));
  transport.stderr.on("data", (bytes) => stderr.push(typeof bytes === "string" ? Buffer.from(bytes) : bytes));
  const lines = createInterface({ input: transport.stdout });
  try {
    expect((await lines[Symbol.asyncIterator]().next()).value).toBe("ready");
    const endpoints = observeCheckerEndpoints(child.pid!, transport.endpoints);
    expect(endpoints.map(({ direction }) => direction)).toEqual(["read", "write", "write"]);
    expect(() => observeCheckerEndpoints(child.pid!, [transport.endpoints[1]!, ...transport.endpoints.slice(1)]))
      .toThrow("identity or direction mismatch");
    lines.close();
    transport.stdout.resume();
    await transport.release(1000);
    expect(await ended).toBe(0);
    await transport.drain(1000);
    // Already-resolved EOF must not turn an exhausted invocation into fresh drain time.
    await expect(transport.drain(0)).rejects.toThrow("finite deadline");
    await expect(transport.drain(-1)).rejects.toThrow("finite deadline");
    expect(Buffer.concat(stdout).toString()).toBe("ready\nstdin-eof\ntrailing-stdout\n");
    expect(Buffer.concat(stderr).toString()).toBe("trailing-stderr\n");
    expect(transport.endpointState()).toMatchObject({
      stdin: { bytesWritten: 3, finished: true },
      stdout: { bytesRead: Buffer.byteLength("ready\nstdin-eof\ntrailing-stdout\n"), eof: true },
      stderr: { bytesRead: Buffer.byteLength("trailing-stderr\n"), eof: true },
    });
  } finally {
    lines.close(); child.kill("SIGKILL"); await ended;
    await transport.dispose();
  }
  expect(existsSync(transport.root)).toBe(false);
  expect([transport.stdin.closed, transport.stdout.closed, transport.stderr.closed]).toEqual([true, true, true]);
  expect(trace.filter(({ event }) => event === "endpoint.end").map(({ facts }) => facts!.endpoint).sort())
    .toEqual(["stderr", "stdout"]);
  expect(trace.filter(({ event }) => event === "endpoint.close")).toHaveLength(3);
  expect(trace.some(({ event }) => event === "endpoint.error")).toBe(false);
});

test("checker premature GO peer exit rejects delivery and closes all endpoints", async () => {
  const transport = createCheckerTransport();
  const child = spawn("/bin/bash", ["-c", "exit 19"], { stdio: [...transport.childEnds] });
  transport.spawned();
  transport.stdout.resume(); transport.stderr.resume();
  try {
    await new Promise((resolve) => child.once("close", resolve));
    await expect(transport.release(0)).rejects.toThrow("finite deadline");
    await expect(transport.release(1000)).rejects.toThrow();
  } finally { await transport.dispose(); }
  expect(existsSync(transport.root)).toBe(false);
});

test("checker drain deadline does not confuse process exit with inherited output EOF", async () => {
  const transport = createCheckerTransport();
  const child = spawn("/bin/bash", ["-c", "/usr/bin/sleep 1000 & printf '%s\\n' \"$!\""], { stdio: [...transport.childEnds] });
  transport.spawned();
  const lines = createInterface({ input: transport.stdout });
  const pidLine = lines[Symbol.asyncIterator]().next();
  transport.stderr.resume();
  let descendant: number | undefined;
  try {
    await new Promise((resolve) => child.once("close", resolve));
    descendant = Number((await pidLine).value);
    lines.close();
    transport.stdout.resume();
    expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
    await expect(transport.drain(25)).rejects.toThrow("finite deadline");
  } finally {
    lines.close();
    transport.stdout.resume();
    if (descendant) process.kill(descendant, "SIGKILL");
    await transport.drain(1000);
    await transport.dispose();
  }
  expect(existsSync(transport.root)).toBe(false);
});
