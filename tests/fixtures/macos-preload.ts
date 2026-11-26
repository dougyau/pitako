// Fixtures compare physical worktree roots, but macOS's default TMPDIR (/var/folders/...) goes
// through the /var -> private/var system link. Use its physical path; child processes inherit it.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform === "darwin") process.env.TMPDIR = realpathSync(tmpdir()) + path.sep;
