/**
 * Synchronous SQLite for Pi's Node runtime (`node:sqlite`) and Bun tests (`bun:sqlite`).
 * Node is loaded with createRequire so Pi's jiti loader can open it. Bun's module name
 * stays a runtime string so Node does not try to resolve it.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface SqlStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { lastInsertRowid: number; changes: number };
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

const BUSY_TIMEOUT_MS = 5000;

interface SyncDb {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes?: number };
  };
  close(): void;
}

export async function openSqlite(file: string): Promise<SqlDatabase> {
  const db = typeof Bun !== "undefined" ? await openBun(file) : openNode(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  return wrap(db);
}

function openNode(file: string): SyncDb {
  const mod = require("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { enableForeignKeyConstraints?: boolean; timeout?: number },
    ) => SyncDb;
  };
  return new mod.DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: BUSY_TIMEOUT_MS });
}

async function openBun(file: string): Promise<SyncDb> {
  const specifier = "bun:" + "sqlite";
  const mod = (await import(specifier)) as {
    Database: new (path: string, options?: { create?: boolean }) => SyncDb;
  };
  return new mod.Database(file, { create: true });
}

function wrap(db: SyncDb): SqlDatabase {
  return {
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        get(...params) {
          return asRow(statement.get(...params));
        },
        all(...params) {
          return asRows(statement.all(...params));
        },
        run(...params) {
          return insertResult(statement.run(...params));
        },
      };
    },
    close() {
      db.close();
    },
  };
}

function asRow(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`SQLite row was ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("SQLite all() did not return an array");
  return value.map((row) => {
    const parsed = asRow(row);
    if (!parsed) throw new Error("SQLite returned an empty row");
    return parsed;
  });
}

function insertResult(value: { lastInsertRowid?: number | bigint; changes?: number }): {
  lastInsertRowid: number;
  changes: number;
} {
  const id = value.lastInsertRowid;
  const lastInsertRowid = typeof id === "bigint" ? Number(id) : id;
  if (typeof lastInsertRowid !== "number" || !Number.isSafeInteger(lastInsertRowid)) {
    throw new Error("SQLite did not return an integer row id");
  }
  return { lastInsertRowid, changes: value.changes ?? 0 };
}
