// Ported from juicesharp/rpiv-mono ce6d3530410812ca504ec294995581a52170f9e1
// packages/test-utils/{pi,session,theme,manifest}.ts (MIT; see LICENSE).
// Only todo's helper graph is retained; mocks use Bun instead of Vitest.
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionToolContext,
	ExtensionUIContext,
	RegisteredCommand,
	SessionEntry,
	Theme,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { vi } from "bun:test";
/** A captured `registerShortcut` registration (KeyId → handler). */
export interface CapturedShortcut {
	description?: string;
	handler: (ctx: unknown) => Promise<void> | void;
}

export interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	/** Keyboard shortcuts registered via `pi.registerShortcut(keyId, opts)`. */
	shortcuts: Map<string, CapturedShortcut>;
	flags: Map<string, unknown>;
	events: Map<string, Array<(...args: unknown[]) => unknown>>;
	eventsEmitted: Map<string, unknown[]>;
	activeTools: string[];
	allTools: ToolInfo[];
	/** Custom entries appended via `pi.appendEntry(customType, data)`, in call order. */
	entries: Array<{ customType: string; data: unknown }>;
}

export interface MockPi {
	pi: ExtensionAPI;
	captured: CapturedPi;
}

export interface CreateMockPiOptions extends Partial<ExtensionAPI> {
	/**
	 * Skill names to surface from `getCommands()` as `RegisteredCommand`s with
	 * `source: "skill"` (matching the shape Pi emits from
	 * `agent-session.js:1699` — `name` prefixed with `"skill:"`, `source`
	 * `"skill"`). Lets tests of programmatic `/skill:<name>` dispatch (the
	 * `rpiv-workflow` runner gates dispatch on this registry to prevent
	 * raw-text leakage to the LLM) register the skills their workflow uses
	 * without hand-rolling RegisteredCommand objects.
	 *
	 * Overridden completely by a `getCommands` override in the same call —
	 * `getCommands` takes precedence when both are present.
	 */
	skills?: readonly string[];
}

export function createMockPi(options: CreateMockPiOptions = {}): MockPi {
	const captured: CapturedPi = {
		tools: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		flags: new Map(),
		events: new Map(),
		eventsEmitted: new Map(),
		activeTools: [],
		allTools: [],
		entries: [],
	};

	const { skills, ...overrides } = options;
	const skillCommands: RegisteredCommand[] = (skills ?? []).map(
		(name) =>
			({
				name: `skill:${name}`,
				source: "skill",
				sourceInfo: { path: `/mock/skills/${name}/SKILL.md`, baseDir: `/mock/skills/${name}` },
			}) as unknown as RegisteredCommand,
	);

	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			if (!captured.activeTools.includes(tool.name)) captured.activeTools.push(tool.name);
		}),
		registerCommand: vi.fn((name: string, cmd: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			captured.commands.set(name, cmd);
		}),
		registerShortcut: vi.fn((shortcut: string, opts: CapturedShortcut) => {
			captured.shortcuts.set(shortcut, opts);
		}),
		registerFlag: vi.fn((name: string, value: unknown) => {
			captured.flags.set(name, value);
		}),
		getFlag: vi.fn((name: string) => captured.flags.get(name)),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			const list = captured.events.get(event) ?? [];
			list.push(handler);
			captured.events.set(event, list);
		}),
		appendEntry: vi.fn((customType: string, data?: unknown) => {
			captured.entries.push({ customType, data });
		}),
		sendMessage: vi.fn(async () => {}),
		sendUserMessage: vi.fn((_content: unknown, _options?: unknown) => {
			// Sync fire-and-forget in production; mock captures nothing extra.
			// Tests assert on sentMessages via the chain or directly on this spy.
		}),
		exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			captured.activeTools = [...names];
		}),
		getAllTools: vi.fn(() => [...captured.allTools]),
		getThinkingLevel: vi.fn(() => "medium" as unknown as string),
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				const list = captured.eventsEmitted.get(channel) ?? [];
				list.push(data);
				captured.eventsEmitted.set(channel, list);
			}),
			on: vi.fn(() => () => {}),
		},
		// Default skill registry: just the user-passed `skills` list. Tests
		// that need a custom getCommands can still pass one via overrides
		// (it'll replace this default via the spread below).
		getCommands: vi.fn(() => skillCommands),
		...overrides,
	} as unknown as ExtensionAPI;

	return { pi, captured };
}

export interface MockUI {
	notify: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	setWorkingMessage: ReturnType<typeof vi.fn>;
	setHiddenThinkingLabel: ReturnType<typeof vi.fn>;
	onTerminalInput: ReturnType<typeof vi.fn>;
	pasteToEditor: ReturnType<typeof vi.fn>;
	setEditorComponent: ReturnType<typeof vi.fn>;
	/** Only present when a test passes one in; overlay renders fall back to the factory theme otherwise. */
	theme?: Theme | MockTheme;
}

export function createMockUI(
	overrides: Partial<Omit<ExtensionUIContext, "theme">> & { theme?: Theme | MockTheme } = {},
): MockUI {
	return {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => ""),
		select: vi.fn(async () => undefined),
		setWidget: vi.fn(),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		pasteToEditor: vi.fn(),
		setEditorComponent: vi.fn(),
		...overrides,
	} as unknown as MockUI;
}

export function createMockSessionManager(
	branch: SessionEntry[] = [],
	sessionId = "test-session",
	sessionName?: string,
) {
	return {
		getBranch: vi.fn(() => branch),
		getEntries: vi.fn(() => branch),
		getLeafId: vi.fn(() => (branch.length ? branch[branch.length - 1].id : null)),
		getSessionFile: vi.fn(() => "/tmp/test-session.jsonl"),
		getSessionId: vi.fn(() => sessionId),
		// Pi reports an UNNAMED session as `undefined`, so the default mirrors a
		// session the user never renamed.
		getSessionName: vi.fn(() => sessionName),
	};
}

export function createMockModelRegistry(models: Model<Api>[] = []) {
	return {
		find: vi.fn((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
		getAvailable: vi.fn(() => [...models]),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: {} })),
	};
}

export interface MockCtxOptions {
	hasUI?: boolean;
	/** Host mode the ctx advertises (`"rpc"` for ACP hosts). Pi ≥0.79 field — omitted by default, matching the pinned 0.74 peer types. */
	mode?: string;
	cwd?: string;
	model?: Model<Api>;
	branch?: SessionEntry[];
	models?: Model<Api>[];
	ui?: Partial<ExtensionUIContext>;
	/** Concurrency cap the ctx advertises. Defaults to 1 (sequential). */
	maxConcurrency?: number;
	/** Session id the ctx advertises via `sessionManager.getSessionId()`. Defaults to "test-session". */
	sessionId?: string;
	/** Display name the ctx advertises via `sessionManager.getSessionName()`. Omitted = unnamed session. */
	sessionName?: string;
	/**
	 * Session id a `spawnChild`-minted child ctx advertises. Defaults to
	 * `${sessionId}-child` so parent/child isolation is exercised, not masked.
	 */
	childSessionId?: string;
}

/** A tool `execute()` ctx (Pi ≥ 1.1: `ExtensionToolContext`), which also satisfies `ExtensionContext`. */
export function createMockCtx(opts: MockCtxOptions = {}): ExtensionToolContext {
	return {
		hasUI: opts.hasUI ?? false,
		mode: opts.mode,
		cwd: opts.cwd ?? "/tmp/test-cwd",
		model: opts.model,
		ui: createMockUI(opts.ui),
		sessionManager: createMockSessionManager(opts.branch ?? [], opts.sessionId, opts.sessionName),
		modelRegistry: createMockModelRegistry(opts.models ?? []),
		isIdle: vi.fn(() => true),
		tools: [],
		executeTool: vi.fn(),
	} as unknown as ExtensionToolContext;
}
import type { AssistantMessage, JsonObject, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
export function makeUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}
export interface ToolResultInput {
	toolCallId?: string;
	toolName: string;
	text?: string;
	details?: unknown;
	isError?: boolean;
}

export function makeToolResult(input: ToolResultInput): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: input.toolCallId ?? `call-${input.toolName}-${Date.now()}`,
		toolName: input.toolName,
		content: input.text ? [{ type: "text", text: input.text }] : [],
		details: input.details,
		isError: input.isError ?? false,
		timestamp: Date.now(),
	} as unknown as ToolResultMessage;
}

export function makeMessageEntry(message: Message): SessionEntry {
	return { type: "message", message } as unknown as SessionEntry;
}

/** A `custom` session entry, as `pi.appendEntry(customType, data)` persists it (never sent to the LLM). */
export function makeCustomEntry(customType: string, data: unknown): SessionEntry {
	return { type: "custom", customType, data } as unknown as SessionEntry;
}

/** A root→leaf branch of message entries, chained by `id`/`parentId` like a real
 *  session path, so Pi's path-walking builders (`buildSessionContext`) traverse it. */
export function buildSessionEntries(messages: Message[]): SessionEntry[] {
	return messages.map(
		(message, i) =>
			({
				type: "message",
				id: `entry-${i}`,
				parentId: i === 0 ? null : `entry-${i - 1}`,
				message,
			}) as unknown as SessionEntry,
	);
}
export function makeTodoToolResult(details: unknown, text = "ok"): ToolResultMessage {
	return makeToolResult({ toolName: "todo", text, details });
}
type ColorKey = string;

export interface MockTheme {
	fg: (_color: ColorKey, text: string) => string;
	bg: (_color: ColorKey, text: string) => string;
	bold: (text: string) => string;
	strikethrough: (text: string) => string;
}

export function makeTheme(overrides: Partial<MockTheme> = {}): MockTheme {
	return {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
		strikethrough: (text) => text,
		...overrides,
	};
}
/**
 * Ship-manifest verification helper.
 *
 * Walks a package directory for production `.ts` files and compares them to
 * the `files` array in `package.json`. Used by `ship-manifest.test.ts` files
 * across the monorepo so every published package can prove its npm tarball
 * actually contains the modules it imports at runtime.
 *
 * Replaces the previous copy-pasted `walkProductionTs` helper in three
 * packages with one canonical implementation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "docs"]);
const SKIP_FILES = new Set(["test-fixtures.ts", "test-utils.ts", "test-isolation.ts"]);

export interface ShipManifestResult {
	/** Entries declared in `package.json` `files`. */
	declared: readonly string[];
	/** Production `.ts` files discovered on disk (relative to packageDir). */
	onDisk: readonly string[];
	/** On-disk files NOT covered by the `files` array — these would be missing from the published tarball. */
	missing: readonly string[];
	/** `files` entries with no corresponding path on disk — ghost entries that ship nothing. */
	stale: readonly string[];
}

/**
 * Verify a package's ship manifest against its on-disk production .ts tree.
 *
 * Accepts either a directory path or a `file:` URL string (so callers can
 * pass `import.meta.url` directly — the helper resolves it to the test file's
 * parent directory).
 *
 * Skips: dotfiles/dotdirs, `node_modules`, `docs`, `*.test.ts`, `test-fixtures.ts`.
 * Does NOT check: asset directories (e.g. `locales/*.json`), `exports` map,
 * `main`/`module` fields.
 *
 * The check is two-way: `missing` flags on-disk production files the tarball
 * would omit; `stale` flags `files` entries that point at nothing on disk
 * (asset entries like `README.md` count as present — staleness is plain
 * existence, not the production-`.ts` walk). `!`-prefixed negation patterns
 * (the npm test-file exclusion glob, for instance) are exclusion rules, not
 * paths — they are skipped by both checks.
 */
export function verifyShipManifest(packageDirOrUrl: string): ShipManifestResult {
	const packageDir = packageDirOrUrl.startsWith("file:") ? dirname(fileURLToPath(packageDirOrUrl)) : packageDirOrUrl;
	const pkgRaw = readFileSync(resolve(packageDir, "package.json"), "utf8");
	const pkg = JSON.parse(pkgRaw) as { files?: string[] };
	const declared = pkg.files ?? [];
	const exactFiles = new Set<string>();
	const dirPrefixes: string[] = [];
	for (const entry of declared) {
		// `!`-prefixed entries are npm negation/exclusion patterns (the
		// test-file exclusion glob, for instance), not paths on disk — they
		// carve files OUT of the tarball rather than declaring inclusion, so
		// they neither cover an on-disk file nor count toward staleness. The
		// production-`.ts` walk already omits test files, so the common
		// test-file exclusion has no effect on the `missing` computation.
		if (entry.startsWith("!")) continue;
		// Treat trailing-slash entries AND bare directory names that exist on
		// disk as recursive directory inclusion — matches npm's own `files`
		// semantics so the test answers "would npm publish actually include this?"
		// rather than enforcing a stylistic preference. Bare dir names are
		// normalized to a trailing-slash prefix so a `"load"` entry covers
		// `load/cache.ts` without spuriously matching a sibling `loader.ts`.
		if (entry.endsWith("/")) dirPrefixes.push(entry);
		else if (isDirOnDisk(packageDir, entry)) dirPrefixes.push(`${entry}/`);
		else exactFiles.add(entry);
	}

	const onDisk = walkProductionTs(packageDir, packageDir);
	const missing = onDisk.filter((f) => !isCovered(f, exactFiles, dirPrefixes));
	const stale = declared.filter((entry) => !entry.startsWith("!") && !existsSync(resolve(packageDir, entry)));

	return { declared, onDisk, missing, stale };
}

function isDirOnDisk(packageDir: string, entry: string): boolean {
	try {
		return statSync(resolve(packageDir, entry)).isDirectory();
	} catch {
		// Entry not present on disk (e.g. an asset/extraneous `files` entry) —
		// not a directory we can recurse into; the caller treats it as an exact file.
		return false;
	}
}

function isCovered(file: string, exactFiles: Set<string>, dirPrefixes: readonly string[]): boolean {
	if (exactFiles.has(file)) return true;
	for (const prefix of dirPrefixes) {
		if (file.startsWith(prefix)) return true;
	}
	return false;
}

function walkProductionTs(root: string, dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
		const abs = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkProductionTs(root, abs));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		if (entry.name.endsWith(".test.ts") || SKIP_FILES.has(entry.name)) continue;
		out.push(relative(root, abs));
	}
	return out;
}
