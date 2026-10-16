import { connect } from "../../extensions/agent/bridge/client.js";
const client = await connect(process.argv[2], { expectedSessionId: process.argv[3] });
process.send({ ready: true, capabilities: client.capabilities, node: process.release.name });
process.on("message", async ({ id, method, args = [] }) => {
  try {
    const result = await client[method](...args);
    process.send({ id, result }, () => { if (method === "disconnect") process.disconnect(); });
  } catch (error) { process.send({ id, error: { code: error.code, message: error.message } }); }
});
