import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openBoard, type Topic } from "../extensions/board/store.ts";
import { ledgerFile, openExecutionPlan, planFile, readLedgerTeamHolds } from "../extensions/workflow.ts";
import { teamAssignments } from "../extensions/team.ts";
import { teamWorkerStatus, workerHandoff } from "../extensions/agent/background.ts";
import { WorkflowState, type Resource } from "../extensions/workflow-state.ts";
import type { AttemptRecord } from "../extensions/workflow-engine.ts";
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
      expect(terminal[0].details).toMatchObject({ assignmentId: start.details.assignmentId, status: "completed" });
      const report = await s.read("team_result", { assignmentId: start.details.assignmentId });
      expect(report.host).toMatchObject(bound ? {} : { planId: "planning", unitId: "reviewer-critique" });
      if (bound) { expect(report.host.planId).toBeUndefined(); expect(report.host.unitId).toBeUndefined(); }
      expect(report.object.selector).toEqual(request.object); expect(report.judgment.completion).toBe("complete");
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
      if (rejection === "incompatible-ledger") {
        expect(start.isError).toBe(true);
        expect(JSON.stringify(start.content)).toContain("hash");
        expect(s.branch.filter(entry => entry.customType === "pitako.worker.result")).toEqual([]);
      } else {
        expect(start.isError).not.toBe(true);
        await s.delivered.promise;
        const terminal = s.branch.filter(entry => entry.customType === "pitako.worker.result");
        expect(terminal).toHaveLength(1); expect(terminal[0].details.status).toBe("failed");
        const report = await s.read("team_result", { assignmentId: start.details.assignmentId });
        expect(report.host.failure).toContain("explicit Board topics require a bound watched plan");
      }
      expect(s.host.sessions).toEqual([]);
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
          expect(input.review).toBeUndefined(); expect(input.context.shared).toBeUndefined();
          expect(input.journal).toBeUndefined(); expect(input.snapshot).toBeUndefined();
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
    const store = new WorkflowState(s.root);
    try {
      const db = await openBoard(); let topic: number;
      try { topic = db.createTopic(s.root, { title: "Watched independent critique" }).id; db.claimTopic(s.root, topic, "planning"); } finally { db.close(); }
      const file = writePlan(s.root, "frozen", topic), frozen = readFileSync(file, "utf8");
      const opened = openExecutionPlan("planning", s.root, { createLedger: true });
      const historicalHolds = readLedgerTeamHolds(s.root, "planning", opened.binding);
      const start = await s.invoke("review_start", { ...request, plan: "planning", unit: "reviewer-critique" });
      expect(start.isError).not.toBe(true);
      await subordinate.promise;
      const held = () => {
        const attempt = store.get<AttemptRecord>("attempts", start.details.dispatchId)!;
        expect(attempt).toMatchObject({ assignmentId: start.details.assignmentId, instanceId: start.details.instanceId,
          watch: { planId: "planning", unitId: "reviewer-critique" } });
        expect(attempt.outcome).toBeUndefined();
        const resource = store.get<Resource>("resources", attempt.resource.resourceId);
        expect(resource).toMatchObject(attempt.resource);
        expect(resource!.effectReservation).toBeUndefined();
        expect(store.closureReceipt(attempt.resource)).toBeUndefined();
        expect(teamWorkerStatus(s.evaluation.token, start.details.instanceId)[0]?.closure.state).toBe("pending");
        expect(workerHandoff(start.details.instanceId)).toBeUndefined();
        expect(s.branch.filter(entry => entry.customType === "pitako.worker.result")).toEqual([]);
        expect(s.sent.filter(item => item.options.triggerTurn)).toHaveLength(0);
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
      expect(terminal[0].details).toMatchObject({ assignmentId: start.details.assignmentId, instanceId: start.details.instanceId, status });
      const report = await s.read("team_result", { assignmentId: start.details.assignmentId });
      expect(report.host).toMatchObject({ planId: "planning", unitId: "reviewer-critique", status });
      expect(report).toMatchObject({ protocol: "review", criteria: request.criteria,
        judgment: outcome === "failed" ? null : { completion: "complete", verdict: outcome } });
      expect(report.observations.launch).toBe(report.object.identity);
      expect(report.observations.final).toBe(outcome === "failed" ? null : report.object.identity);
      expect(report.findings).toHaveLength(outcome === "no-blockers" ? 0 : 1);
      if (outcome !== "no-blockers") expect(report.findings[0]).toMatchObject(finding);
      expect(report.missingValidSynthesis).toBe(outcome === "failed");
      await s.bookkeeping(start.details.instanceId);
      const settled = store.get<AttemptRecord>("attempts", start.details.dispatchId)!;
      expect(settled.outcome?.status).toBe(status);
      expect(store.verifyClosureReceipt(store.closureReceipt(settled.resource)!)).toBe(true);
      expect(teamWorkerStatus(s.evaluation.token, start.details.instanceId)[0]?.closure.state).toBe("released");
      // Historical parsing is a nonmutation check, never an activity or admission gate.
      expect(readLedgerTeamHolds(s.root, "planning", opened.binding)).toEqual(historicalHolds);
      expect(readFileSync(file, "utf8")).toBe(frozen);
      const after = await openBoard();
      try { expect(after.readTopic(s.root, topic).topic.status).toBe("open"); } finally { after.close(); }
      expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
      expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
      expect(await s.read("team_result", { assignmentId: start.details.assignmentId })).toEqual(report);
      expect(store.get<AttemptRecord>("attempts", start.details.dispatchId)?.outcome).toEqual(settled.outcome);
    } finally { store.close(); release(); await s.close(); }
  }));
}
