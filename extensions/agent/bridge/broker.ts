import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { chmodSync, lstatSync, readdirSync, realpathSync, linkSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import path from "node:path";
import type { createAgentController, AgentSelection } from "../controller.ts";
import { frame, frames } from "../framing.js";
import { capabilities, failure, isEnvelope, isRequest, outstandingRequests, queueBytes, replyBytes,
  sameOwner, success, errors, isReply, isNotification, isMutationStatus,
  type Descriptor, type Grant, type Request, type ErrorCode, type MutationStatus } from "./protocol.js";

type Controller = ReturnType<typeof createAgentController>;
type View = ReturnType<Controller["openView"]>;
type Mutation = Extract<Request, { method: "input" | "cancel" }>;
type Admission = { digest: string; status: MutationStatus };
type Lease = { token: string; socket?: Socket; idleAt: number; pending: number; highWater: number; receipts: Map<number, Admission> };
const errorCode = (error: unknown): ErrorCode => {
  const message = error instanceof Error ? error.message : "";
  return Object.hasOwn(errors, message) ? message as ErrorCode
    : message === "unknown scoped worker" ? "unknown_target"
    : message === "view has outstanding work" ? "busy"
    : message === "controller owner epoch is retired" || message === "view is disconnected" ? "stale_owner"
    : message === "raw history requires this view's acknowledgement" || message === "raw route requires this view's acknowledgement" ? "forbidden"
    : error instanceof RangeError ? "oversized"
    : ["stale controller selection", "live binding changed; reobserve", "live instance changed", "native binding is closed or stale",
      "synchronous run is read-only", "terminal worker is read-only", "Team evaluation is retired"].includes(message) ? "stale_selection"
    : "invalid_cursor";
};
// Hash semantic fields, not JSON property order or transport correlation IDs.
const mutationDigest = (request: Mutation) => {
  const s = request.params.selection;
  return createHash("sha256").update(JSON.stringify([request.method, s.processId, s.coordinatorSessionId, s.epoch,
    s.target.kind, s.target.kind === "team" ? s.target.assignmentId : s.target.instanceId,
    s.instanceId, s.generation, s.historyId, s.sessionId,
    request.method === "input" ? [request.params.input.intent, request.params.input.text, request.params.input.decisionId ?? null] : null])).digest("hex");
};
const identity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const stat = (file: string) => {
  try { return lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};
function privateRoot(root: string) {
  if (!path.isAbsolute(root) || root.includes("\0") || path.normalize(root) !== root)
    throw new Error("Agent bridge requires an absolute, canonical private directory");
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(root) !== root ||
      !process.getuid || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700)
    throw new Error("Agent bridge directory must be same-user owned, non-symlinked and mode 0700");
  if (readdirSync(root).length) throw new Error("Agent bridge directory must be empty; refusing conflicting contents");
  return info;
}

/** The foreground owns this lifetime BEFORE its first readiness await. */
export function createAgentBridge(controller: Controller, root: string, grants: Grant[], current: () => boolean) {
  const ceilings = [...grants];
  let active = true, rootIdentity: Stats | undefined;
  const owned = new Map<string, Stats>();
  const sockets = new Set<Socket>(), closing = new Set<Promise<unknown>>(), work = new Set<Promise<unknown>>();
  const subscriptions = new Set<() => void>();
  const leases = new Map<string, Lease>();
  const expired = (lease: Lease) => !lease.socket && lease.pending === 0 && Date.now() - lease.idleAt >= 5 * 60_000;
  const socketPath = path.join(root, `b-${randomBytes(6).toString("hex")}.sock`);
  const descriptorPath = path.join(root, "descriptor.json");
  const tempPath = path.join(root, `.descriptor-${randomUUID()}`);
  let descriptor: Descriptor | undefined;
  const live = () => active && current();
  const remember = (file: string) => { const info = stat(file); if (info) owned.set(file, info); };
  const remove = (file: string) => {
    const info = owned.get(file), actual = stat(file), directory = stat(root);
    if (info && actual && directory && rootIdentity && identity(directory, rootIdentity) && identity(info, actual))
      unlinkSync(file);
    owned.delete(file);
  };
  const join = (set: Set<Promise<unknown>>, promise: Promise<unknown>) => {
    set.add(promise);
    promise.then(() => set.delete(promise), () => set.delete(promise));
    return promise;
  };
  const server = createServer(socket => {
    if (!live() || sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket);
    join(closing, new Promise<void>(resolve => socket.once("close", () => { sockets.delete(socket); resolve(); })));
    let view: View | undefined, clientId: string | undefined, lease: Lease | undefined, control = false, outstanding = 0;
    let activateControl: (selection: AgentSelection) => void = () => { throw new Error("forbidden"); };
    let subscription: { id: string; dispose(): void } | undefined;
    const stop = () => { subscription?.dispose(); subscription = undefined; };
    const ids = new Set<string>();
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      stop();
      if (lease?.socket === socket) { lease.socket = undefined; lease.idleAt = Date.now(); }
      if (view) join(work, view.close());
    });
    const send = (reply: unknown) => {
      if (!live() || socket.destroyed) return;
      const data = frame(reply, "Agent bridge");
      if (Buffer.byteLength(data) > replyBytes || socket.writableLength + Buffer.byteLength(data) > queueBytes) {
        socket.destroy(); return;
      }
      socket.write(data);
    };
    const receive = frames(value => {
      if (!live()) { socket.destroy(); return; }
      if (!isEnvelope(value)) { socket.destroy(); return; }
      // All untrusted fields are validated before touching a controller view.
      if (!isRequest(value)) {
        send(failure(value, capabilities.includes(value.method as "workers.list") || value.method === "connect"
          ? "invalid_request" : "unsupported_method"));
        return;
      }
      const request: Request = value;
      if (!descriptor || !sameOwner(request.owner, descriptor.owner)) { send(failure(request, "stale_owner")); return; }
      if (ids.has(request.id) || outstanding >= outstandingRequests) { socket.destroy(); return; }
      ids.add(request.id); outstanding++;
      const accepted = Promise.resolve().then(async () => {
        if (!live() || socket.destroyed) return;
        if (request.method === "connect") {
          if (view || request.params.expectedSessionId !== descriptor!.owner.coordinatorSessionId ||
              !timingSafeEqual(Buffer.from(request.params.token), Buffer.from(descriptor!.token))) {
            send(failure(request, "unauthorized")); return;
          }
          for (const [id, value] of leases) if (expired(value)) leases.delete(id);
          if (request.params.resumeToken !== undefined) {
            const previous = leases.get(request.clientId);
            if (!previous || !timingSafeEqual(Buffer.from(previous.token), Buffer.from(request.params.resumeToken))) {
              send(failure(request, "lease_expired")); return;
            }
            if (previous.socket) { send(failure(request, "busy")); return; }
            lease = previous;
          } else {
            if (leases.has(request.clientId)) { send(failure(request, "unauthorized")); return; }
            if (leases.size >= 16) { send(failure(request, "busy")); return; }
            lease = { token: randomBytes(32).toString("hex"), idleAt: Date.now(), pending: 0, highWater: 0, receipts: new Map() };
            leases.set(request.clientId, lease);
          }
          view = controller.openView({ control: false, bindControl: activate => { activateControl = activate; } });
          clientId = request.clientId; lease.socket = socket;
          send(success(request, { capabilities, grants: [], lease: { clientId, resumeToken: lease.token, highWater: lease.highWater } }));
        } else {
          if (!view || request.clientId !== clientId) { send(failure(request, "unauthorized")); return; }
          let installedSubscription = false;
          try {
            let page: unknown;
            switch (request.method) {
              case "workers.list": page = view.list(request.params.after, request.params.revision); break;
              case "subscribe": {
                if (subscription) throw new Error("busy");
                const id = randomUUID();
                let queued: NodeJS.Immediate | undefined, revision = 0;
                const installed = view.subscribe(value => {
                  revision = value;
                  queued ??= setImmediate(() => {
                    queued = undefined;
                    if (subscription?.id !== id || !installed.active || revision <= installed.snapshot.revision) return;
                    const hint = { version: 1, method: "changed", owner: descriptor!.owner,
                      clientId, subscriptionId: id, revision, refreshRequired: true };
                    if (isNotification(hint)) send(hint);
                    else socket.destroy();
                  });
                });
                const dispose = () => {
                  installed.dispose();
                  if (queued) clearImmediate(queued);
                  queued = undefined;
                  subscriptions.delete(dispose);
                };
                subscriptions.add(dispose);
                subscription = { id, dispose };
                installedSubscription = true;
                page = { subscriptionId: id, snapshot: installed.snapshot };
                break;
              }
              case "unsubscribe":
                if (subscription?.id !== request.params.subscriptionId) throw new Error("stale_reference");
                stop(); page = { subscriptionId: request.params.subscriptionId }; break;
              case "workers.detail": page = view.readDetail(request.params.id, request.params.cursor); break;
              case "workers.requests": page = view.readRequests(request.params.id, request.params.cursor); break;
              case "workers.activity": page = view.readActivity(request.params.ref, request.params.cursor); break;
              case "workers.result": page = view.readResult(request.params.ref, request.params.cursor); break;
              case "view.grant":
                if (!ceilings.includes(request.params.grant)) throw new Error("forbidden");
                if (request.params.grant === "control") { activateControl(request.params.selection); control = true; }
                else view.acknowledge(request.params.grant);
                page = { grant: request.params.grant, acknowledged: true }; break;
              case "request.status":
                page = lease!.receipts.get(request.params.sequence)?.status ?? {
                  state: request.params.sequence <= lease!.highWater ? "outcome_unknown" : "not_admitted", sequence: request.params.sequence };
                break;
              case "input":
              case "cancel": {
                const client = lease!, sequence = request.params.sequence, digest = mutationDigest(request);
                const previous = client.receipts.get(sequence);
                // Lookup/duplicate handling never performs another effect, even on a resumed read-only view.
                if (previous) {
                  if (previous.digest !== digest) throw new Error("sequence_conflict");
                  page = previous.status; break;
                }
                if (sequence <= client.highWater) { page = { state: "outcome_unknown", sequence }; break; }
                if (!ceilings.includes("control") || !control) throw new Error("forbidden");
                const alreadyPending = client.pending > 0;
                const admission: Admission = { digest, status: { state: "pending", sequence } };
                client.highWater = sequence; client.receipts.set(sequence, admission); client.pending++;
                if (client.receipts.size > 32) client.receipts.delete(client.receipts.keys().next().value!);
                const record = (receipt: unknown) => {
                  const result = { state: "recorded", sequence, receipt };
                  // Never truncate native evidence, and never resurrect an evicted callback.
                  admission.status = isMutationStatus(result) &&
                    Buffer.byteLength(JSON.stringify(success(request, result))) + 1 <= replyBytes
                    ? structuredClone(result) : { state: "outcome_unknown", sequence };
                };
                try {
                  if (alreadyPending) throw new Error("busy");
                  if (request.method === "input") {
                    await view.input(request.params.selection, request.params.input, native => record({ kind: "input", native }));
                  } else record({ kind: "cancel", native: view.cancel(request.params.selection) });
                } catch (error) {
                  // own() may reject the return after disconnect/retirement, but cannot erase an admitted native receipt.
                  if (admission.status.state === "pending") record({ kind: "error", code: errorCode(error) });
                } finally { client.pending--; if (!client.socket) client.idleAt = Date.now(); }
                page = admission.status;
                break;
              }
              case "route.read": {
                if (!ceilings.includes("route")) throw new Error("forbidden");
                const { state, ...raw } = view.route(request.params.id, request.params.offset, true);
                page = { state, page: raw }; break;
              }
              case "history.list":
              case "history.read": {
                if (request.method === "history.read" && !ceilings.includes("history")) throw new Error("forbidden");
                const { workerId, cursor, limit } = request.params;
                // Account for this exact complete envelope, retaining the smaller native page ceiling.
                const budget = Math.min(32 * 1024, replyBytes - Buffer.byteLength(JSON.stringify(success(request, null))) - 1);
                const query = request.method === "history.list" ? { action: "list" as const, cursor, limit } :
                  { action: "read" as const, historyId: request.params.historyId, groupId: request.params.groupId, cursor, limit };
                page = await view.history(query, workerId === undefined ? undefined : { instanceId: workerId }, budget);
                break;
              }
            }
            const reply = success(request, page);
            if (!isReply(reply, request.method)) throw new RangeError("worker read identity or projection exceeds wire contract");
            const bytes = Buffer.byteLength(JSON.stringify(reply)) + 1; // complete LF record
            if (request.method === "subscribe" && bytes > replyBytes) stop();
            send(bytes <= replyBytes ? reply : failure(request, "oversized"));
          } catch (error) {
            if (installedSubscription) stop();
            const code = errorCode(error);
            send(failure(request, !live() ? "stale_owner" : code));
          }
        }
      }).catch(() => socket.destroy()).finally(() => { ids.delete(request.id); outstanding--; });
      join(work, accepted);
    }, { label: "Agent bridge", fatalUtf8: true });
    socket.on("data", chunk => {
      try {
        if (typeof chunk === "string") throw new Error("Agent bridge requires byte framing");
        receive(chunk);
      } catch { socket.destroy(); }
    });
  });
  // No service work occurs until the owned lifetime can be installed by its caller.
  const ready = Promise.resolve().then(async () => {
    if (!live()) return;
    try {
      rootIdentity = privateRoot(root);
      if (Buffer.byteLength(socketPath) > 103)
        throw new Error("Agent bridge Unix socket path exceeds the OS limit; choose a shorter private directory");
      const view = controller.openView();
      try {
        descriptor = { version: 1, transport: "unix", socket: socketPath, token: randomBytes(32).toString("hex"),
          owner: view.list().owner, grants: ceilings, capabilities };
      } finally { await view.close(); }
      if (!live()) return;
      await new Promise<void>((resolve, reject) => {
        const error = () => { server.off("listening", listening); reject(new Error("Agent bridge Unix socket listen failed; check the private directory and OS path limit")); };
        const listening = () => { server.off("error", error); resolve(); };
        server.once("error", error); server.once("listening", listening);
        server.listen(socketPath);
      });
      remember(socketPath);
      chmodSync(socketPath, 0o600);
      if (!live()) return;
      const directory = stat(root);
      if (!directory || !identity(directory, rootIdentity)) throw new Error("Agent bridge directory changed during startup");
      writeFileSync(tempPath, JSON.stringify(descriptor) + "\n", { flag: "wx", mode: 0o600 });
      remember(tempPath);
      if (!live()) return;
      // link is atomic and refuses overwrite, unlike rename.
      linkSync(tempPath, descriptorPath);
      remember(descriptorPath);
      remove(tempPath);
    } catch (error) {
      active = false;
      for (const dispose of subscriptions) dispose();
      throw error;
    } finally {
      if (!live()) {
        for (const socket of sockets) socket.destroy();
        await closeServer();
        for (const file of [...owned.keys()]) remove(file);
      }
    }
  });
  const closeServer = async () => {
    if (!server.listening) return;
    const directory = stat(root), socket = stat(socketPath), created = owned.get(socketPath);
    // Node's Unix close unlinks its bound pathname itself. Do not ask it to
    // unlink a replacement object; retain the revoked listener for diagnosis.
    if (!directory || !rootIdentity || !identity(directory, rootIdentity) ||
        socket && (!created || !identity(socket, created)))
      throw new Error("Agent bridge ownership changed; revoked listener retained to avoid deleting unrelated resources");
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  // A retired/failed pending startup is still owned; avoid an unhandled rejection.
  void ready.catch(() => {});
  let settlement: Promise<void> | undefined;
  return {
    ready,
    revoke() {
      if (!active) return;
      active = false;
      for (const dispose of subscriptions) dispose();
      // Revoke admissions immediately; joining physical closure belongs to settle.
      for (const socket of sockets) socket.destroy();
    },
    settle() {
      if (settlement) return settlement;
      this.revoke();
      settlement = (async () => {
        await Promise.allSettled([ready]);
        await closeServer();
        while (work.size || closing.size) await Promise.allSettled([...work, ...closing]);
        leases.clear();
        for (const file of [...owned.keys()]) remove(file);
      })();
      void settlement.catch(() => { settlement = undefined; });
      return settlement;
    },
  };
}
