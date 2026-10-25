import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChildSafeState } from "../node_modules/pi-subagents/src/extension/fanout-child.js";
import { createNativeSupervisorChannel, registerNativeSupervisorClient } from "../node_modules/pi-subagents/src/intercom/native-supervisor-channel.js";
import { runWorkflowScript } from "../node_modules/pi-subagents/src/workflows/scripted-workflow.js";
import { normalizeWorkflowArgs } from "../node_modules/pi-subagents/src/workflows/workflow-resources.js";

const source = readFileSync(new URL("../skills/architecture/workflow.js", import.meta.url), "utf8");
interface Request {
  key?: string;
  agent?: string;
  resume?: string;
  context?: string;
  async?: boolean;
  task: string;
  output: boolean;
  outputSchema: unknown;
}
interface Result { ok: boolean; runId?: string; structuredOutput?: unknown; error?: string }
interface Member { id: string; runId: string }
interface Continuation {
  version: number;
  brief: string;
  rounds: number;
  validRounds: number;
  maxRounds: number;
  directorRunId: string;
  members: Member[];
}
interface Outcome {
  status: "completed" | "blocked" | "failed";
  memo?: string;
  error?: string;
  rounds: number;
  validRounds: number;
  steering: { round: number; key: string; state: string }[];
  continuation: (Partial<Continuation> & { version: number; consultation?: string }) | null;
}
const perspectives = [
  { id: "simple", label: "Operational simplicity", focus: "Question complexity; compare complete designs." },
  { id: "recover", label: "Recoverability", focus: "Question recovery assumptions; compare complete designs." },
];
const discuss = { action: "discuss", perspectives, packet: "Shared decision and evidence", memo: "" };
const finish = { action: "finish", perspectives: [], packet: "", memo: "Choose the simpler design; recovery remains uncertain." };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function child(key: string, decision: unknown = finish): Result {
  return {
    ok: true, runId: `native-${key}`,
    structuredOutput: key.startsWith("director-")
      ? key === "director-prepare" ? discuss : decision
      : { status: "ready", report: `Private report from ${key}` },
  };
}
function fixture(
  respond: (key: string, request: Request) => Result | Promise<Result> = key => child(key),
  steer: (key: string) => { state: string } | Promise<{ state: string }> = () => ({ state: "missed" }),
) {
  const calls: { key: string; request: Request }[] = [];
  const batches: Request[][] = [];
  const steered: { key: string; message: string; options: unknown }[] = [];
  const seen = new Set<string>();
  function launch(key: string, request: Request): Promise<Result> {
    expect(seen.has(key)).toBe(false);
    seen.add(key);
    calls.push({ key, request });
    return Promise.resolve().then(() => respond(key, request)).catch(error => ({ ok: false, error: String(error) }));
  }
  const runs = {
    run(key: string, request: Request): Promise<Result> {
      return launch(key, request).then(result => {
        // Ordinary native terminal failures reject without carrying the result's identity.
        if (!result.ok) throw new Error(`Run '${key}' failed: ${result.error ?? "Child failed"}`);
        return result;
      });
    },
    all(requests: Request[]): Promise<Result[]> {
      batches.push(requests);
      return Promise.all(requests.map(request => launch(request.key!, request)));
    },
    steer(key: string, message: string, options: unknown) {
      steered.push({ key, message, options });
      return Promise.resolve().then(() => steer(key));
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...parameters: string[]
  ) => (args: unknown, runner: typeof runs, state?: unknown) => Promise<Outcome>;
  const execute = (args: unknown = { brief: "Choose a complete persistence design" }, storage?: Map<string, unknown>) =>
    new AsyncFunction("args", "runs", "state", source)(args, runs, storage && {
      get: async (key: string) => structuredClone(storage.get(key)),
      set: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)); },
    });
  return { execute, calls, batches, steered };
}

describe("architecture scripted workflow", () => {
  test("keeps an independent first round fresh and returns only the final memo and references", async () => {
    const host = fixture();
    const result = await host.execute();
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(1);
    expect(result.validRounds).toBe(1);
    expect(host.batches).toHaveLength(1);
    expect(host.batches[0]).toHaveLength(2);
    expect(host.steered).toHaveLength(0);
    for (const request of host.batches[0]!) {
      expect(request.context).toBe("fresh");
      expect(request.agent).toBe("pitako.architect");
      expect(request.task).toContain("Choose a complete persistence design");
    }
    for (const { request } of host.calls) {
      if (!request.resume) expect(request.agent).toBe("pitako.architect");
      expect(request.async).toBeUndefined();
      expect(request.output).toBe(false);
      expect(request.outputSchema).toBeDefined();
    }
    expect(JSON.stringify(result)).not.toContain("Private report");
    expect(result.memo).toBe(finish.memo);
    expect(result.continuation?.directorRunId).toBe("native-director-after-r1");
  });

  test("enforces a ten-round maximum and preserves the director's latest native reference", async () => {
    const host = fixture(key => child(key, key === "director-after-r10" ? finish : discuss));
    const result = await host.execute();
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(10);
    expect(result.validRounds).toBe(10);
    expect(host.calls.filter(call => /^r\d+-/.test(call.key))).toHaveLength(20);
    expect(result.continuation?.directorRunId).toBe("native-director-after-r10");
    expect(host.calls.find(call => call.key === "director-after-r10")?.request.resume)
      .toBe("native-director-after-r9");
    expect(host.calls.some(call => call.key.startsWith("r11-"))).toBe(false);
  });

  test("refuses an extra requested round instead of reporting a false synthesis", async () => {
    const host = fixture(key => child(key, discuss));
    const result = await host.execute({ brief: "Decision", maxRounds: 1 });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("beyond the limit");
    expect(result.rounds).toBe(1);
    expect(host.calls.filter(call => /^r\d+-/.test(call.key))).toHaveLength(2);
    expect(result.memo).toBeUndefined();
  });

  test.each(["delivered", "missed", "failed"])(
    "rolls later reports into stable-key steering and records %s without a retry",
    async state => {
      const late = deferred<Result>();
      const host = fixture(
        key => key === "r2-recover" ? late.promise
          : child(key, key === "director-after-r1" ? discuss : finish),
        key => {
          late.resolve(child(key));
          expect(key).toBe("r2-recover");
          return { state };
        },
      );
      const result = await host.execute();
      expect(result.status).toBe("completed");
      expect(result.rounds).toBe(2);
      expect(host.batches[0]).toHaveLength(2);
      expect(host.steered).toHaveLength(1);
      expect(host.steered[0]?.message).toContain("Private report from r2-simple");
      expect(result.steering).toEqual([{ round: 2, key: "r2-recover", state }]);
      const resumed = host.calls.find(call => call.key === "r2-recover")!.request;
      expect(resumed.resume).toBe("native-r1-recover");
      expect(resumed.agent).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("Private report");
    },
  );

  test("does not finish or replace a failed member before its sibling settles", async () => {
    const waiting = deferred<Result>();
    const entered = deferred<void>();
    const host = fixture(key => {
      if (key === "r1-simple") throw new Error("Controlled child failure");
      if (key === "r1-recover") { entered.resolve(); return waiting.promise; }
      return child(key);
    });
    let finished = false;
    const execution = host.execute().then(result => { finished = true; return result; });
    await entered.promise;
    let result: Outcome;
    try {
      expect(finished).toBe(false);
      expect(host.calls.map(call => call.key)).toEqual(["director-prepare", "r1-simple", "r1-recover"]);
    } finally {
      waiting.resolve(child("r1-recover"));
      result = await execution;
    }
    expect(result.status).toBe("failed");
    expect(result.error).toContain("simple");
    expect(result.validRounds).toBe(0);
    expect(host.calls).toHaveLength(3);
    expect(result.continuation?.members).toHaveLength(1);
  });

  test("settles rolling siblings after a rejected child, without launching a replacement", async () => {
    const waiting = deferred<Result>();
    const entered = deferred<void>();
    const host = fixture(key => {
      if (key === "r2-simple") throw new Error("Controlled rolling failure");
      if (key === "r2-recover") { entered.resolve(); return waiting.promise; }
      return child(key, key === "director-after-r1" ? discuss : finish);
    });
    let finished = false;
    const execution = host.execute().then(result => { finished = true; return result; });
    await entered.promise;
    let result: Outcome;
    try { expect(finished).toBe(false); }
    finally { waiting.resolve(child("r2-recover")); result = await execution; }
    expect(result.status).toBe("failed");
    expect(result.rounds).toBe(2);
    expect(result.validRounds).toBe(1);
    expect(host.steered).toHaveLength(0);
    expect(host.calls.some(call => call.key === "director-after-r2")).toBe(false);
  });

  test("continues the same decision with native resumes and the consumed round count", async () => {
    const first = await fixture().execute();
    const host = fixture();
    const result = await host.execute({ brief: "New recovery evidence", continuation: first.continuation });
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(2);
    expect(result.validRounds).toBe(2);
    expect(host.calls[0]?.request.resume).toBe("native-director-after-r1");
    for (const { request } of host.calls) expect(request.agent).toBeUndefined();
    const member = host.calls.find(call => call.key === "r2-simple")!.request;
    expect(member.task).toContain("Choose a complete persistence design");
    expect(member.task).toContain("New recovery evidence");
    expect(member.resume).toBe("native-r1-simple");
    expect(result.continuation?.members?.[0]?.runId).toBe("native-r2-simple");
  });

  test("cannot complete a resumed consultation whose initial comparison failed", async () => {
    const failed = await fixture(key => key === "r1-simple"
      ? { ...child(key), structuredOutput: { status: "blocked", report: "Missing evidence" } }
      : child(key)).execute();
    expect(failed.status).toBe("failed");
    expect(failed.rounds).toBe(1);
    const resumed = fixture(key => ({ ...child(key), structuredOutput: finish }));
    const result = await resumed.execute({ brief: "Continue", continuation: failed.continuation });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("valid multi-perspective round");
    expect(result.rounds).toBe(1);
    expect(result.validRounds).toBe(0);
    expect(resumed.calls).toHaveLength(1);
  });

  test("can recover with a valid comparison without resetting the consumed budget", async () => {
    const failed = await fixture(key => key === "r1-simple"
      ? { ...child(key), structuredOutput: { status: "blocked", report: "Missing evidence" } }
      : child(key)).execute();
    const recovered = await fixture().execute({ brief: "Evidence supplied", continuation: failed.continuation });
    expect(recovered.status).toBe("completed");
    expect(recovered.rounds).toBe(2);
    expect(recovered.validRounds).toBe(1);
    expect(recovered.continuation?.validRounds).toBe(1);
  });

  test("retains a prior valid comparison when a later round fails", async () => {
    const first = await fixture().execute();
    const failed = await fixture(key => key === "r2-simple"
      ? { ...child(key), structuredOutput: { status: "blocked", report: "Missing new evidence" } }
      : child(key)).execute({ brief: "New question", continuation: first.continuation });
    expect(failed.status).toBe("failed");
    expect(failed.rounds).toBe(2);
    expect(failed.validRounds).toBe(1);
    const stopped = await fixture(key => ({ ...child(key), structuredOutput: finish }))
      .execute({ brief: "Synthesize existing evidence", continuation: failed.continuation });
    expect(stopped.status).toBe("completed");
    expect(stopped.rounds).toBe(2);
    expect(stopped.validRounds).toBe(1);
  });

  test("a trivial reentry cannot reset a continuation's consumed rounds", async () => {
    const first = await fixture().execute({ brief: "Old decision", maxRounds: 1 });
    const host = fixture();
    await expect(host.execute({ brief: "Old decision", continuation: first.continuation, newDecision: true })).rejects.toThrow("cannot reset");
    const capped = await host.execute({ brief: "Continue", continuation: first.continuation });
    expect(capped.status).toBe("failed"); expect(capped.error).toContain("beyond the limit");
    expect(host.calls).toHaveLength(1);
  });

  test("preserves ordinary explicit-new-decision director reuse without retaining old members or count", async () => {
    const first = await fixture().execute({ brief: "Old decision", maxRounds: 1 });
    const host = fixture();
    const result = await host.execute({ brief: "New complete decision", continuation: first.continuation, newDecision: true });
    expect(result.status).toBe("completed"); expect(result.rounds).toBe(1); expect(result.validRounds).toBe(1);
    expect(result.continuation?.maxRounds).toBe(10);
    expect(host.calls[0]?.request.resume).toBe("native-director-after-r1");
    expect(host.batches[0]?.every(request => request.context === "fresh")).toBe(true);
    expect(result.continuation?.brief).toBe("New complete decision");
  });

  test("reports an explicit director blocker without a fanout", async () => {
    const host = fixture(key => ({
      ...child(key), structuredOutput: { ...finish, action: "blocked", memo: "Choose the required recovery objective." },
    }));
    const result = await host.execute();
    expect(result.status).toBe("blocked");
    expect(result.memo).toContain("recovery objective");
    expect(host.calls).toHaveLength(1);
  });

  test("does not equate process success with a usable structured decision", async () => {
    const host = fixture(key => ({ ok: true, runId: `native-${key}` }));
    const result = await host.execute();
    expect(result.status).toBe("failed");
    expect(host.calls).toHaveLength(1);
    expect(result.continuation?.directorRunId).toBe("native-director-prepare");
  });

  test("does not silently replace a director whose native resume fails", async () => {
    const first = await fixture().execute();
    const host = fixture(() => { throw new Error("Native retained session unavailable"); });
    const result = await host.execute({ brief: "More evidence", continuation: first.continuation });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("session unavailable");
    expect(host.calls).toHaveLength(1);
    expect(result.continuation?.directorRunId).toBe(first.continuation?.directorRunId);
  });

  test.each([
    { brief: "" }, { brief: "Decision", maxRounds: 11 },
    { brief: "Decision", maxRounds: 1.5 }, { brief: "Decision", newDecision: "yes" },
    { brief: "Decision", continuation: null }, { brief: "Decision", continuation: { version: 99 } },
  ])("rejects invalid input before dispatch: %j", async args => {
    const host = fixture();
    await expect(host.execute(args)).rejects.toThrow();
    expect(host.calls).toHaveLength(0);
  });
});

describe("planning architecture evidence and doubts", () => {
  test.each([2, 10])("retains the entire mixed inadequate round before validation at round %i", async round => {
    const storage = new Map<string, unknown>();
    const objection = "New contrary evidence: recovery loses the assignment";
    const blocker = "Unanswered blocker: cannot validate ownership";
    const blockedSettled = deferred<void>();
    const pointers = { artifactPaths: ["/native/contrary.json"], outputReference: "/native/contrary.md", asyncDir: "/native/contrary" };
    const host = fixture(async key => {
      if (key === `r${round}-simple`) {
        blockedSettled.resolve();
        return { ok: false, runId: `native-${key}`, ...pointers, error: "Native failure with blocked report", structuredOutput: { status: "blocked", report: blocker } };
      }
      if (key === `r${round}-recover`) {
        await blockedSettled.promise;
        return { ok: true, runId: `native-${key}`, ...pointers, structuredOutput: { status: "ready", report: objection } };
      }
      if (key.startsWith("director-doubts-")) return { ok: true, runId: `native-${key}`, structuredOutput: { doubts: [] } };
      return child(key, discuss);
    });
    const failed = await host.execute({ brief: "Decision", planning: true, consultation: "mixed", maxRounds: 10 }, storage);
    expect(failed).toMatchObject({ status: "failed", rounds: round, validRounds: round - 1, error: "No adequate report from simple. No replacement or retry was launched." });
    expect(host.steered.filter(item => item.message.includes(`round ${round},`))).toHaveLength(0);
    expect(host.calls.some(item => item.key === `director-doubts-r${round}`)).toBe(false);
    expect(structuredClone(storage.get("architecture-mixed"))).toMatchObject({ rounds: round, validRounds: round - 1,
      evidence: expect.arrayContaining([expect.objectContaining({ round, reports: [
        expect.objectContaining({ id: "simple", ok: false, status: "blocked", report: blocker, error: "Native failure with blocked report", runId: `native-r${round}-simple`, ...pointers }),
        expect.objectContaining({ id: "recover", report: objection, runId: `native-r${round}-recover`, ...pointers }),
      ] })]) });
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-prepare"); expect(request.resume).toBe(`native-director-after-r${round - 1}`);
      for (const evidence of [objection, blocker, "Native failure with blocked report", ...Object.values(pointers).flat()]) expect(request.task).toContain(evidence);
      expect(request.task).toContain(`Consumed rounds: ${round}/10`);
      expect(request.task).toContain(`native-r${round}-simple`); expect(request.task).toContain(`native-r${round}-recover`);
      expect(request.task.includes("finish or blocked only")).toBe(round === 10);
      return { ok: true, runId: "native-reconciled", structuredOutput: { ...finish, action: "blocked", memo: blocker } };
    });
    expect(await resumed.execute({ brief: "Reconcile mixed failed round", planning: true, consultation: "mixed" }, storage))
      .toMatchObject({ status: "blocked", rounds: round, validRounds: round - 1 });
    expect(resumed.calls).toHaveLength(1);
    expect(storage.get("architecture-mixed")).toMatchObject({ members: perspectives.map(member => ({ ...member, runId: `native-r${round}-${member.id}` })) });
  });
  test.each([2, 10])("persists settled objections before doubts delivery fails and supplies them to same-consultation synthesis at round %i", async (limit) => {
    const storage = new Map<string, unknown>();
    const objection = "Material objection: proposed recovery loses the assignment";
    const host = fixture((key, request) => {
      if (key === `director-doubts-r${limit}`) {
        // Fail before delivery to the retained director, not after it saw the reports.
        expect(storage.get("architecture-failure")).toMatchObject({ rounds: limit, validRounds: limit,
          evidence: expect.arrayContaining([expect.objectContaining({ round: limit, reports: expect.arrayContaining([
            expect.objectContaining({ report: objection, runId: `native-r${limit}-recover` }),
          ]) })]) });
        throw new Error("Controlled dispatch failure before delivery");
      }
      if (key.startsWith("director-doubts-")) return { ok: true, runId: `native-${key}`, structuredOutput: { doubts: [] } };
      if (key === `r${limit}-recover`) return { ok: true, runId: `native-${key}`, structuredOutput: { status: "ready", report: objection } };
      return child(key, discuss);
    });
    const failed = await host.execute({ brief: "Decision", planning: true, consultation: "failure", maxRounds: limit }, storage);
    expect(failed).toMatchObject({ status: "failed", rounds: limit, validRounds: limit, error: expect.stringContaining("Controlled dispatch failure before delivery") });
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-prepare");
      expect(request.resume).toBe(`native-director-after-r${limit - 1}`);
      expect(request.task).toContain(objection);
      expect(request.task).toContain(`native-r${limit}-recover`);
      expect(request.task).toContain("finish or blocked only");
      return { ok: true, runId: "native-synthesis", structuredOutput: finish };
    });
    const result = await resumed.execute({ brief: "Reconcile the failed doubts delivery", planning: true, consultation: "failure" }, storage);
    expect(result).toMatchObject({ status: "completed", rounds: limit, validRounds: limit });
    expect(resumed.calls).toHaveLength(1);
    expect(storage.get("architecture-failure")).toMatchObject({ members: expect.arrayContaining([
      expect.objectContaining({ id: "recover", runId: `native-r${limit}-recover` }),
    ]) });
  });

  test("resolves actual doubts between rounds and delivers contrary evidence to the complete discussion", async () => {
    const storage = new Map<string, unknown>();
    const host = fixture((key, request) => {
      if (key.startsWith("director-doubts-")) return { ok: true, runId: `native-${key}`, structuredOutput: { doubts: key.endsWith("r1") ? [
        { id: "local", dependsOn: [], kind: "scout", question: "Where is ownership?", decision: "Reuse or replace existing seam" },
        { id: "external", dependsOn: [], kind: "researcher", question: "Does v0.82 support this?", decision: "Choose native boundary" },
        { id: "conflict", dependsOn: [], kind: "evidence-auditor", question: "Conflicting recovery claim", decision: "Fail safely" },
      ] : [] } };
      if (key.startsWith("doubts-")) return { ok: true, runId: `native-${key}`, structuredOutput: { status: "ready", report: "Contrary primary v0.82 evidence; limitation remains" } };
      if (key.startsWith("r2-")) expect(request.task).toContain("Contrary primary v0.82 evidence");
      return child(key, key === "director-after-r1" ? discuss : finish);
    });
    const result = await host.execute({ brief: "Complete decision with initial evidence", planning: true, consultation: "same", maxRounds: 10 }, storage);
    expect(result.status).toBe("completed"); expect(result.rounds).toBe(2);
    const keys = host.calls.map(call => call.key);
    expect(keys.indexOf("director-doubts-r1")).toBeGreaterThan(keys.indexOf("r1-recover"));
    expect(keys.indexOf("director-after-r1")).toBeGreaterThan(keys.indexOf("doubts-r1-2"));
    expect(host.calls.filter(call => call.key.startsWith("doubts-")).map(call => call.request.agent))
      .toEqual(["pitako.scout", "pitako.researcher", "pitako.evidence-auditor"]);
    expect(storage.get("architecture-same")).toMatchObject({ rounds: 2, maxRounds: 10 });
  });

  test("human doubts return to foreground without asking a child to approve, then continue the same retained counter", async () => {
    const storage = new Map<string, unknown>();
    const first = fixture(key => key.startsWith("director-doubts-") ? { ok: true, runId: `native-${key}`, structuredOutput: { doubts: [
      { id: "scope", dependsOn: [], kind: "human", question: "Prefer scope A?", decision: "Scope boundary" },
    ] } } : key.startsWith("human-") ? { ok: true, runId: key, structuredOutput: { status: "blocked", report: "Prefer scope A? Awaiting actual human answer." } } : child(key));
    const blocked = await first.execute({ brief: "Decision", planning: true, consultation: "same", maxRounds: 2 }, storage);
    expect(blocked.status).toBe("blocked"); expect(blocked.memo).toContain("unanswered"); expect(blocked.rounds).toBe(1);
    expect(first.calls.find(call => call.key.startsWith("human-"))?.request.task).toContain("Prefer scope A?");
    expect(first.calls.some(call => call.key.startsWith("doubts-"))).toBe(false);
    const resumed = fixture(key => key.startsWith("director-doubts-") ? { ok: true, runId: key, structuredOutput: { doubts: [] } } : child(key));
    const done = await resumed.execute({ brief: "Actual human answered A", planning: true, consultation: "same", maxRounds: 10 }, storage);
    expect(done.rounds).toBe(2); expect(storage.get("architecture-same")).toMatchObject({ maxRounds: 2 });
    const capped = await fixture().execute({ brief: "Trivial reentry without a continuation", planning: true, consultation: "same" }, storage);
    expect(capped.status).toBe("failed"); expect(capped.rounds).toBe(2);
  });

  test("planning cannot use an ephemeral consultation or reset native retained rounds through a supplied continuation", async () => {
    const host = fixture();
    await expect(host.execute({ brief: "Decision", planning: true, consultation: "same" })).rejects.toThrow("explicit native mission");
    const finished = await fixture().execute({ brief: "Decision", maxRounds: 1 });
    const storage = new Map<string, unknown>([["architecture-same", finished.continuation]]);
    const capped = await host.execute({ brief: "Reentry", planning: true, consultation: "same", continuation: { ...finished.continuation, rounds: 0 } }, storage);
    expect(capped.status).toBe("failed"); expect(capped.rounds).toBe(1);
    await expect(host.execute({ brief: "Changed label", planning: true, consultation: "same", newDecision: true }, storage)).rejects.toThrow("cannot reset");
    expect(host.calls).toHaveLength(1);
  });
});

// Controlled model boundary: drive the packaged relay's sole tool through a private
// native supervisor channel. No model/provider, detached runner, or host UI is used.
function supervisorRelay() {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-architecture-interview-"));
  type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text?: string }[] }> };
  const tools = new Map<string, Tool>();
  const notices: { details: { requestId: string; requestBody: string } }[] = [];
  const first = deferred<void>(), second = deferred<void>();
  const api = { registerTool: (tool: Tool) => { tools.set(tool.name, tool); },
    getAllTools: () => [...tools.values()], on: () => {}, events: { on: () => () => {}, emit: () => {} } } as unknown as ExtensionAPI;
  const state = createChildSafeState(); state.supervisorOwnerSessionId = "owned-planning-parent";
  const channel = createNativeSupervisorChannel(api, state, { getChannelDirs: () => ({ dirs: [root] }),
    parentWake: { sendMessage: message => {
      notices.push(message as unknown as typeof notices[number]);
      (notices.length === 1 ? first : second).resolve();
      return true;
    } } });
  channel.start();
  return { notices, first: first.promise, second: second.promise,
    launch(key: string, request: Request): Promise<Result> {
      const questions = JSON.parse(request.task.match(/FRONTIER \(data\): (.+)\n/)![1]!);
      let contact!: Tool;
      registerNativeSupervisorClient({ registerTool: (tool: Tool) => { contact = tool; }, getAllTools: () => [] } as unknown as ExtensionAPI,
        { channelDir: root, runId: key, agent: "pitako.interview-relay", childIndex: 0, orchestratorSessionId: "owned-planning-parent" });
      const reply = contact.execute(key, {
        reason: "interview_request", message: JSON.stringify(questions), interview: { title: "Planning decisions", questions },
      });
      channel.activateTransport();
      return reply.then(value => ({ ok: true, runId: `native-${key}`, structuredOutput: {
        status: "ready", report: value.content.map(item => item.text ?? "").join("\n"),
      } }));
    },
    reply: (requestId: string) => tools.get("subagent_supervisor")!.execute("human-reply", {
      action: "reply", replyTo: requestId, message: "Actual human answered: yes to the recommended scope.",
    }),
    dispose: () => { channel.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
}

describe("architecture foreground human frontier", () => {
  test.each(["unrelated-provider", "prerequisite-provider", "human", "dispatch"])("retains available native %s failure evidence and settles every frontier child", async failure => {
    const storage = new Map<string, unknown>(), started = new Set<string>();
    const entered = deferred<void>(), human = deferred<void>(), research = deferred<void>(), researchSettled = deferred<void>();
    const failedKey = failure === "human" ? "human-r1-1" : failure === "prerequisite-provider" ? "doubts-r1-0" : "doubts-r1-1";
    const pointers = { runId: `native-${failedKey}`, artifactPaths: ["/native/failed/report.json"],
      outputReference: "/native/failed/report.md", asyncDir: "/native/failed" };
    const failedReport = "Contrary evidence survives the infrastructure failure";
    const infrastructureError = "Controlled child infrastructure failure";
    let finished = false;
    const work = runWorkflowScript({
      script: source, args: { brief: "Complete decision", planning: true, consultation: "native-failure", maxRounds: 1 },
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async key => {
        if (key.startsWith("director-doubts-")) return { key, ok: true, runId: key, output: "", artifactPaths: [], structuredOutput: { doubts: [
          { id: "needed", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
          { id: "external", kind: "researcher", dependsOn: [], question: "External contract?", decision: "Adapter" },
          { id: "other", kind: "researcher", dependsOn: [], question: "Other evidence?", decision: "Other" },
          { id: "scope", kind: "human", dependsOn: [], question: "Prefer scope A (recommended)?", decision: "Scope" },
          { id: "dependent", kind: "human", dependsOn: ["needed"], question: "Reuse seam (recommended)?", decision: "Reuse" },
        ] } };
        if (key.startsWith("human-") || key.startsWith("doubts-")) {
          started.add(key);
          if (["human-r1-0", "doubts-r1-2", failedKey, ...(failure === "prerequisite-provider" ? [] : ["human-r1-1"])].every(key => started.has(key))) entered.resolve();
          if (key === failedKey) {
            if (failure === "dispatch") throw new Error(infrastructureError); // No child identity exists.
            return { key, ok: false, ...pointers, output: "Native failure output", error: infrastructureError,
              structuredOutput: { status: "blocked", report: failedReport } };
          }
          if (key.startsWith("human-")) await human.promise;
          if (key === "doubts-r1-2") { await research.promise; researchSettled.resolve(); }
        }
        return { key, ...child(key), output: "", artifactPaths: [] };
      },
      status: async () => { throw new Error("Unexpected status fallback"); },
    }).then(result => { finished = true; return result; });
    try {
      await Promise.race([entered.promise, work.then(() => { throw new Error("Workflow ended before sibling dispatch"); })]);
      expect(finished).toBe(false);
      research.resolve();
      await researchSettled.promise;
      expect(finished).toBe(false); // Independent (and, when unblocked, dependent) human answers remain pending.
    } finally {
      research.resolve(); human.resolve(); await work;
    }
    expect((await work).value).toMatchObject({ status: failure === "human" ? "blocked" : "failed", rounds: 1, validRounds: 1 });
    const retained = structuredClone(storage.get("architecture-native-failure")) as { evidence: { key?: string }[] };
    expect(retained).toMatchObject({ rounds: 1, validRounds: 1, maxRounds: 1 });
    const failed = retained.evidence.find(item => item.key === failedKey);
    expect(failed).toMatchObject({ key: failedKey, ok: false, error: infrastructureError,
      ...(failure === "dispatch" ? { status: "failed", report: "", artifactPaths: [] } : { ...pointers, status: "blocked", report: failedReport }) });
    if (failure === "dispatch") {
      for (const field of ["runId", "outputReference", "asyncDir"]) expect(failed).not.toHaveProperty(field);
    }
    if (failure === "prerequisite-provider") {
      expect(started.has("human-r1-1")).toBe(false);
      expect(structuredClone(storage.get("architecture-native-failure"))).toMatchObject({ evidence: expect.arrayContaining([
        expect.objectContaining({ key: "human-r1-1", withheld: expect.arrayContaining([expect.objectContaining({ id: "dependent" })]) }),
      ]) });
    }
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-prepare"); expect(request.resume).toBe("director-doubts-r1");
      for (const value of failure === "dispatch" ? [infrastructureError] : [failedReport, infrastructureError, pointers.runId, pointers.outputReference, pointers.asyncDir, ...pointers.artifactPaths]) expect(request.task).toContain(value);
      expect(request.task).toContain("Consumed rounds: 1/1"); expect(request.task).toContain("finish or blocked only");
      return { ...child(key), structuredOutput: finish };
    });
    expect(await resumed.execute({ brief: "Actual human answered; reconcile failure", planning: true, consultation: "native-failure" }, storage))
      .toMatchObject({ status: "completed", rounds: 1, validRounds: 1 });
    expect(resumed.calls).toHaveLength(1);
  });

  test("an overlapping smaller frontier is relayed before a larger prerequisite batch, without awaiting its human answer", async () => {
    const first = deferred<void>(), entered = deferred<void>(), next = deferred<string>(), later = deferred<void>();
    const human = deferred<void>(), facts = deferred<void>();
    const started: string[] = [], storage = new Map<string, unknown>();
    let firstSettled = false;
    const work = runWorkflowScript({
      script: source, args: { brief: "Decision", planning: true, consultation: "overlap" }, globalConcurrencyLimit: 2,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async (key, request) => {
        let result: Result;
        if (key.startsWith("director-doubts-")) result = { ok: true, runId: key, structuredOutput: { doubts: [
          ...["a", "b", "c", "unrelated"].map(id => ({ id, kind: "scout", dependsOn: [], question: `Fact ${id}?`, decision: "Design" })),
          { id: "large", kind: "human", dependsOn: ["a", "b", "c"], question: "Use all facts (recommended)?", decision: "Design" },
          { id: "small", kind: "human", dependsOn: ["a"], question: "Accept A (recommended)?", decision: "Design" },
        ] } };
        else {
          if (key.startsWith("doubts-") || key.startsWith("human-")) {
            started.push(key);
            if (key === "doubts-r1-0") { entered.resolve(); await first.promise; }
            else {
              if (firstSettled) next.resolve(key);
              if (key.startsWith("human-")) {
                expect(request.task).toContain("Private report from doubts-r1-0");
                await human.promise;
              } else {
                later.resolve(); await facts.promise;
              }
            }
          }
          result = child(key);
        }
        return { key, ...result, output: "", artifactPaths: [] };
      },
      status: async () => { throw new Error("Unexpected status fallback"); },
    });
    try {
      await entered.promise; firstSettled = true; first.resolve();
      expect(await Promise.race([next.promise, work.then(() => "ended")])).toBe("human-r1-1");
      await Promise.race([later.promise, work.then(() => { throw new Error("Research waited for the human answer"); })]);
    } finally {
      first.resolve(); human.resolve(); facts.resolve(); await work;
    }
    expect((await work).value).toMatchObject({ status: "completed" });
    expect(started.indexOf("human-r1-1")).toBeLessThan(started.indexOf("doubts-r1-1"));
    expect(started.indexOf("human-r1-0")).toBeLessThan(started.indexOf("doubts-r1-3"));
    expect(started.filter(key => key === "doubts-r1-0")).toHaveLength(1);
  });

  test.each([1, 2])("newly answerable frontiers precede unrelated FIFO research with %s prerequisite groups", async groupCount => {
    const scout = deferred<void>(), entered = deferred<void>(), next = deferred<string>();
    const human = deferred<void>(), research = deferred<void>(), researchBoth = deferred<void>();
    const started: string[] = [], storage = new Map<string, unknown>();
    const work = runWorkflowScript({
      script: source, args: { brief: "Decision", planning: true, consultation: "dependent-capacity" },
      globalConcurrencyLimit: 2,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async (key, request) => {
        let result: Result;
        if (key.startsWith("director-doubts-")) result = { ok: true, runId: key, structuredOutput: { doubts: [
          { id: "needed", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
          { id: "a", kind: "researcher", dependsOn: [], question: "Unrelated A?", decision: "Other" },
          { id: "b", kind: "researcher", dependsOn: [], question: "Unrelated B?", decision: "Other" },
          { id: "scope", kind: "human", dependsOn: ["needed"], question: "Reuse seam (recommended)?", decision: "Reuse" },
          ...(groupCount === 2 ? [
            { id: "later", kind: "scout", dependsOn: [], question: "Other prerequisite?", decision: "Adapter" },
            { id: "adapter", kind: "human", dependsOn: ["needed", "later"], question: "Use adapter (recommended)?", decision: "Adapter" },
          ] : []),
        ] } };
        else {
          if (key.startsWith("doubts-") || key.startsWith("human-")) {
            started.push(key);
            if (key === "doubts-r1-0") { entered.resolve(); await scout.promise; }
            else {
              if (started.includes("doubts-r1-0") && key !== "doubts-r1-1") next.resolve(key);
              if (key === "doubts-r1-3") expect(started).toContain("human-r1-0");
              if (key.startsWith("human-")) {
                expect(request.task).toContain("SETTLED PREREQUISITE FACTS");
                await human.promise;
              } else if (key !== "doubts-r1-3") {
                if (started.includes("doubts-r1-1") && started.includes("doubts-r1-2")) researchBoth.resolve();
                await research.promise;
              }
            }
          }
          result = child(key);
        }
        return { key, ...result, output: "", artifactPaths: [] };
      },
      status: async () => { throw new Error("Unexpected status fallback"); },
    });
    try {
      await entered.promise;
      expect(started).not.toContain("human-r1-0");
      scout.resolve();
      expect(await Promise.race([next.promise, work.then(() => "ended")])).toBe("human-r1-0");
      human.resolve();
      await Promise.race([researchBoth.promise, work.then(() => { throw new Error("Independent research never overlapped"); })]);
    } finally {
      scout.resolve(); human.resolve(); research.resolve(); await work;
    }
    expect((await work).value).toMatchObject({ status: "completed" });
    expect(started.filter(key => key === "doubts-r1-0")).toHaveLength(1);
    expect(started.indexOf("human-r1-0")).toBeLessThan(started.indexOf("doubts-r1-2"));
    if (groupCount === 2) expect(started.indexOf("human-r1-1")).toBeLessThan(started.indexOf("doubts-r1-1"));
  });

  test.each([false, true])("delivers a real native interview before unrelated research settles (research fails=%s)", async fails => {
    const relay = supervisorRelay(), research = deferred<Result>();
    const host = fixture((key, request) => {
      if (key.startsWith("director-doubts-")) return { ok: true, runId: key, structuredOutput: { doubts: [
        { id: "facts", kind: "researcher", dependsOn: [], question: "Which external API exists?", decision: "Adapter" },
        { id: "scope", kind: "human", dependsOn: [], question: "Prefer scope A (recommended)?", decision: "Scope" },
        { id: "dependent", kind: "human", dependsOn: ["facts"], question: "Use the supported adapter (recommended)?", decision: "Adapter" },
      ] } };
      if (key.startsWith("doubts-")) return research.promise;
      if (key.startsWith("human-")) return relay.launch(key, request);
      return child(key);
    });
    const storage = new Map<string, unknown>();
    let finished = false;
    const work = host.execute({ brief: "Complete decision", planning: true, consultation: "frontier" }, storage).then(value => { finished = true; return value; });
    let result!: Outcome;
    try {
      await Promise.race([relay.first, work.then(() => { throw new Error("Workflow ended before the foreground interview"); })]);
      expect(finished).toBe(false);
      expect(relay.notices[0]!.details.requestBody).toContain('"scope"');
      expect(relay.notices[0]!.details.requestBody).not.toContain('"dependent"');
      expect(host.calls.filter(call => call.key.startsWith("human-"))).toHaveLength(1);
      await relay.reply(relay.notices[0]!.details.requestId);
      research.resolve(fails ? { ok: false, runId: "failed-research" } : child("facts"));
      if (!fails) { await relay.second; await relay.reply(relay.notices[1]!.details.requestId); }
      result = await work;
      expect(result.status).toBe(fails ? "failed" : "completed");
      expect(relay.notices).toHaveLength(fails ? 1 : 2);
      expect(JSON.stringify(storage.get("architecture-frontier"))).toContain("native-human-r1-0");
      if (fails) expect(JSON.stringify(storage.get("architecture-frontier"))).toContain("failed-research");
    } finally {
      research.resolve({ ok: false, runId: "cleanup-research" });
      for (const notice of relay.notices) { try { await relay.reply(notice.details.requestId); } catch {} }
      await work;
      relay.dispose();
    }
  });

  test("submits the ready human frontier before factual work occupies two launch slots", async () => {
    const release = deferred<void>(), occupied = deferred<void>();
    const started: string[] = [], storage = new Map<string, unknown>();
    const work = runWorkflowScript({
      script: source, args: { brief: "Decision", planning: true, consultation: "launch-priority" },
      globalConcurrencyLimit: 2,
      state: { get: key => storage.get(key), set: (key, value) => { storage.set(key, structuredClone(value)); } },
      launch: async key => {
        let result: Result;
        if (key.startsWith("director-doubts-")) result = { ok: true, runId: key, structuredOutput: { doubts: [
          { id: "first", kind: "scout", dependsOn: [], question: "First local fact?", decision: "Reuse" },
          { id: "second", kind: "researcher", dependsOn: [], question: "Second external fact?", decision: "Adapter" },
          { id: "scope", kind: "human", dependsOn: [], question: "Prefer scope A (recommended)?", decision: "Scope" },
        ] } };
        else {
          if (key.startsWith("human-") || key.startsWith("doubts-")) {
            started.push(key);
            if (started.length === 2) occupied.resolve();
            await release.promise;
          }
          result = child(key);
        }
        return { key, ...result, output: "", artifactPaths: [] };
      },
      status: async () => { throw new Error("Unexpected status fallback"); },
    });
    try {
      await Promise.race([occupied.promise, work.then(() => { throw new Error("Workflow ended before the launch slots were occupied"); })]);
      expect(started.slice(0, 2)).toContain("human-r1-0");
    } finally {
      release.resolve();
      await work;
    }
  });

  test("a dependent frontier waits only for its named facts, not unrelated providers", async () => {
    const relay = supervisorRelay(), prerequisite = deferred<Result>(), unrelated = deferred<Result>();
    const host = fixture((key, request) => {
      if (key.startsWith("director-doubts-")) return { ok: true, runId: key, structuredOutput: { doubts: [
        { id: "needed", kind: "scout", dependsOn: [], question: "Local seam?", decision: "Reuse" },
        { id: "other", kind: "researcher", dependsOn: [], question: "Unrelated external fact?", decision: "Other" },
        { id: "scope", kind: "human", dependsOn: ["needed"], question: "Reuse seam (recommended)?", decision: "Reuse" },
      ] } };
      if (key === "doubts-r1-0") { prerequisite.resolve(child("needed")); return prerequisite.promise; }
      if (key === "doubts-r1-1") return unrelated.promise;
      if (key.startsWith("human-")) return relay.launch(key, request);
      return child(key);
    });
    let finished = false;
    const work = host.execute({ brief: "Decision", planning: true, consultation: "dependent" }, new Map()).then(value => { finished = true; return value; });
    try {
      await Promise.race([relay.first, work.then(() => { throw new Error("Interview was hidden by unrelated work"); })]);
      expect(finished).toBe(false); expect(relay.notices[0]!.details.requestBody).toContain('"scope"');
      await relay.reply(relay.notices[0]!.details.requestId);
    } finally {
      unrelated.resolve(child("other"));
      for (const notice of relay.notices) { try { await relay.reply(notice.details.requestId); } catch {} }
      await work; relay.dispose();
    }
  });

  test("fresh continuation research receives original context, updated human choices and contrary reports", async () => {
    const retained = await fixture().execute({ brief: "Original complete assignment" });
    const host = fixture((key, request) => {
      if (key.startsWith("director-doubts-")) return { ok: true, runId: key, structuredOutput: { doubts: [
        { id: "adapter", kind: "researcher", dependsOn: [], question: "Does the chosen adapter support recovery?", decision: "Recovery design" },
      ] } };
      if (key.startsWith("doubts-")) {
        for (const context of ["Original complete assignment", "Human chose adapter B", "Private report from r2-recover"])
          expect(request.task).toContain(context);
      }
      return child(key);
    });
    const result = await host.execute({ brief: "Human chose adapter B; complete updated decision", continuation: retained.continuation, planning: true, consultation: "updated" }, new Map());
    expect(result.status).toBe("completed"); expect(result.rounds).toBe(2);
  });

  test("reconciles human answers at ten consumed rounds without an eleventh comparison or counter reset", async () => {
    const previous = { version: 1, brief: "Original decision", rounds: 10, validRounds: 10, maxRounds: 10, directorRunId: "native-doubts-r10", members: [], evidence: [{ round: 10, question: "Prefer scope A?" }] };
    const storage = new Map<string, unknown>([["architecture-cap", previous]]);
    const host = fixture((key, request) => {
      expect(key).toBe("director-prepare"); expect(request.task).toContain("Actual human answered A");
      expect(request.task).toContain("finish or blocked only");
      return { ok: true, runId: "native-synthesis", structuredOutput: finish };
    });
    const result = await host.execute({ brief: "Actual human answered A", planning: true, consultation: "cap" }, storage);
    expect(result.status).toBe("completed"); expect(result.rounds).toBe(10); expect(result.validRounds).toBe(10);
    expect(host.calls).toHaveLength(1); expect(storage.get("architecture-cap")).toMatchObject({ rounds: 10, directorRunId: "native-synthesis" });
    const lower = fixture();
    await expect(lower.execute({ brief: "Same answer", planning: true, consultation: "cap", maxRounds: 9, continuation: result.continuation }, storage)).rejects.toThrow("lower than the consumed");
    expect(lower.calls).toHaveLength(0);
    const extra = await fixture().execute({ brief: "Same answer", planning: true, consultation: "cap", continuation: result.continuation }, storage);
    expect(extra.status).toBe("failed"); expect(extra.rounds).toBe(10); expect(extra.error).toContain("beyond the limit");
  });

  test("planning reentry fits native argument limits while retaining full reports and capped synthesis", async () => {
    const storage = new Map<string, unknown>();
    const roster = Array.from({ length: 4 }, (_, index) => ({ id: `p${index}`, label: `View ${index}`, focus: "Whole decision" }));
    const host = fixture(key => key === "director-prepare"
      ? { ok: true, runId: key, structuredOutput: { ...discuss, perspectives: roster } }
      : key.startsWith("director-doubts-") ? { ok: true, runId: key, structuredOutput: { doubts: [] } }
        : key.startsWith("r1-") ? { ok: true, runId: key, structuredOutput: { status: "ready", report: `${key}:` + "x".repeat(4090) } }
          : child(key));
    const first = await host.execute({ brief: "Complete assignment", planning: true, consultation: "large", maxRounds: 1 }, storage);
    expect(first.status).toBe("completed");
    expect(normalizeWorkflowArgs({ brief: "Actual human answers", continuation: storage.get("architecture-large") })).toMatchObject({ error: expect.stringContaining("16384") });
    const reentry = { brief: "Actual human answers", planning: true, consultation: "large", continuation: first.continuation };
    expect(normalizeWorkflowArgs(reentry)).toEqual({ args: reentry });
    const resumed = fixture((key, request) => {
      expect(key).toBe("director-prepare");
      for (const view of roster) expect(request.task).toContain(`r1-${view.id}:` + "x".repeat(4090));
      expect(request.task).toContain("finish or blocked only");
      return { ok: true, runId: "synthesis", structuredOutput: finish };
    });
    const done = await resumed.execute(reentry, storage);
    expect(done.status).toBe("completed"); expect(done.rounds).toBe(1); expect(resumed.calls).toHaveLength(1);
    expect(JSON.stringify(storage.get("architecture-large"))).toContain("x".repeat(4090));
  });

  test("rejects unknown or nonfactual prerequisites before dispatching any providers or relay", async () => {
    for (const dependsOn of [["missing"], ["scope"]]) {
      const host = fixture(key => key.startsWith("director-doubts-") ? { ok: true, runId: key, structuredOutput: { doubts: [
        { id: "scope", kind: "human", dependsOn, question: "Scope A?", decision: "Scope" },
      ] } } : child(key));
      const result = await host.execute({ brief: "Decision", planning: true, consultation: "invalid" }, new Map());
      expect(result.status).toBe("failed"); expect(result.error).toContain("dependencies");
      expect(host.calls.some(call => call.key.startsWith("human-") || call.key.startsWith("doubts-"))).toBe(false);
    }
  });
});
