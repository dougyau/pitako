import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ManifestPath, WorkspaceImage } from "./workspace.ts";

export const PREPARATION_TIME_MS = 60_000;
export const BOOTSTRAP_TIME_MS = 10_000;

export function hydrateWorkspaceImage(image: WorkspaceImage): WorkspaceImage {
  return { ...image, files: image.files.map(file => ({ ...file, bytes: file.bytes
    ? Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength) : null })) };
}

/** One owned request/response worker per frontier. Cancellation retires it, never falls back to UI scans. */
export class PhysicalObservation {
  private readonly root = mkdtempSync(path.join(tmpdir(), "pitako-physical-"));
  private readonly worker = new Worker(new URL("./physical-observer.mjs", import.meta.url), {
    workerData: { loaderRoot: this.root },
  });
  private readonly ready: Promise<void>;
  private pending?: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
  private failed?: Error;
  private disposed = false;
  private disposal?: Promise<void>;
  private deadline: number;
  private executionBound = false;
  constructor(deadline = performance.now() + PREPARATION_TIME_MS) {
    this.deadline = deadline;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("physical observer bootstrap expired");
        this.failed = error;
        reject(error);
        void this.dispose();
      }, Math.max(1, Math.min(BOOTSTRAP_TIME_MS, deadline - performance.now())));
      this.worker.on("message", (row) => {
        if (row.kind === "ready") { clearTimeout(timer); resolve(); }
        else if (row.kind === "error") {
          const error = new Error(row.error);
          if (!row.id) { clearTimeout(timer); this.failed = error; reject(error); }
          this.pending?.reject(error);
        } else if (row.kind === "result" && row.id === this.pending?.id) this.pending!.resolve(row.value);
      });
      const fail = (error: Error) => {
        clearTimeout(timer); this.failed = error; reject(error); this.pending?.reject(error);
      };
      this.worker.on("error", fail);
      this.worker.on("exit", code => fail(new Error(`physical observer exited ${code}`)));
    });
    // The client may be cancelled before its first request.
    void this.ready.catch(() => {});
  }
  /** One release changes the technical preparation lifetime to the fixed execution deadline. */
  bindExecutionDeadline(deadline: number): void {
    if (this.executionBound || this.pending || this.disposed || !Number.isFinite(deadline) ||
      deadline <= performance.now() || performance.now() >= this.deadline)
      throw new Error("invalid physical observation execution release");
    this.executionBound = true;
    this.deadline = deadline;
  }
  async request<T>(operation: string, input: unknown, signal?: AbortSignal, deadline = this.deadline): Promise<T> {
    deadline = Math.min(deadline, this.deadline);
    if (this.pending) throw new Error("physical observer already has an operation");
    if (this.disposed || this.failed) throw this.failed ?? new Error("physical observer disposed");
    const id = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      this.pending?.reject(new Error("physical observation cancelled"));
      void this.dispose();
    };
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending = { id, resolve: value => resolve(value as T), reject };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) { cancel(); return; }
        timer = setTimeout(() => {
          reject(new Error("physical observation preparation expired"));
          void this.dispose();
        }, Math.max(1, Math.min(2_147_483_647, deadline - performance.now())));
        void this.ready.then(() => {
          if (performance.now() >= deadline) throw new Error("physical observation preparation expired");
          if (!this.disposed) this.worker.postMessage({ id, operation, input });
        }).catch(reject);
      });
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      this.pending = undefined;
    }
  }
  paths(root: string, signal?: AbortSignal, deadline?: number): Promise<ManifestPath[]> {
    return this.request("paths", { root }, signal, deadline);
  }
  async image(root: string, signal?: AbortSignal, deadline?: number): Promise<WorkspaceImage> {
    const image = await this.request<WorkspaceImage>("image", { root }, signal, deadline);
    return hydrateWorkspaceImage(image);
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = this.worker.terminate().then(() => {
      rmSync(this.root, { recursive: true, force: true });
    });
    return this.disposal;
  }
}
