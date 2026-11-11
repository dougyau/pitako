export const gitFakeBootstrap = new URL("./git-fake-bootstrap.mjs", import.meta.url).href;
const settings = ["PITAKO_TEST_GIT_TABLE", "PITAKO_TEST_GIT_CALLS", "PITAKO_TEST_GIT_VIOLATIONS",
  "PITAKO_TEST_GIT_SENTINEL", "PITAKO_TEST_GIT_SENTINEL_LOG"] as const;

/** Preserve fixture-bin precedence while keeping system Git behind the sentinel. */
export function guardEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const guarded = { ...env };
  for (const name of settings) if (guarded[name] === undefined && process.env[name] !== undefined) guarded[name] = process.env[name];
  if (guarded.PITAKO_TEST_GIT_TABLE) {
    const preload = `--import=${gitFakeBootstrap}`;
    const options = guarded.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? "";
    guarded.NODE_OPTIONS = options.includes(preload) ? options : `${options} ${preload}`.trim();
  }
  const sentinel = guarded.PITAKO_TEST_GIT_SENTINEL;
  if (sentinel) {
    const parts = (guarded.PATH ?? process.env.PATH ?? "").split(":").filter(part => part !== sentinel);
    const system = parts.findIndex(part => part === "/usr/bin" || part === "/bin");
    parts.splice(system < 0 ? parts.length : system, 0, sentinel);
    guarded.PATH = parts.join(":");
  }
  return guarded;
}
