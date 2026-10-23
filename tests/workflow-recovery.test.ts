import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RootGuard, openExecuteActivity, registerBackgroundAttempt, registerResource, reserveEffect, type AttemptRecord } from "../extensions/workflow-engine.ts";
import { getActivityStatus } from "../extensions/workflow-status.ts";
import { openExecutionPlan, planFile } from "../extensions/workflow.ts";
import { WorkflowState, type Resource, type Reservation, type ReleaseReceipt } from "../extensions/workflow-state.ts";
import { openSqliteSync } from "../extensions/board/sqlite.ts";

for (const status of ["failed", "cancelled"] as const) {
  test(`${status} outcome and lifecycle uncertainty do not reserve paths; exact late effects close independently`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "pitako-t1-resources-"));
    const guard = new RootGuard(root), context = { kind: "ordinary" as const, guard };
    const a = path.join(root, "a"), b = path.join(root, "b");
    mkdirSync(a); mkdirSync(b);
    try {
      const attempt = registerBackgroundAttempt(context, {
        cwd: root, dispatchId: status, instanceId: status, roleId: "developer",
      });
      expect(guard.store.all("reservations")).toEqual([]);
      expect(guard.store.get<AttemptRecord>("attempts", status)?.resource).toEqual(attempt.producer.ref);
      attempt.admit();
      const sdk = registerResource(attempt.context, "controlled SDK", ["sdk-history", "callback"]);
      sdk.enter();
      const effect = reserveEffect(attempt.context, { reservationId: "actual-effect", kind: "writer", paths: [a] })
        .register("controlled physical effect", ["external-effects"]);
      effect.enter();
      attempt.result({ status, result: "diagnostic, not acceptance" });
      sdk.observe("sdk-history", "unknown");
      sdk.observe("callback", "closed", true);
      effect.observe("external-effects", "unknown", true);
      for (const scope of ["preparation", "callback", "host-operation"] as const)
        attempt.producer.observe(scope, "closed", scope === "host-operation");
      expect(attempt.receipt()).toBeUndefined();
      guard.assertIdle([b]);
      expect(() => guard.assertIdle([a])).toThrow(/operation lease actual-effect: closure unknown/);
      const independent = reserveEffect(context, { reservationId: "independent", kind: "gates", paths: [b] })
        .register("independent", ["host-operation"]);
      independent.enter(); independent.observe("host-operation", "closed", true);
      const reader = new WorkflowState(root);
      try {
        expect(reader.closureReceipt(attempt.producer.ref)).toBeUndefined();
        expect(reader.get<AttemptRecord>("attempts", status)?.outcome?.status).toBe(status);
        expect(reader.all("holds")).toEqual([]);
        sdk.observe("sdk-history", "closed");
        expect(attempt.receipt()).toBeUndefined(); // External effect still owns only a.
        effect.observe("external-effects", "closed");
        const receipt = attempt.receipt()!;
        expect(reader.verifyClosureReceipt(receipt)).toBe(true);
        expect(receipt.dependencies.map(r => r.resourceId).sort()).toEqual([sdk.ref.resourceId, effect.ref.resourceId].sort());
        expect(reader.verifyClosureReceipt({ ...receipt, resource: { ...receipt.resource, generation: 2 } })).toBe(false);
        guard.assertIdle([a]);
        expect(reader.get<AttemptRecord>("attempts", status)?.outcome?.status).toBe(status);
      } finally { reader.close(); }
    } finally { guard.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("status separates failed history, lifecycle evidence and concrete restrictions through late closure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-t1-status-")), file = planFile("status", root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "---\nid: status\nrevision: 1\nstatus: frozen\n---\nStatus fixture.\n");
  const owner = openExecuteActivity(openExecutionPlan("status", root, { createLedger: true }), {}, "status");
  const attempt = registerBackgroundAttempt({ kind: "managed", authority: owner.authority },
    { cwd: root, dispatchId: "failed", instanceId: "failed", roleId: "developer" });
  attempt.admit();
  const lifecycle = registerResource(attempt.context, "controlled SDK", ["sdk-history"]);
  lifecycle.enter();
  const effect = reserveEffect(attempt.context, { reservationId: "actual-file", kind: "writer", paths: [path.join(root, "output")] })
    .register("file writer", ["external-effects"]);
  effect.enter();
  try {
    attempt.result({ status: "failed", result: "Keep diagnostic outcome" });
    lifecycle.observe("sdk-history", "unknown", true);
    effect.observe("external-effects", "unknown", true);
    for (const scope of ["preparation", "callback", "host-operation"] as const)
      attempt.producer.observe(scope, "closed", scope === "host-operation");
    const unknown = getActivityStatus(owner.read);
    expect(unknown.state).toBe("active"); // A failed attempt is not a blocked run.
    expect(unknown.attempts).toMatchObject([{ dispatchId: "failed", outcome: { status: "failed" }, closure: "open" }]);
    expect(unknown.evidence.find(row => row.adapter === "controlled SDK")).toMatchObject({ closure: "unknown" });
    expect(unknown.restrictions).toEqual([{ reservationId: "actual-file", kind: "writer",
      paths: [path.join(root, "output")], state: "unknown", reason: "file writer/external-effects: unknown" }]);
    expect(unknown).not.toHaveProperty("holds");
    await owner.retire();
    lifecycle.observe("sdk-history", "closed");
    effect.observe("external-effects", "closed");
    const closed = getActivityStatus(owner.read);
    expect(closed.attempts).toMatchObject([{ outcome: { status: "failed", result: "Keep diagnostic outcome" }, closure: "closed" }]);
    expect(closed.restrictions).toEqual([]);
    expect(closed.diagnostics).toEqual([]);
    expect(closed.evidence.every(row => row.closure === "closed")).toBe(true);
  } finally {
    if (lifecycle.live) lifecycle.observe("sdk-history", "closed", true);
    if (effect.live) effect.observe("external-effects", "closed", true);
    await owner.retire();
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema 1 migration preserves legacy bytes and receipts, drops only redundant lifecycle exclusion, and invents no closure", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-t1-migration-"));
  const initial = new WorkflowState(root), file = initial.file;
  initial.close();
  const db = openSqliteSync(file);
  const put = (table: string, id: string, value: unknown) => db.prepare(`INSERT INTO ${table}(id,body) VALUES (?,?)`).run(id, JSON.stringify(value));
  const legacyReservation = (id: string, state: Reservation["state"] = "unknown") => ({
    reservationId: id, kind: "writer", paths: [root], generation: 7, ownerId: "old-host", runId: null,
    state, reason: "legacy producer unavailable",
  });
  const legacyResource = (id: string, adapter: string, scopes: string[], facts = {}) => ({
    resourceId: id, producerId: `producer:${id}`, reservationId: id, generation: 7,
    adapter, purpose: "work", scopes, facts, entered: true, sealed: true,
  });
  const original = legacyResource("legacy", "background-attempt", ["preparation", "callback", "host-operation"]);
  const physical = legacyResource("physical", "external-child", ["child-leader", "child-streams", "external-effects"]);
  const lifecycle = legacyResource("lifecycle", "planning-slot", ["host-operation"]);
  const sdk = legacyResource("sdk", "Pi SDK session attempt", ["sdk-history", "session-shutdown"]);
  const archive = { ...legacyResource("archive", "table-archive", ["host-operation", "callback"]),
    reservationId: "legacy" };
  const finished = legacyResource("finished", "writer", ["host-operation"], { "host-operation": "closed" });
  const oldReceipt: ReleaseReceipt = { receiptId: "historical", reservationId: "finished", generation: 7, commitSequence: 1, scopes: ["host-operation"] };
  try {
    db.exec("PRAGMA user_version = 1");
    for (const resource of [original, physical, lifecycle, sdk, finished]) {
      put("resources", resource.resourceId, resource);
      put("reservations", resource.reservationId, legacyReservation(resource.reservationId, resource === finished ? "released" : "unknown"));
    }
    put("resources", archive.resourceId, archive);
    put("receipts", oldReceipt.receiptId, oldReceipt);
    put("holds", "historical-hold", { status: "failed", cleared: false });
  } finally { db.close(); }
  const migrated = new WorkflowState(root);
  try {
    expect(migrated.verifyReceipt(oldReceipt)).toBe(true);
    expect(migrated.get<ReleaseReceipt>("receipts", "historical")).toEqual(oldReceipt);
    // The old shared root lease also hosted an archive: its physical footprint
    // cannot be removed just because the background-attempt parent is lifecycle-only.
    expect(migrated.get<Reservation>("reservations", "legacy")?.exclusionRetired).toBeUndefined();
    expect(migrated.get<Reservation>("reservations", "lifecycle")?.exclusionRetired).toBe("redundant-lifecycle");
    expect(migrated.get<Reservation>("reservations", "sdk")?.exclusionRetired).toBeUndefined();
    expect(migrated.get<Reservation>("reservations", "physical")?.state).toBe("unknown");
    expect(migrated.get<Reservation>("reservations", "physical")?.exclusionRetired).toBeUndefined();
    expect(migrated.get<Resource>("resources", "legacy")?.hostProcess).toBeUndefined();
    expect(migrated.closureReceipt(original)).toBeUndefined();
    expect(migrated.closureReceipt(physical)).toBeUndefined();
    expect(migrated.closureReceipt(sdk)).toBeUndefined();
    expect(migrated.closureReceipt(archive)).toBeUndefined();
    expect(migrated.outbox().find(e => e.target === "migration:legacy")?.body).toEqual({ kind: "original-resource", resource: original });
    expect(migrated.get<{ status: string; cleared: boolean }>("holds", "historical-hold")).toEqual({ status: "failed", cleared: false });
  } finally { migrated.close(); }
  const reopened = new WorkflowState(root);
  try {
    expect(reopened.closureReceipt(original)).toBeUndefined();
    expect(reopened.verifyReceipt(oldReceipt)).toBe(true);
  } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});
