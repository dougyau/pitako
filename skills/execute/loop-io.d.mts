export function stateCapacity(input: {
  invocation: string;
  missionId: string;
  missionPath: string;
}): { total: number; execute: number; unrelated: number };
