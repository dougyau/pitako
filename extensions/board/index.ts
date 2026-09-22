import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBoard } from "./tools.ts";

export default function board(pi: ExtensionAPI): void {
  registerBoard(pi);
}
