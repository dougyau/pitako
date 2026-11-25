import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalDigest, canonicalJSON } from "../extensions/canonical.mjs";
import { openSqliteSync } from "../extensions/board/sqlite.ts";
import { PitakoStore, StoreError, type StoreHead, type StoreRecord } from "../extensions/pitako-store.ts";
import { checkoutEvidence } from "../extensions/spec-plans.ts";
import { gitFakeFixture } from "./fixtures/git-fake-fixture.ts";
import pitakoStoreTool, { readStorePage } from "../extensions/pitako-store-tool.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let fake: ReturnType<typeof gitFakeFixture>;
const roots: string[] = [];
type ChildRun = { child: ChildProcess; exited: Promise<{ code: number | null; stdout: string; stderr: string }> };
const children: ChildRun[] = [];
beforeEach(() => { fake = gitFakeFixture(); });
afterEach(async () => {
  await Promise.all(children.splice(0).map(({ child, exited }) => settle(child, exited)));
  try { fake.dispose(); }
  finally { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }
});
function root() {
  const dir = mkdtempSync(path.join(tmpdir(), "pitako-store-test-"));
  roots.push(dir);
  fake.fakeRepo(dir, { paths: ["product.txt"] });
  fake.set(dir, ["rev-parse", "--git-path", "info/exclude"],
    { stdout: ".git/info/exclude\n", stderr: "", status: 0 });
  writeFileSync(path.join(dir, "product.txt"), "unchanged\n");
  return dir;
}
const scope = "exec:test.e0";
const project = (rows: readonly StoreRecord[]) => rows.map(row => row.body);
const request = canonicalDigest({ operation: "test" });
function append<P>(store: PitakoStore<P>, expected: StoreHead | undefined, opKey: string, body: unknown, target = scope) {
  return store.commit(target, expected, opKey, request, () => ({ kind: "test", body }));
}
function failure(fn: () => unknown, code: StoreError["code"]) {
  try { fn(); throw new Error(`Expected ${code}`); }
  catch (error) {
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).code).toBe(code);
    return error as StoreError;
  }
}

test("public reader pages exact large records and blobs at a pinned head without writes", async () => {
  const dir = root(), store = new PitakoStore(dir);
  const identity = store.activate(scope);
  let head: StoreHead = null;
  for (let i = 0; i < 55; i++) {
    const result = store.commit(scope, head, `r${i}`, request, () => ({
      kind: i === 0 ? "ledger" : i === 1 ? "receipt" : "test",
      body: i === 2 ? "😀\n\"".repeat(20000) : { i },
    }));
    if (result.outcome !== "appended") throw new Error("Expected append");
    head = result.head;
  }
  const bytes = Buffer.from("binary\0😀".repeat(20000));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const db = openSqliteSync(store.file);
  try {
    db.prepare("INSERT INTO blobs VALUES (?,?,?,?,?)").run(digest, bytes.length, bytes.length, 0, bytes);
  } finally { db.close(); }
  let tool: any;
  pitakoStoreTool({ registerTool(value: unknown) { tool = value; } } as ExtensionAPI);
  expect(tool.annotations.readOnlyHint).toBe(true);
  const call = async (input: object) => {
    const result = await tool.execute("read", input, undefined, undefined, { cwd: dir });
    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50 * 1024);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(50 * 1024);
    expect(result.structuredContent).toEqual(result.details);
    return result.details;
  };
  const evidence = checkoutEvidence(dir), before = readFileSync(store.file);
  expect(await call({ op: "head", scope, head })).toMatchObject({ ...identity, head });
  expect(await call({ op: "verify" })).toMatchObject({ status: "ok", ...identity });
  for (const [op, extra] of [["records", {}], ["record", { seq: 3 }], ["ledger", {}],
    ["receipts", {}], ["blob", { digest }]] as const) {
    let cursor = {}, page;
    const chunks = new Map<number, Buffer[]>();
    do {
      page = await call({ op, scope, head, ...extra, ...cursor });
      expect(page.items.length).toBeLessThanOrEqual(50);
      for (const item of page.items) {
        const parts = chunks.get(item.index) ?? [];
        expect(item.offset).toBe(parts.reduce((n, part) => n + part.length, 0));
        parts.push(Buffer.from(item.data, "base64"));
        chunks.set(item.index, parts);
      }
      cursor = page.next;
    } while (page.next);
    const restored = [...chunks.values()].map(parts => Buffer.concat(parts));
    if (op === "blob") {
      expect(restored).toEqual([bytes]);
      expect(page.truncated).toBe(false);
      expect(page.originalSize).toBe(bytes.length);
    } else {
      const rows = restored.map(value => JSON.parse(value.toString()));
      const expected = store.read(scope, head).records.filter(row =>
        op === "record" ? row.seq === 3 : op === "ledger" ? row.kind === "ledger" :
        op === "receipts" ? row.kind === "receipt" : true);
      expect(rows).toEqual(expected);
    }
  }
  expect(readFileSync(store.file)).toEqual(before);
  const firstPage = readStorePage(dir, { op: "records", scope, limit: 1 });
  if (!("next" in firstPage)) throw new Error("Expected page");
  append(store, head, "later", "outside pinned page");
  const pinned = readStorePage(dir, { op: "records", scope, ...firstPage.next! });
  expect(pinned.head).toEqual(head);
  const stable = readFileSync(store.file);
  const result = await tool.execute("bad", { op: "record", scope, seq: 999 }, undefined, undefined, { cwd: dir });
  expect(result.details).toEqual({ status: "unavailable", code: "store-unavailable" });
  expect(() => readStorePage(dir, { op: "records", scope, limit: 51 })).toThrow("Invalid page bounds");
  expect(readFileSync(store.file)).toEqual(stable);
  expect(checkoutEvidence(dir)).toEqual(evidence);
  const corruptDb = openSqliteSync(store.file);
  try { corruptDb.exec("UPDATE records SET body='null' WHERE seq=1"); }
  finally { corruptDb.close(); }
  const corruptBytes = readFileSync(store.file), files = readdirSync(path.dirname(store.file));
  expect((await tool.execute("corrupt", { op: "records", scope }, undefined, undefined, { cwd: dir })).details)
    .toEqual({ status: "unavailable", code: "store-corrupt" });
  expect(readFileSync(store.file)).toEqual(corruptBytes);
  expect(readdirSync(path.dirname(store.file))).toEqual(files);
  const missing = root();
  expect((await tool.execute("missing", { op: "verify" }, undefined, undefined, { cwd: missing })).details)
    .toEqual({ status: "unavailable", code: "store-unavailable" });
  expect(existsSync(path.join(missing, ".pi"))).toBe(false);
});

test("durable canonical chain, head-bounded replay, CAS outcomes and transactional rollback", async () => {
  const dir = root(), store = new PitakoStore(dir, project);
  const evidence = checkoutEvidence(dir);
  const identity = store.activate(scope);
  const first = append(store, null, "first", { z: 1, a: "original" });
  if (first.outcome !== "appended") throw new Error("Expected append");
  const second = append(store, first.head, "second", { later: true });
  if (second.outcome !== "appended") throw new Error("Expected append");
  const reopened = new PitakoStore(dir, project, identity);
  const replay = reopened.commit(scope, null, "first", request, () => { throw new Error("Must not run on replay"); });
  expect(replay).toEqual({ ...first, outcome: "replay" });
  expect(reopened.read(scope, first.head).P).toEqual([{ a: "original", z: 1 }]);
  expect(store.commit(scope, second.head, "first", canonicalDigest("different"), () => {
    throw new Error("Must not run on conflict");
  }).outcome).toBe("replay-differs");
  expect(append(store, first.head, "stale", null)).toEqual({
    outcome: "stale", head: second.head, P: [{ a: "original", z: 1 }, { later: true }], identity,
  });
  expect(append(store, null, "stale-genesis", null).outcome).toBe("stale");
  expect(() => store.commit(scope, second.head, "failed", request, () => { throw new Error("callback failed"); }))
    .toThrow("callback failed");
  const failingProjection = new PitakoStore(dir, () => { throw new Error("projection failed"); });
  const metadata = failingProjection.readRecords(scope, first.head);
  expect(metadata.head).toEqual(first.head);
  expect(metadata.records.map(row => row.body)).toEqual([{ a: "original", z: 1 }]);
  expect(() => append(failingProjection, second.head, "rolled-back", "not committed")).toThrow("projection failed");
  // A chain-valid but inconsistent execute projection must fail before loop-io effects.
  const { withExecuteStore, commitExecute } = await import("../skills/execute/ledger.mjs");
  const executeRoot = root(), executeStore = new PitakoStore(executeRoot);
  executeStore.activate(scope);
  executeStore.commit(scope, null, "bad-projection", request, () => ({ kind: "operation", body: {} }));
  const beforeProjectionFailure = readFileSync(executeStore.file);
  let effects = 0;
  await expect(withExecuteStore(executeRoot, "test", () => {
    commitExecute(executeRoot, "test", "must-not-write", request, "test", {});
    effects++;
  })).rejects.toThrow();
  expect(effects).toBe(0);
  expect(readFileSync(executeStore.file)).toEqual(beforeProjectionFailure);
  expect(store.read(scope).head).toEqual(second.head);
  expect(store.verify()).toEqual(identity);

  const db = openSqliteSync(store.file, { readOnly: true });
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name))
      .toEqual(["active", "blobs", "meta", "records"]);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    const row = db.prepare("SELECT * FROM records WHERE seq=1").get()!;
    expect(row.body).toBe(canonicalJSON({ a: "original", z: 1 }));
    expect(row.bodyDigest).toBe(canonicalDigest({ a: "original", z: 1 }));
    expect(row.digest).toBe(canonicalDigest({
      scope, seq: 1, kind: "test", opKey: "first", requestDigest: request, bodyDigest: row.bodyDigest, prev: null,
    }));
  } finally { db.close(); }
  store.activate("exec:replacement.e0");
  expect(append(store, second.head, "superseded", null).outcome).toBe("superseded");
  expect(append(store, null, "first", null).outcome).toBe("superseded");
  expect(store.read(scope).head).toEqual(second.head);
  expect(readFileSync(path.join(dir, ".git/info/exclude"), "utf8")).toBe("/.pi/pitako/\n");
  expect(checkoutEvidence(dir)).toEqual(evidence);
  const sessionScope = "exec:session.e0";
  store.activate(sessionScope);
  await store.withSession(() => {
    const original = append(store, null, "session-first", { original: true }, sessionScope);
    if (original.outcome !== "appended") throw new Error("Expected append");
    const later = append(store, original.head, "session-next", { next: true }, sessionScope);
    expect(later.outcome).toBe("appended");
    expect(store.read(sessionScope, original.head).P).toEqual([{ original: true }]);
    const read = store.read(sessionScope);
    expect(Object.isFrozen(read.records)).toBe(true);
    expect(function () { "use strict"; (read.records[0]!.body as any).original = false; }).toThrow();
    (original.result as any).original = false;
    (read.P[0] as any).original = false;
    expect(store.read(sessionScope, original.head).P).toEqual([{ original: true }]);
    expect(append(store, null, "session-first", { original: true }, sessionScope))
      .toEqual({ ...original, result: { original: true }, outcome: "replay" });
    // An unchanged head does not conceal a body edit by a different connection.
    const external = openSqliteSync(store.file);
    try { external.prepare("UPDATE records SET body=? WHERE scope=? AND seq=1")
      .run('{"tampered":true}', sessionScope); }
    finally { external.close(); }
    failure(() => store.read(sessionScope), "store-corrupt");
  });
});

test("interrupted exclusion temp files never block creation or duplicate an existing exclusion", () => {
  for (const contents of ["# existing", "# existing\n/.pi/pitako/\n"]) {
    const dir = root(), store = new PitakoStore(dir);
    const exclude = path.join(dir, ".git/info/exclude");
    mkdirSync(path.dirname(exclude), { recursive: true });
    writeFileSync(exclude, contents);
    const interrupted = `${exclude}.pitako-interrupted.tmp`;
    writeFileSync(interrupted, "incomplete exclusion");

    const identity = store.activate(scope);
    expect(store.verify()).toEqual(identity);
    expect(readFileSync(exclude, "utf8")).toBe("# existing\n/.pi/pitako/\n");
    expect(readFileSync(interrupted, "utf8")).toBe("incomplete exclusion");
    expect(existsSync(`${exclude}.lock`)).toBe(false);
  }
});

test("readers never create or quarantine; replacement and wrong cwd remain distinct", async () => {
  const dir = root(), store = new PitakoStore(dir);
  failure(() => store.read(scope), "store-unavailable");
  expect(existsSync(path.join(dir, ".pi"))).toBe(false);
  const oldIdentity = store.activate(scope);
  const committed = append(store, null, "first", 1);
  if (committed.outcome !== "appended") throw new Error("Expected append");
  const before = readFileSync(store.file);
  failure(() => store.read(scope, { seq: 2, hash: "f".repeat(64) }), "cursor-ahead");
  expect(readFileSync(store.file)).toEqual(before);
  expect(readdirSync(path.dirname(store.file)).filter(name => name.includes(".v"))).toEqual([]);
  failure(() => new PitakoStore(root(), undefined, oldIdentity), "wrong-cwd");
  const missingRoot = root();
  const missingBound = new PitakoStore(missingRoot, undefined, { ...oldIdentity, root: missingRoot });
  const missing = failure(() => missingBound.activate(scope), "store-replaced");
  expect(new PitakoStore(missingRoot).verify()).toEqual(missing.recovery!);
  expect(readdirSync(path.dirname(missingBound.file)).filter(name => name.includes(".v"))).toEqual([]);

  const db = openSqliteSync(store.file);
  try { db.prepare("UPDATE meta SET value=? WHERE key='storeId'").run("11111111-1111-4111-8111-111111111111"); }
  finally { db.close(); }
  const bound = new PitakoStore(dir, undefined, oldIdentity);
  const replaced = failure(() => append(bound, committed.head, "next", 2), "store-replaced");
  expect(replaced.recovery?.storeId).not.toBe(oldIdentity.storeId);
  expect(replaced.recovery?.quarantine).toBeUndefined();
  expect(store.read(scope).head).toEqual(committed.head);
  expect(readdirSync(path.dirname(store.file)).filter(name => name.includes(".v"))).toEqual([]);
  const changedRoot = openSqliteSync(store.file);
  try { changedRoot.prepare("UPDATE meta SET value=? WHERE key='rootRealpath'").run("/different/cwd"); }
  finally { changedRoot.close(); }
  const wrongRootBytes = readFileSync(store.file);
  failure(() => store.activate(scope), "wrong-cwd");
  expect(readFileSync(store.file)).toEqual(wrongRootBytes);
  expect(readdirSync(path.dirname(store.file)).filter(name => name.includes(".v"))).toEqual([]);

  const live = new PitakoStore(root());
  const liveIdentity = live.activate(scope);
  await live.withSession(() => {
    expect(append(live, null, "live", 1).outcome).toBe("appended");
    renameSync(path.dirname(live.file), path.dirname(live.file) + "-displaced");
    const replacement = new PitakoStore(live.root);
    const replacementIdentity = replacement.activate("exec:successor.e0");
    const changed = failure(() => live.activate(scope), "store-replaced");
    expect(changed.recovery).toEqual(replacementIdentity);
    expect(changed.recovery?.storeId).not.toBe(liveIdentity.storeId);
    expect(append(replacement, null, "successor", 2, "exec:successor.e0").outcome).toBe("appended");
    expect(readdirSync(path.dirname(live.file)).filter(name => name.includes(".v"))).toEqual([]);
  });
});

test.each(["body", "noncanonical", "chain", "meta", "version", "notadb", "ahead"] as const)(
  "writers recover %s while readers preserve evidence", defect => {
    const dir = root(), store = new PitakoStore(dir);
    let identity = { storeId: "missing", root: dir };
    let head: StoreHead = null;
    if (defect === "notadb") {
      mkdirSync(path.dirname(store.file), { recursive: true });
      writeFileSync(store.file, "not a SQLite database");
    } else {
      identity = store.activate(scope);
      const first = append(store, null, "first", { original: true });
      if (first.outcome !== "appended") throw new Error("Expected append");
      head = first.head;
    }
    if (defect !== "ahead" && defect !== "notadb") {
      const db = openSqliteSync(store.file);
      try {
        if (defect === "noncanonical") {
          // Even a matching raw-body hash and chain cannot admit non-canonical JSON.
          const body = '{ "original": true }';
          const bodyDigest = createHash("sha256").update(body).digest("hex");
          const digest = canonicalDigest({
            scope, seq: 1, kind: "test", opKey: "first", requestDigest: request, bodyDigest, prev: null,
          });
          db.prepare("UPDATE records SET body=?, bodyDigest=?, digest=?").run(body, bodyDigest, digest);
          head = { seq: 1, hash: digest };
        } else db.exec({
          body: "UPDATE records SET body='null'",
          chain: "UPDATE records SET digest='broken'",
          meta: "DELETE FROM meta WHERE key='storeId'",
          version: "PRAGMA user_version=2",
        }[defect]);
      } finally { db.close(); }
    }
    const expected = defect === "ahead" ? { seq: 10, hash: "0".repeat(64) } : head;
    const code = defect === "ahead" ? "cursor-ahead" : "store-corrupt";
    const bytes = readFileSync(store.file), inode = statSync(store.file).ino;
    if (defect === "noncanonical") {
      // Metadata-only projections verify exact bytes without consuming historical bodies.
      const metadata = new PitakoStore(dir, rows => rows.length).read(scope, expected);
      expect(metadata.P).toBe(1);
      failure(() => metadata.records[0]!.body, "store-corrupt");
    } else if (defect === "body" || defect === "chain") {
      failure(() => store.readRecords(scope, expected), code);
      failure(() => new PitakoStore(dir, rows => rows.length).read(scope, expected), code);
    }
    failure(() => store.read(scope, expected), code);
    expect(readFileSync(store.file)).toEqual(bytes);
    expect(statSync(store.file).ino).toBe(inode);
    const writer = defect === "notadb" ? store : new PitakoStore(dir, undefined, identity);
    const error = failure(() => append(writer, expected, "second", 2), code);
    expect(error.recovery?.storeId).not.toBe(identity.storeId);
    const quarantine = error.recovery!.quarantine!;
    expect(quarantine).toContain(`pitako.db.v${defect === "version" ? 2 : defect === "notadb" ? 0 : 1}.`);
    expect(readFileSync(quarantine)).toEqual(bytes);
    expect(statSync(quarantine).ino).toBe(inode);
    expect(store.read(scope).records).toEqual([]);
    expect(store.verify()).toEqual({ storeId: error.recovery!.storeId, root: dir });
    expect(readFileSync(path.join(dir, ".git/info/exclude"), "utf8")).toBe("/.pi/pitako/\n");
});

test("quarantine retains the actual WAL and SHM along with their database", () => {
  const dir = root(), store = new PitakoStore(dir);
  store.activate(scope);
  append(store, null, "first", 1);
  const held = openSqliteSync(store.file);
  try {
    held.exec("UPDATE records SET bodyDigest='broken'; BEGIN; SELECT * FROM records");
    const inodes = ["-wal", "-shm", ""].map(suffix => statSync(store.file + suffix).ino);
    const error = failure(() => append(store, null, "next", 2), "store-corrupt");
    for (const [index, suffix] of ["-wal", "-shm", ""].entries())
      expect(statSync(error.recovery!.quarantine! + suffix).ino).toBe(inodes[index]);
    expect(store.verify().storeId).toBe(error.recovery!.storeId);
  } finally { held.exec("ROLLBACK"); held.close(); }
});

const node = Bun.which("node");
const storeUrl = new URL("../extensions/pitako-store.ts", import.meta.url).href;
const sqliteUrl = new URL("../extensions/board/sqlite.ts", import.meta.url).href;
function nodeChild(source: string): ChildRun {
  if (!node) throw new Error("Store tests require Node >=22.19");
  const child = spawn(node, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = "";
  child.stdout!.setEncoding("utf8").on("data", value => { stdout += value; });
  child.stderr!.setEncoding("utf8").on("data", value => { stderr += value; });
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  const running = { child, exited };
  children.push(running);
  return running;
}
async function settle(child: ChildProcess, exited: Promise<unknown>) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exited;
}

test("writers share initialization when another creator has opened an empty database", async () => {
  const dir = root(), store = new PitakoStore(dir);
  // Creation excludes the store before opening SQLite.
  mkdirSync(path.join(dir, ".git/info"), { recursive: true });
  writeFileSync(path.join(dir, ".git/info/exclude"), "/.pi/pitako/\n");
  mkdirSync(path.dirname(store.file), { recursive: true });
  const creator = nodeChild(`
    import { openSqliteSync } from ${JSON.stringify(sqliteUrl)};
    import { PitakoStore } from ${JSON.stringify(storeUrl)};
    const db = openSqliteSync(${JSON.stringify(store.file)});
    process.send("opened");
    process.once("message", () => {
      db.close();
      const store = new PitakoStore(${JSON.stringify(dir)});
      const result = store.commit("access:creator", undefined, "first", ${JSON.stringify(request)},
        () => ({kind:"test", body:"creator"}));
      console.log(JSON.stringify(result));
      process.disconnect();
    });
  `);
  try {
    const [message] = await Promise.race([
      once(creator.child, "message"),
      creator.exited.then(result => { throw new Error(`Creator exited before ready: ${result.stderr}`); }),
    ]);
    expect(message).toBe("opened");
    const inode = statSync(store.file).ino;
    const identity = store.activate(scope);
    expect(append(store, null, "first", "second writer").outcome).toBe("appended");
    creator.child.send("continue");
    const result = await creator.exited;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "appended", identity });
    expect(store.read("access:creator").records[0]?.body).toBe("creator");
    expect(store.verify()).toEqual(identity);
    expect(statSync(store.file).ino).toBe(inode);
    expect(readdirSync(path.dirname(store.file)).filter(name => name.includes(".v"))).toEqual([]);
    expect(readFileSync(path.join(dir, ".git/info/exclude"), "utf8")).toBe("/.pi/pitako/\n");
  } finally { await settle(creator.child, creator.exited); }
});

test("Bun and Node keyed writers settle independently without staling the execute head", async () => {
  const dir = root(), store = new PitakoStore(dir);
  const identity = store.activate(scope);
  const first = append(store, null, "first", "exec");
  if (first.outcome !== "appended") throw new Error("Expected append");
  const source = `
    import { PitakoStore } from ${JSON.stringify(storeUrl)};
    import { canonicalDigest } from ${JSON.stringify(new URL("../extensions/canonical.mjs", import.meta.url).href)};
    const store = new PitakoStore(${JSON.stringify(dir)});
    const result = store.commit("todo:test", undefined, "node", canonicalDigest("node"),
      () => ({kind:"todo", body:{runtime:process.release.name}}));
    const replay = store.commit("todo:test", undefined, "node", canonicalDigest("node"),
      () => { throw new Error("Replayed callback"); });
    if (replay.outcome !== "replay" || replay.head.hash !== result.head.hash) throw new Error("Replay mismatch");
    store.read(${JSON.stringify(scope)});
    store.verify();
    console.log(JSON.stringify(result));
    process.disconnect();
  `;
  const running = nodeChild(source);
  try {
    expect(append(store, undefined, "bun", { runtime: "bun" }, "access:test").outcome).toBe("appended");
    const result = await running.exited;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).outcome).toBe("appended");
    expect(JSON.parse(result.stdout).identity).toEqual(identity);
    expect(store.read("todo:test").records[0]?.body).toEqual({ runtime: "node" });
    expect(append(store, first.head, "next", "exec2").outcome).toBe("appended");
    expect(() => append(store, null, "invalid", null, "todo:test")).toThrow("Invalid expected head");
  } finally { await settle(running.child, running.exited); }
});

test("a real child-held lock yields transient store-busy, then the same operation commits after release", async () => {
  const dir = root(), store = new PitakoStore(dir, project, undefined, { timeoutMs: 50, attempts: 3 });
  store.activate(scope);
  const holder = nodeChild(`
    import { openSqliteSync } from ${JSON.stringify(sqliteUrl)};
    const db = openSqliteSync(${JSON.stringify(store.file)});
    db.exec("BEGIN IMMEDIATE");
    process.send("locked");
    process.once("message", () => {
      db.exec("ROLLBACK"); db.close(); process.disconnect();
    });
  `);
  try {
    const [message] = await Promise.race([
      once(holder.child, "message"),
      holder.exited.then(result => { throw new Error(`Lock holder exited before ready: ${result.stderr}`); }),
    ]);
    expect(message).toBe("locked");
    let ran = false;
    failure(() => store.commit(scope, null, "busy", request, () => {
      ran = true; return { kind: "test", body: "once" };
    }), "store-busy");
    expect(ran).toBe(false);
    expect(store.read(scope).head).toBeNull();
    holder.child.send("release");
    expect((await holder.exited).code).toBe(0);
    expect(append(store, null, "busy", "once").outcome).toBe("appended");
    expect(store.read(scope).records).toHaveLength(1);
  } finally { await settle(holder.child, holder.exited); }
});
