import { createConnection, type Socket } from "node:net";
import { readDescriptor } from "./descriptor.ts";
import { frame, frames, isReply, sameOwner, type Descriptor, type Operation, type PaneView, type LocalView } from "./protocol.ts";

/** One connection, one outstanding request. Disconnect never retries or replays a mutation. */
export async function connectAgentPane(file: string): Promise<PaneView & { disconnect(): Promise<void> }> {
  const descriptor = await readDescriptor(file);
  let socket!: Socket;
  let sequence = 0, connected = false, closed = false;
  let lastObserved = Date.now();
  let pending: { id: number; mutation: boolean; resolve(value: unknown): void; reject(error: Error): void } | undefined;
  const disconnected = () => {
    connected = false;
    pending?.reject(new Error(pending.mutation
      ? "Unknown mutation outcome: acknowledgment lost; do not replay. Reobserve markers; absence is not non-delivery."
      : "Agent pane disconnected; displayed data is stale"));
    pending = undefined;
  };
  async function attach(value: Descriptor) {
    socket = createConnection(value.socket);
    socket.on("error", () => {});
    socket.on("close", disconnected);
    const receive = frames(value => {
      if (!isReply(value) || !pending || value.id !== pending.id) { socket.destroy(); return; }
      const request = pending; pending = undefined;
      lastObserved = Date.now();
      if ("error" in value) request.reject(new Error(value.error));
      else request.resolve(value.result);
    });
    socket.on("data", chunk => { try { receive(Buffer.from(chunk)); } catch { socket.destroy(); } });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    connected = true;
  }
  function request<T>(operation: Operation): Promise<T> {
    if (closed || !connected) return Promise.reject(new Error("Agent pane is disconnected; explicit reconnect required"));
    if (pending) return Promise.reject(new Error("Agent pane has outstanding work"));
    return new Promise<T>((resolve, reject) => {
      const id = ++sequence;
      pending = { id, mutation: operation.op === "input" || operation.op === "cancel", resolve: value => resolve(value as T), reject };
      try { socket.write(frame({ version: 1, id, capability: descriptor.capability, owner: descriptor.owner, operation })); }
      catch (error) { pending = undefined; reject(error); }
    });
  }
  await attach(descriptor);
  try {
    const listed = await request<ReturnType<LocalView["list"]>>({ op: "list" });
    if (!sameOwner(listed.owner, descriptor.owner)) throw new Error("Agent pane owner fence changed");
  } catch (error) { socket.destroy(); throw error; }
  const disconnect = async () => {
    if (!socket.destroyed) await new Promise<void>(resolve => { socket.once("close", resolve); socket.destroy(); });
  };
  return {
    disconnect,
    connection: () => connected ? "" : `STALE · owner ${descriptor.owner.coordinatorSessionId} / ${descriptor.owner.epoch} · last reply ${new Date(lastObserved).toISOString()} · controls disabled · R reconnect`,
    async reconnect() {
      if (closed || connected || pending) throw new Error("Reconnect requires a disconnected idle view");
      const current = await readDescriptor(file);
      if (!sameOwner(current.owner, descriptor.owner) || current.capability !== descriptor.capability || current.socket !== descriptor.socket)
        throw new Error("Agent pane owner changed; close and launch a new pane");
      await attach(current);
      const listed = await request<ReturnType<LocalView["list"]>>({ op: "list" });
      if (!sameOwner(listed.owner, descriptor.owner)) { socket.destroy(); throw new Error("Agent pane owner fence changed"); }
    },
    list: after => request({ op: "list", after }),
    detail: (id, briefOffset, activityAfter) => request({ op: "detail", id, briefOffset, activityAfter }),
    observe: (selection, options) => request({ op: "observe", selection, options }),
    requests: (id, offset) => request({ op: "requests", id, offset }),
    route: (id, offset) => request({ op: "route", id, offset }),
    history: (query, worker) => request({ op: "history", query, worker }),
    input: (selection, input) => request({ op: "input", selection, input }),
    cancel: selection => request({ op: "cancel", selection }),
    acknowledge: kind => request({ op: "acknowledge", kind }),
    async close() {
      closed = true;
      // The host joins its screen work first. A pending direct client caller receives uncertainty, not replay.
      await disconnect();
    },
  };
}
