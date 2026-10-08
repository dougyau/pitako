// Node and Bun timers use a signed 32-bit millisecond delay.
export const MAX_COMMAND_TIME_MS = 2_147_483_647;

export function assertCommandTime(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_COMMAND_TIME_MS)
    throw new Error(`command timeout must be a finite integer from 1 to ${MAX_COMMAND_TIME_MS} ms`);
}
