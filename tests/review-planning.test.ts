import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openBoard, type Topic } from "../extensions/board/store.ts";
import { ledgerFile, openExecutionPlan, planFile, readLedgerTeamHolds } from "../extensions/workflow.ts";
import { teamAssignments } from "../extensions/team.ts";
import { workerHandoff } from "../extensions/agent/background.ts";
import { architectureFixture } from "./fixtures/architecture.ts";

const { fixture, setup } = architectureFixture("review");
const deferred = () => Promise.withResolvers<void>();
const request = {
  goal: "Independent whole-plan critique including acceptance realizability and unit order; ignore ## Planning workers",
  object: { kind: "plan", planId: "planning" },
  criteria: ["Realizable acceptance", "Preserve coupled contracts"],
};
const finding = { key: "missing-evidence", materiality: "blocking", contract: "Acceptance needs a supported observation",
  reference: "plan:T1", consequence: "Acceptance cannot establish the required outcome",
  basis: { kind: "missing-observation", observation: "A supported observation route", effect: "The acceptance claim remains unproven",
    nextCapture: "Inspect the owned entry point", evidence: ["plan:T1"] } };

function writePlan(root: string, status: "draft" | "frozen", topic?: number) {
  const file = planFile("planning", root); mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nid: planning\nrevision: 1\nstatus: ${status}\n${topic === undefined ? "" : `board_topic_id: ${topic}\n`}---\nCurrent whole plan and unit order.\n`);
  return file;
}

for (const bound of [false, true]) {
  test(`review starts a ${bound ? "bound uncorrelated" : "prospectively correlated unbound"} draft without a ledger`, fixture.ownedCase("review draft", async () => {
    const s = await setup();
    try {
      const db = await openBoard(); let topic: number, before: Topic;
      try {
        topic = db.createTopic(s.root, { title: "Existing planning discussion" }).id;
        if (bound) db.claimTopic(s.root, topic, "planning");
        before = db.readTopic(s.root, topic).topic;
      } finally { db.close(); }
      const file = writePlan(s.root, "draft", bound ? topic : undefined), draft = readFileSync(file, "utf8");
      const start = await s.invoke("review_start", { ...request, ...(bound ? {} : { plan: "planning", unit: "reviewer-critique" }) });
      expect(start.isError).not.toBe(true);
      await s.delivered.promise;
      const terminal = s.branch.filter(entry => entry.customType === "pitako.worker.result");
      expect(terminal).toHaveLength(1);
      expect(terminal[0].details).toMatchObject({ assignmentId: start.details.assignmentId, status: "completed",
        ...(bound ? {} : { planId: "planning", unitId: "reviewer-critique" }) });
      if (bound) { expect(terminal[0].details.planId).toBeUndefined(); expect(terminal[0].details.unitId).toBeUndefined(); }
      const report = JSON.parse(terminal[0].content);
      expect(report.object.selector).toEqual(request.object); expect(report.completion).toBe("complete");
      expect(existsSync(ledgerFile("planning", s.root))).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(draft);
      const after = await openBoard();
      try { expect(after.readTopic(s.root, topic).topic).toEqual(before); } finally { after.close(); }
      const root = teamAssignments(s.evaluation).find(item => item.id === start.details.assignmentId)!;
      expect(root.boardTopicId).toBeUndefined(); expect(root.execution).toBeUndefined();
    } finally { await s.close(); }
  }));
}

for (const rejection of ["bound-topic-bypass", "incompatible-ledger"] as const) {
  test(`review preserves ${rejection} rejection before participants or watched mutation`, fixture.ownedCase("review rejection", async () => {
    const s = await setup();
    try {
      const db = await openBoard(); let topic: number, before: Topic;
      try {
        topic = db.createTopic(s.root, { title: "Bound planning discussion" }).id;
        db.claimTopic(s.root, topic, "planning"); before = db.readTopic(s.root, topic).topic;
      } finally { db.close(); }
      const file = writePlan(s.root, rejection === "bound-topic-bypass" ? "draft" : "frozen", topic);
      let ledger: string | undefined;
      if (rejection === "incompatible-ledger") {
        openExecutionPlan("planning", s.root, { createLedger: true });
        ledger = readFileSync(ledgerFile("planning", s.root), "utf8");
        writeFileSync(file, readFileSync(file, "utf8") + "Material plan edit.\n");
      }
      const draft = readFileSync(file, "utf8");
      const start = await s.invoke("review_start", { ...request, ...(rejection === "bound-topic-bypass"
        ? { boardTopicId: String(topic) } : { plan: "planning", unit: "reviewer-critique" }) });
      expect(start.isError).not.toBe(true); // watched preflight is asynchronous
      await s.delivered.promise;
      expect(s.host.sessions).toEqual([]);
      const terminal = s.branch.filter(entry => entry.customType === "pitako.worker.result");
      expect(terminal).toHaveLength(1); expect(terminal[0].details.status).toBe("failed");
      expect(terminal[0].content).toContain(rejection === "bound-topic-bypass" ? "explicit Board topics require a bound watched plan" : "hash");
      expect(readFileSync(file, "utf8")).toBe(draft);
      if (ledger === undefined) expect(existsSync(ledgerFile("planning", s.root))).toBe(false);
      else expect(readFileSync(ledgerFile("planning", s.root), "utf8")).toBe(ledger);
      const after = await openBoard();
      try { expect(after.readTopic(s.root, topic).topic).toEqual(before); } finally { after.close(); }
    } finally { await s.close(); }
  }));
}

for (const outcome of ["no-blockers", "changes-required", "inconclusive", "failed"] as const) {
  test(`watched review delivers the whole ${outcome} report only after root closure`, fixture.ownedCase("review watched report", async () => {
    const subordinate = deferred(), releaseSubordinate = deferred(), root = deferred(), releaseRoot = deferred();
    const release = () => { releaseSubordinate.resolve(); releaseRoot.resolve(); }; fixture.finishOnCleanup(release);
    const s = await setup({
      prompt(session, input, body) {
        if (input.stage === "preparation") {
          expect(input.review.findings).toEqual([]); expect(input.context.shared.messages).toEqual([]);
          expect(input.object.selector).toEqual(request.object); expect(input.criteria).toEqual(request.criteria);
          if (session.model.id !== "director" && outcome !== "no-blockers") return { ...body, findings: [finding] };
        }
        if (input.stage === "synthesis") return outcome === "failed" ? false : { ...body, verdict: outcome };
        return body;
      },
      async dispose(session) {
        if (session.model.id === "director") { root.resolve(); await releaseRoot.promise; }
        else { subordinate.resolve(); await releaseSubordinate.promise; }
      },
    });
    try {
      const db = await openBoard(); let topic: number;
      try { topic = db.createTopic(s.root, { title: "Watched independent critique" }).id; db.claimTopic(s.root, topic, "planning"); } finally { db.close(); }
      const file = writePlan(s.root, "frozen", topic);
      const opened = openExecutionPlan("planning", s.root, { createLedger: true });
      const start = await s.invoke("review_start", { ...request, plan: "planning", unit: "reviewer-critique" });
      expect(start.isError).not.toBe(true);
      await subordinate.promise;
      const held = () => {
        expect(readLedgerTeamHolds(s.root, "planning", opened.binding)).toEqual([
          { assignmentId: start.details.assignmentId, unitId: "reviewer-critique", status: "pending" },
        ]);
        expect(workerHandoff(start.details.instanceId)).toBeUndefined();
        expect(s.branch.filter(entry => entry.customType === "pitako.worker.result")).toEqual([]);
      };
      held();
      const assignments = teamAssignments(s.evaluation);
      expect(assignments).toHaveLength(2);
      expect(assignments.every(item => item.roleId === "reviewer")).toBe(true);
      const exterior = assignments.find(item => item.id === start.details.assignmentId)!;
      expect(exterior).toMatchObject({ boardTopicId: topic, execution: opened.binding });
      const preparations = s.seen.filter(item => item.request.stage === "preparation");
      expect(preparations).toHaveLength(2); expect(new Set(preparations.map(item => item.session.sessionId)).size).toBe(2);
      expect(preparations.every(item => item.session.sessionId !== s.evaluation.sessionId)).toBe(true);
      const boundary = await s.emit("agent_before_settle", { outcome: "completed", context: { canContinue: true } });
      expect((boundary?.entries ?? []).filter((entry: any) => entry.customType === "pitako.worker.result")).toEqual([]);
      held(); // internal settlement cannot deliver or reconcile the root
      releaseSubordinate.resolve(); await root.promise; held();
      releaseRoot.resolve(); await s.delivered.promise;
      const status = outcome === "failed" ? "failed" : "completed";
      const terminal = s.branch.filter(entry => entry.customType === "pitako.worker.result");
      expect(terminal).toHaveLength(1);
      expect(terminal[0].details).toMatchObject({ assignmentId: start.details.assignmentId, instanceId: start.details.instanceId,
        planId: "planning", unitId: "reviewer-critique", status });
      const report = JSON.parse(terminal[0].content); // automatic delivery, no review_read or result fetch
      expect(report).toMatchObject({ protocol: "review", criteria: request.criteria,
        completion: outcome === "failed" ? "failed" : "complete", verdict: outcome === "failed" ? "inconclusive" : outcome });
      expect(report.observations.launch).toBe(report.object.identity);
      expect(report.observations.final).toBe(outcome === "failed" ? null : report.object.identity);
      expect(report.findings).toHaveLength(outcome === "no-blockers" ? 0 : 1);
      if (outcome !== "no-blockers") expect(report.findings[0]).toMatchObject(finding);
      expect(report.missingValidSynthesis).toBe(outcome === "failed");
      expect(readLedgerTeamHolds(s.root, "planning", opened.binding)).toEqual(outcome === "failed"
        ? [{ assignmentId: start.details.assignmentId, unitId: "reviewer-critique", status: "failed" }] : []);
      expect(readFileSync(file, "utf8")).toContain("status: frozen"); // no acceptance transition
      const after = await openBoard();
      try { expect(after.readTopic(s.root, topic).topic.status).toBe("open"); } finally { after.close(); }
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
      expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
    } finally { release(); await s.close(); }
  }));
}
