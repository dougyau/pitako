import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
interface Result { ok: boolean; runId?: string; structuredOutput?: unknown }
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
  continuation: Continuation | null;
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
  const runs = {
    run(key: string, request: Request): Promise<Result> {
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      calls.push({ key, request });
      return Promise.resolve().then(() => respond(key, request));
    },
    all(requests: Request[]): Promise<Result[]> {
      batches.push(requests);
      return Promise.all(requests.map(request =>
        runs.run(request.key!, request).catch(() => ({ ok: false }))));
    },
    steer(key: string, message: string, options: unknown) {
      steered.push({ key, message, options });
      return Promise.resolve().then(() => steer(key));
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...parameters: string[]
  ) => (args: unknown, runner: typeof runs) => Promise<Outcome>;
  const execute = (args: unknown = { brief: "Choose a complete persistence design" }) =>
    new AsyncFunction("args", "runs", source)(args, runs);
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

  test("enforces a five-round maximum and preserves the director's latest native reference", async () => {
    const host = fixture(key => child(key, key === "director-after-r5" ? finish : discuss));
    const result = await host.execute();
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(5);
    expect(result.validRounds).toBe(5);
    expect(host.calls.filter(call => /^r\d-/.test(call.key))).toHaveLength(10);
    expect(result.continuation?.directorRunId).toBe("native-director-after-r5");
    expect(host.calls.find(call => call.key === "director-after-r5")?.request.resume)
      .toBe("native-director-after-r4");
    expect(host.calls.some(call => call.key.startsWith("r6-"))).toBe(false);
  });

  test("refuses an extra requested round instead of reporting a false synthesis", async () => {
    const host = fixture(key => child(key, discuss));
    const result = await host.execute({ brief: "Decision", maxRounds: 1 });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("beyond the limit");
    expect(result.rounds).toBe(1);
    expect(host.calls.filter(call => /^r\d-/.test(call.key))).toHaveLength(2);
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
      expect(host.batches).toHaveLength(1);
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
    expect(result.continuation?.members[0]?.runId).toBe("native-r2-simple");
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

  test("reuses only the director for an explicitly new decision", async () => {
    const first = await fixture().execute({ brief: "Old decision", maxRounds: 1 });
    const host = fixture();
    const result = await host.execute({
      brief: "New complete decision", continuation: first.continuation, newDecision: true,
    });
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(1);
    expect(result.validRounds).toBe(1);
    expect(result.continuation?.maxRounds).toBe(5);
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
    { brief: "" }, { brief: "Decision", maxRounds: 6 },
    { brief: "Decision", maxRounds: 1.5 }, { brief: "Decision", newDecision: "yes" },
    { brief: "Decision", continuation: null }, { brief: "Decision", continuation: { version: 99 } },
  ])("rejects invalid input before dispatch: %j", async args => {
    const host = fixture();
    await expect(host.execute(args)).rejects.toThrow();
    expect(host.calls).toHaveLength(0);
  });
});
