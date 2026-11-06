import { createLogger } from "@adlc/telemetry";
import { runAgent } from "./run.js";

// Container entrypoint (bundled to dist-bundle/agent.mjs by `pnpm --filter @adlc/agent-runtime build:bundle`).
const logger = createLogger("agent-runtime");
process.exitCode = await runAgent(process.env, logger);
