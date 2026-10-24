export function isPitakoPlaceholder(name: string | undefined): boolean {
  return name === "pitako:coding" || name === "pitako:analysis";
}

export function sessionDisplayName(text: string | undefined): string | undefined {
  const firstLine = text?.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (!firstLine) return undefined;
  const name = firstLine.replace(/\s+/g, " ").slice(0, 60).trimEnd();
  return name && !isPitakoPlaceholder(name) ? name : undefined;
}

export function sessionNameAction(input: {
  current: string | undefined;
  existingUserText?: string;
  pendingPrompt?: string;
}): { set?: string } {
  if (input.current && !isPitakoPlaceholder(input.current)) return {};
  const title = sessionDisplayName(input.existingUserText) ?? sessionDisplayName(input.pendingPrompt);
  if (title) return { set: title };
  return isPitakoPlaceholder(input.current) ? { set: "" } : {};
}
