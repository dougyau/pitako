# T1 verification

Commands:

- `bunx tsc --noEmit` exited 0.
- `bun test tests/agent-pi.test.ts tests/agent.test.ts` exited 0. 16 pass, 0 fail.

The new tests do not call Cursor. A temp `PI_CODING_AGENT_DIR` extension registers `pitako-late/late` only when the child session binds.

Observed:

- `pitako-late/late` with `reasoning: "off"` completed and returned `pong`. The provider stream ran once and the prompt contained `say-pong-marker`.
- `pitako-late/missing` failed with `model unavailable: pitako-late/missing`, `sideEffects: false`, and no provider stream call.
- After a completed late-model run, `continueWith` for `pitako-late/missing` failed with the same unavailable error and did not add a second stream call.

Files changed:

- `extensions/agent/pi.ts`
- `tests/agent-pi.test.ts`
- `docs/engineering.md`
