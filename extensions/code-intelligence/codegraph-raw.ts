import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codegraphExtension from "@vndv/pi-codegraph/extensions/codegraph.ts";

/** Keep vendor raw tool registrations but omit its conflicting raw-first prompt hook. */
export default function codegraphRaw(pi: ExtensionAPI): void {
  const facade = new Proxy(pi, {
    get(target, property) {
      if (property === "on") {
        return (event: string, ...args: unknown[]) => {
          if (event === "before_agent_start") return () => {};
          return (target.on as (...values: unknown[]) => () => void)(event, ...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  codegraphExtension(facade);
}
