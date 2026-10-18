import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { completePitakoConfig } from "../extensions/roles/complete.ts";
import { loadPitakoConfig } from "../extensions/roles/load.ts";
import { planConfigCompletion } from "../extensions/roles/config-completion.ts";

function fixture(run: (file: string, root: string) => void) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pitako-completion-files-"));
  try { run(path.join(root, "agent/pitako/config.toml"), root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function seed(file: string, source = "# private user\nworker_history.ttl_days = false\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, source);
}
const finish = (file: string, current = () => true) => completePitakoConfig({ userConfigPath: file }, current);
function leftovers(file: string) {
  return fs.readdirSync(path.dirname(file)).filter(name => name.endsWith(".tmp") || name.endsWith(".lock"));
}

for (const existing of [false, true])
  test(`${existing ? "preserves existing" : "restricts new"} config directory modes under permissive umask`, () => fixture((file, root) => {
    const ancestor = path.join(root, "agent"), directory = path.dirname(file);
    if (existing) {
      fs.mkdirSync(directory, { recursive: true });
      fs.chmodSync(ancestor, 0o751); fs.chmodSync(directory, 0o750);
    }
    execFileSync(process.execPath, ["-e", `
      import { completePitakoConfig } from ${JSON.stringify(new URL("../extensions/roles/complete.ts", import.meta.url).href)};
      process.umask(0);
      const result = completePitakoConfig({ userConfigPath: ${JSON.stringify(file)} }, () => true);
      if (result.state !== "completed") throw new Error(JSON.stringify(result));
    `], { timeout: 10_000, env: { ...process.env, BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" } });
    expect(fs.statSync(ancestor).mode & 0o7777).toBe(existing ? 0o751 : 0o700);
    expect(fs.statSync(directory).mode & 0o7777).toBe(existing ? 0o750 : 0o700);
    expect(fs.statSync(file).mode & 0o7777).toBe(0o600);
    expect(leftovers(file)).toEqual([]);
  }));

test("creates absent config, preserves effective defaults, repeats without any filesystem writes", () => fixture(file => {
  const before = loadPitakoConfig({ userConfigPath: file });
  expect(fs.existsSync(path.dirname(file))).toBe(false);
  expect(finish(file).state).toBe("completed");
  expect({ ...before, userConfigPresent: true }).toEqual(loadPitakoConfig({ userConfigPath: file }));
  const stat = fs.statSync(file), source = fs.readFileSync(file);
  const mkdir = spyOn(fs, "mkdirSync"), open = spyOn(fs, "openSync"), rename = spyOn(fs, "renameSync");
  const write = spyOn(fs, "writeFileSync"), link = spyOn(fs, "linkSync"), unlink = spyOn(fs, "unlinkSync");
  try {
    expect(finish(file).state).toBe("unchanged");
    for (const method of [mkdir, open, rename, write, link, unlink]) expect(method).not.toHaveBeenCalled();
    expect(fs.statSync(file).ino).toBe(stat.ino);
    expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs);
    expect(fs.readFileSync(file)).toEqual(source);
  } finally { for (const method of [mkdir, open, rename, write, link, unlink]) method.mockRestore(); }
}));

test("preserves existing mode/ownership and replaces only the resolved symlink target", () => fixture((file, root) => {
  const target = path.join(root, "actual.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(target, "# mine\r\n"); fs.chmodSync(target, 0o640);
  fs.symlinkSync(target, file);
  const before = fs.statSync(target), link = fs.lstatSync(file);
  expect(finish(file).state).toBe("completed");
  const after = fs.statSync(target);
  expect([after.mode, after.uid, after.gid]).toEqual([before.mode, before.uid, before.gid]);
  expect(fs.lstatSync(file).ino).toBe(link.ino);
  expect(fs.readFileSync(target, "utf8")).toStartWith("# mine\r\n");
  expect(leftovers(target)).toEqual([]);
}));

test("symlink validation resolves instructions relative to original user path, not target or temp", () => fixture((file, root) => {
  const target = path.join(root, "actual.toml");
  seed(file, 'roles.developer.instructions = "instructions.md"\n');
  fs.writeFileSync(path.join(path.dirname(file), "instructions.md"), "Fixture instructions");
  fs.renameSync(file, target); fs.symlinkSync(target, file);
  expect(finish(file).state).toBe("completed");
  expect(loadPitakoConfig({ userConfigPath: file }).roles.developer!.instructions).toBe("Fixture instructions");
}));

test("cooperative contention warns and does not steal or delete another lock", () => fixture(file => {
  seed(file); const source = fs.readFileSync(file);
  const lock = `${file}.pitako-completion.lock`; fs.writeFileSync(lock, "other owner");
  expect(finish(file)).toMatchObject({ state: "skipped", warning: expect.stringContaining("contention") });
  expect(fs.readFileSync(lock, "utf8")).toBe("other owner");
  expect(fs.readFileSync(file)).toEqual(source);
}));

test("detected concurrent edits skip before replacement and clean owned files", () => fixture(file => {
  seed(file);
  const original = fs.closeSync;
  let closes = 0;
  const close = spyOn(fs, "closeSync").mockImplementation(fd => {
    original(fd);
    if (++closes === 2) fs.writeFileSync(file, "# concurrent edit\n");
  });
  try { expect(finish(file).state).toBe("skipped"); }
  finally { close.mockRestore(); }
  expect(fs.readFileSync(file, "utf8")).toBe("# concurrent edit\n");
  expect(leftovers(file)).toEqual([]);
}));

for (const edit of ["metadata", "missing-lock", "temp-mode", "temp-bytes"] as const)
  test(`detected ${edit} change skips publication and cleans owned paths`, () => fixture(file => {
    seed(file); const source = fs.readFileSync(file);
    const original = fs.closeSync;
    let closes = 0;
    const close = spyOn(fs, "closeSync").mockImplementation(fd => {
      original(fd);
      if (++closes !== 2) return;
      if (edit === "metadata") fs.chmodSync(file, 0o640);
      else if (edit === "missing-lock") fs.unlinkSync(`${file}.pitako-completion.lock`);
      else {
        const temp = path.join(path.dirname(file), fs.readdirSync(path.dirname(file)).find(name => name.endsWith(".tmp"))!);
        if (edit === "temp-mode") fs.chmodSync(temp, 0o644);
        else fs.writeFileSync(temp, "# modified proposal\n");
      }
    });
    try { expect(finish(file).state).toBe("skipped"); }
    finally { close.mockRestore(); }
    expect(fs.readFileSync(file)).toEqual(source);
    expect(leftovers(file)).toEqual([]);
  }));

test("retargeted symlink skips publication without replacing either target", () => fixture((file, root) => {
  const first = path.join(root, "first.toml"), second = path.join(root, "second.toml");
  seed(file); fs.renameSync(file, first); fs.symlinkSync(first, file); fs.writeFileSync(second, "# other target\n");
  const before = fs.readFileSync(first), original = fs.closeSync;
  let closes = 0;
  const close = spyOn(fs, "closeSync").mockImplementation(fd => {
    original(fd);
    if (++closes === 2) { fs.unlinkSync(file); fs.symlinkSync(second, file); }
  });
  try { expect(finish(file).state).toBe("skipped"); } finally { close.mockRestore(); }
  expect(fs.readFileSync(first)).toEqual(before);
  expect(fs.readFileSync(second, "utf8")).toBe("# other target\n");
  expect(leftovers(first)).toEqual([]);
}));

test("no-replace creation preserves a file appearing at publication", () => fixture(file => {
  const original = fs.linkSync;
  const link = spyOn(fs, "linkSync").mockImplementation((from, to) => {
    fs.writeFileSync(to, "# new editor file\n"); return original(from, to);
  });
  try { expect(finish(file).state).toBe("skipped"); }
  finally { link.mockRestore(); }
  expect(fs.readFileSync(file, "utf8")).toBe("# new editor file\n");
  expect(leftovers(file)).toEqual([]);
}));

test("retired ownership is silent and leaves no lock/temp or replacement", () => fixture(file => {
  expect(finish(file, () => false).state).toBe("retired");
  expect(fs.existsSync(path.dirname(file))).toBe(false);
  seed(file); const source = fs.readFileSync(file);
  for (const retireAt of [2, 3, 4, 5]) {
    let calls = 0;
    expect(finish(file, () => ++calls < retireAt).state).toBe("retired");
    expect(fs.readFileSync(file)).toEqual(source);
    expect(leftovers(file)).toEqual([]);
  }
}));

for (const operation of ["writeFileSync", "fchmodSync", "renameSync"] as const)
  test(`explicit ${operation} failure preserves original and cleans owned paths`, () => fixture(file => {
    seed(file); const source = fs.readFileSync(file);
    const method = spyOn(fs, operation).mockImplementation(() => { throw new Error("fixture permission/publication failure"); });
    try { expect(() => finish(file)).toThrow("fixture permission/publication failure"); }
    finally { method.mockRestore(); }
    expect(fs.readFileSync(file)).toEqual(source);
    expect(leftovers(file)).toEqual([]);
  }));

test("ownership preservation failure rejects before replacement", () => fixture(file => {
  seed(file); const source = fs.readFileSync(file), original = fs.fstatSync;
  function observedStat(fd: number, options?: fs.StatOptions & { bigint?: false }): fs.Stats;
  function observedStat(fd: number, options: fs.StatOptions & { bigint: true }): fs.BigIntStats;
  function observedStat(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats;
  function observedStat(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
    const observed = original(fd, options);
    if (observed.size > 0 && typeof observed.uid === "number") observed.uid++;
    return observed;
  }
  const stat = spyOn(fs, "fstatSync").mockImplementation(observedStat);
  const chown = spyOn(fs, "fchownSync").mockImplementation(() => { throw new Error("fixture chown denied"); });
  try { expect(() => finish(file)).toThrow("fixture chown denied"); }
  finally { stat.mockRestore(); chown.mockRestore(); }
  expect(fs.readFileSync(file)).toEqual(source);
  expect(leftovers(file)).toEqual([]);
}));

test("read/parse errors are explicit and never create publication artifacts", () => fixture(file => {
  seed(file, "bad = [");
  expect(() => finish(file)).toThrow("invalid TOML");
  expect(leftovers(file)).toEqual([]);
  const read = spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("fixture read denied"); });
  try { expect(() => finish(file)).toThrow("fixture read denied"); } finally { read.mockRestore(); }
}));

test("owned cleanup never unlinks a substituted lock", () => fixture(file => {
  seed(file);
  const original = fs.renameSync;
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    const lock = `${file}.pitako-completion.lock`;
    original(lock, `${lock}.other`); fs.writeFileSync(lock, "replacement owner");
    return original(from, to);
  });
  try { expect(finish(file).state).toBe("completed"); } finally { rename.mockRestore(); }
  expect(fs.readFileSync(`${file}.pitako-completion.lock`, "utf8")).toBe("replacement owner");
}));

test("owned cleanup never unlinks a substituted temporary path", () => fixture(file => {
  seed(file); const source = fs.readFileSync(file), original = fs.closeSync;
  let closes = 0, replaced = "";
  const close = spyOn(fs, "closeSync").mockImplementation(fd => {
    original(fd);
    if (++closes === 2) {
      replaced = path.join(path.dirname(file), fs.readdirSync(path.dirname(file)).find(name => name.endsWith(".tmp"))!);
      fs.renameSync(replaced, `${replaced}.other`);
      fs.writeFileSync(replaced, "another owner");
    }
  });
  try { expect(finish(file).state).toBe("skipped"); } finally { close.mockRestore(); }
  expect(fs.readFileSync(replaced, "utf8")).toBe("another owner");
  expect(fs.readFileSync(file)).toEqual(source);
}));

test("writer refuses dangling links, nonregular and multiply-linked writable targets; reader remains read-only", () => fixture((file, root) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(path.join(root, "missing"), file);
  expect(() => finish(file)).toThrow();
  fs.unlinkSync(file); fs.mkdirSync(file);
  expect(() => finish(file)).toThrow("regular target");
  fs.rmdirSync(file); seed(file); fs.linkSync(file, path.join(root, "other.toml"));
  expect(() => finish(file)).toThrow("multiply linked");
  expect(loadPitakoConfig({ userConfigPath: file }).workerHistory.ttlDays).toBe(false);
  expect(leftovers(file)).toEqual([]);
}));

test("fully exposed config is unchanged even when target is multiply linked", () => fixture((file, root) => {
  seed(file, planConfigCompletion("", { userConfigPath: file }));
  fs.linkSync(file, path.join(root, "other.toml"));
  expect(finish(file).state).toBe("unchanged");
}));
