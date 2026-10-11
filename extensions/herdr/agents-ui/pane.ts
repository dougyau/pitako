import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { AgentScreen } from "../../agent/screen.ts";
import { connectAgentPane } from "./client.ts";
import { readDescriptor } from "./descriptor.ts";
import { descriptorEnv } from "./protocol.ts";
export { descriptorEnv } from "./protocol.ts";

export async function runAgentPane(): Promise<void> {
  const file = process.env[descriptorEnv];
  await readDescriptor(file);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Agent pane requires a terminal");
  const view = await connectAgentPane(file!);
  const tui = new TuiAltScreen(new ProcessTerminal());
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  const screen = new AgentScreen(view, () => tui.requestRender(), finish, () => tui.terminal.rows);
  tui.addChild(screen);
  tui.setFocus(screen);
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
  try {
    tui.start();
    await closed;
  } finally {
    await screen.finish();
    tui.stop();
    process.off("SIGTERM", finish);
    process.off("SIGINT", finish);
  }
}

// Importing this published module is passive, including non-TUI/child loading.
if (import.meta.main) {
  try {
    await runAgentPane();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
