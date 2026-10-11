import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Input, ScrollView, matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi,
  type Component, type Focusable,
} from "@earendil-works/pi-tui";
import type { createAgentController } from "./controller.ts";
import { formatUiClock } from "./ui.ts";
import type { HistoryPage } from "./history-query.ts";
import type { PaneView } from "../herdr/agents-ui/protocol.ts";

export type AgentView = ReturnType<ReturnType<typeof createAgentController>["openView"]>;
type Detail = ReturnType<AgentView["detail"]>;
type List = ReturnType<AgentView["list"]>;
type Section = "Brief" | "Activity" | "Identity & route" | "Receipts" | "Native history";
const sections: Section[] = ["Brief", "Activity", "Identity & route", "Receipts", "Native history"];
const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
const json = (value: unknown) => value == null ? "unknown / unavailable" : JSON.stringify(value, null, 2);

/** The hosts supply a scoped view and viewport. The component never owns a worker or terminal. */
export class AgentScreen implements Component, Focusable {
  focused = true;
  private list: List;
  private selected = 0;
  private detail?: Detail;
  private section = 0;
  private briefOffset = 0;
  private activityAfter?: number;
  private routePage?: ReturnType<AgentView["route"]>;
  private requestPage?: ReturnType<AgentView["requests"]>;
  private historyPage?: HistoryPage;
  private historyId?: string;
  private historySelected = 0;
  private form?: "query" | "steer" | "cancel" | "history" | "route";
  private readonly input = new Input({ prompt: "> " });
  private message = "";
  private mutationError = "";
  private closed = false;
  private revision = 0;
  private work?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshedAt = performance.now();
  private closing?: Promise<void>;
  private readonly scroll: ScrollView;
  private content: string[] = [];

  constructor(
    private readonly view: PaneView,
    private readonly repaint: () => void,
    private readonly close: () => void,
    private readonly rows: () => number,
    instanceId?: string,
  ) {
    this.list = { items: [], cursor: null, owner: { processId: "", coordinatorSessionId: "", epoch: "00000000-0000-0000-0000-000000000000" } };
    this.scroll = new ScrollView({ render: () => this.content, invalidate() {} }, { scrollbar: "hidden" });
    this.input.onEscape = () => { this.form = undefined; this.paint(); };
    this.input.onSubmit = text => this.submit(text);
    this.load(() => instanceId ? view.detail(instanceId) : view.list(), value => {
      if (instanceId) this.detail = value as Detail; // unknown exact IDs are errors, not list fallback
      else this.list = value as List;
    });
    this.schedule();
  }

  private paint() { if (!this.closed) this.repaint(); }
  private stopTimer() { clearTimeout(this.timer); this.timer = undefined; }
  private schedule() {
    this.stopTimer();
    if (!this.closed && (this.detail?.controls.available || this.detail?.observation?.active || this.view.connection) && !this.form && !this.work) {
      const timer = setTimeout(() => {
        if (this.closed || this.timer !== timer) return;
        this.refresh(); this.paint(); this.schedule();
      }, 1000);
      this.timer = timer;
      this.timer.unref?.();
    }
  }
  private refresh(pageChange = false) {
    if (this.closed || this.work) return;
    if (this.detail && !pageChange && performance.now() - this.refreshedAt < 1000) return;
    try {
      if (this.detail) this.load(() => this.view.detail(this.detail!.id, this.briefOffset, this.activityAfter), value => { this.detail = value; });
      else this.load(() => this.view.list(), value => { this.list = value; });
      this.refreshedAt = performance.now();
    } catch (error) {
      this.message = String(error);
      if (this.detail) this.detail.controls = { available: false, reason: this.message };
    }
  }
  private load<T>(read: () => T | Promise<T>, apply: (value: T) => void, mutationId?: string) {
    if (this.work || this.closed) return;
    const value = read(), revision = this.revision;
    if (value instanceof Promise) void this.run(async () => {
      const result = await value;
      if (!this.closed && revision === this.revision) apply(result);
    }, false, mutationId);
    else apply(value);
  }
  private async run(operation: () => Promise<void>, refresh = true, mutationId?: string) {
    if (this.work || this.closed) return;
    const revision = this.revision;
    this.stopTimer();
    this.work = (async () => {
      try { await operation(); }
      catch (error) {
        if (!this.closed) {
          // Read/reconnect errors cannot reclassify an unacknowledged mutation.
          if (mutationId) {
            this.mutationError = `${mutationId}: ${String(error)}`;
            if (revision === this.revision) this.message = "";
          }
          else if (revision === this.revision) this.message = String(error);
        }
      }
    })();
    this.paint();
    await this.work;
    this.work = undefined;
    if (!this.closed) { if (refresh) this.refresh(); this.paint(); this.schedule(); }
  }
  private switchView() {
    ++this.revision;
    this.stopTimer();
    this.form = undefined;
    this.message = "";
    this.routePage = this.requestPage = undefined;
    this.historyPage = undefined; this.historyId = undefined; this.historySelected = 0;
    this.briefOffset = 0; this.activityAfter = undefined;
    this.scroll.scrollToStart();
  }
  private begin(form: NonNullable<AgentScreen["form"]>) {
    if (this.view.connection?.()) { this.message = this.view.connection(); return; }
    if (this.work) { this.message = "Wait for outstanding work to settle"; return; }
    if ((form === "query" || form === "steer" || form === "cancel") && !this.detail?.controls.available) {
      this.message = this.detail?.controls.reason ?? "No live selection"; return;
    }
    this.stopTimer(); this.form = form; this.input.setValue(""); this.scroll.scrollToStart();
  }
  private submit(text: string) {
    const form = this.form, detail = this.detail;
    if (!form || !detail || this.work) return;
    if (form === "cancel") {
      if (text !== "yes") { this.message = "Not cancelled; confirmation must be yes"; }
      else if (detail.controls.selection) {
        const selection = detail.controls.selection;
        this.load(() => this.view.cancel(selection), value => { this.message = json(value) + "\nRequested, not settled. Reobserve lifecycle."; }, detail.id);
      }
    } else if (form === "history" || form === "route") {
      if (text !== "yes") this.message = "Sensitive read not acknowledged";
      else {
        const acknowledged = <T>(read: () => T | Promise<T>) => {
          const ack = this.view.acknowledge(form);
          return ack instanceof Promise ? ack.then(read) : read();
        };
        if (form === "route")
          this.load(() => acknowledged(() => this.view.route(detail.id)), value => { this.routePage = value; });
        else
          this.load(() => acknowledged(() => this.view.history(this.historyId ? { action: "read", historyId: this.historyId, limit: 20 }
            : { action: "list", limit: 20 }, { instanceId: detail.id })), value => { this.historyPage = value; });
      }
    } else if (detail.controls.selection) {
      if (!text.trim() || Buffer.byteLength(text) > 16 * 1024) { this.message = "Text must be nonempty and at most 16KiB"; return; }
      const selection = detail.controls.selection, revision = this.revision;
      this.message = "pending: input attempt, not admission";
      void this.run(async () => {
        const receipt = await this.view.input(selection, { intent: form, text });
        if (!this.closed && revision === this.revision) this.message = json(receipt);
      }, true, detail.id);
    }
    this.form = undefined; this.paint(); this.schedule();
  }
  private readHistory(cursor?: string) {
    const detail = this.detail, historyId = this.historyId, revision = this.revision;
    if (!detail) return;
    return this.run(async () => {
      const page = await this.view.history(historyId ? { action: "read", historyId, cursor, limit: 20 }
        : { action: "list", cursor, limit: 20 }, { instanceId: detail.id });
      if (!this.closed && revision === this.revision) {
        this.historyPage = page;
        this.historySelected = Math.max(0, page.items.findIndex(item => !!item && typeof item === "object" && "historyId" in item));
        this.scroll.scrollToStart();
      }
    });
  }

  handleInput(data: string): void {
    try { this.interact(data); }
    catch (error) { this.message = String(error); this.paint(); this.schedule(); }
  }
  private interact(data: string): void {
    if (this.closed) return;
    if (data === "R" && this.view.reconnect) {
      void this.run(async () => {
        await this.view.reconnect!();
        if (this.detail) this.detail = await this.view.detail(this.detail.id, this.briefOffset, this.activityAfter);
        else this.list = await this.view.list();
        this.message = "Reconnected and reobserved; lost mutations were not replayed";
      }, false);
      return;
    }
    if (this.form) {
      this.input.focused = this.focused;
      this.input.handleInput(data);
      const value = this.input.getValue();
      const safeValue = clean(value).replaceAll("\n", " ");
      if (safeValue !== value) this.input.setValue(safeValue);
      if (Buffer.byteLength(this.input.getValue()) > 16 * 1024) {
        this.input.setValue(Buffer.from(this.input.getValue()).subarray(0, 16 * 1024 - 3).toString("utf8"));
        this.message = "Input clipped at 16KiB; review text before submitting";
      }
      this.paint(); this.schedule(); return;
    }
    if (matchesKey(data, "escape")) {
      if (this.detail) { this.switchView(); this.detail = undefined; this.refresh(); }
      else { void this.finish(); return; }
    } else if (!this.detail) {
      if (matchesKey(data, "down")) this.selected = Math.min(this.list.items.length - 1, this.selected + 1);
      else if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
      else if (matchesKey(data, "return") && this.list.items[this.selected]) {
        const id = this.list.items[this.selected]!.id;
        this.switchView(); this.load(() => this.view.detail(id), value => { this.detail = value; });
        this.refreshedAt = performance.now();
      } else if (data === "n" && this.list.cursor) {
        this.load(() => this.view.list(this.list.cursor!), value => { this.list = value; this.selected = 0; });
      }
      else if (data === "r") this.refresh();
    } else if (/^[1-5]$/.test(data)) {
      this.switchView(); this.section = Number(data) - 1;
      if (this.section !== 3 && this.section !== 4) this.refresh(true);
      if (this.section === 4) void this.readHistory(); // metadata only, no raw fetch
      if (this.section === 3) this.load(() => this.view.requests(this.detail!.id), value => { this.requestPage = value; });
    } else if (data === "q" || data === "s" || data === "c") this.begin(data === "q" ? "query" : data === "s" ? "steer" : "cancel");
    else if (data === "r") this.refresh();
    else if (data === "p" && !this.work) {
      this.briefOffset = 0; this.activityAfter = this.section === 1 ? 0 : undefined;
      if (this.section === 2 && this.routePage) this.load(() => this.view.route(this.detail!.id), value => { this.routePage = value; });
      else if (this.section === 3) this.load(() => this.view.requests(this.detail!.id), value => { this.requestPage = value; });
      else if (this.section === 4) void this.readHistory();
      else this.refresh(true);
      this.scroll.scrollToStart();
    }
    else if (data === "a" && (this.section === 2 || this.section === 4)) this.begin(this.section === 2 ? "route" : "history");
    else if (data === "n" && !this.work) {
      if (this.section === 0 && this.detail.workbrief.nextOffset !== null) {
        this.briefOffset = this.detail.workbrief.nextOffset; this.refresh(true);
      } else if (this.section === 1 && this.detail.observation?.more === true && typeof this.detail.observation.cursor === "number") {
        this.activityAfter = this.detail.observation.cursor; this.refresh(true);
      } else if (this.section === 2 && this.routePage?.nextOffset != null)
        this.load(() => this.view.route(this.detail!.id, this.routePage!.nextOffset!), value => { this.routePage = value; });
      else if (this.section === 3 && this.requestPage?.nextOffset != null)
        this.load(() => this.view.requests(this.detail!.id, this.requestPage!.nextOffset!), value => { this.requestPage = value; });
      else if (this.section === 4 && this.historyPage?.cursor) void this.readHistory(this.historyPage.cursor);
      this.scroll.scrollToStart();
    } else if (this.section === 4 && !this.historyId && data === "j") {
      this.historySelected = Math.min((this.historyPage?.items.length ?? 1) - 1, this.historySelected + 1);
    } else if (this.section === 4 && !this.historyId && data === "k") this.historySelected = Math.max(0, this.historySelected - 1);
    else if (this.section === 4 && !this.historyId && matchesKey(data, "return")) {
      const item = this.historyPage?.items[this.historySelected];
      if (item && typeof item === "object" && "historyId" in item && typeof item.historyId === "string") {
        this.historyId = item.historyId; this.historyPage = undefined; this.begin("history");
      }
    } else if (matchesKey(data, "down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "up")) this.scroll.scrollBy(-1);
    else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(this.scroll.viewportHeight);
    else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-this.scroll.viewportHeight);
    this.paint(); this.schedule();
  }

  private lines(): string[] {
    if (!this.detail) return this.list.items.length ? this.list.items.map((row, index) =>
      `${index === this.selected ? ">" : " "} ${row.id} · ${row.roleId} · ${row.profile ?? (row.roleId === "developer" ? "profile unavailable" : "profile not applicable")} · ${row.status}\n` +
      `  selected: ${row.selectedModel ?? "unknown"} · requested: ${row.requestedModel ?? "unknown"} / ${row.requestedReasoning ?? "unknown"}\n` +
      `  activated: ${json(row.activated)} · SDK request: ${json(row.sdkRequest)}\n` +
      `  elapsed ${formatUiClock((row.terminalAt ?? Date.now()) - row.acceptedAt)} · ${row.phase} · ${row.activity} · ${row.task}`)
      : ["No workers"];
    const detail = this.detail;
    switch (sections[this.section]) {
      case "Brief": return [`original WorkBrief · offset ${detail.workbrief.offset} · next ${detail.workbrief.nextOffset ?? "end"}`,
        detail.workbrief.text, ...(detail.teamWrapper ? ["Team wrapper (not original WorkBrief)", detail.teamWrapper] : [])];
      case "Activity": return detail.observation ? [json(detail.observation)]
        : ["Activity unavailable: no live native binding. Past native entries require acknowledged history; no persistence inferred."];
      case "Identity & route": return [json({ id: detail.id, role: detail.roleId, status: detail.status, identity: detail.identity }),
        "Selected / requested (not observed activation)", json(detail.selected), "Activated", json(detail.activated),
        "Observed SDK request (not selected)", json(detail.sdkRequest), `SDK requests dropped: ${detail.sdkRequestsDropped}`,
        "Captured route (no rerouting)", json(detail.route), ...(this.routePage ? ["Acknowledged raw route", json(this.routePage)] : ["a: acknowledge raw route"])];
      case "Receipts": return ["pending = attempt; queued = admission; handled = input hook consumption, not answer.",
        "candidateAnswer is a candidate only; adequacy not evaluated. unconfirmed/rejected are not delivery.",
        json(detail.observation?.interactions), "SDK request provenance pages", json(this.requestPage)];
      case "Native history": return ["Native worker source only; all branches/actions in physical order.",
        "Partial entries, persistence gaps, upstream truncation and unavailable external artifacts remain limits.",
        "Decoded fragment previews may split UTF-8; byteOffset/endsEntry and original base64 pages remain authoritative.",
        ...(!this.historyId ? [`Metadata selection ${this.historySelected + 1}; j/k select · Enter acknowledge selected history`] : [`History ${this.historyId}`]),
        json(this.historyPage?.diagnostics), ...(this.historyPage?.items.flatMap((item, index) => {
          if (item && typeof item === "object" && "encoding" in item && item.encoding === "base64" && "data" in item && typeof item.data === "string") {
            const { data, ...metadata } = item;
            return [json(metadata), Buffer.from(data, "base64").toString("utf8")];
          }
          return [`${index === this.historySelected ? ">" : " "} ${json(item)}`];
        }) ?? ["No page fetched"]), `Next: ${this.historyPage?.cursor ? "n (on demand)" : "none"}`];
    }
    return [];
  }
  render(width: number): string[] {
    width = Math.max(1, width);
    const height = Math.max(1, Math.floor(this.rows()));
    const title = this.detail ? `Agents · ${this.detail.id} · ${sections[this.section]}` : "Agents · list";
    const help = this.detail ? "1 Brief · 2 Activity · 3 Route · 4 Receipts · 5 History · q query · s steer · c cancel · n next · p first · r refresh · ↑/↓ scroll · Esc list"
      : "↑/↓ select · Enter detail · n next page · r refresh · Esc close";
    const form = this.form ? [`${this.form}: ${this.form === "query" || this.form === "steer" ? "text, not a command · Enter submit · Esc back" : "sensitive read / cancel request · type yes to confirm · Esc back"}`,
      ...this.input.render(width)] : [];
    this.content = [...(this.view.connection?.() ? [this.view.connection()] : []), ...(this.mutationError ? [this.mutationError] : []),
      ...(this.message ? [this.message] : []),
      ...(this.detail && !this.detail.controls.available ? [`Controls unavailable: ${this.detail.controls.reason ?? "No live selection"}`] : []),
      ...this.lines(), ...(this.work ? ["Outstanding work; navigation may discard its display, not its settlement."] : [])]
      .flatMap(line => clean(line).split("\n").flatMap(part => wrapTextWithAnsi(part, width)));
    this.scroll.updateLayout(this.content.length, Math.max(0, height - 2 - form.length), () => this.paint());
    if (!this.detail) this.scroll.scrollTo(this.content.findIndex(line => line.startsWith(">")));
    const body = this.content.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.scroll.viewportHeight);
    const safeLine = (line: string) => clean(truncateToWidth(clean(line).replaceAll("\n", " "), width, ""));
    return [safeLine(title), ...body.map(safeLine),
      ...form.map((line, index) => index === 0 ? safeLine(line) : truncateToWidth(line, width, "")), safeLine(help)].slice(0, height);
  }
  invalidate(): void { this.input.invalidate(); }
  /** Synchronous revocation; asynchronous accepted work is joined before the host's done callback. */
  dispose(): void { void this.finish(); }
  finish(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; ++this.revision; this.stopTimer();
    return this.closing = (async () => {
      await this.work;
      await this.view.close();
      this.close();
    })();
  }
}

/** Pi owns its terminal, footer, status and editor. */
export async function openAgentScreen(ctx: ExtensionContext, controller: ReturnType<typeof createAgentController>, instanceId?: string): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("The agent screen requires an interactive Pi terminal");
  const view = controller.openView();
  let screen: AgentScreen | undefined;
  try {
    await ctx.ui.custom<void>((tui, _theme, _keys, done) =>
      screen = new AgentScreen(view, () => tui.requestRender(), done, () => tui.terminal.rows, instanceId));
  } finally {
    if (screen) await screen.finish();
    else await view.close();
  }
}

/** T1's passive host probe uses this same component without authority or runtime work. */
export const compatibilityAgents = [{ id: "fixture-alpha", role: "developer", state: "working" },
  { id: "fixture-beta", role: "reviewer", state: "idle" }] as const;
export function compatibilityView(agents: readonly { id: string; role: string; state: string }[] = compatibilityAgents): AgentView {
  const denied = () => { throw new Error("Compatibility fixture is read-only"); };
  return {
    list: () => ({ items: agents.map(row => ({ id: row.id, roleId: row.role, status: "running", source: undefined,
      assignmentId: undefined, task: "", selectedModel: "unknown", requestedModel: undefined, requestedReasoning: undefined, activated: undefined, sdkRequest: null,
      acceptedAt: Date.now(), terminalAt: undefined, activity: row.state, phase: "working", profile: undefined })),
    cursor: null, owner: { processId: "fixture", coordinatorSessionId: "fixture", epoch: "00000000-0000-0000-0000-000000000000" } }),
    detail: id => {
      const row = agents.find(row => row.id === id);
      if (!row) throw new Error(`unknown worker ${id}`);
      return { id, roleId: row.role, status: "running", observation: null,
        identity: { coordinatorSessionId: "fixture", source: undefined, assignmentId: undefined },
        workbrief: { text: `Identity: ${id}\nRole: ${row.role}\nState: ${row.state}`, offset: 0, nextOffset: null, source: "original WorkBrief" },
        teamWrapper: undefined, route: { state: "unavailable" }, selected: { model: "unknown", reasoning: undefined, requestedModel: undefined, attemptId: undefined },
        activated: null, sdkRequest: null, sdkRequestsDropped: 0, controls: { available: false, reason: "Compatibility fixture is read-only" } };
    },
    observe: denied, requests: denied, route: denied, history: async () => denied(), input: async () => denied(),
    cancel: denied, acknowledge: denied, close: async () => {},
  };
}
