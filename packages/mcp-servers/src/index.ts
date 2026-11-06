import { decisionTools } from "./decisions.js";
import { githubTools } from "./github.js";
import { jiraTools } from "./jira.js";
import type { ToolDef } from "./tool.js";

export * from "./decisions.js";
export * from "./github.js";
export * from "./jira.js";
export * from "./policy.js";
export * from "./tool.js";

/** Every tool the gateway offers in Phase 0 (P0-WP5: jira, github, decisions). */
export const allTools: readonly ToolDef[] = [...jiraTools, ...githubTools, ...decisionTools];
