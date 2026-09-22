export type HerdrPresence = {
  present: boolean;
  paneId?: string;
  socketPath?: string;
  tabId?: string;
  workspaceId?: string;
};

function filled(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

/** Presence is the three Herdr env vars. A terminal title is not presence. */
export function readHerdrPresence(env: Readonly<Record<string, string | undefined>> = process.env): HerdrPresence {
  const paneId = filled(env.HERDR_PANE_ID);
  const socketPath = filled(env.HERDR_SOCKET_PATH);
  const tabId = filled(env.HERDR_TAB_ID);
  const workspaceId = filled(env.HERDR_WORKSPACE_ID);
  const presence: HerdrPresence = {
    present: env.HERDR_ENV === "1" && paneId !== undefined && socketPath !== undefined,
  };
  if (paneId) presence.paneId = paneId;
  if (socketPath) presence.socketPath = socketPath;
  if (tabId) presence.tabId = tabId;
  if (workspaceId) presence.workspaceId = workspaceId;
  return presence;
}

/** True only when the pi: status token is exactly `current`. Other agents do not count. */
export function piIntegrationCurrent(statusText: string): boolean {
  for (const line of statusText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("pi:")) continue;
    const token = trimmed.slice("pi:".length).split("(")[0]?.trim() ?? "";
    return token === "current";
  }
  return false;
}
