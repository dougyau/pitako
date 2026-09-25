import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { extensionPaths, loadPitako } from "../../../scripts/load-pitako.ts";
import { packageRoot } from "../../../extensions/stack.ts";

type Arm = "baseline" | "patch";
type Manifest = {
  fixture: string;
  files: string[];
  writableFiles: string[];
  sha256: Record<string, string>;
};
type ToolEvent = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
};

const template = path.dirname(fileURLToPath(import.meta.url));
const repo = await realpath(process.cwd());
const templateRepo = await realpath(path.resolve(template, "../../.."));
if (repo !== templateRepo) throw new Error("Dogfood runner must be started from its fixture's worktree root");
const manifestPath = path.join(template, "fixture-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
const armRoot = path.join(repo, ".pitako", "dogfood", "fixture");
const evidencePath = path.join(repo, ".pitako", "runs", "apply-patch-mutation", "evidence", "T4", "dogfood.json");
const workBriefPath = path.join(template, "WORKBRIEF.md");
const roleInstructions = await readFile(path.join(repo, "roles", "developer.md"), "utf8");
const roleInstructionsHash = hash(roleInstructions);
const workBriefHash = manifest.sha256["WORKBRIEF.md"]!;
const manifestHash = hash(await readFile(manifestPath));
const fixtureHash = await hashFiles(template, manifest.files);
const piPackage = JSON.parse(await readFile(path.join(repo, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")) as { version: string };
const bunVersion = await commandOutput(["bun", "--version"], repo);
const packagePiCliVersion = await commandOutput([path.join(repo, "node_modules/.bin/pi"), "--version"], repo);
const hostPiCliVersion = await commandOutput([path.join(process.env.HOME ?? homedir(), ".bun", "bin", "pi"), "--version"], repo);
const head = await commandOutput(["git", "rev-parse", "HEAD"], repo);
const implementationFiles = ["extensions/apply-patch.ts", "extensions/agent/effects.ts", "extensions/agent/index.ts", "extensions/agent/run.ts", "extensions/index.ts", "extensions/profile.ts", "package.json", "bun.lock", "tests/apply-patch.test.ts", "tests/apply-patch-pi.test.ts", "tests/codex-contract.test.ts"];
const implementationSnapshotHash = await hashFiles(repo, implementationFiles);

for (const file of manifest.files) {
  const expected = manifest.sha256[file];
  if (!expected || hash(await readFile(path.join(template, file))) !== expected) {
    throw new Error(`Frozen fixture hash mismatch: ${file}`);
  }
}

const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const model = runtime.getModel("openai-codex", "gpt-6-luna");
if (!model) throw new Error("gpt-6-luna is absent from the local model registry");
const selectedModel = model;
if (!runtime.hasConfiguredAuth(selectedModel.provider)) throw new Error("openai-codex authentication is unavailable");
const task = await readFile(workBriefPath, "utf8");
const order: Arm[] = ["patch", "baseline", "baseline", "patch"];
const results: Record<string, unknown>[] = [];
let inProgress: { run: number; arm: Arm } | undefined;

for (let index = 0; index < order.length; index++) {
  inProgress = { run: index + 1, arm: order[index]! };
  await saveEvidence("running");
  try {
    await runArm(order[index]!, index + 1);
  } catch (error) {
    results.push({ run: index + 1, arm: order[index], failure: error instanceof Error ? error.name : "unknown", patchRequirementMet: false });
    await saveEvidence("running");
  }
  inProgress = undefined;
}
await saveEvidence("complete");
console.log(JSON.stringify({ evidence: evidencePath, order, results }, null, 2));

async function saveEvidence(status: "running" | "complete"): Promise<void> {
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify({
  status,
  plan: "apply-patch-mutation@rev1",
  fixture: manifest.fixture,
  historicalCommit: "96ef478137785943d469f3f7e7b99524b9ad6819",
  preChangeCommit: "96ef478137785943d469f3f7e7b99524b9ad6819^",
  implementationHead: head,
  worktree: repo,
  provider: selectedModel.provider,
  model: selectedModel.id,
  api: selectedModel.api,
  reasoning: "xhigh",
  role: "Developer",
  roleInstructionsHash,
  hostPiCliVersion,
  packagePiCliVersion,
  piPackageVersion: piPackage.version,
  bunVersion,
  workBriefHash,
  manifestHash,
  fixtureHash,
  implementationFiles,
  implementationSnapshotHash,
  order,
  preliminaryEvidence: "dogfood-preliminary.json (run 1 baseline valid; run 2 patch did not invoke apply_patch; run 3 stopped without metrics)",
  invalidPreliminaryAttempts: [
    { outcome: "initial harness timed out after 900s", metricsPersisted: false, excludedFromPairs: true },
    { outcome: "stopped to move functional gate outside default Bun test discovery", metricsPersisted: false, excludedFromPairs: true },
    { outcome: "first instrumented patch arm used edit only; pair invalid; evidence preserved separately", metricsPersisted: true, excludedFromPairs: true },
  ],
  preChangeAcceptance: { functionalGate: "bun acceptance.gate.ts fails on pre-change source", unitCommand: "bun test tests/session-name.test.ts", unitPass: 2 },
  ...(inProgress ? { inProgress } : {}),
  rawTranscripts: "kept only in live in-memory sessions; not exported",
    results,
  }, null, 2)}\n`, "utf8");
}

async function runArm(arm: Arm, run: number): Promise<void> {
  const initialWorkBrief = await readFile(workBriefPath, "utf8");
  await rm(armRoot, { recursive: true, force: true });
  await mkdir(armRoot, { recursive: true });
  for (const file of manifest.files) {
    const source = path.join(template, file);
    const target = path.join(armRoot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(source));
  }
  if (await realpath(armRoot) !== armRoot) throw new Error("Dogfood fixture root is not physical");
  const copiedFixtureHash = await hashFiles(armRoot, manifest.files);
  if (copiedFixtureHash !== fixtureHash) throw new Error("Copied arm does not match frozen fixture");

  const loaded = await loadPitako(packageRoot(), armRoot);
  const controlPath = path.join(loaded.agentDir, "dogfood-control.mjs");
  await writeFile(controlPath, guardSource(manifest.writableFiles));
  const mutableLoader = loaded.loader as unknown as {
    additionalExtensionPaths: string[];
    extensionsOverride?: (base: { extensions: Array<{ resolvedPath: string }> } & Record<string, unknown>) => { extensions: Array<{ resolvedPath: string }> } & Record<string, unknown>;
  };
  mutableLoader.additionalExtensionPaths.push(controlPath);
  const priorOverride = mutableLoader.extensionsOverride;
  mutableLoader.extensionsOverride = (base) => {
    const result = priorOverride ? priorOverride(base) : base;
    const control = path.resolve(controlPath);
    const found = result.extensions.find((extension) => path.resolve(extension.resolvedPath) === control);
    if (!found) throw new Error("Dogfood guard extension did not load");
    return { ...result, extensions: [...result.extensions.filter((extension) => extension !== found), found] };
  };
  await loaded.loader.reload();
  const extensionOrder = extensionPaths(loaded.loader.getExtensions());
  if (!extensionOrder.at(-1)?.endsWith("dogfood-control.mjs")) throw new Error("Dogfood guard is not last in extension order");
  loaded.loader.getAppendSystemPrompt().push(roleInstructions);

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const calls: Array<{ tool: string; path?: string; editCount?: number; targets?: string[]; failed?: boolean; errorCode?: string }> = [];
  const patches: Array<Record<string, unknown>> = [];
  let gateToolCalls = 0;
  const toolCounts: Record<string, number> = {};
  const failures: Array<Record<string, unknown>> = [];
  let turns = 0;
  let totalTools = 0;
  let mutationCalls = 0;
  const started = Date.now();
  let externalGate: Awaited<ReturnType<typeof runGate>> | undefined;

  try {
    const created = await createAgentSession({
      cwd: armRoot,
      model: selectedModel,
      modelRuntime: runtime,
      resourceLoader: loaded.loader,
      sessionManager: SessionManager.inMemory(armRoot),
    });
    session = created.session;
    session.setThinkingLevel("xhigh");
    const discovered = session.getAllTools().map((tool) => tool.name);
    const nav = [
      "read", "bash", "edit", "write", "grep", "find", "ls",
      "lsp_diagnostics", "lsp_find_references", "lsp_goto_definition", "lsp_prepare_rename", "lsp_symbols",
      "codegraph_search", "codegraph_callers", "codegraph_callees", "codegraph_impact",
      "codegraph_explore", "codegraph_node", "codegraph_files", "codegraph_status",
    ].filter((name) => discovered.includes(name));
    const active = [...nav, ...(arm === "patch" && discovered.includes("apply_patch") ? ["apply_patch"] : [])];
    session.setActiveToolsByName(active);
    const actualActive = session.getActiveToolNames().sort();
    if (active.slice().sort().join("\n") !== actualActive.join("\n")) throw new Error(`Active tool mismatch: ${actualActive.join(",")}`);
    const patchDefinition = session.getToolDefinition("apply_patch");
    if (!patchDefinition) throw new Error("apply_patch schema missing from registered tools");
    const schema = stable(patchDefinition);
    const schemaHash = hash(JSON.stringify(schema));
    const profileGuidance = "Keep edit and write active. Use edit for one or a few local replacements; use apply_patch for coherent multi-file batches.";

    session.subscribe((rawEvent) => {
      const event = rawEvent as ToolEvent;
      if (event.type === "turn_end") turns++;
      if (event.type === "tool_execution_start") {
        totalTools++;
        const name = event.toolName ?? "unknown";
        toolCounts[name] = (toolCounts[name] ?? 0) + 1;
        if (["edit", "write", "apply_patch"].includes(name)) {
          mutationCalls++;
          const args = event.args ?? {};
          const file = typeof args.path === "string" ? args.path : undefined;
          const edits = Array.isArray(args.edits) ? args.edits.length : undefined;
          const targets = name === "apply_patch" ? patchTargets(args.patch) : undefined;
          calls.push({ tool: name, ...(file ? { path: file } : {}), ...(edits !== undefined ? { editCount: edits } : {}), ...(targets ? { targets } : {}) });
        }
        if (name === "bash" && typeof event.args?.command === "string" && (/\bbun\s+acceptance\.gate\.ts\b/.test(event.args.command) || (/\bbun\s+test\b/.test(event.args.command) && /tests\/session-name\.test\.ts/.test(event.args.command)))) gateToolCalls++;
      }
      if (event.type === "tool_execution_end") {
        const name = event.toolName ?? "unknown";
        if (event.isError) failures.push({ tool: name, ...(name === "apply_patch" ? { errorCode: patchDetails(event.result)?.errorCode } : {}) });
        if (name === "apply_patch") {
          const details = patchDetails(event.result);
          if (details) patches.push(compactPatch(details));
          const prior = calls.at(-1);
          if (prior?.tool === name) {
            prior.failed = Boolean(event.isError);
            prior.errorCode = typeof details?.errorCode === "string" ? details.errorCode : undefined;
          }
        }
      }
    });

    const armGlobal = globalThis as typeof globalThis & { __pitakoDogfoodArm?: string; __pitakoDogfoodPrompt?: Record<string, unknown> };
    armGlobal.__pitakoDogfoodArm = arm;
    armGlobal.__pitakoDogfoodPrompt = undefined;
    if (!initialWorkBrief.includes("Historical source:")) throw new Error("WorkBrief hash changed before prompt");
    await promptWithTimeout(session, task);
    const promptCapture = armGlobal.__pitakoDogfoodPrompt;
    const toolActivity = totalTools;
    const firstGate = await runGate(armRoot);
    externalGate = firstGate;
    let correctionTurns = 0;
    while (!externalGate.passed && correctionTurns < 2) {
      correctionTurns++;
      await promptWithTimeout(session, "The fixed functional gate failed. Read acceptance.gate.ts and correct the implementation. Do not edit the frozen acceptance gate. Run `bun acceptance.gate.ts` and `bun test tests/session-name.test.ts` again.");
      externalGate = await runGate(armRoot);
    }

    const acceptanceHash = hash(await readFile(path.join(armRoot, "acceptance.gate.ts")));
    const taskHashAfter = hash(await readFile(path.join(armRoot, "WORKBRIEF.md")));
    const templateHashAfter = await hashFiles(template, manifest.files);
    const implementationHashAfter = await hashFiles(repo, implementationFiles);
    const changed = await changedManifestFiles(armRoot);
    const stats = session.getSessionStats();
    const patchUsed = (toolCounts.apply_patch ?? 0) > 0;
    const promptText = (promptCapture ?? {}) as { guidancePresent?: boolean; baselineGuidanceRemoved?: boolean; explicitBatchGuidancePresent?: boolean };
    const guidancePresent = Boolean(promptText.guidancePresent);
    const baselineGuidanceRemoved = Boolean(promptText.baselineGuidanceRemoved);
    const mutationPaths = [...new Set(calls.flatMap((call) => call.targets ?? (call.path ? [call.path] : [])))];

    const result = {
      run,
      arm,
      implementationHead: head,
      activeTools: actualActive,
      rawNavigationTools: nav,
      pi: { hostCliVersion: hostPiCliVersion, packageCliVersion: packagePiCliVersion, packageVersion: piPackage.version },
      provider: { provider: selectedModel.provider, model: selectedModel.id, api: selectedModel.api, reasoning: session.thinkingLevel },
      patchSchema: { hash: schemaHash, schema },
      prompt: {
        workBriefHash: hash(task),
        roleInstructionsHash,
        profileGuidance,
        guidancePresent,
        baselineGuidanceRemoved,
        explicitBatchGuidancePresent: Boolean(promptText.explicitBatchGuidancePresent),
        explicitBatchGuidance: "For this task's three-file batch, use apply_patch once to update src/index.ts, src/session-name.ts, and tests/session-name.test.ts. Do not use edit or write for the batch.",
        sameWorkBrief: hash(task) === workBriefHash,
      },
      fixtureHash,
      copiedFixtureHash,
      manifestHash,
      implementationSnapshotHash,
      session: {
        elapsedMs: Date.now() - started,
        turns,
        totalTools,
        eventToolCounts: toolCounts,
        piToolCalls: stats.toolCalls,
        mutationCalls: calls,
        patches,
        failures,
        gateToolCalls,
        correctionTurns,
        externalFirstPass: firstGate.passed,
        externalFinal: externalGate,
        patchInvoked: patchUsed,
        intraFileMultiEditCalls: calls.filter((call) => call.tool === "edit" && (call.editCount ?? 0) > 1).length,
        sameFileRepeatedEditCalls: repeatedEditCalls(calls),
        distinctMutationPaths: mutationPaths,
        crossFileLogicalChange: mutationPaths.length > 1,
        changedFiles: changed,
        firstPromptToolCount: toolActivity,
        usage: {
          input: stats.tokens.input,
          output: stats.tokens.output,
          cacheRead: stats.tokens.cacheRead,
          cacheWrite: stats.tokens.cacheWrite,
          total: stats.tokens.total,
          cost: stats.cost,
        },
      },
      integrity: {
        acceptanceUntampered: acceptanceHash === manifest.sha256["acceptance.gate.ts"],
        workBriefUntampered: taskHashAfter === workBriefHash,
        trackedFixtureUntampered: templateHashAfter === fixtureHash,
        implementationUntampered: implementationHashAfter === implementationSnapshotHash,
        copiedFiles: manifest.files,
        writableFiles: manifest.writableFiles,
      },
      patchUsed,
      patchRequirementMet: arm === "baseline" || patchUsed,
    };
    results.push(result);
    inProgress = undefined;
    await saveEvidence("running");
  } catch (error) {
    const failure = error instanceof Error ? `${error.name}: ${error.message}`.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 160) : "unknown";
    const stats = session?.getSessionStats();
    const result = {
      run,
      arm,
      provider: { provider: selectedModel.provider, model: selectedModel.id, api: selectedModel.api, reasoning: session?.thinkingLevel ?? "xhigh" },
      failure,
      elapsedMs: Date.now() - started,
      turns,
      totalTools,
      eventToolCounts: toolCounts,
      mutationCalls: calls,
      patches,
      failures,
      gateToolCalls,
      externalGate,
      patchInvoked: (toolCounts.apply_patch ?? 0) > 0,
      usage: stats ? { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, cost: stats.cost } : undefined,
      patchRequirementMet: false,
    };
    results.push(result);
    inProgress = undefined;
    await saveEvidence("running");
  } finally {
    session?.dispose();
    delete (globalThis as typeof globalThis & { __pitakoDogfoodArm?: string; __pitakoDogfoodPrompt?: Record<string, unknown> }).__pitakoDogfoodArm;
    delete (globalThis as typeof globalThis & { __pitakoDogfoodArm?: string; __pitakoDogfoodPrompt?: Record<string, unknown> }).__pitakoDogfoodPrompt;
  }
}

async function promptWithTimeout(session: Awaited<ReturnType<typeof createAgentSession>>["session"], prompt: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = session.prompt(prompt, { expandPromptTemplates: false });
  try {
    await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Developer session exceeded 15-minute prompt limit")), 15 * 60_000);
    })]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("8-minute prompt limit")) {
      await session.abort();
      await pending.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runGate(cwd: string): Promise<{ passed: boolean; acceptanceExitCode: number; unitExitCode: number; pass: number; fail: number; elapsedMs: number }> {
  const started = Date.now();
  const acceptance = Bun.spawn(["bun", "acceptance.gate.ts"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [acceptanceStdout, acceptanceStderr, acceptanceExitCode] = await Promise.all([
    new Response(acceptance.stdout).text(),
    new Response(acceptance.stderr).text(),
    acceptance.exited,
  ]);
  const unit = Bun.spawn(["bun", "test", "tests/session-name.test.ts"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [unitStdout, unitStderr, unitExitCode] = await Promise.all([
    new Response(unit.stdout).text(),
    new Response(unit.stderr).text(),
    unit.exited,
  ]);
  const unitOutput = `${unitStdout}\n${unitStderr}`;
  const pass = Number(unitOutput.match(/(\d+) pass\b/)?.[1] ?? 0);
  const fail = Number(unitOutput.match(/(\d+) fail\b/)?.[1] ?? 0);
  const acceptancePassed = acceptanceExitCode === 0 && `${acceptanceStdout}\n${acceptanceStderr}`.includes("functional acceptance passed: 4 checks");
  return { passed: acceptancePassed && unitExitCode === 0 && pass > 0 && fail === 0, acceptanceExitCode, unitExitCode, pass, fail, elapsedMs: Date.now() - started };
}

async function hashFiles(root: string, files: string[]): Promise<string> {
  const hashes: Array<[string, string]> = [];
  for (const file of [...files].sort()) hashes.push([file, hash(await readFile(path.join(root, file)))]);
  return hash(JSON.stringify(hashes));
}

async function changedManifestFiles(root: string): Promise<Array<{ path: string; hunks: number }>> {
  const changed: Array<{ path: string; hunks: number }> = [];
  for (const file of manifest.files) {
    const before = hash(await readFile(path.join(template, file)));
    const after = hash(await readFile(path.join(root, file)));
    if (before === after) continue;
    const diff = await commandOutput(["git", "diff", "--no-index", "--unified=0", "--", path.join(template, file), path.join(root, file)], repo, true);
    changed.push({ path: file, hunks: (diff.match(/^@@ /gm) ?? []).length });
  }
  return changed;
}

function repeatedEditCalls(calls: Array<{ tool: string; path?: string }>): number {
  const seen = new Set<string>();
  let repeated = 0;
  for (const call of calls) {
    if (call.tool !== "edit" || !call.path) continue;
    if (seen.has(call.path)) repeated++;
    seen.add(call.path);
  }
  return repeated;
}

function patchTargets(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]!);
}

function patchDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" ? details as Record<string, unknown> : undefined;
}

function compactPatch(details: Record<string, unknown>): Record<string, unknown> {
  const keys = ["targets", "committed", "pending", "uncertain", "plannedFiles", "plannedHunks", "filesChanged", "hunksChanged", "inputBytes", "status", "phase", "errorCode", "elapsedMs"];
  return Object.fromEntries(keys.filter((key) => details[key] !== undefined).map((key) => [key, details[key]]));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function commandOutput(command: string[], cwd: string, allowFailure = false): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) throw new Error(`${command[0]} failed (${exitCode})`);
  return `${stdout}${stderr}`.trim();
}

function guardSource(writableFiles: string[]): string {
  const writable = JSON.stringify(writableFiles);
  return `const writable = new Set(${writable});
const profileGuidance = ${JSON.stringify("Keep edit and write active. Use edit for one or a few local replacements; use apply_patch for coherent multi-file batches.")};
const baselineGuidance = "Keep edit and write active. Use edit for one or a few local replacements; use write for new files. Do not use tools that are not active.";
const patchBatchGuidance = "For this task's three-file batch, use apply_patch once to update src/index.ts, src/session-name.ts, and tests/session-name.test.ts. Do not use edit or write for the batch.";
const validBash = (command) => {
  if (typeof command !== "string" || /[\\r\\n;&|<>\x60]/.test(command)) return false;
  if (/\\b(?:-exec|-execdir|-delete|--output)\\b/.test(command)) return false;
  return /^\\s*(?:bun\\s+test\\b|bun\\s+acceptance\\.gate\\.ts\\b|(?:git\\s+(?:status|diff|log|rev-parse)\\b|pwd\\b|ls\\b|find\\b|grep\\b|rg\\b|head\\b|tail\\b|which\\b|node\\s+--version\\b|bun\\s+--version\\b))/.test(command);
};
export default function(pi) {
  pi.on("before_agent_start", (event) => {
    const before = event.systemPrompt ?? "";
    const arm = globalThis.__pitakoDogfoodArm;
    const after = arm === "baseline"
      ? before.replace(profileGuidance, baselineGuidance)
      : before + "\\n\\n" + patchBatchGuidance;
    globalThis.__pitakoDogfoodPrompt = {
      guidancePresent: after.includes(profileGuidance),
      baselineGuidanceRemoved: arm === "baseline" && before.includes(profileGuidance) && !after.includes(profileGuidance),
      explicitBatchGuidancePresent: arm === "patch" && after.includes(patchBatchGuidance),
    };
    return after === before ? undefined : { systemPrompt: after };
  });
  pi.on("tool_call", (event) => {
    const name = event.toolName;
    const input = event.input ?? {};
    if (name === "edit" || name === "write") {
      const target = input.path;
      if (typeof target === "string" && writable.has(target)) return undefined;
      return { block: true, reason: "Dogfood arm permits mutation only in manifest-listed writable files." };
    }
    if (name === "apply_patch") {
      const patch = input.patch;
      const targets = typeof patch === "string" ? [...patch.matchAll(/^\\*\\*\\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]) : [];
      if (targets.length > 0 && !patch.includes("*** Move to:") && targets.every((target) => writable.has(target))) return undefined;
      return { block: true, reason: "Dogfood patch targets must be manifest-listed writable files." };
    }
    if (name === "bash" && !validBash(input.command)) {
      return { block: true, reason: "Dogfood bash allows read-only navigation and frozen fixture gates only." };
    }
    return undefined;
  });
}\n`;
}
