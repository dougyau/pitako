import { expect, test } from "bun:test";
import { architectureFixture } from "./fixtures/architecture.ts";

const { fixture, setup } = architectureFixture();

test("public definition refresh captures A and rejects its wrapped callback during B before B corrections", fixture.ownedCase("submit definition generations", async () => {
  let definitionA: any, wrappedA: any, checked = false;
  const s = await setup({ config: "", async prompt(session, request, body) {
    const definition = session.boundTools.get("architecture_submit");
    if (request.stage === "composition") {
      definitionA = definition;
      wrappedA = (...args: any[]) => definitionA.execute(...args);
      return { ...body, specialists: [] };
    } else if (request.stage === "preparation" && !checked) {
      checked = true;
      expect(definition).not.toBe(definitionA);
      const ctx = { sessionManager: session.sessionManager };
      // This executes inside B's native prompt context, with B's body and caller.
      const stale = await wrappedA("looks-current", { body }, undefined, undefined, ctx);
      expect(stale.isError).toBe(true);
      expect(stale.content[0].text).toContain("definition generation");
      const rejected = await definition.execute("B-invalid", { body: { ...body, extra: true } }, undefined, undefined, ctx);
      expect(rejected.details.correctionsLeft).toBe(1);
    }
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Prove bound executable generations" });
    expect(start.isError).not.toBe(true);
    await s.delivered.promise;
    const result = await s.read("team_result", { assignmentId: start.details.assignmentId });
    if (result.host.status !== "completed") console.log(JSON.stringify(result));
    expect(result.host.status).toBe("completed");
    expect(checked).toBe(true);
  } finally { await s.close(); }
}));

// Real codemode executable, with the controlled native executeTool boundary only.
// No SDK session driver or model/provider request is involved.
test("direct, nested and codemode share refreshed executable identity and body idempotency", fixture.ownedCase("submit routes", async () => {
  const { createCodemodeExtension } = await import("@earendil-works/pi-coding-agent");
  let old: any, checked = false;
  const s = await setup({ config: "", configure(host) {
    host.factories.createCodemode = options => createCodemodeExtension({ ...options, models: false, inlineBudget: 0 });
  }, async prompt(session, request, body) {
    const current = session.boundTools.get("architecture_submit"), ctx: any = { sessionManager: session.sessionManager };
    if (request.stage === "composition") { old = current; return { ...body, specialists: [] }; }
    if (request.stage !== "preparation") return;
    checked = true;
    let selected = old, sequence = 0;
    ctx.tools = [current];
    ctx.executeTool = async (name: string, value: any, options: any = {}) => {
      expect(name).toBe("architecture_submit");
      const id = `native-parent/${++sequence}`;
      const result = await selected.execute(id, value, options.signal, undefined, ctx);
      return { toolCall: { id, name, arguments: value }, result, isError: result.isError === true };
    };
    const codemode = session.boundTools.get("codemode");
    const code = `return await tools.architecture_submit(${JSON.stringify({ body })})`;
    const staleNested = await ctx.executeTool("architecture_submit", { body });
    expect(staleNested.result.content[0].text).toContain("definition generation");
    const staleCode = await codemode.execute("code-A", { code }, undefined, undefined, ctx);
    expect(staleCode.isError).toBe(true);
    expect(staleCode.content.map((block: any) => block.text).join("\n")).toContain("definition generation");
    selected = current;
    const rejected = await ctx.executeTool("architecture_submit", { body: { ...body, extra: true } });
    expect(rejected.result.details.correctionsLeft).toBe(1);
    const accepted = await current.execute("direct-B", { body }, undefined, undefined, ctx);
    expect(accepted.isError).not.toBe(true);
    expect((await ctx.executeTool("architecture_submit", { body })).result.details).toEqual(accepted.details);
    const codeResult = await codemode.execute("code-B", { code }, undefined, undefined, ctx);
    expect(codeResult.isError).not.toBe(true);
    expect(codeResult.content.map((block: any) => block.text).join("\n")).toContain(accepted.details.id);
    return false;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Submit route equivalence" });
    await s.delivered.promise;
    expect((await s.read("team_result", { assignmentId: start.details.assignmentId })).host.status).toBe("completed");
    expect(checked).toBe(true);
  } finally { await s.close(); }
}));

test("exhaustion returns from its callback, then joins only that attempt's prompt, abort and disposal", fixture.ownedCase("submit exhaustion ownership", async () => {
  const callbackReturned = Promise.withResolvers<void>(), abortEntered = Promise.withResolvers<void>();
  const releasePrompt = Promise.withResolvers<void>(), promptSettled = Promise.withResolvers<void>();
  const disposalEntered = Promise.withResolvers<void>(), releaseDisposal = Promise.withResolvers<void>();
  fixture.finishOnCleanup(() => { releasePrompt.resolve(); releaseDisposal.resolve(); });
  let child: any, directorAborts = 0;
  const s = await setup({ bind(session) {
    if (session.model?.id !== "chosen") return;
    child = session;
    const prompt = session.prompt.bind(session);
    session.prompt = async (text: string) => { try { await prompt(text); } finally { promptSettled.resolve(); } };
  }, async prompt(session, request, body) {
    if (session.model.id !== "chosen" || request.stage !== "preparation") return;
    const submit = session.boundTools.get("architecture_submit"), ctx = { sessionManager: session.sessionManager };
    const first = await submit.execute("bad-one", { body: { ...body, extra: "first" } }, undefined, undefined, ctx);
    expect(first.details.correctionsLeft).toBe(1);
    const duplicate = await submit.execute("bad-one-again", { body: { ...body, extra: "first" } }, undefined, undefined, ctx);
    expect(duplicate).toEqual(first);
    const last = await submit.execute("bad-two", { body: { ...body, extra: "second" } }, undefined, undefined, ctx);
    expect(last.details.correctionsLeft).toBe(0);
    callbackReturned.resolve();
    await releasePrompt.promise;
    return false;
  }, async abort(session) {
    if (session.model?.id !== "chosen") { directorAborts++; return; }
    abortEntered.resolve();
    await callbackReturned.promise;
    await promptSettled.promise; // Native abort's idle join must never be awaited by execute().
  }, async dispose(session) {
    if (session !== child) return;
    disposalEntered.resolve(); await releaseDisposal.promise;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Exhaust only the owned attempt" });
    await callbackReturned.promise; await abortEntered.promise;
    expect(child.events).not.toContain("dispose");
    expect(s.sent.some(item => item.message.customType === "pitako.worker.result")).toBe(false);
    releasePrompt.resolve(); await disposalEntered.promise;
    expect(s.sent.some(item => item.message.customType === "pitako.worker.result")).toBe(false);
    releaseDisposal.resolve(); await s.delivered.promise;
    const result = await s.read("team_result", { assignmentId: start.details.assignmentId });
    expect(result.host.status).toBe("failed"); expect(result.host.closure.state).toBe("released");
    expect(directorAborts).toBe(0);
    expect(s.seen.some(item => item.request.stage === "synthesis")).toBe(true);
  } finally { releasePrompt.resolve(); releaseDisposal.resolve(); await s.close(); }
}));

test("a provisional receipt and settled publication do not claim native persistence before append", fixture.ownedCase("submit native append", async () => {
  const { readFileSync } = await import("node:fs");
  const provisional = Promise.withResolvers<{ session: any; receipt: any }>(), releasePrompt = Promise.withResolvers<void>();
  fixture.finishOnCleanup(releasePrompt.resolve);
  const s = await setup({ config: "", prompt(_session, request, body) {
    if (request.stage === "composition") return { ...body, specialists: [] };
  }, async afterSubmit(session, request, receipt) {
    if (request.stage !== "composition") return;
    provisional.resolve({ session, receipt }); await releasePrompt.promise;
  } });
  try {
    const start = await s.invoke("architecture_start", { goal: "Distinct submission and persistence boundaries" });
    const { session, receipt } = await provisional.promise;
    expect(receipt.details.state).toBe("provisional");
    expect((await s.read("architecture_read", { roomId: start.details.roomId })).messages).toEqual([]);
    const toolResults = () => session.sessionManager.getBranch().filter((entry: any) => entry.type === "message" && entry.message.role === "toolResult");
    expect(toolResults()).toEqual([]);
    const message = { role: "toolResult", toolCallId: "native-submit", toolName: "architecture_submit",
      content: receipt.content, details: receipt.details, isError: false, timestamp: Date.now() };
    session.emit({ type: "message_end", message });
    expect(toolResults()).toEqual([]); // Native message_end can precede append.
    const nativeEntryId = session.sessionManager.appendMessage(message as never);
    expect(toolResults().map((entry: any) => entry.id)).toEqual([nativeEntryId]);
    expect((await s.read("architecture_read", { roomId: start.details.roomId })).messages).toEqual([]);
    releasePrompt.resolve(); await s.delivered.promise;
    const messages = (await s.read("architecture_read", { roomId: start.details.roomId })).messages;
    const composition = messages.find((item: any) => item.stage === "composition");
    expect(composition.submission).toMatchObject({ version: 2, provenance: "host-bound", compositionBasis: { candidateRefs: [], retainableMemberIds: [] } });
    expect(composition.body).not.toHaveProperty("snapshotId");
    expect(composition.native).toMatchObject({ toolCallId: "native-submit", persistence: "unconfirmed" });
    const persisted = readFileSync(session.sessionFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(persisted.find(entry => entry.id === nativeEntryId)).toMatchObject({ type: "message", message: { role: "toolResult", toolCallId: "native-submit", details: { state: "provisional" } } });
  } finally { releasePrompt.resolve(); await s.close(); }
}));
