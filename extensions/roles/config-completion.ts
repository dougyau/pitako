import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import { packageRoot } from "../stack.ts";
import { CONFIG_KEYS } from "./config-keys.ts";
import { parsePitakoConfig, type LoadOptions } from "./load.ts";

const SAFE_GROUPS = ["agent_runtime", "worker_history", "developer_routing", "head_developer"] as const;
type Table = Record<string, unknown>;
interface Setting { keys: string[]; value: unknown; active: boolean }

function table(value: unknown): Table {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected completion catalog table");
  return value as Table;
}

/** Expand actual built-in IDs; validator key sets also define nested example fields. */
export function completionCatalog(root = packageRoot()): Setting[] {
  const defaults = parse(readFileSync(path.join(root, "config/defaults.toml"), "utf8")) as Table;
  const examples = parse(readFileSync(path.join(root, "config/completion-examples.toml"), "utf8")) as Table;
  const entries: Setting[] = [];
  const add = (keys: string[], value: unknown, active = false) => {
    if (value === undefined) throw new Error(`Missing completion example: ${keys.join(".")}`);
    entries.push({ keys, value, active });
  };
  for (const group of SAFE_GROUPS)
    for (const key of CONFIG_KEYS[group]) add([group, key], table(defaults[group])[key], true);
  for (const [id, role] of Object.entries(table(defaults.roles)))
    for (const key of CONFIG_KEYS.role) add(["roles", id, key], table(examples.role)[key] ?? table(role)[key]);
  const target = (keys: Set<string>) => Object.fromEntries([...keys].map(key => {
    if (table(examples.target)[key] === undefined) throw new Error(`Missing target example: ${key}`);
    return [key, table(examples.target)[key]];
  }));
  for (const id of Object.keys(table(defaults.model_policies)))
    for (const key of CONFIG_KEYS.policy) {
      if (key === "primary") {
        for (const field of CONFIG_KEYS.target) add(["model_policies", id, key, field], target(CONFIG_KEYS.target)[field]);
      } else if (key === "fallbacks") add(["model_policies", id, key], [target(CONFIG_KEYS.target)]);
      else throw new Error(`Missing policy example: ${key}`);
    }
  for (const group of ["architecture", "review"]) {
    const candidates = [target(CONFIG_KEYS.candidate)];
    const topic = Object.fromEntries([...CONFIG_KEYS.topic].map(key =>
      [key, key === "candidates" ? candidates : table(examples.topic)[key]]));
    for (const key of CONFIG_KEYS.topic)
      if (topic[key] === undefined) throw new Error(`Missing topic example: ${key}`);
    for (const key of CONFIG_KEYS.candidates) {
      if (key === "candidates") add([group, key], candidates);
      else if (key === "topics") add([group, key], [topic]);
      else throw new Error(`Missing candidate-group example: ${key}`);
    }
  }
  for (const key of CONFIG_KEYS.root)
    if (!entries.some(entry => entry.keys[0] === key)) throw new Error(`Missing completion group: ${key}`);
  return entries;
}

interface Token { text: string; start: number; end: number }
interface Layout {
  comments: Set<string>;
  rootEnd: number;
  explicit: Map<string, number>;
  inline: Map<string, { close: number; comma: boolean }>;
}

/** Lexical positions only. smol-toml validates all syntax and decodes all keys. */
function layout(source: string): Layout {
  const tokens: Token[] = [], comments = new Set<string>();
  let i = 0;
  while (i < source.length) {
    const start = i, c = source[i]!;
    if (c === "#") {
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
      const marker = /^# pitako:setting ([\w.-]+)$/.exec(source.slice(start, i).trim());
      if (marker) comments.add(marker[1]!);
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = source.slice(i, i + 3) === c.repeat(3);
      i += triple ? 3 : 1;
      while (i < source.length) {
        if (c === '"' && source[i] === "\\") { i += 2; continue; }
        if (source.slice(i, i + (triple ? 3 : 1)) === c.repeat(triple ? 3 : 1)) {
          i += triple ? 3 : 1;
          if (triple) while (source[i] === c) i++;
          break;
        }
        i++;
      }
    } else if (c === "\n") i++;
    else if (/\s/.test(c)) { i++; continue; }
    else if ("[]=.,{}".includes(c)) i++;
    else {
      while (i < source.length && !/[\s#"'[\]=.,{}]/.test(source[i]!)) i++;
    }
    tokens.push({ text: source.slice(start, i), start, end: i });
  }
  const result: Layout = { comments, rootEnd: source.length, explicit: new Map(), inline: new Map() };
  let table: string[] = [], previous: string | undefined;
  const decode = (key: string, header = false): string[] => {
    let object: unknown = parse(header ? `${key}\n__completion = 0` : `${key} = 0`);
    const keys: string[] = [];
    while (object && typeof object === "object" && !Array.isArray(object)) {
      const first = Object.keys(object)[0]!;
      if (first === "__completion") break;
      keys.push(first); object = (object as Table)[first];
    }
    return keys;
  };
  for (let t = 0; t < tokens.length;) {
    if (tokens[t]!.text === "\n") { t++; continue; }
    const start = t;
    if (tokens[t]!.text === "[") {
      while (t < tokens.length && tokens[t]!.text !== "\n") t++;
      const end = tokens[t - 1]!.end;
      const header = source.slice(tokens[start]!.start, end);
      if (result.rootEnd === source.length) result.rootEnd = tokens[start]!.start;
      if (previous) result.explicit.set(previous, tokens[start]!.start);
      table = decode(header, true);
      previous = table.length === 1 && !header.startsWith("[[") ? table[0] : undefined;
      if (previous) result.explicit.set(previous, source.length);
      continue;
    }
    while (t < tokens.length && tokens[t]!.text !== "=") t++;
    const equals = t++;
    const keys = decode(source.slice(tokens[start]!.start, tokens[equals]!.start).trim());
    const valueStart = t;
    let depth = 0;
    while (t < tokens.length) {
      const text = tokens[t]!.text;
      if (text === "\n" && depth === 0) break;
      if (text === "{" || text === "[") depth++;
      if (text === "}" || text === "]") depth--;
      t++;
    }
    if (!table.length && keys.length === 1 && tokens[valueStart]?.text === "{") {
      const close = tokens[t - 1]!;
      let last = t - 2;
      while (tokens[last]?.text === "\n") last--;
      const trailing = tokens[last]!.text === ",";
      result.inline.set(keys[0]!, {
        close: trailing ? tokens[last]!.start : close.start,
        comma: tokens[last]!.text !== "{",
      });
    }
  }
  return result;
}

function exposed(raw: Table, keys: string[]): boolean {
  let value: unknown = raw;
  for (const key of keys) {
    if (Array.isArray(value)) return true; // Arrays are wholly user-owned.
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return false;
    value = (value as Table)[key];
  }
  return true;
}

function literal(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (value && typeof value === "object")
    return `{ ${Object.entries(value).map(([key, value]) => `${key} = ${literal(value)}`).join(", ")} }`;
  // Use the existing TOML serializer only for a new value, never the user's document.
  return stringify({ value } as Parameters<typeof stringify>[0]).trim().replace(/^value = /, "");
}

export function planConfigCompletion(source: string | undefined, options: LoadOptions = {}): string {
  const before = parsePitakoConfig(source, options);
  const original = source ?? "";
  const raw = parse(original) as Table;
  const regions = layout(original), newline = original.includes("\r\n") ? "\r\n" : "\n";
  const insertions = new Map<number, string[]>();
  const expected = parse(original) as Table;
  const insert = (at: number, text: string) => insertions.set(at, [...(insertions.get(at) ?? []), text]);
  const examples: string[] = [];
  for (const setting of completionCatalog(options.packageRoot)) {
    const name = setting.keys.join(".");
    if (exposed(raw, setting.keys) || regions.comments.has(name)) continue;
    if (!setting.active) {
      examples.push(`# pitako:setting ${name}`, ...`${name} = ${literal(setting.value)}`.split("\n").map(line => `# ${line}`));
      continue;
    }
    const [group, key] = setting.keys as [string, string];
    expected[group] ??= Object.create(null);
    table(expected[group])[key] = setting.value;
    const inline = regions.inline.get(group);
    if (inline) {
      const existing = insertions.get(inline.close)?.length;
      insert(inline.close, `${inline.comma || existing ? ", " : " "}${key} = ${literal(setting.value)}`);
    } else {
      const at = regions.explicit.get(group) ?? regions.rootEnd;
      const field = regions.explicit.has(group) ? key : name;
      insert(at, `${field} = ${literal(setting.value)}${newline}`);
    }
  }
  if (examples.length) {
    insert(original.length, [
      "# Pitako options: commented choices do not change effective configuration.",
      "# Merge chosen fields into existing tables; do not duplicate table declarations.",
      ...examples,
    ].join(newline) + newline);
  }
  let proposal = original;
  for (const [at, texts] of [...insertions].sort(([a], [b]) => b - a)) {
    const inline = [...regions.inline.values()].some(region => region.close === at);
    let text = texts.join("");
    if (!inline) {
      if (at && original[at - 1] !== "\n") text = newline + text;
      if (at === original.length && original.length && !original.endsWith("\n")) text = text.replace(/\r?\n$/, "");
    }
    proposal = proposal.slice(0, at) + text + proposal.slice(at);
  }
  const after = parsePitakoConfig(proposal, options);
  if (!isDeepStrictEqual(parse(proposal), expected) ||
      !isDeepStrictEqual({ ...before, userConfigPresent: true }, after)) {
    throw new Error(`${before.userConfigPath}: config completion would change existing configuration`);
  }
  return proposal;
}
