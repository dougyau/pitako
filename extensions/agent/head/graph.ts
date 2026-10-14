import path from "node:path";
import { existsSync, lstatSync } from "node:fs";
import { canonicalPath } from "../../board/paths.ts";
import { DEVELOPER_PROFILES } from "../../roles/types.ts";
import type { DeveloperCapacity } from "../routing.ts";

export interface HeadNodeSpec {
  id: string;
  brief: string;
  deps: string[];
  writes: string[];
  capacity: DeveloperCapacity;
}
export interface HeadNode extends HeadNodeSpec {
  revision: number;
  judgment: "pending" | "satisfied" | "rejected" | "superseded";
  review?: { runId: string; effectiveRevision: number; evidence: string[]; reason: string };
}
export interface HeadTransaction {
  expectedRevision: number;
  nodes: HeadNodeSpec[];
  supersede: string[];
}

export function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
export function writesConflict(left: readonly string[], right: readonly string[]): boolean {
  return left.some(a => right.some(b => contains(a, b) || contains(b, a)));
}
export function boundedText(text: string, label: string, limit = 16 * 1024): void {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > limit) {
    throw new Error(`${label} must be nonempty and at most ${limit} bytes`);
  }
}
export function evidenceRefs(refs: string[]): void {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > 32) throw new Error("evidence references required");
  for (const ref of refs) boundedText(ref, "evidence reference", 1024);
}

/** Assignment-local graph. Transactions build and validate a candidate before committing. */
export class HeadGraph {
  revision = 0;
  private nodes = new Map<string, HeadNode>();
  private history: HeadNode[] = [];
  readonly root: string;
  readonly envelope: readonly string[];

  constructor(root: string, writes: string[]) {
    this.root = canonicalPath(root);
    this.envelope = Object.freeze(this.canonicalWrites(writes));
  }

  canonicalWrites(writes: string[], withinEnvelope = false): string[] {
    if (!Array.isArray(writes) || writes.length > 128) throw new Error("invalid declared writes");
    const result = writes.map(write => {
      if (typeof write !== "string" || !write.length || write.length > 4096 ||
          path.isAbsolute(write) || /[\\*?[\]{}]/.test(write) ||
          [...write].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
        throw new Error("writes must be relative files or subtrees, not globs");
      }
      // canonicalPath resolves existing ancestors, but cannot resolve a dangling alias.
      for (let cursor = path.resolve(this.root, write); path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) {
        try {
          if (lstatSync(cursor).isSymbolicLink() && !existsSync(cursor)) throw new Error("declared writes have an unresolved symlink ancestor");
        } catch (error) {
          if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      const absolute = canonicalPath(write, this.root);
      if (!contains(this.root, absolute) ||
          (withinEnvelope && !this.envelope.some(parent => contains(parent, absolute)))) {
        throw new Error("declared writes escape the assignment envelope");
      }
      return absolute;
    });
    return [...new Set(result)];
  }

  get(id: string): HeadNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`unknown Head node ${id}`);
    return structuredClone(node);
  }
  snapshot(): { revision: number; nodes: HeadNode[]; history: HeadNode[] } {
    return { revision: this.revision, nodes: [...this.nodes.values()].map(node => structuredClone(node)),
      history: structuredClone(this.history) };
  }
  ready(id: string): boolean {
    const node = this.get(id);
    return node.judgment === "pending" && node.deps.every(dep => this.get(dep).judgment === "satisfied");
  }

  transact(transaction: HeadTransaction, active: ReadonlySet<string>,
    negotiated?: { id: string; revision: number }, validateOnly = false): number {
    if (transaction.expectedRevision !== this.revision) throw new Error("stale Head graph revision");
    if (!Array.isArray(transaction.nodes) || !Array.isArray(transaction.supersede)) throw new Error("invalid Head transaction");
    const next = new Map([...this.nodes].map(([id, node]) => [id, structuredClone(node)]));
    const touched = new Set<string>();
    const revision = this.revision + 1;
    for (const id of transaction.supersede) {
      if (touched.has(id)) throw new Error("duplicate Head node edit");
      touched.add(id);
      const node = this.get(id);
      if (active.has(id) || node.judgment === "superseded") throw new Error("cannot supersede active or superseded work");
      next.set(id, { ...node, judgment: "superseded" });
    }
    for (const spec of transaction.nodes) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(spec.id) || touched.has(spec.id)) throw new Error("invalid or duplicate Head node ID");
      touched.add(spec.id);
      boundedText(spec.brief, "node brief");
      if (!Array.isArray(spec.deps) || spec.deps.length > 128 || new Set(spec.deps).size !== spec.deps.length) throw new Error("invalid dependencies");
      if (!spec.capacity || !["direct", "default", "classify"].includes(spec.capacity.route) ||
          (spec.capacity.route === "direct" && !(DEVELOPER_PROFILES as readonly string[]).includes(spec.capacity.profile))) {
        throw new Error("invalid Developer capacity");
      }
      const previous = next.get(spec.id);
      if (previous?.judgment === "superseded") throw new Error("superseded IDs cannot be reused");
      const agreement = negotiated?.id === spec.id && negotiated.revision === previous?.revision;
      if (active.has(spec.id) && !agreement) throw new Error("active contract requires negotiated scope acknowledgment");
      if (previous?.judgment === "satisfied") throw new Error("satisfied work requires explicit supersession");
      next.set(spec.id, { ...structuredClone(spec), writes: this.canonicalWrites(spec.writes, true), revision, judgment: "pending" });
    }
    if (next.size > 128) throw new Error("Head graph exceeds 128 retained nodes");
    // A satisfied prerequisite cannot be replaced beneath active dependents, even indirectly.
    const dependsOn = (id: string, target: string, seen = new Set<string>()): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      return this.get(id).deps.some(dep => dep === target || dependsOn(dep, target, seen));
    };
    for (const id of transaction.supersede) {
      if (this.get(id).judgment === "satisfied" && [...active].some(dependent => dependsOn(dependent, id))) {
        throw new Error("cannot replace a satisfied prerequisite under active dependents");
      }
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error("Head dependency cycle");
      if (visited.has(id)) return;
      const node = next.get(id);
      if (!node || node.judgment === "superseded") throw new Error("dependency references missing or superseded work");
      visiting.add(id);
      for (const dep of node.deps) visit(dep);
      visiting.delete(id); visited.add(id);
    };
    for (const node of next.values()) if (node.judgment !== "superseded") visit(node.id);
    if (!validateOnly) {
      for (const id of touched) {
        const previous = this.nodes.get(id);
        if (previous) this.history.push(structuredClone(previous));
      }
      this.nodes = next; this.revision = revision;
    }
    return revision;
  }

  review(id: string, revision: number, judgment: "satisfied" | "rejected", review: NonNullable<HeadNode["review"]>): void {
    const node = this.get(id);
    if (node.revision !== revision || node.judgment !== "pending") throw new Error("stale or already judged Head result");
    evidenceRefs(review.evidence);
    boundedText(review.reason, "review reason");
    this.nodes.set(id, { ...node, judgment, review: structuredClone(review) });
  }
}
