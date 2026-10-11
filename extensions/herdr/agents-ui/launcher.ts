import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { HerdrPresence } from "../presence.ts";
import { descriptorEnv } from "./protocol.ts";

const execute = promisify(execFile);
export type AgentPane = { paneId: string; focus(): Promise<void>; close(): Promise<void> };

/** Capture presence in the Pi caller, never from the newly launched panel or current focus. */
export async function openAgentPane(input: {
  presence: HerdrPresence;
  descriptorPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AgentPane> {
  const { presence } = input;
  if (!presence.present || !presence.paneId || !presence.socketPath || !path.isAbsolute(presence.socketPath)) {
    throw new Error("Agent pane requires a Herdr caller and its exact socket; Pitako will not start Herdr");
  }
  if (!path.isAbsolute(input.descriptorPath) || !path.isAbsolute(input.cwd)) {
    throw new Error("Agent pane requires absolute descriptor and working-directory paths");
  }
  const env: NodeJS.ProcessEnv = { ...(input.env ?? process.env), HERDR_ENV: "1", HERDR_SOCKET_PATH: presence.socketPath,
    HERDR_PANE_ID: presence.paneId };
  // A socket captured in Pi is authoritative; a saved/inherited session selector is not.
  delete env.HERDR_SESSION;
  async function run(args: string[], allowAlreadyClosed = false): Promise<unknown> {
    let stdout: string;
    try {
      ({ stdout } = await execute(env.HERDR_BIN_PATH || "herdr", args,
        { cwd: input.cwd, env, timeout: 10_000, maxBuffer: 64 * 1024 }));
    } catch (error) {
      // A graceful screen exit has already removed this exact returned panel.
      // No scanning/focus rediscovery, and every other failure remains actionable.
      if (allowAlreadyClosed && error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
        let body: unknown;
        try { body = JSON.parse(error.stderr); } catch { /* Not a Herdr protocol error. */ }
        if (body && typeof body === "object" && "error" in body && body.error &&
            typeof body.error === "object" && "code" in body.error && body.error.code === "plugin_pane_not_found") return;
      }
      throw error;
    }
    const body: unknown = JSON.parse(stdout);
    if (!body || typeof body !== "object" || "error" in body || !("result" in body)) {
      throw new Error("Herdr returned an invalid agent pane response");
    }
    return body.result;
  }
  await run(["pane", "get", presence.paneId]);
  const result = await run(["plugin", "pane", "open", "--plugin", "pitako.agents-ui", "--entrypoint", "agents",
    "--placement", "split", "--target-pane", presence.paneId, "--direction", "right", "--no-focus",
    "--cwd", input.cwd, "--env", `${descriptorEnv}=${input.descriptorPath}`]);
  if (!result || typeof result !== "object" || !("plugin_pane" in result) || !result.plugin_pane ||
      typeof result.plugin_pane !== "object" || !("pane" in result.plugin_pane) || !result.plugin_pane.pane ||
      typeof result.plugin_pane.pane !== "object" || !("pane_id" in result.plugin_pane.pane) ||
      typeof result.plugin_pane.pane.pane_id !== "string" || !result.plugin_pane.pane.pane_id) {
    throw new Error("Herdr did not return the opened agent panel ID");
  }
  const paneId = result.plugin_pane.pane.pane_id;
  return { paneId,
    async focus() { await run(["plugin", "pane", "focus", paneId]); },
    async close() { await run(["plugin", "pane", "close", paneId], true); },
  };
}
