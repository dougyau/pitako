/**
 * pi-dev-tools: typed tools for git, ssh, Python and Rust workflows.
 *
 * Each area registers its own tools from a sibling module; this file only wires them up.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type CargoToolOptions, registerCargoTools } from "./cargo/index.ts";
import { registerGitTools } from "./git/index.ts";
import { type PyToolOptions, registerPyTools } from "./py/index.ts";
import { type ResourceSnapshotOptions, registerResourceTools } from "./resource/index.ts";
import { registerSshTools, type SshToolOptions } from "./ssh/index.ts";

/** Per-group seams, for tests that drive the whole extension; production passes none. */
export interface DevToolsOptions {
	ssh?: SshToolOptions;
	py?: PyToolOptions;
	cargo?: CargoToolOptions;
	resource?: ResourceSnapshotOptions;
}

/** The extension factory, with `options` handed to each tool group. */
export function createDevTools(options: DevToolsOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		registerGitTools(pi);
		registerSshTools(pi, options.ssh);
		registerPyTools(pi, options.py);
		registerCargoTools(pi, options.cargo);
		registerResourceTools(pi, options.resource);
	};
}

export default createDevTools();
