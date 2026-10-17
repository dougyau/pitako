import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyProfile, profileIsCurrent } from "./profile.ts";

/** Runs after the independently declared Codex entry, without owning its hooks. */
export default function profilePolicy(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (profileIsCurrent(ctx.sessionManager)) applyProfile(pi, ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    if (profileIsCurrent(ctx.sessionManager)) applyProfile(pi, ctx);
  });
}
