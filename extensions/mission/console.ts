import { createServer, type Server } from "node:net";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** Local operator entry point. Pi prompts and extension input handlers never reach this server. */
export async function openMissionConsole(directory: string, submit: (text: string, causalId: ReturnType<typeof randomUUID>) => Promise<string>,
  visible?: (causalId: string, responseMs: number) => void): Promise<{ path: string; close(): Promise<void> }> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const socketPath = path.join(directory, `operator-${process.pid}-${randomUUID()}.sock`);
  const secretPath = `${socketPath}.key`;
  const secret = randomBytes(32);
  writeFileSync(secretPath, secret, { mode: 0o600, flag: "wx" });
  let pending = Promise.resolve();
  const awaitingDisplay = new Map<string, number>();
  const server: Server = createServer((socket) => {
    let bytes = "";
    socket.setEncoding("utf8");
    socket.on("error", () => { /* disconnected client cannot confirm display */ });
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("data", (chunk: string) => {
      bytes += chunk;
      if (bytes.length > 64 * 1024) { socket.destroy(new Error("operator input too long")); return; }
      if (!bytes.endsWith("\n")) return;
      pending = pending.then(async () => {
        const causalId = randomUUID();
        const began = performance.now();
        try {
          const frame: unknown = JSON.parse(bytes);
          if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("invalid operator frame");
          const proof = (frame as { proof?: unknown }).proof;
          if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof) ||
            !timingSafeEqual(Buffer.from(proof, "hex"), secret)) throw new Error("operator console credential required");
          const displayId = (frame as { visibleId?: unknown }).visibleId;
          if (typeof displayId === "string") {
            const started = awaitingDisplay.get(displayId);
            if (started === undefined) throw new Error("response has no pending display");
            awaitingDisplay.delete(displayId);
            visible?.(displayId, performance.now() - started);
            socket.end(JSON.stringify({ ok: true, message: "display recorded", causalId: displayId }) + "\n");
            return;
          }
          const text = (frame as { text: unknown }).text;
          if (typeof text !== "string" || !text.trim()) throw new Error("empty operator input");
          socket.setTimeout(30_000);
          const message = await submit(text, causalId);
          if (visible) {
            for (const [id, at] of awaitingDisplay) if (began - at > 60_000) awaitingDisplay.delete(id);
            awaitingDisplay.set(causalId, began);
          }
          socket.end(JSON.stringify({ ok: true, message, causalId, responseMs: performance.now() - began }) + "\n");
        } catch (error) { socket.end(JSON.stringify({ ok: false, message: String(error), causalId, responseMs: performance.now() - began }) + "\n"); }
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
  } catch (error) { server.close(); rmSync(secretPath, { force: true }); throw error; }
  return { path: socketPath, close: async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pending;
    rmSync(socketPath, { force: true });
    rmSync(secretPath, { force: true });
  } };
}
