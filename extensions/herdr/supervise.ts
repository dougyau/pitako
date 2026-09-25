import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createInstanceId } from "../agent/run.ts";
import { currentInstanceId } from "../agent/scope.ts";
import { PitakoConfigError } from "../errors.ts";
import { loadPitakoConfig, resolveRoleFromConfig, type LoadOptions } from "../roles/load.ts";
import type { ResolvedRole } from "../roles/types.ts";
import { ORCHESTRATION_TOOLS } from "../profile.ts";
import { piIntegrationCurrent, readHerdrPresence } from "./presence.ts";

/** CLI seam. Not an AgentRuntime. */
export type HerdrCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type HerdrRunner = (
  args: readonly string[],
  options: { cwd: string; signal?: AbortSignal },
) => Promise<HerdrCommandResult>;

export type SuperviseResult = {
  instanceId: string;
  paneId: string;
  agent_status: string;
  excerpt?: string;
};

const noExtra = { additionalProperties: false } as const;
const OPEN_START = new Set(["agent_not_ready", "timeout"]);
const READ_STATUS = new Set(["blocked", "agent_blocked"]);

// ponytail: one in-flight supervise call per process. A queue belongs in a later scheduler.
let inFlight = false;

export async function superviseAgent(input: {
  roleId: string;
  task: string;
  cwd: string;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  load?: LoadOptions;
  run?: HerdrRunner;
}): Promise<SuperviseResult> {
  if (inFlight) throw new Error("agent_supervise is already in flight");
  inFlight = true;
  try {
    return await superviseOnce(input);
  } finally {
    inFlight = false;
  }
}

async function superviseOnce(input: {
  roleId: string;
  task: string;
  cwd: string;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  load?: LoadOptions;
  run?: HerdrRunner;
}): Promise<SuperviseResult> {
  const env = input.env ?? process.env;
  const run = input.run ?? defaultRun;
  const signal = input.signal;
  throwIfAborted(signal);
  if (currentInstanceId() || env.PITAKO_INSTANCE_ID) {
    throw new Error("agent_supervise cannot be called from a child agent");
  }
  const task = input.task.trim();
  if (task.length === 0) throw new PitakoConfigError("agent_supervise task must not be empty");

  const presence = readHerdrPresence(env);
  if (!presence.present || !presence.paneId) {
    throw new Error("agent_supervise requires Herdr presence (HERDR_ENV=1, HERDR_PANE_ID, and HERDR_SOCKET_PATH)");
  }

  const integration = await exec(run, ["integration", "status"], input.cwd, signal);
  if (integration.code !== 0 || !piIntegrationCurrent(`${integration.stdout}\n${integration.stderr}`)) {
    throw new Error("Pi integration is not current. Install it with `herdr integration install pi`. Pitako will not install it.");
  }

  const status = await exec(run, ["status", "--json"], input.cwd, signal);
  if (status.code !== 0 || !serverReady(status.stdout)) {
    throw new Error("herdr server is not running or not endpoint-compatible. Stop. Do not upgrade or restart.");
  }

  const role = resolveRoleFromConfig(loadPitakoConfig(input.load), input.roleId);
  if (!role.modelPolicy.primary) {
    throw new PitakoConfigError(role.modelPolicy.diagnostic ?? `model policy "${role.modelPolicyId}" has no primary target`);
  }
  const target = role.modelPolicy.primary;
  if (target.fast === true) {
    throw new PitakoConfigError(`fast mode is not supported by agent_supervise for primary target "${target.model}"`);
  }
  const instanceId = createInstanceId(role.id);

  const layout = await exec(run, ["pane", "layout", "--pane", presence.paneId], input.cwd, signal);
  if (layout.code !== 0) throw new Error(commandError("pane layout", layout));
  const size = paneSize(layout.stdout, presence.paneId);
  const direction = size.width >= size.height ? "right" : "down";

  const split = await exec(run, [
    "pane",
    "split",
    "--current",
    "--direction",
    direction,
    "--cwd",
    input.cwd,
    "--no-focus",
    "--env",
    `PITAKO_INSTANCE_ID=${instanceId}`,
    "--env",
    `PITAKO_ROLE_ID=${role.id}`,
  ], input.cwd, signal);
  if (split.code !== 0) throw new Error(commandError("pane split", split));
  let paneId: string | undefined = paneIdFromSplit(split.stdout);
  let live = false;
  try {
    const startArgs = ["agent", "start", instanceId, "--kind", "pi", "--pane", paneId, "--", "--model", target.model];
    if (target.reasoning) startArgs.push("--thinking", target.reasoning);
    startArgs.push("--no-approve", "--append-system-prompt", preamble(role, instanceId), "--exclude-tools", ORCHESTRATION_TOOLS.join(","));
    const start = await exec(run, startArgs, input.cwd, signal);
    const startFailure = failureCode(start);
    if (startFailure) {
      if (OPEN_START.has(startFailure)) return { instanceId, paneId, agent_status: startFailure };
      await closeQuiet(run, paneId, input.cwd);
      paneId = undefined;
      throw new Error(`herdr agent start failed: ${startFailure}`);
    }
    live = true;

    const prompt = await exec(run, ["agent", "prompt", instanceId, task, "--wait"], input.cwd, signal);
    const agent_status = agentStatusFrom(prompt.stdout) ?? failureCode(prompt) ?? "unknown";
    let excerpt: string | undefined;
    if (READ_STATUS.has(agent_status)) {
      const read = await exec(run, ["agent", "read", instanceId, "--source", "recent-unwrapped", "--lines", "40"], input.cwd, signal);
      excerpt = read.stdout;
    }
    return excerpt === undefined
      ? { instanceId, paneId, agent_status }
      : { instanceId, paneId, agent_status, excerpt };
  } catch (error) {
    if (paneId && signal?.aborted) {
      await abortClose(run, instanceId, paneId, input.cwd);
      throw new Error("agent_supervise cancelled");
    }
    if (paneId && !live) await closeQuiet(run, paneId, input.cwd);
    throw error;
  }
}

export function registerAgentSupervise(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent_supervise",
    label: "Supervise agent",
    description:
      "Open one visible Herdr sibling Pi pane, submit one task, and return the instance id, pane id, and Herdr status. Requires Herdr presence and a current Pi integration. Does not fall back to agent_run.",
    promptSnippet: "Supervise one role in a visible Herdr pane",
    promptGuidelines: [
      "Use agent_supervise only inside Herdr when a visible pane is required. If it fails, report the error. Do not fall back to agent_run or do that role's work yourself.",
    ],
    parameters: Type.Object(
      {
        role: Type.String({ description: "Role id, for example developer" }),
        task: Type.String({ description: "Task for the supervised agent" }),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await superviseAgent({ roleId: params.role, task: params.task, cwd: ctx.cwd, signal });
        const settled = result.agent_status === "idle" || result.agent_status === "done" || READ_STATUS.has(result.agent_status);
        return {
          content: [{ type: "text" as const, text: formatSuperviseResult(result) }],
          details: result,
          isError: !settled,
        };
      } catch (error) {
        const message = error instanceof PitakoConfigError || error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
}

function preamble(role: ResolvedRole, instanceId: string): string {
  return [
    `You are Pitako role ${role.id}, instance ${instanceId}, in a visible Herdr pane.`,
    "Your conversation is private. Do not assume you saw the parent session.",
    "Do not spawn other agents. agent_run, agent_supervise, agent_spawn, agent_status, agent_result, and agent_cancel are not available.",
    "Publish shared findings on the Board. Board contents are not injected here.",
    "Your rpiv-todo list is private to this session.",
    "The model and reasoning for this run come from this role's ModelPolicy, not from the parent session.",
    "",
    role.instructions,
  ].join("\n");
}

function formatSuperviseResult(result: SuperviseResult): string {
  const lines = [
    `instance_id: ${result.instanceId}`,
    `pane_id: ${result.paneId}`,
    `agent_status: ${result.agent_status}`,
  ];
  if (result.excerpt) lines.push("", result.excerpt);
  return lines.join("\n");
}

function defaultRun(args: readonly string[], options: { cwd: string; signal?: AbortSignal }): Promise<HerdrCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("herdr", [...args], { cwd: options.cwd, signal: options.signal });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
  });
}

async function exec(
  run: HerdrRunner,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<HerdrCommandResult> {
  throwIfAborted(signal);
  const result = await run(args, { cwd, signal });
  throwIfAborted(signal);
  return result;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("agent_supervise cancelled");
}

async function abortClose(run: HerdrRunner, instanceId: string, paneId: string, cwd: string): Promise<void> {
  try {
    await run(["agent", "send-keys", instanceId, "ctrl+c"], { cwd });
  } catch {
    // Still close the pane this call created.
  }
  await closeQuiet(run, paneId, cwd);
}

async function closeQuiet(run: HerdrRunner, paneId: string, cwd: string): Promise<void> {
  try {
    await run(["pane", "close", paneId], { cwd });
  } catch {
    // The pane may already be gone.
  }
}

function serverReady(stdout: string): boolean {
  const body = json(stdout);
  if (!isRecord(body) || !isRecord(body.server)) return false;
  return body.server.running === true && body.server.endpoint_compatible === true;
}

function paneSize(stdout: string, paneId: string): { width: number; height: number } {
  const body = json(stdout);
  const layout = isRecord(body) && isRecord(body.result) && isRecord(body.result.layout) ? body.result.layout : undefined;
  const panes = layout && Array.isArray(layout.panes) ? layout.panes : [];
  const match = panes.find((pane) => isRecord(pane) && pane.pane_id === paneId);
  const rect = isRecord(match) && isRecord(match.rect) ? match.rect : layout && isRecord(layout.area) ? layout.area : undefined;
  if (!isRecord(rect) || typeof rect.width !== "number" || typeof rect.height !== "number") {
    throw new Error("herdr pane layout did not include width and height");
  }
  return { width: rect.width, height: rect.height };
}

function paneIdFromSplit(stdout: string): string {
  const body = json(stdout);
  const pane = isRecord(body) && isRecord(body.result) ? body.result.pane : undefined;
  if (!isRecord(pane) || typeof pane.pane_id !== "string" || pane.pane_id.length === 0) {
    throw new Error("herdr pane split did not return a pane id");
  }
  return pane.pane_id;
}

function agentStatusFrom(stdout: string): string | undefined {
  const body = json(stdout);
  if (!isRecord(body)) return undefined;
  const result = isRecord(body.result) ? body.result : body;
  if (typeof result.agent_status === "string") return result.agent_status;
  if (isRecord(result.agent) && typeof result.agent.agent_status === "string") return result.agent.agent_status;
  const data = isRecord(result.event) && isRecord(result.event.data) ? result.event.data : undefined;
  if (data && typeof data.agent_status === "string") return data.agent_status;
  return undefined;
}

function failureCode(result: HerdrCommandResult): string | undefined {
  const body = json(result.stdout) ?? json(result.stderr);
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") return body.error.code;
  if (result.code === 0) return undefined;
  const text = `${result.stdout}\n${result.stderr}`;
  if (text.includes("agent_not_ready")) return "agent_not_ready";
  if (text.includes("agent_prompt_stalled")) return "agent_prompt_stalled";
  if (text.includes("agent_blocked")) return "agent_blocked";
  if (text.includes("timed out") || text.includes("timeout")) return "timeout";
  return "failed";
}

function commandError(command: string, result: HerdrCommandResult): string {
  const code = failureCode(result) ?? "failed";
  return `herdr ${command} failed: ${code}`;
}

function json(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
