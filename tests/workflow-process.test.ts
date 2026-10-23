import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureHostProcess, probeHostProcess, type HostProcessBinding } from "../extensions/workflow-process.ts";
import { WorkflowState } from "../extensions/workflow-state.ts";

test("linux-proc-v1 distinguishes a live host, its ended incarnation and unverifiable views", async () => {
  const own = captureHostProcess();
  expect(own).toBeDefined();
  expect(probeHostProcess(own!)).toBe("present");
  const root = mkdtempSync(path.join(tmpdir(), "pitako-linux-witness-"));
  const child = spawn(process.execPath, ["--eval", `
    import { captureHostProcess } from ${JSON.stringify(new URL("../extensions/workflow-process.ts", import.meta.url).href)};
    import { WorkflowState } from ${JSON.stringify(new URL("../extensions/workflow-state.ts", import.meta.url).href)};
    const store = new WorkflowState(${JSON.stringify(root)});
    const pure = store.resource(undefined, { adapter: "in-process-only", ownerId: "child", purpose: "work",
      scopes: ["callback"], inProcessScopes: ["callback"] });
    const mixed = store.resource(undefined, { adapter: "mixed", ownerId: "child", purpose: "work",
      scopes: ["callback", "sdk-history", "child-leader", "child-streams", "external-effects"], inProcessScopes: ["callback"] });
    store.enter(pure); store.enter(mixed);
    for (const [i, scope] of ["sdk-history", "child-leader", "child-streams", "external-effects"].entries())
      store.observe(mixed, i + 1, scope, "unknown", scope === "external-effects");
    const binding = captureHostProcess();
    process.stdout.write(JSON.stringify({ binding, pure, mixed }) + "\\n");
    await new Promise(resolve => process.stdin.once("data", resolve));
    store.close();
    process.stdin.destroy();
  `], { stdio: ["pipe", "pipe", "pipe"] });
  const settled = once(child, "close");
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  try {
    const [data] = await Promise.race([
      once(child.stdout, "data"),
      settled.then(([code]) => { throw new Error(`child host ended before handshake (${code}): ${stderr}`); }),
    ]);
    const { binding, pure, mixed } = JSON.parse(String(data));
    const observed: HostProcessBinding = binding;
    expect(observed.pid).toBe(child.pid!);
    expect(binding.version).toBe("linux-proc-v1");
    expect(binding.pid).toBe(child.pid!);
    expect(probeHostProcess(binding)).toBe("present");
    expect(probeHostProcess({ ...binding, boot: "unverifiable" })).toBe("unknown");
    expect(probeHostProcess({ ...binding, pidNamespace: "unverifiable" })).toBe("unknown");
    expect(probeHostProcess({ ...binding, procMount: "unverifiable" })).toBe("unknown");
    const live = new WorkflowState(root);
    try {
      expect(live.closureReceipt(pure)).toBeUndefined();
      expect(live.closureReceipt(mixed)).toBeUndefined();
    } finally { live.close(); }
    child.stdin.end("host handshake complete\n");
    expect((await settled)[0], stderr).toBe(0);
    expect(probeHostProcess(binding)).toBe("ended");
    expect(probeHostProcess({ ...binding, procDevice: "unverifiable" })).toBe("unknown");
    const reopened = new WorkflowState(root);
    try {
      const receipt = reopened.closureReceipt(pure)!;
      expect(reopened.verifyClosureReceipt(receipt)).toBe(true);
      expect(reopened.closureReceipt(mixed)).toBeUndefined();
      expect(reopened.exactResource(mixed).facts).toEqual({ callback: "closed", "sdk-history": "unknown",
        "child-leader": "unknown", "child-streams": "unknown", "external-effects": "unknown" });
      const count = reopened.all("observations").length;
      reopened.reconcile();
      expect(reopened.all("observations")).toHaveLength(count);
    } finally { reopened.close(); }
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await settled;
    rmSync(root, { recursive: true, force: true });
  }
});
