import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { createAgentController } from "../../agent/controller.ts";
import { frame, frames, isRequest, sameOwner, type Descriptor, type LocalView, type Operation } from "./protocol.ts";

export interface PaneGrants { control: boolean; rawHistory: boolean }
/** The capability identifies these server-owned grants, not flags supplied by a client. */
export async function createAgentBroker(controller: ReturnType<typeof createAgentController>, grants: PaneGrants,
  runtimeRoot = os.tmpdir()) {
  if (!path.isAbsolute(runtimeRoot)) throw new Error("Agent pane runtime root must be absolute");
  const probe = controller.openView();
  let owner;
  try { owner = probe.list().owner; } finally { await probe.close(); }
  const root = await mkdtemp(path.join(runtimeRoot, "pitako-pane-"));
  const socketPath = path.join(root, "s");
  const descriptorPath = path.join(root, "connection.json");
  if (Buffer.byteLength(socketPath) > 103) { await rm(root, { recursive: true }); throw new Error("Agent pane absolute Unix socket path exceeds 103 bytes"); }
  let active = true;
  const sockets = new Set<Socket>(), work = new Set<Promise<unknown>>();
  const views = new Set<LocalView>();
  const permissions = Object.freeze({ ...grants });
  const descriptor: Descriptor = { version: 1, socket: socketPath, owner, capability: randomBytes(32).toString("hex") };
  async function dispatch(view: LocalView, op: Operation) {
    if (!active) throw new Error("Agent pane owner is retired");
    switch (op.op) {
      case "list": return view.list(op.after);
      case "detail": {
        const detail = view.detail(op.id, op.briefOffset, op.activityAfter);
        if (!permissions.control) detail.controls = { available: false, reason: "Pane is read-only; close/reopen with --control" };
        return detail;
      }
      case "observe": return view.observe(op.selection, op.options);
      case "requests": return view.requests(op.id, op.offset);
      case "route":
        if (!permissions.rawHistory) throw new Error("Pane has no raw-history grant");
        return view.route(op.id, op.offset);
      case "history":
        if (op.query.action === "read" && !permissions.rawHistory) throw new Error("Pane has no raw-history grant");
        return view.history(op.query, op.worker);
      case "acknowledge":
        if (!permissions.rawHistory) throw new Error("Pane has no raw-history grant");
        view.acknowledge(op.kind); return null;
      case "input":
        if (!permissions.control) throw new Error("Pane is read-only");
        return view.input(op.selection, op.input);
      case "cancel":
        if (!permissions.control) throw new Error("Pane is read-only");
        return view.cancel(op.selection);
      case "close": await view.close(); return null;
    }
  }
  const server = createServer(socket => {
    if (!active || sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket);
    let view: LocalView;
    try { view = controller.openView(); views.add(view); }
    catch { socket.destroy(); sockets.delete(socket); return; }
    let busy = false;
    const receive = frames(value => {
      if (busy || !active || !isRequest(value) || !sameOwner(value.owner, owner) || value.capability !== descriptor.capability) {
        socket.destroy(); return;
      }
      busy = true;
      const accepted = (async () => {
        const send = (reply: unknown) => new Promise<void>((resolve, reject) => {
          socket.write(frame(reply), error => error ? reject(error) : resolve());
        });
        try {
          const result = await dispatch(view, value.operation);
          if (!socket.destroyed && active) await send({ version: 1, id: value.id, result: result ?? null });
        } catch (error) {
          if (!socket.destroyed && active) await send({ version: 1, id: value.id, error: String(error).slice(0, 2048) });
        } finally {
          busy = false;
          if (value.operation.op === "close") socket.end();
        }
      })();
      work.add(accepted);
      accepted.then(() => work.delete(accepted), () => { work.delete(accepted); socket.destroy(); });
    });
    socket.on("data", chunk => { try { receive(Buffer.from(chunk)); } catch { socket.destroy(); } });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      const closing = view.close();
      work.add(closing);
      closing.finally(() => { work.delete(closing); views.delete(view); });
    });
  });
  const revoke = () => {
    active = false;
    for (const socket of sockets) socket.destroy();
    // Controller retirement is separately synchronous at the coordinator boundary.
    for (const view of views) { const closing = view.close(); work.add(closing); closing.finally(() => work.delete(closing)); }
  };
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    revoke();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // close callbacks may add the final view joins while server.close settles.
    while (work.size) await Promise.allSettled([...work]);
    await rm(root, { recursive: true });
  })();
  server.on("error", () => {});
  try {
    await chmod(root, 0o700);
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      server.once("error", fail);
      server.listen(socketPath, () => { server.off("error", fail); resolve(); });
    });
    await chmod(socketPath, 0o600);
    await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600, flag: "wx" });
  } catch (error) {
    revoke();
    if (server.listening) await close();
    else await rm(root, { recursive: true });
    throw error;
  }
  return { descriptorPath, revoke, close };
}
