import { expect, test } from "bun:test";
import { architectureFixture, reviewResults } from "./fixtures/architecture.ts";
import { jsonBytes } from "../extensions/table/results.ts";
import { teamWorkerResult } from "../extensions/agent/background.ts";
import { writeFileSync } from "node:fs";
import path from "node:path";

const parse = (envelope: any) => JSON.parse(envelope.content[0].text);
const finding = { key: "dissent", materiality: "blocking", contract: "Preserve dissent", reference: "fixture:17",
  consequence: "Independent objection", basis: { kind: "failure", path: "fixture.ts", evidence: ["seeded dissent"] } };

for (const protocol of ["architecture", "review"] as const) {
  const f = architectureFixture(protocol);
  for (const large of [false, true]) test(`${protocol} vertical ${large ? "reference" : "inline"} preserves independent host facts`, f.fixture.ownedCase(`${protocol} vertical ${large}`, async () => {
    const giant = large ? "界😀\\\"\n".repeat(2000) : "bounded";
    let findingId = "";
    const s = await f.setup({ config: large ? f.configuration : "", prompt(session, request, body) {
      if (!large && request.stage === "composition") return { ...body, specialists: [] };
      if (!large && request.stage === "synthesis" && protocol === "review") return { ...body, summary: "ok" };
      if (!large) return;
      if (request.stage === "preparation") return { ...body,
        ...(protocol === "review" && session.model.id === "director" ? { findings: [finding] } : {}),
        doubts: session.model.id === "director" ? [{ question: "first question", purpose: "independent knowledge" }] : [] };
      if (request.stage === "consultation-plan") return { ...body, support: [{ role: "scout", brief: "Observe independently",
        doubtIds: request.context.doubts.map((d: any) => d.id), prerequisites: [] }] };
      if (request.stage === "consultation-response") return { kind: "consultation-response",
        doubtIds: request.context.request.doubtIds, answer: "seeded answer", evidence: ["seeded evidence"], limits: ["seeded limit"], doubts: [] };
      if (request.stage === "knowledge") return { ...body, resolutions: request.context.delegatedDoubtIds.map((id: string) => ({
        doubtId: id, status: "answered", answer: "observed", supportIds: [request.context.responses[0].id] })) };
      if (request.stage === "contribution") {
        if (session.model.id !== "director") throw new Error("seeded specialist failure");
        if (protocol === "review") findingId = reviewResults(request).findings[0].id;
        return { ...body, doubts: [{ question: "seeded pending question", purpose: "independent pending" }] };
      }
      if (request.stage === "synthesis") return protocol === "review" ? { ...body, completion: "partial", verdict: "changes-required",
        summary: giant, dispositions: [{ findingId, status: "upheld", reason: "seeded dissent retained", references: [findingId] }] }
        : { ...body, status: "partial", recommendation: giant, disagreements: ["seeded dissent"], pending: [] };
    } });
    try {
      const start = await s.invoke(`${protocol}_start`, protocol === "architecture" ? { goal: "Vertical fixture" } :
        { goal: "Vertical fixture", object: { kind: "brief", text: "Explore locally" }, criteria: ["Keep dissent"] });
      expect(start.isError).not.toBe(true); expect(jsonBytes(start)).toBeLessThanOrEqual(4096);
      await s.delivered.promise;
      const message = s.sent.find(item => item.message.customType === "pitako.worker.result")!.message;
      expect(jsonBytes(message)).toBeLessThanOrEqual(4096);
      const automatic = JSON.parse(message.content);
      expect(jsonBytes(automatic.header)).toBeLessThanOrEqual(2048);
      expect(automatic.header.complete).toBe(!large);
      let envelope = await s.invoke("team_result", { assignmentId: start.details.assignmentId, maxBytes: 4096 });
      let canonical = "";
      while (true) {
        expect(envelope.isError).not.toBe(true); expect(jsonBytes(envelope)).toBeLessThanOrEqual(4096);
        const page = parse(envelope); expect(jsonBytes(page.header)).toBeLessThanOrEqual(2048);
        canonical += page.fragment;
        if (!page.header.cursor) break;
        const replay = await s.invoke("team_result", { assignmentId: start.details.assignmentId, cursor: page.header.cursor });
        expect(replay).toEqual(await s.invoke("team_result", { assignmentId: start.details.assignmentId, cursor: page.header.cursor }));
        envelope = replay;
      }
      const report = JSON.parse(canonical);
      expect(report.protocol).toBe(protocol); expect(report.judgment).not.toBeNull();
      expect(report.host.closure).toEqual({ state: "released" });
      if (large) {
        expect(JSON.stringify(report.failures)).toContain("no valid settled submit");
        expect(report.limits).toContain("seeded limit");
        expect(report.pending[0].question).toBe("seeded pending question");
        expect(protocol === "review" ? report.findings[0].consequence : report.judgment.disagreements[0])
          .toBe(protocol === "review" ? "Independent objection" : "seeded dissent");
        expect(protocol === "review" ? report.judgment.synthesis.summary : report.judgment.recommendation).toBe(giant);
      } else expect(automatic.report).toEqual(report);
      // Canonical re-read, not reserialization of a stripped/mutated envelope.
      let full = "", page = parse(await s.invoke("team_result", { assignmentId: start.details.assignmentId }));
      while (true) {
        full += page.fragment; if (!page.header.cursor) break;
        page = parse(await s.invoke("team_result", { assignmentId: start.details.assignmentId, cursor: page.header.cursor }));
      }
      expect(Buffer.from(full)).toEqual(Buffer.from(canonical));
      expect(teamWorkerResult(s.evaluation.token, start.details.instanceId).status).toBe(large ? "failed" : "completed");
    } finally { await s.close(); }
  }));

  test(`${protocol} diagnostic cuts isolate rooms and terminal results, including giant start/control data`, f.fixture.ownedCase(`${protocol} cuts`, async () => {
    const giant = "界😀\\\"\n".repeat(3000);
    const secondEntered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.fixture.finishOnCleanup(release.resolve);
    let syntheses = 0, closed = false;
    const s = await f.setup({ config: `[${protocol}]\ncandidates = []\n[[${protocol}.topics]]\ntopic = ${JSON.stringify(giant)}\ncandidates = []\n`,
      async prompt(_session, request, body) {
      if (request.stage === "composition") return { ...body, specialists: [] };
      if (request.stage === "synthesis") {
        if (++syntheses === 2) { secondEntered.resolve(); await release.promise; }
        return protocol === "architecture" ? { ...body, recommendation: giant } : { ...body, summary: giant };
      }
    } });
    const start = () => s.invoke(`${protocol}_start`, protocol === "architecture" ? { goal: giant } :
      { goal: giant, object: { kind: "brief", text: giant }, criteria: [giant] });
    try {
      const first = await start(); expect(jsonBytes(first)).toBeLessThanOrEqual(4096);
      await s.delivered.promise;
      const target = { roomId: first.details.roomId };
      const oldCut = parse(await s.invoke(`${protocol}_read`, { ...target, maxBytes: 4096 }));
      const resultTarget = { assignmentId: first.details.assignmentId };
      const resultPage = parse(await s.invoke("team_result", { ...resultTarget, maxBytes: 4096 }));
      expect(typeof oldCut.header.cursor).toBe("string");
      expect(typeof resultPage.header.cursor).toBe("string");
      const second = await start(); await secondEntered.promise;
      const otherTarget = { roomId: second.details.roomId };
      const otherCut = parse(await s.invoke(`${protocol}_read`, { ...otherTarget, maxBytes: 4096 }));
      const replay = await s.invoke(`${protocol}_read`, { ...otherTarget, cursor: otherCut.header.cursor });
      const replacement = await s.invoke(`${protocol}_read`, { ...target, maxBytes: 4096 });
      expect(jsonBytes(replacement)).toBeLessThanOrEqual(4096);
      const diagnostic = await s.read(`${protocol}_read`, target, replacement);
      expect(diagnostic.snapshot.topics[0].topic).toBe(giant.trim().replace(/\s+/g, " "));
      expect(diagnostic.members.some((member: any) => member.task === giant)).toBe(true);
      expect(await s.invoke(`${protocol}_read`, { ...otherTarget, cursor: otherCut.header.cursor })).toEqual(replay);
      const resultReplay = await s.invoke("team_result", { ...resultTarget, cursor: resultPage.header.cursor });
      expect(resultReplay.isError).not.toBe(true);
      for (const [name, params] of [
        [`${protocol}_read`, { ...target, cursor: oldCut.header.cursor }],
        [`${protocol}_read`, { ...target, cursor: otherCut.header.cursor }],
        ["team_result", { ...resultTarget, cursor: oldCut.header.cursor }],
        ["team_result", { ...resultTarget, cursor: giant }],
        ["team_result", { ...resultTarget, section: "not-a-section" }],
        ["team_result", { ...resultTarget, maxBytes: 16385 }],
        ["team_result", { ...resultTarget, cursor: resultPage.header.cursor, maxBytes: 4096 }],
        ["team_result", { assignmentId: giant, cursor: resultPage.header.cursor }],
        [`${protocol}_control`, { ...target, action: "context", text: giant }],
        [`${protocol}_read`, { roomId: giant }],
      ] as const) {
        const error = await s.invoke(name, params);
        expect(error.isError).toBe(true); expect(jsonBytes(error)).toBeLessThanOrEqual(4096);
        expect(error.details).toEqual({ table: true });
        expect(parse(error).error).toBe("table_request_failed");
      }
      const control = await s.invoke(`${protocol}_control`, { ...otherTarget, action: "context", text: giant });
      expect(control.isError).not.toBe(true); expect(jsonBytes(control)).toBeLessThanOrEqual(4096);
      const status = await s.invoke("team_status", {});
      const roots = status.details.members.filter((member: any) => member.resultId);
      expect(roots).toHaveLength(2);
      for (const root of roots) {
        expect(jsonBytes(root)).toBeLessThanOrEqual(4096);
        expect(JSON.stringify(root)).not.toContain(giant);
      }
      release.resolve(); await s.close(); closed = true;
      const retired = await s.invoke(`${protocol}_read`, { ...target, cursor: parse(replacement).header.cursor });
      expect(retired.isError).toBe(true); expect(jsonBytes(retired)).toBeLessThanOrEqual(4096);
      const retiredResult = await s.invoke("team_result", { ...resultTarget, cursor: resultPage.header.cursor });
      expect(retiredResult.isError).toBe(true); expect(jsonBytes(retiredResult)).toBeLessThanOrEqual(4096);
      expect(retiredResult.details).toEqual({ table: true });
      expect(parse(retiredResult).error).toBe("table_request_failed");
    } finally { release.resolve(); if (!closed) await s.close(); }
  }));

  test(`${protocol} pre-reservation model diagnostics cannot echo unlimited input`, f.fixture.ownedCase(`${protocol} bounded admission`, async () => {
    const role = protocol === "architecture" ? "architect" : "reviewer";
    const s = await f.setup({ config: "" });
    try {
      writeFileSync(path.join(s.root, "pitako/config.toml"), `[model_policies.${role}]\nprimary = { model = "${"界".repeat(10000)}" }\n`);
      const error = await s.invoke(`${protocol}_start`, protocol === "architecture" ? { goal: "diagnose admission" } :
        { goal: "diagnose admission", object: { kind: "brief", text: "local" }, criteria: ["independent"] });
      expect(error.isError).toBe(true); expect(jsonBytes(error)).toBeLessThanOrEqual(4096);
      expect(s.host.sessions).toHaveLength(0);
    } finally { await s.close(); }
  }));
}
