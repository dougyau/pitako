import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const socket = process.argv[2];
if (!socket || !process.stdin.isTTY) {
  console.error("Usage: bun scripts/mission-console.ts <socket-path> (interactive terminal required)");
  process.exit(2);
}
const proof = readFileSync(`${socket}.key`).toString("hex");
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  while (true) {
    let text: string;
    try { text = await terminal.question("mission> "); } catch { break; }
    if (text === "/exit") break;
    if (!text.trim()) continue;
    const response = await new Promise<string>((resolve, reject) => {
      const client = connect(socket);
      let result = "";
      client.setEncoding("utf8");
      client.on("connect", () => client.write(JSON.stringify({ text, proof }) + "\n"));
      client.on("data", (part: string) => { result += part; });
      client.on("end", () => resolve(result));
      client.on("error", reject);
    });
    const reply = JSON.parse(response) as { ok: boolean; message: string; causalId: string };
    await new Promise<void>((resolve, reject) => process.stdout.write(`${reply.message}\n`, (error) => error ? reject(error) : resolve()));
    if (reply.ok) {
      const client = connect(socket);
      let acknowledgement = "";
      client.on("data", (part) => { acknowledgement += part; });
      client.on("end", () => { if (acknowledgement && !JSON.parse(acknowledgement).ok) console.error(`Display observation unavailable: ${acknowledgement}`); });
      client.on("connect", () => client.write(JSON.stringify({ proof, visibleId: reply.causalId }) + "\n"));
      client.on("error", (error) => console.error(`Display observation unavailable: ${error}`));
    }
  }
} finally { terminal.close(); }
