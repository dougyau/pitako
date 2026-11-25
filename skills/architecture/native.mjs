// Shared by the sandbox reducer and the deterministic observer; published prose never enters the cursor.
export function architectureNative(canonicalDigest) {
  const text = value => typeof value === "string" && value.trim().length > 0;
  function utf8Bytes(value) { return encodeURIComponent(value).replace(/%[0-9A-F]{2}|[^%]/g, "x").length; }
  const providerSchema = { type: "object", additionalProperties: false, required: ["status", "report"],
    properties: { status: { enum: ["ready", "blocked"] }, report: { type: "string", minLength: 1 } } };
  const doubtsSchema = { type: "object", additionalProperties: false, required: ["doubts", "humanContext"], properties: {
    humanContext: { type: "string" },
    doubts: { type: "array", maxItems: 80, items: { type: "object", additionalProperties: false,
      required: ["id", "dependsOn", "kind", "question", "decision"], properties: {
        id: { type: "string", maxLength: 32, pattern: "^[A-Za-z0-9_-]+$" },
        dependsOn: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", maxLength: 32 } },
        kind: { enum: ["scout", "researcher", "evidence-auditor", "human", "experiment", "deliberation"] },
        question: { type: "string", minLength: 1 }, decision: { type: "string", minLength: 1 },
        recommendation: { type: "string", minLength: 1 },
      } } },
  } };
  const decisionSchema = {
    type: "object", additionalProperties: false,
    required: ["action", "perspectives", "packet", "memo"],
    properties: {
      action: { enum: ["discuss", "finish", "blocked"] },
      perspectives: {
        type: "array", maxItems: 4,
        items: {
          type: "object", additionalProperties: false, required: ["id", "label", "focus"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$" },
            label: { type: "string", minLength: 1, maxLength: 64, maxJSONBytes: 128 },
            focus: { type: "string", minLength: 1 },
          },
        },
      },
      packet: { type: "string" },
      memo: { type: "string" },
    },
  };
  const reportSchema = {
    type: "object", additionalProperties: false, required: ["status", "report"],
    properties: {
      status: { enum: ["ready", "blocked"] },
      report: { type: "string", minLength: 1 },
    },
  };
  function validDoubts(doubts) {
    const factual = item => ["scout", "researcher", "evidence-auditor"].includes(item.kind);
    return doubts.filter(item => item.kind === "deliberation").length <= 8 && doubts.filter(factual).length <= 8 && doubts.filter(item => ["human", "experiment"].includes(item.kind)).length <= 64 &&
      new Set(doubts.map(item => item.id)).size === doubts.length && doubts.every(item =>
        (!factual(item) || item.dependsOn.length === 0) &&
        (!["human", "experiment"].includes(item.kind) || text(item.recommendation)) &&
        item.dependsOn.every(id => doubts.some(other => other.id === id && factual(other))));
  }

  function boundedText(value, bytes) {
    let result = String(value).slice(0, bytes - 2);
    while (utf8Bytes(JSON.stringify(result)) > bytes) result = result.slice(0, -1);
    return result;
  }
  // Each original pins its own run root; only normalized descendants can be reconstructed.
  function originalPath(original) {
    if (original.savedOutputPath) return original.savedOutputPath; // ephemeral caller-context reference
    const relative = original.relativePath;
    if (!relative) return undefined;
    const artifactRoot = original.artifactRoot;
    if (!artifactRoot || !validAbsolutePath(artifactRoot) || !validRelativePath(relative))
      throw new Error("Architecture original path traversal/outside-root: invalid retained artifact reference.");
    return artifactRoot + "/" + relative;
  }
  function validRelativePath(value) {
    return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") &&
      !value.split("/").some(part => !part || part === "." || part === "..");
  }
  function validAbsolutePath(value) { return typeof value === "string" && value.startsWith("/") && validRelativePath(value.slice(1)); }
  function relativeOriginal(file, requested) {
    if (!validAbsolutePath(file)) throw new Error("Architecture original path traversal/outside-root: published savedOutputPath must be normalized and absolute.");
    const artifactRoot = file.endsWith("/" + requested) ? file.slice(0, -requested.length - 1) : file.slice(0, file.lastIndexOf("/"));
    if (!validAbsolutePath(artifactRoot) || utf8Bytes(JSON.stringify(artifactRoot)) > 384)
      throw new Error("Architecture original path traversal/outside-root: artifact root exceeds 384 JSON bytes or is invalid; use a shorter artifact root.");
    const relative = file.startsWith(artifactRoot + "/") ? file.slice(artifactRoot.length + 1) : null;
    if (!validRelativePath(relative) || artifactRoot + "/" + relative !== file)
      throw new Error("Architecture original path traversal/outside-root: published savedOutputPath is outside the retained artifact root.");
    if (utf8Bytes(JSON.stringify(relative)) > 160) throw new Error("Architecture original relative path exceeds 160 JSON bytes; use a shorter artifact path.");
    return {relativePath: relative, artifactRoot};
  }

  function originalRef(original) { return { path: originalPath(original), digest: original.digest }; }

  const nativeControlFields = ["state", "stopped", "interrupted", "detached", "detachedReason", "timedOut",
    "exitCode", "processSignal", "terminalOutcome", "recovery", "outputPartial",
    "structuredOutputFailed", "turnBudgetExceeded", "toolBudgetBlocked", "timeoutRecovery", "error"];
  function retainedError(error) {
    // Native failure receipts append report output; report bodies never enter mission state.
    return typeof error === "string" ? error.split("\n\nOutput:\n")[0] : error;
  }
  function nativeReference(result) {
    const reference = {};
    for (const field of ["runId", "agent", "state"])
      if (text(result?.[field])) reference[field] = boundedText(result[field], field === "runId" ? 96 : 64);
    for (const receipt of [result, ...(result?.results ?? [])].filter(Boolean)) {
      for (const field of nativeControlFields)
        if (!["error", "state", "exitCode"].includes(field) && receipt[field]) reference[field] = true;
      if (receipt.exitCode !== undefined && receipt.exitCode !== 0) reference.exitCode = -1;
    }
    return reference;
  }

  function conforms(value, schema) {
    if (schema.nullable && value === null) return true;
    if (schema.integer) return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
    if (schema.type === "boolean") return typeof value === "boolean";
    if (schema.type === "number") return Number.isInteger(value) && value >= 0 && value <= 255;
    if (schema.const !== undefined && value !== schema.const) return false;
    if (schema.enum && !schema.enum.includes(value)) return false;
    if (schema.type === "object") return value !== null && typeof value === "object" && !Array.isArray(value) &&
      (!schema.required || schema.required.every(key => Object.hasOwn(value, key))) &&
      Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties ?? {}, key)
        ? conforms(item, schema.properties[key]) : schema.additionalProperties !== false);
    if (schema.type === "array") return Array.isArray(value) &&
      (schema.maxItems === undefined || value.length <= schema.maxItems) &&
      (!schema.uniqueItems || new Set(value.map(item => JSON.stringify(item))).size === value.length) &&
      value.every(item => conforms(item, schema.items));
    if (schema.type === "string") return typeof value === "string" &&
      (schema.minLength === undefined || value.trim().length >= schema.minLength) &&
      (schema.maxLength === undefined || (schema.utf8 ? utf8Bytes(value) : value.length) <= schema.maxLength) &&
      (schema.maxJSONBytes === undefined || utf8Bytes(JSON.stringify(value)) <= schema.maxJSONBytes) &&
      (!schema.pattern || new RegExp(schema.pattern).test(value));
    return true;
  }

  function projectNativeOriginal(contract, result) {
    const {key, consultation, revision, attempt} = contract.association;
    const value = result?.structuredOutput;
    const children = result?.results ?? [];
    const diagnostics = [];
    const receipts = [result, ...children].filter(Boolean);
    const successfulStates = ["complete", "completed"];
    const pendingStates = ["running", "queued", "pending", "starting"];
    const nonterminal = receipts.some(receipt => receipt.detached || pendingStates.includes(receipt.state));
    const controlFailure = receipts.some(receipt => receipt.stopped || receipt.interrupted || receipt.timedOut ||
      receipt.detached || receipt.processSignal || receipt.recovery ||
      ["cancelled", "stopped"].includes(receipt.state) ||
      ["timed-out", "stopped"].includes(receipt.timeoutRecovery?.termination) || receipt.timeoutRecovery?.recoveryNeeded ||
      receipt.outputPartial || receipt.structuredOutputFailed || receipt.turnBudgetExceeded || receipt.toolBudgetBlocked ||
      // pi-subagents reports terminalOutcome only for partial closure (budget or timeout).
      receipt.terminalOutcome !== undefined ||
      /\bStop\b|Blocked by pi-subagents permission rule:/i.test(receipt.error ?? ""));
    const nativeFailure = nonterminal || controlFailure || receipts.some(receipt =>
      (receipt.exitCode !== undefined && receipt.exitCode !== 0) ||
      (receipt.state !== undefined && !successfulStates.includes(receipt.state)));
    // Native identity witnesses must agree with the requested producer. Missing optional metadata is distinct.
    const producerMatches = (result?.key === undefined || result.key === key) &&
      (result?.agent === undefined || result.agent === contract.agent) && children.every(child =>
        (child.agent === undefined || child.agent === contract.agent) &&
        (child.workflowKey === undefined || child.workflowKey === key) &&
        (child.key === undefined || child.key === key) &&
        (child.runId === undefined || child.runId === result.runId));
    // A returned terminal failed/partial value can be complete delivery without being
    // successful work. A detached/running receipt cannot confirm terminal settlement.
    const terminal = typeof result?.ok === "boolean" && !nonterminal &&
      (result.state === undefined || ["complete", "completed", "failed", "cancelled", "stopped"].includes(result.state)) && text(result?.runId);
    const complete = terminal && !receipts.some(receipt => receipt.outputPartial || receipt.structuredOutputFailed) && producerMatches && conforms(value, contract.schema);
    let publication = terminal && utf8Bytes(JSON.stringify(result.runId)) <= 96 && !result.outputSaveError &&
      children.some(child => text(child.savedOutputPath) && utf8Bytes(JSON.stringify(child.savedOutputPath)) <= 1024) && !children.some(child => child.outputSaveError);
    let reference;
    const publishedChild = children.find(child => text(child.savedOutputPath) && !child.outputSaveError && utf8Bytes(JSON.stringify(child.savedOutputPath)) <= 1024);
    if (publishedChild) {
      try { reference = relativeOriginal(publishedChild.savedOutputPath,
        `architecture/${consultation}/v${revision}/${key}-a${attempt}.json`); }
      catch (error) { publication = false; diagnostics.push(error.message); }
    }
    const failedOriginal = !publication && complete ? value : undefined;
    for (const receipt of receipts) if (receipt.error) diagnostics.push(retainedError(receipt.error));
    let barrier;
    if (nativeFailure) {
      const diagnostic = "Native control failure: " + JSON.stringify(nativeReference(result)) +
        receipts.filter(receipt => receipt.error).map(receipt => "; " + retainedError(receipt.error)).join("");
      diagnostics.push(diagnostic);
      // An ordinary terminal failed analysis may be explicitly retried. Control
      // barriers and contradictory success receipts never authorize that route.
      if (nonterminal || controlFailure || result?.ok) {
        barrier = { key, diagnostic: boundedText(diagnostic, 512) };
      }
    }

    if (result?.outputSaveError) diagnostics.push("Mandatory native publication failure: " + result.outputSaveError);
    for (const child of children) if (child.outputSaveError)
      diagnostics.push("Mandatory native publication failure: " + child.outputSaveError);
    if (!producerMatches) diagnostics.push("Native producer association mismatch.");
    const access = complete && contract.access;
    const adequate = complete && access && (value.status === "ready" || value.action !== undefined || Array.isArray(value.doubts));
    const entry = { id: contract.id, ...contract.association, ...nativeReference(result),
      ...(reference ?? {}),
      terminal: terminal ? (result.ok && !nativeFailure ? "succeeded" : "failed") : "unconfirmed",
      status: result?.ok && !nativeFailure && publication && adequate ? "sufficient" : "failed",
      publication: publication ? "published" : "unpublished", delivery: complete ? "complete" : value === undefined ? "not-delivered" : "unproved",
      accessibility: publication ? "unverified" : "unknown",
      essentialAccess: access ? "accessible" : "incomplete", sufficient: Boolean(result?.ok && !nativeFailure && publication && adequate),
      ...(!(result?.ok && !nativeFailure && publication && adequate) ? { diagnostic: boundedText([...diagnostics, ...(!complete ? ["Original completeness/schema/association not demonstrated."]
        : !publication ? ["Mandatory native publication not demonstrated."] : !access ? ["Essential access incomplete or contradictory."] : !adequate ? ["Analysis is blocked or inadequate."] : [])].join("; "), 512) } : {}),
      ...(failedOriginal ? { failedDelivery: true } : {}),
    };
    return {entry, barrier};
  }

  function confirmNativeOriginal(entry, intent, result) {
    intent.terminal = entry.terminal;
    intent.boundary = entry.terminal !== "unconfirmed" && entry.delivery === "complete" &&
      (entry.publication === "published" || entry.failedDelivery === true) ? "confirmed" : "incomplete";
    intent.runId = entry.runId ?? null;
    if (entry.delivery === "complete") {
      const value = result.structuredOutput;
      if (Array.isArray(value.doubts) && !validDoubts(value.doubts)) {
        intent.boundary = "incomplete";
        intent.invalid = "factual-count";
        return;
      }
      entry.digest = canonicalDigest(JSON.parse(JSON.stringify(value)));
      intent.controlOutput = value.action !== undefined
        ? { action: value.action, perspectives: value.action === "discuss" ? value.perspectives.map(({id, label}) => ({id, label})) : [], hasPacket: text(value.packet), hasMemo: text(value.memo) }
        : Array.isArray(value.doubts) ? { doubts: value.doubts.map(({id, kind, dependsOn}) => ({id, kind, dependsOn: value.doubts.filter(item => ["scout", "researcher", "evidence-auditor"].includes(item.kind)).reduce((mask, fact, i) => mask | (dependsOn.includes(fact.id) ? 1 << i : 0), 0)})) }
        : { status: value.status };
    }
  }

  function architectureOutputSchema(phase) {
    if (phase === "architecture-doubts") return doubtsSchema;
    if (phase === "architecture-prepare" || phase === "architecture-evaluate") return decisionSchema;
    if (phase === "architecture-factual") return { ...providerSchema,
      required: [...providerSchema.required, "humanContext"],
      properties: { ...providerSchema.properties, humanContext: { type: "string", minLength: 1 } } };
    return reportSchema;
  }
  function observeSlotRefs(value) {
    const {consultation, currentDecision: {revision}, rounds, cursor} = value;
    return cursor.dispatches.map(({key, attempt, runId, terminal, digest}) => {
      let phase, producer, round;
      let match;
      if (key === "director-prepare") {
        phase = "architecture-prepare"; producer = "director";
        round = cursor.control.round === null || cursor.control.stage === "prepare" ? rounds : rounds - 1;
      } else if ((match = /^r(10|[1-9])-([A-Za-z0-9][A-Za-z0-9_-]{0,31})$/.exec(key))) {
        phase = "architecture-perspective"; [, round, producer] = match;
      } else if ((match = /^director-(doubts|after)-r(10|[1-9])$/.exec(key))) {
        phase = match[1] === "doubts" ? "architecture-doubts" : "architecture-evaluate";
        producer = match[1] === "doubts" ? "director-doubts" : "director"; round = match[2];
      } else if ((match = /^doubts-r(10|[1-9])-([0-7])$/.exec(key))) {
        phase = "architecture-factual"; round = match[1];
        // The producer is part of the verified doubts projection, not cursor data.
        producer = null;
      } else throw new Error("Invalid architecture continuation cursor dispatch key.");
      return {association: {consultation, revision, key, attempt, round: Number(round), phase, producer},
        runId, terminal, digest};
    });
  }
  return { providerSchema, doubtsSchema, decisionSchema, reportSchema, boundedText, originalPath, relativeOriginal, originalRef, observeSlotRefs, retainedError, nativeReference, conforms, projectNativeOriginal, confirmNativeOriginal, architectureOutputSchema };
}

export const architectureNativeSource = `const { providerSchema, doubtsSchema, decisionSchema, reportSchema, boundedText, originalPath, relativeOriginal, originalRef, observeSlotRefs, retainedError, nativeReference, conforms, projectNativeOriginal, confirmNativeOriginal, architectureOutputSchema } = (${architectureNative.toString()})(canonicalDigest);\n`;
