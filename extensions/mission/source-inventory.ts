import { sha256 } from "./model.ts";

/** Half-open UTF-8 byte coordinates in the original, immutable Markdown. */
export interface SourceRef {
  id: string;
  from: number;
  to: number;
  text: string;
  owner: string;
  role: string;
  parentId?: string;
}
export interface SourceInventory {
  version: 1;
  profile: "ordered-markdown-v1";
  sourceHash: string;
  units: Array<SourceRef & { sourceUnitId: string; engineId: string; ordinal: number }>;
  criteria: SourceRef[];
  context: SourceRef[];
  dependencies: Array<{ unitId: string; requires: string; basis: "profile-order" | "source-declaration"; sourceRef?: string }>;
  unresolved: Array<SourceRef & { issue: string }>;
}

const UNIT = /^(#{1,6})\s+(T\d+)\s*(?:—|–|-)\s+\S/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LABEL = /^(Objective|Scope|Relevant constraints|Constraints|Acceptance(?: criteria)?|Expected evidence|Likely files|Dependencies):(?:\s|$)/i;
const GLOBAL_CONTEXT = /^(Goal|Baseline and evidence|Decisions and consequential premises|Scope and exclusions|Principal-session interaction|Architecture and invariants|Ordered work units|Execution|Verification procedure)$/i;
const GLOBAL_CRITERIA = /^(Final verification and success|Success(?: criteria)?|Acceptance(?: criteria)?|Verification|Final verification)$/i;

/**
 * Structural accounting only. Unknown sections and syntax remain unresolved.
 * Whole clauses are retained; this does not split English or judge proof adequacy.
 */
export function inventoryFrozenSource(text: string): SourceInventory {
  const sourceHash = sha256(Buffer.from(text));
  const result: SourceInventory = { version: 1, profile: "ordered-markdown-v1", sourceHash,
    units: [], criteria: [], context: [], dependencies: [], unresolved: [] };
  const lines: Array<{ text: string; from: number; to: number; fenced: boolean }> = [];
  let from = 0, fence: string | undefined;
  for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const line = raw.replace(/\r?\n$/, "");
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const fenced = fence !== undefined || marker !== undefined;
    if (marker && !fence) fence = marker[0];
    else if (marker?.[0] === fence) fence = undefined;
    const to = from + Buffer.byteLength(raw);
    lines.push({ text: line, from, to, fenced }); from = to;
  }
  const ref = (start: number, end: number, owner: string, role: string, parentId?: string): SourceRef => {
    const from = lines[start]!.from, to = lines[end - 1]!.to;
    return { id: `${sourceHash}:${owner}:${role}:${from}-${to}`, from, to,
      text: Buffer.from(text).subarray(from, to).toString("utf8"), owner, role, ...(parentId ? { parentId } : {}) };
  };
  const unknown = (start: number, end: number, owner: string, issue: string) =>
    result.unresolved.push({ ...ref(start, end, owner, "unresolved"), issue });
  const unitStarts = lines.flatMap((line, i) => !line.fenced && UNIT.test(line.text) ? [i] : []);
  const seen = new Set<string>();
  for (const [ordinal, start] of unitStarts.entries()) {
    const match = UNIT.exec(lines[start]!.text)!;
    const depth = match[1]!.length;
    let end = start + 1;
    while (end < lines.length) {
      const heading = !lines[end]!.fenced && HEADING.exec(lines[end]!.text);
      if (heading && heading[1]!.length <= depth) break;
      end++;
    }
    const sourceUnitId = match[2]!, engineId = sourceUnitId.toLowerCase();
    const row = { ...ref(start, end, engineId, "unit"), sourceUnitId, engineId, ordinal };
    result.units.push(row);
    if (seen.has(engineId)) unknown(start, end, engineId, `duplicate source unit ${sourceUnitId}`);
    if (ordinal && UNIT.exec(lines[unitStarts[ordinal - 1]!]!.text)![1]!.length !== depth)
      unknown(start, end, engineId, "incompatible unit heading nesting");
    seen.add(engineId);
    if (ordinal) result.dependencies.push({ unitId: engineId, requires: result.units[ordinal - 1]!.engineId, basis: "profile-order" });
  }
  // Each acceptance list item (including children) is addressable. Parent items
  // retain their complete attached children/code; duplicate text has distinct ranges.
  const criteria = (start: number, end: number, owner: string) => {
    const list = /^\s*(?:[-+*]|\d+[.)])\s+/;
    let i = start;
    const parents: Array<{ indent: number; id: string }> = [];
    while (i < end) {
      if (!lines[i]!.text.trim()) { i++; continue; }
      if (!lines[i]!.fenced && /^\s*(?:\||>|<!--)/.test(lines[i]!.text)) {
        let next = i + 1;
        while (next < end && lines[next]!.text.trim()) next++;
        unknown(i, next, owner, "unsupported criterion structure"); i = next; continue;
      }
      const item = !lines[i]!.fenced && list.test(lines[i]!.text);
      const indent = item ? lines[i]!.text.search(/\S/) : -1;
      let next = i + 1;
      while (next < end) {
        const line = lines[next]!;
        if (!line.fenced && list.test(line.text) && (!item || line.text.search(/\S/) <= indent)) break;
        if (!item && !line.fenced && !line.text.trim()) {
          let following = next + 1;
          while (following < end && !lines[following]!.text.trim()) following++;
          if (!lines[following]?.fenced) break;
        }
        next++;
      }
      while (parents.length && parents[parents.length - 1]!.indent >= indent) parents.pop();
      const row = ref(i, next, owner, "criterion", parents[parents.length - 1]?.id);
      result.criteria.push(row);
      if (item) {
        parents.push({ indent, id: row.id });
        // Visit nested children independently, without discarding the original parent.
        let child = i + 1;
        while (child < next && (lines[child]!.fenced || !list.test(lines[child]!.text))) child++;
        i = child < next ? child : next;
      } else i = next;
    }
  };
  let i = 0;
  if (lines[0]?.text === "---") {
    i = 1;
    while (i < lines.length && lines[i]!.text !== "---") i++;
    if (i === lines.length) { unknown(0, i, "mission", "unterminated metadata"); return result; }
    i++;
  }
  let owner = "mission", mode: "context" | "criteria" | "unknown" = "unknown", role = "unlabeled";
  let contextDepth = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const unit = result.units.find((row) => row.from === line.from);
    if (unit) {
      owner = unit.engineId; mode = "unknown"; role = "unlabeled";
      result.context.push(ref(i, i + 1, owner, "unit-heading")); i++; continue;
    }
    if (!line.text.trim() || !line.fenced && /^(?:---+|\*\*\*+)\s*$/.test(line.text)) { i++; continue; }
    const heading = !line.fenced && HEADING.exec(line.text);
    const label = !line.fenced && LABEL.exec(line.text);
    if (heading && owner !== "mission") {
      const current = result.units.find((row) => row.engineId === owner)!;
      if (line.from >= current.to) owner = "mission";
    }
    if (heading && owner === "mission") {
      const title = heading[2]!, depth = heading[1]!.length;
      if (GLOBAL_CRITERIA.test(title)) { mode = "criteria"; role = title; contextDepth = depth; }
      else if (depth === 1 && !result.context.length || GLOBAL_CONTEXT.test(title)) { mode = "context"; role = title; contextDepth = depth; }
      else if (mode !== "context" || depth <= contextDepth) { mode = "unknown"; role = title; }
      if (mode === "unknown") unknown(i, i + 1, owner, `unrecognized section (${title})`);
      else result.context.push(ref(i, i + 1, owner, "section-heading"));
      i++; continue;
    }
    if (heading && owner !== "mission") {
      const title = heading[2]!.replace(/:$/, "");
      if (LABEL.test(`${title}:`)) {
        role = title.toLowerCase(); mode = role.startsWith("acceptance") ? "criteria" : "context";
        result.context.push(ref(i, i + 1, owner, "section-heading")); i++; continue;
      }
      mode = "unknown"; role = title;
    }
    if (label && owner !== "mission") {
      role = label[1]!.toLowerCase();
      mode = role.startsWith("acceptance") ? "criteria" : "context";
    } else if (owner !== "mission" && !line.fenced && /^[A-Z][\w -]+:/.test(line.text)) {
      mode = "unknown"; role = "unknown-label";
    }
    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end]!;
      if (!next.fenced && (HEADING.test(next.text) || owner !== "mission" &&
        (LABEL.test(next.text) || /^[A-Z][\w -]+:/.test(next.text)))) break;
      end++;
    }
    if (mode === "criteria") {
      // Inline acceptance prose after the label is itself an original obligation.
      if (label) {
        if (line.text.slice(label[0].length).trim()) result.criteria.push(ref(i, i + 1, owner, "criterion"));
        else result.context.push(ref(i, i + 1, owner, "acceptance-label"));
        criteria(i + 1, end, owner);
      } else criteria(i, end, owner);
    } else if (mode === "unknown") unknown(i, end, owner, `unrecognized source region (${role})`);
    else {
      const row = ref(i, end, owner, role); result.context.push(row);
      if (role === "dependencies") {
        const declaration = /^Dependencies:\s*(T\d+(?:\s*,\s*T\d+)*)\s*$/i.exec(line.text);
        if (!declaration || lines.slice(i + 1, end).some((line) => line.text.trim()))
          unknown(i, end, owner, "unsupported dependency declaration");
        else for (const required of declaration[1]!.split(/\s*,\s*/)) {
          const requires = required.toLowerCase();
          if (!result.units.some((row) => row.engineId === requires && row.ordinal < result.units.find((row) => row.engineId === owner)!.ordinal))
            unknown(i, end, owner, `unknown or forward dependency ${required}`);
          else result.dependencies.push({ unitId: owner, requires, basis: "source-declaration", sourceRef: row.id });
        }
      }
    }
    i = end;
  }
  if (!result.units.length && lines.length) unknown(0, lines.length, "mission", "no ordinary ordered work units");
  if (fence && lines.length) unknown(0, lines.length, "mission", "unterminated code fence");
  return result;
}
