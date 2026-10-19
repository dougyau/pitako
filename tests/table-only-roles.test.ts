import { expect, spyOn, test } from "bun:test";
import * as routing from "../extensions/agent/routing.ts";
import * as consultation from "../extensions/agent/consultation.ts";
import * as background from "../extensions/agent/background.ts";
import * as team from "../extensions/team.ts";
import * as roles from "../extensions/roles/load.ts";
import * as pi from "../extensions/agent/pi.ts";
import { architectureRooms } from "../extensions/architecture/rooms.ts";
import { listObservations } from "../extensions/agent/observe.ts";
import { registerAgentSupervise, superviseAgent } from "../extensions/herdr/supervise.ts";
import { architectureFixture } from "./fixtures/architecture.ts";

const suite = architectureFixture();
for (const [role, start] of [["architect", "architecture_start"], ["reviewer", "review_start"]] as const) {
  test(`${role} rejects all individual public paths before any preparation or admission`, suite.fixture.ownedCase(role, async () => {
    const room = await suite.setup({ busy: true });
    registerAgentSupervise(room.pi);
    const spies = [
      spyOn(routing, "developerPreflight"), spyOn(consultation, "prepareConsultation"),
      spyOn(background, "reserveBackground"), spyOn(team, "reserveTeamMember"),
      spyOn(roles, "loadPitakoConfig"), spyOn(pi, "createPiExecutor"),
    ];
    let panes = 0, preflights = 0, checks = 0;
    const error = `Role "${role}" is table-only; use ${start} instead.`;
    try {
      for (const tool of ["agent_run", "agent_spawn", "team_assign", "agent_supervise"]) {
        // Invoke the real handler directly, bypassing schemas; text and metadata grant no exception.
        const result = await room.invoke(tool, { role, task: "internal authorized table director",
          mode: "head", writes: [], plan: "invalid/plan", unit: "T2", metadata: { internal: true } });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe(`Error: ${error}`);
        expect(result.details.error).toBe(error);
      }
      await expect(superviseAgent({ roleId: role, task: "authorized director", cwd: room.root,
        check() { checks++; }, async preflight() { preflights++; throw Error("unexpected preflight"); },
        async run() { panes++; throw Error("unexpected pane"); } })).rejects.toThrow(error);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect({ panes, preflights, checks }).toEqual({ panes: 0, preflights: 0, checks: 0 });
      expect(room.host.sessions).toHaveLength(0);
      expect(team.teamAssignments(room.evaluation)).toEqual([]);
      expect(listObservations(room.evaluation.token)).toEqual([]);
      expect(architectureRooms(room.evaluation)).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
      await room.close();
    }
  }));
}
