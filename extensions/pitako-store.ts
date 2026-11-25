import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalDigest, canonicalJSON } from "./canonical.mjs";
import { openSqliteSync, type SqlDatabase } from "./board/sqlite.ts";
import { gitPort } from "./git-port.ts";

export const STORE_VERSION = 1;
export type StoreHead = { seq: number; hash: string } | null;
export interface StoreIdentity { storeId: string; root: string }
export interface StoreRecord {
  scope: string;
  seq: number;
  kind: string;
  opKey: string;
  requestDigest: string;
  body: unknown;
  bodyDigest: string;
  prev: string | null;
  digest: string;
}
export type VerifiedStoreRecord = Readonly<Omit<StoreRecord, "body">> & { readonly body: unknown };
export type StoreErrorCode = "store-busy" | "store-corrupt" | "store-unavailable" |
  "store-replaced" | "cursor-ahead" | "wrong-cwd" | "superseded" | "missing-record";
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  recovery?: StoreIdentity & { quarantine?: string };
  constructor(
    code: StoreErrorCode,
    message: string,
    recovery?: StoreIdentity & { quarantine?: string },
  ) { super(message); this.code = code; this.recovery = recovery; }
}
export type CommitResult<P> =
  | { outcome: "appended" | "replay"; head: StoreHead; result: unknown; P: P; identity: StoreIdentity }
  | { outcome: "stale"; head: StoreHead; P: P; identity: StoreIdentity }
  | { outcome: "replay-differs" | "superseded"; identity: StoreIdentity };

const schema = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE records (
  scope TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, opKey TEXT NOT NULL,
  requestDigest TEXT NOT NULL, body TEXT NOT NULL, bodyDigest TEXT NOT NULL,
  prev TEXT, digest TEXT NOT NULL, PRIMARY KEY(scope,seq), UNIQUE(scope,opKey)
);
CREATE TABLE blobs (
  digest TEXT PRIMARY KEY, size INTEGER NOT NULL, originalSize INTEGER NOT NULL,
  truncated INTEGER NOT NULL, bytes BLOB NOT NULL
);
CREATE TABLE active (kind TEXT PRIMARY KEY, scope TEXT NOT NULL);
`;
const headOf = (rows: readonly StoreRecord[]): StoreHead => {
  const last = rows.at(-1);
  return last ? { seq: last.seq, hash: last.digest } : null;
};
const sameHead = (a: StoreHead, b: StoreHead) => a?.seq === b?.seq && a?.hash === b?.hash;
function corrupt(message: string): never { throw new StoreError("store-corrupt", message); }
const busy = (error: unknown) => error instanceof StoreError && error.code === "store-busy" ||
  /SQLITE_BUSY|SQLITE_LOCKED|database (?:is )?(?:busy|locked)/i.test(String(error));
const corruptSql = (error: unknown) =>
  /SQLITE_CORRUPT|SQLITE_NOTADB|not a database|database disk image is malformed|no such (?:table|column)/i.test(String(error));
export const MAX_GATE_LOG_BYTES = 1024 * 1024;
function blobDigest(bytes: Uint8Array, originalSize: number) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Identical retained ends can represent streams of different lengths.
  return originalSize === bytes.length ? sha256 : canonicalDigest({ sha256, originalSize });
}
function checkedBlob(row: Record<string, unknown>, digest: string) {
  const { size, originalSize, truncated, bytes } = row;
  if (!(bytes instanceof Uint8Array) || bytes.length !== size || bytes.length > MAX_GATE_LOG_BYTES ||
      typeof originalSize !== "number" || !Number.isSafeInteger(originalSize) || originalSize < bytes.length ||
      truncated !== Number(originalSize > bytes.length) ||
      (truncated && bytes.length !== MAX_GATE_LOG_BYTES) || blobDigest(bytes, originalSize) !== digest)
    corrupt("Blob digest or metadata mismatch.");
  return { size: bytes.length, originalSize, truncated: Boolean(truncated), bytes: Buffer.from(bytes) };
}

function scopeKind(scope: string): string {
  const match = /^(exec|review|arch|todo|access):.+$/.exec(scope);
  if (!match) throw new Error("Invalid store scope.");
  return match[1]!;
}

function recordHash(row: Omit<StoreRecord, "body" | "digest">): string {
  const { scope, seq, kind, opKey, requestDigest, bodyDigest, prev } = row;
  return canonicalDigest({ scope, seq, kind, opKey, requestDigest, bodyDigest, prev });
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalBody(bytes: string): unknown {
  const body: unknown = JSON.parse(bytes);
  let ordered = true;
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) freeze(child);
    } else {
      let previous: string | undefined;
      for (const key of Object.keys(value)) {
        if (previous !== undefined && previous > key) ordered = false;
        previous = key;
        freeze((value as Record<string, unknown>)[key]);
      }
    }
    Object.freeze(value);
  };
  freeze(body);
  // Parsed objects retain key order except array-index keys. Avoid copying and
  // sorting ordinary canonical bodies; the fallback handles lexicographic indices.
  if ((ordered ? JSON.stringify(body) : canonicalJSON(body)) !== bytes)
    corrupt("Non-canonical record body.");
  return body;
}

function verifiedRows(db: SqlDatabase, scope: string, head?: StoreHead): StoreRecord[] {
  const rows = db.prepare("SELECT * FROM records WHERE scope = ? AND seq <= ? ORDER BY seq")
    .all(scope, head === undefined ? Number.MAX_SAFE_INTEGER : head?.seq ?? 0);
  const records: StoreRecord[] = [];
  for (const row of rows) {
    const bytes = row.body;
    if (typeof bytes !== "string" ||
        createHash("sha256").update(bytes).digest("hex") !== row.bodyDigest)
      corrupt("Record body mismatch.");
    let parsed = false, body: unknown;
    // Verify every stored byte now; parse and freeze bodies only when consumed.
    const record = { ...row, get body() {
      if (!parsed) {
        try { body = canonicalBody(bytes); }
        catch { corrupt("Invalid record body."); }
        parsed = true;
      }
      return body;
    } } as unknown as StoreRecord;
    let digest: string;
    try { digest = recordHash(record); }
    catch { corrupt("Invalid record fields."); }
    if (record.scope !== scope || record.seq !== records.length + 1 ||
        record.prev !== (records.at(-1)?.digest ?? null) || digest !== record.digest)
      corrupt("Record chain mismatch.");
    records.push(Object.freeze(record));
  }
  if (head !== undefined && !sameHead(head, headOf(records)))
    throw new StoreError("cursor-ahead", "Cursor head is absent from the store.");
  return records;
}

export type StoreRecordLocation = { storeId: string; scope: string; seq: number };

function verifyRecordDigest(db: SqlDatabase, identity: StoreIdentity, ref: StoreRecordLocation, digest: string): void {
  if (ref.storeId !== identity.storeId) corrupt("Access record store identity differs.");
  if (!db.prepare("SELECT 1 FROM records WHERE scope=? AND seq=?").get(ref.scope, ref.seq))
    throw new StoreError("missing-record", "Access record does not exist.");
  const row = verifiedRows(db, ref.scope)[ref.seq - 1]!;
  void row.body; // Also enforce canonical form on the referenced body.
  if (row.digest !== digest) corrupt("Access record digest differs.");
}

function excludeStore(root: string): void {
  const exclude = gitPort().read(["rev-parse", "--git-path", "info/exclude"], { cwd: root, encoding: "utf8" }).trim();
  const file = path.resolve(root, exclude);
  mkdirSync(path.dirname(file), { recursive: true });
  const contents = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (contents.split(/\r?\n/).includes("/.pi/pitako/")) return;
  // An interrupted creator may leave a temp file, but cannot block the next writer.
  const temporary = `${file}.pitako-${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx");
  try {
    try {
      writeFileSync(fd, `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}/.pi/pitako/\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export interface StoreBusyPolicy { timeoutMs?: number; attempts?: number }

export type TodoRecordKind = "request" | "step-receipt" | "summary-deletion" | "retired-run";
export function readTodoRecords(cwd: string, invocation: string, kind: TodoRecordKind): readonly unknown[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(invocation) || invocation.includes(".."))
    throw new Error("Invalid execute todo invocation");
  const store = new PitakoStore(cwd);
  if (!existsSync(store.file)) return [];
  return store.readRecords(`todo:${invocation}`).records.filter(row => row.kind === kind).map(row => row.body);
}

/** Only deterministic host writers may call activate/commit.
 * The reducer and commit callback must be pure synchronous functions: effects precede commit.
 */
export class PitakoStore<P = readonly StoreRecord[]> {
  readonly root: string;
  readonly file: string;
  private readonly project: (records: readonly StoreRecord[]) => P;
  private readonly cursor?: StoreIdentity;
  private readonly busyPolicy: StoreBusyPolicy;
  private session?: {
    db?: SqlDatabase; inode?: ReturnType<typeof statSync>; storeId?: string; dataVersion?: number;
    records: Map<string, StoreRecord[]>; pending: Map<string, StoreRecord[]>;
    projections: Map<string, P>; failed?: boolean;
  };
  /** Reuse verified bytes only within one deterministic invocation, never across callers. */
  async withSession<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.session) throw new Error("Store session is already active.");
    const session = this.session = { records: new Map(), pending: new Map(), projections: new Map() } as NonNullable<PitakoStore<P>["session"]>;
    try { return await fn(); }
    finally { this.session = undefined; session.db?.close(); }
  }

  private rows(db: SqlDatabase, scope: string, head?: StoreHead): StoreRecord[] {
    if (!this.session) return verifiedRows(db, scope, head);
    const cached = this.session.records.get(scope) ?? verifiedRows(db, scope);
    const working = cached.slice();
    this.session.pending.set(scope, working);
    const rows = head === undefined ? working : working.slice(0, head?.seq ?? 0);
    if (head !== undefined && !sameHead(head, headOf(rows)))
      throw new StoreError("cursor-ahead", "Cursor head is absent from the store.");
    return rows;
  }
  private projection(rows: StoreRecord[]): P {
    const session = this.session;
    if (!session) return structuredClone(this.project(rows));
    const key = rows.at(-1)?.digest ?? "genesis";
    if (!session.projections.has(key)) session.projections.set(key, this.project(rows));
    return structuredClone(session.projections.get(key)!);
  }
  constructor(
    cwd: string,
    project: (records: readonly StoreRecord[]) => P = rows => rows as P,
    cursor?: StoreIdentity,
    busyPolicy: StoreBusyPolicy = {},
  ) {
    this.project = project;
    this.cursor = cursor;
    this.busyPolicy = busyPolicy;
    this.root = realpathSync(cwd);
    this.file = path.join(this.root, ".pi", "pitako", "pitako.db");
    if (cursor && cursor.root !== this.root) throw new StoreError("wrong-cwd", "Cursor root differs from cwd.");
    for (const value of [busyPolicy.timeoutMs ?? 5000, busyPolicy.attempts ?? 3])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid store busy policy.");
  }

  /** Replaces the fence only on explicit admission, never implicitly on commit or replay. */
  activate(scope: string): StoreIdentity {
    const kind = scopeKind(scope);
    if (kind === "todo" || kind === "access") throw new Error("Keyed append scopes have no active fence.");
    return this.operation(true, (db, identity) => {
      db.prepare("INSERT INTO active(kind,scope) VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET scope=excluded.scope")
        .run(kind, scope);
      return identity;
    });
  }

  commit(
    scope: string, expected: StoreHead | undefined, opKey: string, requestDigest: string,
    fn: (records: readonly StoreRecord[]) => { kind: string; body: unknown },
    { admit = false, restore = false, admitIf }: { admit?: boolean; restore?: boolean;
      admitIf?: (active: readonly StoreRecord[]) => boolean } = {},
  ): CommitResult<P> {
    const kind = scopeKind(scope), keyed = kind === "todo" || kind === "access";
    if (!opKey || !/^[a-f0-9]{64}$/i.test(requestDigest)) throw new Error("Invalid store operation identity.");
    if (keyed ? expected !== undefined : expected === undefined) throw new Error("Invalid expected head for scope.");
    if (admit && (keyed || expected !== null)) throw new Error("Admission requires a fenced genesis.");
    if (restore && !admit) throw new Error("Restoration requires a fenced genesis.");
    return this.operation(true, (db, identity) => {
      const admitGenesis = admit && !db.prepare("SELECT 1 FROM records WHERE scope=? LIMIT 1").get(scope);
      if (admitGenesis && admitIf) {
        const active = db.prepare("SELECT scope FROM active WHERE kind=?").get(kind)?.scope;
        if (typeof active === "string" && !admitIf(this.rows(db, active)))
          return { outcome: "superseded", identity };
      }
      if (!keyed && (!admitGenesis || restore)) {
        const active = db.prepare("SELECT scope FROM active WHERE kind=?").get(kind)?.scope;
        if (active !== scope && !(admitGenesis && restore && active === undefined))
          return { outcome: "superseded", identity };
      }
      const records = this.rows(db, scope);
      const replay = records.find(row => row.opKey === opKey);
      if (replay) {
        if (replay.requestDigest !== requestDigest) return { outcome: "replay-differs", identity };
        const original = records.slice(0, replay.seq);
        return { outcome: "replay", head: headOf(original), result: structuredClone(replay.body), P: this.projection(original), identity };
      }
      const head = headOf(records);
      if (!keyed && !sameHead(expected!, head)) {
        if (expected === null || records.some(row => row.seq === expected?.seq && row.digest === expected.hash))
          return { outcome: "stale", head, P: this.projection(records), identity };
        throw new StoreError("cursor-ahead", "Cursor head is absent from the store.");
      }
      const value = fn(records);
      const body = canonicalJSON(value.body);
      if (!value.kind) throw new Error("Record kind is required.");
      const record: StoreRecord = {
        scope, seq: records.length + 1, kind: value.kind, opKey, requestDigest,
        body: JSON.parse(body), bodyDigest: createHash("sha256").update(body).digest("hex"), prev: head?.hash ?? null, digest: "",
      };
      record.digest = recordHash(record);
      db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?)").run(
        scope, record.seq, record.kind, opKey, requestDigest, body, record.bodyDigest, record.prev, record.digest,
      );
      if (admitGenesis)
        db.prepare("INSERT INTO active(kind,scope) VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET scope=excluded.scope")
          .run(kind, scope);
      records.push(immutable(record));
      return { outcome: "appended", head: headOf(records), result: structuredClone(record.body), P: this.projection(records), identity };
    });
  }

  /** Undefined head is an explicit tip observation; cursor readers must pass their head (including null). */
  readRecords(scope: string, head?: StoreHead, requireActive = false): { identity: StoreIdentity; head: StoreHead; records: readonly VerifiedStoreRecord[] } {
    const kind = scopeKind(scope);
    return this.operation(false, (db, identity) => {
      if (requireActive && db.prepare("SELECT scope FROM active WHERE kind=?").get(kind)?.scope !== scope)
        throw new StoreError("superseded", "Execute scope was superseded.");
      const records = this.rows(db, scope, head);
      return { identity, head: headOf(records), records: Object.freeze(records.slice()) };
    });
  }

  /** Host-side cursor observation; neither creates nor quarantines a store. */
  readActiveReview() {
    return this.operation(false, (db, identity) => {
      const scope = db.prepare("SELECT scope FROM active WHERE kind='review'").get()?.scope;
      if (scope === undefined) return undefined;
      if (typeof scope !== "string" || !scope.startsWith("review:")) corrupt("Invalid review fence.");
      const rows = this.rows(db, scope);
      if (!rows.length) corrupt("Review fence has no final record.");
      return {scope, identity, head: headOf(rows), body: rows[0]!.body};
    });
  }

  verifyRecord(ref: StoreRecordLocation, digest: string): void {
    this.operation(false, (db, identity) => verifyRecordDigest(db, identity, ref, digest));
  }

  readIdentity(): StoreIdentity | null {
    return existsSync(this.file) ? this.operation(false, (_db, identity) => identity) : null;
  }

  /** The fenced writer rechecks an unavailable access reference under its write lock. */
  verifyRecordForWrite(ref: StoreRecordLocation, digest: string, activeScope: string): void {
    this.operation(true, (db, identity) => {
      if (db.prepare("SELECT scope FROM active WHERE kind=?").get(scopeKind(activeScope))?.scope !== activeScope)
        throw new StoreError("superseded", "Execute scope was superseded.");
      try { verifyRecordDigest(db, identity, ref, digest); }
      catch (error) {
        if (error instanceof StoreError && error.code === "missing-record") corrupt(error.message);
        throw error;
      }
    });
  }

  /** Final review rechecks its access receipt without appending or claiming a fence. */
  verifyReviewAccessForWrite<T>(scope: string, authorize: (active: readonly VerifiedStoreRecord[]) => void,
    check: (records: readonly VerifiedStoreRecord[], identity: StoreIdentity) => T): T {
    return this.operation(true, (db, identity) => {
      const active = db.prepare("SELECT scope FROM active WHERE kind='review'").get()?.scope;
      authorize(typeof active === "string" ? this.rows(db, active) : []);
      return check(this.rows(db, scope), identity);
    });
  }

  read(scope: string, head?: StoreHead): { identity: StoreIdentity; head: StoreHead; records: readonly VerifiedStoreRecord[]; P: P } {
    scopeKind(scope);
    return this.operation(false, (db, identity) => {
      const records = this.rows(db, scope, head);
      return { identity, head: headOf(records), records: Object.freeze(records.slice()), P: this.projection(records) };
    });
  }

  verify(): StoreIdentity {
    return this.operation(false, (db, identity) => {
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") corrupt("SQLite integrity check failed.");
      for (const row of db.prepare("SELECT DISTINCT scope FROM records").all()) verifiedRows(db, String(row.scope));
      for (const row of db.prepare("SELECT digest FROM blobs").all())
        checkedBlob(db.prepare("SELECT * FROM blobs WHERE digest=?").get(row.digest)!, String(row.digest));
      return identity;
    });
  }

  /** Deterministic writers recheck read-side failures before quarantining. */
  verifyForWrite(
    validateRecords?: (scope: string, records: readonly VerifiedStoreRecord[]) => void,
    cursor?: { scope: string; head: StoreHead; requiredRecord?: { scope: string; opKey: string };
      matchesScope?: (scope: string) => boolean },
  ): StoreIdentity & { scope?: string } {
    return this.operation(true, (db, identity) => {
      let boundScope: string | undefined;
      const { matchesScope, head } = cursor ?? {};
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") corrupt("SQLite integrity check failed.");
      for (const row of db.prepare("SELECT DISTINCT scope FROM records").all()) {
        const scope = String(row.scope), records = this.rows(db, scope);
        validateRecords?.(scope, records);
        if (head && matchesScope?.(scope) && records[head.seq - 1]?.digest === head.hash)
          boundScope = scope;
      }
      if (cursor) {
        const active = db.prepare("SELECT scope FROM active WHERE kind=?").get(scopeKind(cursor.scope))?.scope;
        // A known older head must still fail the fence. If the active invocation
        // owns the request but the head is absent, check it for cursor-ahead.
        const scope = boundScope ?? (typeof active === "string" && matchesScope?.(active) ? active : cursor.scope);
        if (active !== scope)
          throw new StoreError("superseded", "Execute scope was superseded.");
        this.rows(db, scope, cursor.head);
        const required = cursor.requiredRecord;
        if (required && !this.rows(db, required.scope).some(row => row.opKey === required.opKey))
          corrupt("Missing required store record.");
        if (matchesScope) return { ...identity, scope };
      }
      return identity;
    });
  }

  /** Gate-log writes never advance a workflow head. */
  writeGateLog(bytes: Buffer, originalSize: number, scope?: string): string {
    const digest = blobDigest(bytes, originalSize);
    const truncated = Number(originalSize > bytes.length);
    checkedBlob({ size: bytes.length, originalSize, truncated, bytes }, digest);
    return this.operation(true, db => {
      if (scope && db.prepare("SELECT scope FROM active WHERE kind='exec'").get()?.scope !== scope)
        throw new StoreError("superseded", "Execute scope was superseded.");
      const existing = db.prepare("SELECT * FROM blobs WHERE digest=?").get(digest);
      if (existing) checkedBlob(existing, digest);
      else db.prepare("INSERT INTO blobs VALUES (?,?,?,?,?)").run(digest, bytes.length, originalSize, truncated, bytes);
      return digest;
    });
  }

  /** Truncated blobs bind both the retained bytes and the original size. */
  readBlob(digest: string) {
    if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error("Invalid blob digest.");
    return this.operation(false, (db, identity) => ({ identity, digest, ...this.gateLog(db, digest) }));
  }

  verifyGateLogForWrite(digest: string, scope?: string): void {
    if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error("Invalid blob digest.");
    this.operation(true, db => {
      if (scope && db.prepare("SELECT scope FROM active WHERE kind='exec'").get()?.scope !== scope)
        throw new StoreError("superseded", "Execute scope was superseded.");
      if (!db.prepare("SELECT 1 FROM blobs WHERE digest=?").get(digest)) corrupt("Missing referenced gate log.");
      this.gateLog(db, digest);
    });
  }

  private gateLog(db: SqlDatabase, digest: string) {
    const row = db.prepare("SELECT * FROM blobs WHERE digest=?").get(digest);
    if (!row) throw new StoreError("missing-record", "Blob does not exist.");
    return checkedBlob(row, digest);
  }

  private operation<T>(writer: boolean, fn: (db: SqlDatabase, identity: StoreIdentity) => T): T {
    if (this.session?.failed) throw new StoreError("store-corrupt", "Store invocation already failed.");
    for (let attempt = 0; ; attempt++) {
      let db: SqlDatabase | undefined;
      let observedVersion = 0, observedId = "";
      let inode: ReturnType<typeof statSync> | undefined;
      try {
        const session = this.session;
        db = session?.db;
        inode = statSync(this.file, { throwIfNoEntry: false });
        if (session?.inode && (inode?.ino !== session.inode.ino || inode?.dev !== session.inode.dev))
          throw new StoreError("store-replaced", "Store changed between invocation transactions.");
        const existed = inode !== undefined;
        if (!writer && !existed) throw new StoreError("store-unavailable", "Store does not exist.");
        if (writer && !existed) {
          excludeStore(this.root);
          mkdirSync(path.dirname(this.file), { recursive: true });
        }
        db ??= openSqliteSync(this.file, { readOnly: session ? false : !writer, setWal: false });
        if (session) session.db = db;
        inode ??= statSync(this.file);
        db.exec(`PRAGMA busy_timeout=${this.busyPolicy.timeoutMs ?? 5000}`);
        if (writer) {
          db.exec("PRAGMA journal_mode=WAL");
          db.exec("PRAGMA synchronous=FULL");
        }
        const dataVersion = Number(db.prepare("PRAGMA data_version").get()?.data_version);
        db.exec(writer ? "BEGIN IMMEDIATE" : "BEGIN");
        observedVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version);
        // Another creator may have opened the file; initialize only under the write lock.
        if (writer && observedVersion === 0 &&
            db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length === 0) {
          db.exec(schema);
          db.prepare("INSERT INTO meta VALUES ('storeId',?), ('rootRealpath',?)").run(randomUUID(), this.root);
          db.exec(`PRAGMA user_version=${STORE_VERSION}`);
          observedVersion = STORE_VERSION;
        }
        if (observedVersion !== STORE_VERSION) corrupt("Unsupported store version.");
        observedId = String(db.prepare("SELECT value FROM meta WHERE key='storeId'").get()?.value ?? "");
        const root = db.prepare("SELECT value FROM meta WHERE key='rootRealpath'").get()?.value;
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(observedId) || typeof root !== "string")
          corrupt("Store identity is missing.");
        if (root !== this.root) throw new StoreError("wrong-cwd", "Store root differs from cwd.");
        const identity = { storeId: observedId, root };
        if (session && (session.dataVersion !== dataVersion ||
            Number(db.prepare("PRAGMA data_version").get()?.data_version) !== dataVersion)) {
          // Other writers may have committed to independent scopes. Reverify
          // instead of treating an ordinary WAL commit as corruption.
          session.records.clear();
          session.projections.clear();
        }
        const atOpenedFile = () => {
          const current = statSync(this.file, { throwIfNoEntry: false });
          return inode?.ino === current?.ino && inode?.dev === current?.dev;
        };
        const expectedStoreId = this.cursor?.storeId ?? session?.storeId;
        if (expectedStoreId !== undefined && expectedStoreId !== observedId) {
          if (!atOpenedFile())
            throw new StoreError("store-replaced", "Store changed during operation.");
          // A missing database may just have been initialized; publish its identity before returning it.
          db.exec("COMMIT");
          throw new StoreError("store-replaced", "Store was replaced.", identity);
        }
        // Cache extensions only after COMMIT, including reads of an older prefix.
        session?.pending.clear();
        const result = fn(db, identity);
        if (!atOpenedFile())
          throw new StoreError("store-replaced", "Store changed during operation.");
        db.exec("COMMIT");
        if (session) {
          session.inode = inode;
          session.storeId = observedId;
          session.dataVersion = dataVersion;
          for (const [scope, records] of session.pending) session.records.set(scope, records.slice());
        }
        return result;
      } catch (cause) {
        const error = corruptSql(cause) ? new StoreError("store-corrupt", String(cause)) : cause;
        let quarantine: string | undefined;
        try {
          if (writer && error instanceof StoreError && (error.code === "store-corrupt" || error.code === "cursor-ahead"))
            // Retain the connection/transaction until renames finish so its sidecars survive.
            quarantine = this.quarantine(inode, observedVersion, observedId);
        } finally {
          if (db) {
            try { db.exec("ROLLBACK"); } catch { /* BEGIN failed or transaction ended. */ }
            db.close();
            if (this.session) {
              this.session.db = undefined;
              this.session.records.clear();
              this.session.pending.clear();
              this.session.projections.clear();
              this.session.dataVersion = undefined;
            }
            db = undefined;
          }
        }
        if (busy(cause)) {
          if (writer && attempt + 1 < (this.busyPolicy.attempts ?? 3)) continue;
          throw new StoreError("store-busy", "Store remained busy.");
        }
        if (this.session) this.session.failed = true;
        if (error instanceof StoreError && (quarantine || (error.code === "store-replaced" && !error.recovery))) {
          const fresh = new PitakoStore(this.root, undefined, undefined, this.busyPolicy);
          // Resolve the current store only after closing the displaced connection.
          // Writers may initialize a missing replacement, without claiming a fence.
          const identity = writer ? fresh.operation(true, (_db, identity) => identity) : fresh.readIdentity();
          if (identity) error.recovery = quarantine ? { ...identity, quarantine } : identity;
        }
        throw error;
      } finally { if (!this.session) db?.close(); }
    }
  }

  private quarantine(inode: ReturnType<typeof statSync> | undefined, version: number, storeId: string): string {
    const current = statSync(this.file);
    if (inode && (current.ino !== inode.ino || current.dev !== inode.dev))
      throw new StoreError("store-replaced", "Store changed before quarantine.");
    let target = `${this.file}.v${version}.${storeId.slice(0, 8) || Date.now()}`;
    let stamp = Date.now();
    while (["", "-wal", "-shm"].some(suffix => existsSync(target + suffix)))
      target = `${this.file}.v${version}.${stamp++}`;
    for (const suffix of ["-wal", "-shm", ""]) {
      const check = statSync(this.file);
      if (check.ino !== current.ino || check.dev !== current.dev)
        throw new StoreError("store-replaced", "Store changed during quarantine.");
      if (existsSync(this.file + suffix)) renameSync(this.file + suffix, target + suffix);
    }
    return target;
  }
}
