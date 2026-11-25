// One contract for the named resolver, sandbox and deterministic writer.
export function reviewCursorContract() {
  const key = "pitako-review";
  const hash = {type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]+$"};
  const str = (maxLength, pattern) => ({type: "string", minLength: 1, maxLength, ...(pattern ? {pattern} : {})});
  const object = properties => ({type: "object", additionalProperties: false, required: Object.keys(properties), properties});
  const nullable = schema => ({...schema, nullable: true});
  const bool = {type: "boolean"};
  const outcomes = {enum: ["completed", "blocked", "failed"]};
  const ref = object({
    key: str(128, "^[A-Za-z0-9][A-Za-z0-9._-]*$"),
    runId: nullable(str(128, "^[A-Za-z0-9][A-Za-z0-9._-]*$")),
    digest: hash, failed: bool,
    unbound: nullable(object({ok: bool, rejected: bool, error: nullable({...str(256), maxJSONBytes: 258})})),
  });
  ref.properties.barrier = {enum: ["stop", "native-barrier"]};
  const schema = object({
    version: {const: 10}, identity: hash, scopeId: hash, parentScope: nullable(hash),
    prefix: {type: "string", minLength: 0, maxLength: 84, pattern: "^(?:[A-Za-z0-9][A-Za-z0-9._-]*)?$"},
    models: object(Object.fromEntries(["r1", "r2", "synthesis"].map(slot => [slot, object({
      key: {const: `pitako.review.${slot}`},
      model: str(256, "^[^/\\s:*?,\\u0000-\\u001f]+/[^\\s*?,\\u0000-\\u001f]+(?::(?:off|minimal|low|medium|high|xhigh|max))?$"),
    })]))),
    phase: {enum: ["prepare", "independent", "synthesis", "save"]},
    slots: {type: "array", maxItems: 6, items: ref},
    verifier: nullable(ref),
    terminal: nullable({anyOf: [
      object({
        outcome: outcomes, storeId: str(36, "^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$"),
        head: object({seq: {const: 1}, hash}),
      }),
      str(128, "^Standalone review integrity failure: review-recovery-overflow: [0-9]+ bytes for [0-7] settled slots \\(limit 61440\\)\\.$"),
    ]}),
  });
  const bytes = value => encodeURIComponent(value).replace(/%[0-9A-F]{2}|[^%]/g, "x").length;
  function conforms(value, s) {
    if (s.nullable && value === null) return true;
    if (s.anyOf) return s.anyOf.some(branch => conforms(value, branch));
    if (s.const !== undefined) return value === s.const;
    if (s.enum) return s.enum.includes(value);
    if (s.type === "boolean") return typeof value === "boolean";
    if (s.type === "string") {
      if (typeof value !== "string") return false;
      try { return bytes(value) >= s.minLength && bytes(value) <= s.maxLength &&
        (s.maxJSONBytes === undefined || bytes(JSON.stringify(value)) <= s.maxJSONBytes) &&
        (!s.pattern || new RegExp(s.pattern).test(value)); }
      catch (_) { return false; }
    }
    if (s.type === "array") return Array.isArray(value) && value.length <= s.maxItems && value.every(item => conforms(item, s.items));
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      s.required.every(field => Object.hasOwn(value, field)) &&
      Object.keys(value).every(field => Object.hasOwn(s.properties, field) && conforms(value[field], s.properties[field]));
  }
  function validate(stateKey, cursor) {
    if (stateKey !== key) throw new Error("Unknown review cursor key.");
    if (!conforms(cursor, schema)) throw new Error("Invalid standalone review cursor.");
    if (bytes(JSON.stringify({[key]: cursor}, null, 2)) > 16384) throw new Error("Review cursor exceeds 16384 bytes.");
    const refs = [...cursor.slots, ...(cursor.verifier ? [cursor.verifier] : [])];
    const overflow = typeof cursor.terminal === "string";
    if (new Set(refs.map(item => item.key)).size !== refs.length ||
        refs.some(item => (item.runId === null) !== (item.unbound !== null) || (item.barrier && (!item.failed || !item.runId))) ||
        (cursor.terminal !== null && (overflow ? cursor.phase === "save" : cursor.phase !== "save")))
      throw new Error("Invalid standalone review cursor references.");
    return cursor;
  }
  // Only the fields used by the reducer, not runner/debug metadata or the reuse flag.
  function witness(result) {
    const common = ["key", "agent", "runId", "workflowKey", "nativeKey", "state", "error",
      "exitCode", "stopped", "interrupted", "detached", "timedOut", "terminalOutcome", "recovery",
      "toolBudgetBlocked", "acceptance", "outputSaveError", "metadataSaveError", "artifactPaths", "outputReference"];
    const verifier = result.agent === "pitako.originals-verifier" || result.agent === "pitako.access-verifier";
    const verifierFlags = verifier
      ? ["truncation", "transcriptError", "outputPartial", "processSignal"] : [];
    const pick = (value, fields) => Object.fromEntries(fields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
    return JSON.parse(JSON.stringify({
      ...pick(result, [...common, "ok", "asyncDir", "outputArtifactPath", "outputPathMapping", "nativeBarrier", "nativeFailure",
        "structuredOutput", ...verifierFlags, ...(verifier ? ["output"] : [])]),
      ...(Array.isArray(result.results) ? {results: result.results.map(item => pick(item,
        [...common, "index", "savedOutputPath", "structuredOutputPath", ...verifierFlags,
          ...(verifier ? ["nativeBarrier", "nativeFailure"] : [])]))} : {}),
    }));
  }
  function barrier(result) {
    const entries = [result, ...(result.results ?? [])];
    if (entries.some(entry => entry.stopped)) return "stop";
    if (result.nativeBarrier || result.nativeFailure || entries.some(entry => entry.interrupted || entry.detached ||
        entry.timedOut || entry.recovery || entry.toolBudgetBlocked || entry.acceptance?.recovery ||
        /Blocked by pi-subagents permission rule:/.test(entry.error ?? ""))) return "native-barrier";
  }
  function verifierRetry(key, base) {
    if (key === base) return 0;
    if (!key?.startsWith(`${base}.r`)) return -1;
    const retry = Number(key.slice(base.length + 2));
    return Number.isSafeInteger(retry) && retry > 0 && key === `${base}.r${retry}` ? retry : -1;
  }
  return {key, schema, validate, witness, barrier, verifierRetry};
}
export const reviewCursorScript = `const reviewCursorContract = ${reviewCursorContract.toString()};\n`;
