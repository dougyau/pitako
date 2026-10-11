import { afterAll, beforeAll } from "bun:test";

// Direct foreground registration invokes official install telemetry. Each file
// owns its opt-out until its cases and settlement hooks have finished.
const previous = process.env.PI_OFFLINE;
beforeAll(() => { process.env.PI_OFFLINE = "1"; });
afterAll(() => {
  if (previous === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previous;
});
