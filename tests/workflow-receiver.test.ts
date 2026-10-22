import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { snapshotPlan } from "../extensions/workflow-planning.ts";
import {
  bindCallContext, bindForegroundCallContext, captureCallContext, captureResultSource, checkCallContext,
  currentCallContext, openPlanActivity, registerBackgroundAttempt, reserveEffect, withCallContext, withReceiverContext,
  openTaskActivity,
} from "../extensions/workflow-engine.ts";

test("native origin is an admission record, not manager ID, cloned context, or later SDK binding", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-receiver-origin-"));
  const manager = SessionManager.inMemory(root);
  const unbind = bindForegroundCallContext(root, manager);
  const principal = captureCallContext(root, manager);
  const attempt = registerBackgroundAttempt(principal, { cwd: root, instanceId: "original", dispatchId: "original", roleId: "developer" });
  attempt.admit();
  const sdkChild = SessionManager.inMemory(root), unbindChild = bindCallContext(sdkChild, attempt.context);
  const source = captureResultSource(attempt, "original-source",
    { customType: "result", content: "original", details: { deliveryId: "original" } },
    { owns: () => true, getBranch: () => [] });
  let planning: ReturnType<typeof openPlanActivity> | undefined, unbindPlanning = () => {};
  try {
    expect(source.receiverContext(manager)).toBe(principal);
    expect(() => source.receiverContext({ getSessionId: () => manager.getSessionId() })).toThrow(/receiver/);
    expect(() => source.receiverContext(sdkChild)).toThrow(/receiver/);
    expect(() => withReceiverContext(manager, { ...principal }, () => true, () => {})).toThrow(/root binding/);
    expect(() => withReceiverContext(manager, attempt.context, () => true, () => {})).toThrow(/root binding/);
    expect(withCallContext(attempt.context, () => currentCallContext(sdkChild))).toBe(attempt.context);
    expect(() => withCallContext(attempt.context, () => currentCallContext(manager))).toThrow(/another native admission/);
    unbindChild();
    expect(() => withCallContext(attempt.context, () => currentCallContext(sdkChild))).toThrow(/another native admission/);
    expect(captureCallContext(root, manager)).toBe(principal);
    expect(source.receiverContext(manager)).toBe(principal);
    attempt.assertAdmissionCurrent();
    attempt.result({ status: "completed", result: "original outcome" });
    attempt.producer.observe("preparation", "closed");
    attempt.producer.observe("host-operation", "closed");
    expect(attempt.producer.observe("callback", "closed", true)).toBeDefined();
    expect(attempt.receipt()).toBeDefined();
    expect(() => withCallContext(attempt.context, () =>
      reserveEffect(currentCallContext()!, { reservationId: "released-child", kind: "writer", paths: [root] })))
      .toThrow(/ancestor is unavailable or retired/);
    const oldReceiver = withReceiverContext(manager, principal, () => true, () => AsyncLocalStorage.snapshot());
    unbind();
    planning = openPlanActivity("next", root, snapshotPlan("next", root), manager, manager.getSessionId());
    unbindPlanning = bindCallContext(manager, planning.context);
    unbind(); // A stale ordinary release must not delete the newer managed record.
    expect(captureCallContext(root, manager)).toBe(planning.context);
    expect(() => oldReceiver(() => currentCallContext(manager))).toThrow(/binding replaced/);
    expect(() => oldReceiver(() => currentCallContext())).toThrow(/binding replaced/);
    expect(() => source.claimWake("new intent from old payload")).toThrow(/retired or replaced/);
    expect(() => attempt.assertAdmissionCurrent()).toThrow(/retired or replaced/);
    expect(() => withCallContext(principal, () => captureCallContext(root, manager))).toThrow(/retired or replaced/);
    expect(() => withCallContext(principal, () => checkCallContext(currentCallContext()!))).toThrow(/retired or replaced/);
    expect(attempt.store.get("attempts", "original")).toMatchObject({ outcome: { result: "original outcome" } });
    expect(attempt.receipt()).toBeDefined();
    unbindPlanning();
    const noOrdinary = bindForegroundCallContext(root, manager);
    noOrdinary();
    expect(captureCallContext(root, manager).kind).toBe("managed-unavailable");
  } finally {
    unbindChild(); unbindPlanning(); unbind();
    await planning?.retire();
    principal.kind === "ordinary" && principal.guard.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted same-session ordinary reload binds a fresh generation without reviving old operations or receivers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-receiver-reload-"));
  const manager = SessionManager.inMemory(root);
  const release = bindForegroundCallContext(root, manager);
  const original = captureCallContext(root, manager);
  const operation = withCallContext(original, () => AsyncLocalStorage.snapshot());
  const receiver = withReceiverContext(manager, original, () => true, () => AsyncLocalStorage.snapshot());
  let releaseNext = () => {};
  try {
    expect(() => bindForegroundCallContext(root, manager)).toThrow("native foreground already bound");
    release();
    expect(captureCallContext(root, manager).kind).toBe("managed-unavailable");
    releaseNext = bindForegroundCallContext(root, manager);
    const next = captureCallContext(root, manager);
    expect(next.kind).toBe("ordinary");
    expect(next).not.toBe(original);
    release(); // An older lifecycle's cleanup cannot remove the new generation.
    expect(captureCallContext(root, manager)).toBe(next);
    expect(() => operation(() => checkCallContext(currentCallContext()!))).toThrow(/retired or replaced/);
    expect(() => operation(() => captureCallContext(root, manager))).toThrow(/retired or replaced/);
    expect(() => receiver(() => currentCallContext())).toThrow(/binding replaced/);
    const producer = reserveEffect(next, { reservationId: "new-generation", kind: "writer", paths: [root] })
      .register("reload effect", ["host-operation"]);
    producer.enter();
    expect(producer.observe("host-operation", "closed", true)).toBeDefined();
  } finally {
    releaseNext(); release();
    if (original.kind === "ordinary") original.guard.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit absence of native admission survives reservation cloning and SDK bind", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-receiver-absent-"));
  const context = captureCallContext(root);
  const attempt = registerBackgroundAttempt(context, { cwd: root, instanceId: "anonymous", dispatchId: "anonymous", roleId: "developer" });
  attempt.admit();
  const manager = SessionManager.inMemory(root), unbind = bindCallContext(manager, attempt.context);
  try {
    attempt.assertAdmissionCurrent();
    expect(() => attempt.receiverContext(manager)).toThrow(/no original native principal receiver/);
    attempt.result({ status: "completed", result: "anonymous custody" });
    attempt.producer.observe("preparation", "closed");
    attempt.producer.observe("host-operation", "closed");
    expect(attempt.producer.observe("callback", "closed", true)).toBeDefined();
    expect(attempt.receipt()).toBeDefined();
  } finally {
    unbind();
    context.kind === "ordinary" && context.guard.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed receiver fences owner loss, Stop, resumed epoch, and a reused manager's new session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-receiver-stop-"));
  const manager = SessionManager.inMemory(root);
  const original = openTaskActivity("resume", root, snapshotPlan("resume", root), manager, manager.getSessionId());
  const unbind = bindCallContext(manager, original.context);
  let owns = true, resumed: ReturnType<typeof openTaskActivity> | undefined, unbindResume = () => {};
  const receiver = withReceiverContext(manager, original.context, () => owns, () => AsyncLocalStorage.snapshot());
  try {
    owns = false;
    expect(() => receiver(() => currentCallContext())).toThrow(/owner retired/);
    owns = true;
    unbind();
    await original.retire();
    resumed = openTaskActivity("resume", root, snapshotPlan("resume", root), manager, manager.getSessionId());
    unbindResume = bindCallContext(manager, resumed.context);
    expect(resumed.authority.fence.epoch).toBeGreaterThan(original.authority.fence.epoch);
    expect(() => receiver(() => currentCallContext(manager))).toThrow(/activity replaced/);
    expect(() => withCallContext(original.context, () => checkCallContext(currentCallContext()!))).toThrow(/retired/);
    unbindResume();
    await resumed.retire();
    // Only a real lifecycle admission, not a result lookup, publishes the new root.
    manager.newSession();
    const release = bindForegroundCallContext(root, manager);
    const fresh = captureCallContext(root, manager);
    expect(fresh.kind).toBe("ordinary");
    expect(() => receiver(() => currentCallContext())).toThrow(/owner retired/);
    release();
    if (fresh.kind === "ordinary") fresh.guard.close();
  } finally {
    unbind(); unbindResume();
    await original.retire();
    await resumed?.retire();
    rmSync(root, { recursive: true, force: true });
  }
});
