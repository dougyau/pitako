import { appendFileSync, readFileSync, realpathSync } from "node:fs";

/** Shared by the typed fixture and the pre-loader Node/Bun bootstrap. */
export function createGitFakePort(files, calls = []) {
  function lookup(method, args, opts) {
    const cwd = realpathSync(String(opts.cwd ?? process.cwd()));
    const input = opts.stdin ?? opts.input;
    const call = { method, args: [...args], cwd, env: { ...(opts.env ?? process.env) }, stdin: input == null ? null : String(input) };
    calls.push(call);
    appendFileSync(files.calls, JSON.stringify(call) + "\n");
    const answer = JSON.parse(readFileSync(files.table, "utf8"))[JSON.stringify([cwd, args])];
    if (answer) return answer;
    const message = `PITAKO_GIT_FAKE_MISS: ${JSON.stringify({ cwd, args })}`;
    appendFileSync(files.violations, JSON.stringify({ ...call, message }) + "\n");
    throw Object.assign(new Error(message), { status: 128, stderr: message });
  }
  return {
    read(args, opts) {
      const answer = lookup("read", args, opts);
      if (answer.status !== 0) throw Object.assign(new Error(answer.stderr), answer);
      return answer.stdout;
    },
    status(args, opts) {
      const answer = lookup("status", args, opts);
      const stdout = opts.encoding ? answer.stdout : Buffer.from(answer.stdout);
      const stderr = opts.encoding ? answer.stderr : Buffer.from(answer.stderr);
      return { ...answer, stdout, stderr, pid: 0, signal: null, output: [null, stdout, stderr] };
    },
    async run(opts) {
      const answer = lookup("run", opts.args, opts);
      return { stdout: answer.stdout, stderr: answer.stderr, exitCode: answer.status, termSignal: null,
        stdoutDropped: 0, stderrDropped: 0, timedOut: false, aborted: false, durationMs: 0 };
    },
  };
}
