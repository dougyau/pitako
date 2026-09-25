import assert from "node:assert/strict";
import registerPitako, { type PitakoExtensionAPI } from "./src/index.ts";
import { sessionDisplayName } from "./src/session-name.ts";

type HookEvent = { prompt?: string; entries?: readonly unknown[] };
type Hook = (event: HookEvent) => void;

function harness(current: string | undefined) {
  const hooks = new Map<string, Hook>();
  const commands = new Map<string, (args: string) => void>();
  const setNames: string[] = [];
  let name = current;
  const api: PitakoExtensionAPI = {
    on(event, handler) {
      hooks.set(event, handler);
    },
    registerCommand(command, definition) {
      commands.set(command, definition.handler);
    },
    getSessionName() {
      return name;
    },
    setSessionName(value) {
      setNames.push(value);
      name = value || undefined;
    },
  };
  registerPitako(api);
  return {
    emit(event: string, value: HookEvent = {}) {
      hooks.get(event)?.(value);
    },
    command(value: string) {
      commands.get("pitako")?.(value);
    },
    get name() {
      return name;
    },
    setNames,
  };
}

const message = (content: unknown) => ({ type: "message", message: { role: "user", content } });

const restored = harness("pitako:coding");
restored.emit("session_start", {
  entries: [message([{ type: "text", text: "  Repair   session names\nDetails follow" }])],
});
assert.equal(restored.name, "Repair session names");

const pending = harness("pitako:analysis");
pending.emit("before_agent_start", { prompt: "  Normalize   session names\nMore detail" });
assert.equal(pending.name, "Normalize session names");

const custom = harness("Manual title");
custom.emit("before_agent_start", { prompt: "Different task" });
custom.command("profile analysis");
assert.equal(custom.name, "Manual title");
assert.deepEqual(custom.setNames, []);

assert.equal(sessionDisplayName("\n  First   useful   line \nsecond"), "First useful line");
assert.equal(sessionDisplayName("x".repeat(61)), "x".repeat(60));
assert.equal(sessionDisplayName("Pitako worker developer-ab12cd completed"), undefined);
console.log("functional acceptance passed: 4 checks");
