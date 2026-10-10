import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSmoke } from "../scripts/smoke.ts";
import { settleOwnedCodeGraph } from "../scripts/owned-codegraph.ts";

test("fixture can use LSP and CodeGraph through Pitako", async () => {
  const receipts: string[] = [];
  const log = spyOn(console, "error").mockImplementation((line) => { receipts.push(String(line)); });
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    const lines = await runSmoke();
    const joined = lines.map((line) => line.text).join("\n");
    expect(joined).toContain("greet");
    expect(joined).toContain("greet.ts");
    expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
    const receipt = JSON.parse(receipts.find((line) => line.startsWith("PITAKO_SMOKE_SETTLED="))!.split("=")[1]!);
    expect(existsSync(receipt.owned)).toBe(false);
    expect(receipt.processes.length).toBeGreaterThanOrEqual(3);
    expect(receipt.codegraph.before.length).toBeGreaterThanOrEqual(2);
    expect(receipt.codegraph.stop.outcome).toBe("term");
    for (const native of receipt.codegraph.after) expect(["absent", "Z"]).toContain(native.state);
    for (const child of receipt.processes) {
      expect(child.settled).toBe(true);
      expect(() => process.kill(child.pid, 0)).toThrow();
    }
  } finally { log.mockRestore(); }
}, 120_000);

test("smoke acquisition failure settles before removing its roots", async () => {
  const receipts: string[] = [];
  const log = spyOn(console, "error").mockImplementation((line) => { receipts.push(String(line)); });
  try {
    await expect(runSmoke(path.join(tmpdir(), `pitako-missing-${crypto.randomUUID()}`))).rejects.toThrow();
    const receipt = JSON.parse(receipts.find((line) => line.startsWith("PITAKO_SMOKE_SETTLED="))!.split("=")[1]!);
    expect(existsSync(receipt.owned)).toBe(false);
    expect(receipt.processes).toEqual([]);
  } finally { log.mockRestore(); }
});

test("uncertain native identity retains the owned root without signalling a live child", async () => {
  const project = mkdtempSync(path.join(tmpdir(), "pitako-native-identity-"));
  const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    mkdirSync(path.join(project, ".codegraph"));
    writeFileSync(path.join(project, ".codegraph", "daemon.pid"), JSON.stringify({
      pid: child.pid, version: "1.6.0", socketPath: path.join(project, "missing.sock"), startedAt: Date.now(),
    }));
    await expect(settleOwnedCodeGraph(project)).rejects.toThrow("still running; retain");
    expect(existsSync(project)).toBe(true);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  } finally {
    child.kill();
    await closed;
    rmSync(project, { recursive: true, force: true });
  }
}, 15_000);
