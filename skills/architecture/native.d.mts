export const architectureNativeSource: string;
export function architectureNative(canonicalDigest: (value: unknown) => string): {
  architectureOutputSchema(phase: string): unknown;
  projectNativeOriginal(contract: unknown, result: unknown): { entry: unknown; barrier?: unknown };
  confirmNativeOriginal(entry: unknown, dispatch: unknown, result: unknown): void;
};
