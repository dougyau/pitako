import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "bun:test";
import { __resetState as resetI18n } from "@juicesharp/rpiv-i18n";

// Call at file scope before any config read; Bun isolates each test file's env.
export function isolateTodoConfig(): string {
	const originalHome = process.env.HOME;
	const originalXdg = process.env.XDG_CONFIG_HOME;
	const home = mkdtempSync(join(tmpdir(), "pitako-todo-test-"));
	process.env.HOME = home;
	process.env.XDG_CONFIG_HOME = join(home, ".config");
	const configDir = join(home, ".config", "rpiv-todo");
	beforeEach(() => {
		rmSync(configDir, { recursive: true, force: true });
		resetI18n();
	});
	afterAll(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdg;
		rmSync(home, { recursive: true, force: true });
	});
	return join(configDir, "config.json");
}
