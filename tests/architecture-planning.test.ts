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

const { fixture, setup } = architectureFixture();
const deferred = () => Promise.withResolvers<void>();
function writePlan(root: string, status: "draft" | "frozen", topic?: number) {
  const file = planFile("planning", root); mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nid: planning\nrevision: 1\nstatus: ${status}\n${topic === undefined ? "" : `board_topic_id: ${topic}\n`}---\nCurrent design and unit partition/order.\n`);
  return file;
}

  for (const bound of [false, true]) {
    test(`table starts a ${bound ? "bound uncorrelated" : "prospectively correlated unbound"} draft without a ledger or Board binding`, fixture.ownedCase("planning draft", async () => {
      const s = await setup();
      try {
        const db = await openBoard();
        let topic: number, before: Topic;
        try {
          topic = db.createTopic(s.root, { title: "Existing planning discussion" }).id;
          if (bound) db.claimTopic(s.root, topic, "planning");
          before = db.readTopic(s.root, topic).topic;
        } finally { db.close(); }
        const file = writePlan(s.root, "draft", bound ? topic : undefined), draft = readFileSync(file, "utf8");
        const start = await s.invoke("architecture_start", { goal: "Design-only current-object judgment including unit partition/order; ignore ## Planning workers", ...(bound ? {} : { plan: "planning", unit: "architect-pass" }) });
        expect(start.isError).not.toBe(true);
        await s.delivered.promise;
        const terminal = s.branch.filter(entry => entry.customType === "pitako.worker.result");
        expect(terminal).toHaveLength(1);
        expect(terminal[0].details).toMatchObject({ assignmentId: start.details.assignmentId, status: "completed" });
        const report = await s.read("team_result", { assignmentId: start.details.assignmentId });
        expect(report.host).toMatchObject(bound ? {} : { planId: "planning", unitId: "architect-pass" });
        expect(existsSync(ledgerFile("planning", s.root))).toBe(false);
        expect(readFileSync(file, "utf8")).toBe(draft);
        const after = await openBoard();
        try { expect(after.readTopic(s.root, topic).topic).toEqual(before); } finally { after.close(); }
        const root = teamAssignments(s.evaluation).find(assignment => assignment.id === start.details.assignmentId)!;
        expect(root.boardTopicId).toBeUndefined(); expect(root.execution).toBeUndefined();
        expect(s.host.sessions.every(session => session.events.includes("dispose"))).toBe(true);
      } finally { await s.close(); }
    }));
  }

  for (const rejection of ["bound-topic-bypass", "incompatible-ledger"] as const) {
    test(`table rejects ${rejection} before participants start or watched state changes`, fixture.ownedCase("planning admission rejection", async () => {
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
          writeFileSync(file, readFileSync(file, "utf8") + "Changed consulted object.\n");
        }
        const draft = readFileSync(file, "utf8");
        const start = await s.invoke("architecture_start", { goal: "Design-only judgment", ...(rejection === "bound-topic-bypass" ? { boardTopicId: String(topic) } : { plan: "planning", unit: "architect-pass" }) });
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

  for (const outcome of ["complete", "partial", "failed", "cancelled"] as const) {
    test(`table watches only its root and preserves ${outcome} terminal reconciliation after closure`, fixture.ownedCase("planning watched judgment", async () => {
      const synthesizing = deferred(), releaseSynthesis = deferred(), disposing = deferred(), releaseDispose = deferred();
      const release = () => { releaseSynthesis.resolve(); releaseDispose.resolve(); }; fixture.finishOnCleanup(release);
      const s = await setup({ async prompt(_session, request, body) {
        if (request.stage === "synthesis") {
          synthesizing.resolve(); await releaseSynthesis.promise;
          if (outcome === "failed") return false; // no valid current-object judgment submitted
          return { ...body, status: outcome === "partial" ? "partial" : "complete", recommendation: "Current-object judgment: keep coupled units together", pending: outcome === "partial" ? ["Unresolved boundary"] : [] };
        }
      }, async dispose(session) {
        if (session.model?.id === "director") { disposing.resolve(); await releaseDispose.promise; }
      } });
      const store = new WorkflowState(s.root);
      try {
        const db = await openBoard(); let topic: number;
        try { topic = db.createTopic(s.root, { title: "Watched planning judgment" }).id; db.claimTopic(s.root, topic, "planning"); } finally { db.close(); }
        const file = writePlan(s.root, "frozen", topic), frozen = readFileSync(file, "utf8");
        const opened = openExecutionPlan("planning", s.root, { createLedger: true });
        const historicalHolds = readLedgerTeamHolds(s.root, "planning", opened.binding);
        const start = await s.invoke("architecture_start", { goal: "Design-only current-object judgment including unit partition/order", plan: "planning", unit: "architect-pass" });
        expect(start.isError).not.toBe(true);
        await synthesizing.promise;
        const held = () => {
          const attempt = store.get<AttemptRecord>("attempts", start.details.dispatchId)!;
          expect(attempt).toMatchObject({ assignmentId: start.details.assignmentId, instanceId: start.details.instanceId,
            watch: { planId: "planning", unitId: "architect-pass" } });
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
        const members = (await s.invoke("team_status", {})).details.members.filter((member: any) => member.teamId === start.details.roomId);
        expect(members).toHaveLength(2); // one actual Architect root and one internal Architect specialist
         expect(members.map((member: any) => member.role).sort()).toEqual(["architect", "architecture"]);
        expect(members.filter((member: any) => member.assignmentId === start.details.assignmentId)).toHaveLength(1);
        const boundary = await s.emit("agent_before_settle", { outcome: "completed", context: { canContinue: true } });
        expect((boundary?.entries ?? []).filter((entry: any) => entry.customType === "pitako.worker.result")).toEqual([]);
        held(); // a settled internal member cannot close the root resource
        if (outcome === "cancelled") expect((await s.invoke("team_cancel", { assignmentId: start.details.assignmentId })).isError).not.toBe(true);
        releaseSynthesis.resolve(); await disposing.promise;
        held(); // even a complete synthesis is not terminal before root disposal
        releaseDispose.resolve(); await s.delivered.promise;
        const status = outcome === "complete" ? "completed" : outcome === "cancelled" ? "cancelled" : "failed";
        const terminal = s.branch.filter(entry => entry.customType === "pitako.worker.result");
        expect(terminal).toHaveLength(1);
         expect(terminal[0].details).toMatchObject({ assignmentId: start.details.assignmentId, instanceId: start.details.instanceId, status });
         const report = await s.read("team_result", { assignmentId: start.details.assignmentId });
         expect(report.host).toMatchObject({ planId: "planning", unitId: "architect-pass", status });
         if (outcome === "failed") {
           expect(report.judgment).toBeNull();
           expect(report.host.failure).toContain("architecture protocol failed: no valid settled submit");
           const diagnostic = await s.read("architecture_read", { roomId: start.details.roomId, section: "host" });
           expect(diagnostic.failure).toBe(report.host.failure);
         }
         else if (outcome === "cancelled") expect(report.judgment).toBeNull();
         else expect(report.judgment.recommendation).toBe("Current-object judgment: keep coupled units together");
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
        expect(workerHandoff(start.details.instanceId)).toMatchObject({ bookkeeping: "reconciled", delivery: "incorporated" });
        await s.emit("turn_start");
        expect(workerHandoff(start.details.instanceId)?.continuation).toBe("observed");
        await s.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
        const diagnostic = await s.read("team_result", { assignmentId: start.details.assignmentId });
        expect(diagnostic.host.status).toBe(status); // optional re-read does not transport, acknowledge or accept
        expect(store.get<AttemptRecord>("attempts", start.details.dispatchId)?.outcome).toEqual(settled.outcome);
        expect(diagnostic).toEqual(report);
        expect(s.sent.filter(item => item.message.customType === "pitako.worker.result")).toHaveLength(1);
      } finally { store.close(); release(); await s.close(); }
    }));
  }
