import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import planExecute, { executionResource } from "../extensions/plan-execute.ts";
import { SPEC_SECTIONS } from "../extensions/spec-plans.ts";
import { executeControllerFixture } from "./fixtures/execute-workflow.ts";

const { fixture } = executeControllerFixture();
const invalid = [null, [], 3, "slow", { unknown: 1 }, { reviewerMs: 0 }, { workerMs: 86400001 },
  { gateFloorMs: 1.5 }, { reviewerMs: Number.MAX_SAFE_INTEGER + 1 }, { workerMs: "100" }];

test.each(invalid)("invalid timeouts %j fail at all three boundaries before state reads or launches", async timeouts => {
  const resource = executionResource();
  expect(() => resource.resolve({ timeouts })).toThrow("Expected timeouts");
  const handlers: Record<string, Function> = {};
  planExecute({ on: (name: string, handler: Function) => { handlers[name] = handler; } } as unknown as ExtensionAPI);
  expect(handlers.tool_call!({ toolName: "subagent", input: { workflow: "pitako.execute", args: { timeouts } } }, {}))
    .toMatchObject({ block: true, reason: expect.stringContaining("Expected timeouts") });
  const host = fixture();
  let reads = 0;
  const get = host.state.get;
  host.state.get = async key => { reads++; return get(key); };
  const output = await host.execute({ timeouts });
  expect(output).toMatchObject({ status: "blocked", reason: expect.stringContaining("Expected timeouts") });
  expect(reads).toBe(0);
  expect(host.launches).toHaveLength(0);
  expect(host.hostCalls).toHaveLength(0);
  expect(host.storage.size).toBe(0);
});

test("resolver passes valid options only in config, leaving host admission request unchanged", () => {
  const host = fixture();
  const spec = path.join(host.root, ".pitako/plans/assignment.md");
  mkdirSync(path.dirname(spec), { recursive: true });
  writeFileSync(spec, `---\npitako-spec: 1\nid: assignment\nstatus: complete\n---\n${SPEC_SECTIONS.map(title => `## ${title}\nAgreed ${title}.`).join("\n")}\n`);
  const missionPath = path.join(host.root, "native.mission-1.json");
  writeFileSync(missionPath, JSON.stringify({ id: "native.mission-1" }));
  const args = { root: host.root, id: "assignment", invocation: "human-1", missionId: "native.mission-1", missionPath };
  const resource = executionResource();
  const normal = resource.resolve(args);
  for (const timeouts of [{ reviewerMs: 1, workerMs: 86400000, gateFloorMs: 20 }, {}]) {
    const changed = resource.resolve({ ...args, timeouts });
    expect(changed.hostCommands).toEqual(normal.hostCommands);
    const configLine = changed.script.split("\n").find(line => line.startsWith("const config = "))!;
    const config = JSON.parse(configLine.slice("const config = ".length, -1));
    expect(config.timeouts).toEqual(timeouts);
    delete config.timeouts;
    expect(config).toEqual(JSON.parse(normal.script.split("\n").find(line => line.startsWith("const config = "))!.slice("const config = ".length, -1)));
  }
});

test("sticky fields merge on relaunch, omission retains, and empty object resets with effective reporting", async () => {
  const host = fixture();
  host.setFailSave(value => value.loop?.attempt?.stage === "intention");
  await host.execute({ timeouts: { reviewerMs: 20000000, workerMs: 21000000 } });
  expect(host.current().timeouts).toEqual({ values: { reviewerMs: 20000000, workerMs: 21000000 }, since: { loop: 0, attempt: 0 } });
  const association = structuredClone(host.current().association);
  const binding = host.current().admissionBinding;
  const backlogPath = path.join(host.root, ".pitako/backlog/spec.json");
  const backlog = readFileSync(backlogPath, "utf8");
  const digest = host.current().backlogDigest;
  const output = await host.execute({ timeouts: { gateFloorMs: 22000000 } });
  expect(host.current().timeouts.values).toEqual({ reviewerMs: 20000000, workerMs: 21000000, gateFloorMs: 22000000 });
  expect(output.timeouts).toEqual(output.loopReport.timeouts);
  expect(output.timeouts.since).toEqual({ loop: 1, attempt: 0 });
  await host.execute();
  expect(host.current().timeouts).toEqual({ values: output.timeouts.values, since: output.timeouts.since });
  const reset = await host.execute({ timeouts: {} });
  expect(host.current().timeouts.values).toEqual({});
  expect(reset.timeouts.values).toEqual({ reviewerMs: 14400000, workerMs: 14400000, gateFloorMs: 0 });
  expect(reset.loopReport.timeouts).toEqual(reset.timeouts);
  expect(host.current().association).toEqual(association);
  expect(host.current().admissionBinding).toBe(binding);
  expect(readFileSync(backlogPath, "utf8")).toBe(backlog);
  expect(host.current().backlogDigest).toBe(digest);
});

test("an essential timeout save failure prevents subsequent dispatch", async () => {
  const host = fixture();
  host.setFailSave(value => !!value.timeouts);
  const result = await host.execute({ timeouts: { workerMs: 20000000 } });
  expect(result.reason).toContain("Essential persistence failed");
  expect(host.launches).toHaveLength(0);
});
