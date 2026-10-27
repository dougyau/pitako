// Adapted from nredd/pi-harness; MIT (Redd). See docs/provenance.json for source commits and test origins.
/**
 * Minimal pi mock: enough `ExtensionAPI` to register tools and hooks and call them. Calls are
 * validated against the tool's TypeBox `parameters`, and results against its `outputSchema`, so a
 * test cannot pass with arguments or structured content pi itself would reject.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Errors } from "typebox/value";

type AnyTool = {
	name: string;
	description?: string;
	annotations?: Record<string, boolean>;
	parameters: TSchema;
	outputSchema?: TSchema;
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: { cwd: string },
	) => Promise<unknown>;
};
type Hook = (event: unknown, ctx: unknown) => unknown;
export type MockResult = {
	content: { text: string }[];
	structuredContent: unknown;
	isError: boolean;
	details?: unknown;
};

function schemaProblem(schema: TSchema, value: unknown): string | undefined {
	const first = [...Errors(schema, value)][0];
	return first ? `${first.instancePath || "/"}: ${first.message}` : undefined;
}

export function createMockPi() {
	const tools = new Map<string, AnyTool>();
	const hooks = new Map<string, Hook[]>();
	const pi = {
		registerTool(tool: AnyTool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: Hook) {
			hooks.set(event, [...(hooks.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		tools,
		hooks,
		async call(name: string, params: unknown, cwd: string): Promise<MockResult> {
			const tool = tools.get(name);
			if (!tool) throw new Error(`tool ${name} not registered`);
			const bad = schemaProblem(tool.parameters, params);
			if (bad) throw new Error(`${name} params rejected by schema ${bad}`);
			const result = (await tool.execute("id", params, undefined, undefined, { cwd })) as MockResult;
			if (tool.outputSchema) {
				const badOut = schemaProblem(tool.outputSchema, result.structuredContent);
				if (badOut) throw new Error(`${name} structuredContent violates outputSchema ${badOut}`);
			}
			return result;
		},
		text(result: MockResult): string {
			return result.content.map((c) => c.text).join("\n");
		},
		toolCall(toolName: string, input: unknown) {
			for (const hook of hooks.get("tool_call") ?? []) {
				const decision = hook({ toolName, input }, {});
				if (decision) return decision;
			}
			return undefined;
		},
	};
}
