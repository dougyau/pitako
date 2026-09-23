export function isPitakoPlaceholder(name: string | undefined): boolean {
  return name === "pitako:coding" || name === "pitako:analysis";
}

export function sessionDisplayName(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine || firstLine.startsWith("Pitako worker ")) return undefined;
  const name = firstLine.replace(/\s+/g, " ").slice(0, 60).trimEnd();
  return name && !isPitakoPlaceholder(name) ? name : undefined;
}

export function planInvocation(text: string | undefined): { activity: "plan" | "execute"; id: string } | undefined {
  if (text === undefined) return undefined;
  const match = /\$(plan|execute)(?=$|\s)(?:\s+([^\s]+))?/.exec(text);
  if (!match?.[2] || !/^[a-z0-9][a-z0-9-_]*$/.test(match[2]) || match[2].includes("..")) return undefined;
  return { activity: match[1] as "plan" | "execute", id: match[2] };
}

export function planHeading(text: string): string | undefined {
  const frontmatter = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const body = frontmatter ? text.slice(frontmatter[0].length) : text;
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) return match[1].trim() || undefined;
  }
  return undefined;
}

export function workflowDisplayName(activity: "plan" | "execute", title: string): string | undefined {
  return sessionDisplayName(`${activity}: ${title}`);
}

export function sessionNameAction(input: {
  current: string | undefined;
  existingUserText?: string;
  pendingPrompt?: string;
  workflow?: { activity: "plan" | "execute"; title: string; fromPlanWrite?: boolean };
}): { set?: string } {
  const { current } = input;
  const firstLine = sessionDisplayName(input.existingUserText);
  const owned = current === undefined || current === "" || isPitakoPlaceholder(current) ||
    current === firstLine || current.startsWith("plan: ") || current.startsWith("execute: ");
  if (!owned) return {};

  const workflowName = input.workflow && workflowDisplayName(input.workflow.activity, input.workflow.title);
  if (workflowName && workflowName !== current && !(input.workflow?.fromPlanWrite && current?.startsWith("execute: "))) {
    return { set: workflowName };
  }

  if ((current === undefined || current === "" || isPitakoPlaceholder(current)) && firstLine) return { set: firstLine };
  if (isPitakoPlaceholder(current) && !firstLine) return { set: "" };
  if ((current === undefined || current === "") && !firstLine) {
    const pendingTitle = sessionDisplayName(input.pendingPrompt);
    if (pendingTitle) return { set: pendingTitle };
  }
  return {};
}
