import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { principalLeases, reserveOperation } from "../extensions/agent/head/operation-leases.ts";
import { packageRoot } from "../extensions/stack.ts";
import { snapshotPlan } from "../extensions/workflow-planning.ts";
import { openExecutionPlan, planFile } from "../extensions/workflow.ts";
import {
  bindCallContext, bindForegroundCallContext, captureCallContext, captureResultSource, checkCallContext,
  currentCallContext, openPlanActivity, registerBackgroundAttempt, reserveEffect, withCallContext, withReceiverContext,
  openTaskActivity, openExecuteActivity, guardDefinition,
} from "../extensions/workflow-engine.ts";

test("ordinary external tools need no fictional leases while managed effects retain their boundaries", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-navigation-admission-"));
  const external = mkdtempSync(path.join(tmpdir(), "pitako-navigation-external-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const manager = SessionManager.inMemory(root), child = SessionManager.inMemory(root);
  const unbind = bindForegroundCallContext(root, manager), principal = captureCallContext(root, manager);
  const attempt = registerBackgroundAttempt(principal, { cwd: root, instanceId: "developer", dispatchId: "developer", roleId: "developer" });
  attempt.admit();
  const unbindChild = bindCallContext(child, attempt.context);
  const tools = new Map<string, any>(), hooks = new Map<string, Function>();
  const sources = new Map<string, string>();
  const pi = { registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, hook: Function) { hooks.set(name, hook); },
    getAllTools: () => [...tools.values()].map(tool => ({ ...tool, sourceInfo: { path: sources.get(tool.name) ?? "foreign-extension" } })),
  } as unknown as ExtensionAPI;
  principalLeases(pi, { async exec() { throw new Error("no shell in this fixture"); } });
  pi.registerTool(guardDefinition({ name: "bounded_write", label: "bounded write", description: "Controlled writer",
    parameters: Type.Object({}), async execute(_id, _input, _signal, _update, ctx) {
      writeFileSync(path.join(ctx.cwd, "output.ts"), "bounded effect\n");
      return { content: [{ type: "text", text: "written" }], details: {} };
    } }, "write"));
  // Controlled external definitions/results; source metadata is the host registry boundary.
  const externalNames = ["lsp_rename", "unknown_navigation", "codemode", "task_status",
    "orchestrator_capabilities", "delegate_task", "tool_search", "apply_patch"];
  let externalCalls = 0;
  for (const name of ["read", "codegraph_explore", "lsp_symbols", ...externalNames]) {
    sources.set(name, path.join(packageRoot(), name.startsWith("codegraph_") ?
      "node_modules/@vndv/pi-codegraph/extensions/codegraph.ts" : "node_modules/pi-lsp-client/src/index.ts"));
    tools.set(name, { name, parameters: Type.Object({}), async execute() {
      externalCalls++;
      return { content: [{ type: "text", text: readFileSync(path.join(root, "input.ts"), "utf8") }], details: {} };
    } });
  }
  sources.set("read", "builtin:read");
  writeFileSync(path.join(root, "input.ts"), "export const answer = 42;\n");
  const invoke = async (name: string, input: object, native: SessionManager, cwd = root) => {
    const ctx = { cwd, sessionManager: native }, event = { toolCallId: name, toolName: name, input };
    const admission = await hooks.get("tool_call")!(event, ctx);
    if (admission?.block) throw new Error(admission.reason);
    try { return await tools.get(name).execute(name, input, undefined, undefined, ctx); }
    finally { await hooks.get("tool_result")!(event, ctx); }
  };
  let planning: ReturnType<typeof openPlanActivity> | undefined, unbindPlanning = () => {};
  let execution: ReturnType<typeof openExecuteActivity> | undefined, unbindExecution = () => {};
  try {
    const cwd = path.join(root, "session-cwd");
    mkdirSync(cwd);
    expect(realpathSync(cwd)).not.toBe(realpathSync(process.cwd()));
    const beforeWrite = new Set(attempt.store.all<{ reservationId: string }>("reservations").map(r => r.reservationId));
    await invoke("bounded_write", {}, child, cwd);
    expect(readFileSync(path.join(cwd, "output.ts"), "utf8")).toBe("bounded effect\n");
    const scopes = attempt.store.all<{ reservationId: string; paths: string[] }>("reservations")
      .filter(r => !beforeWrite.has(r.reservationId)).flatMap(r => r.paths);
    expect(new Set(scopes)).toEqual(new Set([realpathSync(cwd)]));
    const before = attempt.store.all("reservations");
    for (const name of ["codegraph_explore", "lsp_symbols"]) {
      expect(JSON.stringify(await invoke(name, {}, child))).toContain("answer = 42");
    }
    expect(attempt.store.all("reservations")).toEqual(before);
    expect(JSON.stringify(await invoke("read", {}, manager))).toContain("answer = 42");
    for (const name of externalNames) {
      expect(JSON.stringify(await invoke(name, {}, manager, cwd))).toContain("answer = 42");
      expect(JSON.stringify(await invoke(name, {}, child, cwd))).toContain("answer = 42");
    }
    sources.set("codegraph_explore", "foreign-extension");
    expect(JSON.stringify(await invoke("codegraph_explore", {}, child))).toContain("answer = 42");
    const registry = pi.getAllTools;
    try {
      pi.getAllTools = undefined!;
      expect(JSON.stringify(await invoke("tool_search", {}, manager, cwd))).toContain("answer = 42");
    } finally { pi.getAllTools = registry; }
    expect(attempt.store.all("reservations")).toEqual(before);
    // Compositions still pass their nested native calls through admission.
    tools.get("codemode").execute = () => invoke("write", { path: "composed.ts", content: "nested effect\n" }, manager, cwd);
    await invoke("codemode", {}, manager, cwd);
    expect(readFileSync(path.join(cwd, "composed.ts"), "utf8")).toBe("nested effect\n");
    await expect(invoke("write", { path: path.join(root, "..", "outside.ts"), content: "forbidden" }, child))
      .rejects.toThrow("invalid parent reservation");
    await invoke("write", { path: "inside.ts", content: "authorized\n" }, child);
    expect(readFileSync(path.join(root, "inside.ts"), "utf8")).toBe("authorized\n");
    // An explicitly selected external target remains valid for the principal;
    // the bounded child's attempt cannot acquire that same scope.
    await invoke("write", { path: path.join(external, "explicit.ts"), content: "external effect\n" }, manager);
    expect(readFileSync(path.join(external, "explicit.ts"), "utf8")).toBe("external effect\n");
    expect(() => reserveOperation(external, "writer", attempt.context)).toThrow("invalid parent reservation");
    attempt.result({ status: "completed", result: "controlled navigation and edit" });
    attempt.producer.observe("preparation", "closed");
    attempt.producer.observe("host-operation", "closed");
    expect(attempt.producer.observe("callback", "closed", true)).toBeDefined();
    unbind();
    await expect(invoke("read", {}, manager)).rejects.toThrow(/retired/);
    await expect(invoke("lsp_symbols", {}, child)).rejects.toThrow(/retired or replaced/);
    for (const name of externalNames) {
      await expect(invoke(name, {}, child)).rejects.toThrow(/retired or replaced/);
      await expect(invoke(name, {}, manager)).rejects.toThrow(/retired/);
    }
    planning = openPlanActivity("independent", root, snapshotPlan("independent", root), manager, manager.getSessionId());
    unbindPlanning = bindCallContext(manager, planning.context);
    expect(JSON.stringify(await invoke("lsp_symbols", {}, manager))).toContain("answer = 42");
    expect(JSON.stringify(await invoke("read", {}, manager))).toContain("answer = 42");
    const beforeRejected = externalCalls, managedReservations = planning.guard.store.all("reservations");
    for (const name of externalNames) {
      await expect(invoke(name, {}, manager)).rejects.toThrow("generic mutations are unavailable");
    }
    expect(externalCalls).toBe(beforeRejected);
    expect(planning.guard.store.all("reservations")).toEqual(managedReservations);
    await planning.retire();
    for (const name of externalNames) {
      await expect(invoke(name, {}, manager)).rejects.toThrow(/retired/);
    }
    unbindPlanning();
    const file = planFile("execution", root);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "---\nid: execution\nrevision: 1\nstatus: frozen\n---\n\n# Controlled execution\n");
    execution = openExecuteActivity(openExecutionPlan("execution", root, { createLedger: true }), manager, manager.getSessionId());
    unbindExecution = bindCallContext(manager, execution.context);
    for (const name of externalNames) {
      await expect(invoke(name, {}, manager)).rejects.toThrow("trusted effect adapter is required");
    }
    expect(externalCalls).toBe(beforeRejected);
  } finally {
    unbindChild(); unbindExecution(); unbindPlanning(); unbind();
    if (!attempt.receipt()) {
      attempt.producer.observe("preparation", "closed");
      attempt.producer.observe("host-operation", "closed");
      attempt.producer.observe("callback", "closed", true);
    }
    await planning?.retire();
    await execution?.retire();
    if (principal.kind === "ordinary") principal.guard.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

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
