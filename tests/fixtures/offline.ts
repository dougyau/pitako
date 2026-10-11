import { afterAll, beforeAll, spyOn } from "bun:test";
import * as codex from "../../extensions/codex.ts";

// The calling file owns its stub and hooks; this module owns no shared mock.
// Pitako's handlers still run, but not the external factory or official tools.
export function stubExternalFactories(): void {
  let registration: ReturnType<typeof spyOn>;
  beforeAll(() => {
    registration = spyOn(codex, "registerCodexTools").mockImplementation(pi => {
      pi.registerTool({ name: "apply_patch", description: "controlled external tool", parameters: {} } as never);
      return async () => {};
    });
  });
  afterAll(() => registration.mockRestore());
}
