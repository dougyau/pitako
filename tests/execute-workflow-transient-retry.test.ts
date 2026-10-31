import { expect, test } from "bun:test";
import { executeControllerFixture, copy } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();

test.each([false, true])("transient save retries identical bytes without duplicate effects (committed=%s)", async committed => {
  const host = fixture(undefined, { readOnly: true });
  const set = host.state.set;
  const attempts: any[] = [];
  let injected = false;
  host.state.set = async (key, value) => {
    if (key === "invoke-human-1" && (value as any).loop?.attempt?.stage === "intention" && !injected) {
      injected = true;
      attempts.push(copy(value));
      if (committed) await set(key, value);
      throw Error("EIO: i/o error, rename '/state.tmp' -> '/state.json'");
    }
    if (injected && attempts.length === 1) attempts.push(copy(value));
    return set(key, value);
  };
  const output = await host.executeNative();
  expect(output.status, output.reason).toBe("complete");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(host.current().consumedLoops).toBe(1);
  expect(host.calls.filter(call => call.agent === "pitako.worker").map(call =>
    JSON.parse(call.task!.split("FROZEN ATTEMPT:\n")[1]!.split("\n")[0]!).taskId)).toEqual(["change1", "final"]);
  expect(new Set(host.calls.map(call => call.key)).size).toBe(host.calls.length);
});

test.each([
  "Mission state exceeds the 256 KiB limit (273647 bytes; maximum 262144 bytes).",
  "Invalid mission state file '/state.json': Unexpected end of JSON input",
  "state.set('invoke-human-1') value must contain only JSON data",
])("deterministic save failure halts immediately: %s", async message => {
  const host = fixture();
  let attempts = 0;
  host.setFailSave(() => { attempts++; throw Error(message); });
  const output = await host.executeNative();
  expect(output.status).not.toBe("complete");
  expect(output.reason).toContain(message);
  expect(output.reason).toContain("Essential persistence failed");
  expect(attempts).toBe(1);
  expect(host.calls).toHaveLength(0);
});

test.each(["seal", "gaps", "observation", "closing"].flatMap(phase => [
  "Mission state exceeds the 256 KiB limit (273647 bytes; maximum 262144 bytes).",
  "Invalid mission state file '/state.json': Unexpected end of JSON input",
  "state.set('invoke-human-1') value must contain only JSON data",
].map(message => ({ phase, message }))))("deterministic $phase save failure cannot trigger outer retries: $message", async ({ phase, message }) => {
  const host = fixture(undefined, { readOnly: phase !== "seal" }); host.setLimit(1);
  if (phase === "gaps") host.setRespond((request, normal) => {
    const result = normal();
    if (request.agent === "pitako.execution-director") result.structuredOutput.tasks = [];
    return result;
  });
  let attempts = 0, calls = 0;
  host.setFailSave(value => {
    const selected = phase === "seal" ? value.ledger?.count === 2 && !value.sealPending
      : phase === "gaps" ? value.loop?.archived
      : phase === "observation" ? !!value.loop?.closing
      : value.loop?.phase === "finished";
    if (selected) { if (++attempts === 1) calls = host.calls.length; throw Error(message); }
    return false;
  });
  const output = await host.execute();
  expect(output.status).not.toBe("complete");
  expect(output.reason).toContain(message);
  expect(attempts).toBe(1);
  expect(host.calls).toHaveLength(calls);
});

test.each([
  "Timed out acquiring mission state lock '/state.json.lock'.",
  "Failed to read mission state '/state.json': EIO: i/o error, read",
  "ENOSPC: no space left on device, write",
])("transient save cap halts with the repeated cause: %s", async message => {
  const host = fixture();
  let attempts = 0;
  host.setFailSave(() => { attempts++; throw Error(message); });
  const output = await host.executeNative();
  expect(output.status).not.toBe("complete");
  expect(output.reason).toContain("Three state-save attempts failed");
  expect(output.reason).toContain(message);
  expect(attempts).toBe(3);
  expect(host.calls).toHaveLength(0);
});

test.each(["transport", "envelope"])("fixed host inspection recovers automatically on its third attempt: %s", async kind => {
  const host = fixture();
  host.setHostResponse((key, value) => {
    if (key.startsWith("inspect-initial") && host.hostCalls.length < 3) {
      if (kind === "envelope") return { version: 1, error: "EIO: inspection read failed", next: "Retry fixed read" };
      throw Error("EIO: transport loss");
    }
    return value;
  });
  const output = await host.executeNative();
  expect(output.status, output.reason).toBe("complete");
  expect(host.hostCalls).toEqual(["inspect-initial", "inspect-initial.r1", "inspect-initial.r2"]);
  expect(host.current().hostHalt).toBeUndefined();
  expect(new Set(host.calls.map(call => call.key)).size).toBe(host.calls.length);
});

test.each([false, true])("bounded host reconstruction retries and preserves its cap (recovers=%s)", async recovers => {
  const host = fixture();
  host.setHostResponse(() => { throw Error("EIO: transport loss"); });
  expect((await host.execute()).status).toBe("blocked");
  const original = copy(host.current().hostHalt), before = host.hostCalls.length;
  host.setHostResponse((_key, value) => {
    if (!recovers || host.hostCalls.length < before + 2) throw Error("EIO: repeated transport loss");
    return value;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe(recovers ? "complete" : "blocked");
  expect(host.current().hostReconstruction.stage).toBe(recovers ? "admitted" : "failed");
  expect(host.current().hostReconstruction.source).toEqual(original);
  if (!recovers) {
    expect(host.hostCalls).toHaveLength(before + 3);
    expect(output.reason).toContain("Three inspection attempts failed: EIO: repeated transport loss");
    const calls = host.hostCalls.length;
    host.setHostResponse();
    const replay = await host.execute();
    expect(replay.status).toBe("blocked");
    expect(replay.reason).toContain("EIO: repeated transport loss");
    expect(host.hostCalls).toHaveLength(calls);
    expect(host.calls).toHaveLength(0);
  }
});

test.each(["stopped", "permission"])("host retry never clears a %s barrier", async cause => {
  const host = fixture();
  host.setHostResponse(() => { throw Error("Transport loss"); });
  await host.execute();
  const before = copy(host.current());
  if (cause === "stopped") before.hostHalt.observedState = "stopped";
  else before.hostHalt.observedBarrier = "native permission denial";
  host.storage.set("invoke-human-1", copy(before));
  host.setHostResponse();
  const calls = host.hostCalls.length;
  expect((await host.execute()).status).toBe("blocked");
  expect(host.hostCalls).toHaveLength(calls);
  expect(host.current()).toEqual(before);
  expect(host.calls).toHaveLength(0);
});

test.each([
  "Blocked by pi-subagents permission rule: 'host' is denied.",
  "Invalid inspection configuration",
])("host refusal or deterministic error never launches retry aliases: %s", async message => {
  const host = fixture();
  host.setHostResponse(() => { throw Error(message); });
  const output = await host.executeNative();
  expect(output.status).toBe("blocked");
  expect(host.hostCalls).toEqual(["inspect-initial"]);
  expect(host.current().hostHalt.observedError).toContain(message);
  expect(host.calls).toHaveLength(0);
});

test("a transient barrier save retries without relaunching a stopped writer", async () => {
  const host = fixture(undefined, { readOnly: true });
  host.setRespond((request, normal) => request.agent === "pitako.worker"
    ? { ...normal(), ok: false, stopped: true } : normal());
  let attempts = 0;
  host.setFailSave(value => {
    if (!value.activePlan && value.loop?.halt?.cause === "stopped" && attempts++ === 0) throw Error("EBUSY: resource busy, rename");
    return false;
  });
  const output = await host.execute();
  expect(output.status).toBe("cancelled");
  expect(attempts).toBe(2);
  expect(host.current().loop.halt.cause).toBe("stopped");
  expect(host.calls.filter(call => call.agent === "pitako.worker")).toHaveLength(1);
});
