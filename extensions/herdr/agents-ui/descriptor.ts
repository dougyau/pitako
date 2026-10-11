import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { isDescriptor, type Descriptor } from "./protocol.ts";

export async function readDescriptor(file: string | undefined): Promise<Descriptor> {
  if (!file || !path.isAbsolute(file)) throw new Error("Open this pane from its owning Pi session; a private descriptor path is required");
  const parent = await lstat(path.dirname(file));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)
    throw new Error("Agent pane descriptor directory must be private and owned");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096)
      throw new Error("Agent pane descriptor must be a small, private, owned regular file");
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error("Agent pane descriptor exceeds 4096 bytes");
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (!isDescriptor(value) || path.dirname(value.socket) !== path.dirname(file))
      throw new Error("Unsupported agent pane descriptor; reopen from its owning Pi session");
    const socket = await lstat(value.socket);
    if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077) !== 0)
      throw new Error("Agent pane socket must be private and owned");
    return value;
  } finally { await handle.close(); }
}
