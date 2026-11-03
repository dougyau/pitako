import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

test("owned TypeBox schemas infer and validate through SDK 1.5.0", () => {
  const sdkPackage = new URL("../package.json", import.meta.resolve("@earendil-works/pi-ai"));
  expect(JSON.parse(readFileSync(sdkPackage, "utf8")).version).toBe("1.5.0");

  const development = defineTool({
    name: "development_schema", label: "Development schema", description: "Owned contract",
    parameters: Type.Object({ value: Type.String(), count: Type.Optional(Type.Number()) }),
    async execute(_id, input) {
      const value: string = input.value;
      const count: number | undefined = input.count;
      return { content: [{ type: "text", text: value.repeat(count ?? 1) }], details: {} };
    },
  });
  // SDK StringEnum now returns pi-schema, not TypeBox: keep nested enums TypeBox-native.
  const enumTool = defineTool({
    name: "enum_schema", label: "Enum schema", description: "Owned contract",
    parameters: Type.Object({
      value: Type.Enum(["owned", "other"], { type: "string" }),
      status: Type.Optional(Type.Enum(["open", "closed"], { type: "string" })),
    }),
    async execute(_id, input) {
      const value: "owned" | "other" = input.value;
      const status: "open" | "closed" | undefined = input.status;
      return { content: [{ type: "text", text: status ?? value }], details: {} };
    },
  });
  for (const tool of [development, enumTool]) {
    expect(validateToolArguments(tool, {
      type: "toolCall", id: "valid", name: tool.name, arguments: { value: "owned" },
    })).toEqual({ value: "owned" });
    expect(() => validateToolArguments(tool, {
      type: "toolCall", id: "invalid", name: tool.name, arguments: {},
    })).toThrow();
  }
  expect(validateToolArguments(enumTool, {
    type: "toolCall", id: "enum-valid", name: enumTool.name, arguments: { value: "other", status: "open" },
  })).toEqual({ value: "other", status: "open" });
  const invalidArguments: Record<string, string>[] = [{ value: "invalid" }, { value: "owned", status: "invalid" }];
  for (const args of invalidArguments) {
    expect(() => validateToolArguments(enumTool, {
      type: "toolCall", id: "enum-invalid", name: enumTool.name, arguments: args,
    })).toThrow();
  }
});
