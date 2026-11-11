import type { GitPort } from "../../extensions/git-port.ts";
import type { GitCall, GitFakeFiles } from "./git-fake.ts";
export function createGitFakePort(files: GitFakeFiles, calls?: GitCall[]): GitPort;
