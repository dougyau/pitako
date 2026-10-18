# Startup configuration completion

Pitako uses `$PI_CODING_AGENT_DIR/pitako/config.toml`, or `~/.pi/agent/pitako/config.toml` when `PI_CODING_AGENT_DIR` is unset. A principal `session_start` creates or completes this file after the previous foreground owner has settled. Completion runs before history maintenance and foreground profile publication.

## Active defaults and commented choices

Completion inserts missing settings from these groups in [`config/defaults.toml`](../config/defaults.toml):

- `agent_runtime`
- `worker_history`
- `developer_routing`
- `head_developer`

Existing values take precedence. Completion checks that the proposed file leaves the effective configuration unchanged. Creation changes only the file-presence metadata.

All role overrides, model policies, architecture candidates, review candidates, and topics appear as commented examples. Role and policy IDs come from the bundled defaults. Explicit-choice examples come from [`config/completion-examples.toml`](../config/completion-examples.toml). The `provider/model` value is a placeholder, not an installed or authenticated model.

Commented choices do not enable models or tables. Completion never inserts an active instruction override, `reasoning`, `fast`, an empty fallback list, or a candidate list. An omitted Developer fallback field continues to inherit its existing policy.

## Source and upgrade behavior

Completion adds source text rather than serializing the user document. Existing values, comments, order, strings, and newline style remain intact. The absence of a final newline also remains intact. Explicit tables, root dotted keys, quoted keys, and root inline groups keep their existing declaration form.

Each commented setting has a stable `# pitako:setting ...` marker. A genuine comment marker or an active setting prevents another example for that setting. Marker-like text inside a string has no effect. Later startups add newly supported settings without replacing existing example text. Arrays remain wholly user-owned, including candidate and topic arrays.

Examples use dotted keys to show each setting's full path. An uncommented root dotted key belongs before any table header. Within an existing table, the equivalent key omits that table's prefix. Duplicate table declarations and conflicting dotted declarations are invalid TOML.

Relative instruction paths resolve against the original user configuration directory, including when the config is a symlink. They never resolve against the package or a publication temporary file.

## Publication and errors

An unchanged file causes no directory, lock, temporary-file, or target write. A changed file uses an exclusive cooperative lock beside the resolved target. Pitako takes a fresh snapshot, closes its exclusive temporary file, and rechecks the owner, target path, identity, metadata, and bytes before publication.

An existing regular target is replaced by an atomic rename. Creation uses same-directory no-replace publication. Valid symlinks remain links, and completion updates the resolved target. Existing mode, UID, and GID are preserved or publication fails before replacement. The writer refuses dangling links, nonregular targets, and multiply linked targets that need changes. Ordinary readers do not gain these writer restrictions.

Lock contention and detected concurrent edits cause a warning and skip completion. A retired owner skips silently. Read, validation, permission, and publication errors remain explicit startup errors, outside the history-maintenance warning handler. Cleanup removes only owned lock and temporary paths. Pitako does not steal stale locks.

The final recheck cannot prevent an arbitrary editor from changing the file immediately afterward. Completion does not provide portable compare-and-swap, ACL or extended-attribute preservation, power-loss durability, cross-filesystem publication, or sandbox guarantees.

Imports, runtime preparation, inspection commands, ordinary configuration readers, and worker sessions never complete configuration files.
