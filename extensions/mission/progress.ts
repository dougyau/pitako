import type { MissionDefinition, MissionEvent } from "./model.ts";
import { resourcePolicy } from "./resources.ts";

/** Display cache only. Never authority, never hydrates artifacts or checks physical inputs. */
export class MissionProgress {
  cursor = 0;
  revision = 0;
  phase = "prepared";
  current = "";
  reason = "";
  private accepted = new Set<string>();
  private startedAt?: number;
  private unitCount: number;
  private policy: ReturnType<typeof resourcePolicy> | undefined;
  private usage = new Map<string, { resource: string; charge: number; unknown: boolean; outstanding: boolean }>();

  constructor(readonly planId: string, definition: MissionDefinition) {
    this.unitCount = definition.units.length;
    this.policy = resourcePolicy(definition);
  }

  accept(events: readonly MissionEvent[]) {
    for (const event of events) {
      if (event.seq <= this.cursor) continue;
      this.cursor = event.seq;
      if (event.revision !== this.revision) {
        this.revision = event.revision;
        const retained = event.kind === "mission.revised" ? new Set(preserved(event.payload.retained)) : new Set<string>();
        this.accepted = new Set([...this.accepted].filter(id => retained.has(id)));
        this.current = "";
        this.reason = "";
      }
      const p = event.payload;
      if (event.kind === "mission.revised") {
        const snapshot = p.snapshot as { units: unknown[] };
        this.unitCount = snapshot.units.length;
        this.policy = undefined; // Revised limits require a fresh binding, not guessed from old display data.
      }
      if (event.kind === "mission.created") this.startedAt = Date.parse(event.occurredAt);
      if (event.kind === "mission.activated" || event.kind === "mission.resumed") { this.phase = "running"; this.reason = ""; }
      if (event.kind === "mission.setup.intent" || event.kind === "mission.setup.invoking") this.phase = "setup";
      if (event.kind === "mission.finalization.phase.started") this.phase = `finalization ${String(p.phase)}`;
      if (event.kind === "attempt.started" || event.kind === "unit.verifying") this.current = event.unitId ?? "";
      if (event.kind === "unit.accepted" && event.unitId) this.accepted.add(event.unitId);
      if (["mission.completed", "mission.cancelled", "mission.paused", "mission.blocked"].includes(event.kind)) {
        this.phase = event.kind.slice(8);
        this.reason = typeof p.reason === "string" ? p.reason :
          Array.isArray(p.blockers) ? p.blockers.join("; ") : "";
      }
      if (["resource.metered.admitted", "reservation.created"].includes(event.kind)) {
        const ticket = p.ticket as { ticketId: string; resource: string } | undefined;
        const id = ticket?.ticketId ?? String(p.reservationId);
        this.usage.set(id, { resource: ticket?.resource ?? String(p.resource),
          charge: Number(p.knownCharge ?? 0), unknown: false, outstanding: ticket ? p.outstanding !== false : true });
      }
      if (["resource.metered.settled", "budget.reservation.settled"].includes(event.kind)) {
        const row = this.usage.get(String(p.ticketId ?? p.reservationId));
        if (row) {
          row.charge = Number(p.knownCharge ?? 0);
          row.unknown = p.unknown === true || Number(p.unknownCharge ?? 0) > 0;
          row.outstanding = p.outstanding === true;
        }
      }
    }
  }

  text(now = Date.now()) {
    const policy = this.policy;
    const usage = (resource: string) => {
      const rows = [...this.usage.values()].filter(row => row.resource === resource);
      return rows.length ? `${rows.reduce((sum, row) => sum + row.charge, 0)}${rows.some(row => row.unknown || row.outstanding) ? "+ unknown/pending" : ""}` : "unknown";
    };
    const time = (ms?: number) => ms === undefined ? "none" : `${ms}ms`;
    const estimates = policy ? `estimates: ${time(policy.estimates.activeTimeMs)} / ${policy.estimates.tokens ?? "none"} tokens` : "estimates: unknown for revised contract";
    const caps = policy ? `caps: ${time(policy.limits.activeTimeMs)} / ${policy.limits.tokens ?? "none"} tokens` : "caps: unknown for revised contract; /mission inspect";
    const elapsed = this.startedAt === undefined ? "unknown" : `${Math.max(0, now - this.startedAt)}ms`;
    const active = usage("active-time-ms");
    return `Mission ${this.planId} r${this.revision} · ${this.phase}${this.current ? ` / ${this.current}` : ""} · accepted ${this.accepted.size}/${this.unitCount} · elapsed ${elapsed} · active ${active === "unknown" ? active : `${active}ms`} · tokens ${usage("tokens")} · ${estimates} · ${caps}${this.reason ? ` · ${this.reason}; /mission inspect ${this.planId}` : ""}`;
  }
}

function preserved(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}
