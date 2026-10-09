import { expect, test } from "bun:test";
import { MissionProgress } from "../extensions/mission/progress.ts";
import type { MissionEvent } from "../extensions/mission/model.ts";
import { missionDefinition } from "./mission-fixtures.ts";

test("progress reports observed usage, revision outcomes and actionable stops, never percent from estimates", () => {
  const { budget: _budget, schemaVersion: _schema, resourcePolicy: _policy, ...base } = missionDefinition();
  const definition = { ...base, schemaVersion: 3 as const,
    resourcePolicy: { limits: {}, estimates: { activeTimeMs: 1, tokens: 1 } } };
  const progress = new MissionProgress("fixture", definition);
  let seq = 0;
  const event = (kind: string, payload: Record<string, unknown> = {}, revision = 1, unitId?: string): MissionEvent => ({
    missionId: crypto.randomUUID(), eventId: crypto.randomUUID(), causalId: crypto.randomUUID(), schemaVersion: 1,
    seq: ++seq, revision, kind, payload, occurredAt: new Date(1000).toISOString(), unitId: unitId ?? null,
    runtimeId: "fixture", monotonicDurationMs: null, attemptId: null, effectId: null, teamRoundId: null,
    reason: null, provenance: null,
  });
  progress.accept([event("mission.created"), event("mission.activated"), event("attempt.started", {}, 1, "T1"),
    event("unit.accepted", {}, 1, "T1"),
    event("resource.metered.admitted", { ticket: { ticketId: "time", resource: "active-time-ms" } }),
    event("resource.metered.settled", { ticketId: "time", knownCharge: 100, outstanding: false }),
    event("resource.metered.admitted", { ticket: { ticketId: "tokens", resource: "tokens" } }),
    event("resource.metered.settled", { ticketId: "tokens", knownCharge: 20, unknown: true, outstanding: false })]);
  expect(progress.text(1200)).toContain("elapsed 200ms");
  expect(progress.text(1200)).toContain("active 100ms");
  expect(progress.text(1200)).toContain("tokens 20+ unknown/pending");
  expect(progress.text(1200)).toContain("estimates: 1ms / 1 tokens");
  expect(progress.text(1200)).toContain("caps: none / none tokens");
  expect(progress.text(1200)).not.toContain("%");
  const revised = event("mission.revised", { retained: ["T1"], snapshot: { units: [{}, {}] } }, 2);
  progress.accept([revised, event("mission.blocked", { blockers: ["Restore missing runtime input"] }, 2)]);
  expect(progress.text()).toContain("r2");
  expect(progress.text()).toContain("accepted 1/2");
  expect(progress.text()).toContain("Restore missing runtime input; /mission inspect fixture");
  expect(progress.text()).toContain("caps: unknown for revised contract");
  // Repaint/replay of the same tail cannot double-count usage.
  progress.accept([revised]);
  expect(progress.text()).toContain("active 100ms");
});
