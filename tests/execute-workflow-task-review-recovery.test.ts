import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { readBacklog } from "../skills/execute/loop.ts";
import { RunFanoutLimitError } from "../node_modules/pi-subagents/src/runs/shared/run-fanout-budget.js";
import { copy, executeControllerFixture, type Result } from "./fixtures/execute-workflow.ts";
import { canonicalDigest } from "../extensions/canonical.mjs";
import { executeScope, executeStore } from "../skills/execute/ledger.mjs";
import { pitakoAgentFamily } from "../skills/agent-names.mjs";

const { fixture } = executeControllerFixture();
const reviewChildren = (key: string) => /\.task-(reviewer|synthesis)$/.test(key);
const noUnit = (host: ReturnType<typeof fixture>) =>
  expect(host.records().some((record: { kind: string }) => record.kind === "unit")).toBe(false);
const settledSynthesis = (cursor: any) => cursor.review?.slots.some((slot: { key: string; runId: string | null }) =>
  slot.key.endsWith(".task-synthesis") && slot.runId);
function pinned(host: ReturnType<typeof fixture>, cursor = host.current()) {
  const scope = executeScope(cursor.invocation, cursor.epoch);
  const { store } = executeStore(host.root, cursor.invocation, false, cursor.epoch);
  return store.readRecords(scope, cursor.head).records;
}
function budget(key: string) {
  const error = new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: `workflow[${key}]`,
    used: 64, limit: 64, requested: 1, remaining: 0 }).message;
  return { key, ok: false, error, output: error, artifactPaths: [] };
}
function reject(result: Result) {
  (result.structuredOutput as Record<string, unknown>).correctness = { verdict: "Required path incomplete", score: 8, findings: [{
    summary: "Required error path broken", evidence: "src/change1.ts:1", introducedByDelta: true, affectsTask: true,
  }] };
  writeFileSync(result.results![0]!.savedOutputPath!, JSON.stringify(result.structuredOutput));
}

test.each(["reviewer", "synthesis"])("%s model failures block without gaps, retry or fallback", async stage => {
  for (const error of ["Unknown subagent model 'custom/missing' in the active Pi model registry.", "Provider authentication failed"]) {
    const host = fixture(); host.setLimit(1);
    host.setRespond((request, normal) => request.key.endsWith(`.task-${stage}`)
      ? { ...(error.startsWith("Provider") ? normal() : {}), ok: false, key: request.key,
        error, structuredOutput: undefined } : normal());
    const output = await host.execute();
    expect(output.status, output.reason).toBe("blocked");
    expect(output.reason).toContain(`pitako.execute.${stage === "reviewer" ? "taskReviewer" : "taskSynthesis"}`);
    expect(output.reason).toContain(stage === "reviewer" ? "openai-codex/gpt-6.1-sol:xhigh" : "anthropic/claude-opus-5-5:high");
    expect(output.reason).toContain(error);
    expect(output.reason).toContain("start a new invocation");
    expect(host.current().halt.stage).toBe("task-review-model");
    expect(host.current().loop.outcome).toBeNull();
    expect(host.launches.filter(call => reviewChildren(call.key))).toHaveLength(stage === "reviewer" ? 1 : 2);
    const count = host.launches.length;
    const replay = await host.execute();
    expect(replay.reason).toBe(output.reason);
    expect(replay.loopReport.halt).toEqual(output.loopReport.halt);
    expect(host.launches).toHaveLength(count);
    expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
  }
});

test.each(["reviewer", "synthesis"].flatMap(stage => ["Stop", "permission"].map(cause => [stage, cause])))(
  "%s native %s remains cancelled and cannot settle done", async (stage, cause) => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => request.key.endsWith(`.task-${stage}`)
    ? cause === "Stop" ? { ...(stage === "reviewer" ? normal() : budget(request.key)),
      ok: false, stopped: true, structuredOutput: undefined }
      : { ok: false, key: request.key, error: "Blocked by pi-subagents permission rule: 'run' is denied." }
    : normal());
  const output = await host.execute();
  expect(output.status, output.reason).toBe("cancelled");
  expect(output.loopReport.halt.code).toBe("native-barrier");
  expect(host.current().action.key).toEndWith(`.task-${stage}`);
  noUnit(host);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
  const before = host.launches.length;
  if (stage === "reviewer" && cause === "Stop") {
    const ref = output.loopReport.halt.ref;
    expect(ref.agent).toBe("pitako.reviewer"); // Stable retained digest, not the launch name.
    expect(host.native.get(ref.runId)!.agent).toBe("pitako.task-review");
    host.setStatus(target => {
      const native = copy(host.native.get(target)!);
      return target === ref.runId ? { ...native, agent: "pitako.reviewer" } : native;
    });
  }
  const resumed = await host.execute();
  expect(resumed.status, resumed.reason).toBe("cancelled");
  expect(resumed.reason).toBe(output.reason);
  expect(resumed.loopReport.halt).toEqual(output.loopReport.halt);
  expect(host.launches).toHaveLength(before);
});

const stages = ["gate", "delta", "reviewer", "verdict", "sealer", "repair"] as const;
test.each(["reviewer", "synthesis"])("saved %s projection replays with body-free settled native status", async stage => {
  const host = fixture(); host.setLimit(1);
  const next = stage === "reviewer" ? ".task-synthesis" : ".seal";
  let denied = false;
  host.setLaunchRespond((request, normal) => {
    if (!denied && request.key.endsWith(next)) { denied = true; return budget(request.key); }
    return normal();
  });
  const first = await host.execute();
  expect(first.status, first.reason).toBe("budget-exhausted");
  const slot = host.current().review.slots.find((slot: { key: string }) => slot.key.endsWith(`.task-${stage}`));
  expect(slot).toMatchObject({ runId: host.native.get(slot.key)?.runId, phase: "reviewer" });
  expect(pinned(host).find(row => row.kind === "task-review-context")).toBeDefined();
  const reviewKeys = host.current().review.slots.filter((slot: { phase: string }) => slot.phase === "reviewer");
  host.setStatus(ref => {
    const result = copy(host.native.get(ref)!);
    if (result && reviewKeys.some((slot: { key: string; runId: string | null }) => slot.key === ref || slot.runId === ref)) {
      delete result.structuredOutput;
      result.state = "complete";
    }
    return result ?? { ok: false, state: "unknown" };
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  expect(host.records()).toContainEqual(expect.objectContaining({ kind: "unit" }));
  for (const child of ["reviewer", "synthesis"])
    expect(host.calls.filter(call => call.key.endsWith(`.task-${child}`))).toHaveLength(1);
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind))
    .toEqual(["unit"]);
});

test.each(["running", "Stop", "permission", "wrong-run"])("saved projection cannot override body-free native %s", async defect => {
  const host = fixture(); host.setLimit(1);
  host.setLaunchRespond((request, normal) => request.key.endsWith(".seal") ? budget(request.key) : normal());
  expect((await host.execute()).status).toBe("budget-exhausted");
  const reviewKeys = host.current().review.slots.filter((slot: { phase: string }) => slot.phase === "reviewer");
  host.setStatus(ref => {
    const result = copy(host.native.get(ref)!);
    if (!result || !reviewKeys.some((slot: { key: string; runId: string | null }) => slot.key === ref || slot.runId === ref))
      return result ?? { ok: false, state: "unknown" };
    delete result.structuredOutput;
    result.state = "complete";
    if (defect === "running") result.state = "running";
    else if (defect === "Stop") result.stopped = true;
    else if (defect === "permission") {
      result.ok = false; result.error = "Blocked by pi-subagents permission rule: 'run' is denied.";
    } else if (defect === "wrong-run") result.runId = "another-producer";
    return result;
  });
  const before = host.launches.filter(call => reviewChildren(call.key) || call.agent === "pitako.checkpoint-sealer").length;
  const output = await host.execute();
  expect(output.status, output.reason).toBe(defect === "wrong-run" ? "blocked" : "cancelled");
  expect(host.launches.filter(call => reviewChildren(call.key) || call.agent === "pitako.checkpoint-sealer")).toHaveLength(before);
  noUnit(host);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
});

test.each(stages)("%s budget relaunch preserves admitted children and seal kind", async stage => {
  const host = fixture(); host.setLimit(1);
  let denied = false;
  host.setRespond((request, normal) => {
    const result = normal();
    if (stage === "repair" && request.key === "invoke-human-1.l1.t1.a1.task-synthesis") reject(result);
    return result;
  });
  host.setLaunchRespond((request, normal) => {
    const selected = stage === "gate" ? request.key.endsWith(".a1.gate")
      : stage === "delta" ? request.key.endsWith(".delta")
      : stage === "reviewer" ? request.key.endsWith(".task-reviewer")
      : stage === "verdict" ? request.key.endsWith(".task-synthesis")
      : stage === "sealer" ? request.agent === "pitako.checkpoint-sealer"
      : request.key.endsWith(".t1.a2");
    if (!denied && selected) { denied = true; return budget(request.key); }
    return normal();
  });
  const first = await host.execute();
  expect(denied).toBe(true);
  expect(first.status, first.reason).toBe("budget-exhausted");
  const rejected: string[] = copy(host.current().budget.rejectedKeys);
  expect(rejected).toHaveLength(1);
  const admitted = host.launches.filter(call => !rejected.includes(canonicalDigest(call.key))).map(call => call.key);
  host.setStatus(ref => {
    if (rejected.includes(canonicalDigest(ref))) throw Error("No child was launched for this admission");
    return host.native.get(ref) ?? { ok: false, state: "unknown" };
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  expect(host.current().budget.consumedLoops).toBe(1);
  for (const key of admitted) expect(host.launches.filter(call => call.key === key)).toHaveLength(1);
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind))
    .toEqual(stage === "repair" ? ["pause", "unit"] : ["unit"]);
});

test.each(stages)("%s receipt-save cut replays without duplicate settled dispatch", async stage => {
  const host = fixture(); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (stage === "repair" && request.key === "invoke-human-1.l1.t1.a1.task-synthesis") reject(result);
    return result;
  });
  let cut = false;
  host.setFailSave(value => {
    const attempt = value.loop?.attempt;
    cut ||= stage === "gate" ? value.action.op === "gate" && pinned(host, value).some(row => row.opKey.endsWith(".a1.gate") && row.kind === "marker")
      : stage === "delta" ? pinned(host, value).some(row => row.kind === "task-review-context")
      : stage === "reviewer" ? value.review?.slots.some((slot: { key: string, runId: string | null }) => slot.key.endsWith(".task-reviewer") && slot.runId)
      : stage === "verdict" ? value.review?.slots.some((slot: { key: string, runId: string | null }) => slot.key.endsWith(".task-synthesis") && slot.runId)
      : stage === "sealer" ? value.inFlight.some((ref: { role: string }) => ref.role === "checkpoint-sealer")
      : attempt?.number === 2 && value.action.kind === "launched" && value.action.role === "worker";
    return cut;
  });
  const first = await host.execute();
  expect(first.status, first.reason).toBe("partial");
  expect(cut).toBe(true);
  const admitted = host.launches.map(call => call.key);
  host.setFailSave();
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
  expect(host.current().budget.consumedLoops).toBe(1);
  for (const key of admitted) expect(host.launches.filter(call => call.key === key).map(call => call.key)).toEqual([key]);
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind))
    .toEqual(stage === "repair" ? ["pause", "unit"] : ["unit"]);
});

test("successive budget rejections after review progress do not falsely stall", async () => {
  const host = fixture(); host.setLimit(1);
  const denied = new Set<string>();
  host.setLaunchRespond((request, normal) => {
    if ([".gate", ".delta", ".task-reviewer", ".task-synthesis", ".seal"].some(suffix => request.key.endsWith(suffix)) &&
        !denied.has(request.key)) {
      denied.add(request.key); return budget(request.key);
    }
    return normal();
  });
  for (let i = 0; i < 5; i++) {
    const output = await host.execute();
    expect(output.status, output.reason).toBe("budget-exhausted");
  }
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
});

test("a sealed rejection replays as pause and repairs with the frozen model overrides", async () => {
  const host = fixture(); host.setLimit(1);
  host.setHostResponse((key, value) => key === "inspect-initial" && value.admission
    ? { ...value, admission: { ...value.admission, taskReviewer: "custom/reviewer:low", taskSynthesis: "custom/synthesis" } } : value);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key === "invoke-human-1.l1.t1.a1.task-synthesis") reject(result);
    return result;
  });
  host.setFailSave(value => value.loop?.attempt?.number === 1 && value.loop.attempt.stage === "result");
  expect((await host.execute()).status).toBe("partial");
  host.setFailSave(); host.setHostResponse();
  const output = await host.execute();
  expect(output.status, output.reason).toBe("partial");
  expect(host.calls.filter(call => call.agent === "pitako.checkpoint-sealer").map(call => JSON.parse(call.task).kind))
    .toEqual(["pause", "unit"]);
  expect(host.launches.filter(call => reviewChildren(call.key)).map(call => call.model))
    .toEqual(["custom/reviewer:low", "custom/synthesis", "custom/reviewer:low", "custom/synthesis"]);
  expect(host.launches.filter(call => call.agent === "pitako.worker")).toHaveLength(2);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("done");
});

test("reviewer candidate mutation fails the saved gate candidate check", async () => {
  const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
  host.setRespond((request, normal) => {
    const result = normal();
    if (request.key.endsWith(".task-reviewer")) host.changeCheckout();
    return result;
  });
  const output = await host.execute();
  expect(output.status, output.reason).toBe("blocked");
  expect(output.reason).toContain("Sealer candidate differs from the saved gate receipt");
  expect(host.current().halt.stage).toBe("recovery");
  noUnit(host);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
  expect(host.launches.filter(call => call.key.endsWith(".gate"))).toHaveLength(1);
});

test("a settled sealer cannot admit a checkout changed before replay", async () => {
  const host = fixture(undefined, { realCheckout: true }); host.setLimit(1);
  host.setFailSave(value => value.inFlight.some((ref: { role: string }) => ref.role === "checkpoint-sealer"));
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  host.setFailSave(); host.changeCheckout();
  const count = host.launches.length;
  const output = await host.execute();
  expect(output.status, output.reason).toBe("blocked");
  expect(output.reason).toContain("checkout differs from its settled seal");
  expect(host.launches.slice(count).map(call => call.key)).toEqual(["invoke-human-1.l1.t1.a1.task-synthesis.review-recovery.r1"]);
  noUnit(host);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
});

test.each(["disk-digest", "native-digest", "missing"])("replayed review original fails closed: %s", async defect => {
  const host = fixture(); host.setLimit(1);
  host.setFailSave(settledSynthesis);
  expect((await host.execute()).reason).toContain("Essential persistence failed");
  const slot = host.current().review.slots.find((slot: { key: string }) => slot.key.endsWith(".task-reviewer"));
  const original = host.native.get(slot.runId)!;
  const path = original.results?.[0]?.savedOutputPath;
  if (!path) throw new Error("Reviewer original path unavailable");
  host.setFailSave();
  host.setStatus(ref => {
    const result = copy(host.native.get(ref) ?? { ok: false, state: "unknown" });
    if (pitakoAgentFamily(result.agent) === "reviewer") { delete result.structuredOutput; result.state = "complete"; }
    return result;
  });
  if (defect === "missing") rmSync(path);
  else if (defect === "disk-digest") {
    const body = JSON.parse(readFileSync(path, "utf8"));
    body.correctness.verdict = "Altered report";
    writeFileSync(path, JSON.stringify(body));
  } else host.setStatus(ref => {
    const result = copy(host.native.get(ref) ?? { ok: false, state: "unknown" });
    if (result.runId === original.runId) (result.structuredOutput as { correctness: { verdict: string } }).correctness.verdict = "Altered native body";
    return result;
  });
  const before = host.launches.filter(call => reviewChildren(call.key)).length;
  const output = await host.execute();
  expect(output.status, output.reason).toBe("blocked");
  expect(output.reason).toMatch(defect === "missing" ? /missing|ENOENT/i : /integrity|digest mismatch/i);
  expect(host.launches.filter(call => reviewChildren(call.key))).toHaveLength(before);
  noUnit(host);
  expect(readBacklog(host.root, "spec").backlog!.tasks[0]!.status).toBe("pending");
});
