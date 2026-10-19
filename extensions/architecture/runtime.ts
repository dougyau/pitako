import { createTable } from "../table/runtime.ts";

/** Architecture's director-led table facade. */
export function createConsultation(input: Omit<Parameters<typeof createTable>[0], "review">) {
  return createTable(input);
}
export type Consultation = ReturnType<typeof createConsultation>;
