import { expect, test } from "bun:test";
import { runSmoke } from "../scripts/smoke.ts";
import { packageRoot } from "../extensions/stack.ts";

test("fixture can use LSP and CodeGraph through Pitako", async () => {
  const lines = await runSmoke();
  const joined = lines.map((line) => line.text).join("\n");
  expect(joined).toContain("greet");
  expect(joined).toContain("greet.ts");
}, 120_000);

test("pi-web-access fetches an HTTP page without credentials and Scout cannot activate web tools", () => {
  const run = Bun.spawnSync([process.execPath, "scripts/web-smoke.ts"], { cwd: packageRoot() });
  expect(new TextDecoder().decode(run.stderr)).toBe("");
  expect(run.exitCode).toBe(0);
  expect(new TextDecoder().decode(run.stdout)).toContain("Pitako web fetch smoke passed");
}, 30_000);
