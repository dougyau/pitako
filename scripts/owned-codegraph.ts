import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const native = require(`@colbymchenry/codegraph-${process.platform}-${process.arch}/lib/dist/mcp/daemon-registry.js`) as {
  stopDaemonAt(root: string): Promise<{ root: string; pid: number | null; outcome: string }>;
};

interface ProcessIdentity { pid: number; startTicks: string; state: string }

function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, state: fields[0]!, startTicks: fields[19]! };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function descendants(pid: number): ProcessIdentity[] {
  const identity = processIdentity(pid);
  if (!identity) return [];
  const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
  return [identity, ...children.split(/\s+/).filter(Boolean).flatMap((child) => descendants(Number(child)))];
}

// Only for fresh caller-owned fixture projects, never an invoking user's graph.
// Native stop verifies the lock/socket hello before signalling; /proc identities
// prove descendant termination separately from the MCP caller's close event.
export async function settleOwnedCodeGraph(project: string) {
  if (process.platform !== "linux") throw new Error("Owned CodeGraph descendant settlement requires Linux /proc");
  const root = realpathSync(project);
  let pid: number | undefined;
  try {
    pid = JSON.parse(readFileSync(path.join(root, ".codegraph", "daemon.pid"), "utf8")).pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const before = pid ? descendants(pid) : [];
  const stop = await native.stopDaemonAt(root);
  const deadline = Date.now() + 5_000;
  const terminal = () => before.every((identity) => {
    const current = processIdentity(identity.pid);
    return !current || current.startTicks !== identity.startTicks || current.state === "Z";
  });
  while (!terminal() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!terminal()) throw new Error(`Owned CodeGraph descendants still running; retain ${root}`);
  const after = before.map(({ pid }) => processIdentity(pid) ?? { pid, state: "absent" });
  return { root, stop, before, after };
}
