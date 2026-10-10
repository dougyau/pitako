import path from "node:path";
import { writeFileSync } from "node:fs";
import { installLocalProvider } from "../local-provider.ts";

{
  await installLocalProvider({
    agentDir: process.env.PI_CODING_AGENT_DIR, model: "senior", reasoning: true,
  });
  const provider = globalThis.__pitako_local;
  const stream = provider.streamSimple;
  provider.streamSimple = (model, context, options) => {
    const result = stream(model, context, options);
    writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "cli-activation.json"),
      JSON.stringify({ model: model.id, provider: model.provider, reasoning: options.reasoning,
        sessionId: options.sessionId }));
    return result;
  };
}
