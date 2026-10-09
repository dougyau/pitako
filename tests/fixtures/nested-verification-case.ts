import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createMissionWorkspace, preflightContainment, spawnContained } from "../../extensions/mission/workspace.ts";
import { createPiExecutor } from "../../extensions/agent/pi.ts";
import { installMissionLocalProvider } from "../mission-local-provider.ts";

const root = "/verification/scratch";
const evidence = "/verification/evidence";
assert.equal(readFileSync(0, "utf8"), "", "GO channel must reach EOF after release");
const source = path.join(root, "source"), store = path.join(root, "store"), other = path.join(root, "other");
for (const dir of [source, store, other]) mkdirSync(dir);
mkdirSync(path.join(source, "src"));
writeFileSync(path.join(source, "src/sentinel"), "fixture-source");
writeFileSync(path.join(store, "sentinel"), "fixture-store");
const git = (args: string[]) => execFileSync("/usr/bin/git", args, { cwd: source });
git(["init", "-q"]); git(["add", "."]);
git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
const workspace = await createMissionWorkspace({ missionId: crypto.randomUUID(), attemptId: crypto.randomUUID(),
  sourceRoot: source, storeRoot: store, candidateParent: path.join(root, "candidates"), otherCandidates: [other],
  allowedPaths: ["src/**"] });
const proof = await preflightContainment(workspace);
assert(proof.protectedInputOrigins.some((row) => row.origin === "inherited-read-only"));
assert(proof.protectedInputOrigins.some((row) => row.origin === "enclosing-writable"));
const child = spawnContained(workspace, "/bin/bash", ["-c", "printf owned > src/owned; printf forbidden > /tmp/pitako/source/src/escape 2>/dev/null && exit 81; exit 0"]);
child.stdin!.end();
child.stdout!.resume(); child.stderr!.resume();
const childExit = await new Promise((resolve) => child.once("close", resolve));
assert.equal(childExit, 0);
assert.equal(readFileSync(path.join(workspace.candidateRoot, "src/owned"), "utf8"), "owned");
assert.equal(readFileSync(path.join(source, "src/sentinel"), "utf8"), "fixture-source");
assert.equal(readFileSync(path.join(store, "sentinel"), "utf8"), "fixture-store");
assert(!existsSync(path.join(source, "src/escape")));

// A nested user namespace cannot turn an inherited locked read-only subject into writable input.
const remount = spawnSync("/usr/bin/bwrap", ["--unshare-user", "--ro-bind", "/", "/",
  "--bind", "/tmp/pitako/product", "/rebound", "--", "/bin/bash", "-c", "printf bad > /rebound/subject-escape"],
{ encoding: "utf8" });
assert.notEqual(remount.status, 0);
assert(!existsSync("/tmp/pitako/product/subject-escape"));

const socket = path.join(root, "private.socket");
const server = net.createServer((connection) => connection.end("private"));
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
let privateBytes = "";
await new Promise<void>((resolve, reject) => {
  const connection = net.connect(socket);
  connection.on("data", (bytes) => { privateBytes += bytes; });
  connection.once("error", reject); connection.once("end", resolve);
});
assert.equal(privateBytes, "private");
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const external = await new Promise<string>((resolve) => {
  const connection = net.connect({ host: "1.1.1.1", port: 443 });
  connection.setTimeout(1000, () => { connection.destroy(); resolve("timeout"); });
  connection.once("connect", () => { connection.destroy(); resolve("connected"); });
  connection.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "unknown"));
});
assert(["ENETUNREACH", "ECONNREFUSED"].includes(external));
const hostCredentials = process.argv[2];
assert(hostCredentials && path.isAbsolute(hostCredentials), "host credential path must be supplied by the fixture");
assert(!existsSync(hostCredentials), "host credentials must not be exposed");

const agentDir = path.join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const provider = await installMissionLocalProvider({ agentDir, responseForPrompt: () => "SDK_PASS",
  toolForPrompt: () => ({ name: "read", arguments: { path: "src/owned" } }) });
const events: unknown[] = [];
const result = await createPiExecutor().start({ instanceId: "contained-sdk", role: {
  id: "developer", name: "Developer", description: "offline", instructionsPath: "roles/developer.md",
  instructions: "Read the owned fixture file.", skills: [], principles: [], modelPolicyId: "developer",
  modelPolicy: { id: "developer", fallbacks: [] },
}, task: "Read src/owned", target: { model: `${provider.provider}/${provider.model}`, reasoning: "off" },
  cwd: workspace.candidateRoot, signal: new AbortController().signal, onActivity: (event) => { events.push(event); } });
try {
  assert.equal(result.status, "completed");
  assert.equal(result.result, "SDK_PASS");
  assert(JSON.stringify(events).includes("owned"));
  assert(provider.trace.length >= 2);
} finally { await result.session?.dispose(); }
provider.flush(path.join(evidence, "sdk-provider.json"));
writeFileSync(path.join(evidence, "sdk-events.json"), JSON.stringify(events));
writeFileSync(path.join(evidence, "containment.json"), JSON.stringify({ proof, childExit, remountExit: remount.status, external, sdkDisposed: true }));

// Detached, nested PID namespace with closed stdio: an empty outer namespace scan alone cannot establish retirement.
const marker = path.join(root, "detached-started");
const detached = spawn("/usr/bin/bwrap", ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/",
  "--bind", root, root, "--proc", "/proc",
  "--", "/bin/bash", "-c", `printf started > ${marker}; exec /usr/bin/sleep 1000`], { detached: true, stdio: "ignore" });
detached.unref();
for (let n = 0; n < 200 && !existsSync(marker); n++) await new Promise((resolve) => setTimeout(resolve, 10));
assert(existsSync(marker), "detached nested namespace did not start");
console.log("NESTED_AND_SDK_PASS");
console.error("NESTED_TRAILING_STDERR");
