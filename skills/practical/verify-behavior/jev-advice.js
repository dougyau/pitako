(() => {
  const version = 1;
  const slot = "pitako.jev.latest";
  const questions = {
    failure: {
      orientation: {
        type: "choice",
        instructions: "Which boundary most likely explains the observed failure? Advice only; do not change deterministic evidence.",
        criteria: {
          product: "Evidence points to owned product behavior.",
          fixture: "Evidence points to the observer, test driver or fixture.",
          prerequisite: "Evidence points to a missing or failed prerequisite.",
          unknown: "The available evidence does not establish the boundary."
        }
      }
    },
    "test-audit": {
      orientation: {
        type: "choice",
        instructions: "How does this check contribute to the assigned observable guarantee? Advice cannot authorize deleting a test.",
        criteria: {
          useful_owned_observer: "Observes a distinct owned behavior or affected guarantee.",
          delegated_duplicate_detail_only: "Possibly observes delegated behavior, duplicates another observer, or checks implementation detail only.",
          insufficient_context: "The guarantee or other evidence is insufficient to judge."
        }
      }
    },
    consultation: {
      orientation: {
        type: "choice",
        instructions: "Which uncertainty remains in the assigned result, scope, proposal and evidence? Do not dispatch a role or generate a WorkBrief.",
        criteria: {
          continue_developer: "Focused inspection, known diagnosis or correction stays within the Developer's assignment.",
          consult_architect: "An identified design decision is missing.",
          consult_reviewer: "An existing proposal has an identified correctness question.",
          insufficient_context: "Focused inspection must establish the actual question first."
        }
      }
    }
  };
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const json = value => {
    const encoded = JSON.stringify(value, (_key, item) => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
          typeof item === "bigint" || typeof item === "number" && !Number.isFinite(item)) {
        throw new Error("Expected finite JSON data");
      }
      return item;
    });
    return JSON.parse(encoded);
  };
  const validAnswer = answer => {
    if (!object(answer)) return false;
    if (answer.type === "choice") return typeof answer.choice === "string" &&
      Number.isFinite(answer.confidence) && object(answer.probabilities) &&
      Object.hasOwn(answer.probabilities, answer.choice) &&
      Object.values(answer.probabilities).every(Number.isFinite);
    if (answer.type === "bool") return Number.isFinite(answer.probability);
    if (answer.type === "score") return Number.isFinite(answer.score) && Number.isFinite(answer.confidence);
    return false;
  };
  async function advise(input) {
    let selected;
    try {
      selected = json(input);
      if (!object(selected) || !Object.hasOwn(questions, selected.subject) || !object(selected.context) ||
          Object.keys(selected).some(key => !["subject", "context", "evidenceRefs"].includes(key)) ||
          selected.evidenceRefs !== undefined && (!Array.isArray(selected.evidenceRefs) ||
            !selected.evidenceRefs.every(ref => typeof ref === "string"))) throw new Error("Invalid advisory input");
    } catch (error) {
      return { outcome: "rejected", evidence: "incomplete", error: String(error?.message ?? error) };
    }
    const record = {
      id: `jev-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      time: new Date().toISOString(), helperVersion: version, subject: selected.subject,
      state: selected.context, questions: json(questions[selected.subject]),
      evidenceRefs: selected.evidenceRefs || [], outcome: "unavailable"
    };
    if (JSON.stringify(record).length > 262144) {
      return { outcome: "rejected", evidence: "incomplete", error: "Advisory input exceeds native value limit" };
    }
    let model;
    try {
      model = (await models.getAvailableOfType("classifier"))
        .find(candidate => candidate.provider === "opencode" && candidate.id === "jev-1.13-free");
      if (!model) record.error = "opencode/jev-1.13-free unavailable";
    } catch (error) {
      record.error = `Classifier availability failed: ${String(error?.message ?? error)}`;
    }
    if (model) {
      record.request = { state: record.state, questions: record.questions };
      try {
        const response = await models.classify(model, record.request);
        try {
          record.response = json(response);
        } catch (error) {
          return { id: record.id, slot, outcome: "malformed", evidence: "incomplete",
            error: `Complete public response is not JSON: ${String(error?.message ?? error)}` };
        }
        if (!object(response)) record.outcome = "malformed";
        else if (response.stopReason === "aborted") record.outcome = "aborted";
        else if (response.stopReason === "error" || response.errorMessage) record.outcome = "error";
        else if (response.stopReason !== "stop" || typeof response.api !== "string" ||
            typeof response.provider !== "string" || typeof response.model !== "string" ||
            !Number.isFinite(response.timestamp) || !object(response.answers) ||
            !Object.values(response.answers).every(validAnswer) ||
            response.answers.orientation?.type !== "choice") record.outcome = "malformed";
        else record.outcome = "advice";
      } catch (error) {
        record.outcome = "error";
        record.error = String(error?.message ?? error);
      }
    }
    const summary = { id: record.id, slot, outcome: record.outcome, evidence: "staged" };
    try {
      if (JSON.stringify(record).length > 262144) throw new Error("Complete advisory record exceeds native value limit");
      store(slot, record);
    } catch (error) {
      return { ...summary, evidence: "incomplete", error: String(error?.message ?? error) };
    }
    if (record.outcome === "advice") {
      summary.orientation = record.response.answers.orientation.choice;
      summary.advice = record.response.answers.orientation;
    }
    return summary;
  }
  return { version, advise };
})()
