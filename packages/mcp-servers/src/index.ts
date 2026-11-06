import { decisionTools } from "./decisions.js";
import { evidenceTools } from "./evidence.js";
import { githubTools } from "./github.js";
import { jiraTools } from "./jira.js";
import type { ToolDef } from "./tool.js";

export * from "./decisions.js";
export * from "./evidence.js";
export * from "./github.js";
export * from "./jira.js";
export * from "./policy.js";
export * from "./tool.js";

/** Every tool the gateway offers in Phase 0 (jira, github, decisions; evidence from P0-WP7). */
export const allTools: readonly ToolDef[] = [...jiraTools, ...githubTools, ...decisionTools, ...evidenceTools];
