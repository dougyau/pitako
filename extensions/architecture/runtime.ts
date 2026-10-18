import { createTable } from "../table/runtime.ts";

/** Architecture's public facade retains direct and autonomous modes. */
export function createConsultation(input: Omit<Parameters<typeof createTable>[0], "review">) {
  return createTable(input);
}
export type Consultation = ReturnType<typeof createConsultation>;
