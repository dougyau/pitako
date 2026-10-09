import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerMissionExtension } from "../extensions/mission/index.ts";
import { MissionStore, openMissionStore } from "../extensions/mission/store.ts";
import { authoringProposal, authoringSource } from "./mission-authoring-fixture.ts";
import { createMissionFixture } from "./mission-fixtures.ts";
import { installMissionLocalProvider } from "./mission-local-provider.ts";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { packageRoot } from "../extensions/stack.ts";
import { confirmMissionAction, missionActionView } from "../extensions/mission/preparation-view.ts";
import { previewFrozenStart, openPreparationRequest, preparedAdmissionText, consumePreparedAdmission } from "../extensions/mission/preparation.ts";
import { recordOperatorInput } from "../extensions/mission/admission.ts";

const oldDir = process.env.PI_CODING_AGENT_DIR, bases: string[] = [];
afterEach(() => {
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  delete (globalThis as Record<string, unknown>).__pitako_mission_local;
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});
function fixture() {
  const f = createMissionFixture("authoring-"); bases.push(f.base);
  rmSync(f.definitionFile); writeFileSync(f.planFile, authoringSource);
  mkdirSync(path.join(f.stateDir, "pitako"), { recursive: true });
  writeFileSync(path.join(f.stateDir, "pitako/config.toml"), '[model_policies.developer]\nprimary={model="test/developer",reasoning="high",fast=false}\n[model_policies.reviewer]\nprimary={model="test/reviewer",reasoning="high",fast=false}\n');
  process.env.PI_CODING_AGENT_DIR = f.stateDir;
  return f;
}
function contextFromMessage(message: string) {
  return JSON.parse(message.split("\n")[1]!);
}
function host(f: ReturnType<typeof fixture>) {
  const handlers = new Map<string, Function[]>(), tools = new Map<string, any>(), messages: string[] = [], notices: string[] = [];
  let command!: Function, confirm: (title: string, text: string) => Promise<boolean> = async () => true;
  registerMissionExtension({
    on: (name: string, fn: Function) => handlers.set(name, [...handlers.get(name) ?? [], fn]),
    registerCommand: (_name: string, value: { handler: Function }) => { command = value.handler; },
    registerTool: (value: any) => tools.set(value.name, value),
    sendUserMessage: (text: string, options: unknown) => { expect(options).toEqual({ deliverAs: "followUp" }); messages.push(text); },
  } as any);
  let session = "principal";
  const ctx = { mode: "tui", hasUI: true, cwd: f.root, sessionManager: { getSessionId: () => session },
    ui: { notify: (text: string) => notices.push(text), setStatus: (_key: string, _text: string | undefined) => {},
      confirm: (title: string, text: string) => confirm(title, text) } };
  return { ctx, messages, notices, tools, command: (text: string) => command(text, ctx), session: (id: string) => { session = id; },
    confirm: (fn: typeof confirm) => { confirm = fn; },
    emit: async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({ reason: "reload" }, ctx); },
    submit: (params: unknown) => tools.get("mission_prepare").execute("author", params, undefined, undefined, ctx) };
}

function meteredProposal(context: Parameters<typeof authoringProposal>[0]) {
  const proposal = authoringProposal(context);
  const { budget: _budget, schemaVersion: _schema, resourcePolicy: _policy, ...definition } = proposal.definition;
  return { ...proposal, definition: { ...definition, schemaVersion: 3 as const,
    resourcePolicy: { limits: {}, estimates: { tokens: 1, activeTimeMs: 1 } } } };
}

test.each(["refuse", "source", "shutdown", "switch", "replace", "session", "cancel"] as const)(
  "frozen start %s cannot resume stale consent or start setup/workers", async (scenario) => {
    const f = fixture(), h = host(f);
    try {
      await h.command("start durable-fixture");
      expect(h.messages[0]).toContain("schemaVersion 3");
      expect(h.messages[0]).toContain("Retrieve the current preparation context");
      const context = contextFromMessage(h.messages[0]!);
      const params = { id: "durable-fixture", requestId: context.requestId, proposal: meteredProposal(context) };
      await expect(h.tools.get("mission_start").execute("model", { id: params.id }, undefined, undefined, h.ctx))
        .rejects.toThrow("model tool cannot mint start authority");
      expect(existsSync(f.dbPath)).toBe(false);
      let prompts = 0;
      h.confirm(async (title, text) => {
        prompts++;
        expect(title).toBe("Start frozen mission");
        expect(text).toContain("Refusal starts neither");
        expect(text).toContain("Workers starting: t1 (developer)");
        expect(text).toContain("omitted dimensions are metered");
        expect(text).toContain("Estimates (not ceilings)");
        if (scenario === "source") writeFileSync(f.planFile, authoringSource + "\nchanged");
        if (scenario === "shutdown") await h.emit("session_shutdown");
        if (scenario === "switch") await h.emit("session_before_switch");
        if (scenario === "session") h.session("other");
        if (scenario === "replace") {
          await h.submit({ ...params, proposal: { ...params.proposal, mappings: [] } });
        }
        if (scenario === "cancel") await h.command("cancel durable-fixture");
        return scenario !== "refuse";
      });
      if (scenario === "refuse") expect(JSON.parse((await h.submit(params)).content[0].text).state).toBe("dismissed");
      else await expect(h.submit(params)).rejects.toThrow();
      expect(prompts).toBe(1);
      expect(existsSync(f.dbPath)).toBe(false);
      if (scenario === "session") h.session("principal"); // Restoring an ID does not resurrect lost requester authority.
      if (scenario !== "replace") await expect(h.submit({ id: params.id, requestId: params.requestId })).rejects.toThrow();
    } finally { await h.emit("session_shutdown"); }
  });

test("combined frozen admission is one-use and binds the entire schema3 proposal", async () => {
  const f = fixture(), h = host(f);
  try {
    await h.command("start durable-fixture");
    const context = contextFromMessage(h.messages[0]!);
    const request = openPreparationRequest("durable-fixture", f.root, "principal");
    const proposal = meteredProposal(context);
    const receiptId = crypto.randomUUID();
    const result = previewFrozenStart({ request, proposal, receiptId });
    if (result.state !== "ready") throw new Error(JSON.stringify(result));
    const text = preparedAdmissionText(result.prepared);
    const receipt = recordOperatorInput("native-confirmation", "principal", text, receiptId)!;
    const db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir });
    try {
      const input = { repositoryRoot: f.root, planId: "durable-fixture", prepared: result.prepared,
        commandId: receiptId, admissionReceiptId: receiptId, operatorText: text, operatorReceipt: receipt };
      const created = db.createMission(input);
      expect(created.definition.resourcePolicy).toEqual(proposal.definition.resourcePolicy);
      expect(db.inspectMission(created.id).prepared?.authorityDecision.receiptId).toBe(receiptId);
      expect(JSON.parse(text).action).toBe("admit-and-start-frozen-mission-v1");
      expect(db.createMission(input).id).toBe(created.id); // Exact command retry is idempotent, not a new admission.
      expect(db.inspectMission(created.id).events).toHaveLength(1);
      expect(() => consumePreparedAdmission(result.prepared, receipt)).toThrow();
      expect(() => result.prepared.definition.authority.externalEffects.push("expanded")).toThrow();
      const forged = structuredClone(result.prepared);
      forged.definition.authority.externalEffects.push("expanded");
      expect(() => preparedAdmissionText(forged)).toThrow("host-validated");
    } finally { db.close(); }
  } finally { await h.emit("session_shutdown"); }
});

test("native cached status observes preparation, owns only namespaced status, and does not hydrate on repaint", async () => {
  const f = fixture(), h = host(f), statuses: Array<[string, string | undefined]> = [];
  h.ctx.ui.setStatus = (key, text) => { statuses.push([key, text]); };
  try {
    await h.command("prepare durable-fixture");
    await h.command("status");
    expect(h.notices.at(-1)).toContain("observed 1 units");
    expect(statuses.at(-1)![1]).toContain("pending request attribution unavailable");
    const context = contextFromMessage(h.messages[0]!);
    await h.submit({ id: "durable-fixture", requestId: context.requestId, proposal: authoringProposal(context) });
    await h.emit("session_start"); // Matching admitted preparation is rediscovered, not reconsented or activated.
    const inspection = spyOn(MissionStore.prototype, "inspectMission").mockImplementation(() => { throw new Error("status hydrated"); });
    const artifacts = spyOn(MissionStore.prototype, "readArtifact").mockImplementation(() => { throw new Error("status hydrated"); });
    try {
      await h.command("status");
      expect(h.notices.at(-1)).toContain("accepted 0/1");
      const result = JSON.parse((await h.tools.get("mission_status").execute("status", {}, undefined, undefined, h.ctx)).content[0].text);
      expect(result.authority).toBe("display-only");
      expect(result.observation).toContain("caps:");
    } finally { inspection.mockRestore(); artifacts.mockRestore(); }
    await h.emit("session_before_switch");
    expect(statuses.at(-1)).toEqual(["pitako.mission", undefined]);
    expect(statuses.every(([key]) => key === "pitako.mission")).toBe(true);
  } finally { await h.emit("session_shutdown"); }
});

test("mission confirmation shows concise actions; viewing details is not consent", async () => {
  const f = fixture(), h = host(f);
  try {
    await h.command("prepare durable-fixture");
    const context = contextFromMessage(h.messages[0]!);
    const proposal = authoringProposal(context);
    const views: string[] = [], details: string[] = [];
    let selections = 0;
    Object.assign(h.ctx.ui, {
      select: async (title: string, options: string[]) => {
        views.push(title);
        expect(options).toEqual(["Prepare mission", "View details", "Cancel"]);
        return ++selections === 1 ? "View details" : options[0];
      },
      editor: async (_title: string, text: string) => {
        details.push(text);
        expect(existsSync(f.dbPath)).toBe(false);
        return '{"budget":{"tokens":1}}'; // Viewer edits must not alter the bound proposal.
      },
    });
    const result = JSON.parse((await h.submit({ id: "durable-fixture", requestId: context.requestId, proposal })).content[0].text);
    expect(result.status).toBe("ready");
    expect(details).toHaveLength(1);
    expect(selections).toBe(2); // Details, then one approval; no second confirmation.
    expect(JSON.parse(details[0]!).decisions[0].values.budget).toEqual(proposal.definition.budget);
    expect(views.every((view) => view.length < 1600 && !view.includes("definitionHash"))).toBe(true);
    const db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
    try {
      const mission = db.findManagedMission(f.root)!;
      expect(mission.definition.budget).toEqual(proposal.definition.budget);
      expect(mission.events.some(({ kind }) => kind === "mission.activated")).toBe(false);
    } finally { db.close(); }
  } finally { await h.emit("session_shutdown"); }
});

test("cancel or expired details cannot approve a mission action", async () => {
  let live = true, selections = 0;
  const ui: Parameters<typeof confirmMissionAction>[0] = {
    select: async () => ++selections === 1 ? "View details" : "Cancel",
    editor: async () => undefined,
    confirm: async () => { throw new Error("Unexpected legacy confirmation"); },
  };
  const input = { title: "Confirm mission start", summary: "Start the prepared mission", acceptLabel: "Start mission",
    details: () => '{"exact":"payload"}', check: () => { if (!live) throw new Error("expired"); } };
  expect(await confirmMissionAction(ui, input)).toBe(false);
  selections = 0;
  ui.editor = async () => { live = false; return undefined; };
  await expect(confirmMissionAction(ui, input)).rejects.toThrow("expired");
  expect(selections).toBe(1);
});

test("start and resume summaries disclose effects and limits without dumping the definition", async () => {
  const f = fixture(), h = host(f);
  try {
    await h.command("prepare durable-fixture");
    const context = contextFromMessage(h.messages[0]!);
    const definition = authoringProposal(context).definition;
    definition.budget.tokens = 64000000;
    definition.budget.activeTimeMs = 24960 * 60000;
    definition.budget.artifactBytes = 208 * 1024 ** 3;
    const original = JSON.stringify(definition);
    for (const action of ["start", "resume"]) {
      const text = missionActionView({ action, planId: "durable-fixture", revision: 7, root: f.root,
        state: action === "start" ? "prepared" : "paused", definition });
      expect(text).toContain("Plan: durable-fixture @7");
      expect(text).toContain(f.root);
      expect(text).toContain("provider requests");
      expect(text).toContain("64M tokens");
      expect(text).toContain("17 d 8 h");
      expect(text).toContain("208 GiB");
      expect(text).toContain("ceilings, not estimates");
      expect(text).toContain("current inputs are rechecked");
      expect(text.length).toBeLessThan(1400);
      expect(text).not.toContain("rolePolicies");
      expect(text).not.toContain("definitionHash");
      expect(text).toContain(action === "start" ? "Start implementation workers" : "Continue unfinished work");
    }
    expect(JSON.stringify(definition)).toBe(original);
  } finally { await h.emit("session_shutdown"); }
});

test.each(["request", "session", "root", "source", "config", "omission", "replace", "dismiss", "shutdown", "switch",
  "reload", "source-wait", "config-wait", "source-identity"] as const)(
  "assisted preparation rejects %s without setup/start/worker effects", async (scenario) => {
    const f = fixture(), h = host(f);
    await h.command("prepare durable-fixture");
    expect(h.messages).toHaveLength(1);
    const context = contextFromMessage(h.messages[0]!);
    const params = { id: "durable-fixture", requestId: context.requestId, proposal: authoringProposal(context) };
    if (scenario === "request") params.requestId = "wrong";
    if (scenario === "session") h.session("other");
    if (scenario === "root") h.ctx.cwd = f.base;
    if (scenario === "source") writeFileSync(f.planFile, authoringSource + "\nchanged");
    if (scenario === "config") writeFileSync(path.join(f.stateDir, "pitako/config.toml"), '[model_policies.developer]\nprimary="test/changed"\n');
    if (scenario === "omission") params.proposal.mappings.pop();
    let admissionPrompts = 0;
    h.confirm(async (title) => {
      if (title.startsWith("Prepare mission")) {
        admissionPrompts++;
        if (scenario === "shutdown") await h.emit("session_shutdown");
        if (scenario === "switch") await h.emit("session_before_switch");
        if (scenario === "reload") await h.emit("session_start");
        if (scenario === "source-wait") writeFileSync(f.planFile, authoringSource + "\nchanged");
        if (scenario === "source-identity") { writeFileSync(`${f.planFile}.new`, authoringSource); renameSync(`${f.planFile}.new`, f.planFile); }
        if (scenario === "config-wait") writeFileSync(path.join(f.stateDir, "pitako/config.toml"), "");
        if (scenario === "replace") {
          h.confirm(async () => false);
          await h.submit({ ...params, proposal: { definition: params.proposal.definition, mappings: [] } });
        }
        if (scenario === "dismiss") return undefined as unknown as boolean;
      }
      return true;
    });
    try {
      if (!["dismiss", "omission"].includes(scenario))
        await expect(h.submit(params)).rejects.toThrow();
      else {
        const result = JSON.parse((await h.submit(params)).content[0].text);
        expect(result.state).toBe(scenario === "dismiss" ? "dismissed" : "needs-input");
      }
      expect(admissionPrompts).toBe(["replace", "dismiss", "shutdown", "switch", "reload", "source-wait", "config-wait", "source-identity"].includes(scenario) ? 1 : 0);
      if (scenario === "dismiss") await expect(h.submit(params)).rejects.toThrow("current host request");
      expect(existsSync(f.dbPath)).toBe(false);
      expect(existsSync(path.join(f.stateDir, "pitako/console"))).toBe(false);
    } finally { await h.emit("session_shutdown"); }
  });

test("authority refusal is no grant; grouped source interpretation is explicitly bound and retained", async () => {
  const f = fixture(), h = host(f);
  writeFileSync(f.planFile, authoringSource + "\n## Ambiguous notes\n- Preserve diagnostics unless incompatible.\n");
  try {
    await h.command("prepare durable-fixture");
    let context = contextFromMessage(h.messages.at(-1)!);
    expect(context.inventory.unresolved.length).toBeGreaterThan(0);
    const params = () => ({ id: "durable-fixture", requestId: context.requestId, proposal: authoringProposal(context),
      interpretations: context.inventory.unresolved.map(({ id }: { id: string }) => ({ sourceId: id, disposition: "context" })) });
    h.confirm(async (title, text) => {
      expect(title).toContain("Prepare mission");
      expect(text).toContain("Preserve diagnostics unless incompatible");
      expect(text).toContain("Source decision");
      expect(text).toContain("provider requests");
      return false;
    });
    expect(JSON.parse((await h.submit(params())).content[0].text).state).toBe("dismissed");
    expect(existsSync(f.dbPath)).toBe(false);
    await h.command("prepare durable-fixture");
    context = contextFromMessage(h.messages.at(-1)!);
    const prompts: string[] = [];
    h.confirm(async (_title, text) => { prompts.push(text); return true; });
    const diagnostic = JSON.parse((await h.submit(params())).content[0].text);
    expect(prompts).toHaveLength(1);
    expect(diagnostic.authority).toBe("proposal-only");
    expect(diagnostic.operatorReceipt).toBeUndefined();
    const db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
    try {
      expect(db.findManagedMission(f.root)?.prepared?.answers).toHaveLength(context.inventory.unresolved.length);
      const preview = prompts.at(-1)!;
      expect(preview).toStartWith("Plan: durable-fixture @");
      expect(preview).toContain("no setup, provider or worker runs");
      expect(db.findManagedMission(f.root)?.prepared?.originalSource).toContain("Preserve diagnostics unless incompatible");
    } finally { db.close(); }
  } finally { await h.emit("session_shutdown"); }
});

test.each(["mapping", "observer", "proposal"] as const)("technical %s repair never becomes a permission dialog", async (problem) => {
  const f = fixture(), h = host(f);
  try {
    await h.command("prepare durable-fixture");
    const context = contextFromMessage(h.messages[0]!);
    expect(context.producers.find(({ id }: { id: string }) => id === "command_exit").proof).toContain("descriptor only");
    const proposal = authoringProposal(context);
    if (problem === "mapping") proposal.mappings.pop();
    if (problem === "observer") {
      proposal.definition.units[0]!.acceptance[0]!.kind = "manual";
      delete proposal.definition.units[0]!.acceptance[0]!.command;
    }
    let prompts = 0;
    h.confirm(async () => { prompts++; return true; });
    const result = JSON.parse((await h.submit({ id: "durable-fixture", requestId: context.requestId,
      proposal: problem === "proposal" ? { definition: proposal.definition } : proposal })).content[0].text);
    expect(result.status).toBe("technical-unresolved");
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: problem === "mapping" ? "missing-mapping" : problem === "observer" ? "unsupported-observer" : "invalid-proposal",
      owner: "author",
    }));
    expect(result.nextAction).toBeTruthy();
    expect(prompts).toBe(0);
    expect(existsSync(f.dbPath)).toBe(false);
  } finally { await h.emit("session_shutdown"); }
});

test("existing stage producer informs authoring without importing executable stage code", async () => {
  const f = fixture(), h = host(f);
  mkdirSync(path.join(f.root, "scripts"));
  writeFileSync(path.join(f.root, "scripts/verify-mission.ts"), 'throw new Error("stage execution is not preparation");\n');
  try {
    await h.command("prepare durable-fixture");
    const context = contextFromMessage(h.messages[0]!);
    const descriptor = context.producers.find(({ id }: { id: string }) => id === "verify:mission");
    expect(descriptor.route).toBe("scripts/verify-mission.ts");
    expect(descriptor.requirements).toContain("independent source mapping");
    expect(descriptor.proof).toContain("nested verification capability is not established");
    expect(existsSync(f.dbPath)).toBe(false);
  } finally { await h.emit("session_shutdown"); }
});

test("readable native view preserves exact finite budgets and optional canonical details without starting", async () => {
  const f = fixture(), h = host(f);
  try {
    await h.command("help");
    expect(h.notices.at(-1)).toContain("Technical errors need author correction, not user permission");
    expect(h.notices.at(-1)).toContain("sealed-nested-verification-v1");
    expect(h.notices.at(-1)).toContain("Ordinary worker namespace, socket and tool restrictions remain unchanged");
    await h.command("prepare durable-fixture");
    await h.command("prepare-details");
    const context = contextFromMessage(h.messages[0]!);
    const proposal = authoringProposal(context);
    const prompts: string[] = [];
    h.confirm(async (_title, text) => { prompts.push(text); return true; });
    const result = JSON.parse((await h.submit({ id: "durable-fixture", requestId: context.requestId, proposal })).content[0].text);
    expect(result.status).toBe("ready");
    expect(result.nextAction).toContain("/mission start durable-fixture");
    expect(prompts).toHaveLength(1);
    for (const text of prompts) {
      expect(text).not.toStartWith("{");
      expect(text).toContain(`Execution root: ${f.root}`);
      const budget = proposal.definition.budget;
      expect(text).toContain(`${budget.roleLaunches} launches`);
      expect(text).toContain(`${budget.providerRequests} provider requests`);
      expect(text).toContain(`${budget.tokens.toLocaleString("en-US")} tokens`);
      expect(text).toContain(`${budget.activeTimeMs / 60000} min`);
      expect(text).toContain("stored output: 64 MiB");
      expect(text).toContain("Setup: none");
      expect(text).toContain("no nested checker");
      expect(text).toContain("no setup, provider or worker runs");
      expect(text).not.toContain("rolePolicies");
      expect(text).not.toContain(proposal.definition.authority.rolePolicies.developer!.hash);
    }
    const details = h.notices.filter((text) => text.startsWith("{")).map((text) => JSON.parse(text));
    expect(details.at(-1).prepared.definition).toEqual(proposal.definition);
    expect(details.at(-1).preparedHash).toBe(result.preparedHash);
    const db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
    try {
      const mission = db.findManagedMission(f.root)!;
      expect(mission.events.some(({ kind }) => /setup|attempt|activated|provider/.test(kind))).toBe(false);
      expect(mission.prepared?.authorityDecision.text).toBe(JSON.stringify(details[0].decisions[0]));
    } finally { db.close(); }
  } finally { await h.emit("session_shutdown"); }
});

test.each(["grant-only", "selected", "cancelled", "stale"] as const)(
  "readable nested confirmation discloses capability and preserves %s admission", async (scenario) => {
    const f = fixture(), h = host(f);
    try {
      await h.command("prepare durable-fixture");
      const context = contextFromMessage(h.messages[0]!);
      const proposal = authoringProposal(context);
      proposal.definition.authority.verificationProfiles = ["sealed-nested-verification-v1"];
      if (scenario !== "grant-only")
        proposal.definition.units[0]!.acceptance[0]!.profile = "sealed-nested-verification-v1";
      const prompts: string[] = [];
      h.confirm(async (title, text) => {
        prompts.push(text);
        if (title.startsWith("Prepare mission")) {
          if (scenario === "cancelled") return false;
          if (scenario === "stale") writeFileSync(f.planFile, authoringSource + "\nchanged");
        }
        return true;
      });
      const submit = () => h.submit({ id: "durable-fixture", requestId: context.requestId, proposal });
      if (scenario === "stale") await expect(submit()).rejects.toThrow();
      else {
        const result = JSON.parse((await submit()).content[0].text);
        expect(scenario === "cancelled" ? result.state : result.status).toBe(scenario === "cancelled" ? "dismissed" : "ready");
      }
      expect(prompts).toHaveLength(1);
      for (const text of prompts) {
        expect(text).toContain("Offline nested checker authorized");
        expect(text).toContain("no host writes, credentials or network");
        expect(text).toContain("Workers remain restricted");
        expect(text).toContain("Mission budget:");
        expect(text).toContain("no setup, provider or worker runs");
        expect(text).toContain("separate execution consent");
        if (scenario === "grant-only") {
          expect(text).toContain("0 selected checks only");
        } else {
          expect(text).toContain("1 selected checks only");
        }
      }
      if (scenario === "cancelled" || scenario === "stale") expect(existsSync(f.dbPath)).toBe(false);
      else {
        const db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
        try {
          const mission = db.findManagedMission(f.root)!;
          expect(mission.definition.authority.verificationProfiles).toEqual(["sealed-nested-verification-v1"]);
          expect(mission.events.some(({ kind }) => /setup|attempt|activated|provider/.test(kind))).toBe(false);
        } finally { db.close(); }
      }
    } finally { await h.emit("session_shutdown"); }
  });

test("missing setup input names runtime repair, never asks for broader setup permission", async () => {
  const f = fixture(), h = host(f);
  mkdirSync(path.join(f.root, "scripts"));
  writeFileSync(path.join(f.root, "scripts/setup.sh"), "exit 0\n");
  try {
    await h.command("prepare durable-fixture");
    const context = contextFromMessage(h.messages[0]!);
    let prompts = 0;
    h.confirm(async () => { prompts++; return true; });
    const result = JSON.parse((await h.submit({ id: "durable-fixture", requestId: context.requestId,
      proposal: authoringProposal(context), setup: { effectProfile: "execution-root-local-v1",
        writableDirectories: ["node_modules"], activeTimeMs: 1000, artifactBytes: 16384 } })).content[0].text);
    expect(result.status).toBe("technical-unresolved");
    const issue = result.issues.find(({ code }: { code: string }) => code === "missing-local-input");
    expect(issue).toMatchObject({ owner: "runtime" });
    expect(issue.message).toContain("node_modules");
    expect(prompts).toBe(0);
    expect(existsSync(f.dbPath)).toBe(false);
  } finally { await h.emit("session_shutdown"); }
});

test("setup input changes during the native decision invalidate the original exact payload", async () => {
  const f = fixture(), h = host(f);
  mkdirSync(path.join(f.root, "scripts"));
  mkdirSync(path.join(f.root, "node_modules"));
  const hook = path.join(f.root, "scripts/setup.sh");
  writeFileSync(hook, "exit 0\n");
  try {
    await h.command("prepare durable-fixture");
    const context = contextFromMessage(h.messages[0]!);
    h.confirm(async () => { writeFileSync(hook, "exit 23\n"); return true; });
    try {
      await h.submit({ id: "durable-fixture", requestId: context.requestId, proposal: authoringProposal(context),
        setup: { effectProfile: "execution-root-local-v1", writableDirectories: ["node_modules"],
          activeTimeMs: 1000, artifactBytes: 16384 } });
      throw new Error("changed setup input was admitted");
    } catch (error) {
      expect(error).toMatchObject({ issue: { code: "stale-binding", owner: "runtime" } });
    }
    expect(existsSync(f.dbPath)).toBe(false);
    expect(existsSync(path.join(f.root, "node_modules/dependency"))).toBe(false);
  } finally { await h.emit("session_shutdown"); }
});

test.each(["valid", "infeasible", "malformed"] as const)("proposed %s setup distinguishes admission from ready-to-start", async (mode) => {
  const f = fixture(), h = host(f);
  mkdirSync(path.join(f.root, "scripts"));
  mkdirSync(path.join(f.root, "node_modules"));
  writeFileSync(path.join(f.root, "scripts/setup.sh"), "printf installed > node_modules/dependency\n");
  try {
    await h.command("prepare durable-fixture");
    const context = contextFromMessage(h.messages[0]!);
    const proposal = authoringProposal(context);
    let prompts = 0;
    h.confirm(async (_title, text) => {
      prompts++;
      expect(text).toContain("Setup: prepare node_modules");
      expect(text).toContain("16 KiB, within the mission budget");
      return true;
    });
    const result = JSON.parse((await h.submit({ id: "durable-fixture", requestId: context.requestId, proposal,
      setup: { effectProfile: "execution-root-local-v1", writableDirectories: ["node_modules"],
        activeTimeMs: mode === "infeasible" ? proposal.definition.budget.activeTimeMs : mode === "malformed" ? -1 : 1000,
        artifactBytes: 16384 } })).content[0].text);
    expect(result.status).toBe("technical-unresolved");
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: mode === "valid" ? "unresolved-setup" : mode === "infeasible" ? "insufficient-grant" : "invalid-proposal",
      owner: mode === "valid" ? "runtime" : "author",
    }));
    expect(prompts).toBe(mode === "valid" ? 1 : 0);
    expect(existsSync(path.join(f.root, "node_modules/dependency"))).toBe(false);
    if (mode === "valid") {
      expect(result.state).toBe("prepared");
      await h.command("status");
      const observed = h.notices.at(-1)!;
      expect(observed).toContain("prepared");
      expect(observed).toContain("Setup has not executed");
      expect(observed).toContain("/mission start");
    } else expect(existsSync(f.dbPath)).toBe(false);
  } finally { await h.emit("session_shutdown"); }
}, 30000);

test("native copied setup confirms exact bounds/destination and settles while prepared, without activation", async () => {
  const f = fixture(), h = host(f);
  const seed = path.join(f.base, "seed");
  mkdirSync(seed); writeFileSync(path.join(seed, "seed"), "1");
  mkdirSync(path.join(f.root, "scripts"));
  writeFileSync(path.join(f.root, "scripts/setup.sh"), "printf installed > node_modules/dependency\n");
  let destination: string | undefined;
  let prompts = 0;
  try {
    await h.command("prepare durable-fixture");
    const context = contextFromMessage(h.messages[0]!);
    const proposal = authoringProposal(context);
    proposal.definition.budget = { ...proposal.definition.budget, roleLaunches: 100, providerRequests: 100, artifactBytes: 8000000000 };
    h.confirm(async (_title, text) => {
      prompts++;
      expect(existsSync(path.join(f.root, "node_modules"))).toBe(false);
      expect(text).toContain("Setup: prepare node_modules");
      expect(text).not.toContain("bytes/file");
      expect(text).not.toContain("Setup output limits");
      expect(text).toContain("Private copies, network denied");
      return true;
    });
    const result = JSON.parse((await h.submit({ id: "durable-fixture", requestId: context.requestId, proposal,
      setup: { effectProfile: "execution-root-local-copy-v1", writableDirectories: ["node_modules"], activeTimeMs: 60000,
        artifactBytes: 600000000, copy: { bounds: { paths: 20, largestFileBytes: 100, totalBytes: 100 },
          seeds: [{ source: seed, destination: "node_modules", bounds: { paths: 2, largestFileBytes: 1, totalBytes: 1 } }] } } })).content[0].text);
    expect(result).toMatchObject({ state: "prepared", status: "ready" });
    expect(prompts).toBe(1);
    expect(result.nextAction).toContain("rechecked and reused");
    await h.command("status");
    expect(JSON.parse(h.notices.at(-1)!)).toMatchObject({ preparationStatus: "ready" });
    const reader = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
    try {
      const mission = reader.findManagedMission(f.root)!;
      destination = mission.prepared!.setup!.identity.copy!.destination;
      expect(mission.state).toBe("prepared");
      expect(mission.events.filter(({ kind }) => kind === "mission.setup.intent")).toHaveLength(1);
      expect(mission.events.some(({ kind }) => ["mission.activated", "attempt.reserved", "provider.request"].includes(kind))).toBe(false);
      expect(readFileSync(path.join(destination, "published/node_modules/dependency"), "utf8")).toBe("installed");
      expect(existsSync(path.join(f.root, "node_modules"))).toBe(false);
    } finally { reader.close(); }
  } finally {
    await h.emit("session_shutdown");
    if (destination) rmSync(destination, { recursive: true, force: true });
  }
}, 120000);

test.each(["stale-seed", "infeasible-root"] as const)("copied native setup rejects %s before effects", async (mode) => {
  const f = fixture(), h = host(f), seed = path.join(f.base, "seed");
  mkdirSync(seed); writeFileSync(path.join(seed, "seed"), "1");
  mkdirSync(path.join(f.root, "scripts"));
  writeFileSync(path.join(f.root, "scripts/setup.sh"), "printf installed > node_modules/dependency\n");
  try {
    await h.command("prepare durable-fixture");
    const context = contextFromMessage(h.messages[0]!);
    const proposal = authoringProposal(context);
    proposal.definition.budget = { ...proposal.definition.budget, roleLaunches: 100, providerRequests: 100, artifactBytes: 8000000000 };
    let prompts = 0;
    h.confirm(async () => { prompts++; writeFileSync(path.join(seed, "seed"), "2"); return true; });
    const submit = () => h.submit({ id: "durable-fixture", requestId: context.requestId, proposal,
      setup: { effectProfile: "execution-root-local-copy-v1", writableDirectories: ["node_modules"],
        activeTimeMs: mode === "infeasible-root" ? proposal.definition.budget.activeTimeMs : 15000, artifactBytes: 600000000,
        copy: { bounds: { paths: 20, largestFileBytes: 100, totalBytes: 100 },
          seeds: [{ source: seed, destination: "node_modules", bounds: { paths: 2, largestFileBytes: 1, totalBytes: 1 } }] } } });
    if (mode === "stale-seed") {
      try { await submit(); throw new Error("stale copied seed admitted"); }
      catch (error) { expect(error).toMatchObject({ issue: { code: "stale-binding", owner: "runtime" } }); }
      expect(prompts).toBe(1);
    } else {
      const result = JSON.parse((await submit()).content[0].text);
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "insufficient-grant", owner: "author" }));
      expect(prompts).toBe(0);
    }
    expect(existsSync(f.dbPath)).toBe(false);
    expect(existsSync(path.join(f.root, "node_modules"))).toBe(false);
  } finally { await h.emit("session_shutdown"); }
}, 30000);

test("supported busy SDK command → queued foreground provider → author tool → native decisions → immutable prepared reload", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = await installMissionLocalProvider({ agentDir: f.stateDir,
    responseGate: async (prompt, signal) => {
      if (prompt !== "Unrelated principal work") return;
      entered(); await gate;
      expect(signal?.aborted).not.toBe(true);
    },
    toolForPrompt: (prompt) => {
      if (!prompt.startsWith("Mission preparation request")) return;
      const context = contextFromMessage(prompt);
      return { name: "mission_prepare", arguments: { id: "durable-fixture", requestId: context.requestId,
        proposal: authoringProposal(context) } };
    } });
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.stateDir, extensionFactories: [registerMissionExtension],
    noSkills: true, noPromptTemplates: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: f.root, agentDir: f.stateDir, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(f.root), noTools: "builtin" });
  const previews: string[] = [], notices: string[] = [];
  const ui = {
    notify: (text: string) => notices.push(text),
    select: async (title: string, options: string[]) => { previews.push(title); return options[0]; },
    editor: async () => undefined,
    confirm: async () => { throw new Error("Unexpected legacy confirmation"); },
  };
  try {
    await session.bindExtensions({ mode: "tui", uiContext: ui as any });
    await session.setModel(session.modelRuntime.getModel(provider.provider, provider.model)!);
    const ordinary = session.prompt("Unrelated principal work");
    await waiting;
    const started = performance.now();
    await session.prompt("/mission prepare durable-fixture");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(provider.trace.some(({ prompt }) => prompt.startsWith("Mission preparation request"))).toBe(false);
    expect(existsSync(f.dbPath)).toBe(false);
    release(); await ordinary;
    for (let i = 0; i < 500 && !notices.some((text) => text.startsWith("Prepared ")); i++) await Bun.sleep(10);
    await session.waitForIdle();
    if (!provider.trace.length) throw new Error(`foreground message not dispatched: ${JSON.stringify(notices)}`);
    expect(provider.trace.some(({ prompt }) => prompt.startsWith("Mission preparation request"))).toBe(true);
    expect(previews).toHaveLength(1);
    expect(previews[0]).toContain("Prepare now: validate and register");
    const db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
    try {
      const mission = db.findManagedMission(f.root)!;
      expect(mission.state).toBe("prepared");
      expect(mission.prepared?.originalSource).toBe(authoringSource);
      expect(mission.events.some(({ kind }) => /setup|attempt|activated|provider/.test(kind))).toBe(false);
      expect(existsSync(f.definitionFile)).toBe(false);
      await session.reload();
      await session.prompt("/mission status");
      expect(db.findManagedMission(f.root)?.snapshot.preparedHash).toBe(mission.snapshot.preparedHash);
      expect(db.ownershipIdentity.claimId).toBe("");
      expect(notices.some((text) => text.includes('"state":"prepared"'))).toBe(true);
      if (process.env.MISSION_T3_ARTIFACT_DIR) {
        mkdirSync(process.env.MISSION_T3_ARTIFACT_DIR, { recursive: true });
        writeFileSync(path.join(process.env.MISSION_T3_ARTIFACT_DIR, "sdk-authoring.json"), JSON.stringify({
          fixtureAuthority: true, userApproval: false, provider: provider.provider, model: provider.model,
          mission, previews, notices, trace: provider.trace,
        }, null, 2));
      }
    } finally { db.close(); }
  } finally { release(); await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
}, 60000);

test("supported SDK reload invalidates a pending exact confirmation callback before any admission", async () => {
  const f = fixture();
  const provider = await installMissionLocalProvider({ agentDir: f.stateDir, toolForPrompt: (prompt) => {
    if (!prompt.startsWith("Mission preparation request")) return;
    const context = contextFromMessage(prompt);
    return { name: "mission_prepare", arguments: { id: "durable-fixture", requestId: context.requestId,
      proposal: authoringProposal(context) } };
  } });
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.stateDir,
    extensionFactories: [registerMissionExtension], noSkills: true, noPromptTemplates: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: f.root, agentDir: f.stateDir, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(f.root), noTools: "builtin" });
  let answer!: (accepted: boolean) => void;
  try {
    await session.bindExtensions({ mode: "tui", uiContext: {
      notify: () => {}, editor: async () => undefined,
      select: async (title: string, options: string[]) => title.startsWith("Prepare mission")
        ? new Promise<string>((resolve) => { answer = (accepted) => resolve(accepted ? options[0]! : "Cancel"); }) : options[0],
      confirm: async () => { throw new Error("Unexpected legacy confirmation"); },
    } as any });
    await session.setModel(session.modelRuntime.getModel(provider.provider, provider.model)!);
    await session.prompt("/mission prepare durable-fixture");
    for (let i = 0; i < 500 && !answer; i++) await Bun.sleep(10);
    expect(answer).toBeFunction();
    await session.reload();
    answer(true);
    await session.waitForIdle();
    expect(existsSync(f.dbPath)).toBe(false);
    expect(provider.trace.some(({ prompt }) => prompt.startsWith("Mission preparation request"))).toBe(true);
  } finally {
    answer?.(false);
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
  }
}, 60000);

test("actual Pi PTY foreground author tool prepares with one native confirmation", async () => {
  const f = fixture(), extension = path.join(f.stateDir, "authoring.ts");
  writeFileSync(extension, `
import { registerMissionExtension } from ${JSON.stringify(path.join(packageRoot(), "extensions/mission/index.ts"))};
import { authoringProposal } from ${JSON.stringify(path.join(packageRoot(), "tests/mission-authoring-fixture.ts"))};
import { createAssistantMessageEventStream } from ${JSON.stringify(path.join(packageRoot(), "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"))};
export default function(pi) {
 registerMissionExtension(pi);
 pi.registerProvider("authoring-offline", { api:"openai-completions", apiKey:"fixture", baseUrl:"http://127.0.0.1",
  models:[{id:"fixture",name:"Offline authoring wiring",reasoning:false,input:["text"],contextWindow:200000,maxTokens:8192,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
  streamSimple(model, context) {
    const prompt=[...context.messages].reverse().find(m=>m.role==="user")?.content.filter(p=>p.type==="text").map(p=>p.text).join("\\n") ?? "";
    const host=prompt.startsWith("Mission preparation request") ? JSON.parse(prompt.split("\\n")[1]) : undefined;
    const tool=host && context.messages.at(-1)?.role==="user";
    const message={role:"assistant",api:"openai-completions",provider:model.provider,model:model.id,timestamp:Date.now(),
      usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
      stopReason:tool?"toolUse":"stop",
      content:tool?[{type:"toolCall",id:"author-call",name:"mission_prepare",arguments:{id:"durable-fixture",requestId:host.requestId,proposal:authoringProposal(host)}}]:[{type:"text",text:"Offline wiring; no product execution."}]};
    const stream=createAssistantMessageEventStream();
    queueMicrotask(()=>{stream.push({type:"done",reason:message.stopReason,message});stream.end(message)});
    return stream;
  }
 });
}`);
  const child = spawn("script", ["-q", "-e", "-c",
    `${JSON.stringify(path.join(packageRoot(), "node_modules/.bin/pi"))} --no-extensions --no-session --approve -e ${JSON.stringify(extension)} --provider authoring-offline --model fixture`,
    "/dev/null"], { cwd: f.root, detached: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color" } });
  let output = "";
  child.stdout.on("data", (part) => { output += part.toString(); });
  child.stderr.on("data", (part) => { output += part.toString(); });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 1500; i++) {
      if (predicate()) return;
      if (child.exitCode !== null) throw new Error(`PTY exited ${child.exitCode}: ${output.slice(-4000)}`);
      await Bun.sleep(20);
    }
    throw new Error(`PTY timeout: ${output.slice(-4000)}`);
  };
  try {
    await wait(() => output.includes("Pi") || output.includes("pi v"));
    child.stdin.write("/mission prepare durable-fixture\r");
    await wait(() => output.includes("Prepare mission — not start"));
    expect(existsSync(f.dbPath)).toBe(false);
    child.stdin.write("\r");
    await wait(() => output.includes("Prepared "));
    const db = await openMissionStore({ dbPath: f.dbPath, objectDir: f.objectDir, readOnly: true });
    try {
      const mission = db.findManagedMission(f.root)!;
      expect(mission.state).toBe("prepared");
      expect(mission.events[0]?.payload.operatorReceipt).toMatchObject({ source: "native-confirmation" });
      expect(mission.events.some(({ kind }) => /activated|attempt|setup/.test(kind))).toBe(false);
      expect(mission.prepared?.inventory.criteria).toHaveLength(3);
      if (process.env.MISSION_T3_ARTIFACT_DIR) {
        writeFileSync(path.join(process.env.MISSION_T3_ARTIFACT_DIR, "pty-authoring.json"), JSON.stringify({
          fixtureAuthority: true, userApproval: false, provider: "authoring-offline/fixture", mission,
        }, null, 2));
      }
    } finally { db.close(); }
    child.stdin.write("/quit\r");
    await wait(() => child.exitCode !== null);
    expect(child.exitCode).toBe(0);
  } finally {
    if (child.exitCode === null) {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
      await Promise.race([new Promise((resolve) => child.once("close", resolve)), Bun.sleep(5000)]);
      if (child.exitCode === null) try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
    if (process.env.MISSION_T3_ARTIFACT_DIR)
      writeFileSync(path.join(process.env.MISSION_T3_ARTIFACT_DIR, "pty-output.txt"), output);
  }
}, 60000);
