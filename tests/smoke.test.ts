import { expect, test } from "bun:test";
import { runSmoke } from "../scripts/smoke.ts";

test("fixture can use LSP and CodeGraph through Pitako", async () => {
  const lines = await runSmoke();
  const joined = lines.map((line) => line.text).join("\n");
  expect(joined).toContain("greet");
  expect(joined).toContain("greet.ts");
}, 120_000);
