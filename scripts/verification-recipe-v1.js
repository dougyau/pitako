(() => {
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const pathInput = value => typeof value === "string" && value.length <= 4096 && value.startsWith("/") &&
    !/[\x00-\x1f\x7f]/.test(value) && !value.split("/").includes("..");
  const gates = {
    typecheck: "bun run typecheck",
    bun: "bun run test",
    "code-intelligence-node": "bun run test:code-intelligence-node",
  };
  return {
    version: 1,
    async run({ root, evidenceDir, selection }) {
      if (!pathInput(root) || !pathInput(evidenceDir)) throw Error("Expected absolute safe paths");
      if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw Error("Invalid selection");
      const keys = Object.keys(selection).sort().join(",");
      let commands;
      if (selection.kind === "full" && keys === "kind") commands = Object.values(gates);
      else if (selection.kind === "gate" && keys === "gate,kind" && typeof selection.gate === "string" &&
        Object.hasOwn(gates, selection.gate)) commands = [gates[selection.gate]];
      else if (selection.kind === "focused" && keys === "files,kind" &&
        Array.isArray(selection.files) && selection.files.length > 0 && selection.files.length <= 100 &&
        new Set(selection.files).size === selection.files.length &&
        selection.files.every(file => typeof file === "string" && file.length <= 4096 &&
          /^tests\/(?:[^/\\\x00-\x1f\x7f]+\/)*[^/\\\x00-\x1f\x7f]+\.test\.ts$/.test(file) &&
          !file.split("/").some(part => part === "." || part === ".."))) {
        commands = ["bun test " + selection.files.map(file => quote("./" + file)).join(" ")];
      } else throw Error("Invalid selection");

      const results = [];
      for (const command of commands) {
        const metadata = JSON.stringify({ version: 1, root, selection, command,
          childEnv: { BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" } });
        // Capture on disk, not through the model-facing output limit. Each call owns fresh files.
        const shell = `mkdir -p -- ${quote(evidenceDir)} || exit 125
dir=$(mktemp -d ${quote(evidenceDir.replace(/\/$/, "") + "/recipe-v1.XXXXXX")}) || exit 125
printf 'PITAKO_RECIPE_START\\t%s\\n' "$dir"
printf '%s\\n' ${quote(metadata)} > "$dir/invocation.json" || exit 125
date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/start.txt" || exit 125
printf 'BUN_OPTIONS=%s\\nBUN_INSTALL=%s\\nPATH=%s\\n' "\${BUN_OPTIONS-}" "\${BUN_INSTALL-}" "$PATH" > "$dir/environment.txt" || exit 125
cd -- ${quote(root)} || exit 125
${selection.kind === "focused" ? selection.files.map(file => `target=$(realpath -- ${quote(file)}) || exit 125
scope=$(realpath -- tests) || exit 125
project=$(pwd -P)
case "$scope/" in "$project/"*) ;; *) exit 125 ;; esac
case "$target" in "$scope/"*) ;; *) exit 125 ;; esac
test -f "$target" || exit 125`).join("\n") : ""}
(
  BUN_OPTIONS='' NO_COLOR=1 FORCE_COLOR=0 ${command}
) 2>&1 | tee "$dir/raw.log" >/dev/null
codes=("\${PIPESTATUS[@]}")
code=\${codes[0]}
test "\${codes[1]}" = 0 || exit 125
test -f "$dir/raw.log" || exit 125
printf '%s\\n' "$code" > "$dir/exit-code.txt" || exit 125
date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/end.txt" || exit 125
printf 'PITAKO_RECIPE_EXIT\\t%s\\t%s\\n' "$dir" "$code"
exit "$code"`;
        let result = { command, status: "incomplete" };
        try {
          const observed = await tools.bash({ command: shell });
          const output = observed && typeof observed.output === "string" ? observed.output : "";
          const start = output.match(/^PITAKO_RECIPE_START\t([^\n\t]+)\n/);
          if (start && start[1].startsWith(evidenceDir.replace(/\/$/, "") + "/recipe-v1.")) {
            result.evidenceDir = start[1];
            result.log = start[1] + "/raw.log";
          }
          const terminal = output.match(/^PITAKO_RECIPE_START\t([^\n\t]+)\nPITAKO_RECIPE_EXIT\t\1\t(\d+)\n$/);
          if (terminal && result.evidenceDir && observed.truncated === false &&
            Number.isInteger(observed.exit_code) && observed.exit_code >= 0 &&
            observed.exit_code <= 255 && Number(terminal[2]) === observed.exit_code) {
            result.exitCode = observed.exit_code;
            result.status = observed.exit_code === 0 ? "passed" : "failed";
          } else result.error = "Missing or invalid terminal/capture observation";
        } catch (error) {
          result.error = String(error.message || error).slice(0, 1000);
        }
        results.push(result);
        if (result.status !== "passed") break;
      }
      return { version: 1, root, evidenceDir, selection, status: results.every(result => result.status === "passed") ?
        "passed" : results[results.length - 1].status, results, unrun: commands.slice(results.length) };
    },
  };
})()
