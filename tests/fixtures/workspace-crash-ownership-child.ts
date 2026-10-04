import { afterEach, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { workspaceCrashOwnership } from "./workspace-crash-ownership.ts";

const mode = process.env.WORKSPACE_CRASH_MODE!;
const directory = path.join(process.env.WORKSPACE_CRASH_ROOT!, "owned");
const ownership = workspaceCrashOwnership([directory]);
const marker = (text: string) => writeSync(2, `${text}\n`);
afterEach(() => {
  ownership.requireReleased();
  marker("AFTER_GUARD");
  rmSync(directory, { recursive: true, force: true });
  marker("DELETED");
});
test.serial("owned crash callback", ownership.ownedCase(mode, async () => {
  mkdirSync(directory);
  if (mode === "callback-pending") {
    marker("CALLBACK_PENDING");
    await new Promise(() => {});
  }
  if (mode === "cleanup-pending" || mode === "cleanup-error") {
    ownership.cleanup(async () => {
      marker("CLEANUP_ONE");
      if (mode === "cleanup-error") throw new Error("first cleanup failed");
      await new Promise(() => {});
    });
    ownership.cleanup(() => { marker("CLEANUP_TWO"); });
    throw new Error("original callback failed");
  }
  const child = spawn(mode === "spawn-error" ? "/nonexistent/workspace-crash-node" : process.execPath,
    ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const observed = ownership.observeChild(child);
  ownership.cleanup(async () => {
    await observed.settled;
    marker("ACTUAL_CLOSE");
  });
  ownership.cleanup(async () => { await observed.settled; marker("STORE_CLOSED"); });
  await observed.spawned;
  marker("CHILD_SPAWNED");
  if (mode === "body-error") throw new Error("body failed with live child");
}), mode.endsWith("-pending") ? 100 : 5_000);
test.serial("following case", () => { marker("NEXT_CASE"); });
