import { afterEach } from "bun:test";
import { loadPitako as load, type LoadedPitako } from "../../scripts/load-pitako.ts";

// These callers do not start SDK sessions or tool processes; those need their
// own settlement before releasing directories (see the provider and smoke owners).
const loaded: LoadedPitako[] = [];
afterEach(() => {
  for (const item of loaded) item.releaseOwnedDirectories();
  loaded.length = 0;
});

export async function loadPitako(...args: Parameters<typeof load>): Promise<LoadedPitako> {
  const item = await load(...args);
  loaded.push(item);
  return item;
}
