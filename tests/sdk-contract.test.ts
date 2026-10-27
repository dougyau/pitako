import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import { Type as SdkType, validateToolArguments } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

test("owned schemas load and infer through SDK 1.4.0 with independently resolved TypeBox baselines", async () => {
  const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-ai"));
  const sdkPath = sdkRequire.resolve("typebox");
  const developmentPath = new URL(import.meta.resolve("typebox"));
  expect(realpathSync(sdkPath)).not.toBe(realpathSync(developmentPath));
  expect(JSON.parse(readFileSync(new URL("../package.json", pathToFileURL(sdkPath)), "utf8")).version).toBe("1.3.27");
  expect(JSON.parse(readFileSync(new URL("../package.json", developmentPath), "utf8")).version).toBe("1.4.3");

  // Both schemas must infer the execute input through the published SDK API.
  // No cast or deduplication may bridge these independently resolved versions.
  const development = defineTool({
    name: "development_schema", label: "Development schema", description: "Owned contract",
    parameters: Type.Object({ value: Type.String(), count: Type.Optional(Type.Number()) }),
    async execute(_id, input) {
      const value: string = input.value;
      const count: number | undefined = input.count;
      return { content: [{ type: "text", text: value.repeat(count ?? 1) }], details: {} };
    },
  });
  const baseline = defineTool({
    name: "sdk_schema", label: "SDK schema", description: "Owned contract",
    parameters: SdkType.Object({ value: SdkType.String() }),
    async execute(_id, input) {
      const value: string = input.value;
      return { content: [{ type: "text", text: value }], details: {} };
    },
  });
  for (const tool of [development, baseline]) {
    expect(validateToolArguments(tool, {
      type: "toolCall", id: "valid", name: tool.name, arguments: { value: "owned" },
    })).toEqual({ value: "owned" });
    expect(() => validateToolArguments(tool, {
      type: "toolCall", id: "invalid", name: tool.name, arguments: {},
    })).toThrow();
  }
});
