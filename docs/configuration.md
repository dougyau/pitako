# Configuration

Pitako's current configuration consists of its package resource declarations,
ordinary profiles, and the upstream extensions' settings.

- `package.json` declares extensions, advertised skills, prompts, and pi-subagents
  profiles under `agents/`.
- `config/stack.json` lists required extension entries checked by startup.
- `--pitako-profile coding|analysis` selects the session profile.
  `PITAKO_PROFILE` is the fallback when the flag is omitted.
- `/pitako profile coding|analysis` changes the current session's profile.
- `PI_CODING_AGENT_DIR` selects Pi storage. Board uses its `pitako/board.db`.

ACP defaults to `delegate:false`, `autoUpdate:false`, and
`toolBashDefaultTimeout:0`. Explicit `~/.pi/acp.json` and project `.pi/acp.json`
override these defaults, with project settings winning. `enabled:false` keeps
upstream native compaction available. Pitako does not rewrite those files.

Pi and pi-subagents own model and child configuration. Pitako's former
`config.toml`, role policies, developer routing, Head, and worker-history settings
are not read, validated, or completed. Existing files are left untouched.

`plan` and `execute` are excluded from advertised skills. Their files only
document suspension; they are not compatibility implementations.
