// Both the sandbox review phase and deterministic execute publication use this contract.
export function reviewSynthesisContract(mode) {
  const text = value => typeof value === "string" && value.trim().length > 0;
  const string = { type: "string", minLength: 1 };
  const object = properties => ({
    type: "object", additionalProperties: false, required: Object.keys(properties), properties,
  });
  const list = items => ({ type: "array", items });
  const classification = { enum: ["scoped-defect", "related-improvement", "out-of-scope", "uncertain"] };
  const requirement = { anyOf: [string, { type: "null" }] };
  const decision = { enum: ["include", "discard", "uncertain"] };
  const screening = object({
    verdict: { enum: ["clear", "material-gaps", "blocked"] }, reason: string,
    assessments: list(object({
      findingId: string, requirement, consequence: string, material: { type: "boolean" }, reason: string,
    })),
  });
  const schema = object({
    ...(mode === "execute" ? { screening } : {}),
    status: { enum: ["ready", "blocked"] }, reason: string, memo: string,
    dispositions: list(object({ findingId: string, decision, reason: string, classification, requirement })),
  });
  const scoped = value => classification.enum.includes(value?.classification) &&
    (text(value.requirement) || value.requirement === null) &&
    (value.classification !== "scoped-defect" || text(value.requirement));
  function validate(value, findingIds) {
    function exactIds(entries, field, values) {
      if (!Array.isArray(entries) || entries.length !== findingIds.length ||
          new Set(entries.map(entry => entry?.findingId)).size !== findingIds.length ||
          entries.some(entry => !findingIds.includes(entry?.findingId) ||
            !values.includes(entry?.[field]) || !text(entry.evidence ?? entry.reason)))
        throw new Error("Incomplete or invalid synthesis finding dispositions.");
    }
    exactIds(value.dispositions, "decision", decision.enum);
    if (value.dispositions.some(entry => !scoped(entry) ||
        (entry.classification === "uncertain" && entry.decision === "include")))
      throw new Error("Director returned invalid finding scope or unsupported inclusion.");
    if (!text(value.memo)) throw new Error("Director returned no final memo.");
    if (mode !== "execute") return;
    const result = value.screening;
    if (!result || !screening.properties.verdict.enum.includes(result.verdict) ||
        !text(result.reason)) throw new Error("Missing reasoned execute screening.");
    exactIds(result.assessments, "material", [true, false]);
    const contradicted = result.assessments.filter(entry => entry.material &&
      value.dispositions.some(item => item.findingId === entry.findingId &&
        (item.decision === "discard" || ["out-of-scope", "related-improvement"].includes(item.classification))));
    if (result.assessments.some(entry => !text(entry.consequence) ||
        (entry.material && !text(entry.requirement)) ||
        !(text(entry.requirement) || entry.requirement === null)) ||
        contradicted.length ||
        (result.verdict === "clear" && result.assessments.some(entry => entry.material)) ||
        (result.verdict === "material-gaps" && !result.assessments.some(entry => entry.material)))
      throw new Error(`Execute screening contradicts dispositions or lacks consequences.${contradicted.map(entry => ` ${entry.findingId}`).join("")}`);
  }
  return { classification, requirement, schema, scoped, validate };
}

export function reviewAnalysisConforms(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(item => reviewAnalysisConforms(value, item));
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "object") return value !== null && typeof value === "object" && !Array.isArray(value) &&
    schema.required.every(key => Object.hasOwn(value, key)) && Object.entries(value).every(([key, item]) =>
      schema.properties[key] ? reviewAnalysisConforms(item, schema.properties[key]) : schema.additionalProperties !== false);
  if (schema.type === "array") return Array.isArray(value) &&
    (schema.minItems === undefined || value.length >= schema.minItems) &&
    (schema.maxItems === undefined || value.length <= schema.maxItems) && value.every(item => reviewAnalysisConforms(item, schema.items));
  if (schema.type === "string") return typeof value === "string" && value.trim().length > 0 &&
    (!schema.pattern || new RegExp(schema.pattern).test(value));
  return true;
}

export const reviewSynthesisScript = `${reviewSynthesisContract.toString()}\n${reviewAnalysisConforms.toString()}\n`;
