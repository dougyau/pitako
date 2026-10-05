import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeSync } from "node:fs";
import path from "node:path";
import { providerFixtureOwnership } from "./provider-fixture-ownership.ts";

const fixture = providerFixtureOwnership();
const mode = process.env.PROVIDER_FIXTURE_MODE!;
const directory = path.join(process.env.PROVIDER_FIXTURE_ROOT!, "owned");
const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const mark = (text: string) => writeSync(2, `${text}\n`);
mark(`FIXTURE_PROCESS=${JSON.stringify({ pid: process.pid, ppid: process.ppid })}`);

afterEach(() => {
  // Observe restoration before the real guard, without restoring anything here.
  if (globalThis.fetch === originalFetch) mark("RESTORATION");
  fixture.requireReleasedFixture();
  mark("AFTER_GUARD");
});

test.serial("owned callback", fixture.ownedCase("network-free ownership control", async () => {
  mkdirSync(directory);
  fixture.directories.push(directory);
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => { throw new Error("No network permitted"); },
  });
  process.env.PI_CODING_AGENT_DIR = directory;
  if (mode === "timeout") {
    mark("ENTER_UNSETTLED");
    try {
      await new Promise<void>(() => {});
    } finally {
      mark("BODY_FINALLY");
    }
  } else if (mode === "disposal-failure") {
    await fixture.acquire(Promise.resolve({ session: { dispose() {
      mark("DISPOSE_ONE");
      throw new Error("first disposal failed");
    } } }));
    await fixture.acquire(Promise.resolve({ session: { dispose() { mark("DISPOSE_TWO"); } } }));
    throw new Error("original assertion failure");
  } else if (mode === "start-failure") {
    await Promise.all([
      fixture.acquire(Promise.reject(new Error("first start failed"))),
      fixture.acquire(new Promise<{ session: { dispose(): void } }>((resolve) => {
        setTimeout(() => resolve({ session: { dispose() { mark("DISPOSE_LATE_HANDLE"); } } }), 10);
      })),
    ]);
  } else if (mode === "run-rejection") {
    await fixture.run(Promise.reject(new Error("run-owned disposal failed")));
  } else {
    await fixture.acquire(Promise.resolve({ session: { dispose() { mark("DISPOSE_COMPLETE"); } } }));
  }
}), 200);

test.serial("following case", () => {
  expect(globalThis.fetch).toBe(originalFetch);
  expect(process.env.PI_CODING_AGENT_DIR).toBe(originalAgentDir);
  mark("NEXT_CASE");
});
