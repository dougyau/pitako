import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openSqliteSync, type SqlDatabase } from "./board/sqlite.ts";
import { assertPlanId } from "./workflow.ts";
import { AgentClosureError } from "./agent/closure.ts";

export type Activity = "plan" | "execute" | "task";
export type Phase = "planning" | "execution";
export type ResourceScope = "preparation" | "host-operation" | "callback" | "live-input" |
  "sdk-session" | "session-shutdown" | "sdk-history" | "child-leader" | "child-streams" | "external-effects";
export type ResourceRef = { resourceId: string; producerId: string; reservationId: string; generation: number };
export type ReleaseReceipt = {
  receiptId: string; reservationId: string; generation: number; commitSequence: number;
  scopes: readonly ResourceScope[];
};
export type RunFence = { runId: string; ownerId: string; epoch: number; phaseEpoch: number };
export type RunRecord = RunFence & {
  activity: Activity; phase: Phase; planId: string; binding: string; sessionId: string;
  state: "active" | "waiting" | "blocked" | "retiring" | "completed" | "interrupted";
  version: number; selectedUnit: string | null; lastFactAt: string;
  waitRef?: ResourceRef;
  task?: { intentId: string; freezeReceiptRef?: string; executionAcceptanceRef?: string };
};
export type ReservationSpec = {
  reservationId: string; kind: "assignment-writer" | "writer" | "checkpoint" | "gates";
  paths: readonly string[]; parentReservationId?: string; purpose?: "work" | "observation";
};
export type Reservation = ReservationSpec & {
  generation: number; runId: string | null; ownerId: string; state: "active" | "unknown" | "released";
  reason: string | null;
};
export type Resource = ResourceRef & {
  adapter: string; purpose: "work" | "observation"; scopes: ResourceScope[];
  entered: boolean; sealed: boolean; facts: Partial<Record<ResourceScope, "closed" | "unknown">>;
};

const VERSION = 1;
const tables = ["runs", "attempts", "holds", "recoveries", "reservations", "resources", "observations", "receipts", "obligations", "dispositions", "outbox"] as const;
const observers = new Map<string, Set<() => void>>();
const overlaps = (a: string, b: string) => a === b ||
  a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);

/** One physical-root journal. Every reduction is synchronous and fail-closed. */
export class WorkflowState {
  readonly root: string;
  readonly file: string;
  private db: SqlDatabase;
  private failed?: { cause: unknown };
  private reducing = false;
  constructor(root: string) {
    this.root = realpathSync(root);
    const directory = path.join(this.root, ".pitako", "runs");
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, "workflow-state.sqlite");
    this.db = openSqliteSync(this.file, { setWal: false });
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      const integrity = this.db.prepare("PRAGMA quick_check").get();
      if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("workflow store is corrupt");
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      if (version === 0) {
        // A concurrent initializer may commit after the version read. Recheck the schema under the write lock.
        this.db.exec("PRAGMA synchronous = FULL");
        this.transaction(() => {
          const current = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
          if (current === VERSION) return;
          if (current !== 0) throw new Error(`unsupported workflow schema ${current}`);
          if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)
            throw new Error("unversioned workflow schema");
          this.persist(() => this.db.exec(`
            CREATE TABLE runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE attempts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE holds (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE recoveries (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE reservations (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE resources (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE observations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, producer TEXT NOT NULL,
              producer_sequence INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(producer,producer_sequence));
            CREATE TABLE receipts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE obligations (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE dispositions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL,
              binding TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
            PRAGMA user_version = 1;
          `));
        });
      } else if (version !== VERSION) throw new Error(`unsupported workflow schema ${version}`);
      for (const table of tables) this.db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private assertWritable(): void {
    if (this.failed) throw new Error("workflow store unavailable", { cause: this.failed.cause });
  }
  /** Latch SQLite write failures, not domain rejections from the reducer. Reads remain available. */
  private persist<T>(write: () => T): T {
    this.assertWritable();
    try { return write(); }
    catch (cause) { this.failed ??= { cause }; throw cause; }
  }
  transaction<T>(reduce: () => T): T {
    this.assertWritable();
    if (this.reducing) return reduce();
    this.persist(() => this.db.exec("BEGIN IMMEDIATE"));
    this.reducing = true;
    try {
      const value = reduce();
      if (value && typeof (value as { then?: unknown }).then === "function") throw new Error("workflow reduction must not await");
      this.persist(() => this.db.exec("COMMIT"));
      this.reducing = false;
      for (const observe of observers.get(this.file) ?? []) {
        try { observe(); } catch { /* An observer cannot undo a committed transition. */ }
      }
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); }
      catch (cause) { this.failed ??= { cause }; } // Failed rollback also closes admission; preserve the original error.
      throw error;
    } finally { this.reducing = false; }
  }
  subscribe(observe: () => void): () => void {
    let listeners = observers.get(this.file);
    if (!listeners) observers.set(this.file, listeners = new Set());
    listeners.add(observe);
    return () => { listeners.delete(observe); if (!listeners.size) observers.delete(this.file); };
  }
  get<T>(table: typeof tables[number], id: string): T | undefined {
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row.body)) as T : undefined;
  }
  all<T>(table: typeof tables[number]): T[] {
    return this.db.prepare(`SELECT body FROM ${table}`).all().map(row => JSON.parse(String(row.body)) as T);
  }
  put(table: typeof tables[number], id: string, body: unknown): void {
    this.assertWritable();
    const json = JSON.stringify(body);
    this.persist(() => this.db.prepare(`INSERT INTO ${table}(id,body) VALUES (?,?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(id, json));
  }
  fence(fence: RunFence): RunRecord {
    this.assertWritable(); // A healthy consumer connection cannot bypass its owner's latched failure.
    const run = this.get<RunRecord>("runs", fence.runId);
    if (!run || run.ownerId !== fence.ownerId || run.epoch !== fence.epoch || run.phaseEpoch !== fence.phaseEpoch ||
        ["retiring", "completed", "interrupted"].includes(run.state)) throw new Error("workflow owner is retired or stale");
    return run;
  }
  ancestors(reservationId: string): Set<string> {
    const ancestors = new Set<string>();
    let id: string | undefined = reservationId;
    let owner: string | undefined;
    while (id) {
      if (ancestors.has(id)) throw new Error("reservation ancestry cycle");
      const reservation: Reservation | undefined = this.get("reservations", id);
      if (!reservation || reservation.state !== "active" || owner && reservation.ownerId !== owner)
        throw new Error("reservation ancestor is unavailable or retired");
      owner = reservation.ownerId;
      ancestors.add(id);
      id = reservation.parentReservationId;
    }
    return ancestors;
  }
  reserve(spec: ReservationSpec, ownerId: string, fence?: RunFence): Reservation {
    return this.transaction(() => {
      if (fence) this.fence(fence);
      if (this.get("reservations", spec.reservationId)) throw new Error("reservation already exists");
      if (!spec.paths.length || spec.paths.some(p => !path.isAbsolute(p))) throw new Error("reservation requires physical absolute paths");
      const parent = spec.parentReservationId && this.get<Reservation>("reservations", spec.parentReservationId);
      const ancestors = spec.parentReservationId ? this.ancestors(spec.parentReservationId) : new Set<string>();
      if (spec.parentReservationId && (!parent || parent.state !== "active" || parent.ownerId !== ownerId ||
          !spec.paths.every(p => parent.paths.some(base => p === base || p.startsWith(base + path.sep)))))
        throw new Error("invalid parent reservation");
      for (const existing of this.all<Reservation>("reservations").sort((a, b) =>
        Number(b.state === "unknown") - Number(a.state === "unknown"))) {
        if (spec.purpose === "observation") continue;
        if (existing.state === "released" || ancestors.has(existing.reservationId)) continue;
        if (existing.purpose === "observation" && existing.state === "active") continue;
        if (!spec.paths.some(a => existing.paths.some(b => overlaps(a, b)))) continue;
        if (existing.state === "unknown")
          throw new AgentClosureError([new Error(existing.reason ?? "unreleased operation lease")], `operation lease ${existing.reservationId}`);
        if (existing.kind !== "writer" || spec.kind !== "writer")
          throw new Error(`active operation lease (${existing.kind} lease) is occupied: ${existing.reservationId}`);
      }
      const reservation: Reservation = { ...spec, paths: [...spec.paths], generation: 1, runId: fence?.runId ?? null,
        ownerId, state: "active", reason: null };
      this.put("reservations", reservation.reservationId, reservation);
      this.enqueue(`reservation:${reservation.reservationId}`, fence ? JSON.stringify(fence) : ownerId, { kind: "reserved", reservation });
      return reservation;
    });
  }
  resource(reservation: Reservation, spec: Pick<Resource, "adapter" | "scopes" | "purpose">): Resource {
    return this.transaction(() => {
      this.exactReservation(reservation);
      if ((reservation.purpose ?? "work") !== spec.purpose) throw new Error("resource purpose differs from its reservation");
      const resource: Resource = { resourceId: randomUUID(), producerId: randomUUID(),
        reservationId: reservation.reservationId, generation: reservation.generation, ...spec,
        scopes: [...spec.scopes], entered: false, sealed: false, facts: {} };
      if (!resource.adapter || !resource.scopes.length) throw new Error("resource contract required before effect");
      this.put("resources", resource.resourceId, resource);
      return resource;
    });
  }
  enter(ref: ResourceRef): void {
    this.transaction(() => {
      const resource = this.exactResource(ref);
      if (resource.entered || resource.sealed) throw new Error("resource already entered or sealed");
      resource.entered = true;
      this.put("resources", resource.resourceId, resource);
    });
  }
  exactReservation(ref: Pick<Reservation, "reservationId" | "generation">): Reservation {
    const value = this.get<Reservation>("reservations", ref.reservationId);
    if (!value || value.generation !== ref.generation || value.state === "released") throw new Error("stale reservation");
    return value;
  }
  exactResource(ref: ResourceRef): Resource {
    const value = this.get<Resource>("resources", ref.resourceId);
    if (!value || value.producerId !== ref.producerId || value.reservationId !== ref.reservationId ||
        value.generation !== ref.generation) throw new Error("foreign resource");
    return value;
  }
  /** The observation port remains attached to the original resource after owner retirement. */
  observe(ref: ResourceRef, sequence: number, scope: ResourceScope, fact: "closed" | "unknown", seal = false): ReleaseReceipt | undefined {
    return this.transaction(() => {
      const resource = this.exactResource(ref);
      if (!resource.scopes.includes(scope)) throw new Error("scope not declared by resource");
      const previous = this.db.prepare("SELECT body FROM observations WHERE producer=? AND producer_sequence=?").get(ref.producerId, sequence);
      const observation = JSON.stringify({ ref, scope, fact, seal });
      if (previous && previous.body !== observation) throw new Error("producer sequence reused with another observation");
      if (previous) return this.all<ReleaseReceipt>("receipts").find(r =>
        r.reservationId === ref.reservationId && r.generation === ref.generation);
      const lastSequence = Number(this.db.prepare("SELECT max(producer_sequence) AS n FROM observations WHERE producer=?").get(ref.producerId)?.n ?? 0);
      if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) throw new Error("stale producer sequence");
      if (!previous) this.persist(() => this.db.prepare("INSERT INTO observations(producer,producer_sequence,body) VALUES (?,?,?)")
        .run(ref.producerId, sequence, observation));
      resource.facts[scope] = fact;
      resource.sealed ||= seal;
      this.put("resources", resource.resourceId, resource);
      const reservation = this.exactReservation(ref);
      if (fact === "unknown") {
        reservation.state = "unknown"; reservation.reason = `${resource.adapter}/${scope}: unknown`;
        this.put("reservations", reservation.reservationId, reservation);
      }
      const commitSequence = Number(this.db.prepare("SELECT max(sequence) AS n FROM observations").get()?.n);
      const receipt = this.releaseReady(reservation, commitSequence);
      if (receipt) {
        let child = reservation;
        const visited = new Set([child.reservationId]);
        while (child.parentReservationId) {
          const parent = this.get<Reservation>("reservations", child.parentReservationId);
          if (!parent || visited.has(parent.reservationId) || parent.ownerId !== child.ownerId || parent.runId !== child.runId)
            throw new Error("invalid reservation release ancestry");
          visited.add(parent.reservationId);
          if (parent.state === "released" || !this.releaseReady(parent, commitSequence)) break;
          child = parent;
        }
      }
      return receipt; // The child's append port never returns an ancestor's receipt.
    });
  }
  private releaseReady(reservation: Reservation, commitSequence: number): ReleaseReceipt | undefined {
    const resources = this.all<Resource>("resources").filter(r => r.reservationId === reservation.reservationId && r.generation === reservation.generation);
    const children = this.all<Reservation>("reservations").filter(r => r.parentReservationId === reservation.reservationId);
    const receipts = this.all<ReleaseReceipt>("receipts");
    if (!resources.length || !resources.every(r => r.sealed && r.scopes.every(s => r.facts[s] === "closed")) ||
        !children.every(child => child.ownerId === reservation.ownerId && child.runId === reservation.runId &&
          child.state === "released" && receipts.some(receipt => receipt.reservationId === child.reservationId &&
            receipt.generation === child.generation))) return undefined;
    const receipt: ReleaseReceipt = { receiptId: randomUUID(), reservationId: reservation.reservationId,
      generation: reservation.generation, commitSequence,
      scopes: [...new Set(resources.flatMap(r => r.scopes))] };
    reservation.state = "released"; reservation.reason = null;
    this.put("reservations", reservation.reservationId, reservation);
    this.put("receipts", receipt.receiptId, receipt);
    this.enqueue(`reservation:${reservation.reservationId}`, reservation.ownerId, { kind: "released", receipt });
    return receipt;
  }
  verifyReceipt(receipt: ReleaseReceipt): boolean {
    // A second connection observes only committed facts, never the producer's local state.
    const reader = openSqliteSync(this.file, { readOnly: true, setWal: false });
    try {
      reader.exec("PRAGMA busy_timeout = 0");
      const saved = reader.prepare("SELECT body FROM receipts WHERE id=?").get(receipt.receiptId);
      const reservation = reader.prepare("SELECT body FROM reservations WHERE id=?").get(receipt.reservationId);
      return !!saved && saved.body === JSON.stringify(receipt) && !!reservation &&
        JSON.parse(String(reservation.body)).generation === receipt.generation &&
        JSON.parse(String(reservation.body)).state === "released";
    } finally { reader.close(); }
  }
  enqueue(target: string, binding: string, body: unknown): void {
    this.assertWritable();
    const json = JSON.stringify(body);
    this.persist(() => this.db.prepare("INSERT INTO outbox(target,binding,body) VALUES (?,?,?)").run(target, binding, json));
  }
  outbox(): { sequence: number; target: string; binding: string; body: unknown; state: string }[] {
    return this.db.prepare("SELECT * FROM outbox ORDER BY sequence").all().map(row => ({
      sequence: Number(row.sequence), target: String(row.target), binding: String(row.binding),
      body: JSON.parse(String(row.body)), state: String(row.state),
    }));
  }
  project(apply: (entry: ReturnType<WorkflowState["outbox"]>[number]) => "applied" | "not-applicable" | "blocked",
    accepts: (entry: ReturnType<WorkflowState["outbox"]>[number]) => boolean = () => true): void {
    this.assertWritable();
    const blocked = new Set<string>();
    for (const entry of this.outbox()) {
      if (!accepts(entry)) continue;
      if (["applied", "not-applicable"].includes(entry.state) || blocked.has(entry.target)) continue;
      let state: "applied" | "not-applicable" | "blocked";
      let diagnostic: string | undefined;
      try { state = apply(entry); } catch (error) { state = "blocked"; diagnostic = String(error); }
      if (state === "blocked") blocked.add(entry.target);
      // Keep the original fact fields, plus the sink's latest failure. A blocked
      // projection must retain its cause across the owner's lifetime/restart.
      const body = entry.body && typeof entry.body === "object" && !Array.isArray(entry.body)
        ? { ...entry.body, projectionDiagnostic: diagnostic } : entry.body;
      this.transaction(() => {
        this.persist(() => this.db.prepare("UPDATE outbox SET state=?,body=? WHERE sequence=?").run(state, JSON.stringify(body), entry.sequence));
      });
    }
  }
}

/** Long exclusion lives in a different database, never the observation journal. */
export function acquireWorkflowOwner(root: string, planId: string): () => void {
  return acquirePlanLock(root, planId, "workflow-owner");
}
/** Per-plan sink exclusion must not hold the common journal's write lock. */
export function acquirePlanLock(root: string, planId: string,
  kind: "workflow-owner" | "ledger-writer" | "team-holds-projection"): () => void {
  const directory = path.join(realpathSync(root), ".pitako", "runs", assertPlanId(planId));
  mkdirSync(directory, { recursive: true });
  const db = openSqliteSync(path.join(directory, `${kind}.sqlite`), { setWal: false });
  try {
    // Preserve bounded ledger-writer serialization; owners/drainers reject
    // contention immediately. None of these waits owns the common journal.
    db.exec(`PRAGMA busy_timeout = ${kind === "ledger-writer" ? 5000 : 0}; PRAGMA journal_mode = DELETE`);
    if (String(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toLowerCase() !== "delete")
      throw new Error(`${kind} requires DELETE journal mode`);
    db.exec("BEGIN IMMEDIATE");
  } catch (error) { db.close(); throw new Error(`${kind} unavailable (no takeover)`, { cause: error }); }
  let closed = false;
  return () => {
    if (closed) return;
    db.exec("ROLLBACK");
    db.close(); closed = true;
  };
}
