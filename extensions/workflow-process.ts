import { readFileSync, readlinkSync, statSync, statfsSync } from "node:fs";

/** Host-owned evidence for exclusively in-process scopes, never descendant effects. */
export type HostProcessBinding = {
  version: "linux-proc-v1";
  host: string;
  boot: string;
  pidNamespace: string;
  mountNamespace: string;
  procDevice: string;
  procMount: string;
  pid: number;
  startTicks: string;
};

function view(): Omit<HostProcessBinding, "version" | "pid" | "startTicks"> {
  if (process.platform !== "linux" || Number(statfsSync("/proc").type) !== 0x9fa0 ||
      readlinkSync("/proc/self") !== String(process.pid)) throw new Error("unsupported procfs domain");
  const procMount = readFileSync("/proc/self/mountinfo", "utf8").split("\n")
    .find(line => line.split(" ")[4] === "/proc");
  if (!procMount?.includes(" - proc ") || /hidepid=(?!0(?:,|\s|$))/.test(procMount))
    throw new Error("unverifiable procfs visibility");
  const host = readFileSync("/etc/machine-id", "utf8").trim();
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9]{32}$/.test(host) || !/^[a-f0-9-]{36}$/.test(boot))
    throw new Error("incomplete host identity");
  return { host, boot, procMount, procDevice: String(statSync("/proc").dev),
    pidNamespace: readlinkSync("/proc/self/ns/pid"), mountNamespace: readlinkSync("/proc/self/ns/mnt") };
}

function birth(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) throw new Error("incomplete process birth identity");
  return startTicks;
}

export function captureHostProcess(): HostProcessBinding | undefined {
  try {
    const before = view(), startTicks = birth(process.pid);
    if (JSON.stringify(before) !== JSON.stringify(view())) return undefined;
    return { version: "linux-proc-v1", ...before, pid: process.pid, startTicks };
  } catch { return undefined; }
}

/** Absence is meaningful only within the original, positively verified procfs view. */
export function probeHostProcess(binding: HostProcessBinding): "present" | "ended" | "unknown" {
  try {
    const { version, pid, startTicks, ...originalView } = binding;
    if (version !== "linux-proc-v1" || !Number.isSafeInteger(pid) || pid <= 0 ||
        !/^\d+$/.test(startTicks)) return "unknown";
    const before = view();
    if (JSON.stringify(before) !== JSON.stringify(originalView)) return "unknown";
    birth(process.pid);
    let current: string | undefined;
    try { current = birth(pid); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
    }
    if (JSON.stringify(before) !== JSON.stringify(view())) return "unknown";
    return current === startTicks ? "present" : "ended";
  } catch { return "unknown"; }
}
