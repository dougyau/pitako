export function sessionDisplayName(_text: string | undefined): string | undefined {
  return undefined;
}

export function sessionNameAction(input: { current: string | undefined }): { set?: string } {
  if (!input.current) return { set: "pitako:coding" };
  return {};
}
