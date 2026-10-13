// Native Node consumer of the published package entry. Parent barriers select
// observations; this reader assembles and upserts only actual wire data.
import assert from "node:assert/strict";
import { on } from "node:events";
import { connect } from "../../extensions/agent/bridge/client.js";

const [descriptor, owner, id, toolError] = process.argv.slice(2);
const client = await connect(descriptor, { expectedSessionId: owner });
const detail = await client.publicDetail(id);
const ref = detail.bindings[0].ref;
const records = new Map();
const commands = on(process, "message");
let cursor;

async function read() {
  const parts = new Map();
  let pages = 0, fragments = 0, more;
  do {
    const page = await client.publicActivity(ref, cursor);
    assert.equal(page.state, "ready");
    assert.deepEqual(await client.publicActivity(ref, cursor), page);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 48 * 1024);
    assert.ok(page.changes.length <= 50);
    pages++;
    for (const change of page.changes) {
      let record;
      if (change.kind === "fragment") {
        fragments++;
        const key = `${change.id}:${change.revision}`;
        const chunks = parts.get(key) ?? [];
        assert.equal(chunks.reduce((n, chunk) => n + chunk.length, 0), change.byteOffset);
        chunks.push(Buffer.from(change.data, "base64"));
        parts.set(key, chunks);
        if (change.byteOffset + chunks.at(-1).length !== change.totalBytes) continue;
        record = JSON.parse(Buffer.concat(chunks).toString("utf8")).record;
        parts.delete(key);
      } else record = change.record;
      const old = records.get(record.id);
      if (!old || record.revision > old.revision) records.set(record.id, record);
      else if (record.revision === old.revision) assert.deepEqual(record, old);
    }
    cursor = page.next;
    more = page.more;
  } while (more && cursor);
  assert.equal(parts.size, 0);
  const tools = [...records.values()].filter(record => record.kind === "tool");
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.toolCallId, "real-tool-id");
  assert.equal(tool.payload.args.path, '漢😀"\\\n'.repeat(9000));
  const publicText = JSON.stringify([...records.values()]);
  assert.ok(!publicText.includes("PRIVATE_") && !publicText.includes("OFFLINE_MANAGED_CREDENTIAL"));
  return { pages, fragments, tool };
}

try {
  const initial = await read();
  assert.ok(initial.fragments > 1);
  assert.equal(initial.tool.payload.status, "updated");
  assert.equal(initial.tool.payload.result[0].text, "visible update");
  process.send({ phase: "live", node: process.version, pages: initial.pages, fragments: initial.fragments });
  // Serial phases avoid overlapping cursor reads. Disconnect has no worker effect.
  for await (const [command] of commands) {
    if (command === "exit") break;
    if (command === "tool") {
      const updated = await read();
      assert.equal(updated.tool.payload.status, toolError === "true" ? "error" : "completed");
      assert.equal(updated.tool.payload.result[0].text, toolError === "true" ? "visible tool error" : "visible result");
      process.send({ phase: "tool", records: records.size });
    } else if (command === "terminal") {
      await read();
      const terminal = await client.publicDetail(id);
      assert.equal(terminal.lifecycle.capture, "closed");
      const result = await client.publicResult(detail.ref);
      assert.equal(result.text.text, "repeat");
      assert.deepEqual(await client.publicResult(detail.ref), result);
      const repeated = [...records.values()].filter(record => record.kind === "message" &&
        record.payload.role === "assistant" && record.payload.blocks.some(block => block.type === "text" && block.text === "repeat"));
      assert.equal(repeated.length, 2);
      assert.notEqual(repeated[0].id, repeated[1].id);
      process.send({ phase: "terminal", messages: repeated.length, result: result.text.text });
      break;
    } else throw Error(`Unknown reader phase ${command}`);
  }
} finally {
  await commands.return();
  await client.disconnect();
  process.disconnect();
}
