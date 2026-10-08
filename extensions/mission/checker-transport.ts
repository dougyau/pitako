import { execFileSync } from "node:child_process";
import { constants, closeSync, createReadStream, createWriteStream, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface Endpoint { device: number; inode: number; direction: "read" | "write" }

/** Host-owned one-way rendezvous. No path is mounted in the checker capsule. */
export function createCheckerTransport(trace?: (event: string, facts?: Record<string, unknown>) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "pitako-checker-"));
  const owned = lstatSync(root);
  const pending = new Set<number>();
  const open = (name: string, flags: number) => {
    const fd = openSync(path.join(root, name), flags | constants.O_NOFOLLOW);
    pending.add(fd);
    return fd;
  };
  const close = (fd: number) => { if (pending.delete(fd)) closeSync(fd); };
  const cleanup = () => {
    const current = lstatSync(root);
    if (current.dev !== owned.dev || current.ino !== owned.ino || !current.isDirectory())
      throw new Error("checker transport directory identity changed");
    rmSync(root, { recursive: true });
  };
  try {
    execFileSync("/usr/bin/mkfifo", ["-m", "600", ...["go", "stdout", "stderr"].map((name) => path.join(root, name))],
      { timeout: 5_000, stdio: "ignore" });
    const channel = (name: string) => {
      // A read-only nonblocking rendezvous makes both subsequent blocking opens finite.
      // It is closed immediately; no self-writer can conceal EOF.
      const rendezvous = open(name, constants.O_RDONLY | constants.O_NONBLOCK);
      const writer = open(name, constants.O_WRONLY);
      const reader = open(name, constants.O_RDONLY);
      close(rendezvous);
      return { reader, writer };
    };
    const go = channel("go"), stdout = channel("stdout"), stderr = channel("stderr");
    const childEnds = [go.reader, stdout.writer, stderr.writer] as const;
    const endpoints: Endpoint[] = childEnds.map((fd, index) => {
      const stat = fstatSync(fd);
      if (!stat.isFIFO()) throw new Error("checker transport is not a native FIFO");
      return { device: stat.dev, inode: stat.ino, direction: index === 0 ? "read" : "write" };
    });
    const streams = {
      stdin: createWriteStream(path.join(root, "go"), { fd: go.writer, autoClose: true }),
      stdout: createReadStream(path.join(root, "stdout"), { fd: stdout.reader, autoClose: true }),
      stderr: createReadStream(path.join(root, "stderr"), { fd: stderr.reader, autoClose: true }),
    };
    const endpointState = () => ({
      stdin: { bytesWritten: streams.stdin.bytesWritten, closed: streams.stdin.closed,
        destroyed: streams.stdin.destroyed, finished: streams.stdin.writableFinished,
        error: streams.stdin.errored?.message ?? null },
      stdout: { bytesRead: streams.stdout.bytesRead, eof: streams.stdout.readableEnded,
        closed: streams.stdout.closed, destroyed: streams.stdout.destroyed,
        error: streams.stdout.errored?.message ?? null },
      stderr: { bytesRead: streams.stderr.bytesRead, eof: streams.stderr.readableEnded,
        closed: streams.stderr.closed, destroyed: streams.stderr.destroyed,
        error: streams.stderr.errored?.message ?? null },
    });
    if (trace) for (const [endpoint, stream] of Object.entries(streams)) {
      for (const event of ["end", "finish", "close"])
        stream.once(event, () => trace(`endpoint.${event}`, { endpoint, state: endpointState() }));
      stream.on("error", (error) => trace("endpoint.error", { endpoint, error: error.message,
        state: endpointState() }));
    }
    for (const fd of [go.writer, stdout.reader, stderr.reader]) pending.delete(fd);
    // Install error observation before spawn, including GO EPIPE.
    let failure: Error | undefined;
    for (const stream of Object.values(streams)) stream.on("error", (error) => { failure ??= error; });
    const drains = Promise.all([streams.stdout, streams.stderr].map((stream) => new Promise<void>((resolve, reject) => {
      stream.once("end", resolve);
      stream.once("error", reject);
      stream.once("close", () => { if (!stream.readableEnded) reject(new Error("checker output closed before EOF")); });
    })));
    // Rejection is checked by the explicit process/output join, never unhandled.
    void drains.catch(() => {});
    return {
      ...streams, childEnds, endpoints, root, endpointState,
      spawned() { for (const fd of childEnds) close(fd); },
      async drain(timeoutMs: number) {
        if (timeoutMs <= 0) throw new Error("checker output drain exceeded finite deadline");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([drains, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("checker output drain exceeded finite deadline")), Math.max(1, timeoutMs));
          })]);
          if (failure) throw failure;
        } finally { clearTimeout(timer); }
      },
      async release(timeoutMs: number) {
        if (timeoutMs <= 0) throw new Error("checker GO delivery exceeded finite deadline");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("checker GO delivery exceeded finite deadline")), Math.max(1, timeoutMs));
            streams.stdin.once("error", reject);
            streams.stdin.once("close", () => failure ? reject(failure) : resolve());
            streams.stdin.end("GO\n");
          });
          if (failure) throw failure;
        } finally { clearTimeout(timer); }
      },
      async dispose() {
        for (const fd of [...pending]) close(fd);
        const closed = Promise.all(Object.values(streams).map((stream) => new Promise<void>((resolve) => {
          if (stream.closed) return resolve();
          stream.once("close", resolve);
          stream.destroy();
        })));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([closed, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("checker endpoint closure is unresolved")), 5_000);
          })]);
          cleanup();
        } finally { clearTimeout(timer); }
      },
    };
  } catch (error) {
    for (const fd of [...pending]) close(fd);
    cleanup();
    throw error;
  }
}

export type CheckerTransport = ReturnType<typeof createCheckerTransport>;

export function observeCheckerEndpoints(pid: number, endpoints: readonly Endpoint[]) {
  if (endpoints.length !== 3) throw new Error("checker stdio endpoint set is incomplete");
  return endpoints.map((expected, fd) => {
    const target = `/proc/${pid}/fd/${fd}`;
    // Linux O_PATH pins the FIFO without opening an additional reader or writer.
    const pinned = openSync(target, 0x200000);
    try {
      const stat = fstatSync(pinned);
      const info = readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8");
      const flags = Number.parseInt(/^flags:\s+([0-7]+)$/m.exec(info)?.[1] ?? "", 8);
      if (!Number.isSafeInteger(flags) || !stat.isFIFO() || stat.dev !== expected.device || stat.ino !== expected.inode ||
        (flags & constants.O_NONBLOCK) !== 0 ||
        (flags & 3) !== (expected.direction === "read" ? constants.O_RDONLY : constants.O_WRONLY))
        throw new Error("checker stdio endpoint identity or direction mismatch");
      return { fd, ...expected, flags, nativeFIFO: true };
    } finally { closeSync(pinned); }
  });
}
