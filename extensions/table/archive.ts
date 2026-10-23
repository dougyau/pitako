import { promises as fs, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { evidenceFile, readExecutionBinding, workflowWorkspace } from "../workflow.ts";
import { assertGenericWrite, captureCallContext, currentCallContext, reserveEffect, type Producer } from "../workflow-engine.ts";

export type ArchiveDestination = { root: string; planId?: string } | { unavailable: string };
export type ArchiveState =
  | { state: "pending" }
  | { state: "written"; path: string }
  | { state: "unavailable"; reason: string }
  | { state: "failed"; reason: string; settlement: "released" | "unknown"; retained?: string };

/** Called by the foreground adapters at reservation, never by a later reader.
 * Prospective plan correlation is not an execution binding and creates nothing. */
export function captureTableArchive(cwd: string, planId?: string): ArchiveDestination {
  try {
    const binding = planId ? readExecutionBinding(planId, cwd) : undefined;
    if (binding) return { root: binding.executionRoot, planId: binding.planId };
    return { root: realpathSync(workflowWorkspace(cwd)) };
  } catch (error) { return { unavailable: String(error) }; }
}

const denied = (error: unknown) => ["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "");
class Unavailable extends Error {}

/** Exact publication intent, captured before admission; unrelated archive IDs do not overlap. */
export function tableArchivePaths(destination: ArchiveDestination | undefined, id: string): string[] {
  if (!destination || "unavailable" in destination) return [];
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Unavailable("invalid host result id");
  const target = destination.planId
    ? evidenceFile(destination.planId, `table-results/${id}.json`, destination.root)
    : path.join(destination.root, ".pitako", "table-results", `${id}.json`);
  const relative = path.relative(destination.root, path.dirname(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Unavailable("archive destination outside captured root");
  return [target, path.join(path.dirname(target), `.${id}.tmp`)];
}

/** Auxiliary copy only. A closed temp is linked exclusively, never renamed over a destination.
 * Component checks reject existing symlinks. They are not an adversarial filesystem sandbox:
 * the host must own the tree against concurrent external replacement. No fsync durability claim. */
export function startTableArchive(destination: ArchiveDestination | undefined, id: string, canonical: string, io = fs, producer?: Producer) {
  let state: ArchiveState = { state: "pending" };
  const admitted = producer;
  // Capture and register before any asynchronous filesystem operation. Background roots
  // supply the port registered at admission; retirement cannot substitute a new owner.
  // A captured caller owns the lease; its archive destination is only the effect path.
  let paths: string[] = [];
  if (destination && !("unavailable" in destination)) {
    try {
      paths = tableArchivePaths(destination, id);
      if (producer) {
        if (JSON.stringify(producer.effectPaths) !== JSON.stringify(paths))
          throw new Unavailable("archive producer does not own the exact publication intent");
      } else {
        const context = currentCallContext() ?? captureCallContext(destination.root);
        assertGenericWrite(context);
        producer = reserveEffect(context, { reservationId: randomUUID(), kind: "writer", paths })
          .register("table-archive", ["host-operation", "callback"]);
        producer.enter();
      }
    }
    catch (error) {
      if (!admitted) {
        producer?.observe("host-operation", "closed");
        producer?.observe("callback", "closed", true);
      }
      return { get state(): ArchiveState { return { state: "unavailable", reason: String(error) }; },
        get closure() { return "released" as const; },
        get retainedHandle() { return undefined; }, async closeRetained() {}, completion: Promise.resolve() };
    }
  }
  let temp: string | undefined, handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let unknown = false;
  const completion = (async () => {
    if (!destination || "unavailable" in destination) {
      state = { state: "unavailable", reason: destination?.unavailable ?? "no authorized archive root captured" };
      producer?.observe("host-operation", "closed");
      producer?.observe("callback", "closed", true);
      return;
    }
    try {
      const root = destination.root;
      try {
        if (await io.realpath(root) !== root) throw new Unavailable("archive root changed physical identity");
      } catch (error) { throw new Unavailable(String(error)); }
      const [target, candidate] = paths as [string, string];
      const relative = path.relative(root, path.dirname(target));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Unavailable("archive destination outside captured root");
      let directory = root;
      for (const component of relative.split(path.sep)) {
        directory = path.join(directory, component);
        try { await io.mkdir(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        const stat = await io.lstat(directory);
        if (!stat.isDirectory() || await io.realpath(directory) !== directory) throw new Unavailable("archive directory is not physically contained");
      }
      // Only a successfully opened exclusive temp is ours to remove.
      handle = await io.open(candidate, "wx", 0o600);
      temp = candidate;
      try { await handle.writeFile(canonical, "utf8"); }
      finally {
        try { await handle.close(); handle = undefined; }
        catch (error) { unknown = true; throw error; }
      }
      await io.link(temp, target); // EEXIST preserves any previous copy, including symlinks.
      await io.unlink(temp); temp = undefined;
      state = { state: "written", path: target };
    } catch (error) {
      state = unknown
        ? { state: "failed", reason: String(error), settlement: "unknown", retained: temp }
        : denied(error) || error instanceof Unavailable
          ? { state: "unavailable", reason: String(error) }
          : { state: "failed", reason: String(error), settlement: "released" };
      if (temp && !unknown) {
        try { await io.unlink(temp); temp = undefined; }
        catch (cleanup) { state = { state: "failed", reason: `${String(error)}; cleanup: ${String(cleanup)}`, settlement: "released", retained: temp }; }
      }
    } finally {
      producer?.observe("host-operation", unknown ? "unknown" : "closed");
      producer?.observe("callback", unknown ? "unknown" : "closed", true);
    }
  })();
  // Retain the actual handle too if close failed; retirement must not drop its resources.
  return {
    get state() { return state; }, get retainedHandle() { return handle; }, completion,
    get closure(): "pending" | "released" | "unknown" {
      return state.state === "pending" ? "pending" : unknown ? "unknown" : "released";
    },
    /** Retry only the retained original descriptor. This releases evidence, not the failed outcome. */
    async closeRetained() {
      await completion;
      if (!unknown || !handle) return;
      await handle.close();
      handle = undefined;
      producer!.observe("host-operation", "closed");
      producer!.observe("callback", "closed", true);
      unknown = false;
    },
  };
}
export type TableArchive = ReturnType<typeof startTableArchive>;
