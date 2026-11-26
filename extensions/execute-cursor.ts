import { EXECUTE_STATE_VERSION } from "./execute-state.ts";

export const EXECUTE_CURSOR_KEY = "pitako-execute";
export const EXECUTE_CURSOR_MAX_BYTES = 16384;
export const EXECUTE_TASK_GATES_MAX = 16;

// Runtime agents load this schema directly with Node, without Pi's host imports.
const closed = <T extends Record<string, CursorShape>, K extends keyof T = never>(
  properties: T, optional: K[] = [],
) => ({
  type: "object" as const,
  required: (Object.keys(properties) as (keyof T)[])
    .filter((key): key is Exclude<keyof T, K> => !optional.some(field => field === key)),
  properties,
  additionalProperties: false as const,
});
const nullable = <T extends CursorShape>(schema: T) => ({ anyOf: [schema, { type: "null" as const }] });
const literal = <T extends string | number>(value: T) => ({ type: typeof value, const: value });
const integer = (minimum: number, maximum: number) => ({ type: "integer" as const, minimum, maximum });
const string = (minLength: number, maxLength: number, pattern: string) =>
  ({ type: "string" as const, minLength, maxLength, pattern });
const array = <T extends CursorShape>(items: T, maxItems: number) => ({ type: "array" as const, items, maxItems });
const counter = integer(0, Number.MAX_SAFE_INTEGER);
const positive = integer(1, Number.MAX_SAFE_INTEGER);
const token = (maxLength: number) => string(1, maxLength, "^[A-Za-z0-9._:/@+~-]+(?![\\s\\S])");
const hash = string(64, 64, "^[a-f0-9]{64}$");
const uuid = string(36, 36, "^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$");
const model = string(3, 128,
  "^[^/\\s:*?,]+/[^\\s*?,]+(?::(?:off|minimal|low|medium|high|xhigh|max))?(?![\\s\\S])");
const record = closed({ seq: positive, digest: hash });
const head = closed({ seq: positive, hash });
const stageDigest = closed({ stage: token(32), digest: hash });
const haltReason = string(0, 360, "^[\\s\\S]*(?![\\s\\S])");
const gateTimeout = integer(1, 2147483647);
const dispatchHalt = closed({
  stage: { anyOf: [literal("capacity"), literal("native-dispatch"),
    literal("task-review-model"), literal("stop"), literal("interrupt"), literal("permission")] },
  digest: hash,
  reason: haltReason,
});
const hostObservationHalt = closed({
  stage: { anyOf: [literal("host"), literal("host-stop")] },
  digest: hash,
  reason: haltReason,
});
const child = closed({ key: token(192), runId: uuid, role: token(32) });
const reviewSlot = closed({
  key: token(192), runId: nullable(uuid), phase: token(32), digest: nullable(hash),
});

/** Only control and references belong here; prompts and decision inputs belong to the head-bound store projection. */
export const executeCursorSchema = closed({
  version: literal(EXECUTE_STATE_VERSION),
  storeId: uuid,
  root: string(1, 1024, "^[^\\u0000-\\u001f\\u007f]+(?![\\s\\S])"),
  invocation: string(1, 128, "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]*(?![\\s\\S])"),
  epoch: counter,
  associationDigest: hash,
  admissionBinding: hash,
  head,
  action: { anyOf: [
    closed({ kind: literal("pending"), op: token(32), opKey: token(192), input: record,
      gateTimeoutMs: gateTimeout,
      gateTimeouts: array(gateTimeout, EXECUTE_TASK_GATES_MAX),
      gateMetricMs: integer(0, 1800000) }, ["gateTimeoutMs", "gateTimeouts", "gateMetricMs"]),
    closed({ kind: literal("pending"), op: literal("drain"), opKey: token(192), input: record,
      drainDigest: hash }),
    closed({ kind: literal("launched"), key: token(192), runId: nullable(uuid), role: token(32), input: record,
      op: token(32), gateTimeoutMs: gateTimeout }, ["op", "gateTimeoutMs"]),
    closed({ kind: literal("waiting") }),
    closed({ kind: literal("terminal") }),
  ] },
  loop: nullable(closed({
    number: positive,
    phase: token(32),
    cursor: counter,
    taskId: nullable(token(128)),
    outcome: nullable(token(32)),
    attempt: nullable(closed({
      number: positive,
      stage: token(32),
      intent: nullable(record),
      revival: nullable(token(32)),
    })),
  })),
  inFlight: array(child, 8),
  halt: nullable({ anyOf: [stageDigest, dispatchHalt] }),
  hostHalt: nullable(hostObservationHalt),
  timeouts: closed({
    reviewerMs: integer(1, 86400000),
    workerMs: integer(1, 86400000),
    gateFloorMs: integer(0, 86400000),
  }),
  models: closed({
    taskReviewer: model, taskSynthesis: model,
    r1: model, r2: model, synthesis: model,
  }),
  budget: closed({
    consumedLoops: counter, maxCycles: positive,
    rejectedKeys: array(hash, 8),
    lastProgress: nullable(hash),
  }),
  backlogDigest: nullable(hash),
  boardTopicId: positive,
  review: nullable(closed({
    generation: positive,
    phase: token(32),
    slots: array(reviewSlot, 6),
    verifier: nullable(child),
  })),
});

type CursorValue<S> =
  S extends { const: infer V } ? V :
  S extends { anyOf: (infer V)[] } ? CursorValue<V> :
  S extends { type: "object"; properties: infer P; required: (infer K)[] }
    ? { [F in keyof P as F extends K ? F : never]: CursorValue<P[F]> } &
      { [F in keyof P as F extends K ? never : F]?: CursorValue<P[F]> } :
  S extends { type: "array"; items: infer I } ? CursorValue<I>[] :
  S extends { type: "integer" } ? number :
  S extends { type: "string" } ? string :
  S extends { type: "null" } ? null : never;

export type ExecuteCursor = CursorValue<typeof executeCursorSchema>;

type CursorShape = {
  const?: unknown; anyOf?: CursorShape[]; type?: string;
  properties?: Record<string, CursorShape>; required?: string[]; additionalProperties?: boolean;
  items?: CursorShape; maxItems?: number;
  minLength?: number; maxLength?: number; pattern?: string;
  minimum?: number; maximum?: number;
};
type CursorValidator = (key: string, value: unknown) => asserts value is ExecuteCursor;

/** Inlined into the sandbox: all dependencies must be arguments or local functions. */
function createExecuteCursorValidator(schema: CursorShape, stateKey: string, maxBytes: number): CursorValidator {
  function matches(shape: CursorShape, value: unknown): boolean {
    if ("const" in shape) return value === shape.const;
    if (shape.anyOf) return shape.anyOf.some(branch => matches(branch, value));
    if (shape.type === "null") return value === null;
    if (shape.type === "boolean") return typeof value === "boolean";
    if (shape.type === "integer") return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= shape.minimum! && value <= shape.maximum!;
    if (shape.type === "string") return typeof value === "string" &&
      Array.from(value).length >= shape.minLength! && Array.from(value).length <= shape.maxLength! &&
      new RegExp(shape.pattern!, "u").test(value);
    if (shape.type === "array") return Array.isArray(value) && value.length <= shape.maxItems! &&
      Array.from(value).every(item => matches(shape.items!, item));
    if (shape.type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Record<string, unknown>, properties = shape.properties!;
      return shape.required!.every(key => Object.hasOwn(object, key)) &&
        Object.getOwnPropertyNames(object).every(key => Object.hasOwn(properties, key) && matches(properties[key]!, object[key]));
    }
    return false;
  }
  // Unlike encodeURIComponent, this also counts lone surrogates as UTF-8 replacement characters.
  function bytes(text: string) {
    let count = 0;
    for (const point of text) {
      const code = point.codePointAt(0)!;
      count += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    return count;
  }
  return function validateExecuteCursor(key: string, input: unknown): asserts input is ExecuteCursor {
    if (key !== stateKey) throw new Error("Unknown execute cursor key.");
    if (!matches(schema, input)) {
      const object = input && typeof input === "object" && !Array.isArray(input)
        ? input as Record<string, unknown> : {};
      const fields = Object.keys(schema.properties!).filter(key => !matches(schema.properties![key]!, object[key]));
      throw new Error(`Invalid execute cursor schema${fields.length ? `: ${fields.join(", ")}` : ""}.`);
    }
    const value = input as ExecuteCursor;
    if (value.hostHalt && bytes(JSON.stringify(value.hostHalt.reason)) - 2 > 1080)
      throw new Error("Host observation halt reason exceeds its excerpt bound.");
    if (value.halt && "reason" in value.halt) {
      // Another native or host barrier vetoes dispatch before a failure can reach this halt.
      if (value.action.kind !== "launched" || value.action.runId !== null ||
          value.hostHalt)
        throw new Error("Pre-dispatch halt requires a launched action without a native run or another barrier.");
      if (value.halt.reason.length > 360 || bytes(JSON.stringify(value.halt.reason)) - 2 > 1080)
        throw new Error("Pre-dispatch halt reason exceeds its excerpt bound.");
    }
    if (value.action.kind === "launched" && value.action.role === "worker" &&
        value.action.gateTimeoutMs === undefined)
      throw new Error("Launched worker requires its frozen gate deadline.");
    if (value.action.kind === "pending" && !("drainDigest" in value.action)) {
      const gates = ["gate", "close"].includes(value.action.op);
      if (gates && value.action.gateTimeoutMs === undefined)
        throw new Error("Pending gates require their frozen gate deadline.");
      if (!gates && value.action.gateTimeoutMs !== undefined)
        throw new Error("Pending operation does not run task gates.");
      if (value.action.op === "gate" && (value.action.gateTimeouts === undefined || value.action.gateMetricMs === undefined))
        throw new Error("Pending task gate requires its frozen renewal inputs.");
      if (value.action.op !== "gate" && (value.action.gateTimeouts !== undefined || value.action.gateMetricMs !== undefined))
        throw new Error("Only pending task gates have renewal inputs.");
    }
    const terminal = value.loop?.outcome === "complete" ||
      value.loop?.outcome === "gaps" &&
        value.budget.consumedLoops === value.budget.maxCycles;
    if (value.action.kind === "waiting" && !terminal)
      throw new Error("Nonterminal execute cursor requires a pending or launched action.");
    if (value.action.kind === "terminal" && !terminal)
      throw new Error("Terminal execute cursor requires a retained disposition.");
    if (bytes(value.root) > 1024) throw new Error("Execute cursor root exceeds its UTF-8 bound.");
    if (Object.values(value.models).some(model => bytes(model) > 128))
      throw new Error("Execute cursor model exceeds its UTF-8 bound.");
    if (bytes(JSON.stringify({ [key]: value }, null, 2)) > maxBytes)
      throw new Error("Execute cursor exceeds 16384 bytes.");
    const intent = value.loop?.attempt?.intent;
    if (value.loop?.attempt?.stage === "launched" && !intent)
      throw new Error("Launched execute attempt requires a committed intent.");
    if (intent && intent.seq > value.head.seq) throw new Error("Execute intent is ahead of cursor head.");
    if ("input" in value.action && value.action.input.seq > value.head.seq)
      throw new Error("Execute action input is ahead of cursor head.");
    if (value.budget.consumedLoops > value.budget.maxCycles)
      throw new Error("Execute cursor exceeds its frozen cycle budget.");
  };
}

/** The same schema and boundary checks run on the host and before sandbox state.set. */
export const validateExecuteCursor: CursorValidator =
  createExecuteCursorValidator(executeCursorSchema, EXECUTE_CURSOR_KEY, EXECUTE_CURSOR_MAX_BYTES);

export function executeCursorValidationScript(): string {
  return `const EXECUTE_TASK_GATES_MAX = ${EXECUTE_TASK_GATES_MAX};\nconst validateExecuteCursor = (${createExecuteCursorValidator.toString()})(${JSON.stringify(executeCursorSchema)}, ${JSON.stringify(EXECUTE_CURSOR_KEY)}, ${EXECUTE_CURSOR_MAX_BYTES});`;
}
