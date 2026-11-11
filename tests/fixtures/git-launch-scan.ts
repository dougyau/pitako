/** Narrow source scan, including child eval strings; not a general shell analyzer. */
export function gitLaunches(source: string): string[] {
  return [...source.matchAll(
    /\b(?:spawn(?:Sync)?|execFile(?:Sync)?|exec(?:Sync)?)\s*\(\s*["'`]git(?:["'`]|\s)|\bBun\.spawn(?:Sync)?\s*\(\s*(?:\[\s*|\{[^}]*?\bcmd\s*:\s*\[\s*)["'`]git["'`]|\bBun\.which\s*\(\s*["'`]git["'`]|\/usr\/bin\/git/g,
  )].map(match => match[0]);
}
