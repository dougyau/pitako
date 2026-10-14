import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import type { AgentSession, AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { fileCut, nativeHeader, validateCut, window, type FileCut } from "./history-native.ts";
import type { SessionHistory } from "./history.ts";
import type { PublicBinding, PublicConversationPage, PublicRecord, PublicContent, WorkerReadReference } from "./bridge/protocol.js";
import { resolvePublicTodo } from "./public-todo.ts";

const WORKER_BYTES = 4 * 1024 * 1024;
const OWNER_BYTES = 32 * 1024 * 1024;
const PAGE_BYTES = 40 * 1024; // Broker also subtracts the exact complete envelope.
const FRAGMENT_BYTES = 12 * 1024;
const ORDER_STEP = 1024 * 1024;
const OWNERS = Symbol.for("pitako.publicConversationOwners");
type OwnerStorage = Map<symbol, Set<PublicConversation>>;
function owners(): OwnerStorage {
  const host = globalThis as Record<symbol, OwnerStorage | undefined>;
  host[OWNERS] ??= new Map();
  return host[OWNERS];
}

/** Positive projection only. Unknown/binary blocks are explicit omissions, never copied. */
function content(value: unknown): PublicContent[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [{ type: "omitted", reason: "unsupported_content" }];
  return value.map(block => {
    if (!block || typeof block !== "object") return { type: "omitted", reason: "unsupported_content" };
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string")
      return { type: "toolCall", toolCallId: block.id, name: block.name, arguments: block.arguments };
    // Thinking, signatures and private metadata have no public fields.
    return { type: "omitted", reason: "unsupported_content" };
  });
}

type CapturedRecord = PublicRecord & { sequence: number | null };
type NewRecord<T = PublicRecord> = T extends PublicRecord ?
  Omit<T, "revision" | "order" | "nativeOrder" | "occurredAt"> & Partial<Pick<T, "nativeOrder" | "occurredAt">> : never;
type CaptureBinding = Omit<PublicBinding, "state" | "headEntryId" | "attemptIds"> &
  { active: boolean; head: string | null; headObserved: boolean };
interface Retained { record: CapturedRecord; bytes: number }
type NativePlacement = Pick<PublicRecord, "nativeEntryId" | "parentEntryId" | "nativeTime" | "nativeOrder">;
interface Placement { binding: number; id: string; order: number; revision: number; native?: NativePlacement }
interface OrderRange { first: number; last: number; base: number; step: number }
interface NativeDescriptor { id: string; parentId: string | null; type: string; offset: number; todo: boolean }
interface RecoveryOrders {
  binding: number; revision: number; ranges?: OrderRange[];
  known?: Array<{ ordinal: number; order: number }>;
  file: FileCut; observedAt: number; metadata: PublicBinding; capture: PublicConversationPage["capture"];
  descriptors: Map<string, NativeDescriptor>; todoAdmitted: boolean; gaps: PublicConversationPage["gaps"];
  materialized: Map<number, { json?: string; offset: number; ordinal: number; ended: boolean; gaps: PublicConversationPage["gaps"] }>;
}
interface Position {
  epoch: string; scope: string; binding: number; cut: number;
  mode: "snapshot" | "changes" | "follow" | "recovery"; after: number; fragment: number;
  file?: FileCut; offset?: number; observedAt?: number; recoveryRevision?: number;
  retentionEpoch?: number;
  orderEpoch?: number;
  skipLine?: boolean;
  bindingMetadata?: PublicBinding; capture?: PublicConversationPage["capture"]; lostAtStart?: number;
}

/** One accepted invocation; sessions/bindings and attempts are not workers. */
export class PublicConversation {
  readonly epoch = randomUUID();
  private readonly key = randomUUID();
  private owner?: symbol;
  private sequence = 0;
  private revision = 0;
  private bytes = 0;
  private retained: Retained[] = [];
  private order = 0;
  private placements = new Map<string, Placement>();
  private recoveryOrders = new Map<number, RecoveryOrders>();
  private bindings: CaptureBinding[] = [];
  private files = new Map<number, { path: string; persisted: boolean }>();
  private lostThrough = 0;
  private retentionEpoch = 0;
  private orderEpoch = 0;
  private closed = false;
  private failed = false;
  private nextGeneration = 0;
  private retired = false;
  private trimming = false;
  private evictedBindingsThrough = 0;
  private initialBrief = new Map<number, { entryId: string; text?: string }>();
  private batching = 0;
  private dirty = false;
  onChange?: () => void;

  constructor(private readonly limits = { worker: WORKER_BYTES, owner: OWNER_BYTES }, private readonly expectedSource = true) {}

  bind(owner: symbol) {
    this.owner = owner;
    const storage = owners();
    const group = storage.get(owner) ?? new Set();
    group.add(this);
    storage.set(owner, group);
  }

  retire() {
    this.retired = true;
    if (this.owner) {
      const group = owners().get(this.owner);
      group?.delete(this);
      if (!group?.size) owners().delete(this.owner);
    }
    this.retained = []; this.bytes = 0; this.bindings = []; this.files.clear(); this.initialBrief.clear();
    this.placements.clear(); this.recoveryOrders.clear();
    this.onChange = undefined;
  }

  binding(historyId: string, sessionId: string, file?: string): number {
    if (this.retired) throw new Error("stale_owner");
    const existing = this.bindings.find(item => item.historyId === historyId && item.sessionId === sessionId);
    if (existing) {
      if (file && !this.retired) this.files.set(existing.generation, { path: file,
        persisted: this.files.get(existing.generation)?.persisted === true || existsSync(file) });
      return existing.generation;
    }
    for (const previous of this.bindings) previous.active = false;
    const generation = ++this.nextGeneration;
    this.bindings.push({ generation, historyId, sessionId, active: true,
      head: null, headObserved: false, todoHead: { state: "unavailable" }, capture: "open", attempts: [], gaps: [] });
    if (file) this.files.set(generation, { path: file, persisted: existsSync(file) });
    this.changed();
    return generation;
  }

  attempt(id: string, activated?: { model: string; reasoning: string },
    selected?: { model: string; requestedModel?: string; reasoning?: string }) {
    const binding = this.bindings.at(-1);
    if (!binding) return;
    const existing = binding.attempts.find(attempt => attempt.attemptId === id);
    const activation = activated ? { model: activated.model, reasoning: activated.reasoning } : undefined;
    const selection = selected ? { model: selected.model, requestedModel: selected.requestedModel, reasoning: selected.reasoning } : undefined;
    if (existing) {
      if (selection && !existing.selected) existing.selected = selection;
      if (activation && !existing.activated) existing.activated = activation;
      if (selection || activation) this.changed();
    } else { binding.attempts.push({ attemptId: id, ...(activation ? { activated: activation } : {}),
      ...(selection ? { selected: selection } : {}) }); this.changed(); }
  }

  private changed(trim = true) {
    if (trim && !this.trimming && !this.retired) {
      this.trimming = true;
      try { this.trim(); } finally { this.trimming = false; }
    }
    if (this.batching) { this.dirty = true; return; }
    try { this.onChange?.(); } catch { /* Hints cannot affect execution. */ }
  }

  batch(action: () => void) {
    this.batching++;
    try { action(); } catch (error) {
      this.fail();
      throw error;
    } finally {
      this.batching--;
      if (!this.batching && this.dirty) { this.dirty = false; this.changed(); }
    }
  }

  todoLimits() { return { entries: Math.floor(this.limits.worker / 64), bytes: this.limits.worker }; }

  private storageBytes() {
    if (!this.retained.length && !this.bindings.length && !this.initialBrief.size &&
      !this.placements.size && !this.recoveryOrders.size) return 0;
    const recipes = [...this.recoveryOrders].map(([id, plan]) => [id, { ...plan,
      descriptors: [...plan.descriptors.values()],
      materialized: [...plan.materialized].map(([offset, { json, ...metadata }]) => [offset, metadata]) }]);
    const materializedBytes = [...this.recoveryOrders.values()].reduce((sum, plan) => sum +
      [...plan.materialized.values()].reduce((sum, item) => sum + Buffer.byteLength(item.json ?? ""), 0), 0);
    return this.bytes + materializedBytes + Buffer.byteLength(JSON.stringify(this.bindings.map(binding => this.publicBinding(binding)))) +
      Buffer.byteLength(JSON.stringify([...this.initialBrief])) +
      Buffer.byteLength(JSON.stringify([...this.placements.values()])) +
      Buffer.byteLength(JSON.stringify(recipes));
  }

  /** Both changes and snapshots count; identity/attempt metadata cannot grow without bound. */
  private trim() {
    // One binding must also fit a detail page; dropped attempt metadata is declared.
    for (const binding of this.bindings) {
      while (Buffer.byteLength(JSON.stringify(this.publicBinding(binding))) > 4 * 1024 && binding.attempts.length) {
        binding.attempts.shift();
        if (!binding.gaps.includes("evicted")) binding.gaps.push("evicted");
      }
    }
    while (this.storageBytes() > this.limits.worker && this.recoveryOrders.size > 1) this.evictOrderMetadata();
    while (this.storageBytes() > this.limits.worker && this.retained.length) this.evict();
    while (this.storageBytes() > this.limits.worker && this.evictOrderMetadata()) { /* Count placements and cuts too. */ }
    while (this.storageBytes() > this.limits.worker && this.bindings.length > 1) {
      const removed = this.bindings.shift()!;
      this.evictedBindingsThrough = Math.max(this.evictedBindingsThrough, removed.generation);
      this.files.delete(removed.generation); this.initialBrief.delete(removed.generation);
      this.dropOrders(removed.generation);
      const current = this.bindings.at(-1)!;
      if (!current.gaps.includes("evicted")) current.gaps.push("evicted");
    }
    // Keep local accumulation bounded during a batch; notify/trim peers only after its head is coherent.
    const group = !this.batching && this.owner && owners().get(this.owner);
    if (group) {
      while ([...group].reduce((sum, worker) => sum + worker.storageBytes(), 0) > this.limits.owner) {
        const oldest = [...group].filter(worker => worker.retained.length)
          .sort((a, b) => a.retained[0]!.record.observedAt - b.retained[0]!.record.observedAt)[0];
        if (oldest) oldest.evict();
        else {
          const orders = [...group].find(worker => worker.recoveryOrders.size || worker.placements.size);
          if (orders && orders.evictOrderMetadata()) continue;
          const metadata = [...group].find(worker => worker.bindings.length);
          if (!metadata) break;
          const removed = metadata.bindings.shift()!;
          metadata.evictedBindingsThrough = Math.max(metadata.evictedBindingsThrough, removed.generation);
          metadata.files.delete(removed.generation); metadata.initialBrief.delete(removed.generation);
          metadata.dropOrders(removed.generation);
          metadata.changed(false);
        }
      }
    }
  }

  private id(generation: number, kind: "entry" | "tool" | "head", native: string) {
    const binding = this.bindings.find(item => item.generation === generation)!;
    return `${binding.historyId}:${binding.sessionId}:${kind}:${native}`;
  }

  private change({ sequence, ...record }: CapturedRecord) { return { sequence, op: "upsert" as const, record }; }

  private placementKey(binding: number, id: string) { return `${binding}:${id}`; }

  private dropOrders(binding: number) {
    for (const [key, placement] of this.placements) if (placement.binding === binding) this.placements.delete(key);
    for (const [key, plan] of this.recoveryOrders) if (plan.binding === binding) this.recoveryOrders.delete(key);
  }

  private evictOrderMetadata() {
    const plan = this.recoveryOrders.keys().next();
    if (this.recoveryOrders.size > 1) this.dropRecovery(plan.value!);
    else {
      const placement = this.placements.keys().next();
      if (placement.done) {
        if (plan.done) return false;
        this.dropRecovery(plan.value);
        return true;
      }
      const binding = this.bindings.find(item => item.generation === this.placements.get(placement.value)!.binding);
      if (binding && !binding.gaps.includes("evicted")) binding.gaps.push("evicted");
      this.placements.delete(placement.value);
      this.retentionEpoch++;
      this.orderEpoch++;
    }
    return true;
  }

  private dropRecovery(revision: number) {
    const plan = this.recoveryOrders.get(revision);
    this.recoveryOrders.delete(revision);
    const binding = this.bindings.find(item => item.generation === plan?.binding);
    if (binding && !binding.gaps.includes("evicted")) binding.gaps.push("evicted");
  }

  private place(binding: number, id: string, order?: number, revision = this.revision, native?: NativePlacement) {
    const key = this.placementKey(binding, id);
    const previous = this.placements.get(key);
    if (order === undefined && !previous) this.order += ORDER_STEP;
    const placement = { binding, id, revision, order: order ?? previous?.order ?? this.order,
      native: native ?? previous?.native };
    if (!Number.isSafeInteger(placement.order)) throw new RangeError("public order exhausted");
    this.order = Math.max(this.order, placement.order);
    if (!previous || previous.revision <= revision) this.placements.set(key, placement);
    else if (!previous.native && native) previous.native = native; // A native identity fact does not replace a newer placement.
    return placement.order;
  }

  private push(record: NewRecord, order?: number) {
    if (this.retired) return;
    const sequence = ++this.sequence;
    const previous = [...this.retained].reverse().find(item => item.record.binding === record.binding &&
      item.record.kind === record.kind && item.record.id === record.id)?.record;
    const native = this.placements.get(this.placementKey(record.binding, record.id))?.native;
    const projected: CapturedRecord = { ...record, sequence, revision: ++this.revision,
      order: this.place(record.binding, record.id, order),
      nativeEntryId: record.nativeEntryId ?? native?.nativeEntryId ?? null,
      parentEntryId: record.nativeEntryId || !native ? record.parentEntryId : native.parentEntryId,
      nativeTime: record.nativeTime ?? native?.nativeTime ?? null,
      nativeOrder: record.nativeOrder ?? previous?.nativeOrder ?? native?.nativeOrder ?? null,
      occurredAt: record.occurredAt ?? null };
    if (projected.nativeEntryId) this.place(record.binding, record.id, projected.order, projected.revision, {
      nativeEntryId: projected.nativeEntryId, parentEntryId: projected.parentEntryId,
      nativeTime: projected.nativeTime, nativeOrder: projected.nativeOrder });
    // Serialize here, at the boundary. No SDK object survives a producer callback.
    const encoded = JSON.stringify(projected);
    const bytes = Buffer.byteLength(JSON.stringify(this.change(projected)));
    if (bytes > this.limits.worker) {
      this.lostThrough = sequence;
      const gaps = this.bindings.find(item => item.generation === record.binding)?.gaps;
      if (gaps && !gaps.includes("unsupported_content")) gaps.push("unsupported_content");
      this.changed();
      return;
    }
    this.retained.push({ record: JSON.parse(encoded), bytes });
    this.bytes += bytes;
    this.changed();
  }

  private evict() {
    const item = this.retained.shift();
    if (!item) return;
    this.bytes -= item.bytes;
    this.retentionEpoch++;
    this.lostThrough = Math.max(this.lostThrough, item.record.sequence!);
    this.changed(false); // The owner loop owns trimming; peer notifications must not recurse.
  }

  /** Called only at a post-append point. IDs/parents come directly from SessionManager. */
  entry(generation: number, entry: SessionEntry, initialUser = false, brief?: string, nativeOrder?: number,
    todoSnapshot?: import("./bridge/protocol.js").PublicTodoSnapshot) {
    if (entry.type !== "message") return;
    const message = entry.message;
    if (message.role === "user" || message.role === "assistant") {
      if (initialUser && brief !== undefined) this.initialBrief.set(generation, { entryId: entry.id,
        text: Buffer.byteLength(brief) <= this.limits.worker / 2 ? brief : undefined });
      this.push({ id: this.id(generation, "entry", entry.id), binding: generation, kind: "message",
        nativeEntryId: entry.id, parentEntryId: entry.parentId, toolCallId: null,
        nativeOrder: nativeOrder ?? null, occurredAt: message.timestamp,
        observedAt: Date.now(), nativeTime: entry.timestamp, payload: { role: message.role,
          ...(message.role === "assistant" ? { stopReason: message.stopReason, errorMessage: message.errorMessage } : {}),
          blocks: initialUser && brief !== undefined ? [{ type: "text", text: brief }] : content(message.content) } });
    } else if (message.role === "toolResult") {
      const previous = [...this.retained].reverse().find(item => item.record.binding === generation &&
        item.record.kind === "tool" && item.record.toolCallId === message.toolCallId)?.record;
      const tool = previous?.kind === "tool" ? previous : undefined;
      this.push({ id: this.id(generation, "tool", message.toolCallId), binding: generation, kind: "tool", toolCallId: message.toolCallId,
        nativeOrder: nativeOrder ?? null, occurredAt: message.timestamp,
        parentToolCallId: tool?.parentToolCallId, nativeEntryId: entry.id, parentEntryId: entry.parentId,
        observedAt: Date.now(), nativeTime: entry.timestamp, payload: {
          status: message.isError ? "error" : "completed", name: message.toolName,
          args: tool?.payload.args, argsState: tool?.payload.argsState ?? "not_captured",
          result: content(message.content), isError: message.isError, ...(todoSnapshot ? { todoSnapshot } : {}) } });
    }
  }

  tool(generation: number, event: AgentSessionEvent) {
    if (event.type !== "tool_execution_start" && event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return;
    const previous = [...this.retained].reverse().find(item =>
      item.record.binding === generation && item.record.kind === "tool" && item.record.toolCallId === event.toolCallId)?.record;
    const tool = previous?.kind === "tool" ? previous : undefined;
    this.push({ id: this.id(generation, "tool", event.toolCallId), binding: generation, kind: "tool", toolCallId: event.toolCallId,
      parentToolCallId: event.parentToolCallId ?? tool?.parentToolCallId,
      nativeEntryId: tool?.nativeEntryId ?? null, parentEntryId: tool?.parentEntryId ?? null,
      observedAt: Date.now(), nativeTime: null, payload: {
        name: event.toolName,
        status: event.type === "tool_execution_end" ? event.isError ? "error" : "completed"
          : event.type === "tool_execution_start" ? "started" : "updated",
        args: event.type === "tool_execution_start" ? event.args : tool?.payload.args,
        argsState: event.type === "tool_execution_start" ? "available" : tool?.payload.argsState ?? "not_captured",
        result: event.type === "tool_execution_start" ? null : content(
          event.type === "tool_execution_update" ? event.partialResult.content : event.result.content),
        isError: event.type === "tool_execution_end" ? event.isError : null } });
  }

  head(generation: number, head: string | null, entries: SessionEntry[], oldLeaf?: string | null,
    todoHead?: import("./bridge/protocol.js").PublicTodoHead) {
    if (this.retired) return;
    const binding = this.bindings.find(item => item.generation === generation)!;
    binding.headObserved = true;
    if (binding.capture === "incomplete") todoHead = { state: "unavailable" };
    const selectorChanged = todoHead && JSON.stringify(binding.todoHead) !== JSON.stringify(todoHead);
    if (todoHead) binding.todoHead = todoHead;
    if (binding.head === head && (oldLeaf === undefined || oldLeaf === head)) {
      if (selectorChanged) this.changed();
      return;
    }
    const previous = oldLeaf === undefined ? binding.head : oldLeaf;
    let current = head;
    const parents = new Map(entries.map(entry => [entry.id, entry.parentId]));
    const visited = new Set<string>();
    while (current && current !== previous && !visited.has(current)) {
      visited.add(current); current = parents.get(current) ?? null;
    }
    if (previous && current !== previous) {
      this.push({ id: this.id(generation, "head", head ?? "root"), binding: generation, kind: "branch_changed",
        observedAt: Date.now(), nativeTime: null, nativeEntryId: head, toolCallId: null,
        parentEntryId: head ? parents.get(head) ?? null : null,
        payload: { headEntryId: head, previousHeadEntryId: previous } });
    }
    binding.head = head;
    this.changed();
  }

  closeBinding(generation: number, failed = false) {
    const binding = this.bindings.find(item => item.generation === generation);
    if (!binding) return;
    binding.active = false;
    binding.capture = failed || binding.gaps.includes("capture_failed") ? "incomplete" : "closed";
    if (failed) {
      binding.todoHead = { state: "unavailable" };
      if (!binding.gaps.includes("capture_failed")) binding.gaps.push("capture_failed");
      this.failed = true;
    }
    this.changed();
  }

  fail() {
    this.failed = true;
    const binding = this.bindings.at(-1);
    if (binding) {
      binding.capture = "incomplete";
      binding.todoHead = { state: "unavailable" };
      if (!binding.gaps.includes("capture_failed")) binding.gaps.push("capture_failed");
    }
    this.changed();
  }
  finish() { this.closed = true; this.changed(); }
  private publicBinding(binding: CaptureBinding): PublicBinding {
    const { active, head, headObserved, ...rest } = binding;
    return { ...rest, state: active ? "active" : "historical", headEntryId: head,
      attemptIds: binding.attempts.map(attempt => attempt.attemptId) };
  }
  metadata(ref: WorkerReadReference) {
    return { capture: this.failed || (!this.expectedSource || this.closed) && this.nextGeneration === 0 ||
      this.closed && this.bindings.some(binding => binding.capture !== "closed")
      ? "incomplete" as const : this.closed ? "closed" as const : this.nextGeneration === 0 ? "opening" as const : "open" as const,
    captureReason: this.failed ? "capture_failed" as const : (!this.expectedSource || this.closed) && this.nextGeneration === 0
      ? "not_captured" as const : undefined,
    epoch: this.epoch, sequence: this.sequence, finalSequence: this.closed ? this.sequence : undefined,
    gaps: [...(this.lostThrough || this.evictedBindingsThrough ? ["evicted" as const] : []),
      ...(this.failed ? ["capture_failed" as const] : [])],
    bindings: this.bindings.map(binding => ({ ...this.publicBinding(binding), ref: { ...ref,
      native: { generation: binding.generation, historyId: binding.historyId, sessionId: binding.sessionId } } })) };
  }

  private scope(ref: WorkerReadReference) {
    return createHash("sha256").update(JSON.stringify([ref.kind, ref.processId, ref.coordinatorSessionId, ref.epoch,
      ref.instanceId, ref.source, ref.assignmentId, ref.native?.generation, ref.native?.historyId, ref.native?.sessionId])).digest("hex");
  }
  private encode(position: Position) {
    // Recovery metadata/materializations are owned and budgeted by the recipe, never duplicated in cursors.
    const value = Buffer.from(JSON.stringify(position.mode === "recovery"
      ? { ...position, bindingMetadata: undefined, capture: undefined } : position)).toString("base64url");
    return `${value}.${createHmac("sha256", this.key).update(value).digest("base64url")}`;
  }
  private decode(value: string, ref: WorkerReadReference): Position {
    const [data, signature, extra] = value.split(".");
    const expected = createHmac("sha256", this.key).update(data ?? "").digest();
    const supplied = Buffer.from(signature ?? "", "base64url");
    if (extra || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("invalid_cursor");
    const position: Position = JSON.parse(Buffer.from(data!, "base64url").toString("utf8"));
    if (position.epoch !== this.epoch || position.scope !== this.scope(ref) || position.binding !== ref.native?.generation)
      throw new Error("invalid_cursor");
    return position;
  }

  hasBinding(ref: WorkerReadReference) {
    return this.bindings.some(binding => binding.generation === ref.native?.generation &&
      binding.historyId === ref.native?.historyId && binding.sessionId === ref.native?.sessionId);
  }

  read(ref: WorkerReadReference, cursor?: string, recovery = false, byteBudget = PAGE_BYTES): PublicConversationPage {
    if (this.retired) throw new Error("stale_owner");
    const saved = cursor ? this.decode(cursor, ref) : undefined;
    const binding = this.bindings.find(item => item.generation === ref.native?.generation &&
      item.sessionId === ref.native?.sessionId && item.historyId === ref.native?.historyId);
    if (!binding) {
      if (saved && ref.native && ref.native.generation <= this.evictedBindingsThrough)
        return { format: "public-v1", state: "resync_required", ref, epoch: this.epoch, cut: this.sequence,
          changes: [], next: null, more: false, gaps: ["evicted", "resync_required"] };
      throw new Error("unknown_target");
    }
    const position = saved ?? { epoch: this.epoch, scope: this.scope(ref),
      binding: binding.generation, cut: this.sequence, after: 0, fragment: 0,
      orderEpoch: this.orderEpoch,
      ...(this.lostThrough ? { lostAtStart: this.lostThrough } : {}),
      ...(recovery ? { retentionEpoch: this.retentionEpoch } : {}),
      mode: recovery ? "recovery" as const : "snapshot" as const };
    if (position.orderEpoch !== this.orderEpoch)
      return { format: "public-v1", state: "resync_required", ref, epoch: this.epoch, cut: position.cut,
        changes: [], next: null, more: false, gaps: ["evicted", "resync_required"] };
    if (position.mode === "recovery") {
      // Recovery reuses retained data at its cut; eviction would change a replay's bytes.
      if (position.retentionEpoch !== this.retentionEpoch)
        return { format: "public-v1", state: "resync_required", ref, epoch: this.epoch, cut: position.cut,
          changes: [], next: null, more: false, gaps: ["evicted", "resync_required"] };
      return this.recover(ref, position, byteBudget);
    }
    const following = position.mode === "follow";
    if (following) { position.mode = "changes"; position.cut = this.sequence; }
    if (!position.bindingMetadata || following) {
      position.bindingMetadata = JSON.parse(JSON.stringify(this.publicBinding(binding)));
      position.capture = { state: this.metadata(ref).capture, finalSequence: this.closed ? this.sequence : null };
    }
    if (this.lostThrough > Math.max(position.after, position.mode === "snapshot" ? position.lostAtStart ?? 0 : 0))
      return { format: "public-v1", state: "resync_required", ref,
      epoch: this.epoch, cut: position.cut, changes: [], next: null, more: false,
      lost: { from: position.after + 1, through: this.lostThrough }, gaps: ["evicted", "resync_required"] };
    let records = this.retained.map(item => item.record).filter(record =>
      record.binding === binding.generation && record.sequence! > position.after && record.sequence! <= position.cut);
    if (position.mode === "snapshot") {
      const latest = new Map<string, CapturedRecord>();
      for (const record of records) latest.set(`${record.kind}:${record.id}`, record);
      records = [...latest.values()].sort((a, b) => a.sequence! - b.sequence!);
    }
    const page = this.page(ref, position, records, byteBudget);
    if (!page.next) {
      page.next = this.encode({ ...position, mode: "follow", after: position.cut, fragment: 0 });
      page.more = false;
    }
    return page;
  }

  private page(ref: WorkerReadReference, position: Position, source: CapturedRecord[], byteBudget: number,
    frozenJson?: string): PublicConversationPage {
    const page: PublicConversationPage = { format: "public-v1", state: "ready", ref,
      epoch: this.epoch, cut: position.cut, changes: [], next: null, more: false,
      binding: position.bindingMetadata, capture: position.capture,
      gaps: [...(position.lostAtStart ? ["evicted" as const] : []),
        ...(position.bindingMetadata?.gaps ?? []), ...(position.capture?.state === "incomplete" ? ["capture_failed" as const] : [])]
        .filter((gap, index, gaps) => gaps.indexOf(gap) === index),
      ...(position.lostAtStart ? { lost: { from: 1, through: position.lostAtStart } } : {}) };
    let next = { ...position };
    for (const record of source) {
      const change = this.change(record);
      const bytes = Buffer.from(frozenJson ?? JSON.stringify(change));
      let offset = record.sequence === position.after ? position.fragment : 0;
      // A fragment continuation stays on its immutable revision, not the latest upsert.
      offset = position.fragment && page.changes.length === 0 ? position.fragment : offset;
      do {
        const item = bytes.length > FRAGMENT_BYTES ? { kind: "fragment" as const, id: record.id,
          binding: record.binding, revision: record.revision, sequence: record.sequence, encoding: "base64-json" as const,
          byteOffset: offset, totalBytes: bytes.length,
          data: bytes.subarray(offset, offset + FRAGMENT_BYTES).toString("base64") } : change;
        const end = bytes.length > FRAGMENT_BYTES ? Math.min(bytes.length, offset + FRAGMENT_BYTES) : bytes.length;
        // Recovery's file ordinal is independent of a retained record's public order.
        const sequence = position.mode === "recovery" ? position.after + 1 : record.sequence ?? record.order;
        const candidate = { ...next, after: end < bytes.length ? sequence - 1 : sequence,
          fragment: end < bytes.length ? end : 0 };
        const token = this.encode(candidate);
        if (page.changes.length >= 50 || Buffer.byteLength(JSON.stringify({ ...page, changes: [...page.changes, item], next: token })) > Math.min(PAGE_BYTES, byteBudget)) {
          if (!page.changes.length) throw new RangeError("public identity exceeds page budget");
          page.next = this.encode(next);
          page.more = true;
          return page;
        }
        page.changes.push(item); next = candidate; offset = end;
      } while (offset < bytes.length);
    }
    return page;
  }

  private nativeLine(fd: number, cut: FileCut, start: number, skipLine = false) {
    const chunks: Buffer[] = [];
    let offset = start, total = 0, ended = false;
    while (offset < cut.size && !ended && total < this.limits.worker) {
      const bytes = window(fd, offset, cut.size - offset);
      const newline = bytes.indexOf(10);
      const part = bytes.subarray(0, newline < 0 ? bytes.length : newline);
      if (!skipLine) chunks.push(part);
      total += part.length;
      offset += newline < 0 ? bytes.length : newline + 1;
      ended = newline >= 0;
    }
    let entry: SessionEntry | undefined;
    if (ended && total <= this.limits.worker && !skipLine) {
      try { entry = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* An unprovable line is a gap. */ }
    }
    return { offset, ended, total, entry };
  }

  private nativePublicId(binding: number, entry: SessionEntry) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) return;
    if (entry.message.role === "user" || entry.message.role === "assistant") return this.id(binding, "entry", entry.id);
    if (entry.message.role === "toolResult") return this.id(binding, "tool", entry.message.toolCallId);
  }

  /** Reserve insertion ranges once per recovery, not a second file-ordinal order domain.
   * Descriptors cover all native classes; only matching todo details are loaded by the resolver.
   */
  private prepareOrders(fd: number, cut: FileCut, plan: RecoveryOrders) {
    let placements = [...this.placements.values()].filter(item => item.binding === plan.binding)
      .map(item => ({ ...item })).sort((a, b) => a.order - b.order);
    const available = new Map(placements.map(item => [item.id, item]));
    const anchors: Array<{ ordinal: number; placement: Placement }> = [];
    let ordinal = 0, offset = 0, skipLine = false;
    let descriptorBytes = 0, complete = true;
    while (offset < cut.size) {
      const start = offset;
      const line = this.nativeLine(fd, cut, offset, skipLine);
      offset = line.offset; skipLine = !line.ended;
      const entry = line.entry;
      if (entry && (entry.type as string) !== "session") {
        if (typeof entry.id !== "string" || !entry.id || !(entry.parentId === null || typeof entry.parentId === "string") ||
          typeof entry.type !== "string" || plan.descriptors.has(entry.id) ||
          entry.type === "message" && (!entry.message || typeof entry.message !== "object" || Array.isArray(entry.message))) {
          complete = false;
          if (!plan.gaps.includes("capture_failed")) plan.gaps.push("capture_failed");
        }
        else {
          const descriptor: NativeDescriptor = { id: entry.id, parentId: entry.parentId, type: entry.type, offset: start,
            todo: entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo" };
          descriptorBytes += Buffer.byteLength(JSON.stringify(descriptor));
          if (plan.descriptors.size >= this.todoLimits().entries || descriptorBytes > this.limits.worker) complete = false;
          else plan.descriptors.set(entry.id, descriptor);
        }
      } else if (!entry) complete = false;
      const id = line.entry && this.nativePublicId(plan.binding, line.entry);
      if (!id) continue;
      ordinal++;
      const placement = available.get(id);
      if (placement) anchors.push({ ordinal, placement });
    }
    const ranges: OrderRange[] = [];
    let previousOrdinal = 0;
    let rebase = false;
    for (const anchor of anchors) {
      const index = placements.indexOf(anchor.placement);
      const base = placements[index - 1]?.order ?? 0;
      const count = anchor.ordinal - previousOrdinal - 1;
      const step = Math.floor((anchor.placement.order - base) / (count + 1));
      if (count) ranges.push({ first: previousOrdinal + 1, last: anchor.ordinal - 1, base, step });
      if (step < 1 || anchors.some(other => other.ordinal < anchor.ordinal && other.placement.order >= anchor.placement.order))
        rebase = true;
      previousOrdinal = anchor.ordinal;
    }
    if (rebase) {
      // Publish new revisions, leaving already issued cuts/revisions untouched.
      // Observations preceding an attached native anchor stay with that anchor.
      const native = new Map(anchors.map(anchor => [anchor.placement.id, anchor.ordinal]));
      const groups: Array<{ ordinal: number; placements: Placement[] }> = [];
      let group: Placement[] = [];
      for (const placement of placements) {
        group.push(placement);
        const ordinal = native.get(placement.id);
        if (ordinal !== undefined) { groups.push({ ordinal, placements: group }); group = []; }
      }
      placements = [...groups.sort((a, b) => a.ordinal - b.ordinal).flatMap(group => group.placements), ...group];
      ranges.length = 0; previousOrdinal = 0;
      let order = this.order;
      for (const placement of placements) {
        const ordinal = native.get(placement.id);
        if (ordinal !== undefined) {
          const count = ordinal - previousOrdinal - 1;
          if (count) ranges.push({ first: previousOrdinal + 1, last: ordinal - 1, base: order, step: ORDER_STEP });
          order += count * ORDER_STEP; previousOrdinal = ordinal;
        }
        placement.order = order += ORDER_STEP;
        const retained = [...this.retained].reverse().find(item =>
          item.record.binding === placement.binding && item.record.id === placement.id)?.record;
        if (retained) this.push(retained, placement.order);
        else this.place(placement.binding, placement.id, placement.order, ++this.revision);
      }
    }
    const remaining = ordinal - previousOrdinal;
    if (remaining) {
      ranges.push({ first: previousOrdinal + 1, last: ordinal, base: this.order, step: ORDER_STEP });
      this.order += remaining * ORDER_STEP;
    }
    plan.ranges = ranges;
    plan.known = anchors.map(anchor => ({ ordinal: anchor.ordinal, order: anchor.placement.order }));
    if (!complete || Buffer.byteLength(JSON.stringify({ ...plan, descriptors: [...plan.descriptors.values()] })) > this.limits.worker) {
      complete = false;
      plan.descriptors.clear();
    }
    const lookup = (id: string) => {
      if (!complete) return;
      const descriptor = plan.descriptors.get(id);
      return descriptor?.todo ? this.nativeLine(fd, cut, descriptor.offset).entry : descriptor;
    };
    if (complete && plan.metadata.headEntryId !== null && !plan.descriptors.has(plan.metadata.headEntryId))
      plan.gaps.push("capture_failed");
    plan.todoAdmitted = plan.todoAdmitted && complete &&
      (plan.metadata.headEntryId === null || plan.descriptors.has(plan.metadata.headEntryId));
    if (plan.metadata.todoHead !== undefined) {
      const todo = plan.todoAdmitted ? resolvePublicTodo(lookup, plan.metadata.headEntryId, this.todoLimits()) : undefined;
      plan.metadata.todoHead = todo?.head ?? { state: "unavailable" };
      if (todo?.budgetExceeded) plan.gaps.push("unsupported_content");
    }
    if (!complete) plan.gaps.push("unsupported_content");
    this.changed();
  }

  private recoveryOrder(plan: RecoveryOrders, ordinal: number) {
    const known = plan.known!.find(item => item.ordinal === ordinal);
    if (known) return known.order;
    const range = plan.ranges!.find(range => range.first <= ordinal && ordinal <= range.last);
    if (!range) throw new Error("unavailable public placement");
    return range.base + (ordinal - range.first + 1) * range.step;
  }

  private rejectRecovery(bindingId: number) {
    this.batch(() => {
      for (const [revision, plan] of this.recoveryOrders) if (plan.binding === bindingId) this.dropRecovery(revision);
      const binding = this.bindings.find(item => item.generation === bindingId);
      if (binding) {
        binding.todoHead = { state: "unavailable" };
        if (!binding.gaps.includes("capture_failed")) binding.gaps.push("capture_failed");
      }
      // Recovery projections never enter retained: independent live snapshots remain untouched.
      this.changed();
    });
  }

  /** Only this registered binding's file, positional bounded reads, never an SDK loader. */
  private recover(ref: WorkerReadReference, position: Position, byteBudget: number): PublicConversationPage {
    const page: PublicConversationPage = { format: "public-v1", state: "ready", ref,
      epoch: this.epoch, cut: position.cut, changes: [], next: null, more: false, gaps: ["not_captured"] };
    if (position.recoveryRevision && !this.recoveryOrders.has(position.recoveryRevision))
      return { ...page, state: "resync_required", gaps: ["evicted", "resync_required"] };
    const registered = this.files.get(position.binding);
    const file = registered?.path;
    if (!file || !existsSync(file)) {
      page.gaps = [registered?.persisted ? "pruned" : "not_persisted"];
      if (position.recoveryRevision) {
        this.rejectRecovery(position.binding);
        page.state = "resync_required"; page.gaps.push("resync_required");
      }
      return page;
    }
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const binding = this.bindings.find(item => item.generation === position.binding)!;
      if (nativeHeader(fd).id !== binding.sessionId) throw new Error("stale_cursor");
      const cut = position.file ?? fileCut(fd);
      validateCut(fd, cut);
      const observedAt = position.observedAt ?? Date.now();
      const recoveryRevision = position.recoveryRevision ?? ++this.revision;
      let orders = this.recoveryOrders.get(recoveryRevision);
      if (!position.recoveryRevision) {
        // Head and FileCut are sampled in this synchronous entry, before any continuation.
        orders = { binding: position.binding, revision: recoveryRevision, file: cut, observedAt,
          metadata: JSON.parse(JSON.stringify(this.publicBinding(binding))),
          capture: { state: this.metadata(ref).capture, finalSequence: this.closed ? this.sequence : null },
          descriptors: new Map(), materialized: new Map(), todoAdmitted: binding.headObserved, gaps: [] };
        this.recoveryOrders.set(recoveryRevision, orders);
        this.prepareOrders(fd, cut, orders);
      }
      if (!orders) throw new Error("unavailable public placement");
      page.binding = orders.metadata; page.capture = orders.capture;
      page.gaps.push(...orders.gaps);
      let offset = position.offset ?? 0;
      let ordinal = position.after;
      const records: CapturedRecord[] = [];
      const start = offset;
      let materialized = orders.materialized.get(start);
      if (position.fragment && !materialized) throw new Error("unavailable public placement");
      // One bounded line per call. Oversized lines are skipped with an explicit gap.
      const line = materialized ? { ...materialized, total: 0, entry: undefined } :
        this.nativeLine(fd, cut, offset, position.skipLine);
      offset = line.offset;
      const { ended, total, entry } = line;
      if (materialized) {
        ordinal = materialized.ordinal;
        page.gaps.push(...materialized.gaps);
      } else if (entry) {
        if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult")) {
          if (typeof entry.id !== "string" || !entry.id || !(entry.parentId === null || typeof entry.parentId === "string") ||
            typeof entry.timestamp !== "string" || !Number.isFinite(entry.message.timestamp)) throw new Error("invalid public native message");
          if (entry.message.role === "assistant" &&
            (entry.message.stopReason !== undefined && !["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(entry.message.stopReason) ||
              entry.message.errorMessage !== undefined && typeof entry.message.errorMessage !== "string"))
            throw new Error("invalid public native assistant outcome");
          const fields = { binding: binding.generation, nativeEntryId: entry.id,
            parentEntryId: entry.parentId, toolCallId: null, nativeTime: entry.timestamp, observedAt, sequence: null,
            order: this.recoveryOrder(orders, ++ordinal),
            revision: orders.revision, recovered: true as const, nativeOrder: null, occurredAt: entry.message.timestamp };
          if (entry.message.role === "toolResult") {
            const message = entry.message;
            if (typeof message.toolCallId !== "string" || !message.toolCallId || typeof message.toolName !== "string" ||
              typeof message.isError !== "boolean") throw new Error("invalid public native tool result");
            const todo = orders.todoAdmitted && orders.metadata.todoHead !== undefined && message.toolName === "todo"
              ? resolvePublicTodo(id => {
                const descriptor = orders!.descriptors.get(id);
                return descriptor?.todo ? this.nativeLine(fd!, cut, descriptor.offset).entry : descriptor;
              }, entry.id, this.todoLimits()) : undefined;
            if (todo?.budgetExceeded && !page.gaps.includes("unsupported_content")) page.gaps.push("unsupported_content");
            records.push({ ...fields, id: this.id(binding.generation, "tool", message.toolCallId), kind: "tool",
              toolCallId: message.toolCallId, payload: { status: message.isError ? "error" : "completed", name: message.toolName,
                argsState: "not_captured", result: content(message.content), isError: message.isError,
                ...(todo?.head.state === "ready" && todo.head.sourceEntryId === entry.id && todo.snapshot
                  ? { todoSnapshot: todo.snapshot } : {}) } });
          } else records.push({ ...fields, id: this.id(binding.generation, "entry", entry.id), kind: "message",
            payload: { role: entry.message.role,
              ...(entry.message.role === "assistant" ? { stopReason: entry.message.stopReason, errorMessage: entry.message.errorMessage } : {}),
              blocks: this.initialBrief.get(binding.generation)?.entryId === entry.id
              ? this.initialBrief.get(binding.generation)!.text === undefined ? [{ type: "omitted", reason: "unsupported_content" }]
                : [{ type: "text", text: this.initialBrief.get(binding.generation)!.text! }] : content(entry.message.content) } });
          const record = records[0]!;
          const retained = [...this.retained].reverse().find(item => item.record.binding === binding.generation &&
            item.record.id === record.id && item.record.sequence! <= position.cut)?.record;
          if (retained) {
            // A winning recovery upsert must not erase public fields absent from persistence.
            records[0] = { ...record, ...retained, order: record.order, sequence: null, revision: record.revision, recovered: true,
              nativeEntryId: retained.nativeEntryId ?? record.nativeEntryId,
              parentEntryId: retained.nativeEntryId ? retained.parentEntryId : record.parentEntryId,
              nativeTime: retained.nativeTime ?? record.nativeTime, occurredAt: retained.occurredAt ?? record.occurredAt };
            if (record.kind === "tool" && retained.kind === "tool" && record.payload.name === "todo") {
              // Native result/snapshot wins. Live-only permitted arguments and parent are retained.
              records[0] = { ...records[0]!, kind: "tool", toolCallId: record.toolCallId,
                nativeEntryId: record.nativeEntryId, parentEntryId: record.parentEntryId, nativeTime: record.nativeTime,
                payload: { ...record.payload, args: retained.payload.args, argsState: retained.payload.argsState } };
            }
          }
          const projected = records[0]!;
          this.place(binding.generation, record.id, record.order, record.revision, {
            nativeEntryId: projected.nativeEntryId, parentEntryId: projected.parentEntryId,
            nativeTime: projected.nativeTime, nativeOrder: projected.nativeOrder });
          this.changed();
        }
      } else page.gaps.push(position.skipLine || !ended && offset < cut.size || total > this.limits.worker
        ? "unsupported_content" : "capture_failed");
      if (!materialized) {
        materialized = { ...(records[0] ? { json: JSON.stringify(this.change(records[0])) } : {}),
          offset, ordinal, ended, gaps: page.gaps.filter(gap => gap !== "not_captured") };
        orders.materialized.set(start, materialized);
        this.changed();
      }
      records.length = 0;
      if (materialized.json) {
        const change = JSON.parse(materialized.json);
        records.push({ ...change.record, sequence: change.sequence });
      }
      const frozenPosition = { ...position, observedAt, recoveryRevision, file: cut,
        bindingMetadata: orders.metadata, capture: orders.capture };
      const fragmentPage = this.page(ref, frozenPosition, records, byteBudget, materialized.json);
      // Frozen metadata lives in the budgeted recipe, not in each signed cursor.
      const cursorPosition = { ...position, observedAt, recoveryRevision, file: cut };
      page.changes = fragmentPage.changes;
      page.next = fragmentPage.next ??
        (offset < cut.size ? this.encode({ ...cursorPosition, offset,
        after: ordinal, fragment: 0, skipLine: !ended }) : null);
      page.more = page.next !== null;
      if (!page.next) page.gaps.push("not_persisted"); // Transient tools are not recoverable from native messages.
      if (position.retentionEpoch !== this.retentionEpoch || !this.recoveryOrders.has(recoveryRevision))
        return { ...page, state: "resync_required", changes: [], next: null, more: false, gaps: ["evicted", "resync_required"] };
      return page;
    } catch (error) {
      if (error instanceof RangeError) throw error;
      if (error instanceof Error && error.message === "stale_cursor") {
        this.rejectRecovery(position.binding);
        if (!position.recoveryRevision) throw error;
        page.state = "resync_required";
      }
      page.changes = []; page.next = null; page.more = false;
      if (error instanceof Error && error.message === "unavailable public placement") page.state = "resync_required";
      page.gaps = page.state === "resync_required" ? ["evicted", "resync_required"] :
        [(error as NodeJS.ErrnoException).code === "ENOENT" ? "pruned" : "capture_failed"];
      return page;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
}

/** Producer owns the real SDK source until shutdown/disposal and reconciliation settle. */
export function createPublicProducer(session: AgentSession, history: SessionHistory) {
  let source: AgentSession | undefined = session;
  let capture: PublicConversation | undefined;
  let generation: number | undefined;
  let registeredSessionId: string | undefined;
  let registeredFile: string | undefined;
  let entryCount = 0;
  let initialUser = true;
  let queued: Promise<void> | undefined;
  const reconcile = (oldLeaf?: string | null) => {
    if (!source || !capture) return;
    if (registeredSessionId !== source.sessionId) {
      // Admission's registered member, not any filename exposed by a switched SDK context.
      const member = history.invocation.store.read(history.invocation.group.groupId).members
        .find(member => member.historyId === history.historyId);
      if (member?.native.state !== "allocated" || member.native.sessionId !== source.sessionId ||
        member.native.path !== source.sessionFile) throw new Error("unregistered public SDK session");
      registeredSessionId = source.sessionId; registeredFile = member.native.path;
    }
    if (source.sessionFile !== registeredFile) throw new Error("unregistered public SDK session");
    const worker = capture, native = source;
    worker.batch(() => {
      const next = worker.binding(history.historyId, native.sessionId, registeredFile);
      if (generation !== next) {
        if (generation !== undefined) worker.closeBinding(generation);
        entryCount = 0; initialUser = true; generation = next;
      }
      const entries = native.sessionManager.getEntries();
      const limits = worker.todoLimits();
      const ids = new Set<string>(), ambiguous = new Set<string>();
      if (entries.length <= limits.entries) for (const entry of entries) {
        if (ids.has(entry.id)) ambiguous.add(entry.id);
        ids.add(entry.id);
      }
      const lookup = (id: string) => entries.length > limits.entries || ambiguous.has(id)
        ? undefined : native.sessionManager.getEntry(id);
      let failed = false;
      for (const [index, entry] of entries.slice(entryCount).entries()) {
        const first = initialUser && entry.type === "message" && entry.message.role === "user";
        if (first) initialUser = false;
        try {
          const todo = entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo"
            ? resolvePublicTodo(lookup, entry.id, limits) : undefined;
          worker.entry(next, entry, first && history.invocation.origin?.source === "team_assign",
            history.invocation.origin?.workbrief, entryCount + index,
            todo?.head.state === "ready" && todo.head.sourceEntryId === entry.id ? todo.snapshot : undefined);
        } catch { failed = true; }
      }
      entryCount = entries.length;
      const head = native.sessionManager.getLeafId();
      worker.head(next, head, entries, oldLeaf, resolvePublicTodo(lookup, head, limits).head);
      if (failed) worker.fail();
    });
  };
  const safely = (oldLeaf?: string | null) => { try { reconcile(oldLeaf); } catch { capture?.fail(); } };
  return {
    attach(worker: PublicConversation) { capture = worker; safely(); },
    reconcile: safely,
    event(event: AgentSessionEvent) {
      if (!capture || !source) return;
      if (generation !== undefined) {
        try { capture.tool(generation, event); } catch { capture.fail(); }
      }
      if (event.type === "message_end" || event.type === "agent_end" || event.type === "entry_appended") {
        queued ??= new Promise<void>(resolve => queueMicrotask(() => { safely(); queued = undefined; resolve(); }));
      }
    },
    async close(failed = false) {
      try {
        await queued;
        safely();
        if (generation !== undefined) capture?.closeBinding(generation, failed);
      } catch { capture?.fail(); }
      finally { source = undefined; }
    },
  };
}
