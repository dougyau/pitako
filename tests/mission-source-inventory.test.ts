import { expect, test } from "bun:test";
import { inventoryFrozenSource } from "../extensions/mission/source-inventory.ts";

const source = `---
id: ordinary
revision: 1
status: frozen
---
# Ordinary change

## Goal
Reject invalid values.

## Ordered work units
### T1 — Fix input
Objective: retain valid behavior.
Scope: src/input.ts
Acceptance:
- Valid input works.
- Invalid input rejects.
  - Empty input rejects.
  - Empty input rejects.
Expected evidence: focused checks.

### T2 — Review output
Objective: inspect the result.
Dependencies: T1
Acceptance criteria:
The complete result remains correct.
Expected evidence: review.

## Final verification and success
Run the final check:

\`\`\`sh
node check.mjs
# T99 — not a unit
\`\`\`
`;

test("host inventory retains nested occurrences, complete clauses, globals and order", () => {
  const inventory = inventoryFrozenSource(source);
  expect(inventory.unresolved).toEqual([]);
  expect(inventory.units.map(({ sourceUnitId }) => sourceUnitId)).toEqual(["T1", "T2"]);
  expect(inventory.criteria.filter(({ owner }) => owner === "t1")).toHaveLength(4);
  const duplicates = inventory.criteria.filter(({ text }) => text.trim() === "- Empty input rejects.");
  expect(duplicates).toHaveLength(2);
  expect(duplicates[0]!.id).not.toBe(duplicates[1]!.id);
  expect(duplicates[0]!.parentId).toBe(duplicates[1]!.parentId);
  expect(inventory.criteria.find(({ text }) => text.startsWith("- Invalid"))!.text).toContain("Empty input");
  expect(inventory.criteria.filter(({ owner }) => owner === "mission")).toHaveLength(1);
  expect(inventory.dependencies).toEqual([
    { unitId: "t2", requires: "t1", basis: "profile-order" },
    { unitId: "t2", requires: "t1", basis: "source-declaration", sourceRef: expect.any(String) },
  ]);
  for (const row of [...inventory.units, ...inventory.criteria, ...inventory.context])
    expect(Buffer.from(source).subarray(row.from, row.to).toString()).toBe(row.text);
});

test("unsupported regions cannot vanish into context or fenced fake units", () => {
  for (const modified of [
    source.replace("Acceptance:", "Acceptance checks:"),
    source.replace("- Valid input works.", "| condition | evidence |\n| valid | check |"),
    source.replace("Dependencies: T1", "Dependencies: after the first implementation"),
    source.replace("## Final verification and success", "## Odd obligations"),
    source.replace("### T2", "#### T2"),
    source.replace("### T2 — Review output", "### T1 — Review output"),
  ]) expect(inventoryFrozenSource(modified).unresolved.length).toBeGreaterThan(0);
});

test("byte coordinates survive unicode and CRLF without excerpt-search identity", () => {
  const text = source.replace("Reject invalid values.", "Reject invalid values. café ✓").replaceAll("\n", "\r\n");
  const inventory = inventoryFrozenSource(text);
  expect(inventory.unresolved).toEqual([]);
  for (const row of [...inventory.units, ...inventory.criteria, ...inventory.context])
    expect(Buffer.from(text).subarray(row.from, row.to).toString()).toBe(row.text);
});
