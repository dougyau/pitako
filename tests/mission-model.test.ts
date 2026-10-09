import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  MissionValidationError,
  validateEvaluationObservation,
  validateMeasurement,
  validateMissionDefinition,
  validateMissionDefinitionBytes,
  type EvaluationObservation,
  type MissionMeasurement,
} from "../extensions/mission/model.ts";
import { missionDefinition } from "./mission-fixtures.ts";

describe("mission domain schemas", () => {
  test("validates typed units, policy bindings, finite limits, and dependency references", () => {
    const definition = missionDefinition();
    definition.units.push({
      id: "verify",
      dependencies: ["snapshot"],
      kind: "check",
      role: "developer",
      inputs: ["snapshot"],
      outputs: [],
      acceptance: [{ id: "verify-pass", kind: "command_exit", target: "bun test" }],
      risk: "medium",
      retryLimit: 1,
    });
    definition.finalization.requiredPredicates.push("verify-pass");

    expect(validateMissionDefinition(definition)).toEqual(definition);
    const bytes = Buffer.from(JSON.stringify(definition));
    expect(validateMissionDefinitionBytes(bytes)).toEqual({
      definition,
      hash: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  test("fails closed for malformed UTF-8, unknown schema fields, and incomplete definitions", () => {
    expect(() => validateMissionDefinitionBytes(Buffer.from([0xff, 0xfe]))).toThrow(/UTF-8 JSON/);
    expect(() => validateMissionDefinition({ ...missionDefinition(), schemaVersion: 4 })).toThrow(/schema 4 is not supported/);
    expect(() => validateMissionDefinition({ ...missionDefinition(), schemaVersion: 2 })).toThrow(/model target must be an object/);
    expect(() => validateMissionDefinition({ ...missionDefinition(), injectedExecutor: "run()" })).toThrow(/unknown: injectedExecutor/);
    expect(() => validateMissionDefinition({ ...missionDefinition(), units: [] })).toThrow(/non-empty array/);
  });

  test("rejects unknown dependencies, dependency cycles, presentation cycles, and missing predicates", () => {
    const unknown = missionDefinition();
    unknown.units[0]!.dependencies = ["missing"];
    expect(() => validateMissionDefinition(unknown)).toThrow(/unknown unit missing/);

    const cycle = missionDefinition();
    cycle.units.push({ ...cycle.units[0]!, id: "other", dependencies: ["snapshot"], acceptance: [{ id: "other-pass", kind: "manual", target: "other" }] });
    cycle.units[0]!.dependencies = ["other"];
    cycle.finalization.requiredPredicates.push("other-pass");
    expect(() => validateMissionDefinition(cycle)).toThrow(/dependency cycle/);

    const parentCycle = missionDefinition();
    parentCycle.units.push({ ...parentCycle.units[0]!, id: "other", parentId: "snapshot", acceptance: [{ id: "other-pass", kind: "manual", target: "other" }] });
    parentCycle.units[0]!.parentId = "other";
    parentCycle.finalization.requiredPredicates.push("other-pass");
    expect(() => validateMissionDefinition(parentCycle)).toThrow(/parent cycle/);

    const missingPredicate = missionDefinition();
    missingPredicate.finalization.requiredPredicates.push("forged-pass");
    expect(() => validateMissionDefinition(missingPredicate)).toThrow(/unknown predicate forged-pass/);
  });

  test("records unknown measurements explicitly and validates evaluation observations", () => {
    const missionId = randomUUID();
    const measurement: MissionMeasurement = {
      schemaVersion: 1,
      id: randomUUID(),
      missionId,
      revision: 1,
      causalId: randomUUID(),
      metric: "provider-input-tokens",
      value: null,
      unit: "tokens",
      source: "provider receipt",
      occurredAt: "2026-09-27T00:00:00.000Z",
      runtimeId: randomUUID(),
      durationMs: null,
      unknownReason: "provider ended before usage receipt",
      inputTokens: null,
      outputTokens: null,
      usageUnknownReason: "provider usage unavailable",
    };
    expect(validateMeasurement(measurement, missionId)).toEqual(measurement);
    expect(() => validateMeasurement({ ...measurement, unknownReason: undefined }, missionId)).toThrow(/unknown measurement value requires unknownReason/);
    expect(() => validateMeasurement({ ...measurement, usageUnknownReason: undefined }, missionId)).toThrow(/unknown token usage requires usageUnknownReason/);

    const observation: EvaluationObservation = {
      schemaVersion: 1,
      id: randomUUID(),
      missionId,
      revision: 1,
      resultManifestHash: "b".repeat(64),
      criterionVersion: "outcome-v1",
      evaluatorIdentity: "independent-fixture",
      method: "read exact exported artifact",
      observedAt: "2026-09-27T00:01:00.000Z",
      windowStart: null,
      windowEnd: null,
      evidenceRefs: ["export.json"],
      verdict: "unassessed",
      classification: "outcome",
      supersedesId: null,
    };
    expect(validateEvaluationObservation(observation, missionId)).toEqual(observation);
    expect(() => validateEvaluationObservation({ ...observation, verdict: "success" }, missionId)).toThrow(/verdict must be one of/);
    expect(() => validateEvaluationObservation(observation, randomUUID())).toThrow(/does not match target mission/);
  });
});
